import { deepFreeze } from "../configuration/snapshot";
import type { RoomInfo } from "../gmcp/contracts/room";
import type { TransportReconnectStatusPayload } from "../transport/types";
import type { SessionEventBus } from "./event-bus";
import type { Unsubscribe } from "./events";
import type { ResourceScope } from "./resource-scope";
import type { SessionWorld } from "./world";

/**
 * The scene activity feed: what the player is doing in the world, reduced to
 * the beats the Scene panel can act out between fights. A `look` fires when
 * the player sends a look command; a `walk` fires when the room changes,
 * carrying the direction the player went so the figure enters from the right
 * side of the stage. Nothing here talks to the server: looks come from the
 * outbound command stream and walks from the world runtime's room identity.
 */
export type SceneActivityKind = "look" | "walk";

export interface SceneActivity {
  readonly seq: number;
  readonly kind: SceneActivityKind;
  /** Normalised direction of a walk ("n", "sw", "u", ...), or "" when unknown; always "" for a look. */
  readonly direction: string;
  /** Which way the figure faces afterwards: 1 toward stage right, -1 toward stage left. */
  readonly facing: 1 | -1;
  /** Runtime clock reading when the activity was recorded. */
  readonly at: number;
}

export interface SessionActivitySnapshot {
  /** Increments once per activity; a listener that saw this seq has seen `latest`. */
  readonly seq: number;
  readonly latest: SceneActivity | null;
}

export interface SessionActivity {
  getSnapshot(): SessionActivitySnapshot;
  subscribe(listener: (snapshot: SessionActivitySnapshot) => void): Unsubscribe;
}

export interface SessionActivityOptions {
  now?: () => number;
}

export type CommandIntent = { kind: "look" } | { kind: "move"; direction: string };

const DIRECTION_ALIASES: Readonly<Record<string, string>> = {
  n: "n",
  north: "n",
  s: "s",
  south: "s",
  e: "e",
  east: "e",
  w: "w",
  west: "w",
  ne: "ne",
  northeast: "ne",
  nw: "nw",
  northwest: "nw",
  se: "se",
  southeast: "se",
  sw: "sw",
  southwest: "sw",
  u: "u",
  up: "u",
  d: "d",
  down: "d",
};
const LOOK_VERBS = new Set(["look", "l", "glance"]);
/** A movement command older than this no longer explains a room change. */
const PENDING_MOVE_TTL_MS = 6000;
const MAX_PENDING_MOVES = 8;

/**
 * What a command the player sent means to the scene. A look verb with or
 * without a target is a look; a bare direction (short or long form) is a
 * move. Anything else, including a direction with trailing words, is
 * neither.
 */
export function classifyCommand(text: string): CommandIntent | null {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return null;
  const verb = trimmed.split(/\s+/, 1)[0] ?? "";
  if (LOOK_VERBS.has(verb)) return { kind: "look" };
  const direction = DIRECTION_ALIASES[verb];
  if (direction !== undefined && verb === trimmed) return { kind: "move", direction };
  return null;
}

/** Westward and downward travel enters from stage right, everything else from stage left. */
export function facingFor(direction: string): 1 | -1 {
  return direction === "w" || direction === "nw" || direction === "sw" || direction === "d"
    ? -1
    : 1;
}

function roomIdOf(room: RoomInfo | null | undefined): string {
  const id = room?.num ?? room?.id;
  return id === undefined || id === null ? "" : String(id);
}

/**
 * The exit of the previous room that leads to the next one, when its exits
 * name room ids. "" when the rooms are unknown or not adjacent that way.
 */
export function inferDirection(previous: RoomInfo | null, next: RoomInfo | null): string {
  const exits = previous?.exits;
  const target = roomIdOf(next);
  if (!exits || typeof exits !== "object" || !target) return "";
  for (const [direction, destination] of Object.entries(exits)) {
    if (String(destination) !== target) continue;
    const key = direction.toLowerCase();
    return DIRECTION_ALIASES[key] ?? key;
  }
  return "";
}

export function createSessionActivity(
  scope: ResourceScope,
  eventBus: SessionEventBus,
  world: Pick<SessionWorld, "subscribe">,
  options: SessionActivityOptions = {},
): SessionActivity {
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<(snapshot: SessionActivitySnapshot) => void>();
  let snapshot: SessionActivitySnapshot = deepFreeze({ seq: 0, latest: null });
  let pendingMoves: { direction: string; at: number }[] = [];
  let lastRoom: RoomInfo | null = null;
  let lastGeneration: number | null = null;
  // The first room after connecting is where the player is, not a walk.
  let awaitingArrival = true;
  let disposed = false;

  const publish = (kind: SceneActivityKind, direction: string): void => {
    if (disposed) return;
    const seq = snapshot.seq + 1;
    snapshot = deepFreeze({
      seq,
      latest: { seq, kind, direction, facing: facingFor(direction), at: now() },
    });
    for (const listener of [...listeners]) listener(snapshot);
  };

  const prunePendingMoves = (at: number): void => {
    pendingMoves = pendingMoves.filter((move) => at - move.at < PENDING_MOVE_TTL_MS);
  };

  scope.own(
    "subscription",
    eventBus.subscribe("transport:outbound-command", (event) => {
      const payload = event.payload as { text?: unknown };
      const intent = classifyCommand(typeof payload.text === "string" ? payload.text : "");
      if (!intent) return;
      if (intent.kind === "look") {
        publish("look", "");
        return;
      }
      const at = now();
      prunePendingMoves(at);
      pendingMoves.push({ direction: intent.direction, at });
      if (pendingMoves.length > MAX_PENDING_MOVES) {
        pendingMoves.splice(0, pendingMoves.length - MAX_PENDING_MOVES);
      }
    }),
  );

  scope.own(
    "subscription",
    eventBus.subscribe("transport:reconnect-status", (event) => {
      const payload = event.payload as TransportReconnectStatusPayload;
      if (payload.status === "connected") return;
      // The next room after a reconnect is an arrival, not a walk.
      pendingMoves = [];
      awaitingArrival = true;
    }),
  );

  scope.own(
    "subscription",
    world.subscribe((next) => {
      const room = next.room;
      const roomId = roomIdOf(room);
      const changed = lastGeneration !== null && next.roomGeneration !== lastGeneration;
      const previousRoom = lastRoom;
      lastGeneration = next.roomGeneration;
      // Keep the merged Room.Info even for the same room so its exits stay current.
      lastRoom = room;
      if (!changed || !roomId || !next.connected) return;
      if (awaitingArrival) {
        awaitingArrival = false;
        return;
      }
      const at = now();
      prunePendingMoves(at);
      const pending = pendingMoves.shift();
      publish("walk", pending?.direction || inferDirection(previousRoom, room));
    }),
  );

  scope.own("teardown", () => {
    disposed = true;
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
  };
}
