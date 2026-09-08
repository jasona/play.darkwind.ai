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
