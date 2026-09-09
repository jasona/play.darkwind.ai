import type {
  AliasDefinition,
  CommandButtonDefinition,
  ConfigSourceMetadata,
  FunctionDefinition,
  HighlightDefinition,
  KeyMappingDefinition,
  LocalDefinitions,
  TimerDefinition,
  TriggerDefinition,
} from "../model/configuration";
import type { CharacterProfileId } from "../model/ids";
import { createEmptyLocalDefinitions } from "../model/profiles";

/** One effective definition with provenance metadata for a resolved snapshot. */
export interface EffectiveDefinition<T> {
  definition: T;
  source: ConfigSourceMetadata;
}

/** Resolved effective configuration for one character profile across all six kinds. */
export interface EffectiveConfigurationSnapshot {
  characterProfileId: CharacterProfileId;
  aliases: EffectiveDefinition<AliasDefinition>[];
  triggers: EffectiveDefinition<TriggerDefinition>[];
  highlights: EffectiveDefinition<HighlightDefinition>[];
  functions: EffectiveDefinition<FunctionDefinition>[];
  keyMappings: EffectiveDefinition<KeyMappingDefinition>[];
  timers: EffectiveDefinition<TimerDefinition>[];
  commandButtons: EffectiveDefinition<CommandButtonDefinition>[];
}

/**
 * Phase 1 built-in precedence tier. Legacy managers ship no defaults, so every
 * kind is intentionally empty while preserving the reserved built-in layer.
 */
export const BUILTIN_DEFINITIONS: Readonly<LocalDefinitions> = Object.freeze(
  deepFreezeLocalDefinitions(createEmptyLocalDefinitions()),
);

/** Deep-freezes a resolved snapshot and every nested definition payload. */
export function freezeSnapshot(
  snapshot: EffectiveConfigurationSnapshot,
): EffectiveConfigurationSnapshot {
  return deepFreeze(snapshot);
}

function deepFreezeLocalDefinitions(definitions: LocalDefinitions): LocalDefinitions {
  return {
    aliases: Object.freeze(
      definitions.aliases.map((item) => deepFreeze(item)),
    ) as AliasDefinition[],
    triggers: Object.freeze(
      definitions.triggers.map((item) => deepFreeze(item)),
    ) as TriggerDefinition[],
    highlights: Object.freeze(
      definitions.highlights.map((item) => deepFreeze(item)),
    ) as HighlightDefinition[],
    functions: Object.freeze(
      definitions.functions.map((item) => deepFreeze(item)),
    ) as FunctionDefinition[],
    keyMappings: Object.freeze(
      definitions.keyMappings.map((item) => deepFreeze(item)),
    ) as KeyMappingDefinition[],
    timers: Object.freeze(definitions.timers.map((item) => deepFreeze(item))) as TimerDefinition[],
    commandButtons: Object.freeze(
      definitions.commandButtons.map((item) => deepFreeze(item)),
    ) as CommandButtonDefinition[],
  };
}

// Objects this function has already walked. Snapshots are rebuilt by spreading
// the previous one, so most of a new snapshot is subtrees frozen on an earlier
// publish; skipping them keeps the per-packet cost proportional to what changed.
const deepFrozen = new WeakSet<object>();

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (deepFrozen.has(value)) {
    return value;
  }
  deepFrozen.add(value);

  Object.freeze(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
    return value;
  }

  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }

  return value;
}
