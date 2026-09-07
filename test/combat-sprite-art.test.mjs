import test from 'node:test';
import assert from 'node:assert/strict';

const { SPRITE_STYLES, spriteStyleFor } = await import('../public/js/combat-sprite-art.mjs');
const { figureGeometry, resolveFigure, resolvePose, POSES } = await import('../public/js/combat-rig-core.mjs');

function recordingContext() {
  const calls = [];
  return {
    calls,
    ctx: new Proxy({}, {
      get(target, prop) {
        if (typeof prop !== 'string') return undefined;
        return (...args) => { calls.push(prop); };
      },
      set() { return true; },
    }),
  };
}

test('every registered style draws each pose without throwing', () => {
  assert.ok(spriteStyleFor('male-scro'));
  assert.equal(spriteStyleFor('nope'), null);
  for (const [key, style] of Object.entries(SPRITE_STYLES)) {
    assert.equal(style.key, key);
    assert.ok(['humanoid', 'beast'].includes(style.kind));
    const figure = resolveFigure(style.kind === 'beast' ? { isNpc: true } : { race: key.split('-').slice(1).join('-') }, style.kind === 'beast' ? 'target' : 'player');
    figure.facing = 1;
    for (const pose of Object.keys(POSES)) {
      const joints = resolvePose({ from: pose, to: pose, t: 1 }, 0, { reducedMotion: true });
      const geo = figureGeometry(figure, joints, 128, 232, 64);
      const { ctx, calls } = recordingContext();
      style.draw(ctx, geo, {});
      assert.ok(calls.includes('fill') && calls.includes('stroke'), key + ' draws ' + pose);
    }
  }
});
