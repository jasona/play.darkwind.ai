import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};
globalThis.document = {
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
  createElement() {
    return {
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild() {},
      setAttribute() {},
      addEventListener() {},
      removeEventListener() {},
    };
  },
};
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  matchMedia() {
    return { matches: false, addEventListener() {}, removeEventListener() {} };
  },
};

const { renderDpsPanel } = await import('../public/js/dps-panel-renderer.mjs');
const {
  createDpsState,
  reduceDpsEvents,
  reduceDpsState,
  selectDpsView,
} = await import('../public/js/dps-meter-core.mjs');

const NOW = 1_000_000;

function stateFrame(overrides = {}) {
  return {
    epoch: 'connection-7',
    encounter_id: 'encounter-12',
    seq: 1,
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

function eventFrame(events, overrides = {}) {
  return {
    epoch: 'connection-7',
    encounter_id: 'encounter-12',
    events,
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

test('dps pane waits for combat before it shows numbers', () => {
  const bodyEl = { innerHTML: '' };
  renderDpsPanel(bodyEl, null);
  assert.match(bodyEl.innerHTML, /Waiting for combat/);
});

test('dps pane renders a live fight with its target and totals', () => {
  const bodyEl = { innerHTML: '', querySelectorAll: () => [] };

  let state = reduceDpsState(createDpsState(), stateFrame(), NOW);
  state = reduceDpsEvents(state, eventFrame([
    swing(1, { damage: 400 }),
    swing(2, { result: 'critical', damage: 600 }),
  ]), NOW);

  renderDpsPanel(bodyEl, selectDpsView(state, NOW + 10_000));

  assert.match(bodyEl.innerHTML, /dps-panel-active/);
  assert.match(bodyEl.innerHTML, /an ash drake/);
  assert.match(bodyEl.innerHTML, /1,000/, 'total damage is shown');
  assert.match(bodyEl.innerHTML, /600/, 'best hit is shown');
  assert.match(bodyEl.innerHTML, /data-dps-action="reset"/);
});

test('dps pane names the idle state instead of a stale target', () => {
  const bodyEl = { innerHTML: '', querySelectorAll: () => [] };

  let state = reduceDpsState(createDpsState(), stateFrame(), NOW);
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 400 })]), NOW);
  state = reduceDpsState(state, stateFrame({ active: false, outcome: 'victory' }), NOW + 4000);

  renderDpsPanel(bodyEl, selectDpsView(state, NOW + 5000));

  assert.match(bodyEl.innerHTML, /Idle/);
  assert.match(bodyEl.innerHTML, /Last fight DPS/);
  assert.doesNotMatch(bodyEl.innerHTML, /dps-panel-active/);
});

test('dps pane explains missing damage numbers rather than showing zeroes', () => {
  const bodyEl = { innerHTML: '', querySelectorAll: () => [] };

  let state = reduceDpsState(createDpsState(), stateFrame(), NOW);
  state = reduceDpsEvents(state, eventFrame([
    { seq: 1, kind: 'attack', perspective: 'outgoing', result: 'hit', summary: 'You hit an ash drake.' },
  ]), NOW);

  renderDpsPanel(bodyEl, selectDpsView(state, NOW + 1000));

  assert.match(bodyEl.innerHTML, /combatbrief damage/);
  // The damage figures are dashed out rather than shown as an unearned zero.
  assert.doesNotMatch(bodyEl.innerHTML, /0\.00/);
  assert.match(bodyEl.innerHTML, /--/);
  // Swing counts are still true and stay on screen.
  assert.match(bodyEl.innerHTML, /Swings/);
});

test('dps pane keeps a real session total when only the live fight lacks numbers', () => {
  const bodyEl = { innerHTML: '', querySelectorAll: () => [] };

  // A first fight reported numbers, then the player turned them off.
  let state = reduceDpsState(createDpsState(), stateFrame(), NOW);
  state = reduceDpsEvents(state, eventFrame([swing(1, { damage: 750 })]), NOW);
  state = reduceDpsState(state, stateFrame({ active: false }), NOW + 2000);

  const second = stateFrame({ encounter_id: 'encounter-13' });
  state = reduceDpsState(state, second, NOW + 3000);
  state = reduceDpsEvents(state, eventFrame([
    { seq: 1, kind: 'attack', perspective: 'outgoing', result: 'hit', summary: 'You hit.' },
  ], { encounter_id: 'encounter-13' }), NOW + 3000);

  renderDpsPanel(bodyEl, selectDpsView(state, NOW + 4000));

  assert.match(bodyEl.innerHTML, /combatbrief damage/, 'the live fight is flagged');
  assert.match(bodyEl.innerHTML, /750/, 'the banked session total survives');
});

test('dps pane shows a dash for a rate it cannot compute yet', () => {
  const bodyEl = { innerHTML: '', querySelectorAll: () => [] };
  renderDpsPanel(bodyEl, selectDpsView(createDpsState(), NOW));
  assert.match(bodyEl.innerHTML, /--/);
  assert.match(bodyEl.innerHTML, /No combat recorded yet/);
});

test('dps pane lists recent fights newest first', () => {
  const bodyEl = { innerHTML: '', querySelectorAll: () => [] };

  let state = createDpsState();
  for (const [id, name, damage] of [
    ['encounter-1', 'an ash drake', 400],
    ['encounter-2', 'a cave bat', 90],
  ]) {
    const frame = stateFrame({
      encounter_id: id,
      actors: [
        { id: 'self', name: 'Acer', role: 'self' },
        { id: 'actor-2', name, role: 'target' },
      ],
    });
    state = reduceDpsState(state, frame, NOW);
    state = reduceDpsEvents(state, eventFrame([swing(1, { damage })], { encounter_id: id }), NOW);
    state = reduceDpsState(state, { ...frame, active: false }, NOW + 2000);
  }

  renderDpsPanel(bodyEl, selectDpsView(state, NOW + 3000));

  const batIndex = bodyEl.innerHTML.indexOf('a cave bat');
  const drakeIndex = bodyEl.innerHTML.indexOf('an ash drake');
  assert.ok(batIndex > -1 && drakeIndex > -1, 'both fights are listed');
  assert.ok(batIndex < drakeIndex, 'the most recent fight is listed first');
});

test('dps pane escapes a hostile target name', () => {
  const bodyEl = { innerHTML: '', querySelectorAll: () => [] };

  const state = reduceDpsState(createDpsState(), stateFrame({
    actors: [
      { id: 'self', name: 'Acer', role: 'self' },
      { id: 'actor-2', name: '<img src=x onerror=alert(1)>', role: 'target' },
    ],
  }), NOW);

  renderDpsPanel(bodyEl, selectDpsView(state, NOW));

  assert.doesNotMatch(bodyEl.innerHTML, /<img src=x/);
  assert.match(bodyEl.innerHTML, /&lt;img/);
});

test('dps pane reports the session crit rate across fights', () => {
  const bodyEl = { innerHTML: '', querySelectorAll: () => [] };

  let state = createDpsState();
  // Fight one: two landed hits, one of them critical.
  state = reduceDpsState(state, stateFrame(), NOW);
  state = reduceDpsEvents(state, eventFrame([
    swing(1, { result: 'hit', damage: 100 }),
    swing(2, { result: 'critical', damage: 300 }),
  ]), NOW);
  state = reduceDpsState(state, stateFrame({ active: false }), NOW + 2000);

  // Fight two: a single ordinary hit, so the session is one crit in three.
  const second = stateFrame({ encounter_id: 'encounter-13' });
  state = reduceDpsState(state, second, NOW + 3000);
  state = reduceDpsEvents(state, eventFrame([swing(1, { result: 'hit', damage: 50 })], { encounter_id: 'encounter-13' }), NOW + 3000);
  state = reduceDpsState(state, { ...second, active: false }, NOW + 5000);

  const view = selectDpsView(state, NOW + 6000);
  assert.equal(view.session.crits, 1);
  assert.equal(view.session.hits, 3);

  renderDpsPanel(bodyEl, view);

  // Crits are a share of landed hits, matching the per-fight row above it.
  assert.match(bodyEl.innerHTML, /1 \(33%\)/);
});

test('session crit counts survive damage numbers being turned off', () => {
  const bodyEl = { innerHTML: '', querySelectorAll: () => [] };

  // A fight whose events carry results but no numeric wording at all.
  let state = reduceDpsState(createDpsState(), stateFrame(), NOW);
  state = reduceDpsEvents(state, eventFrame([
    { seq: 1, kind: 'attack', perspective: 'outgoing', result: 'critical', summary: 'You critically hit.' },
    { seq: 2, kind: 'attack', perspective: 'outgoing', result: 'hit', summary: 'You hit.' },
  ]), NOW);

  const view = selectDpsView(state, NOW + 2000);
  assert.equal(view.missingDamageNumbers, true);

  renderDpsPanel(bodyEl, view);

  // Damage figures are dashed, but the crit tally is still real and shown.
  assert.match(bodyEl.innerHTML, /combatbrief damage/);
  assert.match(bodyEl.innerHTML, /1 \(50%\)/);
});

test('the reset button calls back instead of dispatching a document event', () => {
  const clicks = [];
  const bodyEl = {
    innerHTML: '',
    querySelectorAll() {
      return [{ addEventListener(type, handler) { clicks.push([type, handler]); } }];
    },
  };
  let resets = 0;
  renderDpsPanel(bodyEl, selectDpsView(createDpsState(), NOW), { onReset: () => { resets += 1; } });
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0][0], 'click');
  clicks[0][1]();
  assert.equal(resets, 1);
});
