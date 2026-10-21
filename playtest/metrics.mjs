// node playtest/metrics.mjs <dir>: v1.8 balance targets (decapitations, leader arrests per day, wins, crowd trend, ms/step)
import fs from 'node:fs'; import path from 'node:path';
const dir = process.argv[2], files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('ckpt')).sort();
const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
let decap = 0; const per = [], wins = [], ms = [], bySt = {};
for (const f of files) {
  const R = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), s = R.summary, st = s.strategy;
  if (s.reason === 'decapitated') decap++;
  if (s.win) wins.push(`${f.replace('.json', '')} d${s.day} ${s.at}`);
  const B = bySt[st] ||= { la: [], early: 0, peaks: [], crowd0: [] };
  for (const d of R.days) { const n = d.leaderArrests.length; per.push(n); B.la.push(n); if (d.day < 3) B.early += n; ms.push(...d.hours.map(h => h.ms).filter(Boolean)); }
  B.crowd0.push(R.days.map(d => d.stats.crowd0).join('>'));
}
console.log('campaigns', files.length, 'decapitation losses', decap, 'wins', wins.join(', ') || 'none');
console.log('leader arrests per played day: median', med(per), 'mean', (per.reduce((a, b) => a + b, 0) / per.length).toFixed(2), 'days', per.length);
for (const [k, B] of Object.entries(bySt)) console.log(k, 'leader arrests/day median', med(B.la), 'mean', (B.la.reduce((a, b) => a + b, 0) / B.la.length).toFixed(2), 'on days 1-2:', B.early, '| crowd at day start:', B.crowd0.join(' ; '));
console.log('ms/step: mean of hourly means', (ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(2), 'max hourly', Math.max(...ms).toFixed(2));
