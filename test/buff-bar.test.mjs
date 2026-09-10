import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createServer, isRunnableDevEnvironment } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(t) {
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
  return ssr.runner.import("/workspace/buff-bar.ts");
}

test("the buff bar counts a timed buff down from receipt, picks the soonest to expire, and honours a pin", async (t) => {
  const m = await loadModule(t);
  const stoneskin = { name: "stoneskin", desc: "Your skin is hardened.", kind: "buff", duration: 120, remaining: 85 };
  const haste = { name: "haste", kind: "buff", duration: 60, remaining: 30 };
  const poison = { name: "poison", kind: "debuff", duration: 40, remaining: 40 };
  const blessed = { name: "blessed", kind: "buff" };
  const received = new Map([[stoneskin, 0], [haste, 0], [poison, 0], [blessed, 0]]);
  const at = (item) => received.get(item) ?? 0;

  assert.equal(m.buffRemaining(stoneskin, 0, 10_000), 75, "ten seconds after receipt, ten fewer remain");
  assert.equal(m.buffRemaining(stoneskin, 0, 500_000), 0, "never below zero");
  assert.equal(m.buffRemaining(blessed, 0, 5_000), 0, "untimed buffs have no countdown");
  assert.equal(m.formatRemaining(75), "1:15");
  assert.equal(m.formatRemaining(3723), "1:02:03");
  assert.equal(m.formatRemaining(0), "0:00");

  const auto = m.buffBarReading([stoneskin, haste, poison, blessed], "", 0, at);
  assert.deepEqual(
    [auto.label, auto.kind, auto.timed, auto.percent, auto.text, auto.color, auto.pinnedName, auto.pinMissing],
    ["haste", "buff", true, 50, "0:30", "#3fb950", "", false],
    "automatic picks the timed buff closest to running out",
  );
  assert.deepEqual(auto.choices.map((c) => [c.name, c.kind]), [["stoneskin", "buff"], ["haste", "buff"], ["poison", "debuff"], ["blessed", "buff"]]);

  const later = m.buffBarReading([stoneskin, haste], "", 25_000, at);
  assert.deepEqual([later.label, later.remainingSeconds, later.percent, later.color], ["haste", 5, 8, "#f85149"], "under a tenth left is red");
  assert.equal(m.buffBarReading([stoneskin], "", 70_000, at).color, "#d29922", "under a quarter left is amber");

  const pinned = m.buffBarReading([stoneskin, haste], "stoneskin", 0, at);
  assert.deepEqual([pinned.label, pinned.percent, pinned.text, pinned.pinMissing], ["stoneskin", 71, "1:25", false]);
  const debuff = m.buffBarReading([poison], "poison", 0, at);
  assert.deepEqual([debuff.kind, debuff.color, debuff.percent], ["debuff", "#f85149", 100]);
  const untimed = m.buffBarReading([blessed], "", 0, at);
  assert.deepEqual([untimed.label, untimed.timed, untimed.percent, untimed.text], ["blessed", false, 100, "active"], "an untimed buff shows full");

  const missing = m.buffBarReading([haste], "stoneskin", 0, at);
  assert.deepEqual(
    [missing.known, missing.label, missing.text, missing.percent, missing.pinMissing, missing.choices.length],
    [false, "stoneskin", "not active", 0, true, 1],
    "a pinned buff that dropped shows empty under its own name",
  );
  const none = m.buffBarReading([], "", 0, at);
  assert.deepEqual([none.known, none.label, none.text], [false, "Buff", "--"]);
  assert.equal(m.buffBarReading(null, "", 0, at).choices.length, 0);
  assert.equal(m.buffBarReading([{ name: "" }, { kind: "buff" }], "", 0, at).known, false, "nameless entries are ignored");

  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
  const key = m.buffBarStorageKey("char-1");
  assert.equal(key, "darkflow-buff-bar:char-1");
  assert.equal(m.loadBuffBarPin(storage, key), "");
  assert.equal(m.saveBuffBarPin(storage, key, " stoneskin "), "stoneskin");
  assert.equal(m.loadBuffBarPin(storage, key), "stoneskin");
  assert.equal(m.saveBuffBarPin(storage, key, ""), "", "an empty name clears the pin");
  map.set(key, "{not json");
  assert.equal(m.loadBuffBarPin(storage, key), "", "unreadable storage reads as no pin");
  assert.equal(m.loadBuffBarPin(null, key), "");
  assert.equal(m.BUFF_BAR_PANEL_ID, "buffBar");
});
