import { deepFreeze } from "../configuration/snapshot";
import type { SessionGmcpBus } from "../gmcp/bus";
import type { TransportReconnectStatusPayload } from "../transport/types";
// @ts-expect-error Retained DPS reducers are JavaScript without a declaration file.
import * as dpsCore from "../../public/js/dps-meter-core.mjs";
import type { SessionEventBus } from "./event-bus";
import type { Unsubscribe } from "./events";
import type { Disposer, ResourceScope } from "./resource-scope";

/** A live fight is re-published once a second so the clock and rolling window keep moving. */
export const DPS_TICK_MS = 1_000;

type DpsModel = { readonly active: boolean } & Record<string, unknown>;

const core = dpsCore as {
  createDpsState(): DpsModel;
  finalizeEncounter(model: DpsModel, now: number): DpsModel;
  reduceDpsEvents(model: DpsModel, payload: unknown, now: number): DpsModel;
  reduceDpsIdle(model: DpsModel, now: number): DpsModel;
  reduceDpsState(model: DpsModel, payload: unknown, now: number): DpsModel;
  resetDpsSession(model: DpsModel, now: number): DpsModel;
  selectDpsView(model: DpsModel, now: number): DpsSnapshot;
};

export interface DpsFigures {
  readonly durationMs: number;
  readonly dps: number | null;
  readonly damage: number;
  readonly swings: number;
  readonly hits: number;
  readonly crits: number;
  readonly hitRate: number | null;
  readonly critRate: number | null;
  readonly [key: string]: unknown;
}

export interface DpsEncounterFigures extends DpsFigures {
  readonly current: number | null;
  readonly peak: number | null;
  readonly bestHit: number;
  readonly misses: number;
  readonly dodges: number;
  readonly absorbed: number;
}

export interface DpsSessionFigures extends DpsFigures {
  readonly encounters: number;
}

export interface DpsHistoryEntry {
  readonly targetName: string;
  readonly dps: number | null;
  readonly durationMs: number;
  readonly [key: string]: unknown;
}

/** The view model selectDpsView produces; see docs/dps-meter.md for the figures. */
export interface DpsSnapshot {
  readonly active: boolean;
  readonly targetName: string;
  readonly hasData: boolean;
  readonly missingDamageNumbers: boolean;
  readonly windowSeconds: number;
  readonly encounter: DpsEncounterFigures;
  readonly session: DpsSessionFigures;
  readonly history: readonly DpsHistoryEntry[];
}

export interface SessionDps {
  getSnapshot(): DpsSnapshot;
  subscribe(listener: (snapshot: DpsSnapshot) => void): Unsubscribe;
  resetSession(): void;
}

export interface SessionDpsOptions {
  now?: () => number;
}

/**
 * Creates the session-owned DPS meter. It consumes the same Darkwind.Combat
 * frames as the combat runtime but keeps its own encounter identity, so it
 * keeps counting while the visual pane is closed, collapsed, or disabled.
 */
export function createSessionDps(
  gmcp: SessionGmcpBus,
  scope: ResourceScope,
  eventBus: SessionEventBus,
  options: SessionDpsOptions = {},
): SessionDps {
  const now = options.now ?? Date.now;
  const listeners = new Set<(snapshot: DpsSnapshot) => void>();
  let model = core.createDpsState();
  let snapshot = deepFreeze(core.selectDpsView(model, now()));
  let ticker: Disposer | null = null;
  let connected = false;
  let disposed = false;

  const stopTicker = (): void => {
    ticker?.();
    ticker = null;
  };

  const publish = (): void => {
    if (disposed) return;
    snapshot = deepFreeze(core.selectDpsView(model, now()));
    for (const listener of [...listeners]) listener(snapshot);
    if (!model.active) {
      stopTicker();
      return;
    }
    if (!ticker) {
      ticker = scope.setInterval(() => {
        if (disposed) return;
        // A quiet fight closes at its last swing; otherwise only the clock moves.
        model = core.reduceDpsIdle(model, now());
        publish();
      }, DPS_TICK_MS);
    }
  };

  const apply = (next: DpsModel): void => {
    if (next === model) return;
    model = next;
    publish();
  };

  const stateHandler = (input: unknown): void => {
    if (disposed) return;
    apply(core.reduceDpsState(model, input, now()));
  };
  const eventsHandler = (input: unknown): void => {
    if (disposed) return;
    apply(core.reduceDpsEvents(model, input, now()));
  };
  // Some servers emit one event per frame instead of a batch; the meter
  // accepts the singular spelling the same way the combat runtime does.
  const eventHandler = (input: unknown): void => {
    if (disposed) return;
    const event =
      input !== null && typeof input === "object" ? (input as Record<string, unknown>) : null;
    if (!event) return;
    apply(
      core.reduceDpsEvents(
        model,
        {
          epoch: event.epoch,
          encounter_id: event.encounter_id,
          first_seq: event.seq,
          last_seq: event.seq,
          events: [event],
        },
        now(),
      ),
    );
  };

  gmcp.on("Darkwind.Combat.State", stateHandler);
  gmcp.on("Darkwind.Combat.Events", eventsHandler);
  gmcp.on("Darkwind.Combat.Event", eventHandler);
  scope.own("listener", () => gmcp.off("Darkwind.Combat.State", stateHandler));
  scope.own("listener", () => gmcp.off("Darkwind.Combat.Events", eventsHandler));
  scope.own("listener", () => gmcp.off("Darkwind.Combat.Event", eventHandler));

  scope.own(
    "subscription",
    eventBus.subscribe("transport:reconnect-status", (event) => {
      const payload = event.payload as TransportReconnectStatusPayload;
      if (payload.status === "connected") {
        connected = true;
        return;
      }
      if (!connected) return;
      connected = false;
      // Close the live fight but keep the session totals on screen. A
      // reconnect arrives with a new epoch, which clears them.
      apply(core.finalizeEncounter(model, now()));
    }),
  );

  scope.own("teardown", () => {
    disposed = true;
    stopTicker();
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

    resetSession() {
      if (disposed) return;
      model = core.resetDpsSession(model, now());
      publish();
    },
  };
}
