// Falling trees: when a tree is cut (trees.js fellTree, through Terrain.onFell), its trunk and the leaves that only it
// held up leave the voxel grid at once and become one rigid model, frozen in the tree's shape, that topples over about
// the foot of the cut log, away from whoever cut it. When any of it hits the ground (or the water) the leaves burst into
// small leaves that flutter down, settle and shrink away, and the trunk breaks into its logs, which tumble for a while
// and shrink away too. Only for show: the planks are counted when the tree's cut, and nothing collides with it.
//
// Drawn like the debris (debris.js): the logs as boxes (bark on their sides, rings on their ends) with the villagers'
// toon outline as a shell; the frozen leaves traced as rounded leaf blocks (render.js LEAF_TUNING), with the leaf
// texture's gaps, outlined where the trace passes close by; the small leaves as flat leaf shapes.

import { skyWgsl, linearColor } from './sky.js';
import { BLOCK, WATER_LEVEL } from './terrain.js';
import { intoWater, splashWater } from './splash.js';
import { TOON_TUNING, LEAF_TUNING, BLOCK_TUNING, NORMAL_TUNING } from './render.js';
import { sfx } from './audio.js';

// Tuning (T > Felling).
export const FELL_TUNING = {
  on: 1,             // 1: cut trees fall over; 0: they vanish (their leaves wither) as before
  push: 0.5,         // radians per second the cut gives it to start it toppling
  gravity: 20,       // voxels per second²
  leafWeight: 0.25,  // a leaf block's weight next to a log's (the canopy's pull on the fall)
  leaves: 3,         // small leaves each leaf block bursts into
  leafSize: 0.16,    // voxels, a small leaf's half length
  burst: 3,          // voxels per second they burst out at
  fall: 0.8,         // voxels per second they flutter down at, at most
  flutter: 1,        // how far they rock and drift from side to side
  leafLife: 3,       // seconds a small leaf lies on the ground before it shrinks away
  spin: 4,           // radians per second a broken-off log tumbles at (more or less)
  bounce: 0.3,       // how much speed a log's bounce keeps
  logLife: 2.5,      // seconds before a log shrinks away
};

const MAX_PIECES = 8192;
const FLOATS = 16;
const UNIFORM_FLOATS = 60; // (View)
const TEX_SIZE = 128;
const BARK = 4, RINGS = 5, LEAVES = 6; // the albedo array's layers (textures.js)
const LOG_LOOK = [0, 0, 0, BARK * 16 + RINGS]; // (see fsLog)

export const FELL_WGSL = /* wgsl */ `
// eye: w = orthographic; ahead: the camera's forward, w = a pixel's size (voxels, per voxel away in perspective);
// toon: bands (0 = toon shading off), softness, screen size (zw); outline: rgb, width (pixels, 0 = none); leaf: rounding
// radius (0 = cubes), 1 when the leaf texture's gaps are cut out. A building's tumbling blocks' bevels, as the
// terrain's (render.js BLOCK_TUNING): blocks: bricks' bevel width and strength, planks'; clay: its rounding, strength,
// bricks across and up a voxel; clay2: corner rounding, hand made, toon seams' strength; seam: toon strokes' colour;
// nw: normal map strengths (NORMAL_TUNING) of dirt, stone, planks and bricks.
struct View {
  viewProj: mat4x4f, sun: vec4f, eye: vec4f, ahead: vec4f, toon: vec4f, outline: vec4f, leaf: vec4f,
  blocks: vec4f, clay: vec4f, clay2: vec4f, seam: vec4f, nw: vec4f,
}
@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var albedo: texture_2d_array<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var shadowTex: texture_2d<f32>;
@group(0) @binding(4) var normalMaps: texture_2d_array<f32>;
${skyWgsl(1)}

// One piece: a: centre (xyz), size (a log's or leaf block's edge, a small leaf's half length; shrinking away); b: its
// turn (a quaternion); c: shade, sun shadow from the screen (1) or none (0), a leaf block's closed sides (bits: +x -x
// +y -y +z -z), -.
struct PIn { @location(0) a: vec4f, @location(1) b: vec4f, @location(2) c: vec4f, @location(3) d: vec4f }

fn qrot(q: vec4f, v: vec3f) -> vec3f { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
fn qinv(q: vec4f) -> vec4f { return vec4f(-q.xyz, q.w); }

fn pixelAt(p: vec3f) -> f32 { return select(V.ahead.w * length(V.eye.xyz - p), V.ahead.w, V.eye.w > 0.5); }
// The texture's level of detail for a block of edge size at p; colourLod: for its colour (toon shading: the average).
fn lodAt(p: vec3f, size: f32) -> f32 { return log2(max(pixelAt(p) * ${TEX_SIZE}.0 / max(size, 1e-3), 1e-4)); }
fn colourLod(lod: f32) -> f32 { return select(lod, 16.0, V.toon.x > 0.5); }

// The sun shadow (half resolution) at p's pixel.
fn shadowAt(p: vec3f) -> f32 {
  let c = V.viewProj * vec4f(p, 1.0);
  let s = vec2f(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5) * V.toon.zw;
  let q = clamp(vec2i(s * 0.5), vec2i(0), vec2i(textureDimensions(shadowTex)) - 1);
  return textureLoad(shadowTex, q, 0).r;
}
fn shadowOf(p: vec3f, c: vec4f) -> f32 { return select(1.0, shadowAt(p), c.y > 0.5); }

fn lit(col: vec3f, n: vec3f, shadow: f32) -> vec3f {
  var diffuse = max(dot(n, V.sun.xyz), 0.0) * shadow;
  if (V.toon.x > 0.5) {
    let xb = diffuse * V.toon.x;
    let s = max(V.toon.y, 1e-3);
    diffuse = (floor(xb) + smoothstep(0.5 - s, 0.5 + s, fract(xb))) / V.toon.x;
  }
  return col * (diffuse * lightIlluminance() / PI + ambient(n));
}

fn depthOf(p: vec3f) -> f32 {
  let c = V.viewProj * vec4f(p, 1.0);
  return c.z / c.w;
}
// The ray through world point p: its origin and direction.
fn eyeRay(p: vec3f) -> array<vec3f, 2> {
  let d = select(normalize(p - V.eye.xyz), V.ahead.xyz, V.eye.w > 0.5);
  return array<vec3f, 2>(select(V.eye.xyz, p - d * 16.0, V.eye.w > 0.5), d);
}

// A block's closed sides (mask bits: +x -x +y -y +z -z): those up against another block of the tree.
fn isClosed(mask: u32, axis: u32, s: f32) -> bool {
  return ((mask >> (axis * 2u + select(0u, 1u, s < 0.0))) & 1u) == 1u;
}
// How far the box reaches on each side (with the outline's width on the open ones), along axis.
fn reach(mask: u32, axis: u32, s: f32, line: f32) -> f32 { return 0.5 + select(line, 0.0, isClosed(mask, axis, s)); }

var<private> CORNERS: array<vec2f, 6> = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));

// ---- a building's block's look, as render.js shades it on the ground (its normal maps and bevels) ------------------

const X = vec3f(1.0, 0.0, 0.0);
const Z = vec3f(0.0, 0.0, 1.0);
const UP = vec3f(0.0, 1.0, 0.0);
fn hash3(c: vec3f) -> f32 {
  return fract(sin(dot(c, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}
// Layer's normal map at uv in its own terms (x along u, y up the image, z out), tilted by its strength.
fn tnorm(uv: vec2f, layer: i32, lod: f32) -> vec3f {
  let m = textureSampleLevel(normalMaps, samp, uv, layer, lod).xyz * 2.0 - 1.0;
  let k = select(select(select(V.nw.w, V.nw.z, layer == 8), V.nw.y, layer == 7), V.nw.x, layer == 1);
  return normalize(vec3f(m.xy * k, max(m.z, 0.05)));
}
fn bend(n: vec3f, m: vec3f, tu: vec3f, tv: vec3f) -> vec3f {
  let t0 = tu - n * dot(tu, n);
  let t = t0 * inverseSqrt(max(dot(t0, t0), 1e-8));
  let b0 = tv - n * dot(tv, n) - t * dot(tv, t);
  let b = b0 * inverseSqrt(max(dot(b0, b0), 1e-8));
  return m.x * t + m.y * b + m.z * n;
}
// (render.js blockBevel and clayBevel.)
fn blockBevel(uv: vec2f, plank: bool, w: f32, fp: f32) -> vec3f {
  var vv: f32;
  var uu = 0.5;
  var size = vec2f(1e9, 0.5);
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
  let e = (0.5 - abs(f - 0.5)) * size - mortar;
  let away = sign(f - 0.5);
  let k = select(vec2f(0.0), 1.0 - smoothstep(vec2f(0.0), vec2f(max(w, 1e-4)), e), e >= vec2f(0.0));
  let show = 1.0 - smoothstep(w, 3.0 * w, fp);
  let tilt = away * k * show;
  let seam = (1.0 - smoothstep(-0.5 * fp, 0.5 * fp, min(e.x, e.y))) * (1.0 - smoothstep(0.25 * size.y, 0.5 * size.y, fp));
  return vec3f(tilt.x, -tilt.y, seam);
}
fn clayBevel(uv: vec2f, fp: f32) -> vec3f {
  let w = max(V.clay.x, 1e-3);
  let vv = uv.y * V.clay.w + 0.013;
  let odd = (i32(floor(vv)) & 1) != 0;
  let uu = uv.x * V.clay.z + select(0.02, 0.52, odd);
  let size = 1.0 / V.clay.zw;
  let id = floor(vec2f(uu, vv));
  let wob = V.clay2.y;
  let shrink = 0.014 + wob * 0.012 * vec2f(hash3(vec3f(id, 1.0)), hash3(vec3f(id, 2.0)));
  let off = (vec2f(hash3(vec3f(id, 3.0)), hash3(vec3f(id, 4.0))) - 0.5) * wob * 0.012;
  let lean = (vec2f(hash3(vec3f(id, 5.0)), hash3(vec3f(id, 6.0))) - 0.5) * wob * 0.15;
  let half = 0.5 * size - shrink;
  let rc = min(V.clay2.x * mix(1.0, 0.6 + 0.8 * hash3(vec3f(id, 7.0)), wob), min(half.x, half.y));
  let lp = (fract(vec2f(uu, vv)) - 0.5) * size - off;
  let k = abs(lp) - (half - rc);
  let outer = max(k, vec2f(0.0));
  let e = rc - length(outer) - min(max(k.x, k.y), 0.0);
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

// ---- logs: 36 vertices of the box, then (with an outline) 36 of a shell the outline's width bigger round it --------

struct LOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec3f,                     // on the box, -0.5 to 0.5 (the log runs along y)
  @location(1) @interpolate(flat) normal: vec3f, // local
  @location(2) @interpolate(flat) turn: vec4f,
  @location(3) @interpolate(flat) col: vec4f,    // shade, sun shadow, level of detail, hull (1: the shell, 2: not drawn)
  @location(4) @interpolate(flat) look: vec4f,   // a flat colour (rgb), and w: its layers (see fsLog)
}

@vertex
fn vsLog(@builtin(vertex_index) vi: u32, p: PIn) -> LOut {
  var o: LOut;
  let hull = vi >= 36u;
  let j = vi % 36u;
  let face = j / 6u;
  let axis = face / 2u;
  let s = select(1.0, -1.0, (face & 1u) == 1u);
  let k = CORNERS[j % 6u];
  var local = vec3f(0.0);
  var n = vec3f(0.0);
  local[axis] = s;
  n[axis] = s;
  local[(axis + 1u) % 3u] = k.x;
  local[(axis + 2u) % 3u] = k.y;
  let mask = u32(p.c.z);
  var corner = local * 0.5 * p.a.w;
  var flag = 0.0;
  if (hull) {
    // The shell: bigger by the outline's width, but not on the sides up against another block of the tree (so no
    // line shows between them), and those sides not drawn at all.
    let line = V.outline.w * pixelAt(p.a.xyz) / max(p.a.w, 1e-3);
    if (line <= 0.0 || p.a.w <= 0.0 || isClosed(mask, axis, s)) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
    var grown = vec3f(0.0);
    for (var i = 0u; i < 3u; i++) { grown[i] = local[i] * reach(mask, i, local[i], line); }
    corner = grown * p.a.w;
    // Facing the eye (seen from the middle of the face): not drawn, so the log shows through.
    let mid = p.a.xyz + qrot(p.b, n * reach(mask, axis, s, line) * p.a.w);
    let toEye = select(V.eye.xyz - mid, -V.ahead.xyz, V.eye.w > 0.5);
    flag = select(1.0, 2.0, dot(qrot(p.b, n), toEye) > 0.0);
  }
  o.pos = V.viewProj * vec4f(p.a.xyz + qrot(p.b, corner), 1.0);
  o.local = local * 0.5;
  o.normal = n;
  o.turn = p.b;
  o.col = vec4f(p.c.x, shadowOf(p.a.xyz, p.c), lodAt(p.a.xyz, p.a.w), flag);
  o.look = p.d;
  return o;
}

@fragment
fn fsLog(in: LOut) -> @location(0) vec4f {
  if (in.col.w > 1.5) { discard; }
  if (in.col.w > 0.5) { return vec4f(V.outline.rgb, 1.0); }
  // Bark up its sides (the texture's v down the log, as on the ground), rings on its ends; or a building's block (see
  // Felling.crumble): look.w = its sides' layer × 16 + its top and bottom's, + 256 for its flat colour (look.rgb, a
  // team's) in place of the texture, + 512 × its relief: 0 none (logs), 1 its normal map, 2 a brick's bevels, 3 a
  // plank's, 4 a clay brick's. Its texture's laid on as it was on the ground (one repeat a voxel, the same way round),
  // so it keeps its look as it tumbles: normal maps (not in toon shading), bevels, and in toon shading their seams.
  let a = abs(in.normal);
  let g = in.local + 0.5;
  let side = select(vec2f(g.x, -g.y), vec2f(g.z, -g.y), a.x > 0.5);
  let uv = select(side, g.xz, a.y > 0.5);
  let lw = u32(in.look.w + 0.5);
  let layer = i32(select((lw >> 4u) & 15u, lw & 15u, a.y > 0.5));
  let tex = textureSampleLevel(albedo, samp, uv, layer, colourLod(in.col.z)).rgb;
  var col = select(tex, in.look.rgb, (lw & 256u) != 0u) * in.col.x;
  var n = in.normal;
  let relief = (lw >> 9u) & 7u;
  if (relief > 0u) {
    let toon = V.toon.x > 0.5;
    let fp = exp2(in.col.z) / ${TEX_SIZE}.0; // (a pixel's size, voxels)
    var bev = vec3f(0.0);
    var k = 0.0;
    if (relief == 2u || relief == 3u) {
      let plank = relief == 3u;
      let bw = select(V.blocks.xy, V.blocks.zw, plank);
      bev = blockBevel(uv, plank, bw.x, fp);
      k = bw.y;
    } else if (relief == 4u) {
      bev = clayBevel(uv, fp);
      k = V.clay.y;
    }
    let m = select(tnorm(uv, layer, in.col.z), vec3f(0.0, 0.0, 1.0), toon);
    let tu = select(X, Z, a.x > 0.5 && a.y <= 0.5);
    let tv = select(UP, -Z, a.y > 0.5);
    n = normalize(bend(in.normal, normalize(m + vec3f(bev.xy * k, 0.0)), tu, tv));
    if (toon) { col = mix(col, V.seam.rgb, bev.z * V.clay2.z); }
  }
  return vec4f(lit(col, qrot(in.turn, n), in.col.y), 1.0);
}

// ---- the frozen leaf blocks: a box (bigger by the outline on its open sides), the rounded leaf traced in it ---------

struct BOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) @interpolate(flat) centre: vec4f, // xyz, edge
  @location(2) @interpolate(flat) turn: vec4f,
  @location(3) @interpolate(flat) col: vec4f,    // shade, closed sides, outline width (voxels), level of detail
}


@vertex
fn vsLeaf(@builtin(vertex_index) vi: u32, p: PIn) -> BOut {
  var o: BOut;
  let face = vi / 6u;
  let axis = face / 2u;
  let s = select(1.0, -1.0, (face & 1u) == 1u);
  let k = CORNERS[vi % 6u];
  let mask = u32(p.c.z);
  let line = V.outline.w * pixelAt(p.a.xyz) / max(p.a.w, 1e-3); // (in the block's own size)
  var local = vec3f(0.0);
  local[axis] = s * reach(mask, axis, s, line);
  let a1 = (axis + 1u) % 3u;
  let a2 = (axis + 2u) % 3u;
  local[a1] = k.x * reach(mask, a1, k.x, line);
  local[a2] = k.y * reach(mask, a2, k.y, line);
  o.world = p.a.xyz + qrot(p.b, local * p.a.w);
  o.pos = V.viewProj * vec4f(o.world, 1.0);
  o.centre = p.a;
  o.turn = p.b;
  o.col = vec4f(p.c.x, p.c.z, line, lodAt(p.a.xyz, p.a.w));
  return o;
}

struct FOut { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 }

@fragment
fn fsLeaf(in: BOut) -> FOut {
  var o: FOut;
  let ray = eyeRay(in.world);
  let size = max(in.centre.w, 1e-3);
  // Into the block's own terms: its middle at 0, its edge 1.
  let back = qinv(in.turn);
  let ro = qrot(back, ray[0] - in.centre.xyz) / size;
  let rd = qrot(back, ray[1]);
  let mask = u32(in.col.y);
  let line = in.col.z;
  // Where the ray's in the box drawn.
  var lo = vec3f(0.0);
  var hi = vec3f(0.0);
  for (var i = 0u; i < 3u; i++) { lo[i] = -reach(mask, i, -1.0, line); hi[i] = reach(mask, i, 1.0, line); }
  let inv = 1.0 / rd;
  let ta = (lo - ro) * inv;
  let tb = (hi - ro) * inv;
  let tmin = min(ta, tb);
  let tmax = max(ta, tb);
  let tIn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0));
  let tOut = min(min(tmax.x, tmax.y), tmax.z);
  if (tIn >= tOut) { discard; }
  var faceIn = vec3f(0.0);
  if (tmin.x >= max(tmin.y, tmin.z)) { faceIn.x = -sign(rd.x); } else if (tmin.y >= tmin.z) { faceIn.y = -sign(rd.y); } else { faceIn.z = -sign(rd.z); }
  // The rounded leaf (as render.js leafQ: an open side rounded by r, a closed one flat, running on to its neighbour).
  let r = V.leaf.x;
  var t = tIn;
  var best = 1e9;
  var bestT = tIn;
  var hit = false;
  var n = faceIn;
  for (var i = 0; i < 32; i++) {
    let g = ro + rd * t;
    var q = abs(g) - (0.5 - r);
    for (var k = 0u; k < 3u; k++) { if (isClosed(mask, k, g[k])) { q[k] = -1.0; } }
    let m = max(q, vec3f(0.0));
    let d = length(m) + min(max(max(q.x, q.y), q.z), 0.0) - r;
    if (d < best) { best = d; bestT = t; }
    if (d < 1e-3) {
      hit = true;
      if (i > 0) { n = normalize(m) * sign(g); }
      break;
    }
    t += d;
    if (t > tOut) { break; }
  }
  if (hit) {
    let g = ro + rd * t;
    // The leaf texture's gaps, on the face it mostly faces (as on the ground).
    let a = abs(n);
    let uv = select(select(g.xy, g.xz, a.y >= max(a.x, a.z)), g.zy, a.x >= max(a.y, a.z)) + 0.5;
    if (V.leaf.y > 0.5 && textureSampleLevel(albedo, samp, uv, ${LEAVES}, in.col.w).a < 0.5) { discard; }
    let col = textureSampleLevel(albedo, samp, uv, ${LEAVES}, colourLod(in.col.w)).rgb;
    o.color = vec4f(lit(col * in.col.x, qrot(in.turn, n), 1.0), 1.0);
    o.depth = depthOf(ray[0] + ray[1] * (t * size));
    return o;
  }
  // Close by but missed: the outline, unless the ray goes on into the block beside this one through a closed side
  // (that one carries on the surface it passed).
  var exitAxis = 2u;
  if (tmax.x <= min(tmax.y, tmax.z)) { exitAxis = 0u; } else if (tmax.y <= tmax.z) { exitAxis = 1u; }
  if (best > line || line <= 0.0 || isClosed(mask, exitAxis, rd[exitAxis])) { discard; }
  o.color = vec4f(V.outline.rgb, 1.0);
  o.depth = depthOf(ray[0] + ray[1] * (bestT * size));
  return o;
}

// ---- small leaves: a flat leaf shape, outlined -----------------------------------------------------------------------

struct SOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,                     // across and along the leaf, -1 to 1 (a little more for the outline)
  @location(1) @interpolate(flat) normal: vec3f,
  @location(2) @interpolate(flat) col: vec4f,    // rgb, the outline's width (in half lengths)
  @location(3) @interpolate(flat) shadow: f32,
  @location(4) world: vec3f,
}

const LEAF_WIDTH = 0.55; // a small leaf's width, as a fraction of its length

@vertex
fn vsSmall(@builtin(vertex_index) vi: u32, p: PIn) -> SOut {
  var o: SOut;
  let k = CORNERS[vi] * 1.25;
  let size = p.a.w;
  let local = vec3f(k.x * LEAF_WIDTH, 0.0, k.y);
  o.world = p.a.xyz + qrot(p.b, local * size);
  o.pos = V.viewProj * vec4f(o.world, 1.0);
  o.local = k;
  o.normal = qrot(p.b, vec3f(0.0, 1.0, 0.0));
  let line = V.outline.w * pixelAt(p.a.xyz) * 0.6 / max(size, 1e-4);
  o.col = vec4f(textureSampleLevel(albedo, samp, vec2f(0.5), ${LEAVES}, 16.0).rgb * p.c.x, line);
  o.shadow = shadowOf(p.a.xyz, p.c);
  return o;
}

@fragment
fn fsSmall(in: SOut) -> @location(0) vec4f {
  // A pointed oval: two arcs meeting at the tips (in half lengths, x across scaled to the length).
  let x = abs(in.local.x) * LEAF_WIDTH;
  let y = in.local.y;
  let R = (1.0 + LEAF_WIDTH * LEAF_WIDTH) / (2.0 * LEAF_WIDTH);
  let d = length(vec2f(x + R - LEAF_WIDTH, y)) - R;
  if (d > in.col.w) { discard; }
  if (d > 0.0 && V.outline.w > 0.0) { return vec4f(V.outline.rgb, 1.0); }
  if (d > 0.0) { discard; }
  // Lit on whichever side faces the eye.
  let toEye = select(V.eye.xyz - in.world, -V.ahead.xyz, V.eye.w > 0.5);
  let n = select(-in.normal, in.normal, dot(in.normal, toEye) >= 0.0);
  return vec4f(lit(in.col.rgb, n, in.shadow), 1.0);
}
`;

// Quaternion helpers ([x, y, z, w]).
function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
function qnorm(q) {
  const l = Math.hypot(...q) || 1;
  return q.map((v) => v / l);
}
const qaxis = (a, angle) => [a[0] * Math.sin(angle / 2), a[1] * Math.sin(angle / 2), a[2] * Math.sin(angle / 2), Math.cos(angle / 2)];
// Turned by the angle |w| dt about w (world axes).
function qspin(q, w, dt) {
  const a = Math.hypot(...w) * dt;
  if (a < 1e-6) return q;
  return qnorm(qmul(qaxis(w.map((c) => c * dt / a), a), q));
}
function qrot(q, v) {
  const [x, y, z, w] = q;
  const cx = y * v[2] - z * v[1] + w * v[0], cy = z * v[0] - x * v[2] + w * v[1], cz = x * v[1] - y * v[0] + w * v[2];
  return [v[0] + 2 * (y * cz - z * cy), v[1] + 2 * (z * cx - x * cz), v[2] + 2 * (x * cy - y * cx)];
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];

// The ground's per-block leaf shade (render.js treeAlbedo), so the frozen leaves keep theirs.
function leafShade(x, y, z) {
  const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return 0.85 + 0.3 * (h - Math.floor(h));
}

export class Felling {
  // terrain: the Terrain; albedo: the ground's texture array; sky: the Sky lighting them.
  constructor(device, format, depthFormat, terrain, albedo, sky, normalMaps) {
    this.device = device;
    this.terrain = terrain;
    this.sky = sky;
    this.albedo = albedo;
    this.normalMaps = normalMaps; // (the ground's normal maps, for a building's blocks, see crumble)
    this.sampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat',
    });
    const module = device.createShaderModule({ label: 'felling', code: FELL_WGSL });
    this.layout = device.createBindGroupLayout({
      label: 'felling',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout, sky.layout] });
    const buffers = [{ arrayStride: FLOATS * 4, stepMode: 'instance', attributes: [0, 1, 2, 3].map((i) => ({ shaderLocation: i, offset: i * 16, format: 'float32x4' })) }];
    const pipeline = (kind) => device.createRenderPipeline({
      label: `felling ${kind}`,
      layout,
      vertex: { module, entryPoint: `vs${kind}`, buffers },
      fragment: { module, entryPoint: `fs${kind}`, targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.logPipeline = pipeline('Log');
    this.leafPipeline = pipeline('Leaf');
    this.smallPipeline = pipeline('Small');
    this.uniforms = device.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.buffer = device.createBuffer({ size: MAX_PIECES * FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.data = new Float32Array(MAX_PIECES * FLOATS);
    this.trees = [];  // falling: { pivot, axis, angle, spin, free, centre, velocity, cm, mass, inertia, blocks, age }
    this.logs = [];   // broken off, tumbling
    this.small = [];  // small leaves
    this.shadowFor = null;
  }

  get busy() { return this.trees.length + this.logs.length + this.small.length > 0; }

  // A block of a building breaking off (collapse.js): from the middle of voxel [x, y, z], at velocity v, spinning at w
  // (radians a second about each axis), tumbling like a felled tree's logs for `life` seconds before it shrinks away.
  // look: [r, g, b, layers] (see fsLog). Silent as it bounces. Returns whether there was room for it.
  crumble([x, y, z], v, w, life, look) {
    if (this.logs.length >= MAX_PIECES * 0.3) return false; // (a few thousand at most: each one's physics costs)
    this.logs.push({ p: [x + 0.5, y + 0.5, z + 0.5], v, q: [0, 0, 0, 1], w, age: 0, life, shade: 0.9 + 0.2 * Math.random(), look, quiet: true });
    return true;
  }

  // A tree's been cut at log `cut` ([x, y, z]): `logs` (all of the trunk that falls, the cut log too) and `leaves` (the
  // leaf blocks only it held up), as [x, y, z]s, just taken off the grid, topple over away from `from` (where the cutter
  // stands; null: any way). Returns whether it took them (FELL_TUNING.on).
  fell(cut, logs, leaves, from) {
    const T = FELL_TUNING;
    if (T.on < 0.5 || !logs.length) return false;
    let dir;
    if (from) {
      const dx = cut[0] + 0.5 - from[0], dz = cut[2] + 0.5 - from[2], l = Math.hypot(dx, dz);
      if (l > 1e-3) dir = Math.atan2(dz, dx) + (Math.random() - 0.5) * 0.6;
    }
    if (dir === undefined) dir = Math.random() * 2 * Math.PI;
    const d = [Math.cos(dir), 0, Math.sin(dir)];
    // About the cut log's foot, on its edge on the side it falls to.
    const edge = 0.5 / Math.max(Math.abs(d[0]), Math.abs(d[2]));
    const pivot = [cut[0] + 0.5 + d[0] * edge, cut[1], cut[2] + 0.5 + d[2] * edge];
    const axis = [d[2], 0, -d[0]]; // turning about it takes up towards d
    const set = new Set([...logs, ...leaves].map(([x, y, z]) => `${x},${y},${z}`));
    const has = (x, y, z) => set.has(`${x},${y},${z}`);
    const blocks = [];
    // The sides another block of the tree is up against (a leaf's flat, not rounded; no outline between them).
    const closed = (x, y, z) => (has(x + 1, y, z) ? 1 : 0) | (has(x - 1, y, z) ? 2 : 0) | (has(x, y + 1, z) ? 4 : 0)
      | (has(x, y - 1, z) ? 8 : 0) | (has(x, y, z + 1) ? 16 : 0) | (has(x, y, z - 1) ? 32 : 0);
    for (const [x, y, z] of logs) blocks.push({ o: sub([x + 0.5, y + 0.5, z + 0.5], pivot), leaf: false, shade: 1, mask: closed(x, y, z) });
    for (const [x, y, z] of leaves) blocks.push({ o: sub([x + 0.5, y + 0.5, z + 0.5], pivot), leaf: true, shade: leafShade(x, y, z), mask: closed(x, y, z) });
    let mass = 0, cm = [0, 0, 0], inertia = 0;
    for (const b of blocks) {
      const m = b.leaf ? T.leafWeight : 1;
      mass += m;
      cm = add(cm, scale(b.o, m));
      const along = dot(b.o, axis);
      inertia += m * (dot(b.o, b.o) - along * along + 1 / 6);
    }
    cm = scale(cm, 1 / mass);
    this.trees.push({ pivot, axis, angle: 0, spin: T.push, free: false, centre: null, velocity: null, cm, mass, inertia, blocks, age: 0 });
    return true;
  }

  // The tree's turn, a block's place and its velocity.
  turn(f) { return qaxis(f.axis, f.angle); }
  place(f, q, b) { return f.free ? add(f.centre, qrot(q, sub(b.o, f.cm))) : add(f.pivot, qrot(q, b.o)); }
  speedAt(f, p) {
    const w = cross(scale(f.axis, f.spin), sub(p, f.free ? f.centre : f.pivot));
    return f.free ? add(w, f.velocity) : w;
  }

  tick(dt) {
    if (!this.busy) return;
    dt = Math.min(dt, 0.1);
    const steps = Math.ceil(dt / (1 / 120));
    for (let s = 0; s < steps; s++) this.step(dt / steps);
    this.logs = this.logs.filter((c) => c.age < c.life);
    this.small = this.small.filter((l) => l.landed < 0 || l.landed < l.life + 0.5);
  }

  step(dt) {
    const T = FELL_TUNING, t = this.terrain, F = Math.floor;
    const hard = (x, y, z) => t.solid(F(x), F(y), F(z)) && t.block(F(x), F(y), F(z)) !== BLOCK.LEAVES;
    this.trees = this.trees.filter((f) => {
      f.age += dt;
      if (!f.free) {
        // Toppling about the foot: gravity's pull on the centre of mass turns it.
        const r = qrot(this.turn(f), f.cm);
        const torque = dot(cross(r, [0, -T.gravity, 0]), f.axis) * f.mass;
        f.spin += torque / f.inertia * dt;
        f.angle += f.spin * dt;
        if (f.angle > Math.PI * 0.55) {
          // Past lying flat with nothing under it (off a drop): falling free from here, still turning.
          f.free = true;
          f.centre = add(f.pivot, r);
          f.velocity = cross(scale(f.axis, f.spin), r);
        }
      } else {
        f.velocity[1] -= T.gravity * dt;
        f.centre = add(f.centre, scale(f.velocity, dt));
        f.angle += f.spin * dt;
      }
      // Hit: the bottom of any block (but those at the foot, still on the stump) in something solid (not leaves), or in
      // the water.
      const q = this.turn(f);
      let hit = f.age > 8;
      for (const b of f.blocks) {
        if (hit) break;
        if (!f.free && dot(b.o, b.o) < 2) continue;
        const p = this.place(f, q, b);
        if (p[1] - 0.45 < WATER_LEVEL) { hit = true; splashWater(p, 2.5, 8); } // (a tree down in the sea: a big splash)
        else if (hard(p[0], p[1] - 0.45, p[2])) hit = true;
      }
      if (hit) this.burst(f, q);
      return !hit;
    });
    for (const c of this.logs) this.tumble(c, dt);
    for (const l of this.small) this.flutter(l, dt);
  }

  // The tree hits the ground: its leaves burst into small ones, its trunk breaks into its logs.
  burst(f, q) {
    const T = FELL_TUNING;
    const places = f.blocks.map((b) => this.place(f, q, b));
    let mid = [0, 0, 0], n = 0;
    f.blocks.forEach((b, i) => { if (b.leaf) { mid = add(mid, places[i]); n++; } });
    mid = scale(mid, 1 / Math.max(1, n));
    sfx('treeCrash', n ? mid : places[0]);
    f.blocks.forEach((b, i) => {
      const p = places[i], v = scale(this.speedAt(f, p), 0.5);
      if (!b.leaf) {
        if (this.logs.length >= MAX_PIECES / 4) return;
        const k = T.spin;
        this.logs.push({
          p, v: add(v, [(Math.random() - 0.5) * 2, 2 + 2 * Math.random(), (Math.random() - 0.5) * 2]),
          q, w: add(scale(f.axis, f.spin * 0.5), [0, 1, 2].map(() => (Math.random() - 0.5) * 2 * k)),
          age: 0, life: T.logLife * (0.75 + 0.5 * Math.random()), shade: 0.9 + 0.2 * Math.random(),
        });
        return;
      }
      const count = Math.round(T.leaves);
      for (let k = 0; k < count && this.small.length < MAX_PIECES / 2; k++) {
        const at = add(p, [Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5].map((c) => c * 0.9));
        let out = sub(at, mid);
        const l = Math.hypot(...out) || 1;
        out = scale(out, T.burst * (0.5 + 0.7 * Math.random()) / l);
        const a = Math.random() * 2 * Math.PI;
        this.small.push({
          p: at, v: add(scale(v, 0.4), add(out, [0, T.burst * 0.5 * Math.random(), 0])),
          size: T.leafSize * (0.7 + 0.6 * Math.random()), shade: b.shade * (0.9 + 0.2 * Math.random()),
          yaw: Math.random() * 2 * Math.PI, yawSpin: (Math.random() * 2 - 1) * 6,
          tumble: Math.random() * 2 * Math.PI, tumbleSpin: (Math.random() * 2 - 1) * 10,
          phase: Math.random() * 2 * Math.PI, rate: 3 + 2 * Math.random(), drift: [Math.cos(a), Math.sin(a)],
          age: 0, landed: -1, life: T.leafLife * (0.7 + 0.6 * Math.random()),
        });
      }
    });
  }

  // A broken-off log: falling, bouncing off the voxels, sliding to a stop on one of its sides.
  tumble(c, dt) {
    const T = FELL_TUNING, t = this.terrain, F = Math.floor;
    const solid = (x, y, z) => t.solid(F(x), F(y), F(z));
    c.age += dt;
    const r = 0.45, p = c.p, v = c.v;
    for (let i = 0; i < 100 && solid(p[0], p[1], p[2]); i++) p[1] = F(p[1]) + 1 + r;
    intoWater(c, p, 0.9, v[1]);
    const wet = p[1] < WATER_LEVEL;
    v[1] -= T.gravity * (wet ? 0.2 : 1) * dt;
    if (wet) for (let i = 0; i < 3; i++) v[i] *= Math.exp(-3 * dt);
    for (const a of [0, 2]) {
      p[a] += v[a] * dt;
      const side = Math.sign(v[a]);
      const q = [...p];
      q[a] += side * r;
      if (side && F(q[a]) !== F(p[a]) && solid(...q)) {
        p[a] = side > 0 ? F(q[a]) - r : F(q[a]) + 1 + r;
        v[a] = -v[a] * T.bounce;
      }
    }
    p[1] += v[1] * dt;
    if (v[1] > 0 && solid(p[0], p[1] + r, p[2])) {
      p[1] = F(p[1] + r) - r;
      v[1] = -v[1] * T.bounce;
    }
    if (v[1] <= 0 && solid(p[0], p[1] - r, p[2])) {
      p[1] = F(p[1] - r) + 1 + r;
      if (v[1] < -2 && !c.quiet) sfx('logKnock', p, { gain: Math.min(1, -v[1] / 10) });
      v[1] = -v[1] * T.bounce;
      if (v[1] < 1.5) v[1] = 0;
      // On the ground: sliding to a stop, its spin dying away, rolling onto whichever side is nearest down.
      v[0] *= Math.exp(-6 * dt);
      v[2] *= Math.exp(-6 * dt);
      c.w = c.w.map((k) => k * Math.exp(-6 * dt));
      let best = null, most = -1;
      for (const ax of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
        const u = qrot(c.q, ax);
        if (Math.abs(u[1]) > most) { most = Math.abs(u[1]); best = u[1] >= 0 ? u : scale(u, -1); }
      }
      const tilt = [-best[2], 0, best[0]]; // best × up, scaled by how far off it is
      const k = Math.min(1, 8 * dt);
      c.q = qspin(c.q, tilt.map((x) => x * k / dt), dt);
    }
    c.q = qspin(c.q, c.w, dt);
  }

  // A small leaf: up with the burst, then fluttering down (no faster than FELL_TUNING.fall, rocking and drifting side
  // to side) until it lands, lies there a while, and shrinks away.
  flutter(l, dt) {
    const T = FELL_TUNING, t = this.terrain;
    l.age += dt;
    if (l.landed >= 0) { l.landed += dt; return; }
    l.v[1] = Math.max(l.v[1] - 9 * dt, -T.fall);
    l.v[0] *= Math.exp(-2.5 * dt);
    l.v[2] *= Math.exp(-2.5 * dt);
    l.yawSpin *= Math.exp(-2 * dt);
    l.tumbleSpin *= Math.exp(-3 * dt);
    l.yaw += l.yawSpin * dt;
    l.tumble += l.tumbleSpin * dt;
    const settled = Math.min(1, l.age / 0.8);
    const sway = Math.cos(l.age * l.rate + l.phase) * T.flutter * 0.8 * settled;
    l.p[0] += (l.v[0] + l.drift[0] * sway) * dt;
    l.p[1] += l.v[1] * dt;
    l.p[2] += (l.v[2] + l.drift[1] * sway) * dt;
    const ground = Math.max(t.heightAt(l.p[0], l.p[2]), WATER_LEVEL);
    if (l.v[1] < 0 && l.p[1] <= ground + 0.02) {
      l.p[1] = ground + 0.02;
      l.landed = 0;
    }
    if (l.age > 15) l.landed = Math.max(l.landed, l.life);
  }

  // The small leaf's turn: rocking with its swing as it falls (tumbling at first), flat once down.
  leafTurn(l) {
    if (l.landed >= 0) return qaxis([0, 1, 0], l.yaw);
    const settled = Math.min(1, l.age / 0.8);
    const rock = Math.sin(l.age * l.rate + l.phase) * 0.7 * FELL_TUNING.flutter * settled + l.tumble * (1 - settled);
    return qmul(qaxis([0, 1, 0], l.yaw), qaxis([1, 0, 0], rock));
  }

  // shadow: the terrain's sun shadow texture (half resolution); cam: { eye, ahead, ortho, pixel, size: [w, h] }.
  draw(encoder, colorView, depthView, shadow, viewProj, sun, cam, profiler) {
    if (!this.busy) return;
    if (this.shadowFor !== shadow) {
      this.shadowFor = shadow;
      this.group = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniforms } },
          { binding: 1, resource: this.albedo.createView({ dimension: '2d-array' }) },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: shadow.createView() },
          { binding: 4, resource: this.normalMaps.createView({ dimension: '2d-array' }) },
        ],
      });
    }
    const T = TOON_TUNING, toon = T.on > 0.5, L = LEAF_TUNING;
    const u = new Float32Array(UNIFORM_FLOATS);
    u.set(viewProj, 0);
    u.set([...sun, 0], 16);
    u.set([...cam.eye, cam.ortho ? 1 : 0], 20);
    u.set([...cam.ahead, cam.pixel], 24);
    u.set([toon ? Math.max(1, Math.round(T.bands)) : 0, T.softness, ...cam.size], 28);
    u.set([...linearColor(T.unitColor), toon ? T.unitOutline : 0], 32);
    u.set([L.round > 0.5 ? Math.min(Math.max(L.radius, 0.01), 0.5) : 0, L.holes > 0.5 ? 1 : 0, 0, 0], 36);
    const B = BLOCK_TUNING; // (as render.js)
    u.set([B.brickBevel, B.brickStrength, B.plankBevel, B.plankStrength], 40);
    u.set([B.clayRound, B.clayStrength, Math.max(1, Math.round(B.clayAcross)), Math.max(1, Math.round(B.clayUp))], 44);
    u.set([B.clayCorner, B.clayHandmade, B.seams, 0], 48);
    u.set([...linearColor(T.edgeColor), 0], 52);
    u.set(['dirt', 'stone', 'plank', 'brick'].map((k) => NORMAL_TUNING[k] ?? 0), 56);
    this.device.queue.writeBuffer(this.uniforms, 0, u);
    // Logs (the falling trees' and the broken-off ones), then leaf blocks, then small leaves.
    const data = this.data;
    let n = 0;
    const put = (p, size, q, shade, shadowed, mask, look = LOG_LOOK) => {
      if (n >= MAX_PIECES) return;
      data.set([...p, size, ...q, shade, shadowed, mask, 0, ...look], n++ * FLOATS);
    };
    for (const f of this.trees) {
      const q = this.turn(f);
      for (const b of f.blocks) if (!b.leaf) put(this.place(f, q, b), 1, q, b.shade, 0, b.mask);
    }
    for (const c of this.logs) put(c.p, Math.max(0, Math.min(1, (c.life - c.age) / 0.4)), c.q, c.shade, 1, 0, c.look);
    const logs = n;
    for (const f of this.trees) {
      const q = this.turn(f);
      for (const b of f.blocks) if (b.leaf) put(this.place(f, q, b), 1, q, b.shade, 0, b.mask);
    }
    const leaves = n - logs;
    for (const l of this.small) {
      const shrink = l.landed < 0 ? 1 : Math.max(0, Math.min(1, 1 - (l.landed - l.life) / 0.5));
      put(l.p, l.size * shrink, this.leafTurn(l), l.shade, 1, 0);
    }
    const small = n - logs - leaves;
    this.device.queue.writeBuffer(this.buffer, 0, data, 0, n * FLOATS);
    const pass = encoder.beginRenderPass({
      label: 'felling',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'store' },
      timestampWrites: profiler?.tsw('felling'),
    });
    pass.setBindGroup(0, this.group);
    pass.setBindGroup(1, this.sky.group);
    pass.setVertexBuffer(0, this.buffer);
    if (logs) { pass.setPipeline(this.logPipeline); pass.draw(72, logs, 0, 0); }
    if (leaves) { pass.setPipeline(this.leafPipeline); pass.draw(36, leaves, 0, logs); }
    if (small) { pass.setPipeline(this.smallPipeline); pass.draw(6, small, 0, logs + leaves); }
    pass.end();
  }
}
