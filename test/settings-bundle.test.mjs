import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer, isRunnableDevEnvironment } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function storage(initial = {}, failures = []) {
  const data = new Map(Object.entries(initial));
  let writes = 0;
  return {
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) {
      writes += 1;
      if (failures.includes(writes)) throw new Error("quota");
      data.set(key, value);
    },
    removeItem(key) { data.delete(key); },
    snapshot() { return new Map(data); },
    writes() { return writes; },
  };
}

function graph(ids) {
  const definitions = { aliases: [], triggers: [], highlights: [], functions: [], keyMappings: [], timers: [], commandButtons: [] };
  const refs = structuredClone(definitions);
  return {
    schemaVersion: 1,
    defaults: { themeKey: "darkflow-default", defaultCharacterProfileId: ids.character },
    serverProfiles: {
      [ids.server]: {
        id: ids.server, protocol: "wss", host: "mud.example.com", port: 4242,
        label: "Example", capabilities: {}, worldKey: "example-world",
      },
    },
    characterProfiles: {
      [ids.character]: {
        id: ids.character, serverProfileId: ids.server, label: "Main", configSetRefs: refs,
        localDefinitions: definitions, automationVariables: { target: "goblin" }, commandHistory: ["look"], workspace: { version: 1, payload: { dockview: "kept" } },
        audio: {
          ambient: { enabled: true, volume: 1 }, combat: { enabled: true, volume: 1 },
          notification: { enabled: true, volume: 1 },
        },
      },
    },
    configurationSets: {},
  };
}

test("settings bundle validates, round-trips three owners, and keeps unknown client fields", async (t) => {
  const server = await createServer({ configFile: path.join(repoRoot, "vite.config.ts"), appType: "custom", logLevel: "silent", server: { middlewareMode: true }, hmr: false, watch: null });
  t.after(() => server.close());
  assert.ok(isRunnableDevEnvironment(server.environments.ssr));
  const ssr = server.environments.ssr;
  const bundle = await ssr.runner.import("/app/settings-bundle.ts");
  const ids = await ssr.runner.import("/model/ids.ts");
  const uuid = ids.createSequentialUuidFactory("70000000-0000-4000-8000-");
  const state = graph({ server: ids.createServerProfileId(uuid), character: ids.createCharacterProfileId(uuid) });
  const initial = {
    "darkflow-session-core-v1": JSON.stringify(state),
    "darkwind-client-settings": JSON.stringify({ theme: "darkflow-default", deferred: { keep: true } }),
    "darkwind-sound-settings": JSON.stringify({ enabled: false, volume: 0.4, categoryEnabled: { combat: false } }),
  };
  const store = storage(initial);
  const exported = bundle.buildSettingsBundle(store, {
    clientSettings: { repeatLastCommand: false, gmcpDebugEnabled: true },
  });
  assert.equal(exported.success, true);
  assert.equal(JSON.parse(exported.data.text).formatVersion, 2);
  const prepared = bundle.prepareSettingsImport(exported.data.text, store);
  assert.equal(prepared.success, true, prepared.success ? "" : prepared.message);
  assert.deepEqual(prepared.data.clientSettings.deferred, { keep: true });
  assert.equal(prepared.data.clientSettings.repeatLastCommand, false);
  assert.equal(prepared.data.clientSettings.gmcpDebugEnabled, true);
  assert.deepEqual(
    Object.values(prepared.data.applicationState.characterProfiles)[0].automationVariables,
    { target: "goblin" },
  );
  assert.deepEqual(bundle.applySettingsImport(store, prepared.data), { success: true });
  assert.deepEqual(JSON.parse(store.getItem("darkwind-sound-settings")).categoryEnabled.combat, false);
});

test("invalid and failed imports do not lose owner bytes", async (t) => {
  const server = await createServer({ configFile: path.join(repoRoot, "vite.config.ts"), appType: "custom", logLevel: "silent", server: { middlewareMode: true }, hmr: false, watch: null });
  t.after(() => server.close());
  const ssr = server.environments.ssr;
  const bundle = await ssr.runner.import("/app/settings-bundle.ts");
  const ids = await ssr.runner.import("/model/ids.ts");
  const uuid = ids.createSequentialUuidFactory("71000000-0000-4000-8000-");
  const state = graph({ server: ids.createServerProfileId(uuid), character: ids.createCharacterProfileId(uuid) });
  const initial = {
    "darkflow-session-core-v1": JSON.stringify(state),
    "darkwind-client-settings": JSON.stringify({ theme: "darkflow-default" }),
    "darkwind-sound-settings": JSON.stringify({}),
  };
  const store = storage(initial);
  const before = store.snapshot();
  assert.equal(bundle.prepareSettingsImport("{", store).success, false);
  assert.equal(
    bundle.prepareSettingsImport(JSON.stringify({ format: "darkwind-client-settings-export", formatVersion: 99 }), store)
      .success,
    false,
  );
  assert.deepEqual(store.snapshot(), before);
  const exported = bundle.buildSettingsBundle(store);
  assert.equal(exported.success, true);
  const validBundle = JSON.parse(exported.data.text);
  for (const [field, value] of [
    ["applicationState", {}],
    ["clientSettings", { ...validBundle.data.clientSettings, repeatLastCommand: "bad" }],
    ["clientSettings", { ...validBundle.data.clientSettings, gmcpDebugEnabled: "bad" }],
    ["clientSettings", { ...validBundle.data.clientSettings, terminalFontFamily: "fantasy" }],
    ["clientSettings", { ...validBundle.data.clientSettings, terminalFontSize: 17 }],
    ["sound", { ...validBundle.data.sound, volume: 2 }],
  ]) {
    const invalid = structuredClone(validBundle);
    invalid.data[field] = value;
    assert.equal(bundle.prepareSettingsImport(JSON.stringify(invalid), store).success, false, field);
    assert.deepEqual(store.snapshot(), before);
    assert.equal(store.writes(), 0);
  }
  const prepared = bundle.prepareSettingsImport(exported.data.text, store);
  assert.equal(prepared.success, true, prepared.success ? "" : prepared.message);
  for (const write of [1, 2, 3]) {
    const failing = storage(Object.fromEntries(before), [write]);
    const result = bundle.applySettingsImport(failing, prepared.data);
    assert.equal(result.success, false);
    assert.deepEqual(failing.snapshot(), before);
  }
  const incomplete = storage(Object.fromEntries(before), [3, 4]);
  assert.equal(bundle.applySettingsImport(incomplete, prepared.data).recoveryFailedOwner, "darkwind-sound-settings");
  const nullOwners = storage({ "darkflow-session-core-v1": initial["darkflow-session-core-v1"] }, [3]);
  const nullPrepared = bundle.prepareSettingsImport(exported.data.text, nullOwners);
  assert.equal(nullPrepared.success, true);
  assert.equal(bundle.applySettingsImport(nullOwners, nullPrepared.data).success, false);
  assert.equal(nullOwners.getItem("darkwind-client-settings"), null);
  assert.equal(nullOwners.getItem("darkwind-sound-settings"), null);
});

test("legacy imports select the active scope, variables, and workspace", async (t) => {
  const server = await createServer({ configFile: path.join(repoRoot, "vite.config.ts"), appType: "custom", logLevel: "silent", server: { middlewareMode: true }, hmr: false, watch: null });
  t.after(() => server.close());
  const ssr = server.environments.ssr;
  const bundle = await ssr.runner.import("/app/settings-bundle.ts");
  const ids = await ssr.runner.import("/model/ids.ts");
  const uuid = ids.createSequentialUuidFactory("72000000-0000-4000-8000-");
  const id = { server: ids.createServerProfileId(uuid), character: ids.createCharacterProfileId(uuid) };
  const state = graph(id);
  const otherCharacter = ids.createCharacterProfileId(uuid);
  const sharedSet = ids.createConfigSetId(uuid);
  state.characterProfiles[otherCharacter] = {
    ...structuredClone(state.characterProfiles[id.character]),
    id: otherCharacter,
    label: "Alt",
    configSetRefs: { ...structuredClone(state.characterProfiles[id.character].configSetRefs), aliases: [sharedSet] },
  };
  state.configurationSets[sharedSet] = {
    id: sharedSet,
    label: "Shared aliases",
    kind: "aliases",
    revision: 1,
    definitions: [],
  };
  const preservedOther = structuredClone(state.characterProfiles[otherCharacter]);
  const preservedSet = structuredClone(state.configurationSets[sharedSet]);
  const store = storage({
    "darkflow-session-core-v1": JSON.stringify(state),
    "darkwind-client-settings": JSON.stringify({ theme: "darkflow-default", untouched: true }),
    "darkwind-sound-settings": JSON.stringify({}),
  });
  const scoped = (entry) => ({ scopes: { [id.character]: entry } });
  const legacy = {
    format: "darkwind-client-settings-export", formatVersion: 1,
    data: {
      settings: { theme: "nord", keyMappings: [{ code: "F2", command: "score" }] },
      aliases: scoped({ aliases: [{ trigger: "q", steps: [{ type: "send_command", template: "quit" }] }], variables: { target: "orc" } }),
      highlights: scoped({ rules: [] }), triggers: scoped({ triggers: [] }), timers: scoped({ timers: [] }), functions: scoped({ functions: [] }),
      panels: {
        version: 2,
        profiles: {
          classic: {
            docks: { left: false, right: false },
            panels: {
              status: {
                dock: "left", order: 1, collapsed: true, visible: true,
                floatX: 20, floatY: 60, floatW: 280, floatH: 200,
              },
            },
          },
        },
      },
      sound: { enabled: false, volume: 0.3, categoryEnabled: { ambient: false } },
    },
  };
  const prepared = bundle.prepareSettingsImport(JSON.stringify(legacy), store, { characterProfileId: id.character });
  assert.equal(prepared.success, true, prepared.success ? "" : prepared.message);
  assert.equal(
    prepared.data.preview.legacyLayoutWarning,
    "Legacy panel visibility, docking, order, collapse, size, and position will be converted where supported.",
  );
  const character = prepared.data.applicationState.characterProfiles[id.character];
  assert.equal(character.workspace.payload.activeLayout, "classic");
  assert.equal(character.workspace.payload.profiles.classic.panels.status.collapsed, true);
  assert.deepEqual(character.commandHistory, ["look"]);
  assert.equal(character.workspace.version, 1);
  assert.equal(character.localDefinitions.aliases[0].trigger, "q");
  assert.deepEqual(character.automationVariables, { target: "orc" });
  assert.equal(character.localDefinitions.keyMappings[0].command, "score");
  assert.equal(prepared.data.clientSettings.untouched, true);
  assert.deepEqual(prepared.data.applicationState.characterProfiles[otherCharacter], preservedOther);
  assert.deepEqual(prepared.data.applicationState.configurationSets[sharedSet], preservedSet);

  const missingArray = structuredClone(legacy);
  delete missingArray.data.aliases.scopes[id.character].aliases;
  assert.equal(
    bundle.prepareSettingsImport(JSON.stringify(missingArray), store, { characterProfileId: id.character })
      .success,
    false,
  );
  const mismatchedScope = structuredClone(legacy);
  mismatchedScope.data.aliases.scopes.other = { aliases: [] };
  delete mismatchedScope.data.aliases.scopes[id.character];
  assert.equal(
    bundle.prepareSettingsImport(JSON.stringify(mismatchedScope), store, { characterProfileId: id.character })
      .success,
    false,
  );
  const ambiguous = structuredClone(legacy);
  for (const key of ["aliases", "highlights", "triggers", "timers", "functions"])
    ambiguous.data[key].scopes.other = structuredClone(ambiguous.data[key].scopes[id.character]);
  assert.equal(
    bundle.prepareSettingsImport(JSON.stringify(ambiguous), store, { characterProfileId: "missing" })
      .success,
    false,
  );
  const telnetsScope = structuredClone(legacy);
  for (const key of ["aliases", "highlights", "triggers", "timers", "functions"]) {
    telnetsScope.data[key].scopes["wss://mud.example.com:4242"] = telnetsScope.data[key].scopes[id.character];
    delete telnetsScope.data[key].scopes[id.character];
  }
  assert.equal(
    bundle.prepareSettingsImport(JSON.stringify(telnetsScope), store, {
      characterProfileId: id.character,
      endpoint: { protocol: "telnets", host: "mud.example.com", port: "4242" },
    }).success,
    true,
  );
});
