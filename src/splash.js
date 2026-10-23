// Splashes: flat squares facing the camera, each one colour, unlike the fireballs' soft puffs (Jordan). They fly,
// fall and change size over their life (up quickly, then down to nothing). Water's, wherever anything falls into the
// sea (a ragdoll, a head, a dropped helmet, a pebble, a log, a tree, an arrow); snow's, kicked up at the feet of what
// walks on snowy ground; blood's, when a villager's hurt (more for an arrow or a spear in it, and from the neck when
// its head comes off), which the options can turn off.
//
// Anything can ask for a splash through splashWater / splashBlood (no import of this module's GPU side needed): main
// sets the Splashes that takes them.

import { WATER_LEVEL } from './terrain.js';
import { linearColor } from './sky.js';

export const SPLASH_TUNING = {
  grow: 0.15,        // share of a square's life it takes to reach its full size (then it shrinks to nothing)
  gravity: 22,       // voxels per second²
  drag: 1.2,         // how fast they slow in the air (per second)
  water: 16,         // squares a splash of something a voxel across makes (bigger and faster: more)
  waterSize: 0.1,    // half a square's width (voxels)
  waterSpeed: 5,     // voxels per second up (and a little less out) a splash throws them
  waterLife: 0.8,    // seconds
  waterColor: '#a8dbe6',
  snow: 5,           // squares a footstep in the snow kicks up (a hoof: half again)
  snowSize: 0.06,
  snowSpeed: 1.8,
  snowLife: 0.45,
  snowColor: '#f4f8ff',
  blood: 1,          // blood (1) or none (0): Options > Blood
  bloodCount: 10,    // squares a blow makes (an arrow or spear: half again, mostly out the way it went)
  bloodSize: 0.07,
  bloodSpeed: 3.5,
  bloodLife: 0.7,
  bloodColor: '#86100d',
  neck: 1.2,         // seconds blood spurts from the neck once the head's come off
  neckRate: 40,      // squares a second it starts at (falling off to none)
};

const MAX = 4096;
const FLOATS = 8;

const WGSL = /* wgsl */ `
struct View { viewProj: mat4x4f, right: vec4f, up: vec4f }
@group(0) @binding(0) var<uniform> V: View;
struct PIn { @location(0) a: vec4f, @location(1) b: vec4f } // a: xyz centre, w half size; b: rgb colour
struct VOut { @builtin(position) pos: vec4f, @location(0) color: vec3f }
@vertex
fn vs(@builtin(vertex_index) vi: u32, p: PIn) -> VOut {
  let corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  let k = corners[vi];
  var out: VOut;
  out.pos = V.viewProj * vec4f(p.a.xyz + (V.right.xyz * k.x + V.up.xyz * k.y) * p.a.w, 1.0);
  out.color = p.b.rgb;
  return out;
}
@fragment
fn fs(in: VOut) -> @location(0) vec4f { return vec4f(in.color, 1.0); }
`;

let sink = null;
// A splash where something of `size` (voxels across) going `speed` (voxels per second) meets the water at pos.
export function splashWater(pos, size = 0.5, speed = 4) { sink?.water(pos, size, speed); }
// Blood from pos, thrown along dir ([x, y, z], or null: all round), `amount` times the usual.
export function splashBlood(pos, dir = null, amount = 1) { sink?.blood(pos, dir, amount); }
// Something (with a wet flag of its own) at pos this step: when it's just gone under, its splash.
export function intoWater(body, pos, size, vy) {
  const wet = pos[1] < WATER_LEVEL;
  if (wet && body.wet === false) splashWater([pos[0], WATER_LEVEL, pos[2]], size, Math.abs(vy));
  body.wet = wet;
}

export class Splashes {
  // hidden(x, z): the fog of war hides it (no splash there).
  constructor(device, format, depthFormat, terrain, hidden = () => false) {
    this.device = device;
    this.terrain = terrain;
    this.hidden = hidden;
    this.list = []; // { p, v, size, age, life, col, wet: dies in the water, solid: dies on the ground }
    this.data = new Float32Array(MAX * FLOATS);
    this.buffer = device.createBuffer({ size: this.data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.uniforms = device.createBuffer({ size: 24 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ label: 'splashes', code: WGSL });
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }] });
    this.pipeline = device.createRenderPipeline({
      label: 'splashes',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: {
        module, entryPoint: 'vs',
        buffers: [{ arrayStride: FLOATS * 4, stepMode: 'instance', attributes: [0, 1].map((i) => ({ shaderLocation: i, offset: i * 16, format: 'float32x4' })) }],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less' },
    });
    this.group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.uniforms } }] });
    sink = this;
  }

  add(p, v, size, life, hex, how) {
    if (this.list.length >= MAX) return;
    const c = linearColor(hex), k = Math.random() * 0.25; // (a little lighter or darker each)
    this.list.push({ p, v, size, age: 0, life, col: c.map((x) => x * (0.9 + k)), ...how });
  }

  water(pos, size, speed) {
    const T = SPLASH_TUNING;
    if (this.hidden(pos[0], pos[2])) return;
    const r = Math.max(0.15, size / 2), strength = Math.min(2.5, 0.4 + speed / 8);
    const n = Math.round(T.water * Math.min(3, Math.max(0.3, size)) * strength);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, out = Math.random();
      const up = T.waterSpeed * strength * (0.5 + 0.7 * Math.random()), side = T.waterSpeed * 0.45 * strength * (0.3 + out);
      this.add([pos[0] + Math.cos(a) * r * out, WATER_LEVEL + 0.05, pos[2] + Math.sin(a) * r * out],
        [Math.cos(a) * side, up, Math.sin(a) * side], T.waterSize * (0.6 + 0.8 * Math.random()) * Math.min(1.6, 0.7 + size * 0.4),
        T.waterLife * (0.6 + 0.6 * Math.random()), T.waterColor, { wet: true });
    }
  }

  // A footstep at the feet (pos), going `heading` (radians, the way +z turns: as units' yaw); big: a hoof.
  snow(pos, heading, big = false) {
    const T = SPLASH_TUNING;
    if (this.hidden(pos[0], pos[2])) return;
    const n = Math.round(T.snow * (big ? 1.5 : 1) * (0.7 + 0.6 * Math.random()));
    const fx = Math.sin(heading), fz = Math.cos(heading);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = T.snowSpeed * (0.4 + 0.6 * Math.random());
      // (Kicked back and up, scattering a little.)
      this.add([pos[0] + (Math.random() - 0.5) * 0.3, pos[1] + 0.05, pos[2] + (Math.random() - 0.5) * 0.3],
        [-fx * s * 0.6 + Math.cos(a) * s * 0.4, s, -fz * s * 0.6 + Math.sin(a) * s * 0.4],
        T.snowSize * (0.6 + 0.8 * Math.random()), T.snowLife * (0.6 + 0.6 * Math.random()), T.snowColor, { solid: true, fall: 0.5 });
    }
  }

  blood(pos, dir, amount) {
    const T = SPLASH_TUNING;
    if (T.blood < 0.5 || this.hidden(pos[0], pos[2])) return;
    let n = T.bloodCount * amount;
    for (; n > 0; n--) {
      if (n < 1 && Math.random() > n) break;
      const a = Math.random() * Math.PI * 2, z = Math.random() * 2 - 1, r = Math.sqrt(1 - z * z);
      const round = [Math.cos(a) * r, Math.abs(z) * 0.6 + 0.3, Math.sin(a) * r], s = T.bloodSpeed * (0.4 + 0.8 * Math.random());
      const d = dir ? round.map((c, i) => dir[i] * 1.4 + c * 0.6) : round;
      this.add([...pos], d.map((c) => c * s), T.bloodSize * (0.6 + 0.8 * Math.random()), T.bloodLife * (0.6 + 0.6 * Math.random()), T.bloodColor, { solid: true, wet: true });
    }
  }

  update(dt) {
    if (!(dt > 0)) return;
    const T = SPLASH_TUNING, drag = Math.exp(-T.drag * dt), t = this.terrain, F = Math.floor;
    for (const s of this.list) {
      s.age += dt;
      s.v[1] -= T.gravity * (s.fall ?? 1) * dt;
      for (let i = 0; i < 3; i++) { s.v[i] *= drag; s.p[i] += s.v[i] * dt; }
      if (s.v[1] < 0 && ((s.wet && s.p[1] < WATER_LEVEL) || (s.solid && t.solid(F(s.p[0]), F(s.p[1]), F(s.p[2]))))) s.age = s.life;
    }
    this.list = this.list.filter((s) => s.age < s.life);
  }

  // light: [r, g, b] the day's (dim at night); view: the camera's view matrix (its right and up rows).
  draw(encoder, colorView, depthView, viewProj, view, light) {
    const T = SPLASH_TUNING;
    let n = 0;
    for (const s of this.list) {
      const f = s.age / s.life, g = Math.max(0.01, T.grow);
      const k = f < g ? f / g : 1 - (f - g) / Math.max(1e-3, 1 - g);
      this.data.set([...s.p, s.size * k, s.col[0] * light[0], s.col[1] * light[1], s.col[2] * light[2], 0], n++ * FLOATS);
    }
    if (!n) return;
    this.device.queue.writeBuffer(this.buffer, 0, this.data, 0, n * FLOATS);
    const u = new Float32Array(24);
    u.set(viewProj, 0);
    u.set([view[0], view[4], view[8], 0], 16); // (the view matrix's rows: the camera's right and up in the world)
    u.set([view[1], view[5], view[9], 0], 20);
    this.device.queue.writeBuffer(this.uniforms, 0, u);
    const pass = encoder.beginRenderPass({
      label: 'splashes',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depthView, depthReadOnly: true },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.setVertexBuffer(0, this.buffer);
    pass.draw(6, n);
    pass.end();
  }
}
