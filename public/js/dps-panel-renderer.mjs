// dps-panel-renderer.mjs - data-in, HTML-out rendering for the DPS Meter.
//
// renderDpsPanel(bodyEl, view, options) draws the view model from
// selectDpsView in dps-meter-core.mjs into bodyEl. It knows nothing about
// where the view came from: DpsPanel.svelte feeds it the session's DPS
// snapshot and passes the Reset handler in through `options.onReset`.

import { escHtml, formatInt } from './core-information-panel-renderers.mjs';

// A rate the meter could not compute yet (no elapsed fight time) is shown as
// a dash rather than as a zero it has not earned.
export function formatDpsNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  if (value >= 100) return Math.round(value).toLocaleString('en-US');
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

export function formatClock(milliseconds) {
  const total = Math.max(0, Math.round((Number(milliseconds) || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return hours + 'h ' + (minutes % 60) + 'm';
  }
  return minutes + ':' + String(seconds).padStart(2, '0');
}

function percentSuffix(rate) {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '';
  return ' (' + Math.round(rate * 100) + '%)';
}

function dpsCell(label, value) {
  return '<div class="dps-cell"><span>' + escHtml(String(value)) + '</span><small>' +
    escHtml(label) + '</small></div>';
}

function dpsRow(label, value) {
  return '<div class="status-row"><span class="status-key">' + escHtml(label) +
    '</span><span>' + escHtml(String(value)) + '</span></div>';
}

export function renderDpsPanel(bodyEl, data, options = {}) {
  if (!data) {
    bodyEl.innerHTML = '<div class="placeholder">Waiting for combat...</div>';
    return;
  }

  const encounter = data.encounter;
  const session = data.session;
  const headline = data.active ? encounter.current : encounter.dps;
  const headlineLabel = data.active
    ? 'DPS (last ' + formatDpsNumber(data.windowSeconds) + 's)'
    : 'Last fight DPS';
  // Without numeric wording every damage total is a zero the meter has not
  // earned. Show a dash and let the notice below explain why.
  const figure = (value, format) => (data.missingDamageNumbers ? '--' : format(value));
  // The session keeps its real total when earlier fights did report numbers;
  // it only goes blank when nothing measurable has ever been banked.
  const sessionUnknown = data.missingDamageNumbers && !session.damage;
  const sessionFigure = (value, format) => (sessionUnknown ? '--' : format(value));

  let html = '<div class="dps-panel' + (data.active ? ' dps-panel-active' : '') + '">';

  const target = data.targetName || 'no target';
  html += '<div class="dps-target">' +
    '<span class="dps-state-dot"></span>' +
    '<span class="dps-target-name">' + escHtml(data.active ? target : 'Idle') + '</span>' +
    '<span class="dps-elapsed">' + escHtml(formatClock(encounter.durationMs)) + '</span>' +
    '</div>';

  html += '<div class="dps-headline">' +
    '<span class="dps-headline-value">' + escHtml(figure(headline, formatDpsNumber)) + '</span>' +
    '<small>' + escHtml(headlineLabel) + '</small>' +
    '</div>';

  if (data.missingDamageNumbers) {
    // Swings are arriving with their numeric wording stripped, so every
    // total below would read as a confident zero. Say why instead.
    html += '<div class="dps-notice">Damage numbers are off. ' +
      'Turn them on with <code>combatbrief damage</code>.</div>';
  } else if (!data.hasData) {
    html += '<div class="dps-notice dps-notice-quiet">No combat recorded yet.</div>';
  }

  html += '<div class="dps-grid">' +
    dpsCell('Fight DPS', figure(encounter.dps, formatDpsNumber)) +
    dpsCell('Peak', figure(encounter.peak, formatDpsNumber)) +
    dpsCell('Damage', figure(encounter.damage, formatInt)) +
    dpsCell('Best hit', figure(encounter.bestHit, formatInt)) +
    '</div>';

  html += '<div class="dps-rows">' +
    dpsRow('Swings', formatInt(encounter.swings)) +
    dpsRow('Hits', formatInt(encounter.hits) + percentSuffix(encounter.hitRate)) +
    dpsRow('Crits', formatInt(encounter.crits) + percentSuffix(encounter.critRate)) +
    dpsRow('Missed', formatInt(encounter.misses + encounter.dodges)) +
    dpsRow('Absorbed', formatInt(encounter.absorbed)) +
    '</div>';

  html += '<div class="dps-section-title">Session</div>';
  html += '<div class="dps-rows">' +
    dpsRow('Session DPS', sessionFigure(session.dps, formatDpsNumber)) +
    dpsRow('Damage', sessionFigure(session.damage, formatInt)) +
    // Counts stay true even with damage numbers off, so this is never dashed.
    dpsRow('Crits', formatInt(session.crits) + percentSuffix(session.critRate)) +
    dpsRow('Fights', formatInt(session.encounters)) +
    dpsRow('In combat', formatClock(session.durationMs)) +
    '</div>';

  if (data.history.length) {
    html += '<div class="dps-section-title">Recent fights</div>';
    html += '<div class="dps-history">';
    for (const entry of data.history) {
      html += '<div class="dps-history-row">' +
        '<span class="dps-history-name">' + escHtml(entry.targetName || 'unknown') + '</span>' +
        '<span class="dps-history-dps">' + escHtml(formatDpsNumber(entry.dps)) + '</span>' +
        '<span class="dps-history-meta">' + escHtml(formatClock(entry.durationMs)) + '</span>' +
        '</div>';
    }
    html += '</div>';
  }

  html += '<div class="dps-actions">' +
    '<button type="button" class="dps-btn dps-btn-secondary" data-dps-action="reset">Reset session</button>' +
    '</div>';
  html += '</div>';

  bodyEl.innerHTML = html;

  if (typeof options.onReset === 'function' && typeof bodyEl.querySelectorAll === 'function') {
    bodyEl.querySelectorAll('[data-dps-action="reset"]').forEach((btn) => {
      btn.addEventListener('click', () => options.onReset());
    });
  }
}
