// Spawn points (editor): where a building, once built, brings out a new unit, and the way it faces. Placed from the
// Build menu on the top of a block, each takes up the empty voxel above it (without filling it) and shows as a glowing
// blue plate a third of a voxel high with an arrow on it the way the unit will face. A design saved round one keeps it
// (one per design, see captureDesign); a building's plan carries it as plan.spawn: { cell: [x, y, z], dir: [dx, dz] }.

import { SIZE, BLOCK } from './terrain.js';

const [X, Y, Z] = SIZE;

export const SPAWN_TUNING = {
  color: '#3d9bff', // the plate's glow
  glow: 1.6,        // its brightness (past 1 blooms)
};

export class SpawnPoints {
  constructor(terrain) {
    this.terrain = terrain;
    this.list = []; // { cell: [x, y, z], dir: [dx, dz] }
  }

  at(x, y, z) { return this.list.find((s) => s.cell[0] === x && s.cell[1] === y && s.cell[2] === z) ?? null; }

  // Where a click on a surface (a raycast hit) would put one: on top faces only. { cell, fits }, or null.
  placement(hit) {
    if (!hit || hit.normal[1] < 0.5) return null;
    const cell = hit.point.map((v, i) => Math.floor(v + hit.normal[i] * 0.5));
    return { cell, fits: this.fits(cell) };
  }

  // An empty voxel with a block under it.
  fits([x, y, z]) {
    const t = this.terrain;
    return x >= 0 && z >= 0 && y >= 1 && x < X && y < Y && z < Z && t.block(x, y, z) === BLOCK.AIR && t.solid(x, y - 1, z);
  }

  add(cell, dir) { this.list.push({ cell, dir }); }
  remove(s) { this.list = this.list.filter((o) => o !== s); }
  // A quarter turn clockwise, seen from above.
  turn(s) { s.dir = [-s.dir[1], s.dir[0]]; }

  // Drops those whose voxel was filled or whose block was dug away.
  check() { this.list = this.list.filter((s) => this.fits(s.cell)); }

  // Those in the voxel box [x0, x1) × [y0, y1) × [z0, z1).
  inBox(x0, z0, x1, z1, y0, y1) {
    return this.list.filter(({ cell: [x, y, z] }) => x >= x0 && x < x1 && y >= y0 && y < y1 && z >= z0 && z < z1);
  }

  // Boxes for the unit renderer, every one placed.
  parts(out, color) {
    for (const s of this.list) spawnParts(s.cell, s.dir, color, out);
    return out;
  }
}

// A plate and its arrow at cell, facing dir, for the unit renderer; `color` is linear rgb, `dim` for a preview.
export function spawnParts([x, y, z], [dx, dz], color, out = [], dim = 1) {
  const yaw = Math.atan2(dx, dz), H = 1 / 3;
  const glow = color.map((c) => c * SPAWN_TUNING.glow * dim);
  out.push({ m: yawBox([x + 0.5, y + H / 2, z + 0.5], 0, 0.9, H, 0.9), col: glow, emit: 2 });
  // The arrow, white on top of it: a shaft and the two halves of its head.
  const white = [1.4 * dim, 1.4 * dim, 1.5 * dim], top = y + H + 0.02;
  const along = (d, s = 0) => [x + 0.5 + dx * d + dz * s, top, z + 0.5 + dz * d - dx * s];
  out.push({ m: yawBox(along(-0.08), yaw, 0.1, 0.04, 0.44), col: white, emit: 1 });
  for (const side of [-1, 1]) {
    out.push({ m: yawBox(along(0.12, side * 0.09), yaw - side * Math.PI / 4, 0.1, 0.04, 0.3), col: white, emit: 1 });
  }
  return out;
}

// A box sx × sy × sz (sz along the yaw: 0 is +z) centred at c, turned by yaw about the vertical, as a column-major
// model matrix.
function yawBox(c, yaw, sx, sy, sz) {
  const s = Math.sin(yaw), k = Math.cos(yaw);
  return [k * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, k * sz, 0, c[0], c[1], c[2], 1];
}
