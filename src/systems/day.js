// Day system: the 7-day campaign loop. Owns sim.day.
// Phases: 'briefing' (paused, pick spawn points) -> 'day' (08:00-18:00) -> 'dusk' (18:00-20:00, people go home,
// light dims) -> 'summary' (paused, day stats) -> next 'briefing' ... ; 'ended' when the campaign is won or lost.
// Gauges are not implemented yet: carry-over uses simple placeholder formulas (see docs/contract.md, v1.3).
// Sandbox mode (?sandbox in the URL): no campaign, the legacy initScenario, phase stays 'day'.
import { clamp, ACT, lmName } from '../common.js';

const H8 = 8 * 3600, H18 = 18 * 3600, H20 = 20 * 3600, DAYS = 7;
export const FLAVOUR = [
  'A call to march goes viral overnight',
  'Students walk out of the lycées',
  'The unions call a general strike',
  'Transport grinds to a halt; the CRS are reinforced',
  'Every camera in Europe is on the street',
  'Exhausted police, furious streets',
  'The final march on the Élysée',
];
const RIOTS_PER_DAY = [1, 2, 2, 3, 4, 4, 5];
const DAY1_CROWD = 1000, CROWD_MAX = 3500, START_LEADERS = 3;
// v1.5: police squads deployed each morning (was 3 + day - 1, cap 9): enough to seal the 4 Élysée posts from day 1
const SQUADS_BY_DAY = [5, 6, 7, 8, 9, 10, 11];
const BYSTANDERS_FULL = 1800, FULL_WALK_CELLS = 674652;
const COLLAPSE_N = 50, COLLAPSE_T = 600, PROMOTE_MIN = 150;
// v1.8: leaders each morning by tomorrow's crowd (>= LEAD2_N: 2, >= LEAD3_N: 3); one mid-day successor per day steps up
// SUCC_DELAY s after the last active leader is arrested if >= SUCC_MIN loose protesters are still within SUCC_R m; carry-over
// keeps RET_PEAK x peak + RET_HELD x the followers still marching at dusk (v1.4-1.7: 0.55 x peak)
const LEAD2_N = 300, LEAD3_N = 1400, SUCC_DELAY = 45, SUCC_R = 90, SUCC_MIN = 60, SUCC_BIND_R = 60, SUCC_BIND_P = 0.85, SUCC_PER_DAY = 1;
const RET_PEAK = 0.6, RET_HELD = 0.3;
const HOLD_T = 60; // v1.5: seconds the Élysée gate must be held (>= WIN_COUNT followers within GOAL_R) to win
// intensity ramp (v1.6, was the v1.5 'chaos' ramp TOD [8,0][9,.12][11,.4][13,.7][15,1][18,1][20,.8] x DAY .5..1.12):
// sim.day.intensity = INT_TOD(hour) x INT_DAY[day], 0..1. Quiet mornings, building after ~11:00, peak 16:00-17:30,
// and day over day: day 1 is a gentle tutorial (peak 0.32), days 5-7 reach the maximum (0.87 / 0.95 / 1).
const INT_TOD = [[8, 0.02], [10, 0.08], [11, 0.18], [13, 0.48], [15, 0.82], [16, 1], [17.5, 1], [18, 0.9], [20, 0.6]];
const INT_DAY = [0.32, 0.48, 0.62, 0.75, 0.87, 0.95, 1];
const newStats = () => ({ looted: 0, arrests: 0, injured: 0, recruits: 0, peak: 0, fires: 0, projectiles: 0, brawls: 0,
  riotJoined: 0, riotsJoined: 0, explosions: 0, lootGrabs: 0, leadersArrested: [], brutality: 0, officersDown: 0, objectives: [] }); // v1.5: brutality + officersDown (for the gauges next round)

export default function create(sim) {
  const { px, py, vx, vy, lead, panicT, fleeX, fleeY, act, riot, extFx, extFy, walk, COLS, ROWS, CELL, rand } = sim;
  const search = typeof location !== 'undefined' ? location.search : '';
  const managed = !/[?&]sandbox\b/.test(search);
  const leaving = sim.leaving = sim.registerAgentArray(new Uint8Array(sim.MAXA)); // v1.6: exposed (1 = heading home at dusk, act HOME)
  let D, exitDist = null, bysT = 0, lowT = 0;
  const lootedToday = new Set(); // shops looted today (stats.looted counts shops, stats.lootGrabs counts 'loot' events)
  const legacyInit = sim.initScenario;

  const dayBase = () => (D.day - 1) * 86400;
  const tod = () => sim.simTime - dayBase();
  const activeLeaders = () => sim.leaders.filter(L => !L.arrested && !L.gone);
  const spawnKeys = () => Object.keys(sim.spawnPoints);
  const totalFollowers = () => { let n = 0; for (const L of sim.leaders) if (!L.arrested && !L.gone) n += L.count; return n; };
  const bystanderTarget = () => Math.round(BYSTANDERS_FULL * Math.min(1, sim.walkCells / FULL_WALK_CELLS));

  // place names: nearest landmark within 250 m, else '' (the UI adds street names)
  function placeName(x, y) {
    let best = '', bd = 250;
    for (const k in sim.LM) { const p = sim.LM[k], d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = lmName(k); } }
    return best;
  }

  // ---------------------------------------------------------------- exit field (multi-source BFS from the map edge)
  function buildExitField() {
    const NC = COLS * ROWS, dist = new Uint16Array(NC).fill(65535), q = new Int32Array(NC);
    let qh = 0, qt = 0;
    for (let gy = 1; gy < ROWS - 1; gy++) for (let gx = 1; gx < COLS - 1; gx++) {
      if (gx > 3 && gy > 3 && gx < COLS - 4 && gy < ROWS - 4) continue;
      const c = gy * COLS + gx; if (walk[c]) { dist[c] = 0; q[qt++] = c; }
    }
    while (qh < qt) {
      const c = q[qh++], d = dist[c] + 1;
      for (const o of [1, -1, COLS, -COLS]) { const n = c + o; if (n >= 0 && n < NC && walk[n] && dist[n] > d) { dist[n] = d; q[qt++] = n; } }
    }
    return dist;
  }
  const EX = [1, -1, 0, 0, 1, 1, -1, -1], EY = [0, 0, 1, -1, 1, -1, 1, -1];
  const exitV = { x: 0, y: 0, d: 0 };
  function exitDir(x, y) {
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL), c = gy * COLS + gx;
    if (gx < 1 || gy < 1 || gx >= COLS - 1 || gy >= ROWS - 1) { exitV.d = 0; return exitV; }
    let best = exitDist[c], bk = -1;
    for (let k = 0; k < 8; k++) { const n = c + EX[k] + EY[k] * COLS; if (exitDist[n] < best) { best = exitDist[n]; bk = k; } }
    exitV.d = exitDist[c];
    if (bk < 0) { exitV.x = exitV.y = 0; return exitV; }
    const l = Math.hypot(EX[bk], EY[bk]); exitV.x = EX[bk] / l; exitV.y = EY[bk] / l;
    return exitV;
  }

  // ---------------------------------------------------------------- planning
  function planRiots(day) {
    const spots = (sim.data.riotSpawns || []).slice();
    for (let i = spots.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [spots[i], spots[j]] = [spots[j], spots[i]]; }
    const n = Math.min(spots.length, RIOTS_PER_DAY[day - 1] || 5), mult = 1 + 0.1 * (day - 1), atStart = Math.ceil(n / 2);
    const out = [];
    for (let k = 0; k < n; k++) {
      const s = spots[k], late = k - atStart, nLate = n - atStart;
      // v1.5: the first wave breaks out from 09:00 (was 08:00), 20 min apart; the rest between 11:00 and 15:30
      const at = k < atStart ? H8 + 3600 + k * 1200 : Math.round((11 + (nLate > 1 ? 4.5 * late / (nLate - 1) : 2)) * 3600);
      out.push({ x: s.x, y: s.y, n: Math.round((s.n || 150) * mult), at, place: placeName(s.x, s.y), spawned: false });
    }
    return out;
  }
  function squadsFor(day) { return SQUADS_BY_DAY[clamp(day, 1, 7) - 1]; }
  function defaultChoices() {
    const keys = spawnKeys(), act = activeLeaders(), used = new Set(Object.values(D.choice || {}));
    const choice = {};
    act.forEach((L, k) => {
      const prev = D.choice?.[L.id];
      choice[L.id] = keys.includes(prev) ? prev : (keys.find(kk => !used.has(kk) && !Object.values(choice).includes(kk)) || keys[k % keys.length]);
    });
    D.choice = choice;
  }

  // ---------------------------------------------------------------- world reset between days
  function clearWorld() {
    for (let i = 0; i < sim.NA; i++) sim.removeAgent(i);
    sim.flushRemovals?.();
    if (sim.api.resetRiots) sim.api.resetRiots(); else if (sim.riots) sim.riots.length = 0;
    if (sim.projectiles) sim.projectiles.length = 0;
    if (sim.fires) sim.fires.length = 0;
    for (const p of sim.props || []) if (p.state === 'burning') p.state = 'burnt'; // burnt stays burnt
    for (const s of sim.shops || []) s.burning = false;                           // looted stays looted
    if (sim.gas) sim.gas.fill(0);
    if (sim.emitters) sim.emitters.length = 0;
    for (const sq of (sim.squads || []).slice()) sim.api.removeSquad(sq);
    sim.dispersedHome = 0;
  }
  function deployPolice(day, toward) {
    const n = squadsFor(day);
    if (sim.api.deployPolice) return sim.api.deployPolice(n, toward, day);
    const g = sim.goal, LM = sim.LM, spots = [];
    for (const [k, ox, oy] of [['beauvau', 25, -10], ['madeleine', 30, 0], ['concorde', 60, 20]]) if (LM[k]) spots.push([LM[k][0] + ox, LM[k][1] + oy]);
    for (let k = 0; spots.length < n && k < 40; k++) { // extra squads: staggered between the protest's centre and the Élysée
      const f = 0.25 + 0.55 * ((k * 0.618) % 1), j = (rand() - 0.5) * 160;
      const x = g[0] + (toward[0] - g[0]) * f, y = g[1] + (toward[1] - g[1]) * f, dx = toward[0] - g[0], dy = toward[1] - g[1], l = Math.hypot(dx, dy) || 1;
      spots.push([x - dy / l * j, y + dx / l * j]);
    }
    for (const [x, y] of spots.slice(0, n)) sim.api.addSquad(x, y, toward[0] - x, toward[1] - y);
  }

  // ---------------------------------------------------------------- phase transitions
  function setupCampaign() {
    const keys = spawnKeys();
    let starts = keys.map(k => sim.spawnPoints[k]);
    if (!starts.length) return legacyInit();
    for (let k = 0; k < START_LEADERS; k++) { const p = starts[k % starts.length]; sim.api.addLeader(p[0] + (k >= starts.length ? 12 : 0), p[1]); }
    D.day = 1; D.carry = { fromDay: 0, crowd: DAY1_CROWD, retained: 0, recruits: DAY1_CROWD, riotJoined: 0, arrested: [], promoted: null, squads: squadsFor(1) };
    enterBriefing();
    if (sim.leaders.length) sim.select(0, false);
    return { start: centroid() };
  }
  function centroid() {
    const pts = activeLeaders().map(L => sim.spawnPoints[D.choice[L.id]] || [L.x, L.y]);
    if (!pts.length) return [sim.W / 2, sim.H / 2];
    return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
  }
  function enterBriefing() {
    D.objectives = D.objectives.filter(o => o.persist); objT = 0;
    D.phase = 'briefing'; D.holdT = 0; D.stats = newStats(); lootedToday.clear(); D.light = 1; lowT = 0; D.policeClear = false; D.endReason = null;
    sim.simTime = dayBase() + H8; D.t = H8;
    D.riotPlan = planRiots(D.day);
    D.squadsToday = squadsFor(D.day);
    defaultChoices();
    // preview: leaders stand at their chosen spawn points
    for (const L of activeLeaders()) placeLeader(L, D.choice[L.id]);
  }
  function placeLeader(L, key) {
    const p = sim.spawnPoints[key]; if (!p) return;
    const same = activeLeaders().filter(o => o !== L && D.choice[o.id] === key && o.id < L.id).length;
    let x = p[0] + same * 14, y = p[1] - same * 6;
    if (!sim.walkAt(x, y)) { const c = sim.nearestWalkable(Math.floor(x / CELL), Math.floor(y / CELL), 60); if (c >= 0) { x = sim.cellX(c); y = sim.cellY(c); } else { x = p[0]; y = p[1]; } }
    L.x = x; L.y = y; L.field = sim.computeField(x, y); L.arrived = true; L.path = null; L.prog = 0;
  }
  function chooseSpawn(leaderId, key) {
    if (D.phase !== 'briefing' || !sim.spawnPoints[key]) return false;
    const L = sim.leaders[leaderId]; if (!L || L.arrested || L.gone) return false;
    D.choice[leaderId] = key;
    for (const o of activeLeaders()) placeLeader(o, D.choice[o.id]);
    return true;
  }
  function startDay() {
    if (D.phase !== 'briefing') return false;
    const act = activeLeaders();
    clearWorld();
    sim.simTime = dayBase() + H8;
    for (const L of act) { placeLeader(L, D.choice[L.id]); L.energy = 100; L.rallyCd = L.scatterCd = L.rallyT = 0; L.count = 0; }
    const total = D.carry.crowd, per = act.length ? Math.floor(total / act.length) : 0;
    act.forEach((L, k) => {
      const n = per + (k === 0 ? total - per * act.length : 0);
      if (sim.api.spawnCrowd) sim.api.spawnCrowd(L.x, L.y, n, L.id); else sim.spawnAround(L.x, L.y, n, L.id);
    });
    sim.spawnBystanders(Math.round(bystanderTarget() * 0.55));
    deployPolice(D.day, centroid());
    D.phase = 'day'; D.light = 1; lowT = 0; bysT = 0; D.lastFollowers = total;
    D.succession = null; D.successorsToday = 0; D.heldAtDusk = 0; D.lastArrest = null; // v1.8
    sim.emit('dayStart', centroid()[0], centroid()[1], { day: D.day });
    spawnDueRiots();
    if (act.length && ![...sim.selected].some(id => !sim.leaders[id].arrested)) sim.select(act[0].id, false);
    return true;
  }
  function spawnDueRiots() {
    const t = tod();
    for (const r of D.riotPlan) {
      if (r.spawned || r.at > t) continue;
      r.spawned = true;
      if (sim.api.spawnRiot) r.id = sim.api.spawnRiot(r.x, r.y, r.n, { day: D.day });
      else sim.spawnAround(r.x, r.y, r.n, -1);
      sim.emit('riotSpawn', r.x, r.y, { n: r.n, riot: r.id ?? -1, place: r.place });
    }
  }
  function endDay(reason) {
    if (D.phase !== 'day' && D.phase !== 'dusk') return;
    const st = D.stats;
    const recruits = Math.round(100 + 0.3 * st.riotJoined + 50 * D.day);
    const held = D.phase === 'dusk' ? (D.heldAtDusk || 0) : 0; // v1.8: a march that survives the day keeps more of its people
    const retained = Math.round(RET_PEAK * st.peak + RET_HELD * held);
    st.recruits = recruits;
    D.carry = { fromDay: D.day, peak: st.peak, held, retained, recruits, riotJoined: st.riotJoined, crowd: clamp(retained + recruits, 0, CROWD_MAX),
      arrested: st.leadersArrested.slice(), promoted: null, squads: squadsFor(D.day + 1), reason: reason || 'time' };
    D.history.push({ day: D.day, ...st, leadersArrested: st.leadersArrested.slice(), reason: reason || 'time' });
    D.phase = 'summary'; D.endReason = reason || 'time';
    sim.emit('dayEnd', sim.goal.x, sim.goal.y, { day: D.day, stats: { ...st } });
    if (D.day >= DAYS) return finish(false, 'time', 'Day 7 is over and the Élysée still stands.');
    if (!activeLeaders().length && !canPromote()) return finish(false, 'decapitated', 'Every leader is behind bars and nobody steps up.');
  }
  // a new leader can step up after day 1 only if the crowd is still >= 150
  function canPromote() { return D.day < DAYS && (D.day === 1 || (D.lastFollowers || 0) >= PROMOTE_MIN); }
  function nextDay() {
    if (D.phase !== 'summary' || D.result) return false;
    clearWorld();
    for (const L of sim.leaders) if (L.arrested && !L.gone) { L.gone = true; L.x = -5000; L.y = -5000; L.field = null; L.count = 0; }
    D.day++;
    let promoted = null;
    // v1.8: enough leaders for tomorrow's crowd (2 from LEAD2_N marchers, 3 from LEAD3_N; v1.4-1.7: one promotion if fewer than 2)
    const want = D.carry.crowd >= LEAD3_N ? 3 : D.carry.crowd >= LEAD2_N ? 2 : 1;
    if (D.day <= 2 || D.carry.crowd >= PROMOTE_MIN) {
      const names = [];
      for (let k = 0; activeLeaders().length < want && k < 3; k++) {
        const p = sim.spawnPoints[spawnKeys()[0]] || [sim.W / 2, sim.H / 2];
        const L = sim.api.addLeader(p[0], p[1]);
        if (L) { names.push(L.name); L.promotedDay = D.day; } else break;
      }
      if (names.length) promoted = names.join(', ');
    }
    if (!activeLeaders().length) { D.day--; return finish(false, 'decapitated', 'Every leader is behind bars and nobody steps up.'); }
    D.carry.promoted = promoted;
    enterBriefing();
    const first = activeLeaders()[0]; if (first) sim.select(first.id, false);
    if (promoted) sim.emit('promoted', 0, 0, { name: promoted, day: D.day });
    return true;
  }
  function finish(win, reason, text) {
    const L = win ? sim.winner() : null;
    D.result = { win, reason, text, day: D.day, leader: L ? L.name : null, count: L ? L.count : 0, at: tod() };
    if (win || D.phase === 'day' || D.phase === 'dusk') D.history.push({ day: D.day, ...D.stats, leadersArrested: D.stats.leadersArrested.slice(), reason });
    D.phase = 'ended';
    sim.emit(win ? 'campaignWon' : 'campaignLost', sim.goal.x, sim.goal.y, { reason, day: D.day });
  }
  function skipTo(hours) {
    if (D.phase !== 'day' && D.phase !== 'dusk') return false;
    const t = Math.max(tod(), hours * 3600);
    for (const r of D.riotPlan) if (!r.spawned && r.at < t) { r.spawned = true; r.skipped = true; }
    sim.simTime = dayBase() + t;
    return true;
  }

  // ---------------------------------------------------------------- v1.8 mid-day successor
  // Called while no leader is active. Returns true while a successor is pending (or has just stepped up), false when nobody can.
  function succession(t) {
    const A = D.lastArrest;
    if (!D.succession) {
      if (!A || (D.successorsToday || 0) >= SUCC_PER_DAY || D.phase !== 'day') return false;
      if (looseNear(A.x, A.y, SUCC_R) < SUCC_MIN) return false;
      D.succession = { at: t + SUCC_DELAY, x: A.x, y: A.y }; D.successorsToday = (D.successorsToday || 0) + 1;
      sim.emit('succession', A.x, A.y, { phase: 'pending', at: D.succession.at });
      return true;
    }
    if (t < D.succession.at) return true;
    const S = D.succession; D.succession = null;
    // the densest knot of loose protesters near the arrest (sampled), at least 12 m from any officer
    let best = -1, bn = -1;
    const cand = [];
    sim.forEachNear(S.x, S.y, SUCC_R, j => { if (isLoose(j)) cand.push(j); });
    if (cand.length < SUCC_MIN) return false;
    for (let k = 0; k < 40; k++) {
      const j = cand[Math.floor(rand() * cand.length)];
      if (nearOfficer(px[j], py[j], 12)) continue;
      const n = sim.countNear(px[j], py[j], 6); if (n > bn) { bn = n; best = j; }
    }
    if (best < 0) return false;
    const L = sim.api.addLeader(px[best], py[best]); if (!L) return false;
    L.promotedDay = D.day; L.successor = true; L.orderT = sim.simTime;
    let n = 0;
    sim.forEachNear(L.x, L.y, SUCC_BIND_R, j => { if (isLoose(j) && rand() < SUCC_BIND_P) { lead[j] = L.id; n++; } });
    sim.emit('promoted', L.x, L.y, { name: L.name, day: D.day, successor: true, n });
    return true;
  }
  const isLoose = j => lead[j] < 0 && riot[j] < 0 && panicT[j] <= 0 && !leaving[j] && (act[j] === ACT.IDLE || act[j] === ACT.FOLLOW);
  function looseNear(x, y, r) { let n = 0; sim.forEachNear(x, y, r, j => { if (isLoose(j)) n++; }); return n; }
  function nearOfficer(x, y, r) { for (const sq of sim.squads || []) { if (Math.hypot(sq.x - x, sq.y - y) > r + 40) continue; for (let k = 0; k < (sq.na ?? sq.n); k++) if (Math.hypot(sq.ox[k] - x, sq.oy[k] - y) < r) return true; } return false; }

  // ---------------------------------------------------------------- stats from events
  function onEvent(e) {
    if (!D || (D.phase !== 'day' && D.phase !== 'dusk')) return;
    const st = D.stats;
    switch (e.type) {
      case 'loot': { st.lootGrabs++; const k = typeof e.shop === 'number' ? e.shop : (e.shop?.idx ?? -1); if (k < 0 || !lootedToday.has(k)) { if (k >= 0) lootedToday.add(k); st.looted++; } break; }
      case 'arrest':
        st.arrests++;
        if (e.leader != null) { const L = sim.leaders[e.leader]; if (L && !st.leadersArrested.includes(L.name)) st.leadersArrested.push(L.name); if (L) D.lastArrest = { x: L.x, y: L.y, n: L.count, t: tod(), id: L.id }; }
        break;
      case 'injury': st.injured++; break;
      case 'fire': st.fires++; break;
      case 'throw': st.projectiles++; break;
      case 'brawl': st.brawls++; break;
      case 'explosion': st.explosions++; break;
      case 'brutality': st.brutality++; break;
      case 'officerDown': st.officersDown++; break;
      case 'riotJoined': {
        st.riotsJoined++;
        const r = e.riot != null && sim.riots ? sim.riots.find(q => q.id === e.riot) : null;
        st.riotJoined += e.n ?? e.count ?? r?.count ?? 0;
        break;
      }
    }
  }

  // ---------------------------------------------------------------- intensity ramp (v1.6)
  // sim.day.intensity 0..1 from the time of day (INT_TOD) and the day number (INT_DAY). Riots read it to scale loot,
  // burn, throw and fight rates (sim.day.chaos and sim.chaos are kept as legacy aliases of the same value).
  // D.intensityOverride (number) pins it (tests / debug).
  function intensityAt(day, t) {
    const h = t / 3600;
    let f = INT_TOD[0][1];
    for (let k = 1; k < INT_TOD.length; k++) { const [h0, v0] = INT_TOD[k - 1], [h1, v1] = INT_TOD[k]; if (h <= h1) { f = v0 + (v1 - v0) * clamp((h - h0) / (h1 - h0), 0, 1); break; } f = v1; }
    return clamp(f * (INT_DAY[day - 1] ?? 1), 0, 1);
  }
  function setIntensity(v) { D.intensity = D.chaos = D.intensityOverride ?? v; }

  // ---------------------------------------------------------------- v1.7 objective hook (intermediate / per-day objectives)
  // Not used by the game yet. sim.api.addObjective({ id, title, day?, check(sim, D, dt) -> 'done' | 'failed' | undefined, persist? })
  // registers an objective; during 'day'/'dusk' every check runs once per sim second until it returns a status, which is stored
  // (D.objectives[k].status / at) and emitted as 'objective' {id, status}. Objectives with a 'day' only run on that day; the list
  // is cleared at each briefing unless persist is set. Each day's results go into D.stats.objectives (and the history).
  let objT = 0;
  function addObjective(o) { if (!o || !o.id || typeof o.check !== 'function') return null; const r = { status: null, at: null, ...o }; D.objectives.push(r); return r; }
  function checkObjectives(dt) {
    if (!D.objectives.length || (objT -= dt) > 0) return;
    objT = 1;
    for (const o of D.objectives) {
      if (o.status || (o.day && o.day !== D.day)) continue;
      let r; try { r = o.check(sim, D, 1); } catch (e) { r = undefined; }
      if (r === 'done' || r === 'failed') { o.status = r; o.at = tod(); D.stats.objectives.push({ id: o.id, status: r, at: o.at }); sim.emit('objective', sim.goal.x, sim.goal.y, { id: o.id, status: r }); }
    }
  }

  // ---------------------------------------------------------------- per-substep update
  function update(dt) {
    if (!D.managed) { D.t = sim.simTime % 86400; setIntensity(1); D.stats.peak = Math.max(D.stats.peak, totalFollowers()); return; }
    if (D.phase !== 'day' && D.phase !== 'dusk') { D.intensity = D.chaos = 0; return; }
    const t = tod(); D.t = t;
    setIntensity(intensityAt(D.day, t));
    // leaders arrested by police (police sets L.arrested); make sure the name is recorded even without an event
    for (const L of sim.leaders) if (L.arrested && !L.gone && !D.stats.leadersArrested.includes(L.name)) D.stats.leadersArrested.push(L.name);
    const actL = activeLeaders(), followers = totalFollowers();
    if (actL.length) D.lastFollowers = followers;
    D.stats.peak = Math.max(D.stats.peak, followers);
    D.followers = followers;

    // win / lose. v1.5: the gate must be HELD for HOLD_T s (design doc §8.1); the timer drains twice as fast when lost
    const Wn = sim.winner();
    if (Wn) {
      if (!(D.holdT > 0)) sim.emit('gateHold', sim.goal.x, sim.goal.y, { leader: Wn.id, phase: 'start' });
      D.holdT = (D.holdT || 0) + dt; D.holdLeader = Wn.id;
      if (D.holdT >= HOLD_T) return finish(true, 'elysee', 'The crowd took and held the Élysée gate.');
    } else if (D.holdT > 0) { D.holdT = Math.max(0, D.holdT - 2 * dt); if (D.holdT === 0) sim.emit('gateHold', sim.goal.x, sim.goal.y, { phase: 'lost' }); }
    if (sim.leaders.length && !actL.length) {
      if (succession(t)) { /* v1.8: a successor is stepping up */ }
      else if (canPromote()) return endDay('leaderless');
      else return finish(false, 'decapitated', 'Every leader is behind bars and nobody steps up.');
    }
    if (D.phase === 'day' && t > H8 + 300) {
      // v1.8: a collapsed march with a leader still free ends the DAY ('dispersed', no dusk bonus); the campaign is lost only on day 7
      if (followers < COLLAPSE_N) { lowT += dt; if (lowT >= COLLAPSE_T) return D.day < DAYS ? endDay('dispersed') : finish(false, 'collapse', 'The movement fizzled out: too few marchers left on the street.'); }
      else lowT = 0;
    }
    D.lowT = lowT;
    checkObjectives(dt);

    if (D.phase === 'day') {
      D.light = 1;
      spawnDueRiots();
      // bystanders: the streets fill up over the day (55% at 08:00 -> 115% by 15:00)
      bysT -= dt;
      if (bysT <= 0) {
        bysT = 30;
        let n = 0; const NA = sim.NA;
        for (let i = 0; i < NA; i++) if (lead[i] < 0 && riot[i] < 0 && act[i] === ACT.IDLE && !leaving[i]) n++;
        const want = Math.round(bystanderTarget() * (0.55 + 0.6 * clamp((t - H8) / (7 * 3600), 0, 1)));
        if (n < want) sim.spawnBystanders(Math.min(want - n, 60));
      }
      if (t >= H18) { D.heldAtDusk = totalFollowers(); D.phase = 'dusk'; D.policeClear = true; sim.emit('dusk', sim.goal.x, sim.goal.y, { day: D.day }); }
      return;
    }
    // dusk: light fades, protesters and bystanders head for the map edge and are removed there
    const f = clamp((t - H18) / (H20 - H18), 0, 1);
    D.light = 1 - 0.7 * f;
    if (!exitDist) exitDist = buildExitField();
    const rate = (0.0004 + 0.003 * f) * dt, NA = sim.NA;
    for (let i = 0; i < NA; i++) {
      const a = act[i];
      if (a === ACT.DOWN || a === ACT.ARRESTED) continue;
      if (!leaving[i]) { if (rand() < rate) leaving[i] = 1; else continue; }
      const e = exitDir(px[i], py[i]);
      if (e.d <= 3 || e.d === 65535 && rand() < dt / 60) { sim.removeAgent(i); sim.dispersedHome++; continue; }
      // v1.5: walk home (act HOME, not panic): the crowd steers HOME agents along fleeX/fleeY at a stroll
      lead[i] = -1; riot[i] = -1; panicT[i] = 0; act[i] = ACT.HOME; sim.prevLead[i] = -1;
      if (e.x || e.y) { fleeX[i] = e.x; fleeY[i] = e.y; }
    }
    if (t >= H20) endDay('time');
  }

  // ---------------------------------------------------------------- API
  sim.api.dayInfo = () => D;
  sim.api.dayStart = startDay;
  sim.api.addObjective = addObjective; // v1.7 hook (see checkObjectives)
  sim.api.dayContinue = nextDay;
  sim.api.chooseSpawn = chooseSpawn;
  sim.api.daySkipTo = skipTo;
  sim.api.dayEnd = () => endDay('time');
  // [v1.6 debug/tests] jump the campaign to day n while in the briefing (optionally with a given crowd size)
  sim.api.daySetDay = (n, crowd) => {
    if (D.phase !== 'briefing') return false;
    D.day = clamp(n | 0, 1, DAYS); if (crowd) D.carry.crowd = crowd;
    enterBriefing(); return true;
  };
  // tomorrow's (or today's) crowd estimate, for the HUD
  sim.api.intensityAt = (day, hours) => intensityAt(day, hours * 3600); // v1.6: for the HUD / tests
  sim.api.dayPlan =() => ({ riots: D.riotPlan, squads: D.squadsToday, crowd: D.carry?.crowd ?? 0 });
  // winner excludes arrested leaders
  sim.winner = () => sim.leaders.find(L => !L.arrested && !L.gone && L.count >= sim.WIN_COUNT && Math.hypot(L.x - sim.goal[0], L.y - sim.goal[1]) < sim.GOAL_R) || null;
  if (managed) sim.initScenario = setupCampaign;
  sim.onEvent?.(onEvent);

  return {
    name: 'day',
    init() {
      D = sim.day = { managed, day: 1, phase: managed ? 'briefing' : 'day', t: H8, start: H8, end: H20, dusk: H18, light: 1, days: DAYS,
        stats: newStats(), choice: {}, riotPlan: [], carry: null, history: [], result: null, followers: 0, lastFollowers: 0, lowT: 0,
        flavour: FLAVOUR, squadsToday: squadsFor(1), policeClear: false, intensity: managed ? 0 : 1, chaos: managed ? 0 : 1, intensityOverride: null, objectives: [] };
    },
    update,
  };
}
