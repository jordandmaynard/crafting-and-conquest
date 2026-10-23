// Renders one frame of the game offscreen in Node (Dawn + SwiftShader) and writes a PNG.
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';
const root = '/opt/pw-browsers';
process.env.VK_ICD_FILENAMES = readdirSync(root).map((d) => join(root, d, 'chrome-linux', 'vk_swiftshader_icd.json')).find(existsSync);
const { create, globals } = await import('webgpu');
Object.assign(globalThis, globals);
const G = new URL('../src/', import.meta.url).href;
const { Terrain } = await import(G + 'terrain.js');
const { TerrainField } = await import(G + 'sdf.js');
const { TerrainRenderer } = await import(G + 'render.js');
const { createTerrainTextures } = await import(G + 'textures.js');
const { Camera, CAMERA_TUNING } = await import(G + 'camera.js');
const gpu = create(['backend=vulkan']);
const adapter = await gpu.requestAdapter();
const device = await adapter.requestDevice();
device.addEventListener?.('uncapturederror', (e) => console.error('GPU', e.error.message));
const W = +process.env.W || 640, H = +process.env.H || 400;
let t = performance.now();
const terrain = new Terrain(); terrain.generate(7);
console.log('gen', (performance.now() - t) | 0); t = performance.now();
const field = new TerrainField(device, terrain); field.buildAll();
await device.queue.onSubmittedWorkDone();
console.log('sdf', (performance.now() - t) | 0); t = performance.now();
const edits = JSON.parse(process.env.EDITS || '[]');
for (let [x, y, z, r, add] of edits) { if (y === null) y = terrain.heightAt(x, z); const c = terrain.applySphere([x, y, z], r, add); if (c) field.update(c.lo, c.hi); }
const albedo = createTerrainTextures(device);
const fmt = 'rgba8unorm-srgb';
const renderer = new TerrainRenderer(device, fmt, field, albedo);
const cam = new Camera(); cam.aspect = W / H;
Object.assign(cam, JSON.parse(process.env.CAM || '{}'));
cam.target[1] = terrain.heightAt(cam.target[0], cam.target[2]);
const m = cam.matrices();
const target = device.createTexture({ size: [W, H], format: fmt, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
const bpr = Math.ceil(W * 4 / 256) * 256;
const read = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
const enc = device.createCommandEncoder();
const brush = JSON.parse(process.env.BRUSH || '[0,0,0,0]'); if (brush[1] === null) brush[1] = terrain.heightAt(brush[0], brush[2]);
renderer.draw(enc, target.createView(), {
  invViewProj: m.invViewProj, camPos: m.eye, ortho: cam.ortho, sun: [0.55, 0.75, 0.35].map((v) => v / Math.hypot(0.55, 0.75, 0.35)),
  brush, brushColor: [0.55, 1, 0.6, 1], pixel: cam.ortho ? 2 * m.halfH / H : 2 * Math.tan(CAMERA_TUNING.fov / 2) / H,
  fogStart: cam.ortho ? 250 : cam.distance, time: 0, cubes: !!process.env.CUBES,
});
enc.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow: bpr }, [W, H]);
device.queue.submit([enc.finish()]);
await read.mapAsync(GPUMapMode.READ);
console.log('render', (performance.now() - t) | 0);
const px = new Uint8Array(read.getMappedRange());
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) raw[y * (W * 3 + 1) + 1 + x * 3 + c] = px[y * bpr + x * 4 + c]; }
const crc = (b) => { let c, crc = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(process.argv[2], Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
process.exit(0);
