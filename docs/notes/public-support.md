# Public support (and police mandate): v1 implementation notes

Feedback item 3 (2026-10-20): "Public support is missing." This is the v1 of `docs/gauges.md` §2.6 (Support) and §2.7
(Mandate). Code: `src/systems/support.js` (new system, last in `SYSTEM_FACTORIES`), the HUD in `src/ui.js` and
`index.html`. No other system was edited. Support and Mandate don't drive anything yet: the hooks are exposed as pure
functions on `sim.api`, and the wiring is proposed below for the day and police owners.

## What the player sees

- **HUD** (top of the meters block, full width): `SUPPORT ▲ 47 +2.1 today`, a bar coloured by value (red < 20, orange
  < 35, yellow < 55, green) with a white tick at the 45 baseline, one line with today's two biggest causes ("police
  brutality +3.1 · looting by marchers −2.0"), and a thin blue **Mandate** bar under it. The tooltip shows the value
  in words (discredited / hostile / sceptical / divided / sympathetic / behind you), today's change, the trend, every
  cause of the day with its count, and the Mandate with its escalation ceiling. The trend arrow is ▲ above +0.6/h,
  ▼ below −0.6/h, otherwise ▸.
- **Ticker**: one line whenever a single cause moves Support by ≥ 1.5 points within 4 sim-minutes, with the delta
  first so it isn't cut off: "Support +2.1: opinion turns on the police after violence on rue de Rivoli",
  "Support −1.5: your marchers loot on rue de Rivoli". Lines are green or red and are not "low" priority rows.
- **Night summary**: replaces the "coming soon" placeholder. It shows support at dusk on a bar (with a tick at the
  morning value), today's change, the change by cause (up to 7 rows with counts), the overnight drift and the new
  value, and Mandate morning → dusk. The briefing's "Since yesterday" and the end screen show the value too.
- **Help panel**: one sentence on what moves Support.
- The legend (I) only lists map items, not HUD meters, so it has no entry.

## State and API

```
sim.support = { value 0..100, mandate 0..100, trend (points per sim-hour, smoothed ~10 min), climate (0, fixed in v1),
                media (M), start / mStart (values at dayStart), today: { cause: { s, m, n } }, incidents,
                cleanIncidents (today, d < 0.3 and severity >= 2), history: [per day], samples: [{t, v, m}] (every 5 sim-min),
                last: {t, cause, delta}, dusk, overnight, sandbox }
history[i] = { day, start, end (dusk), drift, after, mStart, mEnd, mAfter, incidents, cleanIncidents, recruitMod, causes: [{cause, label, s, m, n}] }

sim.api.supportInfo()              copy of sim.support + { delta (today), top (3 causes), ceiling, lambda, recruitMod }
sim.api.supportRecruitMod()        clamp((S/50)^1.5 × (1 + 0.25 × min(2, cleanIncidents)), 0.25, 2.5)
sim.api.supportMandateMod()        clamp(0.5 + Mandate/100, 0.5, 1.5); 1.0 at Mandate 50
sim.api.supportEscalationCeiling() clamp(floor(Mandate / 22), 0, 4)
sim.api.supportMoraleBase()        clamp(0.5 + 0.2 × (S − 50)/50, 0.2, 0.8)   (for the future morale gauge)
sim.api.supportCauses()            the cause table (labels, caps)
event 'support' { delta, mandate, cause, causeLabel, dir: 'up'|'down', value }
```

Persistence: the system listens for `'dayStart'` (it resets `today`, the saturation and the morning reference, but
never the value) and `'dayEnd'` (it writes the history row, then applies the overnight drift). Agents being cleared
each morning doesn't touch it. Nothing changes during 'briefing' or 'summary'.

## Mechanics and numbers

**Start**: Support 45, Mandate 50. **Media presence** M = 0.6 (0.8 from day 5), multiplying every delta. **Climate**
C = 0 (v2).

**Saturation (news fatigue).** The sim produces far more events than gauges.md assumed. In sandbox there are about
3,000 loot grabs, 450 shop break-ins, 300 fires and 100 brutality incidents per sim-hour; a campaign day 1 has
70–340 incidents. Raw per-event deltas would pin the gauge at 0 or 100 within minutes. So every cause `c` has a cap,
and an event with raw magnitude `r` changes the gauge by

```
Δ = sign × M × cap × (e^(−A/cap) − e^(−(A+r)/cap)),   then A += r   (A ≤ 6·cap, A decays with τ = 3 sim-hours, reset each morning)
```

The first events of a kind are news and later ones barely move the needle. This replaces the design's
`fade = 0.6^n` for brutality, which would also fail at 100 incidents an hour. Mandate uses the same rule with its own
cap.

| Cause (key) | Trigger | Raw Support | Raw Mandate | Support cap | Mandate cap |
|---|---|---|---|---|---|
| police brutality (`brutality`) | `'brutality' {severity, d}` | 1.5 × min(sev, 6) × (1 − d)² × (0.7 + 0.3C) × frame | 1.5 × sev × (1 − d) × min(1, frame) | +12 | −12 |
| looting by marchers (`looting`) | `'loot'` grab by an agent with `lead ≥ 0` | 0.2 (= 1.0·v per shop over 5v grabs) | 0.16 | −12 | +10 |
| looting by rioters (`wildLoot`) | `'loot'` by a riot member or bystander | 0.1 (50%, "casseurs, not protesters") | 0.16 | −6 | +10 |
| smashed shops (`damage`) | `'shatter'` with `shop` / `'barricade'` | 0.3 / 0.1 | 0.2 / 0.1 | −4 | +4 |
| fires and explosions (`fires`) | `'fire'` by kind / `'explosion'` power ≥ 1 | shop 1.0, car 0.6, barricade 0.25, bin 0.15, molotov 0.1 / 1.0 | same | −6 | +6 |
| officers injured (`officers`) | `'officerDown'` | 2 | 3 | −6 | +10 |
| bystanders hurt (`collateral`) | `'injury'` from a crowd weapon (rock, bottle, paving, firework, molotov, blast, fire) on a non-offender, non-bloc | 0.4 | 0.2 | −4 | +2 |
| rioters arrested (`arrests`) | `'arrest' {agent}` of an offender | 0.2 | 0.5 | −3 | +5 |
| mass arrests (`sweeps`) | `'arrest' {agent}` of a non-offender | rando 0.08, pacifist 0.25, encourager 0.1, medic 0.35, bloc 0 × frame | 0.1 | +4 | −3 |
| leaders arrested (`leaders`) | `'arrest' {leader}` | peaceful +0.6 (plus police's severity-5 brutality incident), firm +1.2, unleashed −0.8 | −1 / −1 / +2 | ±8 | ±6 |
| peaceful marches (`peaceful`) | each sim-minute: a leader with ≥ 500 followers and no follower offence for 10 min; plus visibility when ≥ 500 march in total | +0.5/h; +0.3/h × min(1.5, total/2000) | −0.3/h | +5 | −3 |
| leaders' stance (`stance`) | each sim-minute, leaders with ≥ 100 followers, weight w = min(1, n/1000) | peaceful (and clean) +0.3·w/h; unleashed −1.0·w/h | −0.2·w / +0.5·w per h | ±4 | ±3 |

- **Offender** = act LOOT / FIGHT / THROW now or within the last 20 s (the same window as police.js). The system keeps
  its own registered `lastOff` array, scanned every 0.5 s, because police.js doesn't expose its own.
- **Frame** (new, not in gauges.md): police force is judged by the stance of the nearest active leader (≥ 30
  followers) within 60 m: peaceful ×1.2, firm ×1.0, unleashed ×0.5. Without it, a reckless Unleashed march scored as
  well as a careful one, because police.js finds most victims "clean" even in a hot crowd.
- Police injuries of non-offenders already arrive as `'brutality'` incidents, so `'injury'` events from police
  weapons are ignored to avoid counting them twice.
- **Overnight** (at `'dayEnd'`): Support moves 25% toward 45 + 20C, and Mandate 20% toward 50.
- **Sandbox** (`?sandbox`, no nights): continuous drift of 25% toward the baseline per 4 sim-hours.

## Test runs (Node, small map, `makeSim('small', seed)`, 0.12 s steps, `tools/bot.js`)

Sandbox (seed 1, careful bot, intensity 1): 45 → 31.3 after 1 h → 33.3 after 2 h → 33.6 after 3 h, Mandate 50 →
67 → 65. The first minutes have a looting and fire wave on top of 104 brutality incidents (+7.7), then the gauge
settles and slowly recovers as the news cycle forgets.

Campaign day 1, seed 1, value at dusk → after overnight drift:

| Run | Dusk | Next morning | Mandate at dusk | recruitMod | Top causes |
|---|---|---|---|---|---|
| passive, Firm (default) | 32.0 | 35.2 | 68.3 | 0.77 | brutality +10.9, looting by marchers −10.3, by rioters −6.2, fires −5.8 |
| passive, all Peaceful | 46.6 | 46.2 | 56.4 | 1.35 | brutality +11.6, fires −5.8, by rioters −4.8, sweeps +3.8, stance +1.5 |
| passive, all Unleashed | 28.3 | 32.5 | 69.5 | 0.64 | looting −10.7, brutality +9.3, fires −5.5, stance −2.3 |
| careful bot | 50.5 | 49.2 | 47.5 | 1.52 | brutality +8.9, damage −2.7, by rioters −2.7, sweeps +2.7, leaders +1.8 |
| reckless bot | (campaign lost on day 1 before dusk; 4 brutality swings in the ticker) | | | | |

Hourly, passive-Peaceful day 1: 45.3 (09h), 44.6, 48.0, 46.1, 48.9, 47.4, 46.9, 45.3, 45.7, 46.7 (18h), 46.6.
Passive-Firm over two days (before the framing change): 45 → 32.0 (dusk 1) → 35.2 → 30.0 (dusk 2) → 33.8. Mandate
50 → 68 → 65 → 76 → 71. Chaos left alone erodes Support by about 10 a day and hands the police cover. That matches
gauges.md ("ignoring chaos for three days makes day 5 much harder"), but see the open questions.

Browser smoke tests (`tools/smoke.mjs`, port 8083): sandbox at 20 s, the campaign briefing, the campaign at 14:43
on day 1, and the night summary. No exceptions.

## Proposed wiring (for the owners of day.js and police.js; not done here)

**day.js, recruits** (in `endDay`, where `recruits` is computed; Support is still the dusk value there, because
`'dayEnd'` and the drift come after it):

```js
const sMod = sim.api.supportRecruitMod ? sim.api.supportRecruitMod() : 1;   // 0.25..2.5, 1.0 near Support 50
const recruits = Math.round((100 + 0.3 * st.riotJoined + 50 * D.day) * sMod);
```

Optionally, also scale retention mildly: `retained × (0.85 + 0.3 × S/100)`. Add `supportMod: sMod` to `D.carry` so
the briefing can show "Recruits +X (public support ×1.2)". Later (gauges.md §8.1), consider a loss on
`sim.support.value < 10` at dusk ("opinion collapse").

**police.js, mandate** (two touch points):

1. Escalation ceiling: wherever the target level is computed (`lvl` before `sim.emit('escalation', …)`),
   `lvl = Math.min(lvl, Math.max(1, sim.api.supportEscalationCeiling?.() ?? 4))`. Keep a floor of 1 so the police
   never go fully passive, and keep the gate guard exempt.
2. Willingness to use force: multiply the gas volley chance, the charge decision and the stray-snatch / line-grab
   rates by `sim.api.supportMandateMod?.() ?? 1` (0.5 at Mandate 0, 1.5 at 100). With low Mandate the police are
   careful and prefer liaison and snatch; with high Mandate they gas and kettle (gauges.md §2.7, λ = 1.5 − Mandate/100
   is in `supportInfo().lambda`).

**Morale** (future gauges system): the morning morale baseline is `sim.api.supportMoraleBase()`.

## Contract changelog entry (paste into docs/contract.md)

```
- v1.9 (support agent: src/systems/support.js (new), ui.js, index.html; sim.js `// [support]`; additive):
  - New system `support`, appended to SYSTEM_FACTORIES (after `day`). It reads events only and writes nothing other systems own.
  - `sim.support = { value 0..100 (start 45), mandate 0..100 (start 50), trend (pts/sim-hour), climate (0), media (0.6, 0.8 from day 5),
    start, mStart, today:{cause:{s, m, n}}, incidents, cleanIncidents, history:[{day, start, end, drift, after, mStart, mEnd, mAfter,
    incidents, cleanIncidents, recruitMod, causes}], samples:[{t, v, m}] }`. It persists across days: 'dayStart' resets only `today`;
    'dayEnd' records history, then drifts Support 25% toward 45 and Mandate 20% toward 50. Sandbox: continuous drift (25% per 4 sim-h).
  - Causes: brutality, looting (marchers), wildLoot (riot/bystander, 50%), damage, fires, officers, collateral, arrests (offenders),
    sweeps (non-offenders), leaders, peaceful, stance. Each saturates per news cycle (cap, τ 3 h). Police force is framed by the nearest
    leader's stance (peaceful ×1.2, unleashed ×0.5).
  - APIs: `supportInfo()`, `supportRecruitMod()` (0.25..2.5), `supportMandateMod()` (0.5..1.5), `supportEscalationCeiling()`
    (floor(M/22)), `supportMoraleBase()`, `supportCauses()`. Not wired into day.js / police.js yet (see docs/notes/public-support.md).
  - Event: `'support' {delta, mandate, cause, causeLabel, dir, value}` when one cause moves Support >= 1.5 within 4 sim-min.
  - Per-agent array (registered): the support system's own `lastOff` (time of the last LOOT/FIGHT/THROW).
  - UI: Support + Mandate meter at the top of #gauges (now in index.html markup), ticker lines for 'support', the night-summary
    support section, and support in the briefing and end screens.
```

## Open questions

1. **Brutality dominates.** police.js produces 70–340 incidents a day, 60–85% of them "clean" (d < 0.3), so the
   brutality cause hits its cap almost every day whatever the player does. The cap keeps it bounded, but if police
   tuning cuts brutality (feedback items 1, 2 and 5 may add more force), the balance shifts. Revisit the caps after
   the police round.
2. **Firm is costly.** The default stance lets followers loot, which costs about 10 Support on day 1. That is good
   pressure toward Peaceful, but first-time players start on Firm. Should the default become Peaceful, or the day-1
   looting cost be halved?
3. **Mandate creeps up** on chaotic days (≈ +15 a day for passive play), reaching ceiling 3 by day 2. The overnight
   drift is only 20%. That is fine once it caps escalation, but check it after wiring.
4. Climate, streamers (dynamic M), opinion segments and the night "Media campaign" token are v2 (gauges.md §11).
   `sim.support.climate` is in place for them.
5. In sandbox the first sim-minutes (intensity 1 from 08:00) produce a burst of −1.5 ticker lines. They merge in the
   ticker, but the sandbox could start looting later.
