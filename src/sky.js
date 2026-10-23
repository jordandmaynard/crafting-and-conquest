// Sky: web-ocean's physically based atmosphere and cloud deck (https://github.com/Noniv/web-ocean, MIT licence: see
// LICENSES/web-ocean.txt), lighting the terrain, the water and the villagers, with the sun placed by time of day.
//
// From web-ocean, mostly as written: Hillaire-style transmittance, multiple-scattering and sky-view LUTs (Rayleigh,
// Mie haze, ozone), the two procedural cloud layers, the sun disc with limb darkening, and the environment cube
// (refreshed a couple of faces a frame) whose mips give the water its reflections and everything its sky light.
//
// Changed for this game: the sun's direction comes from the hour, latitude and season; sunlight and skylight get a
// colour and strength each, and there's an exposure for the lot; below the horizon the cube shows light bounced off
// the ground rather than a far ocean; and at night a moon opposite the sun takes over as the light that casts
// shadows, and the sky keeps a faint blue glow and stars, so the map stays readable.

const TRANS_W = 256, TRANS_H = 64, MS_SIZE = 32;
const SKY_W = 256, SKY_H = 144;          // sky-view LUT
const ENV_SIZE = 128, ENV_MIPS = 8;      // environment cube faces, down to 1×1
const D2R = Math.PI / 180;

export const SKY_TUNING = {
  timeOfDay: 8,     // hours, 0-24
  timeSpeed: 8,      // game hours that pass per real minute (0 = the clock stands still)
  latitude: 40,        // degrees north: how high the sun climbs
  season: 12,          // the sun's declination in degrees: +23 midsummer, 0 equinox, -23 midwinter
  north: -131,         // which way north is on the map, degrees
  sunColor: '#ffffff', // tint on direct sunlight
  sunStrength: 0.45,
  skyColor: '#ffffff', // tint on skylight (the sky itself, the light from it and its reflections)
  skyStrength: 0.02,
  moonColor: '#a8bcff', // tint on moonlight
  moonStrength: 1.08,
  nightLight: 0.15,     // the glow of the night sky, so the map can still be seen
  haze: 11,           // aerosols: hazier makes a whiter sky and redder sunsets
  clouds: 0.55,         // low cumulus cover
  highClouds: 0.36,    // high altostratus veil
  exposure: 1.0,
  autoExposure: 1.0,   // how much the exposure opens up as the light fails at dusk and night (0 = not at all)
  fog: 5.0,            // distance fog density
  // The background (what's seen past the map) as a colour that follows the time of day, blended over the
  // physical sky by `background` (0 = the sky as it is, 1 = just the colour, with the stars kept at night).
  background: 0.33,
  bgDay: '#9cc3e4',
  bgDusk: '#e9a27c',
  bgNight: '#18203a',
  bgFog: 1,            // how much distance fog fades to the background colour as well (0 = to the sky's haze)
};

// Per-frame sky parameters, shared by every shader that uses the sky. Layout matches Sky.update's writes.
const SKY_FRAME_WGSL = /* wgsl */ `
struct SkyFrame {
  sunDir: vec4f,   // xyz towards the sun, w = the sun's illuminance above the atmosphere (with exposure)
  sunTint: vec4f,  // rgb: sunlight colour × strength
  skyTint: vec4f,  // rgb: skylight colour × strength, w = night sky glow (with exposure)
  atmo: vec4f,     // haze (Mie multiplier), camera altitude (km), high cloud cover, high cloud density
  cloudP: vec4f,   // low cloud altitude (km), cover, density, time (s)
  camPos: vec4f,   // camera (m), w = frame number
  ground: vec4f,   // rgb: ground albedo, for light bounced up from below
  misc: vec4f,     // x = fog per metre, y = exposure, z = how much fog takes the background colour
  moon: vec4f,     // rgb: moonlight (colour × strength × exposure); the moon is opposite the sun
  bg: vec4f,       // rgb: the background colour for this time of day (radiance, before tone mapping), w = amount
};
`;

const ATMO_CORE_WGSL = /* wgsl */ `
const PI: f32 = 3.14159265358979;
const RG: f32 = 6360.0;
const RT: f32 = 6460.0;
const RAY_S: vec3f = vec3f(5.802e-3, 13.558e-3, 33.1e-3);
const MIE_S: f32 = 3.996e-3;
const MIE_E: f32 = 4.40e-3;
const OZO_A: vec3f = vec3f(0.650e-3, 1.881e-3, 0.085e-3);
const SUN_ANG_R: f32 = 0.004675;
const TRANS_W: f32 = ${TRANS_W}.0;
const TRANS_H: f32 = ${TRANS_H}.0;
const MS_SIZE: f32 = ${MS_SIZE}.0;
const SKY_W: f32 = ${SKY_W}.0;
const SKY_H: f32 = ${SKY_H}.0;

struct Medium { ext: vec3f, rayS: vec3f, mieS: f32 };

fn medium(h: f32, haze: f32) -> Medium {
  let hh = max(h, 0.0);
  let dR = exp(-hh / 8.0);
  // aerosols: regular 1.2 km layer plus a dense boundary layer
  let dM = exp(-hh / 1.2);
  let dO = max(0.0, 1.0 - abs(hh - 25.0) / 15.0);
  var m: Medium;
  m.rayS = RAY_S * dR;
  m.mieS = MIE_S * dM * haze;
  m.ext = m.rayS + vec3f(MIE_E * dM * haze) + OZO_A * dO;
  return m;
}

fn raySphere(ro: vec3f, rd: vec3f, R: f32) -> vec2f {
  let l = length(ro);
  let b = dot(ro, rd);
  let c = (l - R) * (l + R);
  let d = b * b - c;
  if (d < 0.0) { return vec2f(-1.0, -1.0); }
  let s = sqrt(d);
  return vec2f(-b - s, -b + s);
}

fn rhoOf(r: f32) -> f32 { return sqrt(max(0.0, (r - RG) * (r + RG))); }

fn transRMuToUV(r: f32, mu: f32) -> vec2f {
  let H = sqrt(RT * RT - RG * RG);
  let rho = rhoOf(r);
  let disc = r * r * (mu * mu - 1.0) + RT * RT;
  let d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  let dMin = RT - r;
  let dMax = rho + H;
  return vec2f((d - dMin) / (dMax - dMin), rho / H);
}

fn transUVToRMu(uv: vec2f) -> vec2f {
  let H = sqrt(RT * RT - RG * RG);
  let rho = H * uv.y;
  let r = sqrt(rho * rho + RG * RG);
  let dMin = RT - r;
  let dMax = rho + H;
  let d = dMin + uv.x * (dMax - dMin);
  var mu = 1.0;
  if (d > 0.0) { mu = (H * H - rho * rho - d * d) / (2.0 * r * d); }
  return vec2f(r, clamp(mu, -1.0, 1.0));
}

fn fromUnitToSubUvs(u: f32, res: f32) -> f32 { return (u + 0.5 / res) * (res / (res + 1.0)); }
fn fromSubUvsToUnit(u: f32, res: f32) -> f32 { return (u - 0.5 / res) * (res / (res - 1.0)); }

fn phaseRayleigh(c: f32) -> f32 { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
fn phaseMie(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
fn phaseHG(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// true when the sun is below the geometric horizon of a point at radius r
fn sunBelowHorizon(r: f32, mu: f32) -> bool {
  return mu < -rhoOf(r) / r;
}

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
fn gnoise(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = dot(hashGrad(i), f);
  let b = dot(hashGrad(i + vec2i(1, 0)), f - vec2f(1.0, 0.0));
  let c = dot(hashGrad(i + vec2i(0, 1)), f - vec2f(0.0, 1.0));
  let d = dot(hashGrad(i + vec2i(1, 1)), f - vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

// Sky radiance, sunlight and clouds. Needs SKY, skyTrans, skyLUT and skySamp (see skyBindings).
const SKY_FUNCS_WGSL = /* wgsl */ `
fn camR() -> f32 { return RG + SKY.atmo.y; }

fn sampleTrans(r: f32, mu: f32) -> vec3f {
  return textureSampleLevel(skyTrans, skySamp, transRMuToUV(r, mu), 0.0).rgb;
}

// Sunlight arriving at the ground (irradiance on a surface facing the sun), fading out as the sun sets.
fn sunIlluminance() -> vec3f {
  let risen = smoothstep(-0.009, 0.001, SKY.sunDir.y);
  return sampleTrans(camR(), SKY.sunDir.y) * SKY.sunDir.w * SKY.sunTint.rgb * risen;
}

// Moonlight, rising as the sun sets (the moon is opposite it).
fn moonIlluminance() -> vec3f {
  return SKY.moon.rgb * smoothstep(0.0, 0.15, -SKY.sunDir.y);
}

// The light that casts shadows: the sun by day, the moon by night. Its direction is the sun's, or the moon's when
// the sun is down.
fn lightIlluminance() -> vec3f {
  return select(moonIlluminance(), sunIlluminance(), SKY.sunDir.y >= 0.0);
}

fn skyViewUV(dir: vec3f) -> vec2f {
  let r = camR();
  let vHorizon = rhoOf(r);
  let cosBeta = vHorizon / r;
  let beta = acos(clamp(cosBeta, -1.0, 1.0));
  let zha = PI - beta;
  let vzc = clamp(dir.y, -1.0, 1.0);
  var uv: vec2f;
  if (vzc >= -cosBeta) {
    var coord = acos(vzc) / zha;
    coord = 1.0 - coord;
    coord = sqrt(max(coord, 0.0));
    coord = 1.0 - coord;
    uv.y = coord * 0.5;
  } else {
    var coord = (acos(vzc) - zha) / beta;
    coord = sqrt(max(coord, 0.0));
    uv.y = coord * 0.5 + 0.5;
  }
  let dl = length(dir.xz);
  let sl = length(SKY.sunDir.xz);
  var lvc = 1.0;
  if (dl > 1e-6 && sl > 1e-6) { lvc = clamp(dot(dir.xz, SKY.sunDir.xz) / (dl * sl), -1.0, 1.0); }
  uv.x = sqrt(max(-lvc * 0.5 + 0.5, 0.0));
  return vec2f(fromUnitToSubUvs(uv.x, SKY_W), fromUnitToSubUvs(uv.y, SKY_H));
}

// The night sky's faint glow (airglow and moonlight, roughly), brighter overhead.
fn nightGlow(dir: vec3f) -> vec3f {
  return vec3f(0.016, 0.026, 0.05) * (0.7 + 0.3 * max(dir.y, 0.0)) * SKY.skyTint.w;
}

fn skyAtmo(dir: vec3f) -> vec3f {
  return textureSampleLevel(skyLUT, skySamp, skyViewUV(dir), 0.0).rgb * SKY.sunDir.w * SKY.skyTint.rgb + nightGlow(dir);
}

// ---- clouds -------------------------------------------------------------
// Two thin, light-aware layers: broken low cumulus with cauliflower edges and high altostratus. Each is shaded
// with self-shadowing towards the sun, bright sun-facing rims, silver linings on thin back-lit parts and warm
// multiple scattering.
const CLOUD_ROT: mat2x2f = mat2x2f(0.8, 0.6, -0.6, 0.8);
// fbm whose octaves fade once smaller than the pixel footprint fp (noise units);
// 'billow' turns the small octaves into bulgy |noise| for cauliflower-like edges
fn cloudFbm(p: vec2f, fp: f32, oct: i32, billow: f32) -> f32 {
  var s = 0.0;
  var a = 0.5;
  var q = p;
  var f = 1.0;
  for (var i = 0; i < oct; i++) {
    let w = 1.0 - smoothstep(0.08, 0.28, fp * f);
    var n = gnoise(q);
    if (i >= 2) { n = mix(n, abs(n) * 2.0 - 0.38, billow); }
    s += a * n * w;
    q = CLOUD_ROT * q * 2.03 + vec2f(13.1, 7.7);
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}
fn lowEdge(q: vec2f, fp: f32, oct: i32) -> f32 {
  let t = SKY.cloudP.w;
  var p = q * 0.38 + vec2f(t * 0.004, t * 0.0012);
  let w = vec2f(gnoise(p * 0.3 + vec2f(1.7, 9.2)), gnoise(p * 0.3 + vec2f(8.3, 2.8)));
  p += w * 1.4;
  let base = cloudFbm(p * vec2f(1.0, 1.7), fp * 0.65, oct, 0.35) * 1.3 + 0.5;
  let large = gnoise(q * 0.05 + vec2f(3.1, 1.3)) * 0.7;
  return base + large - (1.0 - SKY.cloudP.y);
}
fn lowSoft(fp: f32) -> f32 { return 0.38 + min(fp * 0.65, 1.0) * 0.3; }
fn lowDensity(q: vec2f, fp: f32, oct: i32) -> f32 {
  return clamp(lowEdge(q, fp, oct) / lowSoft(fp), 0.0, 1.0);
}
fn highEdge(q: vec2f, fp: f32, oct: i32) -> f32 {
  let t = SKY.cloudP.w;
  let p = CLOUD_ROT * (q * vec2f(0.09, 0.20)) + vec2f(t * 0.0015, 0.0);
  let n = cloudFbm(p, fp * 0.2, oct, 0.0) * 1.25 + 0.5;
  let big = gnoise(q * 0.012 + vec2f(7.0, 3.0)) * 0.6;
  return n + big - (1.0 - SKY.atmo.z);
}
fn highSoft(fp: f32) -> f32 { return 0.85 + min(fp * 0.2, 1.0) * 0.3; }
fn highDensity(q: vec2f, fp: f32, oct: i32) -> f32 {
  return clamp(highEdge(q, fp, oct) / highSoft(fp), 0.0, 1.0);
}

struct CloudHit { t: f32, q: vec2f, mu: f32, up: vec3f };
fn hitLayer(dir: vec3f, hc: f32) -> CloudHit {
  var h: CloudHit;
  let ro = vec3f(0.0, camR(), 0.0);
  h.t = raySphere(ro, dir, RG + hc).y;
  let p = ro + dir * h.t;
  h.up = p / length(p);
  h.q = p.xz + SKY.camPos.xz * 0.001;
  h.mu = max(dot(h.up, dir), 0.03);
  return h;
}

// d: density at the hit; s1..s3: densities 80 m / 250 m / 600 m towards the sun
fn shadeLayer(dir: vec3f, h: CloudHit, hc: f32, d: f32, s1: f32, s2: f32, s3: f32, sigma: f32, g: f32) -> vec4f {
  let tau = d * sigma / h.mu;
  let alpha = 1.0 - exp(-tau);
  let tauS = (d * 0.5 + s1 * 0.6 + s2 + s3 * 0.7) * sigma * 0.55;
  let Ts = exp(-tauS);
  let sunC = sampleTrans(RG + hc, dot(h.up, SKY.sunDir.xyz)) * SKY.sunDir.w * SKY.sunTint.rgb
             * smoothstep(-0.03, 0.0, dot(h.up, SKY.sunDir.xyz));
  let cosT = dot(dir, SKY.sunDir.xyz);
  let ph = mix(phaseHG(cosT, g), phaseHG(cosT, -0.2), 0.25);
  let fwd = smoothstep(-0.2, 0.7, cosT);
  // single scattering: reflected when front-lit, transmitted through thin parts when back-lit
  let single = sunC * Ts * ph * mix(alpha * 0.55, tau * exp(-tau) * 2.2, fwd) * 3.0;
  // edges where density falls off towards the sun catch direct light
  let rim = clamp((d - s1) * 2.5, 0.0, 1.0);
  // multiple scattering: a low sun lights cloud tops and sun-facing flanks, not the bases seen from below
  let toward = smoothstep(-0.3, 0.9, cosT);
  let ms = sunC * (0.025 + 0.22 * rim) * mix(1.0, Ts, 0.5) * alpha * (0.25 + 0.75 * toward);
  // bases are lit by the sky from the sides and below, cooler than the tops
  let amb = (skyAtmo(normalize(vec3f(dir.x, 0.03, dir.z))) * 0.26 + skyAtmo(vec3f(0.0, 1.0, 0.0)) * 0.42)
            * alpha * (1.0 - 0.35 * d);
  return vec4f(single + ms + amb, alpha);
}

// (premultiplied radiance, fraction of the sky behind hidden). pixAng: a pixel's angular size.
fn cloudLayers(dir: vec3f, pixAng: f32, sunT: ptr<function, f32>) -> vec4f {
  *sunT = 1.0;
  if (dir.y <= 0.0) { return vec4f(0.0); }
  let sxz = SKY.sunDir.xz / max(length(SKY.sunDir.xz), 1e-4);
  var lo = vec4f(0.0);
  var loVis = 1.0;
  if (SKY.cloudP.y > 0.001) {
    let hc = SKY.cloudP.x;
    let h = hitLayer(dir, hc);
    // clear band near the horizon, where a low sun shines under the clouds
    let far = 1.0 - smoothstep(18.0, 36.0, h.t);
    if (far > 0.0) {
      let fp = h.t * pixAng / h.mu;
      let e = lowEdge(h.q, fp, 7);
      let d = clamp(e / lowSoft(fp), 0.0, 1.0) * far;
      if (d > 0.002) {
        let s1 = lowDensity(h.q + sxz * 0.08, fp, 5) * far;
        let s2 = lowDensity(h.q + sxz * 0.25, fp, 4) * far;
        let s3 = lowDensity(h.q + sxz * 0.6, fp, 3) * far;
        lo = shadeLayer(dir, h, hc, d, s1, s2, s3, SKY.cloudP.z, 0.75);
        // opacity saturates within a sliver of the density ramp: spread the silhouette over ~1.5 pixels
        lo *= smoothstep(0.0, fp * 0.38 * 2.5 * 1.5 + 1e-6, e);
        loVis = exp(-h.t * 0.02 * (0.6 + 0.4 * SKY.atmo.x));
      }
    }
  }
  var hi = vec4f(0.0);
  var hiVis = 1.0;
  if (SKY.atmo.z > 0.001) {
    let hc = 4.5;
    let h = hitLayer(dir, hc);
    let far = 1.0 - smoothstep(30.0, 70.0, h.t);
    if (far > 0.0) {
      let fp = h.t * pixAng / h.mu;
      let e = highEdge(h.q, fp, 6);
      let d = clamp(e / highSoft(fp), 0.0, 1.0) * far;
      if (d > 0.002) {
        let s1 = highDensity(h.q + sxz * 0.15, fp, 4) * far;
        let s2 = highDensity(h.q + sxz * 0.5, fp, 3) * far;
        hi = shadeLayer(dir, h, hc, d, s1, s2, s2, SKY.atmo.w, 0.80);
        hi *= smoothstep(0.0, fp * 0.2 * 2.5 * 1.5 + 1e-6, e);
        hiVis = exp(-h.t * 0.010 * (0.6 + 0.4 * SKY.atmo.x));
      }
    }
  }
  *sunT = (1.0 - lo.a) * (1.0 - hi.a);
  // low layer in front; aerial perspective fades each layer into the haze
  let col = lo.rgb * loVis + hi.rgb * hiVis * (1.0 - lo.a);
  let hidden = lo.a * loVis + hi.a * hiVis * (1.0 - lo.a);
  return vec4f(col, hidden);
}

fn sunDisk(dir: vec3f, pixAng: f32) -> vec3f {
  let c = dot(dir, SKY.sunDir.xyz);
  let ang = sqrt(max(2.0 * (1.0 - c), 0.0));
  let pix = max(pixAng * 0.75, 1e-5);
  let edge = 1.0 - smoothstep(SUN_ANG_R - pix, SUN_ANG_R + pix, ang);
  if (edge <= 0.0) { return vec3f(0.0); }
  let x = min(ang / SUN_ANG_R, 1.0);
  let mu = sqrt(max(1.0 - x * x, 0.0));
  let limb = vec3f(1.0) - vec3f(0.397, 0.503, 0.652) * (1.0 - mu);
  let rad = SKY.sunDir.w / (PI * SUN_ANG_R * SUN_ANG_R);
  return rad * limb * edge * sampleTrans(camR(), max(dir.y, -0.01)) * SKY.sunTint.rgb * select(0.0, 1.0, dir.y > -0.004);
}

fn moonDisk(dir: vec3f, pixAng: f32) -> vec3f {
  let c = dot(dir, -SKY.sunDir.xyz);
  let ang = sqrt(max(2.0 * (1.0 - c), 0.0));
  let R = 0.0045;
  let pix = max(pixAng * 0.75, 1e-5);
  let edge = 1.0 - smoothstep(R - pix, R + pix, ang);
  if (edge <= 0.0 || dir.y < -0.004) { return vec3f(0.0); }
  // A few darker seas on its face.
  let q = (dir + SKY.sunDir.xyz) / R;
  let seas = 1.0 - 0.25 * smoothstep(0.2, 0.6, gnoise(q.xz * 1.7 + vec2f(3.1, 1.7)) + 0.5);
  return SKY.moon.rgb / (PI * R * R) * 0.02 * seas * edge * smoothstep(0.0, 0.05, -SKY.sunDir.y);
}

fn skyRadiance(dirIn: vec3f, withSun: bool, pixAng: f32) -> vec3f {
  var dir = dirIn;
  dir.y = max(dir.y, 0.0005);
  dir = normalize(dir);
  var L = skyAtmo(dir);
  var sunT = 1.0;
  let cl = cloudLayers(dir, pixAng, &sunT);
  L = L * (1.0 - cl.a) + cl.rgb;
  if (withSun) { L += (sunDisk(dir, pixAng) + moonDisk(dirIn, pixAng)) * sunT; }
  return L;
}

// Light bounced up off the ground (lit by the sun and the sky overhead), for surfaces facing down.
fn groundBounce() -> vec3f {
  let E = lightIlluminance() * abs(SKY.sunDir.y) + skyAtmo(vec3f(0.0, 1.0, 0.0)) * PI * 1.2;
  return SKY.ground.rgb * E / PI;
}

// The colour distance fog fades to: the sky just above the horizon in that direction.
fn fogColor(rd: vec3f) -> vec3f {
  let haze = skyAtmo(normalize(vec3f(rd.x, max(rd.y, 0.02), rd.z)));
  return mix(haze, SKY.bg.rgb / 0.95, SKY.bg.w * SKY.misc.z); // (/0.95: callers dim it by that)
}
fn fogDensity() -> f32 { return SKY.misc.x; }
`;

// Lighting from the environment cube. Needs skyEnv as well.
const SKY_LIGHT_WGSL = /* wgsl */ `
const ENV_MAXMIP: f32 = ${ENV_MIPS - 1}.0;
const ENV_TEXELS_PER_RAD: f32 = ${ENV_SIZE}.0 / 1.5708;

fn envSky(dir: vec3f, lod: f32) -> vec3f { return textureSampleLevel(skyEnv, skySamp, dir, lod).rgb; }

// Light from the sky (and the ground below it) reaching a diffuse surface facing n, as radiance: multiply by albedo.
fn ambient(n: vec3f) -> vec3f {
  // Facing up: the whole sky, cosine weighted (roughly: the zenith and four directions around the horizon).
  let m = ENV_MAXMIP - 1.0;
  let up = envSky(vec3f(0.0, 1.0, 0.0), ENV_MAXMIP) * 0.4 + 0.15 * (envSky(vec3f(0.94, 0.34, 0.0), m) +
    envSky(vec3f(-0.94, 0.34, 0.0), m) + envSky(vec3f(0.0, 0.34, 0.94), m) + envSky(vec3f(0.0, 0.34, -0.94), m));
  // Facing sideways: the sky on that side.
  let side = envSky(normalize(vec3f(n.x, 0.35, n.z)), m);
  let sky = mix(side, up, max(n.y, 0.0));
  return mix(groundBounce() + nightGlow(vec3f(0.0, 1.0, 0.0)) * 0.5, sky, n.y * 0.5 + 0.5);
}

// Stars, fading in as the sky darkens.
fn stars(dir: vec3f, pixAng: f32) -> vec3f {
  let dark = 1.0 - smoothstep(-0.14, -0.02, SKY.sunDir.y);
  if (dark <= 0.0 || dir.y <= 0.0) { return vec3f(0.0); }
  let cells = 260.0;
  let p = dir * cells;
  let c = vec3i(floor(p));
  let h = pcgHash((u32(c.x) * 73856093u) ^ (u32(c.y) * 19349663u) ^ (u32(c.z) * 83492791u));
  if ((h & 255u) > 6u) { return vec3f(0.0); }
  let j = vec3f(f32((h >> 8u) & 255u), f32((h >> 16u) & 255u), f32(h >> 24u)) / 255.0;
  let d = length(p - (vec3f(c) + 0.2 + j * 0.6));
  let size = max(pixAng * cells * 0.8, 0.06);
  let b = (1.0 - smoothstep(0.0, size, d)) * (0.3 + j.x * j.x * 2.0);
  let tint = mix(vec3f(0.75, 0.85, 1.0), vec3f(1.0, 0.88, 0.7), j.y);
  return tint * b * dark * smoothstep(0.0, 0.15, dir.y) * SKY.misc.y * 0.6;
}

// What a ray that misses everything sees: the sky, clouds and sun, and below the horizon the haze.
fn skyBackground(rd: vec3f, pixAng: f32) -> vec3f {
  let st = stars(rd, pixAng);
  let col = (skyRadiance(rd, true, pixAng) + st) * mix(1.0, 0.85, clamp(-rd.y * 4.0, 0.0, 1.0));
  return mix(col, SKY.bg.rgb + st, SKY.bg.w);
}
`;

const bindings = (group, env) => /* wgsl */ `
@group(${group}) @binding(0) var<uniform> SKY: SkyFrame;
@group(${group}) @binding(1) var skyTrans: texture_2d<f32>;
@group(${group}) @binding(2) var skyLUT: texture_2d<f32>;
@group(${group}) @binding(3) var skySamp: sampler;
${env ? `@group(${group}) @binding(4) var skyEnv: texture_cube<f32>;` : ''}
`;

// Everything a shader needs to be lit by the sky, with Sky.layout's bindings in bind group `group`:
// sunIlluminance(), ambient(n), envSky(dir, lod), skyAtmo(dir), skyBackground(rd, pixAng), fogColor(rd),
// fogDensity(). Defines PI.
export function skyWgsl(group) {
  return SKY_FRAME_WGSL + ATMO_CORE_WGSL + bindings(group, true) + SKY_FUNCS_WGSL + SKY_LIGHT_WGSL;
}

// ---- LUTs and the environment cube --------------------------------------------------------------------------

const ATMO_UNIFORM = /* wgsl */ `
struct AtmoP { haze: vec4f };   // x = Mie multiplier
@group(0) @binding(0) var<uniform> A: AtmoP;
`;

const TRANS_LUT = ATMO_CORE_WGSL + ATMO_UNIFORM + /* wgsl */ `
@group(0) @binding(1) var dst: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= TRANS_W || f32(id.y) >= TRANS_H) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(TRANS_W, TRANS_H);
  let rm = transUVToRMu(uv);
  let ro = vec3f(0.0, rm.x, 0.0);
  let rd = vec3f(sqrt(max(0.0, 1.0 - rm.y * rm.y)), rm.y, 0.0);
  let tMax = raySphere(ro, rd, RT).y;
  var od = vec3f(0.0);
  let STEPS = 64u;
  let dt = tMax / f32(STEPS);
  for (var i = 0u; i < STEPS; i++) {
    let p = ro + rd * ((f32(i) + 0.5) * dt);
    od += medium(length(p) - RG, A.haze.x).ext * dt;
  }
  textureStore(dst, id.xy, vec4f(exp(-od), 1.0));
}
`;

const MS_LUT = ATMO_CORE_WGSL + ATMO_UNIFORM + /* wgsl */ `
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var sampC: sampler;
@group(0) @binding(3) var dst: texture_storage_2d<rgba16float, write>;

fn sampleTrans(r: f32, mu: f32) -> vec3f {
  return textureSampleLevel(transLUT, sampC, transRMuToUV(r, mu), 0.0).rgb;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= MS_SIZE || f32(id.y) >= MS_SIZE) { return; }
  var uv = (vec2f(id.xy) + 0.5) / MS_SIZE;
  uv = vec2f(fromSubUvsToUnit(uv.x, MS_SIZE), fromSubUvsToUnit(uv.y, MS_SIZE));
  let cosSun = uv.x * 2.0 - 1.0;
  let h = max(uv.y * (RT - RG), 0.01);
  let r = RG + h;
  let ro = vec3f(0.0, r, 0.0);
  let sun = vec3f(sqrt(max(0.0, 1.0 - cosSun * cosSun)), cosSun, 0.0);
  var Lsum = vec3f(0.0);
  var Fsum = vec3f(0.0);
  let SQ = 8u;
  let STEPS = 20u;
  for (var a = 0u; a < SQ; a++) {
    for (var b = 0u; b < SQ; b++) {
      let th = acos(1.0 - 2.0 * (f32(b) + 0.5) / f32(SQ));
      let ph = 2.0 * PI * (f32(a) + 0.5) / f32(SQ);
      let rd = vec3f(sin(th) * cos(ph), cos(th), sin(th) * sin(ph));
      let tTop = raySphere(ro, rd, RT);
      let tGr = raySphere(ro, rd, RG);
      var tMax = tTop.y;
      let hitG = tGr.x > 0.0;
      if (hitG) { tMax = tGr.x; }
      let dt = tMax / f32(STEPS);
      var T = vec3f(1.0);
      var L = vec3f(0.0);
      var Fms = vec3f(0.0);
      for (var s = 0u; s < STEPS; s++) {
        let p = ro + rd * ((f32(s) + 0.5) * dt);
        let pr = length(p);
        let m = medium(pr - RG, A.haze.x);
        let scat = m.rayS + vec3f(m.mieS);
        let Ts = exp(-m.ext * dt);
        let smu = dot(p, sun) / pr;
        var sunT = sampleTrans(pr, smu);
        if (sunBelowHorizon(pr, smu)) { sunT = vec3f(0.0); }
        let ext = max(m.ext, vec3f(1e-9));
        let S = scat * sunT / (4.0 * PI);
        L += T * (S - S * Ts) / ext;
        Fms += T * (scat - scat * Ts) / ext;
        T *= Ts;
      }
      if (hitG) {
        let pg = ro + rd * tMax;
        let ng = normalize(pg);
        let smu = dot(ng, sun);
        L += T * sampleTrans(RG, smu) * max(smu, 0.0) * 0.06 / PI;
      }
      Lsum += L;
      Fsum += Fms;
    }
  }
  let invN = 1.0 / f32(SQ * SQ);
  textureStore(dst, id.xy, vec4f(Lsum * invN / (1.0 - Fsum * invN), 1.0));
}
`;

// Sky-view LUT: the sky's radiance by direction relative to the sun, recomputed each frame.
const SKYVIEW_LUT = SKY_FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> SKY: SkyFrame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var msLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var dst: texture_storage_2d<rgba16float, write>;

fn sampleTrans(r: f32, mu: f32) -> vec3f {
  return textureSampleLevel(transLUT, sampC, transRMuToUV(r, mu), 0.0).rgb;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= SKY_W || f32(id.y) >= SKY_H) { return; }
  var uv = (vec2f(id.xy) + 0.5) / vec2f(SKY_W, SKY_H);
  uv = vec2f(fromSubUvsToUnit(uv.x, SKY_W), fromSubUvsToUnit(uv.y, SKY_H));
  let haze = SKY.atmo.x;
  let r = RG + SKY.atmo.y;
  let vHorizon = rhoOf(r);
  let cosBeta = vHorizon / r;
  let beta = acos(clamp(cosBeta, -1.0, 1.0));
  let zha = PI - beta;
  var vza: f32;
  if (uv.y < 0.5) {
    var coord = 2.0 * uv.y;
    coord = 1.0 - coord;
    coord *= coord;
    coord = 1.0 - coord;
    vza = zha * coord;
  } else {
    var coord = uv.y * 2.0 - 1.0;
    coord *= coord;
    vza = zha + beta * coord;
  }
  let vzc = cos(vza);
  let vzs = sin(vza);
  let cx = uv.x * uv.x;
  let lvc = -(cx * 2.0 - 1.0);
  let lvs = sqrt(max(0.0, 1.0 - lvc * lvc));
  let rd = vec3f(vzs * lvc, vzc, vzs * lvs);
  let smu = SKY.sunDir.y;
  let sun = vec3f(sqrt(max(0.0, 1.0 - smu * smu)), smu, 0.0);
  let ro = vec3f(0.0, r, 0.0);

  let tTop = raySphere(ro, rd, RT);
  let tGr = raySphere(ro, rd, RG);
  var tMax = tTop.y;
  if (tGr.x > 0.0) { tMax = tGr.x; }
  let cosT = dot(rd, sun);
  let pR = phaseRayleigh(cosT);
  let pM = phaseMie(cosT, 0.84);
  var L = vec3f(0.0);
  var T = vec3f(1.0);
  let STEPS = 48u;
  var tPrev = 0.0;
  for (var i = 0u; i < STEPS; i++) {
    let fa = (f32(i) + 1.0) / f32(STEPS);
    let tn = tMax * fa * fa;
    let dt = tn - tPrev;
    let t = tPrev + dt * 0.3;
    tPrev = tn;
    let p = ro + rd * t;
    let pr = length(p);
    let h = pr - RG;
    let m = medium(h, haze);
    let pmu = dot(p, sun) / pr;
    var sunT = sampleTrans(pr, pmu);
    if (sunBelowHorizon(pr, pmu)) { sunT = vec3f(0.0); }
    let msuv = vec2f(fromUnitToSubUvs(pmu * 0.5 + 0.5, MS_SIZE), fromUnitToSubUvs(clamp(h / (RT - RG), 0.0, 1.0), MS_SIZE));
    let ms = textureSampleLevel(msLUT, sampC, msuv, 0.0).rgb;
    let S = sunT * (m.rayS * pR + vec3f(m.mieS * pM)) + ms * (m.rayS + vec3f(m.mieS));
    let Ts = exp(-m.ext * dt);
    let ext = max(m.ext, vec3f(1e-9));
    L += T * (S - S * Ts) / ext;
    T *= Ts;
  }
  textureStore(dst, id.xy, vec4f(L, 1.0));
}
`;

// The environment cube: sky and clouds above the horizon, light bounced off the ground below it. A few faces are
// refreshed each frame: face = (frame + z) % 6.
const ENV_CUBE = SKY_FRAME_WGSL + ATMO_CORE_WGSL + bindings(0, false) + /* wgsl */ `
@group(0) @binding(4) var dst: texture_storage_2d_array<rgba16float, write>;
` + SKY_FUNCS_WGSL + /* wgsl */ `
const ENV: f32 = ${ENV_SIZE}.0;
fn faceDir(face: u32, uv: vec2f) -> vec3f {
  let u = uv.x * 2.0 - 1.0;
  let v = uv.y * 2.0 - 1.0;
  switch (face) {
    case 0u: { return vec3f(1.0, -v, -u); }
    case 1u: { return vec3f(-1.0, -v, u); }
    case 2u: { return vec3f(u, 1.0, v); }
    case 3u: { return vec3f(u, -1.0, -v); }
    case 4u: { return vec3f(u, -v, 1.0); }
    default: { return vec3f(-u, -v, -1.0); }
  }
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= ENV || f32(id.y) >= ENV) { return; }
  let face = (u32(SKY.camPos.w) + id.z) % 6u;
  let dir = normalize(faceDir(face, (vec2f(id.xy) + 0.5) / ENV));
  var L: vec3f;
  if (dir.y >= 0.0) {
    L = skyRadiance(dir, false, 1.5708 / ENV * 1.5);
  } else {
    let hz = skyRadiance(normalize(vec3f(dir.x, 0.004, dir.z)), false, 1.5708 / ENV * 1.5);
    L = mix(hz * 0.75, groundBounce(), clamp(-dir.y * 6.0, 0.0, 1.0));
  }
  textureStore(dst, id.xy, face, vec4f(L, 1.0));
}
`;

const CUBE_MIPS = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let srcSize = vec2i(textureDimensions(src));
  let p = vec2i(id.xy) * 2;
  // 4x4 tent-ish filter for a smoother blur
  var acc = vec4f(0.0);
  var wsum = 0.0;
  for (var j = -1; j <= 2; j++) {
    for (var i = -1; i <= 2; i++) {
      let q = clamp(p + vec2i(i, j), vec2i(0), srcSize - 1);
      let w = select(1.0, 3.0, i == 0 || i == 1) * select(1.0, 3.0, j == 0 || j == 1);
      acc += textureLoad(src, q, id.z, 0) * w;
      wsum += w;
    }
  }
  textureStore(dst, id.xy, id.z, acc / wsum);
}
`;

export const SKY_SHADERS = { TRANS_LUT, MS_LUT, SKYVIEW_LUT, ENV_CUBE, CUBE_MIPS };

const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// The background colour for a sun this high (sunY: the sun direction's y): night, through dusk around the
// horizon, to day. As radiance that tone maps (render.js: c / (1 + 0.12c)) back to the colour picked.
export function backgroundColor(T, sunY) {
  const night = linearColor(T.bgNight), dusk = linearColor(T.bgDusk), day = linearColor(T.bgDay);
  const a = smoothstep(-0.2, -0.02, sunY), b = smoothstep(0.02, 0.3, sunY);
  return night.map((n, i) => {
    const c = Math.min(0.99, n + (dusk[i] - n) * a + (day[i] - dusk[i]) * b);
    return c / (1 - 0.12 * c);
  });
}

// '#rrggbb' to linear rgb.
export function linearColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [16, 8, 0].map((s) => {
    const c = ((n >> s) & 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
}

// The direction towards the sun for the tuning's hour, latitude, season and north.
export function sunDirection(T = SKY_TUNING) {
  const h = (T.timeOfDay - 12) * 15 * D2R, lat = T.latitude * D2R, dec = T.season * D2R, n = T.north * D2R;
  const up = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(h) * Math.cos(lat);
  const east = -Math.cos(dec) * Math.sin(h);
  const north = Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.cos(h) * Math.sin(lat);
  return [east * Math.cos(n) + north * Math.sin(n), up, east * Math.sin(n) - north * Math.cos(n)];
}

export class Sky {
  constructor(device) {
    this.device = device;
    const TU = GPUTextureUsage, GU = GPUBufferUsage;
    const tex = (label, w, h, layers = 1, mips = 1) => device.createTexture({
      label, size: [w, h, layers], format: 'rgba16float', mipLevelCount: mips,
      usage: TU.TEXTURE_BINDING | TU.STORAGE_BINDING | TU.COPY_SRC, // copy: for reading back when debugging
    });
    this.trans = tex('sky transmittance', TRANS_W, TRANS_H);
    this.ms = tex('sky multiple scattering', MS_SIZE, MS_SIZE);
    this.view = tex('sky view', SKY_W, SKY_H);
    this.env = tex('sky environment cube', ENV_SIZE, ENV_SIZE, 6, ENV_MIPS);
    this.uniforms = device.createBuffer({ label: 'sky frame', size: 160, usage: GU.UNIFORM | GU.COPY_DST });
    this.atmo = device.createBuffer({ label: 'sky haze', size: 16, usage: GU.UNIFORM | GU.COPY_DST });
    this.data = new Float32Array(40);
    this.samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });

    const compute = (code, label) => device.createComputePipeline({
      label, layout: 'auto', compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' },
    });
    const bg = (pipe, entries) => device.createBindGroup({
      layout: pipe.getBindGroupLayout(0), entries: entries.map((resource, binding) => ({ binding, resource })),
    });
    const transPipe = compute(TRANS_LUT, 'sky transmittance');
    const msPipe = compute(MS_LUT, 'sky multiple scattering');
    const viewPipe = compute(SKYVIEW_LUT, 'sky view');
    const envPipe = compute(ENV_CUBE, 'sky environment cube');
    const mipPipe = compute(CUBE_MIPS, 'sky environment mips');
    const mip = (m) => this.env.createView({ dimension: '2d-array', baseMipLevel: m, mipLevelCount: 1 });
    const u = { buffer: this.uniforms };
    this.passes = {
      trans: [transPipe, bg(transPipe, [{ buffer: this.atmo }, this.trans.createView()])],
      ms: [msPipe, bg(msPipe, [{ buffer: this.atmo }, this.trans.createView(), this.samp, this.ms.createView()])],
      view: [viewPipe, bg(viewPipe, [u, this.trans.createView(), this.ms.createView(), this.samp, this.view.createView()])],
      env: [envPipe, bg(envPipe, [u, this.trans.createView(), this.view.createView(), this.samp, mip(0)])],
      mips: Array.from({ length: ENV_MIPS - 1 }, (_, i) => bg(mipPipe, [mip(i), mip(i + 1)])),
      mipPipe,
    };

    // What shaders lit by the sky bind (see skyWgsl).
    const FRAG = GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE; // (compute: the probe light, skyvis.js)
    this.layout = device.createBindGroupLayout({
      label: 'sky',
      entries: [
        { binding: 0, visibility: FRAG, buffer: { type: 'uniform' } },
        { binding: 1, visibility: FRAG, texture: {} },
        { binding: 2, visibility: FRAG, texture: {} },
        { binding: 3, visibility: FRAG, sampler: {} },
        { binding: 4, visibility: FRAG, texture: { viewDimension: 'cube' } },
      ],
    });
    this.group = device.createBindGroup({
      label: 'sky',
      layout: this.layout,
      entries: [
        { binding: 0, resource: u },
        { binding: 1, resource: this.trans.createView() },
        { binding: 2, resource: this.view.createView() },
        { binding: 3, resource: this.samp },
        { binding: 4, resource: this.env.createView({ dimension: 'cube' }) },
      ],
    });
    this.haze = null;    // the haze the LUTs were built for
    this.settings = '';  // the settings the environment cube was built for
    this.frame = 0;
    this.time = 0;
    this.sun = sunDirection();
    this.light = this.sun;
  }

  // Advances the clock, places the sun and updates the LUTs and environment cube for this frame.
  // frame: { dt, eye }
  update(encoder, frame, profiler) {
    const T = SKY_TUNING;
    T.timeOfDay = (((T.timeOfDay + frame.dt * T.timeSpeed / 60) % 24) + 24) % 24;
    this.time += frame.dt;
    this.sun = sunDirection(T);
    this.light = this.sun[1] >= 0 ? this.sun : this.sun.map((v) => -v); // the sun, or the moon opposite it
    // Auto exposure, roughly as an eye or camera adapts: up to 3.5× brighter as the sun goes down.
    const light = 0.25 + 0.75 * smoothstep(-0.1, 0.5, this.sun[1]);
    this.exposure = T.exposure * Math.min(3.5, 1 / light) ** T.autoExposure;
    const d = this.data, e = this.exposure;
    d.set([...this.sun, 7 * e], 0); // web-ocean's sun is 14 with its exposure of about half
    d.set([...linearColor(T.sunColor).map((c) => c * T.sunStrength), 0], 4);
    d.set([...linearColor(T.skyColor).map((c) => c * T.skyStrength), T.nightLight * e], 8);
    d.set([T.haze, 0.05, T.highClouds, 0.9], 12);
    d.set([1.5, T.clouds, 2.2, this.time], 16);
    d.set([...frame.eye, this.frame], 20);
    d.set([0.26, 0.24, 0.17, 0], 24);
    d.set([0.0004 * T.fog, e, T.bgFog, 0], 28);
    d.set([...linearColor(T.moonColor).map((c) => c * 0.45 * T.moonStrength * e), 0], 32);
    d.set([...backgroundColor(T, this.sun[1]), T.background], 36);
    this.device.queue.writeBuffer(this.uniforms, 0, d);

    const cp = encoder.beginComputePass({ label: 'sky', timestampWrites: profiler?.tsw('sky: atmosphere + environment') });
    const run = ([pipe, group], x, y, z = 1) => { cp.setPipeline(pipe); cp.setBindGroup(0, group); cp.dispatchWorkgroups(x, y, z); };
    if (this.haze !== T.haze) {
      this.haze = T.haze;
      this.device.queue.writeBuffer(this.atmo, 0, new Float32Array([T.haze, 0, 0, 0]));
      run(this.passes.trans, TRANS_W / 8, TRANS_H / 8);
      run(this.passes.ms, MS_SIZE / 8, MS_SIZE / 8);
    }
    run(this.passes.view, SKY_W / 8, SKY_H / 8);
    // All six faces when something changed (a slider moved, or the clock is running), else two a frame for the
    // drifting clouds.
    const settings = JSON.stringify([this.sun, T.sunColor, T.sunStrength, T.skyColor, T.skyStrength, T.moonColor, T.moonStrength, T.nightLight, T.haze, T.clouds, T.highClouds, e, T.fog]);
    const faces = settings === this.settings ? 2 : 6;
    this.settings = settings;
    run(this.passes.env, ENV_SIZE / 8, ENV_SIZE / 8, faces);
    cp.setPipeline(this.passes.mipPipe);
    for (let m = 1; m < ENV_MIPS; m++) {
      const s = Math.max(1, ENV_SIZE >> m);
      cp.setBindGroup(0, this.passes.mips[m - 1]);
      cp.dispatchWorkgroups(Math.ceil(s / 8), Math.ceil(s / 8), 6);
    }
    cp.end();
    this.frame = (this.frame + faces) % 6;
  }
}
