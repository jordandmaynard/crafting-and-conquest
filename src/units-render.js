// Draws the units' boxes (and cones and pyramids: a part with a shape, such as a wizard's hat) with ordinary rasterisation, after the terrain: the terrain's shade pass writes depth
// for every pixel it hits, so the boxes depth-test against the raymarched ground. Also draws ghost cubes, see-through
// over everything: ground marked to dig (red, a touch bigger than the voxel so it shows on its faces) or to fill
// (green, a touch smaller), as jobs and as the brush's preview. Marked digs (and a dig's preview, such as a whole vein
// or forest) also show through the ground, fainter (GHOST_TUNING.xray), so a vein that goes deep can be seen.

import { skyWgsl, linearColor } from './sky.js';
import { TOON_TUNING } from './render.js';
import { HEALTHBAR_TUNING } from './bars.js';
import { CRYSTAL_TUNING } from './crystals.js';
import { BANNER_STEPS } from './banner-shape.js';

// Selected villagers are outlined round their silhouette (in their team's colour from the health bars, the part just
// lost) this many pixels: their parts go into a mask, with no depth test, and a screen pass draws round its edge over
// everything (like a selected building's, see outline.js), so no lines show between their own parts and the whole
// silhouette shows through a hill or a cave roof in front of them (Jordan).
export const SELECT_TUNING = { outline: 2.5 };
// Ghost cubes marked to dig, where the ground's in front of them: drawn at this share of their opacity (0: not at all).
export const GHOST_TUNING = { xray: 0.45 };

export const MAX_PARTS = 16384;
export const MAX_GHOSTS = 32768;

export const MAX_UNIT_LIGHTS = 16;
export const MAX_GLOWS = 8; // coloured lights (power crystals', see crystals.js)

export const UNITS_WGSL = /* wgsl */ `
// torch: rgb = the torches' light (colour × strength × exposure), w = reach; lights: the flames nearest the camera,
// xyz and w = brightness (0 for an unused slot); eye: xyz, w = 1 for orthographic; ahead: the way the camera looks, w =
// a pixel's world size at unit distance (or anywhere, orthographic); toon (TOON_TUNING): x = on, y = bands, z = band
// softness, w = outline width (pixels); outline: rgb = its colour (linear), w = marked digs' opacity behind the
// ground (GHOST_TUNING.xray); selBlue, selRed, selYellow, selPurple: the teams' colours (selBlue's slot holds the player's team's, which tints the ghosts the
// player could build, see vsGhost; the selected's outline is a pass of its own, see SELECT_OUTLINE_WGSL); metal (parts with emit 3 and up, see
// metalColour): reflection strength, glints, glint speed, time (s); metalEnv: x = 1 with a reflection cube (oreEnv,
// see setEnv), y = its brightness, z = the sun's highlight, w = its sharpness; glows: coloured lights, pairs of (xyz, reach; 0
// for an unused slot) and (colour × strength, -).
struct View {
  viewProj: mat4x4f, sun: vec4f, torch: vec4f, lights: array<vec4f, ${MAX_UNIT_LIGHTS}>,
  eye: vec4f, ahead: vec4f, toon: vec4f, outline: vec4f, selBlue: vec4f, selRed: vec4f,
  selYellow: vec4f, selPurple: vec4f, metal: vec4f, metalEnv: vec4f, glows: array<vec4f, ${2 * MAX_GLOWS}>,
}
@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var oreEnv: texture_cube<f32>;
${skyWgsl(1)}

// (pos is invariant: worked out the same in the selection mask's pass, so that depth-tests equal.)
struct VOut {
  @builtin(position) @invariant pos: vec4f, @location(0) n: vec3f, @location(1) col: vec4f, @location(2) local: vec3f,
  @location(3) world: vec3f, @location(4) round: vec3f, // (from its centre: metal's normals bend out along it)
}

@vertex
fn vs(@location(0) corner: vec3f, @location(1) normal: vec3f,
      @location(2) m0: vec4f, @location(3) m1: vec4f, @location(4) m2: vec4f, @location(5) m3: vec4f,
      @location(6) col: vec4f) -> VOut {
  return part(corner, normal, m0, m1, m2, m3, col);
}

// A box may be tapered: m0.w and m1.w (its matrix's spare bottom row) are how its width in x and in z change over its
// height, as 1 + taper * y (y from -0.5 to 0.5): positive narrows it towards its bottom, negative towards its top.
fn part(corner: vec3f, normal: vec3f, m0: vec4f, m1: vec4f, m2: vec4f, m3: vec4f, col: vec4f) -> VOut {
  let t = vec2f(m0.w, m1.w);
  let m = mat4x4f(vec4f(m0.xyz, 0.0), vec4f(m1.xyz, 0.0), vec4f(m2.xyz, 0.0), m3); // (m2.w: selected, see vsMask)
  var o: VOut;
  let world = m * vec4f(corner.x * (1.0 + t.x * corner.y), corner.y, corner.z * (1.0 + t.y * corner.y), 1.0);
  o.pos = V.viewProj * world;
  o.world = world.xyz;
  o.round = world.xyz - m3.xyz;
  // Its sides lean with the taper; normals take the inverse transpose (each column over its length², the columns
  // being square to each other).
  let nl = vec3f(normal.x, normal.y - 0.5 * (t.x * abs(normal.x) + t.y * abs(normal.z)), normal.z);
  o.n = normalize(m0.xyz / dot(m0.xyz, m0.xyz) * nl.x + m1.xyz / dot(m1.xyz, m1.xyz) * nl.y + m2.xyz / dot(m2.xyz, m2.xyz) * nl.z);
  o.col = col;
  o.local = corner;
  return o;
}

// A cone or pyramid (see SHAPES) fills the same unit cube as a box. Its faces aren't darkened towards their edges like
// a box's.
@vertex
fn vsCone(@location(0) corner: vec3f, @location(1) normal: vec3f,
          @location(2) m0: vec4f, @location(3) m1: vec4f, @location(4) m2: vec4f, @location(5) m3: vec4f,
          @location(6) col: vec4f) -> VOut {
  var o = part(corner, normal, m0, m1, m2, m3, col);
  o.local = select(vec3f(0.0), corner * 1.1, col.a > 2.5); // (metal, a gold nugget: its glints' grid, see metalColour)
  // Its slanted normals need the inverse transpose (a box's, along its axes, don't): each column over its length².
  let a = m0.xyz / dot(m0.xyz, m0.xyz);
  let b = m1.xyz / dot(m1.xyz, m1.xyz);
  let c = m2.xyz / dot(m2.xyz, m2.xyz);
  o.n = normalize(a * normal.x + b * normal.y + c * normal.z);
  if (col.a < -0.5) { o.pos = vec4f(0.0, 0.0, 2.0, 1.0); } // (emit -1: in the selection mask only, see crystalParts)
  return o;
}

// A torch's light at p (normal n): a soft falloff that reaches zero at the torch's reach, with some wrap-around.
fn torchLight(l: vec4f, p: vec3f, n: vec3f) -> vec3f {
  let d = l.xyz - p;
  let dist = length(d);
  let x = min(dist / V.torch.w, 1.0);
  let window = (1.0 - x * x) * (1.0 - x * x);
  let ndl = max(dot(n, d / max(dist, 1e-3)), 0.0) * 0.75 + 0.25;
  return V.torch.rgb * l.w * window * ndl / (1.0 + 0.35 * dist * dist);
}

// The coloured lights (see View.glows) at p (normal n): like a torch's, but each its own colour and reach, and
// falling off more gently (a power crystal lights the ground well round it).
fn glowLight(p: vec3f, n: vec3f) -> vec3f {
  var light = vec3f(0.0);
  for (var i = 0; i < ${MAX_GLOWS}; i++) {
    let g = V.glows[2 * i];
    if (g.w <= 0.0) { continue; }
    let d = g.xyz - p;
    let dist = length(d);
    let x = min(dist / g.w, 1.0);
    let window = (1.0 - x * x) * (1.0 - x * x);
    let ndl = max(dot(n, d / max(dist, 1e-3)), 0.0) * 0.75 + 0.25;
    light += V.glows[2 * i + 1].rgb * window * ndl / (1.0 + 0.08 * dist * dist);
  }
  return light;
}

fn hash3(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(12.9898, 78.233, 37.719))) * 43758.5453); }

// Polished metal (ore chunks: emit 3 + how much it's its own colour), out of toon shading. It reflects the world
// round it (oreEnv: the terrain and sky baked into a cube near the camera's target, see TerrainRenderer.bakeCube),
// tinted by its own colour and whiter at grazing angles, with the sun's highlight; without the cube, a matcap: its
// colour by where its normal points on screen (a bright sky-like top, a dark horizon band, a white highlight up and to
// the left, a bright rim). Lit by the light there (so it darkens at night), and glints: little stars that flash on its
// faces, now and then and as the camera moves.
fn metalColour(in: VOut, flat: vec3f) -> vec3f {
  // Its faces a little rounded, so the reflections sweep across them.
  let n = normalize(flat + 0.45 * normalize(in.round + vec3f(1e-5)));
  let f = select(normalize(in.world - V.eye.xyz), V.ahead.xyz, V.eye.w > 0.5);
  let k = V.metal.x;
  // Lit softly (the sun wrapped round, the sky and torches), with the highlight from the sun's own light.
  let sunOn = max(V.sun.y, 0.0);
  var light = (0.4 + 0.6 * max(dot(n, V.sun.xyz), 0.0)) * lightIlluminance() / PI + ambient(n);
  for (var i = 0; i < ${MAX_UNIT_LIGHTS}; i++) {
    let l = V.lights[i];
    if (l.w <= 0.0) { continue; }
    light += torchLight(l, in.world, n);
  }
  light += glowLight(in.world, n);
  var col: vec3f;
  if (V.metalEnv.x > 0.5) {
    let r = reflect(f, n);
    var env = textureSampleLevel(oreEnv, skySamp, r, 0.0).rgb;
    env = env / max(vec3f(1.0) - 0.12 * env, vec3f(0.05)); // (undoing the terrain's tone map)
    let fresnel = in.col.rgb + (vec3f(1.0) - in.col.rgb) * pow(1.0 - clamp(-dot(f, n), 0.0, 1.0), 5.0);
    let sun = pow(max(dot(r, V.sun.xyz), 0.0), max(V.metalEnv.w, 1.0)) * V.metalEnv.z * sunOn * lightIlluminance() / PI;
    col = in.col.rgb * light * (1.0 - 0.8 * clamp(k, 0.0, 1.0)) + (env * V.metalEnv.y + vec3f(sun)) * fresnel * k;
  } else {
    var right = cross(f, vec3f(0.0, 1.0, 0.0));
    right = select(vec3f(1.0, 0.0, 0.0), normalize(right), dot(right, right) > 1e-6);
    let up = cross(right, f);
    let nv = vec3f(dot(n, right), dot(n, up), -dot(n, f)); // the normal on screen: x right, y up, z toward the eye
    let sky = smoothstep(-0.7, 0.9, nv.y);
    let band = 1.0 - 0.7 * exp(-pow((nv.y + 0.12) / 0.09, 2.0));
    let spot = smoothstep(0.9, 0.985, dot(normalize(nv), normalize(vec3f(-0.45, 0.6, 0.66))));
    let rim = pow(1.0 - clamp(nv.z, 0.0, 1.0), 3.0);
    let cap = in.col.rgb * mix(1.0, (0.15 + 0.95 * sky) * band + 0.5 * rim, k);
    col = cap * light + vec3f(spot * k) * (sunOn * lightIlluminance() / PI + ambient(vec3f(0.0, 1.0, 0.0)));
  }
  // Glints: on each face (in its box's own coordinates), a grid of spots; a few flash, as time passes and as the
  // way to the eye turns.
  let a = abs(in.local);
  let uv = select(select(in.local.xy, in.local.xz, a.y > a.z), in.local.yz, a.x > max(a.y, a.z));
  let face = sign(in.local) * step(vec3f(max(a.x, max(a.y, a.z)) - 1e-3), a);
  let cell = floor(uv * 2.0);
  let h = hash3(vec3f(cell, dot(face, vec3f(1.0, 2.0, 3.0))) + in.col.rgb * 17.0);
  let flash = pow(max(sin(V.metal.w * V.metal.z * (1.5 + 2.0 * h) + h * 40.0 + dot(f, vec3f(7.0, 5.0, 9.0)) * 3.0), 0.0), 24.0);
  let d = fract(uv * 2.0) - 0.5 - (vec2f(hash3(vec3f(cell, 7.0)), hash3(vec3f(cell, 9.0))) - 0.5) * 0.5;
  let star = max(smoothstep(0.14, 0.0, length(d)), smoothstep(0.05, 0.0, min(abs(d.x), abs(d.y))) * smoothstep(0.45, 0.0, length(d)));
  let glint = star * flash * step(0.55, h) * V.metal.y;
  col += vec3f(glint) * 3.0 * max(sunOn, 0.15) * (lightIlluminance() / PI + ambient(vec3f(0.0, 1.0, 0.0)));
  col = mix(col, in.col.rgb, clamp(in.col.a - 3.0, 0.0, 1.0)); // its own colour, a little
  return col / (1.0 + col * 0.12);
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let n = normalize(in.n);
  if (in.col.a > 2.5) { return vec4f(metalColour(in, n), 1.0); }
  var diffuse = max(dot(n, V.sun.xyz), 0.0);
  // Darken towards each box's edges a touch, so the blocks read as separate pieces (toon shading outlines them
  // instead, its light in bands).
  let e = abs(in.local) * 2.0;
  let edge = max(max(min(e.x, e.y), min(e.y, e.z)), min(e.x, e.z));
  var shade = 1.0 - 0.18 * smoothstep(0.82, 1.0, edge);
  if (V.toon.x > 0.5) {
    let b = max(V.toon.y, 1.0);
    let xb = diffuse * b;
    let s = max(V.toon.z, 1e-3);
    diffuse = (floor(xb) + smoothstep(0.5 - s, 0.5 + s, fract(xb))) / b;
    shade = 1.0;
  }
  var light = diffuse * lightIlluminance() / PI + ambient(n);
  for (var i = 0; i < ${MAX_UNIT_LIGHTS}; i++) {
    let l = V.lights[i];
    if (l.w <= 0.0) { continue; }
    light += torchLight(l, in.world, n);
  }
  light += glowLight(in.world, n);
  var col = in.col.rgb * light * shade;
  col = mix(col, in.col.rgb, min(in.col.a, 1.0)); // a glowing part (a torch's flame) is its own colour
  col = col / (1.0 + col * 0.12);
  return vec4f(col, 1.0);
}

// Toon shading's outlines: each part again, grown by the outline's width in pixels all round (from its centre), with
// only the faces turned away from the eye drawn, in the outline's colour: they show round its edges, behind it. Parts
// thinner than a few hundredths of a voxel (a bowstring) are left out, and so is light (emit 2, a priest's beam).
struct OOut { @builtin(position) pos: vec4f, @location(0) n: vec3f, @location(1) world: vec3f, @location(2) col: vec3f }

@vertex
fn vsOutline(@location(0) corner: vec3f, @location(1) normal: vec3f,
             @location(2) m0: vec4f, @location(3) m1: vec4f, @location(4) m2: vec4f, @location(5) m3: vec4f,
             @location(6) col: vec4f) -> OOut {
  let size = vec3f(length(m0.xyz), length(m1.xyz), length(m2.xyz));
  let dist = select(length(m3.xyz - V.eye.xyz), 1.0, V.eye.w > 0.5);
  let w = V.toon.w * V.ahead.w * dist;
  let thin = min(min(size.x, size.y), size.z) < 0.03;
  let grow = select(1.0 + 2.0 * w / max(size, vec3f(1e-4)), vec3f(0.0), thin || V.toon.x < 0.5);
  let o = part(corner * grow, normal, m0, m1, m2, m3, col);
  var out: OOut;
  out.pos = o.pos;
  out.col = V.outline.rgb;
  out.n = o.n;
  out.world = o.world;
  if ((col.a > 1.5 && col.a < 2.5) || col.a < -0.5) { out.pos = vec4f(0.0, 0.0, 2.0, 1.0); } // light (or emit -1): outside the view, so never drawn
  return out;
}

@fragment
fn fsOutline(in: OOut) -> @location(0) vec4f {
  let toEye = select(V.eye.xyz - in.world, -V.ahead.xyz, V.eye.w > 0.5);
  if (dot(in.n, toEye) > 0.0) { discard; }
  return vec4f(in.col, 1.0);
}

// The selection mask: a selected villager's parts (m2.w 1 blue, 2 red, 3 yellow, 4 purple), seen or not (no depth
// test), as its team over 4; the rest, and light, left out.
struct MOut { @builtin(position) @invariant pos: vec4f, @location(0) @interpolate(flat) team: f32 }

@vertex
fn vsMask(@location(0) corner: vec3f, @location(1) normal: vec3f,
          @location(2) m0: vec4f, @location(3) m1: vec4f, @location(4) m2: vec4f, @location(5) m3: vec4f,
          @location(6) col: vec4f) -> MOut {
  var o: MOut;
  o.pos = part(corner, normal, m0, m1, m2, m3, col).pos;
  if (m2.w < 0.5 || col.a > 1.5) { o.pos = vec4f(0.0, 0.0, 2.0, 1.0); }
  o.team = m2.w / 4.0;
  return o;
}

@fragment
fn fsMask(in: MOut) -> @location(0) vec4f { return vec4f(in.team, 0.0, 0.0, 1.0); }

// Ghost cubes: per instance the voxel (xyz) and its kind (w): 0 dig, 1 fill, 2 dig preview, 3 fill preview; or a
// torch's marker, a stick-sized box centred at xyz + 0.5: 4 marked (or a preview that fits), 5 a preview that doesn't;
// a fill a new game's inventory can't cover, in white: 6 marked, 7 a preview; a farm (farm.js), a slab over the voxel's
// top: 8 marked to be tilled, 9 a preview, 10 a preview where it can't go; a portcullis's opening (gates.js), a cube
// just over the wall's voxel: 11 a preview, 12 a preview the iron won't cover (white), 13 ordered (10 where it can't
// go); a building's or a wall's block: 14 a preview that fits (in the team's colour), 15 one that doesn't, 16 ordered.
// Colours (Jordan): digs and fills, marked or about to be, green; building things (buildings, walls, portcullises,
// farms), previewed or ordered, the team's colour; what the inventory can't cover, white; red only where it can't go.
struct GOut { @builtin(position) pos: vec4f, @location(0) col: vec4f, @location(1) xray: f32 }

@vertex
fn vsGhost(@location(0) corner: vec3f, @location(1) normal: vec3f, @location(2) gi: vec4f) -> GOut {
  // (w also carries, from 32 up, which of the cube's faces touch another ghost of its kind: +x -x +y -y +z -z.
  // Those inside faces are left out, so a group of ghosts shows as one shell.)
  let packed = u32(gi.w);
  let g = vec4f(gi.xyz, f32(packed & 31u));
  let face = select(select(select(5u, 4u, normal.z > 0.5), select(3u, 2u, normal.y > 0.5), abs(normal.y) > 0.5),
    select(1u, 0u, normal.x > 0.5), abs(normal.x) > 0.5);
  let torch = g.w > 3.5 && g.w < 5.5;
  let farm = g.w > 7.5 && g.w < 10.5;
  let gate = g.w > 10.5 && g.w < 13.5;
  let blocked = g.w == 5.0 || g.w == 10.0 || g.w == 15.0; // (where it can't go: red)
  let dig = g.w == 0.0 || g.w == 2.0 || blocked; // (a shell just round the voxel, more opaque)
  let preview = (g.w > 1.5 && g.w < 3.5) || g.w == 7.0 || (g.w > 8.5 && g.w < 12.5) || g.w == 14.0 || g.w == 15.0;
  let size = select(select(vec3f(select(0.94, 1.02, dig || gate)), vec3f(0.16, 0.66, 0.16), torch), vec3f(1.02, 0.14, 1.02), farm);
  var o: GOut;
  o.pos = V.viewProj * vec4f(g.xyz + select(vec3f(0.5), vec3f(0.5, 1.0, 0.5), farm) + corner * size, 1.0);
  let lit = 0.75 + 0.2 * normal.y + 0.08 * normal.x;
  var col = vec3f(0.3, 1.1, 0.4);
  var alpha = select(select(0.22, 0.4, dig), select(0.3, 0.5, dig), preview);
  if (blocked) { col = vec3f(1.3, 0.15, 0.1); }
  if (g.w == 4.0) { col = vec3f(1.5, 1.1, 0.3); }
  if (g.w == 6.0 || g.w == 7.0 || g.w == 12.0) { col = vec3f(1.1, 1.18, 1.35); alpha = select(0.32, 0.45, preview); }
  let team = g.w == 8.0 || g.w == 9.0 || g.w == 11.0 || g.w == 13.0 || g.w == 14.0 || g.w == 16.0;
  if (team) { col = V.selBlue.rgb * 1.25; alpha = select(0.32, 0.45, preview); } // (the player's team's colour)
  if (torch) { alpha = 0.6; }
  o.col = vec4f(col * lit, alpha);
  o.xray = select(0.0, 1.0, g.w == 0.0 || g.w == 2.0); // (a dig, marked or previewed: seen through the ground too)
  if (((packed >> 5u) & (1u << face)) != 0u) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); } // (an inside face: off screen)
  return o;
}

@fragment
fn fsGhost(in: GOut) -> @location(0) vec4f { return in.col; }

// The same, where the ground's in front of it (see ghostHiddenPipeline): digs only, fainter (V.outline.w, xray).
@fragment
fn fsGhostHidden(in: GOut) -> @location(0) vec4f {
  if (in.xray < 0.5) { discard; }
  return vec4f(in.col.rgb, in.col.a * V.outline.w);
}
`;

// The ghosts into data, each one's kind (w) plus 32 × the faces it shares with another ghost of the same kind (bits
// +x -x +y -y +z -z, see vsGhost), so the faces inside a group aren't drawn. Torch markers sit off the grid: all faces.
const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const ghostKinds = new Map();
function ghostFaces(ghosts, ng, data) {
  const key = (x, y, z) => (x * 1024 + z) * 256 + y;
  ghostKinds.clear();
  for (let i = 0; i < ng; i++) {
    const [x, y, z, w] = ghosts[i];
    if (w !== 4 && w !== 5) ghostKinds.set(key(x, y, z), w);
  }
  for (let i = 0; i < ng; i++) {
    const [x, y, z, w] = ghosts[i];
    let mask = 0;
    if (w !== 4 && w !== 5) {
      for (let f = 0; f < 6; f++) {
        const [dx, dy, dz] = SIDES[f];
        if (ghostKinds.get(key(x + dx, y + dy, z + dz)) === w) mask |= 1 << f;
      }
    }
    data[i * 4] = x; data[i * 4 + 1] = y; data[i * 4 + 2] = z; data[i * 4 + 3] = w + 32 * mask;
  }
}

// A unit cube centred on the origin, as 36 vertices of (corner, normal).
function cubeVertices() {
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  const out = [];
  for (const [n, u, v] of faces) {
    const corner = (a, b) => n.map((c, i) => c * 0.5 + u[i] * a * 0.5 + v[i] * b * 0.5);
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) out.push(...corner(a, b), ...n);
  }
  return new Float32Array(out);
}

// Shapes other than boxes, filling the same unit cube centred on the origin (base at y = -0.5, apex at y = 0.5), as
// vertices of (corner, normal) with flat faces: a cone of 10 sides, a square pyramid whose apex is over the middle of
// its back edge (-z), so its back is upright (a wizard's hat), and a 16-sided cylinder.
function pointedVertices(base, apex) {
  const out = [], n = base.length;
  for (let k = 0; k < n; k++) {
    const p0 = base[k], p1 = base[(k + 1) % n];
    const e0 = p1.map((v, i) => v - p0[i]), e1 = apex.map((v, i) => v - p0[i]);
    let nn = [e0[1] * e1[2] - e0[2] * e1[1], e0[2] * e1[0] - e0[0] * e1[2], e0[0] * e1[1] - e0[1] * e1[0]];
    const mid = [(p0[0] + p1[0]) / 2, (p0[2] + p1[2]) / 2];
    if (nn[0] * mid[0] + nn[2] * mid[1] < 0) nn = nn.map((v) => -v); // outwards
    const l = Math.hypot(...nn);
    for (const v of [p0, p1, apex]) out.push(...v, ...nn.map((c) => c / l));
    for (const v of [p0, [0, -0.5, 0], p1]) out.push(...v, 0, -1, 0);
  }
  return new Float32Array(out);
}
export { SHAPES };

// A cylinder of `sides` flat sides along y (a disc, flattened: a shield).
function prismVertices(sides) {
  const out = [];
  const ring = (k, y) => { const a = k / sides * Math.PI * 2; return [Math.sin(a) * 0.5, y, Math.cos(a) * 0.5]; };
  for (let k = 0; k < sides; k++) {
    const mid = (k + 0.5) / sides * Math.PI * 2, n = [Math.sin(mid), 0, Math.cos(mid)];
    const a0 = ring(k, -0.5), a1 = ring(k + 1, -0.5), b0 = ring(k, 0.5), b1 = ring(k + 1, 0.5);
    for (const v of [a0, a1, b1, a0, b1, b0]) out.push(...v, ...n);
    for (const v of [b0, b1, [0, 0.5, 0]]) out.push(...v, 0, 1, 0);
    for (const v of [a1, a0, [0, -0.5, 0]]) out.push(...v, 0, -1, 0);
  }
  return new Float32Array(out);
}
// A banner: a cloth cut to a point at the bottom, as thick as the unit cube: across it, straight sides from its top down
// to its shoulders `point` of the way up from its tip (at the middle of the bottom), flat faces. One shape for each of
// BANNER_STEPS points (see banner-shape.js), so a banner's one part, with no seam where its point starts.
function bannerVertices(point) {
  const out = [], y = point - 0.5, TL = [-0.5, 0.5], TR = [0.5, 0.5], R = [0.5, y], T = [0, -0.5], L = [-0.5, y];
  const face = (vs, n) => { for (const v of vs) out.push(...v, ...n); };
  face([[...TL, 0.5], [...TR, 0.5], [...R, 0.5], [...TL, 0.5], [...R, 0.5], [...T, 0.5], [...TL, 0.5], [...T, 0.5], [...L, 0.5]], [0, 0, 1]);
  face([[...TL, -0.5], [...R, -0.5], [...TR, -0.5], [...TL, -0.5], [...T, -0.5], [...R, -0.5], [...TL, -0.5], [...L, -0.5], [...T, -0.5]], [0, 0, -1]);
  // Round its edge: top, right side, the point's two edges, left side (each out from the middle).
  const ring = [TL, TR, R, T, L];
  for (let k = 0; k < 5; k++) {
    const P = ring[k], Q = ring[(k + 1) % 5], e = [Q[0] - P[0], Q[1] - P[1]], l = Math.hypot(...e);
    if (l < 1e-6) continue;
    const n = [-e[1] / l, e[0] / l, 0];
    face([[...P, 0.5], [...P, -0.5], [...Q, -0.5], [...P, 0.5], [...Q, -0.5], [...Q, 0.5]], n);
  }
  return new Float32Array(out);
}
// A crystal: two square pyramids base to base, its waist `waist` of the way up from its lower tip (the unit cube's
// bottom) to its upper one (the top).
function gemVertices(waist) {
  const out = [], y = waist - 0.5, ring = [[0.5, y, 0], [0, y, 0.5], [-0.5, y, 0], [0, y, -0.5]];
  for (const tip of [[0, 0.5, 0], [0, -0.5, 0]]) {
    for (let k = 0; k < 4; k++) {
      const p0 = ring[k], p1 = ring[(k + 1) % 4];
      const e0 = p1.map((v, i) => v - p0[i]), e1 = tip.map((v, i) => v - p0[i]);
      let nn = [e0[1] * e1[2] - e0[2] * e1[1], e0[2] * e1[0] - e0[0] * e1[2], e0[0] * e1[1] - e0[1] * e1[0]];
      const mid = [p0, p1, tip].reduce((a, v) => a.map((c, i) => c + v[i] / 3), [0, 0, 0]);
      if (nn[0] * mid[0] + nn[1] * (mid[1] - y) + nn[2] * mid[2] < 0) nn = nn.map((v) => -v); // outwards
      const l = Math.hypot(...nn);
      for (const v of [p0, p1, tip]) out.push(...v, ...nn.map((c) => c / l));
    }
  }
  return new Float32Array(out);
}
// A gold nugget: a sphere (an icosahedron split once: 80 faces) made lumpy, each corner pushed in or out a little,
// with smooth normals (the corners' faces' averaged) so it reads round.
function nuggetVertices() {
  const t = (1 + Math.sqrt(5)) / 2;
  let pts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const unit = (p) => { const l = Math.hypot(...p); return p.map((v) => v / l); };
  pts = pts.map(unit);
  const mids = new Map(), mid = (a, b) => {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (!mids.has(key)) { mids.set(key, pts.length); pts.push(unit(pts[a].map((v, i) => v + pts[b][i]))); }
    return mids.get(key);
  };
  faces = faces.flatMap(([a, b, c]) => { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]; });
  // Lumps: each corner's distance out from 0.41 to 0.5, the same every time.
  pts = pts.map((p, k) => { const h = Math.abs(Math.sin(k * 12.9898 + 78.233) * 43758.5453) % 1; return p.map((v) => v * (0.41 + 0.09 * h)); });
  const normals = pts.map(() => [0, 0, 0]);
  for (const [a, b, c] of faces) {
    const e0 = pts[b].map((v, i) => v - pts[a][i]), e1 = pts[c].map((v, i) => v - pts[a][i]);
    let n = [e0[1] * e1[2] - e0[2] * e1[1], e0[2] * e1[0] - e0[0] * e1[2], e0[0] * e1[1] - e0[1] * e1[0]];
    if (n[0] * pts[a][0] + n[1] * pts[a][1] + n[2] * pts[a][2] < 0) n = n.map((v) => -v); // outwards
    for (const k of [a, b, c]) normals[k] = normals[k].map((v, i) => v + n[i]);
  }
  const out = [];
  for (const f of faces) for (const k of f) out.push(...pts[k], ...unit(normals[k]));
  return new Float32Array(out);
}
const SHAPES = {
  nugget: nuggetVertices(),
  cylinder: prismVertices(16),
  cone: pointedVertices(Array.from({ length: 10 }, (_, k) => [Math.sin(k / 10 * Math.PI * 2) * 0.5, -0.5, Math.cos(k / 10 * Math.PI * 2) * 0.5]), [0, 0.5, 0]),
  pyramid: pointedVertices([[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5]], [0, 0.5, -0.5]),
  gem: gemVertices(CRYSTAL_TUNING.waist),
  ...Object.fromEntries(Array.from({ length: BANNER_STEPS }, (_, k) => [`banner${k}`, bannerVertices((k + 0.5) / BANNER_STEPS)])),
};

export class UnitRenderer {
  // sky: the Sky lighting them.
  constructor(device, format, depthFormat, sky) {
    this.device = device;
    this.sky = sky;
    this.player = 'blue'; // the team played from this screen (its ghosts are tinted its colour: selBlue's slot)
    const module = device.createShaderModule({ label: 'units', code: UNITS_WGSL });
    const viewLayout = device.createBindGroupLayout({
      label: 'units view',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: 'cube' } },
      ],
    });
    this.viewLayout = viewLayout;
    const partPipeline = (entryPoint) => device.createRenderPipeline({
      label: `units ${entryPoint}`,
      layout: device.createPipelineLayout({ bindGroupLayouts: [viewLayout, sky.layout] }),
      vertex: {
        module, entryPoint,
        buffers: [
          { arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] },
          {
            arrayStride: 80, stepMode: 'instance',
            attributes: [0, 1, 2, 3, 4].map((i) => ({ shaderLocation: 2 + i, offset: i * 16, format: 'float32x4' })),
          },
        ],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.pipeline = partPipeline('vs');
    this.conePipeline = partPipeline('vsCone');
    this.outlinePipeline = device.createRenderPipeline({
      label: 'units outline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [viewLayout, sky.layout] }),
      vertex: {
        module, entryPoint: 'vsOutline',
        buffers: [
          { arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] },
          {
            arrayStride: 80, stepMode: 'instance',
            attributes: [0, 1, 2, 3, 4].map((i) => ({ shaderLocation: 2 + i, offset: i * 16, format: 'float32x4' })),
          },
        ],
      },
      fragment: { module, entryPoint: 'fsOutline', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.maskPipeline = device.createRenderPipeline({
      label: 'units selection mask',
      layout: device.createPipelineLayout({ bindGroupLayouts: [viewLayout, sky.layout] }),
      vertex: {
        module, entryPoint: 'vsMask',
        buffers: [
          { arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] },
          {
            arrayStride: 80, stepMode: 'instance',
            attributes: [0, 1, 2, 3, 4].map((i) => ({ shaderLocation: 2 + i, offset: i * 16, format: 'float32x4' })),
          },
        ],
      },
      fragment: { module, entryPoint: 'fsMask', targets: [{ format: 'r8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    const sel = device.createShaderModule({ label: 'selection outline', code: SELECT_OUTLINE_WGSL });
    this.selLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    this.selPipeline = device.createRenderPipeline({
      label: 'selection outline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.selLayout] }),
      vertex: { module: sel, entryPoint: 'vs' },
      fragment: {
        module: sel, entryPoint: 'fs',
        targets: [{ format, blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        } }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.selUniforms = device.createBuffer({ size: 24 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.mask = null;
    this.ghostPipeline = device.createRenderPipeline({
      label: 'ghost cubes',
      layout: device.createPipelineLayout({ bindGroupLayouts: [viewLayout] }),
      vertex: {
        module, entryPoint: 'vsGhost',
        buffers: [
          { arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] },
          { arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x4' }] },
        ],
      },
      fragment: {
        module, entryPoint: 'fsGhost',
        targets: [{ format, blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
        } }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' }, // (only the faces you'd see were it solid)
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less' },
    });
    // Marked digs behind the ground: their front faces where the depth test fails (greater), so a buried vein shows
    // through and an exposed block isn't drawn twice.
    this.ghostHiddenPipeline = device.createRenderPipeline({
      label: 'ghost cubes behind the ground',
      layout: device.createPipelineLayout({ bindGroupLayouts: [viewLayout] }),
      vertex: {
        module, entryPoint: 'vsGhost',
        buffers: [
          { arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] },
          { arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x4' }] },
        ],
      },
      fragment: {
        module, entryPoint: 'fsGhostHidden',
        targets: [{ format, blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
        } }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater' },
    });
    this.ghosts = device.createBuffer({ size: MAX_GHOSTS * 16, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.ghostData = new Float32Array(MAX_GHOSTS * 4);
    const verts = cubeVertices();
    this.cube = device.createBuffer({ size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.cube, 0, verts);
    this.shapes = Object.entries(SHAPES).map(([name, v]) => {
      const buffer = device.createBuffer({ size: v.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, v);
      return { name, buffer, count: v.length / 6, first: 0, n: 0 };
    });
    this.instances = device.createBuffer({ size: MAX_PARTS * 80, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.instanceData = new Float32Array(MAX_PARTS * 20);
    this.uniforms = device.createBuffer({ size: (64 + 4 * MAX_UNIT_LIGHTS + 8 * MAX_GLOWS) * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const blank = device.createTexture({ label: 'no reflection cube', size: [1, 1, 6], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING });
    this.setEnv(blank.createView({ dimension: 'cube' }));
  }

  // The cube view metal parts reflect (see metalColour; used while cam.metalEnv's x is 1).
  setEnv(view) {
    if (view === this.env) return;
    this.env = view;
    this.bindGroup = this.device.createBindGroup({
      layout: this.viewLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniforms } }, { binding: 1, resource: view }],
    });
  }

  // The ghost cubes draw() was given, in a pass of their own, so they can go over the fog of war (Jordan: orders show
  // where it's not been seen). Uses draw()'s uniforms, so call it after that, in the same frame.
  drawGhosts(encoder, colorView, depthView) {
    if (!this.ng) return;
    const pass = encoder.beginRenderPass({
      label: 'ghost cubes',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'store' },
    });
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.cube);
    pass.setVertexBuffer(1, this.ghosts);
    if (GHOST_TUNING.xray > 0) {
      pass.setPipeline(this.ghostHiddenPipeline);
      pass.draw(36, this.ng);
    }
    pass.setPipeline(this.ghostPipeline);
    pass.draw(36, this.ng);
    pass.end();
  }

  // parts: [{ m: 16 floats, col: [r, g, b], emit (0-1, how much it's its own colour; 2: light, its own colour and never
// outlined: a priest's beam), shape (one of SHAPES, or a box) }]; ghosts: [[x, y, z, kind]] (see vsGhost).
  // torch: [r, g, b, reach]; lights: [[x, y, z, brightness]] (the nearest MAX_UNIT_LIGHTS are used); cam: { eye, ahead
  // (the way it looks), ortho, pixel (a pixel's world size at unit distance, or anywhere when orthographic), size: the
  // canvas's [width, height], metal, metalEnv: see View.metal }, for toon shading's outlines, the selected's and metal parts.
  // glows: coloured lights, [[x, y, z, reach, r, g, b]] (colour × strength), the first MAX_GLOWS.
  draw(encoder, colorView, depthView, viewProj, sun, parts, profiler, ghosts = [], torch = [0, 0, 0, 1], lights = [], cam = null, glows = []) {
    const n = Math.min(parts.length, MAX_PARTS);
    const ng = Math.min(ghosts.length, MAX_GHOSTS);
    this.ng = ng; // (the ghosts are drawn after the fog of war: see drawGhosts)
    if (!n && !ng) return;
    // Boxes first, then each of the other shapes.
    const d = this.instanceData;
    let i = 0, boxes = 0;
    for (const shape of [null, ...this.shapes]) {
      const first = i;
      for (let j = 0; j < n; j++) {
        const part = parts[j];
        if ((part.shape ?? null) !== (shape?.name ?? null)) continue;
        d.set(part.m, i * 20);
        d.set(part.col, i * 20 + 16);
        d[i * 20 + 19] = part.emit ?? 0;
        i++;
      }
      if (shape) { shape.first = first; shape.n = i - first; } else boxes = i;
    }
    if (n) this.device.queue.writeBuffer(this.instances, 0, d, 0, n * 20);
    ghostFaces(ghosts, ng, this.ghostData);
    if (ng) this.device.queue.writeBuffer(this.ghosts, 0, this.ghostData, 0, ng * 4);
    const u = new Float32Array(64 + 4 * MAX_UNIT_LIGHTS + 8 * MAX_GLOWS);
    u.set(viewProj, 0);
    u.set([...sun, 0], 16);
    u.set(torch, 20);
    lights.slice(0, MAX_UNIT_LIGHTS).forEach((l, i) => u.set(l, 24 + i * 4));
    const T = TOON_TUNING, toon = T.on > 0.5 && cam, base = 24 + 4 * MAX_UNIT_LIGHTS;
    if (cam) u.set([...cam.eye, cam.ortho ? 1 : 0, ...cam.ahead, cam.pixel], base);
    u.set([toon ? 1 : 0, Math.max(1, Math.round(T.bands)), T.softness, T.unitOutline, ...linearColor(T.unitColor), GHOST_TUNING.xray], base + 8);
    const HB = HEALTHBAR_TUNING;
    const hotPlayer = HB[`hot${this.player[0].toUpperCase()}${this.player.slice(1)}`] ?? HB.hotBlue;
    u.set([...linearColor(hotPlayer), SELECT_TUNING.outline, ...linearColor(HB.hotRed), 0], base + 16);
    u.set([...linearColor(HB.hotYellow), 0, ...linearColor(HB.hotPurple), 0], base + 24);
    u.set(cam?.metal ?? [0, 0, 0, 0], base + 32);
    u.set(cam?.metalEnv ?? [0, 0, 0, 0], base + 36);
    glows.slice(0, MAX_GLOWS).forEach(([x, y, z, reach, r, g, b], i) => u.set([x, y, z, reach, r, g, b, 0], base + 40 + i * 8));
    let selected = false;
    for (let j = 0; j < n && !selected; j++) selected = parts[j].m[11] > 0.5;
    this.device.queue.writeBuffer(this.uniforms, 0, u);
    let pass = encoder.beginRenderPass({
      label: 'units',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'store' },
      timestampWrites: profiler?.tsw('units'),
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setBindGroup(1, this.sky.group);
    pass.setVertexBuffer(0, this.cube);
    pass.setVertexBuffer(1, this.instances);
    if (boxes) pass.draw(36, boxes);
    if (n > boxes) {
      pass.setPipeline(this.conePipeline);
      for (const sh of this.shapes) {
        if (!sh.n) continue;
        pass.setVertexBuffer(0, sh.buffer);
        pass.draw(sh.count, sh.n, 0, sh.first);
      }
      pass.setVertexBuffer(0, this.cube);
    }
    const outline = selected && SELECT_TUNING.outline > 0 && cam?.size;
    if (outline) {
      // The selected's mask (their whole silhouette, behind the terrain too).
      pass.end();
      const [W, H] = cam.size;
      if (!this.mask || this.mask.width !== W || this.mask.height !== H) {
        this.mask?.destroy();
        this.mask = this.device.createTexture({ label: 'selection mask', size: [W, H], format: 'r8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        this.selGroup = this.device.createBindGroup({
          layout: this.selLayout,
          entries: [{ binding: 0, resource: { buffer: this.selUniforms } }, { binding: 1, resource: this.mask.createView() }],
        });
      }
      const mp = encoder.beginRenderPass({
        label: 'selection mask',
        colorAttachments: [{ view: this.mask.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
      });
      mp.setPipeline(this.maskPipeline);
      mp.setBindGroup(0, this.bindGroup);
      mp.setBindGroup(1, this.sky.group);
      mp.setVertexBuffer(1, this.instances);
      mp.setVertexBuffer(0, this.cube);
      if (boxes) mp.draw(36, boxes);
      for (const sh of this.shapes) {
        if (!sh.n) continue;
        mp.setVertexBuffer(0, sh.buffer);
        mp.draw(sh.count, sh.n, 0, sh.first);
      }
      mp.end();
      pass = encoder.beginRenderPass({
        label: 'units outlines',
        colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'store' },
      });
      pass.setBindGroup(0, this.bindGroup);
      pass.setBindGroup(1, this.sky.group);
      pass.setVertexBuffer(0, this.cube);
      pass.setVertexBuffer(1, this.instances);
    }
    // Toon shading's outlines (see vsOutline), after every part, so none hides behind another's.
    if (toon && T.unitOutline > 0) {
      pass.setPipeline(this.outlinePipeline);
      if (boxes) pass.draw(36, boxes);
      for (const sh of this.shapes) {
        if (!sh.n) continue;
        pass.setVertexBuffer(0, sh.buffer);
        pass.draw(sh.count, sh.n, 0, sh.first);
      }
      pass.setVertexBuffer(0, this.cube);
    }
    pass.end();
    if (outline) {
      // Round the selected's silhouette (see SELECT_OUTLINE_WGSL), over everything drawn so far.
      const HB = HEALTHBAR_TUNING, su = new Float32Array(24);
      [HB.hotBlue, HB.hotRed, HB.hotYellow, HB.hotPurple].forEach((c, k) => su.set([...linearColor(c), 0], k * 4));
      su.set([Math.min(SELECT_TUNING.outline, 6), ...cam.size, 0], 16);
      this.device.queue.writeBuffer(this.selUniforms, 0, su);
      const sp = encoder.beginRenderPass({
        label: 'selection outline',
        colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
        timestampWrites: profiler?.tsw('selection outline'),
      });
      sp.setPipeline(this.selPipeline);
      sp.setBindGroup(0, this.selGroup);
      sp.draw(3);
      sp.end();
    }
  }
}

// The selected villagers' outline: a pixel outside the selection mask with one in it within the outline's width is
// drawn in that one's team's colour (the nearest's), faded off at the edge.
const SELECT_OUTLINE_WGSL = /* wgsl */ `
// colors: blue, red, yellow, purple (linear rgb); params: width (pixels), screen size (yz).
struct U { colors: array<vec4f, 4>, params: vec4f }
@group(0) @binding(0) var<uniform> O: U;
@group(0) @binding(1) var mask: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn team(px: vec2i) -> i32 {
  let q = clamp(px, vec2i(0), vec2i(O.params.yz) - 1);
  return i32(round(textureLoad(mask, q, 0).r * 4.0));
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let px = vec2i(pos.xy);
  if (team(px) > 0) { discard; }
  let R = O.params.x;
  let n = i32(ceil(R));
  var best = 1e9;
  var k = 0;
  for (var dy = -6; dy <= 6; dy++) {
    if (abs(dy) > n) { continue; }
    for (var dx = -6; dx <= 6; dx++) {
      if (abs(dx) > n) { continue; }
      let d2 = f32(dx * dx + dy * dy);
      if (d2 >= best || d2 > (R + 0.5) * (R + 0.5)) { continue; }
      let t = team(px + vec2i(dx, dy));
      if (t > 0) { best = d2; k = t; }
    }
  }
  let a = clamp(R + 0.5 - sqrt(best), 0.0, 1.0);
  if (a <= 0.0 || k == 0) { discard; }
  return vec4f(O.colors[k - 1].rgb, a);
}
`;
