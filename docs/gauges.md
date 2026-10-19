# Gauges, classes and the 7-day arc (design v1)

Design only. Nothing here is code. It builds on `docs/contract.md` (the sim architecture) and
`docs/police-tactics.md` (cited as **[PT §x]**). Where the current `src/sim.js` already has a
mechanic, this doc names the variable it extends: `panicT`, `aggr`, `L.energy`, `sq.energy`,
`makePanic`, the `stepAgents` neighbour loop, the gas grid `gS`, and `WIN_COUNT`.

Units: per-agent gauges are floats from 0 to 1 internally and are shown as 0–100. Rates are per
**sim-second**. A playable day is about 4 sim-hours (14,400 s) of action, played at 15× by default.

---

## 1. Design pillars

1. **Every gauge is a lever, not a meter.** Each gauge the HUD shows has at least one player verb
   that moves it directly (a stance, an order, a night action). If a gauge can't be pulled, it isn't on
   the HUD; it shows up in the world (tint, icons) instead.
2. **Four numbers, one story.** The player reads four things: **Support** (global), and for the
   selected crowd **Morale**, **Heat** and **Fatigue**. Everything else (police nerve, climate,
   leader notoriety) is either visible on the map or explained in the event ticker.
3. **You lead people, you don't drive units.** Crowds are autonomous. The player sets *where* and
   *how hot*, and the crowd decides the rest. Control comes from predictable rules: the same
   situation always makes the same kind of crowd reaction.
4. **Every gain is paid for somewhere else.** Looting buys morale with Support. Brutality buys
   Support with morale and leaders. Speed costs fatigue. Heat breaks police lines and invites
   escalation. No action is free, and no gauge is maximised by doing one thing.
5. **Chaos is a resource, not just a threat.** Uncontrolled riots drain police and spread heat. The
   player can feed off them, capture them, or let them burn and pay the opinion bill.

---

## 2. The gauge set

### 2.1 Naming the "angry" gauge: **Heat**

Candidates: Rage, Fury, Colère, Anger, Heat. We pick **Heat**:
- It reads as a temperature, which is exactly how the sim treats it: it **diffuses between
  neighbours like heat** (§4), and it tints the crowd red. The metaphor *is* the mechanic.
- It is two-sided. Heat is not just bad: ESIM says shared grievance makes a crowd *empowered* and
  cohesive [PT §4.5]. A hot crowd pushes police lines back, ignores gas longer and re-forms after a
  charge. "Rage" and "Fury" only sound destructive.
- The verbs are natural: *heat up*, *cool down*, *the street is hot*. The player can say "Calm"
  and "Rally" without a glossary.
- The French build can label it **Colère** ("la colère monte"), which keeps the flavour.

### 2.2 Overview

| Gauge | Scope | Range | Start | Shown as |
|---|---|---|---|---|
| **Morale** | per agent (`mor`), aggregated per leader's crowd | 0–1 | 0.60 | HUD bar for the selected crowd; crowd brightness |
| **Heat** | per agent (`heat`, replaces `aggr`), aggregated per crowd and per riot | 0–1 | 0.20 (randos) | HUD bar; red tint |
| **Fatigue** | per agent (`fat`); per leader (`L.energy`, existing); per squad (`sq.energy`, existing) | 0–1 | 0.05 carry-over | HUD bar; slower walk animation |
| **Support** | global | 0–100 | 45 | big top bar |
| **Mandate** | global, police side | 0–100 | 50 | thin bar under Support, police colour |
| **Escalation** | global, police side | level 0–4 | 1 | five pips, icon per level |
| **Nerve** | per squad | 0–1 | 1.0 | shield icon cracking over the squad |
| **Notoriety** | per leader | 0–100 | 10 | "wanted" ring on the leader portrait |
| **Climate** | global, slow (moves overnight only) | −1 to +1 | 0 (scenario) | the newspaper headline at the night screen |

Support and Mandate form a 2×2 that the player learns in one sentence:
**Support is whether France backs you. Mandate is whether France lets the police hit you.**
Looting and fires: Support down, Mandate up. Brutality: Support up, Mandate down.

### 2.3 Morale (per agent)

What it is: confidence that the march is winning and safe to stay in.

| Raises | Amount |
|---|---|
| Near own leader (≤ 12 m), leader not fleeing | toward 0.80 at +0.004/s |
| Encourager neighbour | weighted neighbour average (§4, weight 3, emits 0.90) |
| Positive wave (Rally, line pushed back, riot captured, reached rally point) | see §4.3 |
| Looting (self) | +0.20 once; +0.3 cheer wave at the shop |
| Big crowd around (local density 1–2.5 p/m²) | +0.001/s ("we are many") |

| Lowers | Amount |
|---|---|
| Gas exposure | −0.25 × g per s (g = local gas concentration `gS`) |
| Negative wave (gas landing, charge, arrest, injury witnessed) | see §4.3 |
| Fleeing neighbours | contagion (§4.4) |
| Fatigue | −0.01 × fat per s |
| Own leader arrested | −0.35 to all followers at once, and the crowd is leaderless |
| Crush (density > 4 p/m²) | −0.02/s [PT §4.1, LoS F] |

Decay: toward the crowd baseline 0.50 with τ = 1200 s (20 min). Leaderless agents decay toward 0.35.

Behaviour mapping:
- **Speed**: `v_eff = v0 × (0.70 + 0.40·mor) × (1 − 0.40·fat) × (1 + 0.15·heat)`.
- **Cohesion**: the attach radius in the current leader check (`25 + 1.5·√count`) is multiplied by
  `(0.6 + 0.8·mor)`. Below mor 0.25 an agent drifts off its leader at `0.02·(1 − mor)` per s.
- **Flee threshold**: the gas panic chance (`dt·g·0.9` today) and charge panic chance (`dt·0.5`)
  are multiplied by `(1.4 − mor)`. A 0.9-morale crowd panics at half the rate of a 0.4 crowd.
- **Regroup**: after `panicT` runs out, the chance of going home (`GO_HOME = 0.25`) becomes
  `0.25 × (1.6 − mor) × (0.5 + fat)`. High-morale people come back; tired, scared people leave.
- **Recruitment**: bystanders within `R_rec = 15 m × (0.5 + mor)` of a following agent join at
  `0.02/s × (Support/50)`. Good morale literally widens the net.

### 2.4 Heat (per agent)

What it is: readiness to confront. It is fuelled by injustice and by contact.

| Raises | Amount |
|---|---|
| Witnessed brutality (§2.6) or negative wave while mor > 0.5 | wave converts to Heat, not fear (§4.3, the ESIM rule) |
| Gas exposure | +0.05 × g per s (ESIM: gas = anger +6 [PT §4.3]) |
| Police line contact (front row) | +0.01/s ("+1/min in contact" [PT §4.3]) |
| Kettled (no exit in field) | +0.008/s (cohesion +10 [PT §2.4]) |
| Black bloc neighbour | weighted average, emits 0.85 |
| Leader stance *Unleashed* | +0.003/s in the leader's crowd |

| Lowers | Amount |
|---|---|
| Looting or smashing (catharsis) | −0.15 once |
| Pacifist neighbour | weighted average, emits 0.05 |
| Leader *Calm* order | −0.25 in 15 m, then crowd cools faster for 60 s |
| Leader stance *Peaceful* | decay doubles |

Decay: toward the class baseline (rando 0.20, bloc 0.60, pacifist 0.05) with τ = 600 s.

Behaviour mapping:
- **Push force (shove)**: an agent with heat > 0.55 adds a shove to neighbours in front of it
  (along its desired direction, within 1 m): `extF_j += SHOVE × heat_i × (1 − fat_i)`, SHOVE = 3 m/s².
  Its own social-force amplitude `SF_A` is scaled by `(1 − 0.4·heat)`, so it squeezes through. Hot
  agents migrate to the front by themselves, which is the visible "angry people push others".
- **Line pressure**: a crowd pushes a police line back (§2.7). Pressure from the front 7 m is
  `P = Σ heat × (1 − fat)`.
- **Loot chance** within 8 m of an unlooted shop: `p = 0.05/s × heat² × stanceMult × classMult`.
- **Fight/throw chance** within 25 m of police: `p = 0.06/s × max(0, heat − 0.5) × stanceMult × classMult`.
- **Gas resistance**: the chance to re-form after gas (with a leader) is `0.3 + 0.6·heat` [PT §4.4,
  "anger > 50 re-form"].
- **Arrest risk**: an agent that loots, throws or fights gets an `offence` flag for 30 s. Snatch squads
  only target flagged agents at Escalation ≤ 2; from level 3 they also target anyone with heat > 0.7.

### 2.5 Fatigue

**Per agent (`fat`)**:
- +4e-5/s walking (≈ +0.58 over a 4 h day), +1.5e-5/s standing, +1e-4/s running/fleeing,
  +0.02 per shove given, +0.05 per gassing.
- −3e-5/s when standing still near a medic.
- Overnight: `fat = max(0.10 × daysEngaged, fat × 0.35)`. That is the residual-fatigue floor
  idea from police units [PT §1.5], applied to protesters.
- Effects: speed (above), shove strength, arrest risk ×(1 + fat) (tired people can't run),
  retention overnight (§8).

**Per leader (`L.energy`, existing)**: already drains with movement and crowd size and recovers
when stopped. Rally and Calm cost energy (§6). At 0 energy a leader can't use orders and walks at 35%.

**Per squad (`sq.energy`, existing)**: keep the existing costs (charge −9, gas volley −3, regen
0.04/s). Add −0.5/s while the line is under pressure P > R and −2 per projectile hit. Below 40 the
squad speed and line strength fall, and it can't charge below 25 (already the case). Below 15 the AI
must rotate it out [PT §1.5, "above 85 must be relieved"].

### 2.6 Support (global, the public opinion)

What it is: how much of France backs the movement. It sets tomorrow's turnout and the police AI's
caution (λ in [PT §6.3]).

Event deltas (all multiplied by **media presence M**, see below):

| Event | Support Δ | Mandate Δ |
|---|---|---|
| Shop looted (value v = 1..3) | −1.0 × v × (1 − 0.6·max(0, Climate)) | +0.8 × v |
| "Symbol" looted (bank, luxury boutique) when Climate > 0.4 | +0.5 × v × (Climate − 0.4) / 0.6 | +0.5 × v |
| Fire started (car, bin) | −0.5 | +0.5 |
| Officer injured by a protester | −2 | +3 |
| Brutality incident (below) | +B × severity × (1 − d)² × fade | −1.5 × severity × (1 − d) |
| Discriminate arrest of an offender | −0.2 | +0.5 |
| Peaceful hour (no offences in a crowd > 500) | +0.5 per sim-hour | −0.3 |
| Crowd > 2,000 marching | +0.3 per sim-hour (visibility) | 0 |
| Uncontrolled riot looting | 50% of the normal cost ("casseurs, not protesters") | full |

**Brutality incident.** It fires when police force (charge contact, baton, LBD, gas inside 5 m)
injures or arrests an agent **without** an `offence` flag.
- `severity` = sum of victim weights: rando 1, pacifist 2, medic 3, streamer 2, black bloc 0,
  leader 3, plus +2 for any injury (`hp → 0`).
- `d` (discrimination, from [PT §4.5]) = the share of agents within 15 m who had an `offence` flag.
  A clean crowd gives d ≈ 0 and full outrage; a crowd throwing rocks gives d ≈ 0.6 and almost none.
- `fade` = 0.6^(incidents earlier today). This is outrage fatigue: the fifth incident of the day barely
  makes the news.
- `B` = 1.5.

**Media presence M** = `0.4 + 0.15 × streamers within 40 m (max 3) + 0.2 if Day ≥ 5`, capped at 1.2.
It multiplies Support and Mandate deltas from events. Bad things on camera cost more, and so do good
things.

Drift: overnight, Support moves 25% of the way toward `45 + 20 × Climate`. There is no drift during
the day, so every change is caused by something on screen and named in the ticker.

### 2.7 Police-side gauges

**Mandate (0–100, global).** This is the political room for force. It sets the **Escalation ceiling**:
`ceiling = floor(Mandate / 22)`, giving level 0 below 22 and level 4 at 88. Mandate also scales the
legitimacy-cost term of the police AI: `λ = 1.5 − Mandate / 100` [PT §6.3]. With low Mandate the
police are careful and favour liaison and snatch. With high Mandate they gas and kettle.

**Escalation (0–4, global).** It follows the ladder in [PT §3.2]. The current level moves toward
`min(ceiling, threatLevel)`, at most one level per 20 sim-minutes, where `threatLevel` comes from
violence events and crowd proximity to the 8th arrondissement. Each level unlocks police tactics
[PT §3.2] and changes snatch targeting (§2.4). Level ≥ 3 makes Notoriety matter (snatch squads hunt
leaders).

**Nerve (0–1, per squad).** This is police morale.
- Lowered by projectile hits (−0.04), fire within 15 m (−0.01/s), being outnumbered at the front
  (`front > 3 × n`: −0.01/s), and line pushed back (−0.1 per metre).
- Raised by an adjacent squad within 30 m (+0.005/s), and recovers +0.002/s at rest.
- **Line resistance** `R = n × (0.4 + 0.6·energy/100) × (0.5 + 0.5·nerve) × 1.2`. If the crowd's front
  pressure P > R, the line gives ground at `0.25 × min(1, P/R − 1)` m/s. If it gives 6 m, the line
  **breaks**: the squad retreats and the crowd gets a +0.7 cheer wave.
- **Unauthorised force**: per contact-second, `p = 0.0004 × (1 − energy/100)/0.5 × (1 − nerve)/0.5 ×
  meanFrontHeat/0.5` [PT §4.5 formula, per minute → per second]. When it fires, the squad charges
  indiscriminately, which usually produces a brutality incident. **Tired, frightened police make
  mistakes.** The player can engineer this cleanly by keeping pacifists in long contact with the line.

**Notoriety (0–100, per leader).**
- Raised by +2 per offence within 15 m of the leader, +5 per riot captured, +0.5 per sim-minute
  within 30 m of police at Escalation ≥ 2.
- Lowered by −30 overnight, and by −10 per Calm order.
- From Escalation 3, the snatch-target score of a leader is `Notoriety × (1 − localDensity/2)`. A
  leader deep in a dense, calm crowd is safe; a notorious leader at the thin edge of a hot riot is not.

### 2.8 Climate (global, slow): it earns its place

Climate answers the user's point that violence can sometimes *raise* support. It is a single
number from −1 (**"Order"**: the public wants calm and believes the police) to +1 (**"Revolt"**: the
public is furious with the government). It **changes only overnight**, so it never adds noise to a
day. It reshapes which strategies pay over the week:

- Looting cost is multiplied by `(1 − 0.6·max(0, C))`. Symbol looting turns *positive* above C = 0.4.
- Brutality gain is multiplied by `(0.7 + 0.3·C)`. In an Order climate, people half-believe the police.
- Recruit mix: high C brings more black bloc; low C brings more pacifists and randos (§8).
- The Support drift target is `45 + 20·C`.

Overnight update:
`C += 0.08 × cleanIncidentsToday − 0.05 × daysWithMoreThan10Lootings + scriptedEvent(day)`, clamped
to [−1, +1]. Scripted events come from the scenario: "Pension reform passed by decree: +0.3",
"Teacher injured on camera: +0.2", "Shops burnt on the Champs: −0.2" [PT §3.4, weekly shape].

Readability: Climate is shown only on the night screen, as a newspaper headline and a dial with one
line of consequences ("Revolt climate: attacks on banks no longer hurt your support").

---

## 3. The interaction loop

```
                       (+) recruits overnight
             ┌──────────────────────────────────────────────┐
             │                                              │
          SUPPORT ◄──(−)── looting / fires ──(+)──► MANDATE │
             ▲                  ▲     │                │    │
             │(+) brutality     │     │(+) MORALE now  │(+) │
             │    (×(1−d)²·fade)│     ▼                ▼    │
             │              HEAT ──► loot/throw    ESCALATION
             │               ▲  ▲      │               │    │
             │   (+) ESIM    │  │      │ offences      │ gas, charge,
             │   if mor>0.5  │  │      ▼ (d rises,     │ snatch, kettle
             │               │  │   incidents get      ▼    │
          BRUTALITY ◄────────┘  │   "dirty")        POLICE FORCE
          INCIDENT ◄── unauthorised force ◄── NERVE↓ + SQUAD FATIGUE↑
             │                  │                     ▲
             │(−) MORALE        │(+) line contact,    │ line pressure P = Σheat·(1−fat)
             │  if mor<0.5:     │    gas              │
             ▼  fear wave       │                     │
          PANIC / GO HOME ──► crowd shrinks ──► smaller turnout tomorrow
             ▲
          FATIGUE ──(−) speed, retention, arrest risk
```

The key trade-offs (the decisions):

1. **Loot now, starve tomorrow.** Unleashing a crowd on a shopping street gives a big morale pulse
   (cheer waves, catharsis cools heat, and a demoralised crowd is rescued) but costs about 2 Support per
   shop and raises Mandate. That means fewer recruits tomorrow and more gas the day after. Looting is
   the right call when a crowd is about to collapse, or in a Revolt climate on banks.
2. **Hot breaks lines; hot invites the hammer.** Heat is the only way to push through a cordon
   (P > R). But hot crowds commit offences, which raises Mandate and Escalation and makes any later
   brutality "dirty" (high d).
3. **The martyr play (the perverse incentive), and why it isn't degenerate.** Provoking brutality is a
   legitimate strategy (civil disobedience), but it is bounded six ways:
   - **Clean or nothing.** The gain scales with `(1 − d)²`. Using black bloc to provoke makes d high,
     so a provocation earns Mandate for the police instead.
   - **Outrage fatigue.** ×0.6 per incident each day, so one or two incidents a day is the useful dose.
   - **The victims are yours.** Each incident sends a negative wave through your crowd. Low-morale
     crowds panic and go home, and medics and pacifists get arrested.
   - **Leaders burn.** Notoriety rises near incidents. At Escalation 3+ leaders get snatched, and losing
     all leaders is a loss.
   - **Heat runaway.** Incidents heat high-morale crowds (ESIM). Hot crowds start throwing, which makes
     the next incident dirty. The strategy limits itself unless the player actively Calms.
   - **Support only pays overnight.** Brutality never moves anyone closer to the Élysée today. It
     buys bodies tomorrow, and the week is finite.

   The skill in the martyr play is to keep the crowd *clean and brave*: pacifists in front, streamers
   nearby, medics behind, bloc held back, and Calm used right after the incident to stop the heat spiral.
4. **Fast or fresh.** Pushing a big crowd hard (bigger crowds are slower: `1.45/√(1 + count/300)`
   already) burns leader energy and agent fatigue. A tired crowd reaches the Élysée gate and can't push
   the final cordon.
5. **Capture the riot or let it burn.** Capturing gives instant bodies and heat but transfers the riot's
   opinion cost to you at 100% and raises Notoriety. Leaving it pulls police squads away but costs 50%
   Support per looting and pushes Mandate up.

---

## 4. Propagation model (contagion inside a crowd)

Three mechanisms at three scales:
- **Diffusion**: local smoothing, 1–3 m, seconds. Neighbours converge.
- **Waves**: events that travel through the crowd at 4–8 m/s and cross a 60 m crowd in about 10 s.
  This is the visible front-to-back ripple.
- **Auras**: leaders, encouragers and pacifists set a crowd-wide baseline.

Diffusion alone is too slow for long range: a 50 m crowd takes about L²/(K·h²) ≈ 2,500/0.2 ≈ 3.5 h to
equalise. That is why waves exist, and it is also why a crowd can hold two moods at once: a hot,
gassed front and a cheerful back.

### 4.1 Data (per agent, all registered with `sim.registerAgentArray`)

| Array | Type | Meaning |
|---|---|---|
| `mor`, `heat`, `fat` | Float32 | the gauges |
| `wv` | Float32 | current wave value, signed (−1 fear .. +1 cheer) |
| `wcd` | Float32 | wave refractory timer (s) |
| `off` | Float32 | offence timer (s), 0 = clean |
| scratch `nbM`, `nbH`, `nbW`, `nbF`, `nbN` | Float32 / Uint8 | neighbour sums written by the crowd loop. Not registered: they are rewritten every substep before use. |

### 4.2 Accumulate in the existing neighbour loop

The `stepAgents` loop already visits every j with `d < 2` and counts `nn` for `d < 1.5`. Inside the
`d < 1.5` branch, add:
```
w = CLASS_W[cls[j]]                 # rando 1, encourager 3, pacifist 3, bloc 2, medic 1, streamer 1
nbN[i] += w
nbM[i] += w * (cls[j]==ENCOURAGER ? max(mor[j], 0.90) : mor[j])
nbH[i] += w * (cls[j]==PACIFIST ? min(heat[j], 0.05) : cls[j]==BLACKBLOC ? max(heat[j], 0.85) : heat[j])
if |wv[j]| > |nbW[i]|:  nbW[i] = wv[j]      # strongest wave around me
if panicT[j] > 0:       nbF[i] += 1
```
That adds no extra spatial queries, about 8 flops per pair.

### 4.3 Gauge pass (new `gauges` system after `crowd`, before deferred removals)

It runs every substep. The cost is O(N) with no neighbour queries.
```
if nbN > 0:
   aM = nbM/nbN ; aH = nbH/nbN
   k  = (aM < mor) ? K_M * NEG_BIAS : K_M              # bad news spreads faster
   mor  += dt * k   * (aM - mor)
   heat += dt * K_H * (aH - heat)
mor  += dt * (base_mor - mor) / TAU_M ;  heat += dt * (base_heat[cls] - heat) / TAU_H

# waves: relay one hop per substep with probability HOP_P
if wcd <= 0 and |nbW| > |wv| / R_i and rand() < HOP_P:
   R_i = nbW < 0 ? R_FEAR + R_SPAN*(1-mor) : R_CHEER + R_SPAN*mor   # scared people relay fear better
   wv  = nbW * R_i ; wcd = WCD
wcd -= dt ; wv *= exp(-dt / TAU_W)

# apply wave
if wv > 0.05:  mor += WAVE_K * wv * dt
if wv < -0.05:
   hit = WAVE_K * (-wv) * dt
   if mor > 0.5: heat += hit * HEAT_CONV            # ESIM: confident crowd turns injustice into anger
   mor  -= hit * (1 - 0.5*heat)                       # hot people shrug off fear a bit
   if mor < 0.25 and rand() < dt * 2*(-wv): makePanic(i, 6 + rand()*8, away-from-wave-source)

# fear contagion from fleeing neighbours
fF = nbF / max(1, nn)
if fF > 0.2 and panicT==0 and rand() < dt * PANIC_K * fF * (1-mor)^2: makePanic(i, 4 + rand()*6, avg flee dir)

clamp mor, heat to [0,1];  reset scratch
```
The refractory timer `wcd` stops echo. Without it, a neighbour's relayed copy (R·w) could bounce back
once my own value has decayed below it.

Wave direction emerges by itself. Events happen where police are, which is the front, so fear rolls
backward. Leaders walk at the head, so Rally cheer also rolls backward. Each hop multiplies by R ≈ 0.85,
so a strong wave (0.8) reaches about 15 hops, roughly 20–25 m. In a demoralised crowd R → 0.94 and
fear reaches 60 m: **panic spreads further through a weak crowd.** That is the tactile, readable lesson.

### 4.4 Wave sources

| Source | Initial `wv` | Radius |
|---|---|---|
| Gas canister lands | −0.8 | 8 m |
| Charge contact | −0.6 | officers' front 3 m |
| Arrest witnessed | −0.4 | 5 m |
| Injury (agent goes DOWN) | −0.5 | 6 m |
| Brutality incident | −0.7 | 10 m (converts to heat in confident crowds) |
| Flashbang / explosion | −0.9 | power-based |
| Leader **Rally** | +0.6 | 10 m around leader |
| Police line broken | +0.7 | crowd front 10 m |
| Reached ordered destination / rally point | +0.5 | leader 12 m |
| Riot captured | +0.5 | riot centre 15 m |
| Shop looted | +0.3 | 6 m |
| Encourager chant (every 8 s ± 2) | +0.3 | 4 m |

### 4.5 Parameters

| Param | Value | Notes |
|---|---|---|
| K_M | 0.20 /s | morale diffusion |
| NEG_BIAS | 1.6 | negativity bias: bad morale spreads 60% faster |
| K_H | 0.10 /s | heat diffuses slower and is stickier |
| TAU_M | 1200 s | morale relaxation to baseline (0.50 led, 0.35 leaderless) |
| TAU_H | 600 s | heat relaxation to class baseline |
| HOP_P | 0.5 | about 4–8 m/s wave speed at 0.12 s substeps |
| R_FEAR / R_CHEER / R_SPAN | 0.80 / 0.78 / 0.14 | relay factors |
| TAU_W | 0.5 s | local wave decay |
| WCD | 1.5 s | refractory |
| WAVE_K | 0.6 /s | wave impact (front −0.25 morale from a gas wave, rear about −0.05) |
| HEAT_CONV | 0.8 | share of a negative wave converted to heat when mor > 0.5 |
| PANIC_K | 1.2 /s | fear contagion |
| CLASS_W | rando 1, enc 3, pac 3, bloc 2, med 1, str 1 | neighbour weights |

Performance: 6 extra Float32 arrays × 16,000 agents = 384 KB. Work per pair is constant, so cost is
expected to stay within 10% of the current crowd step.

---

## 5. Classes

Six classes. That is the five requested plus **Streamer**, because it makes "where the cameras are"
a positional decision and drives media presence M. The contract's `cls` gets `5 STREAMER`.

| Class | Share (day 1) | Colour / icon | Base heat |
|---|---|---|---|
| Rando | 55% | leader colour, plain dot | 0.20 |
| Pacifist | 15% | sky blue, small white flag | 0.05 |
| Encourager | 8% | **yellow** (gilet jaune), megaphone | 0.30 |
| Medic | 5% | white, red cross | 0.10 |
| Black bloc | 10% | black, slightly larger dot | 0.60 |
| Streamer | 7% | magenta, phone glow pulse | 0.15 |

**Rando**: the mass.
- Behaviour: follows, loots if heat and stance allow, flees easily. It is the body count.
- Gauges: none of its own. It is the medium the other classes act on.
- Player: numbers win the Élysée (`WIN_COUNT`). They are also the first to go home.
- Counter: gas and charges scatter them. Encouragers keep them.

**Pacifist**: the conscience.
- Behaviour: never loots or throws. Under the *Calm* order, or when facing a police line, it walks to
  the front and **sits** (desired speed 0, high social-force mass), forming a soft wall. It doesn't flee
  charges (panic ×0.3) and gets arrested instead.
- Gauges: heat sink (weight 3, emits 0.05). Any force used on it is a high-severity brutality incident
  (weight 2). It keeps d low around it.
- Player: it keeps a crowd clean, cools runaway heat, and turns police contact into Support. It also
  ties up squads (long contact drains squad energy and nerve).
- Suffers: it never pushes lines (heat ≈ 0) and is lost to arrests.
- Counter: police snatch squads at Escalation ≥ 3 drag them out. That costs Mandate but removes them.

**Encourager**: the morale engine.
- Behaviour: stays in the middle third of the crowd (it steers toward the crowd centroid). Every 8 s
  it chants (+0.3 cheer wave, 4 m). It boosts recruitment radius ×1.5 around itself.
- Gauges: morale source (weight 3, emits ≥ 0.90). Mild heat (+0.3 base).
- Player: a crowd with about 8% encouragers survives a gas strike; one without them dissolves.
- Suffers: fatigue +50% (shouting all day). It is a snatch priority at Escalation ≥ 2.
- Counter: gas the middle, not the front. Arrest encouragers.

**Medic**: the recovery.
- Behaviour: stays at the back third. It moves to `DOWN` agents within 25 m and heals them (`act HEAL`,
  6 s → hp 0.6, agent stands with mor +0.2). Near gas it treats eyes: agents within 3 m get gas morale
  loss halved.
- Gauges: fatigue recovery −3e-5/s within 5 m. Stops "injury" waves from re-firing. Brutality weight 3.
- Player: fewer people go home after charges, and injured people come back.
- Suffers: slow and unarmed. Losing medics is the biggest single brutality-Support gain, which is a
  grim temptation by design.
- Counter: police kettles cut medics off from the front.

**Black bloc**: the battering ram.
- Behaviour: drifts to the front and edges. It throws (rocks, paving, fireworks, molotov at heat > 0.8),
  smashes shops (loot classMult 2.0), builds barricades from props. At stance Peaceful it **still acts
  at 30%**: bloc never fully obeys. That is its cost.
- Gauges: heat source (weight 2, emits 0.85). It raises d around it, making any brutality "dirty".
  Its offences raise Notoriety for a nearby leader.
- Player: it is what gives line pressure and throws back gas canisters (5% chance per canister within
  4 m). It is essential for the final Élysée cordon.
- Suffers: it costs Support and gives Mandate. Masked: it ignores the first gas exposure.
- Counter: discriminate snatches (police gain Mandate). Pacifists around bloc cool them.

**Streamer**: the camera.
- Behaviour: drifts toward the most intense activity within 40 m (police contact, fires) and keeps 6–10 m
  away. Flees late.
- Gauges: adds +0.15 to media presence M per streamer within 40 m of an event (max 3). Assaulting a
  streamer is an incident with weight 2 and adds "Filmed" to the ticker.
- Player: put streamers where you want consequences amplified: by the pacifist sit-in, *not* by the
  looted shop. Because they're autonomous, the player shapes this by where the crowd goes.
- Counter: police target streamers only at Escalation 4. That costs Mandate heavily but kills coverage.

Class ratios per crowd come from recruitment (§8). The player can nudge them with the night action Train.

---

## 6. Player agency

### 6.1 During the day: one dial and three verbs per leader

| Control | Input | Effect | Cost | Feedback |
|---|---|---|---|---|
| **Move** (existing) | right-click | leader paths, crowd follows | leader energy | path line |
| **Stance dial** | 1 / 2 / 3 keys or portrait toggle | **Peaceful**: stanceMult 0.1 (bloc 0.3), heat decay ×2. **Firm**: 0.5, default. **Unleashed**: 1.5, heat +0.003/s | none, but visible consequences | leader ring colour (blue / white / red) |
| **Rally** | Q | +0.6 cheer wave from the leader, +0.05 heat in 10 m, leader speed +20% for 20 s | 15 energy, 45 s cooldown | gold ripple through the crowd |
| **Calm** | W | heat −0.25 in 15 m, Notoriety −10, pacifists move to the front and sit if facing police | 10 energy, 60 s cooldown, crowd stops for 5 s | blue ripple, ticker "Karim calls for calm" |
| **Scatter** | E | crowd splits into 3–5 small groups that take different side streets and regroup on the leader in 90 s. Gas and kettles lose their target | morale −0.10 to all, 20% go home if mor < 0.4 | crowd fans out with dashed paths |

Stance is the "allow looting?" choice the user asked for, packed into one readable control together
with fighting.

Why it feels in control even though people are autonomous:
- **Every verb has an immediate visible ripple** (a wave through the crowd). Cause and effect show up
  within 1–3 s on screen.
- **The crowd's aggregate response is predictable**: speed, cohesion and loot rate are monotone in
  morale and heat, with no hidden dice the player can't see. Randomness only decides *which* individual
  acts, not *whether the crowd* does.
- **Every gauge change is named**: the ticker attributes each Support or Mandate change to a place and
  cause.
- **Few levers, clear tradeoffs**: 4 verbs plus 1 dial, all on cooldowns, so there is decision tension
  without micromanagement.

### 6.2 At night: three tokens, plus free placement

The night screen shows a summary (day stats, Support Δ by cause, Climate headline) and tomorrow's
police intel. The player spends **3 tokens** (4 on days 5–7):

| Action | Tokens | Effect |
|---|---|---|
| **Recruit drive** (pick a district) | 1 | +30% recruits, who spawn near that district tomorrow |
| **Rest** | 1 | all fatigue ×0.6 on top of the normal recovery; morale baseline +0.05 tomorrow |
| **Media campaign** | 1 | Support +3 now, M +0.1 all tomorrow, OR "spin" today: refund 50% of looting Support losses |
| **Train** | 1 | convert 10% of randos to a chosen class (encourager, medic or pacifist; bloc only if Climate > 0) |
| **Legal team** | 2 | an arrested leader returns tomorrow morning (otherwise they are out for 1 full day) |
| **Scout** | 1 | reveals tomorrow's police deployment and cordon positions at briefing |
| **Choose rally points** | free | each leader's start position (from `spawnPoints`, plus any district reached today) |

---

## 7. Uncontrolled riots: "maximum chaos"

The contract already has `sim.riots` and `riot` per agent. They spawn at `riotSpawns`.

**Spawning.** At dawn: `riots = round(0.5 + 1.5 × max(0, C) + 2 × avgHeatYesterday + 0.5 × (day ≥ 3))`,
capped at 5. More riots also spawn mid-day after a brutality incident with severity ≥ 5 (one riot
within 400 m of it, 50% chance). Each riot has 60–300 agents. Class mix: 50% rando, 35% bloc, 10%
streamer, 5% other. Riot heat starts at 0.7 and morale at 0.5.

**Behaviour** (agents with `riot ≥ 0` and `act MILL`):
- The riot drifts toward the nearest unlooted shop or prop, loots and burns using the same loot/throw
  rules with stanceMult 1.5 (it is effectively always Unleashed).
- It moves toward the nearest police within 150 m if heat > 0.7, and away if morale < 0.4.
- It recruits bystanders at half rate.
- It costs Support at 50% while uncontrolled, but Mandate rises at the full rate.
- Police treat it as threat (crowd_size × anger [PT §3.3]) and divert squads to it. **This is the
  chaos dividend**: a burning riot two streets away can strip a cordon from your path.
- It dissipates when riot morale < 0.25, or after 2–3 sim-hours.

**Capture.** A leader within `R_cap = 30 m + √riotCount` of the riot centroid accumulates capture
progress:
```
alignment  = 1 − |riot.heat − stanceHeat|        # stanceHeat: Peaceful 0.2, Firm 0.5, Unleashed 0.8
rate       = 0.04/s × alignment × (0.5 + leaderCrowdMorale) × (L.energy > 20 ? 1 : 0.3)
progress  += rate × dt  (decays −0.02/s when the leader leaves);  captured at 1.0  (~25–60 s)
```
- **Unleashed captures a hot riot fast** (alignment 0.9). The riot keeps its heat and joins as a
  battering ram.
- **Peaceful captures slowly** (alignment 0.5). On capture, the riot's heat is set to the leader crowd's
  average and its morale gets +0.2. You **tame** it, and riot agents with heat > 0.8 (mostly bloc)
  refuse and stay as a smaller riot.
- On capture, agents get `riot = −1` and `lead = L.id`, the event `riotJoined` fires, a +0.5 cheer wave
  plays, and Notoriety +5.

**Risks.**
- Opinion attribution: once captured, the riot's lootings cost 100% and are tied to the leader's name
  in the ticker.
- Heat contamination: a big hot riot raises your crowd's heat by diffusion, and Firm stance stops
  restraining it.
- Notoriety and Escalation: capture events count as threat for the police. Kettles become likely at
  level ≥ 3.
- Left alone, riots push Mandate up and Escalation follows. Ignoring chaos for three days makes day 5
  much harder.

---

## 8. Win, lose and the 7-day arc

### 8.1 Conditions

- **Win**: `WIN_COUNT` (300, existing) followers within `GOAL_R` of the Élysée gate, **held for 60 s**
  with the leader not arrested. Any day ends in victory. On day 7 there is no "tomorrow", so all-in plays
  are valid.
- **Lose: decapitated**. All leaders are arrested at once, with no Legal team available.
- **Lose: collapse**. At dawn the turnout (§8.2) is below 150 total.
- **Lose: opinion collapse**. Support < 10 at dusk. The movement is discredited, and Mandate gives the
  police free rein.
- **Lose: time**. Day 7 ends without a win. The epilogue is graded by Support: high Support gives the
  ending "you lost the street, won the argument".

### 8.2 Overnight carry-over

```
retention   = clamp(0.45 + 0.40·morale_end − 0.30·fat_end, 0.2, 0.9)     # per crowd
survivors   = followers_at_dusk × retention
newRecruits = BASE_REC(day) × (Support/50)^1.5
                × (1 + 0.3 × (heat_avg − 0.5)/0.5)          # anger mobilises [PT §4.5]
                × (1 + 0.25 × min(2, cleanIncidentsToday))   # outrage mobilises
                × (1 + 0.3 × max(0, C)) × campaignBonus
turnout     = survivors + newRecruits
```
Recruit class mix: pacifist share = `0.10 + 0.10 × Support/100`; bloc share = `0.05 + 0.10 × heat_avg
+ 0.05 × max(0, C)`; encourager 8%; medic 5%; streamer 7%; the remainder is randos.

Heat carry: each agent's `heat = 0.5 × heat + 0.5 × base`. Morale resets to `0.5 + 0.2 × (Support − 50)/50`.
Support keeps its value and drifts (§2.6). Mandate drifts 20% toward 50. Escalation drops one level
overnight unless Mandate > 70.

### 8.3 Sample 7-day curve

This is shaped on the Gilets jaunes week [PT §3.4].

| Day | BASE_REC | Police squads | Escalation ceiling cap | Riots | Notes |
|---|---|---|---|---|---|
| 1 | 600 | 3 (existing) | 2 | 0–1 | tutorial-ish; police under-prepared |
| 2 | 700 | 5 | 2 | 1 | surge after day-1 violence; police respond |
| 3 | 800 | 8 + water cannon | 3 | 1–2 | heavy deployment, armour |
| 4 | 900 | 9 | 3 | 2 | police fatigue carry-over starts to bite (squads start at energy 80) |
| 5 | 900 | 8 | 3 | 2–3 | scrutiny: media M +0.2, λ up, selective tactics |
| 6 | 1,000 | 8, energy 70 | 4 | 3 | police exhausted; big chance if Support is high |
| 7 | 1,200 | 12, all reserves on the perimeter | 4 | 3–5 | final stand |

The intended curve: days 1–2 teach, days 3–4 are the hard squeeze where the player must manage
Support for bodies, and days 5–6 are the window opened by police fatigue. Day 7 is the climax.

---

## 9. UI and readability

**Principles**: four bars, one ticker, and the map does the rest.
- **Crowd tint (default)**: agent dot = class colour (randos = leader colour). **Heat** is a red outer
  glow whose alpha = heat². **Morale** is brightness: low morale desaturates the dots to grey. A hot,
  confident crowd looks saturated with red halos; a beaten crowd looks grey and dim.
- **Overlay toggle (Tab)**: cycles Off → Heat map (blue to red) → Morale map (dark to gold) → Fatigue
  map. Uses the same per-agent floats; the renderer splats them.
- **Waves are drawn**: a ring of brightened (cheer, gold) or darkened (fear, violet) dots moving through
  the crowd. This one effect sells the propagation model.
- **Floating icons, rate-limited to 1 per 3 s per 50 m**: shop bag (loot), flame, broken shield (line
  broken), camera (filmed incident), handcuffs (arrest), cross (medic heal).
- **Event ticker**: the last 4 lines. Each line has a cause, a place and a gauge delta, and is clickable
  to centre the camera.
- **Squads**: show energy as the existing bar, plus nerve as a crack overlay on the shield icon.

HUD mockup:
```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ DAY 3 · 15:42   ▶▶ 15×        SUPPORT ██████████████░░░░░░  58 (+4 today)              │
│                               MANDATE ▓▓▓▓▓▓▓▓▓░░░░░░░░░░░  44     ESCALATION ■■■□□ 3   │
├──────────────────────────┬─────────────────────────────────────────────────────────────┤
│ LEADERS                  │                                                             │
│ ▌1 Inès   1,240 ◉ FIRM   │                       (map)                                 │
│   MOR ████████░░ 78      │                                                             │
│   HEAT ██████░░░░ 61     │           . . o o O O  <- gold wave rolling back            │
│   FAT  ███░░░░░░░ 31     │        police ║║║ . : o O O O o o                           │
│   ⚑ wanted 22  ⚡ 64     │                                                             │
│ ▌2 Karim    430 ◉ CALM   │                                                             │
│   MOR ████░░░░░░ 42 ▼    │                                                             │
│   HEAT ██░░░░░░░░ 18     │                                                             │
│ ▌3 Louise  (arrested)    │                                                             │
├──────────────────────────┴─────────────────────────────────────────────────────────────┤
│ [Q] RALLY 0s   [W] CALM 32s   [E] SCATTER   Stance: [1]Peace [2]Firm [3]Unleash        │
│ ▸ 15:41 Looting on rue de Rivoli: Support −3, Mandate +2                               │
│ ▸ 15:40 CRS line broken at Châtelet: Inès's crowd morale up                            │
│ ▸ 15:38 Medic struck, filmed (Bd Sébastopol): Support +5, Mandate −4                   │
│ ▸ 15:35 Riot near Les Halles joined Inès (+180)                                        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```
Only the selected leader's bars are expanded. The others show just MOR with a ▲/▼ trend arrow.

---

## 10. Tuning table

| Area | Param | Start value |
|---|---|---|
| Morale | start / led baseline / leaderless baseline | 0.60 / 0.50 / 0.35 |
| | leader aura target, radius, rate | 0.80, 12 m, +0.004/s |
| | gas morale loss | −0.25 × g /s |
| | leader arrested shock | −0.35 |
| | speed factor | 0.70 + 0.40·mor |
| | cohesion radius factor | 0.6 + 0.8·mor |
| | flee multiplier | 1.4 − mor |
| | go-home after panic | 0.25 × (1.6 − mor) × (0.5 + fat) |
| Heat | class baselines rando/pac/enc/med/bloc/str | 0.20/0.05/0.30/0.10/0.60/0.15 |
| | gas heat gain | +0.05 × g /s |
| | contact heat | +0.01/s |
| | SHOVE / threshold | 3 m/s² / heat > 0.55 |
| | loot rate | 0.05/s × heat² × stance × class |
| | fight rate | 0.06/s × (heat − 0.5)+ × stance × class |
| | stanceMult Peaceful/Firm/Unleashed | 0.1 / 0.5 / 1.5 (bloc floor 0.3) |
| Fatigue | walk / stand / run per s | 4e-5 / 1.5e-5 / 1e-4 |
| | overnight | × 0.35, floor 0.10 × daysEngaged |
| Diffusion & waves | K_M, NEG_BIAS, K_H | 0.20, 1.6, 0.10 |
| | TAU_M, TAU_H | 1200 s, 600 s |
| | HOP_P, TAU_W, WCD, WAVE_K | 0.5, 0.5 s, 1.5 s, 0.6 |
| | R_FEAR, R_CHEER, R_SPAN | 0.80, 0.78, 0.14 |
| | HEAT_CONV, PANIC_K | 0.8, 1.2 |
| Support | start / drift target | 45 / 45 + 20·C, 25% per night |
| | loot cost per value | −1.0 × v |
| | brutality B, fade | 1.5, 0.6^n |
| | media M base / per streamer / cap | 0.4 / 0.15 / 1.2 |
| Mandate | start / loot / brutality | 50 / +0.8v / −1.5·sev·(1 − d) |
| | escalation ceiling | floor(Mandate / 22) |
| Police | line resistance | n × (0.4 + 0.6·energy/100) × (0.5 + 0.5·nerve) × 1.2 |
| | line give rate / break distance | 0.25 m/s / 6 m |
| | unauthorised force | 0.0004/s × fatigue, nerve and heat factors |
| | nerve: projectile / fire / outnumbered | −0.04 / −0.01/s / −0.01/s |
| Leaders | Rally cost/cd, Calm cost/cd | 15 / 45 s, 10 / 60 s |
| | Notoriety: offence nearby / capture / overnight | +2 / +5 / −30 |
| Riots | capture rate | 0.04/s × alignment × (0.5 + mor) |
| | uncontrolled Support cost share | 50% |
| Night | tokens | 3 (4 on days 5–7) |
| | BASE_REC by day | 600, 700, 800, 900, 900, 1000, 1200 |
| | retention | 0.45 + 0.40·mor − 0.30·fat |
| Climate | clean incident / loot day | +0.08 / −0.05 |

**The five knobs that matter most for balance**
1. **Brutality gain `B` and the cleanliness exponent `(1 − d)²`**: these decide whether the martyr play
   dominates. If players farm incidents, raise the exponent to 3 or lower B.
2. **Loot cost per value (−1.0·v) versus loot morale (+0.20 and the cheer wave)**: these decide whether
   Unleashed is a crutch.
3. **NEG_BIAS and R_FEAR**: how fragile crowds feel. Too high and every gas strike is a rout; too low and
   police feel toothless.
4. **Line resistance multiplier (1.2)**: whether the final Élysée cordon can be pushed and how much heat it
   takes.
5. **Recruit exponent (Support/50)^1.5 and BASE_REC**: how much the week snowballs. Lower the exponent if
   good players snowball out of reach, and raise it if Support feels pointless.

---

## 11. Implementation plan

### v1: 80% of the fun

1. **Per-agent gauges**: `mor`, `heat` (rename `aggr`), `fat`, `wv`, `wcd`, `off`, registered. Accumulate
   neighbour sums in the crowd loop and add a `gauges` system after `crowd`.
2. **Behaviour hooks**: speed, cohesion radius, flee multiplier, go-home, shove, loot and fight rates.
   Gas and charges feed morale and heat.
3. **Waves**: gas, charge, arrest and injury (negative); Rally, line broken and loot (positive). Draw them.
4. **Support and Mandate** with the event table, brutality incidents with `d` and `fade`, and an
   Escalation ceiling from Mandate. Media M is fixed at 0.6 (no streamers yet).
5. **Classes**: rando, pacifist, encourager, medic and black bloc, with the behaviours in §5. The medic heal
   and the pacifist sit can be simple.
6. **Player**: Stance dial, Rally, Calm. (Scatter waits for v1.5.)
7. **Police**: line pressure vs resistance (line give and break), squad energy costs, and unauthorised force
   using energy only (nerve comes in v2).
8. **Riots**: spawn, loot and capture with alignment, at a fixed 50% Support share.
9. **Night**: the overnight formula, a summary screen, and 3 tokens limited to Recruit, Rest and Legal team.
   Rally points.
10. **HUD**: Support and Mandate bars, per-leader MOR, HEAT and FAT, the escalation pips, the ticker and the
    heat glow.

### v2: the smarter opinion and climate model

1. **Climate** with overnight drift, scripted news events and a newspaper night screen. Symbol looting turns
   positive in a Revolt climate.
2. **Streamer class** and dynamic media presence M. Media campaign and "spin".
3. **Opinion segments**: Support splits into 3 publics, each with its own reaction weights:
   - *Left / unions* (brutality ×1.5, looting ×0.5)
   - *Centre* (the current weights; it is the swing vote and recruits pacifists)
   - *Right / order* (looting ×2, brutality ×0.3; drives Mandate)

   Displayed Support is the weighted mean. Recruits come mostly from Left and Centre, and Mandate from
   Right and Centre. This gives "violence may help with some publics and hurt with others" without new
   player verbs.
4. **News cycle**: incidents are queued and "published" at 20:00. One headline dominates the night (the
   highest |Δ|), and the player's Media campaign can swap it for the second one.
5. **Police nerve** per squad; the full unauthorised-force formula; police learning (hot spots, side-street
   cordons) [PT §3.4].
6. **Scatter**, Train and Scout night actions; new leaders emerging from big leaderless crowds when
   Support > 60.
7. **Kettle response**: kettled crowds unify (heat and cohesion up), and outside crowds converge
   [PT §2.4, ESIM].
