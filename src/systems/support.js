// Support system: public opinion (Support 0..100) and the police's political cover (Mandate 0..100).
// Design: docs/gauges.md §2.6 / §2.7 / §8.2; mechanics and numbers: docs/notes/public-support.md.
// Pure listener: it reads events (sim.onEvent) and leader / agent state, never writes anything other systems own.
//
//   sim.support = { value, mandate, trend (points per sim-hour, smoothed), climate, media, today: {cause: {s, m, n}},
//                   start (value at dayStart), cleanIncidents, history: [per day], samples: [{t, v, m}] }
//   sim.api.supportInfo()              -> sim.support plus top causes (read only)
//   sim.api.supportRecruitMod()        -> recruit multiplier for tomorrow, (S/50)^1.5 x outrage bonus, 0.25..2.5
//   sim.api.supportMandateMod()        -> police political cover, 0.5 (none) .. 1.5 (free rein); 1 at Mandate 50
//   sim.api.supportEscalationCeiling() -> floor(Mandate / 22), 0..4
//   sim.api.supportMoraleBase()        -> morning morale baseline 0.5 + 0.2 (S - 50) / 50
//   Event emitted: 'support' {delta, cause, causeLabel, dir, mandate} for big swings (the ticker reads it).
//
// News fatigue: every cause has a saturation cap per news cycle. A raw delta r on cause c with accumulated raw A gives
// cap x (e^(-A/cap) - e^(-(A+|r|)/cap)): the first looted shop is news, the 500th is not. A decays with TAU_NEWS
// and resets each morning. The sim produces far more events than gauges.md assumed (sandbox: ~3000 loot grabs and
// ~100 brutality incidents per hour), so this replaces the per-day 0.6^n brutality fade.
import { clamp, ACT } from '../common.js';

const S0 = 45, M0 = 50;                    // start values (gauges.md §2.2)
const MEDIA = 0.6, MEDIA_LATE = 0.8;        // media presence M: fixed in v1, +0.2 from day 5 (no streamers yet)
const B = 1.5;                              // brutality gain
const OFF_WIN = 20;                         // s: a visible offence (LOOT/FIGHT/THROW) makes an agent an offender (police: OFFENCE_WINDOW)
const TAU_NEWS = 3 * 3600;                  // s: the news cycle forgets a cause's saturation
const ACC_MAX = 6;                          // saturation memory is capped at 6 x cap (marginal effect e^-6 = 0.25% of raw)
const SEV_MAX = 6;                          // one incident counts at most severity 6 (a whole charge on a clean crowd)
const DRIFT_NIGHT = 0.25, MDRIFT_NIGHT = 0.2; // overnight: Support 25% toward 45 + 20C, Mandate 20% toward 50
const SANDBOX_DRIFT_T = 4 * 3600;           // sandbox (no nights): 25% of the way to the baseline per 4 sim-hours
const SWING = 1.5, SWING_WIN = 240;         // ticker: a cause that moves Support >= 1.5 points within 4 sim-minutes
const CLS_W_ARREST = [0.08, 0.25, 0.1, 0.35, 0];  // sympathy per arrest of a non-offender by class (rando, pacifist, enc, medic, bloc)

// cause -> label, Support cap (signed direction), Mandate cap (per news cycle, before media M)
const CAUSES = {
  brutality:  { label: 'police brutality',      s: +12, m: -12 },
  looting:    { label: 'looting by marchers',   s: -12, m: +10 },
  wildLoot:   { label: 'looting by rioters',    s: -6,  m: +10 },  // uncontrolled riots and bystanders: 50% (gauges.md §7)
  damage:     { label: 'smashed shops',         s: -4,  m: +4 },
  fires:      { label: 'fires and explosions',  s: -6,  m: +6 },
  officers:   { label: 'officers injured',      s: -6,  m: +10 },
  collateral: { label: 'bystanders hurt',       s: -4,  m: +2 },
  arrests:    { label: 'rioters arrested',      s: -3,  m: +5 },
  sweeps:     { label: 'mass arrests',          s: +4,  m: -3 },
  leaders:    { label: 'leaders arrested',      s: +8,  m: -6 },  // signed per event (an unleashed leader's arrest costs)
  peaceful:   { label: 'peaceful marches',      s: +5,  m: -3 },
  stance:     { label: 'leaders’ stance',   s: +4,  m: +3 },  // signed per event
};
// framing: police force next to a march is judged by that march's stance (the nearest active leader within FRAME_R m)
const FRAME = { peaceful: 1.2, firm: 1.0, unleashed: 0.5 }, FRAME_R = 60;
const CROWD_KINDS = new Set(['rock', 'bottle', 'paving', 'firework', 'molotov', 'blast', 'fire']);
const FIRE_RAW = { car: 0.6, shop: 1.0, barricade: 0.25, bin: 0.15, molotov: 0.1 };

export default function create(sim) {
  const { act, lead, cls, tgt } = sim;
  const A_LOOT = ACT.LOOT, A_FIGHT = ACT.FIGHT, A_THROW = ACT.THROW;
  const lastOff = sim.registerAgentArray(new Float32Array(sim.MAXA), -1e9);
  const search = typeof location !== 'undefined' ? location.search : '';
  const sandbox = /[?&]sandbox\b/.test(search);
  let S, acc = {}, swing = {}, scanT = 0, minT = 0, sampT = 0, prevV = S0, leaderOffT = [];

  const T = () => sim.simTime;
  const managed = () => !!(sim.day && sim.day.managed) && !sandbox;
  const live = () => { const p = sim.day && sim.day.phase; return !sim.day || !managed() || p === 'day' || p === 'dusk'; };
  const media = () => ((sim.day && sim.day.day) || 1) >= 5 && managed() ? MEDIA_LATE : MEDIA;
  const offender = j => { const a = act[j]; return a === A_LOOT || a === A_FIGHT || a === A_THROW || T() - lastOff[j] < OFF_WIN; };

  function fresh() {
    return { value: S0, mandate: M0, trend: 0, climate: 0, media: MEDIA, today: {}, start: S0, mStart: M0, cleanIncidents: 0,
      incidents: 0, history: [], samples: [], last: null, sandbox };
  }
  function resetToday() {
    S.today = {}; S.start = S.value; S.mStart = S.mandate; S.cleanIncidents = 0; S.incidents = 0; acc = {}; swing = {};
  }
  function today(c) { return S.today[c] || (S.today[c] = { s: 0, m: 0, n: 0 }); }

  // saturating application: raw magnitude r (>= 0) on cause c; sgnS / sgnM override the cause's sign (stance, leaders)
  function apply(c, rawS, rawM, x, y, sgnS, sgnM) {
    const C = CAUSES[c]; if (!C || !live()) return 0;
    const M = media(), a = acc[c] || (acc[c] = { s: 0, m: 0, t: T() });
    decayAcc(a);
    const capS = Math.abs(C.s), capM = Math.abs(C.m);
    const dS = rawS > 0 ? (sgnS ?? Math.sign(C.s)) * M * capS * (Math.exp(-a.s / capS) - Math.exp(-(a.s + rawS) / capS)) : 0;
    const dM = rawM > 0 ? (sgnM ?? Math.sign(C.m)) * M * capM * (Math.exp(-a.m / capM) - Math.exp(-(a.m + rawM) / capM)) : 0;
    a.s = Math.min(ACC_MAX * capS, a.s + rawS); a.m = Math.min(ACC_MAX * capM, a.m + rawM); // a flooded cause recovers within a few hours
    S.value = clamp(S.value + dS, 0, 100); S.mandate = clamp(S.mandate + dM, 0, 100);
    const td = today(c); td.s += dS; td.m += dM; td.n++;
    if (dS) noteSwing(c, dS, dM, x, y);
    return dS;
  }
  function decayAcc(a) {
    const dt = T() - a.t; a.t = T();
    if (dt > 0) { const k = Math.exp(-dt / TAU_NEWS); a.s *= k; a.m *= k; }
  }
  // ticker: emit a 'support' event when one cause moves Support >= SWING points within SWING_WIN s
  function noteSwing(c, dS, dM, x, y) {
    let w = swing[c];
    if (!w || T() - w.t0 > SWING_WIN || Math.sign(w.s) !== Math.sign(dS)) w = swing[c] = { t0: T(), s: 0, m: 0, x, y };
    w.s += dS; w.m += dM; if (x != null) { w.x = x; w.y = y; }
    if (Math.abs(w.s) >= SWING) {
      S.last = { t: T(), cause: c, delta: +w.s.toFixed(2) };
      sim.emit('support', w.x ?? sim.goal.x, w.y ?? sim.goal.y, { delta: +w.s.toFixed(2), mandate: +w.m.toFixed(2), cause: c,
        causeLabel: CAUSES[c].label, dir: w.s > 0 ? 'up' : 'down', value: +S.value.toFixed(1) });
      delete swing[c];
    }
  }

  // the looter: the LOOT agent at the event position (riots.js emits at the looter's position)
  function looterAt(x, y, shop) {
    let b = -1, bd = 4;
    sim.forEachNear(x, y, 2, (j, dx, dy, d2) => { if (act[j] === A_LOOT && (shop == null || tgt[j] === shop) && d2 < bd) { bd = d2; b = j; } });
    return b;
  }

  function frame(x, y) {
    let b = null, bd = FRAME_R;
    for (const L of sim.leaders || []) { if (L.arrested || L.gone || (L.count || 0) < 30) continue; const d = Math.hypot(L.x - x, L.y - y); if (d < bd) { bd = d; b = L; } }
    return b ? FRAME[b.stance] ?? 1 : 1;
  }
  function onEvent(e) {
    switch (e.type) {
      case 'dayStart': resetToday(); prevV = S.value; return;
      case 'dayEnd': return dayEnd(e);
      case 'support': return;
    }
    if (!live()) return;
    switch (e.type) {
      case 'brutality': {
        const sev = Math.min(SEV_MAX, e.severity || 1), d = clamp(e.d || 0, 0, 1);
        S.incidents++; if (d < 0.3 && sev >= 2) S.cleanIncidents++;
        const clim = 0.7 + 0.3 * S.climate;
        const f = frame(e.x, e.y);
        apply('brutality', B * sev * (1 - d) * (1 - d) * clim * f, 1.5 * sev * (1 - d) * Math.min(1, f), e.x, e.y);
        return;
      }
      case 'loot': {
        const j = looterAt(e.x, e.y, e.shop);
        const wild = j < 0 || lead[j] < 0;   // not one of your marchers (wild riot, bystander): "casseurs, not protesters", 50% Support cost
        const clim = 1 - 0.6 * Math.max(0, S.climate);
        apply(wild ? 'wildLoot' : 'looting', 0.2 * (wild ? 0.5 : 1) * clim, 0.16, e.x, e.y); // gauges.md: -1.0 x v per shop over 5v grabs; Mandate +0.8 v
        return;
      }
      case 'shatter': if (e.shop != null) apply('damage', 0.3, 0.2, e.x, e.y); return; // a shop broken into (bottles smashing don't count)
      case 'barricade': apply('damage', 0.1, 0.1, e.x, e.y); return;                 // street furniture torn up
      case 'fire': { const r = FIRE_RAW[e.kind] ?? 0.2; apply('fires', r, r, e.x, e.y); return; }
      case 'explosion': if ((e.power || 0) >= 1) apply('fires', 1.0, 1.0, e.x, e.y); return; // a car blowing up
      case 'officerDown': apply('officers', 2, 3, e.x, e.y); return;
      case 'injury': {
        const i = e.i; if (i == null || i < 0 || i >= sim.NA) return;
        if (CROWD_KINDS.has(e.kind) && !offender(i) && cls[i] !== 4) apply('collateral', 0.4, 0.2, e.x, e.y);
        // police injuries of non-offenders reach us as 'brutality' incidents (police.js); offenders hurt by police: no story
        return;
      }
      case 'arrest': {
        if (e.leader != null) {
          const L = sim.leaders[e.leader]; if (!L) return;
          // peaceful leaders also produce a severity-5 'brutality' incident (police.js); here: the organiser story itself
          if (L.stance === 'unleashed') apply('leaders', 0.8, 2, e.x, e.y, -1, +1);
          else apply('leaders', L.stance === 'peaceful' ? 0.6 : 1.2, 1, e.x, e.y, +1, -1);
          return;
        }
        const i = e.agent; if (i == null || i < 0 || i >= sim.NA) return;
        if (offender(i)) apply('arrests', 0.2, 0.5, e.x, e.y);                    // discriminate arrest of an offender
        else apply('sweeps', (CLS_W_ARREST[cls[i]] ?? 0.08) * frame(e.x, e.y), 0.1, e.x, e.y);         // arrests of people doing nothing
        return;
      }
    }
  }

  function dayEnd(e) {
    const end = S.value, mEnd = S.mandate, target = S0 + 20 * S.climate;
    const drift = (target - end) * DRIFT_NIGHT, mDrift = (M0 - mEnd) * MDRIFT_NIGHT;
    S.value = clamp(end + drift, 0, 100); S.mandate = clamp(mEnd + mDrift, 0, 100);
    S.history.push({ day: e.day, start: +S.start.toFixed(1), end: +end.toFixed(1), drift: +drift.toFixed(1), after: +S.value.toFixed(1),
      mStart: +S.mStart.toFixed(1), mEnd: +mEnd.toFixed(1), mAfter: +S.mandate.toFixed(1), incidents: S.incidents,
      cleanIncidents: S.cleanIncidents, recruitMod: +recruitMod(end).toFixed(2), causes: topCauses(99) });
    S.dusk = end; S.overnight = drift;
  }

  // per leader: followers who offend (scanned twice a sim-second)
  function scan() {
    const t = T(), NA = sim.NA;
    for (let i = 0; i < NA; i++) {
      const a = act[i];
      if (a === A_LOOT || a === A_FIGHT || a === A_THROW) { lastOff[i] = t; const l = lead[i]; if (l >= 0) leaderOffT[l] = t; }
    }
  }
  // once a sim-minute: peaceful marches, visibility and stance
  function minute() {
    let total = 0;
    for (const L of sim.leaders || []) {
      if (L.arrested || L.gone) continue;
      const n = L.count || 0; total += n;
      if (n < 100) continue;
      const clean = T() - (leaderOffT[L.id] ?? -1e9) > 600;
      if (n >= 500 && clean) apply('peaceful', 0.5 / 60, 0.3 / 60, L.x, L.y);           // a peaceful hour: +0.5 / sim-hour
      const w = Math.min(1, n / 1000);
      if (L.stance === 'peaceful' && clean) apply('stance', 0.3 * w / 60, 0.2 * w / 60, L.x, L.y, +1, -1);
      else if (L.stance === 'unleashed') apply('stance', 1.0 * w / 60, 0.5 * w / 60, L.x, L.y, -1, +1);
    }
    if (total >= 500) apply('peaceful', 0.3 * clamp(total / 2000, 0, 1.5) / 60, 0, null, null); // visibility of a big march
  }

  function topCauses(n = 3) {
    return Object.entries(S.today).filter(([, v]) => Math.abs(v.s) >= 0.05 || Math.abs(v.m) >= 0.05)
      .sort((a, b) => Math.abs(b[1].s) - Math.abs(a[1].s)).slice(0, n)
      .map(([k, v]) => ({ cause: k, label: CAUSES[k]?.label || k, s: +v.s.toFixed(2), m: +v.m.toFixed(2), n: v.n }));
  }
  function recruitMod(v = S.value) {
    return clamp(Math.pow(Math.max(0, v) / 50, 1.5) * (1 + 0.25 * Math.min(2, S.cleanIncidents)), 0.25, 2.5);
  }

  sim.api.supportInfo = () => ({ ...S, today: { ...S.today }, delta: S.value - S.start, top: topCauses(3),
    ceiling: sim.api.supportEscalationCeiling(), lambda: +(1.5 - S.mandate / 100).toFixed(2), recruitMod: recruitMod() });
  sim.api.supportRecruitMod = () => recruitMod();
  sim.api.supportMandateMod = () => clamp(0.5 + S.mandate / 100, 0.5, 1.5);
  sim.api.supportEscalationCeiling = () => clamp(Math.floor(S.mandate / 22), 0, 4);
  sim.api.supportMoraleBase = () => clamp(0.5 + 0.2 * (S.value - 50) / 50, 0.2, 0.8);
  sim.api.supportCauses = () => CAUSES;

  return {
    name: 'support',
    init() {
      S = sim.support = fresh(); prevV = S.value; leaderOffT = [];
      sim.onEvent(onEvent);
    },
    update(dt) {
      if (!live()) return;
      S.media = media();
      scanT -= dt; if (scanT <= 0) { scanT = 0.5; scan(); }
      minT -= dt; if (minT <= 0) { minT = 60; minute(); }
      if (!managed()) { // sandbox: no nights, so drift continuously (25% per SANDBOX_DRIFT_T)
        const k = -Math.log(1 - DRIFT_NIGHT) / SANDBOX_DRIFT_T * dt;
        S.value += (S0 + 20 * S.climate - S.value) * k; S.mandate += (M0 - S.mandate) * k;
      }
      // trend: points per sim-hour, smoothed over ~10 sim-minutes
      const rate = (S.value - prevV) / dt * 3600; prevV = S.value;
      const a = 1 - Math.exp(-dt / 600); S.trend += (rate - S.trend) * a;
      sampT -= dt;
      if (sampT <= 0) { sampT = 300; S.samples.push({ t: Math.round(T()), v: +S.value.toFixed(2), m: +S.mandate.toFixed(2) }); if (S.samples.length > 2000) S.samples.splice(0, 500); }
    },
  };
}
