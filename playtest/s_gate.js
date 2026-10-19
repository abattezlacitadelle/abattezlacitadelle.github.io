const { createBot } = await import('/tools/bot.js');
const sim = S.sim; S.ui.paused = true; sim.seed(1);
const bot = createBot(sim, 'careful', { seed: 1 });
bot.briefing(); S.startDay(); bot.dayStarted(); S.ui.paused = true;
const g = sim.goal; let acc = 0, n = 0;
while (n++ < 40000) { sim.step(0.12); acc += 0.12; if (acc >= 5) { acc = 0; bot.tick(5); }
  const d = Math.min(...sim.leaders.filter(L => !L.arrested).map(L => Math.hypot(L.x - g.x, L.y - g.y)));
  if (d < 60 || sim.day.phase !== 'day') break; }
log((sim.day.t / 3600).toFixed(2), sim.leaders.map(l => `${l.name} ${l.count} d${Math.round(Math.hypot(l.x - g.x, l.y - g.y))} ${l.arrested ? 'ARR' : ''}`).join(' | '));
S.view.showIntent = true; S.focus(g.x, g.y, 4); await frame(); await frame(); await shot('gate1');
for (let k = 0; k < 250; k++) { sim.step(0.12); acc += 0.12; if (acc >= 5) { acc = 0; bot.tick(5); } }
await frame(); await frame(); await shot('gate2');
log(sim.squads.filter(q => q.gate).map(q => `${q.id} ${q.state} gap${q.gap} e${Math.round(q.energy)} L${Math.round(q.load)}/${Math.round(q.strength)}`).join(' | '));
