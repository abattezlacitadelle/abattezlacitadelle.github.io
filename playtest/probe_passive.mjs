import { makeSim } from '../tools/nodesim.mjs';
const sim = makeSim('small', 1); sim.initScenario(); sim.api.dayStart();
const br = {}, inj = {}, heat = []; let brawl = 0;
sim.onEvent(e => {
  if (e.type === 'lineBroken') { const sq = sim.squads.find(q => q.id === e.squad); const k = `${e.squad}:${sq?.hunt ? 'hunt' : sq?.role}:${sq?.na}`; br[k] = (br[k] || 0) + 1; }
  if (e.type === 'injury') inj[e.kind] = (inj[e.kind] || 0) + 1;
  if (e.type === 'brawl') brawl++;
});
for (let m = 0; m < 120; m++) {
  for (let k = 0; k < 500; k++) sim.step(0.12);
  if (m % 10 === 9) console.log((sim.day.t / 3600).toFixed(2), 'heat', sim.police.heat.toFixed(2), 'esc', sim.police.escalation, 'brawl', brawl, JSON.stringify(br), JSON.stringify(inj), sim.squads.map(q => `${q.id}${q.hunt ? 'h' : ''}:${q.role}/${q.state}/${q.na}/${Math.round(q.energy)}/L${(q.load || 0).toFixed(0)}S${(q.strength || 0).toFixed(0)}`).join(' '));
}
