import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DPS_IDLE_TIMEOUT_MS,
  createDpsState,
  encounterDurationMs,
  finalizeEncounter,
  reduceDpsEvents,
  reduceDpsIdle,
  reduceDpsState,
  resetDpsSession,
  rollingDps,
  selectDpsView,
  sessionCombatMs,
} from '../public/js/dps-meter-core.mjs';

const NOW = 1_000_000;

function stateFrame(overrides = {}) {
  return {
    epoch: 'connection-7',
    encounter_id: 'encounter-12',
    seq: 1,
    visual_enabled: false,
    effective: false,
    active: true,
    current_actor_id: 'self',
    current_target_id: 'actor-2',
    actors: [
      { id: 'self', name: 'Acer', role: 'self' },
      { id: 'actor-2', name: 'an ash drake', role: 'target' },
    ],
    ...overrides,
  };
}

function swing(seq, overrides = {}) {
  return {
    seq,
    kind: 'attack',
    perspective: 'outgoing',
    actor_id: 'self',
    target_id: 'actor-2',
    result: 'hit',
    damage: 100,
    ...overrides,
  };
}

function eventFrame(events, overrides = {}) {
  return {
    epoch: 'connection-7',
    encounter_id: 'encounter-12',
    first_seq: events.length ? events[0].seq : 0,
    last_seq: events.length ? events[events.length - 1].seq : 0,
    events,
    ...overrides,
  };
}

function openEncounter(now = NOW) {
  return reduceDpsState(createDpsState(), stateFrame(), now);
}

test('a State frame opens an encounter and names the target from the roster', () => {
  const state = openEncounter();
  assert.equal(state.active, true);
  assert.equal(state.encounterId, 'encounter-12');
  assert.equal(state.targetName, 'an ash drake');
});

test('the meter tracks encounters while visual combat is disabled', () => {
  // combat-visual-core drops every event unless visualEnabled is true. The
  // meter must not inherit that gate.
  let state = openEncounter();
  assert.equal(state.active, true);
  state = reduceDpsEvents(state, eventFrame([swing(1)]), NOW);
  assert.equal(state.encounter.damage, 100);
});

test('an event batch adopts an encounter that no State frame introduced', () => {
  const state = reduceDpsEvents(createDpsState(), eventFrame([swing(1, { damage: 25 })]), NOW);
  assert.equal(state.active, true);
  assert.equal(state.encounterId, 'encounter-12');
  assert.equal(state.encounter.damage, 25);
});

test('only outgoing swings count toward damage', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([
    swing(1, { damage: 100 }),
    swing(2, { perspective: 'incoming', actor_id: 'actor-2', target_id: 'self', damage: 999 }),
    swing(3, { perspective: 'observed', damage: 500 }),
  ]), NOW);

  assert.equal(state.encounter.damage, 100);
  assert.equal(state.encounter.swings, 1);
  // Non-outgoing frames still advance the sequence cursor so a later replay
  // of the same seq cannot be double counted.
  assert.equal(state.lastSeq, 3);
});

test('duplicate and out-of-order sequences are ignored', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([swing(1), swing(2)]), NOW);
  const damageAfterFirstBatch = state.encounter.damage;

  const replayed = reduceDpsEvents(state, eventFrame([swing(1), swing(2)]), NOW + 100);
  assert.equal(replayed, state, 'a fully duplicate batch returns the same state object');
  assert.equal(replayed.encounter.damage, damageAfterFirstBatch);

  const withStale = reduceDpsEvents(state, eventFrame([swing(2), swing(3)]), NOW + 200);
  assert.equal(withStale.encounter.damage, damageAfterFirstBatch + 100);
  assert.equal(withStale.encounter.swings, 3);
});

test('event batches sort by sequence before they are applied', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([swing(3), swing(1), swing(2)]), NOW);
  assert.equal(state.encounter.swings, 3);
  assert.equal(state.lastSeq, 3);
});

test('results are tallied and the best hit is remembered', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([
    swing(1, { result: 'hit', damage: 40 }),
    swing(2, { result: 'critical', damage: 250 }),
    swing(3, { result: 'miss', damage: 0 }),
    swing(4, { result: 'dodge', damage: 0 }),
    swing(5, { result: 'absorb', damage: 0, absorbed: 12 }),
  ]), NOW);

  const tally = state.encounter;
  assert.equal(tally.swings, 5);
  assert.equal(tally.hits, 2);
  assert.equal(tally.crits, 1);
  assert.equal(tally.misses, 1);
  assert.equal(tally.dodges, 1);
  assert.equal(tally.absorbs, 1);
  assert.equal(tally.damage, 290);
  assert.equal(tally.absorbed, 12);
  assert.equal(tally.bestHit, 250);
});

test('encounter DPS divides damage by the elapsed fight, not by wall clock', () => {
  let state = openEncounter(NOW - 30_000);
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 100 })]), NOW);
  state = reduceDpsEvents(state, eventFrame([swing(2, { damage: 300 })]), NOW + 4000);

  // The clock starts at the first swing, not when the encounter was opened.
  assert.equal(encounterDurationMs(state, NOW + 4000), 4000);
  const view = selectDpsView(state, NOW + 4000);
  assert.equal(view.encounter.dps, 100);
});

test('a burst of swings in one instant does not report an absurd rate', () => {
  let state = openEncounter();
  // A whole batch can share a timestamp; dividing 1138 damage by a few
  // milliseconds would otherwise read as hundreds of thousands of DPS.
  state = reduceDpsEvents(state, eventFrame([
    swing(1, { damage: 400 }),
    swing(2, { damage: 400 }),
    swing(3, { damage: 338 }),
  ]), NOW);

  assert.equal(selectDpsView(state, NOW + 4).encounter.dps, null);
  // The rolling window is still meaningful because it divides by the window.
  assert.equal(selectDpsView(state, NOW + 4).encounter.current, 113.8);
  // Once a measurable second has passed the rate is reported.
  assert.equal(selectDpsView(state, NOW + 2000).encounter.dps, 569);
});

test('a fight too short to measure is banked without a DPS figure', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 400 })]), NOW);
  state = reduceDpsState(state, stateFrame({ active: false, outcome: 'victory' }), NOW + 10);

  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].dps, null);
  assert.equal(state.history[0].damage, 400, 'the damage total is still recorded');
});

test('a fight runs until the frame that reports its outcome', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 100 })]), NOW);
  state = reduceDpsEvents(state, eventFrame([swing(2, { damage: 300 })]), NOW + 2000);
  state = reduceDpsState(state, stateFrame({ active: false, outcome: 'victory', seq: 9 }), NOW + 4000);

  assert.equal(state.active, false);
  // 400 damage over the full four seconds, not over the two seconds between
  // the first and last swing.
  assert.equal(encounterDurationMs(state, NOW + 9000), 4000);
  assert.equal(selectDpsView(state, NOW + 9000).encounter.dps, 100);
});

test('a finished encounter freezes instead of decaying as time passes', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 400 })]), NOW);
  state = reduceDpsState(state, stateFrame({ active: false, outcome: 'victory' }), NOW + 4000);

  const atEnd = selectDpsView(state, NOW + 4000).encounter.dps;
  const muchLater = selectDpsView(state, NOW + 600_000).encounter.dps;
  assert.equal(atEnd, muchLater);
});

test('the rolling window reports recent damage over the window length', () => {
  let state = createDpsState({ windowMs: 10_000 });
  state = reduceDpsState(state, stateFrame(), NOW);
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 500 })]), NOW);

  // 500 damage inside a ten second window is 50 damage per second.
  assert.equal(rollingDps(state, NOW), 50);
  // Once the sample ages out of the window the rolling value returns to zero.
  assert.equal(rollingDps(state, NOW + 11_000), 0);
});

test('peak DPS records the highest rolling value the encounter reached', () => {
  let state = createDpsState({ windowMs: 10_000 });
  state = reduceDpsState(state, stateFrame(), NOW);
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 1000 })]), NOW);
  const peak = state.peakDps;
  assert.equal(peak, 100);

  state = reduceDpsEvents(state, eventFrame([swing(2, { damage: 10 })]), NOW + 60_000);
  assert.equal(state.peakDps, peak, 'a later quiet stretch does not lower the peak');
});

test('a new encounter banks the previous fight into session totals and history', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 400 })]), NOW);
  state = reduceDpsState(state, stateFrame({ active: false, outcome: 'victory' }), NOW + 4000);

  state = reduceDpsState(state, stateFrame({
    encounter_id: 'encounter-13',
    actors: [
      { id: 'self', name: 'Acer', role: 'self' },
      { id: 'actor-2', name: 'a cave bat', role: 'target' },
    ],
  }), NOW + 5000);

  assert.equal(state.encounterId, 'encounter-13');
  assert.equal(state.targetName, 'a cave bat');
  assert.equal(state.encounter.damage, 0, 'the live tally resets for the new fight');
  assert.equal(state.session.damage, 400, 'the session tally carries over');
  assert.equal(state.session.encounters, 1);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].targetName, 'an ash drake');
  assert.equal(state.history[0].dps, 100);
});

test('session DPS uses combat time only, so walking around does not dilute it', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 400 })]), NOW);
  state = reduceDpsState(state, stateFrame({ active: false, outcome: 'victory' }), NOW + 4000);

  // Ten idle minutes pass out of combat.
  const later = NOW + 4000 + 600_000;
  assert.equal(sessionCombatMs(state, later), 4000);
  assert.equal(selectDpsView(state, later).session.dps, 100);
});

test('history is bounded by the configured limit', () => {
  let state = createDpsState({ historyLimit: 2 });
  for (let i = 1; i <= 4; i++) {
    const encounterId = 'encounter-' + i;
    const at = NOW + i * 10_000;
    state = reduceDpsState(state, stateFrame({ encounter_id: encounterId }), at);
    state = reduceDpsEvents(state, eventFrame([swing(1, { damage: i * 10 })], { encounter_id: encounterId }), at);
    state = reduceDpsState(state, stateFrame({ encounter_id: encounterId, active: false }), at + 1000);
  }

  assert.equal(state.history.length, 2);
  assert.deepEqual(state.history.map((entry) => entry.damage), [30, 40]);
  // The view shows the most recent fight first.
  assert.deepEqual(selectDpsView(state, NOW).history.map((entry) => entry.damage), [40, 30]);
});

test('an encounter with no swings is not recorded in history', () => {
  let state = openEncounter();
  state = reduceDpsState(state, stateFrame({ active: false, outcome: 'fled' }), NOW + 1000);
  assert.equal(state.history.length, 0);
  assert.equal(state.session.encounters, 0);
});

test('an idle encounter is closed out at its last swing', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 400 })]), NOW);
  state = reduceDpsEvents(state, eventFrame([swing(2, { damage: 400 })]), NOW + 2000);

  const stillActive = reduceDpsIdle(state, NOW + 2000 + DPS_IDLE_TIMEOUT_MS - 1);
  assert.equal(stillActive.active, true);

  const closed = reduceDpsIdle(state, NOW + 2000 + DPS_IDLE_TIMEOUT_MS);
  assert.equal(closed.active, false);
  // The dead air is not billed to the fight: it ran from the first swing to
  // the last, two seconds.
  assert.equal(encounterDurationMs(closed, NOW + 600_000), 2000);
  assert.equal(closed.session.combatMs, 2000);
});

test('trailing events cannot reopen a finished encounter', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 100 })]), NOW);
  state = reduceDpsState(state, stateFrame({ active: false, outcome: 'victory' }), NOW + 1000);

  const after = reduceDpsEvents(state, eventFrame([swing(2, { damage: 5000 })]), NOW + 2000);
  assert.equal(after, state);
  assert.equal(after.active, false);
  assert.equal(after.encounter.damage, 100);
});

test('a new connection epoch discards every earlier tally', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 400 })]), NOW);
  state = reduceDpsState(state, stateFrame({ active: false }), NOW + 2000);
  assert.equal(state.session.damage, 400);

  state = reduceDpsState(state, stateFrame({ epoch: 'connection-8', encounter_id: 'encounter-99' }), NOW + 3000);
  assert.equal(state.epoch, 'connection-8');
  assert.equal(state.session.damage, 0);
  assert.equal(state.session.encounters, 0);
  assert.equal(state.history.length, 0);
});

test('missing damage numbers are reported rather than shown as zero', () => {
  let state = openEncounter();
  // `combatbrief damage` off: the server omits every numeric field.
  const noNumbers = { seq: 1, kind: 'attack', perspective: 'outgoing', result: 'hit', summary: 'You hit an ash drake.' };
  state = reduceDpsEvents(state, eventFrame([noNumbers]), NOW);

  const view = selectDpsView(state, NOW + 1000);
  assert.equal(view.missingDamageNumbers, true);
  assert.equal(view.encounter.swings, 1);
  assert.equal(view.encounter.damage, 0);
});

test('damage numbers seen once clear the missing-numbers hint', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 10 })]), NOW);
  assert.equal(selectDpsView(state, NOW).missingDamageNumbers, false);
});

test('a fight that has only missed is not mistaken for missing numbers', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([
    swing(1, { result: 'miss', damage: 0 }),
    swing(2, { result: 'dodge', damage: 0 }),
  ]), NOW);
  assert.equal(selectDpsView(state, NOW + 1000).missingDamageNumbers, false);
});

test('turning damage numbers off mid-session is reported on the next fight', () => {
  const numberless = (seq) => ({
    seq, kind: 'attack', perspective: 'outgoing', result: 'hit', summary: 'You hit an ash drake.',
  });

  // A first fight with numbers on.
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 100 })]), NOW);
  state = reduceDpsState(state, stateFrame({ active: false }), NOW + 2000);
  assert.equal(selectDpsView(state, NOW + 2000).missingDamageNumbers, false);

  // The player turns `combatbrief damage` off, then fights again.
  state = reduceDpsState(state, stateFrame({ encounter_id: 'encounter-13' }), NOW + 3000);
  state = reduceDpsEvents(state, eventFrame([numberless(1)], { encounter_id: 'encounter-13' }), NOW + 3000);

  assert.equal(selectDpsView(state, NOW + 4000).missingDamageNumbers, true);
});

test('resetting the session clears totals but keeps the live fight running', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 400 })]), NOW);
  state = reduceDpsState(state, stateFrame({ active: false }), NOW + 2000);
  state = reduceDpsState(state, stateFrame({ encounter_id: 'encounter-13' }), NOW + 3000);
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 50 })], { encounter_id: 'encounter-13' }), NOW + 3000);

  const reset = resetDpsSession(state, NOW + 4000);
  assert.equal(reset.session.damage, 0);
  assert.equal(reset.session.encounters, 0);
  assert.equal(reset.history.length, 0);
  assert.equal(reset.active, true, 'the fight in progress keeps running');
  assert.equal(reset.encounterId, 'encounter-13');
  assert.equal(reset.lastSeq, 1, 'the sequence cursor survives so replays stay deduplicated');
  assert.equal(reset.encounter.damage, 0);
});

test('resetting outside combat leaves the meter idle', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 400 })]), NOW);
  state = reduceDpsState(state, stateFrame({ active: false }), NOW + 2000);

  const reset = resetDpsSession(state, NOW + 3000);
  assert.equal(reset.active, false);
  assert.equal(reset.session.damage, 0);
  assert.equal(reset.epoch, 'connection-7', 'the connection epoch is kept so later frames still match');
});

test('malformed frames leave the state untouched', () => {
  const state = openEncounter();
  assert.equal(reduceDpsEvents(state, null, NOW), state);
  assert.equal(reduceDpsEvents(state, [], NOW), state);
  assert.equal(reduceDpsEvents(state, { events: [swing(1)] }, NOW), state, 'no epoch or encounter id');
  assert.equal(reduceDpsState(state, null, NOW), state);
  assert.equal(reduceDpsState(state, { active: true }, NOW), state, 'no epoch');
});

test('events for a different encounter start a fresh fight', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 100 })]), NOW);
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 70 })], { encounter_id: 'encounter-13' }), NOW + 1000);

  assert.equal(state.encounterId, 'encounter-13');
  assert.equal(state.encounter.damage, 70);
  assert.equal(state.session.damage, 170);
  assert.equal(state.session.encounters, 1);
});

test('the sample buffer stays bounded under a long fight', () => {
  let state = createDpsState({ windowMs: 10_000, sampleLimit: 16 });
  state = reduceDpsState(state, stateFrame(), NOW);
  for (let i = 1; i <= 200; i++) {
    state = reduceDpsEvents(state, eventFrame([swing(i, { damage: 5 })]), NOW + i);
  }
  assert.ok(state.samples.length <= 16, 'samples are capped at the configured limit');
});

test('finalizing an already finished encounter is a no-op', () => {
  let state = openEncounter();
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 100 })]), NOW);
  const ended = finalizeEncounter(state, NOW + 1000);
  assert.equal(finalizeEncounter(ended, NOW + 2000), ended);
  assert.equal(ended.session.encounters, 1);
});

test('the view exposes hit and crit rates only when there is something to divide', () => {
  let state = openEncounter();
  assert.equal(selectDpsView(state, NOW).encounter.hitRate, null);

  state = reduceDpsEvents(state, eventFrame([
    swing(1, { result: 'hit' }),
    swing(2, { result: 'critical' }),
    swing(3, { result: 'miss', damage: 0 }),
    swing(4, { result: 'miss', damage: 0 }),
  ]), NOW);

  const view = selectDpsView(state, NOW + 1000);
  assert.equal(view.encounter.hitRate, 0.5);
  assert.equal(view.encounter.critRate, 0.5);
  assert.equal(view.hasData, true);
});
