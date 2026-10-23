// HDR output (opt-in, see main.js): the frame's drawn into a float texture (`scene`, linear light, nothing clipped at
// white) instead of the canvas, and this last pass writes it out to a float canvas the browser shows in extended range
// (toneMapping 'extended'), so on an HDR screen what's brighter than white (the sun on the water, glints, fire, the
// sky round the sun) is brighter than white. Up to white it's the same picture as without: over it, highlights are
// lifted by `gain` and rolled off smoothly towards `peak` (times SDR white) rather than cut off. The canvas is 'srgb':
// its values carry the sRGB curve, carried on past 1.

export const HDR_TUNING = {
  peak: 4,    // the brightest it goes, in times SDR white (screens top out at their own peak)
  gain: 1,    // how much brighter than white what's over white gets (1: as bright as it was drawn)
};

const HDR_WGSL = /* wgsl */ `
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var<uniform> P: vec4f; // peak, gain

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

// Over white: lifted by gain, rolled off towards peak.
fn highlight(x: f32) -> f32 {
  if (x <= 1.0) { return x; }
  let head = max(P.x - 1.0, 1e-3);
  return 1.0 + head * (1.0 - exp(-(x - 1.0) * P.y / head));
}

// The sRGB curve, carried on past 1.
fn encode(x: f32) -> f32 {
  return select(12.92 * x, 1.055 * pow(x, 1.0 / 2.4) - 0.055, x > 0.0031308);
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var c = textureLoad(scene, vec2i(pos.xy), 0).rgb;
  // Anything not a number shows as black rather than whatever the display makes of it.
  c = select(max(c, vec3f(0.0)), vec3f(0.0), (bitcast<vec3u>(c) & vec3u(0x7f800000u)) == vec3u(0x7f800000u));
  return vec4f(encode(highlight(c.r)), encode(highlight(c.g)), encode(highlight(c.b)), 1.0);
}
`;

export class HdrOutput {
  constructor(device) {
    this.device = device;
    const module = device.createShaderModule({ label: 'hdr output', code: HDR_WGSL });
    this.pipeline = device.createRenderPipeline({
      label: 'hdr output', layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
    });
    this.uniforms = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.texture = null;
    this.group = null;
  }

  // The float texture the frame's drawn into, w × h (made again when the canvas changes size).
  scene(w, h) {
    if (this.texture?.width === w && this.texture?.height === h) return this.texture;
    this.texture?.destroy();
    this.texture = this.device.createTexture({
      label: 'hdr scene', size: [w, h], format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
    });
    this.group = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.texture.createView() }, { binding: 1, resource: { buffer: this.uniforms } }],
    });
    return this.texture;
  }

  // The scene out to the canvas's texture.
  draw(encoder, canvasTexture) {
    this.device.queue.writeBuffer(this.uniforms, 0, new Float32Array([Math.max(1, HDR_TUNING.peak), Math.max(0, HDR_TUNING.gain), 0, 0]));
    const pass = encoder.beginRenderPass({
      label: 'hdr output',
      colorAttachments: [{ view: canvasTexture.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.draw(3);
    pass.end();
  }
}
