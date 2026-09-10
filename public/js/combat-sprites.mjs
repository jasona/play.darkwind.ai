// Sprite sheets for the combat stage figures.
//
// A sheet replaces the procedural body of one figure kind (humanoid, beast)
// with one image frame per pose name from combat-rig-core.mjs. Weapons,
// shield, helmet, and the portrait head keep drawing on top, so equipment
// and identity still work with any art. See docs/combat-sprites.md for the
// manifest format an artist authors against.
//
// The pure parts (manifest normalization, frame selection, placement math)
// live here so they can be tested without a canvas; the loader takes fetch
// and Image constructors as parameters for the same reason.

import { POSES } from './combat-rig-core.mjs';

export const SPRITE_MANIFEST_VERSION = 1;
export const SPRITE_KINDS = Object.freeze(['humanoid', 'beast']);
// A sheet key is a path fragment under the sprites folder: a body kind
// (`humanoid`), a gender and race pair (`male-scro`), or a character
// (`characters/elyndar`). Only these shapes become URLs.
const SHEET_KEY_PATTERN = /^(?:characters\/)?[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function spriteSlug(value) {
  return String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isSheetKey(key) {
  return typeof key === 'string' && key.length <= 80 && SHEET_KEY_PATTERN.test(key);
}

// Races that share one body and can share one sheet. A race without its own
// sheet falls through to `<gender>-<family>` before the body kind, so one
// painted human serves every human culture, one elf every elven kind, and
// one dwarf every dwarven kind. A family may also be a race whose sheet
// another race borrows: Uruk draw the Scro sheet.
export const SPRITE_RACE_FAMILIES = Object.freeze({
  'barbarian': 'human',
  'darkwinder': 'human',
  'desert-nomad': 'human',
  'glavian': 'human',
  'gypsy': 'human',
  'northman': 'human',
  'souvraeli': 'human',
  'arctic-elf': 'elf',
  'high-elf': 'elf',
  'shel-zaranite': 'elf',
  'silver-elf': 'elf',
  'wayfarian': 'elf',
  'desert-dwarf': 'dwarf',
  'rift-duergar': 'dwarf',
  'stone-dwarf': 'dwarf',
  'uruk': 'scro',
});

export function spriteRaceFamily(race) {
  return SPRITE_RACE_FAMILIES[spriteSlug(race)] || '';
}

// Sheets to try for a figure, most specific first. Only the recipient's
// own token gets name and race keys: an observed fighter or a target has
// no recipient-safe identity beyond its body kind and, for players, the
// name shown in the roster.
export function spriteKeysFor(combatant, figure, side) {
  const keys = [];
  const own = side === 'player' && combatant && !combatant.observed;
  if (own) {
    const name = spriteSlug(combatant.name);
    if (name) keys.push('characters/' + name);
    const gender = spriteSlug(combatant.gender);
    const race = spriteSlug(combatant.race);
    if (gender && race) {
      keys.push(gender + '-' + race);
      const family = spriteRaceFamily(race);
      if (family && family !== race) keys.push(gender + '-' + family);
    }
  }
  if (figure && SPRITE_KINDS.includes(figure.kind)) keys.push(figure.kind);
  return keys.filter(isSheetKey);
}

function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function point(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const out = { x, y };
  if (Number.isFinite(Number(value.r))) out.r = Number(value.r);
  return out;
}

// Validates a manifest object. Returns null when it cannot be used; every
// frame must name a known pose and sit inside the image grid so a bad file
// degrades to the procedural body instead of drawing garbage.
export function normalizeSpriteManifest(raw, kind) {
  if (!raw || typeof raw !== 'object') return null;
  if (finite(raw.version, 0) !== SPRITE_MANIFEST_VERSION) return null;
  if (kind && raw.kind && raw.kind !== kind) return null;
  // Optional cloak override: false hides the stage cloak (the art has its
  // own), a hex color recolors it.
  let cloak = true;
  if (raw.cloak === false) cloak = false;
  else if (typeof raw.cloak === 'string' && /^#[0-9a-f]{6}$/i.test(raw.cloak)) cloak = raw.cloak;
  const frameWidth = finite(raw.frameWidth, 0);
  const frameHeight = finite(raw.frameHeight, 0);
  const unit = finite(raw.unit, 0);
  const anchor = point(raw.anchor);
  const image = typeof raw.image === 'string' ? raw.image.trim() : '';
  if (frameWidth <= 0 || frameHeight <= 0 || unit <= 0 || !anchor || !image) return null;
  if (!/^(\/|https:\/\/)/.test(image)) return null;
  const frames = {};
  const source = raw.frames && typeof raw.frames === 'object' ? raw.frames : {};
  for (const name of Object.keys(source)) {
    if (!(name in POSES)) continue;
    const frame = source[name];
    if (!frame || typeof frame !== 'object') continue;
    const x = finite(frame.x, -1);
    const y = finite(frame.y, -1);
    if (x < 0 || y < 0) continue;
    const anchors = {};
    if (frame.anchors && typeof frame.anchors === 'object') {
      for (const key of ['head', 'neck', 'hand', 'offHand', 'cloak']) {
        const p = point(frame.anchors[key]);
        if (p) anchors[key] = p;
      }
    }
    frames[name] = { x, y, anchors };
  }
  if (!frames.idle) return null;
  return {
    version: SPRITE_MANIFEST_VERSION,
    kind: raw.kind || kind || 'humanoid',
    image,
    frameWidth,
    frameHeight,
    unit,
    anchor,
    facing: raw.facing === 'left' ? -1 : 1,
    rigAligned: raw.rigAligned !== false,
    // Pixel-art sheets are drawn with image smoothing off so scaled pixels
    // stay square instead of blurring.
    pixelated: raw.pixelated === true,
    // The art already shows the character's weapons, so the stage must not
    // draw its own on top.
    weaponsInArt: raw.weaponsInArt === true,
    cloak,
    frames,
  };
}

// Which frames to draw for a pose phase, with alphas. Sparse sheets carry
// one frame per pose, so a blend is a short crossfade between the two.
export function selectSpriteFrames(sheet, phase, easedT) {
  const idle = sheet.frames.idle;
  if (!phase) return [{ frame: idle, name: 'idle', alpha: 1 }];
  // A pose the sheet lacks falls back to the other pose of the blend, and
  // finally to idle; the reported name is the frame actually drawn.
  const fromName = sheet.frames[phase.from] ? phase.from : 'idle';
  const from = sheet.frames[fromName];
  const toName = sheet.frames[phase.to] ? phase.to : fromName;
  const to = sheet.frames[toName];
  const t = Math.max(0, Math.min(1, Number.isFinite(easedT) ? easedT : phase.t));
  if (from === to || t >= 1) return [{ frame: to, name: toName, alpha: 1 }];
  if (t <= 0) return [{ frame: from, name: fromName, alpha: 1 }];
  return [
    { frame: from, name: fromName, alpha: 1 },
    { frame: to, name: toName, alpha: t },
  ];
}

// Destination rectangle for a frame so its ground anchor lands on
// (hipX, groundY) at the figure's scale, mirrored for left-facing figures.
// `stretch` scales vertically about the ground line.
export function placeSpriteFrame(sheet, unit, scale, hipX, groundY, facing, stretch = 1) {
  const s = (unit * scale) / sheet.unit;
  const width = sheet.frameWidth * s;
  const height = sheet.frameHeight * s * stretch;
  const anchorX = sheet.anchor.x * s;
  const anchorY = sheet.anchor.y * s * stretch;
  const mirrored = facing !== sheet.facing;
  return {
    scale: s,
    width,
    height,
    mirrored,
    // Top-left in stage space when not mirrored; when mirrored the caller
    // flips around hipX, so the left edge is measured from the flipped side.
    x: mirrored ? hipX - (width - anchorX) : hipX - anchorX,
    y: groundY - anchorY,
  };
}

// Converts a frame-space anchor (pixels inside one frame, unmirrored) into
// stage space using a placement from placeSpriteFrame().
export function anchorToStage(placement, anchor) {
  const localX = anchor.x * placement.scale;
  const localY = anchor.y * placement.scale;
  const out = {
    x: placement.mirrored
      ? placement.x + placement.width - localX
      : placement.x + localX,
    y: placement.y + localY,
  };
  if (Number.isFinite(anchor.r)) out.r = anchor.r * placement.scale;
  return out;
}

function manifestHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16);
}

// Loads manifests and images on demand. One entry per kind; failures are
// cached so a missing sheet costs one request, not one per frame.
export function createSpriteLibrary(options = {}) {
  const fetchImpl = options.fetch || null;
  const ImageCtor = options.Image || null;
  const basePath = options.basePath || '/assets/sprites/';
  const onReady = typeof options.onReady === 'function' ? options.onReady : () => {};
  const entries = new Map();

  function load(key) {
    if (!isSheetKey(key)) return null;
    if (entries.has(key)) return entries.get(key);
    const entry = { key, status: 'loading', sheet: null, image: null };
    entries.set(key, entry);
    if (!fetchImpl || !ImageCtor) {
      entry.status = 'unavailable';
      return entry;
    }
    let request;
    try {
      // Revalidate the manifest every load; a stale manifest against a new
      // image misplaces every anchor.
      request = fetchImpl(basePath + key + '.json', { cache: 'no-cache' });
    } catch (error) {
      entry.status = 'failed';
      return entry;
    }
    let manifestText = '';
    Promise.resolve(request)
      .then((response) => (response && response.ok ? response.text() : null))
      .then((text) => {
        if (typeof text !== 'string') return null;
        manifestText = text;
        try {
          return JSON.parse(text);
        } catch (error) {
          return null;
        }
      })
      .then((json) => {
        // A character or race sheet must still declare a body kind the
        // rig knows; the key itself does not carry one.
        const sheet = normalizeSpriteManifest(json, SPRITE_KINDS.includes(key) ? key : '');
        if (sheet && !SPRITE_KINDS.includes(sheet.kind)) {
          entry.status = 'failed';
          return;
        }
        if (!sheet) {
          entry.status = 'failed';
          return;
        }
        entry.sheet = sheet;
        const image = new ImageCtor();
        image.decoding = 'async';
        image.onload = () => {
          entry.image = image;
          entry.status = 'ready';
          onReady(key);
        };
        image.onerror = () => {
          entry.status = 'failed';
        };
        // Version the image by the manifest text so a re-baked sheet is never
        // paired with a cached image from the previous bake.
        image.src = sheet.image + (sheet.image.includes('?') ? '&' : '?') + 'v=' + manifestHash(manifestText);
      })
      .catch(() => {
        entry.status = 'failed';
      });
    return entry;
  }

  return {
    load,
    get(key) {
      const entry = load(key);
      return entry && entry.status === 'ready' ? entry : null;
    },
    // First ready sheet in preference order. Every key is requested, so a
    // more specific sheet that is still loading takes over on a later frame.
    pick(keys) {
      let best = null;
      for (const key of keys || []) {
        const entry = load(key);
        if (!best && entry && entry.status === 'ready') best = entry;
      }
      return best;
    },
    status(key) {
      const entry = entries.get(key);
      return entry ? entry.status : 'unloaded';
    },
    clear() {
      entries.clear();
    },
  };
}
