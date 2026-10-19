// Rust -> WASM benchmark runner (Node, manual WebAssembly.instantiate, no wasm-pack / wasm-bindgen).
// Build first (from bench/rust):
//   cargo build --release --lib --target wasm32-unknown-unknown --no-default-features
// Usage: node bench/sim_wasm.mjs [S1|S2|S3|all] [--warmup 200] [--steps 2000] [--fields 10]
//
// Each timed step = sim_step() inside WASM + copying px/py out of WASM memory into JS-owned Float32Arrays
// (what a renderer that keeps its own buffers would pay). "step" and "copy" are timed separately, so the
// zero-copy alternative (a Float32Array view straight onto WASM memory, rebuilt if memory grows) is just
// the "step" number. Single-threaded: no wasm threads/SharedArrayBuffer.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM = path.join(HERE, 'rust', 'target', 'wasm32-unknown-unknown', 'release', 'riot_bench.wasm');
const pct = (s, p) => s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))];

async function load() {
  const mod = await WebAssembly.compile(fs.readFileSync(WASM));
  // stub any imports (a plain std cdylib for wasm32-unknown-unknown normally has none)
  const imports = {};
  for (const im of WebAssembly.Module.imports(mod)) {
    imports[im.module] ??= {};
    imports[im.module][im.name] = () => { throw new Error(`wasm import ${im.module}.${im.name} called`); };
  }
  const inst = await WebAssembly.instantiate(mod, imports);
  return inst.exports;
}

async function runScenario(X, name, { warmup = 200, steps = 2000, fields = 10, log = console.log } = {}) {
  const buf = fs.readFileSync(path.join(HERE, 'fixtures', name + '.bin'));
  const p = X.wasm_alloc(buf.length);
  new Uint8Array(X.memory.buffer, p, buf.length).set(buf);
  const sim = X.sim_create(p, buf.length);
  const fieldChecksum = (X.sim_goal_field_checksum(sim) >>> 0).toString(16).padStart(8, '0');
  for (let k = 0; k < 2; k++) X.sim_bench_field(sim);
  let tf = performance.now();
  for (let k = 0; k < fields; k++) X.sim_bench_field(sim);
  const fieldMs = (performance.now() - tf) / fields;

  let na = X.sim_na(sim);
  const outX = new Float32Array(na), outY = new Float32Array(na);
  const copyOut = () => {
    na = X.sim_na(sim);
    outX.set(new Float32Array(X.memory.buffer, X.sim_px(sim), na));
    outY.set(new Float32Array(X.memory.buffer, X.sim_py(sim), na));
  };
  for (let s = 0; s < warmup; s++) { X.sim_step(sim, 0.12); copyOut(); }
  const tStep = new Float64Array(steps), tCopy = new Float64Array(steps);
  for (let s = 0; s < steps; s++) {
    const a = performance.now(); X.sim_step(sim, 0.12);
    const b = performance.now(); copyOut();
    tStep[s] = b - a; tCopy[s] = performance.now() - b;
  }
  const stats = t => { const s = Float64Array.from(t).sort(); return { mean: t.reduce((x, y) => x + y, 0) / t.length, p50: pct(s, 50), p95: pct(s, 95), min: s[0], max: s[s.length - 1] }; };
  const tTot = tStep.map((v, k) => v + tCopy[k]);

  const rp = X.wasm_alloc(64 * 8);
  X.sim_report(sim, rp);
  const r = new Float64Array(X.memory.buffer, rp, 64);
  const nL = r[10];
  const leaders = [];
  for (let k = 0; k < nL; k++) { const b = 11 + k * 6; leaders.push({ count: r[b], x: r[b + 1], y: r[b + 2], prog: r[b + 3], energy: r[b + 4], arrived: !!r[b + 5] }); }
  const res = {
    scenario: name, N: X.sim_na(sim), warmup, steps, fieldMs, fieldChecksum,
    stepMs: stats(tTot), stepOnlyMs: stats(tStep), copyMs: stats(tCopy),
    checksum: { sum: r[0], fnv: (r[1] >>> 0).toString(16).padStart(8, '0') },
    aggregate: { NA: r[2], attached: r[3], idle: r[4], fleeing: r[5], gone: r[6], meanAdvanceAll: r[7], meanAdvanceFollowers: r[8], meanSpeed: r[9], leaders },
  };
  log(`${name} N=${res.N}: field ${fieldMs.toFixed(2)} ms | step+copy mean ${res.stepMs.mean.toFixed(3)} p50 ${res.stepMs.p50.toFixed(3)} p95 ${res.stepMs.p95.toFixed(3)} ms (copy ${res.copyMs.mean.toFixed(4)} ms) | checksum ${res.checksum.sum.toFixed(3)} ${res.checksum.fnv} | followers ${leaders.map(l => l.count).join('/')}`);
  return res;
}

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const which = args.find(a => /^(S\d|all)$/.test(a)) || 'all';
const names = which === 'all' ? ['S1', 'S2', 'S3'] : [which];
const o = { warmup: +opt('--warmup', 200), steps: +opt('--steps', 2000), fields: +opt('--fields', 10) };
if (!fs.existsSync(WASM)) { console.error(`missing ${WASM}\nbuild it: cd bench/rust && cargo build --release --lib --target wasm32-unknown-unknown --no-default-features`); process.exit(1); }
const results = [];
for (const n of names) results.push(await runScenario(await load(), n, o)); // fresh instance per scenario
const out = path.join(HERE, 'results', 'rust_wasm.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ runner: 'rust-wasm', node: process.version, copy: 'per-step copy of px/py into JS Float32Arrays (stepOnlyMs = zero-copy view)', results }, null, 2));
console.log('wrote ' + path.relative(process.cwd(), out));
