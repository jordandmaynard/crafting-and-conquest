// Water: an FFT ocean (Tessendorf) filling the map up to WATER_LEVEL, ported from Maksymilian Dendura's web-ocean
// (https://github.com/Noniv/web-ocean, MIT licence: see LICENSES/web-ocean.txt).
//
// From web-ocean, mostly as written: the wave spectrum (fetch-limited JONSWAP wind sea with Donelan-Banner spreading,
// plus a narrow swell), its evolution, the radix-2 FFTs that turn it into displacement / slope / Jacobian textures,
// their mips, the procedural foam texture, Jacobian foam that builds up and decays in a world-space map, and the
// surface shading: LEAN slope statistics for sun glitter, Fresnel sky reflection, body scatter, backlit crests and
// foam. Also its CDLOD grid mesh, here clipped to the map.
//
// Changed for this game: four cascades sized for a 500 m map with a calmer, lake-sized sea; the foam map is one fixed
// level covering the map instead of camera-centred clipmaps; the sky, sun and environment cube are sky.js's (shared
// with the terrain), and there's no bloom. And the water is see-through: it reads the
// terrain's G-buffer and the frame drawn so far, so shallows show the ground under them (bent a little by the
// waves, and tinted by depth), shores get a line of foam, and the map's sides show the water's cross-section.

import { SIZE, WATER_LEVEL, SOLID_MIN } from './terrain.js';
import { skyWgsl } from './sky.js';

const N = 256;          // FFT resolution per cascade
const LOGN = 8;
const CASCADES = 4;
const CASC_L = [331.0, 62.3, 11.71, 2.203]; // patch size of each cascade, metres (= voxels)
const FOAM_SIZE = 2 ** Math.ceil(Math.log2(Math.max(SIZE[0], SIZE[2]))); // metres the foam map covers (the map, rounded up)
const FOAM_RES = Math.min(2048, FOAM_SIZE * 2); // foam map texels across FOAM_SIZE
const FOAM_TEX = 512;   // procedural foam pattern texture
const LOOP = 600.0;     // s, the spectrum's time loop (frequencies are quantised to it)
const D2R = Math.PI / 180;

export const WATER_TUNING = {
  windSpeed: 6.0,      // m/s at 10 m
  windDir: 118,        // degrees, direction the waves travel
  fetchKm: 6,          // a lake, not an ocean
  windHeight: 1,       // wind sea height, times the spectrum's own
  windFreq: 1,         // wind sea peak frequency, times the spectrum's own (higher = shorter waves)
  gamma: 3.3,          // JONSWAP peak enhancement: how much the waves are of one size
  swellHs: 0.35,       // m significant height
  swellDir: 94,
  swellLength: 36,     // m peak wavelength
  swellSpread: 24,     // cos^2s exponent
  choppy: 1.0,
  speed: 1,            // how fast the waves go by (1 = real time)
  ripples: 0.75,       // height of the finest cascade (it otherwise reads as crumpled foil)
  shortCut: 1.2,       // mm: waves shorter than about this are damped
  gusts: 1,            // wind gusts ("cat's paws"): patches of stronger and calmer ripples
  turbidity: 1.6,      // brightness of the water body (sediment / plankton)
  foam: 1.0,
  absorb: [0.42, 0.13, 0.09], // per metre: how fast the water hides what's under it (red goes first)
  refraction: 0.35,    // how far the waves bend the view of the bottom
  clarity: 1,          // divides absorb: higher sees deeper
  foamFade: 0.22,      // per second, how fast foam on open water fades
  shoreFoam: 0.6,      // the foam line along the shore
  sss: 2.6,            // sunlight through the backlit crests
};

// The settings that shape the wave spectrum: changing one regenerates it.
const SPECTRUM_KEYS = ['windSpeed', 'windDir', 'fetchKm', 'windHeight', 'windFreq', 'gamma', 'swellHs', 'swellDir',
  'swellLength', 'swellSpread', 'ripples', 'shortCut'];

// Grid mesh: CDLOD quadtree over the map; finest nodes are LEAF metres across with GRID² quads.
const GRID = 32;
const LEAF = 4.0;
const R0 = 8 * LEAF;
const LODS = 1 + Math.ceil(Math.log2(Math.max(SIZE[0], SIZE[2]) / LEAF)); // the root, LEAF * 2^(LODS - 1), covers the map
const MAX_NODES = 2048;
const HB = 2.0;         // vertical bound of the displaced surface around WATER_LEVEL
const XB = 2.0;         // horizontal displacement margin for culling
const PANEL_SEG = 250;  // segments along each side of the map for the water's cross-section

const DIMS_WGSL = `const DIMS = vec3f(${SIZE[0]}, ${SIZE[1]}, ${SIZE[2]});`;

const NOISE_WGSL = /* wgsl */ `
fn pcgHash(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn hashGrad(i: vec2i) -> vec2f {
  let h = pcgHash(u32(i.x) * 1664525u + pcgHash(u32(i.y) + 1013904223u));
  let a = f32(h) * (6.28318530718 / 4294967296.0);
  return vec2f(cos(a), sin(a));
}
`;

// Periodic (tileable) noise for the foam texture.
const PERIODIC_WGSL = /* wgsl */ `
fn pnoise(p: vec2f, period: i32) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let i00 = (i % period + period) % period;
  let i10 = ((i + vec2i(1, 0)) % period + period) % period;
  let i01 = ((i + vec2i(0, 1)) % period + period) % period;
  let i11 = ((i + vec2i(1, 1)) % period + period) % period;
  let a = dot(hashGrad(i00), f);
  let b = dot(hashGrad(i10), f - vec2f(1.0, 0.0));
  let c = dot(hashGrad(i01), f - vec2f(0.0, 1.0));
  let d = dot(hashGrad(i11), f - vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn pfbm(p: vec2f, period: i32, oct: i32) -> f32 {
  var s = 0.0; var a = 0.5; var q = p; var per = period;
  for (var o = 0; o < oct; o++) {
    s += a * pnoise(q, per);
    q *= 2.0; per *= 2; a *= 0.5;
  }
  return s;
}
`;

// ---- Simulation (web-ocean's sim.js) --------------------------------------------------------------------------

const SIM_STRUCT = /* wgsl */ `
const N: u32 = ${N}u;
const LOGN: u32 = ${LOGN}u;
const PI: f32 = 3.14159265358979;
const GRAV: f32 = 9.81;
const SURF: f32 = 7.4e-5;   // surface tension / density

struct Sim {
  L:          array<vec4f, 2>,  // patch size per cascade ([c>>2][c&3])
  kMin:       array<vec4f, 2>,
  kMax:       array<vec4f, 2>,
  wind:       vec4f,  // U10 m/s, direction rad, fetch m, gamma
  swell:      vec4f,  // Hs m, direction rad, peak omega, spreading exponent
  misc:       vec4f,  // choppiness, short wave cut (m), loop period s, seed
  timeP:      vec4f,  // time (looped), dt, -, spectrum gain
  waves:      vec4f,  // wind sea gain (height^2), wind sea peak frequency scale, finest cascade height, -
};
@group(0) @binding(0) var<uniform> S: Sim;

fn waveVec(x: u32, y: u32, L: f32) -> vec2f {
  let nx = select(i32(x), i32(x) - i32(N), x >= N / 2u);
  let ny = select(i32(y), i32(y) - i32(N), y >= N / 2u);
  return vec2f(f32(nx), f32(ny)) * (2.0 * PI / L);
}
fn omegaOf(k: f32) -> f32 { return sqrt(GRAV * k + SURF * k * k * k); }
fn dOmegaOf(k: f32) -> f32 { return (GRAV + 3.0 * SURF * k * k) / (2.0 * omegaOf(k)); }
fn cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn mulI(a: vec2f) -> vec2f { return vec2f(-a.y, a.x); }
`;

const SIM_INIT = SIM_STRUCT + NOISE_WGSL + /* wgsl */ `
@group(0) @binding(1) var<storage, read_write> h0: array<vec4f>;

fn rand01(s: u32) -> f32 { return (f32(pcgHash(s) >> 8u) + 0.5) / 16777216.0; }
fn gauss2(seed: u32) -> vec2f {
  let u1 = rand01(seed * 2u + 17u);
  let u2 = rand01(seed * 2u + 18u + pcgHash(seed));
  let r = sqrt(-2.0 * log(u1));
  let a = 2.0 * PI * u2;
  return r * vec2f(cos(a), sin(a));
}
fn wrapAngle(a: f32) -> f32 {
  var x = a;
  x = x - 2.0 * PI * floor((x + PI) / (2.0 * PI));
  return x;
}
fn jonswap(w: f32, wp: f32, alpha: f32, gamma: f32) -> f32 {
  let sigma = select(0.09, 0.07, w <= wp);
  let d = (w - wp) / (sigma * wp);
  let r = exp(-0.5 * d * d);
  let q = wp / w;
  let q2 = q * q;
  return alpha * GRAV * GRAV / (w * w * w * w * w) * exp(-1.25 * q2 * q2) * pow(gamma, r);
}
// Donelan-Banner directional spreading (normalised over [-pi, pi])
fn donelanBanner(theta: f32, w: f32, wp: f32) -> f32 {
  let ratio = w / wp;
  var beta: f32;
  if (ratio < 0.95) {
    beta = 2.61 * pow(ratio, 1.3);
  } else if (ratio < 1.6) {
    beta = 2.28 * pow(ratio, -1.3);
  } else {
    let eps = -0.4 + 0.8393 * exp(-0.567 * log(ratio * ratio));
    beta = pow(10.0, eps);
  }
  let sh = 1.0 / cosh(clamp(beta * theta, -20.0, 20.0));
  return beta / (2.0 * tanh(beta * PI)) * sh * sh;
}
// cos^2s(theta/2) spreading, normalised
fn cosSpread(theta: f32, s: f32) -> f32 {
  let q = sqrt(s + 0.25) / (2.0 * sqrt(PI));
  return q * pow(abs(cos(theta * 0.5)), 2.0 * s);
}

fn spectrum(k: vec2f) -> f32 {
  let kl = length(k);
  let w = omegaOf(kl);
  let theta = atan2(k.y, k.x);
  // fetch-limited wind sea (JONSWAP)
  let U = S.wind.x;
  let F = S.wind.z;
  var Sw = 0.0;
  if (U > 0.1) {
    let alpha = 0.076 * pow(U * U / (F * GRAV), 0.22);
    let wp = 22.0 * pow(GRAV * GRAV / (U * F), 1.0 / 3.0) * S.waves.y;
    Sw = jonswap(w, wp, alpha, S.wind.w) * donelanBanner(wrapAngle(theta - S.wind.y), w, wp) * S.waves.x;
  }
  // swell: narrow, long-crested JONSWAP
  if (S.swell.x > 0.001) {
    let ws = S.swell.z;
    let gs = 6.0;
    let hs4 = S.swell.x * 0.25;
    let alphaS = hs4 * hs4 * 5.0 * ws * ws * ws * ws / (GRAV * GRAV) * (1.0 - 0.287 * log(gs));
    Sw += jonswap(w, ws, alphaS, gs) * cosSpread(wrapAngle(theta - S.swell.y), S.swell.w);
  }
  // damp the very shortest waves
  let sc = S.misc.y;
  Sw *= exp(-kl * kl * sc * sc);
  return Sw * dOmegaOf(kl) / kl * S.timeP.w;
}

fn amplitude(k: vec2f, c: u32) -> f32 {
  let kl = length(k);
  if (kl < 1e-5 || kl < S.kMin[c >> 2u][c & 3u] || kl >= S.kMax[c >> 2u][c & 3u]) { return 0.0; }
  let dk = 2.0 * PI / S.L[c >> 2u][c & 3u];
  // the finest cascade is toned down (it otherwise reads as crumpled foil)
  let g = select(1.0, S.waves.z, c == ${CASCADES - 1}u);
  return sqrt(max(spectrum(k), 0.0)) * dk * 0.5 * g;
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = id.z;
  let L = S.L[c >> 2u][c & 3u];
  let k = waveVec(id.x, id.y, L);
  let mx = (N - id.x) % N;
  let my = (N - id.y) % N;
  let seed = u32(S.misc.w) * 7919u + c * 1000003u;
  let a = gauss2(seed + (id.y * N + id.x)) * amplitude(k, c);
  let b = gauss2(seed + (my * N + mx)) * amplitude(-k, c);
  h0[(c * N + id.y) * N + id.x] = vec4f(a, b.x, -b.y);
}
`;

const SIM_EVOLVE = SIM_STRUCT + /* wgsl */ `
@group(0) @binding(1) var<storage, read> h0: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> specA: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> specB: array<vec4f>;

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = id.z;
  let idx = (c * N + id.y) * N + id.x;
  let k = waveVec(id.x, id.y, S.L[c >> 2u][c & 3u]);
  let kl = length(k);
  if (kl < 1e-5) {
    specA[idx] = vec4f(0.0);
    specB[idx] = vec4f(0.0);
    return;
  }
  let w0 = 2.0 * PI / S.misc.z;
  let w = floor(omegaOf(kl) / w0) * w0;
  let ph = w * S.timeP.x;
  let e = vec2f(cos(ph), sin(ph));
  let H0 = h0[idx];
  // h0(k) travels along +k: h(k,t) = h0(k) e^{-iwt} + conj(h0(-k)) e^{iwt}
  let h = cmul(H0.xy, vec2f(e.x, -e.y)) + cmul(H0.zw, e);
  let ih = mulI(h);
  let lam = S.misc.x;
  let ik = 1.0 / kl;
  let Dx = ih * (lam * k.x * ik);
  let Dz = ih * (lam * k.y * ik);
  let jxz = h * (-lam * k.x * k.y * ik);
  let sx = ih * k.x;
  let sz = ih * k.y;
  let jxx = h * (-lam * k.x * k.x * ik);
  let jzz = h * (-lam * k.y * k.y * ik);
  specA[idx] = vec4f(Dx + mulI(Dz), h + mulI(jxz));
  specB[idx] = vec4f(sx + mulI(sz), jxx + mulI(jzz));
}
`;

const FFT_CORE = /* wgsl */ `
const N: u32 = ${N}u;
const LOGN: u32 = ${LOGN}u;
const PI: f32 = 3.14159265358979;
var<workgroup> wa: array<vec4f, ${N}>;
var<workgroup> wb: array<vec4f, ${N}>;
fn cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn bitrev(i: u32) -> u32 { return reverseBits(i) >> (32u - LOGN); }
// In-place radix-2 inverse FFT over shared memory (input already bit-reversed).
fn butterflies(t: u32) {
  for (var s = 0u; s < LOGN; s++) {
    let half = 1u << s;
    let pos = t & (half - 1u);
    let i0 = ((t >> s) << (s + 1u)) + pos;
    let i1 = i0 + half;
    let ang = PI * f32(pos) / f32(half);
    let w = vec2f(cos(ang), sin(ang));
    let a0 = wa[i0]; let a1 = wa[i1];
    let b0 = wb[i0]; let b1 = wb[i1];
    let ta = vec4f(cmul(a1.xy, w), cmul(a1.zw, w));
    let tb = vec4f(cmul(b1.xy, w), cmul(b1.zw, w));
    wa[i0] = a0 + ta; wa[i1] = a0 - ta;
    wb[i0] = b0 + tb; wb[i1] = b0 - tb;
    workgroupBarrier();
  }
}
`;

const FFT_ROWS = FFT_CORE + /* wgsl */ `
@group(0) @binding(0) var<storage, read> inA: array<vec4f>;
@group(0) @binding(1) var<storage, read> inB: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> outA: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> outB: array<vec4f>;

@compute @workgroup_size(${N / 2})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) t: u32) {
  let base = (wg.z * N + wg.x) * N;
  let e0 = t;
  let e1 = t + N / 2u;
  wa[bitrev(e0)] = inA[base + e0];
  wa[bitrev(e1)] = inA[base + e1];
  wb[bitrev(e0)] = inB[base + e0];
  wb[bitrev(e1)] = inB[base + e1];
  workgroupBarrier();
  butterflies(t);
  outA[base + e0] = wa[e0];
  outA[base + e1] = wa[e1];
  outB[base + e0] = wb[e0];
  outB[base + e1] = wb[e1];
}
`;

// Column pass + final assembly (displacement / derivative / slope-moment textures).
const FFT_COLS = FFT_CORE + /* wgsl */ `
@group(0) @binding(0) var<storage, read> inA: array<vec4f>;
@group(0) @binding(1) var<storage, read> inB: array<vec4f>;
@group(0) @binding(2) var dispOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var derivOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(4) var momOut: texture_storage_2d_array<rgba16float, write>;

fn emit(x: u32, y: u32, c: u32, a: vec4f, b: vec4f) {
  // a = (Dx, Dz, Dy, jxz), b = (sx, sz, jxx, jzz)
  let p = vec2u(x, y);
  textureStore(dispOut, p, c, vec4f(a.x, a.z, a.y, a.w));
  textureStore(derivOut, p, c, b);
  textureStore(momOut, p, c, vec4f(b.x * b.x, b.y * b.y, b.x * b.y, 0.0));
}

@compute @workgroup_size(${N / 2})
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_index) t: u32) {
  let x = wg.x;
  let c = wg.z;
  let e0 = t;
  let e1 = t + N / 2u;
  let i0 = (c * N + e0) * N + x;
  let i1 = (c * N + e1) * N + x;
  wa[bitrev(e0)] = inA[i0];
  wa[bitrev(e1)] = inA[i1];
  wb[bitrev(e0)] = inB[i0];
  wb[bitrev(e1)] = inB[i1];
  workgroupBarrier();
  butterflies(t);
  emit(x, e0, c, wa[e0], wb[e0]);
  emit(x, e1, c, wa[e1], wb[e1]);
}
`;

// Box-filter mip generation for the three simulation textures (array of cascades).
const SIM_MIPS = /* wgsl */ `
@group(0) @binding(0) var srcA: texture_2d_array<f32>;
@group(0) @binding(1) var srcB: texture_2d_array<f32>;
@group(0) @binding(2) var srcC: texture_2d_array<f32>;
@group(0) @binding(3) var dstA: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(4) var dstB: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(5) var dstC: texture_storage_2d_array<rgba16float, write>;

fn box(t: texture_2d_array<f32>, p: vec2i, l: u32) -> vec4f {
  return 0.25 * (textureLoad(t, p, l, 0) + textureLoad(t, p + vec2i(1, 0), l, 0) +
                 textureLoad(t, p + vec2i(0, 1), l, 0) + textureLoad(t, p + vec2i(1, 1), l, 0));
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dstA);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy) * 2;
  textureStore(dstA, id.xy, id.z, box(srcA, p, id.z));
  textureStore(dstB, id.xy, id.z, box(srcB, p, id.z));
  textureStore(dstC, id.xy, id.z, box(srcC, p, id.z));
}
`;

// Tileable foam micro-structure: R = bubble lace (multi-scale Worley edges),
// G = finer lace, B = soft fbm density, A = streak noise.
const FOAM_PATTERN = NOISE_WGSL + PERIODIC_WGSL + /* wgsl */ `
@group(0) @binding(0) var dst: texture_storage_2d<rgba8unorm, write>;
const SIZE: f32 = ${FOAM_TEX}.0;

fn h2(i: vec2i, salt: u32) -> vec2f {
  let h = pcgHash((u32(i.x) * 73856093u) ^ pcgHash(u32(i.y) * 19349663u + salt));
  let h2v = pcgHash(h + 0x9e3779b9u);
  return vec2f(f32(h >> 8u), f32(h2v >> 8u)) / 16777216.0;
}
// "swiss cheese" foam: 1 in foam material, 0 inside bubbles; per-bubble radius
fn bubbles(uv: vec2f, period: i32, salt: u32, rmin: f32, rmax: f32) -> f32 {
  let w = vec2f(pfbm(uv * f32(period) * 0.5, period / 2, 3), pfbm(uv * f32(period) * 0.5 + 17.0, period / 2, 3));
  let p = uv * f32(period) + w * 0.9;
  let ip = vec2i(floor(p));
  let fp = p - floor(p);
  var v = 9.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let o = vec2i(i, j);
      let cell = ((ip + o) % period + period) % period;
      let hh = h2(cell, salt);
      let r = vec2f(o) + hh * 0.9 + 0.05 - fp;
      let rad = mix(rmin, rmax, h2(cell, salt + 7u).x);
      v = min(v, length(r) / rad);
    }
  }
  return smoothstep(0.8, 1.25, v);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let uv = (vec2f(id.xy) + 0.5) / SIZE;
  // irregular holes from warped fbm (big sheets with ragged openings) ...
  let w1 = vec2f(pfbm(uv * 5.0, 5, 3), pfbm(uv * 5.0 + vec2f(3.7, 9.1), 5, 3));
  let m1 = smoothstep(-0.14, 0.06, pfbm(uv * 10.0 + w1 * 1.4, 10, 5));
  let w2 = vec2f(pfbm(uv * 12.0 + 1.3, 12, 2), pfbm(uv * 12.0 + 7.9, 12, 2));
  let m2 = smoothstep(-0.16, 0.04, pfbm(uv * 27.0 + w2 * 0.9, 27, 4));
  // ... plus small round bubbles
  let b3 = bubbles(uv, 29, 37u, 0.06, 0.45);
  let b4 = bubbles(uv, 61, 53u, 0.05, 0.42);
  let dens = pfbm(uv * 4.0, 4, 5) * 0.5 + 0.5;
  let fineD = pfbm(uv * 16.0, 16, 3) * 0.5 + 0.5;
  let big = m1 * (0.55 + 0.45 * m2) * (0.75 + 0.25 * b3);
  let fine = 0.45 + 0.55 * b3 * (0.7 + 0.3 * b4);
  let streak = pfbm(uv * vec2f(4.0, 16.0), 4, 5) * 0.5 + 0.5;
  textureStore(dst, id.xy, vec4f(clamp(big * 0.6 + dens * 0.4, 0.0, 1.0), clamp(fine * 0.8 + fineD * 0.2, 0.0, 1.0), dens, streak));
}
`;

const MIPS_2D = (format) => /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<${format}, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let p = vec2i(id.xy) * 2;
  let v = 0.25 * (textureLoad(src, p, 0) + textureLoad(src, p + vec2i(1, 0), 0) +
                  textureLoad(src, p + vec2i(0, 1), 0) + textureLoad(src, p + vec2i(1, 1), 0));
  textureStore(dst, id.xy, v);
}
`;

// Foam map over the whole water (web-ocean's clipmap update, with one fixed level). Foam is injected where the
// total surface Jacobian (all cascades) folds, then drifts downwind and decays.
const FOAM_UPDATE = /* wgsl */ `
const RES: i32 = ${FOAM_RES};
struct FoamU {
  p0: vec4f,                 // texel size, dt, decay rate, -
  p1: vec4f,                 // J threshold, gain, growth, -
  cascL: array<vec4f, 2>,
  cascInvL: array<vec4f, 2>,
  drift: vec4f,              // foam drift velocity (m/s) xz
};
@group(0) @binding(0) var<uniform> U: FoamU;
@group(0) @binding(1) var prevTex: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var dispTex: texture_2d_array<f32>;
@group(0) @binding(4) var derivTex: texture_2d_array<f32>;
@group(0) @binding(5) var samp: sampler;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let ts = U.p0.x;
  let p = (vec2f(id.xy) + 0.5) * ts;
  var jxx = 0.0; var jzz = 0.0; var jxz = 0.0;
  for (var c = 0u; c < ${CASCADES}u; c++) {
    let texel = U.cascL[c >> 2u][c & 3u] / ${N}.0;
    let lod = log2(max(ts / texel, 1.0));
    if (lod < 7.5) {
      let uv = p * U.cascInvL[c >> 2u][c & 3u];
      let d = textureSampleLevel(derivTex, samp, uv, c, lod);
      let a = textureSampleLevel(dispTex, samp, uv, c, lod);
      jxx += d.z; jzz += d.w; jxz += a.w;
    }
  }
  let J = (1.0 + jxx) * (1.0 + jzz) - jxz * jxz;
  // semi-Lagrangian advection: foam slowly drifts downwind (and spreads a little)
  let dt = U.p0.y;
  let back = (vec2f(id.xy) + 0.5 - U.drift.xy * dt / ts) / f32(RES);
  let prev = textureSampleLevel(prevTex, samp, back, 0.0);
  let inject = clamp((U.p1.x - J) * U.p1.y, 0.0, 1.0);
  var f = prev.r * exp(-dt * U.p0.z);
  f = max(f, inject);
  f = min(f + inject * dt * U.p1.z, 1.6);
  // g: freshness (recently injected) used for brighter, denser crest foam
  let fresh = max(prev.g * exp(-dt * 1.6), inject);
  textureStore(dst, id.xy, vec4f(f, fresh, J, 1.0));
}
`;

// ---- Surface and the map's sides (web-ocean's ocean.js, plus see-through shallows) ---------------------------

export const WATER_WGSL = /* wgsl */ `
${DIMS_WGSL}
const TEX_N: f32 = ${N}.0;
${skyWgsl(1)}

struct Water {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  camPos: vec4f,       // eye xyz, w = 1 for orthographic
  sun: vec4f,          // xyz towards the sun, w = time (s)
  screen: vec4f,       // w, h, 1/w, 1/h
  cascL: array<vec4f, 2>,
  cascInvL: array<vec4f, 2>,
  wind: vec4f,         // xy = wind direction (unit), z = wind speed, w = water level
  lodP: vec4f,         // CDLOD base range, grid quads per node, foam map size (m), -
  view: vec4f,         // x = world size of a pixel at unit distance (perspective) or anywhere (ortho), y = fog
                       // start, z = gust strength
  waterCol: vec4f,     // body scatter colour rgb, unresolved slope variance
  sssCol: vec4f,       // sss colour rgb, sss strength
  foamP: vec4f,        // J threshold, J gain, foam intensity, shore foam
  absorb: vec4f,       // rgb absorption per metre, refraction strength
}
@group(0) @binding(0) var<uniform> F: Water;
@group(0) @binding(1) var dispTex: texture_2d_array<f32>;
@group(0) @binding(2) var derivTex: texture_2d_array<f32>;
@group(0) @binding(3) var momTex: texture_2d_array<f32>;
@group(0) @binding(4) var foamTex: texture_2d<f32>;
@group(0) @binding(5) var foamWorld: texture_2d<f32>;
@group(0) @binding(6) var sampR: sampler;
// The terrain's G-buffer (x = hit distance along the pixel's ray, -1 = none) and the frame drawn so far.
@group(0) @binding(7) var gbuf: texture_2d<f32>;
@group(0) @binding(8) var scene: texture_2d<f32>;
@group(0) @binding(9) var sdfTex: texture_3d<f32>;
@group(0) @binding(10) var sampC: sampler;
@group(0) @binding(11) var voxels: texture_3d<u32>;

// The terrain shader writes col / (1 + 0.12 col); undo that to blend in linear light.
fn untonemap(c: vec3f) -> vec3f { return c / max(1.0 - 0.12 * c, vec3f(0.05)); }
fn tonemap(c: vec3f) -> vec3f { return c / (1.0 + c * 0.12); }
// A NaN or infinity (a stray glint or slope) as 0. An 8-bit canvas never kept them, but a float (HDR) frame does, and
// the passes after (fog of war over it, bloom) spread them into black blots with bright rims. Checked on the bits, so
// a compiler that assumes finite maths can't drop it.
fn finite(c: vec3f) -> vec3f {
  let e = bitcast<vec3u>(c) & vec3u(0x7f800000u);
  return select(c, vec3f(0.0), e == vec3u(0x7f800000u));
}

struct Ray { ro: vec3f, rd: vec3f }
fn pixelRay(pos: vec2f) -> Ray {
  let ndc = vec2f(pos.x * F.screen.z * 2.0 - 1.0, 1.0 - pos.y * F.screen.w * 2.0);
  let near = F.invViewProj * vec4f(ndc, 0.0, 1.0);
  let far = F.invViewProj * vec4f(ndc, 1.0, 1.0);
  let ro = near.xyz / near.w;
  return Ray(ro, normalize(far.xyz / far.w - ro));
}

fn boxEntry(ro: vec3f, rd: vec3f) -> f32 {
  let inv = 1.0 / rd;
  let a = (vec3f(0.0) - ro) * inv;
  let b = (DIMS - ro) * inv;
  let lo = min(a, b);
  return max(max(lo.x, lo.y), max(lo.z, 0.0));
}

// Distance fog as the terrain has it: from the orbit target's depth, so zooming out doesn't fog everything.
fn fog(col: vec3f, r: Ray, t: f32) -> vec3f {
  let tc = select(t, t - boxEntry(r.ro, r.rd), F.camPos.w > 0.5);
  let f = 1.0 - exp(-max(tc - F.view.y, 0.0) * fogDensity());
  return mix(col, fogColor(r.rd) * 0.95, f);
}

fn waveDisp(xz: vec2f, spacing: f32) -> vec3f {
  var disp = vec3f(0.0);
  for (var c = 0u; c < ${CASCADES}u; c++) {
    let texel = F.cascL[c >> 2u][c & 3u] / TEX_N;
    let lod = log2(max(spacing / texel, 1.0)) + 0.5;
    if (lod < 8.0) {
      disp += textureSampleLevel(dispTex, sampR, xz * F.cascInvL[c >> 2u][c & 3u], c, lod).xyz;
    }
  }
  return disp;
}

// Ambient light from the sky, from the environment cube's blurriest mips.
fn skyUp() -> vec3f { return envSky(vec3f(0.0, 1.0, 0.0), ENV_MAXMIP); }
fn skyHemi() -> vec3f {
  let m = ENV_MAXMIP - 1.0;
  return skyUp() * 0.4 + 0.15 * (envSky(vec3f(0.94, 0.34, 0.0), m) + envSky(vec3f(-0.94, 0.34, 0.0), m) +
    envSky(vec3f(0.0, 0.34, 0.94), m) + envSky(vec3f(0.0, 0.34, -0.94), m));
}
// Light scattered back up out of deep water.
fn bodyColor() -> vec3f {
  return F.waterCol.rgb * (skyHemi() * 1.6 + lightIlluminance() * max(F.sun.y, 0.0) * 0.8);
}

// What's under the surface seen through thickness \`thick\` of water along the view (\`depth\` of it vertically).
fn throughWater(below: vec3f, thick: f32, depth: f32, body: vec3f) -> vec3f {
  let T = exp(-F.absorb.rgb * (thick + depth));
  return below * T + body * (1.0 - T);
}

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,   // displaced position
  @location(1) xz: vec2f,      // undisplaced (lagrangian) coordinates
  @location(2) height: f32,
};

@vertex fn vsSurface(@builtin(vertex_index) vi: u32, @location(0) inst: vec4f) -> VSOut {
  let n = u32(F.lodP.y);
  let g = vec2f(f32(vi % (n + 1u)), f32(vi / (n + 1u)));
  let spacing = inst.z / f32(n);
  var xz = inst.xy + g * spacing;
  // CDLOD morph towards the next coarser level
  let R = F.lodP.x * exp2(inst.w);
  let d = distance(vec3f(xz.x, F.wind.w, xz.y), F.camPos.xyz);
  let mk = clamp((d - 0.8 * R) / (0.2 * R), 0.0, 1.0);
  xz -= fract(g * 0.5) * 2.0 * spacing * mk;
  // The quadtree covers 512 m: the part past the map folds onto its edge.
  xz = min(xz, DIMS.xz);
  let disp = waveDisp(xz, spacing * (1.0 + mk));
  var o: VSOut;
  // Displaced sideways, but never past the map's sides.
  let w = clamp(xz + disp.xz, vec2f(0.0), DIMS.xz);
  o.world = vec3f(w.x, F.wind.w + disp.y, w.y);
  o.pos = F.viewProj * vec4f(o.world, 1.0);
  o.xz = xz;
  o.height = disp.y;
  return o;
}

fn fresnelWater(c: f32) -> f32 {
  // Schlick with F0 for n = 1.333
  let x = 1.0 - clamp(c, 0.0, 1.0);
  let x2 = x * x;
  return 0.02 + 0.98 * x2 * x2 * x;
}

fn lambdaSmith(w: vec3f, cov: vec3f) -> f32 {
  let xz2 = max(dot(w.xz, w.xz), 1e-8);
  let il = inverseSqrt(xz2);
  let az = w.xz * il;
  let sig2 = az.x * az.x * cov.x + az.y * az.y * cov.y + 2.0 * az.x * az.y * cov.z;
  let cotT = w.y * il;
  let a = max(cotT, 1e-3) / sqrt(2.0 * max(sig2, 1e-7));
  if (a >= 1.6) { return 0.0; }
  return (1.0 - 1.259 * a + 0.396 * a * a) / (3.535 * a + 2.181 * a * a);
}

fn foamPattern(xz: vec2f, t: f32) -> f32 {
  let a = textureSample(foamTex, sampR, xz * 0.23 + vec2f(0.013, 0.0) * t).r;
  let b = textureSample(foamTex, sampR, xz * 0.71 + vec2f(0.37, 0.71)).g;
  return a * 0.78 + b * 0.22;
}

@fragment fn fsSurface(in: VSOut) -> @location(0) vec4f {
  let xz = in.xz;
  let time = F.sun.w;
  var s = vec2f(0.0);
  var jxx = 0.0;
  var jzz = 0.0;
  var jxz = 0.0;
  var cov = vec3f(0.0);
  // wind gusts ("cat's paws"): patches where the short ripples are stronger or calmer
  let gustN = textureSample(foamTex, sampR, xz * 0.011 + F.wind.xy * (time * 0.0004)).b;
  let gust = mix(1.0, mix(0.35, 1.2, smoothstep(0.3, 0.72, gustN)), F.view.z);
  for (var c = 0u; c < ${CASCADES}u; c++) {
    let uv = xz * F.cascInvL[c >> 2u][c & 3u];
    let gk = mix(1.0, gust, select(0.0, select(0.5, 1.0, c >= 3u), c >= 2u));
    let dv = textureSample(derivTex, sampR, uv, c) * gk;
    let mv = textureSample(momTex, sampR, uv, c) * (gk * gk);
    let av = textureSample(dispTex, sampR, uv, c) * gk;
    s += dv.xy;
    jxx += dv.z;
    jzz += dv.w;
    jxz += av.w;
    cov += vec3f(max(mv.x - dv.x * dv.x, 0.0), max(mv.y - dv.y * dv.y, 0.0), mv.z - dv.x * dv.y);
  }
  let r = pixelRay(in.pos.xy);
  let dist = distance(in.world, F.camPos.xyz);
  let V = -r.rd;
  let Ld = F.sun.xyz;

  // slope statistics (LEAN): add unresolved capillary roughness, growing with distance
  let unres = F.waterCol.w + 0.0035 * smoothstep(30.0, 500.0, dist);
  cov.x += unres;
  cov.y += unres;
  let jx = max(1.0 + jxx, 0.15);
  let jz = max(1.0 + jzz, 0.15);
  let sl = vec2f(s.x / jx, s.y / jz);
  let nrm = normalize(vec3f(-sl.x, 1.0, -sl.y));
  // specular anti-aliasing: slope variation across the pixel widens the lobe
  let dsx = dpdx(sl);
  let dsy = dpdy(sl);
  let aa = vec3f(dsx.x * dsx.x + dsy.x * dsy.x, dsx.y * dsx.y + dsy.y * dsy.y, dsx.x * dsx.y + dsy.x * dsy.y) * 0.5;
  cov += aa * min(1.0, 0.03 / max(max(aa.x, aa.y), 1e-8));
  let J = (1.0 + jxx) * (1.0 + jzz) - jxz * jxz;

  let sunE = lightIlluminance();
  let hemi = skyHemi();
  let up = skyUp();
  let skyN = envSky(nrm, ENV_MAXMIP - 1.0);

  // ---- sun glitter: anisotropic Gaussian slope distribution ----
  let Hv = normalize(V + Ld);
  let hs = -Hv.xz / max(Hv.y, 1e-3);
  let dsl = hs - sl;
  let det = max(cov.x * cov.y - cov.z * cov.z, 1e-10);
  let e = (dsl.x * dsl.x * cov.y + dsl.y * dsl.y * cov.x - 2.0 * dsl.x * dsl.y * cov.z) / det;
  let pdf = exp(-0.5 * e) / (2.0 * PI * sqrt(det));
  let hy2 = Hv.y * Hv.y;
  let Dm = pdf / max(hy2 * hy2, 1e-6);
  let G = 1.0 / (1.0 + lambdaSmith(V, cov) + lambdaSmith(Ld, cov));
  let Fh = fresnelWater(dot(V, Hv));
  let spec = sunE * (Fh * Dm * G / (4.0 * max(V.y, 0.02))) * step(0.0, Ld.y);

  // ---- sky reflection ----
  // At grazing angles the visible facets are biased towards the viewer, so the effective reflector tilts up.
  let sigV = sqrt(max(cov.x + cov.y, 1e-6) * 0.5);
  let vh = normalize(vec3f(V.x, 0.0, V.z) + vec3f(1e-5, 0.0, 0.0));
  let aV = max(V.y, 1e-3) / max(sqrt(1.0 - V.y * V.y), 1e-3) / (1.4142 * sigV);
  let tilt = 0.32 * sigV * (1.0 - smoothstep(0.0, 2.5, aV));
  let nV = normalize(nrm + vh * tilt);
  var R = reflect(-V, nV);
  R.y = abs(R.y) * 0.4 + max(R.y, 0.0) * 0.6;
  R = normalize(R);
  let refl = envSky(R, clamp(log2(max(2.0 * sigV * ENV_TEXELS_PER_RAD, 1.0)), 0.0, ENV_MAXMIP));
  // Fresnel from a partially smoothed normal
  let nF = normalize(mix(nrm, vec3f(0.0, 1.0, 0.0), 0.45));
  let Fr = fresnelWater(max(dot(nF, V), 0.0));

  // ---- water body: upwelling scatter + backlit subsurface glow ----
  let ambient = up * 1.3 + skyN * 0.5;
  var body = bodyColor();
  let crest = clamp((in.height - 0.05) / 0.9, 0.0, 1.0);
  let toSun = max(dot(Ld, -V), 0.0);
  let thin = pow(clamp(0.5 - 0.5 * dot(Ld, nrm), 0.0, 1.0), 3.0);
  let k1 = F.sssCol.w * crest * crest * pow(toSun, 4.0) * thin;
  body += F.sssCol.rgb * sunE * k1;

  // ---- what's under the surface: the terrain already drawn, through the water above it ----
  let px = vec2i(in.pos.xy);
  let tw = dot(in.world - r.ro, r.rd);
  let gHere = textureLoad(gbuf, px, 0).x;
  let thick0 = select(max(gHere - tw, 0.0), 80.0, gHere < 0.0);
  // The waves bend the view of the bottom: look up the frame a little way along the slope, unless that pixel
  // shows something in front of the water.
  let footprint = select(F.view.x * tw, F.view.x, F.camPos.w > 0.5);
  let bend = clamp(-nrm.xz * F.absorb.w * min(thick0, 3.0) / max(footprint, 1e-4), vec2f(-24.0), vec2f(24.0));
  let size = vec2i(F.screen.xy);
  var spx = clamp(px + vec2i(vec2f(bend.x, -bend.y)), vec2i(0), size - 1);
  var gT = textureLoad(gbuf, spx, 0).x;
  if (gT >= 0.0 && gT < tw) { spx = px; gT = gHere; }
  let thick = select(max(gT - tw, 0.0), 80.0, gT < 0.0);
  let depth = thick * max(-r.rd.y, 0.0);
  let below = untonemap(textureLoad(scene, spx, 0).rgb);
  let under = throughWater(below, thick, depth, body);

  // ---- foam ----
  // persistent foam from the world-space foam map, plus instantaneous crest foam from the per-pixel Jacobian
  let fwl = textureSample(foamWorld, sampR, xz / F.lodP.z);
  let fresh = clamp((F.foamP.x - J) * F.foamP.y, 0.0, 1.0);
  var cover = clamp((max(fwl.r, fresh * 0.3) + fwl.g * 0.6) * F.foamP.z, 0.0, 1.5);
  // aged foam breaks into wind-aligned streaks; fresh crest foam stays dense
  let wd = F.wind.xy;
  let ws = vec2f(dot(xz, wd), dot(xz, vec2f(-wd.y, wd.x)));
  let streak = textureSample(foamTex, sampR, ws * vec2f(0.035, 0.11)).a;
  let freshK = clamp(fwl.g * 2.0 + fresh, 0.0, 1.0);
  cover *= mix(smoothstep(0.25, 0.75, streak) * 1.5, 1.0, freshK);
  let pat = foamPattern(xz, time);
  // Shore foam: a band of lace along the waterline that the waves wash in and out.
  let wash = 0.5 + 0.5 * sin(depth * 7.0 - time * 1.6 + pat * 4.0);
  let shore = (1.0 - smoothstep(0.0, 0.06 + 0.3 * wash, depth)) * F.foamP.w;
  cover = max(cover, shore);
  let fw = fwidth(pat) + 0.03;
  // dense foam has crisp edges, thin decaying foam a soft translucent margin
  let soft = 0.04 + 0.14 * (1.0 - clamp(cover, 0.0, 1.0));
  let fm = smoothstep(1.0 - cover - fw - soft, 1.0 - cover + fw + soft, pat);
  var foamMask = clamp(fm * smoothstep(0.0, 0.5, cover), 0.0, 1.0) * (0.68 + 0.32 * smoothstep(0.3, 0.9, cover));
  // freshly broken crests: dense, almost opaque core
  foamMask = max(foamMask, smoothstep(0.35, 0.9, fwl.g) * smoothstep(0.25, 0.6, pat + 0.25) * 0.95);
  let bub = textureSample(foamTex, sampR, xz * 1.9 + vec2f(0.21, 0.53)).g;
  let foamAlb = vec3f(0.82, 0.87, 0.92) * (0.78 + 0.3 * bub);
  let foamAmb = hemi * 1.0 + skyN * 0.3;
  let foamAmbN = mix(foamAmb, vec3f(dot(foamAmb, vec3f(0.2126, 0.7152, 0.0722))), 0.85);
  let foamLit = foamAlb * (sunE * max(dot(nrm, Ld), 0.0) * 0.318 * 0.9 + foamAmbN * 0.9);

  var col = under * (1.0 - Fr) + refl * Fr + spec;
  // submerged bubbles brighten the water just beneath foam
  col += F.sssCol.rgb * (sunE * 0.05 + ambient * 0.35) * clamp(cover, 0.0, 1.0) * (1.0 - Fr);
  col = mix(col, foamLit, foamMask * 0.95);
  // The waterline itself: fade in over the first few centimetres so the shore isn't a hard edge.
  col = mix(below, col, smoothstep(0.0, 0.06, depth + thick * 0.02));
  return vec4f(finite(tonemap(fog(col, r, tw))), 1.0);
}

// ---- The water's cross-section on the map's sides ----

struct PanelOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) @interpolate(flat) normal: vec3f,
  @location(2) top: f32,
};

@vertex fn vsPanel(@builtin(vertex_index) vi: u32) -> PanelOut {
  let seg = ${PANEL_SEG}u;
  let side = vi / (seg * 6u);
  let k = vi % (seg * 6u);
  var corners = array<vec2u, 6>(vec2u(0u, 0u), vec2u(1u, 0u), vec2u(1u, 1u), vec2u(0u, 0u), vec2u(1u, 1u), vec2u(0u, 1u));
  let corner = corners[k % 6u];
  let along = select(DIMS.x, DIMS.z, side >= 2u);
  let u = f32(k / 6u + corner.x) / f32(seg) * along;
  var xz = vec2f(u, 0.0);
  var n = vec3f(0.0, 0.0, -1.0);
  if (side == 1u) { xz = vec2f(u, DIMS.z); n = vec3f(0.0, 0.0, 1.0); }
  if (side == 2u) { xz = vec2f(0.0, u); n = vec3f(-1.0, 0.0, 0.0); }
  if (side == 3u) { xz = vec2f(DIMS.x, u); n = vec3f(1.0, 0.0, 0.0); }
  let top = F.wind.w + waveDisp(xz, along / f32(seg)).y;
  var o: PanelOut;
  o.world = vec3f(xz.x, select(0.0, top, corner.y == 1u), xz.y) + n * 0.02;
  o.pos = F.viewProj * vec4f(o.world, 1.0);
  o.normal = n;
  o.top = top;
  return o;
}

// Is the terrain solid just inside the map from this point on its side?
fn solidInside(q: vec3f) -> bool {
  return textureLoad(voxels, vec3i(floor(q)), 0).r >= ${SOLID_MIN}u;
}

@fragment fn fsPanel(in: PanelOut) -> @location(0) vec4f {
  let r = pixelRay(in.pos.xy);
  // From inside the map the side is seen through the surface instead; where the terrain reaches the side, it shows.
  if (dot(r.rd, in.normal) > 0.0 || solidInside(in.world - in.normal * 0.52)) { discard; }
  let px = vec2i(in.pos.xy);
  let tw = dot(in.world - r.ro, r.rd);
  let g = textureLoad(gbuf, px, 0).x;
  let thick = select(max(g - tw, 0.0), 80.0, g < 0.0);
  let depth = max(in.top - in.world.y, 0.0);
  // Deeper water is lit less.
  let body = bodyColor() * exp(-depth * vec3f(0.10, 0.035, 0.025));
  var col = throughWater(untonemap(textureLoad(scene, px, 0).rgb), thick, 0.0, body);
  // A bright line where the surface meets the glass.
  col += vec3f(0.30, 0.38, 0.40) * (1.0 - smoothstep(0.0, 0.18, depth));
  return vec4f(finite(tonemap(fog(col, r, tw))), 1.0);
}
`;

// ---- Host side --------------------------------------------------------------------------------------------------

export class Water {
  // field: the terrain's TerrainField (for the voxel and distance textures the sides read).
  // sky: the Sky lighting it.
  constructor(device, format, depthFormat, field, sky) {
    this.device = device;
    this.sky = sky;
    this.format = format;
    this.field = field;
    const GU = GPUBufferUsage, TU = GPUTextureUsage;
    const C = CASCADES;
    const specBytes = N * N * C * 16;
    const buf = (size, usage, label) => device.createBuffer({ size, usage, label });
    this.simUBO = buf(224, GU.UNIFORM | GU.COPY_DST, 'water sim');
    const h0 = buf(specBytes, GU.STORAGE, 'water h0');
    const specA = buf(specBytes, GU.STORAGE, 'water specA');
    const specB = buf(specBytes, GU.STORAGE, 'water specB');
    const tmpA = buf(specBytes, GU.STORAGE, 'water tmpA');
    const tmpB = buf(specBytes, GU.STORAGE, 'water tmpB');

    this.simMips = LOGN + 1;
    const simTex = (label) => device.createTexture({
      label, size: [N, N, C], format: 'rgba16float', mipLevelCount: this.simMips,
      usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
    });
    const disp = simTex('water displacement');
    const deriv = simTex('water derivatives');
    const mom = simTex('water slope moments');
    const lvl = (t, m, dimension = '2d-array') => t.createView({ dimension, baseMipLevel: m, mipLevelCount: 1 });
    const arr = (t) => t.createView({ dimension: '2d-array' });

    const compute = (code, label) => device.createComputePipeline({
      label, layout: 'auto', compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' },
    });
    this.initPipe = compute(SIM_INIT, 'water spectrum');
    this.evolvePipe = compute(SIM_EVOLVE, 'water evolve');
    this.rowsPipe = compute(FFT_ROWS, 'water fft rows');
    this.colsPipe = compute(FFT_COLS, 'water fft cols');
    this.simMipPipe = compute(SIM_MIPS, 'water mips');
    this.foamUpdPipe = compute(FOAM_UPDATE, 'water foam');
    this.mip16Pipe = compute(MIPS_2D('rgba16float'), 'water foam mips');
    const patternPipe = compute(FOAM_PATTERN, 'foam pattern');
    const mip8Pipe = compute(MIPS_2D('rgba8unorm'), 'foam pattern mips');

    const bg = (pipe, entries, label) => device.createBindGroup({
      label, layout: pipe.getBindGroupLayout(0), entries: entries.map((resource, binding) => ({ binding, resource })),
    });
    this.bgInit = bg(this.initPipe, [{ buffer: this.simUBO }, { buffer: h0 }]);
    this.bgEvolve = bg(this.evolvePipe, [{ buffer: this.simUBO }, { buffer: h0 }, { buffer: specA }, { buffer: specB }]);
    this.bgRows = bg(this.rowsPipe, [{ buffer: specA }, { buffer: specB }, { buffer: tmpA }, { buffer: tmpB }]);
    this.bgCols = bg(this.colsPipe, [{ buffer: tmpA }, { buffer: tmpB }, lvl(disp, 0), lvl(deriv, 0), lvl(mom, 0)]);
    this.bgSimMips = [];
    for (let m = 1; m < this.simMips; m++) {
      this.bgSimMips.push(bg(this.simMipPipe, [lvl(disp, m - 1), lvl(deriv, m - 1), lvl(mom, m - 1), lvl(disp, m), lvl(deriv, m), lvl(mom, m)]));
    }

    // Foam pattern texture, generated once.
    const patternMips = Math.log2(FOAM_TEX) + 1;
    const pattern = device.createTexture({
      label: 'foam pattern', size: [FOAM_TEX, FOAM_TEX], format: 'rgba8unorm', mipLevelCount: patternMips,
      usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
    });
    {
      const enc = device.createCommandEncoder();
      const cp = enc.beginComputePass();
      cp.setPipeline(patternPipe);
      cp.setBindGroup(0, bg(patternPipe, [lvl(pattern, 0, '2d')]));
      cp.dispatchWorkgroups(FOAM_TEX / 8, FOAM_TEX / 8);
      cp.setPipeline(mip8Pipe);
      for (let m = 1; m < patternMips; m++) {
        const s = FOAM_TEX >> m;
        cp.setBindGroup(0, bg(mip8Pipe, [lvl(pattern, m - 1, '2d'), lvl(pattern, m, '2d')]));
        cp.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8));
      }
      cp.end();
      device.queue.submit([enc.finish()]);
    }

    // Foam map over the water, ping-ponged each frame.
    this.foamMips = Math.log2(FOAM_RES) + 1;
    const foam = [0, 1].map((i) => device.createTexture({
      label: `foam map ${i}`, size: [FOAM_RES, FOAM_RES], format: 'rgba16float', mipLevelCount: this.foamMips,
      usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING,
    }));
    this.foamUBO = buf(112, GU.UNIFORM | GU.COPY_DST, 'water foam');
    const sampSim = device.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat',
    });
    const sampClampLin = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    // Foam map i is written from map 1 - i.
    this.bgFoam = [0, 1].map((i) => device.createBindGroup({
      layout: this.foamUpdPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.foamUBO } },
        { binding: 1, resource: lvl(foam[1 - i], 0, '2d') },
        { binding: 2, resource: lvl(foam[i], 0, '2d') },
        { binding: 3, resource: arr(disp) },
        { binding: 4, resource: arr(deriv) },
        { binding: 5, resource: sampSim },
      ],
    }));
    this.bgFoamMips = [0, 1].map((i) => {
      const out = [];
      for (let m = 1; m < this.foamMips; m++) out.push(bg(this.mip16Pipe, [lvl(foam[i], m - 1, '2d'), lvl(foam[i], m, '2d')]));
      return out;
    });
    this.foamCur = 0;

    // Render pipelines: surface and sides share one layout.
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.layout = device.createBindGroupLayout({
      label: 'water',
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 1, visibility: VF, texture: { viewDimension: '2d-array' } },
        { binding: 2, visibility: VF, texture: { viewDimension: '2d-array' } },
        { binding: 3, visibility: VF, texture: { viewDimension: '2d-array' } },
        { binding: 4, visibility: VF, texture: {} },
        { binding: 5, visibility: VF, texture: {} },
        { binding: 6, visibility: VF, sampler: {} },
        { binding: 7, visibility: VF, texture: { sampleType: 'unfilterable-float' } },
        { binding: 8, visibility: VF, texture: { sampleType: 'unfilterable-float' } },
        { binding: 9, visibility: VF, texture: { viewDimension: '3d' } },
        { binding: 10, visibility: VF, sampler: {} },
        { binding: 11, visibility: VF, texture: { viewDimension: '3d', sampleType: 'uint' } },
      ],
    });
    const module = device.createShaderModule({ label: 'water', code: WATER_WGSL });
    const pipeLayout = device.createPipelineLayout({ bindGroupLayouts: [this.layout, sky.layout] });
    const depthStencil = { format: depthFormat, depthWriteEnabled: true, depthCompare: 'less' };
    this.surfacePipe = device.createRenderPipeline({
      label: 'water surface', layout: pipeLayout,
      vertex: {
        module, entryPoint: 'vsSurface',
        buffers: [{ arrayStride: 16, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }],
      },
      fragment: { module, entryPoint: 'fsSurface', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
    });
    this.panelPipe = device.createRenderPipeline({
      label: 'water sides', layout: pipeLayout,
      vertex: { module, entryPoint: 'vsPanel' },
      fragment: { module, entryPoint: 'fsPanel', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
    });
    this.sampR = device.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8,
    });
    this.sampC = sampClampLin;
    this.views = { disp: arr(disp), deriv: arr(deriv), mom: arr(mom), pattern: pattern.createView(), foam: foam.map((t) => t.createView()) };

    // Grid mesh indices, and per-node instances.
    const idx = new Uint16Array(GRID * GRID * 6);
    let k = 0;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = i + j * (GRID + 1), b = a + 1, c = a + GRID + 1, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = d;
        idx[k++] = a; idx[k++] = d; idx[k++] = b;
      }
    }
    this.indexBuf = buf(idx.byteLength, GU.INDEX | GU.COPY_DST, 'water grid');
    device.queue.writeBuffer(this.indexBuf, 0, idx);
    this.instData = new Float32Array(MAX_NODES * 4);
    this.instBuf = buf(this.instData.byteLength, GU.VERTEX | GU.COPY_DST, 'water nodes');
    this.nodeCount = 0;
    this.ranges = Array.from({ length: LODS }, (_, l) => R0 * 2 ** l);
    this.planes = new Float64Array(16);

    this.uniforms = buf(88 * 4, GU.UNIFORM | GU.COPY_DST, 'water frame');
    this.frameData = new Float32Array(88);
    this.simData = new Float32Array(56);
    this.foamData = new Float32Array(28);
    this.needSpectrum = true;
    this.hb = HB;
    this.xb = XB;
    this.time = 0;
    this.size = [0, 0];
  }

  // Follows the output size: a copy of the frame drawn so far for the water to look through, and bind groups for the
  // terrain's (resized) G-buffer.
  resize(w, h, gbuf) {
    if (this.size[0] === w && this.size[1] === h && this.gbuf === gbuf) return;
    this.size = [w, h];
    this.gbuf = gbuf;
    this.sceneCopy?.destroy();
    this.sceneCopy = this.device.createTexture({
      label: 'frame under the water', size: [w, h], format: this.format.replace('-srgb', ''),
      viewFormats: [this.format], usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const v = this.views;
    this.groups = [0, 1].map((i) => this.device.createBindGroup({
      label: 'water',
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniforms } },
        { binding: 1, resource: v.disp },
        { binding: 2, resource: v.deriv },
        { binding: 3, resource: v.mom },
        { binding: 4, resource: v.pattern },
        { binding: 5, resource: v.foam[i] },
        { binding: 6, resource: this.sampR },
        { binding: 7, resource: gbuf.createView() },
        { binding: 8, resource: this.sceneCopy.createView({ format: this.format }) },
        { binding: 9, resource: this.field.sdfTex.createView() },
        { binding: 10, resource: this.sampC },
        { binding: 11, resource: this.field.voxelTex.createView() },
      ],
    }));
  }

  writeSim(dt) {
    const T = WATER_TUNING, f = this.simData, C = CASCADES;
    for (let c = 0; c < C; c++) {
      const L = CASC_L[c];
      f[c] = L;
      f[8 + c] = c === 0 ? Math.PI / L : (2 * Math.PI * 6) / L;                                  // kMin
      f[16 + c] = c < C - 1 ? (2 * Math.PI * 6) / CASC_L[c + 1] : (Math.PI * N / L) * 0.98;      // kMax
    }
    for (let c = 1; c < C; c++) f[8 + c] = f[16 + c - 1];
    f[24] = T.windSpeed; f[25] = T.windDir * D2R; f[26] = Math.max(T.fetchKm, 0.01) * 1000; f[27] = Math.max(T.gamma, 1);
    const ks = 2 * Math.PI / Math.max(T.swellLength, 0.5);
    f[28] = T.swellHs; f[29] = T.swellDir * D2R; f[30] = Math.sqrt(9.81 * ks); f[31] = T.swellSpread;
    f[32] = T.choppy; f[33] = T.shortCut / 1000; f[34] = LOOP; f[35] = 1;
    f[36] = this.time; f[37] = dt; f[38] = 0; f[39] = 1.0;
    f[40] = T.windHeight * T.windHeight; f[41] = Math.max(T.windFreq, 0.05); f[42] = T.ripples; f[43] = 0;
    this.device.queue.writeBuffer(this.simUBO, 0, f, 0, 44);
    const key = SPECTRUM_KEYS.map((k) => T[k]).join();
    if (key !== this.spectrumKey) { this.spectrumKey = key; this.needSpectrum = true; }
    // The surface's bounds for culling grow with the waves (fetch-limited height goes as wind speed x sqrt(fetch)).
    const grow = Math.max(1, T.windHeight * (T.windSpeed / 6) * Math.sqrt(Math.max(T.fetchKm, 0.01) / 6));
    this.hb = HB * grow + Math.max(0, T.swellHs - 0.35) * 1.5;
    this.xb = XB * grow * Math.max(1, T.choppy);
  }

  writeFoam(dt) {
    const T = WATER_TUNING, f = this.foamData;
    f[0] = FOAM_SIZE / FOAM_RES; f[1] = dt; f[2] = T.foamFade; f[3] = 0;
    f[4] = 0.52 + 0.16 * T.foam; f[5] = 2.0; f[6] = 1.0; f[7] = 0;
    for (let c = 0; c < CASCADES; c++) { f[8 + c] = CASC_L[c]; f[16 + c] = 1 / CASC_L[c]; }
    const drift = 0.03 * T.windSpeed;
    f[24] = Math.cos(T.windDir * D2R) * drift; f[25] = Math.sin(T.windDir * D2R) * drift;
    this.device.queue.writeBuffer(this.foamUBO, 0, f);
  }

  // CDLOD node selection (web-ocean's), over the map's quadtree, in world space.
  select(eye, viewProj) {
    const m = viewProj, P = this.planes;
    for (let i = 0; i < 4; i++) {
      const r = i >> 1, s = (i & 1) ? -1 : 1;
      P[i * 4] = m[3] + s * m[r];
      P[i * 4 + 1] = m[7] + s * m[4 + r];
      P[i * 4 + 2] = m[11] + s * m[8 + r];
      P[i * 4 + 3] = m[15] + s * m[12 + r];
    }
    const [ex, ey, ez] = eye, y = WATER_LEVEL, HB = this.hb, XB = this.xb;
    const sphereHit = (x0, z0, size, r) => {
      const dx = Math.max(x0 - ex, 0, ex - (x0 + size));
      const dz = Math.max(z0 - ez, 0, ez - (z0 + size));
      const dy = Math.max(y - HB - ey, 0, ey - (y + HB));
      return dx * dx + dy * dy + dz * dz <= r * r;
    };
    const inFrustum = (x0, z0, size) => {
      const minx = x0 - XB, maxx = x0 + size + XB, minz = z0 - XB, maxz = z0 + size + XB;
      for (let p = 0; p < 16; p += 4) {
        const a = P[p], b = P[p + 1], c = P[p + 2], d = P[p + 3];
        const px = a > 0 ? maxx : minx, py = b > 0 ? y + HB : y - HB, pz = c > 0 ? maxz : minz;
        if (a * px + b * py + c * pz + d < 0) return false;
      }
      return true;
    };
    const inst = this.instData;
    let count = 0;
    const add = (x0, z0, size, lod) => {
      if (count >= MAX_NODES || x0 >= SIZE[0] || z0 >= SIZE[2]) return;
      inst.set([x0, z0, size, lod], count * 4);
      count++;
    };
    const visit = (x0, z0, size, lod) => {
      if (!sphereHit(x0, z0, size, this.ranges[lod])) return false;
      if (!inFrustum(x0, z0, size)) return true;
      if (lod === 0 || !sphereHit(x0, z0, size, this.ranges[lod - 1])) { add(x0, z0, size, lod); return true; }
      const h = size * 0.5;
      for (let i = 0; i < 4; i++) {
        const nx = x0 + (i & 1) * h, nz = z0 + (i >> 1) * h;
        if (!visit(nx, nz, h, lod - 1) && inFrustum(nx, nz, h)) add(nx, nz, h, lod - 1);
      }
      return true;
    };
    const top = LODS - 1;
    if (!visit(0, 0, LEAF * 2 ** top, top) && inFrustum(0, 0, LEAF * 2 ** top)) add(0, 0, LEAF * 2 ** top, top);
    this.nodeCount = count;
  }

  // Runs the simulation for this frame and draws the water over the frame in `colorTexture` (which must allow
  // COPY_SRC), depth-tested against the terrain and units.
  // frame: { dt, eye, viewProj, invViewProj, ortho, sun, pixel, fogStart }
  draw(encoder, colorTexture, depthView, frame, profiler) {
    const dt = Math.min(frame.dt, 0.1);
    this.time = (this.time + dt * Math.max(0, WATER_TUNING.speed)) % LOOP;
    this.writeSim(dt);
    this.writeFoam(Math.max(dt, 1e-4));
    this.foamCur = 1 - this.foamCur;

    const cp = encoder.beginComputePass({ label: 'water sim', timestampWrites: profiler?.tsw('water: waves + foam (compute)') });
    if (this.needSpectrum) {
      cp.setPipeline(this.initPipe);
      cp.setBindGroup(0, this.bgInit);
      cp.dispatchWorkgroups(N / 16, N / 16, CASCADES);
      this.needSpectrum = false;
    }
    cp.setPipeline(this.evolvePipe);
    cp.setBindGroup(0, this.bgEvolve);
    cp.dispatchWorkgroups(N / 16, N / 16, CASCADES);
    cp.setPipeline(this.rowsPipe);
    cp.setBindGroup(0, this.bgRows);
    cp.dispatchWorkgroups(N, 1, CASCADES);
    cp.setPipeline(this.colsPipe);
    cp.setBindGroup(0, this.bgCols);
    cp.dispatchWorkgroups(N, 1, CASCADES);
    cp.setPipeline(this.simMipPipe);
    for (let m = 1; m < this.simMips; m++) {
      const s = N >> m;
      cp.setBindGroup(0, this.bgSimMips[m - 1]);
      cp.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), CASCADES);
    }
    cp.setPipeline(this.foamUpdPipe);
    cp.setBindGroup(0, this.bgFoam[this.foamCur]);
    cp.dispatchWorkgroups(FOAM_RES / 8, FOAM_RES / 8);
    cp.setPipeline(this.mip16Pipe);
    const fm = this.bgFoamMips[this.foamCur];
    for (let m = 1; m < this.foamMips; m++) {
      const s = Math.max(1, FOAM_RES >> m);
      cp.setBindGroup(0, fm[m - 1]);
      cp.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8));
    }
    cp.end();

    const T = WATER_TUNING, f = this.frameData, [w, h] = this.size;
    f.set(frame.viewProj, 0);
    f.set(frame.invViewProj, 16);
    f.set([...frame.eye, frame.ortho ? 1 : 0], 32);
    f.set([...frame.sun, this.time], 36);
    f.set([w, h, 1 / w, 1 / h], 40);
    for (let c = 0; c < 8; c++) { f[44 + c] = CASC_L[c] ?? 1; f[52 + c] = 1 / (CASC_L[c] ?? 1); }
    f.set([Math.cos(T.windDir * D2R), Math.sin(T.windDir * D2R), T.windSpeed, WATER_LEVEL], 60);
    f.set([R0, GRID, FOAM_SIZE, 0], 64);
    f.set([frame.pixel, frame.fogStart, T.gusts, 0], 68);
    f.set([0.016 * T.turbidity, 0.080 * T.turbidity, 0.096 * T.turbidity, 0.0024], 72);
    f.set([0.035, 0.120, 0.085, T.sss], 76);
    f.set([0.36 + 0.12 * T.foam, 2.5, T.foam, T.shoreFoam * T.foam], 80);
    const clear = Math.max(T.clarity, 0.01);
    f.set([T.absorb[0] / clear, T.absorb[1] / clear, T.absorb[2] / clear, T.refraction], 84);
    this.device.queue.writeBuffer(this.uniforms, 0, f);
    this.select(frame.eye, frame.viewProj);
    if (this.nodeCount) this.device.queue.writeBuffer(this.instBuf, 0, this.instData, 0, this.nodeCount * 4);

    encoder.copyTextureToTexture({ texture: colorTexture }, { texture: this.sceneCopy }, [w, h]);
    const pass = encoder.beginRenderPass({
      label: 'water',
      colorAttachments: [{ view: colorTexture.createView({ format: this.format }), loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: depthView, depthLoadOp: 'load', depthStoreOp: 'store' },
      timestampWrites: profiler?.tsw('water: surface + sides'),
    });
    pass.setBindGroup(0, this.groups[this.foamCur]);
    pass.setBindGroup(1, this.sky.group);
    if (this.nodeCount) {
      pass.setPipeline(this.surfacePipe);
      pass.setVertexBuffer(0, this.instBuf);
      pass.setIndexBuffer(this.indexBuf, 'uint16');
      pass.drawIndexed(GRID * GRID * 6, this.nodeCount);
    }
    pass.setPipeline(this.panelPipe);
    pass.draw(PANEL_SEG * 6 * 4);
    pass.end();
  }
}
