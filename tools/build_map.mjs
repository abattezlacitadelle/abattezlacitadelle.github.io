// Build riot-sim/data/paris.js from OpenStreetMap (Overpass API).
// Usage: node tools/build_map.mjs [--refetch] [--bbox south,west,north,east] [--out file] [--preview file]
//        [--crop south,west,north,east] [--crop-out file]   (extra high-res preview crop)
// Raw Overpass responses are cached in data/raw/*.json (always for the full default bbox).
// With --bbox, the cached data is filtered/clipped to the sub-bbox (must lie inside the cached area),
// road polylines are clipped too, and `spawnPoints` are emitted.
// Example: node tools/build_map.mjs --bbox 48.8505,2.3085,48.8725,2.3530 --out data/paris-small.js
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = path.join(ROOT, 'data', 'raw');
fs.mkdirSync(RAW, { recursive: true });

const argv = process.argv.slice(2);
const argVal = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

// Full cached (fetch) area
const FS = 48.8460, FW = 2.2990, FN = 48.8745, FE = 2.3760;
const BB = `${FS},${FW},${FN},${FE}`;
const bboxArg = argVal('--bbox');
const CUSTOM = !!bboxArg;
let S = FS, W = FW, N = FN, E = FE, LAT0 = 48.8603;
if (CUSTOM) {
  const v = bboxArg.split(',').map(Number);
  if (v.length !== 4 || v.some(isNaN) || v[0] >= v[2] || v[1] >= v[3]) throw new Error('--bbox expects south,west,north,east');
  [S, W, N, E] = v;
  LAT0 = Math.round((S + N) / 2 * 1e6) / 1e6;
  if (S < FS || W < FW || N > FN || E > FE) console.warn('WARNING: --bbox extends outside the cached area; edges will be empty');
}
const OUT = path.resolve(ROOT, argVal('--out') || path.join('data', 'paris.js'));
const PREVIEW = argVal('--preview') ? path.resolve(ROOT, argVal('--preview'))
  : path.basename(OUT) === 'paris.js' ? path.join(path.dirname(OUT), 'preview.png')
  : path.join(path.dirname(OUT), path.basename(OUT, '.js').replace(/^paris/, 'preview') + (/^paris/.test(path.basename(OUT)) ? '' : '-preview') + '.png');
const KX = 111320 * Math.cos(LAT0 * Math.PI / 180);
const KY = 110574;
const TOL = 0.4;
const REFETCH = argv.includes('--refetch');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const QUERIES = {
  roads: `[out:json][timeout:300];way["highway"](${BB});out geom;`,
  buildings: `[out:json][timeout:300];(way["building"](${BB});relation["building"](${BB}););out geom;`,
  water: `[out:json][timeout:300];(way["natural"="water"](${BB});way["waterway"="riverbank"](${BB});relation["natural"="water"](${BB});relation["waterway"="riverbank"](${BB}););out geom;`,
  parks: `[out:json][timeout:300];(way["leisure"~"^(park|garden)$"](${BB});relation["leisure"~"^(park|garden)$"](${BB});way["landuse"="grass"](${BB});relation["landuse"="grass"](${BB}););out geom;`,
  squares: `[out:json][timeout:300];(way["highway"="pedestrian"]["area"="yes"](${BB});relation["highway"="pedestrian"](${BB});way["place"="square"](${BB});relation["place"="square"](${BB});way["area:highway"](${BB});relation["area:highway"](${BB}););out geom;`,
  landmarks: `[out:json][timeout:120];(
    nwr["name"="Palais de l'Élysée"](${BB});
    nwr["name"="Place de la Concorde"](${BB});
    nwr["name"="Place de la République"](${BB});
    nwr["name"="Place de la Bastille"](${BB});
    nwr["amenity"="townhall"]["name"~"Hôtel de Ville"](${BB});
    nwr["name"~"^Cathédrale Notre-Dame de Paris"](${BB});
    nwr["name"="Palais du Louvre"](${BB});
    nwr["name"="Musée du Louvre"](${BB});
    nwr["name"="Place du Châtelet"](${BB});
    nwr["name"="Place Beauvau"](${BB});
    nwr["name"="Hôtel de Beauvau"](${BB});
    nwr["name"~"Madeleine"]["building"](${BB});
    nwr["name"~"^Église de la Madeleine"](${BB});
    nwr["name"="Palais Garnier"](${BB});
    nwr["name"="Pont Neuf"](${BB});
  );out center tags;`,
  shops: `[out:json][timeout:300];(
    nwr["shop"](${BB});
    nwr["amenity"~"^(bank|bureau_de_change|pharmacy|fast_food|restaurant|cafe|bar)$"](${BB});
  );out tags geom;`,
  props: `[out:json][timeout:300];(
    node["amenity"~"^(waste_basket|waste_disposal|recycling|bicycle_rental|bicycle_parking|motorcycle_parking)$"](${BB});
    node["highway"="bus_stop"](${BB});
    way["amenity"="parking"](${BB});
    nwr["landuse"="construction"](${BB});
    nwr["building"="construction"](${BB});
    way["highway"="construction"](${BB});
  );out tags geom;`,
};

async function fetchQuery(name) {
  const file = path.join(RAW, `${name}.json`);
  if (!REFETCH && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  let lastErr;
  for (const ep of ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        console.log(`fetch ${name} <- ${ep}`);
        const res = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'riot-sim-map-builder/1.0' },
          body: 'data=' + encodeURIComponent(QUERIES[name]),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const txt = await res.text();
        const json = JSON.parse(txt);
        if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(json.remark);
        fs.writeFileSync(file, txt);
        return json;
      } catch (e) {
        lastErr = e;
        console.log(`  failed: ${e.message}`);
        await new Promise(r => setTimeout(r, 15000));
      }
    }
  }
  throw lastErr;
}

// ---------- geometry helpers ----------
const r1 = v => Math.round(v * 10) / 10;
const proj = (lat, lon) => [(lon - W) * KX, (lat - S) * KY];
const WIDTH = r1((E - W) * KX), HEIGHT = r1((N - S) * KY);
const geomToPts = g => g.filter(Boolean).map(p => proj(p.lat, p.lon));

function areaSigned(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}
function stripClose(pts) {
  if (pts.length > 1) { const a = pts[0], b = pts[pts.length - 1]; if (a[0] === b[0] && a[1] === b[1]) return pts.slice(0, -1); }
  return pts;
}
function dp(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let d;
      if (L2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        let t = ((px - ax) * dx + (py - ay) * dy) / L2; t = Math.max(0, Math.min(1, t));
        d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      }
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function simplifyRing(ring, tol) {
  ring = stripClose(ring);
  if (ring.length < 4) return ring;
  // split at point farthest from ring[0] so DP works on two open chains
  let far = 0, fd = -1;
  for (let i = 1; i < ring.length; i++) { const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = dp(ring.slice(0, far + 1), tol);
  const b = dp(ring.slice(far).concat([ring[0]]), tol);
  return a.concat(b.slice(1, -1));
}
function dedupe(pts) {
  const out = [];
  for (const p of pts) { const q = [r1(p[0]), r1(p[1])]; const l = out[out.length - 1]; if (!l || l[0] !== q[0] || l[1] !== q[1]) out.push(q); }
  return out;
}
// Sutherland–Hodgman clip of ring to the bbox rectangle
function clipRing(ring) {
  const edges = [
    p => p[0] >= 0, p => p[0] <= WIDTH, p => p[1] >= 0, p => p[1] <= HEIGHT,
  ];
  const inter = [
    (a, b) => { const t = (0 - a[0]) / (b[0] - a[0]); return [0, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (WIDTH - a[0]) / (b[0] - a[0]); return [WIDTH, a[1] + t * (b[1] - a[1])]; },
    (a, b) => { const t = (0 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), 0]; },
    (a, b) => { const t = (HEIGHT - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), HEIGHT]; },
  ];
  let out = stripClose(ring);
  for (let e = 0; e < 4; e++) {
    const inp = out; out = [];
    if (!inp.length) break;
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i], prev = inp[(i + inp.length - 1) % inp.length];
      const ci = edges[e](cur), pi = edges[e](prev);
      if (ci) { if (!pi) out.push(inter[e](prev, cur)); out.push(cur); }
      else if (pi) out.push(inter[e](prev, cur));
    }
  }
  return out;
}
function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}
const intersectsBox = pts => { const [x0, y0, x1, y1] = bboxOf(pts); return x1 >= 0 && y1 >= 0 && x0 <= WIDTH && y0 <= HEIGHT; };
// Liang–Barsky clip of a polyline to the bbox rectangle; returns the inside pieces (each >= 2 pts)
function clipPolyline(pts) {
  const pieces = [];
  let cur = null;
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const dx = x1 - x0, dy = y1 - y0;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, x0], [dx, WIDTH - x0], [-dy, y0], [dy, HEIGHT - y0]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok) { if (cur) { pieces.push(cur); cur = null; } continue; }
    const a = t0 === 0 ? pts[i - 1] : [x0 + t0 * dx, y0 + t0 * dy];
    const b = t1 === 1 ? pts[i] : [x0 + t1 * dx, y0 + t1 * dy];
    if (cur && same(cur[cur.length - 1], a)) cur.push(b);
    else { if (cur) pieces.push(cur); cur = [a, b]; }
    if (t1 < 1) { pieces.push(cur); cur = null; }
  }
  if (cur) pieces.push(cur);
  return pieces.filter(p => p.length >= 2);
}
function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const unflat = f => { const o = []; for (let i = 0; i < f.length; i += 2) o.push([f[i], f[i + 1]]); return o; };
const flat = pts => { const o = []; for (const [x, y] of pts) o.push(x, y); return o; };
const ccw = pts => (areaSigned(pts) < 0 ? pts.slice().reverse() : pts);
const cw = pts => (areaSigned(pts) > 0 ? pts.slice().reverse() : pts);

// Assemble ways (arrays of lat/lon geometry) into closed rings by matching endpoints.
function assembleRings(segs) {
  const key = p => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
  const pool = segs.filter(s => s && s.length >= 2).map(s => s.slice());
  const rings = [];
  let openDropped = 0;
  while (pool.length) {
    let cur = pool.pop();
    let guard = 0;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 100000) {
      const endK = key(cur[cur.length - 1]);
      let found = -1, rev = false;
      for (let i = 0; i < pool.length; i++) {
        if (key(pool[i][0]) === endK) { found = i; break; }
        if (key(pool[i][pool[i].length - 1]) === endK) { found = i; rev = true; break; }
      }
      if (found < 0) break;
      let nx = pool.splice(found, 1)[0];
      if (rev) nx = nx.slice().reverse();
      cur = cur.concat(nx.slice(1));
    }
    if (key(cur[0]) === key(cur[cur.length - 1])) rings.push(cur);
    else openDropped++;
  }
  return { rings, openDropped };
}

// Convert an Overpass element (way or multipolygon relation) to [{outer, inners}] in metres (unclipped)
function elementPolys(el, stats) {
  if (el.type === 'way') {
    if (!el.geometry || el.geometry.length < 4) return [];
    const g = el.geometry;
    if (g[0].lat !== g[g.length - 1].lat || g[0].lon !== g[g.length - 1].lon) return [];
    return [{ outer: stripClose(geomToPts(g)), inners: [] }];
  }
  if (el.type === 'relation') {
    const t = el.tags || {};
    if (t.type && t.type !== 'multipolygon' && t.type !== 'boundary' && t.type !== 'building') return [];
    const outerSegs = [], innerSegs = [];
    for (const m of el.members || []) {
      if (m.type !== 'way' || !m.geometry) continue;
      const g = m.geometry.filter(Boolean);
      if (m.role === 'inner') innerSegs.push(g); else if (m.role === 'outer' || m.role === '' || m.role === 'outline') outerSegs.push(g);
    }
    const o = assembleRings(outerSegs), i = assembleRings(innerSegs);
    if (stats) { stats.openDropped = (stats.openDropped || 0) + o.openDropped + i.openDropped; }
    const outers = o.rings.map(r => ({ outer: stripClose(geomToPts(r)), inners: [] }));
    for (const r of i.rings) {
      const pts = stripClose(geomToPts(r));
      const host = outers.find(ob => pointInRing(pts[0], ob.outer)) || outers.find(ob => pts.some(p => pointInRing(p, ob.outer)));
      if (host) host.inners.push(pts);
    }
    return outers;
  }
  return [];
}

function processAreas(elements, filter, label) {
  const stats = {};
  const out = [];
  const seen = new Set();
  for (const el of elements) {
    if (filter && !filter(el)) continue;
    const id = el.type + el.id; if (seen.has(id)) continue; seen.add(id);
    for (const poly of elementPolys(el, stats)) {
      if (!intersectsBox(poly.outer)) continue;
      const o = dedupe(simplifyRing(clipRing(poly.outer), TOL));
      if (o.length < 3 || Math.abs(areaSigned(o)) < 4) continue;
      const rec = { o: flat(ccw(o)) };
      const holes = [];
      for (const h of poly.inners) {
        if (!intersectsBox(h)) continue;
        const c = dedupe(simplifyRing(clipRing(h), TOL));
        if (c.length >= 3 && Math.abs(areaSigned(c)) >= 4) holes.push(flat(cw(c)));
      }
      if (holes.length) rec.i = holes;
      out.push(rec);
    }
  }
  if (stats.openDropped) console.log(`  ${label}: ${stats.openDropped} unclosed ring chains dropped`);
  return out;
}

// ---------- main ----------
const data = {};
for (const k of Object.keys(QUERIES)) data[k] = await fetchQuery(k);

// Roads
const EXCL_HW = new Set(['construction', 'proposed', 'abandoned', 'razed', 'platform', 'bus_stop', 'elevator', 'corridor', 'services', 'rest_area', 'traffic_island', 'disused']);
const DEF_W = { motorway: 18, trunk: 18, primary: 18, secondary: 14, tertiary: 11, unclassified: 8, residential: 8, living_street: 7, pedestrian: 7, service: 5, footway: 3, path: 3, cycleway: 3, steps: 3, track: 3, bridleway: 3 };
const baseKind = k => k.replace(/_link$/, '');
const roads = [];
let roadDropShort = 0;
for (const el of data.roads.elements) {
  if (el.type !== 'way' || !el.geometry) continue;
  const t = el.tags || {};
  const k = t.highway;
  if (!k || EXCL_HW.has(k)) continue;
  if (t.area === 'yes') continue;
  const layer = parseFloat(t.layer);
  if (!isNaN(layer) && layer < 0) continue;
  if (t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage') continue;
  if (t.indoor === 'yes' || (t.level && parseFloat(t.level) < 0)) continue;
  const raw = geomToPts(el.geometry);
  if (!intersectsBox(raw)) continue;
  const pieces = CUSTOM ? clipPolyline(raw) : [raw];
  let w = parseFloat(String(t.width || '').replace(',', '.'));
  if (isNaN(w)) w = DEF_W[baseKind(k)] ?? 5; else w = Math.max(2, Math.min(40, w));
  for (const piece of pieces) {
    const pts = dedupe(dp(piece, TOL));
    if (pts.length < 2) continue;
    let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (len < 0.5) { roadDropShort++; continue; }
    const r = { k, w };
    if (t.bridge && t.bridge !== 'no') r.b = 1;
    if (t.name) r.n = t.name;
    r.p = flat(pts);
    roads.push(r);
  }
}

// Buildings
const buildings = [];
const bStats = {};
const seenB = new Set();
for (const el of data.buildings.elements) {
  const t = el.tags || {};
  if (!t.building || t.building === 'no') continue;
  const id = el.type + el.id; if (seenB.has(id)) continue; seenB.add(id);
  const layer = parseFloat(t.layer);
  if (!isNaN(layer) && layer < 0) continue;
  const religious = /Notre-Dame/i.test(t.name || '') || ['church', 'cathedral', 'chapel', 'basilica'].includes(t.building) || t.amenity === 'place_of_worship';
  let h = parseFloat(String(t.height || '').replace(',', '.'));
  if (isNaN(h)) { const lv = parseFloat(t['building:levels']); h = isNaN(lv) ? 20 : lv * 3.2 + 1; }
  h = Math.max(4, Math.min(religious ? 90 : 60, h));
  h = r1(h);
  for (const poly of elementPolys(el, bStats)) {
    if (!intersectsBox(poly.outer)) continue;
    const o = dedupe(simplifyRing(poly.outer, TOL));
    if (o.length < 3 || Math.abs(areaSigned(o)) < 12) continue;
    buildings.push({ h, p: flat(ccw(o)) });
  }
}
if (bStats.openDropped) console.log(`  buildings: ${bStats.openDropped} unclosed chains dropped`);

// Water / parks / squares
const water = processAreas(data.water.elements, el => {
  const t = el.tags || {};
  const layer = parseFloat(t.layer);
  if (!isNaN(layer) && layer < 0) return false;
  if ((t.tunnel && t.tunnel !== 'no') || t.covered === 'yes' || t.location === 'underground') return false;
  return t.natural === 'water' || t.waterway === 'riverbank';
}, 'water');
const seineRel = data.water.elements.find(e => e.type === 'relation' && /Seine/i.test((e.tags || {}).name || ''));
console.log('Seine relation:', seineRel ? `${seineRel.id} "${seineRel.tags.name}" members=${seineRel.members.length}` : 'NOT FOUND');

const parks = processAreas(data.parks.elements, el => {
  const t = el.tags || {};
  return t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'grass';
}, 'parks');
const squares = processAreas(data.squares.elements, el => {
  const t = el.tags || {};
  const layer = parseFloat(t.layer); if (!isNaN(layer) && layer < 0) return false;
  return (t.highway === 'pedestrian' && (t.area === 'yes' || el.type === 'relation')) || t.place === 'square' || !!t['area:highway'];
}, 'squares');

// Landmarks
const lmEls = data.landmarks.elements.map(e => {
  const c = e.center || (e.lat != null ? { lat: e.lat, lon: e.lon } : null);
  return c ? { name: (e.tags || {}).name || '', tags: e.tags || {}, type: e.type, c } : null;
}).filter(Boolean);
const pref = { relation: 0, way: 1, node: 2 };
function pickLM(test, fallback) {
  const c = lmEls.filter(e => test(e)).sort((a, b) => pref[a.type] - pref[b.type]);
  const ll = c.length ? c[0].c : { lat: fallback[0], lon: fallback[1] };
  const [x, y] = proj(ll.lat, ll.lon);
  return { xy: [r1(x), r1(y)], src: c.length ? `${c[0].type} "${c[0].name}"` : 'fallback' };
}
const LM_DEFS = {
  elysee: [e => e.name === "Palais de l'Élysée", [48.8704, 2.3167]],
  concorde: [e => e.name === 'Place de la Concorde', [48.8656, 2.3212]],
  republique: [e => e.name === 'Place de la République', [48.8675, 2.3637]],
  bastille: [e => e.name === 'Place de la Bastille', [48.8532, 2.3691]],
  hotelDeVille: [e => e.tags.amenity === 'townhall' && /ville de Paris/i.test((e.name + ';' + (e.tags.alt_name || ''))), [48.85643, 2.35253]],
  notreDame: [e => /^Cathédrale Notre-Dame de Paris/.test(e.name) && e.type !== 'node', [48.8530, 2.3499]],
  louvre: [e => e.name === 'Palais du Louvre' || e.name === 'Musée du Louvre', [48.8606, 2.3376]],
  chatelet: [e => e.name === 'Place du Châtelet', [48.8578, 2.3470]],
  beauvau: [e => e.name === 'Place Beauvau', [48.8716, 2.3165]],
  madeleine: [e => /^Église de la Madeleine/.test(e.name), [48.8700, 2.3245]],
  operaGarnier: [e => e.name === 'Palais Garnier', [48.8720, 2.3316]],
  pontNeuf: [e => e.name === 'Pont Neuf', [48.8575, 2.3413]],
};
const landmarks = {};
const inBox = ([x, y]) => x >= 0 && y >= 0 && x <= WIDTH && y <= HEIGHT;
for (const [k, [test, fb]] of Object.entries(LM_DEFS)) {
  const r = pickLM(test, fb);
  if (CUSTOM && k !== 'elysee' && !inBox(r.xy)) { console.log(`  landmark ${k}: outside bbox, skipped`); continue; }
  landmarks[k] = r.xy;
  console.log(`  landmark ${k}: [${r.xy}] from ${r.src}`);
}

// Extra landmarks + protest spawn points for sub-bbox maps. Areas are looked up by name in the
// cached parks/squares data (bounds centre); points are then snapped to the nearest walkable spot
// (not in a building/water; inside a square/park polygon, else nearest point on a non-bridge road >= 5 m wide).
let spawnPoints;
if (CUSTOM) {
  const findArea = (set, name, fb) => {
    const e = data[set].elements.find(el => (el.tags || {}).name === name && el.bounds);
    const ll = e ? { lat: (e.bounds.minlat + e.bounds.maxlat) / 2, lon: (e.bounds.minlon + e.bounds.maxlon) / 2 } : { lat: fb[0], lon: fb[1] };
    return { xy: proj(ll.lat, ll.lon), src: e ? `${set} ${e.type} "${name}"` : 'fallback' };
  };
  const prep = list => list.map(a => { const o = unflat(a.o); return { o, i: (a.i || []).map(unflat), bb: bboxOf(o) }; });
  const inPoly = (p, P) => p[0] >= P.bb[0] && p[0] <= P.bb[2] && p[1] >= P.bb[1] && p[1] <= P.bb[3] && pointInRing(p, P.o) && !P.i.some(h => pointInRing(p, h));
  const walkPolys = prep([...squares, ...parks]);
  const blockPolys = prep([...buildings.map(b => ({ o: b.p })), ...water]);
  const blocked = p => blockPolys.some(P => inPoly(p, P));
  // Walkable = not inside a building or water polygon, and inside a square/park or on a (non-bridge) road.
  function snapWalkable(p) {
    if (!blocked(p) && walkPolys.some(P => inPoly(p, P))) return { xy: p, d: 0, via: 'area' };
    const cands = [];
    for (const r of roads) {
      if (r.w < 5 || r.b) continue;
      for (let i = 2; i < r.p.length; i += 2) {
        const ax = r.p[i - 2], ay = r.p[i - 1], bx = r.p[i], by = r.p[i + 1];
        const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        const t = L2 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2)) : 0;
        const q = [ax + t * dx, ay + t * dy], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (d < 300) cands.push({ xy: q, d, via: r.n || r.k });
      }
    }
    cands.sort((u, v) => u.d - v.d);
    return cands.find(c => !blocked(c.xy)) || { xy: null };
  }
  const EXTRA_LM = {
    palaisRoyal: findArea('squares', 'Place du Palais Royal', [48.86255, 2.33678]),
    tuileries: findArea('parks', 'Jardin des Tuileries', [48.8637, 2.3267]),
  };
  for (const [k, r] of Object.entries(EXTRA_LM)) {
    const xy = [r1(r.xy[0]), r1(r.xy[1])];
    if (!inBox(xy)) continue;
    landmarks[k] = xy;
    console.log(`  landmark ${k}: [${xy}] from ${r.src}`);
  }
  // Snap landmark points (except the Élysée win target) onto walkable ground
  // Hints: walkable forecourt in front of monuments whose centre is deep inside a building
  const LM_HINT = {
    hotelDeVille: [48.85665, 2.35130],  // Place de l'Hôtel de Ville
    notreDame: [48.85340, 2.34800],     // Parvis Notre-Dame – Place Jean-Paul II
    operaGarnier: [48.87100, 2.33180],  // Place de l'Opéra
    palaisRoyal: [48.86250, 2.33700],   // Place du Palais Royal
  };
  for (const k of Object.keys(landmarks)) {
    if (k === 'elysee') continue;
    if (LM_HINT[k]) { const h = proj(...LM_HINT[k]); if (inBox(h)) landmarks[k] = [r1(h[0]), r1(h[1])]; }
    const s = snapWalkable(landmarks[k]);
    if (s.xy && s.d) { landmarks[k] = [r1(s.xy[0]), r1(s.xy[1])]; console.log(`    snap landmark ${k} -> [${landmarks[k]}] (${s.d.toFixed(1)} m, ${s.via})`); }
  }
  // East-side protest starting places (lat, lon)
  const SPAWN_DEFS = {
    hotelDeVille: [48.85665, 2.35130],   // Place de l'Hôtel de Ville (parvis)
    chatelet: [48.85790, 2.34700],       // Place du Châtelet, north side
    louvreRivoli: [48.86080, 2.34100],   // rue de Rivoli at Louvre-Rivoli / Place du Louvre
    pontNeuf: [48.85690, 2.34200],       // Place du Pont-Neuf on Île de la Cité (by Place Dauphine)
  };
  spawnPoints = {};
  for (const [k, [lat, lon]] of Object.entries(SPAWN_DEFS)) {
    const s = snapWalkable(proj(lat, lon));
    if (!s.xy || !inBox(s.xy)) { console.log(`  spawn ${k}: outside bbox, skipped`); continue; }
    spawnPoints[k] = [r1(s.xy[0]), r1(s.xy[1])];
    console.log(`  spawn ${k}: [${spawnPoints[k]}] (${s.d ? `snapped ${s.d.toFixed(1)} m to ${s.via}` : 'inside square/park'})`);
  }
}

// ---------- shops, props, riot spawns ----------
// Seeded PRNG (mulberry32) so the output is deterministic.
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rnd = mulberry32(0x5EED1789);

// Spatial grid (20 m cells) over road segments and polygons for walkability tests.
const GC = 20;
const gkey = (cx, cy) => (cx + 4000) * 10000 + (cy + 4000);
function makeGrid() {
  const m = new Map();
  return {
    add(x0, y0, x1, y1, item) {
      for (let cx = Math.floor(x0 / GC); cx <= Math.floor(x1 / GC); cx++)
        for (let cy = Math.floor(y0 / GC); cy <= Math.floor(y1 / GC); cy++) {
          const k = gkey(cx, cy); let a = m.get(k); if (!a) m.set(k, a = []); a.push(item);
        }
    },
    at(x, y) { return m.get(gkey(Math.floor(x / GC), Math.floor(y / GC))) || []; },
    near(x, y, r) { // unique items in cells within r
      const s = new Set();
      for (let cx = Math.floor((x - r) / GC); cx <= Math.floor((x + r) / GC); cx++)
        for (let cy = Math.floor((y - r) / GC); cy <= Math.floor((y + r) / GC); cy++)
          for (const it of m.get(gkey(cx, cy)) || []) s.add(it);
      return s;
    },
  };
}
const segGrid = makeGrid(), blockGrid = makeGrid(), areaGrid = makeGrid();
const NON_CAR = new Set(['footway', 'path', 'cycleway', 'steps', 'track', 'bridleway', 'pedestrian']);
roads.forEach((r, ri) => {
  const hw = r.w / 2;
  for (let i = 2; i < r.p.length; i += 2) {
    const s = { ax: r.p[i - 2], ay: r.p[i - 1], bx: r.p[i], by: r.p[i + 1], hw, ri, k: r.k };
    segGrid.add(Math.min(s.ax, s.bx) - hw, Math.min(s.ay, s.by) - hw, Math.max(s.ax, s.bx) + hw, Math.max(s.ay, s.by) + hw, s);
  }
});
const mkPoly = (o, i, sq) => { const P = { o: unflat(o), i: (i || []).map(unflat), sq }; P.bb = bboxOf(P.o); return P; };
for (const b of buildings) { const P = mkPoly(b.p); blockGrid.add(...P.bb, P); }
for (const w of water) { const P = mkPoly(w.o, w.i); blockGrid.add(...P.bb, P); }
for (const a of squares) { const P = mkPoly(a.o, a.i, 1); areaGrid.add(...P.bb, P); }
for (const a of parks) { const P = mkPoly(a.o, a.i, 0); areaGrid.add(...P.bb, P); }
const inP = (p, P) => p[0] >= P.bb[0] && p[0] <= P.bb[2] && p[1] >= P.bb[1] && p[1] <= P.bb[3] && pointInRing(p, P.o) && !P.i.some(h => pointInRing(p, h));
const isBlocked = p => blockGrid.at(p[0], p[1]).some(P => inP(p, P));
const inSquare = p => areaGrid.at(p[0], p[1]).some(P => P.sq && inP(p, P));
const inArea = p => areaGrid.at(p[0], p[1]).some(P => inP(p, P));
function segNearest(s, p) {
  const dx = s.bx - s.ax, dy = s.by - s.ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - s.ax) * dx + (p[1] - s.ay) * dy) / L2)) : 0;
  const q = [s.ax + t * dx, s.ay + t * dy];
  return { q, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
}
const onRoad = p => segGrid.at(p[0], p[1]).some(s => segNearest(s, p).d <= s.hw);
const walkable = p => !isBlocked(p) && (onRoad(p) || inArea(p));
// Nearest walkable point to p within maxD: for each nearby road, the point of its walkable band
// (centreline +/- half width) facing p, backed off toward the centreline until it is outside
// buildings/water; plus the nearest point (0.5 m inside) of any nearby square/park polygon.
function snapWalk(p, maxD) {
  if (walkable(p)) return { xy: p, d: 0 };
  let best = null;
  const consider = c => { const d = Math.hypot(c[0] - p[0], c[1] - p[1]); if (d <= maxD && (!best || d < best.d)) best = { xy: c, d }; };
  for (const s of segGrid.near(p[0], p[1], maxD)) {
    const { q, d } = segNearest(s, p);
    if (d - s.hw > maxD) continue;
    const ux = d ? (p[0] - q[0]) / d : 0, uy = d ? (p[1] - q[1]) / d : 0;
    for (let o = Math.min(d, Math.max(0, s.hw - 0.4)); o >= 0; o -= 0.5) {
      const c = [q[0] + ux * o, q[1] + uy * o];
      if (best && Math.hypot(c[0] - p[0], c[1] - p[1]) >= best.d) break;
      if (!isBlocked(c)) { consider(c); break; }
    }
  }
  for (const P of areaGrid.near(p[0], p[1], maxD)) {
    const ring = P.o;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const { q, d } = segNearest({ ax: a[0], ay: a[1], bx: b[0], by: b[1] }, p);
      if (d > maxD || (best && d >= best.d)) continue;
      const ex = b[0] - a[0], ey = b[1] - a[1], L = Math.hypot(ex, ey) || 1;
      for (const sg of [1, -1]) { const c = [q[0] - sg * ey / L * 0.5, q[1] + sg * ex / L * 0.5]; if (inP(c, P) && !isBlocked(c)) { consider(c); break; } }
    }
  }
  return best;
}
const inMap = p => p[0] >= 0 && p[1] >= 0 && p[0] <= WIDTH && p[1] <= HEIGHT;
const elCenter = el => {
  if (el.lat != null) return proj(el.lat, el.lon);
  if (el.bounds) return proj((el.bounds.minlat + el.bounds.maxlat) / 2, (el.bounds.minlon + el.bounds.maxlon) / 2);
  if (el.geometry) { const bb = bboxOf(geomToPts(el.geometry)); return [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2]; }
  return null;
};
const elVerts = el => {
  if (el.geometry) return geomToPts(el.geometry);
  const o = []; for (const m of el.members || []) if (m.geometry) o.push(...geomToPts(m.geometry)); return o;
};

// --- shops ---
const LUX_BRANDS = /\b(chanel|dior|louis vuitton|herm[eè]s|gucci|prada|cartier|saint laurent|balenciaga|givenchy|c[eé]line|fendi|valentino|versace|bulgari|bvlgari|van cleef|chaumet|boucheron|tiffany|rolex|burberry|loewe|bottega veneta|miu miu|dolce|armani|lanvin|goyard|moncler|chopard|piaget|omega|patek philippe|jaeger|audemars|montblanc|berluti|mcqueen|chlo[eé]|ralph lauren|hublot|breguet|messika|mauboussin|repossi|dinh van|graff|harry winston|longines|tag heuer|richard mille|vacheron|breitling|zegna|brioni|kiton|tom ford|jimmy choo|louboutin|roger vivier|delvaux|loro piana|brunello cucinelli|max mara|ala[iï]a|schiaparelli|mugler|rimowa)\b/i;
const LUX_STREET = /saint-honor[eé]|montaigne|fran[cç]ois (1er|ier)|george v|champs-[eé]lys[eé]es|rue royale|place vend[oô]me|rue de la paix|rue de castiglione/i;
const V3 = new Set(['jewelry', 'watches', 'electronics', 'mobile_phone', 'amenity:bank']);
const V2 = new Set(['clothes', 'shoes', 'sports', 'department_store', 'supermarket', 'cosmetics', 'perfumery', 'computer']);
const FASHIONY = /^(clothes|boutique|fashion|fashion_accessories|bag|shoes|leather|jewelry|watches|perfumery|cosmetics)$/;
function shopValue(k, t) {
  if (V3.has(k)) return 3;
  if (LUX_BRANDS.test(t.brand || '') || (FASHIONY.test(k) && LUX_BRANDS.test(t.name || ''))) return 3;
  if (/^(boutique|clothes|fashion)$/.test(k) && (t['addr:postcode'] === '75008' || LUX_STREET.test(t['addr:street'] || ''))) return 3;
  if (V2.has(k)) return 2;
  return 1;
}
const shops = [];
const shopStats = { total: 0, dropped: 0, v: { 1: 0, 2: 0, 3: 0 } };
const seenS = new Set();
for (const el of data.shops.elements) {
  const t = el.tags || {};
  const id = el.type + el.id; if (seenS.has(id)) continue; seenS.add(id);
  let k;
  if (t.shop) { if (/^(vacant|no|disused)$/.test(t.shop)) continue; k = t.shop; }
  else if (t.amenity) k = 'amenity:' + t.amenity; else continue;
  const c = elCenter(el);
  if (!c || !inMap(c)) continue;
  shopStats.total++;
  let s = snapWalk(c, 25);
  if (el.type !== 'node') { // large shop polygons: also snap from the outline, keep the result nearest the centre
    const vs = elVerts(el);
    const step = Math.max(1, Math.floor(vs.length / 40));
    for (let i = 0; i < vs.length; i += step) {
      const sv = snapWalk(vs[i], 25);
      if (sv) { const d = Math.hypot(sv.xy[0] - c[0], sv.xy[1] - c[1]); if (!s || d < s.d) s = { xy: sv.xy, d }; }
    }
  }
  if (!s || !inMap(s.xy)) { shopStats.dropped++; continue; }
  const v = shopValue(k, t);
  shopStats.v[v]++;
  const rec = { x: r1(s.xy[0]), y: r1(s.xy[1]), k };
  if (t.name) rec.n = t.name;
  rec.v = v; rec.ox = r1(c[0]); rec.oy = r1(c[1]);
  shops.push(rec);
}
console.log(`shops: ${shops.length} kept of ${shopStats.total} (dropped ${shopStats.dropped} not snappable within 25 m); v1=${shopStats.v[1]} v2=${shopStats.v[2]} v3=${shopStats.v[3]}`);

// --- props ---
const props = [];
const pc = {};
const addProp = (xy, k, a) => { const p = { x: r1(xy[0]), y: r1(xy[1]), k }; if (a != null) p.a = Math.round(a * 100) / 100; props.push(p); pc[k] = (pc[k] || 0) + 1; return p; };
// true if p lies on the carriageway of another (vehicular) road than ri
const roadConflict = (p, ri, margin) => segGrid.at(p[0], p[1]).some(s => s.ri !== ri && !NON_CAR.has(s.k) && segNearest(s, p).d < s.hw + margin);

// OSM point props (snapped to walkable within 15 m)
const PROP_KIND = { waste_basket: 'bin', waste_disposal: 'bin', recycling: 'bin', bicycle_rental: 'scooter', bicycle_parking: 'scooter', motorcycle_parking: 'bike' };
const osmBins = [];
const parkingAreas = [];
for (const el of data.props.elements) {
  const t = el.tags || {};
  if (el.type === 'node' && (PROP_KIND[t.amenity] || t.highway === 'bus_stop')) {
    const c = proj(el.lat, el.lon); if (!inMap(c)) continue;
    const s = snapWalk(c, 15); if (!s || !inMap(s.xy)) continue;
    const k = t.highway === 'bus_stop' ? 'bus_stop' : PROP_KIND[t.amenity];
    const p = addProp(s.xy, k);
    if (k === 'bin') osmBins.push([p.x, p.y]);
  } else if (t.landuse === 'construction' || t.building === 'construction' || t.highway === 'construction') {
    let c;
    if (t.highway === 'construction' && el.geometry) { const g = geomToPts(el.geometry); c = g[Math.floor(g.length / 2)]; }
    else c = elCenter(el);
    if (!c || !inMap(c)) continue;
    const s = snapWalk(c, 60); if (!s || !inMap(s.xy)) continue;
    addProp(s.xy, 'construction');
  } else if (el.type === 'way' && t.amenity === 'parking' && el.geometry && !/underground|multi-storey|rooftop/.test(t.parking || '') && t.location !== 'underground' && !(parseFloat(t.layer) < 0)) {
    const g = stripClose(geomToPts(el.geometry));
    if (g.length >= 3 && intersectsBox(g)) parkingAreas.push(g);
  }
}

// Generated kerbside cars: residential/tertiary/secondary streets >= 10 m wide, not bridges/squares/pedestrian.
// Slots every ~6 m on both kerbs at (w/2 - 1.5) from the centreline; occupancy is a 2-state Markov
// chain (P(occ|occ)=0.6, P(occ|free)=0.17 -> ~30% mean, clustered gaps).
const CAR_KINDS = new Set(['residential', 'tertiary', 'secondary', 'tertiary_link', 'secondary_link', 'unclassified']);
let cars = [];
const carRej = { blocked: 0, square: 0, conflict: 0, corner: 0 };
roads.forEach((r, ri) => {
  if (!CAR_KINDS.has(r.k) || r.w < 10 || r.b) return;
  const pts = unflat(r.p);
  let len = 0; const cum = [0];
  for (let i = 1; i < pts.length; i++) { len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); cum.push(len); }
  const off = r.w / 2 - 1.5;
  for (const side of [1, -1]) {
    let occ = rnd() < 0.3, seg = 1;
    for (let d = 7 + rnd() * 3; d < len - 7; d += 5.6 + rnd() * 1.2) {
      occ = rnd() < (occ ? 0.6 : 0.17);
      if (!occ) continue;
      while (seg < pts.length - 1 && cum[seg] < d) seg++;
      const a = pts[seg - 1], b = pts[seg], L = cum[seg] - cum[seg - 1] || 1, u = d - cum[seg - 1];
      const tx = (b[0] - a[0]) / L, ty = (b[1] - a[1]) / L;
      // keep clear of vertices (corners) by 2.5 m
      if (u < 2.5 && seg > 1 || L - u < 2.5 && seg < pts.length - 1) { carRej.corner++; continue; }
      const c = [a[0] + tx * u - ty * off * side, a[1] + ty * u + tx * off * side];
      if (!inMap(c)) continue;
      if (isBlocked(c)) { carRej.blocked++; continue; }
      if (inSquare(c)) { carRej.square++; continue; }
      if (roadConflict(c, ri, 1)) { carRej.conflict++; continue; }
      cars.push({ xy: c, a: Math.atan2(ty, tx) });
    }
  }
});
// a few cars per surface parking lot, aligned with the lot's longest edge
let lotCars = 0;
for (const g of parkingAreas) {
  const area = Math.abs(areaSigned(g)); if (area < 40) continue;
  let la = 0, ll = 0;
  for (let i = 0; i < g.length; i++) { const a = g[i], b = g[(i + 1) % g.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > ll) { ll = l; la = Math.atan2(b[1] - a[1], b[0] - a[0]); } }
  const n = Math.min(8, Math.max(1, Math.floor(area / 80))), bb = bboxOf(g);
  const mine = [];
  for (let tries = 0; mine.length < n && tries < n * 30; tries++) {
    const c = [bb[0] + rnd() * (bb[2] - bb[0]), bb[1] + rnd() * (bb[3] - bb[1])];
    if (!pointInRing(c, g) || !inMap(c) || isBlocked(c)) continue;
    if (mine.some(o => Math.hypot(o[0] - c[0], o[1] - c[1]) < 3.5)) continue;
    mine.push(c); cars.push({ xy: c, a: la }); lotCars++;
  }
}
const CAR_CAP = Math.round(2500 * (WIDTH * HEIGHT) / (3262 * 2433));
const carsRaw = cars.length;
if (cars.length > CAR_CAP) { // deterministic thinning
  for (let i = cars.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cars[i], cars[j]] = [cars[j], cars[i]]; }
  cars = cars.slice(0, CAR_CAP);
}
for (const c of cars) addProp(c.xy, 'car', c.a);
console.log(`cars: ${cars.length} (generated ${carsRaw}, of which ${lotCars} in ${parkingAreas.length} surface lots; cap ${CAR_CAP}); kerb slots rejected: ${JSON.stringify(carRej)}`);

// Generated bins every ~60 m along streets when OSM has too few (< 60% of one per 60 m of street)
let streetLen = 0;
for (const r of roads) if (!NON_CAR.has(r.k) && r.k !== 'service' && !r.b) for (let i = 2; i < r.p.length; i += 2) streetLen += Math.hypot(r.p[i] - r.p[i - 2], r.p[i + 1] - r.p[i - 1]);
const binTarget = streetLen / 60;
let genBins = 0;
if (osmBins.length < binTarget * 0.6) {
  const binGrid = makeGrid();
  for (const b of osmBins) binGrid.add(b[0], b[1], b[0], b[1], b);
  roads.forEach((r, ri) => {
    if (NON_CAR.has(r.k) || r.k === 'service' || r.b || r.w < 7) return;
    const pts = unflat(r.p); let side = rnd() < 0.5 ? 1 : -1;
    let acc = 20 + rnd() * 40;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!L) continue;
      const tx = (b[0] - a[0]) / L, ty = (b[1] - a[1]) / L, off = r.w / 2 - 0.7;
      for (; acc < L; acc += 55 + rnd() * 10) {
        side = -side;
        const c = [a[0] + tx * acc - ty * off * side, a[1] + ty * acc + tx * off * side];
        if (!inMap(c) || isBlocked(c) || roadConflict(c, ri, 0.5)) continue;
        if ([...binGrid.near(c[0], c[1], 30)].some(o => Math.hypot(o[0] - c[0], o[1] - c[1]) < 30)) continue;
        binGrid.add(c[0], c[1], c[0], c[1], c);
        addProp(c, 'bin'); genBins++;
      }
      acc -= L;
    }
  });
}
console.log(`bins: ${osmBins.length} from OSM + ${genBins} generated (street length ${(streetLen / 1000).toFixed(1)} km)`);
console.log('props:', JSON.stringify(pc));

// --- riot spawns (suggested uncontrolled riot locations) ---
const RIOT_DEFS = [
  ['vendome', 48.86750, 2.32940, 200],     // Place Vendôme
  ['opera', 48.87060, 2.33190, 250],       // Place de l'Opéra
  ['palaisRoyal', 48.86490, 2.33790, 150], // Jardin du Palais-Royal
  ['madeleine', 48.86940, 2.32440, 120],   // Place de la Madeleine, south edge / rue Royale
  ['rivoli', 48.86330, 2.33240, 90],       // rue de Rivoli at Place des Pyramides
];
const riotSpawns = [];
const elyseeXY = landmarks.elysee;
for (const [name, lat, lon, n] of RIOT_DEFS) {
  const s = snapWalk(proj(lat, lon), 60);
  if (!s || !inMap(s.xy)) { console.log(`  riotSpawn ${name}: outside map, skipped`); continue; }
  const dE = elyseeXY ? Math.hypot(s.xy[0] - elyseeXY[0], s.xy[1] - elyseeXY[1]) : Infinity;
  const dS = Math.min(Infinity, ...Object.values(spawnPoints || {}).map(q => Math.hypot(s.xy[0] - q[0], s.xy[1] - q[1])));
  if (dE < 400 || dS < 150) { console.log(`  riotSpawn ${name}: too close (elysee ${dE.toFixed(0)} m, spawn ${dS.toFixed(0)} m), skipped`); continue; }
  riotSpawns.push({ x: r1(s.xy[0]), y: r1(s.xy[1]), n });
  console.log(`  riotSpawn ${name}: [${r1(s.xy[0])},${r1(s.xy[1])}] n=${n} (elysee ${dE.toFixed(0)} m, nearest spawn ${isFinite(dS) ? dS.toFixed(0) + ' m' : 'n/a'})`);
}

const meta = { bbox: [S, W, N, E], lat0: LAT0, width: WIDTH, height: HEIGHT, attribution: '© OpenStreetMap contributors' };
const out = { meta, roads, buildings, water, parks, squares, landmarks };
if (spawnPoints) out.spawnPoints = spawnPoints;
out.shops = shops; out.props = props; out.riotSpawns = riotSpawns;
const js = 'window.PARIS_DATA = ' + JSON.stringify(out) + ';\n';
fs.writeFileSync(OUT, js);
console.log(`roads=${roads.length} buildings=${buildings.length} water=${water.length} parks=${parks.length} squares=${squares.length}`);
console.log(`size=${(Buffer.byteLength(js) / 1048576).toFixed(2)} MB  (${WIDTH} x ${HEIGHT} m)`);

// ---------- preview PNG (pure JS rasteriser) ----------
// Overlays: shops (v1 yellow, v2 orange, v3 magenta), cars (blue), bins (green), other props (white),
// riotSpawns (orange rings), landmarks (red), spawnPoints (cyan).
// --crop south,west,north,east renders a high-res crop (roads drawn at true width) to --crop-out.
function png(w, h, rgb) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = b => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function render(file, SC, X0, Y0, X1, Y1, detail) {
  const PW = Math.ceil((X1 - X0) * SC), PH = Math.ceil((Y1 - Y0) * SC);
  const img = Buffer.alloc(PW * PH * 3, 0);
  for (let i = 0; i < PW * PH; i++) { img[i * 3] = 40; img[i * 3 + 1] = 40; img[i * 3 + 2] = 44; }
  const toPx = (x, y) => [(x - X0) * SC, (Y1 - y) * SC]; // north up
  const setPx = (x, y, c) => { if (x < 0 || y < 0 || x >= PW || y >= PH) return; const o = (y * PW + x) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; };
  const visible = f => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (let i = 0; i < f.length; i += 2) { x0 = Math.min(x0, f[i]); x1 = Math.max(x1, f[i]); y0 = Math.min(y0, f[i + 1]); y1 = Math.max(y1, f[i + 1]); } return x1 >= X0 - 40 && x0 <= X1 + 40 && y1 >= Y0 - 40 && y0 <= Y1 + 40; };
  function fillPoly(rings, c) { // even-odd scanline over all rings (holes)
    if (!visible(rings[0])) return;
    const edges = [];
    let ymin = Infinity, ymax = -Infinity;
    for (const fr of rings) {
      const n = fr.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = toPx(fr[i * 2], fr[i * 2 + 1]), b = toPx(fr[j * 2], fr[j * 2 + 1]);
        if (a[1] === b[1]) continue;
        edges.push([a, b]); ymin = Math.min(ymin, a[1], b[1]); ymax = Math.max(ymax, a[1], b[1]);
      }
    }
    for (let y = Math.max(0, Math.floor(ymin)); y <= Math.min(PH - 1, Math.ceil(ymax)); y++) {
      const yc = y + 0.5, xs = [];
      for (const [a, b] of edges) if ((a[1] > yc) !== (b[1] > yc)) xs.push(a[0] + (yc - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) for (let x = Math.max(0, Math.ceil(xs[i] - 0.5)); x <= Math.min(PW - 1, Math.floor(xs[i + 1] - 0.5)); x++) setPx(x, y, c);
    }
  }
  function line(p, c, thick) {
    if (!visible(p)) return;
    const r = Math.max(0, thick / 2), ri = Math.ceil(r);
    for (let i = 2; i < p.length; i += 2) {
      const a = toPx(p[i - 2], p[i - 1]), b = toPx(p[i], p[i + 1]);
      const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])) + 1;
      for (let s = 0; s <= steps; s++) {
        const x = a[0] + (b[0] - a[0]) * s / steps, y = a[1] + (b[1] - a[1]) * s / steps;
        for (let dx = -ri; dx <= ri; dx++) for (let dy = -ri; dy <= ri; dy++) if (dx * dx + dy * dy <= r * r + 0.5) setPx(Math.round(x) + dx, Math.round(y) + dy, c);
      }
    }
  }
  const dot = (x, y, rad, c, ring) => { const [px, py] = toPx(x, y); const R = Math.ceil(rad); for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) { const d2 = dx * dx + dy * dy; if (d2 <= rad * rad && (!ring || d2 >= (rad - ring) * (rad - ring))) setPx(Math.round(px) + dx, Math.round(py) + dy, c); } };
  function rect(x, y, a, hl, hw, c) { // oriented rectangle, half length/width in metres
    const ca = Math.cos(a), sa = Math.sin(a);
    const P = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([u, v]) => [x + u * ca - v * sa, y + u * sa + v * ca]);
    fillPoly([flat(P)], c);
  }
  for (const p of parks) fillPoly([p.o, ...(p.i || [])], [60, 120, 60]);
  for (const p of squares) fillPoly([p.o, ...(p.i || [])], [150, 140, 110]);
  for (const p of water) fillPoly([p.o, ...(p.i || [])], [50, 110, 200]);
  if (detail) { // roads at true width (the walkable band), then centrelines
    for (const r of roads) line(r.p, NON_CAR.has(r.k) ? [95, 95, 88] : [78, 78, 84], r.w * SC);
    for (const b of buildings) fillPoly([b.p], [150, 150, 155]);
    for (const r of roads) line(r.p, r.b ? [255, 220, 120] : [120, 120, 125], 1);
  } else {
    for (const b of buildings) fillPoly([b.p], [140, 140, 145]);
    for (const r of roads) line(r.p, r.b ? [255, 220, 120] : [235, 235, 235], r.w >= 11 ? 2 : 1);
  }
  const PCOL = { bin: [40, 220, 90], scooter: [255, 255, 255], bike: [200, 200, 255], bus_stop: [255, 255, 0], construction: [255, 120, 0] };
  for (const p of props) {
    if (p.k === 'car') { if (detail) rect(p.x, p.y, p.a, 2.2, 0.9, [40, 90, 230]); else dot(p.x, p.y, 1.2, [60, 110, 255]); }
    else dot(p.x, p.y, detail ? 0.6 * SC : 1, PCOL[p.k] || [255, 255, 255]);
  }
  const VCOL = { 1: [240, 230, 40], 2: [255, 140, 0], 3: [255, 0, 220] };
  for (const s of shops) {
    if (detail) { line([s.ox, s.oy, s.x, s.y], [90, 20, 20], 1); dot(s.ox, s.oy, 1.5, [120, 40, 40]); }
    dot(s.x, s.y, detail ? 0.9 * SC : 1.5, VCOL[s.v]);
  }
  for (const [x, y] of Object.values(landmarks)) dot(x, y, 5, [230, 30, 30]);
  for (const [x, y] of Object.values(spawnPoints || {})) dot(x, y, 5, [0, 230, 230]);
  for (const r of riotSpawns) { dot(r.x, r.y, Math.max(6, r.n / 25 * SC * 10 / SC), [255, 110, 0], 2.5); dot(r.x, r.y, 2.5, [255, 110, 0]); }
  fs.writeFileSync(file, png(PW, PH, img));
  console.log(`preview ${PW}x${PH} -> ${file}`);
}
render(PREVIEW, CUSTOM ? 0.5 : 0.35, 0, 0, WIDTH, HEIGHT, false);
if (argVal('--crop')) {
  const [cs, cw, cn, ce] = argVal('--crop').split(',').map(Number);
  const [x0, y0] = proj(cs, cw), [x1, y1] = proj(cn, ce);
  const cropOut = argVal('--crop-out') ? path.resolve(ROOT, argVal('--crop-out')) : PREVIEW.replace(/\.png$/, '-crop.png');
  render(cropOut, Math.min(4, 2400 / (x1 - x0)), x0, y0, x1, y1, true);
}
