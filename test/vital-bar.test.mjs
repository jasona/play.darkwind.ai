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
  return ssr.runner.import("/workspace/vital-bar.ts");
}

test("a vital bar reads its pair of fields, colours by the shared scale, and treats missing data as unknown", async (t) => {
  const { vitalReading, vitalBarKindForPanel, VITAL_BAR_PANEL_IDS } = await loadModule(t);

  const hp = vitalReading({ hp: 80, maxhp: 100, sp: 5, maxsp: 50 }, "hp");
  assert.deepEqual(
    [hp.label, hp.known, hp.current, hp.max, hp.percent, hp.text, hp.color],
    ["HP", true, 80, 100, 80, "80 / 100", "#3fb950"],
  );
  const sp = vitalReading({ hp: 80, maxhp: 100, sp: 5, maxsp: 50 }, "sp");
  assert.deepEqual([sp.label, sp.percent, sp.text, sp.color], ["SP", 10, "5 / 50", "#f85149"]);
  assert.equal(vitalReading({ hp: 45, maxhp: 100 }, "hp").color, "#d29922", "amber in the middle band");

  assert.equal(vitalReading({ hp: 30, mhp: 60 }, "hp").max, 60, "the legacy maximum spelling counts");
  assert.equal(vitalReading({ mana: 12, maxmana: 40 }, "sp").text, "12 / 40", "mana spellings feed SP");
  assert.equal(vitalReading({ mp: 3, mmp: 9 }, "sp").percent, 33);

  const unknown = vitalReading({ hp: 80, maxhp: 100 }, "sp");
  assert.deepEqual([unknown.known, unknown.percent, unknown.text], [false, 0, "--"], "no SP fields: unknown, not zero");
  assert.equal(vitalReading(null, "hp").known, false);
  assert.equal(vitalReading(undefined, "hp").text, "--");
  assert.equal(vitalReading({ hp: "80", maxhp: 100 }, "hp").known, false, "non-numeric fields are ignored");

  assert.equal(vitalReading({ hp: 140, maxhp: 100 }, "hp").percent, 100, "overfull clamps to 100");
  assert.equal(vitalReading({ hp: -5, maxhp: 100 }, "hp").percent, 0);
  assert.equal(vitalReading({ hp: -5, maxhp: 100 }, "hp").current, 0);
  assert.equal(vitalReading({ hp: 10, maxhp: 0 }, "hp").percent, 0, "a zero maximum is not a division");

  assert.deepEqual(VITAL_BAR_PANEL_IDS, { hp: "hpBar", sp: "spBar" });
  assert.equal(vitalBarKindForPanel("hpBar"), "hp");
  assert.equal(vitalBarKindForPanel("spBar"), "sp");
  assert.equal(vitalBarKindForPanel("vitals"), null);
});

test("guild resource slots pick meters by position or pin, colour reverse meters inverted, and keep pins as a preference", async (t) => {
  const m = await loadModule(t);
  const snapshot = {
    items: [
      { id: "vampire.vitae", guild: "Vampire", label: "Vitae", kind: "meter", cur: 40, max: 100, tip: "Blood." },
      { id: "vampire.frenzy", guild: "Vampire", label: "Frenzy", kind: "boolean", on: 1 },
      { id: "street_samurai.heat", guild: "Street Samurai", label: "Heat", kind: "meter_reverse", cur: 90, max: 100 },
      { id: "bad.meter", label: "Broken", kind: "meter", cur: 5, max: 0 },
      { id: "", label: "Nameless", kind: "meter", cur: 1, max: 2 },
      { id: "dk.wrath", guild: "Death Knight", label: "Wrath", kind: "meter_reverse", cur: 20, max: 50 },
    ],
  };
  const meters = m.guildMeters(snapshot);
  assert.deepEqual(
    meters.map((x) => [x.id, x.label, x.percent, x.reverse]),
    [
      ["vampire.vitae", "Vitae", 40, false],
      ["street_samurai.heat", "Heat", 90, true],
      ["dk.wrath", "Wrath", 40, true],
    ],
    "only well-formed meter kinds count",
  );
  assert.deepEqual(m.guildMeters({ bars: [{ id: "g.r", label: "Resource", kind: "warning", cur: 5, max: 10 }] }).map((x) => [x.label, x.reverse]), [["Resource", true]], "v1 bars are meters; warning is reverse");
  assert.deepEqual(m.guildMeters(null), []);

  const slot1 = m.guildBarReading(snapshot, 1, "");
  assert.deepEqual([slot1.label, slot1.text, slot1.percent, slot1.color, slot1.pinMissing], ["Vitae", "40 / 100", 40, "#d29922", false]);
  const slot3 = m.guildBarReading(snapshot, 3, null);
  assert.deepEqual([slot3.label, slot3.color], ["Wrath", "#d29922"], "a reverse meter at 40% is amber on the inverted scale");
  assert.equal(m.guildBarReading(snapshot, 2, "").color, m.guildMeterColor(meters[1]), "heat keeps its own ramp");
  assert.equal(m.guildMeterColor({ ...meters[2], percent: 90 }), "#f85149", "a full reverse meter is red");
  assert.equal(m.guildMeterColor({ ...meters[2], percent: 10 }), "#3fb950");

  const pinned = m.guildBarReading(snapshot, 1, "dk.wrath");
  assert.deepEqual([pinned.label, pinned.pinnedId, pinned.pinMissing], ["Wrath", "dk.wrath", false]);
  const missing = m.guildBarReading(snapshot, 2, "fighter.prowess");
  assert.deepEqual([missing.label, missing.pinMissing], ["Heat", true], "a missing pin falls back to the slot's position and says so");
  const empty = m.guildBarReading(snapshot, 5, "");
  assert.deepEqual([empty.known, empty.text, empty.label], [false, "--", "Guild resource 5"]);
  assert.equal(m.guildBarReading(null, 1, "").choices.length, 0);

  assert.deepEqual(m.GUILD_BAR_PANEL_IDS, ["guildBar1", "guildBar2", "guildBar3"]);
  assert.equal(m.guildBarSlotForPanel("guildBar2"), 2);
  assert.equal(m.guildBarSlotForPanel("hpBar"), 0);

  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
  const key = m.guildBarStorageKey("char-1");
  assert.equal(key, "darkflow-guild-bars:char-1");
  assert.deepEqual(m.loadGuildBarPins(storage, key), {});
  assert.deepEqual(m.saveGuildBarPin(storage, key, 1, "vampire.vitae"), { 1: "vampire.vitae" });
  assert.deepEqual(m.saveGuildBarPin(storage, key, 2, " dk.wrath "), { 1: "vampire.vitae", 2: "dk.wrath" });
  assert.deepEqual(m.loadGuildBarPins(storage, key), { 1: "vampire.vitae", 2: "dk.wrath" });
  assert.deepEqual(m.saveGuildBarPin(storage, key, 1, ""), { 2: "dk.wrath" }, "an empty id clears the pin");
  map.set(key, "{not json");
  assert.deepEqual(m.loadGuildBarPins(storage, key), {}, "unreadable storage reads as no pins");
  map.set(key, JSON.stringify({ pins: { x: "bad", 3: 7, 1: "ok" } }));
  assert.deepEqual(m.loadGuildBarPins(storage, key), { 1: "ok" }, "only numeric slots with string ids survive");
  assert.deepEqual(m.loadGuildBarPins(null, key), {});
});
