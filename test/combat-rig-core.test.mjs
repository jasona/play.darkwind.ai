import test from 'node:test';
import assert from 'node:assert/strict';

const {
  MELEE_WEAPONS,
  POSES,
  STRIKE_POSE_BY_WEAPON,
  WEAPONS,
  figureGeometry,
  figureHeight,
  posePhase,
  resolveFigure,
  poseWeaponFor,
  resolvePose,
  solveLeg,
} = await import('../public/js/combat-rig-core.mjs');

const still = { reducedMotion: true };

test('figures resolve weapon from guild, scale from race, and beast form for NPC targets', () => {
  assert.equal(resolveFigure({ guild: 'Mage', race: 'High Elf' }, 'player').weapon, 'staff');
  assert.equal(resolveFigure({ guild: 'Ranger' }, 'player').weapon, 'bow');
  assert.equal(resolveFigure({ guild: 'Monk' }, 'player').weapon, 'claws');
  assert.equal(resolveFigure({ guild: 'Street Samurai' }, 'player').weapon, 'blade');
  assert.equal(resolveFigure({ guild: 'unknown guild' }, 'player').weapon, 'blade');
  assert.equal(resolveFigure({}, 'player').weapon, 'blade');
  assert.ok(resolveFigure({ race: 'Pixie' }, 'player').scale < 1);
  assert.ok(resolveFigure({ race: 'Ice Ogre' }, 'player').scale > 1);
  assert.equal(resolveFigure({ race: 'Darkwinder' }, 'player').scale, 1);
  assert.equal(resolveFigure({}, 'player').facing, 1);

  const beast = resolveFigure({ isNpc: true, guild: 'Mage' }, 'target');
  assert.equal(beast.kind, 'beast');
  assert.equal(beast.weapon, 'claws', 'NPC targets ignore guild text');
  assert.equal(beast.facing, -1);
  const rival = resolveFigure({ isNpc: false, guild: 'Fighter' }, 'target');
  assert.equal(rival.kind, 'humanoid');
  assert.equal(rival.weapon, 'blade');
  for (const weapon of WEAPONS) assert.ok(STRIKE_POSE_BY_WEAPON[weapon] in POSES);
  for (const weapon of MELEE_WEAPONS) assert.ok(WEAPONS.includes(weapon));
});

test('equipment outranks guild for the weapon and adds shield, helmet, and armor', () => {
  const armed = resolveFigure({
    guild: 'Mage',
    equipment: {
      mainHand: { name: 'a great axe', kind: 'axe' },
      offHand: null,
      shield: true,
      helmet: true,
      bodyArmor: true,
      twoHanded: false,
    },
  }, 'player');
  assert.equal(armed.weapon, 'axe');
  assert.equal(armed.offKind, '');
  assert.equal(armed.shield, true);
  assert.equal(armed.helmet, true);
  assert.equal(armed.armor, true);

  const bare = resolveFigure({ guild: 'Fighter', equipment: { mainHand: null, offHand: null, shield: false, helmet: false, bodyArmor: false, twoHanded: false } }, 'player');
  assert.equal(bare.weapon, 'claws', 'an inventory with nothing wielded means bare hands');

  const unknown = resolveFigure({ guild: 'Ranger', equipment: { mainHand: { name: 'Whisper', kind: '' }, offHand: { name: 'a dirk', kind: 'knife' }, shield: false, helmet: false, bodyArmor: false, twoHanded: false } }, 'player');
  assert.equal(unknown.weapon, 'bow', 'an unrecognized main-hand name keeps the guild weapon');
  assert.equal(unknown.offKind, 'knife');

  const noInventory = resolveFigure({ guild: 'Ranger', equipment: null }, 'player');
  assert.equal(noInventory.weapon, 'bow');

  const beast = resolveFigure({ isNpc: true, equipment: { mainHand: { name: 'a sword', kind: 'blade' } } }, 'target');
  assert.equal(beast.weapon, 'claws', 'beasts ignore equipment');

  const geo = figureGeometry(armed, resolvePose(null, 0, still), 100, 300, 40);
  assert.equal(geo.shield, true);
  assert.equal(geo.helmet, true);
  assert.equal(geo.armor, true);
  assert.equal(typeof geo.weapon.offDx, 'number');
});

test('pose phases anticipate, snap, hold, and settle along the action timeline', () => {
  const hit = { result: 'hit', landed: true };
  assert.deepEqual(posePhase('actor', hit, 0), { from: 'idle', to: 'windup', t: 0, ease: 'settle' });
  assert.equal(posePhase('actor', hit, 0.1).t, 1, 'windup holds before the strike');
  const snap = posePhase('actor', hit, 0.145);
  assert.equal(snap.to, 'strike');
  assert.equal(snap.ease, 'snap');
  assert.ok(snap.t > 0 && snap.t < 1);
  assert.equal(posePhase('actor', hit, 0.25).to, 'strike');
  assert.equal(posePhase('actor', hit, 0.25).t, 1, 'follow-through holds');
  assert.equal(posePhase('actor', hit, 0.5).to, 'idle');
  assert.equal(posePhase('actor', hit, 0.7), null);
  assert.equal(posePhase('actor', hit, 0.145, 'staff').to, 'cast');
  assert.equal(posePhase('actor', hit, 0.145, 'bow').to, 'loose');
  assert.equal(posePhase('actor', hit, 0.05, 'bow').to, 'draw');
  assert.equal(posePhase('actor', hit, 0.05, 'axe').to, 'raise');
  assert.equal(posePhase('actor', hit, 0.145, 'blunt').to, 'chop');
  assert.equal(posePhase('actor', hit, 0.145, 'polearm').to, 'thrust');
  assert.equal(posePhase('actor', hit, 0.145, 'rapier').to, 'thrust');
  assert.equal(posePhase('actor', hit, 0.145, 'claws').to, 'maul');
  assert.equal(posePhase('actor', { result: 'miss', landed: false }, 0.145).to, 'whiff');

  assert.equal(posePhase('impact', hit, 0.1), null, 'victim waits for contact');
  assert.equal(posePhase('impact', hit, 0.2).to, 'recoil');
  assert.equal(posePhase('impact', hit, 0.2).ease, 'snap');
  assert.equal(posePhase('impact', hit, 0.35).t, 1, 'recoil holds');
  assert.equal(posePhase('impact', hit, 0.6).from, 'recoil');
  assert.equal(posePhase('impact', { result: 'dodge', landed: false }, 0.15).to, 'dodge');
  assert.equal(posePhase('impact', { result: 'absorb', landed: false }, 0.3).to, 'guard');
  assert.equal(posePhase('impact', { result: 'miss', landed: false }, 0.3), null);
  assert.equal(posePhase('bystander', hit, 0.3), null);
});

test('resolvePose blends between poses and rests exactly on idle under reduced motion', () => {
  const idle = resolvePose(null, 0, still);
  assert.deepEqual(idle, { ...POSES.idle });
  const start = resolvePose({ from: 'idle', to: 'strike', t: 0 }, 0, still);
  assert.deepEqual(start, { ...POSES.idle });
  const end = resolvePose({ from: 'idle', to: 'strike', t: 1 }, 0, still);
  assert.deepEqual(end, { ...POSES.strike });
  const mid = resolvePose({ from: 'idle', to: 'strike', t: 0.5, ease: 'settle' }, 0, still);
  assert.ok(mid.rShoulder > POSES.idle.rShoulder && mid.rShoulder < POSES.strike.rShoulder);
  const snapped = resolvePose({ from: 'idle', to: 'strike', t: 0.5, ease: 'snap' }, 0, still);
  assert.ok(snapped.rShoulder > mid.rShoulder, 'snap easing is ahead of settle easing at the midpoint');
  const breathing = resolvePose(null, 700, {});
  assert.notEqual(breathing.lean, POSES.idle.lean, 'idle breath moves the torso when motion is allowed');
});

test('two-bone leg solver honors limb lengths and bends the knee toward the requested side', () => {
  const hip = { x: 0, y: 0 };
  const solved = solveLeg(hip, { x: 10, y: 40 }, 30, 25, 1);
  const thigh = Math.hypot(solved.knee.x - hip.x, solved.knee.y - hip.y);
  const shin = Math.hypot(solved.foot.x - solved.knee.x, solved.foot.y - solved.knee.y);
  assert.ok(Math.abs(thigh - 30) < 1e-6);
  assert.ok(Math.abs(shin - 25) < 1e-6);
  assert.equal(solved.stretched, false);
  assert.ok(solved.knee.x > 10 * (solved.knee.y / 40), 'knee bows toward facing');
  const mirrored = solveLeg(hip, { x: 10, y: 40 }, 30, 25, -1);
  assert.ok(mirrored.knee.x < solved.knee.x, 'opposite bend direction puts the knee on the other side');
  const tooFar = solveLeg(hip, { x: 0, y: 200 }, 30, 25, 1);
  assert.equal(tooFar.stretched, true);
  assert.ok(Math.hypot(tooFar.foot.x, tooFar.foot.y) <= 55, 'out-of-reach foot is pulled back within reach');
});

test('geometry stands the figure on the ground line, faces the right way, and keeps feet planted through a lunge', () => {
  const figure = resolveFigure({ guild: 'Fighter' }, 'player');
  const joints = resolvePose(null, 0, still);
  const geo = figureGeometry(figure, joints, 100, 300, 40);
  assert.ok(Math.abs(geo.legs.front.foot.y - 300) < 1, 'front foot rests on the ground line');
  assert.ok(Math.abs(geo.legs.rear.foot.y - 300) < 1, 'rear foot rests on the ground line');
  assert.ok(geo.head.y < geo.shoulder.y && geo.shoulder.y < geo.hip.y, 'head above shoulders above hips');
  assert.ok(geo.head.y - geo.head.r > 300 - figureHeight(figure, 40) - 1, 'head fits within the figure height budget');
  const height = 300 - (geo.head.y - geo.head.r);
  assert.ok(height / (geo.head.r * 2) > 4, 'figure stands more than four heads tall');
  assert.ok(geo.torso.shoulderFront.x - geo.torso.shoulderBack.x > geo.torso.hipFront.x - geo.torso.hipBack.x, 'shoulders are wider than hips');
  assert.equal(geo.facing, 1);

  // A lunge moves the hip but not the planted feet.
  const lunged = figureGeometry(figure, joints, 112, 300, 40, { baseX: 100 });
  assert.equal(lunged.hip.x, 112);
  assert.ok(Math.abs(lunged.legs.rear.foot.x - geo.legs.rear.foot.x) < 1e-6, 'rear foot stays planted');
  assert.ok(Math.abs(lunged.legs.front.foot.x - geo.legs.front.foot.x) < 1e-6, 'front foot stays planted');

  const strike = figureGeometry(figure, resolvePose({ from: 'idle', to: 'strike', t: 1 }, 0, still), 100, 300, 40);
  assert.ok(strike.arms.right.hand.x > geo.arms.right.hand.x, 'a strike pushes the weapon hand forward');
  assert.ok(strike.weapon.dx > 0, 'the weapon points toward the target');
  assert.ok(strike.legs.front.foot.x > geo.legs.front.foot.x, 'the front foot steps into the strike');

  const stretched = figureGeometry(figure, joints, 100, 300, 40, { stretch: 1.1 });
  assert.ok(stretched.head.y < geo.head.y, 'stretch lifts the head');
  assert.ok(stretched.torso.shoulderFront.x - stretched.torso.shoulderBack.x < geo.torso.shoulderFront.x - geo.torso.shoulderBack.x, 'stretch narrows the body');

  const enemy = resolveFigure({ isNpc: true }, 'target');
  const enemyStrike = figureGeometry(enemy, resolvePose({ from: 'idle', to: 'maul', t: 1 }, 0, still), 400, 300, 40);
  assert.ok(enemyStrike.arms.right.hand.x < enemyStrike.hip.x, 'the enemy strikes toward the left');
  assert.ok(enemyStrike.shoulder.x < enemyStrike.hip.x, 'a beast leans toward its prey');
  assert.equal(enemyStrike.tail, true);
  assert.equal(geo.cloak, true);
});

test('blade and axe swings come over the top, and strikes land pointing forward and down', () => {
  const figure = resolveFigure({ guild: 'Fighter' }, 'player');
  const at = (phase) => figureGeometry(figure, resolvePose(phase, 0, still), 100, 300, 40);
  const windup = at({ from: 'windup', to: 'windup', t: 1 });
  assert.ok(windup.arms.right.hand.y < windup.shoulder.y, 'windup carries the hand above the shoulder');
  assert.ok(windup.weapon.dy < 0, 'blade points upward in the windup');
  const mid = at({ from: 'windup', to: 'strike', t: 0.5, ease: 'settle' });
  assert.ok(mid.arms.right.hand.y < windup.shoulder.y, 'mid-swing the hand is still overhead, not below the hip');
  const strike = at({ from: 'strike', to: 'strike', t: 1 });
  assert.ok(strike.weapon.dx > 0 && strike.weapon.dy > 0, 'the strike lands with the blade forward and down');
  const raise = at({ from: 'raise', to: 'raise', t: 1 });
  assert.ok(raise.arms.right.hand.y < raise.head.y, 'an axe is raised above the head');
  const chop = at({ from: 'chop', to: 'chop', t: 1 });
  assert.ok(chop.weapon.dx > 0 && chop.weapon.dy > 0, 'the chop lands forward and down');
  const whiff = at({ from: 'whiff', to: 'whiff', t: 1 });
  assert.ok(whiff.weapon.dy > 0, 'a whiff overextends downward');
});

test('a staff casts only for caster guilds; anyone else swings it', () => {
  const mage = resolveFigure({ guild: 'Mage', equipment: { mainHand: { name: 'an oak staff', kind: 'staff' }, offHand: null, shield: false, helmet: false, bodyArmor: false, twoHanded: true } }, 'player');
  assert.equal(mage.caster, true);
  assert.equal(poseWeaponFor(mage), 'staff');
  const monk = resolveFigure({ guild: 'Monk', equipment: { mainHand: { name: 'a bo staff', kind: 'staff' }, offHand: null, shield: false, helmet: false, bodyArmor: false, twoHanded: true } }, 'player');
  assert.equal(monk.caster, false);
  assert.equal(monk.weapon, 'staff');
  assert.equal(poseWeaponFor(monk), 'blade', 'a monk swings the staff with the blade poses');
  assert.equal(posePhase('actor', { result: 'hit', landed: true }, 0.145, poseWeaponFor(monk)).to, 'strike');
  assert.equal(posePhase('actor', { result: 'hit', landed: true }, 0.145, poseWeaponFor(mage)).to, 'cast');
  const idle = figureGeometry(mage, resolvePose(null, 0, still), 100, 300, 40);
  assert.ok(idle.weapon.dy > 0, 'at rest the grip points down, so the staff head (drawn opposite) is up');
  const cast = figureGeometry(mage, resolvePose({ from: 'cast', to: 'cast', t: 1 }, 0, still), 100, 300, 40);
  assert.ok(-cast.weapon.dx > 0, 'in a cast the staff head (opposite the grip) points at the target');
  assert.equal(figureGeometry(monk, resolvePose(null, 0, still), 100, 300, 40).caster, false);
  assert.equal(resolveFigure({ isNpc: true, guild: 'Mage' }, 'target').caster, false, 'beasts never cast');
});
