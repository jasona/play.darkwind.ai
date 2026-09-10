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
  const [dps, bus, diagnostics, ids, scope, events] = await Promise.all([
    ssr.runner.import("/runtime/dps.ts"),
    ssr.runner.import("/gmcp/bus.ts"),
    ssr.runner.import("/runtime/diagnostics.ts"),
    ssr.runner.import("/model/ids.ts"),
    ssr.runner.import("/runtime/resource-scope.ts"),
    ssr.runner.import("/runtime/event-bus.ts"),
  ]);
  return { ...dps, ...bus, ...diagnostics, ...ids, ...scope, ...events };
}

function createHarness(modules, clock) {
  const sessionId = modules.createSessionId(modules.createSequentialUuidFactory());
  const diagnostics = new modules.SessionDiagnostics(sessionId);
  const scope = modules.createResourceScope(sessionId, diagnostics);
  const eventBus = modules.createSessionEventBus(sessionId, diagnostics);
  const gmcp = modules.createSessionGmcpBus(sessionId, () => true, diagnostics);
  const dps = modules.createSessionDps(gmcp, scope, eventBus, { now: () => clock.now });
  const reconnect = (status) =>
    eventBus.publish("transport:reconnect-status", { status, attempt: 0, transport: "ws" });
  return { dps, gmcp, reconnect, scope };
}

function state(overrides = {}) {
  return {
    epoch: "connection-7",
    encounter_id: "encounter-12",
    seq: 1,
    visual_enabled: 1,
    effective: 1,
    active: true,
    current_actor_id: "self",
    current_target_id: "actor-2",
    actors: [
      { id: "self", name: "Acer", role: "self" },
      { id: "actor-2", name: "an ash drake", role: "target" },
    ],
    outcome: "",
    summary: "Combat begins.",
    ...overrides,
  };
}

function swing(seq, overrides = {}) {
  return {
    seq,
    kind: "attack",
    perspective: "outgoing",
    actor_id: "self",
    target_id: "actor-2",
    result: "hit",
    damage: 100,
    summary: "You hit an ash drake.",
    ...overrides,
  };
}

function events(list, overrides = {}) {
  return {
    epoch: "connection-7",
    encounter_id: "encounter-12",
    first_seq: list[0].seq,
    last_seq: list[list.length - 1].seq,
    events: list,
    overflow: { omitted: 0, hits: 0, damage: 0 },
    ...overrides,
  };
}

test("the DPS runtime tallies outgoing swings from the session bus and publishes frozen views", async (t) => {
  const modules = await loadModules(t);
  const clock = { now: 1_000_000 };
  const harness = createHarness(modules, clock);
  t.after(() => harness.scope.dispose());
  const seen = [];
  harness.dps.subscribe((snapshot) => seen.push(snapshot));
  assert.equal(seen.length, 1, "subscribing delivers the current view");
  assert.equal(seen[0].hasData, false);

  harness.reconnect("connected");
  harness.gmcp.dispatch("Darkwind.Combat.State", state());
  harness.gmcp.dispatch(
    "Darkwind.Combat.Events",
    events([swing(1, { damage: 400 }), swing(2, { result: "critical", damage: 600 })]),
  );
  clock.now += 10_000;

  const snapshot = harness.dps.getSnapshot();
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.targetName, "an ash drake");
  assert.equal(snapshot.encounter.damage, 1000);
  assert.equal(snapshot.encounter.crits, 1);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.history), true);

  // The singular package spelling counts too.
  harness.gmcp.dispatch("Darkwind.Combat.Event", {
    epoch: "connection-7",
    encounter_id: "encounter-12",
    ...swing(3, { damage: 50 }),
  });
  assert.equal(harness.dps.getSnapshot().encounter.damage, 1050);

  // Incoming swings never reach a tally.
  harness.gmcp.dispatch(
    "Darkwind.Combat.Events",
    events([swing(4, { perspective: "incoming", actor_id: "actor-2", target_id: "self", damage: 999 })]),
  );
  assert.equal(harness.dps.getSnapshot().encounter.damage, 1050);
});

test("a disconnect closes the live fight, a reset clears the session, and disposal stops publishing", async (t) => {
  const modules = await loadModules(t);
  const clock = { now: 2_000_000 };
  const harness = createHarness(modules, clock);
  harness.reconnect("connected");
  harness.gmcp.dispatch("Darkwind.Combat.State", state());
  harness.gmcp.dispatch("Darkwind.Combat.Events", events([swing(1, { damage: 300 })]));
  clock.now += 3_000;
  assert.equal(harness.dps.getSnapshot().active, true);

  harness.reconnect("disconnected");
  const closed = harness.dps.getSnapshot();
  assert.equal(closed.active, false, "the fight is finalized on disconnect");
  assert.equal(closed.session.damage, 300, "session totals survive the disconnect");
  assert.equal(closed.history.length, 1);

  harness.dps.resetSession();
  const reset = harness.dps.getSnapshot();
  assert.equal(reset.session.damage, 0);
  assert.equal(reset.history.length, 0);

  let published = 0;
  harness.dps.subscribe(() => {
    published += 1;
  });
  harness.scope.dispose();
  const before = published;
  harness.dps.resetSession();
  assert.equal(published, before, "a disposed runtime publishes nothing");
});
