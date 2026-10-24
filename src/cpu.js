// The computer opponent (a new game's): one Cpu for each team it plays. It looks at the game every so often
// (CPU_TUNING.think seconds) and plays only by giving its team's commands (commands.js), the same a player's clicks give:
// nothing it does is out of a player's reach, and it sees only what its team has seen (the fog of war).
//
// What it does, each look:
// - Economy: its workers' Priorities (a few on each kind of work), Mine orders on the trees, stone, dirt and ore nearest
//   its Keep (topped up as they're dug), farms for wheat (more as it has more workers), workers trained up to its
//   target; and while it knows of too few trees or too little ore, a worker sent out to look further.
// - A building site it's started that's short of something (planks, bricks, clay, iron, gold): that first. More Mine
//   marks on where it comes from and fewer on the rest, its lumberjacks or miners (and odd-job workers) moved onto it,
//   nothing trained that costs it, and a worker sent to look for more if it knows of none.
// - Building: a House when its population's nearly full, else the next in BUILD_ORDER, one at a time, on the first spot
//   near its Keep that fits (clear of its Keep's door, its other buildings and its farms). With nowhere flat enough in
//   range, it levels a site first: just the building's footprint (and the room it takes), dug and filled to one floor
//   height, near its Keep's own (levelDelta) where that's not much more work, with the fewest voxels to move.
// - Army: its fighting buildings train what it can afford and send it to a rally point in front of its Keep. Enemies
//   near its Keep: the army goes for them. Once it's big enough (and the first attack's time has come), the army
//   attack-moves on the nearest rival's Keep, at its power crystal once it's in sight; each attack bigger than the last.
// - Scouting: until it's seen a rival's Keep, it goes by where one would be (its own start turned round the middle of
//   the map, or mirrored), sending its first fighter to look.
//
// main.js gives it the game (see the `game` it's made with): the terrain, units, buildings, farms, each team's Keep,
// inventory and population, what a team's seen, and apply(team, cmd).

import { BLOCK, SIZE, WATER_LEVEL } from './terrain.js';
import { BUILDINGS, planBox, facingToward, trainingCost } from './buildings.js';
import { WHEAT } from './inventory.js';

export const CPU_TUNING = {
  think: 1.5,       // seconds between its looks at the game (Normal; see CPU_LEVELS)
  workers: 14,      // workers it trains (Normal)
  farms: 1.2,       // farms it keeps for each worker (at least farmsMin)
  farmsMin: 8,
  trees: 4,         // trees it keeps marked to fell (more with more workers: x(1 + workers / 10))
  stone: 6,         // stone blocks it keeps marked to dig (the same)
  dirt: 4,          // dirt blocks it keeps marked to dig, for clay (the same)
  ore: 2,           // iron and gold ore veins it keeps marked
  stock: 150,       // planks and bricks it stops felling and digging for at (clay: half this)
  shortMore: 2,     // a building site short of something: the Mine marks it keeps for that, times this (and no stock limit)
  shortOthers: 0.25, // and for the rest, times this
  scanStep: 1500,   // columns it looks over each look (a look round takes several: see scan)
  range: 40,        // voxels from its Keep it looks for trees, stone and ore, and room to build and farm
  farMax: 3,        // with none left near enough that it needs (trees, or what a site's short of): it looks and explores
                    // further, half as far again each look round, up to this many times as far
  markLife: 120,    // seconds before a Mine mark it's given up on (no one's dug it) is taken off
  firstAttack: 300, // game seconds before its first attack (Normal)
  wave: 6,          // fighters in its first attack (Normal)
  waveGrow: 3,      // and more in each after
  defend: 28,       // voxels from its Keep an enemy has to come for its army to turn on it
  regroup: 15,      // seconds between sending an attack's idle fighters on again
  levelDelta: 2,    // a site it levels for a building (none flat in range): its floor at most this far from the Keep's
  levelOff: 4,      // what each voxel of that costs, against the voxels dug and filled to level it
  levelMax: 160,    // and the most it'll take on (voxels dug and filled, and those)
  levelLife: 300,   // seconds it gives a site to be levelled before it tries another
};
// The New game setup's difficulty: what each scales CPU_TUNING's by (think: the time between looks; workers; wave: the
// size of its attacks; firstAttack: the time before its first).
export const CPU_LEVELS = {
  easy: { think: 2, workers: 0.6, wave: 0.7, firstAttack: 1.6 },
  normal: { think: 1, workers: 1, wave: 1, firstAttack: 1 },
  hard: { think: 0.5, workers: 1.3, wave: 1.4, firstAttack: 0.6 },
};

// What it builds, in order, once it has the workers for each (a House is put in whenever it's nearly full).
const BUILD_ORDER = [['barracks', 4], ['archeryRange', 6], ['hut', 7], ['stables', 9], ['mageTower', 10], ['barracks', 12], ['hut', 13], ['archeryRange', 14]];
// Its workers' Priorities, by how many it has (the first a Builder, then round these).
const SPEC_ROUND = ['farmer', 'lumberjack', 'miner', 'farmer', 'lumberjack', 'miner', 'worker'];
const ORE = [BLOCK.IRON, BLOCK.GOLD];
// Where each building block comes from (the kind of Mine mark), and who gathers that.
const SOURCE = new Map([[BLOCK.PLANK, 'tree'], [BLOCK.BRICK, 'stone'], [BLOCK.CLAY, 'dirt'], [BLOCK.IRON, 'ore'], [BLOCK.GOLD, 'ore']]);
const GATHERER = { tree: 'lumberjack', stone: 'miner', dirt: 'miner', ore: 'miner' };
const [X, , Z] = SIZE;
const UP = [0, 1, 0];
const NOT_ARMY = new Set(['worker', 'crystal', 'wall']);

// Columns round (0, 0) out to radius r, nearest first: [dx, dz, distance].
const RINGS = new Map();
function ring(r) {
  if (!RINGS.has(r)) {
    const out = [];
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) { const d = Math.hypot(dx, dz); if (d <= r) out.push([dx, dz, d]); }
    out.sort((a, b) => a[2] - b[2]);
    RINGS.set(r, out);
  }
  return RINGS.get(r);
}
// Whether boxes ({ lo, hi }, [x, y, z], hi exclusive) come within `gap` columns of each other across the ground.
const near = (a, b, gap) => a.lo[0] < b.hi[0] + gap && b.lo[0] < a.hi[0] + gap && a.lo[2] < b.hi[2] + gap && b.lo[2] < a.hi[2] + gap;

export class Cpu {
  constructor(team, game, level = 'normal') {
    this.team = team;
    this.game = game;
    this.level = CPU_LEVELS[level] ?? CPU_LEVELS.normal;
    this.wait = Math.random() * CPU_TUNING.think; // (the CPUs' looks spread out)
    this.marks = []; // its Mine marks: { c: [x, y, z], kind: 'tree' | 'stone' | 'ore', t: when }
    this.giveUp = new Set(); // and those it's taken off, not dug in time ('x,y,z')
    this.site = null; // a site being levelled for a building (see siteFor)
    this.badSites = new Set(); // and spots it's given up on ('x,z')
    this.scanAt = -Infinity;
    this.found = { tree: [], stone: [], dirt: [], ore: [] };
    this.scanning = null; // a look round under way (see scan)
    this.scanned = false;
    this.far = 1; // how much further than usual it looks and explores (see CPU_TUNING.farMax)
    this.order = BUILD_ORDER.slice(); // what it builds (see BUILD_ORDER), and how far through it
    this.built = 0;
    this.farmTry = 0;
    this.rallied = new Set(); // its buildings given the rally point
    this.wave = CPU_TUNING.wave * this.level.wave;
    this.attacking = false;
    this.regroupAt = 0;
    this.defendAt = 0;
    this.scout = null;
    this.trained = new Map(); // building id -> how many it's had trained (to take turns between what it trains)
  }

  // Every step of the game: a look when it's time.
  update(dt) {
    if (this.game.out(this.team)) return;
    this.wait -= dt;
    if (this.wait > 0) return;
    this.wait = Math.max(0.1, CPU_TUNING.think * this.level.think);
    const keep = this.game.keeps.get(this.team);
    if (!keep) return;
    this.home = planBox(keep);
    this.mid = [(this.home.lo[0] + this.home.hi[0]) / 2, (this.home.lo[2] + this.home.hi[2]) / 2];
    this.door = keep.spawn ? keep.spawn.cell : [this.mid[0], 0, this.mid[1]];
    const now = this.game.clock();
    const mine = this.game.units.list.filter((u) => u.team === this.team && !u.dying);
    this.workers = mine.filter((u) => u.kind === 'worker');
    this.army = mine.filter((u) => !NOT_ARMY.has(u.kind));
    this.buildings = this.game.buildings.list.filter((b) => b.team === this.team);
    this.shortages();
    this.specs();
    this.mining(now);
    this.explore();
    this.farming();
    this.building();
    this.training();
    this.fighting(now);
  }

  apply(cmd) { return this.game.apply(this.team, cmd); }
  seen(x, z) { return this.game.seen(x, z, this.team); }
  // A point on the ground of column (x, z), for a command (see Units.order).
  ground(x, z) {
    x = Math.max(0, Math.min(X - 1, Math.floor(x)));
    z = Math.max(0, Math.min(Z - 1, Math.floor(z)));
    return { point: [x + 0.5, this.game.terrain.groundAt(x, z), z + 0.5], normal: UP };
  }
  // Clear of its Keep and its door (where it shouldn't dig, farm or build).
  homeClear(x, z, gap) {
    const h = this.home, d = this.door;
    if (x >= h.lo[0] - gap && x < h.hi[0] + gap && z >= h.lo[2] - gap && z < h.hi[2] + gap) return false;
    return Math.hypot(x - d[0], z - d[2]) > gap + 3;
  }

  // What its building sites (started, not finished) are short of, past what it has (see Inventory.share): this.short,
  // block -> how many; this.need, the kinds of Mine mark that give them; this.oreNeed, the ore it wants first.
  shortages() {
    this.short = new Map();
    for (const j of this.game.units.crew(this.team).jobs) {
      if (!j.siteId || j.done) continue;
      for (const [b, n] of j.missing ?? []) if (SOURCE.has(b)) this.short.set(b, (this.short.get(b) ?? 0) + n);
    }
    this.need = new Set([...this.short.keys()].map((b) => SOURCE.get(b)));
    this.oreNeed = this.short.has(BLOCK.GOLD) ? BLOCK.GOLD : this.short.has(BLOCK.IRON) ? BLOCK.IRON : null;
  }

  // Its workers' Priorities: the first a Builder, then round SPEC_ROUND (oldest first, so they keep theirs). With a site
  // short of something, the gatherers (and odd-job workers) on getting it: one kind short, all of them; trees and
  // something dug, the odd-job workers split between.
  specs() {
    const want = new Map(), lean = [...new Set([...this.need].map((k) => GATHERER[k]))];
    [...this.workers].sort((a, b) => a.id - b.id).forEach((u, i) => {
      let spec = i === 0 ? 'builder' : SPEC_ROUND[(i - 1) % SPEC_ROUND.length];
      if (lean.length === 1 && (spec === 'worker' || spec === 'lumberjack' || spec === 'miner')) spec = lean[0];
      else if (lean.length === 2 && spec === 'worker') spec = lean[i % 2];
      if ((u.spec ?? 'worker') !== spec) want.set(spec, [...(want.get(spec) ?? []), u.id]);
    });
    for (const [spec, ids] of want) this.apply({ k: 'spec', units: ids, spec });
  }

  // Trees, stone, dirt and ore near its Keep that it's seen, nearest first (looked for again every so often): trees
  // and ore out to half as far again as its range (where it explores), ore showing on a side as well as on top.
  // A look round takes several looks (CPU_TUNING.scanStep columns each, nearest first), so none takes long; the
  // first one's finds are used as they come, later ones' once they're done.
  scan(now) {
    if (!this.scanning) {
      if (now - this.scanAt < 10) return;
      this.scanAt = now;
      this.scanning = { i: 0, found: { tree: [], stone: [], dirt: [], ore: [] } };
      if (!this.scanned) this.found = this.scanning.found;
    }
    const t = this.game.terrain, [cx, cz] = this.mid, S = this.scanning, found = S.found;
    const R = CPU_TUNING.range, cells = ring(this.reach()), end = Math.min(cells.length, S.i + Math.max(100, CPU_TUNING.scanStep));
    for (; S.i < end; S.i++) {
      const [dx, dz, d] = cells[S.i], x = Math.floor(cx + dx), z = Math.floor(cz + dz);
      if (x < 1 || z < 1 || x >= X - 1 || z >= Z - 1 || !this.seen(x, z) || !this.homeClear(x, z, 2)) continue;
      const g = t.groundAt(x, z), top = t.block(x, g - 1, z);
      if (t.block(x, g, z) === BLOCK.LOG) { found.tree.push([x, g, z]); continue; }
      const ore = this.oreAt(x, g, z);
      if (ore) { found.ore.push(ore); continue; }
      if (d > R) continue;
      if (top === BLOCK.STONE) found.stone.push([x, g - 1, z]);
      // (Dirt a little way out, clear of farms, and a few hundred at most.)
      else if (top === BLOCK.GROUND && d >= 9 && found.dirt.length < 300 && !this.game.farmIn({ lo: [x, 0, z], hi: [x + 1, 0, z + 1] }, 1)) found.dirt.push([x, g - 1, z]);
    }
    if (S.i < cells.length) return;
    this.found = found;
    this.scanned = true;
    this.scanning = null;
    // (Trees, or what a site's short of, all gone near enough: further next time.)
    if (['tree', ...this.need].some((k) => !this.usable(k).length)) this.far = Math.min(CPU_TUNING.farMax, this.far * 1.5);
  }
  // How far out it looks for trees, stone and ore, and explores.
  reach() { return Math.round(CPU_TUNING.range * 1.5 * Math.max(1, this.far)); }
  // Its finds of a kind still there that it hasn't given up on (ore: the kind a site wants, if one does).
  usable(kind) {
    const t = this.game.terrain;
    return this.found[kind].filter((c) => !this.giveUp.has(c.join()) && (kind === 'tree' ? t.block(...c) === BLOCK.LOG : t.solid(...c)) &&
      (kind !== 'ore' || !this.oreNeed || t.block(...c) === this.oreNeed));
  }

  // Ore in column (x, z) a worker could get at: on top, or a few down with open air beside it. [x, y, z] or null.
  oreAt(x, g, z) {
    const t = this.game.terrain;
    for (let y = g - 1; y >= Math.max(1, g - 5); y--) {
      if (!ORE.includes(t.block(x, y, z))) continue;
      if (y === g - 1 || [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => t.block(x + dx, y, z + dz) === BLOCK.AIR)) return [x, y, z];
    }
    return null;
  }

  // Its Mine marks topped up: CPU_TUNING's trees, stone and ore veins open at once (those dug, or given up on after
  // markLife, dropped).
  mining(now) {
    const t = this.game.terrain;
    const open = (m) => (m.kind === 'tree' ? t.block(...m.c) === BLOCK.LOG : t.solid(...m.c));
    const stale = this.marks.filter((m) => open(m) && now - m.t > CPU_TUNING.markLife);
    if (stale.length) this.apply({ k: 'unmine', voxels: stale.map((m) => m.c), veins: false });
    const tried = new Set(this.marks.map((m) => m.c.join()));
    this.marks = this.marks.filter((m) => open(m) && now - m.t <= CPU_TUNING.markLife);
    for (const m of stale) this.giveUp.add(m.c.join());
    this.scan(now);
    const inv = this.game.inventory(this.team), have = (b) => inv?.get(b) ?? 0, more = 1 + this.workers.length / 10, T = CPU_TUNING;
    const wants = [
      ['tree', T.trees * more, have(BLOCK.PLANK) >= T.stock],
      ['stone', T.stone * more, have(BLOCK.BRICK) >= T.stock],
      ['dirt', T.dirt * more, have(BLOCK.CLAY) >= T.stock / 2],
      ['ore', T.ore, false],
    ];
    // (A site short of something: more of that, past the stock limit, and less of the rest.)
    for (const [kind, base, full] of wants) {
      const want = this.need.has(kind) ? base * T.shortMore : full ? 0 : this.need.size ? base * T.shortOthers : base;
      let n = this.marks.filter((m) => m.kind === kind).length;
      const add = [];
      // (The ore a site wants first, nearest first.)
      const finds = kind === 'ore' && this.oreNeed ? [...this.found.ore].sort((a, b) => (t.block(...b) === this.oreNeed) - (t.block(...a) === this.oreNeed)) : this.found[kind];
      for (const c of finds) {
        if (n >= Math.round(want)) break;
        const k = c.join();
        if (tried.has(k) || this.giveUp.has(k) || (kind === 'tree' ? t.block(...c) !== BLOCK.LOG : !t.solid(...c))) continue;
        add.push(c);
        tried.add(k);
        n++;
      }
      if (!add.length) continue;
      if (this.apply({ k: 'mine', voxels: add, veins: kind === 'ore' }).ok) for (const c of add) this.marks.push({ c, kind, t: now });
    }
  }

  // Looking further: while it knows of too few trees or too little ore, an idle worker walks out to the nearest place
  // it's never seen (within half as far again as its range).
  explore() {
    const e = this.explorer;
    if (e && !e.dying && (e.goal || e.path.length)) return; // (still on its way)
    this.explorer = null;
    // (And while a site's short of something it knows nowhere to get.)
    const none = [...this.need].some((k) => !this.usable(k).length);
    if (this.usable('tree').length >= CPU_TUNING.trees && this.found.ore.length >= 2 && !none) return;
    const u = this.workers.find((w) => !w.task && !w.goal && !w.path.length && !w.carry);
    if (!u) return;
    const [cx, cz] = this.mid;
    for (const [dx, dz] of ring(this.reach())) {
      const x = Math.floor(cx + dx), z = Math.floor(cz + dz);
      if (x < 2 || z < 2 || x >= X - 2 || z >= Z - 2 || this.seen(x, z)) continue;
      if (this.apply({ k: 'move', units: [u.id], ...this.ground(x, z), amove: false, queued: false }).ok) this.explorer = u;
      return;
    }
  }

  // Farms: CPU_TUNING.farms for each worker (at least farmsMin), a patch at a time, on the grass nearest its Keep.
  farming() {
    const want = Math.max(CPU_TUNING.farmsMin, Math.round(CPU_TUNING.farms * this.workers.length));
    if (this.game.farmCount(this.team) >= want) return;
    const [cx, cz] = this.mid, R = Math.round(CPU_TUNING.range), rings = ring(R), farms = this.game.farms;
    // (A few spots a look, carrying on round from the last.)
    for (let k = 0; k < 40; k++) {
      const [dx, dz, d] = rings[this.farmTry++ % rings.length];
      if (d < 6) continue;
      const x0 = Math.floor(cx + dx) - 2, z0 = Math.floor(cz + dz) - 2, box = { lo: [x0, 0, z0], hi: [x0 + 4, 0, z0 + 4] };
      if (!this.seen(x0 + 2, z0 + 2) || !this.homeClear(x0, z0, 4) || !this.homeClear(x0 + 4, z0 + 4, 4)) continue;
      if (this.buildings.some((b) => near(planBox(b.plan), box, 2))) continue;
      const cells = farms.box(x0, z0, x0 + 4, z0 + 4);
      if (cells.length < 10) continue;
      if (this.apply({ k: 'farm', cells }).ok) return;
    }
  }

  // A House when it's nearly full (one at a time), else the next of BUILD_ORDER it has the workers for, once nothing
  // else is going up.
  building() {
    const sites = this.game.units.crew(this.team).jobs.filter((j) => j.siteId && !j.done);
    const pop = this.game.population(this.team), room = this.game.popRoom(this.team);
    if (pop >= room - 2 && !sites.some((j) => j.key === 'hut')) { this.place('hut'); return; }
    if (sites.length) return;
    const next = this.order[this.built];
    // (Stables cost gold on top: till it has it, the one after them first.)
    if (next?.[0] === 'stables' && (this.game.inventory(this.team)?.get(BLOCK.GOLD) ?? 0) < 10 && this.order[this.built + 1]) {
      [this.order[this.built], this.order[this.built + 1]] = [this.order[this.built + 1], next];
    }
    const due = this.order[this.built];
    if (due && this.workers.length >= due[1] && this.place(due[0])) this.built++;
  }

  // A building on the first spot near its Keep that fits (its door towards the middle of the map), clear of its Keep,
  // door, other buildings and farms. Whether it went down.
  place(key) {
    const B = BUILDINGS[key], t = this.game.terrain, [cx, cz] = this.mid, R = Math.round(CPU_TUNING.range), rings = ring(R);
    const others = [...this.buildings, ...this.game.units.crew(this.team).jobs.filter((j) => j.siteId && !j.done)].map((b) => planBox(b.plan));
    // (Its floor's columns, from the cell it's placed at, for each way it faces: those must all be flat ground.)
    B.feet ??= [0, 1, 2, 3].map((f) => {
      const p = B.plan(0, 50, 0, f), seen = new Set(), out = [];
      for (const [x, y, z] of p.space) if (y === 50 && !seen.has(`${x},${z}`)) { seen.add(`${x},${z}`); out.push([x, z]); }
      return out;
    });
    // (A few hundred spots a look, carrying on round from the last, back to the nearest once it's placed one.)
    if (this.site?.key === key) return this.levelSite(); // (a site being levelled for it)
    if (this.placing?.key !== key) this.placing = { key, i: 0 };
    for (let k = 0; k < 600; k++) {
      const [dx, dz, d] = rings[this.placing.i++ % rings.length];
      if (d < 7) continue;
      const x = Math.floor(cx + dx), z = Math.floor(cz + dz);
      if (x < 2 || z < 2 || x >= X - 2 || z >= Z - 2 || !this.seen(x, z)) continue;
      const y0 = t.groundAt(x, z), facing = facingToward(x + 0.5, z + 0.5, [X / 2, 0, Z / 2]);
      if (!B.feet[facing].every(([fx, fz]) => t.groundAt(x + fx, z + fz) === y0 && t.block(x + fx, y0, z + fz) === BLOCK.AIR)) continue;
      const plan = B.plan(x, y0, z, facing), box = planBox(plan);
      if (!this.homeClear(box.lo[0], box.lo[2], 3) || !this.homeClear(box.hi[0], box.hi[2], 3) || others.some((o) => near(o, box, 2))) continue;
      if (this.game.farmIn(box, 1)) continue;
      if (this.apply({ k: 'build', key, cell: [x, y0, z], facing }).ok) { this.placing = null; return true; }
    }
    // A whole round with nowhere flat enough: a site to level for it (one at a time).
    if (this.placing.i >= rings.length && !this.site) this.site = this.siteFor(key);
    return false;
  }

  // Where to level for building `key`: the spot in range (clear as for place) and floor height (within levelDelta of
  // its Keep's floor) needing the least work: voxels dug, filled (half as much again: it takes blocks) and, under a
  // floor sunk more than one below the ground round it, dug three times over (it has to walk out of its door), with
  // levelOff for each voxel off the Keep's height. Ordered at once: Mine on what's in the building's way, Fill (clay, or
  // bricks if it has more) under its floor. Or null, with nowhere worth it.
  siteFor(key) {
    const B = BUILDINGS[key], t = this.game.terrain, T = CPU_TUNING, [cx, cz] = this.mid, keepY = this.game.keeps.get(this.team).floor;
    const others = [...this.buildings, ...this.game.units.crew(this.team).jobs.filter((j) => j.siteId && !j.done)].map((b) => planBox(b.plan));
    // (Each column's ground, or -1 with something on it that isn't: a tree, a building.)
    const grounds = new Map();
    const ground = (x, z) => {
      const k = x + X * z;
      if (!grounds.has(k)) { const g = t.groundAt(x, z); grounds.set(k, t.heightAt(x, z) > g ? -1 : g); }
      return grounds.get(k);
    };
    let best = null;
    for (const [dx, dz, d] of ring(Math.round(T.range))) {
      if (d < 7) continue;
      const x = Math.floor(cx + dx), z = Math.floor(cz + dz);
      if (x < 3 || z < 3 || x >= X - 3 || z >= Z - 3 || !this.seen(x, z) || this.badSites.has(`${x},${z}`)) continue;
      const facing = facingToward(x + 0.5, z + 0.5, [X / 2, 0, Z / 2]);
      const gs = B.feet[facing].map(([fx, fz]) => ground(x + fx, z + fz));
      if (gs.some((g) => g <= WATER_LEVEL)) continue; // (a tree, a building, water)
      let clear = null; // (worked out once it's worth it)
      for (let y0 = keepY - Math.round(T.levelDelta); y0 <= keepY + Math.round(T.levelDelta); y0++) {
        if (y0 <= WATER_LEVEL + 1) continue;
        let cost = Math.abs(y0 - keepY) * T.levelOff + d * 0.2;
        for (const g of gs) cost += g > y0 ? (g - y0) * (g - y0 > 1 ? 3 : 1) : (y0 - g) * 1.5;
        if (cost >= (best?.cost ?? T.levelMax)) continue;
        if (clear === null) {
          const box = planBox(B.plan(x, y0, z, facing));
          clear = this.homeClear(box.lo[0], box.lo[2], 3) && this.homeClear(box.hi[0], box.hi[2], 3) && !others.some((o) => near(o, box, 2)) && !this.game.farmIn(box, 1);
        }
        if (clear) best = { x, z, y0, facing, cost };
      }
    }
    if (!best) return null;
    const { x, z, y0, facing } = best, plan = B.plan(x, y0, z, facing);
    const dig = plan.space.filter((c) => t.solid(...c));
    const fill = [];
    for (const [fx, fz] of B.feet[facing]) for (let y = ground(x + fx, z + fz); y < y0; y++) fill.push([x + fx, y, z + fz]);
    const inv = this.game.inventory(this.team), block = (inv?.get(BLOCK.BRICK) ?? 0) > (inv?.get(BLOCK.CLAY) ?? 0) ? BLOCK.BRICK : BLOCK.CLAY;
    if (dig.length) this.apply({ k: 'mine', voxels: dig, veins: false });
    if (fill.length) this.apply({ k: 'fill', voxels: fill, block });
    return { key, x, z, y0, facing, dig, fill, t: this.game.clock() };
  }

  // The site being levelled: once it's dug and filled, the building on it (or, if it won't go there after all, or it's
  // taken too long, another site next time). Whether the building went down.
  levelSite() {
    const s = this.site, t = this.game.terrain;
    if (s.dig.every((c) => !t.solid(...c)) && s.fill.every((c) => t.solid(...c))) {
      const ok = this.apply({ k: 'build', key: s.key, cell: [s.x, s.y0, s.z], facing: s.facing }).ok;
      if (!ok) this.badSites.add(`${s.x},${s.z}`);
      this.site = null;
      this.placing = null;
      return ok;
    }
    if (this.game.clock() - s.t > CPU_TUNING.levelLife) {
      const left = s.dig.filter((c) => t.solid(...c));
      if (left.length) this.apply({ k: 'unmine', voxels: left, veins: false });
      this.badSites.add(`${s.x},${s.z}`);
      this.site = null;
    }
    return false;
  }

  // Workers from the Keep up to its target, then fighters from its other buildings, by turns, what it can afford (wheat
  // kept back for the next worker while it's short of them).
  training() {
    const inv = this.game.inventory(this.team), target = Math.round(CPU_TUNING.workers * this.level.workers);
    // (Nothing that costs what a building site's short of.)
    const afford = (kind, keep = 0) => trainingCost(kind).every(([blk, n]) => !this.short.has(blk) && (inv?.get(blk) ?? 0) >= n + (blk === WHEAT ? keep : 0));
    const full = this.game.population(this.team) >= this.game.popRoom(this.team);
    const short = this.workers.length < target;
    for (const b of this.buildings) {
      if (!b.actions.length || b.queue.length >= (b.key === 'keep' ? 1 : 2)) continue;
      if (b.key === 'keep') {
        if (short && !full && afford('worker')) this.apply({ k: 'train', building: b.id, kind: 'worker' });
        continue;
      }
      if (!this.rallied.has(b.id)) { // (its fighters gather in front of the Keep)
        const r = this.rally();
        if (this.apply({ k: 'rally', building: b.id, ...this.ground(r[0], r[1]), amove: false, queued: false }).ok) this.rallied.add(b.id);
      }
      if (full) continue;
      const n = this.trained.get(b.id) ?? 0;
      const order = [...b.actions.slice(n % b.actions.length), ...b.actions.slice(0, n % b.actions.length)];
      const kind = order.find((k) => afford(k, short ? 5 : 0));
      if (kind && this.apply({ k: 'train', building: b.id, kind }).ok) this.trained.set(b.id, n + 1);
    }
  }

  // Where its fighters gather: in front of its Keep, towards the middle of the map.
  rally() {
    const [cx, cz] = this.mid, dx = X / 2 - cx, dz = Z / 2 - cz, d = Math.hypot(dx, dz) || 1;
    return [cx + (dx / d) * 14, cz + (dz / d) * 14];
  }

  // Where a rival's Keep is, as far as it knows: [x, z] and whether it's seen it, for each rival still in the game.
  rivals() {
    const out = [];
    for (const team of this.game.teams) {
      if (team === this.team || this.game.out(team)) continue;
      const k = this.game.keeps.get(team);
      if (!k) continue;
      const b = planBox(k), at = [(b.lo[0] + b.hi[0]) / 2, (b.lo[2] + b.hi[2]) / 2];
      // (Seen: its army goes to the ground before its door, not the Keep's roof, which nobody can walk to.)
      const door = k.spawn ? [k.spawn.cell[0] + 0.5 + k.spawn.dir[0] * 4, k.spawn.cell[2] + 0.5 + k.spawn.dir[1] * 4] : at;
      if (this.seen(...at)) { out.push({ team, at: door, known: true }); continue; }
      // (Not seen: where a start would be, its own turned round the middle of the map, or mirrored; the first of
      // those not seen yet.)
      const [x, z] = this.mid;
      const guess = [[X - x, Z - z], [X - x, z], [x, Z - z]].find((g) => !this.seen(...g));
      if (guess) out.push({ team, at: guess, known: false });
    }
    const dist = (r) => Math.hypot(r.at[0] - this.mid[0], r.at[1] - this.mid[1]);
    return out.sort((a, b) => b.known - a.known || dist(a) - dist(b));
  }

  // Its army: after enemies near its Keep, on the attack once it's big enough, else gathered; its first fighter scouts.
  fighting(now) {
    const U = this.game.units, [cx, cz] = this.mid;
    const idle = (u) => !u.goal && !u.queue.length && !u.target && !u.patrol && !u.path.length;
    const threats = U.list.filter((o) => o.team !== this.team && !o.dying && !NOT_ARMY.has(o.kind) && o.kind !== 'worker' &&
      this.game.visible(o.pos[0], o.pos[2], this.team) && Math.hypot(o.pos[0] - cx, o.pos[2] - cz) < CPU_TUNING.defend);
    const rivals = this.rivals(), target = rivals[0];
    // Scouting: its first fighter goes to look where a rival would be, till it's seen one.
    if (target && !target.known) {
      if (!this.scout || this.scout.dying) this.scout = this.army[0] ?? null;
      if (this.scout && idle(this.scout)) this.apply({ k: 'move', units: [this.scout.id], ...this.ground(...target.at), amove: false, queued: false });
    } else this.scout = null;
    const army = this.army.filter((u) => u !== this.scout);
    if (threats.length) { // (home first: the nearest enemy, every few seconds for those not fighting yet)
      if (now < this.defendAt) return;
      this.defendAt = now + 4;
      const t = threats.sort((a, b) => Math.hypot(a.pos[0] - cx, a.pos[2] - cz) - Math.hypot(b.pos[0] - cx, b.pos[2] - cz))[0];
      const free = army.filter((u) => !u.target);
      if (free.length) this.apply({ k: 'move', units: free.map((u) => u.id), ...this.ground(t.pos[0], t.pos[2]), amove: true, queued: false });
      return;
    }
    const first = CPU_TUNING.firstAttack * this.level.firstAttack;
    if (!this.attacking && target && now >= first && army.length >= Math.round(this.wave)) {
      this.attacking = true;
      this.regroupAt = 0;
      this.wave += CPU_TUNING.waveGrow * this.level.wave;
    }
    if (this.attacking && (army.length < 2 || !target)) this.attacking = false; // (beaten back: gather again)
    if (!this.attacking || now < this.regroupAt) return;
    this.regroupAt = now + CPU_TUNING.regroup;
    // On: idle ones at the rival's crystal once it's in sight (and they're near it), else at its Keep.
    const crystal = U.list.find((o) => o.kind === 'crystal' && o.team === target.team && !o.dying && this.game.visible(o.pos[0], o.pos[2], this.team));
    const go = army.filter(idle);
    const close = crystal ? go.filter((u) => Math.hypot(u.pos[0] - crystal.pos[0], u.pos[2] - crystal.pos[2]) < 25) : [];
    if (close.length) this.apply({ k: 'attack', units: close.map((u) => u.id), target: crystal.id });
    const rest = go.filter((u) => !close.includes(u));
    if (rest.length) this.apply({ k: 'move', units: rest.map((u) => u.id), ...this.ground(...target.at), amove: true, queued: false });
  }
}
