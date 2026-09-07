import test from 'node:test';
import assert from 'node:assert/strict';

const {
  anchorToStage,
  createSpriteLibrary,
  isSheetKey,
  normalizeSpriteManifest,
  placeSpriteFrame,
  selectSpriteFrames,
  spriteKeysFor,
} = await import('../public/js/combat-sprites.mjs');

function manifest(overrides = {}) {
  return {
    version: 1,
    kind: 'humanoid',
    image: '/assets/sprites/humanoid.png',
    frameWidth: 256,
    frameHeight: 256,
    unit: 64,
    anchor: { x: 128, y: 232 },
    facing: 'right',
    frames: {
      idle: { x: 0, y: 0, anchors: { head: { x: 128, y: 60, r: 20 }, hand: { x: 150, y: 150 } } },
      strike: { x: 256, y: 0 },
      windup: { x: 512, y: 0 },
      bogus: { x: 768, y: 0 },
    },
    ...overrides,
  };
}

test('manifest normalization keeps known poses and rejects unusable files', () => {
  const sheet = normalizeSpriteManifest(manifest(), 'humanoid');
  assert.ok(sheet);
  assert.deepEqual(Object.keys(sheet.frames).sort(), ['idle', 'strike', 'windup']);
  assert.equal(sheet.facing, 1);
  assert.equal(sheet.rigAligned, true);
  assert.deepEqual(sheet.frames.idle.anchors.head, { x: 128, y: 60, r: 20 });
  assert.equal(normalizeSpriteManifest(manifest({ version: 2 }), 'humanoid'), null, 'unknown version');
  assert.equal(normalizeSpriteManifest(manifest({ kind: 'beast' }), 'humanoid'), null, 'kind mismatch');
  assert.equal(normalizeSpriteManifest(manifest({ frames: { strike: { x: 0, y: 0 } } }), 'humanoid'), null, 'idle is required');
  assert.equal(normalizeSpriteManifest(manifest({ image: 'javascript:alert(1)' }), 'humanoid'), null, 'image must be a path or https URL');
  assert.equal(normalizeSpriteManifest(manifest({ unit: 0 }), 'humanoid'), null);
  assert.equal(normalizeSpriteManifest(null, 'humanoid'), null);
  assert.equal(normalizeSpriteManifest(manifest({ facing: 'left' }), 'humanoid').facing, -1);
  assert.equal(normalizeSpriteManifest(manifest(), 'humanoid').pixelated, false);
  assert.equal(normalizeSpriteManifest(manifest({ pixelated: true }), 'humanoid').pixelated, true);
  assert.equal(normalizeSpriteManifest(manifest({ pixelated: 'yes' }), 'humanoid').pixelated, false, 'only a real true enables it');
  assert.equal(normalizeSpriteManifest(manifest(), 'humanoid').weaponsInArt, false);
  assert.equal(normalizeSpriteManifest(manifest({ weaponsInArt: true }), 'humanoid').weaponsInArt, true);
});

test('frame selection crossfades between the two poses of a phase', () => {
  const sheet = normalizeSpriteManifest(manifest(), 'humanoid');
  assert.deepEqual(selectSpriteFrames(sheet, null).map((f) => [f.name, f.alpha]), [['idle', 1]]);
  const mid = selectSpriteFrames(sheet, { from: 'idle', to: 'strike', t: 0.4 }, 0.4);
  assert.deepEqual(mid.map((f) => [f.name, f.alpha]), [['idle', 1], ['strike', 0.4]]);
  assert.deepEqual(selectSpriteFrames(sheet, { from: 'idle', to: 'strike', t: 1 }, 1).map((f) => f.name), ['strike']);
  assert.deepEqual(selectSpriteFrames(sheet, { from: 'strike', to: 'strike', t: 1 }, 1).map((f) => f.name), ['strike']);
  const missing = selectSpriteFrames(sheet, { from: 'idle', to: 'chop', t: 0.5 }, 0.5);
  assert.deepEqual(missing.map((f) => f.name), ['idle'], 'a pose without a frame keeps the from pose');
});

test('placement lands the ground anchor on the hip and mirrors for left-facing figures', () => {
  const sheet = normalizeSpriteManifest(manifest(), 'humanoid');
  const right = placeSpriteFrame(sheet, 32, 1, 300, 400, 1);
  assert.equal(right.scale, 0.5);
  assert.equal(right.width, 128);
  assert.equal(right.height, 128);
  assert.equal(right.mirrored, false);
  assert.equal(right.x, 300 - 64);
  assert.equal(right.y, 400 - 116);
  const left = placeSpriteFrame(sheet, 32, 1, 300, 400, -1);
  assert.equal(left.mirrored, true);
  assert.equal(left.x + left.width - 64, 300, 'mirrored anchor still sits on the hip');
  const stretched = placeSpriteFrame(sheet, 32, 1, 300, 400, 1, 1.1);
  assert.ok(stretched.height > right.height && stretched.y < right.y, 'stretch grows upward from the ground');

  const headRight = anchorToStage(right, sheet.frames.idle.anchors.head);
  assert.equal(headRight.x, 300);
  assert.equal(headRight.y, right.y + 30);
  assert.equal(headRight.r, 10);
  const handRight = anchorToStage(right, sheet.frames.idle.anchors.hand);
  assert.equal(handRight.x, 300 + 11, 'right hand is ahead of the hip when facing right');
  const handLeft = anchorToStage(left, sheet.frames.idle.anchors.hand);
  assert.equal(handLeft.x, 300 - 11, 'mirrored hand is ahead of the hip when facing left');
});

test('the library loads a sheet once, caches failures, and reports readiness', async () => {
  const requested = [];
  const images = [];
  class FakeImage {
    set src(value) {
      this._src = value;
      images.push(this);
      setTimeout(() => { if (this.onload) this.onload(); }, 0);
    }
    get src() { return this._src; }
  }
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.endsWith('humanoid.json')) return { ok: true, text: async () => JSON.stringify(manifest()), json: async () => manifest() };
    return { ok: false, text: async () => JSON.stringify(null), json: async () => null };
  };
  const ready = [];
  const library = createSpriteLibrary({ fetch: fetchImpl, Image: FakeImage, onReady: (kind) => ready.push(kind) });
  assert.equal(library.get('humanoid'), null, 'not ready synchronously');
  assert.equal(library.status('humanoid'), 'loading');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const entry = library.get('humanoid');
  assert.ok(entry && entry.sheet && entry.image);
  assert.deepEqual(ready, ['humanoid']);
  library.get('humanoid');
  assert.equal(requested.filter((url) => url.endsWith('humanoid.json')).length, 1, 'one manifest request');

  assert.equal(library.get('beast'), null);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(library.status('beast'), 'failed');
  library.get('beast');
  assert.equal(requested.filter((url) => url.endsWith('beast.json')).length, 1, 'failure is cached');
  assert.equal(library.load('../etc'), null, 'keys that are not sheet keys are refused');

  const offline = createSpriteLibrary({});
  assert.equal(offline.get('humanoid'), null);
  assert.equal(offline.status('humanoid'), 'unavailable');
});

test('sheet keys go from character to race to kind, and only for the recipient', () => {
  const figure = { kind: 'humanoid' };
  assert.deepEqual(spriteKeysFor({ name: 'Grash Ironjaw', gender: 'Male', race: 'Scro' }, figure, 'player'),
    ['characters/grash-ironjaw', 'male-scro', 'humanoid']);
  assert.deepEqual(spriteKeysFor({ name: 'Ulf', gender: 'Male', race: 'Northman' }, figure, 'player'),
    ['characters/ulf', 'male-northman', 'male-human', 'humanoid'], 'human cultures fall through to the shared human sheet');
  assert.deepEqual(spriteKeysFor({ name: 'Corwin', gender: 'Male', race: 'Darkwinder' }, figure, 'player'),
    ['characters/corwin', 'male-darkwinder', 'male-human', 'humanoid']);
  assert.deepEqual(spriteKeysFor({ name: 'Esme', gender: 'female', race: 'Desert Nomad' }, figure, 'player'),
    ['characters/esme', 'female-desert-nomad', 'female-human', 'humanoid']);
  assert.deepEqual(spriteKeysFor({ name: 'Tam', gender: 'male', race: 'Wayfarian' }, figure, 'player'),
    ['characters/tam', 'male-wayfarian', 'male-elf', 'humanoid'], 'the elven kinds fall through to the shared elf sheet');
  assert.deepEqual(spriteKeysFor({ name: 'Ola', gender: 'female', race: 'Shel-Zaranite' }, figure, 'player'),
    ['characters/ola', 'female-shel-zaranite', 'female-elf', 'humanoid']);
  assert.deepEqual(spriteKeysFor({ name: 'Borin', gender: 'male', race: 'Rift Duergar' }, figure, 'player'),
    ['characters/borin', 'male-rift-duergar', 'male-dwarf', 'humanoid'], 'the dwarven kinds fall through to the shared dwarf sheet');
  assert.deepEqual(spriteKeysFor({ name: 'Gorbag', gender: 'male', race: 'Uruk' }, figure, 'player'),
    ['characters/gorbag', 'male-uruk', 'male-scro', 'humanoid'], 'Uruk borrow the Scro sheet');
  assert.deepEqual(spriteKeysFor({ name: 'Pip', gender: 'male', race: 'Kender' }, figure, 'player'),
    ['characters/pip', 'male-kender', 'humanoid'], 'a race outside every family gets no family key');
  assert.deepEqual(spriteKeysFor({ name: 'Bryn', race: 'High Elf' }, figure, 'player'),
    ['characters/bryn', 'humanoid'], 'no gender means no race key');
  assert.deepEqual(spriteKeysFor({ name: 'Bryn', gender: 'male', race: 'Scro' }, figure, 'target'),
    ['humanoid'], 'targets only get the body kind');
  assert.deepEqual(spriteKeysFor({ name: 'Bryn', gender: 'male', race: 'Scro', observed: true }, figure, 'player'),
    ['humanoid'], 'an observed fighter never gets identity keys');
  assert.deepEqual(spriteKeysFor({ name: '../../x', gender: '..', race: 'Scro' }, { kind: 'beast' }, 'player'),
    ['characters/x', 'beast'], 'names and races are slugged before becoming keys');
  assert.equal(isSheetKey('characters/grash'), true);
  assert.equal(isSheetKey('male-scro'), true);
  assert.equal(isSheetKey('../etc'), false);
  assert.equal(isSheetKey('characters/'), false);
});

test('a race sheet takes over from the kind sheet once it is ready, and cloak overrides parse', async () => {
  class FakeImage {
    set src(value) { this._src = value; setTimeout(() => { if (this.onload) this.onload(); }, this._src.includes('scro') ? 40 : 0); }
    get src() { return this._src; }
  }
  const fetchImpl = async (url) => {
    if (url.endsWith('humanoid.json')) return { ok: true, text: async () => JSON.stringify(manifest()), json: async () => manifest() };
    if (url.endsWith('male-scro.json')) return { ok: true, text: async () => JSON.stringify(manifest({ image: '/assets/sprites/male-scro.png', cloak: '#4d1414' })), json: async () => manifest({ image: '/assets/sprites/male-scro.png', cloak: '#4d1414' }) };
    if (url.endsWith('characters/grash.json')) return { ok: true, text: async () => JSON.stringify(manifest({ kind: 'dragon' })), json: async () => manifest({ kind: 'dragon' }) };
    return { ok: false, text: async () => JSON.stringify(null), json: async () => null };
  };
  const library = createSpriteLibrary({ fetch: fetchImpl, Image: FakeImage });
  const keys = ['characters/grash', 'male-scro', 'humanoid'];
  assert.equal(library.pick(keys), null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(library.pick(keys).key, 'humanoid', 'kind sheet is ready first');
  await new Promise((resolve) => setTimeout(resolve, 60));
  const picked = library.pick(keys);
  assert.equal(picked.key, 'male-scro', 'the more specific sheet wins once loaded');
  assert.equal(picked.sheet.cloak, '#4d1414');
  assert.equal(library.status('characters/grash'), 'failed', 'a sheet with an unknown body kind is refused');
  assert.equal(normalizeSpriteManifest(manifest({ cloak: false }), 'humanoid').cloak, false);
  assert.equal(normalizeSpriteManifest(manifest({ cloak: 'red' }), 'humanoid').cloak, true, 'non-hex colors are ignored');
});
