// Torches placed in the world, Minecraft style: chosen from the Build menu, a click on the top of a block marks a
// torch standing up on it, a click on the side of one a torch leaning out from the wall. Each takes up an empty voxel
// (one torch per voxel) without filling it, so villagers walk through it. A villager carries it there and sets it;
// it burns day and night until what holds it up is dug away or its voxel is filled.

import { SIZE, BLOCK } from './terrain.js';

const [X, Y, Z] = SIZE;
const STICK = 0.125, LENGTH = 0.625, FLAME = 0.16, LEAN = 0.4; // sizes (voxels), and a wall torch's lean (radians)
const TORCH_REACH = { reach: 3, reachUp: 4, reachDown: 4 };

export class Torches {
  constructor(terrain) {
    this.terrain = terrain;
    this.list = []; // { cell: [x, y, z], wall: [dx, dz] or null (on the floor), lit: false until it's been set }
  }

  at(x, y, z) { return this.list.find((t) => t.cell[0] === x && t.cell[1] === y && t.cell[2] === z) ?? null; }

  // Where a click on a surface (a raycast hit) would put a torch: { cell, wall } (fits: whether it can go there), or
  // null for a ceiling.
  placement(hit) {
    if (!hit) return null;
    const [nx, ny, nz] = hit.normal;
    if (ny < -0.5) return null;
    const cell = hit.point.map((v, i) => Math.floor(v + hit.normal[i] * 0.5));
    const wall = ny > 0.5 ? null : [Math.round(nx), Math.round(nz)]; // the way it leans: out of the wall
    return { cell, wall, fits: this.fits(cell, wall) && !this.at(...cell) };
  }

  // Whether a torch can be in `cell`: an empty voxel with a block under it (on the floor) or behind it (on a wall).
  fits([x, y, z], wall) {
    const t = this.terrain;
    if (x < 0 || z < 0 || y < 1 || x >= X || y >= Y || z >= Z || t.block(x, y, z) !== BLOCK.AIR) return false;
    return wall ? t.solid(x - wall[0], y, z - wall[1]) : t.solid(x, y - 1, z);
  }

  // Marks a torch to be set; returns the job for it.
  add({ cell, wall }) {
    const torch = { cell, wall, lit: false };
    this.list.push(torch);
    return new TorchJob(this, torch);
  }

  // Drops the torches whose voxel was filled or whose support was dug away. Call after the voxels change.
  check() {
    this.list = this.list.filter((t) => this.fits(t.cell, t.wall));
  }

  // The stick's base, its direction (unit) and the flame's centre.
  pose(t) {
    const [x, y, z] = t.cell;
    if (!t.wall) return { base: [x + 0.5, y, z + 0.5], dir: [0, 1, 0] };
    const [dx, dz] = t.wall, s = Math.sin(LEAN), c = Math.cos(LEAN);
    // Its foot against the wall a little way up, leaning out.
    return { base: [x + 0.5 - dx * 0.5, y + 0.2, z + 0.5 - dz * 0.5], dir: [dx * s, c, dz * s] };
  }

  // Boxes for the unit renderer (see Units.parts), and the flames as lights: [x, y, z, brightness].
  parts(clock, flameCol, flicker, wood) {
    const out = [], flames = [];
    for (const t of this.list) {
      if (!t.lit) continue;
      const { base, dir } = this.pose(t);
      const mid = base.map((b, i) => b + dir[i] * LENGTH / 2);
      const tip = base.map((b, i) => b + dir[i] * (LENGTH - FLAME / 2));
      out.push({ m: boxMatrix(mid, dir, STICK, LENGTH), col: wood, emit: 0 });
      out.push({ m: boxMatrix(tip, dir, FLAME, FLAME), col: flameCol, emit: 1 });
      const k = clock * 9 + (t.cell[0] * 7.1 + t.cell[2] * 3.7);
      flames.push([...tip, 1 - flicker * (0.5 + 0.3 * Math.sin(k) + 0.2 * Math.sin(k * 2.7 + 1.3))]);
    }
    return { parts: out, flames };
  }

  // Ghost markers (see the unit renderer's vsGhost) for the torches still to be set: [x, y, z, 4] at the stick's middle.
  ghosts(out = []) {
    for (const t of this.list) if (!t.lit) out.push(marker(this.pose(t), 4));
    return out;
  }
  // The marker for a torch that would go at placement p (red where it can't).
  preview(p) { return marker(this.pose(p), p.fits ? 4 : 5); }
}

function marker({ base, dir }, kind) {
  return [...base.map((b, i) => b + dir[i] * LENGTH / 2 - 0.5), kind];
}

// A box `w` wide and deep and `len` long along `dir` (unit), centred at c, as a column-major model matrix.
function boxMatrix(c, dir, w, len) {
  // Across: horizontal and square to dir (any horizontal if dir is straight up); then the third axis.
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

// The job of setting one torch: one column, one task, done once it's lit (or gone).
export class TorchJob {
  constructor(torches, torch) {
    this.torches = torches;
    this.torch = torch;
    const [x, , z] = torch.cell;
    this.x0 = x; this.z0 = z; this.x1 = x + 1; this.z1 = z + 1;
    this.pending = [x + X * z];
    this.claimed = new Map();
    this.skipUntil = new Map();
  }

  get done() { return this.pending.length === 0; }

  contains(x, z) { return x === this.x0 && z === this.z0; }

  task(x, z) {
    const t = this.torch;
    if (t.lit || !this.torches.list.includes(t)) return null;
    const [, y] = t.cell;
    return { x, y, z, dig: false, top: y, ...TORCH_REACH, onPlace: () => { t.lit = true; } };
  }

  // Calling it off takes the mark away too.
  cancel() { this.torches.list = this.torches.list.filter((t) => t !== this.torch); }

  marks() { return []; }
}
