// debug: count crossings of each gate line plane per step (snapshot before / after each step), plus followers inside 60 m
import { makeSim } from '../tools/nodesim.mjs';
import { createBot } from '../tools/bot.js';
const [strat = 'reckless', seed = '1', mh = '9.6'] = process.argv.slice(2);
const sim = makeSim('small', +seed); sim.initScenario();
const bot = createBot(sim, strat, { seed: +seed });
bot.briefing(); sim.api.dayStart(); bot.dayStarted();
const gx = sim.goal.x, gy = sim.goal.y;
let acc = 0, pr = 0; const ox = new Float32Array(sim.MAXA), oy = new Float32Array(sim.MAXA), oid = new Float32Array(sim.MAXA);
const cross = {}; let leaderIn = '';
while (sim.day.phase === 'day' && sim.day.t < +mh * 3600) {
  const NA0 = sim.NA; for (let i = 0; i < NA0; i++) { ox[i] = sim.px[i]; oy[i] = sim.py[i]; oid[i] = sim.v0[i]; }
  sim.step(0.12); acc += 0.12; if (acc >= 5) { acc = 0; bot.tick(5); }
  for (const sq of sim.squads) { if (!sq.gate) continue;
    for (let i = 0; i < Math.min(NA0, sim.NA); i++) { if (sim.v0[i] !== oid[i]) continue; // same agent (v0 as an id)
      const a0 = (ox[i] - sq.x) * sq.dx + (oy[i] - sq.y) * sq.dy, a1 = (sim.px[i] - sq.x) * sq.dx + (sim.py[i] - sq.y) * sq.dy;
      if (a0 >= -0.4 && a1 < -0.4) { const la = (sim.px[i] - sq.x) * sq.pxu + (sim.py[i] - sq.y) * sq.pyu; if (la < -sq.right - 3 || la > sq.left + 3) continue;
        const k = `${sq.id}:${sq.state}:la${Math.round(la)}:${a0.toFixed(1)}>${a1.toFixed(1)}:gap${sq.gap}`; cross[sq.id] = (cross[sq.id] || 0) + 1; if (cross[sq.id] < 15) console.log((sim.day.t / 3600).toFixed(3), 'CROSS', k, 'L', sq.left.toFixed(1), sq.right.toFixed(1), 'act', sim.act[i], 'panic', sim.panicT[i].toFixed(1)); } } }
  if ((pr += 0.12) >= 60) { pr = 0; let fin = 0, bin = 0; for (let i = 0; i < sim.NA; i++) if (Math.hypot(sim.px[i] - gx, sim.py[i] - gy) < 60) { if (sim.lead[i] >= 0) fin++; else bin++; }
    console.log((sim.day.t / 3600).toFixed(3), 'inside60 followers', fin, 'others', bin, 'crossings', JSON.stringify(cross), sim.leaders.map(L => L.name + ':' + Math.round(Math.hypot(L.x - gx, L.y - gy))).join(' ')); }
}
