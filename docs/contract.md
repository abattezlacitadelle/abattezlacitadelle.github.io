# Shared architecture contract (v1, day-loop round)

Every agent builds against this contract. **If you need to change it, keep it backward compatible and record the change in the "Changelog" section at the bottom.**

## Units and coordinates
- Units are metres and seconds. `x` grows east and `y` grows north. The origin is the map's south-west corner.
- Sim time runs in substeps of 0.12 s or less, driven by `sim.advance(simDt)`.

## `createSim(data)`: shared state (src/sim.js)
Agents are stored as a structure of arrays with capacity `MAXA`. `sim.NA` (a getter) is the live count. When an agent is removed, the last live agent is swap-copied into its slot, so **every per-agent array must be registered** via `sim.registerAgentArray(arr)`, which ensures `copyAgent` covers it.

| Field | Type | Meaning |
|---|---|---|
| px, py, vx, vy | Float32 | position and velocity |
| lead | Int16 | the player-controlled leader being followed, or -1 |
| panicT | Float32 | seconds of fleeing left |
| cls | Uint8 | class: 0 RANDO, 1 PACIFIST, 2 ENCOURAGER, 3 MEDIC, 4 BLACKBLOC (`sim.CLS`) |
| act | Uint8 | current action (`sim.ACT`): 0 IDLE, 1 FOLLOW, 2 FLEE, 3 LOOT, 4 FIGHT, 5 THROW, 6 PUSH, 7 HEAL, 8 MILL (riot milling), 9 DOWN (injured on the ground), 10 ARRESTED |
| tgt | Int32 | action target id: a shop index, squad*1000+officer, or an agent index; -1 for none |
| riot | Int16 | id of the uncontrolled riot group the agent belongs to, or -1 |
| hp | Float32 | 1 = healthy, 0 = down |
| aggr | Float32 | 0..1, placeholder temperament (the future anger gauge plugs in here) |
| cd | Float32 | generic action cooldown in seconds |
| extFx, extFy | Float32 | external acceleration accumulators (m/s²). Any system may add to them. The crowd step consumes and zeroes them each substep. **This is how pushes, charges and blasts move people.** |

## Systems
`sim.systems` is an ordered array of `{ name, init?(sim), update(dt, sim) }`. Each substep runs:
`buildHash` → systems in order: `leaders`, `riots` (autonomous AI), `police`, `combat`, `gas`, `crowd` (integration), `day`.
- A system lives in `src/systems/<name>.js` and exports `default function create(sim) { return { name, init, update } }`.
- To replace a system, edit only its own file.

## Helpers on `sim`
- `walkAt(x, y)`, `cellOf(x, y)`, `nearestWalkable(gx, gy, r)`, `computeField(tx, ty)` (returns `{dist, dir, tx, ty}`), `fieldDir(F, x, y, out)`, `fieldDist(F, x, y)`
- `forEachNear(x, y, r, fn(j, dx, dy, d2))`: spatial hash query over agents
- `W, H, CELL, COLS, ROWS, walk, clear`
- `goal` (the walkable Élysée gate, `{x, y}`) and `GOAL_R`
- `rand()`: the sim's PRNG (seedable via `sim.seed(n)`). Use it rather than Math.random in sim code.
- `addAgent(x, y, opts)` returns an index. `removeAgent(i)` is deferred to the end of the substep.

## Collections (each owned by the named system; others read only, or use that system's API)
- `sim.leaders` (leaders system): `{id, name, x, y, color, field, count, energy, speed, arrived, path, stance, arrested, gone, rallyCd, scatterCd, rallyT}`. Leaders are never removed from the array (`lead[i]` indexes it); `arrested` (set by police) and `gone` (arrested on an earlier day, parked off-map at -5000,-5000) mark inactive leaders. `stance` is `'peaceful' | 'firm' | 'unleashed'` (default `'firm'`).
- `sim.squads` (police system): `{id, x, y, dx, dy, n, ox, oy (Float32 officer positions), state, energy, ...}` plus anything new. The renderer reads `ox`, `oy`, `dx`, `dy`, `state` and `energy`.
- `sim.projectiles` (combat system): `{id, kind, x, y, z, vx, vy, vz, owner:'P'|'C', age, alive}`. `kind` is one of `'rock' | 'bottle' | 'molotov' | 'firework' | 'gas' | 'lbd' | 'flashbang' | 'paving'`. The renderer keeps its own trail history keyed by id.
- `sim.fires` (combat system): `{id, x, y, r, intensity 0..1, kind:'car'|'bin'|'shop'|'barricade'|'molotov', age}`
- `sim.props` (combat system, built from `data.props`): `{x, y, k:'car'|'bin'|'scooter'|'bike'|'construction'|'bus_stop', state:'ok'|'burning'|'burnt'|'used'}`
- `sim.shops` (riots system, built from `data.shops`): `{x, y, k, n, v (value 1..3), looted 0..1, burning}`
- `sim.riots` (riots system): uncontrolled crowds `{id, x, y, count, aggr, controlledBy:-1|leaderId, target}`
- `sim.day` (day system): `{managed, day (1..7), days: 7, phase:'briefing'|'day'|'dusk'|'summary'|'ended', t (sim seconds since midnight of the current day), start (8h), dusk (18h), end (20h), light (1 = daylight .. 0.3 at 20:00), policeClear (true during dusk), stats:{looted (shops), lootGrabs, arrests, injured, recruits, peak, fires, projectiles, brawls, explosions, riotJoined (members), riotsJoined, leadersArrested:[names]}, choice:{leaderId: spawnKey}, riotPlan:[{x, y, n, at, place, spawned}], squadsToday, carry, history:[stats per day], result: null | {win, reason, text, day, leader, count, at}, followers, lastFollowers, lowT}`. `managed` is false in sandbox mode (`?sandbox` in the URL): no campaign, legacy `initScenario`, phase stays `'day'`.

## APIs between systems
- combat:
  - `sim.api.throwProjectile(kind, x0, y0, tx, ty, owner, from?)`
  - `sim.api.ignite(x, y, kind, r?)`
  - `sim.api.explode(x, y, power)`, which adds radial `extFx`/`extFy`, causes injuries and emits an event
- gas: `sim.api.throwGas(x, y)`. A gas canister projectile calls this when it lands.
- police: `sim.api.addSquad(x, y, fx, fy)` and `sim.api.removeSquad(sq)`
- leaders: `sim.api.addLeader(x, y)`, `sim.api.orderLeaders(ids, x, y)`, `sim.api.setStance(id, stance | +1 | -1)`, `sim.api.leaderAction(id, 'rally' | 'scatter')` (returns false on cooldown or for an inactive leader), `sim.api.activeLeaders()`
- day: `sim.api.dayInfo()` (= `sim.day`), `dayStart()` (briefing → day), `dayContinue()` (summary → next briefing), `chooseSpawn(leaderId, spawnKey)` (briefing only), `daySkipTo(hours)` (debug, e.g. 17.99), `dayEnd()`, `dayPlan()`

## Events (for FX and the HUD)
`sim.events.push({ t, x, y, ...extra })`. The renderer calls `sim.drainEvents()` once per frame. Types:
`'explosion' {power}`, `'throw' {kind, owner}`, `'impact' {kind}`, `'fire' {kind}`, `'fireOut'`, `'loot' {shop}`, `'arrest'`, `'charge' {squad}`, `'gas'`, `'injury'`, `'brawl'`, `'shatter'`, `'flash'`, `'dayStart' {day}`, `'dayEnd' {day, stats}`, `'riotJoined' {riot, leader}`, `'dusk' {day}`, `'riotSpawn' {n, riot, place}`, `'promoted' {name, day}`, `'campaignWon' / 'campaignLost' {reason, day}`, `'rally' {leader, n}`, `'scatter' {leader, n}`, `'stance' {leader, stance}`.
Any number of consumers may subscribe with `sim.onEvent(fn)` (called synchronously inside `emit`); `drainEvents()` still works for one per-frame consumer.

## Data (`data/paris-small.js` → `window.PARIS_DATA`)
- Existing: `meta`, `roads`, `buildings`, `water`, `parks`, `squares`, `landmarks`, `spawnPoints`
- New: `shops`: `[{x, y, k:'<shop tag>', n?, v:1..3}]`, positioned on the walkable street edge in front of the shop
- New: `props`: `[{x, y, k}]`
- New: `riotSpawns`: `[{x, y, n}]`, suggested places for uncontrolled riots

## Changelog
- v1: initial version (orchestrator).
- v1.1 (phase 1 architecture, all backward compatible):
  - Constants and helpers (`clamp`, `LEADER_COLORS`, `NAMES`, `LM_NAMES`, `lmName`, path helpers, `CLS`, `ACT`, `makeRng`) live in `src/common.js`. sim.js re-exports them, and systems import from `../common.js` to avoid a circular import.
  - `sim.systems` is built from `SYSTEM_FACTORIES` in sim.js. Every factory's `create(sim)` runs first (this is where systems put their API functions on `sim.api` and legacy aliases on `sim`), then every `init(sim)` runs in order (this is where collections are created). So a system may call another system's API at update time even if that system comes later in the order.
  - The deferred-removal flush (`removeAgent`) runs after all systems in each substep, then `simTime += dt`.
  - `registerAgentArray(arr, def = 0)` takes an optional default value that `addAgent` writes for new agents. It returns `arr`. Arrays must have length ≥ `MAXA`.
  - `addAgent(x, y, opts)`: `opts` is either a leader index (legacy) or `{ lead, cls, riot, aggr }`. If omitted, `cls` is random (50/20/10/8/12) and `aggr` is a per-class placeholder (RANDO 0.3, PACIFIST 0.05, ENCOURAGER 0.4, MEDIC 0.1, BLACKBLOC 0.75, each ±0.1). `act` starts as FOLLOW if the agent has a leader, else IDLE. `hp` = 1, `tgt` = -1, `riot` = -1.
  - Other core per-agent arrays on `sim`: `v0` (preferred speed), `fleeX`/`fleeY`, `gone` (the removal mark). The spatial hash is exposed as `HC`, `hStart`, `hItems`, `hkey`, alongside `countNear(x, y, r)`.
  - Crowd and `act`: DOWN and ARRESTED agents are skipped completely. Their velocity is zeroed, they don't move or attach to leaders, and they don't count toward a leader, but they stay in the hash so they act as obstacles. `panicT > 0` sets FLEE, overriding any other action. Otherwise the crowd rewrites `act` only when it is IDLE, FOLLOW or FLEE, so actions 3..8 set by other systems persist until that system clears them. The crowd also counts `cd` down by dt.
  - `forEachNear(x, y, r, fn)`: `dx = px[j] - x`, `dy = py[j] - y`. Return `true` from `fn` to stop early. It uses the hash built at the start of the substep, so agents added during the substep are not visited.
  - Events: use `sim.emit(type, x, y, extra)`, which pushes `{ type, t: simTime, x, y, ...extra }`. `sim.events` stays the same array. `drainEvents()` returns a copy and clears it. If nothing drains, the queue is capped at about 4000. Emitted so far: `'gas'` (from `throwGas`) and `'charge' {squad}`, emitted at the squad's line centre.
  - `sim.goal` is still the legacy `[x, y]` array, and it now also has `.x`/`.y`.
  - `sim.api.orderLeaders(ids, x, y)` follows the contract. The legacy `sim.orderLeaders(x, y, ids = selected)` is unchanged. Legacy aliases on `sim`: `addLeader`, `orderLeaders`, `select`, `updatePaths`, `addSquad`, `removeSquad`, `throwGas`.
  - Gas exposes `sim.gasSample(x, y)`, which returns the shared object `sim.gs = {s, gx, gy}` (concentration and gradient), plus the existing `gas`, `gwalk`, `GC`, `GCOLS`, `GROWS`, `gasBox`, `emitters`, `WIND` and puff arrays `pX, pY, pH, pSize, pAlpha, NP`. Puffs are now updated inside the gas system, before the crowd. They are visual only.
  - Stubs: combat's `throwProjectile`, `ignite` and `explode` are no-ops. `sim.shops` and `sim.props` are built from `data.shops` and `data.props` when present. `sim.day` starts as `{day: 1, phase: 'day', t: 0, start: 8h, end: 20h, stats: {...0}}`.
  - Sim RNG: mulberry32 with a random seed unless `sim.seed(n)` is called.
- v1.1 (map builder): `shops`, `props` and `riotSpawns` are now in both `data/paris-small.js` and `data/paris.js`. Extra fields: `shops[i].ox, oy` = original OSM position (the shop itself; `x, y` is the snapped walkable street spot in front of it). Shop `k` is the OSM `shop=*` value, or `'amenity:bank'`, `'amenity:cafe'`, etc. `props[i].k` is one of `'car' | 'bin' | 'scooter' | 'bike' | 'bus_stop' | 'construction'`; cars also carry `a` (heading in radians along the street; draw as an oriented ~4.4 x 1.8 m rectangle). `riotSpawns` is an array `[{x, y, n}]` (not keyed like `spawnPoints`). All positions are rounded to 0.1 m and generation is deterministic (seeded PRNG).
- v1.2 (orchestrator, Phase 2 kickoff): cross-system hooks
  - police exposes `sim.api.hitOfficer(sq, k, dmg, kind)` (combat calls it when a projectile or blast hits an officer). Officers get per-officer `hp` (Float32Array on the squad) and may be `down`.
  - police exposes `sim.api.arrestAgent(i)`, which sets act=ARRESTED. The agent is removed after being carried off. Leaders can be arrested: police sets `L.arrested = true` and emits 'arrest' {leader}. The leaders system skips arrested leaders (they don't move or attract followers).
  - riots exposes `sim.api.spawnRiot(x, y, n, opts)` returning a riot id, and `sim.api.spawnCrowd(x, y, n, leaderId)`. The day system calls these at day start using `data.riotSpawns` / `data.spawnPoints`.
  - combat exposes `sim.api.hitAgent(i, dmg, kind)`, which lowers hp; at or below 0 the agent becomes act=DOWN and emits 'injury'. Medics restore hp/DOWN agents through `sim.api.healAgent(i, amt)`.
  - day exposes `sim.api.dayInfo()` and `sim.paused`-style gating via `sim.day.phase`. Systems should go quiet (no new riots or looting) when the phase isn't 'day'/'dusk'.
  - Ownership in Phase 2:
    - crowd-AI agent: riots.js and crowd.js
    - police agent: police.js
    - combat agent: combat.js
    - day agent: day.js, leaders.js, ui.js and the HUD/overlay markup in index.html
    - FX agent (still running): render2d.js, fx2d.js and fxdemo.html
    - sim.js core: request small additions via the orchestrator, or make minimal, clearly marked additive edits
- v1.3 (orchestrator): **projectile `owner`: `'P'` = POLICE, `'C'` = CROWD/protesters.** fx2d already uses this. combat infers the side from `from` ({sq,k} = police, agent index = crowd) regardless. crowd/riots must pass 'C'; police must pass 'P'. combat.js does NOT write sim.day.stats (day.js counts events).
- v1.3 (crowd-AI agent: riots.js + crowd.js, all additive):
  - Per-agent arrays from riots (registered): `sim.aiX, aiY, aiV` (desired direction + speed the crowd uses while act is LOOT..MILL), `sim.thinkT` (decision timer), `sim.aiTk` (target kind of `tgt`: 0 none, 1 shop, 2 officer = squadIndex*1000+k, 3 agent, 4 prop), `sim.carry` (1 = carrying loot, 2 = carrying loot home), `sim.encT` (encourager aura timer). crowd adds `desX/desY` (internal).
  - Squads (written by crowd every substep): `sq.pressure` = smoothed line pressure in "pressing protester" units (sum of officer-contact reactions from agents on the squad's front side, m/s² / 6; compare with police's `sq.strength`), `sq.pressureRaw` (this substep, m/s²), `sq.opress[k]` (per officer, raw).
  - Shops gain `broken, smashed, looters, lastT, breakT, idx` (plus `ox, oy` from data). `looted` 0..1 grows per grab (1/(5·v)). Riots gain `n0, tx, ty, spread, state ('mill'|'march'), alive, conv (Map leader -> converted), convL`; `target` is `{x, y, kind:'shop'|'police'|'fire'|'square'|'spawn', ref}`.
  - Events: `'loot' {shop}` per grab (day counts these as `looted`), `'shatter' {shop, smash?}` once per shop break-in, `'barricade' {k}` when bloc dismantle a prop (prop.state = 'used'), `'brawl'` (rate-limited to ~6/s), `'riotJoined' {riot, leader, n}`.
  - `sim.crowdAI = { stats, histogram(), lootedShops(), localField, lfDir }` for debugging/HUD.
  - Leader `stance` scales follower aggression: peaceful = no loot/fight/throw, firm = 0.7, unleashed = 2.2.
- v1.4 (day agent: day.js, leaders.js, ui.js, HUD markup; additive):
  - sim.js (marked `// [day]`): `sim.onEvent(fn)` multi-subscriber event hook, called at emit time, returns an unsubscribe function; `drainEvents()` is unchanged. `sim.flushRemovals()` is exposed so the day system can clear agents between days while the sim is paused.
  - Day loop: `sim.day` (fields above). Campaign start replaces `sim.initScenario` (the legacy one is used in sandbox mode). The UI only calls `sim.advance` while the phase is 'day' or 'dusk'; the day system does nothing in 'briefing', 'summary' and 'ended'. Systems that want to react to a new day can listen for 'dayStart' / 'dayEnd' through `sim.onEvent`.
  - At day start: every agent is removed, riots (`sim.api.resetRiots?.()` if exposed, else `sim.riots.length = 0`), projectiles, fires and gas are cleared; burning props become 'burnt' and shops keep `looted`; all squads are removed and redeployed (`sim.api.deployPolice?.(n, toward, day)` if police exposes it, else 3 + (day - 1) squads, cap 9, via addSquad). Crowds spawn with `sim.api.spawnCrowd?.(x, y, n, leaderId)` (fallback spawnAround) and riots with `sim.api.spawnRiot?.(x, y, n, {day})` (riots per day 1,2,2,3,4,4,5; size × (1 + 0.1·(day-1)); half at 08:00, the rest between 10:30 and 15:00).
  - Dusk (18:00–20:00): agents increasingly decide to leave (rate 0.0004→0.0034 /s); a leaving agent gets `lead = riot = -1`, a held `panicT ≥ 1` with `fleeX/fleeY` along a BFS field to the map edge (slowed to ~1.4 m/s with extF), and is removed at the edge (`dispersedHome++`). Per-agent array `leaving` (Uint8) is registered. `sim.day.light` fades 1 → 0.3; the UI copies `1 - light` into `view.fx.night` when the view has it (unless `view.fx.nightOwned`).
  - Carry-over (placeholder until gauges): recruits = 100 + 0.3 × riotJoined members + 50 × day; tomorrow's crowd = clamp(round(0.55 × peak followers) + recruits, 0, 3500), split evenly across active leaders. Day 1 = 1000 marchers, 3 leaders. Each morning one leader is promoted if fewer than 2 are active.
  - Win: `sim.winner()` (overridden to skip arrested leaders). Lose: all leaders arrested and no promotion possible (after day 1 a leader is promoted only if the crowd was ≥ 150 at the last arrest; otherwise the day ends early as 'leaderless'); followers < 50 for 10 continuous sim-minutes during 'day'; day 7 ends.
  - Leaders: `L.stance` ('peaceful' | 'firm' | 'unleashed', no gauge effect yet; crowd AI reads it). Rally: followers within 40 m tighten (pull toward the leader for 6 s), panicking agents within 40 m calm (panicT = 0) and join; cooldown 60 s. Scatter: followers within 60 m panic outward for 3–7 s and drop their leader; cooldown 90 s. Arrested leaders don't move, can't be selected or ordered, and their followers are released each substep.
- v1.5 (orchestrator, Phase 3b resume): police contract + intent overlay
  - police APIs: `hitOfficer(sq|squadIndex, k, dmg, kind)`, `arrestAgent(i, by?)`, `arrestLeader(L|id)`, `deployPolice(n, toward, day)`, `policeOrder(sq, x, y, fx, fy, opts)`, `policeCharge(sq, dist)`, `policePush(sq, dist, to)`, `policeOp('kettle'|'funnel'|'split'|'cordon', {...})`, `policeInfo()`.
  - `sim.police = {escalation 0..4, heat, brutalityCount, counts{gas, lbd, flash, charges, warnings, arrests, leaderArrests, snatches, filtered, officersDown, lineBreaks, reinforcements}, ops, threats, hotspots, log, ...}`; `sim.snatchTeams = [{x, y, state:'dash'|'drag'|'return', target, n, sq}]`; squad fields `tactic, role, hp[k] (≤0 = down), na (active officers, 0..na-1; front row 0..nFront-1), nFront, load, strength`. Police read `sq.pressure × pressureScale(1.4)` against `strength = na × 3 × fatigue factor`.
  - Events: `warning {squad, n}`, `brutality {severity, kind}`, `officerDown`, `lineBroken`, `reinforcement`, `escalation {level}`, `kettle | funnel | split | cordon {phase, op}`.
  - **NEW, police intent (for the legend / intent overlay):**
    - `sim.police.plan = [{ id, kind:'block'|'cordon'|'kettle'|'funnel'|'split'|'perimeter'|'hunt'|'response'|'clear', x, y, r?, pts?:[[x, y], ...] (polyline, e.g. the cordon ring or the block line), squads:[squad ids], status:'planned'|'moving'|'active'|'closing'|'done' }]`
    - per squad `sq.dest = {x, y} | null` (where it's heading) and `sq.transit` (true while moving fast in vans)
    - `sim.police.predict = [{ leaderId|riotId, pts:[[x, y], ...] }]` (predicted crowd routes the commander is reacting to)
  - Ownership Phase 3b:
    - police agent: police.js
    - crowd agent: crowd.js, riots.js, leaders.js, combat.js, gas.js, day.js
    - UI agent: ui.js, render2d.js, fx2d.js, index.html, README.md
    - sim.js core: minimal marked additive edits only
- v1.6 (UI agent, recorded by orchestrator): render2d exports `PALETTE` and shared draw helpers. View API: `view.legendSwatch(ctx, key, w, h)`, `view.showIntent`, `view.placeName`. fx2d exports `FX_PALETTE`, `fx.legend`, `fx.drawTint()` and `fx.opts.tint`; the dusk tint applies to the map only, not to agents. The UI reads `sim.day.intensity`, `sim.police.escalation`, `sim.police.plan` (array, or the legacy object) and `predict`, `sq.dest`, `sq.transit`/`sq.van`, and `act` HOME / `sim.leaving` for leavers.
- v1.6 (crowd agent: crowd.js, riots.js, leaders.js, combat.js, gas.js, day.js; all additive):
  - **`sim.day.intensity`** (0..1): the chaos ramp. It is `INT_TOD(hour) × INT_DAY[day]`, with TOD `[8, .02] [10, .08] [11, .18] [13, .48] [15, .82] [16, 1] [17.5, 1] [18, .9] [20, .6]` and DAY `.32 .48 .62 .75 .87 .95 1` (day 1 peaks at 0.32; days 5–7 reach the maximum). It is 0 outside 'day'/'dusk' and 1 in sandbox. `sim.day.intensityOverride` (number or null) pins it. `sim.day.chaos` and `sim.chaos` remain as aliases. Riots scale loot, burn, throw and fight rates with it. In the campaign, bystanders don't loot or vandalise before 11:00. New APIs: `sim.api.intensityAt(day, hours)` and, for debug and tests, `sim.api.daySetDay(n, crowd?)` (briefing only).
  - `sim.leaving` (Uint8, registered; day.js) is now exposed. Dusk leavers have `act = ACT.HOME` (11) plus `leaving = 1`; they are never FLEE, so `sim.counts().leaving` and the HUD keep them out of "Fleeing".
  - Restless crowd (crowd.js). New registered per-agent arrays: `sim.wtX, wtY` (wander target), `sim.wT` (leg time left), `sim.wM` (leg mode: 0 none, 1 go, 2 pause, 3 walk back), `sim.rxn` (reaction lag to orders, 0.6–5 s), and `sim.lapL` (Int16, the leader a lapsed follower drifted away from, -1 for none). The crowd also has internal `wSp` and `pk` arrays.
    - Around a stopped or crawling leader (`arrived`, `L.slowT > 5 s`, or within the agent's `rxn` of `L.orderT`), followers walk legs: strolls ray-cast down streets, visits to a neighbour, curiosity trips, pauses, and walk-backs beyond the roam radius `30 + 1.8·√count` m.
    - A follower more than 70 m from its leader lapses after about 80 s (4× faster beyond 220 m), unless the leader is rallying or an encourager is near (`encT`). An encourager re-binds a lapsed follower to `lapL`.
    - Bystanders and lapsed agents roam the same way.
    - Optional hook: `L.cohesion` (default 1) scales the roam and lapse radii, for the future morale gauge.
  - Leaders: new fields `L.orderT` (sim time of the last order), `L.slowT` (seconds crawling under 0.15 m/s), `L.hx, L.hy` (heading; people in front of a moving leader step aside) and `L.dbg {fw, wait, gasSlow, near}`.
    - **Rally**: every follower walks back in and packs tight for 20 s (was 25 s); cooldown 45 s (was 60). Lapsed followers and panicking former followers within 150 m are re-bound, and 40% of bystanders within 27 m join. The `'rally'` event now carries `r`.
    - Leader wait rule: it only starts 12 s after an order, the factor is at least 0.65, and it is off in gas. Gas slow is 0.7 (was 0.55).
  - riots.js:
    - `sim.crowdAI` gains `hot` (loot hotspots `[{x, y, w, t, t0}]`), `hotNear(x, y, r)`, `curiosity(x, y, r, out)` → `{x, y, kind: 'fire'|'hot'|'police'|'shop'}`, and `navCacheSize()`.
    - New `sim.api.resetRiots()`, used by the day reset.
    - Squads gain `sq.brawlers` (protesters brawling with the squad, recounted every substep), plus `sq.fightTok` and `sq.fightTokT` (the brawl limiter).
    - Riot members roam while milling: within 1.8 × spread, with curiosity trips, walking back beyond 2.6 × spread.
    - Bloc, looters, medics and throwers path around corners with cached local flow fields (`localField(x0, y0, tx, ty, margin)`).
    - New registered arrays: `aggT`, `nThrow`, `navT`, `navM`.
  - gas.js: a canister landing makes people within 9 m scatter (chance 0.85 × falloff, pacifists × 0.4) for 4–9 s. In crowd.js, the cloud panics agents above 0.18 (was 0.4), for 6–14 s.
  - sim.js `// [crowd]`: the spatial hash has `HSIZE = 1 << 15` buckets (was `1 << 17`); `hkey` is unchanged.
- v1.6 (police agent: police.js only; no sim.js edits; additive and backward compatible):
  - Global coordination layer. Every 12 s, or after at least 6 s on an urgent event such as a leader's new order, an officer down, a broken line, an escalation or a fire, the police rebuild a world model and re-plan.
  - `sim.police.plan` is always an array of `{ id, kind, x, y, r?, pts, squads:[ids], status, target?, score?, secondary?, filter?:[x,y], inside?, arrests?, filtered? }`. It is rebuilt every 1 s.
    - `kind` is one of `'perimeter' | 'block' | 'cordon' | 'kettle' | 'funnel' | 'split' | 'hunt' | 'response' | 'clear'`.
    - `status` is one of `'planned'` (wanted but no squad: a gap), `'moving'`, `'active'`, `'closing'` (a kettle, cordon or funnel draining through its filter exit) or `'done'` (kept for 15–20 s).
    - `pts`: block, perimeter and clear give the 2-point line across the street, which is the live squad line once deployed. Cordon, kettle and funnel give a ring at the current mean radius of the lines. Hunt gives a circle. Response gives a line from the approach point to the hotspot. Split gives a line across the march.
    - `target` is the group key: `'L<leaderId>'`, `'R<riotId>'`, `'C<n>'` for a loose cluster, or `'S<x>,<y>'` for a looting/fire hotspot.
    - `secondary: true` marks the screening blocks on streets parallel to the main block.
  - `sim.police.predict` is `[{ key, kind:'march'|'riot', leaderId?, riotId?, size, threat, pts:[[x,y],...] (≤120 points, ~30 m apart), eta (s to the gate, or null), toGoal }]`.
    - For a march, `pts` follows the leader's current order (`L.field`) and continues from its end to the gate along the goal flow field. A leader with no order gets the goal flow field from its position.
  - `sim.police.groups` (debug) holds the whole world model, including `kind:'loose'` clusters of stragglers and unaffiliated offenders. Each group has `route`, `v`, `heading`, `dG`, `spread`, `aggr` and `cx/cy`.
  - Other new `sim.police` fields:
    - `timeline` holds one entry per plan-op status change: `{t, id, kind, status, squads, target}`.
    - `gaps` and `lastGaps` record jobs that couldn't be staffed: `{t, kind, key, target, why:'no squad'|'late'|'unreachable'|'not enough squads in reach'}`.
    - `warnAreas` lists the area sommation records.
    - `blockMem` stores the block point per march.
    - `prof` holds per-phase ms totals; divide by `msSteps`.
  - New `counts`: `vanTrips, plans, retasks, blocks, kettles, cordons, funnels, splits, hunts, huntArrests, gaps`.
  - Squad fields:
    - `sq.dest = {x, y, ...} | null` is unchanged, plus the internal fields `fx, fy, then, ...`.
    - `sq.transit` (boolean) is the same as `sq.van` and means riding in vans at 6.5 m/s.
    - Other new fields: `sq.hunt` and `sq.parentId` (detached hunt team of 8 officers that rejoins its parent), `sq.planId` (id of its plan entry, or 0), `sq.role` (`'perimeter'|'block'|'response'|'hunt'|'clear'|'reserve'|'relief'|'op'`), `sq.watch` (the march a block line is waiting for) and `sq.slotKey`.
    - Hunt teams are real entries in `sim.squads`. They appear and disappear as squads split and merge, but the total officer count is unchanged.
  - Vans: a squad rides when its trip is over 80 m and fewer than 8 protesters are within 60 m. It dismounts 40 m from the destination or when 14 or more protesters are within 28 m, and re-mounts when the street clears. Long trips use an A* path ("path field"); local fields are bounded box fields. Police no longer compute full-map fields at run time; the only one left is the goal field at init.
  - Sommations: 2 warnings 6 s apart per area (160 m radius), valid for 1 h. Force is allowed from escalation 1 once an area is warned (it was escalation 2).
  - Escalation floors from march path distance to the gate: under 1500 m gives 2, under 700 m gives 3, under 200 m gives 3.5. Riots of 50 or more give 2. The heat cap is 1.0 level per 10 min (was 0.6), and heat decays one level per 40 min.
  - `policeOp('cordon', {x, y, r, squads})` was added; a cordon is a kettle-type encirclement of a whole area. `policeInfo()` also returns `plan`, `predict`, `gaps` and `ms`.
  - Events: `'kettle'` / `'cordon'` / `'funnel'` / `'split'` `{phase:'deploy'|'closed'|'end', op}`. `'dismount' {squad}`. `brutality` is emitted as before, whenever force is used on a non-offender (baton, LBD, flashbang or arrest).
- v1.7 (balance round: tools/bot.js, tools/playtest.mjs; edits in sim.js, police.js, crowd.js, riots.js, leaders.js, day.js, render2d.js; all additive):
  - **sim.js**: `createSim(data, opts?)`. `opts.navRaster` (Uint8Array COLS×ROWS, a dump of `sim.walk`) replaces the canvas rasteriser, so the sim runs in Node. `data/nav-paris-small.bin` is that dump (`node playtest/dumpnav.mjs [small|full]`); `tools/nodesim.mjs` exports `makeSim(map, seed)`. The browser path is unchanged.
  - **Police intelligence (guess-only, user feedback)**: police no longer read `L.field` / orders. `sim.police.tracks` (Map `'L<id>'` → `{s:[{t,x,y}], w, top, hx, hy, v}`) samples leader positions every 5 s. The heading is the displacement over the last 120 s (60 s at escalation ≥ 3: the helicopter). Destinations are the gate plus landmarks (Concorde, Madeleine, Opéra, Tuileries, Palais-Royal, Louvre, Pont Neuf, Châtelet, Hôtel de Ville, Notre-Dame), scored by consistency with the observed movement × a prior (gate 0.4) and smoothed between intel ticks. **`sim.police.predict` entries gain `conf` (0..1), `dest` (`'gate'` or a landmark key) and `rank` (0 = the hypothesis the planner acts on); a march has up to 3 entries with the same `key`.** Riots have one entry with `conf: 1`. A change of favourite counts as a visible turn and forces a re-plan (`counts.intelTurns`). Splits use the observed heading.
  - **Line arrests** (user feedback): `lineGrab(sq)`. An isolated protester (≤ 1 other within 4 m) within 3 m of an officer is arrested by the line itself: fleeing or offending people from escalation 1, anyone isolated at 4, an exposed leader (fewer than 5 own followers within 8 m) from 2. One grab per 7–14 s per front section of 8 officers. Counted in `counts.lineArrests`; it emits `'arrest'` as usual.
  - **Brutality = incidents**: `'brutality' {severity, kind, n, d}` now fires once per incident. Only an injury (the victim goes DOWN), an arrest or a direct LBD hit on a non-offender counts. Victims within 35 m and 20 s merge, and the event is emitted when the incident closes. Severity is the sum of victim weights (rando 1, pacifist 2, encourager 1, medic 3, black bloc 0, +2 for an injury; peaceful leader arrest 5). `d` is the share of offenders within 15 m. `police.brutalityCount` counts incidents.
  - **Gate guard**: squads with `sq.gate = true`, `sq.gatePost`, `role 'gate'`, `tactic 'gate'`, `manual: true`, one on every street of a 65 m ring around the gate. They are deployed by `deployPolice` / `sim.api.deployGate()`, never re-tasked, relieved, charged or pushed, and have ×1.8 strength. Overwhelmed for 8 s, a gate line is **breached**: `sq.breachT` (40 s) opens a gap `sq.gap` ≤ 6 m, and it emits `'gateBreach' {squad}` and `counts.gateBreaches`. The planner perimeter (`PERIM_R`) moved out to 110 m.
  - Squads: `sq.gasStock` (40 canisters, restocked at rest / in reserve / each morning), `sq.grabCd`, `sq.huntCool` (a swamped hunt team withdraws to its parent instead of holding), `sq.brokeT`. `lineBroken` fires at most once a minute per squad (heat 0.2, was 0.3). The heat window is 0.7 per 10 min (was 1.0). A `brawl` gives 0.003 heat (was 0.01). Gas volleys need escalation ≥ 2 (or the squad attacked) and a hostile or advancing crowd. Stray snatches start at escalation 3 (was 2), and hunts only target loose clusters with offenders, or any cluster at escalation ≥ 3. Proximity escalation floors are softer on day 1 (−1) and day 2 (−0.5). New counts: `gateBreaches, intelTurns, lineArrests`.
  - **Leaders**: `L.pressing` (held `LINE_KEEP` 5 m short of a line in front, not "stalled"), `L.gasEsc` (in gas > 0.5 the leader steps out toward the clearest walkable direction, `L.gasDx/gasDy`), `L.dbg.held`. The crowd wait rule is stronger: grace 6 s (was 12), minimum factor 0.2 (was 0.65), radius 12 m.
  - **Crowd**: non-pushers stop 1.6 m short of a police line in front of them (slowing from 4 m; a breach / filter gap lets them through). The neighbour loop reads a bucket-ordered snapshot (`sX/sY/sVX/sVY/sL`, internal).
  - **Riots**: brawl tokens refill at `(0.06 + 0.94·intensity) / 45 s` per squad (was a flat 1 / 20 s), max 1 brawler below intensity 0.45.
  - **Day (objective hook, not used yet)**: `sim.api.addObjective({id, title?, day?, check(sim, D, dt) → 'done'|'failed'|undefined, persist?})`. Checks run once per sim-second in 'day'/'dusk' until settled, emitting `'objective' {id, status}`. `D.objectives` holds the list (cleared at each briefing unless `persist`), and the results go to `D.stats.objectives` and the history. `stats` gains `objectives: []`.
  - Bot hook: `createBot(sim, strategy, {seed, target(sim, L)})`. `target` overrides a leader's routing target (for intermediate objectives).
- v1.8 (balance round "leader survival": crowd.js, leaders.js, police.js, day.js, riots.js, tools/bot.js, tools/playtest.mjs, new tools/ckpt.mjs; sim.js one marked line; all additive):
  - **Protective core (crowd.js)**: a share of each march, `L.coreShare = max(0.2, 20 / count)` (× `1 / L.cohesion`, clamped 0.5–1.5), is its core (per-agent draw `sim.coreU`, registered). Core radius `L.coreR = min(14, 6 + 0.3·√count)` m. Around a stopped leader the core shuffles and pauses inside the radius instead of roaming; beyond it, it walks back along a shared local rejoin field (`localField`, box ±40 cells, ≤ 2 new fields per substep, refreshed every 2.5 s or 5 m). On the march, core members behind the leader speed up. Core members react at once to orders (0.25 × `rxn`), are gas-panicked 0.1× as often, lean out of gas at half weight, and panic wears off 2.5× faster. riots.js: a core member outside the radius drops autonomous actions. Restless roaming and lapsing are unchanged for everyone else.
  - **Leaders (leaders.js)**: the wait rule waits for 10 own followers within 12 m (was 5), with a squared factor and minimum 0.06 (was 0.2). Gas reflex threshold 0.25 (was 0.5). **Scatter spares the core.** Gate barrier: a leader can't cross an unbreached gate line (0.4 m behind its front, within its width + 3 m), even when shoved by a passing squad.
  - **Police leader exposure (police.js)**: `L.pexp = {t, own, ready, mult, exposed, kettled, chargeT}`, updated every 0.5 s. A leader is exposed while it has fewer than 8 own non-panicking followers within 15 m and fewer than 12 people within 5 m. Exposure grows at a rate of stance (peaceful 0.4, firm 1, unleashed 2.5) × gate distance (<300 m 3, <700 m 1.8, <1500 m 1, else 0.5) × small march (<120: 2) × escalation 4 (1.25) × kettled (closed or draining op: 1.5) × charged in the last 20 s (2), capped at 6, × day (0.25, 0.4, 0.7, then 1). Otherwise it drains 2× faster. `ready` = exposure ≥ 60 and escalation ≥ 3 (≥ 2 when unleashed or within 700 m of the gate). Snatch teams, hunts and line grabs only take a ready, still-exposed leader, and a snatch dash pulls out if the core closes around the leader. `'arrest'` for a leader gains `by` ('snatch' | 'hunt' | 'line' | 'api'), `own` and `expMult`.
  - **Custody (police.js)**: ordinary arrests (line grabs, offender and stray snatches, kettle-filter arrests; not leaders) need capacity. Each squad can make 3 per 10 min (`sq.cust`). The force holds at most 25 at once (`police.custPool`), refilled at 15 + 4 × day per hour.
  - **Gate (police.js, crowd.js, day.js)**: gate strength × `[2.2, 2.0, 1.85, 1.8, …][day]` × (1 + 0.8 × (1 − intensity)). Gate lines never yield ground (v1.7 gave ground to 46 m, where the streets open into the square). No breach while intensity < 0.35. After a breach closes, the line is re-armed (+25 energy) and can't be breached again for 120 s, and the gate guard is never relieved. Crowd hard constraint: nobody crosses an unbreached gate line plane. **Win rule**: the holding leader also needs ≥ 150 own followers within GOAL_R + 20 m (v1.7 counted followers anywhere).
  - **Day (day.js)**: each morning there are enough leaders for tomorrow's crowd (2 from 300, 3 from 1400). One mid-day successor per day steps up 45 s after the last active leader's arrest if ≥ 60 loose protesters are within 90 m: at the densest knot ≥ 12 m from officers and ≥ 90 m from the gate, binding 85% of loose people within 60 m (`L.successor`, `'succession' {phase:'pending'}`, `'promoted' {successor:true, n}`). A march that collapses (< 50 followers for 10 min) with a leader still free ends the day as `'dispersed'` (campaign loss only on day 7). Carry-over: 0.65 × peak + 0.35 × followers at dusk (`carry.held`) + recruits 100 + 0.3 × riotJoined + 60 × day (was 0.55 × peak, 50 × day).
  - **police.js misc**: `dayStart` also runs on the `'dayStart'` event, once per day (`police.dayDone`).
  - **Tools**: `tools/playtest.mjs --untilHour H` (debug) and `--chunkMin M`. With `--chunkMin`, workers checkpoint after M wall minutes to `<out>/<job>.ckpt.json` and resume on the next call, finished jobs are skipped, and the run prints `ALL DONE` when nothing is left. `tools/ckpt.mjs` `saveSim/loadSim` is approximate: exact agent arrays, day, leaders, riots, fires, gas, shops and police state; squads come back untasked; ops, snatch teams and hunt detachments are dropped; arrestees are removed; RNGs are reseeded. `sim.agentArrays` is exposed (sim.js, marked). Bot / logger `save()`/`load()`, `bot.reseed(n)`. Logger leader arrests gain `by, expMult, kettled, successor`; day stats gain `leaders0, successors, held, leaderArrests`. Debug scripts: `playtest/{sumarr,metrics,coredbg,coretrace,losstrace,gatedbg3,ringdbg}.mjs`.
