// Farms: the god panel's Farm order (6) marks grass or dirt tops; an idle worker within the job range tills each one
// (with a hoe) into a farm block (BLOCK.FARM: tilled rows on top, textures/tilled.png and its normal map), and wheat
// starts growing there at once. Over FARM_TUNING.growTime seconds it sprouts, shoots up and grows its ears, green
// turning gold; ripe, it waits for an idle worker within the job range to reap it (with a sickle): the yield goes into
// a new game's inventory (wheat, listed over iron and gold) and the farm's sown again, growing from the start.
//
// The farms are one shared open order (FarmJob), like Mine's: its columns are the marks still to till and the ripe
// wheat, checked a few times a second (Farms.update), which adds it back to the open jobs whenever there's work in it.
// Delete clears farms under the brush, tilled ones going back to grass. A farm that's dug out goes; one built over
// stops growing (and isn't drawn) till it's open to the sky again.
//
// The wheat's drawn like the grass tufts (grass.js): cartoon clumps of stalks, each an upright quad turned to the
// camera with its shapes cut out in the fragment shader, outlined, lit like the ground under it. One instance per
// clump, ROWS rows of PER_ROW on each farm, standing on the tilled ridges; how grown each is comes from the farm's
// sowing time and the clock, on the GPU, so only sowing and reaping send anything up. On a farm's open sides (where the
// ground's top edge is bevelled, see render.js bevelCuts) the clumps whose feet would be on the bevel aren't drawn, so
// none stick out over it and the field's no denser there.

import { skyWgsl, linearColor } from './sky.js';
import { SIZE, BLOCK, WATER_LEVEL, isEdge } from './terrain.js';
import { TOON_TUNING, RENDER_TUNING } from './render.js';
import { WHEAT } from './inventory.js';

// Tuning (T > Farming).
export const FARM_TUNING = {
  growTime: 30,       // seconds from sowing to ripe wheat
  yield: 1,           // wheat a ripe farm gives when it's reaped
  tillTime: 1.2,      // seconds a worker takes to till a farm
  reapTime: 0.9,      // and to reap one
  height: 1.33,       // voxels: ripe wheat's height
  width: 1,           // the stalks' and leaves' width
  sway: 1,            // how much it sways in the wind
  youngColor: '#6aa32f',
  ripeColor: '#eecc77',
  outline: 1.3,       // pixels
  youngOutline: '#2b5c10',
  ripeOutline: '#6e4a12',
};

const [X, Y, Z] = SIZE;
const ROWS = 3;      // tilled ridges a voxel (as textures/tilled-normal.png has them, along x; see tools/tilled.mjs)
const PER_ROW = 4;   // clumps of wheat along each
const BEVEL_MARGIN = 0.08; // voxels past a bevel a clump's foot has to be, so its leaves don't hang out over it
const CLUMPS = ROWS * PER_ROW;
const MAX_FARMS = 16384; // drawn
const FARM_REACH = { reach: 2, reachUp: 3, reachDown: 3 };
// Farms need their top above the sand by the water (a cube's top within 1.5 of the water is sand, see render.js).
const MIN_TOP = Math.floor(WATER_LEVEL + 1.5) + 1;

export const FARM_WGSL = /* wgsl */ `
// eye: xyz, orthographic (w); ahead: the view's way, a pixel's size (w); toon: bands, softness, on, -; wheat: height,
// width, sway, grow time; clock: seconds, outline width (pixels), how far in from an open side clumps start (voxels; 0
// none), -; young, ripe: the wheat's colours (linear);
// youngLine, ripeLine: its outline's.
struct View {
  viewProj: mat4x4f, sun: vec4f, eye: vec4f, ahead: vec4f, screen: vec4f, toon: vec4f, wheat: vec4f, clock: vec4f,
  young: vec4f, ripe: vec4f, youngLine: vec4f, ripeLine: vec4f,
}
@group(0) @binding(0) var<uniform> V: View;
// Per farm two: x, top (the height it stands on), z, when it was sown; its open sides (bits: -x, +x, -z, +z), -, -, -.
@group(0) @binding(1) var<storage, read> farms: array<vec4f>;
@group(0) @binding(2) var shadowTex: texture_2d<f32>;
${skyWgsl(1)}

fn hash(a: u32) -> u32 {
  var x = a * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return (x >> 22u) ^ x;
}
fn rand(h: u32, k: u32) -> f32 { return f32(hash(h + k * 0x9e3779b9u) & 0xffffffu) / 16777216.0; }

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,                     // x across (in clump heights), y up (0 at the ground, 1 at the top)
  @location(1) @interpolate(flat) seed: u32,
  @location(2) @interpolate(flat) grow: vec2f,   // x: how grown (0-1, 1 ripe), y: its sway now
  @location(3) @interpolate(flat) px: vec2f,     // x: a pixel in clump heights; y: sun on the ground there (0-1)
}

const HALF = 0.42; // the quad's half width, in clump heights

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let f = farms[ii / ${CLUMPS}u * 2u];
  let open = u32(farms[ii / ${CLUMPS}u * 2u + 1u].x);
  let k = ii % ${CLUMPS}u;
  let row = k / ${PER_ROW}u;
  let col = k % ${PER_ROW}u;
  let h = hash((u32(f.x) * 73856093u) ^ (u32(f.z) * 19349663u) ^ (k * 83492791u));
  let g = clamp((V.clock.x - f.w) / max(V.wheat.w, 0.01), 0.0, 1.0);
  // On its ridge (see textures/tilled.png: ROWS of them across a voxel), spread along it.
  let foot = vec3f(f.x + (f32(col) + 0.5 + (rand(h, 1u) - 0.5) * 0.6) / ${PER_ROW}.0, f.y,
    f.z + (f32(row) + 0.5) / ${ROWS}.0 + (rand(h, 2u) - 0.5) * 0.05);
  // None on an open side's bevel.
  let at = foot.xz - f.xz;
  let band = V.clock.z;
  if (band > 0.0 && (((open & 1u) != 0u && at.x < band) || ((open & 2u) != 0u && at.x > 1.0 - band) ||
      ((open & 4u) != 0u && at.y < band) || ((open & 8u) != 0u && at.y > 1.0 - band))) {
    o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  // Sprouts first, shooting up to full height by most of the way through.
  let size = V.wheat.x * (0.85 + 0.3 * rand(h, 3u)) * (0.16 + 0.84 * smoothstep(0.0, 0.85, g));
  // Upright, square to the way to the eye (or to the view, orthographic).
  let toEye = select(V.eye.xyz - foot, -V.ahead.xyz, V.eye.w > 0.5);
  let level = vec2f(toEye.x, toEye.z);
  let fw = select(vec2f(0.0, 1.0), normalize(level), dot(level, level) > 1e-8);
  let right = vec3f(fw.y, 0.0, -fw.x);
  var corners = array<vec2f, 6>(vec2f(-1.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(-1.0, 0.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let corner = corners[vi];
  let lift = -0.03; // (from a hair under the ground, so they meet it without a seam)
  let up = 1.2;     // (room for the ears' awns over the tallest stalk)
  let world = foot + right * corner.x * HALF * size + vec3f(0.0, lift + corner.y * size * up, 0.0);
  o.pos = V.viewProj * vec4f(world, 1.0);
  o.local = vec2f(corner.x * HALF, corner.y * up + lift / size);
  o.seed = h;
  let sway = sin(V.clock.x * (1.3 + 0.4 * rand(h, 4u)) + 6.2831853 * rand(h, 5u) + f.x * 0.37 + f.z * 0.23) * V.wheat.z * 0.06;
  o.grow = vec2f(g, sway);
  let pixel = select(V.ahead.w * length(V.eye.xyz - foot), V.ahead.w, V.eye.w > 0.5);
  // The sun shadow (half resolution) where the clump stands.
  let c = V.viewProj * vec4f(foot, 1.0);
  let s = vec2f(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5) * V.screen.xy;
  let q = clamp(vec2i(s * 0.5), vec2i(0), vec2i(textureDimensions(shadowTex)) - 1);
  o.px = vec2f(pixel / size, textureLoad(shadowTex, q, 0).r);
  return o;
}

// Signed distance from p to a blade (as grass.js's): from its foot at x = b up to its tip at (t, h), bending out as it
// rises, w0 wide each side at the foot, narrowing to the tip.
fn blade(p: vec2f, b: f32, t: f32, h: f32, w0: f32) -> f32 {
  if (p.y >= h) { return length(p - vec2f(t, h)); }
  let s = max(p.y, 0.0) / h;
  let cx = b + (t - b) * s * s;
  let slope = (t - b) * 2.0 * s / h;
  let hw = w0 * pow(1.0 - s, 0.7);
  return (abs(p.x - cx) - hw) / sqrt(1.0 + slope * slope);
}
// A straight line from a to b, w wide each side.
fn seg(p: vec2f, a: vec2f, b: vec2f, w: f32) -> f32 {
  let d = b - a;
  let k = clamp(dot(p - a, d) / max(dot(d, d), 1e-8), 0.0, 1.0);
  return length(p - a - d * k) - w;
}
// An ear of wheat centred at c, len long and w wide each side, its grains' bumps down its sides.
fn ear(p: vec2f, c: vec2f, len: f32, w: f32) -> f32 {
  let r = (p - c) / vec2f(w, len * 0.5);
  let bumps = 1.0 + 0.18 * abs(sin((p.y - c.y) / max(len, 1e-4) * 18.0));
  return (length(r) - bumps) * min(w, len * 0.5) * 0.8;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let h = in.seed;
  let g = in.grow.x;
  let m = select(-1.0, 1.0, rand(h, 6u) < 0.5); // mirrored or not
  var p = vec2f(in.local.x * m, in.local.y);
  p.x -= in.grow.y * p.y * p.y; // swaying, more at the top
  let w = V.wheat.y;
  let ow = V.clock.y * in.px.x * 0.5; // half the outline's width
  let ripe = smoothstep(0.55, 1.0, g);          // green turning gold
  let earGrow = smoothstep(0.4, 0.8, g);        // the ears coming
  let awns = smoothstep(0.75, 1.0, g);          // and their whiskers
  let young = V.young.rgb;
  let gold = V.ripe.rgb;
  var col = vec3f(0.0);
  var line = false;
  var hit = false;
  // Back to front: two leaves arching out from the foot, then three stalks, each with its ear.
  var leaves = array<vec4f, 2>(
    vec4f(-0.02, -0.26 - 0.08 * rand(h, 7u), 0.42 + 0.12 * rand(h, 8u), 0.07 * w),
    vec4f(0.02, 0.24 + 0.08 * rand(h, 9u), 0.36 + 0.12 * rand(h, 10u), 0.06 * w),
  );
  for (var i = 0; i < 2; i++) {
    let b = leaves[i];
    let d = blade(p, b.x, b.y, b.z, b.w);
    if (d > ow) { continue; }
    hit = true;
    line = d >= -ow && ow > 0.0;
    col = mix(young * 0.9, gold * 0.8, ripe * 0.8) * (0.92 + 0.1 * f32(i));
  }
  var stalks = array<vec3f, 3>(
    vec3f(-0.09, -0.16 - 0.06 * rand(h, 11u), 0.82 + 0.08 * rand(h, 12u)),
    vec3f(0.08, 0.15 + 0.06 * rand(h, 13u), 0.78 + 0.1 * rand(h, 14u)),
    vec3f(0.0, 0.03 * (rand(h, 15u) * 2.0 - 1.0), 0.95 + 0.05 * rand(h, 16u)),
  );
  var shades = array<f32, 3>(0.88, 0.95, 1.05);
  for (var i = 0; i < 3; i++) {
    let s = stalks[i];
    let len = 0.34 * earGrow;
    let ew = 0.042 * w * earGrow;
    // The ear tops the stalk; the stalk stops at its foot.
    let tip = vec2f(s.y, s.z);
    let ec = tip - normalize(vec2f(s.y - s.x, s.z)) * len * 0.5;
    var d = seg(p, vec2f(s.x, 0.0), vec2f(mix(s.x, s.y, 1.0 - len * 0.5 / s.z), s.z - len * 0.5), 0.018 * w);
    var part = 0;
    if (earGrow > 0.0) {
      let e = ear(p, ec, len, ew);
      if (e < d) { d = e; part = 1; }
      // Awns: fine whiskers up from the ear's top, fanning out a little.
      if (awns > 0.0) {
        for (var j = -1; j <= 1; j++) {
          let root = vec2f(ec.x + f32(j) * ew * 0.5, tip.y - len * 0.25);
          let a = seg(p, root, vec2f(ec.x + f32(j) * 0.07 + (s.y - s.x) * 0.15, tip.y + 0.13 * awns), 0.006 * w);
          if (a < d) { d = a; part = 2; }
        }
      }
    }
    if (d > ow) { continue; }
    hit = true;
    line = d >= -ow && ow > 0.0;
    let stem = mix(young, gold * 0.85, ripe);
    let head = mix(young * 1.1, gold * 1.08, ripe);
    col = select(stem, head, part > 0) * shades[i] * (0.94 + 0.12 * rand(h, 17u + u32(i)));
  }
  if (!hit || in.local.y < 0.0) { discard; }
  let outline = mix(V.youngLine.rgb, V.ripeLine.rgb, ripe);
  // Lit like the ground under it, the outline too (so it darkens at night).
  return vec4f(select(col, outline, line) * light(in.px.y), 1.0);
}

// The light on the wheat: the sun (in toon shading's bands), times shadow (0-1), and the sky.
fn light(shadow: f32) -> vec3f {
  var diffuse = max(V.sun.y, 0.0) * shadow;
  if (V.toon.z > 0.5) {
    let nb = max(V.toon.x, 1.0);
    let xb = diffuse * nb;
    let s = max(V.toon.y, 1e-3);
    diffuse = (floor(xb) + smoothstep(0.5 - s, 0.5 + s, fract(xb))) / nb;
  }
  return diffuse * lightIlluminance() / PI + ambient(vec3f(0.0, 1.0, 0.0));
}
`;

export class Farms {
  // terrain: the Terrain; sky: the Sky lighting the wheat.
  constructor(device, format, depthFormat, terrain, sky) {
    this.device = device;
    this.terrain = terrain;
    this.sky = sky;
    this.list = new Map(); // column (x + X * z) -> { x, y (its ground voxel), z, tilled, sown (clock), covered, open }
    this.clock = 0;
    this.wait = 0;
    this.job = new FarmJob(this);
    this.inventory = null; // a new game's (inventory.js): reaped wheat goes into it; sandbox has none
    this.onEdit = null;    // (lo, hi): tilling or clearing a farm changed the voxel box [lo, hi)
    this.dirty = true;     // the wheat to draw has changed
    this.count = 0;        // farms drawn
    const module = device.createShaderModule({ label: 'wheat', code: FARM_WGSL });
    this.layout = device.createBindGroupLayout({
      label: 'wheat',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      label: 'wheat',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout, sky.layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.uniforms = device.createBuffer({ size: 64 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.instances = device.createBuffer({ size: MAX_FARMS * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.data = new Float32Array(MAX_FARMS * 8);
    this.shadowFor = null;
  }

  // Whether the voxel (x, y, z) can be made a farm: grass or dirt (ground above the sand), open to the sky right above
  // (no tree, block or building on it), not the map's edge.
  farmable(x, y, z) {
    const t = this.terrain;
    return !isEdge(x, z) && y + 1 >= MIN_TOP && t.block(x, y, z) === BLOCK.GROUND && t.block(x, y + 1, z) === BLOCK.AIR;
  }

  // The voxel a Farm click on a raycast hit means: the block clicked, if it's farmable and not a farm yet; or null.
  target(hit) {
    const c = hit.point.map((v, i) => Math.floor(v - hit.normal[i] * 0.01));
    return this.farmable(...c) && !this.list.has(c[0] + X * c[2]) ? c : null;
  }

  // The farmable tops in the columns [x0, x1) × [z0, z1) not farms yet, as [[x, y, z]] (a Farm box).
  box(x0, z0, x1, z1) {
    const t = this.terrain, out = [];
    for (let z = Math.max(0, z0); z < Math.min(Z, z1); z++) {
      for (let x = Math.max(0, x0); x < Math.min(X, x1); x++) {
        if (this.list.has(x + X * z)) continue;
        const y = t.heightAt(x, z) - 1;
        if (y >= 0 && this.farmable(x, y, z)) out.push([x, y, z]);
      }
    }
    return out;
  }

  // Marks voxels ([x, y, z], farmable) to be tilled. insta: tilled at once (insta-build).
  mark(cells, insta = false) {
    for (const [x, y, z] of cells) {
      const k = x + X * z;
      if (this.list.has(k) || !this.farmable(x, y, z)) continue;
      this.list.set(k, { x, y, z, tilled: false, sown: this.clock, covered: false, open: 0 });
      this.job.grow(x, z);
      if (insta) this.till(k);
    }
    this.wait = 0; // (its work goes up next update)
  }

  // Clears the farms in columns [x0, x1) × [z0, z1) (Delete, under the brush): tilled ones go back to grass.
  unmark(x0, z0, x1, z1) {
    const t = this.terrain;
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        const k = x + X * z, f = this.list.get(k);
        if (!f) continue;
        this.list.delete(k);
        if (f.tilled && t.block(f.x, f.y, f.z) === BLOCK.FARM) {
          const c = t.setVoxel(f.x, f.y, f.z, BLOCK.GROUND);
          if (c) this.onEdit?.(c.lo, c.hi);
        }
        this.dirty = true;
      }
    }
    this.wait = 0;
  }

  has(x, z) { return this.list.has(x + X * z); }

  // A worker's hoe: the ground's tilled, and wheat's sown in it.
  till(k) {
    const f = this.list.get(k);
    if (!f || f.tilled || !this.farmable(f.x, f.y, f.z)) return;
    const c = this.terrain.setVoxel(f.x, f.y, f.z, BLOCK.FARM);
    f.tilled = true;
    f.sown = this.clock;
    f.open = this.openSides(f);
    this.dirty = true;
    if (c) this.onEdit?.(c.lo, c.hi);
  }

  ripe(f) { return f.tilled && !f.covered && this.clock - f.sown >= FARM_TUNING.growTime; }

  // A worker's sickle: the ripe wheat's reaped into its arms (to take to the Keep or a house, see jobs.js
  // Workers.take; with no worker, straight into the inventory), and the farm sown again.
  reap(k, u = null) {
    const f = this.list.get(k);
    if (!f || !this.ripe(f)) return;
    const n = Math.max(0, Math.round(FARM_TUNING.yield));
    if (this.inventory && u && this.workers) this.workers.take(u, WHEAT, n, [f.x, f.y + 1, f.z]);
    else this.inventory?.add(WHEAT, n);
    f.sown = this.clock;
    this.dirty = true;
  }

  // Per frame: the clock on, and a few times a second each farm checked (dug out: gone; built over: not growing) and
  // the open order's work (marks to till, ripe wheat) handed to the workers.
  update(dt, workers) {
    this.workers = workers;
    this.clock += dt;
    this.wait -= dt;
    if (this.wait > 0) return;
    this.wait = 0.25;
    const t = this.terrain, pending = [];
    for (const [k, f] of this.list) {
      const b = t.block(f.x, f.y, f.z);
      if (f.tilled ? b !== BLOCK.FARM : !this.farmable(f.x, f.y, f.z)) { this.list.delete(k); this.dirty = true; continue; }
      const covered = f.tilled && t.block(f.x, f.y + 1, f.z) !== BLOCK.AIR;
      if (covered !== f.covered) { f.covered = covered; this.dirty = true; }
      if (covered) f.sown = this.clock; // (nothing grows under a block)
      const open = this.openSides(f);
      if (open !== f.open) { f.open = open; this.dirty = true; }
      if (!f.tilled || this.ripe(f)) pending.push(k);
    }
    this.job.pending = pending;
    if (pending.length && !workers.jobs.includes(this.job)) workers.add(this.job);
  }

  // The sides of a farm's voxel with nothing solid beside it (bits: -x, +x, -z, +z): there the ground's top edge is
  // bevelled (see render.js bevelCuts).
  openSides(f) {
    const t = this.terrain;
    return (t.solid(f.x - 1, f.y, f.z) ? 0 : 1) | (t.solid(f.x + 1, f.y, f.z) ? 0 : 2)
      | (t.solid(f.x, f.y, f.z - 1) ? 0 : 4) | (t.solid(f.x, f.y, f.z + 1) ? 0 : 8);
  }

  // Ghost markers (see the unit renderer's vsGhost) for the farms still to till: [x, y, z, 8].
  ghosts(out = []) {
    for (const f of this.list.values()) if (!f.tilled) out.push([f.x, f.y, f.z, 8]);
    return out;
  }

  // shadow: the terrain's sun shadow texture (half resolution); cam: { eye, ahead, ortho, pixel, size: [w, h] }.
  draw(encoder, colorView, depthView, shadow, viewProj, sun, cam, profiler) {
    const F = FARM_TUNING;
    if (this.dirty) {
      this.dirty = false;
      let n = 0;
      for (const f of this.list.values()) {
        if (!f.tilled || f.covered || n >= MAX_FARMS) continue;
        this.data.set([f.x, f.y + 1, f.z, f.sown, f.open, 0, 0, 0], n * 8);
        n++;
      }
      this.count = n;
      if (n) this.device.queue.writeBuffer(this.instances, 0, this.data, 0, n * 8);
    }
    if (!this.count || F.height <= 0) return;
    if (this.shadowFor !== shadow) {
      this.shadowFor = shadow;
      this.group = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniforms } },
          { binding: 1, resource: { buffer: this.instances } },
          { binding: 2, resource: shadow.createView() },
        ],
      });
    }
    const T = TOON_TUNING;
    const u = new Float32Array(64);
    u.set(viewProj, 0);
    u.set([...sun, 0], 16);
    u.set([...cam.eye, cam.ortho ? 1 : 0], 20);
    u.set([...cam.ahead, cam.pixel], 24);
    u.set([...cam.size, 0, 0], 28);
    u.set([Math.max(1, Math.round(T.bands)), T.softness, T.on > 0.5 ? 1 : 0, 0], 32);
    u.set([F.height, F.width, F.sway, Math.max(0.01, F.growTime)], 36);
    const bevel = Math.max(RENDER_TUNING.bevel, RENDER_TUNING.cornerBevel);
    u.set([this.clock, F.outline, bevel > 0 ? bevel + BEVEL_MARGIN : 0, 0], 40);
    u.set([...linearColor(F.youngColor), 0], 44);
    u.set([...linearColor(F.ripeColor), 0], 48);
    u.set([...linearColor(F.youngOutline), 0], 52);
    u.set([...linearColor(F.ripeOutline), 0], 56);
    this.device.queue.writeBuffer(this.uniforms, 0, u);
    const pass = encoder.beginRenderPass({
      label: 'wheat',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'store' },
      timestampWrites: profiler?.tsw('wheat'),
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.setBindGroup(1, this.sky.group);
    pass.draw(6, this.count * CLUMPS);
    pass.end();
  }
}

// The farms as one open order, shared like Mine's: its columns are those with a mark to till or ripe wheat (Farms.update
// sets them); an idle worker within the job range takes the nearest. Tilling and reaping aren't blocks placed, so
// they're done by the task's onPlace, with the task's own time and tool.
export class FarmJob {
  constructor(farms) {
    this.farms = farms;
    this.pending = [];
    this.claimed = new Map();
    this.skipUntil = new Map();
    this.x0 = X; this.z0 = Z; this.x1 = 0; this.z1 = 0; // bounds of every farm ever marked
  }

  get done() { return this.pending.length === 0; }

  grow(x, z) {
    this.x0 = Math.min(this.x0, x); this.x1 = Math.max(this.x1, x + 1);
    this.z0 = Math.min(this.z0, z); this.z1 = Math.max(this.z1, z + 1);
  }

  contains(x, z) { return this.farms.has(x, z); }

  task(x, z) {
    const farms = this.farms, k = x + X * z, f = farms.list.get(k), F = FARM_TUNING;
    if (!f) return null;
    if (!f.tilled) {
      if (!farms.farmable(f.x, f.y, f.z)) return null;
      return { x, y: f.y, z, dig: false, top: f.y, ...FARM_REACH, time: F.tillTime, tool: 'hoe', onPlace: () => farms.till(k) };
    }
    if (!farms.ripe(f)) return null;
    return { x, y: f.y + 1, z, dig: false, top: f.y, ...FARM_REACH, time: F.reapTime, tool: 'sickle', onPlace: (u) => farms.reap(k, u) };
  }

  marks() { return []; }
}
