import test from 'node:test';
import assert from 'node:assert/strict';

// A small DOM double with the parts the canvas combat stage relies on:
// parent/child tracking (so a stage notices when innerHTML replaced it), a
// 2D context stub that records draw calls, and a controllable frame loop.

const frames = [];
const createdImages = [];

class FakeImage {
  constructor() {
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    createdImages.push(this);
  }
  set src(value) {
    this._src = value;
  }
  get src() {
    return this._src;
  }
  finishLoading() {
    this.naturalWidth = 128;
    this.naturalHeight = 160;
    if (this.onload) this.onload();
  }
  fail() {
    if (this.onerror) this.onerror();
  }
}

function makeContext(log) {
  const gradient = { addColorStop() {} };
  return new Proxy({}, {
    get(target, prop) {
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => gradient;
      if (prop === 'measureText') return () => ({ width: 10 });
      if (typeof prop === 'string') {
        return (...args) => { log.push([prop, args]); };
      }
      return undefined;
    },
    set(target, prop, value) {
      if (prop === 'imageSmoothingEnabled') log.push(['set:imageSmoothingEnabled', [value]]);
      if (prop === 'strokeStyle') log.push(['set:strokeStyle', [value]]);
      return true;
    },
  });
}

function makeElement(tag, doc) {
  const el = {
    tagName: tag,
    ownerDocument: doc,
    parentNode: null,
    children: [],
    attributes: {},
    style: {},
    className: '',
    clientWidth: 640,
    clientHeight: 320,
    _innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {} },
    get isConnected() {
      let node = el;
      while (node) {
        if (node === doc.body) return true;
        node = node.parentNode;
      }
      return false;
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = el.children.indexOf(child);
      if (index >= 0) el.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) { el.attributes[name] = String(value); },
    getAttribute(name) { return el.attributes[name]; },
    removeAttribute(name) { delete el.attributes[name]; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    get innerHTML() { return el._innerHTML; },
    set innerHTML(value) {
      for (const child of el.children) child.parentNode = null;
      el.children = [];
      el._innerHTML = value;
    },
  };
  if (tag === 'canvas') {
    el.drawLog = [];
    el.width = 0;
    el.height = 0;
    el.getContext = (kind) => (kind === '2d' ? makeContext(el.drawLog) : null);
  }
  return el;
}

let fetchManifest = null;
const fakeWindow = {
  devicePixelRatio: 2,
  Image: FakeImage,
  fetch: async (url) => {
    if (fetchManifest && url.endsWith('humanoid.json')) return { ok: true, text: async () => JSON.stringify(fetchManifest), json: async () => fetchManifest };
    return { ok: false, text: async () => JSON.stringify(null), json: async () => null };
  },
  performance: { now: () => 1000 },
  addEventListener() {},
  removeEventListener() {},
  matchMedia() {
    return { matches: false, addEventListener() {}, removeEventListener() {} };
  },
  requestAnimationFrame(callback) {
    frames.push(callback);
    return frames.length;
  },
  cancelAnimationFrame() {},
};

const fakeDocument = {
  hidden: false,
  visibilityState: 'visible',
  defaultView: fakeWindow,
  addEventListener() {},
  removeEventListener() {},
  createElement(tag) { return makeElement(tag, fakeDocument); },
};
fakeDocument.body = makeElement('body', fakeDocument);
fakeDocument.documentElement = makeElement('html', fakeDocument);

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};
globalThis.document = fakeDocument;
globalThis.window = fakeWindow;

const { createCombatStageRenderer } = await import('../public/js/combat-stage-renderer.mjs');

// One renderer per body, the way CombatPanel.svelte mounts one per panel.
const renderers = new WeakMap();
function mountRenderer(body) {
  let renderer = renderers.get(body);
  if (!renderer) {
    renderer = createCombatStageRenderer(body);
    renderers.set(body, renderer);
  }
  return renderer;
}
const {
  createCombatVisualState,
  reduceCombatEvents,
  reduceCombatState,
  takeNextCombatEvent,
} = await import('../public/js/combat-visual-core.mjs');

function bodyElement() {
  const body = makeElement('div', fakeDocument);
  fakeDocument.body.appendChild(body);
  return body;
}

function runFrame(time) {
  const pending = frames.splice(0, frames.length);
  for (const callback of pending) callback(time);
  return pending.length;
}

function combatModel(overrides = {}) {
  return reduceCombatState(createCombatVisualState(), {
    epoch: 'epoch-1',
    encounter_id: 'encounter-1',
    seq: 4,
    visual_enabled: 1,
    effective: 1,
    active: 1,
    current_target_id: 'target-1',
    actors: [
      { id: 'self', name: 'Acer', role: 'self' },
      { id: 'target-1', name: '<script>drake</script>', role: 'target' },
    ],
    summary: 'Combat begins.',
    outcome: '',
    ...overrides,
  });
}

function findCanvas(body) {
  const stack = [...body.children];
  while (stack.length) {
    const node = stack.shift();
    if (node.tagName === 'canvas') return node;
    stack.push(...node.children);
  }
  return null;
}

function deepHtml(el) {
  return el._innerHTML + el.children.map(deepHtml).join('');
}

test('canvas stage renders the DOM overlay with escaped names and accessible health bars', () => {
  const body = bodyElement();
  assert.equal(mountRenderer(body).render({
    model: combatModel(),
    vitals: { hp: 78, maxhp: 100 },
    enemy: { enemy_name: '<script>drake</script>', enemy_curhp: 41, enemy_maxhp: 100, enemy_is_npc: 1, enemy_hp_string: 'bloodied' },
    avatar: { url: 'https://media.example/acer.jpg', name: 'Acer' },
    room: { terrain: 'forest' },
  }), true, 'a supported canvas reports success to the panel');

  const root = body.children[0];
  assert.ok(root, 'root element appended');
  assert.match(root.className, /combat-visual-canvas/);
  assert.match(root.className, /combat-visual-effective/);
  assert.equal(root.getAttribute('aria-label'), 'Visual combat');
  assert.equal(root.getAttribute('data-encounter-id'), 'encounter-1');
  const canvas = findCanvas(body);
  assert.ok(canvas, 'canvas mounted inside the stage');
  assert.equal(canvas.width, 1280, 'canvas is sized for devicePixelRatio 2');
  const html = deepHtml(body);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;drake&lt;\/script&gt;/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="78"/);
  assert.match(html, /aria-valuenow="41"/);
  assert.match(html, /combat-target-condition">bloodied/);
  assert.match(html, /combat-live-region[^>]*>Combat begins\./);
  assert.ok(createdImages.some((img) => img.src === '/assets/tiles/forest.jpg'), 'terrain tile requested');
  assert.ok(createdImages.some((img) => img.src === 'https://media.example/acer.jpg'), 'avatar requested');
});

test('re-rendering reuses the same canvas and plays each event once', () => {
  const body = bodyElement();
  let model = combatModel();
  const render = (nextModel) => mountRenderer(body).render({
    model: nextModel,
    vitals: { hp: 78, maxhp: 100 },
    enemy: { enemy_name: 'a drake', enemy_curhp: 41, enemy_maxhp: 100, enemy_is_npc: 1 },
    avatar: {},
  });
  render(model);
  const canvas = findCanvas(body);
  const stage = mountRenderer(body).stage;
  runFrame(1000);
  const framesBefore = stage.frames;

  model = reduceCombatEvents(model, {
    epoch: 'epoch-1',
    encounter_id: 'encounter-1',
    first_seq: 5,
    last_seq: 5,
    events: [{
      seq: 5, kind: 'attack', perspective: 'outgoing', actor_id: 'self', target_id: 'target-1',
      result: 'critical', damage: 42, summary: 'You critically hit a drake for 42 damage.',
    }],
  });
  model = takeNextCombatEvent(model).state;
  assert.ok(model.currentEvent, 'event is staged');
  render(model);
  assert.equal(findCanvas(body), canvas, 'same canvas survives a re-render');
  assert.equal(stage._actions.length, 1, 'event queued as one action');
  render(model);
  render(model);
  assert.equal(stage._actions.length, 1, 'repeated publishes of the same beat do not replay it');
  assert.match(deepHtml(body), /You critically hit a drake for 42 damage\./);

  runFrame(1100);
  assert.ok(stage.frames > framesBefore, 'a frame was drawn after the event');
  assert.ok(canvas.drawLog.some(([name]) => name === 'fillText' || name === 'strokeText'),
    'damage number drawn on the canvas');
});

test('stage stops when the renderer is disposed and when its element is detached', () => {
  const body = bodyElement();
  mountRenderer(body).render({
    model: combatModel(),
    vitals: { hp: 10, maxhp: 100 },
    enemy: { enemy_name: 'a drake', enemy_curhp: 5, enemy_maxhp: 100, enemy_is_npc: 1 },
    avatar: {},
  });
  const stage = mountRenderer(body).stage;
  assert.equal(stage.running, true);

  // The panel unmounts: the renderer is disposed and the stage with it.
  mountRenderer(body).dispose();
  assert.equal(mountRenderer(body).stage, null);
  assert.equal(stage.destroyed, true);
  assert.equal(stage.running, false);

  // A detached stage stops on its own even if nobody called destroy.
  const other = bodyElement();
  mountRenderer(other).render({
    model: combatModel({ encounter_id: 'encounter-2' }),
    vitals: { hp: 10, maxhp: 100 },
    enemy: { enemy_name: 'a drake', enemy_curhp: 5, enemy_maxhp: 100, enemy_is_npc: 1 },
    avatar: {},
  });
  const second = mountRenderer(other).stage;
  other.innerHTML = '<div class="panel-inactive placeholder">Combat view unavailable</div>';
  assert.equal(second.running, true, 'nothing has told the stage to stop yet');
  runFrame(2000);
  assert.equal(second.running, false, 'loop halts once the element is gone');
  assert.equal(second._rafId, 0, 'no further frame requested by the detached stage');
});

test('image failures fall back to the NPC placeholder without throwing', () => {
  const body = bodyElement();
  createdImages.length = 0;
  mountRenderer(body).render({
    model: combatModel(),
    vitals: { hp: 50, maxhp: 100 },
    enemy: { enemy_name: 'a drake', enemy_image: 'https://media.example/drake.jpg', enemy_curhp: 5, enemy_maxhp: 100, enemy_is_npc: 1 },
    avatar: {},
  });
  const drake = createdImages.find((img) => img.src === 'https://media.example/drake.jpg');
  assert.ok(drake);
  drake.fail();
  assert.ok(createdImages.some((img) => img.src === '/assets/generic-monster.png'),
    'generic monster requested after the generated art fails');
  const stage = mountRenderer(body).stage;
  runFrame(3000);
  assert.ok(stage.frames > 0);
});

test('status descriptor shows under the player name and its portrait loads before the ghost', () => {
  const body = bodyElement();
  createdImages.length = 0;
  mountRenderer(body).render({
    model: combatModel({ encounter_id: 'encounter-status' }),
    vitals: { hp: 50, maxhp: 100 },
    enemy: { enemy_name: 'a drake', enemy_curhp: 5, enemy_maxhp: 100, enemy_is_npc: 1 },
    avatar: {},
    status: { race: 'Stone Dwarf', class: 'Fighter', gender: 'Male' },
  });
  const html = deepHtml(body);
  assert.match(html, /combat-hud-descriptor">Male Stone Dwarf \u00b7 Fighter</);
  assert.ok(createdImages.some((img) => img.src === '/assets/avatars/male-stone-dwarf.png'),
    'bundled race portrait requested');
  assert.ok(!createdImages.some((img) => img.src === '/assets/avatar-ghost.svg'),
    'ghost placeholder is not requested while the bundled portrait is still loading');
  const bundled = createdImages.find((img) => img.src === '/assets/avatars/male-stone-dwarf.png');
  bundled.fail();
  assert.ok(createdImages.some((img) => img.src === '/assets/avatar-ghost.svg'),
    'ghost placeholder requested after the bundled portrait fails');
});

test('inventory equipment reaches the stage figure', () => {
  const body = bodyElement();
  mountRenderer(body).render({
    model: combatModel({ encounter_id: 'encounter-gear' }),
    vitals: { hp: 50, maxhp: 100 },
    enemy: { enemy_name: 'a drake', enemy_curhp: 5, enemy_maxhp: 100, enemy_is_npc: 1 },
    avatar: {},
    status: { race: 'Northman', class: 'Mage', gender: 'Female' },
    inventory: [
      { id: 's1', name: 'a steel sword (main weapon)', attrib: 'l' },
      { id: 'b1', name: 'a round shield (used as shield)', attrib: 'w' },
      { id: 'h1', name: 'an iron helm (worn on head)', attrib: 'w' },
    ],
  });
  const stage = mountRenderer(body).stage;
  const equipment = stage._view.player.equipment;
  assert.equal(equipment.mainHand.kind, 'blade', 'the wielded sword outranks the mage guild staff');
  assert.equal(equipment.shield, true);
  assert.equal(equipment.helmet, true);
  const canvas = findCanvas(body);
  canvas.drawLog.length = 0;
  runFrame(4000);
  // Only the strapped shield rotates the context; ground shadows draw ellipses too.
  assert.ok(canvas.drawLog.some(([name]) => name === 'rotate'), 'shield drawn on the left forearm');
});

test('a humanoid sprite sheet replaces the body and overlays keep drawing', async () => {
  fetchManifest = {
    version: 1,
    kind: 'humanoid',
    image: '/assets/sprites/humanoid.png',
    frameWidth: 256,
    frameHeight: 256,
    unit: 64,
    anchor: { x: 128, y: 232 },
    facing: 'right',
    rigAligned: false,
    frames: {
      idle: { x: 0, y: 0, anchors: { head: { x: 128, y: 60, r: 20 }, hand: { x: 150, y: 150 }, offHand: { x: 100, y: 150 } } },
      strike: { x: 256, y: 0, anchors: { head: { x: 140, y: 64, r: 20 }, hand: { x: 200, y: 120 } } },
    },
  };
  const body = bodyElement();
  createdImages.length = 0;
  mountRenderer(body).render({
    model: combatModel({ encounter_id: 'encounter-sprite' }),
    vitals: { hp: 50, maxhp: 100 },
    enemy: { enemy_name: 'a drake', enemy_curhp: 5, enemy_maxhp: 100, enemy_is_npc: 1 },
    avatar: {},
    status: { race: 'Northman', class: 'Fighter', gender: 'Female' },
    inventory: [{ id: 's1', name: 'a steel sword (main weapon)', attrib: 'l' }, { id: 'b1', name: 'a shield (used as shield)', attrib: 'w' }],
  });
  const stage = mountRenderer(body).stage;
  // The sheet is requested the first time a figure draws, not at render.
  runFrame(4990);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const sheetImage = createdImages.find((img) => img.src.startsWith('/assets/sprites/humanoid.png?v='));
  assert.ok(sheetImage, 'sheet image requested after the manifest loads');
  sheetImage.finishLoading();
  assert.equal(stage._sprites.status('humanoid'), 'ready');
  assert.equal(stage._sprites.status('beast'), 'failed', 'no beast sheet means the beast keeps the rig body');
  const canvas = findCanvas(body);
  canvas.drawLog.length = 0;
  runFrame(5000);
  const spriteDraws = canvas.drawLog.filter(([name, args]) => name === 'drawImage' && args.length === 9);
  assert.ok(spriteDraws.length >= 1, 'sheet frame drawn with a source rectangle');
  assert.ok(canvas.drawLog.some(([name]) => name === 'rotate'), 'shield still drawn over the sprite');
  fetchManifest = null;
});

test('a pixelated sheet is drawn with image smoothing off', async () => {
  fetchManifest = {
    version: 1,
    kind: 'humanoid',
    image: '/assets/sprites/humanoid.png',
    frameWidth: 128,
    frameHeight: 128,
    unit: 32,
    anchor: { x: 64, y: 116 },
    facing: 'right',
    pixelated: true,
    frames: { idle: { x: 0, y: 0 } },
  };
  const body = bodyElement();
  createdImages.length = 0;
  mountRenderer(body).render({
    model: combatModel({ encounter_id: 'encounter-pixel' }),
    vitals: { hp: 50, maxhp: 100 },
    enemy: { enemy_name: 'a drake', enemy_curhp: 5, enemy_maxhp: 100, enemy_is_npc: 1 },
    avatar: {},
  });
  const stage = mountRenderer(body).stage;
  runFrame(6000);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const sheetImage = createdImages.find((img) => img.src.startsWith('/assets/sprites/humanoid.png?v='));
  sheetImage.finishLoading();
  assert.equal(stage._sprites.get('humanoid').sheet.pixelated, true);
  const canvas = findCanvas(body);
  canvas.drawLog.length = 0;
  runFrame(6100);
  const smoothing = canvas.drawLog.filter(([name]) => name === 'set:imageSmoothingEnabled').map(([, args]) => args[0]);
  assert.ok(smoothing.includes(false), 'smoothing turned off for the sheet draw');
  fetchManifest = null;
});

test('a sheet with weapons painted into the art suppresses weapon overlays but keeps the shield', async () => {
  fetchManifest = {
    version: 1,
    kind: 'humanoid',
    image: '/assets/sprites/humanoid.png',
    frameWidth: 256,
    frameHeight: 256,
    unit: 64,
    anchor: { x: 128, y: 232 },
    facing: 'right',
    weaponsInArt: true,
    frames: { idle: { x: 0, y: 0 } },
  };
  const body = bodyElement();
  createdImages.length = 0;
  mountRenderer(body).render({
    model: combatModel({ encounter_id: 'encounter-armed-art' }),
    vitals: { hp: 50, maxhp: 100 },
    enemy: { enemy_name: 'a drake', enemy_curhp: 5, enemy_maxhp: 100, enemy_is_npc: 1 },
    avatar: {},
    inventory: [
      { id: 's1', name: 'a steel sword (main weapon)', attrib: 'l' },
      { id: 'b1', name: 'a round shield (used as shield)', attrib: 'w' },
    ],
  });
  const stage = mountRenderer(body).stage;
  runFrame(7000);
  await new Promise((resolve) => setTimeout(resolve, 5));
  createdImages.find((img) => img.src.startsWith('/assets/sprites/humanoid.png?v=')).finishLoading();
  const canvas = findCanvas(body);
  canvas.drawLog.length = 0;
  runFrame(7100);
  // The sword is drawn with a dashed-free tapered polygon plus a pommel stroke;
  // its crossguard uses a moveTo/lineTo pair after a setLineDash-free path.
  // The cheapest reliable signal: the shield rotates the context, the blade
  // never does, and with weapons in the art the blade's bright edge stroke
  // (a strokeStyle of the highlight white) never appears.
  const strokes = canvas.drawLog.filter(([name]) => name === 'set:strokeStyle').map(([, args]) => args[0]);
  assert.ok(!strokes.includes('rgba(255, 255, 255, 0.7)'), 'no blade edge highlight when weapons are in the art');
  assert.ok(canvas.drawLog.some(([name]) => name === 'rotate'), 'shield still drawn');
  fetchManifest = null;
});

test('without a 2D canvas the DOM card renderer takes over and the contract still holds', () => {
  const body = bodyElement();
  const noCanvasDocument = {
    ...fakeDocument,
    createElement(tag) {
      const el = makeElement(tag, noCanvasDocument);
      if (tag === 'canvas') el.getContext = () => null;
      return el;
    },
  };
  const renderer = createCombatStageRenderer(body, { document: noCanvasDocument });
  assert.equal(renderer.render({
    model: combatModel({ encounter_id: 'encounter-fallback' }),
    vitals: { hp: 30, maxhp: 100 },
    enemy: { enemy_name: 'a drake', enemy_curhp: 5, enemy_maxhp: 100, enemy_is_npc: 1 },
    avatar: {},
  }), true, 'the DOM fallback still counts as a working presentation');
  assert.equal(renderer.stage, null, 'no canvas stage was mounted');
  assert.match(body._innerHTML, /combatant-card combatant-player/);
  assert.match(body._innerHTML, /aria-label="Visual combat"/);
  assert.match(body._innerHTML, /aria-valuenow="30"/);
  renderer.dispose();
  assert.equal(renderer.render({ model: combatModel() }), false, 'a disposed renderer reports failure');
});

test('a room image becomes the stage backdrop and the terrain tile is its fallback', () => {
  const body = bodyElement();
  createdImages.length = 0;
  const renderer = createCombatStageRenderer(body);
  renderer.render({
    model: combatModel({ encounter_id: 'encounter-room-art' }),
    vitals: { hp: 50, maxhp: 100 },
    enemy: { enemy_name: 'a drake', enemy_curhp: 5, enemy_maxhp: 100, enemy_is_npc: 1 },
    avatar: {},
    room: { terrain: 'forest' },
    roomImage: 'https://media.example/clearing.png',
  });
  const art = createdImages.find((img) => img.src === 'https://media.example/clearing.png');
  assert.ok(art, 'the room image is requested');
  assert.ok(!createdImages.some((img) => img.src === '/assets/tiles/forest.jpg'),
    'the tile is not fetched while the art is still the first choice');
  art.fail();
  assert.ok(createdImages.some((img) => img.src === '/assets/tiles/forest.jpg'),
    'the terrain tile is requested once the art fails');
  const canvas = findCanvas(body);
  canvas.drawLog.length = 0;
  runFrame(8000);
  assert.ok(canvas.drawLog.some(([name]) => name === 'fillRect'), 'the backdrop still paints without art');
});

test('between fights the stage is a scene: the player alone in the room, and the opponent pops in when a fight starts', () => {
  const body = bodyElement();
  const renderer = mountRenderer(body);
  const room = { name: 'The Dusty Crossroads', terrain: 'forest' };
  const enemy = { enemy_name: 'a drake', enemy_curhp: 40, enemy_maxhp: 50, enemy_is_npc: 1 };
  assert.equal(renderer.render({
    model: createCombatVisualState(),
    vitals: { hp: 60, maxhp: 100 },
    avatar: { name: 'Acer' },
    room,
  }), true, 'an empty model still renders the scene');
  const root = body.children[0];
  assert.match(root.className, /combat-scene-idle/);
  assert.doesNotMatch(root.className, /combat-visual-syncing/, 'an idle scene is not "synchronizing"');
  let html = deepHtml(body);
  assert.match(html, /combat-scene-room-name">The Dusty Crossroads</);
  assert.match(html, /combat-token-hud-player/);
  assert.match(html, /aria-valuenow="60"/, 'the player keeps a health bar');
  assert.doesNotMatch(html, /combat-token-hud-target/, 'no opponent HUD between fights');
  assert.doesNotMatch(html, /combat-current-event/);
  assert.doesNotMatch(html, /combat-sync-state/);
  assert.deepEqual(renderer.stage.scene, { idle: true, presence: 0 });
  runFrame(500);
  assert.equal(renderer.stage.running, false, 'an idle scene settles to a still frame');

  // A fight begins: the duel HUD returns and the opponent enters over a few frames.
  renderer.render({ model: combatModel(), vitals: { hp: 60, maxhp: 100 }, enemy, avatar: { name: 'Acer' }, room, present: true });
  assert.doesNotMatch(body.children[0].className, /combat-scene-idle/);
  html = deepHtml(body);
  assert.match(html, /combat-token-hud-target/);
  assert.match(html, /combat-current-event/);
  assert.doesNotMatch(html, /combat-scene-room/);
  assert.equal(renderer.stage.scene.idle, false);
  runFrame(1000);
  runFrame(1100);
  const partway = renderer.stage.scene.presence;
  assert.ok(partway > 0 && partway < 1, 'the opponent is still entering: ' + partway);
  for (let t = 1200; t <= 2200; t += 100) runFrame(t);
  assert.equal(renderer.stage.scene.presence, 1, 'fully on stage');

  // The player dismisses the fight: the panel stays, the opponent leaves.
  renderer.render({ model: combatModel(), vitals: { hp: 60, maxhp: 100 }, enemy, avatar: { name: 'Acer' }, room, present: false });
  assert.match(body.children[0].className, /combat-scene-idle/);
  assert.doesNotMatch(deepHtml(body), /combat-token-hud-target/);
  for (let t = 2300; t <= 3300; t += 100) runFrame(t);
  assert.deepEqual(renderer.stage.scene, { idle: true, presence: 0 });

  // A fight that ends leaves its outcome under the scene.
  renderer.render({
    model: combatModel({ active: 0, outcome: 'victory', summary: 'Victory.' }),
    vitals: { hp: 60, maxhp: 100 },
    enemy,
    avatar: { name: 'Acer' },
    room,
    present: false,
  });
  html = deepHtml(body);
  assert.match(body.children[0].className, /combat-scene-idle/);
  assert.match(html, /combat-scene-room-name">The Dusty Crossroads</);
  assert.match(html, /combat-outcome combat-outcome-victory">Victory\./);
  assert.doesNotMatch(html, /combat-token-hud-target/);
});

test('the idle scene acts out looks and walks from the activity feed, but a fight does not', () => {
  const body = bodyElement();
  const renderer = mountRenderer(body);
  const vitals = { hp: 60, maxhp: 100 };
  const room = { name: 'The Long Road', terrain: 'forest' };
  renderer.render({ model: createCombatVisualState(), vitals, avatar: { name: 'Acer' }, room });
  runFrame(100);
  assert.equal(renderer.stage.running, false);

  assert.equal(renderer.playActivity({ kind: 'walk', facing: -1, seq: 1 }), true, 'the idle scene takes a walk');
  assert.equal(renderer.stage.running, true, 'and starts animating');
  runFrame(200);
  runFrame(400);
  const canvas = findCanvas(body);
  assert.ok(canvas.drawLog.length > 0, 'frames draw while the walk plays');
  assert.equal(renderer.stage._sceneActions.length, 1);
  assert.equal(renderer.playActivity({ kind: 'look', seq: 2 }), true, 'a new activity replaces the one in progress');
  assert.equal(renderer.stage._sceneActions[0].kind, 'look');
  // The stage clock is pinned at 1000 in this harness, so the look ends at 2500.
  for (let t = 500; t <= 2600; t += 100) runFrame(t);
  assert.equal(renderer.stage._sceneActions.length, 0, 'the look has played out');
  assert.equal(renderer.stage.running, false, 'and the scene is still again');
  assert.equal(renderer.playActivity({ kind: 'dance', seq: 3 }), false, 'unknown activities are ignored');

  renderer.render({
    model: combatModel(),
    vitals,
    enemy: { enemy_name: 'a drake', enemy_curhp: 40, enemy_maxhp: 50, enemy_is_npc: 1 },
    avatar: { name: 'Acer' },
    room,
    present: true,
  });
  assert.equal(renderer.playActivity({ kind: 'look', seq: 4 }), false, 'a fight owns the figure');
  assert.equal(renderer.stage._sceneActions.length, 0);
});

test('the backdrop is composed once and blitted per frame, and old room paintings are evicted', () => {
  const body = bodyElement();
  const renderer = mountRenderer(body);
  createdImages.length = 0;
  const data = (n) => ({
    model: combatModel({ encounter_id: 'encounter-perf' }),
    vitals: { hp: 50, maxhp: 100 },
    enemy: { enemy_name: 'a drake', enemy_curhp: 5, enemy_maxhp: 100, enemy_is_npc: 1 },
    avatar: {},
    room: { terrain: 'forest' },
    roomImage: 'https://media.example/room-' + n + '.png',
    present: true,
  });
  renderer.render(data(1));
  const art = createdImages.find((img) => img.src === 'https://media.example/room-1.png');
  art.finishLoading();
  const canvas = findCanvas(body);
  canvas.drawLog.length = 0;
  runFrame(1000);
  runFrame(1016);
  runFrame(1032);
  const names = canvas.drawLog.map(([name]) => name);
  assert.equal(names.filter((name) => name === 'createLinearGradient').length, 0,
    'the wash gradient lives in the cached layer, not in every frame');
  assert.ok(names.filter((name) => name === 'drawImage').length >= 1, 'the cached layer is blitted');
  const stage = renderer.stage;
  assert.ok(stage._backdropCache && stage._backdropCache.art === art, 'the layer was composed for the room art');
  const composedFor = stage._backdropCache;
  runFrame(1048);
  assert.equal(stage._backdropCache, composedFor, 'a steady frame reuses the composed layer');

  for (let n = 2; n <= 20; n++) renderer.render(data(n));
  assert.ok(stage._images.size <= 12, 'the image cache stays bounded: ' + stage._images.size);
  assert.ok(stage._images.has('https://media.example/room-20.png'), 'the current room stays');
  assert.ok(!stage._images.has('https://media.example/room-2.png'), 'an old room is gone');
});

test('a resting fight draws every other frame while an exchange draws every frame', () => {
  const body = bodyElement();
  const renderer = mountRenderer(body);
  renderer.render({
    model: combatModel({ encounter_id: 'encounter-rest' }),
    vitals: { hp: 50, maxhp: 100 },
    enemy: { enemy_name: 'a drake', enemy_curhp: 5, enemy_maxhp: 100, enemy_is_npc: 1 },
    avatar: {},
    present: true,
  });
  const stage = renderer.stage;
  // Let the opponent finish entering so the scene is at rest.
  for (let t = 0; t <= 1200; t += 16) runFrame(t);
  const before = stage.frames;
  for (let t = 1216; t <= 1216 + 16 * 20; t += 16) runFrame(t);
  const drawn = stage.frames - before;
  assert.ok(drawn >= 9 && drawn <= 12, 'about half of 21 resting frames are drawn: ' + drawn);
});
