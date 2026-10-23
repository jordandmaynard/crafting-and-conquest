// Banners (the Editor's Build menu: Banner 1, 2 and 3): a cloth hung down the side of a block from a rod just under
// its top, 1, 2 or 3 voxels long, cut to a point at the bottom, like the walls' (see walls.js). A click on the side of
// a block hangs one in front of it (a click on one already there takes it down, or changes its length); they're saved
// with a design like its torches, and come with the building once it's built. Always in the colour of the team that
// built the block it hangs on (Terrain.owners; none: plain cloth). They take up no voxel: villagers walk through them.
// One goes once the block it hangs on does.

import { SIZE, BLOCK } from './terrain.js';
import { TEAMS } from './units.js';
import { bannerShape } from './banner-shape.js';

const [X, Y, Z] = SIZE;
const ROD = [0.3, 0.2, 0.1], PLAIN = [0.78, 0.72, 0.6];
const TEAM_ORDER = ['blue', 'red', 'yellow', 'purple']; // (Terrain.owners' OWNER 1 to 4)

// How a hung banner (these, and the walls') looks: its point, and its flutter. (T > Banners.)
export const BANNER_LOOK = {
  point: 0.45,       // voxels from where its sides end to the tip of its point
  flutter: 0.06,     // radians it swings out from the wall (and half that, turning; its bottom ripples wider and narrower)
  flutterSpeed: 2.4, // how fast (radians a second)
};

// Parts ({ m, col, emit, shape }) for a banner hung on the face of column (x, z) that looks `out` ([dx, dz]), its rod at
// height top - 0.12, its cloth len long and then its point (a triangle, BANNER_LOOK.point more), in colour col: the
// cloth one part (see bannerShape), so no line where its point starts. wave: a clock: it flutters a little like the
// wheat sways, swinging out from the wall (never into it) and turning a touch, its bottom rippling.
export function bannerParts(out, x, z, top, [ox, oz], len, col, wave = 0) {
  const L = BANNER_LOOK, point = Math.max(0, L.point), H = len + point;
  const band = col.map((v) => v + (1 - v) * 0.45);
  const W = 0.62, D = 0.035, face = 0.5 + 0.02 + D / 2; // (the cloth's middle, out from the column's middle)
  const k = wave * L.flutterSpeed + x * 0.9 + z * 1.1;
  const swing = L.flutter * (0.6 + 0.25 * Math.sin(k) + 0.15 * Math.sin(k * 2.3 + 1.1)); // (out from the wall, always)
  const turn = L.flutter * 0.5 * Math.sin(k * 0.7 + 2.0);
  // Its axes: along the face (turned a touch), out from it, and down its length (swung out).
  const ct = Math.cos(turn), st = Math.sin(turn);
  const across = [-oz * ct + ox * st, 0, ox * ct + oz * st], o = [ox * ct + oz * st, 0, oz * ct - ox * st];
  const down = [o[0] * Math.sin(swing), -Math.cos(swing), o[2] * Math.sin(swing)];
  const n = [o[0] * Math.cos(swing), Math.sin(swing), o[2] * Math.cos(swing)];
  const y1 = top - 0.12, hinge = [x + 0.5 + ox * face, y1, z + 0.5 + oz * face];
  // A part w across and h long, its top `from` down from the rod, d thick and `off` out from the cloth's middle.
  const part = (from, w, h, d, off, c, shape, taper = 0) => {
    const m = [...across.map((v) => v * w), taper, ...down.map((v) => -v * h), 0, ...n.map((v) => v * d), 0,
      ...hinge.map((v, i) => v + down[i] * (from + h / 2) + n[i] * off), 1];
    out.push({ m, col: c, emit: 0, shape });
  };
  const rod = 0.5 + 0.01 + 0.03;
  out.push({ m: [ox ? 0.06 : 0.76, 0, 0, 0, 0, 0.07, 0, 0, 0, 0, ox ? 0.76 : 0.06, 0, x + 0.5 + ox * rod, y1 + 0.02, z + 0.5 + oz * rod, 1], col: ROD, emit: 0 });
  part(0, W, H, D, 0, col, bannerShape(point / Math.max(H, 1e-3)), L.flutter * Math.sin(k * 1.6 + 0.5)); // the cloth
  part(Math.min(0.28, len * 0.45) - 0.06, W + 0.01, 0.12, D + 0.005, 0, band); // its band
  return out;
}

// A banner `h` voxels long hangs this long (its cloth, above the point).
const clothOf = (h) => Math.min(1.7, h - 0.72);

export class Banners {
  constructor(terrain) {
    this.terrain = terrain;
    this.list = []; // { cell: [x, y, z] (the voxel in front of the block it hangs on), wall: [dx, dz] (out from it), h }
  }

  at(x, y, z) { return this.list.find((b) => b.cell[0] === x && b.cell[1] === y && b.cell[2] === z) ?? null; }

  // Where a click on a surface (a raycast hit) would hang one h long: { cell, wall, h, fits }, or null off a block's
  // side.
  placement(hit, h) {
    if (!hit || Math.abs(hit.normal[1]) > 0.5) return null;
    const cell = hit.point.map((v, i) => Math.floor(v + hit.normal[i] * 0.5));
    const wall = [Math.round(hit.normal[0]), Math.round(hit.normal[2])];
    return { cell, wall, h, fits: this.fits(cell, wall) };
  }

  // Whether one can hang in `cell`: in the map, an empty voxel with a block behind it.
  fits([x, y, z], [dx, dz]) {
    const t = this.terrain;
    if (x < 0 || z < 0 || y < 1 || x >= X || y >= Y || z >= Z || t.block(x, y, z) !== BLOCK.AIR) return false;
    return t.solid(x - dx, y, z - dz);
  }

  // Hangs one (in place of one already in that voxel; the same again takes it down). Returns whether one's there now.
  toggle({ cell, wall, h }) {
    const old = this.at(...cell);
    this.list = this.list.filter((b) => b !== old);
    if (old && old.h === h && old.wall[0] === wall[0] && old.wall[1] === wall[1]) return false;
    this.list.push({ cell, wall, h });
    return true;
  }
  add({ cell, wall, h }) {
    if (this.fits(cell, wall) && !this.at(...cell)) this.list.push({ cell, wall, h });
  }

  // Drops those whose voxel was filled or whose block was dug away. Call after the voxels change.
  check() {
    this.list = this.list.filter((b) => this.fits(b.cell, b.wall));
  }

  // The colour of one on the block at (x, z)'s column: its builder's team's.
  colourAt(x, z) {
    const team = TEAM_ORDER[this.terrain.owners[x + X * z] - 1];
    return TEAMS[team]?.toga ?? PLAIN;
  }

  // Boxes for the unit renderer (see Units.parts). hidden(x, z): fogged. wave: a clock, for their sway.
  parts(out = [], hidden = null, wave = 0) {
    for (const b of this.list) this.partsOf(b, out, hidden, wave);
    return out;
  }
  partsOf({ cell: [x, y, z], wall, h }, out = [], hidden = null, wave = 0) {
    const sx = x - wall[0], sz = z - wall[1];
    if (hidden?.(sx + 0.5, sz + 0.5)) return out;
    return bannerParts(out, sx, sz, y + 1, wall, clothOf(h), this.colourAt(sx, sz), wave);
  }

  // Ghost markers for one that can't hang at placement p (red: [x, y, z, 5] per voxel it would cover).
  blocked(p, out = []) {
    for (let k = 0; k < p.h; k++) out.push([p.cell[0], p.cell[1] - k, p.cell[2], 5]);
    return out;
  }
}
