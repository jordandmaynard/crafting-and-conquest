// The terrain's signed distance field on the GPU. The voxels (r8uint) and brick distances (r8uint) are uploaded
// from the CPU; a compute shader turns the voxels into signed distances, clamped to ±SDF_RANGE voxels, and packs
// them two half floats to a word into a staging buffer that is copied into an r16float 3D texture the raymarcher
// samples with hardware trilinear filtering. (8-bit distances were too coarse: the lighting showed contour lines.) Edits re-run all of this over just the edited box.
//
// Voxels hold block types, and the surface is halfway between a solid voxel and an empty one. A voxel's distance is
// to the nearest voxel of the opposite kind, less half a step. Next to the surface that's exact along the grid;
// further out it is a close estimate. The renderer draws exact cubes near the surface and only uses this to take
// big steps through empty space (see render.js).

import { SIZE, BLOCK, BRICK, BRICKS, SDF_RANGE, SOLID_MIN, TERRAIN_MIN, HALF, MAX_BLASTS, BLAST_SLOTS } from './terrain.js';

const ROW_BYTES = Math.ceil((SIZE[0] * 2) / 256) * 256; // copyBufferToTexture rows are 256-byte aligned
const SLAB = 50; // z slices per dispatch when building the whole field, so no single submit runs too long

export const SDF_WGSL = /* wgsl */ `
struct Params { origin: vec4u, size: vec4u }
@group(0) @binding(0) var voxels: texture_3d<u32>;
@group(0) @binding(1) var bricks: texture_3d<u32>;
@group(0) @binding(2) var<storage, read_write> field: array<u32>;
@group(0) @binding(3) var<uniform> P: Params;

const DIMS = vec3i(${SIZE[0]}, ${SIZE[1]}, ${SIZE[2]});
const R = ${SDF_RANGE};
const ROW_WORDS = ${ROW_BYTES / 4}u;

// -0.5 inside solid, 0.5 in air.
fn phi(c: vec3i) -> f32 {
  return select(0.5, -0.5, textureLoad(voxels, clamp(c, vec3i(0), DIMS - 1), 0).r >= ${SOLID_MIN}u);
}

// Signed distance at a voxel centre, as a fraction of R.
fn distance01(c: vec3i) -> f32 {
  if (c.x >= DIMS.x) { return 1.0; } // row padding
  let pc = phi(c);
  let s = pc < 0.0;
  let sign = select(1.0, -1.0, s);
  if (textureLoad(bricks, c / ${BRICK}, 0).r != 0u) { return sign; }
  var best = f32(R);
  for (var z = -R; z <= R; z++) {
    for (var y = -R; y <= R; y++) {
      for (var x = -R; x <= R; x++) {
        let len = sqrt(f32(x * x + y * y + z * z));
        if (len - 1.0 >= best) { continue; }
        let pq = phi(c + vec3i(x, y, z));
        if ((pq < 0.0) != s) {
          best = min(best, len - abs(pq) / (abs(pq) + abs(pc)));
        }
      }
    }
  }
  return sign * best / f32(R);
}

@compute @workgroup_size(4, 4, 4)
fn build(@builtin(global_invocation_id) id: vec3u) {
  if (id.x * 4u >= P.size.x || id.y >= P.size.y || id.z >= P.size.z) { return; }
  let c = vec3i(P.origin.xyz) + vec3i(vec3u(id.x * 4u, id.y, id.z));
  var pair = array<f32, 4>();
  for (var i = 0; i < 4; i++) {
    pair[i] = distance01(c + vec3i(i, 0, 0)) * f32(R);
  }
  let row = (u32(c.z) * u32(DIMS.y) + u32(c.y)) * ROW_WORDS + u32(c.x) / 2u;
  field[row] = pack2x16float(vec2f(pair[0], pair[1]));
  field[row + 1u] = pack2x16float(vec2f(pair[2], pair[3]));
}
`;

// The column (x + X * z) of the trunk a leaf voxel at (x, y, z) hangs from, or -1: the nearest log beside it (at its
// height, or one below: an oak's top layer is over its trunk's top) within the 2 voxels an oak's canopy reaches.
const TRUNK_REACH = [];
for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) TRUNK_REACH.push([dx, dz]);
TRUNK_REACH.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
function trunkOf(v, x, y, z) {
  const [X, Y, Z] = SIZE;
  for (const [dx, dz] of TRUNK_REACH) {
    const tx = x + dx, tz = z + dz;
    if (tx < 0 || tz < 0 || tx >= X || tz >= Z) continue;
    const i = tx + X * (y + Y * tz);
    if (v[i] === BLOCK.LOG || (y > 0 && v[i - X] === BLOCK.LOG)) return tx + X * tz;
  }
  return -1;
}

export class TerrainField {
  constructor(device, terrain) {
    this.device = device;
    this.terrain = terrain;
    this.profiler = null; // set by main: times rebuilds after edits
    const [X, Y, Z] = SIZE;
    const tex3 = (label, size, format) => device.createTexture({
      label, size, format, dimension: '3d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.voxelTex = tex3('voxels', SIZE, 'r8uint');
    this.charTex = tex3('char', SIZE, 'r8unorm'); // terrain.char (scorch.js), filtered by the shader
    this.blastCellTex = tex3('blast cells', HALF, 'rgba16uint'); // terrain.blastCells
    this.blastBuffer = device.createBuffer({ // terrain.blastList
      label: 'blasts', size: MAX_BLASTS * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.brickTex = tex3('brick distance', BRICKS, 'r8uint');
    this.sdfTex = tex3('terrain sdf', SIZE, 'r16float');
    this.staging = device.createBuffer({
      label: 'sdf staging',
      size: ROW_BYTES * Y * Z,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.params = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // Fog of war drawn as nothing (fog.js): a byte per column, 0 where the player's never seen it, which goes up as
    // air (so it isn't drawn, casts no shadow and lights nothing); null: every column as it is.
    this.blank = null;
    // And of what's drawn, the columns sent up bare (only the land: no trees or buildings), so nothing standing there
    // hides what's behind it: () => a byte per column, 0 for bare (the player's never-seen); null: none.
    this.bare = null;
    // And the player's view of each column (() => a byte per column, 0 never seen; null: none): a tree's leaves go up
    // as its trunk's column is seen, not their own, so there are no leaves hanging in the air over a trunk not yet
    // seen (and with `bare`, a seen tree's leaves reaching over the never seen stay).
    this.seen = null;
    const module = device.createShaderModule({ label: 'sdf build', code: SDF_WGSL });
    this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'build' } });
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.voxelTex.createView() },
        { binding: 1, resource: this.brickTex.createView() },
        { binding: 2, resource: { buffer: this.staging } },
        { binding: 3, resource: { buffer: this.params } },
      ],
    });
  }

  // Everything, after generation.
  buildAll() {
    const { device } = this;
    if (this.blank) { // (a slab at a time, with the blank columns cleared)
      for (let z = 0; z < SIZE[2]; z += SLAB) this.upload([0, 0, z], [SIZE[0], SIZE[1], Math.min(SIZE[2], z + SLAB)]);
    } else {
      device.queue.writeTexture({ texture: this.voxelTex }, this.terrain.voxels,
        { bytesPerRow: SIZE[0], rowsPerImage: SIZE[1] }, SIZE);
    }
    this.uploadBricks();
    for (let z = 0; z < SIZE[2]; z += SLAB) {
      this.rebuild([0, 0, z], [SIZE[0], SIZE[1], Math.min(SIZE[2], z + SLAB)]);
    }
  }

  // The voxels in [lo, hi) to the GPU (the blank columns as air).
  upload(lo, hi) {
    const [X, Y] = SIZE;
    const w = hi[0] - lo[0], h = hi[1] - lo[1], d = hi[2] - lo[2];
    const box = new Uint8Array(w * h * d);
    const v = this.terrain.voxels, blank = this.blank, bare = blank && this.bare?.(), seen = blank && this.seen?.();
    for (let z = 0; z < d; z++) {
      for (let y = 0; y < h; y++) {
        const src = lo[0] + X * (lo[1] + y + Y * (lo[2] + z));
        box.set(v.subarray(src, src + w), (z * h + y) * w);
      }
      if (!blank) continue;
      const row = (lo[2] + z) * X;
      for (let x = 0; x < w; x++) {
        if (blank[row + lo[0] + x] !== 0) {
          const strip = bare && bare[row + lo[0] + x] === 0;
          if (!strip && !seen) continue;
          for (let y = 0; y < h; y++) {
            const k = (z * h + y) * w + x, b = box[k];
            if (b >= TERRAIN_MIN || b === 0) continue;
            const trunk = seen && b === BLOCK.LEAVES ? trunkOf(v, lo[0] + x, lo[1] + y, lo[2] + z) : -1;
            if (trunk >= 0 ? seen[trunk] === 0 : strip) box[k] = 0;
          }
          continue;
        }
        for (let y = 0; y < h; y++) box[(z * h + y) * w + x] = 0;
      }
    }
    this.device.queue.writeTexture({ texture: this.voxelTex, origin: lo }, box,
      { bytesPerRow: w, rowsPerImage: h }, [w, h, d]);
  }

  // After an edit that changed voxels in [lo, hi).
  update(lo, hi) {
    this.upload(lo, hi);
    this.updateChar(lo, hi); // (blocks put down start clean; a slumped column takes its char down with it)
    this.uploadBricks();
    // Distances change up to SDF_RANGE (+1 for rounding) away from any changed voxel.
    const pad = SDF_RANGE + 1;
    const a = lo.map((v, i) => Math.max(0, v - pad));
    const b = hi.map((v, i) => Math.min(SIZE[i], v + pad));
    this.rebuild(a, b);
  }

  // After the terrain's char changed in [lo, hi).
  updateChar(lo, hi) {
    const [X, Y] = SIZE;
    const w = hi[0] - lo[0], h = hi[1] - lo[1], d = hi[2] - lo[2];
    const box = new Uint8Array(w * h * d);
    const c = this.terrain.char;
    for (let z = 0; z < d; z++) {
      for (let y = 0; y < h; y++) {
        const src = lo[0] + X * (lo[1] + y + Y * (lo[2] + z));
        box.set(c.subarray(src, src + w), (z * h + y) * w);
      }
    }
    this.device.queue.writeTexture({ texture: this.charTex, origin: lo }, box,
      { bytesPerRow: w, rowsPerImage: h }, [w, h, d]);
    // The blasts listed in the half-resolution cells covering the box.
    const [HX, HY] = HALF, S = BLAST_SLOTS;
    const h0 = lo.map((v) => v >> 1), h1 = hi.map((v, i) => Math.min(HALF[i], (v + 1) >> 1));
    const hw = h1[0] - h0[0], hh = h1[1] - h0[1], hd = h1[2] - h0[2];
    const cells = new Uint16Array(hw * hh * hd * S);
    const b = this.terrain.blastCells;
    for (let z = 0; z < hd; z++) {
      for (let y = 0; y < hh; y++) {
        const src = S * (h0[0] + HX * (h0[1] + y + HY * (h0[2] + z)));
        cells.set(b.subarray(src, src + hw * S), (z * hh + y) * hw * S);
      }
    }
    this.device.queue.writeTexture({ texture: this.blastCellTex, origin: h0 }, cells,
      { bytesPerRow: hw * S * 2, rowsPerImage: hh }, [hw, hh, hd]);
  }

  // After blast number `index` was added to terrain.blastList.
  uploadBlast(index) {
    this.device.queue.writeBuffer(this.blastBuffer, index * 32, this.terrain.blastList, index * 8, 8);
  }

  uploadBricks() {
    this.device.queue.writeTexture({ texture: this.brickTex }, this.terrain.brickDist,
      { bytesPerRow: BRICKS[0], rowsPerImage: BRICKS[1] }, BRICKS);
  }

  // Recomputes distances over [lo, hi) and copies them into the sampled texture.
  rebuild(lo, hi) {
    const { device } = this;
    const x0 = Math.floor(lo[0] / 4) * 4;
    const x1 = Math.min(Math.ceil(hi[0] / 4) * 4, Math.ceil(SIZE[0] / 4) * 4);
    const size = [x1 - x0, hi[1] - lo[1], hi[2] - lo[2]];
    device.queue.writeBuffer(this.params, 0, new Uint32Array([x0, lo[1], lo[2], 0, size[0], size[1], size[2], 0]));
    const enc = device.createCommandEncoder({ label: 'sdf rebuild' });
    const pass = enc.beginComputePass({ label: 'sdf rebuild', timestampWrites: this.profiler?.tsw('sdf rebuild (edits)') });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(size[0] / 16), Math.ceil(size[1] / 4), Math.ceil(size[2] / 4));
    pass.end();
    enc.copyBufferToTexture(
      { buffer: this.staging, offset: (lo[2] * SIZE[1] + lo[1]) * ROW_BYTES + x0 * 2, bytesPerRow: ROW_BYTES, rowsPerImage: SIZE[1] },
      { texture: this.sdfTex, origin: [x0, lo[1], lo[2]] },
      [Math.min(size[0], SIZE[0] - x0), size[1], size[2]],
    );
    device.queue.submit([enc.finish()]);
  }
}
