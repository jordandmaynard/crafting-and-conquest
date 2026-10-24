// Commands: every order a player gives (units sent somewhere, an attack, Mine and Fill marks, a building placed, a
// unit trained...) as plain data, applied through one function for the team that gave it. The clicks at this screen
// go through it like anyone's would, so an order that comes from another computer later (online play) is checked and
// carried out exactly the same way, and a computer opponent can play its team by giving the same commands.
//
// A command is { k: its kind, ...its fields } (KINDS lists each kind's fields). check(cmd) says whether it's well
// formed: every field there and of the right type, every number finite and on the map, every list a sane length, as
// if it came from somewhere that can't be trusted. Commands.apply(team, cmd) checks it and runs its handler for that
// team; a handler says how it went: { ok: true, sound } or { ok: false, why } (for the screen to say, or not).
//
// What a handler may do is up to it (main.js): it gets only the team and the command, and checks against the game
// (that the units are the team's, that the building fits, that the inventory has what it costs).

import { SIZE } from './terrain.js';

export const COMMAND_LIMITS = {
  units: 500,     // units one command can name
  voxels: 250000, // voxels (or cells) one command can name (a Mine or Fill box)
  index: 16,      // a training queue's places
};

const [X, Y, Z] = SIZE;
const int = (v) => Number.isInteger(v);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const inMap = (x, y, z) => int(x) && int(y) && int(z) && x >= 0 && y >= 0 && z >= 0 && x < X && y < Y && z < Z;

// Field types: each a test of the value.
const TYPES = {
  bool: (v) => v === undefined || typeof v === 'boolean',
  id: (v) => int(v) && v > 0,
  ids: (v) => Array.isArray(v) && v.length <= COMMAND_LIMITS.units && v.every((i) => int(i) && i > 0),
  // A voxel ([x, y, z], on the map), and a list of them.
  cell: (v) => Array.isArray(v) && v.length === 3 && inMap(...v),
  cells: (v) => Array.isArray(v) && v.length <= COMMAND_LIMITS.voxels && v.every((c) => Array.isArray(c) && c.length === 3 && inMap(...c)),
  // A column ([x, z], on the map).
  column: (v) => Array.isArray(v) && v.length === 2 && inMap(v[0], 0, v[1]),
  height: (v) => int(v) && v >= 0 && v < Y,
  // Where a click met the ground (a raycast's point, on or just off the map) and the face's normal.
  point: (v) => Array.isArray(v) && v.length === 3 && v.every(num) && v[0] >= -1 && v[0] <= X + 1 && v[1] >= -1 && v[1] <= Y + 1 && v[2] >= -1 && v[2] <= Z + 1,
  normal: (v) => Array.isArray(v) && v.length === 3 && v.every((c) => num(c) && Math.abs(c) <= 1),
  facing: (v) => int(v) && v >= 0 && v < 4,
  radius: (v) => int(v) && v >= 1 && v <= 128,
  index: (v) => int(v) && v >= 0 && v < COMMAND_LIMITS.index,
  block: (v) => int(v) && v > 0 && v < 256,
  // A name from a table (a building's key, a saved design's too, a unit's kind, a Priority): looked up by the handler.
  name: (v) => typeof v === 'string' && /^[a-zA-Z][\w:-]{0,39}$/.test(v),
};

// Each kind's fields and their types.
export const KINDS = {
  // Units (by id): to a point (attack-moving with amove), at an enemy, on patrol, stopped, or a worker's Priority.
  move: { units: 'ids', point: 'point', normal: 'normal', amove: 'bool', queued: 'bool' },
  attack: { units: 'ids', target: 'id' },
  patrol: { units: 'ids', point: 'point', normal: 'normal', queued: 'bool' },
  stop: { units: 'ids' },
  spec: { units: 'ids', spec: 'name' },
  // The open orders workers take on: Mine marks (veins: each ore's whole vein, each tree's forest) and taking them
  // off, Fill marks of a block, farms to till, a Wall line, a building, a torch, a portcullis, and Delete's clearing.
  mine: { voxels: 'cells', veins: 'bool' },
  unmine: { voxels: 'cells', veins: 'bool' },
  fill: { voxels: 'cells', block: 'block' },
  farm: { cells: 'cells' },
  wall: { a: 'column', b: 'column', y: 'height', block: 'block' },
  build: { key: 'name', cell: 'cell', facing: 'facing' },
  torch: { point: 'point', normal: 'normal' },
  gate: { point: 'point', normal: 'normal' },
  clear: { point: 'point', normal: 'normal', radius: 'radius' },
  // A building's (by id): a unit trained, one in its queue called off, a rally waypoint, its waypoints cleared.
  train: { building: 'id', kind: 'name' },
  untrain: { building: 'id', index: 'index' },
  rally: { building: 'id', point: 'point', normal: 'normal', amove: 'bool', queued: 'bool' },
  unrally: { building: 'id' },
};

// Whether cmd is a well-formed command: an object of a known kind with exactly its fields, each of its type.
export function check(cmd) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return false;
  const fields = KINDS[cmd.k];
  if (!fields || !Object.hasOwn(KINDS, cmd.k)) return false;
  for (const key of Object.keys(cmd)) if (key !== 'k' && !Object.hasOwn(fields, key)) return false;
  for (const [key, type] of Object.entries(fields)) if (!TYPES[type](cmd[key])) return false;
  return true;
}

export class Commands {
  constructor() {
    this.handlers = new Map(); // kind -> (team, cmd) => { ok, why?, sound? }
    this.onApply = null;       // (team, cmd, result) => void, after each (a log, or sending it on)
  }

  on(kind, handler) {
    if (!KINDS[kind]) throw new Error(`No command kind ${kind}`);
    this.handlers.set(kind, handler);
  }

  // Carries out cmd for team, if it's well formed: how it went.
  apply(team, cmd) {
    const handler = check(cmd) && this.handlers.get(cmd.k);
    const result = handler ? handler(team, cmd) ?? { ok: true } : { ok: false, why: null };
    this.onApply?.(team, cmd, result);
    return result;
  }
}
