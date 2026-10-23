// Renders one frame of the game offscreen (terrain, trees, sky and a few villagers of each class) in Node with Dawn +
// SwiftShader, to a PNG. Needs `npm install webgpu` on the module path. One frame per process.
// usage: [TOON=1] [TIME=10] [W=960 H=540] [CAM='{"yaw":..,"pitch":..,"distance":..}'] node tools/frame.mjs out.png
import { readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';
const root = '/opt/pw-browsers';
process.env.VK_ICD_FILENAMES = readdirSync(root).map((d) => join(root, d, 'chrome-linux', 'vk_swiftshader_icd.json')).find(existsSync);
const { create, globals } = await import('webgpu');
Object.assign(globalThis, globals);
globalThis.document = { baseURI: 'http://x/' };
const G = new URL('../src/', import.meta.url).href;
const { decodePng } = await import(new URL('./png.mjs', import.meta.url).href);
const { Terrain } = await import(G + 'terrain.js');
const { TerrainField } = await import(G + 'sdf.js');
const { TerrainRenderer, DEPTH_FORMAT, TOON_TUNING } = await import(G + 'render.js');
const { createTerrainTextures, TEXTURE_FILES, NORMAL_FILES, FLAT_NORMAL } = await import(G + 'textures.js');
const { Camera, CAMERA_TUNING } = await import(G + 'camera.js');
const { Units, CLASSES } = await import(G + 'units.js');
const { UnitRenderer } = await import(G + 'units-render.js');
const { Sky, SKY_TUNING } = await import(G + 'sky.js');
SKY_TUNING.timeOfDay = +(process.env.TIME ?? 10); // hours
const { plantTrees } = await import(G + 'trees.js');
const gpu = create(['backend=vulkan']);
const adapter = await gpu.requestAdapter();
const device = await adapter.requestDevice();
const errors = [];
device.addEventListener?.('uncapturederror', (e) => errors.push(e.error.message));
const W = +process.env.W || 960, H = +process.env.H || 540;
TOON_TUNING.on = +(process.env.TOON ?? 0);
Object.assign(TOON_TUNING, JSON.parse(process.env.TOONSET || '{}'));
const terrain = new Terrain(); terrain.generate(7); plantTrees(terrain, 7);
const field = new TerrainField(device, terrain); field.buildAll();
const base = new URL('../', import.meta.url).pathname;
const albedo = createTerrainTextures(device, TEXTURE_FILES.map((f) => decodePng(base + f)));
const normals = createTerrainTextures(device, NORMAL_FILES.map((f) => (f ? decodePng(base + f) : FLAT_NORMAL)), true);
const sky = new Sky(device);
const fmt = 'rgba8unorm-srgb';
const { SkyVisibility, GI_TUNING } = await import(G + 'skyvis.js');
if (process.env.GI) GI_TUNING.on = +process.env.GI;
const skyVis = new SkyVisibility(device, field, albedo, sky); skyVis.buildAll();
const renderer = new TerrainRenderer(device, fmt, field, albedo, sky, normals, skyVis);
renderer.resize(W, H);
const unitR = new UnitRenderer(device, fmt, DEPTH_FORMAT, sky);
const units = new Units(terrain);
const cam = new Camera(); cam.aspect = W / H;
Object.assign(cam, JSON.parse(process.env.CAM || '{"distance": 14}'));
const [cx, cz] = [cam.target[0] | 0, cam.target[2] | 0];
CLASSES.forEach((k, i) => { const u = units.spawn(cx - 3 + i, cz + (i % 2), undefined, i % 2 ? 'red' : 'blue', k); if (u) u.yaw = 0.4; });
cam.target[1] = terrain.heightAt(cx, cz) + 1;
const m = cam.matrices();
const pixel = cam.ortho ? 2 * m.halfH / H : 2 * Math.tan(CAMERA_TUNING.fov / 2) / H;
const target = device.createTexture({ size: [W, H], format: fmt, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
const skyEnc = device.createCommandEncoder();
sky.update(skyEnc, { dt: 0, eye: m.eye });
device.queue.submit([skyEnc.finish()]);
skyVis.tick({ light: sky.light, torch: [0, 0, 0, 1], flames: [], target: cam.target }); // (GI env: its mode)
const enc = device.createCommandEncoder();
renderer.draw(enc, target.createView(), {
  invViewProj: m.invViewProj, viewProj: m.viewProj, camPos: m.eye, ortho: cam.ortho, sun: sky.light, torch: [0, 0, 0, 1],
  brush: [0, 0, 0, 0], brushColor: [0, 0, 0, 0], pixel, fogStart: cam.ortho ? 250 : cam.distance, time: 0, marks: units.marks(256, [], false),
});
unitR.draw(enc, target.createView(), renderer.depthView, m.viewProj, sky.light, units.parts(0), null, [], [0, 0, 0, 1], [], {
  eye: m.eye, ahead: [-m.view[2], -m.view[6], -m.view[10]], ortho: cam.ortho, pixel,
});
const bpr = Math.ceil(W * 4 / 256) * 256;
const read = device.createBuffer({ size: bpr * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
enc.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow: bpr }, [W, H]);
device.queue.submit([enc.finish()]);
await read.mapAsync(GPUMapMode.READ);
if (errors.length) console.log('GPU errors:\n' + errors.join('\n'));
const px = new Uint8Array(read.getMappedRange());
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) raw[y * (W * 3 + 1) + 1 + x * 3 + c] = px[y * bpr + x * 4 + c];
const crc = (b) => { let c, r = 0xffffffff; for (let n = 0; n < b.length; n++) { c = (r ^ b[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; r = (r >>> 8) ^ c; } return (r ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(process.argv[2], Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote', process.argv[2]);
process.exit(0);
