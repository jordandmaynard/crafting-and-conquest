// Sound, all synthesized: no sound files. Each sound is a recipe, a few lines of DSP (noise, oscillators, filters,
// decaying partials, plucked strings) rendered into an AudioBuffer once, when the page first gets a click or a key (the
// browser allows sound only then), in a few variants so repeats differ. Game code anywhere calls sfx(name, pos, opts)
// at the moment something happens; it does nothing until then, and nothing in Node (the sims).
//
// A sound in the world is placed by the camera: louder near the middle of the screen and fading off it, panned left or
// right by where it is on screen, and quieter the further the camera (the listener) is from it (small sounds, footsteps
// and pebbles, fade most as it pulls back; an explosion carries). The steady sounds of things that are always there
// (the waves, a torch's crackle, a power crystal's hum) have a reach (AUDIO_TUNING ambientReach): heard only with the
// camera close to them. Nothing plays from where the player can't see (fog of war). Too many at once are cut: at
// most AUDIO_TUNING.voices playing, and a few of one sound at a time (a 40-unit battle reads as a battle). Each play is pitched a little at random. Slow motion (main.js GAME_SPEED) slows and lowers every sound
// but the interface's with the game.
//
// Steady sounds (water, wind, insects at night, fire, a barbarian's whirl, fireballs in flight, a priest's beam, the
// power crystals' hum) are loops whose volume and pan follow what's on screen each frame (bed, emit).
//
// Voices (a villager hurt or dying, a horse, units answering orders) are hooked up but silent: they need recordings.
//
// Tuning: T > Sound (the mix), and a volume and pitch for each sound in T > Sound: combat, work, world, interface.

const TAU = Math.PI * 2;

export const AUDIO_TUNING = {
  on: 1,           // 1: sound on
  master: 0.8,     // everything
  combat: 1,       // each group's volume
  work: 0.8,
  world: 0.7,
  ui: 0.6,
  near: 80,        // voxels from the camera a sound's at full volume; further, it fades (small sounds most)
  zoomFade: 1,     // how much the camera pulling back fades small sounds (0: not at all)
  offscreen: 0.6,  // how fast a sound fades past the edge of the screen (screen half-widths to fall to a half)
  ambientReach: 35, // the steady sounds of things that are always there (the waves, a torch's crackle, a power crystal's
                   // hum) are heard this near them (voxels from the camera to a half; twice as far, hardly at all)
  ambientFall: 6,  // and how sharply they fall off past that (higher: quicker)
  windLow: 0.05,   // the wind's level with the camera down low, and pulled all the way back (none on the menus)
  windHigh: 0.25,
  pan: 0.7,        // how far left or right a sound at the screen's edge is panned (0-1)
  voices: 24,      // sounds playing at once, at most (the interface's aside)
  merge: 0.06,     // seconds within which repeats of one sound count together
  mergeMax: 3,     // how many of one sound may start within that
  variety: 0.07,   // how much each play's pitch varies at random (share)
  alertEvery: 8,   // seconds between "under attack" alerts at most
  thud: 1.5,       // fallen bodies and gear sound when they land faster than this (voxels/s)
};

// --- DSP: a few building blocks, each working on Float32Arrays at the context's sample rate -------------------------

function rng(seed) {
  let s = (seed * 2654435761 + 1013904223) >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

class Synth {
  constructor(sr, seed) {
    this.sr = sr;
    this.rand = rng(seed);
  }
  buf(sec) { return new Float32Array(Math.max(1, Math.round(sec * this.sr))); }
  r(a, b) { return a + (b - a) * this.rand(); }

  // White noise; brown noise (a leaky integral of it: a rumble).
  noise(sec) {
    const b = this.buf(sec);
    for (let i = 0; i < b.length; i++) b[i] = this.rand() * 2 - 1;
    return b;
  }
  brown(sec) {
    const b = this.buf(sec);
    let y = 0;
    for (let i = 0; i < b.length; i++) { y = y * 0.995 + (this.rand() * 2 - 1) * 0.1; b[i] = y; }
    return b;
  }
  // An oscillator: f in Hz, or a function of time (seconds) giving it.
  tone(sec, f, shape = 'sine') {
    const b = this.buf(sec), sr = this.sr, fixed = typeof f === 'number';
    let ph = this.rand();
    for (let i = 0; i < b.length; i++) {
      ph += (fixed ? f : f(i / sr)) / sr;
      const p = ph - Math.floor(ph);
      b[i] = shape === 'sine' ? Math.sin(TAU * p) : shape === 'saw' ? 2 * p - 1 : shape === 'square' ? (p < 0.5 ? 1 : -1) : 1 - 4 * Math.abs(p - 0.5);
    }
    return b;
  }
  // Frequency modulation: a carrier at fc (Hz or function) moved by a sine at fc × ratio, index (number or function).
  fm(sec, fc, ratio, index) {
    const b = this.buf(sec), sr = this.sr;
    let pc = 0, pm = 0;
    for (let i = 0; i < b.length; i++) {
      const t = i / sr, f = typeof fc === 'number' ? fc : fc(t), k = typeof index === 'number' ? index : index(t);
      pc += f / sr;
      pm += (f * ratio) / sr;
      b[i] = Math.sin(TAU * pc + k * Math.sin(TAU * pm));
    }
    return b;
  }
  // Decaying sine partials, [[Hz, seconds to fall to 1/e, amplitude], ...], each detuned a little at random (`jitter`):
  // struck metal, glass and wood.
  modes(sec, list, jitter = 0.02) {
    const b = this.buf(sec), sr = this.sr;
    for (const [f0, d, a = 1] of list) {
      const f = f0 * (1 + (this.rand() - 0.5) * 2 * jitter), ph = this.rand() * TAU, k = Math.exp(-1 / (d * sr));
      let e = a;
      for (let i = 0; i < b.length; i++) { b[i] += e * Math.sin(TAU * f * (i / sr) + ph); e *= k; if (e < 1e-5) break; }
    }
    return b;
  }
  // A plucked string (Karplus-Strong) at f Hz: damp near 1 rings longer.
  pluck(sec, f, damp = 0.995) {
    const b = this.buf(sec), n = Math.max(2, Math.round(this.sr / f)), line = new Float32Array(n);
    for (let i = 0; i < n; i++) line[i] = this.rand() * 2 - 1;
    for (let i = 0; i < b.length; i++) {
      const j = i % n, y = line[j];
      b[i] = y;
      line[j] = damp * 0.5 * (y + line[(j + 1) % n]);
    }
    return b;
  }
  // Friction: a train of tiny clicks rate (Hz, or a function of time) apart, a little uneven, rung through resonances
  // ([[Hz, Q], ...]): a creaking bow or tree.
  creak(sec, rate, res) {
    const imp = this.buf(sec), sr = this.sr;
    let ph = 0;
    for (let i = 0; i < imp.length; i++) {
      ph += (typeof rate === 'number' ? rate : rate(i / sr)) * (0.7 + 0.6 * this.rand()) / sr;
      if (ph >= 1) { ph -= 1; imp[i] = this.rand() < 0.5 ? 1 : -1; }
    }
    const out = this.buf(sec);
    for (const [f, q] of res) this.add(out, this.filter(imp.slice(), 'bp', f, q));
    return out;
  }
  // A biquad filter (lp, hp or bp), in place: f in Hz or a function of time.
  filter(b, type, f, q = 0.707) {
    const sr = this.sr, fixed = typeof f === 'number';
    let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const set = (hz) => {
      const w = TAU * clamp(hz, 10, sr * 0.45) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
      if (type === 'lp') { b0 = (1 - cs) / 2 / a0; b1 = (1 - cs) / a0; b2 = b0; }
      else if (type === 'hp') { b0 = (1 + cs) / 2 / a0; b1 = -(1 + cs) / a0; b2 = b0; }
      else { b0 = al / a0; b1 = 0; b2 = -al / a0; }
      a1 = -2 * cs / a0;
      a2 = (1 - al) / a0;
    };
    if (fixed) set(f);
    for (let i = 0; i < b.length; i++) {
      if (!fixed && (i & 15) === 0) set(f(i / sr));
      const x = b[i], y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      b[i] = y;
    }
    return b;
  }
  // Envelopes, in place: a fast attack then an exponential fall (tau seconds to 1/e), from `delay`; any function of time;
  // or straight lines through [[seconds, level], ...].
  decay(b, tau, attack = 0.002, delay = 0) {
    const sr = this.sr;
    for (let i = 0; i < b.length; i++) {
      const t = i / sr - delay;
      b[i] *= t < 0 ? 0 : t < attack ? t / attack : Math.exp(-(t - attack) / tau);
    }
    return b;
  }
  shape(b, fn) {
    for (let i = 0; i < b.length; i++) b[i] *= fn(i / this.sr);
    return b;
  }
  env(b, pts) {
    return this.shape(b, (t) => {
      if (t <= pts[0][0]) return pts[0][1];
      for (let k = 1; k < pts.length; k++) {
        if (t <= pts[k][0]) { const [t0, v0] = pts[k - 1], [t1, v1] = pts[k]; return v0 + (v1 - v0) * (t - t0) / (t1 - t0); }
      }
      return pts[pts.length - 1][1];
    });
  }
  // Mixes src into dst at `at` seconds, times gain.
  add(dst, src, gain = 1, at = 0) {
    const o = Math.round(at * this.sr);
    for (let i = 0; i < src.length && i + o < dst.length; i++) if (i + o >= 0) dst[i + o] += src[i] * gain;
    return dst;
  }
  // `n` copies of what make() returns, scattered over [from, from + spread) seconds, each times gain(its time).
  scatter(dst, n, from, spread, make, gain = () => 1) {
    for (let k = 0; k < n; k++) { const t = from + this.rand() * spread; this.add(dst, make(), gain(t) * (0.5 + 0.5 * this.rand()), t); }
    return dst;
  }
  // Scaled to a peak of 1 (in place).
  norm(b) {
    let m = 0;
    for (let i = 0; i < b.length; i++) m = Math.max(m, Math.abs(b[i]));
    if (m > 0) for (let i = 0; i < b.length; i++) b[i] /= m;
    return b;
  }
  // Something real struck: a short burst of noise (falling in `burst` seconds) ringing each of its resonances,
  // [[Hz, seconds to fall to 1/e, amplitude], ...], each detuned a little at random (jitter). Unlike modes' pure sines,
  // every strike starts noisy and rings a little differently, as wood, stone and metal do.
  struck(sec, list, burst = 0.003, jitter = 0.03) {
    const sr = this.sr, ex = this.decay(this.noise(sec), burst, 0.0005), out = this.buf(sec);
    for (const [f0, tau, a = 1] of list) {
      const w = TAU * clamp(f0 * (1 + (this.rand() - 0.5) * 2 * jitter), 20, sr * 0.45) / sr;
      const r = Math.exp(-1 / (tau * sr)), c1 = 2 * r * Math.cos(w), c2 = -r * r, b = this.buf(sec);
      let y1 = 0, y2 = 0;
      for (let i = 0; i < b.length; i++) { const y = ex[i] + c1 * y1 + c2 * y2; b[i] = y; y2 = y1; y1 = y; }
      this.add(out, this.norm(b), a);
    }
    return out;
  }
  // A short knock: noise through a band-pass at f (Q q), falling in tau seconds.
  knock(f, tau, q = 2, sec = tau * 6) { return this.decay(this.filter(this.noise(sec), 'bp', f, q), tau, 0.0008); }
  // A low thump: a dull thud of low noise round f0 Hz, under a little of a sine settling quickly from f0 to f1, gone in
  // tau (mostly noise, so it lands like a weight, not a drum).
  thump(f0, f1, tau, sec = tau * 6) {
    const o = this.decay(this.tone(sec, (t) => f1 + (f0 - f1) * Math.exp(-t / (tau * 0.25))), tau, 0.003);
    const n = this.norm(this.decay(this.filter(this.filter(this.noise(sec), 'lp', f0 * 2.5), 'lp', f0 * 2.5), tau * 0.8, 0.001));
    return this.add(this.shape(o, () => 0.45), n, 1);
  }
}

// Peak-normalised (so recipes are mixed by their gain), with a few milliseconds' fade at the end.
function finish(b, sr) {
  let m = 0;
  for (let i = 0; i < b.length; i++) if (Number.isFinite(b[i])) m = Math.max(m, Math.abs(b[i]));
  const k = m > 0 ? 0.9 / m : 0, fade = Math.min(b.length, Math.round(0.004 * sr));
  for (let i = 0; i < b.length; i++) b[i] = Number.isFinite(b[i]) ? b[i] * k : 0;
  for (let i = 0; i < fade; i++) b[b.length - 1 - i] *= i / fade;
  return b;
}
// A seamless loop: the last `fade` seconds crossfaded into the start (equal power).
function seamless(b, sr, fade) {
  const F = Math.round(fade * sr), L = b.length - F, out = b.slice(0, L);
  for (let i = 0; i < F; i++) { const k = i / F; out[i] = b[i] * Math.sqrt(k) + b[L + i] * Math.sqrt(1 - k); }
  return out;
}

// --- The sounds --------------------------------------------------------------------------------------------------------
// Each: group (combat, work, world, ui), label (T panel), gain (its level in the mix), size (0 a small sound that fades
// as the camera pulls back, 1 one that carries), ui (not placed in the world, never slowed), loop (seconds: a steady
// bed), silent (a voice still to be recorded), and render(s, sec): the sound, from a Synth. Variants: renders with
// different seeds.

const METAL = [[523, 0.22, 1], [1287, 0.16, 0.6], [2290, 0.11, 0.5], [3511, 0.07, 0.3], [4720, 0.05, 0.2]];
const WOOD = [[210, 0.03, 1], [470, 0.02, 0.6], [980, 0.012, 0.45], [1900, 0.006, 0.3]];
// An axe or pick biting in: the blade's sharp crack (wide, very short).
const bite = (s, f = 3500) => s.knock(f, 0.0025, 0.7, 0.03);
// Splinters or grit after a blow: a few tiny crackles.
const crackles = (s, o, n, lo, hi, gain) => s.scatter(o, n, 0.008, 0.09, () => s.knock(s.r(lo, hi), 0.0015, 2, 0.012), (t) => gain * Math.exp(-t * 25));
const GLASS = [[1318, 0.6, 1], [3133, 0.4, 0.6], [5240, 0.25, 0.4], [7550, 0.15, 0.25]];
const clatter = (s, modes, len) => {
  const out = s.buf(len);
  let t = 0, a = 1, gap = s.r(0.1, 0.16);
  for (let k = 0; k < 4 && t < len - 0.1; k++) {
    s.add(out, s.struck(0.3, modes.map(([f, d, m]) => [f * s.r(0.97, 1.03), d * (0.6 + 0.4 * a), m])), a, t);
    s.add(out, s.knock(3000, 0.003, 0.8), a * 0.4, t);
    t += gap; gap *= 0.6; a *= 0.55;
  }
  return out;
};
const pings = (s, notes, step, tau, sec) => {
  const out = s.buf(sec);
  notes.forEach((f, k) => s.add(out, s.modes(tau * 5, [[f, tau, 1], [f * 2.76, tau * 0.4, 0.25]], 0), 1, k * step));
  return out;
};
const brass = (s, notes, durs, sec) => {
  const out = s.buf(sec);
  let t = 0;
  notes.forEach((f, k) => {
    const d = durs[k];
    const n = s.fm(d + 0.3, (tt) => f * (1 + 0.004 * Math.sin(TAU * 5 * tt)), 1, (tt) => 1.2 + 1.8 * Math.min(1, tt / 0.05) * Math.exp(-tt / (d * 0.8)));
    s.env(n, [[0, 0], [0.03, 1], [d, 0.8], [d + 0.3, 0]]);
    s.add(out, s.filter(n, 'lp', 2400), 1, t);
    t += d;
  });
  return out;
};

const RECIPES = {
  // Combat
  swordSwing: { group: 'combat', label: 'Sword swing', gain: 0.45, size: 0.3, render: (s) => s.shape(s.filter(s.noise(0.26), 'bp', (t) => 2600 - 7000 * t, 2.5), (t) => Math.sin(Math.PI * Math.min(1, t / 0.24)) ** 2) },
  swordHit: { group: 'combat', label: 'Sword hits cloth', gain: 0.75, size: 0.4, render: (s) => {
    const o = s.thump(110, 55, 0.07, 0.3);
    s.add(o, s.decay(s.filter(s.noise(0.3), 'lp', 1800), 0.035), 0.8);
    return s.add(o, s.decay(s.filter(s.noise(0.1), 'hp', 3000), 0.012), 0.4);
  } },
  armourHit: { group: 'combat', label: 'Sword hits armour', gain: 0.65, size: 0.45, render: (s) => {
    const o = s.struck(0.6, METAL.map(([f, d, a]) => [f * s.r(0.9, 1.1), d * 0.6, a]), 0.002);
    s.add(o, s.knock(4000, 0.003, 0.8), 0.7);
    return s.add(o, s.thump(120, 60, 0.05, 0.3), 0.5);
  } },
  axeHit: { group: 'combat', label: 'Axe hit', gain: 0.85, size: 0.45, render: (s) => {
    const o = s.thump(85, 40, 0.09, 0.35);
    s.add(o, s.decay(s.filter(s.noise(0.35), 'lp', 1200), 0.06), 0.9);
    return s.add(o, s.knock(600, 0.04, 3), 0.7);
  } },
  whirl: { group: 'combat', label: 'Barbarian whirl', gain: 0.5, size: 0.4, loop: 2, render: (s, sec) => {
    const rate = 2; // swooshes a second, over a whole number of them so it loops
    return s.shape(s.filter(s.noise(sec), 'bp', (t) => 1000 + 600 * Math.sin(TAU * rate * t), 1.8),
      (t) => 0.2 + 0.8 * (0.5 + 0.5 * Math.sin(TAU * rate * t)) ** 3);
  } },
  bowDraw: { group: 'combat', label: 'Bow draw (creak)', gain: 0.25, size: 0.1, render: (s) => s.env(s.creak(0.6, (t) => 40 + 140 * t, [[900, 8], [2100, 6]]), [[0, 0], [0.1, 0.6], [0.5, 1], [0.6, 0]]) },
  bowRelease: { group: 'combat', label: 'Bowstring release', gain: 0.7, size: 0.3, render: (s) => {
    const o = s.decay(s.pluck(0.5, s.r(100, 115), 0.992), 0.12, 0.001);
    s.add(o, s.decay(s.filter(s.noise(0.1), 'lp', 600), 0.015), 0.8);
    return s.add(o, s.knock(2500, 0.004), 0.4);
  } },
  arrowFly: { group: 'combat', label: 'Arrow in flight', gain: 0.22, size: 0.1, render: (s) => s.shape(s.filter(s.noise(0.45), 'bp', (t) => 4200 - 3500 * t, 5), (t) => Math.sin(Math.PI * t / 0.45)) },
  arrowHit: { group: 'combat', label: 'Arrow hits', gain: 0.65, size: 0.25, render: (s) => s.add(s.thump(160, 90, 0.04, 0.2), s.decay(s.filter(s.noise(0.1), 'lp', 2500), 0.02), 0.7) },
  arrowLand: { group: 'combat', label: 'Arrow lands', gain: 0.45, size: 0.15, render: (s) => {
    const o = s.knock(2200, 0.006, 1.5, 0.4);
    return s.add(o, s.decay(s.shape(s.tone(0.4, 190), (t) => 0.6 + 0.4 * Math.sin(TAU * 26 * t)), 0.12), 0.35);
  } },
  spearThrow: { group: 'combat', label: 'Spear throw', gain: 0.55, size: 0.3, render: (s) => s.shape(s.filter(s.noise(0.4), 'bp', (t) => 1500 - 2500 * t, 1.5), (t) => Math.sin(Math.PI * t / 0.4) ** 1.5) },
  spearHit: { group: 'combat', label: 'Spear hits', gain: 0.85, size: 0.4, render: (s) => {
    const o = s.thump(90, 45, 0.08, 0.35);
    s.add(o, s.modes(0.3, WOOD.map(([f, d, a]) => [f * 1.1, d, a])), 0.6);
    return s.add(o, s.decay(s.filter(s.noise(0.2), 'lp', 1500), 0.03), 0.6);
  } },
  orbCharge: { group: 'combat', label: 'Mage orb gathering', gain: 0.35, size: 0.35, render: (s) => {
    const o = s.fm(1.4, (t) => 330 + 330 * t, 1.5, (t) => 0.5 + 2.5 * t);
    s.add(o, s.filter(s.noise(1.4), 'bp', (t) => 800 + 2500 * t, 3), 0.5);
    return s.env(o, [[0, 0], [0.3, 0.3], [1.3, 1], [1.4, 0]]);
  } },
  fireLaunch: { group: 'combat', label: 'Fireball launched', gain: 0.55, size: 0.45, render: (s) => {
    const o = s.filter(s.noise(0.55), 'lp', (t) => 300 + 2500 * Math.sin(Math.PI * Math.min(1, t / 0.5)), 1.2);
    s.add(o, s.brown(0.55), 2);
    return s.env(o, [[0, 0], [0.06, 1], [0.55, 0]]);
  } },
  fireball: { group: 'combat', label: 'Fireball in flight', gain: 0.55, size: 0.5, loop: 3, render: (s, sec) => {
    const o = s.filter(s.noise(sec), 'lp', 700, 1);
    s.add(o, s.brown(sec), 3);
    return s.shape(o, (t) => 0.7 + 0.12 * Math.sin(TAU * 7 * t) + 0.1 * Math.sin(TAU * 11.3 * t + 1) + 0.08 * Math.sin(TAU * 17.7 * t + 2));
  } },
  explosion: { group: 'combat', label: 'Explosion', gain: 1, size: 0.9, render: (s) => {
    const o = s.decay(s.noise(2.2), 0.05, 0.001);
    s.add(o, s.thump(80, 28, 0.5, 2.2), 1.2);
    s.add(o, s.decay(s.filter(s.noise(2.2), 'lp', (t) => 120 + 300 * Math.exp(-t * 3)), 0.7, 0.004), 1.6);
    return s.scatter(o, 40, 0.15, 1.3, () => s.knock(s.r(900, 3000), 0.01, 2, 0.06), (t) => 0.3 * Math.exp(-t * 2));
  } },
  prayer: { group: 'combat', label: 'Priest prays', gain: 0.32, size: 0.35, render: (s) => {
    const o = s.buf(2);
    for (const f of [220, 277.2, 329.6, 440]) for (const d of [-1.5, 1.5]) s.add(o, s.tone(2, f + d), f === 440 ? 0.3 : 1);
    return s.env(o, [[0, 0], [0.6, 1], [1.2, 0.8], [2, 0]]);
  } },
  healBeam: { group: 'combat', label: 'Heal beam hum', gain: 0.2, size: 0.3, loop: 2, render: (s, sec) => {
    const o = s.tone(sec, (t) => 440 + 4 * Math.sin(TAU * 5 * t));
    s.add(o, s.tone(sec, 660), 0.5);
    return s.add(o, s.tone(sec, 880), 0.2);
  } },
  healTick: { group: 'combat', label: 'Heal tick', gain: 0.3, size: 0.2, render: (s) => pings(s, [1760, 2217, 2637], 0.04, 0.12, 0.6) },
  grunt: { group: 'combat', label: 'Hurt grunt', silent: true },
  deathCry: { group: 'combat', label: 'Death cry', silent: true },
  bodyFall: { group: 'combat', label: 'Body falls', gain: 0.7, size: 0.3, render: (s) => {
    const o = s.thump(75, 45, 0.06, 0.3);
    s.add(o, s.decay(s.filter(s.noise(0.3), 'lp', 500), 0.05), 0.8);
    return s.add(o, s.decay(s.filter(s.noise(0.15), 'bp', 1500, 1), 0.02), 0.3);
  } },
  metalClink: { group: 'combat', label: 'Helmet or pauldron bounces', gain: 0.45, size: 0.15, render: (s) => s.add(s.struck(0.35, [[s.r(1300, 1700), 0.07, 1], [s.r(3300, 4000), 0.045, 0.7], [s.r(5400, 6400), 0.03, 0.5], [s.r(7800, 8800), 0.02, 0.3]], 0.0015, 0.06), s.knock(5000, 0.002, 0.8), 0.5) },
  clothFlop: { group: 'combat', label: 'Hat lands', gain: 0.35, size: 0.1, render: (s) => s.decay(s.filter(s.noise(0.2), 'lp', 900), 0.04, 0.005) },
  leatherTap: { group: 'combat', label: 'Boot or sandal lands', gain: 0.35, size: 0.1, render: (s) => s.add(s.knock(700, 0.025, 2, 0.15), s.thump(160, 100, 0.02, 0.15), 0.5) },
  metalClatter: { group: 'combat', label: 'Dropped metal weapon', gain: 0.55, size: 0.25, render: (s) => clatter(s, [[800, 0.07, 1], [2100, 0.05, 0.6], [3300, 0.035, 0.5], [5200, 0.02, 0.3]], 0.8) },
  woodClatter: { group: 'combat', label: 'Dropped wooden weapon', gain: 0.55, size: 0.25, render: (s) => clatter(s, WOOD, 0.7) },
  splash: { group: 'combat', label: 'Splash', gain: 0.65, size: 0.45, render: (s) => {
    const o = s.decay(s.filter(s.noise(0.9), 'bp', (t) => 1500 - 800 * t, 0.8), 0.22, 0.01);
    return s.scatter(o, 25, 0.05, 0.6, () => s.knock(s.r(2500, 6000), 0.006, 3, 0.04), (t) => Math.exp(-t * 3));
  } },
  bubbles: { group: 'combat', label: 'Bubbles (drowning)', gain: 0.35, size: 0.2, render: (s) => {
    const o = s.buf(0.6);
    return s.scatter(o, 6, 0, 0.45, () => { const f = s.r(300, 600); return s.decay(s.tone(0.12, (t) => f * (1 + 25 * t)), 0.04, 0.003); });
  } },
  hoof: { group: 'combat', label: 'Hoofbeats', gain: 0.45, size: 0.15, render: (s) => s.add(s.knock(s.r(1000, 1400), 0.008, 3, 0.12), s.thump(150, 90, 0.025, 0.12), 0.8) },
  neigh: { group: 'combat', label: 'Horse neigh', silent: true },
  horseFall: { group: 'combat', label: 'Horse falls', gain: 0.9, size: 0.45, render: (s) => s.add(s.thump(60, 32, 0.15, 0.6), s.decay(s.filter(s.noise(0.6), 'lp', 300), 0.12), 1) },
  crystalHit: { group: 'combat', label: 'Power crystal hit', gain: 0.55, size: 0.5, render: (s) => s.add(s.modes(1.3, GLASS, 0.02), s.knock(6000, 0.003), 0.4) },
  crystalShatter: { group: 'combat', label: 'Power crystal shatters', gain: 1, size: 1, render: (s) => {
    const o = s.thump(60, 30, 0.8, 2.6);
    s.add(o, s.decay(s.filter(s.noise(2.6), 'hp', 2500), 0.35, 0.002), 0.8);
    return s.scatter(o, 34, 0, 1.3, () => s.modes(0.4, [[s.r(2000, 7000), s.r(0.06, 0.25), 1]], 0), (t) => Math.exp(-t * 1.5));
  } },

  // Work
  pickStone: { group: 'work', label: 'Pickaxe on stone', gain: 0.6, size: 0.35, render: (s) => {
    // The pick's steel rings a moment over the rock's crunch.
    const o = s.struck(0.35, [[s.r(2400, 2800), 0.03, 0.6], [s.r(3900, 4400), 0.02, 0.4], [s.r(6100, 6800), 0.012, 0.3]], 0.0015, 0.05);
    s.add(o, bite(s, 3000), 1);
    s.add(o, s.decay(s.filter(s.noise(0.35), 'bp', 1800, 0.8), 0.025, 0.001), 0.8);
    crackles(s, o, 8, 1500, 5000, 0.35);
    return s.add(o, s.thump(160, 120, 0.025, 0.2), 0.4);
  } },
  pickOre: { group: 'work', label: 'Pickaxe on ore', gain: 0.55, size: 0.35, render: (s) => {
    // Harder than stone: the steel rings longer, with less crunch.
    const o = s.struck(0.5, [[s.r(1800, 2000), 0.07, 0.8], [s.r(2700, 2900), 0.05, 0.6], [s.r(4500, 4800), 0.035, 0.4], [s.r(6000, 6400), 0.025, 0.3]], 0.0015, 0.04);
    s.add(o, bite(s, 4000), 1);
    s.add(o, s.decay(s.filter(s.noise(0.3), 'bp', 2200, 0.8), 0.015, 0.001), 0.5);
    crackles(s, o, 5, 2000, 6000, 0.3);
    return o;
  } },
  coin: { group: 'work', label: 'Ore mined (coin)', gain: 0.35, size: 0.3, render: (s) => pings(s, [1975, 2637], 0.07, 0.15, 0.6) },
  breakStone: { group: 'work', label: 'Stone breaks', gain: 0.55, size: 0.35, render: (s) => {
    const o = s.thump(110, 70, 0.05, 0.7);
    return s.scatter(o, 26, 0, 0.4, () => s.knock(s.r(800, 3200), s.r(0.008, 0.025), 2, 0.12), (t) => Math.exp(-t * 5));
  } },
  breakWood: { group: 'work', label: 'Wood breaks', gain: 0.5, size: 0.3, render: (s) => {
    const o = s.struck(0.4, WOOD.map(([f, d, a]) => [f * s.r(0.85, 1.15), d, a]), 0.004);
    s.add(o, s.decay(s.filter(s.noise(0.4), 'bp', 1400, 0.7), 0.04, 0.002), 0.7);
    return s.scatter(o, 10, 0.01, 0.15, () => s.knock(s.r(1500, 5000), 0.002, 2, 0.015), (t) => 0.5 * Math.exp(-t * 15));
  } },
  shovel: { group: 'work', label: 'Shovel in dirt', gain: 0.45, size: 0.25, render: (s) => s.add(s.env(s.filter(s.noise(0.35), 'bp', 1800, 1.2), [[0, 0], [0.05, 1], [0.3, 0]]), s.thump(95, 60, 0.04, 0.3), 0.6) },
  chop: { group: 'work', label: 'Axe chops wood', gain: 0.8, size: 0.4, render: (s) => {
    // A solid "thock": the blade's crack, the trunk's dull knock (low, short, no ring), the cut's crunch, splinters.
    const o = s.struck(0.3, [[s.r(150, 190), 0.03, 1], [s.r(380, 460), 0.018, 0.7], [s.r(850, 1050), 0.01, 0.5], [s.r(1800, 2300), 0.005, 0.35]], 0.005, 0.05);
    s.add(o, bite(s, s.r(3000, 4200)), 0.9);
    s.add(o, s.decay(s.filter(s.noise(0.3), 'lp', 1400), 0.022, 0.001), 0.9);
    s.add(o, s.decay(s.filter(s.noise(0.3), 'bp', 2600, 0.8), 0.012, 0.001, 0.004), 0.4);
    crackles(s, o, 5, 2500, 6500, 0.2);
    return o;
  } },
  treeCreak: { group: 'work', label: 'Tree creaks', gain: 0.45, size: 0.5, render: (s) => s.env(s.creak(1.6, (t) => 25 + 35 * Math.sin(Math.PI * t / 1.6), [[480, 10], [1100, 8]]), [[0, 0], [0.3, 0.7], [1.3, 1], [1.6, 0]]) },
  treeCrash: { group: 'work', label: 'Tree crashes down', gain: 1, size: 0.8, render: (s) => {
    const o = s.thump(60, 30, 0.3, 2);
    s.add(o, s.decay(s.filter(s.noise(2), 'lp', 800), 0.35, 0.003), 1);
    s.scatter(o, 14, 0, 0.3, () => s.knock(s.r(900, 2200), 0.012, 2, 0.08), () => 0.8);
    return s.add(o, s.env(s.filter(s.noise(2), 'hp', 2500), [[0, 0], [0.2, 0.5], [1.2, 0.2], [2, 0]]), 0.6);
  } },
  logKnock: { group: 'work', label: 'Logs bounce', gain: 0.5, size: 0.3, render: (s) => s.add(s.struck(0.3, [[s.r(110, 140), 0.045, 1], [s.r(260, 320), 0.028, 0.6], [s.r(600, 720), 0.014, 0.4], [s.r(1300, 1600), 0.007, 0.25]], 0.006), s.thump(90, 70, 0.04, 0.3), 0.6) },
  leaves: { group: 'work', label: 'Leaves fall', gain: 0.22, size: 0.15, render: (s) => s.env(s.shape(s.filter(s.filter(s.noise(0.9), 'hp', 2000), 'lp', 7000), () => 0.4 + 0.6 * s.rand()), [[0, 0], [0.15, 1], [0.9, 0]]) },
  placeStone: { group: 'work', label: 'Stone or brick placed', gain: 0.55, size: 0.3, render: (s) => {
    const o = s.struck(0.25, [[s.r(300, 380), 0.012, 1], [s.r(850, 1000), 0.007, 0.6], [s.r(2000, 2400), 0.004, 0.4]], 0.004);
    s.add(o, s.thump(120, 90, 0.03, 0.25), 0.8);
    return crackles(s, o, 6, 1500, 4500, 0.3); // (grit)
  } },
  placeDirt: { group: 'work', label: 'Dirt placed', gain: 0.5, size: 0.3, render: (s) => {
    const o = s.norm(s.decay(s.filter(s.filter(s.noise(0.3), 'lp', 450), 'lp', 450), 0.05, 0.006));
    s.add(o, s.thump(90, 70, 0.04, 0.3), 0.5);
    return s.scatter(o, 8, 0.01, 0.15, () => s.knock(s.r(500, 1500), 0.006, 1.5, 0.04), (t) => 0.25 * Math.exp(-t * 12));
  } },
  placeWood: { group: 'work', label: 'Planks placed', gain: 0.55, size: 0.3, render: (s) => {
    const o = s.struck(0.3, [[s.r(170, 210), 0.03, 1], [s.r(400, 470), 0.02, 0.6], [s.r(850, 1000), 0.01, 0.4], [s.r(1800, 2200), 0.005, 0.25]], 0.005);
    return s.add(o, s.decay(s.filter(s.noise(0.3), 'lp', 1200), 0.02, 0.001), 0.6);
  } },
  // (Jordan: what dirt breaking sounded like.)
  hammer: { group: 'work', label: 'Hammering', gain: 0.55, size: 0.3, render: (s) => {
    const o = s.decay(s.filter(s.noise(0.45), 'lp', 700), 0.1, 0.005);
    return s.scatter(o, 10, 0, 0.25, () => s.knock(s.r(400, 1200), 0.01, 1.5, 0.08), (t) => Math.exp(-t * 6));
  } },
  buildDone: { group: 'work', label: 'Building finished', gain: 0.55, size: 0.6, render: (s) => {
    const o = s.buf(1.4);
    for (const t of [0, 0.22]) s.add(o, RECIPES.hammer.render(s), 0.7, t);
    return s.add(o, pings(s, [523, 659, 784], 0.1, 0.35, 1), 0.6, 0.45);
  } },
  gate: { group: 'work', label: 'Portcullis rises or falls', gain: 0.45, size: 0.4, render: (s) => s.add(
    s.env(s.creak(1, (t) => 22 + 18 * t, [[600, 8], [1400, 6]]), [[0, 0], [0.08, 0.8], [0.8, 1], [1, 0]]),
    clatter(s, [[900, 0.05, 1], [2300, 0.035, 0.6], [4100, 0.02, 0.3]], 0.6), 0.6) },
  torchLight: { group: 'work', label: 'Torch lit', gain: 0.45, size: 0.25, render: (s) => {
    const o = s.env(s.filter(s.noise(1), 'lp', (t) => 200 + 2300 * Math.min(1, t / 0.15)), [[0, 0], [0.08, 1], [0.4, 0.3], [1, 0]]);
    return s.scatter(o, 12, 0.1, 0.8, () => s.knock(s.r(2000, 5000), 0.003, 2, 0.02), (t) => Math.exp(-t * 2));
  } },
  till: { group: 'work', label: 'Tilling', gain: 0.45, size: 0.25, render: (s) => s.add(s.env(s.filter(s.noise(0.35), 'bp', 1200, 1), [[0, 0], [0.03, 1], [0.25, 0]]), s.thump(90, 60, 0.04, 0.3), 0.7) },
  reap: { group: 'work', label: 'Reaping wheat', gain: 0.45, size: 0.25, render: (s) => {
    const o = s.shape(s.filter(s.noise(0.35), 'bp', (t) => 4000 - 8000 * t, 2), (t) => Math.sin(Math.PI * Math.min(1, t / 0.3)) ** 2);
    return s.scatter(o, 10, 0.05, 0.25, () => s.knock(s.r(3000, 6000), 0.004, 2, 0.03), () => 0.5);
  } },
  pebble: { group: 'work', label: 'Pebbles bounce', gain: 0.22, size: 0, render: (s) => s.add(s.knock(s.r(3000, 5000), 0.003, 1.5, 0.06), s.struck(0.06, [[s.r(2500, 4500), 0.005, 1], [s.r(6000, 8000), 0.003, 0.5]], 0.001), 0.6) },
  chip: { group: 'work', label: 'Wood chips bounce', gain: 0.22, size: 0, render: (s) => s.knock(s.r(1200, 1800), 0.008, 3, 0.08) },
  stepGrass: { group: 'work', label: 'Footsteps on grass and dirt', gain: 0.22, size: 0, render: (s) => s.add(s.decay(s.filter(s.noise(0.12), 'lp', 1000), 0.02, 0.003), s.thump(110, 80, 0.015, 0.1), 0.5) },
  stepStone: { group: 'work', label: 'Footsteps on stone', gain: 0.22, size: 0, render: (s) => s.add(s.knock(s.r(2000, 2800), 0.006, 1.5, 0.1), s.thump(130, 90, 0.015, 0.1), 0.6) },
  stepWood: { group: 'work', label: 'Footsteps on planks', gain: 0.22, size: 0, render: (s) => s.add(s.struck(0.12, [[s.r(160, 220), 0.02, 1], [s.r(420, 520), 0.012, 0.5], [s.r(1000, 1300), 0.005, 0.3]], 0.006), s.decay(s.filter(s.noise(0.12), 'lp', 900), 0.015, 0.003), 0.6) },

  // World (steady beds)
  water: { group: 'world', label: 'Water and surf', gain: 0.5, size: 1, loop: 6, render: (s, sec) => {
    const o = s.filter(s.brown(sec), 'lp', 500);
    s.add(o, s.shape(s.filter(s.noise(sec), 'bp', 1200, 0.7), (t) => 0.1 + 0.25 * (0.5 + 0.5 * Math.sin(TAU * t / 3)) ** 2), 1);
    return s.scatter(o, 10, 0, sec - 0.3, () => s.decay(s.filter(s.noise(0.3), 'lp', s.r(800, 1600)), 0.06, 0.02), () => 0.15);
  } },
  wind: { group: 'world', label: 'Wind', gain: 0.45, size: 1, loop: 8, render: (s, sec) => {
    const slow = (t) => 0.5 + 0.25 * Math.sin(TAU * t / 8) + 0.15 * Math.sin(TAU * t / 4 + 1) + 0.1 * Math.sin(TAU * t / 2 + 2);
    const o = s.shape(s.filter(s.noise(sec), 'bp', (t) => 300 + 400 * slow(t), 0.8), slow);
    return s.add(o, s.shape(s.filter(s.noise(sec), 'bp', (t) => 1100 + 200 * slow(t), 6), (t) => slow(t) ** 3), 0.4);
  } },
  crickets: { group: 'world', label: 'Crickets and frogs at night', gain: 0.25, size: 1, loop: 4, render: (s, sec) => {
    const o = s.buf(sec);
    for (const [f, every, at] of [[4400, 0.62, 0], [4850, 0.8, 0.27]]) {
      for (let t = at; t < sec - 0.1; t += every * s.r(0.9, 1.1)) {
        s.add(o, s.shape(s.tone(0.1, f), (tt) => (tt < 0.09 ? (0.5 + 0.5 * Math.sin(TAU * 33 * tt - Math.PI / 2)) : 0)), 0.6, t);
      }
    }
    for (const t of [0.9, 2.7]) s.add(o, s.decay(s.shape(s.tone(0.35, 170, 'tri'), (tt) => (Math.sin(TAU * 18 * tt) > 0 ? 1 : 0.2)), 0.12, 0.01), 0.25, t);
    return o;
  } },
  fire: { group: 'world', label: 'Fire crackle', gain: 0.4, size: 0.3, reach: 'ambientReach', loop: 3, render: (s, sec) => {
    const o = s.filter(s.brown(sec), 'lp', 300);
    s.add(o, s.filter(s.noise(sec), 'hp', 3000), 0.04);
    return s.scatter(o, 70, 0, sec - 0.05, () => s.knock(s.r(1500, 6000), s.r(0.001, 0.004), 2, 0.03), () => 0.5);
  } },
  crystalHum: { group: 'world', label: 'Power crystal hum', gain: 0.28, size: 0.5, reach: 'ambientReach', loop: 4, render: (s, sec) => {
    const o = s.tone(sec, 110);
    s.add(o, s.tone(sec, 110.5), 1);
    s.add(o, s.tone(sec, 220), 0.5);
    s.add(o, s.tone(sec, 330), 0.25);
    return s.add(o, s.filter(s.noise(sec), 'hp', 6000), 0.03);
  } },

  // Interface
  select: { group: 'ui', label: 'Units selected', gain: 0.35, ui: true, render: (s) => pings(s, [880, 1320], 0.035, 0.04, 0.2) },
  orderMove: { group: 'ui', label: 'Move order', gain: 0.35, ui: true, render: (s) => s.add(s.modes(0.1, [[1200, 0.025, 1]], 0), s.knock(3000, 0.003), 0.3) },
  orderAttack: { group: 'ui', label: 'Attack order', gain: 0.4, ui: true, render: (s) => s.add(s.decay(s.filter(s.add(s.tone(0.15, 600, 'square'), s.tone(0.15, 900, 'square'), 0.6), 'lp', 2500), 0.04), s.thump(160, 90, 0.03, 0.15), 0.6) },
  orderPatrol: { group: 'ui', label: 'Patrol order', gain: 0.35, ui: true, render: (s) => { const o = s.buf(0.2); for (const t of [0, 0.07]) s.add(o, s.modes(0.1, [[1100, 0.025, 1]], 0), 1, t); return o; } },
  orderWork: { group: 'ui', label: 'Work order', gain: 0.35, ui: true, render: (s) => s.modes(0.15, [[900, 0.03, 1], [1800, 0.02, 0.4]], 0) },
  orderReply: { group: 'ui', label: 'Units answer orders', silent: true },
  click: { group: 'ui', label: 'Button click', gain: 0.3, ui: true, render: (s) => s.add(s.knock(3500, 0.003, 1.5, 0.05), s.modes(0.05, [[2000, 0.008, 1]], 0), 0.5) },
  hover: { group: 'ui', label: 'Button hover', gain: 0.08, ui: true, render: (s) => s.modes(0.04, [[2600, 0.006, 1]], 0) },
  error: { group: 'ui', label: "Can't do that", gain: 0.35, ui: true, render: (s) => {
    const o = s.buf(0.32);
    s.add(o, s.decay(s.filter(s.tone(0.14, 220, 'saw'), 'lp', 1200), 0.08, 0.005), 1, 0);
    return s.add(o, s.decay(s.filter(s.tone(0.16, 185, 'saw'), 'lp', 1200), 0.09, 0.005), 1, 0.14);
  } },
  trainQueue: { group: 'ui', label: 'Training queued', gain: 0.3, ui: true, render: (s) => pings(s, [1500, 2250], 0.03, 0.05, 0.25) },
  unitReady: { group: 'ui', label: 'Unit ready', gain: 0.35, ui: true, render: (s) => pings(s, [523, 659, 784], 0.08, 0.25, 0.9) },
  group: { group: 'ui', label: 'Control group', gain: 0.3, ui: true, render: (s) => s.add(s.modes(0.15, [[600, 0.05, 1], [1200, 0.03, 0.3]], 0), s.knock(3000, 0.003), 1) },
  underAttack: { group: 'ui', label: 'Under attack', gain: 0.5, ui: true, alert: true, render: (s) => {
    const o = s.buf(1);
    for (const [f, t] of [[330, 0], [247, 0.4]]) s.add(o, s.env(s.filter(s.tone(0.38, (tt) => f * (1 + 0.01 * Math.sin(TAU * 6 * tt)), 'saw'), 'lp', 1500), [[0, 0], [0.03, 1], [0.3, 0.8], [0.38, 0]]), 1, t);
    return o;
  } },
  eliminated: { group: 'ui', label: 'Team eliminated (gong)', gain: 0.6, ui: true, render: (s) => s.add(s.modes(3, [[110, 2.5, 1], [163, 2, 0.7], [231, 1.6, 0.6], [311, 1.2, 0.5], [427, 0.8, 0.4], [562, 0.6, 0.3]], 0.01), s.knock(800, 0.02, 1), 0.3) },
  victory: { group: 'ui', label: 'Victory', gain: 0.55, ui: true, render: (s) => brass(s, [262, 330, 392, 523], [0.22, 0.22, 0.22, 1.3], 2.4) },
  defeat: { group: 'ui', label: 'Defeat', gain: 0.55, ui: true, render: (s) => brass(s, [392, 311, 262, 196], [0.35, 0.35, 0.35, 1.4], 2.8) },
  toggleOn: { group: 'ui', label: 'Toggle on', gain: 0.3, ui: true, render: (s) => s.decay(s.tone(0.12, (t) => 900 + 4000 * t), 0.04, 0.003) },
  toggleOff: { group: 'ui', label: 'Toggle off', gain: 0.3, ui: true, render: (s) => s.decay(s.tone(0.12, (t) => 1400 - 4000 * t), 0.04, 0.003) },
  slowDown: { group: 'ui', label: 'Slow motion down', gain: 0.3, ui: true, render: (s) => s.env(s.filter(s.tone(0.5, (t) => 300 * Math.exp(-t * 3.5), 'saw'), 'lp', 1500), [[0, 0], [0.02, 1], [0.5, 0]]) },
  speedUp: { group: 'ui', label: 'Slow motion up', gain: 0.3, ui: true, render: (s) => s.env(s.filter(s.tone(0.5, (t) => 60 * Math.exp(t * 3.5), 'saw'), 'lp', 1500), [[0, 0], [0.05, 1], [0.5, 0]]) },
};
export const SOUND_NAMES = Object.keys(RECIPES);
const VARIANTS = 3;

// Each sound's volume and pitch, by group (T > Sound: combat ...): { name: volume, namePitch: pitch }.
export const SOUND_LEVELS = { combat: {}, work: {}, world: {}, ui: {} };
for (const [name, r] of Object.entries(RECIPES)) {
  if (r.silent) continue;
  SOUND_LEVELS[r.group][name] = 1;
  SOUND_LEVELS[r.group][`${name}Pitch`] = 1;
}

// The T panel's sound sections (see main.js TUNING).
export function soundTuning() {
  const A = AUDIO_TUNING, titles = { combat: 'Sound: combat', work: 'Sound: work', world: 'Sound: world', ui: 'Sound: interface' };
  return [
    ['Sound', [
      [A, 'on', 'Sound on (1) or off (0)', 0, 1, 1],
      [A, 'master', 'Master volume', 0, 2, 0.01],
      [A, 'combat', 'Combat volume', 0, 2, 0.01],
      [A, 'work', 'Work volume', 0, 2, 0.01],
      [A, 'world', 'World (water, wind...) volume', 0, 2, 0.01],
      [A, 'ui', 'Interface volume', 0, 2, 0.01],
      [A, 'near', 'Full volume out to (voxels from the camera)', 10, 600, 5],
      [A, 'zoomFade', 'Small sounds fade as the camera pulls back', 0, 2, 0.01],
      [A, 'offscreen', 'Fade off screen (half-widths to a half)', 0.1, 3, 0.05],
      [A, 'ambientReach', 'Waves, torches, crystal hum heard this near (voxels from the camera to a half)', 5, 300, 1],
      [A, 'ambientFall', 'And how sharply they fall off past that', 1, 12, 0.5],
      [A, 'windLow', 'Wind with the camera down low', 0, 1, 0.01],
      [A, 'windHigh', 'Wind with the camera pulled all the way back', 0, 1, 0.01],
      [A, 'pan', 'Left-right pan at the screen edge', 0, 1, 0.01],
      [A, 'voices', 'Sounds at once, at most', 4, 64, 1],
      [A, 'merge', 'Repeats counted together within (s)', 0, 0.3, 0.01],
      [A, 'mergeMax', 'Repeats of one sound at once, at most', 1, 10, 1],
      [A, 'variety', 'Random pitch variety', 0, 0.3, 0.005],
      [A, 'alertEvery', '"Under attack" at most every (s)', 1, 30, 0.5],
      [A, 'thud', 'Fallen bodies and gear sound landing harder than (voxels/s)', 0, 10, 0.1],
    ]],
    ...Object.entries(titles).map(([g, title]) => [title, Object.entries(RECIPES).filter(([, r]) => r.group === g && !r.silent).flatMap(([name, r]) => [
      [SOUND_LEVELS[g], name, `${r.label}: volume`, 0, 3, 0.01],
      [SOUND_LEVELS[g], `${name}Pitch`, `${r.label}: pitch`, 0.25, 3, 0.01],
    ])]),
  ];
}

// Variant v of a sound (a Float32Array) at sample rate sr: the same every time. How many variants it has: a loop one,
// a silent one none. Exported for the sims.
export const variantsOf = (name) => (RECIPES[name]?.silent ? 0 : RECIPES[name]?.loop ? 1 : VARIANTS);
export function renderSound(name, sr, v = 0) {
  const r = RECIPES[name];
  const s = new Synth(sr, (v * 104729 + [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)) >>> 0);
  return r.loop ? finish(seamless(r.render(s, r.loop + 0.5), sr, 0.5), sr) : finish(r.render(s), sr);
}

// --- The engine ----------------------------------------------------------------------------------------------------------

class Engine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.buffers = new Map(); // name -> [AudioBuffer]
    this.beds = new Map();    // name -> { src, gain, pan } (loops)
    this.want = new Map();    // name -> [level, pan] asked for this frame
    this.recent = new Map();  // name -> start times (the merge window)
    this.voices = 0;
    this.view = null;         // { eye, viewProj } of the frame
    this.speed = 1;           // the game's speed (slow motion)
    this.hidden = null;       // (x, z) => the player can't see there
    this.player = 'blue';
    this.alertAt = -1e9;
    this.todo = [];           // sounds still to render (a few each frame, see frame)
  }

  // On the first click or key: the context, the mix and every sound rendered.
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    // (Hushed while the tab's hidden: the frames stop, and the beds would play on as they were.)
    globalThis.document?.addEventListener('visibilitychange', () => (document.hidden ? ctx.suspend() : ctx.resume()));
    this.groups = {};
    for (const g of Object.keys(SOUND_LEVELS)) { this.groups[g] = ctx.createGain(); this.groups[g].connect(this.master); }
    // Rendered a few at a time over the next frames (all of them take a second or two): the interface's first, then
    // the steady beds, then the rest.
    const order = (n) => (RECIPES[n].ui ? 0 : RECIPES[n].loop ? 1 : 2);
    this.todo = SOUND_NAMES.filter((n) => !RECIPES[n].silent).sort((a, b) => order(a) - order(b))
      .flatMap((n) => Array.from({ length: variantsOf(n) }, (_, v) => [n, v]));
    this.ready = true;
    this.render(12);
  }

  // Renders sounds still to do for up to `ms` milliseconds.
  render(ms) {
    const t0 = performance.now(), ctx = this.ctx;
    while (this.todo.length && performance.now() - t0 < ms) {
      const [name, v] = this.todo.shift(), data = renderSound(name, ctx.sampleRate, v);
      const b = ctx.createBuffer(1, data.length, ctx.sampleRate);
      b.copyToChannel(data, 0);
      if (!this.buffers.has(name)) this.buffers.set(name, []);
      this.buffers.get(name).push(b);
    }
  }

  // Where a sound at pos is heard from the camera this frame: { gain, pan, on (on screen) }; size: 0 small to 1 big;
  // reach: if given, voxels from the camera it falls to a half at, and soon after to nothing (AUDIO_TUNING.ambientFall).
  place(pos, size = 0.5, reach = 0) {
    const v = this.view, A = AUDIO_TUNING;
    if (!v) return { gain: 1, pan: 0, on: true };
    const m = v.viewProj, [x, y, z] = pos;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    let s = 3, pan = 0;
    if (cw > 1e-6) { const nx = cx / cw, ny = cy / cw; s = Math.hypot(nx, ny); pan = clamp(nx * A.pan, -1, 1); }
    const screen = s <= 1 ? 1 - 0.25 * s * s : 0.75 / (1 + ((s - 1) / Math.max(0.05, A.offscreen)) ** 2);
    const d = Math.hypot(x - v.eye[0], y - v.eye[1], z - v.eye[2]);
    const zoom = reach > 0 ? ambientFade(d, reach) : Math.min(1, A.near / Math.max(d, 1)) ** (A.zoomFade * (1 - size) + 0.15);
    return { gain: screen * zoom, pan, on: s <= 1 };
  }

  // Plays a sound (see sfx).
  play(name, pos, opts) {
    const r = RECIPES[name], A = AUDIO_TUNING;
    if (!this.ready || !r || r.silent || !(A.on > 0.5)) return;
    const ctx = this.ctx, now = ctx.currentTime, L = SOUND_LEVELS[r.group];
    let gain = r.gain * (L[name] ?? 1) * (opts.gain ?? 1), pan = 0;
    if (r.alert) { // "under attack": the player's own, out of sight, now and then
      if (!pos || opts.team !== this.player || this.place(pos).on || now - this.alertAt < A.alertEvery) return;
      this.alertAt = now;
    } else if (!r.ui && pos) {
      if (this.hidden?.(pos[0], pos[2])) return;
      const p = this.place(pos, r.size, reachOf(r));
      gain *= p.gain;
      pan = p.pan;
    }
    if (gain < 0.002) return;
    const recent = (this.recent.get(name) ?? []).filter((t) => now - t < A.merge);
    this.recent.set(name, recent);
    if (recent.length >= A.mergeMax || (!r.ui && this.voices >= A.voices)) return;
    recent.push(now);
    const list = this.buffers.get(name);
    if (!list?.length) return;
    const src = ctx.createBufferSource();
    src.buffer = list[Math.floor(Math.random() * list.length)];
    src.playbackRate.value = Math.max(0.05, (r.ui ? 1 : this.speed) * (L[`${name}Pitch`] ?? 1) * (opts.pitch ?? 1) * (1 + (Math.random() - 0.5) * 2 * A.variety));
    const g = ctx.createGain(), p = ctx.createStereoPanner();
    g.gain.value = gain;
    p.pan.value = pan;
    src.connect(g).connect(p).connect(this.groups[r.group]);
    src.start(now + (opts.delay ?? 0) / Math.max(0.05, r.ui ? 1 : this.speed));
    this.voices++;
    src.onended = () => { this.voices--; src.disconnect(); g.disconnect(); p.disconnect(); };
  }

  // A steady sound this frame, at level (0-1) and pan.
  bed(name, level, pan = 0) {
    const w = this.want.get(name);
    if (!w || level > w[0]) this.want.set(name, [level, pan]);
  }
  // A steady sound from every one of `positions` this frame: as loud as they come together, panned towards the loudest.
  emit(name, positions) {
    if (!this.ready) return;
    const r = RECIPES[name];
    let quiet = 1, pan = 0, sum = 0;
    for (const pos of positions) {
      if (this.hidden?.(pos[0], pos[2])) continue;
      const p = this.place(pos, r.size, reachOf(r));
      quiet *= 1 - Math.min(1, p.gain) * 0.7;
      pan += p.pan * p.gain;
      sum += p.gain;
    }
    if (sum > 0) this.bed(name, (1 - quiet) / 0.7, pan / sum);
  }

  // Once a frame, after the game's asked for its sounds: the camera (eye, viewProj), the game's speed, the mix and the beds.
  frame(view, speed) {
    this.view = view;
    this.speed = speed;
    if (!this.ready) { this.want.clear(); return; }
    if (this.todo.length) this.render(6);
    const ctx = this.ctx, A = AUDIO_TUNING, now = ctx.currentTime;
    this.master.gain.setTargetAtTime(A.on > 0.5 ? A.master : 0, now, 0.05);
    for (const g of Object.keys(this.groups)) this.groups[g].gain.setTargetAtTime(A[g] ?? 1, now, 0.05);
    for (const [name, r] of Object.entries(RECIPES)) {
      if (!r.loop) continue;
      const [level, pan] = this.want.get(name) ?? [0, 0];
      let b = this.beds.get(name);
      if (!b && (level <= 0.001 || !this.buffers.has(name))) continue;
      if (!b) {
        const src = ctx.createBufferSource();
        src.buffer = this.buffers.get(name)[0];
        src.loop = true;
        const gain = ctx.createGain(), p = ctx.createStereoPanner();
        gain.gain.value = 0;
        src.connect(gain).connect(p).connect(this.groups[r.group]);
        src.start(now, Math.random() * r.loop);
        b = { src, gain, pan: p };
        this.beds.set(name, b);
      }
      const L = SOUND_LEVELS[r.group];
      b.gain.gain.setTargetAtTime(Math.min(1.5, level) * r.gain * (L[name] ?? 1), now, 0.12);
      b.pan.pan.setTargetAtTime(pan, now, 0.12);
      b.src.playbackRate.setTargetAtTime(Math.max(0.05, speed * (L[`${name}Pitch`] ?? 1)), now, 0.05);
    }
    this.want.clear();
  }
}

// How loud a sound with a reach is from d voxels away (see place).
export const ambientFade = (d, reach) => 1 / (1 + (d / reach) ** AUDIO_TUNING.ambientFall);

// A sound's reach (see place), if it has one: its recipe's reach names the AUDIO_TUNING key.
const reachOf = (r) => (r.reach ? AUDIO_TUNING[r.reach] : 0);

export const audio = new Engine();

// Plays sound `name` (see RECIPES) at pos ([x, y, z] in the world; null or left out for the interface's), opts:
// { gain, pitch (times), delay (seconds), team (for "under attack") }. Does nothing before sound's started.
export function sfx(name, pos = null, opts = {}) {
  if (audio.ready) audio.play(name, pos, opts);
}
