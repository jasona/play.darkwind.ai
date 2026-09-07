// Procedural fighter rig for the canvas combat stage. Pure math: figures,
// poses, and joint geometry, with no drawing and no DOM. combat-stage.mjs
// renders what figureGeometry() returns.
//
// A figure is a jointed body whose head is the portrait disc the stage
// already draws. Equipment (or guild) picks the weapon, race picks the
// scale, and NPC targets get a hunched beast variant. Arms are posed by
// angle; legs are solved by two-bone inverse kinematics toward foot targets
// so the feet stay planted while the body lunges. Pose names are the seam
// for later sprite sheets: whatever replaces the shapes only has to honor
// the same names and blend weights.

// Body units. A humanoid stands about 2.9 units tall with a 0.62 unit head,
// so it reads at roughly four and a half heads: stylized, not chibi.
const HUMANOID = Object.freeze({
  kind: 'humanoid',
  // Hip sits below full leg extension so the knees keep slack for lunges.
  hipHeight: 1.08,
  torso: 0.92,
  neck: 0.08,
  head: 0.31,
  upperArm: 0.5,
  forearm: 0.46,
  thigh: 0.64,
  shin: 0.6,
  shoulderHalf: 0.34,
  hipHalf: 0.22,
  upperArmWidth: 0.2,
  forearmWidth: 0.16,
  thighWidth: 0.25,
  shinWidth: 0.19,
  handRadius: 0.1,
  footLength: 0.3,
  baseLean: 0,
  frontFoot: 0.28,
  rearFoot: -0.26,
  cloak: true,
  tail: false,
});

const BEAST = Object.freeze({
  kind: 'beast',
  hipHeight: 0.9,
  torso: 0.88,
  neck: 0.05,
  head: 0.36,
  upperArm: 0.62,
  forearm: 0.56,
  thigh: 0.52,
  shin: 0.52,
  shoulderHalf: 0.48,
  hipHalf: 0.32,
  upperArmWidth: 0.28,
  forearmWidth: 0.22,
  thighWidth: 0.32,
  shinWidth: 0.24,
  handRadius: 0.13,
  footLength: 0.36,
  baseLean: 0.62,
  frontFoot: 0.3,
  rearFoot: -0.32,
  cloak: false,
  tail: true,
});

const WEAPON_BY_GUILD = Object.freeze({
  fighter: 'blade',
  berserker: 'blade',
  swashbuckler: 'blade',
  'street-samurai': 'blade',
  ninja: 'blade',
  thief: 'blade',
  charlatan: 'blade',
  bard: 'blade',
  mage: 'staff',
  acolyte: 'staff',
  druid: 'staff',
  artificer: 'staff',
  psionicist: 'staff',
  ranger: 'bow',
  monk: 'claws',
  garou: 'claws',
  vampire: 'claws',
  morpher: 'claws',
  dragon: 'claws',
});

// Guilds whose staff is a focus: they cast with it and the stage draws an
// orb and a bolt. Anyone else holding a staff swings it.
const CASTER_GUILDS = new Set(['mage', 'acolyte', 'druid', 'artificer', 'psionicist']);

const SCALE_BY_RACE = Object.freeze({
  pixie: 0.72,
  faerie: 0.76,
  sylph: 0.82,
  kender: 0.84,
  halfling: 0.84,
  'crannian-gnome': 0.84,
  'hyperborean-gnome': 0.84,
  'desert-dwarf': 0.9,
  'stone-dwarf': 0.9,
  'rift-duergar': 0.9,
  barbarian: 1.08,
  northman: 1.05,
  uruk: 1.12,
  scro: 1.1,
  'ice-gnoll': 1.12,
  'ice-ogre': 1.22,
  'swamp-troll': 1.2,
  yugoloth: 1.18,
  dragon: 1.25,
});

export const WEAPONS = Object.freeze(['blade', 'rapier', 'knife', 'axe', 'blunt', 'polearm', 'staff', 'bow', 'claws']);
export const MELEE_WEAPONS = Object.freeze(['blade', 'rapier', 'knife', 'axe', 'blunt', 'polearm', 'claws']);

function slug(value) {
  return String(value === undefined || value === null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The equipment profile (from Char.Items) outranks guild: a wielded item
// with a recognized kind sets the weapon, an inventory with nothing wielded
// means bare hands, and an unrecognized name keeps the guild weapon.
function weaponFromEquipment(equipment, guildWeapon) {
  if (!equipment) return { weapon: guildWeapon, offKind: '' };
  const main = equipment.mainHand;
  const off = equipment.offHand;
  let weapon = guildWeapon;
  if (!main) weapon = 'claws';
  else if (main.kind && WEAPONS.includes(main.kind)) weapon = main.kind;
  const offKind = off && off.kind && WEAPONS.includes(off.kind) ? off.kind : '';
  return { weapon, offKind };
}

export function resolveFigure(combatant = {}, side = 'player') {
  const isBeast = side === 'target' && !!combatant.isNpc;
  const guild = slug(combatant.guild);
  const race = slug(combatant.race);
  const equipment = isBeast ? null : (combatant.equipment || null);
  const held = isBeast
    ? { weapon: 'claws', offKind: '' }
    : weaponFromEquipment(equipment, WEAPON_BY_GUILD[guild] || 'blade');
  return {
    kind: isBeast ? 'beast' : 'humanoid',
    proportions: isBeast ? BEAST : HUMANOID,
    weapon: held.weapon,
    offKind: held.offKind,
    shield: !!(equipment && equipment.shield),
    helmet: !!(equipment && equipment.helmet),
    armor: !!(equipment && equipment.bodyArmor),
    twoHanded: !!(equipment && equipment.twoHanded),
    caster: !isBeast && CASTER_GUILDS.has(guild),
    scale: isBeast ? 1.08 : (SCALE_BY_RACE[race] || 1),
    facing: side === 'player' ? 1 : -1,
  };
}

// The weapon kind that drives poses. A staff in a non-caster's hands is
// swung like a blade rather than cast with.
export function poseWeaponFor(figure) {
  if (!figure) return 'blade';
  if (figure.weapon === 'staff' && !figure.caster) return 'blade';
  return figure.weapon || 'blade';
}

// Joint parameters. Shoulder angles measure from straight down, positive
// toward the facing direction; elbows are relative to the upper arm. `lean`
// rotates the torso forward about the hip, `hop` lifts the hip in body
// units, and the foot fields are offsets from the rest stance in body units
// (x positive toward facing, y positive upward off the ground).
const REST = Object.freeze({
  lean: 0,
  hop: 0,
  headTilt: 0,
  rShoulder: 0.25,
  rElbow: -0.5,
  lShoulder: -0.18,
  lElbow: -0.4,
  weapon: 0.35,
  frontFootX: 0,
  frontFootY: 0,
  rearFootX: 0,
  rearFootY: 0,
});

function pose(overrides) {
  return Object.freeze({ ...REST, ...overrides });
}

export const POSES = Object.freeze({
  idle: REST,
  // Arm raised up and back with the blade above the head; the blend to
  // strike passes through straight up (pi), so the swing comes over the top.
  windup: pose({ lean: -0.2, rShoulder: 3.4, rElbow: -0.5, lShoulder: 0.55, lElbow: -0.6, weapon: 0.9, rearFootX: -0.08, frontFootX: -0.05 }),
  strike: pose({ lean: 0.42, hop: 0.02, rShoulder: 1.2, rElbow: 0.15, lShoulder: -0.65, lElbow: -0.3, weapon: -0.6, frontFootX: 0.55, frontFootY: 0.02 }),
  thrust: pose({ lean: 0.34, rShoulder: 1.58, rElbow: 0.02, lShoulder: -0.75, weapon: -0.1, frontFootX: 0.62 }),
  // The staff's head is drawn opposite the grip direction, so this points
  // the grip back and down and the head forward at the target.
  cast: pose({ lean: 0.08, rShoulder: 1.3, rElbow: 0.32, lShoulder: 1.1, lElbow: 0.22, weapon: -3.04, frontFootX: 0.2 }),
  draw: pose({ lean: 0.05, rShoulder: 1.0, rElbow: -2.3, lShoulder: 1.55, lElbow: 0.05, weapon: 0, frontFootX: 0.15 }),
  loose: pose({ lean: 0.12, rShoulder: 0.6, rElbow: -0.6, lShoulder: 1.55, lElbow: 0.05, weapon: 0, frontFootX: 0.15 }),
  maul: pose({ lean: 0.52, hop: 0.06, rShoulder: 1.4, rElbow: 0.5, lShoulder: 1.2, lElbow: 0.45, weapon: 0.4, frontFootX: 0.5, frontFootY: 0.04 }),
  whiff: pose({ lean: 0.6, hop: 0.02, rShoulder: 0.9, rElbow: 0.25, lShoulder: -0.85, weapon: -0.8, frontFootX: 0.7 }),
  recoil: pose({ lean: -0.52, hop: 0.06, headTilt: -0.35, rShoulder: 0.95, rElbow: -1.7, lShoulder: 0.8, lElbow: -1.6, weapon: 0.9, frontFootX: -0.12, rearFootX: -0.35, rearFootY: 0.06 }),
  dodge: pose({ lean: -0.42, hop: 0.3, headTilt: -0.15, rShoulder: 0.6, rElbow: -1.2, lShoulder: 0.4, lElbow: -1.0, weapon: 0.6, frontFootX: 0.05, frontFootY: 0.36, rearFootX: -0.05, rearFootY: 0.4 }),
  guard: pose({ lean: -0.12, rShoulder: 1.15, rElbow: -2.05, lShoulder: 1.05, lElbow: -2.0, weapon: 1.3, frontFootX: 0.08 }),
  raise: pose({ lean: -0.24, rShoulder: 3.5, rElbow: -0.35, lShoulder: 0.4, lElbow: -0.5, weapon: 0.2, rearFootX: -0.08 }),
  chop: pose({ lean: 0.5, hop: 0.04, rShoulder: 1.2, rElbow: 0.3, lShoulder: -0.5, lElbow: -0.3, weapon: -0.7, frontFootX: 0.55 }),
});

export const STRIKE_POSE_BY_WEAPON = Object.freeze({
  blade: 'strike',
  rapier: 'thrust',
  knife: 'thrust',
  axe: 'chop',
  blunt: 'chop',
  polearm: 'thrust',
  staff: 'cast',
  bow: 'loose',
  claws: 'maul',
});

const WINDUP_POSE_BY_WEAPON = Object.freeze({
  blade: 'windup',
  rapier: 'windup',
  knife: 'windup',
  axe: 'raise',
  blunt: 'raise',
  polearm: 'windup',
  staff: 'windup',
  bow: 'draw',
  claws: 'windup',
});

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function easeInOut(t) {
  const x = clamp01(t);
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}

function easeOutCubic(t) {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 3);
}

const EASINGS = Object.freeze({
  settle: easeInOut,
  snap: easeOutCubic,
});

function lerp(a, b, t) {
  // Exact endpoints so a finished blend lands on the pose, not a float near it.
  if (t <= 0) return a;
  if (t >= 1) return b;
  return a + (b - a) * t;
}

// Which poses a side is blending between at `progress` of an action, given
// its role in that action. The actor anticipates (settle into windup, hold),
// snaps into the strike over a few frames around the contact point, holds
// the follow-through, then settles home. The victim snaps into its reaction
// and settles back. Returns null when the side just idles.
export function posePhase(role, action, progress, weapon = 'blade') {
  const p = clamp01(progress);
  const contact = 0.16;
  if (role === 'actor') {
    const windup = WINDUP_POSE_BY_WEAPON[weapon] || 'windup';
    const strike = action.result === 'miss'
      ? 'whiff'
      : (STRIKE_POSE_BY_WEAPON[weapon] || 'strike');
    if (p < 0.08) return { from: 'idle', to: windup, t: p / 0.08, ease: 'settle' };
    if (p < 0.12) return { from: windup, to: windup, t: 1, ease: 'settle' };
    if (p < 0.17) return { from: windup, to: strike, t: (p - 0.12) / 0.05, ease: 'snap' };
    if (p < 0.3) return { from: strike, to: strike, t: 1, ease: 'settle' };
    if (p < 0.62) return { from: strike, to: 'idle', t: (p - 0.3) / 0.32, ease: 'settle' };
    return null;
  }
  if (role === 'impact') {
    if (action.landed) {
      if (p < contact) return null;
      if (p < 0.24) return { from: 'idle', to: 'recoil', t: (p - contact) / (0.24 - contact), ease: 'snap' };
      if (p < 0.4) return { from: 'recoil', to: 'recoil', t: 1, ease: 'settle' };
      if (p < 0.76) return { from: 'recoil', to: 'idle', t: (p - 0.4) / 0.36, ease: 'settle' };
      return null;
    }
    if (action.result === 'dodge') {
      if (p < 0.08) return null;
      if (p < 0.2) return { from: 'idle', to: 'dodge', t: (p - 0.08) / 0.12, ease: 'snap' };
      if (p < 0.34) return { from: 'dodge', to: 'dodge', t: 1, ease: 'settle' };
      if (p < 0.66) return { from: 'dodge', to: 'idle', t: (p - 0.34) / 0.32, ease: 'settle' };
      return null;
    }
    if (action.result === 'absorb') {
      if (p < 0.08) return null;
      if (p < 0.18) return { from: 'idle', to: 'guard', t: (p - 0.08) / 0.1, ease: 'snap' };
      if (p < 0.5) return { from: 'guard', to: 'guard', t: 1, ease: 'settle' };
      if (p < 0.78) return { from: 'guard', to: 'idle', t: (p - 0.5) / 0.28, ease: 'settle' };
      return null;
    }
  }
  return null;
}

// Concrete joint parameters for a phase, blended with an idle breath.
export function resolvePose(phase, now = 0, options = {}) {
  const reduced = !!options.reducedMotion;
  const from = POSES[phase && phase.from] || REST;
  const to = POSES[phase && phase.to] || from;
  const ease = EASINGS[phase && phase.ease] || easeInOut;
  const t = phase ? ease(phase.t) : 0;
  const out = {};
  for (const key of Object.keys(REST)) out[key] = lerp(from[key], to[key], t);
  if (!reduced) {
    const breath = Math.sin(now / 900 + (options.phaseOffset || 0));
    out.lean += breath * 0.025;
    out.hop += breath * 0.012;
    out.rShoulder += breath * 0.03;
    out.lShoulder -= breath * 0.03;
  }
  return out;
}

function limb(origin, length, angle, facing) {
  // Angle measured from straight down, positive toward facing.
  return {
    x: origin.x + Math.sin(angle) * length * facing,
    y: origin.y + Math.cos(angle) * length,
  };
}

// Two-bone inverse kinematics: given the hip and a foot target, place the
// knee so thigh and shin lengths are honored, bending toward `bendDir`
// (positive = knee toward facing). Out-of-reach targets are pulled to the
// nearest reachable point so the leg never tears.
export function solveLeg(hip, target, thigh, shin, bendDir) {
  let dx = target.x - hip.x;
  let dy = target.y - hip.y;
  let dist = Math.sqrt(dx * dx + dy * dy);
  const maxReach = (thigh + shin) * 0.995;
  const minReach = Math.abs(thigh - shin) * 1.005;
  if (dist < 1e-6) {
    dx = 0;
    dy = 1;
    dist = 1;
  }
  const reach = Math.max(minReach, Math.min(maxReach, dist));
  const ux = dx / dist;
  const uy = dy / dist;
  const foot = { x: hip.x + ux * reach, y: hip.y + uy * reach };
  // Law of cosines for the knee offset along the hip-foot line.
  const a = (thigh * thigh - shin * shin + reach * reach) / (2 * reach);
  const h = Math.sqrt(Math.max(0, thigh * thigh - a * a));
  // Perpendicular to the hip-foot line; pick the side facing bendDir.
  const px = -uy;
  const py = ux;
  const sign = (px * bendDir) >= 0 ? 1 : -1;
  const knee = { x: hip.x + ux * a + px * h * sign, y: hip.y + uy * a + py * h * sign };
  return { knee, foot, stretched: dist > maxReach };
}

// Joint positions in canvas pixels. `unit` is the body unit in pixels,
// `groundY` the line the feet stand on, `x` the hip x position after any
// lunge or knockback, and `options.baseX` the hip's rest x, which the feet
// stay planted around. `options.stretch` scales the body vertically about
// the ground (1 = none) for squash-and-stretch.
export function figureGeometry(figure, joints, x, groundY, unit, options = {}) {
  const p = figure.proportions;
  const u = unit * figure.scale;
  const facing = figure.facing;
  const baseX = Number.isFinite(options.baseX) ? options.baseX : x;
  const stretch = Number.isFinite(options.stretch) && options.stretch > 0 ? options.stretch : 1;
  const widen = 1 / Math.sqrt(stretch);
  const lean = p.baseLean + joints.lean;
  const up = (length) => length * u * stretch;

  const hip = { x, y: groundY - up(p.hipHeight + joints.hop) };
  // Torso rotates about the hip; "up" is -y so a forward lean moves the
  // shoulder toward the facing direction.
  const shoulder = {
    x: hip.x + Math.sin(lean) * p.torso * u * facing,
    y: hip.y - Math.cos(lean) * up(p.torso),
  };
  // Perpendicular to the spine, pointing toward facing.
  const spineX = shoulder.x - hip.x;
  const spineY = shoulder.y - hip.y;
  const spineLength = Math.max(1e-6, Math.sqrt(spineX * spineX + spineY * spineY));
  const perpX = (-spineY / spineLength) * facing;
  const perpY = (spineX / spineLength) * facing;
  const shoulderHalf = p.shoulderHalf * u * widen;
  const hipHalf = p.hipHalf * u * widen;
  const torso = {
    shoulderFront: { x: shoulder.x + perpX * shoulderHalf, y: shoulder.y + perpY * shoulderHalf },
    shoulderBack: { x: shoulder.x - perpX * shoulderHalf, y: shoulder.y - perpY * shoulderHalf },
    hipFront: { x: hip.x + perpX * hipHalf, y: hip.y + perpY * hipHalf },
    hipBack: { x: hip.x - perpX * hipHalf, y: hip.y - perpY * hipHalf },
  };

  const headTilt = lean * 0.55 + joints.headTilt;
  const neck = {
    x: shoulder.x + Math.sin(headTilt) * p.neck * u * facing,
    y: shoulder.y - Math.cos(headTilt) * up(p.neck),
  };
  const headRadius = p.head * u * Math.sqrt(stretch);
  const head = {
    x: neck.x + Math.sin(headTilt) * headRadius * 0.95 * facing,
    y: neck.y - Math.cos(headTilt) * headRadius * 0.95,
    r: headRadius,
  };

  // Arms hang from just inside the shoulder edges: the near arm from the
  // front edge, the far arm from the back edge.
  const nearShoulder = { x: shoulder.x + perpX * shoulderHalf * 0.55, y: shoulder.y + perpY * shoulderHalf * 0.55 };
  const farShoulder = { x: shoulder.x - perpX * shoulderHalf * 0.55, y: shoulder.y - perpY * shoulderHalf * 0.55 };
  const rElbowPos = limb(nearShoulder, p.upperArm * u, joints.rShoulder + lean, facing);
  const rHand = limb(rElbowPos, p.forearm * u, joints.rShoulder + lean + joints.rElbow, facing);
  const lElbowPos = limb(farShoulder, p.upperArm * u, joints.lShoulder + lean, facing);
  const lHand = limb(lElbowPos, p.forearm * u, joints.lShoulder + lean + joints.lElbow, facing);

  // Legs: feet are planted around the rest x, not the lunged x.
  const frontTarget = {
    x: baseX + (p.frontFoot + joints.frontFootX) * u * facing,
    y: groundY - joints.frontFootY * u,
  };
  const rearTarget = {
    x: baseX + (p.rearFoot + joints.rearFootX) * u * facing,
    y: groundY - joints.rearFootY * u,
  };
  const frontHip = { x: hip.x + perpX * hipHalf * 0.5, y: hip.y + perpY * hipHalf * 0.5 };
  const rearHip = { x: hip.x - perpX * hipHalf * 0.5, y: hip.y - perpY * hipHalf * 0.5 };
  const front = solveLeg(frontHip, frontTarget, p.thigh * u, p.shin * u * stretch, facing);
  const rear = solveLeg(rearHip, rearTarget, p.thigh * u, p.shin * u * stretch, facing);

  const weaponAngle = joints.rShoulder + lean + joints.rElbow + joints.weapon;
  const offAngle = joints.lShoulder + lean + joints.lElbow + joints.weapon;
  return {
    unit: u,
    facing,
    hip,
    shoulder,
    neck,
    head,
    torso,
    spine: { x: spineX / spineLength, y: spineY / spineLength },
    perp: { x: perpX, y: perpY },
    arms: {
      right: { shoulder: nearShoulder, elbow: rElbowPos, hand: rHand },
      left: { shoulder: farShoulder, elbow: lElbowPos, hand: lHand },
    },
    legs: {
      front: { hip: frontHip, knee: front.knee, foot: front.foot, stretched: front.stretched },
      rear: { hip: rearHip, knee: rear.knee, foot: rear.foot, stretched: rear.stretched },
    },
    weapon: {
      kind: figure.weapon,
      hand: rHand,
      offHand: lHand,
      // Direction the weapon points, as a unit vector.
      dx: Math.sin(weaponAngle) * facing,
      dy: Math.cos(weaponAngle),
      offKind: figure.offKind || '',
      offDx: Math.sin(offAngle) * facing,
      offDy: Math.cos(offAngle),
    },
    shield: !!figure.shield,
    helmet: !!figure.helmet,
    armor: !!figure.armor,
    twoHanded: !!figure.twoHanded,
    caster: !!figure.caster,
    widths: {
      upperArm: p.upperArmWidth * u,
      forearm: p.forearmWidth * u,
      thigh: p.thighWidth * u,
      shin: p.shinWidth * u,
      hand: p.handRadius * u,
      foot: p.footLength * u,
    },
    cloak: !!p.cloak,
    tail: !!p.tail,
  };
}

// Height of the standing figure above the ground line, in pixels, so the
// stage can budget vertical space.
export function figureHeight(figure, unit) {
  const p = figure.proportions;
  return (p.hipHeight + p.torso + p.neck + p.head * 2) * unit * figure.scale;
}
