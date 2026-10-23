// Control groups (RTS-style): Ctrl+number makes the selection group number (Ctrl with nothing selected disbands it),
// Shift+number adds the selection to it, the number selects it (twice quickly: and the camera goes to it). One of each
// group carries its banner on a pole on its back, in its team's colour with the group's number on it (drawn in
// units.js, see bannerParts); clicking the banner is the same as the number. When the bearer dies another member
// takes the banner up, and a group with none left is gone.

import { mat4 } from './math.js';

export const GROUP_TUNING = {
  doubleTap: 0.35, // seconds: a group's number pressed again within this goes to it
};

export class Groups {
  constructor(units) {
    this.units = units;
    this.groups = new Map(); // number (0-9) -> { members: Set of units, bearer }
    this.last = { n: -1, at: 0 };
  }

  // Ctrl+number (add false) or Shift+number (add true) with these units.
  assign(n, sel, add = false) {
    if (!add) {
      if (!sel.length) { this.disband(n); return; }
      this.disband(n);
    }
    if (!sel.length) return;
    const g = this.groups.get(n) ?? { members: new Set(), bearer: null };
    for (const u of sel) g.members.add(u);
    this.groups.set(n, g);
    this.update();
  }

  disband(n) {
    const g = this.groups.get(n);
    if (!g) return;
    if (g.bearer) g.bearer.banners = g.bearer.banners.filter((b) => b !== n);
    this.groups.delete(n);
  }

  // The number pressed (or its banner clicked): selects the group, and twice quickly, centres the camera on it.
  // Returns the group's middle [x, z] for that, or null.
  select(n, now = performance.now() / 1000) {
    const g = this.groups.get(n);
    if (!g) return null;
    for (const u of this.units.list) u.selected = g.members.has(u) && !u.hidden;
    const again = this.last.n === n && now - this.last.at < GROUP_TUNING.doubleTap;
    this.last = { n, at: again ? -Infinity : now };
    if (!again) return null;
    let x = 0, z = 0;
    for (const u of g.members) { x += u.pos[0]; z += u.pos[2]; }
    return [x / g.members.size, z / g.members.size];
  }

  // Each frame: the dead (and those gone over to another side) dropped, a new bearer for a banner whose one fell
  // (one not carrying a banner already if there is one), and a group with none left disbanded.
  update() {
    for (const [n, g] of this.groups) {
      for (const u of g.members) if (u.dying || !this.units.list.includes(u)) g.members.delete(u);
      if (g.bearer && !g.members.has(g.bearer)) {
        g.bearer.banners = g.bearer.banners.filter((b) => b !== n);
        g.bearer = null;
      }
      if (!g.members.size) { this.groups.delete(n); continue; }
      if (!g.bearer) {
        const free = [...g.members].find((u) => !u.banners?.length);
        g.bearer = free ?? [...g.members][0];
        g.bearer.banners = [...(g.bearer.banners ?? []), n];
      }
    }
  }

  // The group whose banner the ray (ro, rd) hits first, or -1 (the banner's flag, as units.js last drew it: a box a
  // little bigger, so it's easy to click).
  bannerAt(ro, rd) {
    let best = -1, bestT = Infinity;
    for (const [n, g] of this.groups) {
      const u = g.bearer;
      if (!u?.bannerBox || u.hidden || u.banners[0] !== n) continue;
      const inv = mat4.invert(u.bannerBox);
      const o = mat4.project(inv, ...ro), d = [0, 1, 2].map((i) => inv[i] * rd[0] + inv[4 + i] * rd[1] + inv[8 + i] * rd[2]);
      let t0 = 0, t1 = Infinity;
      for (let a = 0; a < 3; a++) {
        const r = a === 2 ? 4 : 0.65; // (half sizes, in the flag's own box: it's thin)
        const k = 1 / d[a];
        let ta = (-r - o[a]) * k, tb = (r - o[a]) * k;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
      }
      if (t0 <= t1 && t0 < bestT) { bestT = t0; best = n; }
    }
    return best;
  }
}
