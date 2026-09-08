import {
  CLIENT_SETTINGS_STORAGE_KEY,
  readClientSettingsDocument,
  validateClientSettingsDocument,
} from "./client-settings";
import type { ApplicationStateV1 } from "../model/profiles";
import {
  convertLegacyLocalDefinitions,
  convertLegacyVariables,
  mapLegacySoundToCharacterAudio,
} from "../storage/legacy-migration";
import { LEGACY_SOUND_STORAGE_KEY } from "../storage/legacy-keys";
import { SESSION_CORE_STORAGE_KEY } from "../storage/schema";
import { readState, type StorageLike } from "../storage/repository";
import { validateApplicationState } from "../model/validators";

export const SETTINGS_BUNDLE_FORMAT = "darkwind-client-settings-export";
export const SOUND_SETTINGS_STORAGE_KEY = LEGACY_SOUND_STORAGE_KEY;
export const MAX_SETTINGS_BUNDLE_BYTES = 10 * 1024 * 1024;

const OWNER_KEYS = [
  SESSION_CORE_STORAGE_KEY,
  CLIENT_SETTINGS_STORAGE_KEY,
  SOUND_SETTINGS_STORAGE_KEY,
] as const;
const SOUND_CATEGORIES = [
  "combat",
  "spell",
  "skill",
  "potion",
  "quest",
  "celebration",
  "discussion",
  "alert",
  "ambient",
  "fishing",
  "ui",
  "music",
] as const;

type JsonObject = Record<string, unknown>;

export interface SettingsBundlePreview {
  formatVersion: 1 | 2;
  profiles: number;
  configurationSets: number;
  owners: readonly ["profiles and layouts", "client preferences", "sound settings"];
  legacyLayoutWarning?: string;
}

export interface PreparedSettingsBundle {
  preview: SettingsBundlePreview;
  applicationState: ApplicationStateV1;
  clientSettings: JsonObject;
  sound: JsonObject;
}

export type SettingsBundleResult<T> =
  { success: true; data: T } | { success: false; message: string };

export interface LegacyImportContext {
  characterProfileId: string;
  endpoint?: { protocol: string; host: string; port: string | number };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function normalizeSound(value: unknown): JsonObject {
  const source = isObject(value) ? value : {};
  const categories = isObject(source.categoryEnabled) ? source.categoryEnabled : {};
  return {
    enabled: source.enabled !== false,
    volume:
      typeof source.volume === "number" && Number.isFinite(source.volume)
        ? Math.max(0, Math.min(1, source.volume))
        : 0.7,
    categoryEnabled: Object.fromEntries(
      SOUND_CATEGORIES.map((category) => [category, categories[category] !== false]),
    ),
  };
}

function validateSound(value: unknown): SettingsBundleResult<JsonObject> {
  if (!isObject(value)) return { success: false, message: "Sound settings must be an object." };
  if ("enabled" in value && typeof value.enabled !== "boolean")
    return { success: false, message: "Sound setting enabled is invalid." };
  if (
    "volume" in value &&
    (typeof value.volume !== "number" ||
      !Number.isFinite(value.volume) ||
      value.volume < 0 ||
      value.volume > 1)
  )
    return { success: false, message: "Sound setting volume is invalid." };
  if ("categoryEnabled" in value) {
    if (!isObject(value.categoryEnabled))
      return { success: false, message: "Sound categories must be an object." };
    for (const [category, enabled] of Object.entries(value.categoryEnabled)) {
      if (
        !SOUND_CATEGORIES.includes(category as (typeof SOUND_CATEGORIES)[number]) ||
        typeof enabled !== "boolean"
      )
        return { success: false, message: `Sound category ${category} is invalid.` };
    }
  }
  return { success: true, data: normalizeSound(value) };
}

function preview(formatVersion: 1 | 2, state: ApplicationStateV1): SettingsBundlePreview {
  return {
    formatVersion,
    profiles: Object.keys(state.characterProfiles).length,
    configurationSets: Object.keys(state.configurationSets).length,
    owners: ["profiles and layouts", "client preferences", "sound settings"],
    ...(formatVersion === 1
      ? {
          legacyLayoutWarning:
            "Legacy panel visibility, docking, order, collapse, size, and position will be converted where supported.",
        }
      : {}),
  };
}

function currentState(storage: StorageLike): SettingsBundleResult<ApplicationStateV1> {
  const result = readState(storage);
  return result.success && result.data
    ? { success: true, data: result.data }
    : { success: false, message: "The current application graph is invalid." };
}

function currentSound(storage: StorageLike): SettingsBundleResult<JsonObject> {
  const raw = storage.getItem(SOUND_SETTINGS_STORAGE_KEY);
  if (raw === null) return { success: true, data: normalizeSound({}) };
  try {
    return validateSound(JSON.parse(raw));
  } catch {
    return { success: false, message: "Saved sound settings are invalid." };
  }
}

/** Builds the version 2 document from validated durable owners and an optional Settings draft. */
export function buildSettingsBundle(
  storage: StorageLike,
  options: {
    clientSettings?: JsonObject;
    theme?: string;
    sound?: unknown;
    clientVersion?: string;
  } = {},
): SettingsBundleResult<{ bundle: JsonObject; text: string }> {
  const state = currentState(storage);
  if (!state.success) return state;
  const theme = options.theme ?? state.data.defaults.themeKey;
  const storedClient = readClientSettingsDocument(storage, state.data.defaults.themeKey);
  if (!storedClient.success) return storedClient;
  const client = validateClientSettingsDocument(
    { ...storedClient.data, ...options.clientSettings },
    theme,
  );
  if (!client.success) return client;
  const sound = options.sound === undefined ? currentSound(storage) : validateSound(options.sound);
  if (!sound.success) return sound;
  const graph = structuredClone(state.data);
  graph.defaults.themeKey = theme;
  const graphValidation = validateApplicationState(graph);
  if (!graphValidation.success || !graphValidation.data)
    return { success: false, message: "The application graph is invalid." };
  const bundle = {
    format: SETTINGS_BUNDLE_FORMAT,
    formatVersion: 2,
    exportedAt: new Date().toISOString(),
    clientVersion: options.clientVersion ?? "unknown",
    data: {
      applicationState: graphValidation.data,
      clientSettings: client.data,
      sound: sound.data,
    },
  };
  return { success: true, data: { bundle, text: canonicalJson(bundle) } };
}

function parseV2(value: JsonObject): SettingsBundleResult<PreparedSettingsBundle> {
  if (!isObject(value.data))
    return { success: false, message: "That settings export is missing its data payload." };
  const graph = validateApplicationState(value.data.applicationState);
  if (!graph.success || !graph.data)
    return { success: false, message: "The application graph in this export is invalid." };
  const client = validateClientSettingsDocument(value.data.clientSettings);
  if (!client.success) return client;
  if (client.data.theme !== graph.data.defaults.themeKey)
    return { success: false, message: "The exported theme does not match the application graph." };
  const sound = validateSound(value.data.sound);
  if (!sound.success) return sound;
  return {
    success: true,
    data: {
      preview: preview(2, graph.data),
      applicationState: graph.data,
      clientSettings: client.data,
      sound: sound.data,
    },
  };
}

function scopeStore(
  data: JsonObject,
  key: string,
): SettingsBundleResult<Record<string, JsonObject>> {
  const store = data[key];
  if (!isObject(store) || !isObject(store.scopes))
    return { success: false, message: `Legacy ${key} definitions are missing.` };
  const scopes: Record<string, JsonObject> = {};
  for (const [scope, value] of Object.entries(store.scopes)) {
    if (!isObject(value))
      return { success: false, message: `Legacy ${key} scope ${scope} is invalid.` };
    scopes[scope] = value;
  }
  return { success: true, data: scopes };
}

function parseV1(
  value: JsonObject,
  storage: StorageLike,
  context: LegacyImportContext,
): SettingsBundleResult<PreparedSettingsBundle> {
  const data = value.data;
  if (!isObject(data) || !isObject(data.settings))
    return { success: false, message: "That legacy export is missing its settings payload." };
  const legacySettings = data.settings;
  const state = currentState(storage);
  if (!state.success) return state;
  const currentClient = readClientSettingsDocument(storage, state.data.defaults.themeKey);
  if (!currentClient.success) return currentClient;
  const aliases = scopeStore(data, "aliases");
  const highlights = scopeStore(data, "highlights");
  const triggers = scopeStore(data, "triggers");
  const timers = scopeStore(data, "timers");
  const functions = scopeStore(data, "functions");
  if (!aliases.success) return aliases;
  if (!highlights.success) return highlights;
  if (!triggers.success) return triggers;
  if (!timers.success) return timers;
  if (!functions.success) return functions;
  const candidates = new Set(
    [aliases, highlights, triggers, timers, functions].flatMap((store) => Object.keys(store.data)),
  );
  const endpointScope = context.endpoint
    ? `${context.endpoint.protocol === "wss" || context.endpoint.protocol === "telnets" ? "wss" : "ws"}://${context.endpoint.host}:${context.endpoint.port}`
    : "";
  const scope = candidates.has(context.characterProfileId)
    ? context.characterProfileId
    : candidates.has(endpointScope)
      ? endpointScope
      : candidates.size === 1
        ? [...candidates][0]!
        : null;
  if (!scope)
    return {
      success: false,
      message: "Legacy definitions have no unambiguous active-character scope.",
    };
  for (const store of [aliases, highlights, triggers, timers, functions]) {
    if (Object.keys(store.data).length > 0 && !Object.hasOwn(store.data, scope))
      return {
        success: false,
        message: "Legacy definitions do not share one active-character scope.",
      };
  }
  const definitions = convertLegacyLocalDefinitions(
    {
      aliases: aliases.data[scope]?.aliases,
      rules: highlights.data[scope]?.rules,
      triggers: triggers.data[scope]?.triggers,
      timers: timers.data[scope]?.timers,
      functions: functions.data[scope]?.functions,
    },
    legacySettings,
  );
  if (!definitions)
    return { success: false, message: "A legacy definition cannot be converted safely." };
  const variables = convertLegacyVariables(aliases.data[scope]?.variables ?? {});
  if (!variables)
    return { success: false, message: "Legacy scripting variables cannot be converted safely." };
  const theme =
    typeof legacySettings.theme === "string" && legacySettings.theme
      ? legacySettings.theme
      : state.data.defaults.themeKey;
  const knownClient = Object.fromEntries(
    Object.keys(currentClient.data)
      .filter((key) => key in legacySettings && key !== "keyMappings")
      .map((key) => [key, legacySettings[key]]),
  );
  const client = validateClientSettingsDocument({ ...currentClient.data, ...knownClient }, theme);
  if (!client.success) return client;
  const sound = validateSound(data.sound ?? {});
  if (!sound.success) return sound;
  const graph = structuredClone(state.data);
  const character = Object.values(graph.characterProfiles).find(
    (candidate) => candidate.id === context.characterProfileId,
  );
  if (!character)
    return {
      success: false,
      message: "The active character is not present in the application graph.",
    };
  graph.defaults.themeKey = theme;
  // A legacy bundle carries no command buttons, so the character's stay.
  character.localDefinitions = {
    ...definitions,
    commandButtons: character.localDefinitions.commandButtons,
  };
  character.automationVariables = variables;
  if (isObject(data.panels)) {
    character.workspace = {
      version: 1,
      payload: {
        ...data.panels,
        activeLayout: legacySettings.workspaceLayout === "floating" ? "floating" : "classic",
      },
    };
  }
  character.audio = mapLegacySoundToCharacterAudio(sound.data);
  const graphValidation = validateApplicationState(graph);
  if (!graphValidation.success || !graphValidation.data)
    return { success: false, message: "Legacy settings produced an invalid application graph." };
  return {
    success: true,
    data: {
      preview: preview(1, graphValidation.data),
      applicationState: graphValidation.data,
      clientSettings: client.data,
      sound: sound.data,
    },
  };
}

/** Parses and validates an entire import before any storage owner is changed. */
export function prepareSettingsImport(
  text: string,
  storage: StorageLike,
  context?: LegacyImportContext,
): SettingsBundleResult<PreparedSettingsBundle> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { success: false, message: "That settings file is not valid JSON." };
  }
  if (!isObject(value) || value.format !== SETTINGS_BUNDLE_FORMAT)
    return { success: false, message: "That file is not a Darkflow settings export." };
  if (value.formatVersion === 2) return parseV2(value);
  if (value.formatVersion === 1 && context) return parseV1(value, storage, context);
  return { success: false, message: "This settings export version is not supported." };
}

/** Replaces the three owners in fixed order and restores exact raw bytes after a failed write. */
export function applySettingsImport(
  storage: StorageLike,
  prepared: PreparedSettingsBundle,
): { success: true } | { success: false; message: string; recoveryFailedOwner?: string } {
  const target = [
    canonicalJson(prepared.applicationState),
    canonicalJson(prepared.clientSettings),
    canonicalJson(prepared.sound),
  ];
  const snapshot = OWNER_KEYS.map((key) => ({ key, value: storage.getItem(key) }));
  try {
    OWNER_KEYS.forEach((key, index) => storage.setItem(key, target[index]!));
    return { success: true };
  } catch (error) {
    let recoveryFailedOwner: string | undefined;
    for (const entry of [...snapshot].reverse()) {
      try {
        if (entry.value === null) storage.removeItem(entry.key);
        else storage.setItem(entry.key, entry.value);
      } catch {
        recoveryFailedOwner ??= entry.key;
      }
    }
    return {
      success: false,
      message:
        error instanceof Error ? `Import failed: ${error.message}` : "Import could not be written.",
      ...(recoveryFailedOwner ? { recoveryFailedOwner } : {}),
    };
  }
}

export function settingsBundleFilename(recovery = false, date = new Date()): string {
  const stamp = date.toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return `darkflow-settings-${stamp}${recovery ? "-recovery" : ""}.json`;
}
