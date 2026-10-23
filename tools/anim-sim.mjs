{ let s = +(process.env.SEED ?? 1); Math.random = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646; }
// Animation sanity sim: battles and work with the real update(), checking every frame's parts for NaN and every
// unit's limbs and held item for sudden jumps (direction change per frame, representation-independent).
const SRC = process.env.SRC ?? new URL('../src/', import.meta.url).href;
const { Terrain } = await import(SRC + 'terrain.js');
const { Units } = await import(SRC + 'units.js');
const { FlattenJob } = await import(SRC + 'jobs.js');
const t = new Terrain(); t.generate(7);
const units = new Units(t);
const cap = new Map();
const orig = units.posture.bind(units);
units.posture = (u, torch) => { const P = orig(u, torch); cap.set(u, P); return P; };
const rot = (v, a, r) => { const c = Math.cos(a), s = Math.sin(a); const y = c * v[1] - s * v[2], z = s * v[1] + c * v[2]; return [Math.cos(r) * v[0] - Math.sin(r) * y, Math.sin(r) * v[0] + Math.cos(r) * y, z]; };
const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
const worst = {};
const note = (kind, what, v, info) => { const k = kind + ' ' + what; if (!worst[k] || v > worst[k].v) worst[k] = { v, info }; };
const prev = new Map();
let nan = 0;
function check(time, torch) {
  const parts = units.parts(torch);
  for (const p of parts) if (p.m.some((x) => !Number.isFinite(x)) || p.col.some((x) => !Number.isFinite(x))) { nan++; if (nan < 5) console.log('NaN part', time); }
  for (const u of units.list) {
    const P = cap.get(u);
    if (!P || u.rag) { prev.delete(u); continue; }
    const st = {
      L: rot([0, -1, 0], P.armL, P.rollL), R: rot([0, -1, 0], P.armR, P.rollR),
      F: P.frame ? P.frame.o.slice() : null, Fz: P.frame ? P.frame.z.slice() : null, lean: P.lean, side: P.side, twist: P.twist,
      legs: P.legs.slice(), item: P.item,
    };
    const q = prev.get(u);
    if (q) {
      const info = `t=${time.toFixed(2)} id${u.id} striking=${u.striking} swing=${u.swing.toFixed(2)} work=${u.working.toFixed(2)} ws=${u.workS?.toFixed(2)} tool=${P.tool} W=${u.workW.toFixed(2)} hp=${u.hp.toFixed(1)} whirl=${u.whirl.toFixed(2)}`;
      note(u.kind, 'armL', ang(q.L, st.L), info);
      note(u.kind, 'armR', ang(q.R, st.R), info);
      if (q.F && st.F && q.item === st.item) {
        note(u.kind, 'item pos', Math.hypot(...st.F.map((v, i) => v - q.F[i])), info);
        note(u.kind, 'item dir', ang(q.Fz, st.Fz), info);
      }
      note(u.kind, 'lean', Math.abs(st.lean - q.lean), info);
      note(u.kind, 'side', Math.abs(st.side - q.side), info);
      note(u.kind, 'twist', Math.abs(st.twist - q.twist), info);
      note(u.kind, 'legs', Math.max(Math.abs(st.legs[0] - q.legs[0]), Math.abs(st.legs[1] - q.legs[1])), info);
    }
    prev.set(u, st);
  }
}
const dt = 1 / 60;
// A battle: each class on both sides.
const kinds = ['warrior', 'archer', 'spearman', 'mage', 'priest', 'barbarian'];
let i = 0;
for (const team of ['blue', 'red']) for (const k of kinds) for (let n = 0; n < 2; n++) {
  const x = 240 + (i % 6) * 2, z = team === 'blue' ? 244 : 252; i++;
  const u = units.spawn(x, z, undefined, team, k);
}
// Workers at a dig and a fill.
const gy = t.groundAt(250, 300);
units.workers.add(new FlattenJob(t, 246, 296, 254, 304, gy - 2));
for (let n = 0; n < 4; n++) units.spawn(244 + n * 3, 292, undefined, 'blue', 'worker');
const gy2 = t.groundAt(300, 250);
units.workers.add(new FlattenJob(t, 296, 246, 300, 250, gy2 + 2));
for (let n = 0; n < 3; n++) units.spawn(294 + n * 3, 244, undefined, 'blue', 'worker');
let time = 0, deaths = 0;
for (let f = 0; f < 60 * 40; f++) {
  const before = units.list.filter((u) => u.dying).length;
  units.update(dt); time += dt;
  check(time, +(process.env.TORCH ?? 0));
}
console.log('NaN parts:', nan, ' alive:', units.list.filter((u) => !u.dying).map((u) => u.kind[0] + u.team[0]).join(' '));
for (const [k, w] of Object.entries(worst).sort()) console.log(k.padEnd(22), w.v.toFixed(3), w.info);
