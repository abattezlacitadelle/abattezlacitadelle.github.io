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

## Last playtest (`playtest/r2/report.md`, v1.8, 12 campaigns: 4 strategies × 3 seeds × 7 days; chunked run, see contract v1.8)
- Targets missed. There are **7 decapitation losses of 12** (target ≤ 4): reckless 3/3, diversion 3/3, careful 1/3. Passive ran all 7 days 3/3, ending on time.
- Wins: careful-3 on **day 2 at 16:23** (target: no wins on days 1–2) and careful-1 on day 3 at 13:37. No day-1 win; the gate barrier and the crowd-held win rule work.
- Leader arrests per played day: median 2 (mean 1.73 over 52 days). In r1 the median was 1 only because a day ended at the first arrest. By strategy (median / mean): passive 1 / 0.71, careful 2 / 2.14, diversion 2 / 2.45, reckless 3 / 2.54. 52 of 90 leader arrests were within 700 m of the gate (r1: 23 of 99), and 43 were Unleashed leaders.
- Days now survive: 28 of 52 days reached dusk (r1: 0 of 76). Passive loses about one leader a day from day 2, on days 1–2 3 in total.
- Crowd at day start: passive grows (1000 → ~1430–1590 on day 7) and careful holds (1000 → 1027 → 1017; 1000 → 1088) or drops (1000 → 812). Diversion slowly drops, then recovers (1000 → 937 → 846 → 948 → 1072).
- Police stay active: 200–300 arrests a day under the custody cap, kettles, cordons and hunts every day, and gas use roughly doubled.
- Perf: mean of hourly mean step 1.84 ms (r1 1.45); the worst hour is 3.7 ms (r1 3.8).
- Main remaining causes: careful and diversion push at the gate ring for hours at escalation 4. Gas and charges break the core, and the leader is taken there (earned, but it happens nearly every day). Marches with few followers left (< 120) are taken quickly. Day 2 can be won through a gate breach late in the afternoon (intensity ≥ 0.35).

## Next (proposed order)
1. **Leader survival, round 2:**
   - Day-2 gate: raise `GATE_BREACH_INT` to about 0.5, so no breach before day 3.
   - Exposure at the gate ring: lower the < 300 m multiplier (3 → 2), or require the leader itself to be in contact.
   - The bot's careful and diversion strategies sit at the gate ring for hours. Make them fall back after a failed push, so the test measures play, not attrition.
   - Then re-run `node tools/playtest.mjs --chunkMin 8.5 --out playtest/r3` (about 9 calls of 9 min).
2. Implement objectives v1 (`docs/objectives.md` §11.1).
3. Gauges v1 (`docs/gauges.md`), then the night planning screen.

Older open items that are still unverified: the car-fire chain is too strong; dense clashes cost about 4 ms per step; there are no cars on primary roads.

## Working mode
The user wants the assistant to act as orchestrator and dispatch agents for every task, with one owner per file. Scratchpad files from agents do not persist across sessions. Playtest outputs go in `playtest/`.
