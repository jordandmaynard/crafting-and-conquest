// Buildings: chosen from the Build menu and placed on any flat solid surface with room above, then built block by block by idle villagers
// as a build job (which works like a flatten job: villagers claim its columns and place each column bottom-up).
// Every building's doorway is in the middle of its front wall, which faces the camera when it's placed.
//
// The house: 3 × 3 × 3 of planks with a flat roof and a brick chimney in the middle of the left wall that stands one
// block proud of the roof. The big house: 5 × 5 × 5, plank walls two blocks high under a gabled plank roof whose
// ridge runs from front to back, with a brick chimney in its left wall to the top of the roof's slope.

import { SIZE, BLOCK, SOLID_MIN, WATER_LEVEL, isEdge } from './terrain.js';
import { built } from './jobs.js';

const [X, Y, Z] = SIZE;

// How far a builder reaches: sideways, and up from its feet.
const BUILD_REACH = { reach: 3, reachUp: 5 };

// Designs made in the editor (Build → Save design, then Copy designs) that are part of the game, in captureDesign's
// terms (blocks [a, b, k, block], spawn, torches).
export const BUILT_IN_DESIGNS = {
  hut: {"name":"House","w":3,"d":3,"h":4,"blocks":[[0,0,0,208],[0,0,1,208],[0,0,2,208],[0,1,0,208],[0,1,2,208],[0,2,0,208],[0,2,1,208],[0,2,2,208],[1,0,0,208],[1,0,1,208],[1,0,2,208],[1,1,2,208],[1,2,2,208],[2,0,0,220],[2,0,1,220],[2,0,2,220],[2,0,3,220],[2,1,0,208],[2,1,2,208],[2,2,0,208],[2,2,1,208],[2,2,2,208]],"spawn":[1,1,0,0,1],"torches":[[1,1,1,0,1]],"banners":[[0,3,2,0,1,2]]},
  barracks: {"name":"Barracks","w":5,"d":5,"h":3,"blocks":[[0,0,0,220],[0,0,1,220],[0,0,2,208],[0,1,0,220],[0,1,2,208],[0,2,0,220],[0,2,2,208],[0,3,0,220],[0,3,1,220],[0,3,2,208],[0,4,0,220],[1,0,0,220],[1,0,1,220],[1,0,2,208],[1,1,2,208],[1,2,2,208],[1,3,0,220],[1,3,1,220],[1,3,2,208],[2,0,0,220],[2,0,2,208],[2,1,2,208],[2,2,2,208],[2,3,2,208],[3,0,0,220],[3,0,1,220],[3,0,2,208],[3,1,2,208],[3,2,2,208],[3,3,0,220],[3,3,1,220],[3,3,2,208],[4,0,0,220],[4,0,1,220],[4,0,2,208],[4,1,0,220],[4,1,2,208],[4,2,0,220],[4,2,2,208],[4,3,0,220],[4,3,1,220],[4,3,2,208],[4,4,0,220]],"spawn":[2,2,0,0,1],"torches":[[4,4,1,0,0],[0,4,1,0,0],[3,1,1,0,1],[1,1,1,0,1]],"banners":[[3,4,1,0,1,2],[1,4,1,0,1,2]]},
  archeryRange: {"name":"Archery Range","w":5,"d":6,"h":5,"blocks":[[0,0,0,208],[0,0,1,208],[0,0,2,208],[0,1,0,208],[0,1,2,208],[0,2,0,208],[0,2,2,208],[0,3,0,208],[0,3,1,208],[0,3,2,208],[0,4,0,208],[0,5,0,220],[1,0,0,208],[1,0,1,208],[1,0,2,208],[1,0,3,208],[1,1,3,208],[1,2,3,208],[1,3,0,208],[1,3,2,208],[1,3,3,208],[2,0,0,208],[2,0,2,208],[2,0,3,208],[2,1,3,208],[2,1,4,208],[2,2,3,208],[2,2,4,208],[2,3,3,208],[3,0,0,208],[3,0,1,208],[3,0,2,208],[3,0,3,208],[3,1,3,208],[3,2,3,208],[3,3,0,208],[3,3,2,208],[3,3,3,208],[4,0,0,208],[4,0,1,208],[4,0,2,208],[4,1,0,208],[4,1,2,208],[4,2,0,208],[4,2,2,208],[4,3,0,208],[4,3,1,208],[4,3,2,208],[4,4,0,208],[4,5,0,220]],"spawn":[2,1,0,0,1],"torches":[[3,1,1,0,1],[1,1,1,0,1],[4,5,1,0,0],[0,5,1,0,0]],"banners":[[2,4,3,0,1,2]]},
  mageTower: {"name":"Mage Tower","w":5,"d":5,"h":7,"blocks":[[3,0,0,216],[3,0,1,216],[3,0,2,216],[3,0,3,216],[3,0,4,208],[3,0,5,216],[2,0,0,216],[2,0,1,216],[2,0,2,216],[2,0,3,216],[2,0,4,208],[2,0,5,216],[2,0,6,216],[1,0,5,216],[4,1,0,216],[4,1,1,216],[4,1,2,216],[4,1,3,216],[4,1,4,208],[4,1,5,216],[4,1,6,216],[3,1,3,208],[2,1,4,208],[1,1,0,216],[1,1,1,216],[1,1,2,216],[1,1,3,216],[1,1,4,208],[0,1,0,208],[0,1,5,216],[0,1,6,216],[4,2,0,216],[4,2,1,216],[4,2,2,216],[4,2,4,208],[4,2,5,216],[3,2,2,208],[2,2,4,208],[1,2,2,216],[1,2,3,216],[1,2,4,208],[0,2,5,216],[4,3,0,216],[4,3,1,216],[4,3,2,216],[4,3,3,216],[4,3,4,208],[4,3,5,216],[4,3,6,216],[3,3,1,208],[2,3,0,208],[2,3,4,208],[1,3,0,216],[1,3,1,216],[1,3,2,216],[1,3,3,216],[1,3,4,208],[0,3,0,208],[0,3,5,216],[0,3,6,216],[3,4,0,216],[3,4,1,216],[3,4,2,216],[3,4,3,216],[3,4,4,208],[3,4,5,216],[2,4,0,216],[2,4,1,216],[2,4,2,216],[2,4,3,216],[2,4,4,208],[2,4,5,216],[2,4,6,216],[1,4,5,216]],"spawn":[3,2,0,-1,0],"torches":[[0,3,1,0,0],[0,1,1,0,0]],"banners":[[0,3,3,-1,0,3],[0,1,3,-1,0,3]]},
  // A lookout tower: no sight of its own, but a unit on its platform (layer `platform` up, see designPlan) sees
  // LOOKOUT_TUNING.boost times as far (see sightOf in main.js).
  // Stables (Jordan's design): trains knights and scouts; it costs BUILD_EXTRA gold on top of its planks.
  stables: {"name":"Stables","w":7,"d":6,"h":4,"blocks":[[0,0,0,208],[0,0,1,208],[0,0,2,208],[0,0,3,208],[0,1,0,208],[0,1,3,208],[0,2,0,208],[0,2,1,208],[0,2,2,208],[0,2,3,208],[0,3,0,220],[0,4,0,220],[0,5,0,220],[1,0,0,208],[1,0,3,208],[1,1,3,208],[1,2,3,208],[1,5,0,208],[1,5,1,208],[2,0,0,208],[2,0,3,208],[2,1,3,208],[2,2,3,208],[3,0,0,208],[3,0,1,208],[3,0,2,208],[3,0,3,208],[3,1,0,208],[3,1,1,208],[3,1,3,208],[3,2,3,208],[4,0,0,208],[4,0,3,208],[4,1,3,208],[4,2,3,208],[5,0,0,208],[5,0,3,208],[5,1,3,208],[5,2,3,208],[5,5,0,208],[5,5,1,208],[6,0,0,208],[6,0,1,208],[6,0,2,208],[6,0,3,208],[6,1,0,208],[6,1,3,208],[6,2,0,208],[6,2,1,208],[6,2,2,208],[6,2,3,208],[6,3,0,220],[6,4,0,220],[6,5,0,220]],"spawn":[3,3,0,0,1],"torches":[[3,1,2,0,0],[5,5,2,0,0],[1,5,2,0,0]],"banners":[[5,6,1,0,1,2],[1,6,1,0,1,2]]},
  // The Keep (Jordan's design): each team's start, never in the Build menu (see placeKeep). Its power crystal floats
  // over the hole in the middle of its roof; it trains workers, and is where they bring what they gather (see
  // jobs.js Workers.deliver).
  keep: {"name":"Keep","w":5,"d":5,"h":4,"blocks":[[0,0,0,216],[0,0,1,216],[0,0,2,208],[0,0,3,216],[0,1,0,216],[0,1,1,216],[0,1,2,208],[0,2,2,208],[0,2,3,216],[0,3,0,216],[0,3,1,216],[0,3,2,208],[0,4,0,216],[0,4,1,216],[0,4,2,208],[0,4,3,216],[1,0,0,216],[1,0,1,216],[1,0,2,208],[1,1,2,208],[1,2,2,208],[1,3,2,208],[1,4,0,216],[1,4,1,216],[1,4,2,208],[2,0,2,208],[2,0,3,216],[2,1,2,208],[2,2,0,216],[2,3,2,208],[2,4,2,208],[2,4,3,216],[3,0,0,216],[3,0,1,216],[3,0,2,208],[3,1,2,208],[3,2,2,208],[3,3,2,208],[3,4,0,216],[3,4,1,216],[3,4,2,208],[4,0,0,216],[4,0,1,216],[4,0,2,208],[4,0,3,216],[4,1,0,216],[4,1,1,216],[4,1,2,208],[4,2,2,208],[4,2,3,216],[4,3,0,216],[4,3,1,216],[4,3,2,208],[4,4,0,216],[4,4,1,216],[4,4,2,208],[4,4,3,216]],"spawn":[2,3,0,0,1],"torches":[[2,2,1,0,0]],"banners":[[3,5,1,0,1,2],[1,5,1,0,1,2]]},
  lookoutTower: {"name":"Lookout Tower","w":3,"d":4,"h":6,"platform":3,"blocks":[[0,0,0,208],[0,1,0,208],[0,1,1,208],[0,1,2,208],[0,1,3,208],[0,2,3,208],[0,3,0,208],[0,3,1,208],[0,3,2,208],[0,3,3,208],[1,0,1,208],[1,1,3,208],[1,2,3,208],[1,2,4,208],[1,2,5,208],[1,3,3,208],[2,0,2,208],[2,1,0,208],[2,1,1,208],[2,1,2,208],[2,1,3,208],[2,2,3,208],[2,3,0,208],[2,3,1,208],[2,3,2,208],[2,3,3,208]],"torches":[[1,2,6,0,0]],"banners":[[1,4,3,0,1,2]]},
};

// The Build menu's buildings, by key: { name, plan } (the built-in designs, added once designPlan is defined, below,
// and the editor's saved designs). House and Big house (housePlan, bigHousePlan) are no longer offered.
export const BUILDINGS = {};

// What a finished building can make (its command card): the kinds of unit, each brought out at its spawn point once
// its PRODUCTION_TUNING time is up. A building with none (the House, a saved design) brings out one worker
// when it's built, and nothing after.
export const BUILDING_ACTIONS = {
  keep: ['worker'],
  barracks: ['warrior', 'barbarian'],
  archeryRange: ['archer', 'spearman'],
  mageTower: ['mage', 'priest'],
  stables: ['scout', 'knight'],
};

// Seconds each kind of unit takes to make.
export const PRODUCTION_TUNING = { worker: 8, warrior: 5, barbarian: 10, archer: 5, spearman: 10, mage: 5, priest: 10, scout: 8, knight: 12 };

// Population (a new game): a team can have as many villagers as its Keep (`keep`) and its finished houses (Worker's
// Huts, `house` each) make room for. Training waits while it's full. (A dead worker no longer comes back: train
// another at the Keep.)
export const POP_TUNING = { keep: 5, house: 5 };

// How far each kind of finished building sees for the fog of war, round its footprint (voxels; T > Fog of war). A
// building not listed (a design saved in the editor) sees FOG_TUNING.buildingSight.
export const BUILDING_SIGHT = { keep: 10, hut: 5, barracks: 7, archeryRange: 7, mageTower: 10, lookoutTower: 0, stables: 7 };

// A unit standing on a lookout's platform (a design with a platform: the Lookout Tower) sees `boost` times as far.
export const LOOKOUT_TUNING = { boost: 2 };

// What each costs to train in a new game (taken from the inventory when it's queued, given back if it's cancelled;
// free in sandbox): gold, iron, planks and wheat.
export const TRAINING_COST = {
  worker: { gold: 0, iron: 0, planks: 0, wheat: 5 },
  warrior: { gold: 0, iron: 5, planks: 0, wheat: 10 },
  barbarian: { gold: 10, iron: 15, planks: 0, wheat: 0 },
  archer: { gold: 0, iron: 0, planks: 5, wheat: 10 },
  spearman: { gold: 10, iron: 0, planks: 15, wheat: 0 },
  mage: { gold: 5, iron: 0, planks: 0, wheat: 10 },
  priest: { gold: 15, iron: 0, planks: 0, wheat: 0 },
  scout: { gold: 0, iron: 0, planks: 10, wheat: 20 },
  knight: { gold: 0, iron: 10, planks: 0, wheat: 30 },
};
// What a building costs on top of its blocks, in a new game (taken when it's placed, given back if it's cancelled before
// it's finished): gold and iron.
export const BUILD_EXTRA = { stables: { gold: 10, iron: 0 } };
export function buildExtra(key) {
  const c = BUILD_EXTRA[key] ?? {};
  return [[BLOCK.GOLD, c.gold], [BLOCK.IRON, c.iron]].map(([b, n]) => [b, Math.round(n ?? 0)]).filter(([, n]) => n > 0);
}
const WHEAT = 1; // (inventory.js WHEAT: it imports this file)
// As [[block (or WHEAT), how many]] (only what it takes some of).
export function trainingCost(kind) {
  const c = TRAINING_COST[kind] ?? {};
  return [[BLOCK.GOLD, c.gold], [BLOCK.IRON, c.iron], [BLOCK.PLANK, c.planks], [WHEAT, c.wheat]].map(([b, n]) => [b, Math.round(n ?? 0)]).filter(([, n]) => n > 0);
}

// Front directions, by which way the door faces: [dx, dz].
const FACINGS = [[0, 1], [1, 0], [0, -1], [-1, 0]];

// The door faces the camera: the axis direction nearest the way from the building towards the eye.
export function facingToward(cx, cz, eye) {
  const dx = eye[0] - cx, dz = eye[2] - cz;
  return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 1 : 3) : (dz > 0 ? 0 : 2);
}

// A building's plan centred on column (cx, cz) on floor height y0, from shape(a, b, k): the block at a across the
// front (to the building's left, seen from the door), b towards the front and k up from the floor, or AIR. a runs
// over [a0, a1] and b over [b0, b1] (both inclusive), and `h` is the height of its bounding box. Returns its blocks as
// [x, y, z, block], the space it needs (all of its bounding box) as [x, y, z], and ghost boxes ([lo, hi]) for the
// outline of the shape.
function makePlan(cx, y0, cz, facing, [A0, A1], [B0, B1], h, shape) {
  const [fx, fz] = FACINGS[facing];
  const rx = -fz, rz = fx;
  const at = (a, b) => [cx + a * rx + b * fx, cz + a * rz + b * fz];
  const blocks = [], space = [], ghosts = [];
  const top = new Map(); // column `${a},${b}` -> its highest k with a block
  for (let b = B0; b <= B1; b++) {
    for (let a = A0; a <= A1; a++) {
      const [x, z] = at(a, b);
      for (let k = 0; k < h; k++) {
        space.push([x, y0 + k, z]);
        const block = shape(a, b, k);
        if (block) { blocks.push([x, y0 + k, z, block]); top.set(`${a},${b}`, k); }
      }
    }
  }
  // The ghost: per layer, the box of the columns that have a block at or above that layer, merged with the layer
  // below when it's the same.
  const box = (a0, a1, b0, b1, k0, k1) => {
    const [xa, za] = at(a0, b0), [xb, zb] = at(a1, b1);
    return [[Math.min(xa, xb), y0 + k0, Math.min(za, zb)], [Math.max(xa, xb) + 1, y0 + k1, Math.max(za, zb) + 1]];
  };
  let prev = null;
  for (let k = 0; k < h; k++) {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let b = B0; b <= B1; b++) {
      for (let a = A0; a <= A1; a++) {
        if ((top.get(`${a},${b}`) ?? -1) >= k) { a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
      }
    }
    if (a0 > a1) break;
    const key = `${a0},${a1},${b0},${b1}`;
    if (prev?.key === key) prev.k1 = k + 1;
    else { prev = { key, a0, a1, b0, b1, k0: k, k1: k + 1 }; ghosts.push(prev); }
  }
  return { blocks, space, ghosts: ghosts.map((g) => box(g.a0, g.a1, g.b0, g.b1, g.k0, g.k1)) };
}

// The house: walls and doorway on k 0-1, the flat roof on k 2, the chimney in the left wall up to k 3.
// A finished house brings out a worker in its middle, facing out of the door (plan.spawn, see spawns.js).
export function housePlan(cx, y0, cz, facing) {
  const plan = housePlanBlocks(cx, y0, cz, facing);
  plan.spawn = { cell: [cx, y0, cz], dir: FACINGS[facing].slice() };
  return plan;
}
function housePlanBlocks(cx, y0, cz, facing) {
  return makePlan(cx, y0, cz, facing, [-1, 1], [-1, 1], 4, (a, b, k) => {
    if (a === 1 && b === 0) return BLOCK.BRICK;                 // chimney, through the roof and one above it
    if (k === 3) return BLOCK.AIR;
    if (k === 2) return BLOCK.PLANK;                             // roof
    const wall = a !== 0 || b !== 0, door = a === 0 && b === 1;
    return wall && !door ? BLOCK.PLANK : BLOCK.AIR;
  });
}

// The big house: walls on k 0-1 (doorway two high), then the roof stepping up a block per block in from each side
// (k 2 over the side walls, k 3, the ridge at k 4), with the front and back walls filling the gables under it. The
// chimney's in the middle of the left wall, up through the eave to a block above it.
export function bigHousePlan(cx, y0, cz, facing) {
  return makePlan(cx, y0, cz, facing, [-2, 2], [-2, 2], 5, (a, b, k) => {
    const roof = 4 - Math.abs(a); // the roof's height over this column
    if (a === 2 && b === 0 && k <= 3) return BLOCK.BRICK;       // chimney
    if (k === roof) return BLOCK.PLANK;                          // roof
    if (k > roof) return BLOCK.AIR;
    const door = a === 0 && b === 2 && k < 2;
    if (Math.abs(b) === 2) return door ? BLOCK.AIR : BLOCK.PLANK; // front and back walls, up into the gables
    return Math.abs(a) === 2 ? BLOCK.PLANK : BLOCK.AIR;          // side walls
  });
}

// A saved design: what's built in the box [x0, x1) × [y0, y1) × [z0, z1) (everything solid but leaves, as villagers
// would build it: wood as planks, stone as bricks), trimmed to the blocks' bounding box. `facing` is the side facing
// the camera, which becomes its front. As { name, w, d, h, blocks: [[a, b, k, block]] }, a across the front (0..w-1),
// b towards it (0..d-1) and k up (0..h-1), or null when the box is empty. `spawn` (a spawn point in the box, see
// spawns.js) is kept as spawn: [a, b, k, da, db], its cell and the way it faces in the same terms; `torches` (those in
// the box, see torches.js) as torches: [[a, b, k, wa, wb]], wa, wb the way a wall torch leans out (0, 0 standing up);
// `banners` (see banners.js) as banners: [[a, b, k, wa, wb, h]], wa, wb the way out from the block it hangs on.
export function captureDesign(terrain, x0, z0, x1, z1, y0, y1, facing, name, spawn = null, torches = [], banners = []) {
  const [fx, fz] = FACINGS[facing];
  const rx = -fz, rz = fx;
  const found = [];
  for (let z = Math.max(0, z0); z < Math.min(Z, z1); z++) {
    for (let x = Math.max(0, x0); x < Math.min(X, x1); x++) {
      for (let y = Math.max(0, y0); y < Math.min(Y, y1); y++) {
        const b = terrain.block(x, y, z);
        if (b < SOLID_MIN || b === BLOCK.LEAVES) continue;
        found.push([x * rx + z * rz, x * fx + z * fz, y, built(b)]);
      }
    }
  }
  if (!found.length) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const f of found) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], f[i]); hi[i] = Math.max(hi[i], f[i] + 1); }
  const design = {
    name, w: hi[0] - lo[0], d: hi[1] - lo[1], h: hi[2] - lo[2],
    blocks: found.map(([a, b, k, block]) => [a - lo[0], b - lo[1], k - lo[2], block]),
  };
  if (spawn) {
    const [x, y, z] = spawn.cell, [dx, dz] = spawn.dir;
    design.spawn = [x * rx + z * rz - lo[0], x * fx + z * fz - lo[1], y - lo[2], dx * rx + dz * rz, dx * fx + dz * fz];
  }
  if (torches.length) {
    design.torches = torches.map(({ cell: [x, y, z], wall }) => {
      const [dx, dz] = wall ?? [0, 0];
      return [x * rx + z * rz - lo[0], x * fx + z * fz - lo[1], y - lo[2], dx * rx + dz * rz, dx * fx + dz * fz];
    });
  }
  if (banners.length) {
    design.banners = banners.map(({ cell: [x, y, z], wall: [dx, dz], h }) =>
      [x * rx + z * rz - lo[0], x * fx + z * fz - lo[1], y - lo[2], dx * rx + dz * rz, dx * fx + dz * fz, h]);
  }
  return design;
}

// The plan function for a saved design (see BUILDINGS), centred on the column clicked, its front facing the camera.
// It needs all of its bounding box empty, on flat ground; its builders reach as high as it is.
export function designPlan(design) {
  const { w, d, h } = design;
  const shape = new Uint8Array(w * d * h);
  for (const [a, b, k, block] of design.blocks) shape[a + w * (b + d * k)] = built(block); // (dirt as clay, say)
  const ha = Math.floor((w - 1) / 2), hb = Math.floor((d - 1) / 2);
  return (cx, y0, cz, facing) => {
    const plan = makePlan(cx, y0, cz, facing, [-ha, w - 1 - ha], [-hb, d - 1 - hb], h,
      (a, b, k) => shape[a + ha + w * (b + hb + d * k)]);
    plan.reach = { reach: 3, reachUp: Math.max(BUILD_REACH.reachUp, h + 2), reachDown: 4 };
    // Its spawn point, torches and banners, from the design's terms to the world's.
    const [fx, fz] = FACINGS[facing], rx = -fz, rz = fx;
    const place = ([a, b, k, da, db]) => {
      const A = a - ha, B = b - hb;
      return { cell: [cx + A * rx + B * fx, y0 + k, cz + A * rz + B * fz], dir: [da * rx + db * fx, da * rz + db * fz] };
    };
    if (design.spawn) plan.spawn = { ...place(design.spawn), kind: design.unit ?? 'worker' };
    if (design.platform != null) plan.platform = y0 + design.platform; // (a lookout's, see LOOKOUT_TUNING)
    if (design.torches) {
      plan.torches = design.torches.map((t) => {
        const { cell, dir } = place(t);
        return { cell, wall: dir[0] || dir[1] ? dir : null };
      });
    }
    if (design.banners) plan.banners = design.banners.map((t) => { const { cell, dir } = place(t); return { cell, wall: dir, h: t[5] }; });
    return plan;
  };
}

// Whether a plan can go here: every column of its footprint stands on something solid at the plan's floor (ground,
// stone, planks, bricks, a roof: anything but leaves), above the water, and all the space it needs is empty (no trees,
// no other buildings). `jobs` are the open jobs, which it
// mustn't overlap.
export function canPlace(terrain, plan, y0, jobs = []) {
  if (y0 <= WATER_LEVEL) return false;
  for (const [x, y, z] of plan.space) {
    if (x < 0 || z < 0 || x >= X || z >= Z || y >= Y || isEdge(x, z)) return false;
    if (terrain.block(x, y, z) !== BLOCK.AIR) return false;
    if (y === y0 && (!terrain.solid(x, y - 1, z) || terrain.block(x, y - 1, z) === BLOCK.LEAVES)) return false;
    if (jobs.some((j) => j.contains(x, z))) return false;
  }
  return true;
}

// Whether a unit coming out at a plan's spawn point could walk out of the building once it's built: a search over the
// cells a villager can stand in (as units.standable, with the plan's blocks in place), stepping to a side neighbour
// up one or down as far as three, until it stands outside the plan's footprint. True for a plan with no spawn point.
export function canExit(terrain, plan, maxCells = 4000) {
  if (!plan.spawn) return true;
  const built = new Set(plan.blocks.map(([x, y, z]) => `${x},${y},${z}`));
  const solid = (x, y, z) => built.has(`${x},${y},${z}`) || terrain.solid(x, y, z);
  const stand = (x, y, z) => x >= 0 && z >= 0 && x < X && z < Z && y >= Math.max(1, WATER_LEVEL) && y < Y - 1 &&
    solid(x, y - 1, z) && !solid(x, y, z) && !solid(x, y + 1, z);
  const { lo, hi } = planBox(plan);
  const outside = (x, z) => x < lo[0] || x >= hi[0] || z < lo[2] || z >= hi[2];
  const [sx, sy, sz] = plan.spawn.cell;
  let start = null;
  for (let y = sy; y >= sy - 3 && !start; y--) if (stand(sx, y, sz)) start = [sx, y, sz]; // (as units.spawn lands)
  if (!start) return false;
  const seen = new Set([start.join()]), queue = [start];
  while (queue.length && seen.size < maxCells) {
    const [x, y, z] = queue.shift();
    if (outside(x, z)) return true;
    for (const [dx, dz] of FACINGS) {
      for (let dy = 1; dy >= -3; dy--) {
        const c = [x + dx, y + dy, z + dz];
        // Up a step needs headroom over where it is; down, the way over the drop clear.
        if (dy > 0 && solid(x, y + 2, z)) continue;
        if (!stand(...c)) { if (dy <= 0 && solid(...c)) break; continue; } // (no going down through a wall)
        const k = c.join();
        if (!seen.has(k)) { seen.add(k); queue.push(c); }
        break;
      }
    }
  }
  return false;
}

// The bounding box of a plan's blocks: [lo, hi) as [x, y, z].
export function planBox(plan) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of plan.blocks) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], b[i]); hi[i] = Math.max(hi[i], b[i] + 1); }
  return { lo, hi };
}

// A building being placed, as ghost cubes (see vsGhost) just where it has blocks: kind 14 where it fits (the team's
// colour), 7 where it fits but the inventory can't cover it (white), 15 where it doesn't fit (red).
export function planGhosts(plan, kind, out = []) {
  for (const [x, y, z] of plan.blocks) out.push([x, y, z, kind]);
  return out;
}

// A building under construction. Villagers claim its columns like a flatten job's; each column is built bottom-up,
// and anything in the way of a block (dirt a brush dropped there, say) is dug out first.
export class BuildJob {
  // reach: how far its builders reach (see WORK_TUNING): the plan's, else BUILD_REACH.
  constructor(terrain, plan, reach = plan.reach ?? BUILD_REACH) {
    this.terrain = terrain;
    this.plan = plan;
    this.reach = reach;
    this.columns = new Map(); // column (x + X * z) -> [[y, block]] bottom-up
    for (const [x, y, z, b] of plan.blocks) {
      const k = x + X * z;
      if (!this.columns.has(k)) this.columns.set(k, []);
      this.columns.get(k).push([y, b]);
    }
    for (const list of this.columns.values()) list.sort((a, b) => a[0] - b[0]);
    const { lo, hi } = planBox(plan);
    this.x0 = lo[0]; this.z0 = lo[2]; this.x1 = hi[0]; this.z1 = hi[2];
    this.pending = [...this.columns.keys()];
    this.claimed = new Map();
    this.skipUntil = new Map();
  }

  get done() { return this.pending.length === 0; }

  contains(x, z) { return x >= this.x0 && x < this.x1 && z >= this.z0 && z < this.z1; }

  // The next block to place in column (x, z) (or what's in its way, to dig out), or null when the column's built.
  // Builders reach further than usual (they'd have ladders and scaffolding), so a roof can be built from the ground.
  task(x, z) {
    const list = this.columns.get(x + X * z);
    if (!list) return null;
    for (const [y, block] of list) {
      const now = this.terrain.block(x, y, z);
      if (now === block) continue;
      if (now === BLOCK.AIR || now === BLOCK.LEAVES) return { x, y, z, dig: false, top: y, place: block, ...this.reach };
      return { x, y, z, dig: true, top: y, low: y, ...this.reach };
    }
    return null;
  }

  // Whether a block's still to go at (x, y, z).
  fills(x, y, z) {
    const list = this.columns.get(x + X * z), now = this.terrain.block(x, y, z);
    return !!list?.some(([h, block]) => h === y && block >= SOLID_MIN && now !== block);
  }

  marks() { return []; } // (drawn as ghost cubes instead, see ghosts)

  // The blocks still to place, as ghost cubes: in the team's colour (kind 16), or white (6) while a new game's
  // inventory can't cover the building (short).
  ghosts(out = [], short = false) {
    for (const [k, list] of this.columns) {
      const x = k % X, z = Math.floor(k / X);
      for (const [y, block] of list) if (block >= SOLID_MIN && this.terrain.block(x, y, z) !== block) out.push([x, y, z, short ? 6 : 16]);
    }
    return out;
  }
}

// (The Keep too, though only the Editor's Build menu has it: a game's Keeps come with the map, see placeKeep.)
for (const [key, d] of Object.entries(BUILT_IN_DESIGNS)) BUILDINGS[key] = { name: d.name, plan: designPlan(d) };

// A team's Keep at its start (x, z), its door facing `facing` (see FACINGS): the ground under it and a little round
// it levelled to the start's height (dug out above, filled with dirt below), then its blocks set straight into the
// terrain. Returns its plan (its floor at plan.floor).
export const KEEP_APRON = 2; // voxels levelled round it
export function placeKeep(terrain, x, z, facing) {
  const d = BUILT_IN_DESIGNS.keep, y0 = terrain.groundAt(x, z), v = terrain.voxels;
  const r = Math.ceil(Math.max(d.w, d.d) / 2) + KEEP_APRON;
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const cx = x + dx, cz = z + dz;
      if (cx < 1 || cz < 1 || cx >= X - 1 || cz >= Z - 1 || isEdge(cx, cz)) continue;
      for (let y = 1; y < Y; y++) {
        const i = terrain.index(cx, y, cz);
        if (y < y0) { if (v[i] < SOLID_MIN) v[i] = BLOCK.GROUND; }
        else if (y < y0 + d.h + 4 || v[i] === BLOCK.LOG) v[i] = BLOCK.AIR; // (a tree there: its trunk too)
      }
    }
  }
  const plan = designPlan(d)(x, y0, z, facing);
  for (const [bx, by, bz, block] of plan.blocks) v[terrain.index(bx, by, bz)] = block;
  plan.floor = y0;
  terrain.updateBricks([x - r, 0, z - r], [x + r + 1, Y, z + r + 1]);
  return plan;
}
