// Entry point: WebGPU setup, input, the brush and the frame loop.

import { Terrain, SIZE, BLOCK, WATER_LEVEL, isOre, OWNER } from './terrain.js';
import { TerrainField } from './sdf.js';
import { SkyVisibility, GI_TUNING } from './skyvis.js';
import { TerrainRenderer, DEPTH_FORMAT, RENDER_TUNING, NORMAL_TUNING, TOON_TUNING, BLOCK_TUNING, OBSIDIAN_LOOK, LEAF_TUNING, SNOW_TUNING } from './render.js';
import { createTerrainTextures, loadTerrainImages, NORMAL_FILES } from './textures.js';
import { Camera, CAMERA_TUNING, POSSESS_TUNING } from './camera.js';
import { clamp } from './math.js';
import { GpuProfiler } from './profiler.js';
import { BANNER_TUNING, CARRY_LOOK, Units, TEAMS, TORCH_TUNING, COMBAT_TUNING, UNIT_TUNING, HIT_TUNING, EYE_TUNING, ANIM_TUNING, LOOK_TUNING, HAIRSTYLE_COUNT, SKIN_TONES, HAIR_COLOURS } from './units.js';
import { RAGDOLL_TUNING } from './ragdoll.js';
import { UnitRenderer, SELECT_TUNING, GHOST_TUNING } from './units-render.js';
import { Grass, GRASS_TUNING } from './grass.js';
import { Debris, DEBRIS_TUNING } from './debris.js';
import { Felling, FELL_TUNING } from './felling.js';
import { Collapse, COLLAPSE_TUNING } from './collapse.js';
import { mat4 } from './math.js';
import { Water, WATER_TUNING } from './water.js';
import { LADDER_TUNING } from './ladders.js';
import { FlattenJob, harvestJob, SculptJob, MineJob, brushVoxels, boxVoxels, BOX_MAX, WORK_TUNING, built, SPECS, CARRY_TUNING } from './jobs.js';
import { Sky, SKY_TUNING, linearColor } from './sky.js';
import { createTuningPanel } from './tuning.js';
import { plantTrees, plantStartForest, LeafDecay, findTrunk, trunkLogs, forestOf, TREE_TUNING } from './trees.js';
import { BUILDINGS, BUILDING_ACTIONS, BUILDING_SIGHT, LOOKOUT_TUNING, PRODUCTION_TUNING, POP_TUNING, TRAINING_COST, trainingCost, BUILD_EXTRA, buildExtra, BUILT_IN_DESIGNS, BuildJob, canPlace, canExit, planGhosts, facingToward, captureDesign, designPlan, placeKeep, planBox } from './buildings.js';
import { Torches } from './torches.js';
import { Banners, BANNER_LOOK } from './banners.js';
import { Walls, WALL_TUNING, wallBlock } from './walls.js';
import { Gates, GATE_TUNING } from './gates.js';
import { SpawnPoints, spawnParts, SPAWN_TUNING } from './spawns.js';
import { PostFX, POST_TUNING } from './post.js';
import { Puffs, EXPLOSION_TUNING } from './puffs.js';
import { Splashes, SPLASH_TUNING } from './splash.js';
import { Haze } from './haze.js';
import { Scorch, SCORCH_TUNING } from './scorch.js';
import { HealthBars, HEALTHBAR_TUNING } from './bars.js';
import { Groups, GROUP_TUNING } from './groups.js';
import { Trails, TRAIL_TUNING } from './trails.js';
import { StrengthBar, STRENGTH_TUNING } from './strength.js';
import { MOUNTS, MOUNT_TUNING, mountLift } from './horse.js';
import { Inventory, INVENTORY_TUNING, RESOURCES, WHEAT } from './inventory.js';
import { Farms, FARM_TUNING } from './farm.js';
import { BuildingOutline } from './outline.js';
import { OreChunks, placeStartOre, ORE_LOOK } from './ores.js';
import { Minimap, MINIMAP_TUNING } from './minimap.js';
import { Fog, FOG_TUNING } from './fog.js';
import { HdrOutput, HDR_TUNING } from './hdr.js';
import { CRYSTAL_TUNING, crystalBase, crystalParts, crystalLights, crystalBeams, crystalGems } from './crystals.js';
import { Beams } from './beams.js';
import { Gems } from './gem.js';
import { audio, sfx, soundTuning, AUDIO_TUNING, ambientFade } from './audio.js';
import { ICON, UNIT_ICON, svg, svgCur, emblem, teamChip, teamBanner, resIcon, WARN, compass, cap, clockText, esc, EventLog, LiveView } from './hud.js';

// Editor mode's world: flat ground with its top this high (above the water, which isn't there), no trees.
export const EDITOR_TUNING = { groundHeight: 16 };

// The HUD (see ui.css): the screen edge moving the camera, and how long alerts stay up.
export const HUD_TUNING = {
  edgePan: 1,        // pushing the mouse to the screen's edge moves the camera (Options has it too)
  edgeMargin: 6,     // pixels
  edgeSpeed: 1,      // × the arrow keys' speed
  threatLast: 15,    // s a threat stays pinned on the events after its last blow
  attackWindow: 5,   // s the crystal's loss is counted over ("−80 in 5 s")
  attackRadius: 20,  // voxels: enemies this near the crystal are attacking it
  eventsShown: 8,    // older events listed when "N more" is opened
};

export const BRUSH_TUNING = {
  minRadius: 1,
  maxRadius: 24,
};

const canvas = document.getElementById('view');
const stats = document.getElementById('stats');

function fail(message) {
  const el = document.getElementById('error');
  el.textContent = message;
  el.style.display = 'grid';
  throw new Error(message);
}

if (!navigator.gpu) fail('WebGPU is not available in this browser. Try Chrome or Edge 113+, or Safari 18+.');
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) fail('No WebGPU adapter was found.');
// timestamp-query (where the browser exposes it) lets the profiler panel time each GPU pass.
// (The large map's distance field takes a storage buffer bigger than the default limits allow.)
const device = await adapter.requestDevice({
  requiredFeatures: ['timestamp-query'].filter((f) => adapter.features.has(f)),
  requiredLimits: { maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize },
});
device.lost.then((info) => fail(`The GPU device was lost: ${info.message}`));
device.addEventListener('uncapturederror', (e) => console.error(e.error.message));

const context = canvas.getContext('webgpu');
const format = navigator.gpu.getPreferredCanvasFormat();
// An sRGB view lets the shader write linear colour.
// The water copies the frame drawn so far to look through it, so the canvas is a copy source too.
// HDR output (the main menu's toggle, kept in localStorage; it takes a reload, as everything's made for its colour
// format): where the browser can show a float canvas in extended range, the frame's drawn into a float texture instead
// (COLOR_FORMAT, linear, nothing clipped at white) and src/hdr.js writes it out to the canvas.
const HDR_KEY = 'mine-wars-hdr';
let hdrWanted = false;
try { hdrWanted = localStorage.getItem(HDR_KEY) === '1'; } catch { /* (private window: off) */ }
let hdr = false;
if (hdrWanted) {
  try {
    context.configure({ device, format: 'rgba16float', colorSpace: 'srgb', toneMapping: { mode: 'extended' }, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    hdr = context.getConfiguration?.()?.toneMapping?.mode === 'extended';
  } catch { hdr = false; }
}
if (!hdr) {
  context.configure({
    device, format, alphaMode: 'opaque', viewFormats: [`${format}-srgb`],
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
}
const COLOR_FORMAT = hdr ? 'rgba16float' : `${format}-srgb`;
const hdrOut = hdr ? new HdrOutput(device) : null;

// The main menu's HDR toggle: on or off for next time (a reload), and whether it's on now (shown straight away, not
// once the world's made).
const hdrButton = document.getElementById('btn-hdr');
if (hdrButton) {
  const screen = window.matchMedia?.('(dynamic-range: high)').matches;
  hdrButton.querySelector('b').textContent = hdr ? 'On' : hdrWanted ? 'Not supported here' : 'Off';
  hdrButton.parentElement.querySelector('small').textContent = hdr ? 'Highlights brighter than white on an HDR screen (T > HDR output). Click to turn off (reloads).'
    : screen ? 'This screen can show HDR. Click to turn it on (reloads).' : 'For HDR screens: highlights brighter than white. Click to turn it on (reloads).';
  hdrButton.addEventListener('click', () => {
    try { localStorage.setItem(HDR_KEY, hdrWanted ? '0' : '1'); } catch { /* (nowhere to keep it) */ }
    location.reload();
  });
}

// The world's seed: from the page's #seed=..., else the last one used, else 7. Any text works: a number is used as it
// is, anything else is hashed to one. A new seed starts the world over (the page reloads with it).
const SEED_KEY = 'god-game-seed';
const seedText = (() => {
  const m = /seed=([^&]*)/.exec(location.hash);
  if (m) return decodeURIComponent(m[1]);
  try { return localStorage.getItem(SEED_KEY) ?? '7'; } catch (err) { return '7'; }
})();
function seedNumber(text) {
  text = text.trim();
  if (/^\d+$/.test(text)) return Number(text) >>> 0;
  let h = 2166136261; // FNV-1a
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}
const seed = seedNumber(seedText);
// A new game's setup, from the main menu's New game screen (which reloads the page with #new=1&map=…&opp=…&mirror=…
// in its address): the map's size (read by terrain.js for SIZE), how many opponents, and whether the map's mirrored
// across x, z (the screen's Y), both, or none; how high the land rises (mount, times as it comes), how much of the
// map is under the water (water, %), how many trees and how much iron and gold (res, times as it comes) and whether
// land bridges join the starts (bridge). The game then starts
// straight away. (parseSetup reads the same from any such text: the New game screen shows the last one started,
// kept in localStorage as SETUP_KEY.)
const SETUP_KEY = 'god-game-setup';
function parseSetup(text) {
  const get = (k) => new RegExp(`(?:^#|&)${k}=([^&]*)`).exec(text)?.[1];
  const opp = get('opp');
  return {
    start: get('new') === '1',
    map: get('map') ?? 'medium',
    opponents: opp === undefined ? 1 : Math.max(0, Math.min(3, Math.round(+opp) || 0)),
    mirror: ['x', 'z', 'both'].includes(get('mirror')) ? get('mirror') : 'none',
    fog: get('fog') !== '0', // fog of war (on unless #fog=0)
    mountains: Math.max(0.25, Math.min(2.5, +(get('mount') ?? 1) || 1)),
    water: Math.max(0, Math.min(90, +(get('water') ?? 30) || 0)),
    resources: Math.max(0.25, Math.min(2, +(get('res') ?? 1) || 1)),
    bridge: get('bridge') !== '0', // land bridges (on unless #bridge=0)
  };
}
const setup = parseSetup(location.hash);

const t0 = performance.now();
const terrain = new Terrain();
const sym = setup.start ? setup.mirror : 'none';
// (Blended across the symmetry's seams; a new game's land shaped by its setup, see Terrain.generate.)
terrain.generate(seed, sym, setup.start ? {
  mountains: setup.mountains, water: setup.water / 100, bridge: setup.bridge, resources: setup.resources,
  starts: startTargets(setup.opponents, sym),
} : {});
// No trees by a seam of the symmetry (mirror() would cut them in two) or on or beside a land bridge (in the way).
const besideBridge = (x, z) => {
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (terrain.bridged[(x + dx) + SIZE[0] * (z + dz)]) return true;
  return false;
};
plantTrees(terrain, seed, (x, z) => (sym !== 'none' && Terrain.nearSeam(sym, x, z)) || besideBridge(x, z), setup.start ? setup.resources : 1);
if (sym !== 'none') terrain.mirror(sym);
// A new game's opponents' teams, in order, each its own side (they fight each other too).
const OPPONENTS = ['red', 'yellow', 'purple'];
// A new game's starts (see newGameStarts), and a Keep at each, its door towards the middle of the map (see
// buildings.js placeKeep; its power crystal comes with the game, see startGame). keeps: team -> its Keep's plan.
const newStarts = setup.start ? newGameStarts(setup.opponents, setup.mirror) : null;
const keeps = new Map();
if (newStarts) {
  [newStarts.blue, ...newStarts.opponents].forEach(([x, z], i) => {
    const team = i ? OPPONENTS[i - 1] : 'blue', plan = placeKeep(terrain, x, z, facingToward(x, z, [SIZE[0] / 2, 0, SIZE[2] / 2]));
    keeps.set(team, plan);
    for (const [bx, , bz] of plan.blocks) terrain.own(bx, bz, team); // (its team's colours)
    placeStartOre(terrain, seed, x, z, besideBridge); // (stone and iron near it, if it hasn't them)
    plantStartForest(terrain, seed, x, z, besideBridge); // (a forest near it, if it hasn't one)
  });
}
const ores = new OreChunks(terrain); // iron and gold ore's chunks of metal (see ores.js)
ores.index();
const leafDecay = new LeafDecay(terrain);
const field = new TerrainField(device, terrain);
field.buildAll();
const albedo = createTerrainTextures(device, await loadTerrainImages().catch((e) => fail(e.message)));
const normalMaps = createTerrainTextures(device, await loadTerrainImages(NORMAL_FILES).catch((e) => fail(e.message)), true);
const sky = new Sky(device);
// Global illumination probes: how much sky each place sees, and the light bouncing round (GI_TUNING, L cycles it).
const skyVis = new SkyVisibility(device, field, albedo, sky);
skyVis.buildAll();
const renderer = new TerrainRenderer(device, COLOR_FORMAT, field, albedo, sky, normalMaps, skyVis);
const haze = new Haze(device, COLOR_FORMAT, sky); // (distance fog for what's drawn after the terrain)
const unitRenderer = new UnitRenderer(device, COLOR_FORMAT, DEPTH_FORMAT, sky);
const oreRenderer = new UnitRenderer(device, COLOR_FORMAT, DEPTH_FORMAT, sky); // (a renderer of their own)
const oreEnv = { view: null, at: 0, x: 0, z: 0, size: 0, wanted: false }; // their reflection cube (see the frame)
const buildingOutlines = new BuildingOutline(device, COLOR_FORMAT);
// Cartoon grass tufts on the grassy tops near the camera's target.
const grass = new Grass(device, COLOR_FORMAT, DEPTH_FORMAT, terrain, albedo, sky);
// Pebbles off stone and bricks, chips off wood, for every solid voxel taken away.
const debris = new Debris(device, COLOR_FORMAT, DEPTH_FORMAT, terrain, albedo, sky);
const farms = new Farms(device, COLOR_FORMAT, DEPTH_FORMAT, terrain, sky); // the god panel's Farm orders, and their wheat
// Cut trees topple over, their leaves bursting and their logs tumbling when they land (the felled logs throw no chips:
// only the cut one does).
const felling = new Felling(device, COLOR_FORMAT, DEPTH_FORMAT, terrain, albedo, sky, normalMaps);
// A team out of the game (its power crystal destroyed): its buildings and walls come apart in tumbling blocks, out
// from the crystal (see eliminate).
const collapse = new Collapse(terrain, felling);
collapse.hidden = (x, z) => fog.hidden(x, z);
terrain.onLose = (x, y, z, block, from, felled) => { // (none where the player can't see)
  if (!fog.hidden(x + 0.5, z + 0.5) && !(felled && FELL_TUNING.on > 0.5)) debris.lose(x, y, z, block, from);
  // Its crumble (not a blast's: that's the explosion; nor a felled tree's logs), and ore's coin.
  const s = from || felled ? null : LOSE_SOUND[block], at = [x + 0.5, y + 0.5, z + 0.5];
  if (s) sfx(s, at);
  if (s && isOre(block)) sfx('coin', at, { delay: 0.08 });
};
terrain.onFell = (cut, logs, leaves, from) => {
  const fell = !fog.hidden(cut[0] + 0.5, cut[2] + 0.5) && felling.fell(cut, logs, leaves, from);
  if (fell) sfx('treeCreak', [cut[0] + 0.5, cut[1] + 1, cut[2] + 0.5]);
  return fell;
};
// Sounds (audio.js): synthesized on the first click or key; none where the player can't see.
const LOSE_SOUND = {
  [BLOCK.STONE]: 'breakStone', [BLOCK.BRICK]: 'breakStone', [BLOCK.IRON]: 'breakStone', [BLOCK.GOLD]: 'breakStone',
  [BLOCK.OBSIDIAN]: 'breakStone', [BLOCK.PLANK]: 'breakWood', // (dirt: just the shovel's, see jobs.js)
};
const startAudio = () => audio.start();
window.addEventListener('pointerdown', startAudio, true);
window.addEventListener('keydown', startAudio, true);
// The interface's buttons: a click, and a tick as the pointer comes onto one.
let hoveredButton = null;
document.addEventListener('pointerdown', (e) => { if (e.target.closest?.('button')) sfx('click'); }, true);
document.addEventListener('pointerover', (e) => {
  const b = e.target.closest?.('button') ?? null;
  if (b && b !== hoveredButton && !b.disabled) sfx('hover');
  hoveredButton = b;
});
// An order's sound, and the unit's spoken reply (silent for now).
function orderSound(kind) {
  sfx(kind === 'attack' ? 'orderAttack' : kind === 'patrol' ? 'orderPatrol' : kind === 'work' ? 'orderWork' : 'orderMove');
  if (kind !== 'work') sfx('orderReply');
}
// Fireballs' fire and smoke (sprites from textures/dust_*.png; without them there's only the fireballs' light).
const puffs = new Puffs(device, COLOR_FORMAT, DEPTH_FORMAT);
puffs.load().catch((err) => console.error('Explosion sprites failed to load.', err));
renderer.loadBlastMark().catch((err) => console.error('The blast mark failed to load.', err));
const water = new Water(device, COLOR_FORMAT, DEPTH_FORMAT, field, sky);
const post = new PostFX(device, COLOR_FORMAT);
// Health bars over the hurt (drawn after the post effects so they stay sharp).
const bars = new HealthBars(device, COLOR_FORMAT, DEPTH_FORMAT);
const strength = new StrengthBar(document.getElementById('strength'));
// The trails whirling barbarians' axes leave.
const trails = new Trails(device, COLOR_FORMAT, DEPTH_FORMAT);
// The power crystals' beams of light.
const beams = new Beams(device, COLOR_FORMAT, DEPTH_FORMAT);
// The power crystals themselves: translucent gems.
const gems = new Gems(device, COLOR_FORMAT, DEPTH_FORMAT, sky);
// Fog of war (a new game's, if its setup says so; O in sandbox): per team, never seen, seen before, seen now (fog.js).
const fog = new Fog(device, COLOR_FORMAT, sky, terrain);
audio.hidden = (x, z) => fog.hidden(x, z);
await device.queue.onSubmittedWorkDone();
const startupMs = performance.now() - t0;
console.log(`terrain ready in ${startupMs.toFixed(0)} ms`);

// Profiler panel (G): fps, the GPU in use, GPU time per pass and CPU time per part of the frame.
let adapterInfo = adapter.info;
if (!adapterInfo && adapter.requestAdapterInfo) adapterInfo = await adapter.requestAdapterInfo().catch(() => null);
const profiler = new GpuProfiler(device, adapterInfo);
field.profiler = profiler;
skyVis.profiler = profiler;
const profPanel = document.getElementById('gpu-panel');
function toggleProfiler() {
  const on = profiler.toggle();
  profPanel.hidden = !on;
  if (on) profPanel.innerHTML = '<div class="ptitle">Measuring…</div>';
}
document.getElementById('btn-gpu').addEventListener('click', (e) => { toggleProfiler(); e.currentTarget.blur(); });

const camera = new Camera();
camera.target = [SIZE[0] / 2, 30, SIZE[2] / 2];
// Start over the dry land nearest the middle of the map (a seed's middle may be sea).
{
  const [cx, , cz] = camera.target;
  search: for (let r = 0; r < SIZE[0] / 2; r += 2) {
    for (let a = 0; a < 2 * Math.PI; a += r ? 2 / r : 7) {
      const x = Math.round(cx + Math.cos(a) * r), z = Math.round(cz + Math.sin(a) * r);
      if ([[0, 0], [-5, -5], [5, -5], [-5, 5], [5, 5]].every(([dx, dz]) => terrain.groundAt(x + dx, z + dz) > WATER_LEVEL + 1)) {
        camera.target[0] = x;
        camera.target[2] = z;
        break search;
      }
    }
  }
}
camera.target[1] = terrain.groundAt(camera.target[0], camera.target[2]);
// The minimap (top right): the map from above, the villagers as dots, the camera's view; its clicks are wired up with
// the orders below (see the minimap's handlers).
const minimap = new Minimap(document.getElementById('minimap'), terrain, camera);

// A few villagers near the middle of the map to start with.
const units = new Units(terrain);
const groups = new Groups(units); // control groups (number keys), see groups.js
// After any edit: let leaves that lost their tree wither, and show it (where the player can see it, with fog of war:
// the rest's held back till they see it, see Fog.defer).
function edited(lo, hi) {
  leafDecay.check(lo, hi);
  for (const b of fog.defer(lo, hi)) shown(b.lo, b.hi);
}
// Showing an edit: the distance field rebuilt there, and the light, grass and minimap. quiet: the grass that went
// doesn't flutter off (an edit held back by the fog, shown long after).
function shown(lo, hi, quiet = false) {
  field.update(lo, hi);
  skyVis.update(lo, hi);
  grass.update(lo, hi, quiet);
  minimap.dirty(lo, hi);
}
minimap.onFog = () => fog.state; // (the minimap's fog: never seen black, seen before dimmed)
fog.onRows = (z0, z1) => minimap.fogRows(z0, z1);
units.onEdit = edited; // villagers digging, filling and felling
units.onDeath = (u) => { // a power crystal's team is out (a dead worker's gone for good: train another at the Keep)
  if (u.kind === 'wall') { // a section of wall knocked down: its blocks crumble out
    const c = walls.knockDown(u.wall);
    if (c) edited(c.lo, c.hi);
    // (A gate's: the other half comes down with it.)
    for (const s of u.wall.gate?.tiles ?? []) {
      if (s === u.wall || walls.tiles.get(s.x + SIZE[0] * s.z) !== s) continue;
      const k = walls.knockDown(s);
      if (k) edited(k.lo, k.hi);
      if (s.unit && !s.unit.dying) s.unit.dying = 1e-4;
    }
    sfx(u.wall.block === BLOCK.PLANK ? 'chop' : 'pickStone', [u.pos[0], u.pos[1] + 1, u.pos[2]]);
    return;
  }
  if (u.kind === 'crystal') {
    const at = [u.pos[0], crystalBase(u) + CRYSTAL_TUNING.hover + CRYSTAL_TUNING.length / 2, u.pos[2]];
    puffs.burst(at, 2);
    sfx('crystalShatter', at);
    eliminate(u.team, at);
  }
};
// A team whose power crystal's been destroyed is out of the game: its villagers fall where they stand, and it trains
// and brings back no more. The player hears of each; when it's theirs, they've lost, and when it's every opponent's,
// they've won. at: where its crystal was, which its buildings come apart out from (see collapse.js).
const eliminated = new Set();
function eliminate(team, at = null) {
  if (eliminated.has(team)) return;
  eliminated.add(team);
  if (at) collapse.start(team, at, { keep: keeps.get(team), walls, banners, torches });
  for (const u of units.list) if (u.team === team && !u.dying && u.kind !== 'crystal' && u.kind !== 'wall') units.hit(u, u, 'drown', u.pos, u.hp + 1);
  const where = at ? [at[0], at[2]] : null;
  if (team === 'blue') { toast('Your power crystal was destroyed: defeat', 12); sfx('defeat'); logEvent('Your crystal was destroyed: defeat', null, where, 'blue'); return; }
  const left = OPPONENTS.slice(0, setup.opponents).filter((t) => !eliminated.has(t));
  logEvent(`${TEAMS[team].name}'s crystal was destroyed: ${TEAMS[team].name} is out`, null, where, team);
  if (!left.length) { toast(`${TEAMS[team].name}'s crystal is destroyed: victory!`, 12); sfx('victory'); logEvent('Every rival is out: victory!', null, null, 'blue'); }
  else sfx('eliminated');
}
collapse.onEdit = edited; // and a fallen team's buildings coming apart
farms.onEdit = edited; // and tilling (or Delete clearing a farm)
// A fireball's burst: fire and smoke, and the ground round it glows red-hot and chars.
const scorch = new Scorch(terrain, (box) => {
  field.uploadBlast(box.index);
  for (const b of fog.defer(box.lo, box.hi)) { // (the char where the player can't see shows when they next do)
    field.updateChar(b.lo, b.hi);
    grass.update(b.lo, b.hi); // (charred grass loses its tufts)
    minimap.dirty(b.lo, b.hi);
  }
});
units.onBlast = (p, r, dir) => {
  const hid = fog.hidden(p[0], p[2]); // (no fire, smoke or glow where the player can't see)
  if (!hid) puffs.burst(p, r);
  scorch.blast(p, r, dir, hid);
};
units.hiddenAt = (x, z) => fog.hidden(x, z);
// Splashes (square, flat, see splash.js): water's where things fall in, blood's where villagers are hurt, and snow's
// kicked up by footsteps on snowy ground (above the snow line on dirt, stone or ore, as render.js's snowy()).
const splashes = new Splashes(device, COLOR_FORMAT, DEPTH_FORMAT, terrain, (x, z) => fog.hidden(x, z));
const SNOWY = new Set([BLOCK.GROUND, BLOCK.STONE, BLOCK.IRON, BLOCK.GOLD]);
function snowyAt(x, y, z) {
  if (SNOW_TUNING.on < 0.5 || !SNOWY.has(terrain.block(x, y - 1, z))) return false;
  const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453, h = v - Math.floor(v);
  return y >= WATER_LEVEL + SNOW_TUNING.height + (h - 0.5) * 2 * SNOW_TUNING.jitter;
}
units.onStep = (u) => { if (u.cell && snowyAt(...u.cell)) splashes.snow(u.pos, u.yaw ?? 0, !!MOUNTS[u.kind]); };
// Raise and Lower don't change the ground themselves: they mark voxels for villagers to fill or dig (one job holds
// every mark; it's added back to the open jobs whenever there's new work in it).
const sculpt = new SculptJob(terrain);
const mines = new MineJob(terrain, null); // the god panel's open Mine orders, shared like sculpt's marks
// Idle Lumberjacks and Miners mark the trees and ore they find on it too, only where the player's seen (Workers.seek).
units.workers.seeking = { job: mines, seen: (x, z) => !fog.never(x, z) };
units.workers.depots = depots; // (where workers take what they carry: the Keep, and houses for wheat)
const torches = new Torches(terrain); // placed from the Build menu
const banners = new Banners(terrain); // hung from the Editor's Build menu, and with the designs that have them
// Walls (the god panel's Wall mode, see walls.js): each built section a target with hit points (a unit of kind 'wall',
// never drawn), its torch ordered as it's finished; knocked down, its blocks come out.
const walls = new Walls(terrain);
units.walls = walls;
walls.onBuilt = (s) => {
  const u = units.spawn(s.x + 0.5, s.z + 0.5, s.y0 + s.h, s.team, 'wall');
  if (u) {
    Object.assign(u, { cell: [s.x, s.y0, s.z], pos: [s.x + 0.5, s.y0, s.z + 0.5], yaw: 0, wall: s });
    u.hp = u.maxHp = s.block === BLOCK.PLANK ? WALL_TUNING.woodHp : WALL_TUNING.stoneHp;
    s.unit = u;
  }
  const t = { cell: [s.x + s.out[0], s.y0 + s.h - 1, s.z + s.out[1]], wall: s.out };
  if (s.torch && torches.fits(t.cell, t.wall) && !torches.at(...t.cell)) order(torches.add(t));
};
walls.onGone = (s) => { if (s.unit && !s.unit.dying) s.unit.dying = 1e-4; }; // (its blocks all dug out)
// Portcullises (the Build menu's, see gates.js): a gate in a team's wall that only its own team walks through. Made,
// its two sections have half a wall's hit points (what they'd lost, lost in proportion).
const gates = new Gates(terrain, walls);
units.gates = gates;
gates.onEdit = edited;
function gateMade(g) {
  for (const s of g.tiles) {
    const u = s.unit;
    if (!u || u.dying) continue;
    const full = (s.block === BLOCK.PLANK ? WALL_TUNING.woodHp : WALL_TUNING.stoneHp) * Math.max(0.01, GATE_TUNING.hp);
    u.hp = Math.max(1, full * u.hp / Math.max(1, u.maxHp));
    u.maxHp = full;
  }
  sfx('gate', [g.x + 0.5 + g.along[0] * 0.5, g.y0 + 1, g.z + 0.5 + g.along[1] * 0.5]);
}
const spawns = new SpawnPoints(terrain); // the editor's spawn points (Build menu), saved with designs
// (The first villagers come with the mode picked in the main menu: see startGame.)

// Tuning panel (T): time of day, the light, haze and clouds, the water, bloom and depth of field, fighting and the
// fallen's tumble.
const S = SKY_TUNING, WT = WATER_TUNING;
const GROUND_NORMALS = ['grass', 'dirt', 'sand', 'fringe', 'stone']; // (left out of the panel: Jordan uses toon shading)
// The world behind the main menu: how fast it turns (it looks just as it does in the game).
const MENU_TUNING = { spin: 0.05 };
// Slow motion (sandbox, - and + in steps of 0.1, for filming): everything but the camera runs at this share of real
// time, from 0.1 to 1 (the units and their ragdolls, fire and smoke, water, the clock, flickers and glints).
const GAME_SPEED = { speed: 1 };
const TUNING = [
  ['Time of day', [
    [S, 'timeOfDay', 'Time of day (hours)', 0, 24, 0.05],
    [S, 'timeSpeed', 'Clock speed (game hours per minute)', 0, 30, 0.1],
    [GAME_SPEED, 'speed', 'Game speed, sandbox (- and +; the camera keeps full speed)', 0.1, 1, 0.1],
    [S, 'latitude', 'Latitude (deg)', -70, 70, 0.5],
    [S, 'season', 'Season (sun declination, deg)', -23.4, 23.4, 0.1],
    [S, 'north', 'North on the map (deg)', -180, 180, 1],
  ]],
  ['Light', [
    [S, 'sunColor', 'Sunlight colour', 'color'],
    [S, 'sunStrength', 'Sunlight strength', 0, 3, 0.01],
    [S, 'skyColor', 'Skylight colour', 'color'],
    [S, 'skyStrength', 'Skylight strength', 0, 3, 0.01],
    [S, 'moonColor', 'Moonlight colour', 'color'],
    [S, 'moonStrength', 'Moonlight strength', 0, 4, 0.01],
    [S, 'nightLight', 'Night glow', 0, 4, 0.01],
    [S, 'exposure', 'Exposure', 0.1, 4, 0.01],
    [S, 'autoExposure', 'Auto exposure at dusk and night', 0, 1, 0.01],
  ]],
  ['Sky', [
    [S, 'haze', 'Haze', 0.5, 15, 0.1],
    [S, 'clouds', 'Low clouds', 0, 1, 0.01],
    [S, 'highClouds', 'High clouds', 0, 1, 0.01],
    [S, 'fog', 'Distance fog', 0, 5, 0.01],
    [S, 'background', 'Background colour (0 = the sky, 1 = the colours below)', 0, 1, 0.01],
    [S, 'bgDay', 'Background by day', 'color'],
    [S, 'bgDusk', 'Background at dawn and dusk', 'color'],
    [S, 'bgNight', 'Background at night', 'color'],
    [S, 'bgFog', 'Distance fog fades to the background', 0, 1, 0.01],
  ]],
  ['Torches', [
    [TORCH_TUNING, 'color', 'Torch colour', 'color'],
    [TORCH_TUNING, 'strength', 'Torch strength', 0, 12, 0.05],
    [TORCH_TUNING, 'radius', 'Torch reach (voxels)', 2, 20, 0.5],
    [TORCH_TUNING, 'flicker', 'Flicker', 0, 1, 0.01],
    [TORCH_TUNING, 'sunBelow', 'Lit when the sun is below (deg)', -10, 30, 0.5],
  ]],
  ['Ground', [
    [RENDER_TUNING, 'sandBright', 'Sand brightness (1 as painted)', 0, 2, 0.01],
    [RENDER_TUNING, 'ripples', 'Ripples on sand tops (1) or none (0)', 0, 1, 1],
    [RENDER_TUNING, 'rippleScale', 'Sand ripple size (voxels a repeat)', 0.5, 16, 0.1],
    [RENDER_TUNING, 'rippleStrength', 'Sand ripple strength', 0, 4, 0.01],
    [RENDER_TUNING, 'bevel', 'Top edge bevel (voxels; 1 = slopes)', 0, 1, 0.01],
    [RENDER_TUNING, 'cornerBevel', 'Upright corner bevel (voxels; 0 = off)', 0, 0.5, 0.01],
    [BLOCK_TUNING, 'brickBevel', 'Brick bevel width (voxels)', 0, 0.1, 0.002],
    [BLOCK_TUNING, 'brickStrength', 'Brick bevel strength', 0, 3, 0.01],
    [BLOCK_TUNING, 'plankBevel', 'Plank bevel width (voxels)', 0, 0.1, 0.002],
    [BLOCK_TUNING, 'plankStrength', 'Plank bevel strength', 0, 3, 0.01],
    [BLOCK_TUNING, 'seams', 'Brick and plank seam strokes (toon)', 0, 1, 0.01],
    [BLOCK_TUNING, 'brickBlue', 'Blue team\'s bricks', 'color'],
    [BLOCK_TUNING, 'brickRed', 'Red team\'s bricks', 'color'],
    [BLOCK_TUNING, 'brickYellow', 'Yellow team\'s bricks', 'color'],
    [BLOCK_TUNING, 'brickPurple', 'Purple team\'s bricks', 'color'],
    [BLOCK_TUNING, 'clayBlue', 'Blue team\'s clay bricks', 'color'],
    [BLOCK_TUNING, 'clayRed', 'Red team\'s clay bricks', 'color'],
    [BLOCK_TUNING, 'clayYellow', 'Yellow team\'s clay bricks', 'color'],
    [BLOCK_TUNING, 'clayPurple', 'Purple team\'s clay bricks', 'color'],
    [BLOCK_TUNING, 'plankBlue', 'Blue team\'s planks', 'color'],
    [BLOCK_TUNING, 'plankRed', 'Red team\'s planks', 'color'],
    [BLOCK_TUNING, 'plankYellow', 'Yellow team\'s planks', 'color'],
    [BLOCK_TUNING, 'plankPurple', 'Purple team\'s planks', 'color'],
    [BLOCK_TUNING, 'clayRound', 'Clay brick rounding (voxels)', 0.01, 0.25, 0.005],
    [BLOCK_TUNING, 'clayStrength', 'Clay brick rounding strength', 0, 3, 0.01],
    [BLOCK_TUNING, 'clayAcross', 'Clay bricks across a voxel', 1, 4, 1],
    [BLOCK_TUNING, 'clayUp', 'Clay bricks up a voxel', 1, 6, 1],
    [BLOCK_TUNING, 'clayCorner', 'Clay brick corners rounded (voxels)', 0, 0.2, 0.005],
    [BLOCK_TUNING, 'clayHandmade', 'Clay bricks hand made (uneven)', 0, 3, 0.05],
    [GRASS_TUNING, 'on', 'Grass tufts (0 off, 1 on)', 0, 1, 1],
    [GRASS_TUNING, 'density', 'Grass tufts per voxel top', 0, 3, 0.01],
    [GRASS_TUNING, 'height', 'Grass height (voxels)', 0.05, 1, 0.01],
    [GRASS_TUNING, 'width', 'Grass blade width', 0.3, 2.5, 0.01],
    [GRASS_TUNING, 'lean', 'Grass side blades lean out', 0, 2, 0.01],
    [GRASS_TUNING, 'variation', 'Grass shade variation', 0, 0.5, 0.01],
    [GRASS_TUNING, 'range', 'Grass drawn within (voxels of the target)', 8, 96, 1],
    [GRASS_TUNING, 'outline', 'Grass outline (pixels)', 0, 4, 0.1],
    [GRASS_TUNING, 'outlineColor', 'Grass outline colour', 'color'],
    [GRASS_TUNING, 'tint', 'Grass tint', 'color'],
    [GRASS_TUNING, 'puff', 'Lost grass: puff up speed (voxels/s)', 0, 8, 0.1],
    [GRASS_TUNING, 'fall', 'Lost grass: flutter down speed (voxels/s)', 0.1, 3, 0.05],
    [GRASS_TUNING, 'flutter', 'Lost grass: rocking and drifting', 0, 3, 0.05],
  ]],
  ['Snow', [
    [SNOW_TUNING, 'on', 'Snow on high ground (1) or none (0)', 0, 1, 1],
    [SNOW_TUNING, 'height', 'Snow line (voxels above the sea)', 0, 120, 1],
    [SNOW_TUNING, 'jitter', 'Snow line ragged by (voxels up or down)', 0, 10, 0.5],
    [SNOW_TUNING, 'color', 'Snow colour', 'color'],
    [SNOW_TUNING, 'trees', 'Snow on the tops of trees above the line (1) or not (0)', 0, 1, 1],
    [SNOW_TUNING, 'ripples', 'Ripples on snow tops (1) or none (0)', 0, 1, 1],
    [SNOW_TUNING, 'rippleScale', 'Snow ripple size (voxels a repeat)', 0.5, 16, 0.1],
    [SNOW_TUNING, 'rippleStrength', 'Snow ripple strength', 0, 4, 0.01],
  ]],
  ['Splashes', [
    [SPLASH_TUNING, 'grow', 'Share of a square\'s life it grows (then shrinks)', 0, 1, 0.01],
    [SPLASH_TUNING, 'gravity', 'Splash gravity (voxels/s²)', 0, 60, 0.5],
    [SPLASH_TUNING, 'drag', 'Splash air drag', 0, 6, 0.05],
    [SPLASH_TUNING, 'water', 'Water: squares a splash (a voxel-sized thing)', 0, 80, 1],
    [SPLASH_TUNING, 'waterSize', 'Water: square size (half width, voxels)', 0.01, 0.5, 0.01],
    [SPLASH_TUNING, 'waterSpeed', 'Water: throw speed', 0, 20, 0.1],
    [SPLASH_TUNING, 'waterLife', 'Water: seconds a square lasts', 0.05, 3, 0.05],
    [SPLASH_TUNING, 'waterColor', 'Water: colour', 'color'],
    [SPLASH_TUNING, 'snow', 'Snow: squares a footstep', 0, 30, 1],
    [SPLASH_TUNING, 'snowSize', 'Snow: square size (half width, voxels)', 0.01, 0.5, 0.01],
    [SPLASH_TUNING, 'snowSpeed', 'Snow: kick speed', 0, 10, 0.1],
    [SPLASH_TUNING, 'snowLife', 'Snow: seconds a square lasts', 0.05, 3, 0.05],
    [SPLASH_TUNING, 'snowColor', 'Snow: colour', 'color'],
    [SPLASH_TUNING, 'blood', 'Blood (1) or none (0) (Options > Blood)', 0, 1, 1],
    [SPLASH_TUNING, 'bloodCount', 'Blood: squares a blow', 0, 60, 1],
    [SPLASH_TUNING, 'bloodSize', 'Blood: square size (half width, voxels)', 0.01, 0.5, 0.01],
    [SPLASH_TUNING, 'bloodSpeed', 'Blood: throw speed', 0, 15, 0.1],
    [SPLASH_TUNING, 'bloodLife', 'Blood: seconds a square lasts', 0.05, 3, 0.05],
    [SPLASH_TUNING, 'bloodColor', 'Blood: colour', 'color'],
    [SPLASH_TUNING, 'neck', 'Blood: seconds the neck spurts (head off)', 0, 5, 0.1],
    [SPLASH_TUNING, 'neckRate', 'Blood: neck spurts a second at first', 0, 120, 1],
  ]],
  ['Leaves', [
    [LEAF_TUNING, 'round', 'Rounded leaves (0 cubes, 1 rounded)', 0, 1, 1],
    [LEAF_TUNING, 'radius', 'Leaf rounding radius (voxels; 0.5 = a lone leaf is a ball)', 0.05, 0.5, 0.01],
    [LEAF_TUNING, 'holes', "Rounded leaves keep the texture's gaps (0 solid, 1 gaps)", 0, 1, 1],
  ]],
  // (Not the ground's own: grass, dirt, sand, the fringe and stone keep theirs at 1, unused in toon shading; the tilled
  // rows are drawn either way.)
  ['Normal maps', Object.keys(NORMAL_TUNING).filter((k) => !GROUND_NORMALS.includes(k)).map((k) => [NORMAL_TUNING, k, k[0].toUpperCase() + k.slice(1), 0, 3, 0.01])],
  ['Water', [
    [WT, 'windSpeed', 'Wind speed (m/s): taller and longer wind waves', 0, 25, 0.1],
    [WT, 'windDir', 'Wind direction (deg, the way the waves travel)', 0, 360, 1],
    [WT, 'fetchKm', 'Fetch (km of open water the wind blows over): bigger, longer waves', 0.1, 100, 0.1],
    [WT, 'windHeight', 'Wind waves: height', 0, 5, 0.01],
    [WT, 'windFreq', 'Wind waves: frequency (higher = shorter, quicker waves)', 0.2, 5, 0.01],
    [WT, 'gamma', 'Wind waves: peakedness (higher = more of one size)', 1, 10, 0.1],
    [WT, 'swellHs', 'Swell: height (m)', 0, 4, 0.01],
    [WT, 'swellLength', 'Swell: wavelength (m)', 2, 200, 0.5],
    [WT, 'swellDir', 'Swell: direction (deg)', 0, 360, 1],
    [WT, 'swellSpread', 'Swell: crest length (higher = longer, straighter crests)', 1, 100, 1],
    [WT, 'ripples', 'Finest ripples: height', 0, 2, 0.01],
    [WT, 'shortCut', 'Waves shorter than this are damped (mm)', 0, 20, 0.1],
    [WT, 'choppy', 'Choppiness (sharper crests, flatter troughs)', 0, 3, 0.01],
    [WT, 'speed', 'Wave speed (1 = real time)', 0, 4, 0.01],
    [WT, 'gusts', 'Wind gusts: patches of stronger and calmer ripples', 0, 1, 0.01],
    [WT, 'turbidity', 'Water body brightness', 0, 5, 0.01],
    [WT, 'clarity', 'Clarity (higher sees deeper)', 0.1, 5, 0.01],
    [WT, 'refraction', 'Refraction', 0, 1, 0.01],
    [WT, 'sss', 'Sunlight through backlit crests', 0, 10, 0.05],
    [WT, 'foam', 'Foam', 0, 3, 0.01],
    [WT, 'foamFade', 'Foam fades (per second)', 0, 2, 0.01],
    [WT, 'shoreFoam', 'Shore foam line', 0, 3, 0.01],
  ]],
  ['Collapse', [
    [COLLAPSE_TUNING, 'on', 'A team whose crystal is destroyed: its buildings and walls come apart (1) or stand (0)', 0, 1, 1],
    [COLLAPSE_TUNING, 'delay', 'Seconds after the crystal shatters before the first block goes', 0, 5, 0.1],
    [COLLAPSE_TUNING, 'speed', 'How fast it spreads out from the crystal (voxels/s)', 0.5, 50, 0.5],
    [COLLAPSE_TUNING, 'jitter', 'Randomness in when each block goes (voxels)', 0, 10, 0.1],
    [COLLAPSE_TUNING, 'burst', 'How hard each block is thrown out and up (voxels/s)', 0, 8, 0.1],
    [COLLAPSE_TUNING, 'spin', 'How fast the blocks tumble (radians/s)', 0, 12, 0.1],
    [COLLAPSE_TUNING, 'life', 'Seconds a block lies about before it shrinks away', 0.5, 20, 0.5],
    [COLLAPSE_TUNING, 'burn', 'Seconds a banner takes to burn away', 0.1, 6, 0.1],
    [COLLAPSE_TUNING, 'torchLife', 'Seconds a fallen torch burns on the ground', 0.5, 30, 0.5],
  ]],
  ['Power crystal', [
    [CRYSTAL_TUNING, 'hp', 'Hit points (a new game\'s crystals, from the next one)', 50, 5000, 10],
    [CRYSTAL_TUNING, 'fire', 'A fireball hurts it as one of this many hit points', 0, 500, 5],
    [CRYSTAL_TUNING, 'sight', 'Sight (voxels, fog of war)', 0, 40, 1],
    [CRYSTAL_TUNING, 'hover', 'Floats over the Keep\'s roof (voxels)', 0, 3, 0.05],
    [CRYSTAL_TUNING, 'length', 'Length, tip to tip (voxels)', 0.5, 5, 0.05],
    [CRYSTAL_TUNING, 'width', 'Width (voxels)', 0.2, 3, 0.05],
    [CRYSTAL_TUNING, 'bob', 'Bob (voxels up and down)', 0, 1, 0.01],
    [CRYSTAL_TUNING, 'bobSpeed', 'Bob speed', 0, 5, 0.05],
    [CRYSTAL_TUNING, 'spin', 'Spin (radians/s)', 0, 5, 0.05],
    [CRYSTAL_TUNING, 'glow', 'Glow from within', 0, 5, 0.05],
    [CRYSTAL_TUNING, 'gemRim', 'Rim light (can go overbright)', 0, 10, 0.05],
    [CRYSTAL_TUNING, 'gemRimPower', 'Rim tightness (higher = thinner)', 0.2, 12, 0.1],
    [CRYSTAL_TUNING, 'gemReflect', 'Facet reflections', 0, 3, 0.01],
    [CRYSTAL_TUNING, 'gemSparkle', 'Sun glints on the facets', 0, 5, 0.05],
    [CRYSTAL_TUNING, 'gemIor', 'Refraction (index: glass 1.5, diamond 2.4)', 1, 3, 0.01],
    [CRYSTAL_TUNING, 'gemAbsorb', 'Colour depth inside (per voxel)', 0, 6, 0.05],
    [CRYSTAL_TUNING, 'gemSeeThrough', 'See-through (what\'s behind, tinted)', 0, 1, 0.01],
    [CRYSTAL_TUNING, 'light', 'Light on what\'s round it', 0, 20, 0.1],
    [CRYSTAL_TUNING, 'reach', 'Light\'s reach (voxels)', 5, 60, 1],
    [CRYSTAL_TUNING, 'beam', 'Beam brightness', 0, 10, 0.05],
    [CRYSTAL_TUNING, 'beamWidth', 'Beam width at the bottom (voxels)', 0.05, 3, 0.01],
    [CRYSTAL_TUNING, 'beamSpread', 'Beam widens going up (voxels per voxel)', 0, 0.2, 0.001],
    [CRYSTAL_TUNING, 'beamHeight', 'Beam height (voxels)', 10, 1000, 10],
    [CRYSTAL_TUNING, 'beamFade', 'Beam fades up over (voxels)', 1, 300, 1],
    [CRYSTAL_TUNING, 'beamEdge', 'Beam edge glow', 0, 10, 0.05],
    [CRYSTAL_TUNING, 'beamEdgePower', 'Beam edge glow tightness', 0.2, 16, 0.1],
    [CRYSTAL_TUNING, 'beamBody', 'Beam body (between its edges)', 0, 3, 0.01],
    [CRYSTAL_TUNING, 'beamStreaks', 'Beam streaks', 0, 1, 0.01],
    [CRYSTAL_TUNING, 'beamFlow', 'Beam streaks run up (voxels/s)', 0, 40, 0.5],
  ]],
  ['Possess', [
    [POSSESS_TUNING, 'fov', 'Field of view (deg, up and down)', 20, 120, 1],
    [POSSESS_TUNING, 'near', 'Near plane (voxels)', 0.01, 0.5, 0.005],
    [POSSESS_TUNING, 'far', 'Far plane (voxels)', 200, 4000, 10],
    [POSSESS_TUNING, 'headBob', 'Eyes move with the head (0 steady at eye height, 1 all its bob, lean and sway)', 0, 1, 0.01],
    [POSSESS_TUNING, 'headTurn', 'View turns with the head left and right (0 the body\'s way, 1 the head\'s)', 0, 1, 0.01],
    [POSSESS_TUNING, 'headNod', 'View turns with the head\'s nod', 0, 1, 0.01],
    [POSSESS_TUNING, 'eyeHeight', 'Eye height over the feet (steady)', 0.5, 3, 0.01],
    [POSSESS_TUNING, 'eyeUp', 'Eyes over the middle of the head (voxels)', -0.3, 0.5, 0.01],
    [POSSESS_TUNING, 'eyeForward', 'Eyes ahead of the middle of the head (voxels)', -0.5, 1, 0.01],
    [POSSESS_TUNING, 'pitch', 'Looks down by (deg; - down, + up)', -45, 45, 0.5],
    [POSSESS_TUNING, 'smooth', 'View eases after the head over (s)', 0, 0.5, 0.005],
    [POSSESS_TUNING, 'hideBody', 'Hide its whole body (0 just its head, 1 all of it)', 0, 1, 1],
    [POSSESS_TUNING, 'oneHand', 'A worker swings pickaxe, axe or shovel one-handed, off to its side (0 both hands)', 0, 1, 1],
    [POSSESS_TUNING, 'oneHandSide', 'That hand out to its right of the middle (voxels; shoulder 0.37)', 0, 0.8, 0.01],
    [POSSESS_TUNING, 'armDrop', 'Arms and what they hold drawn lower by (voxels)', 0, 0.6, 0.01],
    [POSSESS_TUNING, 'armOut', 'And further out to its right by (voxels)', -0.3, 0.6, 0.01],
    [POSSESS_TUNING, 'armBack', 'And further back by (voxels)', -0.3, 0.6, 0.01],
    [POSSESS_TUNING, 'fogStart', 'Distance fog starts at (voxels)', 0, 400, 1],
    [POSSESS_TUNING, 'dof', 'Depth of field (0 off, 1 on)', 0, 1, 1],
    [POSSESS_TUNING, 'focus', 'In focus at (voxels from the eyes)', 0, 200, 0.5],
    [POSSESS_TUNING, 'view', 'Minimap view outline and ore chunks as if zoomed to (voxels)', 10, 400, 1],
  ]],
  ['Selection', [
    [SELECT_TUNING, 'outline', 'Selected villagers\' outline (pixels, in the health bars\' just-lost colours)', 0, 8, 0.1],
    [GHOST_TUNING, 'xray', 'Marked digs seen through the ground (opacity ×, 0 off)', 0, 2, 0.05],
  ]],
  ['Forests', [
    [TREE_TUNING, 'forestLink', 'Trees this near (voxels) are one forest', 2, 20, 1],
    [TREE_TUNING, 'forestMax', 'Most trees in a forest', 20, 2000, 10],
    [TREE_TUNING, 'density', 'Trees in a forest (chance a spot; over 1 a second; new world)', 0, 2, 0.05],
    [TREE_TUNING, 'forestEdge', 'Forest where woods noise is over (new world)', 0.3, 0.95, 0.01],
    [TREE_TUNING, 'forestScale', 'Forest noise frequency (new world)', 0.5, 5, 0.1],
    [TREE_TUNING, 'lone', 'Lone trees in the open (chance a spot; new world)', 0, 0.3, 0.005],
    [WORK_TUNING, 'selfStart', 'Lumberjacks and miners find work of their own (1) or only take orders (0)', 0, 1, 1],
    [WORK_TUNING, 'seekRange', 'Lumberjacks and miners look for trees and ore this far (voxels)', 0, 120, 1],
  ]],
  ['Banners', [
    [BANNER_TUNING, 'poleTop', 'Pole\'s top, over the feet (voxels)', 2, 5, 0.05],
    [BANNER_TUNING, 'back', 'Pole behind the body (voxels)', 0.15, 0.6, 0.01],
    [BANNER_TUNING, 'flagWidth', 'Flag width (voxels)', 0.3, 2, 0.05],
    [BANNER_TUNING, 'flagHeight', 'Flag height (voxels)', 0.5, 2.5, 0.05],
    [BANNER_TUNING, 'flagDrop', 'Flag under the pole\'s top (voxels)', 0, 1, 0.01],
    [BANNER_TUNING, 'flagPoint', 'Flag\'s point (voxels)', 0, 1.5, 0.01],
    [BANNER_LOOK, 'point', 'Hung banners\' point (voxels)', 0, 1.5, 0.01],
    [BANNER_LOOK, 'flutter', 'Hung banners\' flutter (radians)', 0, 0.3, 0.005],
    [BANNER_LOOK, 'flutterSpeed', 'Hung banners\' flutter speed', 0, 10, 0.1],
    [BANNER_TUNING, 'digitPixel', 'Number\'s pixel (voxels)', 0.05, 0.4, 0.005],
    [BANNER_TUNING, 'bright', 'Number brightness (× team colour)', 0.5, 5, 0.1],
    [GROUP_TUNING, 'doubleTap', 'Double tap to go to a group (s)', 0.1, 1, 0.05],
  ]],
  ['Global illumination', [
    [GI_TUNING, 'on', 'Mode: 0 off, 1 sky visibility, 2 bounce light (L)', 0, 2, 1],
    [GI_TUNING, 'strength', 'Strength', 0, 1, 0.01],
    [GI_TUNING, 'minimum', 'Least of the plain sky light kept', 0, 1, 0.01],
    [GI_TUNING, 'bias', 'Read probes this far off the surface (voxels)', 0, 2, 0.05],
    [GI_TUNING, 'rays', 'Rays per probe (retraces all)', 8, 128, 1],
    [GI_TUNING, 'reach', 'Ray reach (voxels; retraces all)', 8, 64, 1],
    [GI_TUNING, 'leaves', 'Light through a leaf voxel (retraces all)', 0, 1, 0.01],
    [GI_TUNING, 'bounce', 'Bounce: light blocks give back', 0, 2, 0.01],
    [GI_TUNING, 'bounceRays', 'Bounce: rays per probe', 8, 128, 1],
    [GI_TUNING, 'range', 'Bounce: kept up to date within (voxels of the target)', 16, 250, 4],
    [GI_TUNING, 'perFrame', 'Bounce: probes relit there per frame', 500, 40000, 500],
    [GI_TUNING, 'torchShadows', 'Walls block torchlight (0 off, 1 on)', 0, 1, 1],
    [GI_TUNING, 'editReach', 'Edits: sky visibility retraced within (voxels)', 0, 32, 1],
    [GI_TUNING, 'editBudget', 'Edits: most probes retraced a frame', 500, 20000, 500],
  ]],
  ['Toon shading', [
    [TOON_TUNING, 'on', 'Toon shading (0 off, 1 on)', 0, 1, 1],
    [TOON_TUNING, 'bands', 'Light bands', 1, 8, 1],
    [TOON_TUNING, 'softness', 'Band edge softness', 0, 0.5, 0.01],
    [TOON_TUNING, 'grassLip', 'Grass over the top of dirt sides (voxels)', 0, 1, 0.01],
    [TOON_TUNING, 'edgeDepth', 'Terrain stroke: ground this far behind an edge (voxels)', 0.1, 10, 0.1],
    [TOON_TUNING, 'edgeGrow', 'Terrain stroke: and further per voxel from the eye', 0, 0.1, 0.001],
    [TOON_TUNING, 'edgeWidth', 'Terrain stroke width (pixels)', 0.5, 6, 0.1],
    [TOON_TUNING, 'edgeMode', 'Terrain stroke mode (0 drop-off, 1 Sobel)', 0, 1, 1],
    [TOON_TUNING, 'sobelNormal', 'Sobel: stroke where normals turn this much (0 depth only)', 0, 2, 0.01],
    [TOON_TUNING, 'edgeStrength', 'Terrain stroke strength (depth)', 0, 1, 0.01],
    [TOON_TUNING, 'creaseStrength', 'Sobel: crease stroke strength (normals)', 0, 1, 0.01],
    [TOON_TUNING, 'ao', 'Ambient occlusion strength (1 as without toon)', 0, 3, 0.01],
    [TOON_TUNING, 'edgeColor', 'Terrain stroke colour', 'color'],
    [TOON_TUNING, 'unitOutline', 'Villager outline width (pixels)', 0, 6, 0.1],
    [TOON_TUNING, 'unitColor', 'Villager outline colour', 'color'],
  ]],
  ['Bloom & depth of field', [
    [POST_TUNING, 'bloom', 'Bloom strength', 0, 2, 0.01],
    [POST_TUNING, 'threshold', 'Bloom threshold (brightness)', 0, 1, 0.01],
    [POST_TUNING, 'bloomRadius', 'Bloom spread', 0, 1, 0.01],
    [POST_TUNING, 'dofBlur', 'Depth of field blur (pixels)', 0, 16, 0.5],
    [POST_TUNING, 'dofFocus', 'Focus nearer / further than the target (voxels)', -100, 100, 1],
    [POST_TUNING, 'dofRange', 'Sharp range (voxels)', 1, 200, 1],
  ]],
  // Each class's stats, with how hard its weapon's killing blow knocks a body about and what of its kit may come off.
  ['Worker', [
    [COMBAT_TUNING, 'workerHp', 'Hit points (new ones)', 1, 200, 1],
    [UNIT_TUNING, 'workerSpeed', 'Move speed (voxels/s)', 0.5, 12, 0.1],
    [WORK_TUNING, 'digTime', 'Dig time (s a voxel)', 0.05, 3, 0.01],
    [WORK_TUNING, 'fillTime', 'Build time (s a voxel filled or placed)', 0.05, 3, 0.01],
    [WORK_TUNING, 'jobRange', 'Pile and seeking range (voxels: piles, and what seeking workers marked; orders: any range)', 1, 200, 1],
    [WORK_TUNING, 'preferEvery', 'Seconds between a specialist on other work looking for its own kind', 0.1, 10, 0.1],
    [WORK_TUNING, 'closeFirst', 'Works right beside the voxel when it can get there (1), or from anywhere in reach (0)', 0, 1, 1],
    [WORK_TUNING, 'island', 'Cells of dry land a worker keeps to walk on (won\'t dig ground into the water that leaves it less)', 0, 200, 1],
    [COMBAT_TUNING, 'drownDamage', 'Drowning: hit points a second one stuck in the water loses (any villager)', 0, 100, 0.5],
    [RAGDOLL_TUNING, 'drownKick', 'Drowned body push (voxels/s)', 0, 30, 0.1],
    [RAGDOLL_TUNING, 'drownLift', 'Drowned body lift (voxels/s)', 0, 25, 0.1],
    [RAGDOLL_TUNING, 'drownSpin', 'Drowned body tip over (rad/s)', 0, 30, 0.1],
    [WORK_TUNING, 'inTheWay', 'How much further a spot to work from counts where a block is still to go at its feet or head (so it doesn\'t get built in)', 0, 200, 5],
  ]],
  ['Farming', [
    [FARM_TUNING, 'growTime', 'Wheat grow time (s from sowing to ripe)', 1, 300, 1],
    [FARM_TUNING, 'yield', 'Yield (wheat a ripe farm gives)', 0, 20, 1],
    [FARM_TUNING, 'tillTime', 'Till time (s a farm)', 0.05, 5, 0.05],
    [FARM_TUNING, 'reapTime', 'Reap time (s a farm)', 0.05, 5, 0.05],
    [FARM_TUNING, 'height', 'Ripe wheat height (voxels)', 0, 2, 0.01],
    [FARM_TUNING, 'width', 'Stalk and leaf width', 0.2, 3, 0.01],
    [FARM_TUNING, 'sway', 'Sway in the wind', 0, 4, 0.01],
    [FARM_TUNING, 'youngColor', 'Young wheat colour', 'color'],
    [FARM_TUNING, 'ripeColor', 'Ripe wheat colour', 'color'],
    [FARM_TUNING, 'outline', 'Outline (pixels)', 0, 4, 0.05],
    [FARM_TUNING, 'youngOutline', 'Young outline colour', 'color'],
    [FARM_TUNING, 'ripeOutline', 'Ripe outline colour', 'color'],
  ]],
  ['Warrior', [
    [COMBAT_TUNING, 'warriorHp', 'Hit points (new ones)', 1, 200, 1],
    [UNIT_TUNING, 'warriorSpeed', 'Move speed (voxels/s)', 0.5, 12, 0.1],
    [COMBAT_TUNING, 'swordDamage', 'Sword damage (hit points)', 0, 20, 0.1],
    [COMBAT_TUNING, 'attackTime', 'Sword swing (s)', 0.2, 3, 0.05],
    [COMBAT_TUNING, 'range', 'Sword reach (voxels)', 1, 3, 0.05],
    [COMBAT_TUNING, 'aggro', 'Aggro range (voxels)', 0, 20, 0.5],
    [RAGDOLL_TUNING, 'swordKick', 'Sword kill knockback (voxels/s)', 0, 30, 0.1],
    [RAGDOLL_TUNING, 'swordLift', 'Sword kill knock up (voxels/s)', 0, 25, 0.1],
    [RAGDOLL_TUNING, 'swordSpin', 'Sword kill spin (rad/s)', 0, 30, 0.1],
    [RAGDOLL_TUNING, 'helmet', 'Helmet off chance (always with the head)', 0, 1, 0.01],
    [RAGDOLL_TUNING, 'pauldron', 'Pauldron off chance', 0, 1, 0.01],
    [RAGDOLL_TUNING, 'boot', 'Boot off chance', 0, 1, 0.01],
  ]],
  ['Archer', [
    [COMBAT_TUNING, 'archerHp', 'Hit points (new ones)', 1, 200, 1],
    [UNIT_TUNING, 'archerSpeed', 'Move speed (voxels/s)', 0.5, 12, 0.1],
    [COMBAT_TUNING, 'arrowDamage', 'Arrow damage (hit points)', 0, 30, 0.1],
    [COMBAT_TUNING, 'bowRange', 'Bow range (voxels)', 2, 60, 1],
    [COMBAT_TUNING, 'shootTime', 'Bow draw (s)', 0.2, 5, 0.05],
    [COMBAT_TUNING, 'arrowSpeed', 'Arrow speed (voxels/s)', 4, 60, 1],
    [COMBAT_TUNING, 'arrowMiss', 'Arrow miss chance', 0, 1, 0.01],
    [COMBAT_TUNING, 'arrowStick', 'Arrows stay stuck (s, and missed spears)', 0, 30, 0.5],
    [RAGDOLL_TUNING, 'arrowKick', 'Arrow kill knockback (voxels/s)', 0, 30, 0.1],
    [RAGDOLL_TUNING, 'arrowLift', 'Arrow kill knock up (voxels/s)', 0, 25, 0.1],
    [RAGDOLL_TUNING, 'arrowSpin', 'Arrow kill spin (rad/s)', 0, 30, 0.1],
  ]],
  ['Spearman', [
    [COMBAT_TUNING, 'spearmanHp', 'Hit points (new ones)', 1, 200, 1],
    [UNIT_TUNING, 'spearmanSpeed', 'Move speed (voxels/s)', 0.5, 12, 0.1],
    [COMBAT_TUNING, 'spearDamage', 'Spear damage (hit points)', 0, 50, 0.1],
    [COMBAT_TUNING, 'spearRange', 'Throw range (voxels)', 2, 40, 1],
    [COMBAT_TUNING, 'throwTime', 'Reload (s)', 0.5, 10, 0.05],
    [COMBAT_TUNING, 'spearSpeed', 'Spear speed (voxels/s)', 4, 40, 1],
    [RAGDOLL_TUNING, 'spearKick', 'Spear kill knockback (voxels/s)', 0, 30, 0.1],
    [RAGDOLL_TUNING, 'spearLift', 'Spear kill knock up (voxels/s)', 0, 25, 0.1],
    [RAGDOLL_TUNING, 'spearSpin', 'Spear kill spin (rad/s)', 0, 30, 0.1],
    [RAGDOLL_TUNING, 'wingedHelmet', 'Winged helmet off chance (always with the head)', 0, 1, 0.01],
  ]],
  ['Fire mage', [
    [COMBAT_TUNING, 'mageHp', 'Hit points (new ones)', 1, 200, 1],
    [UNIT_TUNING, 'mageSpeed', 'Move speed (voxels/s)', 0.5, 12, 0.1],
    [COMBAT_TUNING, 'fireDamage', 'Fireball damage near the burst (% of full hit points)', 0, 100, 1],
    [COMBAT_TUNING, 'fireFull', 'Full damage within (voxels of the burst)', 0, 6, 0.1],
    [COMBAT_TUNING, 'fireEdge', 'Damage at the blast edge (% of full hit points)', 0, 100, 1],
    [COMBAT_TUNING, 'fireBlast', 'Blast radius (voxels)', 0, 8, 0.1],
    [COMBAT_TUNING, 'fireRange', 'Range (voxels)', 2, 60, 1],
    [COMBAT_TUNING, 'castTime', 'Reload (s)', 0.5, 10, 0.05],
    [COMBAT_TUNING, 'fireSpeed', 'Fireball speed (voxels/s)', 2, 40, 1],
    [RAGDOLL_TUNING, 'fireKick', 'Fireball kill knockback (voxels/s)', 0, 30, 0.1],
    [RAGDOLL_TUNING, 'fireLift', 'Fireball kill knock up (voxels/s)', 0, 25, 0.1],
    [RAGDOLL_TUNING, 'fireSpin', 'Fireball kill spin (rad/s)', 0, 30, 0.1],
    [RAGDOLL_TUNING, 'hat', 'Hat off chance (always with the head)', 0, 1, 0.01],
  ]],
  ['Priest', [
    [COMBAT_TUNING, 'priestHp', 'Hit points (new ones)', 1, 200, 1],
    [UNIT_TUNING, 'priestSpeed', 'Move speed (voxels/s)', 0.5, 12, 0.1],
    [COMBAT_TUNING, 'healAmount', 'Beam heals (hit points each tick)', 0, 20, 0.1],
    [COMBAT_TUNING, 'healTick', 'Beam heal tick (s)', 0.05, 5, 0.05],
    [COMBAT_TUNING, 'beamRange', 'Beam range (voxels)', 1, 40, 0.5],
    [COMBAT_TUNING, 'healSeek', 'Goes for the most hurt ally within (voxels)', 0, 60, 1],
    [COMBAT_TUNING, 'switchTime', 'Beam waits after changing target (s)', 0, 5, 0.05],
    [COMBAT_TUNING, 'switchMargin', 'Changes target when another is this much more hurt (share)', 0, 1, 0.01],
    [COMBAT_TUNING, 'beamWidth', 'Beam width (voxels)', 0.01, 0.5, 0.01],
    [COMBAT_TUNING, 'beamColor', 'Beam colour', 'color'],
    [COMBAT_TUNING, 'beamGlow', 'Beam brightness (× its colour; past 1 blooms towards white)', 0, 6, 0.05],
    [COMBAT_TUNING, 'plasma', 'Plasma wisps (per voxel of beam per s)', 0, 60, 1],
    [COMBAT_TUNING, 'plasmaSize', 'Plasma wisp size (voxels)', 0.02, 1, 0.01],
    [COMBAT_TUNING, 'plasmaLife', 'Plasma wisp life (s)', 0.05, 3, 0.05],
    [COMBAT_TUNING, 'plasmaGlow', 'Plasma wisp brightness', 0, 5, 0.05],
    [COMBAT_TUNING, 'plasmaDrift', 'Plasma wisp drift (voxels/s)', 0, 3, 0.05],
  ]],
  ['Barbarian', [
    [COMBAT_TUNING, 'barbarianHp', 'Hit points (new ones)', 1, 200, 1],
    [UNIT_TUNING, 'barbarianSpeed', 'Move speed (voxels/s)', 0.5, 12, 0.1],
    [COMBAT_TUNING, 'whirlRange', 'Whirls with an enemy this near (voxels)', 0.5, 8, 0.1],
    [COMBAT_TUNING, 'axeReach', 'Axe reach (voxels, hits every enemy within)', 0.5, 6, 0.1],
    [COMBAT_TUNING, 'axeDamage', 'Axe damage (hit points a hit)', 0, 20, 0.1],
    [COMBAT_TUNING, 'whirlTime', 'Time between hits (s)', 0.05, 3, 0.05],
    [COMBAT_TUNING, 'whirlSpin', 'Spin (turns/s)', 0.2, 8, 0.1],
    [TRAIL_TUNING, 'arc', 'Axe trail length (turns)', 0, 1, 0.01],
    [TRAIL_TUNING, 'opacity', 'Axe trail opacity', 0, 1, 0.01],
    [TRAIL_TUNING, 'color', 'Axe trail colour', 'color'],
    [RAGDOLL_TUNING, 'axeKick', 'Axe kill knockback (voxels/s)', 0, 30, 0.1],
    [RAGDOLL_TUNING, 'axeLift', 'Axe kill knock up (voxels/s)', 0, 25, 0.1],
    [RAGDOLL_TUNING, 'axeSpin', 'Axe kill spin (rad/s)', 0, 30, 0.1],
  ]],
  ['Mounted', [
    [COMBAT_TUNING, 'knightHp', 'Knight hit points (new ones; fights as a warrior)', 1, 300, 1],
    [UNIT_TUNING, 'knightSpeed', 'Knight move speed (voxels/s)', 0.5, 16, 0.1],
    [COMBAT_TUNING, 'scoutHp', 'Scout hit points (new ones; fights as an archer)', 1, 300, 1],
    [UNIT_TUNING, 'scoutSpeed', 'Scout move speed (voxels/s)', 0.5, 16, 0.1],
    [MOUNT_TUNING, 'lift', 'Rider sits up (voxels)', 0, 1.5, 0.01],
    [MOUNT_TUNING, 'legPitch', 'Rider legs forward (rad)', -1.5, 1, 0.01],
    [MOUNT_TUNING, 'legSplay', 'Rider legs out (rad)', 0, 1.2, 0.01],
    [MOUNT_TUNING, 'gait', 'Trot speed (per villager stride)', 0.2, 5, 0.05],
    [MOUNT_TUNING, 'stride', 'Horse leg swing (rad)', 0, 1.2, 0.01],
    [MOUNT_TUNING, 'knee', 'Horse leg fold (rad)', 0, 2, 0.01],
    [MOUNT_TUNING, 'bob', 'Trot bob (voxels)', 0, 0.3, 0.005],
    [MOUNT_TUNING, 'fallKick', "Dead horse knocked (x rider's knock)", 0, 2, 0.05],
    [MOUNT_TUNING, 'fallSpin', 'Dead horse rolls over (rad/s)', 0, 8, 0.1],
    [MOUNT_TUNING, 'ragSpring', 'Dead horse joints pull back to standing', 0, 5, 0.05],
    [MOUNT_TUNING, 'ragGrip', 'Dead horse grips the ground', 0, 1, 0.01],
    [MOUNT_TUNING, 'knightCoat', 'Knight horse coat', 'color'],
    [MOUNT_TUNING, 'knightMane', 'Knight horse mane and tail', 'color'],
    [MOUNT_TUNING, 'knightMuzzle', 'Knight horse muzzle', 'color'],
    [MOUNT_TUNING, 'trim', 'Barding trim and spike', 'color'],
    [MOUNT_TUNING, 'scoutCoat', 'Scout horse coat', 'color'],
    [MOUNT_TUNING, 'scoutMane', 'Scout horse mane, tail and muzzle', 'color'],
    [MOUNT_TUNING, 'socks', 'Scout horse socks', 'color'],
  ]],
  ['Editor', [
    [SPAWN_TUNING, 'color', 'Spawn point colour', 'color'],
    [SPAWN_TUNING, 'glow', 'Spawn point glow (past 1 blooms)', 0, 5, 0.05],
    [EDITOR_TUNING, 'groundHeight', 'Flat ground height (when Editor starts)', WATER_LEVEL + 1, 60, 1],
  ]],
  ['Obsidian', [
    [OBSIDIAN_LOOK, 'color', 'Colour', 'color'],
    [OBSIDIAN_LOOK, 'grain', 'Stone grain showing', 0, 1, 0.01],
    [OBSIDIAN_LOOK, 'glint', 'Glassy glint at grazing angles', 0, 1, 0.01],
  ]],
  ['Ore', [
    [ORE_LOOK, 'ironColor', 'Iron chunk colour', 'color'],
    [ORE_LOOK, 'goldColor', 'Gold chunk colour', 'color'],
    [ORE_LOOK, 'ironShine', 'Iron glint (own colour, 0-1)', 0, 1, 0.01],
    [ORE_LOOK, 'goldShine', 'Gold glint (own colour, 0-1)', 0, 1, 0.01],
    [ORE_LOOK, 'reflection', 'Metal reflections', 0, 2, 0.01],
    [ORE_LOOK, 'envGain', 'Reflection brightness', 0, 3, 0.01],
    [ORE_LOOK, 'sunSpot', 'Sun highlight', 0, 20, 0.1],
    [ORE_LOOK, 'sunSharp', 'Sun highlight tightness', 4, 2000, 1],
    [ORE_LOOK, 'envHeight', 'Reflected view height (voxels)', 1, 60, 0.5],
    [ORE_LOOK, 'envEvery', 'Reflection rebake (s)', 1, 60, 1],
    [ORE_LOOK, 'envSize', 'Reflection map size', 32, 512, 32],
    [ORE_LOOK, 'glints', 'Metal glints', 0, 3, 0.01],
    [ORE_LOOK, 'glintSpeed', 'Glints flash (speed)', 0, 4, 0.01],
    [ORE_LOOK, 'size', 'Chunk size', 0.3, 2.5, 0.05],
    [ORE_LOOK, 'reach', 'Drawn out to (voxels past the zoom)', 20, 400, 5],
  ]],
  ['Training costs', [...Object.entries({ warrior: 'Warrior', barbarian: 'Barbarian', archer: 'Archer', spearman: 'Spearman', mage: 'Fire mage', priest: 'Priest', scout: 'Scout', knight: 'Knight' })
    .flatMap(([k, name]) => ['gold', 'iron', 'planks', 'wheat'].map((c) => [TRAINING_COST[k], c, `${name}: ${c} (new game)`, 0, 100, 1])),
    ...Object.keys(BUILD_EXTRA).flatMap((k) => ['gold', 'iron'].map((c) => [BUILD_EXTRA[k], c, `${BUILT_IN_DESIGNS[k]?.name ?? k} building: ${c} on top of its blocks (new game)`, 0, 100, 1]))]],
  ['Production', [
    [POP_TUNING, 'keep', 'Population room the Keep gives (new game)', 0, 50, 1],
    [POP_TUNING, 'house', 'Population room each house gives (new game)', 0, 50, 1],
    [PRODUCTION_TUNING, 'worker', 'Worker training (s, Keep)', 0, 60, 0.5],
    [PRODUCTION_TUNING, 'warrior', 'Warrior training (s, Barracks)', 0, 60, 0.5],
    [PRODUCTION_TUNING, 'barbarian', 'Barbarian training (s, Barracks)', 0, 60, 0.5],
    [PRODUCTION_TUNING, 'archer', 'Archer training (s, Archery Range)', 0, 60, 0.5],
    [PRODUCTION_TUNING, 'spearman', 'Spearman training (s, Archery Range)', 0, 60, 0.5],
    [PRODUCTION_TUNING, 'mage', 'Fire mage training (s, Mage Tower)', 0, 60, 0.5],
    [PRODUCTION_TUNING, 'priest', 'Priest training (s, Mage Tower)', 0, 60, 0.5],
    [PRODUCTION_TUNING, 'scout', 'Scout training (s, Stables)', 0, 60, 0.5],
    [PRODUCTION_TUNING, 'knight', 'Knight training (s, Stables)', 0, 60, 0.5],
  ]],
  ['Walls', [
    [WALL_TUNING, 'height', 'Height of a wall (voxels; new orders)', 1, 8, 1],
    [WALL_TUNING, 'woodHp', 'Hit points of a section of wood wall', 10, 2000, 10],
    [WALL_TUNING, 'stoneHp', 'Hit points of a section of stone wall', 10, 2000, 10],
    [WALL_TUNING, 'fire', 'Hit points a fireball takes off a section at its middle', 0, 500, 5],
    [WALL_TUNING, 'maxLength', 'Longest wall in one drag (voxels)', 4, 200, 1],
    [WALL_TUNING, 'every', 'Sections from torch to torch, a banner halfway (0: none; new orders)', 0, 20, 1],
    [WALL_TUNING, 'sight', 'How far a built section sees (fog of war)', 0, 20, 1],
    [GATE_TUNING, 'iron', 'Portcullis: iron it costs (new game)', 0, 20, 1],
    [GATE_TUNING, 'buildTime', 'Portcullis: seconds a worker takes to make one', 0.1, 30, 0.1],
    [GATE_TUNING, 'hp', 'Portcullis: hit points, as a share of the wall\'s', 0.05, 2, 0.05],
    [GATE_TUNING, 'near', 'Portcullis: voxels from it a unit of its team raises it', 0.5, 8, 0.1],
    [GATE_TUNING, 'speed', 'Portcullis: how fast it rises and falls (full travels a second)', 0.1, 5, 0.05],
    [GATE_TUNING, 'color', 'Portcullis: its iron', 'color'],
  ]],
  ['Ladders', [
    [LADDER_TUNING, 'climbSpeed', 'Voxels a second a worker climbs a ladder', 0.5, 8, 0.1],
    [LADDER_TUNING, 'buildTime', 'Seconds a worker takes to fix each rung', 0.05, 3, 0.05],
    [LADDER_TUNING, 'trapped', 'Sandbox (no Keep): a worker that can walk to fewer cells than this is stuck and builds a ladder out', 10, 1000, 10],
    [LADDER_TUNING, 'maxHeight', 'Tallest ladder a worker builds (voxels)', 2, 60, 1],
    [LADDER_TUNING, 'every', 'Seconds between a stuck worker\'s looks for where to build one', 0.5, 10, 0.5],
  ]],
  ['Carrying', [
    [CARRY_TUNING, 'planks', 'Planks a worker carries at once', 1, 50, 1],
    [CARRY_TUNING, 'bricks', 'Bricks a worker carries at once', 1, 50, 1],
    [CARRY_TUNING, 'clay', 'Clay a worker carries at once', 1, 50, 1],
    [CARRY_TUNING, 'ore', 'Iron or gold a worker carries at once', 1, 50, 1],
    [CARRY_TUNING, 'wheat', 'Wheat a worker carries at once', 1, 50, 1],
    [CARRY_LOOK, 'lean', 'Leans back carrying (radians)', 0, 0.6, 0.01],
    [CARRY_LOOK, 'arm', 'Arms out in front (radians)', 0, 2, 0.01],
    [CARRY_LOOK, 'height', 'Load\'s height (from the feet)', 0.5, 1.6, 0.01],
    [CARRY_LOOK, 'out', 'Load\'s distance in front', 0, 0.8, 0.01],
  ]],
  ['Inventory', [
    [INVENTORY_TUNING, 'stoneBricks', 'Bricks a stone block mined gives', 0, 16, 1],
    [INVENTORY_TUNING, 'logPlanks', 'Planks a log gives', 0, 16, 1],
    [INVENTORY_TUNING, 'dirtClay', 'Clay bricks a dirt block gives', 0, 16, 1],
    [INVENTORY_TUNING, 'startWorkers', 'Workers to start with', 1, 20, 1],
    [INVENTORY_TUNING, 'startDirt', 'Clay bricks to start with', 0, 500, 1],
    [INVENTORY_TUNING, 'startBricks', 'Bricks to start with', 0, 500, 1],
    [INVENTORY_TUNING, 'startPlanks', 'Planks to start with', 0, 500, 1],
  ]],
  ['Army strength', [
    [STRENGTH_TUNING, 'worker', 'Worker points', 0, 10, 0.5],
    [STRENGTH_TUNING, 'priest', 'Priest points', 0, 10, 0.5],
    [STRENGTH_TUNING, 'spearman', 'Spearman points', 0, 10, 0.5],
    [STRENGTH_TUNING, 'warrior', 'Warrior points', 0, 10, 0.5],
    [STRENGTH_TUNING, 'barbarian', 'Barbarian points', 0, 10, 0.5],
    [STRENGTH_TUNING, 'archer', 'Archer points', 0, 10, 0.5],
    [STRENGTH_TUNING, 'mage', 'Fire mage points', 0, 10, 0.5],
    [STRENGTH_TUNING, 'scout', 'Scout points', 0, 10, 0.5],
    [STRENGTH_TUNING, 'knight', 'Knight points', 0, 10, 0.5],
    [STRENGTH_TUNING, 'ease', 'Pie slides to a new split (per s; 0 jumps)', 0, 30, 0.5],
    [STRENGTH_TUNING, 'blueColor', 'Blue fill', 'color'],
    [STRENGTH_TUNING, 'redColor', 'Red fill', 'color'],
    [STRENGTH_TUNING, 'yellowColor', 'Yellow fill', 'color'],
    [STRENGTH_TUNING, 'purpleColor', 'Purple fill', 'color'],
  ]],
  ['Minimap', [
    [MINIMAP_TUNING, 'on', 'Minimap (0 off, 1 on)', 0, 1, 1],
    [MINIMAP_TUNING, 'size', 'Size (pixels)', 100, 480, 2],
    [MINIMAP_TUNING, 'rotate', 'Turns with the camera (0 fixed, 1 turns: the view always up)', 0, 1, 1],
    [MINIMAP_TUNING, 'maxZoom', 'Most zoom (× the whole map)', 1, 32, 0.5],
    [MINIMAP_TUNING, 'zoomStep', 'Zoom per wheel notch or + / - click (×)', 1.05, 3, 0.05],
    [MINIMAP_TUNING, 'follow', 'Zoomed in: keeps the camera within this share of the middle', 0, 0.5, 0.01],
    [MINIMAP_TUNING, 'dot', 'Unit dot radius (pixels)', 0.5, 8, 0.1],
    [MINIMAP_TUNING, 'pick', 'A click this near a dot is on it (pixels)', 1, 20, 0.5],
    [MINIMAP_TUNING, 'relief', 'Hill shading', 0, 3, 0.01],
    [MINIMAP_TUNING, 'heightShade', 'Higher ground lighter', 0, 1.5, 0.01],
    [MINIMAP_TUNING, 'opacity', 'Opacity', 0.2, 1, 0.01],
    [MINIMAP_TUNING, 'refresh', 'Rows re-read a frame (besides those edited)', 0, 64, 1],
    [MINIMAP_TUNING, 'ping', 'Order ping lasts (s)', 0, 4, 0.05],
    [MINIMAP_TUNING, 'viewColor', 'Camera view outline', 'color'],
    [MINIMAP_TUNING, 'blue', 'Blue dots and buildings', 'color'],
    [MINIMAP_TUNING, 'red', 'Red', 'color'],
    [MINIMAP_TUNING, 'yellow', 'Yellow', 'color'],
    [MINIMAP_TUNING, 'purple', 'Purple', 'color'],
    [MINIMAP_TUNING, 'grass', 'Grass', 'color'],
    [MINIMAP_TUNING, 'sand', 'Sand', 'color'],
    [MINIMAP_TUNING, 'stone', 'Stone and ore', 'color'],
    [MINIMAP_TUNING, 'trees', 'Trees', 'color'],
    [MINIMAP_TUNING, 'built', 'Bricks and planks', 'color'],
    [MINIMAP_TUNING, 'wall', 'Obsidian wall', 'color'],
    [MINIMAP_TUNING, 'farm', 'Farmland', 'color'],
    [MINIMAP_TUNING, 'water', 'Shallow water', 'color'],
    [MINIMAP_TUNING, 'deep', 'Deep water', 'color'],
  ]],
  ['HUD', [
    [HUD_TUNING, 'edgePan', 'Screen edge moves the camera (0 off, 1 on)', 0, 1, 1],
    [HUD_TUNING, 'edgeMargin', 'The edge is this wide (pixels)', 1, 40, 1],
    [HUD_TUNING, 'edgeSpeed', 'Edge pan speed (× the arrow keys\')', 0.1, 3, 0.05],
    [HUD_TUNING, 'threatLast', 'A threat stays pinned this long after its last blow (s)', 3, 60, 1],
    [HUD_TUNING, 'attackWindow', 'Crystal loss shown over the last (s)', 1, 20, 0.5],
    [HUD_TUNING, 'attackRadius', 'Enemies this near your crystal count as attacking it (voxels)', 4, 60, 1],
    [HUD_TUNING, 'eventsShown', 'Older events shown when opened', 2, 20, 1],
  ]],
  ['Main menu', [
    [MENU_TUNING, 'spin', 'The world behind it turns at (radians/s)', 0, 0.5, 0.005],
  ]],
  ['HDR output', [ // (the main menu's HDR toggle; on an HDR screen only)
    [HDR_TUNING, 'peak', 'Brightest it goes (times SDR white)', 1, 10, 0.1],
    [HDR_TUNING, 'gain', 'How much brighter what\'s over white gets (1 as drawn)', 0, 4, 0.05],
  ]],
  ['Fog of war', [
    [FOG_TUNING, 'voidColor', 'Never seen: colour there', 'color'],
    [FOG_TUNING, 'voidMix', 'Never seen: how much of that colour (0 the sky)', 0, 1, 0.01],
    [FOG_TUNING, 'bare', 'Never seen: no trees or buildings drawn near its edge (0 off, 1 on)', 0, 1, 1],
    [FOG_TUNING, 'feather', 'Never-seen edge softness', 0, 0.5, 0.01],
    [FOG_TUNING, 'edge', 'Never-seen edge smoothed over (voxels)', 0.5, 10, 0.1],
    [FOG_TUNING, 'sight', 'Villagers see at least (voxels; further with a longer range)', 1, 40, 0.5],
    [FOG_TUNING, 'dither', 'Per-column ragged sight (voxels in and out, 0 round)', 0, 12, 0.1],
    [FOG_TUNING, 'speckle', 'Per-column ragged: speckled (1) or wavy (0)', 0, 1, 0.01],
    ...Object.keys(BUILDING_SIGHT).map((k) => [BUILDING_SIGHT, k, `${BUILT_IN_DESIGNS[k]?.name ?? k} sees round its footprint (voxels)`, 0, 120, 0.5]),
    [FOG_TUNING, 'buildingSight', 'Saved designs see round their footprint (voxels)', 0, 120, 0.5],
    [LOOKOUT_TUNING, 'boost', 'A unit on a Lookout Tower\'s platform sees this many times as far', 1, 6, 0.1],
    [FOG_TUNING, 'lowGain', 'Sees further over lower ground (voxels per voxel lower)', 0, 5, 0.05],
    [FOG_TUNING, 'lowMax', 'But no further than (voxels more)', 0, 100, 1],
    [FOG_TUNING, 'highLoss', 'Sees less far up higher ground (voxels per voxel higher)', 0, 5, 0.05],
    [FOG_TUNING, 'every', 'Worked out every (s)', 0.02, 1, 0.01],
    [FOG_TUNING, 'seenDark', 'Seen-before land: darker by (0 full brightness)', 0, 1, 0.01],
    [FOG_TUNING, 'seenDesat', 'Seen-before land: desaturated by (0 full colour)', 0, 1, 0.01],
    [FOG_TUNING, 'seenEdge', 'Seen-before edge smoothed over (voxels)', 0.5, 10, 0.1],
    [FOG_TUNING, 'seenFeather', 'Seen-before edge softness (0.5 a fade over all of it)', 0, 0.5, 0.01],
    [FOG_TUNING, 'mapSeen', 'Seen-before brightness on the minimap', 0, 1, 0.01],
  ]],
  ['Health bars', [
    [HEALTHBAR_TUNING, 'width', 'Width (voxels)', 0.2, 3, 0.05],
    [HEALTHBAR_TUNING, 'height', 'Thickness (voxels)', 0.02, 0.5, 0.01],
    [HEALTHBAR_TUNING, 'above', 'Height above the head (voxels)', -1, 2, 0.05],
    [HEALTHBAR_TUNING, 'crystal', 'Power crystal\'s bar: times as long and thick', 0.5, 5, 0.1],
    [HEALTHBAR_TUNING, 'opacity', 'Opacity', 0, 1, 0.01],
    [HEALTHBAR_TUNING, 'backColor', 'Back colour', 'color'],
    [HEALTHBAR_TUNING, 'hotBlue', 'Just-lost colour (blue team)', 'color'],
    [HEALTHBAR_TUNING, 'hotRed', 'Just-lost colour (red team)', 'color'],
    [HEALTHBAR_TUNING, 'hotYellow', 'Just-lost colour (yellow team)', 'color'],
    [HEALTHBAR_TUNING, 'hotPurple', 'Just-lost colour (purple team)', 'color'],
    [HEALTHBAR_TUNING, 'hotFade', 'Just-lost cools to white (per s)', 0, 20, 0.1],
    [HEALTHBAR_TUNING, 'trail', 'Just-lost catches up (per s)', 0.2, 20, 0.1],
    [HEALTHBAR_TUNING, 'pulse', 'Just-lost pulses before shrinking (s)', 0, 2, 0.01],
    [HEALTHBAR_TUNING, 'pulseGlow', 'Pulse glow', 1, 10, 0.1],
    [HEALTHBAR_TUNING, 'pulseSwell', 'Pulse swell (× thickness)', 0, 3, 0.05],
  ]],
  ['Hit feedback', [
    [HIT_TUNING, 'flash', 'White flash (s)', 0, 1, 0.01],
    [HIT_TUNING, 'flashStrength', 'Flash whiteness', 0, 1, 0.01],
    [HIT_TUNING, 'freeze', 'Hit-freeze (s)', 0, 0.5, 0.005],
    [HIT_TUNING, 'knock', 'Knockback (voxels)', 0, 1, 0.01],
    [HIT_TUNING, 'knockTime', 'Knockback time, out and back (s)', 0.02, 1, 0.01],
  ]],
  ['Eyes', [
    [EYE_TUNING, 'blinkMin', 'Blinks at least every (s)', 0.2, 20, 0.1],
    [EYE_TUNING, 'blinkMax', 'Blinks at most every (s)', 0.2, 30, 0.1],
    [EYE_TUNING, 'blinkTime', 'Blink takes (s)', 0.02, 1, 0.01],
    [EYE_TUNING, 'closed', 'Shut eye height left (0-1)', 0, 1, 0.01],
    [EYE_TUNING, 'wince', 'Wince from a blow (s)', 0, 3, 0.01],
    [EYE_TUNING, 'winceShut', 'Wince: shutting share', 0.01, 1, 0.01],
    [EYE_TUNING, 'winceOpen', 'Wince: opening share', 0.01, 1, 0.01],
    [EYE_TUNING, 'winceTilt', 'Wince: eyes turn in (degrees)', 0, 60, 1],
    [EYE_TUNING, 'cross', 'Dead X: square size (voxels)', 0.01, 0.06, 0.001],
  ]],
  ['Looks', [
    [LOOK_TUNING, 'hairStyle', 'Everyone\'s hairstyle (-1 each their own; 0 buzz, 1 crop, 2 spiky, 3 mop, 4 ponytail, 5 bun, 6 braid, 7 long)', -1, HAIRSTYLE_COUNT - 1, 1],
    [LOOK_TUNING, 'hairColour', 'Everyone\'s hair colour (-1 each their own, else 0-6 below)', -1, HAIR_COLOURS - 1, 1],
    [LOOK_TUNING, 'skinTone', 'Everyone\'s skin tone (-1 each their own, else 0-4 below)', -1, SKIN_TONES - 1, 1],
    [LOOK_TUNING, 'skin0', 'Skin 0 (fair)', 'color'],
    [LOOK_TUNING, 'skin1', 'Skin 1 (light)', 'color'],
    [LOOK_TUNING, 'skin2', 'Skin 2 (tan)', 'color'],
    [LOOK_TUNING, 'skin3', 'Skin 3 (brown)', 'color'],
    [LOOK_TUNING, 'skin4', 'Skin 4 (deep brown)', 'color'],
    [LOOK_TUNING, 'hair0', 'Hair 0 (light brown)', 'color'],
    [LOOK_TUNING, 'hair1', 'Hair 1 (dark brown)', 'color'],
    [LOOK_TUNING, 'hair2', 'Hair 2 (dark blond)', 'color'],
    [LOOK_TUNING, 'hair3', 'Hair 3 (blond)', 'color'],
    [LOOK_TUNING, 'hair4', 'Hair 4 (auburn)', 'color'],
    [LOOK_TUNING, 'hair5', 'Hair 5 (grey)', 'color'],
    [LOOK_TUNING, 'hair6', 'Hair 6 (black)', 'color'],
    [LOOK_TUNING, 'darkEyes', 'Eyes on the deepest skin tone (skin 4)', 'color'],
    [LOOK_TUNING, 'harness', 'Barbarian chest straps (0 off, 1 on)', 0, 1, 1],
    [LOOK_TUNING, 'sashTop', 'Sash (body A): width over the shoulder', 0.06, 0.4, 0.01],
    [LOOK_TUNING, 'sashBottom', 'Sash: width at the waist', 0.1, 0.5, 0.01],
    [LOOK_TUNING, 'sashLean', 'Sash: lean in towards the middle (rad)', -0.6, 0.3, 0.01],
    [LOOK_TUNING, 'bodyType', 'Body type (-1 each their own, 0 all A, 1 all B)', -1, 1, 1],
    [LOOK_TUNING, 'waistWidth', 'Body B: waist width (voxels)', 0.2, 0.6, 0.01],
    [LOOK_TUNING, 'waistDepth', 'Body B: waist depth', 0.18, 0.45, 0.01],
    [LOOK_TUNING, 'chestWidth', 'Body B: chest width under the bust', 0.3, 0.7, 0.01],
    [LOOK_TUNING, 'bustDepth', 'Body B: bust depth', 0.25, 0.5, 0.01],
    [LOOK_TUNING, 'underBust', 'Body B: under the bust, height from the feet', 0.85, 1.36, 0.01],
    [LOOK_TUNING, 'shoulderWidth', 'Body B: shoulder width', 0.3, 0.7, 0.01],
    [LOOK_TUNING, 'shoulderDepth', 'Body B: shoulder depth', 0.18, 0.45, 0.01],
    [LOOK_TUNING, 'hipTop', 'Body B: skirt half width at the waist', 0.1, 0.4, 0.01],
    [LOOK_TUNING, 'hem', 'Body B: skirt half width at the hem', 0.2, 0.6, 0.01],
    [LOOK_TUNING, 'skirtIn', 'Body B: skirt halves in towards the middle', 0, 0.12, 0.005],
    [LOOK_TUNING, 'topDepth', 'Body B: skirt depth at the waist', 0.2, 0.5, 0.01],
    [LOOK_TUNING, 'chin', 'Body B: head width at the chin (top 0.5)', 0.36, 0.5, 0.005],
    [LOOK_TUNING, 'hemDepth', 'Body B: skirt depth at the hem', 0.25, 0.6, 0.01],
  ]],
  ['Animation', [
    [ANIM_TUNING, 'walkLean', 'Walk: lean forward (rad)', 0, 0.5, 0.005],
    [ANIM_TUNING, 'walkTwist', 'Walk: shoulders turn against the stride (rad)', 0, 0.5, 0.005],
    [ANIM_TUNING, 'walkSway', 'Walk: tilt over the standing foot (rad)', 0, 0.3, 0.005],
    [ANIM_TUNING, 'armCross', 'Walk: arms swing across (rad)', 0, 0.6, 0.01],
    [ANIM_TUNING, 'armOut', 'Arms hang out from the sides (rad)', 0, 0.4, 0.01],
    [ANIM_TUNING, 'wristLag', 'Walk: hands trail the swing (rad)', 0, 1, 0.01],
    [ANIM_TUNING, 'climbLean', 'Lean into a step up (rad)', 0, 0.8, 0.01],
    [ANIM_TUNING, 'flinch', 'Flinch: upper body thrown back (rad)', 0, 1.2, 0.01],
    [ANIM_TUNING, 'flinchTime', 'Flinch: recovers in (s)', 0.05, 1.5, 0.01],
    [ANIM_TUNING, 'flinchArms', 'Flinch: arms jerk out (rad)', 0, 1.5, 0.01],
    [ANIM_TUNING, 'workLean', 'Workers lean into their work (× as made)', 0, 2, 0.01],
    [ANIM_TUNING, 'castLean', 'Spearmen, mages and priests lean into it (× as made)', 0, 2, 0.01],
    [ANIM_TUNING, 'whirlLean', 'Barbarian leans out of its whirl (rad)', 0, 0.8, 0.01],
    [ANIM_TUNING, 'dizzy', 'Barbarian staggers after a whirl (s)', 0, 3, 0.05],
    [ANIM_TUNING, 'settle', 'Eases sudden pose changes over (s)', 0, 0.6, 0.01],
  ]],
  ['Explosions', [
    [EXPLOSION_TUNING, 'fire', 'Fire puffs per blast', 0, 80, 1],
    [EXPLOSION_TUNING, 'fireBrightness', 'Fire brightness', 0, 6, 0.05],
    [EXPLOSION_TUNING, 'fireLife', 'Fire lasts (s)', 0.1, 3, 0.05],
    [EXPLOSION_TUNING, 'smoke', 'Smoke puffs per blast', 0, 120, 1],
    [EXPLOSION_TUNING, 'smokeOpacity', 'Smoke opacity', 0, 1, 0.01],
    [EXPLOSION_TUNING, 'smokeLife', 'Smoke lasts (s)', 0.2, 10, 0.1],
    [EXPLOSION_TUNING, 'speed', 'Spread speed (blast radii/s)', 0, 5, 0.05],
    [EXPLOSION_TUNING, 'size', 'Puff size (blast radii)', 0.05, 2, 0.01],
    [EXPLOSION_TUNING, 'rise', 'Smoke rise (voxels/s²)', 0, 6, 0.05],
    [EXPLOSION_TUNING, 'trail', 'Fireball trail (puffs/s)', 0, 120, 1],
    [EXPLOSION_TUNING, 'soft', 'Soft edge against the ground (voxels)', 0, 3, 0.05],
    [SCORCH_TUNING, 'heat', 'Ground heat at the centre (over 1 = white-hot)', 0, 3, 0.05],
    [SCORCH_TUNING, 'heatReach', 'Heat reach (× blast radius)', 0.5, 3, 0.05],
    [SCORCH_TUNING, 'heatCool', 'Heat cools in (s)', 0.1, 10, 0.05],
    [SCORCH_TUNING, 'glow', 'Red-hot glow brightness', 0, 15, 0.05],
    [SCORCH_TUNING, 'char', 'Char darkness at the centre', 0, 1, 0.01],
    [SCORCH_TUNING, 'charSpread', 'Char reaches past the heat (voxels)', 0, 6, 0.05],
    [SCORCH_TUNING, 'charFade', 'Char fades out from (voxels from the centre)', 0, 6, 0.05],
    [SCORCH_TUNING, 'charPatches', 'Char patchiness', 0, 1, 0.01],
    [SCORCH_TUNING, 'charGrain', 'Char patch size (voxels)', 0.2, 6, 0.05],
    [SCORCH_TUNING, 'decal', 'Blast mark strength', 0, 1, 0.01],
    [SCORCH_TUNING, 'decalSize', 'Blast mark size (× char reach)', 0.2, 2, 0.01],
  ]],
  ['Debris', [
    [DEBRIS_TUNING, 'pebbles', 'Pebbles per stone or brick lost', 0, 12, 1],
    [DEBRIS_TUNING, 'pebbleSize', 'Pebble radius (voxels)', 0.02, 0.3, 0.005],
    [DEBRIS_TUNING, 'chips', 'Chips per log or plank lost', 0, 12, 1],
    [DEBRIS_TUNING, 'chipSize', 'Chip length (voxels)', 0.05, 0.6, 0.01],
    [DEBRIS_TUNING, 'speed', 'Fly-off speed (voxels/s)', 0, 12, 0.1],
    [DEBRIS_TUNING, 'blast', 'Off a blast (× speed)', 0, 6, 0.05],
    [DEBRIS_TUNING, 'gravity', 'Gravity (voxels/s²)', 1, 60, 0.5],
    [DEBRIS_TUNING, 'bounce', 'Bounce', 0, 0.9, 0.01],
    [DEBRIS_TUNING, 'roll', 'Pebbles roll off edges (voxels/s²)', 0, 30, 0.5],
    [DEBRIS_TUNING, 'life', 'Lasts (s)', 0.5, 10, 0.1],
  ]],
  ['Felling', [
    [FELL_TUNING, 'on', 'Cut trees fall over (1), or vanish (0)', 0, 1, 1],
    [FELL_TUNING, 'push', 'Push off the cut (radians/s)', 0, 3, 0.05],
    [FELL_TUNING, 'gravity', 'Gravity (voxels/s²)', 1, 60, 0.5],
    [FELL_TUNING, 'leafWeight', 'Leaf block weight (log = 1)', 0, 1, 0.01],
    [FELL_TUNING, 'leaves', 'Small leaves per leaf block', 0, 8, 1],
    [FELL_TUNING, 'leafSize', 'Small leaf size (voxels)', 0.03, 0.5, 0.01],
    [FELL_TUNING, 'burst', 'Leaf burst speed (voxels/s)', 0, 12, 0.1],
    [FELL_TUNING, 'fall', 'Leaves flutter down at (voxels/s)', 0.1, 4, 0.05],
    [FELL_TUNING, 'flutter', 'Leaf flutter', 0, 3, 0.05],
    [FELL_TUNING, 'leafLife', 'Leaves lie on the ground (s)', 0, 15, 0.1],
    [FELL_TUNING, 'spin', 'Log tumble (radians/s)', 0, 15, 0.1],
    [FELL_TUNING, 'bounce', 'Log bounce', 0, 0.9, 0.01],
    [FELL_TUNING, 'logLife', 'Logs last (s)', 0.3, 10, 0.1],
  ]],
  ['Combat', [
    [COMBAT_TUNING, 'goneAfter', 'Bodies last (s)', 1, 60, 0.5],
    [COMBAT_TUNING, 'spread', 'Target spread: each ally already on an enemy counts as this many voxels further', 0, 20, 0.5],
    [COMBAT_TUNING, 'retarget', 'Switches to an enemy this much nearer (voxels, unless told who to attack)', 0, 20, 0.5],
    [COMBAT_TUNING, 'bringFriend', 'Bring a friend: a unit hit calls allies this near (voxels)', 0, 20, 0.5],
    [COMBAT_TUNING, 'twist', 'Body twist into a slash or throw (radians)', 0, 1.2, 0.01],
    [COMBAT_TUNING, 'lunge', 'Warrior lunge into a slash (voxels)', 0, 0.5, 0.01],
    [UNIT_TUNING, 'wristCone', 'Wrist bend limit, any way (radians)', 0, 1.6, 0.01],
  ]],
  ['Ragdoll', [
    [RAGDOLL_TUNING, 'gravity', 'Gravity (voxels/s²)', 2, 60, 0.5],
    [RAGDOLL_TUNING, 'bounce', 'Bounce', 0, 1, 0.01],
    [RAGDOLL_TUNING, 'friction', 'Friction', 0, 2, 0.01],
    [RAGDOLL_TUNING, 'limbSpring', 'Limb stiffness', 0, 30, 0.1],
    [RAGDOLL_TUNING, 'limbDamping', 'Limb damping', 0, 20, 0.1],
    [RAGDOLL_TUNING, 'headPop', 'Head pop chance', 0, 1, 0.01],
    [RAGDOLL_TUNING, 'sandal', 'Sandal off chance', 0, 1, 0.01],
    [RAGDOLL_TUNING, 'popSpeed', 'Head pop speed (voxels/s)', 0, 15, 0.1],
    [RAGDOLL_TUNING, 'scatter', 'Dropped items fling (voxels/s)', 0, 10, 0.1],
    [RAGDOLL_TUNING, 'itemFriction', 'Dropped items friction', 0, 2, 0.01],
  ]],
  ...soundTuning(), // Sound, and each group's sounds' volume and pitch
];
TUNING.sort((a, b) => a[0].localeCompare(b[0])); // (sections in alphabetical order, Jordan 2026-10-22)
const tuning = createTuningPanel(document.getElementById('tuning'), TUNING, [], 'Tuning');
document.getElementById('btn-tuning').addEventListener('click', (e) => { tuning.toggle(); e.currentTarget.blur(); });

// World seed, on New game's setup screen: the one typed there, or with Random on (remembered), a new random one rolled
// at Start (and shown there next time). Start makes the world for it (see the setup screen, below).
const SEED_RANDOM_KEY = 'god-game-seed-random';
const seedInput = document.getElementById('seed');
const seedRandom = document.getElementById('seed-random');
seedInput.value = seedText;
function setSeedRandom(on) {
  seedRandom.checked = on;
  seedInput.disabled = on;
  try { localStorage.setItem(SEED_RANDOM_KEY, on ? '1' : '0'); } catch (err) { /* storage blocked: just this time */ }
}
setSeedRandom((() => { try { return localStorage.getItem(SEED_RANDOM_KEY) === '1'; } catch (err) { return false; } })());
seedRandom.addEventListener('change', () => { setSeedRandom(seedRandom.checked); showSetupSummary(); });
// (The die: a random seed in the box, to keep or change.)
document.getElementById('seed-roll').addEventListener('click', (e) => {
  setSeedRandom(false);
  seedInput.value = String(Math.floor(Math.random() * 1e9));
  showSetupSummary();
  e.currentTarget.blur();
});
// The seed Start uses (saved as the last one used).
function chosenSeed() {
  const text = seedRandom.checked ? String(Math.floor(Math.random() * 1e9)) : seedInput.value.trim() || '7';
  try { localStorage.setItem(SEED_KEY, text); } catch (err) { /* storage blocked: the #seed in the address still carries it */ }
  return text;
}
seedInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') setupBox.querySelector('[data-setup="start"]').click();
});

// --- Input -------------------------------------------------------------------------------------------------

const brush = { tool: 'select', radius: 1, press: null, hit: null }; // radius: the Raise/Lower cube's size; press: where a Raise/Lower press began
const mouse = { x: 0, y: 0, inside: false, button: -1, lastX: 0, lastY: 0, downX: 0, downY: 0, dragged: false };
// Select tool: left click picks a unit, left drag draws a selection box (Shift adds to the selection).
// Any tool: right click (without dragging) sends the selected units there; right drag still orbits.
const selectBox = document.getElementById('select-box');
const CLICK_SLOP = 5; // pixels a press can move and still count as a click
const keys = new Set();

const radiusInput = document.getElementById('radius');
const radiusLabel = document.getElementById('radiusLabel');
function setRadius(r) {
  brush.radius = clamp(Math.round(r), BRUSH_TUNING.minRadius, BRUSH_TUNING.maxRadius);
  radiusInput.value = brush.radius;
  radiusLabel.textContent = brush.radius;
}
radiusInput.addEventListener('input', () => setRadius(+radiusInput.value));
// The dock's and the mode bar's drawn state (see renderDock): cleared to have them drawn again.
let dockKey = '', modeKey = '';
let site = null, siteIds = 0; // the building being built that's selected (see siteAt), and their count
// The tools: Select (as it comes), Build (Craft's), and sandbox's Raise, Lower and Flatten (F3, F4, F5). Another
// tool's key (or the one in use's again) goes back to Select.
function setTool(tool) {
  if (mode.name === 'new' && (tool === 'raise' || tool === 'lower' || tool === 'flatten')) return; // (sandbox only)
  if (brush.tool === tool && tool !== 'select') tool = 'select';
  brush.tool = tool;
  if (tool !== 'select' && (command.armed === 'dig' || command.armed === 'fill' || command.armed === 'farm' || command.armed === 'wall')) arm(null); // (Mine, Fill, Farm, Wall and the tools don't mix)
  for (const b of document.querySelectorAll('#tools [data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
  if (tool !== 'build') hideDesignName();
  wall.drawing = null;
  brush.press = null;
  build.press = null;
  build.facing = null;
}
for (const b of document.querySelectorAll('#tools [data-tool]')) b.addEventListener('click', () => { setTool(b.dataset.tool); b.blur(); });


// The block Fill, Wall, Flatten and Raise use: picked on the resource ribbon (bottom right, under the dock), which shows a new game's
// inventory: its blocks, currencies (iron and gold), wheat, people and the time.
const PALETTE = [
  { block: BLOCK.CLAY, name: 'Clay', tex: 'textures/dirt.png' }, // (dirt, put down as clay bricks)
  { block: BLOCK.BRICK, name: 'Bricks', tex: 'textures/brick.png' },
  { block: BLOCK.PLANK, name: 'Planks', tex: 'textures/plank.png' },
];
const palette = { block: BLOCK.CLAY };
const RES_KIND = { [BLOCK.IRON]: ['iron', 'Iron', 'mined from iron ore, a currency'], [BLOCK.GOLD]: ['gold', 'Gold', 'mined from gold ore, a currency'], [WHEAT]: ['wheat', 'Wheat', 'reaped from farms'] };
const ribbon = document.getElementById('ribbon');
const ribbonShown = new Map(); // what each cell shows, to touch the DOM only when it changes
function buildRibbon() {
  const blocks = PALETTE.map((p) => `<button type="button" class="res" data-block="${p.block}" data-tip="${p.name}||${mode.name === 'new' ? `Yours, from what your workers ${p.block === BLOCK.PLANK ? 'fell' : p.block === BLOCK.BRICK ? 'mine (stone)' : 'dig (dirt)'}. ` : ''}Click to have Fill, Wall${mode.name === 'new' ? '' : ', Raise and Flatten'} use it.">` +
    `<span><i class="sw" style="background-image:url('${p.tex}')"></i><span class="n">${mode.name === 'new' ? '0' : '∞'}</span><span class="w"></span></span><span class="nm">${p.name}</span></button>`).join('');
  // (In two columns, see ui.css: the blocks and the people, then iron, gold, wheat and the time.)
  const res = mode.name !== 'new' ? '' : `<div class="res" data-res="people" data-tip="People||Your villagers, and the room your Keep and houses make for them. Build houses for more."><span>${resIcon('people')}<span class="n">0/0</span><span class="w"></span></span><span class="nm">People</span></div>` +
    [...RESOURCES.filter((c) => c !== WHEAT), WHEAT].map((c) => {
      const [kind, name, from] = RES_KIND[c];
      return `<div class="res" data-res="${c}" data-tip="${name}||${cap(from)}."><span>${resIcon(kind)}<span class="n">0</span><span class="w"></span></span><span class="nm">${name}</span></div>`;
    }).join('');
  ribbon.innerHTML = blocks + res + `<div class="time" data-tip="Time||How long this game has gone on."><span>${svg(ICON.clock, 22, 3)}</span><span class="n">0:00</span><span class="nm">Time</span></div>`;
  ribbonShown.clear();
  setPalette(palette.block);
}
ribbon.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-block]');
  if (!b) return;
  const block = +b.dataset.block;
  if (command.armed === 'wall' && !wallBlock(block)) { toast('Walls are built of planks or bricks', 3); b.blur(); return; }
  setPalette(block);
  b.blur();
});
// Picks the palette's block (and shows it picked).
function setPalette(block) {
  palette.block = block;
  for (const o of ribbon.querySelectorAll('button[data-block]')) o.classList.toggle('is-on', +o.dataset.block === block);
}
// The ribbon's counts (a new game), each with the ink warning when it's short: a block the open orders want more of than
// there is, a currency the selection's training can't be paid for with, the people when there's no room for more.
function setCell(sel, n, short) {
  const key = `${n}|${short}`;
  if (ribbonShown.get(sel) === key) return;
  ribbonShown.set(sel, key);
  const el = ribbon.querySelector(sel);
  if (!el) return;
  el.querySelector('.n').textContent = n;
  el.querySelector('.w').innerHTML = short ? WARN : '';
}
const shortOf = new Set(); // currencies the selected building's training is short of (see dockBuilding)
function showCounts() {
  if (!inventory) return;
  for (const p of PALETTE) setCell(`[data-block="${p.block}"]`, String(inventory.get(p.block)), (inventory.free.get(p.block) ?? 0) < 0);
  for (const c of RESOURCES) setCell(`[data-res="${c}"]`, String(inventory.get(c)), shortOf.has(c));
}
function showRibbonFrame() {
  if (inventory) {
    const pop = population(), room = popRoom();
    setCell('[data-res="people"]', `${pop}/${room}`, pop >= room);
  }
  const t = clockText(gameClock - startClock), el = ribbon.querySelector('.time .n');
  if (el && el.textContent !== t) el.textContent = t;
}

// Game modes, picked in the main menu (shown at startup over the world, turning slowly): sandbox, as the game's always
// been (villagers at a key press, insta-build, every block free), or a new game: INVENTORY_TUNING.startWorkers workers
// (one), and the team's inventory, which its workers fill by mining and building uses up (see inventory.js).
const mode = { name: null };
let inventory = null;
const menu = document.getElementById('menu');
function startGame(name) {
  mode.name = name;
  menu.hidden = true;
  document.body.classList.remove('in-menu');
  document.body.classList.toggle('new-game', name === 'new');
  document.body.classList.toggle('editor', name === 'editor');
  let [cx, , cz] = camera.target;
  if (name === 'editor') {
    // Editor: sandbox with nobody in it and insta-build on, for building designs (Build → Save design) for new games,
    // on flat ground with no trees or water.
    terrain.flat(Math.round(EDITOR_TUNING.groundHeight));
    ores.index();
    field.buildAll();
    skyVis.buildAll();
    grass.update([0, 0, 0], SIZE);
    grass.falling = []; // (not the old world's lost grass fluttering down over the new one)
    minimap.water = false;
    minimap.rebuild();
    if (!insta.on) toggleInsta();
    setTool('build');
    pickBuild('save');
  } else if (name === 'sandbox') {
    for (const [dx, dz] of [[-3, -2], [2, -3], [0, 2], [4, 3]]) units.spawn(cx + dx, cz + dz);
  } else {
    // The starts (see newGameStarts): the camera over the player's, a power crystal at each (over its Keep, see
    // crystals.js) and an idle worker outside each opponent's door (red, yellow, purple).
    const starts = newStarts;
    [cx, cz] = starts.blue;
    camera.target[0] = cx;
    camera.target[2] = cz;
    camera.target[1] = terrain.groundAt(cx, cz);
    // Its feet on the plinth inside the Keep (it's hit, and fought, from there), drawn over the roof's hole (raise).
    const crystal = (x, z, team) => {
      const roof = keeps.get(team).floor + 3, u = units.spawn(x + 0.5, z + 0.5, roof, team, 'crystal');
      if (!u) return;
      u.raise = roof - u.pos[1];
      u.yaw = 0;
      u.hp = u.maxHp = CRYSTAL_TUNING.hp;
    };
    // Outside its door: cell k of a few in a fan out of it.
    const outside = (plan, k) => {
      const { cell: [x, y, z], dir: [dx, dz] } = plan.spawn, a = (k % 3) - 1, b = 3 + Math.floor(k / 3);
      return [x + dx * b - dz * a + 0.5, z + dz * b + dx * a + 0.5, y + 2];
    };
    for (const [team, plan] of keeps) for (const t of plan.torches ?? []) if (!torches.at(...t.cell)) torches.add(t).torch.lit = true;
    for (const [team, plan] of keeps) for (const b of plan.banners ?? []) banners.add(b);
    finishBuilding({ plan: keeps.get('blue'), key: 'keep', name: 'Keep' }, true);
    crystal(cx, cz, 'blue');
    starts.opponents.forEach(([x, z], i) => {
      crystal(x, z, OPPONENTS[i]);
      const [wx, wz, wy] = outside(keeps.get(OPPONENTS[i]), 1);
      units.spawn(wx, wz, wy, OPPONENTS[i], 'worker');
    });
    units.controls = 'blue'; // (the player's orders are for blue's villagers only)
    inventory = new Inventory(units.workers);
    units.workers.inventory = inventory;
    farms.inventory = inventory;
    inventory.onChange = showCounts;
    inventory.onShare = showCosts;
    inventory.start();
    const n = Math.max(1, Math.round(INVENTORY_TUNING.startWorkers));
    for (let i = 0; i < n; i++) { // (outside the Keep's door)
      const [wx, wz, wy] = outside(keeps.get('blue'), i + 1);
      units.spawn(wx, wz, wy);
    }
    if (setup.fog) setFog(true);
  }
  buildRibbon();
  showCounts();
  startClock = gameClock;
  crystalEl.hidden = name !== 'new';
  buildSpawnPicker();
  dockKey = '';
}
for (const b of menu.querySelectorAll('button[data-mode]')) {
  b.addEventListener('click', () => { if (b.dataset.mode === 'new') showSetup(true); else startGame(b.dataset.mode); b.blur(); });
}
// New game's setup screen: map size, who you face (Blue's you; the opponents come in order, Red, Yellow, Purple), the
// world's options and rules, then the page starts over with them (see setup).
const setupBox = menu.querySelector('.menu-setup');
const menuMain = menu.querySelector('.menu-main');
const setupState = { opponents: 1 };
const facesEl = document.getElementById('faces');
function showFaces() {
  const n = setupState.opponents;
  facesEl.innerHTML = '<div class="rod tex-plank"></div>' + ['blue', ...OPPONENTS].map((team, i) => {
    const name = TEAMS[team].name;
    if (i === 0) return `<div class="face ${team}"><div class="bn t-${team}" role="group" aria-label="${name}, you"><span class="h-disp">${name}</span><small>You</small>${emblem(team, 30)}</div></div>`;
    if (i <= n) {
      return `<div class="face ${team}"><div class="bn t-${team}" role="group" aria-label="${name}, an opponent"><span class="h-disp">${name}</span><small>Opponent</small>${emblem(team, 30)}</div>` +
        (i === n ? `<button type="button" class="btn rm" data-opp="${i - 1}" aria-label="Remove ${name}">${svg('M5 5l14 14M19 5L5 19', 14, 4.5)}</button>` : '') + '</div>';
    }
    return `<div class="face ${team}"><button type="button" class="roll t-${team}" data-opp="${i}" aria-label="Add ${name}">${emblem(team, 18)}<span class="h-disp" style="font-size: 17px">${name}</span></button><span class="hint">Click to add</span></div>`;
  }).join('');
  showSetupSummary();
}
facesEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-opp]');
  if (!b) return;
  setupState.opponents = +b.dataset.opp;
  showFaces();
});
// The form from a setup (parseSetup's): the last new game's, or this one's.
function fillSetup(was) {
  for (const [name, value] of [['map', was.map], ['mirror', was.mirror]]) {
    const r = setupBox.querySelector(`input[name="${name}"][value="${value}"]`);
    if (r) r.checked = true;
  }
  document.getElementById('setup-fog').checked = was.fog;
  document.getElementById('setup-bridge').checked = was.bridge;
  mountInput.value = was.mountains;
  waterInput.value = was.water;
  resInput.value = was.resources;
  setupState.opponents = was.opponents;
  showTerrainValues();
  showFaces();
}
function lastSetup() {
  let last = setup.start ? location.hash : null;
  if (!last) try { last = localStorage.getItem(SETUP_KEY); } catch (err) { /* storage blocked: the defaults */ }
  return parseSetup(last ?? '');
}
function showSetup(on) {
  menuMain.hidden = on;
  setupBox.hidden = !on;
  if (on) fillSetup(lastSetup());
}
document.getElementById('setup-again').addEventListener('click', (e) => { fillSetup(lastSetup()); e.currentTarget.blur(); });
// The terrain sliders: Mountains (times as high as it comes), Water (% of the map) and Resources (times as many trees
// and as much iron and gold as it comes with); each fills brass up to its handle.
const mountInput = setupBox.querySelector('#setup-mount'), waterInput = setupBox.querySelector('#setup-water');
const resInput = setupBox.querySelector('#setup-res');
function showTerrainValues() {
  setupBox.querySelector('#setup-mount-out').textContent = `×${(+mountInput.value).toFixed(2)}`;
  setupBox.querySelector('#setup-water-out').textContent = `${Math.round(+waterInput.value)}%`;
  setupBox.querySelector('#setup-res-out').textContent = `×${(+resInput.value).toFixed(2)}`;
  for (const i of [mountInput, waterInput, resInput]) i.style.setProperty('--f', `${(100 * (i.value - i.min) / (i.max - i.min)).toFixed(1)}%`);
  showSetupSummary();
}
mountInput.addEventListener('input', showTerrainValues);
waterInput.addEventListener('input', showTerrainValues);
resInput.addEventListener('input', showTerrainValues);
setupBox.addEventListener('change', () => showSetupSummary());
// The summary beside the start banner: the kingdoms, and the world in a line.
function showSetupSummary() {
  const pick = (name) => setupBox.querySelector(`input[name="${name}"]:checked`)?.value;
  const n = setupState.opponents;
  document.getElementById('setup-teams').innerHTML = ['blue', ...OPPONENTS.slice(0, n)].map((t) => teamBanner(t)).join('');
  const size = { small: 'Small', medium: 'Medium', large: 'Large', huge: 'Huge' }[pick('map') ?? 'medium'];
  const sym = { none: 'no symmetry', x: 'mirrored left-right', z: 'mirrored top-bottom', both: 'mirrored in quarters' }[pick('mirror') ?? 'none'];
  const seedWord = seedRandom.checked ? 'a new seed' : `seed ${esc(seedInput.value.trim() || '7')}`;
  document.getElementById('setup-summary').innerHTML = `${size} map · ${n ? `${n} opponent${n > 1 ? 's' : ''}` : 'no opponents'} · ${sym} · ` +
    `${Math.round(+waterInput.value)}% water · fog ${document.getElementById('setup-fog').checked ? 'on' : 'off'} · ${seedWord}`;
}
seedInput.addEventListener('input', showSetupSummary);
setupBox.querySelector('[data-setup="back"]').addEventListener('click', () => showSetup(false));
setupBox.querySelector('[data-setup="start"]').addEventListener('click', () => {
  const pick = (name) => setupBox.querySelector(`input[name="${name}"]:checked`)?.value;
  location.hash = `seed=${encodeURIComponent(chosenSeed())}&new=1&map=${pick('map') ?? 'medium'}&opp=${setupState.opponents}&mirror=${pick('mirror') ?? 'none'}` +
    `&fog=${document.getElementById('setup-fog').checked ? 1 : 0}&mount=${mountInput.value}&water=${waterInput.value}&res=${resInput.value}` +
    `&bridge=${document.getElementById('setup-bridge').checked ? 1 : 0}`;
  try { localStorage.setItem(SETUP_KEY, location.hash); } catch (err) { /* storage blocked: not remembered */ }
  location.reload();
});
// Back to the main menu (the pause menu's): this world started over (the sandbox's size, no setup).
function toMainMenu() {
  location.hash = `seed=${encodeURIComponent(seedText)}`;
  location.reload();
}

// Fog of war on or off: a new game's from its setup; O (or the tools panel's button) in sandbox. Turned off, every
// edit it held back is shown.
const fogButton = document.getElementById('btn-fog');
function setFog(on) {
  if (on === fog.on || mode.name === 'editor') return;
  fog.enable(on);
  if (!on) {
    for (const b of fog.flush(true)) shown(b.lo, b.hi, true);
    for (const u of units.list) u.hidden = false;
  }
  fogButton.setAttribute('aria-pressed', String(on));
}
// (O and the button: with a click on or off.)
const toggleFog = () => { setFog(!fog.on); sfx(fog.on ? 'toggleOn' : 'toggleOff'); };
fogButton.addEventListener('click', (e) => { if (mode.name === 'sandbox') toggleFog(); e.currentTarget.blur(); });
// Fog of war: never seen isn't drawn, its columns air on the GPU (TerrainField.blank) and bare of grass. Turned on or
// off, everything's sent up again.
// With FOG_TUNING.bare, never-seen columns near the edge go up bare (TerrainField.bare): no trees or buildings there.
let blankOn = false, bareOn = false;
function syncBlank() {
  const want = fog.on, bare = want && FOG_TUNING.bare > 0.5;
  if (want === blankOn && bare === bareOn) return;
  blankOn = want;
  bareOn = bare;
  field.blank = grass.blank = want ? fog.near : null;
  field.bare = bare ? () => fog.state : null;
  field.seen = want ? () => fog.state : null; // (leaves go up as their trunk's seen)
  field.buildAll();
  skyVis.buildAll();
  grass.update([0, 0, 0], SIZE, true);
}
// How far a villager sees: the further of FOG_TUNING.sight and its weapon's (or a priest's beam's) range.
const SIGHT_RANGE = { archer: 'bowRange', spearman: 'spearRange', mage: 'fireRange', priest: 'beamRange' };
// A unit on a lookout tower's platform sees LOOKOUT_TUNING.boost times as far.
const sightOf = (u) => (u.kind === 'crystal' ? CRYSTAL_TUNING.sight : u.kind === 'wall' ? WALL_TUNING.sight
  : Math.max(FOG_TUNING.sight, COMBAT_TUNING[SIGHT_RANGE[u.role ?? u.kind]] ?? 0) * (onLookout(u) ? LOOKOUT_TUNING.boost : 1));
function onLookout(u) {
  if (u.dying || u.cell[1] < 1) return false;
  const b = buildings.at.get(terrain.index(u.cell[0], u.cell[1] - 1, u.cell[2]));
  return b?.plan.platform === u.cell[1] - 1;
}
const buildingSightOf = (b) => BUILDING_SIGHT[b.key] ?? FOG_TUNING.buildingSight;


// A new game's starts: the player's (blue) near one corner of the map, each opponent's (OPPONENTS) at another, the
// player's turned round where the map's symmetrical that way (so it's the same ground), else the nearest open
// ground to that corner. A start is dry, flat (within a voxel over 5 × 5) grass with nothing standing on it.
function startNear(cx, cz) {
  const [X, , Z] = SIZE;
  const ok = (x, z) => {
    if (x < 3 || z < 3 || x >= X - 3 || z >= Z - 3) return false;
    const h = terrain.groundAt(x, z);
    if (h < WATER_LEVEL + 2 || terrain.block(x, h - 1, z) !== BLOCK.GROUND) return false;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(terrain.groundAt(x + dx, z + dz) - h) > 1) return false;
        if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && terrain.block(x + dx, h, z + dz) !== BLOCK.AIR) return false;
      }
    }
    return true;
  };
  for (let r = 0; r < Math.max(X, Z); r++) {
    for (let a = 0; a < 2 * Math.PI; a += r ? 0.9 / r : 7) {
      const x = Math.round(cx + Math.cos(a) * r), z = Math.round(cz + Math.sin(a) * r);
      if (ok(x, z)) return [x, z];
    }
  }
  return [Math.round(cx), Math.round(cz)];
}
// Where a new game's starts are looked for (see newGameStarts), the player's first: [[x, z]].
function startTargets(opponents, mirror) {
  const [X, , Z] = SIZE, m = Math.round(Math.max(20, 0.12 * Math.min(X, Z))), mx = X - 1 - m, mz = Z - 1 - m;
  const corners = {
    none: [[mx, mz], [mx, m], [m, mz]], x: [[mx, mz], [mx, m], [m, mz]], z: [[mx, mz], [m, mz], [mx, m]],
    both: [[mx, mz], [X - 1 - m, m], [m, Z - 1 - m]],
  }[mirror] ?? [];
  return [[m, m], ...corners.slice(0, opponents)];
}
function newGameStarts(opponents, mirror) {
  const [X, , Z] = SIZE, m = Math.round(Math.max(20, 0.12 * Math.min(X, Z)));
  const [px, pz] = startNear(m, m);
  const mx = X - 1 - px, mz = Z - 1 - pz;
  // The other corners, best first: [x, z, exact (the map's turned so that it's the same ground, see
  // Terrain.mirror: half round to the opposite corner, and with both, a quarter round to each of the others)].
  const corners = {
    none: [[mx, mz, false], [mx, pz, false], [px, mz, false]],
    x: [[mx, mz, true], [mx, pz, false], [px, mz, false]],
    z: [[mx, mz, true], [px, mz, false], [mx, pz, false]],
    both: [[mx, mz, true], [X - 1 - pz, px, true], [pz, Z - 1 - px, true]],
  }[mirror];
  const opp = corners.slice(0, opponents).map(([x, z, exact]) => (exact ? [x, z] : startNear(x, z)));
  return { blue: [px, pz], opponents: opp };
}

const finishedPlans = []; // finished buildings, { plan, key }, to be taken on (see finishBuilding) after the units' update
// The way from a cell towards the camera, along the nearer axis: [dx, dz] (a new spawn point faces it).
const FACING_DIRS = [[0, 1], [1, 0], [0, -1], [-1, 0]];
const cameraFacing = ([x, , z]) => FACING_DIRS[facingToward(x + 0.5, z + 0.5, camera.matrices().eye)].slice();
// A message for a few seconds (top middle), with the ink warning.
let toastTimer = 0;
function toast(text, seconds = 3.5) {
  const el = document.getElementById('toast');
  el.innerHTML = `${WARN}<span>${esc(text)}</span>`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, seconds * 1000);
}

// Build tool (Craft's Build, Z): pick a building from the Build menu (over the dock), then click to place it where its
// ghost fits (pale; red where it doesn't: the ground under it must be flat and the space it fills empty). Idle
// villagers then build it.
// A left drag turns the building where it was pressed (its front towards the cursor), and it keeps that turn after
// (facing, a FACING_DIRS index; null: towards the camera) till it's placed, the tool's changed or another's picked;
// only a click places it. press: { hit, facing } while the button's down.
const build = { item: 'hut', facing: null, press: null };
// The Build menu's banners (Editor): how many voxels long each hangs.
const BANNER_ITEMS = { banner1: 1, banner2: 2, banner3: 3 };
// The Build menu: each item's name and what it is (its tooltip); `editor`: the Workshop's only.
const BUILD_ITEMS = [
  { key: 'hut', name: 'House', tip: '3×3×4 of planks with a chimney. Room for 5 more villagers, and a place to take wheat.' },
  { key: 'barracks', name: 'Barracks', tip: '5×5×3 of bricks and planks. Trains warriors and barbarians.' },
  { key: 'archeryRange', name: 'Archery range', tip: '5×6×5 of planks and a little clay. Trains archers and spearmen.' },
  { key: 'mageTower', name: 'Mage tower', tip: '5×5×7 of bricks and planks. Trains fire mages and healers.' },
  { key: 'stables', name: 'Stables', tip: '7×6×4 of planks and a little clay. Trains scouts and knights.' },
  { key: 'lookoutTower', name: 'Lookout tower', tip: 'A stair up to a platform: a unit standing on it sees twice as far.' },
  { key: 'wall', name: 'Wall', hotkey: 'B', tip: 'Drag a straight line over the ground and let go: a wall 3 high of the planks or bricks picked on the bar at the top, with torches and your banners. Yours, with hit points.' },
  { key: 'keep', name: 'Keep', editor: true, tip: 'Each team\'s start in a game (it comes with the map there): here, to build and try it.' },
  { key: 'banner1', name: 'Banner 1', editor: true, tip: 'Click the side of a block to hang it there (again to take it down), in its builder\'s colour.' },
  { key: 'banner2', name: 'Banner 2', editor: true, tip: 'Click the side of a block to hang it there (again to take it down), in its builder\'s colour.' },
  { key: 'banner3', name: 'Banner 3', editor: true, tip: 'Click the side of a block to hang it there (again to take it down), in its builder\'s colour.' },
  { key: 'spawn', name: 'Spawn point', editor: true, tip: 'Click the top of a block for where a unit comes out, facing the arrow (again turns it, Del removes it). One per design.' },
  { key: 'torch', name: 'Torch', tip: 'Click the top or side of a block to have a torch set there.' },
  { key: 'portcullis', name: 'Portcullis', tip: 'Click your own finished wall for a gate 2 wide and 2 high: your units walk through, the enemy meets wall.' },
  { key: 'save', name: 'Save design', tip: 'Drag a box around something built (footprint, release, height, click) and name it, to add it to this menu.' },
];
function pickBuild(item) {
  build.item = item;
  wall.drawing = null;
  brush.press = null;
  build.press = null;
  build.facing = null;
  hideDesignName();
  modeKey = '';
}

// Save design (in the Build menu): drag a box around something built, the way Raise drags one (footprint, release,
// height, click), then name it; it joins the Build menu as a building of its own, placed on flat ground with all of
// its bounding box empty. Designs are kept in this browser.
const DESIGNS_KEY = 'god-game-designs';
let designs = [];
try { designs = JSON.parse(localStorage.getItem(DESIGNS_KEY) || '[]').filter((d) => d?.blocks?.length); } catch (err) { designs = []; }
// Saved designs that are now built in (the same blocks) go from the saved ones, so they aren't in the menu twice.
{
  const same = (a, b) => JSON.stringify(a.blocks) === JSON.stringify(b.blocks);
  const kept = designs.filter((d) => !Object.values(BUILT_IN_DESIGNS).some((b) => same(b, d)));
  if (kept.length !== designs.length) { designs = kept; try { localStorage.setItem(DESIGNS_KEY, JSON.stringify(designs)); } catch (err) { /* storage blocked */ } }
}
const saveDesigns = () => { try { localStorage.setItem(DESIGNS_KEY, JSON.stringify(designs)); } catch (err) { /* storage blocked */ } };
let pendingDesign = null; // captured, waiting for its name
function designButtons() {
  for (const key of Object.keys(BUILDINGS)) if (key.startsWith('design:')) delete BUILDINGS[key];
  designs.forEach((d, i) => { BUILDINGS[`design:${i}`] = { name: d.name, plan: designPlan(d) }; });
  modeKey = ''; // (the Build menu drawn again)
}
// Build menu costs (a new game): the blocks each building takes, as swatches and counts, the one short (what's left
// of the inventory once the open orders are covered won't do) in an ink pill; torches are free.
const COST_TEX = { [BLOCK.CLAY]: 'textures/dirt.png', [BLOCK.BRICK]: 'textures/brick.png', [BLOCK.PLANK]: 'textures/plank.png' };
function planCost(plan) {
  const c = new Map();
  for (const [, , , b] of plan.blocks) c.set(built(b), (c.get(built(b)) ?? 0) + 1);
  return [...c].sort((a, b) => b[1] - a[1]);
}
function buildCostHtml(key) {
  if (!inventory) return '';
  const B = BUILDINGS[key];
  const pill = (short, icon, n) => `<i class="${short ? 'low' : ''}">${icon}${n}</i>`;
  if (key === 'portcullis') {
    const n = Math.round(GATE_TUNING.iron);
    return n > 0 ? pill(inventory.get(BLOCK.IRON) < n, resIcon('iron', 12), n) : 'Free';
  }
  if (key === 'wall') return 'Planks or bricks';
  if (!B) return key === 'torch' ? 'Free' : '';
  B.cost ??= planCost(B.plan(0, 1, 0, 0));
  // (And its gold or iron on top, paid as it's placed.)
  return B.cost.map(([blk, n]) => pill((inventory.free.get(blk) ?? 0) < n, `<i class="s" style="background-image:url('${COST_TEX[blk]}')"></i>`, n)).join('') +
    buildExtra(key).map(([blk, n]) => pill(inventory.get(blk) < n, resIcon(blk === BLOCK.GOLD ? 'gold' : 'iron', 12), n)).join('');
}
function showCosts() { costsShown = ''; } // (inventory.onShare: what's left over has changed)
function deleteDesign(key) {
  designs.splice(+key.slice('design:'.length), 1);
  saveDesigns();
  designButtons();
  if (!BUILDINGS[build.item] && !['torch', 'portcullis', 'save', 'spawn'].includes(build.item) && !BANNER_ITEMS[build.item]) pickBuild('hut');
}
// Its name, asked in the Build menu (Enter saves it, Esc drops it).
function askDesignName(design) {
  pendingDesign = design;
  modeKey = '';
  renderModebar();
  const input = modebar.querySelector('#design-name input');
  if (!input) return;
  input.value = `Design ${designs.length + 1}`;
  input.focus();
  input.select();
}
function hideDesignName() { if (pendingDesign) { pendingDesign = null; modeKey = ''; } }
function finishDesign() {
  if (!pendingDesign) return;
  const input = modebar.querySelector('#design-name input');
  pendingDesign.name = input?.value.trim() || `Design ${designs.length + 1}`;
  designs.push(pendingDesign);
  saveDesigns();
  hideDesignName();
  designButtons();
  pickBuild(`design:${designs.length - 1}`);
}
// Copy designs (Editor): every saved design as JSON, on the clipboard and in a box to copy from by hand (the clipboard
// can be blocked), so they can be pasted to Claude and made part of the game.
document.getElementById('btn-export').addEventListener('click', (e) => {
  const text = JSON.stringify(designs);
  const box = document.getElementById('design-export'), area = box.querySelector('textarea');
  area.value = text;
  box.hidden = false;
  area.focus();
  area.select();
  navigator.clipboard?.writeText(text).then(() => toast(`Copied ${designs.length} design${designs.length === 1 ? '' : 's'}: paste them to Claude.`),
    () => toast('Copy the text in the box (Ctrl+C), then paste it to Claude.'));
  e.currentTarget.blur();
});
// Team (Editor): everything built shown in one team's colours, or plain (see Terrain.ownAll), to try the colours.
document.getElementById('team-look').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  terrain.ownAll(b.dataset.team);
  for (const o of e.currentTarget.querySelectorAll('button')) o.classList.toggle('is-on', o === b);
  b.blur();
});
designButtons();
// Raise and Lower (1, 2): a click marks the brush's cube; a drag draws a box instead. Drag a rectangle, release,
// move the mouse up or down to its height and click again: idle villagers fill what's empty in it with the palette's
// block, or dig it out: a trench, a pit or a tunnel into a hillside.
const MAX_TORCH_LIGHTS = 32; // flames that light the ground (the nearest the camera's target)
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wall = { drawing: null }; // the box being drawn: { ax, az, bx, bz, add, save, level, plane, y0, y1, raising }
function wallBox(d) { return flattenBox(d); }
function wallVoxels(d) {
  const [x0, z0, x1, z1] = wallBox(d);
  return boxVoxels(terrain, x0, z0, x1, z1, d.y0, d.y1, d.add);
}
function wallMarks(d) {
  const [x0, z0, x1, z1] = wallBox(d);
  return [[x0, d.y0, z0, 4], [x1, d.y1, z1, 0]]; // (green, raising or lowering: see fillGhosts)
}
// Starts a box at a press's hit: raising, on the empty cell above (or beside) the one pressed; lowering, on that one.
// (Saving a design draws its box the way raising does.)
function wallStart(hit, add, save = false) {
  const cx = Math.floor(hit.point[0] - hit.normal[0] * 0.01), cz = Math.floor(hit.point[2] - hit.normal[2] * 0.01);
  const level = Math.floor(hit.point[1] + hit.normal[1] * (add ? 0.5 : -0.5));
  wall.drawing = { ax: cx, az: cz, bx: cx, bz: cz, add, save, level, plane: add ? level : level + 1, y0: level, y1: level + 1, raising: false };
}
// Footprint: where the ray meets the plane of the pressed face's top. Height: where it meets the upright plane through
// the box's middle facing the camera; the box goes up from its level, or down from it (taking that layer in too).
function wallDrag(clientX, clientY) {
  const d = wall.drawing;
  const { origin, dir } = rayAt(clientX, clientY);
  if (!d.raising) {
    if (Math.abs(dir[1]) < 1e-4) return;
    const t = (d.plane - origin[1]) / dir[1];
    if (t <= 0) return;
    const px = clamp(Math.floor(origin[0] + dir[0] * t), 0, SIZE[0] - 1);
    const pz = clamp(Math.floor(origin[2] + dir[2] * t), 0, SIZE[2] - 1);
    if (d.stage === 'line') { // Mine/Fill: first a line along x or z, whichever the drag is nearer
      d.axis = Math.abs(px - d.ax) >= Math.abs(pz - d.az) ? 'x' : 'z';
      d.bx = d.axis === 'x' ? px : d.ax;
      d.bz = d.axis === 'z' ? pz : d.az;
    } else if (d.stage === 'width') { // then stretched the other way
      if (d.axis === 'x') d.bz = pz; else d.bx = px;
    } else {
      d.bx = px;
      d.bz = pz;
    }
    return;
  }
  const [x0, z0, x1, z1] = wallBox(d);
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const eye = camera.matrices().eye;
  let nx = eye[0] - cx, nz = eye[2] - cz;
  const len = Math.hypot(nx, nz) || 1;
  nx /= len; nz /= len;
  const denom = dir[0] * nx + dir[2] * nz;
  if (Math.abs(denom) < 1e-5) return;
  const t = ((cx - origin[0]) * nx + (cz - origin[2]) * nz) / denom;
  if (t <= 0) return;
  const y = origin[1] + dir[1] * t;
  if (y >= d.level) {
    d.y0 = d.level;
    d.y1 = clamp(Math.ceil(y), d.level + 1, Math.min(d.level + BOX_MAX, SIZE[1] - 1));
  } else {
    d.y0 = clamp(Math.floor(y), Math.max(1, d.level + 1 - BOX_MAX), d.level);
    d.y1 = d.level + 1;
  }
}
function wallConfirm() {
  const d = wall.drawing;
  if (d.cmd) { // Mine's box: an open order to dig what's solid in it (not leaves: they wither once their tree's
    // gone); Fill's: an open order to fill what's empty in it with the palette's block
    wall.drawing = null;
    if (!d.queued) arm(null);
    const voxels = wallVoxels(d);
    const solid = voxels.filter(([x, y, z]) => terrain.block(x, y, z) !== BLOCK.LEAVES);
    if (d.cmd === 'fill') fillOrder(voxels);
    else if (d.unmark) unmarkMine(solid); // (started on a marked block: the box takes marks off)
    else mineOrder(solid, false, false); // (else it adds to them)
    return;
  }
  if (d.save) {
    const [x0, z0, x1, z1] = wallBox(d);
    const facing = facingToward((x0 + x1) / 2, (z0 + z1) / 2, camera.matrices().eye);
    // One spawn point per design: a box round more than one isn't saved.
    const inside = spawns.inBox(x0, z0, x1, z1, d.y0, d.y1);
    wall.drawing = null;
    if (inside.length > 1) { toast(`A design can have one spawn point: this box has ${inside.length}.`); return; }
    // Torches and banners in the box, or on the outside of a block in it (on its side, or a torch on its top: a box
    // hugging the walls leaves those out).
    const inBox = (x, y, z) => x >= x0 && x < x1 && y >= d.y0 && y < d.y1 && z >= z0 && z < z1;
    const held = ({ cell: [x, y, z], wall }) => inBox(x, y, z) || (wall ? inBox(x - wall[0], y, z - wall[1]) : inBox(x, y - 1, z));
    const lit = torches.list.filter(held), hung = banners.list.filter(held);
    const design = captureDesign(terrain, x0, z0, x1, z1, d.y0, d.y1, facing, '', inside[0], lit, hung);
    if (design) askDesignName(design);
    return;
  }
  sculptMark(wallVoxels(d), d.add, palette.block, true);
  wall.drawing = null;
}

// The building the cursor would place: { plan, fits }, or null.
function buildAt(hit) {
  if (build.press) hit = build.press.hit; // (being turned: where it was pressed)
  if (!hit || !BUILDINGS[build.item]) return null;
  // On the block under the cursor, whatever it is: the floor is the first empty voxel above it in its column.
  const x = Math.floor(hit.point[0] - hit.normal[0] * 0.01), z = Math.floor(hit.point[2] - hit.normal[2] * 0.01);
  let y0 = Math.floor(hit.point[1] - hit.normal[1] * 0.01) + 1;
  while (y0 < SIZE[1] && terrain.solid(x, y0, z)) y0++;
  // Turned so its front faces the camera (or the way it's been turned, see build), or, with a spawn point, so the unit
  // it brings out faces that way.
  const toCam = build.press?.facing ?? build.facing ?? facingToward(x + 0.5, z + 0.5, camera.matrices().eye), make = BUILDINGS[build.item].plan;
  if (build.press) Object.assign(build.press, { x, z, y0 });
  let plan = make(x, y0, z, toCam);
  if (plan.spawn) {
    const [wx, wz] = FACING_DIRS[toCam];
    for (let f = 0; f < 4; f++) {
      const p = f === toCam ? plan : make(x, y0, z, f);
      if (Math.round(p.spawn.dir[0]) === wx && Math.round(p.spawn.dir[1]) === wz) { plan = p; break; }
    }
  }
  // (A building with a spawn point must let its unit walk out.)
  const fits = canPlace(terrain, plan, y0, units.workers.jobs) && canExit(terrain, plan);
  return { plan, fits, short: fits && !!inventory?.planShort(plan) };
}

// Dragging from where a building was pressed: its front turned towards the point on its floor's level under the cursor.
function turnBuilding(clientX, clientY) {
  const p = build.press;
  if (p.x === undefined) return; // (no ghost yet)
  const { origin, dir } = rayAt(clientX, clientY), t = (p.y0 - origin[1]) / dir[1];
  if (!(t > 0)) return;
  const at = [origin[0] + dir[0] * t, 0, origin[2] + dir[2] * t];
  if (Math.hypot(at[0] - p.x - 0.5, at[2] - p.z - 0.5) < 0.5) return; // (right over it: no way to point)
  p.facing = facingToward(p.x + 0.5, p.z + 0.5, at);
}

// Flatten tool (4): drag a box on the ground. Idle villagers level it to the height where the drag started (the wheel
// moves that up and down while dragging): digging out what's above, filling in what's below. Any number of boxes can
// be open at once; each idle villager works on the nearest. Delete calls off the one under the cursor.
const flatten = { drawing: null }; // { ax, az, bx, bz, level } in voxel columns
// Whether voxel (x, y, z) is part of a tree: leaves, or a log with leaves on top of its stack (logs set as blocks
// have none).
function isTree(x, y, z) {
  const b = terrain.block(x, y, z);
  if (b === BLOCK.LEAVES) return true;
  if (b !== BLOCK.LOG) return false;
  while (terrain.block(x, y + 1, z) === BLOCK.LOG) y++;
  return terrain.block(x, y + 1, z) === BLOCK.LEAVES;
}
function flattenBox(d) {
  return [Math.min(d.ax, d.bx), Math.min(d.az, d.bz), Math.max(d.ax, d.bx) + 1, Math.max(d.az, d.bz) + 1];
}
// The box being drawn, as the terrain shader's marks (see FlattenJob.marks).
function flattenMarks(d) {
  const [x0, z0, x1, z1] = flattenBox(d);
  const short = inventory?.flattenShort(x0, z0, x1, z1, d.level, palette.block); // (yellow, see FlattenJob.marks)
  return [[x0, d.level, z0, 3], [x1, d.level, z1, short ? -1 : 0]];
}
function flattenDrag(x, y) {
  const d = flatten.drawing;
  const { origin, dir } = rayAt(x, y);
  if (Math.abs(dir[1]) < 1e-4) return;
  const t = (d.level - origin[1]) / dir[1];
  if (t <= 0) return;
  d.bx = clamp(Math.floor(origin[0] + dir[0] * t), 0, SIZE[0] - 1);
  d.bz = clamp(Math.floor(origin[2] + dir[2] * t), 0, SIZE[2] - 1);
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (possess.unit) return; // (just watching)
  canvas.setPointerCapture(e.pointerId);
  mouse.button = e.button;
  mouse.lastX = mouse.downX = e.clientX;
  mouse.lastY = mouse.downY = e.clientY;
  mouse.dragged = false;
  // A control group's banner (see groups.js): the same as its number.
  if (e.button === 0) {
    const { origin, dir } = rayAt(e.clientX, e.clientY);
    const n = groups.bannerAt(origin, dir);
    if (n >= 0) { selectGroup(n); mouse.skip = true; return; }
  }
  // A command armed (Q attack-move, E mine, the card's Move): this left click is its target, whatever the tool (with
  // Shift: queued, and it stays armed). Mine and Fill are modes: always added to the open orders, and they stay on
  // till right click, Esc, their key again or another mode. They can draw a box too, the way Lower does: drag the
  // footprint, release, move up or down for its height, click.
  if (e.button === 0 && command.armed === 'wall') { // Wall: a line dragged from the ground pressed
    if (brush.hit) {
      const c = brush.hit.point.map((v, i) => Math.floor(v - brush.hit.normal[i] * 0.01));
      wallLine.d = { a: [c[0], c[2]], b: [c[0], c[2]], y: c[1] + 1 };
    }
    mouse.skip = true;
    return;
  }
  if (e.button === 0 && command.armed === 'farm') { // Farm: a click marks the top clicked; a drag, every top in its box
    if (brush.hit) {
      const c = brush.hit.point.map((v, i) => Math.floor(v - brush.hit.normal[i] * 0.01));
      farmDraw.d = { cell: c, ax: c[0], az: c[2], bx: c[0], bz: c[2], plane: c[1] + 1 };
    }
    mouse.skip = true;
    return;
  }
  if (e.button === 0 && (command.armed === 'dig' || command.armed === 'fill')) {
    if (wall.drawing?.cmd && wall.drawing.stage === 'width') Object.assign(wall.drawing, { stage: 'height', raising: true }); // footprint done: now the height
    else if (wall.drawing?.cmd && wall.drawing.raising) wallConfirm(); // (the height: that's the box)
    else if (brush.hit) dig.press = { hit: brush.hit, queued: true, cmd: command.armed, veins: e.shiftKey }; // (a mode: stays on; Shift: a whole ore vein)
    mouse.skip = true;
    return;
  }
  if (e.button === 0 && command.armed) {
    if (command.armed === 'attack') attackMove(e.clientX, e.clientY, e.shiftKey);
    else if (command.armed === 'patrol') patrolOrder(e.clientX, e.clientY, e.shiftKey);
    else moveOrder(e.clientX, e.clientY, e.shiftKey);
    if (!e.shiftKey) arm(null);
    mouse.button = -1;
    mouse.skip = true;
    return;
  }
  if (e.button === 0 && brush.tool === 'flatten') {
    const { origin, dir } = rayAt(e.clientX, e.clientY);
    const hit = terrain.raycast(origin, dir);
    if (hit) {
      const cx = Math.floor(hit.point[0] - hit.normal[0] * 0.01), cz = Math.floor(hit.point[2] - hit.normal[2] * 0.01);
      const cy = Math.floor(hit.point[1] - hit.normal[1] * 0.01);
      // Started on a tree: the plane goes at the ground under it. On any other block: at that block's top.
      const tree = isTree(cx, cy, cz);
      const level = tree ? terrain.groundAt(cx, cz) : cy + 1;
      flatten.drawing = { ax: cx, az: cz, bx: cx, bz: cz, level, cell: [cx, cy, cz], tree };
    }
  } else if (e.button === 0 && brush.tool === 'build' && build.item === 'save') {
    if (wall.drawing?.raising) wallConfirm();
    else if (brush.hit) brush.press = { hit: brush.hit, add: true, save: true };
  } else if (e.button === 0 && brush.tool === 'build' && build.item === 'spawn') {
    // A spawn point (editor): on the top of a block, facing the camera; a click on one turns it a quarter.
    const p = spawns.placement(brush.hit), on = p && spawns.at(...p.cell);
    if (on) spawns.turn(on);
    else if (p?.fits) spawns.add(p.cell, cameraFacing(p.cell));
  } else if (e.button === 0 && brush.tool === 'build' && build.item === 'torch') {
    const p = torches.placement(brush.hit);
    if (p?.fits) { order(torches.add(p)); orderSound('work'); }
  } else if (e.button === 0 && brush.tool === 'build' && build.item === 'portcullis') {
    // A portcullis: in two sections of the player's own built wall (the one clicked and the next along it, on the side
    // clicked nearer), its iron paid now (given back if it's called off before it's made).
    const p = gates.placement(brush.hit, 'blue'), n = inventory ? Math.round(GATE_TUNING.iron) : 0;
    if (!p) { toast('Click a section of your own wall to put a portcullis in it'); sfx('error'); }
    else if (!p.fits) {
      toast({ enemy: 'That wall isn\'t yours', unbuilt: 'That wall isn\'t finished yet', used: 'That wall can\'t take a portcullis (one\'s there already, or it\'s too low)',
        straight: 'A portcullis needs two sections of wall side by side in a straight line, on the same level' }[p.why] ?? 'A portcullis can\'t go there');
      sfx('error');
    } else if (n > 0 && inventory.get(BLOCK.IRON) < n) { toast(`Not enough iron for a portcullis (${n})`); sfx('error'); }
    else {
      const job = gates.add(p, 'blue'), g = job.gate, base = job.cancel.bind(job);
      // (A banner hung down over its opening comes down: the wall's own, or one hung on it in the Editor.)
      for (const s of p.tiles) s.banner = false;
      banners.list = banners.list.filter((b) => !p.tiles.some((s) => b.cell[0] - b.wall[0] === s.x && b.cell[2] - b.wall[1] === s.z));
      if (n > 0) {
        inventory.add(BLOCK.IRON, -n);
        job.cancel = () => { if (!g.built) inventory?.add(BLOCK.IRON, n); base(); };
      }
      job.onMade = gateMade;
      order(job);
      orderSound('work');
      if (!e.shiftKey) { setTool('select'); mouse.skip = true; }
    }
  } else if (e.button === 0 && brush.tool === 'build' && BANNER_ITEMS[build.item]) {
    // A banner (Editor): on the side of a block; a click on one there takes it down (or changes its length).
    const p = banners.placement(brush.hit, BANNER_ITEMS[build.item]);
    if (p?.fits || (p && banners.at(...p.cell))) sfx(banners.toggle(p) ? 'toggleOn' : 'toggleOff');
  } else if (e.button === 0 && brush.tool === 'build') {
    if (BUILDINGS[build.item] && brush.hit) build.press = { hit: brush.hit, facing: null }; // (placed on release, if not dragged)
  } else if (e.button === 0 && (brush.tool === 'raise' || brush.tool === 'lower')) {
    if (wall.drawing?.raising) wallConfirm();
    else if (brush.hit) brush.press = { hit: brush.hit, add: (brush.tool === 'raise') !== e.shiftKey };
  }
});
// A building placed (a click with the Build tool), where its ghost is: ordered for idle villagers to build.
function placeBuilding(shift) {
  const b = buildAt(brush.hit);
  // (In a new game, what it costs on top of its blocks, the Stables' gold, is paid as it's placed, and given back
  // if it's cancelled before it's built.)
  const extra = inventory ? buildExtra(build.item) : [], short = extra.filter(([blk, n]) => inventory.get(blk) < n);
  if (b?.fits && short.length) { toast(`Not enough ${short.map(([blk]) => CURRENCY_NAMES[blk]).join(' or ')} for the ${BUILDINGS[build.item].name}`); sfx('error'); }
  else if (b?.fits) {
    const job = new BuildJob(terrain, b.plan), key = build.item, name = BUILDINGS[key].name;
    Object.assign(job, { key, name, siteId: ++siteIds }); // (selectable while it's built: see siteAt)
    for (const [blk, n] of extra) inventory.add(blk, -n);
    if (extra.length) job.cancel = () => { if (!job.done) for (const [blk, n] of extra) inventory?.add(blk, n); };
    // Once it's built: a building to select, its torches to be set (after the units' update, see finishBuilding).
    job.onDone = () => finishedPlans.push({ plan: b.plan, key, name });
    order(job);
    orderSound('work');
    // Placed: back to the Select tool (Shift keeps building, turned the same way).
    if (!shift) setTool('select');
  }
}
canvas.addEventListener('pointerup', (e) => {
  if (possess.unit) return;
  if (e.button === 0 && wallLine.d) { // Wall's line: ordered
    const d = wallLine.d;
    wallLine.d = null;
    mouse.skip = false;
    mouse.button = -1;
    wallOrder(d);
    return;
  }
  if (e.button === 0 && farmDraw.d) { // Farm's click or box
    const d = farmDraw.d;
    farmDraw.d = null;
    mouse.skip = false;
    mouse.button = -1;
    farmOrder(mouse.dragged ? farms.box(...farmBox(d)) : [d.cell].filter((c) => farms.farmable(...c) && !farms.has(c[0], c[2])));
    return;
  }
  if (e.button === 0 && build.press) { // the Build tool: a click places the building, a drag only turned it
    const turned = mouse.dragged ? build.press.facing : null;
    if (!mouse.dragged) placeBuilding(e.shiftKey);
    build.press = null;
    if (turned !== null) build.facing = turned;
    mouse.button = -1;
    return;
  }
  if (e.button === 0 && mouse.skip) { // (a command's click)
    mouse.skip = false;
    if (wall.drawing?.cmd && wall.drawing.stage === 'line') wall.drawing.stage = 'width'; // line done: now stretch it sideways
    else if (dig.press && !mouse.dragged) { // a click: the block (or tree) clicked, or the empty voxel in front of it
      const { hit, queued, cmd, veins } = dig.press;
      if (!queued) arm(null);
      if (cmd === 'fill') fillOrder(fillTarget(hit));
      else mineOrder(mineTarget(hit.point.map((v, i) => Math.floor(v - hit.normal[i] * 0.01))), veins);
    }
    dig.press = null;
    mouse.button = -1;
    return;
  }
  if (e.button === 0) {
    if (wall.drawing && !wall.drawing.raising) wall.drawing.raising = true; // footprint done: now the height
    else if (brush.press && !brush.press.save) { // a click: the brush's cube
      sculptMark(brushVoxels(terrain, brush.press.hit, brush.radius, brush.press.add), brush.press.add, palette.block);
    }
    brush.press = null;
    if (flatten.drawing) {
      const d = flatten.drawing;
      // A click (not a drag) on a tree fells the whole tree, wherever on it the click was.
      const trunk = !mouse.dragged && d.tree && findTrunk(terrain, ...d.cell);
      if (trunk) harvest(trunk);
      else order(new FlattenJob(terrain, ...flattenBox(d), d.level, palette.block));
      orderSound('work');
      flatten.drawing = null;
    }
    if (brush.tool === 'select') {
      if (mouse.dragged) boxSelect(e.shiftKey); else clickSelect(e.clientX, e.clientY, e.shiftKey);
      selectBox.hidden = true;
    }
  }
  if (e.button === 2 && !mouse.dragged) {
    if (command.armed) arm(null); // (right click calls off an armed command)
    else if (brush.tool === 'build') setTool('select'); // (and the Build tool)
    else moveOrder(e.clientX, e.clientY, e.shiftKey);
  }
  if (e.button === mouse.button) mouse.button = -1;
});
canvas.addEventListener('pointermove', (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  mouse.inside = true;
  const dx = e.clientX - mouse.lastX, dy = e.clientY - mouse.lastY;
  mouse.lastX = e.clientX;
  mouse.lastY = e.clientY;
  if (mouse.button >= 0 && Math.hypot(e.clientX - mouse.downX, e.clientY - mouse.downY) > CLICK_SLOP) mouse.dragged = true;
  if (mouse.button === 0 && brush.tool === 'select' && mouse.dragged && !mouse.skip && !dig.press && !wall.drawing?.cmd) {
    Object.assign(selectBox.style, {
      left: `${Math.min(mouse.downX, e.clientX)}px`, top: `${Math.min(mouse.downY, e.clientY)}px`,
      width: `${Math.abs(e.clientX - mouse.downX)}px`, height: `${Math.abs(e.clientY - mouse.downY)}px`,
    });
    selectBox.hidden = false;
  }
  if (mouse.button === 0 && build.press && mouse.dragged) turnBuilding(e.clientX, e.clientY);
  if (mouse.button === 0 && flatten.drawing) flattenDrag(e.clientX, e.clientY);
  if (mouse.button === 0 && farmDraw.d && mouse.dragged) farmDrag(e.clientX, e.clientY);
  if (mouse.button === 0 && wallLine.d) wallDragTo(e.clientX, e.clientY);
  if (dig.press && mouse.dragged && !wall.drawing) {
    wallStart(dig.press.hit, dig.press.cmd === 'fill');
    // (A Mine box started on a marked block takes marks off; started anywhere else, it adds to them.)
    const h = dig.press.hit, on = dig.press.cmd === 'dig' && !insta.on ? mineTarget(h.point.map((v, i) => Math.floor(v - h.normal[i] * 0.01))) : [];
    Object.assign(wall.drawing, { cmd: dig.press.cmd, queued: dig.press.queued, stage: 'line', unmark: on.length > 0 && isMarked(on[0]) });
  }
  if (brush.press && mouse.dragged && !wall.drawing) wallStart(brush.press.hit, brush.press.add, brush.press.save);
  if (wall.drawing && (wall.drawing.raising || mouse.button === 0 || wall.drawing.stage === 'width')) wallDrag(e.clientX, e.clientY);
  if (mouse.button === 2) {
    camera.orbit(-dx * 0.005, dy * 0.005);
  } else if (mouse.button === 1) {
    // Drag the ground: a pixel is worth this much ground at the target's distance.
    const perPixel = (2 * Math.tan(CAMERA_TUNING.fov / 2)) / canvas.clientHeight;
    camera.pan(-dx * perPixel, dy * perPixel / Math.sin(camera.pitch), SIZE);
  }
});
canvas.addEventListener('pointerleave', () => { mouse.inside = false; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (possess.unit) return;
  if (flatten.drawing) {
    flatten.drawing.level = clamp(flatten.drawing.level - Math.sign(e.deltaY), 1, SIZE[1] - 2);
    flattenDrag(mouse.x, mouse.y);
    return;
  }
  camera.zoom(Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
}, { passive: false });
// The keys (Controls, F1, lists them). The camera is on the arrows (and PgUp/PgDn), the dock's orders and training on
// Q W E R, Craft on Z X C V B; Esc steps back out (an overlay, an armed order, a box being drawn, a tool, the selection)
// and at the last opens the pause menu.
const MENU_KEYS = { Enter: 'new', KeyS: 'sandbox', KeyW: 'editor' };
if (/[?&]dev\b/.test(location.search)) document.body.classList.add('dev-on');
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
  if (/^F[1-9]$/.test(e.code)) e.preventDefault(); // (not the browser's help, find, reload...)
  // ` shows or hides the developer's buttons, fps and panels (top right); T and G open their panels, so show them too.
  if (e.code === 'Backquote' && !e.repeat) { document.body.classList.toggle('dev-on'); return; }
  if (e.code === 'KeyT' || e.code === 'KeyG') document.body.classList.add('dev-on');
  if (overlays.length) { // an overlay open: Esc closes it; the pause menu's own keys
    const top = overlays.at(-1);
    if (e.code === 'Escape') closeOverlay();
    else if (top === 'pause' && e.code === 'F1') openOverlay('controls');
    else if (top === 'pause' && e.code === 'KeyO') openOverlay('options');
    else if (top === 'pause' && e.code === 'KeyQ') toMainMenu();
    else if (top === 'controls' && e.code === 'F1') closeOverlay();
    else if (e.code === 'KeyT') tuning.toggle();
    return;
  }
  if (!mode.name) { // the main menu, or New game's setup screen
    if (!setupBox.hidden) {
      if (e.code === 'Escape') showSetup(false);
      else if (e.code === 'Enter' && !(e.target instanceof HTMLButtonElement)) setupBox.querySelector('[data-setup="start"]').click();
    } else if (MENU_KEYS[e.code] && !e.repeat) menu.querySelector(`button[data-mode="${MENU_KEYS[e.code]}"]:not(:disabled)`)?.click();
    else if (e.code === 'KeyO') openOverlay('options');
    else if (e.code === 'F1') openOverlay('controls');
    else if (e.code === 'KeyC') openOverlay('credits');
    if (e.code === 'KeyT') tuning.toggle();
    if (e.code === 'KeyG') toggleProfiler();
    return;
  }
  if (possess.unit) { // possessing a unit: just watching (Esc or J goes back), and the panels
    if (e.code === 'Escape' || (e.code === 'KeyJ' && !e.repeat)) endPossess();
    else if (e.code === 'KeyT') tuning.toggle();
    else if (e.code === 'KeyG') toggleProfiler();
    else if (e.code === 'F2') document.body.classList.toggle('hud-off');
    return;
  }
  keys.add(e.code);
  // Control groups (see groups.js): Ctrl (or ⌘)+number makes the selection the group, Shift+number adds it, the
  // number selects it (twice: and looks at it).
  const digit = /^(Digit|Numpad)([0-9])$/.exec(e.code);
  if (digit && !e.altKey) {
    e.preventDefault();
    const n = +digit[2];
    if (e.ctrlKey || e.metaKey) { groups.assign(n, units.commandable()); sfx('group'); }
    else if (e.shiftKey) { groups.assign(n, units.commandable(), true); sfx('group'); }
    else if (!e.repeat) selectGroup(n);
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.repeat && !['BracketLeft', 'BracketRight', 'Minus', 'Equal', 'NumpadSubtract', 'NumpadAdd', 'PageUp', 'PageDown'].includes(e.code)) return;
  // The dock: Q W E R its orders (or a building's training and rally), Z X C V B Craft.
  const slot = ['KeyQ', 'KeyW', 'KeyE', 'KeyR'].indexOf(e.code);
  if (slot >= 0) { actionSlots[slot]?.(); return; }
  const craft = ['KeyZ', 'KeyX', 'KeyC', 'KeyV'].indexOf(e.code);
  if (craft >= 0) { CRAFT[craft].run(); return; }
  if (e.code === 'KeyB') { toggleMode('wall'); return; } // (Wall, in the Build menu)
  switch (e.code) {
    case 'F1': openOverlay('controls'); break;
    case 'F2': document.body.classList.toggle('hud-off'); break;
    case 'F3': setTool('raise'); break;
    case 'F4': setTool('lower'); break;
    case 'F5': setTool('flatten'); break;
    case 'KeyM': setMinimapCollapsed(!minimapEl.classList.contains('collapsed')); break;
    case 'Period': case 'NumpadDecimal': if (mode.name === 'new') nextIdle(); break;
    case 'Space': e.preventDefault(); goToAlert(); break;
    case 'KeyL':
      if (e.shiftKey) { GI_TUNING.on = (Math.round(GI_TUNING.on) + 1) % 3; tuning.refresh(); toast(`Lighting: ${['plain', 'sky visibility', 'bounce light'][GI_TUNING.on]}`, 1.5); } // GI A/B
      else lookAtSelection();
      break;
    case 'KeyJ': startPossess(); break;
    case 'KeyN': if (mode.name === 'sandbox') spawnAtCursor(e.shiftKey ? 'red' : 'blue', spawnKind); break;
    case 'KeyI': if (mode.name !== 'new') toggleInsta(); break;
    case 'KeyO': if (mode.name === 'sandbox') toggleFog(); break;
    case 'Minus': case 'NumpadSubtract': if (mode.name === 'sandbox') setGameSpeed(GAME_SPEED.speed - 0.1); break;
    case 'Equal': case 'NumpadAdd': if (mode.name === 'sandbox') setGameSpeed(GAME_SPEED.speed + 0.1); break;
    case 'BracketLeft': setRadius(brush.radius - 1); break;
    case 'BracketRight': setRadius(brush.radius + 1); break;
    case 'KeyP': camera.ortho = !camera.ortho; break;
    case 'KeyG': toggleProfiler(); document.body.classList.add('dev-on'); break;
    case 'KeyT': tuning.toggle(); document.body.classList.add('dev-on'); break;
    case 'Delete': case 'Backspace': cancelJobAtCursor(); break;
    case 'Escape':
      if (pendingDesign) { hideDesignName(); renderModebar(); }
      else if (command.armed) arm(null);
      else if (flatten.drawing) flatten.drawing = null;
      else if (wall.drawing) { wall.drawing = null; brush.press = null; }
      else if (brush.tool !== 'select') setTool('select');
      else if (buildings.selected || site || units.list.some((u) => u.selected)) { for (const u of units.list) u.selected = false; buildings.selected = null; site = null; }
      else pauseGame();
      break;
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => { keys.clear(); brush.press = null; mouse.button = -1; });

// A control group's number (or its banner clicked): it's selected; twice quickly, the camera goes to it.
function selectGroup(n) {
  if (!groups.groups.has(n)) return;
  sfx('group');
  buildings.selected = null;
  const at = groups.select(n);
  if (at) { camera.target[0] = at[0]; camera.target[2] = at[1]; }
}

// The arrows move the camera, PgUp and PgDn tilt it, and so does the mouse at the screen's edge (Options, or
// HUD_TUNING.edgePan: within edgeMargin pixels of it, at edgeSpeed). Off the sandbox, - and + zoom.
const edge = { x: -1, y: -1 };
window.addEventListener('pointermove', (e) => { edge.x = e.clientX; edge.y = e.clientY; });
document.addEventListener('pointerleave', () => { edge.x = edge.y = -1; });
function keyboardCamera(dt) {
  const k = (...codes) => (codes.some((c) => keys.has(c)) ? 1 : 0);
  const pan = 0.8 * dt;
  let right = k('ArrowRight') - k('ArrowLeft');
  let fwd = k('ArrowUp') - k('ArrowDown');
  const H = HUD_TUNING, M = Math.max(1, H.edgeMargin);
  if (H.edgePan >= 0.5 && edge.x >= 0 && document.hasFocus() && mode.name && mouse.button < 0 && !overlays.length) {
    const w = window.innerWidth, h = window.innerHeight;
    if (edge.x <= M) right -= H.edgeSpeed; else if (edge.x >= w - 1 - M) right += H.edgeSpeed;
    if (edge.y <= M) fwd += H.edgeSpeed; else if (edge.y >= h - 1 - M) fwd -= H.edgeSpeed;
  }
  if (right || fwd) camera.pan(right * pan, fwd * pan, SIZE);
  camera.orbit(0, (k('PageUp') - k('PageDown')) * 1.0 * dt);
  if (mode.name === 'sandbox') return; // (- and + set the game speed there instead)
  if (keys.has('Equal') || keys.has('NumpadAdd')) camera.zoom(Math.exp(-1.5 * dt));
  if (keys.has('Minus') || keys.has('NumpadSubtract')) camera.zoom(Math.exp(1.5 * dt));
}

// Slow motion (sandbox): - and + step the game speed down or up by 0.1, from 0.1 to 1.
function setGameSpeed(v) {
  const was = GAME_SPEED.speed;
  GAME_SPEED.speed = clamp(Math.round(v * 10) / 10, 0.1, 1);
  if (GAME_SPEED.speed !== was) sfx(GAME_SPEED.speed < was ? 'slowDown' : 'speedUp');
  tuning.refresh();
  showSpeed();
  toast(`Game speed ×${GAME_SPEED.speed.toFixed(1)}`, 1.2);
}

// --- Brush and units ---------------------------------------------------------------------------------------

function rayAt(clientX, clientY, invViewProj = camera.matrices().invViewProj) {
  const ndcX = (clientX / canvas.clientWidth) * 2 - 1;
  const ndcY = 1 - (clientY / canvas.clientHeight) * 2;
  return camera.ray(invViewProj, ndcX, ndcY);
}

function pick(invViewProj) {
  if (!mouse.inside) return null;
  const { origin, dir } = rayAt(mouse.x, mouse.y, invViewProj);
  const hit = terrain.raycast(origin, dir);
  // (Nothing there to pick where never seen isn't drawn.)
  if (hit && blankOn && fog.blankAt(hit.point[0] - hit.normal[0] * 0.01, hit.point[2] - hit.normal[2] * 0.01)) return null;
  return hit;
}

// The villager under screen point (x, y), unless the ground's in front of it.
function unitAt(x, y) {
  const { origin, dir } = rayAt(x, y);
  const hit = units.pick(origin, dir);
  const ground = terrain.raycast(origin, dir);
  return hit && (!ground || hit.t <= ground.t + 0.5) ? hit.unit : null;
}

// What's under screen point (x, y) to attack: a villager, or a Keep's power crystal for a click on the Keep (the
// crystal's inside, drawn up over its roof). Or null.
function targetAt(x, y) {
  const u = unitAt(x, y);
  if (u) return u;
  const { origin, dir } = rayAt(x, y);
  const hit = terrain.raycast(origin, dir);
  const gate = gates.rayHit(origin, dir, hit?.t ?? Infinity)?.s.unit; // (a portcullis, through its opening)
  if (gate && !gate.dying && !gate.hidden) return gate;
  if (!hit) return null;
  const [cx, cy, cz] = hit.point.map((v, i) => Math.floor(v - hit.normal[i] * 0.01));
  const w = walls.at(cx, cy, cz)?.unit; // (a section of wall)
  if (w && !w.dying && !w.hidden) return w;
  for (const [team, plan] of keeps) {
    if (!plan.blocks.some(([bx, by, bz]) => bx === cx && by === cy && bz === cz)) continue;
    return units.list.find((o) => o.kind === 'crystal' && o.team === team && !o.dying && !o.hidden) ?? null;
  }
  return null;
}
// Sends the selected fighters (all but workers) of other teams than target's to attack it (an archer, spearman or mage
// out of range walks up to its range first; workers don't fight). Returns whether any went.
function attackOrder(target) {
  const sel = units.commandable().filter((u) => u.team !== target.team && u.kind !== 'worker');
  for (const u of sel) units.attack(u, target, true, true);
  if (sel.length) orderSound('attack');
  return sel.length > 0;
}

// Select tool click: picks a unit (of either team); left click only ever selects (orders are right click, the command
// keys and the command card).
function clickSelect(x, y, add) {
  const target = unitAt(x, y);
  // Not on a villager: a finished building there is selected, on its own.
  const b = target ? null : buildingAt(x, y);
  // (Or, on none, a building still being built: see dockSite.)
  const s = target || b ? null : siteAt(x, y);
  if (!add || b || s || buildings.selected || site) for (const u of units.list) u.selected = false;
  if (target) target.selected = add ? !target.selected : true;
  buildings.selected = b;
  site = s;
  if (target || b || s) sfx('select');
}
// A building being built (a Build order of the player's, see placeBuilding) under screen point (x, y): the nearest
// whose blocks, placed or still to place, the ray meets before (or at) the ground. Or null.
function siteAt(x, y) {
  const { origin, dir } = rayAt(x, y);
  const hit = terrain.raycast(origin, dir);
  const far = hit ? Math.hypot(...hit.point.map((v, i) => v - origin[i])) + 0.05 : Infinity;
  let best = null, bestT = far;
  for (const job of units.workers.jobs) {
    if (!job.siteId || job.done) continue;
    for (const [bx, by, bz] of job.plan.blocks) {
      let t0 = 0, t1 = bestT;
      for (let a = 0; a < 3 && t0 <= t1; a++) {
        const lo = [bx, by, bz][a];
        if (Math.abs(dir[a]) < 1e-9) { if (origin[a] < lo || origin[a] > lo + 1) t0 = Infinity; continue; }
        let ta = (lo - origin[a]) / dir[a], tb = (lo + 1 - origin[a]) / dir[a];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      }
      if (t0 <= t1 && t0 < bestT) { bestT = t0; best = job; }
    }
  }
  return best;
}

// Mining: the god panel's Mine (E, then click a block or tree, or drag a box), an open order for the idle workers.
// What mining voxel c means: a tree (its trunk or leaves) is felled from its bottom log; anything else solid but
// leaves and the bedrock is dug. As [[x, y, z]], or [].
function mineTarget(c) {
  const trunk = findTrunk(terrain, ...c);
  if (trunk) return [trunk];
  const [x, y, z] = c;
  return y >= 1 && terrain.solid(x, y, z) && terrain.block(x, y, z) !== BLOCK.LEAVES ? [c] : [];
}
// Fill (U): the empty voxel in front of the face clicked, as [[x, y, z]], or [].
function fillTarget(hit) {
  const c = hit.point.map((v, i) => Math.floor(v + hit.normal[i] * 0.5));
  return c[1] >= 1 && c[1] < SIZE[1] && terrain.block(...c) === BLOCK.AIR ? [c] : [];
}
// Iron or gold ore Shift-clicked with Mine: the whole vein, every block of that ore joined to it face to face (up to
// ORE_VEIN_MAX of them); a tree: its whole forest (see forestOf). (A plain click or a box mines just what it's given.)
const ORE_VEIN_MAX = 4000;
function withVeins(voxels) {
  const seen = new Set(), out = [];
  const key = (x, y, z) => terrain.index(x, y, z);
  for (const c of voxels) {
    const k = key(...c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    const b = terrain.block(...c);
    if (b === BLOCK.LOG) {
      for (const q of forestOf(terrain, c)) {
        const kq = key(...q);
        if (!seen.has(kq)) { seen.add(kq); out.push(q); }
      }
      continue;
    }
    if (!isOre(b)) continue;
    const stack = [c];
    for (let n = 0; stack.length && n < ORE_VEIN_MAX; n++) {
      const [x, y, z] = stack.pop();
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const q = [x + dx, y + dy, z + dz];
        if (q[1] < 1 || terrain.block(...q) !== b) continue;
        const kq = key(...q);
        if (seen.has(kq)) continue;
        seen.add(kq);
        out.push(q);
        stack.push(q);
      }
    }
  }
  return out;
}
// Mine (the god panel's): an open order like a building's, on the shared mine job: idle workers within
// WORK_TUNING.jobRange take its columns, each the nearest to it, and dig them out (a tree's bottom log fells it; ore
// brings its whole vein). Delete clears its marks under the brush; insta-build digs it at once.
function mineOrder(voxels, veins = false, toggle = true) {
  if (!voxels.length) return;
  // A click on what's already marked takes its marks off instead (with Shift, the whole vein's or forest's).
  if (toggle && !insta.on && isMarked(voxels[0])) { unmarkMine(veins ? withVeins(voxels) : voxels); return; }
  orderSound('work');
  const job = insta.on ? new MineJob(terrain, null) : mines;
  // (Not a wall or a building: not the player's own, and enemies' walls are knocked down, not mined. The Editor mines
  // anything, to change what's built.)
  const free = mode.name === 'editor';
  for (const [x, y, z] of veins ? withVeins(voxels) : voxels) if (free || (!walls.at(x, y, z) && !buildings.at.has(terrain.index(x, y, z)))) job.add(x, y, z);
  if (insta.on) units.workers.finish(job);
  else if (!job.done && !units.workers.jobs.includes(job)) units.workers.add(job);
}
// Whether voxel c is marked for mining (a log: any of its tree's trunk).
function isMarked(c) {
  if (terrain.block(...c) !== BLOCK.LOG) return mines.has(...c);
  const trunk = findTrunk(terrain, ...c);
  return !!trunk && trunkLogs(terrain, ...trunk).some((q) => mines.has(...q));
}
// Takes the Mine marks off these voxels (a log: off its whole trunk).
function unmarkMine(voxels) {
  for (const c of voxels) {
    if (terrain.block(...c) !== BLOCK.LOG) { mines.remove(...c); continue; }
    const trunk = findTrunk(terrain, ...c);
    for (const q of trunk ? trunkLogs(terrain, ...trunk) : [c]) mines.remove(...q);
  }
  sfx('toggleOff');
}
// Fill (the god panel's): an open order like a building's, on the shared sculpt job: idle workers within
// WORK_TUNING.jobRange take its columns, each the nearest to it, and fill them with the palette's block (in a new game, from the inventory; marks it can't
// cover show yellow). Delete clears its marks under the brush.
function fillOrder(voxels) {
  if (voxels.length) { sculptMark(voxels, true, palette.block, true); orderSound('work'); }
}
// Farm (6): an open order on the shared farm job (farm.js): idle workers within WORK_TUNING.jobRange till the marked
// grass or dirt tops, wheat grows there, and they reap it when it's ripe. Insta-build tills them at once. Delete clears
// farms under the brush.
function farmOrder(cells) {
  if (!cells.length) return;
  orderSound('work');
  farms.mark(cells, insta.on);
  farms.update(0, units.workers);
}
// Farm's box, dragged out on the plane of the top first pressed: { cell, ax, az, bx, bz, plane }.
const farmDraw = { d: null };
const FARM_BOX_MAX = 64; // columns a side
function farmBox(d) {
  const x0 = Math.min(d.ax, d.bx), z0 = Math.min(d.az, d.bz);
  return [x0, z0, Math.min(Math.max(d.ax, d.bx) + 1, x0 + FARM_BOX_MAX), Math.min(Math.max(d.az, d.bz) + 1, z0 + FARM_BOX_MAX)];
}
function farmDrag(clientX, clientY) {
  const d = farmDraw.d;
  const { origin, dir } = rayAt(clientX, clientY);
  if (Math.abs(dir[1]) < 1e-4) return;
  const t = (d.plane - origin[1]) / dir[1];
  if (t <= 0) return;
  d.bx = clamp(Math.floor(origin[0] + dir[0] * t), 0, SIZE[0] - 1);
  d.bz = clamp(Math.floor(origin[2] + dir[2] * t), 0, SIZE[2] - 1);
}
// Wall (F9, see walls.js): a straight line pressed out over the ground (along x, z or a diagonal), ordered once it's
// let go: the player's team's wall, of the palette's planks or bricks. { a: [x, z], b: [x, z], y: the ground pressed }.
const wallLine = { d: null };
function wallDragTo(clientX, clientY) {
  const d = wallLine.d, { origin, dir } = rayAt(clientX, clientY), hit = terrain.raycast(origin, dir);
  if (hit) {
    const c = hit.point.map((v, i) => Math.floor(v - hit.normal[i] * 0.01));
    d.b = [c[0], c[2]];
  } else if (Math.abs(dir[1]) > 1e-4) { // (off the ground: where it meets the height pressed)
    const t = (d.y - origin[1]) / dir[1];
    if (t > 0) d.b = [Math.floor(origin[0] + dir[0] * t), Math.floor(origin[2] + dir[2] * t)];
  }
}
// The wall line d would order (see Walls.line), and the way its outer face looks: away from its team's Keep (or, with
// none, towards the camera), as one of x or z (where its torches lean out and its banners face).
function wallPlan(d) {
  const L = walls.line(d.a, d.b, d.y), [sx, sz] = L.dir;
  const mid = [(d.a[0] + d.b[0]) / 2 + 0.5, (d.a[1] + d.b[1]) / 2 + 0.5];
  const keep = keeps.get('blue'), box = keep && planBox(keep);
  const from = box ? [(box.lo[0] + box.hi[0]) / 2, (box.lo[2] + box.hi[2]) / 2] : null;
  let p = [-sz, sx];
  if (p[0] && p[1]) p = [p[0], 0]; // (a diagonal: out along x)
  const away = from ? (mid[0] - from[0]) * p[0] + (mid[1] - from[1]) * p[1] : (camera.eye()[0] - mid[0]) * p[0] + (camera.eye()[2] - mid[1]) * p[1];
  if (away < 0) p = [-p[0], -p[1]];
  if (!p[0] && !p[1]) p = [0, 1];
  return { ...L, out: p };
}
function wallOrder(d) {
  const block = wallBlock(palette.block);
  if (!block) { toast('Walls are built of planks or bricks', 3); return; }
  const P = wallPlan(d);
  if (!P.cols.length) return;
  sculptMark(walls.order(P.cols, block, 'blue', P.out), true, block, true);
  orderSound('work');
}

// Mine (E; 'dig' inside) and Fill (U): a click on a block, or a box drawn in steps (wall.drawing with cmd set, its
// stage 'line' while the first drag runs along x or z, 'width' once released while it's stretched the other way, then
// 'height' after a click, which the next click confirms: see wallDrag and wallConfirm).
const dig = { press: null }; // { hit, queued, cmd }: where a Mine or Fill press began

// Whether u (alive) is on screen within the box x0..x1, y0..y1 (CSS pixels).
function inBox(u, x0, y0, x1, y1, viewProj = camera.matrices().viewProj) {
  const [nx, ny, nz] = mat4.project(viewProj, u.pos[0], u.pos[1] + 1, u.pos[2]);
  const sx = (nx * 0.5 + 0.5) * canvas.clientWidth, sy = (0.5 - ny * 0.5) * canvas.clientHeight;
  return !u.dying && !u.hidden && nz >= 0 && nz <= 1 && sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1;
}

function boxSelect(add) {
  const x0 = Math.min(mouse.downX, mouse.lastX), x1 = Math.max(mouse.downX, mouse.lastX);
  const y0 = Math.min(mouse.downY, mouse.lastY), y1 = Math.max(mouse.downY, mouse.lastY);
  const { viewProj } = camera.matrices();
  let any = false;
  for (const u of units.list) {
    if (u.kind !== 'wall' && inBox(u, x0, y0, x1, y1, viewProj)) u.selected = any = true; else if (!add) u.selected = false;
  }
  if (!add || units.list.some((u) => u.selected)) buildings.selected = null;
  if (any) sfx('select');
}

// Select tool double click on a villager: every one of its kind and team on screen (Shift: added to the selection).
canvas.addEventListener('dblclick', (e) => {
  if (brush.tool !== 'select' || possess.unit) return;
  const target = unitAt(e.clientX, e.clientY);
  if (!target) return;
  const { viewProj } = camera.matrices();
  for (const u of units.list) {
    const like = u.kind === target.kind && u.team === target.team && inBox(u, 0, 0, canvas.clientWidth, canvas.clientHeight, viewProj);
    if (like) u.selected = true; else if (!e.shiftKey) u.selected = false;
  }
  buildings.selected = null;
  sfx('select');
});

// Orders the tree with this trunk felled, unless a job already covers it.
function harvest(trunk) {
  if (!insta.on && units.workers.jobs.some((j) => j.contains(trunk[0], trunk[2]))) return;
  order(harvestJob(terrain, trunk));
}

// Insta-build (I): edits happen at once, instead of being left as jobs for the villagers.
const insta = { on: false };
const instaButton = document.getElementById('btn-insta');
function toggleInsta() {
  if (mode.name === 'new') return; // (a new game builds with what its workers mine)
  insta.on = !insta.on;
  instaButton.setAttribute('aria-pressed', String(insta.on));
  if (mode.name === 'sandbox') sfx(insta.on ? 'toggleOn' : 'toggleOff');
}
instaButton.addEventListener('click', (e) => { toggleInsta(); e.currentTarget.blur(); });
function order(job) {
  if (insta.on) units.workers.finish(job);
  else units.workers.add(job);
}
// Raise/Lower marks: onto the shared sculpt job for the villagers, or (insta-build) done at once.
function sculptMark(voxels, add, block, tall = false) {
  if (insta.on) {
    const job = new SculptJob(terrain);
    job.markVoxels(voxels, add, block, tall);
    units.workers.finish(job);
    return;
  }
  sculpt.markVoxels(voxels, add, block, tall);
  if (!units.workers.jobs.includes(sculpt)) units.workers.add(sculpt);
}

function cancelJobAtCursor() {
  const hit = pick(camera.matrices().invViewProj);
  if (!hit) return;
  const sp = spawns.placement(hit), on = sp && spawns.at(...sp.cell);
  if (on) { spawns.remove(on); return; } // a spawn point
  const x = Math.floor(hit.point[0]), z = Math.floor(hit.point[2]);
  if (farms.has(x, z)) { // farms: those under the brush
    const x0 = x - Math.floor((brush.radius - 1) / 2), z0 = z - Math.floor((brush.radius - 1) / 2);
    farms.unmark(x0, z0, x0 + brush.radius, z0 + brush.radius);
    return;
  }
  const job = units.workers.jobs.find((j) => j.contains(x, z));
  if (job === sculpt) sculpt.unmark(hit, brush.radius); // just the marks under the brush
  else if (job === mines) { const x0 = x - Math.floor((brush.radius - 1) / 2), z0 = z - Math.floor((brush.radius - 1) / 2); mines.unmark(x0, z0, x0 + brush.radius, z0 + brush.radius); }
  else if (job) units.workers.cancel(job);
}

// Right click: the selected villagers go there, or attack the enemy of theirs clicked (Shift: once they've done what
// they're doing).
// (Workers too: mining is only ever Dig, E.)
function moveOrder(x, y, queued = false) {
  if (buildings.selected) { setRally(buildings.selected, x, y, false, queued); return; }
  const target = targetAt(x, y);
  if (target && attackOrder(target)) return;
  const { origin, dir } = rayAt(x, y);
  const hit = terrain.raycast(origin, dir);
  if (!hit) return;
  if (units.commandable().length) orderSound('move');
  units.order(hit.point, hit.normal, false, queued);
}

// Attack-move (Q, then left click): the selected villagers go there, fighting the enemies they meet on the way; on an
// enemy, they attack it.
// Armed commands: 'attack' (Q), 'dig' (E: Mine) and 'fill' (U), the god panel's, needing no selection, or 'move'
// (the command card's Move), each waiting for its left click; null for none.
const command = { armed: null };
function arm(name) {
  const sel = units.list.filter((u) => u.selected && !u.dying);
  const work = name === 'dig' || name === 'fill' || name === 'farm' || name === 'wall';
  const rally = buildings.selected?.actions.length && (name === 'attack' || name === 'move'); // (a building's rally)
  command.armed = name && (work || rally || sel.length) ? name : null;
  if (command.armed !== dig.press?.cmd) dig.press = null;
  if (wall.drawing?.cmd && wall.drawing.cmd !== command.armed) wall.drawing = null;
  if (command.armed !== 'farm') farmDraw.d = null;
  if (command.armed !== 'wall') wallLine.d = null;
  else if (!wallBlock(palette.block)) setPalette(BLOCK.BRICK); // (walls are wood or stone: not clay)
  if (work && command.armed && brush.tool !== 'select') setTool('select'); // (not building while digging or filling)
  canvas.classList.toggle('amove', command.armed === 'attack' || command.armed === 'patrol');
  canvas.classList.toggle('dig', command.armed === 'dig');
  canvas.classList.toggle('fill', command.armed === 'fill' || command.armed === 'wall');
  canvas.classList.toggle('farm', command.armed === 'farm');
  canvas.classList.toggle('move', command.armed === 'move');
}
// The dock (bottom right; ui.css): what's selected, its actions on Q W E R (a building's Train and Rally, units'
// Orders), the selected workers' jobs, and Craft on Z X C V, the open orders idle workers take on (Build, with Wall in
// its menu on B, Mine, Fill, Farm). Craft is always there and never moves; the rest grows out to its left. Over the dock, the
// mode in use (or the Build menu). Each button's explanation is its tooltip.
const KEYS = ['Q', 'W', 'E', 'R'];
const CRAFT = [
  { id: 'build', name: 'Build', key: 'Z', icon: ICON.build, tip: 'Pick a building or a wall, then click where it goes. Idle workers build it.', on: () => brush.tool === 'build' || command.armed === 'wall', run: () => (command.armed === 'wall' ? arm(null) : setTool('build')) },
  { id: 'dig', name: 'Mine', key: 'X', icon: ICON.mine, tip: 'Click blocks or trees for workers to dig out, or drag to mark an area.', on: () => command.armed === 'dig', run: () => toggleMode('dig') },
  { id: 'fill', name: 'Fill', key: 'C', icon: ICON.fill, tip: 'Click a face or drag a box for workers to fill, with the block picked on the bar at the top.', on: () => command.armed === 'fill', run: () => toggleMode('fill') },
  { id: 'farm', name: 'Farm', key: 'V', icon: ICON.farm, tip: 'Click grass or dirt, or drag a box: workers till it, wheat grows, and they reap it.', on: () => command.armed === 'farm', run: () => toggleMode('farm') },
];
// Mine, Fill, Farm and Wall are modes: their key (or button) turns them on, and again off.
const toggleMode = (name) => arm(command.armed === name ? null : name);
const CLASS_NAMES = { worker: 'Worker', warrior: 'Warrior', archer: 'Archer', spearman: 'Spearman', mage: 'Fire mage', priest: 'Priest', barbarian: 'Barbarian', knight: 'Knight', scout: 'Scout', crystal: 'Power crystal' };
const PLURAL = { worker: 'Workers', warrior: 'Warriors', archer: 'Archers', spearman: 'Spearmen', mage: 'Fire mages', priest: 'Priests', barbarian: 'Barbarians', knight: 'Knights', scout: 'Scouts', crystal: 'Power crystals' };
const UNIT_BLURB = {
  worker: 'Mines, fells, builds and farms. Never fights.', warrior: 'Strong up close.', barbarian: 'Whirls its axe at every enemy round it.',
  archer: 'Shoots any enemy in range.', spearman: 'Throws spears from a distance.', mage: 'Fireballs blow holes in the ground.',
  priest: 'Heals the most hurt of its side with a beam of light.', knight: 'A warrior on a horse.', scout: 'An archer on a fast horse.',
};
// Worker jobs (SPECS in jobs.js): a click sets the selected workers', and one on a job that isn't its kind drops it.
const SPEC_INFO = {
  worker: { name: 'Any', tip: 'Takes any open order.' },
  lumberjack: { name: 'Lumber', tip: 'Fells trees first, and drops other work when a tree is marked.' },
  miner: { name: 'Miner', tip: 'Mines and digs first, and drops other work when digging is marked.' },
  builder: { name: 'Builder', tip: 'Builds and fills first, and drops other work when building comes up.' },
  farmer: { name: 'Farmer', tip: 'Tills and reaps farms first, and drops other work when a farm needs it.' },
};
const selectedWorkers = () => units.list.filter((u) => u.selected && !u.dying && u.team === 'blue' && u.kind === 'worker');
// (It keeps on with what it's doing till an order of its new kind is open: see Workers.preferOpen.)
function setSpec(u, spec) {
  u.spec = spec;
  u.nextPrefer = 0;
}
// A tooltip's text (title | key | what it does | how), kept in data-tip.
const tipAttr = (title, key = '', text = '', sub = '') => `data-tip="${esc([title, key, text, sub].map((s) => String(s).replace(/\|/g, '/')).join('|'))}"`;
const keyChip = (k) => (k ? `<span class="key kc">${k}</span>` : '');
const socket = '<span class="slot-empty" aria-hidden="true"></span>';
// An order button (68 wide): parchment, or Craft's in the player's colour (gp).
function cmdButton({ id, name, key, icon, tip, sub = '', on = false, locked = false, craft = false, attrs = '' }) {
  return `<button type="button" class="${craft ? 'gp' : 'btn'} cmd${on ? ' is-on' : ''}${locked ? ' is-locked' : ''}" data-cmd="${id}" ${attrs} aria-pressed="${on}" ${locked ? 'aria-disabled="true"' : ''} ` +
    `aria-label="${esc(name)}${key ? ` (${key})` : ''}" ${tipAttr(name, key, tip, sub)}>${craft ? svgCur(icon) : svg(icon)}<span>${esc(name)}</span>${keyChip(key)}</button>`;
}
const costIcon = (blk) => (blk === BLOCK.GOLD ? resIcon('gold', 13) : blk === BLOCK.IRON ? resIcon('iron', 13) : blk === WHEAT ? resIcon('wheat', 13)
  : `<i class="s" style="background-image:url('${COST_TEX[blk]}')"></i>`);
const costHtml = (cost) => `<span class="cost">${cost.map(([blk, n]) => `<i class="${inventory && inventory.get(blk) < n ? 'low' : ''}">${costIcon(blk)}${n}</i>`).join('')}</span>`;

const dock = document.getElementById('dock');
const modebar = document.getElementById('modebar');
const live = new LiveView(document.createElement('canvas'));
// What Q W E R do now (null: nothing in that slot), set as the dock's drawn.
let actionSlots = [null, null, null, null];
// The selection: a building, units (the player's, someone else's, or a power crystal), or nothing.
function selection() {
  if (buildings.selected) { site = null; return { building: buildings.selected }; }
  const sel = units.list.filter((u) => u.selected && !u.dying && u.kind !== 'wall');
  if (sel.length || site?.done || (site && !units.workers.jobs.includes(site))) site = null; // (built, or called off)
  if (site) return { site, units: [] };
  return { units: sel };
}
// The control group the selection is, if it's exactly one.
function selectionGroup(sel) {
  if (!sel.length) return null;
  for (const [n, g] of groups.groups) if (g.members.size === sel.length && sel.every((u) => g.members.has(u))) return n;
  return null;
}
function renderDock() {
  const { building: b, site: job, units: sel } = selection();
  const armed = command.armed, tool = brush.tool;
  const craftKey = CRAFT.map((c) => +c.on()).join('');
  let key;
  if (b) {
    key = `b${b.id}|${b.queue.join()}|${armed}|${b.actions.map((k) => `${canAfford(k)}`).join()}|${craftKey}|${mode.name}`;
  } else if (job) {
    key = `s${job.siteId}|${(job.missing ?? []).join()}|${(job.needs ?? []).join()}|${craftKey}|${mode.name}`;
  } else {
    const counts = new Map();
    for (const u of sel) { const k = `${u.team} ${u.kind}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
    const specs = new Set(selectedWorkers().map((u) => u.spec ?? 'worker'));
    key = `u${[...counts].join()}|${armed}|${[...specs].join()}|${selectionGroup(sel)}|${craftKey}|${mode.name}|${sel.length === 1 ? sel[0].id ?? '' : ''}`;
  }
  key += `|${tool}`;
  if (key !== dockKey) {
    dockKey = key;
    actionSlots = [null, null, null, null];
    shortOf.clear();
    let html = '';
    if (b) html += dockBuilding(b);
    else if (job) html += dockSite(job);
    else if (sel.length) html += dockUnits(sel);
    // (Always a grid like Age of Empires': the actions over Craft on the left, Q W E R over Z X C V, so Craft never
    // moves; what's selected (and a worker's Priority under it) grows out to the right. Nothing to order leaves the actions'
    // row as empty sockets, so the dock (and the resources beside it) keep one height. See ui.css.)
    if (!html.includes('sec act')) html += `<div class="sec act idle"><span class="legend">Orders</span>${socket.repeat(4)}</div>`;
    html += `<div class="sec craft"><span class="legend">Craft</span>${CRAFT.map((c) => cmdButton({ ...c, on: c.on(), craft: true })).join('')}</div>`;
    dock.innerHTML = html;
    dock.classList.toggle('with-spec', !!dock.querySelector('.spec'));
    dock.setAttribute('aria-label', b ? `Selected: ${b.name}` : job ? `Selected: ${job.name}, being built` : sel.length ? `Selected: ${sel.length} unit${sel.length > 1 ? 's' : ''}` : 'Craft');
    const view = dock.querySelector('.live');
    if (view) view.prepend(live.canvas);
    showCounts(); // (the ribbon's warnings follow what's short here)
  }
  // Each frame: the live view turning, the queue's progress and the time left, the units' health.
  if (b) {
    live.draw(Math.min(0.05, lastRealDt), (x, y, z) => terrain.solid(x, y, z));
    const left = standingBlocks(b).length, total = b.plan.blocks.length;
    const hpN = dock.querySelector('.hp-n'), hp = dock.querySelector('.info .hp > i');
    if (hpN) hpN.textContent = `${left} / ${total}`;
    if (hp) hp.style.width = `${(100 * left / Math.max(1, total)).toFixed(1)}%`;
    const time = Math.max(0.01, PRODUCTION_TUNING[b.queue[0]] ?? 5);
    const bar = dock.querySelector('.queue .q .bar > i');
    if (bar) bar.style.width = `${Math.round(100 * b.progress / time)}%`;
    const rest = dock.querySelector('.queue .left');
    if (rest) rest.textContent = b.queue.length ? `${Math.ceil(time - b.progress)} s` : '';
  } else if (job) {
    live.draw(Math.min(0.05, lastRealDt)); // (all of it, built or not)
    const total = job.plan.blocks.length, done = total - job.plan.blocks.filter(([x, y, z, blk]) => terrain.block(x, y, z) !== blk).length;
    const n = dock.querySelector('.hp-n'), bar = dock.querySelector('.info .hp > i');
    if (n) n.textContent = `${done} / ${total}`;
    if (bar) bar.style.width = `${(100 * done / Math.max(1, total)).toFixed(1)}%`;
  } else if (sel.length) {
    for (const el of dock.querySelectorAll('.kind[data-kind]')) {
      const [team, kind] = el.dataset.kind.split(' ');
      const of = sel.filter((u) => u.team === team && u.kind === kind);
      const hp = of.reduce((s, u) => s + Math.max(0, u.hp) / (u.maxHp || 1), 0) / Math.max(1, of.length);
      el.querySelector('.hpb > i').style.width = `${(100 * hp).toFixed(0)}%`;
    }
  }
  renderModebar();
}
// A building still being built: its live view (L looks at it), name, how many of its blocks are in, and what it still
// takes; when the inventory can't cover that (its blocks to place show white), what more it needs, and it's outlined
// white (Jordan).
function dockSite(job) {
  live.set(`s${job.siteId}`, job.plan.blocks);
  const need = (job.needs ?? []).filter(([, n]) => n > 0), missing = (job.missing ?? []).filter(([, n]) => n > 0);
  const name = (blk) => CURRENCY_NAMES[blk] ?? { [BLOCK.PLANK]: 'planks', [BLOCK.BRICK]: 'bricks', [BLOCK.CLAY]: 'clay' }[blk] ?? 'blocks';
  const pills = (list, low) => `<span class="cost">${list.map(([blk, n]) => `<i class="${low ? 'low' : ''}">${costIcon(blk)}${n}</i>`).join('')}</span>`;
  const status = !inventory ? '<span class="note">Your workers are building it</span>'
    : missing.length ? `<span class="note">Needs ${missing.map(([blk, n]) => `${n} more ${name(blk)}`).join(' and ')} to finish</span>${pills(missing, true)}`
    : need.length ? `<span class="note">Still takes</span>${pills(need, false)}` : '<span class="note">Your workers are finishing it</span>';
  return `<div class="sec sel site${missing.length ? ' short' : ''}"><div class="live"><button type="button" class="btn" data-cmd="look" aria-label="Look at the ${esc(job.name)} (L)" ${tipAttr('Look at it', 'L', 'The camera goes to it.')}>${svg(ICON.look, 14, 3)}<span class="key">L</span></button></div>` +
    `<div class="info"><div class="hd">${teamBanner('blue')}<h2>${esc(job.name)}</h2><span class="hp-n"></span></div>` +
    `<span class="hp" role="img" aria-label="Blocks placed"><i style="width: 0%"></i></span>${status}</div></div>`;
}
// A building: its live view (L looks at it), name, health (its blocks still standing), and its training queue (click
// one to cancel it, and get back what it cost); then Train (a button a unit it trains, its cost; Rally on R).
function dockBuilding(b) {
  const total = b.plan.blocks.length;
  live.set(`b${b.id}`, b.plan.blocks);
  const note = { hut: inventory ? `Room for ${Math.round(POP_TUNING.house)} more villagers` : 'A house', keep: 'Workers bring what they gather here', lookoutTower: 'A unit on its platform sees twice as far' }[b.key] ?? '';
  const queue = b.actions.length ? `<div class="queue">${Array.from({ length: TRAIN_QUEUE }, (_, i) => {
    const k = b.queue[i];
    if (!k) return '<span class="q empty" aria-hidden="true"></span>';
    return `<button type="button" class="q" data-queued="${i}" ${tipAttr(CLASS_NAMES[k] ?? k, '', i ? 'Queued.' : 'Training.', 'Click to cancel it: what it cost comes back.')} aria-label="${CLASS_NAMES[k] ?? k}${i ? ', queued' : ', training'}. Click to cancel">` +
      `${svg(UNIT_ICON[k] ?? '', 18)}${i ? '' : '<i class="bar"><i></i></i>'}</button>`;
  }).join('')}<span class="left"></span></div>` : `<span class="note">${note}</span>`;
  let html = `<div class="sec sel"><div class="live"><button type="button" class="btn" data-cmd="look" aria-label="Look at the ${esc(b.name)} (L)" ${tipAttr('Look at it', 'L', 'The camera goes to it.')}>${svg(ICON.look, 14, 3)}<span class="key">L</span></button></div>` +
    `<div class="info"><div class="hd">${teamBanner(b.team)}<h2>${esc(b.name)}</h2><span class="hp-n">${total} / ${total}</span></div>` +
    `<span class="hp" role="img" aria-label="Health"><i style="width: 100%"></i></span>${queue}</div></div>`;
  if (!b.actions.length || b.team !== 'blue') return html;
  const full = b.queue.length >= TRAIN_QUEUE;
  const slots = b.actions.slice(0, 3).map((k, i) => {
    const cost = trainingCost(k), afford = canAfford(k), t = +(PRODUCTION_TUNING[k] ?? 5).toFixed(1);
    if (inventory) for (const [blk, n] of cost) if (inventory.get(blk) < n) shortOf.add(blk);
    actionSlots[i] = () => trainUnit(b, k);
    const short = inventory ? cost.filter(([blk, n]) => inventory.get(blk) < n).map(([blk, n]) => `${n - inventory.get(blk)} more ${CURRENCY_NAMES[blk]}`) : [];
    const name = CLASS_NAMES[k] ?? k;
    const sub = full ? 'The queue is full.' : short.length ? `Need ${short.join(' and ')}.` : `Click or press ${KEYS[i]} to queue one. Click a queued one to cancel it.`;
    return `<button type="button" class="btn cmd cmd-w${afford && !full ? '' : ' is-locked'}" data-train="${k}" ${afford && !full ? '' : 'aria-disabled="true"'} ` +
      `aria-label="${name}${inventory ? `: ${cost.map(([blk, n]) => `${n} ${CURRENCY_NAMES[blk]}`).join(', ')}` : ''}${short.length ? `. Need ${short.join(' and ')}` : ''} (${KEYS[i]})" ` +
      `${tipAttr(name, KEYS[i], `Trains in ${t} s. ${UNIT_BLURB[k] ?? ''}`, sub)}>${svg(afford ? UNIT_ICON[k] ?? '' : ICON.lock)}` +
      `<span class="nm"><span>${name}</span>${inventory ? costHtml(cost) : `<span class="cost"><i>${t} s</i></span>`}</span>${keyChip(KEYS[i])}</button>`;
  });
  while (slots.length < 3) slots.push(socket);
  const attackRally = command.armed === 'attack';
  actionSlots[3] = () => arm(command.armed === 'move' ? 'attack' : command.armed === 'attack' ? null : 'move');
  slots.push(`<button type="button" class="btn cmd cmd-w${command.armed === 'move' || attackRally ? ' is-on' : ''}" data-cmd="rally" aria-label="Rally point (R). Or right click" ` +
    `${tipAttr(attackRally ? 'Attack rally' : 'Rally', 'R', 'Where what it trains goes: click this, then the ground, or just right click the ground. Shift adds a waypoint.', 'Press R again for an attack rally. Right click this to clear them.')}>` +
    `${svg(attackRally ? ICON.attack : ICON.rally)}<span class="nm"><span>${attackRally ? 'Attack' : 'Rally'}</span></span>${keyChip('R')}</button>`);
  return html + `<div class="sec act"><span class="legend">Train</span>${slots.join('')}</div>`;
}
// Units: their kind (each a tile, its count and health: a click selects only those, Shift+click drops them), whether
// they're a control group; then Orders (Attack, Patrol, Stop, Dig on Q W E R) and, for workers, their Priority (job).
function dockUnits(sel) {
  const mine = sel.filter((u) => u.kind !== 'crystal' && (!units.controls || u.team === units.controls));
  const team = sel[0].team;
  const kinds = new Map();
  for (const u of sel) { const k = `${u.team} ${u.kind}`; kinds.set(k, (kinds.get(k) ?? 0) + 1); }
  const one = kinds.size === 1 ? [...kinds.keys()][0].split(' ')[1] : null;
  const title = sel.length === 1 ? (u0 => (u0.team !== 'blue' ? `${TEAMS[u0.team].name} ` : '') + (CLASS_NAMES[u0.kind] ?? u0.kind))(sel[0])
    : one ? `${sel.length} ${PLURAL[one] ?? one}` : `${sel.length} units`;
  const group = selectionGroup(sel);
  const meta = group !== null ? `<span class="grp">Group <span class="key">${group}</span></span>` : ''; // (no HP number: the tiles' bars show it)
  const tiles = [...kinds].slice(0, mine.length ? 3 : 4).map(([k, n]) => {
    const [t, kind] = k.split(' '), name = n > 1 ? PLURAL[kind] ?? kind : CLASS_NAMES[kind] ?? kind;
    return `<button type="button" class="btn kind${t !== 'blue' ? ' foe' : ''}" data-kind="${k}" aria-label="${name}, ${n}. Select only these" ${tipAttr(`${n} ${name}`, '', 'Click to select only these.', 'Shift+click to drop them from the selection.')}>` +
      `${svg(UNIT_ICON[kind] ?? '', 22, 2.6)}<span class="key">×${n}</span><span class="hpb"><i></i></span></button>`;
  }).join('');
  const more = kinds.size > 3 && mine.length ? `<span class="note">+${kinds.size - 3}</span>` : '';
  const watch = mine.length ? `<button type="button" class="btn kind" data-cmd="watch" style="width: 42px" aria-label="Watch through its eyes (J)" ${tipAttr('Watch', 'J', 'See through the eyes of the one nearest the middle of the screen as it goes about its business.', 'Esc or J comes back.')}>${svg(ICON.watch, 22, 2.4)}<span class="key">J</span></button>` : '';
  // (One row: the name, then the kinds and Watch beside it, leaving room over the Priority row: Jordan.)
  let html = `<div class="sec sel"><div class="info row"><div class="hd">${teamBanner(team)}<h2>${esc(title)}</h2>${meta}</div>` +
    `<div class="kinds">${tiles}${more}${watch}</div></div></div>`;
  if (!mine.length) return html;
  const fighters = mine.some((u) => u.kind !== 'worker' && u.kind !== 'priest');
  const workers = mine.some((u) => u.kind === 'worker');
  const orders = [
    fighters ? { id: 'attack', name: 'Attack', icon: ICON.attack, tip: 'Then click a place: they fight what they meet on the way. Or click an enemy.', sub: 'Shift queues a waypoint.', run: () => arm('attack') } : null,
    { id: 'patrol', name: 'Patrol', icon: ICON.patrol, tip: 'Walk back and forth between two points, fighting anything on the way.', sub: 'Then click the far point. Shift adds points to the round.', run: () => arm('patrol') },
    { id: 'stop', name: 'Stop', icon: ICON.stop, tip: 'Hold where they are.', run: () => units.stop() },
    workers ? { id: 'dig', name: 'Dig', icon: ICON.mine, tip: 'Then click blocks for workers to dig out, or drag to mark an area.', sub: 'The same as Craft\'s Mine.', run: () => toggleMode('dig') } : null,
  ];
  const slots = orders.map((o, i) => {
    if (!o) return socket;
    actionSlots[i] = o.run;
    return cmdButton({ ...o, key: KEYS[i], on: command.armed === o.id });
  });
  html += `<div class="sec act"><span class="legend">Orders</span>${slots.join('')}</div>`;
  const ws = selectedWorkers();
  if (ws.length) {
    const specs = new Set(ws.map((u) => u.spec ?? 'worker'));
    html += `<div class="sec spec"><span class="legend">Priority</span>${SPECS.map((k) => {
      const s = SPEC_INFO[k];
      return cmdButton({ id: `spec-${k}`, name: s.name, icon: ICON[k], tip: s.tip, on: specs.size === 1 && specs.has(k), attrs: `data-spec="${k}"` });
    }).join('')}</div>`;
  }
  return html;
}
dock.addEventListener('click', (e) => {
  const train = e.target.closest('button[data-train]'), queued = e.target.closest('[data-queued]');
  if (train) { trainUnit(buildings.selected, train.dataset.train); train.blur(); return; }
  if (queued) { cancelTraining(buildings.selected, +queued.dataset.queued); return; }
  const spec = e.target.closest('button[data-spec]');
  if (spec) { for (const u of selectedWorkers()) setSpec(u, spec.dataset.spec); spec.blur(); return; }
  const kind = e.target.closest('button[data-kind]');
  if (kind) {
    const [team, k] = kind.dataset.kind.split(' ');
    for (const u of units.list) if (u.selected && (u.team === team && u.kind === k) === e.shiftKey) u.selected = false;
    sfx('select');
    kind.blur();
    return;
  }
  const b = e.target.closest('button[data-cmd]');
  if (!b) return;
  const id = b.dataset.cmd;
  const craft = CRAFT.find((c) => c.id === id);
  if (craft) craft.run();
  else if (id === 'look') lookAtSelection();
  else if (id === 'watch') startPossess();
  else if (id === 'rally') actionSlots[3]?.();
  else {
    const i = [...b.parentElement.querySelectorAll('[data-cmd], .slot-empty')].indexOf(b);
    actionSlots[i]?.();
  }
  b.blur();
});
// (Right click on Rally clears the rally waypoints.)
dock.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (e.target.closest('[data-cmd="rally"]') && buildings.selected) { buildings.selected.rally = []; sfx('toggleOff'); }
});

// Over the dock: the mode in use, in the player's colour (an order waiting for its click in ink), with what to do and
// how to stop; with Build on, the Build menu.
const MODES = {
  dig: { name: 'Mine', key: 'X', icon: ICON.mine, text: 'Click blocks or trees to dig them out. Drag to mark an area. Shift+click an ore for its vein, a tree for its forest.' },
  fill: { name: 'Fill', key: 'C', icon: ICON.fill, text: () => `Click a face, or drag a box, to fill with ${PALETTE.find((p) => p.block === palette.block)?.name.toLowerCase() ?? 'clay'} (pick on the bar at the top).` },
  farm: { name: 'Farm', key: 'V', icon: ICON.farm, text: 'Click grass or dirt, or drag a box over it: workers till it, wheat grows, and they reap it.' },
  wall: { name: 'Wall', key: 'B', icon: ICON.wall, text: () => `Drag a straight line over the ground and let go: a wall of ${palette.block === BLOCK.PLANK ? 'planks' : 'bricks'} (pick on the bar at the top).` },
  attack: { name: 'Attack', icon: ICON.attack, order: true, text: () => (buildings.selected ? 'Click the ground: what it trains attack-moves there. Shift adds a waypoint.' : 'Click a place to attack-move there, or an enemy to attack it. Shift queues.') },
  patrol: { name: 'Patrol', icon: ICON.patrol, order: true, text: 'Click the far point of the round. Shift adds points.' },
  move: { name: 'Rally', icon: ICON.rally, order: true, text: () => (buildings.selected ? 'Click the ground: what it trains goes there. Shift adds a waypoint.' : 'Click where they go.') },
  raise: { name: 'Raise', key: 'F3', icon: ICON.raise, tool: true, text: 'Click to mark a cube to fill. Drag a rectangle, release, move up for its height, click.' },
  lower: { name: 'Lower', key: 'F4', icon: ICON.lower, tool: true, text: 'Click to mark a cube to dig. Drag a rectangle, release, move down for its depth, click.' },
  flatten: { name: 'Flatten', key: 'F5', icon: ICON.flatten, tool: true, text: 'Drag a box for idle villagers to level. The wheel sets its height.' },
  build: { name: 'Build', key: 'Z', icon: ICON.build, tool: true, text: 'Click to place it. Drag first to turn its door that way.' },
};
let workHint = '';
function renderModebar() {
  const m = MODES[command.armed] ?? (brush.tool !== 'select' ? MODES[brush.tool] : null);
  const key = `${command.armed}|${brush.tool}|${build.item}|${!!pendingDesign}|${workHint}|${palette.block}|${designs.length}|${mode.name}|${buildings.selected ? 1 : 0}`;
  const menuOpen = brush.tool === 'build' || command.armed === 'wall';
  if (key === modeKey) {
    if (menuOpen && inventory) refreshBuildCosts();
    for (const v of menuViews.values()) if (v.canvas.isConnected) v.draw(Math.min(0.05, lastRealDt));
    return;
  }
  modeKey = key;
  modebar.hidden = !m && !pendingDesign;
  if (modebar.hidden) { modebar.innerHTML = ''; return; }
  const text = m ? (typeof m.text === 'function' ? m.text() : m.text) : '';
  const stop = m?.order ? 'Right click or <span class="key">Esc</span> cancels' : `Right click${m?.key ? ` or <span class="key">${m.key}</span>` : ''} to stop`;
  let html = '';
  if (menuOpen) html += buildMenuHtml();
  if (m) html += `<div class="strip${m.order ? ' order' : ''}" role="status">${m.order ? svg(m.icon, 22, 3).replace('#2b1d12', '#fff3d6') : svgCur(m.icon, 22, 3)}<span class="h-disp">${m.name}</span><span>${esc(workHint || text)}</span><span class="stop">${stop}</span></div>`;
  modebar.innerHTML = html;
  for (const el of modebar.querySelectorAll('[data-pv]')) { const v = menuViews.get(el.dataset.pv); if (v) el.prepend(v.canvas); }
  costsShown = '';
}
// The Build menu's previews: each building turning on its grass plate (a wall: a few columns of it), drawn while the
// menu's open. Other items show an icon.
const menuViews = new Map();
const MENU_ICON = {
  torch: 'M10 22h4l1-11H9zM12 2c2 2.5 3 4 3 5.5a3 3 0 0 1-6 0C9 6 10 4.5 12 2z',
  portcullis: 'M4 3h16v18M4 3v18M8 3v18M12 3v18M16 3v18M4 9h16M4 15h16',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 14h8v6H8z',
  spawn: 'M4 17h16M12 15V5M8 9l4-4 4 4',
  banner1: 'M7 3v18M7 4h10v9l-5-3-5 3', banner2: 'M7 3v18M7 4h10v9l-5-3-5 3', banner3: 'M7 3v18M7 4h10v9l-5-3-5 3',
};
function menuPreview(key) {
  let blocks = null;
  if (key === 'wall') {
    const b = wallBlock(palette.block) ?? BLOCK.BRICK;
    blocks = [];
    for (let x = 0; x < 5; x++) for (let y = 0; y < Math.round(WALL_TUNING.height); y++) blocks.push([x, y, 0, b]);
  } else if (BUILDINGS[key]) {
    blocks = BUILDINGS[key].plan(0, 1, 0, 0).blocks;
  }
  if (!blocks?.length) return '';
  let v = menuViews.get(key);
  if (!v) menuViews.set(key, v = new LiveView(document.createElement('canvas')));
  v.set(`${key}|${BUILDINGS[key]?.name ?? ''}|${blocks.length}|${blocks[0][3]}`, blocks);
  return `<span class="pv" data-pv="${esc(key)}"></span>`;
}
function buildMenuHtml() {
  const items = BUILD_ITEMS.filter((it) => !it.editor || mode.name === 'editor');
  const designItems = designs.map((d, i) => ({ key: `design:${i}`, name: d.name, tip: `${d.w} × ${d.d} × ${d.h}: needs that much empty flat ground.`, design: true }));
  const at = items.findIndex((it) => it.key === 'save');
  items.splice(at, 0, ...designItems);
  const on = (it) => (it.key === 'wall' ? command.armed === 'wall' : brush.tool === 'build' && build.item === it.key);
  const html = items.map((it) => `<button type="button" class="btn bb${on(it) ? ' is-on' : ''}" data-build="${esc(it.key)}" aria-pressed="${on(it)}" ${tipAttr(it.name, it.hotkey ?? '', it.tip, it.design ? 'The × deletes it.' : '')}>` +
    (menuPreview(it.key) || `<span class="pv icon">${svg(MENU_ICON[it.key] ?? ICON.build, 30, 2.6)}</span>`) +
    `<span class="nm">${esc(it.name)}${it.hotkey ? keyChip(it.hotkey) : ''}</span><span class="cost" data-cost="${esc(it.key)}">${buildCostHtml(it.key)}</span>${it.design ? '<span class="del" data-del aria-label="Delete this design">×</span>' : ''}</button>`).join('');
  const ask = pendingDesign ? '<div id="design-name" style="flex-basis: 100%; justify-content: flex-end"><span style="font: 900 14px var(--body)">Its name</span><input type="text" maxlength="40" aria-label="Design name"><button type="button" class="btn" style="height: 34px; padding: 0 12px; border-width: 3px; font: 900 14px var(--body)">Save</button></div>' : '';
  return `<div id="build-menu" class="panel"><span class="legend">Build</span>${html}${ask}</div>`;
}
// (The costs as the inventory changes, without redrawing the menu.)
let costsShown = '';
function refreshBuildCosts() {
  const k = `${inventory.version ?? ''}|${[...inventory.free].join()}|${RESOURCES.map((c) => inventory.get(c)).join()}`;
  if (k === costsShown) return;
  costsShown = k;
  for (const el of modebar.querySelectorAll('[data-cost]')) {
    const html = buildCostHtml(el.dataset.cost);
    if (el.innerHTML !== html) el.innerHTML = html;
  }
}
modebar.addEventListener('click', (e) => {
  if (e.target.closest('[data-del]')) { deleteDesign(e.target.closest('[data-build]').dataset.build); return; }
  if (e.target.closest('#design-name button')) { finishDesign(); return; }
  const b = e.target.closest('button[data-build]');
  if (!b) return;
  if (b.dataset.build === 'wall') toggleMode('wall');
  else {
    if (brush.tool !== 'build') setTool('build'); // (from Wall)
    pickBuild(b.dataset.build);
  }
  b.blur();
});
modebar.addEventListener('keydown', (e) => {
  if (!e.target.closest('#design-name input')) return;
  e.stopPropagation();
  if (e.key === 'Enter') finishDesign();
  if (e.key === 'Escape') { hideDesignName(); renderModebar(); }
});

// The Information panel (under the minimap, Jordan): what's under the pointer. Over the HUD, a tooltip (data-tip:
// title | key | what it does | how), shown on hover and on keyboard focus; over the world, what's there (a unit, a
// building, a tree, ore...: see worldInfo). Hidden when there's nothing; the alerts sit under it.
const infoEl = document.getElementById('info');
let tipFor = null, infoKey = '', infoHide = 0;
function showInfo(info) { // { title, key, team, text, sub } or null
  const key = info ? JSON.stringify(info) : '';
  if (key === infoKey) return;
  clearTimeout(infoHide);
  if (!info) { infoHide = setTimeout(() => { infoKey = ''; infoEl.hidden = true; }, 180); return; } // (no flicker between things)
  infoKey = key;
  infoEl.innerHTML = `<b class="t">${info.team ? teamChip(info.team, 13) : ''}<span>${esc(info.title)}</span>${info.key ? `<span class="key">${esc(info.key)}</span>` : ''}</b>` +
    `${info.text ? `<span class="tx">${esc(info.text)}</span>` : ''}${info.sub ? `<span class="sub">${esc(info.sub)}</span>` : ''}`;
  infoEl.hidden = false;
}
function tipInfo(el) {
  const [title, key, text, sub] = el.dataset.tip.split('|');
  return { title, key, text, sub };
}
function tipAt(el) {
  if (el === tipFor) return;
  tipFor = el;
  if (el && !document.body.classList.contains('in-menu')) showInfo(tipInfo(el)); else { showInfo(null); worldInfoAt = 0; }
}
document.addEventListener('pointerover', (e) => tipAt(e.target.closest?.('[data-tip]') ?? null));
document.addEventListener('focusin', (e) => { if (e.target.matches?.(':focus-visible')) tipAt(e.target.closest?.('[data-tip]') ?? null); });
document.addEventListener('focusout', () => tipAt(null));

// Over the world (each INFO_EVERY s while no tooltip's up): what the pointer's on, if it's worth a word. Not the plain
// ground, water or what's never been seen.
const INFO_EVERY = 0.12;
let worldInfoAt = 0;
const BLOCK_INFO = {
  [BLOCK.STONE]: () => ({ title: 'Stone', text: `Mine it (X) for ${Math.round(INVENTORY_TUNING.stoneBricks)} bricks a block.` }),
  [BLOCK.IRON]: () => ({ title: 'Iron ore', text: 'Mine it (X): a worker carries the iron to your Keep.', sub: 'Iron pays for portcullises and some units.' }),
  [BLOCK.GOLD]: () => ({ title: 'Gold ore', text: 'Mine it (X): a worker carries the gold to your Keep.', sub: 'Gold pays for the Stables and mounted units.' }),
  [BLOCK.CLAY]: () => ({ title: 'Clay bricks', text: 'Built with clay.' }),
  [BLOCK.BRICK]: () => ({ title: 'Bricks', text: 'Built with bricks.' }),
  [BLOCK.PLANK]: () => ({ title: 'Planks', text: 'Built with planks.' }),
};
const OWNER_TEAM = Object.fromEntries(Object.entries(OWNER).map(([t, n]) => [n, t]));
function worldInfo(x, y) {
  const u = unitAt(x, y);
  if (u && !u.hidden) {
    if (u.kind === 'crystal') return { title: `${cap(u.team)} power crystal`, team: u.team, text: u.team === 'blue' ? 'Yours. Lose it and your kingdom falls.' : 'Destroy it and that kingdom falls.', sub: `${Math.max(0, Math.ceil(u.hp))} / ${Math.round(u.maxHp)} hit points` };
    let sub = `${Math.max(0, Math.ceil(u.hp))} / ${Math.round(u.maxHp)} hit points`;
    if (u.kind === 'worker' && u.team === 'blue') {
      const job = SPEC_INFO[u.spec ?? 'worker']?.name ?? 'Any';
      const doing = u.carry?.n ? `carrying ${u.carry.n} ${CURRENCY_NAMES[u.carry.block] ?? { [BLOCK.PLANK]: 'planks', [BLOCK.BRICK]: 'bricks', [BLOCK.CLAY]: 'clay' }[u.carry.block] ?? 'blocks'}` : u.task ? 'working' : 'idle';
      sub += `. Priority: ${job}, ${doing}.`;
    }
    return { title: `${CLASS_NAMES[u.kind] ?? cap(u.kind)}`, team: u.team, text: UNIT_BLURB[u.kind] ?? '', sub };
  }
  const b = buildingAt(x, y);
  if (b) {
    const total = b.plan.blocks.length;
    const note = { keep: 'Workers bring what they gather here.', hut: `Room for ${Math.round(POP_TUNING.house)} more villagers.`, lookoutTower: 'A unit on its platform sees twice as far.' }[b.key] ?? '';
    return { title: b.name, team: b.team, text: `${note}${b.team === 'blue' ? `${note ? ' ' : ''}Click to select it.` : ''}`, sub: `${standingBlocks(b).length} / ${total} blocks standing` };
  }
  const job = siteAt(x, y);
  if (job) {
    const missing = (job.missing ?? []).filter(([, n]) => n > 0);
    const name = (blk) => CURRENCY_NAMES[blk] ?? { [BLOCK.PLANK]: 'planks', [BLOCK.BRICK]: 'bricks', [BLOCK.CLAY]: 'clay' }[blk] ?? 'blocks';
    return { title: `${job.name} (being built)`, team: 'blue', text: 'Click to select it.', sub: missing.length ? `Needs ${missing.map(([blk, n]) => `${n} more ${name(blk)}`).join(' and ')} to finish.` : 'Your workers are building it.' };
  }
  const { origin, dir } = rayAt(x, y);
  const hit = terrain.raycast(origin, dir);
  if (!hit) return null;
  const [cx, cy, cz] = hit.point.map((v, i) => Math.floor(v - hit.normal[i] * 0.01));
  if (fog.on && fog.never(cx, cz)) return null;
  const w = walls.at(cx, cy, cz);
  if (w?.unit && !w.unit.dying) return { title: 'Wall', team: w.team, text: w.team === 'blue' ? 'Yours. Enemies have to break through it.' : 'Attack it to break through.', sub: `${Math.max(0, Math.ceil(w.unit.hp))} / ${Math.round(w.unit.maxHp)} hit points` };
  for (const [team, plan] of keeps) {
    if (plan.blocks.some(([bx, by, bz]) => bx === cx && by === cy && bz === cz)) return { title: `${cap(team)} Keep`, team, text: team === 'blue' ? 'Your workers bring what they gather here.' : 'Its power crystal is inside.' };
  }
  const pile = units.workers.piles.find((p) => p.x === cx && p.z === cz && (p.y === cy || p.y === cy + 1));
  if (pile) return { title: `${pile.n} ${CURRENCY_NAMES[pile.block] ?? { [BLOCK.PLANK]: 'planks', [BLOCK.BRICK]: 'bricks', [BLOCK.CLAY]: 'clay' }[pile.block] ?? 'blocks'}`, text: 'Left on the ground: a worker will carry it to your Keep.' };
  const blk = terrain.block(cx, cy, cz);
  const marked = isMarked([cx, cy, cz]) ? 'Marked to mine.' : '';
  if (blk === BLOCK.LOG || blk === BLOCK.LEAVES) {
    const trunk = findTrunk(terrain, cx, cy, cz);
    const logs = trunk ? trunkLogs(terrain, ...trunk).length : 0;
    if (!logs) return null; // (leaves with no tree: nothing worth saying)
    return { title: 'Tree', text: `Mine it (X): a worker fells it for ${logs * Math.round(INVENTORY_TUNING.logPlanks)} planks.`, sub: marked };
  }
  if (blk === BLOCK.FARM || farms.has(cx, cz)) {
    const f = farms.list.get(cx + SIZE[0] * cz);
    if (!f) return null;
    const grown = Math.min(1, (farms.clock - f.sown) / Math.max(1, FARM_TUNING.growTime));
    return { title: 'Farm', team: 'blue', text: !f.tilled ? 'Marked: a worker will till it and sow wheat.' : farms.ripe(f) ? 'Ripe: a worker will reap the wheat.' : `Wheat growing, ${Math.round(100 * grown)}%.` };
  }
  const info = BLOCK_INFO[blk]?.();
  if (!info) return null;
  const owner = OWNER_TEAM[terrain.owners[cx + SIZE[0] * cz]];
  if (owner && (blk === BLOCK.CLAY || blk === BLOCK.BRICK || blk === BLOCK.PLANK)) { info.team = owner; info.text += ` ${cap(owner)}'s.`; }
  if (marked) info.sub = info.sub ? `${marked} ${info.sub}` : marked;
  return info;
}
function updateWorldInfo(dt) {
  if (tipFor && !tipFor.isConnected) tipAt(null); // (the HUD under the pointer was redrawn)
  if (tipFor) { showInfo(tipInfo(tipFor)); return; } // (a tooltip's up: kept to what it says now)
  worldInfoAt -= dt;
  if (worldInfoAt > 0) return;
  worldInfoAt = INFO_EVERY;
  showInfo(mouse.inside && mouse.button < 0 && !possess.unit && mode.name ? worldInfo(mouse.x, mouse.y) : null);
}

// The camera to the selection: the building, or the selected units' middle.
function lookAtSelection() {
  const b = buildings.selected ?? site;
  let x, z;
  if (b) {
    const box = planBox(b.plan);
    x = (box.lo[0] + box.hi[0]) / 2;
    z = (box.lo[2] + box.hi[2]) / 2;
  } else {
    const sel = units.list.filter((u) => u.selected && !u.dying);
    if (!sel.length) return;
    x = sel.reduce((s, u) => s + u.pos[0], 0) / sel.length;
    z = sel.reduce((s, u) => s + u.pos[2], 0) / sel.length;
  }
  camera.target[0] = x;
  camera.target[2] = z;
}
// The power crystals (top left, a new game): calm, the player's in a ring of its health and each rival's beside it;
// while it's losing hit points (any within HUD_TUNING.attackWindow seconds), the alarm, in ink: how much it lost in
// that time, which way the attackers are (their middle, those of other teams within attackRadius of it), how many and
// whose, and a way there (Space); under it every rival's crystal, those destroyed Out.
const crystalEl = document.getElementById('crystal');
const crystalHistory = []; // [game s, hp] of the player's crystal, over the last attackWindow seconds
let crystalKey = '';
const crystalOf = (team) => units.list.find((u) => u.kind === 'crystal' && u.team === team);
const GEM = (stroke, size) => `<svg width="${size}" height="${Math.round(size * 52 / 44)}" viewBox="0 0 44 52" aria-hidden="true"><path d="M22 3L39 18 22 49 5 18z" fill="#3557c9" stroke="${stroke}" stroke-width="5" stroke-linejoin="round"/><path d="M22 3L14 18h16zM5 18h34" fill="#7f9ae6" stroke="${stroke}" stroke-width="4" stroke-linejoin="round"/></svg>`;
// The attack on the player's crystal now: { loss, hp, max, dir, n, team } or null.
function crystalAttack(c) {
  if (!c || c.dying) return null;
  const W = Math.max(0.5, HUD_TUNING.attackWindow);
  crystalHistory.push([gameClock, c.hp]);
  while (crystalHistory.length && crystalHistory[0][0] < gameClock - W) crystalHistory.shift();
  const loss = Math.max(0, crystalHistory[0][1] - c.hp);
  if (loss <= 0) return null;
  const R = HUD_TUNING.attackRadius, near = units.list.filter((u) => u.team !== c.team && !u.dying && u.kind !== 'crystal' && u.kind !== 'wall' &&
    Math.hypot(u.pos[0] - c.pos[0], u.pos[2] - c.pos[2]) < R);
  const count = new Map();
  for (const u of near) count.set(u.team, (count.get(u.team) ?? 0) + 1);
  const team = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const mx = near.reduce((s, u) => s + u.pos[0], 0) / Math.max(1, near.length), mz = near.reduce((s, u) => s + u.pos[2], 0) / Math.max(1, near.length);
  return { loss, dir: near.length ? compass(c.pos[0], c.pos[2], mx, mz) : null, n: near.length, team };
}
function renderCrystal() {
  if (crystalEl.hidden) return;
  const c = crystalOf('blue'), max = c?.maxHp || CRYSTAL_TUNING.hp, hp = c && !c.dying ? Math.max(0, c.hp) : 0;
  const attack = crystalAttack(c);
  const rivals = OPPONENTS.slice(0, setup.opponents).map((t) => {
    const r = crystalOf(t);
    return { t, hp: r && !r.dying && !eliminated.has(t) ? Math.max(0, Math.ceil(r.hp)) : 0, max: r?.maxHp || CRYSTAL_TUNING.hp };
  });
  const key = `${Math.ceil(hp)}|${attack ? `${Math.round(attack.loss)}|${attack.dir}|${attack.n}|${attack.team}` : ''}|${rivals.map((r) => r.hp).join()}`;
  if (key === crystalKey) return;
  crystalKey = key;
  const f = hp / max;
  if (!attack) {
    crystalEl.className = 'panel calm';
    const arc = 2 * Math.PI * 22;
    crystalEl.innerHTML = `<span class="gem" role="img" aria-label="Your crystal, ${Math.ceil(hp)} of ${Math.round(max)}${hp > 0 ? ', safe' : ', destroyed'}">` +
      `<svg width="54" height="54" viewBox="0 0 54 54" aria-hidden="true"><circle cx="27" cy="27" r="22" fill="#e9d3a6" stroke="#2b1d12" stroke-width="11"/>` +
      `<circle cx="27" cy="27" r="22" fill="none" stroke="#3f8a3a" stroke-width="5" stroke-dasharray="${(arc * f).toFixed(1)} ${arc.toFixed(1)}" transform="rotate(-90 27 27)"/></svg>` +
      `<span style="position: absolute; left: 15px; top: 13px">${GEM('#2b1d12', 24)}</span></span>` +
      `<div class="calm-text"><span class="h-disp" style="font-size: 16px; line-height: 1">${hp > 0 ? 'Crystal safe' : 'Crystal destroyed'}</span>` +
      `<span class="rivals-row">${rivals.map((r) => `<span class="${r.hp ? '' : 'out'}" aria-label="${TEAMS[r.t].name} crystal ${r.hp ? `${r.hp} of ${Math.round(r.max)}` : 'destroyed'}">${teamChip(r.t)}${TEAMS[r.t].name} ${r.hp || 'out'}</span>`).join('')}</span></div>`;
    return;
  }
  crystalEl.className = 'panel alarm';
  const name = attack.team ? TEAMS[attack.team].name : '';
  crystalEl.innerHTML = `<div class="alarm-top" role="alert"><div class="alarm-row"><span style="position: relative; flex: none; width: 48px; height: 52px"><span class="ping"></span><span style="position: relative">${GEM('#fff3d6', 44)}</span></span>` +
    `<div style="flex: 1; display: flex; flex-direction: column; gap: 6px"><span class="h-disp" style="font-size: 19px; line-height: 1; white-space: nowrap">Under attack</span>` +
    `<span class="hpbar"><i style="width: ${(100 * f).toFixed(1)}%"></i><b style="width: ${(100 * Math.min(1 - f, attack.loss / max)).toFixed(1)}%"></b></span>` +
    `<div style="display: flex; align-items: center; justify-content: space-between; font: 900 13px/1 var(--body)"><span>${Math.ceil(hp)} / ${Math.round(max)}</span><span class="loss">−${Math.round(attack.loss)} in ${Math.round(HUD_TUNING.attackWindow)} s</span></div></div></div>` +
    (attack.dir ? `<div style="display: flex; align-items: center; gap: 8px; font: 900 14px/1 var(--body)">${svg(ICON.dir, 18, 3.5).replace('#2b1d12', '#fff3d6')}<span>From the ${attack.dir}</span></div>` : '') +
    `<div style="display: flex; align-items: center; gap: 8px">${attack.team ? `${teamChip(attack.team, 16, 'width: 24px; height: 24px; border-color: var(--cream)')}<span style="flex: 1; font: 800 13px/1 var(--body); white-space: nowrap">${attack.n} ${name} unit${attack.n > 1 ? 's' : ''}</span>` : '<span style="flex: 1"></span>'}` +
    `<button type="button" class="btn goto" data-goto aria-label="Go to your crystal (Space)">Go to it<span class="key">Space</span></button></div></div>` +
    `<div class="rivals">${rivals.map((r) => `<div class="rival${r.hp ? '' : ' out'}">${teamChip(r.t, 16, 'width: 22px; height: 22px')}<span class="nm">${TEAMS[r.t].name}</span>` +
      `<span class="bar"><i style="width: ${(100 * r.hp / r.max).toFixed(0)}%"></i></span><span class="v">${r.hp || 'Out'}</span></div>`).join('')}</div>`;
}
crystalEl.addEventListener('click', (e) => { if (e.target.closest('[data-goto]')) { goToAlert(); e.target.closest('button').blur(); } });

// Events (under the minimap): an enemy hitting what's the player's (their crystal, walls, units) pinned on top in ink
// while it lasts (HUD_TUNING.threatLast seconds after the latest blow), then the latest of what happened, and the rest
// (up to eventsShown) on asking. A click on one (or Space, the newest threat) takes the camera there.
const events = new EventLog();
const eventsEl = document.getElementById('events');
let eventsOpen = false, eventsKey = '';
// The middle of the player's kingdom: its crystal, or the map's middle.
function home() {
  const c = crystalOf('blue');
  return c ? [c.pos[0], c.pos[2]] : [SIZE[0] / 2, SIZE[2] / 2];
}
units.onHurt = (t, by) => {
  if (!mode.name || mode.name === 'editor' || t.team !== 'blue' || !by || !TEAMS[by.team] || by.team === t.team || t.dying) return;
  const name = TEAMS[by.team].name, time = clockText(gameClock - startClock), [hx, hz] = home();
  const last = HUD_TUNING.threatLast;
  if (t.kind === 'crystal') {
    const dir = compass(t.pos[0], t.pos[2], by.pos[0], by.pos[2]);
    events.threat(by.team, 'crystal', [t.pos[0], t.pos[2]], `${name} is attacking your crystal`, `${cap(dir)} · ${time}`, gameClock, last);
  } else if (t.kind === 'wall') {
    const dir = compass(hx, hz, t.pos[0], t.pos[2]);
    events.threat(by.team, 'wall', [t.pos[0], t.pos[2]], `${name} is attacking your ${dir} wall`, `${cap(dir)} · ${time}`, gameClock, last);
  } else {
    const dir = compass(hx, hz, t.pos[0], t.pos[2]);
    events.threat(by.team, 'units', [t.pos[0], t.pos[2]], `${name} is attacking your units`, `${cap(dir)} · ${time}`, gameClock, last);
  }
};
// What happened: text, an icon (or a team's emblem), and where (for the camera).
const logEvent = (text, icon, at = null, team = null) => events.add({ text, icon, at, team }, gameClock);
const eventTime = (e) => clockText(e.t - startClock);
function eventRow(e, newest = false) {
  const tag = e.at ? 'button type="button"' : 'div';
  const end = e.at ? 'button' : 'div';
  if (e.threat) {
    return `<${tag} class="ev threat" role="alert" data-ev="${e.id}">${teamChip(e.team, 16)}<span class="txt"><span>${esc(e.text)}</span><small>${esc(e.sub)}</small></span>${newest ? '<span class="key">Space</span>' : ''}</${end}>`;
  }
  if (e.warn) {
    return `<${tag} class="ev warn" role="status" data-ev="${e.id}">${WARN}<span class="txt"><span>${esc(e.text)}</span><small>${esc(e.sub)}</small></span></${end}>`;
  }
  return `<${tag} class="ev" data-ev="${e.id}">${e.team ? teamChip(e.team, 14) : svg(e.icon ?? ICON.chevron, 18, 3)}<span class="txt">${esc(e.text)}</span><span class="t">${eventTime(e)}</span></${end}>`;
}
function renderEvents() {
  const { threats, warns, rest } = events.split(gameClock);
  const key = `${events.version}|${threats.map((e) => e.id).join()}|${warns.map((e) => e.id).join()}|${rest.length}|${eventsOpen}`;
  if (key === eventsKey) return;
  eventsKey = key;
  const older = rest.slice(1, 1 + Math.max(0, Math.round(HUD_TUNING.eventsShown)));
  let html = threats.map((e, i) => eventRow(e, i === 0)).join('') + warns.map((e) => eventRow(e)).join('') + (rest[0] ? eventRow(rest[0]) : '');
  if (older.length) {
    html += `<button type="button" class="btn more" data-more aria-expanded="${eventsOpen}" aria-label="${eventsOpen ? 'Hide' : 'Show'} ${older.length} older event${older.length > 1 ? 's' : ''}">${svg(ICON.chevron, 14, 4)}${eventsOpen ? 'Fewer' : `${older.length} more`}</button>`;
    if (eventsOpen) html += `<div class="list">${older.map((e) => eventRow(e)).join('')}</div>`;
  }
  eventsEl.innerHTML = html;
}
eventsEl.addEventListener('click', (e) => {
  if (e.target.closest('[data-more]')) { eventsOpen = !eventsOpen; e.target.closest('button').blur(); return; }
  const row = e.target.closest('[data-ev]');
  const ev = row && events.list.find((x) => x.id === +row.dataset.ev);
  if (ev?.at) { lookAt(ev.at[0], ev.at[1]); row.blur(); }
});
function lookAt(x, z) {
  if (possess.unit) return;
  camera.target[0] = clamp(x, 0, SIZE[0]);
  camera.target[2] = clamp(z, 0, SIZE[2]);
}
// Space: the camera to the crystal under attack, or else the newest threat.
function goToAlert() {
  const c = crystalOf('blue');
  if (crystalEl.classList.contains('alarm') && c) { lookAt(c.pos[0], c.pos[2]); return; }
  const t = events.split(gameClock).threats[0];
  if (t?.at) lookAt(t.at[0], t.at[1]);
}

// Idle workers (by the minimap, a new game): how many of the player's workers have nothing to do; the button (or '.')
// selects the next one and takes the camera to it.
const idleButton = document.getElementById('btn-idle');
let idleShown = -1, idleNext = 0;
const idleWorkers = () => units.list.filter((u) => units.workers.idle(u) && !u.hidden);
function renderIdle() {
  if (mode.name !== 'new') return;
  const n = idleWorkers().length;
  if (n === idleShown) return;
  idleShown = n;
  idleButton.classList.toggle('none', !n);
  idleButton.querySelector('.txt').textContent = `${n} idle`;
  idleButton.querySelector('.key').innerHTML = n ? '.' : '<span class="dot"></span>';
  idleButton.setAttribute('aria-label', `${n} idle worker${n === 1 ? '' : 's'}${n ? '. Select the next (.)' : ''}`);
  idleButton.dataset.tip = n ? `${n} idle worker${n === 1 ? '' : 's'}|.|Selects the next one and goes to it.|Give it an order, or Craft some work near it.` : 'No idle workers||Every worker has something to do.';
}
function nextIdle() {
  const list = idleWorkers().sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  if (!list.length) { sfx('error'); return; }
  const u = list[idleNext++ % list.length];
  buildings.selected = null;
  for (const o of units.list) o.selected = o === u;
  sfx('select');
  lookAt(u.pos[0], u.pos[2]);
}
idleButton.addEventListener('click', () => { nextIdle(); idleButton.blur(); });

// The minimap's collapse (M, or its button), kept for next time.
const MM_KEY = 'mine-wars-minimap-collapsed';
const minimapEl = document.getElementById('minimap');
function setMinimapCollapsed(on) {
  minimapEl.classList.toggle('collapsed', on);
  const b = minimapEl.querySelector('.mm-collapse');
  b.setAttribute('aria-label', `${on ? 'Open' : 'Collapse'} the minimap (M)`);
  b.dataset.tip = on ? 'Open the minimap|M|' : 'Collapse the minimap|M|Click again, or press M, to open it.';
  try { localStorage.setItem(MM_KEY, on ? '1' : ''); } catch { /* (not kept) */ }
}
try { setMinimapCollapsed(localStorage.getItem(MM_KEY) === '1'); } catch { setMinimapCollapsed(false); }
minimapEl.querySelector('.mm-collapse').addEventListener('click', (e) => { setMinimapCollapsed(!minimapEl.classList.contains('collapsed')); e.currentTarget.blur(); });

// Sandbox's units at the cursor: pick a kind, then N puts one there (Shift: a red one).
const SPAWN_KINDS = ['worker', 'warrior', 'archer', 'spearman', 'mage', 'priest', 'barbarian', 'knight', 'scout'];
let spawnKind = 'worker';
const spawnPicker = document.getElementById('spawn');
function buildSpawnPicker() {
  spawnPicker.innerHTML = SPAWN_KINDS.map((k) => `<button type="button" class="btn${k === spawnKind ? ' is-on' : ''}" data-kind="${k}" aria-pressed="${k === spawnKind}" ${tipAttr(CLASS_NAMES[k], 'N', UNIT_BLURB[k] ?? '', 'Shift+N for a red one.')}>${CLASS_NAMES[k]}</button>`).join('');
}
spawnPicker.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-kind]');
  if (!b) return;
  spawnKind = b.dataset.kind;
  buildSpawnPicker();
});
const speedLabel = document.getElementById('speed-label');
const showSpeed = () => { speedLabel.textContent = `×${GAME_SPEED.speed.toFixed(1)}`; };
showSpeed();

// Overlays: the pause menu (Esc, or ≡ by the minimap), Controls (F1, or ?), Options and Credits, one over the other;
// Esc closes the top one. While any is open in a game, the game stands still.
const overlays = [];
function openOverlay(id) {
  if (overlays.at(-1) === id) return;
  if (overlays.length) document.getElementById(overlays.at(-1)).hidden = true;
  const i = overlays.indexOf(id);
  if (i >= 0) overlays.splice(i, 1);
  overlays.push(id);
  if (id === 'options') showOptions();
  if (id === 'controls') showControls();
  const el = document.getElementById(id);
  el.hidden = false;
  tipAt(null);
  (el.querySelector('[data-pause="resume"], [data-close]') ?? el).focus?.({ preventScroll: true });
  sfx('toggleOn');
}
function closeOverlay() {
  const id = overlays.pop();
  if (!id) return;
  document.getElementById(id).hidden = true;
  if (overlays.length) document.getElementById(overlays.at(-1)).hidden = false;
  document.activeElement?.blur?.();
  sfx('toggleOff');
}
const closeOverlays = () => { while (overlays.length) closeOverlay(); };
const paused = () => !!mode.name && overlays.length > 0;
function pauseGame() {
  if (!mode.name || possess.unit) return;
  arm(null);
  openOverlay('pause');
}
for (const b of document.querySelectorAll('[data-open]')) b.addEventListener('click', () => openOverlay(b.dataset.open));
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', closeOverlay);
for (const el of document.querySelectorAll('.overlay')) el.addEventListener('pointerdown', (e) => { if (e.target === el) closeOverlay(); });
document.querySelector('[data-pause="resume"]').addEventListener('click', closeOverlays);
document.querySelector('[data-pause="menu"]').addEventListener('click', toMainMenu);
document.getElementById('btn-controls').addEventListener('click', (e) => { openOverlay('controls'); e.currentTarget.blur(); });
document.getElementById('btn-pause').addEventListener('click', (e) => { pauseGame(); e.currentTarget.blur(); });

// Options: the sound's volume, the screen's edge moving the camera, blood (kept in localStorage), HDR output (see
// hdrButton).
const optVolume = document.getElementById('opt-volume'), optEdge = document.getElementById('opt-edge');
const optBlood = document.getElementById('opt-blood'), BLOOD_KEY = 'god-game-blood';
try { if (localStorage.getItem(BLOOD_KEY) === '0') SPLASH_TUNING.blood = 0; } catch { /* (storage blocked: on) */ }
function showOptions() {
  optBlood.checked = SPLASH_TUNING.blood >= 0.5;
  optVolume.value = AUDIO_TUNING.master;
  optVolume.style.setProperty('--f', `${100 * AUDIO_TUNING.master}%`);
  optEdge.checked = HUD_TUNING.edgePan >= 0.5;
}
optVolume.addEventListener('input', () => {
  AUDIO_TUNING.master = +optVolume.value;
  optVolume.style.setProperty('--f', `${100 * AUDIO_TUNING.master}%`);
  tuning.refresh();
});
optEdge.addEventListener('change', () => { HUD_TUNING.edgePan = optEdge.checked ? 1 : 0; tuning.refresh(); });
optBlood.addEventListener('change', () => {
  SPLASH_TUNING.blood = optBlood.checked ? 1 : 0;
  try { localStorage.setItem(BLOOD_KEY, optBlood.checked ? '1' : '0'); } catch { /* (not kept) */ }
  tuning.refresh();
});

// Controls (F1): every key, then how things work.
const kbd = (...k) => k.map((x) => (x === '+' || x === '/' || x === 'then' ? `<small>${x}</small>` : `<span class="key">${x}</span>`)).join('');
const CONTROLS = [
  ['Camera', [
    ['Move', kbd('Arrows') + ' <small>or the screen edge, or middle drag</small>'], ['Turn and tilt', 'Right drag'], ['Tilt', kbd('PgUp', 'PgDn')],
    ['Zoom', 'Wheel'], ['Go to the newest alert', kbd('Space')], ['Look at the selection', kbd('L')], ['Watch through its eyes', kbd('J')],
    ['Perspective or flat', kbd('P')],
  ]],
  ['Units', [
    ['Select', 'Click, or drag a box ' + kbd('Shift') + ' <small>adds</small>'], ['All of a kind on screen', 'Double click'],
    ['Move there, or attack', 'Right click ' + kbd('Shift') + ' <small>queues</small>'], ['Orders (the dock)', kbd('Q', 'W', 'E', 'R')],
    ['Make a group', kbd('Ctrl') + kbd('+') + kbd('0–9')], ['Add to a group', kbd('Shift') + kbd('+') + kbd('0–9')],
    ['Select a group (twice: go there)', kbd('0–9')], ['Next idle worker', kbd('.')],
  ]],
  ['Craft and buildings', [
    ['Build, Mine, Fill, Farm', kbd('Z', 'X', 'C', 'V')], ['Wall (in the Build menu)', kbd('B')], ['Train (a building selected)', kbd('Q', 'W', 'E')],
    ['Rally (twice: attack rally)', kbd('R') + ' <small>or right click</small>'], ['Clear an order under the cursor', kbd('Del')],
    ['Stop a mode', 'Right click ' + kbd('Esc')],
  ]],
  ['The screen', [
    ['Controls', kbd('F1')], ['Hide the HUD', kbd('F2')], ['Collapse the minimap', kbd('M')], ['Pause menu', kbd('Esc')],
    ['Developer buttons', kbd('`')], ['Tuning, profiler', kbd('T', 'G')], ['Lighting modes', kbd('Shift') + kbd('+') + kbd('L')],
  ]],
  ['Sandbox', [
    ['Raise, Lower, Flatten', kbd('F3', 'F4', 'F5')], ['Brush size', kbd('[', ']')], ['A unit at the cursor', kbd('N') + ' <small>(the one picked)</small> ' + kbd('Shift') + ' <small>red</small>'],
    ['Insta-build', kbd('I')], ['Fog of war', kbd('O')], ['Game speed', kbd('−', '+')],
  ]],
];
const HOW = [
  ['Your crystal', 'Your power crystal stands in your Keep. Lose it and you\'re out; destroy every rival\'s to win. When it\'s hit, the top left turns to ink and says from where: Space goes there.'],
  ['Workers and the inventory', 'Workers mine, fell, build and farm, and carry what they gather to your Keep: stone as bricks, logs as planks, dirt as clay, iron and gold ore as currency, wheat from farms. Building uses it up. A worker\'s Priority makes it do that kind of work first.'],
  ['Craft', 'Craft\'s orders need no selection: idle workers take them on, the nearest first, however far. Mine, Fill, Farm and Wall stay on, every click adding more, till right click, Esc or their key again. Shift+click an ore with Mine for its vein, a tree for its forest.'],
  ['Training', 'Select a building to train from it: the Keep trains workers, the Barracks, Archery Range, Mage Tower and Stables fighters. Click one in its queue to cancel it and get its cost back. Houses make room for more people.'],
  ['Shortages', 'When there isn\'t enough of something, its count on the bar at the top carries an ink warning, and so does what it\'s short for.'],
];
function showControls() {
  const keys = document.getElementById('controls-keys');
  if (keys.childElementCount) return;
  keys.innerHTML = CONTROLS.map(([h, rows]) => `<div><h3>${h}</h3>${rows.map(([a, b]) => `<div class="kr"><span>${a}</span><span>${b}</span></div>`).join('')}</div>`).join('');
  document.getElementById('controls-how').innerHTML = HOW.map(([h, p]) => `<div><h3>${h}</h3><p>${p}</p></div>`).join('');
}
// Possess (J, or the dock's Watch): the camera goes into the selected unit's head (of several, the one nearest the
// camera's target) and watches from its eyes, looking where it looks, as it goes about its business. Nothing can be
// ordered meanwhile. Esc (or J again) puts the camera back just as it was, and so does the unit's death. Its head (or,
// T > Possess, all of it) isn't drawn (see Units.parts, which gives its head's place and way as eyeFrame).
const possess = { unit: null, saved: null, view: null }; // view: the eye (relative to its feet), yaw and pitch, eased
const possessBanner = document.getElementById('possess');
function startPossess() {
  if (possess.unit || !mode.name) return;
  const t = camera.target, d = (u) => (u.pos[0] - t[0]) ** 2 + (u.pos[2] - t[2]) ** 2;
  const sel = units.list.filter((u) => u.selected && !u.dying && !u.hidden && u.kind !== 'crystal' && u.kind !== 'wall');
  if (!sel.length) return;
  const u = sel.reduce((a, b) => (d(b) < d(a) ? b : a));
  possess.unit = units.possessed = u;
  possess.saved = { target: [...camera.target], yaw: camera.yaw, pitch: camera.pitch, distance: camera.distance, ortho: camera.ortho };
  possess.view = null;
  arm(null);
  flatten.drawing = wall.drawing = brush.press = dig.press = farmDraw.d = wallLine.d = null;
  mouse.button = -1;
  mouse.skip = false;
  selectBox.hidden = true;
  camera.ortho = false;
  document.body.classList.add('possessing');
  possessBanner.innerHTML = `${teamChip(u.team)}<span>Watching through ${u.team === 'blue' ? 'your' : `${TEAMS[u.team].name}'s`} ${(CLASS_NAMES[u.kind] ?? u.kind).toLowerCase()}'s eyes</span><span class="key">Esc</span><span>goes back</span>`;
  possessBanner.hidden = false;
}
function endPossess() {
  if (!possess.unit) return;
  const s = possess.saved;
  Object.assign(camera, { target: s.target, yaw: s.yaw, pitch: s.pitch, distance: s.distance, ortho: s.ortho, fp: null });
  possess.unit = units.possessed = null;
  document.body.classList.remove('possessing');
  possessBanner.hidden = true;
}
// Each frame (after Units.parts): the camera at the possessed unit's eyes.
function possessView(dt) {
  const u = possess.unit, P = POSSESS_TUNING;
  if (u.dying || !units.list.includes(u)) { endPossess(); return; }
  units.hideBody = P.hideBody > 0.5;
  // Steady: at eye height over its feet, looking the way it faces; with the head (headBob, headTurn, headNod of the
  // way): from its eyes, its way.
  const feet = units.drawHeight(u), base = [u.pos[0], feet, u.pos[2]];
  const body = [Math.sin(u.yaw), 0, Math.cos(u.yaw)];
  const f = units.eyeFrame, bob = f ? clamp(P.headBob, 0, 1) : 0;
  const steady = [body[0] * P.eyeForward, P.eyeHeight + mountLift(u), body[2] * P.eyeForward]; // (a rider's up in its saddle)
  const head = f ? f.pos.map((v, i) => v - base[i] + f.up[i] * P.eyeUp + f.fwd[i] * P.eyeForward) : steady;
  const eye = steady.map((v, i) => v + (head[i] - v) * bob);
  const turn0 = f ? Math.atan2(f.fwd[0], f.fwd[2]) - u.yaw : 0, nod = f ? Math.atan2(f.fwd[1], Math.hypot(f.fwd[0], f.fwd[2])) : 0;
  const yaw = u.yaw + (turn0 - 2 * Math.PI * Math.round(turn0 / (2 * Math.PI))) * clamp(P.headTurn, 0, 1);
  const pitch = clamp(nod * clamp(P.headNod, 0, 1) + (P.pitch * Math.PI) / 180, -1.4, 1.4);
  // Eased (the eye relative to its feet, so it doesn't trail behind as it walks).
  const v = possess.view ??= { eye, yaw, pitch };
  const a = 1 - Math.exp(-dt / Math.max(P.smooth, 1e-3));
  const turn = yaw - v.yaw;
  v.eye = v.eye.map((x, i) => x + (eye[i] - x) * a);
  v.yaw += (turn - 2 * Math.PI * Math.round(turn / (2 * Math.PI))) * a;
  v.pitch += (pitch - v.pitch) * a;
  camera.fp = { eye: v.eye.map((x, i) => x + base[i]), yaw: v.yaw, pitch: v.pitch };
  camera.target = base; // (what's drawn round the target: grass, torchlight, the minimap's follow)
  camera.distance = P.view;
}

// Finished buildings (each selectable as one: a click on any of its blocks with the Select tool, outlined in its
// team's colour while it is). One with actions (BUILDING_ACTIONS) trains units from its command card: a queue of up to
// TRAIN_QUEUE, the first counting down its PRODUCTION_TUNING seconds, then brought out at its spawn point (waiting
// while that's blocked, or in a new game while the population's full: see popRoom) to walk a few voxels out of the
// door. A House (key 'hut') makes room for POP_TUNING.house more villagers. A building goes once most of its
// blocks are gone.
const TRAIN_QUEUE = 5;
const buildings = { list: [], at: new Map(), selected: null, nextId: 1, wait: 0 }; // at: voxel index -> building
// quiet: the Keep, there from the start (its torches already lit).
function finishBuilding({ plan, key, name }, quiet = false) {
  const b = { id: buildings.nextId++, key, name, plan, team: 'blue', actions: BUILDING_ACTIONS[key] ?? [], queue: [], paid: [], progress: 0, rally: [] };
  buildings.list.push(b);
  for (const [x, y, z] of plan.blocks) buildings.at.set(terrain.index(x, y, z), b);
  if (quiet) return;
  for (const t of plan.torches ?? []) if (torches.fits(t.cell, t.wall) && !torches.at(...t.cell)) order(torches.add(t));
  for (const t of plan.banners ?? []) banners.add(t); // (hung at once)
  // The Editor: its spawn point put down too, so saving it again keeps it.
  if (mode.name === 'editor' && plan.spawn && spawns.fits(plan.spawn.cell) && !spawns.at(...plan.spawn.cell)) spawns.add(plan.spawn.cell, plan.spawn.dir);
  const mid = [0, 1, 2].map((i) => plan.blocks.reduce((s, c) => s + c[i], 0) / Math.max(1, plan.blocks.length) + 0.5);
  sfx('buildDone', mid);
  logEvent(`${name} built`, ICON.build, [mid[0], mid[2]]);
}
// The finished building whose block is under the cursor, or null.
function buildingAt(x, y) {
  const { origin, dir } = rayAt(x, y);
  const hit = terrain.raycast(origin, dir);
  if (!hit) return null;
  const [cx, cy, cz] = hit.point.map((v, i) => Math.floor(v - hit.normal[i] * 0.01));
  return cy >= 0 && cy < SIZE[1] ? buildings.at.get(terrain.index(cx, cy, cz)) ?? null : null;
}
// A unit of `kind` at b's spawn point, facing its way (and, walk, sent out of the door): the unit (true for a building
// with no spawn point), or false while it's blocked.
function bringOut(b, kind, walk = true) {
  const sp = b.plan.spawn;
  if (!sp) return true;
  if (eliminated.has(b.team)) return false; // (out of the game)
  const { cell: [x, y, z], dir: [dx, dz] } = sp;
  if (terrain.solid(x, y, z)) return false;
  const u = units.spawn(x + 0.5, z + 0.5, y, b.team, kind);
  if (!u) return false;
  u.yaw = Math.atan2(dx, dz);
  if (!walk) return u;
  // Off along its rally waypoints (attack-moving to those set with Q), or else a few voxels out of the door.
  if (b.rally.length) b.rally.forEach((r, i) => units.order(r.point, r.normal, r.amove, i > 0, [u]));
  else units.order([x + dx * 3 + 0.5, y + 0.5, z + dz * 3 + 0.5], [0, 0, 0], false, false, [u]);
  if (b.team === 'blue') { sfx('unitReady'); logEvent(`${CLASS_NAMES[kind] ?? kind} trained at the ${b.name}`, UNIT_ICON[kind] ?? ICON.chevron, [x + 0.5, z + 0.5]); }
  return u;
}
// A new game's population: the player's villagers (not counting its crystal), and the room its Keep and houses
// make for them (see POP_TUNING).
const population = () => units.list.filter((u) => u.team === 'blue' && !u.dying && u.kind !== 'crystal' && u.kind !== 'wall').length;
function popRoom() {
  let n = 0;
  for (const b of buildings.list) if (b.team === 'blue') n += b.key === 'keep' ? POP_TUNING.keep : b.key === 'hut' ? POP_TUNING.house : 0;
  return Math.round(n);
}
// Where workers take what they've gathered (see jobs.js Workers.deliver): the player's Keep, or for wheat, the
// Keep or any house. As { lo, hi } boxes ([x, y, z], hi exclusive) round their blocks.
function depots(block) {
  return buildings.list.filter((b) => b.team === 'blue' && (b.key === 'keep' || (block === WHEAT && b.key === 'hut'))).map((b) => planBox(b.plan));
}
// A rally waypoint where the screen point (x, y) lands: amove, attack-moving to it; queued (Shift), after the others,
// else instead of them.
function setRally(b, x, y, amove, queued) {
  const { origin, dir } = rayAt(x, y);
  const hit = terrain.raycast(origin, dir);
  if (hit) addRally(b, hit, amove, queued);
}
function addRally(b, hit, amove, queued) {
  if (!b.actions.length) return;
  if (!queued) b.rally = [];
  b.rally.push({ point: hit.point.slice(), normal: hit.normal.slice(), amove });
  orderSound(amove ? 'attack' : 'move');
}
// The selected building's rally waypoints, as unit-renderer parts: a post with a flag at each (blue for a move, red
// for an attack-move), joined by a dotted line along the way a unit coming out of its spawn point would walk.
const markBox = (out, x, y, z, sx, sy, sz, col) => out.push({ m: [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1], col, emit: 1 });
const flagParts = (out, [x, y, z], col) => {
  markBox(out, x + 0.5, y + 0.7, z + 0.5, 0.08, 1.4, 0.08, [0.9, 0.9, 0.9]);
  markBox(out, x + 0.7, y + 1.25, z + 0.5, 0.4, 0.28, 0.04, col);
};
const dotParts = (out, dots, col) => { for (const [x, y, z] of dots) markBox(out, x, y, z, 0.12, 0.12, 0.12, col); };
// Where a unit sent to a clicked point (see units.order) stands: the cell in front of the face, at the nearest
// height it can stand at there.
function standAt(point, normal) {
  const c = point.map((v, i) => Math.floor(v + normal[i] * 0.5));
  const h = units.standHeight(c[0], c[2], c[1], 6);
  return h >= 0 ? [c[0], h, c[2]] : c;
}
function rallyParts(b, out) {
  const sp = b.plan.spawn;
  if (!sp || !b.rally.length) return;
  let start = sp.cell;
  for (let y = sp.cell[1]; y >= sp.cell[1] - 3; y--) if (units.standable(sp.cell[0], y, sp.cell[2])) { start = [sp.cell[0], y, sp.cell[2]]; break; }
  const goals = b.rally.map((r) => standAt(r.point, r.normal));
  const legs = walkDots(b, start, goals, 1000);
  b.rally.forEach((r, i) => {
    const col = r.amove ? [1.4, 0.25, 0.2] : [0.3, 0.7, 1.6];
    flagParts(out, goals[i], col);
    dotParts(out, legs[i], col);
  });
}
// The selected units' patrols (the player's): a yellow post with a flag at each of its points and a dotted line along
// the way it walks round them (staying put: none following the unit along the way it's walking now).
const PATROL_COL = [1.5, 1.15, 0.2];
function patrolParts(out) {
  for (const u of units.commandable()) {
    const P = u.patrol;
    if (!P || u.dying || u.hidden) continue;
    for (const p of P.points) flagParts(out, p, PATROL_COL);
    for (const leg of walkDots(u, P.points[0], P.points.slice(1), 2000)) dotParts(out, leg, PATROL_COL);
  }
}
// The way a unit walks (units.findPath) from cell `start` through each of `goals` in turn, as a dotted line for each
// leg: kept on `holder` and found again every `every` ms (the ground may have changed) or when the points change.
function walkDots(holder, start, goals, every) {
  const key = JSON.stringify([start, goals]), now = performance.now(), c = holder.walkDots;
  if (c && c.key === key && now - c.t < every) return c.legs;
  const legs = [];
  let at = start;
  for (const g of goals) {
    const cells = [at, ...units.findPath(at, g)];
    legs.push(dotsAlong(cells));
    at = cells.at(-1);
  }
  holder.walkDots = { key, t: now + Math.random() * every * 0.25, legs }; // (spread out, so they're not all found in one frame)
  return legs;
}
// Dots a voxel apart along the line through cells (feet at [x, y, z]: dots a little above, at their middles).
function dotsAlong(cells) {
  const pts = cells.map(([x, y, z]) => [x + 0.5, y + 0.3, z + 0.5]), out = [];
  let d = 0, next = 0.7;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    for (; next <= d + len; next += 1) {
      const t = (next - d) / len;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
    d += len;
  }
  return out;
}
// Whether a new game's inventory has what training `kind` costs (sandbox: always).
const canAfford = (kind) => !inventory || trainingCost(kind).every(([blk, n]) => inventory.get(blk) >= n);
function trainUnit(b, kind) {
  if (!b || !b.actions.includes(kind)) return;
  if (b.queue.length >= TRAIN_QUEUE) { sfx('error'); return; }
  const cost = inventory ? trainingCost(kind) : [];
  if (!canAfford(kind)) {
    const short = cost.filter(([blk, n]) => inventory.get(blk) < n).map(([blk]) => CURRENCY_NAMES[blk]);
    toast(`Not enough ${short.join(' or ')} for a ${CLASS_NAMES[kind] ?? kind}`);
    sfx('error');
    return;
  }
  sfx('trainQueue');
  for (const [blk, n] of cost) inventory.add(blk, -n);
  b.queue.push(kind);
  b.paid.push(cost);
}
// Cancelled: what it cost goes back into the inventory.
function cancelTraining(b, i) {
  if (!b || !b.queue[i]) return;
  b.queue.splice(i, 1);
  for (const [blk, n] of b.paid.splice(i, 1)[0] ?? []) inventory?.add(blk, n);
  if (i === 0) b.progress = 0;
}
function updateBuildings(dt) {
  for (const b of buildings.list) {
    if (!b.queue.length) continue;
    const time = Math.max(0, PRODUCTION_TUNING[b.queue[0]] ?? 5);
    b.progress = Math.min(time, b.progress + dt);
    if (b.progress < time) continue;
    if (inventory && b.team === 'blue' && population() >= popRoom()) { // (housed: no room for another)
      const box = planBox(b.plan);
      if (events.warn('housed', `Population full (${population()}/${popRoom()})`, 'Training waits: build more houses', [(box.lo[0] + box.hi[0]) / 2, (box.lo[2] + box.hi[2]) / 2], gameClock)) sfx('error');
      continue;
    }
    if (!bringOut(b, b.queue[0])) continue;
    b.queue.shift();
    b.paid.shift();
    b.progress = 0;
  }
  buildings.wait -= dt;
  if (buildings.wait > 0) return;
  buildings.wait = 0.5;
  // Gone once fewer than half its blocks are still there.
  for (const b of buildings.list) {
    let left = 0;
    for (const [x, y, z, block] of b.plan.blocks) if (terrain.block(x, y, z) === block) left++;
    if (left * 2 >= b.plan.blocks.length) continue;
    b.gone = true;
    for (const [x, y, z] of b.plan.blocks) if (buildings.at.get(terrain.index(x, y, z)) === b) buildings.at.delete(terrain.index(x, y, z));
    if (buildings.selected === b) buildings.selected = null;
  }
  buildings.list = buildings.list.filter((b) => !b.gone);
}
// A building's blocks that are still there, for its outline (src/outline.js).
const standingBlocks = (b) => b.plan.blocks.filter(([x, y, z]) => terrain.solid(x, y, z));
// Training costs' names and icons (see .price in index.html).
const CURRENCY_NAMES = { [BLOCK.GOLD]: 'gold', [BLOCK.IRON]: 'iron', [BLOCK.PLANK]: 'planks', [WHEAT]: 'wheat' };
// Patrol (Y, then left click): the selected villagers attack-move there and back to where they started, over and
// over; with Shift, the point's added to their round (they walk the points in order, then back).
function patrolOrder(x, y, queued) {
  if (buildings.selected) return;
  const { origin, dir } = rayAt(x, y);
  const hit = terrain.raycast(origin, dir);
  if (!hit) return;
  if (units.commandable().length) orderSound('patrol');
  units.patrol(hit.point, hit.normal, queued);
}

function attackMove(x, y, queued) {
  if (buildings.selected) { setRally(buildings.selected, x, y, true, queued); return; }
  const target = targetAt(x, y);
  if (target && attackOrder(target)) return;
  const { origin, dir } = rayAt(x, y);
  const hit = terrain.raycast(origin, dir);
  if (!hit) return;
  if (units.commandable().length) orderSound('attack');
  units.order(hit.point, hit.normal, true, queued);
}

// The minimap's clicks (see minimap.js): left click or drag moves the camera; with a command armed (attack-move, patrol,
// the card's Move), a left click is its target; right click sends the selected villagers (or sets the selected
// building's rally), on the ground of the column clicked or after the villager whose dot was clicked; Ctrl and drag
// selects. Each order pings the minimap: green a move, red an attack.
function mapOrder(cmd, x, z, target, queued) {
  const b = buildings.selected, attackCol = '#ff5a4a', moveCol = '#6dff8a';
  if (!b && !units.commandable().length) return;
  x = clamp(x, 0, SIZE[0] - 1);
  z = clamp(z, 0, SIZE[2] - 1);
  const hit = { point: [x, terrain.groundAt(x, z), z], normal: [0, 1, 0] };
  if (b) {
    if (cmd === 'patrol' || !b.actions.length) return;
    addRally(b, hit, cmd === 'attack', queued);
    minimap.ping(x, z, cmd === 'attack' ? attackCol : moveCol);
    return;
  }
  if (cmd !== 'patrol' && target && attackOrder(target)) { minimap.ping(target.pos[0], target.pos[2], attackCol); return; }
  orderSound(cmd);
  if (cmd === 'patrol') units.patrol(hit.point, hit.normal, queued);
  else units.order(hit.point, hit.normal, cmd === 'attack', queued);
  minimap.ping(x, z, cmd === 'move' ? moveCol : attackCol);
}
minimap.onLook = (x, z) => {
  camera.target[0] = clamp(x, 0, SIZE[0]);
  camera.target[2] = clamp(z, 0, SIZE[2]);
};
minimap.onCommand = (x, z, target, queued) => {
  if (!['attack', 'move', 'patrol'].includes(command.armed)) return false;
  mapOrder(command.armed, x, z, target, queued);
  if (!queued) arm(null);
  return true;
};
minimap.onOrder = (x, z, target, queued) => {
  if (command.armed) arm(null); // (right click calls off an armed command, as in the view)
  else mapOrder('move', x, z, target, queued);
};
minimap.onSelect = (list, add) => {
  if (!add) for (const u of units.list) u.selected = false;
  for (const u of list) u.selected = add && list.length === 1 ? !u.selected : true;
  if (!add || list.length) buildings.selected = null;
  if (list.length) sfx('select');
};

function spawnAtCursor(team = 'blue', kind = 'worker') {
  const hit = pick(camera.matrices().invViewProj);
  if (hit) units.spawn(hit.point[0] + hit.normal[0] * 0.5, hit.point[2] + hit.normal[2] * 0.5, Math.floor(hit.point[1] + hit.normal[1] * 0.5) + 1, team, kind);
}

// The steady sounds this frame (see audio.js bed and emit): whirling axes, fireballs, priests' beams, the power
// crystals' hum and the flames' crackle where they are; the waves near the camera, the wind (a little more the higher
// the camera, AUDIO_TUNING windLow to windHigh) and the night's crickets. Then the mix, from the camera m.
function frameSounds(m, speed, night, flames) {
  if (audio.ready) {
    const live = units.list.filter((u) => !u.dying && !u.hidden);
    audio.emit('whirl', live.filter((u) => u.whirling).map((u) => u.pos));
    audio.emit('fireball', units.fireballs);
    audio.emit('healBeam', (units.beams ?? []).map(({ a, b }) => a.map((v, i) => (v + b[i]) / 2)));
    audio.emit('crystalHum', live.filter((u) => u.kind === 'crystal').map((u) => [u.pos[0], crystalBase(u) + CRYSTAL_TUNING.hover + CRYSTAL_TUNING.length / 2, u.pos[2]]));
    audio.emit('fire', flames);
    // The waves: heard only with the camera near the water (AUDIO_TUNING.ambientReach from it to a half), from the water
    // nearest the camera, louder the more of the ground round there is water. A grid round the camera.
    const reach = AUDIO_TUNING.ambientReach, [ex, ey, ez] = m.eye, step = Math.max(1.5, reach / 8), R = reach * 2.5;
    let wet = 0, n = 0, best = Infinity, at = null;
    const dy = Math.max(0, ey - WATER_LEVEL);
    if (dy < R) {
      const flat = Math.sqrt(R * R - dy * dy);
      for (let z = ez - flat; z <= ez + flat; z += step) {
        for (let x = ex - flat; x <= ex + flat; x += step) {
          const d2 = (x - ex) ** 2 + (z - ez) ** 2;
          if (d2 > flat * flat) continue;
          n++;
          if (x < 0 || z < 0 || x >= SIZE[0] || z >= SIZE[2] || terrain.groundAt(Math.floor(x), Math.floor(z)) >= WATER_LEVEL) continue;
          wet++;
          if (d2 < best) { best = d2; at = [x, WATER_LEVEL, z]; }
        }
      }
    }
    if (at) {
      const d = Math.hypot(at[0] - ex, at[1] - ey, at[2] - ez), near = ambientFade(d, reach);
      audio.bed('water', near * (0.6 + 0.4 * Math.min(1, (wet / n) * 3)), audio.place(at, 1).pan);
    }
    const high = possess.unit ? 0.1 : smooth(80, 900, camera.distance);
    // (None on the main menu and the game setup: the world's only a backdrop there.)
    if (!document.body.classList.contains('in-menu')) audio.bed('wind', AUDIO_TUNING.windLow + (AUDIO_TUNING.windHigh - AUDIO_TUNING.windLow) * high);
    audio.bed('crickets', night * (1 - 0.7 * high) * (1 - 0.6 * (n ? wet / n : 0)));
  }
  audio.frame({ eye: m.eye, viewProj: m.viewProj }, speed);
}

// --- Frame loop --------------------------------------------------------------------------------------------

let last = performance.now();
let fpsTime = last, fpsFrames = 0, fps = 0;
let gameClock = 0; // seconds of game time (slowed with the game speed; still while paused)
let startClock = 0; // gameClock when the game started (the ribbon's time)
let lastRealDt = 0; // the last frame's real time step (the dock's live view turns with it)

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  camera.aspect = w / h;
  renderer.resize(w, h);
  water.resize(w, h, renderer.gbuf);
  post.resize(w, h, renderer.depth);
}

function frame(now) {
  const frameStart = performance.now();
  profiler.lap(null);
  // The game's time step (slowed in slow motion, see GAME_SPEED) and the camera's, always real.
  const realDt = Math.min(0.1, (now - last) / 1000);
  const speed = paused() ? 0 : mode.name === 'sandbox' ? clamp(GAME_SPEED.speed, 0.1, 1) : 1;
  const dt = realDt * speed;
  gameClock += dt;
  const clock = gameClock;
  last = now;
  lastRealDt = realDt;
  resize();
  if (!possess.unit) keyboardCamera(realDt);

  // Ease the orbit target onto the ground so tilting and zooming pivot about the terrain under it.
  const ground = terrain.groundAt(camera.target[0], camera.target[2]);
  camera.target[1] += (ground - camera.target[1]) * Math.min(1, realDt * 6);

  let m = camera.matrices();
  profiler.lap('input + camera');
  const hit = possess.unit ? null : pick(m.invViewProj);
  profiler.lap('pick (voxel raycast)');
  brush.hit = hit;
  profiler.lap(null);
  if (!mode.name) camera.orbit(realDt * MENU_TUNING.spin, 0); // the world turning behind the main menu
  units.update(dt);
  groups.update();
  // Fog of war: what each team sees now; the edits held back that the player sees now shown (and, never seen not
  // drawn, the tiles they've just seen for the first time); other teams' villagers where the player can't see hidden
  // (and dropped from the selection).
  syncBlank();
  for (const b of fog.update(dt, units.list, buildings.list, sightOf, buildingSightOf)) shown(b.lo, b.hi, true);
  for (const u of units.list) {
    const at = u.rag ? u.rag.pos : u.pos;
    u.hidden = fog.on && u.team !== fog.player && fog.hidden(at[0], at[2]);
    if (u.hidden) u.selected = false;
  }
  const seenUnits = fog.on ? units.list.filter((u) => !u.hidden) : units.list;
  for (const f of finishedPlans.splice(0)) finishBuilding(f);
  updateBuildings(dt);
  farms.update(dt, units.workers); // the wheat growing, and the farms' work for the workers
  walls.update(dt, (x, y, z) => units.workers.toFill(x, y, z)); // (sections finished, orders dropped)
  gates.check(); // (a gate goes with its wall)
  for (const g of gates.update(dt, units.list)) { // (raised for its team's units, with a rattle)
    const at = [g.x + 0.5 + g.along[0] * 0.5, g.y0 + 1, g.z + 0.5 + g.along[1] * 0.5];
    if (!fog.hidden(at[0], at[2])) sfx('gate', at);
  }
  inventory?.update(dt);
  // The HUD: the mode bar's hint for a box being drawn, the dock, the ribbon, the crystals, events and idle workers.
  workHint = flatten.drawing ? `Flatten to height ${flatten.drawing.level}. The wheel changes it.`
    : wall.drawing?.stage === 'width' ? 'Move to stretch the line sideways, then click for its height. Esc cancels.'
    : wall.drawing?.raising ? `Box ${wall.drawing.y1 - wall.drawing.y0} high: move up or down, then click to ${wall.drawing.save ? 'save it as a design' : wall.drawing.add ? 'build' : 'dig'}. Esc cancels.` : '';
  renderDock();
  showRibbonFrame();
  renderCrystal();
  renderEvents();
  renderIdle();
  updateWorldInfo(realDt);
  puffs.update(dt);
  splashes.update(dt);
  grass.tick(dt); // lost tufts' blades fluttering down
  if (dt > 0) { // (paused: nothing falls)
    debris.tick(dt);
    felling.tick(dt);
    collapse.update(dt);
  }
  scorch.update(dt);
  bars.update(seenUnits, dt);
  strength.update(units.list.filter((u) => u.kind !== 'crystal' && u.kind !== 'wall'), dt);
  minimap.update(dt, mode.name ? seenUnits.filter((u) => u.kind !== 'wall') : [], fog.on ? buildings.list.filter((b) => b.team === fog.player || b.seen) : buildings.list, buildings.selected);
  for (const c of leafDecay.update(dt)) {
    sfx('leaves', [0, 1, 2].map((i) => (c.lo[i] + c.hi[i]) / 2));
    for (const b of fog.defer(c.lo, c.hi)) shown(b.lo, b.hi);
  }
  // Torches: lit as the sun goes down past TORCH_TUNING.sunBelow; the flames nearest the camera's target light the
  // ground (as marks) and the villagers.
  const sunDeg = Math.asin(Math.max(-1, Math.min(1, sky.sun[1]))) * 180 / Math.PI;
  const torchLit = 1 - smooth(TORCH_TUNING.sunBelow - 2, TORCH_TUNING.sunBelow + 2, sunDeg);
  const parts = units.parts(torchLit);
  const teamColour = (team) => TEAMS[team].toga;
  crystalParts(units, clock, teamColour, parts); // the power crystals (their beams: see beams.draw)
  const glows = crystalLights(units, clock, teamColour).map(([x, y, z, r, ...c]) => [x, y, z, r, ...c.map((v) => v * sky.exposure)]);
  if (possess.unit) { possessView(realDt); m = camera.matrices(); } // (from its eyes as they are this frame)
  const fp = possess.unit ? POSSESS_TUNING : null;
  puffs.trail(units.fireballs, dt);
  puffs.plasma(units.beams ?? [], dt, {
    rate: COMBAT_TUNING.plasma, size: COMBAT_TUNING.plasmaSize, life: COMBAT_TUNING.plasmaLife, glow: COMBAT_TUNING.plasmaGlow,
    drift: COMBAT_TUNING.plasmaDrift, color: linearColor(COMBAT_TUNING.beamColor),
  });
  torches.check(); // a placed torch goes when its voxel's filled or its support is dug away
  const flameCol = linearColor(TORCH_TUNING.color).map((c) => c * 1.6 + 0.15);
  const placed = torches.parts(clock, flameCol, TORCH_TUNING.flicker, [0.42, 0.26, 0.12]);
  parts.push(...placed.parts);
  banners.check(); // (one goes with the block it hangs on)
  banners.parts(parts, units.hiddenAt, clock);
  gates.parts(parts, linearColor(GATE_TUNING.color), units.hiddenAt); // the portcullises' iron grids
  collapse.parts(parts, placed.flames, flameCol, [0.42, 0.26, 0.12], clock); // a fallen team's banners burning, torches down
  const bannerAt = brush.tool === 'build' && BANNER_ITEMS[build.item] ? banners.placement(hit, BANNER_ITEMS[build.item]) : null;
  if (bannerAt?.fits && !banners.at(...bannerAt.cell)) banners.partsOf(bannerAt, parts, null, clock); // (where it'd hang)
  if (buildings.selected) rallyParts(buildings.selected, parts); // its rally waypoints
  patrolParts(parts); // and the selected units' patrols
  // Spawn points: those placed (editor), the one under the cursor while placing one, and a building's being placed.
  spawns.check();
  const spawnCol = linearColor(SPAWN_TUNING.color);
  spawns.parts(parts, spawnCol);
  if (brush.tool === 'build' && build.item === 'spawn') {
    const p = spawns.placement(hit);
    if (p?.fits && !spawns.at(...p.cell)) spawnParts(p.cell, cameraFacing(p.cell), spawnCol, parts, 0.45);
  } else if (brush.tool === 'build' && BUILDINGS[build.item]) {
    const g = buildAt(hit);
    if (g?.plan.spawn) spawnParts(g.plan.spawn.cell, g.plan.spawn.dir, spawnCol, parts, 0.45);
  }
  const ct = camera.target;
  const flames = [...units.torches, ...placed.flames]
    .map((f) => [f, (f[0] - ct[0]) ** 2 + (f[2] - ct[2]) ** 2])
    .sort((a, b) => a[1] - b[1]).slice(0, MAX_TORCH_LIGHTS).map(([f]) => f);
  const torch = [...linearColor(TORCH_TUNING.color).map((c) => c * TORCH_TUNING.strength * sky.exposure), TORCH_TUNING.radius];
  frameSounds(m, speed, torchLit, [...units.torches, ...placed.flames]);
  profiler.lap('units (move + pose)');

  const add = (brush.tool === 'raise') !== (keys.has('ShiftLeft') || keys.has('ShiftRight'));
  const ghost = brush.tool === 'build' ? buildAt(hit) : null;
  const pixel = camera.ortho
    ? (2 * m.halfH) / canvas.height
    : (2 * Math.tan((fp ? (fp.fov * Math.PI) / 180 : CAMERA_TUNING.fov) / 2)) / canvas.height;
  const fogStart = fp ? fp.fogStart : camera.ortho ? 250 : camera.distance;
  const encoder = device.createCommandEncoder();
  sky.update(encoder, { dt, eye: m.eye }, profiler);
  if (S.timeSpeed) tuning.refresh(); // the clock is moving the time of day slider
  const sun = sky.light; // the sun, or the moon at night
  skyVis.tick({ light: sun, torch, flames: flames.map((f) => [f[0], f[1], f[2], Math.min(0.999, f[3])]), target: camera.target });
  // (With HDR output, the float texture the frame's drawn into instead of the canvas: see hdrOut.)
  const canvasTexture = hdr ? hdrOut.scene(canvas.width, canvas.height) : context.getCurrentTexture();
  const colorView = canvasTexture.createView({ format: COLOR_FORMAT });
  renderer.draw(encoder, colorView, {
    invViewProj: m.invViewProj,
    viewProj: m.viewProj,
    torch,
    marks: units.marks(256, [
      ...glows.flatMap(([x, y, z, r, cr, cg, cb]) => [[x, y, z, -2], [cr, cg, cb, r]]), // (the power crystals' light)
      ...flames.map((f) => [f[0], f[1], f[2], 5 + Math.min(0.999, f[3])]),
      ...(flatten.drawing ? flattenMarks(flatten.drawing) : wall.drawing ? wallMarks(wall.drawing) : []),
    ]),
    camPos: m.eye,
    // Where the depth of field has blurred the ground past half its widest (see post.js): no bevels or normal maps.
    detailFar: fp ? (fp.dof > 0.5 && POST_TUNING.dofBlur > 0 ? fp.focus + Math.max(POST_TUNING.dofRange, 0.5) * 1.5 : 1e9)
      : POST_TUNING.dofBlur > 0 ? Math.max(0, camera.distance + POST_TUNING.dofFocus) + Math.max(POST_TUNING.dofRange, 0.5) * 1.5 : 1e9,
    ortho: camera.ortho,
    sun,
    brush: [0, 0, 0, 0], // (the brush shows as ghost cubes instead)
    brushColor: add ? [0.55, 1.0, 0.6, 1] : [1.0, 0.55, 0.45, 1],
    pixel,
    fogStart,
    time: clock,
    scorch: scorch.uniforms(),
  }, profiler);
  grass.draw(encoder, colorView, renderer.depthView, renderer.shadow, m.viewProj, sun, {
    eye: m.eye, ahead: [-m.view[2], -m.view[6], -m.view[10]], ortho: camera.ortho, pixel, target: camera.target, size: renderer.size,
  }, profiler);
  debris.draw(encoder, colorView, renderer.depthView, renderer.shadow, m.viewProj, sun, {
    eye: m.eye, ahead: [-m.view[2], -m.view[6], -m.view[10]], ortho: camera.ortho, pixel, target: camera.target, size: renderer.size,
  }, profiler);
  felling.draw(encoder, colorView, renderer.depthView, renderer.shadow, m.viewProj, sun, {
    eye: m.eye, ahead: [-m.view[2], -m.view[6], -m.view[10]], ortho: camera.ortho, pixel, target: camera.target, size: renderer.size,
  }, profiler);
  farms.draw(encoder, colorView, renderer.depthView, renderer.shadow, m.viewProj, sun, {
    eye: m.eye, ahead: [-m.view[2], -m.view[6], -m.view[10]], ortho: camera.ortho, pixel, size: renderer.size,
  }, profiler);
  // Ghost cubes: the marked ground still to do, and what the Raise/Lower brush would mark here.
  const ghosts = torches.ghosts(sculpt.ghosts()); // (open orders show whatever the tool)
  for (const g of ghosts) if (g[3] === 1 && walls.at(g[0], g[1], g[2])?.built === false) g[3] = 16; // (a wall's: built, the team's colour)
  mines.ghosts(ghosts); // the open Mine orders
  gates.ghosts(ghosts); // and portcullises still to make
  farms.ghosts(ghosts); // and Farm's still to till
  units.workers.buildGhosts(ghosts); // and the buildings' blocks still to place
  // A building being placed: its blocks, in the team's colour where it fits (white past the inventory, red where not).
  if (ghost) planGhosts(ghost.plan, ghost.fits ? (ghost.short ? 7 : 14) : 15, ghosts);
  // Farm (6): the top under the cursor (red where it can't be farmed), or every farmable top in the box being dragged.
  if (command.armed === 'farm' && farmDraw.d && mouse.dragged) {
    for (const [x, y, z] of farms.box(...farmBox(farmDraw.d))) ghosts.push([x, y, z, 9]);
  } else if (command.armed === 'farm' && hit) {
    const c = hit.point.map((v, i) => Math.floor(v - hit.normal[i] * 0.01));
    if (!farms.has(c[0], c[2])) ghosts.push([...c, farms.farmable(...c) ? 9 : 10]);
  }
  // Wall (B): the line being dragged (or the column under the cursor), in the team's colour, white past what the
  // inventory has, red where it can't go.
  if (command.armed === 'wall' && (wallLine.d || hit)) {
    const c = !wallLine.d && hit.point.map((v, i) => Math.floor(v - hit.normal[i] * 0.01));
    const P = wallPlan(wallLine.d ?? { a: [c[0], c[2]], b: [c[0], c[2]], y: c[1] + 1 });
    let left = inventory ? inventory.left(wallBlock(palette.block) ?? BLOCK.BRICK) : Infinity;
    for (const { x, z, y0 } of P.cols) for (let k = 0; k < Math.round(WALL_TUNING.height); k++) ghosts.push([x, y0 + k, z, left-- > 0 ? 14 : 7]);
    for (const { x, z, y0 } of P.blocked) ghosts.push([x, y0, z, 10]);
  }
  // Mine (E): the block (or tree) under the cursor (its box shows as Lower's does).
  if (command.armed === 'dig' && hit && !wall.drawing) {
    const target = mineTarget(hit.point.map((v, i) => Math.floor(v - hit.normal[i] * 0.01)));
    for (const [x, y, z] of keys.has('ShiftLeft') || keys.has('ShiftRight') ? withVeins(target) : target) { // (Shift: the vein)
      for (const [lx, ly, lz] of terrain.block(x, y, z) === BLOCK.LOG ? trunkLogs(terrain, x, y, z) : [[x, y, z]]) ghosts.push([lx, ly, lz, 2]); // (a tree: its whole trunk)
    }
  } else if (command.armed === 'fill' && hit && !wall.drawing) { // (white when the inventory's out of the block)
    for (const [x, y, z] of fillTarget(hit)) ghosts.push([x, y, z, !inventory || inventory.left(palette.block) > 0 ? 3 : 7]);
  }
  if (brush.tool === 'build' && build.item === 'torch') {
    const p = torches.placement(hit);
    if (p) ghosts.push(torches.preview(p));
  } else if (brush.tool === 'build' && build.item === 'portcullis') { // (white when the iron's short)
    const p = gates.placement(hit, 'blue');
    if (p) gates.preview(p, !!inventory && inventory.get(BLOCK.IRON) < Math.round(GATE_TUNING.iron), ghosts);
  } else if (brush.tool === 'build' && BANNER_ITEMS[build.item]) {
    const p = banners.placement(hit, BANNER_ITEMS[build.item]);
    if (p && !p.fits && !banners.at(...p.cell)) banners.blocked(p, ghosts);
  } else if (ghost?.plan.torches) { // a building being placed: its torches
    for (const t of ghost.plan.torches) ghosts.push(torches.preview({ ...t, fits: true }));
  }
  // (In a new game, the fills past what's left of the inventory after the open orders preview white.)
  let left = inventory ? inventory.left(palette.block) : Infinity;
  if (wall.drawing && !wall.drawing.save) {
    for (const [x, y, z] of wallVoxels(wall.drawing)) ghosts.push([x, y, z, wall.drawing.add ? (left-- > 0 ? 3 : 7) : 2]);
  } else if (hit && (brush.tool === 'raise' || brush.tool === 'lower')) {
    for (const [x, y, z] of brushVoxels(terrain, hit, brush.radius, add)) ghosts.push([x, y, z, add ? (left-- > 0 ? 3 : 7) : 2]);
  }
  let oreParts = ores.parts(realDt, camera.target[0], camera.target[2], ORE_LOOK.reach + camera.distance);
  if (blankOn) oreParts = oreParts.filter((p) => !fog.blankAt(p.m[12], p.m[14])); // (none where nothing's drawn)
  if (oreParts.length) {
    oreRenderer.draw(encoder, colorView, renderer.depthView, m.viewProj, sun, oreParts, profiler, [], torch, flames, {
      eye: m.eye, ahead: [-m.view[2], -m.view[6], -m.view[10]], ortho: camera.ortho, pixel,
      metal: [ORE_LOOK.reflection, ORE_LOOK.glints, ORE_LOOK.glintSpeed, clock % 3600],
      metalEnv: [oreEnv.view ? 1 : 0, ORE_LOOK.envGain, ORE_LOOK.sunSpot, ORE_LOOK.sunSharp],
    }, glows);
  }
  oreEnv.wanted = oreParts.length > 0; // (baked only while there are chunks to show it)
  unitRenderer.draw(encoder, colorView, renderer.depthView, m.viewProj, sun, parts, profiler, ghosts, torch, flames, {
    eye: m.eye, ahead: [-m.view[2], -m.view[6], -m.view[10]], ortho: camera.ortho, pixel, size: renderer.size,
  }, glows);
  gems.draw(encoder, colorView, renderer.depthView, m.viewProj, sun, crystalGems(units, now / 1000, teamColour), {
    eye: m.eye, ahead: [-m.view[2], -m.view[6], -m.view[10]], ortho: camera.ortho,
  });
  // Distance fog on everything since the terrain (which fogs itself), before the outlines that should stay crisp.
  haze.draw(encoder, colorView, renderer.gbuf, renderer.depth, m.invViewProj, camera.ortho, fogStart);
  if (buildings.selected) { // its silhouette, in its team's colour, as wide as a selected villager's outline
    buildingOutlines.draw(encoder, colorView, renderer.gbuf, renderer.depth, m.viewProj, m.invViewProj,
      standingBlocks(buildings.selected), linearColor(HEALTHBAR_TUNING.hotBlue), SELECT_TUNING.outline, profiler);
  } else if (site && !site.done) { // one being built: all of it, white while the inventory can't cover it
    buildingOutlines.draw(encoder, colorView, renderer.gbuf, renderer.depth, m.viewProj, m.invViewProj,
      site.plan.blocks, site.short ? [1, 1, 1] : linearColor(HEALTHBAR_TUNING.hotBlue), SELECT_TUNING.outline, profiler);
  }
  profiler.lap('encode terrain + units');
  if (mode.name !== 'editor') { // (the editor has no water)
    water.draw(encoder, canvasTexture, renderer.depthView, {
      dt, eye: m.eye, viewProj: m.viewProj, invViewProj: m.invViewProj, ortho: camera.ortho, sun, pixel,
      fogStart,
    }, profiler);
  }
  profiler.lap('water (mesh LOD + encode)');
  // Fog of war: what's never been seen cut away, what's not seen now darker and greyer (after the water, which it
  // covers too).
  fog.draw(encoder, canvasTexture, colorView, renderer.depth, { invViewProj: m.invViewProj, pixAng: camera.ortho ? 0 : pixel }, profiler);
  unitRenderer.drawGhosts(encoder, colorView, renderer.depthView); // (orders over the fog)
  profiler.lap('fog of war (encode)');
  // Fire and smoke over everything (but behind what's in front of them), the smoke lit by the day (dim at night).
  // (The way the camera looks: from the middle of the screen at the near plane to the far one.)
  const unproject = (z) => {
    const M = m.invViewProj, w = M[11] * z + M[15];
    return [(M[8] * z + M[12]) / w, (M[9] * z + M[13]) / w, (M[10] * z + M[14]) / w];
  };
  const near = unproject(0), far = unproject(1), ll = Math.hypot(...far.map((v, i) => v - near[i])) || 1;
  const day = Math.max(0.12, Math.min(1, (sunDeg + 4) / 14));
  puffs.draw(encoder, colorView, renderer.depthView, renderer.depth, {
    viewProj: m.viewProj, invViewProj: m.invViewProj, eye: m.eye, look: far.map((v, i) => (v - near[i]) / ll),
  }, units.fireballs, [day, day, day * 1.05]);
  splashes.draw(encoder, colorView, renderer.depthView, m.viewProj, m.view, [day, day, day * 1.05]);
  trails.draw(encoder, colorView, renderer.depthView, m.viewProj, units.sweeps, day);
  beams.draw(encoder, colorView, renderer.depthView, m.viewProj, crystalBeams(units, teamColour), {
    eye: m.eye, ahead: [-m.view[2], -m.view[6], -m.view[10]], ortho: camera.ortho,
  }, CRYSTAL_TUNING, clock);
  profiler.lap('fire + smoke (encode)');
  post.draw(encoder, canvasTexture, fp
    ? { invViewProj: m.invViewProj, eye: m.eye, focus: fp.focus - POST_TUNING.dofFocus, dofBlur: fp.dof > 0.5 ? POST_TUNING.dofBlur : 0 }
    : { invViewProj: m.invViewProj, eye: m.eye, focus: camera.distance }, profiler);
  profiler.lap('post (encode)');
  bars.draw(encoder, colorView, renderer.depthView, m.viewProj, m.view, possess.unit ? seenUnits.filter((u) => u !== possess.unit) : seenUnits);
  profiler.lap('health bars (encode)');
  if (hdr) hdrOut.draw(encoder, context.getCurrentTexture()); // (the frame out to the canvas, in extended range)
  profiler.resolve(encoder);
  device.queue.submit([encoder.finish()]);
  // The ore chunks' reflections, for the frames after: the terrain and sky baked round the camera's target now and
  // then (see bakeCube; after the frame's submit, as it shares the terrain's uniforms, and the sky's set for it).
  if (oreEnv.wanted) {
    const [tx, , tz] = camera.target, size = Math.max(32, Math.round(ORE_LOOK.envSize / 32) * 32);
    if (!oreEnv.view || now - oreEnv.at > ORE_LOOK.envEvery * 1000 || Math.hypot(tx - oreEnv.x, tz - oreEnv.z) > 48 || size !== oreEnv.size) {
      const x = clamp(tx, 0, SIZE[0] - 1), z = clamp(tz, 0, SIZE[2] - 1);
      oreEnv.view = renderer.bakeCube([x, terrain.heightAt(Math.floor(x), Math.floor(z)) + ORE_LOOK.envHeight, z], { torch, sun, time: clock, scorch: scorch.uniforms() }, size);
      Object.assign(oreEnv, { at: now, x: tx, z: tz, size });
      oreRenderer.setEnv(oreEnv.view);
    }
  }
  profiler.read();
  profiler.lap('resolve + submit');
  profiler.mode = `${camera.ortho ? 'orthographic' : 'perspective'} · ${canvas.width}×${canvas.height}`;
  profiler.frame(frameStart, now, profPanel, `Terrain built in ${startupMs.toFixed(0)} ms at startup.`);

  fpsFrames++;
  if (now - fpsTime > 500) {
    fps = (fpsFrames * 1000) / (now - fpsTime);
    fpsTime = now;
    fpsFrames = 0;
    const slow = mode.name === 'sandbox' && GAME_SPEED.speed < 1 ? ` · game speed ×${GAME_SPEED.speed.toFixed(1)}` : '';
    stats.textContent = `${fps.toFixed(0)} fps${slow}`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// The world's ready: the main menu's buttons work now (or, set up from the New game screen, the game starts).
for (const b of menu.querySelectorAll('button[data-mode]')) b.disabled = false;
menu.querySelector('.menu-note').textContent = '';
if (setup.start) startGame('new');

// For poking at from the console.
window.game = { terrain, field, camera, brush, minimap, fog, device, profiler, units, water, sky, mode, buildings, events, worldInfo, splashes, get inventory() { return inventory; } };
