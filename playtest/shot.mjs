// node playtest/shot.mjs <script.js> [query] [port]: opens the game, runs the script (async function body; `S` = window.__sim,
// `shot(name)` saves a screenshot to playtest/shots/<name>.png, `log(...)` prints), then exits.
import { open } from './cdp.mjs'; import fs from 'node:fs';
const [file, query = 'index.html', port = '9261'] = process.argv.slice(2);
fs.mkdirSync('playtest/shots', { recursive: true });
const b = await open(query, +port);
await b.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
const body = fs.readFileSync(file, 'utf8');
await b.ev(`window.__shots = []; window.__logs = []; window.__run = async () => { const S = window.__sim; const log = (...a) => __logs.push(a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); const shot = n => new Promise(r => { __shots.push(n); window.__shotDone = r; }); const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); ${body} }; window.__runP = __run().then(() => 'ok', e => 'ERR ' + (e.stack || e)); 1`);
let done = false;
while (!done) {
  await new Promise(r => setTimeout(r, 300));
  const st = await b.ev(`(() => { const s = __shots.splice(0); const l = __logs.splice(0); return { s, l, done: window.__runRes }; })()`);
  for (const l of st.l) console.log(l);
  for (const n of st.s) { await b.shot(`playtest/shots/${n}.png`); console.log('shot', n); await b.ev('window.__shotDone && window.__shotDone(), 1'); }
  const r = await b.ev(`window.__runP && Promise.race([window.__runP, new Promise(r => setTimeout(() => r(null), 10))])`);
  if (r) { console.log('result', r); const st2 = await b.ev(`(() => ({ l: __logs.splice(0), s: __shots.splice(0) }))()`); for (const l of st2.l) console.log(l); for (const n of st2.s) { await b.shot(`playtest/shots/${n}.png`); console.log('shot', n); } done = true; }
}
b.close(); process.exit(0);
