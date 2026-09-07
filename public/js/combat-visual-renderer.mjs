import { buildCombatView } from "./combat-visual-core.mjs";
import { escHtml, formatInt } from "./core-information-panel-renderers.mjs";
import { NPC_FALLBACK_IMAGE, PLAYER_FALLBACK_IMAGE } from "./image-fallbacks.js";

export const RESULT_LABELS = {
  hit: "Hit",
  critical: "Critical",
  miss: "Miss",
  dodge: "Dodged",
  absorb: "Absorbed",
};

const PERSPECTIVE_LABELS = {
  outgoing: {
    hit: "Your hit",
    critical: "Your critical hit",
    miss: "You missed",
    dodge: "Target dodged",
    absorb: "Target absorbed",
  },
  incoming: {
    hit: "Incoming hit",
    critical: "Incoming critical hit",
    miss: "Enemy missed",
    dodge: "You dodged",
    absorb: "You absorbed it",
  },
  observed: {
    hit: "Observed hit",
    critical: "Observed critical hit",
    miss: "Observed miss",
    dodge: "Observed dodge",
    absorb: "Observed absorb",
  },
};

export function healthHtml(side, name, health) {
  const safeName = escHtml(name || (side === "player" ? "You" : "Target"));
  if (!health || !health.known) {
    const unknownLabel =
      health && health.status === "unavailable" ? "Unavailable" : "Synchronizing";
    return (
      '<div class="combat-health combat-health-unknown" role="progressbar" ' +
      'aria-label="' +
      safeName +
      ' health" aria-valuetext="' +
      unknownLabel +
      '">' +
      '<div class="combat-health-track"><div class="combat-health-fill"></div></div>' +
      '<div class="combat-health-values"><span>HP</span><span>' +
      unknownLabel +
      "</span></div></div>"
    );
  }
  const current = Math.round(health.current);
  const maximum = Math.round(health.max);
  const percent = Math.max(0, Math.min(100, Math.round(health.percent)));
  return (
    '<div class="combat-health combat-health-' +
    side +
    '" role="progressbar" ' +
    'aria-label="' +
    safeName +
    ' health" aria-valuemin="0" aria-valuemax="' +
    maximum +
    '" aria-valuenow="' +
    current +
    '" aria-valuetext="' +
    current +
    " of " +
    maximum +
    '">' +
    '<div class="combat-health-track"><div class="combat-health-fill" style="width:' +
    percent +
    '%"></div>' +
    '<span class="combat-health-percent">' +
    percent +
    "%</span></div>" +
    '<div class="combat-health-values"><span>HP</span><span>' +
    formatInt(current) +
    " / " +
    formatInt(maximum) +
    "</span></div></div>"
  );
}

function artHtml(side, combatant, loadedImages, failedImages, event, impactSide) {
  const hasGeneratedImage = !!combatant.image;
  const generatedImageFailed = hasGeneratedImage && failedImages.has(combatant.image);
  const usesNpcFallbackImage = combatant.image === NPC_FALLBACK_IMAGE;
  const isNpcFallback =
    side === "target" &&
    combatant.isNpc &&
    (!hasGeneratedImage || generatedImageFailed || usesNpcFallbackImage);
  const fallbackImage =
    side === "target" && combatant.isNpc ? NPC_FALLBACK_IMAGE : PLAYER_FALLBACK_IMAGE;
  const image = isNpcFallback ? fallbackImage : hasGeneratedImage ? combatant.image : fallbackImage;
  const loadedClass = loadedImages.has(image) ? " is-loaded" : "";
  const failedClass = failedImages.has(image) ? " is-error" : "";
  const classes =
    "combat-art combat-art-" +
    side +
    (isNpcFallback ? " is-fallback" : hasGeneratedImage ? " has-image" : " is-placeholder") +
    loadedClass +
    failedClass;
  let html =
    '<div class="' +
    classes +
    '"><img src="' +
    escHtml(image) +
    '" data-combat-image="' +
    escHtml(image) +
    '"' +
    (combatant.isNpc ? ' data-combat-fallback="' + NPC_FALLBACK_IMAGE + '"' : "") +
    ' alt="" draggable="false">';
  if (event && impactSide === side) {
    html +=
      '<div class="combat-impact-badge" aria-hidden="true">' +
      escHtml(RESULT_LABELS[event.result] || event.result) +
      "</div>";
    if (Object.prototype.hasOwnProperty.call(event, "damage")) {
      html +=
        '<div class="combat-damage-number combat-damage-' +
        side +
        '" aria-hidden="true">' +
        formatInt(event.damage) +
        "</div>";
    }
  }
  return html + "</div>";
}

export function eventLabel(event) {
  if (!event) return "Awaiting the next exchange";
  const perspectiveLabels = PERSPECTIVE_LABELS[event.perspective];
  let label =
    (perspectiveLabels && perspectiveLabels[event.result]) ||
    RESULT_LABELS[event.result] ||
    "Exchange";
  if (Object.prototype.hasOwnProperty.call(event, "damage")) {
    label += " \u2022 " + formatInt(event.damage) + " damage";
  } else if (event.result === "absorb" && Object.prototype.hasOwnProperty.call(event, "absorbed")) {
    label += " \u2022 " + formatInt(event.absorbed) + " absorbed";
  }
  return label;
}

export function createCombatVisualRenderer(bodyEl) {
  const loadedImages = new Set();
  const failedImages = new Set();
  let announcementKey = "";
  let imageListeners = [];
  let disposed = false;

  function clearImageListeners() {
    for (const [image, type, listener] of imageListeners) {
      image.removeEventListener(type, listener);
    }
    imageListeners = [];
  }

  function render(data) {
    if (disposed) return false;
    clearImageListeners();
    const view = buildCombatView(data.model, {
      enemy: data.enemy,
      vitals: data.vitals,
      avatar: data.avatar,
      status: data.status,
      inventory: data.inventory,
    });
    const event = view.event;
    const resultClass = event ? " combat-result-" + event.result : "";
    const perspectiveClass =
      event && event.perspective
        ? " combat-perspective-" + event.perspective.replace(/[^a-z0-9_-]/g, "")
        : "";
    const motionClass = view.reducedMotion ? " combat-visual-reduced" : "";
    const effectiveClass = view.effective ? " combat-visual-effective" : " combat-visual-syncing";
    // Perspective is the recipient-safe source of truth. Keep the actor IDs for
    // observed combat, but never let an older/mixed server omit the player-side
    // impact treatment from an explicitly incoming event.
    const incomingEvent = !!(event && event.perspective === "incoming");
    const outgoingEvent = !!(event && event.perspective === "outgoing");
    const playerImpact = event && (incomingEvent || event.targetId === view.player.id);
    const targetImpact = event && (outgoingEvent || event.targetId === view.target.id);
    const playerActor = event && (outgoingEvent || event.actorId === view.player.id);
    const targetActor = event && (incomingEvent || event.actorId === view.target.id);
    const impactSideClass = playerImpact
      ? " combat-impact-player"
      : targetImpact
        ? " combat-impact-opponent"
        : "";
    const impactSide = playerImpact ? "player" : targetImpact ? "target" : "";
    const playerClass =
      (playerImpact ? " is-impact-target" : "") + (playerActor ? " is-event-actor" : "");
    const targetClass =
      (targetImpact ? " is-impact-target" : "") + (targetActor ? " is-event-actor" : "");
    const currentEventLabel = eventLabel(event);
    let announcement = "";
    let nextAnnouncementKey = "";
    if (event) {
      announcement = event.summary || currentEventLabel;
      nextAnnouncementKey = view.epoch + ":" + view.encounterId + ":event:" + event.seq;
    } else if (view.summary && (!view.active || !view.history.length)) {
      announcement = view.summary;
      nextAnnouncementKey = view.epoch + ":" + view.encounterId + ":state:" + view.stateSeq;
    }
    if (!nextAnnouncementKey || announcementKey === nextAnnouncementKey) {
      announcement = "";
    } else {
      announcementKey = nextAnnouncementKey;
    }
    let html =
      '<div class="combat-visual' +
      resultClass +
      perspectiveClass +
      impactSideClass +
      effectiveClass +
      motionClass +
      '" role="region" aria-label="Visual combat" data-encounter-id="' +
      escHtml(view.encounterId) +
      '">';

    html += '<div class="combat-stage">';
    html += '<article class="combatant-card combatant-player' + playerClass + '">';
    html += '<div class="combatant-name"><span>' + escHtml(view.player.name) + "</span></div>";
    html += artHtml("player", view.player, loadedImages, failedImages, event, impactSide);
    html += healthHtml("player", view.player.name, view.player.health);
    html += "</article>";
    html += '<div class="combat-versus" aria-hidden="true"><span>VS</span></div>';
    html += '<article class="combatant-card combatant-target' + targetClass + '">';
    html += '<div class="combatant-name"><span>' + escHtml(view.target.name) + "</span></div>";
    html += artHtml("target", view.target, loadedImages, failedImages, event, impactSide);
    html += healthHtml("target", view.target.name, view.target.health);
    if (view.target.condition) {
      html += '<div class="combat-target-condition">' + escHtml(view.target.condition) + "</div>";
    }
    html += "</article>";
    html += "</div>";

    html +=
      '<div class="combat-current-event combat-current-' +
      escHtml(event ? event.result : "waiting") +
      '"><span class="combat-event-glyph" aria-hidden="true"></span>' +
      '<span class="combat-event-copy"><strong>' +
      escHtml(currentEventLabel) +
      "</strong>";
    if (event && event.summary) {
      html += '<span class="combat-event-summary">' + escHtml(event.summary) + "</span>";
    }
    html += "</span></div>";

    if (view.threats.length || view.hiddenThreatCount) {
      html +=
        '<div class="combat-threats" aria-label="Additional combat threats"><span class="combat-section-label">Threats</span>';
      for (const threat of view.threats) {
        html += '<span class="combat-threat-chip">' + escHtml(threat.name) + "</span>";
      }
      if (view.hiddenThreatCount) {
        html +=
          '<span class="combat-threat-chip combat-threat-more">+' +
          view.hiddenThreatCount +
          "</span>";
      }
      html += "</div>";
    }

    if (view.history.length) {
      html += '<ol class="combat-event-history" aria-label="Recent combat events">';
      for (const historyEvent of view.history.slice(-5).reverse()) {
        html +=
          '<li class="combat-history-' +
          escHtml(historyEvent.result) +
          '"><span>' +
          escHtml(RESULT_LABELS[historyEvent.result] || historyEvent.result) +
          "</span><span>" +
          escHtml(historyEvent.summary || eventLabel(historyEvent)) +
          "</span></li>";
      }
      if (view.overflow.omitted) {
        html +=
          '<li class="combat-history-overflow"><span>Combined</span><span>+' +
          formatInt(view.overflow.omitted) +
          " exchanges</span></li>";
      }
      html += "</ol>";
    }

    if (!view.active && view.outcome) {
      html +=
        '<div class="combat-outcome combat-outcome-' +
        escHtml(view.outcome) +
        '">' +
        escHtml(view.summary || view.outcome) +
        "</div>";
    } else if (!view.effective) {
      html +=
        '<div class="combat-sync-state">' +
        "Visual combat is synchronizing; text fallback remains active</div>";
    }
    html +=
      '<div class="sr-only combat-live-region" role="status" aria-live="polite" aria-atomic="true">' +
      escHtml(announcement) +
      "</div>";
    html += "</div>";

    bodyEl.innerHTML = html;
    bodyEl._enemyState = null;
    if (typeof bodyEl.querySelectorAll === "function") {
      for (const img of bodyEl.querySelectorAll(".combat-art img")) {
        const wrap = img.parentElement;
        const imageKey = () => img.getAttribute("data-combat-image") || img.src || "";
        const markLoaded = () => {
          const key = imageKey();
          if (key) {
            loadedImages.add(key);
            failedImages.delete(key);
          }
          if (wrap && wrap.classList) {
            wrap.classList.remove("is-error");
            wrap.classList.add("is-loaded");
          }
        };
        const markFailed = () => {
          const key = imageKey();
          const fallback = img.getAttribute("data-combat-fallback") || "";
          if (fallback && key !== fallback) {
            if (key) failedImages.add(key);
            img.setAttribute("data-combat-image", fallback);
            if (wrap && wrap.classList) wrap.classList.remove("is-error");
            img.src = fallback;
            return;
          }
          if (key) failedImages.add(key);
          if (wrap && wrap.classList) wrap.classList.add("is-error");
        };
        img.addEventListener("load", markLoaded);
        img.addEventListener("error", markFailed);
        imageListeners.push([img, "load", markLoaded], [img, "error", markFailed]);
        if (img.complete && img.naturalWidth > 0) markLoaded();
      }
    }
    return true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearImageListeners();
    loadedImages.clear();
    failedImages.clear();
    announcementKey = "";
  }

  return Object.freeze({ render, dispose });
}
