import test from 'node:test';
import assert from 'node:assert/strict';

const {
  ACTION_DURATION_MS,
  buildAction,
  computeStageLayout,
  createSeededRandom,
  idleOffset,
  lungeCurve,
  resolveActionSides,
  resolveStageBackdrop,
  sampleAction,
} = await import('../public/js/combat-stage-core.mjs');

const view = {
  player: { id: 'self', name: 'Acer' },
  target: { id: 'actor-2', name: 'an ash drake' },
};

function event(overrides = {}) {
  return {
    seq: 18,
    kind: 'attack',
    perspective: 'outgoing',
    actorId: 'self',
    targetId: 'actor-2',
    result: 'hit',
    damage: 42,
    ...overrides,
  };
}

test('layout keeps the tokens inside the stage at any size', () => {
  for (const [w, h] of [[120, 80], [320, 180], [900, 420], [1600, 300]]) {
    const layout = computeStageLayout(w, h);
    assert.ok(layout.radius >= 22);
    assert.ok(layout.player.x - layout.radius >= 0, 'player token fits: ' + w + 'x' + h);
    assert.ok(layout.target.x + layout.radius <= w, 'target token fits: ' + w + 'x' + h);
    assert.ok(layout.player.y + layout.radius <= h, 'token bottom fits: ' + w + 'x' + h);
    assert.ok(layout.player.x < layout.target.x);
  }
});

test('backdrop resolves room terrain to a shipped tile and never concatenates server text', () => {
  assert.deepEqual(resolveStageBackdrop({ terrain: 'forest' }),
    { terrain: 'forest', tile: '/assets/tiles/forest.jpg' });
  assert.deepEqual(resolveStageBackdrop({ environment: ['dark', 'underground cave'] }),
    { terrain: 'underground', tile: '/assets/tiles/underground.jpg' });
  assert.deepEqual(resolveStageBackdrop({ terrain: '../../etc/passwd' }),
    { terrain: 'outside', tile: '/assets/tiles/outside.jpg' });
  assert.deepEqual(resolveStageBackdrop(null),
    { terrain: 'outside', tile: '/assets/tiles/outside.jpg' });
});

test('perspective decides sides before actor ids, and observed fights fall back to ids', () => {
  assert.deepEqual(resolveActionSides(event(), view), { actor: 'player', impact: 'target' });
  assert.deepEqual(resolveActionSides(event({ perspective: 'incoming', actorId: 'actor-2', targetId: 'self' }), view),
    { actor: 'target', impact: 'player' });
  // A stale or mixed server marks the wrong ids but says "incoming": the
  // player still takes the hit.
  assert.deepEqual(resolveActionSides(event({ perspective: 'incoming' }), view),
    { actor: 'target', impact: 'player' });
  const observedView = {
    player: { id: 'actor-9', name: 'Bryn' },
    target: { id: 'actor-2', name: 'an ash drake' },
  };
  assert.deepEqual(resolveActionSides(event({ perspective: 'observed', actorId: 'actor-2', targetId: 'actor-9' }), observedView),
    { actor: 'target', impact: 'player' });
  assert.deepEqual(resolveActionSides(event({ perspective: 'observed', actorId: 'nobody', targetId: 'nobody' }), observedView),
    { actor: '', impact: '' });
});

test('buildAction rejects events it cannot stage and seeds particles deterministically', () => {
  assert.equal(buildAction(null, view), null);
  assert.equal(buildAction(event({ result: '' }), view), null);
  assert.equal(buildAction(event({ perspective: 'observed', actorId: 'x', targetId: 'y' }), view), null);

  const hit = buildAction(event(), view, 1000);
  assert.equal(hit.startedAt, 1000);
  assert.equal(hit.duration, ACTION_DURATION_MS);
  assert.equal(hit.landed, true);
  assert.equal(hit.critical, false);
  assert.equal(hit.damage, 42);
  assert.ok(hit.particles.length > 0);
  const again = buildAction(event(), view, 5000);
  assert.deepEqual(again.particles, hit.particles, 'same seq gives the same burst');

  const critical = buildAction(event({ result: 'critical', seq: 19 }), view);
  assert.ok(critical.particles.length > hit.particles.length);
  const miss = buildAction(event({ result: 'miss', damage: undefined }), view);
  assert.equal(miss.particles.length, 0);
  assert.equal(miss.damage, null, 'an undefined damage value is not a number');
  const noDamage = buildAction({ ...event(), damage: undefined }, view);
  assert.equal(noDamage.damage, null);
});

test('seeded random is stable and bounded', () => {
  const a = createSeededRandom(42);
  const b = createSeededRandom(42);
  for (let i = 0; i < 20; i++) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1);
  }
});

test('lunge curve leaves and returns to rest', () => {
  assert.equal(lungeCurve(0), 0);
  assert.ok(lungeCurve(0.42) > 0.99);
  assert.ok(lungeCurve(0.2) > 0 && lungeCurve(0.2) < 1);
  assert.ok(Math.abs(lungeCurve(1)) < 1e-9);
});

test('an outgoing hit lunges the player, recoils the target, and floats the number', () => {
  const action = buildAction(event(), view, 0);
  const early = sampleAction(action, 60);
  assert.equal(early.active, true);
  assert.ok(early.player.x > 0, 'player moves toward the target');
  assert.equal(early.target.x, 0, 'no contact yet');
  assert.equal(early.effects.length, 0);
  assert.equal(early.number, null);

  const contact = sampleAction(action, ACTION_DURATION_MS * 0.2);
  assert.ok(contact.target.x > 0, 'target recoils away from the player');
  assert.ok(contact.target.flash > 0);
  assert.ok(contact.shake > 0 && contact.shake < 1, 'target-side hits shake lightly');
  assert.equal(contact.flash, 0, 'no screen flash when the enemy takes the hit');
  assert.deepEqual(contact.effects.map((effect) => effect.type), ['slash', 'burst']);
  assert.equal(contact.effects[0].side, 'target');
  assert.equal(contact.number.side, 'target');
  assert.equal(contact.number.value, 42);

  const late = sampleAction(action, ACTION_DURATION_MS * 0.9);
  assert.ok(late.number.rise > contact.number.rise, 'number keeps rising');
  assert.ok(late.number.alpha < contact.number.alpha, 'number fades out');

  const done = sampleAction(action, ACTION_DURATION_MS + 1);
  assert.equal(done.active, false);
  assert.equal(done.effects.length, 0);
});

test('an incoming critical shakes and flashes the player side', () => {
  const action = buildAction(event({ perspective: 'incoming', result: 'critical', damage: 77 }), view, 0);
  const contact = sampleAction(action, ACTION_DURATION_MS * 0.18);
  assert.ok(contact.target.x < 0, 'enemy lunges left');
  assert.ok(contact.player.x < 0, 'player is knocked left');
  assert.ok(contact.shake > 1, 'critical incoming shakes hardest');
  assert.ok(contact.flash > 0);
  assert.equal(contact.number.side, 'player');
  assert.equal(contact.number.critical, true);
  assert.equal(contact.badge.result, 'critical');
});

test('misses, dodges, and absorbs stage their own effects without damage numbers', () => {
  const at = ACTION_DURATION_MS * 0.3;
  const miss = sampleAction(buildAction({ ...event({ result: 'miss' }), damage: undefined }, view, 0), at);
  assert.deepEqual(miss.effects.map((effect) => effect.type), ['whiff']);
  assert.equal(miss.number, null);
  assert.equal(miss.shake, 0);
  assert.equal(miss.badge.result, 'miss');

  const dodge = sampleAction(buildAction({ ...event({ result: 'dodge' }), damage: undefined }, view, 0), at);
  assert.deepEqual(dodge.effects.map((effect) => effect.type), ['ghost']);
  assert.ok(dodge.target.x > 0 && dodge.target.alpha < 1, 'target slips aside and ghosts');

  const absorb = sampleAction(buildAction({ ...event({ result: 'absorb', absorbed: 9 }), damage: undefined }, view, 0), at);
  assert.deepEqual(absorb.effects.map((effect) => effect.type), ['shield']);
  assert.equal(absorb.number, null);
});

test('reduced motion removes movement but keeps the outcome readable', () => {
  const action = buildAction(event({ perspective: 'incoming', result: 'critical' }), view, 0);
  const sample = sampleAction(action, ACTION_DURATION_MS * 0.3, { reducedMotion: true });
  assert.equal(sample.player.x, 0);
  assert.equal(sample.target.x, 0);
  assert.equal(sample.shake, 0);
  assert.equal(sample.flash, 0);
  assert.equal(sample.number.rise, 0);
  assert.equal(sample.number.alpha, 1);
  assert.equal(sample.badge.result, 'critical');
  const burst = sample.effects.find((effect) => effect.type === 'burst');
  assert.deepEqual(burst.particles, [], 'no particle spray under reduced motion');
  assert.deepEqual(idleOffset('player', 1234, true), { x: 0, y: 0 });
  assert.notEqual(idleOffset('player', 1234, false).y, 0);
});
