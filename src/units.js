// NPCs: blocky villagers that stand on the voxel terrain, are selected RTS-style and walk where they're told.
//
// A unit is 1 voxel wide and deep and 2 tall, and stands in a voxel cell: the cell below its feet is solid and the
// two cells it occupies are air. It can step up or down one voxel between neighbouring cells (diagonals too, when
// both cells beside the diagonal leave it room to pass), and hop down a drop of up to maxDrop straight ahead. Paths come from A* over those cells, so they follow
// overhangs and tunnels as well as the surface. They stay out of the water, and don't collide with each other.

import { SIZE, BLOCK, WATER_LEVEL } from './terrain.js';
import { Workers, toolFor, workTime } from './jobs.js';
import { linearColor } from './sky.js';
import { Ragdoll, RAGDOLL_TUNING } from './ragdoll.js';
import { POSSESS_TUNING } from './camera.js';
import { CRYSTAL_TUNING } from './crystals.js';
import { MOUNTS, MOUNT_TUNING, mountLift, horseParts, horseBob, HorseRagdoll } from './horse.js';
import { sfx } from './audio.js';
import { Ladders, LADDER_TUNING } from './ladders.js';
import { WALL_TUNING } from './walls.js';
import { bannerShape } from './banner-shape.js';
import { splashWater, splashBlood, SPLASH_TUNING } from './splash.js';

export const UNIT_TUNING = {
  // Each class's walking speed, voxels per second.
  workerSpeed: 3.2, warriorSpeed: 3.2, archerSpeed: 3.2, spearmanSpeed: 3.2, mageSpeed: 3.2, priestSpeed: 3.2, barbarianSpeed: 3.4,
  knightSpeed: 4.8, scoutSpeed: 6.4, // (mounted: a knight 1.5 times a warrior's, a scout twice an archer's)
  climbSpeed: 6,       // voxels per second when stepping up or down
  maxExpanded: 60000,  // A* gives up (and goes as near as it got) after expanding this many cells
  repathDelay: 0.25,   // seconds after an edit blocks the path before looking for a new one
  maxDrop: 3,          // voxels it can hop down (not climb back up)
  dropSpeed: 14,       // voxels per second falling
  wristCone: 1.1,      // radians a hand can bend at the wrist, any way (a ball joint, limited to a cone)
};

// Torches (T panel): villagers carry a Minecraft torch in the left hand at night, lighting the ground around them.
export const TORCH_TUNING = {
  color: '#feca9a',  // the flame's light
  strength: 1.45,      // its brightness
  radius: 10.5,        // voxels it reaches
  flicker: 0.24,      // how much it flickers
  sunBelow: 4,       // lit while the sun is lower than this (degrees above the horizon)
};

const [X, Y, Z] = SIZE;
const key = (x, y, z) => x + X * (z + Z * y);
const unkey = (k) => [k % X, Math.floor(k / (X * Z)), Math.floor(k / X) % Z];

// Villagers come in classes (CLASSES): a worker takes on building jobs, with the tool for each, and never fights, even
// when attacked; a warrior always has its sword in hand, never takes on jobs, and goes for the nearest enemy within
// `aggro` (or one it's told to attack, or that attacks it). The rest fight from afar (RANGED): an archer always has its
// bow (and a quiver of arrows on its back) and shoots at any enemy in bowRange; a spearman throws its spear overhand at
// any in spearRange, slower but harder; a fire mage casts fireballs from its staff at any in fireRange, which blow a
// hole fireBlast voxels round where they burst and hurt every enemy in it. Each goes for one it's told to attack too,
// walking up to its range of it first when that's further. A priest never attacks: it channels a beam of light from its
// ankh into the most hurt of its side within healSeek voxels (not itself, nor one another priest of its side is
// already on), healing healAmount hit points every healTick seconds while it's within beamRange, walking to get there (unless it was
// sent somewhere). Turning to another, it waits switchTime before its beam can start again. A barbarian goes for enemies
// like a warrior, but with no swing: whenever an enemy is within whirlRange of it (even walking where it was sent) it
// whirls, spinning whirlSpin times a second with its double-bladed axe held out, and every whirlTime seconds it hits
// every enemy within axeReach for axeDamage hit points. A knight and a scout ride horses (see horse.js): a knight
// fights as a warrior and a scout as an archer (their role, MOUNTS), only faster, sitting up in the saddle.
//
// A warrior closes in and swings its sword every attackTime seconds while within range, for swordDamage hit points a
// blow (an archer's arrows take arrowDamage, a spear spearDamage, a fireball fireDamage per cent of each one's full hit
// points: rock-paper-scissors, melee tough with little flat damage, bows and spears frail with lots, so melee beats
// them, mages frailest with damage that grows with their target's hit points, so they beat melee); at no hit points left it
// tumbles to the ground (see ragdoll.js) and is gone. Several on one enemy spread round it, a side each (then the
// corners), rather than crowding one square. Arrows and spears strike a random spot on whoever they're aimed at.
export const COMBAT_TUNING = {
  // Each class's hit points (when it's made).
  workerHp: 20, warriorHp: 70, archerHp: 18, spearmanHp: 30, mageHp: 12, priestHp: 20, barbarianHp: 75, knightHp: 100, scoutHp: 30,
  swordDamage: 3,   // hit points a sword blow takes
  arrowDamage: 6,   // and an arrow
  attackTime: 1,      // seconds a swing takes
  twist: 0.45,        // radians a warrior's upper body turns into a slash (and a spearman's into its throw, a little more)
  lunge: 0.12,        // voxels a warrior steps forward into a slash
  range: 1.6,         // voxels from the one it's fighting that it can strike from (a corner's 1.41 away)
  chaseRepath: 0.5,   // seconds between new paths when chasing
  goneAfter: 9,       // seconds a fallen villager lies there before it's gone
  drownDamage: 5,     // hit points a second a villager stuck in the water (nowhere to climb out to) loses: it drowns
  aggro: 15,           // voxels: an enemy this near is attacked (except by a villager walking where it was sent)
  bringFriend: 10,     // voxels: one that turns on whoever hurt it calls its fighters this near to that enemy too
  bowRange: 20,       // voxels an archer shoots to (standing, it shoots whatever enemy it can see nearest)
  shootTime: 1.2,     // seconds to draw and loose an arrow
  arrowSpeed: 16,     // voxels per second
  arrowMiss: 0.2,     // the chance an arrow misses, landing in the ground near its target
  arrowStick: 5,      // seconds an arrow (or a spear that missed) stays stuck in the ground or in whoever it hit
  spearDamage: 12,    // hit points a spear takes
  spearRange: 16,     // voxels a spearman throws to
  throwTime: 3,       // seconds between throws
  spearSpeed: 12,     // voxels per second
  fireDamage: 35,     // per cent of its full hit points a fireball's blast takes from each enemy within fireFull of it
  fireFull: 1,        // voxels from the burst that take the full fireDamage; beyond, it falls off linearly to
  fireEdge: 10,       // per cent of full hit points at the blast's edge
  fireRange: 16,      // voxels a fire mage casts to
  castTime: 2,        // seconds between fireballs
  fireSpeed: 10,      // voxels per second
  fireBlast: 2,       // voxels: the radius of the hole its blast makes (and of whoever it hurts)
  healAmount: 2,      // hit points a priest's beam gives back each healTick (up to their full)
  healTick: 0.5,      // seconds between them
  beamRange: 10,      // voxels a priest's beam reaches
  healSeek: 20,       // voxels: a priest goes for the most hurt of its side this near
  switchTime: 0,      // seconds a priest's beam waits after it turns to another
  switchMargin: 0.1,  // it turns from the one it's healing to another only when that one's this much more hurt (share of hit points)
  beamWidth: 0.08,    // voxels across its beam
  beamColor: '#ffe7a0',
  beamGlow: 2.5,      // how much brighter than its colour the beam shines (past 1 it saturates towards white, and blooms)
  plasma: 14,         // glowing wisps a second per voxel of beam, like hot plasma
  plasmaSize: 0.16,   // voxels: their size
  plasmaLife: 0.5,    // seconds they last
  plasmaGlow: 1.6,    // how bright they are
  plasmaDrift: 0.35,  // voxels a second they drift off the beam
  whirlRange: 2.5,    // voxels: a barbarian whirls while an enemy is this near
  axeReach: 2,        // voxels: its whirling axe hits every enemy this near
  axeDamage: 1.2,     // hit points each of its whirling axe's hits takes
  whirlTime: 0.4,     // seconds between those hits
  whirlSpin: 2.5,     // turns a second it spins at
  lookEvery: 0.5,     // seconds between looks for one (and, fighting one it wasn't told to, for a nearer one)
  retarget: 2,        // voxels nearer another enemy has to be for one fighting an enemy it wasn't told to to switch
  spread: 3,          // picking an enemy itself, each of its side already on one counts as it being this many voxels further
};

// How a blow lands (T > Hit feedback): the one hit flashes white, stops dead for a moment (hit-freeze), then is
// knocked back a little, away from the blow.
export const HIT_TUNING = {
  flash: 0.18,       // seconds the white flash takes to fade
  flashStrength: 0.52, // how white it goes (0-1)
  freeze: 0,         // seconds it stops dead (its moves, swings and walk all held)
  knock: 0.14,       // voxels it's knocked back (only how it's drawn: where it stands, and so its reach, is kept)
  knockTime: 0.06,   // seconds that takes, out quickly and then easing back
};
// Its eyes (T > Eyes): now and then it blinks, a blow makes it wince (a long blink: shut quickly, held, opened slowly),
// and once it's dead they're crosses. An eye closes from its top down, to `closed` of its height.
export const EYE_TUNING = {
  blinkMin: 2,       // seconds between blinks, at least
  blinkMax: 6,       // and at most
  blinkTime: 0.16,   // seconds a blink takes, shut and open again
  closed: 0.12,      // how much of an eye's height is left shut (0-1)
  wince: 0.3,        // seconds a wince takes
  winceShut: 0.12,   // of which shutting (0-1 of it)
  winceOpen: 0.4,    // and opening again (the rest it's held shut)
  winceTilt: 25,     // degrees its eyes turn in as it winces, their inner ends lower
  cross: 0.034,      // a dead one's crosses: each of their 5 squares this wide
};
// How villagers look (T > Looks): each has its own hairstyle (HAIRSTYLES), hair colour and skin tone, picked by its id;
// hairStyle, hairColour or skinTone 0 or more gives every villager that one (to see each), -1 each its own. A
// barbarian wears crossed leather straps over its bare chest (harness 0 takes them off).
export const LOOK_TUNING = {
  hairStyle: -1,
  hairColour: -1,
  skinTone: -1,
  skin0: '#ffe7d1',  // fair
  skin1: '#f3d3b4',  // light
  skin2: '#ecbc93',  // tan
  skin3: '#d8aa69',  // brown
  skin4: '#5f351c',  // deep brown
  hair0: '#957c61',  // light brown
  hair1: '#61554b',  // dark brown
  hair2: '#c4a676',  // dark blond
  hair3: '#f7dda1',  // blond
  hair4: '#cd6632',  // auburn
  hair5: '#d6d6d6',  // grey
  hair6: '#2e2925',  // black
  harness: 1,
  darkEyes: '#0b0b0d', // the eyes of those with the deepest skin tone (skin4), darker so they still show
  // Body type A's toga drape, a sash over the left shoulder: sashTop across there, sashBottom at the waist, leaning
  // in towards the middle by sashLean (radians).
  sashTop: 0.2,
  sashBottom: 0.4,
  sashLean: -0.21,
  // Body type B (any class): a narrower waist, wider hips, and a chest that widens out from the waist to
  // under the bust, then narrows back in to the shoulders. bodyType -1: each villager its own (about half are B), 0 all
  // A, 1 all B. Widths and depths in voxels; underBust the height (from the feet) where the chest is widest.
  bodyType: -1,
  waistWidth: 0.39,    // across at the waist (A: 0.42)
  waistDepth: 0.26,    // front to back there (A: 0.34)
  chestWidth: 0.59,    // under the bust
  bustDepth: 0.47,
  underBust: 1.16,
  shoulderWidth: 0.5,  // at the top (A: 0.56)
  shoulderDepth: 0.28,
  // Its skirt flares straight out from the waist: each half hipTop across at the top and hem across at its hem (A:
  // 0.26 and 0.4), skirtIn closer to the middle than its leg, and topDepth and hemDepth front to back.
  hipTop: 0.28,
  hem: 0.45,
  skirtIn: 0.04,
  topDepth: 0.3,
  hemDepth: 0.45,
  chin: 0.39,          // its head's width at the chin (the top's 0.5, as A's)
};
export const SKIN_TONES = 5, HAIR_COLOURS = 7;
// How far into a wince u is, 0 (none) - 1 (screwed shut).
function winceOf(u) {
  const E = EYE_TUNING;
  if (!(u.wincing > 0)) return 0;
  const t = 1 - u.wincing / Math.max(E.wince, 1e-3);
  return Math.max(0, Math.min(1, t / Math.max(E.winceShut, 1e-3), (1 - t) / Math.max(E.winceOpen, 1e-3)));
}
// How villagers move (T > Animation): walking, their upper body leans into it, turns against their stride and tilts
// over the foot they're on, their arms swing a little out and across and their hands trail; a blow throws their upper
// body the way it knocks them, and their arms out; workers lean and twist into their work, and spearmen, mages and
// priests into a throw, cast or heal; a whirling barbarian leans out against its spin and staggers after; and a priest
// prays a moment, its staff raised, before its heal goes out.
export const ANIM_TUNING = {
  walkLean: 0.07,    // radians the upper body leans forward walking
  walkTwist: 0.1,    // radians it turns against each stride (shoulders against hips)
  walkSway: 0.035,   // radians it tilts over the foot it's on
  armCross: 0.12,    // radians the arms swing in across the body as they come forward
  armOut: 0.06,      // radians they hang out from the sides
  wristLag: 0.3,     // radians the hands trail the arms' swing
  climbLean: 0.2,    // radians it leans into a step up
  flinch: 0.3,       // radians a blow throws the upper body (a spear or fireball's more, an axe's less)
  flinchTime: 0.35,  // seconds to get over it
  flinchArms: 0.5,   // radians the arms jerk out (unless they're busy)
  workLean: 1,       // how far a worker leans, tilts and twists into its work (1 as made)
  castLean: 1,       // and a spearman, mage or priest into a throw, cast or its heal
  whirlLean: 0.22,   // radians a whirling barbarian leans out against its spin
  dizzy: 0.9,        // seconds it staggers once it stops
  settle: 0.15,      // seconds a sudden change of pose (a new target, a swing cut short) is eased over
};
// How hard each weapon's blow makes the one it hits flinch (see ANIM_TUNING.flinch).
const FLINCH = { sword: 1, arrow: 0.7, spear: 1.4, fire: 1.3, axe: 0.6 };

// How open u's eyes are, 0 (shut) - 1.
function eyeOpen(u) {
  const E = EYE_TUNING;
  let shut = winceOf(u);
  if (u.blinking != null) shut = Math.max(shut, Math.sin(Math.PI * Math.min(1, u.blinking / Math.max(E.blinkTime, 1e-3))));
  return 1 - shut * (1 - E.closed);
}

// How far through being knocked back u is drawn, as an offset [x, z] in voxels.
function knockOffset(u) {
  if (!u.knock) return null;
  const x = u.knock.t / Math.max(HIT_TUNING.knockTime, 1e-3), k = x < 0.3 ? ease(x / 0.3) : 1 - ease(Math.min(1, (x - 0.3) / 0.7));
  return [u.knock.dir[0] * k, u.knock.dir[1] * k];
}

export const CLASSES = ['worker', 'warrior', 'archer', 'spearman', 'mage', 'priest', 'barbarian', 'knight', 'scout'];
// The classes that fight from afar: each one's range, seconds between shots, and what it shoots (see Units.loose).
const RANGED = {
  archer: { range: 'bowRange', time: 'shootTime', speed: 'arrowSpeed', what: 'arrow', arc: 0.12 },
  spearman: { range: 'spearRange', time: 'throwTime', speed: 'spearSpeed', what: 'spear', arc: 0.1 },
  mage: { range: 'fireRange', time: 'castTime', speed: 'fireSpeed', what: 'fire', arc: 0.05 },
};
// When in its cycle (0-1) each lets fly: an archer at the end of its draw, a spearman at the end of its wind-up, a
// mage once its orb has gathered its fire.
const LOOSE = { archer: 1, spearman: 0.45, mage: 0.7 };
// Sounds (see audio.js): what a ranged villager's cycle starts with, what each weapon's blow sounds like, what a
// dropped tool falls as, and a villager's footsteps by what's underfoot.
const DRAW_SOUND = { archer: 'bowDraw', mage: 'orbCharge' };
const BLOW_SOUND = { sword: 'swordHit', axe: 'axeHit', arrow: 'arrowHit', spear: 'spearHit' };
const METAL_TOOLS = new Set(['sword', 'pickaxe', 'axe', 'hammer', 'sickle']);
const chest = (u) => [u.pos[0], u.pos[1] + 1 + mountLift(u), u.pos[2]];
function stepSound(terrain, [x, y, z]) {
  const b = terrain.block(x, y - 1, z);
  return b === BLOCK.PLANK || b === BLOCK.LOG ? 'stepWood'
    : b === BLOCK.STONE || b === BLOCK.BRICK || b === BLOCK.IRON || b === BLOCK.GOLD || b === BLOCK.OBSIDIAN ? 'stepStone' : 'stepGrass';
}

// Teams, by the colour of their followers' togas (linear rgb). The player's villagers are blue; red ones (M) take
// orders too for now, but never take on jobs.
export const TEAMS = {
  blue: { name: 'Blue', toga: [0.053, 0.141, 0.753] }, // royal blue, #4169e1
  red: { name: 'Red', toga: [0.62, 0.035, 0.03] },     // crimson
  yellow: { name: 'Yellow', toga: [0.807, 0.479, 0.009] }, // goldenrod, #e8b818 (a new game's second opponent)
  purple: { name: 'Purple', toga: [0.195, 0.028, 0.527] }, // violet, #7a2fc0 (its third)
};
// A team's number for the selection outline (units-render.js): 1 blue, 2 red, 3 yellow, 4 purple.
const SEL_INDEX = { blue: 1, red: 2, yellow: 3, purple: 4 };

// What a fist holds, as boxes in the arm's frame from the fist: [centre, size, colour], or a colour of null for the
// torch's flame. Tools and the sword go in the right fist, the torch and the bow in the left.
const WOOD = [0.42, 0.26, 0.12], IRON = [0.42, 0.44, 0.48], EDGE = [0.7, 0.72, 0.76], LEATHER = [0.36, 0.2, 0.09];
// A sandal, in the leg's frame from the hip: its sole and laces.
const SANDAL = [[[0, -0.715, 0.03], [0.26, 0.07, 0.34], LEATHER], [[0, -0.58, 0], [0.24, 0.05, 0.28], LEATHER]];
// A warrior's kit. Boots, in the leg's frame from the hip: shaft, foot and turned-down cuff.
const STEEL = [0.56, 0.58, 0.62], DARK_LEATHER = [0.22, 0.13, 0.07];
const BOOT = [
  [[0, -0.52, 0], [0.25, 0.38, 0.3], DARK_LEATHER],
  [[0, -0.69, 0.06], [0.27, 0.12, 0.4], DARK_LEATHER],
  [[0, -0.36, 0], [0.27, 0.08, 0.32], LEATHER],
];
// A pauldron on the sword arm, in the arm's frame from the shoulder (its outside is -x): two overlapping plates.
const PAULDRON = [
  [[-0.03, -0.01, 0], [0.27, 0.15, 0.3], STEEL],
  [[-0.06, -0.12, 0], [0.24, 0.09, 0.27], IRON],
];
// A helmet, in the head's frame from the neck (the face is +z), with the team-coloured plume as a colour of null: the
// dome, a brim round it, cheek guards, the back of the neck, a nose guard and a crest running front to back.
const HELMET = [
  [[0, 0.52, 0], [0.56, 0.2, 0.58], STEEL],
  [[0, 0.42, 0], [0.6, 0.04, 0.62], IRON],
  [[0.27, 0.3, -0.03], [0.04, 0.26, 0.42], STEEL],
  [[-0.27, 0.3, -0.03], [0.04, 0.26, 0.42], STEEL],
  [[0, 0.29, -0.285], [0.54, 0.26, 0.08], STEEL],
  [[0, 0.33, 0.28], [0.06, 0.2, 0.04], IRON],
  [[0, 0.65, -0.02], [0.07, 0.06, 0.6], IRON],
  [[0, 0.74, -0.04], [0.09, 0.14, 0.58], null],
  [[0, 0.79, -0.22], [0.07, 0.14, 0.24], null],
];
const HELD = {
  // Straight out of the fist along the arm, like the shovel.
  sword: [
    [[0, 0.02, 0.02], [0.07, 0.16, 0.07], LEATHER],   // grip
    [[0, -0.08, 0.02], [0.26, 0.05, 0.09], IRON],     // crossguard
    [[0, -0.46, 0.02], [0.08, 0.7, 0.03], EDGE],      // blade
  ],
  // The shovel carries on straight out of the fist, along the arm; the rest are held across it.
  shovel: [
    [[0, -0.24, 0.02], [0.06, 0.52, 0.06], WOOD],     // handle
    [[0, -0.58, 0.02], [0.2, 0.22, 0.03], IRON],      // blade
  ],
  axe: [
    [[0, 0, 0.22], [0.06, 0.06, 0.78], WOOD],         // handle
    [[0, -0.1, 0.52], [0.05, 0.22, 0.16], IRON],      // head
    [[0, -0.22, 0.52], [0.03, 0.05, 0.22], EDGE],     // and its bit
  ],
  hammer: [
    [[0, 0, 0.22], [0.06, 0.06, 0.78], WOOD],         // handle
    [[0, -0.02, 0.5], [0.1, 0.26, 0.11], IRON],       // head
  ],
  pickaxe: [
    [[0, 0, 0.22], [0.06, 0.06, 0.78], WOOD],         // handle
    [[0, 0, 0.56], [0.06, 0.62, 0.08], IRON],         // head, both ways
  ],
  // Farming (farm.js): a hoe tills, swung like the pickaxe; a sickle reaps, one-handed like the hammer.
  hoe: [
    [[0, 0, 0.22], [0.06, 0.06, 0.78], WOOD],         // handle
    [[0, -0.05, 0.6], [0.05, 0.12, 0.05], IRON],      // neck
    [[0, -0.16, 0.58], [0.2, 0.14, 0.03], IRON],      // blade, across the handle
  ],
  sickle: [
    [[0, 0, 0.1], [0.06, 0.06, 0.3], WOOD],           // handle
    [[0, 0, 0.3], [0.02, 0.05, 0.14], EDGE],          // blade, hooking round
    [[0, -0.07, 0.38], [0.02, 0.16, 0.05], EDGE],
    [[0, -0.15, 0.31], [0.02, 0.05, 0.14], EDGE],
  ],
  // A Minecraft torch: the arm points forward, so the arm's +z is up: the stick stands on the fist, its tip aflame.
  torch: [
    [[0, -0.02, 0.24], [0.08, 0.08, 0.44], WOOD],
    [[0, -0.02, 0.5], [0.1, 0.1, 0.1], null],
  ],
};
// An archer's bow, standing across the forward-pointing arm, its string pulled back towards the drawing hand by
// `draw` (0-1).
const bowParts = (draw) => [
  [[0, 0, 0], [0.07, 0.08, 0.16], LEATHER],           // grip
  [[0, 0.06, 0.3], [0.05, 0.06, 0.46], WOOD],         // limbs, curving back
  [[0, 0.06, -0.3], [0.05, 0.06, 0.46], WOOD],
  [[0, 0.16, 0.56], [0.05, 0.08, 0.1], WOOD],
  [[0, 0.16, -0.56], [0.05, 0.08, 0.1], WOOD],
  [[0, 0.2 + 0.25 * draw, 0], [0.015, 0.015, 1.1 - 0.3 * draw], [0.85, 0.82, 0.72]], // string
];

// An archer's bow as it shoots, side-on: held out to its left in a fist raised straight out (roll pi/2), standing up
// along the fist's x, its limbs curving back towards it, more as it's drawn. Its string's ends (BOW_TIPS, from the
// fist) are drawn apart, to the drawing hand.
const sideBow = (draw) => [
  [[0, 0, 0], [0.16, 0.08, 0.07], LEATHER],           // grip
  [[0.3, 0.06 + 0.02 * draw, 0], [0.46, 0.06, 0.05], WOOD], // limbs
  [[-0.3, 0.06 + 0.02 * draw, 0], [0.46, 0.06, 0.05], WOOD],
  [[0.56, 0.16 + 0.06 * draw, 0], [0.1, 0.08, 0.05], WOOD],
  [[-0.56, 0.16 + 0.06 * draw, 0], [0.1, 0.08, 0.05], WOOD],
];
const BOW_TIP = (draw) => [0.61, 0.18 + 0.06 * draw, 0];
const STRING = [0.85, 0.82, 0.72];

// An archer's quiver, in the body's frame from the hips (tilted so its top leans back off the shoulders): the leather
// tube, its rim and the fletching of the arrows standing in it.
const QUIVER = [
  [[0.1, 0.42, -0.19], [0.15, 0.56, 0.15], LEATHER],
  [[0.1, 0.71, -0.19], [0.17, 0.04, 0.17], [0.26, 0.14, 0.06]],
  [[0.06, 0.78, -0.17], [0.03, 0.12, 0.07], [0.9, 0.9, 0.86]],
  [[0.13, 0.8, -0.21], [0.03, 0.12, 0.07], [0.9, 0.9, 0.86]],
  [[0.1, 0.76, -0.15], [0.03, 0.12, 0.07], [0.75, 0.2, 0.15]],
];

// A control group's banner (see groups.js), on a pole on its bearer's back: in the body's frame from the hips, the pole
// (from the small of its back to well over its head), the flag on it (cut to a point at the bottom) and a knob on top, and the group's number in a
// 3×5 pixel font on both faces of the flag (BANNER_TUNING, T > Banners).
// Carrying (a new game, see jobs.js CARRY_TUNING): a worker with a load holds it in both arms out in front of it,
// leaning back under its weight; what won't fit is left in a pile on the ground (Workers.piles).
export const CARRY_LOOK = {
  lean: 0.28,   // radians it leans back
  arm: 0.95,    // radians its arms are raised out in front (from hanging down)
  height: 1.06, // the load's bottom, up from its feet
  out: 0.44,    // and out in front of its middle
};
const PLANK_WOOD = [0.45, 0.27, 0.12], BRICK_STONE = [0.5, 0.46, 0.41], CLAY_RED = [0.55, 0.32, 0.19];
const ORE_IRON = [0.5, 0.48, 0.47], ORE_GOLD = [0.9, 0.66, 0.16], WHEAT_SHEAF = [0.86, 0.68, 0.3];
// n of `block` as boxes [centre, size, colour], from the middle of their bottom: planks across, in twos, layer on
// layer (crossed, `crossed`: a pile); bricks and clay in fours, two by two; ore chunks in threes; sheaves of wheat
// in twos.
function loadBoxes(block, n, crossed = false) {
  const out = [], WHEAT = 1;
  for (let i = 0; i < n; i++) {
    if (block === BLOCK.PLANK) {
      const l = Math.floor(i / 2), a = (i % 2 ? 1 : -1) * 0.085, turn = crossed && l % 2;
      out.push([turn ? [a, l * 0.07 + 0.035, 0] : [0, l * 0.07 + 0.035, a], turn ? [0.16, 0.065, 0.7] : [0.7, 0.065, 0.16], PLANK_WOOD]);
    } else if (block === BLOCK.BRICK || block === BLOCK.CLAY) {
      const l = Math.floor(i / 4), j = i % 4;
      out.push([[(j % 2 ? 1 : -1) * 0.135, l * 0.12 + 0.06, (j < 2 ? -1 : 1) * 0.08], [0.25, 0.115, 0.15], block === BLOCK.BRICK ? BRICK_STONE : CLAY_RED]);
    } else if (block === BLOCK.IRON || block === BLOCK.GOLD) {
      const l = Math.floor(i / 3), j = i % 3, r = 0.15 + 0.04 * ((i * 7) % 3) / 2, a = j * 2.1 + l * 1.1;
      out.push([[Math.cos(a) * 0.12, l * 0.13 + r / 2, Math.sin(a) * 0.08], [r, r * 0.85, r], block === BLOCK.GOLD ? ORE_GOLD : ORE_IRON]);
    } else if (block === WHEAT) {
      const l = Math.floor(i / 2);
      out.push([[0, l * 0.1 + 0.05, (i % 2 ? 1 : -1) * 0.06], [0.6, 0.09, 0.11], WHEAT_SHEAF]);
    }
  }
  return out;
}

export const BANNER_TUNING = {
  poleTop: 3.3,    // the pole's top, over the feet (voxels; the head's top is 2)
  back: 0.22,      // the pole this far behind the middle of the body (its back's at 0.17)
  flagWidth: 0.8,
  flagHeight: 1.05,
  flagDrop: 0.12,  // the flag's top this far under the pole's
  flagPoint: 0.4,  // its point under it (voxels; a triangle, as the hung banners', see banners.js)
  digitPixel: 0.15, // a pixel of the number
  bright: 2.2,     // the number: the team's colour this much brighter
};
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001',
  '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
const POLE_WOOD = [0.36, 0.22, 0.1], BANNER_KNOB = [0.85, 0.66, 0.2];

// A warrior's plume: its team's colour, a touch brighter than the toga.
const plumeOf = (team) => TEAMS[team].toga.map((c) => Math.min(1, c * 1.25 + 0.03));

// A spearman's spear, along +z from its middle (the head's at +z, SPEAR_TIP out): shaft, socket, a leaf-shaped blade
// and an iron butt.
const SPEAR = [
  [[0, 0, -0.05], [0.06, 0.06, 2.1], WOOD],
  [[0, 0, 1.04], [0.08, 0.08, 0.1], IRON],
  [[0, 0, 1.17], [0.14, 0.025, 0.18], EDGE],
  [[0, 0, 1.3], [0.07, 0.01, 0.1], EDGE],
  [[0, 0, -1.12], [0.075, 0.075, 0.06], IRON],
];
const SPEAR_TIP = 1.35;
// A spear as something held (in the arm's frame from the fist, standing up out of it) for when it's dropped.
const SPEAR_HELD = SPEAR.map(([c, s, col]) => [[c[0], c[2] + 0.3, c[1]], [s[0], s[2], s[1]], col]);
// A fire mage's staff, along +z from its grip, the orb (a colour of null, glowing) STAFF_ORB out, held in prongs.
const ORB = [1.6, 0.14, 0.04], DARK_WOOD = [0.24, 0.14, 0.07];
const STAFF = [
  [[0, 0, 0.3], [0.07, 0.07, 1.9], DARK_WOOD],
  [[0, 0, 1.27], [0.13, 0.13, 0.06], DARK_WOOD],
  [[0.09, 0, 1.38], [0.03, 0.03, 0.2], DARK_WOOD],
  [[-0.09, 0, 1.38], [0.03, 0.03, 0.2], DARK_WOOD],
  [[0, 0.09, 1.38], [0.03, 0.03, 0.2], DARK_WOOD],
  [[0, -0.09, 1.38], [0.03, 0.03, 0.2], DARK_WOOD],
  [[0, 0, 1.42], [0.18, 0.18, 0.18], null],
];
const STAFF_ORB = 1.42;
const STAFF_HELD = STAFF.map(([c, s, col]) => [[c[0], c[2], c[1]], [s[0], s[2], s[1]], col ?? ORB, col ? 0 : 0.8]);
// A barbarian's double-bladed axe, along +z from its grip like the mage's staff (posed by axePose): a long haft, and at
// its end the head with a broad bit each way across it (lying flat, out to either side, when it's held out level as
// it whirls), and a spike on top.
const BATTLEAXE = [
  [[0, 0, 0.3], [0.07, 0.07, 1.25], DARK_WOOD],     // haft
  [[0, 0, -0.02], [0.085, 0.085, 0.24], LEATHER],   // grip
  [[0, 0, 0.82], [0.16, 0.1, 0.15], IRON],          // head
  [[0.2, 0, 0.82], [0.24, 0.045, 0.22], IRON],      // bits
  [[-0.2, 0, 0.82], [0.24, 0.045, 0.22], IRON],
  [[0.33, 0, 0.82], [0.06, 0.03, 0.38], EDGE],      // their edges, flaring
  [[-0.33, 0, 0.82], [0.06, 0.03, 0.38], EDGE],
  [[0, 0, 0.97], [0.05, 0.05, 0.14], IRON],         // spike
];
// Where its blade sweeps as it whirls (axe level, straight out ahead of the right fist): voxels out from the spin's
// axis, and the way it's turned from straight ahead (radians, towards the right).
const AXE_SWEEP = { inner: 1.22, outer: 1.75, angle: Math.atan2(-0.37, 1.4) };
const BATTLEAXE_HELD = BATTLEAXE.map(([c, s, col]) => [[c[0], c[2], c[1]], [s[0], s[2], s[1]], col]);
// A barbarian's headband in its team's colour, in the head's frame from the neck, its knot's two tails down the back.
// It goes round its hair: e is its half-width (see bandOf).
const headbandOf = (team, e = 0.27) => [
  [[0, 0.44, 0], [2 * e, 0.09, 2 * e], TEAMS[team].toga],
  [[-0.08, 0.34, -e - 0.021], [0.07, 0.2, 0.05], TEAMS[team].toga.map((v) => v * 0.8)],
  [[0.08, 0.36, -e - 0.021], [0.07, 0.16, 0.05], TEAMS[team].toga.map((v) => v * 0.8)],
];
// A barbarian's harness, over its bare chest: leather straps from each shoulder down across to the other hip (into
// its belt), crossing in front, where an iron boss holds them, and behind, over its shoulders, iron studs along them in
// front. As [pivot x, pivot height, centre from it, size, colour, roll (about the body's z, as the arms')], from its
// feet; the straps at their crossing a little apart, so their faces never share a plane.
const HARNESS = [];
{
  const roll = 0.565, d = 0.03; // (from the shoulder at x 0.21, height 1.4, to the hip at 0.17, 0.8)
  for (const side of [-1, 1]) {
    const px = -0.02 * side, r = roll * side, k = side < 0 ? 0 : 0.007;
    HARNESS.push([px, 1.1, [0, 0, 0.175 + k], [0.08, 0.74, d], LEATHER, r]);   // in front
    HARNESS.push([px, 1.1, [0, 0, -0.175 - k], [0.08, 0.74, d], LEATHER, r]);  // behind
    for (const along of [-0.22, 0.2]) HARNESS.push([px, 1.1, [0, along, 0.19 + k + 0.01], [0.035, 0.035, 0.02], IRON, r]);
    HARNESS.push([0.21 * side, 1.42, [0, 0, 0], [0.09, 0.04, 0.41], LEATHER, 0]);  // over the shoulder
  }
  HARNESS.push([0, 1.07, [0, 0, 0.205], [0.13, 0.13, 0.03], IRON, 0]);            // the boss
  HARNESS.push([0, 1.07, [0, 0, 0.225], [0.06, 0.06, 0.02], STEEL, 0]);
}
// A priest's staff, along +z from its grip like the mage's, topped with a gold ankh (facing ahead when it's upright): a
// crossbar and a loop above it. Its loop (a colour of null) glows gold, brightly as its beam heals.
const ANKH_GOLD = [1.0, 0.72, 0.2], PALE_WOOD = [0.55, 0.38, 0.2];
const ANKH_STAFF = [
  [[0, 0, 0.3], [0.07, 0.07, 1.9], PALE_WOOD],
  [[0, 0, 1.27], [0.1, 0.1, 0.06], ANKH_GOLD],
  [[0, 0, 1.36], [0.36, 0.06, 0.06], ANKH_GOLD],
  [[0, 0, 1.42], [0.1, 0.06, 0.06], null],
  [[-0.08, 0, 1.53], [0.06, 0.06, 0.2], null],
  [[0.08, 0, 1.53], [0.06, 0.06, 0.2], null],
  [[0, 0, 1.64], [0.2, 0.08, 0.06], null],
];
const ANKH_HELD = ANKH_STAFF.map(([c, s, col]) => [[c[0], c[2], c[1]], [s[0], s[2], s[1]], col ?? ANKH_GOLD, col ? 0 : 0.4]);
// Boxes are [centre, size, colour], and optionally a glow (0-1, how much it's its own colour) and a form: { tilt (radians
// it's turned about x, about its own centre), shape ('cone': a faceted cone filling the box, apex up) }.
const CONE = { shape: 'cone' };
// A wizard's hat, in the head's frame from the neck (the face is +z), in its team's colour (null): a wide brim, a gold
// band and a square pyramid leaning back (its back upright, see units-render.js).
const GOLD = [0.85, 0.62, 0.15];
const HAT = [
  [[0, 0.5, 0], [0.84, 0.04, 0.84], null],
  [[0, 0.56, 0], [0.54, 0.07, 0.54], GOLD],
  [[0, 0.89, 0], [0.52, 0.62, 0.52], null, 0, { shape: 'pyramid' }],
];
// A spearman's winged helmet, in the head's frame from the neck: a steel dome with a faceted crown, a rim and a nose
// guard, and on each side a wing of three white feathers fanning back.
const FEATHER = [0.94, 0.93, 0.88], FEATHER_SHADE = [0.78, 0.78, 0.76];
const VALKYRIE = [
  [[0, 0.5, 0], [0.56, 0.16, 0.58], STEEL],
  [[0, 0.68, 0], [0.6, 0.2, 0.6], STEEL, 0, CONE],
  [[0, 0.42, 0], [0.6, 0.05, 0.62], IRON],
  [[0, 0.33, 0.28], [0.06, 0.2, 0.04], IRON],
];
for (const side of [-1, 1]) {
  VALKYRIE.push([[side * 0.3, 0.5, -0.03], [0.05, 0.12, 0.14], IRON]); // where the wing's fixed on
  [[0.48, -0.2, FEATHER], [0.42, -0.65, FEATHER_SHADE], [0.34, -1.1, FEATHER]].forEach(([len, tilt, col], i) => {
    const c = [side * (0.32 + i * 0.006), 0.5 + Math.cos(tilt) * len / 2, -0.03 + Math.sin(tilt) * len / 2];
    VALKYRIE.push([c, [0.03, len, 0.12], col, 0, { tilt }]);
  });
}
// A priest's monk hood, in the head's frame from the neck, in its team's colour (null) a shade darker: a crown, the back
// and sides falling to the shoulders round the face, a shadowed lip over the brow and a point at the back.
const HOOD = [
  [[0, 0.58, -0.02], [0.62, 0.1, 0.6], null],
  [[0, 0.235, -0.3], [0.6, 0.63, 0.08], null],
  [[0.3, 0.24, -0.01], [0.08, 0.66, 0.56], null],
  [[-0.3, 0.24, -0.01], [0.08, 0.66, 0.56], null],
  [[0, 0.52, 0.27], [0.6, 0.07, 0.05], 'shade'],
  [[0, 0.68, -0.22], [0.3, 0.22, 0.24], null, 0, { shape: 'pyramid' }],
];
const hoodOf = (team) => HOOD.map(([c, s, col, glow, form]) => [c, s, col === 'shade' ? TEAMS[team].toga.map((v) => v * 0.45) : col ?? TEAMS[team].toga.map((v) => v * 0.8), glow, form]);
const hatOf = (team) => HAT.map(([c, s, col, glow, form]) => [c, s, col ?? TEAMS[team].toga.map((v) => v * 0.8), glow, form]);
const BLAST_TIME = 0.6; // seconds a fireball's burst lights the ground round it

// Poses through a cycle (s, 0-1) from keys [[s, pose, how]] in order, number by number (and directions, as arrays,
// turning from one to the other): between two keys it eases in and out, or (how, the later key's) 'in' speeding up,
// 'out' slowing down or 'lin' steadily.
const lerp = (a, b, k) => a + (b - a) * k, ease = (k) => k * k * (3 - 2 * k);
const nlerp = (a, b, k) => { const v = a.map((x, i) => lerp(x, b[i], k)), l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
function keyed(keys, s) {
  let i = 1;
  while (i < keys.length - 1 && s > keys[i][0]) i++;
  const [s0, a] = keys[i - 1], [s1, b, how] = keys[i];
  let k = Math.max(0, Math.min(1, (s - s0) / Math.max(1e-6, s1 - s0)));
  k = how === 'in' ? k * k : how === 'out' ? 1 - (1 - k) * (1 - k) : how === 'lin' ? k : ease(k);
  const o = { ...a };
  for (const key in b) {
    const x = a[key] ?? b[key], y = b[key];
    o[key] = Array.isArray(y) ? nlerp(x, y, k) : typeof y === 'number' ? lerp(x, y, k) : k < 1 ? x : y;
  }
  return o;
}

// How a spearman's right arm and spear (or a mage's staff) are posed: the arm's swing and roll, the spear or staff's
// own tilt about x (-pi/2 standing up, 0 pointing ahead) and how far along it the fist grips it, whether it's in hand
// and how brightly the staff's orb glows; and the rest of it: its left arm's swing and roll (left, leftRoll, taking
// over from its own by leftW), its upper body's lean (forward) and its legs' split (lunge, its left foot forward). s is
// how far through its cycle it is (null while it's not fighting), walk where it is in its stride (-1 to 1, 0 standing)
// and moving how much it's walking. A spearman raises its spear overhead beside its head, its left arm pointing at its
// target, draws it back leaning away, and throws (LOOSE) stepping into it, its arm following through across its body as
// its left arm pulls back; then it reaches back over its shoulder for another. A mage raises its staff to point at its
// target, leaning back and floating a little, its left hand reaching for the orb (reach) and circling it as it gathers
// fire, then thrusts it forward, stepping in, as it casts, the staff kicking up after, and lowers it. Walking, a mage's
// staff (and a priest's) is a walking stick, planted ahead every other step.
const STILL = { roll: 0, left: 0, leftRoll: 0, leftW: 0, lean: 0, lunge: 0, reach: 0, float: 0 };
const stick = (walk, moving) => ({ arm: -0.15 - 0.25 * walk, ang: -1.5 - 0.25 * walk, slide: -0.12 * moving });
function handPose(kind, s, walk = 0, moving = 0) {
  if (kind === 'spearman') {
    const rest = { ...STILL, arm: -0.1 - 0.18 * walk, ang: -1.45, slide: 0.3 };
    if (s === null || s >= 0.9) return { ...rest, held: true };
    const up = { ...STILL, arm: -3.2, roll: 0.25, ang: -0.12, slide: 0.2, left: -1.45, leftRoll: -0.1, leftW: 1, lean: -0.06, lunge: 0.35 };
    const draw = { ...up, arm: -3.8, roll: 0.3, ang: -0.32, slide: -0.05, left: -1.6, leftRoll: -0.15, lean: -0.16, lunge: 0.4 };
    const thrown = { ...draw, arm: -1.2, roll: 0.35, left: 0.5, leftRoll: 0.25, lean: 0.2, lunge: 1 };
    const follow = { ...thrown, arm: -0.55, roll: 0.45, left: 0.35, leftRoll: 0.1, lean: 0.12, lunge: 0.8 };
    const reach = { ...STILL, arm: -2.7, roll: 0.15, ang: -1.8, slide: 0.15, lunge: 0.3 };
    const pose = keyed([[0, rest], [0.25, up], [0.35, { ...up, left: -1.5 }], [0.45, draw], [0.53, thrown, 'in'], [0.62, follow],
      [0.74, reach], [0.9, rest]], s);
    return { ...pose, held: s < LOOSE.spearman || s >= 0.74 };
  }
  const rest = { ...STILL, ...stick(walk, moving), glow: 0.35 };
  if (s === null) return { ...rest, held: true };
  const raised = { ...rest, arm: -1.75, ang: -0.25, slide: 0, glow: 0.6, lean: -0.1, lunge: 0.2, reach: 1, float: 1 };
  const charged = { ...raised, arm: -1.9, ang: -0.32, glow: 1, lean: -0.15 };
  const cast = { ...charged, arm: -1.55, ang: -0.12, lean: 0.18, lunge: 1, reach: 0.4, float: 0 };
  const kick = { ...cast, arm: -2.1, ang: -0.7, glow: 0.2, lean: -0.04, lunge: 0.6, reach: 0 };
  return { ...keyed([[0, rest], [0.4, raised], [0.6, charged, 'lin'], [0.7, cast, 'in'], [0.78, kick, 'out'], [1, rest]], s), held: true };
}

// A priest's staff and arms (as handPose's; nod: its head's nod, rise: how far up it lifts): as its beam heals
// (u.channel, 0-1 easing in and out) it holds its staff up ahead, the ankh towards the one it's healing, its other hand
// raised out to them, looking up a little.
function priestPose(u, walk, moving) {
  const rest = { ...STILL, ...stick(walk, moving), glow: 0.15, nod: 0, rise: 0, held: true };
  const raised = { ...rest, arm: -2.1, roll: 0.1, ang: -1.2, slide: -0.05, glow: 1, left: -1.9, leftRoll: -0.35, leftW: 1,
    lean: -0.06, nod: -0.15, rise: 0.02, lunge: 0.3 };
  return keyed([[0, rest], [1, raised]], ease(u.channel ?? 0));
}

// How a barbarian holds its axe (the right arm's swing and roll and the axe's own tilt, and the rest of it, as
// handPose's, with twist, its upper body's turn to its left; side, its tilt to its left; splay, how far its legs are
// out; look, its head's turn, or null; ready, how much it holds its axe up ahead in both hands): on its shoulder, or
// raised ahead in both hands while it's after an enemy (u.ready); coiled before it whirls, the axe drawn back out to its
// right and its body turned that way, crouching; then whirling, the axe straight out ahead and level, dipping and rising
// once a turn, its left arm out for balance, leaning out against the spin with its legs apart, its head spotting like a
// dancer's (held one way as it turns, then snapped round ahead, see whirl).
const COIL = aimArm([-0.85, -0.15, 0.5]), COIL_LEFT = aimArm([-0.55, -0.35, 0.75]), WHIRL_LEFT = aimArm([0.85, -0.05, 0.5]);
function axePose(u, walk) {
  const w = ease(u.whirl), coil = u.whirling && u.whirl < 1 ? Math.sin(Math.PI * u.whirl) : 0;
  const wob = Math.sin(u.yaw) * w, lw = w / Math.max(1e-6, w + coil);
  let arm = -0.95 - 0.08 * walk, roll = 0, ang = -2.65;
  arm = lerp(arm, COIL.arm, coil); roll = lerp(roll, COIL.roll, coil); ang = lerp(ang, 0.9, coil);
  arm = lerp(arm, -Math.PI / 2 + 0.1 * wob, w); roll = lerp(roll, 0, w); ang = lerp(ang, 0.12 * wob, w);
  return {
    arm, roll, ang, left: lerp(COIL_LEFT.arm, WHIRL_LEFT.arm, lw), leftRoll: lerp(COIL_LEFT.roll, WHIRL_LEFT.roll, lw), leftW: Math.max(coil, w),
    twist: -0.5 * coil, lean: 0.15 * coil - 0.05 * w, side: ANIM_TUNING.whirlLean * w, lunge: 0.5 * coil, splay: 0.15 * w,
    look: u.whirl > 0 && u.spot !== undefined ? wrapAngle(u.spot - u.yaw) * w : null,
    ready: (u.ready ?? 0) * (1 - w) * (1 - coil),
  };
}

// An archer shooting (s: how far through its shot, 0-1, loosing at 1; rel: how fresh its last loose is, 1 just loosed
// - 0): its drawing hand reaches back over its shoulder to its quiver, brings an arrow to the string, draws it back to
// its chin, fast and then slowing as the bow stiffens, and holds it there; loosed, the hand flies up and back off the
// string and the bow arm dips. dir: the drawing arm's way from its shoulder (in the body's frame); draw: how far the
// string's drawn (0-1); nocked, inHand: whether an arrow's on the string, or in its hand; drop: the bow arm's dip.
const DRAW_FROM = [1, 0.03, 0.12], DRAW_TO = [0.88, 0.33, 0.36], QUIVER_REACH = [0.3, 0.75, -0.55], LOOSED = [0.62, 0.5, 0.6];
function archerPose(s, rel) {
  const dir = keyed([[0, { d: DRAW_FROM }], [0.3, { d: QUIVER_REACH }], [0.46, { d: DRAW_FROM }], [0.85, { d: DRAW_TO }, 'out'],
    [1, { d: DRAW_TO }]], s).d;
  const draw = s < 0.46 ? 0 : s < 0.85 ? 1 - (1 - (s - 0.46) / 0.39) ** 2 : 1;
  return { dir: nlerp(dir, LOOSED, rel), draw, nocked: s >= 0.46, inHand: s >= 0.3 && s < 0.46, drop: 0.18 * rel };
}

// A worker at its task, by its tool (s: how far through the voxel it's on, 0-1: the voxel changes at 1, where each
// blow lands and each cycle starts; e: how far up its target is from its shoulders, radians; flip: a backhand this
// time). Two-handed, a pickaxe is swung up, cocked back over its head and brought down hard, and an axe chopped
// diagonally, forehand and backhand by turns, its body tilted to the swing; a shovel's pushed in, levered, lifted and
// its earth tossed aside (filling, scooped from its side and thrown on). One-handed, a hammer's tapped twice from the
// wrist, the second harder, its other hand steadying the work, and a torch is reached down and set. Two-handed (two),
// its hands are together at phi round the line of its shoulders (0 ahead at their height, pi/2 straight up), the
// handle pointing `tool` the same way (see twoHands); one-handed, arm, roll and wrist are as warriorPose's. Each has its
// body's twist, lean (forward) and side (tilt to its left), its legs' lunge (its left foot forward) and its head's nod,
// and one-handed, its left arm's swing and roll, by leftW.
function workPose(tool, fill, s, e, flip) {
  const down = Math.max(0, -e), still = { twist: 0, lean: 0.05, side: 0, lunge: 0.3, nod: 0.1, leftW: 0, left: 0, leftRoll: 0 };
  if (tool === 'pickaxe' || tool === 'axe' || tool === 'hoe') {
    const axe = tool === 'axe', sg = axe && flip ? -1 : 1, phi = (axe ? -0.3 : -0.55) + 0.45 * e;
    const hit = { ...still, two: true, phi, tool: phi - 0.1, twist: (axe ? 0.3 : 0.05) * sg, lean: 0.15 + 0.2 * down,
      side: axe ? -0.3 * sg : 0, lunge: 0.6, nod: 0.25 + 0.15 * down };
    const rec = { ...hit, phi: phi + 0.2, tool: phi + 0.35, lean: hit.lean - 0.04 };
    const up = { ...hit, phi: 0.6, tool: 2.1, twist: (axe ? -0.4 : -0.1) * sg, lean: -0.1, nod: -0.15 };
    const top = { ...up, phi: 0.7, tool: 2.45, lean: -0.12 };
    return keyed([[0, hit], [0.12, rec], [0.55, up], [0.7, top], [1, hit, 'in']], s);
  }
  if (tool === 'hammer' || tool === 'sickle') {
    const k = s < 0.5 ? s * 2 : s * 2 - 1, big = s < 0.5 ? 0 : 1, arm = -1.05 - 0.45 * e;
    const hit = { ...still, two: false, arm, roll: 0.1, wrist: 0.45, twist: 0.05, lean: 0.18 + 0.2 * down, lunge: 0.5, nod: 0.25,
      leftW: 1, left: -1.2 - 0.45 * e, leftRoll: -0.25 };
    const up = { ...hit, arm: arm - 0.25 - 0.45 * big, wrist: -0.95, twist: -0.06 - 0.1 * big, lean: hit.lean - 0.04 };
    return keyed([[0, hit], [0.55, up], [1, hit, 'in']], k);
  }
  if (tool === 'shovel' && !fill) {
    const push = { ...still, two: true, phi: -0.95 + 0.25 * e, tool: -1.0 + 0.3 * e, twist: 0.1, lean: 0.3 + 0.1 * down, lunge: 0.7, nod: 0.3 };
    const lever = { ...push, phi: push.phi + 0.15, tool: push.tool + 0.4, lean: 0.22 };
    const lift = { ...lever, phi: -0.35, tool: -0.15, twist: -0.1, lean: 0.1, nod: 0.1 };
    const toss = { ...lift, phi: 0.15, tool: 0.5, twist: -0.5, side: -0.1, lean: 0, nod: 0 };
    return keyed([[0, toss], [0.35, push], [0.55, lever], [0.78, lift], [1, toss, 'in']], s);
  }
  if (tool === 'shovel') {
    const toss = { ...still, two: true, phi: -0.1 + 0.3 * e, tool: 0.3 * e, twist: 0.15, lean: 0.15, lunge: 0.6, nod: 0.15 };
    const scoop = { ...toss, phi: -1.0, tool: -1.0, twist: -0.5, side: -0.1, lean: 0.3, nod: 0.25 };
    const load = { ...scoop, phi: -0.7, tool: -0.4, twist: -0.4, lean: 0.2 };
    return keyed([[0, toss], [0.4, scoop], [0.6, load], [1, toss, 'in']], s);
  }
  const rest = { ...still, two: false, arm: -0.2, roll: 0, wrist: 0 };
  const place = { ...rest, arm: -0.6 - 0.4 * e, roll: 0.1, wrist: 0.3, lean: 0.3 + 0.2 * down, nod: 0.3 };
  return keyed([[0, rest], [0.6, place], [0.85, place], [1, rest]], s);
}

// A warrior's slash (s: how far through its swing, 0-1, or null closing in), diagonally across its target: a forehand
// from up over its right shoulder down to its left, or (every other swing) a backhand from up over its left shoulder
// down to its right. It winds up turning its sword shoulder back (or across), its wrist cocked so the blade lies back,
// then whips through, uncocking, its body turning into it and stepping forward, then recovers to its guard, sword
// pointing ahead. arm, roll: the sword arm's swing and roll (as p's); wrist: the sword's tilt from the arm's line;
// twist: the upper body's turn (to its left); lunge: how far into its step (0-1); left, leftRoll: the other arm.
const SLASH_HIT = 0.7; // when in its swing the blow lands: as the blade passes ahead of it
function warriorPose(s, backhand) {
  const tw = COMBAT_TUNING.twist, side = backhand ? -1 : 1;
  const guard = { arm: -0.7, roll: 0.15, wrist: -0.6, twist: 0, lunge: 0 };
  const up = backhand ? { arm: -2.5, roll: -0.7, wrist: -1.1, twist: tw, lunge: 0 } : { arm: -3.3, roll: 0.55, wrist: -1.2, twist: -tw, lunge: 0 };
  const down = { arm: -0.25, roll: up.roll, wrist: 0.15, twist: tw * side, lunge: 1 };
  const mix = (a, b, k) => Object.fromEntries(Object.keys(a).map((key) => [key, lerp(a[key], b[key], k)]));
  const pose = s === null ? guard : s < 0.5 ? mix(guard, up, ease(s / 0.5))
    : s < 0.78 ? mix(up, down, ((s - 0.5) / 0.28) ** 2) // speeding up through the cut
    : mix(down, guard, ease((s - 0.78) / 0.22));
  return { ...pose, left: -0.35 + pose.twist / Math.max(tw, 1e-3) * 0.6, leftRoll: 0.3 };
}

// A spearman's upper body's turn through its throw (s as handPose's): its throwing shoulder drawn back as it winds up,
// then whipped round as it lets fly.
function throwTwist(s) {
  const tw = -COMBAT_TUNING.twist * 1.1, after = COMBAT_TUNING.twist * 0.8;
  if (s === null || s >= 0.8) return 0;
  if (s < 0.45) return tw * ease(Math.min(1, s / 0.3));
  if (s < 0.55) return lerp(tw, after, ease((s - 0.45) / 0.1));
  return lerp(after, 0, ease((s - 0.55) / 0.25));
}

// Where shots at o are aimed from (a unit's feet; a rider's saddle; a power crystal's lower tip, drawn up over its
// Keep's roof, not its feet on the plinth inside), and the height of its middle (where a blast's measured from).
const aimBase = (o) => o.pos[1] + (o.kind === 'crystal' ? (o.raise ?? 0) + CRYSTAL_TUNING.hover : mountLift(o));
const middleY = (o) => (o.kind === 'crystal' ? aimBase(o) + CRYSTAL_TUNING.length * CRYSTAL_TUNING.waist : o.kind === 'wall' ? o.pos[1] + o.wall.h / 2 : o.pos[1] + 1);

// The share of its full hit points a fireball that burst at p takes from o: fireDamage per cent within fireFull voxels,
// falling off linearly to fireEdge per cent at the blast's edge (fireBlast + 0.5, see explode).
function fireShare(o, p) {
  const C = COMBAT_TUNING, d = Math.hypot(o.pos[0] - p[0], middleY(o) - p[1], o.pos[2] - p[2]);
  const k = Math.max(0, Math.min(1, (d - C.fireFull) / Math.max(1e-3, C.fireBlast + 0.5 - C.fireFull)));
  return lerp(C.fireDamage, C.fireEdge, k) / 100;
}

// Hair, so villagers on the same team can still be told apart: hairstyles, in the head's frame from the neck (before
// HEAD_LIFT, the face +z; the head's x and z within 0.25, y 0.04-0.54). Each is a shell round the head: a cap over the
// top, a back and sides (down to back, side), a fringe over the brow (down to fringe, fw either side of the middle),
// t thick (tf at the front), and extras: boxes [[x0, x1], [y0, y1], [z0, z1], layer, shade]. Layers say what shows under
// headgear (see hairParts): 'top' (the cap, tufts and a bun) only bare-headed or under a headband; 'fall' (back, sides
// and fringe) cut off at the brim of a hat or winged helmet; 'tail' (below the head at the back, its top inside a
// helmet's neck guard) under any helmet or hat. Under a monk's hood none shows.
const HAIRSTYLES = [
  { name: 'buzz', t: 0.012, tf: 0.012, cap: 0.56, back: 0.32, side: 0.38, front: 0 },
  { name: 'crop', t: 0.02, tf: 0.02, cap: 0.59, back: 0.3, side: 0.36, front: 0.04, fringe: 0.47, fw: 0.2 },
  { name: 'spiky', t: 0.02, tf: 0.02, cap: 0.6, back: 0.3, side: 0.36, front: 0.04, fringe: 0.47, fw: 0.22, extra: [
    [[-0.19, -0.07], [0.6, 0.72], [-0.12, 0]], [[0.03, 0.15], [0.6, 0.75], [-0.06, 0.06]], [[-0.07, 0.05], [0.6, 0.7], [0.1, 0.23]],
    [[0.1, 0.22], [0.6, 0.68], [-0.22, -0.1]], [[-0.23, -0.12], [0.6, 0.67], [0.09, 0.21]], [[-0.04, 0.08], [0.6, 0.71], [-0.25, -0.13]],
    [[0.12, 0.23], [0.6, 0.69], [0.1, 0.22]],
  ].map(([x, y, z]) => [x, y, z, 'top']) },
  { name: 'mop', t: 0.032, tf: 0.03, cap: 0.62, back: 0.18, side: 0.22, front: 0.18, fringe: 0.42, fw: 0.24 },
  { name: 'ponytail', t: 0.022, tf: 0.022, cap: 0.59, back: 0.26, side: 0.36, front: 0.02, fringe: 0.46, fw: 0.22, extra: [
    [[-0.07, 0.07], [0.29, 0.385], [-0.318, -0.26], 'tail', 0.6], // its tie
    [[-0.055, 0.055], [-0.22, 0.34], [-0.308, -0.252], 'tail'],   // and tail, hanging down the back
  ] },
  { name: 'bun', t: 0.022, tf: 0.022, cap: 0.58, back: 0.3, side: 0.38, front: 0.06, fringe: 0.47, fw: 0.18, extra: [
    [[-0.1, 0.1], [0.36, 0.56], [-0.392, -0.252], 'top'],
    [[-0.125, 0.125], [0.35, 0.57], [-0.32, -0.29], 'top', 0.6], // tied round
  ] },
  { name: 'braid', t: 0.025, tf: 0.025, cap: 0.6, back: 0.2, side: 0.3, front: 0.1, fringe: 0.45, fw: 0.24, extra: [
    [[-0.065, 0.065], [0.12, 0.26], [-0.315, -0.255], 'tail'], [[-0.05, 0.05], [0, 0.13], [-0.305, -0.265], 'tail'],
    [[-0.065, 0.065], [-0.13, 0.01], [-0.315, -0.255], 'tail'], [[-0.05, 0.05], [-0.24, -0.12], [-0.305, -0.265], 'tail'],
    [[-0.06, 0.06], [-0.29, -0.22], [-0.316, -0.254], 'tail', 0.6], // tied at the end
  ] },
  { name: 'long', t: 0.032, tf: 0.025, cap: 0.6, back: -0.02, side: 0.02, front: 0.12, fringe: 0.44, fw: 0.16 },
];
// What of hairstyle h shows under `gear` ('bare', 'band' a headband, 'hat', 'valkyrie' a winged helmet, 'helmet' or
// 'hood'), as boxes [centre, size, shade] in the head's frame from the neck. The fall's cut off at `clear`: inside a
// hat's brim, or a winged helmet's rim (which leaves the back of the head bare). A back long enough to hang below the
// head goes on below 0.2 as a tail, a touch narrower, its top inside a helmet's neck guard (no lower than the top of
// the body, -0.02, so that it clears the shoulders as the head turns). It's all cut off at `floor` (above what an
// archer or a barbarian carries behind its neck, see HAIR_FLOOR).
const HAIR_SHOWS = { bare: ['top', 'fall', 'tail'], band: ['top', 'fall', 'tail'], hat: ['fall', 'tail'], valkyrie: ['fall', 'tail'], helmet: ['tail'], hood: [] };
const HAIR_CLEAR = { hat: 0.5, valkyrie: 0.415 };
const HAIR_FLOOR = { archer: 0.15, barbarian: 0.12 }; // above the quiver's top, the resting axe's head
const hairCache = new Map();
function hairParts(h, gear, floor = -Infinity) {
  const key = `${h},${gear},${floor}`;
  if (hairCache.has(key)) return hairCache.get(key);
  const S = HAIRSTYLES[h], O = 0.25 + S.t, F = 0.25 + S.tf, boxes = [];
  boxes.push([[-O, O], [0.5, S.cap], [-O, F], 'top']);
  if (S.back < 0.2) {
    boxes.push([[-O, O], [0.2, 0.5], [-O, -0.236], 'fall']);
    boxes.push([[-0.262, 0.262], [S.back, 0.2], [-(O - 0.005), -0.236], 'tail']);
  } else boxes.push([[-O, O], [S.back, 0.5], [-O, -0.236], 'fall']);
  boxes.push([[0.18, O], [S.side, 0.5], [-0.236, S.front], 'fall'], [[-O, -0.18], [S.side, 0.5], [-0.236, S.front], 'fall']);
  if (S.fringe) boxes.push([[-S.fw, S.fw], [S.fringe, 0.5], [0.24, F], 'fall']);
  boxes.push(...(S.extra ?? []));
  const shows = HAIR_SHOWS[gear], clear = HAIR_CLEAR[gear] ?? Infinity, out = [];
  for (const [x, y, z, layer, shade = 1] of boxes) {
    if (!shows.includes(layer)) continue;
    const y0 = Math.max(y[0], floor), y1 = layer === 'fall' ? Math.min(y[1], clear) : y[1];
    if (y1 <= y0 + 0.01) continue;
    out.push([[(x[0] + x[1]) / 2, (y0 + y1) / 2, (z[0] + z[1]) / 2], [x[1] - x[0], y1 - y0, z[1] - z[0]], shade]);
  }
  hairCache.set(key, out);
  return out;
}
// The half-width of a headband that goes round hairstyle h's hair.
const bandOf = (h) => Math.max(0.27, 0.262 + Math.max(HAIRSTYLES[h].t, HAIRSTYLES[h].tf));
// Its look, from its id: a hairstyle, hair colour and skin tone each (spread out so neighbours differ).
// Blond, dark blond and auburn hair (FAIR_HAIR) only go with fair or light skin (tones 0-1); the rest go with any.
const FAIR_HAIR = [2, 3, 4], ANY_HAIR = [0, 1, 5, 6];
function looksOf(id) {
  const k = Math.imul(id, 2654435761) >>> 0, skin = (k >>> 15) % SKIN_TONES;
  const hairColour = skin < 2 ? (k >>> 7) % HAIR_COLOURS : ANY_HAIR[(k >>> 7) % ANY_HAIR.length];
  return { hairStyle: k % HAIRSTYLES.length, hairColour, skin, bodyB: ((k >>> 21) & 1) === 1 };
}
// Its hair colour for skin tone `skin` (when T > Looks gives everyone a darker one, fair-only hair changes to another).
const hairFor = (u, skin) => {
  const h = lookPick('hair', u.hairColour ?? 0, HAIR_COLOURS);
  return LOOK_TUNING.hairColour < 0 && skin >= 2 && FAIR_HAIR.includes(h) ? ANY_HAIR[(h + u.id) % ANY_HAIR.length] : h;
};
// A look's colour from LOOK_TUNING (`which` 'skin' or 'hair'), the tuning's choice for everyone if it's made one.
const lookPick = (which, own, n) => {
  const all = LOOK_TUNING[which === 'skin' ? 'skinTone' : 'hairColour'];
  return all >= 0 ? Math.min(n - 1, Math.round(all)) : own;
};
const lookColours = new Map(); // (by hex, so they're worked out once each)
const lookColour = (which, i) => {
  const hex = LOOK_TUNING[`${which}${i}`];
  if (!lookColours.has(hex)) lookColours.set(hex, linearColor(hex));
  return lookColours.get(hex);
};
export const HAIRSTYLE_COUNT = HAIRSTYLES.length;

export class Units {
  constructor(terrain) {
    this.terrain = terrain;
    this.list = [];
    this.nextId = 1;
    this.possessed = null; // the unit the camera's in (see parts)
    this.hideBody = false;
    this.controls = null; // the team the player gives orders to (a new game), or null for any (see commandable)
    this.workers = new Workers(this); // flatten jobs
    this.ladders = new Ladders(terrain); // what workers climb (see ladders.js)
    this.onEdit = null; // (lo, hi) => void, called after a villager digs or fills a voxel
    this.arrows = [];   // in flight (arrows, spears and fireballs, see loose): { what, from, by, target, aim, t, time, to (a
                        // miss: where it lands) }
    this.stuck = [];    // landed in the ground: { pos: where its tip went in, dir: the way it was going, age, spear }
    this.blasts = [];   // fireballs bursting, for their flash of light: { pos, age }
    this.time = 0;      // seconds of updates (for when each stopped, see yields)
    this.attackers = new Map(); // how many are after each villager, as of the start of this update (see targetCost)
    this.fireballs = []; // where the fireballs in flight are, as of the last parts()
    this.sweeps = [];   // whirling barbarians' axes, as of the last parts(), for their trails (see trails.js)
    this.onBlast = null; // (pos, radius) => void, called when a fireball bursts (for its fire and smoke)
    this.hiddenAt = null; // (x, z) => bool: the player can't see there (fog of war): no arrows, fireballs or blasts drawn
                          // there; each villager's u.hidden is set by main, and a hidden one isn't drawn or picked
  }

  // Where to draw a unit's feet: its own (eased) height.
  drawHeight(u) { return u.pos[1]; }

  // Can a unit stand with its feet in cell (x, y, z)? Not under the water: villagers keep to dry land. Nor on top of
  // the obsidian wall round the map.
  standable(x, y, z) {
    const t = this.terrain;
    if (x < 0 || z < 0 || x >= X || z >= Z || y < Math.max(1, WATER_LEVEL) || y >= Y) return false;
    return t.solid(x, y - 1, z) && t.block(x, y - 1, z) !== BLOCK.OBSIDIAN && !t.solid(x, y, z) && !t.solid(x, y + 1, z);
  }

  // Whether u climbs ladders (only workers do; see ladders.js).
  climbs(u) { return !!this.ladders && u.kind === 'worker'; }
  // Whether a climber's feet can be in (x, y, z) on a ladder: a rung there, with room for its head above.
  onLadder(x, y, z) { return !!this.ladders?.has(x, y, z) && !this.terrain.solid(x, y + 1, z); }
  // Where a climber can have its feet: standing, or on a ladder.
  footing(x, y, z, climb) { return this.standable(x, y, z) || (climb && this.onLadder(x, y, z)); }

  // The standable cell in column (x, z) nearest height y (within `reach`), or -1.
  standHeight(x, z, y, reach = 4) {
    for (let d = 0; d <= reach; d++) {
      if (this.standable(x, y - d, z)) return y - d;
      if (d && this.standable(x, y + d, z)) return y + d;
    }
    return -1;
  }

  // On the ground in column (x, z) (not up a tree), or onto the highest standable cell at or below y if one's given.
  spawn(x, z, y = this.terrain.groundAt(x, z), team = 'blue', kind = 'worker') {
    x = Math.floor(x);
    z = Math.floor(z);
    let h = -1;
    for (let yy = Math.min(y, Y - 2); yy >= 1; yy--) if (this.standable(x, yy, z)) { h = yy; break; }
    if (h < 0) return null;
    const id = this.nextId++;
    const u = {
      id,
      pos: [x + 0.5, h, z + 0.5],
      yaw: Math.random() * Math.PI * 2,
      cell: [x, h, z],
      path: [],
      goal: null,
      queue: [],        // waypoints queued after goal (Shift): { cell, amove }
      patrol: null,     // { points: [cell], i, d }: attack-moving to points[i], then on by d, turning at either end
      amove: false,     // attack-move: walking to goal, but fighting enemies it meets on the way
      selected: false,
      walk: 0,          // walk cycle phase
      moving: 0,        // 0..1, eases the walk animation in and out
      idle: Math.random() * 10,
      repath: 0,
      task: null,       // the voxel it's on its way to dig or fill (with its flatten job)
      working: 0,       // seconds spent on the current voxel
      team,
      kind,             // its class, one of CLASSES (see COMBAT_TUNING)
      role: MOUNTS[kind] ?? kind, // the class it fights, poses and dresses as (a knight a warrior, a scout an archer)
      ...looksOf(id),   // hairStyle, hairColour and skin (see LOOK_TUNING)
      hp: COMBAT_TUNING[`${kind}Hp`] ?? 10,
      maxHp: COMBAT_TUNING[`${kind}Hp`] ?? 10,
      healing: null,    // a priest: who it's healing (or going to)
      beaming: false,   // a priest: its beam's on them
      beamTo: null,     // a priest: who its beam was last on (it fades out there)
      beamWait: 0,      // a priest: seconds till its beam can start again, after it turned to another
      healTicked: 0,    // a priest: seconds its beam's been on towards its next heal
      channel: 0,       // a priest: how much it's channelling its beam (0-1, easing in and out; see priestPose)
      whirl: 0,         // a barbarian: how far into its whirl (0-1, easing in and out)
      whirling: false,  // a barbarian: an enemy's within whirlRange, so it's whirling
      whirlTick: 0,     // a barbarian: seconds till its axe's next hit
      restSince: null,  // when it last stopped (Units.time), null while it's moving
      shuffle: 0,       // seconds till it next checks whether it's on another's square
      stepping: false,  // stepping off another's square (see stepAside)
      arrows: [],       // stuck in it: { pos, dir } in its own frame (from its feet, facing +z), age (spear: pos its middle)
      target: null,     // the villager it's fighting
      swing: 0,         // seconds into its current sword swing
      backhand: false,  // its next slash is a backhand (a warrior's alternate, see warriorPose)
      striking: false,  // within range of its target, swinging
      chase: 0,         // seconds until it looks for a new path to its target
      hurt: 0,          // seconds left of the flash from a blow
      blink: EYE_TUNING.blinkMin + Math.random() * (EYE_TUNING.blinkMax - EYE_TUNING.blinkMin), // seconds till it next blinks
      blinking: null,   // seconds into a blink (null when it isn't)
      wincing: 0,       // seconds left of a wince, from a blow
      frozen: 0,        // seconds left of its hit-freeze
      knock: null,      // knocked back by a blow: { dir: [x, z] (voxels in all), t: seconds into it }
      flinch: null,     // flinching from a blow: { dir: [x, z] the way it was knocked, t: seconds into it, k: how hard }
      pose: null,       // its limbs' swings and rolls as last drawn, for its ragdoll to start from (see posture)
      workW: 0,         // a worker: how much it's at its work (0-1, easing in and out, see workPose)
      workPose: null,   // and its pose there, as of the last frame it worked
      workS: 0,         // how far through the voxel it's on it was then
      workFlip: false,  // its next chop's a backhand
      workFrom: null,   // its pose at the end of the last voxel, which the next eases out of
      lastTool: null,   // the last tool it had in hand
      lift: 0,          // how far it's stepping up (or down, below 0), eased: it leans into a step up
      shown: null,      // its pose as last drawn (see settle)
      raw: null,        // its arms as last posed, before easing (see settle)
      settling: null,   // easing over a sudden change of pose: how its pose differed then, and when (see settle)
      ready: 0,         // how much it's after an enemy (0-1, easing in and out: a barbarian raises its axe)
      dizzy: 0,         // a barbarian: seconds left of its stagger after a whirl
      loosed: null,     // an archer: when it last loosed (Units.time)
      dying: 0,         // seconds since it fell (0 while alive)
      look: Math.random() * COMBAT_TUNING.lookEvery, // seconds until it next looks for an enemy near it
      slot: null,       // the side of its target it's making for, [dx, dz] from the target's cell
      ordered: false,   // a ranged villager told to attack its target: it walks up to it if it's out of range
      commanded: false, // the player told it to attack its target: it sticks to it (focus fire)
    };
    this.list.push(u);
    return u;
  }

  // Neighbouring cells a unit can step to from (x, y, z), with their costs. climb: a worker, which climbs ladders: up
  // and down them, and on and off them sideways (a step up, across or down); from a rung it's hanging on, it only steps
  // off sideways, not on the slant, and doesn't hop down. team: the unit's, which can't pass another team's gate (see
  // gates.js: its opening's as good as wall to it); none, every gate's open.
  *neighbours(x, y, z, climb = false, team = null) {
    const ter = this.terrain, gate = team && this.gates?.blocker(team);
    const solid = gate ? (a, b, c) => ter.solid(a, b, c) || gate(a, b, c) : (a, b, c) => ter.solid(a, b, c);
    const stand = gate ? (a, b, c) => this.standable(a, b, c) && !gate(a, b, c) && !gate(a, b + 1, c) : (a, b, c) => this.standable(a, b, c);
    const hanging = climb && !this.standable(x, y, z);
    if (climb) {
      if (this.onLadder(x, y + 1, z) && !solid(x, y + 2, z)) yield [x, y + 1, z, 1.5];
      if (this.onLadder(x, y - 1, z) || (hanging && this.standable(x, y - 1, z))) yield [x, y - 1, z, 1.2];
    }
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = x + dx, nz = z + dz;
        if (hanging && dx && dz) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (!stand(nx, ny, nz)) {
            // (onto a ladder, straight across from beside it: not past a corner)
            if (climb && !(dx && dz) && this.onLadder(nx, ny, nz) && !(dy > 0 && solid(x, y + 2, z)) && !(dy < 0 && solid(nx, y + 1, nz))) {
              yield [nx, ny, nz, 1.5];
            }
            continue;
          }
          // Stepping up needs headroom above where it starts; stepping down, above where it lands.
          if (dy > 0 && solid(x, y + 2, z)) continue;
          if (dy < 0 && solid(nx, y + 1, nz)) continue;
          if (dx && dz) {
            // A diagonal cuts past the two cells beside it: both need room for the body at the higher height.
            const top = Math.max(y, ny);
            if (solid(x + dx, top, z) || solid(x + dx, top + 1, z) || solid(x, top, z + dz) || solid(x, top + 1, z + dz)) continue;
            if (!solid(x + dx, top - 1, z) && !solid(x, top - 1, z + dz)) continue; // no walking over a hole's corner
          }
          yield [nx, ny, nz, (dx && dz ? Math.SQRT2 : 1) + (dy > 0 ? 0.4 : 0)];
        }
        // Hopping down off a ledge, straight ahead only: the column it drops through must be clear.
        if (dx && dz || hanging) continue;
        if (solid(nx, y, nz) || solid(nx, y + 1, nz)) continue;
        for (let drop = 2; drop <= UNIT_TUNING.maxDrop; drop++) {
          const ny = y - drop;
          if (solid(nx, ny + 1, nz)) break; // landed higher up already (that's the one-step move above)
          if (stand(nx, ny, nz)) { yield [nx, ny, nz, 1 + 0.3 * drop]; break; }
        }
      }
    }
  }

  // A* from a cell to a goal cell. Returns the cells after the start, up to the goal or, if it can't be reached,
  // the reachable cell nearest it.
  // climb: a worker's, up and down ladders (see climbs). team: its team's (another team's gates are shut to it).
  findPath(start, goal, maxExpanded = UNIT_TUNING.maxExpanded, climb = false, team = null) {
    const h = (x, y, z) => {
      const dx = Math.abs(x - goal[0]), dz = Math.abs(z - goal[2]);
      return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz) + Math.abs(y - goal[1]) * 0.5;
    };
    const startK = key(...start), goalK = key(...goal);
    const g = new Map([[startK, 0]]);
    const from = new Map();
    const heap = new MinHeap();
    heap.push(h(...start), startK);
    let best = startK, bestH = h(...start), expanded = 0;
    const closed = new Set();
    while (heap.size && expanded < maxExpanded) {
      const k = heap.pop();
      if (closed.has(k)) continue;
      closed.add(k);
      expanded++;
      if (k === goalK) { best = k; break; }
      const [x, y, z] = unkey(k);
      const hk = h(x, y, z);
      if (hk < bestH) { bestH = hk; best = k; }
      const gk = g.get(k);
      for (const [nx, ny, nz, cost] of this.neighbours(x, y, z, climb, team)) {
        const nk = key(nx, ny, nz);
        if (closed.has(nk)) continue;
        const ng = gk + cost;
        if (ng < (g.get(nk) ?? Infinity)) {
          g.set(nk, ng);
          from.set(nk, k);
          heap.push(ng + h(nx, ny, nz), nk);
        }
      }
    }
    const path = [];
    for (let k = best; k !== startK; k = from.get(k)) path.push(unkey(k));
    return path.reverse();
  }

  // Orders the selected units to a clicked point, spreading them over nearby cells so they don't all pile onto one.
  // amove: attack-move (they fight enemies they meet on the way); queued: after the orders they already have (Shift).
  order(point, normal, amove = false, queued = false, sel = this.commandable()) {
    if (!sel.length) return [];
    // The cell in front of the clicked face, then the nearest place to stand there.
    const cx = Math.floor(point[0] + normal[0] * 0.5), cz = Math.floor(point[2] + normal[2] * 0.5);
    const cy = Math.floor(point[1] + normal[1] * 0.5);
    const goals = this.formation(cx, cy, cz, sel.length, new Set(sel));
    sel.forEach((u, i) => this.send(u, goals[i] ?? goals[0], amove, queued));
    return goals;
  }

  // n standable cells spiralling out from (x, z) at about height y, none where another villager (but those in `skip`)
  // has stopped or is going to.
  formation(x, y, z, n, skip = new Set()) {
    const out = [];
    for (let r = 0; out.length < n && r < 12; r++) {
      for (let dz = -r; dz <= r && out.length < n; dz++) {
        for (let dx = -r; dx <= r && out.length < n; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const h = this.standHeight(x + dx, z + dz, y, r ? 3 : 6);
          if (h >= 0 && !this.taken([x + dx, h, z + dz], skip)) out.push([x + dx, h, z + dz]);
        }
      }
    }
    return out;
  }

  // Soft blocking: villagers walk through each other, but never stop on a square another has stopped on or is on its
  // way to stop on. Whether one (other than u, or those in a Set u) has, or is going to (the end of its path).
  taken(cell, u) {
    for (const o of this.list) {
      if (o === u || o.dying || (u instanceof Set && u.has(o))) continue;
      const c = o.path.length ? o.path[o.path.length - 1] : o.cell;
      if (c[0] === cell[0] && c[1] === cell[1] && c[2] === cell[2]) return true;
    }
    return false;
  }

  // Whether u should make way: another villager stopped on its square before it did (or, u still moving, at all).
  yields(u) {
    const mine = u.path.length ? Infinity : u.restSince ?? Infinity;
    for (const o of this.list) {
      if (o === u || o.dying || o.path.length || o.restSince == null) continue;
      if (o.cell[0] !== u.cell[0] || o.cell[1] !== u.cell[1] || o.cell[2] !== u.cell[2]) continue;
      if (o.restSince < mine || (o.restSince === mine && o.id < u.id)) return true;
    }
    return false;
  }

  // Steps u off a square another villager has: to the nearest free one round it it can walk to (for a fighter, the
  // nearest to its target).
  stepAside(u) {
    const [x, y, z] = u.cell, t = u.target;
    for (let r = 1; r <= 3; r++) {
      const ring = [];
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const h = this.standHeight(x + dx, z + dz, y, 2), c = [x + dx, h, z + dz];
          if (h < 0 || this.taken(c, u)) continue;
          ring.push({ c, d: t ? Math.hypot(c[0] + 0.5 - t.pos[0], c[2] + 0.5 - t.pos[2]) : Math.hypot(dx, dz) + Math.random() * 0.1 });
        }
      }
      ring.sort((a, b) => a.d - b.d);
      for (const { c } of ring.slice(0, 3)) {
        const path = this.findPath(u.cell, c, 400, this.climbs(u), u.team), end = path[path.length - 1];
        if (end && end[0] === c[0] && end[1] === c[1] && end[2] === c[2]) { u.path = path; u.stepping = true; return true; }
      }
    }
    return false;
  }

  // Sends u to goal (attack-moving if amove). queued: after what it's already doing (walking somewhere, or going after
  // an enemy it was told to attack), else instead of it.
  send(u, goal, amove = false, queued = false) {
    if (!goal) return;
    if (queued && (u.goal || u.queue.length || (u.target && u.commanded))) { u.queue.push({ cell: goal, amove }); return; }
    this.workers.stop(u);
    u.target = null;
    u.queue = [];
    u.patrol = null;
    u.amove = amove;
    u.goal = goal;
    u.path = this.findPath(u.cell, goal, undefined, this.climbs(u), u.team);
    // A worker that can't get there (stuck in a pit, say): it builds a ladder out, then goes on (see Workers.escape).
    const end = u.path.at(-1) ?? u.cell;
    u.stuckGoal = this.climbs(u) && (end[0] !== goal[0] || end[1] !== goal[1] || end[2] !== goal[2]) ? goal : null;
    u.sentHere = !u.stuckGoal;
  }

  // Patrol (the selected units): attack-move to the point, then back to where each started (or, queued, where its
  // other orders end), and so on. Queued onto a patrol already set, the point's added to its round: they walk the
  // points in order, then back, and again.
  patrol(point, normal, queued = false, sel = this.commandable()) {
    if (!sel.length) return [];
    const cx = Math.floor(point[0] + normal[0] * 0.5), cz = Math.floor(point[2] + normal[2] * 0.5);
    const cy = Math.floor(point[1] + normal[1] * 0.5);
    const goals = this.formation(cx, cy, cz, sel.length, new Set(sel));
    sel.forEach((u, i) => {
      const goal = goals[i] ?? goals[0];
      if (!goal || u.dying) return;
      if (queued && u.patrol) { u.patrol.points.push(goal); return; }
      const from = (queued && (u.queue.at(-1)?.cell ?? u.goal)) || u.cell.slice();
      this.send(u, goal, true, queued);
      u.patrol = { points: [from, goal], i: 1, d: 1 };
    });
    return goals;
  }

  // On to u's next patrol point, turning back at either end of its round.
  patrolNext(u) {
    const P = u.patrol;
    if (P.i + P.d < 0 || P.i + P.d >= P.points.length) P.d = -P.d;
    P.i += P.d;
    u.queue = [{ cell: P.points[P.i], amove: true }];
    this.nextWaypoint(u);
  }

  // Sets u off to its next queued waypoint.
  nextWaypoint(u) {
    const w = u.queue.shift();
    u.amove = w.amove;
    u.goal = w.cell;
    u.path = this.findPath(u.cell, w.cell, undefined, this.climbs(u), u.team);
  }

  // The selected villagers the player can give orders to: all of them, or (controls set: a new game) only those of
  // that team.
  commandable() { return this.list.filter((u) => u.selected && u.kind !== 'crystal' && u.kind !== 'wall' && (!this.controls || u.team === this.controls)); }

  // Stop (H): the selected units drop their orders and stand where they are.
  stop() {
    for (const u of this.commandable()) {
      if (u.dying) continue;
      this.workers.stop(u);
      u.target = null;
      u.ordered = u.commanded = false;
      u.goal = null;
      u.queue = [];
      u.patrol = null;
      u.amove = false;
      if (!u.stepping) u.path = u.path.slice(0, 1); // (finishes the step it's on)
    }
  }

  // Sets u (a warrior or an archer; workers don't fight) on `target`: it goes after it. ordered: told to by the player
  // (an archer then walks up to it when it's out of range).
  // commanded: by the player, so it sticks to it; otherwise it switches to a much nearer enemy now and then, a ranged one
  // leaves one its side's shots in flight will already kill, and a melee one one with no free side to strike from, so
  // that a crowd spreads its blows over the enemy instead of all piling on one.
  attack(u, target, ordered = false, commanded = false) {
    if (u.kind === 'worker' || u.kind === 'priest' || u.kind === 'crystal' || u.kind === 'wall' || u === target || u.dying || target.dying || u.team === target.team) return;
    // Told to by the player: its other orders are dropped. Otherwise (it met an enemy attack-moving, or was hit on its
    // way somewhere) it carries on where it was going once this one's dead.
    if (commanded) { u.queue = []; u.patrol = null; u.amove = false; }
    else if (u.goal) u.queue.unshift({ cell: u.goal, amove: u.amove });
    u.target = target;
    u.ordered = ordered;
    u.commanded = commanded;
    u.slot = null;
    u.goal = null;
    u.path = [];
    u.chase = 0;
    u.swing = 0;
  }

  // Whether u can shoot t: in its range (see RANGED), and a clear line from its eyes to t's chest or head. A wall up to
  // two blocks high right beside it doesn't count (a parapet or battlement it shoots over), so archers can hold a wall
  // or a tower.
  canShoot(u, t) {
    const [ux, uy, uz] = u.cell;
    const from = [u.pos[0], u.pos[1] + 1.6, u.pos[2]];
    const range = COMBAT_TUNING[RANGED[u.role]?.range ?? 'bowRange'];
    // (Its chest or head; a power crystal's middle or upper part, up over its Keep's roof.)
    // (A wall section: its middle or top voxel; reaching it is reaching it, terrain as it is.)
    const crystal = t.kind === 'crystal', b = aimBase(t), L = CRYSTAL_TUNING.length, wall = t.kind === 'wall' && t.wall;
    const lo = crystal ? b + L * 0.4 : wall ? t.pos[1] + wall.h / 2 : t.pos[1] + 1.1;
    const hi = crystal ? b + L * 0.75 : wall ? t.pos[1] + wall.h - 0.5 : t.pos[1] + 1.7;
    if (Math.hypot(t.pos[0] - from[0], lo - from[1], t.pos[2] - from[2]) > range) return false;
    const clear = (to) => {
      const d = to.map((v, i) => v - from[i]), n = Math.ceil(Math.hypot(...d) * 4);
      for (let i = 1; i < n; i++) {
        const x = Math.floor(from[0] + d[0] * i / n), y = Math.floor(from[1] + d[1] * i / n), z = Math.floor(from[2] + d[2] * i / n);
        if (parapet(u.cell, x, y, z)) continue;
        if (wall && x === wall.x && z === wall.z && y >= wall.y0) return true;
        if (this.terrain.solid(x, y, z)) return false;
      }
      return true;
    };
    return clear([t.pos[0], lo, t.pos[2]]) || clear([t.pos[0], hi, t.pos[2]]);
  }

  // A ranged villager's turn (an archer, spearman or mage): keeping its target while it can shoot it, else the nearest
  // enemy it can; going through its cycle (drawing, winding up or gathering fire) and letting fly. A target it was told
  // to attack that it can't shoot from here, it walks towards until it can (so it stops at its range). Walking where it
  // was sent, it holds its fire until it's there (attack-moving, it stops to shoot one it can).
  shoot(u, dt) {
    const C = COMBAT_TUNING, R = RANGED[u.role];
    u.striking = false;
    if (u.goal) {
      u.target = null;
      u.swing = 0;
      if (!u.amove || (u.look -= dt) > 0) return;
      u.look = C.lookEvery;
      const best = this.nearestShot(u);
      if (!best) return;
      this.attack(u, best);
    }
    const t = u.target;
    if (t && (t.dying || !this.list.includes(t))) { u.target = null; u.path = []; }
    if (u.target && !this.canShoot(u, u.target)) {
      if (!u.ordered) { u.target = null; u.path = []; }
      else {
        u.swing = 0;
        u.chase -= dt;
        if (u.chase <= 0 || !u.path.length) {
          u.chase = C.chaseRepath;
          u.path = this.findPath(u.cell, u.target.cell, 6000, false, u.team);
        }
        return;
      }
    }
    if (!u.stepping) u.path = []; // (unless it's making way, see stepAside)
    if (!u.target) {
      u.ordered = false;
      if (u.queue.length || (u.look -= dt) > 0) { u.swing = 0; return; } // (waypoints to go to first: see update)
      u.look = C.lookEvery;
      u.target = this.nearestShot(u);
      u.commanded = false;
      if (!u.target) { u.swing = 0; return; }
    } else if (!u.commanded && u.swing < C[R.time] * 0.2 && (u.look -= dt) <= 0) {
      // Not told to shoot this one: early in its draw now and then, it switches to a much nearer one it can shoot, or
      // to another when its side's shots in flight will already kill this one.
      u.look = C.lookEvery;
      const t = u.target, doomed = this.doomed(t);
      const other = this.nearestShot(u, doomed ? Infinity : this.targetCost(u, t) - C.retarget, t);
      if (other && other !== t) { u.target = other; u.ordered = false; }
    }
    const o = u.target, dx = o.pos[0] - u.pos[0], dz = o.pos[2] - u.pos[2];
    // (An archer stands side-on, its left to its target.)
    const want = Math.atan2(dx, dz) - (u.role === 'archer' ? Math.PI / 2 : 0);
    u.yaw += ((((want - u.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI)) * Math.min(1, dt * 12);
    u.striking = true;
    const time = C[R.time], at = LOOSE[u.role] * time, was = u.swing;
    if (was === 0 && DRAW_SOUND[u.role]) sfx(DRAW_SOUND[u.role], chest(u)); // (drawing its bow, gathering its fire)
    u.swing += dt;
    if (was < at && u.swing >= at) this.loose(u, o);
    if (u.swing >= time) u.swing = 0;
  }

  // The enemy ranged villager u would best shoot (see targetCost: costing under `under`, and not `skip`), leaving out
  // those its side's shots in flight will already kill (unless there's no other), or null.
  nearestShot(u, under = Infinity, skip = null) {
    const R = RANGED[u.role], C = COMBAT_TUNING;
    let best = null, bestD = under, spare = null, spareD = under;
    for (const o of this.list) {
      if (o.team === u.team || o.dying || o === skip || (o.kind === 'wall' && o !== u.target)) continue; // (walls: only when told to)
      if (Math.hypot(o.pos[0] - u.pos[0], o.pos[1] - u.pos[1], o.pos[2] - u.pos[2]) > C[R.range]) continue;
      const d = this.targetCost(u, o);
      if (d >= Math.max(bestD, spareD) || !this.canShoot(u, o)) continue;
      if (this.doomed(o)) { if (d < spareD) { spareD = d; spare = o; } } else if (d < bestD) { bestD = d; best = o; }
    }
    return best ?? (skip ? null : spare);
  }

  // u lets fly at o: an arrow from its bow, a spear from its raised hand, or a fireball from its staff's orb. Arrows and
  // spears go for a random spot on o (aim, in o's frame from its feet), a fireball for its middle; a spear's head goes
  // on through, so that it stops with its middle there.
  loose(u, o) {
    const C = COMBAT_TUNING, R = RANGED[u.role], what = R.what;
    let from;
    u.loosed = this.time;
    if (what === 'arrow') from = [u.pos[0] + Math.cos(u.yaw) * 0.9, u.pos[1] + mountLift(u) + 1.4, u.pos[2] - Math.sin(u.yaw) * 0.9]; // its bow, out to its left
    else {
      const h = handPose(u.role, LOOSE[u.role] - 1e-6, 0); // as it was the moment before
      from = handPoint(u, h.arm, h.ang, h.slide + (what === 'spear' ? SPEAR_TIP : STAFF_ORB), h.roll);
    }
    const aim = what === 'fire' ? [0, 1, 0]
      : what === 'spear' ? [(Math.random() - 0.5) * 0.4, 0.75 + Math.random() * 0.6, 0] // (high enough its head's clear of the ground)
        : [(Math.random() - 0.5) * 0.44, 0.5 + Math.random() * 0.85, (Math.random() - 0.5) * 0.12];
    const a = { what, from, by: u, cell: u.cell.slice(), target: o, aim, arc: R.arc, t: 0, time: 1 };
    const dist = Math.hypot(...this.aimPoint(a).map((v, i) => v - from[i]));
    a.time = Math.max(0.15, dist / C[R.speed]);
    if (what === 'spear') {
      // Its head ends up SPEAR_TIP past the spot it's aimed at, the way it'll be going then.
      a.through = [0, 0, 0];
      for (let i = 0; i < 2; i++) {
        const to = this.aimPoint(a).map((v, j) => v + a.through[j] - from[j]);
        to[1] -= 4 * a.arc * Math.hypot(to[0], to[2]);
        const l = Math.hypot(...to) || 1;
        a.through = to.map((v) => v / l * SPEAR_TIP);
      }
    }
    if (what === 'arrow' && Math.random() < C.arrowMiss) {
      // A miss: into the ground beside it, a little short or long.
      const ang = Math.random() * Math.PI * 2, r = 0.7 + Math.random();
      a.to = this.groundBelow(o.pos[0] + Math.cos(ang) * r, aimBase(o) + 1, o.pos[2] + Math.sin(ang) * r);
    }
    this.arrows.push(a);
    if (what === 'arrow') { sfx('bowRelease', from); sfx('arrowFly', this.arrowAt(a, 0.5), { delay: a.time * 0.2 }); }
    else sfx(what === 'spear' ? 'spearThrow' : 'fireLaunch', from);
  }

  // The spot on its target that a shot's aimed at, in the world.
  aimPoint(a) {
    const t = a.target, cy = Math.cos(t.yaw), sy = Math.sin(t.yaw), [x, y, z] = a.aim;
    return [t.pos[0] + cy * x + sy * z, aimBase(t) + y, t.pos[2] - sy * x + cy * z]; // (a rider: up in its saddle)
  }

  // The top of the ground under (x, y, z): where an arrow that comes down there sticks.
  groundBelow(x, y, z) {
    const cx = Math.floor(x), cz = Math.floor(z);
    let g = Math.floor(y);
    while (g > 0 && !this.terrain.solid(cx, g - 1, cz)) g--;
    return [x, g, z];
  }

  // Where shot a (its tip: an arrow's or spear's head, a fireball's middle) is at s (0-1) through its flight: on an arc
  // (a.arc high for its length) from where it was loosed to the spot on its target (a spear's on through it), or, a
  // miss, to where it lands.
  arrowAt(a, s) {
    const to = a.to ?? this.aimPoint(a).map((v, i) => v + (a.through?.[i] ?? 0));
    const len = Math.hypot(to[0] - a.from[0], to[2] - a.from[2]);
    const p = a.from.map((v, i) => v + (to[i] - v) * s);
    p[1] += 4 * s * (1 - s) * len * a.arc;
    return p;
  }

  // One villager's fighting, before it moves: looking for an enemy near it, closing in on its target, or swinging at
  // it when in range (unless another of its attackers, there first, has the square it's in: then it moves round).
  fight(u, dt) {
    const C = COMBAT_TUNING, old = u.target;
    u.striking = false;
    if (old && (old.dying || !this.list.includes(old))) { u.target = null; u.slot = null; u.path = []; u.goal = null; u.look = 0; }
    const barbarian = u.role === 'barbarian';
    if (barbarian) this.whirl(u, dt);
    if (!u.target) {
      // (walking where it was sent: it doesn't stop to fight, unless attack-moving)
      // (or with waypoints still to go to: see update)
      if ((u.goal && !u.amove) || u.queue.length || (u.look -= dt) > 0) return;
      u.look = C.lookEvery;
      const best = this.bestEnemy(u, C.aggro);
      if (!best) return;
      this.attack(u, best);
      if (!u.target) return;
    }
    const t = u.target;
    const dx = t.pos[0] - u.pos[0], dz = t.pos[2] - u.pos[2];
    const crowded = this.yields(u); // another's stopped on its square (see taken): it moves round
    if (Math.hypot(dx, dz) < C.range && Math.abs(t.pos[1] - u.pos[1]) < 1.6 && !crowded) {
      u.path = [];
      // A barbarian stands there whirling (see whirl) rather than swinging.
      if (barbarian) { u.striking = u.whirling; u.swing = 0; return; }
      u.striking = true;
      const want = Math.atan2(dx, dz);
      u.yaw += ((((want - u.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI)) * Math.min(1, dt * 12);
      // The blow lands as the slash passes ahead of it (see warriorPose), then it recovers and swings the other way.
      const at = SLASH_HIT * C.attackTime, was = u.swing;
      u.swing += dt;
      if (was < at * 0.6 && u.swing >= at * 0.6) sfx('swordSwing', chest(u)); // (the slash's whoosh, as it comes down)
      if (was < at && u.swing >= at) this.hit(t, u);
      if (u.swing >= C.attackTime) { u.swing = 0; u.backhand = !u.backhand; }
      return;
    }
    u.swing = 0;
    // Not told to go for this one: now and then it switches to a much nearer enemy, or to another one when there's no
    // free side of this one to strike from (others round it already).
    let slot = this.slotFor(u, t);
    if (!u.commanded && (u.look -= dt) <= 0) {
      u.look = C.lookEvery;
      const free = (o) => o !== t && this.slotFor(u, o);
      const other = this.bestEnemy(u, C.aggro, free, slot ? this.targetCost(u, t) - C.retarget : Infinity);
      if (other) { this.attack(u, other, u.ordered); return; }
    }
    // A new path every chaseRepath seconds, or sooner (but not every frame) when where it's going has changed.
    const end = u.path[u.path.length - 1];
    const moved = !end || !slot || slot.cell.some((v, i) => v !== end[i]);
    u.chase -= dt;
    if (u.chase <= 0 || !u.path.length || (moved && u.chase < C.chaseRepath - 0.2)) {
      u.chase = C.chaseRepath;
      u.slot = slot?.off ?? null;
      u.path = this.findPath(u.cell, slot?.cell ?? t.cell, 6000, false, u.team);
    }
  }

  // A barbarian's whirl: while any enemy is within whirlRange it spins (easing in and out), its axe held out level,
  // hitting every enemy within axeReach every whirlTime seconds, the first half that in.
  whirl(u, dt) {
    const C = COMBAT_TUNING;
    const near = (o, r) => !o.dying && o.team !== u.team && (o.kind !== 'wall' || o === u.target) && Math.abs(o.pos[1] - u.pos[1]) < 1.6 &&
      Math.hypot(o.pos[0] - u.pos[0], o.pos[2] - u.pos[2]) <= r;
    const on = this.list.some((o) => near(o, C.whirlRange));
    if (on && !u.whirling) u.whirlTick = C.whirlTime * 0.5;
    u.dizzy = !on && u.whirling ? ANIM_TUNING.dizzy : Math.max(0, u.dizzy - dt); // (it staggers once it stops)
    u.whirling = on;
    u.whirl = Math.max(0, Math.min(1, u.whirl + (on ? dt : -dt) / 0.25));
    if (u.whirl > 0) {
      u.yaw = (u.yaw + C.whirlSpin * Math.PI * 2 * ease(u.whirl) * dt) % (Math.PI * 2);
      // Its head spots like a dancer's: held on one way (u.spot) as it turns, then snapped round ahead (see axePose).
      if (u.spot === undefined || wrapAngle(u.spot - u.yaw) < -1) u.spot = u.yaw + 0.8;
    } else u.spot = undefined;
    if (!on || (u.whirlTick -= dt) > 0) return;
    u.whirlTick += C.whirlTime;
    for (const o of this.list.filter((o) => near(o, C.axeReach))) this.hit(o, u, 'axe');
  }

  // A priest's turn: it picks the most hurt of its side within healSeek (by what share of their hit points they've
  // lost) that no other priest of its side has, keeping to the one it has unless another's switchMargin more hurt;
  // with none, it stands idle. It walks till they're well within beamRange (unless it was sent somewhere, healing on
  // the way), and while they're in reach its beam heals them healAmount hit points every healTick seconds. Turning to
  // another, its beam waits switchTime.
  tend(u, dt) {
    const C = COMBAT_TUNING;
    const dist = (o) => Math.hypot(o.pos[0] - u.pos[0], o.pos[1] - u.pos[1], o.pos[2] - u.pos[2]);
    const taken = new Set();
    for (const o of this.list) if (o !== u && o.kind === 'priest' && o.team === u.team && !o.dying && o.healing) taken.add(o.healing);
    const ok = (o) => o !== u && o.team === u.team && !o.dying && o.kind !== 'crystal' && o.kind !== 'wall' && o.hp < o.maxHp && !taken.has(o) && dist(o) <= C.healSeek; // (not a power crystal)
    let best = null, worst = Infinity;
    for (const o of this.list) {
      if (!ok(o)) continue;
      const share = o.hp / o.maxHp;
      if (share < worst) { worst = share; best = o; }
    }
    const was = u.healing;
    if (was && ok(was) && (!best || was.hp / was.maxHp - C.switchMargin <= worst)) best = was;
    if (best !== was) {
      if (was && best) u.beamWait = C.switchTime;
      u.healing = best;
      u.chase = 0;
    }
    u.beamWait = Math.max(0, u.beamWait - dt);
    const o = u.healing;
    const on = !!o && u.beamWait <= 0 && dist(o) <= C.beamRange;
    if (!on) u.healTicked = 0;
    if (on && !u.beaming) sfx('prayer', chest(u));
    u.beaming = on;
    u.channel = Math.max(0, Math.min(1, u.channel + (u.beaming ? dt : -dt) * 4));
    if (u.beaming) {
      u.beamTo = o;
      if ((u.healTicked += dt) >= C.healTick) {
        u.healTicked -= Math.max(C.healTick, 1e-3);
        o.hp = Math.min(o.maxHp, o.hp + C.healAmount);
        sfx('healTick', chest(o));
      }
      if (!u.path.length) { // standing, it turns to them
        const want = Math.atan2(o.pos[0] - u.pos[0], o.pos[2] - u.pos[2]);
        u.yaw += ((((want - u.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI)) * Math.min(1, dt * 8);
      }
    }
    if (u.goal) return;
    if (!o || dist(o) <= C.beamRange * 0.8) { if (!u.stepping) u.path = []; return; }
    u.chase -= dt;
    if (u.chase <= 0 || !u.path.length) {
      u.chase = C.chaseRepath;
      u.path = this.findPath(u.cell, o.cell, 6000, false, u.team);
    }
  }

  // The nearest villager of another team within `radius` of u (and that `ok` allows), or null.
  nearestEnemy(u, radius, ok = null) {
    let best = null, bestD = radius;
    for (const o of this.list) {
      if (o.team === u.team || o.dying || (ok && !ok(o))) continue;
      const d = Math.hypot(o.pos[0] - u.pos[0], (o.pos[1] - u.pos[1]) * 1.5, o.pos[2] - u.pos[2]);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  // How far u is from o (as nearestEnemy measures it).
  enemyDistance(u, o) { return Math.hypot(o.pos[0] - u.pos[0], (o.pos[1] - u.pos[1]) * 1.5, o.pos[2] - u.pos[2]); }

  // How much u would rather not go for o: its distance, plus spread for each other of u's side already on it (so a
  // crowd picking its own targets spreads over the enemy rather than all piling on the nearest).
  targetCost(u, o) {
    const n = (this.attackers.get(o) ?? 0) - (u.target === o ? 1 : 0); // (each enemy is only fought by the other side)
    return this.enemyDistance(u, o) + COMBAT_TUNING.spread * n;
  }

  // The enemy u would best go for (see targetCost) within `radius` voxels (and that `ok` allows), costing less than
  // `under`, or null.
  bestEnemy(u, radius, ok = null, under = Infinity) {
    let best = null, bestC = under;
    for (const o of this.list) {
      if (o.team === u.team || o.dying || o.kind === 'wall' || this.enemyDistance(u, o) > radius || (ok && !ok(o))) continue; // (walls: only when told to)
      const c = this.targetCost(u, o);
      if (c < bestC) { bestC = c; best = o; }
    }
    return best;
  }

  // Whether the shots already flying at o (arrows and spears that won't miss, fireballs) will kill it.
  doomed(o) {
    let dmg = 0;
    for (const a of this.arrows) {
      if (a.target !== o || a.to || a.t >= a.time) continue;
      dmg += COMBAT_TUNING[`${a.what}Damage`] * (a.what === 'fire' ? (o.kind === 'crystal' ? CRYSTAL_TUNING.fire : o.kind === 'wall' ? WALL_TUNING.fire : o.maxHp) / 100 : 1);
    }
    return dmg >= o.hp;
  }

  // Where beside target t attacker u should strike from: the side it was making for if that's still free, else a side
  // no other attacker of t has taken (then a corner), the nearest to u that it could stand in. As { off: [dx, dz],
  // cell }, or null when there's none.
  slotFor(u, t) {
    const taken = new Set();
    for (const o of this.list) if (o !== u && o.target === t && !o.dying && o.slot) taken.add(`${o.slot[0]},${o.slot[1]}`);
    const at = ([ox, oz]) => {
      if (taken.has(`${ox},${oz}`)) return null;
      const x = t.cell[0] + ox, z = t.cell[2] + oz, y = this.standHeight(x, z, t.cell[1], 1);
      return y < 0 || this.taken([x, y, z], u) ? null : { off: [ox, oz], cell: [x, y, z] };
    };
    const kept = u.slot && at(u.slot);
    if (kept) return kept;
    for (const ring of [[[1, 0], [-1, 0], [0, 1], [0, -1]], [[1, 1], [1, -1], [-1, 1], [-1, -1]]]) {
      let best = null, bestD = Infinity;
      for (const off of ring) {
        const s = at(off);
        if (!s) continue;
        const d = Math.hypot(s.cell[0] + 0.5 - u.pos[0], s.cell[2] + 0.5 - u.pos[2]);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (best) return best;
    }
    return null;
  }

  // A blow on t by `by`, with `weapon` ('sword', 'arrow', 'spear' or 'fire', the blast of a fireball that burst at
  // `from'; 'drown', the water, see drown, by itself): it fights back (unless it's a worker, see below), and falls
  // when it's out of hit points, knocked away from `from` as hard as the weapon does (see RAGDOLL_TUNING). damage: hit
  // points it takes, if not the weapon's.
  hit(t, by, weapon = 'sword', from = by.pos, damage = null) {
    if (t.kind === 'crystal') { this.hitCrystal(t, by, weapon, from, damage); return; }
    if (t.kind === 'wall') { this.hitWall(t, by, weapon, from, damage); return; }
    t.hp -= damage ?? (weapon === 'fire' ? fireShare(t, from) * t.maxHp : COMBAT_TUNING[`${weapon}Damage`]);
    const H = HIT_TUNING, water = weapon === 'drown';
    // Its blow (a sword on a warrior's armour clanks), its cry (voices: silent for now), and the player hearing of it
    // when it's theirs out of sight (see audio.js).
    if (!water) {
      const blow = BLOW_SOUND[weapon];
      if (blow) sfx(blow === 'swordHit' && t.role === 'warrior' ? 'armourHit' : blow, chest(t));
      if (by !== t) { sfx('underAttack', t.pos, { team: t.team }); this.onHurt?.(t, by); }
    }
    sfx(t.hp <= 0 ? 'deathCry' : 'grunt', chest(t));
    if (t.hp <= 0 && MOUNTS[t.kind]) sfx('neigh', chest(t));
    // Blood (Options can turn it off): out the way the blow went, more for an arrow or spear going in, and its fall.
    if (!water) {
      const c = chest(t), d = [c[0] - from[0], c[1] - (from[1] + 1), c[2] - from[2]], dl = Math.hypot(...d);
      const pierce = weapon === 'arrow' || weapon === 'spear';
      splashBlood(c, dl > 1e-3 ? d.map((v) => v / dl) : null, (pierce ? 1.5 : weapon === 'fire' ? 0.5 : 1) * (t.hp <= 0 ? 1.5 : 1));
    }
    t.hurt = H.flash;
    t.wincing = EYE_TUNING.wince;
    t.frozen = water ? 0 : H.freeze;
    let kx = t.pos[0] - from[0], kz = t.pos[2] - from[2];
    const kl = Math.hypot(kx, kz);
    if (kl > 1e-3) { kx /= kl; kz /= kl; } else { const a = Math.random() * Math.PI * 2; kx = Math.cos(a); kz = Math.sin(a); }
    if (!water) {
      t.knock = { dir: [kx * H.knock, kz * H.knock], t: 0 };
      t.flinch = { dir: [kx, kz], t: 0, k: FLINCH[weapon] ?? 1 };
    }
    if (t.hp <= 0) {
      // It drops what it was holding: its tool, sword, spear (unless it's just thrown it) or staff, and its bow or (at
      // night) torch.
      const held = [];
      const tool = this.toolOf(t);
      if (tool) held.push({ parts: HELD[tool], hand: 'right', sound: METAL_TOOLS.has(tool) ? 'metalClatter' : 'woodClatter' });
      if (t.role === 'spearman' && handPose('spearman', t.striking ? t.swing / COMBAT_TUNING.throwTime : null, 0).held) held.push({ parts: SPEAR_HELD, hand: 'right' });
      if (t.role === 'mage') held.push({ parts: STAFF_HELD, hand: 'right' });
      if (t.role === 'priest') held.push({ parts: ANKH_HELD, hand: 'right' });
      if (t.role === 'barbarian') held.push({ parts: BATTLEAXE_HELD, hand: 'right', sound: 'metalClatter' });
      if (t.role === 'archer') held.push({ parts: bowParts(0), hand: 'left' });
      else if (this.lit > 0) held.push({ parts: HELD.torch, hand: 'left' });
      // Now and then a sandal comes off as it falls; a warrior's helmet, pauldron or a boot, a spearman's winged
      // helmet or a mage's hat (the ragdoll rolls for those).
      const R = RAGDOLL_TUNING, leg = Math.random() < 0.5 ? 0 : 1;
      if (t.role !== 'warrior' && Math.random() < R.sandal) held.push({ parts: SANDAL, leg });
      if (t.role === 'warrior') {
        const plume = plumeOf(t.team);
        held.push({ parts: HELMET.map(([c, s, col]) => [c, s, col ?? plume]), head: true, chance: R.helmet, kind: 'helmet' });
        held.push({ parts: PAULDRON, limb: 3, chance: R.pauldron, kind: 'pauldron' });
        held.push({ parts: BOOT, leg, chance: R.boot, kind: 'boot' });
      }
      if (t.role === 'mage') held.push({ parts: hatOf(t.team), head: true, chance: R.hat, kind: 'hat' });
      if (t.role === 'spearman') held.push({ parts: VALKYRIE, head: true, chance: R.wingedHelmet, kind: 'helmet' });
      this.workers.stop(t);
      t.dying = 1e-4;
      // Its limbs start as they were last drawn (see posture), swinging, striking or drawing a bow.
      const pose = t.pose ?? { angles: [0, 0, 0, 0], rolls: [0, 0, 0, 0] };
      // (A rider falls from its saddle.)
      const up = mountLift(t), body = up ? { ...t, pos: [t.pos[0], t.pos[1] + up, t.pos[2]] } : t;
      t.rag = new Ragdoll(this.terrain, body, from, pose.angles, held, weapon, pose.rolls);
      // (And its horse falls too, a ragdoll of its own: see horse.js.)
      if (MOUNTS[t.kind]) t.horseRag = new HorseRagdoll(this.terrain, t, from, weapon);
      if (t.rag.popped) { const [at, up] = t.rag.neck(); splashBlood(at, up, 2.5); } // (its head off)
      t.target = null;
      t.striking = false;
      t.whirling = false;
      t.selected = false;
      t.path = [];
      t.goal = null;
      t.queue = [];
      this.onDeath?.(t);
      return;
    }
    if (water) return;
    // It turns on whoever hurt it, however far off (a ranged villager walking up to its own range of them first, as if
    // told to), unless it's busy with one it was told to attack or one that's fighting it back.
    // Bring a friend: the first time it's hurt by an enemy it's fighting, its fighters within bringFriend voxels (who
    // aren't busy) join in, each going for the enemy it would best go for itself (see targetCost; no further than
    // that one). Those don't call others
    // themselves unless they're hurt too.
    const busy = (u) => u.target && !u.target.dying && (u.ordered || u.target.target === u);
    if (t.target !== by) {
      if (busy(t)) return;
      this.attack(t, by, true);
    }
    if (t.calledFriends === by) return;
    t.calledFriends = by;
    const R = COMBAT_TUNING.bringFriend;
    for (const o of this.list) {
      if (o === t || o.team !== t.team || o.dying || o.target === by || busy(o)) continue;
      if (Math.hypot(o.pos[0] - t.pos[0], o.pos[1] - t.pos[1], o.pos[2] - t.pos[2]) > R) continue;
      this.attack(o, this.bestEnemy(o, this.enemyDistance(o, by) + 1e-3) ?? by, true);
    }
  }

  // A blow on a power crystal (see crystals.js): it flashes, and its team's fighters near it (bringFriend voxels) go for
  // whoever hit it, the first time that one does; out of hit points, it's destroyed (onDeath: its team's out).
  hitCrystal(t, by, weapon, from, damage) {
    t.hp -= damage ?? (weapon === 'fire' ? fireShare(t, from) * CRYSTAL_TUNING.fire : COMBAT_TUNING[`${weapon}Damage`]);
    t.hurt = HIT_TUNING.flash;
    // It rings, lower the more it's hurt (its shatter: see main.js onDeath).
    if (t.hp > 0) sfx('crystalHit', [t.pos[0], t.pos[1] + (t.raise ?? 0) + 1.5, t.pos[2]], { pitch: 0.75 + 0.5 * t.hp / (t.maxHp || CRYSTAL_TUNING.hp) });
    if (by !== t && by.team !== t.team) { sfx('underAttack', t.pos, { team: t.team }); this.onHurt?.(t, by); }
    if (t.hp <= 0) {
      t.dying = 1e-4;
      t.selected = false;
      this.onDeath?.(t);
      return;
    }
    if (by === t || by.team === t.team || t.calledFriends === by) return;
    t.calledFriends = by;
    const busy = (u) => u.target && !u.target.dying && (u.ordered || u.target.target === u);
    for (const o of this.list) {
      if (o.team !== t.team || o.dying || o.kind === 'crystal' || o.kind === 'worker' || o.target === by || busy(o)) continue;
      if (Math.hypot(o.pos[0] - t.pos[0], o.pos[1] - t.pos[1], o.pos[2] - t.pos[2]) > COMBAT_TUNING.bringFriend) continue;
      this.attack(o, by, true);
    }
  }

  // A blow on a section of wall (see walls.js): it takes the hit points (a fireball's WALL_TUNING.fire at most), and
  // out of them it comes down (onDeath: main knocks its blocks out).
  hitWall(t, by, weapon, from, damage) {
    if (t.dying) return;
    t.hp -= damage ?? (weapon === 'fire' ? fireShare(t, from) * WALL_TUNING.fire : COMBAT_TUNING[`${weapon}Damage`] ?? 1);
    if (weapon !== 'fire') sfx(t.wall.block === BLOCK.PLANK ? 'chop' : 'pickStone', [t.pos[0], t.pos[1] + t.wall.h / 2, t.pos[2]], { gain: 0.5 });
    if (by !== t && by.team !== t.team) { sfx('underAttack', t.pos, { team: t.team }); this.onHurt?.(t, by); }
    if (t.hp > 0) return;
    t.dying = 1e-4;
    t.selected = false;
    this.onDeath?.(t);
  }

  // A fireball by `by` bursts at p: it blows a hole fireBlast voxels round (never the bedrock), hurts every enemy of
  // by's within it, flings the fallen lying near it about and pulls out whatever's stuck in the ground it took. dir: the
  // way it was flying.
  explode(p, by, dir = [0, -1, 0]) {
    const C = COMBAT_TUNING, r = C.fireBlast, R = RAGDOLL_TUNING;
    sfx('explosion', p);
    const changed = r > 0 ? this.terrain.applySphere(p, r, false, this.walls && ((x, y, z) => !!this.walls.at(x, y, z))) : null; // (not a wall's blocks)
    if (changed) this.onEdit?.(changed.lo, changed.hi);
    this.stuck = this.stuck.filter((s) => Math.hypot(...s.pos.map((v, i) => v - p[i])) > r);
    for (const o of this.list) {
      const d = Math.hypot(o.pos[0] - p[0], middleY(o) - p[1], o.pos[2] - p[2]);
      if (!o.dying && o.team !== by.team && d <= r + 0.5) this.hit(o, by, 'fire', p);
      else if (o.rag && d <= r * 2 + 1) {
        o.rag.blast(p, R.fireKick * (1 - d / (r * 2 + 2)));
        o.horseRag?.blast(p, R.fireKick * (1 - d / (r * 2 + 2)));
      }
    }
    this.onBlast?.(p, Math.max(1, r), dir); // its fire and smoke (see puffs.js), and the ground's char (scorch.js)
    this.blasts.push({ pos: p, age: 0 });
  }

  // What u has in its right hand of HELD: a warrior its sword, a worker the tool for its task (or nothing), the rest
  // nothing (an archer's bow is in its left; a spearman's spear and a mage's staff are posed apart, see handPose).
  toolOf(u) {
    return u.role === 'warrior' ? 'sword' : u.kind === 'worker' ? (u.ladderTask ? 'hammer' : toolFor(this.terrain, u)) : null;
  }

  // A villager stuck in the water (nowhere in its column to climb out to): it loses drownDamage hit points a second,
  // a point at a time, and drowns.
  drown(u, dt) {
    if (u.drowning === undefined) sfx('splash', u.pos); // (it falls in)
    u.drowning = (u.drowning ?? 0) + COMBAT_TUNING.drownDamage * dt;
    if (u.drowning < 1) return;
    const n = Math.floor(u.drowning);
    u.drowning -= n;
    sfx('bubbles', u.pos);
    this.hit(u, u, 'drown', u.pos, n);
  }

  // Nearest unit whose box a ray hits, or null.
  pick(ro, rd) {
    let best = null, bestT = Infinity;
    for (const u of this.list) {
      if (u.dying || u.hidden || u.kind === 'wall') continue; // (a wall's picked as terrain: see main.js targetAt)
      const feet = this.drawHeight(u);
      const top = u.kind === 'crystal' ? CRYSTAL_TUNING.hover + CRYSTAL_TUNING.length + CRYSTAL_TUNING.bob : 2 + mountLift(u);
      const base = feet + (u.kind === 'crystal' ? u.raise ?? 0 : 0); // (a crystal's drawn up on its Keep's roof)
      // (A horse is 2 voxels long: the box round it, the way it faces.)
      const sy = Math.abs(Math.sin(u.yaw)), cy = Math.abs(Math.cos(u.yaw)), horse = MOUNTS[u.kind];
      const hx = horse ? 0.95 * sy + 0.3 * cy : 0.45, hz = horse ? 0.95 * cy + 0.3 * sy : 0.45;
      const lo = [u.pos[0] - hx, base, u.pos[2] - hz], hi = [u.pos[0] + hx, base + top, u.pos[2] + hz];
      let t0 = 0, t1 = Infinity;
      for (let a = 0; a < 3; a++) {
        const inv = 1 / rd[a];
        let ta = (lo[a] - ro[a]) * inv, tb = (hi[a] - ro[a]) * inv;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
      }
      if (t0 <= t1 && t0 < bestT) { bestT = t0; best = u; }
    }
    return best ? { unit: best, t: bestT } : null;
  }

  update(dt) {
    const T = UNIT_TUNING;
    this.time += dt;
    this.attackers.clear();
    if (this.time >= (this.prunedAt ?? 0) + 1) { this.prunedAt = this.time; this.ladders.prune(); } // (rungs edits took away)
    for (const u of this.list) {
      if (u.path.length || u.dying) u.restSince = null;
      else u.restSince ??= this.time;
      if (u.target && !u.dying) this.attackers.set(u.target, (this.attackers.get(u.target) ?? 0) + 1);
    }
    this.workers.update(dt);
    for (const u of this.list) {
      u.hurt = Math.max(0, u.hurt - dt);
      u.wincing = Math.max(0, u.wincing - dt);
      if (u.blinking != null && (u.blinking += dt) >= EYE_TUNING.blinkTime) u.blinking = null;
      if ((u.blink -= dt) <= 0) {
        u.blinking = 0;
        u.blink = EYE_TUNING.blinkMin + Math.random() * Math.max(0, EYE_TUNING.blinkMax - EYE_TUNING.blinkMin);
      }
      if (u.kind === 'crystal' || u.kind === 'wall') { if (u.dying) u.dying += dt; continue; } // (a power crystal: it just floats there; a wall stands)
      if (u.dying) {
        u.idle += dt; u.dying += dt; u.rag?.step(dt); u.horseRag?.step(dt);
        // (Its head off: blood spurts from the neck a while, less and less.)
        const T = SPLASH_TUNING, left = 1 - u.dying / T.neck;
        if (u.rag?.popped && left > 0 && T.bloodCount > 0) {
          const [at, up] = u.rag.neck();
          splashBlood(at, up, T.neckRate * left * dt / T.bloodCount); // (neckRate squares a second)
        }
        continue;
      }
      // Hit-freeze: held still for a moment after a blow (its swing, walk and all), then knocked back (see knockOffset).
      if (u.frozen > 0) { u.frozen -= dt; continue; }
      u.idle += dt;
      if (u.knock && (u.knock.t += dt) >= HIT_TUNING.knockTime) u.knock = null;
      if (u.flinch && (u.flinch.t += dt) >= ANIM_TUNING.flinchTime) u.flinch = null;
      u.workW = Math.max(0, Math.min(1, u.workW + (u.working > 0 ? dt : -dt) * 5));
      u.ready += ((u.target ? 1 : 0) - u.ready) * Math.min(1, dt * 6);
      u.lift += (Math.max(-1, Math.min(1, u.cell[1] - u.pos[1])) - u.lift) * Math.min(1, dt * 10);
      if (RANGED[u.role]) this.shoot(u, dt); else if (u.role === 'warrior' || u.role === 'barbarian') this.fight(u, dt); else if (u.role === 'priest') this.tend(u, dt);
      // Done with an enemy it met on the way: on to where it was going.
      if (u.queue.length && !u.goal && !u.target && !u.path.length && !u.task) this.nextWaypoint(u);
      else if (u.patrol && !u.goal && !u.target && !u.path.length && !u.task) this.patrolNext(u); // (and on patrol)
      // Stopped on a square another villager stopped on first: it steps off (a worker at a job and a fighter at its
      // target see to that themselves).
      if (!u.path.length && !u.task && !u.goal && !u.ladderBuild && !(u.target && !RANGED[u.role]) && (u.shuffle -= dt) <= 0) {
        u.shuffle = 0.3;
        if (this.yields(u)) this.stepAside(u);
      }
      // The ground may have been edited under it: climb out if buried, fall if undermined (a worker on a ladder hangs on).
      const climb = this.climbs(u), rung = climb && this.ladders.get(...u.cell);
      if (!this.standable(...u.cell) && !(rung && !this.terrain.solid(u.cell[0], u.cell[1] + 1, u.cell[2]))) {
        const [x, y, z] = u.cell;
        let h = -1;
        for (let d = 1; d < 6 && h < 0; d++) if (this.standable(x, y + d, z)) h = y + d;
        if (h < 0) for (let yy = y - 1; yy >= 1; yy--) if (this.standable(x, yy, z)) { h = yy; break; }
        if (h >= 0) {
          u.cell = [x, h, z];
          if (u.goal) u.repath = T.repathDelay;
        } else { // in the water: it sinks to its chest and drowns
          u.cell = [x, Math.min(y, WATER_LEVEL - 1), z];
          u.path = [];
          this.drown(u, dt);
        }
      }
      if (u.repath > 0 && (u.repath -= dt) <= 0 && u.goal) u.path = this.findPath(u.cell, u.goal, undefined, this.climbs(u), u.team);

      let walking = false;
      const speed = T[`${u.kind}Speed`] ?? 3.2;
      if (u.path.length) {
        const next = u.path[0];
        // An edit may have made the next step impossible: find a new way there.
        const up = next[0] === u.cell[0] && next[2] === u.cell[2] && next[1] !== u.cell[1]; // (straight up or down a ladder)
        if (!this.footing(...next, climb) || next[1] - u.cell[1] > 1 || u.cell[1] - next[1] > T.maxDrop || (up && !climb)) {
          u.path = [];
          u.repath = T.repathDelay;
        } else if ((up || rung) && Math.abs(u.pos[1] - u.cell[1]) > 0.04) {
          walking = true; // (on a ladder: a rung at a time)
        } else {
          walking = true;
          const tx = next[0] + 0.5, tz = next[2] + 0.5;
          const dx = tx - u.pos[0], dz = tz - u.pos[2];
          const dist = Math.hypot(dx, dz);
          const step = speed * dt;
          if (dist > 1e-4 && !u.whirl) { // (a whirling barbarian spins as it goes)
            const want = Math.atan2(dx, dz);
            let dy = ((want - u.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
            u.yaw += dy * Math.min(1, dt * 12);
          }
          if (dist <= step) {
            u.pos[0] = tx;
            u.pos[2] = tz;
            u.cell = next;
            u.path.shift();
            if (!u.path.length) {
              u.goal = null;
              u.stepping = false;
              if (u.queue.length && !u.target) this.nextWaypoint(u);
            }
          } else {
            u.pos[0] += (dx / dist) * step;
            u.pos[2] += (dz / dist) * step;
            // Take the step up or down once past the cell edge, into the next one (cutting a corner, it can be in
            // neither for a moment: it's still where it was till then).
            const off = (c) => Math.max(Math.abs(u.pos[0] - (c[0] + 0.5)), Math.abs(u.pos[2] - (c[2] + 0.5)));
            if (off(u.cell) > 0.5 && off(next) <= 0.5) u.cell = next;
          }
        }
      }
      // Feet ease onto the height of the cell they're in (on a ladder, at the climb's pace, facing it).
      const dy = u.cell[1] - u.pos[1], hold = climb && (this.ladders.get(...u.cell) ?? this.ladders.get(u.cell[0], Math.floor(u.pos[1] + 0.5), u.cell[2]));
      const onIt = hold && Math.abs(u.pos[0] - u.cell[0] - 0.5) < 0.1 && Math.abs(u.pos[2] - u.cell[2] - 0.5) < 0.1 && (!this.standable(...u.cell) || Math.abs(dy) > 0.04 || u.path[0]?.[1] > u.cell[1]);
      u.pos[1] += Math.sign(dy) * Math.min(Math.abs(dy), (onIt ? LADDER_TUNING.climbSpeed : dy < -1 ? T.dropSpeed : T.climbSpeed) * dt);
      u.climbing = (u.climbing ?? 0) + ((onIt ? 1 : 0) - (u.climbing ?? 0)) * Math.min(1, dt * 10);
      if (onIt) {
        u.clingDir = [hold.dx, hold.dz];
        const want = Math.atan2(hold.dx, hold.dz);
        u.yaw += ((((want - u.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI)) * Math.min(1, dt * 12);
      }
      u.moving += ((walking ? 1 : 0) - u.moving) * Math.min(1, dt * 8);
      if (walking) {
        // A footstep each half stride; a horse's four hooves each quarter of its trot (see horseParts).
        const was = u.walk, beat = MOUNTS[u.kind] ? Math.PI / 2 / MOUNT_TUNING.gait : Math.PI;
        u.walk += dt * (u.climbing > 0.5 ? LADDER_TUNING.climbSpeed * Math.PI : speed * 2.2); // (on a ladder: a hand and foot a rung)
        if (u.climbing > 0.5) { if (Math.floor(u.walk / beat) !== Math.floor(was / beat)) sfx('placeWood', u.pos, { gain: 0.25 }); }
        else if (Math.floor(u.walk / beat) !== Math.floor(was / beat)) {
          sfx(MOUNTS[u.kind] ? 'hoof' : stepSound(this.terrain, u.cell), u.pos);
          this.onStep?.(u); // (in the snow: it kicks some up, see main.js)
        }
      }
    }
    // Shots land when their flight's over: an arrow or spear in its target, where it sticks (if it's still standing),
    // or in the ground (a miss, or one whose target fell while it flew, which comes down where it stood). A fireball
    // bursts there, or on the first ground it meets on the way.
    for (const a of this.arrows) {
      a.t += dt;
      if (!a.to && (a.target.dying || !this.list.includes(a.target))) {
        a.to = a.what === 'fire' ? this.arrowAt(a, 1) : this.groundBelow(a.target.pos[0], aimBase(a.target) + 1, a.target.pos[2]);
      }
      if (a.what === 'fire') {
        const p = this.arrowAt(a, Math.min(1, a.t / a.time)), c = p.map(Math.floor);
        // The way it's flying (its burst mark lies across that).
        const back = this.arrowAt(a, Math.max(0, Math.min(1, a.t / a.time) - 0.03));
        const v = p.map((x, i) => x - back[i]), vl = Math.hypot(...v), dir = vl > 1e-6 ? v.map((x) => x / vl) : [0, -1, 0];
        if (a.t >= a.time || (this.terrain.solid(...c) && !parapet(a.cell, ...c))) { a.t = a.time = -1; this.explode(p, a.by, dir); }
        continue;
      }
      if (a.t < a.time) continue;
      const tip = this.arrowAt(a, 1), back = this.arrowAt(a, 0.97);
      const d = tip.map((v, i) => v - back[i]), l = Math.hypot(...d) || 1, dir = d.map((v) => v / l);
      const spear = a.what === 'spear';
      if (a.to) {
        if (tip[1] < WATER_LEVEL) splashWater([tip[0], WATER_LEVEL, tip[2]], spear ? 0.5 : 0.25, 10); // (into the sea)
        this.stuck.push({ pos: tip, dir, age: 0, spear }); sfx('arrowLand', tip, { pitch: spear ? 0.7 : 1 }); continue;
      }
      // In the target, kept in its frame: an arrow's tip a little way into it from the side it came from; a spear with
      // its middle in it (and so its head out the other side). The spear's in it before the blow, so that if it falls
      // the spear goes down with it, part of its ragdoll.
      const t = a.target, cy = Math.cos(t.yaw), sy = Math.sin(t.yaw);
      const back0 = spear ? SPEAR_TIP : 0.15;
      const w = [tip[0] - dir[0] * back0 - t.pos[0], tip[1] - dir[1] * back0 - t.pos[1], tip[2] - dir[2] * back0 - t.pos[2]];
      const local = (v) => [cy * v[0] - sy * v[2], v[1], sy * v[0] + cy * v[2]];
      if (t.kind !== 'crystal' && t.kind !== 'wall') t.arrows.push({ pos: local(w), dir: local(dir), age: 0, spear }); // (glancing off a crystal)
      this.hit(t, a.by, a.what);
    }
    this.arrows = this.arrows.filter((a) => a.t < a.time);
    const C = COMBAT_TUNING;
    for (const s of this.stuck) s.age += dt;
    this.stuck = this.stuck.filter((s) => s.age < C.arrowStick);
    for (const b of this.blasts) b.age += dt;
    this.blasts = this.blasts.filter((b) => b.age < BLAST_TIME);
    for (const u of this.list) {
      if (!u.arrows.length) continue;
      for (const s of u.arrows) s.age += dt;
      u.arrows = u.arrows.filter((s) => s.spear || s.age < C.arrowStick); // a spear in it stays till it's gone
    }
    if (this.list.some((u) => u.dying > COMBAT_TUNING.goneAfter)) this.list = this.list.filter((u) => !(u.dying > COMBAT_TUNING.goneAfter));
  }

  // How u stands this frame (for parts): its legs' swings and rolls (right, left), its arms' (left, right, as
  // partMatrix's), its wrists' bends ([about x, about z]); its upper body's twist (to its left), lean (forward) and side
  // tilt (to its left) about its hips; its head's turn (look) and nod; how far it bobs up, how far its legs are split
  // (lunge) and it's stepped forward (step); and what's in its right hand (item, HELD-style boxes) and the frame it's
  // held in (see fistFrame), slid `slide` along it, glowing `glow`. Walking, its upper body leans into it, turns against
  // its stride and tilts over the foot it's on; its arms swing opposite its legs, a little out and across as they come
  // forward, its hands trailing. Each class's moves are in handPose, priestPose, axePose, warriorPose, archerPose and
  // workPose; a blow makes it flinch (u.flinch). Its limbs are kept on u (u.pose), for its ragdoll to start from.
  posture(u, torch) {
    // (A rider sits still in its saddle as its horse trots: no walk in it.)
    const A = ANIM_TUNING, C = COMBAT_TUNING, kind = u.role, mounted = !!MOUNTS[u.kind], moving = mounted ? 0 : u.moving;
    const sw = Math.sin(u.walk) * moving, cw = Math.cos(u.walk) * moving, swing = sw * 0.6, relaxed = -0.12 - 0.15 * moving;
    const P = {
      bob: Math.abs(Math.cos(u.walk)) * 0.06 * moving + Math.sin(u.idle * 2) * 0.01 * (1 - moving),
      twist: sw * A.walkTwist, lean: A.walkLean * moving, side: -cw * A.walkSway, look: null, nod: 0,
      lunge: 0, lungeSide: 1, step: 0, legs: [swing, -swing], legRolls: [0, 0],
      armL: swing * 0.8, armR: -swing * 0.8, rollL: A.armOut + sw * A.armCross, rollR: -A.armOut + sw * A.armCross,
      bendL: [relaxed - cw * A.wristLag, 0], bendR: [relaxed + cw * A.wristLag, 0],
      tool: this.toolOf(u), item: null, frame: null, slide: 0, glow: 0, bow: null,
    };
    // (A worker between voxels keeps its last tool in hand as it eases out of its work.)
    if (P.tool) u.lastTool = P.tool;
    else if (kind === 'worker' && u.workW > 0) P.tool = u.lastTool ?? null;
    if (u.rag) return { ...P, look: 0, bendL: [-0.35, 0], bendR: [-0.35, 0] };
    // Stepping up, it leans into it; dropping, its arms go out (u.lift: how far it's going up or down, eased).
    const rise = Math.max(0, u.lift), drop = Math.max(0, Math.min(1, -1.2 * u.lift - 0.2));
    P.lean += A.climbLean * rise;
    P.armL -= 0.5 * drop; P.armR -= 0.5 * drop; P.rollL += 0.9 * drop; P.rollR -= 0.9 * drop;
    // Both hands on a haft (see twoHands), taking over by twoW; or the right hand's item's own tilt (a spear's, say).
    let two = null, twoW = 0, own = null, free = false;
    if (kind === 'worker') {
      // (Possessed, its right hand alone on the haft, off to its side, out of the middle of the view; see POSSESS_TUNING.)
      const one = u === this.possessed && POSSESS_TUNING.oneHand > 0.5;
      const t = u.task ?? u.ladderTask; // (a rung it's fixing: see Workers.escape)
      if (u.working > 0 && t) {
        const s = Math.min(1, u.working / Math.max(workTime(t), 1e-3));
        if (s < u.workS) { u.workFlip = !u.workFlip; u.workFrom = u.workPose; } // (a new voxel)
        u.workS = s;
        const dy = t.y + 0.5 - (u.pos[1] + 1.36), dh = Math.hypot(t.x + 0.5 - u.pos[0], t.z + 0.5 - u.pos[2]);
        const w = workPose(P.tool, !t.dig, s, Math.max(-1.1, Math.min(0.9, Math.atan2(dy, Math.max(0.6, dh)))), u.workFlip);
        // Each blow eases out of the last one's end (its target may be higher or lower, a backhand's the other side).
        u.workPose = u.workFrom && s < 0.2 ? keyed([[0, u.workFrom], [1, w, 'lin']], ease(s / 0.2)) : w;
      }
      const w = u.workPose, k = w ? ease(u.workW) : 0;
      if (k > 0) {
        P.twist += w.twist * k * A.workLean; P.lean += w.lean * k * A.workLean; P.side += w.side * k * A.workLean;
        P.nod += w.nod * k; P.lunge = w.lunge * k; P.lungeSide = -1;
        if (w.two) { if (P.tool) { two = twoHands(w.phi, w.tool, one ? POSSESS_TUNING.oneHandSide : 0); twoW = k; free = one; } }
        else {
          P.armR = lerp(P.armR, w.arm, k); P.rollR = lerp(P.rollR, w.roll, k); P.bendR = [lerp(P.bendR[0], w.wrist, k), 0];
          P.armL = lerp(P.armL, w.left, w.leftW * k); P.rollL = lerp(P.rollL, w.leftRoll, w.leftW * k);
        }
      }
      if (P.tool) P.item = HELD[P.tool];
      // Carrying a load (and not at work): both arms out in front under it, leaning back.
      const cw = u.carry ? 1 - k : 0;
      if (cw > 0) {
        const C = CARRY_LOOK;
        P.armL = lerp(P.armL, -C.arm, cw); P.armR = lerp(P.armR, -C.arm, cw);
        P.rollL = lerp(P.rollL, 0, cw); P.rollR = lerp(P.rollR, 0, cw);
        P.bendL = [lerp(P.bendL[0], 0.25, cw), 0]; P.bendR = [lerp(P.bendR[0], 0.25, cw), 0];
        P.lean -= C.lean * cw;
        if (cw > 0.5) { P.carry = u.carry; P.item = null; }
      }
      // Up a ladder: hands up on the rungs and feet on them, each pair going up in turn, its body upright.
      const cl = Math.min(1, u.climbing ?? 0) * (1 - k);
      if (cl > 0) {
        const s = Math.sin(u.walk) * u.moving;
        P.armL = lerp(P.armL, -2.5 + 0.35 * s, cl); P.armR = lerp(P.armR, -2.5 - 0.35 * s, cl);
        P.rollL = lerp(P.rollL, 0.12, cl); P.rollR = lerp(P.rollR, -0.12, cl);
        P.bendL = [lerp(P.bendL[0], 0.2, cl), 0]; P.bendR = [lerp(P.bendR[0], 0.2, cl), 0];
        P.legs = [lerp(P.legs[0], -0.45 - 0.45 * s, cl), lerp(P.legs[1], -0.45 + 0.45 * s, cl)];
        P.lean *= 1 - cl; P.side *= 1 - cl; P.twist *= 1 - cl; P.bob *= 1 - cl;
        if (cl > 0.5) { P.carry = null; P.item = null; }
      }
    } else if (kind === 'warrior') {
      if (u.target) {
        const s = warriorPose(u.striking ? u.swing / C.attackTime : null, u.backhand);
        P.armR = s.arm; P.rollR = s.roll; P.bendR = [s.wrist, 0]; P.armL = s.left; P.rollL = s.leftRoll;
        P.twist += s.twist; P.lunge = s.lunge; P.step = C.lunge; P.lean += 0.1 * s.lunge;
      }
      P.item = HELD.sword;
    } else if (kind === 'archer') {
      if (u.striking) {
        // Shooting, it stands side-on, its left to its target (see shoot), its head turned to it, its bow arm straight
        // out that way and its drawing arm going through archerPose; its legs apart and leaning back off its target.
        const b = P.bow = archerPose(u.swing / C.shootTime, Math.max(0, 1 - (this.time - (u.loosed ?? -9)) / 0.25));
        const d = aimArm(b.dir, true);
        P.armR = d.arm; P.rollR = d.roll; P.armL = 0; P.rollL = Math.PI / 2 - b.drop; P.bendL = [0, 0]; P.bendR = [0, 0];
        P.side -= 0.04 + 0.04 * b.draw; P.legRolls = [-0.12, 0.18]; P.look = Math.PI / 2;
      } else { P.armL = -0.35 + swing * 0.2; P.rollL = A.armOut; } // (its bow held low ahead)
    } else if (kind === 'spearman' || kind === 'mage') {
      const s = u.striking ? u.swing / C[RANGED[kind].time] : null, h = handPose(kind, s, sw, moving);
      P.armR = h.arm; P.rollR = h.roll; P.armL = lerp(P.armL, h.left, h.leftW); P.rollL = lerp(P.rollL, h.leftRoll, h.leftW);
      P.lean += h.lean * A.castLean; P.lunge = h.lunge; P.lungeSide = -1;
      if (kind === 'spearman') P.twist += throwTwist(s);
      else {
        P.bob += 0.04 * h.float * (0.6 + 0.4 * Math.sin(u.idle * 6));
        if (h.reach > 0) {
          // Its left hand reaching for the orb, circling it.
          const along = h.slide + STAFF_ORB, c = 0.1 * h.float, d = [-0.74 + c * Math.cos(u.idle * 7),
            -0.58 * Math.cos(h.arm) - Math.sin(h.ang) * along + c * Math.sin(u.idle * 7), -0.58 * Math.sin(h.arm) + Math.cos(h.ang) * along];
          const a = aimArm(d);
          P.armL = lerp(P.armL, a.arm, h.reach); P.rollL = lerp(P.rollL, a.roll, h.reach);
        }
      }
      if (h.held) { P.item = kind === 'mage' ? STAFF : SPEAR; own = h.ang; P.slide = h.slide; P.glow = h.glow ?? 0; }
    } else if (kind === 'priest') {
      const h = priestPose(u, sw, moving);
      P.armR = h.arm; P.rollR = h.roll; P.armL = lerp(P.armL, h.left, h.leftW); P.rollL = lerp(P.rollL, h.leftRoll, h.leftW);
      P.lean += h.lean * A.castLean; P.nod += h.nod; P.bob += h.rise; P.lunge = h.lunge; P.lungeSide = -1;
      P.item = ANKH_STAFF; own = h.ang; P.slide = h.slide; P.glow = h.glow;
    } else if (kind === 'barbarian') {
      const a = axePose(u, sw);
      P.armR = a.arm; P.rollR = a.roll; P.armL = lerp(P.armL, a.left, a.leftW); P.rollL = lerp(P.rollL, a.leftRoll, a.leftW);
      P.twist += a.twist; P.lean += a.lean; P.side += a.side; P.lunge = a.lunge; P.lungeSide = -1; P.legRolls = [-a.splay, a.splay];
      if (a.look !== null) P.look = a.look;
      // Staggering after a whirl.
      const dz = u.dizzy / Math.max(A.dizzy, 1e-3), t = this.time;
      if (dz > 0) { P.side += 0.12 * Math.sin(t * 7) * dz; P.lean += 0.06 * Math.sin(t * 5) * dz; P.nod += 0.15 * Math.sin(t * 6) * dz; }
      P.item = BATTLEAXE; own = a.ang;
      if (a.ready > 0) { two = twoHands(-0.2, 0.85); twoW = a.ready; }
    }
    // At night, a torch held up in front in its left hand (an archer has its bow there). Carrying a load, it keeps its
    // arm under the load, the torch still in that fist, sticking out from the wrist (tilted forward with the arm).
    const lit = torch > 0 && kind !== 'archer' && !P.carry && !(u.climbing > 0.5);
    if (lit) { P.armL = -Math.PI / 2; P.rollL = 0; }
    // Flinching from a blow: its upper body thrown the way it was knocked (and turned from it), its head lagging, its
    // arms jerking out (unless they're busy).
    if (u.flinch) {
      const f = u.flinch, x = f.t / Math.max(A.flinchTime, 1e-3), k = f.k * (x < 0.15 ? ease(x / 0.15) : 1 - ease((x - 0.15) / 0.85));
      const cy = Math.cos(u.yaw), sy = Math.sin(u.yaw), lx = cy * f.dir[0] - sy * f.dir[1], lz = sy * f.dir[0] + cy * f.dir[1];
      P.lean += lz * A.flinch * k; P.side += lx * A.flinch * k; P.twist -= lx * 0.5 * A.flinch * k; P.nod -= lz * 0.6 * A.flinch * k;
      if (!u.striking && !(u.working > 0)) { P.rollL += A.flinchArms * k; P.rollR -= A.flinchArms * k; P.armL -= 0.3 * k; P.armR -= 0.3 * k; }
    }
    // Its legs split into a lunge (unless it's walking), the leading one forward and the other back, its hips lower.
    P.lunge *= 1 - moving;
    P.step *= P.lunge;
    P.bob -= 0.06 * P.lunge;
    const split = 0.4 * P.lunge * P.lungeSide;
    P.legs = [P.legs[0] - split, P.legs[1] + split];
    // What's in its right hand, held in its fist (turned at the wrist) or its own way (own), or in both hands (two).
    P.bendR = wristCone(P.bendR);
    if (P.item) {
      const along = P.item === HELD.sword || P.item === HELD.shovel; // (along the arm from the fist; the rest across it)
      let F = own !== null ? ownFrame(-0.37, P.armR, P.rollR, own) : fistFrame(-0.37, P.armR, P.rollR, P.bendR);
      if (two) {
        F = blendFrame(F, along ? turnAlong(two.frame) : two.frame, twoW);
        P.armR = lerp(P.armR, two.right.arm, twoW); P.rollR = lerp(P.rollR, two.right.roll, twoW);
        if (!lit && !free) { P.armL = lerp(P.armL, two.left.arm, twoW); P.rollL = lerp(P.rollL, two.left.roll, twoW); }
      }
      P.frame = F;
      // Its hands turned at the wrist to hold it.
      const axis = along ? F.y.map((v) => -v) : F.z;
      if (two || own !== null) P.bendR = wristCone(bendTo(P.armR, P.rollR, axis, along));
      if (two && !lit && !free) { const b = bendTo(P.armL, P.rollL, axis, along); P.bendL = [lerp(P.bendL[0], b[0], twoW), lerp(P.bendL[1], b[1], twoW)]; }
    }
    P.bendL = wristCone(P.bendL);
    // Its head turned back most of the way from its body's twist, to keep its eyes ahead (or on its target); idle, it
    // looks about now and then.
    if (P.look === null) P.look = Math.sin(u.idle * 0.7) * 0.35 * (1 - moving) * (Math.sin(u.idle * 0.23) > 0.3 ? 1 : 0);
    P.look -= P.twist * 0.7;
    // Mounted: sitting in the saddle with its legs round the horse, bobbing with its trot (see horse.js).
    if (mounted) {
      const M = MOUNT_TUNING;
      P.legs = [M.legPitch, M.legPitch]; P.legRolls = [-M.legSplay, M.legSplay]; P.lunge = 0; P.step = 0;
      P.bob = horseBob(u.walk * M.gait, u.moving);
    }
    this.settle(u, P);
    u.pose = { angles: [P.legs[0], P.legs[1], P.armL, P.armR], rolls: [P.legRolls[0], P.legRolls[1], P.rollL, P.rollR] };
    return P;
  }

  // Eases u over sudden changes of pose (P, from posture): when what it's doing changes (a new target, starting or
  // stopping a swing or a whirl, raising a bow), or its arms jump further than any move swings them, the difference
  // between the pose it was last drawn in and the new one is kept and faded out over ANIM_TUNING.settle seconds, so it
  // goes on moving as the new pose does while it eases into it.
  settle(u, P) {
    const mode = `${u.target?.id ?? 0} ${u.striking} ${u.whirling} ${!!P.bow}`, f = u.shown, was = u.raw;
    const dir = (arm, roll) => armRot([0, -1, 0], arm, roll);
    const jump = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
    if (f && this.time > f.time) {
      const far = 60 * (this.time - f.time); // (more than any move swings an arm in a 60th of a second, in radians)
      // (Its arms' jump is the new pose's from the last one's before easing: from the eased one, any quick move made
      // while easing would look like a jump, and it would never stop easing.)
      if (mode !== f.mode || jump(dir(was.armL, was.rollL), dir(P.armL, P.rollL)) > far || jump(dir(was.armR, was.rollR), dir(P.armR, P.rollR)) > far) {
        const off = { at: this.time, look: wrapAngle(f.look - P.look) };
        for (const key of ['twist', 'lean', 'side', 'nod', 'bob', 'step']) off[key] = f[key] - P[key];
        off.legs = P.legs.map((v, i) => f.legs[i] - v); off.legRolls = P.legRolls.map((v, i) => f.legRolls[i] - v);
        for (const [arm, roll, bend] of [['armL', 'rollL', 'bendL'], ['armR', 'rollR', 'bendR']]) {
          // (From the way of swinging and rolling to where the arm was that's nearest the new one: the other way
          // round, the hand's turned half round too, so its bend's the other way.)
          const near = (a) => Math.abs(a.arm - P[arm]) + Math.abs(wrapAngle(a.roll - P[roll]));
          const same = { arm: f[arm], roll: f[roll] }, other = aimArm(dir(f[arm], f[roll]), f[arm] > -Math.PI / 2);
          const flip = near(other) < near(same), a = flip ? other : same, b = flip ? f[bend].map((v) => -v) : f[bend];
          off[arm] = a.arm - P[arm]; off[roll] = wrapAngle(a.roll - P[roll]); off[bend] = [b[0] - P[bend][0], b[1] - P[bend][1]];
        }
        // What's in its hand: how far it's moved, and its turn (axis and angle) from the new frame to the old.
        if (f.frame && P.frame && f.item === P.item) {
          const F = f.frame, T = P.frame, R = (i, j) => F.x[i] * T.x[j] + F.y[i] * T.y[j] + F.z[i] * T.z[j];
          const angle = Math.acos(Math.max(-1, Math.min(1, (R(0, 0) + R(1, 1) + R(2, 2) - 1) / 2)));
          const axis = unit3([R(2, 1) - R(1, 2), R(0, 2) - R(2, 0), R(1, 0) - R(0, 1)]);
          off.frame = { o: F.o.map((v, i) => v - T.o[i]), axis, angle: Math.sin(angle) > 1e-4 ? angle : 0 };
        }
        u.settling = off;
      }
    }
    u.raw = { armL: P.armL, rollL: P.rollL, armR: P.armR, rollR: P.rollR };
    const S = u.settling, k = S ? (this.time - S.at) / Math.max(ANIM_TUNING.settle, 1e-3) : 1;
    if (k >= 1) u.settling = null;
    else {
      const r = 1 - ease(Math.max(0, k)); // (how much of the difference is left)
      for (const key of ['twist', 'lean', 'side', 'nod', 'bob', 'step', 'look', 'armL', 'rollL', 'armR', 'rollR']) P[key] += S[key] * r;
      P.legs = P.legs.map((v, i) => v + S.legs[i] * r); P.legRolls = P.legRolls.map((v, i) => v + S.legRolls[i] * r);
      P.bendL = P.bendL.map((v, i) => v + S.bendL[i] * r); P.bendR = P.bendR.map((v, i) => v + S.bendR[i] * r);
      if (S.frame && P.frame) {
        const { axis, angle } = S.frame, a = angle * r, c = Math.cos(a), sn = Math.sin(a);
        // (Rodrigues: v turned by a about axis.)
        const turn = (v) => { const d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2], x = cross3(axis, v); return v.map((w, i) => w * c + x[i] * sn + axis[i] * d * (1 - c)); };
        P.frame = { o: P.frame.o.map((v, i) => v + S.frame.o[i] * r), x: turn(P.frame.x), y: turn(P.frame.y), z: turn(P.frame.z) };
      }
    }
    u.shown = { ...P, legs: P.legs.slice(), legRolls: P.legRolls.slice(), mode, time: this.time };
  }

  // Boxes to draw: per part a model matrix (column-major), a colour and whether it glows (emit). `torch` (0-1) is how
  // lit the torches are; each lit torch's flame goes in this.torches as [x, y, z, brightness 0-1].
  parts(torch = 0) {
    const out = [];
    this.torches = [];
    this.sweeps = [];
    this.lit = torch;
    const flame = linearColor(TORCH_TUNING.color).map((c) => c * 1.6 + 0.15);
    const ankhs = new Map(); // each priest's ankh loop: which of out's parts it is (its beam starts there)
    // The possessed unit (main.js looks out from its eyes): its head's place and way, and its head (or, hideBody, all
    // of it) left out so it's not in the way.
    this.eyeFrame = null;
    for (const u of this.list) {
      if (u.hidden || u.kind === 'crystal' || u.kind === 'wall') continue; // (where the player can't see it, see fog.js; crystals.js draws crystals; a wall's terrain)
      const first = out.length;
      const ground = this.drawHeight(u), feet = ground + mountLift(u); // (a rider's up in its saddle)
      // How it stands this frame: its limbs, upper body and head, and what's in its hands (see posture).
      const P = this.posture(u, torch), bob = P.bob, look = P.look;
      const { armL, armR, rollL, rollR, bow } = P;
      const archer = u.role === 'archer', warrior = u.role === 'warrior', mage = u.role === 'mage', L = LOOK_TUNING;
      const bodyB = L.bodyType >= 0 ? L.bodyType >= 0.5 : u.bodyB;
      const priest = u.role === 'priest', barbarian = u.role === 'barbarian';
      // Dressed like Populous II's followers: a toga in the team's colour, draped over the left shoulder and falling
      // to the knee, bare arms and legs, and laced sandals.
      const tone = lookPick('skin', u.skin ?? 1, SKIN_TONES), skin = lookColour('skin', tone);
      const eye = tone === SKIN_TONES - 1 ? lookColour('darkEyes', '') : [0.08, 0.08, 0.1], leather = LEATHER;
      const toga = TEAMS[u.team].toga, fold = toga.map((c) => c * 0.72); // the drape's shaded folds
      const plume = plumeOf(u.team);
      const lost = (kind) => rag?.items.some((it) => it.kind === kind);   // a fallen warrior's kit that's come off
      // [pivot height, pivot x, swing angle, box centre relative to pivot, box size, colour]
      const flash = Math.min(1, u.hurt / Math.max(HIT_TUNING.flash, 1e-3)) * HIT_TUNING.flashStrength; // white, from a blow
      // A fallen villager's parts go where its ragdoll is: the body's, or hung from a hinge, or on the head.
      const rag = u.rag;
      // Its parts are posed in its own frame (feet at 0, facing +z) and placed in the world (W). Those above its hips
      // (upper) turn with its upper body's twist (tw), and lean and tilt with it about its hips (S, see spineMatrix).
      let tw = 0, upper = false;
      const W = worldMatrix(u, feet), S = !rag && (P.lean || P.side) ? mul4(W, spineMatrix(0.75 + bob, P.lean, P.side)) : null;
      const pose = (py, px, ang, c, s, yawOff = 0, roll = 0) => upper && S
        ? mul4(S, partMatrix(ORIGIN, 0, py + bob, px, ang, c, s, yawOff + tw, roll))
        : partMatrix(u, feet, py + bob, px, ang, c, s, yawOff + tw, roll);
      // A matrix in its upper body's own frame (from its feet, before its twist), placed.
      const placed = (m) => mul4(mul4(upper && S ? S : W, liftTurn(bob, tw)), m);
      const push = (m, col, emit = 0, form = null) => {
        out.push({ m, col: flash ? col.map((v) => v + (1 - v) * flash) : col, emit: flash ? Math.max(emit, flash) : emit, shape: form?.shape });
        // A tapered box (form.taper [x, z]: see units-render.js) carries its taper in its matrix's spare bottom row.
        if (form?.taper) { m[3] = form.taper[0]; m[7] = form.taper[1]; }
      };
      // form: a box's tilt and shape (see CONE).
      const p = (py, px, ang, c, s, col, yawOff = 0, emit = 0, form = null, roll = 0) => {
        const tilt = form?.tilt ?? 0;
        push(rag ? rag.matrix(px, py, c, s, HINGE[`${py},${px}`] ?? null, py === NECK, tilt, roll)
          : pose(py, px, ang + tilt, tilt ? rotX(c, -tilt) : c, s, yawOff, roll), col, emit, form);
      };
      for (const [side, i] of [[-1, 0], [1, 1]]) {
        const px = 0.14 * side, ang = P.legs[i], roll = P.legRolls[i];
        // (Body type B's legs a little slimmer and closer together, inside its narrower skirt top.)
        const lx = bodyB ? -0.025 * side : 0;
        p(0.75, px, ang, [lx, -0.36, 0], [bodyB ? 0.19 : 0.22, 0.72, 0.26], skin, 0, 0, null, roll); // legs (ending inside the soles)
        // The toga's skirt (a barbarian's shorts), half to a leg, flaring out from the waist. Where the halves overlap,
        // the left's a little deeper and lower, so their faces never share a plane (no z-fighting).
        if (bodyB) {
          const w = tapered(L.hem, L.hipTop), d = tapered(L.hemDepth + 0.01 * side, L.topDepth + 0.01 * side);
          p(0.75, px, ang, [-(0.01 + L.skirtIn) * side, -0.17 - 0.005 * side, 0], [w.s, 0.42, d.s], toga, 0, 0, { taper: [w.t, d.t] }, roll);
        }
        else p(0.75, px, ang, [-0.01 * side, -0.17 - 0.005 * side, 0], [0.33, 0.42, 0.37 + 0.01 * side], toga, 0, 0, SKIRT_FLARE, roll);
        if (rag?.items.some((it) => it.leg === HINGE[`0.75,${px}`])) continue;         // its sandal (or boot)'s come off
        // (Body type B's narrower, so the two feet's never overlap: see B_FEET.)
        (warrior ? BOOT : SANDAL).forEach(([c, s, col], j) => p(0.75, px, ang, [c[0] + lx, c[1], c[2]],
          bodyB ? [B_FEET[warrior ? 'boot' : 'sandal'][j], s[1], s[2]] : s, col, 0, 0, null, roll));
      }
      tw = P.twist;
      upper = true;
      // The body tapers from the shoulders to the waist (ending just above the hips).
      if (bodyB) {
        // Body type B: from the waist out to under the bust, then back in to the shoulders (see LOOK_TUNING), and no
        // drape across it (Jordan: so the shape shows). A barbarian's is bare, with its belt and a leather band round
        // its chest, straps from it over its shoulders.
        const ub = Math.min(1.36, Math.max(0.85, L.underBust)), lo = ub - 0.77, hi = 1.41 - ub;
        const lw = tapered(L.waistWidth, L.chestWidth), ld = tapered(L.waistDepth, L.bustDepth);
        const uw = tapered(L.chestWidth, L.shoulderWidth), ud = tapered(L.bustDepth, L.shoulderDepth);
        const body = barbarian ? skin : toga;
        p(0.75, 0, 0, [0, 0.02 + lo / 2, 0], [lw.s, lo, ld.s], body, 0, 0, { taper: [lw.t, ld.t] });
        p(0.75, 0, 0, [0, ub - 0.75 + hi / 2, 0], [uw.s, hi, ud.s], body, 0, 0, { taper: [uw.t, ud.t] });
        if (barbarian) {
          // Its body's width and depth at height h (from the feet).
          const at = (h, a, b, c) => h < ub ? lerp(a, b, (h - 0.77) / lo) : lerp(b, c, (h - ub) / hi);
          const wAt = (h) => at(h, L.waistWidth, L.chestWidth, L.shoulderWidth), dAt = (h) => at(h, L.waistDepth, L.bustDepth, L.shoulderDepth);
          // The belt, round its waist and the top of its shorts.
          const skirt = (k) => L.hipTop + (L.hem - L.hipTop) * k;
          const bw = 2 * Math.max(L.waistWidth / 2, 0.13 - L.skirtIn + skirt(0.15) / 2) + 0.04;
          const bd = Math.max(L.waistDepth, L.topDepth + 0.01 + (L.hemDepth - L.topDepth) * 0.15) + 0.05;
          p(0.75, 0, 0, [0, 0.03, 0], [bw, 0.1, bd], DARK_LEATHER);
          p(0.75, 0, 0, [0, 0.03, bd / 2 + 0.01], [0.12, 0.08, 0.02], IRON);          // its buckle
          if (L.harness) {
            const b0 = Math.min(1.02, ub - 0.05), b1 = Math.min(1.36, Math.max(1.28, ub + 0.06));
            const seam = ub + 0.012; // (its two parts meet a little above the body's, so their faces never share a plane)
            for (const [y0, y1] of [[b0, seam], [seam, b1]]) {
              const w = tapered(wAt(y0) + 0.015, wAt(y1) + 0.015), d = tapered(dAt(y0) + 0.03, dAt(y1) + 0.03);
              p(0.75, 0, 0, [0, (y0 + y1) / 2 - 0.75, 0], [w.s, y1 - y0, d.s], LEATHER, 0, 0, { taper: [w.t, d.t] });
            }
            const front = dAt(ub) / 2 + 0.015;
            p(ub, 0, 0, [0, 0, front + 0.015], [0.13, 0.13, 0.03], IRON);           // its boss
            p(ub, 0, 0, [0, 0, front + 0.04], [0.06, 0.06, 0.02], STEEL);
            for (const sx of [-0.17, 0.17]) {
              // Straps from the band up over its shoulders, front and back, lying on its chest and back.
              const zb = dAt(b1) / 2 + 0.005, zt = L.shoulderDepth / 2 + 0.005, dy = 1.415 - b1;
              for (const k of [1, -1]) {
                const tilt = Math.atan2(k * (zt - zb), dy), len = Math.hypot(dy, zt - zb);
                p((b1 + 1.415) / 2, sx, 0, [0, 0, k * (zb + zt) / 2], [0.08, len + 0.02, 0.03], LEATHER, 0, 0, { tilt });
              }
              p(1.42, sx, 0, [0, 0, 0], [0.1, 0.04, L.shoulderDepth + 0.07], LEATHER);  // over the shoulder
            }
          }
        }
      } else if (barbarian) {
        // A barbarian's bare chest, with its kilt's belt round the top of its shorts.
        p(0.75, 0, 0, [0, 0.34, 0], [0.51, 0.64, 0.34], skin, 0, 0, TORSO_TAPER);
        p(0.75, 0, 0, [0, 0.03, 0], [0.56, 0.1, 0.41], DARK_LEATHER);
        p(0.75, 0, 0, [0, 0.03, 0.21], [0.12, 0.08, 0.02], IRON);                    // its buckle
        if (LOOK_TUNING.harness) for (const [px, py, c, s, col, roll] of HARNESS) p(py, px, 0, c, s, col, 0, 0, null, roll);
      } else {
        p(0.75, 0, 0, [0, 0.34, 0], [0.49, 0.64, 0.34], toga, 0, 0, TORSO_TAPER);     // toga: body
        // The drape over the left shoulder, wrapping that side of the body: one piece, narrow at the shoulder and
        // widening down to the waist, leaning in towards the middle (in front of the skirt).
        const sw = tapered(L.sashBottom, L.sashTop);
        p(1.09, 0.165, 0, [0, 0, 0], [sw.s, 0.7, 0.4], fold, 0, 0, { taper: [sw.t, 0] }, L.sashLean);
      }
      if (!rag?.popped) p(0.75, 0, 0, [0, 0.705, 0], [0.2, 0.15, 0.2], skin);        // a neck, up into the head
      // Arms tapering to the wrist, and a hand on a ball joint there: bent (b about x, r about z) within the wrist's
      // cone, round the fist.
      const armsAt = out.length;
      for (const [px, arm, roll, bend] of [[0.37, armL, rollL, P.bendL], [-0.37, armR, rollR, P.bendR]]) {
        p(1.36, px, arm, [0, -0.225, 0], [0.17, 0.51, 0.2], skin, 0, 0, ARM_TAPER, roll);
        p(1.36, px, arm, [0, -0.54, 0], [1, 1, 1], skin, 0, 0, null, roll);
        const h = out[out.length - 1];
        h.m = mul4(h.m, wristLocal(bend[0], bend[1], HAND));
      }
      if (!barbarian) p(1.36, 0.37, armL, [0, -0.08, 0], [0.24, 0.28, 0.26], fold, 0, 0, null, rollL); // the drape's sleeve
      // What it's carrying, in its arms (see CARRY_LOOK).
      if (P.carry && !rag) for (const [c, s, col] of loadBoxes(P.carry.block, P.carry.n)) p(0.75, 0, 0, [c[0], CARRY_LOOK.height - 0.75 + c[1], CARRY_LOOK.out + c[2]], s, col);
      if (warrior && !lost('pauldron')) for (const [c, s, col] of PAULDRON) p(1.36, -0.37, armR, c, s, col, 0, 0, null, rollR);
      // A quiver on its back (body type B's further back, off its fuller chest's back).
      const qz = bodyB ? Math.max(0, L.bustDepth / 2 - 0.11) : 0;
      if (archer) for (const [c, s, col] of QUIVER) p(0.75, 0, -0.15, [c[0], c[1], c[2] - qz], s, col);
      // A control group's banner (the first of them, if it carries more than one).
      u.bannerBox = null;
      if (u.banners?.length && !rag && u !== this.possessed) {
        const B = BANNER_TUNING, z = -B.back - qz, x = archer ? -0.12 : 0;
        const fy = B.poleTop - B.flagDrop - B.flagHeight / 2 - 0.75; // the flag's middle, from the hips
        p(0.75, 0, 0, [x, (0.95 + B.poleTop) / 2 - 0.75, z], [0.07, B.poleTop - 0.95, 0.04], POLE_WOOD); // (inside the flag)
        p(0.75, 0, 0, [x, B.poleTop - 0.75 + 0.04, z], [0.12, 0.1, 0.12], BANNER_KNOB);
        const point = Math.max(0, B.flagPoint), fh = B.flagHeight + point; // (the flag and its point one part)
        p(0.75, 0, 0, [x, fy - point / 2, z], [B.flagWidth, fh, 0.05], toga, 0, 0, { shape: bannerShape(point / Math.max(fh, 1e-3)) });
        u.bannerBox = out[out.length - 1].m;
        const glyph = DIGITS[u.banners[0] % 10], d = B.digitPixel, ink = toga.map((c) => Math.min(1, c * B.bright + 0.25));
        for (let r = 0; r < 5; r++) {
          for (let c = 0; c < 3; c++) {
            if (glyph[r * 3 + c] !== '1') continue;
            const y = fy + (2 - r) * d;
            // (Read the right way round from in front, and from behind.)
            p(0.75, 0, 0, [x + (c - 1) * d, y, z + 0.03], [d, d, 0.02], ink);
            p(0.75, 0, 0, [x - (c - 1) * d, y, z - 0.03], [d, d, 0.02], ink);
          }
        }
      }
      // What's in its right hand (a worker's tool, a sword, spear, staff or axe), in the frame it's held in (see
      // posture); the bow, or a torch at night, in its left. A fallen villager has dropped them (they're the ragdoll's).
      const T = TORCH_TUNING, k = u.idle * 9 + u.id * 7.3;
      const flick = torch * (1 - T.flicker * (0.5 + 0.3 * Math.sin(k) + 0.2 * Math.sin(k * 2.7 + 1.3)));
      // Boxes held in frame F (see fistFrame), `along` further along its z (a spear or staff slid through the fist); a
      // colour of null is a torch's flame, or (glow) a staff's orb or the ankh.
      const hold = (parts, F, along = 0, glow = null) => {
        const f = frameMatrix(F);
        for (const [c, s, col] of parts) {
          push(placed(mul4(f, boxAt([c[0], c[1], c[2] + along], s))), col ?? glow?.col ?? flame, col ? 0 : glow ? glow.emit : torch);
          if (col) continue;
          if (priest) { if (!ankhs.has(u)) ankhs.set(u, []); ankhs.get(u).push(out.length - 1); }
          const m = out[out.length - 1].m;
          if (!glow) this.torches.push([m[12], m[13] + 0.1, m[14], flick]);
          else if (glow.light) this.torches.push([m[12], m[13], m[14], glow.emit * 0.8]);
        }
      };
      if (!rag) {
        if (P.item) hold(P.item, P.frame, P.slide, mage ? { col: ORB, emit: P.glow, light: true } : priest ? { col: ANKH_GOLD, emit: P.glow } : null);
        if (barbarian) {
          // Whirling, its blade sweeps a ring round it at the fist's height (fading in as the axe comes level).
          const k = Math.max(0, (u.whirl - 0.5) * 2);
          if (k > 0) this.sweeps.push({ centre: [u.pos[0], feet + 1.36 + bob, u.pos[2]], angle: u.yaw + AXE_SWEEP.angle, inner: AXE_SWEEP.inner, outer: AXE_SWEEP.outer, strength: ease(k) });
        }
        if (bow) {
          // The bow out to its left, its string in two from the tips to the drawing hand (or straight, before it's
          // drawn), with an arrow nocked there pointing along it (or one in the drawing hand, from the quiver).
          hold(sideBow(bow.draw), fistFrame(0.37, armL, rollL));
          const tip = BOW_TIP(bow.draw), at = (c, px, arm, roll) => pose(1.36, px, arm, c, [1, 1, 1], 0, roll).slice(12, 15);
          const top = at([tip[0], tip[1] - 0.58, 0], 0.37, armL, rollL), bottom = at([-tip[0], tip[1] - 0.58, 0], 0.37, armL, rollL);
          const rest = at([0, tip[1] - 0.58, 0], 0.37, armL, rollL), fist = at([0, -0.58, 0.04], -0.37, armR, rollR);
          const nock = rest.map((v, i) => v + (fist[i] - v) * ease(bow.draw));
          out.push(strand(top, nock, 0.02, STRING), strand(bottom, nock, 0.02, STRING));
          if (bow.nocked) {
            const grip = at([0, -0.58, 0], 0.37, armL, rollL), dir = grip.map((v, i) => v - nock[i]), l = Math.hypot(...dir) || 1;
            out.push(...arrowParts(nock.map((v, i) => v + dir[i] / l * 0.8), dir, 0));
          }
          if (bow.inHand) {
            const wrist = at([0, -0.3, 0], -0.37, armR, rollR), dir = fist.map((v, i) => v - wrist[i]), l = Math.hypot(...dir) || 1;
            out.push(...arrowParts(fist.map((v, i) => v + dir[i] / l * 0.55), dir, 0));
          }
        } else if (archer) hold(bowParts(0), fistFrame(0.37, armL, rollL, P.bendL));
        else if (torch > 0) hold(HELD.torch, fistFrame(0.37, armL, rollL, P.bendL));
      } else {
        for (const it of rag.items) {
          for (const [c, s, col, glow, form] of it.parts) {
            out.push({ m: it.body.matrix(c, form?.tilt ?? 0, s), col: col ?? flame, emit: glow ?? (col ? 0 : torch), shape: form?.shape });
            if (!col && torch > 0) { const m = out[out.length - 1].m; this.torches.push([m[12], m[13] + 0.1, m[14], flick]); }
          }
        }
      }
      const armsEnd = out.length;
      // Arrows stuck in it, moving with it (or its ragdoll's body): those above its hips with its upper body.
      if (u.arrows.length) {
        const low = rag ? rag.matrix(0, 0, [0, 0, 0], [1, 1, 1]) : partMatrix(u, feet, 0, 0, 0, [0, 0, 0], [1, 1, 1], 0);
        const high = rag ? low : placed(boxAt([0, 0, 0], [1, 1, 1]));
        for (const s of u.arrows) {
          const frame = s.pos[1] > 0.75 ? high : low;
          for (const part of s.spear ? spearParts(s.pos, s.dir) : arrowParts(s.pos, s.dir)) { part.m = mul4(frame, part.m); out.push(part); }
        }
      }
      // The head turns (look) and nods (see posture).
      // (It sits HEAD_LIFT up on its neck.)
      const ph = (px, c, s, col, form) => p(NECK, px, P.nod, [c[0], c[1] + HEAD_LIFT, c[2]], s, col, look, 0, form);
      const headAt = out.length;
      // Its head (body type B's a little narrower at the chin: one box, tapered, as wide as A's at the top).
      const jaw = bodyB ? tapered(Math.min(0.5, L.chin), 0.5) : null;
      if (jaw) ph(0, [0, 0.29, 0], [jaw.s, 0.5, 0.5], skin, { taper: [jaw.t, 0] });
      else ph(0, [0, 0.29, 0], [0.5, 0.5, 0.5], skin);
      const gear = warrior && !lost('helmet') ? 'helmet' : mage && !lost('hat') ? 'hat'
        : u.role === 'spearman' && !lost('helmet') ? 'valkyrie' : priest ? 'hood' : barbarian ? 'band' : 'bare';
      if (gear === 'helmet') for (const [c, s, col] of HELMET) ph(0, c, s, col ?? plume); // a helmet over its hair
      else if (gear === 'hat') for (const [c, s, col, , form] of hatOf(u.team)) ph(0, c, s, col, form); // a wizard's hat
      else if (gear === 'valkyrie') for (const [c, s, col, , form] of VALKYRIE) ph(0, c, s, col, form); // winged helmet
      else if (gear === 'hood') for (const [c, s, col, , form] of hoodOf(u.team)) ph(0, c, s, col, form); // a monk's hood
      // Its hair: what of it shows under what it has on its head (see hairParts).
      const style = LOOK_TUNING.hairStyle >= 0 ? Math.min(HAIRSTYLES.length - 1, Math.round(LOOK_TUNING.hairStyle)) : u.hairStyle ?? 1;
      const hair = lookColour('hair', hairFor(u, tone));
      for (const [c, s, shade] of hairParts(style, gear, HAIR_FLOOR[u.role])) ph(0, c, s, shade === 1 ? hair : hair.map((v) => v * shade));
      if (barbarian) for (const [c, s, col] of headbandOf(u.team, bandOf(style))) ph(0, c, s, col); // a headband round it
      // Eyes: shut from the top down to their bottom edge as it blinks or winces; a dead one's are crosses of 5 small squares, about as big.
      for (const ex of [-0.11, 0.11]) {
        if (u.dying) {
          const w = EYE_TUNING.cross;
          for (const [dx, dy] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) ph(ex, [dx * w, 0.32 + dy * w, 0.251], [w, w, 0.02], eye);
        } else {
          // Wincing, each turns in about its middle (rolled at the neck, its centre turned back to stay put).
          const h = 0.08 * eyeOpen(u), y = 0.28 + h / 2 + HEAD_LIFT;
          const r = Math.sign(ex) * winceOf(u) * EYE_TUNING.winceTilt * Math.PI / 180;
          p(NECK, ex, P.nod, [Math.sin(r) * y, Math.cos(r) * y, 0.251], [0.08, h, 0.02], eye, look, 0, null, r);
        }
      }
      const headEnd = out.length;
      if (rag?.popped) out.push({ m: rag.matrix(0, 1.41, [0, 0.02, 0], [0.3, 0.04, 0.3]), col: [0.45, 0.04, 0.03], emit: 0 }); // the neck
      // A mounted one's horse under it, trotting (or, its rider fallen, a ragdoll already in the world: see horse.js).
      if (u.horseRag) for (const h of u.horseRag.parts(u.kind, toga)) push(h.m, h.col, 0, h.taper && { taper: h.taper });
      else if (MOUNTS[u.kind]) {
        const Wg = worldMatrix(u, ground);
        for (const h of horseParts(u.kind, toga, u.walk * MOUNT_TUNING.gait, u.moving)) push(mul4(Wg, h.m), h.col, 0, h.taper && { taper: h.taper });
      }
      // Each villager is its own height, within 2% of the others, so two on one square don't z-fight (the tops of
      // their heads especially): every part scaled about its feet (or a fallen one's body).
      // Knocked back by a blow, it's drawn a little away (see knockOffset).
      const hk = heightScale(u.id), o = rag ? rag.pos : [u.pos[0], feet, u.pos[2]], ko = rag ? null : knockOffset(u);
      // Selected, it's outlined in its team's colour (units-render.js): 1 blue, 2 red, 3 yellow, 4 purple, in each part's matrix's spare
      // corner.
      const sel = u.selected && !rag ? SEL_INDEX[u.team] ?? 1 : 0;
      const step = P.step, ls = [Math.sin(u.yaw) * step, Math.cos(u.yaw) * step]; // its lunge
      // Up a ladder (across the middle of its cell), it's drawn just behind it.
      const cl = !rag && u.climbing > 0 && u.clingDir ? Math.min(1, u.climbing) * -0.2 : 0, cling = cl && [u.clingDir[0] * cl, u.clingDir[1] * cl];
      for (let i = first; i < out.length; i++) {
        const m = out[i].m;
        for (let j = 0; j < 11; j++) if (j % 4 !== 3) m[j] *= hk;
        for (let j = 0; j < 3; j++) m[12 + j] = o[j] + (m[12 + j] - o[j]) * hk;
        if (ko) { m[12] += ko[0]; m[14] += ko[1]; }
        if (step) { m[12] += ls[0]; m[14] += ls[1]; }
        if (cling) { m[12] += cling[0]; m[14] += cling[1]; }
        m[11] = sel;
      }
      if (u === this.possessed) {
        const m = out[headAt].m, unit = (v) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
        this.eyeFrame = { pos: [m[12], m[13], m[14]], up: unit([m[4], m[5], m[6]]), fwd: unit([m[8], m[9], m[10]]) };
        // Its arms and what they hold drawn lower and further out (and back), out of the middle of the view.
        const T = POSSESS_TUNING, cy = Math.cos(u.yaw), sy = Math.sin(u.yaw);
        const off = [-cy * T.armOut - sy * T.armBack, -T.armDrop, sy * T.armOut - cy * T.armBack];
        if (!rag) for (let i = armsAt; i < armsEnd; i++) for (let j = 0; j < 3; j++) out[i].m[12 + j] += off[j];
        if (this.hideBody) { out.splice(first); ankhs.delete(u); } else out.splice(headAt, headEnd - headAt);
      }
    }
    this.ladders.parts(out, this.hiddenAt);
    this.walls?.parts(out, this.hiddenAt, this.time); // (walls' banners)
    // Piles of what workers have left on the ground (see jobs.js Workers.drop), up to 40 items shown each.
    for (const pl of this.workers.piles) {
      if (this.hiddenAt?.(pl.x + 0.5, pl.z + 0.5)) continue;
      for (const [c, s, col] of loadBoxes(pl.block, Math.min(pl.n, 40), true)) {
        out.push({ m: [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, pl.x + 0.5 + c[0], pl.y + c[1], pl.z + 0.5 + c[2], 1], col, emit: 0 });
      }
    }
    // Priests' beams: from the middle of the ankh's loop to the chest of the one it heals, flickering, swelling in and
    // out with its channelling. They're light: past white so they bloom, and never outlined (emit 2, see
    // units-render.js). Their ends go in this.beams, for the plasma wisps along them (see puffs.js).
    const C = COMBAT_TUNING, beamCol = linearColor(C.beamColor).map((c) => c * C.beamGlow);
    this.beams = [];
    for (const [u, parts] of ankhs) {
      const o = u.beamTo;
      if (!u.channel || !o || u.dying) continue;
      const a = [0, 1, 2].map((j) => parts.reduce((t, i) => t + out[i].m[12 + j], 0) / parts.length);
      const b = [o.pos[0], this.drawHeight(o) + mountLift(o) + 1.05 * heightScale(o.id), o.pos[2]];
      const w = C.beamWidth * ease(u.channel) * (0.85 + 0.15 * Math.sin(this.time * 31 + u.id * 3.7));
      out.push({ ...strand(a, b, w, beamCol), emit: 2 });
      this.beams.push({ a, b, strength: ease(u.channel) });
    }
    // Arrows, spears and fireballs in flight (a fireball only lighting what's round it: it's drawn as fire, its
    // position in this.fireballs), and the arrows and spears stuck in the ground (their heads buried).
    this.fireballs = [];
    const hid = (p) => this.hiddenAt?.(p[0], p[2]);
    for (const a of this.arrows) {
      const s = Math.min(1, a.t / a.time), p0 = this.arrowAt(a, s), p1 = this.arrowAt(a, Math.min(1, s + 0.02));
      if (hid(p0)) continue;
      const dir = p1.map((v, i) => v - p0[i]), l = Math.hypot(...dir) || 1;
      if (a.what === 'arrow') out.push(...arrowParts(p0, dir, 0));
      else if (a.what === 'spear') out.push(...spearParts(p0.map((v, i) => v - dir[i] / l * SPEAR_TIP), dir));
      else {
        // A fireball: drawn as fire sprites (see puffs.js), lighting what's round it.
        this.fireballs.push(p0);
        this.torches.push([p0[0], p0[1], p0[2], 0.999]);
      }
    }
    for (const s of this.stuck) if (!hid(s.pos)) out.push(...(s.spear ? spearParts(s.pos.map((v, i) => v - s.dir[i] * (SPEAR_TIP - 0.35)), s.dir) : arrowParts(s.pos, s.dir)));
    // Fireballs bursting (drawn as fire and smoke, see puffs.js) light the ground round them, fading.
    for (const b of this.blasts) if (!hid(b.pos)) this.torches.push([b.pos[0], b.pos[1], b.pos[2], 0.999 * (1 - b.age / BLAST_TIME)]);
    return out;
  }

  // Ground marks for the terrain shader: flatten boxes (w = 3, two entries each, see FlattenJob.marks), each unit's
  // blob shadow (w = 0, or 1 when selected for its ring) and the goals of selected units (w = 2). `extra` (a box
  // being drawn) goes first; `jobs` false leaves the open jobs' boxes out.
  marks(max, extra = [], jobs = true) {
    const out = [...extra, ...(jobs ? this.workers.marks() : [])];
    for (const u of this.list) {
      if (u.hidden || u.kind === 'crystal' || u.kind === 'wall') continue;
      out.push([...this.shadowAt(u), 0]); // (selected ones are outlined instead, see parts)
      // (A horse's, front and back.)
      if (MOUNTS[u.kind] && !u.rag) for (const k of [-0.5, 0.5]) out.push([u.pos[0] + Math.sin(u.yaw) * k, this.drawHeight(u), u.pos[2] + Math.cos(u.yaw) * k, 0]);
      else if (u.horseRag) out.push([...this.groundBelow(...u.horseRag.pos), 0]); // (a dead one's, under its body)
    }
    for (const u of this.list) {
      if (!u.selected) continue;
      for (const g of [u.goal, ...u.queue.map((w) => w.cell), ...(u.patrol?.points ?? [])]) if (g) out.push([g[0] + 0.5, g[1], g[2] + 0.5, 2]);
    }
    return out.slice(0, max);
  }

  // Where a unit's blob shadow goes: under its feet, or on the ground under a fallen one's body.
  shadowAt(u) {
    if (!u.rag) return [u.pos[0], this.drawHeight(u), u.pos[2]];
    const [x, y, z] = u.rag.pos, cx = Math.floor(x), cz = Math.floor(z);
    let g = Math.floor(y);
    while (g > 0 && !this.terrain.solid(cx, g - 1, cz)) g--;
    return [x, g, z];
  }
}

// An arrow's boxes, with its tip at `tip` (in whatever frame) pointing along dir: a shaft, an iron head and pale
// fletching. sunk: how far the tip is in whatever it's stuck in (and so the head hidden).
function arrowParts(tip, dir, sunk = 0.22) {
  const h = Math.hypot(dir[0], dir[2]);
  const ang = -Math.atan2(dir[1], h || 1e-6), yaw = Math.atan2(dir[0], dir[2]);
  const l = Math.hypot(...dir) || 1;
  const c = tip.map((v, i) => v + dir[i] / l * (sunk - 0.36)); // the shaft's middle, 0.36 back from the tip
  const frame = { pos: c, yaw };
  return [
    { m: partMatrix(frame, c[1], 0, 0, ang, [0, 0, 0], [0.04, 0.04, 0.6], 0), col: [0.5, 0.33, 0.16], emit: 0 },
    { m: partMatrix(frame, c[1], 0, 0, ang, [0, 0, 0.32], [0.07, 0.07, 0.08], 0), col: [0.42, 0.44, 0.48], emit: 0 },
    { m: partMatrix(frame, c[1], 0, 0, ang, [0, 0, -0.26], [0.1, 0.02, 0.12], 0), col: [0.9, 0.9, 0.86], emit: 0 },
  ];
}

// A spear's boxes, its middle at `centre` (in whatever frame) and its head pointing along dir.
function spearParts(centre, dir) {
  const h = Math.hypot(dir[0], dir[2]);
  const ang = -Math.atan2(dir[1], h || 1e-6), frame = { pos: centre, yaw: Math.atan2(dir[0], dir[2]) };
  return SPEAR.map(([c, s, col]) => ({ m: partMatrix(frame, centre[1], 0, 0, ang, c, s, 0), col, emit: 0 }));
}

// Rx(ang) * v, Rz(ang) * v, and an arm's turn (Rz(roll) Rx(ang), as partMatrix's) * v.
const rotX = (v, ang) => [v[0], Math.cos(ang) * v[1] - Math.sin(ang) * v[2], Math.sin(ang) * v[1] + Math.cos(ang) * v[2]];
const rotZ = (v, ang) => [Math.cos(ang) * v[0] - Math.sin(ang) * v[1], Math.sin(ang) * v[0] + Math.cos(ang) * v[1], v[2]];
const armRot = (v, ang, roll) => rotZ(rotX(v, ang), roll);
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
// An angle wrapped to -pi - pi.
const wrapAngle = (a) => ((a % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;

// An arm's swing and roll (as partMatrix's) to point it along d (from its shoulder, in the body's frame). There are
// two ways to: swung forward or back then rolled (over false), or swung up past its head then rolled (over true; the
// arm's the same, turned half round about its length), the first unless d's above the shoulder.
function aimArm(d, over = d[1] > 0) {
  const l = Math.hypot(d[0], d[1], d[2]) || 1, a = Math.asin(Math.max(-1, Math.min(1, d[2] / l)));
  return over ? { arm: -Math.PI + a, roll: Math.atan2(-d[0], d[1]) } : { arm: -a, roll: Math.atan2(d[0], -d[1]) };
}

// Frames things are held in, in the body's frame (from its feet, before its upper body's twist): o, where; x, y, z its
// axes. A fist's: the arm swung by arm and rolled by roll from its shoulder at x = px, the hand bent at the wrist by
// bend ([about x, about z], as wristLocal's): what's in it is given in the arm's frame from the fist (see HELD).
function fistFrame(px, arm, roll, bend = [0, 0]) {
  const ax = (v) => armRot(rotX(rotZ(v, bend[1]), bend[0]), arm, roll);
  const f = armRot([0, -0.58, 0], arm, roll);
  return { o: [px + f[0], 1.36 + f[1], f[2]], x: ax([1, 0, 0]), y: ax([0, 1, 0]), z: ax([0, 0, 1]) };
}
// Or in the fist but turned its own way, about x by ang (as a spear, staff or axe is, see handPose).
function ownFrame(px, arm, roll, ang) {
  const ax = (v) => armRot(v, ang, roll);
  const f = armRot([0, -0.58, 0], arm, roll);
  return { o: [px + f[0], 1.36 + f[1], f[2]], x: ax([1, 0, 0]), y: ax([0, 1, 0]), z: ax([0, 0, 1]) };
}
// Both hands together on a haft, at phi round the line of the shoulders (0 ahead at their height, pi/2 straight up,
// GRIP_GAP either side of the middle, where both arms reach): each arm's swing and roll, and the haft's frame between
// them (its handle along z, pointing `tool` round the same way; what's held across it has its blade at -y, facing the
// way it swings down).
// side: the grip moved that far to its right (its right hand alone on the haft: a possessed worker's, see posture).
const GRIP_GAP = 0.07, GRIP_R = Math.sqrt(0.58 ** 2 - (0.37 - GRIP_GAP) ** 2);
function twoHands(phi, tool, side = 0) {
  const d = Math.max(-0.55, Math.min(0.55, 0.37 - GRIP_GAP - side)), r = side ? Math.sqrt(0.58 ** 2 - d * d) : GRIP_R;
  const y = r * Math.sin(phi), z = r * Math.cos(phi), st = Math.sin(tool), ct = Math.cos(tool);
  return {
    right: aimArm([d, y, z], false), left: aimArm([-d, y, z], false),
    frame: { o: [-side, 1.36 + y, z], x: [1, 0, 0], y: [0, ct, -st], z: [0, st, ct] },
  };
}
// A haft's frame for something held along the arm from the fist (a shovel, a sword): its handle along -y instead.
const turnAlong = (F) => ({ o: F.o, x: F.x, y: F.z.map((v) => -v), z: F.y });
// From frame a towards frame b by k.
function blendFrame(a, b, k) {
  if (k <= 0) return a;
  if (k >= 1) return b;
  const z = nlerp(a.z, b.z, k), x = unit3(cross3(nlerp(a.y, b.y, k), z));
  return { o: a.o.map((v, i) => lerp(v, b.o[i], k)), x, y: cross3(z, x), z };
}
// A frame as a matrix, and a box of size s centred at c.
const frameMatrix = (F) => [...F.x, 0, ...F.y, 0, ...F.z, 0, ...F.o, 1];
const boxAt = (c, s) => [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, c[0], c[1], c[2], 1];
// How a hand bends at its wrist ([about x, about z], as wristLocal's) to hold something whose handle runs along `axis`
// (in the body's frame) from a fist on an arm swung by arm and rolled by roll: across the hand (its z), or along
// (from the fist on along the arm).
function bendTo(arm, roll, axis, along) {
  const a = rotX(rotZ(axis, -roll), -arm); // (in the arm's frame)
  return along ? [Math.atan2(-a[2], -a[1]), Math.asin(Math.max(-1, Math.min(1, a[0])))] : [Math.atan2(-a[1], a[2]), 0];
}
// A wrist's bend within the cone it can bend in (UNIT_TUNING.wristCone).
function wristCone(b) {
  const k = Math.min(1, UNIT_TUNING.wristCone / (Math.hypot(b[0], b[1]) || 1));
  return [b[0] * k, b[1] * k];
}

// A unit's frame in the world (its feet, turned to its yaw); its upper body's about its hips (h above its feet),
// leaning forward by `lean` and tilted to its left by `side`; and a lift by bob and turn by its upper body's twist tw.
const ORIGIN = { pos: [0, 0, 0], yaw: 0 };
function worldMatrix(u, feet) {
  const cy = Math.cos(u.yaw), sy = Math.sin(u.yaw);
  return [cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, u.pos[0], feet, u.pos[2], 1];
}
function spineMatrix(h, lean, side) {
  const cl = Math.cos(lean), sl = Math.sin(lean), cs = Math.cos(side), ss = Math.sin(side);
  // Rz(-side) Rx(lean), about (0, h, 0).
  const r = [cs, -ss, 0, 0, ss * cl, cs * cl, sl, 0, -ss * sl, -cs * sl, cl, 0, 0, 0, 0, 1];
  r[12] = -(r[4] * h); r[13] = h - r[5] * h; r[14] = -(r[6] * h);
  return r;
}
function liftTurn(bob, tw) {
  const c = Math.cos(tw), s = Math.sin(tw);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, bob, 0, 1];
}

// a × b for column-major 4×4 matrices.
function mul4(a, b) {
  const o = new Array(16);
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    o[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1] + a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
  }
  return o;
}

// A villager's height, as a scale: 0.99 to 1.01, spread out by its id (golden-ratio steps, so any few are apart).
const heightScale = (id) => 0.99 + 0.02 * ((id * 0.6180339887) % 1);

// The ragdoll's hinges, by the pivots (height, x) the parts hang from: the legs, then the arms. NECK: the head's.
// The body's tapers (see units-render.js: [x, z], over each box's height, wider at the top when positive): the body
// and its drape narrowing to the waist, the skirt flaring out below it and the arms narrowing to the wrist.
const TORSO_TAPER = { taper: [0.286, 0] }, DRAPE_TAPER = { taper: [0.667, 0] }, SKIRT_FLARE = { taper: [-0.424, 0] };
const ARM_TAPER = { taper: [0.4, 0.3] };
// Body type B's feet: its sandals' and a warrior's boots' widths, part by part (SANDAL, BOOT), each a little different
// from its leg's and the others' so no faces share a plane, and narrow enough the two feet never overlap.
const B_FEET = { sandal: [0.208, 0.205], boot: [0.208, 0.224, 0.222] };
const HAND = [0.15, 0.16, 0.17]; // a hand's size, round the fist (a little up into the wrist)
const HEAD_LIFT = 0.06;           // how far above the body the head sits, on its neck
// A box's size and taper (see units-render.js) going from width (or depth) a at its bottom to b at its top.
const tapered = (a, b) => ({ s: (a + b) / 2, t: (b - a) / ((a + b) / 2) });
// A box of size s bent at a wrist by b (about x) and r (about z) round its own centre, as a matrix (Rx(b) Rz(r)).
function wristLocal(b, r, s) {
  const cb = Math.cos(b), sb = Math.sin(b), cr = Math.cos(r), sr = Math.sin(r);
  return [
    cr * s[0], cb * sr * s[0], sb * sr * s[0], 0,
    -sr * s[1], cb * cr * s[1], sb * cr * s[1], 0,
    0, -sb * s[2], cb * s[2], 0,
    0, 0, 0, 1,
  ];
}
const HINGE = { '0.75,-0.14': 0, '0.75,0.14': 1, '1.36,0.37': 2, '1.36,-0.37': 3 };
const NECK = 1.41;

// Whether voxel (x, y, z) is a parapet for a villager standing in `cell`: a wall up to two high right beside it, which
// it shoots over.
const parapet = (cell, x, y, z) => Math.max(Math.abs(x - cell[0]), Math.abs(z - cell[2])) <= 1 && y >= cell[1] && y <= cell[1] + 1;

// Where a point `along` a spear or staff in u's right fist is in the world, with the arm swung by `arm` (and rolled by
// `roll`) and the spear or staff tilted by `ang` (see handPose).
function handPoint(u, arm, ang, along, roll = 0) {
  const v = rotZ([0, -0.58 * Math.cos(arm) - Math.sin(ang) * along, -0.58 * Math.sin(arm) + Math.cos(ang) * along], roll);
  const lx = -0.37 + v[0], ly = 1.36 + v[1], lz = v[2];
  const cy = Math.cos(u.yaw), sy = Math.sin(u.yaw);
  return [u.pos[0] + cy * lx + sy * lz, u.pos[1] + ly, u.pos[2] - sy * lx + cy * lz];
}

// Model matrix for one box of a unit: unit position and facing, then a pivot (hip, shoulder, neck) at (px, py)
// in the unit's frame swinging by `ang` about x (then, for an arm raised out to the side, by `roll` about z: pi/2
// holds it straight out to the unit's left), then the box's centre `c` from the pivot and its size `s`.
function partMatrix(u, feet, py, px, ang, c, s, yawOff, roll = 0) {
  const yaw = u.yaw + yawOff;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const ca = Math.cos(ang), sa = Math.sin(ang), cr = Math.cos(roll), sr = Math.sin(roll);
  // M = Rz(roll) * Rx(ang), by columns.
  const m0 = [cr, sr, 0], m1 = [-sr * ca, cr * ca, sa], m2 = [sr * sa, -cr * sa, ca];
  // Box centre in the unit's frame: pivot + M * c.
  const lx = px + m0[0] * c[0] + m1[0] * c[1] + m2[0] * c[2];
  const ly = py + m0[1] * c[0] + m1[1] * c[1] + m2[1] * c[2], lz = m0[2] * c[0] + m1[2] * c[1] + m2[2] * c[2];
  // Rotation R = Ry(yaw) * M; columns scaled by size.
  const ry = (v, k) => [(cy * v[0] + sy * v[2]) * k, v[1] * k, (cy * v[2] - sy * v[0]) * k, 0];
  const wx = u.pos[0] + cy * lx + sy * lz, wy = feet + ly, wz = u.pos[2] - sy * lx + cy * lz;
  return [...ry(m0, s[0]), ...ry(m1, s[1]), ...ry(m2, s[2]), wx, wy, wz, 1];
}


// A thin box (a bowstring) from a to b.
function strand(a, b, w, col) {
  const d = b.map((v, i) => v - a[i]), h = Math.hypot(d[0], d[2]), l = Math.hypot(...d) || 1e-6;
  const mid = a.map((v, i) => (v + b[i]) / 2), frame = { pos: mid, yaw: Math.atan2(d[0], d[2]) };
  return { m: partMatrix(frame, mid[1], 0, 0, -Math.atan2(d[1], h || 1e-6), [0, 0, 0], [w, w, l], 0), col, emit: 0 };
}

class MinHeap {
  constructor() { this.f = []; this.k = []; }
  get size() { return this.f.length; }
  push(f, k) {
    const F = this.f, K = this.k;
    let i = F.length;
    F.push(f); K.push(k);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (F[p] <= f) break;
      F[i] = F[p]; K[i] = K[p];
      i = p;
    }
    F[i] = f; K[i] = k;
  }
  pop() {
    const F = this.f, K = this.k;
    const top = K[0];
    const f = F.pop(), k = K.pop();
    if (F.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= F.length) break;
        if (c + 1 < F.length && F[c + 1] < F[c]) c++;
        if (F[c] >= f) break;
        F[i] = F[c]; K[i] = K[c];
        i = c;
      }
      F[i] = f; K[i] = k;
    }
    return top;
  }
}
