// Portcullises (the Build menu's Portcullis): a gate 2 voxels wide and 2 high made in the bottom of a team's built
// wall, across two sections side by side along a straight run (x or z) on the same level, under the wall's third
// voxel (its lintel). A worker comes and makes it (GATE_TUNING.buildTime); in a new game it costs GATE_TUNING.iron,
// paid as it's ordered (and given back if it's called off first). Once it's made, its two bottom voxels are empty: the
// wall's own team walks through as if nothing were there, while to everyone else it's still wall (Units.neighbours
// asks blocks), its two sections a target with half a wall's hit points; either knocked down takes the whole gate.
// Its iron grid hangs in the opening, raised (only to look at) while one of its team's units is near.

import { SIZE, BLOCK } from './terrain.js';

export const GATE_TUNING = {
  iron: 4,          // what one costs in a new game
  buildTime: 4,     // seconds of a worker's work to make one
  hp: 0.5,          // its sections' hit points, as a share of the wall's
  near: 2.5,        // voxels from it a unit of its team raises it
  speed: 1.2,       // how fast it rises and falls (its full travel a second)
  color: '#3a2f2a', // its iron
};
const GATE_REACH = { reach: 3, reachUp: 3, reachDown: 3 };

const [X, Y, Z] = SIZE;
const BAR = 0.075, DEPTH = 0.1, SPIKE = 0.24, TRAVEL = 1.6; // sizes (voxels), and how far it rises
const ACROSS = [0.17, 0.5, 0.83, 1.17, 1.5, 1.83];          // its upright bars, along the opening
const UP = [0.3, 0.7, 1.1, 1.5, 1.9];                       // and its crossbars, up from the spikes' tips (closed)

export class Gates {
  constructor(terrain, walls) {
    this.terrain = terrain;
    this.walls = walls;
    this.list = [];          // { tiles: [section, section] (walls.js), x, z (the first's column), along: [dx, dz], y0, team, built, open }
    this.cols = new Map();   // column -> its gate (made or not)
    this.onEdit = null;      // (lo, hi) => void: a gate's opening was made
  }

  // Whether voxel (x, y, z) is a made gate's opening that a unit of `team` can't pass (another team's).
  blocks(team, x, y, z) {
    const g = this.cols.get(x + X * z);
    return !!g && g.built && g.team !== team && y >= g.y0 && y < g.y0 + 2;
  }
  // blocks for one team, or null when no gate stands in its way anywhere (Units.neighbours' quick case).
  blocker(team) {
    if (!this.list.some((g) => g.built && g.team !== team)) return null;
    return (x, y, z) => this.blocks(team, x, y, z);
  }

  // Where a click on a wall (a raycast hit) would put one for `team`: { tiles, x, z, along, y0, fits, why }, or null off
  // a wall. The section clicked and its neighbour along the wall on the side nearer the click.
  placement(hit, team) {
    if (!hit) return null;
    const [x, y, z] = hit.point.map((v, i) => Math.floor(v - hit.normal[i] * 0.01));
    const s = this.walls.at(x, y, z);
    if (!s) return null;
    const fx = hit.point[0] - x - 0.5, fz = hit.point[2] - z - 0.5;
    const ok = (o) => o && o.team === s.team && o.built && o.y0 === s.y0 && o.h >= 3 && !this.cols.has(o.x + X * o.z)
      && this.terrain.block(o.x, o.y0 + 2, o.z) === o.block;
    let best = null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const o = this.walls.tiles.get(s.x + dx + X * (s.z + dz));
      if (!ok(o)) continue;
      const d = -(dx * fx + dz * fz); // (the side the click's nearer first)
      if (!best || d < best.d) best = { o, dx, dz, d };
    }
    const why = s.team !== team ? 'enemy' : !s.built ? 'unbuilt' : !ok(s) ? 'used' : !best ? 'straight' : null;
    if (!best) return { tiles: [s], x: s.x, z: s.z, along: [1, 0], y0: s.y0, fits: false, why };
    const a = best.dx + best.dz < 0 ? best.o : s, b = a === s ? best.o : s;
    return { tiles: [a, b], x: a.x, z: a.z, along: [Math.abs(best.dx), Math.abs(best.dz)], y0: s.y0, fits: !why, why };
  }

  // Orders one (from a placement that fits); returns the job for a worker to make it.
  add(p, team) {
    const g = { tiles: p.tiles, x: p.x, z: p.z, along: p.along, y0: p.y0, team, built: false, open: 0, raising: false };
    this.list.push(g);
    for (const s of g.tiles) { this.cols.set(s.x + X * s.z, g); s.gate = g; }
    return new GateJob(this, g);
  }

  // Lets one go (its order called off, or its wall gone).
  remove(g) {
    this.list = this.list.filter((o) => o !== g);
    for (const s of g.tiles) { if (this.cols.get(s.x + X * s.z) === g) this.cols.delete(s.x + X * s.z); s.gate = null; }
  }

  // Makes it: the bottom two voxels of both its sections come out (to `team`, a way through). Returns its sections.
  make(g) {
    if (g.built || !this.list.includes(g)) return [];
    const t = this.terrain;
    let lo = null, hi = null;
    for (const s of g.tiles) {
      for (let k = 0; k < 2; k++) {
        if (t.block(s.x, g.y0 + k, s.z) === BLOCK.AIR) continue;
        const c = t.setVoxel(s.x, g.y0 + k, s.z, BLOCK.AIR);
        if (c) { lo = lo ? lo.map((v, i) => Math.min(v, c.lo[i])) : c.lo; hi = hi ? hi.map((v, i) => Math.max(v, c.hi[i])) : c.hi; }
      }
    }
    g.built = true;
    if (lo) this.onEdit?.(lo, hi);
    return g.tiles;
  }

  // Drops those whose wall's gone (a section knocked down or dug out), or whose lintel's gone. Returns those dropped.
  check() {
    const gone = this.list.filter((g) => g.tiles.some((s) => this.walls.tiles.get(s.x + X * s.z) !== s
      || this.terrain.block(s.x, g.y0 + 2, s.z) !== s.block));
    for (const g of gone) this.remove(g);
    return gone;
  }

  // Raised while a unit of its team (not a wall or crystal, not fallen) is within `near` of its middle; eased.
  // Returns those that just started to rise or fall (for their rattle).
  update(dt, units) {
    const T = GATE_TUNING, moved = [];
    for (const g of this.list) {
      if (!g.built) continue;
      const cx = g.x + 0.5 + g.along[0] * 0.5, cz = g.z + 0.5 + g.along[1] * 0.5, r2 = T.near * T.near;
      let want = false;
      for (const u of units) {
        if (u.team !== g.team || u.dying || u.kind === 'wall' || u.kind === 'crystal') continue;
        const dx = u.pos[0] - cx, dz = u.pos[2] - cz;
        if (dx * dx + dz * dz < r2 && Math.abs(u.pos[1] - g.y0) < 2.5) { want = true; break; }
      }
      if (want !== g.raising && (want ? g.open < 0.5 : g.open > 0.5)) moved.push(g);
      g.raising = want;
      g.open = Math.min(1, Math.max(0, g.open + (want ? 1 : -1) * dt * Math.max(0.05, T.speed)));
    }
    return moved;
  }

  // The iron grids as boxes for the unit renderer ({ m, col, emit }): in the middle of the wall, its uprights, crossbars
  // and the spikes along its bottom, raised by how open it is (only what's within the opening is drawn). col: linear.
  // hidden(x, z): fogged.
  parts(out = [], col, hidden = null) {
    for (const g of this.list) {
      if (!g.built) continue;
      const cx = g.x + 0.5 + g.along[0] * 0.5, cz = g.z + 0.5 + g.along[1] * 0.5;
      if (hidden?.(cx, cz)) continue;
      const lift = smooth(g.open) * TRAVEL, top = 2;
      // A box from u0 to u1 along the opening, v0 to v1 up from its floor, `d` deep (taper: narrowed to a point at its
      // bottom).
      const box = (u0, u1, v0, v1, d, taper = 0) => {
        if (v1 <= v0 + 0.01) return;
        const u = (u0 + u1) / 2, w = u1 - u0, h = v1 - v0;
        const c = [g.x + (g.along[0] ? u : 0.5), g.y0 + (v0 + v1) / 2, g.z + (g.along[1] ? u : 0.5)];
        const [sx, sz] = g.along[0] ? [w, d] : [d, w];
        out.push({ m: [sx, 0, 0, taper, 0, h, 0, taper, 0, 0, sz, 0, c[0], c[1], c[2], 1], col, emit: 0 });
      };
      for (const a of ACROSS) {
        box(a - BAR / 2, a + BAR / 2, SPIKE + lift, top, DEPTH);
        const s0 = lift, s1 = Math.min(top, SPIKE + lift);
        if (s1 - s0 > 0.02) {
          // (Cut off at the top: only the part of the spike that's below the lintel. Tapered to a point at its
          // bottom, twice as wide as it's given at its top.)
          const w = 0.4 * BAR * (s1 - s0) / SPIKE;
          box(a - w, a + w, s0, s1, DEPTH, 2);
        }
      }
      for (const v of UP) if (v + lift + BAR / 2 <= top) box(0.06, 1.94, v + lift - BAR / 2, v + lift + BAR / 2, DEPTH * 0.8);
    }
    return out;
  }

  // The made gate a ray (origin, direction dir) meets first within its opening (its grid's plane), nearer than maxT
  // (along dir): { g, s (the section there), t }, or null.
  rayHit(origin, dir, maxT = Infinity) {
    let best = null;
    for (const g of this.list) {
      if (!g.built) continue;
      const k = g.along[0] ? 2 : 0, plane = (g.along[0] ? g.z : g.x) + 0.5; // (the axis across the wall)
      if (Math.abs(dir[k]) < 1e-9) continue;
      const t = (plane - origin[k]) / dir[k];
      if (t <= 0 || t >= maxT || (best && t >= best.t)) continue;
      const p = origin.map((o, i) => o + dir[i] * t), u = g.along[0] ? p[0] - g.x : p[2] - g.z;
      if (u < 0 || u > 2 || p[1] < g.y0 || p[1] > g.y0 + 2) continue;
      best = { g, s: g.tiles[u < 1 ? 0 : 1], t };
    }
    return best;
  }

  // Ghost markers for those ordered, not yet made: [x, y, z, 13] over each voxel of the opening to be.
  ghosts(out = []) {
    for (const g of this.list) if (!g.built) for (const s of g.tiles) for (let k = 0; k < 2; k++) out.push([s.x, g.y0 + k, s.z, 13]);
    return out;
  }
  // And for one that would go at placement p: 11 where it fits (12 when the iron's short), 10 where it can't.
  preview(p, short = false, out = []) {
    for (const s of p.tiles) for (let k = 0; k < 2; k++) out.push([s.x, p.y0 + k, s.z, !p.fits ? 10 : short ? 12 : 11]);
    return out;
  }
}

const smooth = (t) => t * t * (3 - 2 * t);

// The job of making one gate: one column, one task (a worker's hammering at it for buildTime), done once it's made (or
// gone).
export class GateJob {
  constructor(gates, gate) {
    this.gates = gates;
    this.gate = gate;
    const { x, z } = gate;
    this.x0 = Math.min(...gate.tiles.map((s) => s.x)); this.z0 = Math.min(...gate.tiles.map((s) => s.z));
    this.x1 = Math.max(...gate.tiles.map((s) => s.x)) + 1; this.z1 = Math.max(...gate.tiles.map((s) => s.z)) + 1;
    this.pending = [x + X * z];
    this.claimed = new Map();
    this.skipUntil = new Map();
    this.onMade = null; // (gate) => void
  }

  get done() { return this.pending.length === 0 || this.gate.built || !this.gates.list.includes(this.gate); }

  contains(x, z) { return this.gate.tiles.some((s) => s.x === x && s.z === z); }

  task(x, z) {
    const g = this.gate;
    if (g.built || !this.gates.list.includes(g)) return null;
    return {
      x, y: g.y0, z, dig: false, top: g.y0, ...GATE_REACH, time: Math.max(0.1, GATE_TUNING.buildTime), tool: 'hammer',
      onPlace: () => { if (this.gates.make(g).length) this.onMade?.(g); },
    };
  }

  // Calling it off takes the order away too (and main gives the iron back).
  cancel() { if (!this.gate.built) this.gates.remove(this.gate); }

  marks() { return []; }
}
