// combat-stage-renderer.mjs - the canvas combat stage behind the Combat
// panel's renderer contract.
//
// createCombatStageRenderer(bodyEl) returns { render(data), dispose() } with
// the same shape as createCombatVisualRenderer in combat-visual-renderer.mjs,
// so CombatPanel.svelte can mount either one. render() draws the fighters on
// a canvas (combat-stage.mjs) and keeps names, health bars, the current
// exchange, threats, history, and the polite live region in the DOM, where
// assistive technology and the browser specs can read them.
//
// When the environment has no 2D canvas, render() delegates to the DOM card
// renderer instead of reporting a failure: the pane still works, it just
// does not animate. Only a renderer that cannot draw at all returns false,
// which is what the panel turns into "presentation unavailable" so the
// server keeps the text fallback on.
//
// `data` is the session combat snapshot plus the recipient-only inputs the
// stage uses for the player token: `status` (Char.Status, for the race,
// guild, and gender descriptor and the bundled portrait), `inventory`
// (Char.Items, for the wielded and worn equipment), and `room` (Room.Info,
// for the terrain backdrop). All three are optional.

import { buildCombatView } from './combat-visual-core.mjs';
import { createCombatStage, isCanvasStageSupported } from './combat-stage.mjs';
import {
  RESULT_LABELS,
  createCombatVisualRenderer,
  eventLabel,
  healthHtml,
} from './combat-visual-renderer.mjs';
import { escHtml, formatInt } from './core-information-panel-renderers.mjs';
import { NPC_FALLBACK_IMAGE, PLAYER_FALLBACK_IMAGE } from './image-fallbacks.js';

function eventClasses(view, event) {
  // Perspective is the recipient-safe source of truth. Keep the actor IDs for
  // observed combat, but never let an older/mixed server omit the player-side
  // impact treatment from an explicitly incoming event.
  const incomingEvent = !!(event && event.perspective === 'incoming');
  const outgoingEvent = !!(event && event.perspective === 'outgoing');
  const playerImpact = event && (incomingEvent || event.targetId === view.player.id);
  const targetImpact = event && (outgoingEvent || event.targetId === view.target.id);
  const playerActor = event && (outgoingEvent || event.actorId === view.player.id);
  const targetActor = event && (incomingEvent || event.actorId === view.target.id);
  const resultClass = event ? ' combat-result-' + event.result : '';
  const perspectiveClass = event && event.perspective
    ? ' combat-perspective-' + event.perspective.replace(/[^a-z0-9_-]/g, '')
    : '';
  const impactSideClass = playerImpact
    ? ' combat-impact-player'
    : (targetImpact ? ' combat-impact-opponent' : '');
  return {
    rootClass: 'combat-visual' + resultClass + perspectiveClass + impactSideClass +
      (view.effective ? ' combat-visual-effective' : ' combat-visual-syncing') +
      (view.reducedMotion ? ' combat-visual-reduced' : ''),
    playerClass: (playerImpact ? ' is-impact-target' : '') +
      (playerActor ? ' is-event-actor' : ''),
    targetClass: (targetImpact ? ' is-impact-target' : '') +
      (targetActor ? ' is-event-actor' : ''),
  };
}

// Name, descriptor, and health for one token, positioned over the canvas by
// combat-visual.css so the progress bars stay real DOM.
function tokenHudHtml(side, combatant, sideClass) {
  let html = '<div class="combat-token-hud combat-token-hud-' + side + sideClass + '">';
  html += '<div class="combat-hud-name"><span>' + escHtml(combatant.name) + '</span></div>';
  if (combatant.descriptor) {
    html += '<div class="combat-hud-descriptor">' + escHtml(combatant.descriptor) + '</div>';
  }
  html += healthHtml(side, combatant.name, combatant.health);
  if (side === 'target' && combatant.condition) {
    html += '<div class="combat-target-condition">' + escHtml(combatant.condition) + '</div>';
  }
  return html + '</div>';
}

// Everything below the stage: current exchange, threats, history, outcome,
// and the live region.
function hudHtml(view, event, label, announcement) {
  let html = '<div class="combat-current-event combat-current-' +
    escHtml(event ? event.result : 'waiting') + '"><span class="combat-event-glyph" aria-hidden="true"></span>' +
    '<span class="combat-event-copy"><strong>' + escHtml(label) + '</strong>';
  if (event && event.summary) {
    html += '<span class="combat-event-summary">' + escHtml(event.summary) + '</span>';
  }
  html += '</span></div>';

  if (view.threats.length || view.hiddenThreatCount) {
    html += '<div class="combat-threats" aria-label="Additional combat threats"><span class="combat-section-label">Threats</span>';
    for (const threat of view.threats) {
      html += '<span class="combat-threat-chip">' + escHtml(threat.name) + '</span>';
    }
    if (view.hiddenThreatCount) {
      html += '<span class="combat-threat-chip combat-threat-more">+' +
        view.hiddenThreatCount + '</span>';
    }
    html += '</div>';
  }

  if (view.history.length) {
    html += '<ol class="combat-event-history" aria-label="Recent combat events">';
    for (const historyEvent of view.history.slice(-5).reverse()) {
      html += '<li class="combat-history-' + escHtml(historyEvent.result) + '"><span>' +
        escHtml(RESULT_LABELS[historyEvent.result] || historyEvent.result) + '</span><span>' +
        escHtml(historyEvent.summary || eventLabel(historyEvent)) + '</span></li>';
    }
    if (view.overflow.omitted) {
      html += '<li class="combat-history-overflow"><span>Combined</span><span>+' +
        formatInt(view.overflow.omitted) + ' exchanges</span></li>';
    }
    html += '</ol>';
  }

  if (!view.active && view.outcome) {
    html += '<div class="combat-outcome combat-outcome-' + escHtml(view.outcome) + '">' +
      escHtml(view.summary || view.outcome) + '</div>';
  } else if (!view.effective) {
    html += '<div class="combat-sync-state">' +
      'Visual combat is synchronizing; text fallback remains active</div>';
  }
  html += '<div class="sr-only combat-live-region" role="status" aria-live="polite" aria-atomic="true">' +
    escHtml(announcement) + '</div>';
  return html;
}

export function createCombatStageRenderer(bodyEl, options = {}) {
  const doc = options.document
    || (bodyEl && bodyEl.ownerDocument)
    || (typeof document !== 'undefined' ? document : null);
  let host = null;
  let fallback = null;
  let announcementKey = '';
  let disposed = false;

  function hostAlive() {
    return !!(host && host.stage && !host.stage.destroyed && host.root.parentNode === bodyEl);
  }

  function destroyStage() {
    if (!host) return;
    const stage = host.stage;
    host = null;
    if (stage && typeof stage.destroy === 'function') stage.destroy();
  }

  function mountStage() {
    const stage = createCombatStage(doc, options.stage || {});
    if (!stage) return null;
    const root = doc.createElement('div');
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Visual combat');
    const stageEl = doc.createElement('div');
    stageEl.className = 'combat-stage combat-stage-canvas-host';
    stageEl.appendChild(stage.element);
    const overlay = doc.createElement('div');
    overlay.className = 'combat-stage-overlay';
    stageEl.appendChild(overlay);
    const hud = doc.createElement('div');
    hud.className = 'combat-hud';
    root.appendChild(stageEl);
    root.appendChild(hud);
    bodyEl.innerHTML = '';
    bodyEl.appendChild(root);
    return { stage, root, overlay, hud };
  }

  // The polite live region only announces a beat once per event or state
  // change; every re-render in between leaves it empty so screen readers do
  // not hear the same exchange repeated.
  function nextAnnouncement(view, event, label) {
    let announcement = '';
    let key = '';
    if (event) {
      announcement = event.summary || label;
      key = view.epoch + ':' + view.encounterId + ':event:' + event.seq;
    } else if (view.summary && (!view.active || !view.history.length)) {
      announcement = view.summary;
      key = view.epoch + ':' + view.encounterId + ':state:' + view.stateSeq;
    }
    if (!key || announcementKey === key) return '';
    announcementKey = key;
    return announcement;
  }

  function renderFallback(data) {
    destroyStage();
    if (!fallback) fallback = createCombatVisualRenderer(bodyEl);
    return fallback.render(data);
  }

  function render(data) {
    if (disposed || !data || !data.model) return false;
    if (!doc || !isCanvasStageSupported(doc)) return renderFallback(data);
    if (!hostAlive()) {
      destroyStage();
      host = mountStage();
      if (!host) return renderFallback(data);
    }
    if (fallback) {
      fallback.dispose();
      fallback = null;
    }

    const view = buildCombatView(data.model, {
      enemy: data.enemy,
      vitals: data.vitals,
      avatar: data.avatar,
      status: data.status,
      inventory: data.inventory,
    });
    const event = view.event;
    const classes = eventClasses(view, event);
    const label = eventLabel(event);
    const announcement = nextAnnouncement(view, event, label);

    host.root.className = classes.rootClass + ' combat-visual-canvas';
    host.root.setAttribute('data-encounter-id', view.encounterId || '');
    host.overlay.innerHTML =
      tokenHudHtml('player', view.player, classes.playerClass) +
      tokenHudHtml('target', view.target, classes.targetClass);
    host.hud.innerHTML = hudHtml(view, event, label, announcement);
    host.stage.update(view, {
      room: data.room || null,
      playerFallback: [view.player.fallbackImage, PLAYER_FALLBACK_IMAGE].filter(Boolean),
      targetFallback: view.target.isNpc ? NPC_FALLBACK_IMAGE : PLAYER_FALLBACK_IMAGE,
    });
    return true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    destroyStage();
    if (fallback) {
      fallback.dispose();
      fallback = null;
    }
    announcementKey = '';
  }

  return Object.freeze({
    render,
    dispose,
    // The live stage, for diagnostics and tests; null between mounts.
    get stage() {
      return hostAlive() ? host.stage : null;
    },
  });
}
