// Global illumination from a grid of probes, one every PROBE voxels each way, traced through the distance field.
//
// Sky visibility (mode 1): each probe casts rays all round (leaves letting some light through) and stores what share
// of them reached the sky, a, and their mean direction weighted by that, b: the order-1 spherical harmonics of its
// visibility, so how much sky a surface facing n sees is about a + 2 b·n. A probe in solid ground moves up its column to
// the first air voxel (by k voxels, stored as 2k + a), or is marked unusable (-1) when there's none. Rays reach
// GI_TUNING.reach voxels; past that counts as open sky. The whole grid is traced at startup; an edit retraces just the
// probes within reach of the edited box. This grid also says where every probe is for mode 2.
//
// Bounce light (mode 2): the same probes store the light arriving from all round, in colour, the same way (a, b per
// channel, so a surface facing n gets a + 2 b·n): the sky where a ray gets out, and where it meets a block, the light
// leaving that block: its colour (its texture's average) times the sun or moon on it (with a shadow ray), the torches
// near it, and the probes' own light there from the last update (so light bounces on, round corners and into caves).
// Light changes with the time of day and the torches, so it's retraced all the time: a few z layers of the probes round
// the camera's target each frame, and one layer of the whole map, written to a second copy that's then copied back
// over the first (the shading and the next bounce read the first).
// The renderer (render.js, probeLight) blends the 8 probes round each point.

import { SIZE, BRICK, BRICKS, SDF_RANGE, SOLID_MIN, BLOCK, WATER_LEVEL } from './terrain.js';
import { skyWgsl } from './sky.js';

export const PROBE = 4; // voxels between probes
export const PROBES = SIZE.map((n) => Math.ceil(n / PROBE) + 1);
export const MAX_GI_TORCHES = 64;
const SLAB = 8; // probe z layers per dispatch when tracing the whole grid

// Tuning (T > Global illumination). on: the A/B switch (L cycles it): 0 off, 1 sky visibility only, 2 bounce light;
// strength: how much (0 = as without); minimum: the least of the old sky light anything keeps; bias: voxels off the
// surface the probes are read at; rays per probe, reach (voxels), leaves: how much light a leaf voxel lets through
// (these three retrace the sky visibility of the whole map); bounce: how much light blocks give back; bounceRays: rays per
// probe for the bounce light; range: voxels round the camera's target kept up to date; perFrame: probes retraced there
// each frame; torchShadows: 1 = walls block torchlight; editReach: voxels round an edit whose probes' sky visibility is
// retraced (rays reach further, but a block or two that far off hardly changes what a probe sees); editBudget: the most
// probes retraced for edits a frame (the rest wait for the next).
export const GI_TUNING = {
  on: 1, strength: 1, minimum: 0, bias: 0.5, rays: 29, reach: 30, leaves: 0.5,
  bounce: 1.34, bounceRays: 20, range: 64, perFrame: 6000, torchShadows: 1, editReach: 12, editBudget: 3000,
};
const TILE = 4; // probes across a column tile, the unit edits queue retraces in

// Shared by both passes: the voxels, and a ray through the distance field.
const TRACE_WGSL = /* wgsl */ `
@group(0) @binding(0) var voxels: texture_3d<u32>;
@group(0) @binding(1) var sdfTex: texture_3d<f32>;
@group(0) @binding(2) var bricks: texture_3d<u32>;
@group(0) @binding(3) var linearSamp: sampler;

const GI_DIMS = vec3f(${SIZE[0]}, ${SIZE[1]}, ${SIZE[2]});
const GI_BRICKS = vec3i(${BRICKS.join(', ')});
const GI_PROBES = vec3u(${PROBES.join(', ')});
const GI_R = ${SDF_RANGE}.0;
const GI_S = ${PROBE};

fn giBlock(c: vec3i) -> u32 {
  if (c.y < 0) { return ${BLOCK.GROUND}u; }
  if (any(c < vec3i(0)) || any(c >= vec3i(GI_DIMS))) { return 0u; }
  return textureLoad(voxels, c, 0).r;
}

// Where a ray ended: how it ended (0 went its whole length, 1 out of the top, 2 out of a side, 3 out of the bottom,
// 4 met a block), how much light the leaves it went through let by, and the block it met (where it met it, which
// block, the face's normal).
struct Hit { end: u32, light: f32, p: vec3f, block: u32, cell: vec3i, n: vec3f }

fn traceRay(ro: vec3f, rd: vec3f, maxT: f32, leaves: f32) -> Hit {
  var h: Hit;
  h.light = 1.0;
  var t = 0.0;
  for (var i = 0; i < 128; i++) {
    if (t > maxT) { h.end = 0u; return h; }
    let p = ro + rd * t;
    if (p.y > GI_DIMS.y) { h.end = 1u; return h; }
    if (p.y < 0.0) { h.end = 3u; return h; }
    if (p.x < 0.0 || p.z < 0.0 || p.x > GI_DIMS.x || p.z > GI_DIMS.z) { h.end = 2u; return h; }
    let s = textureSampleLevel(sdfTex, linearSamp, p / GI_DIMS, 0.0).r;
    if (s < 0.25) {
      var c = vec3i(floor(p));
      var b = giBlock(c);
      if (b < ${SOLID_MIN}u) { c = vec3i(floor(p + rd * 0.5)); b = giBlock(c); }
      if (b == ${BLOCK.LEAVES}u) {
        h.light *= leaves;
        if (h.light < 0.02) { h.light = 0.0; h.end = 4u; h.p = p; h.block = b; h.cell = c; h.n = -rd; return h; }
        t += 1.0;
        continue;
      }
      if (b >= ${SOLID_MIN}u) {
        // The face it came in through: the way out of the cube that's furthest from its centre.
        let d = p - (vec3f(c) + 0.5);
        let a = abs(d);
        var n = vec3f(0.0, sign(d.y), 0.0);
        if (a.x >= a.y && a.x >= a.z) { n = vec3f(sign(d.x), 0.0, 0.0); }
        else if (a.z > a.y) { n = vec3f(0.0, 0.0, sign(d.z)); }
        h.end = 4u; h.p = p; h.block = b; h.cell = c; h.n = n;
        return h;
      }
      t += 0.25; // (the blurred distance said surface, but no solid voxel is there)
      continue;
    }
    var d = s * 0.9;
    if (s > GI_R * 0.97) {
      let bc = clamp(vec3i(floor(p / ${BRICK}.0)), vec3i(0), GI_BRICKS - 1);
      d += f32(max(i32(textureLoad(bricks, bc, 0).r) - 1, 0)) * ${BRICK}.0;
    }
    t += max(d, 0.25);
  }
  h.end = 0u;
  return h;
}

// Fibonacci sphere: direction i of n spread evenly all round.
fn giDir(i: u32, n: u32) -> vec3f {
  let y = 1.0 - (f32(i) + 0.5) * 2.0 / f32(n);
  let r = sqrt(max(1.0 - y * y, 0.0));
  let phi = f32(i) * 2.39996323;
  return vec3f(r * cos(phi), y, r * sin(phi));
}

// The probe's voxel, and (in .w) how far up its column it moved out of solid ground, or -1 when it's solid all the way.
fn probeOrigin(pi: vec3u) -> vec4i {
  let c = vec3i(pi) * GI_S;
  for (var j = 0; j < GI_S; j++) {
    if (giBlock(c + vec3i(0, j, 0)) < ${SOLID_MIN}u) { return vec4i(c + vec3i(0, j, 0), j); }
  }
  return vec4i(c, -1);
}
`;

export const SKYVIS_WGSL = TRACE_WGSL + /* wgsl */ `
struct Params { origin: vec4u, size: vec4u, cfg: vec4f } // cfg: rays, reach, leaves' transmission, -
@group(0) @binding(4) var probes: texture_storage_3d<rgba16float, write>;
@group(0) @binding(5) var<uniform> P: Params;

@compute @workgroup_size(4, 4, 4)
fn build(@builtin(global_invocation_id) id: vec3u) {
  if (any(id >= P.size.xyz)) { return; }
  traceProbe(P.origin.xyz + id);
}

// The column tiles edits queued (see SkyVisibility.update): x, z of the tile's first probe, the first and last + 1
// probe layer. A workgroup's 4 × 4 columns are one tile; it runs up the layers with y.
@group(0) @binding(6) var<storage, read> tiles: array<vec4u>;
@compute @workgroup_size(4, 4, 4)
fn buildTiles(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) l: vec3u) {
  let t = tiles[wg.x];
  let y = t.z + wg.y * 4u + l.y;
  if (y >= t.w) { return; }
  traceProbe(vec3u(t.x + l.x, y, t.y + l.z));
}

fn traceProbe(pi: vec3u) {
  if (any(pi >= GI_PROBES)) { return; }
  let o = probeOrigin(pi);
  if (o.w < 0) {
    textureStore(probes, pi, vec4f(-1.0, 0.0, 0.0, 0.0));
    return;
  }
  let ro = vec3f(o.xyz) + 0.5;
  let n = u32(P.cfg.x);
  var a = 0.0;
  var b = vec3f(0.0);
  for (var i = 0u; i < n; i++) {
    let rd = giDir(i, n);
    let h = traceRay(ro, rd, P.cfg.y, P.cfg.z);
    // Out of the top sees the sky; a ray that went its whole length, or out of a side, does if it's heading up.
    var v = 0.0;
    if (h.end == 1u) { v = h.light; }
    if (h.end == 0u || h.end == 2u) { v = h.light * smoothstep(-0.1, 0.1, rd.y); }
    a += v;
    b += v * rd;
  }
  textureStore(probes, pi, vec4f(2.0 * f32(o.w) + a / f32(n), b / f32(n)));
}
`;

export const BOUNCE_WGSL = TRACE_WGSL + skyWgsl(1) + /* wgsl */ `
// cfg: rays, reach, leaves' transmission, bounce; light: xyz = towards the sun or moon; torch: rgb = torchlight,
// w = its reach; cfg2: x = torches in use
struct Params { origin: vec4u, size: vec4u, cfg: vec4f, light: vec4f, torch: vec4f, cfg2: vec4f }
@group(0) @binding(4) var visTex: texture_3d<f32>;
@group(0) @binding(5) var lastLight: texture_3d<f32>; // the probes' light so far, 3 texels across per probe (r, g, b)
@group(0) @binding(6) var outLight: texture_storage_3d<rgba16float, write>;
@group(0) @binding(7) var<uniform> P: Params;
@group(0) @binding(8) var albedo: texture_2d_array<f32>;
@group(0) @binding(9) var mipSamp: sampler;
@group(0) @binding(10) var<storage, read> torches: array<vec4f>; // xyz, w = brightness

// A block face's colour: its texture's average (layers as in render.js).
fn blockColour(b: u32, c: vec3i, n: vec3f) -> vec3f {
  var layer = 7; // stone
  if (b == ${BLOCK.GROUND}u) {
    if (c.y <= ${WATER_LEVEL}) { layer = 2; } // sand
    else if (n.y > 0.5) { layer = 0; } // grass
    else { layer = 1; } // dirt
  }
  if (b == ${BLOCK.LOG}u) { layer = select(4, 5, abs(n.y) > 0.5); }
  if (b == ${BLOCK.LEAVES}u) { layer = 6; }
  if (b == ${BLOCK.PLANK}u) { layer = 8; }
  if (b == ${BLOCK.BRICK}u) { layer = 9; }
  if (b == ${BLOCK.CLAY}u) { layer = 1; } // (clay bricks: dirt)
  if (b == ${BLOCK.FARM}u) { layer = select(1, 10, n.y > 0.5); } // (tilled on top, dirt on the sides)
  if (b == ${BLOCK.OBSIDIAN}u) { return vec3f(0.012, 0.008, 0.02); } // (the obsidian wall: near black)
  return textureSampleLevel(albedo, mipSamp, vec2f(0.5), layer, 16.0).rgb;
}

// The probes' light so far arriving at p facing n (the 8 round it, nearness weighted, the unusable ones left out).
fn lastAt(p: vec3f, n: vec3f) -> vec3f {
  let g = (p - 0.5) / f32(GI_S);
  let base = vec3i(floor(g));
  let f = g - floor(g);
  var sum = vec3f(0.0);
  var wsum = 0.0;
  for (var i = 0; i < 8; i++) {
    let o = vec3i(i & 1, (i >> 1) & 1, (i >> 2) & 1);
    let pi = base + o;
    if (any(pi < vec3i(0)) || any(pi >= vec3i(GI_PROBES))) { continue; }
    if (textureLoad(visTex, pi, 0).x < 0.0) { continue; }
    let tri = select(1.0 - f, f, o == vec3i(1));
    let w = tri.x * tri.y * tri.z;
    let q = vec3i(pi.x * 3, pi.y, pi.z);
    let r = textureLoad(lastLight, q, 0);
    let gg = textureLoad(lastLight, q + vec3i(1, 0, 0), 0);
    let bb = textureLoad(lastLight, q + vec3i(2, 0, 0), 0);
    sum += w * max(vec3f(r.x + 2.0 * dot(r.yzw, n), gg.x + 2.0 * dot(gg.yzw, n), bb.x + 2.0 * dot(bb.yzw, n)), vec3f(0.0));
    wsum += w;
  }
  return select(vec3f(0.0), sum / max(wsum, 1e-5), wsum > 1e-5);
}

// The light leaving the block face a ray met (as radiance).
fn faceLight(h: Hit) -> vec3f {
  let p = h.p + h.n * 0.05;
  let L = P.light.xyz;
  var direct = vec3f(0.0);
  let ndl = dot(h.n, L);
  if (ndl > 0.0) {
    let s = traceRay(p + h.n * 0.3, L, 160.0, P.cfg.z);
    if (s.end != 4u && s.end != 3u) { direct = lightIlluminance() * ndl * s.light / PI; }
  }
  var torch = vec3f(0.0);
  for (var i = 0u; i < u32(P.cfg2.x); i++) {
    let m = torches[i];
    let d = m.xyz - p;
    let dist = length(d);
    let x = min(dist / max(P.torch.w, 0.1), 1.0);
    let window = (1.0 - x * x) * (1.0 - x * x);
    torch += P.torch.rgb * m.w * window * max(dot(h.n, d / max(dist, 1e-3)), 0.0) / (1.0 + 0.35 * dist * dist);
  }
  return blockColour(h.block, h.cell, h.n) * (direct + torch + lastAt(p + h.n * 0.5, h.n)) * P.cfg.w;
}

@compute @workgroup_size(4, 4, 4)
fn bounce(@builtin(global_invocation_id) id: vec3u) {
  if (any(id >= P.size.xyz)) { return; }
  let pi = P.origin.xyz + id;
  if (any(pi >= GI_PROBES)) { return; }
  let q = vec3u(pi.x * 3u, pi.y, pi.z);
  let v = textureLoad(visTex, pi, 0);
  if (v.x < 0.0) {
    for (var c = 0u; c < 3u; c++) { textureStore(outLight, q + vec3u(c, 0u, 0u), vec4f(0.0)); }
    return;
  }
  let ro = vec3f(pi) * f32(GI_S) + vec3f(0.5, 0.5 + floor(v.x * 0.5), 0.5);
  let n = u32(P.cfg.x);
  var a = vec3f(0.0);
  var bx = vec3f(0.0);
  var by = vec3f(0.0);
  var bz = vec3f(0.0);
  for (var i = 0u; i < n; i++) {
    let rd = giDir(i, n);
    let h = traceRay(ro, rd, P.cfg.y, P.cfg.z);
    var l = vec3f(0.0);
    let sky = envSky(rd, ENV_MAXMIP - 2.0);
    if (h.end == 1u) { l = sky; }
    if (h.end == 0u || h.end == 2u) { l = mix(groundBounce(), sky, smoothstep(-0.1, 0.1, rd.y)); }
    if (h.end == 4u) { l = faceLight(h); }
    l *= h.light;
    a += l;
    bx += l * rd.x;
    by += l * rd.y;
    bz += l * rd.z;
  }
  let k = 1.0 / f32(n);
  textureStore(outLight, q, vec4f(a.r, bx.r, by.r, bz.r) * k);
  textureStore(outLight, q + vec3u(1u, 0u, 0u), vec4f(a.g, bx.g, by.g, bz.g) * k);
  textureStore(outLight, q + vec3u(2u, 0u, 0u), vec4f(a.b, bx.b, by.b, bz.b) * k);
}
`;

export class SkyVisibility {
  constructor(device, field, albedo, sky) {
    this.device = device;
    this.sky = sky;
    this.profiler = null; // set by main: times the retraces
    const T = GPUTextureUsage;
    const tex3 = (label, size, usage) => device.createTexture({ label, size, format: 'rgba16float', dimension: '3d', usage });
    this.tex = tex3('sky visibility probes', PROBES, T.TEXTURE_BINDING | T.STORAGE_BINDING);
    const lightSize = [PROBES[0] * 3, PROBES[1], PROBES[2]];
    this.light = tex3('probe light', lightSize, T.TEXTURE_BINDING | T.COPY_DST);
    this.lightNext = tex3('probe light (next)', lightSize, T.STORAGE_BINDING | T.COPY_SRC);
    const traceEntries = [
      { binding: 0, resource: field.voxelTex.createView() },
      { binding: 1, resource: field.sdfTex.createView() },
      { binding: 2, resource: field.brickTex.createView() },
      { binding: 3, resource: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
    ];

    this.params = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ label: 'sky visibility', code: SKYVIS_WGSL });
    this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'build' } });
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        ...traceEntries,
        { binding: 4, resource: this.tex.createView() },
        { binding: 5, resource: { buffer: this.params } },
      ],
    });

    const C = GPUShaderStage.COMPUTE;
    const layout = device.createBindGroupLayout({
      label: 'probe light',
      entries: [
        { binding: 0, visibility: C, texture: { viewDimension: '3d', sampleType: 'uint' } },
        { binding: 1, visibility: C, texture: { viewDimension: '3d' } },
        { binding: 2, visibility: C, texture: { viewDimension: '3d', sampleType: 'uint' } },
        { binding: 3, visibility: C, sampler: {} },
        { binding: 4, visibility: C, texture: { viewDimension: '3d' } },
        { binding: 5, visibility: C, texture: { viewDimension: '3d' } },
        { binding: 6, visibility: C, storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '3d' } },
        { binding: 7, visibility: C, buffer: { type: 'uniform' } },
        { binding: 8, visibility: C, texture: { viewDimension: '2d-array' } },
        { binding: 9, visibility: C, sampler: {} },
        { binding: 10, visibility: C, buffer: { type: 'read-only-storage' } },
      ],
    });
    // Two parameter buffers: a frame lights two boxes of probes (round the target, and a layer of the whole map).
    this.bounceParams = [0, 1].map(() => device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    this.torches = device.createBuffer({ label: 'gi torches', size: MAX_GI_TORCHES * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const bounceModule = device.createShaderModule({ label: 'probe light', code: BOUNCE_WGSL });
    this.bouncePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout, sky.layout] }),
      compute: { module: bounceModule, entryPoint: 'bounce' },
    });
    const mipSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    this.bounceGroups = this.bounceParams.map((buffer) => device.createBindGroup({
      layout,
      entries: [
        ...traceEntries,
        { binding: 4, resource: this.tex.createView() },
        { binding: 5, resource: this.light.createView() },
        { binding: 6, resource: this.lightNext.createView() },
        { binding: 7, resource: { buffer } },
        { binding: 8, resource: albedo.createView({ dimension: '2d-array' }) },
        { binding: 9, resource: mipSamp },
        { binding: 10, resource: { buffer: this.torches } },
      ],
    }));
    this.tilePipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'buildTiles' } });
    this.maxTiles = Math.ceil(PROBES[0] / TILE) * Math.ceil(PROBES[2] / TILE);
    this.tileBuffer = device.createBuffer({ label: 'sky visibility tiles', size: this.maxTiles * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.tileGroup = device.createBindGroup({
      layout: this.tilePipeline.getBindGroupLayout(0),
      entries: [
        ...traceEntries,
        { binding: 4, resource: this.tex.createView() },
        { binding: 5, resource: { buffer: this.params } },
        { binding: 6, resource: { buffer: this.tileBuffer } },
      ],
    });
    this.dirty = new Map(); // column tile index -> [first, last + 1) probe layers waiting for a retrace (see update)
    this.built = '';
    this.cursor = 0;    // the next z layer of the probes round the target to light
    this.sweep = 0;     // and of the whole map
    this.fresh = false; // whether the probes round the target have been lit since bounce light was switched on
  }

  config() {
    const T = GI_TUNING;
    return [Math.max(1, Math.round(T.rays)), Math.max(1, T.reach), Math.min(Math.max(T.leaves, 0), 1)];
  }

  // The whole grid's sky visibility (after the distance field is built, and again when the rays, reach or leaves change).
  buildAll() {
    this.built = this.config().join();
    this.dirty.clear();
    for (let z = 0; z < PROBES[2]; z += SLAB) {
      this.trace([0, 0, z], [PROBES[0], PROBES[1], Math.min(PROBES[2], z + SLAB)]);
    }
  }

  // Each frame, before the terrain's drawn: retraces the sky visibility if its tuning changed, and with bounce light
  // on, lights some of the probes. frame: { light (towards the sun or moon), torch (as the renderer's: rgb, reach),
  // flames ([x, y, z, brightness], nearest the target first), target }.
  tick(frame) {
    if (this.config().join() !== this.built) this.buildAll();
    this.retraceEdits();
    if (GI_TUNING.on < 1.5) { this.fresh = false; return; }
    const T = GI_TUNING;
    const flames = frame.flames.slice(0, MAX_GI_TORCHES);
    if (flames.length) this.device.queue.writeBuffer(this.torches, 0, new Float32Array(flames.flat()));
    const extra = { light: frame.light, torch: frame.torch, torches: flames.length };
    const h = Math.ceil(Math.max(T.range, PROBE) / PROBE);
    const cx = Math.round(frame.target[0] / PROBE), cz = Math.round(frame.target[2] / PROBE);
    const x0 = Math.max(0, cx - h), x1 = Math.min(PROBES[0], cx + h + 1);
    const z0 = Math.max(0, cz - h), z1 = Math.min(PROBES[2], cz + h + 1);
    if (!this.fresh) {
      // Everything round the target at once, twice so the light has bounced once already.
      // (A few z layers a submit, so no one dispatch runs long enough for the GPU to give up on it.)
      this.fresh = true;
      for (const slot of [0, 1]) {
        for (let z = z0; z < z1; z += 4) this.bounce(slot, [x0, 0, z], [x1, PROBES[1], Math.min(z1, z + 4)], extra);
      }
      return;
    }
    const depth = z1 - z0;
    const layers = Math.max(1, Math.min(depth, Math.floor(T.perFrame / Math.max(1, (x1 - x0) * PROBES[1]))));
    if (this.cursor >= depth) this.cursor = 0;
    const za = z0 + this.cursor;
    this.cursor += layers;
    this.bounce(0, [x0, 0, za], [x1, PROBES[1], Math.min(z1, za + layers)], extra, 'probe light');
    this.sweep = (this.sweep + 1) % PROBES[2];
    this.bounce(1, [0, 0, this.sweep], [PROBES[0], PROBES[1], this.sweep + 1], extra);
  }

  // Lights the probes [lo, hi) (probe indices), with parameter buffer `slot`.
  bounce(slot, lo, hi, extra, timed) {
    const { device } = this;
    const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    if (size.some((n) => n <= 0)) return;
    const T = GI_TUNING;
    const data = new ArrayBuffer(96);
    new Uint32Array(data, 0, 8).set([...lo, 0, ...size, 0]);
    new Float32Array(data, 32, 16).set([
      Math.max(1, Math.round(T.bounceRays)), Math.max(1, T.reach), Math.min(Math.max(T.leaves, 0), 1), T.bounce,
      ...extra.light.slice(0, 3), 0,
      ...extra.torch,
      extra.torches, 0, 0, 0,
    ]);
    device.queue.writeBuffer(this.bounceParams[slot], 0, data);
    const enc = device.createCommandEncoder({ label: 'probe light' });
    const pass = enc.beginComputePass({ label: 'probe light', timestampWrites: timed ? this.profiler?.tsw(timed) : undefined });
    pass.setPipeline(this.bouncePipeline);
    pass.setBindGroup(0, this.bounceGroups[slot]);
    pass.setBindGroup(1, this.sky.group);
    pass.dispatchWorkgroups(Math.ceil(size[0] / 4), Math.ceil(size[1] / 4), Math.ceil(size[2] / 4));
    pass.end();
    enc.copyTextureToTexture(
      { texture: this.lightNext, origin: [lo[0] * 3, lo[1], lo[2]] },
      { texture: this.light, origin: [lo[0] * 3, lo[1], lo[2]] },
      [size[0] * 3, size[1], size[2]],
    );
    device.queue.submit([enc.finish()]);
  }

  // After an edit that changed voxels in [lo, hi) (once the distance field there is rebuilt): queues the sky visibility
  // of the probes within editReach of it, by column tile, retraced by the next ticks (retraceEdits). Probes above the
  // edit only lose or gain a little of the ground below them, which doesn't count as sky, so only those up to its top
  // are. Edits next to each other, or the same spot dug at again, share the tiles and are traced once. (Their light,
  // in bounce mode, catches up as they're lit again.)
  update(lo, hi) {
    const pad = Math.max(0, GI_TUNING.editReach);
    const t0 = [0, 2].map((i) => Math.max(0, Math.floor((lo[i] - pad) / PROBE / TILE)));
    const t1 = [0, 2].map((i) => Math.min(Math.ceil(PROBES[i] / TILE), Math.floor((hi[i] + pad) / PROBE / TILE) + 1));
    const y0 = Math.max(0, Math.floor((lo[1] - pad) / PROBE)), y1 = Math.min(PROBES[1], Math.ceil(hi[1] / PROBE) + 1);
    const across = Math.ceil(PROBES[0] / TILE);
    for (let tz = t0[1]; tz < t1[1]; tz++) {
      for (let tx = t0[0]; tx < t1[0]; tx++) {
        const k = tx + tz * across, d = this.dirty.get(k);
        this.dirty.set(k, d ? [Math.min(d[0], y0), Math.max(d[1], y1)] : [y0, y1]);
      }
    }
  }

  // Retraces queued tiles, up to editBudget probes, in one dispatch.
  retraceEdits() {
    if (!this.dirty.size) return;
    const across = Math.ceil(PROBES[0] / TILE);
    const list = [];
    let probes = 0, maxLayers = 0;
    for (const [k, [y0, y1]] of this.dirty) {
      if (list.length && probes + TILE * TILE * (y1 - y0) > GI_TUNING.editBudget) break;
      this.dirty.delete(k);
      list.push((k % across) * TILE, Math.floor(k / across) * TILE, y0, y1);
      probes += TILE * TILE * (y1 - y0);
      maxLayers = Math.max(maxLayers, y1 - y0);
    }
    const { device } = this;
    device.queue.writeBuffer(this.tileBuffer, 0, new Uint32Array(list));
    const data = new ArrayBuffer(48);
    new Float32Array(data, 32, 4).set([...this.config(), 0]);
    device.queue.writeBuffer(this.params, 0, data);
    const enc = device.createCommandEncoder({ label: 'sky visibility (edits)' });
    const pass = enc.beginComputePass({ label: 'sky visibility (edits)', timestampWrites: this.profiler?.tsw('sky visibility (edits)') });
    pass.setPipeline(this.tilePipeline);
    pass.setBindGroup(0, this.tileGroup);
    pass.dispatchWorkgroups(list.length / 4, Math.ceil(maxLayers / 4), 1);
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  // Traces the sky visibility of the probes [lo, hi) (probe indices).
  trace(lo, hi, timed) {
    const { device } = this;
    const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    if (size.some((n) => n <= 0)) return;
    const data = new ArrayBuffer(48);
    new Uint32Array(data, 0, 8).set([...lo, 0, ...size, 0]);
    new Float32Array(data, 32, 4).set([...this.config(), 0]);
    device.queue.writeBuffer(this.params, 0, data);
    const enc = device.createCommandEncoder({ label: 'sky visibility' });
    const pass = enc.beginComputePass({ label: 'sky visibility', timestampWrites: timed ? this.profiler?.tsw(timed) : undefined });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(size[0] / 4), Math.ceil(size[1] / 4), Math.ceil(size[2] / 4));
    pass.end();
    device.queue.submit([enc.finish()]);
  }
}
