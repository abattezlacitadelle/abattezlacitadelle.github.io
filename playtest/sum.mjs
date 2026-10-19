// node playtest/sum.mjs <dir> [hourly]: compact summary of a playtest output directory
import fs from 'node:fs';
const dir = process.argv[2], hourly = process.argv[3];
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
  const R = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')), s = R.summary;
  console.log(`== ${f} ${s.win ? 'WIN' : 'loss'} ${s.reason} day ${s.day} ${s.at} (${R.wallMin} min) bot ${JSON.stringify(R.bot)}`);
  for (const d of R.days) {
    const t = d.stats;
    console.log(` d${d.day} crowd ${t.crowd0}/${t.peak}/${t.end} riots ${t.riotsJoined} loot ${t.looted}/${t.lootGrabs} fires ${t.fires} throws ${t.throws} brawls ${t.brawls} | arr ${t.arrests} (hunt ${t.huntArrests} line ${t.lineArrests}) L[${t.leadersArrested}] inj ${t.injured} offDown ${t.officersDown} brut ${t.brutality} gas ${t.gas} chg ${t.charges} snatch ${t.snatches} | blk ${t.blocks} ket ${t.kettles} cor ${t.cordons} fun ${t.funnels} spl ${t.splits} hunt ${t.hunts} gaps ${t.gaps} breaks ${t.lineBreaks} gateBr ${t.gateBreaches} turns ${t.intelTurns} | minGoal ${t.minGoal} stall ${t.stallMin}m esc ${t.maxEsc} ms ${d.hours.length ? (d.hours.reduce((a, h) => a + (h.ms || 0), 0) / d.hours.length).toFixed(2) : '-'} ${t.reason}`);
    console.log(`    inj ${JSON.stringify(d.injuries)} brut ${JSON.stringify(d.brutality)} Larr ${JSON.stringify(d.leaderArrests.map(a => `${a.t} ${a.leader} d${a.dGoal} n${a.count} own${a.own10} g${a.gas} e${a.esc} ${a.stance}`))} gaps ${JSON.stringify(d.gapWhy)}`);
    if (hourly) for (const H of d.hours) console.log(`    ${H.h}h fol ${H.followers} NA ${H.NA} looters ${H.looters} fight ${H.fighters} fires ${H.fires} esc ${H.esc} | loot ${H.loot || 0} fire ${H.fire || 0} brawl ${H.brawl || 0} arr ${H.arrest || 0} inj ${H.injury || 0} gas ${H.gas || 0} chg ${H.charge || 0} brut ${H.brutality || 0} offD ${H.officerDown || 0} ket ${(H.kettle || 0) + (H.cordon || 0)} snatch ${H.p_snatches || 0} ms ${H.ms}/${H.msMax}`);
  }
}
