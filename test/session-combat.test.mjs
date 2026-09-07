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
  const [combat, information, bus, diagnostics, ids, scope, events] = await Promise.all([
    ssr.runner.import("/runtime/combat.ts"),
    ssr.runner.import("/runtime/information.ts"),
    ssr.runner.import("/gmcp/bus.ts"),
    ssr.runner.import("/runtime/diagnostics.ts"),
    ssr.runner.import("/model/ids.ts"),
    ssr.runner.import("/runtime/resource-scope.ts"),
    ssr.runner.import("/runtime/event-bus.ts"),
  ]);
  return { ...combat, ...information, ...bus, ...diagnostics, ...ids, ...scope, ...events };
}

function createHarness(modules) {
  const sessionId = modules.createSessionId(modules.createSequentialUuidFactory());
  const diagnostics = new modules.SessionDiagnostics(sessionId);
  const scope = modules.createResourceScope(sessionId, diagnostics);
  const eventBus = modules.createSessionEventBus(sessionId, diagnostics);
  const sent = [];
  let allowSend = true;
  const gmcp = modules.createSessionGmcpBus(sessionId, (bytes) => {
    sent.push(new TextDecoder().decode(bytes));
    return allowSend;
  }, diagnostics);
  const information = modules.createSessionInformation(gmcp, scope, eventBus);
  const combat = modules.createSessionCombat(gmcp, scope, eventBus, information);
  const reconnect = (status) =>
    eventBus.publish("transport:reconnect-status", {
      status,
      attempt: 0,
      transport: "ws",
    });
  return {
    combat,
    gmcp,
    reconnect,
    scope,
    sent,
    setAllowSend(value) {
      allowSend = value;
    },
  };
}

function state(overrides = {}) {
  return {
    epoch: "combat-1",
    encounter_id: "encounter-1",
    seq: 1,
    visual_enabled: 1,
    effective: 0,
    active: 1,
    current_actor_id: "self",
    current_target_id: "target",
    actors: [
      { id: "self", name: "Acer", role: "self" },
      { id: "target", name: "an ash drake", role: "target" },
    ],
    outcome: "",
    summary: "Combat begins.",
    ...overrides,
  };
}

function event(seq, overrides = {}) {
  return {
    seq,
    kind: "attack",
    perspective: "outgoing",
    actor_id: "self",
    target_id: "target",
    result: "hit",
    damage: seq,
    summary: `Hit ${seq}.`,
    ...overrides,
  };
}

test("combat snapshots carry the recipient's Char.Status and inventory for the stage", async (t) => {
  const modules = await loadModules(t);
  const harness = createHarness(modules);
  t.after(() => harness.scope.dispose());

  harness.reconnect("connected");
  harness.gmcp.dispatch("Char.Status", { name: "Acer", race: "Scro", class: "Berserker", gender: "Male" });
  harness.gmcp.dispatch("Char.Items.List", {
    location: "inv",
    items: [{ id: "r1", name: "a slender rapier (main weapon)", attrib: "l" }],
  });
  harness.gmcp.dispatch("Darkwind.Combat.State", state());

  const snapshot = harness.combat.getSnapshot();
  assert.equal(snapshot.status?.race, "Scro");
  assert.equal(snapshot.status?.gender, "Male");
  assert.equal(snapshot.inventory.length, 1);
  assert.equal(snapshot.inventory[0].id, "r1");
  assert.equal(Object.isFrozen(snapshot.inventory), true);

  harness.gmcp.dispatch("Char.Items.List", { location: "room", items: [{ id: "x" }] });
  assert.equal(harness.combat.getSnapshot().inventory.length, 1, "only the inventory location counts");

  harness.reconnect("disconnected");
  assert.equal(harness.combat.getSnapshot().status, null, "a dropped connection clears the descriptor inputs");
  assert.equal(harness.combat.getSnapshot().inventory.length, 0);
});

function framesFor(sent, packageName) {
  return sent.filter((frame) => frame === packageName || frame.startsWith(packageName + " "));
}

function payload(frame, packageName) {
  return JSON.parse(frame.slice(packageName.length + 1));
}

test("combat bootstrap, authoritative display inputs, readiness, and manual close stay exact", async (t) => {
  const modules = await loadModules(t);
  const harness = createHarness(modules);
  t.after(() => harness.scope.dispose());
  const snapshots = [];
  harness.combat.subscribe((snapshot) => snapshots.push(snapshot));

  harness.reconnect("connected");
  assert.equal(
    framesFor(harness.sent, "Darkwind.Client.Subscriptions").length,
    0,
    "connection alone leaves the central full handshake in sole control",
  );
  harness.gmcp.dispatch("Char.Vitals", { hp: 91, maxhp: 100 });
  harness.gmcp.dispatch("Darkwind.Char.Avatar", { url: "/avatar.png", name: "Acer" });
  harness.gmcp.dispatch("Char.Enemy", {
    enemy_name: "an ash drake",
    enemy_curhp: 40,
    enemy_maxhp: 50,
    enemy_image: "/drake.png",
    ignored: "not public",
  });
  harness.gmcp.dispatch("Darkwind.Combat.State", state());

  let snapshot = harness.combat.getSnapshot();
  assert.equal(snapshot.shouldPresent, true, "effective false still bootstraps the pane");
  assert.equal(snapshot.presentationReady, false);
  assert.equal(snapshot.vitals?.hp, 91);
  assert.equal(snapshot.avatar?.url, "/avatar.png");
  assert.equal(snapshot.enemy?.enemy_name, "an ash drake");
  assert.equal(snapshot.enemy?.ignored, undefined);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.model.actors), true);
  assert.equal(Object.isFrozen(snapshot.enemy), true);

  harness.sent.length = 0;
  harness.setAllowSend(false);
  harness.combat.setPresentationReady(true);
  assert.equal(harness.combat.getSnapshot().presentationReady, true);
  assert.equal(framesFor(harness.sent, "Darkwind.Combat.Resync").length, 0);
  harness.setAllowSend(true);
  harness.combat.setPresentationReady(true);
  assert.equal(harness.sent.at(-1), "Darkwind.Combat.Resync");
  assert.equal(
    payload(
      framesFor(harness.sent, "Darkwind.Client.Subscriptions").at(-1),
      "Darkwind.Client.Subscriptions",
    ).features.combatPane,
    true,
  );

  harness.combat.setPresentationReady(false);
  assert.equal(harness.combat.getSnapshot().presentationReady, false);
  assert.equal(harness.combat.getSnapshot().shouldPresent, true, "render failure keeps retry eligible");
  assert.equal(
    payload(framesFor(harness.sent, "Darkwind.Client.Subscriptions").at(-1), "Darkwind.Client.Subscriptions")
      .features.combatPane,
    false,
  );
  harness.combat.setPresentationReady(true);

  harness.combat.dismissEncounter();
  snapshot = harness.combat.getSnapshot();
  assert.equal(snapshot.presentationReady, false);
  assert.equal(snapshot.shouldPresent, false);
  assert.equal(snapshot.manuallyDismissedEncounter, "encounter-1");
  assert.equal(
    payload(framesFor(harness.sent, "Darkwind.Client.Subscriptions").at(-1), "Darkwind.Client.Subscriptions")
      .features.combatPane,
    false,
  );

  harness.gmcp.dispatch("Darkwind.Combat.State", state({ seq: 2, summary: "Still fighting." }));
  assert.equal(harness.combat.getSnapshot().shouldPresent, false, "same encounter stays dismissed");
  const beforeStaleState = harness.combat.getSnapshot().model;
  harness.gmcp.dispatch("Darkwind.Combat.State", state({ seq: 1, summary: "Stale." }));
  assert.equal(harness.combat.getSnapshot().model, beforeStaleState);
  harness.combat.setPresentationReady(true);
  assert.equal(
    harness.combat.getSnapshot().presentationReady,
    false,
    "same-encounter remount stays dismissed",
  );
  assert.equal(harness.combat.getSnapshot().shouldPresent, false);

  const trueSubscriptionsBeforeNewEncounter = framesFor(
    harness.sent,
    "Darkwind.Client.Subscriptions",
  ).filter(
    (frame) => payload(frame, "Darkwind.Client.Subscriptions").features.combatPane === true,
  ).length;
  harness.gmcp.dispatch(
    "Darkwind.Combat.State",
    state({ encounter_id: "encounter-2", seq: 3, summary: "A new fight." }),
  );
  snapshot = harness.combat.getSnapshot();
  assert.equal(snapshot.manuallyDismissedEncounter, "");
  assert.equal(snapshot.shouldPresent, true, "a new encounter may auto-open");
  assert.equal(snapshot.presentationReady, false);
  assert.equal(
    framesFor(harness.sent, "Darkwind.Client.Subscriptions").filter(
      (frame) => payload(frame, "Darkwind.Client.Subscriptions").features.combatPane === true,
    ).length,
    trueSubscriptionsBeforeNewEncounter,
    "new encounter waits for its renderer before advertising",
  );
  harness.combat.setPresentationReady(true);
  assert.equal(harness.combat.getSnapshot().presentationReady, true);
  assert.equal(harness.sent.at(-1), "Darkwind.Combat.Resync");

  harness.gmcp.dispatch(
    "Darkwind.Combat.State",
    state({ encounter_id: "encounter-2", seq: 4, active: 0, outcome: "victory" }),
  );
  assert.equal(harness.combat.getSnapshot().shouldPresent, false, "encounter end hides immediately");
  assert.ok(snapshots.length > 8);
});

test("combat orders batch and singular events and cancels every late beat", async (t) => {
  const modules = await loadModules(t);
  const timers = [];
  const cancelled = new Set();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, delay) => {
    const id = timers.length;
    timers.push({ callback, delay });
    return id;
  };
  globalThis.clearTimeout = (id) => cancelled.add(id);
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  const harness = createHarness(modules);
  t.after(() => harness.scope.dispose());
  harness.reconnect("connected");
  harness.gmcp.dispatch("Darkwind.Combat.State", state());
  harness.gmcp.dispatch("Darkwind.Combat.Events", {
    epoch: "combat-1",
    encounter_id: "encounter-1",
    first_seq: 2,
    last_seq: 3,
    events: [event(3), event(2)],
    overflow: { omitted: 0, hits: 0, damage: 0 },
  });

  assert.equal(harness.combat.getSnapshot().model.currentEvent?.seq, 2);
  assert.equal(harness.combat.getSnapshot().model.pending[0]?.seq, 3);
  assert.equal(timers[0].delay, modules.COMBAT_BEAT_MS);
  timers[0].callback();
  assert.equal(harness.combat.getSnapshot().model.currentEvent?.seq, 3);
  timers[1].callback();
  assert.equal(harness.combat.getSnapshot().model.currentEvent, null);

  harness.gmcp.dispatch("Darkwind.Combat.Event", {
    epoch: "combat-1",
    encounter_id: "encounter-1",
    ...event(4, { perspective: "incoming" }),
  });
  assert.equal(harness.combat.getSnapshot().model.currentEvent?.seq, 4);
  assert.equal(harness.combat.getSnapshot().model.currentEvent?.perspective, "incoming");

  const beforeStale = harness.combat.getSnapshot().model;
  harness.gmcp.dispatch("Darkwind.Combat.Event", {
    epoch: "old",
    encounter_id: "encounter-1",
    ...event(5),
  });
  assert.equal(harness.combat.getSnapshot().model, beforeStale);
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    harness.gmcp.dispatch("Darkwind.Combat.Event", {
      epoch: "combat-1",
      encounter_id: "encounter-1",
      ...event("5"),
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(harness.combat.getSnapshot().model, beforeStale, "malformed advisory delivery is ignored");

  harness.combat.setReducedMotion(true);
  assert.equal(harness.combat.getSnapshot().model.reducedMotion, true);
  assert.equal(timers[2].delay, modules.COMBAT_BEAT_MS, "static reduced motion keeps the readable beat");

  harness.reconnect("connecting");
  const disconnected = harness.combat.getSnapshot();
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.model.currentEvent, null);
  assert.equal(cancelled.has(2), true, "reconnect cancels the only pending beat");
  assert.equal(harness.combat.getSnapshot(), disconnected);

  harness.reconnect("connected");
  assert.equal(harness.combat.getSnapshot().shouldPresent, false, "reconnect requires fresh State");
  harness.gmcp.dispatch("Darkwind.Combat.State", state({ epoch: "combat-2" }));
  harness.gmcp.dispatch("Darkwind.Combat.Event", {
    epoch: "combat-2",
    encounter_id: "encounter-1",
    ...event(2),
  });
  const disposalBeat = timers[3].callback;
  harness.scope.dispose();
  const disposed = harness.combat.getSnapshot();
  disposalBeat();
  assert.equal(harness.combat.getSnapshot(), disposed, "scope guard suppresses a disposed late timer");
});

test("combat recovery and two sessions isolate readiness, queues, reconnect, and disposal", async (t) => {
  const modules = await loadModules(t);
  const first = createHarness(modules);
  const second = createHarness(modules);
  t.after(() => first.scope.dispose());
  t.after(() => second.scope.dispose());
  first.reconnect("connected");
  second.reconnect("connected");
  first.gmcp.dispatch("Darkwind.Combat.State", state({ encounter_id: "first" }));
  second.gmcp.dispatch(
    "Darkwind.Combat.State",
    state({ epoch: "combat-b", encounter_id: "second" }),
  );
  first.combat.setPresentationReady(true);
  first.sent.length = 0;
  second.sent.length = 0;

  first.gmcp.dispatch("Darkwind.Session.Recovered", { mode: "linkdead" });
  assert.deepEqual(first.sent.map((frame) => frame.split(" ")[0]), [
    "Darkwind.Client.Subscriptions",
    "Darkwind.Combat.Resync",
  ]);
  assert.equal(
    payload(first.sent[0], "Darkwind.Client.Subscriptions").features.combatPane,
    true,
  );
  assert.equal(second.sent.length, 0, "another session receives no recovery traffic");

  second.gmcp.dispatch("Darkwind.Session.Recovered", { mode: "linkdead" });
  assert.equal(second.sent.length, 1);
  assert.equal(
    payload(second.sent[0], "Darkwind.Client.Subscriptions").features.combatPane,
    false,
  );

  first.gmcp.dispatch("Darkwind.Combat.Event", {
    epoch: "combat-1",
    encounter_id: "first",
    ...event(2),
  });
  assert.equal(first.combat.getSnapshot().model.currentEvent?.seq, 2);
  assert.equal(second.combat.getSnapshot().model.currentEvent, null);

  first.reconnect("idle");
  assert.equal(first.combat.getSnapshot().model.epoch, "");
  assert.equal(second.combat.getSnapshot().model.epoch, "combat-b");

  second.combat.setPresentationReady(true);
  second.sent.length = 0;
  second.scope.dispose();
  assert.equal(
    payload(second.sent.at(-1), "Darkwind.Client.Subscriptions").features.combatPane,
    false,
  );
  const disposed = second.combat.getSnapshot();
  assert.equal(disposed.connected, false);
  assert.equal(disposed.presentationReady, false);
  assert.equal(disposed.model.epoch, "");
  second.gmcp.dispatch("Darkwind.Combat.State", state({ epoch: "late" }));
  assert.equal(second.combat.getSnapshot(), disposed);
});
