// Visual FX layer for the 2D tactical map (Canvas2D).
// Reads the contract collections (docs/contract.md) every frame and keeps its own visual state:
//   src.projectiles  {id, kind, x, y, z, vx, vy, vz, owner, age, alive}
//   src.fires        {id, x, y, r, intensity, kind, age}
//   src.props        {x, y, k, state, a?}
//   src.shops        {x, y, k, n, v, looted, burning}
//   src.onEvent(fn) (preferred, multi-subscriber) or src.drainEvents() -> [{type, x, y, ...}]
// Nothing here mutates the sim. Missing collections are simply skipped.
//
// API: const fx = createFX2D();
//   fx.update(dt, src)        real-time dt (s); src = sim (or any object exposing the collections)
//   fx.drawUnder(ctx, view)   decals + props + fire scorch; call after the map, before agents
//   fx.draw(ctx, view)        trails, projectiles, fires, smoke, sparks, rings, icons; after agents/police
//   fx.shake                  {x, y} screen-px offset to apply to the frame (screen shake)
//   fx.opts                   toggles: projectiles, trails, explosions, fires, smoke, sparks, decals, props, icons, shake
//   fx.night                  0..1 darkening tint drawn under the lights (0 = daylight map)
//   fx.stats()                {particles, trails, fires, decals, bursts, ms}
//   fx.emitEvent(e)           inject one event directly (same shape as sim events)
// `view` = { s, cx, cy, vw, vh }: px per metre, camera centre (world m), viewport size in CSS px.
//   screenX = (x - cx) * s + vw / 2,  screenY = vh / 2 - (y - cy) * s   (y north, screen north up)
// Height cue: an object at height z is drawn ZK*z metres "up-screen" from its ground point, with a shadow on the ground.

const TAU = Math.PI * 2;
const MAXP = 6000, MAXDEC = 1400, MAXBURST = 400, TRAIL_N = 48, GHOST_T = 1.1; // GHOST_T: trail fade-out after landing (s)
const ZK = 0.75;
const DEFAULT_WIND = { x: 0.35, y: 0.12 };

// particle types
const P_SMOKE = 0, P_FLAME = 1, P_SPARK = 2, P_EMBER = 3, P_GLASS = 4, P_DEBRIS = 5, P_STREAK = 6;
// smoke colours
const S_DARK = 0, S_GREY = 1, S_GAS = 2, S_DUST = 3;
// spark/glow colours
const C_HOT = 0, C_ORANGE = 1, C_RED = 2, C_GREEN = 3, C_CYAN = 4, C_MAGENTA = 5, C_GOLD = 6, C_WHITE = 7, C_BLUE = 8;
const SPARK_CSS = ['#fff1a8', '#ff7a12', '#ff2d2d', '#3dff6e', '#3fd8ff', '#ff3fd2', '#ffc21a', '#ffffff', '#4f8dff'];
const SPARK_RGB = [[255, 241, 168], [255, 122, 18], [255, 45, 45], [61, 255, 110], [63, 216, 255], [255, 63, 210], [255, 194, 26], [255, 255, 255], [79, 141, 255]];
const FW_COLS = [C_RED, C_GREEN, C_CYAN, C_MAGENTA, C_GOLD, C_BLUE];

const KIND = { // trail styles (maxAge s, width px, rgb, alpha); longer, wider and stronger so throws read at overview zoom
  rock: { age: 0.95, w: 1.8, c: '72,68,62', a: 0.8 },
  paving: { age: 1.0, w: 2.0, c: '64,60,56', a: 0.82 },
  bottle: { age: 1.0, w: 1.8, c: '24,150,68', a: 0.85 },
  molotov: { age: 1.6, w: 3.4, c: '60,52,46', a: 0.55 },
  firework: { age: 1.3, w: 2.6, c: '255,255,255', a: 0.95 },
  gas: { age: 2.6, w: 4.2, c: '222,230,170', a: 0.95 }, // tear-gas smoke: pale yellow-green over an olive under-stroke
  lbd: { age: 0.3, w: 2.2, c: '255,236,140', a: 1 },
  flashbang: { age: 0.9, w: 1.6, c: '40,40,48', a: 0.6 },
};
// who threw it: crowd = orange, police = blue (glow halo around heads when zoomed out, landing pops)
const OWNER_RGB = { C: '255,122,18', P: '79,141,255' };
const POLICE_KINDS = new Set(['gas', 'lbd', 'flashbang']);
const ownerOf = (o, kind) => o === 'P' || o === 'C' ? o : POLICE_KINDS.has(kind) ? 'P' : 'C';

// exported so other views / the legend can reuse the exact colours
export const FX_PALETTE = { trail: KIND, spark: SPARK_CSS };

const mkCanvas =(w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
function radial(size, stops) {
  const c = mkCanvas(size, size), g = c.getContext('2d'), h = size / 2;
  const gr = g.createRadialGradient(h, h, 0, h, h, h);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return c;
}
// lumpy smoke puff: several overlapping soft blobs, optional darker rim for contrast on light ground
function puff(size, [r, g, b], rim, seed) {
  const c = mkCanvas(size, size), x = c.getContext('2d'), h = size / 2;
  let s = seed * 9301 + 49297; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let k = 0; k < 7; k++) {
    const a = rnd() * TAU, d = k === 0 ? 0 : h * (0.18 + rnd() * 0.22), rr = h * (k === 0 ? 0.62 : 0.38 + rnd() * 0.18);
    const cx = h + Math.cos(a) * d, cy = h + Math.sin(a) * d;
    const gr = x.createRadialGradient(cx, cy, 0, cx, cy, rr);
    gr.addColorStop(0, `rgba(${r},${g},${b},0.55)`); gr.addColorStop(0.6, `rgba(${r},${g},${b},0.32)`);
    if (rim) gr.addColorStop(0.86, `rgba(${rim[0]},${rim[1]},${rim[2]},0.22)`);
    gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
    x.fillStyle = gr; x.fillRect(0, 0, size, size);
  }
  return c;
}
function scorchSprite(seed) {
  const S = 96, c = mkCanvas(S, S), x = c.getContext('2d'), h = S / 2;
  let s = seed * 7919 + 13; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const gr = x.createRadialGradient(h, h, 0, h, h, h);
  gr.addColorStop(0, 'rgba(18,14,12,0.85)'); gr.addColorStop(0.45, 'rgba(28,24,20,0.6)'); gr.addColorStop(0.8, 'rgba(40,34,30,0.22)'); gr.addColorStop(1, 'rgba(40,34,30,0)');
  x.fillStyle = gr; x.fillRect(0, 0, S, S);
  // splatter rays
  x.fillStyle = 'rgba(20,16,14,0.3)';
  for (let k = 0; k < 9; k++) {
    const a = rnd() * TAU, d0 = h * 0.35, d1 = h * (0.6 + rnd() * 0.38), w = 1.5 + rnd() * 3;
    x.beginPath(); x.moveTo(h + Math.cos(a + 0.12) * d0, h + Math.sin(a + 0.12) * d0); x.lineTo(h + Math.cos(a) * d1, h + Math.sin(a) * d1);
    x.lineTo(h + Math.cos(a - 0.12) * d0, h + Math.sin(a - 0.12) * d0); x.fill();
    x.beginPath(); x.arc(h + Math.cos(a) * d1, h + Math.sin(a) * d1, w * 0.6, 0, TAU); x.fill();
  }
  return c;
}
function glassSprite(seed) {
  const S = 48, c = mkCanvas(S, S), x = c.getContext('2d');
  let s = seed * 104729 + 7; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let k = 0; k < 22; k++) {
    const a = rnd() * TAU, d = Math.sqrt(rnd()) * S * 0.45, cx = S / 2 + Math.cos(a) * d, cy = S / 2 + Math.sin(a) * d, r = 1 + rnd() * 2.6, b = rnd() * TAU;
    x.fillStyle = rnd() < 0.5 ? 'rgba(210,240,255,0.95)' : 'rgba(120,170,200,0.9)';
    x.beginPath(); x.moveTo(cx + Math.cos(b) * r, cy + Math.sin(b) * r); x.lineTo(cx + Math.cos(b + 2.2) * r * 0.6, cy + Math.sin(b + 2.2) * r * 0.6); x.lineTo(cx + Math.cos(b + 3.9) * r * 0.8, cy + Math.sin(b + 3.9) * r * 0.8); x.fill();
  }
  return c;
}
function debrisSprite(seed) {
  const S = 48, c = mkCanvas(S, S), x = c.getContext('2d');
  let s = seed * 31337 + 3; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let k = 0; k < 18; k++) {
    const a = rnd() * TAU, d = Math.sqrt(rnd()) * S * 0.46, cx = S / 2 + Math.cos(a) * d, cy = S / 2 + Math.sin(a) * d, r = 0.8 + rnd() * 2.2;
    x.fillStyle = rnd() < 0.6 ? 'rgba(60,55,50,0.85)' : 'rgba(120,112,100,0.85)';
    x.fillRect(cx - r, cy - r, r * 2, r * 1.4);
  }
  return c;
}

// cheap smooth noise in [-1, 1]
const noise = t => (Math.sin(t * 1.7) * 0.5 + Math.sin(t * 3.1 + 1.3) * 0.3 + Math.sin(t * 7.3 + 2.1) * 0.2);
const hash = n => { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); n = n ^ (n >>> 15); return (n >>> 0) / 4294967296; };

export function createFX2D() {
  // ---------------------------------------------------------------- sprites
  const SMOKE_SPR = [
    [0, 1, 2].map(i => puff(64, [44, 40, 37], null, i + 1)),
    [0, 1, 2].map(i => puff(64, [118, 114, 108], null, i + 11)),
    [0, 1, 2].map(i => puff(64, [222, 230, 176], [128, 150, 30], i + 21)),
    [0, 1, 2].map(i => puff(64, [196, 178, 146], null, i + 31)),
  ];
  const SMOKE_A = [0.72, 0.66, 1, 0.7];
  const FLAME = radial(64, [[0, 'rgba(255,252,225,1)'], [0.22, 'rgba(255,224,110,0.98)'], [0.5, 'rgba(255,128,20,0.78)'], [0.78, 'rgba(210,45,8,0.32)'], [1, 'rgba(160,20,0,0)']]);
  const FLAME_DARK = radial(64, [[0, 'rgba(120,20,0,0.55)'], [0.6, 'rgba(90,15,0,0.28)'], [1, 'rgba(60,10,0,0)']]);
  const GLOW = SPARK_RGB.map(([r, g, b]) => radial(32, [[0, `rgba(${r},${g},${b},1)`], [0.25, `rgba(${r},${g},${b},0.7)`], [1, `rgba(${r},${g},${b},0)`]]));
  const LIGHT = radial(128, [[0, 'rgba(255,170,60,0.9)'], [0.35, 'rgba(255,120,30,0.45)'], [1, 'rgba(255,90,20,0)']]);
  const FLASH = radial(128, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,248,215,0.9)'], [0.65, 'rgba(255,200,110,0.35)'], [1, 'rgba(255,170,60,0)']]);
  const WFLASH = radial(128, [[0, 'rgba(255,255,255,1)'], [0.45, 'rgba(240,248,255,0.8)'], [1, 'rgba(220,235,255,0)']]);
  const GAS_GLOW = radial(32, [[0, 'rgba(214,224,120,1)'], [0.4, 'rgba(180,200,70,0.7)'], [1, 'rgba(150,172,34,0)']]);
  const SHADOW = radial(32, [[0, 'rgba(0,0,0,0.55)'], [0.6, 'rgba(0,0,0,0.3)'], [1, 'rgba(0,0,0,0)']]);
  const DEC_SPR = [scorchSprite(1), scorchSprite(2), scorchSprite(3), glassSprite(1), glassSprite(2), debrisSprite(1), debrisSprite(2)];
  const D_SCORCH = 0, D_GLASS = 3, D_DEBRIS = 5;

  // ---------------------------------------------------------------- particles (SoA pool, swap-remove)
  const X = new Float32Array(MAXP), Y = new Float32Array(MAXP), VX = new Float32Array(MAXP), VY = new Float32Array(MAXP);
  const LIFE = new Float32Array(MAXP), MAXL = new Float32Array(MAXP), SIZE = new Float32Array(MAXP), GROW = new Float32Array(MAXP);
  const DRAG = new Float32Array(MAXP), WINDK = new Float32Array(MAXP), ROT = new Float32Array(MAXP);
  const TYPE = new Uint8Array(MAXP), COL = new Uint8Array(MAXP), VAR = new Uint8Array(MAXP);
  let NP = 0;
  function emit(type, col, x, y, vx, vy, life, size, grow = 0, drag = 0, windk = 0) {
    if (NP >= MAXP) return -1;
    const i = NP++;
    X[i] = x; Y[i] = y; VX[i] = vx; VY[i] = vy; LIFE[i] = 0; MAXL[i] = life; SIZE[i] = size; GROW[i] = grow;
    DRAG[i] = drag; WINDK[i] = windk; TYPE[i] = type; COL[i] = col; VAR[i] = (Math.random() * 3) | 0; ROT[i] = Math.random() * TAU;
    return i;
  }
  function killP(i) {
    const j = --NP;
    if (i === j) return;
    X[i] = X[j]; Y[i] = Y[j]; VX[i] = VX[j]; VY[i] = VY[j]; LIFE[i] = LIFE[j]; MAXL[i] = MAXL[j]; SIZE[i] = SIZE[j]; GROW[i] = GROW[j];
    DRAG[i] = DRAG[j]; WINDK[i] = WINDK[j]; TYPE[i] = TYPE[j]; COL[i] = COL[j]; VAR[i] = VAR[j]; ROT[i] = ROT[j];
  }
  const R = Math.random, rr = (a, b) => a + (b - a) * R();
  function burstDir(type, col, x, y, n, v0, v1, life0, life1, size, grow = 0, drag = 0, windk = 0) {
    for (let k = 0; k < n; k++) { const a = R() * TAU, v = rr(v0, v1); emit(type, col, x, y, Math.cos(a) * v, Math.sin(a) * v, rr(life0, life1), size * rr(0.7, 1.3), grow, drag, windk); }
  }

  // ---------------------------------------------------------------- decals (ring buffer)
  const DX = new Float32Array(MAXDEC), DY = new Float32Array(MAXDEC), DS = new Float32Array(MAXDEC), DA = new Float32Array(MAXDEC), DAL = new Float32Array(MAXDEC);
  const DK = new Uint8Array(MAXDEC);
  let ND = 0, DHEAD = 0;
  function decal(kind, x, y, size, alpha = 1) {
    const i = DHEAD; DHEAD = (DHEAD + 1) % MAXDEC; if (ND < MAXDEC) ND++;
    DX[i] = x; DY[i] = y; DS[i] = size; DA[i] = R() * TAU; DAL[i] = alpha; DK[i] = kind;
  }
  const scorch = (x, y, size, a = 0.9) => decal(D_SCORCH + ((R() * 3) | 0), x, y, size, a);

  // ---------------------------------------------------------------- bursts (rings, flashes, icons)
  const bursts = [];
  function burst(o) { if (bursts.length >= MAXBURST) bursts.shift(); o.t = 0; bursts.push(o); return o; }

  // ---------------------------------------------------------------- state
  const trails = new Map(); // projectile id -> trail
  const fires = new Map();  // fire id -> visual state
  const emitters = [];      // short-lived ground emitters (gas canisters)
  const propState = new WeakMap();
  let T = 0, lastView = null, trauma = 0, wind = DEFAULT_WIND, drawMs = 0, updMs = 0, quality = 1;
  const fx = {
    shake: { x: 0, y: 0 },
    night: 0,
    opts: { projectiles: true, trails: true, explosions: true, fires: true, smoke: true, sparks: true, decals: true, props: true, icons: true, shake: true },
  };

  const visible = (x, y, m) => {
    const v = lastView; if (!v) return true;
    const X0 = (x - v.cx) * v.s + v.vw / 2, Y0 = v.vh / 2 - (y - v.cy) * v.s, mp = m * v.s + 40;
    return X0 > -mp && Y0 > -mp && X0 < v.vw + mp && Y0 < v.vh + mp;
  };
  const zoom = () => lastView ? lastView.s : 2;

  // ---------------------------------------------------------------- events
  function evType(e) { return typeof e.t === 'string' ? e.t : (e.type || e.ev || e.name); }
  function onEvent(e) {
    const ty = evType(e), x = +e.x, y = +e.y, o = fx.opts;
    if (!(x === x && y === y)) return;
    const s = zoom(), fine = s >= 0.6;
    switch (ty) {
      case 'explosion': {
        if (!o.explosions) return;
        const p = Math.max(0.2, e.power ?? 1), Rm = 4 + 4 * p;
        burst({ k: 'flash', x, y, r: Rm * 1.7, dur: 0.28, spr: FLASH });
        burst({ k: 'ring', x, y, r0: 1, r1: Rm * 2.2, dur: 0.55, w: 4, col: '255,236,200', dark: true });
        if (o.sparks && fine) burstDir(P_SPARK, R() < 0.5 ? C_HOT : C_ORANGE, x, y, Math.round(30 + 40 * p), 10, 30 * Math.sqrt(p), 0.35, 0.9, 1.2, 0, 2.6);
        if (fine) burstDir(P_DEBRIS, 0, x, y, Math.round(8 + 10 * p), 4, 14, 0.7, 1.4, 0.35, 0, 3.5);
        burstDir(P_FLAME, 0, x, y, Math.round(6 + 6 * p), 2, 7, 0.35, 0.6, Rm * 0.55, -Rm * 0.4, 3);
        if (o.smoke) for (let k = 0; k < 8 + 6 * p; k++) { const a = R() * TAU, v = rr(1, 4); emit(P_SMOKE, S_DARK, x + Math.cos(a) * Rm * 0.3, y + Math.sin(a) * Rm * 0.3, Math.cos(a) * v, Math.sin(a) * v + 0.6, rr(5, 9), Rm * 0.45, Rm * 0.22, 0.6, 3); }
        if (o.decals) { scorch(x, y, Rm * 1.5); for (let k = 0; k < 4; k++) decal(D_DEBRIS + (k & 1), x + rr(-Rm, Rm), y + rr(-Rm, Rm), rr(2.5, 4.5), 0.9); }
        addTrauma(x, y, 0.5 * p);
        return;
      }
      case 'impact': {
        const k = e.kind;
        if (k === 'bottle' || k === 'molotov') return onEvent({ t: 'shatter', x, y });
        if (k === 'firework') { // coloured starburst
          const c1 = FW_COLS[(R() * FW_COLS.length) | 0], c2 = FW_COLS[(R() * FW_COLS.length) | 0];
          if (o.sparks && fine) { burstDir(P_SPARK, c1, x, y, 26, 6, 16, 0.4, 0.9, 1, 0, 2.2); burstDir(P_SPARK, c2, x, y, 14, 3, 9, 0.4, 0.8, 1, 0, 2.2); burstDir(P_SPARK, C_HOT, x, y, 8, 2, 6, 0.2, 0.4, 1, 0, 2); }
          burst({ k: 'flash', x, y, r: 6, dur: 0.22, spr: GLOW[c1] });
          if (o.smoke) burstDir(P_SMOKE, S_GREY, x, y, 2, 0.3, 1, 2, 3, 1, 0.8, 1, 2);
          return;
        }
        burstDir(P_SMOKE, S_DUST, x, y, k === 'lbd' ? 1 : 3, 0.5, 2, 0.5, 0.9, 0.6, 1.4, 2);
        if (o.sparks && fine) burstDir(P_SPARK, k === 'lbd' ? C_HOT : C_WHITE, x, y, k === 'lbd' ? 5 : 3, 4, 10, 0.12, 0.3, 0.5, 0, 6);
        return;
      }
      case 'shatter':
        if (o.sparks && fine) burstDir(P_GLASS, C_WHITE, x, y, 14, 1.5, 6, 0.5, 1.2, 0.35, 0, 4);
        if (o.decals) decal(D_GLASS + ((R() * 2) | 0), x, y, rr(1.6, 2.6), 1);
        return;
      case 'flash':
        if (!o.explosions) return;
        burst({ k: 'flash', x, y, r: 16, dur: 0.4, spr: WFLASH, strong: true });
        burst({ k: 'ring', x, y, r0: 2, r1: 20, dur: 0.45, w: 3, col: '255,255,255', dark: true });
        if (o.smoke) burstDir(P_SMOKE, S_GREY, x, y, 5, 0.5, 2, 2, 3.5, 1.2, 1, 1, 2);
        if (o.sparks && fine) burstDir(P_SPARK, C_WHITE, x, y, 10, 6, 16, 0.15, 0.35, 0.6, 0, 5);
        addTrauma(x, y, 0.18);
        return;
      case 'fire':
        if (!o.fires) return;
        burstDir(P_FLAME, 0, x, y, 8, 1, 5, 0.3, 0.6, 2.2, -1.5, 2);
        if (o.sparks && fine) burstDir(P_EMBER, C_ORANGE, x, y, 10, 2, 7, 0.6, 1.4, 0.25, 0, 1.5, 3);
        burst({ k: 'ring', x, y, r0: 0.5, r1: 7, dur: 0.35, w: 2.5, col: '255,150,40' });
        return;
      case 'fireOut':
        if (o.smoke) burstDir(P_SMOKE, S_GREY, x, y, 5, 0.3, 1.2, 4, 7, 2, 0.6, 0.5, 4);
        return;
      case 'loot':
        if (o.icons) burst({ k: 'icon', icon: '$', x, y, dur: 1.4 });
        if (o.sparks && fine) burstDir(P_GLASS, C_WHITE, x, y, 10, 1, 5, 0.5, 1.1, 0.35, 0, 4);
        if (o.decals) decal(D_GLASS + ((R() * 2) | 0), x + rr(-1, 1), y + rr(-1, 1), rr(2, 3), 1);
        return;
      case 'arrest':
        if (o.icons) burst({ k: 'icon', icon: 'cuff', x, y, dur: 1.3 });
        burst({ k: 'ring', x, y, r0: 0.5, r1: 4, dur: 0.45, w: 2.5, col: '70,130,255' });
        burst({ k: 'flash', x, y, r: 4, dur: 0.25, spr: GLOW[C_BLUE] });
        return;
      case 'brawl':
        if (o.icons) burst({ k: 'icon', icon: 'stars', x, y, dur: 0.9 });
        if (o.smoke) burstDir(P_SMOKE, S_DUST, x, y, 2, 0.5, 1.5, 0.5, 0.9, 0.7, 1, 2);
        return;
      case 'injury':
        if (o.icons) burst({ k: 'icon', icon: 'cross', x, y, dur: 1.2 });
        return;
      case 'charge': {
        let dx = e.dx, dy = e.dy, pts = null;
        const sq = typeof e.squad === 'object' ? e.squad : (lastSrc?.squads || []).find(q => q.id === e.squad);
        if (sq) { if (dx == null) { dx = sq.dx; dy = sq.dy; } if (sq.ox) pts = sq; }
        if (dx == null) { dx = 1; dy = 0; }
        const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
        for (let k = 0; k < 26; k++) {
          let px = x + rr(-6, 6) * dy, py = y - rr(-6, 6) * dx;
          if (pts && pts.n) { const j = (R() * pts.n) | 0; px = pts.ox[j]; py = pts.oy[j]; }
          const v = rr(5, 9);
          emit(P_STREAK, 0, px - dx * rr(0, 2), py - dy * rr(0, 2), dx * v, dy * v, rr(0.5, 0.9), rr(1.5, 3), 0, 2);
          if (k % 3 === 0) emit(P_SMOKE, S_DUST, px, py, dx * 2, dy * 2, rr(0.8, 1.4), 0.9, 1.6, 1.5);
        }
        return;
      }
      case 'throw':
        if (s >= 1.2) burst({ k: 'swish', x, y, a: Math.atan2(e.ty != null ? e.ty - y : R() - 0.5, e.tx != null ? e.tx - x : R() - 0.5), dur: 0.22, owner: e.owner });
        return;
      case 'gas':
        if (o.smoke) { emitters.push({ x, y, t: 0, dur: 7, acc: 0 }); if (emitters.length > 60) emitters.shift(); burstDir(P_SMOKE, S_GAS, x, y, 8, 1, 4, 2, 4, 1.4, 1.8, 1.2, 2); }
        if (o.explosions) burst({ k: 'pop', x, y, dur: 0.9, kind: 'gas', owner: 'P' });
        return;
    }
  }
  function addTrauma(x, y, amt) {
    const v = lastView; if (!v) { trauma = Math.min(1, trauma + amt * 0.5); return; }
    const X0 = (x - v.cx) * v.s + v.vw / 2 - v.vw / 2, Y0 = v.vh / 2 - (y - v.cy) * v.s - v.vh / 2;
    const diag = Math.hypot(v.vw, v.vh) / 2, fall = Math.max(0, 1 - Math.hypot(X0, Y0) / (diag * 1.1));
    const zf = Math.min(1.4, Math.max(0.25, v.s / 2.5));
    trauma = Math.min(1, trauma + amt * fall * zf);
  }

  // ---------------------------------------------------------------- update
  let lastSrc = null;
  const subscribed = new WeakSet(), queue = [];
  fx.emitEvent = e => onEvent(e);
  fx.update = function (dt, src) {
    const t0 = performance.now();
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    T += dt;
    lastSrc = src;
    if (src) {
      const w = src.wind || src.WIND || src.gasWind; if (w && typeof w.x === 'number') wind = w;
    }
    const s = zoom(), fine = s >= 0.6, o = fx.opts;
    quality = NP > MAXP * 0.85 ? 0.35 : NP > MAXP * 0.65 ? 0.65 : 1;

    // events
    if (src) {
      let evs = null;
      if (typeof src.onEvent === 'function') { // multi-subscriber bus: subscribe once per source, never steal events
        if (!subscribed.has(src)) { subscribed.add(src); src.onEvent(e => { if (queue.length < 3000) queue.push(e); }); }
        if (queue.length) { evs = queue.slice(); queue.length = 0; }
      } else if (typeof src.drainEvents === 'function') evs = src.drainEvents();
      else if (Array.isArray(src.events) && src.events.length) { evs = src.events.slice(); src.events.length = 0; }
      if (evs) for (let k = 0; k < evs.length; k++) onEvent(evs[k]);
    }

    // projectiles -> trails
    const P = src && src.projectiles;
    for (const tr of trails.values()) tr.seen = false;
    if (P) for (let k = 0; k < P.length; k++) {
      const p = P[k]; if (!p || p.alive === false) continue;
      const id = p.id ?? k;
      let tr = trails.get(id);
      if (!tr || tr.dead) {
        tr = { id, kind: p.kind, n: 0, head: 0, xs: new Float32Array(TRAIL_N), ys: new Float32Array(TRAIL_N), zs: new Float32Array(TRAIL_N), ts: new Float32Array(TRAIL_N),
          dead: false, deadT: 0, col: FW_COLS[(hash(id | 0) * FW_COLS.length) | 0], acc: 0, x: p.x, y: p.y, z: p.z || 0, vx: 0, vy: 0, owner: 'C' };
        trails.set(id, tr);
      }
      tr.seen = true; tr.kind = p.kind; tr.owner = ownerOf(p.owner, p.kind);
      const z = p.z || 0, lx = tr.x, ly = tr.y + tr.z * ZK;
      tr.x = p.x; tr.y = p.y; tr.z = z; tr.vx = p.vx || 0; tr.vy = p.vy || 0;
      const hx = p.x, hy = p.y + z * ZK;
      const li = (tr.head + TRAIL_N - 1) % TRAIL_N;
      if (!tr.n || Math.hypot(hx - tr.xs[li], hy - tr.ys[li]) > 0.3 || T - tr.ts[li] > 0.08) {
        tr.xs[tr.head] = hx; tr.ys[tr.head] = hy; tr.zs[tr.head] = z; tr.ts[tr.head] = T;
        tr.head = (tr.head + 1) % TRAIL_N; if (tr.n < TRAIL_N) tr.n++;
      }
      // per-kind particle emission along the path
      if (!o.projectiles || !visible(hx, hy, 10)) continue;
      const moved = Math.hypot(hx - lx, hy - ly);
      if (p.kind === 'molotov') {
        tr.acc += moved * quality;
        while (tr.acc > 0.8) { tr.acc -= 0.8; const f = R(), ex = lx + (hx - lx) * f, ey = ly + (hy - ly) * f;
          if (o.smoke) emit(P_SMOKE, S_DARK, ex, ey, rr(-0.3, 0.3), rr(-0.3, 0.3) + 0.4, rr(1.2, 2.2), 0.5, 0.9, 0.5, 2);
          emit(P_FLAME, 0, ex, ey, rr(-0.5, 0.5), rr(-0.5, 0.5), rr(0.15, 0.3), 0.9, -1.5); }
      } else if (p.kind === 'firework') {
        tr.acc += dt * 90 * quality;
        while (tr.acc > 1) { tr.acc -= 1; if (!o.sparks || !fine) continue; const a = R() * TAU, v = rr(1, 5);
          emit(P_SPARK, R() < 0.35 ? C_HOT : tr.col, hx, hy, Math.cos(a) * v - tr.vx * 0.15, Math.sin(a) * v - tr.vy * 0.15, rr(0.25, 0.6), 0.5, 0, 2); }
      } else if (p.kind === 'gas') {
        tr.acc += moved * quality;
        while (tr.acc > 0.8) { tr.acc -= 0.8; const f = R(); if (o.smoke) emit(P_SMOKE, S_GAS, lx + (hx - lx) * f, ly + (hy - ly) * f, rr(-0.4, 0.4), rr(-0.4, 0.4), rr(2.2, 3.4), 1.0, 1.4, 0.3, 2); }
      }
    }
    for (const [id, tr] of trails) {
      if (tr.seen) continue;
      if (!tr.dead) { // landed: a brief pop at the landing point (screen-min size, so it shows at overview zoom)
        tr.dead = true; tr.deadT = 0;
        if (o.explosions && tr.kind !== 'molotov' && tr.kind !== 'firework' && tr.kind !== 'flashbang' && tr.kind !== 'gas' && visible(tr.x, tr.y, 10))
          burst({ k: 'pop', x: tr.x, y: tr.y, dur: 0.6, kind: tr.kind, owner: tr.owner });
      }
      tr.deadT += dt;
      if (tr.deadT > GHOST_T) trails.delete(id);
    }

    // fires
    const F = src && src.fires;
    for (const st of fires.values()) st.seen = false;
    if (F) for (let k = 0; k < F.length; k++) {
      const f = F[k]; if (!f) continue;
      const id = f.id ?? k;
      let st = fires.get(id);
      if (!st) { st = { seed: R() * 100, fa: 0, ea: 0, sa: 0, x: f.x, y: f.y, r: f.r || 2, age: 0, kind: f.kind }; fires.set(id, st); }
      st.seen = true; st.x = f.x; st.y = f.y; st.r = f.r || 2; st.kind = f.kind; st.age += dt;
      st.int = Math.max(0, Math.min(1, f.intensity ?? 1));
      if (!o.fires) continue;
      const big = f.kind === 'car' || f.kind === 'shop' ? 1.6 : f.kind === 'barricade' ? 1.3 : 1;
      const Rv = st.r * (0.55 + 0.55 * st.int) * big;
      st.Rv = Rv;
      if (!visible(f.x, f.y, Rv * 8 + 40)) continue; // offscreen: no emission
      const q = quality * (fine ? 1 : 0.45);
      // flame tongues
      st.fa += dt * (6 + 16 * st.int) * big * q;
      while (st.fa > 1) { st.fa -= 1; const a = R() * TAU, d = Math.sqrt(R()) * Rv * 0.55;
        emit(P_FLAME, 0, f.x + Math.cos(a) * d, f.y + Math.sin(a) * d, wind.x * 5 + rr(-0.6, 0.6), wind.y * 5 + rr(0.6, 2.2) * Math.max(1, Rv / 3), rr(0.35, 0.8), Rv * rr(0.35, 0.7), -Rv * 0.45, 0.3); }
      // embers
      if (o.sparks && fine) { st.ea += dt * (1 + 4 * st.int) * big * q;
        while (st.ea > 1) { st.ea -= 1; emit(P_EMBER, R() < 0.6 ? C_ORANGE : C_GOLD, f.x + rr(-Rv, Rv) * 0.4, f.y + rr(-Rv, Rv) * 0.4, rr(-1.5, 1.5) + wind.x * 3, rr(-1, 2) + wind.y * 3, rr(1.2, 2.6), rr(0.12, 0.22), 0, 0.3, 4); } }
      // smoke column, drifting with the wind and "rising" up-screen
      if (o.smoke) { st.sa += dt * (1.6 + 2.6 * (0.4 + st.int)) * Math.sqrt(big) * q;
        while (st.sa > 1) { st.sa -= 1; const col = st.int < 0.3 || R() < 0.35 ? S_GREY : S_DARK;
          emit(P_SMOKE, col, f.x + wind.x * Rv * 0.6 + rr(-0.3, 0.3) * Rv, f.y + wind.y * Rv * 0.6 + rr(-0.3, 0.3) * Rv + Rv * 0.3,
            rr(-0.4, 0.4), rr(1.0, 1.8), rr(10, 15), Rv * rr(0.45, 0.7), Rv * rr(0.45, 0.7), 0.02, rr(9, 13)); } }
    }
    for (const [id, st] of fires) {
      if (st.seen) continue;
      if (fx.opts.decals) scorch(st.x, st.y, (st.r || 2) * 2.4, 0.95);
      if (fx.opts.smoke) burstDir(P_SMOKE, S_GREY, st.x, st.y, 5, 0.3, 1.2, 4, 7, (st.r || 2), 0.6, 0.5, 4);
      fires.delete(id);
    }

    // props: burnt transition leaves a scorch
    const PR = src && src.props;
    if (PR) for (let k = 0; k < PR.length; k++) {
      const p = PR[k]; if (!p || typeof p !== 'object') continue;
      const prev = propState.get(p);
      if (prev !== p.state) { propState.set(p, p.state); if (p.state === 'burnt' && prev && fx.opts.decals) scorch(p.x, p.y, p.k === 'car' ? 6.5 : 3, 0.9); }
    }

    // ground emitters (landed gas canisters)
    for (let k = emitters.length - 1; k >= 0; k--) {
      const em = emitters[k]; em.t += dt; em.x += wind.x * 0.4 * dt; em.y += wind.y * 0.4 * dt;
      if (em.t > em.dur) { emitters.splice(k, 1); continue; }
      if (!visible(em.x, em.y, 30)) continue;
      em.acc += dt * 9 * quality * (1 - em.t / em.dur * 0.6);
      while (em.acc > 1) { em.acc -= 1; const a = R() * TAU, v = rr(0.8, 3); emit(P_SMOKE, S_GAS, em.x, em.y, Math.cos(a) * v, Math.sin(a) * v, rr(3, 5.5), 1.2, rr(1.2, 2), 0.6, 2.5); }
    }

    // integrate particles
    const wx = wind.x, wy = wind.y;
    for (let i = 0; i < NP; i++) {
      const l = LIFE[i] + dt;
      if (l >= MAXL[i]) { killP(i); i--; continue; }
      LIFE[i] = l;
      const d = DRAG[i]; if (d) { const f = Math.exp(-d * dt); VX[i] *= f; VY[i] *= f; }
      X[i] += (VX[i] + wx * WINDK[i]) * dt; Y[i] += (VY[i] + wy * WINDK[i]) * dt;
      SIZE[i] = Math.max(0.02, SIZE[i] + GROW[i] * dt);
    }
    // bursts
    for (let k = bursts.length - 1; k >= 0; k--) { const b = bursts[k]; b.t += dt; if (b.t > b.dur) bursts.splice(k, 1); }
    // screen shake
    trauma = Math.max(0, trauma - dt * 1.4);
    if (fx.opts.shake && trauma > 0.001) { const m = trauma * trauma * 10; fx.shake.x = m * noise(T * 37); fx.shake.y = m * noise(T * 41 + 5); }
    else { fx.shake.x = 0; fx.shake.y = 0; }
    updMs = performance.now() - t0;
  };

  // ---------------------------------------------------------------- draw helpers
  let V = null, S = 1;
  const sx = x => (x - V.cx) * S + V.vw / 2;
  const sy = y => V.vh / 2 - (y - V.cy) * S;
  const onScreen = (Xs, Ys, m) => Xs > -m && Ys > -m && Xs < V.vw + m && Ys < V.vh + m;

  const CAR_COLS = ['#6f7c8a', '#8a6e60', '#5f6e5c', '#9c968a', '#4c5159', '#7f5d6c', '#a8a08f', '#41506a', '#b9b4a9', '#7a3b3b'];
  function drawProp(ctx, p, idx) {
    const Xs = sx(p.x), Ys = sy(p.y);
    if (!onScreen(Xs, Ys, 20)) return;
    const st = p.state, burnt = st === 'burnt', burning = st === 'burning';
    const a = p.a ?? hash(idx * 7 + 1) * Math.PI;
    let L = 4.3, Wd = 1.85, col = CAR_COLS[(hash(idx + 3) * CAR_COLS.length) | 0], round = false;
    switch (p.k) {
      case 'car': break;
      case 'bin': L = 0.9; Wd = 0.9; col = '#4d6b4a'; round = true; break;
      case 'scooter': L = 1.7; Wd = 0.65; col = '#5a6170'; break;
      case 'bike': L = 1.8; Wd = 0.45; col = '#3e5a7a'; break;
      case 'construction': L = 2.4; Wd = 0.6; col = '#e88a2a'; break;
      case 'bus_stop': L = 3.2; Wd = 1.3; col = '#7f97a8'; break;
      default: L = 1; Wd = 1; col = '#777';
    }
    if (st === 'used') col = '#8a8578';
    const pxL = L * S;
    if (pxL < 2.2) { // tiny: a dot
      if (S < 0.35 || p.k !== 'car') return;
      ctx.fillStyle = burnt ? '#1e1c1a' : burning ? '#7a2a10' : col; ctx.fillRect(Xs - 1, Ys - 1, 2, 2); return;
    }
    ctx.save(); ctx.translate(Xs, Ys); ctx.rotate(-a);
    const hl = L * S / 2, hw = Wd * S / 2;
    if (round) {
      ctx.beginPath(); ctx.arc(0, 0, hw, 0, TAU); ctx.fillStyle = burnt ? '#1e1c1a' : burning ? '#4a2a18' : col; ctx.fill();
      if (S > 3) { ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1; ctx.stroke(); }
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(-hl + 0.6, -hw + 0.9, hl * 2, hw * 2); // contact shadow
      ctx.fillStyle = burnt ? '#24211f' : burning ? '#3f2618' : col;
      ctx.fillRect(-hl, -hw, hl * 2, hw * 2);
      if (p.k === 'car' && S > 1.6) {
        if (!burnt) {
          ctx.fillStyle = burning ? 'rgba(255,120,30,.55)' : 'rgba(30,38,48,.55)'; // cabin glass
          ctx.fillRect(-hl * 0.35, -hw * 0.78, hl * 0.95, hw * 1.56);
          ctx.fillStyle = burning ? 'rgba(0,0,0,.35)' : 'rgba(255,255,255,.18)'; ctx.fillRect(-hl * 0.15, -hw * 0.72, hl * 0.5, hw * 1.44);
        } else {
          ctx.strokeStyle = 'rgba(120,110,100,.6)'; ctx.lineWidth = 1; ctx.strokeRect(-hl * 0.35, -hw * 0.78, hl * 0.95, hw * 1.56);
        }
        ctx.strokeStyle = burnt ? 'rgba(90,84,78,.8)' : 'rgba(0,0,0,.35)'; ctx.lineWidth = 1; ctx.strokeRect(-hl, -hw, hl * 2, hw * 2);
      } else if (p.k === 'construction') { ctx.fillStyle = '#fff'; for (let k = -2; k <= 2; k += 2) ctx.fillRect(k * hl / 3 - hl * 0.12, -hw, hl * 0.24, hw * 2); }
    }
    ctx.restore();
  }

  function shopMark(ctx, Xs, Ys, m, looted, v) {
    ctx.fillStyle = looted ? '#3b3530' : (v >= 3 ? '#c99a2e' : v >= 2 ? '#8f8a7e' : '#a9a497');
    ctx.fillRect(Xs - m, Ys - m, m * 2, m * 2);
    ctx.strokeStyle = looted ? '#d84a3a' : 'rgba(255,255,255,.85)'; ctx.lineWidth = 1; ctx.strokeRect(Xs - m, Ys - m, m * 2, m * 2);
  }

  // ---------------------------------------------------------------- drawUnder
  fx.drawUnder = function (ctx, view) {
    if (!view) return;
    const t0 = performance.now();
    V = view; S = view.s; lastView = view;
    const src = lastSrc, o = fx.opts;
    ctx.save();
    // decals
    if (o.decals && ND) {
      const fineD = S >= 0.5;
      for (let n = 0; n < ND; n++) {
        const k = DK[n]; if (!fineD && k >= D_GLASS) continue;
        const Xs = sx(DX[n]), Ys = sy(DY[n]), r = DS[n] * S / 2;
        if (r < 0.6 || !onScreen(Xs, Ys, r)) continue;
        ctx.globalAlpha = DAL[n];
        if (r < 3) ctx.drawImage(DEC_SPR[k], Xs - r, Ys - r, r * 2, r * 2);
        else { ctx.save(); ctx.translate(Xs, Ys); ctx.rotate(DA[n]); ctx.drawImage(DEC_SPR[k], -r, -r, r * 2, r * 2); ctx.restore(); }
      }
      ctx.globalAlpha = 1;
    }
    // live fires char the ground under them
    if (o.fires) for (const st of fires.values()) {
      const r = (st.Rv || st.r) * 1.5 * Math.min(1, 0.3 + st.age / 6) * S, Xs = sx(st.x), Ys = sy(st.y);
      if (r < 1 || !onScreen(Xs, Ys, r)) continue;
      ctx.globalAlpha = 0.8; ctx.drawImage(DEC_SPR[0], Xs - r, Ys - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
    // shops
    const SH = src && src.shops;
    if (o.props && SH && S >= 1.0) for (let k = 0; k < SH.length; k++) {
      const sh = SH[k], Xs = sx(sh.x), Ys = sy(sh.y); if (!onScreen(Xs, Ys, 20)) continue;
      const looted = (sh.looted || 0) > 0.3, m = Math.max(2.5, 0.7 * S);
      if (looted && S >= 1.5) { const r = 1.6 * S; ctx.drawImage(DEC_SPR[D_GLASS + (k & 1)], Xs - r, Ys - r, r * 2, r * 2); }
      shopMark(ctx, Xs, Ys, m, looted, sh.v);
    }
    // props
    const PR = src && src.props;
    if (o.props && PR && S >= 0.35) for (let k = 0; k < PR.length; k++) { const p = PR[k]; if (p) drawProp(ctx, p, k); }
    ctx.restore();
    drawMs = performance.now() - t0;
  };

  // night tint (multiply); fx.drawTint(ctx, view) lets a view put it under its units so they stay readable at dusk
  function drawTint(ctx) {
    if (!(fx.night > 0)) return;
    ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = `rgba(${Math.round(255 - 170 * fx.night)},${Math.round(255 - 160 * fx.night)},${Math.round(255 - 110 * fx.night)},1)`; ctx.fillRect(-50, -50, V.vw + 100, V.vh + 100); ctx.globalCompositeOperation = 'source-over';
  }
  fx.drawTint = function (ctx, view) { if (!view) return; V = view; S = view.s; lastView = view; drawTint(ctx); };

  // ---------------------------------------------------------------- draw
  fx.draw = function (ctx, view) {
    if (!view) return;
    const t0 = performance.now();
    V = view; S = view.s; lastView = view;
    const o = fx.opts, fine = S >= 0.6;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    if (fx.opts.tint !== false) drawTint(ctx); // (render2d draws the tint itself, under the agents: fx.opts.tint = false)

    // 1. fire light on the ground (warm tint + additive core)
    if (o.fires) {
      for (const st of fires.values()) {
        if (!st.Rv) continue;
        const Xs = sx(st.x), Ys = sy(st.y), fl = 0.85 + 0.15 * noise(T * 9 + st.seed), r = Math.max(14, st.Rv * 5 * S) * fl;
        if (!onScreen(Xs, Ys, r)) continue;
        ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = 0.55 * st.int + 0.15;
        ctx.drawImage(LIGHT, Xs - r, Ys - r, r * 2, r * 2);
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = Math.min(1, (0.25 + 0.75 * fx.night) * (0.4 + 0.6 * st.int));
        const rl = r * (0.7 + 0.6 * fx.night); ctx.drawImage(LIGHT, Xs - rl, Ys - rl, rl * 2, rl * 2);
      }
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    }

    // 2. smoke (normal blend)
    if (o.smoke) {
      for (let i = 0; i < NP; i++) {
        if (TYPE[i] !== P_SMOKE) continue;
        const Xs = sx(X[i]), Ys = sy(Y[i]), r = Math.max(COL[i] === S_GAS ? 4.5 : 1.5, SIZE[i] * S);
        if (!onScreen(Xs, Ys, r)) continue;
        const t = LIFE[i] / MAXL[i], a = Math.min(1, t * 7) * Math.pow(1 - t, 0.75) * SMOKE_A[COL[i]];
        if (a < 0.01) continue;
        ctx.globalAlpha = a;
        ctx.drawImage(SMOKE_SPR[COL[i]][VAR[i]], Xs - r, Ys - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
    }

    // 3. fire bodies: dark ember bed + layered flicker blobs
    if (o.fires) {
      for (const st of fires.values()) {
        if (!st.Rv) continue;
        const Xs = sx(st.x), Ys = sy(st.y), Rp = Math.max(4, st.Rv * S);
        if (!onScreen(Xs, Ys, Rp * 3)) continue;
        ctx.globalAlpha = 0.9; ctx.drawImage(FLAME_DARK, Xs - Rp * 1.4, Ys - Rp * 1.4, Rp * 2.8, Rp * 2.8);
        const nb = fine ? 4 : 2;
        for (let k = 0; k < nb; k++) {
          const ph = T * (7 + k * 2.3) + st.seed + k * 11, j = Rp * 0.35;
          const ox = noise(ph) * j + wind.x * Rp * 0.5 * (k / nb), oy = -noise(ph + 3) * j - wind.y * Rp * 0.5 * (k / nb) - Rp * 0.15 * k / nb;
          const rr2 = Rp * (1.25 - k * 0.18) * (0.85 + 0.25 * (noise(ph * 1.7) * 0.5 + 0.5)) * (0.5 + 0.5 * st.int);
          ctx.globalAlpha = 0.95;
          ctx.drawImage(FLAME, Xs + ox - rr2, Ys + oy - rr2, rr2 * 2, rr2 * 2);
        }
      }
      ctx.globalAlpha = 1;
    }

    // 4. projectile trails + heads
    if (o.projectiles) drawProjectiles(ctx, fine);

    // 5. flame particles
    if (o.fires || o.explosions) {
      for (let i = 0; i < NP; i++) {
        if (TYPE[i] !== P_FLAME) continue;
        const Xs = sx(X[i]), Ys = sy(Y[i]), r = Math.max(1.5, SIZE[i] * S);
        if (!onScreen(Xs, Ys, r)) continue;
        const t = LIFE[i] / MAXL[i]; ctx.globalAlpha = (1 - t) * 0.95;
        ctx.drawImage(FLAME, Xs - r, Ys - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
    }

    // 6. sparks, embers, glass, debris, dust streaks
    if (o.sparks && fine) drawSparks(ctx);
    drawStreaks(ctx);

    // 7. flashes and rings
    for (const b of bursts) {
      const Xs = sx(b.x), Ys = sy(b.y), u = b.t / b.dur;
      if (b.k === 'flash') {
        const r = Math.max(10, b.r * S) * (0.6 + 0.6 * u); if (!onScreen(Xs, Ys, r)) continue;
        const a = (1 - u) * (1 - u);
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = a; ctx.drawImage(b.spr, Xs - r, Ys - r, r * 2, r * 2);
        ctx.globalCompositeOperation = 'source-over';
        if (b.strong) { ctx.globalAlpha = a * 0.9; ctx.drawImage(b.spr, Xs - r * 0.8, Ys - r * 0.8, r * 1.6, r * 1.6); }
        else { ctx.globalAlpha = a * 0.75; ctx.drawImage(FLASH, Xs - r * 0.55, Ys - r * 0.55, r * 1.1, r * 1.1); }
      } else if (b.k === 'ring') {
        const e = 1 - (1 - u) * (1 - u) * (1 - u), r = Math.max(3, (b.r0 + (b.r1 - b.r0) * e) * S); if (!onScreen(Xs, Ys, r)) continue;
        const a = 1 - u, w = Math.max(1, b.w * (1 - u * 0.7) * Math.min(1.5, Math.max(0.6, S / 2)));
        ctx.beginPath(); ctx.arc(Xs, Ys, r, 0, TAU);
        if (b.dark) { ctx.globalAlpha = a * 0.5; ctx.strokeStyle = 'rgb(40,30,20)'; ctx.lineWidth = w + 2.5; ctx.stroke(); }
        ctx.globalAlpha = a; ctx.strokeStyle = `rgb(${b.col})`; ctx.lineWidth = w; ctx.stroke();
      } else if (b.k === 'pop') { // landing: owner-coloured ring + small glow, min screen size
        const gasPop = b.kind === 'gas', e = 1 - (1 - u) * (1 - u), r = Math.max(4 + 9 * e, (0.5 + (gasPop ? 4 : 2) * e) * S); if (!onScreen(Xs, Ys, r)) continue;
        const col = gasPop ? '150,172,34' : OWNER_RGB[b.owner] || OWNER_RGB.C, a = 1 - u;
        ctx.globalAlpha = a * 0.45; ctx.drawImage(gasPop ? GAS_GLOW : GLOW[b.owner === 'P' ? C_BLUE : C_ORANGE], Xs - r * 0.8, Ys - r * 0.8, r * 1.6, r * 1.6);
        ctx.beginPath(); ctx.arc(Xs, Ys, r, 0, TAU);
        ctx.globalAlpha = a * 0.5; ctx.strokeStyle = 'rgb(30,26,22)'; ctx.lineWidth = 3.2; ctx.stroke();
        ctx.globalAlpha = a; ctx.strokeStyle = `rgb(${col})`; ctx.lineWidth = 1.8; ctx.stroke();
      } else if (b.k === 'swish') {
        if (!onScreen(Xs, Ys, 20)) continue;
        const r = Math.max(5, 1.4 * S), a0 = -b.a - 1.2 + u * 1.6;
        ctx.globalAlpha = (1 - u) * 0.8; ctx.strokeStyle = b.owner === 'P' ? '#9ab8ff' : '#ffffff'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(Xs, Ys, r, a0, a0 + 1.4); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';

    // 8. icons (screen-sized)
    if (o.icons) for (const b of bursts) if (b.k === 'icon') drawIcon(ctx, b);

    ctx.restore();
    drawMs += performance.now() - t0;
  };

  // one trail, given as segments [X0, Y0, X1, Y1, age] in screen px (shared by the game and the legend swatches)
  const BANDS = 5;
  function strokeTrail(ctx, kind, colIdx, seg, nseg, maxAge, ghost, zoomS) {
    const ks = KIND[kind] || KIND.rock;
    const isFw = kind === 'firework', isMol = kind === 'molotov', isGas = kind === 'gas', isLbd = kind === 'lbd';
    const rgb = isFw ? SPARK_RGB[colIdx].join(',') : ks.c;
    for (let b = 0; b < BANDS; b++) {
      ctx.beginPath(); let any = false;
      for (let m = 0; m < nseg; m++) {
        const o = m * 5, band = Math.min(BANDS - 1, Math.floor(seg[o + 4] / maxAge * BANDS)); if (band !== b) continue;
        ctx.moveTo(seg[o], seg[o + 1]); ctx.lineTo(seg[o + 2], seg[o + 3]); any = true;
      }
      if (!any) continue;
      const fa = (1 - b / BANDS) * ghost, w = Math.max(1.6, ks.w * (1 - b / BANDS * 0.5) * Math.min(1.6, Math.max(0.9, zoomS / 2.2)));
      if (isGas) { ctx.globalAlpha = fa * 0.6; ctx.strokeStyle = 'rgb(118,138,28)'; ctx.lineWidth = w + 2.4; ctx.stroke(); }
      if (isFw || isLbd) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = fa * 0.6; ctx.strokeStyle = `rgb(${rgb})`; ctx.lineWidth = w * 2.8; ctx.stroke(); ctx.globalCompositeOperation = 'source-over'; }
      if (isFw) { ctx.globalAlpha = fa * 0.6; ctx.strokeStyle = 'rgba(40,20,40,1)'; ctx.lineWidth = w + 1.6; ctx.stroke(); }
      ctx.globalAlpha = fa * ks.a; ctx.strokeStyle = `rgb(${rgb})`; ctx.lineWidth = w; ctx.stroke();
      if (isMol && b < 2) { ctx.globalAlpha = fa; ctx.strokeStyle = b === 0 ? '#ffd24a' : '#ff7a1a'; ctx.lineWidth = Math.max(1, w * 0.45); ctx.stroke(); }
      if (isLbd) { ctx.globalAlpha = fa; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(0.8, w * 0.4); ctx.stroke(); }
    }
    ctx.globalAlpha = 1;
  }
  // projectile head at screen (gx, hy); base = max(1, px per metre); seed varies flicker
  function drawHead(ctx, k, gx, hy, base, colIdx, seed) {
    switch (k) {
      case 'rock': case 'paving': {
        const r = Math.max(2.4, 0.22 * base);
        ctx.fillStyle = '#2b2926'; ctx.beginPath(); ctx.arc(gx, hy, r + 0.8, 0, TAU); ctx.fill();
        ctx.fillStyle = k === 'paving' ? '#9a948a' : '#7d7871'; ctx.beginPath();
        if (k === 'paving') ctx.rect(gx - r, hy - r, r * 2, r * 2); else ctx.arc(gx, hy, r, 0, TAU); ctx.fill(); break;
      }
      case 'bottle': {
        const r = Math.max(2.4, 0.2 * base);
        ctx.fillStyle = '#123d22'; ctx.beginPath(); ctx.arc(gx, hy, r + 0.8, 0, TAU); ctx.fill();
        ctx.fillStyle = '#2fb35a'; ctx.beginPath(); ctx.arc(gx, hy, r, 0, TAU); ctx.fill();
        const g = 0.5 + 0.5 * Math.sin(T * 25 + seed); ctx.fillStyle = `rgba(255,255,255,${0.5 + 0.5 * g})`; ctx.fillRect(gx - r * 0.5, hy - r * 0.6, Math.max(1, r * 0.6), Math.max(1, r * 0.6)); break;
      }
      case 'molotov': {
        const r = Math.max(4, 0.9 * base) * (0.9 + 0.2 * Math.sin(T * 30 + seed));
        ctx.drawImage(FLAME, gx - r, hy - r, r * 2, r * 2);
        ctx.fillStyle = '#5a3a14'; ctx.beginPath(); ctx.arc(gx, hy, Math.max(1.4, 0.15 * base), 0, TAU); ctx.fill(); break;
      }
      case 'firework': {
        const r = Math.max(5, 1.2 * base);
        ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(GLOW[colIdx], gx - r, hy - r, r * 2, r * 2); ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(gx, hy, Math.max(1.5, 0.18 * base), 0, TAU); ctx.fill(); break;
      }
      case 'gas': {
        const r = Math.max(2.6, 0.2 * base);
        ctx.fillStyle = '#2b3138'; ctx.beginPath(); ctx.arc(gx, hy, r + 0.9, 0, TAU); ctx.fill();
        ctx.fillStyle = '#c9d48a'; ctx.beginPath(); ctx.arc(gx, hy, r, 0, TAU); ctx.fill(); break;
      }
      case 'lbd': {
        const r = Math.max(4, 0.5 * base);
        ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(GLOW[C_HOT], gx - r, hy - r, r * 2, r * 2); ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#fff'; ctx.fillRect(gx - 1, hy - 1, 2, 2); break;
      }
      case 'flashbang': {
        const r = Math.max(2.4, 0.18 * base);
        ctx.fillStyle = '#16181c'; ctx.beginPath(); ctx.arc(gx, hy, r, 0, TAU); ctx.fill();
        if (Math.sin(T * 30) > 0) { ctx.fillStyle = '#ff4040'; ctx.fillRect(gx - 0.8, hy - 0.8, 1.6, 1.6); } break;
      }
      default: ctx.fillStyle = '#444'; ctx.beginPath(); ctx.arc(gx, hy, 2, 0, TAU); ctx.fill();
    }
  }
  const segBuf = new Float32Array(TRAIL_N * 5);
  function drawProjectiles(ctx, fine) {
    // trails, in alpha bands to keep the stroke count low
    if (fx.opts.trails) for (const tr of trails.values()) {
      const ks = KIND[tr.kind] || KIND.rock, n = tr.n; if (n < 2) continue;
      const ghost = tr.dead ? Math.max(0, 1 - tr.deadT / GHOST_T) : 1;
      const last = (tr.head + TRAIL_N - 1) % TRAIL_N;
      if (!onScreen(sx(tr.xs[last]), sy(tr.ys[last]), 200)) continue;
      const maxAge = ks.age * (tr.kind === 'lbd' ? 1 : Math.min(1.6, Math.max(0.8, 1.6 / Math.max(0.6, S))));
      let ns = 0;
      for (let m = 1; m < n; m++) {
        const i1 = (tr.head - m + TRAIL_N) % TRAIL_N, i0 = (tr.head - m - 1 + TRAIL_N) % TRAIL_N;
        const age = T - tr.ts[i1]; if (age > maxAge) break;
        const o = ns * 5; segBuf[o] = sx(tr.xs[i1]); segBuf[o + 1] = sy(tr.ys[i1]); segBuf[o + 2] = sx(tr.xs[i0]); segBuf[o + 3] = sy(tr.ys[i0]); segBuf[o + 4] = age; ns++;
      }
      if (ns) strokeTrail(ctx, tr.kind, tr.col, segBuf, ns, maxAge, ghost, S);
    }
    // heads + ground shadows
    for (const tr of trails.values()) {
      if (tr.dead) continue;
      const gx = sx(tr.x), gy = sy(tr.y), z = tr.z, hy = gy - z * ZK * S;
      if (!onScreen(gx, gy, 60)) continue;
      const k = tr.kind;
      if (S < 1.2) { const r = 7.5; ctx.globalAlpha = 0.75; ctx.drawImage(GLOW[tr.owner === 'P' ? C_BLUE : C_ORANGE], gx - r, hy - r, r * 2, r * 2); ctx.globalAlpha = 1; }
      if (z > 0.15 && k !== 'lbd') { const r = Math.max(1.6, (0.25 + z * 0.03) * S); ctx.globalAlpha = Math.max(0.15, 0.6 / (1 + z * 0.15)); ctx.drawImage(SHADOW, gx - r, gy - r * 0.7, r * 2, r * 1.4); ctx.globalAlpha = 1; }
      drawHead(ctx, k, gx, hy, Math.max(1, S), tr.col, tr.id);
    }
  }

  const bucket = Array.from({ length: SPARK_CSS.length }, () => new Int32Array(MAXP)), bucketN = new Int32Array(SPARK_CSS.length);
  function drawSparks(ctx) {
    bucketN.fill(0);
    for (let i = 0; i < NP; i++) {
      if (TYPE[i] !== P_SPARK) continue;
      const Xs = sx(X[i]); if (Xs < -20 || Xs > V.vw + 20) continue;
      const c = COL[i]; bucket[c][bucketN[c]++] = i;
    }
    const k = 0.045 * S, wmul = Math.min(2.2, Math.max(1, S / 2.5));
    // dark under-stroke so bright sparks read on a light map, then the colour, then an additive bloom
    for (let pass = 0; pass < 3; pass++) {
      for (let c = 0; c < SPARK_CSS.length; c++) {
        const n = bucketN[c]; if (!n) continue;
        const arr = bucket[c]; ctx.beginPath();
        for (let m = 0; m < n; m++) {
          const i = arr[m], Xs = sx(X[i]), Ys = sy(Y[i]);
          let dx = VX[i] * k, dy = -VY[i] * k; const l = Math.hypot(dx, dy); if (l < 1) { dx = 1; dy = 0; }
          ctx.moveTo(Xs, Ys); ctx.lineTo(Xs - dx, Ys - dy);
        }
        if (pass === 0) { ctx.globalAlpha = 0.18; ctx.strokeStyle = '#2a1608'; ctx.lineWidth = 2.6 * wmul; }
        else if (pass === 1) { ctx.globalAlpha = 1; ctx.strokeStyle = SPARK_CSS[c]; ctx.lineWidth = 1.4 * wmul; }
        else { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.45; ctx.strokeStyle = SPARK_CSS[c]; ctx.lineWidth = 3.5 * wmul; }
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    ctx.globalAlpha = 1;
    // embers, glass glints, debris
    for (let i = 0; i < NP; i++) {
      const ty = TYPE[i]; if (ty !== P_EMBER && ty !== P_GLASS && ty !== P_DEBRIS) continue;
      const Xs = sx(X[i]), Ys = sy(Y[i]); if (!onScreen(Xs, Ys, 6)) continue;
      const t = LIFE[i] / MAXL[i];
      if (ty === P_EMBER) {
        const r = Math.max(0.8, SIZE[i] * S * 0.6), fl = 0.55 + 0.45 * Math.sin(T * 20 + i);
        ctx.globalAlpha = (1 - t) * fl; ctx.fillStyle = COL[i] === C_GOLD ? '#ffb000' : '#ff4a00'; ctx.fillRect(Xs - r, Ys - r, r * 2, r * 2);
        if (fx.night > 0.2) { const g = r * 5; ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha *= 0.6; ctx.drawImage(GLOW[COL[i]], Xs - g, Ys - g, g * 2, g * 2); ctx.globalCompositeOperation = 'source-over'; }
      } else if (ty === P_GLASS) {
        const r = Math.max(1.5, SIZE[i] * S * 1.5) * (0.5 + 0.5 * Math.abs(Math.sin(T * 18 + i * 1.3)));
        ctx.globalAlpha = 1 - t; ctx.strokeStyle = i & 1 ? '#ffffff' : '#bfe8ff'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(Xs - r, Ys); ctx.lineTo(Xs + r, Ys); ctx.moveTo(Xs, Ys - r); ctx.lineTo(Xs, Ys + r); ctx.stroke();
      } else {
        const r = Math.max(1, SIZE[i] * S * 0.6); ctx.globalAlpha = Math.min(1, (1 - t) * 2); ctx.fillStyle = '#2e2a26'; ctx.fillRect(Xs - r, Ys - r, r * 2, r * 2);
      }
    }
    ctx.globalAlpha = 1;
  }
  function drawStreaks(ctx) {
    ctx.beginPath(); let any = false;
    const wmul = Math.min(2.5, Math.max(1, S / 2));
    for (let i = 0; i < NP; i++) {
      if (TYPE[i] !== P_STREAK) continue;
      const Xs = sx(X[i]), Ys = sy(Y[i]); if (!onScreen(Xs, Ys, 30)) continue;
      const l = Math.hypot(VX[i], VY[i]) || 1, L = SIZE[i] * S * (1 - LIFE[i] / MAXL[i]);
      ctx.moveTo(Xs, Ys); ctx.lineTo(Xs - VX[i] / l * L, Ys + VY[i] / l * L); any = true;
    }
    if (!any) return;
    ctx.globalAlpha = 0.55; ctx.strokeStyle = '#a89470'; ctx.lineWidth = 1.6 * wmul; ctx.stroke(); ctx.globalAlpha = 1;
  }

  function drawIcon(ctx, b) {
    const Xs = sx(b.x), Ys0 = sy(b.y); if (!onScreen(Xs, Ys0, 30)) return;
    const u = b.t / b.dur, pop = u < 0.15 ? 0.5 + 0.5 * Math.sin(u / 0.15 * Math.PI * 0.75) / Math.sin(Math.PI * 0.75) * 1.0 : 1;
    const sz = Math.min(18, Math.max(9, 3 * S)) * (u < 0.15 ? 0.6 + 0.6 * (u / 0.15) : 1.2 - Math.min(0.2, (u - 0.15) * 0.5)) * pop;
    const Ys = Ys0 - sz * 0.8 - u * 16;
    ctx.globalAlpha = u > 0.65 ? Math.max(0, 1 - (u - 0.65) / 0.35) : 1;
    iconAt(ctx, b.icon, Xs, Ys, sz);
    ctx.globalAlpha = 1;
  }
  // event icon centred at screen (Xs, Ys), size sz px (shared with the legend)
  function iconAt(ctx, icon, Xs, Ys, sz) {
    ctx.lineWidth = 2;
    switch (icon) {
      case '$':
        ctx.fillStyle = '#1f8f3a'; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(Xs, Ys, sz * 0.62, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = `800 ${Math.round(sz * 0.85)}px system-ui,Segoe UI,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('$', Xs, Ys + 0.5); break;
      case 'cuff': {
        const r = sz * 0.3;
        ctx.fillStyle = '#1d3a8f'; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.arc(Xs, Ys, sz * 0.66, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = '#dfe8ff'; ctx.lineWidth = Math.max(1.5, sz * 0.12);
        ctx.beginPath(); ctx.arc(Xs - r * 0.95, Ys + r * 0.2, r * 0.7, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.arc(Xs + r * 0.95, Ys + r * 0.2, r * 0.7, 0, TAU); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(Xs - r * 0.3, Ys - r * 0.4); ctx.quadraticCurveTo(Xs, Ys - r * 1.1, Xs + r * 0.3, Ys - r * 0.4); ctx.stroke(); break;
      }
      case 'cross': {
        const a = sz * 0.42, w = sz * 0.16;
        ctx.fillStyle = '#fff'; ctx.strokeStyle = '#c81d25'; ctx.beginPath(); ctx.arc(Xs, Ys, sz * 0.6, 0, TAU); ctx.fill(); ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = '#e01e2b'; ctx.fillRect(Xs - w, Ys - a, w * 2, a * 2); ctx.fillRect(Xs - a, Ys - w, a * 2, w * 2); break;
      }
      case 'stars': {
        const n = 3;
        for (let k = 0; k < n; k++) {
          const ang = T * 4 + k * TAU / n, cx = Xs + Math.cos(ang) * sz * 0.7, cy = Ys + Math.sin(ang) * sz * 0.35;
          star(ctx, cx, cy, sz * 0.38, sz * 0.16, '#ffd23f', '#5a3b00');
        }
        break;
      }
    }
  }
  function star(ctx, x, y, R1, R0, fill, stroke) {
    ctx.beginPath();
    for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, r = k & 1 ? R0 : R1; k ? ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r) : ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r); }
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = stroke; ctx.stroke();
  }

  // ---------------------------------------------------------------- legend swatches (same drawing code as the game)
  // All coordinates are screen px. Used by render2d's view.legendSwatch().
  fx.legend = {
    icon(ctx, name, X, Y, sz) { ctx.save(); iconAt(ctx, name, X, Y, sz); ctx.restore(); },
    // a sample throw from (x0, y0) to (x1, y1) with an arc of height hgt px; head drawn at the end
    trail(ctx, kind, x0, y0, x1, y1, hgt = 0, zoomS = 2.5) {
      const ks = KIND[kind] || KIND.rock, N = 16, maxAge = ks.age, col = C_MAGENTA, seg = new Float32Array(N * 5);
      const P = u => [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u - hgt * 4 * u * (1 - u)];
      for (let m = 0; m < N; m++) {
        const u1 = 1 - m / N, u0 = 1 - (m + 1) / N, a = P(u1), b = P(u0), o = m * 5;
        seg[o] = a[0]; seg[o + 1] = a[1]; seg[o + 2] = b[0]; seg[o + 3] = b[1]; seg[o + 4] = maxAge * (m + 0.5) / N * 0.98;
      }
      ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      strokeTrail(ctx, kind, col, seg, N, maxAge, 1, zoomS);
      drawHead(ctx, kind, x1, y1, zoomS, col, 1.3);
      ctx.restore();
    },
    fire(ctx, X, Y, r) {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = 0.5; ctx.drawImage(LIGHT, X - r * 2.2, Y - r * 2.2, r * 4.4, r * 4.4);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.9; ctx.drawImage(FLAME_DARK, X - r * 1.4, Y - r * 1.4, r * 2.8, r * 2.8);
      ctx.globalAlpha = 0.95;
      for (let k = 0; k < 3; k++) { const rr2 = r * (1.15 - k * 0.2), oy = -r * 0.18 * k; ctx.drawImage(FLAME, X - rr2 + (k - 1) * r * 0.15, Y + oy - rr2, rr2 * 2, rr2 * 2); }
      ctx.restore();
    },
    // smoke: 'dark' (fire), 'grey' (burnt out / flashbang), 'gas' (tear gas puffs), 'dust'
    smoke(ctx, kind, X, Y, r) {
      const c = { dark: S_DARK, grey: S_GREY, gas: S_GAS, dust: S_DUST }[kind] ?? S_GREY;
      ctx.save(); ctx.globalAlpha = SMOKE_A[c];
      ctx.drawImage(SMOKE_SPR[c][0], X - r, Y - r, r * 2, r * 2); ctx.drawImage(SMOKE_SPR[c][1], X - r * 0.4, Y - r * 0.9, r * 1.4, r * 1.4);
      ctx.restore();
    },
    decal(ctx, kind, X, Y, r) { // 'scorch' | 'glass' | 'debris'
      const k = kind === 'glass' ? D_GLASS : kind === 'debris' ? D_DEBRIS : D_SCORCH;
      ctx.save(); ctx.globalAlpha = 0.95; ctx.drawImage(DEC_SPR[k], X - r, Y - r, r * 2, r * 2); ctx.restore();
    },
    glints(ctx, X, Y, r) { // flying glass (shatter)
      ctx.save(); ctx.lineWidth = 1.2;
      [[-0.6, -0.3, 1], [0.5, -0.5, 0.8], [0.1, 0.5, 0.7], [-0.2, 0.05, 0.5]].forEach(([dx, dy, s], i) => {
        const x = X + dx * r, y = Y + dy * r, q = r * 0.35 * s; ctx.strokeStyle = i & 1 ? '#ffffff' : '#bfe8ff';
        ctx.beginPath(); ctx.moveTo(x - q, y); ctx.lineTo(x + q, y); ctx.moveTo(x, y - q); ctx.lineTo(x, y + q); ctx.stroke();
      });
      ctx.restore();
    },
    prop(ctx, k, state, X, Y, zoomS = 4, a = 0.35) {
      const sv = V, ss = S; V = { cx: 0, cy: 0, vw: X * 2, vh: Y * 2, s: zoomS }; S = zoomS;
      try { drawProp(ctx, { x: 0, y: 0, k, state, a }, 3); } finally { V = sv; S = ss; }
    },
    shop(ctx, X, Y, m, looted, v = 1) { ctx.save(); shopMark(ctx, X, Y, m, looted, v); ctx.restore(); },
    flash(ctx, X, Y, r) { ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.9; ctx.drawImage(WFLASH, X - r, Y - r, r * 2, r * 2); ctx.restore(); },
  };

  fx.busyAt = (x, y, r) => {
    const r2 = r * r, near = (px, py) => (px - x) * (px - x) + (py - y) * (py - y) < r2;
    for (const tr of trails.values()) if (!tr.dead && near(tr.x, tr.y)) return true;
    for (const b of bursts) if (b.k !== 'icon' && b.k !== 'swish' && near(b.x, b.y)) return true;
    for (const em of emitters) if (near(em.x, em.y)) return true;
    return false;
  };
  fx.stats = () => ({ particles: NP, trails: trails.size, fires: fires.size, decals: ND, bursts: bursts.length, emitters: emitters.length, quality, drawMs: +drawMs.toFixed(2), updMs: +updMs.toFixed(2) });
  fx.clear = () => { NP = 0; ND = 0; DHEAD = 0; bursts.length = 0; trails.clear(); fires.clear(); emitters.length = 0; trauma = 0; };
  return fx;
}
