// The power crystals' beams of light: a god ray from the bottom of each crystal's plinth up into the sky, a
// translucent column (a cone, widening a little as it goes up) that's brightest along its edges, as space-miner's
// shield is (a fresnel edge glow), with a faint body between them, and fading out as it goes up. Bright streaks run
// up it. Added over the scene after the water and fog of war (hidden behind what's in front of it, never hiding
// anything itself), lit by nothing: it's light.

const SIDES = 24;        // round each beam
const ROWS = 24;         // up each (closer together low down, where it changes most)
const MAX_BEAMS = 16;
const BEAM_FLOATS = 8;   // base xyz, -; colour rgb, -

const SHADER = /* wgsl */ `
// viewProj; eye: xyz, w = 1 orthographic; ahead: the way the camera looks (orthographic); shape: x = radius at the
// bottom, y = widens (voxels per voxel up), z = height, w = fades over (voxels: 1/e that far up); look: x = edge
// glow, y = edge power (higher = thinner), z = body, w = brightness; flow: x = streaks, y = their speed (voxels a
// second), z = time (s).
struct View { viewProj: mat4x4f, eye: vec4f, ahead: vec4f, shape: vec4f, look: vec4f, flow: vec4f }
@group(0) @binding(0) var<uniform> V: View;

struct Beam { base: vec4f, col: vec4f }
@group(0) @binding(1) var<storage, read> beams: array<Beam>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) @interpolate(flat) beam: u32,
}

fn radiusAt(h: f32) -> f32 { return V.shape.x + V.shape.y * h; }

// A mesh round the beam (a little outside the true cone, so it covers it): SIDES × ROWS quads.
@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let corner = array<vec2u, 6>(vec2u(0, 0), vec2u(1, 0), vec2u(1, 1), vec2u(0, 0), vec2u(1, 1), vec2u(0, 1))[vi % 6u];
  let quad = vi / 6u;
  let side = quad % ${SIDES}u + corner.x;
  let row = quad / ${SIDES}u + corner.y;
  let k = f32(row) / f32(${ROWS});
  let h = k * k * V.shape.z;
  let a = f32(side) / f32(${SIDES}) * 6.28318530718;
  let r = radiusAt(h) / cos(3.14159265 / f32(${SIDES}));
  let b = beams[ii].base.xyz;
  let world = b + vec3f(cos(a) * r, h, sin(a) * r);
  var out: VOut;
  out.pos = V.viewProj * vec4f(world, 1.0);
  out.world = world;
  out.beam = ii;
  return out;
}

fn hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1, 0)), u.x), mix(hash(i + vec2f(0, 1)), hash(i + vec2f(1, 1)), u.x), u.y);
}

@fragment
fn fs(in: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let beam = beams[in.beam];
  let b = beam.base.xyz;
  let h = in.world.y - b.y;
  let r = max(radiusAt(h), 1e-3);
  let q = in.world.xz - b.xz;
  // Its far side shows only from inside it (else the near side's glow already counts the whole way through).
  let inside = length(V.eye.xz - b.xz) < radiusAt(V.eye.y - b.y);
  if (front == inside) { discard; }
  var rd = normalize(in.world - V.eye.xyz);
  if (V.eye.w > 0.5) { rd = V.ahead.xyz; }
  // How far across the beam the ray passes, seen from above (0 through its middle, 1 at its edge): the edge glow
  // and the depth of light the ray goes through (the body).
  let across = length(rd.xz);
  var s = length(q) / r;
  if (across > 1e-3) { s = abs(q.x * rd.z - q.y * rd.x) / (across * r); }
  s = clamp(s, 0.0, 1.0);
  let depth = sqrt(1.0 - s * s);
  let rim = pow(1.0 - depth, max(V.look.y, 0.1));
  // Streaks running up it: noise round it (by angle) and up it, moving up.
  let ang = atan2(q.y, q.x) / 6.28318530718 * 12.0;
  let streak = noise(vec2f(ang, (h - V.flow.z * V.flow.y) * 0.08)) * 0.65 + noise(vec2f(ang * 2.3 + 7.0, (h - V.flow.z * V.flow.y * 1.6) * 0.21)) * 0.35;
  let flow = mix(1.0, smoothstep(0.2, 0.8, streak) * 2.0, V.flow.x);
  // Fading up from the bottom (to nothing at its top), and in over its first half voxel.
  let fade = exp(-h / max(V.shape.w, 0.01)) * (1.0 - smoothstep(0.8, 1.0, h / max(V.shape.z, 0.01))) * smoothstep(0.0, 0.5, h);
  let glow = (V.look.x * rim + V.look.z * depth * flow) * fade * V.look.w;
  return vec4f(beam.col.rgb * glow, 0.0);
}
`;

export const BEAMS_WGSL = SHADER;

export class Beams {
  constructor(device, format, depthFormat) {
    this.device = device;
    this.data = new Float32Array(MAX_BEAMS * BEAM_FLOATS);
    this.beams = device.createBuffer({ label: 'crystal beams', size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.uniforms = device.createBuffer({ label: 'crystal beams', size: 64 + 16 * 5, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ label: 'crystal beams', code: SHADER });
    const layout = device.createBindGroupLayout({
      label: 'crystal beams',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      label: 'crystal beams',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module, entryPoint: 'fs',
        targets: [{ format, blend: { // added (light)
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
        } }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less' },
    });
    this.group = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: this.uniforms } }, { binding: 1, resource: { buffer: this.beams } }],
    });
  }

  // beams: [{ base: [x, y, z] (the middle of its bottom), col: [r, g, b] (linear, its brightness included) }].
  // view: { eye, ahead, ortho }. T: CRYSTAL_TUNING (its beam* keys). time: seconds.
  draw(encoder, colorView, depthView, viewProj, beams, view, T, time) {
    const n = Math.min(beams.length, MAX_BEAMS);
    if (!n || T.beam <= 0) return;
    const d = this.data;
    for (let i = 0; i < n; i++) d.set([...beams[i].base, 0, ...beams[i].col, 0], i * BEAM_FLOATS);
    const height = Math.max(1, T.beamHeight);
    this.device.queue.writeBuffer(this.uniforms, 0, new Float32Array([
      ...viewProj,
      ...view.eye, view.ortho ? 1 : 0,
      ...view.ahead, 0,
      T.beamWidth / 2, T.beamSpread, height, T.beamFade,
      T.beamEdge, T.beamEdgePower, T.beamBody, T.beam,
      T.beamStreaks, T.beamFlow, time % 3600, 0,
    ]));
    this.device.queue.writeBuffer(this.beams, 0, d, 0, n * BEAM_FLOATS);
    const pass = encoder.beginRenderPass({
      label: 'crystal beams',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depthView, depthReadOnly: true },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.draw(SIDES * ROWS * 6, n);
    pass.end();
  }
}
