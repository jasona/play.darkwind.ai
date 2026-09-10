// Hand-authored vector bodies for specific sprite sheets. Each style draws a
// body over the rig's joint geometry, so the baked sheet stays rig-aligned
// and equipment overlays (weapons, shield, helmet, portrait head) still
// attach at the rig's hands and neck. Styles are used only while baking; the
// shipped sheet is the PNG the bake produces.

const OUTLINE = '#0a0c0f';

function capsulePath(c, a, b, wa, wb) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.max(1e-6, Math.sqrt(dx * dx + dy * dy));
  const nx = -dy / len;
  const ny = dx / len;
  const angle = Math.atan2(dy, dx);
  c.beginPath();
  c.arc(a.x, a.y, wa / 2, angle + Math.PI / 2, angle - Math.PI / 2);
  c.lineTo(b.x + nx * wb / 2, b.y + ny * wb / 2);
  c.arc(b.x, b.y, wb / 2, angle - Math.PI / 2, angle + Math.PI / 2);
  c.closePath();
}

// Capsule with a base fill, a shade band on the back side, a rim highlight
// on the front, and an outline.
function capsule(c, a, b, wa, wb, fill, shade, light, facing, depth = 1) {
  c.save();
  c.globalAlpha *= depth;
  capsulePath(c, a, b, wa, wb);
  c.fillStyle = fill;
  c.fill();
  c.save();
  capsulePath(c, a, b, wa, wb);
  c.clip();
  const w = (wa + wb) / 2;
  c.fillStyle = shade;
  c.globalAlpha *= 0.6;
  capsulePath(c, { x: a.x - facing * w * 0.3, y: a.y + w * 0.08 }, { x: b.x - facing * w * 0.3, y: b.y + w * 0.08 }, wa, wb);
  c.fill();
  c.globalAlpha /= 0.6;
  c.fillStyle = light;
  c.globalAlpha *= 0.55;
  capsulePath(c, { x: a.x + facing * w * 0.32, y: a.y }, { x: b.x + facing * w * 0.32, y: b.y }, wa * 0.35, wb * 0.35);
  c.fill();
  c.restore();
  capsulePath(c, a, b, wa, wb);
  c.lineWidth = Math.max(1.3, w * 0.08);
  c.strokeStyle = OUTLINE;
  c.stroke();
  c.restore();
}

function polygon(c, points, fill, stroke = OUTLINE, lineWidth = 1.4) {
  c.beginPath();
  points.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
  c.closePath();
  if (fill) {
    c.fillStyle = fill;
    c.fill();
  }
  if (stroke) {
    c.lineWidth = lineWidth;
    c.strokeStyle = stroke;
    c.stroke();
  }
}

function mix(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function offset(p, dx, dy) {
  return { x: p.x + dx, y: p.y + dy };
}

// Male Scro in full plate: a broad orcish frame, bare muscled upper arms
// under spiked pauldrons, a ridged cuirass with layered abdomen plates,
// tassets over dark breeches, greaves and sabatons, and gauntlets. The
// Berserker and Street Samurai flavor comes through in the red under-cloth,
// the brass trim, and the studded belt.
export const SCRO_PLATE = Object.freeze({
  key: 'male-scro',
  kind: 'humanoid',
  cloak: '#4d1414',
  palette: {
    skin: '#6b7a56',
    skinShade: '#434f36',
    skinLight: '#8b9a74',
    metal: '#7d858f',
    metalShade: '#3d434a',
    metalLight: '#b6bec6',
    trim: '#b8903a',
    cloth: '#3a1212',
    clothShade: '#200909',
    clothLight: '#5b2424',
    leather: '#4a3320',
    leatherLight: '#6d4c30',
  },
  draw(c, geo) {
    const p = this.palette;
    const u = geo.unit;
    const f = geo.facing;
    const w = geo.widths;
    const legs = geo.legs;
    const arms = geo.arms;

    const drawLeg = (leg, depth) => {
      // Breeches on the thigh, greave on the shin, sabaton on the foot.
      capsule(c, leg.hip, leg.knee, w.thigh * 1.15, w.thigh * 0.85, p.cloth, p.clothShade, p.clothLight, f, depth);
      capsule(c, leg.knee, leg.foot, w.shin * 1.2, w.shin * 0.95, p.metal, p.metalShade, p.metalLight, f, depth);
      // Knee cop.
      c.save();
      c.globalAlpha *= depth;
      c.beginPath();
      c.arc(leg.knee.x + f * w.shin * 0.12, leg.knee.y, w.shin * 0.55, 0, Math.PI * 2);
      c.fillStyle = p.metalLight;
      c.fill();
      c.lineWidth = 1.3;
      c.strokeStyle = OUTLINE;
      c.stroke();
      // Sabaton: a plated boot, longer toe than the plain rig boot.
      const heel = offset(leg.foot, -f * w.foot * 0.3, 0);
      const toe = offset(leg.foot, f * w.foot * 0.85, 0);
      polygon(c, [
        offset(heel, 0, -w.shin * 0.55),
        offset(mix(heel, toe, 0.55), 0, -w.shin * 0.45),
        offset(toe, 0, -w.shin * 0.12),
        offset(toe, 0, w.shin * 0.14),
        offset(heel, 0, w.shin * 0.14),
      ], p.metal);
      c.strokeStyle = p.metalLight;
      c.lineWidth = 1.2;
      c.beginPath();
      c.moveTo(mix(heel, toe, 0.35).x, heel.y - w.shin * 0.3);
      c.lineTo(mix(heel, toe, 0.7).x, heel.y - w.shin * 0.2);
      c.stroke();
      c.restore();
    };

    const drawArm = (arm, depth) => {
      // Bare muscled upper arm, plated vambrace, gauntlet fist.
      capsule(c, arm.shoulder, arm.elbow, w.upperArm * 1.35, w.upperArm * 1.0, p.skin, p.skinShade, p.skinLight, f, depth);
      capsule(c, arm.elbow, arm.hand, w.forearm * 1.3, w.forearm * 1.05, p.metal, p.metalShade, p.metalLight, f, depth);
      c.save();
      c.globalAlpha *= depth;
      // Vambrace edge rings.
      c.strokeStyle = p.trim;
      c.lineWidth = Math.max(1.2, u * 0.03);
      const ringA = mix(arm.elbow, arm.hand, 0.2);
      const ringB = mix(arm.elbow, arm.hand, 0.85);
      for (const ring of [ringA, ringB]) {
        c.beginPath();
        c.arc(ring.x, ring.y, w.forearm * 0.62, 0, Math.PI * 2);
        c.stroke();
      }
      // Gauntlet.
      c.beginPath();
      c.arc(arm.hand.x, arm.hand.y, w.hand * 1.35, 0, Math.PI * 2);
      c.fillStyle = p.metal;
      c.fill();
      c.lineWidth = 1.3;
      c.strokeStyle = OUTLINE;
      c.stroke();
      c.beginPath();
      c.arc(arm.hand.x - f * w.hand * 0.3, arm.hand.y - w.hand * 0.3, w.hand * 0.5, 0, Math.PI * 2);
      c.fillStyle = p.metalLight;
      c.fill();
      // Pauldron: rounded plate with two spikes, over the shoulder.
      const sx = arm.shoulder.x;
      const sy = arm.shoulder.y - u * 0.04;
      const r = w.upperArm * 1.25;
      c.beginPath();
      c.arc(sx, sy, r, Math.PI * 0.95, Math.PI * 2.05);
      c.lineTo(sx + r * 0.9, sy + r * 0.55);
      c.lineTo(sx - r * 0.9, sy + r * 0.55);
      c.closePath();
      c.fillStyle = p.metal;
      c.fill();
      c.lineWidth = 1.5;
      c.strokeStyle = OUTLINE;
      c.stroke();
      c.beginPath();
      c.arc(sx - f * r * 0.15, sy - r * 0.1, r * 0.55, Math.PI * 1.05, Math.PI * 1.95);
      c.strokeStyle = p.metalLight;
      c.lineWidth = Math.max(1.5, r * 0.18);
      c.stroke();
      c.strokeStyle = p.trim;
      c.lineWidth = Math.max(1, r * 0.08);
      c.beginPath();
      c.arc(sx, sy, r * 0.92, Math.PI * 1.0, Math.PI * 2.0);
      c.stroke();
      for (const spike of [-0.45, 0.25]) {
        const bx = sx + spike * r * f;
        const by = sy - Math.sqrt(Math.max(0, r * r - (spike * r) * (spike * r))) + r * 0.05;
        polygon(c, [
          { x: bx - r * 0.16, y: by },
          { x: bx + r * 0.16, y: by },
          { x: bx + f * r * 0.1, y: by - r * 0.55 },
        ], p.metalLight);
      }
      c.restore();
    };

    const t = geo.torso;
    const drawTorso = () => {
      const front = geo.perp;
      const widen = (pt, amount) => ({ x: pt.x + front.x * amount, y: pt.y + front.y * amount });
      // Cuirass: broader than the rig torso, squared shoulders, flared hips.
      const shoulderFront = widen(t.shoulderFront, u * 0.06);
      const shoulderBack = widen(t.shoulderBack, -u * 0.06);
      const hipFront = offset(widen(t.hipFront, u * 0.1), 0, u * 0.14);
      const hipBack = offset(widen(t.hipBack, -u * 0.1), 0, u * 0.14);
      const waistFront = widen(mix(t.shoulderFront, t.hipFront, 0.62), -u * 0.02);
      const waistBack = widen(mix(t.shoulderBack, t.hipBack, 0.62), u * 0.02);
      // Under-tunic peeking at the waist and hips.
      polygon(c, [waistBack, waistFront, hipFront, hipBack], p.cloth);
      // Breastplate.
      polygon(c, [shoulderBack, shoulderFront, waistFront, waistBack], p.metal, OUTLINE, 1.6);
      c.save();
      c.beginPath();
      [shoulderBack, shoulderFront, waistFront, waistBack].forEach((pt, i) => (i ? c.lineTo(pt.x, pt.y) : c.moveTo(pt.x, pt.y)));
      c.closePath();
      c.clip();
      // Back-side shade and front-side light on the plate.
      c.fillStyle = p.metalShade;
      c.globalAlpha = 0.55;
      polygon(c, [shoulderBack, mix(shoulderBack, shoulderFront, 0.34), mix(waistBack, waistFront, 0.3), waistBack], p.metalShade, null);
      c.globalAlpha = 0.7;
      polygon(c, [mix(shoulderBack, shoulderFront, 0.62), mix(shoulderBack, shoulderFront, 0.9), mix(waistBack, waistFront, 0.86), mix(waistBack, waistFront, 0.66)], p.metalLight, null);
      c.globalAlpha = 1;
      // Center ridge and pectoral curve.
      c.strokeStyle = OUTLINE;
      c.lineWidth = Math.max(1.4, u * 0.035);
      const ridgeTop = mix(shoulderBack, shoulderFront, 0.52);
      const ridgeBottom = mix(waistBack, waistFront, 0.5);
      c.beginPath();
      c.moveTo(ridgeTop.x, ridgeTop.y + u * 0.08);
      c.lineTo(ridgeBottom.x, ridgeBottom.y);
      c.stroke();
      c.strokeStyle = p.metalLight;
      c.lineWidth = Math.max(1, u * 0.025);
      c.beginPath();
      c.moveTo(ridgeTop.x + f * u * 0.03, ridgeTop.y + u * 0.08);
      c.lineTo(ridgeBottom.x + f * u * 0.03, ridgeBottom.y);
      c.stroke();
      c.restore();
      // Brass trim along the plate edge.
      c.strokeStyle = p.trim;
      c.lineWidth = Math.max(1.2, u * 0.03);
      c.beginPath();
      c.moveTo(shoulderBack.x, shoulderBack.y + u * 0.05);
      c.lineTo(shoulderFront.x, shoulderFront.y + u * 0.05);
      c.stroke();
      // Layered abdomen plates below the breastplate.
      for (let i = 0; i < 3; i++) {
        const a = mix(waistBack, hipBack, i * 0.34);
        const b = mix(waistFront, hipFront, i * 0.34);
        const a2 = mix(waistBack, hipBack, i * 0.34 + 0.3);
        const b2 = mix(waistFront, hipFront, i * 0.34 + 0.3);
        polygon(c, [widen(a, -u * 0.02), widen(b, u * 0.02), widen(b2, u * 0.02), widen(a2, -u * 0.02)], p.metal, OUTLINE, 1.2);
        c.strokeStyle = p.metalLight;
        c.lineWidth = 1;
        c.beginPath();
        c.moveTo(mix(a, b, 0.55).x, mix(a, b, 0.55).y + u * 0.02);
        c.lineTo(mix(a, b, 0.92).x, mix(a, b, 0.92).y + u * 0.02);
        c.stroke();
      }
      // Studded belt with a brass buckle.
      c.strokeStyle = p.leather;
      c.lineWidth = Math.max(3, u * 0.09);
      c.beginPath();
      c.moveTo(hipBack.x - u * 0.02, hipBack.y - u * 0.02);
      c.lineTo(hipFront.x + u * 0.02, hipFront.y - u * 0.02);
      c.stroke();
      c.fillStyle = p.trim;
      for (let i = 0.15; i < 1; i += 0.2) {
        const s = mix(hipBack, hipFront, i);
        c.beginPath();
        c.arc(s.x, s.y - u * 0.02, u * 0.02, 0, Math.PI * 2);
        c.fill();
      }
      const buckle = mix(hipBack, hipFront, 0.6);
      c.fillStyle = p.trim;
      c.fillRect(buckle.x - u * 0.06, buckle.y - u * 0.07, u * 0.12, u * 0.1);
      c.strokeStyle = OUTLINE;
      c.lineWidth = 1;
      c.strokeRect(buckle.x - u * 0.06, buckle.y - u * 0.07, u * 0.12, u * 0.1);
      // Tassets hanging from the belt over each hip.
      for (const side of [-1, 1]) {
        const top = side > 0 ? offset(hipFront, -f * u * 0.02, u * 0.02) : offset(hipBack, f * u * 0.02, u * 0.02);
        polygon(c, [
          offset(top, -side * f * u * 0.16, 0),
          offset(top, side * f * u * 0.12, 0),
          offset(top, side * f * u * 0.16, u * 0.3),
          offset(top, -side * f * u * 0.1, u * 0.32),
        ], p.metal, OUTLINE, 1.2);
      }
      // Gorget at the neck.
      const neckW = w.forearm * 1.1;
      polygon(c, [
        offset(geo.shoulder, -front.x * neckW * 0.9, -front.y * neckW * 0.9 - u * 0.02),
        offset(geo.shoulder, front.x * neckW * 0.9, front.y * neckW * 0.9 - u * 0.02),
        offset(geo.neck, front.x * neckW * 0.55, front.y * neckW * 0.55),
        offset(geo.neck, -front.x * neckW * 0.55, -front.y * neckW * 0.55),
      ], p.metal, OUTLINE, 1.3);
      c.strokeStyle = p.trim;
      c.lineWidth = 1.2;
      c.beginPath();
      c.moveTo(geo.neck.x - front.x * neckW * 0.5, geo.neck.y - front.y * neckW * 0.5 + u * 0.03);
      c.lineTo(geo.neck.x + front.x * neckW * 0.5, geo.neck.y + front.y * neckW * 0.5 + u * 0.03);
      c.stroke();
    };

    drawLeg(legs.rear, 0.75);
    drawArm(arms.left, 0.75);
    drawTorso();
    drawLeg(legs.front, 1);
    // Neck skin under the gorget so the portrait sits on a body, not a plate.
    capsule(c, geo.shoulder, geo.neck, w.forearm * 1.1, w.forearm * 1.0, p.skin, p.skinShade, p.skinLight, f, 1);
    drawArm(arms.right, 1);
  },
});

export const SPRITE_STYLES = Object.freeze({
  'male-scro': SCRO_PLATE,
});

export function spriteStyleFor(key) {
  return SPRITE_STYLES[key] || null;
}
