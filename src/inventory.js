// The team's inventory in a new game (sandbox has none: every block is free there). Each block blue's workers mine
// goes into it once they've carried it to the Keep (see jobs.js CARRY_TUNING) (stone as bricks, logs as planks and dirt as clay bricks, INVENTORY_TUNING; clay, bricks and planks as
// themselves), and
// each block they place comes out of it. A worker won't take on placing a block the inventory hasn't got (counting
// what the others are already on their way to place), so it digs elsewhere until there is some.
//
// Every few frames the inventory is shared out over the open orders, oldest first, counting what each order will dig
// out on the way: an order (a building, a flatten box, Raise marks) it can't cover is flagged short and drawn white.

import { BLOCK, SIZE } from './terrain.js';
import { FlattenJob, SculptJob, built } from './jobs.js';
import { BuildJob } from './buildings.js';

export const INVENTORY_TUNING = {
  stoneBricks: 4,  // bricks a stone block mined gives
  logPlanks: 1,    // planks a log gives
  dirtClay: 2,     // clay bricks a dirt block gives
  startWorkers: 2, // workers a new game starts with
  startDirt: 20,   // and blocks in its inventory
  startBricks: 20,
  startPlanks: 20,
  refresh: 0.25,   // seconds between sharing the inventory out over the orders (for the white)
};

// The blocks the inventory holds, as the palette shows them, and its currencies: mined from ore, never built with.
// Wheat (harvested from farms, see farm.js) isn't a block: WHEAT is its own id, clear of the blocks' values. RESOURCES:
// what the palette's wallet lists, top to bottom.
export const STOCK = [BLOCK.CLAY, BLOCK.BRICK, BLOCK.PLANK];
export const CURRENCY = [BLOCK.IRON, BLOCK.GOLD];
export const WHEAT = 1;
export const RESOURCES = [WHEAT, ...CURRENCY];

// What mining a block gives: [block, how many], or null (leaves).
export function yieldOf(block) {
  const T = INVENTORY_TUNING;
  if (block === BLOCK.STONE) return [BLOCK.BRICK, Math.round(T.stoneBricks)];
  if (block === BLOCK.LOG) return [BLOCK.PLANK, Math.round(T.logPlanks)];
  if (block === BLOCK.GROUND || block === BLOCK.FARM) return [BLOCK.CLAY, Math.round(T.dirtClay)]; // (tilled soil is dirt)
  if (block === BLOCK.CLAY || block === BLOCK.BRICK || block === BLOCK.PLANK) return [block, 1];
  if (block === BLOCK.IRON || block === BLOCK.GOLD) return [block, 1];
  return null;
}

const empty = (b) => b === BLOCK.AIR || b === BLOCK.LEAVES;

export class Inventory {
  constructor(workers) {
    this.workers = workers;
    this.terrain = workers.units.terrain;
    this.count = new Map([...STOCK, ...RESOURCES].map((b) => [b, 0]));
    this.free = new Map(this.count); // what's left once the open orders are covered, as of the last share()
    this.onChange = null;            // () => void, whenever a count changes
    this.onShare = null;             // () => void, after each share()
    this.wait = 0;
  }

  start() {
    const T = INVENTORY_TUNING;
    this.count.set(BLOCK.CLAY, Math.round(T.startDirt));
    this.count.set(BLOCK.BRICK, Math.round(T.startBricks));
    this.count.set(BLOCK.PLANK, Math.round(T.startPlanks));
    for (const b of RESOURCES) this.count.set(b, 0);
    this.share();
    this.onChange?.();
  }

  get(b) { return this.count.get(b) ?? 0; }

  add(b, n) {
    if (!this.count.has(b) || !n) return;
    this.count.set(b, Math.max(0, this.get(b) + n));
    this.wait = 0; // share it out again next update
    this.onChange?.();
  }

  // What mining `block` gives (see yieldOf; jobs.js can't import it, as this file imports that one).
  yieldOf(block) { return yieldOf(block); }

  // Whether u can take on placing a block b: there's one left once the others' placings are counted.
  affords(b, u) {
    let have = this.get(b);
    for (const o of this.workers.units.list) {
      const t = o.task;
      if (o !== u && t && !t.dig && !t.onPlace && built(t.place ?? BLOCK.GROUND) === b) have--;
    }
    return have > 0;
  }

  update(dt) {
    this.wait -= dt;
    if (this.wait > 0) return;
    this.wait = INVENTORY_TUNING.refresh;
    this.share();
  }

  // Shares the inventory out over the open orders, oldest first, flagging each one short (job.short) when what's
  // left (with what it digs out itself) doesn't cover it. Raise marks are flagged voxel by voxel (job.shortVoxels).
  share() {
    const free = new Map(this.count);
    for (const job of this.workers.jobs) {
      if (job instanceof SculptJob) { this.shareSculpt(job, free); continue; }
      const need = new Map();
      if (job instanceof BuildJob) this.buildNeeds(job.plan.blocks, free, need);
      else if (job instanceof FlattenJob) this.flattenNeeds(job, job.pending, free, need);
      else continue;
      // (A building's: what it still takes, block by block, and what of that the inventory can't cover, for the dock.)
      if (job instanceof BuildJob) {
        job.needs = [...need];
        job.missing = [...need].filter(([b, k]) => k > (free.get(b) ?? 0)).map(([b, k]) => [b, k - (free.get(b) ?? 0)]);
      }
      job.short = this.cover(free, need);
    }
    this.free = free;
    this.onShare?.();
  }

  // Takes `need` (block -> count) out of `free`; returns whether anything was short.
  cover(free, need) {
    let short = false;
    for (const [b, n] of need) {
      const have = free.get(b) ?? 0;
      if (n > have) short = true;
      free.set(b, Math.max(0, have - n));
    }
    return short;
  }

  gain(free, block) {
    const y = yieldOf(block);
    if (y) free.set(y[0], (free.get(y[0]) ?? 0) + y[1]);
  }

  // A building's blocks ([x, y, z, block]) not in place yet, and what's in their way (dug out first).
  buildNeeds(blocks, free, need) {
    for (const [x, y, z, block] of blocks) {
      const now = this.terrain.block(x, y, z);
      if (now === block) continue;
      if (!empty(now)) this.gain(free, now);
      const b = built(block);
      need.set(b, (need.get(b) ?? 0) + 1);
    }
  }

  // A flatten box's columns (x + X * z): everything above its plane is dug out, every empty voxel below filled.
  flattenNeeds(job, columns, free, need) {
    const t = this.terrain, v = t.voxels, [X, Y] = SIZE, L = job.level;
    const b = built(job.fill);
    let n = 0;
    for (const k of columns) {
      const x = k % X, z = Math.floor(k / X);
      for (let y = 1; y < Y; y++) {
        const at = v[t.index(x, y, z)];
        if (y < L) { if (empty(at)) n++; } else if (!empty(at)) this.gain(free, at);
      }
    }
    if (n) need.set(b, (need.get(b) ?? 0) + n);
  }

  // Raise and Lower marks: what the digs give, then each fill in turn, short once its block's run out.
  shareSculpt(job, free) {
    const v = this.terrain.voxels;
    const short = new Set();
    for (const [i, want] of job.want) if (want === BLOCK.AIR && !job.met(i, want)) this.gain(free, v[i]);
    for (const [i, want] of job.want) {
      if (want === BLOCK.AIR || job.met(i, want)) continue;
      const b = built(want), have = free.get(b) ?? 0;
      if (have > 0) free.set(b, have - 1); else short.add(i);
    }
    job.shortVoxels = short;
  }

  // Previews, against what's left over after the open orders: whether a building's plan would be short.
  planShort(plan) {
    const free = new Map(this.free), need = new Map();
    this.buildNeeds(plan.blocks, free, need);
    return this.cover(free, need);
  }

  // Whether a flatten box being drawn would be short.
  flattenShort(x0, z0, x1, z1, level, fill) {
    const X = SIZE[0];
    const columns = [];
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) columns.push(x + X * z);
    const free = new Map(this.free), need = new Map();
    this.flattenNeeds({ level, fill }, columns, free, need);
    return this.cover(free, need);
  }

  // How many blocks of `block` a Raise preview can still have.
  left(block) { return this.free.get(built(block)) ?? 0; }
}
