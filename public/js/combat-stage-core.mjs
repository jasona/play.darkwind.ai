// Pure scene math for the canvas combat stage. Nothing in this module touches
// the DOM or a drawing context, so the timeline that turns one
// Darkwind.Combat event into token motion, effects, and numbers can be tested
// deterministically in Node. combat-stage.mjs owns the canvas and draws what
// sampleAction() reports for a given moment.

import { getPrimaryTerrain } from './terrain-semantics.mjs';

export const STAGE_SIDES = Object.freeze(['player', 'target']);

// Terrain tiles already shipped for the map double as stage backdrops. Every
// canonical terrain token has a tile, so the lookup is a whitelist rather
// than string concatenation on server text.
const STAGE_BACKDROP_TILES = new Set([
  'arctic', 'barren', 'beach', 'canopy', 'city', 'desert', 'farm', 'forest',
  'hills', 'inside', 'jungle', 'lake', 'mountain', 'outside', 'path',
  'plains', 'river', 'road', 'sea', 'sky', 'swamp', 'underground',
  'underwater',
]);

const RESULT_TINTS = Object.freeze({
  hit: '#f0bd69',
  critical: '#ffd48a',
  miss: '#8fa3b3',
  dodge: '#7ee7df',
  absorb: '#b4abff',
});

export const ACTION_DURATION_MS = 900;

export function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function easeOutCubic(t) {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 3);
}

export function easeInOutQuad(t) {
  const x = clamp01(t);
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

// A lunge goes out fast and settles back: 0 at start, 1 at the apex, 0 at end.
export function lungeCurve(t) {
  const x = clamp01(t);
  if (x < 0.42) return easeOutCubic(x / 0.42);
  return 1 - easeInOutQuad((x - 0.42) / 0.58);
}

export function resultTint(result) {
  return RESULT_TINTS[result] || RESULT_TINTS.hit;
}

// Small deterministic generator so particle bursts are reproducible per
// event sequence. The stage never needs cryptographic randomness.
export function createSeededRandom(seed) {
  let state = (Number(seed) >>> 0) || 0x9e3779b9;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function computeStageLayout(width, height) {
  const w = Math.max(1, Number(width) || 0);
  const h = Math.max(1, Number(height) || 0);
  const radius = Math.max(22, Math.min(w * 0.13, h * 0.3, 120));
  const groundY = h * 0.62;
  return {
    width: w,
    height: h,
    radius,
    groundY,
    player: { x: w * 0.27, y: groundY - radius * 0.1 },
    target: { x: w * 0.73, y: groundY - radius * 0.1 },
    compact: w < 360 || h < 170,
  };
}

export function resolveStageBackdrop(room) {
  const environment = room && typeof room === 'object'
    ? [room.terrain, room.environment, room.env, room.type]
    : room;
  const terrain = getPrimaryTerrain(environment);
  if (!STAGE_BACKDROP_TILES.has(terrain)) return { terrain: 'outside', tile: '/assets/tiles/outside.jpg' };
  return { terrain, tile: '/assets/tiles/' + terrain + '.jpg' };
}

// Which token acts and which absorbs the outcome. Perspective is the
// recipient-safe source of truth; actor ids only matter for observed fights.
export function resolveActionSides(event, view) {
  if (!event) return { actor: '', impact: '' };
  const playerId = view && view.player ? view.player.id : 'self';
  const targetId = view && view.target ? view.target.id : '';
  if (event.perspective === 'outgoing') return { actor: 'player', impact: 'target' };
  if (event.perspective === 'incoming') return { actor: 'target', impact: 'player' };
  let actor = '';
  let impact = '';
  if (event.actorId === playerId) actor = 'player';
  else if (event.actorId === targetId) actor = 'target';
  if (event.targetId === playerId) impact = 'player';
  else if (event.targetId === targetId) impact = 'target';
  if (actor && !impact) impact = actor === 'player' ? 'target' : 'player';
  if (impact && !actor) actor = impact === 'player' ? 'target' : 'player';
  return { actor, impact };
}

function damageValue(event) {
  if (!event) return null;
  if (Object.prototype.hasOwnProperty.call(event, 'damage')) {
    const value = Number(event.damage);
    return Number.isFinite(value) ? Math.round(value) : null;
  }
  return null;
}

function particleBurst(seed, count, spread) {
  const random = createSeededRandom(seed);
  const particles = [];
  for (let i = 0; i < count; i++) {
    const angle = random() * Math.PI * 2;
    const speed = spread * (0.45 + random() * 0.55);
    particles.push({
      angle,
      speed,
      size: 1.5 + random() * 2.5,
      life: 0.55 + random() * 0.45,
    });
  }
  return particles;
}

// Build one self-contained action from an event. The action describes what
// happens over ACTION_DURATION_MS relative to startedAt; sampleAction() turns
// that into concrete offsets for a frame.
export function buildAction(event, view, startedAt = 0) {
  if (!event || !event.result) return null;
  const sides = resolveActionSides(event, view);
  if (!sides.actor || !sides.impact) return null;
  const result = String(event.result);
  const seq = Number(event.seq) || 0;
  const critical = result === 'critical';
  const landed = result === 'hit' || critical;
  const damage = damageValue(event);
  const burstCount = critical ? 26 : (landed ? 14 : 0);
  return {
    seq,
    result,
    perspective: event.perspective || '',
    actorSide: sides.actor,
    impactSide: sides.impact,
    startedAt,
    duration: ACTION_DURATION_MS,
    damage,
    critical,
    landed,
    tint: resultTint(result),
    particles: burstCount ? particleBurst(seq * 7919 + 17, burstCount, critical ? 1.6 : 1) : [],
  };
}

function zeroOffset() {
  return { x: 0, y: 0, scale: 1, alpha: 1, flash: 0 };
}

// Sample an action at absolute time `now`. Offsets are in units of the token
// radius so the drawing layer can scale them to the stage.
export function sampleAction(action, now, options = {}) {
  const reducedMotion = !!options.reducedMotion;
  const player = zeroOffset();
  const target = zeroOffset();
  const empty = {
    active: false,
    progress: 1,
    player,
    target,
    shake: 0,
    flash: 0,
    effects: [],
    number: null,
    badge: null,
  };
  if (!action) return empty;
  const elapsed = now - action.startedAt;
  if (elapsed < 0) return { ...empty, active: true, progress: 0 };
  const progress = clamp01(elapsed / action.duration);
  if (progress >= 1) return empty;

  const offsets = { player, target };
  const actor = offsets[action.actorSide];
  const victim = offsets[action.impactSide];
  const direction = action.actorSide === 'player' ? 1 : -1;
  const effects = [];
  let shake = 0;
  let flash = 0;

  // Timeline in normalized progress: lunge 0-0.36 (contact at 0.16),
  // outcome 0.16-0.7, numbers drift until the end.
  const contactAt = 0.16;
  const afterContact = clamp01((progress - contactAt) / (1 - contactAt));

  if (!reducedMotion) {
    const lunge = lungeCurve(progress / 0.36);
    // The strike pose steps the front foot forward, so the body itself only
    // needs a short lunge to close distance.
    actor.x = direction * lunge * 0.7;
    actor.y = -lunge * 0.18;
    actor.scale = 1 + lunge * 0.04;

    if (action.landed && progress >= contactAt) {
      const recoil = clamp01((progress - contactAt) / 0.34);
      const kick = (1 - easeOutCubic(recoil)) * (action.critical ? 0.55 : 0.32);
      victim.x = direction * kick;
      victim.flash = Math.max(0, 1 - recoil * 1.4);
      victim.scale = 1 - kick * 0.12;
      shake = (action.impactSide === 'player' ? 1 : 0.45)
        * (action.critical ? 1.4 : 1)
        * Math.max(0, 1 - recoil * 1.25);
      flash = action.impactSide === 'player' ? Math.max(0, 1 - recoil * 1.6) : 0;
    } else if (action.result === 'dodge' && progress >= contactAt * 0.6) {
      const t = clamp01((progress - contactAt * 0.6) / 0.5);
      const slip = Math.sin(t * Math.PI);
      // Slip far enough to read as a sidestep but stay inside a narrow pane.
      victim.x = direction * slip * 0.32;
      victim.y = -slip * 0.22;
      victim.alpha = 1 - slip * 0.45;
    } else if (action.result === 'absorb' && progress >= contactAt) {
      const t = clamp01((progress - contactAt) / 0.4);
      victim.scale = 1 + Math.sin(t * Math.PI) * 0.05;
    } else if (action.result === 'miss' && progress >= contactAt) {
      // The victim barely reacts; the whiff arc carries the story.
      victim.x = direction * Math.sin(afterContact * Math.PI) * 0.08;
    }
  }

  if (progress >= contactAt) {
    if (action.landed) {
      effects.push({
        type: 'slash',
        side: action.impactSide,
        direction,
        progress: clamp01((progress - contactAt) / 0.38),
        critical: action.critical,
        tint: action.tint,
      });
      effects.push({
        type: 'burst',
        side: action.impactSide,
        progress: clamp01((progress - contactAt) / 0.5),
        particles: reducedMotion ? [] : action.particles,
        critical: action.critical,
        tint: action.tint,
      });
    } else if (action.result === 'miss') {
      effects.push({
        type: 'whiff',
        side: action.impactSide,
        direction,
        progress: clamp01((progress - contactAt) / 0.42),
        tint: action.tint,
      });
    } else if (action.result === 'dodge') {
      effects.push({
        type: 'ghost',
        side: action.impactSide,
        direction,
        progress: clamp01((progress - contactAt) / 0.5),
        tint: action.tint,
      });
    } else if (action.result === 'absorb') {
      effects.push({
        type: 'shield',
        side: action.impactSide,
        progress: clamp01((progress - contactAt) / 0.55),
        tint: action.tint,
      });
    }
  }

  let number = null;
  if (action.damage !== null && progress >= contactAt) {
    number = {
      side: action.impactSide,
      value: action.damage,
      progress: afterContact,
      rise: reducedMotion ? 0 : easeOutCubic(afterContact) * 1.6,
      alpha: reducedMotion
        ? (afterContact > 0.85 ? 1 - (afterContact - 0.85) / 0.15 : 1)
        : (afterContact < 0.12 ? afterContact / 0.12 : 1 - Math.pow(afterContact, 3)),
      scale: reducedMotion ? 1 : 0.8 + easeOutCubic(Math.min(1, afterContact * 3)) * 0.25,
      critical: action.critical,
      tint: action.tint,
    };
  }

  const badge = progress >= contactAt
    ? {
      side: action.impactSide,
      result: action.result,
      progress: afterContact,
      alpha: afterContact > 0.78 ? 1 - (afterContact - 0.78) / 0.22 : 1,
      tint: action.tint,
    }
    : null;

  return {
    active: true,
    progress,
    player,
    target,
    shake: reducedMotion ? 0 : shake,
    flash: reducedMotion ? 0 : flash,
    effects,
    number,
    badge,
  };
}

// Idle breathing keeps the tokens alive between exchanges without motion
// that competes with an action. Reduced motion pins it flat.
export function idleOffset(side, now, reducedMotion) {
  if (reducedMotion) return { x: 0, y: 0 };
  const phase = side === 'player' ? 0 : Math.PI * 0.7;
  const t = (now / 1000) * Math.PI * 0.9 + phase;
  return { x: 0, y: Math.sin(t) * 0.05 };
}
