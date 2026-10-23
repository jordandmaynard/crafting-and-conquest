// Ladders: workers (only workers) build them for free when they can't get back to the Keep (out of a pit, or up to an
// old ladder a cavern's been dug out from under; see jobs.js Workers.escape). A ladder stands up the middle of open
// cells, freestanding, as high as it takes: each rung is an empty cell, with the way a worker faces climbing it
// (dx, dz). A worker climbs with its feet in those cells, straight up or down, and steps off sideways. Others walk
// through them as if they weren't there. A rung goes once its cell is filled.

import { SIZE } from './terrain.js';

export const LADDER_TUNING = {
  climbSpeed: 2.2, // voxels a second a worker climbs
  buildTime: 0.4,  // seconds a worker takes to fix each rung
  trapped: 150,    // with no Keep to get back to (sandbox): a worker that can walk to fewer cells than this is stuck
  maxHeight: 24,   // tallest ladder it builds, in voxels
  every: 3,        // seconds between a stuck worker's looks for where to build one
};

const [X, Y, Z] = SIZE;
const WOOD = [0.45, 0.27, 0.12], RUNG = [0.52, 0.33, 0.16];

export class Ladders {
  constructor(terrain) {
    this.terrain = terrain;
    this.at = new Map(); // voxel index -> { x, y, z, dx, dz }
    this.building = [];  // ladders being built: { x, y0, z } their foot (others in that pit wait for it)
    this.version = 0;    // bumped when a rung comes or goes
  }

  add(x, y, z, dx, dz) {
    this.at.set(this.terrain.index(x, y, z), { x, y, z, dx, dz });
    this.version++;
  }

  // The rung at (x, y, z), while its cell's empty (else null).
  get(x, y, z) {
    if (x < 0 || z < 0 || x >= X || z >= Z || y < 1 || y >= Y) return null;
    const r = this.at.get(this.terrain.index(x, y, z));
    if (!r) return null;
    return this.terrain.solid(x, y, z) ? null : r;
  }
  has(x, y, z) { return !!this.get(x, y, z); }

  // Drops the rungs whose cell's been filled (after an edit).
  prune() {
    for (const [k, r] of this.at) if (!this.get(r.x, r.y, r.z)) { this.at.delete(k); this.version++; }
  }

  // Rails and rungs as boxes ({ m, col, emit }, like Units.parts), across the middle of each cell, a little in front of
  // where a worker climbing it is (see Units.parts' cling). hidden(x, z): fogged.
  parts(out = [], hidden = null) {
    for (const r of this.at.values()) {
      if (hidden?.(r.x + 0.5, r.z + 0.5) || !this.get(r.x, r.y, r.z)) continue;
      const cx = r.x + 0.5 + r.dx * 0.12, cz = r.z + 0.5 + r.dz * 0.12, along = r.dx ? [0, 1] : [1, 0];
      const box = (c, s, col) => out.push({ m: [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, c[0], c[1], c[2], 1], col, emit: 0 });
      const size = (w, h, d) => r.dx ? [d, h, w] : [w, h, d]; // (w along the wall, d out from it)
      for (const side of [-1, 1]) box([cx + along[0] * 0.33 * side, r.y + 0.5, cz + along[1] * 0.33 * side], size(0.08, 1, 0.07), WOOD);
      for (const h of [0.25, 0.75]) box([cx, r.y + h, cz], size(0.6, 0.06, 0.05), RUNG);
    }
    return out;
  }
}
