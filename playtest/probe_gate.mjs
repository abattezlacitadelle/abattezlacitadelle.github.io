// node playtest/probe_gate.mjs <strategy> <seed> [startDay] [crowd]: play until a leader is within 300 m of the gate, then log the gate fight
import { makeSim } from '../tools/nodesim.mjs';
import { createBot } from '../tools/bot.js';
const [strat = 'careful', seed = '1', sd, crowd] = process.argv.slice(2);
const sim = makeSim('small', +seed); sim.initScenario(); if (sd) sim.api.daySetDay(+sd, crowd ? +crowd : undefined);
const bot = createBot(sim, strat, { seed: +seed });
bot.briefing(); sim.api.dayStart(); bot.dayStarted();
const ev = {}; sim.onEvent(e => { if (['lineBroken', 'officerDown', 'arrest', 'gateHold', 'kettle', 'cordon', 'relief'].includes(e.type)) { ev[e.type] = (ev[e.type] || 0) + 1; if (e.type === 'arrest' && e.leader != null || e.type === 'gateHold' || e.type === 'lineBroken') console.log('   EV', (sim.day.t / 3600).toFixed(3), e.type, JSON.stringify(e).slice(0, 160)); } });
let acc = 0, logT = 0, near = false;
const g = sim.goal;
while (sim.day.phase === 'day' || sim.day.phase === 'dusk') {
  sim.step(0.12); acc += 0.12; if (acc >= 5) { acc = 0; bot.tick(5); }
  const act = sim.leaders.filter(L => !L.arrested && !L.gone);
  const dmin = Math.min(...act.map(L => Math.hypot(L.x - g.x, L.y - g.y)));
  if (!near && dmin < 300) near = true;
  if (near && (logT -= 0.12) <= 0) {
    logT = 20;
    console.log((sim.day.t / 3600).toFixed(3), 'esc', sim.police.escalation, act.map(L => { let own = 0; sim.forEachNear(L.x, L.y, 15, j => { if (sim.lead[j] === L.id) own++; }); return `${L.name} n${L.count} own15=${own} d${Math.round(Math.hypot(L.x - g.x, L.y - g.y))} ${L.stance[0]}${L.pressing ? ' PRESS' : ''}`; }).join(' | '));
    console.log('   ', sim.squads.filter(q => Math.hypot(q.x - g.x, q.y - g.y) < 260).map(q => `${q.id}:${q.role}/${q.state}/${q.tactic} d${Math.round(Math.hypot(q.x - g.x, q.y - g.y))} na${q.na} e${Math.round(q.energy)} L${(q.load || 0).toFixed(0)}/S${(q.strength || 0).toFixed(0)} f${q.front}`).join(' ; '), JSON.stringify(ev));
  }
  if (sim.day.phase === 'ended') break;
}
console.log('END', sim.day.phase, JSON.stringify(sim.day.result));
