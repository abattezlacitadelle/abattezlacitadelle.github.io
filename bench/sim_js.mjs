// JS crowd-sim benchmark runner (Node). Port of the crowd core of src/sim.js (snapshot 2026-10-17 21:18).
// Usage: node bench/sim_js.mjs [S1|S2|S3|all] [--warmup 200] [--steps 2000] [--fields 10] [--out bench/results/js.json]
//
// Faithful to src/sim.js: same constants, typed arrays, hash, flow field (Dial), fieldDir/fieldDist,
// stepAgents (social force, viscosity, Weidmann fw, attachment + votes, gas sample + steering, wall push,
// leader parting, integrate + wall collision), updateLeaders (density/gas/energy speed, moveWithWalls).
// Deliberate differences (identical in every port):
//   - Math.random -> per-agent xorshift32 (state in the fixture; rnd(i) advances agent i's state only), so
//     results do not depend on iteration order or thread count. Leaders do not use randomness.
//   - Police squads removed (they are a per-agent bounding-box test that is false for almost everyone).
//   - Gas is a static field from the fixture (no diffusion update, no emitters/puffs). The sample and the
//     gradient/steering math still run per agent. Peak 0.35 < 0.4, so nobody panics or goes home.
//   - MAXA is the scenario size (the game caps at 16000).
//   - step() = buildHash(); updateLeaders(dt); stepAgents(dt)  (police/gas/puff updates dropped).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function loadFixture(file) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dv = new DataView(ab);
  if (dv.getUint32(0, true) !== 0x31425352) throw new Error('bad fixture magic');
  const F = {
    W: dv.getFloat64(8, true), H: dv.getFloat64(16, true),
    CELL: dv.getUint32(24, true), COLS: dv.getUint32(28, true), ROWS: dv.getUint32(32, true),
    GC: dv.getUint32(36, true), GCOLS: dv.getUint32(40, true), GROWS: dv.getUint32(44, true),
    nL: dv.getUint32(48, true), N: dv.getUint32(52, true),
    goal: [dv.getFloat64(56, true), dv.getFloat64(64, true)], seed: dv.getUint32(72, true),
  };
  const NC = F.COLS * F.ROWS, GN = F.GCOLS * F.GROWS, N = F.N;
  let o = 128;
  F.leaders = [];
  for (let l = 0; l < F.nL; l++) { F.leaders.push([dv.getFloat64(o, true), dv.getFloat64(o + 8, true)]); o += 16; }
  const take = (T, n) => { const a = new T(ab.slice(o, o + n * T.BYTES_PER_ELEMENT)); o += n * T.BYTES_PER_ELEMENT; return a; };
  F.gas = take(Float32Array, GN);
  F.px = take(Float32Array, N); F.py = take(Float32Array, N); F.v0 = take(Float32Array, N);
  F.rng = take(Uint32Array, N); F.lead = take(Int32Array, N);
  F.walk = take(Uint8Array, NC); F.clear = take(Uint8Array, NC); F.gwalk = take(Uint8Array, GN);
  return F;
}

export function createBenchSim(FX) {
  const W = FX.W, H = FX.H;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  // ---------------- nav grid ----------------
  const CELL = FX.CELL, COLS = FX.COLS, ROWS = FX.ROWS, NC = COLS * ROWS;
  const walk = FX.walk, clear = FX.clear;
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

  // ---------------- flow field (Dial, 8-connected, no corner cutting) ----------------
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

  // ---------------- agents ----------------
  let NA = FX.N;
  const MAXA = NA;
  const px = Float32Array.from(FX.px), py = Float32Array.from(FX.py), vx = new Float32Array(MAXA), vy = new Float32Array(MAXA);
  const v0 = Float32Array.from(FX.v0), panicT = new Float32Array(MAXA), fleeX = new Float32Array(MAXA), fleeY = new Float32Array(MAXA);
  const lead = new Int16Array(MAXA), gone = new Uint8Array(MAXA), rng = Uint32Array.from(FX.rng);
  for (let i = 0; i < NA; i++) lead[i] = FX.lead[i];
  // per-agent xorshift32 (replaces Math.random)
  function rnd(i) { let s = rng[i]; s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; rng[i] = s; return s / 4294967296; }
  function copyAgent(f, t) {
    px[t] = px[f]; py[t] = py[f]; vx[t] = vx[f]; vy[t] = vy[f]; v0[t] = v0[f]; rng[t] = rng[f];
    panicT[t] = panicT[f]; fleeX[t] = fleeX[f]; fleeY[t] = fleeY[f]; lead[t] = lead[f]; gone[t] = gone[f];
  }
  function makePanic(i, t, fx, fy) {
    panicT[i] = Math.max(panicT[i], t); lead[i] = -1;
    const l = Math.hypot(fx, fy) || 1; fleeX[i] = fx / l; fleeY[i] = fy / l;
  }

  // spatial hash (counting sort)
  const HC = 2.0, HSIZE = 1 << 17, HMASK = HSIZE - 1;
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

  // ---------------- gas (static field, same sampler) ----------------
  const GC = FX.GC, GCOLS = FX.GCOLS, GROWS = FX.GROWS;
  const gas = FX.gas, gwalk = FX.gwalk;
  let gS = 0, gGX = 0, gGY = 0;
  function gasSample(x, y) {
    const i = Math.floor(x / GC), j = Math.floor(y / GC);
    if (i < 1 || j < 1 || i >= GCOLS - 1 || j >= GROWS - 1) { gS = gGX = gGY = 0; return; }
    const k = j * GCOLS + i;
    gS = gas[k];
    if (gS < 0.01) { gGX = gGY = 0; return; }
    const c = gS, l = gwalk[k - 1] ? gas[k - 1] : c, r = gwalk[k + 1] ? gas[k + 1] : c, d = gwalk[k - GCOLS] ? gas[k - GCOLS] : c, u = gwalk[k + GCOLS] ? gas[k + GCOLS] : c;
    gGX = (r - l) / (2 * GC); gGY = (u - d) / (2 * GC);
  }

  // ---------------- leaders ----------------
  const leaders = [];
  function addLeader(x, y) {
    if (!walkAt(x, y)) { const c = nearestWalkable(Math.floor(x / CELL), Math.floor(y / CELL), 60); if (c < 0) return null; x = cellX(c); y = cellY(c); }
    const L = { id: leaders.length, x, y, field: null, prog: 0, arrived: true, count: 0, newCount: 0, energy: 100, speed: 0 };
    leaders.push(L);
    return L;
  }
  function orderLeaders(F) { for (const L of leaders) { L.field = F; L.arrived = false; } }
  function dirTo(x, y, tx, ty, out) { const dx = tx - x, dy = ty - y, l = Math.hypot(dx, dy); if (l < 1e-3) return false; out.x = dx / l; out.y = dy / l; return true; }
  function moveWithWalls(o, dx, dy) {
    const nx = o.x + dx, ny = o.y + dy;
    if (walkAt(nx, ny)) { o.x = nx; o.y = ny; }
    else if (walkAt(nx, o.y)) o.x = nx;
    else if (walkAt(o.x, ny)) o.y = ny;
  }
  function updateLeaders(dt) {
    for (const L of leaders) {
      const F = L.field;
      L.prog = F ? fieldDist(F, L.x, L.y) : 0;
      let moving = false;
      if (F && !L.arrived) {
        if (L.prog < 2.5) L.arrived = true;
        else {
          const nearCrowd = countNear(L.x, L.y, 1.5);
          const rho = (nearCrowd + 1) / 7.07;
          const fw = rho < 0.5 ? 1 : Math.max(0.35, 1 - Math.exp(-1.913 * (1 / rho - 1 / 5.4)));
          gasSample(L.x, L.y);
          const gasSlow = gS > 0.3 ? 0.55 : 1;
          L.speed = 1.45 / Math.sqrt(1 + L.count / 300) * (0.35 + 0.65 * L.energy / 100) * fw * gasSlow;
          if (fieldDir(F, L.x, L.y, tmpV) || dirTo(L.x, L.y, F.tx, F.ty, tmpV)) {
            moveWithWalls(L, tmpV.x * L.speed * dt, tmpV.y * L.speed * dt);
            moving = true;
          }
          if (gS > 0.3) L.energy -= dt * 0.15;
        }
      }
      if (!moving) L.speed = 0;
      L.energy = clamp(L.energy + (moving ? -(0.006 + L.count / 120000) : 0.03) * dt, 0, 100);
    }
  }

  // ---------------- crowd step ----------------
  const votes = new Float32Array(32);
  const SF_A = 2.2, SF_B = 0.28, SF_K = 18, RADS = 0.6, VISC = 1.2, TAU = 0.5, GO_HOME = 0.25;
  let dispersedHome = 0;
  function stepAgents(dt) {
    const nL = leaders.length;
    for (const L of leaders) L.newCount = 0;
    for (let i = 0; i < NA; i++) {
      const x = px[i], y = py[i];
      let fx = 0, fy = 0, nn = 0, avx = 0, avy = 0;
      if (nL) votes.fill(0, 0, nL);
      const cx = Math.floor(x / HC), cy = Math.floor(y / HC);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const k = hkey(cx + ox, cy + oy);
        for (let s = hStart[k], e = hStart[k + 1]; s < e; s++) {
          const j = hItems[s]; if (j === i) continue;
          const ddx = x - px[j], ddy = y - py[j], d2 = ddx * ddx + ddy * ddy;
          if (d2 > 4) continue;
          const d = Math.sqrt(d2) + 1e-3;
          let f = SF_A * Math.exp((RADS - d) / SF_B); if (d < RADS) f += SF_K * (RADS - d);
          fx += ddx / d * f; fy += ddy / d * f;
          if (d < 1.5) { nn++; avx += vx[j]; avy += vy[j]; }
          const lj = lead[j]; if (lj >= 0) votes[lj]++;
        }
      }
      const rho = (nn + 1) / 7.07;
      gasSample(x, y);
      const g = gS;

      // --- attachment ---
      let L = lead[i];
      if (panicT[i] > 0) {
        panicT[i] -= dt; L = -1;
        if (panicT[i] <= 0 && rnd(i) < GO_HOME) gone[i] = 1;
      } else {
        if (L >= 0) { const Ld = leaders[L], dl = Math.hypot(Ld.x - x, Ld.y - y); if (!(dl < 25 + 1.5 * Math.sqrt(Ld.count) || (votes[L] >= 2 && dl < 700))) L = -1; }
        if (L < 0) {
          let bv = 2.5;
          for (let l = 0; l < nL; l++) if (votes[l] > bv) { bv = votes[l]; L = l; }
          if (L < 0) for (let l = 0; l < nL; l++) { const Ld = leaders[l]; if (Math.hypot(Ld.x - x, Ld.y - y) < 20 && rnd(i) < dt * 0.8) { L = l; break; } }
        }
      }
      lead[i] = L;

      // --- desired velocity ---
      let dxD = 0, dyD = 0, vdes = 0;
      if (panicT[i] > 0) {
        if (g > 0.02 && (gGX || gGY)) { const l = Math.hypot(gGX, gGY); fleeX[i] = -gGX / l; fleeY[i] = -gGY / l; }
        dxD = fleeX[i]; dyD = fleeY[i]; vdes = 2.3;
      } else if (L >= 0) {
        const Ld = leaders[L]; Ld.newCount++;
        const F = Ld.field, cluster = Math.sqrt(Ld.count) * 0.95 + 3;
        if (F && fieldDir(F, x, y, tmpV)) {
          dxD = tmpV.x; dyD = tmpV.y;
          const my = fieldDist(F, x, y);
          if (Ld.arrived) vdes = my > cluster ? v0[i] : 0;
          else {
            const ahead = Ld.prog - my;
            vdes = ahead > 2 ? 0 : ahead > -1 ? v0[i] * 0.6 : ahead < -15 ? v0[i] * 1.25 : v0[i];
          }
        } else if (dirTo(x, y, Ld.x, Ld.y, tmpV)) {
          dxD = tmpV.x; dyD = tmpV.y; vdes = Math.hypot(Ld.x - x, Ld.y - y) > cluster ? v0[i] : 0;
        }
      }
      if (g > 0.05 && panicT[i] <= 0) {
        const l = Math.hypot(gGX, gGY);
        if (l > 1e-5) {
          const w = Math.min(1, g / 0.25);
          dxD = dxD * (1 - w) - gGX / l * w * 1.5; dyD = dyD * (1 - w) - gGY / l * w * 1.5;
          const dl = Math.hypot(dxD, dyD) || 1; dxD /= dl; dyD /= dl; vdes = Math.max(vdes, 1.4);
        }
        if (g > 0.4 && rnd(i) < dt * g * 0.9) makePanic(i, 12 + rnd(i) * 18, -gGX, -gGY);
      }
      const fw = rho < 0.3 ? 1 : Math.max(0.05, 1 - Math.exp(-1.913 * (1 / rho - 1 / 5.4)));
      vdes *= fw; if (g > 1) vdes *= 0.7;

      let ax = (dxD * vdes - vx[i]) / TAU + fx, ay = (dyD * vdes - vy[i]) / TAU + fy;
      if (nn) { ax += VISC * (avx / nn - vx[i]); ay += VISC * (avy / nn - vy[i]); }
      // walls
      const c = cellOf(x, y);
      if (clear[c] <= 1) {
        const gx = clear[c + 1] - clear[c - 1], gy = clear[c + COLS] - clear[c - COLS], gl = Math.hypot(gx, gy);
        if (gl > 0) { ax += gx / gl * 2.5; ay += gy / gl * 2.5; }
      }
      // leaders part the crowd around themselves
      for (let l = 0; l < nL; l++) {
        const Ld = leaders[l], ex = x - Ld.x, ey = y - Ld.y;
        if (ex > 3 || ex < -3 || ey > 3 || ey < -3) continue;
        const d = Math.hypot(ex, ey) + 1e-3; if (d < 2.6) { const f = 5 * (2.6 - d); ax += ex / d * f; ay += ey / d * f; }
      }
      let nvx = vx[i] + ax * dt, nvy = vy[i] + ay * dt;
      const sp = Math.hypot(nvx, nvy), vmax = panicT[i] > 0 ? 3.4 : 2.4;
      if (sp > vmax) { nvx *= vmax / sp; nvy *= vmax / sp; }
      // integrate + wall collision
      const nx = x + nvx * dt, ny = y + nvy * dt;
      if (walkAt(nx, ny)) { px[i] = nx; py[i] = ny; }
      else if (walkAt(nx, y)) { px[i] = nx; nvy = 0; }
      else if (walkAt(x, ny)) { py[i] = ny; nvx = 0; }
      else { nvx *= -0.2; nvy *= -0.2; }
      vx[i] = nvx; vy[i] = nvy;
    }
    for (const L of leaders) L.count = L.newCount;
    for (let i = NA - 1; i >= 0; i--) if (gone[i]) { NA--; dispersedHome++; if (i !== NA) copyAgent(NA, i); }
  }

  function step(dt = 0.12) { buildHash(); updateLeaders(dt); stepAgents(dt); }

  // setup: leaders from the fixture, all ordered to march on the Élysée goal
  for (const [x, y] of FX.leaders) addLeader(x, y);
  const goalField = computeField(FX.goal[0], FX.goal[1]);
  orderLeaders(goalField);

  // ---------------- reporting ----------------
  function checksum() {
    // order-sensitive weighted sum (f64) + FNV-1a over the raw f32 bytes of px, py
    let s = 0;
    for (let i = 0; i < NA; i++) s += px[i] * ((i % 7) + 1) + py[i] * ((i % 11) + 1);
    let h = 0x811c9dc5;
    const bytes = [new Uint8Array(px.buffer, 0, NA * 4), new Uint8Array(py.buffer, 0, NA * 4)];
    for (const b of bytes) for (let k = 0; k < b.length; k++) { h ^= b[k]; h = Math.imul(h, 0x01000193) >>> 0; }
    return { sum: s, fnv: h.toString(16).padStart(8, '0') };
  }
  function fieldChecksum(F) {
    let h = 0x811c9dc5;
    for (let c = 0; c < NC; c++) { h ^= F.dir[c]; h = Math.imul(h, 0x01000193) >>> 0; h ^= F.dist[c] & 255; h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  // aggregate stats used for the cross-language agreement check
  function aggregate(dist0) {
    let sumAdv = 0, nAdv = 0, sumAdvF = 0, nAdvF = 0, sumSp = 0, attached = 0, idle = 0, fleeing = 0;
    for (let i = 0; i < NA; i++) {
      const d1 = fieldDist(goalField, px[i], py[i]), d0 = dist0[i];
      if (isFinite(d0) && isFinite(d1)) { sumAdv += d0 - d1; nAdv++; if (lead[i] >= 0) { sumAdvF += d0 - d1; nAdvF++; } }
      sumSp += Math.hypot(vx[i], vy[i]);
      if (panicT[i] > 0) fleeing++; else if (lead[i] >= 0) attached++; else idle++;
    }
    return {
      NA, attached, idle, fleeing, gone: dispersedHome,
      meanAdvanceAll: sumAdv / nAdv, meanAdvanceFollowers: nAdvF ? sumAdvF / nAdvF : 0, meanSpeed: sumSp / NA,
      leaders: leaders.map(L => ({ count: L.count, x: +L.x.toFixed(2), y: +L.y.toFixed(2), prog: +L.prog.toFixed(1), energy: +L.energy.toFixed(3), arrived: L.arrived })),
    };
  }
  function distSnapshot() { const d = new Float64Array(NA); for (let i = 0; i < NA; i++) d[i] = fieldDist(goalField, px[i], py[i]); return d; }

  return { step, computeField, goalField, fieldChecksum, checksum, aggregate, distSnapshot, get NA() { return NA; }, px, py, leaders };
}

// ---------------- benchmark driver ----------------
function pct(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))]; }

export function runScenario(name, { warmup = 200, steps = 2000, fields = 10, log = console.log } = {}) {
  const FX = loadFixture(path.join(HERE, 'fixtures', name + '.bin'));
  const sim = createBenchSim(FX);
  // flow field timing (goal field, avg of `fields` runs after 2 warmup runs)
  for (let k = 0; k < 2; k++) sim.computeField(FX.goal[0], FX.goal[1]);
  let tf = performance.now();
  for (let k = 0; k < fields; k++) sim.computeField(FX.goal[0], FX.goal[1]);
  const fieldMs = (performance.now() - tf) / fields;

  const dist0 = sim.distSnapshot();
  for (let s = 0; s < warmup; s++) sim.step(0.12);
  const t = new Float64Array(steps);
  for (let s = 0; s < steps; s++) { const a = performance.now(); sim.step(0.12); t[s] = performance.now() - a; }
  const sorted = Float64Array.from(t).sort();
  const mean = t.reduce((a, b) => a + b, 0) / steps;
  const res = {
    scenario: name, N: FX.N, warmup, steps,
    fieldMs, fieldChecksum: sim.fieldChecksum(sim.goalField),
    stepMs: { mean, p50: pct(sorted, 50), p95: pct(sorted, 95), min: sorted[0], max: sorted[steps - 1] },
    checksum: sim.checksum(), aggregate: sim.aggregate(dist0),
  };
  log(`${name} N=${FX.N}: field ${fieldMs.toFixed(2)} ms | step mean ${mean.toFixed(3)} p50 ${res.stepMs.p50.toFixed(3)} p95 ${res.stepMs.p95.toFixed(3)} ms | checksum ${res.checksum.sum.toFixed(3)} ${res.checksum.fnv} | followers ${res.aggregate.leaders.map(l => l.count).join('/')}`);
  return res;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const which = args.find(a => /^(S\d|all)$/.test(a)) || 'all';
  const names = which === 'all' ? ['S1', 'S2', 'S3'] : [which];
  const o = { warmup: +opt('--warmup', 200), steps: +opt('--steps', 2000), fields: +opt('--fields', 10) };
  const out = opt('--out', path.join(HERE, 'results', 'js.json'));
  const results = names.map(n => runScenario(n, o));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ runner: 'js-node', node: process.version, results }, null, 2));
  console.log('wrote ' + path.relative(process.cwd(), out));
}
