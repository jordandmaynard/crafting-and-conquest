// The voxel world on the CPU: one byte per voxel, its block type (BLOCK: air, leaves, log or ground; SOLID_MIN and
// up is solid, which all but air are), indexed x + X * (y + Y * z) with y up,
// the same layout as the GPU's 3D textures. The CPU owns the voxels: brushes edit them here, the edited box is
// uploaded, and the GPU rebuilds the signed distance field over just that box (see sdf.js).
//
// Bricks of 8³ voxels summarise the grid for the raymarcher. A brick is a "surface" brick when it or one of its
// 26 neighbours holds both air and solid, or two of them differ; every other brick is far enough from the surface
// that its distances are all clamped (SDF_RANGE < BRICK). Each brick stores its Chebyshev distance, in bricks, to
// the nearest surface brick (0 = surface, capped at MAX_BRICK_DIST), which lets rays skip whole runs of empty bricks.

// The map's size, [x, y (up), z]. A new game's setup picks one (#map=small, medium, large or huge in the page's address,
// read here before anything else is made: everything sized by the map follows SIZE); otherwise 500 × 100 × 500.
export const MAP_SIZES = { small: [128, 128, 128], medium: [256, 128, 256], large: [512, 128, 512], huge: [1024, 128, 1024] };
export const SIZE = (() => {
  const m = /(?:^#|&)map=(\w+)/.exec(globalThis.location?.hash ?? '');
  return (m && MAP_SIZES[m[1]]?.slice()) || [500, 100, 500];
})();
export const BRICK = 8;
export const BRICKS = SIZE.map((n) => Math.ceil(n / BRICK));
export const SDF_RANGE = 3; // voxels: distances are clamped to ±this
export const MAX_BRICK_DIST = 6; // bricks: brick distances are capped here, which bounds how far an edit reaches

// Fireball blasts (see Terrain.scorch): a ring of the last MAX_BLASTS, and for each half-resolution cell (2³ voxels)
// the last BLAST_SLOTS of them that reach it.
export const HALF = SIZE.map((n) => Math.ceil(n / 2));
export const MAX_BLASTS = 4096;
export const BLAST_SLOTS = 4;
export const SOLID_MIN = 128; // block value at which a voxel counts as solid
// Block types. Ground is grass, dirt or sand by where it is (the renderer decides); stone is stone everywhere; trees
// are logs and leaves; what villagers build is planks and bricks. Ground and stone (TERRAIN_MIN and up) make up the land; trees stand on it.
// Iron and gold ore are stone with metal in it, here and there in the stone (ORE_TUNING): mined, they're currency,
// never built with. Obsidian is the wall round the map's edge (Terrain.wall): nothing breaks it. Farm is ground a
// worker has tilled into rows for wheat (see farm.js): dirt on its sides, the tilled rows on top; dug, it's dirt.
// Clay is dirt a villager has put down (filled in or built with): rounded clay bricks, built like bricks and planks
// (not the land: no grass grows on it, it can't be farmed).
export const BLOCK = { AIR: 0, LEAVES: 160, LOG: 192, PLANK: 208, BRICK: 216, CLAY: 220, STONE: 224, IRON: 232, GOLD: 240, OBSIDIAN: 248, FARM: 250, GROUND: 255 };
export const isOre = (b) => b === BLOCK.IRON || b === BLOCK.GOLD;
// Who built what: per column, the team that last put a block down in it (Terrain.owners; 0 none), for the renderer's
// team tints on bricks, clay and planks (render.js BLOCK_TUNING).
export const OWNER = { blue: 1, red: 2, yellow: 3, purple: 4 };
export const TERRAIN_MIN = BLOCK.STONE;
// The map's edge: the ring of columns the obsidian wall stands in (no order works on them).
export const isEdge = (x, z) => x <= 0 || z <= 0 || x >= SIZE[0] - 1 || z >= SIZE[2] - 1;
export const WALL_ABOVE = 2; // voxels the wall stands over the ground next to it, or over the water, whichever's higher
export const WATER_LEVEL = 10;

// Where stone shows up: blobs of 3D value noise, scale voxels across (scaleY tall), wherever the noise is over the
// threshold; the threshold drops by `deeper` per voxel below the surface (down to ten) and by `highUp` per voxel of
// height above 30, so there's more stone underground and on the high ridges.
// Ore in the stone: small veins of 3D value noise (scale voxels across) over each threshold; gold's are rarer, and
// more of it deeper down (its threshold drops by goldDeeper per voxel below the surface, down to ten). Read when the
// world's made.
export const ORE_TUNING = { scale: 4.5, iron: 0.8, gold: 0.875, goldDeeper: 0.003 };
export const STONE_TUNING = { scale: 26, scaleY: 12, threshold: 0.66, deeper: 0.02, highUp: 0.004 }; // height of the still water surface (the waves move about it)
// Land at a new game's starts: within radius (a share of the map's width) of each start (and its turned copies) the
// ground's lifted to at least rise over the shore (in elevation, about 3 voxels over the water; see generate), wholly
// within core of that and fading out to the edge, so every start is on land of its own and any land bridge (see
// landBridge) is laid out away from them. Read when the world's made.
export const START_LAND = { radius: 0.14, core: 0.7, rise: 0.08 };
const EMPTY = 0, SOLID = 1, MIXED = 2;

export class Terrain {
  constructor() {
    const [X, Y, Z] = SIZE;
    this.voxels = new Uint8Array(X * Y * Z);
    // Char: 255 for each voxel a fireball has charred (see scorch.js). Blocks put down later start clean.
    this.char = new Uint8Array(X * Y * Z);
    // Owners: per column (x + X * z), the team that built there (OWNER, 0 none); ownersVersion bumped on a change.
    this.owners = new Uint8Array(X * Z);
    this.ownersVersion = 0;
    this.ownAs = null;
    // The blasts: per blast (centre, char reach), (the way the fireball flew, its mark's turn 0..1); number 0 is
    // never used (an empty slot). blastCells: per half-res cell, BLAST_SLOTS blast numbers (0 = none).
    this.blastList = new Float32Array(MAX_BLASTS * 8);
    this.blastCells = new Uint16Array(HALF[0] * HALF[1] * HALF[2] * BLAST_SLOTS);
    this.blastCount = 0; // blasts so far
    // (x, y, z, block, from): called for each solid voxel an edit takes away (dug, blown up, felled); from: the
    // blast's centre, or null. For the debris that flies off it (see debris.js).
    this.onLose = null;
    const [BX, BY, BZ] = BRICKS;
    this.brickState = new Uint8Array(BX * BY * BZ);
    this.brickDist = new Uint8Array(BX * BY * BZ);
    this.brickSurface = new Uint8Array(BX * BY * BZ);
  }

  // Column (x, z) is team's: it built there (see owners). Unless ownAs is set (an OWNER number, 0 for none: the
  // Editor's Team switch), when it's that.
  own(x, z, team) {
    const c = this.ownAs ?? OWNER[team] ?? 0, k = x + SIZE[0] * z;
    if ((c || this.ownAs === 0) && this.owners[k] !== c) { this.owners[k] = c; this.ownersVersion++; }
  }
  // Everything built is team's (null: none, plain), and what's built from now on (see ownAs).
  ownAll(team) {
    this.ownAs = OWNER[team] ?? 0;
    this.owners.fill(this.ownAs);
    this.ownersVersion++;
  }

  index(x, y, z) {
    return x + SIZE[0] * (y + SIZE[1] * z);
  }

  solid(x, y, z) {
    if (x < 0 || z < 0 || y >= SIZE[1] || x >= SIZE[0] || z >= SIZE[2]) return false;
    if (y < 0) return true;
    return this.voxels[this.index(x, y, z)] >= SOLID_MIN;
  }

  // Flat ground with its top at height h, no stone (the editor's world).
  flat(h) {
    const [X, Y, Z] = SIZE;
    this.voxels.fill(BLOCK.AIR);
    this.char.fill(0);
    for (let z = 0; z < Z; z++) {
      for (let y = 0; y < Math.min(h, Y - 1); y++) this.voxels.fill(BLOCK.GROUND, this.index(0, y, z), this.index(0, y, z) + X);
    }
    this.wall();
    this.updateBricks([0, 0, 0], SIZE);
  }

  // The wall round the map: every edge column obsidian from the bottom to WALL_ABOVE over the highest ground next to it
  // (the columns in from it, corners included) or over the water, whichever's higher, and nothing above that (a tree
  // that stood there is gone). Made with the world (generate, mirror, flat), which updates the bricks after.
  wall() {
    const [X, Y, Z] = SIZE, v = this.voxels;
    const edges = [];
    for (let x = 0; x < X; x++) edges.push([x, 0], [x, Z - 1]);
    for (let z = 1; z < Z - 1; z++) edges.push([0, z], [X - 1, z]);
    const tops = edges.map(([x, z]) => {
      let g = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, nz = z + dz;
          if (nx >= 0 && nz >= 0 && nx < X && nz < Z && !isEdge(nx, nz)) g = Math.max(g, this.groundAt(nx, nz));
        }
      }
      return Math.min(Y - 1, Math.max(g, WATER_LEVEL) + WALL_ABOVE);
    });
    edges.forEach(([x, z], k) => {
      for (let y = 0; y < Y; y++) v[this.index(x, y, z)] = y < tops[k] ? BLOCK.OBSIDIAN : BLOCK.AIR;
    });
  }

  // Rolling hills with a few ridges, lakes and coast, from a seeded heightmap.
  // sym: the symmetry the map will have ('none', 'x', 'z' or 'both', see mirror): the noise is blended with its own
  // turned copies over a band SYM_BAND voxels either side of each seam, so the land runs on smoothly across it (no
  // cliff where the two halves meet). Columns wholly on a far side are left for mirror() to fill.
  // opts (a new game's setup): mountains, how high the land rises over the water (1 as it comes); water, the share
  // of the map under the water (0-1; null as it comes, about a third); bridge, with starts (the [x, z] each team's
  // start is looked for at, the player's first): land made so there's a way on foot from each start to every other
  // (see landBridge), and land lifted round each start (START_LAND). All of them keep the map's symmetry. resources: how much iron and gold, as a share of what
  // there'd be (the Resources slider; 1 as it comes; the trees go with it, see plantTrees).
  generate(seed = 1, sym = 'none', { mountains = 1, water = null, bridge = false, starts = [], resources = 1 } = {}) {
    const [X, Y, Z] = SIZE;
    const taps = symTaps(sym);
    const noise = valueNoise2(seed);
    const stoneNoise = valueNoise3(seed + 101);
    const ironNoise = valueNoise3(seed + 202), goldNoise = valueNoise3(seed + 303);
    const S = STONE_TUNING, O = ORE_TUNING;
    const fbm = (x, z, oct) => {
      let s = 0, a = 0.5, f = 1;
      for (let i = 0; i < oct; i++) {
        s += a * noise(x * f, z * f);
        f *= 2.03;
        a *= 0.5;
      }
      return s;
    };
    // Each column's elevation (about -0.2..1, 0 the sea floor's edge) and ridge (0-1), from the noise...
    const elevation = (x, z) => (fbm(x / 160, z / 160, 5) - 0.38) / 0.42;
    const ridgeAt = (x, z) => 1 - Math.abs(2 * noise(x / 90 + 17, z / 90 - 9) - 1);
    // ...make its height. As it comes, the low ground (about a third of the map) sits under the water at WATER_LEVEL.
    const shape = (e, ridge) => {
      const b = Math.min(1, Math.max(0, e));
      return 3 + 14 * b + 30 * b * b + 22 * ridge * ridge * ridge * b * b;
    };
    const SHORE = (-14 + Math.sqrt(14 * 14 + 120 * (WATER_LEVEL + 0.5 - 3))) / 60; // (shape(SHORE, 0) = WATER_LEVEL + 0.5)
    // Land at the starts (START_LAND): how much a column's lifted (0-1), and an elevation lifted by it.
    const L = START_LAND, reach = Math.max(16, L.radius * Math.min(X, Z)), core = reach * Math.min(Math.max(L.core, 0), 0.99);
    const landAt = starts.flatMap(([x, z]) => symImages(sym, x, z));
    const liftAt = (x, z) => {
      let l = 0;
      for (const [px, pz] of landAt) {
        const t = Math.min(1, Math.max(0, (reach - Math.hypot(x - px, z - pz)) / (reach - core)));
        l = Math.max(l, t * t * (3 - 2 * t));
      }
      return l;
    };
    const lifted = (e, l) => (l > 0 ? e + Math.max(0, SHORE + L.rise - e) * l : e);
    // Water coverage: elevations bent (piecewise linearly) so that `water` of the map is under the water: eq goes to
    // SHORE, where the land comes half a voxel over the water (so at 0% even the lowest ground is dry; the land at the
    // starts counted as lifted). The highest
    // goes to at least SHORE + RELIEF, so a map whose noise came out low all over (a small map can) still rises out of
    // the water instead of all sinking under it. eq's found by halving, over every few columns.
    let bend = (e) => e;
    if (water !== null) {
      const RELIEF = 0.5, step = Math.max(1, Math.round(Math.min(X, Z) / 160)), samples = [];
      let lo = Infinity, hi = -Infinity;
      for (let z = 0; z < Z; z += step) {
        for (let x = 0; x < X; x += step) {
          const t = taps(x, z);
          if (!t) continue;
          const at = t.map(([w, sx, sz]) => [w, elevation(sx, sz), ridgeAt(sx, sz), liftAt(sx, sz)]);
          for (const [, e] of at) { lo = Math.min(lo, e); hi = Math.max(hi, e); }
          samples.push(at);
        }
      }
      const low = Math.min(lo, SHORE - 0.2), top = Math.max(hi, SHORE + RELIEF);
      const bent = (eq) => (e) => (e < eq
        ? SHORE + (e - eq) * (SHORE - low) / Math.max(eq - lo, 1e-6)
        : SHORE + (e - eq) * (top - SHORE) / Math.max(hi - eq, 1e-6));
      const share = (f) => {
        let wet = 0;
        for (const at of samples) {
          let h = 0;
          for (const [w, e, r, l] of at) h += w * shape(lifted(f(e), l), r);
          if (Math.round(h) < WATER_LEVEL) wet++;
        }
        return wet / Math.max(samples.length, 1);
      };
      const want = Math.min(1, Math.max(0, water));
      let a = lo, b = hi;
      for (let i = 0; i < 24; i++) {
        const m = (a + b) / 2;
        if (share(bent(m)) < want) a = m; else b = m;
      }
      bend = bent((a + b) / 2);
    }
    // The heightmap: worked out where generated (see taps), copied round where mirror() will copy the columns, so
    // it's as symmetrical as the voxels will be (and a land bridge can be laid over it before they're filled).
    const tops = new Float32Array(X * Z);
    for (let z = 0; z < Z; z++) {
      for (let x = 0; x < X; x++) {
        const t = taps(x, z);
        if (!t) continue;
        let h = 0;
        for (const [w, sx, sz] of t) h += w * shape(lifted(bend(elevation(sx, sz)), liftAt(sx, sz)), ridgeAt(sx, sz));
        if (h > WATER_LEVEL) h = WATER_LEVEL + (h - WATER_LEVEL) * Math.max(0, mountains); // Mountainous
        tops[x + X * z] = Math.round(Math.min(Y - 8, Math.max(2, h)));
      }
    }
    const from = mirrorSource(sym);
    for (let z = 0; z < Z; z++) {
      for (let x = 0; x < X; x++) {
        const s = from(x, z);
        if (s) tops[x + X * z] = tops[s[0] + X * s[1]];
      }
    }
    // Land bridges: columns raised or cut so that every start can be walked to, their tops plain ground.
    this.bridged = new Uint8Array(X * Z);
    if (bridge && starts.length > 1) landBridge(tops, this.bridged, starts, sym);

    const stoneAt = (x, y, z) => stoneNoise(x / S.scale, y / S.scaleY, z / S.scale) * 0.7 + stoneNoise(x / S.scale * 2.7 + 31, y / S.scaleY * 2.7, z / S.scale * 2.7) * 0.3;
    const r = O.scale;
    const goldAt = (x, y, z) => goldNoise(x / r, y / r, z / r), ironAt = (x, y, z) => ironNoise(x / r, y / r, z / r);
    // The thresholds moved so `resources` times as much of the stone is over them (gold's for each depth; iron's a
    // little more, as it's only where gold isn't, and there's more gold too).
    const goldOver = abundant(goldNoise, resources), g = goldOver.share(O.gold - O.goldDeeper * 5);
    const ironOver = abundant(ironNoise, resources * (1 - g) / Math.max(0.05, 1 - g * resources));
    const ironT = ironOver(O.iron), goldT = Array.from({ length: 11 }, (_, d) => goldOver(O.gold - O.goldDeeper * d));
    for (let z = 0; z < Z; z++) {
      for (let x = 0; x < X; x++) {
        const t = taps(x, z); // [[weight, x, z]]: the noise here, blended over the seams (see symTaps)
        if (!t) continue;     // (all on a far side: mirror() fills it)
        const mix = (f, y) => { let v = 0; for (const [w, sx, sz] of t) v += w * f(sx, y, sz); return v; };
        const top = tops[x + X * z], bridged = this.bridged[x + X * z];
        for (let y = 0; y < top; y++) {
          // Stone in blobs of 3D noise, more of it the deeper down, and where a blob reaches the top, an outcrop.
          const depth = top - 1 - y;
          const n = mix(stoneAt, y);
          const stone = n > S.threshold - S.deeper * Math.min(depth, 10) - S.highUp * Math.max(0, top - 30);
          let b = stone && !(bridged && depth < 2) ? BLOCK.STONE : BLOCK.GROUND;
          if (b === BLOCK.STONE && y >= WATER_LEVEL) { // (no ore below sea level: seen under the water, but never minable)
            if (mix(goldAt, y) > goldT[Math.min(depth, 10)]) b = BLOCK.GOLD;
            else if (mix(ironAt, y) > ironT) b = BLOCK.IRON;
          }
          this.voxels[this.index(x, y, z)] = b;
        }
      }
    }
    this.wall();
    this.updateBricks([0, 0, 0], SIZE);
  }

  // Whether column (x, z) is near a seam of symmetry sym (within d voxels), where trees aren't planted (mirror()
  // would cut them in two).
  static nearSeam(sym, x, z, d = 4) {
    const cx = (SIZE[0] - 1) / 2, cz = (SIZE[2] - 1) / 2;
    return ((sym === 'x' || sym === 'both') && Math.abs(x - cx) < d) || ((sym === 'z' || sym === 'both') && Math.abs(z - cz) < d);
  }

  // Makes the map symmetrical the way League of Legends' map is: one part copied round the middle, turned rather than
  // just reflected, so each start's ground is the same as the one opposite. 'x' or 'z': the far half (across x, or
  // across z) is the near half turned half round, so opposite corners match; 'both': each quarter is the first
  // turned a quarter round more (the map's square), so all four corners match.
  mirror(axes) {
    const [X, Y, Z] = SIZE, v = this.voxels, XY = X * Y;
    const column = (x, z, sx, sz) => { // (x, z)'s column becomes a copy of (sx, sz)'s
      const d = x + XY * z, s0 = sx + XY * sz;
      for (let y = 0; y < Y; y++) v[d + X * y] = v[s0 + X * y];
    };
    if (axes === 'x' || axes === 'z') {
      for (let z = 0; z < Z; z++) {
        for (let x = 0; x < X; x++) {
          if ((axes === 'x' ? x < Math.ceil(X / 2) : z < Math.ceil(Z / 2))) continue;
          column(x, z, X - 1 - x, Z - 1 - z);
        }
      }
    } else if (axes === 'both' && X === Z) {
      // Each column outside the first quarter, from the one it's turned from: back a quarter turn at a time,
      // (x, z) -> (z, N - 1 - x), until it's in the first quarter (x and z under half).
      const N = X, h = Math.ceil(N / 2);
      for (let z = 0; z < Z; z++) {
        for (let x = 0; x < X; x++) {
          if (x < h && z < h) continue;
          let sx = x, sz = z;
          for (let k = 0; k < 3 && !(sx < h && sz < h); k++) [sx, sz] = [sz, N - 1 - sx];
          if (sx < h && sz < h) column(x, z, sx, sz);
        }
      }
    }
    this.wall(); // (again: its columns were copied too, but the ground beside them may not have been)
    this.updateBricks([0, 0, 0], SIZE);
  }

  // The block at (x, y, z): BLOCK.AIR outside the map, BLOCK.GROUND below it.
  block(x, y, z) {
    if (x < 0 || z < 0 || y >= SIZE[1] || x >= SIZE[0] || z >= SIZE[2]) return BLOCK.AIR;
    if (y < 0) return BLOCK.GROUND;
    return this.voxels[this.index(x, y, z)];
  }

  // Top of the highest ground or stone voxel in a column (0 if there's none): trees don't count.
  groundAt(x, z) {
    x = Math.floor(x);
    z = Math.floor(z);
    if (x < 0 || z < 0 || x >= SIZE[0] || z >= SIZE[2]) return 0;
    for (let y = SIZE[1] - 1; y >= 0; y--) if (this.voxels[this.index(x, y, z)] >= TERRAIN_MIN) return y + 1;
    return 0;
  }

  // Top of the highest solid voxel in a column (0 if the column is empty).
  heightAt(x, z) {
    x = Math.floor(x);
    z = Math.floor(z);
    if (x < 0 || z < 0 || x >= SIZE[0] || z >= SIZE[2]) return 0;
    for (let y = SIZE[1] - 1; y >= 0; y--) if (this.voxels[this.index(x, y, z)] >= SOLID_MIN) return y + 1;
    return 0;
  }

  // Fills the air in a sphere with ground (add), or carves everything in it out (!add), but what keep(x, y, z) says to
  // leave. Returns the voxel box [lo, hi) that changed, or null.
  applySphere(center, radius, add, keep = null) {
    const lo = [0, 0, 0], hi = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.max(0, Math.floor(center[a] - radius));
      hi[a] = Math.min(SIZE[a], Math.ceil(center[a] + radius) + 1);
      if (lo[a] >= hi[a]) return null;
    }
    const r2 = radius * radius;
    let changed = false;
    const cl = [SIZE[0], SIZE[1], SIZE[2]], ch = [0, 0, 0];
    for (let z = lo[2]; z < hi[2]; z++) {
      const dz = z + 0.5 - center[2];
      for (let y = Math.max(lo[1], 1); y < hi[1]; y++) { // the bottom layer is bedrock: never carved
        const dy = y + 0.5 - center[1];
        for (let x = lo[0]; x < hi[0]; x++) {
          const dx = x + 0.5 - center[0];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2) continue;
          const i = this.index(x, y, z);
          const old = this.voxels[i];
          const value = add ? (old >= SOLID_MIN ? old : BLOCK.GROUND) : BLOCK.AIR;
          if (value === old || old === BLOCK.OBSIDIAN || keep?.(x, y, z)) continue; // (the wall: never)
          this.voxels[i] = value;
          if (value >= SOLID_MIN) this.char[i] = 0;
          else this.onLose?.(x, y, z, old, center);
          changed = true;
          if (x < cl[0]) cl[0] = x; if (x + 1 > ch[0]) ch[0] = x + 1;
          if (y < cl[1]) cl[1] = y; if (y + 1 > ch[1]) ch[1] = y + 1;
          if (z < cl[2]) cl[2] = z; if (z + 1 > ch[2]) ch[2] = z + 1;
        }
      }
    }
    if (!changed) return null;
    this.updateBricks(cl, ch);
    return { lo: cl, hi: ch };
  }

  // A fireball's char round `center`, a sphere of `reach`: every voxel any part of which is inside is marked charred
  // (the shader works out the char from the distance to the blast's centre), and the blast is listed in every cell
  // it reaches, taking the slot of the oldest there when they're full. dir: the way the fireball was flying (a unit
  // vector); spin: the turn of its mark (0..1). Returns the voxel box it covered and the blast's number, or null.
  scorch(center, reach, dir = [0, -1, 0], spin = 0) {
    const pad = reach + 1.74; // a half-res cell's half diagonal past the reach
    const lo = [0, 0, 0], hi = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.max(0, Math.floor(center[a] - pad));
      hi[a] = Math.min(SIZE[a], Math.ceil(center[a] + pad) + 1);
      if (lo[a] >= hi[a]) return null;
    }
    for (let z = lo[2]; z < hi[2]; z++) {
      for (let y = lo[1]; y < hi[1]; y++) {
        for (let x = lo[0]; x < hi[0]; x++) {
          // (√3 / 2: half a voxel's diagonal, so a voxel only its corner reaches into counts.)
          if (Math.hypot(x + 0.5 - center[0], y + 0.5 - center[1], z + 0.5 - center[2]) > reach + 0.87) continue;
          this.char[this.index(x, y, z)] = 255;
        }
      }
    }
    const index = this.blastCount % (MAX_BLASTS - 1) + 1;
    this.blastCount++;
    this.blastList.set([...center, reach, ...dir, spin % 1], index * 8);
    // How old a listed blast is: the ring's numbers count up from the newest's, wrapping.
    const age = (k) => (index - k + MAX_BLASTS - 1) % (MAX_BLASTS - 1);
    const [HX, HY] = HALF, cells = this.blastCells, S = BLAST_SLOTS;
    for (let hz = lo[2] >> 1; hz < (hi[2] + 1) >> 1; hz++) {
      for (let hy = lo[1] >> 1; hy < (hi[1] + 1) >> 1; hy++) {
        for (let hx = lo[0] >> 1; hx < (hi[0] + 1) >> 1; hx++) {
          if (Math.hypot(center[0] - (2 * hx + 1), center[1] - (2 * hy + 1), center[2] - (2 * hz + 1)) > pad) continue;
          const j = S * (hx + HX * (hy + HY * hz));
          let slot = 0;
          for (let k = 0; k < S; k++) {
            const n = cells[j + k];
            if (n === 0 || n === index) { slot = k; break; }
            if (age(n) > age(cells[j + slot])) slot = k;
          }
          cells[j + slot] = index;
        }
      }
    }
    return { lo, hi, index };
  }

  // Sets one voxel's block (a villager digging or placing dirt). Returns the voxel box that changed, or null.
  setVoxel(x, y, z, fill) {
    if (x < 0 || z < 0 || y < 1 || x >= SIZE[0] || y >= SIZE[1] || z >= SIZE[2]) return null; // never the bedrock
    const i = this.index(x, y, z);
    const old = this.voxels[i];
    if (old === fill || old === BLOCK.OBSIDIAN) return null; // (the wall: never)
    this.voxels[i] = fill;
    if (fill >= SOLID_MIN) this.char[i] = 0;
    else if (old >= SOLID_MIN) this.onLose?.(x, y, z, old, null);
    const lo = [x, y, z], hi = [x + 1, y + 1, z + 1];
    this.updateBricks(lo, hi);
    return { lo, hi };
  }

  // Removes voxel (x, y, z) and drops everything above it in the column down one (a villager undercutting a
  // pillar). Returns the voxel box that changed, or null.
  slumpColumn(x, y, z) {
    if (x < 0 || z < 0 || y < 1 || x >= SIZE[0] || y >= SIZE[1] || z >= SIZE[2]) return null;
    const v = this.voxels;
    let top = SIZE[1] - 1;
    while (top > y && v[this.index(x, top, z)] === 0) top--;
    for (let yy = y; yy <= top; yy++) if (v[this.index(x, yy, z)] === BLOCK.OBSIDIAN) return null; // (the wall: never)
    if (v[this.index(x, y, z)] >= SOLID_MIN) this.onLose?.(x, y, z, v[this.index(x, y, z)], null);
    const c = this.char;
    for (let yy = y; yy < top; yy++) {
      v[this.index(x, yy, z)] = v[this.index(x, yy + 1, z)];
      c[this.index(x, yy, z)] = c[this.index(x, yy + 1, z)];
    }
    v[this.index(x, top, z)] = 0;
    const lo = [x, y, z], hi = [x + 1, top + 1, z + 1];
    this.updateBricks(lo, hi);
    return { lo, hi };
  }

  // Recomputes the state of every brick touching the voxel box [lo, hi), then every brick's distance.
  updateBricks(lo, hi) {
    const [X, Y, Z] = SIZE;
    const [BX, BY] = BRICKS;
    const b0 = lo.map((v) => Math.floor(v / BRICK));
    const b1 = hi.map((v) => Math.ceil(v / BRICK));
    for (let bz = b0[2]; bz < b1[2]; bz++) {
      for (let by = b0[1]; by < b1[1]; by++) {
        for (let bx = b0[0]; bx < b1[0]; bx++) {
          let seen = 0; // bit 0: air, bit 1: solid
          for (let z = bz * BRICK; z < Math.min(Z, bz * BRICK + BRICK) && seen !== 3; z++) {
            for (let y = by * BRICK; y < Math.min(Y, by * BRICK + BRICK); y++) {
              const row = this.index(0, y, z);
              for (let x = bx * BRICK; x < Math.min(X, bx * BRICK + BRICK); x++) seen |= this.voxels[row + x] >= SOLID_MIN ? 2 : 1;
            }
          }
          this.brickState[bx + BX * (by + BY * bz)] = seen === 3 ? MIXED : seen === 2 ? SOLID : EMPTY;
        }
      }
    }
    this.updateBrickDistances(b0, b1);
  }

  // Surface flags for bricks in [b0, b1) ± 1, then distances wherever those flags can reach. Distances are capped
  // at MAX_BRICK_DIST, so an edit only changes them within that many bricks of the bricks it touched, and only that
  // box is recomputed (from surface bricks up to the cap beyond it, so it stays exact).
  updateBrickDistances(b0, b1) {
    const [BX, BY, BZ] = BRICKS;
    const N = BRICKS;
    const st = this.brickState, surf = this.brickSurface, dist = this.brickDist;
    const K = MAX_BRICK_DIST;
    const box = (lo, hi, pad) => [lo.map((v) => Math.max(0, v - pad)), hi.map((v, a) => Math.min(N[a], v + pad))];
    const [f0, f1] = box(b0, b1, 1);
    for (let bz = f0[2]; bz < f1[2]; bz++) {
      for (let by = f0[1]; by < f1[1]; by++) {
        for (let bx = f0[0]; bx < f1[0]; bx++) {
          const i = bx + BX * (by + BY * bz);
          const s = st[i];
          let surface = s === MIXED;
          for (let dz = -1; dz <= 1 && !surface; dz++) {
            const z = bz + dz;
            if (z < 0 || z >= BZ) continue;
            for (let dy = -1; dy <= 1 && !surface; dy++) {
              const y = by + dy;
              if (y < 0 || y >= BY) continue;
              for (let dx = -1; dx <= 1; dx++) {
                const x = bx + dx;
                if (x < 0 || x >= BX) continue;
                if (st[x + BX * (y + BY * z)] !== s) { surface = true; break; }
              }
            }
          }
          surf[i] = surface ? 1 : 0;
        }
      }
    }
    // d0..d1: the bricks whose distance can change; e0..e1: the surface bricks that can reach them.
    const [d0, d1] = box(f0, f1, K);
    const [e0, e1] = box(d0, d1, K);
    const ex = e1[0] - e0[0], ey = e1[1] - e0[1], ez = e1[2] - e0[2];
    const n = ex * ey * ez;
    if (!this.scratch || this.scratch.length < n) {
      this.scratch = new Uint8Array(n);
      this.queue = new Int32Array(n);
    }
    const local = this.scratch, q = this.queue;
    local.fill(K, 0, n);
    let head = 0, tail = 0;
    for (let z = 0; z < ez; z++) {
      for (let y = 0; y < ey; y++) {
        for (let x = 0; x < ex; x++) {
          if (!surf[x + e0[0] + BX * (y + e0[1] + BY * (z + e0[2]))]) continue;
          const j = x + ex * (y + ey * z);
          local[j] = 0;
          q[tail++] = j;
        }
      }
    }
    // Breadth-first over the 26-neighbourhood gives Chebyshev distance.
    while (head < tail) {
      const j = q[head++];
      const d = local[j] + 1;
      if (d >= K) continue;
      const x0 = j % ex, y0 = Math.floor(j / ex) % ey, z0 = Math.floor(j / (ex * ey));
      for (let dz = -1; dz <= 1; dz++) {
        const z = z0 + dz;
        if (z < 0 || z >= ez) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const y = y0 + dy;
          if (y < 0 || y >= ey) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const x = x0 + dx;
            if (x < 0 || x >= ex) continue;
            const k = x + ex * (y + ey * z);
            if (local[k] > d) {
              local[k] = d;
              q[tail++] = k;
            }
          }
        }
      }
    }
    for (let z = d0[2]; z < d1[2]; z++) {
      for (let y = d0[1]; y < d1[1]; y++) {
        for (let x = d0[0]; x < d1[0]; x++) {
          dist[x + BX * (y + BY * z)] = local[x - e0[0] + ex * (y - e0[1] + ey * (z - e0[2]))];
        }
      }
    }
  }

  // First solid voxel along a ray (voxel units), by DDA. Returns { t, point, normal } or null.
  raycast(ro, rd, maxT = 4000) {
    // Clip the ray to the world box first; below y = 0 counts as solid.
    let t0 = 0, t1 = maxT;
    let n0 = [0, 1, 0];
    for (let a = 0; a < 3; a++) {
      const lo = a === 1 ? -1 : 0, hi = SIZE[a];
      if (Math.abs(rd[a]) < 1e-9) {
        if (ro[a] < lo || ro[a] > hi) return null;
        continue;
      }
      let ta = (lo - ro[a]) / rd[a], tb = (hi - ro[a]) / rd[a];
      let sign = -1;
      if (ta > tb) { [ta, tb] = [tb, ta]; sign = 1; }
      if (ta > t0) { t0 = ta; n0 = [0, 0, 0]; n0[a] = sign; }
      t1 = Math.min(t1, tb);
    }
    if (t0 > t1) return null;
    const eps = 1e-4;
    const p = [ro[0] + rd[0] * (t0 + eps), ro[1] + rd[1] * (t0 + eps), ro[2] + rd[2] * (t0 + eps)];
    const v = p.map(Math.floor);
    const step = rd.map((d) => (d > 0 ? 1 : -1));
    const tDelta = rd.map((d) => (Math.abs(d) < 1e-9 ? Infinity : Math.abs(1 / d)));
    const tMax = [0, 1, 2].map((a) => {
      if (Math.abs(rd[a]) < 1e-9) return Infinity;
      const edge = rd[a] > 0 ? v[a] + 1 : v[a];
      return t0 + eps + (edge - p[a]) / rd[a];
    });
    let t = t0, normal = n0;
    for (let i = 0; i < 2048 && t <= t1; i++) {
      if (this.solid(v[0], v[1], v[2])) {
        return { t, point: [ro[0] + rd[0] * t, ro[1] + rd[1] * t, ro[2] + rd[2] * t], normal };
      }
      const a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      t = tMax[a];
      tMax[a] += tDelta[a];
      v[a] += step[a];
      normal = [0, 0, 0];
      normal[a] = -step[a];
    }
    return null;
  }
}

// Seeded 2D value noise with smoothstep interpolation, 0..1.
function valueNoise2(seed) {
  const N = 256;
  const perm = new Uint16Array(N * 2);
  const vals = new Float32Array(N);
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < N; i++) { perm[i] = i; vals[i] = rand(); }
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < N; i++) perm[N + i] = perm[i];
  const h = (x, z) => vals[perm[perm[x & 255] + (z & 255)]];
  return (x, z) => {
    const xi = Math.floor(x), zi = Math.floor(z);
    const fx = x - xi, fz = z - zi;
    const u = fx * fx * (3 - 2 * fx), w = fz * fz * (3 - 2 * fz);
    const a = h(xi, zi), b = h(xi + 1, zi), c = h(xi, zi + 1), d = h(xi + 1, zi + 1);
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  };
}

// 3D value noise in [0, 1), smooth (smoothstep-interpolated) between integer lattice points.
// Symmetry's blend (see Terrain.generate): for column (x, z), the columns whose noise makes it up, [[weight, x, z]],
// or null where its own weight is nothing (wholly on a far side). The map's turns (half round for 'x' or 'z', quarter
// turns for 'both') each take a share: a column's own share is 1 well inside the first half or quarter, 0 well
// outside it and a smoothstep across SYM_BAND voxels either side of each seam, and the shares are the same for
// each turned copy of a column, so the blend is symmetrical and runs on smoothly over the seams.
export const SYM_BAND = 24;
function symTaps(sym) {
  const [X, , Z] = SIZE, cx = (X - 1) / 2, cz = (Z - 1) / 2;
  if (sym !== 'x' && sym !== 'z' && !(sym === 'both' && X === Z)) return (x, z) => [[1, x, z]];
  const step = (d) => { const t = Math.min(1, Math.max(0, (d + SYM_BAND) / (2 * SYM_BAND))); return t * t * (3 - 2 * t); };
  const own = (x, z) => (sym === 'x' ? step(cx - x) : sym === 'z' ? step(cz - z) : step(cx - x) * step(cz - z));
  return (x, z) => {
    if (own(x, z) <= 0) return null;
    const images = sym === 'both'
      ? [[x, z], [X - 1 - z, x], [X - 1 - x, Z - 1 - z], [z, Z - 1 - x]]
      : [[x, z], [X - 1 - x, Z - 1 - z]];
    const w = images.map(([a, b]) => own(a, b));
    const sum = w.reduce((a, b) => a + b, 0);
    const out = [];
    images.forEach(([a, b], i) => { if (w[i] > 1e-6) out.push([w[i] / sum, a, b]); });
    return out;
  };
}

// The column mirror(sym) copies column (x, z) from, [x, z], or null where it's left as generated.
function mirrorSource(sym) {
  const [X, , Z] = SIZE;
  if (sym === 'x' || sym === 'z') {
    return (x, z) => ((sym === 'x' ? x >= Math.ceil(X / 2) : z >= Math.ceil(Z / 2)) ? [X - 1 - x, Z - 1 - z] : null);
  }
  if (sym === 'both' && X === Z) {
    const h = Math.ceil(X / 2);
    return (x, z) => {
      if (x < h && z < h) return null;
      let sx = x, sz = z;
      for (let k = 0; k < 3 && !(sx < h && sz < h); k++) [sx, sz] = [sz, X - 1 - sx];
      return sx < h && sz < h ? [sx, sz] : null;
    };
  }
  return () => null;
}

// Column (x, z) and the columns the map's symmetry turns it to (see Terrain.mirror), [[x, z]].
function symImages(sym, x, z) {
  const [X, , Z] = SIZE;
  if (sym === 'x' || sym === 'z') return [[x, z], [X - 1 - x, Z - 1 - z]];
  if (sym === 'both' && X === Z) return [[x, z], [X - 1 - z, x], [X - 1 - x, Z - 1 - z], [z, Z - 1 - x]];
  return [[x, z]];
}

// Land bridges over heightmap tops (whole voxels; changed in place), so there's a way on foot from each start to
// every other (and back: steps of a voxel at most, on dry land, inside the wall). Each start gets a flat pad
// (BRIDGE_PAD voxels round, at its height or just over the water), so that's where its start is found. Then, while
// a start can't be walked to from the first, the cheapest way to that land (by the water to fill and the steps over
// a voxel) is laid three columns wide: filled to just over the water and graded so it never steps more than one,
// cutting into slopes as much as building up to them. Everything's done to each turned copy too, so the map stays
// symmetrical. bridged: 1 for each column laid (no trees there, a top of plain ground).
export const BRIDGE_PAD = 5;
function landBridge(tops, bridged, starts, sym) {
  const [X, , Z] = SIZE, N = X * Z, dry = WATER_LEVEL + 1;
  const inside = (x, z) => x >= 1 && z >= 1 && x < X - 1 && z < Z - 1;
  const lay = (want) => { // want: Map(column -> height): laid with its turned copies, then smoothed to steps of 1
    const t = new Map();
    for (const [c, h] of want) {
      for (const [x, z] of symImages(sym, c % X, Math.floor(c / X))) {
        const k = x + X * z;
        t.set(k, Math.max(t.get(k) ?? -Infinity, h));
      }
    }
    // The lowest heights at least these that step no more than one between neighbours laid.
    for (let changed = true; changed;) {
      changed = false;
      for (const [k, h] of t) {
        const x = k % X, z = (k - x) / X;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const n = (x + dx) + X * (z + dz), hn = t.get(n);
          if (hn !== undefined && hn < h - 1) { t.set(n, h - 1); changed = true; }
        }
      }
    }
    for (const [k, h] of t) { tops[k] = h; bridged[k] = 1; }
  };
  // Pads.
  const pads = new Map();
  for (const [sx, sz] of starts) {
    const cx = Math.round(sx), cz = Math.round(sz);
    const h = Math.max(tops[cx + X * cz], dry + 1);
    for (let dz = -BRIDGE_PAD; dz <= BRIDGE_PAD; dz++) {
      for (let dx = -BRIDGE_PAD; dx <= BRIDGE_PAD; dx++) {
        if (dx * dx + dz * dz <= BRIDGE_PAD * BRIDGE_PAD + 1 && inside(cx + dx, cz + dz)) pads.set(cx + dx + X * (cz + dz), h);
      }
    }
  }
  // (A pad is flat: what it's laid at, not raised by its neighbours' smoothing.)
  lay(pads);
  // Which land each column's walking reaches: 0 under the water, else a label shared by all it can walk to.
  const label = new Int32Array(N);
  const labelFrom = (start) => {
    label.fill(0);
    const q = new Int32Array(N);
    let n = 0, head = 0;
    label[start] = 1;
    q[n++] = start;
    while (head < n) {
      const c = q[head++], x = c % X, z = (c - x) / X;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz, k = nx + X * nz;
        if (!inside(nx, nz) || label[k] || tops[k] < WATER_LEVEL || Math.abs(tops[k] - tops[c]) > 1) continue;
        label[k] = 1;
        q[n++] = k;
      }
    }
  };
  const home = Math.round(starts[0][0]) + X * Math.round(starts[0][1]);
  for (let i = 1, tries = 0; i < starts.length; tries++) {
    labelFrom(home);
    const from = Math.round(starts[i][0]) + X * Math.round(starts[i][1]);
    if (label[from] || tries >= 3) { i++; tries = -1; continue; }
    // Dijkstra from this start to the nearest column of the first start's land.
    const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
    const heap = new Heap();
    dist[from] = 0;
    heap.push(0, from);
    let end = -1;
    while (heap.size) {
      const [d, c] = heap.pop();
      if (d > dist[c]) continue;
      if (label[c]) { end = c; break; }
      const x = c % X, z = (c - x) / X, hc = Math.max(tops[c], dry);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz, k = nx + X * nz;
        if (!inside(nx, nz)) continue;
        const hk = Math.max(tops[k], dry);
        const cost = 1 + 3 * Math.max(0, dry - tops[k]) + 2 * Math.max(0, Math.abs(hk - hc) - 1);
        if (d + cost < dist[k]) { dist[k] = d + cost; prev[k] = c; heap.push(d + cost, k); }
      }
    }
    if (end < 0) { i++; tries = -1; continue; }
    const path = [];
    for (let c = end; c >= 0; c = prev[c]) path.push(c);
    // Graded along the way: halfway between the lowest and highest heights that step at most one and are, at every
    // column, at or over (and at or under) its own height, filled to just over the water; and kept to its own height
    // at both ends (the land it reaches, the start's pad), so it meets them without a step.
    const P = path.map((c) => Math.max(tops[c], dry)), n = P.length;
    const lo = P.slice(), hi = P.slice();
    for (let j = 1; j < n; j++) { lo[j] = Math.max(lo[j], lo[j - 1] - 1); hi[j] = Math.min(hi[j], hi[j - 1] + 1); }
    for (let j = n - 2; j >= 0; j--) { lo[j] = Math.max(lo[j], lo[j + 1] - 1); hi[j] = Math.min(hi[j], hi[j + 1] + 1); }
    const want = new Map(), e0 = tops[path[0]], e1 = tops[path[n - 1]];
    path.forEach((c, j) => {
      const mid = Math.floor((lo[j] + hi[j]) / 2), d0 = j, d1 = n - 1 - j;
      const g = Math.min(Math.max(mid, e0 - d0, e1 - d1, dry), e0 + d0, e1 + d1), x = c % X, z = (c - x) / X;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!inside(x + dx, z + dz)) continue;
          const k = x + dx + X * (z + dz);
          want.set(k, Math.max(want.get(k) ?? -Infinity, g));
        }
      }
    });
    for (const [k] of pads) if (want.has(k)) want.set(k, Math.max(want.get(k), tops[k]));
    lay(want);
  }
}

// A binary min-heap of [key, value].
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, value) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(value);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = value;
  }
  pop() {
    const k = this.k, v = this.v, top = [k[0], v[0]], lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lk;
        if (l < k.length && k[l] < mk) { m = l; mk = k[l]; }
        if (r < k.length && k[r] < mk) { m = r; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

// For a noise function (valueNoise3): t => the threshold that k times as much of the noise is over as is over t,
// read off a sorted sample of it (k 1: t as it is).
function abundant(noise, k) {
  const n = 40000, v = new Float32Array(n);
  let s = 12345;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) * 256;
  for (let i = 0; i < n; i++) v[i] = noise(rand(), rand(), rand());
  v.sort();
  const above = (t) => { // samples over t
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (v[m] > t) hi = m; else lo = m + 1; }
    return n - lo;
  };
  const over = (t) => {
    if (k === 1) return t;
    const want = Math.min(n - 1, Math.round(above(t) * k));
    return want < 1 ? Infinity : v[n - want - 1];
  };
  over.share = (t) => above(t) / n; // (the share of the noise over t as it is)
  return over;
}

function valueNoise3(seed) {
  const N = 256;
  const perm = new Uint16Array(N * 2);
  const vals = new Float32Array(N);
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < N; i++) { perm[i] = i; vals[i] = rand(); }
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < N; i++) perm[N + i] = perm[i];
  const h = (x, y, z) => vals[perm[perm[perm[x & 255] + (y & 255)] + (z & 255)]];
  return (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const fx = x - xi, fy = y - yi, fz = z - zi;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
    const lerp = (a, b, t) => a + (b - a) * t;
    const plane = (y0) => lerp(
      lerp(h(xi, y0, zi), h(xi + 1, y0, zi), u),
      lerp(h(xi, y0, zi + 1), h(xi + 1, y0, zi + 1), u), w);
    return lerp(plane(yi), plane(yi + 1), v);
  };
}
