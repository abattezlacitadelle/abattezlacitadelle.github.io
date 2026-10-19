import { makeSim } from '../tools/nodesim.mjs';
const sim = makeSim('small', 1); sim.initScenario(); sim.api.dayStart();
for (let k = 0; k < 100; k++) sim.step(0.12);
const pol = sim.police;
for (const R of [45, 50, 52, 55, 60, 65]) console.log(R, pol.ringExits(sim.goal.x, sim.goal.y, R).map(e => `${Math.round(e.x)},${Math.round(e.y)} w${Math.round(e.w)}`).join(' | '));
