import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer, isRunnableDevEnvironment } from "vite";

// Command buttons as a configuration kind: older stored graphs still load,
// resolution layers shared sets under local definitions by id, and the
// graph checks apply to the new reference list.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SERVER_ID = "00000000-0000-4000-8000-0000000000a1";
const CHARACTER_ID = "00000000-0000-4000-8000-0000000000b1";
const SET_ID = "00000000-0000-4000-8000-0000000000c1";

async function loadModules(t) {
  const server = await createServer({
    configFile: path.join(repoRoot, "vite.config.ts"),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
    hmr: false,
    watch: null,
  });
  t.after(async () => server.close());
  const ssr = server.environments.ssr;
  assert.ok(isRunnableDevEnvironment(ssr));
  const [validators, resolve, profiles, configuration] = await Promise.all([
    ssr.runner.import("/model/validators.ts"),
    ssr.runner.import("/configuration/resolve.ts"),
    ssr.runner.import("/model/profiles.ts"),
    ssr.runner.import("/model/configuration.ts"),
  ]);
  return { ...validators, ...resolve, ...profiles, ...configuration };
}

// A graph as the first schema wrote it: six kinds, no commandButtons anywhere.
function legacyGraph() {
  const six = () => ({
    aliases: [],
    triggers: [],
    highlights: [],
    functions: [],
    keyMappings: [],
    timers: [],
  });
  return {
    schemaVersion: 1,
    defaults: { themeKey: "darkwind-default", defaultCharacterProfileId: CHARACTER_ID },
    serverProfiles: {
      [SERVER_ID]: {
        id: SERVER_ID,
        protocol: "wss",
        host: "127.0.0.1",
        port: 4242,
        label: "Test MUD",
        capabilities: {},
        worldKey: "test-world",
      },
    },
    characterProfiles: {
      [CHARACTER_ID]: {
        id: CHARACTER_ID,
        serverProfileId: SERVER_ID,
        label: "Main",
        configSetRefs: six(),
        localDefinitions: six(),
        commandHistory: [],
        workspace: { version: 1, payload: {} },
        audio: {
          ambient: { enabled: true, volume: 1 },
          combat: { enabled: true, volume: 1 },
          notification: { enabled: true, volume: 1 },
        },
      },
    },
    configurationSets: {},
  };
}

test("a graph stored before command buttons existed validates and gains empty arrays", async (t) => {
  const m = await loadModules(t);
  assert.deepEqual(m.CONFIG_KINDS_ADDED_AFTER_V1, ["commandButtons"]);
  assert.ok(m.CONFIG_KINDS.includes("commandButtons"));

  const result = m.parseApplicationState(JSON.stringify(legacyGraph()));
  assert.equal(result.success, true, JSON.stringify(result.errors));
  const character = result.data.characterProfiles[CHARACTER_ID];
  assert.deepEqual(character.localDefinitions.commandButtons, []);
  assert.deepEqual(character.configSetRefs.commandButtons, []);
  assert.deepEqual(character.localDefinitions.keyMappings, [], "existing kinds are untouched");

  const upgraded = m.upgradeApplicationStateInput(legacyGraph());
  assert.deepEqual(upgraded.characterProfiles[CHARACTER_ID].localDefinitions.commandButtons, []);
  const current = m.validateApplicationState(legacyGraph()).data;
  assert.equal(m.upgradeApplicationStateInput(current), current, "an up-to-date graph is returned as-is");
  assert.equal(m.upgradeApplicationStateInput("nonsense"), "nonsense");
  assert.equal(m.upgradeApplicationStateInput(null), null);

  assert.deepEqual(m.createEmptyLocalDefinitions().commandButtons, []);
  assert.deepEqual(m.createEmptyConfigurationSetRefs().commandButtons, []);
});

test("command buttons resolve by id across shared sets and local definitions", async (t) => {
  const m = await loadModules(t);
  const graph = legacyGraph();
  const character = graph.characterProfiles[CHARACTER_ID];
  character.configSetRefs.commandButtons = [SET_ID];
  character.localDefinitions.commandButtons = [
    { id: "local-1", enabled: true, label: "Heal", command: "cast heal", shortcut: "Alt+Digit1" },
    { id: "shared-2", enabled: false, label: "Rally (mine)", command: "shout rally!", shortcut: "" },
  ];
  graph.configurationSets[SET_ID] = {
    id: SET_ID,
    label: "Guild",
    revision: 3,
    kind: "commandButtons",
    definitions: [
      { id: "shared-1", enabled: true, label: "Flee", command: "flee", shortcut: "F9" },
      { id: "shared-2", enabled: true, label: "Rally", command: "shout rally", shortcut: "Alt+KeyR" },
      { id: "shared-3", enabled: true, label: "Heal", command: "cast heal", shortcut: "" },
    ],
  };
  const validated = m.validateApplicationState(graph);
  assert.equal(validated.success, true, JSON.stringify(validated.errors));

  const resolved = m.resolveEffectiveConfiguration(validated.data, CHARACTER_ID);
  assert.equal(resolved.success, true);
  const buttons = resolved.data.commandButtons;
  assert.deepEqual(
    buttons.map(({ definition, source }) => [definition.id, definition.label, source.kind]),
    [
      ["shared-1", "Flee", "shared-set"],
      ["shared-2", "Rally (mine)", "local"],
      ["shared-3", "Heal", "shared-set"],
      ["local-1", "Heal", "local"],
    ],
    "a local definition with the same id overrides the shared one in place; same labels do not collide",
  );
  assert.equal(buttons[0].source.configSetId, SET_ID);
  assert.equal(buttons[0].source.revision, 3);

  const wrongKind = structuredClone(graph);
  wrongKind.configurationSets[SET_ID].kind = "aliases";
  wrongKind.configurationSets[SET_ID].definitions = [];
  const crossKind = m.validateApplicationState(wrongKind);
  assert.equal(crossKind.success, false);
  assert.ok(
    crossKind.errors.some((issue) => issue.code === "cross-kind-config-reference"),
    "the new reference list is checked like the others",
  );
});
