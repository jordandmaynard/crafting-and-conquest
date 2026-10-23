// Finds z-fighting in a villager's model: pairs of box faces (tapered as the shader does) that lie in nearly the same
// plane and overlap, facing the same way (those flicker). Faces that touch facing each other are inside the model,
// never seen: FACING=1 lists them too. usage: [SRC=/path/to/src] [KIND=worker] [POSE=idle|walk] node tools/zfight.mjs
const src = (process.env.SRC ?? new URL('../src', import.meta.url).pathname) + '/';
const { Terrain } = await import(src + 'terrain.js');
const { Units } = await import(src + 'units.js');
const t = new Terrain(); t.generate(7);
const units = new Units(t);
const u = units.spawn(250, 250, undefined, 'blue', process.env.KIND ?? 'worker');
u.yaw = 0; u.idle = 0; u.walk = process.env.POSE === 'walk' ? 0.9 : 0; u.moving = process.env.POSE === 'walk' ? 1 : 0;
const parts = units.parts(+(process.env.TORCH ?? 0));
const EPS = +(process.env.EPS ?? 0.006); // voxels: closer than this counts as the same plane
const sub = (a, b) => a.map((v, i) => v - b[i]), dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
const QUADS = [ // each face's corners, in order round it
  [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]],
  [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]],
  [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]],
];
const faces = [];
parts.forEach((p, i) => {
  if (p.shape) return;
  const m = p.m, tx = m[3], tz = m[7];
  const w = (c) => { const q = [c[0] * 0.5 * (1 + tx * c[1] * 0.5), c[1] * 0.5, c[2] * 0.5 * (1 + tz * c[1] * 0.5)]; return [0, 1, 2].map((k) => m[k] * q[0] + m[4 + k] * q[1] + m[8 + k] * q[2] + m[12 + k]); };
  const size = [0, 4, 8].map((k) => Math.hypot(m[k], m[k + 1], m[k + 2]).toFixed(2)).join('x');
  QUADS.forEach((q, f) => {
    const pts = q.map(w), n = norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
    faces.push({ part: i, f, pts, n, d: dot(n, pts[0]), label: `#${i} ${size} col ${p.col.map((c) => c.toFixed(2)).join(',')}` });
  });
});
// Area of the overlap of two convex polygons in the plane with normal n (Sutherland-Hodgman).
function overlap(a, b, n) {
  const ax = norm(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0])), ay = cross(n, ax);
  const to2 = (p) => [dot(p, ax), dot(p, ay)];
  const orient = (P) => { let s = 0; for (let i = 0; i < P.length; i++) { const [x0, y0] = P[i], [x1, y1] = P[(i + 1) % P.length]; s += x0 * y1 - x1 * y0; } return s < 0 ? P.slice().reverse() : P; };
  let poly = orient(a.map(to2));
  const clip = orient(b.map(to2));
  for (let i = 0; i < clip.length && poly.length; i++) {
    const [cx0, cy0] = clip[i], [cx1, cy1] = clip[(i + 1) % clip.length];
    const inside = ([x, y]) => (cx1 - cx0) * (y - cy0) - (cy1 - cy0) * (x - cx0) >= 0;
    const hit = (p, q) => { const d1 = (cx1 - cx0) * (p[1] - cy0) - (cy1 - cy0) * (p[0] - cx0), d2 = (cx1 - cx0) * (q[1] - cy0) - (cy1 - cy0) * (q[0] - cx0), k = d1 / (d1 - d2); return [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k]; };
    const out = [];
    for (let j = 0; j < poly.length; j++) {
      const p = poly[j], q = poly[(j + 1) % poly.length];
      if (inside(q)) { if (!inside(p)) out.push(hit(p, q)); out.push(q); } else if (inside(p)) out.push(hit(p, q));
    }
    poly = out;
  }
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length]; s += x0 * y1 - x1 * y0; }
  return Math.abs(s) / 2;
}
const found = [];
for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) {
  const a = faces[i], b = faces[j];
  if (a.part === b.part) continue;
  const c = dot(a.n, b.n);
  if (Math.abs(c) < 0.9995) continue;
  if (c < 0 && !process.env.FACING) continue;
  const gap = Math.abs(a.d - Math.sign(c) * b.d);
  if (gap > EPS) continue;
  const area = overlap(a.pts, b.pts, a.n);
  if (area > 1e-5) found.push(`${a.label} face ${a.f} / ${b.label} face ${b.f}: ${gap.toFixed(4)} apart, overlap ${area.toFixed(4)} (${c > 0 ? 'same way' : 'facing'})`);
}
console.log(`${parts.length} parts, ${found.length} near-coplanar overlaps (within ${EPS})`);
for (const s of found) console.log('  ' + s);
process.exit(0);
