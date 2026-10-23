// A selected building's outline: its whole silhouette on screen, in its team's colour, as wide as a selected
// villager's (SELECT_TUNING.outline pixels), drawn over everything, so it shows through the hill or the cave roof in
// front of it too (Jordan). Drawn after the villagers: its blocks (each a voxel cube) go into a mask with no depth
// test, and a screen pass draws round the mask's edge, faded off at the edge. So the lines between its own blocks never
// show, at any angle, and the line runs along the ground where it stands too.

export const OUTLINE_WGSL = /* wgsl */ `
// viewProj; color: rgb (linear), w = width (pixels); screen: width, height.
struct U { viewProj: mat4x4f, color: vec4f, screen: vec4f }
@group(0) @binding(0) var<uniform> O: U;
@group(0) @binding(1) var mask: texture_2d<f32>;

// The mask: one cube per block (its low corner per instance).
@vertex
fn vsMask(@location(0) corner: vec3f, @location(1) cell: vec3f) -> @builtin(position) vec4f {
  return O.viewProj * vec4f(cell + corner, 1.0);
}

@fragment
fn fsMask() -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 1.0); }

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

// Whether pixel px shows (or would, with nothing in front) one of the building's blocks.
fn inside(px: vec2i) -> bool {
  let q = clamp(px, vec2i(0), vec2i(O.screen.xy) - 1);
  return textureLoad(mask, q, 0).r > 0.5;
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let px = vec2i(pos.xy);
  if (inside(px)) { discard; }
  let R = O.color.w;
  let n = i32(ceil(R));
  var best = 1e9;
  for (var dy = -6; dy <= 6; dy++) {
    if (abs(dy) > n) { continue; }
    for (var dx = -6; dx <= 6; dx++) {
      if (abs(dx) > n) { continue; }
      let d2 = f32(dx * dx + dy * dy);
      if (d2 >= best || d2 > (R + 0.5) * (R + 0.5)) { continue; }
      if (inside(px + vec2i(dx, dy))) { best = d2; }
    }
  }
  let a = clamp(R + 0.5 - sqrt(best), 0.0, 1.0);
  if (a <= 0.0) { discard; }
  return vec4f(O.color.rgb, a);
}
`;

// A unit cube's 36 corners (0 to 1), two triangles a face.
function cubeCorners() {
  const out = [];
  for (let axis = 0; axis < 3; axis++) {
    for (const side of [0, 1]) {
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      const q = [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]];
      for (const [a, b] of q) {
        const c = [0, 0, 0];
        c[axis] = side; c[u] = a; c[v] = b;
        out.push(...c);
      }
    }
  }
  return new Float32Array(out);
}

export class BuildingOutline {
  constructor(device, format) {
    this.device = device;
    const module = device.createShaderModule({ label: 'building outline', code: OUTLINE_WGSL });
    this.maskLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } }],
    });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    });
    this.maskPipeline = device.createRenderPipeline({
      label: 'building outline mask',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.maskLayout] }),
      vertex: {
        module, entryPoint: 'vsMask',
        buffers: [
          { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
          { arrayStride: 12, stepMode: 'instance', attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
        ],
      },
      fragment: { module, entryPoint: 'fsMask', targets: [{ format: 'r8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    this.pipeline = device.createRenderPipeline({
      label: 'building outline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module, entryPoint: 'fs',
        targets: [{ format, blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        } }],
      },
      primitive: { topology: 'triangle-list' },
    });
    const corners = cubeCorners();
    this.cube = device.createBuffer({ size: corners.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.cube, 0, corners);
    this.uniforms = device.createBuffer({ size: 24 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.maskGroup = device.createBindGroup({ layout: this.maskLayout, entries: [{ binding: 0, resource: { buffer: this.uniforms } }] });
    this.cells = null;
    this.mask = null;
    this.group = null;
  }

  // The building's blocks still there ([[x, y, z]]), outlined in `color` (linear rgb), `width` pixels wide, at the
  // canvas's size (gbuf's; it and depth are no longer read: the outline goes over whatever is in front).
  draw(encoder, colorView, gbuf, depth, viewProj, invViewProj, cells, color, width, profiler) {
    if (!cells.length || width <= 0) return;
    const W = gbuf.width, H = gbuf.height;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const data = new Float32Array(cells.length * 3);
    cells.forEach((c, k) => {
      for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], c[i]); hi[i] = Math.max(hi[i], c[i] + 1); data[k * 3 + i] = c[i]; }
    });
    if (!this.cells || this.cells.size < data.byteLength) {
      this.cells?.destroy();
      this.cells = this.device.createBuffer({ size: Math.max(256, data.byteLength * 2), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    this.device.queue.writeBuffer(this.cells, 0, data);
    if (!this.mask || this.mask.width !== W || this.mask.height !== H) {
      this.mask?.destroy();
      this.mask = this.device.createTexture({ label: 'building outline mask', size: [W, H], format: 'r8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      this.group = this.device.createBindGroup({
        layout: this.layout,
        entries: [{ binding: 0, resource: { buffer: this.uniforms } }, { binding: 1, resource: this.mask.createView() }],
      });
    }
    const u = new Float32Array(24);
    u.set(viewProj, 0);
    u.set([...color, Math.min(width, 6)], 16);
    u.set([W, H, 0, 0], 20);
    this.device.queue.writeBuffer(this.uniforms, 0, u);
    // Only the pixels round the building's box on screen (all of them when it's partly behind the camera).
    let x0 = 0, y0 = 0, x1 = W, y1 = H;
    const pts = [];
    for (let k = 0; k < 8; k++) {
      const p = [k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]];
      const m = viewProj;
      const cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      if (cw <= 1e-4) { pts.length = 0; break; }
      pts.push([(m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / cw, (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / cw]);
    }
    if (pts.length) {
      const pad = Math.ceil(width) + 2;
      x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => (p[0] * 0.5 + 0.5) * W)) - pad));
      x1 = Math.min(W, Math.ceil(Math.max(...pts.map((p) => (p[0] * 0.5 + 0.5) * W)) + pad));
      y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => (0.5 - p[1] * 0.5) * H)) - pad));
      y1 = Math.min(H, Math.ceil(Math.max(...pts.map((p) => (0.5 - p[1] * 0.5) * H)) + pad));
    }
    if (x1 <= x0 || y1 <= y0) return;
    const mp = encoder.beginRenderPass({
      label: 'building outline mask',
      colorAttachments: [{ view: this.mask.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
    });
    mp.setPipeline(this.maskPipeline);
    mp.setBindGroup(0, this.maskGroup);
    mp.setVertexBuffer(0, this.cube);
    mp.setVertexBuffer(1, this.cells);
    mp.draw(36, cells.length);
    mp.end();
    const pass = encoder.beginRenderPass({
      label: 'building outline',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      timestampWrites: profiler?.tsw('building outline'),
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.setScissorRect(x0, y0, x1 - x0, y1 - y0);
    pass.draw(3);
    pass.end();
  }
}
