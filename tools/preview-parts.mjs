// CPU preview renderer for unit parts (boxes, with the taper the GPU shader applies): the game's src (top row) vs a
// modified copy at $PROTO (bottom row), or $BEFORE (top) vs the game's src (bottom). Four views of a worker, or with
// KINDS=warrior,archer,... one view (VIEW, default three-quarter) of each.
// BANNER=n: the bottom row's carry group n's banner. CARRY=block:n: the bottom row's carrying a load (see jobs.js
// CARRY_TUNING; wheat is block 1).
// usage: PROTO=/path/to/copy/src | BEFORE=/path/to/old/src [KINDS=...] [VIEW=front] [POSE=walk] node tools/preview-parts.mjs out.png
import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
const GAME = new URL('../src/', import.meta.url).pathname;
const SRCS = process.env.BEFORE ? { before: process.env.BEFORE + '/', after: GAME } : { before: GAME, after: (process.env.PROTO ?? '/tmp/proto/src') + '/' };
const kinds = (process.env.KINDS ?? 'worker').split(',');
const SS = 2, CW = 300, CH = 420; // cell size (output pixels)
let views = [
  { name: 'front', yaw: 0, elev: 0.08, dist: 4.2 },
  { name: 'three-quarter', yaw: 0.7, elev: 0.15, dist: 4.2 },
  { name: 'side', yaw: Math.PI / 2, elev: 0.08, dist: 4.2 },
  { name: 'game view', yaw: 0.6, elev: 0.75, dist: 4.6 },
];
if (process.env.KINDS) views = [views.find((v) => v.name === (process.env.VIEW ?? 'three-quarter'))];
const rows = [];
const pose = process.env.POSE || 'idle';
let SHAPES = {};
for (const [label, src] of Object.entries(SRCS)) {
  const mod = await import(src + 'units-render.js');
  if (mod.SHAPES) SHAPES = mod.SHAPES; // the newest set (the copy's)
  const { Terrain } = await import(src + 'terrain.js');
  const { Units } = await import(src + 'units.js');
  const t = new Terrain(); t.generate(7);
  const units = new Units(t);
  const cells = [];
  for (const kind of kinds) {
    units.list.length = 0;
    const u = units.spawn(250, 250, undefined, 'blue', kind);
    if (process.env.BANNER && label === 'after') u.banners = [+process.env.BANNER]; // a control group's banner
    if (process.env.CARRY && label === 'after') { const [b, n] = process.env.CARRY.split(':'); u.carry = { block: +b, n: +n }; } // a load in its arms
    u.yaw = 0; u.idle = 0; u.walk = pose === 'walk' ? 0.9 : 0; u.moving = pose === 'walk' ? 1 : 0;
    const parts = units.parts(0);
    for (const v of views) cells.push({ parts, base: [u.pos[0], u.pos[1], u.pos[2]], v });
  }
  rows.push({ label, cells });
}
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
  const target = [row.base[0], row.base[1] + 1.05, row.base[2]];
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
