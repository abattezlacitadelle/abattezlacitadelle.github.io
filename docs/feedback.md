# Playtest feedback backlog

User feedback waiting to be scheduled. Newest first. When an item is done, move it to the contract changelog and delete it here.

## 2026-10-20

1. **The police (CRS) are too focused on objectives and ignore confrontation.** Squads keep to their planned role (block, perimeter, gate, cordon) even when protesters clash with them or right next to them. They should react to aggression: hit back, pursue, charge and clear the people attacking them, and not only stand on their plan line.
   - Look at: the police.js coordination layer (re-planning every 12 s, `sq.role`, plan ops), and how hostile contact or thrown objects feed back into tasking.

2. **Tear gas should be used much more freely.** Today gas volleys need escalation ≥ 2 (or a squad in trouble), and every squad has a stock of 40 canisters (`sq.gasStock`). The user wants gas to be the police's default tool: earlier, more often, to deny areas and steer the crowd, and against any crowd that gets close or doesn't disperse.
   - Look at: the escalation gate on gas, the volley rate, the stock and restock, and gas used for steering (police-tactics.md §gas).

3. **Public support is missing.** There is no visible support or public-opinion gauge. It is designed in `docs/gauges.md` (Support, Mandate) but not implemented. It should be on the HUD and react to brutality, property damage and arrests; it should feed recruits and the police mandate.

4. **The map border cuts off too abruptly.** The playable area ends in a hard rectangle. It needs a softer edge: a fade or vignette, streets and buildings running on past the edge in a muted style, or a fog band.
   - Look at: render2d.js (static map tiles, background).

5. **The police just stand still.** Lines feel static. Squads should move: advance, reposition, rotate, patrol, chase and come back, so the police feel alive and active.

6. **A very large crowd should break up police formations.** When a squad faces a crowd far bigger than itself, it should be shaken: the formation loses cohesion, the line bends or breaks, officers get pushed back or scattered, and the squad falls back in disorder before it regroups. Today a line holds unless its strength or pressure check fails.
   - Look at: police.js line breaks (`lineBroken`, `sq.pressure` versus `sq.strength`, `brokeT`), a possible police morale or cohesion value, and how officer positions are drawn when a formation breaks.
