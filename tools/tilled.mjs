// Placeholder tilled-soil textures (128², tileable) for a farm's top (see src/farm.js), for Jordan to repaint:
// textures/tilled.png is plain dirt (textures/dirt.png a little darker, no rows in it), and textures/tilled-normal.png
// is only the rows: ROWS soft, rounded ridges running along u (across the image), with no clods or grit, so the rows
// come from the lighting alone. The wheat stands on the ridges' crests, at (r + 0.5) / ROWS down the image, so keep
// ROWS in step with farm.js.
// usage: node tools/tilled.mjs [out dir (default textures/)]
import zlib from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { decodePng } from './png.mjs';

const N = 128, ROWS = 3, STRENGTH = 9, DARKEN = 0.86;
const dir = process.argv[2] ?? new URL('../textures', import.meta.url).pathname;

// Albedo: the dirt, darker (freshly turned soil).
const dirt = decodePng(new URL('../textures/dirt.png', import.meta.url).pathname);
const rgba = new Uint8Array(N * N * 4);
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const s = ((y % dirt.height) * dirt.width + (x % dirt.width)) * 4, i = (y * N + x) * 4;
  for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(dirt.data[s + c] * DARKEN);
  rgba[i + 3] = 255;
}

// Normal map (OpenGL: green up the image) from the rows' height: a sine across the rows, crests at (r + 0.5) / ROWS.
const height = (y) => 0.5 - 0.5 * Math.cos(2 * Math.PI * ROWS * y / N);
const nrm = new Uint8Array(N * N * 4);
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const dyDown = (height(y + 1) - height(y - 1)) * 0.5;
  const nx = 0, ny = dyDown * STRENGTH, nz = 1;
  const l = Math.hypot(nx, ny, nz);
  const i = (y * N + x) * 4;
  nrm[i] = Math.round((nx / l * 0.5 + 0.5) * 255);
  nrm[i + 1] = Math.round((ny / l * 0.5 + 0.5) * 255);
  nrm[i + 2] = Math.round((nz / l * 0.5 + 0.5) * 255);
  nrm[i + 3] = 255;
}

function png(data) {
  const raw = Buffer.alloc(N * (N * 4 + 1));
  for (let y = 0; y < N; y++) Buffer.from(data.buffer, y * N * 4, N * 4).copy(raw, y * (N * 4 + 1) + 1);
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = table[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(type), d]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
writeFileSync(`${dir}/tilled.png`, png(rgba));
writeFileSync(`${dir}/tilled-normal.png`, png(nrm));
