import { makeSim } from '../tools/nodesim.mjs';
const sim = makeSim('small', 1);
console.log('goal', sim.goal.x, sim.goal.y, 'W', sim.W, sim.H);
const F = sim.computeField(sim.goal.x, sim.goal.y);
for (const k in sim.spawnPoints) { const p = sim.spawnPoints[k]; console.log('spawn', k, p, Math.round(sim.fieldDist(F, p[0], p[1]))); }
for (const r of sim.data.riotSpawns) console.log('riot', r.x, r.y, r.n, Math.round(sim.fieldDist(F, r.x, r.y)));
console.log(Object.keys(sim.LM).map(k => k + ':' + sim.LM[k].map(Math.round)).join(' '));
