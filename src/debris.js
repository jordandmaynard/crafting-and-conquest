// Debris: whenever stone or bricks are dug out or blown up, small round pebbles fly off them, bounce, roll down off
// the edges of the voxels they land on and shrink away after a few seconds; wood (logs, planks) throws out chips that
// tumble, land flat and go the same way. Terrain.onLose reports each solid voxel an edit takes away (see terrain.js).
//
// Pebbles are drawn as spheres traced in a camera-facing quad (so they're perfectly round, writing their own depth),
// chips as little boxes; both lit like the ground (the sun shadow at their pixel, toon shading's bands) and, with
// toon shading on, outlined like the villagers (TOON_TUNING.unitOutline, unitColor).

import { skyWgsl, linearColor } from './sky.js';
import { BLOCK, WATER_LEVEL } from './terrain.js';
import { intoWater } from './splash.js';
import { TOON_TUNING } from './render.js';
import { sfx } from './audio.js';

// Tuning (T > Debris).
export const DEBRIS_TUNING = {
  pebbles: 4,        // pebbles per stone or brick voxel lost
  pebbleSize: 0.08,  // voxels, a pebble's radius on average
  chips: 5,          // chips per log or plank voxel lost
  chipSize: 0.18,    // voxels, a chip's length on average
  speed: 4,          // voxels per second they fly off at
  blast: 2,          // times faster off a fireball's blast (outward from it)
  gravity: 20,       // voxels per second²
  bounce: 0.35,      // how much speed a bounce keeps
  roll: 8,           // how hard a pebble on the edge of a drop rolls off it (voxels per second²)
  life: 3,           // seconds before they shrink away (each varies by a third)
};

const MAX_DEBRIS = 4096;
const FLOATS = 16;
// The ground's texture array layers (see textures.js) whose average colours they take.
const LAYER = { [BLOCK.STONE]: 7, [BLOCK.IRON]: 7, [BLOCK.GOLD]: 7, [BLOCK.BRICK]: 9, [BLOCK.LOG]: 5, [BLOCK.PLANK]: 8 };

export const DEBRIS_WGSL = /* wgsl */ `
// eye: w = orthographic; ahead: the camera's forward, w = a pixel's size (voxels, per voxel away in perspective);
// toon: bands (0 = toon shading off), softness, screen size (zw); outline: rgb, width (pixels, 0 = none).
struct View { viewProj: mat4x4f, sun: vec4f, eye: vec4f, ahead: vec4f, toon: vec4f, outline: vec4f }
@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var albedo: texture_2d_array<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var shadowTex: texture_2d<f32>;
${skyWgsl(1)}

// One piece: a: centre (xyz), radius (pebble) or length (chip); b: its turn (a quaternion); c: texture layer, shade,
// scale (shrinking away), -; d: a chip's thickness and width (as fractions of its length).
struct PIn { @location(0) a: vec4f, @location(1) b: vec4f, @location(2) c: vec4f, @location(3) d: vec4f }

fn qrot(q: vec4f, v: vec3f) -> vec3f { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }

fn pixelAt(p: vec3f) -> f32 { return select(V.ahead.w * length(V.eye.xyz - p), V.ahead.w, V.eye.w > 0.5); }

// The sun shadow (half resolution) at p's pixel.
fn shadowAt(p: vec3f) -> f32 {
  let c = V.viewProj * vec4f(p, 1.0);
  let s = vec2f(c.x / c.w * 0.5 + 0.5, 0.5 - c.y / c.w * 0.5) * V.toon.zw;
  let q = clamp(vec2i(s * 0.5), vec2i(0), vec2i(textureDimensions(shadowTex)) - 1);
  return textureLoad(shadowTex, q, 0).r;
}

fn baseColour(c: vec4f) -> vec3f { return textureSampleLevel(albedo, samp, vec2f(0.5), i32(c.x), 16.0).rgb * c.y; }

fn lit(col: vec3f, n: vec3f, shadow: f32) -> vec3f {
  var diffuse = max(dot(n, V.sun.xyz), 0.0) * shadow;
  if (V.toon.x > 0.5) {
    let xb = diffuse * V.toon.x;
    let s = max(V.toon.y, 1e-3);
    diffuse = (floor(xb) + smoothstep(0.5 - s, 0.5 + s, fract(xb))) / V.toon.x;
  }
  return col * (diffuse * lightIlluminance() / PI + ambient(n));
}

struct POut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) @interpolate(flat) centre: vec4f, // xyz, radius
  @location(2) @interpolate(flat) turn: vec4f,
  @location(3) @interpolate(flat) col: vec4f,    // rgb, sun shadow
  @location(4) @interpolate(flat) line: f32,     // the outline's width (voxels)
}

@vertex
fn vsPebble(@builtin(vertex_index) vi: u32, p: PIn) -> POut {
  var o: POut;
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let k = corners[vi];
  let r = p.a.w * p.c.z;
  let line = V.outline.w * pixelAt(p.a.xyz);
  let toEye = select(normalize(V.eye.xyz - p.a.xyz), -V.ahead.xyz, V.eye.w > 0.5);
  var right = cross(vec3f(0.0, 1.0, 0.0), toEye);
  right = select(vec3f(1.0, 0.0, 0.0), normalize(right), dot(right, right) > 1e-8);
  let up = cross(toEye, right);
  // (Wide enough for the sphere's outline seen from close by, in perspective.)
  let half = (r + line) * 1.25;
  o.world = p.a.xyz + (right * k.x + up * k.y) * half + toEye * r;
  o.pos = V.viewProj * vec4f(o.world, 1.0);
  o.centre = vec4f(p.a.xyz, r);
  o.turn = p.b;
  o.col = vec4f(baseColour(p.c), shadowAt(p.a.xyz));
  o.line = line;
  return o;
}

struct FOut { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 }

@fragment
fn fsPebble(in: POut) -> FOut {
  var o: FOut;
  let d = select(normalize(in.world - V.eye.xyz), V.ahead.xyz, V.eye.w > 0.5);
  let org = select(V.eye.xyz, in.world - d * 4.0, V.eye.w > 0.5);
  let oc = org - in.centre.xyz;
  let b = dot(oc, d);
  let miss = sqrt(max(dot(oc, oc) - b * b, 0.0)); // how far the ray passes from the centre
  let r = in.centre.w;
  if (miss > r + in.line) { discard; }
  var t = -b;
  if (miss > r) {
    o.color = vec4f(V.outline.rgb, 1.0);
  } else {
    t = -b - sqrt(r * r - miss * miss);
    let n = (org + d * t - in.centre.xyz) / r;
    // A faint two-tone pattern turning with it, so it's seen to roll.
    let m = qrot(vec4f(-in.turn.xyz, in.turn.w), n);
    let spots = step(0.0, sin(m.x * 4.0) * sin(m.y * 4.0 + 1.0) * sin(m.z * 4.0 + 2.0));
    o.color = vec4f(lit(in.col.rgb * (0.93 + 0.07 * spots), n, in.col.w), 1.0);
  }
  let c = V.viewProj * vec4f(org + d * t, 1.0);
  o.depth = c.z / c.w;
  return o;
}

struct COut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) normal: vec3f,
  @location(1) @interpolate(flat) col: vec4f,  // rgb, sun shadow
  @location(2) @interpolate(flat) hull: f32,   // 1: the outline's shell (drawn only where it faces away)
}

// A chip: 36 vertices of its box, then (with an outline) 36 of a shell the outline's width bigger round it.
@vertex
fn vsChip(@builtin(vertex_index) vi: u32, p: PIn) -> COut {
  var o: COut;
  let hull = vi >= 36u;
  let j = vi % 36u;
  let face = j / 6u;
  let axis = face / 2u;
  let s = select(1.0, -1.0, (face & 1u) == 1u);
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let k = corners[j % 6u];
  var local = vec3f(0.0);
  var n = vec3f(0.0);
  local[axis] = s;
  n[axis] = s;
  local[(axis + 1u) % 3u] = k.x;
  local[(axis + 2u) % 3u] = k.y;
  let len = p.a.w * p.c.z;
  var half = vec3f(0.5, 0.5 * p.d.x, 0.5 * p.d.y) * len;
  let line = V.outline.w * pixelAt(p.a.xyz);
  if (hull) {
    if (line <= 0.0) { o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o; }
    half += vec3f(line);
  }
  let world = p.a.xyz + qrot(p.b, local * half);
  o.pos = V.viewProj * vec4f(world, 1.0);
  o.normal = qrot(p.b, n);
  if (hull) {
    // Facing the eye (seen from the middle of the face): not drawn, so the chip shows through.
    let mid = p.a.xyz + qrot(p.b, n * half);
    let toEye = select(V.eye.xyz - mid, -V.ahead.xyz, V.eye.w > 0.5);
    o.hull = select(1.0, 2.0, dot(o.normal, toEye) > 0.0);
  }
  o.col = vec4f(baseColour(p.c), shadowAt(p.a.xyz));
  return o;
}

@fragment
fn fsChip(in: COut) -> @location(0) vec4f {
  if (in.hull > 1.5) { discard; }
  if (in.hull > 0.5) { return vec4f(V.outline.rgb, 1.0); }
  return vec4f(lit(in.col.rgb, in.normal, in.col.w), 1.0);
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
// Turned by the angle |w| dt about w.
function qspin(q, w, dt) {
  const a = Math.hypot(...w) * dt;
  if (a < 1e-6) return q;
  const s = Math.sin(a / 2) / (a / dt);
  return qnorm(qmul([w[0] * s, w[1] * s, w[2] * s, Math.cos(a / 2)], q));
}
function qrot(q, v) {
  const [x, y, z, w] = q;
  const cx = y * v[2] - z * v[1] + w * v[0], cy = z * v[0] - x * v[2] + w * v[1], cz = x * v[1] - y * v[0] + w * v[2];
  return [v[0] + 2 * (y * cz - z * cy), v[1] + 2 * (z * cx - x * cz), v[2] + 2 * (x * cy - y * cx)];
}
function randomTurn() {
  return qnorm([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]);
}

export class Debris {
  // terrain: the Terrain; albedo: the ground's texture array; sky: the Sky lighting them.
  constructor(device, format, depthFormat, terrain, albedo, sky) {
    this.device = device;
    this.terrain = terrain;
    this.sky = sky;
    this.albedo = albedo;
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    const module = device.createShaderModule({ label: 'debris', code: DEBRIS_WGSL });
    this.layout = device.createBindGroupLayout({
      label: 'debris',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { viewDimension: '2d-array' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout, sky.layout] });
    const buffers = [{ arrayStride: FLOATS * 4, stepMode: 'instance', attributes: [0, 1, 2, 3].map((i) => ({ shaderLocation: i, offset: i * 16, format: 'float32x4' })) }];
    const pipeline = (kind) => device.createRenderPipeline({
      label: `debris ${kind}`,
      layout,
      vertex: { module, entryPoint: `vs${kind}`, buffers },
      fragment: { module, entryPoint: `fs${kind}`, targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.pebblePipeline = pipeline('Pebble');
    this.chipPipeline = pipeline('Chip');
    this.uniforms = device.createBuffer({ size: 36 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.buffer = device.createBuffer({ size: MAX_DEBRIS * FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.data = new Float32Array(MAX_DEBRIS * FLOATS);
    this.pieces = [];
    this.shadowFor = null;
  }

  // Voxel (x, y, z) of `block` was taken away; from: the blast's centre that did it, or null (dug or felled).
  lose(x, y, z, block, from) {
    const D = DEBRIS_TUNING;
    const layer = LAYER[block];
    if (layer === undefined) return;
    const pebble = block === BLOCK.STONE || block === BLOCK.BRICK || block === BLOCK.IRON || block === BLOCK.GOLD;
    const n = Math.round((pebble ? D.pebbles : D.chips) * (0.6 + 0.8 * Math.random()));
    for (let k = 0; k < n && this.pieces.length < MAX_DEBRIS; k++) {
      const p = [x + 0.2 + 0.6 * Math.random(), y + 0.2 + 0.6 * Math.random(), z + 0.2 + 0.6 * Math.random()];
      let v;
      if (from) {
        // Out from the blast, and up.
        const d = p.map((c, i) => c - from[i]);
        const l = Math.hypot(...d) || 1;
        const s = D.speed * D.blast * (0.6 + 0.8 * Math.random());
        v = [d[0] / l * s, d[1] / l * s + D.speed * 0.6, d[2] / l * s];
      } else {
        // Popping up and out (dug, or felled).
        const a = Math.random() * 2 * Math.PI, s = D.speed * (0.2 + 0.5 * Math.random());
        v = [Math.cos(a) * s, D.speed * (0.6 + 0.6 * Math.random()), Math.sin(a) * s];
      }
      const size = (pebble ? D.pebbleSize : D.chipSize) * (0.6 + 0.8 * Math.random());
      this.pieces.push({
        pebble, p, v, size, layer,
        q: randomTurn(),
        w: [0, 1, 2].map(() => (Math.random() - 0.5) * (pebble ? 10 : 30)), // spin (radians per second)
        thin: [0.18 + 0.12 * Math.random(), 0.4 + 0.25 * Math.random()],    // a chip's thickness and width
        shade: 0.8 + 0.35 * Math.random(),
        age: 0,
        life: D.life * (0.67 + 0.67 * Math.random()),
        down: false,
      });
    }
  }

  // Moves them on by dt seconds: falling, bouncing off the voxels, rolling, settling, shrinking away.
  tick(dt) {
    if (!this.pieces.length) return;
    const steps = Math.ceil(dt / (1 / 60));
    for (let s = 0; s < steps; s++) this.step(dt / steps);
    this.pieces = this.pieces.filter((d) => d.age < d.life);
  }

  step(dt) {
    const D = DEBRIS_TUNING, t = this.terrain, F = Math.floor;
    const solid = (x, y, z) => t.solid(F(x), F(y), F(z));
    for (const d of this.pieces) {
      d.age += dt;
      const r = d.pebble ? d.size : d.size * 0.15; // how far it stands off what it hits
      const p = d.p, v = d.v;
      // Built over, or never out of the voxel: up to the top of what's there.
      for (let i = 0; i < 100 && solid(p[0], p[1], p[2]); i++) p[1] = F(p[1]) + 1 + r;
      intoWater(d, p, d.pebble ? d.size * 2 : d.size, v[1]);
      const wet = p[1] < WATER_LEVEL;
      v[1] -= D.gravity * (wet ? 0.3 : 1) * dt;
      if (wet) for (let i = 0; i < 3; i++) v[i] *= Math.exp(-4 * dt);
      // Off the sides, one axis at a time.
      for (const a of [0, 2]) {
        p[a] += v[a] * dt;
        const side = Math.sign(v[a]);
        const q = [...p];
        q[a] += side * r;
        if (side && F(q[a]) !== F(p[a]) && solid(...q)) {
          p[a] = side > 0 ? F(q[a]) - r : F(q[a]) + 1 + r;
          v[a] = -v[a] * D.bounce;
        }
      }
      p[1] += v[1] * dt;
      if (v[1] > 0 && solid(p[0], p[1] + r, p[2])) {
        p[1] = F(p[1] + r) - r;
        v[1] = -v[1] * D.bounce;
      }
      d.down = false;
      const below = F(p[1] - r);
      if (v[1] <= 0 && solid(p[0], p[1] - r, p[2])) {
        p[1] = below + 1 + r;
        if (v[1] < -1.5) sfx(d.pebble ? 'pebble' : 'chip', p, { gain: Math.min(1, -v[1] / 8) }); // (a tick as it lands)
        v[1] = -v[1] * D.bounce;
        if (v[1] < 1) v[1] = 0;
        d.down = true;
      }
      if (d.down) {
        if (d.pebble) {
          // Rolling: slowing a little, and off the edge of a drop it's on.
          const fx = p[0] - F(p[0]), fz = p[2] - F(p[2]);
          const open = (dx, dz) => !t.solid(F(p[0]) + dx, below, F(p[2]) + dz);
          const edge = (f) => Math.max(0, 2 * f - 1); // 0 at the middle of its voxel, 1 at the edge
          v[0] += D.roll * dt * ((open(1, 0) ? edge(fx) : 0) - (open(-1, 0) ? edge(1 - fx) : 0));
          v[2] += D.roll * dt * ((open(0, 1) ? edge(fz) : 0) - (open(0, -1) ? edge(1 - fz) : 0));
          v[0] *= Math.exp(-1.2 * dt);
          v[2] *= Math.exp(-1.2 * dt);
          d.w = [v[2] / r, 0, -v[0] / r];
        } else {
          // Sliding to a stop, and lying down flat.
          v[0] *= Math.exp(-8 * dt);
          v[2] *= Math.exp(-8 * dt);
          d.w = d.w.map((c) => c * Math.exp(-10 * dt));
          const up = qrot(d.q, [0, 1, 0]);
          const target = up[1] >= 0 ? 1 : -1;
          const axis = [-up[2] * target, 0, up[0] * target]; // up × (0, ±1, 0)
          const k = Math.min(1, 10 * dt);
          d.q = qspin(d.q, axis.map((c) => c * k / dt), dt);
        }
      }
      d.q = qspin(d.q, d.w, dt);
    }
  }

  // shadow: the terrain's sun shadow texture (half resolution); cam: { eye, ahead, ortho, pixel, size: [w, h] }.
  draw(encoder, colorView, depthView, shadow, viewProj, sun, cam, profiler) {
    if (!this.pieces.length) return;
    if (this.shadowFor !== shadow) {
      this.shadowFor = shadow;
      this.group = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniforms } },
          { binding: 1, resource: this.albedo.createView({ dimension: '2d-array' }) },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: shadow.createView() },
        ],
      });
    }
    const T = TOON_TUNING, toon = T.on > 0.5;
    const u = new Float32Array(36);
    u.set(viewProj, 0);
    u.set([...sun, 0], 16);
    u.set([...cam.eye, cam.ortho ? 1 : 0], 20);
    u.set([...cam.ahead, cam.pixel], 24);
    u.set([toon ? Math.max(1, Math.round(T.bands)) : 0, T.softness, ...cam.size], 28);
    u.set([...linearColor(T.unitColor), toon ? T.unitOutline : 0], 32);
    this.device.queue.writeBuffer(this.uniforms, 0, u);
    // Pebbles first, then chips.
    const data = this.data, list = this.pieces.filter((d) => d.pebble);
    const pebbles = list.length;
    for (const d of this.pieces) if (!d.pebble) list.push(d);
    list.forEach((d, i) => {
      const shrink = Math.min(1, (d.life - d.age) / 0.4);
      data.set([...d.p, d.size, ...d.q, d.layer, d.shade, Math.max(0, shrink), 0, ...d.thin, 0, 0], i * FLOATS);
    });
    this.device.queue.writeBuffer(this.buffer, 0, data, 0, list.length * FLOATS);
    const pass = encoder.beginRenderPass({
      label: 'debris',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'store' },
      timestampWrites: profiler?.tsw('debris'),
    });
    pass.setBindGroup(0, this.group);
    pass.setBindGroup(1, this.sky.group);
    pass.setVertexBuffer(0, this.buffer);
    if (pebbles) {
      pass.setPipeline(this.pebblePipeline);
      pass.draw(6, pebbles, 0, 0);
    }
    if (list.length > pebbles) {
      pass.setPipeline(this.chipPipeline);
      pass.draw(72, list.length - pebbles, 0, pebbles);
    }
    pass.end();
  }
}
