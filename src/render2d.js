// Top-down 2D tactical-map view (Canvas2D) on top of sim.js.
// World: metres, x east, y north. Screen: north up, no rotation.
import { clamp, ring, holes, polyPath, linePath, LM_NAMES, LEADER_COLORS, lmName } from './sim.js';
import { hex } from './ui.js';
import { createFX2D } from './fx2d.js'; // FX hook

// The renderer's palette. Exported (as PALETTE) so the legend draws with exactly these colours.
const COL = {
  bg: '#d9d4c8', ground: '#e2ddd2', park: '#cbe0b4', parkEdge: '#b2cc96', square: '#f3f0e8', squareEdge: '#d3ccbe',
  water: '#a6c5dd', waterEdge: '#8fb3cf', road: '#ffffff', roadMajor: '#fff8e6', foot: '#f4f1ea', casing: '#cbc3b4',
  bld: '#cbc2b1', bldEdge: '#aca290',
  idle: '#7b7f87', panic: '#f5c518', cop: '#1d3461', copCharge: '#5a7fe0', copDown: '#6b7385', gold: '#e0a800',
  outline: 'rgba(25,28,34,0.55)',
  // agent states (act / riot / cls)
  // wild riot (no leader): dark diamond with a bright orange rim, so it never reads as a red/orange leader's followers (even at dusk)
  wild: '#3a1f12', wildRim: '#ff8a1c',
  home: '#eef1f5', homeRim: '#59626f', // heading home at dusk: hollow pale dot
  loot: '#ff2bd6', lootBag: '#ffe14d', down: '#5b2a2a', downCross: '#e01e2b', arrested: '#9aa3b2', arrestRing: '#1f6fff',
  medic: '#ffffff', medicCross: '#c0141e', bloc: '#111111', encourager: '#ffd400', pacifist: '#9fd8ff', snatch: '#0e1f45', snatchHot: '#3d6dff',
  stance: { peaceful: '#3fae5a', firm: '#e09a2b', unleashed: '#d7263d' },
  // police intent overlay, by plan kind
  intent: { block: '#e0313d', cordon: '#2f6bff', kettle: '#b4148c', funnel: '#f08c00', split: '#8a3ffc', perimeter: '#0f8b8d', hunt: '#d81b60', response: '#00897b', clear: '#5d4037', route: '#e0313d', dest: '#1d3461' },
};
export const PALETTE = COL;
const TILE = 512, LEVELS = [1, 2, 4, 8, 16], BASE_LEVEL = 0.5, MAX_TILES = 220, BUCKET = 128;
const STANCE_COL = COL.stance;

// ------------------------------------------------------------------ shared shapes (game + legend)
// diamond path (wild riot members), half-diagonal r
function diamond(ctx, X, Y, r) { ctx.moveTo(X, Y - r); ctx.lineTo(X + r, Y); ctx.lineTo(X, Y + r); ctx.lineTo(X - r, Y); ctx.closePath(); }
// leader marker: coloured disc, white rim, stance badge (P/F/U); arrested = grey disc, blue ring, handcuffs
function leaderMarker(ctx, X, Y, R, color, stance, arrested, selected) {
  if (arrested) {
    ctx.fillStyle = '#8a8f99'; ctx.beginPath(); ctx.arc(X, Y, R, 0, 6.283); ctx.fill();
    ctx.strokeStyle = COL.arrestRing; ctx.lineWidth = 3; ctx.stroke();
    const q = Math.max(2.2, R * 0.38);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6; ctx.beginPath();
    ctx.moveTo(X - q * 0.2, Y); ctx.arc(X - q * 1.2, Y, q, 0, 6.283); ctx.moveTo(X + q * 2.2, Y); ctx.arc(X + q * 1.2, Y, q, 0, 6.283); ctx.stroke();
    return;
  }
  if (selected) {
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(X, Y, R + 5, 0, 6.283); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  }
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X, Y, R, 0, 6.283); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(X, Y, R + 1.8, 0, 6.283); ctx.stroke();
  const sc = stance && STANCE_COL[stance];
  if (sc) {
    const bX = X + R * 0.85, bY = Y + R * 0.85, br = Math.max(3.2, R * 0.42);
    ctx.fillStyle = sc; ctx.beginPath(); ctx.arc(bX, bY, br, 0, 6.283); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.3; ctx.stroke();
    if (br >= 4.5) { ctx.fillStyle = '#fff'; ctx.font = `800 ${Math.round(br * 1.3)}px system-ui,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(stance[0].toUpperCase(), bX, bY + 0.5); }
  }
}
// police van at (X, Y), heading a (screen radians), half length hl / half width hw
function vanShape(ctx, X, Y, a, hl, hw, blink) {
  ctx.save(); ctx.translate(X, Y); ctx.rotate(a);
  ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(-hl + 1, -hw + 1.5, hl * 2, hw * 2);
  ctx.fillStyle = 'rgba(61,109,255,.35)'; ctx.fillRect(-hl - 2, -hw - 2, hl * 2 + 4, hw * 2 + 4);
  ctx.fillStyle = COL.cop; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-hl, -hw, hl * 2, hw * 2, Math.min(3, hw * 0.5)) : ctx.rect(-hl, -hw, hl * 2, hw * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.fillStyle = '#e9eef8'; ctx.fillRect(-hl * 0.55, -hw * 0.18, hl * 1.1, hw * 0.36); // roof stripe
  ctx.fillStyle = '#a9c2ee'; ctx.fillRect(hl * 0.55, -hw * 0.75, hl * 0.25, hw * 1.5);   // windscreen
  ctx.fillStyle = blink ? '#3d7bff' : '#9fc0ff'; ctx.fillRect(hl * 0.25, -hw * 0.6, hl * 0.18, hw * 1.2); // light bar
  ctx.restore();
}
function snatchDiamond(ctx, X, Y, R, hot) {
  ctx.beginPath(); diamond(ctx, X, Y, R);
  ctx.fillStyle = hot ? COL.snatchHot : COL.snatch; ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
}
// zoomed-out squad bar: centre (mx, my), lateral unit (lx, ly), facing (fx, fy) in screen space
function squadBar(ctx, mx, my, lx, ly, fx, fy, half, s, charge) {
  ctx.lineCap = 'butt'; ctx.lineWidth = Math.max(5, 1.6 * s) + 2.5;
  ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.beginPath(); ctx.moveTo(mx - lx * half, my - ly * half); ctx.lineTo(mx + lx * half, my + ly * half); ctx.stroke();
  ctx.lineWidth -= 2.5; ctx.strokeStyle = charge ? COL.copCharge : COL.cop; ctx.stroke();
  ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx + fx * 9, my + fy * 9); ctx.stroke();
}
// police label box (CRS n · state · TACTIC) with the energy bar; returns nothing
function policeTag(ctx, t, X, by, w, h, charge, energy) {
  const bx = X - w / 2;
  ctx.fillStyle = charge ? 'rgba(60,90,190,.92)' : 'rgba(20,32,64,.88)'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, w, h, 3) : ctx.rect(bx, by, w, h); ctx.fill();
  ctx.fillStyle = '#dbe6ff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '600 10px system-ui,Segoe UI,sans-serif'; ctx.fillText(t, X, by + 7);
  ctx.fillStyle = '#333a4a'; ctx.fillRect(bx + 4, by + h - 3.5, w - 8, 2);
  ctx.fillStyle = '#8fb3ff'; ctx.fillRect(bx + 4, by + h - 3.5, (w - 8) * clamp((energy ?? 100) / 100, 0, 1), 2);
}
// gas concentration a (0..1) -> rgba of the tear-gas cloud
// ------------------------------------------------------------------ police intent primitives (overlay + legend), screen px
// status style: planned = faint dashed, moving = dashed, active/closing = solid, done = very faint
function intentStyle(c, col, status, w = 3) {
  const st = status || 'planned';
  c.strokeStyle = col; c.fillStyle = col; c.lineWidth = w; c.lineCap = 'round'; c.lineJoin = 'round';
  if (st === 'planned') { c.globalAlpha = 0.6; c.setLineDash([7, 6]); }
  else if (st === 'moving') { c.globalAlpha = 0.85; c.setLineDash([12, 5]); c.lineDashOffset = -(performance.now() / 60) % 17; }
  else if (st === 'done') { c.globalAlpha = 0.3; c.setLineDash([3, 6]); }
  else { c.globalAlpha = 0.95; c.setLineDash([]); }
}
function intentReset(c) { c.setLineDash([]); c.lineDashOffset = 0; c.globalAlpha = 1; }
// polyline (block line / cordon ring) with a white casing; pts = flat [X, Y, ...]
function intentLine(c, pts, col, status, closed, w = 3.2) {
  if (!pts || pts.length < 4) return;
  const path = () => { c.beginPath(); c.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]); if (closed) c.closePath(); };
  path(); c.setLineDash([]); c.globalAlpha = status === 'planned' ? 0.35 : status === 'done' ? 0.2 : 0.75; c.strokeStyle = '#fff'; c.lineWidth = w + 3; c.lineCap = 'round'; c.lineJoin = 'round'; c.stroke();
  intentStyle(c, col, status, w); path(); c.stroke();
  intentReset(c);
}
// block: a thick bar with end caps
function intentBlock(c, X0, Y0, X1, Y1, col, status) {
  intentLine(c, [X0, Y0, X1, Y1], col, status, false, 5);
  const dx = X1 - X0, dy = Y1 - Y0, l = Math.hypot(dx, dy) || 1, nx = -dy / l * 6, ny = dx / l * 6;
  intentStyle(c, col, status, 2.5); c.setLineDash([]);
  c.beginPath(); c.moveTo(X0 - nx, Y0 - ny); c.lineTo(X0 + nx, Y0 + ny); c.moveTo(X1 - nx, Y1 - ny); c.lineTo(X1 + nx, Y1 + ny); c.stroke();
  intentReset(c);
}
// kettle: ring with inward ticks
function intentKettle(c, X, Y, R, col, status) {
  c.beginPath(); c.arc(X, Y, R, 0, 6.283); c.setLineDash([]); c.globalAlpha = status === 'planned' ? 0.35 : 0.7; c.strokeStyle = '#fff'; c.lineWidth = 6; c.stroke();
  intentStyle(c, col, status, 3); c.beginPath(); c.arc(X, Y, R, 0, 6.283); c.stroke();
  c.setLineDash([]); c.beginPath();
  for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4, ca = Math.cos(a), sa = Math.sin(a); c.moveTo(X + ca * R, Y + sa * R); c.lineTo(X + ca * (R - Math.min(9, R * 0.3)), Y + sa * (R - Math.min(9, R * 0.3))); }
  c.lineWidth = 2; c.stroke();
  c.globalAlpha *= 0.12; c.beginPath(); c.arc(X, Y, R, 0, 6.283); c.fill();
  intentReset(c);
}
// funnel: an arrow (X0, Y0) -> (X1, Y1) with a chevron head
function intentArrow(c, X0, Y0, X1, Y1, col, status, w = 3) {
  intentLine(c, [X0, Y0, X1, Y1], col, status, false, w);
  const dx = X1 - X0, dy = Y1 - Y0, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l, hs = 5 + w * 1.6;
  intentStyle(c, col, status === 'planned' ? 'planned' : 'active', w); c.setLineDash([]);
  c.beginPath(); c.moveTo(X1 - ux * hs - uy * hs * 0.7, Y1 - uy * hs + ux * hs * 0.7); c.lineTo(X1, Y1); c.lineTo(X1 - ux * hs + uy * hs * 0.7, Y1 - uy * hs - ux * hs * 0.7); c.stroke();
  intentReset(c);
}
// generic op marker (perimeter / hunt / response / clear / split without geometry): dashed circle + dot
function intentSpot(c, X, Y, R, col, status) {
  intentStyle(c, col, status, 2.2); c.beginPath(); c.arc(X, Y, R, 0, 6.283); c.stroke();
  c.setLineDash([]); c.beginPath(); c.arc(X, Y, 3, 0, 6.283); c.fill();
  intentReset(c);
}
// predicted crowd route: thin red dotted line with a small arrowhead
function intentRoute(c, pts) {
  if (!pts || pts.length < 4) return;
  c.beginPath(); c.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
  c.strokeStyle = 'rgba(255,255,255,.7)'; c.lineWidth = 3.5; c.setLineDash([1, 5]); c.lineCap = 'round'; c.stroke();
  c.strokeStyle = COL.intent.route; c.lineWidth = 2; c.stroke(); c.setLineDash([]);
  const n = pts.length, X1 = pts[n - 2], Y1 = pts[n - 1]; let X0 = pts[n - 4], Y0 = pts[n - 3];
  for (let i = n - 4; i >= 0 && Math.hypot(X1 - X0, Y1 - Y0) < 8; i -= 2) { X0 = pts[i]; Y0 = pts[i + 1]; }
  const l = Math.hypot(X1 - X0, Y1 - Y0) || 1, ux = (X1 - X0) / l, uy = (Y1 - Y0) / l;
  c.fillStyle = COL.intent.route; c.beginPath(); c.moveTo(X1 + ux * 3, Y1 + uy * 3); c.lineTo(X1 - ux * 6 - uy * 4, Y1 - uy * 6 + ux * 4); c.lineTo(X1 - ux * 6 + uy * 4, Y1 - uy * 6 - ux * 4); c.fill();
}
// squad heading to sq.dest: dashed navy line + target tick; transit = brighter blue (vans)
function intentDest(c, X0, Y0, X1, Y1, transit) {
  c.beginPath(); c.moveTo(X0, Y0); c.lineTo(X1, Y1);
  c.strokeStyle = 'rgba(255,255,255,.75)'; c.lineWidth = 4; c.setLineDash([]); c.lineCap = 'round'; c.stroke();
  c.strokeStyle = transit ? COL.snatchHot : COL.intent.dest; c.lineWidth = 2; c.setLineDash([6, 4]); c.lineDashOffset = -(performance.now() / 50) % 10; c.stroke();
  c.setLineDash([]); c.lineDashOffset = 0;
  c.beginPath(); c.arc(X1, Y1, 4.5, 0, 6.283); c.fillStyle = '#fff'; c.fill(); c.lineWidth = 2; c.stroke();
}

const GASC = [0, 0, 0, 0];
const gasRGBA = (a, o = GASC) => { o[0] = 214 - a * 50; o[1] = 226 - a * 40; o[2] = 150 - a * 70; o[3] = 70 + a * 150; return o; };

export function createView2D(sim, canvas) {
  const D = sim.data, W = sim.W, H = sim.H;
  const ctx = canvas.getContext('2d');
  // FX hook: projectiles/fires/explosions layer (src/fx2d.js). view.fxSource overrides the data source (fxdemo.html).
  const fx = createFX2D(), fxV = { s: 1, cx: 0, cy: 0, vw: 0, vh: 0 };
  let fxOn = true;
  const fxRun = f => { if (!fxOn) return; try { f(); } catch (e) { fxOn = false; console.warn('FX layer disabled after error:', e); } };
  const view = { cursor: { x: W / 2, y: H / 2, ok: false }, showNav: false, showDensity: false, showPuffs: true };
  let dpr = 1, vw = 0, vh = 0;
  const cam = { x: W / 2, y: H / 2, s: 0.3 };
  let ui = null;

  // ---------------------------------------------------------------- static map
  // features in draw order, bucketed for tile rendering
  const feats = [];
  const bboxOf = (p, pad = 0) => { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (let i = 0; i < p.length; i += 2) { const x = p[i], y = p[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return [x0 - pad, y0 - pad, x1 + pad, y1 + pad]; };
  for (const a of D.parks || []) feats.push({ k: 0, a, bb: bboxOf(ring(a)) });
  for (const a of D.squares || []) feats.push({ k: 1, a, bb: bboxOf(ring(a)) });
  for (const a of D.water || []) feats.push({ k: 2, a, bb: bboxOf(ring(a)) });
  for (const r of [...D.roads].sort((a, b) => a.w - b.w)) feats.push({ k: 3, a: r, bb: bboxOf(r.p, r.w) });
  for (const b of D.buildings) feats.push({ k: 4, a: b, bb: bboxOf(b.p) });
  feats.forEach((f, i) => { f.o = i; f.stamp = 0; });
  const BC = Math.ceil(W / BUCKET), BR = Math.ceil(H / BUCKET);
  const buckets = Array.from({ length: BC * BR }, () => []);
  for (const f of feats) {
    const i0 = clamp(Math.floor(f.bb[0] / BUCKET), 0, BC - 1), i1 = clamp(Math.floor(f.bb[2] / BUCKET), 0, BC - 1);
    const j0 = clamp(Math.floor(f.bb[1] / BUCKET), 0, BR - 1), j1 = clamp(Math.floor(f.bb[3] / BUCKET), 0, BR - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) buckets[j * BC + i].push(f);
  }
  let stampN = 0;
  function query(x0, y0, x1, y1) {
    const out = [], st = ++stampN;
    const i0 = clamp(Math.floor(x0 / BUCKET), 0, BC - 1), i1 = clamp(Math.floor(x1 / BUCKET), 0, BC - 1);
    const j0 = clamp(Math.floor(y0 / BUCKET), 0, BR - 1), j1 = clamp(Math.floor(y1 / BUCKET), 0, BR - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) for (const f of buckets[j * BC + i]) {
      if (f.stamp === st || f.bb[2] < x0 || f.bb[0] > x1 || f.bb[3] < y0 || f.bb[1] > y1) continue;
      f.stamp = st; out.push(f);
    }
    out.sort((a, b) => a.o - b.o);
    return out;
  }
  // draw the map features of world rect [x0,x1]x[y0,y1] into c (which is wpx x hpx), lvl px per metre
  function drawMap(c, lvl, x0, y0, x1, y1, list) {
    const px = 1 / lvl; // one screen pixel in metres
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = COL.ground; c.fillRect(0, 0, c.canvas.width, c.canvas.height);
    c.setTransform(lvl, 0, 0, -lvl, -x0 * lvl, y1 * lvl);
    c.lineJoin = 'round'; c.lineCap = 'round';
    for (const f of list) if (f.k === 0) { areaPath(c, f.a); c.fillStyle = COL.park; c.fill('evenodd'); if (lvl >= 1) { c.strokeStyle = COL.parkEdge; c.lineWidth = px; c.stroke(); } }
    for (const f of list) if (f.k === 1) { areaPath(c, f.a); c.fillStyle = COL.square; c.fill('evenodd'); if (lvl >= 1) { c.strokeStyle = COL.squareEdge; c.lineWidth = px; c.stroke(); } }
    for (const f of list) if (f.k === 2) { areaPath(c, f.a); c.fillStyle = COL.water; c.fill('evenodd'); c.strokeStyle = COL.waterEdge; c.lineWidth = px; c.stroke(); }
    // roads: casing pass then fill pass
    c.strokeStyle = COL.casing;
    for (const f of list) if (f.k === 3) { const r = f.a; if (r.w <= 3 || r.w * lvl < 2.5) continue; c.lineWidth = r.w + 1.6 * px; linePath(c, r.p); c.stroke(); }
    for (const f of list) if (f.k === 3) {
      const r = f.a, foot = r.w <= 3;
      c.strokeStyle = foot ? COL.foot : r.w >= 14 ? COL.roadMajor : COL.road;
      c.lineWidth = Math.max(r.w, foot ? 0.8 * px : 1.2 * px); linePath(c, r.p); c.stroke();
    }
    c.fillStyle = COL.bld; c.strokeStyle = COL.bldEdge; c.lineWidth = lvl >= 2 ? 1.0 * px : 0.6 * px;
    for (const f of list) if (f.k === 4) { c.beginPath(); polyPath(c, f.a.p); c.fill(); if (lvl >= 1) c.stroke(); }
    c.setTransform(1, 0, 0, 1, 0, 0);
  }
  function areaPath(c, a) { c.beginPath(); polyPath(c, ring(a)); const h = holes(a); if (h) for (const r of h) polyPath(c, r); }

  const base = document.createElement('canvas');
  base.width = Math.ceil(W * BASE_LEVEL); base.height = Math.ceil(H * BASE_LEVEL);
  drawMap(base.getContext('2d'), BASE_LEVEL, 0, 0, W, H, feats);

  const tiles = new Map();
  function getTile(lvl, i, j, budget) {
    const key = lvl + ':' + i + ':' + j;
    let t = tiles.get(key);
    if (t) { tiles.delete(key); tiles.set(key, t); return t; }
    if (budget.n <= 0) return null;
    budget.n--;
    const span = TILE / lvl, x0 = i * span, y0 = j * span, x1 = x0 + span, y1 = y0 + span;
    t = document.createElement('canvas'); t.width = TILE; t.height = TILE;
    drawMap(t.getContext('2d'), lvl, x0, y0, x1, y1, query(x0, y0, x1, y1));
    tiles.set(key, t);
    if (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value);
    return t;
  }

  // ---------------------------------------------------------------- nav overlay
  let navCanvas = null;
  function buildNavCanvas() {
    const { COLS, ROWS, walk } = sim;
    navCanvas = document.createElement('canvas'); navCanvas.width = COLS; navCanvas.height = ROWS;
    const c = navCanvas.getContext('2d'), img = c.createImageData(COLS, ROWS);
    for (let gy = 0; gy < ROWS; gy++) for (let gx = 0; gx < COLS; gx++) {
      const k = ((ROWS - 1 - gy) * COLS + gx) * 4, w = walk[gy * COLS + gx];
      img.data[k] = w ? 40 : 30; img.data[k + 1] = w ? 190 : 30; img.data[k + 2] = w ? 110 : 36; img.data[k + 3] = w ? 120 : 150;
    }
    c.putImageData(img, 0, 0);
  }

  // ---------------------------------------------------------------- transforms
  const sx = x => (x - cam.x) * cam.s + vw / 2;
  const sy = y => vh / 2 - (y - cam.y) * cam.s;
  const wx = X => (X - vw / 2) / cam.s + cam.x;
  const wy = Y => cam.y - (Y - vh / 2) / cam.s;
  const fitScale = () => Math.min(vw / W, vh / H);
  const minScale = () => fitScale() * 0.6, MAX_SCALE = 10;
  function clampCam() {
    cam.s = clamp(cam.s, minScale(), MAX_SCALE);
    // keep at least 30% of the screen (or of the map, if smaller) covered by the map
    const mx = vw / 2 / cam.s, my = vh / 2 / cam.s, ox = 0.3 * Math.min(W, 2 * mx), oy = 0.3 * Math.min(H, 2 * my);
    cam.x = clamp(cam.x, ox - mx, W - ox + mx);
    cam.y = clamp(cam.y, oy - my, H - oy + my);
  }
  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2); vw = innerWidth; vh = innerHeight;
    canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr);
    canvas.style.width = vw + 'px'; canvas.style.height = vh + 'px';
    clampCam();
  }
  resize();
  addEventListener('resize', resize);

  // ---------------------------------------------------------------- dynamic layers
  // density heatmap
  let dens = null, densDc = 0, densCanvas = document.createElement('canvas');
  const RAMP = [[0, 70, 140, 220, 0], [0.4, 40, 170, 230, 110], [1.0, 60, 200, 90, 150], [2.0, 250, 220, 40, 175], [3.5, 250, 120, 20, 195], [5.0, 220, 20, 30, 215]];
  const rampLUT = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    const v = i / 255 * 6; let k = 0; while (k < RAMP.length - 2 && v > RAMP[k + 1][0]) k++;
    const a = RAMP[k], b = RAMP[k + 1], t = clamp((v - a[0]) / (b[0] - a[0]), 0, 1);
    for (let c = 0; c < 4; c++) rampLUT[i * 4 + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * t;
  }
  function drawDensity() {
    const dc = cam.s >= 1 ? 3 : cam.s >= 0.5 ? 6 : 12;
    const DC = Math.ceil(W / dc), DR = Math.ceil(H / dc);
    if (densDc !== dc) { dens = new Float32Array(DC * DR); densDc = dc; } else dens.fill(0);
    const { px, py, NA } = sim;
    for (let i = 0; i < NA; i++) { const ci = Math.floor(px[i] / dc), cj = Math.floor(py[i] / dc); if (ci >= 0 && cj >= 0 && ci < DC && cj < DR) dens[cj * DC + ci]++; }
    const i0 = clamp(Math.floor(wx(0) / dc) - 1, 0, DC - 1), i1 = clamp(Math.ceil(wx(vw) / dc) + 1, 0, DC - 1);
    const j0 = clamp(Math.floor(wy(vh) / dc) - 1, 0, DR - 1), j1 = clamp(Math.ceil(wy(0) / dc) + 1, 0, DR - 1);
    const w = i1 - i0 + 1, h = j1 - j0 + 1;
    if (densCanvas.width !== w || densCanvas.height !== h) { densCanvas.width = w; densCanvas.height = h; }
    const dctx = densCanvas.getContext('2d'), img = dctx.createImageData(w, h), d = img.data, area = dc * dc;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const n = dens[j * DC + i]; if (!n) continue;
      const li = Math.min(255, Math.round(n / area / 6 * 255)) * 4, o = ((j1 - j) * w + (i - i0)) * 4;
      d[o] = rampLUT[li]; d[o + 1] = rampLUT[li + 1]; d[o + 2] = rampLUT[li + 2]; d[o + 3] = rampLUT[li + 3];
    }
    dctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(densCanvas, sx(i0 * dc), sy((j1 + 1) * dc), w * dc * cam.s, h * dc * cam.s);
  }
  // tear gas grid
  const gasCanvas = document.createElement('canvas');
  function drawGas() {
    const box = sim.gasBox; if (!box) return;
    const { gas, GCOLS, GC } = sim, w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1;
    if (gasCanvas.width !== w || gasCanvas.height !== h) { gasCanvas.width = w; gasCanvas.height = h; }
    const gctx = gasCanvas.getContext('2d'), img = gctx.createImageData(w, h), d = img.data;
    for (let j = box.y0; j <= box.y1; j++) for (let i = box.x0; i <= box.x1; i++) {
      const g = gas[j * GCOLS + i]; if (g < 0.01) continue;
      const o = ((box.y1 - j) * w + (i - box.x0)) * 4, a = Math.min(1, Math.sqrt(g / 0.8)), c = gasRGBA(a);
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = c[3];
    }
    gctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(gasCanvas, sx(box.x0 * GC), sy((box.y1 + 1) * GC), w * GC * cam.s, h * GC * cam.s);
  }
  function drawPuffs() {
    const { pX, pY, pSize, pAlpha, NP } = sim;
    if (!NP || cam.s < 0.5) return;
    ctx.fillStyle = '#e4ebc0';
    for (let i = 0; i < NP; i++) {
      const X = sx(pX[i]), Y = sy(pY[i]), r = pSize[i] * 0.5 * cam.s;
      if (X < -r || Y < -r || X > vw + r || Y > vh + r) continue;
      ctx.globalAlpha = pAlpha[i] * 0.7; ctx.beginPath(); ctx.arc(X, Y, r, 0, 6.283); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // agents, batched by colour. Buckets: 0..9 leader colours, 10 idle, 11 panic, 12 wild (riot, no leader),
  // 13 loot carriers, 14 DOWN, 15 ARRESTED. Every optional field (act, riot, cls) is guarded.
  // 16 HOME (heading home at dusk: act HOME or sim.leaving[i]).
  const leaderCss = [], NB = 17, B_IDLE = 10, B_PANIC = 11, B_WILD = 12, B_LOOT = 13, B_DOWN = 14, B_ARR = 15, B_HOME = 16;
  const A_LOOT = 3, A_DOWN = 9, A_ARRESTED = 10, A_HOME = 11, C_PAC = 1, C_ENC = 2, C_MED = 3, C_BLOC = 4;
  const BUCKET_COL = { [B_IDLE]: COL.idle, [B_PANIC]: COL.panic, [B_WILD]: COL.wild, [B_LOOT]: COL.loot, [B_DOWN]: COL.down, [B_ARR]: COL.arrested, [B_HOME]: COL.home };
  const bucketIdx = Array.from({ length: NB }, () => new Int32Array(sim.MAXA)), bucketN = new Int32Array(NB);
  const dotR = s => Math.max(1.6, 0.4 * s); // (0.32 before: people were hard to read at mid zoom)
  // one batch of agent dots in a bucket's style (shared with the legend). pts = flat [X, Y, ...] screen coords.
  function dotBatch(c, b, pts, n, r) {
    const useRect = r < 2.2;
    const shape = (X, Y, rr) => useRect ? c.rect(X - rr, Y - rr, rr * 2, rr * 2) : (c.moveTo(X + rr, Y), c.arc(X, Y, rr, 0, 6.283));
    if (b === B_WILD) { // diamond, dark fill, orange rim (rim drawn as a larger diamond underneath)
      const rd = r * 1.35;
      c.fillStyle = COL.wildRim; c.beginPath(); for (let k = 0; k < n; k++) diamond(c, pts[2 * k], pts[2 * k + 1], rd + 1.1); c.fill();
      c.fillStyle = COL.wild; c.beginPath(); for (let k = 0; k < n; k++) diamond(c, pts[2 * k], pts[2 * k + 1], Math.max(0.8, rd - 0.5)); c.fill();
      return;
    }
    if (b === B_HOME) { // hollow pale dot with a grey rim
      c.fillStyle = COL.homeRim; c.beginPath(); for (let k = 0; k < n; k++) shape(pts[2 * k], pts[2 * k + 1], r + 0.6); c.fill();
      c.fillStyle = COL.home; c.beginPath(); for (let k = 0; k < n; k++) shape(pts[2 * k], pts[2 * k + 1], Math.max(0.6, r - 0.7)); c.fill();
      return;
    }
    if (r >= 1.8) { c.fillStyle = COL.outline; c.beginPath(); for (let k = 0; k < n; k++) shape(pts[2 * k], pts[2 * k + 1], r + 0.8); c.fill(); }
    c.fillStyle = b < 10 ? (leaderCss[b] ||= hex(LEADER_COLORS[b])) : BUCKET_COL[b];
    c.beginPath(); for (let k = 0; k < n; k++) shape(pts[2 * k], pts[2 * k + 1], r); c.fill();
  }
  let ptsBuf = new Float32Array(2048);
  function drawAgents() {
    const { px, py, panicT, lead, NA } = sim, act = sim.act, riot = sim.riot, cls = sim.cls, leaving = sim.leaving;
    const r = dotR(cam.s), m = r + 2;
    bucketN.fill(0);
    const nlc = 10;
    for (let i = 0; i < NA; i++) {
      const X = sx(px[i]), Y = sy(py[i]);
      if (X < -m || Y < -m || X > vw + m || Y > vh + m) continue;
      const a = act ? act[i] : 0;
      const b = a === A_DOWN ? B_DOWN : a === A_ARRESTED ? B_ARR : (a === A_HOME || (leaving && leaving[i])) ? B_HOME : panicT[i] > 0 ? B_PANIC : a === A_LOOT ? B_LOOT
        : lead[i] >= 0 ? lead[i] % nlc : riot && riot[i] >= 0 ? B_WILD : B_IDLE;
      bucketIdx[b][bucketN[b]++] = i;
    }
    // draw order: home and idle first (background), then leaders, wild, panic, loot, arrested
    for (const b of [B_HOME, B_IDLE, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, B_WILD, B_PANIC, B_LOOT, B_ARR]) {
      const nb = bucketN[b]; if (!nb) continue;
      if (ptsBuf.length < nb * 2) ptsBuf = new Float32Array(nb * 2 + 1024);
      const arr = bucketIdx[b];
      for (let n = 0; n < nb; n++) { const i = arr[n]; ptsBuf[2 * n] = sx(px[i]); ptsBuf[2 * n + 1] = sy(py[i]); }
      dotBatch(ctx, b, ptsBuf, nb, r);
    }
    const fill = b => { const nb = bucketN[b], arr = bucketIdx[b]; if (ptsBuf.length < nb * 2) ptsBuf = new Float32Array(nb * 2 + 1024); for (let n = 0; n < nb; n++) { const i = arr[n]; ptsBuf[2 * n] = sx(px[i]); ptsBuf[2 * n + 1] = sy(py[i]); } return nb; };
    if (bucketN[B_DOWN]) { const n = fill(B_DOWN); downBatch(ctx, ptsBuf, n, r); }
    if (bucketN[B_ARR]) { const n = fill(B_ARR); arrestBatch(ctx, ptsBuf, n, r); }
    if (bucketN[B_LOOT] && r >= 2.4) { const n = fill(B_LOOT); lootBatch(ctx, ptsBuf, n, r); }
    // class indicators when zoomed in (randos unmarked). Only for standing agents.
    if (cls && cam.s >= 3.2) {
      for (const cl of [C_BLOC, C_ENC, C_PAC, C_MED]) {
        let n = 0;
        for (let b = 0; b < NB; b++) {
          if (b === B_DOWN || b === B_ARR || !bucketN[b]) continue;
          const arr = bucketIdx[b];
          for (let k = 0; k < bucketN[b]; k++) { const i = arr[k]; if (cls[i] !== cl) continue; if (ptsBuf.length < n * 2 + 2) { const nb2 = new Float32Array(ptsBuf.length * 2); nb2.set(ptsBuf); ptsBuf = nb2; } ptsBuf[2 * n] = sx(px[i]); ptsBuf[2 * n + 1] = sy(py[i]); n++; }
        }
        if (n) classBatch(ctx, cl, ptsBuf, n, r);
      }
    }
  }
  // DOWN: a body lying on the ground (flat dark bar) + red cross; zoomed out just a red cross
  function downBatch(c, pts, nd, r) {
    const big = r >= 2.4;
    if (big) {
      const hw = r * 1.5, hh = r * 0.6;
      c.fillStyle = 'rgba(25,28,34,0.6)'; c.beginPath();
      for (let n = 0; n < nd; n++) c.rect(pts[2 * n] - hw - 0.8, pts[2 * n + 1] - hh - 0.8, hw * 2 + 1.6, hh * 2 + 1.6);
      c.fill();
      c.fillStyle = COL.down; c.beginPath();
      for (let n = 0; n < nd; n++) c.rect(pts[2 * n] - hw, pts[2 * n + 1] - hh, hw * 2, hh * 2);
      c.fill();
    }
    const q = Math.max(2.2, r * 0.9), lw = Math.max(1.4, r * 0.4);
    c.lineCap = 'butt'; c.beginPath();
    for (let n = 0; n < nd; n++) { const X = pts[2 * n], Y = pts[2 * n + 1] - (big ? r * 1.4 : 0); c.moveTo(X - q, Y); c.lineTo(X + q, Y); c.moveTo(X, Y - q); c.lineTo(X, Y + q); }
    c.strokeStyle = '#fff'; c.lineWidth = lw + 1.6; c.stroke();
    c.strokeStyle = COL.downCross; c.lineWidth = lw; c.stroke();
  }
  // ARRESTED: blue ring around the grey dot (the dot itself is drawn by dotBatch)
  function arrestBatch(c, pts, n, r) {
    const lw = Math.max(1.2, r * 0.4);
    c.strokeStyle = COL.arrestRing; c.lineWidth = lw; c.beginPath();
    for (let k = 0; k < n; k++) { const X = pts[2 * k], Y = pts[2 * k + 1], rr = r + 0.8 + lw * 0.5; c.moveTo(X + rr, Y); c.arc(X, Y, rr, 0, 6.283); }
    c.stroke();
  }
  // LOOT: a little yellow bag on the carrier (zoomed in)
  function lootBatch(c, pts, n, r) {
    const q = r * 0.45;
    c.fillStyle = COL.lootBag; c.beginPath();
    for (let k = 0; k < n; k++) c.rect(pts[2 * k] + r * 0.3, pts[2 * k + 1] - r * 0.3 - q, q * 2, q * 2);
    c.fill();
  }
  // class marker drawn on top of the dot: bloc black, encourager yellow, pacifist light blue (inner dot); medic white cross
  function classBatch(c, cl, pts, n, r) {
    const q = Math.max(1, r * 0.5), cross = cl === C_MED;
    c.beginPath();
    for (let k = 0; k < n; k++) {
      const X = pts[2 * k], Y = pts[2 * k + 1];
      if (cross) { const a = Math.max(1.6, r * 0.8), w = Math.max(0.8, r * 0.28); c.rect(X - a, Y - w, a * 2, w * 2); c.rect(X - w, Y - a, w * 2, a * 2); }
      else { c.moveTo(X + q, Y); c.arc(X, Y, q, 0, 6.283); }
    }
    if (cross) { c.strokeStyle = COL.medicCross; c.lineWidth = 1.2; c.stroke(); }
    c.fillStyle = cl === C_BLOC ? COL.bloc : cl === C_ENC ? COL.encourager : cl === C_PAC ? COL.pacifist : COL.medic; c.fill();
  }

  // snatch teams: small dark-blue diamond; brighter while active
  function drawSnatch() {
    const T = sim.snatchTeams; if (!T || !T.length) return;
    const R = Math.max(4.5, 1.1 * cam.s);
    for (const t of T) {
      if (!t || !isFinite(t.x) || !isFinite(t.y)) continue;
      const X = sx(t.x), Y = sy(t.y);
      if (X < -40 || Y < -40 || X > vw + 40 || Y > vh + 40) continue;
      const hot = t.state && t.state !== 'idle' && t.state !== 'return' && t.state !== 'wait';
      snatchDiamond(ctx, X, Y, R, hot);
      if (cam.s >= 1.5) label('SNATCH' + (t.state ? ' · ' + t.state : ''), X, Y - R - 7, { color: '#14254f', font: '700 9px system-ui,Segoe UI,sans-serif' });
    }
  }

  // night/day dimming: fx2d draws the tint (fx.night); if the FX layer died, draw a fallback overlay ourselves
  function dayLight() { const L = sim.day && sim.day.light; return typeof L === 'number' && isFinite(L) ? clamp(L, 0, 1) : 1; }
  function drawNightFallback() {
    const n = 1 - dayLight(); if (n <= 0.01) return;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `rgb(${Math.round(255 - 170 * n)},${Math.round(255 - 160 * n)},${Math.round(255 - 110 * n)})`;
    ctx.fillRect(-50, -50, vw + 100, vh + 100); ctx.globalCompositeOperation = 'source-over';
  }

  const inTransit = sq => !!(sq.transit ?? sq.van);
  // the squad's front row as [centre X, centre Y, half length] in screen px: officers 0..nFront-1 (or row 0), active only
  function frontRow(sq, lx, ly) {
    const na = Math.min(sq.na ?? sq.n, sq.n), ohp = sq.hp, odn = sq.down;
    let nf = sq.nFront;
    if (!(nf > 0)) { nf = 0; if (sq.row && sq.row.length) { for (let k = 0; k < na; k++) if (Math.abs(sq.row[k] || 0) < 0.01) nf++; } if (!nf) nf = Math.max(1, sq.n >> 1); }
    nf = Math.max(1, Math.min(nf, na || 1));
    let cx = 0, cy = 0, c = 0, lo = 1e9, hi = -1e9;
    for (let k = 0; k < nf; k++) {
      if ((ohp && ohp[k] <= 0) || (odn && odn[k])) continue;
      const X = sx(sq.ox[k]), Y = sy(sq.oy[k]); cx += X; cy += Y; c++;
    }
    if (!c) return null;
    cx /= c; cy /= c;
    for (let k = 0; k < nf; k++) {
      if ((ohp && ohp[k] <= 0) || (odn && odn[k])) continue;
      const u = (sx(sq.ox[k]) - cx) * lx + (sy(sq.oy[k]) - cy) * ly; if (u < lo) lo = u; if (u > hi) hi = u;
    }
    const mid = (lo + hi) / 2;
    return [cx + lx * mid, cy + ly * mid, Math.max(7, (hi - lo) / 2 + 2)];
  }
  function officerRect(c, X, Y, lx, ly, fx, fy, hw, hd) {
    c.moveTo(X + lx * hw + fx * hd, Y + ly * hw + fy * hd);
    c.lineTo(X - lx * hw + fx * hd, Y - ly * hw + fy * hd);
    c.lineTo(X - lx * hw - fx * hd, Y - ly * hw - fy * hd);
    c.lineTo(X + lx * hw - fx * hd, Y + ly * hw - fy * hd);
    c.closePath();
  }
  function drawPolice() {
    const s = cam.s, hw = Math.max(0.45 * s, 2.2), hd = Math.max(0.25 * s, 1.3);
    for (const sq of sim.squads) {
      if (inTransit(sq)) { drawVans(sq); continue; }
      const lx = sq.pxu ?? -sq.dy, ly = -(sq.pyu ?? sq.dx), fx = sq.dx, fy = -sq.dy; // screen-space unit vectors
      const ohp = sq.hp, odn = sq.down; let nDown = 0;
      ctx.beginPath();
      for (let k = 0; k < sq.n; k++) {
        const X = sx(sq.ox[k]), Y = sy(sq.oy[k]);
        if (X < -20 || Y < -20 || X > vw + 20 || Y > vh + 20) continue;
        if ((ohp && ohp[k] <= 0) || (odn && odn[k])) { nDown++; continue; }
        officerRect(ctx, X, Y, lx, ly, fx, fy, hw, hd);
      }
      ctx.fillStyle = sq.state === 'charge' ? COL.copCharge : COL.cop; ctx.fill();
      if (s >= 2) { ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 0.8; ctx.stroke(); }
      if (s < 2) { // zoomed out: draw the front row as a bold bar so it reads at a glance
        const fr = frontRow(sq, lx, ly);
        if (fr) squadBar(ctx, fr[0], fr[1], lx, ly, fx, fy, fr[2], s, sq.state === 'charge');
      }
      // hurt officers (hp < 0.5) get a red ring; downed officers lie grey with a red cross
      if (ohp && s >= 2) {
        ctx.beginPath(); let any = false;
        for (let k = 0; k < sq.n; k++) { if (!(ohp[k] > 0 && ohp[k] < 0.5) || (odn && odn[k])) continue; const X = sx(sq.ox[k]), Y = sy(sq.oy[k]); if (X < -20 || Y < -20 || X > vw + 20 || Y > vh + 20) continue; any = true; ctx.moveTo(X + hw, Y); ctx.arc(X, Y, hw, 0, 6.283); }
        if (any) { ctx.strokeStyle = COL.downCross; ctx.lineWidth = 1.2; ctx.stroke(); }
      }
      if (nDown) {
        const c = Math.max(2.2, 0.35 * s);
        const isDown = k => (ohp && ohp[k] <= 0) || (odn && odn[k]);
        ctx.beginPath();
        for (let k = 0; k < sq.n; k++) { if (!isDown(k)) continue; const X = sx(sq.ox[k]), Y = sy(sq.oy[k]); if (X < -20 || Y < -20 || X > vw + 20 || Y > vh + 20) continue; ctx.rect(X - hw, Y - hd * 0.7, hw * 2, hd * 1.4); }
        ctx.fillStyle = COL.copDown; ctx.fill();
        ctx.beginPath();
        for (let k = 0; k < sq.n; k++) { if (!isDown(k)) continue; const X = sx(sq.ox[k]), Y = sy(sq.oy[k]); if (X < -20 || Y < -20 || X > vw + 20 || Y > vh + 20) continue; ctx.moveTo(X - c, Y); ctx.lineTo(X + c, Y); ctx.moveTo(X, Y - c); ctx.lineTo(X, Y + c); }
        ctx.strokeStyle = COL.downCross; ctx.lineWidth = 1.6; ctx.lineCap = 'butt'; ctx.stroke();
      }
    }
  }

  // police vans (fast transit, sq.transit / legacy sq.van): one van per 8 officers, at the mean position of its riders
  function drawVans(sq) {
    const per = 8, na = Math.min(sq.na ?? sq.n, sq.n), nv = Math.max(1, Math.ceil(na / per)), s = cam.s;
    const hl = Math.max(2.8 * s, 9), hw = Math.max(1.1 * s, 3.8);
    const blink = (performance.now() / 250 | 0) & 1;
    for (let v = 0; v < nv; v++) {
      let x = 0, y = 0, n = 0;
      for (let k = v * per; k < Math.min((v + 1) * per, na); k++) { x += sq.ox[k]; y += sq.oy[k]; n++; }
      if (!n) { if (v) continue; x = sq.x; y = sq.y; n = 1; }
      const X = sx(x / n), Y = sy(y / n);
      if (X < -30 || Y < -30 || X > vw + 30 || Y > vh + 30) continue;
      vanShape(ctx, X, Y, Math.atan2(-sq.dy, sq.dx), hl, hw, blink);
    }
  }

  function drawPaths() {
    const t = performance.now() / 1000;
    for (const L of sim.leaders) {
      const F = L.field; if (!F || L.arrived || L.arrested || L.gone) continue;
      const sel = sim.selected.has(L.id), col = hex(L.color);
      if (sel) {
        if (!L.path) L.path = sim.tracePath(F, L.x, L.y);
        const p = L.path;
        ctx.beginPath(); ctx.moveTo(sx(p[0]), sy(p[1]));
        for (let i = 2; i < p.length; i += 2) ctx.lineTo(sx(p[i]), sy(p[i + 1]));
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 5; ctx.stroke();
        ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.setLineDash([8, 6]); ctx.lineDashOffset = -t * 20; ctx.stroke(); ctx.setLineDash([]);
      }
      // target marker
      const X = sx(F.tx), Y = sy(F.ty), R = Math.max(7, 3 * cam.s);
      ctx.globalAlpha = sel ? 1 : 0.55;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(X, Y, R, 0, 6.283); ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X - R - 4, Y); ctx.lineTo(X - R + 3, Y); ctx.moveTo(X + R - 3, Y); ctx.lineTo(X + R + 4, Y);
      ctx.moveTo(X, Y - R - 4); ctx.lineTo(X, Y - R + 3); ctx.moveTo(X, Y + R - 3); ctx.lineTo(X, Y + R + 4); ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  function drawGoal() {
    const [gx, gy] = sim.goal, X = sx(gx), Y = sy(gy), R = Math.max(10, sim.GOAL_R * cam.s);
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 400);
    ctx.fillStyle = `rgba(255,209,102,${0.12 + 0.06 * pulse})`; ctx.beginPath(); ctx.arc(X, Y, R, 0, 6.283); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 5; ctx.stroke();
    ctx.strokeStyle = COL.gold; ctx.lineWidth = 3; ctx.stroke();
  }

  let placed = [];
  const hits = (x0, y0, x1, y1) => placed.some(r => x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]);
  function label(text, X, Y, { color = '#23272e', font = '600 11px system-ui,Segoe UI,sans-serif', halo = 'rgba(255,255,255,.92)', align = 'center' } = {}) {
    ctx.font = font; ctx.textAlign = align; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3.5; ctx.strokeStyle = halo; ctx.lineJoin = 'round'; ctx.strokeText(text, X, Y);
    ctx.fillStyle = color; ctx.fillText(text, X, Y);
  }
  function drawLandmarks() {
    const LM = sim.LM;
    { const [gx, gy] = sim.goal, R = Math.max(10, sim.GOAL_R * cam.s), X = sx(gx), Y = sy(gy) - R - 10;
      label('★ ÉLYSÉE', X, Y, { color: '#9a6b00', font: '800 13px system-ui,Segoe UI,sans-serif' }); }
    for (const k in LM) {
      if (k === 'elysee') continue;
      const [x, y] = LM[k], X = sx(x), Y = sy(y);
      if (X < -80 || Y < -20 || X > vw + 80 || Y > vh + 20) continue;
      const t = lmName(k).toUpperCase();
      ctx.font = '700 10.5px system-ui,Segoe UI,sans-serif'; const w = ctx.measureText(t).width / 2 + 3;
      if (hits(X - w, Y - 18, X + w, Y + 3)) continue;
      placed.push([X - w, Y - 18, X + w, Y + 3]);
      ctx.fillStyle = '#23272e'; ctx.beginPath(); ctx.arc(X, Y, 2.5, 0, 6.283); ctx.fill();
      label(t, X, Y - 10, { color: '#3a3f48', font: '700 10.5px system-ui,Segoe UI,sans-serif' });
    }
  }

  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); }
  function drawLeaders() {
    const R = Math.max(5.5, 1.0 * cam.s);
    // markers (stance badge lower right: green peaceful, amber firm, red unleashed)
    for (const L of sim.leaders) {
      if (L.gone) continue;
      const X = sx(L.x), Y = sy(L.y);
      if (X < -60 || Y < -60 || X > vw + 60 || Y > vh + 60) continue;
      leaderMarker(ctx, X, Y, R, hex(L.color), L.stance, L.arrested, sim.selected.has(L.id));
    }
    // labels
    ctx.font = '600 11px system-ui,Segoe UI,sans-serif'; ctx.textBaseline = 'middle';
    for (const L of sim.leaders) {
      if (L.gone) continue;
      const X = sx(L.x), Y = sy(L.y);
      if (X < -100 || Y < -60 || X > vw + 100 || Y > vh + 60) continue;
      const name = L.name, cnt = L.arrested ? 'ARRESTED' : String(L.count ?? 0) + (L.blockedT > 0 ? ' · blocked by police' : '');
      ctx.font = '700 11px system-ui,Segoe UI,sans-serif'; const wn = ctx.measureText(name).width;
      ctx.font = '500 11px system-ui,Segoe UI,sans-serif'; const wc = ctx.measureText(cnt).width;
      const w = wn + wc + 18, h = 21, bx = X - w / 2, by = Y - R - 10 - h;
      placed.push([bx, by, bx + w, by + h + 4]);
      ctx.fillStyle = 'rgba(18,20,24,.84)'; roundRect(bx, by, w, h, 3); ctx.fill();
      ctx.fillStyle = L.arrested ? COL.arrestRing : hex(L.color); ctx.fillRect(bx, by, 3, h);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#fff'; ctx.font = '700 11px system-ui,Segoe UI,sans-serif'; ctx.fillText(name, bx + 8, by + 8);
      ctx.fillStyle = L.arrested ? '#8fb3ff' : '#d6d9de'; ctx.font = '500 11px system-ui,Segoe UI,sans-serif'; ctx.fillText(cnt, bx + 12 + wn, by + 8);
      // fatigue (energy) bar
      ctx.fillStyle = '#3a3d44'; ctx.fillRect(bx + 8, by + h - 5, w - 14, 2.5);
      if (!L.arrested) { ctx.fillStyle = L.energy > 40 ? '#7bd389' : L.energy > 20 ? '#f4a261' : '#e63946'; ctx.fillRect(bx + 8, by + h - 5, (w - 14) * clamp((L.energy ?? 0) / 100, 0, 1), 2.5); }
      // pointer
      ctx.fillStyle = 'rgba(18,20,24,.84)'; ctx.beginPath(); ctx.moveTo(X - 4, by + h); ctx.lineTo(X + 4, by + h); ctx.lineTo(X, by + h + 4); ctx.fill();
    }
  }
  const squadText = sq => `CRS ${sq.id} · ${inTransit(sq) ? 'by van' : sq.state}` + (sq.tactic ? ` · ${String(sq.tactic).toUpperCase()}` : '');
  function drawPoliceLabels() {
    if (cam.s < 0.25) return;
    for (const sq of sim.squads) {
      const adv = sq.adv || 0, x = sq.x + sq.dx * adv, y = sq.y + sq.dy * adv, off = Math.max(22, 4.5 * cam.s + 10);
      let X = sx(x) - sq.dx * off, Y = sy(y) + sq.dy * off; // behind the line
      if (inTransit(sq)) { X = sx(sq.x); Y = sy(sq.y) - Math.max(22, 2.6 * cam.s + 16); } // above the vans, not on them
      if (X < -60 || Y < -30 || X > vw + 60 || Y > vh + 30) continue;
      const t = squadText(sq);
      ctx.font = '600 10px system-ui,Segoe UI,sans-serif'; const w = ctx.measureText(t).width + 10, h = 16;
      const bx = X - w / 2; let by = Y - h / 2;
      for (let tries = 0; tries < 4 && hits(bx, by, bx + w, by + h); tries++) by += sq.dy <= 0 ? h + 3 : -(h + 3); // dodge other labels
      placed.push([bx, by, bx + w, by + h]);
      policeTag(ctx, t, X, by, w, h, sq.state === 'charge', sq.energy);
    }
  }
  function drawScaleBar() {
    const target = 120 / cam.s, pow = Math.pow(10, Math.floor(Math.log10(target)));
    const m = [1, 2, 5, 10].map(k => k * pow).filter(v => v <= target).pop() || pow, w = m * cam.s;
    const X = vw - 24 - w, Y = vh - 28;
    ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.fillRect(X - 6, Y - 16, w + 12, 24);
    ctx.strokeStyle = '#23272e'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(X, Y - 4); ctx.lineTo(X, Y); ctx.lineTo(X + w, Y); ctx.lineTo(X + w, Y - 4); ctx.stroke();
    ctx.fillStyle = '#23272e'; ctx.font = '600 10px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(m >= 1000 ? m / 1000 + ' km' : m + ' m', X + w / 2, Y - 6);
    ctx.textAlign = 'right'; ctx.fillText('N ↑', vw - 24, Y - 20 - 4);
  }

  // ---------------------------------------------------------------- police intent overlay (O)
  // Reads (all optional): sim.police.plan [{id, kind, x, y, r?, pts?, squads, status}], sim.police.predict [{pts}],
  // sq.dest {x, y} and sq.transit. Also understands the older plan shape {marches: [{path, exits}]}.
  const flatPts = a => {
    if (!a || !a.length) return null;
    if (typeof a[0] === 'number') return a;
    const o = []; for (const p of a) { if (Array.isArray(p)) o.push(p[0], p[1]); else if (p && typeof p.x === 'number') o.push(p.x, p.y); }
    return o.length >= 2 ? o : null;
  };
  const toScr = w => { const o = new Array(w.length); for (let i = 0; i < w.length; i += 2) { o[i] = sx(w[i]); o[i + 1] = sy(w[i + 1]); } return o; };
  const STATUS_WORD = { planned: 'planned', moving: 'moving in', active: '', closing: 'closing', done: 'done' };
  function intentData() {
    const P = sim.police || {}, raw = P.plan;
    const plan = Array.isArray(raw) ? raw : Array.isArray(raw?.ops) ? raw.ops : [];
    let predict = Array.isArray(P.predict) ? P.predict : [];
    if (!predict.length && raw && Array.isArray(raw.marches)) predict = raw.marches.map(m => ({ pts: m.path || m.pts }));
    return { plan, predict };
  }
  function chip(text, X, Y, col, faint) {
    ctx.font = '700 10px system-ui,Segoe UI,sans-serif';
    const w = ctx.measureText(text).width + 12, h = 16; const bx = clamp(X - w / 2, 4, vw - w - 4); let by = clamp(Y - h / 2, 4, vh - h - 4);
    for (let t = 0; t < 5 && hits(bx, by, bx + w, by + h); t++) by -= h + 2;
    placed.push([bx, by, bx + w, by + h]);
    ctx.globalAlpha = faint ? 0.75 : 0.95; ctx.fillStyle = 'rgba(18,20,24,.88)'; roundRect(bx, by, w, h, 3); ctx.fill();
    ctx.fillStyle = col; ctx.fillRect(bx, by, 3, h);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, bx + w / 2 + 1.5, by + h / 2 + 0.5);
    ctx.globalAlpha = 1;
  }
  const intentLabels = [];
  function drawIntent() {
    intentLabels.length = 0;
    const { plan, predict } = intentData();
    // predicted crowd routes
    // v1.7: marches carry 1-3 guessed destinations with conf (0..1): fainter = less sure; the guess is labelled at the route end
    for (const p of predict) {
      const w = flatPts(p && (p.pts || p.path)); if (!w) continue;
      const conf = p.conf ?? 1; ctx.globalAlpha = 0.25 + 0.75 * Math.min(1, conf);
      const sc = toScr(w); intentRoute(ctx, sc);
      if (p.dest && p.kind === 'march' && sc.length >= 2 && (p.rank ?? 0) < 2) {
        const nm = p.dest === 'gate' ? 'Élysée' : lmName(p.dest);
        ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'left';
        const t = `? ${nm} ${Math.round(conf * 100)}%`, X = sc[sc.length - 2] + 6, Y = sc[sc.length - 1] - 6;
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.strokeText(t, X, Y); ctx.fillStyle = COL.intent.route; ctx.fillText(t, X, Y);
      }
      ctx.globalAlpha = 1;
    }
    // planned operations
    for (const op of plan) {
      if (!op) continue;
      const kind = op.kind || 'op', col = COL.intent[kind] || '#555', st = op.status || 'planned';
      const w = flatPts(op.pts), sp = w && toScr(w);
      let ax = op.x, ay = op.y;
      if (!(isFinite(ax) && isFinite(ay)) && w) { ax = 0; ay = 0; for (let i = 0; i < w.length; i += 2) { ax += w[i]; ay += w[i + 1]; } ax /= w.length / 2; ay /= w.length / 2; }
      if (!(isFinite(ax) && isFinite(ay))) continue;
      const X = sx(ax), Y = sy(ay), R = Math.max(8, (op.r || 25) * cam.s);
      if (kind === 'kettle') { intentKettle(ctx, X, Y, R, col, st); if (sp) intentLine(ctx, sp, col, st, true); }
      else if (kind === 'funnel') {
        if (sp && sp.length >= 4) intentArrow(ctx, sp[0], sp[1], sp[sp.length - 2], sp[sp.length - 1], col, st, 3.5);
        else { const dx = op.fx ?? op.dx ?? 1, dy = op.fy ?? op.dy ?? 0, l = Math.hypot(dx, dy) || 1, L = Math.max(24, R); intentArrow(ctx, X - dx / l * L, Y + dy / l * L, X + dx / l * L * 0.3, Y - dy / l * L * 0.3, col, st, 3.5); }
      }
      else if (kind === 'block') {
        if (sp && sp.length === 4) { let [a0, b0, a1, b1] = sp; const l = Math.hypot(a1 - a0, b1 - b0); if (l < 26) { const k = (26 / Math.max(l, 1e-3) - 1) / 2, ex = (a1 - a0) * k, ey = (b1 - b0) * k; if (l < 1e-3) { a0 -= 13; a1 += 13; } else { a0 -= ex; b0 -= ey; a1 += ex; b1 += ey; } } intentBlock(ctx, a0, b0, a1, b1, col, st); } else if (sp) intentLine(ctx, sp, col, st, false, 5); else intentSpot(ctx, X, Y, Math.max(8, 10 * cam.s), col, st); }
      else if (sp) { const closed = (kind === 'cordon' || kind === 'perimeter') && w.length >= 6; intentLine(ctx, sp, col, st, closed); }
      else intentSpot(ctx, X, Y, op.r ? R : Math.max(8, 12 * cam.s), col, st);
      if (st === 'done') continue;
      const where = op.place || (view.placeName ? view.placeName(ax, ay) : '');
      const word = STATUS_WORD[st] ?? st;
      let lY = Y - (kind === 'kettle' || (!sp && op.r) ? R : 0) - 14, lX = X;
      if (sp && kind !== 'kettle') { let k0 = 1; for (let i = 3; i < sp.length; i += 2) if (sp[i] < sp[k0]) k0 = i; if (kind === 'cordon' || kind === 'perimeter') { lX = sp[k0 - 1]; lY = sp[k0] - 14; } else lY = Math.min(lY, sp[k0] - 14); }
      intentLabels.push([`${kind.toUpperCase()}${word ? ' ' + word : ''}${where ? ' · ' + where : ''}`, lX, lY, col, st === 'planned']);
    }
    // squad destinations
    for (const sq of sim.squads) {
      const d = sq.dest; if (!d || !isFinite(d.x) || !isFinite(d.y)) continue;
      const X0 = sx(sq.x), Y0 = sy(sq.y), X1 = sx(d.x), Y1 = sy(d.y);
      if (Math.hypot(X1 - X0, Y1 - Y0) < 6) continue;
      const tr = inTransit(sq);
      intentDest(ctx, X0, Y0, X1, Y1, tr);
      if (tr) vanShape(ctx, X1, Y1 - 11, Math.atan2(Y1 - Y0, X1 - X0) > Math.PI / 2 || Math.atan2(Y1 - Y0, X1 - X0) < -Math.PI / 2 ? Math.PI : 0, 7, 3, (performance.now() / 250 | 0) & 1); // vans arriving here
    }
  }
  function drawIntentLabels() { for (const l of intentLabels) chip(...l); }

  // ---------------------------------------------------------------- legend swatches
  // Draws one legend item into a small canvas context c (CSS px w x h), with the exact game drawing code and palette.
  function legendSwatch(c, key, w, h) {
    const cx = w / 2, cy = h / 2, [k, arg] = key.split(':');
    c.save(); c.clearRect(0, 0, w, h);
    c.fillStyle = COL.ground; c.beginPath(); if (c.roundRect) c.roundRect(0, 0, w, h, 4); else c.rect(0, 0, w, h); c.fill();
    const cluster = (b, r = 3.2) => { const P = [cx - 9, cy - 3, cx - 2, cy + 4, cx + 5, cy - 4, cx + 10, cy + 3, cx + 1, cy - 1]; dotBatch(c, b, P, 5, r); return P; };
    const BK = { idle: B_IDLE, panic: B_PANIC, wild: B_WILD, loot: B_LOOT, arrested: B_ARR, home: B_HOME };
    const CL = { bloc: C_BLOC, encourager: C_ENC, pacifist: C_PAC, medic: C_MED };
    const lfx = fx.legend;
    switch (k) {
      case 'follow': cluster(+arg || 0); break;
      case 'dot': {
        if (arg === 'down') { const P = [cx - 6, cy + 3, cx + 7, cy + 5]; downBatch(c, P, 2, 3.2); break; }
        const P = cluster(BK[arg] ?? B_IDLE);
        if (arg === 'arrested') arrestBatch(c, P, 5, 3.2);
        if (arg === 'loot') lootBatch(c, P, 5, 3.2);
        break;
      }
      case 'cls': { const r = 4.6, P = [cx, cy]; dotBatch(c, 0, P, 1, r); if (CL[arg] != null) classBatch(c, CL[arg], P, 1, r); break; }
      case 'leader': leaderMarker(c, cx - 3, cy - 1.5, 10.8, hex(LEADER_COLORS[0]), arg === 'none' ? null : (arg || 'firm'), arg === 'arrested', false); break;
      case 'officers': { c.beginPath(); for (let i = 0; i < 6; i++) officerRect(c, cx - 15 + i * 6, cy - 2, 1, 0, 0, -1, 2.4, 1.5); for (let i = 0; i < 5; i++) officerRect(c, cx - 12 + i * 6, cy + 4, 1, 0, 0, -1, 2.4, 1.5); c.fillStyle = arg === 'charge' ? COL.copCharge : COL.cop; c.fill(); break; }
      case 'bar': squadBar(c, cx, cy + 2, 1, 0, 0, -1, 14, 1, arg === 'charge'); break;
      case 'copdown': { c.fillStyle = COL.copDown; c.fillRect(cx - 4, cy - 2.2, 8, 4.4); c.beginPath(); c.moveTo(cx - 3.2, cy); c.lineTo(cx + 3.2, cy); c.moveTo(cx, cy - 3.2); c.lineTo(cx, cy + 3.2); c.strokeStyle = COL.downCross; c.lineWidth = 1.6; c.stroke(); break; }
      case 'tag': { c.font = '600 10px system-ui,Segoe UI,sans-serif'; const t = arg === 'van' ? 'van' : 'CRS'; const tw = c.measureText(t).width + 10; policeTag(c, t, cx, cy - 8, tw, 16, false, 70); break; }
      case 'snatch': snatchDiamond(c, cx, cy, 5.5, arg !== 'idle'); break;
      case 'van': vanShape(c, cx, cy, 0, 11, 4.5, 1); break;
      case 'goal': { c.fillStyle = 'rgba(255,209,102,0.18)'; c.beginPath(); c.arc(cx, cy, 8, 0, 6.283); c.fill(); c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 5; c.stroke(); c.strokeStyle = COL.gold; c.lineWidth = 3; c.stroke(); break; }
      case 'icon': if (lfx) lfx.icon(c, arg, cx, cy, 15); break;
      case 'glass': if (lfx) { lfx.decal(c, 'glass', cx - 5, cy + 2, 10); lfx.glints(c, cx + 6, cy - 2, 12); } break;
      case 'decal': if (lfx) lfx.decal(c, arg, cx, cy, arg === 'scorch' ? 11 : 8); break;
      case 'trail': if (lfx) lfx.trail(c, arg, 5, cy + 6, w - 8, cy + (arg === 'lbd' ? 2 : 0), arg === 'lbd' ? 0 : 10, 4); break;
      case 'fire': if (lfx) lfx.fire(c, cx, cy + 2, 6); break;
      case 'smoke': if (lfx) lfx.smoke(c, arg || 'dark', cx, cy, 10); break;
      case 'gas': {
        for (const [dx, dy, r, a] of [[-6, 1, 9, 0.35], [5, -2, 8, 0.6], [1, 3, 5, 0.9]]) { const g = gasRGBA(a, [0, 0, 0, 0]); c.fillStyle = `rgba(${g[0] | 0},${g[1] | 0},${g[2] | 0},${(g[3] / 255).toFixed(2)})`; c.beginPath(); c.arc(cx + dx, cy + dy, r, 0, 6.283); c.fill(); }
        break;
      }
      case 'prop': if (lfx) lfx.prop(c, 'car', arg || 'burnt', cx, cy, 4, 0.3); break;
      case 'shop': if (lfx) lfx.shop(c, cx, cy, 6, arg === 'looted', arg === 'v3' ? 3 : 1); break;
      case 'intent': {
        const col = COL.intent[arg] || COL.intent.cordon, y = cy;
        if (arg === 'block') intentBlock(c, 7, y, w - 7, y, col, 'active');
        else if (arg === 'cordon') intentLine(c, [8, y + 6, 14, y - 6, w - 14, y - 6, w - 8, y + 6], col, 'active', true);
        else if (arg === 'kettle') intentKettle(c, cx, y, 8, col, 'active');
        else if (arg === 'funnel') intentArrow(c, 7, y, w - 6, y, col, 'active', 3);
        else if (arg === 'planned') intentLine(c, [6, y, w - 6, y], COL.intent.cordon, 'planned', false);
        else if (arg === 'active') intentLine(c, [6, y, w - 6, y], COL.intent.cordon, 'active', false);
        else if (arg === 'route') intentRoute(c, [5, y + 5, cx, y - 3, w - 8, y + 1]);
        else if (arg === 'dest') intentDest(c, 6, y + 4, w - 8, y - 3, false);
        else if (arg === 'perimeter') intentLine(c, [7, y + 5, cx, y - 5, w - 7, y + 5], col, 'active', false);
        else if (arg === 'other') { intentSpot(c, cx - 9, y, 7, COL.intent.hunt, 'active'); intentSpot(c, cx + 9, y, 7, COL.intent.response, 'planned'); }
        else if (arg === 'transit') { intentDest(c, 6, y + 7, w - 10, y + 3, true); vanShape(c, w - 10, y - 8, 0, 7, 3, 1); }
        break;
      }
    }
    c.restore();
  }

  // ---------------------------------------------------------------- frame
  const keys = new Set();
  let camGlide = null;
  function frame(rdt) {
    if (camGlide && (drag?.moved)) camGlide = null; // the user grabbed the map: stop any glide
    if (camGlide) { // smooth focus (0.35 s ease)
      const g = camGlide, k = 1 - Math.exp(-rdt * 9); g.t += rdt;
      cam.x += (g.x - cam.x) * k; cam.y += (g.y - cam.y) * k; cam.s += (g.s - cam.s) * k; clampCam();
      if (g.t > 1.2 || (Math.hypot(g.x - cam.x, g.y - cam.y) * cam.s < 0.5 && Math.abs(g.s - cam.s) < 0.01)) camGlide = null;
    }
    // keyboard pan
    let kx = 0, ky = 0;
    if (keys.has('a') || keys.has('arrowleft')) kx--; if (keys.has('d') || keys.has('arrowright')) kx++;
    if (keys.has('w') || keys.has('arrowup')) ky++; if (keys.has('s') || keys.has('arrowdown')) ky--;
    if (kx || ky) { camGlide = null; const sp = 700 / cam.s * rdt; cam.x += kx * sp; cam.y += ky * sp; clampCam(); }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
    // map: base image, then crisp tiles at the right level
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!view.fxSource && !fx.nightOwned) fx.night = 1 - dayLight(); // FX hook: day/night tint
    fxRun(() => { fx.update(rdt, view.fxSource || sim); if (view.fxShake !== false) ctx.translate(fx.shake.x, fx.shake.y); }); // FX hook
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(base, sx(0), sy(H), W * cam.s, H * cam.s);
    const want = cam.s * dpr;
    if (want > BASE_LEVEL * 1.25) {
      const lvl = LEVELS.find(l => l >= want * 0.85) || LEVELS[LEVELS.length - 1], span = TILE / lvl;
      const i0 = Math.max(0, Math.floor(wx(0) / span)), i1 = Math.min(Math.ceil(W / span) - 1, Math.floor(wx(vw) / span));
      const j0 = Math.max(0, Math.floor(wy(vh) / span)), j1 = Math.min(Math.ceil(H / span) - 1, Math.floor(wy(0) / span));
      const budget = { n: view.tileBudget ?? 3 };
      // draw tiles nearest the centre first so the budget goes there
      const list = [];
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) list.push([i, j, Math.hypot((i + 0.5) * span - cam.x, (j + 0.5) * span - cam.y)]);
      list.sort((a, b) => a[2] - b[2]);
      const sz = span * cam.s;
      for (const [i, j] of list) {
        const t = getTile(lvl, i, j, budget);
        if (t) ctx.drawImage(t, Math.floor(sx(i * span)), Math.floor(sy((j + 1) * span)), Math.ceil(sz + 0.5), Math.ceil(sz + 0.5));
      }
      view.pendingTiles = budget.n <= 0;
    } else view.pendingTiles = false;
    if (view.showNav) {
      if (!navCanvas) buildNavCanvas();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(navCanvas, sx(0), sy(sim.ROWS * sim.CELL), sim.COLS * sim.CELL * cam.s, sim.ROWS * sim.CELL * cam.s);
      ctx.imageSmoothingEnabled = true;
    }
    fxRun(() => { Object.assign(fxV, { s: cam.s, cx: cam.x, cy: cam.y, vw, vh }); fx.drawUnder(ctx, fxV); }); // FX hook
    // dusk/night tint goes on the map only, under people and police, so their colours stay readable at dusk
    if (fxOn) { fx.opts.tint = false; fxRun(() => fx.drawTint(ctx, fxV)); } else drawNightFallback();
    drawGoal();
    drawPaths();
    if (view.showDensity) { ctx.globalAlpha = 0.35; drawAgents(); ctx.globalAlpha = 1; drawDensity(); } else drawAgents();
    drawPolice();
    drawSnatch();
    drawGas();
    if (view.showPuffs) drawPuffs();
    fxRun(() => fx.draw(ctx, fxV)); // FX hook
    { const [gx, gy] = sim.goal, R = Math.max(10, sim.GOAL_R * cam.s), X = sx(gx), Y = sy(gy) - R - 10;
      placed = [[X - 42, Y - 10, X + 42, Y + 10]]; } // reserve the goal label first
    if (view.showIntent) { try { drawIntent(); } catch (e) { console.warn('intent overlay error', e); view.showIntent = false; } }
    drawLeaders();
    drawPoliceLabels();
    if (view.showIntent) drawIntentLabels();
    drawLandmarks();
    drawScaleBar();
  }

  // ---------------------------------------------------------------- input
  let drag = null;
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, y: e.clientY, b: e.button, cx: cam.x, cy: cam.y, moved: false };
    try { canvas.setPointerCapture(e.pointerId); } catch {}
  });
  canvas.addEventListener('pointermove', e => {
    view.cursor.x = wx(e.clientX); view.cursor.y = wy(e.clientY); view.cursor.ok = true;
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 5) drag.moved = true;
    if (drag.moved && drag.b === 0) { cam.x = drag.cx - dx / cam.s; cam.y = drag.cy + dy / cam.s; clampCam(); canvas.style.cursor = 'grabbing'; }
  });
  canvas.addEventListener('pointerup', e => {
    const d = drag; drag = null; canvas.style.cursor = '';
    if (!d || d.moved || !ui) return;
    ui.click(wx(e.clientX), wy(e.clientY), d.b, e.shiftKey);
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault(); camGlide = null;
    const bx = wx(e.clientX), by = wy(e.clientY);
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    cam.s = clamp(cam.s * Math.exp(-dy * 0.0015), minScale(), MAX_SCALE);
    cam.x = bx - (e.clientX - vw / 2) / cam.s; cam.y = by + (e.clientY - vh / 2) / cam.s;
    clampCam();
  }, { passive: false });
  const PAN_KEYS = new Set(['w', 'a', 's', 'd', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown']);
  addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
  addEventListener('blur', () => keys.clear());

  Object.assign(view, {
    cam, frame, fx, // FX hook
    attach(u) { ui = u; },
    onKey(e, k) {
      if (PAN_KEYS.has(k)) { keys.add(k); e.preventDefault(); return true; }
      if (k === 'k') { view.showDensity = !view.showDensity; ui?.toast(view.showDensity ? 'Crowd density heatmap on' : 'Density heatmap off'); return true; }
      if (k === 'm') { view.showPuffs = !view.showPuffs; return true; }
      if (k === '0') { view.fitAll(); return true; }
      return false;
    },
    pickRadius: () => Math.max(6, 14 / cam.s),
    toggleNav() { view.showNav = !view.showNav; },
    toggleDensity() { view.showDensity = !view.showDensity; },
    // v1.5: focus pans smoothly and only zooms in when asked (or when zoomed far out); it used to snap to
    // zoom 2.5 on every call (ticker clicks, double-clicks on the leader list), the 'camera jump'.
    // Only an explicit instant=true snaps; a requested zoom glides there too.
    focus(x, y, zoom, instant) {
      const s = zoom || (cam.s < 0.6 ? Math.min(1.4, cam.s * 2.2) : cam.s);
      if (instant) { cam.x = x; cam.y = y; cam.s = s; clampCam(); camGlide = null; return; }
      camGlide = { x, y, s, t: 0 };
    },
    showIntent: false,
    legendSwatch, // (ctx, key, w, h): draw one legend item with the game's own drawing code
    placeName: null, // set by the UI: (x, y) -> 'rue Royale'
    fitAll() { const left = vw > 900 ? 280 : 0; cam.s = Math.max(minScale(), Math.min((vw - left - 10) / W, (vh - 10) / H)); cam.x = W / 2 - (left / 2) / cam.s; cam.y = H / 2; clampCam(); },
    initCamera(start) {
      // fit start + goal into the screen area right of the HUD panel
      const g = sim.goal, dx = Math.abs(start[0] - g[0]) + 400, dy = Math.abs(start[1] - g[1]) + 400, left = vw > 900 ? 280 : 0;
      cam.s = clamp(Math.min((vw - left - 20) / dx, (vh - 40) / dy), minScale(), MAX_SCALE);
      cam.x = (start[0] + g[0]) / 2 - (left / 2) / cam.s; cam.y = (start[1] + g[1]) / 2; clampCam();
    },
    toScreen: (x, y) => [sx(x), sy(y)], toWorld: (X, Y) => [wx(X), wy(Y)],
    // render every tile needed for the current view now (for screenshots / tests)
    warmTiles() { view.tileBudget = 1e9; frame(0); view.tileBudget = 3; },
  });
  return view;
}
