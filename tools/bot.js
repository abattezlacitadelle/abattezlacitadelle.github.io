// Bot player + campaign logger for balance playtests (tools/playtest.mjs runs them in Node, no browser).
//
// createBot(sim, strategy, { seed, target? }) -> { strategy, briefing(), dayStarted(), tick(dt), state }
//   opts.target(sim, L) -> {x, y} | null: optional routing target per leader (hook for per-day intermediate objectives; the
//   gate otherwise). Objectives themselves plug into day.js (sim.api.addObjective); the logger records their results.
//   passive    starts each day and does nothing (leaders stand at their spawn points).
//   reckless   "unleashed": every leader from the spawn nearest the Élysée, stance Unleashed, straight at the gate,
//              re-ordered when it stops. Never rallies, never scatters, ignores the police.
//   careful    the "reasonable human":
//              - spawns split over the two nearest spawn points, so one kettle can't take everyone;
//              - reads the police intent overlay (sim.police.plan: blocks, perimeter posts, cordons, kettles, and the
//                squads themselves) and routes around it with a cost field to the gate (re-planned every 30 s and
//                when the plan changes); stretches the police by sending leaders on different routes (the second leader
//                pays extra for the first leader's route);
//              - stance Peaceful when police are close (no offenders to snatch, no excuse to charge), Firm otherwise
//                (Firm for the final push at the gate);
//              - Rally after gas, when followers flee, or when the crowd has lapsed (people around but few attached);
//              - misdirection: the biggest march first heads for Opéra (the police only see the march, they guess where it is
//                going), then turns for the gate about 1100 m out;
//              - captures uncontrolled riots near its route (detour) to grow the march;
//              - Scatter + walk out when a kettle / cordon closes around it; falls back into the crowd when exposed.
//   diversion  one leader (the decoy) goes Unleashed to the uncontrolled riots / looting far from the main route to pull
//              squads away (police responses and ops); the main march gathers out of reach and pushes (careful routing)
//              once the police are committed elsewhere (or from 14:30).
// The bot only uses the player's API (orderLeaders, setStance, leaderAction, chooseSpawn) plus what the player sees on
// screen (positions, the intent overlay = sim.police.plan / predict, gas, riots).
import { ACT, makeRng } from '../src/common.js';

const hyp = Math.hypot;

export function createBot(sim, strategy = 'careful', opts = {}) {
  const rng = makeRng(((opts.seed || 1) * 7919 + 17) >>> 0), rand = rng.rand;
  const goal = sim.goal, { COLS, ROWS, CELL, walk } = sim;
  const NC = COLS * ROWS;
  const S = {
    passive: { passive: true },
    reckless: { stance: 'unleashed', direct: true },
    careful: { route: true, riots: true, rally: true, scatter: true, careful: true },
    diversion: { route: true, riots: true, rally: true, scatter: true, careful: true, decoy: true },
  }[strategy];
  if (!S) throw new Error('unknown strategy ' + strategy);
  const state = { orders: 0, rallies: 0, scatters: 0, stanceChanges: 0, riotDetours: 0, plans: 0, planMs: 0, escapes: 0, fallbacks: 0, pushes: 0, decoyTrips: 0 };
  const per = new Map();
  const P = L => { let o = per.get(L.id); if (!o) per.set(L.id, o = { wp: null, mode: 'march', riot: -1, lastOrderT: -1e9, planSig: '', fbT: 0, role: 'main', lastCount: 0, holdT: 0 }); return o; };
  const active = () => sim.leaders.filter(L => !L.arrested && !L.gone);
  const dGoal = L => hyp(L.x - goal.x, L.y - goal.y);

  // ------------------------------------------------------------ cost field to the gate (what a player reads off the intent overlay)
  const pen = new Uint8Array(NC), dist = new Int32Array(NC);
  const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1], DC = [10, 10, 10, 10, 14, 14, 14, 14];
  const DOFF = DX.map((d, k) => d + DY[k] * COLS);
  const NB = 512, ring = Array.from({ length: NB }, () => []);
  function stamp(x, y, R, v) {
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL), r = Math.ceil(R / CELL);
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
      const cx = gx + i, cy = gy + j; if (cx < 1 || cy < 1 || cx >= COLS - 1 || cy >= ROWS - 1) continue;
      const d = Math.sqrt(i * i + j * j) * CELL; if (d > R) continue;
      const c = cy * COLS + cx, p = Math.round(v * (1 - 0.6 * d / R));
      if (p > pen[c]) pen[c] = Math.min(60, p);
    }
  }
  function stampLine(pts, R, v) {
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1], l = hyp(bx - ax, by - ay), n = Math.max(1, Math.ceil(l / 4));
      for (let q = 0; q <= n; q++) stamp(ax + (bx - ax) * q / n, ay + (by - ay) * q / n, R, v);
    }
    if (pts.length === 1) stamp(pts[0][0], pts[0][1], R, v);
  }
  // avoid: extra cost along another leader's route (stretch the police over several streets)
  function stampPenalties(avoidPts) {
    pen.fill(0);
    for (const sq of sim.squads) { if (sq.transit || sq.van) continue; for (let k = 0; k < sq.na; k += 3) stamp(sq.ox[k], sq.oy[k], 24, 45); }
    for (const p of sim.police?.plan || []) {
      if (p.status === 'done' || !p.pts) continue;
      const near = hyp(p.x - goal.x, p.y - goal.y) < 120; // the last ring has to be crossed somewhere: cheaper
      const v = p.kind === 'hunt' || p.kind === 'response' ? 0 : p.status === 'planned' ? 18 : near ? 25 : 40;
      if (!v) continue;
      if (p.kind === 'cordon' || p.kind === 'kettle' || p.kind === 'funnel') stamp(p.x, p.y, (p.r || 25) + 12, v);
      else stampLine(p.pts, 14, v);
    }
    if (sim.gasBox && sim.gas) { const b = sim.gasBox, GC = sim.GC; for (let j = b.y0; j <= b.y1; j++) for (let i = b.x0; i <= b.x1; i++) { const g = sim.gas[j * sim.GCOLS + i]; if (g > 0.08) stamp((i + 0.5) * GC, (j + 0.5) * GC, 6, Math.round(20 * Math.min(1, g))); } }
    if (avoidPts) stampLine(avoidPts, 30, 12);
  }
  function planField(avoidPts, tx = goal.x, ty = goal.y) {
    const t0 = performance.now();
    stampPenalties(avoidPts);
    dist.fill(0x3fffffff);
    let t = sim.cellOf(tx, ty); if (!walk[t]) t = sim.nearestWalkable(Math.floor(tx / CELL), Math.floor(ty / CELL), 30);
    dist[t] = 0; ring[0].push(t);
    let pending = 1, cur = 0;
    while (pending > 0) {
      const b = ring[cur % NB];
      while (b.length) {
        const c = b.pop(); pending--;
        if (dist[c] !== cur) continue;
        for (let k = 0; k < 8; k++) {
          const n = c + DOFF[k]; if (!walk[n]) continue;
          if (k >= 4 && (!walk[c + DX[k]] || !walk[c + DY[k] * COLS])) continue;
          const nd = cur + Math.round(DC[k] * (1 + pen[n] * 0.12));
          if (nd < dist[n]) { dist[n] = nd; ring[nd % NB].push(n); pending++; }
        }
      }
      cur++;
    }
    state.plans++; state.planMs += performance.now() - t0;
  }
  // walk down the cost field from (x, y) for `ahead` m; returns { x, y, pts } (pts = the route, ~15 m apart)
  function along(x, y, ahead) {
    let c = sim.cellOf(x, y);
    if (!walk[c]) { c = sim.nearestWalkable(Math.floor(x / CELL), Math.floor(y / CELL), 10); if (c < 0) return null; }
    let acc = 0, mark = 0; const pts = [[x, y]];
    for (let s = 0; s < 3000 && acc < ahead; s++) {
      let best = dist[c], bk = -1;
      for (let k = 0; k < 8; k++) { const n = c + DOFF[k]; if (walk[n] && dist[n] < best) { if (k >= 4 && (!walk[c + DX[k]] || !walk[c + DY[k] * COLS])) continue; best = dist[n]; bk = k; } }
      if (bk < 0) break;
      c += DOFF[bk]; acc += DC[bk] * CELL / 10;
      if (acc - mark > 15) { mark = acc; pts.push([sim.cellX(c), sim.cellY(c)]); }
    }
    return { x: sim.cellX(c), y: sim.cellY(c), pts };
  }

  function routeAhead(pts, x, y, ahead) {
    if (!pts || pts.length < 2) return null;
    let bi = 0, bd = 1e18; for (let k = 0; k < pts.length; k++) { const d = (pts[k][0] - x) ** 2 + (pts[k][1] - y) ** 2; if (d < bd) { bd = d; bi = k; } }
    if (bd > 60 * 60) return null; // off the route: re-plan
    let acc = 0, k = bi; while (k + 1 < pts.length && acc < ahead) { acc += hyp(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]); k++; }
    return { x: pts[k][0], y: pts[k][1], end: k === pts.length - 1 };
  }

  // ------------------------------------------------------------ perception helpers
  function order(L, x, y, force) {
    const o = P(L);
    if (!force && o.wp && hyp(o.wp.x - x, o.wp.y - y) < 25 && !L.arrived) return false; // same order still running
    if (!sim.api.orderLeaders([L.id], x, y)) return false;
    o.wp = { x, y }; o.lastOrderT = sim.simTime; state.orders++;
    return true;
  }
  function stance(L, s) { if (L.stance !== s) { sim.api.setStance(L.id, s); state.stanceChanges++; } }
  function nearestCop(x, y) {
    const r = { d: 1e9, x: 0, y: 0, sq: null };
    for (const sq of sim.squads) {
      if (sq.van || sq.transit) continue;
      const bb = sq.bb; if (bb && (x < bb[0] - 120 || x > bb[2] + 120 || y < bb[1] - 120 || y > bb[3] + 120)) continue;
      for (let k = 0; k < sq.na; k++) { const d = hyp(sq.ox[k] - x, sq.oy[k] - y); if (d < r.d) { r.d = d; r.x = sq.ox[k]; r.y = sq.oy[k]; r.sq = sq; } }
    }
    for (const t of sim.snatchTeams || []) { const d = hyp(t.x - x, t.y - y); if (d < r.d) { r.d = d; r.x = t.x; r.y = t.y; } }
    return r;
  }
  function around(L, r) { // own followers / fleeing / unattached people near the leader
    const o = { own: 0, flee: 0, loose: 0 };
    sim.forEachNear(L.x, L.y, r, j => {
      const a = sim.act[j]; if (a === ACT.DOWN || a === ACT.ARRESTED || a === ACT.HOME) return;
      if (sim.lead[j] === L.id) o.own++;
      else if (sim.panicT[j] > 0) o.flee++;
      else if (sim.riot[j] < 0 && (sim.lapL?.[j] === L.id || sim.prevLead[j] === L.id)) o.loose++;
    });
    return o;
  }
  // a kettle / cordon / funnel that (nearly) encloses the leader
  function trap(L) {
    for (const p of sim.police?.plan || []) {
      if (p.status === 'done' || p.status === 'planned') continue;
      if (p.kind !== 'kettle' && p.kind !== 'cordon' && p.kind !== 'funnel') continue;
      const d = hyp(L.x - p.x, L.y - p.y); if (d < (p.r || 25) + 12) return p;
    }
    return null;
  }
  // the way out of a trap: the direction (of 16) with the clearest street and the fewest officers
  function escapePoint(L, p) {
    let best = null;
    for (let k = 0; k < 16; k++) {
      const a = k / 16 * Math.PI * 2, ux = Math.cos(a), uy = Math.sin(a);
      let d = 0; while (d < 140 && sim.walkAt(L.x + ux * (d + 2), L.y + uy * (d + 2))) d += 2;
      if (d < 20) continue;
      const tx = L.x + ux * d, ty = L.y + uy * d;
      let cops = 0;
      for (const sq of sim.squads) for (let q = 0; q < sq.na; q += 2) { const ex = sq.ox[q] - L.x, ey = sq.oy[q] - L.y, al = ex * ux + ey * uy; if (al > 0 && al < d + 10 && Math.abs(-ex * uy + ey * ux) < 12) cops++; }
      const sc = Math.min(d, 120) - cops * 25 - (p ? Math.max(0, 40 - hyp(tx - p.x, ty - p.y)) : 0);
      if (!best || sc > best.sc) best = { x: tx, y: ty, sc };
    }
    return best;
  }

  // ------------------------------------------------------------ briefing: spawn choice
  function briefing() {
    if (S.passive) return;
    const keys = Object.keys(sim.spawnPoints); if (!keys.length) return;
    const F = goalField();
    const byDist = keys.slice().sort((a, b) => { const p = sim.spawnPoints[a], q = sim.spawnPoints[b]; return sim.fieldDist(F, p[0], p[1]) - sim.fieldDist(F, q[0], q[1]); });
    const act = active();
    act.forEach((L, i) => {
      let k = byDist[0];
      if (S.careful && act.length >= 2) k = byDist[i % 2];          // two spawn points: two marches, two routes
      if (S.decoy && act.length >= 2 && i === act.length - 1) k = byDist[Math.min(byDist.length - 1, 2)]; // decoy from further east
      sim.api.chooseSpawn(L.id, k);
    });
  }
  let gF = null;
  function goalField() { return gF || (gF = sim.computeField(goal.x, goal.y)); }
  function dayStarted() {
    per.clear(); planT = 0; lastPlanSig = '';
    const act = active();
    // diversion: the leader with the most eastern / least useful spawn is the decoy
    if (S.decoy && act.length >= 2) {
      const F = goalField();
      const decoy = act.reduce((a, b) => (sim.fieldDist(F, b.x, b.y) > sim.fieldDist(F, a.x, a.y) ? b : a), act[0]);
      P(decoy).role = 'decoy';
    }
    pushGo = !S.decoy;
    // misdirection: the police only see the march, so the first march heads for a feint target (Opéra) and turns for the gate
    // once it is ~1100 m (path) from it; the police notice the turn only after its heading has visibly changed
    if (S.careful && !S.decoy && act.length) {
      const op = sim.LM?.operaGarnier, F = goalField();
      if (op && sim.fieldDist(F, act[0].x, act[0].y) > 1500) P(act[0]).feint = { name: 'operaGarnier', x: op[0], y: op[1] };
    }
  }

  // ------------------------------------------------------------ per-tick decisions (every 5 sim seconds)
  let planT = 0, lastPlanSig = '', pushGo = true;
  const routes = new Map(); // leader id -> route pts (for the "avoid" stamp)
  function planSig() { // a coarse signature of the visible police plan: re-plan when it changes
    let s = '';
    for (const p of sim.police?.plan || []) if (p.status !== 'done' && p.kind !== 'hunt' && p.kind !== 'response') s += p.kind[0] + Math.round(p.x / 40) + ',' + Math.round(p.y / 40) + p.status[0] + ';';
    return s;
  }
  function decoyTarget(L) {
    // the biggest uncontrolled riot / looting hotspot far from the main route, else the riot spawns
    let best = null, bs = -1e9;
    const mainL = active().find(o => P(o).role === 'main');
    for (const R of sim.riots || []) {
      if (!R.alive || R.count < 15) continue;
      const dm = mainL ? hyp(R.x - mainL.x, R.y - mainL.y) : 500, dd = hyp(R.x - L.x, R.y - L.y);
      const sc = R.count * (R.controlledBy === L.id ? 0.6 : 1) + Math.min(dm, 900) * 0.2 - dd * 0.15 + hyp(R.x - goal.x, R.y - goal.y) * 0.05;
      if (sc > bs) { bs = sc; best = { x: R.x, y: R.y, riot: R }; }
    }
    if (!best) for (const h of sim.crowdAI?.hot || []) { const sc = h.w * 10 - hyp(h.x - L.x, h.y - L.y) * 0.1; if (sc > bs) { bs = sc; best = { x: h.x, y: h.y }; } }
    return best;
  }
  function policeCommittedElsewhere() {
    // squads busy away from the main march: responses, ops on other targets, hunts; few in reserve
    const mains = active().filter(o => P(o).role === 'main');
    if (!mains.length) return true;
    let busy = 0, total = 0;
    for (const sq of sim.squads) {
      if (sq.hunt) continue; total++;
      const far = mains.every(L => hyp(sq.x - L.x, sq.y - L.y) > 500);
      if (far && (sq.role === 'response' || (sq.op && !mains.some(L => sq.op.target === 'L' + L.id)) || sq.role === 'relief')) busy++;
    }
    return total > 0 && busy >= Math.max(2, Math.round(total * 0.3));
  }

  function tick(dt) {
    if (S.passive) return;
    const d = sim.day; if (d.phase !== 'day' && d.phase !== 'dusk') return;
    const act = active(); if (!act.length) return;
    const hour = d.t / 3600;

    // ---------------- reckless: straight at the gate, Unleashed
    if (S.direct) {
      for (const L of act) {
        stance(L, S.stance);
        const o = P(L);
        if (!o.wp || (L.arrived && dGoal(L) > 15) || (sim.simTime - o.lastOrderT > 300 && (L.slowT || 0) > 30)) order(L, goal.x, goal.y, true);
      }
      return;
    }

    // ---------------- routing strategies
    planT -= dt;
    const sig = planSig();
    const replan = S.route && (planT <= 0 || (sig !== lastPlanSig && planT < 22));
    if (replan) { planT = 30; lastPlanSig = sig; }
    if (S.decoy && !pushGo && (hour >= 14.5 || (hour >= 11 && policeCommittedElsewhere()))) { pushGo = true; state.pushes++; }
    const strongest = act.reduce((a, b) => (b.count > a.count ? b : a), act[0]);
    let first = true;
    for (const L of act.slice().sort((a, b) => b.count - a.count)) {
      const o = P(L), dg = dGoal(L), final = dg < 260;
      // decoy: chaos elsewhere
      if (o.role === 'decoy' && !(final || (pushGo && hour >= 16.5))) {
        stance(L, 'unleashed');
        const t = (o.dT = (o.dT || 0) - dt) <= 0 || !o.dTgt ? (o.dT = 60, o.dTgt = decoyTarget(L)) : o.dTgt;
        if (t && hyp(t.x - L.x, t.y - L.y) > 30) { if (order(L, t.x, t.y)) state.decoyTrips++; }
        const cop = nearestCop(L.x, L.y); // don't get snatched: keep a distance from the lines
        if (cop.d < 30) { const e = escapePoint(L, null); if (e) order(L, e.x, e.y, true); }
        if (L.rallyCd <= 0 && around(L, 40).flee > 10) { if (sim.api.leaderAction(L.id, 'rally')) state.rallies++; }
        continue;
      }
      const cop = nearestCop(L.x, L.y);
      sim.gasSample(L.x, L.y); const gas = sim.gs.s;
      // 1. trapped in a kettle / cordon: scatter the crowd through the gaps and walk out
      const tr = S.scatter ? trap(L) : null;
      if (tr && o.mode !== 'escape') {
        const e = escapePoint(L, tr);
        if (e) {
          if ((tr.status === 'active' || tr.status === 'closing') && L.scatterCd <= 0 && sim.api.leaderAction(L.id, 'scatter')) state.scatters++;
          o.mode = 'escape'; o.fbT = 45; state.escapes++; order(L, e.x, e.y, true); stance(L, 'peaceful');
          continue;
        }
      }
      if (o.mode === 'escape' || o.mode === 'fallback') {
        o.fbT -= dt;
        if (o.fbT <= 0) { o.mode = 'march'; o.wp = null; if (S.rally && L.rallyCd <= 0 && sim.api.leaderAction(L.id, 'rally')) state.rallies++; }
        else continue;
      }
      // 1b. separated from the march (a human sees the leader marker far ahead of its dots): walk back to the crowd and Rally
      if (L.count >= 60) {
        let n20 = 0, cx = 0, cy = 0, n = 0;
        for (let i = 0; i < sim.NA; i++) if (sim.lead[i] === L.id) { const dx = sim.px[i] - L.x, dy = sim.py[i] - L.y; if (dx * dx + dy * dy < 400) n20++; cx += sim.px[i]; cy += sim.py[i]; n++; }
        if (n && n20 < Math.max(12, 0.04 * L.count) && hyp(cx / n - L.x, cy / n - L.y) > 30) {
          const c = sim.nearestWalkable(Math.floor(cx / n / CELL), Math.floor(cy / n / CELL), 15);
          if (c >= 0) { o.mode = 'fallback'; o.fbT = 25; state.regroups = (state.regroups || 0) + 1; order(L, sim.cellX(c), sim.cellY(c), true); }
          if (S.rally && L.rallyCd <= 0 && sim.api.leaderAction(L.id, 'rally')) state.rallies++;
          continue;
        }
      }
      // 2. exposed (few own people around, police close, or deep gas): fall back into the crowd
      const near = around(L, 12);
      if (!final && ((near.own < 6 && cop.d < 25) || gas > 0.6)) {
        let ax = L.x - cop.x, ay = L.y - cop.y; if (cop.d > 200 || gas > 0.6) { ax = -(sim.gs.gx || 0); ay = -(sim.gs.gy || 0); }
        const l = hyp(ax, ay) || 1; ax /= l; ay /= l;
        const c = sim.nearestWalkable(Math.floor((L.x + ax * 45) / CELL), Math.floor((L.y + ay * 45) / CELL), 12);
        if (c >= 0) { o.mode = 'fallback'; o.fbT = 30; state.fallbacks++; order(L, sim.cellX(c), sim.cellY(c), true); stance(L, 'peaceful'); }
        if (S.rally && L.rallyCd <= 0 && sim.api.leaderAction(L.id, 'rally')) state.rallies++;
        continue;
      }
      // 3. diversion: the main march waits out of reach (gathers, Peaceful) until the police are committed elsewhere
      if (S.decoy && !pushGo && o.role === 'main') {
        stance(L, 'peaceful');
        if (!o.holdPt) { const F = goalField(); o.holdPt = null; // a point ~1300 m (path) from the gate on our side
          let c = sim.cellOf(L.x, L.y); for (let s = 0; s < 3000 && sim.fieldDist(F, sim.cellX(c), sim.cellY(c)) > 1300; s++) { const code = F.dir[c]; if (code >= 8) break; c += DOFF[code]; }
          o.holdPt = { x: sim.cellX(c), y: sim.cellY(c) }; }
        if (hyp(o.holdPt.x - L.x, o.holdPt.y - L.y) > 30) order(L, o.holdPt.x, o.holdPt.y);
        if (S.rally && L.rallyCd <= 0 && (L.arrived || L.count < o.lastCount * 0.85)) { if (sim.api.leaderAction(L.id, 'rally')) state.rallies++; }
        o.lastCount = L.count;
        continue;
      }
      // 4. riots near the route: detour to win them over (not on the final approach, not under fire)
      if (S.riots && !final && dg > 500 && cop.d > 60) {
        if (o.mode === 'riot') {
          const R = (sim.riots || []).find(r => r.id === o.riot);
          if (!R || !R.alive || R.controlledBy === L.id || R.count < 10 || hyp(R.x - L.x, R.y - L.y) > 450 || sim.simTime - o.riotT > 900) { o.mode = 'march'; o.riot = -1; o.wp = null; }
          else { order(L, R.x, R.y); }
        } else {
          let best = null, bd = 350;
          for (const R of sim.riots || []) {
            if (!R.alive || R.count < 25 || R.controlledBy >= 0 || hyp(R.x - goal.x, R.y - goal.y) < 300) continue;
            if (act.some(o2 => o2 !== L && P(o2).riot === R.id)) continue;
            const dd = hyp(R.x - L.x, R.y - L.y); if (dd < bd) { bd = dd; best = R; }
          }
          if (best) { o.mode = 'riot'; o.riot = best.id; o.riotT = sim.simTime; state.riotDetours++; order(L, best.x, best.y, true); }
        }
      }
      // 5. march along the cost field (re-planned; the second march avoids the first one's route)
      if (o.mode === 'march') {
        // feint phase: head for the feint target until ~1100 m (path) from the gate or close to the target, then turn
        const fe = o.feint && !o.feintDone ? o.feint : null;
        if (fe && (hyp(fe.x - L.x, fe.y - L.y) < 300 || sim.fieldDist(goalField(), L.x, L.y) < 1100 || hour > 13)) { o.feintDone = true; state.feintTurns = (state.feintTurns || 0) + 1; o.route = null; }
        const tgt = opts.target?.(sim, L) || (o.feint && !o.feintDone ? o.feint : goal); // opts.target: hook for future intermediate objectives
        let wp = null;
        if (replan || !o.route || L.arrived || !o.wp || hyp(o.wp.x - L.x, o.wp.y - L.y) < 50) {
          if (replan || !o.route) {
            const other = first ? null : routes.get(strongest.id);
            planField(other && L !== strongest ? other : null, tgt.x, tgt.y);
            const a = along(L.x, L.y, 1e9); o.route = a ? a.pts : null; if (a) routes.set(L.id, a.pts);
          }
          wp = final ? { x: goal.x, y: goal.y } : routeAhead(o.route, L.x, L.y, 280);
          if (!wp && !final) { o.route = null; planT = Math.min(planT, 5); }
          if (wp) order(L, wp.x, wp.y, !o.wp);
        }
      }
      first = false;
      // 6. stance: Peaceful near the police (unless pushing the last line), Firm marching, Unleashed at the gate
      stance(L, final ? 'firm' : cop.d < 55 ? 'peaceful' : 'firm');
      // 7. Rally: after gas, when people flee, or when the crowd has lapsed (people around but few attached)
      if (S.rally && L.rallyCd <= 0) {
        const a40 = around(L, 45);
        const lapsed = L.count < o.lastCount * 0.8 || a40.loose > 25;
        if (gas > 0.1 || a40.flee > 10 || lapsed || (final && L.count < 400)) { if (sim.api.leaderAction(L.id, 'rally')) state.rallies++; }
      }
      o.lastCount = Math.max(L.count, o.lastCount * 0.98);
    }
  }
  return { strategy, briefing, dayStarted, tick, state };
}

// ============================================================ logger: per-day stats, hourly timeline, leader tracks, stalls
const hhmm = t => `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}`;
const HOURLY = ['loot', 'fire', 'throw', 'brawl', 'arrest', 'injury', 'gas', 'charge', 'brutality', 'officerDown', 'explosion', 'kettle', 'cordon', 'funnel', 'split', 'riotJoined', 'lineBroken', 'gateBreach'];
export function createLogger(sim, bot) {
  const days = [];
  let D = null, sampleT = 0, hourIdx = -1;
  const pc = () => ({ ...(sim.police?.counts || {}) });
  sim.onEvent(e => {
    if (!D) return;
    const ph = sim.day.phase; if (ph !== 'day' && ph !== 'dusk' && e.type !== 'campaignWon' && e.type !== 'campaignLost') return;
    D.events[e.type] = (D.events[e.type] || 0) + 1;
    const H = D.hours[D.hours.length - 1];
    if (H && HOURLY.includes(e.type) && !(e.phase && e.phase !== 'deploy')) H[e.type] = (H[e.type] || 0) + 1;
    if (e.type === 'brutality') { const k = (e.kind || '?') + (e.leader != null ? ':leader' : ''); D.brutality[k] = (D.brutality[k] || 0) + 1; }
    if (e.type === 'throw' && e.owner === 'C') D.crowdThrows++;
    if (e.type === 'promoted' && e.successor) D.successors = (D.successors || 0) + 1; // v1.8
    if (e.type === 'injury') D.injuries[e.kind || '?'] = (D.injuries[e.kind || '?'] || 0) + 1;
    if ((e.type === 'kettle' || e.type === 'cordon' || e.type === 'funnel' || e.type === 'split') && e.phase === 'deploy') D.ops.push({ type: e.type, t: hhmm(sim.day.t) });
    if (e.type === 'arrest' && e.leader != null) {
      const L = sim.leaders[e.leader]; let own = 0; sim.forEachNear(L.x, L.y, 10, j => { if (sim.lead[j] === L.id) own++; });
      sim.gasSample(L.x, L.y);
      D.leaderArrests.push({ t: hhmm(sim.day.t), leader: L.name, dGoal: Math.round(hyp(L.x - sim.goal.x, L.y - sim.goal.y)), count: L.count, own10: own, gas: +sim.gs.s.toFixed(2), esc: sim.police.escalation, stance: L.stance, by: e.by, expMult: e.expMult, kettled: !!L.pexp?.kettled, successor: !!L.successor }); // v1.8: by, expMult, kettled, successor
    }
  });
  let stepAcc = 0, stepN = 0, stepMax = 0, winAcc = 0, winN = 0, hourC0 = null;
  function dayStart() {
    D = { day: sim.day.day, hours: [], tracks: {}, stalls: [], ops: [], leaderArrests: [], start: pc(), crowd0: sim.day.carry?.crowd ?? 0, events: {}, brutality: {}, injuries: {}, crowdThrows: 0,
      minGoal: 1e9, stallS: 0, gapT0: sim.simTime, peakNA: 0, msHour: [], leaders0: sim.leaders.filter(L => !L.arrested && !L.gone).length };
    hourIdx = -1; sampleT = 0; stepAcc = stepN = stepMax = 0;
  }
  function closeHour() {
    const H = D.hours[D.hours.length - 1]; if (!H) return;
    H.ms = stepN ? +(stepAcc / stepN).toFixed(2) : 0; H.msMax = +stepMax.toFixed(2);
    const c = pc(); for (const k of ['snatches', 'gas', 'charges', 'arrests', 'huntArrests', 'gaps', 'retasks']) H['p_' + k] = (c[k] || 0) - (hourC0[k] || 0);
  }
  const stallSt = new Map();
  function sample(dt) {
    const d = sim.day, t = d.t, h = Math.floor(t / 3600);
    if (h !== hourIdx) {
      if (hourIdx >= 0) closeHour();
      stepAcc = stepN = stepMax = 0; hourIdx = h; hourC0 = pc();
      D.hours.push({ h, followers: 0, NA: 0, looters: 0, fighters: 0, throwers: 0, fires: 0, riotMembers: 0, esc: 0 });
    }
    const H = D.hours[D.hours.length - 1];
    let fol = 0; for (const L of sim.leaders) if (!L.arrested && !L.gone) fol += L.count;
    let looters = 0, fighters = 0, throwers = 0, riotM = 0; const NA = sim.NA;
    for (let i = 0; i < NA; i++) { const a = sim.act[i]; if (a === ACT.LOOT) looters++; else if (a === ACT.FIGHT) fighters++; else if (a === ACT.THROW) throwers++; if (sim.riot[i] >= 0) riotM++; }
    H.followers = Math.max(H.followers, fol); H.NA = Math.max(H.NA, NA); H.looters = Math.max(H.looters, looters); H.fighters = Math.max(H.fighters, fighters); H.throwers = Math.max(H.throwers, throwers);
    H.fires = Math.max(H.fires, (sim.fires || []).length); H.riotMembers = Math.max(H.riotMembers, riotM); H.esc = Math.max(H.esc, sim.police?.escalation || 0);
    D.peakNA = Math.max(D.peakNA, NA);
    for (const L of sim.leaders) {
      if (L.gone || L.arrested) continue;
      D.minGoal = Math.min(D.minGoal, hyp(L.x - sim.goal.x, L.y - sim.goal.y));
      // stall time: an ordered leader (not arrived) that moved < 0.15 m/s over the sample
      const s = stallSt.get(L);
      if (s && s.F === L.field && !L.arrived && hyp(L.x - s.x, L.y - s.y) < 0.15 * dt) D.stallS += dt;
      // stall episodes: no progress toward the order target for 120 s
      if (!s || s.F !== L.field || L.arrived) stallSt.set(L, { t: sim.simTime, prog: L.prog, x: L.x, y: L.y, F: L.field, t0: sim.simTime, p0: L.prog });
      else {
        s.x = L.x; s.y = L.y;
        if (sim.simTime - s.t0 >= 120) { if (s.p0 - L.prog < 8 && L.prog > 15) D.stalls.push(diagnose(L)); s.t0 = sim.simTime; s.p0 = L.prog; }
      }
    }
  }
  function diagnose(L) {
    let cop = 1e9, sqState = '';
    for (const sq of sim.squads) for (let k = 0; k < sq.na; k++) { const dd = hyp(sq.ox[k] - L.x, sq.oy[k] - L.y); if (dd < cop) { cop = dd; sqState = sq.state + '/' + sq.tactic; } }
    sim.gasSample(L.x, L.y);
    const dens = sim.countNear(L.x, L.y, 1.5);
    const cause = cop < 5 ? 'police' : sim.gs.s > 0.3 ? 'gas' : dens >= 7 ? 'crowd' : L.energy < 20 ? 'tired' : 'other';
    return { t: hhmm(sim.day.t), leader: L.name, x: Math.round(L.x), y: Math.round(L.y), prog: Math.round(L.prog), cause, cop: Math.round(cop), sqState, gas: +sim.gs.s.toFixed(2), dens, count: L.count };
  }
  function tick(dt) { sampleT -= dt; if (sampleT <= 0) { sample(5 - sampleT); sampleT = 5; } }
  function stepMs(ms) { stepAcc += ms; stepN++; winAcc += ms; winN++; if (winN >= 25) { const w = winAcc / winN; if (w > stepMax) stepMax = w; winAcc = winN = 0; } }
  function dayEnd() {
    if (!D || D.done) return;
    D.done = true; closeHour();
    const h = sim.day.history.find(x => x.day === D.day) || sim.day.stats, end = pc(), st = {};
    for (const k in end) st[k] = (end[k] || 0) - (D.start[k] || 0);
    const gaps = (sim.police?.gaps || []).filter(g => g.t >= D.gapT0);
    const gapWhy = {}; for (const g of gaps) { const k = g.kind + ':' + g.why; gapWhy[k] = (gapWhy[k] || 0) + 1; }
    let fol = 0; for (const L of sim.leaders) if (!L.arrested && !L.gone) fol += L.count;
    D.stats = { crowd0: D.crowd0, peak: h.peak, end: sim.day.result?.win ? sim.day.result.count : fol, riotsJoined: h.riotsJoined, riotJoined: h.riotJoined, looted: h.looted, lootGrabs: h.lootGrabs, fires: h.fires,
      explosions: h.explosions, throws: D.crowdThrows, brawls: h.brawls, arrests: h.arrests, leadersArrested: (h.leadersArrested || []).join(','), injured: h.injured,
      officersDown: st.officersDown || 0, brutality: h.brutality || 0, gas: st.gas || 0, charges: st.charges || 0, lbd: st.lbd || 0, snatches: st.snatches || 0, huntArrests: st.huntArrests || 0,
      blocks: st.blocks || 0, kettles: st.kettles || 0, cordons: st.cordons || 0, funnels: st.funnels || 0, splits: st.splits || 0, hunts: st.hunts || 0, retasks: st.retasks || 0, vanTrips: st.vanTrips || 0,
      gaps: st.gaps || 0, lineBreaks: st.lineBreaks || 0, gateBreaches: st.gateBreaches || 0, lineArrests: st.lineArrests || 0, intelTurns: st.intelTurns || 0, reinforcements: st.reinforcements || 0, minGoal: Math.round(D.minGoal), stallMin: Math.round(D.stallS / 60), stalls: D.stalls.length,
      reason: h.reason || sim.day.endReason || sim.day.result?.reason || '', leaders0: D.leaders0 ?? 0, successors: D.successors || 0, held: sim.day.carry?.held ?? null, leaderArrests: D.leaderArrests.length, objectives: (h.objectives || []).map(o => o.id + ':' + o.status).join(','), peakNA: D.peakNA, maxEsc: Math.max(0, ...D.hours.map(x => x.esc)) };
    D.gapWhy = gapWhy;
    D.police = st;
    D.bot = { ...bot.state };
    days.push(D);
  }
  function progressLine() {
    const d = sim.day;
    let fol = 0; for (const L of sim.leaders) if (!L.arrested && !L.gone) fol += L.count;
    return `day ${d.day} ${hhmm(d.t)} ${d.phase} fol=${fol} NA=${sim.NA} fires=${(sim.fires || []).length} loot=${d.stats.looted} arr=${d.stats.arrests} inj=${d.stats.injured} brut=${d.stats.brutality} offDown=${d.stats.officersDown} esc=${sim.police?.escalation} ms=${stepN ? (stepAcc / stepN).toFixed(2) : '-'} ` +
      sim.leaders.filter(L => !L.gone).map(L => `${L.name}:${L.arrested ? 'ARR' : L.count}@${Math.round(hyp(L.x - sim.goal.x, L.y - sim.goal.y))}m`).join(' ');
  }
  function result() {
    const r = sim.day.result;
    return {
      summary: { strategy: bot.strategy, win: !!(r && r.win), reason: r ? r.reason : 'stopped', day: r ? r.day : sim.day.day, at: r ? hhmm(r.at) : '', text: r ? r.text : '',
        days: days.map(d => ({ day: d.day, ...d.stats, msAvg: +(d.hours.reduce((a, h) => a + (h.ms || 0), 0) / Math.max(1, d.hours.length)).toFixed(2), msPeak: Math.max(0, ...d.hours.map(h => h.msMax || 0)) })) },
      days,
    };
  }
  return { dayStart, dayEnd, tick, stepMs, progressLine, result };
}
