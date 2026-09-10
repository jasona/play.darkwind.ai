// Equipment profile for the combat figure, derived from the Char.Items
// inventory the Inventory panel already renders. Pure: no DOM, no GMCP.
//
// The protocol marks items wielded (`l`) or worn (`w`) and puts the slot in a
// trailing parenthetical of the name, but it carries no weapon type. The
// weapon kind below is therefore a keyword heuristic over the item name; an
// unrecognized name yields '' so the figure falls back to the guild weapon.

export const ITEM_SLOT_PATTERN = /\(([^)]+)\)\s*$/;

export const ITEM_SLOT_MAP = Object.freeze({
  'worn on head': 'Head',
  'worn around the neck': 'Neck',
  'worn over the shoulders': 'Shoulders',
  'worn on body': 'Body',
  'worn on body and legs': 'Body+Legs',
  'worn as a full suit of armour': 'FullSuit',
  'worn on hands': 'Hands',
  'worn on legs': 'Legs',
  'worn on feet': 'Feet',
  'worn on finger': 'Finger',
  'used as shield': 'Shield',
  'main weapon': 'Main Weapon',
  'secondary weapon': 'Off-hand',
  'used as light': 'Light',
});

export function itemSlot(name) {
  const match = String(name || '').match(ITEM_SLOT_PATTERN);
  return match ? (ITEM_SLOT_MAP[match[1]] || null) : null;
}

export function cleanItemName(name) {
  return String(name || '').replace(/^\*/, '').replace(ITEM_SLOT_PATTERN, '').trim();
}

// Order matters: earlier rows win, so "bow" beats a "blade" that appears in
// "bladed bow", and "staff" beats a "sword" in "swordstaff".
export const WEAPON_KEYWORDS = Object.freeze([
  ['bow', /\b(?:long|short|great|cross)?bows?\b|\bslings?\b|\bblowguns?\b/],
  ['staff', /\b(?:quarter)?staff\b|\bstaves\b|\brods?\b|\bwands?\b|\bscepters?\b|\bsceptres?\b/],
  ['polearm', /\bspears?\b|\bhalberds?\b|\bpikes?\b|\blances?\b|\bglaives?\b|\bbardiches?\b|\btridents?\b|\bpolearms?\b|\bnaginatas?\b/],
  ['axe', /\baxes?\b|\bhatchets?\b|\bcleavers?\b|\btomahawks?\b/],
  ['blunt', /\bmaces?\b|\bhammers?\b|\bclubs?\b|\bmauls?\b|\bflails?\b|\bmorningstars?\b|\bcudgels?\b|\bwarhammers?\b/],
  ['rapier', /\brapiers?\b|\bestocs?\b|\bfoils?\b|\bepees?\b/],
  ['knife', /\bdaggers?\b|\bdirks?\b|\bknives\b|\bknife\b|\bstilettos?\b|\bfangs?\b|\bkukris?\b|\bshivs?\b/],
  ['blade', /\bswords?\b|\bblades?\b|\bscimitars?\b|\bsab(?:re|er)s?\b|\bkatanas?\b|\brapiers?\b|\bcutlass(?:es)?\b|\bfalchions?\b|\bclaymores?\b|\bbroadswords?\b|\blongswords?\b|\bgreatswords?\b/],
  ['claws', /\bclaws?\b|\bknuckles?\b|\bcestus\b|\bfists?\b/],
]);

// "great" and "giant" match as prefixes too, so greatsword and giantaxe count.
const TWO_HANDED_PATTERN = /\b(?:great|giant)\w*|\b(?:two-handed|claymore|halberd|bardiche|maul|pike|lance|glaive|longbow)\b/;

export function classifyWeapon(name) {
  const text = cleanItemName(name).toLowerCase();
  if (!text) return '';
  for (const [kind, pattern] of WEAPON_KEYWORDS) {
    if (pattern.test(text)) return kind;
  }
  return '';
}

function hasAttribute(item, flag) {
  return !!(item && typeof item.attrib === 'string' && item.attrib.includes(flag));
}

function weaponEntry(item) {
  if (!item) return null;
  return { name: cleanItemName(item.name), kind: classifyWeapon(item.name) };
}

// `items` is the inventory array from Char.Items. Returns null when no
// inventory has been received, so callers can tell "nothing wielded" from
// "nothing known".
export function equipmentProfile(items) {
  if (!Array.isArray(items)) return null;
  let mainHand = null;
  let offHand = null;
  let shield = false;
  let helmet = false;
  let bodyArmor = false;
  const wielded = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const slot = itemSlot(item.name);
    const isWielded = hasAttribute(item, 'l');
    const isWorn = hasAttribute(item, 'w');
    if (isWielded) {
      if (slot === 'Main Weapon') mainHand = weaponEntry(item);
      else if (slot === 'Off-hand') offHand = weaponEntry(item);
      else wielded.push(weaponEntry(item));
    }
    if (isWorn || isWielded) {
      if (slot === 'Shield') shield = true;
      if (slot === 'Head' || slot === 'FullSuit') helmet = true;
      if (slot === 'Body' || slot === 'Body+Legs' || slot === 'FullSuit') bodyArmor = true;
    }
  }
  // A wielded item without a slot label is still a weapon in hand.
  if (!mainHand && wielded.length) mainHand = wielded.shift();
  if (!offHand && wielded.length) offHand = wielded.shift();
  const twoHanded = !!mainHand && !offHand && !shield
    && (['polearm', 'bow', 'staff'].includes(mainHand.kind)
      || TWO_HANDED_PATTERN.test(mainHand.name.toLowerCase()));
  return { mainHand, offHand, shield, helmet, bodyArmor, twoHanded };
}
