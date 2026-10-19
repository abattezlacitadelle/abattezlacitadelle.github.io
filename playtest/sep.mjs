// leader / crowd separation probe: reckless day 1, first 25 min
import { makeSim } from '../tools/nodesim.mjs';
import { createBot } from '../tools/bot.js';
const strat = process.argv[2] || 'reckless';
const sim = makeSim('small', 1); sim.initScenario();
const bot = createBot(sim, strat, { seed: 1 });
bot.briefing(); sim.api.dayStart(); bot.dayStarted();
let acc = 0;
for (let s = 0; s < 25 * 60 / 0.12; s++) {
  sim.step(0.12); acc += 0.12;
  if (Math.round(s * 0.12 * 100) % 500 === 0) bot.tick(5);
  if (s % 250 === 0) {
    const rows = [];
    for (const L of sim.leaders) {
      if (L.arrested) { rows.push(L.name + ':ARR'); continue; }
      let own10 = 0, own25 = 0, cx = 0, cy = 0, n = 0, ahead = 0;
      for (let i = 0; i < sim.NA; i++) if (sim.lead[i] === L.id) { const d = Math.hypot(sim.px[i] - L.x, sim.py[i] - L.y); if (d < 10) own10++; if (d < 25) own25++; cx += sim.px[i]; cy += sim.py[i]; n++; if (L.field && sim.fieldDist(L.field, sim.px[i], sim.py[i]) < L.prog) ahead++; }
      rows.push(`${L.name}:n${L.count} o10=${own10} o25=${own25} cen=${n ? Math.round(Math.hypot(cx / n - L.x, cy / n - L.y)) : '-'} ahead=${ahead} sp=${L.speed.toFixed(2)} w=${L.dbg?.wait?.toFixed(2)} fw=${L.dbg?.fw?.toFixed(2)} cop=${Math.round(Math.min(...sim.squads.map(q => Math.hypot(q.x - L.x, q.y - L.y))))}`);
    }
    console.log((sim.day.t / 3600).toFixed(2), 'esc', sim.police.escalation, rows.join(' | '));
  }
}
