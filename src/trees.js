// Trees, as in Minecraft: oaks of log and leaf blocks on the voxel grid. A tree is just its blocks: villagers can't
// walk through them (but can stand on them), brushes and flatten jobs remove them like anything else. Cutting a log
// fells the trunk above it, and leaves that are no longer within reach of a log (through other leaves) wither away
// over the next few seconds.

import { SIZE, BLOCK, WATER_LEVEL } from './terrain.js';

export const TREE_TUNING = {
  spacing: 7,        // voxels between tree spots (each jittered within its cell)
  density: 1.5,      // chance of a tree at a spot in a forest (over 1: what's over is a second tree's, see plantTrees)
  forestScale: 2.2,  // forests' noise frequency (×; higher: more, smaller forests)
  forestEdge: 0.72,  // where the woods noise (0-1) is over this, it's forest; under it, open land
  forestMapScale: 0.6, // smaller maps than 500 across get smaller, closer forests (frequency × (500 / size)^this), so
                     // a small map still has a few, not one or none
  startTrees: 10,    // a new game: each start gets a forest of at least this many trees within startReach of it (see
  startReach: 28,    // plantStartForest; voxels)
  startDist: 16,     // planted round about this far from the start (voxels; further, up to startReach, where there's no
                     // room nearer: a start on a spit of sand)
  startClear: 9,     // and none nearer it than this (the Keep and its yard)
  lone: 0.02,        // chance of a lone tree at a spot out in the open
  forestLink: 8,     // a tree with its trunk within this many voxels (across the ground) of a forest's is part of it
  forestMax: 400,    // trees a forest is counted up to (Shift+click with Mine marks them all)
  trunk: 3,          // logs of bare trunk at least, between the ground and the lowest leaves (read when the world's made)
  trunkVary: 2,      // and up to this many more
  leafReach: 4,      // leaves further than this from a log (counting through leaves) decay
  decayMin: 0.5,     // seconds before an unsupported leaf goes, at the soonest
  decayMax: 6,       // and at the latest
};

const [X, Y, Z] = SIZE;

// Scatters oaks over the dry grassland (not on bare stone): in forests, patches where a low-frequency woods noise is
// over forestEdge, thick with trees, and here and there a lone tree out in the open between them, so each forest
// reads as one (see forestOf). Deterministic for a seed. avoid(x, z): columns not to plant on (by a seam of the map's
// symmetry). abundance: how many trees, as a share of what it'd be (a new game's Resources slider; 1 as it comes): it
// scales each spot's chance and widens the forests a little, and where a spot's chance is over 1 what's over is the
// chance of a second tree in the cell, kept clear of the first.
export function plantTrees(terrain, seed = 1, avoid = null, abundance = 1) {
  let s = (seed * 2654435761) >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const T = TREE_TUNING, n = T.spacing;
  const f = T.forestScale * Math.max(1, 500 / Math.min(X, Z)) ** T.forestMapScale;
  const ox = rand() * 1000, oz = rand() * 1000; // (each seed's forests somewhere else)
  const woods = (x, z) => {
    x = x * f + ox; z = z * f + oz;
    return 0.5 + 0.5 * Math.sin(x * 0.021 + 1.3 * Math.sin(z * 0.017)) * Math.cos(z * 0.019 - 0.8 * Math.sin(x * 0.013));
  };
  const edge = T.forestEdge - 0.15 * (abundance - 1);
  let count = 0;
  const plant = (x, z, apart) => { if (plantOak(terrain, x, z, apart, rand, avoid)) count++; };
  for (let cz = 0; cz < Z; cz += n) {
    for (let cx = 0; cx < X; cx += n) {
      const x = cx + 2 + Math.floor(rand() * (n - 4)), z = cz + 2 + Math.floor(rand() * (n - 4));
      const chance = abundance * (woods(x, z) > edge ? T.density : T.lone);
      if (rand() < chance) plant(x, z, 0);
      if (chance > 1 && rand() < chance - 1) plant(cx + Math.floor(rand() * n), cz + Math.floor(rand() * n), 2);
    }
  }
  terrain.updateBricks([0, 0, 0], SIZE);
  return count;
}

// The ground height where an oak can stand at (x, z): dry land above the beaches, grass (not stone), not too steep; or
// -1.
function treeGround(terrain, x, z, avoid) {
  if (x < 3 || z < 3 || x >= X - 3 || z >= Z - 3 || avoid?.(x, z)) return -1;
  const h = terrain.groundAt(x, z);
  if (h < WATER_LEVEL + 3 || terrain.block(x, h - 1, z) !== BLOCK.GROUND) return -1;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (Math.abs(terrain.groundAt(x + dx, z + dz) - h) > 1) return -1;
  return h;
}

// Plants an oak at (x, z) if one can stand there with room overhead and no trunk within `apart` of it. Returns
// whether it did.
function plantOak(terrain, x, z, apart, rand, avoid) {
  const T = TREE_TUNING, h = treeGround(terrain, x, z, avoid);
  if (h < 0) return false;
  // The canopy's 4 layers start on the trunk's fourth log from the top, so the trunk is that much taller.
  const height = Math.round(T.trunk) + 3 + Math.floor(rand() * (Math.round(T.trunkVary) + 1));
  if (h + height + 2 >= Y) return false;
  for (let dz = -apart; dz <= apart; dz++) {
    for (let dx = -apart; dx <= apart; dx++) {
      for (let y = h - 2; y <= h + 3; y++) if (terrain.block(x + dx, y, z + dz) === BLOCK.LOG) return false;
    }
  }
  growOak(terrain, x, h, z, height, rand);
  return true;
}

// A new game: a forest near the start at (sx, sz) if it hasn't one (TREE_TUNING startTrees within startReach),
// round the spot about startDist away with the most room for trees (further where there's little), none on the Keep's
// yard. Laid out the same way
// from every start, turned to face the map's middle, so starts on a symmetric map get the same forest.
export function plantStartForest(terrain, seed, sx, sz, avoid = null) {
  const T = TREE_TUNING;
  const away = (x, z) => Math.hypot(x - sx, z - sz);
  let got = 0;
  const R = Math.ceil(T.startReach);
  for (let z = sz - R; z <= sz + R; z++) {
    for (let x = sx - R; x <= sx + R; x++) {
      if (x >= 0 && z >= 0 && x < X && z < Z && away(x, z) <= R && terrain.block(x, terrain.groundAt(x, z), z) === BLOCK.LOG) got++;
    }
  }
  if (got >= T.startTrees) return 0;
  let s = (seed * 2246822519 + 7) >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const a0 = Math.atan2((Z - 1) / 2 - sz, (X - 1) / 2 - sx), c = Math.cos(a0), n = Math.sin(a0);
  const at = (u, v) => [Math.round(sx + u * c - v * n), Math.round(sz + u * n + v * c)]; // (u towards the middle)
  let best = null, most = 0;
  for (let d = T.startDist; d <= Math.max(T.startDist, T.startReach); d += 4) {
    for (let a = 0; a < 16; a++) {
      const cu = Math.cos(a * Math.PI / 8) * d, cv = Math.sin(a * Math.PI / 8) * d;
      let room = 0;
      for (let dv = -6; dv <= 6; dv += 2) {
        for (let du = -6; du <= 6; du += 2) {
          const [x, z] = at(cu + du, cv + dv);
          if (away(x, z) >= T.startClear && treeGround(terrain, x, z, avoid) >= 0) room++;
        }
      }
      const score = room - (d - T.startDist) * 0.5; // (49 at most: nearer wins unless it's much more cramped)
      if (room && score > most) { most = score; best = [cu, cv]; }
    }
  }
  let planted = 0;
  for (let tries = 0; best && tries < 240 && got < T.startTrees; tries++) {
    const [x, z] = at(best[0] + (rand() * 2 - 1) * 7, best[1] + (rand() * 2 - 1) * 7);
    if (away(x, z) >= T.startClear && plantOak(terrain, x, z, 2, rand, avoid)) { got++; planted++; }
  }
  if (planted) terrain.updateBricks([Math.max(0, sx - 40), 0, Math.max(0, sz - 40)], [Math.min(X, sx + 41), Y, Math.min(Z, sz + 41)]);
  return planted;
}

// A Minecraft oak: a trunk `height` logs tall from (x, y, z), under a canopy of two wide layers of leaves and two
// narrow ones, with ragged corners.
function growOak(terrain, x, y, z, height, rand) {
  const v = terrain.voxels;
  const set = (px, py, pz, b) => {
    if (px < 0 || pz < 0 || py < 0 || px >= X || py >= Y || pz >= Z) return;
    const i = terrain.index(px, py, pz);
    if (b === BLOCK.LOG || v[i] === BLOCK.AIR) v[i] = b;
  };
  const top = y + height;
  for (let ly = top - 3; ly <= top; ly++) {
    const k = ly - top;
    const r = k >= -1 ? 1 : 2;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) === r && Math.abs(dz) === r && (k === 0 || rand() < 0.5)) continue;
        set(x + dx, ly, z + dz, BLOCK.LEAVES);
      }
    }
  }
  for (let ly = y; ly < top; ly++) set(x, ly, z, BLOCK.LOG);
}

// The tree a clicked block (x, y, z) belongs to: the bottom log of its trunk, as [x, y, z], or null if it isn't part
// of a tree. From a leaf, the nearest log joined to it through leaves (within leafReach) is the trunk.
export function findTrunk(terrain, x, y, z) {
  let log = null;
  const b = terrain.block(x, y, z);
  if (b === BLOCK.LOG) log = [x, y, z];
  else if (b === BLOCK.LEAVES) {
    const seen = new Set([terrain.index(x, y, z)]);
    let front = [[x, y, z]];
    for (let d = 0; d < TREE_TUNING.leafReach && front.length && !log; d++) {
      const next = [];
      for (const [px, py, pz] of front) {
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const q = [px + dx, py + dy, pz + dz];
          const qb = terrain.block(...q);
          if (qb === BLOCK.LOG) { log = q; break; }
          if (qb !== BLOCK.LEAVES || q[1] < 0) continue;
          const i = terrain.index(...q);
          if (seen.has(i)) continue;
          seen.add(i);
          next.push(q);
        }
        if (log) break;
      }
      front = next;
    }
  }
  if (!log) return null;
  while (terrain.block(log[0], log[1] - 1, log[2]) === BLOCK.LOG) log[1]--;
  return log;
}

// The forest the tree with its bottom log at trunk [x, y, z] is part of: every tree linked to it through trees whose
// trunks are within forestLink voxels of each other across the ground (up to forestMax of them), as their bottom logs,
// this one first. Worked out from the trees standing now, so one planted later joins in, and a forest cut through the
// middle falls into two.
export function forestOf(terrain, trunk) {
  const T = TREE_TUNING, R = Math.round(T.forestLink), out = [trunk];
  const seen = new Set([terrain.index(...trunk)]);
  for (let i = 0; i < out.length && out.length < T.forestMax; i++) {
    const [x, y, z] = out[i];
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz > R * R || (!dx && !dz)) continue;
        // A trunk's bottom log in that column, about this one's height (a tree on a hill a little higher).
        for (let qy = y - 5; qy <= y + 5; qy++) {
          if (terrain.block(x + dx, qy, z + dz) !== BLOCK.LOG || terrain.block(x + dx, qy - 1, z + dz) === BLOCK.LOG) continue;
          const k = terrain.index(x + dx, qy, z + dz);
          if (!seen.has(k) && out.length < T.forestMax) { seen.add(k); out.push([x + dx, qy, z + dz]); }
          break;
        }
      }
    }
  }
  return out;
}

// The logs cutting the log at (x, y, z) would fell (as fellTree finds them, without felling anything), as [x, y, z]s
// pushed to out; `seen` (voxel indices) skips logs already there.
export function trunkLogs(terrain, x, y, z, out = [], seen = new Set()) {
  const i0 = terrain.index(x, y, z);
  if (terrain.block(x, y, z) !== BLOCK.LOG || seen.has(i0)) return out;
  seen.add(i0);
  out.push([x, y, z]);
  const stack = [[x, y, z]];
  while (stack.length) {
    const [px, py, pz] = stack.pop();
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) {
      const qx = px + dx, qy = py + dy, qz = pz + dz;
      if (qy < y || terrain.block(qx, qy, qz) !== BLOCK.LOG) continue;
      const i = terrain.index(qx, qy, qz);
      if (seen.has(i)) continue;
      seen.add(i);
      out.push([qx, qy, qz]);
      stack.push([qx, qy, qz]);
    }
  }
  return out;
}

// Cuts the log at (x, y, z) and fells everything of the trunk above it (the logs joined to it at its height or
// higher); what's below stays as a stump. Terrain.onLose hears of each log (felled: true for all but the cut one);
// Terrain.onFell(cut, logs, leaves, from), if it's set, is offered the felled logs and the leaves only they held up, to
// topple over (felling.js) away from `from` (where the cutter stands, or null): when it takes them, those leaves go
// at once instead of withering. Returns the voxel box that changed, or null.
export function fellTree(terrain, x, y, z, from = null) {
  if (terrain.block(x, y, z) !== BLOCK.LOG) return null;
  const v = terrain.voxels;
  const lo = [x, y, z], hi = [x + 1, y + 1, z + 1];
  const grow = (qx, qy, qz) => {
    lo[0] = Math.min(lo[0], qx); lo[1] = Math.min(lo[1], qy); lo[2] = Math.min(lo[2], qz);
    hi[0] = Math.max(hi[0], qx + 1); hi[1] = Math.max(hi[1], qy + 1); hi[2] = Math.max(hi[2], qz + 1);
  };
  const stack = [[x, y, z]], logs = [[x, y, z]];
  v[terrain.index(x, y, z)] = BLOCK.AIR;
  terrain.onLose?.(x, y, z, BLOCK.LOG, null, false);
  while (stack.length) {
    const [px, py, pz] = stack.pop();
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) {
      const qx = px + dx, qy = py + dy, qz = pz + dz;
      if (qy < y || terrain.block(qx, qy, qz) !== BLOCK.LOG) continue;
      v[terrain.index(qx, qy, qz)] = BLOCK.AIR;
      terrain.onLose?.(qx, qy, qz, BLOCK.LOG, null, true);
      stack.push([qx, qy, qz]);
      logs.push([qx, qy, qz]);
      grow(qx, qy, qz);
    }
  }
  if (terrain.onFell) {
    const leaves = canopyOf(terrain, logs);
    if (terrain.onFell([x, y, z], logs, leaves, from)) {
      for (const [lx, ly, lz] of leaves) { v[terrain.index(lx, ly, lz)] = BLOCK.AIR; grow(lx, ly, lz); }
    }
  }
  terrain.updateBricks(lo, hi);
  return { lo, hi };
}

// The leaves the logs (just taken away) held up: those within leafReach of them (through leaves) that no other log
// reaches, as [x, y, z]s.
function canopyOf(terrain, logs) {
  const R = TREE_TUNING.leafReach, t = terrain;
  const a = [X, Y, Z], b = [0, 0, 0];
  for (const p of logs) for (let i = 0; i < 3; i++) { a[i] = Math.min(a[i], p[i] - 2 * R - 1); b[i] = Math.max(b[i], p[i] + 2 * R + 2); }
  for (let i = 0; i < 3; i++) { a[i] = Math.max(0, a[i]); b[i] = Math.min(SIZE[i], b[i]); }
  const w = b[0] - a[0], h = b[1] - a[1], d = b[2] - a[2];
  const at = (x, y, z) => x - a[0] + w * (y - a[1] + h * (z - a[2]));
  // Breadth first through leaves, out to the reach, from the given cells.
  const spread = (seeds) => {
    const dist = new Uint8Array(w * h * d).fill(255), queue = [];
    for (const [x, y, z] of seeds) { const j = at(x, y, z); dist[j] = 0; queue.push(j); }
    for (let head = 0; head < queue.length; head++) {
      const j = queue[head], nd = dist[j] + 1;
      if (nd > R) continue;
      const x = j % w, y = Math.floor(j / w) % h, z = Math.floor(j / (w * h));
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const qx = x + dx, qy = y + dy, qz = z + dz;
        if (qx < 0 || qy < 0 || qz < 0 || qx >= w || qy >= h || qz >= d) continue;
        const k = qx + w * (qy + h * qz);
        if (dist[k] <= nd || t.voxels[t.index(qx + a[0], qy + a[1], qz + a[2])] !== BLOCK.LEAVES) continue;
        dist[k] = nd;
        queue.push(k);
      }
    }
    return dist;
  };
  const mine = spread(logs);
  const others = [];
  for (let z = a[2]; z < b[2]; z++) for (let y = a[1]; y < b[1]; y++) for (let x = a[0]; x < b[0]; x++) {
    if (t.voxels[t.index(x, y, z)] === BLOCK.LOG) others.push([x, y, z]);
  }
  const held = spread(others);
  const out = [];
  for (let z = a[2]; z < b[2]; z++) for (let y = a[1]; y < b[1]; y++) for (let x = a[0]; x < b[0]; x++) {
    const j = at(x, y, z);
    if (mine[j] > 0 && mine[j] <= R && held[j] > R) out.push([x, y, z]);
  }
  return out;
}

// Leaf decay: after an edit, finds the leaves near it that no log supports any more and lets them go one by one.
export class LeafDecay {
  constructor(terrain) {
    this.terrain = terrain;
    this.due = new Map(); // voxel index -> time it goes
    this.clock = 0;
    this.rand = Math.random;
  }

  // Call after the voxels in [lo, hi) changed.
  check(lo, hi) {
    const t = this.terrain, R = TREE_TUNING.leafReach;
    // Leaves within reach of the edit may have lost their log; logs within reach of those leaves may hold them up.
    const a = lo.map((v) => Math.max(0, v - R - 1)), b = hi.map((v, i) => Math.min(SIZE[i], v + R + 1));
    const A = a.map((v) => Math.max(0, v - R)), B = b.map((v, i) => Math.min(SIZE[i], v + R));
    const w = B[0] - A[0], h = B[1] - A[1], d = B[2] - A[2];
    const dist = new Uint8Array(w * h * d).fill(255);
    const queue = [];
    let leaves = 0;
    for (let z = A[2]; z < B[2]; z++) {
      for (let y = A[1]; y < B[1]; y++) {
        for (let x = A[0]; x < B[0]; x++) {
          const blk = t.voxels[t.index(x, y, z)];
          if (blk === BLOCK.LOG) { const j = x - A[0] + w * (y - A[1] + h * (z - A[2])); dist[j] = 0; queue.push(j); }
          else if (blk === BLOCK.LEAVES) leaves++;
        }
      }
    }
    if (!leaves) return;
    // Breadth-first from the logs, through leaves, out to the reach.
    for (let head = 0; head < queue.length; head++) {
      const j = queue[head];
      const nd = dist[j] + 1;
      if (nd > R) continue;
      const x = j % w, y = Math.floor(j / w) % h, z = Math.floor(j / (w * h));
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const qx = x + dx, qy = y + dy, qz = z + dz;
        if (qx < 0 || qy < 0 || qz < 0 || qx >= w || qy >= h || qz >= d) continue;
        const k = qx + w * (qy + h * qz);
        if (dist[k] <= nd || t.voxels[t.index(qx + A[0], qy + A[1], qz + A[2])] !== BLOCK.LEAVES) continue;
        dist[k] = nd;
        queue.push(k);
      }
    }
    const T = TREE_TUNING;
    for (let z = a[2]; z < b[2]; z++) {
      for (let y = a[1]; y < b[1]; y++) {
        for (let x = a[0]; x < b[0]; x++) {
          const i = t.index(x, y, z);
          if (t.voxels[i] !== BLOCK.LEAVES || this.due.has(i)) continue;
          if (dist[x - A[0] + w * (y - A[1] + h * (z - A[2]))] <= R) continue;
          this.due.set(i, this.clock + T.decayMin + this.rand() * (T.decayMax - T.decayMin));
        }
      }
    }
  }

  // Removes the leaves whose time has come. Returns the voxel boxes that changed (one per leaf).
  update(dt) {
    this.clock += dt;
    const out = [];
    if (!this.due.size) return out;
    const t = this.terrain;
    for (const [i, when] of this.due) {
      if (when > this.clock) continue;
      this.due.delete(i);
      if (t.voxels[i] !== BLOCK.LEAVES) continue;
      t.voxels[i] = BLOCK.AIR;
      const x = i % X, y = Math.floor(i / X) % Y, z = Math.floor(i / (X * Y));
      const lo = [x, y, z], hi = [x + 1, y + 1, z + 1];
      t.updateBricks(lo, hi);
      out.push({ lo, hi });
    }
    return out;
  }
}
