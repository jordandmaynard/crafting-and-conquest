// Distance haze for everything drawn after the terrain: units, grass tufts, ore chunks, falling trees, debris, wheat
// and the crystals' gems. The terrain fogs itself as it's shaded (render.js fsShade), but those passes don't, so far
// off they stood out dark against the hazy hills (Jordan). This screen pass reads the depth buffer and, where something
// stands in front of the terrain's own hit (or against the sky), fades it to the fog's colour by the same rule: by
// distance past the orbit target's depth (fogStart), at the sky's fog density.

import { skyWgsl } from './sky.js';
import { SIZE } from './terrain.js';

const WGSL = /* wgsl */ `
// misc: x = fog start (voxels), y = orthographic.
struct HazeView { invViewProj: mat4x4f, misc: vec4f }
@group(0) @binding(0) var<uniform> H: HazeView;
@group(0) @binding(1) var gbuf: texture_2d<f32>;
@group(0) @binding(2) var depthTex: texture_depth_2d;
${skyWgsl(1)}

const DIMS = vec3f(${SIZE[0]}.0, ${SIZE[1]}.0, ${SIZE[2]}.0);

struct VOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f }
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0))[vi];
  var o: VOut;
  o.pos = vec4f(p, 0.0, 1.0);
  o.ndc = p;
  return o;
}

fn unproject(ndc: vec2f, z: f32) -> vec3f {
  let w = H.invViewProj * vec4f(ndc, z, 1.0);
  return w.xyz / w.w;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let px = vec2i(in.pos.xy);
  let d = textureLoad(depthTex, px, 0);
  if (d >= 1.0) { discard; } // (the sky)
  let ro = unproject(in.ndc, 0.0);
  let rd = normalize(unproject(in.ndc, 1.0) - ro);
  let t = dot(unproject(in.ndc, d) - ro, rd);
  let g = textureLoad(gbuf, px, 0).x;
  // (The terrain itself, fogged already. Its depth was stored from g, so allow for what the depth buffer can hold that
  // far out: a few steps of it, which is a lot more than a voxel when the near plane's close, as possessing.)
  let step = dot(unproject(in.ndc, min(d + 5e-7, 1.0)) - ro, rd) - t;
  if (g >= 0.0 && t > g - max(0.02 * max(1.0, g * 0.01), step)) { discard; }
  // As the terrain counts it: from the eye, or (orthographic) from where the ray enters the map.
  var tc = t;
  if (H.misc.y > 0.5) {
    let inv = 1.0 / rd;
    let a = (vec3f(0.0) - ro) * inv;
    let b = (DIMS - ro) * inv;
    let lo = min(a, b);
    tc = t - max(max(lo.x, lo.y), max(lo.z, 0.0));
  }
  let k = 1.0 - exp(-max(tc - H.misc.x, 0.0) * fogDensity());
  if (k <= 0.0) { discard; }
  var f = fogColor(rd) * 0.95;
  f = f / (1.0 + f * 0.12); // (tone mapped, like what it's over)
  return vec4f(f * k, k);
}
`;

export class Haze {
  constructor(device, format, sky) {
    this.device = device;
    this.sky = sky;
    this.uniforms = device.createBuffer({ size: 20 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const F = GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      label: 'haze',
      entries: [
        { binding: 0, visibility: F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, texture: { sampleType: 'unfilterable-float' } },
        { binding: 2, visibility: F, texture: { sampleType: 'depth' } },
      ],
    });
    const module = device.createShaderModule({ label: 'haze', code: WGSL });
    this.pipeline = device.createRenderPipeline({
      label: 'haze',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout, sky.layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module, entryPoint: 'fs',
        targets: [{ format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.group = null;
    this.for = null;
  }

  // gbuf: the terrain's G-buffer (its hit distances); depth: the depth texture everything's drawn with.
  draw(encoder, colorView, gbuf, depth, invViewProj, ortho, fogStart) {
    if (this.for?.gbuf !== gbuf || this.for?.depth !== depth) {
      this.for = { gbuf, depth };
      this.group = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniforms } },
          { binding: 1, resource: gbuf.createView() },
          { binding: 2, resource: depth.createView() },
        ],
      });
    }
    const u = new Float32Array(20);
    u.set(invViewProj, 0);
    u.set([fogStart, ortho ? 1 : 0, 0, 0], 16);
    this.device.queue.writeBuffer(this.uniforms, 0, u);
    const pass = encoder.beginRenderPass({ label: 'haze', colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }] });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.setBindGroup(1, this.sky.group);
    pass.draw(3);
    pass.end();
  }
}
