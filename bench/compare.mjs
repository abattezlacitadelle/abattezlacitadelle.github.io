// Prints the results table (ms/step + speedup vs JS) and the JS-vs-Rust agreement check from bench/results/*.json.
// Usage: node bench/compare.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const R = path.join(path.dirname(fileURLToPath(import.meta.url)), 'results');
const load = f => { try { return JSON.parse(fs.readFileSync(path.join(R, f), 'utf8')); } catch { return null; } };
const js = load('js.json'), nat = load('rust_native.json'), wasm = load('rust_wasm.json');
if (!js) { console.error('no results/js.json: run node bench/sim_js.mjs first'); process.exit(1); }

const cols = [['JS (Node)', s => js.results.find(r => r.scenario === s)]];
if (nat) {
  cols.push(['Rust native seq, 1 thread', s => nat.results.find(r => r.scenario === s && r.mode === 'seq')]);
  cols.push(['Rust native 2-phase, 1 thread', s => nat.results.find(r => r.scenario === s && r.mode === '2p1')]);
  cols.push([`Rust native 2-phase, MULTITHREADED ${nat.threads} threads (${nat.pool || "rayon"})`, s => nat.results.find(r => r.scenario === s && r.mode === '2pmt')]);
}
if (wasm) cols.push(['Rust WASM (Node, incl. copy)', s => wasm.results.find(r => r.scenario === s)]);

const scen = js.results.map(r => r.scenario);
const cell = (r, base, key = 'stepMs') => r ? `${r[key].mean.toFixed(2)} (p50 ${r[key].p50.toFixed(2)}, p95 ${r[key].p95.toFixed(2)})${base && r !== base ? ` **${(base[key].mean / r[key].mean).toFixed(2)}x**` : ''}` : 'n/a';
const lines = [];
lines.push('| Scenario | ' + cols.map(c => c[0]).join(' | ') + ' |');
lines.push('|---|' + cols.map(() => '---').join('|') + '|');
for (const s of scen) {
  const base = cols[0][1](s);
  lines.push(`| ${s} (${base.N} agents) ms/step | ` + cols.map(([, f]) => cell(f(s), base)).join(' | ') + ' |');
}
const fb = cols[0][1]('S1');
lines.push('| Flow field (Dial), ms | ' + cols.map(([, f]) => { const r = f('S1'); return r ? `${r.fieldMs.toFixed(2)}${r !== fb ? ` **${(fb.fieldMs / r.fieldMs).toFixed(2)}x**` : ''}` : 'n/a'; }).join(' | ') + ' |');
console.log(lines.join('\n'));

// ---- agreement ----
console.log('\nAgreement vs JS after warmup+steps (aggregate stats):');
for (const [name, f] of cols.slice(1)) {
  for (const s of scen) {
    const a = cols[0][1](s), b = f(s); if (!b) continue;
    const A = a.aggregate, B = b.aggregate;
    const rel = (x, y) => (Math.abs(x - y) / Math.max(1e-9, Math.abs(x)) * 100).toFixed(2) + '%';
    const cnt = A.leaders.map((l, k) => `${l.count}/${B.leaders[k].count}`).join(' ');
    const lpos = A.leaders.map((l, k) => Math.hypot(l.x - B.leaders[k].x, l.y - B.leaders[k].y).toFixed(2)).join(' '); // JS rounds leader x/y to 0.01 m in its JSON
    console.log(`  ${name} ${s}: fieldChecksum ${a.fieldChecksum === b.fieldChecksum ? 'IDENTICAL' : 'DIFFERENT'}; positions ${a.checksum.fnv === b.checksum.fnv ? 'BIT-IDENTICAL' : 'diverged'};` +
      ` followers JS/Rust ${cnt}; attached ${A.attached}/${B.attached} (${rel(A.attached, B.attached)});` +
      ` meanAdvanceFollowers ${A.meanAdvanceFollowers.toFixed(2)}/${B.meanAdvanceFollowers.toFixed(2)} m (${rel(A.meanAdvanceFollowers, B.meanAdvanceFollowers)});` +
      ` meanAdvanceAll ${rel(A.meanAdvanceAll, B.meanAdvanceAll)}; meanSpeed ${rel(A.meanSpeed, B.meanSpeed)}; leader position gap (m) ${lpos}`);
  }
}
