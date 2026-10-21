// node playtest/sumarr.mjs <dir>: compact per-day summary with leader arrests (v1.8 balance round)
import fs from 'node:fs'; import path from 'node:path';
const dir = process.argv[2];
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.includes('.ckpt')).sort()) {
  const R = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), s = R.summary;
  console.log(`## ${f} ${s.win ? 'WIN' : 'loss'} ${s.reason} d${s.day} ${s.at} wall ${R.wallMin}m`);
  for (const d of R.days) {
    const st = d.stats;
    console.log(`  d${d.day} ${st.reason} L0=${st.leaders0} crowd0 ${st.crowd0} peak ${st.peak} end ${st.end} held ${st.held} arr ${st.arrests} snatch ${st.snatches} hunts ${st.hunts} hArr ${st.huntArrests} kettles ${st.kettles} cord ${st.cordons} lineArr ${st.lineArrests} gas ${st.gas} chg ${st.charges} esc ${st.maxEsc} minG ${st.minGoal} breach ${st.gateBreaches} succ ${st.successors} ms ${(d.hours.reduce((a, h) => a + (h.ms || 0), 0) / Math.max(1, d.hours.length)).toFixed(2)}`);
    for (const a of d.leaderArrests) console.log(`     ${a.t} ${a.leader}${a.successor ? '(succ)' : ''} ${a.stance} n${a.count} own10 ${a.own10} dG ${a.dGoal} esc ${a.esc} gas ${a.gas} by ${a.by} m${a.expMult}${a.kettled ? ' KETTLED' : ''}`);
  }
}
