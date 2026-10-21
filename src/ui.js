// Shared HUD, keyboard commands, day-loop overlays, event ticker and main loop. Works with any view that implements:
//   view.cursor        {x, y, ok}  world position under the mouse
//   view.focus(x, y)   centre the camera on a world point
//   view.frame(rdt)    draw one frame (rdt = real seconds since last frame)
//   view.pickRadius()  world radius for click-selecting a leader
//   view.toggleNav() / view.toggleDensity?()   overlays
//   view.onKey?(e, k)  view-specific keys; return true if handled
//   view.toScreen?(x, y) -> [X, Y]   optional; used for the briefing's spawn markers
//   view.fx?.night     optional; set to 1 - sim.day.light each frame
import { clamp, lmName } from './sim.js';

const $ = id => document.getElementById(id);
export const hex = c => '#' + c.toString(16).padStart(6, '0');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const STANCE_LABEL = { peaceful: 'Peaceful', firm: 'Firm', unleashed: 'Unleashed' };
const PHASE_LABEL = { briefing: 'Briefing', day: 'Day', dusk: 'Dusk', summary: 'Night', ended: 'Over' };
const hhmm = t => `${String(Math.floor(t / 3600) % 24).padStart(2, '0')}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}`;

// styles for the legend panel, HUD toggles and gauges (injected so both index.html and index3d.html get them)
const UI2_CSS = `
#hudbtns { display:flex; gap:5px; margin-top:7px; }
#hudbtns button.tog { flex:1; padding:3px 6px; font-size:11.5px; }
#hudbtns button.tog.on { background:#e9e6df; color:#15171b; border-color:#e9e6df; font-weight:600; }
#hudbtns button.tog kbd { background:rgba(0,0,0,.25); color:inherit; border-radius:3px; padding:0 3px; font:10px ui-monospace,monospace; margin-left:3px; }
#hudbtns button.tog.on kbd { background:rgba(0,0,0,.12); }
#gauges { display:grid; grid-template-columns:1fr 1fr; gap:4px 10px; margin-top:6px; padding-top:6px; border-top:1px solid rgba(255,255,255,.07); font-size:10.5px; color:var(--mute,#9a978f); text-transform:uppercase; letter-spacing:.04em; }
#gauges:empty { display:none; }
#gauges .g { display:flex; flex-direction:column; gap:3px; }
#gauges .g .h { display:flex; justify-content:space-between; } #gauges .g .h b { color:var(--ink,#e9e6df); font-weight:600; letter-spacing:0; text-transform:none; }
#gauges .meter { height:5px; border-radius:3px; background:#2b2e34; overflow:hidden; } #gauges .meter i { display:block; height:100%; border-radius:3px; }
#gauges .pips { display:flex; gap:3px; } #gauges .pips i { flex:1; height:5px; border-radius:2px; background:#2b2e34; }
#legend { top:46px; right:12px; width:470px; max-height:calc(100% - 270px); min-height:200px; overflow:auto; display:none; padding:10px 12px 8px; box-sizing:border-box; z-index:25; }
#legend.open { display:block; }
#legend .lg-top { display:flex; align-items:baseline; justify-content:space-between; margin-bottom:2px; }
#legend .lg-top b { font-size:12px; letter-spacing:.08em; color:var(--accent,#e63946); }
#legend .lg-top span { color:var(--mute,#9a978f); font-size:11px; }
#legend .lg-x { background:none; border:0; color:var(--mute,#9a978f); font-size:16px; cursor:pointer; padding:0 2px; line-height:1; }
#legend .lg-x:hover { color:#fff; }
#legend .lg-sec { margin-top:9px; }
#legend .lg-sh { font-size:10.5px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--mute,#9a978f); margin-bottom:4px; display:flex; justify-content:space-between; }
#legend .lg-sh em { font-style:normal; font-weight:500; letter-spacing:0; text-transform:none; }
#legend .lg-grid { display:grid; grid-template-columns:1fr 1fr; gap:3px 12px; }
#legend .lg-it { display:flex; align-items:center; gap:8px; font-size:12px; line-height:1.2; min-height:30px; }
#legend .lg-it canvas { flex:none; width:46px; height:30px; border-radius:4px; box-shadow:0 0 0 1px rgba(255,255,255,.06); }
#legend .lg-it .t small { display:block; color:var(--mute,#9a978f); font-size:10.5px; }
#ticker .tk.low { color:#c9c6bf; }
/* [support] public support meter (full width, first row of #gauges) */
#gauges .g.sup { grid-column:1 / -1; gap:3px; margin-bottom:2px; cursor:help; }
#gauges .g.sup .h { align-items:baseline; }
#gauges .g.sup .h b { font-size:15px; font-variant-numeric:tabular-nums; }
#gauges .g.sup .h b small { font-size:11px; font-weight:500; color:var(--mute,#9a978f); margin-left:4px; }
#gauges .g.sup .ar { font-size:11px; margin-right:3px; } #gauges .ar.up { color:#7bd389; } #gauges .ar.dn { color:#ff6b6b; } #gauges .ar.fl { color:var(--mute,#9a978f); }
#gauges .meter.big { height:8px; position:relative; } #gauges .meter.big em { position:absolute; top:-1px; bottom:-1px; width:2px; background:rgba(255,255,255,.55); }
#gauges .meter.thin { height:3px; } #gauges .meter.thin i { background:#5a7fe0; }
#gauges .sup .why { text-transform:none; letter-spacing:0; font-size:11px; color:#c9c6bf; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
#gauges .sup .why .p { color:#7bd389; } #gauges .sup .why .n { color:#ff8a8f; }
#gauges .sup .mrow { display:flex; align-items:center; gap:6px; font-size:9.5px; } #gauges .sup .mrow .meter { flex:1; }
#ticker .tk.opinion-up { border-color:#7bd389; color:#d9f5df; font-weight:600; } #ticker .tk.opinion-dn { border-color:#ff8a8f; color:#ffd7d9; font-weight:600; }
`;
// [support] helpers for the public-support meter (sim.support, src/systems/support.js)
const sgn = (v, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d);
const supColor = v => v < 20 ? '#e63946' : v < 35 ? '#f4a261' : v < 55 ? '#e9c46a' : '#7bd389';
const supWord = v => v < 15 ? 'discredited' : v < 30 ? 'hostile' : v < 42 ? 'sceptical' : v < 55 ? 'divided' : v < 70 ? 'sympathetic' : 'behind you';

// Legend catalogue: [swatch key (drawn by view.legendSwatch), label, note?]. Keys are documented in render2d.js legendSwatch().
const LEGEND = [
  { h: 'People', note: 'one dot per person', items: [
    ['$followers'],
    ['dot:idle', 'Bystanders', 'not marching (yet)'],
    ['dot:wild', 'Wild riot', 'no leader; lead a march into it to win it over'],
    ['dot:panic', 'Fleeing', 'panicked by gas, charges, blasts'],
    ['dot:loot', 'Looting', 'yellow bag = carrying loot'],
    ['dot:down', 'Injured', 'down on the ground'],
    ['dot:arrested', 'Arrested', 'being carried off'],
    ['dot:home', 'Heading home', 'leaving at dusk'],
  ] },
  { h: 'Who they are', note: 'markers show when zoomed in', items: [
    ['cls:medic', 'Medic', 'heals the injured'],
    ['cls:bloc', 'Black bloc', 'smashes, throws, fights'],
    ['cls:encourager', 'Encourager', 'fires up people nearby'],
    ['cls:pacifist', 'Pacifist', 'never fights'],
    ['cls:rando', 'Everyone else', 'no marker'],
  ] },
  { h: 'Leaders', items: [
    ['leader:none', 'Your leader', 'label: name, followers, energy'],
    ['leader:peaceful', 'P = Peaceful', 'no looting or fighting'],
    ['leader:firm', 'F = Firm', 'fights back if pushed'],
    ['leader:unleashed', 'U = Unleashed', 'loots and fights'],
    ['leader:arrested', 'Arrested leader', 'blue ring, handcuffs'],
    ['goal', 'Élysée gate', 'bring 300+ followers here'],
  ] },
  { h: 'Police', items: [
    ['officers', 'Officers', 'zoomed in, one block each'],
    ['bar', 'Police line', 'zoomed out: the front row'],
    ['bar:charge', 'Charging', 'light blue line'],
    ['tag', 'Squad label', 'CRS no. · state · tactic, energy'],
    ['copdown', 'Officer down', ''],
    ['snatch', 'Snatch team', 'arrest squad; bright = running'],
    ['van', 'Vans', 'squad moving fast by road'],
  ] },
  { h: 'What just happened', note: 'icons pop up and fade', items: [
    ['icon:stars', 'Brawl', 'fist fight'],
    ['icon:$', 'Shop looted', ''],
    ['icon:cross', 'Injury', 'someone went down'],
    ['icon:cuff', 'Arrest', ''],
    ['glass', 'Broken glass', 'shop window smashed'],
    ['shop:looted', 'Looted shop', 'shops show when zoomed in'],
    ['shop:v3', 'Valuable shop', 'gold = worth more loot'],
    ['prop:burnt', 'Burnt-out car', ''],
  ] },
  { h: 'Thrown things', note: 'trails fade behind them', items: [
    ['trail:rock', 'Rock / paving stone', 'crowd'],
    ['trail:bottle', 'Bottle', 'crowd'],
    ['trail:molotov', 'Molotov', 'crowd; starts fires'],
    ['trail:firework', 'Firework', 'crowd'],
    ['trail:gas', 'Tear-gas canister', 'police'],
    ['trail:lbd', 'Rubber bullet (LBD)', 'police'],
    ['trail:flashbang', 'Flash-bang', 'police; white flash'],
  ] },
  { h: 'Fire and gas', items: [
    ['fire', 'Fire', 'cars, bins, barricades, shops'],
    ['smoke:dark', 'Smoke', 'drifts with the wind'],
    ['gas', 'Tear gas', 'people flee it'],
    ['decal:scorch', 'Scorch mark', 'where something burned'],
    ['decal:debris', 'Debris', 'after an explosion'],
  ] },
  { h: 'Police intent', note: 'press O to show', items: [
    ['intent:dest', 'Squad heading', 'dashed line to its destination'],
    ['intent:transit', 'By van', 'fast move along the roads'],
    ['intent:block', 'Block', 'line across a street'],
    ['intent:perimeter', 'Perimeter', 'guard line around the Élysée'],
    ['intent:cordon', 'Cordon', 'ring around an area'],
    ['intent:kettle', 'Kettle', 'crowd trapped inside'],
    ['intent:funnel', 'Funnel', 'crowd pushed this way'],
    ['intent:route', 'Predicted route', 'where police expect a crowd to go'],
    ['intent:other', 'Hunt / response', 'snatch hunt, rapid response, clearing'],
    ['intent:planned', 'Planned (faint, dashed)', 'solid = in progress'],
  ] },
];

// make sure the HUD/overlay elements exist (a page without the markup still works)
function ensureDom() {
  const mk = (id, cls, parent = document.body, tag = 'div') => { let el = $(id); if (!el) { el = document.createElement(tag); el.id = id; if (cls) el.className = cls; parent.appendChild(el); } return el; };
  const hud = $('hud');
  if (hud) {
    if (!$('daystats')) { const d = document.createElement('div'); d.id = 'daystats'; $('stats')?.after(d); }
    if (!$('skipdusk')) { const row = $('speed')?.parentElement; if (row) { const b = document.createElement('button'); b.id = 'skipdusk'; b.className = 'mini'; b.title = 'Debug: skip ahead'; b.textContent = 'Skip ▸ dusk'; row.appendChild(b); } }
    if (!$('gauges')) { const g = document.createElement('div'); g.id = 'gauges'; ($('daystats') || $('stats'))?.after(g); }
    if (!$('hudbtns')) {
      const r = document.createElement('div'); r.id = 'hudbtns';
      r.innerHTML = '<button id="btn-legend" class="mini tog" title="What the colours, markers and icons mean">Legend <kbd>I</kbd></button><button id="btn-intent" class="mini tog" title="Show where the police are heading and what they plan">Police intent <kbd>O</kbd></button>';
      $('gauges').after(r);
    }
    if (!$('lact')) mk('lact', '', hud);
  }
  mk('legend', 'panel');
  if (!$('ui2-style')) { const st = document.createElement('style'); st.id = 'ui2-style'; st.textContent = UI2_CSS; document.head.appendChild(st); }
  mk('ticker', 'panel');
  mk('overlay');
  mk('spawnmk');
}

// coarse grid index of road names, for "rue de Rivoli" style place names in the ticker
function buildStreetIndex(sim) {
  const G = 60, GC = Math.ceil(sim.W / G) + 1, cells = new Map(), names = [];
  const nameId = new Map();
  for (const r of sim.data.roads || []) {
    if (!r.n || r.b || /^(Piste|Accès|Bretelle|Passerelle)/.test(r.n) || /^(service|steps|cycleway|footway|path)$/.test(r.k)) continue;
    let id = nameId.get(r.n); if (id == null) { id = names.length; names.push(r.n); nameId.set(r.n, id); }
    const p = r.p;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = p[i], y0 = p[i + 1], x1 = p[i + 2], y1 = p[i + 3], n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 15));
      for (let s = 0; s <= n; s++) {
        const x = x0 + (x1 - x0) * s / n, y = y0 + (y1 - y0) * s / n, k = Math.floor(y / G) * GC + Math.floor(x / G);
        let a = cells.get(k); if (!a) cells.set(k, a = []); a.push(x, y, id);
      }
    }
  }
  const lower = n => /^(Rue|Boulevard|Avenue|Quai|Place|Passage|Impasse|Allée|Cour|Galerie|Square|Voie|Port|Cité|Villa)\b/.test(n) ? n[0].toLowerCase() + n.slice(1) : n;
  return (x, y) => {
    const cx = Math.floor(x / G), cy = Math.floor(y / G);
    let best = -1, bd = 90 * 90;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const a = cells.get((cy + dy) * GC + cx + dx); if (!a) continue;
      for (let i = 0; i < a.length; i += 3) { const ex = a[i] - x, ey = a[i + 1] - y, d2 = ex * ex + ey * ey; if (d2 < bd) { bd = d2; best = a[i + 2]; } }
    }
    return best >= 0 ? lower(names[best]) : '';
  };
}

export function createUI(sim, view) {
  ensureDom();
  const { leaders, squads, selected } = sim;
  const D = () => sim.day || { managed: false, phase: 'day', day: 1, stats: {}, light: 1 };
  const ui = { paused: false, timeScale: +($('speed')?.value || 15), won: false, fps: 0, simBudget: 11, lagAvg: 0 };
  const street = buildStreetIndex(sim);
  const place = (x, y) => {
    let best = '', bd = 160;
    for (const k in sim.LM) { const p = sim.LM[k], d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = lmName(k); } }
    return best || street(x, y) || 'the streets';
  };
  const onStreet = (x, y) => { const s = street(x, y); return s ? `on ${s}` : `near ${place(x, y)}`; };
  if (view.legendSwatch) view.placeName = (x, y) => street(x, y) || place(x, y);

  // ---------------------------------------------------------------- legend (I) + police intent overlay (O)
  const dprOf = () => Math.min(devicePixelRatio || 1, 2);
  function buildLegend() {
    const box = $('legend'); if (!box) return;
    const sw = !!view.legendSwatch;
    const items = list => list.flatMap(([k, t, n]) => k === '$followers'
      ? leaders.filter(L => !L.gone).map(L => [`follow:${L.id % 10}`, `${L.name}'s marchers`, L.arrested ? 'their leader is arrested' : 'following this leader'])
      : [[k, t, n]]);
    box.innerHTML = `<div class="lg-top"><b>LEGEND</b><span>${sw ? 'drawn exactly as on the map' : 'swatches in the 2D view'}</span><button class="lg-x" title="Close (I)">×</button></div>` +
      LEGEND.map(sec => `<div class="lg-sec"><div class="lg-sh">${esc(sec.h)}${sec.note ? `<em>${esc(sec.note)}</em>` : ''}</div><div class="lg-grid">` +
        items(sec.items).map(([k, t, n]) => `<div class="lg-it">${sw ? `<canvas data-k="${esc(k)}"></canvas>` : ''}<div class="t">${esc(t)}${n ? `<small>${esc(n)}</small>` : ''}</div></div>`).join('') +
        '</div></div>').join('');
    box.querySelector('.lg-x').onclick = () => toggleLegend(false);
    if (!sw) return;
    const d = dprOf();
    for (const c of box.querySelectorAll('canvas[data-k]')) {
      c.width = 46 * d; c.height = 30 * d;
      const g = c.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0);
      try { view.legendSwatch(g, c.dataset.k, 46, 30); } catch (e) { console.warn('legend swatch', c.dataset.k, e); }
    }
  }
  function toggleLegend(on) {
    const box = $('legend'); if (!box) return;
    on = on ?? !box.classList.contains('open');
    if (on) buildLegend();
    box.classList.toggle('open', on); $('btn-legend')?.classList.toggle('on', on);
  }
  function toggleIntent(on) {
    if (!view.legendSwatch) { toast('Police intent overlay: 2D view only'); return; }
    view.showIntent = on ?? !view.showIntent; $('btn-intent')?.classList.toggle('on', view.showIntent);
    toast(view.showIntent ? 'Police intent overlay on (O)' : 'Police intent overlay off');
  }
  $('btn-legend')?.addEventListener('click', () => toggleLegend());
  $('btn-intent')?.addEventListener('click', () => toggleIntent());

  // HUD counts, with dusk leavers (act HOME or sim.leaving[i]) kept out of 'Fleeing'
  const A_DOWN = 9, A_ARR = 10, A_HOME = 11;
  function hudCounts() {
    const c0 = sim.counts ? sim.counts() : {};
    const { act, panicT, lead } = sim, lv = sim.leaving, NA = sim.NA;
    if (!act || !panicT || !lead) return c0;
    let attached = 0, idle = 0, fleeing = 0, leaving = 0;
    for (let i = 0; i < NA; i++) {
      const a = act[i];
      if (a === A_HOME || (lv && lv[i])) leaving++;
      else if (a === A_DOWN || a === A_ARR) continue;
      else if (panicT[i] > 0) fleeing++; else if (lead[i] >= 0) attached++; else idle++;
    }
    return { attached, idle, fleeing, leaving, gone: c0.gone ?? sim.dispersedHome ?? 0 };
  }
  // tension (sim.day.intensity) and police escalation (sim.police.escalation 0..4), shown only when present
  function gaugesHtml() {
    const d = D(), P = sim.police, out = [];
    const sup = supportHtml(); if (sup) out.push(sup); // [support]
    const I = d && typeof d.intensity === 'number' && isFinite(d.intensity) ? d.intensity : null;
    if (I != null) {
      const v = clamp(I > 1.001 ? I / 100 : I, 0, 1), col = v < 0.35 ? '#7bd389' : v < 0.65 ? '#f4a261' : '#e63946';
      out.push(`<div class="g" title="How tense the streets are (rises through the day and the week)"><div class="h">Tension <b>${Math.round(v * 100)}%</b></div><div class="meter"><i style="width:${(v * 100).toFixed(0)}%;background:${col}"></i></div></div>`);
    }
    const E = P && typeof P.escalation === 'number' && isFinite(P.escalation) ? clamp(P.escalation, 0, 4) : null;
    if (E != null) {
      const word = ['calm', 'firm', 'gas', 'charges', 'all-out'][Math.floor(E + 1e-6)] || '';
      const cols = ['#5a7fe0', '#5a7fe0', '#f4a261', '#e76f51', '#e63946'];
      const pips = [1, 2, 3, 4].map(k => `<i style="${E >= k - 0.5 ? `background:${cols[k]}` : ''}${E >= k - 0.5 && E < k ? ';opacity:.5' : ''}"></i>`).join('');
      out.push(`<div class="g" title="Police escalation level 0–4: 0 calm, 1 firm, 2 tear gas, 3 charges and snatch arrests, 4 all-out"><div class="h">Police <b>${Number.isInteger(E) ? E : E.toFixed(1)}/4 ${word}</b></div><div class="pips">${pips}</div></div>`);
    }
    return out.join('');
  }
  // [support] public support 0-100 (big bar, baseline tick at 45), trend arrow, today's change and its two biggest causes,
  // and the police Mandate as a thin blue bar underneath. The tooltip lists every cause of today.
  function supportHtml() {
    const S = sim.api.supportInfo ? sim.api.supportInfo() : null;
    if (!S || !isFinite(S.value)) return '';
    const v = clamp(S.value, 0, 100), tr = S.trend || 0, dl = S.delta || 0;
    const ar = tr > 0.6 ? '<span class="ar up">▲</span>' : tr < -0.6 ? '<span class="ar dn">▼</span>' : '<span class="ar fl">▸</span>';
    const all = Object.entries(S.today || {}).filter(([, c]) => Math.abs(c.s) >= 0.05).sort((a, b) => Math.abs(b[1].s) - Math.abs(a[1].s));
    const lab = k => sim.api.supportCauses?.()[k]?.label || k;
    const why = all.slice(0, 2).map(([k, c]) => `<span class="${c.s > 0 ? 'p' : 'n'}">${esc(lab(k))} ${sgn(c.s)}</span>`).join(' · ') || '<span>no news yet today</span>';
    const tip = [`Public support ${v.toFixed(0)}/100 (${supWord(v)}), ${sgn(dl)} today, trend ${sgn(tr)}/h.`,
      'Brutality against peaceful people raises it; looting, fires and violence lower it. It sets tomorrow’s recruits.',
      ...(all.length ? ['Today:', ...all.map(([k, c]) => `  ${lab(k)}: ${sgn(c.s, 2)} (×${c.n})`)] : []),
      `Police mandate ${S.mandate.toFixed(0)}/100: political cover for force (escalation ceiling ${S.ceiling}/4).`].join('\n');
    return `<div class="g sup" title="${esc(tip)}"><div class="h">Support <b>${ar}${v.toFixed(0)}<small>${sgn(dl)} today</small></b></div>` +
      `<div class="meter big"><i style="width:${v.toFixed(1)}%;background:${supColor(v)}"></i><em style="left:45%" title="baseline"></em></div>` +
      `<div class="why">${why}</div>` +
      `<div class="mrow"><span>Mandate</span><div class="meter thin"><i style="width:${clamp(S.mandate, 0, 100).toFixed(1)}%"></i></div><b style="color:#9fb4f0">${S.mandate.toFixed(0)}</b></div></div>`;
  }

  $('speed').addEventListener('input', e => { ui.timeScale = +e.target.value; $('speedv').textContent = ui.timeScale + '×'; });
  $('skipdusk')?.addEventListener('click', () => {
    const d = D(); if (!sim.api.daySkipTo) return;
    if (d.phase === 'day') sim.api.daySkipTo(17.99); else if (d.phase === 'dusk') sim.api.daySkipTo(19.99);
  });

  function toast(t) { const el = $('toast'); el.textContent = t; el.style.display = 'block'; clearTimeout(toast.h); toast.h = setTimeout(() => el.style.display = 'none', 1800); }
  function select(id, add) { sim.select(id, add); refreshLeaderList(true); }
  const selLeader = () => { for (const id of selected) { const L = leaders[id]; if (L && !L.arrested && !L.gone) return L; } return null; };

  // ---------------------------------------------------------------- leader list
  function refreshLeaderList(force) {
    const box = $('leaders');
    if (force || box.children.length !== leaders.length) {
      box.innerHTML = '';
      for (const L of leaders) {
        const r = document.createElement('div'); r.className = 'lrow';
        r.innerHTML = `<span class="sw" style="background:${hex(L.color)}"></span><span class="nm"></span><span class="st"></span><span class="ct"></span><span class="bar"><i></i></span>`;
        r.onclick = e => select(L.id, e.shiftKey);
        r.ondblclick = () => { if (!L.gone) view.focus(L.x, L.y); };
        box.appendChild(r);
      }
    }
    leaders.forEach((L, i) => {
      const r = box.children[i], out = L.arrested || L.gone;
      r.classList.toggle('sel', selected.has(L.id));
      r.classList.toggle('arrested', !!out);
      r.querySelector('.nm').textContent = `${i + 1}. ${L.name}`;
      const st = r.querySelector('.st');
      st.textContent = out ? 'arrested' : (STANCE_LABEL[L.stance] || '');
      st.className = 'st ' + (out ? 'arr' : (L.stance || ''));
      r.querySelector('.ct').textContent = out ? '' : String(L.count);
      r.querySelector('.bar i').style.width = (out ? 0 : L.energy).toFixed(0) + '%';
    });
    // hide arrested leaders from earlier days once there are many rows
    const gone = leaders.filter(L => L.gone).length;
    leaders.forEach((L, i) => { box.children[i].style.display = L.gone && gone > 3 ? 'none' : ''; });
  }
  function refreshActions() {
    const el = $('lact'); if (!el) return;
    const L = selLeader();
    if (!L) { el.innerHTML = `<span class="mute">Select a leader (click or 1–9)</span>`; return; }
    const cd = v => v > 0 ? `<i>${Math.ceil(v)}s</i>` : '<b>ready</b>';
    el.innerHTML = `<div class="la-h"><span class="sw" style="background:${hex(L.color)}"></span>${esc(L.name)}</div>` +
      `<div class="la-row"><span class="mute">Stance</span><button class="mini" data-a="s-">◂</button><span class="stance ${L.stance}">${STANCE_LABEL[L.stance]}</span><button class="mini" data-a="s+">▸</button><kbd>Q</kbd><kbd>E</kbd></div>` +
      `<div class="la-row"><button class="act" data-a="rally" ${L.rallyCd > 0 ? 'disabled' : ''}><kbd>T</kbd> Rally ${cd(L.rallyCd)}</button>` +
      `<button class="act" data-a="scatter" ${L.scatterCd > 0 ? 'disabled' : ''}><kbd>Y</kbd> Scatter ${cd(L.scatterCd)}</button></div>`;
  }
  $('lact')?.addEventListener('click', e => {
    const a = e.target.closest('[data-a]')?.dataset.a; const L = selLeader(); if (!a || !L) return;
    if (a === 's-') stance(-1); else if (a === 's+') stance(1); else leaderAction(a);
  });
  function stance(dir) { const L = selLeader(); if (!L || !sim.api.setStance) return; sim.api.setStance(L.id, dir); refreshLeaderList(true); refreshActions(); }
  function leaderAction(kind) {
    const L = selLeader(); if (!L) { toast('Select a leader first'); return; }
    if (!sim.api.leaderAction?.(L.id, kind)) toast(`${kind === 'rally' ? 'Rally' : 'Scatter'} is cooling down (${Math.ceil(kind === 'rally' ? L.rallyCd : L.scatterCd)}s)`);
    refreshActions();
  }

  // ---------------------------------------------------------------- clock + stats
  function clockText() {
    const d = D();
    if (!d.managed) { const t = sim.simTime; return `Day ${1 + Math.floor(t / 86400)} · ${hhmm(t)}`; }
    return `Day ${d.day}/${d.days || 7} · ${hhmm(d.phase === 'briefing' ? d.start : d.t)}`;
  }
  let hudT = 0;
  function updateHud(dt, force) {
    hudT -= dt; if (hudT > 0 && !force) return; hudT = 0.25;
    const d = D();
    $('clock').innerHTML = esc(clockText()) + (d.managed ? ` <span class="phase ${d.phase}">${PHASE_LABEL[d.phase] || d.phase}</span>` : '') + (ui.paused ? '  ❚❚' : '');
    const c = hudCounts();
    const lag = ui.lagAvg > 0.08 ? ` · <span style="color:#f4a261" title="The simulation cannot keep up with this speed on this machine; it runs slower instead of skipping time">sim ${Math.round((1 - ui.lagAvg) * ui.timeScale)}×</span>` : '';
    $('stats').innerHTML = `Marching <b>${c.attached | 0}</b> · Bystanders <b>${c.idle | 0}</b><br>Fleeing <b>${c.fleeing | 0}</b> · ${c.leaving ? `<span title="Leaving at dusk (not panicking)">Leaving <b>${c.leaving}</b></span> · ` : ''}Gone home <b>${c.gone | 0}</b><br>Police squads <b>${squads.length}</b> · ${ui.fps} fps${lag}`;
    const gg = $('gauges'); if (gg) { const h = gaugesHtml(); if (gg.innerHTML !== h) gg.innerHTML = h; }
    const s = d.stats || {};
    const ds = $('daystats');
    if (ds) ds.innerHTML = `<span><b>${s.looted | 0}</b>looted</span><span><b>${s.arrests | 0}</b>arrests</span><span><b>${s.injured | 0}</b>injured</span><span><b>${s.fires | 0}</b>fires</span>`;
    const sk = $('skipdusk');
    if (sk) { sk.style.display = d.managed && (d.phase === 'day' || d.phase === 'dusk') ? '' : 'none'; sk.textContent = d.phase === 'dusk' ? 'End day ▸' : 'Skip ▸ dusk'; }
    refreshLeaderList(false);
    refreshActions();
    tickerUpdate();
    view.onHud?.();
    if (!d.managed) {
      const L = !ui.won && sim.winner();
      if (L) { ui.won = true; ui.wonAt = sim.simTime; const b = $('banner'); b.innerHTML = `${L.name}'s crowd reached the Élysée!<div style="font-size:16px;font-weight:500">${L.count} people · ${clockText()}</div>`; b.style.display = 'block'; }
    }
    if (d.managed) { // v1.5: gate hold progress
      const b = $('banner');
      if (d.phase === 'day' || d.phase === 'dusk') {
        if (d.holdT > 0) { const L = leaders[d.holdLeader]; b.innerHTML = `${esc(L ? L.name : 'The crowd')} is holding the Élysée gate<div style="font-size:16px;font-weight:500">${Math.floor(d.holdT)} / ${d.holdTarget || 60} s</div>`; b.style.display = 'block'; }
        else if (b.style.display === 'block') b.style.display = 'none';
      } else b.style.display = 'none';
    }
    if (d.phase !== shownPhase) showPhase();
  }

  // ---------------------------------------------------------------- event ticker
  const TICK_MAX = 6, tick = [], pendingEv = [], tickLooted = new Set();
  function evText(e) {
    const Ln = id => leaders[id]?.name || 'A leader';
    switch (e.type) {
      case 'loot': {
        const si = typeof e.shop === 'number' ? e.shop : -1;
        if (si >= 0) { if (tickLooted.has(si)) return null; tickLooted.add(si); }
        const sh = typeof e.shop === 'number' ? sim.shops?.[e.shop] : e.shop;
        const nm = sh?.n || (sh?.k ? sh.k.replace(/^amenity:/, '').replace(/_/g, ' ') : 'a shop');
        return { key: 'loot', cls: 'warn', text: `Shop looted — ${nm}${street(e.x, e.y) ? ', ' + street(e.x, e.y) : ''}` };
      }
      case 'arrest':
        if (e.leader != null) return { key: 'arrestL' + e.leader, cls: 'bad', text: `Leader ${Ln(e.leader)} arrested!`, solo: true };
        return { key: 'arrest', cls: '', text: `Arrests ${onStreet(e.x, e.y)}` };
      case 'riotJoined': return { key: 'joined' + e.riot, cls: 'good', text: `Riot at ${place(e.x, e.y)} joined ${Ln(e.leader)}`, solo: true };
      case 'riotSpawn': return { key: 'riot' + e.riot + e.x, cls: 'warn', text: `Riot breaks out at ${e.place || place(e.x, e.y)} (~${e.n})`, solo: true };
      case 'fire':
        if (e.kind === 'car') return { key: 'firecar', cls: 'warn', text: `Car set alight ${onStreet(e.x, e.y)}` };
        if (e.kind === 'shop') return { key: 'fireshop', cls: 'warn', text: `Shop on fire ${onStreet(e.x, e.y)}` };
        if (e.kind === 'barricade') return { key: 'firebar', cls: 'warn', text: `Barricade burning ${onStreet(e.x, e.y)}` };
        if (e.kind === 'bin') return { key: 'firebin', cls: '', text: `Bins burning ${onStreet(e.x, e.y)}` };
        return null;
      case 'explosion': return { key: 'boom', cls: 'bad', text: `${e.kind === 'car' || e.power > 6 ? 'Car explodes' : 'Explosion'} ${onStreet(e.x, e.y)}` };
      case 'charge': return { key: 'charge', cls: '', text: `Police charge ${onStreet(e.x, e.y)}` };
      case 'gas': return { key: 'gas', cls: '', text: `Tear gas ${onStreet(e.x, e.y)}` };
      case 'injury': return { key: 'injury', cls: '', text: `Protesters injured ${onStreet(e.x, e.y)}` };
      case 'barricade': return { key: 'barr', cls: 'warn', text: `Barricade going up ${onStreet(e.x, e.y)}` };
      case 'brawl': return { key: 'brawl', cls: 'warn', text: `Brawl ${onStreet(e.x, e.y)}` };
      case 'rally': return { key: 'rally' + e.leader, cls: 'good', text: `${Ln(e.leader)} rallies the crowd`, solo: true };
      case 'scatter': return { key: 'scatter' + e.leader, cls: '', text: `${Ln(e.leader)}'s crowd scatters into side streets`, solo: true };
      case 'stance': return { key: 'stance' + e.leader, cls: e.stance === 'unleashed' ? 'bad' : '', text: `${Ln(e.leader)} goes ${STANCE_LABEL[e.stance] || e.stance}`, solo: true, replace: true };
      case 'dayStart': tickLooted.clear(); return { key: 'ds', cls: 'good', text: `Day ${e.day} begins`, solo: true, nofocus: true };
      case 'dusk': return { key: 'dusk', cls: '', text: 'Dusk — the crowds start heading home', solo: true, nofocus: true };
      case 'gateHold': return e.phase === 'start' ? { key: 'hold', cls: 'good', text: `${Ln(e.leader)}'s crowd is at the Élysée gate. Hold it!`, solo: true } : { key: 'hold', cls: 'bad', text: 'The police retake the Élysée gate', solo: true };
      case 'warning': return { key: 'warn', cls: '', text: `Police warning (sommation ${e.n}/2) ${onStreet(e.x, e.y)}` };
      case 'officerDown': return { key: 'offdown', cls: 'warn', text: `Officer down ${onStreet(e.x, e.y)}` };
      case 'lineBroken': return { key: 'lineb', cls: 'good', text: `Police line broken ${onStreet(e.x, e.y)}!`, solo: true };
      case 'kettle': return e.phase === 'deploy' ? { key: 'kettle' + e.op, cls: 'bad', text: `Police are kettling ${place(e.x, e.y)}`, solo: true } : null;
      case 'funnel': return e.phase === 'deploy' ? { key: 'funnel' + e.op, cls: 'bad', text: `Police funnel the crowd at ${place(e.x, e.y)}`, solo: true } : null;
      case 'split': return e.phase === 'deploy' ? { key: 'split' + e.op, cls: 'bad', text: `Police split ${Ln(e.leader)}'s march`, solo: true } : null;
      case 'cordon': return e.phase === 'deploy' ? { key: 'cordon' + e.op, cls: 'bad', text: `Police cordon off ${place(e.x, e.y)}`, solo: true } : null;
      case 'escalation': return e.level != null ? { key: 'esc', cls: e.level >= 3 ? 'bad' : '', text: `Police escalate: level ${Math.round(e.level)}/4`, replace: true, nofocus: true } : null;
      case 'reinforcement': return { key: 'reinf', cls: '', text: 'Police reinforcements arrive', nofocus: false };
      case 'support': return supportText(e); // [support] big swings in public opinion
      case 'promoted': return { key: 'prom', cls: 'good', text: `${e.name} steps up to lead`, solo: true, nofocus: true };
    }
    return null;
  }
  // [support] 'support' {delta, cause, dir}: one cause moved public support by >= 1.5 points within a few sim-minutes
  function supportText(e) {
    const d = e.delta || 0, up = d > 0, at = e.x > 0 ? onStreet(e.x, e.y) : '';
    const T = {
      brutality: `opinion turns on the police after violence ${at}`,
      sweeps: `arrests of peaceful marchers ${at} draw sympathy`,
      leaders: up ? 'outrage at a leader’s arrest' : 'few mourn a rioting leader’s arrest',
      peaceful: 'a peaceful march wins hearts',
      stance: up ? 'calm, disciplined marches win sympathy' : 'calls for violence alienate the public',
      looting: `your marchers loot ${at}`,
      wildLoot: `rioters loot ${at}; the movement is blamed`,
      damage: `shop windows smashed ${at}`,
      fires: `fires ${at}`,
      officers: `officers injured ${at}`,
      collateral: `bystanders hurt ${at}`,
      arrests: 'arrests of rioters reassure the public',
    }[e.cause] || (up ? 'opinion swings your way' : 'opinion turns against you');
    return { key: 'sup' + e.cause + (up ? '+' : '-'), cls: up ? 'opinion-up' : 'opinion-dn', text: `Support ${sgn(d)}: ${T.trim()}` };
  }
  sim.onEvent?.(e => { if (pendingEv.length < 400) pendingEv.push(e); });
  // Merging: repeated events of one kind within MERGE_MS collapse into one row ("Tear gas on rue Royale ×7", latest place).
  // Routine street events (LOW) update in place instead of jumping to the top, and are evicted first, so leader news,
  // riots and police operations stay readable. The list does not re-render while the mouse is over it.
  const MERGE_MS = 15000, LOW = new Set(['arrest', 'charge', 'gas', 'injury', 'brawl', 'warn', 'firebin', 'offdown', 'loot', 'reinf', 'barr']);
  let tickUid = 0, tickHover = false;
  function tickerUpdate() {
    const now = performance.now();
    for (const e of pendingEv) {
      const m = evText(e); if (!m) continue;
      m.low = LOW.has(m.key);
      const last = tick.find(t => t.key === m.key);
      if (last && (m.replace || (!m.solo && now - last.at < MERGE_MS))) {
        last.text = m.text; last.cls = m.cls; if (m.replace) last.n = 1; else last.n++;
        last.at = now; last.t = e.t; last.x = e.x; last.y = e.y;
        if (!m.low) { tick.splice(tick.indexOf(last), 1); tick.unshift(last); }
      } else tick.unshift({ ...m, n: 1, at: now, t: e.t, x: e.x, y: e.y, uid: ++tickUid });
    }
    pendingEv.length = 0;
    while (tick.length > TICK_MAX) { let k = -1; for (let i = tick.length - 1; i >= 0; i--) if (tick[i].low) { k = i; break; } tick.splice(k >= 0 ? k : tick.length - 1, 1); }
    const box = $('ticker'); if (!box || tickHover) return;
    box.style.display = tick.length ? 'block' : 'none';
    box.innerHTML = tick.map(t => {
      const age = (now - t.at) / 1000, op = clamp(1 - age / (t.low ? 15 : 30), t.low ? 0.25 : 0.4, 1);
      return `<div class="tk ${t.cls}${t.low ? ' low' : ''}" data-u="${t.uid}" style="opacity:${op.toFixed(2)}" title="${t.nofocus ? '' : 'Click to pan there'}"><span class="tt">${hhmm(t.t % 86400)}</span>${esc(t.text)}${t.n > 1 ? ` <span class="tn">×${t.n}</span>` : ''}</div>`;
    }).join('');
  }
  $('ticker')?.addEventListener('mouseenter', () => { tickHover = true; });
  $('ticker')?.addEventListener('mouseleave', () => { tickHover = false; });
  // a click pans (never zooms in) to the row's latest location
  $('ticker')?.addEventListener('click', e => { const u = +e.target.closest('.tk')?.dataset.u; const t = tick.find(q => q.uid === u); if (t && !t.nofocus && t.x > 0) view.focus(t.x, t.y); });

  // ---------------------------------------------------------------- overlays (briefing / summary / end)
  let shownPhase = null, briefLeader = null, briefFramed = false;
  const ov = () => $('overlay');
  function showPhase() {
    const d = D(); shownPhase = d.phase;
    const o = ov(); if (!o) return;
    o.className = ''; o.innerHTML = '';
    $('spawnmk').innerHTML = '';
    if (!d.managed) return;
    if (d.phase === 'briefing') { tick.length = 0; renderBriefing(); }
    else if (d.phase === 'summary') renderSummary();
    else if (d.phase === 'ended') renderEnd();
  }
  const spawnName = k => lmName(k);
  function renderBriefing() {
    const d = D(), o = ov(), act = leaders.filter(L => !L.arrested && !L.gone);
    if (!briefLeader || !act.includes(briefLeader)) briefLeader = act[0] || null;
    const keys = Object.keys(sim.spawnPoints), c = d.carry || {};
    const carry = d.day > 1 ? `<div class="sec"><div class="sh">Since yesterday</div>
      <div class="kv"><span>Peak crowd on day ${c.fromDay}</span><b>${c.peak | 0}</b></div>
      <div class="kv"><span>Return today (55%)</span><b>${c.retained | 0}</b></div>
      <div class="kv"><span>New recruits${c.riotJoined ? ` (incl. ${c.riotJoined} riot joiners)` : ''}</span><b>+${c.recruits | 0}</b></div>
      ${c.arrested?.length ? `<div class="kv bad"><span>Leaders lost</span><b>${esc(c.arrested.join(', '))}</b></div>` : ''}
      ${c.promoted ? `<div class="kv good"><span>Promoted</span><b>${esc(c.promoted)}</b></div>` : ''}
      ${sim.support ? `<div class="kv"><span>Public support</span><b style="color:${supColor(sim.support.value)}">${sim.support.value.toFixed(0)} · ${supWord(sim.support.value)}</b></div>` : ''}</div>` : ''; // [support]
    const rows = act.map(L => `<div class="lpick ${L === briefLeader ? 'cur' : ''}" data-l="${L.id}">
        <div class="lp-n"><span class="sw" style="background:${hex(L.color)}"></span>${esc(L.name)}</div>
        <div class="chips">${keys.map(k => `<button class="chip ${d.choice[L.id] === k ? 'on' : ''}" data-l="${L.id}" data-k="${k}">${esc(spawnName(k))}</button>`).join('')}</div></div>`).join('');
    const riots = (d.riotPlan || []).map(r => `<div class="kv"><span>${hhmm(r.at)} · ${esc(r.place || place(r.x, r.y))}</span><b>~${r.n}</b></div>`).join('');
    o.className = 'brief';
    o.innerHTML = `<div class="card side">
      <div class="dayno">DAY ${d.day} <span>/ ${d.days || 7}</span></div>
      <div class="flav">${esc(d.flavour?.[d.day - 1] || '')}</div>
      ${carry}
      <div class="sec"><div class="sh">Marchers today <b class="big">${c.crowd | 0}</b></div>
        <div class="hint">Pick each leader's starting point (click a chip, or select a leader and click a marker on the map).</div>${rows}</div>
      <div class="sec"><div class="sh">Expected today</div>
        <div class="kv"><span>Police squads</span><b>${d.squadsToday}${d.day > 1 ? ' (+1)' : ''}</b></div>
        <div class="kv"><span>Uncontrolled riots</span><b>${(d.riotPlan || []).length}</b></div>${riots}</div>
      ${d.day === 1 ? `<div class="hint" style="margin:8px 0;font-size:11px;opacity:.8">Fiction. Toute ressemblance avec des lieux, personnes ou événements réels serait purement fortuite. Devoir recourir à des dégradations pour gagner n'est pas un encouragement à en commettre. Le jeu condamne toutes les violences, des manifestants comme des forces de l'ordre, et ne cherche pas à les banaliser. Any resemblance to real places, people or events is purely coincidental. Having to resort to property damage to win is not an encouragement to damage property. The game condemns all violence, by protesters and police alike, and does not seek to trivialize it.</div>` : ''}
      <button class="go" id="ov-go">Start day ${d.day} ▸ <kbd>Enter</kbd></button></div>`;
    o.querySelectorAll('.chip').forEach(b => b.onclick = ev => { ev.stopPropagation(); briefLeader = leaders[+b.dataset.l]; sim.api.chooseSpawn(+b.dataset.l, b.dataset.k); renderBriefing(); });
    o.querySelectorAll('.lpick').forEach(b => b.onclick = () => { briefLeader = leaders[+b.dataset.l]; select(briefLeader.id, false); renderBriefing(); });
    $('ov-go').onclick = startDay;
    buildSpawnMarkers();
    if (!briefFramed) { briefFramed = true; frameBriefing(); }
  }
  // 2D: fit the spawn points, today's riots and the Élysée between the HUD (left) and the briefing card (right)
  function frameBriefing() {
    if (!view.cam || !view.focus) return;
    const d = D(), pts = [...Object.values(sim.spawnPoints), sim.goal, ...(d.riotPlan || []).map(r => [r.x, r.y])];
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    const vw = innerWidth, vh = innerHeight, L = vw > 1000 ? 290 : 0, R = vw > 1000 ? 480 : 0, visW = Math.max(200, vw - L - R);
    const s = Math.min(visW / (x1 - x0 + 300), (vh - 60) / (y1 - y0 + 300));
    view.focus((x0 + x1) / 2 - (L + visW / 2 - vw / 2) / s, (y0 + y1) / 2, s, true);
  }
  function buildSpawnMarkers() {
    const box = $('spawnmk'); box.innerHTML = '';
    if (!view.toScreen) return;
    const d = D();
    for (const k of Object.keys(sim.spawnPoints)) {
      const p = sim.spawnPoints[k], who = leaders.filter(L => !L.arrested && !L.gone && d.choice[L.id] === k);
      const m = document.createElement('div'); m.className = 'smk' + (who.length ? ' on' : ''); m.dataset.k = k; m.dataset.x = p[0]; m.dataset.y = p[1];
      m.innerHTML = `<i></i><span>${esc(spawnName(k))}${who.map(L => `<em style="background:${hex(L.color)}"></em>`).join('')}</span>`;
      m.onclick = () => { if (briefLeader) { sim.api.chooseSpawn(briefLeader.id, k); renderBriefing(); } };
      box.appendChild(m);
    }
    for (const r of d.riotPlan || []) {
      const m = document.createElement('div'); m.className = 'rmk'; m.dataset.x = r.x; m.dataset.y = r.y;
      m.innerHTML = `<i>!</i><span>${hhmm(r.at)}</span>`; box.appendChild(m);
    }
    placeMarkers();
  }
  function placeMarkers() {
    if (!view.toScreen) return;
    for (const m of $('spawnmk').children) { const [X, Y] = view.toScreen(+m.dataset.x, +m.dataset.y); m.style.transform = `translate(${X.toFixed(0)}px,${Y.toFixed(0)}px)`; }
  }
  function startDay() {
    if (!sim.api.dayStart?.()) return;
    briefFramed = false;
    showPhase(); refreshLeaderList(true); updateHud(0, true);
  }
  function statGrid(s) {
    const cell = (l, v) => `<div class="sg"><b>${v | 0}</b><span>${l}</span></div>`;
    return `<div class="sgrid">${cell('peak followers', s.peak)}${cell('shops looted', s.looted)}${cell('arrests', s.arrests)}${cell('injured', s.injured)}
      ${cell('fires', s.fires)}${cell('projectiles', s.projectiles)}${cell('brawls', s.brawls)}${cell('riot joiners', s.riotJoined)}</div>`;
  }
  function renderSummary() {
    const d = D(), o = ov(), s = d.stats, c = d.carry || {};
    const why = d.endReason === 'leaderless' ? '<div class="flav bad">Every leader was arrested — the crowd melted away early.</div>' : '<div class="flav">20:00 — the streets empty out.</div>';
    o.className = 'full';
    o.innerHTML = `<div class="card mid">
      <div class="dayno">END OF DAY ${d.day} <span>/ ${d.days || 7}</span></div>${why}
      ${statGrid(s)}
      <div class="sec"><div class="sh">Leaders arrested</div><div class="${s.leadersArrested.length ? 'bad' : 'mute'}">${s.leadersArrested.length ? esc(s.leadersArrested.join(', ')) : 'none'}</div></div>
      ${summarySupport(d.day)}
      <div class="sec"><div class="sh">Tomorrow</div>
        <div class="kv"><span>Returning (55% of peak)</span><b>${c.retained | 0}</b></div>
        <div class="kv"><span>Recruits</span><b>+${c.recruits | 0}</b></div>
        <div class="kv"><span>Marchers</span><b class="big">${c.crowd | 0}</b></div>
        <div class="kv"><span>Police squads</span><b>${c.squads}</b></div></div>
      <button class="go" id="ov-go">Continue to day ${d.day + 1} ▸ <kbd>Enter</kbd></button></div>`;
    $('ov-go').onclick = nextDay;
  }
  // [support] night summary: support at dawn -> dusk, the change by cause, the overnight drift and the police mandate
  function summarySupport(day) {
    const S = sim.support, h = S?.history?.findLast?.(x => x.day === day) ?? S?.history?.[S.history.length - 1];
    if (!S || !h) return '';
    const lab = k => sim.api.supportCauses?.()[k]?.label || k, dd = h.end - h.start;
    const rows = (h.causes || []).filter(c => Math.abs(c.s) >= 0.1).slice(0, 7)
      .map(c => `<div class="kv ${c.s > 0 ? 'good' : 'bad'}"><span>${esc(lab(c.cause))} <span class="mute">×${c.n}</span></span><b>${sgn(c.s)}</b></div>`).join('');
    return `<div class="sec"><div class="sh">Public support <b class="big" style="color:${supColor(h.end)}">${h.end.toFixed(0)}<span class="mute" style="font-size:12px;font-weight:500"> / 100 · ${supWord(h.end)}</span></b></div>
      <div class="support"><i style="width:${clamp(h.end, 0, 100).toFixed(1)}%;background:${supColor(h.end)}"></i><em style="left:${clamp(h.start, 0, 100).toFixed(1)}%" title="this morning"></em></div>
      <div class="kv ${dd >= 0 ? 'good' : 'bad'}"><span>Today (from ${h.start.toFixed(0)} this morning)</span><b>${sgn(dd)}</b></div>
      ${rows || '<div class="mute">A quiet day: nothing moved public opinion.</div>'}
      <div class="kv"><span>Overnight, opinion settles</span><b>${sgn(h.drift)} → ${h.after.toFixed(0)}</b></div>
      <div class="kv"><span>Police mandate (political cover for force)</span><b style="color:#9fb4f0">${h.mStart.toFixed(0)} → ${h.mEnd.toFixed(0)}</b></div></div>`;
  }
  function nextDay() { if (!sim.api.dayContinue?.()) { showPhase(); return; } showPhase(); refreshLeaderList(true); updateHud(0, true); }
  function renderEnd() {
    const d = D(), o = ov(), r = d.result || {}, H = d.history || [];
    const tot = {}; for (const h of H) for (const k of ['peak', 'looted', 'arrests', 'injured', 'fires', 'projectiles', 'brawls', 'riotJoined']) tot[k] = k === 'peak' ? Math.max(tot[k] || 0, h[k] || 0) : (tot[k] || 0) + (h[k] || 0);
    const title = r.win ? 'VICTORY' : 'DEFEAT';
    const sub = r.win ? `${esc(r.leader)}'s crowd of ${r.count} reached the Élysée gate on day ${r.day} at ${hhmm(r.at)}.` : esc(r.text || '');
    const lost = H.flatMap(h => h.leadersArrested || []);
    o.className = 'full end ' + (r.win ? 'win' : 'lose');
    o.innerHTML = `<div class="card mid">
      <div class="endt">${title}</div><div class="flav">${sub}</div>
      <div class="sh">Campaign · ${H.length} day${H.length === 1 ? '' : 's'}</div>
      ${statGrid(tot)}
      <div class="sec"><div class="sh">Leaders arrested</div><div class="${lost.length ? 'bad' : 'mute'}">${lost.length ? esc(lost.join(', ')) : 'none'}</div></div>
      ${sim.support ? `<div class="sec"><div class="sh">Public support</div><div class="kv"><span>${(sim.support.history || []).map(h => h.end.toFixed(0)).join(' → ') || 'at the end'}</span><b style="color:${supColor(sim.support.value)}">${sim.support.value.toFixed(0)} · ${supWord(sim.support.value)}</b></div></div>` : ''}
      <button class="go" id="ov-go">New campaign ▸</button></div>`;
    $('ov-go').onclick = () => location.reload();
  }

  // world click from the view: button 0 = select, 2 = order
  function click(x, y, button, shift) {
    const d = D();
    if (d.managed && d.phase === 'briefing') {
      let bk = null, bd = Math.max(120, view.pickRadius() * 3);
      for (const k in sim.spawnPoints) { const p = sim.spawnPoints[k], dd = Math.hypot(p[0] - x, p[1] - y); if (dd < bd) { bd = dd; bk = k; } }
      if (bk && briefLeader) { sim.api.chooseSpawn(briefLeader.id, bk); renderBriefing(); }
      return;
    }
    if (d.managed && d.phase !== 'day' && d.phase !== 'dusk') return;
    if (button === 0) {
      const pickR = view.pickRadius();
      let best = null, bd = pickR;
      for (const L of leaders) { if (L.arrested || L.gone) continue; const dd = Math.hypot(L.x - x, L.y - y); if (dd < bd) { bd = dd; best = L; } }
      select(best ? best.id : null, shift);
    } else if (button === 2) {
      if (!selected.size) { toast('Select a leader first (left-click or 1–9)'); return; }
      sim.orderLeaders(x, y);
    }
  }

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase(), cur = view.cursor, d = D();
    if (k === 'enter' && d.managed) {
      if (d.phase === 'briefing') { startDay(); e.preventDefault(); return; }
      if (d.phase === 'summary') { nextDay(); e.preventDefault(); return; }
    }
    if (view.onKey && view.onKey(e, k)) return;
    if (k >= '1' && k <= '9') { select(+k - 1, e.shiftKey); return; }
    if (k === ' ') { ui.paused = !ui.paused; e.preventDefault(); updateHud(0, true); }
    else if (k === 'q') stance(-1);
    else if (k === 'e') stance(1);
    else if (k === 't') leaderAction('rally');
    else if (k === 'y') leaderAction('scatter');
    else if (k === 'c' && cur.ok) { if (sim.api.combatDemo) sim.api.combatDemo(cur.x, cur.y); else toast('combatDemo not available'); }
    else if (k === 'b' && cur.ok) { if (sim.api.spawnRiot) { sim.api.spawnRiot(cur.x, cur.y, 150, {}); toast('Riot spawned (debug)'); } else toast('spawnRiot not available'); }
    else if (k === 'l' && cur.ok) { const L = sim.addLeader(cur.x, cur.y); if (L) { select(L.id, false); toast(`${L.name} starts agitating`); } }
    else if (k === 'r') {
      const L = selLeader();
      if (L) { sim.spawnAround(L.x, L.y, 100, L.id); toast(`+100 join ${L.name}`); } else if (cur.ok) { sim.spawnAround(cur.x, cur.y, 100, -1); toast('+100 bystanders'); }
    }
    else if (k === 'p' && cur.ok) {
      let fx = 1, fy = 0, bd = 1e9;
      for (const L of leaders) { if (L.gone) continue; const dd = Math.hypot(L.x - cur.x, L.y - cur.y); if (dd < bd) { bd = dd; fx = L.x - cur.x; fy = L.y - cur.y; } }
      sim.addSquad(cur.x, cur.y, fx, fy);
    }
    else if (k === 'x' && cur.ok && squads.length) {
      let best = null, bd = 1e9;
      for (const sq of squads) { const dd = Math.hypot(sq.x - cur.x, sq.y - cur.y); if (dd < bd) { bd = dd; best = sq; } }
      sim.removeSquad(best);
    }
    else if (k === 'g' && cur.ok) sim.throwGas(cur.x, cur.y);
    else if (k === 'n') view.toggleNav();
    else if (k === 'h') $('help').style.display = $('help').style.display === 'none' ? '' : 'none';
    else if (k === 'i') toggleLegend();
    else if (k === 'o') toggleIntent();
    // F glides to the selected leader; it zooms in only when zoomed far out (it used to snap to zoom 2.5 instantly,
    // which is easy to trigger by accident next to the D pan key: the 'camera jump').
    else if (k === 'f') { const L = selLeader(); if (L) view.focus(L.x, L.y, view.cam && view.cam.s < 0.9 ? 1.6 : undefined); }
  });

  let last = performance.now(), fpsAcc = 0, fpsN = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const rdt = clamp((now - last) / 1000, 0, 0.05); last = now;
    fpsAcc += rdt; fpsN++; if (fpsAcc > 0.5) { ui.fps = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
    const d = D(), running = !d.managed || d.phase === 'day' || d.phase === 'dusk';
    // v1.5: sim time budget per frame (ms): at high speed on a slow machine the sim slows down gracefully
    // instead of freezing the frame (16 substeps max per call as before)
    if (!ui.paused && running) { sim.advance(rdt * ui.timeScale, ui.simBudget); ui.lagAvg = ui.lagAvg * 0.95 + (sim.lag || 0) * 0.05; }
    if (view.fx && typeof view.fx.night === 'number' && !view.fx.nightOwned) view.fx.night = clamp(1 - (d.light ?? 1), 0, 1);
    view.frame(rdt);
    if (d.phase === 'briefing') placeMarkers();
    updateHud(rdt);
  }
  ui.start = () => { refreshLeaderList(true); last = performance.now(); updateHud(0, true); requestAnimationFrame(loop); };
  Object.assign(ui, { toast, select, click, refreshLeaderList, updateHud, startDay, nextDay, showPhase, tick, toggleLegend, toggleIntent });
  return ui;
}

// window.__sim debug hook shared by both views
export function installDebugHook(sim, ui, view, extra = {}) {
  window.__sim = {
    sim, view, ui, LM: sim.LM, goal: sim.goal,
    winner: () => { const L = sim.winner(); return L ? { n: L.name, c: L.count, t: sim.simTime } : null; }, leaders: sim.leaders, squads: sim.squads,
    select: (id, add) => ui.select(id, add),
    orderLeaders: (x, y) => sim.orderLeaders(x, y),
    throwGas: (x, y) => sim.throwGas(x, y),
    addSquad: (x, y, fx, fy) => sim.addSquad(x, y, fx, fy),
    addLeader: (x, y) => sim.addLeader(x, y),
    focus: (x, y, z) => view.focus(x, y, z),
    stats: () => sim.stats(),
    step: (n, dt = 0.12) => { const t0 = performance.now(); for (let s = 0; s < n; s++) sim.step(dt); sim.updatePaths(1); return performance.now() - t0; },
    // day loop helpers
    day: () => sim.day,
    startDay: () => ui.startDay(),
    nextDay: () => ui.nextDay(),
    skipTo: h => sim.api.daySkipTo?.(h),
    ...extra,
  };
}

// boot helper: load data, build the sim, hand it to the view factory
export async function bootPage(loadMapData, createSim, makeView) {
  try {
    const { data, src } = await loadMapData();
    await new Promise(r => setTimeout(r, 20)); // let the loading text paint
    const t0 = performance.now();
    const sim = createSim(data);
    const view = makeView(sim);
    const ui = createUI(sim, view);
    view.attach?.(ui);
    const sc = sim.initScenario();
    view.initCamera(sc.start);
    installDebugHook(sim, ui, view);
    ui.start();
    console.log(`boot ${(performance.now() - t0).toFixed(0)} ms (nav ${sim.buildMs.toFixed(0)} ms), map ${src}, grid ${sim.COLS}x${sim.ROWS}, walk cells ${sim.walkCells}, buildings ${data.buildings.length}, agents ${sim.NA}`);
    $('loading').style.display = 'none';
  } catch (e) {
    $('loading').textContent = 'Error: ' + e.message; console.error(e);
  }
}
