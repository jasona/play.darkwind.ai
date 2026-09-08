import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer, isRunnableDevEnvironment } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  const [board, diagnostics, ids, scope] = await Promise.all([
    ssr.runner.import("/runtime/command-board.ts"),
    ssr.runner.import("/runtime/diagnostics.ts"),
    ssr.runner.import("/model/ids.ts"),
    ssr.runner.import("/runtime/resource-scope.ts"),
  ]);
  return { ...board, ...diagnostics, ...ids, ...scope };
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

function createHarness(modules, t, storage = memoryStorage()) {
  const sessionId = modules.createSessionId(modules.createSequentialUuidFactory());
  const diagnostics = new modules.SessionDiagnostics(sessionId);
  const scope = modules.createResourceScope(sessionId, diagnostics);
  t.after(() => {
    if (!scope.disposed) scope.dispose();
  });
  let counter = 0;
  const board = modules.createSessionCommandBoard(scope, {
    storage,
    storageKey: "board-test",
    createId: () => `id${++counter}`,
  });
  const seen = [];
  board.subscribe((snapshot) => seen.push(snapshot));
  return { board, scope, seen, storage };
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

test("a new board starts with the starter buttons and edits persist per character", async (t) => {
  const modules = await loadModules(t);
  const h = createHarness(modules, t);
  const start = h.board.getSnapshot();
  assert.deepEqual(
    start.buttons.map((b) => [b.label, b.command, b.shortcut]),
    [
      ["Look", "look", ""],
      ["Inventory", "inventory", ""],
      ["Score", "score", ""],
    ],
  );
  assert.equal(start.columns, 3);

  const added = h.board.addButton({ label: "  Heal  ", command: "cast heal", shortcut: "Alt+Digit1" });
  assert.equal(added.label, "Heal");
  assert.equal(added.shortcut, "Alt+Digit1");
  assert.equal(h.board.getSnapshot().buttons.length, 4);
  assert.equal(h.board.updateButton(added.id, { command: "cast greater heal" }), true);
  assert.equal(h.board.getSnapshot().buttons.at(-1).command, "cast greater heal");
  assert.equal(h.board.getSnapshot().buttons.at(-1).shortcut, "Alt+Digit1", "a patch leaves other fields alone");
  assert.equal(h.board.updateButton("nope", { label: "x" }), false);
  assert.equal(h.board.moveButton(added.id, -10), true);
  assert.equal(h.board.getSnapshot().buttons[0].id, added.id, "moves clamp to the ends");
  assert.equal(h.board.moveButton(added.id, -1), false, "already first");
  h.board.setColumns(99);
  assert.equal(h.board.getSnapshot().columns, 8);
  h.board.setColumns(0);
  assert.equal(h.board.getSnapshot().columns, 1);

  const saved = JSON.parse(h.storage.map.get("board-test"));
  assert.equal(saved.columns, 1);
  assert.equal(saved.buttons[0].command, "cast greater heal");

  const again = createHarness(modules, t, h.storage);
  assert.deepEqual(again.board.getSnapshot(), h.board.getSnapshot(), "a fresh runtime reads the saved board");

  assert.equal(h.board.removeButton(added.id), true);
  assert.equal(h.board.removeButton(added.id), false);
  assert.equal(h.board.getSnapshot().buttons.length, 3);
  h.board.resetToDefaults();
  assert.equal(h.board.getSnapshot().columns, 3);
  assert.ok(h.seen.length >= 8, "every change was published");
});

test("stored boards are cleaned: bad shortcuts drop, duplicate ids are reissued, limits hold", async (t) => {
  const modules = await loadModules(t);
  const storage = memoryStorage({
    "board-test": JSON.stringify({
      version: 1,
      columns: "4",
      buttons: [
        { id: "a", label: "One", command: "look", shortcut: "KeyA" },
        { id: "a", label: "Two", command: 7, shortcut: "Alt+Digit2" },
        "garbage",
        { id: "c", label: "x".repeat(80), command: "y".repeat(600), shortcut: "Ctrl+KeyC" },
      ],
    }),
  });
  const h = createHarness(modules, t, storage);
  const board = h.board.getSnapshot();
  assert.equal(board.columns, 4);
  assert.equal(board.buttons.length, 4);
  assert.equal(board.buttons[0].shortcut, "", "a bare-letter shortcut is dropped");
  assert.equal(board.buttons[1].id !== "a", true, "a duplicate id is reissued");
  assert.equal(board.buttons[1].command, "", "a non-string command is emptied");
  assert.equal(board.buttons[2].label, "");
  assert.equal(board.buttons[3].label.length, 40);
  assert.equal(board.buttons[3].command.length, 500);

  const corrupt = createHarness(modules, t, memoryStorage({ "board-test": "{not json" }));
  assert.equal(corrupt.board.getSnapshot().buttons.length, 3, "unreadable storage falls back to the defaults");

  for (let i = 0; i < 60; i++) h.board.addButton({ label: "b" + i, command: "x" });
  assert.equal(h.board.getSnapshot().buttons.length, 48, "the board is capped");
});

test("matchShortcut finds the button for a key event and ignores unassignable presses", async (t) => {
  const modules = await loadModules(t);
  const h = createHarness(modules, t);
  const heal = h.board.addButton({ label: "Heal", command: "cast heal", shortcut: "Alt+Digit1" });
  h.board.addButton({ label: "Empty", command: "", shortcut: "F6" });
  assert.equal(h.board.matchShortcut(key("Digit1", { altKey: true }))?.id, heal.id);
  assert.equal(h.board.matchShortcut(key("Digit1")), null, "no modifier, no match");
  assert.equal(h.board.matchShortcut(key("Digit1", { altKey: true, shiftKey: true })), null, "Shift changes the combination");
  assert.equal(h.board.matchShortcut(key("F6")), null, "a button without a command never fires");

  h.scope.dispose();
  assert.equal(h.board.addButton({ label: "late", command: "x" }).label, "late");
  assert.equal(h.board.getSnapshot().buttons.length, 5, "a disposed board no longer changes");
});
