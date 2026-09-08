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
