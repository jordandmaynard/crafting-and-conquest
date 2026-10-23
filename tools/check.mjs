// Dev-only checks (need `npm install webgpu` somewhere on the module path). The game itself has no dependencies.
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root = '/opt/pw-browsers';
const icd = readdirSync(root).map((d) => join(root, d, 'chrome-linux', 'vk_swiftshader_icd.json')).find(existsSync);
if (icd) process.env.VK_ICD_FILENAMES = icd;
const { create, globals } = await import('webgpu');
Object.assign(globalThis, globals);
const { SDF_WGSL } = await import('../src/sdf.js');
const { RENDER_WGSL } = await import('../src/render.js');
const { SKYVIS_WGSL, BOUNCE_WGSL } = await import('../src/skyvis.js');
const gpu = create(['backend=vulkan']);
const adapter = await gpu.requestAdapter();
const device = await adapter.requestDevice();
for (const [name, code] of Object.entries({ SDF_WGSL, RENDER_WGSL, SKYVIS_WGSL, BOUNCE_WGSL })) {
  const m = device.createShaderModule({ code });
  const info = await m.getCompilationInfo();
  console.log(name, info.messages.length ? info.messages.map((x) => `${x.type} ${x.lineNum}:${x.linePos} ${x.message}`).join('\n') : 'ok');
}
process.exit(0);
