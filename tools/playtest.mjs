// Headless balance playtests in Node (no browser): full 7-day campaigns played by tools/bot.js.
//
//   node tools/playtest.mjs [--strategies passive,reckless,careful,diversion] [--seeds 1,2,3] [--days 7]
//                           [--jobs 12] [--map small|full] [--out playtest/out] [--quiet]
//                           [--startDay N --crowd C]   (debug: begin on day N with C marchers; --days counts from there)
//
// Every job (strategy x seed) runs in its own Node process (fork of this script with --worker). The sim runs in
// fixed 0.12 s substeps; the bot decides every 5 sim seconds. The nav grid comes from data/nav-<map>.bin (dump it with
// `node playtest/dumpnav.mjs` after a map rebuild). Output in --out: <strategy>-<seed>.json (per-day stats, hourly
// timeline, leader arrests, stall episodes, police gaps) and report.md (campaign table, per-day table, hourly chaos curve).
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2), v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1'; args[k] = v; }
const self = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(self), '..');

if (args.worker) await worker(args.worker);
else await main();

// ---------------------------------------------------------------- one campaign (child process)
async function worker(job) {
  const [strategy, seedS] = job.split(':'), seed = +seedS, days = +(args.days || 7), map = args.map || 'small';
  const { makeSim } = await import('./nodesim.mjs');
  const { createBot, createLogger } = await import('./bot.js');
  const sim = makeSim(map, seed);
  if (args.intensity) sim.day.intensityOverride = +args.intensity;
  sim.initScenario();
  if (args.startDay) sim.api.daySetDay(+args.startDay, args.crowd ? +args.crowd : undefined); // debug: start the campaign on day N
  const bot = createBot(sim, strategy, { seed });
  const log = createLogger(sim, bot);
  const DT = 0.12, BOT_DT = 5;
  let botAcc = 0, lastP = 0;
  const t0 = performance.now();
  while (true) {
    const d = sim.day;
    if (d.phase === 'ended') { log.dayEnd(); break; }
    if (d.phase === 'briefing') { if (d.day > days + (+args.startDay || 1) - 1) break; bot.briefing(); log.dayStart(); sim.api.dayStart(); bot.dayStarted(); continue; }
    if (d.phase === 'summary') { log.dayEnd(); if (d.day >= days + (+args.startDay || 1) - 1) break; sim.api.dayContinue(); continue; }
    const s0 = performance.now();
    sim.step(DT);
    log.stepMs(performance.now() - s0);
    botAcc += DT;
    if (botAcc >= BOT_DT - 1e-6) { botAcc = 0; bot.tick(BOT_DT); }
    log.tick(DT);
    if (performance.now() - lastP > 20000) { lastP = performance.now(); process.send?.({ progress: log.progressLine() }); }
  }
  const r = log.result();
  r.seed = seed; r.wallMin = +((performance.now() - t0) / 60000).toFixed(1); r.bot = bot.state;
  const out = path.resolve(args.out || path.join(root, 'playtest/out'));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${strategy}-${seed}.json`), JSON.stringify(r));
  process.send?.({ done: true, summary: r.summary, wallMin: r.wallMin });
  process.exit(0);
}

// ---------------------------------------------------------------- driver
async function main() {
  const strategies = (args.strategies || 'passive,reckless,careful,diversion').split(',');
  const seeds = (args.seeds || '1,2,3').split(',').map(Number);
  const jobsN = +(args.jobs || 12);
  const outDir = path.resolve(args.out || path.join(root, 'playtest/out'));
  fs.mkdirSync(outDir, { recursive: true });
  const jobs = [];
  for (const strategy of strategies) for (const seed of seeds) jobs.push({ strategy, seed, name: `${strategy}-${seed}` });
  const pass = ['days', 'map', 'intensity', 'startDay', 'crowd'].flatMap(k => args[k] ? ['--' + k, args[k]] : []);
  let next = 0;
  const T0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(jobsN, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await new Promise(res => {
        const cp = fork(self, ['--worker', `${job.strategy}:${job.seed}`, '--out', outDir, ...pass], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        cp.on('message', m => {
          if (m.progress && !args.quiet) console.log(`[${job.name} ${((Date.now() - T0) / 60000).toFixed(1)}m] ${m.progress}`);
          if (m.done) { const s = m.summary; console.log(`[${job.name}] DONE ${m.wallMin} min: ${s.win ? 'WIN' : 'LOSS'} (${s.reason}) day ${s.day} ${s.at}`); }
        });
        cp.on('exit', code => { if (code) console.log(`[${job.name}] FAILED (exit ${code})`); res(); });
      });
    }
  }));
  writeReport(outDir, jobs);
}

export function writeReport(outDir, jobs) {
  const load = j => { const f = path.join(outDir, `${j.name}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
  const L = ['# Playtest report', '', `${new Date().toISOString()}`, '', '## Campaigns', '',
    '| strategy | seed | result | day | time | reason | peak crowd by day | arrests | leaders arrested | min dist to gate by day (m) | wall |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const j of jobs) {
    const R = load(j); if (!R) { L.push(`| ${j.strategy} | ${j.seed} | ERROR |||||||||`); continue; }
    const s = R.summary;
    L.push(`| ${j.strategy} | ${j.seed} | ${s.win ? '**WIN**' : 'loss'} | ${s.day} | ${s.at} | ${s.reason} | ${s.days.map(d => d.peak).join(' / ')} | ${s.days.reduce((a, d) => a + d.arrests, 0)} | ${s.days.map(d => d.leadersArrested ? `d${d.day}:${d.leadersArrested}` : '').filter(Boolean).join(' ') || '-'} | ${s.days.map(d => d.minGoal).join(' / ')} | ${R.wallMin}m |`);
  }
  const cols = ['crowd0', 'peak', 'end', 'riotsJoined', 'looted', 'lootGrabs', 'fires', 'throws', 'brawls', 'arrests', 'leadersArrested', 'injured', 'officersDown', 'brutality', 'gas', 'charges', 'snatches', 'blocks', 'kettles', 'cordons', 'funnels', 'splits', 'hunts', 'gaps', 'lineBreaks', 'minGoal', 'stallMin', 'maxEsc', 'msAvg', 'msPeak', 'reason'];
  L.push('', '## Per day', '', '| run | day | ' + cols.join(' | ') + ' |', '|' + '---|'.repeat(cols.length + 2));
  for (const j of jobs) { const R = load(j); if (!R) continue; for (const d of R.summary.days) L.push(`| ${j.name} | ${d.day} | ` + cols.map(c => d[c] ?? '').join(' | ') + ' |'); }
  // hourly chaos curve, averaged over all runs and days >= 4
  const hk = ['loot', 'fire', 'throw', 'brawl', 'arrest', 'injury', 'gas', 'charge', 'brutality', 'officerDown', 'kettle', 'cordon', 'p_snatches'];
  const acc = {}, n = {};
  for (const j of jobs) { const R = load(j); if (!R) continue; for (const d of R.days) { if (d.day < 4) continue; for (const H of d.hours) { const a = acc[H.h] ||= {}; n[H.h] = (n[H.h] || 0) + 1; for (const k of hk) a[k] = (a[k] || 0) + (H[k] || 0); a.looters = (a.looters || 0) + H.looters; a.fires_live = (a.fires_live || 0) + H.fires; } } }
  L.push('', '## Hourly chaos (mean per hour, days 4-7, all runs)', '', '| hour | ' + hk.join(' | ') + ' | peak looters | peak live fires |', '|' + '---|'.repeat(hk.length + 3));
  for (const h of Object.keys(acc).map(Number).sort((a, b) => a - b)) L.push(`| ${h}:00 | ` + hk.map(k => (acc[h][k] / n[h]).toFixed(1)).join(' | ') + ` | ${(acc[h].looters / n[h]).toFixed(0)} | ${(acc[h].fires_live / n[h]).toFixed(0)} |`);
  fs.writeFileSync(path.join(outDir, 'report.md'), L.join('\n') + '\n');
  console.log(L.slice(0, 6 + jobs.length + 2).join('\n'));
}
