import { deepFreeze } from "../configuration/snapshot";
import type { StorageLike } from "../storage/repository";
import type { Unsubscribe } from "./events";
import type { ResourceScope } from "./resource-scope";

/**
 * The Command Board: a panel of player-defined buttons that each send one
 * command line, with an optional keyboard shortcut that works anywhere in the
 * client. This runtime owns the board's contents and persistence; the panel
 * renders it, records shortcuts, and sends the commands through the terminal
 * so aliases and slash commands apply exactly as if typed.
 *
 * Shortcuts are stored as a modifier prefix plus a KeyboardEvent.code, for
 * example "Alt+Digit1", "Ctrl+Shift+KeyH", or "F5". A shortcut must carry
 * Ctrl, Alt, or Meta, or be a function or numpad key: a bare letter would
 * fire while the player types.
 */
export interface CommandBoardButton {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  /** Normalised shortcut, or "" for none. */
  readonly shortcut: string;
}

export interface CommandBoardSnapshot {
  readonly buttons: readonly CommandBoardButton[];
  /** Grid columns, 1..8. */
  readonly columns: number;
}

export interface CommandBoardButtonInput {
  label?: string;
  command?: string;
  shortcut?: string;
}

/** The parts of a KeyboardEvent a shortcut is read from. */
export interface ShortcutEventLike {
  readonly code: string;
  /** Used to infer the physical key when `code` is empty (some virtual keyboards). */
  readonly key?: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

export interface SessionCommandBoard {
  getSnapshot(): CommandBoardSnapshot;
  subscribe(listener: (snapshot: CommandBoardSnapshot) => void): Unsubscribe;
  addButton(input?: CommandBoardButtonInput): CommandBoardButton;
  updateButton(id: string, patch: CommandBoardButtonInput): boolean;
  removeButton(id: string): boolean;
  /** Moves a button by `delta` places (negative is earlier). */
  moveButton(id: string, delta: number): boolean;
  setColumns(columns: number): void;
  /** The button whose shortcut the key event matches, if any. */
  matchShortcut(event: ShortcutEventLike): CommandBoardButton | null;
  /** Puts the starter buttons back. */
  resetToDefaults(): void;
}

export interface SessionCommandBoardOptions {
  storage?: StorageLike;
  storageKey?: string;
  createId?: () => string;
}

export const COMMAND_BOARD_LIMITS = Object.freeze({
  maxButtons: 48,
  maxLabel: 40,
  maxCommand: 500,
  minColumns: 1,
  maxColumns: 8,
});

export const DEFAULT_COMMAND_BOARD_BUTTONS: readonly CommandBoardButtonInput[] = Object.freeze([
  { label: "Look", command: "look" },
  { label: "Inventory", command: "inventory" },
  { label: "Score", command: "score" },
]);

const DEFAULT_COLUMNS = 3;
const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;
const STANDALONE_CODE = /^(F\d{1,2}|Numpad(\d|Add|Subtract|Multiply|Divide|Decimal|Enter))$/;

const KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num -",
  NumpadMultiply: "Num *",
  NumpadDivide: "Num /",
  NumpadDecimal: "Num .",
  NumpadEnter: "Num Enter",
};

/**
 * A KeyboardEvent.code stand-in derived from `key`, for events that arrive
 * without one: digits, letters, function keys, and named keys.
 */
function inferCode(key: string | undefined): string {
  const value = String(key || "");
  if (!value) return "";
  if (/^\d$/.test(value)) return "Digit" + value;
  if (/^[a-z]$/i.test(value)) return "Key" + value.toUpperCase();
  if (/^F\d{1,2}$/.test(value)) return value;
  if (value.length > 1 && !/\s/.test(value)) return value;
  return "";
}

/**
 * The normalised shortcut for a key event, or null when the combination is
 * not allowed as a shortcut (a modifier alone, or an unmodified ordinary key).
 */
export function shortcutFromEvent(event: ShortcutEventLike): string | null {
  const code = String(event.code || "") || inferCode(event.key);
  if (!code || MODIFIER_CODES.test(code)) return null;
  const modified = event.ctrlKey || event.altKey || event.metaKey;
  if (!modified && !STANDALONE_CODE.test(code)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  parts.push(code);
  return parts.join("+");
}

/** A stored shortcut string re-validated through the same rules, or "". */
export function normalizeShortcut(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const parts = value.trim().split("+");
  const code = parts.pop() ?? "";
  const mods = new Set(parts);
  const known = ["Ctrl", "Alt", "Shift", "Meta"];
  if ([...mods].some((mod) => !known.includes(mod))) return "";
  return (
    shortcutFromEvent({
      code,
      ctrlKey: mods.has("Ctrl"),
      altKey: mods.has("Alt"),
      shiftKey: mods.has("Shift"),
      metaKey: mods.has("Meta"),
    }) ?? ""
  );
}

/** Human-readable form of a shortcut: "Alt+1", "Ctrl+Shift+H", "F5", "Num 1". */
export function shortcutLabel(shortcut: string): string {
  if (!shortcut) return "";
  const parts = shortcut.split("+");
  const code = parts.pop() ?? "";
  let key = KEY_LABELS[code];
  if (key === undefined) {
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit\d$/.test(code)) key = code.slice(5);
    else if (/^Numpad\d$/.test(code)) key = "Num " + code.slice(6);
    else key = code;
  }
  return [...parts, key].join("+");
}

function clampInt(value: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function normalizeButton(raw: unknown, id: string): CommandBoardButton {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    id,
    label: cleanText(source.label, COMMAND_BOARD_LIMITS.maxLabel),
    command: cleanText(source.command, COMMAND_BOARD_LIMITS.maxCommand),
    shortcut: normalizeShortcut(source.shortcut),
  };
}

/** A stored or supplied board, bounded and cleaned. Unknown shapes give an empty board. */
export function normalizeBoard(raw: unknown, createId: () => string): CommandBoardSnapshot {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const seen = new Set<string>();
  const buttons: CommandBoardButton[] = [];
  const list = Array.isArray(source.buttons) ? source.buttons : [];
  for (const entry of list.slice(0, COMMAND_BOARD_LIMITS.maxButtons)) {
    const rawId =
      entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
        ? (entry as { id: string }).id
        : "";
    let id = rawId && !seen.has(rawId) ? rawId : createId();
    while (seen.has(id)) id = createId();
    seen.add(id);
    buttons.push(normalizeButton(entry, id));
  }
  return {
    buttons,
    columns: clampInt(
      source.columns,
      DEFAULT_COLUMNS,
      COMMAND_BOARD_LIMITS.minColumns,
      COMMAND_BOARD_LIMITS.maxColumns,
    ),
  };
}

export function createSessionCommandBoard(
  scope: ResourceScope,
  options: SessionCommandBoardOptions = {},
): SessionCommandBoard {
  let counter = 0;
  const createId =
    options.createId ?? (() => `b${Date.now().toString(36)}${(counter++).toString(36)}`);
  const listeners = new Set<(snapshot: CommandBoardSnapshot) => void>();
  let disposed = false;

  const defaults = (): CommandBoardSnapshot => ({
    buttons: DEFAULT_COMMAND_BOARD_BUTTONS.map((input) => normalizeButton(input, createId())),
    columns: DEFAULT_COLUMNS,
  });

  const load = (): CommandBoardSnapshot => {
    if (!options.storage || !options.storageKey) return defaults();
    try {
      const raw = options.storage.getItem(options.storageKey);
      if (raw === null) return defaults();
      return normalizeBoard(JSON.parse(raw), createId);
    } catch {
      return defaults();
    }
  };

  let snapshot: CommandBoardSnapshot = deepFreeze(load());

  const save = (): void => {
    if (!options.storage || !options.storageKey) return;
    try {
      options.storage.setItem(
        options.storageKey,
        JSON.stringify({ version: 1, columns: snapshot.columns, buttons: snapshot.buttons }),
      );
    } catch (error) {
      console.warn("Command Board could not save", error);
    }
  };

  const commit = (next: CommandBoardSnapshot): void => {
    if (disposed) return;
    snapshot = deepFreeze(next);
    save();
    for (const listener of [...listeners]) listener(snapshot);
  };

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

    addButton(input = {}) {
      const button = normalizeButton(input, createId());
      if (disposed || snapshot.buttons.length >= COMMAND_BOARD_LIMITS.maxButtons) return button;
      commit({ ...snapshot, buttons: [...snapshot.buttons, button] });
      return button;
    },

    updateButton(id, patch) {
      const index = snapshot.buttons.findIndex((button) => button.id === id);
      if (disposed || index < 0) return false;
      const current = snapshot.buttons[index]!;
      const next = normalizeButton(
        {
          label: patch.label !== undefined ? patch.label : current.label,
          command: patch.command !== undefined ? patch.command : current.command,
          shortcut: patch.shortcut !== undefined ? patch.shortcut : current.shortcut,
        },
        id,
      );
      const buttons = snapshot.buttons.slice();
      buttons[index] = next;
      commit({ ...snapshot, buttons });
      return true;
    },

    removeButton(id) {
      if (disposed || !snapshot.buttons.some((button) => button.id === id)) return false;
      commit({ ...snapshot, buttons: snapshot.buttons.filter((button) => button.id !== id) });
      return true;
    },

    moveButton(id, delta) {
      const from = snapshot.buttons.findIndex((button) => button.id === id);
      if (disposed || from < 0) return false;
      const to = Math.max(0, Math.min(snapshot.buttons.length - 1, from + Math.trunc(delta)));
      if (to === from) return false;
      const buttons = snapshot.buttons.slice();
      const [button] = buttons.splice(from, 1);
      buttons.splice(to, 0, button!);
      commit({ ...snapshot, buttons });
      return true;
    },

    setColumns(columns) {
      if (disposed) return;
      const next = clampInt(
        columns,
        snapshot.columns,
        COMMAND_BOARD_LIMITS.minColumns,
        COMMAND_BOARD_LIMITS.maxColumns,
      );
      if (next !== snapshot.columns) commit({ ...snapshot, columns: next });
    },

    matchShortcut(event) {
      const shortcut = shortcutFromEvent(event);
      if (!shortcut) return null;
      return (
        snapshot.buttons.find((button) => button.shortcut === shortcut && button.command) ?? null
      );
    },

    resetToDefaults() {
      if (disposed) return;
      commit(defaults());
    },
  };
}
