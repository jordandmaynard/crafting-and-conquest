// Ore's look: iron and gold ore (BLOCK.IRON, BLOCK.GOLD) are stone with flecks of their metal (the terrain shader's),
// and on every face of one open to the air, a few polygonal chunks of the metal sticking out of it, so they're easy
// to pick out. The chunks are tapered boxes at odd angles (gold's, rounded nuggets) for the units renderer (a renderer of their own, so they
// don't take from the villagers' parts), each face's made the same every time from its voxel. Only those within reach
// of the camera are drawn. They're kept per 16 × 16 column tile, made again when an edit (any terrain.updateBricks)
// touches the tile, so mining next to one shows its new face's chunks and a mined one's go.

import { SIZE, BLOCK, SOLID_MIN, WATER_LEVEL, isOre } from './terrain.js';
import { linearColor } from './sky.js';

const [X, Y, Z] = SIZE;
const TILE = 16;

export const ORE_LOOK = {
  ironColor: '#ababab', // the chunks' colours
  goldColor: '#ffae00',
  ironShine: 0.14,      // how much of each is its own colour (0-1, unlit)
  goldShine: 0.12,
  // Polished metal, not toon shaded (see metalColour in units-render.js):
  reflection: 1.4,      // how strong its reflections are (0 = flat colour)
  envGain: 1.03,        // their brightness
  sunSpot: 3.7,         // the sun's highlight on them
  sunSharp: 4,          // and how tight it is
  // What they reflect: the terrain and sky baked into a cube (see TerrainRenderer.bakeCube), now and then, from above
  // the camera's target; not realtime, and only roughly what's round each chunk.
  envHeight: 41,        // voxels above the ground there
  envEvery: 60,         // seconds between bakes (and on a big move of the camera)
  envSize: 64,          // each face's size (pixels)
  glints: 0.76,         // how bright the glints flashing on it are
  glintSpeed: 1.14,     // how often they flash
  size: 1.15,           // the chunks' size (1 = about a fifth of a voxel)
  reach: 140,           // voxels from the camera's target that chunks are drawn out to (plus its distance)
  refresh: 0.25,        // seconds between gathering the chunks round the camera
};

const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export class OreChunks {
  constructor(terrain) {
    this.terrain = terrain;
    this.tiles = new Map(); // tile (tx + tz * tiles across) -> [voxel index] of ore
    this.made = new Map();  // tile -> its open faces' chunks' parts (gone when an edit touches it)
    this.list = [];
    this.wait = 0;
    this.look = '';
    // Every edit tells the terrain's bricks; the tiles it touches (and a voxel round it) are made again.
    const update = terrain.updateBricks.bind(terrain), across = Math.ceil(X / TILE);
    terrain.updateBricks = (lo, hi) => {
      update(lo, hi);
      const x0 = Math.max(0, Math.floor((lo[0] - 1) / TILE)), x1 = Math.floor(Math.min(X - 1, hi[0]) / TILE);
      const z0 = Math.max(0, Math.floor((lo[2] - 1) / TILE)), z1 = Math.floor(Math.min(Z - 1, hi[2]) / TILE);
      for (let tz = z0; tz <= z1; tz++) for (let tx = x0; tx <= x1; tx++) this.made.delete(tx + tz * across);
      this.wait = 0;
    };
  }

  // Finds the ore (after the world's made, or made again).
  index() {
    const t = this.terrain, v = t.voxels, across = Math.ceil(X / TILE);
    this.tiles.clear();
    this.made.clear();
    for (let z = 0; z < Z; z++) {
      for (let y = 0; y < Y; y++) {
        for (let x = 0; x < X; x++) {
          const i = t.index(x, y, z);
          if (!isOre(v[i])) continue;
          const k = Math.floor(x / TILE) + Math.floor(z / TILE) * across;
          if (!this.tiles.has(k)) this.tiles.set(k, []);
          this.tiles.get(k).push(i);
        }
      }
    }
    this.wait = 0;
  }

  // The chunks' parts round (cx, cz) out to `reach`, gathered again every ORE_LOOK.refresh seconds (or after an edit).
  parts(dt, cx, cz, reach) {
    const L = ORE_LOOK;
    const look = `${L.ironColor}${L.goldColor}${L.ironShine}${L.goldShine}${L.size}`;
    if (look !== this.look) { this.look = look; this.made.clear(); this.wait = 0; }
    if ((this.wait -= dt) > 0) return this.list;
    this.wait = L.refresh;
    const across = Math.ceil(X / TILE);
    const out = [];
    const t0x = Math.max(0, Math.floor((cx - reach) / TILE)), t1x = Math.min(across - 1, Math.floor((cx + reach) / TILE));
    const t0z = Math.max(0, Math.floor((cz - reach) / TILE)), t1z = Math.min(Math.ceil(Z / TILE) - 1, Math.floor((cz + reach) / TILE));
    for (let tz = t0z; tz <= t1z; tz++) {
      for (let tx = t0x; tx <= t1x; tx++) {
        const k = tx + tz * across;
        if (!this.tiles.has(k)) continue;
        let parts = this.made.get(k);
        if (!parts) { parts = this.make(k); this.made.set(k, parts); }
        for (const p of parts) out.push(p);
      }
    }
    this.list = out;
    return out;
  }

  // Tile k's open ore faces' chunks.
  make(k) {
    const v = this.terrain.voxels, out = [];
    for (const i of this.tiles.get(k)) {
      const b = v[i];
      if (!isOre(b)) continue; // (mined)
      const x = i % X, y = Math.floor(i / X) % Y, z = Math.floor(i / (X * Y));
      for (let f = 0; f < 6; f++) {
        const [dx, dy, dz] = FACES[f];
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (ny < 0) continue;
        const open = nx < 0 || nz < 0 || nx >= X || ny >= Y || nz >= Z || v[i + dx + X * (dy + Y * dz)] < SOLID_MIN;
        if (open) out.push(...chunks(x, y, z, FACES[f], b, i * 6 + f));
      }
    }
    return out;
  }
}

// A face's chunks: two or three of the metal sticking out of it: iron's tapered boxes leaning out at odd angles,
// narrowing outward; gold's rounded nuggets, squat and half sunk in the stone.
function chunks(x, y, z, nrm, block, seed) {
  let s = (seed * 2654435761 + 1013904223) >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const L = ORE_LOOK, gold = block === BLOCK.GOLD;
  const col = linearColor(gold ? L.goldColor : L.ironColor);
  const shine = gold ? L.goldShine : L.ironShine;
  // The face's two directions across it.
  const u = nrm[0] ? [0, 1, 0] : [1, 0, 0];
  const w = cross(nrm, u);
  const centre = [x + 0.5 + nrm[0] * 0.5, y + 0.5 + nrm[1] * 0.5, z + 0.5 + nrm[2] * 0.5];
  const n = 2 + (rand() < 0.55 ? 1 : 0);
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = (rand() - 0.5) * 0.64, b = (rand() - 0.5) * 0.64;
    const size = (0.15 + rand() * 0.12) * L.size;
    // Its up leans off the face's normal; its other two axes spin about it.
    const up = norm(add(nrm, add(scale(u, (rand() - 0.5) * 1.1), scale(w, (rand() - 0.5) * 1.1))));
    const spin = rand() * Math.PI * 2;
    const side0 = norm(cross(up, Math.abs(up[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const side1 = cross(up, side0);
    const ax = add(scale(side0, Math.cos(spin)), scale(side1, Math.sin(spin)));
    const az = cross(ax, up);
    let sx, sy, sz, tx = 0, tz = 0, rise;
    if (gold) { // a nugget: wider than it's tall
      sx = size * (1.1 + rand() * 0.45); sy = size * (0.7 + rand() * 0.35); sz = size * (1.1 + rand() * 0.45);
      rise = 0.08;
    } else {
      sx = size * (0.75 + rand() * 0.5); sy = size * (1.1 + rand() * 0.9); sz = size * (0.75 + rand() * 0.5);
      tx = -(0.25 + rand() * 0.45); tz = -(0.25 + rand() * 0.45); // (narrower towards its top: the tip)
      rise = 0.18;
    }
    const c = add(centre, add(add(scale(u, a), scale(w, b)), scale(up, sy * rise)));
    const shade = 0.8 + rand() * 0.4;
    out.push({
      m: [ax[0] * sx, ax[1] * sx, ax[2] * sx, tx, up[0] * sy, up[1] * sy, up[2] * sy, tz, az[0] * sz, az[1] * sz, az[2] * sz, 0, c[0], c[1], c[2], 1],
      col: col.map((v) => v * shade),
      emit: 3 + shine, // (3 and up: metal)
      ...(gold && { shape: 'nugget' }),
    });
  }
  return out;
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Every start gets stone and iron within reach (Jordan; gold's left to chance): where there's less than START_ORE asks
// round the Keep at (sx, sz), a rocky mound of stone is raised on open land nearby, iron showing in it. Placed as
// plantStartForest places its forest (the roomiest spot, nearer preferred, in a frame turned towards the map's middle,
// the same seed), so symmetric starts get the same mound. avoid(x, z): columns to keep off (by a land bridge).
export const START_ORE = {
  reach: 26,   // voxels round the start counted
  stone: 30,   // stone blocks showing (with a face open to the air) wanted in reach
  iron: 6,     // iron blocks showing wanted in reach
  dist: 14,    // voxels from the start the mound's looked for from (out to reach)
  clear: 10,   // and never nearer than this (the Keep's there)
  radius: 4,   // the mound's radius
  height: 2,   // stone it rises above the ground at its middle
};
export function placeStartOre(terrain, seed, sx, sz, avoid = null) {
  const S = START_ORE, v = terrain.voxels, R = Math.ceil(S.reach);
  const open = (x, y, z) => x < 0 || z < 0 || x >= X || z >= Z || y >= Y || v[terrain.index(x, y, z)] < SOLID_MIN;
  const showing = (x, y, z) => FACES.some(([dx, dy, dz]) => open(x + dx, y + dy, z + dz));
  let stone = 0, iron = 0;
  for (let z = sz - R; z <= sz + R; z++) {
    for (let x = sx - R; x <= sx + R; x++) {
      if (x < 0 || z < 0 || x >= X || z >= Z || Math.hypot(x - sx, z - sz) > R) continue;
      const h = terrain.groundAt(x, z);
      for (let y = Math.max(WATER_LEVEL, h - 4); y < h; y++) {
        const b = v[terrain.index(x, y, z)];
        if ((b === BLOCK.STONE || b === BLOCK.IRON) && showing(x, y, z)) b === BLOCK.STONE ? stone++ : iron++;
      }
    }
  }
  const needIron = Math.max(0, Math.round(S.iron) - iron);
  if (stone >= S.stone && !needIron) return 0;
  let s = (seed * 3266489917 + 11) >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const a0 = Math.atan2((Z - 1) / 2 - sz, (X - 1) / 2 - sx), c = Math.cos(a0), n = Math.sin(a0);
  const at = (u, w) => [Math.round(sx + u * c - w * n), Math.round(sz + u * n + w * c)]; // (u towards the middle)
  // Open land: dry, nothing on it (a tree, a building), not by the map's edge, the start or a bridge.
  const land = (x, z) => {
    if (x < 4 || z < 4 || x >= X - 4 || z >= Z - 4 || Math.hypot(x - sx, z - sz) < S.clear || avoid?.(x, z)) return -1;
    const h = terrain.groundAt(x, z);
    if (h < WATER_LEVEL + 2 || h + 4 >= Y) return -1;
    for (let y = h; y < h + 4; y++) if (v[terrain.index(x, y, z)] !== BLOCK.AIR) return -1;
    return h;
  };
  const r = Math.max(2, S.radius);
  let best = null, most = 0;
  for (let d = S.dist; d <= Math.max(S.dist, S.reach - r); d += 3) {
    for (let a = 0; a < 16; a++) {
      const cu = Math.cos(a * Math.PI / 8) * d, cw = Math.sin(a * Math.PI / 8) * d;
      let room = 0;
      for (let dw = -r; dw <= r; dw++) for (let du = -r; du <= r; du++) if (du * du + dw * dw <= r * r && land(...at(cu + du, cw + dw)) >= 0) room++;
      const score = room - (d - S.dist) * 0.5;
      if (room > r * r && score > most) { most = score; best = [cu, cw]; }
    }
  }
  if (!best) return 0;
  // The mound: each column's top turned to stone, and stone piled on it, higher towards the middle, its edge ragged.
  const tops = [];
  for (let dw = -r; dw <= r; dw++) {
    for (let du = -r; du <= r; du++) {
      const e = Math.hypot(du, dw) / r + (rand() - 0.5) * 0.35;
      if (e > 1) continue;
      const [x, z] = at(best[0] + du, best[1] + dw), h = land(x, z);
      if (h < 0) continue;
      v[terrain.index(x, h - 1, z)] = BLOCK.STONE;
      const up = Math.round(S.height * (1 - e) + rand() * 0.6);
      for (let k = 0; k < up; k++) v[terrain.index(x, h + k, z)] = BLOCK.STONE;
      tops.push({ x, y: h - 1 + up, z, e });
    }
  }
  // Iron showing in it, nearest its middle first (a little shuffled).
  for (const t of tops) t.e += rand() * 0.3;
  tops.sort((p, q) => p.e - q.e);
  for (let i = 0; i < Math.min(tops.length, needIron + 2); i++) v[terrain.index(tops[i].x, tops[i].y, tops[i].z)] = BLOCK.IRON;
  terrain.updateBricks([Math.max(0, sx - 40), 0, Math.max(0, sz - 40)], [Math.min(X, sx + 41), Y, Math.min(Z, sz + 41)]);
  return tops.length;
}
