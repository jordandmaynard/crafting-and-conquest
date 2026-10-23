// Explosion fire and smoke, after space-miner's puffs.js: camera-facing sprites shaped by four soft smoke images
// (textures/dust_1..4.png, grey, from strata-miner via space-miner). Two kinds: fire (added on, white-hot to deep red
// as it cools) and smoke (blended over the scene, back to front, lit orange by the fire early on and by the daylight
// after). Each puff spins, swells, slows and rises as it drifts. Puffs fade out where they meet the ground (soft
// particles, against the depth buffer) so no sprite's edge ever cuts a hard line through the terrain.
//
// A fireball in flight is a few fire sprites round where it is (cores, given each frame) and a trail of fire and smoke
// puffs it leaves behind (trail). A priest's beam gives off glowing wisps along it, like hot plasma (plasma): added on
// like fire, but in the beam's colour.

export const EXPLOSION_TUNING = {
  fire: 26,           // fire puffs per blast
  fireBrightness: 2.4, // how bright fresh fire is (the canvas saturates past 1, which reads as white-hot)
  fireLife: 0.7,      // seconds a fire puff lasts (each varies up to half again)
  smoke: 30,          // smoke puffs per blast
  smokeOpacity: 0.75,
  smokeLife: 3,       // seconds a smoke puff lasts (each varies up to half again)
  speed: 1.5,         // outward speed, in blast radii per second (each varies)
  size: 0.5,          // puff size at birth, in blast radii; they grow to about 2.5x
  rise: 1.2,          // voxels per second² smoke drifts upward (hot air)
  trail: 30,          // puffs per second a fireball in flight leaves behind it
  soft: 0.8,          // voxels: how far in front of the ground a puff starts fading into it
};

const MAX_PUFFS = 1024;
const PUFF_FLOATS = 12;

const PUFF_WGSL = /* wgsl */ `
// tint: rgb = what lights the smoke (daylight or moonlight), w = fire brightness scale. look: xyz the camera's
// forward, w = softness (voxels).
struct View { viewProj: mat4x4f, invViewProj: mat4x4f, eye: vec4f, look: vec4f, tint: vec4f }
@group(0) @binding(0) var<uniform> V: View;
@group(0) @binding(1) var sprites: texture_2d_array<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var depthTex: texture_depth_2d;

struct PIn {
  @location(0) a: vec4f, // xyz = position, w = half size (voxels)
  @location(1) b: vec4f, // rgb = colour (premultiplied by opacity for smoke), a = opacity
  @location(2) c: vec4f, // x = rotation (rad), y = sprite 0..3
};
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  @location(2) @interpolate(flat) sprite: i32,
  @location(3) world: vec3f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, p: PIn) -> VOut {
  let corners = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  let k = corners[vi];
  let cs = cos(p.c.x);
  let sn = sin(p.c.x);
  let r = vec2f(k.x * cs - k.y * sn, k.x * sn + k.y * cs);
  let view = -V.look.xyz;
  var right = cross(vec3f(0.0, 1.0, 0.0), view);
  if (length(right) < 1e-3) { right = vec3f(1.0, 0.0, 0.0); }
  right = normalize(right);
  let up = cross(view, right);
  let world = p.a.xyz + (right * r.x + up * r.y) * p.a.w;
  var out: VOut;
  out.pos = V.viewProj * vec4f(world, 1.0);
  out.uv = k * vec2f(0.5, -0.5) + 0.5;
  out.color = p.b;
  out.sprite = i32(p.c.y);
  out.world = world;
  return out;
}

// Premultiplied: fire is added (its alpha ignored), smoke blends over what's behind it. Both fade where the ground
// behind is near (soft).
@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  let s = textureSample(sprites, samp, in.uv, in.sprite).r;
  let r = length(in.uv * 2.0 - 1.0);
  var shape = s * smoothstep(1.0, 0.6, r);
  let d = textureLoad(depthTex, vec2i(in.pos.xy), 0);
  if (d < 1.0) {
    let ndc = vec4f(in.pos.x / f32(textureDimensions(depthTex).x) * 2.0 - 1.0,
                    1.0 - in.pos.y / f32(textureDimensions(depthTex).y) * 2.0, d, 1.0);
    let w = V.invViewProj * ndc;
    let behind = dot(w.xyz / w.w - in.world, V.look.xyz);
    shape *= clamp(behind / max(V.look.w, 1e-3), 0.0, 1.0);
  }
  return vec4f(in.color.rgb * shape, shape * in.color.a);
}
`;

export class Puffs {
  // format: the canvas view's; depthFormat and depthTexture: the terrain's depth buffer (read, not written).
  constructor(device, format, depthFormat, tuning = EXPLOSION_TUNING) {
    this.device = device;
    this.t = tuning;
    this.puffs = []; // { pos, vel, size, grow, rot, spin, age, life, sprite, fire, heat }
    this.trailDue = 0;
    this.data = new Float32Array(MAX_PUFFS * PUFF_FLOATS);
    this.buffer = device.createBuffer({ size: this.data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.uniforms = device.createBuffer({ size: 48 * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const F = GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, texture: { viewDimension: '2d-array' } },
        { binding: 2, visibility: F, sampler: {} },
        { binding: 3, visibility: F, texture: { sampleType: 'depth' } },
      ],
    });
    const module = device.createShaderModule({ label: 'puffs', code: PUFF_WGSL });
    const pipeline = (label, color) => device.createRenderPipeline({
      label,
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: {
        module, entryPoint: 'vs',
        buffers: [{
          arrayStride: PUFF_FLOATS * 4, stepMode: 'instance',
          attributes: [0, 1, 2].map((i) => ({ shaderLocation: i, offset: i * 16, format: 'float32x4' })),
        }],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format, blend: { color, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less' },
    });
    this.smokePipeline = pipeline('puffs smoke', { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' });
    this.firePipeline = pipeline('puffs fire', { srcFactor: 'one', dstFactor: 'one', operation: 'add' });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.sprites = null; // a 4-layer texture, once the images have loaded
    this.group = null;
    this.depthTexture = null;
    this.smokeCount = 0;
    this.fireCount = 0;
  }

  // Loads the four smoke images (grey PNGs, all one size) into a texture array, with mips.
  async load(baseUrl = document.baseURI) {
    const images = await Promise.all([1, 2, 3, 4].map(async (i) => {
      const res = await fetch(new URL(`textures/dust_${i}.png`, baseUrl));
      if (!res.ok) throw new Error(`Couldn't load textures/dust_${i}.png (${res.status})`);
      const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      return { size: bitmap.width, data: ctx.getImageData(0, 0, bitmap.width, bitmap.width).data };
    }));
    const size = images[0].size, levels = Math.log2(size) + 1;
    const tex = this.device.createTexture({
      label: 'puff sprites', size: [size, size, 4], format: 'r8unorm', mipLevelCount: levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    images.forEach(({ data }, layer) => {
      // Mips by averaging 2×2 (the red channel of the grey image).
      let n = size, px = new Uint8Array(n * n);
      for (let i = 0; i < n * n; i++) px[i] = data[i * 4];
      for (let level = 0; level < levels; level++) {
        const row = Math.max(256, Math.ceil(n / 256) * 256), padded = new Uint8Array(row * n);
        for (let y = 0; y < n; y++) padded.set(px.subarray(y * n, y * n + n), y * row);
        this.device.queue.writeTexture({ texture: tex, mipLevel: level, origin: [0, 0, layer] }, padded, { bytesPerRow: row }, [n, n, 1]);
        if (n === 1) break;
        const m = n / 2, next = new Uint8Array(m * m);
        for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
          next[y * m + x] = (px[2 * y * n + 2 * x] + px[2 * y * n + 2 * x + 1] + px[(2 * y + 1) * n + 2 * x] + px[(2 * y + 1) * n + 2 * x + 1] + 2) >> 2;
        }
        px = next;
        n = m;
      }
    });
    this.sprites = tex;
    this.group = null;
  }

  // A blast of `radius` voxels at `pos`.
  burst(pos, radius) {
    const t = this.t;
    const rand = (a, b) => a + Math.random() * (b - a);
    const dir = () => {
      const z = rand(-1, 1), a = rand(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
      return [Math.cos(a) * r, Math.abs(z) * 0.8 + 0.2, Math.sin(a) * r]; // (up and out: the ground's below)
    };
    const add = (fire, count, life, speed) => {
      for (let i = 0; i < count; i++) {
        const v = dir(), sp = radius * t.speed * speed * rand(0.35, 1.2);
        const size = radius * t.size * rand(0.7, 1.3) * (fire ? 0.8 : 1);
        this.puffs.push({
          pos: pos.map((c, k) => c + v[k] * radius * rand(0, 0.3)), vel: v.map((c) => c * sp),
          size, grow: size * rand(1.2, 2.2), rot: rand(0, Math.PI * 2), spin: rand(-1.5, 1.5) * (fire ? 1.6 : 0.6),
          age: 0, life: life * rand(1, 1.5), sprite: Math.floor(rand(0, 4)), fire,
        });
      }
    };
    add(false, Math.round(t.smoke), t.smokeLife, 0.8);
    add(true, Math.round(t.fire), t.fireLife, 1);
    if (this.puffs.length > MAX_PUFFS) this.puffs.splice(0, this.puffs.length - MAX_PUFFS);
  }

  // Fireballs in flight for `dt` seconds, at `points` ([x, y, z] each): each leaves a trail of small fire puffs and
  // wisps of smoke behind it.
  trail(points, dt) {
    const t = this.t, rand = (a, b) => a + Math.random() * (b - a);
    this.trailDue += Math.max(0, t.trail) * dt;
    for (; this.trailDue >= 1; this.trailDue--) {
      for (const p of points) {
        const fire = Math.random() < 0.6, size = fire ? rand(0.18, 0.3) : rand(0.2, 0.35);
        this.puffs.push({
          pos: p.map((c) => c + rand(-0.08, 0.08)), vel: [rand(-0.3, 0.3), rand(0, 0.5), rand(-0.3, 0.3)],
          size, grow: size * rand(0.8, 1.6), rot: rand(0, Math.PI * 2), spin: rand(-2, 2),
          age: 0, life: fire ? rand(0.2, 0.35) : rand(0.8, 1.3), sprite: Math.floor(rand(0, 4)), fire, opacity: 0.35, heat: 0.5,
        });
      }
    }
    if (this.puffs.length > MAX_PUFFS) this.puffs.splice(0, this.puffs.length - MAX_PUFFS);
  }

  // Priests' beams for `dt` seconds ([{ a, b, strength 0-1 }]): wisps born at random along each (rate per voxel per
  // second), drifting off it and rising a little, in `color` ([r, g, b], linear) at `glow`, swelling as they fade.
  plasma(beams, dt, { rate, size, life, glow, drift, color }) {
    const rand = (a, b) => a + Math.random() * (b - a);
    for (const { a, b, strength } of beams) {
      const d = b.map((v, i) => v - a[i]), len = Math.hypot(...d);
      let due = rate * len * strength * dt;
      for (; due > 0; due--) {
        if (due < 1 && Math.random() > due) break;
        const k = Math.random(), s = size * rand(0.6, 1.4);
        this.puffs.push({
          pos: a.map((c, i) => c + d[i] * k + rand(-0.03, 0.03)), vel: [0, 0, 0].map(() => rand(-drift, drift)),
          size: s, grow: s * rand(0.8, 1.8), rot: rand(0, Math.PI * 2), spin: rand(-3, 3), age: 0, life: life * rand(0.6, 1.4),
          sprite: Math.floor(rand(0, 4)), fire: true, rise: 0.25, tint: color.map((c) => c * glow * strength),
        });
      }
    }
    if (this.puffs.length > MAX_PUFFS) this.puffs.splice(0, this.puffs.length - MAX_PUFFS);
  }
  update(dt) {
    this.clock = (this.clock ?? 0) + dt; // (game time: the fire cores' flicker, slowed in slow motion)
    const rise = this.t.rise;
    for (const p of this.puffs) {
      p.age += dt;
      const drag = Math.exp(-dt * (p.fire ? 3.5 : 1.8)); // smoke and fire slow as they spread
      p.vel = p.vel.map((v) => v * drag);
      p.vel[1] += rise * dt * (p.rise ?? (p.fire ? 0.5 : 1));
      p.pos = p.pos.map((c, k) => c + p.vel[k] * dt);
      p.rot += p.spin * dt;
    }
    this.puffs = this.puffs.filter((p) => p.age < p.life);
  }

  // This frame's sprites, smoke back to front, then fire (and the fireballs' cores: [[x, y, z], ...], each a few
  // flickering fire sprites). light: [r, g, b] lighting the smoke.
  draw(encoder, colorView, depthView, depthTexture, frame, cores = [], light = [1, 1, 1]) {
    if (!this.sprites) return;
    const t = this.t, e = frame.eye;
    const dist = (p) => (p.pos[0] - e[0]) ** 2 + (p.pos[1] - e[1]) ** 2 + (p.pos[2] - e[2]) ** 2;
    const smoke = this.puffs.filter((p) => !p.fire).sort((a, b) => dist(b) - dist(a));
    const fire = this.puffs.filter((p) => p.fire);
    let n = 0;
    const put = (pos, size, rgb, alpha, rot, sprite) => {
      if (n < MAX_PUFFS) this.data.set([...pos, size, ...rgb, alpha, rot, sprite, 0, 0], n++ * PUFF_FLOATS);
    };
    const sizeOf = (p) => { const f = p.age / p.life; return p.size + p.grow * (1 - (1 - f) ** 2); };
    for (const p of smoke) {
      const f = p.age / p.life;
      // Fades in over the first tenth, out over the rest; glows orange from the fire for its first half second.
      const alpha = (p.opacity ?? t.smokeOpacity) * Math.min(1, f * 10) * (1 - f) ** 1.5;
      const hot = (p.heat ?? 1) * Math.max(0, 1 - p.age / 0.5) ** 2;
      const base = [0.34, 0.31, 0.28].map((c, i) => c * light[i]);
      const rgb = [base[0] + 2.2 * hot, base[1] + 0.8 * hot, base[2] + 0.2 * hot].map((c) => c * alpha);
      put(p.pos, sizeOf(p), rgb, alpha, p.rot, p.sprite);
    }
    this.smokeCount = n;
    const flame = (b, f) => [b, b * (0.75 - 0.55 * f) ** 1.2, b * Math.max(0, 0.45 - f) * 0.9];
    for (const p of fire) {
      const f = p.age / p.life;
      // Cooling: white-yellow, orange, then deep red as it fades (plasma: its own colour, fading in fast and out).
      if (p.tint) put(p.pos, sizeOf(p), p.tint.map((c) => c * Math.min(1, f * 8) * (1 - f) ** 1.5), 1, p.rot, p.sprite);
      else put(p.pos, sizeOf(p), flame(t.fireBrightness * (1 - f) ** 2, f), 1, p.rot, p.sprite);
    }
    const now = this.clock ?? 0;
    for (const c of cores) {
      for (let k = 0; k < 3; k++) {
        const flick = 0.85 + 0.15 * Math.sin(now * 37 + k * 2.1);
        put(c, (0.42 - k * 0.1) * flick, flame(t.fireBrightness * (0.7 + 0.3 * k), 0.1 * (2 - k)), 1, now * (3 + k) * (k % 2 ? -1 : 1), k);
      }
    }
    this.fireCount = n - this.smokeCount;
    if (!n) return;
    this.device.queue.writeBuffer(this.buffer, 0, this.data, 0, n * PUFF_FLOATS);
    const u = new Float32Array(48);
    u.set(frame.viewProj, 0);
    u.set(frame.invViewProj, 16);
    u.set([...e, 0], 32);
    u.set([...frame.look, t.soft], 36);
    u.set([...light, 1], 40);
    this.device.queue.writeBuffer(this.uniforms, 0, u);
    if (!this.group || this.depthTexture !== depthTexture) {
      this.depthTexture = depthTexture;
      this.group = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniforms } },
          { binding: 1, resource: this.sprites.createView({ dimension: '2d-array' }) },
          { binding: 2, resource: this.sampler },
          { binding: 3, resource: depthTexture.createView() },
        ],
      });
    }
    const pass = encoder.beginRenderPass({
      label: 'puffs',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depthView, depthReadOnly: true },
    });
    pass.setBindGroup(0, this.group);
    pass.setVertexBuffer(0, this.buffer);
    if (this.smokeCount) {
      pass.setPipeline(this.smokePipeline);
      pass.draw(6, this.smokeCount, 0, 0);
    }
    if (this.fireCount) {
      pass.setPipeline(this.firePipeline);
      pass.draw(6, this.fireCount, 0, this.smokeCount);
    }
    pass.end();
  }
}
