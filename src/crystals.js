// Power crystals (a new game): one at each team's start, in its Keep (see buildings.js placeKeep). The crystal floats
// over the hole in the middle of the Keep's roof, slowly turning and bobbing, glowing in its team's colour and lighting
// the ground and villagers round it, with a beam of light going up into the sky from the bottom of the roof's hole
// (see beams.js).
//
// It's a unit of its own kind ('crystal', see Units): it's attacked like any villager, has CRYSTAL_TUNING.hp hit points
// and a health bar, and where the player can't see (fog of war) another team's is hidden, beam and all, as their
// villagers are. It never moves or fights. When it's destroyed its team is out of the game (see main.js eliminate).
// The unit stands on the plinth inside the Keep (so fighters can get at it, through its doors); it's drawn u.raise
// voxels higher, on the roof (see crystalBase).

export const CRYSTAL_TUNING = {
  hp: 500,          // hit points
  fire: 30,         // a fireball hurts it as it would a villager with this many hit points (35% of it, full on)
  sight: 12,        // voxels it sees round it (fog of war)
  hover: 0.65,      // voxels from the Keep's roof to its lower tip
  length: 3.45,      // voxels tip to tip
  width: 2.6,      // voxels across its middle
  waist: 0.38,      // where its middle is, from its lower tip (share of its length)
  bob: 0.18,        // voxels it bobs up and down
  bobSpeed: 1.1,    // bobs a second (radians)
  spin: 0.5,        // radians a second it turns
  glow: 1.45,        // how bright it glows from within (times its team's colour; see gem.js)
  gemIor: 1.64,      // how much light bends going in and out of it (index of refraction: glass 1.5, diamond 2.4)
  gemAbsorb: 0.05,   // how fast light inside takes its colour (a voxel)
  gemReflect: 3,    // the sky reflected on its facets
  gemSparkle: 3.15,    // the sun glinting on them
  gemRim: 0.45,      // rim light round its outline (can go overbright)
  gemRimPower: 12, // how tightly the rim hugs its outline (higher = thinner)
  gemSeeThrough: 0.69, // how much of what's behind it shows through (tinted)
  light: 4.7,       // how strongly it lights what's round it
  reach: 16,        // voxels its light reaches
  beam: 1.05,        // how bright its beam is (see beams.js)
  beamWidth: 2.43,  // voxels across at the bottom
  beamSpread: 0.015, // voxels wider per voxel up (each side)
  beamHeight: 180,  // voxels up
  beamFade: 25,     // fades up over this many voxels (to a third)
  beamEdge: 1,    // edge glow
  beamEdgePower: 1.6, // how tightly the edge glow hugs its edges (higher = thinner)
  beamBody: 0.12,   // the light between its edges
  beamStreaks: 0.5, // streaks running up it (0 = none)
  beamFlow: 12,      // voxels a second they run up
};

// The height the crystal floats over (its "plinth": the top of the Keep's roof), and where its beam starts (the
// bottom of the roof's hole).
export const crystalBase = (u) => u.pos[1] + (u.raise ?? 0);

// A team's glow colour: its colour brightened to full (the brightest channel 1), so a dark team colour still shines.
export function crystalColour(teamColour) {
  const m = Math.max(...teamColour, 1e-3);
  return teamColour.map((c) => (c / m) * 0.85 + 0.15 * (c / m) ** 0.5);
}

// A column-major matrix: turned `yaw` about y, scaled [sx, sy, sz], centred at c.
function turned(c, yaw, s) {
  const co = Math.cos(yaw), si = Math.sin(yaw);
  return [co * s[0], 0, -si * s[0], 0, 0, s[1], 0, 0, si * s[2], 0, co * s[2], 0, c[0], c[1], c[2], 1];
}

// Where crystal u is drawn now: its middle, how far it's turned and its colour.
function pose(u, time) {
  const T = CRYSTAL_TUNING, bob = Math.sin(time * T.bobSpeed + u.id) * T.bob;
  const y = crystalBase(u) + T.hover + bob + T.length / 2;
  return { c: [u.pos[0], y, u.pos[2]], yaw: time * T.spin + u.id };
}

// Parts for the unit renderer (see Units.parts): each crystal the player can see. colourOf(team): the team's colour
// (linear). A crystal flashes white when it's hit, like a villager.
export function crystalParts(units, time, colourOf, out) {
  const T = CRYSTAL_TUNING;
  for (const u of units.list) {
    if (u.kind !== 'crystal' || u.hidden || u.dying) continue;
    const { c, yaw } = pose(u, time), glow = crystalColour(colourOf(u.team));
    const flash = Math.min(1, u.hurt / 0.12);
    const col = glow.map((v) => (v * T.glow) + (1 - v) * flash);
    const m = turned(c, yaw, [T.width, T.length, T.width]);
    m[11] = u.selected ? 1 : 0; // (outlined, selected: see units-render.js)
    out.push({ m, col, emit: -1, shape: 'gem' }); // (only for its selection outline: it's drawn by gem.js)
  }
}

// The gems (see Gems.draw): each crystal the player can see, where it is now, in its colour, white as it's hit.
export function crystalGems(units, time, colourOf) {
  const out = [];
  for (const u of units.list) {
    if (u.kind !== 'crystal' || u.hidden || u.dying) continue;
    const { c, yaw } = pose(u, time);
    out.push({ c, yaw, col: crystalColour(colourOf(u.team)), flash: Math.min(1, (u.hurt ?? 0) / 0.12) });
  }
  return out;
}

// The beams (see Beams.draw): one from the bottom of each seen crystal's roof hole, in its colour. (They don't turn.)
export function crystalBeams(units, colourOf) {
  const out = [];
  for (const u of units.list) {
    if (u.kind !== 'crystal' || u.hidden || u.dying) continue;
    out.push({ base: [u.pos[0], crystalBase(u) - 1, u.pos[2]], col: crystalColour(colourOf(u.team)) });
  }
  return out;
}

// Each crystal the player can see as a light: [x, y, z, reach, r, g, b] (colour × strength; times the exposure by
// the caller).
export function crystalLights(units, time, colourOf) {
  const T = CRYSTAL_TUNING, out = [];
  for (const u of units.list) {
    if (u.kind !== 'crystal' || u.hidden || u.dying) continue;
    const { c } = pose(u, time), glow = crystalColour(colourOf(u.team));
    out.push([...c, Math.max(5, T.reach), ...glow.map((v) => v * T.light)]);
  }
  return out;
}
