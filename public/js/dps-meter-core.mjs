import { normalizeCombatEvent, normalizeCombatState } from './combat-visual-core.mjs';

// Pure, DOM-free reducers behind the DPS meter.
//
// The visual combat pane consumes the same Darkwind.Combat frames, but it
// drops every event while the saved `combatbrief visual` preference is off.
// The meter deliberately does not share that gate: a player who fights with
// the animated pane closed still wants a damage readout. It therefore tracks
// its own encounter identity and will adopt an encounter straight from an
// event batch when no State frame introduced one.

const HIT_RESULTS = new Set(['hit', 'critical']);

export const DPS_WINDOW_MS = 10000;
export const DPS_HISTORY_LIMIT = 5;
export const DPS_SAMPLE_LIMIT = 600;
// A missing State frame must not leave the session clock running forever.
// Combat that goes quiet for this long is closed out at its last swing.
export const DPS_IDLE_TIMEOUT_MS = 15000;
// A whole batch of swings can share one timestamp. Dividing by that sliver of
// a second yields a rate in the hundreds of thousands, so no fight reports a
// DPS figure until it has run long enough to measure.
export const DPS_MIN_DURATION_MS = 1000;

function nonNegativeInteger(value) {
  if (value === null || value === '' || typeof value === 'boolean') return 0;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

function safeText(value, maxLength = 128) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  let out = '';
  for (let i = 0; i < text.length && out.length < maxLength; i++) {
    const code = text.charCodeAt(i);
    // Drop C0 controls and DEL, including the ESC that starts an ANSI run.
    if (code < 0x20 || code === 0x7f) continue;
    out += text[i];
  }
  return out.trim();
}

function createTally() {
  return {
    damage: 0,
    absorbed: 0,
    swings: 0,
    hits: 0,
    crits: 0,
    misses: 0,
    dodges: 0,
    absorbs: 0,
    bestHit: 0,
  };
}

function addToTally(tally, event) {
  const damage = nonNegativeInteger(event.damage);
  return {
    damage: tally.damage + damage,
    absorbed: tally.absorbed + nonNegativeInteger(event.absorbed),
    swings: tally.swings + 1,
    hits: tally.hits + (HIT_RESULTS.has(event.result) ? 1 : 0),
    crits: tally.crits + (event.result === 'critical' ? 1 : 0),
    misses: tally.misses + (event.result === 'miss' ? 1 : 0),
    dodges: tally.dodges + (event.result === 'dodge' ? 1 : 0),
    absorbs: tally.absorbs + (event.result === 'absorb' ? 1 : 0),
    bestHit: Math.max(tally.bestHit, damage),
  };
}

export function createDpsState(options = {}) {
  return {
    epoch: '',
    encounterId: '',
    active: false,
    targetName: '',
    lastSeq: 0,
    firstEventAt: 0,
    lastEventAt: 0,
    endedAt: 0,
    encounter: createTally(),
    session: { ...createTally(), combatMs: 0, encounters: 0, peakDps: 0 },
    samples: [],
    peakDps: 0,
    history: [],
    sawOutgoingEvent: false,
    sawDamageNumber: false,
    limits: {
      windowMs: Math.max(1000, nonNegativeInteger(options.windowMs) || DPS_WINDOW_MS),
      history: Math.max(1, nonNegativeInteger(options.historyLimit) || DPS_HISTORY_LIMIT),
      samples: Math.max(16, nonNegativeInteger(options.sampleLimit) || DPS_SAMPLE_LIMIT),
      idleMs: Math.max(1000, nonNegativeInteger(options.idleMs) || DPS_IDLE_TIMEOUT_MS),
      minDurationMs: Math.max(0, nonNegativeInteger(options.minDurationMs) || DPS_MIN_DURATION_MS),
    },
  };
}

function freshEncounter(state, encounterId, targetName) {
  return {
    ...state,
    encounterId,
    active: true,
    targetName: targetName || '',
    lastSeq: 0,
    firstEventAt: 0,
    lastEventAt: 0,
    endedAt: 0,
    encounter: createTally(),
    samples: [],
    peakDps: 0,
    // Scoped to the fight: a player who turns `combatbrief damage` off
    // mid-session must still get told on the very next encounter.
    sawDamageNumber: false,
  };
}

export function encounterDurationMs(state, now = Date.now()) {
  if (!state || !state.firstEventAt) return 0;
  const end = state.active ? now : (state.endedAt || state.lastEventAt);
  return Math.max(0, end - state.firstEventAt);
}

export function sessionCombatMs(state, now = Date.now()) {
  if (!state) return 0;
  return state.session.combatMs + (state.active ? encounterDurationMs(state, now) : 0);
}

function pruneSamples(samples, now, limits) {
  const cutoff = now - limits.windowMs;
  let start = 0;
  while (start < samples.length && samples[start].at <= cutoff) start++;
  let pruned = start > 0 ? samples.slice(start) : samples;
  if (pruned.length > limits.samples) pruned = pruned.slice(pruned.length - limits.samples);
  return pruned;
}

export function rollingDps(state, now = Date.now()) {
  if (!state || !state.samples.length) return 0;
  const samples = pruneSamples(state.samples, now, state.limits);
  let total = 0;
  for (const sample of samples) total += sample.damage;
  return total / (state.limits.windowMs / 1000);
}

// Close out the live encounter, banking its duration and tallies into the
// session totals and the recent-fight history.
//
// `endedAt` defaults to now because a fight really does run until the frame
// that reports its outcome. The idle sweep passes the last swing instead, so
// an unreported end cannot bill dead air to the session clock.
export function finalizeEncounter(state, now = Date.now(), endedAt = now) {
  if (!state || !state.active) return state;
  const settled = { ...state, active: false, endedAt: endedAt || now };

  // Nothing was ever swung at this target, so there is no fight to record.
  if (!settled.encounter.swings) return settled;

  const durationMs = encounterDurationMs(settled, now);
  const dps = perSecond(settled.encounter.damage, durationMs, settled.limits);
  const history = settled.history.concat([{
    encounterId: settled.encounterId,
    targetName: settled.targetName,
    damage: settled.encounter.damage,
    swings: settled.encounter.swings,
    hits: settled.encounter.hits,
    durationMs,
    dps,
    endedAt,
  }]);
  if (history.length > settled.limits.history) {
    history.splice(0, history.length - settled.limits.history);
  }

  return {
    ...settled,
    history,
    session: {
      ...settled.session,
      combatMs: settled.session.combatMs + durationMs,
      encounters: settled.session.encounters + 1,
    },
  };
}

function resolveTargetName(normalized) {
  if (!normalized.currentTargetId) return '';
  for (const actor of normalized.actors) {
    if (actor.id === normalized.currentTargetId) return actor.name;
  }
  return '';
}

export function reduceDpsState(current, payload, now = Date.now()) {
  const state = current || createDpsState();
  const normalized = normalizeCombatState(payload);
  if (!normalized || !normalized.epoch) return state;

  let next = state;
  // A new connection epoch invalidates every earlier tally.
  if (state.epoch && normalized.epoch !== state.epoch) next = createDpsState(state.limits);
  next = { ...next, epoch: normalized.epoch };

  const targetName = resolveTargetName(normalized);

  if (normalized.encounterId && normalized.encounterId !== next.encounterId) {
    next = freshEncounter(finalizeEncounter(next, now), normalized.encounterId, targetName);
    return normalized.active ? next : { ...next, active: false, endedAt: now };
  }

  if (targetName && targetName !== next.targetName) next = { ...next, targetName };
  if (!normalized.active && next.active) return finalizeEncounter(next, now);
  return next;
}

export function reduceDpsEvents(current, payload, now = Date.now()) {
  const state = current || createDpsState();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return state;

  const epoch = safeText(payload.epoch);
  const encounterId = safeText(payload.encounter_id);
  if (!epoch || !encounterId) return state;

  let next = state;
  if (state.epoch && epoch !== state.epoch) next = createDpsState(state.limits);
  next = { ...next, epoch };

  if (encounterId !== next.encounterId) {
    // Adopt the encounter even when no State frame introduced it.
    next = freshEncounter(finalizeEncounter(next, now), encounterId, '');
  } else if (!next.active) {
    // The fight is already closed out; trailing events must not reopen it.
    return state;
  }

  const normalized = (Array.isArray(payload.events) ? payload.events : [])
    .map((event) => normalizeCombatEvent(event, now))
    .filter(Boolean)
    .sort((left, right) => left.seq - right.seq);

  const accepted = [];
  let lastSeq = next.lastSeq;
  for (const event of normalized) {
    if (event.seq <= lastSeq) continue;
    lastSeq = event.seq;
    // Outgoing swings only: this meter reports what the player deals.
    if (event.perspective !== 'outgoing') continue;
    accepted.push(event);
  }

  if (lastSeq === next.lastSeq) return state;
  next = { ...next, lastSeq };
  if (!accepted.length) return next;

  let encounter = next.encounter;
  let session = next.session;
  let samples = next.samples;
  let sawDamageNumber = next.sawDamageNumber;
  let firstEventAt = next.firstEventAt;

  for (const event of accepted) {
    encounter = addToTally(encounter, event);
    session = {
      ...addToTally(session, event),
      combatMs: session.combatMs,
      encounters: session.encounters,
      peakDps: session.peakDps,
    };
    if (Object.prototype.hasOwnProperty.call(event, 'damage')) sawDamageNumber = true;
    const damage = nonNegativeInteger(event.damage);
    if (damage > 0) samples = samples.concat([{ at: event.receivedAt, damage }]);
    if (!firstEventAt) firstEventAt = event.receivedAt;
  }

  const candidate = {
    ...next,
    encounter,
    session,
    samples: pruneSamples(samples, now, next.limits),
    firstEventAt,
    lastEventAt: accepted[accepted.length - 1].receivedAt,
    sawOutgoingEvent: true,
    sawDamageNumber,
  };

  const peakDps = Math.max(next.peakDps, rollingDps(candidate, now));
  return {
    ...candidate,
    peakDps,
    session: { ...candidate.session, peakDps: Math.max(session.peakDps, peakDps) },
  };
}

// Called from the manager's tick. Closes an encounter whose State frame never
// arrived, so an unreported end cannot inflate the session clock.
export function reduceDpsIdle(current, now = Date.now()) {
  const state = current || createDpsState();
  if (!state.active || !state.lastEventAt) return state;
  if (now - state.lastEventAt < state.limits.idleMs) return state;
  return finalizeEncounter(state, now, state.lastEventAt);
}

export function resetDpsSession(current, now = Date.now()) {
  const state = current || createDpsState();
  const fresh = createDpsState(state.limits);
  if (!state.active) return { ...fresh, epoch: state.epoch };
  // Keep the live fight running; only the accumulated session is cleared.
  return {
    ...fresh,
    epoch: state.epoch,
    encounterId: state.encounterId,
    active: true,
    targetName: state.targetName,
    lastSeq: state.lastSeq,
    firstEventAt: now,
    lastEventAt: state.lastEventAt,
    sawOutgoingEvent: state.sawOutgoingEvent,
    sawDamageNumber: state.sawDamageNumber,
  };
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

// Null until the fight has run long enough for the division to mean anything.
function perSecond(damage, durationMs, limits) {
  if (durationMs < limits.minDurationMs || durationMs <= 0) return null;
  return damage / (durationMs / 1000);
}

export function selectDpsView(current, now = Date.now()) {
  const state = current || createDpsState();
  const durationMs = encounterDurationMs(state, now);
  const sessionMs = sessionCombatMs(state, now);

  return {
    active: state.active,
    targetName: state.targetName,
    hasData: state.sawOutgoingEvent || state.session.swings > 0,
    // Numeric wording is stripped from events while `combatbrief damage` is
    // off. Say so instead of presenting a confident zero. Keyed on landed
    // hits, so a fight that has only missed so far is not mistaken for it.
    missingDamageNumbers: state.encounter.hits > 0 && !state.sawDamageNumber,
    windowSeconds: state.limits.windowMs / 1000,
    encounter: {
      ...state.encounter,
      durationMs,
      dps: perSecond(state.encounter.damage, durationMs, state.limits),
      current: rollingDps(state, now),
      peak: state.peakDps,
      hitRate: ratio(state.encounter.hits, state.encounter.swings),
      critRate: ratio(state.encounter.crits, state.encounter.hits),
    },
    session: {
      ...state.session,
      durationMs: sessionMs,
      dps: perSecond(state.session.damage, sessionMs, state.limits),
      hitRate: ratio(state.session.hits, state.session.swings),
      critRate: ratio(state.session.crits, state.session.hits),
    },
    history: state.history.slice().reverse(),
  };
}
