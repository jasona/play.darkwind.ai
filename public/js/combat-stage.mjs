// Canvas combat stage. Draws the two combatant tokens, the terrain backdrop,
// and the transient effects that combat-stage-core.mjs samples per frame.
//
// Ownership rules:
// - The renderer keeps one stage per Enemy pane body and calls update() on
//   every publish; the stage never reaches into the model on its own.
// - The stage stops its frame loop when its element leaves the document,
//   when the tab is hidden, or when the encounter is over and no effect is
//   still playing. It never keeps a timer alive for a closed pane.
// - Canvas or 2D-context failures surface as null from createCombatStage()
//   so the renderer can pick the DOM fallback instead of pretending.

import {
  buildAction,
  computeStageLayout,
  idleOffset,
  resolveStageBackdrop,
  sampleAction,
} from './combat-stage-core.mjs';
import {
  MELEE_WEAPONS,
  figureGeometry,
  posePhase,
  poseWeaponFor,
  resolveFigure,
  resolvePose,
} from './combat-rig-core.mjs';
import {
  anchorToStage,
  createSpriteLibrary,
  placeSpriteFrame,
  selectSpriteFrames,
  spriteKeysFor,
} from './combat-sprites.mjs';

const MAX_CONCURRENT_ACTIONS = 3;
// Body unit for the procedural figures, as a fraction of the stage radius.
const FIGURE_UNIT_SCALE = 0.66;
// Freeze both figures for a beat when a blow lands. Criticals hold longer.
const HIT_STOP_MS = 60;
const CRITICAL_HIT_STOP_MS = 95;
const RESULT_BADGES = Object.freeze({
  hit: 'HIT',
  critical: 'CRITICAL',
  miss: 'MISS',
  dodge: 'DODGE',
  absorb: 'ABSORB',
});

function readCssVar(doc, name, fallback) {
  try {
    const root = doc && doc.documentElement;
    const win = doc && doc.defaultView;
    if (!root || !win || typeof win.getComputedStyle !== 'function') return fallback;
    const value = win.getComputedStyle(root).getPropertyValue(name);
    const trimmed = value ? String(value).trim() : '';
    return trimmed || fallback;
  } catch (error) {
    return fallback;
  }
}

export function isCanvasStageSupported(doc) {
  if (!doc || typeof doc.createElement !== 'function') return false;
  try {
    const canvas = doc.createElement('canvas');
    if (!canvas || typeof canvas.getContext !== 'function') return false;
    return !!canvas.getContext('2d');
  } catch (error) {
    return false;
  }
}

function fallbackList(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === 'string' && item);
  return typeof value === 'string' && value ? [value] : [];
}

function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgba(color, alpha) {
  const rgb = hexToRgb(color) || [240, 189, 105];
  return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + Math.max(0, Math.min(1, alpha)) + ')';
}

export function createCombatStage(doc, options = {}) {
  if (!isCanvasStageSupported(doc)) return null;
  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  const raf = options.requestAnimationFrame
    || (win && typeof win.requestAnimationFrame === 'function'
      ? win.requestAnimationFrame.bind(win)
      : null);
  const caf = options.cancelAnimationFrame
    || (win && typeof win.cancelAnimationFrame === 'function'
      ? win.cancelAnimationFrame.bind(win)
      : null);
  if (!raf) return null;
  const now = options.now || (() => (win && win.performance && typeof win.performance.now === 'function'
    ? win.performance.now()
    : Date.now()));
  const ImageCtor = options.Image || (win && win.Image) || (typeof Image !== 'undefined' ? Image : null);
  const fetchImpl = options.fetch
    || (win && typeof win.fetch === 'function' ? win.fetch.bind(win) : null);

  const element = doc.createElement('div');
  element.className = 'combat-stage-canvas-wrap';
  const canvas = doc.createElement('canvas');
  canvas.className = 'combat-stage-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  element.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const stage = {
    element,
    canvas,
    ctx,
    destroyed: false,
    running: false,
    _rafId: 0,
    _width: 0,
    _height: 0,
    _dpr: 1,
    _images: new Map(),
    _actions: [],
    _playedSeqs: new Set(),
    _encounterKey: '',
    _view: null,
    _reducedMotion: false,
    _backdrop: resolveStageBackdrop(null),
    _palette: {
      accent: readCssVar(doc, '--df-accent', '#42d6c9'),
      danger: readCssVar(doc, '--df-err', '#f85149'),
      text: readCssVar(doc, '--df-text', '#e2e9ef'),
      muted: readCssVar(doc, '--df-muted', '#8fa3b3'),
    },
    _resizeObserver: null,
    _visibilityHandler: null,
    _lastFrameAt: 0,
    _hitStop: null,
    _sprites: null,
    _tintCanvas: null,
    _secondaryState: null,
    _lightDir: 1,
    frames: 0,

    update(view, sources = {}) {
      if (this.destroyed || !view) return;
      const key = String(view.epoch || '') + ':' + String(view.encounterId || '');
      if (key !== this._encounterKey) {
        this._encounterKey = key;
        this._actions = [];
        this._playedSeqs.clear();
      }
      this._view = view;
      this._reducedMotion = !!view.reducedMotion;
      this._backdrop = resolveStageBackdrop(sources.room);
      this._ensureImage(this._backdrop.tile, '');
      this._playerFallback = fallbackList(sources.playerFallback);
      this._targetFallback = fallbackList(sources.targetFallback);
      this._ensureImage(view.player.image, this._playerFallback);
      this._ensureImage(view.target.image, this._targetFallback);

      const event = view.event;
      if (event && Number.isFinite(Number(event.seq)) && !this._playedSeqs.has(event.seq)) {
        const action = buildAction(event, view, now());
        if (action) {
          this._playedSeqs.add(event.seq);
          this._actions.push(action);
          if (this._actions.length > MAX_CONCURRENT_ACTIONS) {
            this._actions.splice(0, this._actions.length - MAX_CONCURRENT_ACTIONS);
          }
        }
      }
      if (this._playedSeqs.size > 512) {
        // Sequence numbers only grow; keep the set bounded for long fights.
        const keep = Array.from(this._playedSeqs).slice(-256);
        this._playedSeqs = new Set(keep);
      }
      this._resize();
      this.start();
    },

    start() {
      if (this.destroyed || this.running) return;
      if (doc.hidden) return;
      this.running = true;
      this._rafId = raf((t) => this._tick(t));
    },

    stop() {
      if (this._rafId && caf) caf(this._rafId);
      this._rafId = 0;
      this.running = false;
    },

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.stop();
      if (this._resizeObserver) {
        try { this._resizeObserver.disconnect(); } catch (error) { /* ignore */ }
        this._resizeObserver = null;
      }
      if (this._visibilityHandler && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('visibilitychange', this._visibilityHandler);
        this._visibilityHandler = null;
      }
      if (this._resizeHandler && win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('resize', this._resizeHandler);
        this._resizeHandler = null;
      }
      this._images.clear();
      if (element.parentNode && typeof element.parentNode.removeChild === 'function') {
        element.parentNode.removeChild(element);
      }
    },

    isAttached() {
      if (typeof element.isConnected === 'boolean') return element.isConnected;
      return !!element.parentNode;
    },

    // Loads `url`, then each fallback in turn as earlier candidates fail.
    _ensureImage(url, fallback) {
      const fallbacks = fallbackList(fallback);
      const key = url || fallbacks[0];
      const rest = url ? fallbacks : fallbacks.slice(1);
      if (!key || !ImageCtor || this._images.has(key)) return;
      const entry = { img: null, status: 'loading', fallbacks: rest };
      this._images.set(key, entry);
      try {
        const img = new ImageCtor();
        img.decoding = 'async';
        img.onload = () => {
          entry.status = 'loaded';
          if (!this.running) this.start();
        };
        img.onerror = () => {
          entry.status = 'failed';
          const next = rest.find((candidate) => candidate !== key);
          if (next) this._ensureImage(next, rest.slice(rest.indexOf(next) + 1));
          if (!this.running) this.start();
        };
        img.src = key;
        entry.img = img;
      } catch (error) {
        entry.status = 'failed';
      }
    },

    _imageFor(url, fallback) {
      const candidates = (url ? [url] : []).concat(fallbackList(fallback));
      for (const candidate of candidates) {
        const entry = this._images.get(candidate);
        if (entry && entry.status === 'loaded') return entry.img;
      }
      return null;
    },

    _resize() {
      const parent = element;
      const width = Math.max(1, Math.round(parent.clientWidth || 0));
      const height = Math.max(1, Math.round(parent.clientHeight || 0));
      const dpr = Math.max(1, Math.min(3, (win && win.devicePixelRatio) || 1));
      if (width === this._width && height === this._height && dpr === this._dpr) return;
      this._width = width;
      this._height = height;
      this._dpr = dpr;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = width + 'px';
      canvas.style.height = height + 'px';
    },

    _observe() {
      if (this._resizeObserver || this._resizeHandler) return;
      if (win && typeof win.ResizeObserver === 'function') {
        this._resizeObserver = new win.ResizeObserver(() => {
          this._resize();
          if (!this.running) this.start();
        });
        this._resizeObserver.observe(element);
      } else if (win && typeof win.addEventListener === 'function') {
        this._resizeHandler = () => {
          this._resize();
          if (!this.running) this.start();
        };
        win.addEventListener('resize', this._resizeHandler);
      }
      if (typeof doc.addEventListener === 'function') {
        this._visibilityHandler = () => {
          if (doc.hidden) this.stop();
          else this.start();
        };
        doc.addEventListener('visibilitychange', this._visibilityHandler);
      }
    },

    _tick(timestamp) {
      this._rafId = 0;
      if (this.destroyed) return;
      if (!this.isAttached()) {
        this.running = false;
        return;
      }
      // A collapsed or hidden pane has no size. Stop drawing; the resize
      // observer or the next publish restarts the loop when it comes back.
      if (!(element.clientWidth > 0 && element.clientHeight > 0)) {
        this.running = false;
        return;
      }
      const frameTime = Number.isFinite(timestamp) ? timestamp : now();
      const t = this._reducedMotion ? frameTime : this._applyHitStop(frameTime);
      this._lastFrameAt = t;
      this._actions = this._actions.filter((action) => t - action.startedAt < action.duration);
      this._draw(t);
      this.frames++;
      const view = this._view;
      const keepGoing = this._actions.length > 0
        || (view && view.active && !this._reducedMotion);
      if (keepGoing) {
        this._rafId = raf((next) => this._tick(next));
      } else {
        this.running = false;
      }
    },

    // Returns the effective animation time. While a hit-stop is active the
    // clock holds at the contact instant; when it releases, every action's
    // start shifts forward so playback resumes exactly where it froze.
    _applyHitStop(t) {
      if (this._hitStop) {
        if (t < this._hitStop.until) return this._hitStop.at;
        const shift = t - this._hitStop.at;
        for (const action of this._actions) action.startedAt += shift;
        this._hitStop = null;
        return t;
      }
      for (const action of this._actions) {
        if (!action.landed || action.hitStopped) continue;
        const progress = (t - action.startedAt) / action.duration;
        if (progress < 0.16) continue;
        action.hitStopped = true;
        this._hitStop = { at: t, until: t + (action.critical ? CRITICAL_HIT_STOP_MS : HIT_STOP_MS) };
        return t;
      }
      return t;
    },

    _draw(t) {
      this._resize();
      const w = this._width;
      const h = this._height;
      const layout = computeStageLayout(w, h);
      const view = this._view;
      const reduced = this._reducedMotion;
      const samples = this._actions.map((action) => ({
        ...sampleAction(action, t, { reducedMotion: reduced }),
        action,
      }));
      const c = ctx;
      c.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
      c.clearRect(0, 0, w, h);

      let shake = 0;
      let flash = 0;
      for (const sample of samples) {
        shake = Math.max(shake, sample.shake);
        flash = Math.max(flash, sample.flash);
      }
      const shakeX = shake ? Math.sin(t / 19) * shake * layout.radius * 0.14 : 0;
      const shakeY = shake ? Math.cos(t / 23) * shake * layout.radius * 0.08 : 0;

      c.save();
      c.translate(shakeX, shakeY);
      this._drawBackdrop(c, layout);
      const tokens = this._tokenPositions(layout, samples, t);
      this._drawGround(c, layout, tokens);
      for (const sample of samples) this._drawBackEffects(c, layout, tokens, sample);
      this._drawToken(c, layout, tokens.player, 'player', view.player, samples);
      this._drawToken(c, layout, tokens.target, 'target', view.target, samples);
      for (const sample of samples) this._drawFrontEffects(c, layout, tokens, sample);
      c.restore();

      if (flash > 0) {
        const gradient = c.createLinearGradient(0, 0, w * 0.55, 0);
        gradient.addColorStop(0, rgba(this._palette.danger, 0.42 * flash));
        gradient.addColorStop(1, rgba(this._palette.danger, 0));
        c.fillStyle = gradient;
        c.fillRect(0, 0, w, h);
      }
      if (view && !view.effective) {
        c.fillStyle = 'rgba(3, 7, 11, 0.32)';
        c.fillRect(0, 0, w, h);
      }
    },

    _tokenPositions(layout, samples, t) {
      const positions = {};
      for (const side of ['player', 'target']) {
        const base = layout[side];
        const idle = idleOffset(side, t, this._reducedMotion);
        let x = idle.x;
        let y = idle.y;
        let scale = 1;
        let alpha = 1;
        let flashAmount = 0;
        for (const sample of samples) {
          const offset = sample[side];
          x += offset.x;
          y += offset.y;
          scale *= offset.scale;
          alpha = Math.min(alpha, offset.alpha);
          flashAmount = Math.max(flashAmount, offset.flash);
        }
        positions[side] = {
          x: base.x + x * layout.radius,
          y: base.y + y * layout.radius,
          baseX: base.x,
          baseY: base.y,
          scale,
          alpha,
          flash: flashAmount,
        };
      }
      return positions;
    },

    _drawBackdrop(c, layout) {
      const w = layout.width;
      const h = layout.height;
      const tile = this._imageFor(this._backdrop.tile, '');
      c.fillStyle = '#05090e';
      c.fillRect(-w, -h, w * 3, h * 3);
      if (tile && tile.naturalWidth > 0) {
        const scale = Math.max(w / tile.naturalWidth, h / tile.naturalHeight) * 1.08;
        const drawW = tile.naturalWidth * scale;
        const drawH = tile.naturalHeight * scale;
        c.save();
        c.globalAlpha = 0.55;
        c.drawImage(tile, (w - drawW) / 2, (h - drawH) / 2, drawW, drawH);
        c.restore();
      }
      const wash = c.createLinearGradient(0, 0, 0, h);
      wash.addColorStop(0, 'rgba(4, 9, 14, 0.66)');
      wash.addColorStop(0.5, 'rgba(4, 9, 14, 0.28)');
      wash.addColorStop(1, 'rgba(2, 5, 8, 0.9)');
      c.fillStyle = wash;
      c.fillRect(-w, -h, w * 3, h * 3);
      const vignette = c.createRadialGradient(w / 2, h * 0.5, Math.min(w, h) * 0.25, w / 2, h * 0.5, Math.max(w, h) * 0.75);
      vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
      vignette.addColorStop(1, 'rgba(0, 0, 0, 0.62)');
      c.fillStyle = vignette;
      c.fillRect(-w, -h, w * 3, h * 3);
      // Side tints keep the left/right reading even on a neutral tile.
      const left = c.createRadialGradient(layout.player.x, layout.player.y, 0, layout.player.x, layout.player.y, layout.radius * 3.2);
      left.addColorStop(0, rgba(this._palette.accent, 0.16));
      left.addColorStop(1, rgba(this._palette.accent, 0));
      c.fillStyle = left;
      c.fillRect(0, 0, w, h);
      const right = c.createRadialGradient(layout.target.x, layout.target.y, 0, layout.target.x, layout.target.y, layout.radius * 3.2);
      right.addColorStop(0, rgba(this._palette.danger, 0.14));
      right.addColorStop(1, rgba(this._palette.danger, 0));
      c.fillStyle = right;
      c.fillRect(0, 0, w, h);
    },

    _drawGround(c, layout, tokens) {
      const groundY = layout.groundY + layout.radius * 0.95;
      c.save();
      c.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(0, groundY);
      c.lineTo(layout.width, groundY);
      c.stroke();
      for (const side of ['player', 'target']) {
        const token = tokens[side];
        const lift = Math.max(0, token.baseY - token.y);
        const spread = layout.radius * (0.95 - Math.min(0.35, lift / layout.radius * 0.4));
        c.fillStyle = 'rgba(0, 0, 0, ' + (0.42 * token.alpha) + ')';
        c.beginPath();
        c.ellipse(token.x, groundY, spread, layout.radius * 0.22, 0, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    },

    _drawToken(c, layout, token, side, combatant, samples) {
      const figure = resolveFigure(combatant, side);
      const unit = layout.radius * FIGURE_UNIT_SCALE;
      // Lunge and knockback offsets move the body; vertical offsets lift its
      // ground line. Feet stay planted around the rest position.
      const groundLine = layout.groundY + layout.radius * 0.95 + (token.y - token.baseY);
      let phase = null;
      let isActor = false;
      let smear = null;
      let stretch = 1;
      if (!this._reducedMotion) {
        for (const sample of samples) {
          if (!sample.active || !sample.action) continue;
          const action = sample.action;
          const role = action.actorSide === side
            ? 'actor'
            : (action.impactSide === side ? 'impact' : '');
          if (!role) continue;
          if (role === 'actor' && sample.progress < 0.4) isActor = true;
          const poseWeapon = poseWeaponFor(figure);
          const candidate = posePhase(role, action, sample.progress, poseWeapon);
          if (candidate) phase = candidate;
          // Stretch on the strike snap, squash on the landed hit.
          if (role === 'actor' && candidate && candidate.ease === 'snap' && candidate.t < 1) {
            stretch = Math.max(stretch, 1 + 0.06 * (1 - candidate.t));
            if (MELEE_WEAPONS.includes(poseWeapon)) smear = candidate;
          }
          if (role === 'impact' && action.landed && sample.progress >= 0.16) {
            const since = (sample.progress - 0.16) / 0.12;
            if (since < 1) stretch = Math.min(stretch, 1 - 0.09 * (1 - since));
          }
        }
      }
      const joints = resolvePose(phase, this._lastFrameAt, {
        reducedMotion: this._reducedMotion,
        phaseOffset: side === 'player' ? 0 : 2.1,
      });
      const geo = figureGeometry(figure, joints, token.x, groundLine, unit, {
        baseX: token.baseX,
        stretch,
      });
      const material = this._materials(side, figure);
      const flashMix = token.flash;
      const secondary = this._secondary(side, geo, this._lastFrameAt);

      c.save();
      c.globalAlpha = token.alpha;
      if (flashMix > 0) material.flash = flashMix;
      // A shipped sprite sheet replaces the body; overlays stay procedural
      // and attach to the sheet's anchors (or rig geometry when the sheet
      // was baked from the rig).
      const sprite = this._sprites
        ? this._sprites.pick(spriteKeysFor({ ...combatant, observed: !!(this._view && this._view.observer) }, figure, side))
        : null;
      const weaponsInArt = !!(sprite && sprite.sheet.weaponsInArt);
      let head = geo.head;
      if (sprite) {
        const placed = this._drawSpriteBody(c, sprite, figure, phase, token, groundLine, unit, stretch, flashMix, secondary, geo, material);
        if (placed) {
          head = placed.head || geo.head;
          if (placed.hand) geo.weapon.hand = placed.hand;
          if (placed.offHand) { geo.weapon.offHand = placed.offHand; geo.arms.left.hand = placed.offHand; }
        }
      } else {
        // Far side first: rear leg, cloak or tail, far arm, then torso, near
        // leg, head, near arm, and finally the weapon in the near hand.
        this._drawLeg(c, geo, geo.legs.rear, material, 0.72);
        if (geo.tail) this._drawTail(c, geo, material, secondary);
        if (geo.cloak) this._drawCloak(c, geo, material, secondary);
        this._drawArm(c, geo, geo.arms.left, material, 0.72);
      }
      if (weaponsInArt) {
        // Art carries the weapons; keep the shield since armor is not in the art.
        if (geo.shield) this._drawShieldArm(c, geo, material.ring);
      } else if (figure.weapon === 'bow') this._drawBow(c, geo, geo.weapon);
      else this._drawOffHand(c, geo, material);
      if (!sprite) {
        this._drawTorso(c, geo, material);
        this._drawLeg(c, geo, geo.legs.front, material, 1);
        this._drawNeck(c, geo, material);
      }
      this._drawHead(c, head, side, combatant, material.ring, isActor, flashMix);
      if (geo.helmet) this._drawHelmet(c, head, geo.facing);
      if (!sprite) this._drawArm(c, geo, geo.arms.right, material, 1);
      if (!weaponsInArt && figure.weapon !== 'bow') {
        if (smear) this._drawSmear(c, figure, joints, phase, token, groundLine, unit, material, smear);
        this._drawHeldWeapon(c, geo, geo.weapon.kind, geo.weapon.hand, geo.weapon.dx, geo.weapon.dy, material.ring, geo.twoHanded ? 1.2 : 1, 1);
      }
      c.restore();
    },

    // Draws the sheet frames for the current phase (crossfading a blend),
    // mirrored for left-facing figures, stretched about the ground line, and
    // tinted through an offscreen canvas on a hit flash. Returns the stage
    // positions of the overlay anchors.
    _drawSpriteBody(c, sprite, figure, phase, token, groundLine, unit, stretch, flashMix, secondary, geo, material) {
      const sheet = sprite.sheet;
      const eased = phase ? (phase.ease === 'snap'
        ? 1 - Math.pow(1 - Math.max(0, Math.min(1, phase.t)), 3)
        : (phase.t < 0.5 ? 2 * phase.t * phase.t : 1 - Math.pow(-2 * phase.t + 2, 2) / 2)) : 0;
      const frames = selectSpriteFrames(sheet, phase, eased);
      const placement = placeSpriteFrame(sheet, unit, figure.scale, token.x, groundLine, figure.facing, stretch);
      const draw = (target) => {
        for (const entry of frames) {
          target.save();
          target.imageSmoothingEnabled = !sheet.pixelated;
          target.globalAlpha *= entry.alpha;
          if (placement.mirrored) {
            target.translate(placement.x + placement.width, placement.y);
            target.scale(-1, 1);
            target.drawImage(sprite.image, entry.frame.x, entry.frame.y, sheet.frameWidth, sheet.frameHeight,
              0, 0, placement.width, placement.height);
          } else {
            target.drawImage(sprite.image, entry.frame.x, entry.frame.y, sheet.frameWidth, sheet.frameHeight,
              placement.x, placement.y, placement.width, placement.height);
          }
          target.restore();
        }
      };
      // Cloak and tail are live overlays (spring-lagged), so a baked sheet
      // leaves them out and they draw here behind the body.
      if (geo.tail && sheet.rigAligned) this._drawTail(c, geo, material, secondary);
      if (geo.cloak && sheet.rigAligned && sheet.cloak !== false) {
        this._drawCloak(c, geo, material, secondary, typeof sheet.cloak === 'string' ? sheet.cloak : '');
      }
      if (flashMix > 0 && this._tintCanvas !== false) {
        const tint = this._tintSurface(Math.ceil(placement.width) + 4, Math.ceil(placement.height) + 4);
        if (tint) {
          const tc = tint.getContext('2d');
          tc.setTransform(1, 0, 0, 1, 0, 0);
          tc.clearRect(0, 0, tint.width, tint.height);
          tc.save();
          tc.translate(2 - placement.x, 2 - placement.y);
          draw(tc);
          tc.restore();
          tc.globalCompositeOperation = 'source-atop';
          tc.fillStyle = 'rgba(255, 240, 224, ' + (0.35 + 0.65 * flashMix) + ')';
          tc.fillRect(0, 0, tint.width, tint.height);
          tc.globalCompositeOperation = 'source-over';
          c.drawImage(tint, placement.x - 2, placement.y - 2);
        } else {
          draw(c);
        }
      } else {
        draw(c);
      }
      // Overlay anchors: the target frame's anchors when the art supplies
      // them, otherwise the rig's own geometry (correct for baked sheets).
      const primary = frames[frames.length - 1].frame;
      const result = { head: null, hand: null, offHand: null };
      if (!sheet.rigAligned) {
        if (primary.anchors.head) result.head = anchorToStage(placement, primary.anchors.head);
        if (primary.anchors.hand) result.hand = anchorToStage(placement, primary.anchors.hand);
        if (primary.anchors.offHand) result.offHand = anchorToStage(placement, primary.anchors.offHand);
      }
      return result;
    },

    _tintSurface(width, height) {
      if (this._tintCanvas === false) return null;
      if (!this._tintCanvas) {
        try {
          const surface = doc.createElement('canvas');
          if (!surface || typeof surface.getContext !== 'function' || !surface.getContext('2d')) {
            this._tintCanvas = false;
            return null;
          }
          this._tintCanvas = surface;
        } catch (error) {
          this._tintCanvas = false;
          return null;
        }
      }
      if (this._tintCanvas.width < width || this._tintCanvas.height < height) {
        this._tintCanvas.width = Math.max(this._tintCanvas.width, width);
        this._tintCanvas.height = Math.max(this._tintCanvas.height, height);
      }
      return this._tintCanvas;
    },

    // Palette per side and body kind. Cloth carries the team hue; skin,
    // leather, and metal stay neutral so the team read comes from clothing
    // and the ring, not from painting the whole body.
    _materials(side, figure) {
      const ring = side === 'player' ? this._palette.accent : this._palette.danger;
      if (figure.kind === 'beast') {
        return {
          ring,
          skin: '#6b3126',
          skinShade: '#3f1a14',
          cloth: '#4a2119',
          clothShade: '#2b110c',
          leather: '#3a2418',
          metal: '#9aa3ab',
          outline: '#07090c',
          highlight: 'rgba(255, 214, 190, 0.14)',
          flash: 0,
        };
      }
      return {
        ring,
        skin: '#d3a684',
        skinShade: '#9c6f52',
        cloth: side === 'player' ? '#1e5461' : '#5d2424',
        clothShade: side === 'player' ? '#0f2f37' : '#341212',
        leather: '#5b4630',
        metal: '#b3bcc4',
        outline: '#07090c',
        highlight: 'rgba(255, 255, 255, 0.12)',
        flash: 0,
      };
    },

    // Cloak and tail lag the body by a spring so fast moves leave a trail of
    // motion behind the figure.
    _secondary(side, geo, now) {
      if (!this._secondaryState) this._secondaryState = {};
      let state = this._secondaryState[side];
      if (!state) {
        state = { angle: 0, velocity: 0, lastX: geo.hip.x, lastAt: now };
        this._secondaryState[side] = state;
      }
      const dt = Math.max(1, Math.min(50, now - state.lastAt)) / 1000;
      const dx = geo.hip.x - state.lastX;
      state.lastX = geo.hip.x;
      state.lastAt = now;
      if (this._reducedMotion) {
        state.angle = 0;
        state.velocity = 0;
        return state;
      }
      // Moving toward facing swings the cloth back (negative), and the body
      // lean tilts its rest angle.
      const target = Math.max(-1.1, Math.min(1.1, -(dx / Math.max(1, geo.unit)) * 3.2));
      const accel = (target - state.angle) * 180 - state.velocity * 14;
      state.velocity += accel * dt;
      state.angle += state.velocity * dt;
      return state;
    },

    // Tapered capsule between two joints, with outline, a shade band on the
    // side away from the light (the back), and a rim on the front.
    _capsule(c, a, b, wa, wb, material, fill, shade, depth) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy));
      const nx = -dy / len;
      const ny = dx / len;
      const angle = Math.atan2(dy, dx);
      const path = () => {
        c.beginPath();
        c.arc(a.x, a.y, wa / 2, angle + Math.PI / 2, angle - Math.PI / 2);
        c.lineTo(b.x + nx * wb / 2, b.y + ny * wb / 2);
        c.arc(b.x, b.y, wb / 2, angle - Math.PI / 2, angle + Math.PI / 2);
        c.closePath();
      };
      c.save();
      path();
      c.fillStyle = material.flash > 0 ? this._flashMix(fill, material.flash) : fill;
      c.fill();
      // Shade band clipped to the shape, offset toward the back and down.
      c.save();
      path();
      c.clip();
      const backX = -this._lightDir * (wa + wb) * 0.18;
      c.fillStyle = shade;
      c.globalAlpha = 0.55 * depth;
      c.beginPath();
      c.arc(a.x + backX, a.y + wa * 0.1, wa / 2, angle + Math.PI / 2, angle - Math.PI / 2);
      c.lineTo(b.x + backX + nx * wb / 2, b.y + wb * 0.1 + ny * wb / 2);
      c.arc(b.x + backX, b.y + wb * 0.1, wb / 2, angle - Math.PI / 2, angle + Math.PI / 2);
      c.closePath();
      c.fill();
      c.restore();
      path();
      c.lineWidth = Math.max(1.2, (wa + wb) * 0.06);
      c.strokeStyle = material.outline;
      c.globalAlpha = 0.9 * depth;
      c.stroke();
      c.restore();
    },

    _flashMix(color, amount) {
      return 'rgba(255, 240, 224, ' + Math.min(1, 0.35 + 0.65 * amount) + ')';
    },

    _drawLeg(c, geo, leg, material, depth) {
      const w = geo.widths;
      const dim = depth < 1 ? material.clothShade : material.cloth;
      this._capsule(c, leg.hip, leg.knee, w.thigh, w.thigh * 0.8, material, dim, material.clothShade, depth);
      this._capsule(c, leg.knee, leg.foot, w.shin, w.shin * 0.85, material, dim, material.clothShade, depth);
      // Boot: a wedge from heel to toe pointing toward facing.
      const toe = { x: leg.foot.x + geo.facing * w.foot * 0.75, y: leg.foot.y };
      const heel = { x: leg.foot.x - geo.facing * w.foot * 0.25, y: leg.foot.y };
      c.save();
      c.globalAlpha = depth;
      c.beginPath();
      c.moveTo(heel.x, heel.y - w.shin * 0.45);
      c.lineTo(toe.x, leg.foot.y - w.shin * 0.15);
      c.lineTo(toe.x, leg.foot.y + w.shin * 0.12);
      c.lineTo(heel.x, leg.foot.y + w.shin * 0.12);
      c.closePath();
      c.fillStyle = material.flash > 0 ? this._flashMix(material.leather, material.flash) : material.leather;
      c.fill();
      c.lineWidth = 1.2;
      c.strokeStyle = material.outline;
      c.stroke();
      c.restore();
    },

    _drawArm(c, geo, arm, material, depth) {
      const w = geo.widths;
      const sleeve = depth < 1 ? material.clothShade : material.cloth;
      this._capsule(c, arm.shoulder, arm.elbow, w.upperArm, w.upperArm * 0.8, material, sleeve, material.clothShade, depth);
      const forearm = geo.armor ? material.metal : material.skin;
      const forearmShade = geo.armor ? '#6c757d' : material.skinShade;
      this._capsule(c, arm.elbow, arm.hand, w.forearm, w.forearm * 0.85, material, forearm, forearmShade, depth);
      c.save();
      c.globalAlpha = depth;
      c.beginPath();
      c.arc(arm.hand.x, arm.hand.y, w.hand, 0, Math.PI * 2);
      c.fillStyle = material.flash > 0 ? this._flashMix(material.skin, material.flash) : material.skin;
      c.fill();
      c.lineWidth = 1.2;
      c.strokeStyle = material.outline;
      c.stroke();
      c.restore();
    },

    _drawTorso(c, geo, material) {
      const t = geo.torso;
      const u = geo.unit;
      const path = () => {
        c.beginPath();
        c.moveTo(t.shoulderBack.x, t.shoulderBack.y);
        c.lineTo(t.shoulderFront.x, t.shoulderFront.y);
        c.lineTo(t.hipFront.x + geo.perp.x * u * 0.04, t.hipFront.y + u * 0.12);
        c.lineTo(t.hipBack.x - geo.perp.x * u * 0.04, t.hipBack.y + u * 0.12);
        c.closePath();
      };
      c.save();
      path();
      c.fillStyle = material.flash > 0 ? this._flashMix(material.cloth, material.flash) : material.cloth;
      c.fill();
      c.save();
      path();
      c.clip();
      // Back-side shade and a chest highlight toward the light.
      c.fillStyle = material.clothShade;
      c.globalAlpha = 0.6;
      c.beginPath();
      c.moveTo(t.shoulderBack.x, t.shoulderBack.y);
      c.lineTo(t.shoulderBack.x + (t.shoulderFront.x - t.shoulderBack.x) * 0.38, t.shoulderBack.y + (t.shoulderFront.y - t.shoulderBack.y) * 0.38);
      c.lineTo(t.hipBack.x + (t.hipFront.x - t.hipBack.x) * 0.3, t.hipBack.y + u * 0.12);
      c.lineTo(t.hipBack.x, t.hipBack.y + u * 0.12);
      c.closePath();
      c.fill();
      c.globalAlpha = 1;
      c.fillStyle = material.highlight;
      c.beginPath();
      c.moveTo(t.shoulderFront.x - geo.perp.x * u * 0.14, t.shoulderFront.y + u * 0.08);
      c.lineTo(t.shoulderFront.x - geo.perp.x * u * 0.02, t.shoulderFront.y + u * 0.14);
      c.lineTo(t.hipFront.x - geo.perp.x * u * 0.02, t.hipFront.y - u * 0.05);
      c.lineTo(t.hipFront.x - geo.perp.x * u * 0.12, t.hipFront.y - u * 0.1);
      c.closePath();
      c.fill();
      if (geo.armor) {
        // Chest plate: a lighter panel over the upper torso with a rim.
        c.fillStyle = material.metal;
        c.globalAlpha = 0.92;
        c.beginPath();
        c.moveTo(t.shoulderBack.x + (t.shoulderFront.x - t.shoulderBack.x) * 0.08, t.shoulderBack.y + u * 0.05);
        c.lineTo(t.shoulderFront.x - (t.shoulderFront.x - t.shoulderBack.x) * 0.08, t.shoulderFront.y + u * 0.05);
        c.lineTo(t.hipFront.x - (t.hipFront.x - t.hipBack.x) * 0.05, t.hipFront.y - u * 0.22);
        c.lineTo(t.hipBack.x + (t.hipFront.x - t.hipBack.x) * 0.05, t.hipBack.y - u * 0.22);
        c.closePath();
        c.fill();
        c.globalAlpha = 0.5;
        c.fillStyle = '#6c757d';
        c.beginPath();
        c.moveTo(t.shoulderBack.x + (t.shoulderFront.x - t.shoulderBack.x) * 0.08, t.shoulderBack.y + u * 0.05);
        c.lineTo(t.shoulderBack.x + (t.shoulderFront.x - t.shoulderBack.x) * 0.4, t.shoulderBack.y + u * 0.05);
        c.lineTo(t.hipBack.x + (t.hipFront.x - t.hipBack.x) * 0.35, t.hipBack.y - u * 0.22);
        c.lineTo(t.hipBack.x + (t.hipFront.x - t.hipBack.x) * 0.05, t.hipBack.y - u * 0.22);
        c.closePath();
        c.fill();
      }
      c.restore();
      // Belt.
      c.lineWidth = Math.max(2, u * 0.07);
      c.strokeStyle = material.leather;
      c.beginPath();
      c.moveTo(t.hipBack.x - geo.perp.x * u * 0.03, t.hipBack.y + u * 0.02);
      c.lineTo(t.hipFront.x + geo.perp.x * u * 0.03, t.hipFront.y + u * 0.02);
      c.stroke();
      path();
      c.lineWidth = Math.max(1.4, u * 0.035);
      c.strokeStyle = material.outline;
      c.stroke();
      if (geo.armor) {
        // Pauldron on the near shoulder.
        c.fillStyle = material.metal;
        c.beginPath();
        c.arc(geo.arms.right.shoulder.x, geo.arms.right.shoulder.y - u * 0.02, geo.widths.upperArm * 0.85, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = material.outline;
        c.lineWidth = 1.4;
        c.stroke();
      }
      c.restore();
    },

    _drawNeck(c, geo, material) {
      const w = geo.widths.forearm * 0.9;
      this._capsule(c, geo.shoulder, geo.neck, w, w * 0.9, material, material.skin, material.skinShade, 1);
    },

    _drawCloak(c, geo, material, secondary, fillOverride = '') {
      const u = geo.unit;
      const t = geo.torso;
      const swing = secondary.angle;
      const top = { x: t.shoulderBack.x + geo.perp.x * u * 0.02, y: t.shoulderBack.y + u * 0.02 };
      const length = u * 1.15;
      // Hem swings behind the body when it moves forward.
      const hemX = top.x - geo.facing * (u * 0.28 + Math.max(0, -swing) * u * 0.9) + geo.facing * Math.max(0, swing) * u * 0.4;
      const hemY = top.y + length * (1 - Math.abs(swing) * 0.25);
      const midX = top.x - geo.facing * (u * 0.12 + Math.max(0, -swing) * u * 0.35);
      c.save();
      c.beginPath();
      c.moveTo(top.x, top.y);
      c.lineTo(t.shoulderFront.x - geo.perp.x * u * 0.12, t.shoulderFront.y + u * 0.02);
      c.quadraticCurveTo(midX + geo.facing * u * 0.35, top.y + length * 0.55, hemX + geo.facing * u * 0.42, hemY - u * 0.05);
      c.lineTo(hemX, hemY);
      c.quadraticCurveTo(midX, top.y + length * 0.5, top.x, top.y);
      c.closePath();
      c.fillStyle = fillOverride || material.clothShade;
      c.fill();
      c.lineWidth = 1.3;
      c.strokeStyle = material.outline;
      c.globalAlpha = 0.8;
      c.stroke();
      c.restore();
    },

    _drawTail(c, geo, material, secondary) {
      const u = geo.unit;
      const base = { x: geo.torso.hipBack.x, y: geo.torso.hipBack.y + u * 0.05 };
      const swing = secondary.angle;
      const tipX = base.x - geo.facing * u * (1.0 + Math.max(0, -swing) * 0.5);
      const tipY = base.y + u * (0.15 - swing * 0.35);
      const ctrlX = base.x - geo.facing * u * 0.5;
      const ctrlY = base.y - u * (0.35 + swing * 0.3);
      c.save();
      c.lineCap = 'round';
      c.lineWidth = geo.widths.thigh * 0.75;
      c.strokeStyle = material.outline;
      c.beginPath();
      c.moveTo(base.x, base.y);
      c.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY);
      c.stroke();
      c.lineWidth = geo.widths.thigh * 0.55;
      c.strokeStyle = material.flash > 0 ? this._flashMix(material.skin, material.flash) : material.skin;
      c.stroke();
      c.restore();
    },

    // Ghost copies of the weapon along the strike blend, drawn behind the
    // real one, so a fast swing reads as an arc rather than a jump.
    _drawSmear(c, figure, joints, phase, token, groundLine, unit, material, smear) {
      const steps = [0.35, 0.7];
      c.save();
      for (const fraction of steps) {
        const ghostT = smear.t * fraction;
        const ghostJoints = resolvePose({ ...smear, t: ghostT }, this._lastFrameAt, { reducedMotion: false });
        const ghost = figureGeometry(figure, ghostJoints, token.x, groundLine, unit, { baseX: token.baseX });
        c.globalAlpha = 0.12 + fraction * 0.16;
        this._drawHeldWeapon(c, ghost, ghost.weapon.kind, ghost.weapon.hand, ghost.weapon.dx, ghost.weapon.dy, material.ring, ghost.twoHanded ? 1.2 : 1, 0.6);
      }
      c.restore();
      void joints;
      void phase;
    },

    _drawOffHand(c, geo, material) {
      const w = geo.weapon;
      if (geo.shield) this._drawShieldArm(c, geo, material.ring);
      else if (w.offKind && w.offKind !== 'bow') {
        this._drawHeldWeapon(c, geo, w.offKind, w.offHand, w.offDx, w.offDy, material.ring, 0.85, 0.75);
      }
    },

    // One-handed weapon shapes, all drawn from the hand along (dx, dy).
    _drawHeldWeapon(c, geo, kind, hand, dx, dy, ringColor, size, depth) {
      const u = geo.unit * size;
      const tip = (length) => ({ x: hand.x + dx * u * length, y: hand.y + dy * u * length });
      const across = (point, length) => ({ x: point.x - dy * u * length, y: point.y + dx * u * length });
      const outline = '#07090c';
      c.save();
      c.lineCap = 'round';
      c.lineJoin = 'round';
      c.globalAlpha *= depth;
      if (kind === 'blade' || kind === 'knife' || kind === 'rapier') {
        const length = kind === 'knife' ? 0.55 : (kind === 'rapier' ? 1.3 : 1.2);
        const width = u * (kind === 'knife' ? 0.09 : (kind === 'rapier' ? 0.06 : 0.13));
        const end = tip(length);
        const base = tip(0.08);
        // Blade as a tapered polygon with a bright edge.
        c.beginPath();
        c.moveTo(base.x - dy * width / 2 * -1, base.y + dx * width / 2 * -1);
        c.lineTo(base.x - dy * width / 2, base.y + dx * width / 2);
        c.lineTo(end.x, end.y);
        c.closePath();
        c.fillStyle = '#d9dee3';
        c.fill();
        c.lineWidth = 1.2;
        c.strokeStyle = outline;
        c.stroke();
        c.beginPath();
        c.moveTo(base.x, base.y);
        c.lineTo(end.x, end.y);
        c.lineWidth = Math.max(1, width * 0.25);
        c.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        c.stroke();
        if (kind === 'rapier') {
          // Cup hilt: a swept guard bowl around the hand.
          const bowl = tip(0.12);
          c.fillStyle = '#b8903a';
          c.beginPath();
          c.arc(bowl.x, bowl.y, u * 0.16, Math.atan2(dy, dx) + Math.PI * 0.5, Math.atan2(dy, dx) + Math.PI * 1.5);
          c.closePath();
          c.fill();
          c.lineWidth = 1.2;
          c.strokeStyle = outline;
          c.stroke();
        } else {
          // Crossguard and grip.
          const guardA = across(hand, 0.2);
          const guardB = across(hand, -0.2);
          c.lineWidth = Math.max(2.5, u * 0.08);
          c.strokeStyle = '#8a6a3c';
          c.beginPath();
          c.moveTo(guardA.x, guardA.y);
          c.lineTo(guardB.x, guardB.y);
          c.stroke();
        }
        const pommel = tip(-0.22);
        c.strokeStyle = '#3d2c1b';
        c.lineWidth = Math.max(2.5, u * 0.09);
        c.beginPath();
        c.moveTo(hand.x, hand.y);
        c.lineTo(pommel.x, pommel.y);
        c.stroke();
      } else if (kind === 'axe' || kind === 'blunt') {
        c.lineWidth = Math.max(3, u * 0.1);
        c.strokeStyle = '#6d5232';
        const butt = tip(-0.25);
        const end = tip(kind === 'axe' ? 0.95 : 0.85);
        c.beginPath();
        c.moveTo(butt.x, butt.y);
        c.lineTo(end.x, end.y);
        c.stroke();
        c.fillStyle = '#c9ced4';
        c.strokeStyle = outline;
        c.lineWidth = 1.2;
        if (kind === 'axe') {
          const neck = tip(0.7);
          const edgeA = across(tip(1.02), 0.4);
          const edgeB = across(tip(0.45), 0.34);
          const edgeMid = across(tip(0.74), 0.5);
          c.beginPath();
          c.moveTo(neck.x, neck.y);
          c.lineTo(edgeB.x, edgeB.y);
          c.quadraticCurveTo(edgeMid.x, edgeMid.y, edgeA.x, edgeA.y);
          c.closePath();
          c.fill();
          c.stroke();
        } else {
          const head = tip(0.85);
          c.beginPath();
          c.arc(head.x, head.y, u * 0.19, 0, Math.PI * 2);
          c.fill();
          c.stroke();
          c.fillStyle = '#eef2f5';
          c.beginPath();
          c.arc(head.x - u * 0.05, head.y - u * 0.06, u * 0.06, 0, Math.PI * 2);
          c.fill();
        }
      } else if (kind === 'polearm') {
        c.lineWidth = Math.max(3, u * 0.08);
        c.strokeStyle = '#6d5232';
        const butt = tip(-0.75);
        const neck = tip(1.35);
        c.beginPath();
        c.moveTo(butt.x, butt.y);
        c.lineTo(neck.x, neck.y);
        c.stroke();
        c.fillStyle = '#d9dee3';
        c.strokeStyle = outline;
        c.lineWidth = 1.2;
        const point = tip(1.8);
        const barbA = across(neck, 0.14);
        const barbB = across(neck, -0.14);
        c.beginPath();
        c.moveTo(point.x, point.y);
        c.lineTo(barbA.x, barbA.y);
        c.lineTo(barbB.x, barbB.y);
        c.closePath();
        c.fill();
        c.stroke();
      } else if (kind === 'staff') {
        // The head of the staff sits opposite the grip direction, so a hand
        // holding it pointed down carries the head above the shoulder at rest.
        c.lineWidth = Math.max(3, u * 0.09);
        c.strokeStyle = '#7a5a34';
        const butt = tip(0.75);
        const top = tip(-1.0);
        c.beginPath();
        c.moveTo(butt.x, butt.y);
        c.lineTo(top.x, top.y);
        c.stroke();
        c.lineWidth = 1.2;
        c.strokeStyle = outline;
        c.stroke();
        if (geo.caster) {
          c.fillStyle = rgba(ringColor, 0.95);
          c.shadowColor = rgba(ringColor, 0.9);
          c.shadowBlur = u * 0.35;
          c.beginPath();
          c.arc(top.x, top.y, u * 0.14, 0, Math.PI * 2);
          c.fill();
        } else {
          // A fighting staff: iron-shod ends instead of an orb.
          c.lineWidth = Math.max(2, u * 0.05);
          c.strokeStyle = '#b3bcc4';
          for (const end of [top, butt]) {
            const inner = { x: end.x + (hand.x - end.x) * 0.12, y: end.y + (hand.y - end.y) * 0.12 };
            c.beginPath();
            c.moveTo(end.x, end.y);
            c.lineTo(inner.x, inner.y);
            c.stroke();
          }
        }
      } else {
        // Claws or bare hands.
        c.lineWidth = Math.max(1.5, u * 0.05);
        c.strokeStyle = '#e8e0d0';
        for (let i = -1; i <= 1; i++) {
          const angle = Math.atan2(dy, dx) + i * 0.32;
          c.beginPath();
          c.moveTo(hand.x, hand.y);
          c.lineTo(hand.x + Math.cos(angle) * u * 0.34, hand.y + Math.sin(angle) * u * 0.34);
          c.stroke();
        }
      }
      c.restore();
    },

    _drawBow(c, geo, w) {
      const u = geo.unit;
      const cx = w.offHand.x;
      const cy = w.offHand.y;
      const r = u * 0.8;
      c.save();
      c.lineCap = 'round';
      c.lineWidth = Math.max(3, u * 0.09);
      c.strokeStyle = '#07090c';
      c.beginPath();
      c.arc(cx, cy, r, -Math.PI / 2 + (geo.facing > 0 ? 0 : Math.PI), Math.PI / 2 + (geo.facing > 0 ? 0 : Math.PI), geo.facing < 0);
      c.stroke();
      c.lineWidth = Math.max(2, u * 0.06);
      c.strokeStyle = '#a07a45';
      c.stroke();
      c.lineWidth = 1;
      c.strokeStyle = 'rgba(230, 230, 230, 0.75)';
      c.beginPath();
      c.moveTo(cx, cy - r);
      c.lineTo(w.hand.x, w.hand.y);
      c.lineTo(cx, cy + r);
      c.stroke();
      c.restore();
    },

    // Shield strapped to the left forearm, following its angle.
    _drawShieldArm(c, geo, ringColor) {
      const u = geo.unit;
      const arm = geo.arms.left;
      const angle = Math.atan2(arm.hand.y - arm.elbow.y, arm.hand.x - arm.elbow.x);
      const cx = (arm.hand.x + arm.elbow.x) / 2;
      const cy = (arm.hand.y + arm.elbow.y) / 2;
      c.save();
      c.translate(cx, cy);
      c.rotate(angle);
      c.fillStyle = '#2f353c';
      c.strokeStyle = '#07090c';
      c.lineWidth = 1.5;
      c.beginPath();
      c.ellipse(0, 0, u * 0.52, u * 0.38, 0, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      c.strokeStyle = rgba(ringColor, 0.9);
      c.lineWidth = Math.max(2, u * 0.06);
      c.beginPath();
      c.ellipse(0, 0, u * 0.42, u * 0.29, 0, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = '#b3bcc4';
      c.beginPath();
      c.arc(0, 0, u * 0.11, 0, Math.PI * 2);
      c.fill();
      c.restore();
    },

    // Helmet cap over the portrait disc.
    _drawHelmet(c, head, facing) {
      const r = head.r;
      c.save();
      c.lineCap = 'round';
      c.lineWidth = Math.max(4, r * 0.3);
      c.strokeStyle = '#07090c';
      c.beginPath();
      c.arc(head.x, head.y, r * 1.02, Math.PI * 1.1, Math.PI * 1.9);
      c.stroke();
      c.lineWidth = Math.max(3, r * 0.22);
      c.strokeStyle = '#b3bcc4';
      c.stroke();
      c.lineWidth = Math.max(2, r * 0.1);
      c.beginPath();
      c.moveTo(head.x + facing * r * 0.05, head.y - r * 0.95);
      c.lineTo(head.x + facing * r * 0.05, head.y - r * 0.35);
      c.stroke();
      c.restore();
    },

    _drawHead(c, head, side, combatant, ringColor, isActor, flashMix) {
      const radius = head.r;
      const fallback = side === 'player' ? this._playerFallback : this._targetFallback;
      const img = this._imageFor(combatant.image, fallback);
      const x = head.x;
      const y = head.y;
      c.save();
      const glow = c.createRadialGradient(x, y, radius * 0.7, x, y, radius * 1.6);
      glow.addColorStop(0, rgba(ringColor, isActor ? 0.34 : 0.16));
      glow.addColorStop(1, rgba(ringColor, 0));
      c.fillStyle = glow;
      c.beginPath();
      c.arc(x, y, radius * 1.6, 0, Math.PI * 2);
      c.fill();

      c.save();
      c.beginPath();
      c.arc(x, y, radius, 0, Math.PI * 2);
      c.closePath();
      c.clip();
      c.fillStyle = side === 'player' ? '#07131a' : '#180d0b';
      c.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      if (img && img.naturalWidth > 0) {
        const scale = Math.max((radius * 2) / img.naturalWidth, (radius * 2) / img.naturalHeight);
        const drawW = img.naturalWidth * scale;
        const drawH = img.naturalHeight * scale;
        c.drawImage(img, x - drawW / 2, y - radius - (drawH - radius * 2) * 0.3, drawW, drawH);
      } else {
        this._drawSilhouette(c, { x, y }, radius, combatant, ringColor);
      }
      if (flashMix > 0) {
        c.fillStyle = 'rgba(255, 244, 230, ' + (0.42 * flashMix) + ')';
        c.fillRect(x - radius, y - radius, radius * 2, radius * 2);
      }
      c.restore();

      c.lineWidth = Math.max(2, radius * 0.1);
      c.strokeStyle = rgba(ringColor, 0.95);
      c.shadowColor = rgba(ringColor, 0.7);
      c.shadowBlur = isActor ? radius * 0.4 : radius * 0.15;
      c.beginPath();
      c.arc(x, y, radius, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    },

    _drawProjectile(c, layout, tokens, sample) {
      const action = sample.action;
      if (!action || action.result === 'absorb') return;
      const actorView = this._view && this._view[action.actorSide];
      if (!actorView) return;
      const figure = resolveFigure(actorView, action.actorSide);
      const casts = figure.weapon === 'staff' && figure.caster;
      if (figure.weapon !== 'bow' && !casts) return;
      const start = 0.11;
      const end = 0.17;
      if (sample.progress < start || sample.progress > end) return;
      const t = (sample.progress - start) / (end - start);
      const from = tokens[action.actorSide];
      const to = tokens[action.impactSide];
      const unit = layout.radius * FIGURE_UNIT_SCALE;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y - unit * 0.6 + (to.y - from.y) * t - Math.sin(t * Math.PI) * unit * 0.4;
      const dir = action.actorSide === 'player' ? 1 : -1;
      c.save();
      if (figure.weapon === 'bow') {
        c.lineWidth = Math.max(1.5, unit * 0.05);
        c.strokeStyle = '#e6d8b8';
        c.beginPath();
        c.moveTo(x - dir * unit * 0.45, y);
        c.lineTo(x + dir * unit * 0.2, y);
        c.stroke();
      } else {
        const tint = action.actorSide === 'player' ? this._palette.accent : this._palette.danger;
        c.fillStyle = rgba(tint, 0.95);
        c.shadowColor = rgba(tint, 0.9);
        c.shadowBlur = unit * 0.5;
        c.beginPath();
        c.arc(x, y, unit * 0.16, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    },

    _drawSilhouette(c, token, radius, combatant, ringColor) {
      const initial = (combatant && combatant.name ? String(combatant.name).trim() : '')
        .replace(/^(an?|the)\s+/i, '')
        .charAt(0)
        .toUpperCase() || '?';
      // Head and shoulders shape so an unloaded portrait still reads as a body.
      c.fillStyle = rgba(ringColor, 0.22);
      c.beginPath();
      c.arc(token.x, token.y - radius * 0.22, radius * 0.34, 0, Math.PI * 2);
      c.fill();
      c.beginPath();
      c.ellipse(token.x, token.y + radius * 0.62, radius * 0.72, radius * 0.5, 0, Math.PI, Math.PI * 2);
      c.fill();
      c.fillStyle = rgba(this._palette.text, 0.9);
      c.font = '700 ' + Math.round(radius * 0.62) + 'px "Segoe UI", system-ui, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(initial, token.x, token.y + radius * 0.02);
    },

    _drawBackEffects(c, layout, tokens, sample) {
      for (const effect of sample.effects) {
        if (effect.type === 'ghost') this._drawGhost(c, layout, tokens[effect.side], effect);
      }
    },

    _drawFrontEffects(c, layout, tokens, sample) {
      this._drawProjectile(c, layout, tokens, sample);
      for (const effect of sample.effects) {
        const token = tokens[effect.side];
        if (effect.type === 'slash') this._drawSlash(c, layout, token, effect);
        else if (effect.type === 'burst') this._drawBurst(c, layout, token, effect);
        else if (effect.type === 'whiff') this._drawWhiff(c, layout, token, effect);
        else if (effect.type === 'shield') this._drawShield(c, layout, token, effect);
      }
      if (sample.badge) this._drawBadge(c, layout, tokens[sample.badge.side], sample.badge, sample.number);
      if (sample.number) this._drawNumber(c, layout, tokens[sample.number.side], sample.number);
    },

    _drawSlash(c, layout, token, effect) {
      const p = effect.progress;
      if (p >= 1) return;
      const radius = layout.radius;
      const alpha = p < 0.2 ? p / 0.2 : 1 - (p - 0.2) / 0.8;
      const arcs = effect.critical ? 3 : 2;
      c.save();
      c.globalAlpha = Math.max(0, alpha);
      c.lineCap = 'round';
      for (let i = 0; i < arcs; i++) {
        const spread = (i - (arcs - 1) / 2) * radius * 0.42;
        const angle = -0.9 * effect.direction + i * 0.18;
        const sweepStart = angle - 0.7 - p * 0.9;
        const sweepEnd = angle + 0.7 - p * 0.9;
        c.lineWidth = Math.max(2, radius * (effect.critical ? 0.09 : 0.06)) * (1 - p * 0.5);
        c.strokeStyle = rgba(effect.tint, 0.95);
        c.shadowColor = rgba(effect.tint, 0.8);
        c.shadowBlur = radius * 0.3;
        c.beginPath();
        c.arc(token.x + spread * 0.4, token.y - spread * 0.2, radius * (0.75 + i * 0.22), sweepStart, sweepEnd);
        c.stroke();
      }
      c.restore();
    },

    _drawBurst(c, layout, token, effect) {
      const p = effect.progress;
      if (p >= 1) return;
      const radius = layout.radius;
      c.save();
      const ringAlpha = Math.max(0, 1 - p * 1.3);
      c.strokeStyle = rgba(effect.tint, ringAlpha);
      c.lineWidth = Math.max(1, radius * 0.05 * (1 - p));
      c.beginPath();
      c.arc(token.x, token.y, radius * (0.9 + p * (effect.critical ? 1.3 : 0.8)), 0, Math.PI * 2);
      c.stroke();
      // Dust kicked up at the feet.
      const groundLine = layout.groundY + layout.radius * 0.95;
      c.strokeStyle = 'rgba(214, 200, 176, ' + (0.5 * (1 - p)) + ')';
      c.lineWidth = Math.max(1.5, radius * 0.05 * (1 - p * 0.6));
      for (let i = -1; i <= 1; i += 2) {
        const spread = radius * (0.35 + p * 1.1);
        c.beginPath();
        c.arc(token.x + i * spread, groundLine - radius * 0.08 - p * radius * 0.25, radius * (0.12 + p * 0.18), Math.PI * 1.05, Math.PI * 1.95);
        c.stroke();
      }
      if (p < 0.25) {
        c.fillStyle = 'rgba(255, 240, 210, ' + (0.55 * (1 - p / 0.25)) + ')';
        c.beginPath();
        c.arc(token.x, token.y, radius * 0.55 * (1 + p * 2), 0, Math.PI * 2);
        c.fill();
      }
      for (const particle of effect.particles) {
        const life = Math.min(1, p / particle.life);
        if (life >= 1) continue;
        const distance = radius * (0.6 + particle.speed * life * 1.9);
        const x = token.x + Math.cos(particle.angle) * distance;
        const y = token.y + Math.sin(particle.angle) * distance + life * life * radius * 0.5;
        c.fillStyle = rgba(effect.tint, 1 - life);
        c.beginPath();
        c.arc(x, y, particle.size * (1 - life * 0.5), 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    },

    _drawWhiff(c, layout, token, effect) {
      const p = effect.progress;
      if (p >= 1) return;
      const radius = layout.radius;
      const alpha = p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85;
      const travel = (p - 0.5) * radius * 1.4 * effect.direction;
      c.save();
      c.globalAlpha = Math.max(0, alpha * 0.7);
      c.strokeStyle = rgba(effect.tint, 0.9);
      c.lineWidth = Math.max(1.5, radius * 0.04);
      c.lineCap = 'round';
      c.setLineDash([radius * 0.18, radius * 0.12]);
      c.beginPath();
      c.arc(token.x + travel - effect.direction * radius * 0.9, token.y - radius * 0.6, radius * 1.15,
        -0.55 * effect.direction - 0.9, -0.55 * effect.direction + 0.9);
      c.stroke();
      c.restore();
    },

    _drawGhost(c, layout, token, effect) {
      const p = effect.progress;
      if (p >= 1) return;
      const radius = layout.radius;
      c.save();
      c.globalAlpha = Math.max(0, 0.55 * (1 - p));
      c.strokeStyle = rgba(effect.tint, 0.9);
      c.lineWidth = Math.max(1.5, radius * 0.05);
      c.setLineDash([radius * 0.12, radius * 0.1]);
      c.beginPath();
      c.arc(token.baseX, token.baseY, radius * (1 + p * 0.1), 0, Math.PI * 2);
      c.stroke();
      c.restore();
    },

    _drawShield(c, layout, token, effect) {
      const p = effect.progress;
      if (p >= 1) return;
      const radius = layout.radius;
      c.save();
      const bubble = c.createRadialGradient(token.x, token.y, radius * 0.9, token.x, token.y, radius * 1.35);
      bubble.addColorStop(0, rgba(effect.tint, 0));
      bubble.addColorStop(0.8, rgba(effect.tint, 0.28 * (1 - p)));
      bubble.addColorStop(1, rgba(effect.tint, 0));
      c.fillStyle = bubble;
      c.beginPath();
      c.arc(token.x, token.y, radius * 1.35, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = rgba(effect.tint, 0.9 * (1 - p));
      c.lineWidth = Math.max(2, radius * 0.06);
      c.beginPath();
      c.arc(token.x, token.y, radius * (1.12 + p * 0.35), 0, Math.PI * 2);
      c.stroke();
      c.restore();
    },

    _drawBadge(c, layout, token, badge, number) {
      // Landed hits let the number speak; other results get a label.
      if ((badge.result === 'hit' || badge.result === 'critical') && number) return;
      const radius = layout.radius;
      const label = RESULT_BADGES[badge.result] || String(badge.result).toUpperCase();
      c.save();
      c.globalAlpha = Math.max(0, badge.alpha);
      c.font = '700 ' + Math.max(10, Math.round(radius * 0.3)) + 'px "Segoe UI", system-ui, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      // Badges sit at chest height, like the damage numbers, so a hop never
      // pushes them into the DOM health overlay above the stage.
      const y = token.y + radius * 0.1;
      c.lineWidth = 4;
      c.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      c.strokeText(label, token.x, y);
      c.fillStyle = badge.tint;
      c.fillText(label, token.x, y);
      c.restore();
    },

    _drawNumber(c, layout, token, number) {
      const radius = layout.radius;
      const size = Math.max(14, Math.round(radius * (number.critical ? 0.62 : 0.5) * number.scale));
      // Numbers start near the token's heart and rise to its crown. Keeping
      // them inside the token's own footprint stops them from crossing the
      // health bars in short panes.
      const y = token.y + radius * 0.1 - number.rise * radius * 0.55;
      c.save();
      c.globalAlpha = Math.max(0, number.alpha);
      c.font = (number.critical ? '700 ' : '600 ') + size + 'px Georgia, "Times New Roman", serif';
      c.textAlign = 'center';
      c.textBaseline = 'alphabetic';
      c.lineWidth = Math.max(3, size * 0.12);
      c.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      c.strokeText(String(number.value), token.x, y);
      c.fillStyle = number.side === 'player' ? this._palette.danger : number.tint;
      c.shadowColor = rgba(number.tint, 0.6);
      c.shadowBlur = size * 0.4;
      c.fillText(String(number.value), token.x, y);
      c.restore();
    },
  };

  stage._sprites = options.sprites || createSpriteLibrary({
    fetch: fetchImpl,
    Image: ImageCtor,
    onReady: () => { if (!stage.running) stage.start(); },
  });
  stage._observe();
  return stage;
}
