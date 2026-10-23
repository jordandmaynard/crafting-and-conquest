// The power crystals drawn as gems: translucent and in their team's colour. On each facet, the sky reflected (more at
// a glancing angle, as glass does) with the sun glinting; through it, light bent in at the facet, bouncing round the
// facets inside (each one it meets either lets it out, bent again, or turns it back in) and tinted the deeper it goes,
// with the crystal's own glow from within. What's behind shows through, tinted in its colour. Round its outline a rim
// light that can get overbright. Drawn after the units (it writes depth), each crystal on its own (its colour tints
// what's behind it, as the blend's constant). Its selection outline is still the unit renderer's (see crystalParts).

import { skyWgsl } from './sky.js';
import { SHAPES } from './units-render.js';
import { CRYSTAL_TUNING } from './crystals.js';

const MAX_GEMS = 16;
const GEM_FLOATS = 12; // centre xyz, yaw; width, length, waist (share up from its lower tip), flash; colour rgb, -

const SHADER = /* wgsl */ `
// eye: xyz, w = 1 orthographic; ahead: the way the camera looks; sun: the sun's (or moon's) direction; look: x = index
// of refraction, y = absorption (a voxel), z = reflections, w = sun glints; glow: x = glow from within, y = rim light,
// z = rim power (higher = thinner), w = how much shows through.
struct View { viewProj: mat4x4f, eye: vec4f, ahead: vec4f, sun: vec4f, look: vec4f, glow: vec4f }
@group(0) @binding(0) var<uniform> V: View;
struct Gem { pose: vec4f, size: vec4f, col: vec4f }
@group(0) @binding(1) var<storage, read> gems: array<Gem>;
${skyWgsl(1)}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec3f, // from its middle, in voxels, along its own axes (it's turned yaw about y)
  @location(1) n: vec3f,     // the facet's outward normal, the same way
  @location(2) @interpolate(flat) gem: u32,
}

// Its own axes in the world: x and z (y is up).
fn axes(yaw: f32) -> mat2x3f { return mat2x3f(vec3f(cos(yaw), 0.0, -sin(yaw)), vec3f(sin(yaw), 0.0, cos(yaw))); }
fn toWorld(v: vec3f, yaw: f32) -> vec3f { let a = axes(yaw); return a[0] * v.x + vec3f(0.0, v.y, 0.0) + a[1] * v.z; }
fn toLocal(v: vec3f, yaw: f32) -> vec3f { let a = axes(yaw); return vec3f(dot(v, a[0]), v.y, dot(v, a[1])); }

@vertex
fn vs(@location(0) corner: vec3f, @location(1) normal: vec3f, @builtin(instance_index) ii: u32) -> VOut {
  let g = gems[ii];
  let size = vec3f(g.size.x, g.size.y, g.size.x);
  let local = corner * size;
  var out: VOut;
  out.pos = V.viewProj * vec4f(g.pose.xyz + toWorld(local, g.pose.w), 1.0);
  out.local = local;
  out.n = normalize(normal / size);
  out.gem = ii;
  return out;
}

// Its facets as planes: the k-th's outward normal (xyz) and how far out it is from the middle (w). 0-3 above its
// waist, 4-7 below.
fn facet(k: u32, g: Gem) -> vec4f {
  let w = g.size.x * 0.5;
  let h = g.size.y * 0.5;
  let waist = (g.size.z - 0.5) * g.size.y;
  let s = vec2f(select(-1.0, 1.0, (k & 1u) == 0u), select(-1.0, 1.0, (k & 2u) == 0u));
  let up = k < 4u;
  let span = select(waist + h, h - waist, up); // from the waist to that tip
  let n = vec3f(s.x / w, select(-1.0, 1.0, up) / span, s.y / w);
  let l = length(n);
  return vec4f(n / l, h / span / l);
}

// The light coming into it from along d (local, leaving): the sky that way, bright from above and dark from below
// and round the horizon (so its facets inside show as light and dark patches), brightest where it's the sun.
fn outside(d: vec3f, yaw: f32) -> vec3f {
  let w = toWorld(d, yaw);
  let sky = envSky(w, 1.0) * (0.15 + 2.2 * smoothstep(0.1, 0.8, w.y));
  let sun = pow(max(dot(w, V.sun.xyz), 0.0), 60.0) * lightIlluminance() / PI * 0.5;
  return sky + sun;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let g = gems[in.gem];
  let yaw = g.pose.w;
  let col = g.col.rgb;
  let n = normalize(in.n);
  let worldPos = g.pose.xyz + toWorld(in.local, yaw);
  let rdw = select(normalize(worldPos - V.eye.xyz), V.ahead.xyz, V.eye.w > 0.5);
  let rd = toLocal(rdw, yaw);
  if (dot(rd, n) >= 0.0) { discard; } // (a far facet: what's inside is worked out from the near one)
  let ior = max(V.look.x, 1.0);
  let f0 = pow((ior - 1.0) / (ior + 1.0), 2.0);
  let cosi = clamp(-dot(rd, n), 0.0, 1.0);
  let fres = f0 + (1.0 - f0) * pow(1.0 - cosi, 5.0);
  // On the facet: the sky reflected, and the sun glinting.
  let r = reflect(rd, n);
  let rw = toWorld(r, yaw);
  var reflection = envSky(rw, 0.5) * V.look.z;
  reflection += pow(max(dot(rw, V.sun.xyz), 0.0), 300.0) * lightIlluminance() / PI * 6.0 * V.look.w;
  // Inside: bent in, then round the facets. Each meets one: some gets out there (bent again; none past the critical
  // angle) and the rest turns back in. Tinted the further it goes; its glow gathered along the way.
  let absorb = V.look.y * (1.0 - col) + 0.05;
  var p = in.local;
  var d = refract(rd, n, 1.0 / ior);
  var carry = 1.0 - fres; // of the light still going
  var travelled = 0.0;
  var inner = vec3f(0.0);
  for (var bounce = 0; bounce < 4; bounce++) {
    var best = 1e3;
    var hit = vec3f(0.0, 1.0, 0.0);
    for (var k = 0u; k < 8u; k++) {
      let f = facet(k, g);
      let dn = dot(f.xyz, d);
      if (dn <= 1e-4) { continue; }
      let s = (f.w - dot(f.xyz, p)) / dn;
      if (s > 1e-4 && s < best) { best = s; hit = f.xyz; }
    }
    if (best > 999.0) { break; }
    best = min(best, 4.0);
    // Its glow from within along the way there, dimmed by what it passes through: brightest at its core, so it
    // shows bent differently through each facet.
    let tint = exp(-absorb * travelled);
    let mid = p + d * (best * 0.5);
    let core = 0.15 + 1.6 * exp(-dot(mid.xz, mid.xz) / max(0.06 * g.size.x * g.size.x, 1e-4));
    inner += col * col * V.glow.x * best * tint * carry * core * 0.6;
    p += d * best;
    travelled += best;
    let leave = refract(d, -hit, ior);
    let c = clamp(dot(d, hit), 0.0, 1.0);
    let fi = select(f0 + (1.0 - f0) * pow(1.0 - c, 5.0), 1.0, dot(leave, leave) < 1e-6);
    if (fi < 1.0) { inner += outside(normalize(leave), yaw) * exp(-absorb * travelled) * col * carry * (1.0 - fi); }
    carry *= fi;
    d = reflect(d, -hit);
  }
  var light = reflection * fres + inner;
  // A hit flashes it white, like a villager.
  light = mix(light, vec3f(1.0), g.size.w);
  light = light / (1.0 + light * 0.12);
  // Round its outline (seen as if it were round, so it brightens smoothly towards the edge): a rim light in its
  // colour, whiter where it's strongest; not toned down, so it can go overbright.
  let semi = vec3f(g.size.x, g.size.y, g.size.x) * 0.5;
  let nr = normalize(in.local / (semi * semi));
  let edge = pow(1.0 - clamp(-dot(rd, nr), 0.0, 1.0), max(V.glow.z, 0.1));
  light += (col + vec3f(0.25) * edge) * edge * V.glow.y;
  return vec4f(light, 1.0);
}
`;

export const GEM_WGSL = SHADER;

export class Gems {
  constructor(device, format, depthFormat, sky) {
    this.device = device;
    this.sky = sky;
    this.data = new Float32Array(MAX_GEMS * GEM_FLOATS);
    this.gems = device.createBuffer({ label: 'gems', size: this.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.uniforms = device.createBuffer({ label: 'gems', size: 64 + 16 * 5, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const verts = SHAPES.gem;
    this.count = verts.length / 6;
    this.vertices = device.createBuffer({ label: 'gem', size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vertices, 0, verts);
    const module = device.createShaderModule({ label: 'gems', code: SHADER });
    const layout = device.createBindGroupLayout({
      label: 'gems',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      label: 'gems',
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout, sky.layout] }),
      vertex: {
        module, entryPoint: 'vs',
        buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }],
      },
      fragment: {
        module, entryPoint: 'fs',
        targets: [{ format, blend: { // its light, over what's behind it times the blend constant (tinted)
          color: { srcFactor: 'one', dstFactor: 'constant', operation: 'add' },
          alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
        } }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' }, // (its far facets are left out in fs)
      depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.group = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: this.uniforms } }, { binding: 1, resource: { buffer: this.gems } }],
    });
  }

  // gems: [{ c: [x, y, z] (its middle), yaw, col: [r, g, b] (linear), flash (0-1) }]. sun: its direction. cam: { eye,
  // ahead, ortho }.
  draw(encoder, colorView, depthView, viewProj, sun, gems, cam) {
    const n = Math.min(gems.length, MAX_GEMS);
    if (!n) return;
    const T = CRYSTAL_TUNING, d = this.data;
    for (let i = 0; i < n; i++) {
      const g = gems[i];
      d.set([...g.c, g.yaw, T.width, T.length, T.waist, g.flash, ...g.col, 0], i * GEM_FLOATS);
    }
    this.device.queue.writeBuffer(this.uniforms, 0, new Float32Array([
      ...viewProj,
      ...cam.eye, cam.ortho ? 1 : 0,
      ...cam.ahead, 0,
      ...sun.slice(0, 3), 0,
      T.gemIor, T.gemAbsorb, T.gemReflect, T.gemSparkle,
      T.glow, T.gemRim, T.gemRimPower, T.gemSeeThrough,
    ]));
    this.device.queue.writeBuffer(this.gems, 0, d, 0, n * GEM_FLOATS);
    const pass = encoder.beginRenderPass({
      label: 'gems',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'store' },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.setBindGroup(1, this.sky.group);
    pass.setVertexBuffer(0, this.vertices);
    const see = Math.min(Math.max(T.gemSeeThrough, 0), 1);
    for (let i = 0; i < n; i++) {
      // What's behind it shows through, in its colour (a little of every colour, so a pure team colour doesn't
      // black the rest out).
      const tint = gems[i].col.map((c) => see * (0.2 + 0.8 * c));
      pass.setBlendConstant({ r: tint[0], g: tint[1], b: tint[2], a: 1 });
      pass.draw(this.count, 1, 0, i);
    }
    pass.end();
  }
}
