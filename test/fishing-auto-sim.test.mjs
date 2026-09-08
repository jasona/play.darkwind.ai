// Drives the Auto-Angler controller against the real fishing-core simulation.
//
// fishing-auto-core.test.mjs tests the pieces in isolation; this file tests
// whether they actually play the game. Everything here is seeded, so a failure
// reproduces exactly.
//
// The numbers these tests assert are measured, not aspirational. Where a bound
// is deliberately loose it says so - the point is to catch a regression that
// moves behaviour by tens of percent, not to freeze a figure that will shift
// slightly whenever a constant is retuned.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFightSim, computeAccuracy, PROGRESS_START } from '../public/js/fishing-core.mjs';
import { createFightController, TUNING } from '../public/js/fishing-auto-core.mjs';

// ~60fps, matching the requestAnimationFrame loop in fishing-manager.
const STEP_MS = 16.67;

// Enough to end any fight that is going to end. A fight still running after
// this is a stall, which the tests treat as a failure in its own right.
const MAX_STEPS = 60000;

// Fight profiles.
//
// Only `spec` is real - it is the example payload in
// docs/gmcp-darkwind-fishing.md. The rest are invented to bracket a range that
// stays unknown until live params are captured (task 7.3), and they should be
// replaced with measured values then.
export const PROFILES = {
  // The documented example. Carries the catch-rate and accuracy assertions.
  spec: {
    strength: 7, erratic: 6, stamina: 110, barSize: 20,
    progressRate: 9, drainRate: 11, tensionRise: 17, tensionDecay: 12,
    minFightMs: 6000,
  },

  // A trivial fish with an unusually wide catch window - barSize 26 gives a
  // 16-unit overlap window on a 100-unit track. That width is why this fixture
  // matters: it is what exposed the stall's need to steer away from the fish
  // rather than merely release, since a released bar never leaves a window
  // that wide.
  easy: {
    strength: 3, erratic: 2, stamina: 70, barSize: 26,
    progressRate: 12, drainRate: 8, tensionRise: 9, tensionDecay: 14,
    minFightMs: 6000,
  },

  // Hard but winnable: measured around 68% landed. Difficulty comes from
  // tension and a demanding break-even, not from speed - strength and erratic
  // stay at spec levels deliberately, because raising those collapses tracking
  // accuracy below break-even and makes a fight unwinnable rather than hard.
  // Carries the snap-rate assertion.
  tough: {
    strength: 7, erratic: 6, stamina: 130, barSize: 18,
    progressRate: 8, drainRate: 12, tensionRise: 22, tensionDecay: 11,
    minFightMs: 6000,
  },

  // OUT OF BOUNDS. These two are unwinnable by anyone, not merely by us:
  // with every handicap stripped - zero reaction lag, no tension guard, no
  // deadband - they still land 1.3% and 0.0% of fights respectively.
  //
  // They are kept as stress cases to prove the controller degrades safely on a
  // fight it cannot win, and they must NOT carry catch-rate assertions.
  // Replace them once real params are captured (task 7.3).
  hard: {
    strength: 11, erratic: 10, stamina: 160, barSize: 14,
    progressRate: 7, drainRate: 14, tensionRise: 24, tensionDecay: 9,
    minFightMs: 6000,
  },
  brutal: {
    strength: 14, erratic: 13, stamina: 200, barSize: 11,
    progressRate: 6, drainRate: 16, tensionRise: 30, tensionDecay: 7,
    minFightMs: 6000,
  },
};

const WINNABLE = ['spec', 'easy', 'tough'];
const UNWINNABLE = ['hard', 'brutal'];

// Run one fight, controller against simulation, exactly as fishing-manager
// wires them together.
export function runFight(params, seed, tuning) {
  const sim = createFightSim(params, seed);
  const controller = createFightController(params, { seed, tuning });

  let outcome = null;
  let steps = 0;
  while (!outcome && steps < MAX_STEPS) {
    outcome = sim.step(STEP_MS, controller.decide(sim.getState(), STEP_MS));
    steps += 1;
  }

  const state = sim.getState();
  return {
    outcome: outcome || 'stalled',
    fightMs: state.elapsedMs,
    accuracy: computeAccuracy(state),
    tensionPeak: state.tensionPeak,
    debug: controller.getDebug(),
  };
}

export function runMany(params, runs, tuning, firstSeed = 1) {
  const results = [];
  for (let i = 0; i < runs; i++) results.push(runFight(params, firstSeed + i, tuning));

  const rate = (predicate) => results.filter(predicate).length / results.length;
  const mean = (pick) => results.reduce((a, r) => a + pick(r), 0) / results.length;

  return {
    results,
    caught: rate((r) => r.outcome === 'caught'),
    snap: rate((r) => r.outcome === 'snap'),
    slack: rate((r) => r.outcome === 'slack'),
    stalled: rate((r) => r.outcome === 'stalled'),
    underFloor: rate((r) => r.fightMs < params.minFightMs),
    meanAccuracy: mean((r) => r.accuracy),
    meanFlips: mean((r) => r.debug.flipsPerSec),
  };
}

// The overlap fraction below which progress goes backwards no matter how the
// fight is played: progressRate * f = drainRate * (1 - f).
export function breakEvenOverlap(params) {
  return params.drainRate / (params.progressRate + params.drainRate);
}

// ---- Fixture characterisation ---------------------------------------------
// These pin what each fixture *is*, so a later edit to the numbers cannot
// quietly turn the winnable set unwinnable and take the real assertions with
// it.

test('the winnable fixtures ask for an overlap the controller can reach', () => {
  for (const name of WINNABLE) {
    const needed = breakEvenOverlap(PROFILES[name]);
    assert.ok(needed < TUNING.targetAccuracyMin,
      name + ' needs ' + (needed * 100).toFixed(1) + '% overlap, above the '
      + (TUNING.targetAccuracyMin * 100).toFixed(0) + '% we aim to report');
  }
});

test('the out-of-bounds fixtures are documented as beyond reach', () => {
  for (const name of UNWINNABLE) {
    const needed = breakEvenOverlap(PROFILES[name]);
    assert.ok(needed > 0.6,
      name + ' is only a stress case if it demands a punishing overlap');
  }
});

test('the fastest possible fight is bounded by progressRate alone', () => {
  // Progress starts at PROGRESS_START and rises at progressRate with perfect
  // overlap, so no fight can be shorter than this - which also means a server
  // minFightMs above it would be unsatisfiable by any player.
  for (const [name, params] of Object.entries(PROFILES)) {
    const floorMs = ((100 - PROGRESS_START) / params.progressRate) * 1000;
    assert.ok(Number.isFinite(floorMs) && floorMs > 0, name);
  }
});

// ---- Termination -----------------------------------------------------------

test('every fixture terminates without throwing', () => {
  for (const [name, params] of Object.entries(PROFILES)) {
    const summary = runMany(params, 60);
    assert.equal(summary.stalled, 0, name + ' left fights unresolved');
  }
});

// ---- Catch rate ------------------------------------------------------------

// Floors sit well under what is measured today. They are here to catch a
// regression that moves behaviour by tens of percent, not to freeze a number
// that shifts whenever a constant is retuned.
const CATCH_FLOOR = {
  spec: 0.90,   // measured 0.97
  easy: 0.95,   // measured 1.00
  tough: 0.50,  // measured 0.66
};

test('the controller lands fish on every winnable fixture', () => {
  for (const name of WINNABLE) {
    const summary = runMany(PROFILES[name], 500);
    assert.ok(summary.caught >= CATCH_FLOOR[name],
      name + ' landed ' + (summary.caught * 100).toFixed(1) + '%, floor is '
      + (CATCH_FLOOR[name] * 100).toFixed(0) + '%');
  }
});

// PRD metric M2. Only the fixtures representing fish a player would actually
// be targeting carry it - `tough` is deliberately at the edge of what the
// adaptive cast power would keep choosing, and would back off from in practice.
test('land rate clears the 80% target on ordinary fish (M2)', () => {
  for (const name of ['spec', 'easy']) {
    const summary = runMany(PROFILES[name], 500);
    assert.ok(summary.caught >= 0.8,
      name + ' landed only ' + (summary.caught * 100).toFixed(1) + '%');
  }
});

// A good average over one seed range can hide a controller that fails on a
// whole class of fights. Disjoint ranges must agree.
test('catch rate is stable across disjoint seed ranges', () => {
  for (const name of WINNABLE) {
    const a = runMany(PROFILES[name], 250, undefined, 1);
    const b = runMany(PROFILES[name], 250, undefined, 5001);
    assert.ok(Math.abs(a.caught - b.caught) < 0.12,
      name + ' split ' + (a.caught * 100).toFixed(1) + '% vs '
      + (b.caught * 100).toFixed(1) + '%');
  }
});

// ---- Reported accuracy (M3) -----------------------------------------------

// The band's *ceiling* is the plausibility requirement: a server rejects
// results that are implausibly good, and near-perfect accuracy is the clearest
// such signal we could send. These are the assertions that matter.

test('no fight ever reports near-perfect accuracy', () => {
  for (const [name, params] of Object.entries(PROFILES)) {
    const { results } = runMany(params, 800);
    const perfect = results.filter((r) => r.accuracy >= 0.99);
    assert.equal(perfect.length, 0,
      name + ' reported >= 0.99 accuracy on ' + perfect.length + ' fights');
  }
});

test('accuracy above the band ceiling stays rare', () => {
  for (const [name, params] of Object.entries(PROFILES)) {
    const { results } = runMany(params, 800);
    const over = results.filter((r) => r.accuracy > TUNING.accuracyMax).length;
    assert.ok(over / results.length <= 0.05,
      name + ' exceeded the ceiling on ' + (100 * over / results.length).toFixed(1) + '% of fights');
  }
});

test('mean accuracy sits inside the band on ordinary fish', () => {
  for (const name of ['spec', 'easy']) {
    const summary = runMany(PROFILES[name], 500);
    assert.ok(summary.meanAccuracy >= TUNING.accuracyMin
      && summary.meanAccuracy <= TUNING.accuracyMax,
      name + ' mean accuracy ' + summary.meanAccuracy.toFixed(3) + ' is outside the band');
  }
});

test('most landed fish report an in-band accuracy', () => {
  for (const name of ['spec', 'easy']) {
    const { results } = runMany(PROFILES[name], 500);
    const caught = results.filter((r) => r.outcome === 'caught');
    const inBand = caught.filter((r) => r.accuracy >= TUNING.accuracyMin
      && r.accuracy <= TUNING.accuracyMax);
    assert.ok(inBand.length / caught.length >= 0.6,
      name + ' only ' + (100 * inBand.length / caught.length).toFixed(1) + '% of catches in band');
  }
});

// A hard fish does not permit the overlap the band asks for, so its catches
// legitimately report below it. Recorded rather than asserted against, because
// the fix would be to play *worse* on easy fish for no plausibility gain - a
// server has no reason to reject a result for being unimpressive.
test('accuracy on a hard fish falls below the band, as expected', () => {
  const summary = runMany(PROFILES.tough, 500);
  assert.ok(summary.meanAccuracy < TUNING.accuracyMin);
  assert.ok(summary.meanAccuracy > 0.6,
    'a collapse well below this would mean the controller had stopped tracking');
});

// ---- Fight duration floor (M4) ---------------------------------------------

// createFightSim never reads params.minFightMs: the server states a floor and
// the simulation ignores it, so a fight can finish under the server's own
// stated minimum unless the controller stalls. Nothing else enforces this.

test('no landed fish is ever reported faster than the fight floor (M4)', () => {
  for (const [name, params] of Object.entries(PROFILES)) {
    const { results } = runMany(params, 500);
    const early = results.filter((r) => r.outcome === 'caught'
      && r.fightMs < params.minFightMs);
    assert.equal(early.length, 0,
      name + ' landed ' + early.length + ' fish under the ' + params.minFightMs + 'ms floor');
  }
});

// An escape legitimately ends early - a snapped line is not a fast catch, and
// reporting the true duration of a fight we lost is correct. The floor exists
// to stop us claiming an implausibly quick *catch*, which is why the assertion
// above is scoped to caught fights and this one records the difference.
test('escapes may run shorter than the floor', () => {
  const { results } = runMany(PROFILES.brutal, 200);
  const short = results.filter((r) => r.fightMs < PROFILES.brutal.minFightMs);
  assert.ok(short.length > 0, 'expected brutal to lose fights quickly');
  assert.ok(short.every((r) => r.outcome !== 'caught'));
});

// Proves the stall is doing the work, rather than fights merely happening to
// run long enough on their own.
test('raising the fight floor visibly lengthens fights', () => {
  const noFloor = runMany({ ...PROFILES.easy, minFightMs: 0 }, 200);
  const withFloor = runMany({ ...PROFILES.easy, minFightMs: 10000 }, 200);

  const mean = (s) => s.results.reduce((a, r) => a + r.fightMs, 0) / s.results.length;
  assert.ok(mean(withFloor) > mean(noFloor) * 1.15,
    'floor raised mean duration only from ' + (mean(noFloor) / 1000).toFixed(1)
    + 's to ' + (mean(withFloor) / 1000).toFixed(1) + 's');
});

// The stall cannot stretch a fight indefinitely, and past a point it starts
// costing accuracy badly (long non-overlap stretches). Both metrics hold
// comfortably at the 6000ms the protocol documents; this records where that
// stops being true, because it decides how much PRD 9.2 Q3 - whether
// minFightMs varies by species - actually matters.
test('the fight floor is satisfiable at the documented 6000ms but not far above', () => {
  const at6000 = runMany({ ...PROFILES.easy, minFightMs: 6000 }, 300);
  assert.equal(at6000.underFloor, 0);

  const at15000 = runMany({ ...PROFILES.easy, minFightMs: 15000 }, 300);
  assert.ok(at15000.underFloor > 0.1,
    'if a 15s floor became satisfiable, this limitation is worth re-measuring');
});

// ---- Tension guard (M5) ----------------------------------------------------

// Disables the guard by putting both ceilings out of reach, so its effect can
// be measured rather than assumed.
const GUARD_OFF = { tensionCeilMin: 999, tensionCeilMax: 999, tensionHardCeil: 999 };

test('snap rate stays under 10% on winnable fish (M5)', () => {
  for (const name of WINNABLE) {
    const summary = runMany(PROFILES[name], 500);
    assert.ok(summary.snap <= 0.10,
      name + ' snapped ' + (summary.snap * 100).toFixed(1) + '% of fights');
  }
});

// Without the guard, a tension-threatening fish fails M5 outright. This is the
// test that would catch the guard being disabled, mis-ordered, or having its
// ceiling raised past usefulness.
test('the guard is what keeps the snap rate down', () => {
  const guarded = runMany(PROFILES.tough, 500);
  const unguarded = runMany(PROFILES.tough, 500, GUARD_OFF);

  assert.ok(unguarded.snap > 0.10,
    'tough should fail M5 without the guard, snapped only '
    + (unguarded.snap * 100).toFixed(1) + '%');
  assert.ok(guarded.snap < unguarded.snap / 5,
    'guard reduced snaps only from ' + (unguarded.snap * 100).toFixed(1)
    + '% to ' + (guarded.snap * 100).toFixed(1) + '%');
});

// Backing off costs fish - snap avoidance outranks catch progress (PRD 4.27),
// so some fights that would have been won on a knife edge are lost to slack
// instead. The trade is deliberate but it should stay a trade, not a collapse.
test('the guard costs catch rate without gutting it', () => {
  const guarded = runMany(PROFILES.tough, 500);
  const unguarded = runMany(PROFILES.tough, 500, GUARD_OFF);
  assert.ok(guarded.caught > unguarded.caught - 0.15,
    'guard cost ' + ((unguarded.caught - guarded.caught) * 100).toFixed(1)
    + 'pp of catch rate, more than expected');
});

// On a fight that cannot be won either way, the guard should still convert
// snapped lines into slack losses.
test('the guard turns snaps into slack losses on unwinnable fish', () => {
  for (const name of UNWINNABLE) {
    const guarded = runMany(PROFILES[name], 200);
    const unguarded = runMany(PROFILES[name], 200, GUARD_OFF);
    assert.ok(guarded.snap < unguarded.snap * 0.75,
      name + ' snapped ' + (guarded.snap * 100).toFixed(1)
      + '% guarded vs ' + (unguarded.snap * 100).toFixed(1) + '% unguarded');
    assert.ok(guarded.slack > unguarded.slack, name + ' should lose slowly instead');
  }
});

// The guard must not be a blanket handicap: on a fish whose tension never
// approaches the ceiling it should never fire, and cost nothing.
test('the guard does not interfere when tension never builds', () => {
  const guarded = runMany(PROFILES.easy, 300);
  const unguarded = runMany(PROFILES.easy, 300, GUARD_OFF);
  assert.equal(guarded.caught, unguarded.caught);
  assert.equal(guarded.snap, 0);
});

// The out-of-bounds fixtures cannot be won, so the only thing worth asserting
// is that the controller fails safely rather than flailing: it must still
// resolve every fight, and it must not be reporting perfect accuracy while
// losing.
test('unwinnable fixtures degrade safely rather than flailing', () => {
  for (const name of UNWINNABLE) {
    const summary = runMany(PROFILES[name], 200);
    assert.equal(summary.stalled, 0, name + ' failed to resolve');
    assert.ok(summary.caught + summary.snap + summary.slack === 1, name);
    assert.ok(summary.meanAccuracy < TUNING.accuracyMax,
      name + ' reported ' + summary.meanAccuracy.toFixed(3)
      + ' accuracy on fights it lost');
  }
});
