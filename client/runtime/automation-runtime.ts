import type { ResourceScope } from "./resource-scope";

const GMCP_VARIABLE_PREFIX = "gmcp";

/** Minimal timer definition shape consumed by reconcileTimers. */
export interface EffectiveTimerDefinition {
  id: string;
  enabled?: boolean;
  autoStart?: boolean;
}

/** Runtime metadata tracked for one scheduled timer id. */
export interface TimerRuntimeState {
  startedAt: number;
  fireAt: number;
}

/** Session-owned automation execution state: variables, GMCP variables, and timers. */
export interface AutomationRuntimeState {
  getVariable(name: string): string | undefined;
  setVariable(name: string, value: string): boolean;
  removeVariable(name: string): void;
  listVariableNames(): string[];
  getAutomationVariables(): Record<string, string>;
  setGmcpVariable(packageName: string, data: unknown): void;
  resetGmcpVariables(): void;
  getGmcpVariables(): Record<string, string>;
  listGmcpVariables(): Array<{ name: string; value: string }>;
  scheduleTimer(timerId: string, durationMs: number, onFire: () => void): void;
  clearTimer(timerId: string): void;
  getTimerRuntimeState(timerId: string): TimerRuntimeState | null;
  scheduleWait(delayMs: number): Promise<void>;
  reconcileTimers(
    effectiveTimers: EffectiveTimerDefinition[],
    onStart: (timer: EffectiveTimerDefinition) => void,
  ): void;
  dispose(): void;
}

interface TimerRegistryEntry {
  startedAt: number;
  fireAt: number;
  disposer: () => void;
}

function normalizeWhitespace(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

// Segment names repeat endlessly across a session (every inventory item has
// an "id", a "name", ...), so the regex normalisation runs once per distinct
// key. The cache is cleared if it ever grows past a sane size.
const SEGMENT_CACHE_LIMIT = 20_000;
const segmentCache = new Map<string, string>();

/** Mirrors gmcp-variables.js toVariableSegment for identical variable naming. */
function toVariableSegment(value: unknown): string {
  const raw = String(value || "");
  const cached = segmentCache.get(raw);
  if (cached !== undefined) return cached;
  const segment = raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (segmentCache.size >= SEGMENT_CACHE_LIMIT) segmentCache.clear();
  segmentCache.set(raw, segment);
  return segment;
}

/** Mirrors gmcp-variables.js variableNameFor. */
function variableNameFor(parts: string[]): string {
  return [GMCP_VARIABLE_PREFIX, ...parts].map(toVariableSegment).filter(Boolean).join("_");
}

/** The name a child key gets under an already-built parent name. */
function childVariableName(parentName: string, key: string): string {
  const segment = toVariableSegment(key);
  if (!segment) return parentName;
  return parentName ? `${parentName}_${segment}` : segment;
}

/** Mirrors gmcp-variables.js serializeValue. */
function serializeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function setGmcpVariableEntry(
  gmcpVariables: Map<string, string>,
  name: string,
  value: unknown,
): void {
  if (!name || name === GMCP_VARIABLE_PREFIX) return;
  gmcpVariables.set(name, serializeValue(value));
}

/**
 * Mirrors gmcp-variables.js flattenValue. The name is built incrementally on
 * the way down rather than re-normalising the whole path at every node, which
 * for a large inventory list was the bulk of each frame's handling time.
 */
function flattenValue(gmcpVariables: Map<string, string>, name: string, value: unknown): void {
  if (value === undefined) return;

  if (value === null || typeof value !== "object") {
    setGmcpVariableEntry(gmcpVariables, name, value);
    return;
  }

  setGmcpVariableEntry(gmcpVariables, name, value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flattenValue(gmcpVariables, childVariableName(name, String(index)), item);
    });
    return;
  }

  Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
    flattenValue(gmcpVariables, childVariableName(name, key), item);
  });
}

/** Creates session-owned automation execution state backed by one resource scope. */
export function createAutomationRuntimeState(
  scope: ResourceScope,
  initialVariables: Record<string, string> = {},
  persistVariables?: (variables: Record<string, string>) => boolean,
): AutomationRuntimeState {
  const userVariables = new Map(Object.entries(initialVariables));
  const gmcpVariables = new Map<string, string>();
  // Frames waiting to be flattened, latest payload per package. Variables are
  // read when an alias, trigger, or function runs and when the settings
  // dialog lists them; between reads a busy fight can deliver hundreds of
  // frames whose flattening nobody would have seen. Every frame also arrives
  // here twice (the session's own handler and the legacy compat bridge), and
  // keying by package collapses that duplicate to one entry.
  const pendingGmcpFrames = new Map<string, { name: string; data: unknown }>();
  const drainGmcpFrames = (): void => {
    if (!pendingGmcpFrames.size) return;
    const frames = Array.from(pendingGmcpFrames.values());
    pendingGmcpFrames.clear();
    for (const frame of frames) flattenValue(gmcpVariables, frame.name, frame.data);
  };
  const timerRegistry = new Map<string, TimerRegistryEntry>();

  const persistUserVariables = (): boolean =>
    persistVariables?.(Object.fromEntries(userVariables.entries())) !== false;

  const clearTimer = (timerId: string): void => {
    const key = String(timerId || "");
    if (!key) return;
    const entry = timerRegistry.get(key);
    if (!entry) return;
    entry.disposer();
    timerRegistry.delete(key);
  };

  const scheduleTimer = (timerId: string, durationMs: number, onFire: () => void): void => {
    const key = String(timerId || "");
    if (!key) return;

    clearTimer(key);

    const startedAt = Date.now();
    const fireAt = startedAt + durationMs;
    const disposer = scope.setTimeout(() => {
      timerRegistry.delete(key);
      onFire();
    }, durationMs);

    timerRegistry.set(key, { startedAt, fireAt, disposer });
  };

  return {
    getVariable(name: string): string | undefined {
      return userVariables.get(name);
    },

    setVariable(name: string, value: string): boolean {
      const cleanName = normalizeWhitespace(name);
      if (!cleanName) return false;
      const nextValue = String(value ?? "");
      const previousValue = userVariables.get(cleanName);
      if (previousValue === nextValue) return true;
      userVariables.set(cleanName, nextValue);
      if (!persistUserVariables()) {
        if (previousValue === undefined) userVariables.delete(cleanName);
        else userVariables.set(cleanName, previousValue);
        return false;
      }
      return true;
    },

    removeVariable(name: string): void {
      if (!name || !userVariables.has(name)) return;
      const previousValue = userVariables.get(name)!;
      userVariables.delete(name);
      if (!persistUserVariables()) userVariables.set(name, previousValue);
    },

    listVariableNames(): string[] {
      return Array.from(userVariables.keys()).sort((left, right) => left.localeCompare(right));
    },

    getAutomationVariables(): Record<string, string> {
      drainGmcpFrames();
      const merged: Record<string, string> = {};
      for (const [name, value] of gmcpVariables.entries()) {
        merged[name] = value;
      }
      for (const [name, value] of userVariables.entries()) {
        merged[name] = value;
      }
      return merged;
    },

    setGmcpVariable(packageName: string, data: unknown): void {
      const packageParts = String(packageName || "")
        .split(".")
        .map(toVariableSegment)
        .filter(Boolean);

      if (!packageParts.length) return;
      const name = variableNameFor(packageParts);
      // Re-insert so drain order follows the latest arrival of each package.
      pendingGmcpFrames.delete(name);
      pendingGmcpFrames.set(name, { name, data: data === undefined ? "" : data });
    },

    resetGmcpVariables(): void {
      pendingGmcpFrames.clear();
      gmcpVariables.clear();
    },

    getGmcpVariables(): Record<string, string> {
      drainGmcpFrames();
      return Object.fromEntries(gmcpVariables.entries());
    },

    listGmcpVariables(): Array<{ name: string; value: string }> {
      drainGmcpFrames();
      return Array.from(gmcpVariables.entries())
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([name, value]) => ({ name, value }));
    },

    scheduleTimer,

    clearTimer,

    getTimerRuntimeState(timerId: string): TimerRuntimeState | null {
      const entry = timerRegistry.get(String(timerId || ""));
      return entry ? { startedAt: entry.startedAt, fireAt: entry.fireAt } : null;
    },

    scheduleWait(delayMs: number): Promise<void> {
      if (delayMs <= 0) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        scope.setTimeout(() => {
          resolve();
        }, delayMs);
      });
    },

    reconcileTimers(
      effectiveTimers: EffectiveTimerDefinition[],
      onStart: (timer: EffectiveTimerDefinition) => void,
    ): void {
      const effectiveById = new Map<string, EffectiveTimerDefinition>();
      for (const timer of effectiveTimers) {
        if (timer && timer.id) {
          effectiveById.set(timer.id, timer);
        }
      }

      for (const timerId of Array.from(timerRegistry.keys())) {
        const definition = effectiveById.get(timerId);
        if (!definition || definition.enabled === false) {
          clearTimer(timerId);
        }
      }

      for (const timer of effectiveTimers) {
        if (!timer || !timer.id || timer.enabled === false || !timer.autoStart) {
          continue;
        }
        if (timerRegistry.has(timer.id)) {
          continue;
        }
        onStart(timer);
      }
    },

    dispose(): void {
      userVariables.clear();
      gmcpVariables.clear();
      timerRegistry.clear();
    },
  };
}
