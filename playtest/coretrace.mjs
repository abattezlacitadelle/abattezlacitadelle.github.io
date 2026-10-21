// debug: node playtest/coretrace.mjs <strategy> <seed> <untilHour> [startDay] [crowd] [every s]: where is each leader's core?
import { makeSim } from '../tools/nodesim.mjs';
import { createBot } from '../tools/bot.js';
import { ACT } from '../src/common.js';
const [strat = 'reckless', seed = '1', mh = '9', sd = '2', crowd = '750', ev = '10'] = process.argv.slice(2);
const sim = makeSim('small', +seed); sim.initScenario(); if (+sd > 1) sim.api.daySetDay(+sd, +crowd);
const bot = createBot(sim, strat, { seed: +seed });
bot.briefing(); sim.api.dayStart(); bot.dayStarted();
let acc = 0, pr = 0;
sim.onEvent(e => { if (e.type === 'arrest' && e.leader != null) console.log((sim.day.t / 3600).toFixed(3), 'LEADER ARREST', e.leader, e.by); if (['kettle', 'cordon', 'charge', 'scatter', 'rally'].includes(e.type) && (e.phase ?? 'x') !== 'end') { for (const L of sim.leaders) if (!L.arrested && Math.hypot(L.x - e.x, L.y - e.y) < 60) console.log((sim.day.t / 3600).toFixed(3), 'EVENT', e.type, e.phase || '', 'near', L.name); } });
while (sim.day.phase === 'day' && sim.day.t < +mh * 3600) {
  sim.step(0.12); acc += 0.12; if (acc >= 5) { acc = 0; bot.tick(5); }
  if ((pr += 0.12) >= +ev) { pr = 0;
    for (const L of sim.leaders) { if (L.arrested || L.gone) continue;
      let own10 = 0, core = 0, coreIn = 0, coreP = 0, coreAuto = 0, coreFar = 0, cx = 0, cy = 0, pan = 0, auto = 0;
      sim.forEachNear(L.x, L.y, 10, j => { if (sim.lead[j] === L.id && sim.panicT[j] <= 0) own10++; });
      for (let i = 0; i < sim.NA; i++) {
        const mine = sim.lead[i] === L.id, wasMine = sim.prevLead[i] === L.id && sim.panicT[i] > 0;
        if (mine && sim.act[i] >= ACT.LOOT && sim.act[i] <= ACT.MILL) auto++;
        if (wasMine) pan++;
        if (!(mine || wasMine) || !(sim.coreU[i] < L.coreShare)) continue;
        core++; const d = Math.hypot(sim.px[i] - L.x, sim.py[i] - L.y);
        if (wasMine) coreP++; else if (sim.act[i] >= ACT.LOOT && sim.act[i] <= ACT.MILL) coreAuto++; else if (d < L.coreR) coreIn++; else { coreFar++; cx += sim.px[i] - L.x; cy += sim.py[i] - L.y; }
      }
      let cop = 1e9; for (const sq of sim.squads) for (let k = 0; k < sq.na; k++) cop = Math.min(cop, Math.hypot(sq.ox[k] - L.x, sq.oy[k] - L.y));
      sim.gasSample(L.x, L.y);
      const E = L.pexp || {};
      console.log((sim.day.t / 3600).toFixed(3), L.name, L.stance[0], 'n', L.count, 'own10', own10, `core in ${coreIn} far ${coreFar} (off ${coreFar ? Math.round(Math.hypot(cx, cy) / coreFar) : 0}m) panic ${coreP} auto ${coreAuto} /${core}`, 'pan', pan, 'auto', auto, 'spd', L.speed.toFixed(2), L.gasEsc ? 'GASESC' : '', L.pressing ? 'press' : '', L.arrived ? 'arr' : 'mov', 'gas', sim.gs.s.toFixed(2), 'cop', cop.toFixed(0), 'dG', Math.round(Math.hypot(L.x - sim.goal.x, L.y - sim.goal.y)), 'exp', (E.t ?? 0).toFixed(0) + (E.ready ? 'R' : ''), 'esc', sim.police.escalation.toFixed(1));
    } }
}
