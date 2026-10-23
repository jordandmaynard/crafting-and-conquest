// Mounted villagers: a knight (a warrior on a grey charger in its team's barding) and a scout (an archer on a chestnut
// with its team's saddle cloth). Each fights as the class it rides as (MOUNTS), sitting up in the saddle with its legs
// round the horse. The horse is 2 voxels long, centred on its voxel, so it reaches half a voxel into the voxel in front
// of it and the one behind; it trots with its diagonal legs together, its body bobbing (and its rider with it), and
// when its rider dies it goes down as a ragdoll (HorseRagdoll): its body a box that falls, rolls and slides on the
// voxels, its neck, head, tail and two-part legs jointed within a real horse's limits (a front knee folds back, a hind
// hock forward). Its parts are boxes in its own frame (feet on the ground at 0, facing +z),
// like the villagers' (see units.js parts, which places them in the world).

import { linearColor } from './sky.js';
import { RAGDOLL_TUNING, Body, boxPoints, rot, qmul, scale, dot, cross, len } from './ragdoll.js';

// The class each mounted kind fights, poses and dresses as.
export const MOUNTS = { knight: 'warrior', scout: 'archer' };

// T > Mounted.
export const MOUNT_TUNING = {
  lift: 0.63,          // how far up its rider sits (its feet, from the ground)
  legPitch: -0.12,     // its rider's legs, forward (radians)
  legSplay: 0.42,      // and out round the horse
  gait: 0.85,          // the trot's speed, per stride of a villager's walk
  stride: 0.63,        // how far the legs swing (radians)
  knee: 1.5,           // how far a leg folds as it comes forward
  bob: 0.05,           // how far the body bobs at a trot (voxels)
  fallKick: 0.65,      // dead, its body's knocked away this share as hard as its rider (heavier)
  fallSpin: 2.6,       // and rolled over sideways (radians per second)
  ragSpring: 0.3,      // how much its joints pull back towards standing (a little muscle left)
  ragGrip: 0.11,       // how its body grips the ground
  knightCoat: '#cbcbc8', knightMane: '#959595', knightMuzzle: '#898686', trim: '#e1c461',
  scoutCoat: '#ad7645', scoutMane: '#4b3c30', socks: '#e7e5dd',
};

// How far up a unit's rider sits (0 on foot, or fallen: its ragdoll starts there, see units.js hit).
export const mountLift = (u) => (MOUNTS[u.kind] && !u.rag ? MOUNT_TUNING.lift : 0);

const STEEL = [0.56, 0.58, 0.62], LEATHER = [0.36, 0.2, 0.09], DARK = [0.12, 0.07, 0.04], IRON = [0.42, 0.44, 0.48];
const HOOF = [0.07, 0.06, 0.05], EYE = [0.03, 0.03, 0.035];
const SEAT = 1.36, HIP = 0.93; // the saddle's top; where the legs swing from

const add = (p, v, k = 1) => p.map((x, i) => x + v[i] * k);
// A box's size and taper from its width a at the bottom to b at the top (like units.js tapered).
const tp = (a, b) => ({ s: (a + b) / 2, t: (b - a) / ((a + b) / 2) });

// The horse's still parts (all but its legs), for a knight's (barding) or a scout's: [centre, size, colour, pitch,
// roll, taper, what it's on (its body, neck, head or tail, or the reins: see HorseRagdoll)], colour a name (see
// colours) or an rgb. out.joints: where its neck, head and tail hinge (standing).
function build(knight) {
  const out = [];
  let on = 'body';
  const b = (c, s, col, ang = 0, roll = 0, taper = null) => out.push([c, s, col, ang, roll, taper, on]);
  // A box from p0 to p1 (in the yz plane), its width w0 -> w1 and depth d0 -> d1 along the way; returns its frame:
  // at(x, y, z) for y -0.5..0.5 along it, and its width w(y) and depth d(y).
  const seg = (p0, p1, [w0, w1], [d0, d1], col) => {
    const d = [0, p1[1] - p0[1], p1[2] - p0[2]], len = Math.hypot(d[1], d[2]), ang = Math.atan2(d[2], d[1]);
    const w = tp(w0, w1), dd = tp(d0, d1);
    if (col) b(add(p0, d, 0.5), [w.s, len, dd.s], col, ang, 0, [w.t, dd.t]);
    const ez = [0, -Math.sin(ang), Math.cos(ang)];
    return { ang, ey: [0, d[1] / len, d[2] / len], at: (x, y, z) => add(add([x, p0[1], p0[2]], d, y + 0.5), ez, z),
      w: (y) => w.s * (1 + w.t * y), d: (y) => dd.s * (1 + dd.t * y) };
  };
  // Its body: the barrel, a deeper chest in front, rounder hindquarters behind.
  b([0, 1.08, -0.06], [0.42, 0.44, 1.06], 'coat');
  b([0, 1.12, 0.35], [0.4, 0.5, 0.3], 'coat');
  b([0, 1.12, -0.46], [0.44, 0.48, 0.36], 'coat');
  // Its head: long, deep and broad at the top (its poll and jaw), tapering down to the muzzle, nose down. (Its top
  // side, the forehead, is its frame's -z.)
  const HA = 0.85, HL = 0.62, HC = [0, 1.78, 0.67], dir = [0, -Math.sin(HA), Math.cos(HA)];
  on = 'head';
  const head = seg(add(HC, dir, -HL / 2), add(HC, dir, HL / 2), [0.32, 0.21], [0.4, 0.22], 'coat');
  // Its neck: thick, broad where it meets the chest, narrowing up to behind the poll (inside the sides of the face,
  // which narrow towards the muzzle); the mane along its crest (the neck's -z).
  on = 'neck';
  const neck = seg([0, 1.2, 0.27], head.at(0, -0.3, 0.02), [0.36, 0.19], [0.56, 0.36], 'coat');
  seg(neck.at(0, -0.42, -neck.d(-0.42) / 2 + 0.01), add(neck.at(0, 0.5, -neck.d(0.5) / 2 + 0.01), neck.ey, 0.06), [0.1, 0.1], [0.09, 0.09], 'mane');
  on = 'head';
  { const y = 0.455; b(head.at(0, y, 0), [head.w(y) + 0.012, HL * 0.12, head.d(y) + 0.012], 'muzzle', head.ang); } // its muzzle, darker (a little past the head's end, so the two front faces don't z-fight)
  for (const sx of [-1, 1]) {
    const e = head.at(0, -0.5, -head.d(-0.5) / 2 + 0.03);
    b([0.085 * sx, e[1] + 0.07, e[2] - 0.03], [0.07, 0.17, 0.06], 'coat', -0.25);                 // ears
    const y = -0.18;
    b(head.at(sx * (head.w(y) / 2 + 0.006), y, -head.d(y) * 0.22), [0.02, 0.05, 0.065], EYE, head.ang); // eyes
  }
  b(head.at(0, -0.36, -head.d(-0.36) / 2 - 0.012), [0.11, 0.12, 0.03], 'mane', head.ang);       // forelock
  on = 'tail';
  b([0, 0.98, -0.8], [0.12, 0.66, 0.12], 'mane', 0.42);                                          // tail
  on = 'body';
  if (knight) {
    // Barding: a cloth over its body in its team's colour, flaring out to the hem, with a trim band round the middle
    // flaring with it; a steel plate down its forehead, with a spike.
    const w = tp(0.6, 0.47), d = tp(1.3, 1.18), H = 0.5, band = 0.08, bw = w.s + 0.006, bd = d.s + 0.006;
    b([0, 1.06, -0.06], [w.s, H, d.s], 'team', 0, 0, [w.t, d.t]);
    b([0, 1.06, -0.06], [bw, band, bd], 'trim', 0, 0, [w.s * w.t * band / H / bw, d.s * d.t * band / H / bd]);
    const a = -0.4, z = 0.3;
    on = 'head';
    seg(head.at(0, a, -head.d(a) / 2 - 0.018), head.at(0, z, -head.d(z) / 2 - 0.018), [head.w(a) - 0.02, head.w(z) - 0.02], [0.03, 0.03], STEEL);
    b(add(head.at(0, -0.3, -head.d(-0.3) / 2 - 0.03), [0, 0.05, 0.02]), [0.03, 0.11, 0.03], 'trim', -0.3);
    on = 'body';
  } else b([0, 1.19, 0], [0.46, 0.26, 0.5], 'team');                                                 // saddle cloth
  // The saddle, its pommel and cantle; stirrups on their leathers; the bridle's noseband and reins up to its rider.
  b([0, SEAT - 0.03, 0], [0.3, 0.06, 0.44], LEATHER);
  b([0, SEAT + 0.02, 0.19], [0.18, 0.1, 0.06], LEATHER);
  b([0, SEAT + 0.02, -0.2], [0.24, 0.1, 0.06], LEATHER);
  for (const sx of [-1, 1]) {
    b([0.31 * sx, 1.02, 0.12], [0.012, 0.6, 0.03], DARK, 0, 0.3 * sx);
    b([0.42 * sx, 0.72, 0.12], [0.14, 0.04, 0.14], IRON);
  }
  const y = 0.2;
  on = 'head';
  b(head.at(0, y, 0), [head.w(y) + 0.025, 0.04, head.d(y) + 0.025], DARK, head.ang);
  on = 'reins';
  for (const sx of [-1, 1]) seg(head.at(sx * (head.w(y) / 2 + 0.015), y, 0), [0.17 * sx, 1.42, 0.2], [0.015, 0.015], [0.02, 0.02], DARK);
  // (The tail's box is 0.66 long, pitched 0.42 back from hanging straight down.)
  out.joints = { neck: [0, 1.2, 0.27], poll: head.at(0, -0.3, 0.02), muzzle: head.at(0, 0.5, 0),
    tail: [0, 0.98 + 0.33 * Math.cos(0.42), -0.8 + 0.33 * Math.sin(0.42)], tailTip: [0, 0.98 - 0.33 * Math.cos(0.42), -0.8 - 0.33 * Math.sin(0.42)] };
  return out;
}
const SHAPES = { knight: build(true), scout: build(false) };
// Its legs: where each swings from ([x, z]), and its trot's diagonal pairs (front left with back right).
const LEGS = [[-0.12, 0.34, 0], [0.12, 0.34, Math.PI], [-0.13, -0.5, Math.PI], [0.13, -0.5, 0]];

// A box's matrix in the horse's frame (column-major, scaled by its size): turned Rz(roll) Rx(pitch), at c.
function boxMatrix(c, s, ang, roll) {
  const ca = Math.cos(ang), sa = Math.sin(ang), cr = Math.cos(roll), sr = Math.sin(roll);
  const m0 = [cr, sr, 0], m1 = [-sr * ca, cr * ca, sa], m2 = [sr * sa, -cr * sa, ca];
  return [...m0.map((v) => v * s[0]), 0, ...m1.map((v) => v * s[1]), 0, ...m2.map((v) => v * s[2]), 0, c[0], c[1], c[2], 1];
}
// (0, y, z) turned by pitch a.
const pitch = (a, y, z) => [0, Math.cos(a) * y - Math.sin(a) * z, Math.sin(a) * y + Math.cos(a) * z];

// How far its body's bobbing up at trot phase ph, moving (0-1) as fast.
export const horseBob = (ph, moving) => MOUNT_TUNING.bob * Math.abs(Math.sin(ph)) * moving;

// A mounted unit's horse: its parts as { m (in its own frame), col, taper, on (what it's on, see build; a leg's
// upper part leg0u-leg3u, its lower part and hoof leg0l-leg3l) }, for its kind and team colour (toga), at trot phase
// ph, moving (0-1).
export function horseParts(kind, toga, ph, moving) {
  const T = MOUNT_TUNING, knight = kind === 'knight';
  const colours = {
    coat: linearColor(knight ? T.knightCoat : T.scoutCoat), mane: linearColor(knight ? T.knightMane : T.scoutMane),
    team: toga, trim: linearColor(T.trim), socks: linearColor(T.socks),
  };
  colours.muzzle = knight ? linearColor(T.knightMuzzle) : colours.mane;
  const out = [], lift = horseBob(ph, moving);
  for (const [c, s, col, ang, roll, taper, on] of SHAPES[kind] ?? SHAPES.knight) {
    out.push({ m: boxMatrix([c[0], c[1] + lift, c[2]], s, ang, roll), col: typeof col === 'string' ? colours[col] : col, taper, on });
  }
  // Each leg swings from its hip, its lower leg folding back at the knee as it comes forward.
  LEGS.forEach(([lx, lz, off], i) => {
    const [a, k] = legPose(ph + off, moving), bend = a + k;
    const hip = [lx, HIP + lift, lz], knee = add(hip, pitch(a, -0.41, 0));
    out.push({ m: boxMatrix(add(hip, pitch(a, -0.21, 0)), [0.13, 0.42, 0.16], a, 0), col: colours.coat, on: `leg${i}u` });
    out.push({ m: boxMatrix(add(knee, pitch(bend, -0.2, 0)), [0.1, 0.4, 0.1], bend, 0), col: knight ? colours.coat : colours.socks, on: `leg${i}l` });
    out.push({ m: boxMatrix(add(knee, pitch(bend, -0.47, 0.01)), [0.12, 0.1, 0.13], bend, 0), col: HOOF, on: `leg${i}l` });
  });
  return out;
}
// A leg's swing at the hip and its fold at the knee, at its trot phase p, moving (0-1).
const legPose = (p, moving) => [-MOUNT_TUNING.stride * Math.sin(p) * moving, MOUNT_TUNING.knee * Math.max(0, Math.cos(p)) * moving];

// Its ragdoll's joints (standing): what each hangs from (its body, or another), its pivot and the end it reaches,
// and its limits: swing (about the x of what it hangs from: + takes its end back and down) lo..hi, and bend sideways
// (about that one's z, a leg or the tail, or its y, the neck and head) blo..bhi.
const J = SHAPES.knight.joints;
const BODY_C = [0, 1.11, -0.07], BODY_HALF = [0.23, 0.25, 0.57]; // its body box (barrel, chest and rump)
const JOINTS = [
  { on: 'neck', from: null, pivot: J.neck, end: J.poll, side: 'y', lo: -0.4, hi: 1.4, blo: -0.7, bhi: 0.7 },
  { on: 'head', from: 'neck', pivot: J.poll, end: J.muzzle, side: 'y', lo: -0.5, hi: 0.8, blo: -0.3, bhi: 0.3 },
  { on: 'tail', from: null, pivot: J.tail, end: J.tailTip, side: 'z', lo: -0.9, hi: 1.0, blo: -0.8, bhi: 0.8 },
  ...LEGS.flatMap(([lx, lz], i) => {
    const front = lz > 0, out = lx < 0 ? -1 : 1; // (sideways: out from the body more than in)
    const [blo, bhi] = out < 0 ? [-0.5, 0.12] : [-0.12, 0.5];
    return [
      // shoulder or hip: a front leg reaches further forward, a hind one further back
      { on: `leg${i}u`, from: null, pivot: [lx, HIP, lz], end: [lx, 0.52, lz], side: 'z', lo: front ? -1.3 : -0.8, hi: front ? 0.5 : 0.9, blo, bhi },
      // knee (folds back only) or hock (folds forward only)
      { on: `leg${i}l`, from: `leg${i}u`, pivot: [lx, 0.52, lz], end: [lx, 0, lz], side: 'z', lo: front ? -0.05 : -2.2, hi: front ? 2.4 : 0.05, blo: 0, bhi: 0 },
    ];
  }),
];
for (const j of JOINTS) {
  const d = [j.end[0] - j.pivot[0], j.end[1] - j.pivot[1], j.end[2] - j.pivot[2]];
  j.len = len(d);
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
// A joint's turn from standing: sideways (about z or y) then swing (about x).
const jointQuat = (side, a, b) => qmul(side === 'z' ? [0, 0, Math.sin(b / 2), Math.cos(b / 2)] : [0, Math.sin(b / 2), 0, Math.cos(b / 2)], [Math.sin(a / 2), 0, 0, Math.cos(a / 2)]);
const swingAxis = (side, b) => (side === 'z' ? [Math.cos(b), Math.sin(b), 0] : [Math.cos(b), 0, -Math.sin(b)]);

// A dead horse: its body a box (see ragdoll.js Body), knocked away from the blow and rolled over sideways, its joints
// swinging as rods hung from what they're on (gravity, less how fast their pivot's speeding up; left behind as what
// they're on turns; damped, pulled a little back towards standing) within their limits. An end in the ground moves to
// the nearest pose that clears it; its legs buckling, it rolls onto its side as it goes down. u: the unit as its rider fell
// (its trot as it was), `from` where the blow came from, `weapon` what struck it (see RAGDOLL_TUNING).
export class HorseRagdoll {
  constructor(terrain, u, from, weapon = 'sword') {
    const T = RAGDOLL_TUNING, M = MOUNT_TUNING;
    this.solid = (x, y, z) => terrain.solid(x, y, z);
    const q = [0, Math.sin(u.yaw / 2), 0, Math.cos(u.yaw / 2)];
    this.body = new Body(this.solid, add([u.pos[0], u.pos[1], u.pos[2]], rot(q, BODY_C)), q, BODY_HALF, boxPoints(BODY_HALF), () => MOUNT_TUNING.ragGrip);
    this.body.sound = 'horseFall'; // (its thud as it lands: see audio.js)
    let dx = u.pos[0] - from[0], dz = u.pos[2] - from[2];
    const dl = Math.hypot(dx, dz);
    if (dl > 1e-3) { dx /= dl; dz /= dl; } else { const a = Math.random() * Math.PI * 2; dx = Math.cos(a); dz = Math.sin(a); }
    const kick = (T[`${weapon}Kick`] ?? T.swordKick) * M.fallKick, lift = (T[`${weapon}Lift`] ?? T.swordLift) * M.fallKick;
    // Rolled over towards the side it was knocked to (its right, -x, for a turn about its forward way).
    const fwd = rot(q, [0, 0, 1]), right = rot(q, [-1, 0, 0]), k = dx * right[0] + dz * right[2];
    const way = Math.abs(k) > 0.2 ? Math.sign(k) : Math.random() < 0.5 ? -1 : 1;
    this.body.v = [dx * kick, lift, dz * kick];
    this.way = way;
    this.age = 0;
    this.stuck = 0;
    this.body.w = scale(fwd, way * M.fallSpin).map((v) => v + (Math.random() - 0.5) * 0.6);
    // Its legs start as they were mid-stride.
    const ph = u.walk * M.gait;
    this.joints = JOINTS.map((def) => {
      let a = 0;
      const leg = /^leg(\d)(u|l)$/.exec(def.on);
      if (leg) { const [sw, kn] = legPose(ph + LEGS[+leg[1]][2], u.moving ?? 0); a = leg[2] === 'u' ? sw : kn; }
      return { def, a: Math.max(def.lo, Math.min(def.hi, a)), b: 0, om: 0, or: 0, q: null, P: null, W: [0, 0, 0], prev: null, vp: null, wa: null, wb: null };
    });
    this.by = Object.fromEntries(this.joints.map((j) => [j.def.on, j]));
    this.place();
  }

  // What joint j hangs from: its turn, the world spot of its pivot (standing) and its spin.
  parent(j) {
    const p = j.def.from && this.by[j.def.from];
    return p ? { q: p.q, P: p.P, c: p.def.pivot, W: p.W } : { q: this.body.q, P: this.body.pos, c: BODY_C, W: this.body.w };
  }

  // Each joint's turn and pivot in the world, from its body's and its parents'.
  place() {
    for (const j of this.joints) {
      const p = this.parent(j);
      j.P = add(p.P, rot(p.q, sub(j.def.pivot, p.c)));
      j.q = qmul(p.q, jointQuat(j.def.side, j.a, j.b));
    }
  }

  step(dt) {
    const SUB = 4, h = dt / SUB, b = this.body;
    for (let s = 0; s < SUB; s++) {
      if (b.asleep) return;
      // Still upright (less than 75° over) in its first 3 seconds: its legs buckle and it keeps rolling over onto its side
      // at fallSpin, at least, the way it was knocked (the other way, if a bank stops it rolling that one for half a
      // second). Past that it's on its own.
      this.age += h;
      if (this.age < 3 && rot(b.q, [0, 1, 0])[1] > 0.25) {
        const f = rot(b.q, [0, 0, 1]), want = this.way * MOUNT_TUNING.fallSpin, now = dot(b.w, f);
        this.stuck = now * this.way < want * 0.5 * this.way ? this.stuck + h : 0;
        if (this.stuck > 0.5) { this.way = -this.way; this.stuck = 0; }
        if (now * this.way < want * this.way) b.w = add(b.w, scale(f, this.way * MOUNT_TUNING.fallSpin - now));
      }
      b.move(h);
      this.place();
      this.jointStep(h);
      b.collide(h);
      b.settle(h);
    }
    this.place();
  }

  jointStep(h) {
    const T = RAGDOLL_TUNING, K = MOUNT_TUNING.ragSpring, b = this.body;
    for (const j of this.joints) {
      const d = j.def, p = this.parent(j);
      const P = add(p.P, rot(p.q, sub(d.pivot, p.c)));
      const vp = j.prev ? scale(sub(P, j.prev), 1 / h) : [0, 0, 0];
      let acc = j.vp ? scale(sub(vp, j.vp), 1 / h) : [0, 0, 0];
      const al = len(acc);
      if (al > 80) acc = scale(acc, 80 / al);
      j.prev = P;
      j.vp = vp;
      const g = [-acc[0], -T.gravity - acc[1], -acc[2]];
      const ax = rot(p.q, swingAxis(d.side, j.b)), bx = rot(p.q, d.side === 'z' ? [0, 0, 1] : [0, 1, 0]);
      const rod = sub(d.end, d.pivot), dir = scale(rot(qmul(p.q, jointQuat(d.side, j.a, j.b)), rod), 1 / d.len);
      const torque = scale(cross(dir, g), 1.5 / d.len);
      const wa = dot(p.W, ax), wb = dot(p.W, bx);
      j.om += (dot(torque, ax) - K * j.a - T.limbDamping * j.om) * h - (j.wa === null ? 0 : wa - j.wa);
      j.or += (dot(torque, bx) - K * j.b - T.limbDamping * j.or) * h - (j.wb === null ? 0 : wb - j.wb);
      j.wa = wa;
      j.wb = wb;
      j.a += j.om * h;
      j.b += j.or * h;
      if (j.a < d.lo) { j.a = d.lo; if (j.om < 0) j.om *= -0.2; }
      if (j.a > d.hi) { j.a = d.hi; if (j.om > 0) j.om *= -0.2; }
      if (j.b < d.blo) { j.b = d.blo; if (j.or < 0) j.or *= -0.2; }
      if (j.b > d.bhi) { j.b = d.bhi; if (j.or > 0) j.or *= -0.2; }
      // Its end in the ground: the nearest pose that clears it (with none, it stays: a limb doesn't prop the body up).
      const end = (a, bb) => add(P, rot(qmul(p.q, jointQuat(d.side, a, bb)), rod));
      const inside = (e) => this.solid(Math.floor(e[0]), Math.floor(e[1]), Math.floor(e[2]));
      const e = end(j.a, j.b);
      if (inside(e)) {
        let free = null;
        for (let k = 1; k <= 30 && free === null; k++) {
          const dd = k * 0.05;
          for (const [a, bb] of [[j.a + dd, j.b], [j.a - dd, j.b], [j.a, j.b + dd], [j.a, j.b - dd], [j.a + dd, j.b + dd], [j.a + dd, j.b - dd], [j.a - dd, j.b + dd], [j.a - dd, j.b - dd]]) {
            if (a >= d.lo && a <= d.hi && bb >= d.blo && bb <= d.bhi && !inside(end(a, bb))) { free = [a, bb]; break; }
          }
        }
        if (free !== null) [j.a, j.b] = free;
        j.om = 0;
        j.or = 0;
      }
      j.P = P;
      j.q = qmul(p.q, jointQuat(d.side, j.a, j.b));
      j.W = add(p.W, add(scale(ax, j.om), scale(bx, j.or)));
    }
  }

  // A blast at p flings it away (and up), waking it if it had settled.
  blast(p, speed) {
    if (speed <= 0) return;
    const o = this.body, d = sub(o.pos, p), l = len(d) || 1, k = speed * MOUNT_TUNING.fallKick * 2;
    o.v = add(o.v, [d[0] / l * k, (Math.max(0, d[1] / l) * 0.5 + 0.6) * k, d[2] / l * k]);
    o.w = add(o.w, [0, 0, 0].map(() => (Math.random() - 0.5) * k));
    o.asleep = false;
    o.still = 0;
  }

  // Where to draw the ground shadow from.
  get pos() { return this.body.pos; }

  // Its parts in the world (see horseParts; the reins are left out: they've come loose).
  parts(kind, toga) {
    const out = [];
    for (const part of horseParts(kind, toga, 0, 0)) {
      if (part.on === 'reins') continue;
      const j = part.on === 'body' ? null : this.by[part.on];
      const q = j ? j.q : this.body.q, P = j ? j.P : this.body.pos, c = j ? j.def.pivot : BODY_C, m = part.m;
      const c0 = rot(q, [m[0], m[1], m[2]]), c1 = rot(q, [m[4], m[5], m[6]]), c2 = rot(q, [m[8], m[9], m[10]]);
      const t = add(P, rot(q, sub([m[12], m[13], m[14]], c)));
      out.push({ ...part, m: [...c0, 0, ...c1, 0, ...c2, 0, ...t, 1] });
    }
    return out;
  }
}

function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
