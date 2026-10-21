// Approximate sim checkpoints for long headless playtests (v1.8). A 7-day campaign takes 50-100 wall minutes, so
// tools/playtest.mjs --chunkMin M stops a worker after M minutes, saves a checkpoint and resumes it on the next call.
//
// Saved exactly: every registered per-agent array (sim.agentArrays), sim time, the day state (sim.day), leaders (flow fields
// are recomputed from their order target), riots, fires, gas, shop / prop state, loot hotspots, the police's escalation, heat,
// counts, tracks and warnings, and each squad's position, facing, officers, hp, energy and stocks.
// Approximated: squads come back without a task (the planner re-plans within ~1-12 s); running kettles / cordons / funnels /
// splits, snatch teams and detached hunt teams are dropped (hunt teams return as small squads); people under arrest are
// removed (taken away); projectiles in flight are dropped; the sim and bot RNGs are reseeded from (seed, sim time).
const enc = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const dec = (s, C) => { const b = Buffer.from(s, 'base64'); return new C(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const prim = v => v === null || ['number', 'string', 'boolean'].includes(typeof v);
const plain = o => { const r = {}; for (const k in o) if (prim(o[k])) r[k] = o[k]; return r; };
const json = v => JSON.parse(JSON.stringify(v, (k, x) => (x instanceof Map ? { __map: [...x] } : x)));
const unjson = v => JSON.parse(JSON.stringify(v), (k, x) => (x && x.__map ? new Map(x.__map) : x));

export function saveSim(sim) {
  const NA = sim.NA;
  const arrays = sim.agentArrays.map(({ arr }) => [arr.constructor.name, enc(arr.subarray(0, NA))]);
  const leaders = sim.leaders.map(L => {
    const o = {};
    for (const k in L) { if (k === 'field' || k === 'path' || k === 'dbg') continue; const v = L[k]; if (prim(v) || (v && typeof v === 'object' && !ArrayBuffer.isView(v))) o[k] = v; }
    o.fieldT = L.field ? [L.field.tx, L.field.ty] : null;
    return json(o);
  });
  const riots = (sim.riots || []).map(R => { const o = {}; for (const k in R) { if (k === 'field') continue; o[k] = R[k]; } if (o.target) o.target = plain(o.target); return json(o); });
  const P = sim.police, pol = {};
  for (const k in P) if (prim(P[k])) pol[k] = P[k];
  Object.assign(pol, json({ counts: P.counts, tracks: P.tracks, warnAreas: P.warnAreas.map(plain), blockMem: P.blockMem, splitT: P.splitT, stillT: P.stillT, gaps: P.gaps }));
  const squads = sim.squads.map(sq => ({ x: sq.x, y: sq.y, ax: sq.anchor.x, ay: sq.anchor.y, hx: sq.home.x, hy: sq.home.y, dx: sq.dx, dy: sq.dy, n: sq.n, na: sq.na, hp: Array.from(sq.hp.subarray(0, sq.n)),
    energy: sq.energy, gasStock: sq.gasStock, lbdStock: sq.lbdStock, gate: !!sq.gate, gatePost: sq.gatePost, maxAdv: sq.maxAdv, manual: sq.manual, tactic: sq.tactic, rearmT: sq.rearmT || 0 }));
  let gas = null;
  if (sim.gasBox && sim.gas) { const g = [], G = sim.gas; for (let k = 0; k < G.length; k++) if (G[k] > 1e-4) g.push(k, +G[k].toFixed(5)); gas = { box: { ...sim.gasBox }, g, emitters: json(sim.emitters || []) }; }
  const day = {}; for (const k in sim.day) if (k !== 'objectives' && typeof sim.day[k] !== 'function') day[k] = sim.day[k];
  return {
    v: 1, simTime: sim.simTime, NA, dispersedHome: sim.dispersedHome, arrays, leaders, riots, police: pol, squads, gas,
    day: json(day), fires: json(sim.fires || []), hot: json(sim.crowdAI?.hot || []),
    shops: (sim.shops || []).map(plain), props: (sim.props || []).map(plain),
  };
}

// sim: a fresh makeSim(map, seed) with initScenario() already called
export function loadSim(sim, S, reseed) {
  if (S.v !== 1) throw new Error('checkpoint version');
  sim.simTime = S.simTime;
  Object.assign(sim.day, unjson(S.day)); sim.day.objectives = [];
  // agents
  while (sim.NA < S.NA) if (sim.addAgent(0, 0) < 0) break;
  S.arrays.forEach(([cn, b], k) => { const A = sim.agentArrays[k]; if (!A || A.arr.constructor.name !== cn) throw new Error('agent array mismatch ' + k); A.arr.set(dec(b, A.arr.constructor)); });
  sim.dispersedHome = S.dispersedHome;
  // leaders (same objects array; the systems hold sim.leaders by reference through sim)
  sim.leaders.length = 0;
  for (const o of S.leaders) {
    const L = unjson(o); const ft = L.fieldT; delete L.fieldT;
    L.field = ft ? sim.computeField(ft[0], ft[1]) : null; L.path = null;
    sim.leaders.push(L);
  }
  sim.selected?.clear?.();
  // riots
  if (sim.riots) { sim.riots.length = 0; for (const o of S.riots) { const R = unjson(o); R.field = null; R.fieldT = -1e9; if (R.target) R.target.ref = null; sim.riots.push(R); } }
  // fires, hotspots, shops, props
  if (sim.fires) { sim.fires.length = 0; for (const f of unjson(S.fires)) sim.fires.push(f); }
  if (sim.crowdAI?.hot) { sim.crowdAI.hot.length = 0; for (const h of unjson(S.hot)) sim.crowdAI.hot.push(h); }
  (sim.shops || []).forEach((s, k) => Object.assign(s, S.shops[k] || {}));
  (sim.props || []).forEach((p, k) => Object.assign(p, S.props[k] || {}));
  // gas: the grid, plus two zero-rate emitters at the box corners so the gas system re-opens its box
  if (S.gas && sim.gas) {
    const G = sim.gas, g = S.gas.g; for (let k = 0; k < g.length; k += 2) G[g[k]] = g[k + 1];
    const b = S.gas.box, GC = sim.GC;
    for (const e of unjson(S.gas.emitters)) sim.emitters.push(e);
    sim.emitters.push({ x: (b.x0 + 0.5) * GC, y: (b.y0 + 0.5) * GC, rate: 0, t: 0.01 }, { x: (b.x1 + 0.5) * GC, y: (b.y1 + 0.5) * GC, rate: 0, t: 0.01 });
  }
  // police
  for (const sq of sim.squads.slice()) sim.api.removeSquad(sq);
  const P = sim.police, pol = unjson(S.police);
  for (const k in pol) if (prim(pol[k])) P[k] = pol[k];
  Object.assign(P.counts, pol.counts);
  P.tracks = pol.tracks instanceof Map ? pol.tracks : new Map();
  for (const k of ['warnAreas', 'gaps']) { P[k].length = 0; P[k].push(...(pol[k] || [])); }
  for (const k of ['blockMem', 'splitT', 'stillT']) P[k] = pol[k] || {};
  P.gateDone = true; P.deployed = true; P.cmdT = 1; P.urgent = true;
  for (const q of S.squads) {
    const sq = sim.api.addSquad(q.x, q.y, q.dx, q.dy, { manual: q.manual, tactic: q.tactic, n: q.n });
    if (!sq) continue;
    sq.anchor.x = q.ax; sq.anchor.y = q.ay; sq.home.x = q.hx; sq.home.y = q.hy;
    for (let k = 0; k < q.hp.length; k++) sq.hp[k] = q.hp[k];
    sq.na = q.na; sq.energy = q.energy; sq.gasStock = q.gasStock; sq.lbdStock = q.lbdStock; sq.maxAdv = q.maxAdv;
    if (q.gate) { sq.gate = true; sq.gatePost = q.gatePost; sq.role = 'gate'; sq.rearmT = q.rearmT; }
  }
  // people under arrest are taken away (the escort records were not saved)
  for (let i = 0; i < sim.NA; i++) if (sim.act[i] === sim.ACT.ARRESTED) sim.removeAgent(i);
  sim.flushRemovals?.();
  if (reseed != null) sim.seed(reseed);
}
