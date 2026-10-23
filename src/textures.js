// Terrain albedo: Jordan's painted 128² textures (textures/*.png) in one texture array with a full mip chain,
// averaged in linear light so the mips don't darken. Layers: 0 grass (tops), 1 dirt (sides and below),
// 2 sand (beaches and under the water), 3 the fringe of grass laid over the dirt below a grass top (by its alpha),
// 4 bark (the sides of logs), 5 rings (their cut ends), 6 leaves (whose alpha marks the gaps between them),
// 7 stone (every face of a stone block), 8 planks and 9 stone bricks (what villagers build), 10 tilled soil (a farm's
// top: its rows are in the normal map, running along u, see farm.js).
// Each has an OpenGL-style normal map (textures/*-normal.png: green up the image) in a second array, layer for layer,
// but the trees' (bark, rings, leaves), which are flat (see NO_NORMALS). The normal maps have one more layer after
// those, 11: ripples, laid over sand's tops at a scale of their own (RENDER_TUNING's ripples in render.js).

export const TEX_SIZE = 128;
export const LAYERS = ['grass', 'dirt', 'sand', 'fringe', 'bark', 'rings', 'leaves', 'stone', 'plank', 'brick', 'tilled'];
export const TEXTURE_FILES = LAYERS.map((name) => `textures/${name}.png`);
const NO_NORMALS = new Set(['bark', 'rings', 'leaves']);
export const NORMAL_FILES = [...LAYERS.map((name) => (NO_NORMALS.has(name) ? null : `textures/${name}-normal.png`)),
  'textures/ripples-normal.png'];
// A layer with no normal map file: flat (straight out of the surface).
export const FLAT_NORMAL = { width: 1, height: 1, data: new Uint8Array([128, 128, 255, 255]) };

// Decodes the texture files (in the browser) to { width, height, data: RGBA bytes }.
export async function loadTerrainImages(files = TEXTURE_FILES, baseUrl = document.baseURI) {
  return Promise.all(files.map(async (file) => {
    if (!file) return FLAT_NORMAL;
    const res = await fetch(new URL(file, baseUrl));
    if (!res.ok) throw new Error(`Couldn't load ${file} (${res.status})`);
    const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, data: new Uint8Array(data.buffer) };
  }));
}

// normals: the images are normal maps, so they're stored and averaged as they are rather than as sRGB colour.
export function createTerrainTextures(device, images, normals = false) {
  const levels = Math.log2(TEX_SIZE) + 1;
  const texture = device.createTexture({
    label: normals ? 'terrain normals' : 'terrain albedo',
    size: [TEX_SIZE, TEX_SIZE, images.length],
    format: normals ? 'rgba8unorm' : 'rgba8unorm-srgb',
    mipLevelCount: levels,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  images.forEach((image, layer) => {
    let img = resize(image, TEX_SIZE);
    let size = TEX_SIZE;
    for (let level = 0; level < levels; level++) {
      device.queue.writeTexture(
        { texture, mipLevel: level, origin: [0, 0, layer] },
        img, { bytesPerRow: size * 4 }, [size, size, 1],
      );
      if (size > 1) img = downsample(img, size, normals);
      size = Math.max(1, size >> 1);
    }
  });
  return texture;
}

// Nearest-neighbour resample to size², for a texture that isn't TEX_SIZE already.
function resize({ width, height, data }, size) {
  if (width === size && height === size) return data;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (Math.floor(y * height / size) * width + Math.floor(x * width / size)) * 4;
      out.set(data.subarray(s, s + 4), (y * size + x) * 4);
    }
  }
  return out;
}

const toLinear = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const toSrgb = (l) => Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055));

// 2×2 box filter, in linear light for colour (unless linear: the bytes are averaged as they are).
function downsample(img, size, linear) {
  const half = size >> 1;
  const out = new Uint8Array(half * half * 4);
  for (let y = 0; y < half; y++) {
    for (let x = 0; x < half; x++) {
      const i = ((2 * y) * size + 2 * x) * 4;
      const o = (y * half + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = img[i + c], b = img[i + 4 + c], d = img[i + size * 4 + c], e = img[i + size * 4 + 4 + c];
        out[o + c] = c === 3 || linear
          ? Math.round((a + b + d + e) / 4)
          : toSrgb((toLinear[a] + toLinear[b] + toLinear[d] + toLinear[e]) / 4);
      }
    }
  }
  return out;
}
