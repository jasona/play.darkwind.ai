import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer, isRunnableDevEnvironment } from "vite";

// The Command Board runtime against the real configuration graph: buttons are
// the "commandButtons" configuration kind, so edits made through the board
// land in the character's local definitions in storage, and buttons from a
// shared configuration set show up read-only.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SERVER_ID = "00000000-0000-4000-8000-0000000000a1";
const CHARACTER_ID = "00000000-0000-4000-8000-0000000000b1";
const SHARED_SET_ID = "00000000-0000-4000-8000-0000000000c1";

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
  const [board, diagnostics, ids, scope, editor, profiles, repository, schema, service] =
    await Promise.all([
      ssr.runner.import("/runtime/command-board.ts"),
      ssr.runner.import("/runtime/diagnostics.ts"),
      ssr.runner.import("/model/ids.ts"),
      ssr.runner.import("/runtime/resource-scope.ts"),
      ssr.runner.import("/configuration/editor.ts"),
      ssr.runner.import("/model/profiles.ts"),
      ssr.runner.import("/storage/repository.ts"),
      ssr.runner.import("/storage/schema.ts"),
      ssr.runner.import("/configuration/service.ts"),
    ]);
  return {
    ...board,
    ...diagnostics,
    ...ids,
    ...scope,
    ...editor,
    ...profiles,
    ...repository,
    ...schema,
    ...service,
  };
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    map,
  };
}

function graphState(modules, { sharedButtons = null } = {}) {
  const configSetRefs = modules.createEmptyConfigurationSetRefs();
  const configurationSets = {};
  if (sharedButtons) {
    configSetRefs.commandButtons = [SHARED_SET_ID];
    configurationSets[SHARED_SET_ID] = {
      id: SHARED_SET_ID,
      label: "Guild buttons",
      revision: 1,
      kind: "commandButtons",
      definitions: sharedButtons,
    };
  }
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
        configSetRefs,
        localDefinitions: modules.createEmptyLocalDefinitions(),
        commandHistory: [],
        workspace: { version: 1, payload: {} },
        audio: {
          ambient: { enabled: true, volume: 1 },
          combat: { enabled: true, volume: 1 },
          notification: { enabled: true, volume: 1 },
        },
      },
    },
    configurationSets,
  };
}

function createHarness(modules, t, { sharedButtons = null, storage = memoryStorage() } = {}) {
  if (storage.getItem(modules.SESSION_CORE_STORAGE_KEY) === null) {
    // A fresh graph: drop subscriptions left by earlier tests. A second
    // runtime over the same storage must keep the first one's subscription.
    modules.resetConfigurationSubscriptionsForTests?.();
    const committed = modules.commit(storage, graphState(modules, { sharedButtons }));
    assert.equal(committed.success, true, "the test graph commits");
  }
  const sessionId = modules.createSessionId(modules.createSequentialUuidFactory());
  const diagnostics = new modules.SessionDiagnostics(sessionId);
  const scope = modules.createResourceScope(sessionId, diagnostics);
  t.after(() => {
    if (!scope.disposed) scope.dispose();
  });
  const configuration = modules.createSessionConfiguration(storage, CHARACTER_ID);
  let counter = 0;
  const board = modules.createSessionCommandBoard(scope, configuration, {
    storage,
    storageKey: "board-prefs",
    createId: () => `id${++counter}`,
  });
  const seen = [];
  board.subscribe((snapshot) => seen.push(snapshot));
  const stored = () =>
    JSON.parse(storage.getItem(modules.SESSION_CORE_STORAGE_KEY)).characterProfiles[CHARACTER_ID]
      .localDefinitions.commandButtons;
  return { board, configuration, scope, seen, storage, stored };
}

const key = (code, mods = {}) => ({
  code,
  altKey: false,
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

test("shortcuts need a modifier or a function/numpad key, and read back as friendly labels", async (t) => {
  const { shortcutFromEvent, normalizeShortcut, shortcutLabel } = await loadModules(t);
  assert.equal(shortcutFromEvent(key("Digit1", { altKey: true })), "Alt+Digit1");
  assert.equal(shortcutFromEvent(key("KeyH", { ctrlKey: true, shiftKey: true })), "Ctrl+Shift+KeyH");
  assert.equal(shortcutFromEvent(key("F5")), "F5");
  assert.equal(shortcutFromEvent(key("Numpad1")), "Numpad1");
  assert.equal(shortcutFromEvent(key("KeyA")), null, "a bare letter would fire while typing");
  assert.equal(shortcutFromEvent(key("KeyA", { shiftKey: true })), null, "Shift alone is still typing");
  assert.equal(shortcutFromEvent(key("AltLeft", { altKey: true })), null, "a modifier by itself is not a shortcut");
  assert.equal(shortcutFromEvent(key("")), null);
  assert.equal(
    shortcutFromEvent({ ...key("", { altKey: true }), key: "2" }),
    "Alt+Digit2",
    "a missing code is inferred from the key",
  );
  assert.equal(shortcutFromEvent({ ...key("", { ctrlKey: true }), key: "h" }), "Ctrl+KeyH");
  assert.equal(shortcutFromEvent({ ...key(""), key: "F7" }), "F7");
  assert.equal(shortcutFromEvent({ ...key(""), key: "Alt" }), null);
  assert.equal(shortcutFromEvent({ ...key("", { altKey: true }), key: " " }), null);

  assert.equal(normalizeShortcut("Alt+Digit1"), "Alt+Digit1");
  assert.equal(normalizeShortcut(" Shift+Ctrl+KeyH "), "Ctrl+Shift+KeyH", "modifier order is canonical");
  assert.equal(normalizeShortcut("KeyA"), "", "stored bare letters are dropped");
  assert.equal(normalizeShortcut("Hyper+KeyA"), "");
  assert.equal(normalizeShortcut(42), "");

  assert.equal(shortcutLabel("Alt+Digit1"), "Alt+1");
  assert.equal(shortcutLabel("Ctrl+Shift+KeyH"), "Ctrl+Shift+H");
  assert.equal(shortcutLabel("F5"), "F5");
  assert.equal(shortcutLabel("Numpad7"), "Num 7");
  assert.equal(shortcutLabel("Alt+ArrowUp"), "Alt+Up");
  assert.equal(shortcutLabel("Ctrl+Minus"), "Ctrl+-");
  assert.equal(shortcutLabel(""), "");
});

test("board edits are written to the character's local command buttons in the graph", async (t) => {
  const modules = await loadModules(t);
  const h = createHarness(modules, t);
  assert.deepEqual(h.board.getSnapshot().buttons, [], "a new character has no buttons until asked");
  assert.equal(h.board.getSnapshot().columns, 3);

  assert.equal(h.board.resetToDefaults(), true);
  assert.deepEqual(
    h.board.getSnapshot().buttons.map((b) => [b.label, b.command, b.shortcut, b.enabled, b.source]),
    [
      ["Look", "look", "", true, "local"],
      ["Inventory", "inventory", "", true, "local"],
      ["Score", "score", "", true, "local"],
    ],
  );
  assert.equal(h.stored().length, 3, "the starters are in storage as local definitions");

  const added = h.board.addButton({ label: "  Heal  ", command: "cast heal", shortcut: "Alt+Digit1" });
  assert.equal(added.label, "Heal");
  assert.equal(added.shortcut, "Alt+Digit1");
  assert.equal(added.source, "local");
  assert.equal(h.board.isEditable(added.id), true);
  assert.equal(h.stored().at(-1).command, "cast heal");
  assert.equal(h.board.updateButton(added.id, { command: "cast greater heal" }), true);
  const updated = h.board.getSnapshot().buttons.at(-1);
  assert.equal(updated.command, "cast greater heal");
  assert.equal(updated.shortcut, "Alt+Digit1", "a patch leaves other fields alone");
  assert.equal(h.board.updateButton(added.id, { enabled: false }), true);
  assert.equal(h.board.getSnapshot().buttons.at(-1).enabled, false);
  assert.equal(h.board.matchShortcut(key("Digit1", { altKey: true })), null, "a disabled button never fires");
  assert.equal(h.board.updateButton(added.id, { enabled: true }), true);
  assert.equal(h.board.matchShortcut(key("Digit1", { altKey: true }))?.id, added.id);
  assert.equal(h.board.updateButton("nope", { label: "x" }), false);

  assert.equal(h.board.moveButton(added.id, -10), true);
  assert.equal(h.board.getSnapshot().buttons[0].id, added.id, "moves clamp to the ends");
  assert.equal(h.stored()[0].id, added.id, "order is persisted");
  assert.equal(h.board.moveButton(added.id, -1), false, "already first");

  h.board.setColumns(99);
  assert.equal(h.board.getSnapshot().columns, 8);
  assert.equal(JSON.parse(h.storage.map.get("board-prefs")).columns, 8, "the column count is a panel preference");
  h.board.setColumns(0);
  assert.equal(h.board.getSnapshot().columns, 1);

  const again = createHarness(modules, t, { storage: h.storage });
  assert.deepEqual(again.board.getSnapshot(), h.board.getSnapshot(), "a fresh runtime reads the graph and the preference");

  assert.equal(h.board.removeButton(added.id), true);
  assert.equal(h.board.removeButton(added.id), false);
  assert.equal(h.stored().length, 3);
  assert.ok(h.seen.length >= 8, "every change was published");

  // Edits made elsewhere (Settings) reach the board through the configuration subscription.
  const result = h.configuration.replaceLocalDefinitions("commandButtons", [
    { id: "from-settings", enabled: true, label: "Flee", command: "flee", shortcut: "F9" },
  ]);
  assert.equal(result.success, true);
  assert.deepEqual(
    h.board.getSnapshot().buttons.map((b) => b.label),
    ["Flee"],
  );
  assert.equal(h.board.matchShortcut(key("F9"))?.command, "flee");
});

test("buttons from a shared configuration set show on the board but are not edited from it", async (t) => {
  const modules = await loadModules(t);
  const h = createHarness(modules, t, {
    sharedButtons: [
      { id: "shared-1", enabled: true, label: "Rally", command: "shout rally", shortcut: "Alt+KeyR" },
      { id: "shared-2", enabled: false, label: "Old", command: "old", shortcut: "" },
    ],
  });
  const buttons = h.board.getSnapshot().buttons;
  assert.deepEqual(
    buttons.map((b) => [b.label, b.source, b.enabled]),
    [
      ["Rally", "shared-set", true],
      ["Old", "shared-set", false],
    ],
  );
  assert.equal(h.board.isEditable("shared-1"), false);
  assert.equal(h.board.updateButton("shared-1", { label: "x" }), false);
  assert.equal(h.board.removeButton("shared-1"), false);
  assert.equal(h.board.moveButton("shared-1", 1), false);
  assert.equal(h.board.matchShortcut(key("KeyR", { altKey: true }))?.id, "shared-1", "shared shortcuts fire");

  const mine = h.board.addButton({ label: "Mine", command: "say hi" });
  assert.deepEqual(
    h.board.getSnapshot().buttons.map((b) => [b.label, b.source]),
    [
      ["Rally", "shared-set"],
      ["Old", "shared-set"],
      ["Mine", "local"],
    ],
    "local buttons follow the shared ones",
  );
  assert.equal(h.stored().length, 1, "only the local button is in the character's definitions");
  assert.equal(h.board.isEditable(mine.id), true);

  h.scope.dispose();
  assert.equal(h.board.addButton({ label: "late", command: "x" }), null, "a disposed board refuses writes");
});

test("stored definitions are cleaned on the way to the board and the local count is capped", async (t) => {
  const modules = await loadModules(t);
  const h = createHarness(modules, t);
  const result = h.configuration.replaceLocalDefinitions("commandButtons", [
    { id: "a", enabled: true, label: "One", command: "look", shortcut: "KeyA" },
    { id: "b", enabled: true, label: "x".repeat(80), command: "y".repeat(600), shortcut: "Ctrl+KeyC" },
  ]);
  assert.equal(result.success, true);
  const [one, two] = h.board.getSnapshot().buttons;
  assert.equal(one.shortcut, "", "a bare-letter shortcut is dropped");
  assert.equal(two.label.length, 40);
  assert.equal(two.command.length, 500);
  assert.equal(two.shortcut, "Ctrl+KeyC");

  for (let i = 0; i < 60; i++) h.board.addButton({ label: "b" + i, command: "x" });
  assert.equal(h.board.getSnapshot().buttons.length, 48, "the local board is capped");
  assert.equal(h.board.addButton({ label: "one more", command: "x" }), null);
});
