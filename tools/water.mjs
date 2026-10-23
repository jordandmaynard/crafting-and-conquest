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
const { Units } = await import(G + 'units.js');
const { UnitRenderer } = await import(G + 'units-render.js');
const { DEPTH_FORMAT } = await import(G + 'render.js');
const { Water } = await import(G + 'water.js');
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
device.pushErrorScope('validation');
const renderer = new TerrainRenderer(device, fmt, field, albedo);
renderer.resize(W, H);
const unitR = new UnitRenderer(device, fmt, DEPTH_FORMAT);
const water = process.env.NOWATER ? null : new Water(device, fmt, DEPTH_FORMAT, field);
water?.resize(W, H, renderer.gbuf);
const units = new Units(terrain);
for (const [x, z, sel] of JSON.parse(process.env.UNITS || '[]')) { const u = units.spawn(x, z); if (u) u.selected = !!sel; }
if (process.env.ORDER) { const [x, z] = JSON.parse(process.env.ORDER); units.order([x, terrain.heightAt(x, z), z], [0, 1, 0]); for (let i = 0; i < +(process.env.STEPS || 0); i++) units.update(1 / 30); }
const cams = process.env.CAMS ? JSON.parse(process.env.CAMS) : [JSON.parse(process.env.CAM || '{}')];
for (let ci = 0; ci < cams.length; ci++) {
const camSpec = cams[ci];
const cam = new Camera(); cam.aspect = W / H;
Object.assign(cam, camSpec);
cam.target[1] = terrain.heightAt(cam.target[0], cam.target[2]);
const m = cam.matrices();
const target = device.createTexture({ size: [W, H], format: fmt, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
const bpr = Math.ceil(W * 4 / 256) * 256;
const read = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
const SUNV = (() => { const s = JSON.parse(process.env.SUN || '[0.6,0.55,0.3]'); const l = Math.hypot(...s); return s.map((v) => v / l); })();
const frameW = { dt: 1 / 30, eye: m.eye, viewProj: m.viewProj, invViewProj: m.invViewProj, ortho: cam.ortho, sun: SUNV, pixel: cam.ortho ? 2 * m.halfH / H : 2 * Math.tan(CAMERA_TUNING.fov / 2) / H, fogStart: cam.ortho ? 250 : cam.distance, cubes: !!process.env.CUBES };
if (water && ci === 0) { water.time = +(process.env.T || 20); for (let i = 0; i < +(process.env.WARM || 0); i++) { const e = device.createCommandEncoder(); water.draw(e, target, renderer.depthView, frameW); device.queue.submit([e.finish()]); } await device.queue.onSubmittedWorkDone(); }
const enc = device.createCommandEncoder();
const brush = JSON.parse(process.env.BRUSH || '[0,0,0,0]'); if (brush[1] === null) brush[1] = terrain.heightAt(brush[0], brush[2]);
renderer.draw(enc, target.createView(), {
  invViewProj: m.invViewProj, camPos: m.eye, ortho: cam.ortho, sun: (() => { const s = JSON.parse(process.env.SUN || '[0.6,0.55,0.3]'); const l = Math.hypot(...s); return s.map((v) => v / l); })(),
  brush, brushColor: [0.55, 1, 0.6, 1], pixel: cam.ortho ? 2 * m.halfH / H : 2 * Math.tan(CAMERA_TUNING.fov / 2) / H,
  fogStart: cam.ortho ? 250 : cam.distance, time: 0, cubes: !!process.env.CUBES, viewProj: m.viewProj, marks: units.marks(256),
});
unitR.draw(enc, target.createView(), renderer.depthView, m.viewProj, [0.6, 0.55, 0.3].map((v) => v / Math.hypot(0.6, 0.55, 0.3)), units.parts());
if (water) water.draw(enc, target, renderer.depthView, { ...frameW, dt: 0 });
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
let bright = 0; for (let i = 0; i < W * H; i++) { const r = px[(Math.floor(i / W)) * bpr + (i % W) * 4], g = px[(Math.floor(i / W)) * bpr + (i % W) * 4 + 1]; if (r > 140 && g > 150) bright++; }
console.log('cam', JSON.stringify(camSpec), 'bright', bright);
if (!process.env.NOPNG) writeFileSync(process.argv[2].replace('.png', `_${ci}.png`), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
const verr = await device.popErrorScope(); if (verr) console.log("VALIDATION", verr.message); device.pushErrorScope("validation");
read.unmap(); read.destroy(); target.destroy(); await device.queue.onSubmittedWorkDone();
}
process.exit(0);
