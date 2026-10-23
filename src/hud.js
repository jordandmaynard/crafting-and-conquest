// The HUD's pieces that don't need the game's state (Banner Hall, see ui.css): icons, team emblems, compass words, the
// event log and the selected building's live view, turning on its grass plate.

import { BLOCK } from './terrain.js';

// Icons, 24 × 24 paths (stroked in ink, square caps, as on the design canvas).
export const ICON = {
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18M12 7v5l3 3',
  build: 'M3 21h18M5 21V10h14v11M9 21v-6h6v6M3 10l9-6 9 6',
  mine: 'M4 20L14 10M8 4Q18 6 20 16',
  fill: 'M4 14h16v6H4zM8 10h8v4H8zM12 3v5M9 6l3 3 3-3',
  farm: 'M12 22V7M12 7c-2.2-.6-3.2-2.4-3-4.5 2.2.4 3.2 2.2 3 4.5M12 12c2.2-.6 3.2-2.4 3-4.5-2.2.4-3.2 2.2-3 4.5M12 17c-2.2-.6-3.2-2.4-3-4.5 2.2.4 3.2 2.2 3 4.5',
  wall: 'M3 21V8h3v3h3V8h3v3h3V8h3v3h3V8v13zM3 16h18M9 11v5M15 11v5M12 16v5',
  attack: 'M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2',
  patrol: 'M4 8h13l-3-3M20 16H7l3 3',
  stop: 'M6 6h12v12H6z',
  rally: 'M7 21V4M7 4h10l-3 3.5 3 3.5H7',
  look: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
  watch: 'M12 3a5 5 0 1 0 0 10a5 5 0 1 0 0-10M4 21c0-4 3.5-6.5 8-6.5s8 2.5 8 6.5M9 8h.01M15 8h.01',
  idle: 'M7 9h10v5H7zM9 14v6M15 14v6M5 9h14M9 5h6v4H9z',
  chevron: 'M5 9l7 7 7-7',
  lock: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5zM12 15v2',
  dir: 'M6 18L18 6M9 6h9v9',
  // Worker jobs (see jobs.js SPECS).
  worker: 'M12 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8M5 21v-2a7 7 0 0 1 14 0v2',
  lumberjack: 'M13 3l7 7-3 3-7-7zM11.5 8.5L3 21',
  miner: 'M4 20L14 10M8 4Q18 6 20 16',
  builder: 'M3 21h18M5 21V10h14v11M3 10l9-6 9 6',
  farmer: 'M12 22V7M12 7c-2.2-.6-3.2-2.4-3-4.5 2.2.4 3.2 2.2 3 4.5M12 12c2.2-.6 3.2-2.4 3-4.5-2.2.4-3.2 2.2-3 4.5',
  // Raise, Lower, Flatten (sandbox tools in the mode strip).
  raise: 'M12 20V5M6 11l6-6 6 6M4 21h16',
  lower: 'M12 4v15M6 13l6 6 6-6M4 3h16',
  flatten: 'M3 15h18M6 15v5h12v-5M8 10h8',
};
// Units (the queue, the selection's kinds).
export const UNIT_ICON = {
  worker: 'M5 8l6-3 3 3-6 3zM9.5 9.5L19 19',
  warrior: 'M14.5 17.5L3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2',
  barbarian: 'M12 4v17M12 6c-4 0-6 2-6 5 3 0 6-1 6-3M12 6c4 0 6 2 6 5-3 0-6-1-6-3',
  archer: 'M7 4c7 3 7 13 0 16M7 4v16M4 12h14M15 9l3 3-3 3',
  spearman: 'M5 19L16 8M13.5 4.5h6v6z',
  mage: 'M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-3 2-4 2-6 2 1 3 3 3 5',
  priest: 'M12 11c-3-2-3-7 0-7s3 5 0 7zM7 11h10M12 11v10',
  knight: 'M7 20h11M9 20c0-4 3-6 3-8-2 1-4 1-5-1l4-5c1-1 2-2 4-2 3 2 3 8 2 16M13 4l1-2',
  scout: 'M9 20c0-4 3-6 3-8-2 1-4 1-5-1l4-5c1-1 2-2 4-2 3 2 3 8 2 16M2 14h4M3 18h4',
  crystal: 'M12 2l7 7-7 13-7-13zM5 9h14M12 2l-3 7h6z',
};
export const svg = (d, size = 20, width = 2.8) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#2b1d12" stroke-width="${width}" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="${d}"/></svg>`;
// (Craft's: stroked in currentColor, the player's banner text colour.)
export const svgCur = (d, size = 20, width = 2.6) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="${d}"/></svg>`;

// Teams: an emblem each (so a team never rests on colour alone), its CSS class, and the minimap's mark shape.
export const EMBLEM = {
  blue: 'M12 3l8 3v6c0 5-3.5 8-8 9.5C7.5 20 4 17 4 12V6z', // shield
  red: 'M3 18L4.5 7l5 4.5L12 4l2.5 7.5 5-4.5L21 18z', // crown
  yellow: 'M6 21V10H4V4h3v2h2.5V4h5v2H17V4h3v6h-2v11z', // tower
  purple: 'M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9z', // star
};
export const emblem = (team, size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path class="emb" d="${EMBLEM[team] ?? EMBLEM.blue}"/></svg>`;
// A team's emblem on a square of its colour, and on a small hanging banner.
export const teamChip = (team, size = 14, style = '') => `<span class="chip t-${team}" style="${style}">${emblem(team, size)}</span>`;
export const teamBanner = (team) => `<span class="bn bn-s t-${team}">${emblem(team, 12)}</span>`;

// Resources: blocks are their texture's swatch; iron and gold an ingot, wheat an ear, people a figure.
const INGOT = 'M3 21l4-12h12l4 12z';
const WHEAT = 'M13 24V9M13 9c-3-1-4-4-3.5-7 3 .8 4 3.6 3.5 7M13 15c3-1 4-4 3.5-7-3 .8-4 3.6-3.5 7M13 15c-3-1-4-4-3.5-7';
const PEOPLE = 'M8 9a5 5 0 1 0 10 0a5 5 0 1 0-10 0M4 24c0-6 4-9 9-9s9 3 9 9z';
export const RES_ICON = {
  iron: [INGOT, '#c9c4bc', 'M8 13h6'],
  gold: [INGOT, '#f2c53d', 'M8 13h6'],
  wheat: [WHEAT, '#e3b94e', ''],
  people: [PEOPLE, '#fff3d6', ''],
};
export function resIcon(kind, size = 26) {
  const [d, fill, d2] = RES_ICON[kind];
  return `<svg width="${size}" height="${size}" viewBox="0 0 26 26" aria-hidden="true"><path d="${d}" fill="${fill}" stroke="#2b1d12" stroke-width="3" stroke-linejoin="round"/>` +
    (d2 ? `<path d="${d2}" fill="none" stroke="#2b1d12" stroke-width="2.5" stroke-linecap="round"/>` : '') + '</svg>';
}
// The ink warning (never red: red is a team).
export const WARN = '<svg class="warn" width="20" height="18" viewBox="0 0 24 22" aria-hidden="true"><path d="M12 1.5L23 20.5H1z" fill="#2b1d12" stroke="#fff3d6" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 7.5v6" stroke="#fff3d6" stroke-width="3" stroke-linecap="round"/><circle cx="12" cy="17" r="1.7" fill="#fff3d6"/></svg>';

// Where (x, z) is from (fx, fz), in compass words: the map's top is north (x east, z south).
const WINDS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
export function compass(fx, fz, x, z) {
  const a = Math.atan2(z - fz, x - fx);
  return WINDS[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}
export const cap = (s) => s[0].toUpperCase() + s.slice(1);
// Game time as m:ss (h:mm:ss past an hour).
export function clockText(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// The event log (top left, under the power crystals): threats (an enemy hitting what's the player's: their crystal, walls, units) pinned
// on top while they last, then what happened, newest first. A threat from the same team on the same kind of thing near
// the same place is the same one, kept up to date rather than added again.
export class EventLog {
  constructor() {
    this.list = []; // { id, threat, team, what, text, sub, at: [x, z] | null, t (game s), until, icon }
    this.nextId = 1;
    this.version = 0;
  }
  add(e, now) {
    this.list.unshift({ id: this.nextId++, t: now, ...e });
    if (this.list.length > 40) this.list.length = 40;
    this.version++;
  }
  // A threat: from team, on what ('crystal', 'wall', 'units'), at [x, z]; lasts `last` seconds after its latest blow.
  threat(team, what, at, text, sub, now, last = 15) {
    const near = (e) => e.threat && e.team === team && e.what === what && (!at || !e.at || Math.hypot(e.at[0] - at[0], e.at[1] - at[1]) < 24);
    const e = this.list.find(near);
    if (e && e.until > now) {
      const changed = e.text !== text || e.sub !== sub;
      Object.assign(e, { until: now + last, at: at ?? e.at, text, sub });
      if (changed) this.version++;
      return false;
    }
    this.add({ threat: true, team, what, at, text, sub, until: now + last }, now);
    return true;
  }
  // A warning: something stuck ('housed': population full and training waiting), shown while it lasts (refresh it
  // within `last` seconds) and gone once it's put right. True when it's new.
  warn(what, text, sub, at, now, last = 1.5) {
    const e = this.list.find((x) => x.warn && x.what === what);
    if (e) {
      const changed = e.text !== text || e.sub !== sub;
      Object.assign(e, { until: now + last, at: at ?? e.at, text, sub });
      if (changed) this.version++;
      return false;
    }
    this.add({ warn: true, what, at, text, sub, until: now + last }, now);
    return true;
  }
  // The threats going on now (newest first), the warnings, and the rest (warnings put right drop out).
  split(now) {
    const n = this.list.length;
    this.list = this.list.filter((e) => !e.warn || e.until > now);
    if (this.list.length !== n) this.version++;
    const threats = [], warns = [], rest = [];
    for (const e of this.list) (e.warn ? warns : e.threat && e.until > now ? threats : rest).push(e);
    return { threats, warns, rest };
  }
}

// The selected building's live view: its blocks as toon cubes turning slowly on a grass plate (a small canvas, drawn
// on the CPU; the plan's blocks are a few hundred at most).
const BLOCK_RGB = {
  [BLOCK.PLANK]: [176, 122, 69], [BLOCK.BRICK]: [170, 86, 64], [BLOCK.CLAY]: [140, 96, 62], [BLOCK.STONE]: [141, 140, 136],
  [BLOCK.LOG]: [107, 74, 43], [BLOCK.LEAVES]: [63, 120, 50], [BLOCK.IRON]: [180, 176, 170], [BLOCK.GOLD]: [226, 186, 60],
  [BLOCK.GROUND]: [122, 90, 58], [BLOCK.OBSIDIAN]: [42, 34, 54], [BLOCK.FARM]: [122, 79, 44],
};
const FACES = [ // normal, its 4 corners (of the unit cube)
  [[0, 1, 0], [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]]],
  [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
  [[-1, 0, 0], [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]]],
  [[0, 0, 1], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]],
  [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]],
];
export class LiveView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.blocks = null;
    this.key = null;
    this.angle = 0.6;
  }
  // blocks: [[x, y, z, block], ...] (world cells); team: whose (its plate's edge); present: (x, y, z) => still there.
  set(key, blocks) {
    if (key === this.key) return;
    this.key = key;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const [x, y, z] of blocks) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], [x, y, z][i]); hi[i] = Math.max(hi[i], [x, y, z][i] + 1); }
    this.mid = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
    this.radius = Math.hypot(hi[0] - lo[0], hi[2] - lo[2]) / 2;
    this.tall = hi[1] - lo[1];
    const at = new Set(blocks.map(([x, y, z]) => `${x},${y},${z}`));
    this.cells = blocks.map(([x, y, z, b]) => ({ x, y, z, b, open: FACES.map(([n]) => !at.has(`${x + n[0]},${y + n[1]},${z + n[2]}`)) }));
  }
  draw(dt, present = null) {
    if (!this.cells) return;
    const c = this.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(c.clientWidth * dpr), H = Math.round(c.clientHeight * dpr);
    if (!W || !H) return;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    this.angle += dt * 0.5;
    const ctx = this.ctx, a = this.angle, ca = Math.cos(a), sa = Math.sin(a), p = 0.6, cp = Math.cos(p), sp = Math.sin(p);
    // Fit: its turning width across, its height plus the plate's depth up and down.
    const r = this.radius + 0.8, s = Math.min(W * 0.92 / (2 * r), H * 0.86 / (this.tall * cp + 2 * r * sp));
    const ox = W / 2, oy = H * 0.5 + this.tall * cp * s * 0.5;
    const proj = (x, y, z) => { // (relative to the middle of its base)
      const rx = x * ca - z * sa, rz = x * sa + z * ca;
      return [ox + rx * s, oy - y * cp * s + rz * sp * s, rz * cp + y * sp];
    };
    ctx.clearRect(0, 0, W, H);
    // The plate: a disc of grass, its rim darker.
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(1, sp);
    ctx.beginPath(); ctx.arc(0, 0.6 * s / sp, r * s, 0, Math.PI * 2); ctx.fillStyle = '#3e6b2a'; ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, r * s, 0, Math.PI * 2); ctx.fillStyle = '#6fa443'; ctx.fill();
    ctx.lineWidth = 2 * dpr / sp; ctx.strokeStyle = '#2b1d12'; ctx.stroke();
    ctx.restore();
    // The faces that face the camera and aren't against another block, far ones first.
    const view = [0, sp, cp], light = [0.45, 0.8, 0.4];
    const faces = [];
    const [mx, my, mz] = this.mid;
    for (const cell of this.cells) {
      if (present && !present(cell.x, cell.y, cell.z)) continue;
      const rgb = BLOCK_RGB[cell.b] ?? [150, 120, 90];
      FACES.forEach(([n, corners], i) => {
        if (!cell.open[i]) return;
        const nx = n[0] * ca - n[2] * sa, nz = n[0] * sa + n[2] * ca;
        if (nx * view[0] + n[1] * view[1] + nz * view[2] <= 0.01) return;
        const pts = corners.map(([u, v, w]) => proj(cell.x + u - mx, cell.y + v - my, cell.z + w - mz));
        const depth = pts.reduce((d, q) => d + q[2], 0) / 4;
        const lit = 0.55 + 0.45 * Math.max(0, nx * light[0] + n[1] * light[1] + nz * light[2]);
        faces.push({ pts, depth, col: `rgb(${rgb.map((v) => Math.round(v * lit)).join(',')})` });
      });
    }
    faces.sort((f, g) => f.depth - g.depth);
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, 0.9 * dpr);
    ctx.strokeStyle = 'rgba(43, 29, 18, 0.85)';
    for (const f of faces) {
      ctx.beginPath();
      ctx.moveTo(f.pts[0][0], f.pts[0][1]);
      for (let i = 1; i < 4; i++) ctx.lineTo(f.pts[i][0], f.pts[i][1]);
      ctx.closePath();
      ctx.fillStyle = f.col;
      ctx.fill();
      ctx.stroke();
    }
  }
}
