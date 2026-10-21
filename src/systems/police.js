/// Police system v1.6 (Phase 3b). Owns sim.squads, sim.snatchTeams and sim.police.
// - Physical squads: per-officer hp (downed officers drop out and are dragged back), shield-line push,
//   lines that give ground under crowd pressure and break when overwhelmed and tired, charges (bond offensif),
//   fatigue (energy) that drains with action and recovers in reserve.
// - Less-lethal weapons through combat projectiles ('gas', 'lbd', 'flashbang'), with direct fallbacks when combat is a stub.
// - Sommations: 2 warnings ~6 s apart, once per area per hour, before force on a crowd (none needed once attacked).
// - Snatch teams (BRAV-M style) that arrest isolated offenders and exposed leaders; detached hunt teams sweep stragglers.
// - Composable tactics: block, perimeter, advance (push), charge, split, kettle / cordon with filter exit, funnel / fish trap.
// - v1.6 global coordination layer (docs/police-tactics.md §6, user feedback 2026-10-18):
//   world model every ~12 s (protester groups: marches, riots, loose clusters; size, aggression, heading, predicted route
//   to the Elysee -> sim.police.predict), planner (perimeter >= 2 squads on the approach streets, early blocks at the
//   narrowest reachable point of each threatening route, cordons / kettles / funnels / splits, responses to looting and
//   fires, hunts) -> sim.police.plan, fast van transit (sq.transit, sq.dest), escalation 0-4, limited reinforcements.
// Squad fields read by the renderers: x, y, dx, dy, pxu, pyu, n, ox, oy, state, energy, adv, id, van/transit, dest, tactic.
// Officers 0..na-1 are active (front row first: 0..nFront-1); na..n-1 are downed officers being dragged back.
import { clamp, ACT } from '../common.js';

const A_LOOT = ACT.LOOT, A_FIGHT = ACT.FIGHT, A_THROW = ACT.THROW, A_PUSH = ACT.PUSH, A_DOWN = ACT.DOWN, A_ARRESTED = ACT.ARRESTED, A_FLEE = ACT.FLEE;
const A_HOME = ACT.HOME ?? 255;
const CAP = 64;                 // officer slots per squad
const SQ_N = 24;                // default section strength
const SPACING = 1.05, ROW_GAP = 1.3;
const V_MOVE = 1.6, V_PUSH = 0.5, V_PUSH_FREE = 0.9, V_CHARGE = 4.4, V_OFF = 2.6; // v1.6: on foot 1.6 (was 1.2)
const STR_PER_OFF = 3.0;        // line strength per officer, in "pressing protester" units (vs crowd sq.pressure x pressureScale)
const THINK = 0.5;              // squad think period (s)
const OFFENCE_WINDOW = 20;      // force on someone without a visible offence in the last 20 s = brutality
// v1.6 sommations: 2 warnings WARN_GAP s apart, once per area (WARN_AREA_R m) per WARN_AREA_T s; force WARN_READY s after the 2nd
const WARN_GAP = 6, WARN_READY = 2, WARN_AREA_R = 160, WARN_AREA_T = 3600;
// v1.6 global coordination layer: world model + planner every INTEL_PERIOD s (urgent events: after >= INTEL_MIN s)
const INTEL_PERIOD = 12, INTEL_MIN = 6, MAX_OPS = 3, DWELL = 25, BIN = 40;
const BASE_ESC = [1, 1.3, 1.6, 2, 2, 2.3, 2.6]; // escalation floor by day
const PERIM_R = 110;            // v1.7: planner perimeter posts on the approach streets ~110 m out (v1.6: 65 m, now the gate guard's ring)
// v1.7 gate guard (Garde républicaine at the Élysée): a fixed line on every street GATE_R m from the gate, outside the planner (manual
// squads, never re-tasked or relieved). They give ground down to GOAL_HOLD m; overwhelmed (the broken rule) the line is BREACHED: it
// opens a gap of up to GATE_GAP m for GATE_BREACH_T s (the crowd and its leader can walk through), then closes again.
const GATE_R = 65, GATE_GAP = 6, GATE_BREACH_T = 40, GATE_STR = 1.8, GATE_BREAK_T = 8;
// v1.8: the gate guard is stronger on the first days (barriers, fresh reserves) and when the streets are calm: strength x GATE_STR_DAY[day]
// x (1 + GATE_CALM x (1 - sim.day.intensity)); after a breach closes the line is re-armed (fresh officers, +GATE_REARM_E energy) and
// cannot be breached again for GATE_REARM s (v1.7: re-breached every ~48 s, the day-1 win at 09:22 / 10:05)
const GATE_STR_DAY = [2.2, 2.0, 1.85, 1.8, 1.8, 1.8, 1.8], GATE_CALM = 0.8, GATE_REARM = 120, GATE_REARM_E = 25;
const GATE_BREACH_INT = 0.35; // v1.8: no breach while sim.day.intensity < 0.35 (never on day 1, day 2 only ~13:30-17:30; reinforcements stand by)
const GATE_GIVE = 0;       // v1.8: a gate line gives no ground (its post is the narrow point of the street) (v1.7: down to GOAL_HOLD 46 m, where the streets open into the square and an 8 m line no longer closes them: the day-1 win at 09:05)
const BLOCK_MIN_AHEAD = 110, BLOCK_WINDOW = 320, BLOCK_MAX_AHEAD = 1100, BLOCK_MIN_DG = 170; // m along the predicted route
// v1.6 brutal: more gas, sooner; more charges
const GAS_CD0 = 9, GAS_CD1 = 7, GAS_MASS = 8, GAS_SKIP = 0.3, GAS_CORE = 14, // [behaviour] gas every 9-16 s (v1.7: 14-24 s), from 8 people (v1.7: 10); skip ground above 0.3
   CHARGE_CD0 = 22, CHARGE_CD1 = 12, CHARGE_FRONT = 4, SNATCH_CD0 = 16, SNATCH_CD1 = 10;
// riot gear: damage multiplier per hit kind (helmet, shield, body armour)
// v1.6 (v1.5: melee .25, rock .3, paving .35, bottle .3, firework .3, molotov .45, fire .4, blast .5; v1.4: .35/.5/.5/.45/.5/.6/.6/.6)
const ARMOUR = { melee: 0.24, rock: 0.3, paving: 0.34, bottle: 0.3, firework: 0.3, molotov: 0.45, fire: 0.4, blast: 0.5, lbd: 0.5, flashbang: 0.3, gas: 0.1 };
const HP_REGEN = 0.005;         // officer hp/s recovered when the squad has not been hit for 20 s (bruises, rotation)
// v1.6 fast transit ("vans", sq.transit): a squad ordered further than VAN_MIN m with no protesters within VAN_CLEAR_R m rides at
// V_VAN along the streets; it dismounts VAN_DISMOUNT m before the destination or when protesters close in (VAN_STOP_R), and
// re-mounts on foot legs once the street is clear again. Mounted squads are drawn as vans and are not obstacles / targets.
const VAN_MIN = 80, V_VAN = 6.5, VAN_DISMOUNT = 40, VAN_CLEAR_R = 60, VAN_CLEAR_N = 8, VAN_STOP_R = 28, VAN_SIZE = 8;
const GAS_STOCK = 100;          // [behaviour] canisters a squad carries (v1.7: 40); restocked at rest / in reserve / each morning, and by supply vans on duty
const GAS_RESUPPLY = 30, GAS_RESUPPLY_LOW = 6, GAS_LOW = 25; // [behaviour] s per canister brought up on duty while not in contact (faster below GAS_LOW)
const HEAT_WIN = 0.7;
const GRAB_R = 3, GRAB_ALLIES = 1, GRAB_CD0 = 7, GRAB_CD1 = 7; // v1.7 line arrests (lineGrab); first pass 2 allies, 4-8 s: 400-1000 line arrests a day
// v1.7 march intelligence (inferred destinations, see inferMarch)
const TRACK_DT = 5, TRACK_KEEP = 400, TRACK_W = 120, TRACK_W_HELI = 60, DEST_K = 3.5, DEST_SMOOTH = 0.5, DEST_PRIOR_GATE = 0.4;
const DEST_KEYS = ['concorde', 'madeleine', 'operaGarnier', 'tuileries', 'palaisRoyal', 'louvre', 'pontNeuf', 'chatelet', 'hotelDeVille', 'notreDame'];           // v1.7: max escalation heat gained per 10 sim-minutes (v1.6: 1.0, v1.5: 0.6)
const HUNT_N = 8;               // officers in a detached hunt team
// v1.8 leader exposure (L.pexp): every EXP_DT s each active leader with fewer than EXP_OWN own (non-panicking) followers within
// EXP_R m and fewer than EXP_DENSE people within 5 m accumulates exposure at a rate set by its risk (stance, distance to the gate,
// crowd size, escalation 4, kettled, charged); otherwise exposure drains EXP_DECAY x faster. A leader becomes a target (snatch,
// hunt, line grab) only when ready: exposure >= EXP_T and escalation >= 3 (>= 2 when unleashed or within 700 m of the gate;
// a kettle only speeds exposure up). A leader inside a dense core of its march cannot be taken until a kettle, a charge or gas breaks the core.
const EXP_DT = 0.5, EXP_R = 15, EXP_OWN = 8, EXP_DENSE = 12, EXP_T = 60, EXP_DECAY = 2, EXP_MULT_MAX = 6; // (rate capped: at least ~10 s exposed; v1.8 tuning: EXP_T 60, was 40)
const EXP_STANCE = { peaceful: 0.4, firm: 1, unleashed: 2.5 };
// v1.8 custody: every squad (or hunt team) processes at most CUSTODY_CAP ordinary arrests per CUSTODY_T s (vans, escorts, paperwork);
// a squad at capacity stops line grabs, stray / offender snatches and kettle filter arrests until it frees up. Leaders are exempt.
// (Playtests: 500-900 arrests a day dissolved every march by noon and the crowd shrank day over day.)
const CUSTODY_CAP = 3, CUSTODY_T = 600;
// ... and the whole force at most CUST_POOL arrests at once, refilled at CUST_H0 + CUST_HD x day per hour (the vans and the
// station; ~250-400 ordinary arrests over a full day, v1.7 runs made 500-900 and dissolved every march)
const CUST_POOL = 25, CUST_H0 = 15, CUST_HD = 4;
const EXP_DAY = [0.25, 0.4, 0.7, 1, 1, 1, 1]; // exposure rate by day (the first days are gentler)

export default function create(sim) {
  const { walkAt, nearestWalkable, cellX, cellY, CELL, px, py, vx, vy, lead, act, tgt, hp, aggr, riot, panicT, extFx, extFy, gone,
    rand, forEachNear, countNear, computeField, fieldDir, fieldDist, tracePath, makePanic, removeAgent, moveWithWalls, MAXA } = sim;
  const uid = sim.registerAgentArray(new Int32Array(MAXA), 0);        // stable ids for agents police track (lazy)
  const lastOff = sim.registerAgentArray(new Float32Array(MAXA), -1e9); // sim time of the last visible offence (LOOT/FIGHT/THROW)
  let uidSerial = 0, squadSerial = 0, teamSerial = 0, opSerial = 0;
  let squads, teams, police, arrestees, ops;
  let T = 0, geo = null, lastPhase = null, offScan = 0, shopScanT = 0, shopSnap = null;
  const fieldCache = new Map(); // key -> field (LRU)
  const tmp = { x: 0, y: 0 };

  // ===================================================================== helpers
  const hyp = Math.hypot;
  function snapWalk(x, y, r = 30) {
    if (walkAt(x, y)) return { x, y };
    const c = nearestWalkable(Math.floor(x / CELL), Math.floor(y / CELL), r);
    return c < 0 ? null : { x: cellX(c), y: cellY(c) };
  }
  function walkExtent(x, y, ux, uy, max) { let d = 0; while (d < max && walkAt(x + ux * (d + 0.5), y + uy * (d + 0.5))) d += 0.5; return d; }
  function getField(x, y) {
    const p = snapWalk(x, y); if (!p) return null;
    const key = Math.floor(p.x / 6) + ',' + Math.floor(p.y / 6);
    let F = fieldCache.get(key);
    if (F) { fieldCache.delete(key); fieldCache.set(key, F); return F; }
    const t0 = performance.now(); F = computeField(p.x, p.y); pt('fullField', t0); if (!F) return null;
    police.fields = (police.fields || 0) + 1;
    fieldCache.set(key, F);
    if (fieldCache.size > 8) fieldCache.delete(fieldCache.keys().next().value);
    return F;
  }
  // ---- v1.6 bounded flow fields: Dial's algorithm (same costs as sim.computeField) restricted to a box around the target and
  // the source. A full-map field costs ~35 ms; police re-task often, so they use these (typically 1-5 ms) and fall back to a
  // full field only when the box does not connect the two points. fDir / fDist / fPath accept both kinds of field.
  const UN = 65535, DX8 = [1, -1, 0, 0, 1, 1, -1, -1], DY8 = [0, 0, 1, -1, 1, -1, 1, -1], DC8 = [10, 10, 10, 10, 14, 14, 14, 14];
  const DV8X = DX8.map((d, k) => d / Math.hypot(d, DY8[k])), DV8Y = DY8.map((d, k) => d / Math.hypot(DX8[k], d));
  const bkts = Array.from({ length: 15 }, () => []);
  const prof = {}; const pt = (k, t0) => { prof[k] = (prof[k] || 0) + performance.now() - t0; };
  function boxField(tx, ty, sx, sy, margin = 120) { const t0 = performance.now(); const F = boxField0(tx, ty, sx, sy, margin); pt('boxField', t0); return F; }
  function boxField0(tx, ty, sx, sy, margin) {
    const t = snapWalk(tx, ty, 30); if (!t) return null;
    const COLS = sim.COLS, ROWS = sim.ROWS, walk = sim.walk, m = Math.ceil(margin / CELL);
    const x0 = Math.max(1, Math.floor(Math.min(t.x, sx) / CELL) - m), x1 = Math.min(COLS - 2, Math.floor(Math.max(t.x, sx) / CELL) + m);
    const y0 = Math.max(1, Math.floor(Math.min(t.y, sy) / CELL) - m), y1 = Math.min(ROWS - 2, Math.floor(Math.max(t.y, sy) / CELL) + m);
    const w = x1 - x0 + 1, h = y1 - y0 + 1, n = w * h;
    const dist = new Uint16Array(n).fill(UN), dir = new Uint8Array(n).fill(255);
    const tc = (Math.floor(t.y / CELL) - y0) * w + Math.floor(t.x / CELL) - x0;
    dist[tc] = 0; bkts[0].push(tc);
    let pending = 1, cur = 0;
    while (pending > 0) {
      const b = bkts[cur % 15];
      while (b.length) {
        const c = b.pop(); pending--;
        if (dist[c] !== cur) continue;
        const cx = c % w, cy = (c - cx) / w, g = (cy + y0) * COLS + cx + x0;
        for (let k = 0; k < 8; k++) {
          const nx = cx + DX8[k], ny = cy + DY8[k]; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (!walk[g + DX8[k] + DY8[k] * COLS]) continue;
          if (k >= 4 && (!walk[g + DX8[k]] || !walk[g + DY8[k] * COLS])) continue;
          const nd = cur + DC8[k], ln = ny * w + nx;
          if (nd < dist[ln] && nd < UN) { dist[ln] = nd; bkts[nd % 15].push(ln); pending++; }
        }
      }
      cur++;
    }
    for (let c = 0; c < n; c++) {
      const d = dist[c]; if (d === UN) continue;
      if (d === 0) { dir[c] = 8; continue; }
      const cx = c % w, cy = (c - cx) / w, g = (cy + y0) * COLS + cx + x0;
      let best = d, bk = 255;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX8[k], ny = cy + DY8[k]; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const dn = dist[ny * w + nx];
        if (dn < best) { if (k >= 4 && (!walk[g + DX8[k]] || !walk[g + DY8[k] * COLS])) continue; best = dn; bk = k; }
      }
      dir[c] = bk;
    }
    police.boxFields = (police.boxFields || 0) + 1;
    return { box: true, x0, y0, w, h, dist, dir, tx: t.x, ty: t.y };
  }
  function fDist(F, x, y) {
    if (F.path) return pathDist(F, x, y);
    if (!F.box) return fieldDist(F, x, y);
    const i = Math.floor(x / CELL) - F.x0, j = Math.floor(y / CELL) - F.y0;
    if (i < 0 || j < 0 || i >= F.w || j >= F.h) return Infinity;
    const d = F.dist[j * F.w + i]; return d === UN ? Infinity : d * CELL / 10;
  }
  function fDir(F, x, y, out) {
    if (F.path) return pathDir(F, x, y, out);
    if (!F.box) return fieldDir(F, x, y, out);
    const fx = x / CELL - 0.5, fy = y / CELL - 0.5, i0 = Math.floor(fx), j0 = Math.floor(fy), li = i0 - F.x0, lj = j0 - F.y0;
    if (li < 0 || lj < 0 || li >= F.w - 1 || lj >= F.h - 1) return false;
    const ax = fx - i0, ay = fy - j0; let vx2 = 0, vy2 = 0;
    for (let q = 0; q < 4; q++) {
      const di = q & 1, dj = q >> 1, wq = (di ? ax : 1 - ax) * (dj ? ay : 1 - ay), code = F.dir[(lj + dj) * F.w + li + di];
      if (code < 8) { vx2 += DV8X[code] * wq; vy2 += DV8Y[code] * wq; }
      else if (code === 8) { const ex = F.tx - x, ey = F.ty - y, l = Math.hypot(ex, ey) || 1; vx2 += ex / l * wq; vy2 += ey / l * wq; }
    }
    const l = Math.hypot(vx2, vy2); if (l < 1e-3) return false;
    out.x = vx2 / l; out.y = vy2 / l; return true;
  }
  function fPath(F, x, y) {
    if (F.path) return F.pts.slice();
    if (!F.box) return tracePath(F, x, y);
    const pts = [x, y]; let i = Math.floor(x / CELL) - F.x0, j = Math.floor(y / CELL) - F.y0, steps = 0;
    while (steps++ < 4000 && i >= 0 && j >= 0 && i < F.w && j < F.h) {
      const code = F.dir[j * F.w + i]; if (code >= 8) break;
      i += DX8[code]; j += DY8[code];
      if (steps % 3 === 0) pts.push((i + F.x0 + 0.5) * CELL, (j + F.y0 + 0.5) * CELL);
    }
    pts.push(F.tx, F.ty); return pts;
  }
  // ---- v1.6 A* path "fields" for squad transit: a weighted A* (8-connected, no corner cutting, same costs as the flow fields)
  // explores a narrow band around the route instead of a whole box; the squad then follows the polyline (lookahead steering).
  // F = { path: true, pts: [x,y,...], cum (remaining length per vertex), n, k (cursor), tx, ty }. Off the path by > 30 m,
  // fDist is Infinity and the move step re-plans.
  let asG = null, asFrom = null, asStamp = null, asClosed = null, asSerial = 0;
  const hpC = [], hpF = [];
  function hpPush(c, f) { let i = hpC.length; hpC.push(c); hpF.push(f); while (i > 0) { const p = (i - 1) >> 1; if (hpF[p] <= f) break; hpC[i] = hpC[p]; hpF[i] = hpF[p]; i = p; } hpC[i] = c; hpF[i] = f; }
  function hpPop() {
    const top = hpC[0], lc = hpC.pop(), lf = hpF.pop(), n = hpC.length;
    if (n) { let i = 0; for (;;) { let l = 2 * i + 1; if (l >= n) break; if (l + 1 < n && hpF[l + 1] < hpF[l]) l++; if (hpF[l] >= lf) break; hpC[i] = hpC[l]; hpF[i] = hpF[l]; i = l; } hpC[i] = lc; hpF[i] = lf; }
    return top;
  }
  function astar(sx, sy, tx, ty, maxExp = 90000) {
    const COLS = sim.COLS, NC = COLS * sim.ROWS, walk = sim.walk;
    if (!asG) { asG = new Float32Array(NC); asFrom = new Int32Array(NC); asStamp = new Uint32Array(NC); asClosed = new Uint32Array(NC); }
    const s = snapWalk(sx, sy, 6), t = snapWalk(tx, ty, 30); if (!s || !t) return null;
    const sc = sim.cellOf(s.x, s.y), tc = sim.cellOf(t.x, t.y), tcx = tc % COLS, tcy = (tc - tcx) / COLS, st = ++asSerial;
    const h = c => { const cx = c % COLS, dx = Math.abs(cx - tcx), dy = Math.abs((c - cx) / COLS - tcy); return 1.25 * (dx > dy ? 10 * dx + 4 * dy : 10 * dy + 4 * dx); };
    hpC.length = hpF.length = 0;
    asG[sc] = 0; asStamp[sc] = st; asFrom[sc] = -1; hpPush(sc, h(sc));
    let exp = 0, found = false;
    while (hpC.length) {
      const c = hpPop();
      if (asClosed[c] === st) continue; asClosed[c] = st;
      if (c === tc) { found = true; break; }
      if (++exp > maxExp) break;
      const gc = asG[c];
      for (let k = 0; k < 8; k++) {
        const n = c + DX8[k] + DY8[k] * COLS; if (!walk[n] || asClosed[n] === st) continue;
        if (k >= 4 && (!walk[c + DX8[k]] || !walk[c + DY8[k] * COLS])) continue;
        const ng = gc + DC8[k];
        if (asStamp[n] !== st || ng < asG[n]) { asStamp[n] = st; asG[n] = ng; asFrom[n] = c; hpPush(n, ng + h(n)); }
      }
    }
    police.astarExp = (police.astarExp || 0) + exp;
    if (!found) return null;
    const cells = []; for (let c = tc; c >= 0; c = asFrom[c]) { cells.push(c); if (c === sc) break; }
    cells.reverse();
    const pts = [s.x, s.y];
    for (let i = 2; i < cells.length - 1; i += 2) pts.push(cellX(cells[i]), cellY(cells[i]));
    pts.push(t.x, t.y);
    return pts;
  }
  function pathField(pts) {
    const n = pts.length / 2, cum = new Float32Array(n);
    for (let i = n - 2; i >= 0; i--) cum[i] = cum[i + 1] + hyp(pts[2 * i + 2] - pts[2 * i], pts[2 * i + 3] - pts[2 * i + 1]);
    return { path: true, pts, cum, n, k: 0, tx: pts[pts.length - 2], ty: pts[pts.length - 1] };
  }
  const pq = { i: 0, t: 0, d: 0, x: 0, y: 0 };
  function pathNearest(F, x, y) {
    const P = F.pts; let bd = 1e18;
    for (let i = Math.max(0, F.k - 4), e = Math.min(F.n - 2, F.k + 40); i <= e; i++) {
      const ax = P[2 * i], ay = P[2 * i + 1], bx = P[2 * i + 2] - ax, by = P[2 * i + 3] - ay, l2 = bx * bx + by * by || 1e-9;
      const t = clamp(((x - ax) * bx + (y - ay) * by) / l2, 0, 1), qx = ax + bx * t, qy = ay + by * t, d = (x - qx) ** 2 + (y - qy) ** 2;
      if (d < bd) { bd = d; pq.i = i; pq.t = t; pq.x = qx; pq.y = qy; }
    }
    if (F.n < 2) { pq.i = 0; pq.t = 1; pq.x = F.tx; pq.y = F.ty; bd = (x - F.tx) ** 2 + (y - F.ty) ** 2; }
    pq.d = Math.sqrt(bd); F.k = pq.i; return pq;
  }
  function pathDist(F, x, y) {
    const q = pathNearest(F, x, y); if (q.d > 30) return Infinity;
    if (F.n < 2) return q.d;
    const i = q.i, seg = hyp(F.pts[2 * i + 2] - F.pts[2 * i], F.pts[2 * i + 3] - F.pts[2 * i + 1]);
    return q.d + (1 - q.t) * seg + F.cum[i + 1];
  }
  function pathDir(F, x, y, out) {
    const q = pathNearest(F, x, y); if (q.d > 30) return false;
    // lookahead 3.5 m along the path from the projection
    let i = q.i, ax = q.x, ay = q.y, left = 3.5;
    while (left > 0 && i < F.n - 1) {
      const bx = F.pts[2 * i + 2], by = F.pts[2 * i + 3], l = hyp(bx - ax, by - ay);
      if (l >= left) { ax += (bx - ax) / l * left; ay += (by - ay) / l * left; left = 0; } else { left -= l; ax = bx; ay = by; i++; }
    }
    const ex = ax - x, ey = ay - y, l = hyp(ex, ey); if (l < 1e-3) return false;
    out.x = ex / l; out.y = ey / l; return true;
  }
  // field toward (tx, ty) for a squad at (sx, sy): A* path; small trips / failures: bounded box field; last resort: full field
  function routeField(tx, ty, sx, sy) {
    const d = hyp(tx - sx, ty - sy);
    if (d > 40) { const t0 = performance.now(); const P = astar(sx, sy, tx, ty); pt('astar', t0); if (P) return pathField(P); }
    const F = boxField(tx, ty, sx, sy, clamp(0.4 * d + 60, 60, 400)); if (!F) return null;
    if (Number.isFinite(fDist(F, sx, sy)) || !walkAt(sx, sy)) return F;
    return getField(tx, ty);
  }
  // protesters (not bystanders, not dusk leavers, not down / arrested)
  const isProt = j => { const a = act[j]; return a !== A_DOWN && a !== A_ARRESTED && a !== A_HOME && (lead[j] >= 0 || riot[j] >= 0 || (a >= A_LOOT && a <= ACT.MILL) || T - lastOff[j] < 120); };
  function protNear(x, y, r, max = 1e9) { let n = 0; forEachNear(x, y, r, j => { if (isProt(j) && ++n >= max) return true; }); return n; }
  function uidOf(i) { if (!uid[i]) uid[i] = ++uidSerial; return uid[i]; }
  // re-find a tracked agent after swap-removals (indices are only stable within a substep)
  function resolveRec(rec) {
    if (rec.i >= 0 && rec.i < sim.NA && uid[rec.i] === rec.uid && !gone[rec.i]) return rec.i;
    let f = -1;
    forEachNear(rec.x, rec.y, 6, j => { if (uid[j] === rec.uid && !gone[j]) { f = j; return true; } });
    rec.i = f; return f;
  }
  const isOffAct = a => a === A_LOOT || a === A_FIGHT || a === A_THROW;
  const offender = j => isOffAct(act[j]) || T - lastOff[j] < OFFENCE_WINDOW;
  function log(sq, what) {
    const L = police.log; L.push({ t: Math.round(T), sq: sq ? sq.id : 0, what, tactic: sq?.tactic, state: sq?.state });
    if (L.length > 3000) L.splice(0, 1000);
  }
  function setState(sq, s) { if (sq.state !== s) { sq.state = s; log(sq, 'state'); } }
  function setTactic(sq, t) { if (sq.tactic !== t) { sq.tactic = t; log(sq, 'tactic'); } }
  function resolveSquad(ref) {
    if (ref && typeof ref === 'object') return squads.includes(ref) ? ref : null;
    if (typeof ref === 'number') return squads[ref] || null; // index (riots encode tgt = squadIndex*1000 + officer)
    return null;
  }
  const ef = sq => sq.energy < 40 ? 0.65 + 0.35 * sq.energy / 40 : 1; // fatigue speed factor
  const alongOf = (sq, x, y) => (x - sq.x) * sq.dx + (y - sq.y) * sq.dy;
  const latOf = (sq, x, y) => (x - sq.x) * sq.pxu + (y - sq.y) * sq.pyu;

  // ===================================================================== force on agents
  // v1.7 brutality INCIDENTS (docs/gauges.md §3: "police force injures or arrests an agent without an offence flag").
  // v1.6 emitted one 'brutality' event per baton touch / arrest of a non-offender (hundreds per hour). Now:
  // - only an injury (the blow puts the victim DOWN), an arrest, or a direct LBD hit on a non-offender counts;
  // - victim weight by class: rando 1, pacifist 2, encourager 1, medic 3, black bloc 0 (no incident); +2 for an injury;
  // - victims within INC_R m and INC_T s of an open incident join it (one charge = one incident); the incident is
  //   emitted when it closes, as 'brutality' {severity (sum of weights), kind, n (victims), d (share of offenders within
  //   15 m when it opened: a rock-throwing crowd gives a "clean" incident, d ~ 0.6)}. police.brutalityCount counts incidents.
  const VICTIM_W = [1, 2, 1, 3, 0], INC_R = 35, INC_T = 20;
  const incidents = [];
  function discrimination(x, y) { let n = 0, o = 0; forEachNear(x, y, 15, j => { const a = act[j]; if (a === A_DOWN || a === A_ARRESTED) return; n++; if (offender(j)) o++; }); return n ? o / n : 0; }
  function brutalityCheck(j, kind, injured) {
    if (offender(j)) return false;
    const w = (VICTIM_W[sim.cls[j]] ?? 1) + (injured ? 2 : 0); if (w <= 0 || VICTIM_W[sim.cls[j]] === 0) return false;
    for (const inc of incidents) if (T - inc.t0 < INC_T && hyp(inc.x - px[j], inc.y - py[j]) < INC_R) { inc.sev += w; inc.n++; return true; }
    incidents.push({ x: px[j], y: py[j], t0: T, kind, sev: w, n: 1, d: discrimination(px[j], py[j]) });
    return true;
  }
  function flushIncidents(all) {
    for (let q = incidents.length - 1; q >= 0; q--) {
      const inc = incidents[q]; if (!all && T - inc.t0 < INC_T) continue;
      incidents.splice(q, 1); police.brutalityCount++;
      sim.emit('brutality', inc.x, inc.y, { severity: inc.sev, kind: inc.kind, n: inc.n, d: +inc.d.toFixed(2) });
    }
  }
  function hitAgent(j, dmg, kind) {
    if (sim.api.hitAgent) return sim.api.hitAgent(j, dmg, kind);
    if (act[j] === A_DOWN || act[j] === A_ARRESTED) return false;
    hp[j] -= dmg;
    if (hp[j] <= 0) { hp[j] = 0; act[j] = A_DOWN; lead[j] = -1; sim.emit('injury', px[j], py[j], { kind }); return true; }
    return false;
  }
  function strike(j, dmg, kind) { const off = offender(j), down = hitAgent(j, dmg, kind); if (down && !off) brutalityCheck(j, kind, true); return down; }
  // launch through combat (owner 'P' = police, from = {sq, k}); returns true if combat took it (else the caller applies a fallback)
  function launch(kind, x0, y0, tx, ty, sq, k) {
    const f = sim.api.throwProjectile; if (!f) return false;
    const before = sim.projectiles ? sim.projectiles.length : 0;
    const p = f(kind, x0, y0, tx, ty, 'P', sq ? { sq, k: k ?? 0 } : undefined);
    return p != null || (sim.projectiles && sim.projectiles.length > before);
  }

  // ===================================================================== squads: creation and formation
  function addSquad(x, y, faceX = 0, faceY = 1, opts = {}) {
    const p = snapWalk(x, y); if (!p) return null;
    const sq = {
      id: ++squadSerial, x: p.x, y: p.y, dx: 0, dy: 1, pxu: 1, pyu: 0, adv: 0, lat: [], row: [], n: 0, na: 0, nFront: 0,
      ox: new Float32Array(CAP), oy: new Float32Array(CAP), hp: new Float32Array(CAP),
      state: 'hold', tactic: opts.tactic || 'cordon', role: opts.manual ? 'manual' : 'free', manual: !!opts.manual, energy: 100,
      half: 6, left: 6, right: 6, formation: 'line', anchor: { x: p.x, y: p.y }, home: { x: p.x, y: p.y }, maxAdv: 12,
      dest: null, field: null, trail: [], gap: 0, gapLat: 0, pushField: null, pushLeft: 0, pushTarget: null, sinceRelayout: 0,
      chargeCd: 8, chargeLeft: 0, lbdStock: 12, gasStock: GAS_STOCK, pushCd: 0, chargeKeep: false, gasCd: 15, lbdCd: 5, flashCd: 10, snatchCd: 12, thinkT: rand() * THINK,
      warn: 0, warnT: 0, warnReadyT: -1e9, attackedT: -1e9, brokenT: 0, quietT: 0,
      load: 0, pressEst: 0, strength: 0, front: 0, near: 0, nearX: 0, nearY: 0, throwers: [], offenders: [], leaderCand: null,
      op: null, slotKey: null, downed: [], lost: 0, bb: null, creep: null,
      transit: false, van: false, slotT: -1e9, slotScore: 0, hunt: !!opts.hunt, parentId: opts.parentId || 0, planId: 0,
    };
    let span = 0;
    { // size the section for its first street unless told
      const ax = lineAxis(p.x, p.y, faceX, faceY); span = ax.left + ax.right;
    }
    const n = clamp(opts.n ?? clamp(2 * Math.round(span / 1.1), 16, 32), 4, CAP);
    sq.na = n;
    for (let k = 0; k < n; k++) sq.hp[k] = 1;
    formLine(sq, p.x, p.y, faceX, faceY, false);
    for (let k = 0; k < n; k++) { slotOf(sq, k, tmp); const ok = walkAt(tmp.x, tmp.y); sq.ox[k] = ok ? tmp.x : sq.x; sq.oy[k] = ok ? tmp.y : sq.y; }
    sq.n = n; computeBB(sq);
    squads.push(sq);
    log(sq, 'spawn');
    return sq;
  }
  function removeSquad(sq) {
    sq = resolveSquad(sq); if (!sq) return;
    const i = squads.indexOf(sq); if (i >= 0) squads.splice(i, 1);
    for (let t = teams.length - 1; t >= 0; t--) if (teams[t].sq === sq) dropTeam(t);
    for (const r of arrestees) if (r.sq === sq) r.sq = null;
    if (sq.op) sq.op.squads = sq.op.squads.filter(s => s !== sq);
  }
  // narrowest walkable cross-section through (x, y): line axis + facing flipped toward (fx, fy)
  function lineAxis(x, y, fx, fy, exact) {
    let dx, dy;
    if (exact) { const l = hyp(fx, fy) || 1; dx = fx / l; dy = fy / l; }
    else {
      // cross-section measured at the point and 2 m ahead/behind (robust to corners), biased toward the requested facing
      let best = null; const fl = hyp(fx, fy);
      for (let a = 0; a < 16; a++) {
        const t = a / 16 * Math.PI, ux = Math.cos(t), uy = Math.sin(t), nx = -uy, ny = ux;
        let s = 0;
        for (const o of [0, 2, -2]) { const qx = x + nx * o, qy = y + ny * o; s += walkAt(qx, qy) ? walkExtent(qx, qy, ux, uy, 18) + walkExtent(qx, qy, -ux, -uy, 18) : 18; }
        if (fl > 1e-6) s *= 1 + 0.5 * (1 - Math.abs(nx * fx + ny * fy) / fl);
        if (!best || s < best.s) best = { s, ux, uy };
      }
      dx = -best.uy; dy = best.ux;
      if (dx * fx + dy * fy < 0) { dx = -dx; dy = -dy; }
    }
    const pxu = dy, pyu = -dx;
    return { dx, dy, pxu, pyu, left: walkExtent(x, y, pxu, pyu, 18), right: walkExtent(x, y, -pxu, -pyu, 18) };
  }
  function formLine(sq, x, y, fx, fy, exact, gap = 0) {
    const ax = lineAxis(x, y, fx, fy, exact);
    sq.dx = ax.dx; sq.dy = ax.dy; sq.pxu = ax.pxu; sq.pyu = ax.pyu;
    // recentre in the street
    const sh = (ax.left - ax.right) / 2, cx = x + ax.pxu * sh, cy = y + ax.pyu * sh;
    if (walkAt(cx, cy)) { x = cx; y = cy; sq.left = sq.right = (ax.left + ax.right) / 2; } else { sq.left = ax.left; sq.right = ax.right; }
    sq.left = Math.max(sq.left, 1.5); sq.right = Math.max(sq.right, 1.5);
    sq.x = sq.anchor.x = x; sq.y = sq.anchor.y = y;
    sq.gap = gap; sq.gapLat = 0;
    sq.formation = 'line';
    layoutLine(sq);
  }
  function relayoutExtents(sq) { // re-measure the street at the anchor keeping the facing (push along bending streets)
    const l = walkExtent(sq.anchor.x, sq.anchor.y, sq.pxu, sq.pyu, 18), r = walkExtent(sq.anchor.x, sq.anchor.y, -sq.pxu, -sq.pyu, 18);
    const sh = (l - r) / 2, cx = sq.anchor.x + sq.pxu * sh, cy = sq.anchor.y + sq.pyu * sh;
    if (Math.abs(sh) > 0.3 && walkAt(cx, cy)) { sq.anchor.x = cx; sq.anchor.y = cy; sq.left = sq.right = Math.max(1.5, (l + r) / 2); }
    else { sq.left = Math.max(1.5, l); sq.right = Math.max(1.5, r); }
    layoutLine(sq);
  }
  function layoutLine(sq) {
    sq._settled = false;
    const na = sq.na, span = sq.left + sq.right, gap = sq.gap;
    const usable = Math.max(2, span - gap);
    const nFront = clamp(Math.round(usable / SPACING), Math.min(3, na), Math.max(1, na));
    sq.nFront = nFront; sq.half = span / 2;
    sq.lat.length = sq.row.length = 0;
    for (let k = 0, r = 0; k < na; r++) {
      const cnt = Math.min(nFront, na - k);
      for (let c = 0; c < cnt; c++, k++) {
        let u = -sq.right + (c + 0.5) * usable / cnt;
        if (gap > 0 && u > sq.gapLat - gap / 2) u += gap;
        sq.lat.push(u); sq.row.push(-r * ROW_GAP);
      }
    }
  }
  function trailPoint(sq, s, out) { // point s metres back along the column trail
    const tr = sq.trail, n = tr.length;
    if (!n) { out.x = sq.x; out.y = sq.y; out.dx = sq.dx; out.dy = sq.dy; return; }
    let idx = n - 1 - Math.round(s / 0.5); if (idx < 0) idx = 0;
    const p = tr[idx], q = tr[Math.min(n - 1, idx + 1)];
    out.x = p.x; out.y = p.y;
    const ddx = q.x - p.x, ddy = q.y - p.y, l = hyp(ddx, ddy);
    if (l > 1e-3) { out.dx = ddx / l; out.dy = ddy / l; } else { out.dx = sq.dx; out.dy = sq.dy; }
    if (idx === 0 && s / 0.5 > n - 1) { const extra = s - (n - 1) * 0.5; out.x -= out.dx * extra; out.y -= out.dy * extra; if (!walkAt(out.x, out.y)) { out.x = p.x; out.y = p.y; } }
  }
  const tp = { x: 0, y: 0, dx: 0, dy: 0 };
  function slotOf(sq, k, out) {
    if (sq.formation === 'column' && sq.van) { // mounted: officers ride in vans of VAN_SIZE, 7.5 m apart along the trail
      const v = Math.floor(k / VAN_SIZE), q = k % VAN_SIZE;
      trailPoint(sq, 1.5 + v * 7.5, tp);
      const lx = tp.dy, ly = -tp.dx, off = ((q & 1) - 0.5) * 0.8, al = ((q >> 1) - 1.5) * 0.9;
      out.x = tp.x + lx * off + tp.dx * al; out.y = tp.y + ly * off + tp.dy * al;
      if (!walkAt(out.x, out.y)) { out.x = tp.x; out.y = tp.y; }
      return;
    }
    if (sq.formation === 'column') {
      const r = Math.floor(k / 4), c = k % 4;
      trailPoint(sq, r * 1.1 + 0.3, tp);
      const lx = tp.dy, ly = -tp.dx, off = (c - 1.5) * 0.9;
      out.x = tp.x + lx * off; out.y = tp.y + ly * off;
      if (!walkAt(out.x, out.y)) { out.x = tp.x; out.y = tp.y; }
      return;
    }
    let lat = sq.lat[k] ?? 0, row = sq.row[k] ?? 0;
    const bh = sq.bh; if (bh) { lat += bh.jl[k]; row += bh.jr[k] - bh.bend[k]; } // [behaviour] ragged / bent line
    if (sq.state === 'broken') { lat *= 1.5; row = row * 2.5 - ((k * 7919) % 5) * 0.6; lat += (((k * 104729) % 7) - 3) * 0.4; }
    out.x = sq.x + sq.pxu * lat + sq.dx * row; out.y = sq.y + sq.pyu * lat + sq.dy * row;
  }
  function computeBB(sq) {
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (let k = 0; k < sq.n; k++) { const x = sq.ox[k], y = sq.oy[k]; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
    if (!sq.n) { minx = maxx = sq.x; miny = maxy = sq.y; }
    sq.bb = [minx - 2.5, miny - 2.5, maxx + 2.5, maxy + 2.5];
    if (sq.van) sq.bb = null; // v1.5: mounted squads are not obstacles / targets (other systems skip bb-less squads or check sq.van)
  }

  // ===================================================================== orders
  // move to (x, y) in column along a cached flow field, then form a line facing (fx, fy).
  // opts: { exact, then: 'hold'|'push', pushTo:{x,y}, pushDist, gap, tactic }
  function orderMove(sq, x, y, fx, fy, opts = {}) {
    sq = resolveSquad(sq); if (!sq) return false;
    const p = snapWalk(x, y); if (!p) return false;
    if (opts.tactic) setTactic(sq, opts.tactic);
    if (sq.bh) { sq.bh.sally = null; sq.bh.pt = null; } // [behaviour]
    sq.dest = { x: p.x, y: p.y, fx: fx ?? sq.dx, fy: fy ?? sq.dy, exact: !!opts.exact, then: opts.then || 'hold', pushTo: opts.pushTo || null, pushDist: opts.pushDist || 0, gap: opts.gap || 0, maxAdv: opts.maxAdv };
    sq.home = { x: p.x, y: p.y };
    if (hyp(sq.x - p.x, sq.y - p.y) < 3) { arrive(sq); return true; }
    // keep the current field when re-ordered to (nearly) the same place
    if (!(sq.field && sq.state === 'move' && hyp(sq.field.tx - p.x, sq.field.ty - p.y) < 4)) sq.field = routeField(p.x, p.y, sq.x, sq.y);
    if (!sq.field) { sq.dest = null; return false; }
    const wasMoving = sq.state === 'move';
    sq.formation = 'column';
    // v1.6: trips longer than VAN_MIN by van when no protesters are close (dismounted again near the destination or a crowd)
    const far = fDist(sq.field, sq.x, sq.y);
    sq.van = sq.transit = far > VAN_MIN && protNear(sq.x, sq.y, VAN_CLEAR_R, VAN_CLEAR_N) < VAN_CLEAR_N;
    if (sq.van) police.counts.vanTrips++;
    if (wasMoving && sq.trail.length) { sq.creep = null; sq.pushLeft = 0; return true; }
    sq.trail = [];
    // seed the trail behind the current position so the column forms behind the head
    for (let s = 12; s >= 0; s--) sq.trail.push({ x: sq.x - sq.dx * s * 0.5, y: sq.y - sq.dy * s * 0.5 });
    sq.creep = null; sq.pushLeft = 0;
    setState(sq, 'move');
    return true;
  }
  function arrive(sq) {
    const d = sq.dest; sq.dest = null; sq.field = null; sq.trail = []; sq.van = sq.transit = false;
    formLine(sq, d.x, d.y, d.fx, d.fy, d.exact, d.gap);
    sq.home = { x: sq.anchor.x, y: sq.anchor.y };
    if (d.maxAdv != null) sq.maxAdv = d.maxAdv;
    if (d.then === 'push') startPush(sq, d.pushTo, d.pushDist);
    else setState(sq, d.then === 'rest' ? 'rest' : 'hold');
  }
  function startPush(sq, to, dist) {
    sq.pushTarget = to || null;
    sq.pushField = to ? boxField(to.x, to.y, sq.anchor.x, sq.anchor.y, 60) : null;
    sq.pushLeft = dist || 40;
    setState(sq, 'push');
  }
  function orderCharge(sq, dist, keep = false) {
    sq = resolveSquad(sq); if (!sq || sq.formation !== 'line') return false;
    if (sq.bh) sq.bh.sally = null; // [behaviour] (riposte sets it again for a sally)
    sq.chargeLeft = dist ?? (10 + rand() * 5); sq.chargeKeep = keep;
    sq.chargeCd = CHARGE_CD0 + rand() * CHARGE_CD1; sq.energy = Math.max(0, sq.energy - 8);
    police.counts.charges++;
    for (const L of sim.leaders) if (!L.arrested && !L.gone && L.pexp && hyp(L.x - sq.x, L.y - sq.y) < 45) L.pexp.chargeT = T; // v1.8: a charge into the march exposes its leader
    setState(sq, 'charge');
    sim.emit('charge', sq.x, sq.y, { squad: sq.id });
    return true;
  }

  // ===================================================================== officers: hits, downs, drag-back
  function hitOfficer(sqRef, k, dmg = 0.3, kind = 'rock') {
    const sq = resolveSquad(sqRef); if (!sq || k < 0 || k >= sq.na) return false;
    sq.hp[k] -= dmg * (ARMOUR[kind] ?? 0.5);
    sq.attackedT = T; police.attacksOnOfficers++;
    if (sq.bh) sq.bh.aggro += 0.6; // [behaviour]
    addHeat(0.01);
    if (sq.hp[k] <= 0) { downOfficer(sq, k, kind); return true; }
    return false;
  }
  function downOfficer(sq, k, kind) {
    if (sq.downed.length < CAP - sq.na) sq.downed.push({ x: sq.ox[k], y: sq.oy[k], t: 0 });
    const l = sq.na - 1;
    sq.ox[k] = sq.ox[l]; sq.oy[k] = sq.oy[l]; sq.hp[k] = sq.hp[l]; sq.na = l;
    if (sq.formation === 'line') layoutLine(sq);
    police.counts.officersDown++; addHeat(0.12); police.urgent = true;
    if (!sq.gate && sq.cohesion != null) { sq.cohesion = Math.max(0, sq.cohesion - 0.05); if (sq.bh) sq.bh.aggro += 1.5; } // [behaviour]
    sim.emit('officerDown', sq.ox[k], sq.oy[k], { squad: sq.id, kind });
  }

  // ===================================================================== arrests
  function poolLeft() { const d = sim.day?.day || 4, r = (CUST_H0 + CUST_HD * d) / 3600; police.custPool = Math.min(CUST_POOL, (police.custPool ?? CUST_POOL) + (T - (police.custPoolT ?? T)) * r); police.custPoolT = T; return police.custPool; } // v1.8
  function custody(sq) { if (!sq) return 0; const c = Math.max(0, (sq.cust || 0) - (T - (sq.custT ?? T)) * CUSTODY_CAP / CUSTODY_T); sq.cust = c; sq.custT = T; return c; } // v1.8
  const custodyFull = sq => custody(sq) >= CUSTODY_CAP || poolLeft() < 1;
  function arrestAgent(i, by) {
    if (i < 0 || i >= sim.NA || gone[i] || act[i] === A_ARRESTED) return false;
    brutalityCheck(i, 'arrest', false);
    act[i] = A_ARRESTED; lead[i] = -1; panicT[i] = 0; tgt[i] = -1; vx[i] = vy[i] = 0;
    let sq = null, team = null;
    if (by && by.ox) sq = by; else if (by && by.team) { team = by; sq = by.sq; }
    if (!sq) sq = nearestSquad(px[i], py[i]);
    if (sq) sq.cust = custody(sq) + 1; police.custPool = poolLeft() - 1; // v1.8 custody load
    const rec = { uid: uidOf(i), i, x: px[i], y: py[i], sq, team, t: 0 };
    arrestees.push(rec);
    if (team) team.arrestee = rec;
    police.counts.arrests++; // day.js counts the 'arrest' event
    if (sq && sq.hunt) police.counts.huntArrests++;
    sim.emit('arrest', px[i], py[i], { agent: i });
    return true;
  }
  function arrestLeader(L, team, by) {
    if (!L || L.arrested) return false;
    L.arrested = true; L.field = null; L.arrived = true; L.path = null;
    police.counts.arrests++; police.counts.leaderArrests++;
    const E = L.pexp; // v1.8: how the leader was taken (snatch / hunt / line / api) and its exposure at that moment
    sim.emit('arrest', L.x, L.y, { leader: L.id, by: by || (team ? (team.sq && team.sq.hunt ? 'hunt' : 'snatch') : 'api'), own: E ? E.own : -1, expMult: E ? +E.mult.toFixed(2) : 0 });
    if (L.stance === 'peaceful') { police.brutalityCount++; sim.emit('brutality', L.x, L.y, { severity: 5, kind: 'arrest', leader: L.id, n: 1, d: +discrimination(L.x, L.y).toFixed(2) }); } // arresting a peaceful organiser (v1.7: weight 3 + 2)
    if (team) team.leaderHeld = L;
    return true;
  }
  function nearestSquad(x, y, pred) { let b = null, bd = 1e9; for (const s of squads) { if (pred && !pred(s)) continue; const d = hyp(s.x - x, s.y - y); if (d < bd) { bd = d; b = s; } } return b; }
  function updateArrestees(dt) {
    for (let a = arrestees.length - 1; a >= 0; a--) {
      const r = arrestees[a]; r.t += dt;
      const i = resolveRec(r);
      if (i < 0 || act[i] !== A_ARRESTED) { arrestees.splice(a, 1); continue; }
      if (r.team && teams.includes(r.team)) { // carried by its team
        const tm = r.team; r.x = tm.x + 0.6; r.y = tm.y; if (walkAt(r.x, r.y)) { px[i] = r.x; py[i] = r.y; } else { r.x = px[i] = tm.x; r.y = py[i] = tm.y; }
        vx[i] = vy[i] = 0;
        continue;
      }
      r.team = null;
      const s = r.sq && squads.includes(r.sq) ? r.sq : null;
      if (!s) { if (r.t > 20) { removeAgent(i); arrestees.splice(a, 1); } continue; }
      const tx = s.x - s.dx * 5, ty = s.y - s.dy * 5, ex = tx - px[i], ey = ty - py[i], d = hyp(ex, ey);
      if (d < 1.5 || r.t > 45) { removeAgent(i); arrestees.splice(a, 1); continue; }
      const st = Math.min(d, 1.6 * dt), nx = px[i] + ex / d * st, ny = py[i] + ey / d * st;
      if (walkAt(nx, ny)) { px[i] = nx; py[i] = ny; }
      r.x = px[i]; r.y = py[i]; vx[i] = vy[i] = 0;
    }
  }

  // ===================================================================== snatch teams (BRAV-M style)
  function launchSnatch(sq, cand) {
    const k = police.escalation >= 3 && sq.na >= 18 ? 4 : 2;
    if (sq.na - k < (sq.hunt ? 3 : 8)) return null;
    let x = 0, y = 0;
    const hps = [];
    for (let q = 0; q < k; q++) { const o = sq.na - 1 - q; hps.push(sq.hp[o]); x += sq.ox[o]; y += sq.oy[o]; }
    sq.na -= k; if (sq.formation === 'line') layoutLine(sq);
    const tm = { id: ++teamSerial, team: true, x: x / k, y: y / k, state: 'dash', target: -1, sq, n: k, hps, t: 0, arrestee: null, leader: null, leaderHeld: null, rec: null };
    if (cand.L) { tm.leader = cand.L; tm.target = 'L' + cand.L.id; }
    else { tm.rec = { uid: uidOf(cand.j), i: cand.j, x: px[cand.j], y: py[cand.j] }; tm.target = cand.j; }
    teams.push(tm);
    sq.snatchCd = sq.hunt ? 10 + rand() * 8 : SNATCH_CD0 + rand() * SNATCH_CD1; sq.energy = Math.max(0, sq.energy - 3); // v1.5: was 40-60 s
    police.counts.snatches++;
    log(sq, 'snatch:' + (cand.L ? 'leader ' + cand.L.id : 'agent'));
    return tm;
  }
  function dropTeam(t) { const tm = teams[t]; if (tm.arrestee) tm.arrestee.team = null; teams.splice(t, 1); }
  function clearLine(x0, y0, x1, y1) { const d = hyp(x1 - x0, y1 - y0), n = Math.ceil(d / 0.75); for (let q = 1; q < n; q++) if (!walkAt(x0 + (x1 - x0) * q / n, y0 + (y1 - y0) * q / n)) return false; return true; }
  // straight when there is a line of sight, else along a (cached) flow field
  function teamMove(tm, tx, ty, v, dt) {
    if (!walkAt(tm.x, tm.y)) { const p = snapWalk(tm.x, tm.y, 4); if (p) { tm.x = p.x; tm.y = p.y; } }
    let ex = tx - tm.x, ey = ty - tm.y; const d = hyp(ex, ey); if (d < 1e-3) return 0;
    ex /= d; ey /= d;
    tm.losT = (tm.losT || 0) - dt;
    if (tm.losT <= 0) { tm.losT = 0.5; tm.los = clearLine(tm.x, tm.y, tx, ty); }
    if (!tm.los) { // v1.6: small bounded field per team, refreshed when the target moves (was a full-map field per target)
      if (!tm.F || (T - tm.Ft > 1.5 && hyp(tm.F.tx - tx, tm.F.ty - ty) > 5)) { tm.F = boxField(tx, ty, tm.x, tm.y, 30); tm.Ft = T; }
      if (tm.F && fDir(tm.F, tm.x, tm.y, tmp)) { ex = tmp.x; ey = tmp.y; }
    }
    const s = Math.min(d, v * dt); moveWithWalls(tm, ex * s, ey * s); return d;
  }
  function updateTeams(dt) {
    for (let t = teams.length - 1; t >= 0; t--) {
      const tm = teams[t], sq = tm.sq; tm.t += dt;
      if (!squads.includes(sq)) { dropTeam(t); continue; }
      const hx = sq.x - sq.dx * 3, hy = sq.y - sq.dy * 3;
      if (tm.state === 'dash') {
        let tx, ty, ok = true;
        if (tm.leader) { if (tm.leader.arrested) ok = false; tx = tm.leader.x; ty = tm.leader.y; }
        else { const j = resolveRec(tm.rec); if (j < 0 || act[j] === A_ARRESTED || act[j] === A_DOWN && rand() < 0.5) ok = false; else { tx = tm.rec.x = px[j]; ty = tm.rec.y = py[j]; tm.target = j; } }
        if (ok && (tm.t > 25 || hyp(tx - hx, ty - hy) > 70)) ok = false;
        if (ok && tm.leader && tm.leader.pexp && !tm.leader.pexp.exposed && tm.t > 1) ok = false; // v1.8: the core closed around the leader: pull out
        if (ok && tm.t > 2 && countNear(tm.x, tm.y, 3) > 14) ok = false; // swallowed by the crowd: pull out
        if (!ok) { tm.state = 'return'; continue; }
        const d = teamMove(tm, tx, ty, 4.6, dt);
        if (d < 1.3) {
          if (tm.leader) arrestLeader(tm.leader, tm); else arrestAgent(tm.target, tm);
          tm.state = 'drag';
        }
      } else if (tm.state === 'drag') {
        const d = teamMove(tm, hx, hy, 2.0, dt);
        if (tm.leaderHeld) { tm.leaderHeld.x = tm.x + 0.6; tm.leaderHeld.y = tm.y; }
        if (d < 2) {
          if (tm.arrestee) { const i = resolveRec(tm.arrestee); if (i >= 0) removeAgent(i); const ai = arrestees.indexOf(tm.arrestee); if (ai >= 0) arrestees.splice(ai, 1); tm.arrestee = null; }
          tm.state = 'return';
        }
      } else { // return: rejoin the squad
        const d = teamMove(tm, hx, hy, 3.0, dt);
        if (tm.leaderHeld) { tm.leaderHeld.x = tm.x + 0.6; tm.leaderHeld.y = tm.y; }
        if (d < 2.5 || tm.t > 90) {
          for (let q = 0; q < tm.n && sq.na < CAP; q++) { const k = sq.na++; sq.ox[k] = tm.x; sq.oy[k] = tm.y; sq.hp[k] = tm.hps[q]; }
          if (sq.formation === 'line') layoutLine(sq);
          if (tm.arrestee) tm.arrestee.team = null;
          teams.splice(t, 1);
        }
      }
    }
  }

  // ===================================================================== perception (staggered think)
  function scan(sq) {
    let load = 0, front = 0, near = 0, nx = 0, ny = 0, close = 0;
    const thr = sq.throwers, offs = sq.offenders, strays = sq.strays || (sq.strays = []); thr.length = 0; offs.length = 0; strays.length = 0;
    const half = sq.half + 1, H = sq.hunt, cx = H ? sq.x : sq.x + sq.dx * 18, cy = H ? sq.y : sq.y + sq.dy * 18, pS = H ? 0.6 : 0.15;
    forEachNear(cx, cy, H ? 45 : 30, j => {
      const a = act[j]; if (a === A_DOWN || a === A_ARRESTED) return;
      const ex = px[j] - sq.x, ey = py[j] - sq.y;
      const al0 = ex * sq.dx + ey * sq.dy; if (al0 < -1 && !H) return;
      const al = H ? Math.max(al0, Math.sqrt(ex * ex + ey * ey)) : al0; // hunt teams look all around
      const la = ex * sq.pxu + ey * sq.pyu, ala = la < 0 ? -la : la;
      const committed = lead[j] >= 0 || riot[j] >= 0 || (a >= A_LOOT && a <= ACT.MILL); // (not HOME leavers)
      if (al < 5 && ala < half && panicT[j] <= 0) {
        if (committed) { load += 0.5 + aggr[j] + (a === A_PUSH || a === A_FIGHT ? 1 : 0); front++; } else load += 0.1;
      }
      if (al > 6 && al < 48 && ala < half + 14 && committed && panicT[j] <= 0) { near++; nx += px[j]; ny += py[j]; if (al < 20) close++; } // [behaviour] close: 6-20 m
      if ((a === A_THROW || a === A_FIGHT) && al < 40 && thr.length < 8) thr.push(j);
      if (isOffAct(a) && al > 2 && al < 35 && offs.length < 6) offs.push(j);
      else if (committed && al > 2 && al < 40 && panicT[j] <= 0 && strays.length < 8 && rand() < pS) strays.push(j); // hunting (random sample)
    });
    sq.pressEst = load;
    sq.load = typeof sq.pressure === 'number' ? sq.pressure * police.pressureScale : load; // crowd system's force if it provides one
    sq.front = front; sq.near = near; sq.close = close;
    if (near) { sq.nearX = nx / near; sq.nearY = ny / near; }
    sq.strength = sq.na * STR_PER_OFF * (0.45 + 0.55 * sq.energy / 100) * (sq.gate ? GATE_STR_DAY[clamp((sim.day?.day || 4) - 1, 0, 6)] * (1 + GATE_CALM * (1 - clamp(sim.day?.intensity ?? 1, 0, 1))) : 1) // v1.7 (v1.8: by day and intensity)
      * (sq.gate || sq.cohesion == null ? 1 : COH_STR0 + (1 - COH_STR0) * sq.cohesion); // [behaviour] a shaken line is weaker
    // exposed leaders: few people around them, within reach in front
    sq.leaderCand = null;
    // v1.5: leaders are snatch targets from escalation 3 (doc: notoriety at level >= 3), or from level 2 when they
    // lead an Unleashed crowd; before that teams only take visible offenders
    // v1.8: only a leader whose exposure is ready (see leaderExposure) and that is still exposed right now
    for (const L of sim.leaders) {
      if (L.arrested || L.gone || !L.pexp || !L.pexp.ready || L.pexp.own >= EXP_OWN) continue;
      const al = alongOf(sq, L.x, L.y); if (al < 2 || al > 45 || Math.abs(latOf(sq, L.x, L.y)) > sq.half + 20) continue;
      sq.leaderCand = L; break;
    }
  }
  function snatchCandidate(sq) {
    if (sq.leaderCand) return { L: sq.leaderCand };
    if (custodyFull(sq)) return null; // v1.8
    let best = -1, bd = 1e9;
    for (const j of sq.offenders) {
      const d = hyp(px[j] - sq.x, py[j] - sq.y);
      if (d < bd && countNear(px[j], py[j], 3) <= 5) { bd = d; best = j; }
    }
    if (best < 0 && police.escalation >= 3) { // v1.7: from escalation 3 (v1.5/1.6: 2) teams also pick off isolated protesters (dispersed, spread-out crowds)
      for (const j of sq.strays || []) { if (j >= sim.NA || act[j] === A_DOWN || act[j] === A_ARRESTED) continue; const d = hyp(px[j] - sq.x, py[j] - sq.y); if (d < bd && countNear(px[j], py[j], 4) <= 2) { bd = d; best = j; } }
    }
    return best >= 0 ? { j: best } : null;
  }
  const attacked = sq => T - sq.attackedT < 60;
  // v1.6 sommations per AREA: once two warnings have been given within WARN_AREA_R m in the last hour, every squad there may
  // use force (no repeated procedure per squad). Records: {x, y, t (first), tLast, n, ready, sq}
  function warnRecAt(x, y) { for (const w of police.warnAreas) if (T - w.t < WARN_AREA_T && hyp(w.x - x, w.y - y) < WARN_AREA_R) return w; return null; }
  const frontPt = sq => (tmp.x = sq.x + sq.dx * 15, tmp.y = sq.y + sq.dy * 15, tmp);
  function warned(sq) { const f = frontPt(sq), w = warnRecAt(f.x, f.y); sq.warn = w ? w.n : 0; return !!w && w.n >= 2 && T >= w.ready; }
  const forceOK = sq => (police.escalation >= 1 && warned(sq)) || attacked(sq);           // v1.6: from level 1 once warned (was 2)
  const pushOK = sq => warned(sq) || attacked(sq);
  function emitWarning(w, sq) {
    police.counts.warnings++;
    sim.emit('warning', w.x, w.y, { squad: sq ? sq.id : 0, n: w.n });
    log(sq, 'warning ' + w.n);
    // some moderates leave on each sommation
    forEachNear(w.x, w.y, 50, j => {
      if (aggr[j] < 0.3 && panicT[j] <= 0 && act[j] <= A_FLEE && rand() < 0.12) makePanic(j, 6 + rand() * 6, px[j] - w.sx, py[j] - w.sy);
    });
  }
  function issueWarning(sq) {
    const f = frontPt(sq);
    if (warnRecAt(f.x, f.y)) return; // already warned here (or in progress)
    const w = { x: sq.x + sq.dx * 3, y: sq.y + sq.dy * 3, sx: sq.x, sy: sq.y, t: T, tLast: T, n: 1, ready: 1e12, sq };
    police.warnAreas.push(w); if (police.warnAreas.length > 60) police.warnAreas.shift();
    sq.warn = 1; emitWarning(w, sq);
  }
  function updateWarnings() { // second sommation WARN_GAP s after the first
    for (const w of police.warnAreas) if (w.n === 1 && T - w.tLast >= WARN_GAP) { w.n = 2; w.tLast = T; w.ready = T + WARN_READY; emitWarning(w, squads.includes(w.sq) ? w.sq : null); }
  }
  const engages = sq => sq.tactic !== 'reserve' && sq.tactic !== 'relief' && sq.state !== 'move' && sq.state !== 'rest';

  // distance to the march a block line is waiting for (live leader position)
  const watchD = sq => { const w = sq.watch; if (!w) return 1e9; const L = w.L; return L && !L.arrested ? hyp(L.x - sq.x, L.y - sq.y) : L ? 1e9 : w.d; };
  function decide(sq, phaseActive) {
    if (!phaseActive || !engages(sq)) return;
    const esc = police.escalation, att = attacked(sq);
    const st = sq.state, lineReady = st === 'hold' || st === 'push' || st === 'yield';
    const wantsForce = sq.front >= 4 || sq.near >= 20 || sq.throwers.length >= 2 || sq.tactic === 'advance' || sq.tactic === 'funnel-push' || sq.tactic === 'clear'
      || watchD(sq) < 150 || (sq.hunt && sq.strays && sq.strays.length > 0) || sq.front + (sq.close || 0) >= 8; // [behaviour] a close crowd gets the sommations (gas follows)
    if (esc >= 1 && !att && wantsForce && !warned(sq)) issueWarning(sq);
    if (!lineReady) return;
    const force = forceOK(sq);
    // v1.6 area denial: a block line gasses the head and flanks of the march it waits for as it comes within ~130 m
    const wd = watchD(sq);
    if (force && esc >= 1 && sq.gasCd <= 0 && wd < 150 && wd > 25 && sq.energy > 10) { // [behaviour] from escalation 1 (was 2), skips ground still gassed
      const L = sq.watch.L, wx0 = L ? L.x : sq.watch.x, wy0 = L ? L.y : sq.watch.y, wl = hyp(wx0 - sq.x, wy0 - sq.y) || 1, wa = clamp(wl - 25, 22, 60); // [behaviour] the head of the march, not its leader
      const gx = sq.x + (wx0 - sq.x) / wl * wa, gy = sq.y + (wy0 - sq.y) / wl * wa;
      if (gasFree(gx, gy)) { gasAt(sq, gx, gy, esc >= 3 ? 4 : 3, 16); sq.gasCd += 12; police.counts.gasDeny++; log(sq, 'gas ahead'); } else sq.gasCd = 4;
    }
    const dens = sq.front / Math.max(10, 5 * 2 * sq.half);
    let thrNear = 0; for (const j of sq.throwers) if (alongOf(sq, px[j], py[j]) < 22) thrNear++;
    const uCharge = force && sq.chargeCd <= 0 && sq.energy > 30 && (sq.cohesion ?? 1) > 0.5 && (sq.bh?.odds ?? 0) < RIP_ODDS // [behaviour] no charge into a crowd far bigger than the squad
      ? 40 * ((sq.front >= CHARGE_FRONT ? 1 : 0) + Math.min(2, thrNear * 0.4) + (sq.load > 0.6 * sq.strength ? 1 : 0)) * (1 - Math.min(0.7, dens / 4)) * (att && (sq.front >= CHARGE_FRONT || thrNear) ? 1.6 : 1) : 0; // [behaviour] attacked at close range: hit back before gassing
    let wind = 1; if (sim.WIND && sq.near) { const gx = sq.nearX - sq.x, gy = sq.nearY - sq.y, l = hyp(gx, gy) || 1; if ((sim.WIND.x * gx + sim.WIND.y * gy) / l < -0.25) wind = 0.5; }
    const mass = sq.near + 0.5 * sq.front; // area denial in front of the line counts too
    // v1.7: volleys need a hostile or advancing crowd (attacked, throwers, a pressing front, offenders, the march a block waits for,
    // or a big mass from escalation 3) and canisters in stock (limited supply: squads rotate out to restock)
    // [behaviour] gas is the default tool (user feedback 2026-10-20 #2): from escalation 1 once the area is warned (or when attacked;
    // v1.7 needed escalation 2), against any committed crowd that comes close or lingers after the sommations, not only hostile ones.
    // An approaching crowd gets a denial volley across the street in front of the line; a close / lingering / hostile one a dispersal
    // volley on its centre. Ground that is still gassed is skipped (re-gassed as it clears): steer and scatter, not saturate.
    const closeN = sq.front + (sq.close || 0), linger = sq.bh ? sq.bh.lingerT : 0;
    const hostile = att || sq.throwers.length > 0 || sq.front >= 4 || sq.offenders.length >= 2 || wd < 150 || (esc >= 3 && mass >= 25) || closeN >= 8 || linger > 15 || (esc >= 2 && mass >= 20);
    const uGas = force && hostile && sq.gasStock >= 1 && sq.gasCd <= 0 && !(sq.op && sq.op.type === 'kettle') && mass >= GAS_MASS && sq.energy > 10 ? (40 + 30 * Math.min(2, mass / 25)) * wind * (sq.front >= CHARGE_FRONT && (sq.bh?.odds ?? 0) < RIP_ODDS ? 0.5 : 1) : 0; // contact with a crowd the squad can take: baton before gas
    if (uCharge >= 30 && uCharge >= uGas && !sq.gate) orderCharge(sq, undefined, sq.tactic === 'advance' || sq.tactic === 'clear' || sq.tactic === 'funnel-push');
    else if (uGas >= 30) gasChoice(sq, closeN, linger, att);
    // LBD at visible throwers (sparingly)
    if (sq.throwers.length && sq.lbdCd <= 0 && sq.lbdStock > 0 && (esc >= 2 || att) && rand() < 0.3) {
      let best = -1, bd = 41; for (const j of sq.throwers) { const d = hyp(px[j] - sq.x, py[j] - sq.y); if (d < bd) { bd = d; best = j; } }
      if (best >= 0) fireLBD(sq, best);
    }
    // flashbang when attacked at close quarters or the line is close to breaking
    if (sq.flashCd <= 0 && esc >= 2 && (att && sq.front >= 12 || sq.load > 1.3 * sq.strength)) flashbang(sq);
    // snatch
    if (sq.snatchCd <= 0 && esc >= 1 && sq.na >= (sq.hunt ? 5 : 12) && st !== 'yield') { const c = snatchCandidate(sq); if (c) launchSnatch(sq, c); }
    // cordon push: shield line steps forward against a crowd pressing it
    if (st === 'hold' && !sq.hunt && !sq.gate && sq.pushCd <= 0 && sq.front >= 4 && pushOK(sq) && sq.load < 0.8 * sq.strength && sq.energy > 30 && hyp(sq.anchor.x - sq.home.x, sq.anchor.y - sq.home.y) < sq.maxAdv - 2)
      startPush(sq, null, 6);
  }

  // v1.7 line arrests (user feedback: "isolated protesters pushed into the police by gas should be arrested"): an isolated protester
  // (at most GRAB_ALLIES others within 4 m) within GRAB_R m of an officer is grabbed by the line itself, no snatch dash needed.
  // Panicking / fleeing people (the gas trap: gas on one side, the line on the other) and offenders are taken from escalation 1,
  // anyone isolated from escalation 2; an exposed leader (few own followers within 8 m) from escalation 2. Rate: one grab every
  // GRAB_CD0..GRAB_CD0+GRAB_CD1 s per front section of ~8 officers. Brutality only when the person had no offence (usual rule).
  function lineGrab(sq) {
    if (sq.van || sq.state === 'move' || sq.state === 'broken' || sq.state === 'charge' || sq.formation !== 'line' || sq.na < 6) return;
    const esc = police.escalation; if (esc < 1) return;
    const R = sq.half + GRAB_R + 1;
    const offNear = (x, y) => { // within GRAB_R of an active officer?
      const bb = sq.bb; if (bb && (x < bb[0] - GRAB_R || x > bb[2] + GRAB_R || y < bb[1] - GRAB_R || y > bb[3] + GRAB_R)) return false;
      for (let k = 0; k < sq.na; k++) { const ex = sq.ox[k] - x, ey = sq.oy[k] - y; if (ex * ex + ey * ey < GRAB_R * GRAB_R) return true; }
      return false;
    };
    if (esc >= 2) for (const L of sim.leaders) { // v1.8: exposure-gated (L.pexp.ready), plus nobody close around it
      if (L.arrested || L.gone || !L.pexp || !L.pexp.ready || L.pexp.own >= EXP_OWN || hyp(L.x - sq.x, L.y - sq.y) > R || !offNear(L.x, L.y)) continue;
      if (countNear(L.x, L.y, 4) < 4) { arrestLeader(L, null, 'line'); police.counts.lineArrests++; sq.grabCd = GRAB_CD0; log(sq, 'line arrest: leader ' + L.id); return; }
    }
    if (custodyFull(sq)) { sq.grabCd = 3; return; } // v1.8: at custody capacity
    let cand = -1;
    forEachNear(sq.x, sq.y, R, j => {
      const a = act[j]; if (a === A_DOWN || a === A_ARRESTED || a === A_HOME || !isProt(j)) return;
      const fleeing = panicT[j] > 0;
      if (!fleeing && !offender(j) && esc < 4) return; // plain isolated stragglers only at level 4
      if (!offNear(px[j], py[j])) return;
      let allies = 0; forEachNear(px[j], py[j], 4, q => { if (q !== j && act[q] !== A_DOWN && act[q] !== A_ARRESTED && isProt(q) && ++allies > GRAB_ALLIES) return true; });
      if (allies > GRAB_ALLIES) return;
      cand = j; return true;
    });
    if (cand < 0) { sq.grabCd = 1; return; }
    arrestAgent(cand, sq); police.counts.lineArrests++;
    sq.grabCd = (GRAB_CD0 + rand() * GRAB_CD1) / Math.max(1, sq.nFront / 8);
  }

  // ===================================================================== weapons
  // v1.6: lob n canisters around (x, y) (range-limited to 60 m from the line)
  function gasAt(sq, x, y, n, spread = 14) {
    n = Math.min(n, Math.floor(sq.gasStock)); if (n <= 0) { sq.gasCd = 10; return; }
    sq.gasStock -= n;
    let gx = x - sq.x, gy = y - sq.y; const l = hyp(gx, gy) || 1; gx /= l; gy /= l;
    const dist = clamp(l, 15, 60), lx = -gy, ly = gx;
    for (let q = 0; q < n; q++) {
      const lat = (q - (n - 1) / 2) * spread * 0.8 + (rand() - 0.5) * 6; // a spread line across the street: head and flanks
      let t = snapWalk(sq.x + gx * (dist + (rand() - 0.5) * 8) + lx * lat, sq.y + gy * (dist + (rand() - 0.5) * 8) + ly * lat, 6); if (!t) continue;
      t = coreClear(t, sq); // [behaviour]
      const k = Math.floor(rand() * Math.max(1, sq.nFront));
      if (!launch('gas', sq.ox[k], sq.oy[k], t.x, t.y, sq, k)) sim.api.throwGas?.(t.x, t.y);
      police.counts.gas++;
    }
    sq.gasCd = GAS_CD0 + rand() * GAS_CD1; sq.energy = Math.max(0, sq.energy - 1);
  }
  // [behaviour] gas helpers
  const gasFree = (x, y) => !sim.gasSample || sim.gasSample(x, y).s < GAS_SKIP;
  // below escalation 3 canisters are not dropped on a march's leading group (GAS_CORE m around an active leader): gas steers and
  // thins the march from its edges instead of blowing its core apart (the core scattering exposed leaders to snatches far out)
  function coreClear(t, sq) {
    if (police.escalation >= 3) return t;
    for (const L of sim.leaders) {
      if (L.arrested || L.gone) continue;
      let ex = t.x - L.x, ey = t.y - L.y; const d = hyp(ex, ey); if (d >= GAS_CORE) continue;
      if (d < 0.5) { ex = sq.x - L.x; ey = sq.y - L.y; } const l = hyp(ex, ey) || 1;
      const p = snapWalk(L.x + ex / l * GAS_CORE, L.y + ey / l * GAS_CORE, 6); if (p) { t = p; police.counts.gasCoreShift++; }
    }
    return t;
  }
  function gasChoice(sq, closeN, linger, att) {
    const esc = police.escalation;
    if (closeN < 8 && !att && !sq.throwers.length && sq.near >= 8) { // approaching: deny the ground in front of the line
      const dd = 18 + rand() * 8, x = sq.x + sq.dx * dd, y = sq.y + sq.dy * dd;
      if (gasFree(x, y)) { gasAt(sq, x, y, esc >= 3 ? 3 : 2, 7); police.counts.gasDeny++; log(sq, 'gas deny'); } else sq.gasCd = 4;
      return;
    }
    if (att || gasFree(sq.near >= 10 ? sq.nearX : sq.x + sq.dx * 18, sq.near >= 10 ? sq.nearY : sq.y + sq.dy * 18)) { gasVolley(sq); police.counts.gasDisperse++; }
    else sq.gasCd = 4;
  }
  function gasVolley(sq) {
    if (sq.near < 10) { sq.nearX = sq.x + sq.dx * 18; sq.nearY = sq.y + sq.dy * 18; } // no crowd further out: deny the zone just in front
    let gx = sq.nearX - sq.x, gy = sq.nearY - sq.y; const l = hyp(gx, gy) || 1; gx /= l; gy /= l;
    const dist = clamp(l, 20, 50), n = Math.min(3 + (police.escalation >= 3 ? 1 : 0) + (sq.near >= 60 ? 1 : 0), Math.floor(sq.gasStock)); // [behaviour] 3-5 (v1.7: 4-5)
    if (n <= 0) { sq.gasCd = 10; return; }
    sq.gasStock -= n;
    for (let q = 0; q < n; q++) {
      let t = snapWalk(sq.x + gx * dist + (rand() - 0.5) * 14, sq.y + gy * dist + (rand() - 0.5) * 14, 6); if (!t) continue;
      t = coreClear(t, sq); // [behaviour]
      const k = Math.floor(rand() * Math.max(1, sq.nFront));
      if (!launch('gas', sq.ox[k], sq.oy[k], t.x, t.y, sq, k)) sim.api.throwGas?.(t.x, t.y);
      police.counts.gas++;
    }
    sq.gasCd = GAS_CD0 + rand() * GAS_CD1; sq.energy = Math.max(0, sq.energy - 1);
    log(sq, 'gas');
  }
  function fireLBD(sq, j) {
    const k = Math.floor(rand() * Math.max(1, sq.nFront));
    police.counts.lbd++; sq.lbdCd = 20 + rand() * 20; sq.lbdStock--; sq.energy = Math.max(0, sq.energy - 0.3);
    if (launch('lbd', sq.ox[k], sq.oy[k], px[j], py[j], sq, k)) return;
    // fallback: direct hit roll
    let victim = j;
    if (rand() < 0.3) { // miss: may hit someone near the line of fire
      victim = -1; forEachNear(px[j], py[j], 3, q => { if (q !== j && act[q] !== A_DOWN) { victim = q; return true; } });
    }
    sim.emit('impact', px[j], py[j], { kind: 'lbd' });
    if (victim >= 0) {
      strike(victim, 0.5, 'lbd', 2);
      const ex = px[victim] - sq.ox[k], ey = py[victim] - sq.oy[k], d = hyp(ex, ey) || 1;
      extFx[victim] += ex / d * 30; extFy[victim] += ey / d * 30;
    }
  }
  function flashbang(sq) {
    const dist = 7 + rand() * 5, t = snapWalk(sq.x + sq.dx * dist + (rand() - 0.5) * 4, sq.y + sq.dy * dist + (rand() - 0.5) * 4, 4);
    sq.flashCd = 25 + rand() * 15; if (!t) return;
    police.counts.flash++;
    log(sq, 'flashbang');
    if (launch('flashbang', sq.ox[0], sq.oy[0], t.x, t.y, sq, 0)) return;
    sim.emit('flash', t.x, t.y, {});
    forEachNear(t.x, t.y, 7, (j, ex, ey, d2) => {
      if (act[j] === A_DOWN || act[j] === A_ARRESTED) return;
      const d = Math.sqrt(d2) + 0.3;
      extFx[j] += ex / d * 18; extFy[j] += ey / d * 18;
      if (panicT[j] <= 0) makePanic(j, 4 + rand() * 6, ex, ey);
      if (d < 2.5 && rand() < 0.08) strike(j, 0.35, 'flashbang', 1);
    });
  }

  // ===================================================================== [behaviour] cohesion, reactions to aggression, live lines
  // (user feedback 2026-10-20, items 1, 5, 6; docs/notes/police-behaviour.md)
  // - sq.cohesion 0..1 (morale / formation integrity). It drains while the squad is heavily outnumbered close in (odds = weighted
  //   committed protesters in front / active officers above COH_ODDS0), faster when the crowd presses or attacks; it recovers when the
  //   odds are low. It scales line strength (x COH_STR0 + (1 - COH_STR0) x cohesion). Below COH_RAGGED the line visibly loses shape
  //   (officers jitter out of their slots, pressed front officers are bent back); below COH_BREAK while pressed or attacked the
  //   squad routs in disorder ('broken', farther with bigger odds), then regroups with cohesion COH_AFTER. The gate guard is exempt.
  // - Aggression meter (sq.bh.aggro): hits on officers, brawlers on the line, throwers in front, a pressing front. Above RIP_AGGRO
  //   the squad hits back: a sally (a steered charge at the throwers, up to RIP_MAX m from its post, then it walks back and faces
  //   its post again), a short clearing charge on the front, or, if the crowd is far bigger (odds > RIP_ODDS) or cohesion is low,
  //   a gas volley on the attackers. Snatch teams are readied to take the attackers.
  // - Live lines: quiet squads patrol forward and back around their post, a bound forward at a close crowd (show of force), a step
  //   back when outnumbered, and the front rank rotates with the second rank every ~40-70 s in contact (releve).
  const COH_ODDS0 = 3, COH_DRAIN = 0.022, COH_REC = 0.025, COH_RAGGED = 0.7, COH_BREAK = 0.22, COH_AFTER = 0.42, COH_STR0 = 0.55, COH_SWAMP = 12;
  const RIP_AGGRO = 1.8, RIP_CD0 = 10, RIP_CD1 = 10, RIP_MAX = 40, RIP_ODDS = 6, RIP_OP = 14;
  const PATROL_V = 0.8, PATROL_R = 8, PATROL_R_RES = 16, ROT_T0 = 40, ROT_T1 = 30;
  function bhOf(sq) {
    return sq.bh || (sq.bh = { jl: new Float32Array(CAP), jr: new Float32Array(CAP), bend: new Float32Array(CAP), jMag: 0, jT: 0, aggro: 0, ripCd: 4 + rand() * 8,
      sally: null, pt: null, ptV: PATROL_V, ptWait: rand() * 8, rotT: ROT_T0 + rand() * ROT_T1, lingerT: 0, odds: 0 });
  }
  const oddsOf = sq => (sq.front + 0.7 * (sq.close || 0) + 0.15 * sq.near) / Math.max(4, sq.na);
  function behaviourThink(sq, phaseActive) {
    const b = bhOf(sq), dt = THINK;
    if (sq.cohesion == null) sq.cohesion = 1;
    b.ripCd -= dt; b.rotT -= dt; b.aggro *= 0.9;
    const st = sq.state;
    if (st === 'broken') { shapeLine(sq, b); return; } // routing: cohesion frozen until it regroups
    if (sq.gate || sq.van || st === 'move' || st === 'rest' || !phaseActive) { // off the line: recover, formation tidies up
      sq.cohesion = Math.min(1, sq.cohesion + COH_REC * (st === 'rest' ? 3 : 1) * dt); b.odds = 0; b.lingerT = 0;
      if (sq.gate) sq.cohesion = 1;
      shapeLine(sq, b);
      return;
    }
    const odds = b.odds = oddsOf(sq), ratio = sq.load / Math.max(1, sq.strength), att = T - sq.attackedT < 8;
    if ((sq.brawlers || 0) > 0) sq.attackedT = T; // a brawl on the line is an attack on it
    // ---- cohesion
    let dC = 0;
    if (odds > COH_ODDS0) dC -= COH_DRAIN * Math.min(4, odds - COH_ODDS0) * (0.15 + Math.min(1.5, ratio)) * (sq.energy < 30 ? 1.4 : 1);
    if (att) dC -= 0.008;
    if (odds < 1.5 && T - sq.attackedT > 15) dC += COH_REC * (sq.tactic === 'reserve' ? 2 : 1);
    else if (odds < COH_ODDS0 && !att) dC += COH_REC * 0.35;
    sq.cohesion = clamp(sq.cohesion + dC * dt, 0, 1);
    if (!sq.hunt && sq.cohesion < COH_BREAK && (ratio > 0.5 || att || odds > COH_SWAMP) && (st === 'hold' || st === 'push' || st === 'yield')) { rout(sq, odds); shapeLine(sq, b); return; }
    // close crowd lingering in front (dispersal gas after warnings, see decide)
    if (sq.front + (sq.close || 0) >= 8) b.lingerT += dt; else b.lingerT = Math.max(0, b.lingerT - 2 * dt);
    // ---- aggression meter and reactions (the hits themselves are added in hitOfficer)
    let thrNear = 0; for (const j of sq.throwers) { const al = alongOf(sq, px[j], py[j]); if (al > 1 && al < 40) thrNear++; }
    b.aggro += 0.6 * Math.min(3, sq.brawlers || 0) + 0.25 * thrNear + (ratio > 0.6 && sq.front >= 4 ? 0.6 : 0);
    const lineOK = sq.formation === 'line' && (st === 'hold' || st === 'push' || st === 'yield');
    if (lineOK && b.aggro > RIP_AGGRO && b.ripCd <= 0 && !sq.hunt && sq.na >= 10 && sq.energy > 20 && sq !== sq.op?.filterSq && forceOK(sq)) riposte(sq, b, odds);
    else if (lineOK && st === 'hold' && !sq.hunt) liveLine(sq, b, odds, ratio);
    // ---- releve: the front rank swaps with the second rank now and then while in contact
    if (b.rotT <= 0 && st === 'hold' && sq.formation === 'line' && sq.front >= 2 && sq.na >= 2 * sq.nFront) {
      b.rotT = ROT_T0 + rand() * ROT_T1;
      for (let k = 0; k < sq.nFront; k++) { const r = k + sq.nFront, x = sq.ox[k], y = sq.oy[k], h = sq.hp[k]; sq.ox[k] = sq.ox[r]; sq.oy[k] = sq.oy[r]; sq.hp[k] = sq.hp[r]; sq.ox[r] = x; sq.oy[r] = y; sq.hp[r] = h; }
      sq._settled = false; police.counts.rotations++;
    }
    shapeLine(sq, b);
  }
  // per-officer slot offsets: ragged formation (jitter grows as cohesion drops) and the line bent back where the crowd presses
  function shapeLine(sq, b) {
    const dis = 1 - sq.cohesion, mag = sq.state === 'broken' ? 1 : clamp((dis - (1 - COH_RAGGED)) / COH_RAGGED, 0, 1);
    let ch = false;
    if ((b.jT -= THINK) <= 0 || Math.abs(mag - b.jMag) > 0.25) {
      b.jT = 1.5 + rand() * 2; b.jMag = mag;
      if (mag > 0.02) { for (let k = 0; k < sq.na; k++) { b.jl[k] = (rand() - 0.5) * 3.2 * mag; b.jr[k] = (rand() - 0.7) * 3.0 * mag; } ch = true; }
      else if (b.jl[0] || b.jr[0] || b.jl[1]) { b.jl.fill(0); b.jr.fill(0); ch = true; }
    }
    const op = sq.opress, nf = sq.formation === 'line' ? Math.min(sq.nFront, sq.na) : 0;
    for (let k = 0; k < nf; k++) {
      const tgt = op && k < op.length ? Math.min(1, op[k] / 35) * (0.4 + 2.6 * dis) : 0, d = tgt - b.bend[k];
      if (d > 0.08 || d < -0.08) { b.bend[k] += d * 0.4; ch = true; }
    }
    for (let k = nf; k < sq.na; k++) if (b.bend[k]) { b.bend[k] = 0; ch = true; }
    if (ch) sq._settled = false;
  }
  function rout(sq, odds) {
    setState(sq, 'broken'); sq.routLeft = 18 + 6 * Math.min(5, odds); sq.energy = Math.max(0, sq.energy - 10); sq.pushLeft = 0;
    police.counts.routs++; police.counts.cohesionBreaks++; police.urgent = true;
    sim.emit('routed', sq.x, sq.y, { squad: sq.id, cohesion: +sq.cohesion.toFixed(2), odds: +odds.toFixed(1) });
    if (T - (sq.brokeT ?? -1e9) > 60) { police.counts.lineBreaks++; addHeat(0.2); sim.emit('lineBroken', sq.x, sq.y, { squad: sq.id, cause: 'cohesion' }); }
    sq.brokeT = T; log(sq, 'routed (cohesion ' + sq.cohesion.toFixed(2) + ', odds ' + odds.toFixed(1) + ')');
  }
  function riposte(sq, b, odds) {
    b.aggro = 0; b.ripCd = RIP_CD0 + rand() * RIP_CD1; police.counts.ripostes++;
    sq.snatchCd = Math.min(sq.snatchCd, 1.5); // arrest teams go for the attackers
    let tx = 0, ty = 0, n = 0;
    for (const list of [sq.throwers, sq.offenders]) for (const j of list) { if (j >= sim.NA) continue; const al = alongOf(sq, px[j], py[j]); if (al > 2 && al < 42) { tx += px[j]; ty += py[j]; n++; } } // attackers: throwers, brawlers, offenders in front
    for (const a of b.atk || []) { if (T - a.t > 12) continue; const al = alongOf(sq, a.x, a.y); if (al > 2 && al < 45) { tx += a.x; ty += a.y; n++; } } // recent throws at the squad
    if (odds > RIP_ODDS || sq.cohesion < 0.55) { // far too many to go in: gas them instead
      if (sq.gasStock >= 1) { if (n) { sq.nearX = tx / n; sq.nearY = ty / n; sq.near = Math.max(sq.near, 10); } gasVolley(sq); police.counts.ripGas++; log(sq, 'riposte: gas'); }
      b.ripCd *= 0.6; return;
    }
    const room = (sq.op ? RIP_OP : RIP_MAX) - hyp(sq.x - sq.home.x, sq.y - sq.home.y);
    if (n && room > 8) {
      tx /= n; ty /= n; const d = hyp(tx - sq.x, ty - sq.y);
      if (clearLine(sq.x, sq.y, tx, ty) && orderCharge(sq, clamp(d + 4, 8, room))) {
        b.sally = { tx, ty, fx: sq.dx, fy: sq.dy }; police.counts.sallies++; log(sq, 'riposte: sally ' + Math.round(d) + ' m'); return;
      }
    }
    if ((sq.front >= 2 || (sq.brawlers || 0) > 0) && orderCharge(sq, 8 + rand() * 6)) { log(sq, 'riposte: clearing charge'); return; }
    if (sq.gasStock >= 1 && n) { sq.nearX = tx / n; sq.nearY = ty / n; sq.near = Math.max(sq.near, 10); gasVolley(sq); police.counts.ripGas++; log(sq, 'riposte: gas'); }
  }
  // a crowd projectile aimed at a squad (combat 'throw' event: x, y = thrower, tx, ty = target): the target squad remembers
  // where it came from (the thrower is only in act THROW for an instant, scan rarely sees it) and gets angrier
  function throwAt(e) {
    if (e.tx == null || !squads) return;
    for (const sq of squads) {
      const bb = sq.bb; if (!bb || e.tx < bb[0] - 3 || e.tx > bb[2] + 3 || e.ty < bb[1] - 3 || e.ty > bb[3] + 3) continue;
      const b = bhOf(sq); b.aggro += 0.5;
      const A = b.atk || (b.atk = []); A.push({ x: e.x, y: e.y, t: T }); if (A.length > 12) A.shift();
      police.counts.throwsAtPolice++; if (sq.gate) police.counts.throwsAtGate++;
      break;
    }
  }
  // a holding line that is not reacting: bound at a close crowd, step back when outnumbered (patrols are in holdMove)
  function liveLine(sq, b, odds, ratio) {
    if (sq.gate || sq.creep) return;
    const adv = (sq.anchor.x - sq.home.x) * sq.dx + (sq.anchor.y - sq.home.y) * sq.dy; // metres ahead of the post
    if (odds > COH_ODDS0 && sq.cohesion < 0.6 && ratio < 1.05 && adv > -10 && !b.pt) { // give a few metres before it breaks
      const p = { x: sq.anchor.x - sq.dx * 3, y: sq.anchor.y - sq.dy * 3 };
      if (walkAt(p.x, p.y) && goalD(p.x, p.y) > GOAL_HOLD) { b.pt = p; b.ptV = 0.6; police.counts.stepBacks++; }
      return;
    }
    if (sq.pushCd <= 0 && sq.front < 4 && (sq.close || 0) >= 12 && odds < COH_ODDS0 && sq.cohesion > 0.6 && sq.energy > 30 && adv < sq.maxAdv - 3 && pushOK(sq)) {
      startPush(sq, null, 4 + rand() * 4); sq.pushCd = 18 + rand() * 12; police.counts.bounds++;
    }
  }
  // hold-state anchor moves: a step-back point, or a patrol point around the post once things are quiet
  function holdMove(sq, e, dt) {
    const b = bhOf(sq);
    if (!b.pt) {
      if (sq.front > 0 || sq.near >= 10 || sq.quietT < 4) return;
      if ((b.ptWait -= dt) > 0) return;
      const ready = watchD(sq) < 220; // a march is coming: stand on the post
      const R = sq.tactic === 'reserve' ? PATROL_R_RES : ready ? 0 : Math.min(PATROL_R, Math.max(2, sq.maxAdv - 2));
      const along = R ? (rand() * 1.6 - 0.6) * R : 0;
      const p = { x: sq.home.x + sq.dx * along, y: sq.home.y + sq.dy * along };
      b.pt = walkAt(p.x, p.y) && clearLine(sq.anchor.x, sq.anchor.y, p.x, p.y) ? p : { x: sq.home.x, y: sq.home.y }; b.ptV = PATROL_V;
    }
    const ex = b.pt.x - sq.anchor.x, ey = b.pt.y - sq.anchor.y, d = hyp(ex, ey);
    if (d < 0.3) { b.pt = null; b.ptWait = 5 + rand() * 12; return; }
    const s = Math.min(d, (b.ptV || PATROL_V) * e * dt), nx = sq.anchor.x + ex / d * s, ny = sq.anchor.y + ey / d * s;
    if (!walkAt(nx, ny)) { b.pt = null; b.ptWait = 4; return; }
    sq.anchor.x = nx; sq.anchor.y = ny; sq.sinceRelayout += s;
    if (sq.sinceRelayout > 1.5) { sq.sinceRelayout = 0; relayoutExtents(sq); }
  }

  // ===================================================================== squad step
  function updateSquad(sq, dt, phaseActive) {
    const mx0 = sq.x, my0 = sq.y; // [behaviour] movement metering
    sq.chargeCd -= dt; sq.pushCd -= dt; sq.gasCd -= dt; sq.lbdCd -= dt; sq.flashCd -= dt; sq.snatchCd -= dt; sq.grabCd = (sq.grabCd || 0) - dt;
    sq.thinkT -= dt;
    if (sq.thinkT <= 0) {
      sq.thinkT += THINK;
      rotateHurt(sq);
      if (sq.state !== 'move' && sq.state !== 'rest') scan(sq);
      else { sq.front = 0; sq.near = 0; sq.load = 0; }
      decide(sq, phaseActive);
      if (phaseActive && sq.grabCd <= 0) lineGrab(sq);
      behaviourThink(sq, phaseActive); // [behaviour]
    }
    const e = ef(sq);
    let vOff = V_OFF;
    switch (sq.state) {
      case 'move': {
        const F = sq.field, d = sq.dest;
        if (!d || !F) { setState(sq, 'hold'); sq.formation = 'line'; layoutLine(sq); break; }
        let rem = fDist(F, sq.x, sq.y);
        if (rem < 2.5 || hyp(sq.x - d.x, sq.y - d.y) < 2) { arrive(sq); break; }
        if (!Number.isFinite(rem) && T - (sq.reRouteT || -1e9) > 3) { // pushed off the route: plan again from here
          sq.reRouteT = T; const NF = routeField(d.x, d.y, sq.x, sq.y); if (NF) { sq.field = NF; rem = fDist(NF, sq.x, sq.y); }
        }
        sq.vanChk = (sq.vanChk || 0) - dt;
        if (sq.van && (rem < VAN_DISMOUNT || (sq.vanChk <= 0 && (sq.vanChk = 1, protNear(sq.x, sq.y, VAN_STOP_R, 14) >= 14)))) {
          sq.van = sq.transit = false; sim.emit('dismount', sq.x, sq.y, { squad: sq.id }); // everybody out, continue on foot
        } else if (!sq.van && sq.vanChk <= 0) { // v1.6: back into the vans once the street ahead is clear again
          sq.vanChk = 3;
          if (rem > VAN_MIN + 40 && protNear(sq.x, sq.y, VAN_CLEAR_R, 4) < 4) { sq.van = sq.transit = true; police.counts.vanTrips++; }
        }
        if (fDir(F, sq.x, sq.y, tmp) || sim.dirTo(sq.x, sq.y, d.x, d.y, tmp)) {
          const crowd = countNear(sq.x + tmp.x * 2, sq.y + tmp.y * 2, 2.5);
          const v = sq.van ? (crowd > 2 ? 1.5 : V_VAN) : V_MOVE * e * (crowd > 8 ? 0.45 : crowd > 4 ? 0.75 : 1);
          const ox0 = sq.x, oy0 = sq.y;
          moveWithWalls(sq, tmp.x * v * dt, tmp.y * v * dt);
          sq.dx = sq.dx * 0.8 + tmp.x * 0.2; sq.dy = sq.dy * 0.8 + tmp.y * 0.2;
          const l = hyp(sq.dx, sq.dy) || 1; sq.dx /= l; sq.dy /= l; sq.pxu = sq.dy; sq.pyu = -sq.dx;
          const last = sq.trail[sq.trail.length - 1];
          if (!last || hyp(last.x - sq.x, last.y - sq.y) >= 0.5) { // keep ~0.5 m spacing even at van speed
            const lx = last ? last.x : ox0, ly = last ? last.y : oy0, seg = hyp(sq.x - lx, sq.y - ly), n = Math.max(1, Math.floor(seg / 0.5));
            for (let q = 1; q <= n; q++) sq.trail.push({ x: lx + (sq.x - lx) * q / n, y: ly + (sq.y - ly) * q / n });
            while (sq.trail.length > 80) sq.trail.shift();
          }
        }
        if (!sq.van) sq.energy -= dt * 0.1 / 60;
        vOff = sq.van ? V_VAN * 1.6 : 2.0;
        break;
      }
      case 'push': {
        let dirx = sq.dx, diry = sq.dy;
        if (sq.pushField && fDir(sq.pushField, sq.anchor.x, sq.anchor.y, tmp)) { dirx = tmp.x; diry = tmp.y; }
        const ratio = sq.load / Math.max(1, sq.strength);
        let v = (sq.front > 2 ? V_PUSH : V_PUSH_FREE) * e;
        if (ratio > 0.9) v = 0; else if (ratio > 0.6) v *= (0.9 - ratio) / 0.3;
        if (ratio > 1.05) { yieldGround(sq, ratio, dt); break; }
        if (v > 0) {
          const ax = sq.anchor.x + dirx * v * dt, ay = sq.anchor.y + diry * v * dt;
          if (walkAt(ax, ay)) {
            sq.anchor.x = ax; sq.anchor.y = ay; sq.pushLeft -= v * dt; sq.sinceRelayout += v * dt; sq.energy -= v * dt * 0.05;
            if (sq.pushField) { sq.dx = sq.dx * 0.97 + dirx * 0.03; sq.dy = sq.dy * 0.97 + diry * 0.03; const l = hyp(sq.dx, sq.dy) || 1; sq.dx /= l; sq.dy /= l; sq.pxu = sq.dy; sq.pyu = -sq.dx; }
            if (sq.sinceRelayout > 1.5) { sq.sinceRelayout = 0; relayoutExtents(sq); }
          } else { sq.pushLeft = 0; sq.pushCd = 15; }
        }
        sq.x = sq.anchor.x; sq.y = sq.anchor.y;
        const beyond = hyp(sq.anchor.x - sq.home.x, sq.anchor.y - sq.home.y) > sq.maxAdv;
        if (sq.pushLeft <= 0 || (beyond && sq.tactic !== 'advance' && sq.tactic !== 'clear' && sq.tactic !== 'funnel-push')) {
          if (sq.tactic === 'advance' || sq.tactic === 'clear' || sq.tactic === 'funnel-push') sq.home = { x: sq.anchor.x, y: sq.anchor.y };
          else sq.pushCd = 8;
          setState(sq, 'hold');
        }
        break;
      }
      case 'charge': {
        const sal = sq.bh?.sally; // [behaviour] a sally steers at the attackers and stops against a solid mass
        if (sal) {
          const ex = sal.tx - sq.x, ey = sal.ty - sq.y, l = hyp(ex, ey);
          if (l > 3) { sq.dx = sq.dx * 0.85 + ex / l * 0.15; sq.dy = sq.dy * 0.85 + ey / l * 0.15; const q = hyp(sq.dx, sq.dy) || 1; sq.dx /= q; sq.dy /= q; sq.pxu = sq.dy; sq.pyu = -sq.dx; }
          if ((sq.sallyChk = (sq.sallyChk || 0) - dt) <= 0) { sq.sallyChk = 0.4; if (countNear(sq.x + sq.dx * 3, sq.y + sq.dy * 3, 2.5) > 12) sq.chargeLeft = 0; }
        }
        const v = V_CHARGE * e, nx = sq.x + sq.dx * v * dt, ny = sq.y + sq.dy * v * dt;
        if (walkAt(nx, ny) && sq.chargeLeft > 0) { sq.x = nx; sq.y = ny; sq.chargeLeft -= v * dt; }
        else if (sal && sq.chargeLeft > 0) { const x0 = sq.x, y0 = sq.y; moveWithWalls(sq, sq.dx * v * dt, sq.dy * v * dt); const m = hyp(sq.x - x0, sq.y - y0); sq.chargeLeft = m < v * dt * 0.3 ? 0 : sq.chargeLeft - m; }
        else sq.chargeLeft = 0;
        if (sq.chargeLeft <= 0) {
          if (sq.chargeKeep) { sq.anchor.x = sq.x; sq.anchor.y = sq.y; relayoutExtents(sq); }
          setState(sq, 'regroup'); sq.regroupT = 6;
        }
        vOff = 5.2;
        break;
      }
      case 'regroup': { // stop, re-form, walk back to the anchor
        sq.regroupT = (sq.regroupT || 0) - dt;
        const sal = sq.bh?.sally; // [behaviour] back from a sally: walk back (around corners), turn to face the post again
        if (sal && sq.regroupT < 3) {
          const ex = sq.anchor.x - sq.x, ey = sq.anchor.y - sq.y, d = hyp(ex, ey);
          sq.dx = sq.dx * 0.9 + sal.fx * 0.1; sq.dy = sq.dy * 0.9 + sal.fy * 0.1; { const q = hyp(sq.dx, sq.dy) || 1; sq.dx /= q; sq.dy /= q; sq.pxu = sq.dy; sq.pyu = -sq.dx; }
          if (d > 0.3) { const s = Math.min(d, 1.5 * e * dt), x0 = sq.x, y0 = sq.y; moveWithWalls(sq, ex / d * s, ey / d * s); if (hyp(sq.x - x0, sq.y - y0) < s * 0.2) { sq.x += ex / d * s; sq.y += ey / d * s; } }
          else if (sq.regroupT <= 0) { sq.x = sq.anchor.x; sq.y = sq.anchor.y; sq.dx = sal.fx; sq.dy = sal.fy; sq.pxu = sq.dy; sq.pyu = -sq.dx; sq.bh.sally = null; setState(sq, 'hold'); }
        } else if (sq.regroupT < 3) {
          const ex = sq.anchor.x - sq.x, ey = sq.anchor.y - sq.y, d = hyp(ex, ey);
          if (d > 0.2) { const s = Math.min(d, 1.0 * e * dt); sq.x += ex / d * s; sq.y += ey / d * s; }
          else if (sq.regroupT <= 0) setState(sq, 'hold');
        }
        break;
      }
      case 'yield': {
        const ratio = sq.load / Math.max(1, sq.strength);
        if (sq.breachT > 0) { setState(sq, 'hold'); break; }
        sq.yieldT = (sq.yieldT || 0) + dt;
        if (ratio > 1.0) yieldGround(sq, ratio, dt); else { sq.brokenT = Math.max(0, sq.brokenT - dt); if (ratio < 0.85 && sq.yieldT > 4) setState(sq, 'hold'); }
        break;
      }
      case 'broken': { // rout back ~25 m, then regroup
        const ax = sq.anchor.x - sq.dx * 2.0 * dt, ay = sq.anchor.y - sq.dy * 2.0 * dt;
        if (goalD(ax, ay) < GATE_R - 18) { // v1.6: never rout onto the Elysee gate: the broken line withdraws aside by van
          setState(sq, 'hold'); sq.brokenT = 0; relief(sq, true); break;
        }
        if (walkAt(ax, ay)) { sq.anchor.x = ax; sq.anchor.y = ay; sq.routLeft -= 2.0 * dt; } else sq.routLeft = 0;
        sq.x = sq.anchor.x; sq.y = sq.anchor.y;
        if (sq.routLeft <= 0) { relayoutExtents(sq); sq.home = { x: sq.anchor.x, y: sq.anchor.y }; setState(sq, 'regroup'); sq.regroupT = 8; sq.brokenT = 0; if (sq.cohesion != null) sq.cohesion = Math.max(sq.cohesion, COH_AFTER); } // [behaviour]
        vOff = 3.0;
        break;
      }
      case 'rest':
        sq.energy += dt * 4 / 60; // v1.6: 4 / min at rest (was 2.5)
        sq.gasStock = Math.min(GAS_STOCK, sq.gasStock + dt / 4); sq.lbdStock = Math.min(12, sq.lbdStock + dt / 60); // v1.7: restock at staging
        break;
      default: { // hold
        const ratio = sq.load / Math.max(1, sq.strength);
        // v1.7: hunt teams never hold a line: swamped (or spent) they pull out and go back to their parent squad. In v1.6 they
        // stood in the crowd yielding and "breaking" every few seconds (thousands of lineBroken events, heat runaway to level 4)
        if (sq.hunt && phaseActive && (ratio > 0.8 || sq.front >= 6 || sq.energy < 20)) { huntWithdraw(sq); break; }
        if (sq.breachT > 0) { sq.breachT -= dt; if (sq.breachT <= 0) { sq.gap = 0; layoutLine(sq); sq.rearmT = T + GATE_REARM; sq.energy = Math.min(100, sq.energy + GATE_REARM_E); log(sq, 'gate closed'); } sq.x = sq.anchor.x; sq.y = sq.anchor.y; break; } // v1.8: re-armed after a breach
        if (ratio > 1.05 && phaseActive) { setState(sq, 'yield'); sq.yieldT = 0; break; }
        // kettle creep: tighten slowly toward the centre while the crowd lets us
        if (sq.creep && !sq.creep.done && ratio < 0.6) creepStep(sq, e, dt);
        // drift back to the assigned post when nothing is in contact
        if (sq.front === 0 && sq.near < 10 && !sq.creep) {
          sq.quietT += dt;
          const ex = sq.home.x - sq.anchor.x, ey = sq.home.y - sq.anchor.y, d = hyp(ex, ey);
          if (sq.gate) { if (sq.quietT > 15 && d > 1) { const s = Math.min(d, 0.7 * e * dt); const nx = sq.anchor.x + ex / d * s, ny = sq.anchor.y + ey / d * s; if (walkAt(nx, ny)) { sq.anchor.x = nx; sq.anchor.y = ny; } } }
        } else sq.quietT = 0;
        if (!sq.gate && !sq.creep && phaseActive) holdMove(sq, e, dt); // [behaviour] patrols around the post, step-backs (was: drift home after 15 s quiet)
        sq.x = sq.anchor.x; sq.y = sq.anchor.y;
        break;
      }
    }
    // fatigue
    if (sq.state !== 'move' && sq.state !== 'rest') {
      if (sq.front >= 4) sq.energy -= dt * 1.0 / 60;
      if (T - sq.attackedT < 10) sq.energy -= dt * 2.0 / 60;
      if (sq.front === 0 && T - sq.attackedT > 30 && sq.state === 'hold') { sq.energy += dt * (sq.tactic === 'reserve' ? 2.0 : 0.5) / 60; if (sq.tactic === 'reserve') sq.gasStock = Math.min(GAS_STOCK, sq.gasStock + dt / 8); }
      if (sq.front === 0 && T - sq.attackedT > 10 && sq.gasStock < GAS_STOCK && sq.tactic !== 'reserve') { const a = Math.min(GAS_STOCK - sq.gasStock, dt / (sq.gasStock < GAS_LOW ? GAS_RESUPPLY_LOW : GAS_RESUPPLY)); sq.gasStock += a; police.counts.gasResupply += a; } // [behaviour] supply vans
    }
    sq.energy = clamp(sq.energy, 0, 100);
    if (T - sq.attackedT > 20) for (let k = 0; k < sq.na; k++) if (sq.hp[k] < 1) sq.hp[k] = Math.min(1, sq.hp[k] + HP_REGEN * dt); // v1.5
    // officers walk to their slots
    // (v1.6 perf) a settled line whose layout did not change since the last step skips the loop
    const lk = sq._lk || (sq._lk = new Float64Array(9));
    const same = sq.formation === 'line' && lk[0] === sq.x && lk[1] === sq.y && lk[2] === sq.dx && lk[3] === sq.dy && lk[4] === sq.na && lk[5] === sq.left && lk[6] === sq.right && lk[7] === sq.gap && lk[8] === (sq.state === 'broken' ? 1 : 0);
    if (!(same && sq._settled)) {
      let moved = false;
      for (let k = 0; k < sq.na; k++) {
        slotOf(sq, k, tmp);
        const ox = sq.ox[k], oy = sq.oy[k], ex = tmp.x - ox, ey = tmp.y - oy, d = hyp(ex, ey);
        if (d < 1e-3) continue;
        if (d > 30 && walkAt(tmp.x, tmp.y)) { sq.ox[k] = tmp.x; sq.oy[k] = tmp.y; moved = true; continue; }
        const s = Math.min(d, vOff * dt), nx = ox + ex / d * s, ny = oy + ey / d * s;
        if (walkAt(nx, ny)) { sq.ox[k] = nx; sq.oy[k] = ny; moved = true; } else if (walkAt(nx, oy)) { sq.ox[k] = nx; moved = true; } else if (walkAt(ox, ny)) { sq.oy[k] = ny; moved = true; }
      }
      sq._settled = !moved;
      lk[0] = sq.x; lk[1] = sq.y; lk[2] = sq.dx; lk[3] = sq.dy; lk[4] = sq.na; lk[5] = sq.left; lk[6] = sq.right; lk[7] = sq.gap; lk[8] = sq.state === 'broken' ? 1 : 0;
    }
    // downed officers are dragged behind the line, then evacuated
    for (let q = sq.downed.length - 1; q >= 0; q--) {
      const o = sq.downed[q]; o.t += dt;
      const tx = sq.x - sq.dx * 7, ty = sq.y - sq.dy * 7, ex = tx - o.x, ey = ty - o.y, d = hyp(ex, ey);
      if (o.t > 2 && d > 0.3) { const s = Math.min(d, 1.0 * dt), nx = o.x + ex / d * s, ny = o.y + ey / d * s; if (walkAt(nx, ny)) { o.x = nx; o.y = ny; } }
      if (o.t > 14) { sq.downed.splice(q, 1); sq.lost++; }
    }
    for (let q = 0; q < sq.downed.length; q++) { sq.ox[sq.na + q] = sq.downed[q].x; sq.oy[sq.na + q] = sq.downed[q].y; sq.hp[sq.na + q] = 0; } // hp 0 = down (others skip them)
    sq.n = sq.na + sq.downed.length;
    computeBB(sq);
    if (phaseActive) contactForces(sq, dt);
    if (phaseActive) { // [behaviour] metering: metres walked on foot by squads, squad-seconds on duty
      const C = police.counts; C.squadSec += dt; if (!sq.van) { const d = hyp(sq.x - mx0, sq.y - my0); C.footM += d; if (sq.state !== 'move') C.stationM += d; }
    }
  }
  // hurt front-rank officers swap places with the fittest officer of the rear ranks (relève)
  function rotateHurt(sq) {
    if (sq.formation !== 'line' || sq.na <= sq.nFront) return;
    for (let k = 0; k < sq.nFront; k++) {
      if (sq.hp[k] >= 0.45) continue;
      let b = -1, bh = 0.7; for (let r = sq.nFront; r < sq.na; r++) if (sq.hp[r] > bh) { bh = sq.hp[r]; b = r; }
      if (b < 0) return;
      const x = sq.ox[k], y = sq.oy[k], h = sq.hp[k];
      sq.ox[k] = sq.ox[b]; sq.oy[k] = sq.oy[b]; sq.hp[k] = sq.hp[b]; sq.ox[b] = x; sq.oy[b] = y; sq.hp[b] = h; sq._settled = false;
    }
  }
  const GOAL_HOLD = 46; // m: last ground a line gives before the gate (GOAL_R is 40)
  const goalD = (x, y) => hyp(x - sim.goal.x, y - sim.goal.y);
  // kettle / cordon creep: tighten along the own street toward the centre; stop before the lines bunch up (v1.6 fix: blockers
  // used to converge on 0.55 r and overlap) or before stepping out of the street into the open square
  function creepStep(sq, e, dt) {
    const c = sq.creep, d = hyp(c.x - sq.anchor.x, c.y - sq.anchor.y);
    if (d <= c.minD) { c.done = true; return; }
    if (sq.op) for (const o of sq.op.squads) if (o !== sq && hyp(o.anchor.x - sq.anchor.x, o.anchor.y - sq.anchor.y) < o.half + sq.half + 4) { c.done = true; return; }
    const s = 0.3 * e * dt, nx = sq.anchor.x + sq.dx * s, ny = sq.anchor.y + sq.dy * s;
    if (!walkAt(nx, ny)) { c.done = true; return; }
    sq.anchor.x = nx; sq.anchor.y = ny; sq.sinceRelayout += s;
    if (sq.sinceRelayout > 1.5) {
      sq.sinceRelayout = 0;
      const l = walkExtent(nx, ny, sq.pxu, sq.pyu, 18), r = walkExtent(nx, ny, -sq.pxu, -sq.pyu, 18);
      if (c.w0 == null) c.w0 = sq.left + sq.right;
      if (l + r > Math.max(c.w0 * 1.6, c.w0 + 6) || (l + r) / SPACING > sq.na) { sq.anchor.x -= sq.dx * 1.5; sq.anchor.y -= sq.dy * 1.5; c.done = true; return; }
      relayoutExtents(sq);
    }
  }
  function yieldGround(sq, ratio, dt) {
    if (sq.state !== 'yield') { setState(sq, 'yield'); sq.yieldT = 0; }
    const v = Math.min(0.6, 0.3 * ratio) * dt, ax = sq.anchor.x - sq.dx * v, ay = sq.anchor.y - sq.dy * v;
    let moved = false;
    if (walkAt(ax, ay) && goalD(ax, ay) > (sq.gate ? GATE_R - GATE_GIVE : GOAL_HOLD)) { sq.anchor.x = ax; sq.anchor.y = ay; moved = true; police.groundGiven += v; } // v1.6: lines stop giving ground short of the gate
    sq.x = sq.anchor.x; sq.y = sq.anchor.y;
    sq.energy -= dt * 1.5 / 60;
    if ((ratio > 2.0 && sq.energy < 35) || (!moved && ratio > 2.5)) sq.brokenT += dt; else sq.brokenT = Math.max(0, sq.brokenT - dt * 0.5);
    if (sq.gate) { if (T < (sq.rearmT || 0) || (sim.day?.intensity ?? 1) < GATE_BREACH_INT) sq.brokenT = 0; else if (sq.brokenT > GATE_BREAK_T) gateBreach(sq); return; } // v1.8: a gate line breaches, it never routs (v1.7 bug: it broke at 4 s, was relieved and left the street open)
    if (sq.brokenT > 4) {
      setState(sq, 'broken'); sq.routLeft = 25; sq.energy = Math.max(0, sq.energy - 15); police.counts.routs++; // [behaviour] every rout
      if (T - (sq.brokeT ?? -1e9) > 60) { police.counts.lineBreaks++; addHeat(0.2); police.urgent = true; sim.emit('lineBroken', sq.x, sq.y, { squad: sq.id }); } // v1.7: once per minute per squad (was every break, heat 0.3)
      sq.brokeT = T;
    }
  }
  // shields push the people in front; charges knock back and injure
  function contactForces(sq, dt) {
    const st = sq.state;
    if (st === 'move' || st === 'rest' || st === 'broken') return;
    if (st !== 'charge' && sq.front === 0) return;
    const charge = st === 'charge', push = st === 'push';
    const reach = charge ? 4 : push ? 3 : 1.6, F = charge ? 24 : push ? 9 : 2.5;
    const strikeRate = charge ? 0.18 : push ? 0.06 : police.escalation >= 3 ? 0.008 : 0; // v1.6: more baton (was .12 / .03 / 0)
    const half = sq.half + 0.8;
    forEachNear(sq.x + sq.dx * 1.5, sq.y + sq.dy * 1.5, half + 3, j => {
      const a = act[j]; if (a === A_DOWN || a === A_ARRESTED) return;
      const ex = px[j] - sq.x, ey = py[j] - sq.y, al = ex * sq.dx + ey * sq.dy;
      if (al < -0.6 || al > reach) return;
      const la = ex * sq.pxu + ey * sq.pyu; if (la > half || la < -half) return;
      const f = F * (1 - Math.max(0, al) / (reach + 0.5));
      extFx[j] += sq.dx * f; extFy[j] += sq.dy * f;
      if (charge && panicT[j] <= 0 && rand() < dt * 0.8) makePanic(j, 4 + rand() * 6, sq.dx, sq.dy);
      if (strikeRate && al < 1.5 && rand() < dt * strikeRate) strike(j, charge ? 0.25 + rand() * 0.25 : 0.15, 'baton', charge ? 2 : 1);
    });
  }

  // ===================================================================== geometry for tactics
  // streets leaving a circle of radius r around (cx, cy), connected to the centre: [{x, y, fx, fy (inward), w, a}]
  function ringExits(cx, cy, r, F) {
    const N = Math.max(48, Math.ceil(2 * Math.PI * r / 1.0)), ok = new Uint8Array(N), pts = [];
    for (let s = 0; s < N; s++) {
      const a = s / N * Math.PI * 2, x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      pts.push([x, y, a]);
      ok[s] = walkAt(x, y) && (!F || fDist(F, x, y) <= r * 1.8) ? 1 : 0;
    }
    let start = -1; for (let s = 0; s < N; s++) if (!ok[s]) { start = s; break; }
    const runs = [];
    if (start < 0) { for (let q = 0; q < 4; q++) runs.push({ s0: q * N / 4, len: N / 4 }); } // open space: 4 quadrants
    else {
      let s = start, cnt = 0;
      while (cnt < N) {
        s = (s + 1) % N; cnt++;
        if (ok[s]) { let len = 0; const s0 = s; while (ok[s] && len < N) { len++; s = (s + 1) % N; cnt++; } runs.push({ s0, len }); }
      }
    }
    const out = [];
    for (const r0 of runs) {
      const w = r0.len * 2 * Math.PI * r / N; if (w < 2.5) continue;
      const mid = pts[Math.floor(r0.s0 + r0.len / 2) % N];
      let fx = cx - mid[0], fy = cy - mid[1];
      if (F && fDir(F, mid[0], mid[1], tmp)) { fx = tmp.x; fy = tmp.y; }
      const l = hyp(fx, fy) || 1;
      out.push({ x: mid[0], y: mid[1], fx: fx / l, fy: fy / l, w, a: mid[2], distG: geo?.Fgoal ? fieldDist(geo.Fgoal, mid[0], mid[1]) : 0 });
    }
    return out;
  }
  function initGeo() {
    const g = sim.goal;
    geo = { Fgoal: computeField(g.x ?? g[0], g.y ?? g[1]) };
    const gx = g.x ?? g[0], gy = g.y ?? g[1];
    geo.posts = ringExits(gx, gy, PERIM_R, geo.Fgoal).map((e, i) => ({ ...e, fx: -e.fx, fy: -e.fy, i }));  // perimeter: face outward
    geo.gatePosts = ringExits(gx, gy, GATE_R, geo.Fgoal).map((e, i) => ({ ...e, fx: -e.fx, fy: -e.fy, i })); // v1.7 gate guard posts
    // staging for the mobile reserve: Concorde if near, else the widest exit of a 120 m ring
    const st = [];
    const C = sim.LM?.concorde; if (C) { const p = snapWalk(C[0], C[1]); if (p && fieldDist(geo.Fgoal, p.x, p.y) < 900) st.push(p); }
    for (const e of ringExits(gx, gy, 120, geo.Fgoal).sort((a, b) => b.w - a.w).slice(0, 3)) st.push({ x: e.x, y: e.y });
    if (!st.length) st.push({ x: gx, y: gy });
    geo.staging = st;
    // map-edge entry points for reinforcements
    const E = [], W = sim.W, H = sim.H, step = 90, inset = 15;
    const tryP = (x, y) => { const p = snapWalk(x, y, 10); if (p && Number.isFinite(fieldDist(geo.Fgoal, p.x, p.y))) E.push(p); };
    for (let x = inset; x < W; x += step) { tryP(x, inset); tryP(x, H - inset); }
    for (let y = inset; y < H; y += step) { tryP(inset, y); tryP(W - inset, y); }
    E.sort((a, b) => fieldDist(geo.Fgoal, a.x, a.y) - fieldDist(geo.Fgoal, b.x, b.y)); // nearest to the Élysée first
    geo.edges = E.slice(0, 16);
  }
  // point along the street path from (x, y) toward the goal, `ahead` metres from (x, y)
  function pointTowardGoal(x, y, ahead) {
    const q = snapWalk(x, y, 8); if (!q) return { x, y }; x = q.x; y = q.y;
    const path = tracePath(geo.Fgoal, x, y); let acc = 0;
    if (path.length <= 4) return { x, y };
    for (let k = 2; k < path.length; k += 2) { acc += hyp(path[k] - path[k - 2], path[k + 1] - path[k - 1]); if (acc >= ahead) return { x: path[k], y: path[k + 1] }; }
    return { x: path[path.length - 2], y: path[path.length - 1] };
  }
  function pointAtGoalDist(x, y, dG) { // first point on the path to the goal whose path distance is <= dG
    const q = snapWalk(x, y, 8); if (!q) return null;
    const path = tracePath(geo.Fgoal, q.x, q.y); if (path.length <= 4) return null;
    for (let k = 0; k < path.length; k += 2) if (fieldDist(geo.Fgoal, path[k], path[k + 1]) <= dG) return { x: path[k], y: path[k + 1] };
    return null;
  }

  // ===================================================================== operations (multi-squad tactics)
  function freeSquads(x, y, n, exclude = []) {
    return squads.filter(s => !s.op && !s.manual && s.role !== 'relief' && s.na >= 10 && !exclude.includes(s) && s.role !== 'perimeter')
      .sort((a, b) => hyp(a.x - x, a.y - y) - hyp(b.x - x, b.y - y)).slice(0, n);
  }
  function joinOp(op, sq, tactic) { sq.op = op; sq.role = 'op'; sq.slotKey = null; op.squads.push(sq); setTactic(sq, tactic); }
  function releaseOp(op, why = '') {
    for (const s of op.squads) { s.op = null; s.creep = null; s.gap = 0; if (!s.manual) s.role = 'free'; if (s.formation === 'line') layoutLine(s); setTactic(s, s.manual ? 'cordon' : 'cordon'); }
    op.phase = 'done'; op.tDone = T; police.urgent = true; police.doneOps.push(op); if (police.doneOps.length > 12) police.doneOps.shift();
    sim.emit(op.type, op.x, op.y, { phase: 'end', op: op.id });
    op.why = why; log(null, op.type + ' end #' + op.id + ' (' + why + ') filtered ' + op.filtered + ' arrests ' + op.arrests);
  }
  // flow field to a point ~14 m outside an exit (people are steered through the gap, not to it)
  function outsideField(e, op) { const p = snapWalk(e.x - e.fx * 14, e.y - e.fy * 14, 4) || e; return boxField(p.x, p.y, op.x, op.y, op.r * 1.6 + 30); }
  const areaField = (C, r) => boxField(C.x, C.y, C.x, C.y, r * 2.2 + 25);
  // kettle (nasse) with a filter exit: block every street out of radius r, leave one filtered gap, tighten, drain
  // v1.6: type 'cordon' = the same manoeuvre on a whole area (district block / street segment around a group)
  function startKettle(x, y, r = 22, list = null, type = 'kettle') {
    const C = snapWalk(x, y); if (!C) return null;
    const F = areaField(C, r); if (!F) return null;
    const exits = ringExits(C.x, C.y, r, F); if (!exits.length) return null;
    if (!list && exits.length > police.opBudget + 1) return null; // too many streets to close with what we have
    const sqs = list ? list.map(resolveSquad).filter(Boolean) : freeSquads(C.x, C.y, Math.min(exits.length, police.opBudget));
    if (!sqs.length) return null;
    // with too few squads, close the exits nearest to the goal and leave the farthest open (dispersal side)
    exits.sort((a, b) => a.distG - b.distG);
    const used = exits.slice(0, sqs.length);
    let filt = used[0]; for (const e of used) if (e.distG > filt.distG) filt = e;
    const op = { type, id: ++opSerial, x: C.x, y: C.y, r, F, phase: 'deploy', t: 0, squads: [], exits, used, filterSq: null, filterExit: filt, inside: 0, filtered: 0, arrests: 0, emptyT: 0, open: exits.length - used.length };
    const pool = sqs.slice();
    for (const e of used) { // nearest free squad per exit
      let bi = 0, bd = 1e9; pool.forEach((s, i) => { const d = hyp(s.x - e.x, s.y - e.y); if (d < bd) { bd = d; bi = i; } });
      const s = pool.splice(bi, 1)[0];
      joinOp(op, s, e === filt ? type + '-filter' : type);
      orderMove(s, e.x, e.y, e.fx, e.fy, { gap: e === filt ? 4 : 0 });
      if (e === filt) op.filterSq = s;
    }
    op.filterField = outsideField(filt, op);
    ops.push(op);
    sim.emit(type, C.x, C.y, { phase: 'deploy', op: op.id });
    police.counts[type === 'cordon' ? 'cordons' : 'kettles']++;
    log(null, `${type} #${op.id} at ${C.x | 0},${C.y | 0} r=${r} exits=${exits.length} squads=${op.squads.length}`);
    return op;
  }
  // funnel / fish trap: block the side streets, push from behind toward a filter exit where snatch teams wait
  function startFunnel(x, y, r = 25, list = null) {
    const C = snapWalk(x, y); if (!C) return null;
    const F = areaField(C, r); if (!F) return null;
    const exits = ringExits(C.x, C.y, r, F);
    if (exits.length < 2) return startKettle(x, y, r, list);
    let E = exits[0]; for (const e of exits) if (e.distG > E.distG) E = e; // filter exit: away from the Élysée
    let P = null, bd = -1; for (const e of exits) { if (e === E) continue; const da = Math.abs(Math.atan2(Math.sin(e.a - E.a), Math.cos(e.a - E.a))); if (da > bd) { bd = da; P = e; } }
    const blockers = exits.filter(e => e !== E && e !== P);
    const need = 2 + blockers.length;
    if (!list && need > police.opBudget + 1) return null;
    const sqs = list ? list.map(resolveSquad).filter(Boolean) : freeSquads(C.x, C.y, Math.min(need, police.opBudget));
    if (sqs.length < 2) return null;
    const op = { type: 'funnel', id: ++opSerial, x: C.x, y: C.y, r, F, phase: 'deploy', t: 0, squads: [], exits, filterSq: null, filterExit: E, pusher: null, inside: 0, filtered: 0, arrests: 0, emptyT: 0 };
    const pool = sqs.slice();
    const take = (px0, py0) => { let bi = 0, b = 1e9; pool.forEach((s, i) => { const d = hyp(s.x - px0, s.y - py0); if (d < b) { b = d; bi = i; } }); return pool.splice(bi, 1)[0]; };
    // pusher enters behind the crowd from P (10 m further out), faces in
    const pp = snapWalk(P.x - P.fx * 10, P.y - P.fy * 10, 6) || P;
    const pu = take(pp.x, pp.y); joinOp(op, pu, 'funnel-push'); op.pusher = pu; orderMove(pu, pp.x, pp.y, P.fx, P.fy);
    const fs = take(E.x, E.y); joinOp(op, fs, 'funnel-filter'); op.filterSq = fs; orderMove(fs, E.x, E.y, E.fx, E.fy, { gap: 4 }); fs.snatchCd = 0;
    for (const b of blockers.sort((a, c) => a.distG - c.distG)) { if (!pool.length) break; const s = take(b.x, b.y); joinOp(op, s, 'funnel-block'); orderMove(s, b.x, b.y, b.fx, b.fy); }
    op.filterField = outsideField(E, op);
    op.open = blockers.length - (op.squads.length - 2);
    ops.push(op);
    sim.emit('funnel', C.x, C.y, { phase: 'deploy', op: op.id }); police.counts.funnels++;
    log(null, `funnel #${op.id} at ${C.x | 0},${C.y | 0} exits=${exits.length} squads=${op.squads.length} open=${op.open}`);
    return op;
  }
  // split a long march at an intersection: two lines, back to back, separate the head from the tail
  function startSplit(Lid, list = null) {
    const L = sim.leaders[Lid]; if (!L || L.arrested) return null;
    const pts = [];
    for (let i = 0; i < sim.NA; i++) if (lead[i] === L.id) pts.push(i);
    if (pts.length < 60) return null;
    // v1.7: head / tail from the OBSERVED heading of the march (police can't read the order)
    const tr = police.tracks.get('L' + L.id), hx = tr?.hx || 0, hy = tr?.hy || 0;
    const prog = j => (hx || hy) ? -((px[j] - L.x) * hx + (py[j] - L.y) * hy) : hyp(px[j] - L.x, py[j] - L.y);
    pts.sort((a, b) => prog(a) - prog(b)); // head first
    let best = null;
    for (let q = 0.3; q <= 0.701; q += 0.05) {
      const j = pts[Math.floor(q * (pts.length - 1))], x = px[j], y = py[j];
      const nEx = ringExits(x, y, 14, null).length, score = nEx * 10 - Math.abs(q - 0.5) * 20;
      if (!best || score > best.score) best = { x, y, score, nEx, q };
    }
    let fx = L.x - best.x, fy = L.y - best.y;
    if (hx || hy) { fx = hx; fy = hy; }
    const l = hyp(fx, fy) || 1; fx /= l; fy /= l;
    const sqs = list ? list.map(resolveSquad).filter(Boolean) : freeSquads(best.x, best.y, 2);
    if (sqs.length < 2) return null;
    const op = { type: 'split', id: ++opSerial, x: best.x, y: best.y, r: 14, phase: 'deploy', t: 0, squads: [], leader: L, startCount: L.count, fx, fy, filtered: 0, arrests: 0 };
    const a = snapWalk(best.x + fx * 4, best.y + fy * 4, 4) || best, b = snapWalk(best.x - fx * 4, best.y - fy * 4, 4) || best;
    joinOp(op, sqs[0], 'split'); orderMove(sqs[0], a.x, a.y, fx, fy, { exact: true });   // faces the head
    joinOp(op, sqs[1], 'split'); orderMove(sqs[1], b.x, b.y, -fx, -fy, { exact: true }); // faces the tail
    ops.push(op);
    sim.emit('split', best.x, best.y, { phase: 'deploy', op: op.id, leader: L.id }); police.counts.splits++;
    log(null, `split #${op.id} of leader ${L.id} (${L.count}) at q=${best.q.toFixed(2)} exits=${best.nEx}`);
    return op;
  }
  function updateOps(dt, phaseActive) {
    for (let o = ops.length - 1; o >= 0; o--) {
      const op = ops[o]; op.t += dt;
      op.squads = op.squads.filter(s => squads.includes(s));
      if (!op.squads.length || op.phase === 'done' || (op.type !== 'split' && op.squads.length < 2 && op.phase !== 'deploy')) { if (op.phase !== 'done') releaseOp(op, 'undermanned'); ops.splice(o, 1); continue; }
      const deployed = op.squads.every(s => s.state !== 'move'), filterIn = !op.filterSq || !squads.includes(op.filterSq) || op.filterSq.state !== 'move';
      const nMoving = op.squads.filter(s => s.state === 'move').length;
      if (op.phase === 'deploy' && (deployed || (op.t > 150 && filterIn && nMoving <= 1) || op.t > 420)) {
        op.phase = 'closed'; op.tPhase = op.t;
        sim.emit(op.type, op.x, op.y, { phase: 'closed', op: op.id });
        log(null, `${op.type} #${op.id} closed at t+${op.t | 0}s`);
      }
      if (op.type === 'split') {
        if (op.phase === 'closed' && op.t - op.tPhase > 600) releaseOp(op);
        continue;
      }
      if (op.phase === 'closed' && op.t - op.tPhase > 15 && (filterIn || op.t - op.tPhase > 120)) {
        op.phase = 'drain'; log(null, `${op.type} #${op.id} drain`);
        if (op.type === 'kettle' || op.type === 'cordon') for (const s of op.squads) if (s !== op.filterSq) s.creep = { x: op.x, y: op.y, minD: op.r * (op.type === 'cordon' ? 0.4 : 0.45) };
        if (op.type === 'funnel' && op.pusher) { const E = op.filterExit; op.pusher.home = { x: op.pusher.anchor.x, y: op.pusher.anchor.y }; startPush(op.pusher, { x: E.x, y: E.y }, hyp(op.pusher.x - E.x, op.pusher.y - E.y) - 6); }
      }
      if (op.phase !== 'drain' && op.F && (op.cntT = (op.cntT || 0) - dt) <= 0) { // inside count before the drain (status / tests)
        op.cntT = 1; let n = 0; const R = op.r * 1.3; forEachNear(op.x, op.y, op.r + 2, j => { if (isProt(j) && fDist(op.F, px[j], py[j]) <= R) n++; }); op.inside = n;
      }
      if (op.phase === 'drain' && phaseActive) {
        drainOp(op, dt);
        // v1.6: gas behind the crowd at the closed exits drives it toward the filter gap
        if ((op.type === 'cordon' || op.type === 'kettle' || op.type === 'funnel') && op.inside > 15 && police.escalation >= 1) // [behaviour] (was escalation 2)
          for (const s of op.squads) if (s !== op.filterSq && s.formation === 'line' && s.gasCd <= 0 && s.state === 'hold' && s.energy > 10 && forceOK(s)) {
            gasAt(s, s.x + (op.x - s.x) * 0.45, s.y + (op.y - s.y) * 0.45, 2, 6); s.gasCd += 10; log(s, 'gas cordon');
          }
        if (op.inside < 6) op.emptyT += dt; else op.emptyT = 0;
        if (op.bestIn == null || op.inside < op.bestIn - 3) { op.bestIn = op.inside; op.progT = op.t; }
        if (op.emptyT > 20 || op.t - op.tPhase > 600 || op.t - op.progT > 180) releaseOp(op, op.emptyT > 20 ? 'empty' : 'timeout');
      }
    }
  }
  // people inside are directed to the filter gap (moderates first, radicals linger); the gap filters them
  function drainOp(op, dt) {
    const fs = op.filterSq && squads.includes(op.filterSq) ? op.filterSq : null;
    let inside = 0;
    const FF = op.filterField, F = op.F, R = op.r * 1.3;
    forEachNear(op.x, op.y, op.r + 2, j => {
      const a = act[j]; if (a === A_DOWN || a === A_ARRESTED) return;
      if (fDist(F, px[j], py[j]) > R) return;
      if (isProt(j)) inside++; // (bystanders are let out but do not keep the cordon up)
      if (!FF || !fDir(FF, px[j], py[j], tmp)) return;
      const k = offender(j) || aggr[j] > 0.65 ? 0.5 : 1.8;
      extFx[j] += tmp.x * k; extFy[j] += tmp.y * k;
    });
    op.inside = inside;
    if (!fs || fs.state === 'move') return;
    // filter: people passing behind the gap are checked: offenders arrested (rate-limited), others released home
    op.arrestCd = (op.arrestCd || 0) - dt;
    forEachNear(fs.x, fs.y, 9, j => {
      const a = act[j]; if (a === A_DOWN || a === A_ARRESTED) return;
      const al = alongOf(fs, px[j], py[j]), la = latOf(fs, px[j], py[j]);
      if (al > -2 || al < -9 || Math.abs(la - fs.gapLat) > 4) return;
      if ((offender(j) || aggr[j] > 0.7) && op.arrestCd <= 0 && !custodyFull(fs)) { arrestAgent(j, fs); op.arrests++; op.arrestCd = 2.5; }
      else if (al < -5) { removeAgent(j); sim.dispersedHome++; op.filtered++; police.counts.filtered++; }
      else { extFx[j] -= fs.dx * 2; extFy[j] -= fs.dy * 2; }
    });
  }

  // ===================================================================== v1.6 world model (intel picture)
  // Protester groups, rebuilt every INTEL_PERIOD s:
  //  - 'march': a leader's followers (centroid, spread, aggression share, heading); predicted route = the leader's current
  //    order (L.field) and from its end the shortest way to the Elysee gate, else the goal-directed flow field
  //  - 'riot': an uncontrolled riot (route toward its target; toward the gate when close to it)
  //  - 'loose': clusters (BIN m grid, 8-connected) of spread-out protesters: stragglers > 70 m from their leader, riot members
  //    > 80 m from their riot, unaffiliated offenders
  const wm = { cnt: null, sx: null, sy: null, off: null, lab: null, nbx: 0, nby: 0 };
  let clusterMem = [], clusterSerial = 0;
  const gDist = (x, y) => { const d = fieldDist(geo.Fgoal, x, y); return Number.isFinite(d) ? d : hyp(x - sim.goal.x, y - sim.goal.y) * 1.3; };
  // ---- v1.7 march intelligence: observed tracks and destination hypotheses (user feedback: "the police should only GUESS where
  // you are going"). Every TRACK_DT s the police record each active leader's position (what spotters / cameras see). A march's
  // heading is its displacement over the last TRACK_W s (TRACK_W_HELI with the helicopter, escalation >= 3), so a turn shows
  // only after about half a window. Candidate destinations (the gate and landmarks: squares, bridges, Opéra, Madeleine...) are
  // scored by how consistent the observed movement is with heading there (path-distance progress / distance moved) times a
  // prior (the gate is the favourite); the weights are smoothed over intel ticks. A stopped crowd is ambiguous: the weights relax
  // toward the priors. Up to 3 hypotheses with conf; the planner acts on the first.
  function trackLeaders() {
    for (const L of sim.leaders) {
      if (L.arrested || L.gone) continue;
      const key = 'L' + L.id; let tr = police.tracks.get(key);
      if (!tr) { tr = { s: [], w: null, top: null, hx: 0, hy: 0, v: 0 }; police.tracks.set(key, tr); }
      tr.s.push({ t: T, x: L.x, y: L.y });
      while (tr.s.length > 2 && T - tr.s[0].t > TRACK_KEEP) tr.s.shift();
    }
  }
  function destList() {
    if (geo.dests) return geo.dests;
    const D = [{ name: 'gate', x: sim.goal.x, y: sim.goal.y, F: geo.Fgoal, prior: DEST_PRIOR_GATE }];
    for (const k of DEST_KEYS) { const p = sim.LM?.[k]; if (!p) continue; const q = snapWalk(p[0], p[1], 40); if (!q || hyp(q.x - sim.goal.x, q.y - sim.goal.y) < 250) continue; D.push({ name: k, x: q.x, y: q.y, F: null, prior: 0 }); }
    for (const d of D) if (d.name !== 'gate') d.prior = (1 - DEST_PRIOR_GATE) / Math.max(1, D.length - 1);
    return geo.dests = D;
  }
  function destField(d) { if (!d.F) { const t0 = performance.now(); d.F = computeField(d.x, d.y); pt('destField', t0); } return d.F; }
  function inferMarch(G) {
    const tr = police.tracks.get(G.key), L = G.L;
    const D = destList(), W = police.escalation >= 3 ? TRACK_W_HELI : TRACK_W;
    let p0 = null;
    if (tr) for (let k = tr.s.length - 1; k >= 0; k--) { p0 = tr.s[k]; if (T - p0.t >= W) break; }
    const dt = p0 ? Math.max(1, T - p0.t) : 1, mx = p0 ? L.x - p0.x : 0, my = p0 ? L.y - p0.y : 0, moved = hyp(mx, my);
    const v = moved / dt, moving = moved > 20 && v > 0.15;
    if (tr) { if (moving) { tr.hx = mx / moved; tr.hy = my / moved; } tr.v = v; }
    // likelihood per destination
    const w = new Float64Array(D.length); let sum = 0;
    for (let k = 0; k < D.length; k++) {
      const d = D[k]; let lk = 1;
      if (moving) {
        const F = destField(d), a = fieldDist(F, p0.x, p0.y), b = fieldDist(F, L.x, L.y);
        const c = Number.isFinite(a) && Number.isFinite(b) ? clamp((a - b) / moved, -1.5, 1) : -1;
        lk = Math.exp(DEST_K * c);
        if (d.name !== 'gate' && b < 80) lk *= 0.15; // already there: not where it is going next
      }
      w[k] = d.prior * lk; sum += w[k];
    }
    for (let k = 0; k < D.length; k++) w[k] /= sum || 1;
    // smoothing across intel ticks (latency)
    if (tr) { if (!tr.w || tr.w.length !== D.length) tr.w = Array.from(w); else for (let k = 0; k < D.length; k++) tr.w[k] = tr.w[k] * DEST_SMOOTH + w[k] * (1 - DEST_SMOOTH); }
    const ws = tr ? tr.w : Array.from(w);
    const order = D.map((d, k) => k).sort((a, b) => ws[b] - ws[a]).slice(0, 3);
    const tot = order.reduce((a, k) => a + ws[k], 0) || 1;
    const hyps = order.filter((k, i) => i === 0 || ws[k] > 0.08).map(k => { // conf = the raw weight: a stopped crowd stays ambiguous (gate ~ prior 0.4)
      const d = D[k], F = destField(d);
      const flat = d.name === 'gate' ? tracePath(geo.Fgoal, G.x, G.y) : tracePath(F, G.x, G.y).concat(tracePath(geo.Fgoal, d.x, d.y).slice(2));
      return { name: d.name, x: d.x, y: d.y, conf: ws[k], flat };
    });
    // a change of the favourite = a visible turn: re-plan now (no grace on the block point)
    if (tr) { if (tr.top && tr.top !== hyps[0].name) { police.reordered.add(G.key); police.urgent = true; log(null, `intel: ${G.key} now heading for ${hyps[0].name} (${Math.round(hyps[0].conf * 100)}%)`); police.counts.intelTurns++; } tr.top = hyps[0].name; }
    return { hyps, moving, v };
  }
  function resample(flat, step = 15, maxLen = 2600) { // [x,y,...] -> [{x, y, s, dx, dy}]
    const out = []; if (flat.length < 2) return out;
    let s = 0, px0 = flat[0], py0 = flat[1], acc = step;
    for (let k = 0; k < flat.length; k += 2) {
      const x = flat[k], y = flat[k + 1], seg = hyp(x - px0, y - py0);
      s += seg; acc += seg; px0 = x; py0 = y;
      if (acc >= step || k === flat.length - 2) { out.push({ x, y, s, dx: 0, dy: 0 }); acc = 0; }
      if (s > maxLen) break;
    }
    for (let i = 0; i < out.length; i++) {
      const a = out[Math.max(0, i - 1)], b = out[Math.min(out.length - 1, i + 1)], l = hyp(b.x - a.x, b.y - a.y) || 1;
      out[i].dx = (b.x - a.x) / l; out[i].dy = (b.y - a.y) / l;
    }
    return out;
  }
  function buildWorld() {
    const NA = sim.NA, nbx = Math.ceil(sim.W / BIN), nby = Math.ceil(sim.H / BIN), NB = nbx * nby;
    if (!wm.cnt || wm.cnt.length !== NB) { wm.dens = new Int32Array(NB); wm.cnt = new Int32Array(NB); wm.sx = new Float32Array(NB); wm.sy = new Float32Array(NB); wm.off = new Int32Array(NB); wm.lab = new Int32Array(NB); wm.nbx = nbx; wm.nby = nby; }
    const { cnt, sx, sy, off, lab, dens } = wm; dens.fill(0); cnt.fill(0); sx.fill(0); sy.fill(0); off.fill(0); lab.fill(-1);
    const LS = sim.leaders, nL = LS.length, RS = sim.riots || [];
    const lg = LS.map(() => ({ n: 0, x: 0, y: 0, vx: 0, vy: 0, off: 0, r2: 0 }));
    const rById = new Map(); for (const r of RS) if (r.alive !== false) rById.set(r.id, { r, n: 0, x: 0, y: 0, vx: 0, vy: 0, off: 0 });
    for (let i = 0; i < NA; i++) {
      if (!isProt(i)) continue;
      { const b = Math.floor(py[i] / BIN) * nbx + Math.floor(px[i] / BIN); if (b >= 0 && b < NB) dens[b]++; }
      const o = isOffAct(act[i]) || T - lastOff[i] < 60 ? 1 : 0, l = lead[i], ri = riot[i];
      let loose = false, g = null;
      if (l >= 0 && l < nL) { const L = LS[l]; g = lg[l]; const d2 = (px[i] - L.x) ** 2 + (py[i] - L.y) ** 2; g.r2 += d2; if (d2 > 4900) loose = true; }
      else if (ri >= 0 && rById.has(ri)) { g = rById.get(ri); if ((px[i] - g.r.x) ** 2 + (py[i] - g.r.y) ** 2 > 6400) loose = true; }
      else loose = true;
      if (g) { g.n++; g.x += px[i]; g.y += py[i]; g.vx += vx[i]; g.vy += vy[i]; g.off += o; }
      if (loose) { const b = Math.floor(py[i] / BIN) * nbx + Math.floor(px[i] / BIN); if (b >= 0 && b < NB) { cnt[b]++; sx[b] += px[i]; sy[b] += py[i]; off[b] += o; } }
    }
    const groups = [];
    for (const L of LS) {
      if (L.arrested || L.gone) continue;
      const g = lg[L.id]; if (g.n < 10) continue;
      const n = g.n, cx = g.x / n, cy = g.y / n;
      groups.push({ key: 'L' + L.id, kind: 'march', leaderId: L.id, L, x: L.x, y: L.y, cx, cy, size: n, aggr: g.off / n, vx: g.vx / n, vy: g.vy / n, spread: Math.sqrt(g.r2 / n) });
    }
    for (const g of rById.values()) {
      if (g.n < 10) continue;
      const n = g.n;
      groups.push({ key: 'R' + g.r.id, kind: 'riot', riotId: g.r.id, riot: g.r, x: g.r.x, y: g.r.y, cx: g.x / n, cy: g.y / n, size: n, aggr: Math.max(g.off / n, 0.4 * (g.r.aggr ?? 0.5)), vx: g.vx / n, vy: g.vy / n, spread: g.r.spread || 25 });
    }
    // loose clusters: connected components of occupied bins
    const stack = [], newMem = [];
    for (let b = 0; b < NB; b++) {
      if (!cnt[b] || lab[b] >= 0) continue;
      let n = 0, x = 0, y = 0, o = 0, nb = 0; stack.push(b); lab[b] = b;
      while (stack.length) {
        const c = stack.pop(), cx = c % nbx, cy = (c - cx) / nbx; n += cnt[c]; x += sx[c]; y += sy[c]; o += off[c]; nb++;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const qx = cx + ox, qy = cy + oy; if (qx < 0 || qy < 0 || qx >= nbx || qy >= nby) continue;
          const q = qy * nbx + qx; if (cnt[q] && lab[q] < 0) { lab[q] = b; stack.push(q); }
        }
      }
      if (n < 3) continue;
      x /= n; y /= n;
      let key = null, bd = 100; for (const m of clusterMem) { const d = hyp(m.x - x, m.y - y); if (d < bd && !newMem.some(k => k.key === m.key)) { bd = d; key = m.key; } }
      if (!key) key = 'C' + (++clusterSerial);
      newMem.push({ key, x, y });
      groups.push({ key, kind: 'loose', x, y, cx: x, cy: y, size: n, aggr: o / n, offenders: o, vx: 0, vy: 0, spread: Math.sqrt(nb) * BIN * 0.5 });
    }
    clusterMem = newMem;
    // routes, threat
    for (const G of groups) {
      const q = snapWalk(G.x, G.y, 8); if (q) { G.x = q.x; G.y = q.y; }
      G.dG = gDist(G.x, G.y);
      let flat = null; G.ordered = false;
      if (G.kind === 'march') {
        // v1.7: the police GUESS where a march is going from what they can see (its track), never from the player's order
        const H = inferMarch(G);
        G.hyps = H.hyps; G.ordered = H.moving; G.dest = H.hyps[0];
        flat = H.hyps[0].flat;
        G.v = Math.max(H.moving ? 0.45 : 0.3, H.v);
      } else if (G.kind === 'riot') {
        const t = G.riot.target || (G.riot.tx != null ? { x: G.riot.tx, y: G.riot.ty } : null);
        flat = G.dG < 700 ? tracePath(geo.Fgoal, G.x, G.y) : t ? [G.x, G.y, t.x, t.y] : [G.x, G.y];
        G.v = Math.max(0.3, hyp(G.vx, G.vy));
      } else { G.v = 0.3; flat = [G.x, G.y]; }
      G.route = resample(flat);
      const p300 = G.route.find(p => p.s >= 300) || G.route[G.route.length - 1];
      const prog = p300 ? G.dG - gDist(p300.x, p300.y) : 0;
      G.heading = G.kind === 'march' ? (G.ordered ? clamp(prog / 300 + 0.2, 0.1, 1.2) : 0.45) : G.kind === 'riot' ? (G.dG < 700 ? 0.6 : 0.15) : 0.1;
      const last = G.route[G.route.length - 1];
      G.toGoal = !!last && hyp(last.x - sim.goal.x, last.y - sim.goal.y) < 60;
      G.etaGoal = G.toGoal ? last.s / G.v : null;
      G.threat = G.size * (0.6 + 2 * G.aggr) * (0.25 + G.heading) / (1 + G.dG / 900);
    }
    groups.sort((a, b) => b.threat - a.threat);
    police.groups = groups;
    // v1.7: one entry per hypothesis (marches: up to 3, with conf; riots: 1, conf 1). The first entry per group is the one the
    // planner acts on.
    const thin = rt => rt.filter((p, i) => i % 2 === 0 || i === rt.length - 1).slice(0, 120).map(p => [Math.round(p.x), Math.round(p.y)]);
    police.predict = [];
    for (const G of groups) {
      if (G.kind === 'loose' || G.route.length < 2) continue;
      const base = { key: G.key, kind: G.kind, leaderId: G.leaderId, riotId: G.riotId, size: G.size, threat: +G.threat.toFixed(1) };
      if (G.kind !== 'march' || !G.hyps) { police.predict.push({ ...base, pts: thin(G.route), eta: G.etaGoal != null ? Math.round(G.etaGoal) : null, toGoal: G.toGoal, conf: 1, dest: null, rank: 0 }); continue; }
      G.hyps.forEach((h, k) => {
        const rt = k === 0 ? G.route : resample(h.flat), last = rt[rt.length - 1];
        police.predict.push({ ...base, pts: thin(rt), eta: k === 0 && G.etaGoal != null ? Math.round(G.etaGoal) : null, toGoal: !!last && hyp(last.x - sim.goal.x, last.y - sim.goal.y) < 60, conf: +h.conf.toFixed(2), dest: h.name, rank: k });
      });
    }
  }

  // ===================================================================== v1.6 planner
  // Persistent plan slots (single-squad jobs: perimeter / block / response / hunt / clear) keyed by a stable key; multi-squad
  // operations (kettle / cordon / funnel / split) live in `ops`. Every INTEL_PERIOD s the planner re-scores everything against
  // the squads available: perimeter >= 2, early blocks on threatening routes, ops, then responses / secondary blocks / hunts
  // by score; the rest is reserve. Hysteresis: a squad keeps its slot (same key) and is only re-tasked after DWELL s unless the
  // new job scores 1.5x more; squads in contact are sticky; blocks keep their point while it still lies on the predicted route.
  let slots = new Map(), doneSlots = [];
  function relief(s, force) {
    if (s.role === 'relief' || s.gate) return; // v1.8: the gate guard is never relieved
    if (s.op) { s.op.squads = s.op.squads.filter(q => q !== s); s.op = null; s.creep = null; s.gap = 0; }
    s.role = 'relief'; s.slotKey = 'relief'; s.watch = null;
    const st = geo.staging[s.id % geo.staging.length];
    orderMove(s, st.x, st.y, s.dx, s.dy, { then: 'rest', tactic: 'relief' });
    if (force && s.field) { s.van = s.transit = true; police.counts.vanTrips++; }
    log(s, 'relief');
  }
  const segDist = (ax, ay, bx, by, px0, py0) => { const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey || 1e-9, t = clamp(((px0 - ax) * ex + (py0 - ay) * ey) / l2, 0, 1); return hyp(ax + ex * t - px0, ay + ey * t - py0); };
  // estimated travel time (s); avoid = a group whose crowd the trip would have to push through (+150 s)
  // metres of the straight trip that cross dense protest (density grid of the last intel tick, >= 10 per 40 m bin)
  function crowdedLen(ax, ay, bx, by) {
    const D = wm.dens; if (!D) return 0;
    const L = hyp(bx - ax, by - ay), n = Math.max(1, Math.ceil(L / 20)); let c = 0;
    for (let k = 1; k <= n; k++) { const x = ax + (bx - ax) * k / n, y = ay + (by - ay) * k / n, b = Math.floor(y / BIN) * wm.nbx + Math.floor(x / BIN); if (b >= 0 && b < D.length && D[b] >= 10) c++; }
    return c * L / n;
  }
  function travelT(q, x, y, avoid) {
    const d = hyp(q.x - x, q.y - y) * 1.3;
    const cl = crowdedLen(q.x, q.y, x, y) * 1.3;
    if (cl > 0) return (d - cl) / V_VAN + cl / 0.6 + 12 + (q.front >= 4 ? 30 : 0); // through the crowd on foot (slowed)
    const van = d > VAN_MIN && (q.transit || q.vanOK);              // vanOK: no crowd around it (planner tick)
    let t = van ? d / V_VAN + 12 : d > VAN_MIN ? Math.min(d, 120) / (V_MOVE * ef(q)) + Math.max(0, d - 120) / V_VAN + 12 : d / (V_MOVE * ef(q));
    if (q.front >= 4 || q.state === 'charge' || q.state === 'yield' || q.state === 'broken') t += 30;
    return t;
  }
  function crossLine(x, y, fx, fy) { const ax = lineAxis(x, y, fx, fy); return [[Math.round(x + ax.pxu * ax.left), Math.round(y + ax.pyu * ax.left)], [Math.round(x - ax.pxu * ax.right), Math.round(y - ax.pyu * ax.right)]]; }
  function circlePts(x, y, r, n = 20) { const o = []; for (let k = 0; k <= n; k++) { const a = k / n * Math.PI * 2; o.push([Math.round(x + Math.cos(a) * r), Math.round(y + Math.sin(a) * r)]); } return o; }
  function streetWidth(x, y, dx, dy) { const nx = -dy, ny = dx; return walkExtent(x, y, nx, ny, 25) + walkExtent(x, y, -nx, -ny, 25); }
  // block point on G's predicted route: the first stretch the police can reach before the crowd (squad van ETA + margin <
  // crowd ETA), at least BLOCK_MIN_AHEAD m ahead, then the narrowest mid-block point within BLOCK_WINDOW m of it
  function chooseBlock(G, free) {
    let firstS = null, best = null;
    for (const p of G.route) {
      if (p.s < BLOCK_MIN_AHEAD) continue;
      if (p.s > BLOCK_MAX_AHEAD) break;
      if (gDist(p.x, p.y) < BLOCK_MIN_DG) break;
      if (firstS == null) {
        const eta = p.s / G.v; let ok = false;
        for (const q of free) if (travelT(q, p.x, p.y, G) * 1.3 + 25 < eta) { ok = true; break; } // margin: deploy before the head arrives
        if (!ok) continue;
        firstS = p.s;
      }
      if (p.s > firstS + BLOCK_WINDOW) break;
      const w = streetWidth(p.x, p.y, p.dx, p.dy); if (w < 3) continue;
      const deg = ringExits(p.x, p.y, 13, null).length;
      const score = -w - (deg > 2 ? 7 * (deg - 2) : 0) - (p.s - firstS) * 0.012;
      if (!best || score > best.score) best = { x: p.x, y: p.y, dx: p.dx, dy: p.dy, s: p.s, w, deg, score };
    }
    return best;
  }
  const ringCache = new Map();
  function ringAt(R) { const k = Math.max(120, Math.round(R / 60) * 60); let e = ringCache.get(k); if (!e) { e = ringExits(sim.goal.x, sim.goal.y, k, geo.Fgoal); ringCache.set(k, e); } return e; }
  // stall tracking (a march held at a block -> cordon it)
  function routeHas(G, x, y, tol) { for (const p of G.route) if (hyp(p.x - x, p.y - y) < tol) return p; return null; }

  function plannerTick() {
    police.lastTick = T; police.ticks++;
    const phase = sim.day?.phase || 'day', dusk = phase === 'dusk', esc = police.escalation;
    let tw = performance.now(); buildWorld(); pt('world', tw);
    const groups = police.groups;
    // relief: exhausted or decimated squads rotate out to staging
    for (const s of squads) {
      if (s.manual || s.hunt) continue;
      if (s.role !== 'relief' && (s.energy < 12 || s.na < 8) && !(s.op && s.op.phase === 'drain' && s.na >= 8)) relief(s);
      else if (s.role === 'relief' && s.energy > 55 && s.na >= 8) { s.role = 'free'; s.slotKey = null; }
      if (s.role === 'relief' && s.na < 5 && s.state === 'rest') removeSquad(s);
    }
    // reinforcements from the map edges (day only, capped per day)
    const pool = () => squads.filter(s => !s.manual && s.role !== 'relief' && !s.hunt);
    const want = police.baseForce + 2 * esc;
    if (phase === 'day' && pool().length < want && police.reinforcementsToday < police.reinforceCap && geo.edges.length && T - police.lastReinforceT > 240) {
      const e = geo.edges[Math.floor(rand() * Math.min(6, geo.edges.length))];
      const s = addSquad(e.x, e.y, sim.goal.x - e.x, sim.goal.y - e.y, { n: SQ_N });
      if (s) { police.reinforcementsToday++; police.counts.reinforcements++; police.lastReinforceT = T; sim.emit('reinforcement', e.x, e.y, { squad: s.id }); }
    }
    // ops whose target escaped or vanished are released
    for (const op of ops) {
      if (!op.target || op.phase === 'done') continue;
      const G = groups.find(g => g.key === op.target);
      if (op.type === 'split') { if (!G || G.L?.arrested) releaseOp(op, 'target gone'); continue; }
      if (!G) { if (op.phase !== 'drain') releaseOp(op, 'target gone'); continue; }
      if (Math.min(hyp(G.x - op.x, G.y - op.y), hyp(G.cx - op.x, G.cy - op.y)) > (op.r || 20) + 70 && (op.inside || 0) < 15) { op.escT = (op.escT || 0) + INTEL_PERIOD; if (op.escT > 40) releaseOp(op, 'escaped'); } else op.escT = 0;
    }
    const avail = pool().filter(s => !s.op);
    for (const q of avail) q.vanOK = protNear(q.x, q.y, VAN_CLEAR_R, VAN_CLEAR_N) < VAN_CLEAR_N;
    // v1.7: a hunt team that was swamped or is spent (huntCool) walks back to its parent squad and merges; it is not re-tasked
    const huntTeams = squads.filter(s => s.hunt && !s.manual && !(s.huntCool > T));
    const huntCooling = squads.filter(s => s.hunt && !s.manual && s.huntCool > T);
    for (const tm of huntCooling) huntReturn(tm);
    const taken = new Set(), newSlots = new Map(), gaps = [];
    const freeList = () => avail.filter(q => !taken.has(q));
    function gap(c, why) { if ((c.kind === 'response' || c.kind === 'hunt') && (gaps.filter(g => g.kind === c.kind).length >= 3 || c.score < 40)) return; gaps.push({ t: Math.round(T), kind: c.kind, key: c.key, target: c.target, why }); }
    // staff a single-squad slot. c: {key, kind, x, y, fx, fy, score, eta?, order(q), target?, pts?, r?}
    function staff(c) {
      let s = avail.find(q => q.slotKey === c.key && !taken.has(q));
      // the job moved far (re-planned block): hand it to a clearly faster free squad instead of dragging the holder through the crowd
      if (s && s.slotPt && hyp(s.slotPt.x - c.x, s.slotPt.y - c.y) > 60) {
        const ts = travelT(s, c.x, c.y, c.avoid); let alt = null, ta = ts - 30;
        for (const q of avail) { if (q === s || taken.has(q) || (q.slotKey && q.slotKey !== 'reserve' && q.slotScore * 1.2 > c.score)) continue; const t = travelT(q, c.x, c.y, c.avoid); if (t < ta) { ta = t; alt = q; } }
        if (alt) { s.slotKey = null; s.slotPt = null; s = null; c.preferred = alt; }
      }
      if (!s && c.preferred) s = c.preferred;
      if (!s) {
        let bt = 1e9;
        for (const q of avail) {
          if (taken.has(q)) continue;
          if (!c.override && q.slotKey && q.slotKey !== 'reserve' && T - q.slotT < DWELL && q.slotScore * 1.5 > c.score) continue; // dwell hysteresis
          if (!c.override && q.slotKey && q.front >= 4 && q.slotScore * 2 > c.score) continue;                                     // in contact: sticky
          const t = travelT(q, c.x, c.y, c.avoid) + (q.energy < 35 ? 40 : 0); if (t < bt) { bt = t; s = q; }
        }
        if (s && c.eta != null && bt + 10 > c.eta) { gap(c, 'late'); return null; }
      }
      if (!s) { gap(c, 'no squad'); return null; }
      taken.add(s);
      let sl = slots.get(c.key);
      if (!sl) { sl = { id: ++opSerial, t0: T }; police.counts.plans++; }
      Object.assign(sl, c, { squads: [s] }); newSlots.set(c.key, sl);
      const moved = s.slotPt && hyp(s.slotPt.x - c.x, s.slotPt.y - c.y) > (c.kind === 'response' ? 45 : 12);
      if (s.slotKey !== c.key || moved) {
        if (s.slotKey !== c.key) { s.slotT = T; if (s.slotKey && s.slotKey !== 'reserve') police.counts.retasks++; }
        s.slotKey = c.key; s.role = c.kind; s.respT = c.respT || null; s.slotPt = { x: c.x, y: c.y }; s.planId = sl.id;
        c.order(s);
        log(s, 'assign ' + c.key);
      }
      s.slotScore = c.score; s.watch = c.watch || null;
      return s;
    }
    // ---- 1. perimeter: >= 2 squads on the approach streets ~PERIM_R m out, on the side the threats come from
    const routesToGoal = groups.filter(G => G.toGoal && G.kind !== 'loose');
    const postThreat = p => { let best = 1e9; for (const G of routesToGoal) { const tail = G.route.slice(-14); for (const r of tail) { const d = hyp(r.x - p.x, r.y - p.y) - G.threat * 0.3; if (d < best) best = d; } } return best; };
    const closeMarch = groups.filter(G => G.kind === 'march' && G.size >= 50).reduce((m, G) => Math.min(m, G.dG), 1e9);
    const nPer = Math.min(geo.posts.length, 2 + (closeMarch < 900 ? 1 : 0) + (closeMarch < 400 ? 1 : 0));
    const posts = geo.posts.map(p => ({ p, sc: postThreat(p) - p.w * 1.5 - (avail.some(q => q.slotKey === 'post' + p.i) ? 120 : 0) })).sort((a, b) => a.sc - b.sc).slice(0, nPer).map(o => o.p);
    posts.forEach((p, k) => staff({ key: 'post' + p.i, kind: 'perimeter', x: p.x, y: p.y, fx: p.fx, fy: p.fy, score: closeMarch < 600 ? 5000 : k < 2 ? 1000 : 300, override: closeMarch < 600, pts: crossLine(p.x, p.y, p.fx, p.fy), // v1.7: a march within 600 m: the gate posts are staffed first, whatever the squads are doing
      order: q => orderMove(q, p.x, p.y, p.fx, p.fy, { tactic: 'perimeter', maxAdv: 10 }) }));
    // ---- 2. per threatening group: multi-squad ops (escalation >= 2) or an early block
    const marches = groups.filter(G => G.kind === 'march' && G.size >= 25 && G.dG > 120);
    const nOps = () => ops.filter(o => o.phase !== 'done').length;
    const inOp = G => ops.some(o => o.phase !== 'done' && (o.target === G.key || hyp(o.x - G.x, o.y - G.y) < (o.r || 20) + 25));
    const tryRing = (G, r, need0) => { // squads for an encirclement: free + (the block squad already in contact)
      const ex = ringExits(G.x, G.y, r, null).length; return { ex, ok: ex > 0 && ex <= need0 + 1 };
    };
    function startOpOn(G, type, maxSq = 6) {
      if (police.doneOps.some(o => o.target === G.key && T - o.tDone < 180)) return null; // cool-down after an op on the same group
      const tMax = type === 'split' ? 200 : type === 'kettle' ? 200 : 260; // s: squads further away than this are no use for the op
      const free = freeList().filter(q => q.na >= 10 && q.slotKey !== 'blk:' + G.key && q.front < 4 && travelT(q, G.x, G.y) < tMax).sort((a, b) => hyp(a.x - G.x, a.y - G.y) - hyp(b.x - G.x, b.y - G.y));
      const blk = avail.find(q => q.slotKey === 'blk:' + G.key && q.state !== 'move' && hyp(q.x - G.x, q.y - G.y) < 80);
      if (type === 'cordon' && blk && !taken.has(blk) && !free.includes(blk)) free.unshift(blk);
      let op = null;
      if (type === 'split') { if (free.length < 2) return null; op = startSplit(G.leaderId, free.slice(0, 2)); }
      else if (type === 'funnel') { const r = clamp(Math.sqrt(G.size) + 12, 18, 32), { ex } = tryRing(G, r, free.length); if (ex < 2 || free.length < Math.min(ex, 4)) return null; op = startFunnel(G.x, G.y, r, free.slice(0, Math.min(ex, 5))); }
      else { // kettle (tight) / cordon (the area the group occupies: pick the radius that needs the fewest squads)
        let best = null;
        const radii = type === 'kettle' ? [clamp(Math.sqrt(G.size) + 10, 16, 32)] : [clamp(G.spread * 1.1 + 14, 25, 60), clamp(G.spread * 1.1 + 30, 35, 75), clamp(G.spread * 0.8 + 10, 22, 45)];
        let cx = type === 'cordon' ? G.cx : G.x, cy = type === 'cordon' ? G.cy : G.y; // a cordon closes the area the crowd occupies
        if (type === 'kettle' && hyp(G.vx, G.vy) > 0.3 && G.route.length > 2 && free.length >= 3) { // moving: ambush ahead on its route
          const eta = travelT(free[Math.min(2, free.length - 1)], G.x, G.y), p = G.route.find(q => q.s >= Math.min(300, G.v * eta)) || G.route[G.route.length - 1];
          cx = p.x; cy = p.y;
        }
        for (const r of radii) { const ex = ringExits(cx, cy, r, null).length; if (ex && (!best || ex < best.ex)) best = { r, ex }; }
        if (!best || best.ex > maxSq || free.length < Math.max(2, best.ex)) return null; // every exit closed (one of them is the filter)
        op = startKettle(cx, cy, best.r, free.slice(0, best.ex), type);
      }
      if (!op) return null;
      op.target = G.key; for (const s of op.squads) { taken.add(s); s.slotKey = null; s.watch = null; }
      return op;
    }
    const blockMem = police.blockMem;
    const opsOK = police.autoOps;
    for (const G of marches.slice(0, 3)) {
      if (dusk) break;
      if (inOp(G)) continue;
      const mem = blockMem[G.key];
      if (opsOK) {
      // a march held at our block for > 20 s (or sitting still for ~1 min anywhere) is cordoned off (the block squad becomes one
      // of the cordon lines)
      police.stillT[G.key] = hyp(G.vx, G.vy) < 0.3 ? (police.stillT[G.key] || 0) + INTEL_PERIOD : 0;
      if (esc >= 2 && ((mem && mem.stallT > 20) || police.stillT[G.key] > 50) && G.size < 400 && nOps() < MAX_OPS) { if (startOpOn(G, 'cordon')) { delete blockMem[G.key]; continue; } gap({ kind: 'cordon', key: 'cordon:' + G.key, target: G.key }, 'not enough squads in reach'); }
      if (esc >= 2 && G.size < 200 && G.dG > 250 && nOps() < MAX_OPS && freeList().length >= 3) { if (startOpOn(G, 'kettle')) continue; }
      if (esc >= 2 && G.size >= 300 && G.spread > 55 && hyp(G.vx, G.vy) > 0.4 && !(mem && mem.stallT > 0) && T - (police.splitT[G.key] || -1e9) > 600 && nOps() < MAX_OPS && freeList().length >= 5) { const op = startOpOn(G, 'split'); if (op) { police.splitT[G.key] = T; continue; } }
      if (esc >= 3 && G.size < 450 && G.dG > 250 && nOps() < MAX_OPS && freeList().length >= 4) { if (startOpOn(G, 'funnel')) continue; }
      }
      // early block on the predicted route (hysteresis: keep the point while it is still on the route ahead of the crowd)
      if (!G.toGoal && G.heading < 0.3) continue;
      let B = null;
      if (mem) { // keep the point unless the route has left it on two consecutive ticks (flow-field ties flicker)
        const onRoute = routeHas(G, mem.x, mem.y, 45), contact = hyp(G.x - mem.x, G.y - mem.y) < 70;
        const fresh = police.reordered.has(G.key); // new order: no grace
        if ((onRoute && onRoute.s > 15) || (contact && !fresh)) { B = mem; mem.miss = 0; } else if (!fresh && ++mem.miss < 2 && T - mem.t > 20) B = mem;
      }
      if (!B) { tw = performance.now(); B = chooseBlock(G, freeList()); pt('chooseBlock', tw); if (B) B.miss = 0; if (B) { B.t = T; B.stallT = 0; B.serial = (mem?.serial || 0) + 1; blockMem[G.key] = B; if (mem) log(null, `re-plan block ${G.key}: route changed`); police.counts.blocks++; } }
      if (!B) { gap({ kind: 'block', key: 'blk:' + G.key, target: G.key }, 'unreachable'); continue; }
      const rp = routeHas(G, B.x, B.y, 30), d = rp ? rp.s : hyp(G.x - B.x, G.y - B.y);
      const s = staff({ key: 'blk:' + G.key, kind: dusk ? 'clear' : 'block', target: G.key, avoid: G, x: B.x, y: B.y, fx: -B.dx, fy: -B.dy, score: 400 + G.threat, eta: B === mem ? null : d / G.v,
        pts: crossLine(B.x, B.y, -B.dx, -B.dy), watch: { x: G.x, y: G.y, d, L: G.L },
        order: q => orderMove(q, B.x, B.y, -B.dx, -B.dy, { tactic: 'block', maxAdv: 10 }) });
      if (s && s.state !== 'move' && (s.front >= 4 || s.near >= 15 || hyp(G.x - s.x, G.y - s.y) < 250) && hyp(G.vx, G.vy) < 0.45) B.stallT = (B.stallT || 0) + INTEL_PERIOD; else if (B.stallT) B.stallT = Math.max(0, B.stallT - INTEL_PERIOD / 2);
    }
    for (const k in blockMem) if (!marches.some(G => G.key === k)) delete blockMem[k];
    police.reordered.clear();
    // riots and loose aggressive clusters: kettle / funnel / cordon when the police can afford it
    if (!dusk && esc >= 2 && opsOK) for (const G of groups) {
      if (G.kind === 'march' || nOps() >= MAX_OPS || inOp(G)) continue;
      if (G.kind === 'riot' && G.size < 220 && freeList().length >= 3) { if (startOpOn(G, 'kettle')) continue; }
      if (G.kind === 'riot' && G.size < 450 && freeList().length >= 4) { if (startOpOn(G, 'funnel')) continue; }
      if (G.kind === 'loose' && G.size >= 25 && G.aggr >= 0.2 && freeList().length >= 3) { if (startOpOn(G, 'cordon', 3)) continue; }
    }
    // ---- 3. scored candidates: responses to looting / fires / riots, secondary blocks (screen the parallel streets), hunts
    const cands = [];
    const hot = lootHotspots();
    const respKey = (x, y, k) => { for (const [key, sl] of slots) if (sl.kind === 'response' && sl.respT && hyp(sl.respT.x - x, sl.respT.y - y) < 100) return key; return k; };
    for (const h of hot) if (h.people >= 4 || h.shops >= 3) cands.push({ kind: 'response', key: respKey(h.x, h.y, 'resp' + h.key), target: h.key, x: h.x, y: h.y, score: Math.min(140, 12 * h.shops + 2.5 * h.people) / (1 + h.dG / 4000), hs: h });
    for (const G of groups) if (G.kind === 'riot' && !inOp(G)) cands.push({ kind: 'response', key: respKey(G.x, G.y, 'resp' + G.key), target: G.key, x: G.x, y: G.y, score: G.size * (0.5 + G.aggr) / 3 / (1 + G.dG / 3000), hs: G });
    if (!dusk) for (const G of marches.slice(0, 2)) {
      const B = blockMem[G.key]; if (!B || inOp(G)) continue;
      const R = hyp(B.x - sim.goal.x, B.y - sim.goal.y), bear = Math.atan2(B.y - sim.goal.y, B.x - sim.goal.x);
      const exits = ringAt(R).filter(e => hyp(e.x - B.x, e.y - B.y) > 45 && Math.abs(Math.atan2(Math.sin(e.a - bear), Math.cos(e.a - bear))) < 1.0)
        .map(e => ({ e, d: hyp(e.x - B.x, e.y - B.y) })).filter(o => o.d < 450).sort((a, b) => a.d - b.d).slice(0, 2);
      exits.forEach(({ e, d }, k) => cands.push({ kind: 'block', key: 'scr:' + G.key + ':' + Math.round(e.x / 25) + ',' + Math.round(e.y / 25), target: G.key, x: e.x, y: e.y, fx: -e.fx, fy: -e.fy,
        score: 70 * Math.min(1.5, G.threat / Math.max(1, marches[0].threat)) - k * 10, eta: hyp(G.x - e.x, G.y - e.y) * 1.2 / G.v, secondary: true }));
    }
    for (const G of groups) if (G.kind === 'loose' && G.size >= 3 && !inOp(G) && ((G.offenders || 0) >= 1 || esc >= 3)) cands.push({ kind: 'hunt', key: 'hunt:' + G.key, target: G.key, x: G.x, y: G.y, r: Math.max(20, G.spread), score: 15 + 3 * (G.offenders || 0) + G.size * 0.5 + (esc >= 2 ? 10 : 0) });
    for (const c of cands) { const sl = slots.get(c.key); if (sl) sl.lastWanted = T; }
    for (const [k, sl] of slots) { // grace: response / hunt / screen jobs stay wanted for 40 s after they drop out of the picture
      if (sl.lastWanted == null) sl.lastWanted = sl.t0;
      if ((sl.kind === 'response' || sl.kind === 'hunt' || sl.secondary) && !cands.some(c => c.key === k) && T - sl.lastWanted < 40 && sl.squads.some(q => squads.includes(q) && q.slotKey === k))
        cands.push({ ...sl, score: sl.score * 0.75, squads: undefined, eta: null, grace: true });
    }
    { const seenK = new Map(); for (const c of cands) { const o = seenK.get(c.key); if (!o || c.score > o.score) seenK.set(c.key, c); } cands.length = 0; cands.push(...seenK.values()); }
    // hysteresis: jobs already staffed score 30 % more
    for (const c of cands) if (slots.has(c.key)) c.score *= 1.3;
    cands.sort((a, b) => b.score - a.score);
    // hunt teams: detached from a reserve-like squad (HUNT_N officers), max 1 + esc/2
    const maxHunts = Math.max(0, Math.min(3, 1 + Math.floor(esc / 2)) - huntCooling.length);
    const huntsWanted = cands.filter(c => c.kind === 'hunt').slice(0, maxHunts);
    const huntFree = huntTeams.slice();
    for (const c of huntsWanted) { // a team keeps sweeping "its" area while a cluster is still there (cluster keys flicker)
      let tm = huntFree.find(q => q.slotKey === c.key) || huntFree.find(q => q.slotPt && q.slotKey?.startsWith('hunt:') && hyp(q.slotPt.x - c.x, q.slotPt.y - c.y) < 90) || null;
      if (!tm && huntFree.length) { let bd = 1e9; for (const q of huntFree) { const d = hyp(q.x - c.x, q.y - c.y); if (d < bd) { bd = d; tm = q; } } }
      if (!tm) continue;
      huntFree.splice(huntFree.indexOf(tm), 1);
      let sl = slots.get(c.key); if (!sl) { sl = { id: ++opSerial, t0: T }; police.counts.plans++; }
      Object.assign(sl, c, { squads: [tm], pts: circlePts(c.x, c.y, c.r, 14) }); newSlots.set(c.key, sl);
      const far = !tm.slotPt || hyp(tm.slotPt.x - c.x, tm.slotPt.y - c.y) > 30;
      if (tm.slotKey !== c.key && !far) { tm.slotKey = c.key; tm.planId = sl.id; }
      if (far) {
        tm.slotKey = c.key; tm.slotPt = { x: c.x, y: c.y }; tm.role = 'hunt'; tm.planId = sl.id; tm.idleT = 0;
        const p = snapWalk(c.x, c.y, 10); if (p) orderMove(tm, p.x, p.y, p.x - tm.x, p.y - tm.y, { tactic: 'hunt', maxAdv: 6 });
      }
      c.done = true;
    }
    for (const tm of huntFree) huntReturn(tm);
    let huntsToMake = huntsWanted.filter(c => !c.done).length;
    for (const c of cands) {
      if (c.kind === 'hunt') continue;
      if (!freeList().length) { gap(c, 'no squad'); continue; }
      if (c.kind === 'response') {
        const h = c.hs, ap = pointTowardGoal(h.x, h.y, 35), away = { x: h.x + (h.x - ap.x) * 3, y: h.y + (h.y - ap.y) * 3 };
        staff({ ...c, x: ap.x, y: ap.y, respT: { x: h.x, y: h.y }, pts: [[Math.round(ap.x), Math.round(ap.y)], [Math.round(h.x), Math.round(h.y)]],
          order: q => orderMove(q, ap.x, ap.y, h.x - ap.x, h.y - ap.y, { tactic: dusk ? 'clear' : 'advance', then: 'push', pushTo: away, pushDist: 90 }) });
      } else if (c.kind === 'block') {
        staff({ ...c, pts: crossLine(c.x, c.y, c.fx, c.fy), order: q => orderMove(q, c.x, c.y, c.fx, c.fy, { tactic: 'block', maxAdv: 10 }) });
      }
    }
    // dusk: clear the streets of marches (push them away from the Elysee)
    if (dusk) for (const G of marches) {
      if (!freeList().length) break;
      if (G.dG > 2200 || G.dG < 150) continue;
      const p = pointAtGoalDist(G.x, G.y, clamp(G.dG - 120, 150, 320)); if (!p) continue;
      staff({ kind: 'clear', key: 'clear:' + G.key, target: G.key, x: p.x, y: p.y, fx: G.x - p.x, fy: G.y - p.y, score: 200, pts: crossLine(p.x, p.y, G.x - p.x, G.y - p.y),
        order: q => orderMove(q, p.x, p.y, G.x - p.x, G.y - p.y, { tactic: 'clear', then: 'push', pushTo: { x: G.x + (G.x - p.x), y: G.y + (G.y - p.y) }, pushDist: 120, maxAdv: 25 }) });
    }
    // ---- 4. the rest is the mobile reserve at staging points; new hunt teams peel off reserve squads
    let si = 0;
    for (const s of freeList()) {
      if (huntsToMake > 0 && s.na >= 20 && s.formation === 'line' && s.front === 0 && s.state === 'hold' && !dusk) { const tm = detachHunt(s); if (tm) { huntsToMake--; police.urgent = true; } }
      const st = geo.staging[si++ % geo.staging.length], off = Math.floor((si - 1) / geo.staging.length) * 14;
      const key = 'reserve' + ((si - 1) % geo.staging.length) + ':' + off;
      if (s.slotKey !== key) { const was = s.slotKey; s.slotKey = key; s.role = 'reserve'; s.watch = null; s.slotScore = 0; s.slotPt = null; s.planId = 0; if (!was || !was.startsWith('reserve')) s.slotT = T;
        orderMove(s, st.x - s.dx * off, st.y - s.dy * off, sim.goal.x - st.x, sim.goal.y - st.y, { tactic: 'reserve', then: 'hold' }); log(s, 'assign ' + key); }
    }
    // still short of hunt teams: peel one off a quiet line (perimeter / block / op squad not in contact, >= 22 officers)
    if (huntsToMake > 0 && !dusk) for (const s of squads) {
      if (huntsToMake <= 0) break;
      if (s.hunt || s.manual || s.role === 'relief' || s.na < 22 || s.formation !== 'line' || s.state !== 'hold' || s.front > 0 || s.near > 5) continue;
      if (detachHunt(s)) huntsToMake--;
    }
    // slots that are no longer wanted are 'done' (kept visible for a moment)
    for (const [k, sl] of slots) if (!newSlots.has(k)) { sl.tDone = T; doneSlots.push(sl); }
    while (doneSlots.length > 20) doneSlots.shift();
    slots = newSlots;
    const prevG = police._gapKeys || new Set(), curG = new Set(gaps.map(g => g.key));
    for (const g of gaps) if (!prevG.has(g.key)) { police.counts.gaps++; police.gaps.push(g); }
    if (police.gaps.length > 400) police.gaps.splice(0, 100);
    police._gapKeys = curG;
    police.lastGaps = gaps;
    police.threats = groups.slice(0, 8).map(G => ({ kind: G.kind, key: G.key, x: G.x | 0, y: G.y | 0, size: G.size, score: +G.threat.toFixed(1), dG: G.dG | 0 }));
    buildPlan();
  }
  // looting hotspots and fires (clustered within 60 m), remembered for a while
  function lootHotspots() {
    const shops = sim.shops || [];
    if (!police._lootSnap || police._lootSnap.length !== shops.length) police._lootSnap = Float32Array.from(shops, s => s.looted || 0); // only new looting counts
    const snap = police._lootSnap;
    const hot = [];
    for (let i = 0; i < shops.length; i++) {
      const s = shops[i], d = (s.looted || 0) - snap[i];
      if (d > 0.005 || (s.burning && police._burnSeen?.[i] !== 1)) hot.push({ x: s.x, y: s.y, d: Math.max(d, 0.1) });
      snap[i] = s.looted || 0;
      if (s.burning) (police._burnSeen ||= {})[i] = 1;
    }
    for (const f of sim.fires || []) if ((f.intensity ?? 1) > 0.3 && f.kind !== 'molotov' && f.age < 600) hot.push({ x: f.x, y: f.y, d: 0.08 });
    const used = new Uint8Array(hot.length), out = [];
    for (let a = 0; a < hot.length; a++) {
      if (used[a]) continue; used[a] = 1;
      let sx = hot[a].x, sy = hot[a].y, sd = hot[a].d, n = 1;
      for (let b = a + 1; b < hot.length; b++) if (!used[b] && hyp(hot[b].x - hot[a].x, hot[b].y - hot[a].y) < 90) { used[b] = 1; sx += hot[b].x; sy += hot[b].y; sd += hot[b].d; n++; }
      const x = sx / n, y = sy / n, q = snapWalk(x, y, 8) || { x, y };
      const people = protNear(q.x, q.y, 35, 60);
      out.push({ x: q.x, y: q.y, size: 20 + 60 * sd + people, people, shops: n, key: 'S' + Math.round(x / 120) + ',' + Math.round(y / 120), dG: gDist(q.x, q.y) });
    }
    const mem = police.hotspots;
    for (const t of out) { const m = mem.find(h => h.key === t.key); if (m) { Object.assign(m, t); m.seen = T; } else mem.push({ ...t, seen: T }); }
    for (let h = mem.length - 1; h >= 0; h--) if (T - mem[h].seen > 900) mem.splice(h, 1);
    for (const m of mem) if (!out.some(t => t.key === m.key)) { m.people = protNear(m.x, m.y, 35, 60); out.push({ ...m, shops: m.shops * 0.6 }); }
    return out;
  }
  // ---- hunt teams: HUNT_N officers detached from a squad; they rejoin it (or the nearest squad) when no longer needed
  function detachHunt(parent) {
    const k = HUNT_N; if (parent.na - k < 12) return null;
    const tm = addSquad(parent.x - parent.dx * 4, parent.y - parent.dy * 4, parent.dx, parent.dy, { n: k, hunt: true, parentId: parent.id, tactic: 'hunt' });
    if (!tm) return null;
    for (let q = 0; q < k; q++) { const o = parent.na - 1 - q; tm.hp[q] = parent.hp[o]; tm.ox[q] = parent.ox[o]; tm.oy[q] = parent.oy[o]; }
    tm.energy = parent.energy; tm.role = 'hunt'; tm.slotKey = null;
    parent.na -= k; if (parent.formation === 'line') layoutLine(parent);
    police.counts.hunts++; log(tm, 'hunt team from ' + parent.id);
    return tm;
  }
  function huntWithdraw(tm) {
    if (tm.huntCool > T) return;
    tm.huntCool = T + 150; tm.slotKey = null; log(tm, 'hunt team withdraws');
    huntReturn(tm);
  }
  function huntReturn(tm) {
    const p = squads.find(s => s.id === tm.parentId && !s.hunt) || nearestSquad(tm.x, tm.y, s => !s.hunt && s !== tm);
    if (!p) return;
    tm.parentId = p.id;
    if (tm.slotKey !== 'rejoin' || hyp(tm.slotPt.x - p.x, tm.slotPt.y - p.y) > 15) { tm.slotKey = 'rejoin'; tm.role = 'hunt'; tm.slotPt = { x: p.x, y: p.y }; tm.planId = 0; orderMove(tm, p.x - p.dx * 4, p.y - p.dy * 4, p.dx, p.dy, { tactic: 'hunt' }); }
  }
  function mergeHunts() {
    for (let s = squads.length - 1; s >= 0; s--) {
      const tm = squads[s]; if (!tm.hunt || tm.slotKey !== 'rejoin' || tm.state === 'move') continue;
      const p = squads.find(q => q.id === tm.parentId); if (!p || hyp(p.x - tm.x, p.y - tm.y) > 14) { if (tm.state !== 'move') tm.slotKey = null; continue; }
      if (teams.some(t => t.sq === tm)) continue;
      for (let q = 0; q < tm.na && p.na < CAP - p.downed.length; q++) { const k = p.na++; p.ox[k] = tm.ox[q]; p.oy[k] = tm.oy[q]; p.hp[k] = tm.hp[q]; }
      if (p.formation === 'line') layoutLine(p);
      for (const r of arrestees) if (r.sq === tm) r.sq = p;
      log(tm, 'hunt team rejoined ' + p.id); squads.splice(s, 1);
    }
  }

  // ===================================================================== v1.6 plan output (sim.police.plan, contract v1.5)
  function opRadius(op) {
    let s = 0, n = 0; for (const q of op.squads) if (q !== op.filterSq && q.state !== 'move') { s += hyp(q.x - op.x, q.y - op.y); n++; }
    return n ? s / n : op.r;
  }
  function buildPlan() {
    const out = [], live = s => squads.includes(s);
    for (const sl of slots.values()) {
      const sqs = sl.squads.filter(s => live(s) && s.slotKey === sl.key);
      const status = !sqs.length ? 'planned' : sqs.some(s => s.state === 'move') ? 'moving' : 'active';
      let pts = sl.pts;
      if (status === 'active' && (sl.kind === 'block' || sl.kind === 'perimeter' || sl.kind === 'clear')) { const q = sqs[0]; pts = [[Math.round(q.x + q.pxu * q.left), Math.round(q.y + q.pyu * q.left)], [Math.round(q.x - q.pxu * q.right), Math.round(q.y - q.pyu * q.right)]]; }
      if (sl.kind === 'hunt') pts = circlePts(sl.x, sl.y, sl.r || 25, 14);
      out.push({ id: sl.id, kind: sl.kind, x: Math.round(sl.x), y: Math.round(sl.y), r: sl.r, pts, squads: sqs.map(s => s.id), status, target: sl.target, score: Math.round(sl.score), secondary: sl.secondary || undefined });
    }
    for (const op of ops) {
      if (op.phase === 'done') continue;
      const moving = op.squads.some(s => s.state === 'move');
      const status = op.phase === 'drain' ? 'closing' : op.phase === 'deploy' && moving ? 'moving' : 'active';
      const r = op.type === 'split' ? 14 : opRadius(op);
      const pts = op.type === 'split' ? [[Math.round(op.x - op.fy * 12), Math.round(op.y + op.fx * 12)], [Math.round(op.x + op.fy * 12), Math.round(op.y - op.fx * 12)]] : circlePts(op.x, op.y, r, 24);
      out.push({ id: op.id, kind: op.type, x: Math.round(op.x), y: Math.round(op.y), r: Math.round(r), pts, squads: op.squads.filter(live).map(s => s.id), status, target: op.target,
        filter: op.filterExit ? [Math.round(op.filterExit.x), Math.round(op.filterExit.y)] : undefined, inside: op.inside, arrests: op.arrests, filtered: op.filtered });
    }
    for (const sl of doneSlots) if (T - sl.tDone < 15) out.push({ id: sl.id, kind: sl.kind, x: Math.round(sl.x), y: Math.round(sl.y), r: sl.r, pts: sl.pts, squads: [], status: 'done', target: sl.target });
    for (const op of police.doneOps) if (T - op.tDone < 20) out.push({ id: op.id, kind: op.type, x: Math.round(op.x), y: Math.round(op.y), r: op.r, pts: op.type === 'split' ? undefined : circlePts(op.x, op.y, op.r, 24), squads: [], status: 'done', target: op.target });
    // timeline of plan changes (debug / tests): one entry per op id and status change
    const seen = police._planSeen || (police._planSeen = new Map());
    for (const p of out) { const k = p.status + ':' + p.squads.join(','); if (seen.get(p.id) !== k) { seen.set(p.id, k); police.timeline.push({ t: Math.round(T), id: p.id, kind: p.kind, status: p.status, squads: p.squads.slice(), target: p.target }); } }
    if (police.timeline.length > 3000) police.timeline.splice(0, 1000);
    if (seen.size > 600) for (const k of [...seen.keys()].slice(0, 300)) seen.delete(k);
    police.plan = out;
  }

  // ===================================================================== v1.8 leader exposure (see EXP_* above)
  let expT = 0;
  function leaderExposure(dt) {
    if ((expT -= dt) > 0) return; expT = EXP_DT;
    const esc = police.escalation, g = sim.goal;
    for (const L of sim.leaders) {
      if (L.arrested || L.gone) continue;
      const E = L.pexp || (L.pexp = { t: L.successor ? -EXP_T : 0, own: 0, ready: false, mult: 1, chargeT: -1e9, kettled: false }); // a mid-day successor gets a grace period
      let own = 0;
      forEachNear(L.x, L.y, EXP_R, j => { if (lead[j] === L.id && panicT[j] <= 0 && act[j] !== A_DOWN && act[j] !== A_ARRESTED && ++own >= 40) return true; });
      const dense = countNear(L.x, L.y, 5), dG = hyp(L.x - g.x, L.y - g.y);
      let kettled = false;
      for (const op of ops) if ((op.type === 'kettle' || op.type === 'cordon' || op.type === 'funnel') && (op.phase === 'closed' || op.phase === 'drain') && hyp(L.x - op.x, L.y - op.y) < (op.r || 20) * 1.3) { kettled = true; break; }
      let m = EXP_STANCE[L.stance] ?? 1;
      if (dG < 300) m *= 3; else if (dG < 700) m *= 1.8; else if (dG < 1500) m *= 1; else m *= 0.5; // far from the gate: half rate
      if (L.count < 120) m *= 2;
      if (esc >= 4) m *= 1.25;
      if (kettled) m *= 1.5;
      if (T - E.chargeT < 20) m *= 2;
      m = Math.min(EXP_MULT_MAX, m) * EXP_DAY[clamp((sim.day?.day || 4) - 1, 0, 6)];
      const exposed = own < EXP_OWN && dense < EXP_DENSE;
      E.t = exposed ? Math.min(EXP_T * 2, E.t + EXP_DT * m) : E.t > 0 ? Math.max(0, E.t - EXP_DT * EXP_DECAY) : E.t;
      E.own = own; E.mult = m; E.kettled = kettled; E.exposed = exposed;
      E.ready = E.t >= EXP_T && (esc >= 3 || (esc >= 2 && (L.stance === 'unleashed' || dG < 700))); // (a kettle speeds exposure up but no longer lowers the escalation bar)
    }
  }

  // ===================================================================== escalation
  function updateEscalation(dt, phase) {
    const p = police;
    // v1.6 floors: rise as marches approach the 8th arrondissement (path distance to the gate), and with riots
    // v1.7: the proximity floors are softer on the first days (day 1: -1 level, day 2: -0.5): day 1 is the tutorial
    let floor = p.baseEscalation;
    const soft = Math.max(0, 3 - (sim.day?.day || 3)) * 0.5;
    for (const G of p.groups || []) {
      if (G.kind === 'march' && G.size >= 60) { if (G.dG < 1500) floor = Math.max(floor, 2 - soft); if (G.dG < 700) floor = Math.max(floor, 3 - soft); if (G.dG < 200) floor = Math.max(floor, 3.5 - soft); }
      else if (G.kind === 'riot' && G.size >= 50 && G.aggr >= 0.15) floor = Math.max(floor, 2);
    }
    if (phase === 'dusk') floor = Math.max(floor, 2);
    p.heat -= dt / 2400; // one level per 40 min of calm
    p.heat = clamp(Math.max(p.heat, floor), 0, 4.99);
    const lvl = Math.floor(p.heat);
    if (lvl !== p.escalation) { const up = lvl > p.escalation; p.escalation = lvl; sim.emit('escalation', sim.goal.x, sim.goal.y, { level: lvl }); log(null, 'escalation ' + lvl); if (up) p.urgent = true; }
  }
  // escalation pressure from violence; at most +1 level per 10 sim-minutes (v1.6, was 0.6)
  function addHeat(v) {
    const p = police;
    if (T - p.heatWinT > 600) { p.heatWinT = T; p.heatWin = 0; }
    const room = HEAT_WIN - p.heatWin; if (room <= 0) return;
    v = Math.min(v * 1.5, room); p.heatWin += v; p.heat += v;
  }
  function onEvent(e) {
    const p = police; if (!p) return;
    switch (e.type) {
      case 'dayStart': if (police.dayDone !== e.day) dayStart(); break; // v1.8: also after a day that ended early (leaderless) in the 'day' phase
      case 'loot': addHeat(0.01); break;
      case 'fire': addHeat(0.03); p.urgent = true; break;
      case 'explosion': addHeat(0.03); break;
      case 'throw': if (e.owner === 'C') { addHeat(0.004); throwAt(e); } break; // [behaviour] throwAt // crowd projectiles ('P' = police)
      case 'shatter': addHeat(0.01); break;
      case 'brawl': addHeat(0.003); break; // v1.7: 0.003 (was 0.01: brawl stars alone pushed level 4)
      case 'impact': // police LBD that hit someone: brutality if the victim had no visible offence
        if (e.owner === 'P' && e.kind === 'lbd' && e.direct) {
          let b = -1, bd = 1.5; forEachNear(e.x, e.y, 1.5, (j, ex, ey, d2) => { const d = Math.sqrt(d2); if (d < bd) { bd = d; b = j; } });
          if (b >= 0) brutalityCheck(b, 'lbd', false);
        }
        break;
    }
  }
  function dayStart() {
    police.dayDone = sim.day?.day; // v1.8: once per day (event or phase change)
    police.reinforcementsToday = 0;
    police.baseEscalation = BASE_ESC[clamp((sim.day?.day || 1) - 1, 0, 6)];
    police.heat = Math.max(police.baseEscalation, police.heat * 0.5);
    police._lootSnap = null; police._burnSeen = {}; police.hotspots.length = 0;
    police.splitT = {}; police.stillT = {}; police.blockMem = {}; police.warnAreas.length = 0; clusterMem = []; slots = new Map(); doneSlots = [];
    for (const s of squads) { s.energy = Math.min(100, s.energy + 60); s.warn = 0; s.gasStock = GAS_STOCK; s.lbdStock = 12; }
    police.cmdT = 1; // redeploy right away
    police.tracks.clear();
  }

  // ===================================================================== main update
  function update(dt) {
    const t0 = performance.now();
    updateInner(dt);
    police.ms += performance.now() - t0; police.msSteps++;
  }
  function updateInner(dt) {
    T = sim.simTime;
    if (!geo) initGeo();
    const phase = sim.day?.phase || 'day', active = phase === 'day' || phase === 'dusk';
    if (phase !== lastPhase) {
      if (phase === 'day' && lastPhase !== null && police.dayDone !== sim.day?.day) dayStart();
      if (phase === 'dusk') { police.urgent = true; police.cmdT = 1; for (const sq of squads) if (!sq.manual && !sq.op && sq.role !== 'perimeter' && sq.role !== 'relief') { sq.slotKey = null; sq.respT = null; } } // re-task for clearing
      if (lastPhase !== null) log(null, 'phase ' + phase);
      lastPhase = phase;
    }
    // visible offences (staggered over 4 substeps)
    const NA = sim.NA;
    for (let i = offScan; i < NA; i += 4) if (isOffAct(act[i])) lastOff[i] = T;
    offScan = (offScan + 1) & 3;
    // cheap looting watch: urgent commander tick when a shop's looted level jumps
    shopScanT -= dt;
    if (shopScanT <= 0 && sim.shops?.length) {
      shopScanT = 10;
      const sh = sim.shops; if (!shopSnap || shopSnap.length !== sh.length) shopSnap = Float32Array.from(sh, s => s.looted || 0);
      for (let i = 0; i < sh.length; i++) { const v = sh[i].looted || 0; if (v - shopSnap[i] > 0.05) addHeat(0.01); shopSnap[i] = v; }
    }
    if (!active) for (const sq of squads) { // outside day/dusk: stand still where they are
      if (sq.state === 'move') { sq.dest = null; sq.field = null; sq.trail = []; formLine(sq, sq.x, sq.y, sq.dx, sq.dy, false); }
      if (sq.state !== 'hold' && sq.state !== 'rest') { sq.anchor.x = sq.x; sq.anchor.y = sq.y; sq.pushLeft = 0; setState(sq, 'hold'); }
      sq.home = { x: sq.anchor.x, y: sq.anchor.y };
    }
    if (active) updateWarnings();
    let t0 = performance.now();
    for (let s = 0; s < squads.length; s++) updateSquad(squads[s], dt, active);
    pt('squads', t0);
    mergeHunts();
    for (let s = squads.length - 1; s >= 0; s--) if (squads[s].na === 0 && !squads[s].downed.length && !teams.some(t => t.sq === squads[s])) { log(squads[s], 'wiped out'); removeSquad(squads[s]); }
    t0 = performance.now(); updateTeams(dt); updateArrestees(dt); pt('teams', t0);
    if (incidents.length) flushIncidents(!active);
    t0 = performance.now(); updateOps(dt, active); pt('ops', t0);
    updateEscalation(dt, phase);
    if (active) leaderExposure(dt); // v1.8
    if (police.ai && active) {
      // intel: a march that changes its order (new route) triggers a re-plan
      // v1.7: no peeking at orders: the police sample what they see (leader positions) every TRACK_DT s; a re-plan comes from a
      // visible change of direction (inferMarch), not from the order itself
      police.trackT = (police.trackT || 0) - dt; if (police.trackT <= 0) { police.trackT = TRACK_DT; trackLeaders(); }
      police.cmdT -= dt;
      if (police.urgent && police.cmdT > INTEL_MIN && T - police.lastTick > INTEL_MIN) police.cmdT = INTEL_MIN * rand();
      police.planT -= dt; if (police.planT <= 0) { police.planT = 1; t0 = performance.now(); buildPlan(); pt('buildPlan', t0); }
      if (police.cmdT <= 0) {
        police.urgent = false; police.cmdT = police.cmdPeriod;
        if (!police.gateDone) { police.gateDone = true; deployGate(); }
        if (!police.deployed) { // initial pre-positioning: top up to the base force at the perimeter / staging
          police.deployed = true;
          let k = 0;
          while (squads.filter(s => !s.manual).length < police.baseForce && k < 30) {
            const p = k < geo.posts.length ? geo.posts[k] : geo.staging[k % geo.staging.length]; k++;
            addSquad(p.x, p.y, p.fx ?? 0, p.fy ?? 1, { n: SQ_N });
          }
        }
        t0 = performance.now(); plannerTick(); pt('planner', t0);
      }
    }
  }

  // ===================================================================== API
  sim.api.addSquad = (x, y, fx, fy, opts) => addSquad(x, y, fx, fy, opts);
  sim.api.removeSquad = removeSquad;
  sim.api.hitOfficer = hitOfficer;
  sim.api.arrestAgent = arrestAgent;
  sim.api.arrestLeader = L => arrestLeader(typeof L === 'number' ? sim.leaders[L] : L, null);
  // day system hook: deploy n squads for the day (perimeter posts first, then the reserve staging points)
  // v1.7: the gate guard (one line per street on the GATE_R ring); called at every deployment, tops up missing posts
  function deployGate() {
    if (!geo) initGeo();
    for (const p of geo.gatePosts) {
      if (squads.some(s => s.gate && s.gatePost === p.i)) continue;
      const s = addSquad(p.x, p.y, p.fx, p.fy, { manual: true, tactic: 'gate', n: clamp(2 * Math.round(p.w / 1.05), 12, 24) });
      if (!s) continue;
      s.gate = true; s.gatePost = p.i; s.role = 'gate'; s.maxAdv = 6;
    }
  }
  function gateBreach(sq) {
    sq.breachT = GATE_BREACH_T; sq.gap = Math.max(2, Math.min(GATE_GAP, sq.left + sq.right - 3)); sq.gapLat = 0; layoutLine(sq);
    sq.brokenT = 0; setState(sq, 'hold'); sq.energy = Math.max(0, sq.energy - 10);
    police.counts.gateBreaches = (police.counts.gateBreaches || 0) + 1; addHeat(0.3); police.urgent = true;
    sim.emit('gateBreach', sq.x, sq.y, { squad: sq.id });
    log(sq, 'gate breached');
  }
  sim.api.deployGate = deployGate;
  sim.api.deployPolice = (n, toward, day = 1) => {
    if (!geo) initGeo();
    deployGate();
    police.deployed = true; police.baseForce = n; police.reinforceCap = Math.min(4, 1 + Math.floor(day / 2));
    const made = [];
    // v1.6: 2 perimeter posts on the side of the protest, the rest at the staging points (the planner re-tasks them at once)
    const tw = toward ? { x: toward[0] ?? toward.x, y: toward[1] ?? toward.y } : null;
    const posts = tw ? geo.posts.slice().sort((a, b) => hyp(a.x - tw.x, a.y - tw.y) - hyp(b.x - tw.x, b.y - tw.y)) : geo.posts;
    for (let k = 0; k < n; k++) {
      const p = k < Math.min(2, posts.length) ? posts[k] : geo.staging[k % geo.staging.length];
      const off = k >= geo.posts.length ? Math.floor(k / geo.staging.length) * 12 : 0;
      const s = addSquad(p.x + (rand() - 0.5) * off, p.y + (rand() - 0.5) * off, p.fx ?? (toward ? toward[0] - p.x : 0), p.fy ?? (toward ? toward[1] - p.y : 1), { n: SQ_N });
      if (s) made.push(s);
    }
    police.cmdT = 2;
    return made;
  };
  sim.api.policeOrder = (sq, x, y, fx, fy, opts) => orderMove(sq, x, y, fx, fy, opts);
  sim.api.policeCharge = (sq, dist) => orderCharge(sq, dist);
  sim.api.policePush = (sq, dist, to) => { sq = resolveSquad(sq); if (!sq) return false; sq.home = { x: sq.anchor.x, y: sq.anchor.y }; sq.maxAdv = Math.max(sq.maxAdv, dist + 2); startPush(sq, to, dist); return true; };
  sim.api.policeOp = (type, o = {}) => type === 'kettle' || type === 'cordon' ? startKettle(o.x, o.y, o.r, o.squads, type) : type === 'funnel' ? startFunnel(o.x, o.y, o.r, o.squads) : type === 'split' ? startSplit(o.leader, o.squads) : null;
  sim.api.policeInfo = () => ({ escalation: police.escalation, squads: squads.length, teams: teams.length, ops: ops.map(o => ({ type: o.type, phase: o.phase, inside: o.inside, filtered: o.filtered, arrests: o.arrests })), ...police.counts, brutality: police.brutalityCount,
    plan: police.plan, predict: police.predict, gaps: police.lastGaps, ms: police.msSteps ? police.ms / police.msSteps : 0 });
  Object.assign(sim, { addSquad: sim.api.addSquad, removeSquad });

  return {
    name: 'police',
    init() {
      squads = sim.squads = [];
      teams = sim.snatchTeams = [];
      arrestees = []; ops = [];
      police = sim.police = {
        escalation: 1, heat: 1.2, baseEscalation: 1, brutalityCount: 0, ai: true, autoOps: true,
        cmdPeriod: INTEL_PERIOD, cmdT: 3, planT: 1, splitT: {}, stillT: {}, blockMem: {}, warnAreas: [], plan: [], predict: [], groups: [], gaps: [], lastGaps: [], timeline: [], doneOps: [], reordered: new Set(), tracks: new Map(),
        urgent: false, lastTick: -1e9, ticks: 0, deployed: false,
        baseForce: 8, reinforceCap: 4, opsRange: 1400, opBudget: 99, reinforcementsToday: 0, lastReinforceT: -1e9,
        pressureScale: 1.4, groundGiven: 0, heatWin: 0, heatWinT: -1e9, ms: 0, msSteps: 0, attacksOnOfficers: 0, hotspots: [], threats: [], ops, log: [],
        counts: { ripostes: 0, sallies: 0, ripGas: 0, cohesionBreaks: 0, rotations: 0, bounds: 0, stepBacks: 0, throwsAtPolice: 0, throwsAtGate: 0, gasDeny: 0, gasDisperse: 0, gasCoreShift: 0, gasResupply: 0, gas: 0, lbd: 0, flash: 0, charges: 0, warnings: 0, arrests: 0, leaderArrests: 0, snatches: 0, filtered: 0, officersDown: 0, lineBreaks: 0, reinforcements: 0, gateBreaches: 0, intelTurns: 0, lineArrests: 0, footM: 0, stationM: 0, squadSec: 0, routs: 0,
          vanTrips: 0, plans: 0, retasks: 0, blocks: 0, kettles: 0, cordons: 0, funnels: 0, splits: 0, hunts: 0, huntArrests: 0, gaps: 0 },
      };
      police.prof = prof;
      police.ringExits = (x, y, r) => ringExits(x, y, r, getField(x, y)); // debug / tests
      geo = null; lastPhase = null; fieldCache.clear();
      sim.onEvent?.(onEvent);
    },
    update,
  };
}
