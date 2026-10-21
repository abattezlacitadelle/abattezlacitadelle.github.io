# Action system (design draft v0, 2026-10-21)

This replaces the stance system (Peaceful / Firm / Unleashed), which was hard to understand and whose effects were hard to see. Not implemented yet.

## Principles
1. **Orders, not micromanagement.** The player gives a march a broad order. The crowd works out the details on its own: who builds, which shops, how hard to push. One click and an optional target point.
2. **No cost but the risk.** There are no points, mana or charges. Each action has consequences: Support, police escalation and Mandate, arrests, injuries, people lost, and Discipline. The player weighs those risks.
3. **Visible right away.** Every order shows an icon badge over the leader, an area or route on the map, and a ticker line. Its consequences float up as they happen ("−3 support", "line broken", "8 arrests").
4. **Property damage, not violence against people.** Player orders never include strikes or throwing at people. Only the autonomous riots (AI) can throw. This matches the disclaimer.
5. **Protection is automatic.** Masks and goggles, umbrella walls and medics act on their own, depending on who is in the march (medics, black bloc, preparation). The player never orders them.

## Discipline (replaces stance)
- A per-march value from 0 to 100, shown as a bar under the leader's name next to the energy bar.
- **High discipline:** orders are carried out as given, there is little spontaneous damage, and Confront stays gentle.
- **Low discipline:** spontaneous looting and smashing, Confront turns direct, people drift away, and orders are carried out loosely or partly.
- **Raised by:** Regroup, Sit-in (shared purpose), a calm stretch with no police contact, encouragers in the march.
- **Lowered by:** Smash/loot and Fire (once unleashed, a crowd is hard to rein back), gas, charges, brutality against the march, a leader under threat, fatigue, rising anger (Heat).
- **Starting value:** taken from the march's composition (pacifists raise it, black bloc lower it).

## Actions (v1)

| # | Action | Target | What the march does | Main risks |
|---|---|---|---|---|
| 1 | **Regroup** | none | Everyone closes in around the leader, panic calms down, lapsed followers rejoin. | Becomes a compact, easy target for a kettle. |
| 2 | **Disperse** | destination point | The march breaks into small groups that take different side streets toward the point, getting past police blocks, and reform there. Faster than marching and hard to block. | **Loses people**: some don't reform, more so at low discipline or with a long route. Small groups are exposed to snatch teams. |
| 3 | **Flash march** | route or point | The whole march moves fast as one body. | Fatigue; stragglers drop off; it outruns the police's prediction but draws a fast response. |
| 4 | **Sit-in** | none (here) | Occupies the spot: hard to move, recruits bystanders, gains Support over time. | The police must kettle or clear it, which means mass arrests; Mandate rises if it lasts. |
| 5 | **Confront** | a police line, or none (the nearest) | Faces the police and presses forward. **How hard depends on the climate and the people**: gentle (holding the line, pushing with shields and banners, chanting in their faces) when discipline is high, anger is low or many pacifists are present; direct (hard shoving, trying to break through) when anger is high, discipline is low or many black bloc are present. | Line breaks bring escalation, gas and charges; injuries; Support swings either way depending on who looks violent. |
| 6 | **Barricade** | point (near the march) | Black bloc and willing people build barricades from street furniture across the nearest streets. | Needs black bloc or rough members; Support −; Mandate +; the police come to clear it. |
| 7 | **Smash / loot** | area (near the march) | The march damages property and loots shops in a radius. High discipline: picked symbolic targets (banks, luxury shops). Low discipline: anything goes. | Large Support −; Mandate +; discipline drops; looters drift away carrying their loot. |
| 8 | **Fire** | point | Sets a barricade, bins or a car on fire to deny the area to the police. | The largest Support −; spreading fire and car explosions; escalation. |

**Modes and one-shots:**
- *One-shot actions* finish on their own: Regroup, Disperse (ends when the march has reformed), Flash march (ends on arrival), Barricade and Fire.
- *Modes* last until another order or until they are broken: Sit-in, Confront, Smash/loot.
- **Every order can be cancelled**: right-click to move, or press the same key again.

**Autonomous AI stays:** riots, spontaneous looting at low discipline, brawls, and throwing by riots all still happen without player orders.

## UI
- An action bar for the selected leader: 8 buttons with icons, hotkeys, and the active mode highlighted.
- Hovering an action shows its main risks in one line.
- Hotkeys: Q/E are freed when stance is removed; T/Y are currently Rally/Scatter. The final key map is still to be decided.

## Systems affected (implementation notes)
- **Removed:** `L.stance` and the stance aggression multipliers (crowd.js, riots.js, leaders.js, ui.js), plus the stance framing in support.js and the "unleashed" arrest weighting in police.js.
- **New:** `L.discipline`, `L.action = {kind, x, y, t0, ...}`, `sim.api.orderAction(leaderId, kind, target)`, and the events `'action' {leader, kind, phase}`.
- Sequencing: do this after the current balance, police and support rounds have been merged, because all three read the stance.

## Open questions
1. Disperse: how many people are lost? A proposal is 5–30%, scaled by route length, discipline and police contact along the way.
2. Sit-in: can it be held overnight (into a camp, see objectives.md) or does it end at dusk?
3. Confront: should the player be able to cap its intensity ("keep it gentle"), or is it always decided by the climate?
4. Does a Smash/loot or Fire order also lower the discipline of *nearby* marches (contagion)?
