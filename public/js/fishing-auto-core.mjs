// fishing-auto-core.mjs - pure, DOM-free control logic for the Auto-Angler.
//
// This module decides *how to play* the fishing mini-game; it never touches the
// DOM, the socket, or any timer. Everything here is deterministic given its
// inputs (a seeded RNG plus a simulation snapshot), which is what makes the
// controller testable against the real fishing-core.mjs simulation.
//
// The design problem is not playing well - everything needed to play perfectly
// is already in client memory. The problem is playing *believably*: the server
// validates the outcome, fightMs, accuracy, and tensionPeak we report back, and
// Darkwind.Fishing.Escaped carries a documented reason "implausible". So most
// of the tuning below exists to be deliberately imperfect in a human-shaped way.
//
// See docs/gmcp-darkwind-fishing.md for the protocol and fishing-core.mjs for
// the simulation this controller drives.

import { mulberry32, castPowerAt } from './fishing-core.mjs';

// ---- Simulation constants -------------------------------------------------
// Mirrored from fishing-core.mjs. They are duplicated as named constants
// rather than imported because fishing-core does not export them, and PRD
// section 4.22 forbids modifying that file to add exports.

// The bar counts as on the fish within barSize/2 + OVERLAP_PAD.
export const OVERLAP_PAD = 3;

// Coyote time. When the bar leaves the fish, progress keeps accruing for this
// long - and so does overlapMs, the numerator of the accuracy we report. That
// makes any drop-off shorter than this completely invisible in our reported
// accuracy, which is why the shaper deliberately drops off for longer.
export const GRACE_MS = 300;

// Defaults createFightSim applies to a missing params field. Kept in sync so
// normalizeFightParams produces exactly what the simulation would have used.
export const PARAM_DEFAULTS = Object.freeze({
  strength: 5,
  erratic: 5,
  barSize: 20,
  progressRate: 9,
  drainRate: 11,
  tensionRise: 14,
  tensionDecay: 10,
  stamina: 100,
  // The simulation ignores minFightMs entirely - the server sends it but
  // createFightSim never reads it. We enforce it ourselves, so when the server
  // does not state a floor there is nothing to enforce and 0 is correct. We do
  // not invent a constraint the server did not ask for.
  minFightMs: 0,
});

// ---- Tuning ---------------------------------------------------------------
// Every value here is a plausibility control, not a performance control.
// Raising them makes the Auto-Angler play better and look more automated.

export const TUNING = Object.freeze({
  // The band reported accuracy must land inside (PRD 4.28). Never at or near
  // 1.0. This is the requirement, checked by tests - not what we aim at.
  accuracyMin: 0.82,
  accuracyMax: 0.94,

  // What each fight actually aims at, drawn per fight. Deliberately inset from
  // the band above: aiming at its edges puts half the natural spread outside
  // it. The inset costs nothing and buys roughly six points of compliance.
  // Do not narrow this much further - every fight reporting the same accuracy
  // is its own kind of tell.
  targetAccuracyMin: 0.85,
  targetAccuracyMax: 0.91,

  // Deliberate drop-off length, in ms. Coyote grace swallows the first
  // GRACE_MS of every drop, so a drop only reduces accuracy by
  // (duration - GRACE_MS). A 340ms drop buys 40ms and is close to useless;
  // these are sized so a handful of drops can move accuracy a few points.
  dropOffMinMs: 500,
  dropOffMaxMs: 1100,

  // How far above target accuracy has to drift before a drop-off is triggered.
  accuracyTolerance: 0.02,

  // Jitter applied to each computed drop length. Sizing a drop to the accuracy
  // it needs to remove makes its duration a deterministic function of fight
  // state, which PRD 4.32 rules out - every realism timing must vary per use.
  // Small enough not to disturb the sizing, large enough that no two drops
  // share a duration.
  dropJitterMin: 0.9,
  dropJitterMax: 1.1,

  // Accuracy is meaningless over the first fraction of a second, when
  // overlapMs and elapsedMs are both tiny and their ratio swings wildly.
  shaperWarmupMs: 1500,

  // A drop does not stop costing accuracy when it ends. The bar has fallen
  // away and has to climb back, and that re-acquisition is non-overlap time
  // too. Drops are shortened by this much so the total excursion - drop plus
  // recovery - lands on target instead of sailing past it.
  reacquireAllowanceMs: 200,

  // minFightMs stall (PRD 4.30). The stall band is computed per fight rather
  // than fixed, because how far progress overshoots after we decide to stall
  // depends on the fish's progressRate - see stallCeiling in the controller.
  //
  // Extra headroom below the computed overshoot, in progress points.
  stallMargin: 4,
  // How far progress is allowed to fall before we start reeling again. Wide
  // enough that we are not re-deciding every frame, far enough from 0 that a
  // stall can never turn a won fight into a slack loss.
  stallBandWidth: 10,

  // Decision lag: we act on a simulation sample this far in the past, so bar
  // tracking is never superhuman (PRD 4.25).
  reactionLagMinMs: 120,
  reactionLagMaxMs: 250,

  // Velocity look-ahead, in seconds. The bar accelerates against drag rather
  // than teleporting, so steering on current position always overshoots.
  leadMinSec: 0.12,
  leadMaxSec: 0.18,

  // Tracking deadband, in track units, to stop hold/release chatter.
  deadband: 2.5,

  // How much of the fish's own velocity to anticipate, as a multiple of `lead`.
  // 0 aims at where the fish is; 1 aims at where it is going.
  fishLead: 1,

  // Tension ceiling while the fish is running, randomised per fight so
  // tensionPeak varies across fights instead of converging (PRD 4.31).
  tensionCeilMin: 55,
  tensionCeilMax: 70,

  // Above this we release regardless of tracking error. Snap avoidance always
  // wins a disagreement with the tracking rule (PRD 4.27).
  tensionHardCeil: 80,

  // Once the guard fires it stays latched until tension falls this far below
  // the ceiling. Without hysteresis the guard chatters on and off around the
  // threshold, which both looks robotic and never lets tension actually decay.
  tensionHysteresis: 10,

  // Whether the soft ceiling only applies while the fish is running. Holding
  // through a run costs 2.0x tensionRise against 0.6x released, so a run is
  // where the danger is - but tension also creeps up at 0.25x whenever we hold
  // on an overlapping fish, and only decays when we let go.
  guardRequiresRun: true,

  // Hook reaction (PRD 4.18-4.20). A sub-150ms reaction is not humanly
  // possible and is the single most obvious automation tell.
  hookDelayMinMs: 180,
  hookDelayMaxMs: 550,
  hookDelayCentreMs: 280,
  hookDelayFloorMs: 150,
  hookWindowSafety: 0.6,

  // Adaptive cast power (PRD 4.33-4.36).
  castPowerStart: 55,
  // +2/-8 settles the policy at an 80% land rate (2L = 8(1-L) => L = 0.8),
  // which is what success metric M2 asks for. The PRD's original +5 would have
  // driven power up until we were losing 38% of fights - the point where a
  // +5/-8 pair balances - quietly contradicting its own target.
  castPowerOnCatch: 2,
  castPowerOnEscape: -8,
  castPowerMin: 25,
  castPowerMax: 95,
  castPowerJitter: 2,

  // Loop pacing (PRD 4.12). A new cycle starts this long after the server's
  // verdict, and "fish" follows "bait hook" after a shorter pause so the two
  // commands never leave on the same tick.
  cycleDelayMinMs: 1200,
  cycleDelayMaxMs: 2600,
  baitDelayMinMs: 350,
  baitDelayMaxMs: 900,
});

// ---- RNG helpers ----------------------------------------------------------
// Seeded so every test can reproduce an exact run. mulberry32 is the same
// generator the simulation itself uses.

export function createRng(seed) {
  return mulberry32(Number.isFinite(seed) ? seed : 1);
}

// Uniform draw in [lo, hi].
export function randRange(rand, lo, hi) {
  return lo + rand() * (hi - lo);
}

// Integer draw in [lo, hi], inclusive.
export function randInt(rand, lo, hi) {
  return Math.floor(lo + rand() * (hi - lo + 1));
}

// Triangular draw on [lo, hi] with its peak at `mode`. Used for reaction times,
// which cluster around a mode and trail off rather than spreading evenly.
//
// Sampled by inverting the CDF, which matters: the obvious alternative - draw
// uniformly, shift toward the mode, clamp to range - piles roughly a tenth of
// all draws onto the boundary value exactly. A spike of identical reaction
// times is precisely the kind of artifact this module exists to avoid.
export function randTriangular(rand, lo, hi, mode) {
  if (!(hi > lo)) return lo;
  const m = clamp(mode, lo, hi);
  const u = rand();
  const split = (m - lo) / (hi - lo);
  if (u < split) return lo + Math.sqrt(u * (hi - lo) * (m - lo));
  return hi - Math.sqrt((1 - u) * (hi - lo) * (hi - m));
}

export function clamp(value, lo, hi) {
  if (!Number.isFinite(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

// ---- Cast timing ----------------------------------------------------------
// castPowerAt is a 1200ms triangle wave: power = round(200 * t) on the rising
// half, where t = (tMs % 1200) / 1200. Inverting for the rising edge gives
// tMs = power * 6, so any power in 0..100 is reachable in the first 600ms.
//
// We time the *release* rather than sending a chosen number, because the cast
// then goes out through the same path a human click uses and the reported power
// is whatever the oscillator genuinely reads (PRD 4.15, 4.17).

// Half the oscillator period: the last instant on the rising edge, where power
// reads 100. Releasing later walks back down the falling edge.
export const CAST_PEAK_MS = 600;

// Milliseconds after cast start at which to release to hit `power`.
export function castReleaseMs(power) {
  return clamp(power, 0, 100) * 6;
}

// Apply +/- TUNING.castPowerJitter so repeated casts never report an identical
// value (PRD 4.16). Clamped to the protocol's 0..100, not to the adaptive
// policy's 25..95 - jitter is allowed to nudge a target slightly outside the
// band the policy settled on.
export function jitterPower(power, rand) {
  const j = TUNING.castPowerJitter;
  return clamp(clamp(power, 0, 100) + randRange(rand, -j, j), 0, 100);
}

// A scheduled release can fire late. Up to CAST_PEAK_MS the power we get is
// simply lower than intended, which is harmless and human. Past a full period
// the wave wraps and the reading is meaningless, so the caller should abandon
// the cast rather than send a wildly wrong power.
export function isReleaseUsable(elapsedMs) {
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < 1200;
}

// ---- Adaptive cast power --------------------------------------------------
// Cast power decides which fish will bite: more power reaches rarer fish, but
// they fight harder. So the policy walks power up while we are landing what we
// hook, and backs it off when we are not, settling near what the character's
// current Fishing skill can actually handle (PRD 4.33-4.36).

// How each final outcome moves the target power.
//
// Only `caught`, `snap`, and `slack` say anything about whether the fish was
// too strong for us. `timeout` means we missed the bite - the fish was never
// fought, so its difficulty is unknown. `implausible` means the server rejected
// our reported numbers, which is a defect in our own reporting and says nothing
// about the fish at all.
//
// DEVIATION from PRD 4.35, which says any escape lowers power by 8. Applying
// that to `timeout` and `implausible` would walk power down to its floor for
// reasons unrelated to power, and would then mask the real fault by making the
// symptom look like a difficulty problem. Both are recorded as no-change here.
// Revert by giving them TUNING.castPowerOnEscape if the literal rule is wanted.
export const CAST_POWER_SIGNALS = Object.freeze({
  caught: TUNING.castPowerOnCatch,
  snap: TUNING.castPowerOnEscape,
  slack: TUNING.castPowerOnEscape,
  timeout: 0,
  implausible: 0,
});

// Next target cast power given the outcome the *server* confirmed. Always feed
// this the server's verdict (Caught / Escaped.reason), never the outcome we
// reported from the local simulation - the server can and does disagree.
export function nextCastPower(current, outcome) {
  const parsed = toFiniteOrNull(current);
  const base = parsed === null ? TUNING.castPowerStart : parsed;
  const delta = CAST_POWER_SIGNALS[outcome] ?? 0;
  return clamp(base + delta, TUNING.castPowerMin, TUNING.castPowerMax);
}

// ---- Hook reaction --------------------------------------------------------

// The bite window default fishing-manager applies when the server omits one
// (`data.windowMs || 2500`). Mirrored so our timing matches the live client's.
export const BITE_WINDOW_DEFAULT_MS = 2500;

// How long to wait after a bite before hooking (PRD 4.18-4.20).
//
// Two constraints pull against each other. The plausibility floor says never
// react faster than a person can (a same-frame hook is the most obvious tell
// there is). The window says never react so slowly the fish is lost. When they
// genuinely conflict - a window too short to allow a human-speed reaction - the
// window wins, because missing the bite loses the fish outright while a fast
// hook merely looks fast.
//
// The safety factor applies to *every* draw, not just oversized ones. Our delay
// is measured from when the Bite arrived here, but the server's window opened
// when it was sent, and the Hook still has to travel back. Latency eats both
// ends, so spending the full window is never safe.
export function hookDelayMs(windowMs, rand) {
  const parsed = toFiniteOrNull(windowMs);
  const win = (parsed !== null && parsed > 0) ? parsed : BITE_WINDOW_DEFAULT_MS;
  const cap = win * TUNING.hookWindowSafety;

  const draw = randTriangular(
    rand,
    TUNING.hookDelayMinMs,
    TUNING.hookDelayMaxMs,
    TUNING.hookDelayCentreMs,
  );

  // The floor cannot be honoured when the cap is below it; in that case the cap
  // is the answer. Written as an explicit max so the floor keeps binding if the
  // draw range is ever retuned lower than it.
  const capped = Math.min(draw, cap);
  return Math.round(Math.max(capped, Math.min(TUNING.hookDelayFloorMs, cap)));
}

// ---- Server payload validation --------------------------------------------
// Darkwind.Fishing.Fight params arrive over the network and are untrusted
// (PRD 4.41, 7.6). A single unguarded field caused a live divide-by-zero in the
// sibling auto-player project, so nothing here is taken on faith.

// Safe bounds for each field. `lo` on a field the controller divides by is
// deliberately non-zero. The upper bounds exist so a malformed or hostile
// payload cannot make the controller stall forever or project nonsense.
const PARAM_BOUNDS = Object.freeze({
  strength:     { lo: 0,   hi: 40 },
  erratic:      { lo: 0,   hi: 40 },
  barSize:      { lo: 4,   hi: 60 },
  progressRate: { lo: 0.1, hi: 100 },     // divisor: time-to-complete
  drainRate:    { lo: 0.1, hi: 100 },     // divisor: drop-off cost
  tensionRise:  { lo: 0.1, hi: 100 },     // divisor: time-to-danger
  tensionDecay: { lo: 0.1, hi: 100 },     // divisor: time-to-safe
  stamina:      { lo: 1,   hi: 100000 },  // divisor: sim's tired factor
  minFightMs:   { lo: 0,   hi: 120000 },  // capped: a huge value would stall us forever
});

// Coerce anything to a finite number, or return null if it cannot be. Accepts
// numeric strings because JSON from a MUD is not always well-typed; rejects
// booleans, empty strings, and whitespace, which Number() would silently
// turn into 0.
export function toFiniteOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Normalize a server params payload into values the controller can safely do
// arithmetic with.
//
// IMPORTANT: this is the controller's *model* of the fight, not the fight
// itself. fishing-manager constructs the real simulation from the raw payload,
// so if the server sends something the simulation handles differently from the
// clamps above, our projections drift. `degraded` reports exactly that: any
// field that was missing, unusable, or out of bounds. The manager can use it to
// hand control back rather than play a fight it cannot model.
export function normalizeFightParams(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  const degraded = [];

  for (const key of Object.keys(PARAM_DEFAULTS)) {
    const bounds = PARAM_BOUNDS[key];
    const parsed = toFiniteOrNull(src[key]);

    if (parsed === null) {
      // Missing or unusable. The simulation falls back to its own default via
      // `??`, so we match that rather than inventing a value.
      out[key] = PARAM_DEFAULTS[key];
      if (src[key] !== undefined) degraded.push(key);
      continue;
    }

    const bounded = clamp(parsed, bounds.lo, bounds.hi);
    if (bounded !== parsed) degraded.push(key);
    out[key] = bounded;
  }

  // The simulation computes staminaMax as Math.max(1, params.stamina ?? 100);
  // mirror that exactly so our tired-factor model matches the live fight.
  out.staminaMax = Math.max(1, out.stamina);

  // Half-width of the catch window, precomputed because the controller needs it
  // on every frame. Mirrors `barSize / 2 + 3` in the simulation's overlap test.
  out.overlapHalfWidth = out.barSize / 2 + OVERLAP_PAD;

  out.degraded = Object.freeze(degraded);
  return Object.freeze(out);
}

// ---- Fight controller -----------------------------------------------------
// Decides hold-or-release on every simulation step. The controller never
// touches the simulation - fishing-manager owns that - it only answers the
// `held` question that createFightSim's step() takes.

// A simulation snapshot we cannot reason about. Releasing is the safe answer:
// it bleeds tension rather than building it, so a controller flying blind
// loses the fish slowly instead of snapping the line immediately.
const BLIND_DEFAULT_HELD = false;

function isUsableState(s) {
  return !!s
    && Number.isFinite(s.fishPos)
    && Number.isFinite(s.barPos)
    && Number.isFinite(s.barVel)
    && Number.isFinite(s.tension)
    && Number.isFinite(s.progress);
}

// Build a controller for one fight.
//
// `opts.seed` makes a run reproducible - tests depend on this. Pass the same
// seed the server sent for the fight and the controller's choices replay
// exactly alongside the simulation's.
//
// Each fight draws its own lead, reaction lag, tension ceiling, and accuracy
// target, so no two fights are played identically even against identical
// params (PRD 4.31, 4.32).
export function createFightController(rawParams, opts = {}) {
  const params = normalizeFightParams(rawParams);
  const rand = createRng(opts.seed);

  // Per-controller tuning overrides. Tests and the 6.5 tuning pass use this;
  // production passes nothing and gets TUNING as written.
  const T = opts.tuning ? { ...TUNING, ...opts.tuning } : TUNING;

  const plan = Object.freeze({
    // Velocity look-ahead, seconds.
    lead: randRange(rand, T.leadMinSec, T.leadMaxSec),
    // How stale the snapshot we act on is, milliseconds.
    reactionLagMs: randRange(rand, T.reactionLagMinMs, T.reactionLagMaxMs),
    // Release above this while the fish runs.
    tensionCeil: randRange(rand, T.tensionCeilMin, T.tensionCeilMax),
    // Accuracy this fight aims to report - inset from the required band.
    targetAccuracy: randRange(rand, T.targetAccuracyMin, T.targetAccuracyMax),
  });

  const st = {
    elapsedMs: 0,
    held: false,
    steps: 0,
    flips: 0,       // hold/release reversals - a proxy for how twitchy we look
    blindSteps: 0,  // steps taken against an unusable snapshot
    warmupSteps: 0, // steps before the lag buffer reached back a full reaction
    lastLagMs: 0,   // staleness of the sample actually used, for diagnostics
    guardSteps: 0,  // steps where the tension guard overrode the tracking rule
    shaperSteps: 0, // steps spent inside a deliberate drop-off
    dropOffs: 0,    // deliberate drop-offs started
    stallSteps: 0,  // steps spent holding progress back below the fight floor
  };

  // Reaction-lag buffer: { t, s } snapshots, oldest first. We decide against a
  // sample from plan.reactionLagMs ago rather than the current frame, so bar
  // tracking is never superhuman (PRD 4.25). Snapshots are the objects
  // sim.getState() already returns, which are fresh copies, so nothing aliases.
  const lagBuffer = [];

  // Hard ceiling on retained snapshots. Nothing should approach this - 250ms of
  // lag is ~15 frames at 60fps - but a caller passing dtMs of 0 would otherwise
  // grow the buffer without bound, since elapsed time would never advance.
  const LAG_BUFFER_MAX = 240;

  // Tracking rule (PRD 4.23, 4.24).
  //
  // The bar does not teleport - it accelerates against drag, capping near +87
  // up and -79 down - so steering on current position always overshoots and
  // then oscillates. We compare the fish against where the bar is *heading*,
  // and aim at where the fish is heading too.
  //
  // The projection deliberately looks ahead by `lead` only, not by the full
  // reaction lag. Projecting the whole lag away would cancel the handicap that
  // 1.7 exists to impose; a person anticipates, but does not anticipate
  // perfectly. The residual lag is what keeps the tracking human.
  function trackingHold(s) {
    const projectedBar = s.barPos + s.barVel * plan.lead;
    const fishVel = Number.isFinite(s.fishVel) ? s.fishVel : 0;
    const aim = s.fishPos + fishVel * plan.lead * T.fishLead;

    const error = aim - projectedBar;
    if (error > T.deadband) return true;    // bar needs to rise
    if (error < -T.deadband) return false;  // bar needs to fall
    return st.held;                          // inside the deadband, hold course
  }

  // Tension guard (PRD 4.26, 4.27).
  //
  // Tension only ever *decays* when we are not holding and the fish is not
  // running. During a run it climbs no matter what we do - 2.0x tensionRise
  // held, 0.6x released - so releasing does not reverse a run, it just buys
  // time until the run ends. That makes the guard a latch rather than a
  // threshold: once it fires it stays on until tension has come back down,
  // rather than flickering off the moment we dip below the line.
  let guardLatched = false;

  function tensionGuardWantsRelease(s) {
    const overHard = s.tension >= T.tensionHardCeil;
    const overSoft = s.tension >= plan.tensionCeil
      && (s.running || !T.guardRequiresRun);

    if (overHard || overSoft) {
      guardLatched = true;
    } else if (guardLatched && s.tension <= plan.tensionCeil - T.tensionHysteresis) {
      guardLatched = false;
    }
    return guardLatched;
  }

  // Accuracy shaper (PRD 4.28, 4.29).
  //
  // Left alone the controller reports accuracy near 1.0 on any winnable fight,
  // which is the clearest implausibility signal we can send. So when live
  // accuracy drifts above this fight's target we deliberately lose the fish for
  // a moment, the way a person's attention slips.
  //
  // Drops must outlast the 0.3s coyote grace to register at all: overlapMs, the
  // numerator of the accuracy we report, keeps incrementing throughout the
  // grace window. A drop of duration D therefore costs only (D - GRACE_MS) of
  // accuracy, which is why these are measured in hundreds of milliseconds.
  //
  // There is no upward mechanism. When accuracy runs *below* the band the
  // tracking rule is already trying its hardest and the fight is one we are
  // losing - and a lost fight reports an escape, not a suspiciously good catch.
  // Suppressing drops is the only lever, and that happens for free here.
  let dropUntilMs = 0;
  let dropHeld = false;

  // How long a drop must last to bring reported accuracy down to target.
  //
  // Over a drop of duration D, grace still credits GRACE_MS of overlap while
  // elapsed time grows by the whole D. Solving
  //   (overlap + GRACE_MS) / (elapsed + D) = target
  // for D gives the duration below. Sizing the drop this way instead of
  // picking a random length matters: a fixed 800ms drop is a 4-point accuracy
  // correction on a 12s fight, which sails straight past the target and out
  // the bottom of the band.
  function neededDropMs(overlapMs, elapsedMs) {
    return (overlapMs + GRACE_MS) / plan.targetAccuracy - elapsedMs;
  }

  // Returns null when no drop is wanted, or the hold value to force.
  //
  // A drop commits to driving the bar at one end of the track for its whole
  // duration, chosen at the start as whichever end is further from the fish.
  //
  // Two weaker versions of this did not work, both for the same reason - a
  // wide catch window. On the `easy` profile the window is 16 units of a
  // 100-unit track, and merely releasing leaves 1% of fights reporting
  // accuracy of exactly 1.000, because the bar never travels far enough to
  // leave it. Re-deciding the direction every frame is worse still (2%): the
  // choice flips as the fish crosses the bar, and the bar can end up parked at
  // a clamp the fish keeps wandering back into.
  //
  // Committing to one end works because the fish does not stay there. It
  // retargets across 5..95, so a bar pinned at the bottom is only overlapped
  // while the fish is low, and the gap opens on its own.
  function shaperDecision(s) {
    if (st.elapsedMs < dropUntilMs) return dropHeld;

    const simElapsed = Number.isFinite(s.elapsedMs) ? s.elapsedMs : 0;
    const simOverlap = Number.isFinite(s.overlapMs) ? s.overlapMs : 0;
    if (simElapsed < T.shaperWarmupMs || simElapsed <= 0) return null;

    const live = simOverlap / simElapsed;
    if (live <= plan.targetAccuracy + T.accuracyTolerance) return null;

    const needed = neededDropMs(simOverlap, simElapsed) - T.reacquireAllowanceMs;

    // Too small to be worth doing: grace would swallow most of it, and
    // rounding up to the minimum would overshoot. Let the excess build until a
    // full-sized drop is actually warranted.
    if (needed < T.dropOffMinMs) return null;

    const jitter = randRange(rand, T.dropJitterMin, T.dropJitterMax);
    dropUntilMs = st.elapsedMs + Math.min(needed, T.dropOffMaxMs) * jitter;
    // Drive to whichever end of the track the fish is further from, and hold
    // that choice for the whole drop.
    dropHeld = s.fishPos < 50;
    st.dropOffs += 1;
    return dropHeld;
  }

  // minFightMs stall (PRD 4.30).
  //
  // createFightSim never reads params.minFightMs - the server sends a floor and
  // the simulation ignores it - so a fight can finish well under the server's
  // own stated minimum and be reported as such. Measured on the `easy` profile
  // before any of this existed: 100% of fights landed under the floor. Nothing
  // else enforces it.
  //
  // While the floor is unmet we park progress in a band just below 100 rather
  // than letting it complete, then release the stall once the clock passes.
  // Progress does not stop climbing when we decide to stall. Three delays
  // stack up between the decision and progress actually falling:
  //
  //   1. reactionLagMs - the snapshot we judged was already that old.
  //   2. The bar has to physically leave the catch window. Releasing only
  //      starts it falling; it must travel overlapHalfWidth before it stops
  //      counting as on the fish. Under the simulation's release accelerationc
  //      (-300 against drag) that is roughly sqrt(halfWidth / 150) seconds,
  //      plus a moment to reverse whatever upward velocity it had.
  //   3. GRACE_MS of coyote time after it finally does leave.
  //
  // Across all three, progress rises at the full progressRate. Missing step 2
  // is what broke the first version of this: on the `easy` profile - barSize
  // 26, so a 16-unit window - progress read 92.7, kept climbing for nearly a
  // second while released, and hit 100 at 7.4s against a 10s floor.
  const stallExitMs = 1000 * Math.sqrt(params.overlapHalfWidth / 150) + 150;
  const stallBlindMs = plan.reactionLagMs + stallExitMs + GRACE_MS;
  const stallCeiling = Math.max(
    50,
    100 - params.progressRate * (stallBlindMs / 1000) - T.stallMargin,
  );
  const stallFloor = stallCeiling - T.stallBandWidth;

  let stallLatched = false;

  // Returns null when the stall has no opinion, or the hold value to force.
  //
  // Note this does not simply release. On a wide-barred fish, releasing does
  // not stop progress at all: `easy` has barSize 26, so the catch window is 16
  // units of a 100-unit track, and a released bar never travels far enough to
  // leave it while the fish wanders alongside. Measured, those fights reported
  // accuracy of exactly 1.000 and finished at 5.83s - the theoretical minimum -
  // with the stall latched and releasing the whole way.
  //
  // So the stall steers actively away from the fish instead: down when the fish
  // is above us, up when it is below. That is the only way to open a gap wider
  // than the catch window.
  function stallDecision(s) {
    if (params.minFightMs <= 0) return null;

    const simElapsed = Number.isFinite(s.elapsedMs) ? s.elapsedMs : 0;
    if (simElapsed >= params.minFightMs) {
      stallLatched = false;
      return null;
    }

    if (s.progress >= stallCeiling) stallLatched = true;
    else if (stallLatched && s.progress <= stallFloor) stallLatched = false;
    if (!stallLatched) return null;

    // Drive away from the fish to open a gap wider than overlapHalfWidth.
    return s.fishPos < s.barPos;
  }

  // Priority order matters. Snap avoidance outranks everything: when the guard
  // and the tracking rule disagree, the guard wins (PRD 4.27). Losing a fish to
  // slack is a worse outcome than landing it, but a better one than snapping.
  //
  // The stall comes next - reporting a fight shorter than the server's floor
  // risks the whole catch being thrown out as implausible, so it outranks the
  // cosmetic accuracy shaping below it. All three only ever ask us to let go,
  // so none of them can cause a snap, and their order never creates a conflict
  // - only a different reason recorded for the same release.
  function chooseHold(s) {
    if (tensionGuardWantsRelease(s)) {
      st.guardSteps += 1;
      return false;
    }
    const stall = stallDecision(s);
    if (stall !== null) {
      st.stallSteps += 1;
      return stall;
    }
    const drop = shaperDecision(s);
    if (drop !== null) {
      st.shaperSteps += 1;
      return drop;
    }
    return trackingHold(s);
  }

  function decide(simState, dtMs) {
    st.steps += 1;
    st.elapsedMs += Number.isFinite(dtMs) ? dtMs : 0;

    if (isUsableState(simState)) {
      lagBuffer.push({ t: st.elapsedMs, s: simState });
      if (lagBuffer.length > LAG_BUFFER_MAX) lagBuffer.shift();
    } else {
      st.blindSteps += 1;
    }

    // Drop snapshots we have aged past, keeping the newest one that is still
    // at least a full reaction time old.
    const cutoff = st.elapsedMs - plan.reactionLagMs;
    while (lagBuffer.length > 1 && lagBuffer[1].t <= cutoff) lagBuffer.shift();

    let next;
    const oldest = lagBuffer[0];
    if (!oldest || oldest.t > cutoff) {
      // The buffer does not reach back a full reaction time yet, so the fight
      // has only just started. A person would not have moved either.
      st.warmupSteps += 1;
      next = BLIND_DEFAULT_HELD;
    } else {
      st.lastLagMs = st.elapsedMs - oldest.t;
      next = !!chooseHold(oldest.s, rand);
    }

    if (next !== st.held) st.flips += 1;
    st.held = next;
    return next;
  }

  // Test and diagnostic surface. `flips per second` is the number to watch:
  // a human cannot reverse a hold 30 times a second, so a high rate is both a
  // control-quality problem and a plausibility problem.
  function getDebug() {
    const seconds = st.elapsedMs / 1000;
    return {
      ...st,
      flipsPerSec: seconds > 0 ? st.flips / seconds : 0,
      plan,
      params,
    };
  }

  return { decide, getDebug, params, plan };
}

// ---- Loop pacing ----------------------------------------------------------

// Pause between the server's verdict and the next "bait hook" (PRD 4.12).
export function cycleDelayMs(rand) {
  return Math.round(randRange(rand, TUNING.cycleDelayMinMs, TUNING.cycleDelayMaxMs));
}

// Pause between "bait hook" and the "fish" that follows it.
export function baitDelayMs(rand) {
  return Math.round(randRange(rand, TUNING.baitDelayMinMs, TUNING.baitDelayMaxMs));
}

// ---- Persisted power ------------------------------------------------------

// The adaptive power restored from settings. Anything unusable becomes the
// start value; a usable number is clamped to the policy band, so a hand-edited
// settings file cannot put the policy outside the range it reasons about.
export function normalizeCastPower(value) {
  const n = toFiniteOrNull(value);
  if (n === null) return TUNING.castPowerStart;
  return clamp(Math.round(n), TUNING.castPowerMin, TUNING.castPowerMax);
}

// A fixed override: null when there is none, otherwise clamped to the
// protocol's 0..100 rather than the policy band - a player pinning 100 is
// asking for exactly that.
export function normalizePowerOverride(value) {
  const n = toFiniteOrNull(value);
  return n === null ? null : clamp(Math.round(n), 0, 100);
}

// ---- /autofish ------------------------------------------------------------

export const AUTOFISH_USAGE = 'usage: /autofish, /autofish on, /autofish off, /autofish power <0-100>, /autofish power auto';

// Parse the words after "/autofish" (PRD 4.1-4.4, 7.6). Returns one of
//   { action: 'status' | 'on' | 'off' }
//   { action: 'power', override: number | null }   (null = adaptive)
//   { action: 'error', error: string }
// Non-numeric power is rejected with a message rather than coerced to NaN.
export function parseAutofishCommand(args) {
  const words = (Array.isArray(args) ? args : String(args || '').split(/\s+/))
    .map((w) => String(w === undefined || w === null ? '' : w).trim().toLowerCase())
    .filter(Boolean);
  if (!words.length) return { action: 'status' };
  const [verb, arg, extra] = words;
  if (extra !== undefined) return { action: 'error', error: AUTOFISH_USAGE };
  if (verb === 'status' || verb === 'on' || verb === 'off') {
    if (arg !== undefined) return { action: 'error', error: AUTOFISH_USAGE };
    return { action: verb };
  }
  if (verb === 'power') {
    if (arg === undefined) return { action: 'error', error: AUTOFISH_USAGE };
    if (arg === 'auto') return { action: 'power', override: null };
    const n = toFiniteOrNull(arg);
    if (n === null) return { action: 'error', error: 'cast power must be a number from 0 to 100, or "auto".' };
    return { action: 'power', override: clamp(Math.round(n), 0, 100) };
  }
  return { action: 'error', error: AUTOFISH_USAGE };
}

// One line for the output window, from fishingAuto.status().
export function formatAutofishStatus(s) {
  const lostBy = s.lostBy || {};
  const causes = Object.keys(lostBy).filter((k) => lostBy[k] > 0).map((k) => k + ' ' + lostBy[k]);
  const parts = [
    'Auto-Angler: ' + (s.enabled ? 'on' : 'off'),
    'phase ' + (s.phase || 'idle'),
    'landed ' + (s.landed || 0) + ', lost ' + (s.lost || 0) + (causes.length ? ' (' + causes.join(', ') + ')' : ''),
    'cycles ' + (s.cycles || 0),
    'cast power ' + s.power + (s.powerOverride === null || s.powerOverride === undefined ? ' (adaptive)' : ' (fixed)'),
  ];
  if (s.haltReason) parts.push('last stop: ' + s.haltReason);
  return parts.join(' | ');
}

// The short form the fishing panel shows while the addon is on.
export function formatAutofishSummary(s) {
  return 'AUTO ' + (s.landed || 0) + ' landed, ' + (s.lost || 0) + ' lost, power ' + s.power
    + (s.powerOverride === null || s.powerOverride === undefined ? '' : ' (fixed)');
}

// Re-exported so the manager can time its cast release against the same
// oscillator the simulation uses, rather than importing from two places.
export { castPowerAt };
