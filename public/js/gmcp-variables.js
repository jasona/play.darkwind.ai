import {
  getGmcpVariables as bridgeGetGmcpVariables,
  isAutomationCompatActive,
  listGmcpVariables as bridgeListGmcpVariables,
  resetGmcpVariables as bridgeResetGmcpVariables,
  setGmcpVariable,
} from './session-compat/automation.js';

const GMCP_VARIABLE_PREFIX = 'gmcp';
const runtimeVariables = {};
// Frames not yet flattened, latest payload per package; flattened on read.
const pendingFrames = new Map();

function drainPendingFrames() {
  if (!pendingFrames.size) return;
  const frames = Array.from(pendingFrames.values());
  pendingFrames.clear();
  for (const frame of frames) flattenValue(frame.name, frame.data);
}

// Key names repeat across every payload; normalise each distinct one once.
const SEGMENT_CACHE_LIMIT = 20000;
const segmentCache = new Map();

function toVariableSegment(value) {
  const raw = String(value || '');
  const cached = segmentCache.get(raw);
  if (cached !== undefined) return cached;
  const segment = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (segmentCache.size >= SEGMENT_CACHE_LIMIT) segmentCache.clear();
  segmentCache.set(raw, segment);
  return segment;
}

function childVariableName(parentName, key) {
  const segment = toVariableSegment(key);
  if (!segment) return parentName;
  return parentName ? parentName + '_' + segment : segment;
}

function variableNameFor(parts) {
  return [GMCP_VARIABLE_PREFIX, ...parts]
    .map(toVariableSegment)
    .filter(Boolean)
    .join('_');
}

function serializeValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function setVariable(name, value) {
  if (!name || name === GMCP_VARIABLE_PREFIX) return;
  runtimeVariables[name] = serializeValue(value);
}

// The name is built on the way down instead of re-normalising the whole path
// at every node.
function flattenValue(name, value) {
  if (value === undefined) return;

  if (value === null || typeof value !== 'object') {
    setVariable(name, value);
    return;
  }

  setVariable(name, value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      flattenValue(childVariableName(name, String(index)), item);
    });
    return;
  }

  Object.entries(value).forEach(([key, item]) => {
    flattenValue(childVariableName(name, key), item);
  });
}

function dispatchGmcpVariablesChanged(detail) {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('darkwind:gmcp-variables-changed', {
      detail,
    }));
  }
}

export function registerGmcpVariables(packageName, data) {
  if (isAutomationCompatActive()) {
    setGmcpVariable(packageName, data);
  } else {
    const packageParts = String(packageName || '')
      .split('.')
      .map(toVariableSegment)
      .filter(Boolean);

    if (!packageParts.length) return;
    const name = variableNameFor(packageParts);
    pendingFrames.delete(name);
    pendingFrames.set(name, { name, data: data === undefined ? '' : data });
  }

  dispatchGmcpVariablesChanged({ packageName });
}

export function resetGmcpVariables() {
  if (isAutomationCompatActive()) {
    bridgeResetGmcpVariables();
  } else {
    pendingFrames.clear();
    Object.keys(runtimeVariables).forEach((key) => {
      delete runtimeVariables[key];
    });
  }

  dispatchGmcpVariablesChanged({ reset: true });
}

export function getGmcpVariables() {
  if (isAutomationCompatActive()) {
    return bridgeGetGmcpVariables();
  }
  drainPendingFrames();
  return { ...runtimeVariables };
}

export function listGmcpVariables() {
  if (isAutomationCompatActive()) {
    return bridgeListGmcpVariables();
  }
  drainPendingFrames();
  return Object.entries(runtimeVariables)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([name, value]) => ({ name, value }));
}
