// Cartoon grass tufts: three flat blades each, standing upright on the tops of grassy ground (not sand, stone, char or
// under anything), scattered off the voxels' centres and turned to face the camera about the vertical. Drawn as
// instanced quads after the terrain, against its depth, within GRASS_TUNING.range of the camera's target; each blade is
// cut out of its quad by its shape, outlined round its sides and tip (not along the ground) and lit like the ground
// (the sun shadow there, toon shading's bands).
//
// Which columns have grass, and how high its top is, live in a 500 × 500 texture (0 = none) that edits update; where
// the tufts are, how many, how tall and which way they lean come from a hash of the column, so the tuning applies at once.
//
// When the grassy voxel under drawn tufts is dug, blown up or charred, each of their blades puffs up into the air and
// flutters down, rocking from side to side, until it lands, and then shrinks away (Grass.tick moves them; the same
// hash, repeated here, says where the tufts and their blades were).

import { skyWgsl, linearColor } from './sky.js';
import { SIZE, BLOCK, TERRAIN_MIN, WATER_LEVEL } from './terrain.js';
import { TOON_TUNING, SNOW_TUNING, SNOW_WGSL } from './render.js';

// Tuning (T > Ground).
export const GRASS_TUNING = {
  on: 1,
  density: 2.25,           // tufts per grassy voxel top on average (up to 3)
  height: 0.26,            // voxels, the tallest blade (each tuft 0.75-1.25 times it)
  width: 1.2,              // the blades' width
  lean: 2,                 // how far the side blades bend out
  variation: 0.1,          // how much each blade's shade varies
  range: 96,               // voxels from the camera's target they're drawn to (shrinking away over the last fifth)
  outline: 1.3,            // pixels
  outlineColor: '#007502',
  tint: '#fffafa',         // times the grass texture's average colour
  puff: 3,                 // voxels/s: how fast a lost tuft's blades fly up
  fall: 0.6,               // voxels/s: how fast they flutter down
  flutter: 1,              // how far they rock and drift from side to side
};
const MAX_BLADES = 4096;

// Grass needs its top above the sand by the water (see render.js: a cube's top within 1.5 of the water is sand).
const MIN_TOP = Math.floor(WATER_LEVEL + 1.5) + 1;
const MAX_RANGE = 96;

export const GRASS_WGSL = /* wgsl */ `
// origin: the window's corner column (xz) and its width in columns (z), range (w); tuft: density, height, width,
// variation; tint: rgb, outline width (pixels); outline: rgb, toon on (w); toon: bands, softness, screen size (zw);
// centre: the camera's target (xz), lean; snow: its colour (rgb, with the tint), on (w); snowLine: height over the sea,
// jitter (see render.js SNOW_TUNING).
struct View {
  viewProj: mat4x4f, sun: vec4f, eye: vec4f, ahead: vec4f, origin: vec4f, tuft: vec4f, tint: vec4f, outline: vec4f,
  toon: vec4f, centre: vec4f, snow: vec4f, snowLine: vec4f,
}
@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var tops: texture_2d<u32>;
@group(0) @binding(2) var albedo: texture_2d_array<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var shadowTex: texture_2d<f32>;
${skyWgsl(1)}
${SNOW_WGSL}

fn hash(a: u32) -> u32 {
  var x = a * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return (x >> 22u) ^ x;
}
fn rand(h: u32, k: u32) -> f32 { return f32(hash(h + k * 0x9e3779b9u) & 0xffffffu) / 16777216.0; }

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,                     // x across (in tuft heights), y up (0 at the ground, 1 at the top)
  @location(1) @interpolate(flat) seed: u32,
  @location(2) @interpolate(flat) base: vec3f,   // the grass's colour
  @location(3) @interpolate(flat) px: vec2f,     // x: a pixel in tuft heights; y: sun on the ground there (0-1)
  @location(4) @interpolate(flat) line: vec3f,   // its outline's colour
}

// The quad's half width, in tuft heights: room for the side blades as far as they lean.
fn halfWidth() -> f32 { return max(0.65, 0.25 + 0.42 * V.centre.z); }

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  o.pos = vec4f(2.0, 2.0, 2.0, 1.0); // (off screen: no tuft)
  let n = u32(V.origin.z);
  let k = ii % 3u;
  let cell = ii / 3u;
  let col = vec2i(V.origin.xy) + vec2i(i32(cell % n), i32(cell / n));
  if (any(col < vec2i(0)) || any(col >= vec2i(${SIZE[0]}, ${SIZE[2]}))) { return o; }
  let top = textureLoad(tops, col, 0).r;
  if (top == 0u) { return o; }
  let h = hash((u32(col.x) * 73856093u) ^ (u32(col.y) * 19349663u) ^ (k * 83492791u));
  if (rand(h, 0u) >= clamp(V.tuft.x - f32(k), 0.0, 1.0)) { return o; }
  let foot = vec3f(f32(col.x) + 0.18 + 0.64 * rand(h, 1u), f32(top), f32(col.y) + 0.18 + 0.64 * rand(h, 2u));
  let fade = 1.0 - smoothstep(0.8 * V.origin.w, V.origin.w, length(foot.xz - V.centre.xy));
  let size = V.tuft.y * (0.75 + 0.5 * rand(h, 3u)) * fade;
  if (size <= 0.0) { return o; }
  // Upright, square to the way to the eye (or to the view, orthographic).
  let toEye = select(V.eye.xyz - foot, -V.ahead.xyz, V.eye.w > 0.5);
  let level = vec2f(toEye.x, toEye.z);
  let f = select(vec2f(0.0, 1.0), normalize(level), dot(level, level) > 1e-8);
  let right = vec3f(f.y, 0.0, -f.x);
  var corners = array<vec2f, 6>(vec2f(-1.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(-1.0, 0.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let corner = corners[vi];
  // From a hair under the ground, so they meet it without a seam.
  let lift = -0.03;
  let hw = halfWidth();
  let world = foot + right * corner.x * hw * size + vec3f(0.0, lift + corner.y * size, 0.0);
  o.pos = V.viewProj * vec4f(world, 1.0);
  o.local = vec2f(corner.x * hw, corner.y + lift / size);
  o.seed = h;
  o.base = textureSampleLevel(albedo, samp, vec2f(0.5), 0, 16.0).rgb * V.tint.rgb;
  o.line = V.outline.rgb;
  // (Above the snow line: white, its outline grey.)
  if (V.snow.w > 0.5 && f32(top) >= snowLine(col, V.snowLine.x, V.snowLine.y)) {
    o.base = V.snow.rgb;
    o.line = vec3f(dot(V.outline.rgb, vec3f(0.2126, 0.7152, 0.0722)));
  }
  let pixel = select(V.ahead.w * length(V.eye.xyz - foot), V.ahead.w, V.eye.w > 0.5);
  // The sun shadow (half resolution) where the tuft stands.
  let c = V.viewProj * vec4f(foot, 1.0);
  let s = vec2f(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5) * V.toon.zw;
  let q = clamp(vec2i(s * 0.5), vec2i(0), vec2i(textureDimensions(shadowTex)) - 1);
  o.px = vec2f(pixel / size, textureLoad(shadowTex, q, 0).r);
  return o;
}

// Signed distance (in tuft heights, roughly) from p to a blade: from its foot at x = b up to its tip at (t, h), bending
// out as it rises (its middle at b + (t - b) s², s = y / h), w0 wide each side at the foot, narrowing to the tip.
fn blade(p: vec2f, b: f32, t: f32, h: f32, w0: f32) -> f32 {
  if (p.y >= h) { return length(p - vec2f(t, h)); }
  let s = max(p.y, 0.0) / h;
  let cx = b + (t - b) * s * s;
  let slope = (t - b) * 2.0 * s / h;
  let hw = w0 * pow(1.0 - s, 0.7);
  return (abs(p.x - cx) - hw) / sqrt(1.0 + slope * slope);
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let h = in.seed;
  let m = select(-1.0, 1.0, rand(h, 4u) < 0.5); // mirrored or not
  let p = vec2f(in.local.x * m, in.local.y);
  let w = V.tuft.z;
  let lean = V.centre.z;
  let ow = V.tint.w * in.px.x * 0.5; // half the outline's width
  // Back to front: the tall one, then the two leaning out either side.
  var bl = array<vec4f, 3>(
    vec4f(0.02, 0.02 + (0.06 + 0.1 * rand(h, 5u)) * lean, 0.9 + 0.1 * rand(h, 6u), 0.13 * w),
    vec4f(-0.06, -0.06 - (0.28 + 0.1 * rand(h, 7u)) * lean, 0.55 + 0.15 * rand(h, 8u), 0.14 * w),
    vec4f(0.07, 0.07 + (0.18 + 0.1 * rand(h, 9u)) * lean, 0.68 + 0.15 * rand(h, 10u), 0.12 * w),
  );
  var shades = array<f32, 3>(0.86, 1.0, 1.07);
  var col = vec3f(0.0);
  var hit = false;
  var line = false;
  for (var i = 0; i < 3; i++) {
    let b = bl[i];
    let d = blade(p, b.x, b.y, b.z, b.w);
    if (d > ow) { continue; }
    hit = true;
    line = d >= -ow && ow > 0.0;
    col = in.base * shades[i] * (1.0 + V.tuft.w * (rand(h, 11u + u32(i)) * 2.0 - 1.0));
  }
  if (!hit || in.local.y < 0.0) { discard; }
  // Lit like the ground under it, the outline too (so it darkens at night).
  return vec4f(select(col, in.line, line) * light(in.px.y), 1.0);
}

// The light on a blade: the sun (in toon shading's bands), times shadow (0-1), and the sky.
fn light(shadow: f32) -> vec3f {
  var diffuse = max(V.sun.y, 0.0) * shadow;
  if (V.outline.w > 0.5) {
    let nb = max(V.toon.x, 1.0);
    let xb = diffuse * nb;
    let s = max(V.toon.y, 1e-3);
    diffuse = (floor(xb) + smoothstep(0.5 - s, 0.5 + s, fract(xb))) / nb;
  }
  return diffuse * lightIlluminance() / PI + ambient(vec3f(0.0, 1.0, 0.0));
}

// A falling blade (see Grass.tick): a: its middle (xyz), its tuft's height; b: its turn (radians, in the screen's
// plane), mirrored (±1), its tip's x, its height; c: its width, shade, scale (shrinking away as it lands).
struct BOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,                     // across and up the blade, from its foot (in tuft heights)
  @location(1) @interpolate(flat) shape: vec4f,  // mirrored, tip x, height, width
  @location(2) @interpolate(flat) col: vec4f,    // rgb, a pixel in tuft heights
}

@vertex
fn vsBlade(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f, @location(2) c: vec4f) -> BOut {
  var o: BOut;
  var corners = array<vec2f, 6>(vec2f(-1.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(-1.0, 0.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let corner = corners[vi];
  let local = vec2f(corner.x * halfWidth(), corner.y * 1.1 - 0.05);
  // Turned about its middle.
  let r = local - vec2f(b.y * b.z * 0.5, b.w * 0.5);
  let cs = vec2f(cos(b.x), sin(b.x));
  let turned = vec2f(r.x * cs.x - r.y * cs.y, r.x * cs.y + r.y * cs.x);
  let toEye = select(V.eye.xyz - a.xyz, -V.ahead.xyz, V.eye.w > 0.5);
  let level = vec2f(toEye.x, toEye.z);
  let f = select(vec2f(0.0, 1.0), normalize(level), dot(level, level) > 1e-8);
  let right = vec3f(f.y, 0.0, -f.x);
  let size = a.w * c.z;
  o.pos = V.viewProj * vec4f(a.xyz + (right * turned.x + vec3f(0.0, turned.y, 0.0)) * size, 1.0);
  o.local = local;
  o.shape = vec4f(b.y, b.z, b.w, c.x);
  let pixel = select(V.ahead.w * length(V.eye.xyz - a.xyz), V.ahead.w, V.eye.w > 0.5);
  o.col = vec4f(textureSampleLevel(albedo, samp, vec2f(0.5), 0, 16.0).rgb * V.tint.rgb * c.y, pixel / max(size, 1e-4));
  return o;
}

@fragment
fn fsBlade(in: BOut) -> @location(0) vec4f {
  let p = vec2f(in.local.x * in.shape.x, in.local.y);
  // Closed along its foot too, now it's off the ground.
  let d = max(blade(p, 0.0, in.shape.y, in.shape.z, in.shape.w), -p.y);
  let ow = V.tint.w * in.col.w * 0.5;
  if (d > ow) { discard; }
  return vec4f(select(in.col.rgb, V.outline.rgb, d >= -ow && ow > 0.0) * light(1.0), 1.0);
}
`;

// The shader's hash and rand, for where the tufts and their blades are.
function hash(a) {
  let x = (Math.imul(a >>> 0, 747796405) + 2891336453) >>> 0;
  x = Math.imul(((x >>> ((x >>> 28) + 4)) ^ x) >>> 0, 277803737) >>> 0;
  return ((x >>> 22) ^ x) >>> 0;
}
const rand = (h, k) => (hash((h + Math.imul(k, 0x9e3779b9)) >>> 0) & 0xffffff) / 16777216;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// Each tuft's blades, back to front (as in fs): [foot x, tip x, height, width, shade].
function bladesOf(h) {
  const G = GRASS_TUNING;
  return [
    [0.02, 0.02 + (0.06 + 0.1 * rand(h, 5)) * G.lean, 0.9 + 0.1 * rand(h, 6), 0.13 * G.width, 0.86],
    [-0.06, -0.06 - (0.28 + 0.1 * rand(h, 7)) * G.lean, 0.55 + 0.15 * rand(h, 8), 0.14 * G.width, 1.0],
    [0.07, 0.07 + (0.18 + 0.1 * rand(h, 9)) * G.lean, 0.68 + 0.15 * rand(h, 10), 0.12 * G.width, 1.07],
  ].map((bl, i) => { bl[4] *= 1 + G.variation * (rand(h, 11 + i) * 2 - 1); return bl; });
}

export class Grass {
  // terrain: the Terrain; albedo: the ground's texture array (layer 0 grass); sky: the Sky lighting them.
  constructor(device, format, depthFormat, terrain, albedo, sky) {
    this.device = device;
    this.terrain = terrain;
    this.sky = sky;
    const [X, , Z] = SIZE;
    this.topData = new Uint8Array(X * Z);
    this.tops = device.createTexture({ label: 'grass tops', size: [X, Z], format: 'r8uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.update([0, 0, 0], SIZE);
    this.albedo = albedo;
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    const module = device.createShaderModule({ label: 'grass', code: GRASS_WGSL });
    this.layout = device.createBindGroupLayout({
      label: 'grass',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'uint' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, texture: { viewDimension: '2d-array' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, sampler: {} },
        { binding: 4, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      label: 'grass',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout, sky.layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.uniforms = device.createBuffer({ size: 64 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.shadowFor = null;
    this.bladePipeline = device.createRenderPipeline({
      label: 'falling grass',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout, sky.layout] }),
      vertex: {
        module, entryPoint: 'vsBlade',
        buffers: [{ arrayStride: 48, stepMode: 'instance', attributes: [0, 1, 2].map((i) => ({ shaderLocation: i, offset: i * 16, format: 'float32x4' })) }],
      },
      fragment: { module, entryPoint: 'fsBlade', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.bladeBuffer = device.createBuffer({ size: MAX_BLADES * 48, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.bladeData = new Float32Array(MAX_BLADES * 12);
    this.falling = []; // blades in the air (see lose and tick)
    this.blank = null; // fog of war: a byte a column, 0 for none here (never seen, see fog.js and TerrainField.blank)
    this.view = null;  // where the camera was last drawn from, for which tufts were showing
  }

  // Which columns in the voxel box [lo, hi) have grass on top, and how high (after an edit, or a fireball's char).
  // quiet: lost tufts don't fly off (an edit shown long after it happened, see fog.js).
  update(lo, hi, quiet = false) {
    const t = this.terrain, [X, Y, Z] = SIZE;
    const x0 = Math.max(0, lo[0]), x1 = Math.min(X, hi[0]), z0 = Math.max(0, lo[2]), z1 = Math.min(Z, hi[2]);
    if (x0 >= x1 || z0 >= z1) return;
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        let top = 0;
        for (let y = Y - 1; y >= 0; y--) {
          const i = t.index(x, y, z), v = t.voxels[i];
          if (v < TERRAIN_MIN) continue;
          // The highest ground: grass if it's open to the sky right above (no tree, block or building on it), not
          // charred, and above the sand.
          if (v === BLOCK.GROUND && y + 1 >= MIN_TOP && t.char[i] === 0 && (y + 1 >= Y || t.voxels[i + X] === BLOCK.AIR)) top = y + 1;
          break;
        }
        if (this.blank && this.blank[x + z * X] === 0) top = 0; // (never seen, with fog of war drawn as nothing)
        const was = this.topData[x + z * X];
        // Its tufts' blades fly off if the grassy voxel itself went (dug, blown up) or was charred, not if it was
        // only covered over.
        if (was && was !== top && !quiet) {
          const i = t.index(x, was - 1, z);
          if (t.voxels[i] !== BLOCK.GROUND || t.char[i] !== 0) this.lose(x, z, was);
        }
        this.topData[x + z * X] = top;
      }
    }
    this.device.queue.writeTexture({ texture: this.tops, origin: [x0, z0] }, this.topData,
      { offset: x0 + z0 * X, bytesPerRow: X }, [x1 - x0, z1 - z0]);
  }

  // The tufts that were drawn on column (x, z), its grass top at height top: each of their blades into the air.
  lose(x, z, top) {
    const G = GRASS_TUNING, v = this.view;
    if (!v || G.on < 0.5) return;
    for (let k = 0; k < 3; k++) {
      const h = hash(Math.imul(x, 73856093) ^ Math.imul(z, 19349663) ^ Math.imul(k, 83492791));
      if (rand(h, 0) >= Math.min(1, Math.max(0, Math.min(3, G.density) - k))) continue;
      const foot = [x + 0.18 + 0.64 * rand(h, 1), top, z + 0.18 + 0.64 * rand(h, 2)];
      const fade = 1 - smooth(0.8 * v.range, v.range, Math.hypot(foot[0] - v.target[0], foot[2] - v.target[2]));
      const size = G.height * (0.75 + 0.5 * rand(h, 3)) * fade;
      if (size <= 0) continue;
      const m = rand(h, 4) < 0.5 ? -1 : 1;
      // Across the tuft as it was drawn: square to the way to the eye.
      let fx = v.ortho ? -v.ahead[0] : v.eye[0] - foot[0], fz = v.ortho ? -v.ahead[2] : v.eye[2] - foot[2];
      const l = Math.hypot(fx, fz) || 1;
      const right = [fz / l, -fx / l];
      for (const [b, tip, bh, w, shade] of bladesOf(h)) {
        if (this.falling.length >= MAX_BLADES) return;
        // From its middle, as it stood (mirrored, its foot b along the tuft).
        const across = m * (b + (tip - b) * 0.5) * size;
        const a = Math.random() * Math.PI * 2, out = 0.4 + 0.8 * Math.random();
        this.falling.push({
          p: [foot[0] + right[0] * across, foot[1] + bh * 0.5 * size, foot[2] + right[1] * across],
          v: [Math.cos(a) * out, G.puff * (0.7 + 0.6 * Math.random()), Math.sin(a) * out],
          size, m, tip: tip - b, h: bh, w, shade,
          turn: 0, spin: (Math.random() * 2 - 1) * 8, phase: Math.random() * Math.PI * 2, rate: 3 + 2 * Math.random(),
          drift: [Math.cos(a + 1.6), Math.sin(a + 1.6)], age: 0, landed: -1,
        });
      }
    }
  }

  // Moves the falling blades on by dt seconds: up with the puff, then fluttering down (falling no faster than
  // GRASS_TUNING.fall, rocking and drifting side to side), until one lands and shrinks away.
  tick(dt) {
    if (!this.falling.length) return;
    const G = GRASS_TUNING, t = this.terrain;
    dt = Math.min(dt, 0.05);
    this.falling = this.falling.filter((f) => {
      f.age += dt;
      if (f.landed >= 0) return (f.landed += dt) < 0.3;
      f.v[1] = Math.max(f.v[1] - 9 * dt, -G.fall);
      // Its first spin slows; then it rocks as it drifts, a falling leaf's swing.
      f.spin *= Math.exp(-3 * dt);
      const settled = Math.min(1, f.age / 0.8);
      const swing = Math.sin(f.age * f.rate + f.phase);
      f.turn += f.spin * dt;
      f.turn += (swing * 0.7 * G.flutter - f.turn) * Math.min(1, dt * 4) * settled;
      const sway = Math.cos(f.age * f.rate + f.phase) * G.flutter * 0.8 * settled;
      f.v[0] *= Math.exp(-2 * dt);
      f.v[2] *= Math.exp(-2 * dt);
      f.p[0] += (f.v[0] + f.drift[0] * sway) * dt;
      f.p[1] += f.v[1] * dt;
      f.p[2] += (f.v[2] + f.drift[1] * sway) * dt;
      const ground = Math.max(t.heightAt(f.p[0], f.p[2]), WATER_LEVEL);
      if (f.v[1] < 0 && f.p[1] - f.h * 0.5 * f.size * Math.abs(Math.cos(f.turn)) <= ground) f.landed = 0;
      return f.age < 12;
    });
  }

  // shadow: the terrain's sun shadow texture (half resolution); cam: { eye, ahead, ortho, pixel, target, size: [w, h] }.
  draw(encoder, colorView, depthView, shadow, viewProj, sun, cam, profiler) {
    const G = GRASS_TUNING;
    const range = Math.max(1, Math.min(MAX_RANGE, G.range));
    this.view = { eye: cam.eye, ahead: cam.ahead, ortho: cam.ortho, target: cam.target, range };
    const tufts = G.on > 0.5 && G.density > 0 && G.height > 0;
    if (!tufts && !this.falling.length) return;
    if (this.shadowFor !== shadow) {
      this.shadowFor = shadow;
      this.group = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniforms } },
          { binding: 1, resource: this.tops.createView() },
          { binding: 2, resource: this.albedo.createView({ dimension: '2d-array' }) },
          { binding: 3, resource: this.sampler },
          { binding: 4, resource: shadow.createView() },
        ],
      });
    }
    const r = Math.ceil(range), n = 2 * r + 1;
    const [tx, , tz] = cam.target;
    const T = TOON_TUNING;
    const u = new Float32Array(64);
    u.set(viewProj, 0);
    u.set([...sun, 0], 16);
    u.set([...cam.eye, cam.ortho ? 1 : 0], 20);
    u.set([...cam.ahead, cam.pixel], 24);
    u.set([Math.floor(tx) - r, Math.floor(tz) - r, n, range], 28);
    u.set([Math.min(3, G.density), G.height, G.width, G.variation], 32);
    u.set([...linearColor(G.tint), G.outline], 36);
    u.set([...linearColor(G.outlineColor), T.on > 0.5 ? 1 : 0], 40);
    u.set([Math.max(1, Math.round(T.bands)), T.softness, ...cam.size], 44);
    u.set([tx, tz, G.lean, 0], 48);
    const W = SNOW_TUNING;
    u.set([...linearColor(W.color).map((c, i) => c * linearColor(G.tint)[i]), W.on > 0.5 ? 1 : 0], 52);
    u.set([W.height, W.jitter, 0, 0], 56);
    this.device.queue.writeBuffer(this.uniforms, 0, u);
    const pass = encoder.beginRenderPass({
      label: 'grass',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'store' },
      timestampWrites: profiler?.tsw('grass'),
    });
    pass.setBindGroup(0, this.group);
    pass.setBindGroup(1, this.sky.group);
    if (tufts) {
      pass.setPipeline(this.pipeline);
      pass.draw(6, n * n * 3);
    }
    if (this.falling.length) {
      const d = this.bladeData;
      this.falling.forEach((f, i) => {
        const shrink = f.landed >= 0 ? Math.max(0, 1 - f.landed / 0.3) : 1;
        d.set([...f.p, f.size, f.turn, f.m, f.tip, f.h, f.w, f.shade, shrink, 0], i * 12);
      });
      this.device.queue.writeBuffer(this.bladeBuffer, 0, d, 0, this.falling.length * 12);
      pass.setPipeline(this.bladePipeline);
      pass.setVertexBuffer(0, this.bladeBuffer);
      pass.draw(6, this.falling.length);
    }
    pass.end();
  }
}
