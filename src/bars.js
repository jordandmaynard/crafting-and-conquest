// Health bars over hurt villagers (after neon-haze's): a thin bar lying in the camera's plane above the head (level and
// full width on screen whichever way the camera turns), dark behind, filled in the villager's team colour as far as its
// hit points go, the part just lost pulsing (swollen, glowing hot) for a moment, then cooling to white as it shrinks. Only on the hurt: a villager at full health has none. Drawn after the post effects so they stay sharp,
// hidden behind the ground (and other villagers) in front of them.

import { linearColor } from './sky.js';
import { TEAMS } from './units.js';
import { mountLift } from './horse.js';
import { CRYSTAL_TUNING } from './crystals.js';

export const HEALTHBAR_TUNING = {
  width: 0.9,        // voxels
  height: 0.15,      // voxels
  above: 0.55,       // voxels above the head
  opacity: 1,
  backColor: '#05060a',
  hotBlue: '#5ad2ff', // the part just lost, right after a hit, per team
  hotRed: '#ff9a3c',
  hotYellow: '#fff07a',
  hotPurple: '#e08cff',
  hotFade: 3,        // how quickly that cools to white (per second), once it starts shrinking
  trail: 11.5,       // how quickly the part just lost catches up (per second), once it starts shrinking
  pulse: 0.35,       // seconds the part just lost pulses, swollen and glowing, before it shrinks
  pulseGlow: 3,      // how bright it glows then (past 1 runs white)
  pulseSwell: 0,     // how much thicker it swells then (× the bar's thickness)
  crystal: 2,        // a power crystal's bar is this many times as long and thick
};

const MAX_BARS = 1024; // segments (three a bar at most)
const FLOATS = 12;     // centre + height, from + to (voxels along the bar), colour + opacity
const HEAD = 2.0;      // a villager's height (voxels, from its feet)
// A power crystal's: its top at the highest of its bob (from the Keep's roof, see crystals.js crystalBase).
const crystalHead = () => CRYSTAL_TUNING.hover + CRYSTAL_TUNING.length + CRYSTAL_TUNING.bob;

const SHADER = /* wgsl */ `
struct Frame { viewProj: mat4x4f, right: vec4f, up: vec4f } // the camera's own right and up
struct Segment { a: vec4f, b: vec4f, c: vec4f } // a: bar centre, w = height; b: x from, to (voxels from the centre); c: rgb, opacity
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> segments: array<Segment>;

struct VSOut { @builtin(position) pos: vec4f, @location(0) color: vec4f }

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  let s = segments[ii];
  // x along the segment (0 at its start, 1 at its end), y across it, in the camera's plane.
  var corners = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let c = corners[vi];
  let world = s.a.xyz + F.right.xyz * mix(s.b.x, s.b.y, c.x) + F.up.xyz * (c.y * s.a.w * 0.5);
  var out: VSOut;
  out.pos = F.viewProj * vec4f(world, 1.0);
  out.color = s.c;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  return vec4f(in.color.rgb * in.color.a, in.color.a);
}
`;

export class HealthBars {
  constructor(device, format, depthFormat) {
    this.device = device;
    this.data = new Float32Array(MAX_BARS * FLOATS);
    this.segments = device.createBuffer({ label: 'health bars', size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.uniforms = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ label: 'health bars', code: SHADER });
    this.pipeline = device.createRenderPipeline({
      label: 'health bars',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module, entryPoint: 'fs',
        targets: [{ format, blend: { // premultiplied "over"
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
        } }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less' },
    });
    this.group = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniforms } }, { binding: 1, resource: { buffer: this.segments } }],
    });
    this.state = new WeakMap(); // per villager: { shown (the trailing part, 0-1), heat (0-1), last (0-1), held (s of pulse left) }
    this.count = 0;
  }

  // Eases each villager's trailing part towards its health, and flares it when it's just been hurt.
  update(units, dt) {
    const T = HEALTHBAR_TUNING;
    for (const u of units) {
      const f = Math.max(0, u.hp / (u.maxHp || 10));
      let s = this.state.get(u);
      if (!s) this.state.set(u, (s = { shown: f, heat: 0, last: f, held: 0 }));
      if (f < s.last - 1e-6) { s.heat = 1; s.held = T.pulse; }
      s.last = f;
      if (s.held > 0) { s.held -= dt; if (f > s.shown) s.shown = f; continue; } // pulsing: held where it was
      s.shown = f > s.shown ? f : s.shown + (f - s.shown) * (1 - Math.exp(-T.trail * dt));
      s.heat *= Math.exp(-T.hotFade * dt);
    }
  }

  // This frame's bars, over what's already in colorView (depthView: the scene's depth, read only).
  draw(encoder, colorView, depthView, viewProj, view, units) {
    const T = HEALTHBAR_TUNING, d = this.data;
    const back = linearColor(T.backColor), hotOf = { blue: linearColor(T.hotBlue), red: linearColor(T.hotRed), yellow: linearColor(T.hotYellow), purple: linearColor(T.hotPurple) };
    let n = 0;
    const seg = (u, y, from, to, color, alpha, thick = T.height) => {
      if (n >= MAX_BARS || to <= from) return;
      const k = u.kind === 'crystal' ? Math.max(0.1, T.crystal) : 1, w = T.width * k, half = w / 2, o = n++ * FLOATS;
      d.set([u.pos[0], y, u.pos[2], thick * k, from * w - half, to * w - half, 0, 0, ...color, alpha], o);
    };
    for (const u of units) {
      if (u.dying) continue;
      const s = this.state.get(u), f = Math.max(0, u.hp / (u.maxHp || 10));
      if (!s || (f >= 1 && s.shown >= 1)) continue; // full health: no bar
      const y = u.pos[1] + (u.kind === 'crystal' ? (u.raise ?? 0) + crystalHead() : u.kind === 'wall' ? (u.wall?.h ?? 3) + 0.3 : HEAD + mountLift(u)) + T.above;
      seg(u, y, 0, 1, back, T.opacity);
      // The part just lost: pulsing (a beat of swelling and glowing) while it's held, then cooling as it shrinks.
      const k = s.held > 0 ? Math.sin(Math.PI * (1 - s.held / Math.max(T.pulse, 1e-3))) : 0;
      const hot = hotOf[u.team] ?? hotOf.red;
      seg(u, y, f, s.shown, hot.map((c) => (1 + (c - 1) * s.heat) * (1 + (T.pulseGlow - 1) * k)), Math.min(1, T.opacity * (0.7 + 0.3 * k)), T.height * (1 + T.pulseSwell * k));
      seg(u, y, 0, f, TEAMS[u.team].toga, T.opacity);
    }
    this.count = n;
    if (!n) return;
    this.device.queue.writeBuffer(this.uniforms, 0, new Float32Array([...viewProj, view[0], view[4], view[8], 0, view[1], view[5], view[9], 0]));
    this.device.queue.writeBuffer(this.segments, 0, d, 0, n * FLOATS);
    const pass = encoder.beginRenderPass({
      label: 'health bars',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depthView, depthReadOnly: true },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.draw(6, n);
    pass.end();
  }
}
