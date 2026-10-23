// Scorched ground where fireballs burst (after space-miner's red-hot rock): the crater glows red-hot, cools over a
// second or two, and leaves the ground charred black, darkest at the middle and patchy at its soft edge.
//
// The glow is a short list of hot spots (centre, reach, heat now) the shader sums each frame. The char is a
// sphere in space round each blast's centre (terrain.blastList; terrain.blastCells tell the shader which blasts reach
// where): every voxel there when the blast went off is charred, whatever's in front of it (terrain.char marks those
// voxels; a block put down later stays clean), with the blast mark projected along the fireball's flight.

export const SCORCH_TUNING = {
  heat: 1.5,       // heat a blast leaves at its centre (above 1 runs yellow-white)
  heatReach: 1.2,  // how far the heat reaches, × the blast radius (hottest at the centre)
  heatCool: 1.5,   // seconds for a blast's heat to cool to about a third
  glow: 4,         // emissive brightness of the red-hot ground
  char: 0.9,       // how dark the char is at its darkest, near the centre (0 = none, 1 = black)
  charSpread: 2.85, // voxels the char reaches past the heat
  charFade: 1,     // voxels from the centre at which the char starts fading out (it's gone at the edge)
  charPatches: 0.35, // how patchy the char is (0 = an even fade)
  charGrain: 1.6,  // size of the char's patches (voxels)
  decal: 1,        // how strongly the blast mark (textures/blast.png, multiplied in) shows, projected along the fireball's flight (0 = not at all)
  decalSize: 1,    // the blast mark's radius, × the char's reach
};

export const MAX_HOT = 8;
export const SCORCH_FLOATS = 12 + MAX_HOT * 8; // three of settings, then per spot (centre, reach), (heat, -, -, -)

export class Scorch {
  // onChar({ lo, hi, index }): blast number `index` was added, charring the voxel box [lo, hi) (upload them).
  constructor(terrain, onChar) {
    this.terrain = terrain;
    this.onChar = onChar;
    this.spots = []; // { pos, reach, heat, cool }
    this.data = new Float32Array(SCORCH_FLOATS);
  }

  // A blast of `radius` voxels at p, by a fireball flying along dir. hidden: where the player can't see (fog of war):
  // it chars the ground but doesn't glow.
  blast(p, radius, dir, hidden = false) {
    const T = SCORCH_TUNING;
    const reach = radius * T.heatReach;
    if (hidden) {
      const box = this.terrain.scorch(p, reach + T.charSpread, dir, Math.random());
      if (box) this.onChar?.(box);
      return;
    }
    if (this.spots.length >= MAX_HOT) {
      this.spots.sort((a, b) => b.heat - a.heat);
      this.spots.length = MAX_HOT - 1; // the coolest goes
    }
    this.spots.push({ pos: [...p], reach, heat: T.heat, cool: T.heatCool });
    const box = this.terrain.scorch(p, reach + T.charSpread, dir, Math.random());
    if (box) this.onChar?.(box);
  }

  update(dt) {
    for (const s of this.spots) s.heat *= Math.exp(-dt / Math.max(s.cool, 0.05));
    this.spots = this.spots.filter((s) => s.heat > 0.005);
  }

  // The shader's scorch uniforms (see render.js Frame.scorch).
  uniforms() {
    const T = SCORCH_TUNING, d = this.data;
    d.fill(0);
    d.set([this.spots.length, T.glow, T.char, 1 / Math.max(T.charGrain, 0.05)], 0);
    d.set([T.charFade, T.decal, T.decalSize, 0], 4);
    d.set([T.heat, T.charPatches, 0, 0], 8);
    this.spots.forEach((s, i) => {
      d.set([...s.pos, s.reach], 12 + i * 8);
      d[16 + i * 8] = s.heat;
    });
    return d;
  }
}
