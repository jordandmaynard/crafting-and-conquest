// Fog of war, worked out per team. Each map column is never seen, seen before (remembered) or seen now, as one byte
// per column per team (NEVER, SEEN, VISIBLE). Every few frames each team's villagers (out to the further of their
// weapon's range and FOG_TUNING.sight) and finished buildings (their kind's sight round their footprint) stamp discs of
// VISIBLE, and what they stamped last time drops back to SEEN. How far a disc reaches depends on each column's height
// against the viewer's (ground, the villager's feet; the top of the building): lowGain voxels further for each voxel
// it's lower (up to lowMax), highLoss nearer for each voxel it's higher. (A column's height: the top of its highest
// voxel that isn't a tree's, kept in `ground`, re-read where it's edited.)
//
// The player's (blue's) view of it:
// - Never seen: not drawn at all. Its columns go up to the GPU as air (TerrainField.blank: no terrain, shadow or light
//   from it; Grass.blank: no tufts), all but those near what's been seen (near), each 8 × 8 tile with columns newly
//   near sent up again as it is now (update). A full-screen pass after the water cuts what's drawn there away pixel by
//   pixel along the never-seen mask (blurred on the GPU, `edge` voxels, so the cut runs smoothly through the voxels,
//   softened by `feather`), and paints voidColor (over the sky, by voidMix) there and over what's left: the water, and
//   rays that went down through it to the bottom of the map.
// - Seen before: the land as it was last seen, darker (seenDark) and greyer (seenDesat): the fog pass reads a copy of
//   the frame so far there, by the remembered mask (blurred over its own `seenEdge` voxels and softened by
//   `seenFeather`, so it fades in and out). Edits anywhere the player
//   can't see now aren't shown: defer() holds them back per 8 × 8 column tile, and they're shown once the tile's middle
//   is seen again (the GPU's voxels, distance field, grass and minimap all follow, only the simulation sees the change).
// - Seen now: everything.
// Other teams' villagers, their arrows, fireballs, blasts and debris are hidden wherever the player can't see now (see
// hidden, and Units.parts).

import { SIZE, BLOCK } from './terrain.js';
import { skyWgsl, linearColor } from './sky.js';

export const NEVER = 0, SEEN = 128, VISIBLE = 255;
const TILE = 8;

export const FOG_TUNING = {
  voidColor: '#000000', // never seen: what's there instead
  voidMix: 0,         // and how much of it (0: the sky shows through)
  bare: 1,            // 1: never-seen columns near the edge go up as bare land (no trees or buildings), so nothing
                      // standing there hides what's behind it; 0: as they are (cut away where they stand)
  feather: 0.23,      // how soft the cut along its edge is (0 hard, up to 0.5 very soft)
  edge: 2.1,          // voxels the never-seen edge is smoothed over (the masks' blur)
  sight: 10,          // voxels every villager sees, at least (those with a longer weapon range see that far)
  dither: 0,          // voxels: how far each column's sight edge is moved in or out, for a ragged edge (0: round)
  speckle: 0.6,       // how much of that is speckled column by column (1) rather than smooth wavy (0)
  buildingSight: 10,  // voxels a finished building sees round its footprint, if its kind has no BUILDING_SIGHT
  lowGain: 1,         // voxels further it sees over a column, for every voxel the column is lower than the viewer
  lowMax: 20,         // (but no more than this much further)
  highLoss: 1,        // voxels less far it sees a column, for every voxel the column is higher than the viewer
  every: 0.02,        // seconds between working it out again
  seenDark: 0.9,      // remembered (seen, not now) land, in the view: this much darker (0: full brightness)
  seenDesat: 0.6,     // and this much greyer (0: full colour, 1: grey)
  seenEdge: 1.6,      // voxels its edge (with seen now) is smoothed over
  seenFeather: 0.27,  // how soft that edge is (0 hard, 0.5 a fade over the whole of seenEdge)
  mapSeen: 0.63,      // and its brightness on the minimap (never seen is black)
};

export const FOG_WGSL = /* wgsl */ `
struct FogU {
  invViewProj: mat4x4f,
  size: vec4f,  // w, h, 1/w, 1/h
  map: vec4f,   // X, Z, seenDark, seenDesat
  void: vec4f,  // rgb (linear), how much (0 the sky)
  extra: vec4f, // x: a pixel's angle (for the sky; 0 orthographic), y: feather, z: seenFeather
};
@group(0) @binding(0) var<uniform> U: FogU;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var fogTex: texture_2d<f32>; // r: never seen (blurred), b: remembered (blurred)
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var sceneTex: texture_2d<f32>; // the frame so far (a copy)
${skyWgsl(1)}

struct VOut { @builtin(position) pos: vec4f };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  return o;
}

// How much (0-1) point xz is never seen: past halfway on the blurred mask, softened by feather.
fn unseenAt(xz: vec2f) -> f32 {
  let f = textureSampleLevel(fogTex, samp, xz / U.map.xy, 0.0).r;
  let w = max(U.extra.y, 1e-3);
  return smoothstep(0.5 - w, 0.5 + w, f);
}

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let px = vec2i(v.pos.xy);
  let ndc = vec2f((f32(px.x) + 0.5) * U.size.z * 2.0 - 1.0, 1.0 - (f32(px.y) + 0.5) * U.size.w * 2.0);
  let n0 = U.invViewProj * vec4f(ndc, 0.0, 1.0);
  let n1 = U.invViewProj * vec4f(ndc, 1.0, 1.0);
  let ro = n0.xyz / n0.w;
  let rd = normalize(n1.xyz / n1.w - ro);
  let d = textureLoad(depthTex, px, 0);
  let w = U.invViewProj * vec4f(ndc, d, 1.0);
  let scene = w.xyz / w.w;

  var out = vec4f(0.0);
  // Remembered land: darker (seenDark) and greyer (seenDesat), drawn over the frame (opaque).
  if ((U.map.z > 0.0 || U.map.w > 0.0) && d < 1.0) {
    let ws = max(U.extra.z, 1e-3);
    let rem = smoothstep(0.5 - ws, 0.5 + ws, textureSampleLevel(fogTex, samp, scene.xz / U.map.xy, 0.0).b);
    if (rem > 0.002) {
      let c = textureLoad(sceneTex, px, 0).rgb;
      let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
      out = vec4f(mix(c, vec3f(l), U.map.w * rem) * (1.0 - U.map.z * rem), 1.0);
    }
  }
  // Never seen: what's drawn there cut away (the hit nudged on into what it hit), and a ray that got down through it
  // to the bottom layer of the map (which every column drawn has) painted over.
  var gone = 0.0;
  if (d < 1.0) {
    let q = (scene + rd * 0.02).xz;
    gone = select(unseenAt(q), 1.0, any(q < vec2f(0.0)) || any(q >= U.map.xy));
  } else {
    let inv = 1.0 / select(rd, vec3f(1e-6), abs(rd) < vec3f(1e-6));
    let ta = (vec3f(0.0) - ro) * inv;
    let tb = (vec3f(U.map.x, 1.0, U.map.y) - ro) * inv;
    let t0 = max(max(min(ta.x, tb.x), min(ta.y, tb.y)), max(min(ta.z, tb.z), 0.0));
    let t1 = min(min(max(ta.x, tb.x), max(ta.y, tb.y)), max(ta.z, tb.z));
    gone = select(0.0, 1.0, t0 < t1);
  }
  if (gone <= 0.0) {
    if (out.a <= 0.0) { discard; }
    return out;
  }
  // (What would be behind it, the sky, under the colour.)
  var sky = skyBackground(rd, U.extra.x);
  sky = sky / (1.0 + sky * 0.12);
  return vec4f(mix(sky, U.void.rgb, U.void.a) * gone + out.rgb * (1.0 - gone), gone + out.a * (1.0 - gone));
}
`;

// The never-seen and remembered masks blurred (Gaussians, edge and seenEdge voxels wide, across then down).
export const FOG_BLUR_WGSL = /* wgsl */ `
struct BlurU { radius: vec4f }; // x: radius (texels), y: never's sigma, z: 1 for the second pass (down), w: remembered's sigma
@group(0) @binding(0) var<uniform> B: BlurU;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = vec2i(textureDimensions(src));
  let c = vec2i(id.xy);
  if (c.x >= dims.x || c.y >= dims.y) { return; }
  let down = B.radius.z > 0.5;
  let step = select(vec2i(1, 0), vec2i(0, 1), down);
  let r = i32(B.radius.x);
  var sum = vec2f(0.0);
  var wsum = vec2f(0.0);
  for (var i = -r; i <= r; i++) {
    let q = clamp(c + step * i, vec2i(0), dims - 1);
    let s = textureLoad(src, q, 0);
    let fi = f32(i);
    let w = exp(-fi * fi / (2.0 * B.radius.yw * B.radius.yw));
    // First pass: from the state (0 never, 0.5 seen, 1 now). Second: the first pass's never (r) and remembered (b).
    // (Remembered counts never seen too, so it stays dark up to the never-seen edge, where the cut takes over.)
    let m = select(vec2f(select(0.0, 1.0, s.r < 0.25), select(0.0, 1.0, s.r < 0.75)), s.rb, down);
    sum += m * w;
    wsum += w;
  }
  let m = sum / wsum;
  textureStore(dst, c, vec4f(m.x, 0.0, m.y, 1.0));
}
`;

export class Fog {
  constructor(device, format, sky, terrain) {
    this.device = device;
    this.sky = sky;
    this.terrain = terrain;
    this.ground = null;     // each column's height (see relief), read when the fog's turned on
    this.format = format; // (the canvas's srgb view: the frame's copy is read through it)
    this.scene = null;    // that copy
    const [X, , Z] = SIZE;
    this.on = false;
    this.player = 'blue';
    this.teams = new Map(); // team -> { state: Uint8Array X × Z, discs: [[x, z, r]] stamped last }
    this.wait = 0;
    this.rows = null;       // the player's rows changed since the GPU last had them: [z0, z1)
    this.stale = new Map(); // tile -> [y0, y1): edits there the player hasn't seen
    this.unseen = X * Z;    // the player's never-seen columns (none: no fog to draw)
    this.onRows = null;     // (z0, z1) => void: the player's rows changed (for the minimap)
    this.revealed = new Set(); // tiles where a column's come near what the player's seen since the last update
    // 1 for each column within the cut's reach of what the player's seen (drawn), 0 for the rest (sent to the GPU as
    // air, see TerrainField.blank).
    this.near = new Uint8Array(X * Z);
    const tex = (label, format, usage) => device.createTexture({ label, size: [X, Z], format, usage: GPUTextureUsage.TEXTURE_BINDING | usage });
    this.stateTex = tex('fog state', 'r8unorm', GPUTextureUsage.COPY_DST);
    this.tmpTex = tex('fog blur', 'rgba8unorm', GPUTextureUsage.STORAGE_BINDING);
    this.fogTex = tex('fog', 'rgba8unorm', GPUTextureUsage.STORAGE_BINDING);

    const blur = device.createShaderModule({ label: 'fog blur', code: FOG_BLUR_WGSL });
    this.blurPipe = device.createComputePipeline({ layout: 'auto', compute: { module: blur, entryPoint: 'main' } });
    this.blurU = [0, 1].map(() => device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    const group = (u, src, dst) => device.createBindGroup({
      layout: this.blurPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: u } },
        { binding: 1, resource: src.createView() },
        { binding: 2, resource: dst.createView() },
      ],
    });
    this.blurGroups = [group(this.blurU[0], this.stateTex, this.tmpTex), group(this.blurU[1], this.tmpTex, this.fogTex)];
    this.blurNeeded = true;

    const module = device.createShaderModule({ label: 'fog', code: FOG_WGSL });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      label: 'fog',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout, sky.layout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module, entryPoint: 'fs',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.uniforms = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.data = new Float32Array(32);
    this.depthTexture = null;
    this.group = null;
  }

  team(name) {
    let t = this.teams.get(name);
    if (!t) {
      t = { state: new Uint8Array(SIZE[0] * SIZE[2]), discs: [] };
      this.teams.set(name, t);
    }
    return t;
  }

  // Turns it on (every team's seen nothing yet) or off (every held-back edit shown: see flush).
  enable(on) {
    this.on = on;
    this.ground = null; // (read again, all of it, at the next update)
    this.teams.clear();
    this.revealed.clear();
    this.near.fill(0);
    this.wait = 0;
    this.unseen = SIZE[0] * SIZE[2];
    this.rows = [0, SIZE[2]];
    this.onRows?.(0, SIZE[2]);
  }

  // Whether the player (or another team) can't see column (x, z) now.
  hidden(x, z, team = this.player) {
    if (!this.on) return false;
    const xi = Math.floor(x), zi = Math.floor(z);
    if (xi < 0 || zi < 0 || xi >= SIZE[0] || zi >= SIZE[2]) return true;
    return this.team(team).state[xi + zi * SIZE[0]] !== VISIBLE;
  }

  // The player's state of each column (null while it's off).
  get state() { return this.on ? this.team(this.player).state : null; }

  // Every FOG_TUNING.every seconds: what each team sees, from its villagers (sight(u): how far one sees) and finished
  // buildings (buildingSight(b): how far one sees round its footprint). Returns the held-back edits the player sees
  // now, [{ lo, hi }], to show.
  update(dt, units, buildings, sight, buildingSight = () => FOG_TUNING.buildingSight) {
    if (!this.on || (this.wait -= dt) > 0) return [];
    this.wait = FOG_TUNING.every;
    const discs = new Map();
    const W = Math.max(0, FOG_TUNING.dither);
    this.makeJitter();
    if (!this.ground) {
      this.ground = new Uint8Array(SIZE[0] * SIZE[2]);
      this.relief([0, 0, 0], SIZE);
    }
    const bonus = Math.max(0, FOG_TUNING.lowMax) * (FOG_TUNING.lowGain > 0 ? 1 : 0);
    const add = (team, x, z, r, h) => {
      if (!discs.has(team)) discs.set(team, []);
      // (and the furthest it can reach: ragged, and over lower ground)
      discs.get(team).push([x, z, r, r + W / 2 + Math.min(bonus, Math.max(0, FOG_TUNING.lowGain) * h), h]);
    };
    for (const u of units) if (!u.dying) add(u.team, u.pos[0], u.pos[2], sight(u), Math.round(u.pos[1]));
    for (const b of buildings) {
      if (!b.fogDisc) {
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, y1 = 0;
        for (const [x, y, z] of b.plan.blocks) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x + 1); z1 = Math.max(z1, z + 1); y1 = Math.max(y1, y + 1); }
        b.fogDisc = [(x0 + x1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2, y1];
      }
      add(b.team, b.fogDisc[0], b.fogDisc[1], b.fogDisc[2] + buildingSight(b), b.fogDisc[3]);
    }
    this.team(this.player);
    for (const name of discs.keys()) this.team(name);
    for (const [name, t] of this.teams) {
      const next = discs.get(name) ?? [];
      const player = name === this.player;
      let z0 = Infinity, z1 = -Infinity;
      for (const [x, z, , r] of t.discs) { this.stamp(t.state, x, z, r, SEEN, false); z0 = Math.min(z0, z - r); z1 = Math.max(z1, z + r); }
      for (const [x, z, r, reach, h] of next) { this.stamp(t.state, x, z, reach, VISIBLE, player, r, W, h); z0 = Math.min(z0, z - reach); z1 = Math.max(z1, z + reach); }
      t.discs = next;
      if (player && z1 >= z0) {
        const a = Math.max(0, Math.floor(z0) - 1), b = Math.min(SIZE[2], Math.ceil(z1) + 2);
        this.rows = this.rows ? [Math.min(this.rows[0], a), Math.max(this.rows[1], b)] : [a, b];
        this.onRows?.(a, b);
      }
    }
    for (const b of buildings) if (!this.hidden(b.fogDisc[0], b.fogDisc[1])) b.seen = true;
    // What's near what the player sees, past the furthest the cut reaches into the never seen.
    const M = Math.ceil(Math.max(0.5, FOG_TUNING.edge)) + 2;
    for (const [x, z, , reach] of this.team(this.player).discs) this.nearStamp(x, z, reach + M);
    const out = this.flush(false);
    // The tiles with columns newly near go up again, as they are now (see TerrainField.blank).
    const [X, Y, Z] = SIZE, across = Math.ceil(X / TILE);
    for (const k of this.revealed) {
      const x0 = (k % across) * TILE, z0 = Math.floor(k / across) * TILE;
      out.push({ lo: [x0, 0, z0], hi: [Math.min(X, x0 + TILE), Y, Math.min(Z, z0 + TILE)] });
    }
    this.revealed.clear();
    return out;
  }

  // Disc of radius r round (cx, cz) marked near (each tile with a column newly near is revealed).
  nearStamp(cx, cz, r) {
    const [X, , Z] = SIZE, r2 = r * r, n = this.near, across = Math.ceil(X / TILE);
    const za = Math.max(0, Math.ceil(cz - r - 0.5)), zb = Math.min(Z - 1, Math.floor(cz + r - 0.5));
    for (let z = za; z <= zb; z++) {
      const dz = z + 0.5 - cz, half = Math.sqrt(Math.max(0, r2 - dz * dz));
      const xa = Math.max(0, Math.ceil(cx - half - 0.5)), xb = Math.min(X - 1, Math.floor(cx + half - 0.5));
      const row = z * X;
      for (let i = row + xa; i <= row + xb; i++) {
        if (n[i]) continue;
        n[i] = 1;
        this.revealed.add(Math.floor((i - row) / TILE) + Math.floor(z / TILE) * across);
      }
    }
  }

  // Whether column (x, z) isn't drawn at all (not near anything the player's seen; false while it's off).
  blankAt(x, z) {
    if (!this.on) return false;
    const xi = Math.floor(x), zi = Math.floor(z);
    if (xi < 0 || zi < 0 || xi >= SIZE[0] || zi >= SIZE[2]) return true;
    return this.near[xi + zi * SIZE[0]] === 0;
  }

  // Whether the player (or team) has never seen column (x, z) (false while it's off).
  never(x, z, team = this.player) {
    if (!this.on) return false;
    const xi = Math.floor(x), zi = Math.floor(z);
    if (xi < 0 || zi < 0 || xi >= SIZE[0] || zi >= SIZE[2]) return true;
    return this.team(team).state[xi + zi * SIZE[0]] === NEVER;
  }

  // The view switched to another team's (a test key, see main.js): its fog from now on. Every held-back edit is shown
  // first (returned as boxes, as flush), and what's near what it's seen worked out again; everything goes up again.
  setPlayer(team) {
    if (team === this.player) return [];
    const out = this.flush(true), [X, , Z] = SIZE;
    this.player = team;
    if (!this.on) return out;
    const st = this.team(team).state, M = Math.ceil(Math.max(0.5, FOG_TUNING.edge)) + 2;
    this.unseen = 0;
    for (let i = 0; i < st.length; i++) if (st[i] === NEVER) this.unseen++;
    // Near: within M of a column it's seen (rows, then columns, of a square that size).
    const rows = new Uint8Array(X * Z);
    for (let z = 0; z < Z; z++) {
      let last = -Infinity;
      for (let x = 0; x < X; x++) if (st[x + z * X] !== NEVER) last = x; else if (x - last <= M) rows[x + z * X] = 1;
      last = Infinity;
      for (let x = X - 1; x >= 0; x--) if (st[x + z * X] !== NEVER) { last = x; rows[x + z * X] = 1; } else if (last - x <= M) rows[x + z * X] = 1;
    }
    this.near.fill(0);
    for (let x = 0; x < X; x++) {
      let last = -Infinity;
      for (let z = 0; z < Z; z++) if (rows[x + z * X]) { last = z; this.near[x + z * X] = 1; } else if (z - last <= M) this.near[x + z * X] = 1;
      last = Infinity;
      for (let z = Z - 1; z >= 0; z--) if (rows[x + z * X]) last = z; else if (last - z <= M) this.near[x + z * X] = 1;
    }
    this.revealed.clear();
    this.rows = [0, Z];
    this.onRows?.(0, Z);
    return out;
  }

  // Each column's share (0-1) of FOG_TUNING.dither its sight edge comes in by: a hash (speckled) mixed with value
  // noise a few voxels across (wavy), made again when the speckle changes.
  makeJitter() {
    const k = FOG_TUNING.speckle;
    if (this.jitter && this.jitterLook === k) return;
    const [X, , Z] = SIZE, j = this.jitter ?? new Float32Array(X * Z);
    const hash = (x, z) => {
      let h = Math.imul(x, 374761393) + Math.imul(z, 668265263);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const S = 5; // voxels across a wave
    const smooth = (x, z) => {
      const fx = x / S, fz = z / S, ix = Math.floor(fx), iz = Math.floor(fz);
      let u = fx - ix, v = fz - iz;
      u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
      const a = hash(ix + 7919, iz), b = hash(ix + 7920, iz), c = hash(ix + 7919, iz + 1), d = hash(ix + 7920, iz + 1);
      return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
    };
    for (let z = 0; z < Z; z++) for (let x = 0; x < X; x++) j[x + z * X] = hash(x, z) * k + smooth(x, z) * (1 - k);
    this.jitter = j;
    this.jitterLook = k;
  }

  // Disc of radius r round (cx, cz): VISIBLE (counting never-seen columns going, for the player), or back to SEEN
  // where it's VISIBLE. VISIBLE: r is the furthest it reaches, and each column's in it within sight + W × (0.5 - its
  // jitter), so the edge is ragged.
  stamp(state, cx, cz, r, value, count, sight = r, W = 0, h = -1) {
    const [X, , Z] = SIZE, r2 = r * r, j = this.jitter, g = this.ground, T = FOG_TUNING;
    const gain = Math.max(0, T.lowGain), most = Math.max(0, T.lowMax), loss = Math.max(0, T.highLoss);
    const each = W > 0 || (h >= 0 && g && (gain > 0 || loss > 0)); // (a limit per column)
    const za = Math.max(0, Math.ceil(cz - r - 0.5)), zb = Math.min(Z - 1, Math.floor(cz + r - 0.5));
    for (let z = za; z <= zb; z++) {
      const dz = z + 0.5 - cz, half = Math.sqrt(Math.max(0, r2 - dz * dz));
      const xa = Math.max(0, Math.ceil(cx - half - 0.5)), xb = Math.min(X - 1, Math.floor(cx + half - 0.5));
      const row = z * X;
      if (value === SEEN) {
        for (let i = row + xa; i <= row + xb; i++) if (state[i] === VISIBLE) state[i] = SEEN;
      } else {
        for (let i = row + xa; i <= row + xb; i++) {
          if (each) {
            let lim = sight + W * (0.5 - j[i]);
            if (h >= 0 && g) { const d = h - g[i]; lim += d > 0 ? Math.min(most, gain * d) : loss * d; }
            const dx = i - row + 0.5 - cx;
            if (lim < 0 || dx * dx + dz * dz > lim * lim) continue;
          }
          if (count && state[i] === NEVER) {
            this.unseen--;
            // (bare till now; and so are the leaves of a tree here, up to 2 columns off, see TerrainField.seen)
            const x = i - row, across = Math.ceil(X / TILE);
            for (const [ox, oz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
              const tx = Math.min(X - 1, Math.max(0, x + ox)), tz = Math.min(Z - 1, Math.max(0, z + oz));
              this.revealed.add(Math.floor(tx / TILE) + Math.floor(tz / TILE) * across);
            }
          }
          state[i] = VISIBLE;
        }
      }
    }
  }

  // Each column's height in [lo, hi) read again (the top of its highest voxel that isn't leaves or a log; 0 for none),
  // from this.terrain.
  relief(lo, hi) {
    const [X, Y, Z] = SIZE, v = this.terrain.voxels, g = this.ground;
    const x0 = Math.max(0, lo[0]), x1 = Math.min(X, hi[0]), z0 = Math.max(0, lo[2]), z1 = Math.min(Z, hi[2]);
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        let y = Y - 1;
        while (y >= 0 && v[x + X * (y + Y * z)] < BLOCK.PLANK) y--;
        g[x + X * z] = y + 1;
      }
    }
  }

  // An edit changed voxels in [lo, hi): the parts of it to show now, [{ lo, hi }] (all of it while the fog's off or
  // the player sees all of it); the rest is held back per tile until the player sees the tile's middle.
  defer(lo, hi) {
    if (!this.on) return [{ lo, hi }];
    if (this.ground) this.relief(lo, hi);
    const [X, , Z] = SIZE, st = this.team(this.player).state;
    const x0 = Math.max(0, lo[0]), x1 = Math.min(X, hi[0]), z0 = Math.max(0, lo[2]), z1 = Math.min(Z, hi[2]);
    const seen = (a, b, c, d) => {
      for (let z = c; z < d; z++) for (let x = a; x < b; x++) if (st[x + z * X] !== VISIBLE) return false;
      return true;
    };
    if (seen(x0, x1, z0, z1)) return [{ lo, hi }];
    const out = [], across = Math.ceil(X / TILE);
    for (let tz = Math.floor(z0 / TILE); tz * TILE < z1; tz++) {
      for (let tx = Math.floor(x0 / TILE); tx * TILE < x1; tx++) {
        const a = Math.max(x0, tx * TILE), b = Math.min(x1, (tx + 1) * TILE), c = Math.max(z0, tz * TILE), d = Math.min(z1, (tz + 1) * TILE);
        if (seen(a, b, c, d)) { out.push({ lo: [a, lo[1], c], hi: [b, hi[1], d] }); continue; }
        const k = tx + tz * across, s = this.stale.get(k);
        this.stale.set(k, s ? [Math.min(s[0], lo[1]), Math.max(s[1], hi[1])] : [lo[1], hi[1]]);
      }
    }
    return out;
  }

  // The held-back edits whose tile's middle the player sees now (all of them: everything), as boxes to show.
  flush(all) {
    if (!this.stale.size) return [];
    const [X, , Z] = SIZE, across = Math.ceil(X / TILE), out = [];
    const st = this.on ? this.team(this.player).state : null;
    for (const [k, [y0, y1]] of this.stale) {
      const tx = k % across, tz = Math.floor(k / across);
      const x0 = tx * TILE, z0 = tz * TILE, x1 = Math.min(X, x0 + TILE), z1 = Math.min(Z, z0 + TILE);
      const mid = Math.floor((x0 + x1) / 2) + Math.floor((z0 + z1) / 2) * X;
      if (!all && st && st[mid] !== VISIBLE) continue;
      this.stale.delete(k);
      out.push({ lo: [x0, y0, z0], hi: [x1, y1, z1] });
    }
    return out;
  }

  // The fog pass: over the frame so far (after the water), reading the depth buffer and a copy of the frame. frame:
  // { invViewProj, pixAng (a pixel's angle, for the sky; 0 orthographic) }.
  draw(encoder, canvasTexture, colorView, depthTexture, frame, profiler) {
    if (!this.on) return;
    const T = FOG_TUNING, [X, , Z] = SIZE, dev = this.device;
    if (this.rows) {
      const [z0, z1] = this.rows;
      this.rows = null;
      const st = this.team(this.player).state;
      if (z1 > z0) dev.queue.writeTexture({ texture: this.stateTex, origin: [0, z0] }, st, { offset: z0 * X, bytesPerRow: X }, [X, z1 - z0]);
      this.blurNeeded = true;
    }
    const edge = Math.max(0.5, T.edge);
    const seenEdge = Math.max(0.5, T.seenEdge);
    const radius = Math.min(16, Math.ceil(Math.max(edge, seenEdge) * 1.5));
    const key = `${edge},${seenEdge}`;
    if (this.blurNeeded || key !== this.blurKey) {
      this.blurNeeded = false;
      this.blurKey = key;
      dev.queue.writeBuffer(this.blurU[0], 0, new Float32Array([radius, edge * 0.6, 0, seenEdge * 0.6]));
      dev.queue.writeBuffer(this.blurU[1], 0, new Float32Array([radius, edge * 0.6, 1, seenEdge * 0.6]));
      const pass = encoder.beginComputePass({ label: 'fog blur', timestampWrites: profiler?.tsw('fog of war: blur') });
      pass.setPipeline(this.blurPipe);
      for (const g of this.blurGroups) {
        pass.setBindGroup(0, g);
        pass.dispatchWorkgroups(Math.ceil(X / 8), Math.ceil(Z / 8));
      }
      pass.end();
    }
    const seen = T.seenDark > 0 || T.seenDesat > 0;
    if (this.unseen <= 0 && !seen) return; // (nothing left unseen, and remembered land isn't changed)
    const { width: w, height: h } = depthTexture;
    if (this.depthTexture !== depthTexture || this.scene?.width !== w || this.scene?.height !== h) {
      this.depthTexture = depthTexture;
      this.scene?.destroy();
      this.scene = dev.createTexture({
        label: 'fog: frame', size: [w, h], format: this.format.replace('-srgb', ''), viewFormats: [this.format],
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.group = dev.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniforms } },
          { binding: 1, resource: depthTexture.createView() },
          { binding: 2, resource: this.fogTex.createView() },
          { binding: 3, resource: this.samp },
          { binding: 4, resource: this.scene.createView({ format: this.format }) },
        ],
      });
    }
    if (seen) encoder.copyTextureToTexture({ texture: canvasTexture }, { texture: this.scene }, [w, h]);
    const d = this.data, clamp01 = (v) => Math.max(0, Math.min(1, v));
    d.set(frame.invViewProj, 0);
    d.set([w, h, 1 / w, 1 / h], 16);
    d.set([X, Z, clamp01(T.seenDark), clamp01(T.seenDesat)], 20);
    d.set([...linearColor(T.voidColor), clamp01(T.voidMix)], 24);
    d.set([frame.pixAng ?? 0, Math.max(0.001, Math.min(0.5, T.feather)), Math.max(0.001, Math.min(0.5, T.seenFeather)), 0], 28);
    dev.queue.writeBuffer(this.uniforms, 0, d);
    const pass = encoder.beginRenderPass({
      label: 'fog of war',
      colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }],
      timestampWrites: profiler?.tsw('fog of war'),
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.setBindGroup(1, this.sky.group);
    pass.draw(3);
    pass.end();
  }
}
