import { deepFreeze } from "../configuration/snapshot";
import type { SessionGmcpBus } from "../gmcp/bus";
import type { CharEnemy, CharItem, CharStatus, CharVitals } from "../gmcp/contracts/char";
import type {
  DarkwindCombatActor,
  DarkwindCombatEvent,
  DarkwindCombatEvents,
  DarkwindCombatOverflow,
} from "../gmcp/contracts/combat";
import {
  normalizeDarkwindCombatEvent,
  normalizeDarkwindCombatEvents,
  normalizeDarkwindCombatState,
} from "../gmcp/contracts/combat";
import type { DarkwindAvatar } from "../gmcp/contracts/information";
import { validateCharEnemy } from "../gmcp/contracts/validators";
import type { TransportReconnectStatusPayload } from "../transport/types";
// @ts-expect-error Retained combat reducer is JavaScript without a declaration file.
import * as combatCore from "../../public/js/combat-visual-core.mjs";
import type { SessionEventBus } from "./event-bus";
import type { Unsubscribe } from "./events";
import type { SessionInformation } from "./information";
import type { Disposer, ResourceScope } from "./resource-scope";

const {
  clearCurrentCombatEvent,
  createCombatVisualState,
  reduceCombatEvents,
  reduceCombatState,
  takeNextCombatEvent,
} = combatCore;

export const COMBAT_BEAT_MS = 440;

export interface SessionCombatEvent extends Omit<DarkwindCombatEvent, "actor_id" | "target_id"> {
  readonly actorId: string;
  readonly targetId: string;
  readonly receivedAt: number;
}

export interface SessionCombatModel {
  readonly epoch: string;
  readonly encounterId: string;
  readonly stateSeq: number;
  readonly lastSeq: number;
  readonly visualEnabled: boolean;
  readonly effective: boolean;
  readonly active: boolean;
  readonly currentActorId: string;
  readonly currentTargetId: string;
  readonly actors: readonly DarkwindCombatActor[];
  readonly outcome: string;
  readonly summary: string;
  readonly history: readonly SessionCombatEvent[];
  readonly pending: readonly SessionCombatEvent[];
  readonly overflow: Readonly<DarkwindCombatOverflow>;
  readonly currentEvent: SessionCombatEvent | null;
  readonly announcement: string;
  readonly reducedMotion: boolean;
  readonly receivedAt: number;
  readonly limits: Readonly<{ history: number; queue: number; staleMs: number }>;
}

export interface SessionCombatSnapshot {
  readonly connected: boolean;
  readonly presentationReady: boolean;
  readonly shouldPresent: boolean;
  readonly model: SessionCombatModel;
  readonly enemy: Readonly<CharEnemy> | null;
  readonly vitals: Readonly<CharVitals> | null;
  readonly avatar: Readonly<DarkwindAvatar> | null;
  /** Recipient-only Char.Status, for the stage's player descriptor and portrait fallback. */
  readonly status: Readonly<CharStatus> | null;
  /** Recipient-only Char.Items inventory, for the stage's wielded and worn equipment. */
  readonly inventory: readonly CharItem[];
  readonly presentationGeneration: number;
  readonly manuallyDismissedEncounter: string;
}

export interface SessionCombat {
  getSnapshot(): SessionCombatSnapshot;
  subscribe(listener: (snapshot: SessionCombatSnapshot) => void): Unsubscribe;
  setPresentationReady(ready: boolean): void;
  dismissEncounter(): void;
  setReducedMotion(reduced: boolean): void;
}

function cleanEnemy(enemy: CharEnemy): CharEnemy {
  return {
    ...(enemy.enemy_name === undefined ? {} : { enemy_name: enemy.enemy_name }),
    ...(enemy.enemy_curhp === undefined ? {} : { enemy_curhp: enemy.enemy_curhp }),
    ...(enemy.enemy_maxhp === undefined ? {} : { enemy_maxhp: enemy.enemy_maxhp }),
    ...(enemy.enemy_cursp === undefined ? {} : { enemy_cursp: enemy.enemy_cursp }),
    ...(enemy.enemy_maxsp === undefined ? {} : { enemy_maxsp: enemy.enemy_maxsp }),
    ...(enemy.enemy_hp_string === undefined ? {} : { enemy_hp_string: enemy.enemy_hp_string }),
    ...(enemy.enemy_is_npc === undefined ? {} : { enemy_is_npc: enemy.enemy_is_npc }),
    ...(enemy.enemy_image === undefined ? {} : { enemy_image: enemy.enemy_image }),
  };
}

/** Creates the session-owned Combat reducer, fallback handshake, and presentation lifecycle. */
export function createSessionCombat(
  gmcp: SessionGmcpBus,
  scope: ResourceScope,
  eventBus: SessionEventBus,
  information: SessionInformation,
): SessionCombat {
  let connected = false;
  let rendererHealthy = false;
  let advertisedReady = false;
  let model = createCombatVisualState() as SessionCombatModel;
  let enemy: Readonly<CharEnemy> | null = null;
  let informationSnapshot = information.getSnapshot();
  let presentationGeneration = 0;
  let manuallyDismissedEncounter = "";
  let cancelBeat: Disposer | null = null;
  let disposed = false;
  const listeners = new Set<(snapshot: SessionCombatSnapshot) => void>();

  const canPresent = (): boolean =>
    connected &&
    model.visualEnabled &&
    model.active &&
    !!model.encounterId &&
    manuallyDismissedEncounter !== model.encounterId;

  const createSnapshot = (): SessionCombatSnapshot =>
    deepFreeze({
      connected,
      presentationReady: canPresent() && rendererHealthy,
      shouldPresent: canPresent(),
      model,
      enemy,
      vitals: informationSnapshot.vitals,
      avatar: informationSnapshot.avatar,
      status: informationSnapshot.status,
      inventory: informationSnapshot.inventory,
      presentationGeneration,
      manuallyDismissedEncounter,
    });

  let snapshot = createSnapshot();

  const publish = (): void => {
    if (disposed) return;
    snapshot = createSnapshot();
    for (const listener of [...listeners]) listener(snapshot);
  };

  const stopBeat = (): void => {
    cancelBeat?.();
    cancelBeat = null;
  };

  const syncReadiness = (reason: string, force = false): void => {
    const ready = canPresent() && rendererHealthy;
    if (!force && ready === advertisedReady) return;
    const sent = gmcp.sendSubscriptions({
      reason,
      features: { combatPane: ready },
    });
    if (!ready || sent) advertisedReady = ready;
    if (ready && sent) gmcp.sendCombatResync();
  };

  const drainEvents = (): void => {
    if (cancelBeat || !model.visualEnabled || !model.active) return;
    const taken = takeNextCombatEvent(model) as {
      event: SessionCombatEvent | null;
      state: SessionCombatModel;
    };
    model = taken.state;
    publish();
    if (!taken.event) return;
    cancelBeat = scope.setTimeout(() => {
      cancelBeat = null;
      if (disposed) return;
      model = clearCurrentCombatEvent(model) as SessionCombatModel;
      publish();
      drainEvents();
    }, COMBAT_BEAT_MS);
  };

  const acceptEvents = (events: DarkwindCombatEvents): void => {
    const next = reduceCombatEvents(model, events) as SessionCombatModel;
    if (next === model) return;
    model = next;
    drainEvents();
  };

  const stateHandler = (input: unknown): void => {
    if (disposed || !connected) return;
    const state = normalizeDarkwindCombatState(input);
    if (!state) return;
    const previous = model;
    const next = reduceCombatState(previous, state) as SessionCombatModel;
    if (next === previous) return;
    const newEncounter = next.epoch !== previous.epoch || next.encounterId !== previous.encounterId;
    model = next;
    if (newEncounter) {
      stopBeat();
      manuallyDismissedEncounter = "";
    }
    if (!model.visualEnabled || !model.active) {
      stopBeat();
      rendererHealthy = false;
      if (!model.visualEnabled) manuallyDismissedEncounter = "";
    }
    presentationGeneration += 1;
    publish();
    syncReadiness(model.active ? "combat-state" : "combat-ended");
  };

  const eventsHandler = (input: unknown): void => {
    if (disposed || !connected) return;
    const events = normalizeDarkwindCombatEvents(input);
    if (events) acceptEvents(events);
  };

  const eventHandler = (input: unknown): void => {
    if (disposed || !connected) return;
    const event = normalizeDarkwindCombatEvent(input);
    if (!event) return;
    acceptEvents({
      epoch: event.epoch,
      encounter_id: event.encounter_id,
      first_seq: event.seq,
      last_seq: event.seq,
      events: [event],
      overflow: { omitted: 0, hits: 0, damage: 0 },
    });
  };

  gmcp.on("Darkwind.Combat.State", stateHandler);
  gmcp.on("Darkwind.Combat.Events", eventsHandler);
  gmcp.on("Darkwind.Combat.Event", eventHandler);
  scope.own("listener", () => gmcp.off("Darkwind.Combat.State", stateHandler));
  scope.own("listener", () => gmcp.off("Darkwind.Combat.Events", eventsHandler));
  scope.own("listener", () => gmcp.off("Darkwind.Combat.Event", eventHandler));

  const enemyHandler = (input: unknown): void => {
    if (disposed || !connected) return;
    const validated = validateCharEnemy(input);
    if (!validated.success) return;
    enemy = deepFreeze(cleanEnemy(validated.data));
    publish();
  };
  gmcp.on("Char.Enemy", enemyHandler);
  scope.own("listener", () => gmcp.off("Char.Enemy", enemyHandler));

  const recoveredHandler = (): void => {
    if (!disposed && connected) syncReadiness("combat-session-recovered", true);
  };
  gmcp.on("Darkwind.Session.Recovered", recoveredHandler);
  scope.own("listener", () => gmcp.off("Darkwind.Session.Recovered", recoveredHandler));

  scope.own(
    "subscription",
    information.subscribe((next) => {
      informationSnapshot = next;
      publish();
    }),
  );

  scope.own(
    "subscription",
    eventBus.subscribe("transport:reconnect-status", (event) => {
      const payload = event.payload as TransportReconnectStatusPayload;
      if (payload.status === "connected") {
        if (connected) return;
        connected = true;
        presentationGeneration += 1;
        publish();
        return;
      }
      if (!connected) return;
      connected = false;
      rendererHealthy = false;
      advertisedReady = false;
      stopBeat();
      model = createCombatVisualState({ reducedMotion: model.reducedMotion }) as SessionCombatModel;
      enemy = null;
      manuallyDismissedEncounter = "";
      presentationGeneration += 1;
      gmcp.sendSubscriptions({ reason: "reconnect", features: { combatPane: false } });
      publish();
    }),
  );

  scope.own("teardown", () => {
    stopBeat();
    if (advertisedReady) {
      gmcp.sendSubscriptions({ features: { combatPane: false } });
    }
    connected = false;
    rendererHealthy = false;
    advertisedReady = false;
    model = createCombatVisualState({ reducedMotion: model.reducedMotion }) as SessionCombatModel;
    enemy = null;
    informationSnapshot = {
      ...informationSnapshot,
      vitals: null,
      avatar: null,
      status: null,
      inventory: [],
    };
    manuallyDismissedEncounter = "";
    presentationGeneration += 1;
    disposed = true;
    snapshot = createSnapshot();
    listeners.clear();
  });

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      if (disposed) return () => {};
      listener(snapshot);
      listeners.add(listener);
      return scope.own("subscription", () => listeners.delete(listener));
    },

    setPresentationReady(ready) {
      if (disposed) return;
      if (ready && !canPresent()) return;
      rendererHealthy = ready;
      presentationGeneration += 1;
      publish();
      syncReadiness(ready ? "combat-render-ready" : "combat-render-unavailable");
    },

    dismissEncounter() {
      if (disposed || !model.active || !model.encounterId) return;
      manuallyDismissedEncounter = model.encounterId;
      rendererHealthy = false;
      presentationGeneration += 1;
      publish();
      syncReadiness("combat-dismissed");
    },

    setReducedMotion(reduced) {
      if (disposed || model.reducedMotion === reduced) return;
      model = { ...model, reducedMotion: reduced };
      publish();
    },
  };
}
