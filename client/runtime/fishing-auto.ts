import { deepFreeze } from "../configuration/snapshot";
import type { InteractionFishing } from "../gmcp/contracts/interactions";
import type { StorageLike } from "../storage/repository";
import type { TransportReconnectStatusPayload } from "../transport/types";
// @ts-expect-error The Auto-Angler decision core is retained JavaScript without a declaration file.
import * as autoCore from "../../public/js/fishing-auto-core.mjs";
import type { SessionEventBus } from "./event-bus";
import type { Unsubscribe } from "./events";
import type { SessionInteractions } from "./interactions";
import type { Disposer, ResourceScope } from "./resource-scope";

/**
 * The Auto-Angler: plays Darkwind's fishing mini-game unattended.
 *
 * This runtime owns everything impure about the addon: the loop state
 * machine, timers, persistence, and the messages it reports. Every decision
 * about *how* to play lives in fishing-auto-core.mjs, which is pure and
 * unit-tested. The runtime watches the session's fishing snapshot for the
 * server's side of the conversation (open, bite, fight, verdict, end), sends
 * casts and hooks through the interactions runtime exactly as the panel does,
 * and drives the panel's fight simulation through resolveHeld().
 *
 * Design constraint: when the Auto-Angler is off it is completely inert. A
 * player who never turns it on cannot tell it exists; the panel's only hook is
 * a resolveHeld() call that returns its argument unchanged while we are off.
 */
export type FishingAutoPhase =
  | "idle"
  | "nobait"
  | "ready"
  | "casting"
  | "waiting"
  | "bite"
  | "hooking"
  | "fight"
  | "resolving"
  | "caught"
  | "escaped";

/** Why the Auto-Angler stopped. Appended to "Auto-Angler off." so they read as the reason. */
export const HALT_REASONS = Object.freeze({
  MANUAL: "You took over.",
  SWITCHED_OFF: "Switched off.",
  NO_BAIT: "Out of bait.",
  SESSION_END: "The fishing session ended.",
  DISCONNECTED: "Connection lost.",
  BAD_PARAMS: "The server sent a fight this addon cannot model.",
});

/** Something the addon did to the session, for the panel to mirror on its stage. */
export interface FishingAutoAction {
  readonly seq: number;
  readonly kind: "cast-begin" | "cast" | "cast-abandoned" | "hook";
  /** The released cast power, for "cast". */
  readonly power: number | null;
  readonly at: number;
}

export interface FishingAutoSnapshot {
  readonly enabled: boolean;
  readonly phase: FishingAutoPhase;
  readonly haltReason: string;
  /** The adaptive cast power the policy has settled on. */
  readonly castPower: number;
  /** A pinned cast power, or null for adaptive. */
  readonly powerOverride: number | null;
  /** The power the next cast aims at, before per-cast jitter. */
  readonly power: number;
  readonly landed: number;
  readonly lost: number;
  readonly lostBy: Readonly<Record<string, number>>;
  readonly cycles: number;
  /** One-line run summary for the panel's status strip. */
  readonly summary: string;
  readonly action: FishingAutoAction | null;
}

export interface FishingAutoMessage {
  /** "system" lines are notices; "echo" lines are commands the addon sent, for the audit trail. */
  readonly kind: "system" | "echo";
  readonly text: string;
}

export interface SessionFishingAuto {
  getSnapshot(): FishingAutoSnapshot;
  subscribe(listener: (snapshot: FishingAutoSnapshot) => void): Unsubscribe;
  subscribeMessages(listener: (message: FishingAutoMessage) => void): Unsubscribe;
  enable(): void;
  disable(reason?: string): void;
  toggle(): void;
  /** null restores the adaptive policy; a number pins every cast. */
  setPowerOverride(value: number | null): void;
  /** `/autofish [on|off|power <n>|power auto]`; `args` are the words after the command. */
  handleCommand(args: readonly string[]): void;
  /** The player touched the fishing panel: hand control straight back. */
  notifyManualInput(): void;
  /** The panel's simulation reached an outcome and reported it. */
  notifyFightEnd(): void;
  /** The panel's per-frame delegation point; returns `manualHeld` untouched while off. */
  resolveHeld(manualHeld: boolean, simState: unknown, dtMs: number): boolean;
}

export interface SessionFishingAutoOptions {
  /** Monotonic millisecond clock; defaults to performance.now(). */
  now?: () => number;
  /** RNG seed for cast and hook timing; defaults to the wall clock. */
  seed?: number;
  /** Where the enabled flag, adaptive power, and pinned power persist. */
  storage?: StorageLike;
  storageKey?: string;
}

interface PersistedFishingAuto {
  enabled: boolean;
  castPower: number;
  powerOverride: number | null;
}

interface FightController {
  params: { degraded: string[] };
  decide(simState: unknown, dtMs: number): boolean;
}

interface RunStats {
  landed: number;
  lost: Record<string, number>;
  cycles: number;
  startedAt: number;
}

interface AutoCore {
  TUNING: { castPowerStart: number };
  createFightController(params: unknown, opts: { seed: number }): FightController;
  createRng(seed: number): () => number;
  castReleaseMs(power: number): number;
  jitterPower(power: number, rand: () => number): number;
  isReleaseUsable(elapsedMs: number): boolean;
  hookDelayMs(windowMs: number, rand: () => number): number;
  castPowerAt(elapsedMs: number): number;
  nextCastPower(current: number, outcome: string): number;
  cycleDelayMs(rand: () => number): number;
  baitDelayMs(rand: () => number): number;
  normalizeCastPower(value: unknown): number;
  normalizePowerOverride(value: unknown): number | null;
  parseAutofishCommand(args: readonly string[]): {
    action: "status" | "on" | "off" | "power" | "error";
    override?: number | null;
    error?: string;
  };
  formatAutofishStatus(status: unknown): string;
  formatAutofishSummary(status: unknown): string;
}

const core = autoCore as AutoCore;

/**
 * Params whose degradation means our model of the fight no longer matches the
 * fight the simulation is actually running. barSize decides the catch window
 * and the two rates decide every progress projection; a clamped stand-in for
 * any of them would have the controller playing blind.
 */
const MODEL_CRITICAL = new Set(["barSize", "progressRate", "drainRate"]);

const COMMANDS = Object.freeze({ FISH: "fish", BAIT: "bait hook" });

function emptyStats(): RunStats {
  return {
    landed: 0,
    lost: { snap: 0, slack: 0, timeout: 0, implausible: 0, other: 0 },
    cycles: 0,
    startedAt: 0,
  };
}

/** Whether a command line is the Auto-Angler's slash command, with its arguments. */
export function parseAutofishLine(text: string): readonly string[] | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!words.length || words[0]!.toLowerCase() !== "/autofish") return null;
  return words.slice(1);
}

export function createSessionFishingAuto(
  scope: ResourceScope,
  eventBus: SessionEventBus,
  interactions: Pick<
    SessionInteractions,
    "getSnapshot" | "subscribe" | "castFishing" | "hookFishing"
  >,
  sendCommand: (text: string) => boolean,
  isConnected: () => boolean,
  options: SessionFishingAutoOptions = {},
): SessionFishingAuto {
  const now =
    options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const listeners = new Set<(snapshot: FishingAutoSnapshot) => void>();
  const messageListeners = new Set<(message: FishingAutoMessage) => void>();
  // Notices raised before anything listens (a restored run on startup) wait
  // for the first listener rather than vanish.
  let pendingMessages: FishingAutoMessage[] = [];
  const timers = new Set<Disposer>();

  let disposed = false;
  let enabled = false;
  let haltReason = "";
  let phase: FishingAutoPhase = "idle";
  let stats = emptyStats();
  let rand: () => number = core.createRng(1);
  let castPower: number = core.TUNING.castPowerStart;
  let powerOverride: number | null = null;
  let controller: FightController | null = null;
  // True between sending "bait hook" and the next session Open. A second
  // unbaited Open while this is set means there was no bait to apply.
  let baitAttempted = false;
  let castStartedAt = 0;
  let actionSeq = 0;
  let action: FishingAutoAction | null = null;
  let snapshot: FishingAutoSnapshot;

  // ---- Persistence ---------------------------------------------------------

  const load = (): Partial<PersistedFishingAuto> => {
    if (!options.storage || !options.storageKey) return {};
    try {
      const raw = options.storage.getItem(options.storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? (parsed as Partial<PersistedFishingAuto>) : {};
    } catch {
      return {};
    }
  };

  const save = (): void => {
    if (!options.storage || !options.storageKey) return;
    try {
      const record: PersistedFishingAuto = { enabled, castPower, powerOverride };
      options.storage.setItem(options.storageKey, JSON.stringify(record));
    } catch (error) {
      console.warn("Auto-Angler could not save its settings", error);
    }
  };

  // ---- Reporting -----------------------------------------------------------

  const emit = (kind: FishingAutoMessage["kind"], text: string): void => {
    if (disposed) return;
    const message: FishingAutoMessage = { kind, text };
    if (!messageListeners.size) {
      pendingMessages.push(message);
      if (pendingMessages.length > 20) pendingMessages.shift();
      return;
    }
    for (const listener of [...messageListeners]) listener(message);
  };

  const targetPower = (): number => (powerOverride === null ? castPower : powerOverride);

  const status = () => {
    const lost = Object.values(stats.lost).reduce((a, b) => a + b, 0);
    return {
      enabled,
      phase,
      landed: stats.landed,
      lost,
      lostBy: { ...stats.lost },
      cycles: stats.cycles,
      power: targetPower(),
      castPower,
      powerOverride,
      haltReason,
    };
  };

  const buildSnapshot = (): FishingAutoSnapshot => {
    const current = status();
    return deepFreeze({
      enabled,
      phase,
      haltReason,
      castPower,
      powerOverride,
      power: current.power,
      landed: current.landed,
      lost: current.lost,
      lostBy: current.lostBy,
      cycles: current.cycles,
      summary: core.formatAutofishSummary(current),
      action,
    });
  };

  const publish = (): void => {
    if (disposed) return;
    snapshot = buildSnapshot();
    for (const listener of [...listeners]) listener(snapshot);
  };

  const record = (kind: FishingAutoAction["kind"], power: number | null = null): void => {
    actionSeq += 1;
    action = { seq: actionSeq, kind, power, at: now() };
  };

  // ---- Timers --------------------------------------------------------------

  const after = (delayMs: number, fn: () => void): void => {
    let disposer: Disposer = () => {};
    disposer = scope.setTimeout(
      () => {
        timers.delete(disposer);
        fn();
      },
      Math.max(0, delayMs),
    );
    timers.add(disposer);
  };

  const cancelTimers = (): void => {
    for (const disposer of timers) disposer();
    timers.clear();
  };

  // ---- Enable / disable ----------------------------------------------------

  const send = (command: string): boolean => {
    const sent = sendCommand(command);
    if (sent) emit("echo", command);
    return sent;
  };

  const disable = (reason = ""): void => {
    if (!enabled) return;
    enabled = false;
    controller = null;
    baitAttempted = false;
    cancelTimers();
    haltReason = reason;
    if (phase === "casting") phase = "ready";
    save();
    emit("system", "Auto-Angler off." + (reason ? " " + reason : ""));
    publish();
  };

  // "bait hook", then "fish" a beat later. The server answers the second
  // command with a fresh Open, and whether that Open is baited is the only
  // bait signal we act on.
  const bait = (): void => {
    if (!enabled) return;
    baitAttempted = true;
    send(COMMANDS.BAIT);
    after(core.baitDelayMs(rand), () => {
      if (enabled) send(COMMANDS.FISH);
    });
  };

  const openSession = (): string | null => interactions.getSnapshot().fishing.open?.session ?? null;

  // Charge and release a cast. The power is read from the oscillator at the
  // moment of release rather than chosen and asserted, so the resulting cast
  // is one a human could have made, and the panel animates the same meter.
  const releaseCast = (): void => {
    if (!enabled || phase !== "casting") return;
    const elapsed = now() - castStartedAt;
    const session = openSession();
    // A release scheduled late is usually harmless; past a full oscillator
    // period the reading means nothing, so abandon the cast and try again.
    if (!session || !core.isReleaseUsable(elapsed)) {
      phase = "ready";
      record("cast-abandoned");
      publish();
      after(core.cycleDelayMs(rand), () => kick());
      return;
    }
    const power = core.castPowerAt(elapsed);
    const sent = interactions.castFishing(session, power);
    phase = sent ? "waiting" : "ready";
    record(sent ? "cast" : "cast-abandoned", sent ? power : null);
    publish();
  };

  const beginCast = (): void => {
    if (!enabled || phase !== "ready") return;
    const target = core.jitterPower(targetPower(), rand);
    phase = "casting";
    castStartedAt = now();
    record("cast-begin");
    publish();
    after(core.castReleaseMs(target), releaseCast);
  };

  // Do whatever the current phase calls for. Called when the addon is
  // switched on and at the start of every cycle; the phases in between drive
  // themselves through the fishing snapshot.
  const kick = (): void => {
    if (!enabled) return;
    if (phase === "idle" || !openSession()) {
      // No session: open one. Nothing to send into when the socket is down;
      // the run halts on the disconnect notification anyway.
      if (isConnected()) send(COMMANDS.FISH);
      return;
    }
    if (phase === "ready") {
      beginCast();
      return;
    }
    if (phase === "nobait" || phase === "caught" || phase === "escaped") bait();
  };

  const enable = (opts: { restored?: boolean } = {}): void => {
    if (enabled || disposed) return;
    stats = emptyStats();
    stats.startedAt = now();
    haltReason = "";
    baitAttempted = false;
    rand = core.createRng(
      Number.isFinite(options.seed) ? (options.seed as number) : Date.now() % 2147483647,
    );
    enabled = true;
    save();
    emit(
      "system",
      opts.restored
        ? "Auto-Angler on (restored). It takes over when a fishing session opens."
        : "Auto-Angler on.",
    );
    publish();
    if (!opts.restored) kick();
  };

  // ---- Server-side events --------------------------------------------------

  const onSessionOpen = (): void => {
    if (!enabled) return;
    cancelTimers();
    if (phase === "ready") {
      baitAttempted = false;
      beginCast();
      return;
    }
    if (phase === "nobait") {
      if (baitAttempted) {
        // We just baited and the hook is still bare: nothing to bait it with.
        disable(HALT_REASONS.NO_BAIT);
        return;
      }
      bait();
    }
  };

  // React to a bite after a human-plausible delay rather than on the frame
  // the message arrived.
  const onBite = (windowMs: number): void => {
    if (!enabled) return;
    after(core.hookDelayMs(windowMs, rand), () => {
      if (!enabled || phase !== "bite") return;
      const session = openSession();
      if (session && interactions.hookFishing(session)) {
        phase = "hooking";
        record("hook");
        publish();
      }
    });
  };

  const onFight = (params: unknown, seed: number): void => {
    if (!enabled) return;
    const next = core.createFightController(params, { seed });
    const broken = next.params.degraded.filter((field) => MODEL_CRITICAL.has(field));
    if (broken.length) {
      // We cannot model this fight, so we should not be playing it.
      disable(HALT_REASONS.BAD_PARAMS + " (" + broken.join(", ") + ")");
      return;
    }
    controller = next;
  };

  const tally = (outcome: string): void => {
    stats.cycles += 1;
    if (outcome === "caught") stats.landed += 1;
    else if (Object.prototype.hasOwnProperty.call(stats.lost, outcome)) stats.lost[outcome]! += 1;
    else stats.lost.other! += 1;
  };

  // The server's verdict is the authoritative outcome: it feeds the counters
  // and the adaptive power, and the next cycle starts after a randomised pause.
  const onServerVerdict = (outcome: string): void => {
    controller = null;
    if (!enabled) return;
    tally(outcome);
    if (powerOverride === null) {
      const next = core.nextCastPower(castPower, outcome);
      if (next !== castPower) {
        castPower = next;
        save();
      }
    }
    publish();
    after(core.cycleDelayMs(rand), () => kick());
  };

  // Only an ending resets the run: the server's End, the panel's close, and a
  // disconnect all land here, and the run must not restart into a dead session.
  const onSessionEnd = (): void => {
    controller = null;
    cancelTimers();
    if (enabled) disable(HALT_REASONS.SESSION_END);
  };

  // The server session nonce is dead; anything sent now is discarded.
  const onDisconnect = (): void => {
    controller = null;
    cancelTimers();
    if (enabled) disable(HALT_REASONS.DISCONNECTED);
  };

  // ---- Follow the fishing snapshot -----------------------------------------

  let last: InteractionFishing = interactions.getSnapshot().fishing;
  const reconcile = (next: InteractionFishing): void => {
    const previous = last;
    last = next;
    let changed = false;
    if (next.open !== previous.open) {
      controller = null;
      if (next.open) {
        phase = next.open.baited ? "ready" : "nobait";
        changed = true;
        onSessionOpen();
      } else if (!next.end || next.end === previous.end) {
        // The session vanished without an End: the panel closed it, or the
        // connection dropped and the interactions runtime cleared it first.
        phase = "idle";
        changed = true;
        if (isConnected()) onSessionEnd();
        else onDisconnect();
      }
    }
    if (next.bite && next.bite !== previous.bite) {
      phase = "bite";
      changed = true;
      onBite(next.bite.windowMs);
    }
    if (next.fight && next.fight !== previous.fight) {
      phase = "fight";
      changed = true;
      onFight(next.fight.params, next.fight.seed);
    }
    if (next.caught && next.caught !== previous.caught) {
      phase = "caught";
      changed = true;
      onServerVerdict("caught");
    }
    if (next.escaped && next.escaped !== previous.escaped) {
      phase = "escaped";
      changed = true;
      onServerVerdict(next.escaped.reason || "slack");
    }
    if (next.end && next.end !== previous.end) {
      phase = "idle";
      changed = true;
      onSessionEnd();
    }
    if (changed) publish();
  };

  scope.own(
    "subscription",
    interactions.subscribe((next) => reconcile(next.fishing)),
  );

  scope.own(
    "subscription",
    eventBus.subscribe("transport:reconnect-status", (event) => {
      const payload = event.payload as TransportReconnectStatusPayload;
      if (payload.status === "connected") return;
      onDisconnect();
    }),
  );

  scope.own("teardown", () => {
    disposed = true;
    cancelTimers();
    listeners.clear();
    messageListeners.clear();
    pendingMessages = [];
  });

  // ---- Startup -------------------------------------------------------------

  const persisted = load();
  castPower = core.normalizeCastPower(persisted.castPower);
  powerOverride = core.normalizePowerOverride(persisted.powerOverride);
  snapshot = buildSnapshot();
  // A run left on when the client closed comes back armed. It does not send
  // "fish" on its own: at startup the socket is at the login prompt, where
  // "fish" would be typed as a character name.
  if (persisted.enabled === true) enable({ restored: true });

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      if (disposed) return () => {};
      listener(snapshot);
      listeners.add(listener);
      return scope.own("subscription", () => listeners.delete(listener));
    },

    subscribeMessages(listener) {
      if (disposed) return () => {};
      messageListeners.add(listener);
      const backlog = pendingMessages;
      pendingMessages = [];
      for (const message of backlog) listener(message);
      return scope.own("subscription", () => messageListeners.delete(listener));
    },

    enable: () => enable(),
    disable,

    toggle() {
      if (enabled) disable(HALT_REASONS.SWITCHED_OFF);
      else enable();
    },

    setPowerOverride(value) {
      if (disposed) return;
      powerOverride = core.normalizePowerOverride(value);
      save();
      emit(
        "system",
        powerOverride === null
          ? "Auto-Angler cast power: adaptive (currently " + castPower + ")."
          : "Auto-Angler cast power fixed at " + powerOverride + ".",
      );
      publish();
    },

    handleCommand(args) {
      if (disposed) return;
      const parsed = core.parseAutofishCommand(args);
      switch (parsed.action) {
        case "error":
          emit("system", "Auto-Angler: " + (parsed.error ?? "unknown command"));
          return;
        case "on":
          if (enabled) emit("system", "Auto-Angler is already on.");
          else enable();
          return;
        case "off":
          if (!enabled) emit("system", "Auto-Angler is already off.");
          else disable(HALT_REASONS.SWITCHED_OFF);
          return;
        case "power":
          this.setPowerOverride(parsed.override ?? null);
          return;
        default:
          emit("system", core.formatAutofishStatus(status()));
      }
    },

    notifyManualInput() {
      if (enabled) disable(HALT_REASONS.MANUAL);
    },

    notifyFightEnd() {
      controller = null;
      if (phase === "fight") {
        phase = "resolving";
        publish();
      }
    },

    resolveHeld(manualHeld, simState, dtMs) {
      if (!enabled || !controller) return manualHeld;
      return controller.decide(simState, dtMs);
    },
  };
}
