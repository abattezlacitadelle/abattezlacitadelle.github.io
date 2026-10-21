// debug: walkable / police map of the arc around the gate (angles a0..a1, radii 45..75 m)
import { makeSim } from '../tools/nodesim.mjs';
const [a0 = -80, a1 = 0] = process.argv.slice(2).map(Number);
const sim = makeSim('small', 1); sim.initScenario(); sim.api.dayStart();
for (let k = 0; k < 50; k++) sim.step(0.12);
const gx = sim.goal.x, gy = sim.goal.y;
for (const r of [40, 45, 50, 55, 60, 65, 70, 75]) {
  let s = '';
  for (let a = a0; a <= a1; a += 2) {
    const x = gx + Math.cos(a * Math.PI / 180) * r, y = gy + Math.sin(a * Math.PI / 180) * r;
    let o = false; for (const sq of sim.squads) if (sq.gate) for (let k = 0; k < sq.na; k++) if (Math.hypot(sq.ox[k] - x, sq.oy[k] - y) < 1.2) o = true;
    s += o ? 'P' : sim.walkAt(x, y) ? '.' : '#';
  }
  console.log(String(r).padStart(3), s);
}
for (const s of sim.squads.filter(s => s.gate)) console.log(s.id, Math.round(Math.atan2(s.y - gy, s.x - gx) * 180 / Math.PI), { left: +s.left.toFixed(1), right: +s.right.toFixed(1), na: s.na, rows: s.nFront });
