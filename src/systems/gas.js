// Gas system: tear gas as a diffusing scalar field on a coarse grid (channelled by streets),
// plus the visual puffs (simulated here so every renderer can draw them).
import { clamp } from '../common.js';

export default function create(sim) {
  const { W, H, CELL, COLS, ROWS, walk, walkAt, rand } = sim;
  const GC = 6, GCOLS = Math.ceil(W / GC), GROWS = Math.ceil(H / GC), GN = GCOLS * GROWS;
  const gas = new Float32Array(GN), gas2 = new Float32Array(GN), gwalk = new Uint8Array(GN);
  // v1.5: a canister used to emit 1.3/s for 28 s (36 units: three canisters gassed ~100 x 100 m at panic level 0.4);
  // now CAN_RATE/s for CAN_T s and a faster decay, so a volley clouds ~25 m around its landing points
  const GAS_D = 3.0, GAS_TAU = 55, WIND = { x: 0.35, y: 0.12 }, CAN_RATE = 0.45, CAN_T = 22;
  let gasBox = null, gasShrinkT = 0;
  const emitters = [];
  // last gasSample() result: s = concentration, gx/gy = gradient
  const G = { s: 0, gx: 0, gy: 0 };

  function buildGasGrid() {
    for (let gy = 0; gy < ROWS; gy++) for (let gx = 0; gx < COLS; gx++)
      if (walk[gy * COLS + gx]) gwalk[Math.floor(gy * CELL / GC) * GCOLS + Math.floor(gx * CELL / GC)] = 1;
  }
  function gasSample(x, y) {
    const i = Math.floor(x / GC), j = Math.floor(y / GC);
    if (i < 1 || j < 1 || i >= GCOLS - 1 || j >= GROWS - 1) { G.s = G.gx = G.gy = 0; return G; }
    const k = j * GCOLS + i;
    const c = G.s = gas[k];
    if (c < 0.01) { G.gx = G.gy = 0; return G; }
    const l = gwalk[k - 1] ? gas[k - 1] : c, r = gwalk[k + 1] ? gas[k + 1] : c, d = gwalk[k - GCOLS] ? gas[k - GCOLS] : c, u = gwalk[k + GCOLS] ? gas[k + GCOLS] : c;
    G.gx = (r - l) / (2 * GC); G.gy = (u - d) / (2 * GC);
    return G;
  }
  // v1.6: the canister's pop + first burst makes people within LAND_R scatter (chance LAND_P x falloff; pacifists less) for
  // 4-9 s; the cloud itself then denies the ground (the crowd walks out of it) and panics those who stay in it (crowd.js)
  const LAND_R = 9, LAND_P = 0.85, { ACT: A, CLS: C } = sim;
  function throwGas(x, y) {
    emitters.push({ x, y, t: CAN_T, rate: CAN_RATE }); sim.emit('gas', x, y);
    sim.forEachNear?.(x, y, LAND_R, (j, dx, dy, d2) => {
      const a = sim.act[j]; if (a === A.DOWN || a === A.ARRESTED || a === A.HOME) return;
      if (rand() < LAND_P * (1 - Math.sqrt(d2) / LAND_R) * (sim.cls[j] === C.PACIFIST ? 0.4 : 1)) sim.makePanic(j, 4 + rand() * 5, dx || rand() - 0.5, dy || rand() - 0.5);
    });
  }
  function growBox(i, j, m) {
    if (!gasBox) gasBox = { x0: i, x1: i, y0: j, y1: j };
    gasBox.x0 = clamp(Math.min(gasBox.x0, i - m), 1, GCOLS - 2); gasBox.x1 = clamp(Math.max(gasBox.x1, i + m), 1, GCOLS - 2);
    gasBox.y0 = clamp(Math.min(gasBox.y0, j - m), 1, GROWS - 2); gasBox.y1 = clamp(Math.max(gasBox.y1, j + m), 1, GROWS - 2);
  }
  function updateGas(dt) {
    for (let e = emitters.length - 1; e >= 0; e--) {
      const em = emitters[e];
      const i = Math.floor(em.x / GC), j = Math.floor(em.y / GC);
      if (i > 0 && j > 0 && i < GCOLS - 1 && j < GROWS - 1) {
        const k = j * GCOLS + i;
        if (gwalk[k]) gas[k] += em.rate * dt;
        growBox(i, j, 2);
      }
      em.acc = (em.acc || 0) + dt * 5;
      while (em.acc > 1) { em.acc--; spawnPuff(em.x, em.y); }
      em.x += WIND.x * 0.4 * dt; em.y += WIND.y * 0.4 * dt;
      em.t -= dt; if (em.t <= 0) emitters.splice(e, 1);
    }
    if (!gasBox) return;
    growBox(gasBox.x0, gasBox.y0, 1); growBox(gasBox.x1, gasBox.y1, 1);
    const kd = GAS_D * dt / (GC * GC), decay = Math.exp(-dt / GAS_TAU), aw = dt / GC;
    const { x0, x1, y0, y1 } = gasBox;
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
      const k = j * GCOLS + i;
      if (!gwalk[k]) { gas2[k] = 0; continue; }
      const c = gas[k];
      const l = gwalk[k - 1] ? gas[k - 1] : c, r = gwalk[k + 1] ? gas[k + 1] : c, d = gwalk[k - GCOLS] ? gas[k - GCOLS] : c, u = gwalk[k + GCOLS] ? gas[k + GCOLS] : c;
      let n = c + kd * (l + r + d + u - 4 * c);
      n -= aw * (WIND.x > 0 ? WIND.x * (c - l) : WIND.x * (r - c));
      n -= aw * (WIND.y > 0 ? WIND.y * (c - d) : WIND.y * (u - c));
      gas2[k] = Math.max(0, n * decay);
    }
    for (let j = y0; j <= y1; j++) { const a = j * GCOLS; gas.set(gas2.subarray(a + x0, a + x1 + 1), a + x0); }
    gasShrinkT -= dt;
    if (gasShrinkT <= 0) {
      gasShrinkT = 3;
      let nx0 = 1e9, nx1 = -1, ny0 = 1e9, ny1 = -1;
      for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) if (gas[j * GCOLS + i] > 0.004) { nx0 = Math.min(nx0, i); nx1 = Math.max(nx1, i); ny0 = Math.min(ny0, j); ny1 = Math.max(ny1, j); }
      if (nx1 < 0 && !emitters.length) { for (let j = y0; j <= y1; j++) gas.fill(0, j * GCOLS + x0, j * GCOLS + x1 + 1); gasBox = null; }
      else if (nx1 >= 0) gasBox = { x0: Math.max(1, nx0 - 1), x1: Math.min(GCOLS - 2, nx1 + 1), y0: Math.max(1, ny0 - 1), y1: Math.min(GROWS - 2, ny1 + 1) };
    }
  }

  // visual puffs (pH = height above ground for 3D)
  const MAXP = 4000;
  const pX = new Float32Array(MAXP), pY = new Float32Array(MAXP), pH = new Float32Array(MAXP), pSize = new Float32Array(MAXP), pAlpha = new Float32Array(MAXP);
  const pVX = new Float32Array(MAXP), pVY = new Float32Array(MAXP), pAge = new Float32Array(MAXP), pLife = new Float32Array(MAXP);
  let NP = 0;
  function spawnPuff(x, y) {
    if (NP >= MAXP) return;
    const i = NP++;
    pX[i] = x + (rand() - 0.5) * 2; pH[i] = 0.5 + rand(); pY[i] = y + (rand() - 0.5) * 2;
    const a = rand() * Math.PI * 2, s = 0.3 + rand() * 0.6;
    pVX[i] = WIND.x + Math.cos(a) * s; pVY[i] = WIND.y + Math.sin(a) * s;
    pAge[i] = 0; pLife[i] = 22 + rand() * 14; pSize[i] = 3; pAlpha[i] = 0;
  }
  function updatePuffs(dt) {
    for (let i = 0; i < NP; i++) {
      pAge[i] += dt;
      if (pAge[i] >= pLife[i]) {
        NP--;
        if (i !== NP) { pX[i] = pX[NP]; pY[i] = pY[NP]; pH[i] = pH[NP]; pVX[i] = pVX[NP]; pVY[i] = pVY[NP];
          pAge[i] = pAge[NP]; pLife[i] = pLife[NP]; pSize[i] = pSize[NP]; pAlpha[i] = pAlpha[NP]; }
        i--; continue;
      }
      const t = pAge[i] / pLife[i];
      const nx = pX[i] + pVX[i] * dt, ny = pY[i] + pVY[i] * dt;
      if (walkAt(nx, ny)) { pX[i] = nx; pY[i] = ny; } else { pVX[i] *= -0.5; pVY[i] *= -0.5; }
      pVX[i] += (WIND.x - pVX[i]) * dt * 0.05; pVY[i] += (WIND.y - pVY[i]) * dt * 0.05;
      pH[i] += dt * 0.08;
      pSize[i] = 3 + t * 16;
      pAlpha[i] = 0.32 * Math.min(1, pAge[i] * 1.5) * (1 - t);
    }
  }

  sim.api.throwGas = throwGas;
  Object.assign(sim, { throwGas, gasSample, gs: G, GC, GCOLS, GROWS, gas, gwalk, emitters, WIND, pX, pY, pH, pSize, pAlpha });
  Object.defineProperty(sim, 'gasBox', { get: () => gasBox, enumerable: true, configurable: true });
  Object.defineProperty(sim, 'NP', { get: () => NP, enumerable: true, configurable: true });

  return {
    name: 'gas',
    init() { buildGasGrid(); },
    update(dt) { updateGas(dt); updatePuffs(dt); },
  };
}
