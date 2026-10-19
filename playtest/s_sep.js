const { createBot } = await import('/tools/bot.js');
const sim = S.sim; S.ui.paused = true; sim.seed(1);
const bot = createBot(sim, 'reckless', { seed: 1 });
bot.briefing(); S.startDay(); bot.dayStarted(); S.ui.paused = true;
let acc = 0;
while (sim.day.t < 9.0 * 3600) { sim.step(0.12); acc += 0.12; if (acc >= 5) { acc = 0; bot.tick(5); } }
const L = sim.leaders.find(l => !l.arrested) || sim.leaders[0];
let cx = 0, cy = 0, n = 0; for (let i = 0; i < sim.NA; i++) if (sim.lead[i] === L.id) { cx += sim.px[i]; cy += sim.py[i]; n++; }
log('leader', Math.round(L.x), Math.round(L.y), 'crowd centroid', Math.round(cx / n), Math.round(cy / n), n);
S.view.showIntent = true; S.focus((L.x + cx / n) / 2, (L.y + cy / n) / 2, 1.3); await frame(); await frame(); await shot('sep1');
