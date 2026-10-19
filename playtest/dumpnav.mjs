// Dump the browser-rasterised nav grid (sim.walk) so the sim can run in Node: node playtest/dumpnav.mjs [small|full]
import { open } from './cdp.mjs'; import fs from 'node:fs';
const map = process.argv[2] || 'small';
const b = await open('index.html?sandbox' + (map === 'full' ? '&map=full' : ''), 9251);
const r = await b.ev(`(() => { const s = __sim.sim; let bin = ''; const w = s.walk; for (let i = 0; i < w.length; i += 8192) bin += String.fromCharCode.apply(null, w.subarray(i, i + 8192)); return { cols: s.COLS, rows: s.ROWS, walkCells: s.walkCells, b64: btoa(bin) }; })()`);
b.close();
const buf = Buffer.from(r.b64, 'base64');
fs.writeFileSync(new URL(`../data/nav-${map === 'full' ? 'paris' : 'paris-small'}.bin`, import.meta.url), buf);
console.log(map, r.cols, r.rows, r.walkCells, buf.length);
process.exit(0);
