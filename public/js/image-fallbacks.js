export const PLAYER_FALLBACK_IMAGE = '/assets/avatar-ghost.svg';
export const NPC_FALLBACK_IMAGE = '/assets/generic-monster.png';

export function npcImageSource(source) {
  return typeof source === 'string' && source.trim()
    ? source
    : NPC_FALLBACK_IMAGE;
}

export function isNpcEnemy(enemy) {
  if (!enemy || typeof enemy !== 'object') return false;

  if (Object.prototype.hasOwnProperty.call(enemy, 'enemy_is_npc')) {
    const explicit = String(enemy.enemy_is_npc).trim().toLowerCase();
    return explicit === '1' || explicit === 'true' || explicit === 'on';
  }

  const condition = String(enemy.enemy_hp_string || '').trim().toLowerCase();
  return condition !== '' && condition !== 'none';
}

export function applyNpcImageFallback(img) {
  if (!img) return false;
  const current = typeof img.getAttribute === 'function'
    ? img.getAttribute('src')
    : img.src;
  if (current === NPC_FALLBACK_IMAGE ||
      String(img.src || '').endsWith(NPC_FALLBACK_IMAGE)) {
    return false;
  }
  img.src = NPC_FALLBACK_IMAGE;
  return true;
}

// Portraits shipped in public/assets/avatars, one per gender and race. The
// server usually picks one of these itself through Darkwind.Char.Avatar; the
// client resolves the same file from Char.Status so the combat token has a
// face before that message arrives or when a generated portrait fails.
export const BUNDLED_PORTRAIT_GENDERS = Object.freeze(['female', 'male']);
export const BUNDLED_PORTRAIT_RACES = Object.freeze([
  'arctic-elf', 'barbarian', 'crannian-gnome', 'darkwinder', 'desert-dwarf',
  'desert-nomad', 'dragon', 'faerie', 'glavian', 'gypsy', 'halfling',
  'high-elf', 'hyperborean-gnome', 'ice-gnoll', 'ice-ogre', 'kender',
  'northman', 'pixie', 'rift-duergar', 'scro', 'shel-zaranite', 'sidhe',
  'silver-elf', 'souvraeli', 'stone-dwarf', 'swamp-troll', 'sylph',
  'thraxian', 'uruk', 'wayfarian', 'yugoloth',
]);
const BUNDLED_RACE_SET = new Set(BUNDLED_PORTRAIT_RACES);

export function portraitSlug(value) {
  return String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Returns the bundled portrait path for a race and gender pair, or '' when
// the pair has no shipped file. Only known slugs become URLs, so server text
// never reaches a path.
export function bundledPortraitFor(race, gender) {
  const genderSlug = portraitSlug(gender);
  const raceSlug = portraitSlug(race);
  if (!BUNDLED_PORTRAIT_GENDERS.includes(genderSlug)) return '';
  if (!BUNDLED_RACE_SET.has(raceSlug)) return '';
  return '/assets/avatars/' + genderSlug + '-' + raceSlug + '.png';
}
