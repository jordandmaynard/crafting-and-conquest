// The trail a whirling barbarian's axe leaves: a flat ring-shaped ribbon at the blade's height, swept back round from
// where the blade is now, fading out behind it. Blended over the scene (premultiplied), hidden behind the ground.

import { linearColor } from './sky.js';

export const TRAIL_TUNING = {
  arc: 0.35,         // turns of the spin the trail reaches back over
  opacity: 0.5,      // at the blade
  color: '#e6eeff',  // a steel glint
};

const SEGMENTS = 20;     // per trail
const MAX_TRAILS = 64;
const VERTEX_FLOATS = 8; // position, opacity; colour, -

const SHADER = /* wgsl */ `
@group(0) @binding(0) var<uniform> viewProj: mat4x4f;

struct VIn { @location(0) a: vec4f, @location(1) b: vec4f } // a: position, opacity; b: colour
struct VSOut { @builtin(position) pos: vec4f, @location(0) color: vec4f }

@vertex
fn vs(v: VIn) -> VSOut {
  var out: VSOut;
  out.pos = viewProj * vec4f(v.a.xyz, 1.0);
  out.color = vec4f(v.b.rgb, v.a.w);
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  return vec4f(in.color.rgb * in.color.a, in.color.a);
}
`;

export class Trails {
  constructor(device, format, depthFormat) {
    this.device = device;
    this.data = new Float32Array(MAX_TRAILS * SEGMENTS * 6 * VERTEX_FLOATS);
    this.vertices = device.createBuffer({ label: 'axe trails', size: this.data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.uniforms = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ label: 'axe trails', code: SHADER });
    this.pipeline = device.createRenderPipeline({
      label: 'axe trails',
      layout: 'auto',
      vertex: {
        module, entryPoint: 'vs',
        buffers: [{ arrayStride: VERTEX_FLOATS * 4, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x4' },
          { shaderLocation: 1, offset: 16, format: 'float32x4' },
        ] }],
      },
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
      entries: [{ binding: 0, resource: { buffer: this.uniforms } }],
    });
    this.count = 0;
  }

  // sweeps: { centre (the spin's axis at the blade's height), angle (where the blade is now: world yaw, 0 = +z),
  // inner, outer (voxels from the axis), strength (0-1) } (Units.sweeps). light: how lit the scene is (0-1).
  draw(encoder, colorView, depthView, viewProj, sweeps, light = 1) {
    const T = TRAIL_TUNING, d = this.data;
    const col = linearColor(T.color).map((c) => c * light);
    const arc = T.arc * Math.PI * 2;
    let n = 0;
    const vert = (s, r, a, alpha) => {
      d.set([s.centre[0] + Math.sin(a) * r, s.centre[1], s.centre[2] + Math.cos(a) * r, alpha, ...col, 0], n++ * VERTEX_FLOATS);
    };
    for (const s of sweeps.slice(0, MAX_TRAILS)) {
      if (s.strength <= 0 || arc <= 0) continue;
      for (let i = 0; i < SEGMENTS; i++) {
        // From the blade (k = 0) back round (k = 1), fading out.
        const k0 = i / SEGMENTS, k1 = (i + 1) / SEGMENTS;
        const a0 = s.angle - arc * k0, a1 = s.angle - arc * k1;
        const o0 = T.opacity * s.strength * (1 - k0) ** 2, o1 = T.opacity * s.strength * (1 - k1) ** 2;
        vert(s, s.inner, a0, o0); vert(s, s.outer, a0, o0); vert(s, s.outer, a1, o1);
        vert(s, s.inner, a0, o0); vert(s, s.outer, a1, o1); vert(s, s.inner, a1, o1);
      }
    }
    this.count = n;
    if (!n) return;
    this.device.queue.writeBuffer(this.uniforms, 0, new Float32Array(viewProj));
    this.device.queue.writeBuffer(this.vertices, 0, d, 0, n * VERTEX_FLOATS);
    const pass = encoder.beginRenderPass({
      label: 'axe trails',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depthView, depthReadOnly: true },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.setVertexBuffer(0, this.vertices);
    pass.draw(n);
    pass.end();
  }
}
