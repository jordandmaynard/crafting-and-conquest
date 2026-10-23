// Walls (the god panel's Wall mode): a straight line dragged out over the ground (along x, z or a diagonal) becomes an
// order for a wall WALL_TUNING.height voxels high, of planks (wood) or bricks (stone), its foot following the ground.
// It's its team's: each column (a "section") is held by the team that ordered it, and once built is a target with hit
// points (a unit of kind 'wall' that's never drawn: its voxels are the terrain's), which only the player's order sends
// fighters at (they don't go for walls of their own accord). No one mines it (not even its own team); a fireball
// doesn't blow it apart but hurts it. Out of hit points, a section comes down (its voxels crumble), leaving a gap.
// Along its outer face, torches and banners in its team's colour hung down it, spaced over the ground across all its
// team's walls however they were drawn (a straight run: torch, blank, banner, blank, torch; see order).

import { SIZE, BLOCK, WATER_LEVEL } from './terrain.js';
import { TEAMS } from './units.js';
import { bannerParts } from './banners.js';

export const WALL_TUNING = {
  height: 3,        // voxels
  woodHp: 100,      // hit points of a section of wood (planks)
  stoneHp: 250,     // and of stone (bricks)
  fire: 60,         // hit points a fireball takes off a section at the middle of its blast
  maxLength: 64,    // columns in one line
  every: 4,         // sections from one torch to the next (a banner halfway between)
  sight: 4,         // voxels a built section sees round it (fog of war)
};

const [X, Y, Z] = SIZE;
// Blocks a wall can be built of: planks, or bricks (stone is laid as bricks).
export const wallBlock = (b) => (b === BLOCK.PLANK ? BLOCK.PLANK : b === BLOCK.BRICK || b === BLOCK.STONE ? BLOCK.BRICK : null);
const clear = (b) => b === BLOCK.AIR; // (a wall voxel has to be empty to be built)

export class Walls {
  constructor(terrain) {
    this.terrain = terrain;
    this.tiles = new Map(); // column (x + X * z) -> { x, z, y0, h, block, team, out: [dx, dz], torch, banner, unit, built }
    this.clock = 0;
    this.next = 0;
    this.onBuilt = null; // (tile) => void: a section's finished (main gives it its unit and orders its torch)
    this.onGone = null;  // (tile) => void: a section's lost all its blocks (dug out, or knocked down)
  }

  // The section holding voxel (x, y, z), or null.
  at(x, y, z) {
    const s = this.tiles.get(x + X * z);
    return s && y >= s.y0 && y < s.y0 + s.h ? s : null;
  }

  // The columns of a straight wall from column a to b ([x, z] each), snapped to x, z or a diagonal and no longer than
  // maxLength: [{ x, z, y0 }] with its foot y0 on the ground there (searched from about height y, the ground first
  // clicked). Columns already walled, under the water, or with something in the way (a tree, a building) are left out
  // (as `blocked`, for the preview).
  line(a, b, y) {
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const ang = Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const sx = Math.round(Math.cos(ang)), sz = Math.round(Math.sin(ang));
    const n = Math.min(Math.max(Math.abs(dx), Math.abs(dz)), Math.round(WALL_TUNING.maxLength) - 1);
    const H = Math.round(WALL_TUNING.height), cols = [], blocked = [];
    let ref = y;
    for (let i = 0; i <= (dx || dz ? n : 0); i++) {
      const x = a[0] + sx * i, z = a[1] + sz * i;
      if (x < 1 || z < 1 || x >= X - 1 || z >= Z - 1) break;
      const y0 = this.foot(x, z, ref);
      if (y0 < 0) continue;
      ref = y0;
      let ok = y0 >= WATER_LEVEL && y0 + H < Y - 1 && !this.tiles.has(x + X * z);
      for (let k = 0; k < H && ok; k++) ok = clear(this.terrain.block(x, y0 + k, z));
      (ok ? cols : blocked).push({ x, z, y0 });
    }
    return { cols, blocked, dir: [sx, sz] };
  }

  // The ground's top in column (x, z) nearest height y: the first empty voxel over a solid one (leaves and logs don't
  // count as ground), looking down from a little above y (or, in a hillside, up out of it). -1 if there's none.
  foot(x, z, y) {
    const t = this.terrain, ground = (yy) => { const b = t.block(x, yy, z); return b >= 128 && b !== BLOCK.LEAVES && b !== BLOCK.LOG; };
    let yy = Math.min(Y - 2, y + 4);
    if (ground(yy)) { while (yy < Y - 2 && ground(yy)) yy++; return yy; }
    while (yy > 1 && !ground(yy - 1)) yy--;
    return yy > 1 ? yy : -1;
  }

  // Orders the wall: its sections are its team's from now on (each held till it's built, or its order's dropped).
  // out: the way its outer face looks ([dx, dz], where its torches go). Returns the voxels to fill.
  // Its torches and banners are spaced over the ground, not along this one order: a torch where no torch of its team's
  // walls (these or ones already there, however they were drawn, turn or cross) is within `every` columns, then a
  // banner where none is within `every` and no torch within half that (so a straight run goes torch, blank, banner,
  // blank, torch).
  order(cols, block, team, out) {
    const H = Math.round(WALL_TUNING.height), voxels = [], added = [];
    for (const c of cols) {
      const s = { x: c.x, z: c.z, y0: c.y0, h: H, block, team, out, unit: null, built: false, torch: false, banner: false };
      this.tiles.set(c.x + X * c.z, s);
      added.push(s);
      for (let k = 0; k < H; k++) voxels.push([c.x, c.y0 + k, c.z]);
    }
    const n = Math.round(WALL_TUNING.every), half = Math.floor(n / 2);
    if (n > 0) for (const s of added) s.torch = !this.near(s, 'torch', n) && !this.near(s, 'banner', half);
    if (n > 1) for (const s of added) s.banner = !s.torch && !this.near(s, 'torch', half) && !this.near(s, 'banner', n);
    return voxels;
  }

  // Whether another of s's team's sections less than r columns from it (either way, diagonals counting as one) has a
  // torch (key 'torch') or a banner ('banner').
  near(s, key, r) {
    for (let dz = 1 - r; dz < r; dz++) for (let dx = 1 - r; dx < r; dx++) {
      const o = (dx || dz) && this.tiles.get(s.x + dx + X * (s.z + dz));
      if (o && o.team === s.team && o[key]) return true;
    }
    return false;
  }

  // Every quarter second: sections whose blocks are all in are built (onBuilt); those whose order was dropped with
  // nothing built are let go (with some built: a lower wall); and those with none of their blocks left are gone
  // (onGone). pending(x, y, z): whether an order's still to fill that voxel.
  update(dt, pending) {
    this.clock += dt;
    if (this.clock < this.next) return;
    this.next = this.clock + 0.25;
    const t = this.terrain;
    for (const [k, s] of this.tiles) {
      let n = 0, wait = false;
      while (n < s.h && t.block(s.x, s.y0 + n, s.z) === s.block) n++;
      if (!s.built) {
        if (n < s.h) {
          for (let j = n; j < s.h && !wait; j++) wait = pending(s.x, s.y0 + j, s.z);
          if (wait) continue;
          if (!n) { this.tiles.delete(k); continue; }
          s.h = n;
        }
        s.built = true;
        this.onBuilt?.(s);
      } else {
        let any = false;
        for (let j = 0; j < s.h && !any; j++) any = t.block(s.x, s.y0 + j, s.z) === s.block;
        if (!any) { this.tiles.delete(k); this.onGone?.(s); }
      }
    }
  }

  // A section knocked down: its blocks come out (setVoxel: they crumble), and it's dropped. Returns the box changed.
  knockDown(s) {
    const t = this.terrain;
    let lo = null, hi = null;
    for (let j = 0; j < s.h; j++) {
      if (t.block(s.x, s.y0 + j, s.z) !== s.block) continue;
      const c = t.setVoxel(s.x, s.y0 + j, s.z, BLOCK.AIR);
      if (c) { lo = lo ? lo.map((v, i) => Math.min(v, c.lo[i])) : c.lo; hi = hi ? hi.map((v, i) => Math.max(v, c.hi[i])) : c.hi; }
    }
    this.tiles.delete(s.x + X * s.z);
    return lo && { lo, hi };
  }

  // The banners as boxes for the unit renderer ({ m, col, emit }): on the built sections that have one, a cloth in the
  // team's colour hung from a rod just under the top of its outer face, down most of the wall, cut to a point at the
  // bottom, with a lighter band near the top (see banners.js). hidden(x, z): fogged. wave: a clock, for a slight sway.
  parts(out = [], hidden = null, wave = 0) {
    for (const s of this.tiles.values()) {
      if (!s.built || !s.banner || hidden?.(s.x + 0.5, s.z + 0.5)) continue;
      const top = s.y0 + s.h;
      if (this.terrain.block(s.x, top - 1, s.z) !== s.block) continue;
      bannerParts(out, s.x, s.z, top, s.out, Math.min(1.7, s.h - 0.75), TEAMS[s.team]?.toga ?? [0.5, 0.5, 0.5], wave);
    }
    return out;
  }
}
