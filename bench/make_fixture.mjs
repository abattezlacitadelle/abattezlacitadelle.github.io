// Builds the shared benchmark fixtures (bench/fixtures/S1.bin, S2.bin, S3.bin) from data/paris-small.js.
// Usage: node bench/make_fixture.mjs
//
// The nav grid is rasterised without a canvas: scanline polygon fill (even-odd, sampled at cell centres)
// and round-capped thick lines (cell centre within lineWidth/2 of a segment). This approximates the
// browser's canvas rasteriser (antialiased coverage > 50%) closely but not bit-for-bit. The draw order,
// border clearing, connected-component pass and clearance BFS follow src/sim.js buildNav() exactly.
//
// Every runner (JS, Rust native, Rust WASM) must read these files; they never rebuild the grid.
//
// Binary layout (little endian, all sections naturally aligned):
//   header, 128 bytes:
//     0  u32 magic 'RSB1' (0x31425352)   4  u32 version (1)
//     8  f64 W   16 f64 H                24 u32 CELL  28 u32 COLS  32 u32 ROWS
//     36 u32 GC  40 u32 GCOLS  44 u32 GROWS
//     48 u32 nLeaders  52 u32 N  56 f64 goalX  64 f64 goalY  72 u32 seed  (rest zero)
//   f64 leaders[nLeaders*2]           (x, y)
//   f32 gas[GN]                        static tear-gas field (GN = GCOLS*GROWS)
//   f32 px[N], py[N], v0[N]
//   u32 rng[N]                         per-agent xorshift32 state (never 0)
//   i32 lead[N]                        initial leader attachment (-1 = bystander)
//   u8  walk[NC], clear[NC], gwalk[GN] (NC = COLS*ROWS)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(HERE, 'fixtures');

export const SCENARIOS = [
  { name: 'S1', n: 3000, seed: 0x5eed0001 },
  { name: 'S2', n: 10000, seed: 0x5eed0002 },
  { name: 'S3', n: 30000, seed: 0x5eed0003 },
];

// ---------- shared PRNG (xorshift32). Same algorithm is used by every port. ----------
export function xorshift32(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// ---------- load data ----------
function loadData() {
  const src = fs.readFileSync(path.join(ROOT, 'data', 'paris-small.js'), 'utf8');
  const window = {};
  new Function('window', src)(window);
  return window.PARIS_DATA;
}

const ring = a => Array.isArray(a) ? a : a.o;
const holes = a => Array.isArray(a) ? null : a.i;

function buildGrid(D) {
  const W = D.meta.width, H = D.meta.height, CELL = 3;
  const COLS = Math.ceil(W / CELL), ROWS = Math.ceil(H / CELL), NC = COLS * ROWS;
  const img = new Uint8Array(NC); // 1 = white

  // even-odd scanline fill of a set of rings, sampled at cell centres
  function fillRings(rings, val) {
    let ymin = Infinity, ymax = -Infinity;
    for (const r of rings) for (let i = 1; i < r.length; i += 2) { if (r[i] < ymin) ymin = r[i]; if (r[i] > ymax) ymax = r[i]; }
    const gy0 = Math.max(0, Math.ceil(ymin / CELL - 0.5)), gy1 = Math.min(ROWS - 1, Math.floor(ymax / CELL - 0.5));
    const xs = [];
    for (let gy = gy0; gy <= gy1; gy++) {
      const yc = (gy + 0.5) * CELL;
      xs.length = 0;
      for (const r of rings) {
        const n = r.length >> 1;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const xi = r[2 * i], yi = r[2 * i + 1], xj = r[2 * j], yj = r[2 * j + 1];
          if ((yi > yc) !== (yj > yc)) xs.push(xi + (yc - yi) * (xj - xi) / (yj - yi));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, Math.ceil(xs[k] / CELL - 0.5)), b = Math.min(COLS - 1, Math.floor(xs[k + 1] / CELL - 0.5));
        for (let gx = a; gx <= b; gx++) img[gy * COLS + gx] = val;
      }
    }
  }
  const fillArea = (a, val) => { const rs = [ring(a)]; const h = holes(a); if (h) rs.push(...h); fillRings(rs, val); };

  // round-capped, round-joined polyline: union of capsules
  function strokeLine(p, lw, val) {
    const r = lw / 2, r2 = r * r;
    if (p.length === 2) p = [p[0], p[1], p[0], p[1]];
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
      const gx0 = Math.max(0, Math.floor((Math.min(ax, bx) - r) / CELL)), gx1 = Math.min(COLS - 1, Math.floor((Math.max(ax, bx) + r) / CELL));
      const gy0 = Math.max(0, Math.floor((Math.min(ay, by) - r) / CELL)), gy1 = Math.min(ROWS - 1, Math.floor((Math.max(ay, by) + r) / CELL));
      const ex = bx - ax, ey = by - ay, el = ex * ex + ey * ey;
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
        const cx = (gx + 0.5) * CELL - ax, cy = (gy + 0.5) * CELL - ay;
        let t = el > 0 ? (cx * ex + cy * ey) / el : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = cx - t * ex, dy = cy - t * ey;
        if (dx * dx + dy * dy <= r2) img[gy * COLS + gx] = val;
      }
    }
  }

  // same draw order as src/sim.js buildNav()
  for (const a of D.parks || []) fillArea(a, 1);
  for (const a of D.squares || []) fillArea(a, 1);
  for (const r of D.roads) { if (r.b) continue; strokeLine(r.p, Math.max(r.w, CELL * 1.4), 1); }
  for (const a of D.water || []) fillArea(a, 0);
  for (const r of D.roads) { if (!r.b) continue; strokeLine(r.p, Math.max(r.w, CELL * 1.4), 0); }
  for (const b of D.buildings) fillRings([b.p], 0);

  const walk = img;
  for (let gx = 0; gx < COLS; gx++) { walk[gx] = 0; walk[(ROWS - 1) * COLS + gx] = 0; }
  for (let gy = 0; gy < ROWS; gy++) { walk[gy * COLS] = 0; walk[gy * COLS + COLS - 1] = 0; }

  const G = { D, W, H, CELL, COLS, ROWS, NC, walk };
  G.cellOf = (x, y) => Math.floor(y / CELL) * COLS + Math.floor(x / CELL);
  G.walkAt = (x, y) => !(x < 0 || y < 0 || x >= W || y >= H) && walk[G.cellOf(x, y)] === 1;
  G.nearestWalkable = (gx, gy, maxR = 40) => {
    const ok = (x, y) => x > 0 && y > 0 && x < COLS - 1 && y < ROWS - 1 && walk[y * COLS + x];
    if (ok(gx, gy)) return gy * COLS + gx;
    for (let r = 1; r <= maxR; r++) for (let d = -r; d <= r; d++) {
      if (ok(gx + d, gy - r)) return (gy - r) * COLS + gx + d;
      if (ok(gx + d, gy + r)) return (gy + r) * COLS + gx + d;
      if (ok(gx - r, gy + d)) return (gy + d) * COLS + gx - r;
      if (ok(gx + r, gy + d)) return (gy + d) * COLS + gx + r;
    }
    return -1;
  };
  G.cellX = c => (c % COLS + 0.5) * CELL; G.cellY = c => (Math.floor(c / COLS) + 0.5) * CELL;

  // connected component from the seed (no République in paris-small -> first spawn point)
  const inMap = p => p && p[0] >= 0 && p[1] >= 0 && p[0] <= W && p[1] <= H;
  const spawn = Object.values(D.spawnPoints || {}).filter(inMap);
  const LM = D.landmarks || {};
  const seedP = (inMap(LM.republique) && LM.republique) || spawn[0] || LM.elysee;
  const seed = G.nearestWalkable(Math.floor(seedP[0] / CELL), Math.floor(seedP[1] / CELL), 60);
  const seen = new Uint8Array(NC), q = new Int32Array(NC);
  let qh = 0, qt = 0;
  if (seed >= 0) { q[qt++] = seed; seen[seed] = 1; }
  while (qh < qt) { const i = q[qh++]; for (const o of [1, -1, COLS, -COLS]) { const n = i + o; if (walk[n] && !seen[n]) { seen[n] = 1; q[qt++] = n; } } }
  if (qt > 1000) for (let i = 0; i < NC; i++) walk[i] = seen[i];

  const clear = new Uint8Array(NC);
  qh = qt = 0;
  for (let i = 0; i < NC; i++) { if (!walk[i]) { clear[i] = 0; q[qt++] = i; } else clear[i] = 255; }
  while (qh < qt) { const i = q[qh++]; const d = clear[i]; if (d >= 4) continue;
    for (const o of [1, -1, COLS, -COLS]) { const n = i + o; if (n < 0 || n >= NC) continue; if (clear[n] > d + 1) { clear[n] = d + 1; q[qt++] = n; } } }
  G.clear = clear;
  let wc = 0; for (let i = 0; i < NC; i++) wc += walk[i];
  G.walkCells = wc;
  G.spawn = spawn;
  G.LM = LM;
  return G;
}

// src/sim.js findGoal(): walkable street front north of the Élysée
function findGoal(G) {
  const [ex, ey] = G.LM.elysee;
  for (let d = 0; d <= 150; d += 1) for (const o of [0, -3, 3, -6, 6]) if (G.walkAt(ex + o, ey + d)) {
    let gx = ex + o, gy = ey + d;
    for (let s = 0; s < 2 && G.walkAt(gx, gy + G.CELL); s++) gy += G.CELL;
    const c = G.cellOf(gx, gy); return [G.cellX(c), G.cellY(c)];
  }
  const c = G.nearestWalkable(Math.floor(ex / G.CELL), Math.floor(ey / G.CELL), 80);
  return c >= 0 ? [G.cellX(c), G.cellY(c)] : [ex, ey];
}

function buildGas(G) {
  const GC = 6, GCOLS = Math.ceil(G.W / GC), GROWS = Math.ceil(G.H / GC), GN = GCOLS * GROWS;
  const gwalk = new Uint8Array(GN), gas = new Float32Array(GN);
  for (let gy = 0; gy < G.ROWS; gy++) for (let gx = 0; gx < G.COLS; gx++)
    if (G.walk[gy * G.COLS + gx]) gwalk[Math.floor(gy * G.CELL / GC) * GCOLS + Math.floor(gx * G.CELL / GC)] = 1;
  // static gas cloud (peak 0.35, below the 0.4 panic threshold) between the first two leaders, so agents
  // there take the steering-away branch and leaders slow down; elsewhere gasSample hits its early-out.
  const [a, b] = [G.leaders[0], G.leaders[1] || G.leaders[0]];
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, R = 45;
  for (let j = 1; j < GROWS - 1; j++) for (let i = 1; i < GCOLS - 1; i++) {
    const k = j * GCOLS + i; if (!gwalk[k]) continue;
    const dx = (i + 0.5) * GC - cx, dy = (j + 0.5) * GC - cy;
    const v = 0.35 * Math.exp(-(dx * dx + dy * dy) / (R * R));
    if (v > 0.004) gas[k] = v;
  }
  return { GC, GCOLS, GROWS, GN, gwalk, gas };
}

function makeAgents(G, n, seed) {
  const rand = xorshift32(seed);
  const px = new Float32Array(n), py = new Float32Array(n), v0 = new Float32Array(n), lead = new Int32Array(n), rng = new Uint32Array(n);
  let NA = 0;
  const add = (x, y, L) => { px[NA] = x; py[NA] = y; v0[NA] = 1.2 + rand() * 0.35; lead[NA] = L; NA++; };
  // half of the agents are followers (split 50/30/20 like the game's 600/350/120), half are bystanders
  const nf = Math.round(n * 0.5), shares = [0.5, 0.3, 0.2];
  G.leaders.forEach(([lx, ly], L) => {
    const want = L === G.leaders.length - 1 ? nf - NA : Math.round(nf * shares[L]);
    const r = Math.sqrt(want) * 0.9 + 4; // src/sim.js spawnAround
    let made = 0, tries = 0;
    while (made < want && tries < want * 400) {
      tries++;
      const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * r * (1 + tries / (want * 8));
      const sx = lx + Math.cos(a) * d, sy = ly + Math.sin(a) * d;
      if (G.walkAt(sx, sy) && G.clear[G.cellOf(sx, sy)] >= 1) { add(sx, sy, L); made++; }
    }
  });
  while (NA < n) { // src/sim.js spawnBystanders
    const x = rand() * G.W, y = rand() * G.H;
    if (G.walkAt(x, y) && G.clear[G.cellOf(x, y)] >= 2) add(x, y, -1);
  }
  for (let i = 0; i < n; i++) { let s = 0; while (!s) s = (rand() * 4294967296) >>> 0; rng[i] = s; }
  return { px, py, v0, lead, rng };
}

function writeFixture(file, G, gasG, goal, sc, A) {
  const n = sc.n, nL = G.leaders.length, NC = G.NC, GN = gasG.GN;
  const size = 128 + nL * 16 + GN * 4 + n * 4 * 5 + NC * 2 + GN;
  const buf = Buffer.alloc(size), dv = new DataView(buf.buffer, buf.byteOffset, size);
  dv.setUint32(0, 0x31425352, true); dv.setUint32(4, 1, true);
  dv.setFloat64(8, G.W, true); dv.setFloat64(16, G.H, true);
  dv.setUint32(24, G.CELL, true); dv.setUint32(28, G.COLS, true); dv.setUint32(32, G.ROWS, true);
  dv.setUint32(36, gasG.GC, true); dv.setUint32(40, gasG.GCOLS, true); dv.setUint32(44, gasG.GROWS, true);
  dv.setUint32(48, nL, true); dv.setUint32(52, n, true);
  dv.setFloat64(56, goal[0], true); dv.setFloat64(64, goal[1], true); dv.setUint32(72, sc.seed >>> 0, true);
  let o = 128;
  for (const [x, y] of G.leaders) { dv.setFloat64(o, x, true); dv.setFloat64(o + 8, y, true); o += 16; }
  const put = ta => { buf.set(new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength), o); o += ta.byteLength; };
  put(gasG.gas); put(A.px); put(A.py); put(A.v0); put(A.rng); put(A.lead); put(G.walk); put(G.clear); put(gasG.gwalk);
  if (o !== size) throw new Error('size mismatch');
  fs.writeFileSync(file, buf);
}

const t0 = performance.now();
const D = loadData();
const G = buildGrid(D);
// leaders: first 3 spawn points, snapped to walkable like addLeader()
G.leaders = G.spawn.slice(0, 3).map(([x, y]) => {
  if (G.walkAt(x, y)) return [x, y];
  const c = G.nearestWalkable(Math.floor(x / G.CELL), Math.floor(y / G.CELL), 60);
  return [G.cellX(c), G.cellY(c)];
});
const goal = findGoal(G);
const gasG = buildGas(G);
fs.mkdirSync(OUT, { recursive: true });
console.log(`grid ${G.COLS}x${G.ROWS} (${G.NC} cells), walkable ${G.walkCells} (${(100 * G.walkCells / G.NC).toFixed(1)}%), built in ${(performance.now() - t0).toFixed(0)} ms`);
console.log(`leaders ${JSON.stringify(G.leaders.map(p => p.map(v => +v.toFixed(1))))}  goal (Elysee) ${goal.map(v => v.toFixed(1))}`);
for (const sc of SCENARIOS) {
  const A = makeAgents(G, sc.n, sc.seed);
  const file = path.join(OUT, sc.name + '.bin');
  writeFixture(file, G, gasG, goal, sc, A);
  const nfol = A.lead.reduce((s, l) => s + (l >= 0), 0);
  console.log(`${sc.name}: ${sc.n} agents (${nfol} followers) -> ${path.relative(ROOT, file)} (${(fs.statSync(file).size / 1024).toFixed(0)} KiB)`);
}
// debug preview of the nav grid (PGM, open with any image viewer / GIMP)
const pgm = Buffer.concat([Buffer.from(`P5\n${G.COLS} ${G.ROWS}\n255\n`), Buffer.alloc(G.NC)]);
const hdr = pgm.length - G.NC;
for (let gy = 0; gy < G.ROWS; gy++) for (let gx = 0; gx < G.COLS; gx++) pgm[hdr + (G.ROWS - 1 - gy) * G.COLS + gx] = G.walk[gy * G.COLS + gx] ? 230 : 30;
fs.writeFileSync(path.join(OUT, 'navgrid.pgm'), pgm);
