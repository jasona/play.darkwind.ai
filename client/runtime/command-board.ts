import type { CharacterConfigurationSnapshot, SessionConfiguration } from "../configuration/editor";
import { deepFreeze } from "../configuration/snapshot";
import type { CommandButtonDefinition, ConfigSourceKind } from "../model/configuration";
import type { StorageLike } from "../storage/repository";
import type { Unsubscribe } from "./events";
import type { ResourceScope } from "./resource-scope";

/**
 * The Command Board: a panel of player-defined buttons that each send one
 * command line, with an optional keyboard shortcut that works anywhere in the
 * client.
 *
 * The buttons are configuration: the "commandButtons" kind of the
 * configuration graph, so they live beside aliases and key mappings, appear
 * in Settings, travel with exports, and can be shared through configuration
 * sets. This runtime projects the character's effective command buttons for
 * the panel, edits the character's local definitions on its behalf, and
 * applies the shortcut rules. Only the grid's column count is the panel's
 * own, kept in local storage as a layout preference.
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
  readonly enabled: boolean;
  /** Where the definition came from; only "local" buttons are edited from the panel. */
  readonly source: ConfigSourceKind;
}

export interface CommandBoardSnapshot {
  /** Effective buttons in resolution order: shared sets first, then the character's own. */
  readonly buttons: readonly CommandBoardButton[];
  /** Grid columns, 1..8. */
  readonly columns: number;
}

export interface CommandBoardButtonInput {
  label?: string;
  command?: string;
  shortcut?: string;
  enabled?: boolean;
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
  /** Whether the panel may edit this button (it is one of the character's own). */
  isEditable(id: string): boolean;
  /** Appends a local button; null when the write was refused. */
  addButton(input?: CommandBoardButtonInput): CommandBoardButton | null;
  updateButton(id: string, patch: CommandBoardButtonInput): boolean;
  removeButton(id: string): boolean;
  /** Moves a local button by `delta` places among the local buttons (negative is earlier). */
  moveButton(id: string, delta: number): boolean;
  setColumns(columns: number): void;
  /** The enabled button whose shortcut the key event matches, if any. */
  matchShortcut(event: ShortcutEventLike): CommandBoardButton | null;
  /** Replaces the character's own buttons with the starter set. */
  resetToDefaults(): boolean;
}

export interface SessionCommandBoardOptions {
  /** Where the column count persists. */
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

/** A command button definition with every field cleaned and bounded. */
export function normalizeCommandButton(raw: unknown, id: string): CommandButtonDefinition {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    id,
    enabled: source.enabled === undefined ? true : Boolean(source.enabled),
    label: cleanText(source.label, COMMAND_BOARD_LIMITS.maxLabel),
    command: cleanText(source.command, COMMAND_BOARD_LIMITS.maxCommand),
    shortcut: normalizeShortcut(source.shortcut),
  };
}

/** The grid column count from a stored preference record, bounded. */
export function normalizeColumns(raw: unknown): number {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return clampInt(
    source.columns,
    DEFAULT_COLUMNS,
    COMMAND_BOARD_LIMITS.minColumns,
    COMMAND_BOARD_LIMITS.maxColumns,
  );
}

function fallbackId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `b${Date.now().toString(36)}${random}`;
}

export function createSessionCommandBoard(
  scope: ResourceScope,
  configuration: Pick<SessionConfiguration, "subscribe" | "replaceLocalDefinitions">,
  options: SessionCommandBoardOptions = {},
): SessionCommandBoard {
  const createId =
    options.createId ??
    (() =>
      typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : fallbackId());
  const listeners = new Set<(snapshot: CommandBoardSnapshot) => void>();
  let disposed = false;
  let local: CommandButtonDefinition[] = [];
  let effective: CommandBoardButton[] = [];
  let columns = DEFAULT_COLUMNS;
  let snapshot: CommandBoardSnapshot = deepFreeze({ buttons: [], columns });

  // ---- Column preference -----------------------------------------------------

  const loadColumns = (): number => {
    if (!options.storage || !options.storageKey) return DEFAULT_COLUMNS;
    try {
      const raw = options.storage.getItem(options.storageKey);
      return raw === null ? DEFAULT_COLUMNS : normalizeColumns(JSON.parse(raw));
    } catch {
      return DEFAULT_COLUMNS;
    }
  };

  const saveColumns = (): void => {
    if (!options.storage || !options.storageKey) return;
    try {
      options.storage.setItem(options.storageKey, JSON.stringify({ version: 2, columns }));
    } catch (error) {
      console.warn("Command Board could not save its layout", error);
    }
  };

  // ---- Projection ------------------------------------------------------------

  const publish = (): void => {
    if (disposed) return;
    snapshot = deepFreeze({ buttons: effective, columns });
    for (const listener of [...listeners]) listener(snapshot);
  };

  const project = (config: CharacterConfigurationSnapshot): void => {
    local = config.localDefinitions.commandButtons.map((definition) =>
      normalizeCommandButton(definition, definition.id),
    );
    effective = config.effectiveConfiguration.commandButtons.map(({ definition, source }) => ({
      ...normalizeCommandButton(definition, definition.id),
      source: source.kind,
    }));
  };

  const writeLocal = (next: CommandButtonDefinition[]): boolean => {
    if (disposed) return false;
    const result = configuration.replaceLocalDefinitions("commandButtons", next);
    if (!result.success) {
      console.warn("Command Board could not save", result.message);
      return false;
    }
    return true;
  };

  const localIndex = (id: string): number => local.findIndex((button) => button.id === id);

  columns = loadColumns();
  // The configuration snapshot reads the stored graph and throws when the
  // graph is not in storage (compatibility harnesses build sessions that way).
  // The board then simply has no buttons; writes report their own failure.
  try {
    scope.own(
      "subscription",
      configuration.subscribe((config) => {
        project(config);
        publish();
      }),
    );
  } catch (error) {
    console.warn("Command Board could not read the configuration graph", error);
  }

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

    isEditable(id) {
      return localIndex(id) >= 0;
    },

    addButton(input = {}) {
      if (disposed || local.length >= COMMAND_BOARD_LIMITS.maxButtons) return null;
      const definition = normalizeCommandButton(input, createId());
      if (!writeLocal([...local, definition])) return null;
      return { ...definition, source: "local" };
    },

    updateButton(id, patch) {
      const index = localIndex(id);
      if (index < 0) return false;
      const current = local[index]!;
      const next = normalizeCommandButton(
        {
          enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
          label: patch.label !== undefined ? patch.label : current.label,
          command: patch.command !== undefined ? patch.command : current.command,
          shortcut: patch.shortcut !== undefined ? patch.shortcut : current.shortcut,
        },
        id,
      );
      const definitions = local.slice();
      definitions[index] = next;
      return writeLocal(definitions);
    },

    removeButton(id) {
      if (localIndex(id) < 0) return false;
      return writeLocal(local.filter((button) => button.id !== id));
    },

    moveButton(id, delta) {
      const from = localIndex(id);
      if (from < 0) return false;
      const to = Math.max(0, Math.min(local.length - 1, from + Math.trunc(delta)));
      if (to === from) return false;
      const definitions = local.slice();
      const [button] = definitions.splice(from, 1);
      definitions.splice(to, 0, button!);
      return writeLocal(definitions);
    },

    setColumns(next) {
      if (disposed) return;
      const value = clampInt(
        next,
        columns,
        COMMAND_BOARD_LIMITS.minColumns,
        COMMAND_BOARD_LIMITS.maxColumns,
      );
      if (value === columns) return;
      columns = value;
      saveColumns();
      publish();
    },

    matchShortcut(event) {
      const shortcut = shortcutFromEvent(event);
      if (!shortcut) return null;
      return (
        effective.find(
          (button) => button.enabled && button.shortcut === shortcut && button.command,
        ) ?? null
      );
    },

    resetToDefaults() {
      return writeLocal(
        DEFAULT_COMMAND_BOARD_BUTTONS.map((input) => normalizeCommandButton(input, createId())),
      );
    },
  };
}
