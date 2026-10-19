// node playtest/perf.mjs <strategy> <seed> <startDay> <crowd> <hour>: play to <hour>, then time each system over 600 steps
import { makeSim } from '../tools/nodesim.mjs';
import { createBot } from '../tools/bot.js';
const [strat = 'reckless', seed = '1', sd = '5', crowd = '2200', hour = '8.3'] = process.argv.slice(2);
const sim = makeSim('small', +seed); sim.initScenario(); if (+sd > 1) sim.api.daySetDay(+sd, +crowd);
const bot = createBot(sim, strat, { seed: +seed });
bot.briefing(); sim.api.dayStart(); bot.dayStarted();
let acc = 0;
while (sim.day.phase === 'day' && sim.day.t < +hour * 3600) { sim.step(0.12); acc += 0.12; if (acc >= 5) { acc = 0; bot.tick(5); } }
const T = {}; for (const s of sim.systems) { const u = s.update; s.update = (dt, sm) => { const t0 = performance.now(); u(dt, sm); T[s.name] = (T[s.name] || 0) + performance.now() - t0; }; }
let hashT = 0; const bh = sim.buildHash;
const t0 = performance.now(); const N = 600;
for (let k = 0; k < N; k++) { sim.step(0.12); acc += 0.12; if (acc >= 5) { acc = 0; bot.tick(5); } }
const tot = performance.now() - t0;
console.log(`t=${(sim.day.t / 3600).toFixed(2)} NA=${sim.NA} squads=${sim.squads.length} step ${(tot / N).toFixed(2)} ms:`, Object.entries(T).map(([k, v]) => `${k} ${(v / N).toFixed(2)}`).join(' '), 'police prof', JSON.stringify(Object.fromEntries(Object.entries(sim.police.prof).map(([k, v]) => [k, +(v).toFixed(0)]))));
{ sim.buildHash(); let tot = 0, mx = 0, hist = new Array(12).fill(0), scanned = 0;
  for (let i = 0; i < sim.NA; i++) { let n = 0; sim.forEachNear(sim.px[i], sim.py[i], 1.5, () => { n++; }); tot += n; mx = Math.max(mx, n); hist[Math.min(11, Math.floor(n / 5))]++; }
  // bucket occupancy
  let occ = 0, maxB = 0; for (let k = 0; k < (1 << 15); k++) { const c = sim.hStart[k + 1] - sim.hStart[k]; if (c) occ++; if (c > maxB) maxB = c; }
  console.log('avg neighbours within 1.5 m', (tot / sim.NA).toFixed(1), 'max', mx, 'hist/5', hist.join(','), 'buckets used', occ, 'max bucket', maxB); }
