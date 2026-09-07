import test from 'node:test';
import assert from 'node:assert/strict';

const {
  classifyWeapon,
  cleanItemName,
  equipmentProfile,
  itemSlot,
} = await import('../public/js/combat-equipment-core.mjs');

test('slot and name parsing match the Inventory panel', () => {
  assert.equal(itemSlot('a steel sword (main weapon)'), 'Main Weapon');
  assert.equal(itemSlot('a buckler (used as shield)'), 'Shield');
  assert.equal(itemSlot('a plate suit (worn as a full suit of armour)'), 'FullSuit');
  assert.equal(itemSlot('a torch (unknown slot)'), null);
  assert.equal(itemSlot('a torch'), null);
  assert.equal(cleanItemName('*a steel sword (main weapon)'), 'a steel sword');
});

test('weapon kinds come from name keywords with earlier rows winning', () => {
  assert.equal(classifyWeapon('a steel sword (main weapon)'), 'blade');
  assert.equal(classifyWeapon('a jagged dagger'), 'knife');
  assert.equal(classifyWeapon('a slender rapier (main weapon)'), 'rapier');
  assert.equal(classifyWeapon('a great axe'), 'axe');
  assert.equal(classifyWeapon('a spiked mace'), 'blunt');
  assert.equal(classifyWeapon('a longspear'), '', 'no word boundary means no match');
  assert.equal(classifyWeapon('a long spear'), 'polearm');
  assert.equal(classifyWeapon('an oak quarterstaff'), 'staff');
  assert.equal(classifyWeapon('a yew longbow'), 'bow');
  assert.equal(classifyWeapon('a bladed bow'), 'bow');
  assert.equal(classifyWeapon('brass knuckles'), 'claws');
  assert.equal(classifyWeapon('Whisper'), '', 'flavor names are unknown');
  assert.equal(classifyWeapon(''), '');
  assert.equal(classifyWeapon(undefined), '');
});

test('equipmentProfile reads hands, shield, and armor from the inventory list', () => {
  assert.equal(equipmentProfile(undefined), null, 'no inventory received');
  assert.equal(equipmentProfile('nope'), null);

  const empty = equipmentProfile([]);
  assert.deepEqual(empty, { mainHand: null, offHand: null, shield: false, helmet: false, bodyArmor: false, twoHanded: false });

  const fighter = equipmentProfile([
    { id: 's1', name: 'a steel sword (main weapon)', attrib: 'l' },
    { id: 'b1', name: 'a round shield (used as shield)', attrib: 'w' },
    { id: 'h1', name: 'an iron helm (worn on head)', attrib: 'w' },
    { id: 'c1', name: 'a chain hauberk (worn on body)', attrib: 'w' },
    { id: 'p1', name: 'a backpack', attrib: 'c' },
    { id: 'r1', name: 'a torch (used as light)', attrib: 'w' },
    null,
  ]);
  assert.equal(fighter.mainHand.kind, 'blade');
  assert.equal(fighter.mainHand.name, 'a steel sword');
  assert.equal(fighter.offHand, null);
  assert.equal(fighter.shield, true);
  assert.equal(fighter.helmet, true);
  assert.equal(fighter.bodyArmor, true);
  assert.equal(fighter.twoHanded, false);

  const rogue = equipmentProfile([
    { id: 'k1', name: 'a dirk (main weapon)', attrib: 'l' },
    { id: 'k2', name: 'a dagger (secondary weapon)', attrib: 'l' },
    { id: 'l1', name: 'leather leggings (worn on legs)', attrib: 'w' },
  ]);
  assert.equal(rogue.mainHand.kind, 'knife');
  assert.equal(rogue.offHand.kind, 'knife');
  assert.equal(rogue.bodyArmor, false);

  const halberdier = equipmentProfile([
    { id: 'h', name: 'a halberd (main weapon)', attrib: 'l' },
    { id: 'suit', name: 'a plate suit (worn as a full suit of armour)', attrib: 'w' },
  ]);
  assert.equal(halberdier.mainHand.kind, 'polearm');
  assert.equal(halberdier.twoHanded, true);
  assert.equal(halberdier.helmet, true);
  assert.equal(halberdier.bodyArmor, true);

  const unlabeled = equipmentProfile([
    { id: 'x', name: 'Whisper', attrib: 'l' },
    { id: 'y', name: 'a great axe', attrib: 'l' },
  ]);
  assert.equal(unlabeled.mainHand.name, 'Whisper');
  assert.equal(unlabeled.mainHand.kind, '', 'unknown kind leaves the guild fallback in play');
  assert.equal(unlabeled.offHand.kind, 'axe');
  assert.equal(unlabeled.twoHanded, false, 'an off-hand weapon rules out a two-handed grip');

  const greatsword = equipmentProfile([{ id: 'g', name: 'a greatsword (main weapon)', attrib: 'l' }]);
  assert.equal(greatsword.mainHand.kind, 'blade');
  assert.equal(greatsword.twoHanded, true);
});
