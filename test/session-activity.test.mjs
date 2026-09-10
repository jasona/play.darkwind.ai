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
  const [activity, bus, diagnostics, ids, scope, events, world] = await Promise.all([
    ssr.runner.import("/runtime/activity.ts"),
    ssr.runner.import("/gmcp/bus.ts"),
    ssr.runner.import("/runtime/diagnostics.ts"),
    ssr.runner.import("/model/ids.ts"),
    ssr.runner.import("/runtime/resource-scope.ts"),
    ssr.runner.import("/runtime/event-bus.ts"),
    ssr.runner.import("/runtime/world.ts"),
  ]);
  return { ...activity, ...bus, ...diagnostics, ...ids, ...scope, ...events, ...world };
}

let worldSequence = 0;

function createHarness(modules, clock) {
  const sessionId = modules.createSessionId(modules.createSequentialUuidFactory());
  const diagnostics = new modules.SessionDiagnostics(sessionId);
  const scope = modules.createResourceScope(sessionId, diagnostics);
  const eventBus = modules.createSessionEventBus(sessionId, diagnostics);
  const gmcp = modules.createSessionGmcpBus(sessionId, () => true, diagnostics);
  const world = modules.createSessionWorld(
    gmcp,
    scope,
    eventBus,
    { worldKey: `activity-world-${++worldSequence}`, host: "mud.example", port: 4000 },
    () => true,
  );
  const activity = modules.createSessionActivity(scope, eventBus, world, {
    now: () => clock.now,
  });
  const seen = [];
  activity.subscribe((snapshot) => {
    if (snapshot.latest) seen.push(snapshot.latest);
  });
  const connect = (status = "connected") =>
    eventBus.publish("transport:reconnect-status", { status, attempt: 0, transport: "ws" });
  const command = (text) => eventBus.publish("transport:outbound-command", { text });
  const room = (num, exits = {}) => gmcp.dispatch("Room.Info", { num, name: `Room ${num}`, exits });
  return { activity, command, connect, room, scope, seen };
}

test("commands are classified into looks and bare moves", async (t) => {
  const { classifyCommand, facingFor, inferDirection } = await loadModules(t);
  assert.deepEqual(classifyCommand("look"), { kind: "look" });
  assert.deepEqual(classifyCommand("  L  "), { kind: "look" });
  assert.deepEqual(classifyCommand("look at the drake"), { kind: "look" });
  assert.deepEqual(classifyCommand("glance"), { kind: "look" });
  assert.deepEqual(classifyCommand("n"), { kind: "move", direction: "n" });
  assert.deepEqual(classifyCommand("Northeast"), { kind: "move", direction: "ne" });
  assert.deepEqual(classifyCommand("up"), { kind: "move", direction: "u" });
  assert.equal(classifyCommand("n to the tower"), null, "a direction with trailing words is not a move");
  assert.equal(classifyCommand("say look out"), null);
  assert.equal(classifyCommand("kill drake"), null);
  assert.equal(classifyCommand(""), null);
  assert.equal(facingFor("w"), -1);
  assert.equal(facingFor("sw"), -1);
  assert.equal(facingFor("d"), -1);
  assert.equal(facingFor("e"), 1);
  assert.equal(facingFor(""), 1);
  assert.equal(inferDirection({ num: 1, exits: { north: 2, w: 3 } }, { num: 3 }), "w");
  assert.equal(inferDirection({ num: 1, exits: { north: 2, w: 3 } }, { num: 2 }), "n");
  assert.equal(inferDirection({ num: 1, exits: { north: 2 } }, { num: 9 }), "");
  assert.equal(inferDirection({ num: 1, exits: "" }, { num: 2 }), "");
  assert.equal(inferDirection(null, { num: 2 }), "");
});

test("a look fires on the command and a room change walks in the direction the player went", async (t) => {
  const modules = await loadModules(t);
  const clock = { now: 10_000 };
  const harness = createHarness(modules, clock);
  harness.connect();

  harness.room(1, { e: 2, s: 5 });
  assert.deepEqual(harness.seen, [], "arriving in the first room is not a walk");

  harness.command("look");
  assert.equal(harness.seen.length, 1);
  assert.equal(harness.seen[0].kind, "look");
  assert.equal(harness.seen[0].direction, "");
  assert.equal(harness.seen[0].facing, 1);
  assert.equal(harness.seen[0].at, 10_000);

  harness.command("w");
  clock.now += 400;
  harness.room(2, { w: 1 });
  assert.equal(harness.seen.length, 2);
  assert.deepEqual(
    [harness.seen[1].kind, harness.seen[1].direction, harness.seen[1].facing],
    ["walk", "w", -1],
    "the pending move explains the room change even when the exits disagree",
  );

  clock.now += 400;
  harness.room(1, { e: 2, s: 5 });
  assert.equal(harness.seen.length, 3);
  assert.deepEqual(
    [harness.seen[2].direction, harness.seen[2].facing],
    ["w", -1],
    "without a pending move the previous room's exits give the direction",
  );

  clock.now += 400;
  harness.room(1, { e: 2, s: 5, n: 7 });
  assert.equal(harness.seen.length, 3, "a Room.Info for the same room is not a walk");

  clock.now += 400;
  harness.room(42);
  assert.equal(harness.seen.length, 4);
  assert.deepEqual([harness.seen[3].direction, harness.seen[3].facing], ["", 1], "unknown travel faces right");

  harness.command("n");
  clock.now += 7000;
  harness.room(43);
  assert.equal(harness.seen[4].direction, "", "a stale movement command no longer explains a room change");

  harness.command("e");
  harness.command("e");
  clock.now += 100;
  harness.room(44);
  harness.room(45);
  assert.deepEqual(
    harness.seen.slice(5).map((a) => a.direction),
    ["e", "e"],
    "queued moves pair with room changes in order",
  );

  assert.equal(harness.activity.getSnapshot().seq, harness.seen.length);
  assert.equal(harness.activity.getSnapshot().latest, harness.seen[harness.seen.length - 1]);
});

test("a reconnect makes the next room an arrival and drops pending moves", async (t) => {
  const modules = await loadModules(t);
  const clock = { now: 5000 };
  const harness = createHarness(modules, clock);
  harness.connect();
  harness.room(1, { n: 2 });
  harness.command("n");
  harness.connect("reconnecting");
  harness.connect("connected");
  harness.room(2, { s: 1 });
  assert.deepEqual(harness.seen, [], "the first room after reconnecting is where the player is, not a walk");
  harness.room(1, { n: 2 });
  assert.equal(harness.seen.length, 1);
  assert.equal(harness.seen[0].direction, "s");

  harness.scope.dispose();
  harness.command("look");
  assert.equal(harness.seen.length, 1, "a disposed feed is silent");
  assert.equal(typeof harness.activity.subscribe(() => {}), "function");
});
