import test from 'node:test';
import assert from 'node:assert/strict';
import { castPowerAt } from '../public/js/fishing-core.mjs';
import {
  TUNING,
  PARAM_DEFAULTS,
  GRACE_MS,
  OVERLAP_PAD,
  CAST_PEAK_MS,
  BITE_WINDOW_DEFAULT_MS,
  CAST_POWER_SIGNALS,
  createRng,
  clamp,
  randRange,
  randTriangular,
  toFiniteOrNull,
  castReleaseMs,
  jitterPower,
  isReleaseUsable,
  hookDelayMs,
  nextCastPower,
  normalizeFightParams,
  createFightController,
} from '../public/js/fishing-auto-core.mjs';

const SPEC_PARAMS = {
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

// ---- RNG helpers ----------------------------------------------------------

test('createRng is deterministic and survives a bad seed', () => {
  const a = createRng(4242);
  const b = createRng(4242);
  for (let i = 0; i < 50; i++) assert.equal(a(), b());

  for (const bad of [undefined, null, NaN, 'x']) {
    assert.equal(typeof createRng(bad)(), 'number');
  }
});

test('clamp maps non-finite input to the low bound', () => {
  assert.equal(clamp(5, 1, 10), 5);
  assert.equal(clamp(-3, 1, 10), 1);
  assert.equal(clamp(99, 1, 10), 10);
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, 'x']) {
    assert.equal(clamp(bad, 1, 10), 1);
  }
});

test('randTriangular stays in range and peaks at its mode', () => {
  const rand = createRng(7);
  const draws = Array.from({ length: 20000 }, () => randTriangular(rand, 100, 500, 200));

  assert.ok(Math.min(...draws) >= 100);
  assert.ok(Math.max(...draws) <= 500);

  // Mean of a triangular distribution is (lo + hi + mode) / 3.
  const mean = draws.reduce((a, b) => a + b, 0) / draws.length;
  assert.ok(Math.abs(mean - (100 + 500 + 200) / 3) < 8, 'mean ' + mean);

  // The mode side must be denser than the tail.
  const nearMode = draws.filter((d) => d >= 150 && d <= 250).length;
  const nearTail = draws.filter((d) => d >= 400 && d <= 500).length;
  assert.ok(nearMode > nearTail * 2);
});

// The clamp-based approach this replaced piled ~10% of all draws onto the
// boundary value exactly. A spike of identical timings is the artifact the
// whole module exists to avoid, so it is worth a standing test.
test('randTriangular does not pile draws onto a boundary', () => {
  const rand = createRng(11);
  const draws = Array.from({ length: 20000 }, () =>
    Math.round(randTriangular(rand, 180, 550, 280)));

  const counts = new Map();
  for (const d of draws) counts.set(d, (counts.get(d) || 0) + 1);
  const worst = Math.max(...counts.values()) / draws.length;

  assert.ok(worst < 0.02, 'most common value took ' + (worst * 100).toFixed(1) + '%');
  assert.ok(counts.size > 200, 'only ' + counts.size + ' distinct values');
});

test('randTriangular degenerates safely', () => {
  const rand = createRng(3);
  assert.equal(randTriangular(rand, 5, 5, 5), 5);
  assert.equal(randTriangular(rand, 9, 1, 5), 9); // hi <= lo
});

test('randRange stays within bounds', () => {
  const rand = createRng(19);
  for (let i = 0; i < 500; i++) {
    const v = randRange(rand, -2, 2);
    assert.ok(v >= -2 && v <= 2);
  }
});

// ---- toFiniteOrNull -------------------------------------------------------

test('toFiniteOrNull rejects what Number() would silently coerce', () => {
  assert.equal(toFiniteOrNull(42), 42);
  assert.equal(toFiniteOrNull(0), 0);
  assert.equal(toFiniteOrNull('9'), 9);
  assert.equal(toFiniteOrNull('1e3'), 1000);

  // Number('') and Number(false) are both 0 - which would become a zero
  // divisor. Number(true) is 1. None of these are real values.
  for (const bad of ['', '   ', true, false, null, undefined, NaN, Infinity, 'abc', {}, []]) {
    assert.equal(toFiniteOrNull(bad), null, JSON.stringify(bad) + ' should be null');
  }
});

// ---- Cast timing ----------------------------------------------------------

test('castReleaseMs round-trips through castPowerAt for every power', () => {
  for (let power = 0; power <= 100; power++) {
    assert.equal(castPowerAt(castReleaseMs(power)), power, 'power ' + power);
  }
});

test('castReleaseMs clamps out-of-range and non-finite input', () => {
  assert.equal(castReleaseMs(0), 0);
  assert.equal(castReleaseMs(100), CAST_PEAK_MS);
  assert.equal(castReleaseMs(150), CAST_PEAK_MS);
  assert.equal(castReleaseMs(-5), 0);
  assert.equal(castReleaseMs(NaN), 0);
});

test('jitterPower varies within tolerance and respects protocol bounds', () => {
  const rand = createRng(23);
  const draws = Array.from({ length: 3000 }, () => jitterPower(55, rand));
  const j = TUNING.castPowerJitter;

  assert.ok(Math.min(...draws) >= 55 - j);
  assert.ok(Math.max(...draws) <= 55 + j);
  assert.ok(new Set(draws).size > 1000, 'jitter should not repeat itself');

  // Never outside the 0..100 the protocol allows, even at the extremes.
  for (let i = 0; i < 500; i++) {
    assert.ok(jitterPower(0, rand) >= 0);
    assert.ok(jitterPower(100, rand) <= 100);
  }
});

test('isReleaseUsable rejects a release past a full oscillator period', () => {
  assert.equal(isReleaseUsable(0), true);
  assert.equal(isReleaseUsable(CAST_PEAK_MS), true);
  assert.equal(isReleaseUsable(1199), true);
  assert.equal(isReleaseUsable(1200), false); // wave has wrapped
  assert.equal(isReleaseUsable(-1), false);
  assert.equal(isReleaseUsable(NaN), false);
});

// ---- Hook reaction --------------------------------------------------------

test('hookDelayMs never reacts faster than a person on a normal window', () => {
  const rand = createRng(29);
  const draws = Array.from({ length: 20000 }, () => hookDelayMs(2500, rand));

  assert.ok(Math.min(...draws) >= TUNING.hookDelayFloorMs);
  assert.ok(Math.max(...draws) <= TUNING.hookDelayMaxMs);
  assert.ok(new Set(draws).size > 200, 'reaction times should not cluster');
});

test('hookDelayMs never spends the whole bite window', () => {
  const rand = createRng(31);
  for (const windowMs of [2500, 1200, 900, 600, 400, 250, 120]) {
    for (let i = 0; i < 400; i++) {
      const d = hookDelayMs(windowMs, rand);
      assert.ok(d <= windowMs * TUNING.hookWindowSafety + 1,
        'window ' + windowMs + ' produced ' + d);
    }
  }
});

// A window too short for a human reaction is a fight we lose outright if we
// respect the floor, so the window has to win that conflict.
test('hookDelayMs lets a short window override the plausibility floor', () => {
  const rand = createRng(37);
  const d = hookDelayMs(120, rand);
  assert.ok(d < TUNING.hookDelayFloorMs);
  assert.ok(d <= 120 * TUNING.hookWindowSafety + 1);
});

test('hookDelayMs falls back to the manager default for a missing window', () => {
  const rand = createRng(41);
  // fishing-manager uses `data.windowMs || 2500`, so 0 must behave as absent.
  for (const bad of [undefined, null, 0, NaN, 'abc', -5]) {
    const d = hookDelayMs(bad, rand);
    assert.ok(d >= TUNING.hookDelayFloorMs);
    assert.ok(d <= BITE_WINDOW_DEFAULT_MS * TUNING.hookWindowSafety);
  }
});

// ---- Adaptive cast power --------------------------------------------------

test('nextCastPower clamps to the configured band', () => {
  let up = TUNING.castPowerStart;
  for (let i = 0; i < 100; i++) up = nextCastPower(up, 'caught');
  assert.equal(up, TUNING.castPowerMax);

  let down = TUNING.castPowerStart;
  for (let i = 0; i < 100; i++) down = nextCastPower(down, 'snap');
  assert.equal(down, TUNING.castPowerMin);
});

test('nextCastPower seeds from the default when given no usable value', () => {
  for (const bad of [undefined, null, NaN, 'x']) {
    assert.equal(nextCastPower(bad, 'caught'),
      TUNING.castPowerStart + TUNING.castPowerOnCatch);
  }
  assert.equal(nextCastPower('55', 'caught'), 55 + TUNING.castPowerOnCatch);
});

// The step ratio decides where the policy settles: it holds steady at the land
// rate L where castPowerOnCatch * L = -castPowerOnEscape * (1 - L). At +2/-8
// that is 80%, which is what success metric M2 asks for. A change to either
// constant silently moves the equilibrium, so pin it.
test('cast power settles at an 80% land rate', () => {
  const equilibrium = -TUNING.castPowerOnEscape
    / (TUNING.castPowerOnCatch - TUNING.castPowerOnEscape);
  assert.equal(equilibrium, 0.8);

  let power = TUNING.castPowerStart;
  for (let i = 0; i < 5 * 60; i++) {
    power = nextCastPower(power, (i % 5) < 4 ? 'caught' : 'snap');
  }
  assert.equal(power, TUNING.castPowerStart);
});

test('cast power climbs above and falls below its equilibrium', () => {
  let high = TUNING.castPowerStart;
  for (let i = 0; i < 10 * 60; i++) {
    high = nextCastPower(high, (i % 10) < 9 ? 'caught' : 'snap');
  }
  assert.ok(high > TUNING.castPowerStart, '90% land rate should push power up');

  let low = TUNING.castPowerStart;
  for (let i = 0; i < 5 * 60; i++) {
    low = nextCastPower(low, (i % 5) < 3 ? 'caught' : 'snap');
  }
  assert.ok(low < TUNING.castPowerStart, '60% land rate should back power off');
});

// A timeout means we never fought the fish and an implausible means our own
// reporting was rejected. Neither says the fish was too strong, so neither may
// move cast power - otherwise a hook-timing bug walks power to the floor and
// disguises itself as a difficulty problem.
test('outcomes that say nothing about difficulty leave cast power alone', () => {
  assert.equal(CAST_POWER_SIGNALS.timeout, 0);
  assert.equal(CAST_POWER_SIGNALS.implausible, 0);

  for (const outcome of ['timeout', 'implausible', 'nonsense', undefined]) {
    assert.equal(nextCastPower(60, outcome), 60);
  }
});

// ---- normalizeFightParams -------------------------------------------------

test('normalizeFightParams passes a well-formed payload through untouched', () => {
  const p = normalizeFightParams(SPEC_PARAMS);
  for (const key of Object.keys(SPEC_PARAMS)) {
    assert.equal(p[key], SPEC_PARAMS[key], key);
  }
  assert.deepEqual([...p.degraded], []);
  assert.equal(p.overlapHalfWidth, SPEC_PARAMS.barSize / 2 + OVERLAP_PAD);
  assert.equal(p.staminaMax, SPEC_PARAMS.stamina);
});

test('normalizeFightParams survives a payload that is not an object', () => {
  for (const bad of [null, undefined, 'nope', 42, []]) {
    const p = normalizeFightParams(bad);
    for (const key of Object.keys(PARAM_DEFAULTS)) {
      assert.equal(p[key], PARAM_DEFAULTS[key], key + ' for ' + JSON.stringify(bad));
    }
    assert.deepEqual([...p.degraded], [], 'absent fields are not degradation');
  }
});

// The controller divides by these. A zero here caused a live divide-by-zero in
// the sibling auto-player project, so every one of them is pinned non-zero.
test('normalizeFightParams never yields a zero divisor', () => {
  const hostile = {
    progressRate: 0, drainRate: 0, tensionRise: 0, tensionDecay: 0, stamina: 0,
  };
  const p = normalizeFightParams(hostile);
  for (const key of Object.keys(hostile)) {
    assert.ok(p[key] > 0, key + ' resolved to ' + p[key]);
    assert.ok(p.degraded.includes(key), key + ' should be reported degraded');
  }
  assert.ok(p.staminaMax >= 1);
});

test('normalizeFightParams clamps negatives and caps a hostile fight floor', () => {
  const p = normalizeFightParams({ progressRate: -9, barSize: -20, minFightMs: -1 });
  assert.ok(p.progressRate > 0);
  assert.ok(p.barSize > 0);
  assert.equal(p.minFightMs, 0);

  // An enormous floor would otherwise make the stall wait effectively forever.
  const huge = normalizeFightParams({ minFightMs: 1e9 });
  assert.ok(huge.minFightMs <= 120000);
  assert.ok(huge.degraded.includes('minFightMs'));
});

test('normalizeFightParams falls back on non-finite values', () => {
  const p = normalizeFightParams({
    progressRate: NaN, barSize: Infinity, stamina: -Infinity, drainRate: 'abc',
  });
  assert.equal(p.progressRate, PARAM_DEFAULTS.progressRate);
  assert.equal(p.drainRate, PARAM_DEFAULTS.drainRate);
  assert.ok(Number.isFinite(p.barSize));
  assert.ok(Number.isFinite(p.stamina));
  for (const key of ['progressRate', 'barSize', 'stamina', 'drainRate']) {
    assert.ok(p.degraded.includes(key), key + ' should be reported degraded');
  }
});

test('normalizeFightParams output is frozen', () => {
  const p = normalizeFightParams(SPEC_PARAMS);
  assert.ok(Object.isFrozen(p));
});

// ---- Controller construction ----------------------------------------------

test('every fight draws its own plan', () => {
  const plans = [];
  for (let seed = 1; seed <= 500; seed++) {
    plans.push(createFightController(SPEC_PARAMS, { seed }).plan);
  }
  const key = (p) => [p.lead, p.reactionLagMs, p.tensionCeil, p.targetAccuracy]
    .map((v) => v.toFixed(6)).join('|');
  assert.equal(new Set(plans.map(key)).size, plans.length);

  for (const p of plans) {
    assert.ok(p.lead >= TUNING.leadMinSec && p.lead <= TUNING.leadMaxSec);
    assert.ok(p.reactionLagMs >= TUNING.reactionLagMinMs
      && p.reactionLagMs <= TUNING.reactionLagMaxMs);
    assert.ok(p.tensionCeil >= TUNING.tensionCeilMin
      && p.tensionCeil <= TUNING.tensionCeilMax);
    assert.ok(p.targetAccuracy >= TUNING.targetAccuracyMin
      && p.targetAccuracy <= TUNING.targetAccuracyMax);
  }
});

test('the controller aims inside the band it must report within', () => {
  assert.ok(TUNING.targetAccuracyMin >= TUNING.accuracyMin);
  assert.ok(TUNING.targetAccuracyMax <= TUNING.accuracyMax);
  assert.ok(TUNING.accuracyMax < 1, 'never aim at perfect accuracy');
});

test('the same seed replays identically', () => {
  const a = createFightController(SPEC_PARAMS, { seed: 99 });
  const b = createFightController(SPEC_PARAMS, { seed: 99 });
  const state = (i) => ({
    fishPos: 40 + (i % 30), barPos: 50, barVel: i % 7, fishVel: 1,
    tension: i % 60, progress: 30 + (i % 40), elapsedMs: i * 16.67,
    overlapMs: i * 14, running: i % 11 === 0,
  });
  for (let i = 0; i < 400; i++) {
    assert.equal(a.decide(state(i), 16.67), b.decide(state(i), 16.67), 'step ' + i);
  }
});

test('a drop-off always outlasts the grace window that would hide it', () => {
  // A drop shorter than coyote time costs no accuracy at all, because
  // overlapMs keeps incrementing throughout it.
  assert.ok(TUNING.dropOffMinMs > GRACE_MS);
});

// ---- Controller robustness ------------------------------------------------

test('the controller releases rather than throwing on an unusable snapshot', () => {
  const c = createFightController(SPEC_PARAMS, { seed: 5 });
  for (const bad of [null, undefined, {}, { fishPos: NaN, barPos: 1, barVel: 0, tension: 0, progress: 1 },
    { fishPos: 1, barPos: Infinity, barVel: 0, tension: 0, progress: 1 }]) {
    assert.equal(c.decide(bad, 16.67), false);
  }
  assert.equal(c.getDebug().blindSteps, 5);
});

test('the controller does not react before a human could have', () => {
  const c = createFightController(SPEC_PARAMS, { seed: 13 });
  const lag = c.plan.reactionLagMs;

  // A fish parked far above the bar: the tracking rule would hold instantly,
  // so any hold inside the lag window would be a superhuman reaction.
  let elapsed = 0;
  while (elapsed < lag) {
    const held = c.decide({
      fishPos: 95, barPos: 5, barVel: 0, fishVel: 0,
      tension: 0, progress: 50, elapsedMs: elapsed, overlapMs: 0, running: false,
    }, 16.67);
    assert.equal(held, false, 'reacted at ' + elapsed.toFixed(0) + 'ms of ' + lag.toFixed(0));
    elapsed += 16.67;
  }
  assert.ok(c.getDebug().warmupSteps > 0);
});

test('the lag buffer stays bounded when time never advances', () => {
  const c = createFightController(SPEC_PARAMS, { seed: 17 });
  const snapshot = {
    fishPos: 50, barPos: 50, barVel: 0, fishVel: 0,
    tension: 0, progress: 50, elapsedMs: 0, overlapMs: 0, running: false,
  };
  for (let i = 0; i < 5000; i++) c.decide(snapshot, 0);
  assert.equal(c.getDebug().steps, 5000);
});

test('the tension guard overrides tracking and stays latched', () => {
  const c = createFightController(SPEC_PARAMS, { seed: 21 });
  const ceil = c.plan.tensionCeil;
  const base = {
    fishPos: 95, barPos: 5, barVel: 0, fishVel: 0,
    progress: 50, overlapMs: 5000, running: true,
  };

  // Warm the lag buffer up with a calm, low-tension fight.
  for (let t = 0; t < 600; t += 16.67) {
    c.decide({ ...base, tension: 0, running: false, elapsedMs: t }, 16.67);
  }

  // Fish far above the bar: tracking wants to hold. Over the ceiling and
  // running, the guard must win anyway.
  for (let t = 600; t < 1400; t += 16.67) {
    const held = c.decide({ ...base, tension: ceil + 5, elapsedMs: t }, 16.67);
    if (t > 900) assert.equal(held, false, 'guard should override tracking');
  }
  assert.ok(c.getDebug().guardSteps > 0);

  // Just below the ceiling the latch holds until hysteresis clears it.
  const held = c.decide({ ...base, tension: ceil - 1, elapsedMs: 1500 }, 16.67);
  assert.equal(held, false, 'latch should not release on the first dip');
});

// ---- Loop pacing, persistence, and /autofish ---------------------------------

import {
  AUTOFISH_USAGE,
  cycleDelayMs,
  baitDelayMs,
  normalizeCastPower,
  normalizePowerOverride,
  parseAutofishCommand,
  formatAutofishStatus,
  formatAutofishSummary,
} from '../public/js/fishing-auto-core.mjs';

test('cycle and bait pauses stay in their bands and vary per use', () => {
  const rand = createRng(21);
  const cycles = new Set();
  const baits = new Set();
  for (let i = 0; i < 200; i++) {
    const c = cycleDelayMs(rand);
    const b = baitDelayMs(rand);
    assert.ok(c >= TUNING.cycleDelayMinMs && c <= TUNING.cycleDelayMaxMs, 'cycle ' + c);
    assert.ok(b >= TUNING.baitDelayMinMs && b <= TUNING.baitDelayMaxMs, 'bait ' + b);
    cycles.add(c);
    baits.add(b);
  }
  assert.ok(cycles.size > 50 && baits.size > 50, 'pauses must not repeat');
});

test('normalizeCastPower keeps a restored value inside the policy band', () => {
  assert.equal(normalizeCastPower(undefined), TUNING.castPowerStart);
  assert.equal(normalizeCastPower(NaN), TUNING.castPowerStart);
  assert.equal(normalizeCastPower('70'), 70);
  assert.equal(normalizeCastPower(200), TUNING.castPowerMax);
  assert.equal(normalizeCastPower(1), TUNING.castPowerMin);
  assert.equal(normalizeCastPower(61.4), 61);
});

test('normalizePowerOverride maps absence to null and clamps to the protocol', () => {
  assert.equal(normalizePowerOverride(null), null);
  assert.equal(normalizePowerOverride(''), null);
  assert.equal(normalizePowerOverride(undefined), null);
  assert.equal(normalizePowerOverride(120), 100);
  assert.equal(normalizePowerOverride(-1), 0);
  assert.equal(normalizePowerOverride(42.6), 43);
});

test('parseAutofishCommand accepts the documented forms', () => {
  assert.deepEqual(parseAutofishCommand([]), { action: 'status' });
  assert.deepEqual(parseAutofishCommand(''), { action: 'status' });
  assert.deepEqual(parseAutofishCommand(['on']), { action: 'on' });
  assert.deepEqual(parseAutofishCommand(['OFF']), { action: 'off' });
  assert.deepEqual(parseAutofishCommand(['status']), { action: 'status' });
  assert.deepEqual(parseAutofishCommand(['power', 'auto']), { action: 'power', override: null });
  assert.deepEqual(parseAutofishCommand(['power', '75']), { action: 'power', override: 75 });
  assert.deepEqual(parseAutofishCommand('power 40'), { action: 'power', override: 40 });
  assert.deepEqual(parseAutofishCommand(['power', '150']), { action: 'power', override: 100 });
  assert.deepEqual(parseAutofishCommand(['power', '-5']), { action: 'power', override: 0 });
});

test('parseAutofishCommand rejects bad input with a message rather than NaN', () => {
  assert.equal(parseAutofishCommand(['bogus']).action, 'error');
  assert.equal(parseAutofishCommand(['bogus']).error, AUTOFISH_USAGE);
  assert.equal(parseAutofishCommand(['on', 'now']).action, 'error');
  assert.equal(parseAutofishCommand(['power']).action, 'error');
  assert.equal(parseAutofishCommand(['power', 'lots']).action, 'error');
  assert.match(parseAutofishCommand(['power', 'lots']).error, /number/);
  assert.equal(parseAutofishCommand(['power', '50', 'extra']).action, 'error');
});

test('status lines carry the counters, the power mode, and the last stop', () => {
  const line = formatAutofishStatus({
    enabled: true, phase: 'waiting', landed: 3, lost: 2, lostBy: { snap: 1, timeout: 1, slack: 0 },
    cycles: 5, power: 57, powerOverride: null, haltReason: '',
  });
  assert.match(line, /Auto-Angler: on/);
  assert.match(line, /phase waiting/);
  assert.match(line, /landed 3, lost 2 \(snap 1, timeout 1\)/);
  assert.match(line, /cast power 57 \(adaptive\)/);
  assert.doesNotMatch(line, /last stop/);

  const stopped = formatAutofishStatus({
    enabled: false, phase: 'idle', landed: 0, lost: 0, lostBy: {}, cycles: 0,
    power: 80, powerOverride: 80, haltReason: 'Out of bait.',
  });
  assert.match(stopped, /cast power 80 \(fixed\)/);
  assert.match(stopped, /last stop: Out of bait\./);

  assert.equal(formatAutofishSummary({ landed: 3, lost: 2, power: 57, powerOverride: null }),
    'AUTO 3 landed, 2 lost, power 57');
  assert.equal(formatAutofishSummary({ landed: 0, lost: 0, power: 80, powerOverride: 80 }),
    'AUTO 0 landed, 0 lost, power 80 (fixed)');
});
