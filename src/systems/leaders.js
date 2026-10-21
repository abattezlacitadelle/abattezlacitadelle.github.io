// Leaders system: player-controlled agitators. Owns sim.leaders and sim.selected.
// Per leader: stance ('peaceful' | 'firm' | 'unleashed'), arrested flag (set by police), and two actions
// (rally / scatter) via sim.api.leaderAction(id, kind). Arrested leaders don't move, can't be selected and
// lose their followers.
import { clamp, LEADER_COLORS, NAMES, ACT } from '../common.js';

export const STANCES = ['peaceful', 'firm', 'unleashed'];
// v1.6 Rally is the key re-gather tool for the restless crowd: every follower walks back in and packs tight for RALLY_T s
// (v1.5: 25 s, cooldown 60 s); lapsed followers (sim.lapL) and panicking people within RALLY_BIND m (v1.5: 55 m) are
// re-bound, and some bystanders within RALLY_R / 2 join.
const RALLY_R = 55, RALLY_BIND = 150, RALLY_CD = 45, RALLY_T = 20, RALLY_RECRUIT = 0.4, SCATTER_R = 60, SCATTER_CD = 90;
const V_LEADER = 1.25; // v1.5: free walking speed of a leader with no crowd (was 1.45); / sqrt(1 + count / 300)
const WAIT_GRACE = 6, WAIT_MIN = 0.06, WAIT_R = 12; // v1.7: s after an order before the leader waits for its crowd (v1.6: 12); slowest wait factor (v1.6: 0.65, v1.7: 0.2, v1.8: 0.06 so a leader does not walk away from its core); look radius (10)
const WAIT_N = 10; // v1.8: own followers within WAIT_R the leader waits for (v1.6-1.7: 5; police exposure counts < 8 within 10 m as exposed)
const GAS_SLOW = 0.7;  // v1.6: leader speed factor in gas > 0.3 (was 0.55)
const LINE_KEEP = 5;   // v1.7: a marching leader halts this many metres short of an officer in front of it
const LEADER_GAS = 0.25, V_GAS_ESC = 1.3, GAS_PROBE = 9; // v1.7: gas concentration that makes a leader step out of the cloud, and how fast (v1.8: 0.25, was 0.5: the leader leaves with its core instead of staying alone in thin gas)
const GATE_PLANE = 0.4, GATE_EDGE = 3; // v1.8 gate barrier (same as crowd.js)
const DXS = [1, -1, 0, 0, 1, 1, -1, -1], DYS = [0, 0, 1, -1, 1, -1, 1, -1]; // flow-field direction codes (sim.js)

export default function create(sim) {
  const { walkAt, nearestWalkable, cellX, cellY, CELL, computeField, fieldDist, fieldDir, tracePath, countNear, dirTo, moveWithWalls,
    px, py, lead, panicT, act, riot, extFx, extFy, makePanic, rand } = sim;
  const tmpV = { x: 0, y: 0 };
  let leaders, selected;

  function addLeader(x, y, opts = {}) {
    if (leaders.length >= 30) return null;
    if (!walkAt(x, y)) { const c = nearestWalkable(Math.floor(x / CELL), Math.floor(y / CELL), 60); if (c < 0) return null; x = cellX(c); y = cellY(c); }
    const id = leaders.length, color = LEADER_COLORS[id % LEADER_COLORS.length];
    const L = { id, name: opts.name || NAMES[id % NAMES.length], x, y, color, field: computeField(x, y), prog: 0, arrived: true,
      count: 0, newCount: 0, energy: 100, speed: 0, pathT: 0, path: null,
      stance: 'firm', arrested: false, rallyCd: 0, scatterCd: 0, rallyT: 0 };
    leaders.push(L);
    return L;
  }
  const active = L => L && !L.arrested && !L.gone;
  // legacy signature: orderLeaders(x, y, ids = selected)
  function orderLeaders(x, y, ids = selected) {
    if (!ids.size && !ids.length) return false;
    const F = computeField(x, y);
    if (!F) return false;
    for (const id of ids) { const L = leaders[id]; if (!active(L)) continue; L.field = F; L.arrived = false; L.pathT = 0; L.path = null; L.orderT = sim.simTime; L.slowT = 0; }
    return true;
  }
  function select(id, add) {
    if (!add) selected.clear();
    if (id != null && active(leaders[id])) { if (add && selected.has(id)) selected.delete(id); else selected.add(id); }
  }
  function setStance(id, s) {
    const L = leaders[id]; if (!active(L)) return null;
    if (typeof s === 'number') s = STANCES[(STANCES.indexOf(L.stance) + s + STANCES.length * 4) % STANCES.length];
    if (!STANCES.includes(s)) return null;
    if (L.stance !== s) { L.stance = s; sim.emit('stance', L.x, L.y, { leader: L.id, stance: s }); }
    return s;
  }
  // 'rally': followers within 40 m tighten up for a few seconds, panicking people nearby calm down and rejoin.
  // 'scatter': followers within 60 m run outward and drop their leader (escape a kettle). Returns false on cooldown.
  function leaderAction(id, kind) {
    const L = leaders[id]; if (!active(L)) return false;
    if (kind === 'rally') {
      if (L.rallyCd > 0) return false;
      L.rallyCd = RALLY_CD; L.rallyT = RALLY_T;
      let n = 0;
      const lapL = sim.lapL, A = act;
      sim.forEachNear(L.x, L.y, RALLY_BIND, (j, dx, dy, d2) => {
        const a = A[j];
        if (a === ACT.DOWN || a === ACT.ARRESTED || a === ACT.HOME || riot[j] >= 0) return;
        if (lead[j] === L.id) { n++; return; }
        const near = d2 < RALLY_R * RALLY_R;
        if (panicT[j] > 0 && (near || sim.prevLead[j] === L.id)) { panicT[j] = 0; lead[j] = L.id; n++; }
        else if (lead[j] < 0 && panicT[j] <= 0 && ((lapL && lapL[j] === L.id) || (d2 < RALLY_R * RALLY_R * 0.25 && rand() < RALLY_RECRUIT))) { lead[j] = L.id; if (lapL) lapL[j] = -1; n++; }
      });
      sim.emit('rally', L.x, L.y, { leader: L.id, n, r: RALLY_BIND });
      return true;
    }
    if (kind === 'scatter') {
      if (L.scatterCd > 0) return false;
      L.scatterCd = SCATTER_CD;
      let n = 0;
      sim.forEachNear(L.x, L.y, SCATTER_R, (j, dx, dy) => {
        if (lead[j] !== L.id) return;
        const a = rand() * Math.PI * 2, d = Math.hypot(dx, dy);
        const fx = d > 1 ? dx / d + Math.cos(a) * 0.5 : Math.cos(a), fy = d > 1 ? dy / d + Math.sin(a) * 0.5 : Math.sin(a);
        makePanic(j, 3 + rand() * 4, fx, fy); n++;
      });
      L.rallyT = 0;
      sim.emit('scatter', L.x, L.y, { leader: L.id, n });
      return true;
    }
    return false;
  }

  function update(dt) {
    const squads = sim.squads, G = sim.gs, NA = sim.NA;
    let anyArrested = false;
    for (const L of leaders) {
      if (L.rallyCd > 0) L.rallyCd = Math.max(0, L.rallyCd - dt);
      if (L.scatterCd > 0) L.scatterCd = Math.max(0, L.scatterCd - dt);
      if (L.arrested || L.gone) {
        anyArrested = true; L.speed = 0; L.path = null; L.rallyT = 0;
        if (selected.has(L.id)) selected.delete(L.id);
        if (L.arrested && !L.arrestSeen) { L.arrestSeen = true; L.arrestedAt = sim.simTime; }
        continue;
      }
      const F = L.field, lx0 = L.x, ly0 = L.y; // v1.8: start position (gate barrier)
      L.prog = F ? fieldDist(F, L.x, L.y) : 0;
      let moving = false;
      // v1.7 gas reflex: a leader in a thick cloud steps out of it (against the gradient) like everyone else, then resumes the
      // order. (Playtests: leaders kept walking through gas their crowd had fled and were snatched alone inside the cloud.)
      sim.gasSample(L.x, L.y);
      L.gasEsc = false;
      if (G.s > LEADER_GAS) {
        // the clearest walkable direction: 8 probes GAS_PROBE m out (the raw gradient often points into a wall or a police line)
        const s0 = G.s; let bx = 0, by = 0, bs = s0;
        if (!L.gasDirT || L.gasDirT <= 0) {
          for (let k = 0; k < 8; k++) {
            const a = k * Math.PI / 4, ux = Math.cos(a), uy = Math.sin(a);
            if (!walkAt(L.x + ux * 2, L.y + uy * 2) || !walkAt(L.x + ux * GAS_PROBE, L.y + uy * GAS_PROBE)) continue;
            // never through a police line: any officer within 12 m in a +-35 degree cone rules the direction out
            let pen = 0, wall = false;
            for (const sq of squads) { if (sq.van) continue; const ex = sq.x - L.x, ey = sq.y - L.y, d = Math.hypot(ex, ey); if (d > 40) continue; if (d < 25 && (ex * ux + ey * uy) / (d || 1) > 0.5) pen += 1;
              for (let q = 0; q < sq.na && !wall; q++) { const ox = sq.ox[q] - L.x, oy = sq.oy[q] - L.y, od = Math.hypot(ox, oy); if (od < 12 && (ox * ux + oy * uy) > 0.82 * od) wall = true; } }
            if (wall) continue;
            sim.gasSample(L.x + ux * GAS_PROBE, L.y + uy * GAS_PROBE); const sc = G.s + pen;
            if (sc < bs) { bs = sc; bx = ux; by = uy; }
          }
          L.gasDx = bx; L.gasDy = by; L.gasDirT = 2;
        } else { L.gasDirT -= dt; bx = L.gasDx; by = L.gasDy; }
        if (bx || by) { moveWithWalls(L, bx * V_GAS_ESC * dt, by * V_GAS_ESC * dt); L.hx = bx; L.hy = by; }
        L.gasEsc = true; L.speed = V_GAS_ESC; L.slowT = 0; L.energy -= dt * 0.15;
      } else
      if (F && !L.arrived) {
        if (L.prog < 2.5) L.arrived = true;
        else {
          const nearCrowd = countNear(L.x, L.y, 1.5);
          const rho = (nearCrowd + 1) / 7.07;
          const fw = rho < 0.5 ? 1 : Math.max(0.35, 1 - Math.exp(-1.913 * (1 / rho - 1 / 5.4)));
          sim.gasSample(L.x, L.y);
          const gasSlow = G.s > 0.3 ? GAS_SLOW : 1;
          // v1.5: a leader with a crowd waits for it: few of its own followers within 8 m -> slow down (it used to
          // walk off alone, end up isolated at a police line and get snatched)
          // v1.6: the leader answers an order at once (the player's control); the wait only starts WAIT_GRACE s after the
          // order, looks 10 m around (was 8), never drops below WAIT_MIN (was 0.35) and is off in gas (a leader slowed by gas
          // AND waiting for a gassed, scattered crowd crawled inside the cloud: the main stall cause in the order regression)
          let wait = 1;
          if (L.count >= 20 && gasSlow === 1 && sim.simTime - (L.orderT ?? -1e9) > WAIT_GRACE) { let own = 0; sim.forEachNear(L.x, L.y, WAIT_R, j => { if (lead[j] === L.id && ++own >= WAIT_N) return true; }); wait = own >= WAIT_N ? 1 : WAIT_MIN + (1 - WAIT_MIN) * (own / WAIT_N) ** 2; } // v1.8: squared (stronger) wait
          L.speed = V_LEADER / Math.sqrt(1 + L.count / 300) * (0.35 + 0.65 * L.energy / 100) * fw * gasSlow * wait;
          L.dbg = { fw, wait, gasSlow, near: nearCrowd };
          // v1.7 line keeping: a leader stops LINE_KEEP m short of a police line in front of it instead of walking into the
          // shields alone (playtests: leaders pinned against a line with their crowd 50-100 m behind were snatched within
          // minutes). It counts as "pressing", not stalled: the crowd keeps marching up and leans on the line.
          let held = false;
          if (fieldDir(F, L.x, L.y, tmpV) || dirTo(L.x, L.y, F.tx, F.ty, tmpV)) {
            for (const sq of squads) {
              if (sq.van || sq.transit) continue;
              const bb = sq.bb; if (bb && (L.x < bb[0] - LINE_KEEP || L.x > bb[2] + LINE_KEEP || L.y < bb[1] - LINE_KEEP || L.y > bb[3] + LINE_KEEP)) continue;
              for (let k = 0; k < sq.na; k++) { const ex = sq.ox[k] - L.x, ey = sq.oy[k] - L.y; const e2 = ex * ex + ey * ey; if (e2 < LINE_KEEP * LINE_KEEP && ex * tmpV.x + ey * tmpV.y > 0.8 * Math.sqrt(e2)) { held = true; break; } }
              if (held) break;
            }
          }
          if (held) { L.blockedT = 1.5; L.pressing = true; L.slowT = 0; L.speed = 0; moving = true; L.dbg = { fw, wait, gasSlow, near: nearCrowd, held: true }; }
          else if (fieldDir(F, L.x, L.y, tmpV) || dirTo(L.x, L.y, F.tx, F.ty, tmpV)) {
            L.pressing = false;
            const x0 = L.x, y0 = L.y;
            moveWithWalls(L, tmpV.x * L.speed * dt, tmpV.y * L.speed * dt);
            moving = true;
            // v1.5 corner fallback: wedged in a concave corner (no progress for 2 s) -> step toward the centre of
            // the next cell along the field instead of the interpolated direction
            const mv = Math.hypot(L.x - x0, L.y - y0);
            if (mv > 1e-4) { L.hx = (L.x - x0) / mv; L.hy = (L.y - y0) / mv; } // v1.6 heading (crowd steps aside in front)
            L.slowT = mv < 0.15 * dt ? (L.slowT || 0) + dt : 0;             // v1.6: crawling (< 0.15 m/s) -> the crowd starts to roam
            if (mv < L.speed * dt * 0.2) L.stuckT = (L.stuckT || 0) + dt; else L.stuckT = 0;
            if (L.stuckT > 2) { const c = sim.cellOf(L.x, L.y), code = F.dir[c]; if (code < 8) { const nx = sim.cellX(c) + DXS[code] * CELL, ny = sim.cellY(c) + DYS[code] * CELL; if (dirTo(L.x, L.y, nx, ny, tmpV)) moveWithWalls(L, tmpV.x * 0.5 * dt, tmpV.y * 0.5 * dt); } }
          }
          if (G.s > 0.3) L.energy -= dt * 0.15;
        }
      }
      if (!moving) L.speed = 0;
      L.energy = clamp(L.energy + (moving ? -(0.006 + L.count / 120000) : 0.03) * dt, 0, 100);
      // rally: followers within RALLY_R are pulled in toward the leader (tightening the crowd)
      if (L.rallyT > 0) {
        L.rallyT -= dt;
        sim.forEachNear(L.x, L.y, RALLY_R, (j, dx, dy, d2) => {
          if (lead[j] !== L.id || d2 < 16) return;
          const d = Math.sqrt(d2), f = 1.6;
          extFx[j] -= dx / d * f; extFy[j] -= dy / d * f;
        });
      }
      // police block leaders (v1.5: L.blockedT > 0 while pressed against a line, shown on the leader's label)
      if (L.blockedT > 0) L.blockedT -= dt;
      for (const sq of squads) for (let k = 0; !sq.van && k < sq.n; k++) {
        const ox = sq.ox[k], oy = sq.oy[k], dx = L.x - ox, dy = L.y - oy, d = Math.hypot(dx, dy);
        if (d < 0.9 && d > 1e-4) { const nx = ox + dx / d * 0.9, ny = oy + dy / d * 0.9; if (walkAt(nx, ny)) { L.x = nx; L.y = ny; } if (moving) L.blockedT = 1.5; }
      }
      // v1.8 gate barrier: a leader never walks (or is shoved by a passing squad) through an unbreached gate line, not even past its
      // ends (v1.8 tests: a leader slipped past the end of a gate line, recruited the bystanders inside and held the gate on day 1)
      for (const sq of squads) {
        if (!sq.gate || sq.formation !== 'line') continue;
        const al0 = (lx0 - sq.x) * sq.dx + (ly0 - sq.y) * sq.dy; if (al0 < -GATE_PLANE) continue;
        const rx = L.x - sq.x, ry = L.y - sq.y, al = rx * sq.dx + ry * sq.dy; if (al >= -GATE_PLANE) continue;
        const la = rx * sq.pxu + ry * sq.pyu; if (la < -sq.right - GATE_EDGE || la > sq.left + GATE_EDGE) continue;
        if (sq.gap > 0 && Math.abs(la - (sq.gapLat || 0)) < sq.gap / 2) continue;
        L.x = lx0; L.y = ly0; L.blockedT = 1.5;
      }
    }
    // followers of arrested leaders are released (the crowd may re-attach them to another leader)
    if (anyArrested) for (let i = 0; i < NA; i++) { const l = lead[i]; if (l >= 0 && !active(leaders[l])) lead[i] = -1; }
  }
  // planned paths for selected leaders (refreshed every 0.5 s of sim time); called once per advance()
  function updatePaths(dt) {
    for (const L of leaders) {
      if (!selected.has(L.id) || !L.field || L.arrived || !active(L)) { if (L.arrived || !active(L)) L.path = null; continue; }
      L.pathT -= dt; if (L.pathT > 0 && L.path) continue; L.pathT = 0.5;
      L.path = tracePath(L.field, L.x, L.y);
    }
  }

  // API (contract) + legacy top-level aliases
  sim.api.addLeader = addLeader;
  sim.api.orderLeaders = (ids, x, y) => orderLeaders(x, y, ids ?? selected);
  sim.api.setStance = setStance;
  sim.api.leaderAction = leaderAction;
  sim.api.activeLeaders = () => leaders.filter(active);
  sim.STANCES = STANCES;
  Object.assign(sim, { addLeader, orderLeaders, select, updatePaths });

  return {
    name: 'leaders',
    init() { leaders = sim.leaders = []; selected = sim.selected = new Set(); },
    update,
  };
}
