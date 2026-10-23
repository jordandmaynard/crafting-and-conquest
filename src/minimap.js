// Minimap (top right), RTS style: the map from above, each column's top block a pixel (grass, sand, stone, trees,
// what's built, and the sea, bluer the deeper it is), lit by its height and slope; finished buildings in their team's
// colour, every villager a dot in its team's colour (the selected ones ringed white), and the camera's view as the
// outline of the ground on screen.
//
// Left click or drag: the camera goes there. With a command armed (Q attack-move, Y patrol, the card's Move) a left
// click is its target instead (onCommand). Right click: the selected villagers go there, or attack the dot of another
// team clicked; with a building selected, its rally point (onOrder); Shift queues. Ctrl (or Cmd) and drag: selects the
// villagers in the box, Ctrl+click the one dot (onSelect; Shift adds). The wheel zooms on the point under the cursor,
// the + and - buttons on the middle; zoomed in, middle drag pans it, and the view slides along to keep the camera's
// target on it as the camera moves.
//
// The terrain's re-read where it's edited (dirty), and a few rows a frame besides (refresh), so nothing's missed for
// long (not with fog of war, where edits the player can't see are held back: see fog.js).
//
// Fog of war (onFog gives the player's state of each column, or null): never seen is black, seen before dimmed to
// FOG_TUNING.mapSeen, over the terrain; its rows are re-painted as they change (fogRows).

import { SIZE, BLOCK, WATER_LEVEL, SOLID_MIN, BRICK, BRICKS } from './terrain.js';
import { clamp } from './math.js';
import { FOG_TUNING, NEVER, VISIBLE } from './fog.js';

export const MINIMAP_TUNING = {
  on: 1,
  size: 238,        // CSS pixels across
  rotate: 0,        // 0: fixed, x to the right and z down; 1: turns with the camera, its view always up
  maxZoom: 8,       // the most zoomed in, × the whole map
  zoomStep: 1.5,    // each + or - (and wheel notch)
  dot: 2.5,         // a unit's dot's radius (pixels)
  pick: 7,          // a click this near a dot (pixels) is on it
  relief: 0.6,      // hill shading (light from the top left)
  heightShade: 0.35, // higher ground lighter
  opacity: 0.95,
  refresh: 1,       // rows re-read a frame besides those edited (a safety net: edits are re-read as they happen)
  ping: 1.2,        // an order's ping lasts (s)
  follow: 0.3,      // zoomed in, the camera's target is kept within this share of the middle (each way)
  viewColor: '#ffffff',
  blue: '#5b8cff',
  red: '#ff4a3d',
  yellow: '#ffd23a',
  purple: '#c26bff',
  grass: '#5d9a3c',
  sand: '#d8c690',
  stone: '#8d8c88',
  trees: '#2f6b2a',
  built: '#b58e5a',
  wall: '#2a2236',   // the obsidian round the edge
  farm: '#7a4f2c',   // tilled farmland
  water: '#3f86b8',
  deep: '#173f6e',
};

const hex = (s) => { const n = parseInt(s.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

// A villager's mark, a shape for each team as well as its colour: blue a square, red a diamond, yellow a triangle, purple
// a circle (the path, about r round (sx, sy)).
function mark(ctx, team, sx, sy, r) {
  ctx.beginPath();
  if (team === 'blue') ctx.rect(sx - r * 0.9, sy - r * 0.9, r * 1.8, r * 1.8);
  else if (team === 'red') { ctx.moveTo(sx, sy - r * 1.25); ctx.lineTo(sx + r * 1.25, sy); ctx.lineTo(sx, sy + r * 1.25); ctx.lineTo(sx - r * 1.25, sy); ctx.closePath(); }
  else if (team === 'yellow') { ctx.moveTo(sx, sy - r * 1.3); ctx.lineTo(sx + r * 1.2, sy + r * 0.9); ctx.lineTo(sx - r * 1.2, sy + r * 0.9); ctx.closePath(); }
  else ctx.arc(sx, sy, r, 0, Math.PI * 2);
}
export class Minimap {
  constructor(el, terrain, camera) {
    this.el = el;
    this.canvas = el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.terrain = terrain;
    this.camera = camera;
    const [X, , Z] = SIZE;
    this.map = document.createElement('canvas'); // the terrain, a pixel a column
    this.map.width = X;
    this.map.height = Z;
    this.mctx = this.map.getContext('2d');
    this.image = this.mctx.createImageData(X, Z);
    this.height = new Uint8Array(X * Z); // each column's top (over its highest solid voxel; 0 for none)
    this.top = new Uint8Array(X * Z);    // and that voxel's block
    this.water = true; // (the editor has none)
    this.zoom = 1;
    this.center = [X / 2, Z / 2];
    this.lastTarget = null;
    this.row = 0;
    this.box = null;    // the edited columns still to re-read: [x0, z0, x1, z1)
    this.pings = [];    // { x, z, t, color }
    this.dots = [];     // the dots drawn last: { u, sx, sy }
    this.drag = null;   // { look }, { pan, x, y } (middle drag) or { select, x0, y0, x1, y1, add }
    this.size = 0;
    this.dpr = 0;
    this.look = '';
    this.onLook = null;    // (x, z) => void: the camera goes there
    this.onCommand = null; // (x, z, unit, queued) => bool: an armed command's left click (false: none armed)
    this.onOrder = null;   // (x, z, unit, queued) => void: right click
    this.onSelect = null;  // (units, add) => void
    this.onFog = null;     // () => the player's fog of war (a byte a column, see fog.js), or null when it's off
    this.fogMap = document.createElement('canvas'); // its shade over the terrain, a pixel a column
    this.fogMap.width = X;
    this.fogMap.height = Z;
    this.fctx = this.fogMap.getContext('2d');
    this.fogImage = this.fctx.createImageData(X, Z);
    this.fogPixels = new Uint32Array(this.fogImage.data.buffer);
    this.fogBox = null;    // its rows to paint again: [z0, z1)
    this.fogLook = -1;
    this.listen();
    this.rebuild();
  }

  // Re-reads every column (a new world, or the editor's flat one).
  rebuild() {
    this.scan(0, 0, SIZE[0], SIZE[2]);
    this.paint(0, 0, SIZE[0], SIZE[2]);
  }

  // The voxel box [lo, hi) changed: its columns are re-read next update.
  dirty(lo, hi) {
    const x0 = Math.max(0, Math.floor(lo[0])), z0 = Math.max(0, Math.floor(lo[2]));
    const x1 = Math.min(SIZE[0], Math.ceil(hi[0])), z1 = Math.min(SIZE[2], Math.ceil(hi[2]));
    if (x1 <= x0 || z1 <= z0) return;
    const b = this.box;
    this.box = b ? [Math.min(b[0], x0), Math.min(b[1], z0), Math.max(b[2], x1), Math.max(b[3], z1)] : [x0, z0, x1, z1];
  }

  // Each column's highest solid voxel, from the top down (skipping the terrain's bricks of nothing but air).
  scan(x0, z0, x1, z1) {
    const [X, Y] = SIZE, [BX, BY] = BRICKS, v = this.terrain.voxels, st = this.terrain.brickState;
    for (let z = z0; z < z1; z++) {
      const sz = BX * BY * Math.floor(z / BRICK);
      for (let x = x0; x < x1; x++) {
        const sx = sz + Math.floor(x / BRICK);
        let y = Y - 1, b = 0;
        while (y >= 0) {
          const by = Math.floor(y / BRICK);
          if (st[sx + BX * by] === 0) { y = by * BRICK - 1; continue; } // (an empty brick)
          b = v[x + X * (y + Y * z)];
          if (b >= SOLID_MIN) break;
          y--;
        }
        const c = x + X * z;
        this.height[c] = y + 1;
        this.top[c] = y >= 0 ? b : 0;
      }
    }
  }

  // The columns' colours: by their top block (the sea where it's under the water), lighter higher up and on slopes
  // facing the top left.
  paint(x0, z0, x1, z1) {
    const T = MINIMAP_TUNING, [X, Y] = SIZE, d = this.image.data;
    const col = {
      grass: hex(T.grass), sand: hex(T.sand), stone: hex(T.stone), trees: hex(T.trees), built: hex(T.built), wall: hex(T.wall), farm: hex(T.farm), water: hex(T.water), deep: hex(T.deep),
    };
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        const c = x + X * z, h = this.height[c], b = this.top[c];
        let r, g, bl;
        if (this.water && h < WATER_LEVEL) {
          const t = clamp((WATER_LEVEL - h) / 6, 0, 1);
          r = col.water[0] + (col.deep[0] - col.water[0]) * t;
          g = col.water[1] + (col.deep[1] - col.water[1]) * t;
          bl = col.water[2] + (col.deep[2] - col.water[2]) * t;
        } else {
          const k = b === BLOCK.LEAVES || b === BLOCK.LOG ? col.trees
            : b === BLOCK.PLANK || b === BLOCK.BRICK || b === BLOCK.CLAY ? col.built
            : b === BLOCK.OBSIDIAN ? col.wall
            : b === BLOCK.FARM ? col.farm
            : b === BLOCK.GROUND ? (h <= WATER_LEVEL + 1 && this.water ? col.sand : col.grass) : col.stone;
          const hl = x > 0 ? this.height[c - 1] : h, hu = z > 0 ? this.height[c - X] : h;
          const s = clamp(1 + T.heightShade * ((h - WATER_LEVEL) / (Y - WATER_LEVEL) - 0.25) + T.relief * 0.08 * (2 * h - hl - hu), 0.35, 1.7);
          r = k[0] * s; g = k[1] * s; bl = k[2] * s;
        }
        const p = c * 4;
        d[p] = r; d[p + 1] = g; d[p + 2] = bl; d[p + 3] = 255;
      }
    }
    this.mctx.putImageData(this.image, 0, 0, x0, z0, x1 - x0, z1 - z0);
  }

  // The fog of war changed in rows [z0, z1).
  fogRows(z0, z1) {
    const b = this.fogBox;
    this.fogBox = b ? [Math.min(b[0], z0), Math.max(b[1], z1)] : [z0, z1];
  }

  // The fog's shade in rows [z0, z1): black over never seen, dimmed over seen before.
  paintFog(state, z0, z1) {
    const X = SIZE[0], px = this.fogPixels;
    const seen = (Math.round(clamp(1 - FOG_TUNING.mapSeen, 0, 1) * 255) << 24) >>> 0, never = 0xff000000;
    for (let i = z0 * X, end = z1 * X; i < end; i++) {
      const s = state[i];
      px[i] = s === VISIBLE ? 0 : s === NEVER ? never : seen;
    }
    this.fctx.putImageData(this.fogImage, 0, 0, 0, z0, X, z1 - z0);
  }

  // A ping (an order's target) at (x, z), in a CSS colour.
  ping(x, z, color) { this.pings.push({ x, z, t: 0, color }); }

  // How the map lies on the minimap now: its scale (CSS pixels a voxel), the world point at its middle and its turn.
  view() {
    const T = MINIMAP_TUNING, S = this.size, turn = T.rotate >= 0.5;
    const k = (S / (Math.max(SIZE[0], SIZE[2]) * (turn ? Math.SQRT2 : 1))) * this.zoom;
    const a = turn ? this.camera.yaw : 0;
    return { S, k, cx: this.center[0], cz: this.center[1], cos: Math.cos(a), sin: Math.sin(a), turn };
  }
  toScreen(v, x, z) {
    const dx = x - v.cx, dz = z - v.cz;
    return [v.S / 2 + v.k * (dx * v.cos - dz * v.sin), v.S / 2 + v.k * (dx * v.sin + dz * v.cos)];
  }
  toWorld(v, sx, sy) {
    const a = (sx - v.S / 2) / v.k, b = (sy - v.S / 2) / v.k;
    return [v.cx + a * v.cos + b * v.sin, v.cz - a * v.sin + b * v.cos];
  }
  // Keeps the middle where the whole of the map's side fills the minimap (fixed), or on the map (turning).
  clampCenter() {
    const v = this.view(), c = this.center;
    if (this.zoom <= 1) { c[0] = SIZE[0] / 2; c[1] = SIZE[2] / 2; return; }
    for (const [i, n] of [[0, SIZE[0]], [1, SIZE[2]]]) {
      const half = v.turn ? 0 : v.S / (2 * v.k);
      c[i] = half * 2 >= n ? n / 2 : clamp(c[i], half, n - half);
    }
  }
  // Zooms by f, keeping the world point under minimap point (sx, sy) where it is.
  zoomBy(f, sx = this.size / 2, sy = this.size / 2) {
    const v = this.view(), [wx, wz] = this.toWorld(v, sx, sy);
    this.zoom = clamp(this.zoom * f, 1, Math.max(1, MINIMAP_TUNING.maxZoom));
    const n = this.view();
    const a = (sx - n.S / 2) / n.k, b = (sy - n.S / 2) / n.k;
    this.center = [wx - (a * n.cos + b * n.sin), wz - (-a * n.sin + b * n.cos)];
    this.clampCenter();
  }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  // The dot nearest minimap point (sx, sy), within pick pixels, or null.
  dotAt(sx, sy) {
    let best = null, bd = MINIMAP_TUNING.pick ** 2;
    for (const d of this.dots) {
      const dd = (d.sx - sx) ** 2 + (d.sy - sy) ** 2;
      if (dd < bd) { bd = dd; best = d.u; }
    }
    return best;
  }

  listen() {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // (no autoscroll)
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const [sx, sy] = this.local(e), v = this.view(), [x, z] = this.toWorld(v, sx, sy);
      if (e.button === 2) { this.onOrder?.(x, z, this.dotAt(sx, sy), e.shiftKey); return; }
      if (e.button === 1) { c.setPointerCapture(e.pointerId); this.drag = { pan: true, x: sx, y: sy }; return; }
      if (e.button !== 0) return;
      c.setPointerCapture(e.pointerId);
      if (e.ctrlKey || e.metaKey) { this.drag = { select: true, x0: sx, y0: sy, x1: sx, y1: sy, add: e.shiftKey }; return; }
      if (this.onCommand?.(x, z, this.dotAt(sx, sy), e.shiftKey)) return;
      this.drag = { look: true };
      this.onLook?.(x, z);
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.drag) return;
      const [sx, sy] = this.local(e);
      if (this.drag.look) this.onLook?.(...this.toWorld(this.view(), sx, sy));
      else if (this.drag.pan) { // (the map follows the cursor, as the view's ground does)
        const v = this.view(), dx = sx - this.drag.x, dy = sy - this.drag.y;
        this.center[0] -= (dx * v.cos + dy * v.sin) / v.k;
        this.center[1] -= (-dx * v.sin + dy * v.cos) / v.k;
        this.clampCenter();
        this.drag.x = sx;
        this.drag.y = sy;
      } else { this.drag.x1 = sx; this.drag.y1 = sy; }
    });
    const end = () => {
      const d = this.drag;
      this.drag = null;
      if (!d?.select) return;
      if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < 4) {
        const u = this.dotAt(d.x0, d.y0);
        this.onSelect?.(u ? [u] : [], d.add);
        return;
      }
      const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      this.onSelect?.(this.dots.filter((o) => o.sx >= x0 && o.sx <= x1 && o.sy >= y0 && o.sy <= y1).map((o) => o.u), d.add);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', () => { this.drag = null; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [sx, sy] = this.local(e);
      this.zoomBy(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015) * Math.log(MINIMAP_TUNING.zoomStep) / 0.15), sx, sy);
    }, { passive: false });
    for (const b of this.el.querySelectorAll('button[data-zoom]')) {
      b.addEventListener('click', () => { this.zoomBy(b.dataset.zoom === 'in' ? MINIMAP_TUNING.zoomStep : 1 / MINIMAP_TUNING.zoomStep); b.blur(); });
    }
  }

  // Each frame: the edits taken in, then the minimap drawn: the terrain, the buildings, the villagers' dots, the
  // camera's view and the pings.
  update(dt, units, buildings, selectedBuilding) {
    const T = MINIMAP_TUNING, [X, , Z] = SIZE;
    const on = T.on >= 0.5;
    const size = Math.round(clamp(T.size, 60, 800)), dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (on === this.el.hidden || size !== this.size || dpr !== this.dpr) {
      this.el.hidden = !on;
      this.size = size;
      this.dpr = dpr;
      this.canvas.width = Math.round(size * dpr);
      this.canvas.height = Math.round(size * dpr);
      this.canvas.style.width = this.canvas.style.height = `${size}px`;
      // (what's below it in the top right, the stats and the profiler, moves down by this)
      document.documentElement.style.setProperty('--mm', on ? `${size + 16}px` : '0px');
      this.clampCenter();
    }
    this.el.style.opacity = String(T.opacity);
    if (this.el.classList.contains('collapsed')) return; // (M: just its buttons)
    const look = [T.relief, T.heightShade, T.grass, T.sand, T.stone, T.trees, T.built, T.water, T.deep, this.water].join();
    if (look !== this.look) { this.look = look; this.paint(0, 0, X, Z); }
    if (this.box) { // (and the column past each edge, whose shading looks at its neighbours)
      const [x0, z0, x1, z1] = this.box;
      this.box = null;
      this.scan(x0, z0, x1, z1);
      this.paint(x0, z0, Math.min(X, x1 + 1), Math.min(Z, z1 + 1));
    }
    const fog = this.onFog?.() ?? null;
    if (fog) {
      if (this.fogLook !== FOG_TUNING.mapSeen) { this.fogLook = FOG_TUNING.mapSeen; this.fogBox = [0, Z]; }
      if (this.fogBox) {
        const [z0, z1] = this.fogBox;
        this.fogBox = null;
        this.paintFog(fog, Math.max(0, z0), Math.min(Z, z1));
      }
    }
    const rows = fog ? 0 : Math.min(Z, Math.round(T.refresh)); // (not with fog: it would show what's held back)
    if (rows > 0) {
      const z0 = this.row, z1 = Math.min(Z, z0 + rows);
      this.scan(0, z0, X, z1);
      this.paint(0, z0, X, Math.min(Z, z1 + 1));
      this.row = z1 >= Z ? 0 : z1;
    }
    for (const p of this.pings) p.t += dt;
    this.pings = this.pings.filter((p) => p.t < T.ping);
    if (!on) return;

    // Zoomed in: the view slides along with the camera (not while dragging on it, or the map would run off under the
    // cursor).
    const t = this.camera.target;
    const moved = !this.lastTarget || Math.abs(t[0] - this.lastTarget[0]) + Math.abs(t[2] - this.lastTarget[1]) > 1e-3;
    this.lastTarget = [t[0], t[2]];
    if (this.zoom > 1 && moved && !this.drag?.look) {
      const v = this.view(), [sx, sy] = this.toScreen(v, t[0], t[2]), m = v.S * clamp(T.follow, 0, 0.5);
      const ex = sx - v.S / 2, ey = sy - v.S / 2;
      const dx = ex - clamp(ex, -m, m), dy = ey - clamp(ey, -m, m);
      if (dx || dy) {
        this.center[0] += (dx * v.cos + dy * v.sin) / v.k;
        this.center[1] += (-dx * v.sin + dy * v.cos) / v.k;
      }
    }
    this.clampCenter();

    const v = this.view(), ctx = this.ctx, S = v.S;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#0b1118';
    ctx.fillRect(0, 0, S, S);
    // The terrain, a pixel a column (crisp once a voxel's bigger than a pixel).
    ctx.setTransform(dpr * v.k * v.cos, dpr * v.k * v.sin, -dpr * v.k * v.sin, dpr * v.k * v.cos,
      dpr * (S / 2 - v.k * (v.cx * v.cos - v.cz * v.sin)), dpr * (S / 2 - v.k * (v.cx * v.sin + v.cz * v.cos)));
    ctx.imageSmoothingEnabled = v.k * dpr < 1;
    ctx.drawImage(this.map, 0, 0);
    if (fog) ctx.drawImage(this.fogMap, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const quad = (x0, z0, x1, z1) => {
      ctx.beginPath();
      for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) ctx.lineTo(...this.toScreen(v, x, z));
      ctx.closePath();
    };
    // Finished buildings: their footprints in their team's colour (the selected one edged white).
    for (const b of buildings) {
      if (!b.mapBox) {
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (const [x, , z] of b.plan.blocks) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x + 1); z1 = Math.max(z1, z + 1); }
        b.mapBox = [x0, z0, x1, z1];
      }
      quad(...b.mapBox);
      ctx.fillStyle = T[b.team] ?? T.blue;
      ctx.fill();
      ctx.lineWidth = b === selectedBuilding ? 2 : 1;
      ctx.strokeStyle = b === selectedBuilding ? '#fff' : 'rgba(0, 0, 0, 0.7)';
      ctx.stroke();
    }
    // The villagers: a dot each in its team's colour, the selected ones on top, ringed white.
    this.dots = [];
    for (const u of units) {
      if (u.dying) continue;
      const [sx, sy] = this.toScreen(v, u.pos[0], u.pos[2]);
      if (sx < -4 || sy < -4 || sx > S + 4 || sy > S + 4) continue;
      this.dots.push({ u, sx, sy });
    }
    const r = Math.max(0.5, T.dot);
    for (const pass of [false, true]) {
      for (const { u, sx, sy } of this.dots) {
        if (!!u.selected !== pass) continue;
        mark(ctx, u.team, sx, sy, r);
        ctx.fillStyle = T[u.team] ?? T.blue;
        ctx.fill();
        ctx.lineWidth = pass ? 1.5 : 1;
        ctx.strokeStyle = pass ? '#fff' : 'rgba(0, 0, 0, 0.75)';
        ctx.stroke();
      }
    }
    // The camera's view: where the screen's corners' rays meet the ground at the target's height (a ray at or over the
    // horizon is cut off far out).
    const m = this.camera.matrices(), far = this.camera.distance * 4;
    ctx.beginPath();
    for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const { origin: o, dir } = this.camera.ray(m.invViewProj, nx, ny);
      const flat = Math.hypot(dir[0], dir[2]) || 1;
      let s = dir[1] < -1e-3 ? (t[1] - o[1]) / dir[1] : Infinity;
      s = Math.min(Math.max(s, 0), far / flat);
      ctx.lineTo(...this.toScreen(v, o[0] + dir[0] * s, o[2] + dir[2] * s));
    }
    ctx.closePath();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = T.viewColor;
    ctx.stroke();
    // Pings: a ring spreading and fading where an order went.
    for (const p of this.pings) {
      const f = p.t / Math.max(0.01, T.ping), [sx, sy] = this.toScreen(v, p.x, p.z);
      ctx.globalAlpha = 1 - f;
      ctx.beginPath();
      ctx.arc(sx, sy, 3 + 10 * f, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = p.color;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // A Ctrl-drag's selection box.
    const d = this.drag;
    if (d?.select) {
      ctx.setLineDash([3, 2]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(Math.min(d.x0, d.x1) + 0.5, Math.min(d.y0, d.y1) + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.setLineDash([]);
    }
  }
}
