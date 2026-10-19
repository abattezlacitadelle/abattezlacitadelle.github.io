// Scenario (b) re-run (police agent's stretch test): day 4, two marches in different directions (north via Opéra, south
// via the Tuileries / Concorde) plus the day's riots; logs squad roles, ops and staffing gaps every 5 sim-minutes.
import { makeSim } from '../tools/nodesim.mjs';
const sim = makeSim('small', 7); sim.initScenario(); sim.api.daySetDay(4, 2000);
const keys = Object.keys(sim.spawnPoints);
sim.api.chooseSpawn(0, 'louvreRivoli'); sim.api.chooseSpawn(1, 'pontNeuf'); sim.api.chooseSpawn(2, 'chatelet');
sim.api.dayStart();
const LM = sim.LM, g = sim.goal;
sim.api.orderLeaders([0], LM.operaGarnier[0], LM.operaGarnier[1]);
sim.api.orderLeaders([1], LM.tuileries[0], LM.tuileries[1]);
let t = 0, phase = 0; const gapsSeen = new Set(), out = [];
for (let s = 0; s < 5 * 3600 / 0.12; s++) {
  sim.step(0.12); t += 0.12;
  const L0 = sim.leaders[0], L1 = sim.leaders[1];
  if (phase === 0 && t > 2400) { phase = 1; sim.api.orderLeaders([0], g.x, g.y); sim.api.orderLeaders([1], g.x, g.y); out.push('-- 08:40 both marches turn toward the Élysée'); }
  if (s % Math.round(300 / 0.12) === 0) {
    const roles = {}; for (const q of sim.squads) { const k = q.gate ? 'gate' : q.hunt ? 'hunt' : q.role; roles[k] = (roles[k] || 0) + 1; }
    const ops = sim.police.plan.filter(p => p.status !== 'done' && !['perimeter', 'hunt'].includes(p.kind)).map(p => `${p.kind}:${p.target ?? ''}:${p.status}`);
    const newGaps = sim.police.gaps.filter(gp => !gapsSeen.has(gp)); newGaps.forEach(gp => gapsSeen.add(gp));
    const pred = sim.police.predict.filter(p => p.kind === 'march' && p.rank === 0).map(p => `${p.key}->${p.dest}(${Math.round(p.conf * 100)}%)`);
    out.push(`${(sim.day.t / 3600).toFixed(2)} esc${sim.police.escalation} L0 ${L0.arrested ? 'ARR' : L0.count + '@' + Math.round(Math.hypot(L0.x - g.x, L0.y - g.y))} L1 ${L1.arrested ? 'ARR' : L1.count + '@' + Math.round(Math.hypot(L1.x - g.x, L1.y - g.y))} riots ${sim.riots.filter(r => r.alive).map(r => r.count).join('/')} | squads ${JSON.stringify(roles)} | plan ${ops.join(' ')} | guess ${pred.join(' ')} | new gaps ${newGaps.map(gp => gp.kind + ':' + gp.why).join(', ') || '-'}`);
  }
  if (sim.day.phase !== 'day') break;
}
const c = sim.police.counts;
out.push(`totals: gaps ${c.gaps} retasks ${c.retasks} blocks ${c.blocks} kettles ${c.kettles} cordons ${c.cordons} funnels ${c.funnels} splits ${c.splits} vanTrips ${c.vanTrips} intelTurns ${c.intelTurns} lineArrests ${c.lineArrests} gateBreaches ${c.gateBreaches}`);
console.log(out.join('\n'));
