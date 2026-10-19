// Combat system: projectiles (3D ballistic), fires, explosions, props and damage. Owns sim.projectiles, sim.fires, sim.props.
//
// API (see docs/contract.md):
//   sim.api.throwProjectile(kind, x0, y0, tx, ty, owner, from?) -> projectile | null
//       kind: 'rock'|'paving'|'bottle'|'molotov'|'firework'|'gas'|'lbd'|'flashbang'; owner: stored/emitted as given
//       from: thrower, skipped by hit tests and used for accuracy: agent index (number) or {sq, k} for an officer.
//       Side (p.police) comes from 'from' (object = police, index = crowd), else gas/lbd/flashbang = police. Police projectiles never hit officers.
//   sim.api.ignite(x, y, kind, r?) -> fire | null   kind: 'car'|'bin'|'shop'|'barricade'|'molotov'
//       'car'/'bin'/'shop' attach to the nearest unburnt prop/shop of that kind within a few metres when one exists
//   sim.api.explode(x, y, power)       power 1 ~ a car blowing up
//   sim.api.hitAgent(i, dmg, kind) -> true if the agent went down;  sim.api.healAgent(i, amt) -> hp
//   sim.api.firesNear(x, y, r) -> shared array of fires within r (valid until the next call; copy it to keep it)
//   sim.api.nearestFire(x, y, r) -> fire | null
//   sim.api.combatDemo(x, y)           debug burst of mixed projectiles + a few burning cars
//   sim.api.combatStats() -> counters (throws, hits, injuries, fires, explosions, ms)
import { ACT, CLS, clamp } from '../common.js';

const G = 9.8;
const BUILDING_H = 15;      // projectiles below this height stop at non-walkable cells
const BODY_H = 2.0;         // direct hits on people only below this height
const HIT_R = 0.42;         // person radius + projectile radius
// per-kind ballistics: angle (rad) of the launch, max launch speed, accuracy sigma = s0 + sk * distance (m)
const K = {
  rock:      { ang: 0.60, vmax: 22, s0: 0.5, sk: 0.08, dmg: 0.35 },
  paving:    { ang: 0.70, vmax: 16, s0: 0.6, sk: 0.10, dmg: 0.55 },
  bottle:    { ang: 0.62, vmax: 20, s0: 0.5, sk: 0.08, dmg: 0.30 },
  molotov:   { ang: 0.66, vmax: 18, s0: 0.6, sk: 0.09, dmg: 0.20 },
  firework:  { ang: 0.14, vmax: 38, s0: 1.0, sk: 0.12, dmg: 0.15 },
  gas:       { ang: 0.85, vmax: 32, s0: 1.5, sk: 0.06, dmg: 0.25 },
  flashbang: { ang: 0.78, vmax: 20, s0: 1.0, sk: 0.06, dmg: 0.20 },
  lbd:       { ang: 0,    vmax: 80, s0: 0.15, sk: 0.015, dmg: 0.45 },
};
// fires: radius, fuel (s) range, ramp-up time (s)
const FK = {
  car:       { r: 3.0, f0: 240, f1: 360, ramp: 25 },
  bin:       { r: 1.5, f0: 75,  f1: 105, ramp: 8 },
  shop:      { r: 5.0, f0: 420, f1: 540, ramp: 40 },
  barricade: { r: 3.5, f0: 260, f1: 340, ramp: 15 },
  molotov:   { r: 3.0, f0: 18,  f1: 22,  ramp: 1.2 },
};
// prop kind -> fire kind / per-second ignition chance when inside a fire's reach (at full intensity, zero distance)
const PROP_FIRE = { car: 'car', bin: 'bin', scooter: 'bin', bike: 'bin', construction: 'barricade' };
// v1.5: halved-to-quartered (was car 0.03, bin 0.06, scooter 0.04, bike 0.03, construction 0.03): chaos stays local
const PROP_P = { car: 0.008, bin: 0.03, scooter: 0.018, bike: 0.012, construction: 0.015 };
const CAR_REACH = 5.5;      // v1.5: car fire spread reach (was 8 m: every parked car in the street went up)
const CAR_BOOM_P = 0.12;    // v1.5: chance a burning car explodes (was 0.25)
const PROP_FUEL = { scooter: 60, bike: 40 }; // override fuel for small props burning as 'bin'
const SHIELD_P = 0.6;        // v1.5: chance a front-rank shield stops a projectile hitting the line from the front
const CAR_HL = 2.2, CAR_HW = 0.9;            // car half length / half width (m)

export default function create(sim) {
  const { px, py, vx, vy, act, cls, hp, panicT, tgt, extFx, extFy, walkAt, forEachNear, makePanic, rand, CELL, COLS, ROWS } = sim;
  const A_DOWN = ACT.DOWN, A_ARRESTED = ACT.ARRESTED;
  let projectiles = [], fires = [], props = [], shops = [];
  let projSerial = 0, fireSerial = 0, lastDt = 0.12, tickAcc = 0;
  const S = { throws: 0, hitsAgent: 0, hitsOfficer: 0, injuries: 0, fires: 0, explosions: 0, carExplosions: 0, ms: 0, msMax: 0 };
  const gauss = () => { let u = 0; for (let k = 0; k < 4; k++) u += rand(); return (u - 2) * 1.732; }; // ~N(0,1)

  // ------------------------------------------------------------------ grid indexes (CSR, 8 m cells)
  const GCELL = 8;
  function buildGrid(items) {
    const gc = Math.ceil(sim.W / GCELL) + 1, gr = Math.ceil(sim.H / GCELL) + 1, n = gc * gr;
    const start = new Int32Array(n + 1), it = new Int32Array(items.length), key = new Int32Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const k = clamp(Math.floor(items[i].y / GCELL), 0, gr - 1) * gc + clamp(Math.floor(items[i].x / GCELL), 0, gc - 1);
      key[i] = k; start[k + 1]++;
    }
    for (let k = 0; k < n; k++) start[k + 1] += start[k];
    const cur = start.slice();
    for (let i = 0; i < items.length; i++) it[cur[key[i]]++] = i;
    return { gc, gr, start, it };
  }
  // fn(i, d2) for items within r of (x, y); return true to stop
  function gridQuery(grid, items, x, y, r, fn) {
    if (!grid) return;
    const { gc, gr, start, it } = grid, r2 = r * r;
    const i0 = Math.max(0, Math.floor((x - r) / GCELL)), i1 = Math.min(gc - 1, Math.floor((x + r) / GCELL));
    const j0 = Math.max(0, Math.floor((y - r) / GCELL)), j1 = Math.min(gr - 1, Math.floor((y + r) / GCELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * gc + i;
      for (let s = start[k], e = start[k + 1]; s < e; s++) {
        const q = it[s], o = items[q], dx = o.x - x, dy = o.y - y, d2 = dx * dx + dy * dy;
        if (d2 < r2 && fn(q, d2) === true) return;
      }
    }
  }
  let propGrid = null, shopGrid = null;
  // cars as soft obstacles: per nav cell, up to two car indices (+1) whose inflated footprint touches the cell
  let carA = null, carB = null;
  function buildCarCells() {
    carA = new Int16Array(COLS * ROWS); carB = new Int16Array(COLS * ROWS);
    const R = CAR_HL + 0.5;
    for (let q = 0; q < props.length; q++) {
      const p = props[q]; if (p.k !== 'car' || q > 32766) continue;
      const i0 = Math.max(0, Math.floor((p.x - R) / CELL)), i1 = Math.min(COLS - 1, Math.floor((p.x + R) / CELL));
      const j0 = Math.max(0, Math.floor((p.y - R) / CELL)), j1 = Math.min(ROWS - 1, Math.floor((p.y + R) / CELL));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const c = j * COLS + i;
        if (!carA[c]) carA[c] = q + 1; else if (!carB[c]) carB[c] = q + 1;
      }
    }
  }

  // ------------------------------------------------------------------ damage
  function hitAgent(i, dmg, kind) {
    if (i < 0 || i >= sim.NA) return false;
    const a = act[i];
    if (a === A_DOWN || a === A_ARRESTED) { hp[i] = Math.max(0, hp[i] - dmg); return false; }
    hp[i] -= dmg;
    if (hp[i] <= 0) {
      hp[i] = 0; act[i] = A_DOWN; tgt[i] = -1; vx[i] = vy[i] = 0; panicT[i] = 0;
      S.injuries++;
      sim.emit('injury', px[i], py[i], { i, kind });
      return true;
    }
    return false;
  }
  function healAgent(i, amt) {
    if (i < 0 || i >= sim.NA) return 0;
    hp[i] = Math.min(1, hp[i] + amt);
    if (act[i] === A_DOWN && hp[i] >= 0.35) act[i] = ACT.IDLE; // back on their feet; the crowd relabels next step
    return hp[i];
  }
  const officerUp = (sq, k) => !((sq.hp && sq.hp[k] <= 0) || (sq.down && sq.down[k]));
  function hitOfficer(sq, k, dmg, kind) {
    if (kind !== 'fire') S.hitsOfficer++;
    if (sim.api.hitOfficer) return sim.api.hitOfficer(sq, k, dmg, kind);
    return false;
  }
  // nearest standing officer within r of (x, y) -> sets OFF.sq/OFF.k, returns d2 or Infinity
  const OFF = { sq: null, k: -1 };
  function nearestOfficer(x, y, r) {
    let best = r * r; OFF.sq = null; OFF.k = -1;
    const squads = sim.squads; if (!squads) return Infinity;
    for (const sq of squads) {
      if (sq.van) continue; const bb = sq.bb; if (bb && (x < bb[0] - r || x > bb[2] + r || y < bb[1] - r || y > bb[3] + r)) continue;
      for (let k = 0; k < sq.n; k++) {
        const dx = sq.ox[k] - x, dy = sq.oy[k] - y, d2 = dx * dx + dy * dy;
        if (d2 < best && officerUp(sq, k)) { best = d2; OFF.sq = sq; OFF.k = k; }
      }
    }
    return OFF.sq ? best : Infinity;
  }
  function forEachOfficer(x, y, r, fn) {
    const squads = sim.squads; if (!squads) return;
    const r2 = r * r;
    for (const sq of squads) {
      if (sq.van) continue; const bb = sq.bb; if (bb && (x < bb[0] - r || x > bb[2] + r || y < bb[1] - r || y > bb[3] + r)) continue;
      for (let k = 0; k < sq.n; k++) {
        const dx = sq.ox[k] - x, dy = sq.oy[k] - y, d2 = dx * dx + dy * dy;
        if (d2 < r2 && officerUp(sq, k)) fn(sq, k, dx, dy, d2);
      }
    }
  }
  const isUp = j => act[j] !== A_DOWN && act[j] !== A_ARRESTED;

  // ------------------------------------------------------------------ projectiles
  // which side threw it: from {sq,k} = police, from agent index = crowd; else police kinds (gas/lbd/flashbang) are police.
  // (owner letters are ambiguous across systems: riots passes 'P' for protesters, fx2d draws 'P' as police.)
  const POLICE_KINDS = { gas: 1, lbd: 1, flashbang: 1 };
  function isPolice(kind, owner, from) {
    if (from && typeof from === 'object') return true;
    if (typeof from === 'number' && from >= 0) return false;
    return !!POLICE_KINDS[kind];
  }
  function throwProjectile(kind, x0, y0, tx, ty, owner = 'C', from) {
    const P = K[kind]; if (!P) return null;
    if (!(x0 === x0 && y0 === y0 && tx === tx && ty === ty)) return null;
    // thrower state -> accuracy
    let acc = 1;
    if (typeof from === 'number' && from >= 0 && from < sim.NA) {
      if (panicT[from] > 0) acc += 1.2;
      acc += (1 - hp[from]) * 0.8;
      if (sim.gasSample) acc += Math.min(2, sim.gasSample(px[from], py[from]).s * 3);
      if (cls[from] === CLS.BLACKBLOC) acc *= 0.7;
    } else if (from && typeof from === 'object') acc = 0.7;
    let dx = tx - x0, dy = ty - y0, d = Math.hypot(dx, dy);
    const sig = (P.s0 + P.sk * d) * acc;
    tx += gauss() * sig; ty += gauss() * sig;
    dx = tx - x0; dy = ty - y0; d = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / d, uy = dy / d, z0 = 1.8;
    let vh, vz;
    if (kind === 'lbd') {
      vh = P.vmax; const T = d / vh, zt = 1.2 + gauss() * 0.15 * acc;
      vz = (zt - z0) / T + 0.5 * G * T;
    } else {
      const c = Math.cos(P.ang), t = Math.tan(P.ang);
      let v = Math.sqrt(G * d * d / (2 * c * c * (z0 + d * t)));
      v *= 1 + gauss() * 0.03 * acc;
      v = Math.min(v, P.vmax);
      vh = v * c; vz = v * Math.sin(P.ang);
    }
    const p = { id: ++projSerial, kind, x: x0, y: y0, z: z0, vx: ux * vh, vy: uy * vh, vz, owner, age: 0, alive: true, police: isPolice(kind, owner, from),
      from: from ?? -1, x0, y0, tx, ty, bounces: 0, fuse: kind === 'firework' ? d / vh * (1.1 + rand() * 0.4) + 0.2 : 0 };
    if (sim.projectiles !== projectiles && sim.projectiles) projectiles = sim.projectiles;
    projectiles.push(p);
    S.throws++;
    sim.emit('throw', x0, y0, { kind, owner, tx, ty, id: p.id });
    return p;
  }

  // direct hit test on segment (ax,ay)-(bx,by): returns parameter t in [0,1] or -1; sets HIT
  const HIT = { type: 0, j: -1, sq: null, k: -1 };
  function segHit(p, ax, ay, bx, by) {
    const sx = bx - ax, sy = by - ay, L2 = sx * sx + sy * sy + 1e-9, L = Math.sqrt(L2);
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    let bestT = 2; HIT.type = 0;
    const from = p.from;
    forEachNear(mx, my, L / 2 + HIT_R, (j, ex, ey) => {
      if (j === from || !isUp(j)) return;
      const qx = px[j] - ax, qy = py[j] - ay;
      const t = clamp((qx * sx + qy * sy) / L2, 0, 1);
      const cx = qx - sx * t, cy = qy - sy * t;
      if (cx * cx + cy * cy < HIT_R * HIT_R && t < bestT) { bestT = t; HIT.type = 1; HIT.j = j; }
    });
    if (!p.police && sim.squads) {
      const fo = typeof from === 'object' ? from : null;
      for (const sq of sim.squads) {
        if (sq.van) continue; const bb = sq.bb; if (bb && (mx < bb[0] - L || mx > bb[2] + L || my < bb[1] - L || my > bb[3] + L)) continue;
        for (let k = 0; k < sq.n; k++) {
          if (fo && fo.sq === sq && fo.k === k) continue;
          const qx = sq.ox[k] - ax, qy = sq.oy[k] - ay;
          const t = clamp((qx * sx + qy * sy) / L2, 0, 1);
          const cx = qx - sx * t, cy = qy - sy * t;
          if (cx * cx + cy * cy < (HIT_R + 0.1) ** 2 && t < bestT && officerUp(sq, k)) { bestT = t; HIT.type = 2; HIT.sq = sq; HIT.k = k; }
        }
      }
    }
    return HIT.type ? bestT : -1;
  }

  function updateProjectiles(dt) {
    if (sim.projectiles !== projectiles) projectiles = sim.projectiles || (sim.projectiles = []);
    // compact the ones that died last step (readers saw them once with alive=false)
    let w = 0;
    for (let r = 0; r < projectiles.length; r++) if (projectiles[r].alive) projectiles[w++] = projectiles[r];
    projectiles.length = w;
    for (let n = 0; n < projectiles.length; n++) {
      const p = projectiles[n];
      p.age += dt;
      const sp = Math.hypot(p.vx, p.vy, p.vz);
      const nsub = Math.max(1, Math.ceil(sp * dt / 0.9));
      const h = dt / nsub;
      for (let s = 0; s < nsub && p.alive; s++) {
        const ax = p.x, ay = p.y, az = p.z;
        let bx = ax + p.vx * h, by = ay + p.vy * h, bz = az + p.vz * h - 0.5 * G * h * h;
        p.vz -= G * h;
        // buildings
        if (!p.dropped && bz < BUILDING_H && !walkAt(bx, by)) {
          if (p.kind === 'firework' && p.bounces < 3) { // ricochet off the wall face
            p.bounces++;
            const hx = walkAt(bx, ay), hy = walkAt(ax, by);
            if (!hx) p.vx = -p.vx * 0.6; if (!hy) p.vy = -p.vy * 0.6;
            if (hx && hy) { p.vx = -p.vx * 0.6; p.vy = -p.vy * 0.6; }
            p.vz *= 0.7; p.z = Math.max(0.05, bz); continue;
          }
          if (p.kind === 'lbd') { impact(p, ax, ay, -1); break; }
          p.vx = p.vy = 0; p.dropped = true; // stop and drop at the wall foot
          p.z = Math.max(0, bz); continue;
        }
        // direct hits on people while low (not right at the thrower's hand)
        const travelled = Math.abs(ax - p.x0) + Math.abs(ay - p.y0);
        if (p.kind !== 'gas' && Math.min(az, bz) < BODY_H && travelled > 1.0 && Math.max(az, bz) > 0.1) {
          const t = segHit(p, ax, ay, bx, by);
          if (t >= 0) { impact(p, ax + (bx - ax) * t, ay + (by - ay) * t, HIT.type); break; }
        }
        // ground
        if (bz <= 0) {
          const t = az / Math.max(1e-6, az - bz), gx = ax + (bx - ax) * t, gy = ay + (by - ay) * t;
          if (p.kind === 'firework' && p.age < p.fuse && p.bounces < 4 && Math.abs(p.vz) > 1.5) {
            p.bounces++; p.x = gx; p.y = gy; p.z = 0.02; p.vz = -p.vz * 0.35; p.vx *= 0.7; p.vy *= 0.7; continue;
          }
          impact(p, gx, gy, 0); break;
        }
        p.x = bx; p.y = by; p.z = bz;
      }
      if (p.alive && p.kind === 'firework' && p.age >= p.fuse) impact(p, p.x, p.y, 0);
      if (p.alive && (p.age > 12 || p.x < 0 || p.y < 0 || p.x > sim.W || p.y > sim.H)) p.alive = false;
    }
  }

  // directHit: 0 none (landing / wall), 1 agent HIT.j, 2 officer HIT.sq/HIT.k, -1 lbd wall
  function impact(p, x, y, directHit) {
    p.alive = false; p.x = x; p.y = y;
    if (directHit <= 0) p.z = 0;
    const kind = p.kind, P = K[kind];
    // a hit agent/officer for kinds that hurt on contact
    const hj = directHit === 1 ? HIT.j : -1, hsq = directHit === 2 ? HIT.sq : null, hk = HIT.k;
    sim.emit('impact', x, y, { kind, owner: p.owner, direct: directHit > 0 });
    switch (kind) {
      case 'rock': case 'paving': case 'bottle': {
        const dmg = P.dmg * (0.7 + rand() * 0.6);
        if (hj >= 0) { S.hitsAgent++; hitAgent(hj, dmg * 1.2, kind); }
        else if (hsq) { if (!shielded(p, hsq, hk)) hitOfficer(hsq, hk, dmg * 1.2, kind); }
        else splash(p, x, y, 0.8, dmg, kind);
        if (kind === 'bottle') sim.emit('shatter', x, y);
        break;
      }
      case 'molotov': {
        sim.emit('shatter', x, y);
        if (hj >= 0) { S.hitsAgent++; hitAgent(hj, P.dmg + 0.2, 'molotov'); }
        else if (hsq) { if (!shielded(p, hsq, hk)) hitOfficer(hsq, hk, P.dmg + 0.2, 'molotov'); }
        let fx = x, fy = y;
        if (!walkAt(fx, fy)) { fx = p.x0 + (x - p.x0) * 0.95; fy = p.y0 + (y - p.y0) * 0.95; }
        ignite(fx, fy, 'molotov', 3);
        break;
      }
      case 'gas':
        if (sim.api.throwGas) sim.api.throwGas(x, y);
        break;
      case 'flashbang': flashbang(p, x, y); break;
      case 'firework': {
        const r = 1.6, low = p.z < 2.5;
        if (low) splash(p, x, y, r, P.dmg, 'firework', true);
        forEachNear(x, y, 5, (j, ex, ey, d2) => {
          if (isUp(j) && panicT[j] <= 0 && rand() < 0.35 * (1 - Math.sqrt(d2) / 5)) makePanic(j, 2 + rand() * 4, ex, ey);
        });
        break;
      }
      case 'lbd': {
        if (hj >= 0) {
          S.hitsAgent++;
          const bad = rand() < 0.25; // serious injury
          hitAgent(hj, bad ? 1.1 : P.dmg * (0.7 + rand() * 0.6), 'lbd');
          if (isUp(hj) && panicT[hj] <= 0) makePanic(hj, 3 + rand() * 5, p.vx, p.vy);
        } else if (hsq) hitOfficer(hsq, hk, P.dmg, 'lbd');
        break;
      }
    }
  }
  // v1.5 shields: a front-rank officer of a formed line blocks most projectiles coming at the line's face
  function shielded(p, sq, k) {
    if (sq.formation !== 'line' || k >= (sq.nFront || 0)) return false;
    const v = Math.hypot(p.vx, p.vy) || 1;
    if ((p.vx * sq.dx + p.vy * sq.dy) / v > -0.25) return false;
    if (rand() < SHIELD_P) { S.shieldBlocks = (S.shieldBlocks || 0) + 1; sim.emit('impact', p.x, p.y, { kind: 'shield', owner: p.owner, direct: true }); return true; }
    return false;
  }
  // hurt the nearest person within r (multi: everyone within r, damage falling off)
  function splash(p, x, y, r, dmg, kind, multi = false) {
    if (multi) {
      forEachNear(x, y, r, (j, ex, ey, d2) => { if (isUp(j)) { S.hitsAgent++; hitAgent(j, dmg * (1 - Math.sqrt(d2) / r * 0.6), kind); } });
      if (!p.police) forEachOfficer(x, y, r, (sq, k) => hitOfficer(sq, k, dmg * 0.5, kind));
      return;
    }
    let bj = -1, bd = r * r;
    forEachNear(x, y, r, (j, ex, ey, d2) => { if (d2 < bd && isUp(j)) { bd = d2; bj = j; } });
    const od = !p.police ? nearestOfficer(x, y, r) : Infinity;
    if (od < bd) hitOfficer(OFF.sq, OFF.k, dmg * 0.5, kind); // v1.5: near misses on officers (helmets, shields) count half
    else if (bj >= 0) { S.hitsAgent++; hitAgent(bj, dmg, kind); }
  }
  function flashbang(p, x, y) {
    sim.emit('flash', x, y);
    const R = 6, k = 1 / lastDt;
    forEachNear(x, y, R, (j, ex, ey, d2) => {
      if (!isUp(j)) return;
      const d = Math.sqrt(d2) + 1e-3, f = 1 - d / R;
      if (d < 2 && rand() < 0.3) hitAgent(j, 0.3 + rand() * 0.5, 'flashbang');
      if (!isUp(j)) return;
      makePanic(j, 2 + 4 * f + rand() * 2, ex, ey); // stun -> short panic away
      if (d < 3) { extFx[j] += ex / d * 1.5 * f * k; extFy[j] += ey / d * 1.5 * f * k; }
    });
    if (!p.police) forEachOfficer(x, y, 2, (sq, k2) => { if (rand() < 0.3) hitOfficer(sq, k2, 0.3, 'flashbang'); });
  }

  // ------------------------------------------------------------------ fires
  const live = new Set(); // fires this system started (to detect fires removed by someone else, e.g. the day reset)
  function finishFire(f, silent) {
    live.delete(f);
    if (f.prop >= 0 && props[f.prop] && props[f.prop].state === 'burning') props[f.prop].state = 'burnt';
    if (f.shop >= 0 && shops[f.shop]) { shops[f.shop].burning = false; shops[f.shop].burnt = true; }
    if (!silent) sim.emit('fireOut', f.x, f.y, { kind: f.kind, id: f.id });
  }
  function reconcileFires() {
    const present = new Set(fires);
    for (const f of live) if (!present.has(f)) finishFire(f, true);
    for (const f of fires) if (!live.has(f)) { live.add(f); f.fuel ??= fuelFor(FK[f.kind] ? f.kind : 'molotov'); f.age ??= 0; f.prop ??= -1; f.shop ??= -1; f.explodeAt ??= -1; }
  }
  function fuelFor(kind) { const f = FK[kind]; return f.f0 + rand() * (f.f1 - f.f0); }
  function newFire(x, y, kind, r) {
    const f = FK[kind] || FK.molotov;
    const fire = { id: ++fireSerial, x, y, r: r || f.r, intensity: 0.05, kind, age: 0, fuel: fuelFor(kind), prop: -1, shop: -1, explodeAt: -1, exploded: false };
    if (sim.fires !== fires && sim.fires) fires = sim.fires;
    fires.push(fire); live.add(fire);
    S.fires++;
    sim.emit('fire', x, y, { kind, id: fire.id });
    return fire;
  }
  function igniteProp(q) {
    const p = props[q]; if (!p || p.state !== 'ok') return null;
    const fk = PROP_FIRE[p.k]; if (!fk) return null;
    p.state = 'burning';
    const fire = newFire(p.x, p.y, fk);
    fire.prop = q;
    if (PROP_FUEL[p.k]) { fire.fuel = PROP_FUEL[p.k] * (0.8 + rand() * 0.4); fire.r = 1.3; }
    if (p.k === 'car' && rand() < CAR_BOOM_P) fire.explodeAt = 40 + rand() * 80;
    return fire;
  }
  function igniteShop(si) {
    const s = shops[si]; if (!s || s.burning || s.burnt) return null;
    s.burning = true;
    const fire = newFire(s.x, s.y, 'shop');
    fire.shop = si;
    return fire;
  }
  function ignite(x, y, kind = 'molotov', r) {
    if (!(x === x && y === y)) return null;
    if (kind === 'shop') {
      let best = -1, bd = 1e9;
      gridQuery(shopGrid, shops, x, y, 8, (q, d2) => { if (d2 < bd && !shops[q].burning && !shops[q].burnt) { bd = d2; best = q; } });
      if (best >= 0) return igniteShop(best);
    } else if (kind !== 'molotov' && kind !== 'barricade') {
      let best = -1, bd = 1e9;
      gridQuery(propGrid, props, x, y, 4, (q, d2) => { const p = props[q]; if (d2 < bd && p.state === 'ok' && PROP_FIRE[p.k] === kind) { bd = d2; best = q; } });
      if (best >= 0) return igniteProp(best);
    }
    if (!FK[kind]) kind = 'molotov';
    return newFire(x, y, kind, r);
  }
  function fireTick(f, T) {
    // spread to props / shops within reach; probability per second scaled by intensity and distance
    // reach: parked cars sit ~6 m apart centre to centre, so a car fire must reach ~8 m to jump to the next car
    const reach = f.kind === 'molotov' ? 3 : f.kind === 'car' ? CAR_REACH : f.r + 2.5, I = f.intensity;
    if (I < 0.2) return;
    gridQuery(propGrid, props, f.x, f.y, reach, (q, d2) => {
      const p = props[q]; if (p.state !== 'ok' || !PROP_P[p.k] || q === f.prop) return;
      const fall = 1 - Math.sqrt(d2) / reach;
      const mult = f.kind === 'molotov' ? 1.5 : 1;
      if (rand() < PROP_P[p.k] * mult * I * fall * T) igniteProp(q);
    });
    if (f.kind !== 'bin') {
      const sr = f.kind === 'shop' ? 9 : f.r + 1.5;
      const ps = f.kind === 'molotov' ? 0.01 : f.kind === 'car' ? 0.0015 : 0.003; // v1.5: was 0.02 / 0.004 / 0.006
      gridQuery(shopGrid, shops, f.x, f.y, sr, (q, d2) => {
        if (q === f.shop || shops[q].burning || shops[q].burnt) return;
        if (rand() < ps * I * (1 - Math.sqrt(d2) / sr) * T) igniteShop(q);
      });
    }
  }
  function updateFires(dt) {
    if (sim.fires !== fires) fires = sim.fires || (sim.fires = []);
    if (live.size !== fires.length) reconcileFires();
    tickAcc += dt;
    const tick = tickAcc >= 0.5; const T = tickAcc;
    if (tick) tickAcc = 0;
    for (let n = fires.length - 1; n >= 0; n--) {
      const f = fires[n], FKf = FK[f.kind] || FK.molotov;
      f.age += dt;
      const left = f.fuel - f.age;
      if (left <= 0) {
        fires.splice(n, 1);
        finishFire(f, false);
        continue;
      }
      let I = Math.min(1, f.age / FKf.ramp) * Math.min(1, left / (0.3 * f.fuel));
      if (f.boost > 0) { f.boost -= dt; I = Math.min(1, I + 0.4); }
      f.intensity = Math.max(0.02, I);
      // car explosion
      if (f.explodeAt > 0 && !f.exploded && f.age >= f.explodeAt) {
        f.exploded = true; f.boost = 15; S.carExplosions++;
        explode(f.x, f.y, 1.2);
      }
      // repel + burn people within reach
      if (I > 0.1) {
        const R = f.r + 1.5;
        forEachNear(f.x, f.y, R, (j, ex, ey, d2) => {
          if (!isUp(j)) return;
          const d = Math.sqrt(d2) + 1e-3, fall = 1 - d / R;
          const a = (3 + 6 * fall) * I; // m/s^2 outward
          extFx[j] += ex / d * a; extFy[j] += ey / d * a;
          if (tick && d < f.r) hitAgent(j, 0.04 * I * T * (1 - d / f.r * 0.5), 'fire');
        });
        if (tick) forEachOfficer(f.x, f.y, f.r, (sq, k2) => hitOfficer(sq, k2, 0.03 * I * T, 'fire'));
      }
      if (tick) fireTick(f, T);
    }
  }
  const NEAR = [];
  function firesNear(x, y, r) {
    NEAR.length = 0;
    for (let n = 0; n < fires.length; n++) {
      const f = fires[n], dx = f.x - x, dy = f.y - y, rr = r + f.r;
      if (dx * dx + dy * dy < rr * rr) NEAR.push(f);
    }
    return NEAR;
  }
  function nearestFire(x, y, r) {
    let best = null, bd = r * r;
    for (let n = 0; n < fires.length; n++) { const f = fires[n], dx = f.x - x, dy = f.y - y, d2 = dx * dx + dy * dy; if (d2 < bd) { bd = d2; best = f; } }
    return best;
  }

  // ------------------------------------------------------------------ explosions
  function explode(x, y, power = 1) {
    power = Math.max(0.1, power);
    const sp = Math.sqrt(power), Rcore = 3 * sp, Rk = 10 * sp, Rp = 25 * sp, k = 1 / lastDt;
    S.explosions++;
    sim.emit('explosion', x, y, { power });
    forEachNear(x, y, Rp, (j, ex, ey, d2) => {
      if (!isUp(j)) return;
      const d = Math.sqrt(d2) + 1e-3;
      if (d < Rk) { const dv = 6 * power * (1 - d / Rk); extFx[j] += ex / d * dv * k; extFy[j] += ey / d * dv * k; }
      if (d < Rcore) hitAgent(j, (0.3 + rand() * 0.9) * power * (1 - d / Rcore) + 0.15, 'blast');
      if (isUp(j) && rand() < 1 - d / Rp) makePanic(j, 6 + rand() * 14, ex, ey);
    });
    forEachOfficer(x, y, Rcore * 1.3, (sq, k2, ex, ey, d2) => hitOfficer(sq, k2, (0.3 + rand() * 0.6) * power * (1 - Math.sqrt(d2) / (Rcore * 1.3)) + 0.1, 'blast'));
    gridQuery(propGrid, props, x, y, Rcore + 1, (q) => { if (props[q].state === 'ok' && PROP_FIRE[props[q].k] && rand() < 0.2) igniteProp(q); }); // v1.5: was Rcore+2, 0.5
    gridQuery(shopGrid, shops, x, y, Rcore + 1, (q) => { if (rand() < 0.1 * power) igniteShop(q); }); // v1.5: was 0.25
  }

  // ------------------------------------------------------------------ cars as soft obstacles
  function carRepel() {
    if (!carA) return;
    const NA = sim.NA;
    for (let i = 0; i < NA; i++) {
      const x = px[i], y = py[i], c = Math.floor(y / CELL) * COLS + Math.floor(x / CELL);
      const a1 = carA[c]; if (!a1) continue;
      if (act[i] === A_DOWN || act[i] === A_ARRESTED) continue;
      repelFrom(i, x, y, a1 - 1);
      const b1 = carB[c]; if (b1) repelFrom(i, x, y, b1 - 1);
    }
  }
  function repelFrom(i, x, y, q) {
    const p = props[q]; const ca = p.ca, sa = p.sa;
    const dx = x - p.x, dy = y - p.y;
    const lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
    const ox = CAR_HL + 0.35 - Math.abs(lx), oy = CAR_HW + 0.35 - Math.abs(ly);
    if (ox <= 0 || oy <= 0) return;
    // push out along the axis of least penetration (local frame), as an acceleration
    let fx, fy;
    if (oy < ox) { const s = (ly >= 0 ? 1 : -1) * (4 + 14 * oy); fx = -sa * s; fy = ca * s; }
    else { const s = (lx >= 0 ? 1 : -1) * (4 + 14 * ox); fx = ca * s; fy = sa * s; }
    extFx[i] += fx; extFy[i] += fy;
  }

  // ------------------------------------------------------------------ debug
  function combatDemo(x, y) {
    if (!walkAt(x, y)) { const c = sim.nearestWalkable(Math.floor(x / CELL), Math.floor(y / CELL), 30); if (c >= 0) { x = sim.cellX(c); y = sim.cellY(c); } }
    const kinds = ['rock', 'rock', 'paving', 'bottle', 'bottle', 'molotov', 'molotov', 'firework', 'firework', 'gas', 'lbd', 'lbd', 'flashbang'];
    let thrown = 0;
    for (let n = 0; n < 24; n++) {
      const kind = kinds[n % kinds.length];
      let sx = x, sy = y;
      for (let t = 0; t < 12; t++) { const a = rand() * Math.PI * 2, d = 12 + rand() * 18; if (walkAt(x + Math.cos(a) * d, y + Math.sin(a) * d)) { sx = x + Math.cos(a) * d; sy = y + Math.sin(a) * d; break; } }
      const owner = kind === 'gas' || kind === 'lbd' || kind === 'flashbang' ? 'P' : 'C';
      if (throwProjectile(kind, sx, sy, x + (rand() - 0.5) * 8, y + (rand() - 0.5) * 8, owner)) thrown++;
    }
    const cars = [];
    gridQuery(propGrid, props, x, y, 60, (q, d2) => { if (props[q].k === 'car' && props[q].state === 'ok') cars.push([d2, q]); });
    cars.sort((a, b) => a[0] - b[0]);
    const lit = [];
    for (const [, q] of cars.slice(0, 3)) { const f = igniteProp(q); if (f) lit.push(f); }
    if (lit[0]) lit[0].explodeAt = lit[0].age + 8; // guaranteed bang for the FX test
    if (!lit.length) lit.push(newFire(x, y, 'barricade'));
    return { thrown, fires: lit.map(f => f.id), x, y };
  }

  Object.assign(sim.api, { throwProjectile, ignite, explode, firesNear, nearestFire, combatDemo, combatStats: () => ({ ...S, projectiles: projectiles.length, fireCount: fires.length }) });
  if (!sim.api.hitAgent) sim.api.hitAgent = hitAgent;
  if (!sim.api.healAgent) sim.api.healAgent = healAgent;
  Object.assign(sim, { throwProjectile, ignite, explode, firesNear });

  return {
    name: 'combat',
    init() {
      projectiles = sim.projectiles = [];
      fires = sim.fires = [];
      if (!Array.isArray(sim.props) || !sim.props.length) sim.props = (sim.data.props || []).map(p => ({ ...p, state: 'ok' }));
      props = sim.props;
      for (const p of props) { if (!p.state) p.state = 'ok'; if (p.k === 'car') { const a = p.a || 0; p.ca = Math.cos(a); p.sa = Math.sin(a); } }
      propGrid = buildGrid(props);
      buildCarCells();
      shops = sim.shops || []; shopGrid = buildGrid(shops); // riots inits before combat
    },
    update(dt) {
      const t0 = performance.now();
      lastDt = dt;
      if (sim.shops !== shops) { shops = sim.shops || []; shopGrid = buildGrid(shops); } // riots owns shops; index lazily
      updateProjectiles(dt);
      updateFires(dt);
      carRepel();
      const ms = performance.now() - t0;
      S.ms = S.ms * 0.95 + ms * 0.05; if (ms > S.msMax) S.msMax = ms;
    },
  };
}
