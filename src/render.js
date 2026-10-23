// Full-screen raymarch of the terrain SDF, in three passes so the profiler can time each part:
//   march:  each pixel's ray is clipped to the world box and marched through the distance texture (where
//           distances are clamped, far from the surface, the brick distances let it jump whole runs of empty
//           bricks); near the surface it walks voxel by voxel to the exact cube it hits. Leaves are cut out: a ray
//           that meets a gap in the leaf texture carries on. Writes the hit distance and face normal to a G-buffer.
//   shadow: soft shadow towards the sun from each hit.
//   shade:  each block textured by its type and face (grass, dirt and sand for the ground; bark, rings and leaves
//           for trees), lit by the sun and the sky (sky.js) with corner ambient occlusion, distance fog, the sky for
//           misses, and the brush cursor and job marks.
//
// The world is the exact union of the solid voxels' unit cubes. Near the surface the distance is evaluated
// analytically against the voxels around the point; further out the distance field (which is blurred over a voxel
// or so), less a margin covering how far it can be from the cubes, still drives the big steps and brick skipping.

import { SIZE, BRICK, SDF_RANGE, SOLID_MIN, WATER_LEVEL, BLOCK, BLAST_SLOTS } from './terrain.js';
import { TEX_SIZE, LAYERS } from './textures.js';
import { skyWgsl, linearColor } from './sky.js';
import { mat4 } from './math.js';
import { MAX_HOT, SCORCH_FLOATS } from './scorch.js';
import { PROBE, PROBES, GI_TUNING } from './skyvis.js';

export const UNIFORM_FLOATS = 76 + SCORCH_FLOATS + 104;
export const MAX_MARKS = 256;

// Tuning (T panel): how many voxels one repeat of the ground's textures (grass, dirt, sand, stone) spans.
// bevel, cornerBevel: how far the cuts on the ground's exposed top edges and upright corners reach into a cube (0 = none;
// see bevelCuts). sandBright: the sand texture's brightness (1 as painted). ripples: on (1), a normal map of ripples over
// sand's tops (textures/ripples-normal.png, in toon shading too), rippleScale voxels a repeat, rippleStrength strong.
export const RENDER_TUNING = { textureTiling: 3, bevel: 0.2, cornerBevel: 0, sandBright: 0.8, ripples: 1, rippleScale: 12, rippleStrength: 0.23 };
// Tuning (T > Ground): each brick's and plank's edges bevelled in the lighting only (the normal tilts out over this
// many voxels from its seam, by up to strength: 1 = 45°), and in toon shading the seams drawn as strokes this strong.
// The obsidian wall round the map (T > Obsidian): its colour, how much of the stone's grain shows in it (0 = flat), and
// the glassy glint across its faces (a sheen that comes and goes with the angle you see it at).
export const OBSIDIAN_LOOK = { color: '#1d1628', grain: 0.45, glint: 0.35 };
// Rounded leaves (T > Leaves), an experiment: on (1), each leaf block's edges and corners are rounded off where the leaf
// is open on the sides that meet there (radius in voxels, up to 0.5: a lone leaf is a ball), so a clump of leaves is a
// soft blob, joined flat to the leaves and logs beside it; off (0), cubes. holes: the leaf texture's see-through gaps
// cut out of the rounded leaves too (1), or not (0, solid blobs).
export const LEAF_TUNING = { round: 1, radius: 0.4, holes: 1 };
// Snow (T > Snow): on (1), the ground above the snow line (height voxels above the sea, up or down by up to jitter
// column by column, so the line's ragged) is white on top, dirt and stone alike, down its sides as far as grass hangs
// over them; its grass tufts are white too, and (trees 1) the tops of the trees above it. Only the look: the blocks are
// still dirt and stone. ripples: on (1), sand's ripples (RENDER_TUNING) on the snow's tops too, turned a quarter round
// and inside out (hollows for ridges), rippleScale voxels a repeat, rippleStrength strong.
export const SNOW_TUNING = { on: 1, height: 25, jitter: 0.5, color: '#ecf4fe', trees: 1, ripples: 1, rippleScale: 2.7, rippleStrength: 0.1 };
// The snow line at column (x, z), in voxels up (see SNOW_TUNING; the same in grass.js's WGSL).
export const SNOW_WGSL = /* wgsl */ `
fn snowLine(col: vec2i, height: f32, jitter: f32) -> f32 {
  let h = fract(sin(dot(vec2f(col), vec2f(12.9898, 78.233))) * 43758.5453);
  return ${WATER_LEVEL}.0 + height + (h - 0.5) * 2.0 * jitter;
}`;
export const BLOCK_TUNING = { brickBevel: 0.04, brickStrength: 1, plankBevel: 0.03, plankStrength: 0.8, seams: 0.6,
  // Clay bricks (put-down dirt): how far in from a brick's edge it's rounded (voxels), how strongly, and the bricks
  // across and up a voxel.
  clayRound: 0.065, clayStrength: 1.96, clayAcross: 2, clayUp: 2, clayCorner: 0.065, clayHandmade: 0,
  // What a team built (see Terrain.owners) in its own colours: each of its bricks, clay bricks and planks that colour
  // all over, in place of the texture (their bevels and normal maps as ever).
  brickBlue: '#798abe', brickRed: '#a47b74', brickYellow: '#c4ad78', brickPurple: '#b090d5',
  clayBlue: '#5f6186', clayRed: '#805547', clayYellow: '#967b4f', clayPurple: '#736080',
  plankBlue: '#3c6cdd', plankRed: '#ac482a', plankYellow: '#d3963c', plankPurple: '#6f4096' };
// The teams in Terrain.owners' order (OWNER 1 to 4), for their colours in BLOCK_TUNING.
const TEAM_KEYS = ['Blue', 'Red', 'Yellow', 'Purple'];
// Tuning (T panel): how strongly each texture's normal map bends the light (0 = flat), in the albedo array's layer order.
// Trees' layers (bark, rings, leaves) have no normal maps, so no weight (0).
export const NORMAL_TUNING = { grass: 1, dirt: 1, sand: 1, fringe: 1, stone: 1, plank: 1, brick: 1, tilled: 1 };
// Toon shading (T panel), an experiment: on (1) draws the terrain and blocks in flat colours (each texture's average)
// without normal maps, the light in bands, strokes where the ground drops away behind an edge, and the villagers banded
// and outlined (units-render.js).
export const TOON_TUNING = {
  on: 1,
  bands: 2,            // steps of sunlight, from shadow to full
  softness: 0.5,       // how soft each step's edge is (0 hard)
  grassLip: 0,         // voxels of grass over the top of a dirt side
  edgeDepth: 1.1,      // voxels: the ground this far behind an edge (or the sky) gets a stroke along it
  edgeGrow: 0.011,     // and further by this much a voxel away from the eye, so far ground isn't all strokes
  edgeWidth: 3,        // pixels
  edgeStrength: 1,     // the depth strokes' (tops of the terrain against what's behind)
  edgeColor: '#000000',
  unitOutline: 2,      // pixels round each villager's part (0 none)
  unitColor: '#000000',
  edgeMode: 1,         // terrain strokes: 0 where the ground drops away behind an edge, 1 Sobel (on depth, and normals if sobelNormal)
  sobelNormal: 0.48,   // Sobel: how sharply the surface turns (normals apart, 0-2) before it gets a stroke (0 depth only)
  creaseStrength: 0.45, // Sobel: those strokes' strength (creases and bends)
  ao: 2.16,            // how dark the corner ambient occlusion gets (1 as without toon shading, 0 none, up to 3)
};
export const DEPTH_FORMAT = 'depth32float';
// The coarse march pass works in blocks of COARSE × COARSE pixels (see fsCoarse).
const COARSE = 4;

export const RENDER_WGSL = /* wgsl */ `
struct Frame {
  invViewProj: mat4x4f,
  camPos: vec4f,      // xyz, w = 1 for orthographic
  sun: vec4f,         // xyz = direction towards the sun
  brush: vec4f,       // xyz = centre, w = radius (0 = hidden)
  brushColor: vec4f,  // rgb, a = strength
  pixel: vec4f,       // x = world size of a pixel at unit distance (perspective) or anywhere (ortho), y = time,
                      // z = fog start
  viewProj: mat4x4f,
  marks: vec4f,       // x = how many ground marks (unit shadows, selection rings, goals) are in use,
                      // y = voxels per repeat of the ground's textures, z = top edge bevel, w = corner bevel
  torch: vec4f,       // rgb = torchlight (colour × strength × exposure), w = how far it reaches
  normalWeights: array<vec4f, 3>, // each texture layer's normal map strength (NORMAL_TUNING), four to a vec4; [2].w = sand brightness
  screen: vec4f,      // xy = the output's size in pixels, z = distance from the eye past which the depth of field
                      // blurs the ground enough that it's drawn without bevels or normal maps
  scorch: array<vec4f, ${3 + MAX_HOT * 2}>, // fireballs' scorching (scorch.js): [0] = (hot spots, glow, char darkness,
                      // 1 / patch size), [1] = (char fade start (voxels), blast mark strength, blast mark size, 1 once it's loaded),
                      // [2] = (blast heat, char patchiness, -, -), then per spot (centre, reach), (heat now, -, -, -)
  toon: vec4f,        // toon shading (TOON_TUNING): x = on, y = bands, z = band softness, w = grass lip (voxels)
  toonEdge: vec4f,    // its strokes (see edgeOf): x = depth behind, y = growth with distance, z = width (pixels), w = strength
  toonColor: vec4f,   // rgb = the strokes' colour (linear), w = their mode: 0 drop-off, 1 Sobel
  toonSobel: vec4f,   // x = Sobel's normal threshold (0 = depth only), y = its strokes' strength, z = ambient occlusion strength,
                      // w = brick and plank seam strokes' strength
  blocks: vec4f,      // BLOCK_TUNING: bevel width and strength for bricks (xy) and planks (zw)
  gi: vec4f,          // global illumination (GI_TUNING): x = mode (0 off, 1 sky visibility, 2 bounce light), y = strength,
                      // z = bias (voxels), w = the least of the sky light without it kept
  gi2: vec4f,         // x = 1 when walls block torchlight, z = leaves' rounding radius (LEAF_TUNING; 0 = cubes),
                      // w = 1 when rounded leaves keep the texture's gaps
  obsidian: vec4f,    // OBSIDIAN_LOOK: rgb = colour (linear), w = grain; gi2.y = glint
  clay: vec4f,        // BLOCK_TUNING's clay bricks: rounding (voxels), its strength, bricks across and up a voxel
  clay2: vec4f,       // x = their corners' rounding (voxels), y = how hand made they look (0 = all alike)
  teamBricks: array<vec4f, 4>, // each team's colours (BLOCK_TUNING, OWNER order): its bricks,
  teamClay: array<vec4f, 4>,   // its clay bricks,
  teamPlanks: array<vec4f, 4>, // and its planks
  snow: vec4f,        // SNOW_TUNING: x = on, y = height over the sea, z = jitter, w = trees too
  snowColor: vec4f,   // rgb (linear)
  ripples: vec4f,     // RENDER_TUNING's sand ripples: x = on, y = voxels a repeat, z = strength
  snowRipples: vec4f, // SNOW_TUNING's ripples on the snow, the same
}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var sdfTex: texture_3d<f32>;
@group(0) @binding(2) var bricks: texture_3d<u32>;
@group(0) @binding(3) var albedo: texture_2d_array<f32>;
@group(0) @binding(4) var linearSamp: sampler;
@group(0) @binding(5) var tileSamp: sampler;
@group(0) @binding(6) var voxels: texture_3d<u32>;
// Ground marks: xyz = feet position, w = 0 unit (blob shadow), 1 selected unit (shadow + ring), 2 move goal;
// pairs for a flatten box (w = 3) or a Raise/Lower box (w = 4); a torch's flame: xyz, w = 5 + its brightness (< 1); a
// priest's heal pulse, a pair: (centre, -1), (radius, how far through, -, -); a coloured light (a power crystal's), a
// pair: (xyz, -2), (colour × strength, reach, at least 5).
@group(0) @binding(7) var<storage, read> marks: array<vec4f>;
@group(0) @binding(8) var normalMaps: texture_2d_array<f32>; // layer for layer with albedo, then RIPPLES
@group(0) @binding(9) var charTex: texture_3d<f32>; // 1 for each voxel a fireball has charred (scorch.js)
@group(0) @binding(10) var blastCells: texture_3d<u32>; // per 2³ voxels, the blasts that reach it (terrain.blastCells)
@group(0) @binding(11) var<storage, read> blastList: array<vec4f>; // per blast (centre, char reach), (flight, turn)
@group(0) @binding(12) var blastMark: texture_2d<f32>; // the blast mark decal, multiplied in (textures/blast.png)
@group(0) @binding(13) var skyProbes: texture_3d<f32>; // sky visibility probes (skyvis.js)
@group(0) @binding(14) var probeLightTex: texture_3d<f32>; // their light, 3 texels across per probe (skyvis.js)
@group(0) @binding(15) var owners: texture_2d<u32>; // per column, the team that built there (Terrain.owners; 0 none)

const DIMS = vec3f(${SIZE[0]}, ${SIZE[1]}, ${SIZE[2]});
const BRICKS = vec3i(${SIZE.map((n) => Math.ceil(n / BRICK)).join(', ')});
const R = ${SDF_RANGE}.0;
const WATER = ${WATER_LEVEL}.0;
${skyWgsl(2)}
${SNOW_WGSL}
// Whether the ground whose top is at height top in column col is snowy (SNOW_TUNING).
fn snowy(top: f32, col: vec2i) -> bool { return F.snow.x > 0.5 && top >= snowLine(col, F.snow.y, F.snow.z); }
// Snow's colour over a texture colour c of a layer: a little of the texture's light and dark left in it (none in toon
// shading, where c is the layer's average).
fn snowOver(c: vec3f, layer: i32) -> vec3f {
  let L = vec3f(0.299, 0.587, 0.114);
  return F.snowColor.rgb * mix(1.0, dot(c, L) / max(dot(tri(vec2f(0.0), layer, 16.0), L), 1e-3), 0.25);
}

struct VOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f }

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var o: VOut;
  o.pos = vec4f(p, 0.0, 1.0);
  o.ndc = p;
  return o;
}

// Outside the box's sides counts as air, so the map's edges are walls with proper normals, shadows and AO.
fn sdf(p: vec3f) -> f32 {
  let d = textureSampleLevel(sdfTex, linearSamp, p / DIMS, 0.0).r;
  let outside = max(max(-p.x, p.x - DIMS.x), max(-p.z, p.z - DIMS.z));
  return max(d, outside);
}

// Below the map is bedrock; beyond its other faces is air.
fn blockAt(c: vec3i) -> u32 {
  if (c.y < 0) { return ${BLOCK.GROUND}u; }
  if (any(c < vec3i(0)) || any(c >= vec3i(DIMS))) { return 0u; }
  return textureLoad(voxels, c, 0).r;
}
fn solidAt(c: vec3i) -> bool { return blockAt(c) >= ${SOLID_MIN}u; }
fn groundAt(c: vec3i) -> bool { return blockAt(c) >= ${BLOCK.STONE}u; } // ground or stone: the land, not trees

// Bevels (the T panel's edge bevel, F.marks.z, and corner bevel, F.marks.w): ground and stone cubes have their top
// edges cut off at 45° where there's air above and beside them, and their upright corners where there's air on both
// sides; a bevel is how far its cuts reach into the cube along each face (0 = none). A top edge bevel of 1 cuts a 1-high
// step into a 45° slope. Only the look: units, jobs and the brush still see whole cubes.
//
// Cut i (0-7) of a cube takes off what's beyond the plane dot(cutA(i) + cutB(i), g) = 1 - bevel, with g = p less the
// cube's centre and cutA, cutB the two open sides the cut is between: 0-3 the top edges over sides +x, -x, +z, -z
// (bevelSide), 4-7 the upright corners. Where the edge a cut runs along meets a solid cube that isn't cut the same way,
// the cut tapers to nothing over its last bevel's length (a third plane, at 45° to its ends, so no sliver of the
// neighbour's side shows; an upright corner's over twice that, so its taper is steep enough to texture as a side). Where two top edges meet at the inside corner of an L, the corner cube between them is
// mitred (cuts 8-11: only what's beyond both planes goes) so they join up.
const UP = vec3f(0.0, 1.0, 0.0);
fn bevelSide(i: u32) -> vec3f {
  let s = 1.0 - 2.0 * f32(i & 1u);
  return select(vec3f(0.0, 0.0, s), vec3f(s, 0.0, 0.0), i < 2u);
}
fn cutA(i: u32) -> vec3f { return select(bevelSide((i - 4u) & 1u), bevelSide(i), i < 4u); }
fn cutB(i: u32) -> vec3f { return select(bevelSide(2u + ((i - 4u) >> 1u)), UP, i < 4u); }
// End j (1 or 2) of the edge cut i runs along, as the way to the neighbour there.
fn cutEnd(i: u32, j: u32) -> vec3f {
  let s = select(-1.0, 1.0, j == 1u);
  if (i >= 4u) { return vec3f(0.0, s, 0.0); }
  return select(vec3f(s, 0.0, 0.0), vec3f(0.0, 0.0, s), i < 2u);
}
// Does cut i of cube c have to taper off at end j?
fn cutTapers(c: vec3i, i: u32, j: u32) -> bool {
  let n = c + vec3i(cutEnd(i, j));
  if (!solidAt(n)) { return false; } // an outside corner: other cuts meet it
  let a = vec3i(cutA(i));
  if (groundAt(n) && !solidAt(n + a) && !solidAt(n + vec3i(cutB(i)))) { return false; } // the cut runs on into n
  // A top edge running into the inside corner of an L, where n is mitred to meet it.
  let up = vec3i(0, 1, 0);
  return !(i < 4u && groundAt(n) && !solidAt(n + up) && groundAt(n + a) && !solidAt(n + a + up));
}
// Which cuts cube c has: bit i for cut i (0-11), bit 12 + 2i + j - 1 when cut i (0-7) tapers at end j.
fn bevelCuts(c: vec3i) -> u32 {
  let edges = F.marks.z > 0.0;
  let corners = F.marks.w > 0.0;
  if (!(edges || corners) || !groundAt(c)) { return 0u; }
  var open = 0u; // bit i: the side bevelSide(i) is air
  for (var i = 0u; i < 4u; i++) {
    if (!solidAt(c + vec3i(bevelSide(i)))) { open |= 1u << i; }
  }
  let up = edges && !solidAt(c + vec3i(0, 1, 0));
  var cuts = select(0u, open, up);
  for (var m = 0u; m < 4u; m++) {
    let sx = m & 1u;
    let sz = 2u + (m >> 1u);
    if (corners && ((open >> sx) & (open >> sz) & 1u) != 0u) { cuts |= 1u << (4u + m); }
    // The inside corner of an L: both sides solid ground with air above, the diagonal between them air.
    let px = c + vec3i(bevelSide(sx));
    let pz = c + vec3i(bevelSide(sz));
    if (up && (((open >> sx) | (open >> sz)) & 1u) == 0u && !solidAt(px + pz - c) && groundAt(px) && groundAt(pz) &&
        !solidAt(px + vec3i(0, 1, 0)) && !solidAt(pz + vec3i(0, 1, 0))) {
      cuts |= 1u << (8u + m);
    }
  }
  for (var i = 0u; i < 8u; i++) {
    if ((cuts & (1u << i)) == 0u) { continue; }
    for (var j = 1u; j <= 2u; j++) {
      if (cutTapers(c, i, j)) { cuts |= 1u << (11u + 2u * i + j); }
    }
  }
  return cuts;
}
// Plane j (0-2) of cut i: what the cut takes off is beyond every one of its planes, dot(xyz, g) > w.
fn hasPlane(cuts: u32, i: u32, j: u32) -> bool {
  if (j == 0u) { return true; }
  if (i >= 8u) { return j == 1u; }
  return ((cuts >> (11u + 2u * i + j)) & 1u) != 0u;
}
// Where cut i's main plane is: 1 less its bevel.
fn cutK(i: u32) -> f32 { return 1.0 - select(F.marks.z, F.marks.w, i >= 4u && i < 8u); }
fn cutPlane(i: u32, j: u32) -> vec4f {
  let k = cutK(i);
  if (i >= 8u) { // a mitre: both top edges' planes
    let m = i - 8u;
    return vec4f(select(bevelSide(2u + (m >> 1u)), bevelSide(m & 1u), j == 0u) + UP, k);
  }
  let ab = cutA(i) + cutB(i);
  if (j == 0u) { return vec4f(ab, k); }
  // The taper: reaches the edge's end at nothing, the full cut a bevel (an upright corner's: two) back.
  let lean = select(1.0, 0.5, i >= 4u);
  return vec4f(ab - cutEnd(i, j) * lean, 1.0 - 0.5 * lean);
}
// Distance from p to solid cube c, given box, its distance to the whole cube: a lower bound once it's bevelled.
fn bevelledCube(c: vec3i, p: vec3f, box: f32) -> f32 {
  let g = p - vec3f(c) - 0.5;
  // As if every cut were whole and applied (each cut is within one of these), which rules most points out before
  // reading the neighbours.
  var every = -1e9;
  for (var i = 0u; i < 8u; i++) { every = max(every, dot(cutA(i) + cutB(i), g) - cutK(i)); }
  if (every * 0.70710678 <= box) { return box; }
  let cuts = bevelCuts(c);
  var cut = -1e9;
  for (var i = 0u; i < 12u; i++) {
    if ((cuts & (1u << i)) == 0u) { continue; }
    var beyond = 1e9;
    for (var j = 0u; j < 3u; j++) {
      if (hasPlane(cuts, i, j)) {
        let pl = cutPlane(i, j);
        beyond = min(beyond, (dot(pl.xyz, g) - pl.w) / length(pl.xyz));
      }
    }
    cut = max(cut, beyond);
  }
  return max(box, cut);
}

// Distance to the cube surface (bevelled, or with sharp cubes) when it is under half a voxel, else 0.5; exact for sharp
// cubes. Only the 2x2x2 voxels on p's nearer side can be closer than half a voxel, so those are all it reads.
fn cubeSdf(p: vec3f, bevelled: bool) -> f32 {
  let v = vec3i(floor(p));
  let toward = select(vec3i(-1), vec3i(1), fract(p) >= vec3f(0.5));
  var toSolid = 0.5;
  var toAir = 0.5;
  var inLeaf = -1e9; // inside a rounded leaf: how far in from its surface (its rounded-off parts aren't air cubes)
  for (var i = 0; i < 8; i++) {
    let c = v + vec3i(i & 1, (i >> 1) & 1, (i >> 2) & 1) * toward;
    let lo = vec3f(c);
    let box = length(max(max(lo - p, p - lo - 1.0), vec3f(0.0)));
    let b = blockAt(c);
    if (b == ${BLOCK.LEAVES}u && F.gi2.z > 0.0) {
      let l = leafDist(c, p);
      toSolid = min(toSolid, max(box, l));
      if (l < 0.0) { inLeaf = max(inLeaf, l); }
    } else if (b >= ${SOLID_MIN}u) { toSolid = min(toSolid, select(box, bevelledCube(c, p, box), bevelled)); } else { toAir = min(toAir, box); }
  }
  return select(toSolid, max(-toAir, inLeaf), toSolid <= 0.0);
}

// Where a ray (from ro along rd) entering solid cube c at tIn through face, and leaving its box at tOut, meets the
// cube as bevelled: the hit distance and the normal there, or -1 when it only crosses the cut-off parts. Each cut is
// convex, so the ray is in it over one stretch; it hits where it leaves the last of the stretches it starts in.
fn bevelHit(c: vec3i, ro: vec3f, rd: vec3f, tIn: f32, tOut: f32, face: vec3f) -> vec4f {
  let cuts = bevelCuts(c);
  if ((cuts & 0xfffu) == 0u) { return vec4f(tIn, face); }
  let g = ro - vec3f(c) - 0.5;
  var t = tIn;
  var n = face;
  for (var round = 0; round < 12; round++) {
    var moved = false;
    for (var i = 0u; i < 12u; i++) {
      if ((cuts & (1u << i)) == 0u) { continue; }
      var enter = -1e30;
      var leave = 1e30;
      var leaveN = vec3f(0.0);
      for (var j = 0u; j < 3u; j++) {
        if (!hasPlane(cuts, i, j)) { continue; }
        let pl = cutPlane(i, j);
        let along = dot(pl.xyz, rd);
        let tc = (pl.w - dot(pl.xyz, g)) / along;
        if (along > 0.0) {
          enter = max(enter, tc);
        } else if (along < 0.0) {
          if (tc < leave) { leave = tc; leaveN = pl.xyz; }
        } else if (dot(pl.xyz, g) <= pl.w) {
          enter = 1e30; // alongside the plane, never beyond it
        }
      }
      if (enter <= t && t < leave) { t = leave; n = leaveN; moved = true; }
    }
    if (!moved) { break; }
  }
  if (t > tOut) { return vec4f(-1.0, 0.0, 0.0, 0.0); }
  return vec4f(t, n);
}

// Rounded leaves (LEAF_TUNING, F.gi2.z = radius r): in each eighth of leaf block c, the sides it faces that are open
// (no solid block beyond) are rounded together: two open sides meet in a quarter cylinder, three in an eighth of a ball,
// and a side next to another block stays flat and runs on to it. leafQ: the rounded box's q (as in a rounded box's
// distance, length(max(q, 0)) + min(max(q), 0) - r), -1 for a closed side so it plays no part.
fn leafQ(c: vec3i, g: vec3f) -> vec3f {
  let s = select(vec3i(-1), vec3i(1), g >= vec3f(0.0));
  var q = abs(g) - (0.5 - F.gi2.z);
  if (solidAt(c + vec3i(s.x, 0, 0))) { q.x = -1.0; }
  if (solidAt(c + vec3i(0, s.y, 0))) { q.y = -1.0; }
  if (solidAt(c + vec3i(0, 0, s.z))) { q.z = -1.0; }
  return q;
}
// Distance from p to leaf block c rounded (exact near its surface, negative inside).
fn leafDist(c: vec3i, p: vec3f) -> f32 {
  let q = leafQ(c, p - vec3f(c) - 0.5);
  return length(max(q, vec3f(0.0))) + min(max(max(q.x, q.y), q.z), 0.0) - F.gi2.z;
}
// Where a ray (from ro along rd) entering leaf block c at tIn through face, and leaving it at tOut, meets it rounded: the
// hit distance and normal (face when it's straight on at the entry), or -1 when it only crosses the rounded-off parts.
fn leafHit(c: vec3i, ro: vec3f, rd: vec3f, tIn: f32, tOut: f32, face: vec3f) -> vec4f {
  var t = tIn;
  for (var i = 0; i < 32; i++) {
    let g = ro + rd * t - vec3f(c) - 0.5;
    let q = leafQ(c, g);
    let m = max(q, vec3f(0.0));
    let d = length(m) + min(max(max(q.x, q.y), q.z), 0.0) - F.gi2.z;
    if (d < 1e-3) {
      if (i == 0) { return vec4f(tIn, face); }
      return vec4f(t, normalize(m) * sign(g));
    }
    t += d;
    if (t > tOut) { break; }
  }
  return vec4f(-1.0, 0.0, 0.0, 0.0);
}
// The cube face a normal mostly faces along (unsigned; zero for none), for the leaf texture's gaps.
fn mainAxis(n: vec3f) -> vec3f {
  let a = abs(n);
  if (a.x > 0.0 && a.x >= max(a.y, a.z)) { return vec3f(1.0, 0.0, 0.0); }
  if (a.y > 0.0 && a.y >= a.z) { return vec3f(0.0, 1.0, 0.0); }
  return select(vec3f(0.0), vec3f(0.0, 0.0, 1.0), a.z > 0.0);
}

const CUBE_MARGIN = 1.25; // the cubes and the distance field's surface are never further apart than this

// The distance to march by, given the distance field's value s at p.
fn refine(p: vec3f, s: f32, bevelled: bool) -> f32 {
  if (s > CUBE_MARGIN + 0.5) { return s - CUBE_MARGIN; }
  return cubeSdf(p, bevelled);
}
fn dist(p: vec3f) -> f32 { return refine(p, sdf(p), true); }

// Extra distance a ray may safely skip from p because nearby bricks are all far from the surface.
fn brickSkip(p: vec3f) -> f32 {
  let b = clamp(vec3i(floor(p / ${BRICK}.0)), vec3i(0), BRICKS - 1);
  let d = textureLoad(bricks, b, 0).r;
  return f32(max(i32(d) - 1, 0)) * ${BRICK}.0;
}

// Entry and exit of a ray through the world box, with the entry face's normal.
fn boxRange(ro: vec3f, rd: vec3f) -> vec3f {
  let inv = 1.0 / rd;
  let a = (vec3f(0.0) - ro) * inv;
  let b = (DIMS - ro) * inv;
  let lo = min(a, b);
  let hi = max(a, b);
  return vec3f(max(max(lo.x, lo.y), max(lo.z, 0.0)), min(min(hi.x, hi.y), hi.z), 0.0);
}
fn entryNormal(ro: vec3f, rd: vec3f, t: f32) -> vec3f {
  let p = ro + rd * t;
  let e = 1e-3;
  if (p.x < e) { return vec3f(-1, 0, 0); }
  if (p.x > DIMS.x - e) { return vec3f(1, 0, 0); }
  if (p.z < e) { return vec3f(0, 0, -1); }
  if (p.z > DIMS.z - e) { return vec3f(0, 0, 1); }
  if (p.y > DIMS.y - e) { return vec3f(0, 1, 0); }
  return vec3f(0, -1, 0);
}

// Is the leaf texture see-through where the ray enters a leaf block at p, through face (or, if that's unknown,
// whichever face p is on)? t: distance along the ray, for the texture's level of detail.
fn leafGap(p: vec3f, faceIn: vec3f, t: f32) -> bool {
  var face = faceIn;
  if (dot(face, face) == 0.0) {
    let f = abs(fract(p + 0.5) - 0.5);
    face = select(select(vec3f(0, 0, 1), vec3f(0, 1, 0), f.y <= f.z), vec3f(1, 0, 0), f.x <= min(f.y, f.z));
  }
  let uv = select(select(p.xy, p.xz, abs(face.y) > 0.5), p.zy, abs(face.x) > 0.5);
  let footprint = select(F.pixel.x * t, F.pixel.x, F.camPos.w > 0.5);
  let lod = log2(max(footprint * ${TEX_SIZE}.0, 1e-4));
  return textureSampleLevel(albedo, tileSamp, uv, LEAVES, lod).a < 0.5;
}

// Marches from t0 to t1. Returns the hit distance (or -1) in x and, for a cube hit, the face it entered through in
// yzw (else zero). A start inside solid returns t0 (a box wall).
//
// Near the surface the ray walks voxel by voxel (DDA) instead of sphere tracing: a ray skimming a cube face, e.g.
// straight down a wall when the view is axis-aligned, gets tiny distances there and used to run out of steps before
// reaching anything, leaving one-pixel cracks through the terrain.
fn march(ro: vec3f, rd: vec3f, t0: f32, t1: f32) -> vec4f {
  let inv = 1.0 / rd;
  var t = t0;
  var face = vec3f(0.0);
  // The cell the last step went into (and when): next to the one before through face, not floor(p), since the hair
  // past its entry can carry p over another face of it near an edge, or right through a corner of it (and a side's
  // normal would speckle a flat top).
  var next = vec3f(0.0);
  var entry = 0.0;
  var stepped = false;
  for (var i = 0; i < 400; i++) {
    let p = ro + rd * t;
    let s = sdf(p);
    if (s <= CUBE_MARGIN + 0.5) {
      let cell = select(floor(p), next, stepped);
      let b = blockAt(vec3i(cell));
      let exits = select((cell + select(vec3f(0.0), vec3f(1.0), rd > vec3f(0.0)) - ro) * inv, vec3f(1e30), rd == vec3f(0.0));
      let tExit = min(min(exits.x, exits.y), exits.z);
      let roundLeaf = b == ${BLOCK.LEAVES}u && F.gi2.z > 0.0;
      if (b >= ${SOLID_MIN}u) {
        // (A start in a rounded leaf's block may still be outside it: the coarse pass sees leaves rounded.)
        if (i == 0 && !roundLeaf) { return vec4f(t0, 0.0, 0.0, 0.0); }
        let tIn = select(t, entry, stepped);
        if (roundLeaf) {
          let hit = leafHit(vec3i(cell), ro, rd, tIn, tExit, face);
          if (hit.x >= 0.0 && (F.gi2.w < 0.5 || !leafGap(ro + rd * hit.x, mainAxis(hit.yzw), hit.x))) { return hit; }
        } else if (b == ${BLOCK.LEAVES}u) {
          if (!leafGap(p, face, t)) { return vec4f(tIn, face); }
        } else {
          // In the far blur, sharp cubes (bevels wouldn't show).
          if (length(p - F.camPos.xyz) > F.screen.z) { return vec4f(tIn, face); }
          let hit = bevelHit(vec3i(cell), ro, rd, tIn, tExit, face);
          if (hit.x >= 0.0) { return hit; }
        }
      }
      // On to where the ray leaves this cell (plus a hair, for the distance check), into the next one.
      face = select(vec3f(0.0), -sign(rd), exits <= vec3f(tExit));
      next = cell - face;
      entry = tExit;
      stepped = true;
      t = max(tExit, t) + 1e-3;
      if (t > t1) { break; }
      continue;
    }
    stepped = false;
    var d = refine(p, s, false); // (s is past the margin here: the cubes are far off)
    if (d < 0.02) {
      if (i == 0) { return vec4f(t0, 0.0, 0.0, 0.0); }
      return vec4f(t + d, 0.0, 0.0, 0.0); // d is slightly negative after an overshoot: step back onto the surface
    }
    if (s > R * 0.97) { d += brickSkip(p); }
    t += d * 0.9;
    if (t > t1) { break; }
  }
  return vec4f(-1.0, 0.0, 0.0, 0.0);
}

fn normalAt(p: vec3f) -> vec3f {
  let e = 0.01;
  return normalize(vec3f(
    dist(p + vec3f(e, 0, 0)) - dist(p - vec3f(e, 0, 0)),
    dist(p + vec3f(0, e, 0)) - dist(p - vec3f(0, e, 0)),
    dist(p + vec3f(0, 0, e)) - dist(p - vec3f(0, 0, e))));
}

fn softShadow(ro: vec3f, rd: vec3f) -> f32 {
  let r = boxRange(ro, rd);
  var res = 1.0;
  var t = 0.3;
  for (var i = 0; i < 96; i++) {
    if (t > r.y) { break; }
    let p = ro + rd * t;
    let s = sdf(p);
    var d = refine(p, s, false); // sharp cubes: reading every cube's bevels at every step costs too much
    // Clamped distances (far from the surface) aren't real distances, so only nearer ones can darken.
    if (s < R * 0.97) { res = min(res, 8.0 * d / t); }
    if (res < 0.02) { return 0.0; }
    if (s > R * 0.97) { d += brickSkip(p); }
    t += clamp(d, 0.05, 40.0);
  }
  return smoothstep(0.0, 1.0, res);
}

// Minecraft-style ambient occlusion for a cube face: each corner of the face darkens by how many of the three
// voxels touching it (in front of the face) are solid, blended across the face by position.
fn occupied(c: vec3i) -> f32 { return select(0.0, 1.0, solidAt(c)); }
fn cornerAO(side1: f32, side2: f32, corner: f32) -> f32 {
  return select(3.0 - (side1 + side2 + corner), 0.0, side1 + side2 > 1.5) / 3.0;
}
fn cubeAO(p: vec3f, n: vec3f) -> f32 {
  let a = abs(n);
  var axis = vec3f(0.0, 1.0, 0.0);
  var u = vec3i(1, 0, 0);
  var v = vec3i(0, 0, 1);
  if (a.x >= a.y && a.x >= a.z) { axis = vec3f(1.0, 0.0, 0.0); u = vec3i(0, 1, 0); }
  else if (a.z > a.y) { axis = vec3f(0.0, 0.0, 1.0); v = vec3i(0, 1, 0); }
  let normal = axis * sign(dot(n, axis));
  let front = vec3i(floor(p - normal * 0.01)) + vec3i(normal); // the air voxel the face looks into
  let fp = fract(p);
  let st = vec2f(dot(fp, vec3f(u)), dot(fp, vec3f(v)));
  let su0 = occupied(front - u);
  let su1 = occupied(front + u);
  let sv0 = occupied(front - v);
  let sv1 = occupied(front + v);
  let c00 = cornerAO(su0, sv0, occupied(front - u - v));
  let c10 = cornerAO(su1, sv0, occupied(front + u - v));
  let c01 = cornerAO(su0, sv1, occupied(front - u + v));
  let c11 = cornerAO(su1, sv1, occupied(front + u + v));
  let ao = mix(mix(c00, c10, st.x), mix(c01, c11, st.x), st.y);
  return 0.35 + 0.65 * ao;
}

// The light from the probes round a surface at p facing n (skyvis.js), from the 8 round it: each weighted by
// nearness, less when it's behind the surface, and hardly at all when solid ground (not leaves) lies between them;
// probes in the ground are left out. Mode 1 (F.gi.x): rgb = how much of the sky's light it gets (1 = as much as open
// flat ground, which sees the upper half of the sky: ambient() already allows for the ground below). Mode 2: rgb = the
// light arriving (as radiance: multiply by albedo). a = 0 when no probe is usable.
const PROBE = ${PROBE}.0;
const PROBES = vec3i(${PROBES.join(', ')});
fn probeLight(p: vec3f, n: vec3f) -> vec4f {
  let q = p + n * F.gi.z;
  let g = (q - 0.5) / PROBE;
  let base = vec3i(floor(g));
  let f = g - floor(g);
  let bounce = F.gi.x > 1.5;
  var vis = vec4f(0.0);
  var light = vec3f(0.0);
  var wsum = 0.0;
  for (var i = 0; i < 8; i++) {
    let o = vec3i(i & 1, (i >> 1) & 1, (i >> 2) & 1);
    let pi = base + o;
    if (any(pi < vec3i(0)) || any(pi >= PROBES)) { continue; }
    let v = textureLoad(skyProbes, pi, 0);
    if (v.x < 0.0) { continue; }
    let k = floor(v.x * 0.5);
    let pp = vec3f(pi) * PROBE + vec3f(0.5, 0.5 + k, 0.5);
    let tri = select(1.0 - f, f, o == vec3i(1));
    let to = pp - q;
    let wrap = (dot(normalize(to + vec3f(1e-4)), n) + 1.0) * 0.5;
    var w = tri.x * tri.y * tri.z * (wrap * wrap + 0.2);
    for (var j = 1; j < 4; j++) {
      if (blockAt(vec3i(floor(q + to * (f32(j) * 0.25)))) >= ${BLOCK.LOG}u) { w *= 1e-3; break; }
    }
    if (bounce) {
      let c = vec3i(pi.x * 3, pi.y, pi.z);
      let r = textureLoad(probeLightTex, c, 0);
      let gg = textureLoad(probeLightTex, c + vec3i(1, 0, 0), 0);
      let bb = textureLoad(probeLightTex, c + vec3i(2, 0, 0), 0);
      light += w * vec3f(r.x + 2.0 * dot(r.yzw, n), gg.x + 2.0 * dot(gg.yzw, n), bb.x + 2.0 * dot(bb.yzw, n));
    } else {
      vis += vec4f(v.x - 2.0 * k, v.yzw) * w;
    }
    wsum += w;
  }
  if (wsum < 1e-7) { return vec4f(0.0); }
  if (bounce) { return vec4f(max(light / wsum, vec3f(0.0)), 1.0); }
  let s = vis / wsum;
  let seen = clamp(s.x + 2.0 * dot(s.yzw, n), 0.0, 1.0);
  return vec4f(vec3f(clamp(seen / max(0.5 + 0.5 * n.y, 0.25), 0.0, 1.0)), 1.0);
}

// Whether the torch flame at m is in sight of surface point p (facing n): a walk through the voxels between them, any
// solid one but leaves in the way blocking it. A point on a bevel lies inside its own cube, and the walk out of it can
// clip the uncut cube beside it where a bevel tapers off; so from inside a cube, the cubes entered in the first 0.75
// voxels don't block.
fn torchSeen(p: vec3f, n: vec3f, m: vec3f) -> f32 {
  let ro = p + n * 0.02;
  let inside = solidAt(vec3i(floor(ro)));
  let d = m - ro;
  let len = length(d);
  if (len < 1e-3) { return 1.0; }
  let rd = d / len;
  var c = vec3i(floor(ro));
  let end = vec3i(floor(m));
  let stp = vec3i(sign(rd));
  let inv = 1.0 / max(abs(rd), vec3f(1e-6));
  var tm = (select(vec3f(c) - ro, vec3f(c) + 1.0 - ro, rd > vec3f(0.0))) * sign(rd) * inv;
  tm = select(tm, vec3f(1e9), abs(rd) < vec3f(1e-6));
  for (var i = 0; i < 48; i++) {
    if (all(c == end)) { return 1.0; }
    var te = 0.0; // how far along the ray it entered the next voxel
    if (tm.x < tm.y && tm.x < tm.z) { te = tm.x; if (te > len) { return 1.0; } c.x += stp.x; tm.x += inv.x; }
    else if (tm.y < tm.z) { te = tm.y; if (te > len) { return 1.0; } c.y += stp.y; tm.y += inv.y; }
    else { te = tm.z; if (te > len) { return 1.0; } c.z += stp.z; tm.z += inv.z; }
    if (all(c == end)) { return 1.0; }
    if (blockAt(c) >= ${BLOCK.LOG}u && !(inside && te < 0.75)) { return 0.0; }
  }
  return 1.0;
}

// One texture repeat per cube face, as in Minecraft. Albedo layers: grass, dirt, sand, the fringe of grass hanging
// over dirt, for trees bark, the rings of a cut log, and leaves (with see-through gaps in their alpha), stone, and planks.
const GRASS = 0;
const DIRT = 1;
const SAND = 2;
const FRINGE = 3;
const BARK = 4;
const RINGS = 5;
const LEAVES = 6;
const STONE = 7;
const PLANK = 8;
const BRICK = 9;
const TILLED = 10;
const RIPPLES = 11; // (normal maps only)

fn tri(uv: vec2f, layer: i32, lod: f32) -> vec3f {
  // (Toon: the texture's last mip, its average colour.)
  let c = textureSampleLevel(albedo, tileSamp, uv, layer, select(lod, 16.0, F.toon.x > 0.5)).rgb;
  return select(c, c * F.normalWeights[2].w, layer == SAND);
}
// Sunlight (0-1) in toon shading's bands: steps with soft edges, halfway through each band.
fn toonBand(x: f32) -> f32 {
  let b = max(F.toon.y, 1.0);
  let xb = clamp(x, 0.0, 1.0) * b;
  let s = max(F.toon.z, 1e-3);
  return (floor(xb) + smoothstep(0.5 - s, 0.5 + s, fract(xb))) / b;
}

// Layer's normal map at uv, in its own terms: x along the texture's u, y up its image (OpenGL style), z out of the
// surface; tilted by the layer's weight (the T panel's normal maps).
fn tnorm(uv: vec2f, layer: i32, lod: f32) -> vec3f {
  let m = textureSampleLevel(normalMaps, tileSamp, uv, layer, lod).xyz * 2.0 - 1.0;
  let k = F.normalWeights[layer >> 2u][layer & 3];
  return normalize(vec3f(m.xy * k, max(m.z, 0.05)));
}
// Surface normal n bent by normal map m, for a texture whose u runs along tu and whose image runs up along tv.
fn bend(n: vec3f, m: vec3f, tu: vec3f, tv: vec3f) -> vec3f {
  let t0 = tu - n * dot(tu, n);
  let t = t0 * inverseSqrt(max(dot(t0, t0), 1e-8));
  let b0 = tv - n * dot(tv, n) - t * dot(tv, t);
  let b = b0 * inverseSqrt(max(dot(b0, b0), 1e-8));
  return m.x * t + m.y * b + m.z * n;
}
const X = vec3f(1.0, 0.0, 0.0);
const Z = vec3f(0.0, 0.0, 1.0);

// The fringe of grass hanging over a side, laid over the dirt by its alpha: u along the side, v down from the top of
// the ground (its top row is the grass edge); clear below one repeat.
fn fringe(u: f32, depth: f32, lod: f32) -> vec4f {
  if (depth < -0.05 || depth >= 1.0) { return vec4f(0.0); }
  // (Toon: a flat band of the grass's colour, grassLip voxels deep.)
  if (F.toon.x > 0.5) { return vec4f(tri(vec2f(0.0), GRASS, 16.0), select(0.0, 1.0, depth * max(F.marks.y, 1.0) < F.toon.w)); }
  let v = clamp(depth, 0.5 / ${TEX_SIZE}.0, 1.0 - 0.5 / ${TEX_SIZE}.0);
  return textureSampleLevel(albedo, tileSamp, vec2f(u, v), FRINGE, lod);
}

// Height of the top of the ground in the column under surface point p: the top face of the highest ground voxel of
// the stack it's in (or a big negative number when that's more than a few voxels up).
fn groundTop(p: vec3f, n: vec3f) -> f32 {
  let c = vec3i(floor(p - n * 0.01));
  var y = c.y;
  for (var i = 0; i < 6; i++) {
    if (!groundAt(vec3i(c.x, y + 1, c.z))) { return f32(y + 1); }
    y++;
  }
  return -1e9;
}

// A tree block's colour: bark on a log's sides, rings on its ends; leaves, a touch lighter or darker block by block.
// (No normal maps: trees are lit by their faces' own normals.)
fn treeAlbedo(p: vec3f, n: vec3f, b: u32, lod: f32) -> vec3f {
  let a = abs(n);
  let uv = select(select(p.xy, p.xz, a.y > 0.5), p.zy, a.x > 0.5);
  if (b == ${BLOCK.LOG}u) {
    // Bark runs up the trunk: the texture's v along y.
    let side = select(vec2f(p.x, -p.y), vec2f(p.z, -p.y), a.x > 0.5);
    return select(tri(side, BARK, lod), tri(p.xz, RINGS, lod), a.y > 0.5);
  }
  let c = vec3i(floor(p - n * 0.01));
  let h = fract(sin(f32(c.x) * 12.9898 + f32(c.y) * 78.233 + f32(c.z) * 37.719) * 43758.5453);
  let leaf = tri(uv, LEAVES, lod) * (0.85 + 0.3 * h);
  // Above the snow line, snow on its tops (SNOW_TUNING trees).
  if (F.snow.w > 0.5 && snowy(f32(c.y) + 1.0, c.xz)) { return mix(leaf, snowOver(leaf, LEAVES), smoothstep(0.5, 0.8, n.y)); }
  return leaf;
}

// A villager's torch (mark m, see above) lighting surface point p with normal n: a soft falloff that reaches zero at
// the torch's reach. No shadows (walls block it only with GI_TUNING.torchShadows: see torchSeen).
fn torchLight(m: vec4f, p: vec3f, n: vec3f) -> vec3f {
  let d = m.xyz - p;
  let dist = length(d);
  let x = min(dist / max(F.torch.w, 0.1), 1.0);
  let window = (1.0 - x * x) * (1.0 - x * x);
  let ndl = max(dot(n, d / max(dist, 1e-3)), 0.0);
  return F.torch.rgb * (m.w - 5.0) * window * ndl / (1.0 + 0.35 * dist * dist);
}

// A coloured light (marks (xyz, -2), c = (colour × strength, reach)) lighting surface point p with normal n: like a
// torch's, but falling off more gently. No shadows.
fn glowLight(at: vec3f, c: vec4f, p: vec3f, n: vec3f) -> vec3f {
  let d = at - p;
  let dist = length(d);
  let x = min(dist / max(c.w, 0.1), 1.0);
  let window = (1.0 - x * x) * (1.0 - x * x);
  let ndl = max(dot(n, d / max(dist, 1e-3)), 0.0);
  return c.rgb * window * ndl / (1.0 + 0.08 * dist * dist);
}

// Fireballs' scorching (after space-miner's red-hot rock). A blast's heat stays hot most of the way out to its reach
// and drops off softly near the edge (x = distance / reach).
fn heatFalloff(x: f32) -> f32 {
  let f = clamp(1.0 - x * x * x * x, 0.0, 1.0);
  return f * f * (3.0 - 2.0 * f);
}
// The heat at p now: the hottest spot's.
fn heatAt(p: vec3f) -> f32 {
  var hot = 0.0;
  for (var i = 0u; i < min(u32(F.scorch[0].x), ${MAX_HOT}u); i++) {
    let s = F.scorch[3u + i * 2u];
    hot = max(hot, F.scorch[4u + i * 2u].x * heatFalloff(length(p - s.xyz) / max(s.w, 0.01)));
  }
  return hot;
}
// Dull red through orange to yellow-white as it gets hotter (t up to 1.5).
fn heatRamp(t: f32) -> vec3f {
  let a = mix(vec3f(0.7, 0.04, 0.005), vec3f(1.0, 0.3, 0.03), smoothstep(0.1, 0.65, t));
  return mix(a, vec3f(1.0, 0.78, 0.38), smoothstep(0.7, 1.3, t));
}
fn hash3(c: vec3f) -> f32 {
  return fract(sin(dot(c, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}
fn valueNoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  let x0 = mix(mix(hash3(i), hash3(i + vec3f(1, 0, 0)), u.x), mix(hash3(i + vec3f(0, 1, 0)), hash3(i + vec3f(1, 1, 0)), u.x), u.y);
  let x1 = mix(mix(hash3(i + vec3f(0, 0, 1)), hash3(i + vec3f(1, 0, 1)), u.x), mix(hash3(i + vec3f(0, 1, 1)), hash3(i + vec3f(1, 1, 1)), u.x), u.y);
  return mix(x0, x1, u.z);
}
// Where the heat bites first (space-miner's deep spots of the height map): patches of 0..1 across the ground.
fn charPatches(p: vec3f) -> f32 {
  let q = p * F.scorch[0].w;
  let v = valueNoise(q) * 0.65 + valueNoise(q * 2.7 + 5.3) * 0.35;
  return smoothstep(0.32, 0.68, v);
}

// The bevel round each brick (or plank) in the texture at uv (one repeat a voxel, v down the image), from where its
// seams are drawn: bricks half a voxel by a quarter, every other row offset by half a brick, with mortar about 3 texels
// wide; planks half a voxel wide, their seams across v only (they run on unbroken along u). Returns the normal's tilt
// out from the brick's middle in the texture's own terms (x along u, y up the image), 0 to 1 at its edge across
// width w (voxels), and how much of the pixel (footprint fp voxels) is on a seam. Both fade out once a pixel is too big
// to show them.
fn blockBevel(uv: vec2f, plank: bool, w: f32, fp: f32) -> vec3f {
  var vv: f32;
  var uu = 0.5;
  var size = vec2f(1e9, 0.5); // a brick's width (u) and height (v), voxels
  var mortar = 0.008;
  if (plank) {
    vv = uv.y * 2.0 + 0.016;
  } else {
    vv = uv.y * 4.0 + 0.023;
    let odd = (i32(floor(vv)) & 1) != 0;
    uu = uv.x * 2.0 + select(0.02, -0.49, odd);
    size = vec2f(0.5, 0.25);
    mortar = 0.012;
  }
  let f = fract(vec2f(uu, vv));
  let e = (0.5 - abs(f - 0.5)) * size - mortar; // from the brick's edge (negative in the mortar)
  let away = sign(f - 0.5);
  let k = select(vec2f(0.0), 1.0 - smoothstep(vec2f(0.0), vec2f(max(w, 1e-4)), e), e >= vec2f(0.0));
  let show = 1.0 - smoothstep(w, 3.0 * w, fp);
  let tilt = away * k * show;
  let seam = (1.0 - smoothstep(-0.5 * fp, 0.5 * fp, min(e.x, e.y))) * (1.0 - smoothstep(0.25 * size.y, 0.5 * size.y, fp));
  return vec3f(tilt.x, -tilt.y, seam);
}

// A clay brick's tilt (xy, in the lighting only) and its seams' stroke (z) at uv on a face: rows of F.clay.w bricks a
// voxel, F.clay.z across, every other row half a brick along, each one a rounded-off rectangle (its corners rounded
// over F.clay2.x) domed like a pillow over F.clay.x from its edges (steepest at the edge), with a groove of mortar
// between them. Hand made (F.clay2.y): each brick a little smaller or larger, off centre, its corners rounder or
// sharper, and leaning a little. fp: a pixel's size there.
fn clayBevel(uv: vec2f, fp: f32) -> vec3f {
  let w = max(F.clay.x, 1e-3);
  let vv = uv.y * F.clay.w + 0.013;
  let odd = (i32(floor(vv)) & 1) != 0;
  let uu = uv.x * F.clay.z + select(0.02, 0.52, odd);
  let size = 1.0 / F.clay.zw;
  let id = floor(vec2f(uu, vv));
  let wob = F.clay2.y;
  let shrink = 0.014 + wob * 0.012 * vec2f(hash3(vec3f(id, 1.0)), hash3(vec3f(id, 2.0)));
  let off = (vec2f(hash3(vec3f(id, 3.0)), hash3(vec3f(id, 4.0))) - 0.5) * wob * 0.012;
  let lean = (vec2f(hash3(vec3f(id, 5.0)), hash3(vec3f(id, 6.0))) - 0.5) * wob * 0.15;
  let half = 0.5 * size - shrink;
  let rc = min(F.clay2.x * mix(1.0, 0.6 + 0.8 * hash3(vec3f(id, 7.0)), wob), min(half.x, half.y));
  let lp = (fract(vec2f(uu, vv)) - 0.5) * size - off; // from the brick's middle (voxels)
  let k = abs(lp) - (half - rc);
  let outer = max(k, vec2f(0.0));
  let e = rc - length(outer) - min(max(k.x, k.y), 0.0); // from the brick's edge (negative in the mortar)
  // The way out of the brick from here: round its corners, else across its nearer edge.
  var away = select(vec2f(0.0, sign(lp.y)), vec2f(sign(lp.x), 0.0), k.x > k.y);
  if (k.x > 0.0 && k.y > 0.0) { away = outer / max(length(outer), 1e-5) * sign(lp); }
  let s = clamp(e / w, 0.0, 1.0);
  let r = 1.0 - s;
  let slope = select(0.0, r / sqrt(max(1.0 - r * r, 0.04)) * 0.35, e >= 0.0);
  let show = 1.0 - smoothstep(0.5 * w, 2.0 * w, fp);
  let tilt = (away * slope + select(vec2f(0.0), lean, e >= 0.0)) * show;
  let seam = (1.0 - smoothstep(-0.5 * fp, 0.5 * fp, e)) * (1.0 - smoothstep(0.25 * size.y, 0.5 * size.y, fp));
  return vec3f(tilt.x, -tilt.y, seam);
}

// The team (OWNER, 0 none) that built in the column of cell.
fn ownerOf(cell: vec3i) -> u32 {
  return textureLoad(owners, clamp(cell.xz, vec2i(0), vec2i(DIMS.xz) - 1), 0).r;
}

fn shade(p: vec3f, n: vec3f, rd: vec3f, t: f32, shadow: f32) -> vec3f {
  // Texture lod from the pixel's footprint on the surface, since screen derivatives break at silhouettes.
  let footprint = select(F.pixel.x * t, F.pixel.x, F.camPos.w > 0.5);
  let texel = footprint * ${TEX_SIZE}.0;
  let cell = vec3i(floor(p - n * 0.01));
  // A bevel (see bevelCuts) is textured as the face it leads on from, unfolded flat across its slope rather than
  // blended triplanar: a top edge's as the top (grass), an upright corner's as its x side. tn: the face's normal, which
  // picks the textures; shift: how far the unfolding moves the texture across the bevel, in voxels.
  let side = sign(vec3f(n.x, 0.0, n.z));
  let topBevel = n.y > 0.45 && n.y < 0.8; // (with a taper's end)
  let cornerBevel = abs(n.y) < 0.4 && abs(n.x) > 0.5 && abs(n.z) > 0.5; // (with a taper's end)
  var tn = n;
  var shift = vec3f(0.0);
  if (topBevel || cornerBevel) {
    let across = select(side, vec3f(0.0, 0.0, side.z), cornerBevel); // the way the bevel slopes, off its face
    tn = select(vec3f(0.0, 1.0, 0.0), vec3f(side.x, 0.0, 0.0), cornerBevel);
    let g = p - vec3f(cell) - 0.5;
    // (√2 - 1): the slope is √2 longer. A taper's end, sloping two ways, isn't unfolded.
    let unfold = select(0.0, 0.41421356, select(abs(n.x) < 0.1 || abs(n.z) < 0.1, abs(n.y) < 0.1, cornerBevel));
    shift = across * max(dot(g, across) - (0.5 - select(F.marks.z, F.marks.w, cornerBevel)), 0.0) * unfold;
  }
  let w0 = pow(abs(tn), vec3f(4.0));
  let w = w0 / (w0.x + w0.y + w0.z);
  let lod = log2(max(texel, 1e-4));
  let lodN = log2(max(texel / max(abs(dot(rd, n)), 0.2), 1e-4));
  let lodX = select(log2(max(texel / max(abs(dot(rd, vec3f(1, 0, 0))), 0.2), 1e-4)), lodN, cornerBevel);
  let lodY = select(log2(max(texel / max(abs(rd.y), 0.2), 1e-4)), lodN, topBevel);
  let lodZ = log2(max(texel / max(abs(rd.z), 0.2), 1e-4));
  // Sand on the beaches and under the water, tops and sides alike, as a layer about two voxels deep over the dirt (so
  // the map's walls are still dirt below it): a whole cube is sand or not, by the height of its top and whether it's
  // one of the top two of ground in its column.
  // The ground's textures span tile voxels a repeat (the tuning's texture tiling): q is p in repeats.
  let tile = max(F.marks.y, 1.0);
  let q = (p + shift) / tile;
  let tl = log2(tile);
  let blk = blockAt(cell);
  let sandy = select(0.0, 1.0, f32(cell.y) + 1.0 <= WATER + 1.5 && !groundAt(cell + vec3i(0, 2, 0)));
  // Sides are dirt, tiled in world space, with the fringe of grass hanging over it from the top of the ground (at the
  // same scale as the dirt, so with tiling it hangs further).
  let gTop = groundTop(p, n);
  let depth = (gTop - p.y) / tile;
  let fx = fringe(q.z, depth, lodX - tl);
  let fz = fringe(q.x, depth, lodZ - tl);
  // Above the snow line, snow where the grass would be: on top, and hanging over the sides as its fringe does.
  let snow = snowy(gTop, cell.xz);
  let fxc = select(fx.rgb, snowOver(fx.rgb, GRASS), snow);
  let fzc = select(fz.rgb, snowOver(fz.rgb, GRASS), snow);
  let sideX = mix(mix(tri(q.zy, DIRT, lodX - tl), fxc, fx.a), tri(q.zy, SAND, lodX - tl), sandy);
  let sideZ = mix(mix(tri(q.xy, DIRT, lodZ - tl), fzc, fz.a), tri(q.xy, SAND, lodZ - tl), sandy);
  // The top projection is grass (or snow) where the surface faces up, fading to dirt on steep slopes and undersides.
  let grassAmt = smoothstep(0.55, 0.8, tn.y) * (1.0 - sandy);
  let grassTop = tri(q.xz, GRASS, lodY - tl);
  let top = mix(mix(tri(q.xz + vec2f(0.37, 0.71), DIRT, lodY - tl), select(grassTop, snowOver(grassTop, GRASS), snow), grassAmt), tri(q.xz, SAND, lodY - tl), sandy);
  var base = sideX * w.x + top * w.y + sideZ * w.z;
  // The normal maps, blended the same way and bent around n (so a bevel's follow its slope). Each projection's image
  // runs up along -y on the sides (q.zy, q.xy) and -z on top (q.xz); the fringe's (v down from the grass) along +y,
  // hence its flipped y.
  // (Not in the far blur, where they wouldn't show.)
  let detail = length(p - F.camPos.xyz) < F.screen.z && F.toon.x < 0.5; // (nor in toon shading)
  let fv = clamp(depth, 0.5 / ${TEX_SIZE}.0, 1.0 - 0.5 / ${TEX_SIZE}.0);
  let flipY = vec3f(1.0, -1.0, 1.0);
  var nb = n;
  if (detail) {
  let mX = mix(mix(tnorm(q.zy, DIRT, lodX - tl), tnorm(vec2f(q.z, fv), FRINGE, lodX - tl) * flipY, fx.a), tnorm(q.zy, SAND, lodX - tl), sandy);
  let mZ = mix(mix(tnorm(q.xy, DIRT, lodZ - tl), tnorm(vec2f(q.x, fv), FRINGE, lodZ - tl) * flipY, fz.a), tnorm(q.xy, SAND, lodZ - tl), sandy);
  let mTop = mix(mix(tnorm(q.xz + vec2f(0.37, 0.71), DIRT, lodY - tl), tnorm(q.xz, GRASS, lodY - tl), grassAmt), tnorm(q.xz, SAND, lodY - tl), sandy);
  nb = bend(n, mX, Z, -UP) * w.x + bend(n, mTop, X, -Z) * w.y + bend(n, mZ, X, -UP) * w.z;
  }
  // Ripples on sand's tops, a normal map of their own at their own scale, in toon shading too (short of the far blur).
  if (F.ripples.x > 0.5 && sandy > 0.5 && tn.y > 0.0 && blk == ${BLOCK.GROUND}u && length(p - F.camPos.xyz) < F.screen.z) {
    let rs = max(F.ripples.y, 0.1);
    let rm = textureSampleLevel(normalMaps, tileSamp, (p + shift).xz / rs, RIPPLES, lodY - log2(rs)).xyz * 2.0 - 1.0;
    nb += (bend(n, normalize(vec3f(rm.xy * F.ripples.z, max(rm.z, 0.05))), X, -Z) - n) * w.y;
  }
  let faceLod = select(select(lodZ, lodY, abs(tn.y) > 0.5), lodX, abs(tn.x) > 0.5);
  if (blk == ${BLOCK.STONE}u || blk == ${BLOCK.IRON}u || blk == ${BLOCK.GOLD}u) {
    let a = abs(tn);
    let uv = select(select(q.xy, q.xz, a.y > 0.5), q.zy, a.x > 0.5);
    base = tri(uv, STONE, faceLod - tl);
    if (detail) { nb = bend(n, tnorm(uv, STONE, faceLod - tl), select(X, Z, a.x > 0.5), select(-UP, -Z, a.y > 0.5)); }
    // Ore: flecks of its metal in the stone (the chunks sticking out of its faces are the units renderer's, see
    // ores.js).
    if (blk != ${BLOCK.STONE}u) {
      let fc = floor(p * 7.0 + n * 0.01);
      let f = fract(sin(dot(fc, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
      let metal = select(vec3f(0.62, 0.42, 0.3), vec3f(1.0, 0.68, 0.12), blk == ${BLOCK.GOLD}u);
      base = mix(base, metal, smoothstep(0.78, 0.86, f) * 0.85);
    }
    // Above the snow line, snow on its top and hanging over its sides as the grass's fringe does over dirt.
    if (snow) {
      let fr = select(fz, fx, a.x > 0.5);
      base = select(mix(base, snowOver(base, STONE), fr.a), snowOver(base, STONE), a.y > 0.5 && tn.y > 0.0);
    }
  } else if (blk == ${BLOCK.OBSIDIAN}u) {
    // Obsidian: the stone's texture, darkened to near black glass (only a little of its grain left), with a glint
    // that runs across a face as the view to it turns.
    let a = abs(tn);
    let uv = select(select(q.xy, q.xz, a.y > 0.5), q.zy, a.x > 0.5);
    let s = tri(uv, STONE, faceLod - tl);
    base = F.obsidian.rgb * mix(1.0, dot(s, vec3f(0.299, 0.587, 0.114)) * 2.2, F.obsidian.w);
    let v = normalize(F.camPos.xyz - p);
    base *= 1.0 + F.gi2.y * 6.0 * pow(1.0 - abs(dot(v, n)), 4.0);
    if (detail) { nb = bend(n, tnorm(uv, STONE, faceLod - tl), select(X, Z, a.x > 0.5), select(-UP, -Z, a.y > 0.5)); }
  } else if (blk == ${BLOCK.PLANK}u || blk == ${BLOCK.BRICK}u) {
    // Planks and bricks run across the sides (the texture's v up the wall) and lie flat on top.
    let a = abs(n);
    let side = select(vec2f(p.x, -p.y), vec2f(p.z, -p.y), a.x > 0.5);
    let uv = select(side, p.xz, a.y > 0.5);
    let plank = blk == ${BLOCK.PLANK}u;
    let layer = select(BRICK, PLANK, plank);
    base = tri(uv, layer, faceLod);
    // What a team built: its colour in place of the texture.
    let own = ownerOf(cell);
    if (own > 0u) { base = select(F.teamBricks[own - 1u].rgb, F.teamPlanks[own - 1u].rgb, plank); }
    // Each brick's or plank's bevel (in the lighting only), with or without the texture's normal map; in toon
    // shading, its seams as strokes.
    let bw = select(F.blocks.xy, F.blocks.zw, plank);
    let bev = blockBevel(uv, plank, bw.x, footprint);
    let tu = select(X, Z, a.x > 0.5 && a.y <= 0.5);
    let tv = select(UP, -Z, a.y > 0.5);
    if (detail) {
      nb = bend(n, normalize(tnorm(uv, layer, faceLod) + vec3f(bev.xy * bw.y, 0.0)), tu, tv);
    } else if (length(p - F.camPos.xyz) < F.screen.z) {
      nb = bend(n, normalize(vec3f(bev.xy * bw.y, 1.0)), tu, tv);
    }
    if (F.toon.x > 0.5) { base = mix(base, F.toonColor.rgb, bev.z * F.toonSobel.w); }
  } else if (blk == ${BLOCK.CLAY}u) {
    // Clay bricks: dirt's colour, laid like bricks (across the sides, flat on top), each rounded in the lighting (in
    // toon shading too, short of the far blur) with its seams as strokes in toon shading.
    let a = abs(n);
    let side = select(vec2f(p.x, -p.y), vec2f(p.z, -p.y), a.x > 0.5);
    let uv = select(side, p.xz, a.y > 0.5);
    base = tri(uv, DIRT, faceLod);
    let own = ownerOf(cell); // (a team's: its colour in place of the texture)
    if (own > 0u) { base = F.teamClay[own - 1u].rgb; }
    let bev = clayBevel(uv, footprint);
    let tu = select(X, Z, a.x > 0.5 && a.y <= 0.5);
    let tv = select(UP, -Z, a.y > 0.5);
    if (detail) {
      nb = bend(n, normalize(tnorm(uv, DIRT, faceLod) + vec3f(bev.xy * F.clay.y, 0.0)), tu, tv);
    } else if (length(p - F.camPos.xyz) < F.screen.z) {
      nb = bend(n, normalize(vec3f(bev.xy * F.clay.y, 1.0)), tu, tv);
    }
    if (F.toon.x > 0.5) { base = mix(base, F.toonColor.rgb, bev.z * F.toonSobel.w); }
  } else if (blk == ${BLOCK.FARM}u) {
    // A farm: tilled rows on top (one repeat a voxel, so the wheat stands on its ridges, see farm.js), plain dirt on its
    // sides (no grass fringe). The rows are only in the normal map, so like bricks' and planks' bevels they're drawn
    // whatever the ground's normal maps do (in toon shading too), short of the far blur.
    let uv = (p + shift).xz;
    let dX = tri(q.zy, DIRT, lodX - tl);
    let dZ = tri(q.xy, DIRT, lodZ - tl);
    base = dX * w.x + tri(uv, TILLED, lodY) * w.y + dZ * w.z;
    if (detail) {
      nb = bend(n, tnorm(q.zy, DIRT, lodX - tl), Z, -UP) * w.x + bend(n, tnorm(uv, TILLED, lodY), X, -Z) * w.y
        + bend(n, tnorm(q.xy, DIRT, lodZ - tl), X, -UP) * w.z;
    } else if (length(p - F.camPos.xyz) < F.screen.z) {
      nb = n * (w.x + w.z) + bend(n, tnorm(uv, TILLED, lodY), X, -Z) * w.y;
    }
  } else if (blk != ${BLOCK.GROUND}u) {
    base = treeAlbedo(p, n, blk, faceLod);
    nb = n;
  }
  // Ripples on the snow's tops (on the ground's where grass would be, and stone's): sand's turned a quarter round (the
  // image sampled at (-z, x), its slopes turned with it) and inside out (the slopes the other way).
  let snowTop = select(0.0, w.y * grassAmt, blk == ${BLOCK.GROUND}u)
    + select(0.0, 1.0, (blk == ${BLOCK.STONE}u || blk == ${BLOCK.IRON}u || blk == ${BLOCK.GOLD}u) && abs(tn.y) > 0.5);
  if (snow && F.snowRipples.x > 0.5 && tn.y > 0.0 && snowTop > 0.0 && length(p - F.camPos.xyz) < F.screen.z) {
    let rs = max(F.snowRipples.y, 0.1);
    let at = (p + shift).xz;
    let rm = textureSampleLevel(normalMaps, tileSamp, vec2f(-at.y, at.x) / rs, RIPPLES, lodY - log2(rs)).xyz * 2.0 - 1.0;
    nb += (bend(n, normalize(vec3f(vec2f(rm.y, -rm.x) * F.snowRipples.z, max(rm.z, 0.05))), X, -Z) - n) * snowTop;
  }
  nb = normalize(nb);
  // Wet (darker) just above the waterline and below it.
  base *= 1.0 - 0.25 * (1.0 - smoothstep(WATER - 0.2, WATER + 0.5, p.y));
  // Scorched by fireballs: red-hot where one burst, glowing first in the patches, then all over; charred as it cools.
  // Each blast's char is a sphere round its centre in space: on any voxel that was there (charTex), whatever stood in
  // front of it, darkest within charFade voxels of the centre and fading out to its edge; with its blast mark
  // (textures/blast.png) projected along the way the fireball flew. Both multiply the ground darker; the darkest
  // char of the blasts reaching here, and every one's mark.
  var heatGlow = vec3f(0.0);
  if (textureLoad(charTex, cell, 0).r > 0.5) {
    let hot = heatAt(p);
    let lows = charPatches(p);
    let glowT = clamp(hot * (lows * 0.85 + 0.15 * hot) * 1.4, 0.0, 1.5);
    heatGlow = heatRamp(glowT) * glowT * glowT * F.scorch[0].y;
    var dark = 0.0;
    var mark = 1.0;
    let slots = textureLoad(blastCells, vec3i(floor(p * 0.5)), 0);
    for (var k = 0; k < ${BLAST_SLOTS}; k++) {
      let id = slots[k];
      if (id == 0u) { continue; }
      let a = blastList[id * 2u];
      let b = blastList[id * 2u + 1u];
      let rel = p - a.xyz;
      let dist = length(rel);
      let reach = max(a.w, 0.01);
      if (dist >= reach) { continue; }
      let x = dist / reach;
      // Char only as the glow fades (the most heat it had here: the blast's, over the char's reach).
      let peak = F.scorch[2].x * heatFalloff(x);
      let cooled = 1.0 - clamp(hot / max(peak, 1e-3), 0.0, 1.0);
      let ft = clamp((dist - F.scorch[1].x) / max(reach - F.scorch[1].x, 0.01), 0.0, 1.0);
      let fade = (1.0 - ft * ft) * (1.0 - ft * ft);
      dark = max(dark, F.scorch[0].z * fade * (1.0 - F.scorch[2].y * (1.0 - lows)) * cooled);
      // The blast mark, across the flight (turned at random), on faces towards where it came from most.
      if (F.scorch[1].y > 0.0 && F.scorch[1].w > 0.5) {
        let fly = b.xyz;
        let side = normalize(cross(select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(fly.y) > 0.9), fly));
        let turn = b.w * 6.2831853;
        let ax = side * cos(turn) + cross(fly, side) * sin(turn);
        let ay = cross(fly, ax);
        let size = reach * max(F.scorch[1].z, 0.05);
        let uv = vec2f(dot(rel, ax), dot(rel, ay)) / size * 0.5 + 0.5;
        if (all(uv > vec2f(0.0)) && all(uv < vec2f(1.0))) {
          // Lying almost along the flight, the mark is stretched out a long way and picks blurry mips: at most 32²,
          // and faded to nothing over the last few of its texels round the square's edge, so the square never shows.
          let lodM = min(log2(max(footprint * 512.0 / (2.0 * size) / max(abs(dot(n, fly)), 0.25), 1e-4)), 4.0);
          let margin = max(0.06, exp2(lodM) / 512.0 * 3.0);
          let edge = smoothstep(0.0, margin, min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y)));
          let facing = mix(0.4, 1.0, clamp(-dot(n, fly) * 2.0, 0.0, 1.0));
          // (Inside the sphere only, fading out before its edge: the projection runs on past it along the flight.)
          let inside = 1.0 - smoothstep(0.7, 1.0, x);
          mark *= mix(1.0, textureSampleLevel(blastMark, linearSamp, uv, lodM).r, F.scorch[1].y * facing * inside * edge * cooled);
        }
      }
    }
    base *= (1.0 - clamp(dark, 0.0, 1.0)) * mark;
  }

  let L = F.sun.xyz;
  var diffuse = max(dot(nb, L), 0.0) * shadow;
  if (F.toon.x > 0.5) { diffuse = toonBand(diffuse); }
  var ao = cubeAO(p, n);
  if (F.toon.x > 0.5) { ao = max(1.0 - (1.0 - ao) * F.toonSobel.z, 0.0); }
  var amb = ambient(nb);
  if (F.gi.x > 0.5) {
    let pl = probeLight(p, n);
    if (pl.a > 0.5) {
      let lit = select(amb * pl.rgb, pl.rgb, F.gi.x > 1.5);
      amb = max(mix(amb, lit, F.gi.y), amb * F.gi.w);
    }
  }
  var col = base * (diffuse * lightIlluminance() / PI + amb * ao) + heatGlow;

  // Units' blob shadows, selection rings and move goals.
  let lineW = max(0.12, footprint * 1.2);
  for (var i = 0u; i < u32(F.marks.x); i++) {
    let m = marks[i];
    if (m.w < -1.5) {
      col += base * glowLight(m.xyz, marks[i + 1u], p, nb);
      i++;
      continue;
    }
    if (m.w < -0.5) {
      // A priest's heal pulse (m2 = (radius, how far through 0-1, -, -)): a soft gold-green ring spreading out over the
      // ground from it to its reach, and a glow inside, both fading as it goes.
      let m2 = marks[i + 1u];
      i++;
      let dy = p.y - m.y;
      if (dy < -2.5 || dy > 2.0) { continue; }
      let r = length(p.xz - m.xz);
      let k = m2.y;
      let front = m2.x * (1.0 - (1.0 - k) * (1.0 - k));
      let fadeOut = 1.0 - k;
      let ring = 1.0 - smoothstep(0.0, max(0.35, lineW), abs(r - front));
      let inside = (1.0 - smoothstep(front - 0.5, front, r)) * 0.25;
      col += vec3f(0.9, 1.4, 0.55) * (ring + inside) * fadeOut * fadeOut * 0.6 * (1.0 - smoothstep(1.0, 2.5, abs(dy)));
      continue;
    }
    if (m.w > 4.5) {
      if (F.gi2.x > 0.5 && distance(m.xyz, p) < F.torch.w) { col += base * torchLight(m, p, nb) * torchSeen(p, n, m.xyz); }
      else if (F.gi2.x < 0.5) { col += base * torchLight(m, p, nb); }
      continue;
    }
    if (m.w > 3.5) { i++; continue; } // a building's ghost (drawn by fillGhosts)
    if (m.w > 2.5) {
      // A flatten box: corners (m.xz, m2.xz), plane at m.y; m2.w = 1 once it's an order, 0 while being drawn.
      // Ground above the plane (to dig) is tinted green, and the box is outlined.
      let m2 = marks[i + 1u];
      i++;
      let edge = max(max(m.x - p.x, p.x - m2.x), max(m.z - p.z, p.z - m2.z)); // < 0 inside
      if (edge < 0.0) {
        // Whole cubes: green for the ones to dig (those below are drawn as green ghosts by fillGhosts).
        if (f32(cell.y) >= m.y - 0.5) {
          col = mix(col, vec3f(0.3, 1.2, 0.4) * (0.35 + dot(col, vec3f(0.3, 0.59, 0.11))), 0.6);
        }
      }
      let lineCol = select(vec3f(1.6, 1.6, 1.5), vec3f(1.7, 1.3, 0.4), m2.w > 0.5);
      col = mix(col, lineCol, (1.0 - smoothstep(0.0, lineW, abs(edge))) * 0.9);
      continue;
    }
    let dy = p.y - m.y;
    if (dy < -1.5 || dy > 1.0) { continue; }
    let r = length(p.xz - m.xz);
    if (m.w < 1.5) {
      col *= 1.0 - 0.45 * (1.0 - smoothstep(0.15, 0.6, r));
      if (m.w > 0.5) {
        col = mix(col, vec3f(0.5, 1.6, 0.6), 1.0 - smoothstep(0.0, lineW, abs(r - 0.75)));
      }
    } else {
      let pulse = 0.35 + 0.15 * sin(F.pixel.y * 6.0);
      col = mix(col, vec3f(1.6, 1.4, 0.4), 1.0 - smoothstep(0.0, lineW, abs(r - pulse)));
    }
  }

  // Brush cursor: tint inside the sphere, a bright rim where it meets the surface.
  if (F.brush.w > 0.0) {
    let r = length(p - F.brush.xyz);
    let inside = 1.0 - smoothstep(F.brush.w - 0.6, F.brush.w, r);
    let rim = 1.0 - smoothstep(0.0, max(0.6, footprint * 1.5), abs(r - F.brush.w));
    col = mix(col, F.brushColor.rgb, inside * 0.18 * F.brushColor.a);
    col = mix(col, F.brushColor.rgb * 1.4, rim * 0.85);
  }
  return col;
}

struct Ray { ro: vec3f, rd: vec3f }
// The NDC of full-resolution pixel px's centre (for the passes drawn at a lower resolution).
fn pixelNdc(px: vec2f) -> vec2f {
  let c = min(px, F.screen.xy - 1.0) + 0.5;
  return vec2f(c.x / F.screen.x * 2.0 - 1.0, 1.0 - c.y / F.screen.y * 2.0);
}
fn pixelRay(ndc: vec2f) -> Ray {
  let near = F.invViewProj * vec4f(ndc, 0.0, 1.0);
  let far = F.invViewProj * vec4f(ndc, 1.0, 1.0);
  let ro = near.xyz / near.w;
  return Ray(ro, normalize(far.xyz / far.w - ro));
}

// G-buffer: x = hit distance along the pixel's ray (-1 = sky), yzw = surface normal. (Or, for the march, the coarse
// pass's start distances.)
@group(1) @binding(0) var gbuf: texture_2d<f32>;
@group(1) @binding(1) var shadowTex: texture_2d<f32>;

// The coarse pass: one ray for each COARSE × COARSE block of pixels, through the block's middle, marched as a cone
// wide enough to hold every pixel's ray in the block. It stops where the ground comes within the cone, so up to there
// all of the block's rays are in the air: each one's march starts there instead of where it enters the map, skipping
// the empty air (and most of the creeping past ground it just misses at a low angle).
const COARSE = ${COARSE};
@fragment
fn fsCoarse(in: VOut) -> @location(0) vec4f {
  let r = pixelRay(pixelNdc(floor(in.pos.xy) * f32(COARSE) + f32(COARSE) * 0.5));
  let range = boxRange(r.ro, r.rd);
  if (range.x >= range.y) { return vec4f(-1.0); }
  // The cone's radius at t: the block's half diagonal (and a little) in pixels, as wide as a pixel is there.
  let ortho = F.camPos.w > 0.5;
  let spread = f32(COARSE) * 0.75 + 0.5;
  var t = range.x;
  for (var i = 0; i < 160; i++) {
    let p = r.ro + r.rd * t;
    let s = sdf(p);
    var d = select(refine(p, s, false), s, s > R * 0.97);
    if (s > R * 0.97) { d += brickSkip(p); }
    let cone = spread * select(F.pixel.x * t, F.pixel.x, ortho) + 0.05;
    if (d <= cone) { break; }
    t += (d - cone) * 0.8;
    if (t > range.y) { break; }
  }
  return vec4f(t);
}

@fragment
fn fsMarch(in: VOut) -> @location(0) vec4f {
  let r = pixelRay(in.ndc);
  let range = boxRange(r.ro, r.rd);
  if (range.x >= range.y) { return vec4f(-1.0, 0.0, 1.0, 0.0); }
  // Start where the coarse pass found the block's rays all still in the air (backed off a touch), if that's further.
  let coarse = textureLoad(gbuf, vec2i(in.pos.xy) / COARSE, 0).x;
  let start = select(range.x, max(range.x, coarse - 0.25), coarse > range.x + 0.25);
  if (start >= range.y) { return vec4f(-1.0, 0.0, 1.0, 0.0); }
  let h = march(r.ro, r.rd, start, range.y);
  if (h.x < 0.0) { return vec4f(-1.0, 0.0, 1.0, 0.0); }
  var n: vec3f;
  if (h.x == range.x && range.x > 0.0) {
    n = entryNormal(r.ro, r.rd, h.x);
  } else if (dot(h.yzw, h.yzw) > 0.0) {
    n = normalize(h.yzw); // cube face from the DDA step: exact and free
  } else {
    n = normalAt(r.ro + r.rd * h.x);
  }
  return vec4f(h.x, n);
}

// The sun shadow, at half resolution: one pixel for each 2 × 2 block, for the block's top left pixel (the shade pass
// blends the four nearest, by how alike their depths and normals are to its own).
@fragment
fn fsShadow(in: VOut) -> @location(0) vec4f {
  let full = vec2i(in.pos.xy) * 2;
  let g = textureLoad(gbuf, full, 0);
  if (g.x < 0.0) { return vec4f(1.0); }
  let r = pixelRay(pixelNdc(vec2f(full)));
  let p = r.ro + r.rd * g.x;
  let n = g.yzw;
  if (dot(n, F.sun.xyz) <= 0.0 || F.sun.y < -0.01) { return vec4f(0.0); } // facing away, or night: no need to march
  // Shadows are cast by sharp cubes (see softShadow), so from a bevel start clear of the corner it cut off.
  let a = abs(n);
  let onBevel = max(max(a.x, a.y), a.z) < 0.99;
  return vec4f(softShadow(p + n * (0.05 + select(0.0, max(F.marks.z, F.marks.w) * 0.71, onBevel)), F.sun.xyz));
}

// The empty voxels a flatten box will fill, drawn as see-through green cubes over what's behind them, and likewise
// the Raise/Lower box. (Buildings are ghost cubes now, see units-render.js.)
// Along a pixel's ray everything before the terrain hit is air, so the ghosts it sees are just where the ray crosses
// the box below its plane; the face where it enters gets the voxel grid drawn on it.
fn fillGhosts(col: vec3f, ro: vec3f, rd: vec3f, tHit: f32, footprint: f32) -> vec3f {
  var c = col;
  for (var i = 0u; i < u32(F.marks.x); i++) {
    let m = marks[i];
    if (m.w < 2.5 || m.w > 4.5) { continue; }
    let m2 = marks[i + 1u];
    i++;
    let building = m.w > 3.5;
    let lo = select(vec3f(m.x, 1.0, m.z), m.xyz, building);
    let hi = select(vec3f(m2.x, m.y, m2.z), m2.xyz, building);
    let inv = 1.0 / rd;
    let a = (lo - ro) * inv;
    let b = (hi - ro) * inv;
    let tn = min(a, b);
    let tf = max(a, b);
    let t0 = max(max(tn.x, tn.y), max(tn.z, 0.0));
    let t1 = min(min(tf.x, tf.y), min(tf.z, tHit));
    if (t1 <= t0) { continue; }
    let len = t1 - t0;
    var green = vec3f(0.25, 1.1, 0.35);
    var lineCol = vec3f(0.6, 1.6, 0.7);
    // White: an order a new game's inventory can't cover, a box's (w 4) state 3, a flatten box's 2 (live) or -1 (being
    // drawn).
    let short = select((m2.w > 1.5) || (m2.w < -0.5), m2.w > 2.5, building);
    if (short) { // (white: what the inventory can't cover)
      green = vec3f(1.1, 1.18, 1.35);
      lineCol = vec3f(1.5, 1.6, 1.8);
    }
    c = mix(c, green * 0.8, 0.22 + 0.5 * (1.0 - exp(-len * 0.35)));
    if (t0 < tHit - 0.01) {
      // The voxel grid on the face the ray comes in through.
      let pe = ro + rd * t0;
      let f = abs(fract(pe + 0.5) - 0.5); // distance to the nearest voxel boundary on each axis
      let onFace = select(select(vec3f(f.y, f.z, 9.0), vec3f(f.x, f.y, 9.0), tn.z >= max(tn.x, tn.y)),
                          vec3f(f.x, f.z, 9.0), tn.y >= max(tn.x, tn.z));
      let w = max(0.04, footprint * (t0 / max(tHit, 1e-3)) * 1.2);
      let line = 1.0 - smoothstep(0.0, w, min(onFace.x, onFace.y));
      c = mix(c, lineCol, line * 0.75);
    }
  }
  return c;
}

// The half-resolution shadow at full-resolution pixel px (G-buffer g): the four half-resolution pixels round it,
// weighted bilinearly and by how near their own pixel's depth and normal are to its own, so shadow doesn't bleed across
// an edge onto a surface further off or facing another way.
fn upShadow(px: vec2i, g: vec4f) -> f32 {
  let size = vec2i(textureDimensions(shadowTex));
  let f = vec2f(px) * 0.5; // in half-resolution pixels (each sits on its block's top left pixel)
  let base = vec2i(floor(f));
  let w = f - floor(f);
  var sum = 0.0;
  var weight = 0.0;
  var nearest = 1.0;
  var best = 1e9;
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      let q = clamp(base + vec2i(i, j), vec2i(0), size - 1);
      let gq = textureLoad(gbuf, q * 2, 0);
      let sh = textureLoad(shadowTex, q, 0).r;
      let dt = abs(gq.x - g.x);
      let k = select(1.0 - w.x, w.x, i == 1) * select(1.0 - w.y, w.y, j == 1)
        * exp(-dt / (0.02 * g.x + 0.05)) * pow(max(dot(gq.yzw, g.yzw), 0.0), 8.0);
      sum += sh * k;
      weight += k;
      if (dt < best) { best = dt; nearest = sh; }
    }
  }
  return select(nearest, sum / weight, weight > 1e-4);
}

struct ShadeOut { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 }

// Toon shading's strokes: how much pixel px (its ray's hit t along it) is on an edge with the ground (or the sky)
// toonEdge.x voxels or more behind it (and further away from the eye by toonEdge.y a voxel), within toonEdge.z pixels.
fn edgeOf(px: vec2i, t: f32) -> f32 {
  if (F.toonColor.w > 0.5) { return sobelEdge(px, t); }
  let w = max(F.toonEdge.z, 0.5);
  let far = F.toonEdge.x + t * F.toonEdge.y;
  let size = vec2i(F.screen.xy) - 1;
  var e = 0.0;
  for (var k = 0; k < 8; k++) {
    let a = f32(k) * 0.78539816;
    let q = clamp(px + vec2i(round(vec2f(cos(a), sin(a)) * w)), vec2i(0), size);
    let tn = textureLoad(gbuf, q, 0).x;
    let behind = select(tn - t, 1e9, tn < 0.0);
    e = max(e, smoothstep(far, far * 1.3, behind));
  }
  return e * F.toonEdge.w;
}

// Or by a Sobel filter over the 3×3 G-buffer pixels toonEdge.z / 2 apart round px (so the stroke, which falls on both
// sides of an edge, is about as wide): its depth gradient against the same threshold (the depth jump across the
// kernel, or twice a step's worth on a slope), and, when toonSobel.x > 0, its normals' gradient (how far apart they are
// across the kernel, 0-2) against that, each at its own strength. Sky counts as far.
fn sobelEdge(px: vec2i, t: f32) -> f32 {
  let s = max(F.toonEdge.z * 0.5, 1.0);
  let size = vec2i(F.screen.xy) - 1;
  let n0 = textureLoad(gbuf, px, 0).yzw;
  var d: array<f32, 9>;
  var n: array<vec3f, 9>;
  for (var k = 0; k < 9; k++) {
    let q = clamp(px + vec2i(round(vec2f(f32(k % 3 - 1), f32(k / 3 - 1)) * s)), vec2i(0), size);
    let g = textureLoad(gbuf, q, 0);
    d[k] = select(g.x, t + 1e4, g.x < 0.0);
    n[k] = select(g.yzw, n0, g.x < 0.0);
  }
  let dx = (d[2] + 2.0 * d[5] + d[8]) - (d[0] + 2.0 * d[3] + d[6]);
  let dy = (d[6] + 2.0 * d[7] + d[8]) - (d[0] + 2.0 * d[1] + d[2]);
  let far = F.toonEdge.x + t * F.toonEdge.y;
  var e = smoothstep(far, far * 1.3, length(vec2f(dx, dy)) * 0.25) * F.toonEdge.w;
  if (F.toonSobel.x > 0.0) {
    let nx = (n[2] + 2.0 * n[5] + n[8]) - (n[0] + 2.0 * n[3] + n[6]);
    let ny = (n[6] + 2.0 * n[7] + n[8]) - (n[0] + 2.0 * n[1] + n[2]);
    let th = F.toonSobel.x;
    e = max(e, smoothstep(th, th * 1.3, sqrt(dot(nx, nx) + dot(ny, ny)) * 0.25) * F.toonSobel.y);
  }
  return e;
}

// Also writes the hit's depth, so units drawn afterwards with rasterisation hide behind the terrain.
@fragment
fn fsShade(in: VOut) -> ShadeOut {
  let px = vec2i(in.pos.xy);
  let g = textureLoad(gbuf, px, 0);
  let r = pixelRay(in.ndc);
  // A pixel's angular size, for the sun's disc and the clouds' detail (orthographic rays are all parallel).
  let pixAng = select(F.pixel.x, 0.0, F.camPos.w > 0.5);
  var col: vec3f;
  var depth = 1.0;
  if (g.x >= 0.0) {
    let p = r.ro + r.rd * g.x;
    let clip = F.viewProj * vec4f(p, 1.0);
    depth = clamp(clip.z / clip.w, 0.0, 1.0);
    let range = boxRange(r.ro, r.rd);
    let tc = select(g.x, g.x - range.x, F.camPos.w > 0.5);
    var c = shade(p, g.yzw, r.rd, tc, upShadow(px, g));
    if (F.toon.x > 0.5) { c = mix(c, F.toonColor.rgb, edgeOf(px, g.x)); }
    c = fillGhosts(c, r.ro, r.rd, g.x, select(F.pixel.x * g.x, F.pixel.x, F.camPos.w > 0.5));
    // Fog by distance from the orbit target's depth, so zooming out doesn't fog everything.
    let fog = 1.0 - exp(-max(tc - F.pixel.z, 0.0) * fogDensity());
    col = mix(c, fogColor(r.rd) * 0.95, fog);
  } else {
    col = skyBackground(r.rd, pixAng);
  }
  // Tone map and let the sRGB target encode.
  col = col / (1.0 + col * 0.12);
  return ShadeOut(vec4f(col, 1.0), depth);
}
`;

export class TerrainRenderer {
  // sky: the Sky lighting the terrain; normals: the albedo's normal maps (a texture array, layer for layer).
  constructor(device, format, field, albedo, sky, normals, skyVis) {
    this.sky = sky;
    this.device = device;
    this.format = format;
    const module = device.createShaderModule({ label: 'terrain raymarch', code: RENDER_WGSL });
    const FRAG = GPUShaderStage.FRAGMENT;
    const sceneLayout = device.createBindGroupLayout({
      label: 'terrain scene',
      entries: [
        { binding: 0, visibility: FRAG, buffer: { type: 'uniform' } },
        { binding: 1, visibility: FRAG, texture: { viewDimension: '3d' } },
        { binding: 2, visibility: FRAG, texture: { viewDimension: '3d', sampleType: 'uint' } },
        { binding: 3, visibility: FRAG, texture: { viewDimension: '2d-array' } },
        { binding: 4, visibility: FRAG, sampler: {} },
        { binding: 5, visibility: FRAG, sampler: {} },
        { binding: 6, visibility: FRAG, texture: { viewDimension: '3d', sampleType: 'uint' } },
        { binding: 7, visibility: FRAG, buffer: { type: 'read-only-storage' } },
        { binding: 8, visibility: FRAG, texture: { viewDimension: '2d-array' } },
        { binding: 9, visibility: FRAG, texture: { viewDimension: '3d' } },
        { binding: 10, visibility: FRAG, texture: { viewDimension: '3d', sampleType: 'uint' } },
        { binding: 11, visibility: FRAG, buffer: { type: 'read-only-storage' } },
        { binding: 12, visibility: FRAG, texture: {} },
        { binding: 13, visibility: FRAG, texture: { viewDimension: '3d' } },
        { binding: 14, visibility: FRAG, texture: { viewDimension: '3d' } },
        { binding: 15, visibility: FRAG, texture: { sampleType: 'uint' } },
      ],
    });
    this.gbufLayout = device.createBindGroupLayout({
      label: 'g-buffer',
      entries: [{ binding: 0, visibility: FRAG, texture: { sampleType: 'unfilterable-float' } }],
    });
    this.shadeLayout = device.createBindGroupLayout({
      label: 'g-buffer + shadow',
      entries: [
        { binding: 0, visibility: FRAG, texture: { sampleType: 'unfilterable-float' } },
        { binding: 1, visibility: FRAG, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    const pipeline = (entryPoint, groups, target, depth) => device.createRenderPipeline({
      label: entryPoint,
      layout: device.createPipelineLayout({ bindGroupLayouts: groups }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint, targets: [{ format: target }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: depth ? { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'always' } : undefined,
    });
    this.coarsePipeline = pipeline('fsCoarse', [sceneLayout], 'r32float');
    this.marchPipeline = pipeline('fsMarch', [sceneLayout, this.gbufLayout], 'rgba32float');
    this.shadowPipeline = pipeline('fsShadow', [sceneLayout, this.gbufLayout], 'r8unorm');
    this.shadePipeline = pipeline('fsShade', [sceneLayout, this.shadeLayout, sky.layout], format, true);
    this.marks = device.createBuffer({ label: 'ground marks', size: MAX_MARKS * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.markData = new Float32Array(MAX_MARKS * 4);

    this.uniforms = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // The blast mark (unused until loadBlastMark fills it), 512² with mips.
    this.blastMark = device.createTexture({
      label: 'blast mark', size: [512, 512], format: 'r8unorm', mipLevelCount: 10,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // Who built each column (Terrain.owners), uploaded when it changes (see draw).
    this.terrain = field.terrain;
    this.ownerTex = device.createTexture({ label: 'owners', size: [SIZE[0], SIZE[2]], format: 'r8uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.ownersVersion = -1;
    const linearSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const tileSamp = device.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 1,
    });
    this.sceneGroup = device.createBindGroup({
      layout: sceneLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: field.sdfTex.createView() },
        { binding: 2, resource: field.brickTex.createView() },
        { binding: 3, resource: albedo.createView({ dimension: '2d-array' }) },
        { binding: 4, resource: linearSamp },
        { binding: 5, resource: tileSamp },
        { binding: 6, resource: field.voxelTex.createView() },
        { binding: 7, resource: { buffer: this.marks } },
        { binding: 8, resource: normals.createView({ dimension: '2d-array' }) },
        { binding: 9, resource: field.charTex.createView() },
        { binding: 10, resource: field.blastCellTex.createView() },
        { binding: 11, resource: { buffer: field.blastBuffer } },
        { binding: 12, resource: this.blastMark.createView() },
        { binding: 13, resource: skyVis.tex.createView() },
        { binding: 14, resource: skyVis.light.createView() },
        { binding: 15, resource: this.ownerTex.createView() },
      ],
    });
    this.data = new Float32Array(UNIFORM_FLOATS);
    this.size = [0, 0];
  }

  // Loads textures/blast.png (a 512² greyscale image, multiplied into the ground: white leaves it be) into the blast
  // mark, with its mips.
  async loadBlastMark(baseUrl = document.baseURI) {
    const res = await fetch(new URL('textures/blast.png', baseUrl));
    if (!res.ok) throw new Error(`Couldn't load textures/blast.png (${res.status})`);
    const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = new OffscreenCanvas(512, 512);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, 512, 512);
    const data = ctx.getImageData(0, 0, 512, 512).data;
    let n = 512, px = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) px[i] = data[i * 4];
    for (let level = 0; level < 10; level++) {
      const row = Math.max(256, Math.ceil(n / 256) * 256), padded = new Uint8Array(row * n);
      for (let y = 0; y < n; y++) padded.set(px.subarray(y * n, y * n + n), y * row);
      this.device.queue.writeTexture({ texture: this.blastMark, mipLevel: level }, padded, { bytesPerRow: row }, [n, n]);
      if (n === 1) break;
      const m = n / 2, next = new Uint8Array(m * m);
      for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
        const i = 2 * y * n + 2 * x;
        next[y * m + x] = (px[i] + px[i + 1] + px[i + n] + px[i + n + 1] + 2) >> 2;
      }
      px = next;
      n = m;
    }
    this.blastMarkReady = true;
  }

  // The G-buffer and shadow targets follow the output size.
  resize(w, h) {
    if (this.size[0] === w && this.size[1] === h) return;
    for (const k of ['gbuf', 'shadow', 'coarse', 'depth']) this[k]?.destroy();
    Object.assign(this, this.targets(w, h));
  }

  // The size-dependent targets (and their bind groups) for drawing w × h.
  targets(w, h) {
    const t = { size: [w, h] };
    t.depth = this.device.createTexture({ label: 'depth', size: [w, h], format: DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING }); // (read by the depth of field)
    t.depthView = t.depth.createView();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    t.gbuf = this.device.createTexture({ label: 'g-buffer', size: [w, h], format: 'rgba32float', usage });
    t.shadow = this.device.createTexture({ label: 'sun shadow', size: [Math.ceil(w / 2), Math.ceil(h / 2)], format: 'r8unorm', usage });
    t.coarse = this.device.createTexture({ label: 'coarse march', size: [Math.ceil(w / COARSE), Math.ceil(h / COARSE)], format: 'r32float', usage });
    t.coarseGroup = this.device.createBindGroup({
      layout: this.gbufLayout, entries: [{ binding: 0, resource: t.coarse.createView() }],
    });
    t.gbufGroup = this.device.createBindGroup({
      layout: this.gbufLayout, entries: [{ binding: 0, resource: t.gbuf.createView() }],
    });
    t.shadeGroup = this.device.createBindGroup({
      layout: this.shadeLayout,
      entries: [{ binding: 0, resource: t.gbuf.createView() }, { binding: 1, resource: t.shadow.createView() }],
    });
    return t;
  }

  // Renders the terrain and sky round eye into a cube map (size² faces, this renderer's format), for reflections
  // (the ore chunks', see metalColour in units-render.js), and returns its cube view. Each face is its own submit,
  // as the faces share the uniforms: so call it before draw's frame. frame: draw's torch, sun, time and scorch.
  bakeCube(eye, frame, size = 128) {
    if (this.cube?.width !== size) {
      this.cube?.destroy();
      for (const k of ['gbuf', 'shadow', 'coarse', 'depth']) this.cubeTargets?.[k].destroy();
      this.cube = this.device.createTexture({ label: 'reflection cube', size: [size, size, 6], format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
      this.cubeView = this.cube.createView({ dimension: 'cube' });
      this.cubeTargets = this.targets(size, size);
    }
    const keep = {};
    for (const k of Object.keys(this.cubeTargets)) keep[k] = this[k];
    Object.assign(this, this.cubeTargets);
    // Each face's axis (ma) and its texels' across (sc) and down (tc) directions, as WebGPU samples cube maps.
    const FACES = [
      [[1, 0, 0], [0, 0, -1], [0, -1, 0]], [[-1, 0, 0], [0, 0, 1], [0, -1, 0]],
      [[0, 1, 0], [1, 0, 0], [0, 0, 1]], [[0, -1, 0], [1, 0, 0], [0, 0, -1]],
      [[0, 0, 1], [1, 0, 0], [0, -1, 0]], [[0, 0, -1], [-1, 0, 0], [0, -1, 0]],
    ];
    const near = 0.1, far = 1000, A = far / (far - near), B = -far * near / (far - near);
    const dot = (v) => v[0] * eye[0] + v[1] * eye[1] + v[2] * eye[2];
    FACES.forEach(([ma, sc, tc], i) => {
      const rows = [[...sc, -dot(sc)], [-tc[0], -tc[1], -tc[2], dot(tc)], [...ma.map((v) => v * A), -dot(ma) * A + B], [...ma, -dot(ma)]];
      const viewProj = new Float32Array(16);
      for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) viewProj[c * 4 + r] = rows[r][c];
      const encoder = this.device.createCommandEncoder({ label: 'reflection cube' });
      this.draw(encoder, this.cube.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }), {
        ...frame, invViewProj: mat4.invert(viewProj), viewProj, camPos: eye, ortho: false, brush: [0, 0, 0, 0],
        brushColor: [0, 0, 0, 0], pixel: 2 / size, fogStart: 40, marks: [], detailFar: 0, edges: false,
      });
      this.device.queue.submit([encoder.finish()]);
    });
    Object.assign(this, keep);
    return this.cubeView;
  }

  // frame: { invViewProj, viewProj, camPos, ortho, sun, brush: [x, y, z, r], brushColor: [r, g, b, a], pixel, fogStart,
  //   time, marks: [[x, y, z, kind]], detailFar (distance from the eye past which bevels and normal maps are left out),
//   scorch (Scorch.uniforms()), edges (false: no toon outlines) }
  // profiler (optional) times each pass.
  draw(encoder, view, frame, profiler) {
    const d = this.data;
    d.set(frame.invViewProj, 0);
    d.set([...frame.camPos, frame.ortho ? 1 : 0], 16);
    d.set([...frame.sun, 0], 20);
    d.set(frame.brush, 24);
    d.set(frame.brushColor, 28);
    d.set([frame.pixel, frame.time, frame.fogStart, 0], 32);
    d.set(frame.viewProj, 36);
    const marks = (frame.marks ?? []).slice(0, MAX_MARKS);
    d.set([marks.length, Math.max(1, Math.round(RENDER_TUNING.textureTiling)), RENDER_TUNING.bevel, RENDER_TUNING.cornerBevel], 52);
    d.set(frame.torch ?? [0, 0, 0, 1], 56);
    d.set(LAYERS.map((k) => NORMAL_TUNING[k] ?? 0), 60); // (in layer order)
    d[71] = Math.max(0, RENDER_TUNING.sandBright);
    d.set([this.size[0], this.size[1], frame.detailFar ?? 1e9, 0], 72);
    d.set(frame.scorch ?? [0], 76);
    const T = TOON_TUNING, ec = linearColor(T.edgeColor), edges = frame.edges !== false;
    d.set([T.on > 0.5 ? 1 : 0, Math.max(1, Math.round(T.bands)), T.softness, T.grassLip, T.edgeDepth, T.edgeGrow, T.edgeWidth, edges ? T.edgeStrength : 0, ...ec, T.edgeMode > 0.5 ? 1 : 0, T.sobelNormal, edges ? T.creaseStrength : 0, T.ao, BLOCK_TUNING.seams, ...['brickBevel', 'brickStrength', 'plankBevel', 'plankStrength'].map((k) => BLOCK_TUNING[k])], 76 + SCORCH_FLOATS);
    const G = GI_TUNING;
    d.set([Math.round(Math.min(Math.max(G.on, 0), 2)), G.strength, G.bias, G.minimum, G.torchShadows > 0.5 ? 1 : 0, OBSIDIAN_LOOK.glint,
      LEAF_TUNING.round > 0.5 ? Math.min(Math.max(LEAF_TUNING.radius, 0.01), 0.5) : 0, LEAF_TUNING.holes > 0.5 ? 1 : 0], 96 + SCORCH_FLOATS);
    d.set([...linearColor(OBSIDIAN_LOOK.color), OBSIDIAN_LOOK.grain], 104 + SCORCH_FLOATS);
    const B = BLOCK_TUNING;
    d.set([B.clayRound, B.clayStrength, Math.max(1, Math.round(B.clayAcross)), Math.max(1, Math.round(B.clayUp))], 108 + SCORCH_FLOATS);
    d.set([B.clayCorner, B.clayHandmade, 0, 0], 112 + SCORCH_FLOATS);
    ['brick', 'clay', 'plank'].forEach((m, j) => TEAM_KEYS.forEach((k, i) => d.set([...linearColor(B[m + k]), 0], 116 + SCORCH_FLOATS + (j * 4 + i) * 4)));
    const W = SNOW_TUNING;
    d.set([W.on > 0.5 ? 1 : 0, W.height, W.jitter, W.trees > 0.5 ? 1 : 0, ...linearColor(W.color), 0], 164 + SCORCH_FLOATS);
    const RT = RENDER_TUNING;
    d.set([RT.ripples > 0.5 ? 1 : 0, RT.rippleScale, RT.rippleStrength, 0], 172 + SCORCH_FLOATS);
    d.set([W.ripples > 0.5 ? 1 : 0, W.rippleScale, W.rippleStrength, 0], 176 + SCORCH_FLOATS);
    const t = this.terrain;
    if (t && t.ownersVersion !== this.ownersVersion) {
      this.ownersVersion = t.ownersVersion;
      this.device.queue.writeTexture({ texture: this.ownerTex }, t.owners, { bytesPerRow: SIZE[0] }, [SIZE[0], SIZE[2]]);
    }
    d[83] = this.blastMarkReady ? 1 : 0; // (scorch[1].w)
    this.device.queue.writeBuffer(this.uniforms, 0, d);
    if (marks.length) {
      marks.forEach((m, i) => this.markData.set(m, i * 4));
      this.device.queue.writeBuffer(this.marks, 0, this.markData, 0, marks.length * 4);
    }
    const passes = [
      ['coarse march', this.coarsePipeline, this.coarse.createView(), null],
      ['terrain march', this.marchPipeline, this.gbuf.createView(), this.coarseGroup],
      ['sun shadow', this.shadowPipeline, this.shadow.createView(), this.gbufGroup],
      ['shade', this.shadePipeline, view, this.shadeGroup, true],
    ];
    for (const [name, pipeline, target, group, depth] of passes) {
      const pass = encoder.beginRenderPass({
        label: name,
        colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        depthStencilAttachment: depth ? { view: this.depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } : undefined,
        timestampWrites: profiler?.tsw(name),
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.sceneGroup);
      if (group) pass.setBindGroup(1, group);
      if (depth) pass.setBindGroup(2, this.sky.group);
      pass.draw(3);
      pass.end();
    }
  }
}
