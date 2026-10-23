// Post-processing, after everything else is drawn: bloom (bright parts of the frame glowing over their surroundings)
// and depth of field (sharp around what the camera looks at, blurring nearer and further away, which reads as a
// tilt-shift miniature from up high).
//
// The frame is copied out of the canvas, then: bloom runs a chain of half-size textures down from it (the first step
// keeping only what's brighter than the threshold) and back up, adding each level into the one above; the composite
// reads the copy and the depth buffer, gathers a disc of samples around each pixel as wide as its circle of confusion,
// adds the bloom and writes the result back to the canvas.

export const POST_TUNING = {
  bloom: 0.83,       // bloom strength (0 = off)
  threshold: 0.2,    // how bright (linear, 0-1) a pixel must be to bloom
  bloomRadius: 0.7,  // how far the glow spreads (how much of each wider level is added in)
  dofBlur: 7,        // depth of field: the widest blur, in pixels (0 = off)
  dofFocus: -16,     // voxels nearer (-) or further (+) than the camera's target that's in focus
  dofRange: 59,      // voxels either side of the focus that stay sharp; the blur grows over as many again
};

const LEVELS = 5;
const SAMPLES = 24;

export const POST_WGSL = /* wgsl */ `
struct Post {
  invViewProj: mat4x4f,
  eye: vec4f,       // xyz, w: the widest blur in pixels
  focus: vec4f,     // focus distance, sharp range, bloom strength, threshold
  size: vec4f,      // w, h, 1/w, 1/h
};
@group(0) @binding(0) var<uniform> P: Post;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var depthTex: texture_depth_2d;
@group(0) @binding(4) var bloomTex: texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

// Dual-filter downsample: the centre and four diagonal taps half a source texel out.
// (Each sample between black and white, as the 8-bit canvas has it, so with HDR output's float frame the bloom's the
// same, and a NaN in it doesn't bloom.)
fn tap(uv: vec2f) -> vec3f {
  let c = textureSampleLevel(src, samp, uv, 0.0).rgb;
  return select(clamp(c, vec3f(0.0), vec3f(1.0)), vec3f(0.0), (bitcast<vec3u>(c) & vec3u(0x7f800000u)) == vec3u(0x7f800000u));
}
fn down(uv: vec2f) -> vec3f {
  let t = 1.0 / vec2f(textureDimensions(src));
  var c = tap(uv) * 4.0;
  c += tap(uv + vec2f(-t.x, -t.y));
  c += tap(uv + vec2f(t.x, -t.y));
  c += tap(uv + vec2f(-t.x, t.y));
  c += tap(uv + vec2f(t.x, t.y));
  return c / 8.0;
}

// The first step down: only what's over the threshold, with a soft knee.
@fragment fn fsPrefilter(v: VOut) -> @location(0) vec4f {
  let c = down(v.uv);
  let l = max(max(c.r, c.g), c.b);
  let knee = 0.25 * P.focus.w + 1e-4;
  var s = clamp(l - P.focus.w + knee, 0.0, 2.0 * knee);
  s = s * s / (4.0 * knee);
  return vec4f(c * max(s, l - P.focus.w) / max(l, 1e-4), 1.0);
}

@fragment fn fsDown(v: VOut) -> @location(0) vec4f { return vec4f(down(v.uv), 1.0); }

// Dual-filter upsample (a tent of eight taps), added into the level above by the blend.
@fragment fn fsUp(v: VOut) -> @location(0) vec4f {
  let t = 1.0 / vec2f(textureDimensions(src));
  var c = textureSampleLevel(src, samp, v.uv + vec2f(-2.0 * t.x, 0.0), 0.0).rgb;
  c += textureSampleLevel(src, samp, v.uv + vec2f(2.0 * t.x, 0.0), 0.0).rgb;
  c += textureSampleLevel(src, samp, v.uv + vec2f(0.0, -2.0 * t.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, v.uv + vec2f(0.0, 2.0 * t.y), 0.0).rgb;
  c += textureSampleLevel(src, samp, v.uv + vec2f(-t.x, -t.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, v.uv + vec2f(t.x, -t.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, v.uv + vec2f(-t.x, t.y), 0.0).rgb * 2.0;
  c += textureSampleLevel(src, samp, v.uv + vec2f(t.x, t.y), 0.0).rgb * 2.0;
  return vec4f(c / 12.0, 1.0);
}

// How blurred pixel px is, 0-1: by its distance from the eye against the focus.
fn coc(px: vec2i) -> f32 {
  let d = textureLoad(depthTex, px, 0);
  let ndc = vec2f((f32(px.x) + 0.5) * P.size.z * 2.0 - 1.0, 1.0 - (f32(px.y) + 0.5) * P.size.w * 2.0);
  let w = P.invViewProj * vec4f(ndc, d, 1.0);
  let dist = length(w.xyz / w.w - P.eye.xyz);
  let range = max(P.focus.y, 0.5);
  return clamp((abs(dist - P.focus.x) - range) / range, 0.0, 1.0);
}

@fragment fn fsComposite(v: VOut) -> @location(0) vec4f {
  let px = vec2i(v.pos.xy);
  var col = textureSampleLevel(src, samp, v.uv, 0.0).rgb;
  let maxBlur = P.eye.w;
  if (maxBlur > 0.0) {
    let c0 = coc(px);
    let r0 = c0 * maxBlur;
    if (r0 > 0.5) {
      // A golden-angle disc of samples out to this pixel's blur. Each counts as far as its own blur reaches this one,
      // so sharp things don't smear over blurred ones beside them.
      var sum = col;
      var wsum = 1.0;
      let dims = vec2i(P.size.xy) - 1;
      for (var i = 1; i <= ${SAMPLES}; i++) {
        let fi = f32(i);
        let r = sqrt(fi / ${SAMPLES}.0) * r0;
        let a = fi * 2.39996;
        let o = vec2f(cos(a), sin(a)) * r;
        let q = clamp(px + vec2i(round(o)), vec2i(0), dims);
        let w = clamp(min(coc(q), c0) * maxBlur - r + 1.0, 0.0, 1.0);
        sum += textureSampleLevel(src, samp, v.uv + o * P.size.zw, 0.0).rgb * w;
        wsum += w;
      }
      col = sum / wsum;
    }
  }
  if (P.focus.z > 0.0) { col += textureSampleLevel(bloomTex, samp, v.uv, 0.0).rgb * P.focus.z; }
  return vec4f(col, 1.0);
}
`;

export class PostFX {
  // format: the canvas's (srgb) view format, which the composite writes and the frame copy is read through.
  constructor(device, format) {
    this.device = device;
    this.format = format;
    this.size = [0, 0];
    this.uniforms = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.data = new Float32Array(28);
    this.samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const module = device.createShaderModule({ label: 'post', code: POST_WGSL });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const pipe = (entry, fmt, blend) => device.createRenderPipeline({
      label: `post ${entry}`, layout,
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: entry, targets: [{ format: fmt, blend }] },
      primitive: { topology: 'triangle-list' },
    });
    this.prefilter = pipe('fsPrefilter', 'rgba16float');
    this.downPipe = pipe('fsDown', 'rgba16float');
    this.upPipe = pipe('fsUp', 'rgba16float', {
      color: { srcFactor: 'constant', dstFactor: 'one', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
    });
    this.composite = pipe('fsComposite', format);
    // Stands in for the bloom in the passes that write to the bloom chain (a texture can't be read and drawn to at once).
    this.blank = device.createTexture({ size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING }).createView();
  }

  // Follows the output size: the frame copy, the bloom chain and their bind groups.
  resize(w, h, depthTexture) {
    if (this.size[0] === w && this.size[1] === h && this.depthTexture === depthTexture) return;
    this.size = [w, h];
    this.depthTexture = depthTexture;
    this.scene?.destroy();
    for (const t of this.mips ?? []) t.destroy();
    this.scene = this.device.createTexture({
      label: 'post: frame', size: [w, h], format: this.format.replace('-srgb', ''), viewFormats: [this.format],
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.mips = [];
    for (let i = 0; i < LEVELS; i++) {
      this.mips.push(this.device.createTexture({
        label: `post: bloom ${i}`, size: [Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1))], format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      }));
    }
    const sceneView = this.scene.createView({ format: this.format }), depthView = depthTexture.createView();
    const views = this.mips.map((t) => t.createView());
    const group = (srcView, bloomView = this.blank) => this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: srcView },
        { binding: 2, resource: this.samp },
        { binding: 3, resource: depthView },
        { binding: 4, resource: bloomView },
      ],
    });
    this.views = views;
    this.sceneGroup = group(sceneView);
    this.compositeGroup = group(sceneView, views[0]);
    this.mipGroups = views.map((v) => group(v));
  }

  // frame: { invViewProj, eye, focus (distance from the eye in focus, before dofFocus), dofBlur (optional: in place of
  // POST_TUNING's) }
  draw(encoder, canvasTexture, frame, profiler) {
    const T = POST_TUNING, [w, h] = this.size, blur = frame.dofBlur ?? T.dofBlur;
    if (!(T.bloom > 0) && !(blur > 0)) return;
    const d = this.data;
    d.set(frame.invViewProj, 0);
    d.set([...frame.eye, Math.max(0, blur)], 16);
    d.set([Math.max(0, frame.focus + T.dofFocus), T.dofRange, Math.max(0, T.bloom), T.threshold], 20);
    d.set([w, h, 1 / w, 1 / h], 24);
    this.device.queue.writeBuffer(this.uniforms, 0, d);
    encoder.copyTextureToTexture({ texture: canvasTexture }, { texture: this.scene }, [w, h]);

    const bloom = T.bloom > 0;
    const steps = bloom ? 2 * LEVELS - 1 : 0;
    const tsw = profiler?.chain('post: bloom + depth of field', steps + 1) ?? [];
    let n = 0;
    const run = (view, pipeline, group, load = false) => {
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view, loadOp: load ? 'load' : 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        timestampWrites: tsw[n++],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      if (load) pass.setBlendConstant([T.bloomRadius, T.bloomRadius, T.bloomRadius, 1]);
      pass.draw(3);
      pass.end();
    };
    if (bloom) {
      run(this.views[0], this.prefilter, this.sceneGroup);
      for (let i = 1; i < LEVELS; i++) run(this.views[i], this.downPipe, this.mipGroups[i - 1]);
      for (let i = LEVELS - 2; i >= 0; i--) run(this.views[i], this.upPipe, this.mipGroups[i + 1], true);
    }
    run(canvasTexture.createView({ format: this.format }), this.composite, bloom ? this.compositeGroup : this.sceneGroup);
  }
}
