{ let s = 1; Math.random = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646; }
const SRC = process.env.SRC ?? new URL('../src/', import.meta.url).href;
const { Terrain } = await import(SRC + 'terrain.js');
const { Units } = await import(SRC + 'units.js');
const { FlattenJob } = await import(SRC + 'jobs.js');
const t = new Terrain(); t.generate(7);
const units = new Units(t);
if (process.env.NOSETTLE) units.settle = () => {};
const cap = new Map(); const orig = units.posture.bind(units);
units.posture = (u, torch) => { const P = orig(u, torch); cap.set(u, P); return P; };
const kinds = ['warrior', 'archer', 'spearman', 'mage', 'priest', 'barbarian'];
let i = 0;
for (const team of ['blue', 'red']) for (const k of kinds) for (let n = 0; n < 2; n++) { const x = 240 + (i % 6) * 2, z = team === 'blue' ? 244 : 252; i++; units.spawn(x, z, undefined, team, k); }
const gy = t.groundAt(250, 300);
units.workers.add(new FlattenJob(t, 246, 296, 254, 304, gy - 2));
for (let n = 0; n < 4; n++) units.spawn(244 + n * 3, 292, undefined, 'blue', 'worker');
const fps = +(process.env.FPS ?? 60), sub = +(process.env.DRAWS ?? 1);
const mv = {}; const prev = new Map();
for (let f = 0; f < fps * 20; f++) {
  units.update(1 / fps);
  for (let d = 0; d < sub; d++) units.parts(0);
  for (const u of units.list) {
    const P = cap.get(u); if (!P || u.rag) continue;
    const busy = u.striking || u.working > 0 || u.whirling;
    if (!busy) continue;
    const q = prev.get(u); const m = mv[u.kind] ??= { frames: 0, moved: 0 };
    if (q) { m.frames++; m.moved += Math.abs(P.armR - q.armR) + Math.abs(P.rollR - q.rollR) + Math.abs(P.armL - q.armL); }
    prev.set(u, { armR: P.armR, rollR: P.rollR, armL: P.armL });
  }
}
for (const [k, m] of Object.entries(mv)) console.log(k, 'busy frames', m.frames, 'arm motion/s', (m.moved / m.frames * fps).toFixed(2), 'settling now', units.list.filter(u => u.kind === k && u.settling).length);
