// debug: node playtest/coredbg.mjs <strategy> <seed> <untilHour> [startDay] [crowd]: sample each leader's core / own followers nearby
import { makeSim } from '../tools/nodesim.mjs';
import { createBot } from '../tools/bot.js';
const [strat = 'passive', seed = '1', mh = '10', sd = '1', crowd = ''] = process.argv.slice(2);
const sim = makeSim('small', +seed); sim.initScenario(); if (+sd > 1) sim.api.daySetDay(+sd, crowd ? +crowd : undefined);
const bot = createBot(sim, strat, { seed: +seed });
bot.briefing(); sim.api.dayStart(); bot.dayStarted();
let acc = 0, pr = 0, ms = 0, n = 0;
sim.onEvent(e => { if (e.type === 'arrest' && e.leader != null) console.log((sim.day.t / 3600).toFixed(2), 'LEADER ARREST', JSON.stringify(e).slice(0, 200)); if (e.type === 'promoted' || e.type === 'succession') console.log((sim.day.t / 3600).toFixed(2), e.type, JSON.stringify(e).slice(0, 160)); });
while ((sim.day.phase === 'day' || sim.day.phase === 'dusk') && sim.day.t < +mh * 3600) {
  const t0 = performance.now(); sim.step(0.12); ms += performance.now() - t0; n++; acc += 0.12; if (acc >= 5) { acc = 0; bot.tick(5); }
  if ((pr += 0.12) >= 300) { pr = 0;
    const out = [];
    for (const L of sim.leaders) { if (L.arrested || L.gone) continue;
      let own10 = 0, core = 0, core10 = 0, coreP = 0; sim.forEachNear(L.x, L.y, 10, j => { if (sim.lead[j] === L.id) own10++; });
      for (let i = 0; i < sim.NA; i++) if (sim.lead[i] === L.id && sim.coreU[i] < L.coreShare) { core++; if (Math.hypot(sim.px[i] - L.x, sim.py[i] - L.y) < 10) core10++; }
      for (let i = 0; i < sim.NA; i++) if (sim.prevLead[i] === L.id && sim.panicT[i] > 0) coreP++;
      out.push(`${L.name}[${L.stance[0]}] n${L.count} own10 ${own10} core ${core10}/${core} r${L.coreR.toFixed(0)} panic${coreP} dG${Math.round(Math.hypot(L.x - sim.goal.x, L.y - sim.goal.y))} exp${L.pexp ? L.pexp.t.toFixed(0) + (L.pexp.ready ? 'R' : '') : '-'} ${L.arrived ? 'arr' : 'mov'}${L.pressing ? ' press' : ''}`);
    }
    console.log((sim.day.t / 3600).toFixed(2), 'esc', sim.police.escalation.toFixed(1), 'ms', (ms / n).toFixed(2), '|', out.join(' | ')); ms = n = 0;
  }
}
console.log('end', sim.day.phase, sim.day.t / 3600, JSON.stringify(sim.day.result || ''), 'arrests', sim.day.stats.arrests, 'snatch', sim.police.counts.snatches, 'hunts', sim.police.counts.hunts, 'kettles', sim.police.counts.kettles);
