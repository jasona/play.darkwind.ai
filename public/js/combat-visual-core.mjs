import { bundledPortraitFor } from './image-fallbacks.js';
import { equipmentProfile } from './combat-equipment-core.mjs';

import { isNpcEnemy } from './image-fallbacks.js';

const VALID_RESULTS = new Set(['hit', 'critical', 'miss', 'dodge', 'absorb']);

export const COMBAT_HISTORY_LIMIT = 5;
export const COMBAT_QUEUE_LIMIT = 12;
export const COMBAT_EVENT_STALE_MS = 4000;

function finiteNumber(value) {
  if (value === null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeInteger(value) {
  const number = finiteNumber(value);
  return number === null ? 0 : Math.max(0, Math.trunc(number));
}

function protocolBoolean(value) {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on';
}

function safeText(value, maxLength = 240) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u001b]/g, '')
    .trim()
    .slice(0, maxLength);
}

function emptyOverflow() {
  return { omitted: 0, hits: 0, damage: 0 };
}

function normalizeOverflow(value) {
  value = value && typeof value === 'object' ? value : {};
  return {
    omitted: nonNegativeInteger(value.omitted),
    hits: nonNegativeInteger(value.hits),
    damage: nonNegativeInteger(value.damage),
  };
}

function mergeOverflow(left, right) {
  return {
    omitted: nonNegativeInteger(left && left.omitted) + nonNegativeInteger(right && right.omitted),
    hits: nonNegativeInteger(left && left.hits) + nonNegativeInteger(right && right.hits),
    damage: nonNegativeInteger(left && left.damage) + nonNegativeInteger(right && right.damage),
  };
}

function overflowForEvents(events) {
  const overflow = emptyOverflow();
  for (const event of events) {
    overflow.omitted++;
    if (event.result === 'hit' || event.result === 'critical') overflow.hits++;
    if (Object.prototype.hasOwnProperty.call(event, 'damage')) {
      overflow.damage += nonNegativeInteger(event.damage);
    }
  }
  return overflow;
}

function normalizeActors(value) {
  if (!Array.isArray(value)) return [];
  const actors = [];
  const seen = new Set();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const id = safeText(raw.id, 96);
    const name = safeText(raw.name, 120);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    actors.push({
      id,
      name,
      role: safeText(raw.role, 32).toLowerCase() || 'participant',
    });
    if (actors.length >= 16) break;
  }
  return actors;
}

export function createCombatVisualState(options = {}) {
  return {
    epoch: '',
    encounterId: '',
    stateSeq: 0,
    lastSeq: 0,
    visualEnabled: false,
    effective: false,
    active: false,
    currentActorId: '',
    currentTargetId: '',
    actors: [],
    outcome: '',
    summary: '',
    history: [],
    pending: [],
    overflow: emptyOverflow(),
    currentEvent: null,
    announcement: '',
    reducedMotion: !!options.reducedMotion,
    receivedAt: 0,
    limits: {
      history: Math.max(1, nonNegativeInteger(options.historyLimit) || COMBAT_HISTORY_LIMIT),
      queue: Math.max(1, nonNegativeInteger(options.queueLimit) || COMBAT_QUEUE_LIMIT),
      staleMs: Math.max(250, nonNegativeInteger(options.staleMs) || COMBAT_EVENT_STALE_MS),
    },
  };
}

export function normalizeCombatState(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return {
    epoch: safeText(payload.epoch, 128),
    encounterId: safeText(payload.encounter_id, 128),
    seq: nonNegativeInteger(payload.seq),
    visualEnabled: protocolBoolean(payload.visual_enabled),
    effective: protocolBoolean(payload.effective),
    active: protocolBoolean(payload.active),
    currentActorId: safeText(payload.current_actor_id, 96),
    currentTargetId: safeText(payload.current_target_id, 96),
    actors: normalizeActors(payload.actors),
    outcome: safeText(payload.outcome, 48).toLowerCase(),
    summary: safeText(payload.summary, 320),
  };
}

export function reduceCombatState(current, payload, receivedAt = Date.now()) {
  const normalized = normalizeCombatState(payload);
  if (!normalized) return current;

  const previous = current || createCombatVisualState();
  if (!normalized.epoch || (normalized.active && !normalized.encounterId)) return previous;
  const epochChanged = !!normalized.epoch && normalized.epoch !== previous.epoch;
  const encounterChanged = epochChanged || normalized.encounterId !== previous.encounterId;

  if (!encounterChanged && normalized.seq && normalized.seq < previous.stateSeq) {
    return previous;
  }

  const resetTransient = encounterChanged || !normalized.visualEnabled;
  return {
    ...previous,
    epoch: normalized.epoch,
    encounterId: normalized.encounterId,
    stateSeq: normalized.seq,
    lastSeq: encounterChanged
      ? normalized.seq
      : Math.max(previous.lastSeq, normalized.seq),
    visualEnabled: normalized.visualEnabled,
    effective: normalized.effective,
    active: normalized.active,
    currentActorId: normalized.currentActorId,
    currentTargetId: normalized.currentTargetId,
    actors: normalized.actors,
    outcome: normalized.outcome,
    summary: normalized.summary,
    history: resetTransient ? [] : previous.history,
    pending: resetTransient ? [] : previous.pending,
    overflow: resetTransient ? emptyOverflow() : previous.overflow,
    currentEvent: resetTransient ? null : previous.currentEvent,
    announcement: normalized.summary || (resetTransient ? '' : previous.announcement),
    receivedAt,
  };
}

export function normalizeCombatEvent(payload, receivedAt = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const result = safeText(payload.result, 24).toLowerCase();
  const seq = nonNegativeInteger(payload.seq);
  if (!seq || !VALID_RESULTS.has(result)) return null;

  const event = {
    seq,
    kind: safeText(payload.kind, 32).toLowerCase() || 'attack',
    perspective: safeText(payload.perspective, 24).toLowerCase(),
    actorId: safeText(payload.actor_id, 96),
    targetId: safeText(payload.target_id, 96),
    result,
    summary: safeText(payload.summary, 320),
    receivedAt,
  };

  const damage = finiteNumber(payload.damage);
  if (damage !== null) event.damage = Math.max(0, Math.trunc(damage));
  const absorbed = finiteNumber(payload.absorbed);
  if (absorbed !== null) event.absorbed = Math.max(0, Math.trunc(absorbed));
  return event;
}

export function reduceCombatEvents(current, payload, receivedAt = Date.now()) {
  const previous = current || createCombatVisualState();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return previous;

  const epoch = safeText(payload.epoch, 128);
  const encounterId = safeText(payload.encounter_id, 128);
  if (!previous.visualEnabled
      || !epoch
      || !encounterId
      || epoch !== previous.epoch
      || encounterId !== previous.encounterId) {
    return previous;
  }

  const normalized = (Array.isArray(payload.events) ? payload.events : [])
    .map((event) => normalizeCombatEvent(event, receivedAt))
    .filter(Boolean)
    .sort((left, right) => left.seq - right.seq);

  const accepted = [];
  let lastSeq = previous.lastSeq;
  for (const event of normalized) {
    if (event.seq <= lastSeq) continue;
    accepted.push(event);
    lastSeq = event.seq;
  }

  if (!accepted.length && !payload.overflow) return previous;

  const history = previous.history.concat(accepted);
  if (history.length > previous.limits.history) {
    history.splice(0, history.length - previous.limits.history);
  }

  const pending = previous.pending.concat(accepted);
  let localOverflow = emptyOverflow();
  if (pending.length > previous.limits.queue) {
    const dropped = pending.splice(0, pending.length - previous.limits.queue);
    localOverflow = overflowForEvents(dropped);
  }

  return {
    ...previous,
    lastSeq,
    history,
    pending,
    overflow: mergeOverflow(
      mergeOverflow(previous.overflow, normalizeOverflow(payload.overflow)),
      localOverflow,
    ),
    receivedAt,
  };
}

export function takeNextCombatEvent(current, now = Date.now()) {
  const previous = current || createCombatVisualState();
  const pending = previous.pending.slice();
  const stale = [];
  while (pending.length && now - pending[0].receivedAt > previous.limits.staleMs) {
    stale.push(pending.shift());
  }
  const event = pending.shift() || null;
  return {
    event,
    state: {
      ...previous,
      pending,
      overflow: stale.length
        ? mergeOverflow(previous.overflow, overflowForEvents(stale))
        : previous.overflow,
      currentEvent: event,
      announcement: event && event.summary ? event.summary : previous.announcement,
    },
  };
}

export function clearCurrentCombatEvent(current) {
  if (!current || !current.currentEvent) return current;
  return { ...current, currentEvent: null };
}

function healthSnapshot(currentValue, maxValue) {
  const current = finiteNumber(currentValue);
  const maximum = finiteNumber(maxValue);
  if (current === null || maximum === null || maximum <= 0) {
    return { known: false, current: 0, max: 0, percent: 0 };
  }
  const safeMax = Math.max(1, maximum);
  const safeCurrent = Math.max(0, Math.min(current, safeMax));
  return {
    known: true,
    current: safeCurrent,
    max: safeMax,
    percent: Math.round((safeCurrent / safeMax) * 100),
  };
}

function unavailableHealthSnapshot(status = 'synchronizing') {
  return {
    known: false,
    current: 0,
    max: 0,
    percent: 0,
    status,
  };
}

function emptyDescriptor() {
  return { race: '', guild: '', gender: '', descriptor: '', fallbackImage: '' };
}

// Race, guild, and gender from the sticky Char.Status snapshot, plus the
// bundled portrait that pair maps to. The descriptor is display text for
// the token; the fallback image is used only while no avatar URL exists.
export function playerDescriptor(status) {
  const source = status && typeof status === 'object' ? status : {};
  const race = safeText(source.race, 60);
  const guild = safeText(source.class || source.guild, 60);
  const gender = safeText(source.gender, 24);
  const identity = [gender, race].filter(Boolean).join(' ');
  const descriptor = [identity, guild].filter(Boolean).join(' \u00b7 ');
  return {
    race,
    guild,
    gender,
    descriptor,
    fallbackImage: bundledPortraitFor(race, gender),
  };
}

function activeEnemyName(enemy) {
  const name = safeText(enemy && enemy.enemy_name, 120);
  return name && name !== 'None' ? name : '';
}

export function buildCombatView(current, sources = {}) {
  const model = current || createCombatVisualState();
  const actors = Array.isArray(model.actors) ? model.actors : [];
  const selfActor = actors.find((actor) => actor.role === 'self' || actor.id === 'self');
  const enemy = sources.enemy && typeof sources.enemy === 'object' ? sources.enemy : {};
  const vitals = sources.vitals && typeof sources.vitals === 'object' ? sources.vitals : {};
  const avatar = sources.avatar && typeof sources.avatar === 'object' ? sources.avatar : {};
  const status = sources.status && typeof sources.status === 'object' ? sources.status : {};
  const inventory = Array.isArray(sources.inventory) ? sources.inventory : null;
  const enemyName = activeEnemyName(enemy);
  const selfId = selfActor ? selfActor.id : 'self';
  const latestEvent = model.currentEvent
    || model.history[model.history.length - 1]
    || null;
  const latestObservedEvent = latestEvent && latestEvent.perspective === 'observed'
    ? latestEvent
    : null;
  const encounterEvents = model.currentEvent
    ? model.history.concat(model.currentEvent)
    : model.history;
  const hasRecipientPerspective = encounterEvents.some((event) =>
    event.perspective === 'outgoing' || event.perspective === 'incoming'
  );
  // Newer servers identify the primary combatant explicitly. For older or
  // mixed-version sessions, an observed event still gives us enough
  // recipient-safe identity to avoid putting the bystander in the fight.
  // Event perspective outranks possibly stale Char.Enemy data, but any own
  // incoming/outgoing event keeps the recipient anchored on the left.
  const inferredActorId = latestObservedEvent && !hasRecipientPerspective
    ? latestObservedEvent.actorId
    : selfId;
  const currentActorId = model.currentActorId || inferredActorId;
  const currentActor = actors.find((actor) => actor.id === currentActorId)
    || selfActor;
  const observerView = !!(currentActor && currentActor.id !== selfId);
  const inferredTargetId = observerView && latestObservedEvent
    ? latestObservedEvent.targetId
    : '';
  const requestedTargetId = model.currentTargetId || inferredTargetId;
  const targetActor = actors.find((actor) => actor.id === requestedTargetId)
    || actors.find((actor) => actor.role === 'target');
  const playerId = currentActor ? currentActor.id : selfId;
  const targetId = targetActor ? targetActor.id : requestedTargetId;
  const additionalActors = actors.filter((actor) =>
    actor.id !== selfId
      && actor.id !== playerId
      && actor.id !== targetId
      && actor.role !== 'self'
      && actor.role !== 'target'
  );

  return {
    visualEnabled: model.visualEnabled,
    effective: model.effective,
    active: model.active,
    epoch: model.epoch,
    encounterId: model.encounterId,
    stateSeq: model.stateSeq,
    outcome: model.outcome,
    summary: model.summary,
    announcement: model.announcement || model.summary,
    reducedMotion: model.reducedMotion,
    event: model.currentEvent,
    history: model.history.slice(-model.limits.history),
    overflow: { ...model.overflow },
    player: {
      id: playerId,
      name: (currentActor && currentActor.name)
        || (observerView ? 'Combatant' : safeText(avatar.name, 120) || 'You'),
      image: observerView ? '' : safeText(avatar.url, 2048),
      health: observerView
        ? unavailableHealthSnapshot('unavailable')
        : healthSnapshot(vitals.hp, vitals.maxhp),
      // Char.Status describes the recipient only. An observed fight never
      // borrows it for somebody else's token.
      ...(observerView ? emptyDescriptor() : playerDescriptor(status)),
      // Wielded and worn items from Char.Items, recipient-only for the
      // same reason as the descriptor above.
      equipment: observerView ? null : equipmentProfile(inventory),
    },
    target: {
      id: targetId,
      name: (!observerView && enemyName)
        || (targetActor && targetActor.name)
        || 'Current target',
      image: observerView ? '' : safeText(enemy.enemy_image, 2048),
      condition: observerView ? '' : safeText(enemy.enemy_hp_string, 160),
      isNpc: !observerView && isNpcEnemy(enemy),
      health: !observerView && enemyName
        ? healthSnapshot(enemy.enemy_curhp, enemy.enemy_maxhp)
        : unavailableHealthSnapshot(observerView ? 'unavailable' : 'synchronizing'),
    },
    threats: additionalActors.slice(0, 4).map((actor) => ({
      id: actor.id,
      name: actor.name,
      role: actor.role,
    })),
    hiddenThreatCount: Math.max(0, additionalActors.length - 4),
  };
}

export function prefersReducedCombatMotion(matchMediaImpl) {
  if (typeof matchMediaImpl !== 'function') return false;
  try {
    return !!matchMediaImpl('(prefers-reduced-motion: reduce)').matches;
  } catch (error) {
    return false;
  }
}
