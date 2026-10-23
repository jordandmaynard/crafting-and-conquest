// A team's fall (its power crystal destroyed, see main.js eliminate): everything it built comes apart, spreading out
// from the crystal. Each block of its buildings and walls (bricks, clay, planks in the columns it owns, and its Keep)
// leaves the voxel grid as the spread reaches it and tumbles like a felled tree's logs (felling.js crumble), so what's
// above falls in; its banners burn away from the bottom up as the spread nears them, and its torches drop to the ground
// and burn there a while. The blocks come out a tenth of a second's worth at a time, the edits shown a chunk of columns
// at a time (onEdit), so a big base doesn't all change at once.

import { SIZE, BLOCK, OWNER } from './terrain.js';
import { BLOCK_TUNING } from './render.js';
import { TEAMS } from './units.js';
import { linearColor } from './sky.js';
import { sfx } from './audio.js';

export const COLLAPSE_TUNING = {
  on: 1,           // 1: a fallen team's buildings come apart; 0: they stay standing
  delay: 0.6,      // seconds after the crystal shatters before the first block goes
  speed: 7,        // voxels a second the collapse spreads out from the crystal
  jitter: 1.5,     // voxels of randomness in when each block goes (so it doesn't go in neat rings)
  burst: 1.5,      // voxels a second a block's thrown out from the crystal (more or less), and up
  spin: 3,         // radians a second it tumbles at (more or less)
  life: 4,         // seconds a block lies about before it shrinks away (more or less)
  burn: 1.6,       // seconds a banner takes to burn away
  torchLife: 6,    // seconds a fallen torch burns on the ground
};

const [X, Y, Z] = SIZE;
const STEP = 0.1;   // seconds between batches of blocks
const CHUNK = 16;   // columns a side of the boxes the edits are shown in
const TEAM_KEYS = { blue: 'Blue', red: 'Red', yellow: 'Yellow', purple: 'Purple' };
// The albedo array's layers (textures.js): a block's sides' and its top's (see felling.js fsLog).
const DIRT = 1, BARK = 4, RINGS = 5, STONE = 7, PLANK = 8, BRICK = 9;
// The torches' (torches.js): stick, its length, the flame.
const STICK = 0.125, LENGTH = 0.625, FLAME = 0.16;
const ROD = [0.3, 0.2, 0.1], EMBER = [3.2, 1.1, 0.15];

export class Collapse {
  constructor(terrain, felling) {
    this.terrain = terrain;
    this.felling = felling;
    this.blocks = [];   // still to go, soonest first: { x, y, z, block, at (seconds), team }
    this.banners = [];  // to burn: { x, z, top, out, len, col, at, take () => void (off the wall or the list), t (seconds burning, -1 not yet) }
    this.torches = [];  // to fall: { torch (torches.js), at } then falling or on the ground: { p, v, dir, spin, axis, age, down }
    this.fallen = [];
    this.clock = 0;
    this.next = 0;
    this.onEdit = null;  // (lo, hi) => void: blocks came out there
    this.hidden = null;  // (x, z) => bool: fogged (no tumbling blocks, no sound)
  }

  get busy() { return this.blocks.length + this.banners.length + this.torches.length + this.fallen.length > 0; }

  // `team`'s crystal shattered at `centre` ([x, y, z]): its blocks, banners and torches set going. keep: its Keep's plan
  // (its blocks go whatever they are); walls, banners, torches: walls.js's Walls, banners.js's Banners, torches.js's
  // Torches.
  start(team, centre, { keep, walls, banners, torches }) {
    const T = COLLAPSE_TUNING, t = this.terrain;
    if (T.on < 0.5) return;
    const owner = OWNER[team], found = new Map();
    const when = (x, y, z) => this.clock + Math.max(0, T.delay) + (Math.hypot(x + 0.5 - centre[0], (y + 0.5 - centre[1]) * 0.5, z + 0.5 - centre[2])
      + Math.random() * T.jitter) / Math.max(0.5, T.speed);
    const take = (x, y, z) => {
      const k = t.index(x, y, z);
      if (found.has(k)) return;
      const block = t.block(x, y, z);
      if (block < 128 || block === BLOCK.OBSIDIAN || block === BLOCK.GROUND || block === BLOCK.LEAVES) return;
      found.set(k, { x, y, z, block, at: when(x, y, z), team });
    };
    for (const [x, y, z] of keep?.blocks ?? []) take(x, y, z);
    for (let z = 0; z < Z; z++) {
      for (let x = 0; x < X; x++) {
        if (t.owners[x + X * z] !== owner) continue;
        for (let y = 1; y < Y; y++) {
          const b = t.block(x, y, z);
          if (b === BLOCK.PLANK || b === BLOCK.BRICK || b === BLOCK.CLAY) take(x, y, z);
        }
      }
    }
    for (const s of walls.tiles.values()) if (s.team === team) for (let j = 0; j < s.h; j++) take(s.x, s.y0 + j, s.z);
    this.blocks = [...this.blocks, ...found.values()].sort((a, b) => a.at - b.at);
    const goes = (x, y, z) => found.get(t.index(x, y, z))?.at;
    // Banners: those on its walls, and those hung on its blocks; each starts burning a little before its block goes.
    const early = Math.max(0.1, T.burn) * 0.7, col = TEAMS[team]?.toga ?? [0.5, 0.5, 0.5];
    for (const s of walls.tiles.values()) {
      if (s.team !== team || !s.built || !s.banner) continue;
      const at = goes(s.x, s.y0 + s.h - 1, s.z);
      if (at === undefined) continue;
      this.banners.push({ x: s.x, z: s.z, top: s.y0 + s.h, out: s.out, len: Math.min(1.7, s.h - 0.75), col, at: at - early, t: -1, take: () => { s.banner = false; } });
    }
    for (const b of banners.list) {
      const [x, y, z] = b.cell, sx = x - b.wall[0], sz = z - b.wall[1], at = goes(sx, y, sz);
      if (at === undefined) continue;
      this.banners.push({ x: sx, z: sz, top: y + 1, out: b.wall, len: Math.min(1.7, b.h - 0.72), col: banners.colourAt(sx, sz), at: at - early, t: -1,
        take: () => { banners.list = banners.list.filter((o) => o !== b); } });
    }
    // Torches: those on (or against) its blocks fall as their block goes.
    for (const tr of torches.list) {
      if (!tr.lit) continue;
      const [x, y, z] = tr.cell, at = tr.wall ? goes(x - tr.wall[0], y, z - tr.wall[1]) : goes(x, y - 1, z);
      if (at !== undefined) this.torches.push({ torch: tr, at, list: torches });
    }
  }

  // Every frame: the blocks whose time has come, a batch every STEP seconds; banners burning; torches falling.
  update(dt) {
    if (!this.busy) return;
    this.clock += dt;
    const T = COLLAPSE_TUNING;
    // Torches whose block goes now: off it, falling (from the stick's middle, leaning as it was).
    while (this.torches.length && this.torches[0].at <= this.clock) {
      this.torches.sort((a, b) => a.at - b.at);
      const { torch, list } = this.torches.shift();
      if (!list.list.includes(torch)) continue;
      list.list = list.list.filter((o) => o !== torch);
      const { base, dir } = list.pose(torch), a = Math.random() * 2 * Math.PI;
      this.fallen.push({
        p: base.map((b, i) => b + dir[i] * LENGTH / 2), v: [Math.cos(a) * 0.6, 1, Math.sin(a) * 0.6], dir: [...dir],
        flat: [Math.cos(a), 0, Math.sin(a)], age: 0, down: -1,
      });
    }
    this.torches.sort((a, b) => a.at - b.at);
    // Banners: burning once their time's come, gone once burnt.
    for (const b of this.banners) {
      if (b.t < 0 && b.at <= this.clock) { b.t = 0; b.take(); }
      else if (b.t >= 0) b.t += dt;
    }
    this.banners = this.banners.filter((b) => b.t < Math.max(0.1, T.burn));
    // Fallen torches: dropping and tipping over, then lying burning.
    const t = this.terrain;
    for (const f of this.fallen) {
      f.age += dt;
      if (f.down >= 0) { f.down += dt; continue; }
      f.v[1] -= 20 * dt;
      f.p = f.p.map((c, i) => c + f.v[i] * dt);
      const k = Math.min(1, dt * 4); // (tipping over towards lying flat)
      f.dir = norm(f.dir.map((c, i) => c + (f.flat[i] - c) * k));
      const g = groundUnder(t, f.p);
      if (f.p[1] <= g + STICK / 2 || f.age > 6) { f.p[1] = Math.max(f.p[1], g + STICK / 2); f.dir = f.flat; f.down = 0; }
    }
    this.fallen = this.fallen.filter((f) => f.down < Math.max(0.5, T.torchLife));
    // Blocks: a batch every STEP.
    if (this.clock < this.next) return;
    this.next = this.clock + STEP;
    let n = 0;
    while (n < this.blocks.length && this.blocks[n].at <= this.clock) n++;
    if (!n) return;
    const batch = this.blocks.splice(0, n), v = t.voxels, boxes = new Map();
    let wood = 0, stone = 0, mid = [0, 0, 0], seen = 0;
    for (const b of batch) {
      const i = t.index(b.x, b.y, b.z);
      if (v[i] !== b.block) continue; // (gone already)
      v[i] = BLOCK.AIR;
      const ck = Math.floor(b.x / CHUNK) + 1000 * Math.floor(b.z / CHUNK);
      let box = boxes.get(ck);
      if (!box) boxes.set(ck, (box = { lo: [b.x, b.y, b.z], hi: [b.x + 1, b.y + 1, b.z + 1] }));
      box.lo = box.lo.map((c, a) => Math.min(c, [b.x, b.y, b.z][a]));
      box.hi = box.hi.map((c, a) => Math.max(c, [b.x + 1, b.y + 1, b.z + 1][a]));
      if (this.hidden?.(b.x + 0.5, b.z + 0.5)) continue;
      // Thrown out from where it was, a little away from the crystal's side and up, tumbling.
      const out = [Math.random() - 0.5, 0, Math.random() - 0.5].map((c) => c * 2 * T.burst);
      const vel = [out[0], T.burst * (0.3 + Math.random()), out[2]];
      const w = [0, 1, 2].map(() => (Math.random() - 0.5) * 2 * T.spin);
      if (this.felling.crumble([b.x, b.y, b.z], vel, w, Math.max(0.5, T.life) * (0.75 + 0.5 * Math.random()), lookOf(b))) {
        if (b.block === BLOCK.PLANK || b.block === BLOCK.LOG) wood++; else stone++;
        mid = mid.map((c, a) => c + [b.x, b.y, b.z][a] + 0.5);
        seen++;
      }
    }
    for (const { lo, hi } of boxes.values()) {
      t.updateBricks(lo, hi);
      this.onEdit?.(lo, hi);
    }
    if (seen) sfx(wood > stone ? 'breakWood' : 'breakStone', mid.map((c) => c / seen), { gain: Math.min(1, 0.4 + seen / 30) });
  }

  // Boxes for the unit renderer (banners burning, torches fallen) and the fallen torches' flames as lights
  // ([x, y, z, brightness], into `flames`). flameCol: the flames' colour; wood: the sticks'.
  parts(out, flames, flameCol, wood, clock) {
    const T = COLLAPSE_TUNING, box = (c, s, col, emit = 0) => out.push({ m: [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, c[0], c[1], c[2], 1], col, emit });
    for (const b of this.banners) {
      if (b.t < 0 || this.hidden?.(b.x + 0.5, b.z + 0.5)) continue;
      // The cloth hangs from its rod (as banners.js's), burnt away from the bottom up, a glowing edge where it burns.
      const k = Math.min(1, b.t / Math.max(0.1, T.burn)), len = (b.len + 0.45) * (1 - k), y1 = b.top - 0.12;
      const [ox, oz] = b.out;
      const at = (y, w, h, d, off, c, emit = 0) => {
        const o = 0.5 + off + d / 2;
        box([b.x + 0.5 + ox * o, y, b.z + 0.5 + oz * o], ox ? [d, h, w] : [w, h, d], c, emit);
      };
      if (k < 0.97) at(y1 + 0.02, 0.76, 0.07, 0.06, 0.01, ROD);
      if (len > 0.01) {
        at(y1 - len / 2, 0.62, len, 0.035, 0.02, b.col);
        const flicker = 0.75 + 0.25 * Math.sin(clock * 23 + b.x * 3.1 + b.z * 1.7);
        at(y1 - len - 0.03, 0.64, 0.07, 0.045, 0.02, EMBER.map((c) => c * flicker), 1);
        flames.push([b.x + 0.5 + ox * 0.6, y1 - len, b.z + 0.5 + oz * 0.6, 0.7 * flicker]);
      }
    }
    for (const f of this.fallen) {
      if (this.hidden?.(f.p[0], f.p[2])) continue;
      const fade = f.down < 0 ? 1 : Math.max(0, Math.min(1, (Math.max(0.5, T.torchLife) - f.down) / 0.5));
      out.push({ m: stickMatrix(f.p, f.dir, STICK, LENGTH), col: wood, emit: 0 });
      const tip = f.p.map((c, i) => c + f.dir[i] * (LENGTH / 2 - FLAME / 2));
      if (fade <= 0.01) continue;
      out.push({ m: stickMatrix(tip.map((c, i) => c + (i === 1 ? FLAME * 0.3 : 0)), [0, 1, 0], FLAME * fade, FLAME * fade), col: flameCol, emit: 1 });
      const k = clock * 9 + f.p[0] * 7.1 + f.p[2] * 3.7;
      flames.push([tip[0], tip[1] + 0.1, tip[2], fade * (1 - 0.3 * (0.5 + 0.3 * Math.sin(k) + 0.2 * Math.sin(k * 2.7 + 1.3)))]);
    }
    return out;
  }
}

// What a block looks like tumbling (see felling.js fsLog): a team's bricks, clay and planks in its colour (as
// render.js draws them), anything else its texture; each with its relief as on the ground (bevels, normal maps).
const RELIEF = { map: 512, brick: 1024, plank: 1536, clay: 2048 };
function lookOf({ block, team }) {
  const key = TEAM_KEYS[team], flat = (k) => [...linearColor(BLOCK_TUNING[k + key] ?? '#808080'), 256];
  if (block === BLOCK.BRICK) { const c = flat('brick'); c[3] += BRICK * 17 + RELIEF.brick; return c; }
  if (block === BLOCK.CLAY) { const c = flat('clay'); c[3] += DIRT * 17 + RELIEF.clay; return c; }
  if (block === BLOCK.PLANK) { const c = flat('plank'); c[3] += PLANK * 17 + RELIEF.plank; return c; }
  if (block === BLOCK.LOG) return [0, 0, 0, BARK * 16 + RINGS];
  if (block === BLOCK.STONE || block === BLOCK.IRON || block === BLOCK.GOLD) return [0, 0, 0, STONE * 17 + RELIEF.map];
  return [0, 0, 0, DIRT * 17 + RELIEF.map];
}

// The top of the ground under p (the highest solid voxel at or below it, plus one).
function groundUnder(t, p) {
  const x = Math.floor(p[0]), z = Math.floor(p[2]);
  let y = Math.min(Y - 1, Math.floor(p[1]));
  while (y > 0 && !t.solid(x, y - 1, z)) y--;
  return y;
}

const norm = (v) => { const l = Math.hypot(...v) || 1; return v.map((c) => c / l); };

// A box `w` wide and deep and `len` long along `dir` (unit), centred at c, as a column-major model matrix (as torches.js).
function stickMatrix(c, dir, w, len) {
  let ax = [dir[2], 0, -dir[0]];
  const l = Math.hypot(ax[0], ax[2]);
  ax = l > 1e-4 ? [ax[0] / l, 0, ax[2] / l] : [1, 0, 0];
  const az = [ax[1] * dir[2] - ax[2] * dir[1], ax[2] * dir[0] - ax[0] * dir[2], ax[0] * dir[1] - ax[1] * dir[0]];
  return [
    ax[0] * w, ax[1] * w, ax[2] * w, 0,
    dir[0] * len, dir[1] * len, dir[2] * len, 0,
    az[0] * w, az[1] * w, az[2] * w, 0,
    c[0], c[1], c[2], 1,
  ];
}
