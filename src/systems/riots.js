// Riots system: autonomous crowd AI. Owns sim.shops, sim.riots and the per-agent decision layer.
//
// Every agent re-decides every ~1-2 s (staggered, utility-ish rules per class) and then executes its
// action every substep by writing a desired direction/speed into aiX/aiY/aiV, which the crowd system
// (crowd.js) uses instead of leader following while act is one of LOOT..MILL. Effects (looting, throws,
// heals, smashing, ignition, brawls) are applied here through sim.api.* (guarded: other systems may be stubs).
//
// Uncontrolled riots (sim.riots) have a light brain: mill, then march to targets of opportunity (rich
// shops, police lines, fires, squares) along a cached local flow field (<= 1 recompute per riot per 30 s).
// Player leaders that come close convert members progressively ('riotJoined' when the majority flips).
//
// `aggr` is used as a temperament placeholder shaped like the future Heat gauge (docs/gauges.md §2.4):
// gas and police contact raise it, looting lowers it, and it relaxes to the class baseline (tickTemper).
import { clamp, CLS, ACT } from '../common.js';

const { RANDO, PACIFIST, ENCOURAGER, MEDIC, BLACKBLOC } = CLS;
const { IDLE, FOLLOW, FLEE, LOOT, FIGHT, THROW, PUSH, HEAL, MILL, DOWN, ARRESTED, HOME } = ACT;
const CLS_BASE = [0.3, 0.05, 0.4, 0.1, 0.75];     // same placeholder baselines as sim.js
const RIOT_MIX = [0.47, 0.06, 0.08, 0.05, 0.34];  // riots: more randos and black bloc
// target kinds (tk[i]); tgt[i] holds the matching index (officer = squadIndex*1000 + officer)
const TK_NONE = 0, TK_SHOP = 1, TK_OFF = 2, TK_AGENT = 3, TK_PROP = 4;
const BLOC_KINDS = [['rock', 0.32], ['bottle', 0.22], ['paving', 0.2], ['firework', 0.19], ['molotov', 0.07]];
const SG = 16;            // shop / prop grid bucket size (m)
const FIELD_MIN_T = 30;   // min sim seconds between flow-field recomputes per riot
// looting (v1.6 tuning; v1.5 was grab 8-14 s, 1/(7v), home .08/.04/.3, rest 75+60 s; v1.4 break 3 s, grab 5-9 s, 1/(5v))
const BREAK_T = 5;                         // s of work to break a shop window (bloc x2)
const GRAB_T0 = 11, GRAB_T1 = 9;           // grab time = GRAB_T0 + rand * GRAB_T1 s
const GRAB_FRAC = 9;                       // a grab takes 1 / (GRAB_FRAC * v) of the shop's stock
const HOME_P = { riot: 0.025, follower: 0.012, bystander: 0.2 }; // chance to go home with the loot after a grab
const LOOT_REST = 120;                     // s before the same agent loots again (+ up to 90 s random)
const LOOT_SEED = 0.12;                    // v1.6: loot start multiplier with no looting nearby (waves start rarely ...)
const LOOT_PROOF = 2.5;                    //       ... and spread: x(LOOT_PROOF + min(4, recent looters nearby)) next to a hotspot
const HOT_R = 30, HOT_T = 150;             // v1.6: loot hotspots merge within HOT_R m and cool down after HOT_T s idle
const LOOT_STANCE = { peaceful: 0, firm: 0.3, unleashed: 1.8 }; // follower loot multiplier by leader stance
const STANCE_AGGR = { firm: 0.4, unleashed: 2.0 }; // follower fight/throw/vandalism multiplier by stance (was 0.7 / 2.2; peaceful 0)
const MELEE_P = 0.07;      // chance a melee swing lands on an officer
// v1.6 brawls (user: "less often, and not everyone fights back"): only black bloc and hot randos (aggr > FIGHT_AGGR)
// trade blows; each squad accepts a new brawler every FIGHT_TOK_T s (bucket of FIGHT_TOK_MAX) and at most
// FIGHT_MAX at once; everyone else in contact shoves (PUSH) or backs off. v1.5: bloc 0.35, aggr > 0.65, no limit.
const FIGHT_AGGR = 0.72, FIGHT_BLOC_P = 0.12, FIGHT_TOK_T = 45, FIGHT_TOK_MAX = 2, FIGHT_MAX = 2, FIGHT_T = 12;
const BRAWL_FX_RATE = 2.5; // max 'brawl' events (stars) per sim second (v1.4: 6)
// v1.6 throwing: a throw session is 1-3 throws (was: keep throwing for up to 45 s), then a rest of AGG_REST s
const THROW_BLOC_P = 0.3, THROW_HOT_AGGR = 0.7, THROW_HOT_P = 0.04, AGG_REST = 40;
const PROP_P = 0.004;      // v1.6: bloc per-decision chance to go for a prop (burn / barricade) x aggr x vandalism (v1.5: 0.05)
const BYS_HOUR = 11;       // v1.6: (campaign) bystanders don't loot or vandalise before 11:00
// v1.6 riot roaming (was: mill within 1 x spread, re-picked every decision, walk back beyond 1 x spread)
const MILL_ROAM = 1.8, MILL_BACK = 2.6, MILL_CURIOUS = 0.25;

export default function create(sim) {
  const { px, py, vx, vy, v0, lead, cls, act, tgt, riot, hp, aggr, cd, panicT, CELL, COLS, ROWS, walk,
    walkAt, forEachNear, rand, registerAgentArray, MAXA, nearestWalkable, cellX, cellY } = sim;
  const reg = (C, d = 0) => registerAgentArray(new C(MAXA), d);
  const thinkT = reg(Float32Array);   // seconds until next decision (0 = never decided yet)
  const aiX = reg(Float32Array), aiY = reg(Float32Array), aiV = reg(Float32Array); // desired dir + speed (crowd reads)
  const tgX = reg(Float32Array), tgY = reg(Float32Array); // goal point of the current action
  const actT = reg(Float32Array);     // time spent in the current action / progress timer
  const tk = reg(Uint8Array);         // target kind (TK_*)
  const carry = reg(Uint8Array);      // 1 = carrying loot away, 2 = carrying loot and going home
  const encT = reg(Float32Array);     // encourager aura timer (crowd: tighter following, shorter panic)
  const claimT = reg(Float32Array, -1e9); // sim time a medic last claimed this (DOWN) agent
  const lootT = reg(Float32Array, -1e9);  // v1.5: sim time of this agent's last grab (+ random rest) -> loot cooldown
  const aggT = reg(Float32Array, -1e9);   // v1.6: sim time before which this agent won't start another throw / fight
  const nThrow = reg(Uint8Array);         // v1.6: throws left in the current throw session
  const navT = reg(Float32Array), navM = reg(Uint8Array); // v1.6 nav: re-check timer, mode (0 straight, 1 local field)
  Object.assign(sim, { aiX, aiY, aiV, encT, carry, aiTk: tk, thinkT });

  const stats = { throws: 0, grabs: 0, shatters: 0, smashes: 0, heals: 0, brawls: 0, ignites: 0, barricades: 0,
    converted: 0, lootHome: 0, riotsJoined: 0, fieldMs: 0, fields: 0 };
  let shops, shopStart, shopItems, SGC, SGR, props, propStart, propItems;
  let riots, booted = false, brawlTok = 0, coolT = 0;
  const activeShops = [];
  let downIdx = new Int32Array(1024), nDown = 0, downBuf = new Int32Array(1024), nDownBuf = 0;
  const tmp = { x: 0, y: 0 };

  // ---------------------------------------------------------------- spatial buckets for shops / props
  function buildBuckets(list) {
    SGC = Math.ceil(sim.W / SG) + 1; SGR = Math.ceil(sim.H / SG) + 1;
    const start = new Int32Array(SGC * SGR + 1), items = new Int32Array(list.length), key = new Int32Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const k = clamp(Math.floor(list[i].y / SG), 0, SGR - 1) * SGC + clamp(Math.floor(list[i].x / SG), 0, SGC - 1);
      key[i] = k; start[k + 1]++;
    }
    for (let k = 0; k < SGC * SGR; k++) start[k + 1] += start[k];
    const cur = start.slice();
    for (let i = 0; i < list.length; i++) items[cur[key[i]]++] = i;
    return [start, items];
  }
  // fn(index, d2) for every item within r; return true to stop
  function eachBucket(start, items, list, x, y, r, fn) {
    const gx0 = Math.max(0, Math.floor((x - r) / SG)), gx1 = Math.min(SGC - 1, Math.floor((x + r) / SG));
    const gy0 = Math.max(0, Math.floor((y - r) / SG)), gy1 = Math.min(SGR - 1, Math.floor((y + r) / SG));
    const r2 = r * r;
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      const k = gy * SGC + gx;
      for (let s = start[k], e = start[k + 1]; s < e; s++) {
        const j = items[s], o = list[j], dx = o.x - x, dy = o.y - y, d2 = dx * dx + dy * dy;
        if (d2 < r2 && fn(j, d2) === true) return;
      }
    }
  }
  const eachShop = (x, y, r, fn) => eachBucket(shopStart, shopItems, shops, x, y, r, fn);
  const eachProp = (x, y, r, fn) => eachBucket(propStart, propItems, props, x, y, r, fn);

  // straight walkable line (1.5 m steps)
  function los(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0, n = Math.ceil(Math.hypot(dx, dy) / 1.5);
    for (let s = 1; s < n; s++) if (!walkAt(x0 + dx * s / n, y0 + dy * s / n)) return false;
    return true;
  }
  // v1.5: a point up to `len` m away in roughly direction (fx, fy) reachable in a straight walkable line
  // (rays fanned out around the wish direction; the longest clear run wins, slightly preferring the wish).
  // Used for loot carriers so they run down the street instead of snagging on the first corner.
  const FAN = [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4, 2.0, -2.0, 2.6, -2.6, 3.14];
  function clearPoint(x, y, fx, fy, len, out) {
    const l = Math.hypot(fx, fy) || 1; fx /= l; fy /= l;
    let best = -1; out.x = x; out.y = y;
    for (const a of FAN) {
      const c = Math.cos(a), s = Math.sin(a), ux = fx * c - fy * s, uy = fx * s + fy * c;
      let d = 0; while (d < len && walkAt(x + ux * (d + 1.5), y + uy * (d + 1.5))) d += 1.5;
      const sc = d * (1 - Math.abs(a) * 0.1);
      if (sc > best) { best = sc; out.x = x + ux * d; out.y = y + uy * d; }
      if (d >= len) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- local flow fields (riot marches)
  // Dial's algorithm on a window of the nav grid around (x0,y0)-(tx,ty); far cheaper than a full-map field.
  const DXS = [1, -1, 0, 0, 1, 1, -1, -1], DYS = [0, 0, 1, -1, 1, -1, 1, -1], DC = [10, 10, 10, 10, 14, 14, 14, 14];
  const DVX = DXS.map((d, k) => d / Math.hypot(d, DYS[k])), DVY = DYS.map((d, k) => d / Math.hypot(DXS[k], d));
  const bk = Array.from({ length: 15 }, () => []);
  function localField(x0, y0, tx, ty, M = 60) {
    const t0 = performance.now();
    const t = nearestWalkable(Math.floor(tx / CELL), Math.floor(ty / CELL), 30);
    if (t < 0) return null;
    tx = cellX(t); ty = cellY(t);
    const MAXW = 520;
    let gx0 = Math.floor(Math.min(x0, tx) / CELL) - M, gx1 = Math.floor(Math.max(x0, tx) / CELL) + M;
    let gy0 = Math.floor(Math.min(y0, ty) / CELL) - M, gy1 = Math.floor(Math.max(y0, ty) / CELL) + M;
    const tcx = t % COLS, tcy = Math.floor(t / COLS);
    if (gx1 - gx0 > MAXW) { gx0 = Math.max(gx0, tcx - MAXW / 2); gx1 = gx0 + MAXW; }
    if (gy1 - gy0 > MAXW) { gy0 = Math.max(gy0, tcy - MAXW / 2); gy1 = gy0 + MAXW; }
    gx0 = Math.max(1, gx0); gy0 = Math.max(1, gy0); gx1 = Math.min(COLS - 2, gx1); gy1 = Math.min(ROWS - 2, gy1);
    const w = gx1 - gx0 + 1, h = gy1 - gy0 + 1;
    const dist = new Uint16Array(w * h).fill(65535);
    const lt = (tcy - gy0) * w + (tcx - gx0);
    dist[lt] = 0; bk[0].push(lt);
    let pending = 1, curd = 0;
    while (pending > 0) {
      const b = bk[curd % 15];
      while (b.length) {
        const c = b.pop(); pending--;
        if (dist[c] !== curd) continue;
        const cx = c % w, cy = (c - cx) / w, gc = (cy + gy0) * COLS + cx + gx0;
        for (let k = 0; k < 8; k++) {
          const nx = cx + DXS[k], ny = cy + DYS[k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (!walk[gc + DXS[k] + DYS[k] * COLS]) continue;
          if (k >= 4 && (!walk[gc + DXS[k]] || !walk[gc + DYS[k] * COLS])) continue;
          const n = ny * w + nx, nd = curd + DC[k];
          if (nd < dist[n] && nd < 65535) { dist[n] = nd; bk[nd % 15].push(n); pending++; }
        }
      }
      curd++;
    }
    stats.fieldMs += performance.now() - t0; stats.fields++;
    return { gx0, gy0, w, h, dist, tx, ty };
  }
  function lfDir(F, x, y, out) {
    const cx = Math.floor(x / CELL) - F.gx0, cy = Math.floor(y / CELL) - F.gy0;
    if (cx < 1 || cy < 1 || cx >= F.w - 1 || cy >= F.h - 1) return false;
    const c = cy * F.w + cx, d = F.dist[c];
    if (d === 65535) return false;
    if (d === 0) return sim.dirTo(x, y, F.tx, F.ty, out);
    let best = d, bkk = -1;
    for (let k = 0; k < 8; k++) { const n = c + DXS[k] + DYS[k] * F.w; if (F.dist[n] < best) { best = F.dist[n]; bkk = k; } }
    if (bkk < 0) return false;
    out.x = DVX[bkk]; out.y = DVY[bkk];
    return true;
  }
  const lfDist = (F, x, y) => {
    const cx = Math.floor(x / CELL) - F.gx0, cy = Math.floor(y / CELL) - F.gy0;
    if (cx < 0 || cy < 0 || cx >= F.w || cy >= F.h) return Infinity;
    const d = F.dist[cy * F.w + cx]; return d === 65535 ? Infinity : d * CELL / 10;
  };

  // ---------------------------------------------------------------- v1.6 agent navigation (bloc, looters, medics, throwers)
  // go(i, gx, gy, v): like steer(), but when the straight line to the goal is blocked (re-checked every ~0.8 s per
  // agent) the agent follows a small local flow field to the goal's cell, shared through a cache keyed by that cell
  // (NAV_TTL s, at most NAV_MAX fields, NAV_BUDGET new fields per substep), so nobody snags on corners.
  const NAV_TTL = 20, NAV_MAX = 96, NAV_BUDGET = 3, NAV_M = 10;
  const navCache = new Map(); let navBudget = NAV_BUDGET, curDt = 0.12;
  function los1(x0, y0, x1, y1) { // walkable straight line, 1 m steps
    const dx = x1 - x0, dy = y1 - y0, n = Math.ceil(Math.hypot(dx, dy));
    for (let s = 1; s < n; s++) if (!walkAt(x0 + dx * s / n, y0 + dy * s / n)) return false;
    return true;
  }
  function navField(x, y, gx, gy) {
    const key = sim.cellOf(gx, gy), T = sim.simTime;
    let e = navCache.get(key);
    if (e && T - e.t < NAV_TTL && lfDist(e.F, x, y) < Infinity) return e.F;
    if (navBudget <= 0) return null;
    navBudget--;
    const F = localField(x, y, gx, gy, NAV_M); if (!F) return null;
    if (navCache.size >= NAV_MAX) { let ok = null, ot = Infinity; for (const [k, v] of navCache) if (v.t < ot) { ot = v.t; ok = k; } navCache.delete(ok); }
    navCache.set(key, { F, t: T });
    return F;
  }
  function go(i, gx, gy, v) {
    const x = px[i], y = py[i], dx = gx - x, dy = gy - y, l = Math.hypot(dx, dy);
    if (l < 1e-3) { aiV[i] = 0; return 0; }
    if (l > 3 && l < 90) {
      if ((navT[i] -= curDt) <= 0) { navT[i] = 0.6 + rand() * 0.4; navM[i] = los1(x, y, gx, gy) ? 0 : 1; }
      if (navM[i]) { const F = navField(x, y, gx, gy); if (F && lfDir(F, x, y, tmp)) { aiX[i] = tmp.x; aiY[i] = tmp.y; aiV[i] = v; return l; } }
    }
    aiX[i] = dx / l; aiY[i] = dy / l; aiV[i] = v; return l;
  }

  // ---------------------------------------------------------------- v1.6 loot hotspots (looting comes in waves)
  // every grab / break-in warms a hotspot (merged within HOT_R); hotspots cool off after HOT_T s without looting.
  // Agents near a warm hotspot loot far more readily (contagion) and wandering people drift toward it (curiosity).
  const hot = [];
  function warmHot(x, y, w) {
    const T = sim.simTime;
    for (const h of hot) if (Math.abs(h.x - x) < HOT_R && Math.abs(h.y - y) < HOT_R) { h.x += (x - h.x) * 0.1; h.y += (y - h.y) * 0.1; h.w = Math.min(20, h.w + w); h.t = T; return; }
    if (hot.length < 48) hot.push({ x, y, w, t: T, t0: T });
  }
  function coolHot() { const T = sim.simTime; for (let k = hot.length - 1; k >= 0; k--) if (T - hot[k].t > HOT_T) hot.splice(k, 1); }
  function hotNear(x, y, r) { let best = null, bd = r * r; for (const h of hot) { const d2 = (h.x - x) ** 2 + (h.y - y) ** 2; if (d2 < bd) { bd = d2; best = h; } } return best; }
  // curiosity target for wandering people (crowd.js): a fire, a looting hotspot, a police line, or a shop front within r.
  // Writes {x, y, kind} into out and returns true, or false when there's nothing interesting nearby.
  function curiosity(x, y, r, out) {
    const opts = []; let tw = 0;
    const fr = sim.fires; if (fr) for (let n = 0; n < fr.length; n++) { const f = fr[n], d = Math.hypot(f.x - x, f.y - y); if (d < r * 1.3 && f.intensity > 0.2) { opts.push(['fire', f.x, f.y, f.r + 4 + rand() * 4, 2]); tw += 2; break; } }
    const h = hotNear(x, y, r * 1.6); if (h) { opts.push(['hot', h.x, h.y, 3 + rand() * 6, 2 + h.w * 0.2]); tw += 2 + h.w * 0.2; }
    if (nearestOfficer(x, y, r * 1.5) && noD > 10) { const sq = sim.squads[noS], ox = sq.ox[noK], oy = sq.oy[noK]; opts.push(['police', ox, oy, 12 + rand() * 10, 1.2]); tw += 1.2; }
    let sh = -1, n = 0; eachShop(x, y, Math.min(r, 30), j => { if (rand() * ++n < 1) sh = j; }); // reservoir pick: a random shop
    if (sh >= 0) { opts.push(['shop', shops[sh].x, shops[sh].y, 1.5 + rand() * 2, shops[sh].broken ? 1.5 : 0.8]); tw += shops[sh].broken ? 1.5 : 0.8; }
    if (!opts.length) return false;
    let q = rand() * tw, o = opts[opts.length - 1]; for (const p of opts) if ((q -= p[4]) <= 0) { o = p; break; }
    // stand off at distance o[3] on our side of it
    const dx = x - o[1], dy = y - o[2], l = Math.hypot(dx, dy) || 1, k = Math.min(1, o[3] / l);
    out.x = o[1] + dx * k; out.y = o[2] + dy * k; out.kind = o[0];
    return walkAt(out.x, out.y) || (out.x = o[1], out.y = o[2], walkAt(out.x, out.y));
  }

  // ---------------------------------------------------------------- police helpers
  let noS = -1, noK = -1, noD = 0;
  const offAlive = (sq, k) => k < sq.n && !(sq.hp && sq.hp[k] <= 0) && !(sq.down && sq.down[k]);
  function nearestOfficer(x, y, R) {
    const squads = sim.squads; let best = R * R; noS = -1;
    for (let s = 0; s < squads.length; s++) {
      const sq = squads[s], bb = sq.bb; if (sq.van) continue;
      if (bb && (x < bb[0] - R || x > bb[2] + R || y < bb[1] - R || y > bb[3] + R)) continue;
      for (let k = 0; k < sq.n; k++) {
        const dx = sq.ox[k] - x, dy = sq.oy[k] - y, d2 = dx * dx + dy * dy;
        if (d2 < best && offAlive(sq, k)) { best = d2; noS = s; noK = k; }
      }
    }
    noD = Math.sqrt(best);
    return noS >= 0;
  }
  function officerOf(t) { const sq = sim.squads[Math.floor(t / 1000)], k = t % 1000; return sq && offAlive(sq, k) ? sq : null; }

  // ---------------------------------------------------------------- misc helpers
  const phaseOk = () => { const ph = sim.day?.phase; return !ph || ph === 'day' || ph === 'dusk'; };
  const intensity = () => Math.min(1, sim.day?.intensity ?? sim.chaos ?? 1); // v1.6 (day system; 1 in sandbox)
  function defaultAct(i) { return riot[i] >= 0 ? MILL : lead[i] >= 0 ? FOLLOW : IDLE; }
  function endAction(i) { act[i] = defaultAct(i); tk[i] = TK_NONE; tgt[i] = -1; actT[i] = 0; carry[i] = 0; aiV[i] = 0; }
  function start(i, a, kind, t, gx, gy) { act[i] = a; tk[i] = kind; tgt[i] = t; tgX[i] = gx; tgY[i] = gy; actT[i] = 0; }
  function steer(i, gx, gy, v) {
    const dx = gx - px[i], dy = gy - py[i], l = Math.hypot(dx, dy);
    if (l < 1e-3) { aiV[i] = 0; return 0; }
    aiX[i] = dx / l; aiY[i] = dy / l; aiV[i] = v; return l;
  }
  // v1.5: molotovs come out with the afternoon heat (a bottle instead while sim.chaos is low)
  function pickBlocKind() { let r = rand(); for (const [k, p] of BLOC_KINDS) { if ((r -= p) < 0) return k === 'molotov' && rand() > intensity() ? 'bottle' : k; } return 'rock'; }
  function brawl(x, y) { if (brawlTok >= 1) { brawlTok -= 1; sim.emit('brawl', x, y); } stats.brawls++; }
  function tickTemper(i, dt, gas, contact) {
    // Heat-lite: relax to class baseline (tau 600 s), +gas, +police contact (docs/gauges.md §2.4)
    let a = aggr[i];
    a += dt * (CLS_BASE[cls[i]] - a) / 600 + 0.05 * gas * dt + (contact ? 0.01 * dt : 0);
    aggr[i] = clamp(a, 0, 1);
  }

  // ---------------------------------------------------------------- decision (every ~1-2 s per agent)
  let dShop = -1, dScore = 0, dProof = 0, dx0 = 0, dy0 = 0, dRich = false;
  function shopScan(j, d2) {
    const s = shops[j]; if (s.looted >= 1) return;
    if (sim.simTime - s.lastT < 30) dProof += 1 + s.looters; // v1.6: 15 -> 30 s
    if (dRich && s.v < 3) return;
    const sc = s.v * (1 - s.looted) * (s.broken ? 1.6 : 1) / (1 + Math.sqrt(d2) / 8);
    if (sc > dScore) { dScore = sc; dShop = j; }
  }
  function bestShop(x, y, r, rich) {
    dShop = -1; dScore = 0; dProof = 0; dx0 = x; dy0 = y; dRich = rich;
    eachShop(x, y, r, shopScan);
    if (dShop >= 0 && !los(x, y, shops[dShop].x, shops[dShop].y)) { dShop = -1; }
    return dShop;
  }
  let dDown = -1;
  function nearestDown(x, y, R) {
    let best = R * R; dDown = -1;
    for (let q = 0; q < nDown; q++) {
      const j = downIdx[q]; if (j >= sim.NA || act[j] !== DOWN) continue;
      const dx = px[j] - x, dy = py[j] - y, d2 = dx * dx + dy * dy;
      if (d2 < best && sim.simTime - claimT[j] > 2) { best = d2; dDown = j; }
    }
    return dDown;
  }
  let pProp = -1, pBest = 0, pWant = 0;
  function propScan(j, d2) {
    const p = props[j]; if (p.state !== 'ok' || (p._ig && sim.simTime - p._ig < 60)) return;
    const k = p.k; const ok = pWant === 1 ? (k === 'car' || k === 'bin' || k === 'scooter') : (k === 'construction' || k === 'bin' || k === 'bus_stop');
    if (ok && d2 < pBest) { pBest = d2; pProp = j; }
  }
  function nearestProp(x, y, r, want) { pProp = -1; pBest = r * r; pWant = want; eachProp(x, y, r, propScan); if (pProp >= 0 && !los(x, y, props[pProp].x, props[pProp].y)) pProp = -1; return pProp; }
  let encX = 0, encY = 0;
  function encFn(j) { encT[j] = 2.5; if (panicT[j] > 0) panicT[j] *= 0.6; }

  function decide(i, dtd) {
    const a = act[i];
    if (a === DOWN || a === ARRESTED || panicT[i] > 0 || carry[i]) return;
    const c = cls[i], x = px[i], y = py[i], L = lead[i], r = riot[i];
    sim.gasSample(x, y); const gas = sim.gs.s;
    const copNear = nearestOfficer(x, y, 45);
    tickTemper(i, dtd, gas, copNear && noD < 3);
    const ag = aggr[i];
    // leader stance multiplier for followers (riot members / bystanders: 1). Peaceful crowds don't loot or fight.
    let sm = 1;
    if (L >= 0 && r < 0) { const st = sim.leaders[L]?.stance; sm = st === 'peaceful' ? 0 : st === 'unleashed' ? STANCE_AGGR.unleashed : st === 'firm' ? STANCE_AGGR.firm : 1; }
    const aggrOk = sm > 0 && phaseOk() && gas < (c === BLACKBLOC ? 0.6 : 0.3);
    if (!aggrOk && c !== PACIFIST && a >= LOOT && a <= PUSH) { endAction(i); return; }
    // ongoing actions keep going until they finish (execute ends them), except a timeout re-check
    if (a >= LOOT && a <= HEAL && actT[i] < 25) {
      if (a === PUSH) { /* allow re-targeting below */ } else return;
    }
    const sq = copNear ? sim.squads[noS] : null, offT = copNear ? noS * 1000 + noK : -1;
    const ox = copNear ? sq.ox[noK] : 0, oy = copNear ? sq.oy[noK] : 0;

    // encouragers: aura (tighter following, shorter panic nearby)
    if (c === ENCOURAGER) forEachNear(x, y, 10, encFn);

    // medics: heal the nearest DOWN agent within 40 m
    if (c === MEDIC) {
      const j = nearestDown(x, y, 40);
      if (j >= 0) { claimT[j] = sim.simTime; start(i, HEAL, TK_AGENT, j, 0, 0); return; }
    }
    // pacifists: sit-in in front of a nearby police line (passive push)
    if (c === PACIFIST) {
      if (copNear && noD < 28 && (L >= 0 || r >= 0) && a !== PUSH && rand() < 0.5) { start(i, PUSH, TK_OFF, offT, ox, oy); return; }
      if (a === PUSH && (!copNear || noD > 35)) endAction(i);
      if (a !== PUSH && a >= LOOT && a !== MILL) endAction(i);
      return;
    }
    if (c === MEDIC || c === ENCOURAGER) {
      if (a >= LOOT && a <= HEAL && a !== HEAL) endAction(i);
      return;
    }
    if (!aggrOk) { if (a >= LOOT && a <= PUSH) endAction(i); return; }
    const isBloc = c === BLACKBLOC;
    const free = r >= 0 || L < 0;   // riot members and bystanders roam further than marching followers

    // v1.6 intensity ramp: confrontation and vandalism scale with sim.day.intensity (quiet mornings, hot afternoons,
    // hotter days). Riots start a bit warmer than marches. Bystanders don't loot or burn before BYS_HOUR (campaign).
    const I = intensity(), cf = r >= 0 ? 0.015 + 0.985 * I ** 1.2 : 0.005 + 0.995 * I ** 1.5;
    const bys = r < 0 && L < 0, bysOk = !bys || !sim.day?.managed || (sim.day.t ?? 0) >= BYS_HOUR * 3600;
    const rested = sim.simTime > aggT[i];
    // --- police: melee / throw / push ---
    if (copNear) {
      // v1.6 (user feedback): only some trade blows. Bloc and a few hot randos (aggr > FIGHT_AGGR) fight, rate-limited per
      // squad (takeFight); most people shove (PUSH) or back off; throwing is mostly bloc, rarely a hot rando, in short sessions.
      if (rested && noD < 2.5 && (isBloc ? rand() < FIGHT_BLOC_P * sm * cf : ag > FIGHT_AGGR && rand() < (ag - FIGHT_AGGR) * 1.2 * sm * cf) && takeFight(sq)) { start(i, FIGHT, TK_OFF, offT, ox, oy); return; }
      if (rested && isBloc && noD > 7 && noD < 40 && rand() < THROW_BLOC_P * sm * cf && los(x, y, ox, oy)) { start(i, THROW, TK_OFF, offT, ox, oy); nThrow[i] = 1 + Math.floor(rand() * (1 + 2 * I)); return; }
      if (rested && !isBloc && ag > THROW_HOT_AGGR && noD > 7 && noD < 30 && rand() < THROW_HOT_P * sm * cf && los(x, y, ox, oy)) { start(i, THROW, TK_OFF, offT, ox, oy); nThrow[i] = 1; return; }
      if (ag > 0.45 && noD < 12 && rand() < ag * sm) { start(i, PUSH, TK_OFF, offT, ox, oy); return; }
      // the rest keep their distance from a line they are not pushing (they back off when it gets close)
      if (!isBloc && noD < 5 && ag < 0.5 && rand() < 0.3) { sim.makePanic(i, 1.5 + rand() * 2.5, x - ox, y - oy); return; }
      // randos flee easily from a charge
      if (c === RANDO && ag < 0.5 && sq.state === 'charge' && noD < 15) { sim.makePanic(i, 4 + rand() * 6, x - ox, y - oy); return; }
    }
    if (a === PUSH) { if (!copNear || noD > 45) endAction(i); else return; }

    // --- black bloc: smash rich shops, burn / dismantle props (riots warm up; others need the afternoon heat) ---
    if (isBloc && bysOk) {
      const vand = (r >= 0 ? 0.05 + 0.95 * I : I) * sm;
      const s = bestShop(x, y, free ? 30 : 15, true);
      if (s >= 0 && !shops[s].smashed && rand() < 0.3 * ag * vand) { start(i, FIGHT, TK_SHOP, s, shops[s].x, shops[s].y); return; }
      if (rand() < PROP_P * ag * vand) {
        const want = rand() < 0.5 ? 1 : 2, p = nearestProp(x, y, free ? 25 : 12, want);
        if (p >= 0) { start(i, FIGHT, TK_PROP, p, props[p].x, props[p].y); return; }
      }
    }
    // --- looting (randos mostly; bloc sometimes), contagious via social proof; each looter rests between grabs ---
    // v1.6 waves: with no looting nearby a start is rare (LOOT_SEED); next to fresh looting / a warm hotspot it is
    // LOOT_PROOF + n times likelier, so looting spreads around hotspots instead of popping up everywhere.
    if ((c === RANDO || isBloc) && bysOk && sim.simTime > lootT[i]) {
      const s = bestShop(x, y, free ? 25 : 14, false);
      if (s >= 0) {
        const h = hotNear(x, y, 45), proofN = dProof + (h ? h.w * 0.25 : 0);
        const proof = proofN > 0 ? LOOT_PROOF + Math.min(4, proofN) : LOOT_SEED;
        let p = (0.003 + 0.08 * ag * ag) * Math.min(2, dScore) * proof;
        if (r >= 0) p *= 1.2 * (0.02 + 0.98 * I ** 1.5);                              // riots warm up
        else if (L >= 0) p *= I * I * (LOOT_STANCE[sim.leaders[L]?.stance] ?? 0.3);    // marchers: by stance
        else p *= proofN > 0 ? 0.6 * I * I : 0;                                        // bystanders only join a wave
        if (isBloc) p *= 0.3;
        if (rand() < p * dtd) { start(i, LOOT, TK_SHOP, s, shops[s].x, shops[s].y); return; }
      }
    }
  }
  // v1.6 per-squad brawl limiter: a squad takes on a new brawler only every FIGHT_TOK_T s (bucket FIGHT_TOK_MAX) and
  // never more than FIGHT_MAX at once (sq.brawlers is recounted every substep in update()).
  function takeFight(sq) {
    const T = sim.simTime;
    // v1.7: the token rate and the cap scale with the day's intensity (v1.6: a flat token per 20 s per squad, so day 1 at 08:15
    // already had dozens of brawls: the token bucket, not the per-agent chance, was the binding limit)
    const I = intensity();
    sq.fightTok = Math.min(FIGHT_TOK_MAX, (sq.fightTok ?? 1) + (T - (sq.fightTokT ?? T)) * (0.06 + 0.94 * I) / FIGHT_TOK_T); sq.fightTokT = T;
    if (sq.fightTok < 1 || (sq.brawlers || 0) >= (I < 0.45 ? 1 : FIGHT_MAX)) return false;
    sq.fightTok -= 1; sq.brawlers = (sq.brawlers || 0) + 1;
    return true;
  }
  function rest(i, k) { aggT[i] = sim.simTime + AGG_REST * k * (1.5 - intensity()) * (0.6 + 0.8 * rand()); }

  // ---------------------------------------------------------------- execution (every substep)
  function execute(i, dt) {
    const a = act[i], x = px[i], y = py[i];
    actT[i] += dt;
    const sp = v0[i];
    if (carry[i]) {               // looter running off with the goods
      const L = lead[i], back = carry[i] === 1 && L >= 0 && sim.leaders[L] && !sim.leaders[L].arrested && !sim.leaders[L].gone;
      if (back) { tgX[i] = sim.leaders[L].x; tgY[i] = sim.leaders[L].y; } // marchers carry it back into the march
      const d = back ? go(i, tgX[i], tgY[i], sp * 1.2) : steer(i, tgX[i], tgY[i], sp * 1.35); // v1.6: back to the leader around corners
      if (actT[i] > (back ? 25 : 30) || d < (back ? 10 : 3)) {
        if (carry[i] === 2) { sim.removeAgent(i); sim.dispersedHome++; stats.lootHome++; }
        else endAction(i);
      }
      return;
    }
    switch (a) {
      case LOOT: {
        const s = shops[tgt[i]];
        if (!s || s.looted >= 1 || actT[i] > 60) { endAction(i); return; }
        const d = go(i, s.x, s.y, sp * 1.15);
        if (d < 2.8) {
          aiV[i] = 0;
          s.lastT = sim.simTime; if (s.looters++ === 0) activeShops.push(s);
          if (!s.broken) {
            s.breakT += dt * (cls[i] === BLACKBLOC ? 2 : 1);
            if (s.breakT >= BREAK_T) { s.broken = true; stats.shatters++; warmHot(s.x, s.y, 2); sim.emit('shatter', s.ox ?? s.x, s.oy ?? s.y, { shop: tgt[i] }); }
            return;
          }
          if (cd[i] <= 0) cd[i] = GRAB_T0 + rand() * GRAB_T1;   // grab time for this looter
          else if (cd[i] <= dt * 1.5) {
            s.looted = Math.min(1, s.looted + 1 / (GRAB_FRAC * s.v));
            stats.grabs++; aggr[i] = Math.max(0, aggr[i] - 0.1);
            lootT[i] = sim.simTime + LOOT_REST + rand() * 90;
            warmHot(s.x, s.y, 1);
            sim.emit('loot', x, y, { shop: tgt[i] });
            const kind = riot[i] >= 0 ? 'riot' : lead[i] >= 0 ? 'follower' : 'bystander';
            const home = rand() < HOME_P[kind];
            // carry away: marchers back to their leader; others away from the nearest cops (else at random),
            // along a clear straight run of street (no snagging on corners)
            let fx = rand() - 0.5, fy = rand() - 0.5;
            if (nearestOfficer(x, y, 120)) { const sq = sim.squads[noS]; fx = x - sq.ox[noK]; fy = y - sq.oy[noK]; }
            clearPoint(x, y, fx, fy, home ? 70 : 35, tmp);
            tgX[i] = tmp.x; tgY[i] = tmp.y;
            carry[i] = home ? 2 : 1; actT[i] = 0;
            if (home) { lead[i] = -1; riot[i] = -1; }
          }
        }
        return;
      }
      case HEAL: {
        const j = tgt[i];
        if (j < 0 || j >= sim.NA || act[j] !== DOWN || actT[i] > 40) { endAction(i); return; }
        claimT[j] = sim.simTime;
        const d = go(i, px[j], py[j], sp * 1.2);
        if (d < 1.9) {
          aiV[i] = 0;
          if ((tgX[i] += dt) >= 8) { // tgX is reused as the heal progress once adjacent
            const f = sim.api.healAgent;
            if (f) f(j, 1);
            if (act[j] === DOWN) { hp[j] = Math.max(hp[j], 0.6); act[j] = lead[j] >= 0 ? FOLLOW : riot[j] >= 0 ? MILL : IDLE; }
            stats.heals++; endAction(i);
          }
        } else tgX[i] = 0;
        return;
      }
      case THROW: {
        const sq = officerOf(tgt[i]);
        if (!sq || actT[i] > 45 || nThrow[i] === 0) { endAction(i); rest(i, 1); return; }
        const k = tgt[i] % 1000, ox = sq.ox[k], oy = sq.oy[k], d = Math.hypot(ox - x, oy - y);
        if (d > 50) { endAction(i); return; }
        const want = cls[i] === BLACKBLOC ? 20 : 24;
        if (d > want + 8) go(i, ox, oy, sp);
        else if (d < want - 6) { steer(i, ox, oy, 0); aiX[i] = -aiX[i]; aiY[i] = -aiY[i]; aiV[i] = sp * 0.8; }
        else { steer(i, ox, oy, 0); aiV[i] = 0; }
        if (cd[i] <= 0 && d >= 10 && d <= 42) {
          const bloc = cls[i] === BLACKBLOC;
          const kind = bloc ? pickBlocKind() : (rand() < 0.6 ? 'rock' : 'bottle');
          const sc = d * 0.08;
          sim.api.throwProjectile?.(kind, x, y, ox + (rand() - 0.5) * sc, oy + (rand() - 0.5) * sc, 'C', i); // combat emits 'throw'
          stats.throws++; if (nThrow[i] > 0) nThrow[i]--;
          cd[i] = bloc ? 4.5 + rand() * 5 : 8 + rand() * 8; // v1.5: was 3-7 s / 6-12 s
        }
        return;
      }
      case FIGHT: {
        const kind = tk[i];
        if (kind === TK_OFF) {
          const sq = officerOf(tgt[i]);
          if (!sq || actT[i] > FIGHT_T) { endAction(i); rest(i, 1.5); return; } // v1.6: brawls last <= FIGHT_T s (was 25), then a rest
          const k = tgt[i] % 1000, d = go(i, sq.ox[k], sq.oy[k], sp * 1.3);
          if (d > 30) { endAction(i); return; }
          if (d < 1.7 && cd[i] <= 0) {
            cd[i] = 2 + rand() * 2.5; brawl(x, y); // v1.5: swings every 2-4.5 s (was 1.2-2.7)
            aggr[i] = Math.min(1, aggr[i] + 0.01);
            if (rand() < MELEE_P) sim.api.hitOfficer?.(sq, k, 0.06 + rand() * 0.08, 'melee');
          }
        } else if (kind === TK_SHOP) {
          const s = shops[tgt[i]];
          if (!s || s.smashed || actT[i] > 40) { endAction(i); return; }
          const d = go(i, s.x, s.y, sp * 1.15);
          if (d < 2.8) {
            aiV[i] = 0; s.breakT += dt * 1.5;
            if (s.breakT >= 3) {
              s.smashed = true; stats.smashes++;
              if (!s.broken) { s.broken = true; stats.shatters++; }
              sim.emit('shatter', s.ox ?? s.x, s.oy ?? s.y, { shop: tgt[i], smash: 1 });
              s.lastT = sim.simTime; warmHot(s.x, s.y, 2);
              if (rand() < 0.06 * intensity() && !s.burning) { // v1.6: 0.08 x min(1, 0.3 + chaos) -> 0.06 x intensity (combat's ignite marks the shop burning)
                stats.ignites++;
                if (sim.api.ignite) sim.api.ignite(s.x, s.y, 'shop', 4); else s.burning = true;
              }
              aggr[i] = Math.max(0, aggr[i] - 0.05);
              endAction(i);
            }
          }
        } else if (kind === TK_PROP) {
          const p = props[tgt[i]];
          if (!p || p.state !== 'ok' || actT[i] > 30) { endAction(i); return; }
          const d = go(i, p.x, p.y, sp * 1.1);
          if (d < 2.2) {
            aiV[i] = 0;
            if (actT[i] > 2.5 && cd[i] <= 0) {
              // v1.6: burning needs heat (was car 0.55, bin 0.6, scooter 1): otherwise the prop is smashed / dragged into a barricade
              const I = intensity(), burnable = rand() < (p.k === 'car' ? 0.15 + 0.35 * I : p.k === 'scooter' ? 0.3 + 0.5 * I : 0.2 + 0.4 * I);
              if (burnable) { p._ig = sim.simTime; stats.ignites++; sim.api.ignite?.(p.x, p.y, p.k === 'car' ? 'car' : 'bin'); }
              else { p.state = 'used'; stats.barricades++; sim.emit('barricade', p.x, p.y, { k: p.k }); }
              endAction(i);
            }
          }
        } else endAction(i);
        return;
      }
      case PUSH: {
        const sq = officerOf(tgt[i]);
        if (!sq || actT[i] > (cls[i] === PACIFIST ? 90 : 35)) { endAction(i); return; }
        const k = tgt[i] % 1000, ox = sq.ox[k], oy = sq.oy[k];
        if (cls[i] === PACIFIST) {
          // stand / sit about 1.4 m in front of the line, leaning on it gently
          const d = steer(i, ox, oy, 0.9);
          if (d < 1.6) aiV[i] = 0.25;
          if (d > 40) endAction(i);
        } else {
          const d = go(i, ox, oy, sp * (1 + aggr[i]));
          if (d > 25) endAction(i);
        }
        return;
      }
      case MILL: {
        const R = riots[riot[i]];
        if (!R || !R.alive) { riot[i] = -1; endAction(i); return; }
        // v1.6 roaming: while milling, members drift around the riot's spot (MILL_ROAM x spread, plus curiosity trips
        // picked in update()) and only walk back beyond MILL_BACK x spread; on the march they keep together.
        const dR = Math.hypot(R.tx - x, R.ty - y), back = R.state === 'march' ? R.spread : R.spread * MILL_BACK;
        if (dR > back) {
          if (R.field && lfDir(R.field, x, y, tmp)) { aiX[i] = tmp.x; aiY[i] = tmp.y; aiV[i] = sp * (dR > back * 2 ? 1 : 0.7); }
          else go(i, R.tx, R.ty, sp * 0.8);
        } else {
          const d = Math.hypot(tgX[i] - x, tgY[i] - y);
          if (d > 1.5) go(i, tgX[i], tgY[i], wSpd(i)); else aiV[i] = 0;
        }
        return;
      }
      default: return;
    }
  }

  // ---------------------------------------------------------------- riots
  function spawnRiot(x, y, n, opts = {}) {
    const id = riots.length;
    const mix = opts.mix || RIOT_MIX, cum = []; let acc = 0; for (const m of mix) cum.push(acc += m);
    const R = { id, x, y, count: 0, n0: 0, aggr: 0, controlledBy: -1, target: { x, y, kind: 'spawn' }, tx: x, ty: y,
      spread: 8, state: 'mill', stateT: 20 + rand() * 30, field: null, fieldT: -1e9, thinkT: rand() * 3, alive: true,
      conv: new Map(), name: opts.name || null, convL: -1 };
    riots.push(R);
    if (!walkAt(x, y)) { const c = nearestWalkable(Math.floor(x / CELL), Math.floor(y / CELL), 40); if (c >= 0) { x = cellX(c); y = cellY(c); R.x = R.tx = x; R.y = R.ty = y; } }
    const rad = Math.sqrt(n) * 1.1 + 5;
    let made = 0, tries = 0;
    while (made < n && tries < n * 40) {
      tries++;
      const ang = rand() * Math.PI * 2, d = Math.sqrt(rand()) * rad * (1 + tries / (n * 8));
      const sx = x + Math.cos(ang) * d, sy = y + Math.sin(ang) * d;
      if (!walkAt(sx, sy)) continue;
      const r = rand(); let c = 0; while (c < 4 && r >= cum[c]) c++;
      const ag = clamp((opts.aggr ?? (CLS_BASE[c] + 0.15)) + (rand() - 0.5) * 0.2, 0, 1);
      const i = sim.addAgent(sx, sy, { lead: -1, cls: c, riot: id, aggr: ag });
      if (i < 0) break;
      act[i] = MILL; tgX[i] = sx; tgY[i] = sy; thinkT[i] = 0.2 + rand() * 1.5;
      made++;
    }
    R.count = R.n0 = made; R.spread = Math.sqrt(made) * 1.0 + 6;
    return id;
  }
  function spawnCrowd(x, y, n, leaderId) { return sim.spawnAround(x, y, n, leaderId ?? -1); }

  // riot brain: pick targets of opportunity, march along a cached local field, then mill
  function chooseTarget(R) {
    const opts = [], aggrOk = phaseOk();
    if (aggrOk) {
      dShop = -1; dScore = 0; dRich = true; let best = -1, bd = 1e18;
      eachShop(R.x, R.y, 220, (j, d2) => { const s = shops[j]; if (s.v >= 2 && s.looted < 0.7 && d2 > 400 && d2 < bd) { bd = d2; best = j; } });
      if (best >= 0) opts.push({ w: 3 * R.aggr, x: shops[best].x, y: shops[best].y, kind: 'shop', ref: best });
      if (nearestOfficer(R.x, R.y, 260) && noD > 30) {
        const sq = sim.squads[noS], ox = sq.ox[noK], oy = sq.oy[noK], l = noD;
        opts.push({ w: 2.5 * R.aggr, x: ox + (R.x - ox) / l * 24, y: oy + (R.y - oy) / l * 24, kind: 'police', ref: sq.id });
      }
      for (const f of sim.fires || []) { const d = Math.hypot(f.x - R.x, f.y - R.y); if (d > 30 && d < 200) { opts.push({ w: 0.7, x: f.x, y: f.y, kind: 'fire' }); break; } }
    }
    const pts = sim.data.riotSpawns || [];
    for (const p of pts) { const d = Math.hypot(p.x - R.x, p.y - R.y); if (d > 60 && d < 520) opts.push({ w: 0.6, x: p.x, y: p.y, kind: 'square' }); }
    if (!opts.length) return null;
    let tw = 0; for (const o of opts) tw += o.w;
    let q = rand() * tw; for (const o of opts) if ((q -= o.w) <= 0) return o;
    return opts[opts.length - 1];
  }
  let fieldBudget = 1;
  function riotThink(R, dt) {
    R.stateT -= dt;
    if (R.convL >= 0) return; // being won over: stay put
    if (R.state === 'march') {
      const d = Math.hypot(R.tx - R.x, R.ty - R.y);
      if (d < R.spread * 1.2 || R.stateT <= 0) { R.state = 'mill'; R.stateT = 25 + rand() * 50; }
    } else if (R.stateT <= 0 && fieldBudget > 0 && sim.simTime - R.fieldT >= FIELD_MIN_T) {
      const o = chooseTarget(R);
      if (!o) { R.stateT = 30; return; }
      fieldBudget--;
      const F = localField(R.x, R.y, o.x, o.y);
      R.fieldT = sim.simTime;
      if (!F || lfDist(F, R.x, R.y) === Infinity) { R.stateT = 20; return; }
      R.field = F; R.tx = F.tx; R.ty = F.ty; R.target = { x: F.tx, y: F.ty, kind: o.kind, ref: o.ref };
      R.state = 'march'; R.stateT = 240;
    }
  }

  // ---------------------------------------------------------------- update
  const rsx = [], rsy = [], rn = [], ra = [];
  let nearCnt = new Int32Array(64);
  // v1.6: a riot member's next mill spot: mostly a random point within MILL_ROAM x spread of the riot's spot, sometimes a
  // curiosity trip (a fire, a looting hotspot, a police line, a shop front) as long as it stays inside the roam area
  const cur = { x: 0, y: 0, kind: '' };
  function millPick(i, R) {
    const roam = R.spread * MILL_ROAM;
    if (rand() < MILL_CURIOUS && curiosity(px[i], py[i], 35, cur) && Math.hypot(cur.x - R.tx, cur.y - R.ty) < R.spread * MILL_BACK * 0.9) { tgX[i] = cur.x; tgY[i] = cur.y; return; }
    for (let t = 0; t < 4; t++) {
      const ang = rand() * 6.283, d = Math.sqrt(rand()) * roam, gx = R.tx + Math.cos(ang) * d, gy = R.ty + Math.sin(ang) * d;
      if (walkAt(gx, gy)) { tgX[i] = gx; tgY[i] = gy; return; }
    }
  }
  const wSpd = i => 0.35 + (v0[i] - 1.2) * 1.4; // strolling speed 0.35..0.85 m/s
  function update(dt) {
    curDt = dt; navBudget = NAV_BUDGET;
    if ((coolT -= dt) <= 0) { coolT = 1; coolHot(); }
    for (const sq of sim.squads) { sq.brawlers = sq.brawlAcc || 0; sq.brawlAcc = 0; }
    if (!booted) {
      booted = true;
      if (!sim.day?.managed) for (const p of sim.data.riotSpawns || []) spawnRiot(p.x, p.y, p.n);
    }
    const NA = sim.NA, leaders = sim.leaders, nL = leaders.length, nR = riots.length;
    brawlTok = Math.min(2, brawlTok + dt * BRAWL_FX_RATE);
    fieldBudget = 1;
    for (let r = 0; r < nR; r++) { rsx[r] = rsy[r] = rn[r] = ra[r] = 0; }
    if (nearCnt.length < nR * Math.max(1, nL)) nearCnt = new Int32Array(nR * nL * 2);
    nearCnt.fill(0, 0, nR * nL);
    // shops touched last substep: reset their looter counters (recounted by LOOT agents below)
    for (const s of activeShops) s.looters = 0;
    activeShops.length = 0;
    if (sim.props && sim.props !== props) { props = sim.props; [propStart, propItems] = buildBuckets(props); }
    // DOWN list double buffer
    if (downBuf.length < NA) downBuf = new Int32Array(sim.MAXA);
    nDownBuf = 0;

    for (let i = 0; i < NA; i++) {
      const a = act[i];
      if (a === DOWN) { downBuf[nDownBuf++] = i; continue; }
      if (a === ARRESTED || a === HOME) continue; // v1.5: dusk leavers just walk home
      if (encT[i] > 0) encT[i] -= dt;
      const r = riot[i];
      if (r >= 0) {
        const R = riots[r];
        if (R) {
          rsx[r] += px[i]; rsy[r] += py[i]; rn[r]++; ra[r] += aggr[i];
          for (let l = 0; l < nL; l++) { const Ld = leaders[l]; if (Ld.arrested) continue; const ex = px[i] - Ld.x, ey = py[i] - Ld.y; if (ex * ex + ey * ey < 625) nearCnt[r * nL + l]++; }
          // progressive conversion toward the leader winning this riot over
          const L = R.convL;
          if (L >= 0 && panicT[i] <= 0) {
            const Ld = leaders[L], d = Math.hypot(px[i] - Ld.x, py[i] - Ld.y);
            const p = R.controlledBy === L ? (d < 160 ? 0.15 : 0.04) : d < 40 ? 0.08 : d < 90 ? 0.03 : 0.01;
            if (rand() < p * dt) {
              riot[i] = -1; lead[i] = L; stats.converted++;
              R.conv.set(L, (R.conv.get(L) || 0) + 1);
              if (act[i] === MILL || act[i] === IDLE) { act[i] = FOLLOW; tk[i] = TK_NONE; tgt[i] = -1; aiV[i] = 0; }
            }
          }
        }
      }
      // decisions (staggered)
      let tt = thinkT[i];
      if (tt === 0) tt = thinkT[i] = 0.05 + rand() * 1.5;
      tt -= dt;
      if (tt <= 0) {
        const dtd = 1 + rand() * 0.8;
        thinkT[i] = dtd;
        if (a === MILL && riot[i] >= 0) { const R = riots[riot[i]]; if (R && rand() < (Math.hypot(tgX[i] - px[i], tgY[i] - py[i]) < 2 ? 0.35 : 0.06)) millPick(i, R); }
        if (riot[i] >= 0 && act[i] <= FLEE && panicT[i] <= 0) act[i] = MILL;
        decide(i, dtd);
      } else thinkT[i] = tt;
      const a2 = act[i];
      if (a2 === FIGHT && tk[i] === TK_OFF) { const sq = sim.squads[Math.floor(tgt[i] / 1000)]; if (sq) sq.brawlAcc = (sq.brawlAcc || 0) + 1; }
      if ((a2 >= LOOT && a2 <= MILL) || carry[i]) { if (panicT[i] > 0) { carry[i] = 0; continue; } execute(i, dt); }
      else if (a2 === FLEE && carry[i] === 0 && tk[i] !== TK_NONE) { tk[i] = TK_NONE; tgt[i] = -1; }
    }
    // swap down buffers
    { const t = downIdx; downIdx = downBuf; downBuf = t; nDown = nDownBuf; }

    // riots: centroids, conversion state, brain
    for (let r = 0; r < nR; r++) {
      const R = riots[r]; if (!R.alive) continue;
      R.count = rn[r];
      if (rn[r] > 0) { R.x = rsx[r] / rn[r]; R.y = rsy[r] / rn[r]; R.aggr = ra[r] / rn[r]; }
      R.spread = Math.sqrt(Math.max(1, rn[r])) * 1.0 + 6;
      // who is winning it over?
      let cand = -1, cs = 0;
      for (let l = 0; l < nL; l++) {
        const Ld = leaders[l]; if (Ld.arrested) continue;
        const d = Math.hypot(Ld.x - R.x, Ld.y - R.y), near = nearCnt[r * nL + l];
        const s = (d < 60 ? 2 : 0) + (near >= 8 ? 1 + near / 20 : 0);
        if (s > cs) { cs = s; cand = l; }
      }
      if (cand < 0 && R.controlledBy >= 0 && !leaders[R.controlledBy]?.arrested) cand = R.controlledBy;
      R.convL = cand;
      // v1.5: the leader who converted the most takes control, once (two leaders used to toggle control every substep,
      // emitting riotJoined each time)
      let topL = -1, topN = 0;
      for (const [L, n] of R.conv) if (n > topN) { topN = n; topL = L; }
      if (topL >= 0 && topN > R.count && R.controlledBy !== topL && !(R.joined ||= new Set()).has(topL)) {
        R.controlledBy = topL; R.joined.add(topL); stats.riotsJoined++;
        sim.emit('riotJoined', R.x, R.y, { riot: R.id, leader: topL, n: topN + R.count });
      }
      if (R.count < 4 && R.n0 > 0) {
        // dissolve: stragglers join the controller or become bystanders
        // v1.6: never hand them to an arrested / gone controller (that re-attached people to arrested leaders)
        const ctl = R.controlledBy >= 0 && leaders[R.controlledBy] && !leaders[R.controlledBy].arrested && !leaders[R.controlledBy].gone ? R.controlledBy : -1;
        for (let i = 0; i < NA; i++) if (riot[i] === r) { riot[i] = -1; lead[i] = ctl; if (act[i] === MILL) act[i] = ctl >= 0 ? FOLLOW : IDLE; }
        R.alive = false; R.count = 0; continue;
      }
      R.thinkT -= dt;
      if (R.thinkT <= 0) { riotThink(R, 2 - R.thinkT); R.thinkT = 2; }
    }
  }

  function makeShop(s, idx) {
    return { x: s.x, y: s.y, k: s.k, n: s.n, v: s.v || 1, ox: s.ox, oy: s.oy, looted: 0, burning: false,
      broken: false, smashed: false, breakT: 0, lastT: -1e9, looters: 0, idx };
  }

  sim.api.spawnRiot = spawnRiot;
  // v1.6: day reset (day.js calls it when present): riots, loot hotspots and the nav cache start fresh each morning
  sim.api.resetRiots = () => { riots.length = 0; hot.length = 0; navCache.clear(); };
  sim.api.spawnCrowd = spawnCrowd;
  sim.crowdAI = {
    stats,
    // act histogram: { IDLE: n, FOLLOW: n, ... }
    histogram() {
      const names = Object.keys(ACT), h = {};
      for (let i = 0; i < sim.NA; i++) { const n = names[act[i]]; h[n] = (h[n] || 0) + 1; }
      return h;
    },
    lootedShops: () => shops.reduce((n, s) => n + (s.looted > 0 ? 1 : 0), 0),
    localField, lfDir,
    // v1.6: loot hotspots [{x, y, w (warmth), t (last loot), t0}], curiosity targets for wandering people, local-field nav cache
    hot, hotNear, curiosity, navCacheSize: () => navCache.size,
  };

  return {
    name: 'riots',
    init() {
      riots = sim.riots = [];
      shops = sim.shops = (sim.data.shops || []).map(makeShop);
      [shopStart, shopItems] = buildBuckets(shops);
      props = []; [propStart, propItems] = buildBuckets(props); // sim.props (combat) is indexed on the first update
    },
    update,
  };
}
