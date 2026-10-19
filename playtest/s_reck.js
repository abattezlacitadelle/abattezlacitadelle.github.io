const { createBot } = await import('/tools/bot.js');
const sim = S.sim; S.ui.paused = true;
const bot = createBot(sim, 'reckless', { seed: 1 });
bot.briefing(); S.startDay(); bot.dayStarted(); S.ui.paused = true;
for (let m = 0; m < 17; m++) { for (let k = 0; k < 500; k++) { sim.step(0.12); if (k % 42 === 0) bot.tick(5); } }
const L = sim.leaders[0]; S.focus(L.x, L.y, 2.2); await frame(); await frame();
log((sim.day.t/3600).toFixed(2), sim.leaders.map(l => l.name + ' ' + l.count + ' ' + Math.round(l.x) + ',' + Math.round(l.y)).join(' | '));
await shot('reck_817');
