// Army strength pie, at the top of the screen in the middle: each team's slice is its share of every team's points
// (the sum of its living villagers' class points). A team is anchored to its own quarter of the pie (blue top left,
// red top right, yellow bottom right, purple bottom left) and its slice grows or shrinks from there, with its total
// beside that quarter. Teams with no one left drop out; with no one at all the pie is empty.

// What each class is worth (T > Army strength).
export const STRENGTH_TUNING = {
  worker: 1,
  priest: 3,
  warrior: 3,
  spearman: 4,
  barbarian: 4,
  archer: 4,
  mage: 5,
  knight: 5,
  scout: 4,
  ease: 6,             // how fast the slices slide to a new split (per s; 0 = jumps)
  blueColor: '#4169e1',
  redColor: '#c8251f',
  yellowColor: '#e8b818',
  purpleColor: '#7a2fc0',
};

// The teams round the pie clockwise, each with the middle of its quarter (degrees clockwise from 12 o'clock).
const QUARTERS = [['blue', 315], ['red', 45], ['yellow', 135], ['purple', 225]];
const SVG = 'http://www.w3.org/2000/svg';
const R = 50; // the pie's radius in its viewBox (-50..50)

const wrap = (a) => ((a + 180) % 360 + 360) % 360 - 180;
const point = (deg) => { const a = deg * Math.PI / 180; return `${(R * Math.sin(a)).toFixed(3)} ${(-R * Math.cos(a)).toFixed(3)}`; };
// A slice from `from` round `span` degrees clockwise (a whole disc when it's all of it).
function slice(from, span) {
  if (span >= 359.99) return `M 0 ${-R} A ${R} ${R} 0 1 1 0 ${R} A ${R} ${R} 0 1 1 0 ${-R} Z`;
  return `M 0 0 L ${point(from)} A ${R} ${R} 0 ${span > 180 ? 1 : 0} 1 ${point(from + span)} Z`;
}

export class StrengthBar {
  constructor(el) {
    this.el = el;
    el.textContent = '';
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '-54 -54 108 108');
    svg.classList.add('sb-pie');
    const back = document.createElementNS(SVG, 'circle');
    back.setAttribute('r', R);
    back.classList.add('sb-back');
    svg.append(back);
    this.teams = QUARTERS.map(([team, anchor]) => {
      const path = document.createElementNS(SVG, 'path');
      path.classList.add('sb-slice');
      svg.append(path);
      const num = document.createElement('span');
      num.className = `sb-num sb-num-${team}`;
      el.append(num);
      return { team, anchor, path, num, share: 0, points: 0 };
    });
    const ring = document.createElementNS(SVG, 'circle');
    ring.setAttribute('r', R);
    ring.classList.add('sb-ring');
    svg.append(ring);
    el.prepend(svg);
    this.shown = '';
  }

  update(list, dt) {
    const T = STRENGTH_TUNING, teams = this.teams;
    for (const t of teams) t.points = 0;
    for (const u of list) {
      if (u.dying) continue;
      const t = teams.find((o) => o.team === u.team);
      if (t) t.points += T[u.kind] ?? 1;
    }
    const total = teams.reduce((s, t) => s + t.points, 0);
    const k = T.ease > 0 ? 1 - Math.exp(-T.ease * dt) : 1;
    for (const t of teams) {
      const want = total > 0 ? t.points / total : 0;
      t.share += (want - t.share) * k;
      if (Math.abs(t.share - want) < 1e-4) t.share = want;
    }
    // Lay the slices end to end in quarter order, then turn the whole pie so each slice's middle sits as near its
    // quarter's middle as it can (the mean of their misses; a slice only just appearing counts for little).
    const sum = teams.reduce((s, t) => s + t.share, 0) || 1;
    let at = 0, sx = 0, sy = 0;
    for (const t of teams) {
      t.span = t.share / sum * 360;
      t.from = at;
      at += t.span;
      const miss = (t.from + t.span / 2 - t.anchor) * Math.PI / 180, w = Math.min(1, t.share * 20);
      sx += w * Math.cos(miss);
      sy += w * Math.sin(miss);
    }
    const turn = sx || sy ? -Math.atan2(sy, sx) * 180 / Math.PI : 0;

    const num = (v) => (Number.isInteger(v) ? `${v}` : v.toFixed(1));
    const key = teams.map((t) => `${(t.from + turn).toFixed(2)} ${t.span.toFixed(2)} ${t.points} ${T[`${t.team}Color`]}`).join(' ');
    if (key === this.shown) return; // touch the DOM only when something changed
    this.shown = key;
    for (const t of teams) {
      const on = t.span > 0.05;
      t.path.style.display = on ? '' : 'none';
      if (on) t.path.setAttribute('d', slice(wrap(t.from + turn), t.span));
      t.path.style.fill = T[`${t.team}Color`];
      t.num.style.color = `color-mix(in srgb, ${T[`${t.team}Color`]} 75%, white)`;
      t.num.hidden = t.points <= 0;
      t.num.textContent = num(t.points);
    }
  }
}
