// Paris riot sim: simulation core. No three.js, no DOM rendering.
// createSim(data) builds the nav grid, flow fields, spatial hash and agent arrays, then runs the
// systems in src/systems/ (see docs/contract.md). World coordinates: metres, x east, y north,
// origin at the SW corner of data.meta.bbox.
import { clamp, areaPath, polyPath, linePath, CLS, ACT, makeRng } from './common.js';
import createLeaders from './systems/leaders.js';
import createRiots from './systems/riots.js';
import createPolice from './systems/police.js';
import createCombat from './systems/combat.js';
import createGas from './systems/gas.js';
import createCrowd from './systems/crowd.js';
import createDay from './systems/day.js';
export { LEADER_COLORS, NAMES, LM_NAMES, lmName, clamp, ring, holes, polyPath, areaPath, linePath, CLS, ACT } from './common.js';

const LL = { republique: [48.8675, 2.3637], bastille: [48.8532, 2.3691], hotelDeVille: [48.8566, 2.3522], elysee: [48.8704, 2.3167],
  concorde: [48.8656, 2.3212], beauvau: [48.8714, 2.3171], madeleine: [48.8700, 2.3245], chatelet: [48.8583, 2.3470],
  notreDame: [48.8530, 2.3499], louvre: [48.8606, 2.3376], pontNeuf: [48.8571, 2.3413], operaGarnier: [48.8720, 2.3316] };

// system order per substep (after buildHash)
export const SYSTEM_FACTORIES = [createLeaders, createRiots, createPolice, createCombat, createGas, createCrowd, createDay];

// reference density of bystanders: 1800 on the full map (whose walkable area is FULL_WALK_CELLS nav cells)
const BYSTANDERS_FULL = 1800, FULL_WALK_CELLS = 674652;
// spawn class mix: RANDO 50%, PACIFIST 20%, ENCOURAGER 10%, MEDIC 8%, BLACKBLOC 12% (cumulative)
const CLS_CUM = [0.5, 0.7, 0.8, 0.88, 1.0];
// placeholder base temperament per class (aggr = base +- 0.1)
const CLS_AGGR = [0.3, 0.05, 0.4, 0.1, 0.75];

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

// opts.navRaster (v1.7, optional): a precomputed walk grid (Uint8Array COLS*ROWS, e.g. a dump of sim.walk) used instead of
// rasterising the map on a canvas. This lets the sim run in Node (tools/playtest.mjs) with no DOM / OffscreenCanvas.
export function createSim(D, opts = {}) {
  const W = D.meta.width, H = D.meta.height;
  const rng = makeRng();
  const rand = rng.rand;
  const inMap = p => p && p[0] >= 0 && p[1] >= 0 && p[0] <= W && p[1] <= H;

  function ll2xy(lat, lon) {
    const m = D.meta;
    return [(lon - m.bbox[1]) * 111320 * Math.cos(m.lat0 * Math.PI / 180), (lat - m.bbox[0]) * 110574];
  }
  // landmarks: from the data, else computed from lat/lon; dropped when outside the map
  const LM = {};
  for (const k in LL) { const p = (D.landmarks && D.landmarks[k]) || ll2xy(...LL[k]); if (inMap(p)) LM[k] = p; }
  if (D.landmarks) for (const k in D.landmarks) if (!LM[k] && inMap(D.landmarks[k])) LM[k] = D.landmarks[k];
  if (!LM.elysee) LM.elysee = (D.landmarks && D.landmarks.elysee) || ll2xy(...LL.elysee);
  const spawnPoints = {};
  if (D.spawnPoints) for (const k in D.spawnPoints) if (inMap(D.spawnPoints[k])) spawnPoints[k] = D.spawnPoints[k];

  // =====================================================================
  // NAV GRID
  // =====================================================================
  const CELL = 3;
  const COLS = Math.ceil(W / CELL), ROWS = Math.ceil(H / CELL), NC = COLS * ROWS;
  const walk = new Uint8Array(NC);
  const clear = new Uint8Array(NC);
  let walkCells = 0;

  function buildNav() {
    if (opts.navRaster && opts.navRaster.length === NC) walk.set(opts.navRaster);
    else rasterNav();
    finishNav();
  }
  function rasterNav() {
    const cv = makeCanvas(COLS, ROWS);
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.fillStyle = '#000'; c.fillRect(0, 0, COLS, ROWS);
    c.setTransform(1 / CELL, 0, 0, -1 / CELL, 0, ROWS);
    c.fillStyle = '#fff';
    for (const a of D.parks || []) { areaPath(c, a); c.fill('evenodd'); }
    for (const a of D.squares || []) { areaPath(c, a); c.fill('evenodd'); }
    c.strokeStyle = '#fff'; c.lineCap = 'round'; c.lineJoin = 'round';
    for (const r of D.roads) { if (r.b) continue; c.lineWidth = Math.max(r.w, CELL * 1.4); linePath(c, r.p); c.stroke(); }
    c.fillStyle = '#000';
    for (const a of D.water || []) { areaPath(c, a); c.fill('evenodd'); }
    for (const r of D.roads) { if (!r.b) continue; c.lineWidth = Math.max(r.w, CELL * 1.4); linePath(c, r.p); c.stroke(); }
    for (const b of D.buildings) { c.beginPath(); polyPath(c, b.p); c.fill(); }
    const img = c.getImageData(0, 0, COLS, ROWS).data;
    for (let gy = 0; gy < ROWS; gy++) for (let gx = 0; gx < COLS; gx++)
      walk[gy * COLS + gx] = img[((ROWS - 1 - gy) * COLS + gx) * 4] > 127 ? 1 : 0;
  }
  function finishNav() {
    for (let gx = 0; gx < COLS; gx++) { walk[gx] = 0; walk[(ROWS - 1) * COLS + gx] = 0; }
    for (let gy = 0; gy < ROWS; gy++) { walk[gy * COLS] = 0; walk[gy * COLS + COLS - 1] = 0; }

    // keep only the component connected to the seed (removes sealed courtyards etc.).
    // Seed: République if present (as before), else the first spawn point, else the Élysée.
    const seedP = LM.republique || Object.values(spawnPoints)[0] || LM.elysee;
    const seed = nearestWalkable(Math.floor(seedP[0] / CELL), Math.floor(seedP[1] / CELL), 60);
    const seen = new Uint8Array(NC), q = new Int32Array(NC);
    let qh = 0, qt = 0;
    if (seed >= 0) { q[qt++] = seed; seen[seed] = 1; }
    while (qh < qt) { const i = q[qh++]; for (const o of [1, -1, COLS, -COLS]) { const n = i + o; if (walk[n] && !seen[n]) { seen[n] = 1; q[qt++] = n; } } }
    if (qt > 1000) for (let i = 0; i < NC; i++) walk[i] = seen[i];

    // clearance (distance to nearest blocked cell, in cells, capped)
    qh = qt = 0;
    for (let i = 0; i < NC; i++) { if (!walk[i]) { clear[i] = 0; q[qt++] = i; } else clear[i] = 255; }
    while (qh < qt) { const i = q[qh++]; const d = clear[i]; if (d >= 4) continue;
      for (const o of [1, -1, COLS, -COLS]) { const n = i + o; if (n < 0 || n >= NC) continue; if (clear[n] > d + 1) { clear[n] = d + 1; q[qt++] = n; } } }
    walkCells = 0; for (let i = 0; i < NC; i++) walkCells += walk[i];
  }

  const cellOf = (x, y) => Math.floor(y / CELL) * COLS + Math.floor(x / CELL);
  function walkAt(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    return walk[cellOf(x, y)] === 1;
  }
  function nearestWalkable(gx, gy, maxR = 40) {
    const ok = (x, y) => x > 0 && y > 0 && x < COLS - 1 && y < ROWS - 1 && walk[y * COLS + x];
    if (ok(gx, gy)) return gy * COLS + gx;
    for (let r = 1; r <= maxR; r++) {
      for (let d = -r; d <= r; d++) {
        if (ok(gx + d, gy - r)) return (gy - r) * COLS + gx + d;
        if (ok(gx + d, gy + r)) return (gy + r) * COLS + gx + d;
        if (ok(gx - r, gy + d)) return (gy + d) * COLS + gx - r;
        if (ok(gx + r, gy + d)) return (gy + d) * COLS + gx + r;
      }
    }
    return -1;
  }
  const cellX = c => (c % COLS + 0.5) * CELL, cellY = c => (Math.floor(c / COLS) + 0.5) * CELL;

  // ---------- flow fields (Dial's algorithm, 8-connected, no corner cutting) ----------
  const DXS = [1, -1, 0, 0, 1, 1, -1, -1], DYS = [0, 0, 1, -1, 1, -1, 1, -1];
  const DOFF = DXS.map((dx, k) => dx + DYS[k] * COLS);
  const DCOST = [10, 10, 10, 10, 14, 14, 14, 14];
  const DVX = DXS.map((dx, k) => dx / Math.hypot(dx, DYS[k])), DVY = DYS.map((dy, k) => dy / Math.hypot(DXS[k], dy));
  const buckets = Array.from({ length: 15 }, () => []);
  const UNREACH = 65535;

  function computeField(tx, ty) {
    let t = walkAt(tx, ty) ? cellOf(tx, ty) : nearestWalkable(Math.floor(tx / CELL), Math.floor(ty / CELL), 60);
    if (t < 0) return null;
    if (!walkAt(tx, ty)) { tx = cellX(t); ty = cellY(t); }
    const dist = new Uint16Array(NC).fill(UNREACH);
    const dir = new Uint8Array(NC).fill(255);
    dist[t] = 0; buckets[0].push(t);
    let pending = 1, cur = 0;
    while (pending > 0) {
      const b = buckets[cur % 15];
      while (b.length) {
        const c = b.pop(); pending--;
        if (dist[c] !== cur) continue;
        for (let k = 0; k < 8; k++) {
          const n = c + DOFF[k];
          if (!walk[n]) continue;
          if (k >= 4 && (!walk[c + DXS[k]] || !walk[c + DYS[k] * COLS])) continue;
          const nd = cur + DCOST[k];
          if (nd < dist[n] && nd < UNREACH) { dist[n] = nd; buckets[nd % 15].push(n); pending++; }
        }
      }
      cur++;
    }
    for (let c = 0; c < NC; c++) {
      const d = dist[c];
      if (d === UNREACH) continue;
      if (d === 0) { dir[c] = 8; continue; }
      let best = d, bk = 255;
      for (let k = 0; k < 8; k++) {
        const n = c + DOFF[k];
        if (dist[n] < best) {
          if (k >= 4 && (!walk[c + DXS[k]] || !walk[c + DYS[k] * COLS])) continue;
          best = dist[n]; bk = k;
        }
      }
      dir[c] = bk;
    }
    return { dist, dir, tx, ty };
  }
  const tmpV = { x: 0, y: 0 };
  function fieldDir(F, x, y, out) {
    const fx = x / CELL - 0.5, fy = y / CELL - 0.5;
    const i0 = Math.floor(fx), j0 = Math.floor(fy);
    if (i0 < 0 || j0 < 0 || i0 >= COLS - 1 || j0 >= ROWS - 1) return false;
    const ax = fx - i0, ay = fy - j0;
    let vx = 0, vy = 0;
    for (let q = 0; q < 4; q++) {
      const di = q & 1, dj = q >> 1;
      const w = (di ? ax : 1 - ax) * (dj ? ay : 1 - ay);
      const code = F.dir[(j0 + dj) * COLS + i0 + di];
      if (code < 8) { vx += DVX[code] * w; vy += DVY[code] * w; }
      else if (code === 8) { const dx = F.tx - x, dy = F.ty - y, l = Math.hypot(dx, dy) || 1; vx += dx / l * w; vy += dy / l * w; }
    }
    const l = Math.hypot(vx, vy);
    if (l < 1e-3) return false;
    out.x = vx / l; out.y = vy / l;
    return true;
  }
  function fieldDist(F, x, y) {
    const d = F.dist[cellOf(clamp(x, 0, W - 1), clamp(y, 0, H - 1))];
    return d === UNREACH ? Infinity : d * CELL / 10;
  }
  // polyline [x,y,x,y,...] following the flow field from (x,y) to its target
  function tracePath(F, x, y) {
    const pts = [x, y];
    let c = cellOf(x, y), steps = 0;
    while (steps++ < 6000) {
      const code = F.dir[c]; if (code >= 8) break;
      c += DOFF[code];
      if (steps % 3 === 0) pts.push(cellX(c), cellY(c));
    }
    pts.push(F.tx, F.ty);
    return pts;
  }

  // =====================================================================
  // AGENTS (structure of arrays; every per-agent array is registered so removal can swap-copy it)
  // =====================================================================
  const MAXA = 16000;
  const agentArrays = []; // [{arr, def}]
  // register a per-agent array (length >= MAXA). addAgent sets it to `def` (default 0) for new agents
  // and copyAgent / removal swap-copy it.
  function registerAgentArray(arr, def = 0) {
    if (!agentArrays.some(a => a.arr === arr)) agentArrays.push({ arr, def });
    return arr;
  }
  const reg = Ctor => registerAgentArray(new Ctor(MAXA));
  const px = reg(Float32Array), py = reg(Float32Array), vx = reg(Float32Array), vy = reg(Float32Array);
  const v0 = reg(Float32Array), panicT = reg(Float32Array), fleeX = reg(Float32Array), fleeY = reg(Float32Array);
  const lead = reg(Int16Array), gone = reg(Uint8Array);
  const cls = reg(Uint8Array), act = reg(Uint8Array), tgt = reg(Int32Array), riot = reg(Int16Array);
  const hp = reg(Float32Array), aggr = reg(Float32Array), cd = reg(Float32Array), extFx = reg(Float32Array), extFy = reg(Float32Array);
  const NCORE = agentArrays.length; // core arrays are initialised explicitly in addAgent
  // [v1.5] leader the agent followed before it last panicked (-1 none): panicked marchers regroup with it afterwards
  const prevLead = registerAgentArray(new Int16Array(MAXA), -1);
  let NA = 0, dispersedHome = 0, simTime = 8 * 3600, pendingRemovals = 0;

  function randomCls() { const r = rand(); let c = 0; while (c < 4 && r >= CLS_CUM[c]) c++; return c; }
  // addAgent(x, y, opts): opts is a leader index (legacy) or { lead, cls, riot, aggr }
  function addAgent(x, y, opts = -1) {
    if (NA >= MAXA) return -1;
    const o = typeof opts === 'number' ? { lead: opts } : (opts || {});
    const i = NA++;
    for (let a = NCORE; a < agentArrays.length; a++) { const r = agentArrays[a]; r.arr[i] = r.def; }
    px[i] = x; py[i] = y; vx[i] = vy[i] = 0; v0[i] = 1.2 + rand() * 0.35;
    const L = o.lead ?? -1;
    panicT[i] = 0; fleeX[i] = fleeY[i] = 0; lead[i] = L; gone[i] = 0;
    const c = o.cls ?? randomCls();
    cls[i] = c; act[i] = L >= 0 ? ACT.FOLLOW : ACT.IDLE; tgt[i] = -1; riot[i] = o.riot ?? -1;
    hp[i] = 1; aggr[i] = o.aggr ?? clamp(CLS_AGGR[c] + (rand() - 0.5) * 0.2, 0, 1); cd[i] = 0; extFx[i] = extFy[i] = 0;
    return i;
  }
  function copyAgent(f, t) { for (let a = 0; a < agentArrays.length; a++) { const r = agentArrays[a].arr; r[t] = r[f]; } }
  // deferred: the agent is swap-removed at the end of the current substep (indices stay valid until then)
  function removeAgent(i) { if (i >= 0 && i < NA && !gone[i]) { gone[i] = 1; pendingRemovals++; } }
  function flushRemovals() {
    if (!pendingRemovals) return;
    for (let i = NA - 1; i >= 0; i--) if (gone[i]) { NA--; if (i !== NA) copyAgent(NA, i); }
    pendingRemovals = 0;
  }
  function spawnAround(x, y, n, L = -1) {
    const r = Math.sqrt(n) * 0.9 + 4;
    let made = 0, tries = 0;
    while (made < n && tries < n * 40) {
      tries++;
      const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * r * (1 + tries / (n * 8));
      const sx = x + Math.cos(a) * d, sy = y + Math.sin(a) * d;
      if (walkAt(sx, sy) && clear[cellOf(sx, sy)] >= 1) { addAgent(sx, sy, L); made++; }
    }
    return made;
  }
  function spawnBystanders(n) {
    let made = 0, tries = 0;
    while (made < n && tries < n * 200) {
      tries++;
      const x = rand() * W, y = rand() * H;
      if (walkAt(x, y) && clear[cellOf(x, y)] >= 2) { addAgent(x, y, -1); made++; }
    }
  }
  function makePanic(i, t, fx, fy) {
    if (lead[i] >= 0) prevLead[i] = lead[i];
    panicT[i] = Math.max(panicT[i], t); lead[i] = -1;
    const l = Math.hypot(fx, fy) || 1; fleeX[i] = fx / l; fleeY[i] = fy / l;
  }

  // spatial hash (counting sort)
  const HC = 2.0, HSIZE = 1 << 15, HMASK = HSIZE - 1; // [crowd] v1.6 perf: 2^15 buckets (was 2^17): buildHash clears and prefix-sums every bucket each substep
  const hStart = new Int32Array(HSIZE + 1), hCur = new Int32Array(HSIZE + 1), hItems = new Int32Array(MAXA), hKeyA = new Int32Array(MAXA);
  const hkey = (cx, cy) => ((cx * 92837111) ^ (cy * 689287499)) & HMASK;
  function buildHash() {
    hStart.fill(0);
    for (let i = 0; i < NA; i++) { const k = hkey(Math.floor(px[i] / HC), Math.floor(py[i] / HC)); hKeyA[i] = k; hStart[k + 1]++; }
    for (let k = 0; k < HSIZE; k++) hStart[k + 1] += hStart[k];
    hCur.set(hStart);
    for (let i = 0; i < NA; i++) hItems[hCur[hKeyA[i]]++] = i;
  }
  function countNear(x, y, r) {
    const cx = Math.floor(x / HC), cy = Math.floor(y / HC), R = Math.ceil(r / HC), r2 = r * r;
    let n = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const k = hkey(cx + dx, cy + dy);
      for (let s = hStart[k]; s < hStart[k + 1]; s++) { const j = hItems[s]; const ex = px[j] - x, ey = py[j] - y; if (ex * ex + ey * ey < r2) n++; }
    }
    return n;
  }
  // fn(j, dx, dy, d2) for every agent j within r of (x, y), with dx = px[j] - x. Return true from fn to stop.
  // Uses the hash built at the start of the substep: agents added since then are not visited.
  function forEachNear(x, y, r, fn) {
    const cx = Math.floor(x / HC), cy = Math.floor(y / HC), R = Math.ceil(r / HC), r2 = r * r;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const k = hkey(cx + dx, cy + dy);
      for (let s = hStart[k], e = hStart[k + 1]; s < e; s++) {
        const j = hItems[s]; if (j >= NA) continue;
        const ex = px[j] - x, ey = py[j] - y, d2 = ex * ex + ey * ey;
        if (d2 < r2 && fn(j, ex, ey, d2) === true) return;
      }
    }
  }
  function dirTo(x, y, tx, ty, out) { const dx = tx - x, dy = ty - y, l = Math.hypot(dx, dy); if (l < 1e-3) return false; out.x = dx / l; out.y = dy / l; return true; }
  function moveWithWalls(o, dx, dy) {
    const nx = o.x + dx, ny = o.y + dy;
    if (walkAt(nx, ny)) { o.x = nx; o.y = ny; }
    else if (walkAt(nx, o.y)) o.x = nx;
    else if (walkAt(o.x, ny)) o.y = ny;
  }

  // =====================================================================
  // EVENTS: sim.emit(type, x, y, extra) pushes { type, t, x, y, ...extra }; the renderer drains once per frame
  // =====================================================================
  const events = [];
  function emit(type, x, y, extra) {
    if (events.length > 4000) events.splice(0, 2000); // nobody draining: keep it bounded
    const e = { type, t: simTime, x, y };
    if (extra) Object.assign(e, extra);
    events.push(e);
    for (let k = 0; k < eventListeners.length; k++) { try { eventListeners[k](e); } catch (err) { console.error(err); } } // [day]
    return e;
  }
  function drainEvents() { const out = events.slice(); events.length = 0; return out; }
  // [day] multi-subscriber: onEvent(fn) calls fn(e) at emit time (independent of drainEvents). Returns an unsubscribe function.
  const eventListeners = [];
  function onEvent(fn) { eventListeners.push(fn); return () => { const k = eventListeners.indexOf(fn); if (k >= 0) eventListeners.splice(k, 1); }; }

  // Walkable goal point for the Élysée (the landmark is the palace centre, inside a building).
  // Prefer the street front to the north (rue du Faubourg Saint-Honoré), else the nearest walkable cell.
  function findGoal() {
    const [ex, ey] = LM.elysee;
    for (let d = 0; d <= 150; d += 1) {
      for (const o of [0, -3, 3, -6, 6]) if (walkAt(ex + o, ey + d)) {
        // step 2 more cells north into the street if still walkable
        let gx = ex + o, gy = ey + d;
        for (let s = 0; s < 2 && walkAt(gx, gy + CELL); s++) gy += CELL;
        const c = cellOf(gx, gy); return [cellX(c), cellY(c)];
      }
    }
    const c = nearestWalkable(Math.floor(ex / CELL), Math.floor(ey / CELL), 80);
    return c >= 0 ? [cellX(c), cellY(c)] : [ex, ey];
  }

  const t0 = performance.now();
  buildNav();
  const goal = findGoal(); goal.x = goal[0]; goal.y = goal[1]; // [x, y] (legacy) that also has .x/.y (contract)
  const GOAL_R = 40, WIN_COUNT = 300;

  // =====================================================================
  // THE SIM OBJECT (systems add their collections, APIs and legacy aliases to it)
  // =====================================================================
  const sim = {
    data: D, W, H, LM, spawnPoints, goal, GOAL_R, WIN_COUNT, CLS, ACT,
    // nav grid
    CELL, COLS, ROWS, walk, clear, walkAt, cellOf, nearestWalkable, cellX, cellY, get walkCells() { return walkCells; },
    computeField, fieldDir, fieldDist, tracePath, dirTo, moveWithWalls,
    // agents
    MAXA, px, py, vx, vy, v0, panicT, fleeX, fleeY, lead, gone, cls, act, tgt, riot, hp, aggr, cd, extFx, extFy, prevLead,
    // [v1.5] global chaos ramp 0..~1.1 (day system: quiet mornings, building through the afternoon and over the week; 1 in sandbox)
    get chaos() { const d = sim.day; return d && d.managed ? (d.chaos ?? 0) : 1; },
    get NA() { return NA; },
    get dispersedHome() { return dispersedHome; }, set dispersedHome(v) { dispersedHome = v; },
    registerAgentArray, addAgent, removeAgent, copyAgent, spawnAround, spawnBystanders, makePanic,
    // spatial hash (rebuilt at the start of every substep)
    HC, hStart, hItems, hkey, buildHash, countNear, forEachNear,
    // randomness, events
    rand, seed: n => rng.seed(n), events, emit, drainEvents,    onEvent, flushRemovals, // [day] event subscribers; apply deferred removals now (used between days while paused)
    api: {},
    // time
    get simTime() { return simTime; }, set simTime(v) { simTime = v; },
    step, advance, initScenario, stats, counts,
    winner: () => sim.leaders.find(L => L.count >= WIN_COUNT && Math.hypot(L.x - goal[0], L.y - goal[1]) < GOAL_R) || null,
  };

  // systems: create all (each registers its API / legacy aliases on sim), then init all (collections)
  const systems = SYSTEM_FACTORIES.map(f => f(sim));
  sim.systems = systems;
  for (const s of systems) s.init?.(sim);
  sim.buildMs = performance.now() - t0;

  // =====================================================================
  // STEPPING
  // =====================================================================
  function step(dt = 0.12) {
    buildHash();
    for (let s = 0; s < systems.length; s++) systems[s].update(dt, sim);
    flushRemovals();
    simTime += dt;
  }
  // advance by simDt seconds of sim time in substeps of at most 0.12 s (max 16 substeps per call).
  // [v1.5] budgetMs: stop early once this much real time is spent (graceful slow-down instead of a frozen frame);
  // returns the sim time actually advanced (sim.lag = fraction dropped, for the HUD).
  function advance(simDt, budgetMs = Infinity) {
    const nsub = Math.min(16, Math.ceil(simDt / 0.12));
    if (nsub <= 0) return 0;
    simDt = Math.min(simDt, nsub * 0.12);
    const dt = simDt / nsub, t0 = performance.now();
    let done = 0;
    for (let s = 0; s < nsub; s++) { step(dt); done++; if (performance.now() - t0 > budgetMs) break; }
    sim.lag = 1 - done / nsub;
    sim.updatePaths(dt * done);
    return dt * done;
  }

  // starting situation. Leaders at data.spawnPoints if present, else République/Bastille/Hôtel de Ville.
  function initScenario() {
    const counts = [600, 350, 120];
    let starts = Object.values(spawnPoints);
    if (!starts.length) starts = ['republique', 'bastille', 'hotelDeVille'].map(k => LM[k]).filter(Boolean);
    if (!starts.length) { // last resort: a walkable point far from the Élysée
      const c = nearestWalkable(Math.floor(COLS * 0.8), Math.floor(ROWS * 0.5), 200); if (c >= 0) starts = [[cellX(c), cellY(c)]];
    }
    const made = [];
    starts.forEach((p, i) => { const L = sim.api.addLeader(p[0], p[1]); if (L) { spawnAround(L.x, L.y, counts[i] ?? 120, L.id); made.push(L); } });
    spawnBystanders(Math.round(BYSTANDERS_FULL * Math.min(1, walkCells / FULL_WALK_CELLS)));
    let tx = 0, ty = 0;
    for (const L of made) { tx += L.x; ty += L.y; }
    const toward = made.length ? [tx / made.length, ty / made.length] : [W / 2, H / 2];
    for (const [k, ox, oy] of [['beauvau', 25, -10], ['madeleine', 30, 0], ['concorde', 60, 20]]) {
      const p = LM[k]; if (!p) continue;
      sim.api.addSquad(p[0] + ox, p[1] + oy, toward[0] - p[0], toward[1] - p[1]);
    }
    if (made.length) sim.select(made[0].id, false);
    return { start: toward };
  }

  function stats() {
    return { NA, dispersedHome, simTime, leaders: sim.leaders.map(L => ({ n: L.name, c: L.count, x: Math.round(L.x), y: Math.round(L.y), e: Math.round(L.energy), sp: +L.speed.toFixed(2), arrived: L.arrived })),
      squads: sim.squads.map(s => s.state + ':' + Math.round(s.energy)) };
  }
  function counts() {
    let attached = 0, idle = 0, fleeing = 0, leaving = 0;
    for (let i = 0; i < NA; i++) {
      if (act[i] === ACT.HOME) leaving++;           // [v1.5] dusk leavers are not "fleeing"
      else if (panicT[i] > 0) fleeing++; else if (lead[i] >= 0) attached++; else idle++;
    }
    return { attached, idle, fleeing, leaving, gone: dispersedHome };
  }

  return sim;
}
