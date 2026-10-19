// Crowd system: integrates every agent (soft fluid: social force + viscosity + density-speed).
// Consumes and zeroes extFx/extFy. Sets act to FOLLOW / FLEE / IDLE; other actions set by other systems
// are kept unless the agent panics. DOWN / ARRESTED agents do not move but stay in the hash as obstacles.
// Autonomous actions (LOOT..MILL, set by the riots system) steer by sim.aiX/aiY/aiV instead of the leader field.
// Pushing: hot agents (aggr > 0.55, or acting PUSH/FIGHT) squeeze through (weaker own repulsion), drive harder
// and shove the neighbours in front of them (extFx/extFy), so force propagates through a dense crowd. The
// reaction of every officer-agent contact (agents on the squad's front side only) is summed per squad into
// sq.pressure (smoothed over 0.6 s, in "pressing protester" units = m/s^2 / PRESS_UNIT) and per officer into
// sq.opress[k] (raw m/s^2, this substep).
//
// v1.6 restless crowd (user: "protesters should rarely just stay in one place calmly"):
// - Around a stopped / slow leader, followers walk short legs to a per-agent wander target (wtX/wtY): strolls down
//   the street or across the square (ray-cast to the next wall, so they turn into side streets), visits to a
//   neighbour (small knots), curiosity trips (fires, looting hotspots, police lines, shop fronts, from
//   sim.crowdAI.curiosity), and pauses. Beyond the roam radius (ROAM_R0 + ROAM_RK sqrt(count)) they increasingly
//   choose to walk back. Cohesion is weak on purpose: the crowd breathes and frays.
// - Attachment lapses: a follower more than LOOSE_R m from its leader loses it after ~LAPSE_T s on average (4x
//   faster beyond FAR_R), unless the leader is rallying or an encourager is near (encT). Lapsed people remember
//   their leader (lapL) so an encourager or a Rally can re-bind them; otherwise they roam as bystanders.
// - "Nudge" feel: leaders react to orders at once, followers only after a personal reaction lag (rxn, 0.6-5 s)
//   and then follow loosely; a moving leader's followers step aside in front of it.
// - Bystanders roam the same way (longer legs). Riot members roam in riots.js (MILL).
import { ACT, CLS } from '../common.js';

const hyp = (a, b) => Math.sqrt(a * a + b * b); // v1.6 perf: Math.hypot is several times slower in V8

export default function create(sim) {
  const { px, py, vx, vy, v0, panicT, fleeX, fleeY, lead, act, cd, extFx, extFy, clear, COLS, HC, hStart, hItems, hkey,
    walkAt, cellOf, fieldDir, fieldDist, dirTo, makePanic, removeAgent, rand, riot, aggr, cls, MAXA, registerAgentArray } = sim;
  const { aiX, aiY, aiV, encT } = sim; // from the riots system (created earlier)
  const reg = (C, d = 0) => registerAgentArray(new C(MAXA), d);
  const desX = reg(Float32Array), desY = reg(Float32Array); // last desired dir * speed
  const A_LOOT = ACT.LOOT, A_MILL = ACT.MILL, A_PUSH = ACT.PUSH, A_FIGHT = ACT.FIGHT, PACIFIST = CLS.PACIFIST, ENCOURAGER = CLS.ENCOURAGER;
  // GO_HOME (v1.5: 0.25 -> 0.06): chance that a panicked agent goes home when the panic ends, unless it can
  // regroup with the leader it followed before (prevLead, within REGROUP_R). v1.6: scaled by the panic's length,
  // 0 for short back-offs (<= PANIC_SHORT s) up to GO_HOME for panics of PANIC_SHORT + 8 s and more.
  const SF_A = 2.2, SF_B = 0.28, SF_K = 18, RADS = 0.6, VISC = 1.2, TAU = 0.5, GO_HOME = 0.06, REGROUP_R = 220, PANIC_SHORT = 4;
  const V_HOME = 1.3, VAN_AHEAD = 9, GAS_PANIC = 0.18;
  const LINE_STOP = 1.6, LINE_LOOK = 4; // v1.7: non-pushers stop LINE_STOP m short of an officer ahead (slowing from LINE_LOOK m)
  // v1.6 restless crowd (replaces v1.5 KEEP_R0 60 + KEEP_RK 2.5 sqrt(n) keep radius, the votes keep rule and SPREAD 2.4)
  const LOOSE_R = 70, FAR_R = 220, LAPSE_T = 80;          // attachment lapses beyond LOOSE_R (mean LAPSE_T s; x4 beyond FAR_R)
  const ROAM_R0 = 30, ROAM_RK = 1.8;                       // comfortable roam radius around a stopped leader (330 -> 63 m)
  const P_PAUSE = 0.18, P_CURIOUS = 0.2, P_KNOT = 0.1;     // leg mix (the rest: strolls); followers: + walk-back legs
  const LEG_T0 = 4, LEG_T1 = 9, RXN0 = 0.6, RXN1 = 4.4, SLOW_T = 5; // leg length s; reaction lag s; leader "stalled" after SLOW_T s slow
  const W_GO = 1, W_PAUSE = 2, W_BACK = 3;                 // wander leg modes (wM)
  const A_HOME = ACT.HOME;
  // PRESS_UNIT: contact reaction (m/s^2) of one protester leaning hard on an officer, so sq.pressure reads as
  // "pressing protester" units (the police system compares it with sq.strength = officers x 4).
  const SHOVE = 3.0, PRESS_TAU = 0.6, PRESS_UNIT = 6, R_INT = 1.5, R_INT2 = R_INT * R_INT;
  // social-force lookup by squared distance (d2 in [0, 4), 256 bins per m^2): force / d, split into the
  // exponential part (scaled per agent) and the contact part. Saves a sqrt + exp per neighbour pair.
  const TAB_N = 1025, TAB_S = 256, tabE = new Float32Array(TAB_N), tabK = new Float32Array(TAB_N);
  for (let q = 0; q < TAB_N; q++) {
    const d = Math.sqrt((q + 0.5) / TAB_S) + 1e-3;
    tabE[q] = Math.exp((RADS - d) / SF_B) / d; tabK[q] = d < RADS ? SF_K * (RADS - d) / d : 0;
  }
  const tmpV = { x: 0, y: 0 }, cur = { x: 0, y: 0, kind: '' };
  const votes = new Float32Array(64);
  const A_IDLE = ACT.IDLE, A_FOLLOW = ACT.FOLLOW, A_FLEE = ACT.FLEE, A_DOWN = ACT.DOWN, A_ARRESTED = ACT.ARRESTED;
  let G, gasSample;

  const live = new Uint8Array(64); // per leader: 1 = can be followed (not arrested / gone)
  const PG = 16, PGW = Math.ceil(sim.W / PG) + 1, PGN = PGW * (Math.ceil(sim.H / PG) + 1), pgrid = new Uint16Array(PGN); let pstamp = 0;
  const sX = new Float32Array(MAXA), sY = new Float32Array(MAXA), sVX = new Float32Array(MAXA), sVY = new Float32Array(MAXA), sL = new Int16Array(MAXA);
  const ord = new Int32Array(MAXA), ordKey = new Int32Array(MAXA), ordCnt = new Int32Array(PGN + 1);
  // v1.6 per-agent wander state (registered): target point, leg time left, leg speed, leg mode; reaction lag;
  // lapsed leader (-1 none); longest panic of the current episode
  const wtX = reg(Float32Array), wtY = reg(Float32Array), wT = reg(Float32Array), wSp = reg(Float32Array), wM = reg(Uint8Array);
  const rxn = reg(Float32Array), lapL = reg(Int16Array, -1), pk = reg(Float32Array);
  Object.assign(sim, { wtX, wtY, wT, wM, lapL, rxn });

  // ---------------------------------------------------------------- wander legs
  let WX = 0, WY = 0, WV = 0;
  // a clear straight run from (x, y) toward angle a, at most len m (1.5 m steps); target set 1 m short of the wall
  function ray(i, x, y, a, len) {
    const c = Math.cos(a), s = Math.sin(a);
    let d = 0; while (d < len && walkAt(x + c * (d + 1.5), y + s * (d + 1.5))) d += 1.5;
    if (d < 3) return false;
    wtX[i] = x + c * (d - 1); wtY[i] = y + s * (d - 1); return true;
  }
  // pick the next leg. Ld = leader (null for bystanders), dd = distance to it, roam = comfortable radius
  function pickLeg(i, x, y, Ld, dd, roam) {
    wT[i] = LEG_T0 + rand() * LEG_T1;
    const stroll = (0.45 + rand() * 0.55) * v0[i] / 1.35;
    if (Ld) {
      const pBack = Math.min(0.9, Math.max(0, (dd - roam) / roam));
      if (rand() < pBack) { wM[i] = W_BACK; wSp[i] = v0[i] * (0.7 + rand() * 0.3); return; }
    }
    const r = rand();
    if (r < P_PAUSE) { wM[i] = W_PAUSE; wT[i] = 3 + rand() * 8; return; }
    wM[i] = W_GO; wSp[i] = stroll;
    if (r < P_PAUSE + P_CURIOUS * (Ld ? 1 : 0.7)) {
      const C = sim.crowdAI?.curiosity;
      if (C && C(x, y, 40, cur) && (!Ld || hyp(cur.x - Ld.x, cur.y - Ld.y) < LOOSE_R * 0.9)) { wtX[i] = cur.x; wtY[i] = cur.y; wSp[i] = stroll * 1.2; return; }
    } else if (r < P_PAUSE + P_CURIOUS + P_KNOT) {
      // join a neighbour (reservoir pick of someone within 10 m following the same leader / anyone for bystanders)
      let pick = -1, n = 0; const myL = lead[i];
      sim.forEachNear(x, y, 10, j => { if (j !== i && lead[j] === myL && rand() * ++n < 1) pick = j; });
      if (pick >= 0) { const a = rand() * 6.2832; wtX[i] = px[pick] + Math.cos(a) * 1.3; wtY[i] = py[pick] + Math.sin(a) * 1.3; return; }
    }
    // stroll: down the street / across the square; near the leader's centre, bias outward (the crowd spreads)
    let a = rand() * 6.2832;
    if (Ld && dd < roam * 0.4) a = Math.atan2(y - Ld.y, x - Ld.x) + (rand() - 0.5) * 2.6;
    const len = Ld ? 8 + rand() * 26 : 10 + rand() * 35;
    for (let t = 0; t < 3; t++) { if (ray(i, x, y, a, len)) return; a += 1.6 + rand() * 1.5; }
    wM[i] = W_PAUSE; wT[i] = 2 + rand() * 3;
  }
  // execute the current leg: sets WX/WY/WV; for W_BACK the caller supplies the way back (backX/backY)
  function legStep(i, x, y, Ld, dd, roam, dt, backOk) {
    if ((wT[i] -= dt) <= 0 || wM[i] === 0) pickLeg(i, x, y, Ld, dd, roam);
    const m = wM[i];
    if (m === W_BACK) {
      if (!Ld || dd < roam * 0.45 || !backOk) { wT[i] = 0; WV = 0; return false; }
      WX = tmpV.x; WY = tmpV.y; WV = wSp[i]; return true;
    }
    if (m !== W_GO) return false;
    const dx = wtX[i] - x, dy = wtY[i] - y, d = hyp(dx, dy);
    if (d < 1.2) { wM[i] = W_PAUSE; return false; }
    WX = dx / d; WY = dy / d; WV = wSp[i];
    if (!walkAt(x + WX * 1.2, y + WY * 1.2)) { wT[i] = 0; return false; }
    return true;
  }

  function update(dt) {
    const leaders = sim.leaders, squads = sim.squads, NA = sim.NA, prevLead = sim.prevLead, T = sim.simTime;
    const nL = Math.min(leaders.length, 64);
    const gb = sim.gasBox, GCs = sim.GC, gbx0 = gb ? (gb.x0 - 1) * GCs : 0, gbx1 = gb ? (gb.x1 + 2) * GCs : 0, gby0 = gb ? (gb.y0 - 1) * GCs : 0, gby1 = gb ? (gb.y1 + 2) * GCs : 0;
    for (let l = 0; l < nL; l++) { const L = leaders[l]; L.newCount = 0; live[l] = L.arrested || L.gone ? 0 : 1; }
    for (const sq of squads) { sq.pressAcc = 0; if (!sq.opress || sq.opress.length < sq.n) sq.opress = new Float32Array(Math.max(sq.n, 8)); else sq.opress.fill(0); }
    // v1.6 perf: stamp the PG-m grid cells covered by any squad box (+2 m), so agents far from police skip both officer loops
    pstamp = (pstamp + 1) & 0xffff || 1;
    for (const sq of squads) { const bb = sq.bb; if (!bb) continue; const i0 = Math.max(0, Math.floor((bb[0] - 4) / PG)), i1 = Math.min(PGW - 1, Math.floor((bb[2] + 4) / PG)), j0 = Math.max(0, Math.floor((bb[1] - 4) / PG)), j1 = Math.floor((bb[3] + 4) / PG); for (let j = j0; j <= j1 && j * PGW < PGN; j++) for (let ii = i0; ii <= i1; ii++) pgrid[j * PGW + ii] = pstamp; }
    // v1.6 perf: visit agents in spatial order (counting sort by PG-m cell) so the nav grid, clearance and hash lookups
    // of consecutive agents hit the same cache lines (agent indices are spatially random)
    ordCnt.fill(0); for (let i = 0; i < NA; i++) { let c = Math.floor(py[i] / PG) * PGW + Math.floor(px[i] / PG); if (!(c >= 0 && c < PGN)) c = 0; ordKey[i] = c; ordCnt[c + 1]++; }
    for (let c = 0; c < PGN; c++) ordCnt[c + 1] += ordCnt[c];
    for (let i = 0; i < NA; i++) ord[ordCnt[ordKey[i]]++] = i;
    // v1.7 perf: neighbour data packed in hash-bucket order (the neighbour loop reads contiguous memory instead of chasing
    // random agent indices); a snapshot at the start of the substep
    for (let q = 0; q < NA; q++) { const j = hItems[q]; sX[q] = px[j]; sY[q] = py[j]; sVX[q] = vx[j]; sVY[q] = vy[j]; sL[q] = lead[j]; }
    for (let n = 0; n < NA; n++) {
      const i = ord[n];
      if (cd[i] > 0) cd[i] -= dt;
      const a0 = act[i];
      if (a0 === A_DOWN || a0 === A_ARRESTED) { vx[i] = vy[i] = 0; extFx[i] = extFy[i] = 0; continue; }
      const x = px[i], y = py[i];
      let fx = 0, fy = 0, nn = 0, avx = 0, avy = 0;
      // shove: hot / pushing agents push the people in front of them (along last substep's desired velocity)
      const ag = aggr[i], pushing = a0 === A_PUSH || a0 === A_FIGHT;
      const dsx = desX[i], dsy = desY[i], dsl = hyp(dsx, dsy);
      const shove = (pushing && cls[i] !== PACIFIST) || (ag > 0.55 && dsl > 0.3) ? SHOVE * ag * (pushing ? 1.6 : 1) : 0;
      const sdx = dsl > 1e-3 ? dsx / dsl : 0, sdy = dsl > 1e-3 ? dsy / dsl : 0;
      const sfA = SF_A * (1 - 0.4 * ag);
      const li0 = lead[i], needV = nL > 0 && riot[i] < 0 && (li0 < 0 || !live[li0]);
      if (needV) votes.fill(0, 0, nL);
      const cx = Math.floor(x / HC), cy = Math.floor(y / HC);
      // neighbour loop (v1.6 perf: interaction radius R_INT 1.5 m (was 2 m; the force there is ~0.06 m/s^2), hash cells the
      // disc can't touch are skipped, and leader votes are only collected by people who are looking for a leader)
      const fxr = x - cx * HC, fyr = y - cy * HC; // position inside the cell
      for (let oy = -1; oy <= 1; oy++) {
        const ey = oy < 0 ? fyr : oy > 0 ? HC - fyr : 0; if (ey >= R_INT) continue;
        for (let ox = -1; ox <= 1; ox++) {
          const ex = ox < 0 ? fxr : ox > 0 ? HC - fxr : 0; if (ex >= R_INT || ex * ex + ey * ey >= R_INT2) continue;
          const k = hkey(cx + ox, cy + oy);
          for (let s = hStart[k], e = hStart[k + 1]; s < e; s++) {
            const ddx = x - sX[s], ddy = y - sY[s], d2 = ddx * ddx + ddy * ddy;
            if (d2 >= R_INT2) continue;
            const j = hItems[s]; if (j === i) continue;
            const q = (d2 * TAB_S) | 0, fd = sfA * tabE[q] + tabK[q];
            if (shove && d2 < 1.0) { const dp = -ddx * sdx - ddy * sdy; if (dp > 0 && dp * dp > 0.09 * d2) { extFx[j] += sdx * shove; extFy[j] += sdy * shove; } }
            fx += ddx * fd; fy += ddy * fd;
            nn++; avx += sVX[s]; avy += sVY[s];
            if (needV) { const lj = sL[s]; if (lj >= 0) votes[lj]++; }
          }
        }
      }
      const rho = (nn + 1) / 7.07;
      let g = 0, gGX = 0, gGY = 0; // v1.6 perf: sample the gas only inside the gas box
      if (gb && x >= gbx0 && x <= gbx1 && y >= gby0 && y <= gby1) { gasSample(x, y); g = G.s; gGX = G.gx; gGY = G.gy; }


      // --- attachment (who am I following?) ---
      let L = lead[i];
      const aura = encT[i] > 0, auto = a0 >= A_LOOT && a0 <= A_MILL, home = a0 === A_HOME;
      if (L >= 0 && !live[L]) L = -1; // never follow an arrested leader (fixes re-attachment by votes / proximity)
      if (lapL[i] >= 0 && !live[lapL[i]]) lapL[i] = -1;
      if (home) {
        L = -1; // walking home at dusk (day system steers via fleeX/fleeY)
      } else if (panicT[i] > 0) {
        if (panicT[i] > pk[i]) pk[i] = panicT[i];
        panicT[i] -= aura ? dt * 1.6 : dt; L = -1;
        if (panicT[i] <= 0) {
          const p = prevLead[i];
          if (p >= 0 && p < nL && live[p] && riot[i] < 0 && hyp(leaders[p].x - x, leaders[p].y - y) < REGROUP_R) L = p; // regroup
          else if (rand() < GO_HOME * Math.min(1, Math.max(0, (pk[i] - PANIC_SHORT) / 8))) { removeAgent(i); sim.dispersedHome++; }
          else if (p >= 0 && p < nL && live[p]) lapL[i] = p; // too far to regroup: a Rally / encourager can still bring them back
          prevLead[i] = -1; pk[i] = 0; wT[i] = 0;
        }
      } else if (riot[i] >= 0 || (auto && L >= 0)) {
        // riot members are converted by the riots system only; peeled-off followers keep their leader
      } else {
        if (L >= 0) {
          // v1.6 lapse: far from the leader (and no rally / encourager), attachment slowly lets go
          const Ld = leaders[L], dl = hyp(Ld.x - x, Ld.y - y), coh = Ld.cohesion || 1;
          if (dl > LOOSE_R * coh && !aura && !(Ld.rallyT > 0) && rand() < dt * (dl > FAR_R * coh ? 4 : 1) / LAPSE_T) { lapL[i] = L; L = -1; wT[i] = 0; }
        } else if (aura && lapL[i] >= 0) {
          L = lapL[i]; // an encourager talks a lapsed follower back into the march
        } else {
          let bv = aura ? 1.1 : 1.8; // v1.6: votes now come from 1.5 m (was 2 m: 1.5 / 2.5)
          for (let l = 0; l < nL; l++) if (live[l] && votes[l] > bv) { bv = votes[l]; L = l; }
          if (L < 0) for (let l = 0; l < nL; l++) { if (!live[l]) continue; const Ld = leaders[l]; if (hyp(Ld.x - x, Ld.y - y) < 20 && rand() < dt * 0.8) { L = l; break; } }
        }
        if (L >= 0 && lead[i] !== L) { lapL[i] = -1; wT[i] = 0; }
      }
      lead[i] = L;

      // --- desired velocity ---
      let dxD = 0, dyD = 0, vdes = 0;
      if (home) { dxD = fleeX[i]; dyD = fleeY[i]; vdes = V_HOME; }
      else if (panicT[i] > 0) {
        if (g > 0.02 && (gGX || gGY)) { const l = hyp(gGX, gGY); fleeX[i] = -gGX / l; fleeY[i] = -gGY / l; }
        dxD = fleeX[i]; dyD = fleeY[i]; vdes = 2.3;
      } else if (auto) {
        if (L >= 0) leaders[L].newCount++;
        dxD = aiX[i]; dyD = aiY[i]; vdes = aiV[i];
      } else if (L >= 0) {
        const Ld = leaders[L]; Ld.newCount++;
        const F = Ld.field, packed = Math.sqrt(Ld.count) * 0.95 + 3, dl = hyp(Ld.x - x, Ld.y - y);
        if (!(rxn[i] > 0)) rxn[i] = RXN0 + rand() * RXN1;
        const stopped = Ld.arrived || (Ld.slowT || 0) > SLOW_T || T - (Ld.orderT ?? -1e9) < rxn[i], rally = Ld.rallyT > 0;
        if (rally || stopped) {
          // the way back to the leader (v1.6 perf: only computed when needed): along its field when that passes the
          // leader (arrived, or we are behind it), else straight
          const roam = rally ? 0 : (ROAM_R0 + ROAM_RK * Math.sqrt(Ld.count)) * (Ld.cohesion || 1) * (cls[i] === ENCOURAGER ? 1.3 : 1);
          let backOk = false;
          if (rally || wM[i] === W_BACK || wM[i] === 0 || wT[i] <= dt) {
            if (F && (Ld.arrived || fieldDist(F, x, y) > (Ld.prog || 0)) && fieldDir(F, x, y, tmpV)) backOk = true;
            else backOk = dirTo(x, y, Ld.x, Ld.y, tmpV);
          }
          if (rally) {
            // Rally: everyone walks back in and packs tight around the leader
            if (dl > packed && backOk) { dxD = tmpV.x; dyD = tmpV.y; vdes = v0[i] * 1.15; } else vdes = 0;
            wT[i] = 0;
          } else if (legStep(i, x, y, Ld, dl, roam, dt, backOk)) { dxD = WX; dyD = WY; vdes = WV; }
        } else if (F && fieldDir(F, x, y, tmpV)) {
          // marching: follow the leader's field. Vanguard: followers may walk up to VAN_AHEAD m ahead of the leader at
          // the leader's pace (v1.6: beyond that they slow to half its pace instead of stopping in its way)
          dxD = tmpV.x; dyD = tmpV.y; wT[i] = 0;
          const ahead = (Ld.prog || 0) - fieldDist(F, x, y), lv = Math.max(0.5, Ld.speed);
          vdes = ahead > VAN_AHEAD ? Math.min(v0[i], lv * 0.5) : ahead > 2 ? Math.min(v0[i], lv * 0.9) : ahead > -1 ? Math.min(v0[i], lv * 1.1) : ahead < -15 ? v0[i] * 1.25 : v0[i];
        } else if (dirTo(x, y, Ld.x, Ld.y, tmpV)) {
          dxD = tmpV.x; dyD = tmpV.y; vdes = dl > packed ? v0[i] : 0; wT[i] = 0;
        }
      } else if (a0 === A_IDLE && legStep(i, x, y, null, 0, 0, dt, false)) { dxD = WX; dyD = WY; vdes = WV; } // bystanders / lapsed roam
      if (g > 0.05 && panicT[i] <= 0) {
        const l = hyp(gGX, gGY);
        if (l > 1e-5) {
          const w = Math.min(1, g / 0.25);
          dxD = dxD * (1 - w) - gGX / l * w * 1.5; dyD = dyD * (1 - w) - gGY / l * w * 1.5;
          const dl = hyp(dxD, dyD) || 1; dxD /= dl; dyD /= dl; vdes = Math.max(vdes, 1.4);
        }
        // v1.6: gas scatters people (panic above GAS_PANIC; v1.5 needed g > 0.4, which loose crowds walking away never met,
        // so gas only denied ground) and the panic is shorter (6-14 s, was 7-16 s): they split, then regroup
        if (g > GAS_PANIC && rand() < dt * (g - 0.1) * (cls[i] === PACIFIST ? 0.3 : 1)) makePanic(i, 6 + rand() * 8, -gGX, -gGY);
      }
      const fw = rho < 0.3 ? 1 : Math.max(0.05, 1 - Math.exp(-1.913 * (1 / rho - 1 / 5.4)));
      vdes *= fw; if (g > 1) vdes *= 0.7;
      // v1.7 stand at the line: people walking toward an officer stop ~LINE_STOP m short of the shields unless they are pushing
      // or fighting (v1.6: every marcher kept walking into the line, so any crowd of a few hundred out-pressed a section 5:1 and
      // lines could not hold anything). The pressure on a line now comes from pushers (aggressive, Unleashed crowds), sit-ins and
      // the crush of a dense crowd behind them.
      if (vdes > 0 && !pushing && panicT[i] <= 0) {
        const gci0 = Math.floor(y / PG) * PGW + Math.floor(x / PG);
        if (gci0 >= 0 && gci0 < PGN && pgrid[gci0] === pstamp) {
          // (perf) in the squad's line frame: distance in front of the front row, within its width, walking against its facing;
          // a breach / filter gap (sq.gap) lets people through
          let dmin = LINE_LOOK;
          for (const sq of squads) {
            const bb = sq.bb; if (!bb || sq.van || sq.formation !== 'line' || sq.state === 'broken' || x < bb[0] - LINE_LOOK || x > bb[2] + LINE_LOOK || y < bb[1] - LINE_LOOK || y > bb[3] + LINE_LOOK) continue;
            if (dxD * sq.dx + dyD * sq.dy > -0.6) continue;
            const rx = x - sq.x, ry = y - sq.y, al = rx * sq.dx + ry * sq.dy; if (al < -0.5 || al >= dmin) continue;
            const la = rx * sq.pxu + ry * sq.pyu; if (la < -sq.right - 0.6 || la > sq.left + 0.6) continue;
            if (sq.gap > 0 && Math.abs(la - (sq.gapLat || 0)) < sq.gap / 2 - 0.4) continue;
            dmin = Math.max(0, al);
          }
          if (dmin < LINE_LOOK) vdes *= Math.max(0, (dmin - LINE_STOP) / (LINE_LOOK - LINE_STOP));
        }
      }

      desX[i] = dxD * vdes; desY[i] = dyD * vdes;
      const drive = pushing ? (1 + ag) / TAU : 1 / TAU;
      let ax = (dxD * vdes - vx[i]) * drive + fx + extFx[i], ay = (dyD * vdes - vy[i]) * drive + fy + extFy[i];
      extFx[i] = extFy[i] = 0;
      if (nn) { ax += VISC * (avx / nn - vx[i]); ay += VISC * (avy / nn - vy[i]); }
      // walls
      const c = cellOf(x, y);
      if (clear[c] <= 1) {
        const gx = clear[c + 1] - clear[c - 1], gy = clear[c + COLS] - clear[c - COLS], gl = hyp(gx, gy);
        if (gl > 0) { ax += gx / gl * 2.5; ay += gy / gl * 2.5; }
      }
      // leaders part the crowd around themselves; v1.6: people in front of a moving leader step aside (no wall of
      // waiting followers in its path)
      for (let l = 0; l < nL; l++) {
        const Ld = leaders[l], ex = x - Ld.x, ey = y - Ld.y;
        if (ex > 5 || ex < -5 || ey > 5 || ey < -5) continue;
        const d = hyp(ex, ey) + 1e-3; if (d < 2.6) { const f = 5 * (2.6 - d); ax += ex / d * f; ay += ey / d * f; }
        if (Ld.speed > 0.1 && d < 5 && Ld.hx !== undefined) {
          const fwd = ex * Ld.hx + ey * Ld.hy;
          if (fwd > -0.5) { const lat = -ex * Ld.hy + ey * Ld.hx, s = lat >= 0 ? 1 : -1, f = 3 * (1 - d / 5); ax += -Ld.hy * s * f; ay += Ld.hx * s * f; }
        }
      }
      // police (v1.6 perf: only when the coarse police grid says a squad box is near)
      const gci = Math.floor(y / PG) * PGW + Math.floor(x / PG), polNear = gci >= 0 && gci < PGN && pgrid[gci] === pstamp;
      if (polNear)
      for (const sq of squads) {
        const bb = sq.bb; if (!bb || x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
        for (let k = 0; k < sq.n; k++) {
          const ex = x - sq.ox[k], ey = y - sq.oy[k], d2 = ex * ex + ey * ey;
          if (d2 > 3.3) continue;
          const d = Math.sqrt(d2) + 1e-3, f = 14 * (1.8 - d);
          ax += ex / d * f; ay += ey / d * f;
          // reaction on the officer: counts as line pressure when the agent is on the squad's front side
          const fr = f * (ex * sq.dx + ey * sq.dy) / d;
          if (fr > 0) { sq.pressAcc += fr; sq.opress[k] += fr; }
          if (sq.state === 'charge' && ex * sq.dx + ey * sq.dy > -0.3) {
            ax += sq.dx * 10; ay += sq.dy * 10;
            if (panicT[i] <= 0 && rand() < dt * 0.5 * (cls[i] === PACIFIST ? 0.25 : 1)) makePanic(i, 5 + rand() * 8, sq.dx, sq.dy);
          }
        }
      }
      let nvx = vx[i] + ax * dt, nvy = vy[i] + ay * dt;
      const sp = hyp(nvx, nvy), vmax = panicT[i] > 0 ? 3.4 : 2.4;
      if (sp > vmax) { nvx *= vmax / sp; nvy *= vmax / sp; }
      // integrate + wall collision
      const nx = x + nvx * dt, ny = y + nvy * dt;
      if (walkAt(nx, ny)) { px[i] = nx; py[i] = ny; }
      else if (walkAt(nx, y)) { px[i] = nx; nvy = 0; }
      else if (walkAt(x, ny)) { py[i] = ny; nvx = 0; }
      else { nvx *= -0.2; nvy *= -0.2; }
      vx[i] = nvx; vy[i] = nvy;
      // hard constraint: nobody walks through an officer
      if (polNear) 
      for (const sq of squads) {
        const bb = sq.bb; if (!bb || px[i] < bb[0] || px[i] > bb[2] || py[i] < bb[1] || py[i] > bb[3]) continue;
        for (let k = 0; k < sq.n; k++) {
          const ex = px[i] - sq.ox[k], ey = py[i] - sq.oy[k], d = hyp(ex, ey);
          if (d < 0.7 && d > 1e-4) { const qx = sq.ox[k] + ex / d * 0.7, qy = sq.oy[k] + ey / d * 0.7; if (walkAt(qx, qy)) { px[i] = qx; py[i] = qy; } }
        }
      }
      // action label: panic overrides everything; otherwise only the crowd's own states are rewritten
      if (panicT[i] > 0) act[i] = A_FLEE;
      else if (a0 <= A_FLEE) act[i] = lead[i] >= 0 ? A_FOLLOW : A_IDLE;
    }
    for (const L of leaders) L.count = L.newCount;
    const kp = Math.min(1, dt / PRESS_TAU);
    for (const sq of squads) { sq.pressureRaw = sq.pressAcc; sq.pressure = (sq.pressure || 0) + (sq.pressAcc / PRESS_UNIT - (sq.pressure || 0)) * kp; }
  }

  return {
    name: 'crowd',
    init() { G = sim.gs; gasSample = sim.gasSample; },
    update,
  };
}
