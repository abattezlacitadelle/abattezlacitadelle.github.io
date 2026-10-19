# Paris Riot Sim: project state (updated 2026-10-19)

**This folder is not a git repository**, so a backup is a copy of the folder. See `README.md` for how to run, the controls and the layout, and `docs/contract.md` for the architecture and the changelog up to v1.7.

## Quick run
- `node tools/serve.mjs`, then open http://localhost:8080. Add `?sandbox` for free play and `?map=full` for the large map.
- `node tools/smoke.mjs <ms> <png> [query] [js]` is a headless Chrome smoke test.
- `node tools/playtest.mjs [--strategies passive,reckless,careful,diversion] [--seeds 1,2,3] [--jobs 12] [--out playtest/<dir>]` plays headless 7-day campaigns in Node with `tools/bot.js`. It writes per-run JSON and `report.md`.

**Check on 2026-10-19:** campaign and sandbox boot with no exceptions.

## Done since the 2026-10-18 stop (v1.5–v1.7, see the contract changelog)
- Police: a global coordination layer (re-plans every 12 s; blocks, cordons, kettles, funnels, splits, hunts), vans, an intent plan and predictions, guess-only intel (tracks, with no reading of orders), line arrests, a gate guard ring with breaches, gas stock, and brutality counted as incidents.
- Crowd: restless roaming and lapsing, a stronger leader wait rule, stopping short of police lines, corner-aware pathing for bloc and looters, and a brawl-token limiter.
- Day: the `sim.day.intensity` chaos ramp (by time of day × day of week), dusk leavers as `ACT.HOME`, and an objective hook (`sim.api.addObjective`).
- UI: legend (I), police intent overlay (O), and a separate palette for rival riots.
- Node sim (`tools/nodesim.mjs`, `data/nav-paris-small.bin`) plus the bot and playtest runner, both working.
- Docs: `README.md`, and `docs/objectives.md` (sites, Momentum, Breakthrough meter, camps; a design with a v1 implementation plan in §11, **not implemented**).

## Last playtest (`playtest/r1/report.md`, 12 campaigns: 4 strategies × 3 seeds)
- 11 of 12 runs are losses by **decapitation**. Every day of every run ends "leaderless".
- **Root cause (orchestrator analysis, 2026-10-19):** across 99 leader arrests, the leader typically had **0–10 own followers within 10 m** while leading 100–900. Restless roaming (roam radius 30 + 1.8·√n) leaves leaders exposed, and police line grabs, snatches and hunts take them even when peaceful and 2–3 km from the gate. From day 2 there is only one active leader, so a single arrest ends the day.
- Crowd shrinks from day to day (1000 → 700 → 590) because every day ends leaderless.
- One fluke **day-1 win at 09:22** (careful-3). The gate is beatable at low intensity.

## Next (proposed order)
1. **Leader survival balance:** a protective core of followers around the leader, police leader-targeting rules that depend on stance, escalation and distance, and 2 or more leaders on later days. Re-run the playtest. Close the day-1 gate fluke.
2. Implement objectives v1 (`docs/objectives.md` §11.1).
3. Gauges v1 (`docs/gauges.md`), then the night planning screen.

Older open items that are still unverified: the car-fire chain is too strong; dense clashes cost about 4 ms per step; there are no cars on primary roads.

## Working mode
The user wants the assistant to act as orchestrator and dispatch agents for every task, with one owner per file. Scratchpad files from agents do not persist across sessions. Playtest outputs go in `playtest/`.
