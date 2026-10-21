// debug: node playtest/losstrace.mjs <strategy> <seed> <fromHour> <untilHour> [startDay] [crowd]: why do marchers leave their leader?
import { makeSim } from '../tools/nodesim.mjs';
import { createBot } from '../tools/bot.js';
import { ACT } from '../src/common.js';
const [strat = 'passive', seed = '1', h0 = '11', h1 = '12', sd = '1', crowd = ''] = process.argv.slice(2);
const sim = makeSim('small', +seed); sim.initScenario(); if (+sd > 1) sim.api.daySetDay(+sd, crowd ? +crowd : undefined);
const bot = createBot(sim, strat, { seed: +seed });
bot.briefing(); sim.api.dayStart(); bot.dayStarted();
let acc = 0, pr = 0;
const prev = new Int16Array(sim.MAXA).fill(-1), pid = new Float32Array(sim.MAXA);
const C = {}; const add = k => { C[k] = (C[k] || 0) + 1; };
let removedLed = 0;
const rm = sim.removeAgent; sim.removeAgent = i => { if (sim.day.t >= +h0 * 3600 && sim.lead[i] >= 0) removedLed++; else if (sim.day.t >= +h0 * 3600 && prev[i] >= 0) add('removed(after leaving)'); return rm(i); };
while (sim.day.phase === 'day' && sim.day.t < +h1 * 3600) {
  sim.step(0.12); acc += 0.12; if (acc >= 5) { acc = 0; bot.tick(5); }
  if (sim.day.t < +h0 * 3600) { for (let i = 0; i < sim.NA; i++) { prev[i] = sim.lead[i]; pid[i] = sim.v0[i]; } continue; }
  for (let i = 0; i < sim.NA; i++) {
    if (pid[i] !== sim.v0[i]) { prev[i] = sim.lead[i]; pid[i] = sim.v0[i]; continue; }
    const p = prev[i], l = sim.lead[i];
    if (p >= 0 && l < 0) {
      const a = sim.act[i];
      if (a === ACT.ARRESTED) add('arrested'); else if (sim.panicT[i] > 0) add('panic'); else if (sim.riot[i] >= 0) add('riot'); else if (sim.lapL[i] >= 0) add('lapse'); else if (a === ACT.DOWN) add('down'); else if (sim.leaders[p].arrested) add('leader arrested'); else add('other:' + a);
    } else if (p < 0 && l >= 0) add('joined');
    prev[i] = l;
  }
  if ((pr += 0.12) >= 600) { pr = 0; let f = 0; for (const L of sim.leaders) if (!L.arrested && !L.gone) f += L.count; console.log((sim.day.t / 3600).toFixed(2), 'followers', f, JSON.stringify(C), 'removedWhileLed', removedLed); }
}
