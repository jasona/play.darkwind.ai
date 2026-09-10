import { evaluateArithmeticExpression, isArithmeticExpressionCandidate } from './alias-expression-core.mjs';
import { tokenizeInput } from './completion-core.mjs';
import { FG_NAMES, BRIGHT_FG_NAMES } from './constants.js';

function resolveTemplateToken(token, context, missingVariables) {
  const value = String(token || '');
  if (value.startsWith('$')) {
    const variableName = value.slice(1);
    if (!Object.prototype.hasOwnProperty.call(context.variables, variableName)) {
      missingVariables.add(variableName);
      return '';
    }
    return String(context.variables[variableName] ?? '');
  }
  if (value === '%0') return context.remainder;
  if (/^%[1-9]$/.test(value)) return String(context.args[Number(value.slice(1)) - 1] ?? '');
  return value;
}

export function resolveDefinitionTemplate(template, context) {
  const missingVariables = new Set();
  const errors = [];
  const normalizedContext = {
    args: Array.isArray(context && context.args) ? context.args : [],
    remainder: context && typeof context.remainder === 'string' ? context.remainder : '',
    variables: context && context.variables && typeof context.variables === 'object' ? context.variables : {},
  };
  const text = String(template || '')
    .replace(/\$\{lower:([^}]+)\}/g, (_match, token) => (
      resolveTemplateToken(String(token || '').trim(), normalizedContext, missingVariables).toLowerCase()
    ))
    .replace(/\{([^{}]+)\}/g, (match, expression) => {
      const candidate = String(expression || '').trim();
      if (!isArithmeticExpressionCandidate(candidate)) return match;
      const result = evaluateArithmeticExpression(candidate, normalizedContext, missingVariables);
      errors.push(...result.errors);
      return result.errors.length ? '' : result.text;
    })
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)|%([0-9])/g, (_match, name, index) => (
      resolveTemplateToken(name ? '$' + name : '%' + index, normalizedContext, missingVariables)
    ));
  return { text, missingVariables: Array.from(missingVariables), errors };
}

export function matchAliasDefinitions(rawLine, aliases) {
  const line = String(rawLine || '');
  const inputTokens = tokenizeInput(line);
  if (!inputTokens.length) return null;
  const candidates = (Array.isArray(aliases) ? aliases : [])
    .filter((alias) => alias.enabled !== false)
    .slice()
    .sort((left, right) => {
      if (left.isRegex !== right.isRegex) return left.isRegex ? 1 : -1;
      if (left.isRegex) return 0;
      const tokenDifference = tokenizeInput(right.trigger).length - tokenizeInput(left.trigger).length;
      return tokenDifference || right.trigger.length - left.trigger.length;
    });

  for (const alias of candidates) {
    if (alias.isRegex) {
      try {
        const match = new RegExp(alias.trigger, alias.ignoreCase !== false ? 'i' : '').exec(line);
        if (match) return { alias, args: match.slice(1).map((value) => String(value ?? '')), remainder: String(match[0] ?? '') };
      } catch {
        // Invalid persisted definitions are ignored at execution time.
      }
      continue;
    }
    const triggerTokens = tokenizeInput(alias.trigger);
    if (!triggerTokens.length || triggerTokens.length > inputTokens.length) continue;
    if (!triggerTokens.every((token, index) => token.lower === inputTokens[index].lower)) continue;
    const remainderToken = inputTokens[triggerTokens.length];
    return {
      alias,
      args: inputTokens.slice(triggerTokens.length).map((token) => token.value),
      remainder: remainderToken ? line.slice(remainderToken.start).trimStart() : '',
    };
  }
  return null;
}

function compileTrigger(trigger) {
  if (trigger && typeof trigger === 'object' && compiledTriggerCache.has(trigger)) {
    return compiledTriggerCache.get(trigger);
  }
  const compiled = compileTriggerUncached(trigger);
  if (trigger && typeof trigger === 'object') compiledTriggerCache.set(trigger, compiled);
  return compiled;
}

function compileTriggerUncached(trigger) {
  const source = String(trigger.pattern || '').trim();
  if (!source) return null;
  let pattern = source;
  if (!trigger.isRegex) {
    pattern = '^' + source
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\\\*/g, '(.*?)')
      .replace(/%[1-9]/g, '(.*?)')
      .replace(/\s+/g, '\\s+') + '$';
  }
  try {
    return { ...trigger, regex: new RegExp(pattern, trigger.ignoreCase ? 'i' : '') };
  } catch {
    return null;
  }
}

export function evaluateTriggerDefinitions(text, triggers) {
  const line = String(text || '').replace(/^>\s?/, '');
  const matches = [];
  let gag = false;
  for (const trigger of (Array.isArray(triggers) ? triggers : [])) {
    if (trigger.enabled === false) continue;
    const compiled = compileTrigger(trigger);
    if (!compiled) continue;
    const match = compiled.regex.exec(line);
    if (!match) continue;
    matches.push({ trigger, fullMatch: String(match[0] ?? line), captures: match.slice(1).map((value) => String(value ?? '')) });
    gag = gag || Boolean(trigger.gag);
  }
  return { matches, gag };
}

const standardColors = new Map(FG_NAMES.map((name, index) => [name, { type: 'standard', index }]));
const brightColors = new Map(BRIGHT_FG_NAMES.map((name, index) => [name, { type: 'bright', index }]));

function parseColor(value) {
  const token = String(value || '').trim().toLowerCase();
  if (standardColors.has(token)) return standardColors.get(token);
  if (brightColors.has(token)) return brightColors.get(token);
  const ansi = token.match(/^(?:ansi|xterm)-([0-9]{1,3})$/);
  if (ansi && Number(ansi[1]) <= 255) return { type: '256', index: Number(ansi[1]) };
  const rgb = token.match(/^#([0-9a-f]{6})$/);
  if (rgb) return { type: 'rgb', r: parseInt(rgb[1].slice(0, 2), 16), g: parseInt(rgb[1].slice(2, 4), 16), b: parseInt(rgb[1].slice(4, 6), 16) };
  return null;
}

function cloneStyle(style = {}) {
  return { ...style, fg: style.fg ? { ...style.fg } : null, bg: style.bg ? { ...style.bg } : null };
}

// Structural equality for a style and its colours, without serialising them:
// this runs once per character of every highlighted line.
function sameColor(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}
function sameStyle(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === 'fg' || key === 'bg') {
      if (!sameColor(a[key], b[key])) return false;
    } else if (a[key] !== b[key]) return false;
  }
  return true;
}

// Compiled patterns keyed by the definition object they came from. Definitions
// live in the configuration snapshot, so the same object arrives line after
// line and the RegExp is built once instead of once per line.
const compiledHighlightCache = new WeakMap();
const compiledTriggerCache = new WeakMap();

function compileHighlightDefinition(rule) {
  if (!rule || typeof rule !== 'object') return null;
  if (compiledHighlightCache.has(rule)) return compiledHighlightCache.get(rule);
  let compiled = null;
  try {
    compiled = { ...rule, regex: new RegExp(rule.patternSource, 'g' + (rule.ignoreCase ? 'i' : '')) };
  } catch {
    compiled = null;
  }
  compiledHighlightCache.set(rule, compiled);
  return compiled;
}

export function compileHighlightDefinitions(rules) {
  return (Array.isArray(rules) ? rules : []).flatMap((rule) => {
    if (rule.enabled === false) return [];
    const compiled = compileHighlightDefinition(rule);
    return compiled ? [compiled] : [];
  });
}

export function applyHighlightDefinitionsToLine(line, rules) {
  const compiled = rules.some((rule) => rule.regex) ? rules : compileHighlightDefinitions(rules);
  if (!line?.text || !Array.isArray(line.fragments) || !compiled.length) return line;
  const owners = new Array(line.text.length).fill(-1);
  compiled.forEach((entry, entryIndex) => {
    entry.regex.lastIndex = 0;
    for (let match = entry.regex.exec(line.text); match; match = entry.regex.exec(line.text)) {
      if (!match[0]) {
        entry.regex.lastIndex++;
        continue;
      }
      for (let index = match.index; index < match.index + match[0].length; index++) {
        if (owners[index] === -1) owners[index] = entryIndex;
      }
    }
  });
  const fragments = [];
  let offset = 0;
  for (const fragment of line.fragments) {
    for (const character of String(fragment.text || '')) {
      const owner = compiled[owners[offset++]];
      const style = cloneStyle(fragment.style);
      const href = fragment.href || null;
      if (owner) {
        style.bold = Boolean(owner.style.bold);
        style.fg = parseColor(owner.style.fg);
        style.bg = parseColor(owner.style.bg);
      }
      const previous = fragments.at(-1);
      if (previous && previous.href === href && sameStyle(previous.style, style)) previous.text += character;
      else fragments.push({ text: character, style, href });
    }
  }
  return { ...line, fragments };
}
