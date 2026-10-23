// GPU profiling panel (after space-miner's): while it's open, every pass writes GPU timestamps (when the browser
// exposes timestamp-query). Results are read back without stalling (skipped while a readback is in flight) and
// smoothed. Also shows the frame rate, the CPU (JavaScript) time per part of the frame and the GPU the browser
// picked.

const MAX_PASSES = 48;
const SMOOTH = 0.1; // share of each new reading in the running average

export class GpuProfiler {
  constructor(device, adapterInfo) {
    this.device = device;
    this.info = adapterInfo;
    this.mode = ''; // set by main: what's being drawn (smooth or cubes, resolution)
    this.hasTimestamps = device.features.has('timestamp-query');
    this.on = false;
    this.names = [];       // this frame's timed passes, in order
    this.pending = false;  // a readback is in flight
    this.ema = new Map();  // pass name -> smoothed ms
    this.order = [];
    this.cpu = new Map();  // CPU lap name -> smoothed ms
    this.lapT = 0;
    this.frameMs = 16.7;
    this.cpuMs = 0;
    this.lastT = 0;
    this.shown = 0;
    if (this.hasTimestamps) {
      this.qs = device.createQuerySet({ type: 'timestamp', count: MAX_PASSES * 2 });
      this.resolveBuf = device.createBuffer({ size: MAX_PASSES * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      this.readBuf = device.createBuffer({ size: MAX_PASSES * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    }
  }

  get timing() { return this.on && this.hasTimestamps && !this.pending; }

  // timestampWrites for one pass, or undefined when not profiling. Passes sharing a name add up.
  tsw(name) {
    if (!this.timing || this.names.length >= MAX_PASSES) return undefined;
    const i = this.names.length;
    this.names.push(name);
    return { querySet: this.qs, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 };
  }

  // One row for a run of `count` passes: the first writes the start time, the last the end (a pass in the middle
  // gets no timestampWrites at all: WebGPU rejects one with neither index). Returns each pass's timestampWrites.
  chain(name, count) {
    const out = new Array(count).fill(undefined);
    if (!this.timing || this.names.length >= MAX_PASSES || count < 1) return out;
    const i = this.names.length;
    this.names.push(name);
    if (count === 1) return [{ querySet: this.qs, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 }];
    out[0] = { querySet: this.qs, beginningOfPassWriteIndex: i * 2 };
    out[count - 1] = { querySet: this.qs, endOfPassWriteIndex: i * 2 + 1 };
    return out;
  }

  // Before encoder.finish(): copies this frame's timestamps out for reading.
  resolve(encoder) {
    this.frameNames = null;
    const n = this.names.length;
    if (!n) return;
    encoder.resolveQuerySet(this.qs, 0, n * 2, this.resolveBuf, 0);
    encoder.copyBufferToBuffer(this.resolveBuf, 0, this.readBuf, 0, n * 16);
    this.frameNames = this.names;
    this.names = [];
  }

  // After submit.
  read() {
    const names = this.frameNames;
    this.frameNames = null;
    if (!names) return;
    this.pending = true;
    this.readBuf.mapAsync(GPUMapMode.READ, 0, names.length * 16).then(() => {
      const t = new BigInt64Array(this.readBuf.getMappedRange(0, names.length * 16).slice(0));
      this.readBuf.unmap();
      this.pending = false;
      if (!this.on) return;
      const sums = new Map();
      names.forEach((nm, i) => {
        const ms = Math.max(0, Number(t[i * 2 + 1] - t[i * 2]) / 1e6);
        sums.set(nm, (sums.get(nm) ?? 0) + ms);
      });
      // Passes that only run some frames (an SDF rebuild after a brush stroke) count as 0 on frames without them.
      for (const nm of new Set([...this.ema.keys(), ...sums.keys()])) {
        const ms = sums.get(nm) ?? 0, prev = this.ema.get(nm);
        this.ema.set(nm, prev === undefined ? ms : prev + (ms - prev) * SMOOTH);
      }
      for (const nm of sums.keys()) if (!this.order.includes(nm)) this.order.push(nm);
    }, () => { this.pending = false; });
  }

  // CPU side: time since the previous lap (JavaScript only), smoothed. lap(null) just starts the clock.
  lap(name) {
    const t = performance.now();
    if (this.on && name) {
      const ms = t - this.lapT, p = this.cpu.get(name);
      this.cpu.set(name, p === undefined ? ms : p + (ms - p) * SMOOTH);
    }
    this.lapT = t;
  }

  toggle() {
    this.on = !this.on;
    this.ema.clear();
    this.cpu.clear();
    this.order = [];
    this.shown = 0;
    return this.on;
  }

  // Once per frame, at its end: frame rate and CPU time, and the panel's contents 4 times a second.
  frame(frameStart, now, panel, extra) {
    const dt = this.lastT ? now - this.lastT : 16.7;
    this.lastT = now;
    this.frameMs += (dt - this.frameMs) * SMOOTH;
    this.cpuMs += (performance.now() - frameStart - this.cpuMs) * SMOOTH;
    if (!this.on || now - this.shown < 250) return;
    this.shown = now;
    const table = (head, unit, rows, sumLabel, sum) => {
      const max = Math.max(0.001, ...rows.map((r) => r[1]));
      return `<table><tr><th>${head}</th><th>${unit}</th><th></th></tr>` +
        rows.map(([nm, ms]) => `<tr><td>${nm}</td><td><b>${ms.toFixed(2)}</b></td><td class="ptrack"><span class="pbar" style="width:${(ms / max * 100).toFixed(1)}%"></span></td></tr>`).join('') +
        `<tr class="gsum"><td>${sumLabel}</td><td><b>${sum.toFixed(2)}</b></td><td></td></tr></table>`;
    };
    const rows = this.order.map((nm) => [nm, this.ema.get(nm) || 0]);
    const gpuTotal = rows.reduce((a, r) => a + r[1], 0);
    const i = this.info ?? {};
    const gpuName = [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' · ') || 'not reported by the browser';
    panel.innerHTML =
      `<div class="ptitle">${(1000 / this.frameMs).toFixed(0)} fps · ${this.frameMs.toFixed(1)} ms/frame</div>` +
      `<div class="gpu-name">GPU: ${gpuName}${i.isFallbackAdapter ? ' (software fallback)' : ''}</div>` +
      `<div class="gpu-name">Drawing: ${this.mode}</div>` +
      (this.hasTimestamps
        ? table('GPU pass', 'GPU ms', rows, 'All passes', gpuTotal)
        : `<div class="gnote">This browser doesn't expose GPU timestamps (timestamp-query), so only frame timing is shown.</div>`) +
      table('CPU (JavaScript)', 'CPU ms', [...this.cpu], 'All CPU', this.cpuMs) +
      `<div class="gnote">${extra}` +
      (this.hasTimestamps ? ' Chrome rounds GPU times to 0.1 ms unless chrome://flags "WebGPU Developer Features" is on.' : '') + '</div>';
  }
}
