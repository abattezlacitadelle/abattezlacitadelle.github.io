# Objectives, sites, Momentum and the Breakthrough meter (design v1)

Design only. Nothing here is code. It builds on `docs/contract.md` (the sim and its fields),
`docs/gauges.md` (cited as **[G §x]**: Morale, Heat, Fatigue, Support, Mandate, Escalation, classes,
stance, Rally/Calm/Scatter, night tokens) and the commander AI in `docs/police-tactics.md` (**[PT §x]**).

Everything below is a game rule: zones, headcounts, timers, gauges, scores, probabilities and HUD.
Site names are **placeholders** that the user will rename. They sit at real map positions so the
geography stays believable, but the game only ever calls them by the labels in the data table
(§11.4). Lore blurbs are generic fiction.

Units: metres, sim-seconds, sim-hours. A campaign day runs 08:00–18:00 (day) plus 18:00–20:00 (dusk).

---

## 1. Pillars and fit

### 1.1 Pillars

1. **The city is the board, the Palace is the finish line.** Marching straight to `GOAL` is the
   obvious move and should almost never work. Winning comes from *stretching* the police across the
   city first, then striking.
2. **Hold ground, not just streets.** Taking and holding a site is the core verb. A held site is a
   visible, persistent mark on the map: it grows people, pins police and builds Momentum.
3. **Every site is a trade.** Garrisons don't march. Camps can be cleared overnight. Sites close to
   the Palace raise police escalation. Wealthy districts tempt looting. Nothing is free (**[G §1.4]**).
4. **Guessing game.** The police read only what they see (v1.7 guess-only intel). The player can
   feint: threaten one site to strip squads from another. The one exception is the *announced*
   march, where the player chooses to reveal a route in exchange for a bigger payoff.
5. **Readable at a glance.** Each site is one ring with one owner colour, one capture arc and one
   headcount. Two new gauges only: **Momentum** (top bar) and **Breakthrough** (at the Palace).

### 1.2 Fit with the 7-day arc

| Day | Police (mobile squads, `SQUADS_BY_DAY`) | Objective role |
|---|---|---|
| 1 | 5 | Tutorial. One pick from two offers. `SITE_A` is next to the start spawns and is the intended first capture. |
| 2 | 6 | First real choice: expand to a second site or rescue a leader. |
| 3 | 7 | Police surge [PT §3.4]. Camps are at their highest clearance risk. Holding what you have is the challenge. |
| 4 | 8 | The squeeze. Target: **2 sites held at dusk**. |
| 5 | 9 | The window. Police fatigue carry-over bites; Momentum is high. Breakthrough attempts start. |
| 6 | 10 | Best odds of the week if the board is set up. |
| 7 | 11 + reserves | Final stand. No night, so no camps: everything marches. |

### 1.3 Sample winning campaign

| Day | Picks | What happens | End-of-day Momentum |
|---|---|---|---|
| 1 | *Take City Hall Square* | Leader 1 walks 300 people into `SITE_A` (captured 08:20). Leaves a 120 garrison and marches the rest west to scout police reactions. Camp of 140 holds overnight (risk 9%). | 17 → 15 overnight |
| 2 | *Take the Museum Courtyards*; *Hold City Hall Square* | Leaders 2 and 3 converge on `SITE_C` from two directions; police guess `SITE_C` too late. Captured at 12:40 with 340. Leader 3 arrested at 16:00 near the island. Two camps (A 150, C 210). | 33 → 28 |
| 3 | *Free the arrested* | Morning attack on `SITE_B` from the City Hall side while Leader 1 feints north. Precinct guard breached at 11:10, held 90 s: Leader 3 returns with 60 freed people. Dawn raid on `SITE_C` the next morning (rolled 18%) is beaten back. | 44 → 37 |
| 4 | *Take Opera Square*; *Media moment* | Opera Square captured at 14:00. Police now contain `SITE_C` (4 squads) and `SITE_D` (2): six of eight squads pinned for two hours. Three camps at dusk. | 61 → 52 |
| 5 | *Take the Grand Square* | Morning: the meter climbs to 64 on Strain alone. 16:00: 520 people into `STAGING`, meter 88 (Wavering). Gate not pushed; camp at `STAGING` cleared overnight (rolled under its 41% clear risk), Momentum −8. | 66 → 56 |
| 6 | *Symbolic march (announced)* | Announced route City Hall → Museum Courtyards → Grand Square. Police block it, but the block pulls two contain squads off `SITE_D`. March arrives at 15:30 with 700 people. Meter **Open** at 16:05; 380 followers hold the Palace ring for 60 s. **Win, day 6.** | — |

### 1.4 Why skipping objectives almost never wins

The win is never hard-locked (§4.4), but the Breakthrough meter sets the gate strength and the hold
time, and its biggest terms come from objectives. With no sites:
- Pinned squads `P' = 0`: every mobile squad is free to defend.
- Momentum comes only from street sources, capped at +6/day (§3.2), so `M' ≤ 0.15`.
- Police fatigue `F'` reaches about 0.6 on a violent day.

`Strain = 0.40·0.15 + 0.35·0 + 0.25·0.6 = 0.21`. Even with full Push (1.0), the meter target is
`100 × 0.21 × 1.2 = 25`. At B = 25 the gate guard fights at ×1.6 strength (instead of ×1.0), the hold
needs 150 s (instead of 60 s), and all 9–15 mobile squads can converge. Roughly 1.6× the pressure,
held 2.5× longer, against about 1.5× the defenders: **about 6× harder** than an Open gate. Bot target:
≤ 5% win rate with no objectives (§10).

---

## 2. Holding mechanics

### 2.1 Zones

A site is one or more circular **lobes** (`{x, y, r}`). The site's headcount is the union of its
lobes. Lobes are placed on the most open walkable ground near the anchor (checked against the nav
grid: 84–100% walkable within 40 m).

**Who counts:**
- *Own people*: agents with `lead ≥ 0` (any player leader) or `garr = siteIndex` (garrison), not
  DOWN, ARRESTED or HOME.
- *Police*: active officers of any squad (`na`) whose position is inside a lobe, plus snatch teams.
- Riot members (`riot ≥ 0`) and bystanders don't count for either side.

### 2.2 States

```
 NEUTRAL ──(leader inside + own ≥ N_cap)──► CAPTURING ──(progress = 1)──► HELD
    ▲                    │ police ≥ P_block                              │  ▲
    │                    ▼                                               │  │ own ≥ N_hold, police < P_block
    │                 CONTESTED (progress frozen)  ◄──── police ≥ P_block┘  │
    │                                                                        │
    └──── LOST (retake timer done, or camp cleared) ◄── own < N_hold for T_lose
 SEALED: police-owned, capture needs ×1.5 time (after a retake or a cleared camp; lasts 1 day)
```

**Capture:** a player leader must be inside to start ("someone plants the banner"). After that the
leader may leave.
```
if own ≥ N_cap and police < P_block:
    progress += dt / T_cap × min(1.5, sqrt(own / N_cap))     # more people capture faster, up to 1.5×
elif police ≥ P_block:   frozen (CONTESTED)
else:                    progress -= dt / (2·T_cap)          # decays when too few
P_block = max(8, own / 12)                                   # a small crowd is blocked by a few officers
```
**Hold:** a HELD site stays held while `own ≥ N_hold` (lower than `N_cap`). Police inside at
`≥ P_block` make it CONTESTED: recruits stop and the perk switches off, but it's still yours.
**Lose:** `own < N_hold` and `police ≥ 8` for `T_lose` (45 s) → LOST, then SEALED for the rest of
the day and the next day. If own drops below `N_hold` with no police, the site isn't lost: it goes
**Unmanned** (perk off, no recruits) and returns to HELD when `own ≥ N_hold` again.

### 2.3 Garrison

On capture, the game **automatically detaches a garrison**: `max(N_hold, 15% of the capturing
crowd)` agents nearest the zone centre get `lead = -1`, `garr = site`. They mill inside the zone (the
riot milling behaviour, target kind `'square'`) and don't follow anyone.
- **Garrison verb (G, new):** with a leader selected inside a held zone, G cycles the share left
  behind: 10% / 20% / 35%. With the leader inside, Rally picks up any surplus above `N_hold`.
- **Site recruits** join the garrison (§2.6). Garrison above `G_max` overflows to any leader inside
  the zone; if there is none, the overflow is banked for tomorrow's recruits.
- Garrison agents still have Morale/Heat/Fatigue. They can panic, be arrested or be gassed out.

### 2.4 Dusk rule and overnight camps

- From 18:00, garrison agents are **exempt from going home** (no `leaving` roll).
- Followers whose leader stands inside a held zone at 19:30 may stay: 50% of them join the camp, up
  to `G_max`.
- At 20:00 the **camp** is whoever is inside: `camp = garrison` (capped at `G_max`).
- Camp people **don't march tomorrow**: they're subtracted from the carry-over crowd and respawn
  inside the zone at 08:00 as the new garrison.

**Overnight resolution (abstract, one roll per camp, shown in advance):**
```
risk = clamp( base_s
              × (1 + 0.2·(escalation − 1))
              × dayMod[day]                       # d1 0.8, d2 1.0, d3 1.3, d4 1.2, d5 0.9, d6 0.8
              × (K_s / (K_s + camp)) × 2          # bigger camps are harder to clear
              × (1 − 0.5·policeFatigue)           # §4.1
              × mandateMod × supportMod,          # [G §2.6–2.7]; both 1.0 until gauges exist
              0.03, 0.90)
mandateMod = 0.6 + 0.8·Mandate/100      supportMod = Support > 60 ? 0.8 : 1
roll r = rand():
   r < risk/2  → CLEARED:   site LOST + SEALED. Camp: 40% go home, 30% arrested, 30% join tomorrow's crowd. Momentum −8.
   r < risk    → DAWN RAID: camp −30%. At 08:00 the site starts CONTESTED and a 'clear' op (§8) with 2 squads is already moving.
   else        → HOLDS:     camp −10% attrition. Momentum +3.
```
The dusk summary shows the odds per camp ("Museum Courtyards · camp 210 · clear 11% · raid 11% ·
holds 78%"), so the player can trade marchers for safety before 20:00.

### 2.5 HUD and visual language

| Element | Look |
|---|---|
| Zone ring | Dashed circle per lobe, 2 px. Grey = neutral, **gold** = player (movement colour), **navy** = police/sealed. |
| Capture arc | Solid arc on the ring, filling clockwise in the capturing leader's colour. Freezes and flashes navy/gold stripes when contested. |
| Label | Site label plus `own / N_cap` while capturing (`142 / 300`), then `own` and a timer while held (`HELD 2:14 h`). Red if `own < N_hold × 1.2`. |
| Garrison | Garrison dots use the gold ring colour with a dark centre, so they read as "staying". |
| Camp (dusk and night summary) | Tent icons, one per 25 campers. Odds text under the ring. |
| Police contain | The intent overlay (O) draws a navy ring of short lines at the zone exits with a "contain" tag; `clear` shows arrows into the zone. |
| Perk | Small icon above the label when the perk is active; greyed when contested or unmanned. |
| Ticker | "City Hall Square captured by Inès (+10 Momentum)", "Police contain Museum Courtyards (3 squads pinned)". Click to pan. |

Maximum five sites (six rings including Opera/Column lobes) on the map at once.

### 2.6 What holding gives (all sites)

| Benefit | Rule |
|---|---|
| Recruits | `R_s` per sim-hour join the garrison, × `(Support/50)` × `(1 + M/200)`. Halved when contained, 0 when contested or unmanned. |
| Spawn point | A site held at 08:00 (camp survived) is a spawn option at the briefing. |
| Pins police | The commander must answer it (contain, clear or ignore, §8). Contain/clear squads count as **pinned** for the meter, and they don't rest: energy −0.1/s while within 40 m of the crowd, no regen. |
| Momentum | +0.5 × `w_s` per sim-hour held (§3). |
| Perk | Site-specific (§5). |

---

## 3. Momentum

### 3.1 Definition

**Momentum** (0–100, global, start 0) answers "is the movement winning?". It's the city's sense that
the protest is unstoppable. It is **mostly earned by objectives** and it feeds Strain in the
Breakthrough meter (§4).

HUD: a bar next to Support with ticks at 25/50/75 and a ▲/▼ trend arrow over the last sim-hour.
Each change is named in the ticker.

### 3.2 Sources and drains

| Source | Δ |
|---|---|
| Capture a site (first time this campaign) | +10 |
| Recapture a site | +6 |
| Each sim-hour a site is held (pro rata) | +0.5 × `w_s` (A 1, B 1.5, C 1.5, D 2 per square, STAGING 3) |
| Camp holds overnight | +3 per camp |
| Objective completed | per objective, +4 to +12 (§5, §6) |
| Leaders freed | +10 |
| Police pull a contain off a site (released) | +2 |
| *Street sources* (capped together at **+6 per day**): police line broken +1, riot captured +1, peaceful hour with > 500 marchers +1 | ≤ +6 |

| Drain | Δ |
|---|---|
| Site lost by day | −6 |
| Camp cleared | −8 (−4 if the camp was under 50) |
| Leader arrested | −5 |
| Objective failed | −4 to −10 (per objective) |
| Own crowds loot 10 shops (each 10) | −1 |
| Dusk with no site held | −5 |

**Decay:** −1 per sim-hour during the day while **no** site is held (it doesn't decay while anything
is held). **Carry-over:** overnight `M ← 0.85·M`. **Daily gain cap:** +30 (keeps a perfect day from
deciding the week).

### 3.3 Interaction with the gauges.md gauges

| Gauge | Effect of Momentum | Fallback before gauges exist |
|---|---|---|
| Morale [G §2.3] | Led baseline `0.50 + 0.10·M/100`. | none |
| Heat [G §2.4] | No direct effect (Heat stays the confrontation dial). Capture gives a +0.5 cheer wave (**[G §4.4]**, same as riot captured). | — |
| Support [G §2.6] | Overnight `Support += 0.02·M` (at most +2). | — |
| Mandate [G §2.7] | **Backlash:** at `M ≥ 60`, Mandate +3 per night ("the government orders firmness"). | escalation floor +0.5 |
| Escalation | At `M ≥ 50` the police reinforcement cap is +1 (they call in reserves). | same |
| Recruits [G §8.2] | `newRecruits × (1 + 0.5·M/100)`. | applied to day.js `recruits` |
| Notoriety [G §2.7] | The leader who plants the banner gets +5. | — |

The backlash rows stop Momentum from snowballing for free: high Momentum brings more police.

---

## 4. Breakthrough meter at GOAL

### 4.1 Terms (each 0..1)

| Term | Definition |
|---|---|
| **F'** police fatigue | `clamp((PF − 0.10) / 0.50)`, with `PF` = mean `(1 − energy/100)` over mobile (non-gate) squads. Squads start each day at `energy = 100 × (1 − 0.6·PFcarry)`, where `PFcarry ← 0.6·PFcarry + 0.4·PF_dusk + 0.05·campsHeld` overnight. |
| **P'** pinned squads | `clamp(pinnedEq / (0.35 × mobileSquads))`. `pinnedEq` = squads on site `contain`/`clear` ops + 0.5 per held site the police **ignore**. |
| **M'** Momentum | `M / 100` |
| **H'** crowd Heat | `clamp((H − 0.30) / 0.40)`, H = mean Heat of own people within 450 m of `GOAL` (fallback: mean `aggr`). |
| **N'** numbers | `clamp(nearGoal / 1000)`, `nearGoal` = own people within 450 m of `GOAL` + 0.5 × own people inside `STAGING`. |

### 4.2 Formula

```
Strain = 0.40·M' + 0.35·P' + 0.25·F'          # the city is stretched (built over days, by objectives)
Push   = 0.50·H' + 0.50·N'                    # the crowd is at the gate (built in the last hour)
target = 100 × min(1, Strain × (0.6 + 0.6·Push))
B moves toward target: up 1 point per 3 s, down 1 point per 2 s     # readable, can't be spiked
```
Strain alone can fill 60% of the bar, so the player sees the city weakening long before the final
march. Push decides the last 40%. Full requires `Strain ≥ 0.83` with full Push.

### 4.3 Thresholds and effects at the gate

| B | State | Gate guard strength (replaces `GATE_STR` 1.8) | Overwhelm time (replaces `GATE_BREAK_T` 8 s) | Hold needed |
|---|---|---|---|---|
| 0–39 | Closed | `1.8 − 0.8·B/100` | 8 s | `HOLD_T × (1 + 2·(1 − B/100))` |
| 40–69 | Strained | same formula | 7 s | same |
| 70–99 | Wavering | same formula | 6 s | same |
| 100 | **Open** (latched while B ≥ 85) | 1.0 | 4 s | 60 s (`HOLD_T`) |

Examples: B 25 → ×1.6, 150 s. B 70 → ×1.24, 96 s. Open → ×1.0, 60 s.

### 4.4 The win moment

Unchanged rule, scaled by the meter: a non-arrested leader with `≥ WIN_COUNT` (300) followers within
`GOAL_R` holds for the hold time above. On entering **Open**, the weakest gate post is breached once
(`gateBreach`, a 40 s gap), the meter pulses, the ticker reads "The Palace gates are wavering", and
a 60 s ring timer appears on the goal. If B falls below 85 the latch ends and the hold time rises
again (progress kept, drains 2× as today when the ring is lost).

HUD: a vertical meter docked beside the goal marker on the map, plus a compact top-bar readout
`BREAKTHROUGH 62 · Strain 0.68 × Push 0.40`. Hover lists the five terms with their current values.

---

## 5. Site catalogue

Common numbers per site are in §10. "Contain cost" is the number of squads the police need to
contain the site properly; with fewer, the contain is leaky (recruits only −25%).

### SITE_A "City Hall Square"
- **Lore:** *The old square where the city's first uprising began. Every movement starts here.*
- **Zone:** one lobe, r 45, beside the east starting spawns. Two of the four day-1 spawns sit at or
  next to it.
- **Capture:** `N_cap` 150, `T_cap` 60 s, `N_hold` 60. Far from the Palace (≈ 2.95 km), so low
  police priority on days 1–2.
- **Police response:** ignore on days 1–2 unless a camp is over 200; contain (2 squads) from day 3;
  rarely cleared by day (low threat score).
- **Perk "Rallying point":** spawns and recruit waves arrive at the square at once; Rally cooldown −30%
  for leaders inside; day-start crowds of leaders who spawn here +10%.
- **Failure (fiction: "The square goes quiet"):** if lost or cleared, tomorrow's recruits −15% and the
  east spawns start with police watching (1 squad pre-positioned).
- **Rewards (objective *Take/Hold City Hall Square*):** +150 recruits tomorrow; Momentum +4.

### SITE_B "Island Precinct"
- **Lore:** *The station on the island where the city keeps those it takes off the streets.*
- **Zone:** one lobe, r 35, on the island's west half. Reached only by bridges.
- **Starts police-held.** A fixed **precinct guard** squad (16 officers, ×1.5 strength, never
  re-tasked, the gate-guard rules with its own post) stands at the zone edge.
- **Capture:** overwhelm the guard (8 s, opens a gap like `gateBreach`), then `N_cap` 200 inside for
  `T_cap` 90 s. `N_hold` 80.
- **Police response:** high priority while any leader is in custody. Contain cost only 2 (bridges),
  and kettle-type ops on the island close 30% faster: the island is a trap.
- **Perk "Open doors":** capture frees arrested leaders (§6.1). While held, any leader arrested today
  returns next morning automatically (as the Legal team token, **[G §6.2]**), and 30% of today's
  arrested protesters rejoin as followers.
- **Failure (fiction: "Transferred"):** if the attempt ends in a kettle on the island (≥ 40% of the
  attacking crowd arrested or dispersed), held leaders are transferred: they can't be freed for 2
  days. Momentum −8; arrests on the island count double for the police.
- **Rewards:** freed leaders; Momentum +10; **unlock:** the precinct's records give intel (tomorrow's
  police deployment is shown at the briefing).

### SITE_C "Museum Courtyards"
- **Lore:** *Great courtyards built for kings, now open to everyone. Hard to fence, easy to fill.*
- **Zone:** two lobes, the main courtyard r 55 and a smaller one to the north-east r 35, counted together.
- **Capture:** `N_cap` 300, `T_cap` 90 s, `N_hold` 100. ≈ 1.7 km from the Palace.
- **Police response:** contain cost **4** (many gates). The police usually choose between a full
  contain (4 squads) and a leaky one. Kettles and cordons against crowds inside take ×1.5 longer to close.
- **Perk "Sanctuary":** inside the zone, fatigue −3e-5/s (as next to a medic), panic durations
  halved, gas decays ×1.5 faster. Camp base risk is low.
- **Failure (fiction: "The gates are locked"):** if lost by day, the site is SEALED for 2 days instead
  of 1. If own crowds loot or burn ≥ 6 shops within 150 m while it's held, "Desecration": Support −8,
  Momentum −10, and the site can't be captured again this campaign.
- **Rewards:** +250 recruits tomorrow; **unlock:** a new leader (cap 5) who starts here with 100.

### SITE_D "Opera Square" + "Column Square"
- **Lore:** *The rich quarter: grand boulevards, glass storefronts and every camera in town.*
- **Zone:** two separate squares, Opera (r 40) and Column (r 35), about 400 m apart, captured and held
  **independently**. One square gives half the perk; both give the full perk.
- **Capture (each):** `N_cap` 200, `T_cap` 75 s, `N_hold` 70. ≈ 1.0–1.1 km from the Palace.
- **Police response:** fast. Within 1.5 km of the gate, so holding either raises the police
  escalation floor to 2 (the existing march-distance floor applies to held sites). At escalation ≥ 2
  the planner prefers **clear** (3 squads) over contain.
- **Perk "Spotlight":** media presence M +0.3 (half with one square) within 300 m **[G §2.6]**;
  media-moment Momentum ×1.5; Support from peaceful hours ×2.
- **Temptation:** luxury shops (value 3) cluster here. Own crowds' loot rate ×1.5 within 200 m, and
  each looted shop costs 1.5× Support and −1 Momentum.
- **Failure (fiction: "Smash-and-grab headlines"):** 8 shops looted by own crowds while held → perk
  lost for the day, Mandate +10, escalation +1 tomorrow. If retaken by day: next day's media moments
  aren't offered.
- **Rewards:** **intel** (tomorrow's riot forecast + police plan for the first 2 h); +3 Support.

### STAGING "Grand Square"
- **Lore:** *The vast square at the end of the avenue, where crowds gather before the last walk.*
- **Zone:** one lobe, r 60, ≈ 680 m from the Palace.
- **Capture:** `N_cap` 400, `T_cap` 120 s, `N_hold` 150.
- **Police response:** treated as a perimeter threat. Holding it sets the escalation floor to 3.
  Contain cost 3; at escalation ≥ 3 the police try to clear it within 30 min.
- **Perk "Last mile":** people inside count 0.5 each toward `N'` (§4.1), and meter fill speed ×1.5
  while held. A surviving camp makes it a spawn point (start the day 680 m from the Palace).
- **Failure (fiction: "The square is sealed"):** if lost or cleared, the police perimeter gains one post
  covering the square for the rest of the campaign. Camp base risk is very high (0.60).
- **Rewards:** Breakthrough meter starts tomorrow at 20; Momentum +6.

---

## 6. Other objective types

### 6.1 Free the arrested
- **Offered** only when at least one leader was arrested on an earlier day (`gone`) and isn't yet
  back.
- **Window:** 10:00–15:00. At 15:00 the leaders are "transferred" unless `SITE_B` is CONTESTED or
  HELD by the player.
- **Success:** `SITE_B` captured, *or* the precinct guard breached and 100 own people inside the zone for
  30 s. Each held leader returns at the zone with 50 followers (released arrestees). Momentum +10.
- **Partial:** guard breached but the hold not met by 15:00 → each leader has a 50% chance to slip out.
- **Failure:** window missed, or the kettle-trap rule in §5 `SITE_B`. Momentum −6, Support −2, police
  escalation +0.5 for the rest of the day.

### 6.2 Symbolic march
- **Pick:** a route from a short menu (3–4 waypoints chosen from site centres and spawns), e.g.
  *"The Old Road": City Hall Square → Island bridges → Museum Courtyards → Grand Square*.
- **Kept unbroken:** the leader passes every waypoint (within 60 m) in order before 18:00, never
  dropping below 60% of the starting count and never more than 80 m off the route for over 10 min.
  The march breaks if a police split leaves the leader under the 60% threshold.
- **Announced (default):** the route is published. The police get a `predict` entry for that leader
  with `conf: 1` and the exact route, so blocks are placed early. Rewards ×2, Support +5 on
  announcement, M +0.2 along the route.
- **Unannounced (flash march):** police guess as usual. Half rewards, no Support bonus.
- **Breaking an announced route on purpose** (the feint): Support −5 and "broken promise" in the ticker,
  but the squads pulled to the announced route are already committed.
- **Rewards (announced):** Momentum +8, +200 recruits. **Failure:** Momentum −5.

### 6.3 Media moments
Timed pop-ups during the day (2–3 per day from day 2; none on day 1). The ticker announces them,
and they are optional even when not picked; picking one doubles its reward and adds the failure.

| Moment | Condition | Reward | Fail |
|---|---|---|---|
| **Live crew** | ≥ 300 own people in a named zone for 5 min within a 20 min window, no own looting within 100 m | Momentum +4, Support +3 | Looting on camera: Support −2 × v per shop (×2) |
| **Sit-in photo** | ≥ 30 pacifists within 6 m of a police line for 3 min, no offences within 15 m | Momentum +5, brutality gains ×1.5 for 30 min | — |
| **Aerial shot** | Peak of ≥ 1,500 own people within 250 m of one point | Momentum +6, +150 recruits | — |

Momentum from media moments is ×1.5 inside the `SITE_D` perk radius.

---

## 7. Briefing flow

1. **Night summary** (existing) adds: camp outcomes, Momentum Δ by cause, police fatigue carry.
2. **Intel strip:** whatever intel rewards revealed (police plan, riot forecast).
3. **Objectives:** offers are drawn from the pool. Day 1: 2 offers, pick 1. Days 2–6: 4 offers, pick up to
   2. Day 7: 3 offers (no camp objectives), pick up to 2.
   Offer rules: one *Take* objective for a site not held; one *Hold/Camp* objective if any site is held;
   *Free the arrested* whenever eligible; the rest from march/media.
4. **Spawns** (existing): pick each leader's start. Held sites with surviving camps are added.
5. **Enter** starts the day.

Sites are always capturable. A picked objective only adds the stakes: its reward on success and its
fiction-specific failure.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ DAY 4 · BRIEFING                     MOMENTUM ███████░░░░░░░ 37 ▲            │
│ "Transport grinds to a halt"         POLICE   8 squads · fatigue 0.31        │
├──────────────────────────────────────────────────────────────────────────────┤
│ HELD SITES   ● City Hall Square  camp 150 (held)    ● Museum Courtyards 190  │
│ INTEL        Police plan revealed until 10:00 (press O on the map)           │
├──────────────────────────────────────────────────────────────────────────────┤
│ OBJECTIVES  (choose up to 2)                                    picked 1/2   │
│ [x] TAKE OPERA SQUARE             by 18:00                                   │
│     + intel: riot forecast · +3 Support · Momentum +10 (first capture)       │
│     ! looting 8 shops = headlines (Mandate +10, escalation +1)               │
│ [ ] HOLD MUSEUM COURTYARDS        held at 18:00                              │
│     + +250 recruits · unlock leader   ! lost = sealed 2 days                 │
│ [ ] SYMBOLIC MARCH "The Old Road" announced ▸ / flash                        │
│     + Momentum +8 · +200 recruits · Support +5   ! police see the route      │
│ [ ] MEDIA MOMENT  live crew (time and place revealed at 11:00)               │
│     + Momentum +8 · Support +6       ! looting on camera ×2                  │
├──────────────────────────────────────────────────────────────────────────────┤
│ SPAWNS   Inès ▸ City Hall Square   Karim ▸ Museum Courtyards   Louise ▸ ...  │
│                                                       [Enter] start day      │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 8. Police response to held sites

### 8.1 Site threat score

Computed at every commander tick (12 s, or 6 s when urgent) from **observable** data only: headcount
inside, distance to the gate, perk active.
```
T_site = w_s × (inside / 100) × (1 + 1.5 / (1 + dGoal_km)) × (perkActive ? 1.3 : 1)
         × (objective announced on it ? 1.5 : 1)
```

### 8.2 Decision per site (with 3 min hysteresis)

| Choice | When | What it does |
|---|---|---|
| **ignore** | `T_site < 1`, or no free squads | Nothing on the map. The site recruits ×1.5 ("unopposed") and counts 0.5 pinned in `P'`. |
| **contain** (new kind) | `T_site ≥ 1` and free squads ≥ contain cost | Lines at the zone exits facing inward, open outward: people may leave, not enter. Blocks garrison reinforcement; halves recruits. Pins its squads. |
| **clear** (existing kind, now with `site`) | escalation ≥ 2, free squads ≥ clear cost, `officers ≥ inside / 6`, and no march predicted to the gate with eta < 20 min | Pushes into the zone to drive `own` below `N_hold` and start the `T_lose` timer. |

### 8.3 Priority against GOAL

Allocation order each tick:
1. Gate guard (fixed, outside the planner).
2. Perimeter (≥ 2 squads at `PERIM_R`).
3. Marches by `threat × conf` (existing blocks, splits, kettles).
4. Sites by `T_site` (contain/clear).
5. Hunts and responses.

**Emergency pull:** a march predicted to reach the gate within 10 min with `conf ≥ 0.5` releases
contain squads, lowest `T_site` first. Each release gives Momentum +2 and `counts.siteReleases++`.
That is the feint lever: threaten the gate to free a site, or threaten a site to thin the gate.

**Pre-emption:** when a leader's top `predict.dest` maps to a site (`hotelDeVille`/`chatelet` →
`SITE_A`, `pontNeuf`/`notreDame` → `SITE_B`, `louvre`/`palaisRoyal` → `SITE_C`, `operaGarnier` (+ a new
Column Square key) → `SITE_D`, `concorde` → `STAGING`) with `conf ≥ 0.6`, the planner posts a `contain` with
status `'planned'` at that site. A feint toward one site pre-commits squads there.

### 8.4 Plan entries (compatible with `sim.police.plan`)

```
{ id, kind: 'contain', x, y, r, pts: [[x,y],...] (ring through the exit lines), squads: [ids],
  status: 'planned'|'moving'|'active'|'done', target: 'O<siteId>', site: 'SITE_C', score: T_site }
{ id, kind: 'clear', ..., target: 'O<siteId>', site, phase: 'approach'|'push'|'hold' }
```
Night camp clearance is **not** a plan entry: it's resolved off-map (§2.4). A dawn raid appears at
08:00 as a `clear` entry with status `'moving'`. Squad roles gain `'contain'`; `sq.role === 'clear'`
is reused. New counts: `contains, siteClears, siteReleases, campsCleared, dawnRaids`.

---

## 9. Rewards and unlocks

| Reward | Effect | Number |
|---|---|---|
| Intel: police plan | Tomorrow's deployment (posts, staging, planned contains) shown in the intent overlay until 10:00 | 2 sim-hours |
| Intel: riot forecast | Tomorrow's `riotPlan` (place, size, time) shown at the briefing | all riots |
| Bigger crowd | Added to tomorrow's recruits | +150 / +200 / +250 |
| Freed people | Released arrestees join a freed leader | +50 per leader |
| Weaker police: short-handed | −1 mobile squad tomorrow (not below 4) | −1 squad |
| Weaker police: worn | `PFcarry` +0.10 | ≈ −6 starting energy |
| Weaker police: slow reserves | Reinforcement cap −1 tomorrow | −1 |
| Gate shaken | Breakthrough meter starts tomorrow at this value | 20 |
| Unlock: leader | A new leader (cap 5) at the site | 100 followers |
| Unlock: spawn point | The site stays a spawn option even without a camp (until it's sealed) | — |
| Unlock: ability "Hold fast" | Garrison immune to panic for 60 s, once per day per site | 60 s |
| Unlock: ability "Flash march" | One unannounced march per campaign gets full rewards | 1 use |
| Momentum | Per objective | +4 … +12 |

Objective → reward mapping: `SITE_A` +150 recruits; `SITE_B` freed leaders + police-plan intel;
`SITE_C` +250 recruits + leader; `SITE_D` riot forecast + police plan + Support +3; `STAGING` gate
shaken 20; *Camp overnight* (any site) worn police (+0.10); *Symbolic march* +200 recruits +
short-handed police; *Media moment* Support and recruits as in §6.3. "Hold fast" unlocks after the
first surviving camp; "Flash march" after the first completed march.

---

## 10. Tuning table and balance targets

| Area | Param | Value |
|---|---|---|
| Capture | `P_block` | max(8, own / 12) |
| | capture speed cap | 1.5× |
| | decay without people | 1 / (2·T_cap) per s |
| | `T_lose` | 45 s |
| | sealed duration | 1 day (`SITE_C`: 2) |
| Per site | `N_cap` / `T_cap` / `N_hold` | A 150/60/60 · B 200/90/80 · C 300/90/100 · D 200/75/70 each · ST 400/120/150 |
| | `R_s` recruits per h | A 60 · B 20 · C 40 · D 50 each · ST 30 |
| | `G_max` garrison/camp cap | A 300 · B 150 · C 400 · D 200 each · ST 500 |
| | `w_s` weight | A 1 · B 1.5 · C 1.5 · D 2 each · ST 3 |
| | contain / clear cost (squads) | A 2/2 · B 2/2 · C 4/3 · D 2/3 each · ST 3/4 |
| | camp `base_s` / `K_s` | A 0.10/150 · B 0.45/120 · C 0.15/200 · D 0.35/150 · ST 0.60/250 |
| Garrison | auto share / G steps | 15% / 10, 20, 35% |
| Camp | dayMod d1..d6 | 0.8, 1.0, 1.3, 1.2, 0.9, 0.8 |
| | outcomes | clear risk/2, raid risk/2; attrition 10%; raid −30% |
| Momentum | carry / daily cap / street cap | ×0.85 / +30 / +6 |
| | hold rate | 0.5 × w per h |
| | backlash | M ≥ 50 reserves +1; M ≥ 60 Mandate +3/night |
| Meter | Strain weights M/P/F | 0.40 / 0.35 / 0.25 |
| | Push weights H/N | 0.50 / 0.50 |
| | Push scale | 0.6 + 0.6·Push |
| | P' denominator | 0.35 × mobile squads |
| | N' full / radius | 1000 / 450 m |
| | rise / fall | 1 per 3 s / 1 per 2 s |
| | latch | Open at 100, holds while ≥ 85 |
| Gate | strength / overwhelm / hold | 1.8 − 0.8·B/100 / 8 → 4 s / 60 × (1 + 2·(1 − B/100)) |
| Police | pinned energy drain | −0.1/s near the crowd, no regen |
| | PFcarry | 0.6·old + 0.4·dusk + 0.05·camps |
| | site hysteresis / emergency pull eta | 3 min / 10 min |

**Balance targets (bot-measured, 20 seeds each):**

| Strategy | Target |
|---|---|
| Careful (sample plan §1.3) | ≥ 2 sites held at dusk on day 4 in ≥ 60% of seeds; meter ≥ 70 on day 5; wins on day 5–6 in 40–60%, by day 7 in ≥ 70% |
| No objectives (rush the gate daily) | meter ≤ 30 typical, ≤ 40 max; win rate ≤ 5% |
| Greedy (capture everything, big camps) | camps cleared ≥ 35% of nights; wins before day 7 ≤ 25% |
| Momentum curve (careful) | end of days 1–5 ≈ 15 / 30 / 38 / 55 / 65 (after carry) |
| Police pinning | day 5 with 2–3 sites: 3–5 of 9–12 mobile squads pinned on average; perimeter never below 2 |
| Camp risk | typical camps 10–35% total risk; `STAGING` 45–75% |
| Capture time | a 1.2× `N_cap` crowd with no police captures in `T_cap` × 0.9 |

**Knobs that matter most:** the Strain weight on P (whether pinning beats raw Momentum); camp
`base_s` (how safe the board is overnight); the gate hold formula (how not-locked the goal really is);
`N_cap` on `SITE_C` and `STAGING`; and the Momentum carry (×0.85).

---

## 11. Implementation plan

### 11.1 v1 subset
1. **Zones, capture, hold, lose** for `SITE_A`, `SITE_C`, `SITE_D` (both squares) and `STAGING`, with
   auto-garrison, the G verb and recruits.
2. **Momentum** with the sources and drains above (street cap, carry, decay). Gauge fallbacks where
   gauges.md isn't implemented yet.
3. **Breakthrough meter** with the gate effects (strength, overwhelm, hold time) and the Open latch.
4. **Abstract overnight camps**: dusk exemption, camp size, one roll, the three outcomes, dawn raid.
5. **Police**: `T_site`, ignore/contain/clear, emergency pull, pinned energy drain, `PFcarry`.
6. **Briefing pick**: offers, 1–2 picks, rewards and failures for *Take*, *Hold* and *Camp* objectives.
7. **HUD**: rings, arcs, labels, Momentum bar, meter, camp odds in the summary, ticker lines.

### 11.2 v2
`SITE_B` with the precinct guard and *Free the arrested*; symbolic marches (announced/flash, feint
penalty); media moments; ability unlocks; pre-emptive contains from `predict.dest`; Mandate/Support
interactions once gauges land; site-specific SEALED variants ("Desecration", "Transferred").

### 11.3 Proposed contract fields (additive)

**New system `objectives`** (`src/systems/objectives.js`), run after `crowd` and before `day`, so
day's win check reads this substep's meter. It owns:
```
sim.objectives = {
  sites: [{ id, label, lobes: [{x, y, r}], owner: 'neutral'|'player'|'police',
            state: 'neutral'|'capturing'|'contested'|'held'|'unmanned'|'lost'|'sealed',
            progress 0..1, own, police, garrison, camp, campOdds: {clear, raid}, heldT, capturedBy,
            perkOn, stance: 'ignore'|'contain'|'clear', planId, sealedUntilDay }],
  active:  [{ id, kind: 'take'|'hold'|'camp'|'free'|'march'|'media', site?, route?, announced?,
              status: 'active'|'done'|'failed', due, reward, failure }],
  offered: [...], picks: 0..2, policeFatigue (PFcarry), log: [...] }
sim.momentum = { value 0..100, today, streetToday, trend, log: [{t, d, why}] }
sim.breach   = { value 0..100, target, strain, push, terms: {F, P, M, H, N},
                 state: 'closed'|'strained'|'wavering'|'open', gateMult, overwhelmT, holdNeed }
```
Per-agent array `garr` (Int8, site index or −1, registered).
APIs: `sim.api.objOffers()`, `objPick(id)`, `siteInfo(id)`, `setGarrison(siteId, share)`,
`announceRoute(leaderId, routeId)` (v2), `momentumAdd(d, why)`.
Events: `'site' {site, phase: 'capture'|'held'|'contested'|'unmanned'|'lost'}`, `'momentum' {d, why}`,
`'breach' {state}`, `'camp' {site, outcome}`, plus the existing `'objective' {id, status}`.
Objective checks register through the existing `sim.api.addObjective` hook (`check` returns
`'done'|'failed'`).

**Systems touched:**
- `day.js`: hold time and win check read `sim.breach.holdNeed`; garrison exempt from the dusk leave;
  carry-over subtracts camps and adds banked site recruits and the Momentum recruit factor; camp
  roll at dusk end; briefing offers and picks; held sites as spawn options.
- `police.js`: `contain` kind, `clear` with `site`, `T_site` scoring and priority, emergency pull,
  gate strength and overwhelm time from `sim.breach`, pinned energy drain, `PFcarry` starting energy,
  dawn raid op, (v2) precinct guard reusing the gate-guard code, site escalation floors.
- `riots.js` / `crowd.js`: garrison milling inside lobes (riot milling with target `'square'`);
  garrison agents never lapse.
- `leaders.js`: the G verb; Rally inside a held zone picks up surplus garrison.
- `ui.js`, `render2d.js`: rings, arcs, labels, Momentum bar, meter, briefing panel, summary odds.

### 11.4 Site data table (the one place to rename)

Proposed file `src/sites.js` (or a `sites` block in the map data). Positions are checked against the
nav grid; `sim.goal` is at (598.5, 2260.5), `GOAL_R` 40.

| id | label | lobes (x, y, r) | anchor (data/paris-small.js) | ≈ dist to goal |
|---|---|---|---|---|
| `SITE_A` | City Hall Square | (3134, 690, 45) | `landmarks.hotelDeVille` / `chatelet` | 2.95 km |
| `SITE_B` | Island Precinct | (2500, 660, 35) | island west half, near `landmarks.pontNeuf` | 2.49 km |
| `SITE_C` | Museum Courtyards | (1930, 1190, 55) + (2060, 1330, 35) | `landmarks.louvre` / `palaisRoyal` | 1.7 km |
| `SITE_D` | Opera Square | (1720, 2240, 40) | `landmarks.operaGarnier` | 1.12 km |
| `SITE_D` | Column Square | (1570, 1880, 35) | no landmark key yet (≈ 400 m south-west of `operaGarnier`) | 1.04 km |
| `STAGING` | Grand Square | (946, 1663, 60) | `landmarks.concorde` | 0.69 km |
| `GOAL` | the Palace | `sim.goal`, `GOAL_R` 40 | existing | — |

```
export const SITES = [
  { id: 'SITE_A',  label: 'City Hall Square',  lobes: [[3134, 690, 45]] },
  { id: 'SITE_B',  label: 'Island Precinct',   lobes: [[2500, 660, 35]] },
  { id: 'SITE_C',  label: 'Museum Courtyards', lobes: [[1930, 1190, 55], [2060, 1330, 35]] },
  { id: 'SITE_D',  label: 'Opera Square',      lobes: [[1720, 2240, 40]], group: 'SITE_D' },
  { id: 'SITE_D2', label: 'Column Square',     lobes: [[1570, 1880, 35]], group: 'SITE_D' },
  { id: 'STAGING', label: 'Grand Square',      lobes: [[946, 1663, 60]] },
];
export const GOAL_LABEL = 'the Palace';
```
Lore blurbs and perk names live next to the labels in the same file. All UI text reads `label`, so
renaming a site is one edit. Note that the `SITE_B` lobe sits about 60 m from the `pontNeuf`
spawn: that's the convenient approach, and why the precinct guard and the bridge contain exist.

### 11.5 Bot test scenarios (`tools/bot.js` `target()` hook, Node sim)

1. **Capture smoke:** one leader with 400 to `SITE_A`, police disabled → HELD within `T_cap` + 30 s;
   Momentum +10; garrison ≥ 60.
2. **Contest:** place a squad inside during capture → progress frozen while `police ≥ P_block`.
3. **Lose:** remove the garrison, push 2 squads in → LOST after 45 s, SEALED; Momentum −6.
4. **Camp odds:** 10,000 resolutions per camp size → outcome rates within ±1% of the displayed odds.
5. **No-objectives baseline:** existing rush strategy, 20 seeds × 7 days → meter max ≤ 40, win ≤ 5%.
6. **Careful campaign:** the §1.3 plan via `target()` → the balance targets in §10.
7. **Pinning:** hold 3 sites on day 5 → mean pinned ≥ 3, perimeter ≥ 2 squads at all times.
8. **Feint:** a march toward the gate with eta < 10 min → at least one contain released; `siteReleases` ≥ 1.
9. **Meter monotonicity:** raising any single term never lowers the target; B never moves faster than
   its rise/fall rate.
10. **Performance:** the objectives system costs ≤ 0.1 ms per step (site counts use `forEachNear` per lobe
    once per 0.5 s, not every substep).
