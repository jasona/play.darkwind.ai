import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer, isRunnableDevEnvironment } from "vite";

// The Auto-Angler runtime against the real interactions runtime: the server's
// fishing frames go in through the GMCP bus, and the casts, hooks, and
// commands the addon sends come out the other side. Timers run on node's mock
// clock, advanced in small steps so the addon's own clock keeps pace with
// them the way a frame loop would.

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
  const [auto, interactions, bus, diagnostics, ids, scope, events] = await Promise.all([
    ssr.runner.import("/runtime/fishing-auto.ts"),
    ssr.runner.import("/runtime/interactions.ts"),
    ssr.runner.import("/gmcp/bus.ts"),
    ssr.runner.import("/runtime/diagnostics.ts"),
    ssr.runner.import("/model/ids.ts"),
    ssr.runner.import("/runtime/resource-scope.ts"),
    ssr.runner.import("/runtime/event-bus.ts"),
  ]);
  return { ...auto, ...interactions, ...bus, ...diagnostics, ...ids, ...scope, ...events };
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

function createHarness(modules, t, { storage = memoryStorage(), connected = true } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clock = { now: 100_000 };
  const sessionId = modules.createSessionId(modules.createSequentialUuidFactory());
  const diagnostics = new modules.SessionDiagnostics(sessionId);
  const scope = modules.createResourceScope(sessionId, diagnostics);
  t.after(() => {
    if (!scope.disposed) scope.dispose();
  });
  const eventBus = modules.createSessionEventBus(sessionId, diagnostics);
  const frames = [];
  const gmcp = modules.createSessionGmcpBus(
    sessionId,
    (bytes) => {
      frames.push(new TextDecoder().decode(bytes));
      return true;
    },
    diagnostics,
  );
  const transport = {
    state: "connected",
    getHealthSnapshot: () => ({ lastInboundAt: 0 }),
    forceReconnect() {},
  };
  const interactions = modules.createSessionInteractions(gmcp, scope, eventBus, transport);
  const commands = [];
  const state = { connected };
  const fishingAuto = modules.createSessionFishingAuto(
    scope,
    eventBus,
    interactions,
    (text) => {
      commands.push(text);
      return true;
    },
    () => state.connected,
    { now: () => clock.now, seed: 7, storage, storageKey: "autofish-test" },
  );
  const messages = [];
  fishingAuto.subscribeMessages((message) => messages.push(message));
  const actions = [];
  let lastSeq = 0;
  fishingAuto.subscribe((snapshot) => {
    if (snapshot.action && snapshot.action.seq !== lastSeq) {
      lastSeq = snapshot.action.seq;
      actions.push(snapshot.action);
    }
  });
  // Advance the addon's clock and the timer queue together, a frame at a time.
  const advance = (ms) => {
    let remaining = ms;
    while (remaining > 0) {
      const step = Math.min(25, remaining);
      clock.now += step;
      t.mock.timers.tick(step);
      remaining -= step;
    }
  };
  const open = (session, baited = true) =>
    gmcp.dispatch("Darkwind.Fishing.Open", {
      session,
      terrain: "lake",
      skill: 10,
      poleTier: 1,
      baitTier: 1,
      baited: baited ? 1 : 0,
      sceneArtUrl: null,
    });
  const fightParams = {
    strength: 7,
    erratic: 6,
    stamina: 110,
    barSize: 20,
    progressRate: 9,
    drainRate: 11,
    tensionRise: 17,
    tensionDecay: 12,
    minFightMs: 6000,
  };
  const fish = { id: "carp", name: "a carp", short: "carp", rarity: "common", sizePct: 50, sizeCm: 30, weightKg: 1, quality: 50, pristine: 0, artUrl: null, tease: "Something tugs.", rarityHint: "common" };
  const rewards = { skillup: 0, newSkill: 10 };
  const disconnect = () =>
    eventBus.publish("transport:reconnect-status", { status: "scheduled", attempt: 1, transport: "ws" });
  const sentKinds = () => frames.map((frame) => frame.split(" ")[0]);
  return {
    actions,
    advance,
    clock,
    commands,
    disconnect,
    fightParams,
    fish,
    fishingAuto,
    rewards,
    frames,
    gmcp,
    interactions,
    messages,
    open,
    scope,
    sentKinds,
    state,
    storage,
  };
}

test("the slash command line is recognised with its arguments", async (t) => {
  const { parseAutofishLine } = await loadModules(t);
  assert.deepEqual(parseAutofishLine("/autofish"), []);
  assert.deepEqual(parseAutofishLine("  /AutoFish power 70 "), ["power", "70"]);
  assert.equal(parseAutofishLine("/autofishing"), null);
  assert.equal(parseAutofishLine("fish"), null);
  assert.equal(parseAutofishLine(""), null);
});

test("switching on with no session opens one, then plays a full cycle through to re-baiting", async (t) => {
  const modules = await loadModules(t);
  const h = createHarness(modules, t);

  h.fishingAuto.handleCommand(["on"]);
  assert.deepEqual(h.commands, ["fish"], "no session: open one");
  assert.equal(h.messages[0].text, "Auto-Angler on.");
  assert.deepEqual(h.messages[1], { kind: "echo", text: "fish" }, "sent commands are echoed");
  assert.equal(h.fishingAuto.getSnapshot().enabled, true);

  h.open("s1");
  assert.equal(h.fishingAuto.getSnapshot().phase, "casting");
  assert.equal(h.actions.at(-1).kind, "cast-begin", "a baited session starts a cast");
  h.advance(1300);
  const cast = h.frames.find((frame) => frame.startsWith("Darkwind.Fishing.Cast"));
  assert.ok(cast, "the cast went out through the interactions runtime: " + h.frames.join(" | "));
  const castPayload = JSON.parse(cast.slice("Darkwind.Fishing.Cast ".length));
  assert.equal(castPayload.session, "s1");
  assert.ok(castPayload.power >= 0 && castPayload.power <= 100);
  assert.equal(h.actions.at(-1).kind, "cast");
  assert.equal(h.actions.at(-1).power, castPayload.power);
  assert.equal(h.fishingAuto.getSnapshot().phase, "waiting");

  h.gmcp.dispatch("Darkwind.Fishing.Bite", { session: "s1", windowMs: 2500, tease: "A nibble." });
  assert.equal(h.fishingAuto.getSnapshot().phase, "bite");
  assert.equal(h.sentKinds().filter((k) => k === "Darkwind.Fishing.Hook").length, 0, "not hooked on the frame the bite arrived");
  h.advance(140);
  assert.equal(h.sentKinds().filter((k) => k === "Darkwind.Fishing.Hook").length, 0, "never under the plausibility floor");
  h.advance(1400);
  assert.equal(h.sentKinds().filter((k) => k === "Darkwind.Fishing.Hook").length, 1, "hooked inside the window");
  assert.equal(h.actions.at(-1).kind, "hook");
  assert.equal(h.fishingAuto.getSnapshot().phase, "hooking");

  h.gmcp.dispatch("Darkwind.Fishing.Fight", { session: "s1", seed: 3, params: h.fightParams, fish: h.fish });
  assert.equal(h.fishingAuto.getSnapshot().phase, "fight");
  const simState = { fishPos: 50, barPos: 40, tension: 20, tensionPeak: 20, progress: 30, running: false, elapsedMs: 100, overlapMs: 0 };
  assert.equal(typeof h.fishingAuto.resolveHeld(false, simState, 16), "boolean", "the controller decides the held state");
  h.fishingAuto.notifyFightEnd();
  assert.equal(h.fishingAuto.getSnapshot().phase, "resolving");

  const before = h.fishingAuto.getSnapshot().castPower;
  h.gmcp.dispatch("Darkwind.Fishing.Caught", { session: "s1", fish: h.fish, rewards: h.rewards });
  const afterCatch = h.fishingAuto.getSnapshot();
  assert.equal(afterCatch.phase, "caught");
  assert.equal(afterCatch.landed, 1);
  assert.equal(afterCatch.cycles, 1);
  assert.equal(afterCatch.castPower, before + 2, "a confirmed catch raises the adaptive power");
  assert.match(afterCatch.summary, /1/);
  assert.equal(h.fishingAuto.resolveHeld(true, simState, 16), true, "no controller between fights");

  const commandsBefore = h.commands.length;
  h.advance(2700);
  assert.equal(h.commands[commandsBefore], "bait hook", "re-baits after the cycle pause");
  h.advance(1000);
  assert.equal(h.commands[commandsBefore + 1], "fish");
  assert.equal(JSON.parse(h.storage.map.get("autofish-test")).castPower, before + 2, "the adaptive power is persisted");
});

test("an unbaited open after our own bait attempt halts the run as out of bait", async (t) => {
  const modules = await loadModules(t);
  const h = createHarness(modules, t);
  h.fishingAuto.enable();
  h.open("s1", false);
  assert.equal(h.commands.at(-1), "bait hook", "an unbaited open is baited first");
  h.advance(1000);
  assert.equal(h.commands.at(-1), "fish");
  h.open("s2", false);
  const snapshot = h.fishingAuto.getSnapshot();
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.haltReason, "Out of bait.");
  assert.equal(h.messages.at(-1).text, "Auto-Angler off. Out of bait.");
  assert.equal(JSON.parse(h.storage.map.get("autofish-test")).enabled, false);
});

test("escapes count by cause and lower the power; a timeout leaves it alone; a pin is never adapted", async (t) => {
  const modules = await loadModules(t);
  const h = createHarness(modules, t);
  h.fishingAuto.enable();
  h.open("s1");
  h.advance(1300);
  const start = h.fishingAuto.getSnapshot().castPower;
  h.gmcp.dispatch("Darkwind.Fishing.Escaped", { session: "s1", reason: "snap" });
  assert.equal(h.fishingAuto.getSnapshot().castPower, start - 8);
  assert.equal(h.fishingAuto.getSnapshot().lostBy.snap, 1);
  h.gmcp.dispatch("Darkwind.Fishing.Escaped", { session: "s1", reason: "timeout" });
  assert.equal(h.fishingAuto.getSnapshot().castPower, start - 8, "timeouts say nothing about the fish");
  assert.equal(h.fishingAuto.getSnapshot().lost, 2);

  h.fishingAuto.handleCommand(["power", "70"]);
  assert.equal(h.fishingAuto.getSnapshot().powerOverride, 70);
  assert.equal(h.fishingAuto.getSnapshot().power, 70);
  assert.equal(h.messages.at(-1).text, "Auto-Angler cast power fixed at 70.");
  h.gmcp.dispatch("Darkwind.Fishing.Caught", { session: "s1", fish: h.fish, rewards: h.rewards });
  assert.equal(h.fishingAuto.getSnapshot().castPower, start - 8, "a pinned power is never adapted");
  h.fishingAuto.handleCommand(["power", "auto"]);
  assert.equal(h.fishingAuto.getSnapshot().powerOverride, null);
  h.fishingAuto.handleCommand(["nonsense"]);
  assert.match(h.messages.at(-1).text, /^Auto-Angler: /);
  h.fishingAuto.handleCommand([]);
  assert.match(h.messages.at(-1).text, /Auto-Angler/, "bare /autofish prints the status");
});

test("manual input, the session ending, closing the panel, and a disconnect each halt with their reason", async (t) => {
  const modules = await loadModules(t);
  const h = createHarness(modules, t);

  h.fishingAuto.enable();
  h.open("s1");
  h.fishingAuto.notifyManualInput();
  assert.equal(h.fishingAuto.getSnapshot().haltReason, "You took over.");
  assert.equal(h.fishingAuto.getSnapshot().phase, "ready", "an abandoned charge returns the stage to ready");
  const framesBefore = h.frames.length;
  h.advance(2000);
  assert.equal(h.frames.length, framesBefore, "the pending release was cancelled");

  h.fishingAuto.enable();
  h.gmcp.dispatch("Darkwind.Fishing.End", { session: "s1", reason: "left", message: "You pack up." });
  assert.equal(h.fishingAuto.getSnapshot().haltReason, "The fishing session ended.");
  assert.equal(h.fishingAuto.getSnapshot().phase, "idle");

  h.fishingAuto.enable();
  assert.equal(h.commands.at(-1), "fish");
  h.open("s2");
  h.interactions.cancelFishing("s2");
  assert.equal(h.fishingAuto.getSnapshot().haltReason, "The fishing session ended.");

  h.fishingAuto.enable();
  h.open("s3");
  h.state.connected = false;
  h.disconnect();
  assert.equal(h.fishingAuto.getSnapshot().enabled, false);
  assert.equal(h.fishingAuto.getSnapshot().haltReason, "Connection lost.");

  h.state.connected = false;
  const commandsBefore = h.commands.length;
  h.fishingAuto.handleCommand(["on"]);
  assert.equal(h.commands.length, commandsBefore, "nothing is sent while disconnected");
  h.fishingAuto.handleCommand(["on"]);
  assert.equal(h.messages.at(-1).text, "Auto-Angler is already on.");
  h.fishingAuto.toggle();
  assert.equal(h.fishingAuto.getSnapshot().haltReason, "Switched off.");
});

test("a fight the controller cannot model hands control back", async (t) => {
  const modules = await loadModules(t);
  const h = createHarness(modules, t);
  h.fishingAuto.enable();
  h.open("s1");
  h.gmcp.dispatch("Darkwind.Fishing.Fight", {
    session: "s1",
    seed: 3,
    params: { ...h.fightParams, barSize: -5 },
    fish: h.fish,
  });
  assert.equal(h.fishingAuto.getSnapshot().enabled, false);
  assert.match(h.fishingAuto.getSnapshot().haltReason, /cannot model\. \(barSize\)/);
  assert.equal(h.fishingAuto.resolveHeld(true, {}, 16), true, "and never drives the bar");
});

test("a run left on comes back armed without sending anything, and takes over when a session opens", async (t) => {
  const modules = await loadModules(t);
  const storage = memoryStorage({
    "autofish-test": JSON.stringify({ enabled: true, castPower: 63, powerOverride: null }),
  });
  const h = createHarness(modules, t, { storage });
  const snapshot = h.fishingAuto.getSnapshot();
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.castPower, 63);
  assert.deepEqual(h.commands, [], "no fish at the login prompt");
  assert.match(h.messages[0].text, /restored/);
  h.open("s1");
  assert.equal(h.fishingAuto.getSnapshot().phase, "casting");

  h.scope.dispose();
  h.fishingAuto.handleCommand(["off"]);
  assert.equal(h.fishingAuto.getSnapshot().enabled, true, "a disposed runtime is inert");
});
