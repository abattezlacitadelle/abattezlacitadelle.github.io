import { makeSim } from '../tools/nodesim.mjs';
import { createBot } from '../tools/bot.js';
const [strat = 'reckless', seed = '1', sd = '5', crowd = '2200'] = process.argv.slice(2);
const sim = makeSim('small', +seed); sim.initScenario(); if (+sd > 1) sim.api.daySetDay(+sd, +crowd);
const bot = createBot(sim, strat, { seed: +seed });
bot.briefing(); sim.api.dayStart(); bot.dayStarted();
let acc = 0, lt = 0;
while (sim.day.phase === 'day' && sim.leaders.some(L => !L.arrested)) {
  sim.step(0.12); acc += 0.12; if (acc >= 5) { acc = 0; bot.tick(5); }
  if ((lt -= 0.12) <= 0) { lt = 10;
    console.log((sim.day.t / 3600).toFixed(3), 'esc', sim.police.escalation, sim.leaders.map(L => { if (L.arrested) return L.name + ' ARR'; let own8 = 0, own20 = 0; sim.forEachNear(L.x, L.y, 20, (j, dx, dy, d2) => { if (sim.lead[j] === L.id) { own20++; if (d2 < 64) own8++; } });
      let cop = 1e9; for (const q of sim.squads) for (let k = 0; k < q.na; k++) cop = Math.min(cop, Math.hypot(q.ox[k] - L.x, q.oy[k] - L.y));
      sim.gasSample(L.x, L.y); return `${L.name} n${L.count} o8=${own8} o20=${own20} cop${cop.toFixed(0)} g${sim.gs.s.toFixed(2)} sp${L.speed.toFixed(2)} ${L.dbg?.held ? 'HELD' : ''}${L.gasEsc ? 'GASESC' : ''} w${(L.dbg?.wait ?? 1).toFixed(2)}`; }).join(' | '));
  }
}
console.log(sim.police.log.filter(l => /leader|line arrest/.test(l.what)).map(l => `${(l.t % 86400 / 3600).toFixed(3)} sq${l.sq} ${l.what}`).join('\n'));
