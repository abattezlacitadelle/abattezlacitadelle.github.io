// Shared constants and small helpers (re-exported by sim.js; imported by systems to avoid a circular import).
export const LEADER_COLORS = [0xe63946, 0xf4a261, 0x2a9d8f, 0xa06cd5, 0x4cc9f0, 0xffd166, 0x06d6a0, 0xef476f, 0x90be6d, 0xff8fab];
export const NAMES = ['Inès', 'Karim', 'Louise', 'Malik', 'Chloé', 'Théo', 'Sofia', 'Hugo', 'Yasmine', 'Jules', 'Nora', 'Bastien'];
export const LM_NAMES = { republique: 'République', bastille: 'Bastille', hotelDeVille: 'Hôtel de Ville', elysee: 'ÉLYSÉE',
  concorde: 'Concorde', beauvau: 'Pl. Beauvau', madeleine: 'Madeleine', chatelet: 'Châtelet', notreDame: 'Notre-Dame',
  louvre: 'Louvre', pontNeuf: 'Pont Neuf', operaGarnier: 'Opéra', palaisRoyal: 'Palais-Royal', tuileries: 'Tuileries' };
// display name for a landmark key (falls back to splitting camelCase)
export const lmName = k => LM_NAMES[k] || (k[0].toUpperCase() + k.slice(1)).replace(/([a-z])([A-Z])/g, '$1 $2');
const LL = { republique: [48.8675, 2.3637], bastille: [48.8532, 2.3691], hotelDeVille: [48.8566, 2.3522], elysee: [48.8704, 2.3167],
  concorde: [48.8656, 2.3212], beauvau: [48.8714, 2.3171], madeleine: [48.8700, 2.3245], chatelet: [48.8583, 2.3470],
  notreDame: [48.8530, 2.3499], louvre: [48.8606, 2.3376], pontNeuf: [48.8571, 2.3413], operaGarnier: [48.8720, 2.3316] };

export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const ring = a => Array.isArray(a) ? a : a.o;
export const holes = a => Array.isArray(a) ? null : a.i;
export function polyPath(ctx, f) { ctx.moveTo(f[0], f[1]); for (let i = 2; i < f.length; i += 2) ctx.lineTo(f[i], f[i + 1]); ctx.closePath(); }
export function areaPath(ctx, a) { ctx.beginPath(); polyPath(ctx, ring(a)); const h = holes(a); if (h) for (const r of h) polyPath(ctx, r); }
export function linePath(ctx, p) { ctx.beginPath(); ctx.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]); }

// agent classes and actions (see docs/contract.md)
export const CLS = { RANDO: 0, PACIFIST: 1, ENCOURAGER: 2, MEDIC: 3, BLACKBLOC: 4 };
// HOME (v1.5): heading home at dusk (not panicking; excluded from the Fleeing counter)
export const ACT = { IDLE: 0, FOLLOW: 1, FLEE: 2, LOOT: 3, FIGHT: 4, THROW: 5, PUSH: 6, HEAL: 7, MILL: 8, DOWN: 9, ARRESTED: 10, HOME: 11 };

// seedable PRNG (mulberry32): returns { rand, seed(n) }
export function makeRng(s = (Math.random() * 4294967296) >>> 0) {
  let a = s >>> 0;
  return {
    rand() { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; },
    seed(n) { a = n >>> 0; },
  };
}
