// Flatten jobs: a box on the voxel grid whose plane the villagers level the ground to. Solid voxels above the plane
// get dug out, empty ones below it filled with dirt, one voxel at a time. Jobs aren't given to particular villagers:
// any number can be open at once, and every idle villager works on whichever open column is nearest it.
//
// Each column of the box works top-down when digging (its highest voxel above the plane first) and bottom-up when
// filling (its lowest empty voxel below the plane first, so dirt dropped into a pit or the lake sinks to the
// bottom). A column too tall to reach the top of is undercut instead: its lowest voxel above the plane is dug and
// everything above slumps down one. An idle villager claims the nearest column (of any job) nobody else is working,
// walks to a spot right beside it if it can (see standFor), else one within reach, and changes one voxel; columns it
// can't reach are skipped for a while and
// tried again later. A villager is idle when it has no column and isn't walking somewhere it was sent. One stranded
// on a pillar of the box with nothing it can reach digs its way down through the voxel it stands on.

import { SIZE, BLOCK, SOLID_MIN, WATER_LEVEL, isEdge, isOre } from './terrain.js';
import { fellTree, trunkLogs } from './trees.js';
import { sfx } from './audio.js';
import { LADDER_TUNING } from './ladders.js';

export const WORK_TUNING = {
  digTime: 0.45,     // seconds per voxel dug
  fillTime: 0.45,    // seconds per voxel filled
  reach: 2,          // voxels sideways a villager can work from
  treeReach: 3,      // and chop a trunk from (from under the leaves, which hang 2 out a voxel above the ground)
  reachUp: 2,        // voxels above its feet it can reach
  reachDown: 3,      // and below
  retryDelay: 1,     // seconds before a column that couldn't be reached is tried again
  claimMs: 6,        // milliseconds one search for a way to work may take (longer: as if there were none)
  retryMax: 30,      // and at most this many, doubling each time no worker could find a way to it
  claimsPerFrame: 4, // columns a villager may try in one frame
  idleRetry: 0.5,    // seconds an idle villager waits after finding no column it can work on
  pathsPerFrame: 1,  // path searches all workers together may make in one frame (an unreachable spot is costly)
  pathMs: 3,         // and milliseconds they may spend on them (there's always time for one)
  pathSearch: 3000,  // cells a work path search near the box may expand before giving up (from afar, the usual limit)
  jobRange: 30,      // voxels (across the ground) an idle worker goes for a pile, or for a column a seeking worker
                     // marked (the player's orders it takes at any range)
  preferEvery: 1,    // seconds between a specialist's looks, while on other work, for an order of its own kind to go to
  selfStart: 0,      // 1: an idle Lumberjack or Miner with no order finds trees or ore of its own; 0 (Jordan): all work
                     // comes from the player's orders
  seekRange: 30,     // voxels an idle Lumberjack or Miner with no order to take looks for a tree or ore of its own (see
                     // Workers.seek; no further than jobRange)
  seekEvery: 2,      // seconds between its looks
  closeFirst: 1,     // 1: a worker walks up right beside the voxel it works on when it can, working from further only
                     // when there's no way there; 0: it works from the nearest spot within reach
  island: 30,        // cells of dry land a worker keeps to walk on: it won't dig ground out into the water when that
                     // would leave it, or a villager beside it, stranded on less
  inTheWay: 100,     // how much further (in voxels) a spot to work from counts where a block's still to go at its feet
                     // or head (standing there, a worker can get built in)
};

// Carrying (a new game): what a worker digs, fells or reaps goes into its arms, not the inventory, and only counts once
// it's brought to the Keep (wheat: the Keep or any house). It carries this many at once of each; what won't fit, or
// isn't the same as what it has, is left in a pile on the ground for a trip after (see Workers.take). It heads back
// when it's full, or has nothing left to do.
export const CARRY_TUNING = { planks: 8, bricks: 16, clay: 8, ore: 5, wheat: 5 };
const WHEAT = 1; // (inventory.js WHEAT: it imports this file)
export function carryCap(block) {
  const C = CARRY_TUNING;
  const n = block === BLOCK.PLANK ? C.planks : block === BLOCK.BRICK ? C.bricks : block === BLOCK.CLAY ? C.clay
    : block === BLOCK.IRON || block === BLOCK.GOLD ? C.ore : block === WHEAT ? C.wheat : 4;
  return Math.max(1, Math.round(n));
}
// Which specializations pick up a pile of `block` (any worker does): wood for lumberjacks, wheat for farmers, the rest
// for miners.
const pileFor = (block) => block === BLOCK.PLANK ? 'lumberjack' : block === WHEAT ? 'farmer' : 'miner';

const [X, Y, Z] = SIZE;
// A cell's number, for Sets and Maps of cells (see region).
const cellKey = (x, y, z) => x + X * (z + Z * y);

export class FlattenJob {
  // Columns [x0, x1) × [z0, z1), levelled so the ground's top is at height `level`.
  // `fill` is the block it fills with.
  constructor(terrain, x0, z0, x1, z1, level, fill = BLOCK.GROUND) {
    this.terrain = terrain;
    this.fill = fill;
    this.x0 = Math.max(0, x0); this.z0 = Math.max(0, z0);
    this.x1 = Math.min(X, x1); this.z1 = Math.min(Z, z1);
    this.level = Math.max(1, Math.min(Y - 2, level));
    this.pending = [];             // columns (x + X * z) that still need work
    this.claimed = new Map();      // column -> unit id
    this.skipUntil = new Map();    // column -> time it may be tried again
    for (let z = this.z0; z < this.z1; z++) {
      for (let x = this.x0; x < this.x1; x++) if (this.task(x, z)) this.pending.push(x + X * z);
    }
  }

  get done() { return this.pending.length === 0; }

  // The next voxel to change in column (x, z), or null when it's level. Above the plane: the lowest log, if there's
  // a tree (cutting it fells the trunk, and its leaves wither), else the highest ground voxel (dig). Leaves don't
  // count, so a neighbour's branches overhanging the box don't hold the job up. Below the plane: the lowest voxel
  // that's empty (fill). `top` is where a villager has to reach to work on it: for a fill, the top of the open
  // shaft the dirt drops down. A dig also has `low`, the lowest solid voxel above the plane, for undercutting.
  task(x, z) {
    if (isEdge(x, z)) return null; // (the wall round the map: left as it is)
    const v = this.terrain.voxels, L = this.level;
    const at = (y) => v[x + X * (y + Y * z)];
    const empty = (y) => at(y) === BLOCK.AIR || at(y) === BLOCK.LEAVES;
    let dig = -1, log = false;
    for (let y = L; y < Y; y++) if (at(y) === BLOCK.LOG) { dig = y; log = true; break; }
    if (dig < 0) for (let y = Y - 1; y >= L; y--) if (!empty(y)) { dig = y; break; }
    if (dig >= 0) {
      let low = L;
      while (low < dig && empty(low)) low++;
      return { x, y: dig, z, dig: true, top: dig, low, log };
    }
    for (let y = 1; y < L; y++) {
      if (empty(y)) {
        let top = y;
        while (top + 1 < L && empty(top + 1)) top++;
        return { x, y, z, dig: false, top, place: this.fill };
      }
    }
    return null;
  }

  // Whether column (x, z) is in the box.
  contains(x, z) { return x >= this.x0 && x < this.x1 && z >= this.z0 && z < this.z1; }

  // Box marks for the terrain shader: corners and plane, and whether it's live (1) or being drawn (0); short (a new
  // game's inventory can't cover its fill, drawn yellow): 2 live, -1 being drawn.
  marks(live = 1, short = false) {
    return [[this.x0, this.level, this.z0, 3], [this.x1, this.level, this.z1, short ? (live ? 2 : -1) : live]];
  }
}

// The cube of voxels a brush of `size` (voxels across) covers at a raycast hit: for Raise (add) the cube starts at
// the empty voxel in front of the face clicked, for Lower at the voxel clicked, centred on it (an even size reaches
// one further up and towards +x and +z). As [lo, hi).
export function brushCube(hit, size, add) {
  const s = add ? 0.5 : -0.5;
  const c = hit.point.map((v, i) => Math.floor(v + hit.normal[i] * s));
  const lo = c.map((v) => v - Math.floor((size - 1) / 2));
  return { lo, hi: lo.map((v) => v + size) };
}

// The voxels a Raise (add) or Lower brush marks at a hit: the empty ones in its cube to fill, or the solid ones to
// dig (never the bedrock). As [x, y, z].
export function brushVoxels(terrain, hit, size, add) {
  const { lo, hi } = brushCube(hit, size, add);
  const out = [];
  for (let z = Math.max(0, lo[2]); z < Math.min(SIZE[2], hi[2]); z++) {
    for (let y = Math.max(1, lo[1]); y < Math.min(SIZE[1], hi[1]); y++) {
      for (let x = Math.max(0, lo[0]); x < Math.min(SIZE[0], hi[0]); x++) {
        const b = terrain.block(x, y, z);
        if (add ? b === BLOCK.AIR : b >= SOLID_MIN) out.push([x, y, z]);
      }
    }
  }
  return out;
}

// How far villagers reach for marked ground (as if they had ladders), so a brush's worth can be dug or filled.
const SCULPT_REACH = { reach: 3, reachUp: 5, reachDown: 6 };
export const BOX_MAX = 32; // tallest box the Raise and Lower drags make, in voxels
const BOX_REACH = { reach: 3, reachUp: BOX_MAX + 2, reachDown: 6 };

// The voxels a Raise or Lower drag marks in the box [x0, x1) × [y0, y1) × [z0, z1): to fill, the empty ones; to dig,
// the solid ones (never the bedrock).
export function boxVoxels(terrain, x0, z0, x1, z1, y0, y1, add) {
  const out = [];
  for (let z = Math.max(0, z0); z < Math.min(SIZE[2], z1); z++) {
    for (let x = Math.max(0, x0); x < Math.min(SIZE[0], x1); x++) {
      for (let y = Math.max(1, y0); y < Math.min(SIZE[1], y1); y++) {
        const b = terrain.block(x, y, z);
        if (add ? b === BLOCK.AIR : b >= SOLID_MIN) out.push([x, y, z]);
      }
    }
  }
  return out;
}

// Ground the Raise and Lower tools have marked (a click's cube, or a drag's box): voxels to fill (with the block chosen in the palette) or to dig out, one by one, by idle
// villagers, as a job like the flatten jobs. There's one of these, holding every mark; marking a voxel again
// replaces its mark. In each column the highest voxel to dig goes first, then the lowest to fill.
export class SculptJob {
  constructor(terrain) {
    this.terrain = terrain;
    this.want = new Map();     // voxel index -> BLOCK.AIR (dig) or the block to fill it with
    this.columns = new Map();  // column (x + X * z) -> Set of heights marked in it
    this.pending = [];
    this.claimed = new Map();
    this.skipUntil = new Map();
    this.tall = new Set();     // columns marked by a box (see markVoxels)
    this.x0 = X; this.z0 = Z; this.x1 = 0; this.z1 = 0; // bounds of every column ever marked
  }

  get done() { return this.pending.length === 0; }

  contains(x, z) { return this.columns.has(x + X * z); }

  // Marks a brush's voxels (see brushVoxels): to fill with `block`, or to dig.
  mark(hit, size, add, block = BLOCK.GROUND) {
    this.markVoxels(brushVoxels(this.terrain, hit, size, add), add, block);
  }

  // Marks voxels ([x, y, z]) to fill with `block` or to dig. `tall`: they may stand far above where villagers can get
  // to (a box: see boxVoxels), so these columns are worked on from as far below as it takes.
  markVoxels(voxels, add, block = BLOCK.GROUND, tall = false) {
    const queued = new Set(this.pending);
    for (const [x, y, z] of voxels) {
      if (isEdge(x, z)) continue; // (the wall round the map: left as it is)
      this.want.set(this.terrain.index(x, y, z), add ? block : BLOCK.AIR);
      const k = x + X * z;
      let ys = this.columns.get(k);
      if (!ys) { ys = new Set(); this.columns.set(k, ys); }
      ys.add(y);
      if (tall) this.tall.add(k);
      if (!queued.has(k)) { queued.add(k); this.pending.push(k); }
      this.x0 = Math.min(this.x0, x); this.x1 = Math.max(this.x1, x + 1);
      this.z0 = Math.min(this.z0, z); this.z1 = Math.max(this.z1, z + 1);
    }
  }

  // Clears the marks in a brush's cubes at a hit (both the Raise and the Lower one).
  unmark(hit, size) {
    for (const add of [true, false]) {
      const { lo, hi } = brushCube(hit, size, add);
      for (let z = Math.max(0, lo[2]); z < Math.min(Z, hi[2]); z++) {
        for (let y = Math.max(0, lo[1]); y < Math.min(Y, hi[1]); y++) {
          for (let x = Math.max(0, lo[0]); x < Math.min(X, hi[0]); x++) {
            if (!this.want.delete(this.terrain.index(x, y, z))) continue;
            const ys = this.columns.get(x + X * z);
            ys?.delete(y);
            if (ys && !ys.size) this.columns.delete(x + X * z);
          }
        }
      }
    }
  }

  // Whether voxel (x, y, z) is marked.
  has(x, y, z) { return this.want.has(this.terrain.index(x, y, z)); }

  // Whether voxel (x, y, z) is marked to fill and not filled yet.
  fills(x, y, z) {
    const i = this.terrain.index(x, y, z), want = this.want.get(i);
    return want !== undefined && want !== BLOCK.AIR && !this.met(i, want);
  }

  // Whether voxel i is already as its mark wants it.
  met(i, want) {
    const b = this.terrain.voxels[i];
    return want === BLOCK.AIR ? b === BLOCK.AIR : b >= SOLID_MIN;
  }

  task(x, z) {
    const k = x + X * z, ys = this.columns.get(k);
    if (!ys) return null;
    let dig = -1, fill = Infinity;
    for (const y of ys) {
      const i = this.terrain.index(x, y, z), want = this.want.get(i);
      if (want === undefined || this.met(i, want)) { ys.delete(y); this.want.delete(i); continue; }
      if (want === BLOCK.AIR) dig = Math.max(dig, y); else fill = Math.min(fill, y);
    }
    if (!ys.size) { this.columns.delete(k); this.tall.delete(k); return null; }
    const reach = this.tall.has(k) ? BOX_REACH : SCULPT_REACH;
    if (dig >= 0) return { x, y: dig, z, dig: true, top: dig, low: dig, ...reach };
    return { x, y: fill, z, dig: false, top: fill, place: this.want.get(this.terrain.index(x, fill, z)), ...reach };
  }

  // The marks still to do, for drawing: [x, y, z, kind] with kind 0 dig, 1 fill, 6 a fill the inventory can't cover
  // (shortVoxels, see inventory.js).
  ghosts(out = []) {
    for (const [i, want] of this.want) {
      if (this.met(i, want)) continue;
      out.push([i % X, Math.floor(i / X) % Y, Math.floor(i / (X * Y)), want === BLOCK.AIR ? 0 : this.shortVoxels?.has(i) ? 6 : 1]);
    }
    return out;
  }

  marks() { return []; } // drawn as ghost cubes instead
}

// Blocks and trees to mine. With owners (unit ids), only they take its work, before any other job; without (null:
// the god panel's Mine orders, one shared job), any idle worker near it does. Each target is a voxel to dig out, or a
// tree's bottom log (cutting it fells the trunk). Columns are worked top-down.
const MINE_REACH = { reach: 3, reachUp: 4, reachDown: 5 };
export class MineJob {
  constructor(terrain, owners) {
    this.terrain = terrain;
    this.owners = owners ? new Set(owners) : null;
    this.columns = new Map(); // column (x + X * z) -> Set of heights to dig
    this.pending = [];
    this.claimed = new Map();
    this.skipUntil = new Map();
    this.auto = new Set(); // columns only a seeking worker marked (see Workers.seek), none of them the player's
    this.x0 = X; this.z0 = Z; this.x1 = 0; this.z1 = 0;
  }

  get done() { return this.pending.length === 0; }

  contains(x, z) { return this.columns.has(x + X * z); }

  // Adds voxel (x, y, z) (a block, or a tree's bottom log). auto: marked by a seeking worker, not the player.
  add(x, y, z, auto = false) {
    if (isEdge(x, z)) return; // (the wall round the map: left as it is)
    const k = x + X * z;
    let ys = this.columns.get(k);
    if (!ys) { ys = new Set(); this.columns.set(k, ys); this.pending.push(k); if (auto) this.auto.add(k); }
    if (!auto) this.auto.delete(k);
    ys.add(y);
    this.x0 = Math.min(this.x0, x); this.x1 = Math.max(this.x1, x + 1);
    this.z0 = Math.min(this.z0, z); this.z1 = Math.max(this.z1, z + 1);
  }

  // Whether voxel (x, y, z) is already marked.
  has(x, y, z) { return !!this.columns.get(x + X * z)?.has(y); }

  // Drops the mark on voxel (x, y, z), if it has one.
  remove(x, y, z) {
    const k = x + X * z, ys = this.columns.get(k);
    if (!ys) return;
    ys.delete(y);
    if (!ys.size) { this.columns.delete(k); this.auto.delete(k); }
  }

  // Drops every mark in columns x0..x1-1, z0..z1-1 (Delete, under the brush).
  unmark(x0, z0, x1, z1) {
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) { this.columns.delete(x + X * z); this.auto.delete(x + X * z); }
  }

  task(x, z) {
    const k = x + X * z, ys = this.columns.get(k);
    if (!ys) return null;
    let dig = -1;
    for (const y of ys) {
      const b = this.terrain.block(x, y, z);
      if (b < SOLID_MIN || b === BLOCK.LEAVES) ys.delete(y); else dig = Math.max(dig, y);
    }
    if (dig < 0) { this.columns.delete(k); this.auto.delete(k); return null; }
    const log = this.terrain.block(x, dig, z) === BLOCK.LOG;
    return { x, y: dig, z, dig: true, top: dig, low: dig, log, ...MINE_REACH, ...(log ? { reach: WORK_TUNING.treeReach } : {}) };
  }

  // The voxels still to dig, for drawing as red ghost cubes: [x, y, z, 0]; a log marks the whole trunk it fells (not
  // its leaves).
  ghosts(out = []) {
    const logs = [], seen = new Set();
    for (const [k, ys] of this.columns) {
      const x = k % X, z = Math.floor(k / X);
      for (const y of ys) {
        const b = this.terrain.block(x, y, z);
        if (b === BLOCK.LOG) trunkLogs(this.terrain, x, y, z, logs, seen);
        else if (b >= SOLID_MIN && b !== BLOCK.LEAVES) out.push([x, y, z, 0]); // (not those gone already)
      }
    }
    for (const [x, y, z] of logs) out.push([x, y, z, 0]);
    return out;
  }

  marks() { return []; }
}

// A job to fell one tree: a flatten box of just its trunk's column, levelled at the trunk's foot, so the bottom log
// is the voxel to dig (which fells the trunk, and its leaves wither). `trunk` is from findTrunk.
export function harvestJob(terrain, trunk) {
  const [x, y, z] = trunk;
  return new FlattenJob(terrain, x, z, x + 1, z + 1, y);
}

// What a villager builds with a block: wood goes in as planks, stone as bricks and dirt as clay bricks.
export function built(block) {
  return block === BLOCK.LOG ? BLOCK.PLANK : block === BLOCK.STONE ? BLOCK.BRICK : block === BLOCK.GROUND ? BLOCK.CLAY : block;
}

// The tool a villager carries for its task: an axe for a tree (or planks), a pickaxe for stone, a shovel for digging
// or filling earth, a hammer for building (with anything but earth), nothing when it has no task. A task that isn't a
// block (onPlace) names its own (a farm's hoe or sickle), or none (a torch: it carries that).
export function toolFor(terrain, u) {
  const t = u.task;
  if (!t) return null;
  if (t.onPlace) return t.tool ?? null;
  if (!t.dig) return !t.place || t.place === BLOCK.GROUND ? 'shovel' : 'hammer';
  const b = terrain.block(t.x, t.y, t.z);
  if (b === BLOCK.LOG || b === BLOCK.PLANK) t.tool = 'axe';
  else if (b === BLOCK.STONE || b === BLOCK.BRICK || b === BLOCK.IRON || b === BLOCK.GOLD) t.tool = 'pickaxe';
  else if (b === BLOCK.GROUND || b === BLOCK.FARM || b === BLOCK.CLAY) t.tool = 'shovel';
  return t.tool ?? 'shovel'; // the block's already gone: keep what it had
}

// Seconds a task takes: its own (a farm's tilling or harvest), or a dig's or a fill's.
export const workTime = (t) => t.time ?? (t.dig ? WORK_TUNING.digTime : WORK_TUNING.fillTime);

// Worker specializations (picked on the dock's Job, u.spec): a 'worker' (the default) takes any open order, nearest
// first; the others take their own kind of work first (specFor), however far, and any other open order only when
// there's none of that: a lumberjack fells trees, a miner digs (Mine, Lower, flatten), a builder places blocks and
// clears a building's footprint (buildings, Fill, Raise, torches) and a farmer tills and reaps. On other work, one
// drops it as soon as an order of its own kind comes up (see preferOpen). t: a task (its job in t.job, or given as job).
export const SPECS = ['worker', 'lumberjack', 'miner', 'builder', 'farmer'];
export function specFor(terrain, t, job = t.job) {
  if (t.tool === 'hoe' || t.tool === 'sickle') return 'farmer';
  if (job?.plan) return 'builder'; // (a building: its digging out of the way too)
  if (t.dig) return t.log || terrain.block(t.x, t.y, t.z) === BLOCK.LOG ? 'lumberjack' : 'miner';
  return 'builder';
}

// A team's open jobs, and its workers working on them: picks columns for its idle workers, walks them there and
// carries out the work. Each team has its own (Units.crews), with its own orders, inventory and piles, so one team's
// workers never take another's orders or spend its blocks. Lives alongside Units, which owns the villagers.
export class Workers {
  constructor(units, team = 'blue') {
    this.units = units;
    this.team = team;
    this.jobs = [];
    this.clock = 0;
    this.inventory = null; // a new game's (see inventory.js); sandbox has none, and every block is free
    this.seeking = null;   // { job, seen(x, z) }: where Lumberjacks and Miners mark what they find (see seek)
    this.depots = null;    // (block) => [{ lo, hi }]: where this team's workers take what they carry (deliver; a new game)
    this.piles = [];       // { x, y, z, block, n }: what's left on the ground for a later trip (see take)
    this.paths = null;     // { deadline, n }: the path searches every team's workers share this frame (see Units.update)
  }
  // Whether this frame's path searches are used up (one more is allowed: see paths), else counts one.
  pathBudget() {
    const P = this.paths;
    if (P.n >= WORK_TUNING.pathsPerFrame || (P.n > 0 && performance.now() > P.deadline)) return false;
    P.n++;
    return true;
  }

  // Whether the inventory has a block for task t (when it places one) that nobody else is already placing.
  affords(t, u) {
    return !this.inventory || t.dig || t.onPlace || this.inventory.affords(built(t.place ?? BLOCK.GROUND), u);
  }

  add(job) {
    if (!job.done) this.jobs.push(job);
  }

  // Calls a job off: whoever was working on it goes idle.
  cancel(job) {
    this.jobs = this.jobs.filter((j) => j !== job);
    job.cancel?.();
    for (const u of this.units.list) if (u.task?.job === job) this.release(u);
  }

  // Takes a unit off the column it was working on (a move order does this).
  release(u) {
    if (u.task) u.task.job.claimed.delete(u.task.x + X * u.task.z);
    u.task = null;
    u.working = 0;
  }
  // A move or stop order (or its death): it drops what it's on and the blocks it was given to mine.
  stop(u) {
    this.release(u);
    this.endLadder(u);
    for (const j of this.jobs) j.owners?.delete(u.id);
  }

  // Free to take on work: one of this team's workers, not on a column and not walking somewhere it was sent.
  idle(u) {
    return u.team === this.team && u.kind === 'worker' && !u.dying && !u.task && !u.ladderBuild && !(u.goal && (u.path.length || u.repath > 0)) && this.clock >= (u.nextClaim ?? 0);
  }

  // Per frame, before the units move: give idle villagers a column, and do the work of those that have arrived.
  // paths: this frame's path searches, shared with the other teams' workers (see Units.update).
  update(dt, paths = { deadline: performance.now() + WORK_TUNING.pathMs, n: 0 }) {
    this.clock += dt;
    this.paths = paths;
    // Take the team's villagers in turn, starting one further along each frame, so when there's only time for some of
    // them to look for a path, it isn't always the same ones.
    const list = this.units.list.filter((u) => u.team === this.team), n = list.length;
    this.turn = ((this.turn ?? 0) + 1) % Math.max(1, n);
    for (let j = 0; j < n; j++) {
      const u = list[(this.turn + j) % n];
      if (u.ladderBuild) this.buildLadder(u, dt);
      else if (u.task) {
        if (!this.jobs.includes(u.task.job)) { this.release(u); continue; }
        // A specialist on other work: an order of its own kind come up, it drops this (and takes what it carries home
        // first: see haul) and goes to that.
        const spec = u.spec ?? 'worker';
        if (spec !== 'worker' && this.clock >= (u.nextPrefer ?? 0)) {
          u.nextPrefer = this.clock + WORK_TUNING.preferEvery;
          if (!this.suits(spec, u.task.job, u.task.x + X * u.task.z) && this.preferOpen(spec)) {
            this.release(u);
            u.path = [];
            if (u.carry && this.inventory) u.haul = true;
            continue;
          }
        }
        if (u.path.length) continue;
        if (!this.inReach(u.cell, u.task)) { this.giveUp(u, 1); continue; }
        this.work(u, dt);
      } else if (this.idle(u)) {
        if (this.inventory && this.haul(u)) continue; // (a new game: taking a load home, or fetching a pile)
        // Arms full (or a load left in a pile it has to come back for) and no way home just now: it waits and tries
        // again, rather than digging more only to leave it on the ground.
        if (u.carry && u.haul) { u.nextClaim = this.clock + WORK_TUNING.idleRetry; continue; }
        if (this.jobs.length) {
          u.goal = null; // a move order it couldn't finish
          u.queue = [];
          this.claim(u);
        } else if (!this.seek(u) && !(u.carry && this.deliver(u))) { // (nothing left to do: home with what it has)
          // Stuck down a pit with somewhere to be (a load to take home, a place it was sent, work of its own to find),
          // or not put there: it builds a ladder out.
          const seeker = WORK_TUNING.selfStart >= 0.5 && (u.spec === 'lumberjack' || u.spec === 'miner');
          if (u.carry || u.stuckGoal || seeker || !u.sentHere) this.escape(u);
        }
      }
    }
    this.settle();
    this.jobs = this.jobs.filter((j) => !j.done || (j.onDone?.(), false)); // (onDone: e.g. a house's new worker)
    this.jobs = this.jobs.filter((j) => !j.owners || j.owners.size); // (mine jobs nobody's left to do)
  }

  // How a unit with its feet in `cell` can work on task t: 'top' (normally), 'low' (undercutting a dig), or null.
  reachable(cell, t) {
    const T = WORK_TUNING;
    const side = Math.max(Math.abs(cell[0] - t.x), Math.abs(cell[2] - t.z));
    if (side < 1) { // its own column: digging down, or building itself up out of where it's walled in (see buildUp)
      if (!t.self) return null;
      return (t.dig ? t.top === cell[1] - 1 : t.y === cell[1] || t.y === cell[1] + 1) ? 'top' : null;
    }
    if (side > (t.reach ?? (t.log ? T.treeReach : T.reach))) return null;
    const within = (y) => y >= cell[1] - (t.reachDown ?? T.reachDown) && y <= cell[1] + (t.reachUp ?? T.reachUp);
    if (within(t.top)) return 'top';
    if (t.dig && within(t.low)) return 'low';
    return null;
  }
  inReach(cell, t) { return this.reachable(cell, t) !== null; }

  // What task t gives a worker to carry (wood from a tree, bricks from stone, wheat from a ripe farm...), or null for
  // work that gives nothing (building, filling, tilling).
  gives(t) {
    if (!t) return null;
    if (t.tool === 'sickle') return WHEAT;
    if (!t.dig) return null;
    return this.inventory?.yieldOf(this.units.terrain.block(t.x, t.y, t.z))?.[0] ?? null;
  }

  // Whether dig task t's voxel is buried: no open voxel beside it (above, below or on a side), so a worker can only get
  // at it through the ground round it. (A tree's log never is.)
  buried(t) {
    if (!t?.dig || t.log) return false;
    const ter = this.units.terrain, { x, y, z } = t;
    return ter.solid(x, y + 1, z) && ter.solid(x + 1, y, z) && ter.solid(x - 1, y, z) && ter.solid(x, y, z + 1) && ter.solid(x, y, z - 1) && ter.solid(x, y - 1, z);
  }

  // The nearest unclaimed column of any job that it can get to (a buried block last, see buried), and the path to a
  // spot beside it.
  claim(u) {
    const units = this.units, BURIED = 4 * (WORK_TUNING.jobRange + 1) ** 2, OTHER = 1e12;
    for (let tries = 0; tries < WORK_TUNING.claimsPerFrame; tries++) {
      let job = null, best = -1, bestD = Infinity;
      // Its own mine jobs first (others' are never its): any other job only once none has a column free for it.
      const own = this.jobs.some((j) => j.owners?.has(u.id) && j.pending.some((k) => !j.claimed.has(k) && (j.skipUntil.get(k) ?? 0) <= this.clock));
      // The player's orders at any range (what a seeking worker marked only in range, like what it seeks itself); a
      // specialist's own kind first, anything else counting as further than all of those (OTHER).
      const range2 = WORK_TUNING.jobRange ** 2;
      const spec = u.spec ?? 'worker';
      for (const j of this.jobs) {
        if (j.owners ? !j.owners.has(u.id) : own) continue;
        for (let i = 0; i < j.pending.length; i++) {
          const k = j.pending[i];
          if (j.claimed.has(k)) continue;
          const dx = (k % X) + 0.5 - u.pos[0], dz = Math.floor(k / X) + 0.5 - u.pos[2];
          const d = dx * dx + dz * dz;
          if (d >= bestD || (d > range2 && j.auto?.has(k))) continue;
          const task = j.task(k % X, Math.floor(k / X));
          const other = spec !== 'worker' && task && specFor(units.terrain, task, j) !== spec ? OTHER : 0;
          if (d + other >= bestD) continue;
          // Carrying something: only work that gives more of the same, till it's taken that home.
          if (u.carry && this.inventory && this.gives(task) !== u.carry.block) continue;
          // A block buried in ground nobody's to dig (a vein under dirt) only once there's nothing in the open: it's
          // reached through the ground, so it counts as further than anything in range.
          const buried = this.buried(task);
          if (buried && d + other + BURIED >= bestD) continue;
          // A column waiting to be retried (someone couldn't get to it) is still fine for a villager already in reach.
          if ((j.skipUntil.get(k) ?? 0) > this.clock) {
            const t = d <= 25 && j.task(k % X, Math.floor(k / X));
            if (!t || !this.inReach(u.cell, t) || !this.affords(t, u) || this.underfoot(t)) continue;
          }
          bestD = d + other + (buried ? BURIED : 0); best = i; job = j;
        }
      }
      if (!job) { // all claimed, or waiting to be retried
        if (this.digDown(u) || this.buildUp(u) || this.seek(u)) return;
        if (u.carry && this.deliver(u)) return; // (nothing to do: home)
        if (this.escape(u)) return; // (or stuck: a ladder out)
        u.nextClaim = this.clock + WORK_TUNING.idleRetry;
        return;
      }
      const k = job.pending[best];
      const t = job.task(k % X, Math.floor(k / X));
      if (!t) { job.pending[best] = job.pending[job.pending.length - 1]; job.pending.pop(); continue; }
      // A block the inventory hasn't got: leave it for now (it's tried again once the column's retry is due).
      if (!this.affords(t, u)) { job.skipUntil.set(k, this.clock + WORK_TUNING.retryDelay); continue; }
      // Dug out from under a villager, it would drop into the water: not till it's moved (see underfoot).
      if (this.underfoot(t, 'top', u)) { job.skipUntil.set(k, this.clock + WORK_TUNING.retryDelay); continue; }
      // Right beside it if it can be (unless that's been tried and there's no way there), else from within reach.
      const close = WORK_TUNING.closeFirst > 0.5 && !job.far?.has(k);
      const here = !units.yields(u) && (close ? this.isClose(u.cell, t) : this.inReach(u.cell, t));
      let stand = here ? u.cell : close ? this.standFor(u, t, true) : null, beside = close && !!stand;
      if (!stand) stand = this.inReach(u.cell, t) && !units.yields(u) ? u.cell : this.standFor(u, t);
      if (!stand) { job.skipUntil.set(k, this.clock + WORK_TUNING.retryDelay); continue; }
      if (stand[0] === u.cell[0] && stand[1] === u.cell[1] && stand[2] === u.cell[2]) stand = u.cell;
      let path = [];
      if (stand !== u.cell) {
        // Out of time for path searches this frame: try again next frame.
        if (!this.pathBudget()) return;
        const near = u.cell[0] >= job.x0 - 4 && u.cell[0] < job.x1 + 4 && u.cell[2] >= job.z0 - 4 && u.cell[2] < job.z1 + 4;
        path = units.findPath(u.cell, stand, near ? WORK_TUNING.pathSearch : undefined, true, u.team, performance.now() + WORK_TUNING.claimMs);
        const end = path[path.length - 1];
        if (!end || end[0] !== stand[0] || end[1] !== stand[1] || end[2] !== stand[2]) {
          // No way to get right beside it: next time, from wherever's within reach. No way at all: tried again later,
          // twice as long each time (a search that finds no way is the longest there is), up to retryMax seconds.
          if (beside) (job.far ??= new Set()).add(k);
          else {
            const misses = (job.misses ??= new Map()), n = (misses.get(k) ?? 0) + 1;
            misses.set(k, n);
            job.skipUntil.set(k, this.clock + Math.min(WORK_TUNING.retryMax, WORK_TUNING.retryDelay * 2 ** (n - 1)));
          }
          continue;
        }
      }
      job.claimed.set(k, u.id);
      job.misses?.delete(k);
      t.job = job;
      u.task = t;
      u.path = path;
      u.working = 0;
      u.sentHere = false;
      return;
    }
  }

  // Ladders (see ladders.js). A worker that can't get back to the Keep (or, sent somewhere, there; with no Keep, one
  // that can walk to fewer than LADDER_TUNING.trapped cells) builds one, for free: up the middle of open cells from
  // somewhere it can get to, as high as it takes to step off (or onto an old ladder) where it can get home from. The
  // fewest rungs nearest it win. It fixes them one at a time as it climbs. One's enough at a time for a pit: the others
  // there wait for it. Returns whether it's building one.
  escape(u) {
    const L = LADDER_TUNING, units = this.units, t = units.terrain, lad = units.ladders;
    if (!lad || this.clock < (u.nextEscape ?? 0)) return false;
    u.nextEscape = this.clock + L.every;
    const goals = u.stuckGoal ? [u.stuckGoal] : this.homeCells(u, u.carry?.block ?? BLOCK.BRICK);
    const N = Math.max(4, Math.round(L.trapped)), BIG = 4000, ms = () => performance.now() + WORK_TUNING.claimMs;
    const pit = this.flood(u.cell, BIG, new Set(goals.map((g) => cellKey(...g)))), whole = this.grow(pit, ms()), region = pit.seen;
    // Not stuck: it can get there (or, with nowhere it has to be, it isn't hemmed in; or that takes too long to tell:
    // it's walking about plenty of ground).
    if (goals.length) {
      if (region.hit) return false;
      if (region.size >= BIG || !whole) {
        const g = goals[0], end = units.findPath(u.cell, g, undefined, true, u.team, ms()).at(-1) ?? u.cell;
        if (end.join() === g.join() || units.searchTimedOut) return false;
      }
    } else if (region.size >= N || !whole) return false;
    if (lad.building.some((b) => region.has(cellKey(b.x, b.y0, b.z)))) return false; // (someone's on it)
    // Where it can get home from: the cells reachable from there (near enough, as it can walk back the way it came,
    // bar the drops), checked properly by a path before it starts. Flooded a bit at a time (it looks again soon), and
    // kept a while.
    let home = null;
    if (goals.length) {
      const hk = goals[0].join(), homes = (this.homeRegions ??= new Map());
      let H = homes.get(hk);
      if (!H || this.clock >= H.until) homes.set(hk, (H = { until: Infinity, f: this.flood(goals[0], 30000) }));
      if (!H.f.done) {
        if (!this.grow(H.f, ms())) { u.nextEscape = this.clock + 0.3; return false; }
        H.until = this.clock + 10;
        for (const [k, h] of homes) if (this.clock >= h.until) homes.delete(k);
      }
      home = H.f.seen;
    }
    const tried = new Map();
    const good = (c) => {
      const k = cellKey(...c);
      if (region.has(k)) return false;
      if (home) return home.has(k);
      if (!tried.has(k)) tried.set(k, this.region(c, N).size >= N);
      return tried.get(k);
    };
    const near = [...region.values()].map((c) => ({ c, d: Math.hypot(c[0] + 0.5 - u.pos[0], c[1] - u.pos[1], c[2] + 0.5 - u.pos[2]) }))
      .sort((a, b) => a.d - b.d).slice(0, 800);
    const spots = [];
    for (const { c: [x, y, z], d } of near) {
      let rungs = 0;
      for (let h = y + 1; h <= y + L.maxHeight && h < SIZE[1] - 3; h++) {
        if (t.solid(x, h, z) || t.solid(x, h + 1, z)) break; // (no room to climb)
        if (!lad.has(x, h, z)) rungs++;
        let exit = null;
        for (const [nx, ny, nz] of units.neighbours(x, h, z, true)) {
          if (ny < h && nx === x && nz === z) continue; // (back down)
          if (good([nx, ny, nz])) { exit = [nx, ny, nz]; break; }
        }
        if (exit) { spots.push({ x, y, z, top: h, exit, cost: rungs * 2 + d }); break; }
      }
    }
    spots.sort((a, b) => a.cost - b.cost);
    for (const s of spots.slice(0, 3)) {
      if (home) { // (there or as good as: next to it)
        const g = goals[0], e = units.findPath(s.exit, g, 20000, true, u.team, ms()).at(-1) ?? s.exit;
        if (units.searchTimedOut || Math.max(Math.abs(e[0] - g[0]), Math.abs(e[2] - g[2])) > 1 || Math.abs(e[1] - g[1]) > 2) continue;
      }
      const foot = [s.x, s.y, s.z];
      const path = foot.join() === u.cell.join() ? [] : units.findPath(u.cell, foot, 4000, true, u.team);
      if ((path.at(-1) ?? u.cell).join() !== foot.join()) continue;
      // It climbs facing the way it steps off (onto an old ladder above: facing as that does).
      const above = s.exit[0] === s.x && s.exit[2] === s.z && lad.get(...s.exit);
      const dx = above ? above.dx : Math.sign(s.exit[0] - s.x), dz = above ? above.dz : Math.sign(s.exit[2] - s.z);
      this.release(u);
      u.path = path;
      u.goal = null;
      u.ladderBuild = { x: s.x, z: s.z, dx, dz, y0: s.y, top: s.top, next: s.y, exit: s.exit, pit: region };
      lad.building.push(u.ladderBuild);
      return true;
    }
    return false;
  }

  // Cells right round the nearest place u can take `block` to (the Keep; wheat, the Keep or a house; none in sandbox).
  homeCells(u, block) {
    const boxes = this.depots?.(block) ?? [];
    if (!boxes.length) return [];
    const mid = (b) => [(b.lo[0] + b.hi[0]) / 2, (b.lo[2] + b.hi[2]) / 2];
    const far = (b) => Math.hypot(mid(b)[0] - u.pos[0], mid(b)[1] - u.pos[2]);
    const { lo, hi } = boxes.sort((a, b) => far(a) - far(b))[0];
    const cells = [];
    for (let z = lo[2] - 1; z <= hi[2]; z++) {
      for (let x = lo[0] - 1; x <= hi[0]; x++) {
        if (x >= lo[0] && x < hi[0] && z >= lo[2] && z < hi[2]) continue; // (round it)
        const h = this.units.standHeight(x, z, lo[1], 3);
        if (h >= 0) cells.push([x, h, z]);
      }
    }
    return cells;
  }

  // The cells a worker in `cell` can get to (climbing ladders), up to n: cellKey -> [x, y, z]. Stops early (with .hit
  // set) on reaching one of the keys in `stop`.
  region(cell, n, stop = null) {
    const f = this.flood(cell, n, stop);
    this.grow(f);
    return f.seen;
  }
  // The same a bit at a time: flood() starts one, grow(f, deadline) carries it on till it's done (true) or it's out of
  // time (false; call again to go on). Its cells are in f.seen.
  flood(cell, n, stop = null) {
    const k0 = cellKey(...cell), seen = new Map([[k0, cell]]);
    if (stop?.has(k0)) seen.hit = true;
    return { seen, queue: [cell], q: 0, n, stop, done: !!seen.hit };
  }
  grow(f, deadline = Infinity) {
    const units = this.units, out = units.steps, { seen, queue, stop } = f;
    for (; !f.done && f.q < queue.length && seen.size < f.n; f.q++) {
      if ((f.q & 63) === 0 && performance.now() > deadline) return false;
      const m = units.expand(...queue[f.q], true);
      for (let i = 0; i < m; i++) {
        const x = out[i * 4], y = out[i * 4 + 1], z = out[i * 4 + 2], k = cellKey(x, y, z);
        if (seen.has(k)) continue;
        const c = [x, y, z];
        seen.set(k, c);
        queue.push(c);
        if (stop?.has(k)) { seen.hit = true; return (f.done = true); }
      }
    }
    return (f.done = true);
  }

  // Per frame, a worker building a ladder (u.ladderBuild): it walks to its foot, fixes the rungs it can reach (up to
  // two above its feet), climbs up one, and so on to the top, then climbs off. Then on to where it was sent, if it was.
  buildLadder(u, dt) {
    const b = u.ladderBuild, units = this.units, t = units.terrain, lad = units.ladders;
    if (u.path.length) return;
    const there = u.cell[0] === b.x && u.cell[2] === b.z;
    if (b.next > b.top) { // built
      if (u.cell.join() === b.exit.join()) {
        this.endLadder(u);
        // The others idle down there with it (and not put there) come up too.
        for (const o of units.list) {
          if (o === u || !this.idle(o) || o.sentHere || o.path.length || !b.pit.has(cellKey(...o.cell))) continue;
          const path = units.findPath(o.cell, b.exit, 2000, true, o.team);
          if (path.length) { o.path = path; o.goal = path.at(-1); }
        }
        u.nextEscape = 0;
        const g = u.stuckGoal;
        if (g) { units.send(u, g); if (u.stuckGoal) u.stuckGoal = null; } // (still no way: it stays put)
        else if (!units.standable(...u.cell)) { // (off onto an old ladder: up it, as far as somewhere to stand)
          const home = this.homeCells(u, u.carry?.block ?? BLOCK.BRICK)[0], path = home ? units.findPath(u.cell, home, 20000, true, u.team) : [];
          const i = path.findIndex((c) => units.standable(...c));
          if (i >= 0) { u.path = path.slice(0, i + 1); u.goal = path[i]; }
        }
        return;
      }
      const path = units.findPath(u.cell, b.exit, 400, true, u.team), end = path.at(-1);
      if (end?.join() !== b.exit.join()) { this.endLadder(u); return; }
      u.path = path;
      return;
    }
    // Something's changed: the column's been filled, or it was knocked off the ladder.
    if (!there || t.solid(b.x, b.next, b.z) || t.solid(b.x, b.next + 1, b.z)) {
      if (!there && units.footing(...u.cell, true)) {
        const path = units.findPath(u.cell, [b.x, b.next <= b.y0 + 2 ? b.y0 : b.next - 2, b.z], 400, true, u.team);
        const end = path.at(-1);
        if (end && end[0] === b.x && end[2] === b.z) { u.path = path; return; }
      }
      this.endLadder(u);
      return;
    }
    if (lad.has(b.x, b.next, b.z)) { b.next++; return; } // (already there: an old ladder's)
    if (b.next > u.cell[1] + 2) { // out of reach: up a rung
      if (lad.has(b.x, u.cell[1] + 1, b.z)) u.path = [[b.x, u.cell[1] + 1, b.z]];
      else this.endLadder(u);
      return;
    }
    if (Math.abs(u.pos[1] - u.cell[1]) > 0.04) return; // (still climbing onto the rung)
    // Facing the way it'll climb, hammering the next rung on.
    u.ladderTask = { x: b.x, y: b.next, z: b.z, dig: false, place: BLOCK.PLANK, time: LADDER_TUNING.buildTime };
    const want = Math.atan2(b.dx, b.dz);
    u.yaw += ((((want - u.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI)) * Math.min(1, dt * 12);
    const T = Math.max(LADDER_TUNING.buildTime, 1e-3), s0 = u.working / T;
    u.working += dt;
    const at = [b.x + 0.5, b.next + 0.5, b.z + 0.5];
    if (s0 < 0.5 && u.working / T >= 0.5) sfx('hammer', at, { gain: 0.6 });
    if (u.working < T) return;
    u.working = 0;
    lad.add(b.x, b.next, b.z, b.dx, b.dz);
    sfx('placeWood', at, { gain: 0.6 });
    b.next++;
  }
  endLadder(u) {
    const b = u.ladderBuild;
    if (!b) return;
    const lad = this.units.ladders;
    lad.building = lad.building.filter((x) => x !== b);
    u.ladderBuild = null;
    u.ladderTask = null;
    u.working = 0;
  }

  // A Lumberjack or Miner with no order to take on finds work of its own: the nearest tree, or iron or gold ore with a
  // face open to the air (never plain stone, which still needs an order), within seekRange of it, that the player has
  // seen and that isn't marked already, and marks it on the shared Mine order (seeking.job) to take next. Done with
  // it (or another worker's on it), it looks again, so it works its way through a forest or along a vein. What it
  // marked last time still there with nobody on it when it looks again, it couldn't get to: that's unmarked and it
  // doesn't go for it again. Returns whether it found something.
  seek(u) {
    const S = this.seeking, spec = u.spec;
    if (!S || WORK_TUNING.selfStart < 0.5 || (spec !== 'lumberjack' && spec !== 'miner')) return false;
    const t = this.units.terrain, job = S.job;
    // Done with what it went for last time: it looks again at once (it only waits seekEvery after finding nothing,
    // or before deciding it couldn't get to it).
    const done = u.sought && !(job.has(...u.sought) && t.solid(...u.sought));
    if (this.clock < (u.nextSeek ?? 0) && !done) return false;
    u.nextSeek = this.clock + WORK_TUNING.seekEvery;
    if (u.sought) {
      const [x, y, z] = u.sought;
      u.sought = null;
      if (job.has(x, y, z) && !job.claimed.has(x + X * z) && t.solid(x, y, z)) {
        job.unmark(x, z, x + 1, z + 1);
        (u.seekSkip ??= new Set()).add(t.index(x, y, z));
      }
    }
    const R = Math.round(Math.min(WORK_TUNING.seekRange, WORK_TUNING.jobRange)), [cx, cy, cz] = u.cell;
    let best = null, bestD = Infinity;
    // Rings outwards, till none further out could hold anything nearer.
    for (let r = 0; r <= R && r * r < bestD; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const d = dx * dx + dz * dz, x = cx + dx, z = cz + dz;
          if (d >= bestD || d > R * R || x < 1 || z < 1 || x >= X - 1 || z >= Z - 1 || isEdge(x, z) || !S.seen(x, z)) continue;
          const c = spec === 'lumberjack' ? this.treeAt(x, z, cy) : this.oreAt(x, z);
          if (!c || job.has(...c) || u.seekSkip?.has(t.index(...c))) continue;
          best = c; bestD = d;
        }
      }
    }
    if (!best) return false;
    job.add(...best, true);
    if (!this.jobs.includes(job)) this.add(job);
    u.sought = best;
    u.nextClaim = this.clock; // (it takes it on next)
    return true;
  }
  // A tree's bottom log in column (x, z) about height y (a stump's too), or null.
  treeAt(x, z, y) {
    const t = this.units.terrain;
    for (let qy = Math.max(1, y - 8); qy <= y + 8; qy++) {
      if (t.block(x, qy, z) === BLOCK.LOG && t.block(x, qy - 1, z) !== BLOCK.LOG) return [x, qy, z];
    }
    return null;
  }
  // The highest iron or gold ore in column (x, z) near its top with a face open to the air, above the water, or null.
  oreAt(x, z) {
    const t = this.units.terrain, g = t.groundAt(x, z);
    for (let y = g - 1; y >= Math.max(WATER_LEVEL, g - 8); y--) {
      if (!isOre(t.block(x, y, z))) continue;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) {
        if (t.block(x + dx, y + dy, z + dz) === BLOCK.AIR) return [x, y, z];
      }
    }
    return null;
  }

  // Whether there's a player's order of specialization spec's own kind open: a column nobody's on, not waiting to be
  // retried, that it would take (worked out once a frame for each).
  preferOpen(spec) {
    if (this.openClock !== this.clock) { this.openClock = this.clock; this.open = new Map(); }
    if (this.open.has(spec)) return this.open.get(spec);
    let found = false;
    for (const j of this.jobs) {
      if (j.owners) continue;
      for (const k of j.pending) {
        if (j.claimed.has(k) || j.auto?.has(k) || (j.skipUntil.get(k) ?? 0) > this.clock) continue;
        const t = j.task(k % X, Math.floor(k / X));
        if (t && specFor(this.units.terrain, t, j) === spec && this.affords(t)) { found = true; break; }
      }
      if (found) break;
    }
    this.open.set(spec, found);
    return found;
  }

  // Whether column k of job j is work for specialization spec (a column with nothing left to do is: claiming it
  // clears it out).
  suits(spec, j, k) {
    const t = j.task(k % X, Math.floor(k / X));
    return !t || specFor(this.units.terrain, t, j) === spec;
  }

  // Last resort for a villager stranded on a pillar: dig out the voxel under its feet, if that's part of a job.
  digDown(u) {
    const [x, y, z] = u.cell;
    const k = x + X * z;
    for (const job of this.jobs) {
      if (!job.contains(x, z) || job.claimed.has(k) || (job.owners && !job.owners.has(u.id))) continue;
      const t = job.task(x, z);
      if (!t || !t.dig || t.top !== y - 1 || this.sinks(x, y - 1, z)) continue; // (not down into the water)
      t.job = job;
      t.self = true;
      job.claimed.set(k, u.id);
      u.task = t;
      u.path = [];
      u.working = 0;
      return true;
    }
    return false;
  }

  // Whether a villager standing on voxel (x, y, z) would end up in the water once it's dug out (or, slump, once its
  // column comes down a voxel): it can't climb out of there, and drowns.
  sinks(x, y, z, slump = false) {
    if (slump) return y < WATER_LEVEL;
    let s = y - 1;
    while (s > 0 && !this.units.terrain.solid(x, s, z)) s--;
    return s + 1 < WATER_LEVEL;
  }

  // Whether digging t (how: 'low', undercutting it) would drop a villager into the water, or leave one (u, or one
  // beside it) stranded on a bit of land smaller than WORK_TUNING.island. One standing on it that's free to (not u) is
  // asked to step aside.
  underfoot(t, how = 'top', u = null) {
    if (!t.dig) return false;
    const slump = how === 'low', top = slump ? t.top : t.y; // (undercut: the column's top comes down one)
    if (!this.sinks(t.x, top, t.z, slump)) return false; // (there'll still be ground to stand on there)
    const near = [];
    for (const o of this.units.list) {
      if (o.dying || Math.max(Math.abs(o.cell[0] - t.x), Math.abs(o.cell[2] - t.z)) > 3) continue;
      if (o.cell[0] === t.x && o.cell[2] === t.z && o.cell[1] === top + 1) {
        if (o !== u && !o.path.length && !o.task) this.units.stepAside(o);
        return true;
      }
      if (o === u || o.kind === 'worker') near.push(o);
    }
    if (u && !near.includes(u)) near.push(u);
    const N = Math.round(WORK_TUNING.island), v = this.units.terrain.voxels, i = this.units.terrain.index(t.x, top, t.z);
    if (N < 2) return false;
    const before = near.map((o) => this.land(o.cell, N));
    const was = v[i];
    v[i] = BLOCK.AIR;
    try { return near.some((o, j) => before[j] >= N && this.land(o.cell, N) < N); } finally { v[i] = was; }
  }

  // How many cells a villager standing in `cell` can walk to (counting it), up to n.
  land(cell, n) {
    const units = this.units, t = units.terrain, seen = new Set([cell.join()]), queue = [cell];
    for (let q = 0; q < queue.length && seen.size < n; q++) {
      const [x, y, z] = queue[q];
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (let dy = 1; dy >= -3; dy--) { // (a step up, or a hop down)
          if (dy > 0 && t.solid(x, y + 2, z)) continue;
          const c = [x + dx, y + dy, z + dz];
          if (!units.standable(...c)) { if (dy <= 0 && t.solid(...c)) break; continue; }
          const k = c.join();
          if (!seen.has(k)) { seen.add(k); queue.push(c); }
          break;
        }
      }
    }
    return seen.size;
  }

  // Last resort for a villager standing where a block's still to go (at its feet or head) that nobody can place with
  // it there: it steps out of the way if it can, else (walled in by the blocks built round it) it places the block
  // itself and climbs up onto it.
  buildUp(u) {
    const [x, y, z] = u.cell, k = x + X * z, ter = this.units.terrain;
    for (const job of this.jobs) {
      if (!job.contains(x, z) || job.claimed.has(k) || (job.owners && !job.owners.has(u.id))) continue;
      const t = job.task(x, z);
      if (!t || t.dig || t.onPlace || (t.y !== y && t.y !== y + 1) || !this.affords(t, u)) continue;
      if (this.units.stepAside(u)) { u.nextClaim = this.clock + WORK_TUNING.idleRetry; return true; }
      if (ter.solid(x, t.y + 1, z) || ter.solid(x, t.y + 2, z)) continue; // (no room on top of it)
      t.job = job;
      t.self = true;
      job.claimed.set(k, u.id);
      u.task = t;
      u.path = [];
      u.working = 0;
      return true;
    }
    return false;
  }

  // Whether a job's still to fill voxel (x, y, z): a villager standing with its feet or head there would be in the
  // way of it, and could get built in.
  toFill(x, y, z) {
    for (const j of this.jobs) {
      if (!j.contains(x, z)) continue;
      if (j.fills) { if (j.fills(x, y, z)) return true; continue; }
      const t = j.task(x, z);
      if (t && !t.dig && !t.onPlace && y >= t.y && y <= t.top) return true;
    }
    return false;
  }

  // The standable cell nearest the unit from which it can reach t (its top, or undercutting it), or null.
  // Undercutting counts as a little further, so a villager on the ground beside a wall it can't reach the top of
  // (at the bottom of a pit it dug, say) undercuts it rather than heading for the rim it may not be able to get to.
  // close: only right beside it (see isClose), a side before a corner.
  standFor(u, t, close = false) {
    const top = this.standNear(u, t, t.top, close);
    if (!t.dig) return top?.cell ?? null;
    const low = this.standNear(u, t, t.low, close);
    if (!low || (top && top.d <= low.d + 1.5)) return top?.cell ?? null;
    return low.cell;
  }
  standNear(u, t, height, close = false) {
    const T = WORK_TUNING, units = this.units, R = close ? 1 : t.reach ?? (t.log ? T.treeReach : T.reach);
    const up = close ? 2 : t.reachUp ?? T.reachUp, down = close ? 1 : t.reachDown ?? T.reachDown;
    let best = null, bestD = Infinity;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        if (!dx && !dz) continue;
        for (let y = height - up; y <= height + down; y++) {
          const c = [t.x + dx, y, t.z + dz];
          if (!units.standable(...c)) continue;
          // Not where another villager's stopped or stopping, nor where a block's still to go (unless there's nowhere
          // else); right beside it, a corner counts as a few voxels further than a side.
          const d = Math.hypot(c[0] + 0.5 - u.pos[0], (c[1] - u.pos[1]) * 2, c[2] + 0.5 - u.pos[2]) + (units.taken(c, u) ? 1000 : 0)
            + (close && dx && dz ? 4 : 0) + (this.toFill(c[0], y, c[2]) || this.toFill(c[0], y + 1, c[2]) ? WORK_TUNING.inTheWay : 0);
          if (d < bestD) { bestD = d; best = c; }
        }
      }
    }
    return best && { cell: best, d: bestD };
  }
  // Whether feet in `cell` are right beside t: next to its column (a side or a corner) with the voxel it works on
  // (its top, or the one it undercuts) from a voxel below its feet to its head.
  isClose(cell, t) {
    const side = Math.max(Math.abs(cell[0] - t.x), Math.abs(cell[2] - t.z));
    if (side < 1) return this.inReach(cell, t); // (its own column, digging down)
    if (side > 1) return false;
    const by = (h) => h >= cell[1] - 1 && h <= cell[1] + 2;
    return by(t.top) || (t.dig && by(t.low));
  }

  // Carrying (a new game, see CARRY_TUNING). n of `block` gathered by u at voxel `at`: into its arms, as much as fits
  // with what it has (only the same kind); the rest left in a pile there. Full (or leaving some), it heads home.
  take(u, block, n, at = u.cell) {
    if (!n) return;
    const c = u.carry, cap = carryCap(block);
    const k = c && c.block !== block ? 0 : Math.min(n, cap - (c?.n ?? 0));
    if (k > 0) u.carry = { block, n: (c?.n ?? 0) + k };
    if (n > k) { this.drop(at, block, n - k); u.haul = true; }
    if (u.carry && u.carry.n >= cap) u.haul = true;
  }
  // A pile of n of `block` on the ground at (or under) voxel `at`, added to one of the same there.
  drop([x, y, z], block, n) {
    const t = this.units.terrain;
    while (y > 1 && !t.solid(x, y - 1, z)) y--;
    while (y < Y - 1 && t.solid(x, y, z)) y++;
    const p = this.piles.find((p) => p.x === x && p.y === y && p.z === z && p.block === block);
    if (p) p.n += n; else this.piles.push({ x, y, z, block, n });
  }

  // Piles fall when the ground's dug out from under them (a pit dug on down from where they were left), and come up
  // out of a block filled in where they are; two that end up together are one.
  settle() {
    const t = this.units.terrain;
    let moved = false;
    for (const p of this.piles) {
      const y0 = p.y;
      while (p.y > 1 && !t.solid(p.x, p.y - 1, p.z)) p.y--;
      while (p.y < Y - 1 && t.solid(p.x, p.y, p.z)) p.y++;
      if (p.y !== y0) moved = true;
    }
    if (!moved) return;
    const at = new Map();
    this.piles = this.piles.filter((p) => {
      const k = `${p.x},${p.y},${p.z},${p.block}`, q = at.get(k);
      if (!q) { at.set(k, p); return true; }
      q.n += p.n;
      return false;
    });
  }

  // An idle worker in a new game: puts down what it carries at a depot it's beside; picks up the pile it went for;
  // takes a full load home (see deliver); or, with room, goes for a pile near it (one for its specialization). Returns
  // whether that's what it's doing (else it's free for other work).
  haul(u) {
    const c = u.carry;
    if (c && this.atDepot(u, c.block)) {
      this.inventory.add(c.block, c.n);
      sfx('placeDirt', [u.pos[0], u.pos[1] + 1, u.pos[2]], { gain: 0.5 });
      u.carry = null;
      u.haul = false;
    }
    const p = u.fetching;
    u.fetching = null;
    if (p && this.piles.includes(p) && Math.max(Math.abs(p.x - u.cell[0]), Math.abs(p.z - u.cell[2])) <= 1 && Math.abs(p.y - u.cell[1]) <= 2) {
      const have = u.carry?.block === p.block ? u.carry.n : 0;
      if (!u.carry || have) {
        const k = Math.min(p.n, carryCap(p.block) - have);
        u.carry = { block: p.block, n: have + k };
        if ((p.n -= k) <= 0) this.piles = this.piles.filter((q) => q !== p);
        if (u.carry.n >= carryCap(p.block) || p.n > 0) u.haul = true; // (room left: it gathers more first)
      }
    }
    if (u.carry && u.haul) return this.deliver(u) || this.escape(u); // (no way home: a ladder)
    return this.fetch(u);
  }
  // Whether pile p is near enough u (within jobRange) for it to go for.
  nearPile(u, p) { return (p.x + 0.5 - u.pos[0]) ** 2 + (p.z + 0.5 - u.pos[2]) ** 2 <= WORK_TUNING.jobRange ** 2; }
  // The nearest pile u can carry some of (nothing in its arms, or the same and room for more) that's for its
  // specialization, and it walks over to it. Returns whether it found one.
  fetch(u) {
    if (!this.piles.length || this.clock < (u.nextFetch ?? 0)) return false;
    const spec = u.spec ?? 'worker', c = u.carry;
    let best = null, bestD = Infinity;
    for (const p of this.piles) {
      if ((c && (c.block !== p.block || c.n >= carryCap(p.block))) || (spec !== 'worker' && pileFor(p.block) !== spec)) continue;
      if (!this.nearPile(u, p) || p.skip?.get(u.id) > this.clock) continue;
      const d = (p.x + 0.5 - u.pos[0]) ** 2 + (p.z + 0.5 - u.pos[2]) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) return false;
    if (Math.max(Math.abs(best.x - u.cell[0]), Math.abs(best.z - u.cell[2])) <= 1 && Math.abs(best.y - u.cell[1]) <= 2) {
      u.fetching = best; // (already there)
      return true;
    }
    const cells = [];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const h = this.units.standHeight(best.x + dx, best.z + dz, best.y, 2);
        if (h >= 0) cells.push([best.x + dx, h, best.z + dz]);
      }
    }
    const path = this.walkTo(u, cells);
    if (path === null) return true; // (out of path searches this frame)
    if (!path) { (best.skip ??= new Map()).set(u.id, this.clock + 10); u.nextFetch = this.clock + 0.5; return false; }
    u.fetching = best;
    return true;
  }
  // Whether u is beside (or in) one of the places it can take `block` to.
  atDepot(u, block) {
    const [x, y, z] = u.cell;
    return (this.depots?.(block) ?? []).some(({ lo, hi }) =>
      x >= lo[0] - 1 && x <= hi[0] && z >= lo[2] - 1 && z <= hi[2] && y >= lo[1] - 2 && y <= hi[1]);
  }
  // Sends u with what it carries to the nearest place it can take it (the Keep; wheat, the Keep or a house): to a
  // spot right outside it. Returns whether it's on its way (false: nowhere to take it, or no way there).
  deliver(u) {
    if (!u.carry || this.clock < (u.nextDeliver ?? 0)) return false;
    const cells = this.homeCells(u, u.carry.block).filter((c) => !this.units.taken(c, u));
    if (!cells.length) return false;
    const path = this.walkTo(u, cells);
    if (path === null) return true;
    if (!path) { u.nextDeliver = this.clock + 3; return false; }
    return true;
  }
  // Walks u to the nearest of `cells` it can get to (trying the three nearest, all at once): the path (an empty one:
  // it's there), false when there's no way, or null when there's no time for path searches this frame.
  walkTo(u, cells) {
    const d = (c) => Math.hypot(c[0] + 0.5 - u.pos[0], c[1] - u.pos[1], c[2] + 0.5 - u.pos[2]);
    cells.sort((a, b) => d(a) - d(b));
    if (cells.some((c) => c[0] === u.cell[0] && c[1] === u.cell[1] && c[2] === u.cell[2])) return [];
    if (!this.pathBudget()) return null;
    for (const [i, c] of cells.slice(0, 3).entries()) {
      if (i) this.paths.n++;
      const path = this.units.findPath(u.cell, c, undefined, true, u.team), end = path[path.length - 1];
      if (end && end[0] === c[0] && end[1] === c[1] && end[2] === c[2]) {
        u.goal = c;
        u.path = path;
        return path;
      }
    }
    return false;
  }

  giveUp(u, delay) {
    const k = u.task.x + X * u.task.z;
    u.task.job.skipUntil.set(k, this.clock + delay);
    this.release(u);
  }

  work(u, dt) {
    const t = u.task;
    // Face the column.
    const want = Math.atan2(t.x + 0.5 - u.pos[0], t.z + 0.5 - u.pos[2]);
    u.yaw += ((((want - u.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI)) * Math.min(1, dt * 12);
    const T = Math.max(workTime(t), 1e-3), s0 = u.working / T;
    u.working += dt;
    const s1 = u.working / T, tool = toolFor(this.units.terrain, u), at = [t.x + 0.5, t.y + 0.5, t.z + 0.5];
    // The blows that land before the voxel changes (see units.js workPose): a hammer's or sickle's first tap, a
    // shovel pushed in.
    if ((tool === 'hammer' || tool === 'sickle') && s0 < 0.5 && s1 >= 0.5) sfx(tool === 'hammer' ? 'hammer' : 'reap', at, { gain: 0.6 });
    if (tool === 'shovel' && t.dig && s0 < 0.35 && s1 >= 0.35) sfx('shovel', at);
    if (u.working < workTime(t)) return;
    const job = t.job, units = this.units;
    // Someone else (or a brush) may have changed the column meanwhile: work on whatever it needs now.
    const now = job.task(t.x, t.z);
    const how = now && this.reachable(u.cell, { ...now, self: t.self });
    if (how && now.onPlace) { // something that isn't a block (a torch, a farm's tilling or reaping)
      sfx(tool === 'hoe' ? 'till' : tool === 'sickle' ? 'reap' : 'torchLight', at);
      now.onPlace(u);
    } else if (how) {
      // A block can't be placed in a villager, except under its feet when there's headroom: it climbs up onto it (so
      // one that wandered into a pit gets lifted out as the pit is filled). One standing in the way is asked to step
      // aside; one that can't (walled in by what's been built round it) gets built under too, if there's room on top.
      const t = units.terrain, room = !t.solid(now.x, now.y + 1, now.z) && !t.solid(now.x, now.y + 2, now.z);
      if (!now.dig) {
        for (const o of units.list) {
          if (o.dying || o.cell[0] !== now.x || o.cell[2] !== now.z || now.y < o.cell[1] || now.y > o.cell[1] + 1) continue;
          if (now.y === o.cell[1] && room) continue;
          if (o !== u && (o.path.length || (!o.task && units.stepAside(o)))) { this.giveUp(u, 0.5); return; }
          if (!room || (o !== u && o.task)) { this.giveUp(u, 2); return; }
        }
      }
      // Nor is a voxel dug out from under a villager when it would drop into the water: one that's free to is asked to
      // step aside first.
      if (this.underfoot(now, how, u)) { this.giveUp(u, 2); return; }
      // Nor a wall (see walls.js; anyone's: a team doesn't mine its own), nor from under it.
      const wall = now.dig && units.walls?.tiles.get(now.x + X * now.z);
      if (wall && (how === 'low' || now.y >= wall.y0)) { this.giveUp(u, 5); return; }
      // A new game: placing takes the block from the inventory (none left: someone else got the last one), and what's
      // dug out (every block an edit loses, a whole felled trunk) goes into its arms (see take).
      const inv = this.inventory, block = built(now.place ?? BLOCK.GROUND), from = [now.x, now.y, now.z];
      if (inv && !now.dig && inv.get(block) < 1) { this.giveUp(u, WORK_TUNING.retryDelay); return; }
      const lose = t.onLose;
      if (inv) t.onLose = (...a) => { lose?.(...a); const y = inv.yieldOf(a[3]); if (y) this.take(u, ...y, from); };
      const was = t.block(now.x, now.y, now.z);
      let changed;
      try {
        changed = how === 'low' ? t.slumpColumn(now.x, now.low, now.z)
          : now.dig && t.block(now.x, now.y, now.z) === BLOCK.LOG ? fellTree(t, now.x, now.y, now.z, u.pos)
          : t.setVoxel(now.x, now.y, now.z, now.dig ? BLOCK.AIR : block);
      } finally { t.onLose = lose; }
      if (changed && inv && !now.dig) inv.add(block, -1);
      if (changed && !now.dig) t.own(now.x, now.z, u.team); // (its team's colours, see render.js)
      if (changed) {
        // Its last blow: the pick's or axe's strike (the block's own crumble is main.js's onLose), or a block set down.
        const here = [now.x + 0.5, now.y + 0.5, now.z + 0.5];
        if (now.dig) {
          if (tool === 'pickaxe') sfx(was === BLOCK.IRON || was === BLOCK.GOLD ? 'pickOre' : 'pickStone', here);
          else if (tool === 'axe') sfx('chop', here);
        } else {
          if (tool === 'hammer') sfx('hammer', here);
          sfx(block === BLOCK.STONE || block === BLOCK.BRICK || block === BLOCK.OBSIDIAN ? 'placeStone'
            : block === BLOCK.PLANK || block === BLOCK.LOG ? 'placeWood' : 'placeDirt', here);
        }
        units.onEdit?.(changed.lo, changed.hi);
      }
      job.far?.delete(now.x + X * now.z); // (its next voxel: right beside it again if it can)
    }
    this.release(u);
  }

  // Insta-build: does all of a job's work at once, with no villagers, and rebuilds the ground over what changed.
  finish(job) {
    const t = this.units.terrain, v = t.voxels;
    const lo = [X, Y, Z], hi = [0, 0, 0];
    const grow = (a, b) => { for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], a[i]); hi[i] = Math.max(hi[i], b[i]); } };
    for (const k of job.pending) {
      const x = k % X, z = Math.floor(k / X);
      for (let n = 0; n < 2 * Y; n++) { // (bounded, in case a column never settles)
        const now = job.task(x, z);
        if (!now) break;
        if (now.onPlace) { now.onPlace(); break; } // a torch
        if (now.dig && t.block(now.x, now.y, now.z) === BLOCK.LOG) {
          const c = fellTree(t, now.x, now.y, now.z);
          if (c) grow(c.lo, c.hi);
          continue;
        }
        const i = t.index(now.x, now.y, now.z), want = now.dig ? BLOCK.AIR : built(now.place ?? BLOCK.GROUND);
        if (now.y < 1 || v[i] === want || v[i] === BLOCK.OBSIDIAN) break;
        v[i] = want;
        if (!now.dig) t.own(now.x, now.z, this.team); // (insta-build's done for the team that ordered it)
        grow([now.x, now.y, now.z], [now.x + 1, now.y + 1, now.z + 1]);
      }
    }
    job.pending = [];
    job.onDone?.();
    if (hi[0] <= lo[0]) return;
    t.updateBricks(lo, hi);
    this.units.onEdit?.(lo, hi);
  }

  // Box marks for every live job.
  marks() {
    return this.jobs.flatMap((j) => j.marks(1, j.short));
  }

  // Ghost cubes for the buildings being built (BuildJob.ghosts).
  buildGhosts(out = []) {
    for (const j of this.jobs) if (j.plan) j.ghosts(out, !!j.short);
    return out;
  }
}
