// Run the simulation in Node (no browser): loads the map data file and the precomputed nav grid
// (data/nav-<map>.bin, made by `node playtest/dumpnav.mjs`), then calls createSim with opts.navRaster.
//   import { makeSim } from './nodesim.mjs'; const sim = makeSim('small');
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createSim } from '../src/sim.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cache = {};
export function loadMap(map = 'small') {
  const name = map === 'full' ? 'paris' : 'paris-small';
  if (cache[name]) return cache[name];
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(root + `data/${name}.js`, 'utf8'), ctx);
  const nav = new Uint8Array(fs.readFileSync(root + `data/nav-${name}.bin`));
  return cache[name] = { data: ctx.window.PARIS_DATA, nav };
}
export function makeSim(map = 'small', seed = 1) {
  const { data, nav } = loadMap(map);
  // structuredClone: the systems mutate data-derived objects (shops, props), so every run gets fresh data
  const sim = createSim(structuredClone(data), { navRaster: nav });
  sim.seed(seed);
  return sim;
}
