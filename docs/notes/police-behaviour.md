# Police behaviour round: contract changelog entry

Paste this under "Changelog" in `docs/contract.md`. The code is in `src/systems/police.js`, in blocks marked `// [behaviour]`. Nothing else was edited. Leader-arrest code is untouched: the `lineGrab` leader branch, snatch exposure, `arrestLeader` and hunts.

- v1.9 (police behaviour round: police.js only; all additive; user feedback 2026-10-20 items 1, 2, 5, 6):
  - **Cohesion** (item 6). `sq.cohesion` (0..1, starts at 1) measures squad morale and formation integrity.
    - Odds = `(front + 0.7·close + 0.15·near) / na`. `sq.close` is new: committed protesters 6–20 m in front, counted in scan.
    - Cohesion drains while odds > 3. The rate is `0.022 · min(4, odds − 3) · (0.15 + load/strength)`, ×1.4 when energy < 30. It drains a further 0.008/s while the squad is being hit.
    - Cohesion recovers 0.025/s at odds < 1.5 (×2 in reserve, ×3 at rest, full recovery off the line). A downed officer costs 0.05.
    - Line strength is multiplied by `0.55 + 0.45 · cohesion`.
    - Below 0.7 the formation turns ragged: officers are offset up to about ±1.6 m sideways and 2 m back. Front-rank officers under crowd pressure (`sq.opress[k]`) are bent back by up to 3 m. The renderer draws these positions through the existing `ox`/`oy`.
    - A squad routs when cohesion < 0.22 and one of these holds: load/strength > 0.5, it was attacked in the last 8 s, or odds > 12. A rout puts it in state `'broken'` for `18 + 6·min(5, odds)` m with scattered officers, then `'regroup'`, and it comes back with cohesion 0.42.
    - The gate guard is exempt (cohesion stays 1). Hunt teams never rout this way.
  - **Hitting back** (item 1). An aggression meter on the squad rises with:
    - each hit on an officer (+0.6),
    - each crowd projectile aimed at the squad (+0.5; police listen to combat's `'throw'` event and remember where the thrower stood for 12 s),
    - brawlers on the line (+0.6 each, which also counts as an attack),
    - throwers seen in front (+0.25 each),
    - a pressing front (+0.6).
    - The meter decays ×0.9 every 0.5 s.

    Above 1.8, with a 10–20 s cooldown, a squad whose line is holding, pushing or yielding and that is allowed to use force makes a **riposte**:
    - **Sally:** a `'charge'` steered at the attackers' centroid (throwers, offenders and recent throw origins). It stops against a solid mass (more than 12 people within 2.5 m ahead), goes at most 40 m from the post (14 m for squads in an op), then walks back at 1.5 m/s and turns to face its post again.
    - **Clearing charge:** 8–14 m on the front.
    - **Gas:** when odds > 6 or cohesion < 0.55, a gas volley on the attackers instead of going in.

    Snatch teams are readied for the attackers (`snatchCd` ≤ 1.5 s). Regular charges from `decide` now need cohesion > 0.5 and odds < 6, and get ×1.6 utility when the squad is attacked at close range.
  - **Gas as the default tool** (item 2).
    - Volleys start at escalation 1 once the area is warned, or when attacked. In v1.7 they needed escalation 2.
    - The target is any committed crowd that comes close (≥ 8 people within 20 m), lingers after the sommations (more than 15 s), or reaches a mass of 20 at escalation 2, as well as hostile crowds as before.
    - The volley cooldown is 9–16 s (was 14–24) and the minimum mass is 8 (was 10).
    - There are two volley types:
      - **Deny:** 2–3 canisters across the street 18–26 m in front of the line, against an approaching crowd.
      - **Disperse:** 3–5 canisters on the crowd's centre.
    - A block line's "gas ahead" is aimed 25 m short of the march's leader, at its head.
    - Ground still above concentration 0.3 is not re-gassed.
    - Below escalation 3, no canister lands within 14 m of an active leader. It is moved to the edge of the core, so gas thins a march from its edges.
    - A close crowd in contact that the squad can take (odds < 6) gets baton before gas (gas utility ×0.5).
    - Kettle-drain gas also starts at escalation 1.
    - **Stock:** `GAS_STOCK` is 100 (was 40). Supply vans bring 1 canister per 30 s on duty when not in contact (1 per 6 s below 25). Reserve restocks at 1 per 8 s (was 30) and rest at 1 per 4 s (was 10).
  - **Live lines** (item 5).
    - Quiet holding squads patrol forward and back along their street around their post: within 8 m (16 m in reserve), at 0.8 m/s, pausing 5–17 s between legs. A block line waiting for a march within 220 m stands on its post. This replaces "drift home after 15 s of quiet".
    - **Bound:** a short push of 4–8 m at a crowd within 6–20 m, when not outnumbered.
    - **Step back:** 3 m at a time when outnumbered and shaken.
    - **Relève:** the front rank swaps with the second rank every 40–70 s in contact.
  - **New squad fields:** `cohesion`, `close`, and `bh` (internal: aggression meter, slot offsets `jl/jr/bend`, sally, patrol point; don't rely on it). No new `state` values: sallies use `'charge'`, routs use `'broken'` then `'regroup'`.
  - **Events:**
    - `'routed' {squad, cohesion, odds}` fires on every cohesion rout.
    - `'lineBroken'` gains `cause: 'cohesion'` when a rout causes it. The once-a-minute rule and heat are unchanged.
    - Sallies and clearing charges emit `'charge'` as before.
  - **New `police.counts`:** `ripostes, sallies, ripGas, throwsAtPolice, throwsAtGate, cohesionBreaks, routs, rotations, bounds, stepBacks, gasDeny, gasDisperse, gasCoreShift, gasResupply`, plus metering: `footM` (m walked on foot), `stationM` (m moved while not in transit) and `squadSec` (squad-seconds on duty).
