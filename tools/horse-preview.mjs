// CPU preview renderer for unit parts (boxes, with the taper the GPU shader applies): the game's src (top row) vs a
// modified copy at $PROTO (bottom row), or $BEFORE (top) vs the game's src (bottom). Four views of a worker, or with
// KINDS=warrior,archer,... one view (VIEW, default three-quarter) of each.
// usage: PROTO=/path/to/copy/src | BEFORE=/path/to/old/src [KINDS=...] [VIEW=front] [POSE=walk] node tools/preview-parts.mjs out.png
import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
const GAME = new URL('../src/', import.meta.url).pathname;
const SRCS = process.env.BEFORE ? { before: process.env.BEFORE + '/', after: GAME } : { before: GAME, after: (process.env.PROTO ?? '/tmp/proto/src') + '/' };
const SS = 2, CW = +(process.env.CW ?? 300), CH = +(process.env.CH ?? 300); // cell size (output pixels)
let views = [
  { name: 'front', yaw: 0, elev: 0.08, dist: 4.2 },
  { name: 'three-quarter', yaw: 0.7, elev: 0.15, dist: 4.2 },
  { name: 'side', yaw: Math.PI / 2, elev: 0.08, dist: 4.2 },
  { name: 'game view', yaw: 0.6, elev: 0.75, dist: 4.6 },
];
if (process.env.KINDS) views = [views.find((v) => v.name === (process.env.VIEW ?? 'three-quarter'))];
const rows = [];
let SHAPES = {};
const HT = process.env.HT ? JSON.parse(process.env.HT) : {};
// The horse, in its own frame: feet at 0, facing +z, centred on its voxel (x, z -0.5..0.5); 2 voxels long overall,
// so it reaches half a voxel into the voxel in front and the one behind. Parts: [centre, size, colour, pitch].
function horse(look) {
  const coat = look.coat, dark = look.points, out = [];
  const b = (c, s, col, ang = 0, roll = 0, taper = null) => out.push([c, s, col, ang, roll, taper]);
  const add = (p, v, k = 1) => p.map((x, i) => x + v[i] * k);
  const tp = (a, z) => ({ s: (a + z) / 2, t: (z - a) / ((a + z) / 2) });       // bottom width a, top z (like units.js tapered)
  // A box from p0 to p1 (in the horse's yz plane), its width w0 -> w1 and depth d0 -> d1 along the way; its frame.
  const seg = (p0, p1, [w0, w1], [d0, d1], col, out_ = true) => {
    const d = [0, p1[1] - p0[1], p1[2] - p0[2]], len = Math.hypot(d[1], d[2]), ang = Math.atan2(d[2], d[1]);
    const w = tp(w0, w1), dd = tp(d0, d1);
    if (out_) b(add(p0, d, 0.5), [w.s, len, dd.s], col, ang, 0, [w.t, dd.t]);
    const ey = [0, d[1] / len, d[2] / len], ez = [0, -Math.sin(ang), Math.cos(ang)];
    // local (x, y in -0.5..0.5 along it, z) to the horse's; width and depth at y
    return { ang, len, ey, ez, at: (x, y, z) => add(add([x, p0[1], p0[2]], d, y + 0.5), ez, z),
      w: (y) => w.s * (1 + w.t * y), d: (y) => dd.s * (1 + dd.t * y) };
  };
  const SEAT = 1.36;
  // body: barrel, a deeper chest in front, rounder hindquarters behind
  b([0, 1.08, -0.06], [0.42, 0.44, 1.06], coat);
  b([0, 1.12, 0.35], [0.4, 0.5, 0.3], coat);
  b([0, 1.12, -0.46], [0.44, 0.48, 0.36], coat);
  // the head: long, deep and broad at the top (its poll and jaw), tapering down to the muzzle, nose down
  const HA = HT.headPitch ?? 0.85, HL = HT.headLen ?? 0.62, HC = [0, HT.headY ?? 1.78, HT.headZ ?? 0.67];
  const dir = [0, -Math.sin(HA), Math.cos(HA)];
  const head = seg(add(HC, dir, -HL / 2), add(HC, dir, HL / 2), [HT.pollW ?? 0.32, HT.muzzleW ?? 0.21], [HT.pollD ?? 0.4, HT.muzzleD ?? 0.22], coat);
  // the neck: thick and arched, broad where it meets the chest, narrowing up to behind the poll (inside the sides of
  // the face, which narrow towards the muzzle); its crest's mane
  const NB = [0, 1.2, HT.neckZ ?? 0.27], NT = head.at(0, -0.3, 0.02);
  const neck = seg(NB, NT, [HT.neckW0 ?? 0.36, HT.neckW1 ?? 0.19], [HT.neckD0 ?? 0.56, HT.neckD1 ?? 0.36], coat);
  // (the head's top side is its -z: its forehead; the neck's back is its -z too)
  seg(neck.at(0, -0.42, -neck.d(-0.42) / 2 + 0.01), add(neck.at(0, 0.5, -neck.d(0.5) / 2 + 0.01), neck.ey, 0.06), [0.1, 0.1], [0.09, 0.09], dark);
  // muzzle, darker, a cap over the head's narrow end
  { const y = 0.44, m = head.at(0, y, 0); b(m, [head.w(y) + 0.012, HL * 0.12, head.d(y) + 0.012], look.muzzle ?? dark, head.ang); }
  for (const sx of [-1, 1]) {
    const e = head.at(0, -0.5, -head.d(-0.5) / 2 + 0.03);
    b([0.085 * sx, e[1] + 0.07, e[2] - 0.03], [0.07, 0.17, 0.06], coat, -0.25);                    // ears
    const y = -0.18, ey = head.at(sx * (head.w(y) / 2 + 0.006), y, -head.d(y) * 0.22);
    b(ey, [0.02, 0.05, 0.065], [0.03, 0.03, 0.035], head.ang);                                       // eyes
  }
  b(head.at(0, -0.36, -head.d(-0.36) / 2 - 0.012), [0.11, 0.12, 0.03], dark, head.ang);           // forelock
  out.headFrame = head;
  // tail, from the top of its rump, falling back and down
  b([0, 0.98, -0.8], [0.12, 0.66, 0.12], dark, 0.42);
  // legs: upper, lower, hoof
  for (const [lx, lz] of [[-0.12, 0.34], [0.12, 0.34], [-0.13, -0.5], [0.13, -0.5]]) {
    b([lx, 0.72, lz], [0.13, 0.42, 0.16], coat);
    b([lx, 0.32, lz], [0.1, 0.4, 0.1], look.socks ?? coat);
    b([lx, 0.05, lz + 0.01], [0.12, 0.1, 0.13], [0.07, 0.06, 0.05]);
  }
  // tack: a cloth under the saddle (team colour), the saddle, its pommel and cantle, stirrups
  if (look.caparison) {
    // a knight's barding cloth over its body, flaring out to its hem; its trim band round the middle, flaring with it
    const w = tp(HT.hemW ?? 0.6, 0.47), d = tp(HT.hemD ?? 1.3, 1.18), H = 0.5, band = 0.08;
    b([0, 1.06, -0.06], [w.s, H, d.s], look.team, 0, 0, [w.t, d.t]);
    const bw = w.s + 0.006, bd = d.s + 0.006;
    b([0, 1.06, -0.06], [bw, band, bd], look.trim, 0, 0, [w.s * w.t * band / H / bw, d.s * d.t * band / H / bd]);
    { const H = out.headFrame, a = -0.4, z = 0.3;                      // chanfron (head plate) down its forehead
      const p0 = H.at(0, a, -H.d(a) / 2 - 0.018), p1 = H.at(0, z, -H.d(z) / 2 - 0.018);
      seg(p0, p1, [H.w(a) - 0.02, H.w(z) - 0.02], [0.03, 0.03], STEEL);
      b(add(H.at(0, -0.3, -H.d(-0.3) / 2 - 0.03), [0, 0.05, 0.02]), [0.03, 0.11, 0.03], look.trim, -0.3); } // its spike
  } else {
    b([0, 1.19, 0.0], [0.46, 0.26, 0.5], look.team);                     // saddle cloth
  }
  b([0, SEAT - 0.03, 0], [0.3, 0.06, 0.44], LEATHER);
  b([0, SEAT + 0.02, 0.19], [0.18, 0.1, 0.06], LEATHER);
  b([0, SEAT + 0.02, -0.2], [0.24, 0.1, 0.06], LEATHER);
  for (const sx of [-1, 1]) {
    b([0.31 * sx, 1.02, 0.12], [0.012, 0.6, 0.03], DARK, 0, 0.3 * sx);   // stirrup leathers
    b([0.42 * sx, 0.72, 0.12], [0.14, 0.04, 0.14], IRON);                // stirrups
  }
  // bridle: noseband and reins to the rider's hands
  { const H = out.headFrame, y = 0.2; b(H.at(0, y, 0), [H.w(y) + 0.025, 0.04, H.d(y) + 0.025], DARK, H.ang); } // noseband
  for (const sx of [-1, 1]) { const H = out.headFrame, y = 0.2; seg(H.at(sx * (H.w(y) / 2 + 0.015), y, 0), [0.17 * sx, 1.42, 0.2], [0.015, 0.015], [0.02, 0.02], DARK); }
  return out;
}
const STEEL = [0.56, 0.58, 0.62], LEATHER = [0.36, 0.2, 0.09], DARK = [0.12, 0.07, 0.04], IRON = [0.42, 0.44, 0.48];
const box = (base, [c, s, col, ang, roll = 0, taper = null]) => {
  // R = Rz(roll) * Rx(ang), by columns (like units.js partMatrix)
  const ca = Math.cos(ang), sa = Math.sin(ang), cr = Math.cos(roll), sr = Math.sin(roll);
  const m0 = [cr, sr, 0], m1 = [-sr * ca, cr * ca, sa], m2 = [sr * sa, -cr * sa, ca];
  return { m: [...m0.map((v) => v * s[0]), taper?.[0] ?? 0, ...m1.map((v) => v * s[1]), taper?.[1] ?? 0, ...m2.map((v) => v * s[2]), 0, base[0] + c[0], base[1] + c[1], base[2] + c[2], 1], col };
};
{
  const src = '/mnt/project-files/god-game/src/';
  const mod = await import(src + 'units-render.js'); if (mod.SHAPES) SHAPES = mod.SHAPES;
  const { Terrain } = await import(src + 'terrain.js');
  const { Units, LOOK_TUNING, TEAMS } = await import(src + 'units.js');
  const t = new Terrain(); t.generate(7);
  const units = new Units(t);
  const LIFT = HT.lift ?? 0.63, PITCH = HT.pitch ?? -0.12, SPLAY = HT.splay ?? 0.42;
  const dh = units.drawHeight.bind(units);
  units.drawHeight = (u) => dh(u) + LIFT;
  const pz = units.posture.bind(units);
  units.posture = (u, torch) => { const P = pz(u, torch); P.legs = [PITCH, PITCH]; P.legRolls = [-SPLAY, SPLAY]; P.bob = 0; return P; };
  const team = TEAMS.blue.toga;
  const LOOKS = {
    knight: { coat: [0.6, 0.6, 0.58], points: [0.3, 0.3, 0.3], muzzle: [0.25, 0.24, 0.24], caparison: true, team, trim: [0.75, 0.55, 0.12] },
    scout: { coat: [0.42, 0.18, 0.06], points: [0.07, 0.045, 0.03], socks: [0.8, 0.78, 0.72], team },
  };
  const cell = (kind, look, v, style, skin) => {
    Object.assign(LOOK_TUNING, { hairStyle: style, skinTone: skin, hairColour: -1, bodyType: 0 });
    units.list.length = 0;
    const u = units.spawn(250, 250, undefined, 'blue', kind);
    u.yaw = 0; u.idle = 0; u.walk = 0; u.moving = 0;
    const g = [u.pos[0], u.pos[1], u.pos[2]];
    const parts = look && process.env.RIDER !== '0' ? units.parts(0) : [];
    const hp = look ? horse(LOOKS[look]).map((q) => box(g, q)) : [];
    // the ground: its voxel (lighter) and the ones round it
    const tiles = [];
    for (let i = -1; i <= 1; i++) for (let k = -2; k <= 2; k++) {
      const shade = i === 0 && k === 0 ? [0.3, 0.42, 0.2] : (i + k) & 1 ? [0.14, 0.24, 0.1] : [0.18, 0.3, 0.12];
      tiles.push({ m: [0.97, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.97, 0, g[0] + i, g[1] - 0.05, g[2] + k, 1], col: shade });
    }
    return { parts: [...parts, ...hp, ...tiles], base: [g[0], g[1] + (+(process.env.UP ?? 0.25)), g[2]], v };
  };
  const V0 = [{ yaw: Math.PI / 2, elev: 0.06, dist: 7 }, { yaw: 0.65, elev: 0.2, dist: 7 }, { yaw: 0.2, elev: 0.1, dist: 7 }, { yaw: 2.6, elev: 0.22, dist: 7 }, { yaw: 0.7, elev: 0.75, dist: 7.6 }];
  const V = process.env.VIEWS ? JSON.parse(process.env.VIEWS) : V0;
  rows.push({ cells: V.map((v) => cell('warrior', 'knight', v, 1, 1)) });
  rows.push({ cells: V.map((v) => cell('archer', 'scout', v, 4, 3)) });
  // extents check: the horse's reach along z, relative to its voxel's centre
  for (const look of ['knight', 'scout']) {
    let lo = Infinity, hi = -Infinity, wx = 0;
    for (const [c, s, , ang, roll] of horse(LOOKS[look])) {
      const ca = Math.cos(ang), sa = Math.sin(ang);
      for (const dy of [-1, 1]) for (const dz of [-1, 1]) {
        const z = c[2] + sa * dy * s[1] / 2 + ca * dz * s[2] / 2; lo = Math.min(lo, z); hi = Math.max(hi, z);
      }
      wx = Math.max(wx, Math.abs(c[0]) + s[0] / 2);
    }
    console.log(look, 'z', lo.toFixed(3), hi.toFixed(3), 'half width', wx.toFixed(3));
  }
}
views = rows[0].cells; const kinds = [0];
const cube = (() => {
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  const out = [];
  for (const [n, a, b] of faces) {
    const c = (x, y) => n.map((v, i) => v * 0.5 + a[i] * x * 0.5 + b[i] * y * 0.5);
    out.push([c(-1, -1), c(1, -1), c(1, 1), n], [c(-1, -1), c(1, 1), c(-1, 1), n]);
  }
  return out;
})();
// A shape's vertices (corner, normal: 6 floats each) as triangles [a, b, c, normal].
const meshes = {};
function meshOf(name) {
  if (meshes[name] !== undefined) return meshes[name];
  const v = SHAPES[name];
  if (!v) return (meshes[name] = null);
  const tris = [];
  for (let i = 0; i < v.length; i += 18) tris.push([[v[i], v[i + 1], v[i + 2]], [v[i + 6], v[i + 7], v[i + 8]], [v[i + 12], v[i + 13], v[i + 14]], [v[i + 3], v[i + 4], v[i + 5]]]);
  return (meshes[name] = tris);
}
const W = CW * views.length * kinds.length * SS, H = CH * rows.length * SS;
const img = new Float32Array(W * H * 3), zb = new Float32Array(W * H).fill(Infinity);
// background
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = (y % (CH * SS)) / (CH * SS); img.set([0.16 - 0.06 * k, 0.2 - 0.06 * k, 0.17 - 0.06 * k], (y * W + x) * 3); }
const sun = [0.45, 0.8, 0.55]; { const l = Math.hypot(...sun); sun.forEach((v, i) => sun[i] = v / l); }
const sub = (a, b) => a.map((v, i) => v - b[i]), dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
rows.forEach((r, ri) => r.cells.forEach((row, vi) => {
  const v = row.v;
  const target = [row.base[0], row.base[1] + 1.2, row.base[2]];
  const eye = [target[0] + Math.sin(v.yaw) * Math.cos(v.elev) * v.dist, target[1] + Math.sin(v.elev) * v.dist, target[2] + Math.cos(v.yaw) * Math.cos(v.elev) * v.dist];
  const fw = norm(sub(target, eye)), rt = norm(cross(fw, [0, 1, 0])), up = cross(rt, fw);
  const ox = vi * CW * SS, oy = ri * CH * SS, f = (CH * SS) / 2 / Math.tan(0.3);
  const proj = (p) => { const d = sub(p, eye), z = dot(d, fw); return [ox + CW * SS / 2 + dot(d, rt) * f / z, oy + CH * SS / 2 - dot(d, up) * f / z, z]; };
  for (const part of row.parts) {
    const m = part.m, tx = m[3], tz = m[7];
    const col = [m[0], m[1], m[2]], c1 = [m[4], m[5], m[6]], c2 = [m[8], m[9], m[10]];
    const inv = [col, c1, c2].map((c) => c.map((x) => x / dot(c, c)));
    const world = (c) => { const q = [c[0] * (1 + tx * c[1]), c[1], c[2] * (1 + tz * c[1])]; return [0, 1, 2].map((i) => m[i] * q[0] + m[4 + i] * q[1] + m[8 + i] * q[2] + m[12 + i]); };
    const tris = part.shape ? meshOf(part.shape) : cube;
    if (!tris) continue;
    const boxy = !part.shape || part.shape === 'jaw';
    for (const [a, b, c, n] of tris) {
      const nn = [n[0], n[1] - 0.5 * (tx * Math.abs(n[0]) + tz * Math.abs(n[2])), n[2]];
      const wn = norm([0, 1, 2].map((i) => inv[0][i] * nn[0] + inv[1][i] * nn[1] + inv[2][i] * nn[2]));
      const P = [a, b, c].map((k) => proj(world(k))), L = [a, b, c];
      const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
      if (Math.abs(area) < 1e-9) continue;
      const light = Math.max(0, dot(wn, sun)) * 1.0 + 0.32 + 0.12 * wn[1];
      const x0 = Math.max(ox, Math.floor(Math.min(...P.map((p) => p[0])))), x1 = Math.min(ox + CW * SS - 1, Math.ceil(Math.max(...P.map((p) => p[0]))));
      const y0 = Math.max(oy, Math.floor(Math.min(...P.map((p) => p[1])))), y1 = Math.min(oy + CH * SS - 1, Math.ceil(Math.max(...P.map((p) => p[1]))));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((P[1][0] - px) * (P[2][1] - py) - (P[2][0] - px) * (P[1][1] - py)) / area;
        const w1 = ((P[2][0] - px) * (P[0][1] - py) - (P[0][0] - px) * (P[2][1] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = w0 * P[0][2] + w1 * P[1][2] + w2 * P[2][2], i = y * W + x;
        if (z >= zb[i]) continue;
        zb[i] = z;
        const loc = [0, 1, 2].map((k) => Math.abs(w0 * L[0][k] + w1 * L[1][k] + w2 * L[2][k]) * 2);
        const e = Math.max(Math.min(loc[0], loc[1]), Math.min(loc[1], loc[2]), Math.min(loc[0], loc[2]));
        const s = !boxy ? 1 : 1 - 0.18 * Math.min(1, Math.max(0, (e - 0.82) / 0.18)) ** 2 * (3 - 2 * Math.min(1, Math.max(0, (e - 0.82) / 0.18)));
        img.set(part.col.map((cc) => { const v = cc * light * s * 1.15; return v / (1 + v * 0.12); }), i * 3);
      }
    }
  }
}));
// downsample + sRGB
const w = W / SS, h = H / SS, raw = Buffer.alloc((w * 3 + 1) * h);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
  let s = 0;
  for (let j = 0; j < SS; j++) for (let k = 0; k < SS; k++) s += img[((y * SS + j) * W + x * SS + k) * 3 + c];
  const lin = Math.min(1, Math.max(0, s / SS / SS));
  raw[y * (w * 3 + 1) + 1 + x * 3 + c] = Math.round(255 * (lin <= 0.0031308 ? lin * 12.92 : 1.055 * lin ** (1 / 2.4) - 0.055));
}
const crc = (b) => { let c, r = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (r ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; r = (r >>> 8) ^ c; } return (r ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(process.argv[2], Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote', process.argv[2], w, h);
process.exit(0);
