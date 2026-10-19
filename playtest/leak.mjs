import { makeSim } from '../tools/nodesim.mjs';
const sim = makeSim('small', 3); sim.initScenario(); sim.api.dayStart();
for (let k = 0; k < 600; k++) sim.step(0.12);
const { COLS, ROWS, CELL, walk } = sim, g = sim.goal;
const blk = new Uint8Array(COLS * ROWS);
for (const q of sim.squads) if (q.gate) for (let k = 0; k < q.na; k++) { const cx = Math.floor(q.ox[k] / CELL), cy = Math.floor(q.oy[k] / CELL); for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const x = q.ox[k] + i * 1.0, y = q.oy[k] + j * 1.0; blk[sim.cellOf(x, y)] = 1; } }
const seen = new Uint8Array(COLS * ROWS), qu = [sim.cellOf(g.x, g.y)]; seen[qu[0]] = 1; let far = null;
while (qu.length) { const c = qu.pop(); const x = sim.cellX(c), y = sim.cellY(c); const d = Math.hypot(x - g.x, y - g.y); if (d > 120 && !far) far = [x, y]; if (d > 200) continue;
  for (const o of [1, -1, COLS, -COLS]) { const n = c + o; if (walk[n] && !blk[n] && !seen[n]) { seen[n] = 1; qu.push(n); } } }
console.log('leak to', far);
for (const q of sim.squads) if (q.gate) console.log('gate', q.id, Math.round(q.x), Math.round(q.y), 'L', q.left.toFixed(1), 'R', q.right.toFixed(1), 'na', q.na, 'nFront', q.nFront, 'dir', q.dx.toFixed(2), q.dy.toFixed(2));
