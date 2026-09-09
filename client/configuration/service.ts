import type { ApplicationStateV1 } from "../model/profiles";
import type {
  AliasDefinition,
  CommandButtonDefinition,
  ConfigKind,
  ConfigurationSet,
  FunctionDefinition,
  HighlightDefinition,
  KeyMappingDefinition,
  LocalDefinitions,
  TimerDefinition,
  TriggerDefinition,
} from "../model/configuration";
import type { CharacterProfileId, ConfigSetId } from "../model/ids";
import { commit, readState, type StorageLike } from "../storage/repository";

import { resolveEffectiveConfiguration } from "./resolve";
import type { EffectiveConfigurationSnapshot } from "./snapshot";

/** Listener invoked when a subscribed character receives a fresh effective snapshot. */
export type EffectiveConfigurationListener = (snapshot: EffectiveConfigurationSnapshot) => void;

/** Removes a previously registered effective-configuration listener. */
export type Unsubscribe = () => void;

/** Input for publishing a new revision of one shared configuration set. */
export interface PublishConfigurationSetInput {
  configSetId: ConfigSetId;
  expectedRevision: number;
  definitions:
    | AliasDefinition[]
    | TriggerDefinition[]
    | HighlightDefinition[]
    | FunctionDefinition[]
    | KeyMappingDefinition[]
    | TimerDefinition[]
    | CommandButtonDefinition[];
  label?: string;
}

/** Result of attempting to publish a shared configuration set revision. */
export type PublishConfigurationSetResult =
  | { success: true }
  | {
      success: false;
      code:
        | "missing-state"
        | "unknown-config-set"
        | "stale-revision"
        | "validation-failed"
        | "storage-failed";
      message: string;
    };

/** Result of updating application configuration without changing profile ownership. */
export type ConfigurationWriteResult =
  | { success: true }
  | {
      success: false;
      code: "missing-state" | "unknown-character" | "validation-failed" | "storage-failed";
      message: string;
    };

/** Result of replacing one character's local definitions for a single kind. */
export type ReplaceLocalDefinitionsResult = ConfigurationWriteResult;

const subscribers = new Map<CharacterProfileId, Set<EffectiveConfigurationListener>>();

/** Registers a Phase 1 stand-in listener keyed by character profile ID. */
export function subscribe(
  characterProfileId: CharacterProfileId,
  listener: EffectiveConfigurationListener,
): Unsubscribe {
  let listeners = subscribers.get(characterProfileId);
  if (listeners === undefined) {
    listeners = new Set();
    subscribers.set(characterProfileId, listeners);
  }

  listeners.add(listener);

  return () => {
    const current = subscribers.get(characterProfileId);
    if (current === undefined) {
      return;
    }

    current.delete(listener);
    if (current.size === 0) {
      subscribers.delete(characterProfileId);
    }
  };
}

/** Clears all subscription listeners; intended for isolated test fixtures only. */
export function resetConfigurationSubscriptionsForTests(): void {
  subscribers.clear();
}

/** Compare-and-swap publish of one configuration set, then notify every subscriber. */
export function publishConfigurationSet(
  storage: StorageLike,
  input: PublishConfigurationSetInput,
): PublishConfigurationSetResult {
  const readResult = readState(storage);
  if (!readResult.success || readResult.data === undefined) {
    return {
      success: false,
      code: "missing-state",
      message: "Phase 1 session graph is not present in storage.",
    };
  }

  const state: ApplicationStateV1 = readResult.data;
  const existingSet = state.configurationSets[input.configSetId];
  if (existingSet === undefined) {
    return {
      success: false,
      code: "unknown-config-set",
      message: "Configuration set is not present in the application graph.",
    };
  }

  if (existingSet.revision !== input.expectedRevision) {
    return {
      success: false,
      code: "stale-revision",
      message: "Configuration set revision no longer matches the expected value.",
    };
  }

  const nextSet = {
    ...existingSet,
    definitions: structuredClone(input.definitions),
    revision: existingSet.revision + 1,
    ...(input.label !== undefined ? { label: input.label } : {}),
  } as ConfigurationSet;

  const nextState: ApplicationStateV1 = {
    ...state,
    configurationSets: {
      ...state.configurationSets,
      [input.configSetId]: nextSet,
    },
  };

  const commitResult = commit(storage, nextState);
  if (!commitResult.success) {
    return {
      success: false,
      code: commitResult.code,
      message: commitResult.message,
    };
  }

  notifySubscribers(nextState);
  return { success: true };
}

/** Replaces one character's local definitions for a single kind, then notifies that character only. */
export function replaceLocalDefinitions<K extends ConfigKind>(
  storage: StorageLike,
  characterProfileId: CharacterProfileId,
  kind: K,
  definitions: LocalDefinitions[K],
): ReplaceLocalDefinitionsResult {
  const readResult = readState(storage);
  if (!readResult.success || readResult.data === undefined) {
    return {
      success: false,
      code: "missing-state",
      message: "Phase 1 session graph is not present in storage.",
    };
  }

  const state: ApplicationStateV1 = readResult.data;
  const character = state.characterProfiles[characterProfileId];
  if (character === undefined) {
    return {
      success: false,
      code: "unknown-character",
      message: "Character profile is not present in the application graph.",
    };
  }

  const nextState: ApplicationStateV1 = {
    ...state,
    characterProfiles: {
      ...state.characterProfiles,
      [characterProfileId]: {
        ...character,
        localDefinitions: {
          ...character.localDefinitions,
          [kind]: structuredClone(definitions),
        },
      },
    },
  };

  const commitResult = commit(storage, nextState);
  if (!commitResult.success) {
    return {
      success: false,
      code: commitResult.code,
      message: commitResult.message,
    };
  }

  notifyOneSubscriber(nextState, characterProfileId);
  return { success: true };
}

/** Updates only the application theme default, then notifies active sessions. */
export function setThemeKey(storage: StorageLike, themeKey: string): ConfigurationWriteResult {
  const readResult = readState(storage);
  if (!readResult.success || readResult.data === undefined) {
    return {
      success: false,
      code: "missing-state",
      message: "Phase 1 session graph is not present in storage.",
    };
  }

  const nextState: ApplicationStateV1 = {
    ...readResult.data,
    defaults: {
      ...readResult.data.defaults,
      themeKey,
    },
  };
  const commitResult = commit(storage, nextState);
  if (!commitResult.success) {
    return commitResult;
  }

  notifySubscribers(nextState);
  return { success: true };
}

function notifyOneSubscriber(
  state: ApplicationStateV1,
  characterProfileId: CharacterProfileId,
): void {
  const listeners = subscribers.get(characterProfileId);
  if (listeners === undefined) {
    return;
  }

  const resolved = resolveEffectiveConfiguration(state, characterProfileId);
  if (!resolved.success || resolved.data === undefined) {
    return;
  }

  const listenerCopy = [...listeners];
  for (const listener of listenerCopy) {
    try {
      listener(resolved.data);
    } catch {
      /* isolate throwing listeners, mirroring gmcp.dispatch */
    }
  }
}

function notifySubscribers(state: ApplicationStateV1): void {
  for (const [characterProfileId] of subscribers.entries()) {
    notifyOneSubscriber(state, characterProfileId);
  }
}
