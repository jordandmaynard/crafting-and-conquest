// Dying villagers tumble. The body (torso, skirt and head) is one rigid box that falls, bounces and slides on the
// voxels; the arms and legs are damped ball joints pinned to their shoulders and hips, swinging forward and back and
// out to the side with the body's motion and gravity, within joint limits, their tips stopped by the ground (and
// propping the body up on it). Now and then the
// head pops off and tumbles on its own, or a sandal comes off (or a warrior's helmet, pauldron or a boot, or a mage's
// hat), and whatever
// it was holding falls from its hands and scatters, each a box of its own. A spear through it goes down with it.
//
// Collision is points on the boxes against the voxel grid: a point inside a solid voxel is pushed out through the
// nearest face that opens onto air, with an impulse that bounces a little and rubs with friction.

import { WATER_LEVEL } from './terrain.js';
import { sfx, AUDIO_TUNING } from './audio.js';
import { intoWater } from './splash.js';

// How long a thrown spear is (units.js draws it).
export const SPEAR_LENGTH = 2.2;

export const RAGDOLL_TUNING = {
  gravity: 22,       // voxels per second² (a little more than real, for snap at this scale)
  bounce: 0.22,      // how much of the speed into the ground bounces back
  friction: 0.11,
  // Per weapon: voxels per second the killing blow knocks the body away from the attacker (a fireball's blast: from
  // where it burst), and up, and radians per second it tips the body over by.
  swordKick: 4.8, swordLift: 2.2, swordSpin: 5.7,
  arrowKick: 3, arrowLift: 1.5, arrowSpin: 4,
  spearKick: 7, spearLift: 1.8, spearSpin: 4.5,
  fireKick: 8, fireLift: 8, fireSpin: 8,
  axeKick: 6, axeLift: 3, axeSpin: 9,
  drownKick: 0, drownLift: 0.5, drownSpin: 1.5, // (drowned: it slumps over in the water)
  limbSpring: 1.6, // how much the limbs pull back towards hanging straight (a little muscle left)
  limbDamping: 1.7,
  headPop: 0.18,   // the chance the head comes off
  sandal: 0.44,     // the chance a sandal does
  helmet: 0.6,     // a warrior's: the chance its helmet comes off (it always does with the head)
  pauldron: 0.54,   // its pauldron
  boot: 0.48,      // and a boot
  hat: 0.7,        // a mage's hat
  wingedHelmet: 0.6, // a spearman's helmet
  popSpeed: 7.8,   // voxels per second it flies up at
  scatter: 3.4,      // voxels per second dropped tools and weapons are flung about at
  itemFriction: 0.33, // and how they grip the ground
};

const SUBSTEPS = 4;
// The body box in the villager's frame (feet at 0): the torso and skirt, as wide as the shoulders (arms in); its
// centre is the centre of mass.
const BODY_Y = 0.89, BODY_HALF = [0.45, 0.52, 0.19];
// The head, centred at HEAD_Y, turning on the neck at NECK_Y.
const HEAD_Y = 1.7, HEAD_HALF = [0.26, 0.26, 0.26], NECK_Y = 1.41;
// Ball joints: [pivot x, pivot height, length, forward limit, back limit, roll limits (low, high)]. Each limb's pose is
// a swing (about the body's x; negative swings forward, as when walking) then a roll (about the body's z; positive
// raises it out to the villager's left), as units.js poses them.
const LIMBS = [
  [-0.14, 0.75, 0.75, -1.9, 0.5, -0.7, 0.15],  // right leg
  [0.14, 0.75, 0.75, -1.9, 0.5, -0.15, 0.7],   // left leg
  [0.37, 1.36, 0.62, -3.1, 0.9, -1.6, 2.6],    // left arm (rolled in, it reaches across the body)
  [-0.37, 1.36, 0.62, -3.1, 0.9, -2.6, 1.6],   // right arm
];

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

// Rotates v by the unit quaternion q = [x, y, z, w] (or by its inverse).
function rot(q, v, inverse = false) {
  const [x, y, z] = inverse ? [-q[0], -q[1], -q[2]] : q, w = q[3];
  const t = scale(cross([x, y, z], v), 2);
  return add(add(v, scale(t, w)), cross([x, y, z], t));
}

// Points to collide: a box's corners, edge midpoints and face centres.
function boxPoints(half, centre = [0, 0, 0]) {
  const out = [];
  for (const i of [-1, 0, 1]) for (const j of [-1, 0, 1]) for (const k of [-1, 0, 1]) {
    if (!i && !j && !k) continue;
    out.push([centre[0] + i * half[0], centre[1] + j * half[1], centre[2] + k * half[2]]);
  }
  return out;
}

class Body {
  constructor(solid, pos, q, half, points, friction = () => RAGDOLL_TUNING.friction) {
    this.solid = solid;
    this.friction = friction;
    this.grip = 5; // how fast touching the ground damps its spin
    this.pos = pos;
    this.q = q;
    this.v = [0, 0, 0];
    this.w = [0, 0, 0];
    const [a, b, c] = half.map((h) => 2 * h);
    this.invI = [12 / (b * b + c * c), 12 / (a * a + c * c), 12 / (a * a + b * b)]; // a unit mass's, in the box's frame
    this.points = points;
    this.still = 0;
    this.asleep = false;
    this.sound = null;  // what it sounds like landing (see audio.js), its loudness (soundGain), and how long it's quiet
    this.soundGain = 1; // between landings (quiet)
    this.quiet = 0;
    this.size = 2 * Math.max(...half); // (across: how big a splash it makes)
  }

  invIw(v) {
    const l = rot(this.q, v, true);
    return rot(this.q, [l[0] * this.invI[0], l[1] * this.invI[1], l[2] * this.invI[2]]);
  }

  impulse(j, r) {
    this.v = add(this.v, j);
    this.w = add(this.w, this.invIw(cross(r, j)));
  }

  // Is the point at r (in the box's frame) in a solid voxel?
  inside(r) {
    const p = add(this.pos, rot(this.q, r));
    return this.solid(Math.floor(p[0]), Math.floor(p[1]), Math.floor(p[2]));
  }

  // The point at r (in the box's frame), if it's in a solid voxel: its offset from the centre in the world, and the
  // nearest face out that opens onto air with how far in it is.
  probe(r) {
    const rr = rot(this.q, r), p = add(this.pos, rr);
    const cx = Math.floor(p[0]), cy = Math.floor(p[1]), cz = Math.floor(p[2]);
    if (!this.solid(cx, cy, cz)) return null;
    let n = null, depth = Infinity;
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      if (this.solid(cx + d[0], cy + d[1], cz + d[2])) continue;
      const a = d[0] ? 0 : d[1] ? 1 : 2, c = [cx, cy, cz][a];
      const e = d[a] > 0 ? c + 1 - p[a] : p[a] - c;
      if (e < depth) { depth = e; n = d; }
    }
    if (!n) { n = [0, 1, 0]; depth = cy + 1 - p[1]; } // buried: up
    return { rr, n, depth };
  }

  // The impulse at a contact that stops it moving into the ground (bouncing back a little when it hit hard, if
  // `bounce`) and rubs with friction. `share` scales it (a limb tip passes on only part of its knock).
  resolve({ rr, n }, share = 1, bounce = true) {
    const T = RAGDOLL_TUNING;
    const vp = add(this.v, cross(this.w, rr)), vn = dot(vp, n);
    if (vn >= 0) return;
    const k = 1 + dot(n, cross(this.invIw(cross(rr, n)), rr));
    const j = (-(1 + (bounce && vn < -1 ? T.bounce : 0)) * vn / k) * share;
    this.impulse(scale(n, j), rr);
    const vp2 = add(this.v, cross(this.w, rr));
    const vt = add(vp2, scale(n, -dot(vp2, n))), sp = len(vt);
    if (sp > 1e-6) {
      const t = scale(vt, 1 / sp);
      const kt = 1 + dot(t, cross(this.invIw(cross(rr, t)), rr));
      this.impulse(scale(t, -Math.min(sp / kt, this.friction() * j)), rr);
    }
  }

  // One point's contact on its own (a limb tip): pushed out and stopped. Returns whether it touched.
  contact(r, share = 1) {
    const c = this.probe(r);
    if (!c) return false;
    this.pos = add(this.pos, scale(c.n, c.depth + 1e-4));
    this.resolve(c, share);
    return true;
  }

  // Gravity and motion for one substep (contacts come after).
  move(h) {
    const T = RAGDOLL_TUNING;
    this.quiet -= h;
    this.v[1] -= T.gravity * h;
    if (this.pos[1] < WATER_LEVEL) { // sinks slowly through the water
      this.v = scale(this.v, 1 - Math.min(1, 4 * h));
      this.w = scale(this.w, 1 - Math.min(1, 3 * h));
      this.v[1] += T.gravity * 0.8 * h;
    }
    this.w = scale(this.w, 1 - 0.3 * h);
    this.pos = add(this.pos, scale(this.v, h));
    intoWater(this, this.pos, this.size, this.v[1]);
    const [x, y, z, w] = this.q, [ax, ay, az] = this.w, k = 0.5 * h;
    const q = [x + k * (ax * w + ay * z - az * y), y + k * (ay * w + az * x - ax * z),
      z + k * (az * w + ax * y - ay * x), w - k * (ax * x + ay * y + az * z)];
    const ql = Math.hypot(...q);
    this.q = q.map((c) => c / ql);
  }

  // Contacts for every point; touching the ground also damps its spin a little, so it comes to rest rather than
  // rocking on its corners.
  // All the points touching at once: out by the deepest along each way out, then a few passes of impulses over them
  // together, so a box resting on a face sits still instead of rocking from corner to corner.
  collide(h) {
    const cs = [];
    for (const r of this.points) { const c = this.probe(r); if (c) cs.push(c); }
    if (!cs.length) return;
    // Landing hard enough: its thud (or clink), louder the harder, now and then.
    if (this.sound && this.quiet <= 0) {
      let hit = 0;
      for (const c of cs) hit = Math.max(hit, -dot(add(this.v, cross(this.w, c.rr)), c.n));
      if (hit > AUDIO_TUNING.thud) { this.quiet = 0.12; sfx(this.sound, this.pos, { gain: this.soundGain * Math.min(1, hit / 8) }); }
    }
    const out = new Map();
    for (const c of cs) { const k = c.n.join(); if (!(out.get(k)?.depth >= c.depth)) out.set(k, c); }
    for (const c of out.values()) this.pos = add(this.pos, scale(c.n, c.depth + 1e-4));
    for (let i = 0; i < 4; i++) for (const c of cs) this.resolve(c, 1, i === 0);
    this.w = scale(this.w, 1 - Math.min(1, this.grip * h));
  }

  // Asleep once it's lain still for a moment.
  settle(h) {
    this.still = len(this.v) < 0.3 && len(this.w) < 0.6 ? this.still + h : 0;
    if (this.still > 0.4) { this.asleep = true; this.v = [0, 0, 0]; this.w = [0, 0, 0]; }
  }

  // Model matrix for a box of size s centred at c (in this body's frame), turned by `ang` about its x first and then
  // by `roll` about its z.
  matrix(c, ang, s, roll = 0) {
    const ca = Math.cos(ang), sa = Math.sin(ang), cr = Math.cos(roll), sr = Math.sin(roll);
    const c0 = rot(this.q, [cr, sr, 0]), c1 = rot(this.q, [-sr * ca, cr * ca, sa]), c2 = rot(this.q, [sr * sa, -cr * sa, ca]);
    const p = add(this.pos, rot(this.q, c));
    return [
      c0[0] * s[0], c0[1] * s[0], c0[2] * s[0], 0,
      c1[0] * s[1], c1[1] * s[1], c1[2] * s[1], 0,
      c2[0] * s[2], c2[1] * s[2], c2[2] * s[2], 0,
      p[0], p[1], p[2], 1,
    ];
  }
}

// Rz(roll) * Rx(ang) * v: a limb's pose (see LIMBS).
const limbRot = (v, ang, roll = 0) => {
  const c = Math.cos(ang), s = Math.sin(ang), cr = Math.cos(roll), sr = Math.sin(roll);
  const y = c * v[1] - s * v[2];
  return [cr * v[0] - sr * y, sr * v[0] + cr * y, s * v[1] + c * v[2]];
};
// The same as a quaternion.
const limbQuat = (ang, roll) => qmul([0, 0, Math.sin(roll / 2), Math.cos(roll / 2)], [Math.sin(ang / 2), 0, 0, Math.cos(ang / 2)]);

export class Ragdoll {
  // u: the villager as it falls, `from` where the blow came from, `angles` its limbs' swings as it was hit
  // (LIMBS' order) and `rolls` their rolls, `held` what it had in its hands: [{ parts: [[centre, size, colour], ...] in the arm's frame from
  // the fist, hand: 'left' or 'right' }], and what it wore that may come off: { parts in the leg's frame from the hip,
  // leg } (a sandal or boot), { parts in the arm's frame from the shoulder, limb } (a pauldron) or { parts in the head's
  // frame from the neck, head: true } (a helmet). One with a `chance` comes off with that chance (a head one always
  // does when the head does); `kind` is kept on the item, to tell what's gone.
  constructor(terrain, u, from, angles = [0, 0, 0, 0], held = [], weapon = 'sword', rolls = [0, 0, 0, 0]) {
    const T = RAGDOLL_TUNING;
    const solid = (x, y, z) => terrain.solid(x, y, z);
    const q = [0, Math.sin(u.yaw / 2), 0, Math.cos(u.yaw / 2)];
    const feet = u.pos[1];
    this.popped = Math.random() < T.headPop;
    const points = boxPoints(BODY_HALF);
    if (!this.popped) points.push(...boxPoints(HEAD_HALF, [0, HEAD_Y - BODY_Y, 0]));
    // A spear through it is part of the body: points along its shaft collide too, so it props the body up on the
    // ground. (Each is { pos: its middle, dir } in the villager's frame from its feet, facing +z: the body's frame.)
    for (const sp of u.arrows ?? []) {
      if (!sp.spear) continue;
      for (let k = -2; k <= 2; k++) points.push(add(add(sp.pos, scale(sp.dir, k * SPEAR_LENGTH / 4)), [0, -BODY_Y, 0]));
    }
    this.body = new Body(solid, [u.pos[0], feet + BODY_Y, u.pos[2]], q, BODY_HALF, points);
    this.body.sound = 'bodyFall';
    // Knocked away from the blow, tipping over that way.
    let dx = u.pos[0] - from[0], dz = u.pos[2] - from[2];
    const dl = Math.hypot(dx, dz);
    if (dl > 1e-3) { dx /= dl; dz /= dl; } else { const a = Math.random() * Math.PI * 2; dx = Math.cos(a); dz = Math.sin(a); }
    const b = this.body;
    const kick = T[`${weapon}Kick`] ?? T.swordKick, lift = T[`${weapon}Lift`] ?? T.swordLift, spin = T[`${weapon}Spin`] ?? T.swordSpin;
    b.v = [dx * kick, lift, dz * kick];
    b.w = [dz * spin + (Math.random() - 0.5), (Math.random() - 0.5) * 2, -dx * spin + (Math.random() - 0.5)];
    // Each limb starts as it was (as near as its limits allow: a limb pointing one way can be swung then rolled to it
    // two ways, see units.js aimArm), set flailing out a little, some one way and some the other, so no two falls look
    // alike.
    this.limbs = LIMBS.map(([px, py, l, lo, hi, rlo, rhi], i) => {
      let th = angles[i] ?? 0, rb = rolls[i] ?? 0;
      const d = limbRot([0, -1, 0], th, rb), a = Math.asin(Math.max(-1, Math.min(1, d[2])));
      const out = (t, r) => Math.max(0, lo - t, t - hi) + Math.max(0, rlo - r, r - rhi);
      const other = th < -Math.PI / 2 ? [-a, Math.atan2(d[0], -d[1])] : [-Math.PI + a, Math.atan2(-d[0], d[1])];
      if (out(...other) < out(th, rb) - 1e-6) [th, rb] = other;
      return {
        pivot: [px, py - BODY_Y, 0], len: l, lo, hi, rlo, rhi, th: Math.max(lo, Math.min(hi, th)), om: 0,
        rb: Math.max(rlo, Math.min(rhi, rb)), or: (Math.random() - 0.5) * 4 + Math.sign(px) * 1.5, vp: null, wa: null, wz: null,
      };
    });
    if (this.popped) {
      this.head = new Body(solid, [u.pos[0], feet + HEAD_Y, u.pos[2]], q.slice(), HEAD_HALF, boxPoints(HEAD_HALF));
      const a = Math.random() * Math.PI * 2;
      this.head.v = [b.v[0] + Math.cos(a) * 1.5, T.popSpeed * (0.8 + 0.4 * Math.random()), b.v[2] + Math.sin(a) * 1.5];
      this.head.w = [0, 0, 0].map(() => (Math.random() - 0.5) * 16);
      this.head.sound = 'bodyFall';
      this.head.soundGain = 0.5;
    }
    // Each thing held becomes a box round its parts, starting where it was in the fist; a sandal (leg 0 right, 1
    // left) where it was on the foot. Parts are in the limb's frame, from the fist or (a sandal's) the hip.
    const off = ({ chance, head }) => chance === undefined || (head && this.popped) || Math.random() < chance;
    this.items = held.filter(off).map(({ parts, hand, leg, limb, head, kind, sound }) => {
      const l = head ? null : this.limbs[limb ?? leg ?? (hand === 'left' ? 2 : 3)], from = hand ? [0, -0.58, 0] : [0, 0, 0];
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const [c, s] of parts) for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i], c[i] - s[i] / 2);
        hi[i] = Math.max(hi[i], c[i] + s[i] / 2);
      }
      const mid = lo.map((v, i) => (v + hi[i]) / 2), half = lo.map((v, i) => Math.max(0.03, (hi[i] - v) / 2));
      const centre = l ? add(add(l.pivot, limbRot(from, l.th, l.rb)), limbRot(mid, l.th, l.rb)) : add([0, NECK_Y - BODY_Y, 0], mid);
      const iq = l ? qmul(b.q, limbQuat(l.th, l.rb)) : b.q.slice();
      const body = new Body(solid, add(b.pos, rot(b.q, centre)), iq, half, boxPoints(half), () => T.itemFriction);
      const a = Math.random() * Math.PI * 2;
      body.v = [b.v[0] + Math.cos(a) * T.scatter, lift + Math.random() * T.scatter, b.v[2] + Math.sin(a) * T.scatter];
      body.w = [0, 0, 0].map(() => (Math.random() - 0.5) * 12);
      body.grip = 25; // thin things rattle on their edges otherwise
      body.sound = sound ?? (kind === 'helmet' || kind === 'pauldron' ? 'metalClink' : kind === 'hat' ? 'clothFlop' : leg !== undefined ? 'leatherTap' : 'woodClatter');
      return { body, leg, kind, parts: parts.map(([c, s, ...rest]) => [add(c, scale(mid, -1)), s, ...rest]) };
    });
  }

  step(dt) {
    const h = dt / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) {
      const b = this.body;
      if (!b.asleep) {
        b.move(h);
        this.limbStep(h);
        b.collide(h);
        b.settle(h);
      }
      for (const o of this.loose()) {
        if (o.asleep) continue;
        o.move(h);
        o.collide(h);
        o.settle(h);
      }
    }
  }

  // Each limb swings on its ball joint as a rod hanging from it: forward and back about the body's x (turned by its
  // roll) and out to the side about the body's z, pulled by gravity less the pivot's acceleration, left behind as the
  // body turns, damped, and held within its limits. A tip in the ground moves to the nearest pose that clears it, or
  // (with nowhere to go) stops and pushes the body off it.
  limbStep(h) {
    const T = RAGDOLL_TUNING, b = this.body;
    const az = rot(b.q, [0, 0, 1]), wz = dot(b.w, az);
    for (const l of this.limbs) {
      const rp = rot(b.q, l.pivot), vp = add(b.v, cross(b.w, rp));
      let acc = l.vp ? scale(add(vp, scale(l.vp, -1)), 1 / h) : [0, 0, 0];
      const al = len(acc);
      if (al > 80) acc = scale(acc, 80 / al);
      l.vp = vp;
      const g = [-acc[0], -T.gravity - acc[1], -acc[2]];
      const ax = rot(b.q, [Math.cos(l.rb), Math.sin(l.rb), 0]), wa = dot(b.w, ax);
      const torque = scale(cross(rot(b.q, limbRot([0, -1, 0], l.th, l.rb)), g), 1.5 / l.len);
      const turnedA = l.wa === null ? 0 : wa - l.wa, turnedZ = l.wz === null ? 0 : wz - l.wz;
      l.wa = wa;
      l.wz = wz;
      l.om += (dot(torque, ax) - T.limbSpring * l.th - T.limbDamping * l.om) * h - turnedA;
      l.or += (dot(torque, az) - T.limbSpring * l.rb - T.limbDamping * l.or) * h - turnedZ;
      l.th += l.om * h;
      l.rb += l.or * h;
      if (l.th < l.lo) { l.th = l.lo; if (l.om < 0) l.om *= -0.2; }
      if (l.th > l.hi) { l.th = l.hi; if (l.om > 0) l.om *= -0.2; }
      if (l.rb < l.rlo) { l.rb = l.rlo; if (l.or < 0) l.or *= -0.2; }
      if (l.rb > l.rhi) { l.rb = l.rhi; if (l.or > 0) l.or *= -0.2; }
      const tip = (th, rb) => add(l.pivot, limbRot([0, -l.len, 0], th, rb));
      if (b.inside(tip(l.th, l.rb))) {
        let free = null;
        for (let k = 1; k <= 30 && free === null; k++) {
          const d = k * 0.05;
          for (const [a, r] of [[l.th + d, l.rb], [l.th - d, l.rb], [l.th, l.rb + d], [l.th, l.rb - d]]) {
            if (a >= l.lo && a <= l.hi && r >= l.rlo && r <= l.rhi && !b.inside(tip(a, r))) { free = [a, r]; break; }
          }
        }
        if (free === null) b.contact(tip(l.th, l.rb), 0.5);
        else [l.th, l.rb] = free;
        l.om = 0;
        l.or = 0;
      }
    }
  }

  // A blast at p flings the body, its head and what it dropped away from it (and up), waking them if they'd settled.
  blast(p, speed) {
    if (speed <= 0) return;
    for (const o of [this.body, ...this.loose()]) {
      const d = add(o.pos, scale(p, -1)), l = len(d) || 1;
      o.v = add(o.v, [d[0] / l * speed, (Math.max(0, d[1] / l) * 0.5 + 0.6) * speed, d[2] / l * speed]);
      o.w = add(o.w, [0, 0, 0].map(() => (Math.random() - 0.5) * speed));
      o.asleep = false;
      o.still = 0;
    }
  }

  // What tumbles on its own: the head, if it's come off, and what was held.
  // Where its neck is (the head off: where the blood comes from), and the way the body's up.
  neck() { return [add(this.body.pos, rot(this.body.q, [0, NECK_Y - BODY_Y, 0])), rot(this.body.q, [0, 1, 0])]; }

  loose() {
    return this.head ? [this.head, ...this.items.map((it) => it.body)] : this.items.map((it) => it.body);
  }

  // Where to draw the ground shadow from.
  get pos() { return this.body.pos; }

  // Model matrix for a part posed at pivot (px, py) in the villager's frame (py up from its feet), box centre c from
  // the pivot, size s, turned by tilt about x round its own centre. limb: which of LIMBS it hangs from (or null),
  // head: it's on the head.
  // (A part on the body, not a limb, may be rolled about z round its pivot: a barbarian's harness.)
  matrix(px, py, c, s, limb = null, head = false, tilt = 0, roll = 0) {
    if (head && this.head) {
      return this.head.matrix([px + c[0], py - HEAD_Y + c[1], c[2]], tilt, s);
    }
    const l = limb === null ? null : this.limbs[limb];
    const r = l ? limbRot(c, l.th, l.rb) : roll ? limbRot(c, 0, roll) : c;
    return this.body.matrix([px + r[0], py - BODY_Y + r[1], r[2]], (l ? l.th : 0) + tilt, s, l ? l.rb : roll);
  }
}

// (For horse.js's horses' ragdolls.)
export { Body, boxPoints, rot, qmul, add, scale, dot, cross, len };
