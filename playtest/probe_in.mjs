import { makeSim } from '../tools/nodesim.mjs';
import { createBot } from '../tools/bot.js';
const [strat = 'careful', seed = '1'] = process.argv.slice(2);
const sim = makeSim('small', +seed); sim.initScenario();
const bot = createBot(sim, strat, { seed: +seed });
bot.briefing(); sim.api.dayStart(); bot.dayStarted();
const g = sim.goal; let acc = 0, lt = 0;
while (sim.day.phase === 'day') {
  sim.step(0.12); acc += 0.12; if (acc >= 5) { acc = 0; bot.tick(5); }
  for (const L of sim.leaders) {
    if (L.arrested) continue;
    const d = Math.hypot(L.x - g.x, L.y - g.y);
    if (d < 90 && (lt -= 0.12) <= 0) {
      lt = 3;
      const near = sim.squads.map(q => { let dm = 1e9; for (let k = 0; k < q.na; k++) dm = Math.min(dm, Math.hypot(q.ox[k] - L.x, q.oy[k] - L.y)); return { q, dm }; }).sort((a, b) => a.dm - b.dm).slice(0, 2);
      console.log((sim.day.t / 3600).toFixed(3), L.name, `(${L.x.toFixed(0)},${L.y.toFixed(0)}) d${d.toFixed(0)} n${L.count}`, near.map(({ q, dm }) => `sq${q.id}${q.gate ? 'G' : ''} ${q.state} dm${dm.toFixed(1)} at(${q.x.toFixed(0)},${q.y.toFixed(0)}) d${Math.hypot(q.x - g.x, q.y - g.y).toFixed(0)} L${q.left.toFixed(1)}R${q.right.toFixed(1)} gap${q.gap} na${q.na}`).join(' | '));
    }
  }
  if (sim.day.phase !== 'day') break;
  if (sim.day.t > 9.3 * 3600) break;
}
