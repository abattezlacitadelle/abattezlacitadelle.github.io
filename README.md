# Riot Sim

> **Avertissement / Disclaimer**
>
> Œuvre de fiction. Ce jeu est une simulation imaginaire : toute ressemblance avec des lieux, des personnes, des commerces ou des événements existants ou ayant existé serait purement fortuite. Le fait de devoir recourir à des dégradations pour gagner ne doit en aucun cas être compris comme un encouragement à commettre des dégradations. Ce jeu n'encourage ni ne cautionne les violences policières qu'il représente.
>
> A work of fiction. This game is an imaginary simulation: any resemblance to real places, people, businesses or events, past or present, is purely coincidental. Having to resort to property damage to win must not be taken as encouragement to damage property. Nor does the game encourage or condone the police violence it depicts.

A top-down strategy game set in a fictional city. You lead a protest movement for seven days. Your leaders nudge their marches through the city streets toward the Élysée, while an organised police force blocks, cordons, kettles, gasses and arrests. Uncontrolled riots, looting, fires and brawls play out around you. Each person is simulated as an agent in a fluid-like crowd: about 3,000 people and 6 to 9 police squads.

**Goal:** bring a leader with at least 300 followers into the gold ring at the Élysée gate and hold it. You lose if every leader is arrested, if the march fizzles out, or if day 7 ends.

## Run it

```sh
node tools/serve.mjs
```

Then open http://localhost:8080. You need a recent Chrome, Edge or Firefox. There is no build step and nothing to install.

| URL | Mode |
|---|---|
| `index.html` | Campaign. It opens on the day-1 briefing: pick each leader's starting point, then press Enter. |
| `index.html?sandbox` | Free play with no day loop |
| `index.html?map=full` | The large map, République/Bastille to the Élysée (works with `?sandbox` too) |
| `index3d.html` | The older three.js 3D view of the same simulation |
| `fxdemo.html` | Standalone preview of the effects layer, driven by a mock riot |

Headless smoke test: `node tools/smoke.mjs <ms> <out.png> [query] [js]`. In the browser console, `window.__sim` exposes the sim, view and UI.

## Controls

| Key / mouse | Action |
|---|---|
| Left-click | Select a leader (Shift adds more) |
| Right-click | Send the selected leaders there |
| Left-drag, WASD, arrows | Pan |
| Wheel | Zoom |
| 1–9 | Select a leader |
| F | Pan to the selected leader |
| 0 | Show the whole map |
| Q / E | Stance: Peaceful · Firm · Unleashed |
| T | Rally: tighten the march and calm nearby panickers (60 s cooldown) |
| Y | Scatter: break the march into side streets (90 s cooldown) |
| Space | Pause |
| Enter | Start the day / continue after the night summary |
| I | Legend: what every colour, marker and icon means |
| O | Police intent overlay: where squads are heading, planned blocks, cordons and kettles, predicted crowd routes |
| K | Crowd density heatmap |
| N | Walkable grid |
| M | Tear-gas puffs on/off |
| H | Hide the help panel |
| Debug | L new leader · R +100 people · P / X add or remove a squad · G gas · B riot at cursor · C combat demo |

The HUD also has a speed slider (1–60×), the clock and phase, crowd counts, the day's stats (looted, arrests, injured, fires), a tension meter, the police escalation level (0–4), your leaders with stance and energy, and Legend and Police intent buttons. The ticker in the bottom right reports events; click a row to pan there.

`fxdemo.html` has its own keys: 1–9 and J toggle effect layers, N night tint, Z zoom, B explosion and F fire at the cursor, C clear.

## What's on screen

Press **I** in the game for the full legend. It is drawn by the renderer's own code, so it always matches the map. In short:

- **Dots** are people. A leader's colour means that leader's marchers. Grey dots are bystanders. Dark diamonds with an orange rim are a wild riot with no leader. Yellow is fleeing, magenta is looting, a red cross is injured, a blue ring is arrested, and a hollow dot is heading home at dusk.
- **Zoomed in**, inner markers show a person's role: medic (white cross), black bloc (black), encourager (yellow), pacifist (light blue).
- **Leaders** are large discs with a name label and an energy bar. A badge shows their stance: P peaceful, F firm, U unleashed.
- **Police** are navy officer blocks when zoomed in and a bold bar on the front row when zoomed out. Labels show the squad, its state and its tactic. Diamonds are snatch teams, and vans mean a squad is moving fast by road.
- **Icons:** stars for a brawl, $ for looting, a red cross for an injury, handcuffs for an arrest.
- **Trails** show thrown objects: rocks, bottles, molotovs and fireworks from the crowd; gas canisters, rubber bullets (LBD) and flash-bangs from the police.
- **Fire and gas:** flames and smoke, a yellow-green tear-gas cloud, and scorch marks.

## Project layout

| Path | What |
|---|---|
| `index.html`, `index3d.html`, `fxdemo.html` | Pages: 2D game, 3D view, effects preview |
| `src/sim.js`, `src/common.js` | Simulation core: nav grid, flow fields, spatial hash, agents (struct of arrays), events, `sim.api` |
| `src/systems/*.js` | Systems, run in order each step: `leaders`, `riots` (autonomous crowd AI), `police`, `combat`, `gas`, `crowd` (movement), `day` (7-day loop) |
| `src/render2d.js` | 2D tactical map, people, police, legend swatches and the police intent overlay |
| `src/fx2d.js` | Effects: projectiles and trails, fire, smoke, explosions, decals, event icons, dusk tint |
| `src/ui.js` | HUD, keys, ticker, legend panel, briefing and summary overlays, main loop |
| `src/render3d.js` | 3D view (three.js) |
| `src/loader.js` | Map data loader |
| `data/paris-small.js`, `data/paris.js` | Map data built from OpenStreetMap: roads, buildings, shops, props, spawn points |
| `tools/serve.mjs`, `tools/smoke.mjs` | Static server; headless Chrome smoke test |
| `tools/build_map.mjs` | Rebuilds the maps from OpenStreetMap (`--bbox`, `--out`, `--crop`) |
| `tools/bot.js`, `tools/playtest.*` | Bot player and playtest runner (unfinished) |
| `bench/` | Crowd step benchmark, JS vs Rust/WASM |

## Docs

- [`STATE.md`](STATE.md): current project state, open issues and playtest feedback
- [`docs/contract.md`](docs/contract.md): the shared contract between systems (data fields, APIs, events, changelog)
- [`docs/police-tactics.md`](docs/police-tactics.md): research on public-order policing and the specs for the police AI
- [`docs/gauges.md`](docs/gauges.md): design for morale, anger, fatigue, support and escalation gauges (not implemented yet)
- [`bench/README.md`](bench/README.md): benchmark notes

Map data © OpenStreetMap contributors.
