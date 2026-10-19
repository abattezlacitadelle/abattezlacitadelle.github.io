# Police Tactics Reference: Public-Order Doctrine for the Police AI

Design reference for the police AI in the Paris riot simulator. The player guides protest leaders across central Paris over 7 in-game days, trying to reach the Élysée. The police AI tries to contain, split and disperse.

**Scope.** This document covers doctrine and game mechanics only. It describes what police forces do and how crowds respond, so the AI behaves believably. It does not give operational advice for confronting police.

**How to read the numbers.** Each figure is marked as one of two kinds:
- **[src]**: taken from a cited source.
- **[design]**: a game-tuning estimate based on the sources, video-documented practice and pedestrian-dynamics literature. Tune these freely.

---

## 0. Doctrine in one page

French public-order doctrine (*maintien de l'ordre*, MO) rests on a few ideas that should shape the AI's personality.

1. **Keep distance first, make contact second.** Classic French MO, as practised by CRS and Gendarmerie mobile, aims to hold the crowd at a distance with lines, vehicles, gas and water rather than through hand-to-hand contact. The force escalates step by step: dialogue → *barrage* (static line) → *charge* / *bond offensif* → tear-gas grenades → dispersal grenades. Firearms are reserved for self-defence. [src: https://fr.wikipedia.org/wiki/Gendarmerie_mobile]
2. **Since the Gilets jaunes, doctrine is more mobile and more arrest-focused.** The *Schéma national du maintien de l'ordre* (SNMO, 16 Sept 2020, revised 15 Dec 2021) generalised mobile urban units (BRAV-M, BAC, compagnies d'intervention) for targeted arrests inside crowds, plus "mobility" to reach people who break off from the procession. [src: https://fr.wikipedia.org/wiki/Sch%C3%A9ma_national_du_maintien_de_l%27ordre ; https://www.politis.fr/articles/2025/09/10-septembre-mode-demploi-de-la-repression/]
3. **Sommations are required before force.** The exception is when police are attacked or cannot otherwise hold their ground (Code de la sécurité intérieure L211-9 and R211-11). [src: https://www2.assemblee-nationale.fr/questions/detail/14/qe/88293/(vue)/pdf]
4. **Always leave an exit.** The 2021 SNMO allows encirclement (*nasse*) only to prevent or stop serious, imminent violence. It must always include a controlled exit point and last no longer than strictly necessary. [src: https://reporterre.net/Revision-en-trompe-l-oeil-des-mesures-de-maintien-de-l-ordre ; Conseil d'État 10 June 2021 n°444849 https://www.conseil-etat.fr/fr/arianeweb/CE/decision/2021-06-10/444849]
5. **Crowd psychology pushes back.** Indiscriminate force unifies and radicalises crowds, as described by the Elaborated Social Identity Model (ESIM, Reicher/Stott/Drury). Targeted, legitimate-looking action and liaison work reduce conflict. [src: https://impact.ref.ac.uk/casestudies/CaseStudy.aspx?Id=28487]

The AI's core design tension follows from this: every forceful tactic buys short-term control and pays for it in crowd anger, cohesion, public opinion and police fatigue.

---

## 1. Unit organisation, numbers, speeds, endurance, equipment

### 1.1 France: the two national mobile forces (*forces mobiles*, UFM)

| Force | Parent | Size of national force | Company/squadron | Sub-units | Notes |
|---|---|---|---|---|---|
| **CRS** (Compagnies républicaines de sécurité) | Police nationale | ~13,000 people; **60 companies of ~130** plus specialised companies [src: https://fr.wikipedia.org/wiki/Compagnies_r%C3%A9publicaines_de_s%C3%A9curit%C3%A9] | ~130 on paper (100–150 gardiens). A parliamentary target was **145** per company; most companies were running on 3 operational sections instead of 4 [src: https://www.assemblee-nationale.fr/dyn/15/amendements/2272C/AN/1386.pdf] | 4 sections: 1 command/support + operational sections (SAM *section d'appui et de manœuvre*, SPI *section de protection et d'intervention*). A company splits into **Demi-Alpha / Demi-Bravo**. Each section has 3 groups (A, B, C, with C as command) [src: CRS wiki above] | Units rotate to the Paris region for about **one month** at a time [src: same]. **CRS 8** is a rapid-reaction unit of ~200 in 3 sections, deployable in **15 minutes** [src: same] |
| **EGM** (Escadrons de gendarmerie mobile) | Gendarmerie (military) | ~13,000 gendarmes; **~108–116 squadrons** [src: https://fr.wikipedia.org/wiki/Gendarmerie_mobile] | **110** on paper; some squadrons reinforced to about 140 with a 5th platoon [src: https://questions.assemblee-nationale.fr/dyn/14/questions/QANR5L14QE88310.pdf] | 1 command/support platoon + 4 marching platoons (*pelotons*), one of which is the **peloton d'intervention (PI)**, trained for targeted arrests [src: same] | Gendarmes spend **215–220 days a year** away from base [src: EGM wiki]. Vehicles: VMG (2 per platoon), VBRG armoured vehicles, and since 2021 the **Centaure** armoured vehicle (14.5 t, 10–12 passengers, 100 km/h, grenade launcher; 90 delivered by Oct 2024) [src: https://soframe.com/us/centaure-a-new-armoured-vehicle-to-protect-the-population ; https://www.caradisiac.com/7-passagers-100-km-h-lance-grenades-voici-le-centaure-nouveau-blinde-des-gendarmes-205118.htm] |

**Paris-specific forces (Préfecture de police, DOPC/DSPAP)**
- **Compagnies d'intervention (CI)** and **CSI** (compagnies de sécurisation et d'intervention): local riot-trained police, more contact-oriented than the UFMs.
- **DAR** (*détachements d'action rapide*), created ad hoc in Dec 2018, ~**20 agents** each. They were replaced in 2019 by **BRAV** detachments of ~**60 agents**, about two-thirds from intervention companies and one-third from public-security units. [src: Senate report r18-450 https://www.senat.fr/rap/r18-450/r18-450_mono.html]
- **BRAV-M** (*Brigade de répression de l'action violente motorisée*): motorcycle **pairs (binômes)**, one rider and one passenger/operator. The passenger dismounts to make arrests and carries a baton, LBD and grenades. Formally created in March 2019 by Préfet Delpuech. It had a dedicated motorcyclist service (24-BRAVM) from 2020 and **100+ motorcyclists by 2024**. [src: https://fr.wikipedia.org/wiki/Brigade_de_r%C3%A9pression_de_l%27action_violente_motoris%C3%A9e ; https://www.rtbf.be/article/france-la-brav-m-une-brigade-motorisee-concue-pour-intervenir-plus-rapidement-10321162]
- **BAC** (*brigades anti-criminalité*): plain-clothes or light-kit arrest teams.

**Scale on peak days**
- During the Gilets jaunes, **130+ mobile-force units** were committed on some Saturdays. On 8 and 15 Dec 2018, up to **106 EGM and 57 CRS** were engaged at the same time nationwide. [src: https://questions.assemblee-nationale.fr/dyn/15/questions/QANR5L15QE15521.pdf]
- **8 Dec 2018 (Acte IV):** 8,000 officers in Paris, 89,000 nationwide (120,000 including firefighters and others), 12 gendarmerie armoured vehicles deployed in Paris for the first time since 1958. About 10,000 protesters in Paris and 125,000 nationwide; 1,723 arrests. [src: https://www.interieur.gouv.fr/fr/Archives/Archives-des-actualites/2018-Actualites/Rassemblements-du-8-decembre-le-bilan ; https://www.senat.fr/rap/r18-450/r18-450_mono.html]
- **16 Mar 2019 (Acte XVIII):** 5,000+ forces in Paris, 7,300 preventive checks at entry points (14,000 two weeks later). About 1,500 black bloc plus ~8,500 others "violent". Champs-Élysées sacked: 27 shops looted, 79 fires. [src: Senate r18-450]

### 1.2 UK and Germany (comparison)

- **UK Police Support Unit (PSU):** 1 inspector, 3 sergeants, 18 constables, 3 drivers (+2 medics in the Met) in **3 armoured carriers**. A *serial* is one sergeant plus 6 constables, i.e. one carrier. [src: https://en.wikipedia.org/wiki/Police_support_unit_(United_Kingdom) ; https://hmicfrs.justiceinspectorates.gov.uk/glossary/police-support-unit]
- **Mounted police:** anecdotally, **one horse ≈ 6+ foot officers** for pushing and splitting crowds. Horses are used to split hostile crowds and open lanes for foot units. [src: https://gtr.ukri.org/project/966FC713-6EC6-4E6F-900D-5543250AAB0C ; https://www.college.police.uk/app/public-order-public-safety/mounted-police]
- **Germany:** *Hundertschaften* (~100–120 officers) and *BFE* (Beweissicherungs- und Festnahmeeinheiten), evidence-gathering and arrest squads comparable to the PI or BRAV. The **WaWe 10000 water cannon** carries 10,000 L, has 3 roof nozzles (2×1,200 L/min front, 900 L/min rear) and **65 m maximum range** (50 m rear). [src: https://en.wikipedia.org/wiki/Wasserwerfer_10000]
- **Hamburg G20 (2017):** up to ~20,000 police for the "Welcome to Hell" march of ~12,000. The march was stopped at its start because ~1,000 people were masked. Water cannon and gas were used, and the disorder spread over 2 days. [src: https://www.sbs.com.au/news/article/welcome-to-hell-g20-protest-march-broken-up-by-riot-police/zezwfzylu ; https://www.tt.com/artikel/13186384/kundgebung-welcome-to-hell-gestartet-polizei-12-000-teilnehmer]

### 1.3 Game unit model (recommended)

Use the **section/peloton (~25–30 officers)** as the atomic tactical unit on the map, and the **company/squadron (4 sections)** as the commander's allocation unit.

| Game unit | Real analogue | Strength | Frontage held (2 ranks) | Vehicles | Role tags |
|---|---|---|---|---|---|
| `LineSection` | CRS section / EGM peloton | 25 [design; derived from 110–130 ÷ 4] | **12–15 m** shield line + small reserve [design: ~1 officer per 1.0–1.2 m of front, 2 ranks] | 3 vans (`fourgon`) | cordon, advance, charge, gas |
| `Company` | CRS company / EGM squadron | 4 × `LineSection` (≈100 effective) | **40–60 m**; can seal a Haussmann boulevard (~30–36 m façade to façade) with a reserve | 12–14 vans + command car | allocation unit |
| `InterventionPlatoon` | EGM PI / CI section | 20–25 | n/a | 3 vans | snatch, arrest, protected charge |
| `MotoPairGroup` | BRAV-M | 18–20 bikes (36–40 people) [design; real deployments vary] | n/a | motorcycles | fast response, snatch, dispersal of small groups |
| `WaterCannon` | PP/Gendarmerie *lanceur d'eau* | 1 vehicle + escort section | blocks 1 lane; spray 20–50 m effective, 65 m max | — | area denial, push, extinguish fires |
| `Armoured` | VBRG / Centaure | 1 vehicle | clears barricades, carries 10–12 | — | barricade clearing, shock |
| `LiaisonTeam` | dialogue police / PLT / SNMO liaison | 2–4 | — | on foot | de-escalation, intel |
| `Mounted` (optional, not standard in Paris MO) | Garde républicaine cavalry / UK mounted | 4–8 horses | 1 horse ≈ 6 officers | horsebox | split, push |

### 1.4 Speeds and movement

| Movement | Speed | Notes |
|---|---|---|
| Unit in full riot kit, walking formation | **1.0–1.2 m/s** [design] | Unencumbered pedestrians walk at 1.34 m/s free flow [src: Weidmann via https://arxiv.org/pdf/physics/0506170]. Shields, helmets and 10–15 kg of kit slow formations down. |
| Line advance in contact ("pas cadencé", shields up) | **0.3–0.6 m/s** [design] | Deliberate, stops to re-align every 10–20 m. |
| Charge / *bond offensif* sprint | **3.5–5 m/s** for **15–50 m** [design] | French doctrine treats the *bond* as short and limited: the unit rushes, then stops and re-forms. It does not chase. |
| Pursuit by arrest squads on foot | 4–6 m/s, ≤100 m from support [design] | |
| BRAV-M motorcycles in streets | 8–15 m/s (30–55 km/h) [design] | Can move through side streets the crowd also uses. |
| Vans repositioning | 5–10 m/s through cleared streets; blocked by crowds and barricades [design] | |
| CRS 8 rapid reaction | ready to move in **15 min** [src: CRS wiki] | |

### 1.5 Endurance, fatigue, relief

Real-world anchors:
- Gilets jaunes Saturdays meant **chained weekends with no recovery**. Unions spoke of exhaustion and nervousness [src: https://www.europe1.fr/node/280475 ; https://www.tendanceouest.com/actualite-304981-securite-au-bord-de-la-rupture]. One CRS officer had only **2 rest days a week** [src: https://www.sudradio.fr/societe/un-crs-temoigne-la-premiere-fois-que-je-faisais-face-a-une-telle-violence]. Unpaid overtime reached **>24 million hours**, valued at ~€250 M [src: https://questions.assemblee-nationale.fr/dyn/15/questions/QANR5L15QE15521.pdf].
- The Senate found **~30-minute delays** between field requests and command authorisation on 16 Mar 2019, and units kept "in reserve" while able to act [src: Senate r18-450]. This is a good model for **command latency**.

Game fatigue model [design]:
- `fatigue` runs from 0 to 100 per unit.
  - Passive standby (in vans): +2/h.
  - Static cordon, no contact: +6/h.
  - Static cordon under projectiles: +20/h.
  - Line advance: +0.5 per 10 m.
  - Charge: +8 each.
  - Snatch: +5 each.
  - Using gas: +2 per volley, because masks reduce endurance.
- Above 60: −25% speed, −30% cordon strength, higher chance of unauthorised force (see §4.5).
- Above 85: the unit must be relieved. It retreats to its vans.
- Recovery:
  - In vans: −15/h.
  - Overnight rest: −60, but **only if the unit got 8 h off**.
  - A carry-over floor of +10 per consecutive day engaged represents residual fatigue across the week.
- **Shift length.** A day typically runs 12 h on duty with about 4–6 h of active engagement. On peak days, allow up to 16–18 h but apply heavy fatigue.
- **Relief rotation.** The commander should rotate a contact unit every **60–120 min of active contact** with a fresh section from reserve. Handing over a line takes **2–4 min**, and the line is weak during that window.

### 1.6 Equipment (for effect modelling)

| Item | Real data | Game effect |
|---|---|---|
| Shields, helmets, protective kit | standard | cordon strength |
| **GM2L** tear-gas grenade (replaced the GLI-F4 in Jan 2020) | 56 mm, 10 g CS, **145 dB at 10 m**. Hand-thrown or fired from the Cougar 56 mm launcher at 50/100/200 m [src: https://www.acatfrance.fr/public/carteid-armes.pdf ; https://www.hrw.org/fr/news/2020/01/29/la-police-francaise-va-cesser-dutiliser-des-grenades-lacrymogenes-explosives] | gas cloud + noise shock |
| CM6 / MP7 tear-gas grenades | classic CS grenades, launcher or hand | gas cloud |
| **GENL** (*grenade à éclats non létale*), dispersal grenade | replaced the GMD [src: SNMO wiki] | short-range panic and dispersal, injury risk → anger |
| **LBD 40** (40 mm less-lethal launcher) | Since the SNMO, each LBD shot by urban units (BAC, CI, BRAV-M) requires a **supervisor** [src: SNMO wiki]. Commonly reported doctrinal range 10–50 m [src: ACAT doc above]. **~13,000 shots** during the Gilets jaunes, 50–60% of them between 8 Dec and 5 Jan [src: Senate r18-450] | single-target stop; major legitimacy cost on injury |
| Water cannon | see §1.2, §2.10 | push / denial |
| VBRG / Centaure armour | barricade clearing | |
| Anti-intrusion barriers (*grilles anti-émeutes* / *barre-pont*) | multi-metre mobile barriers mounted on trucks, used to seal streets around the Élysée, with a small door for residents [src: https://www.europe1.fr/node/275650] | impassable wall, needs a guard section |
| Red flare and loudspeakers | used for sommations [src: AN QE 88293] | sommation event |
| Illuminated signs, social media | SNMO communication tools [src: SNMO wiki] | liaison effectiveness |

---

## 2. Tactics catalogue

Shared parameters used in the AI specs below:
- `crowd.density` in persons/m².
- `anger` 0–100: hostility toward police.
- `cohesion` 0–100: shared identity, how much the crowd acts as one.
- `morale` 0–100: will to continue.
- `opinion`: a national public-opinion meter.
- `radicals%`: share of the crowd willing to fight.
- `legit`: the crowd's perception of police legitimacy, 0–100. Most backfire effects run through `legit` (see §4.5).

### 2.1 Static cordon / barrage (FR *barrage*, *ligne fixe*; EN static cordon, police line)

**What it is.** A line of officers, often backed by vans parked nose-to-tail or by anti-intrusion barriers, that closes a street. It is the basic MO building block.

**When it's used.** To protect sensitive points, mark the end of an authorised route, stop a breakaway, or deny an axis.

**Preconditions.**
- One section can hold about 12–15 m of front. A company can hold a 30–36 m Haussmann boulevard with depth.
- Narrow streets (rue du Faubourg Saint-Honoré, ~10–12 m) need only 1 section, ideally with a vehicle or barrier. Wide avenues (Champs-Élysées ~70 m) need 2 companies or vehicle barriers.

**How it ends.**
- The crowd leaves or is redirected.
- The line is relieved.
- The line is flanked through side streets, which is the classic failure.
- The line is overrun. On 1 Dec 2018 at Étoile, static positions were swamped and the Arc de Triomphe was sacked [src: https://www.senat.fr/rap/r18-450/r18-450_mono.html].

**Risks.**
- Static lines are vulnerable to projectiles and fatigue, and they invite confrontation at the line.
- They tie down many units. Gilets jaunes command learned that **fixed points cost mobility**.

**Game AI spec**
```
StaticCordon:
  units_required: ceil(street_width_m / 13) LineSections (+1 reserve if threat > medium)
  with_barrier_vehicle: halves units required (min 1)
  anti_intrusion_barrier: impassable; needs 1 LineSection guard
  setup_time_s: 60–120 (sections dismount and form); 300 for barrier trucks
  blocking: crowd cannot pass while cordon_strength > crowd_push
  cordon_strength = officers_present * (1 - fatigue/150) * (barrier ? 3 : 1)
  crowd_push = front_density * front_width_m * radicals% * anger/50
  breach: if crowd_push > cordon_strength for 30 s -> line breaks, unit routs 30 m, fatigue +20
  effect_on_crowd: halts flow; anger +1/min while contact (frustration); +3/min if crowd > Fruin E at the line
  fatigue: +6/h idle, +20/h under projectiles
  cooldown: none; relief every 90 min of contact
```

### 2.2 Mobile line advance / push (FR *progression*, *refoulement*; EN line advance, push back)

**What it is.** A line, or two lines in echelon, walks forward behind shields to push the crowd back along an axis, usually toward a dispersal area. Vans or water cannon follow behind.

**When it's used.** After sommations, to clear a square or retake an axis.

**Preconditions.**
- Width coverage as for a cordon. The flanks must be covered at each intersection the line passes, otherwise the crowd flows round behind it.
- Doctrine says to always leave the crowd a **direction to go**.

**How it ends.** The line reaches its objective line (usually an intersection it can seal), or it stalls against a dense crowd.

**Risks.**
- Pushing a dense crowd with no space behind it causes crushing (Fruin F), panic and escalation.
- Exposed flanks get bypassed.

**Game AI spec**
```
LineAdvance:
  units_required: cordon_units(width) + 1 per side street to seal en route (or accept flank leak)
  speed_mps: 0.3–0.6 in contact, 1.0 unopposed
  precondition: sommations_done (unless self-defence), exit_route_exists behind crowd
  effect: crowd displaced at advance speed if crowd density behind front < 2.5 p/m2; else stall
  stall -> crowd_push contest as StaticCordon
  side-street leak: each unsealed street passes up to Fruin-flow (≈1.2 p/m/s * width) of crowd around the line
  anger: +2 per 50 m pushed; +10 if crowd pushed into a dead end (no exit)
  fatigue: +0.5 per 10 m, +20/h under projectiles
  cooldown: re-form 60 s after reaching objective
```

### 2.3 Charge / offensive bound (FR *charge*, *bond offensif*; EN baton charge, short offensive rush)

**What it is.**
- A *charge* is a fast rush by a formed line to break contact, push back a front rank, or grab ground.
- A *bond offensif* is the limited version: rush 15–50 m, then stop and re-form. In the escalation ladder it comes after the barrage and before gas [src: EGM wiki].
- Post-2019 Paris doctrine favours multiplying charges and quick dispersal manoeuvres [src: https://www.politis.fr/articles/2025/09/10-septembre-mode-demploi-de-la-repression/].

**When it's used.**
- To break a front line that is throwing projectiles.
- To create space for a snatch.
- To stop a crowd from building up at a cordon.

**Preconditions.**
- Sommations given, unless the unit is under attack.
- A reserve holds the original line.
- Open space behind the crowd, so it can flee.

**How it ends.** The unit halts at its bound limit and either re-forms there or falls back.

**Risks.**
- Over-extension: the unit gets isolated or surrounded.
- Indiscriminate baton use hits peaceful protesters and pushes `legit` down (ESIM).
- Panic and falls in dense crowds.

**Game AI spec**
```
Charge:
  units_required: 1–2 LineSections (+1 holding reserve)
  range_m: 15–50 (bond), max 80 (full charge); speed 3.5–5 m/s
  windup_s: 5 (order + form); duration_s: 10–20; regroup_s: 30–60
  cooldown_s: 120 per unit
  effect: crowd within 20 m of front displaced 20–60 m;
          front-rank density drop 50%; 5–15% of affected crowd disperses (leaves map area)
          if density > 3 p/m2: panic event (trampling risk, injuries -> legit -5)
  anger: peaceful majority +8, radicals +4; cohesion +5 (common fate); morale of moderates -5
  arrests: enables 1 snatch attempt at +30% success
  fatigue: +8
  risk: if crowd flanks (crowd size in 50 m > 10x unit strength) -> unit isolated, chance of being surrounded
```

### 2.4 Kettle / encirclement (FR *nasse*, *encerclement*; EN kettle, containment)

**What it is.** The crowd, or part of it, is fully surrounded and cannot leave, or can leave only through a filter (see 2.5).

**Legal limits.**
- **France:**
  - The Conseil d'État (10 June 2021) annulled the 2020 SNMO provision on encirclement because it did not define precisely when it could be used [src: https://www.conseil-etat.fr/fr/arianeweb/CE/decision/2021-06-10/444849 ; https://www.lemondedudroit.fr/public/282-droit-public-general/76103-manifestations-annulation-partielle-du-schema-du-maintien-de-l-ordre.html].
  - The **Dec 2021 revision** re-authorised it only "to prevent or stop serious and imminent violence against persons and property". It must **always keep a controlled exit** and last only as long as strictly necessary and proportionate [src: https://reporterre.net/Revision-en-trompe-l-oeil-des-mesures-de-maintien-de-l-ordre ; https://blog.landot-avocats.net/2021/12/29/voici-la-version-mise-a-jour-du-schema-national-du-maintien-de-lordre-snmo/].
  - The court also annulled the obligation for journalists to leave during dispersals [src: same].
- **UK:** In *Austin v Commissioner* [2009] UKHL 5, a 7-hour kettle at Oxford Circus (May Day 2001) without food, water or toilets was held not to be a deprivation of liberty under ECHR Art. 5. Crowd-control measures stay lawful if they are non-arbitrary, in good faith, proportionate, and no longer than reasonably necessary. The ECtHR agreed in 2012 [src: https://mentalhealthlaw.co.uk/Austin_v_Commissioner_of_Police_of_the_Metropolis_(2009)_UKHL_5 ; https://www.hrlc.org.au/case-summaries/austin-ors-v-united-kingdom-2012-echr-459-15-march-2012].
- **Hong Kong:** PolyU, 17–29 Nov 2019. Police surrounded the campus and arrested anyone who left: **>1,100 arrested**, ~800 left on 19 Nov, including ~300 minors released without immediate arrest [src: https://en.wikipedia.org/wiki/2019_Hong_Kong_Polytechnic_University_campus_conflict].

**When it's used.** To isolate a violent group (e.g. a black bloc) from the rest of a march, or to stop a breakaway from reaching a sensitive zone.

**Preconditions.**
- Enough units to close every exit. In a street segment between two intersections, that means 2 cordons plus every side street and passage.
- Intelligence that the group is the violent one.

**How it ends.**
- Release through the exit, or ID checks and arrests at a filter.
- Mass arrest. Paris, 16 Mar 2023: after the Concorde gathering, **292 were taken into custody and 283 cases dropped** [src: https://www.ldh-france.org/wp-content/uploads/2023/05/Arrete-n%C2%B02023-00324-du-24-mars-2023-et-modificatif-n%C2%B02023-00333-du-25-mars-2023.pdf ; https://www2.assemblee-nationale.fr/questions/detail/16/qe/6780/(vue)/pdf]. This is a strong "legitimacy cost" data point.

**Risks.**
- Catches bystanders and journalists.
- Creates crush risk.
- Large ESIM backfire: the kettled crowd unifies, and outside crowds converge to "free" it.
- Legal and media costs.

**Game AI spec**
```
Kettle (full, no exit) — only allowed in game if "hardline" escalation >= 4 AND triggers legal penalty:
  units_required: 1 cordon per exit (street width/13 sections each) + 1 reserve
  setup: all closing cordons must arrive within window_s = 120, else crowd leaks
  geometry_bonus: block between two intersections with no side streets = cheapest
  effect: kettled crowd movement 0; density rises if police compress (avoid > 4 p/m2 = crush)
          anger +5/10 min, cohesion +10 immediately, radicals% +5%/30 min (ESIM)
          outside crowds within 500 m: attraction toward kettle (+morale, +anger)
  legit: -10 immediately (France post-2021: -20 and a "Conseil d'État/press" event if no exit)
  duration: max 2–4 h before forced release event; each extra hour opinion -3
  release: 'filtered release' (see 2.5) or 'mass arrest' (arrests = 20–40% of kettled; opinion -10, legit -10)
  fatigue: +10/h per cordon unit (static, tense)
```

### 2.5 Kettle with filter exit / filter cordon (FR *nasse avec point de sortie contrôlé*, *dispositif de filtrage*; EN filter cordon, filtered containment)

**What it is.**
- A containment with a deliberate opening, a gap of a few metres in one cordon. People leave one by one or in small groups through it, and may be checked (ID, bag search, removal of masks or banned objects) or photographed.
- A *filter cordon* (UK) is a line that lets people pass selectively.
- **French doctrine after 2021 requires this exit.**
- The French *dispositif de filtrage* is also used **before** a march: preventive checks at entry points. 7,300 checks on 16 Mar 2019 and 14,000 on 30 Mar 2019 [src: Senate r18-450].

**When it's used.** To bleed off peaceful participants while holding suspected offenders, or to end a kettle legally.

**Preconditions.** As for a kettle, plus 1 filter team (a section) at the gap and an OPJ (judicial police officer) for arrests.

**How it ends.** The kettle is drained.

**Risks.** It is slow. Long queues raise anger, and the filter becomes a crush point if the crowd surges.

**Game AI spec**
```
FilterExit:
  extends Kettle; legal under FR doctrine
  gap_width_m: 2–4
  throughput: 0.3–0.6 persons/s per metre of gap when checking IDs; 1.2 p/m/s if no checks (free flow)
  check_mode: none | id_check | search_and_photo
  arrest_rate_at_filter: 2–5% of passers (id_check), 5–10% (search) [design]
  effect: kettled crowd leaves at throughput; moderates leave first (morale<50 leave 3x faster), radicals stay
          -> radicals% of remaining crowd rises over time (natural "concentration" of hard core)
  anger: +2/10 min for those waiting (vs +5 for full kettle); legit -3 (vs -10/-20)
  preventive filtering (pre-march): at metro/station entries; removes 1–3% of radicals before march, small anger +1
```

### 2.6 Funnel / "fish trap" (EN funnelling, channelling; FR *canalisation*, *couloir*)

**Terminology.** No established police-doctrine term "fish trap" turned up in English or French sources. Searches return only general kettling material [src: https://bigthink.com/politics-current-affairs/kettling-controversial-police-tactic ; https://www.wordorigins.org/big-list-entries/kettling]. The closest real concepts are:
1. **Channelling or canalisation.** The march route is lined with cordons and vehicles on every side street, so the crowd can only go one way, toward a planned dispersal point (e.g. Nation, Place Vauban). This is how authorised Paris marches are routinely managed: side streets held, route declared in advance (see §5).
2. **Funnel to a controlled exit.** A wide space is closed down until it empties through a narrow, monitored exit. This is a filter kettle (2.5) built on geography.
3. **Trap configuration.** A crowd is allowed to enter a space whose far end is pre-blocked. Once inside, the rear is closed and it becomes a kettle, with or without a filter. This is what activists informally describe as being "funnelled into a trap". Hamburg's "Welcome to Hell" march was stopped almost immediately after starting on a riverside street, then dispersed with water cannon and gas [src: SBS link above].

**Game use.** Treat "fish trap" as a **compound tactic**: Channel → Block head → Close tail → Filter exit.

**Risks.** Very high ESIM backfire if the trap is perceived as a set-up. Panic at the head when the crowd discovers the block.

**Game AI spec**
```
FunnelTrap (compound):
  phase A Channel: StaticCordon on every side street along a route segment (L metres); units = side_streets * 1
  phase B Head block: StaticCordon (+barrier vehicle) at segment end, positioned out of sight (around a bend/at a square exit)
  phase C Tail close: 1–2 sections + MotoPairs arrive behind crowd tail within 90 s of head contact
  phase D: FilterExit at a side street with gap 3 m
  detection: crowd scouts detect pre-positioned head block with p = 0.4 + 0.1 * scouts (player counterplay)
  effect: as Kettle+FilterExit; extra anger +10 on trap closure ("set-up"), cohesion +15
  fatigue: phase A units low (+6/h), C high (+8 sprint)
```

### 2.7 Splitting a march (FR *scinder / fractionner le cortège*, *coupure*; EN splitting, cut-through)

**What it is.** Police insert a line across the march, usually at an intersection, separating front from back. Typical goals: cut off a violent "cortège de tête" from the union procession behind it, or split a big crowd into pieces that are easier to manage. The SNMO stresses mobility to deal with groups that break off from the procession [src: politis SNMO summary above].

**Preconditions.**
- An intersection with side-street access for the cutting unit.
- Two cordons, one facing each way, about 10–20 m apart (a "double line").
- Ideally a gap in the march (between union blocks) or a thin moment.
- Horses are classically used to cut crowds [src: UKRI mounted project].

**How it ends.** The front part is pushed one way and the rear is re-routed or allowed to continue.

**Risks.**
- Units in the gap are exposed on both sides.
- Unions and stewards see it as illegitimate if the "good" march gets hit.

**Game AI spec**
```
SplitMarch:
  units_required: 2 LineSections per street width chunk (face both ways) + 1 reserve
  target: intersection with side-street access; or march gap where linear density < 1 p/m2
  insertion_time_s: 30 (at gap) ; 90+ through crowd (requires Charge first)
  effect: crowd graph split into two crowd entities at cut point; each inherits leaders present in its part
          leaderless fragment: cohesion -20, morale -10, tends to stall/disperse 2x faster
          fragment containing radicals: anger +5
  success chance: base 0.7 at gap; 0.3 through dense crowd (>2 p/m2); +0.2 with Mounted
  fatigue: +8 (insertion) +20/h (two-front exposure)
  cooldown_s: 300
```

### 2.8 Pincer (FR *prise en tenaille*; EN pincer)

**What it is.** Two forces converge on a crowd from opposite ends or from flanks to compress it, grab a group, or force it into a side street. It is used in Hong Kong 2019 clearance operations and by French forces combining CI/BRAV with line companies. Without an exit it becomes a kettle.

**Preconditions.** Two units with separate approach routes, and coordination: arrival times within about 60–120 s.

**How it ends.** The crowd escapes through the deliberately open side (the doctrinal version), or it is kettled.

**Risks.** Same as kettle. Crush if both pincer arms push while the exit is too small.

**Game AI spec**
```
Pincer:
  units_required: 2 groups (each >= cordon for its street) ; optional MotoPairs as fast arm
  sync_window_s: 90 (if second arm late -> crowd flows away from first arm, no compression)
  must_leave_exit: true unless escalation >= 4 (then = Kettle)
  effect: crowd displaced toward exit at 1.0–1.5 m/s; 20–40% of crowd disperses through exit and leaves area;
          remainder fragments (split into 2–3 groups) with prob 0.5
  anger +6, panic +15 near exit if exit_width < crowd_flow_needed
  fatigue: +10 per arm
```

### 2.9 Tear gas barrage (FR *grenades lacrymogènes*, *gazage*; EN tear gas / CS)

**What it is.** CS grenades thrown by hand (to ~30–40 m) or fired from 56 mm launchers (50/100/200 m), e.g. GM2L or CM6 [src: ACAT carteid]. It makes an area unbearable, so people leave it.

**Data.**
- The visible discharge cloud lasts only **~20 s**, but the agent keeps dispersing invisibly. In one CFD study of Santiago (Plaza de la Dignidad), hazard thresholds were exceeded at a point for **~185 s** [src: https://muac.unam.mx/guionde-gases-lacrimogenos-en-plaza-de-la-dignidad?lang=en].
- Crowds **break and scatter, then re-form as the gas clears** and advance again. Repeated gassing can stop dispersing crowds and instead unite them against police [src: same; Hong Kong observations https://collection.news/appledaily/articles/EZW5QWBDRVG5DZQTRFGQ3NTY3I].
- **Hong Kong 2019:** about **16,000 tear-gas rounds and 10,000 rubber rounds in 6 months**, with 6,022 arrests [src: https://hongkongfp.com/2019/12/10/hong-kong-police-used-crowd-control-weapons-30000-times-since-june-6000-arrests/].
- **Paris, 1 Dec 2018:** gas volleys blocked the march at Hôtel-de-Ville and on rue de Rivoli, pushing it into rue du Temple. Gas is often used to **steer** crowds, not just to disperse them [src: https://fr.vikidia.org/wiki/Gilets_jaunes].

**When it's used.** After sommations, against crowds that refuse to disperse, or immediately when police are attacked. Also for area denial in front of a cordon.

**Preconditions.**
- **Wind**: police fire from upwind. A wind toward the police makes gas self-defeating.
- An escape route for the crowd. Gassing a crowd that cannot leave causes panic.
- Narrow streets hold gas longer. Open squares and wide boulevards clear faster.

**How it ends.** The cloud dissipates and the crowd either disperses for good or re-forms.

**Risks.**
- It hits bystanders, residents and police too.
- Indiscriminate effect means a big `legit` drop and anger.
- It produces radicalised returners: protesters who come back better prepared with masks and goggles.
- Habituation: each gassing has a smaller effect on the same crowd.

**Game AI spec**
```
TearGas:
  units_required: any LineSection (hand: 1 grenade per 15 s per grenadier, 2 grenadiers/section),
                  launcher-equipped: range 50/100/200 m
  hand_range_m: 25–35 ; launcher_range_m: 50–200
  cloud: radius_m 8–12 per grenade at t=0, grows to 15–20 at 60 s; concentration halves every 45 s in open air,
         every 90 s in narrow streets (width < 15 m), every 30 s if wind > 5 m/s
  drift: cloud centre moves downwind at 0.5 * wind_speed (m/s); wind randomised per hour (Paris mean 3–5 m/s, prevailing SW/W)
  effective_duration_s: 60–120 open, 120–240 confined (anchor: 185 s CFD)
  volley: 4–8 grenades = area denial ~30x30 m for ~2–3 min
  effect on crowd in cloud:
     move away perpendicular to cloud gradient, preferring upwind and open exits, at 1.5–2.5 m/s
     displacement 40–120 m; 10–30% leave area permanently (1st gassing), 5–15% (later gassings: habituation x0.6 per repeat)
     re-form: 60–70% of displaced return within 3–8 min if leaders present and anger > 50
     panic: if no exit within 30 m or density > 3 p/m2 -> panic event (falls/injuries)
  anger: +6 (1st), +4 each repeat; bystanders/residents in cloud: opinion -1 per volley in residential street
  cohesion: +5 (common fate)
  equipment counterplay: crowd fraction with masks/goggles (rises +5%/day of repeated gas) -> effect x(1-0.7*masked%)
  self-gassing: if cloud drifts onto police units -> their fatigue +5, cordon_strength -30% for duration
  cooldown_s: 30 per grenadier; stock per section per day: 40–80 grenades [design]
  fatigue: +2 per volley (masks)
```

### 2.10 Water cannon (FR *lanceur d'eau* / *canon à eau*; DE *Wasserwerfer*; EN water cannon)

**What it is.** An armoured truck that sprays water, sometimes with dye or an irritant, to push people back, deny an area, or put out fires on barricades. Used in Paris since Dec 2018 [src: interieur.gouv.fr bilan 8 Dec]. German WaWe 10000: 10,000 L, 65 m range, 2×1,200 L/min front [src: https://en.wikipedia.org/wiki/Wasserwerfer_10000]. At full output it empties in **~4–6 min of continuous fire**, so in practice it fires in bursts.

**When it's used.** To clear a square or avenue, push back a front line, protect a cordon from projectiles, or extinguish barricade fires.

**Preconditions.**
- Wide axes. It needs about 3 m width plus escort and cannot work in narrow medieval streets.
- An escort section on both sides. Vulnerable to being surrounded when alone.
- A refill point.

**How it ends.** The tank is empty or the area is cleared.

**Risks.**
- Injuries at short range (<10–20 m).
- Images on TV that cost legitimacy.
- Slows the line's tempo.

**Game AI spec**
```
WaterCannon:
  units_required: 1 WaterCannon + 1 LineSection escort
  range_m: effective 20–50, max 65 ; arc width ~10 m per nozzle
  tank: 10 000 L ; burst = 10 s uses ~400 L ; ~25 bursts per tank ; refill 20–30 min (off-map/hydrant point)
  effect: crowd in jet displaced 10–30 m per burst; front-rank dispersal 10–20% per burst;
          extinguishes fire/barricade in 1–3 bursts; cold weather multiplier x1.5 effect (and x1.5 anger)
  injury_chance: 2% per burst if target < 15 m (legit -5 on injury)
  anger: +3 per burst; less "indiscriminate" than gas (affects only targeted front), cohesion +2
  movement: 3–8 m/s; can't enter streets < 8 m wide or crowded > 2 p/m2 without escort
  cooldown_s: 10 between bursts
```

### 2.11 Snatch / arrest squads (FR *interpellation*, *unités d'interpellation*, BRAV-M, PI; EN snatch squads, arrest teams)

**What it is.** Small fast teams (PI, BAC, CI, BRAV-M pairs) go into or beside the crowd to arrest identified offenders, then pull out to the cover of a line. BRAV-M pairs (rider + operator) reach the area fast by motorcycle and the operator dismounts [src: RTBF and Wikipedia above]. Doctrine stresses that arrests should rest on an observed offence (throwing projectiles, violence) [src: politis SNMO summary]. After March 2019, the Senate urged joint training of line units and BRAV for "complementarity" [src: https://www.publicsenat.fr/actualites/politique/violences-le-senat-fait-9-propositions-pour-adapter-le-maintien-de-l-ordre-a].

**When it's used.** Against projectile throwers at the crowd edge, small breakaway groups (wrecking shops on side streets), and to break up gatherings after dispersal (the "mopping-up" phase).

**Preconditions.**
- Target identified (observation, drones, plain-clothes spotters).
- Cover from a line within ~50–100 m.
- Crowd density at the target below ~2 p/m², otherwise the team gets swallowed.

**How it ends.** Arrest made and team back behind the line, or the team withdraws if the crowd closes around it.

**Risks.**
- **High-variance legitimacy.** A precise arrest of a visible offender raises `legit` with moderates (ESIM: differentiation). An indiscriminate or brutal snatch drops it heavily.
- BRAV-M has been controversial, with a 2023 petition to dissolve it reaching ~264,000 signatures [src: BRAV-M wiki].
- The team can become isolated.

**Game AI spec**
```
Snatch (foot team: InterventionPlatoon split into 4–6 person teams):
  range_m: target within 30 m of crowd edge, team within 100 m of supporting line
  duration_s: 20–40 (in), 20 (out)
  success_p = 0.6 * (1 - front_density/3) * (target_visibility) ; +0.3 after a Charge
  failure: team surrounded p = 0.2 * anger/50 -> rescue requires Charge by a LineSection
  effect: removes 1–3 individuals (if target=leader/agitator: crowd radicals% -2..-5, morale -5 locally)
          discriminate (target committed visible offence): legit +2 among moderates, anger +2 locally
          indiscriminate (no visible offence / bystander): legit -8, anger +10, cohesion +8
  fatigue: +5
  cooldown_s: 90 per team

MotoSnatch (BRAV-M MotoPairGroup):
  speed: 8–15 m/s on clear streets; can use streets the crowd isn't on; can't enter dense crowd (>1 p/m2)
  role: chase small groups (<50) that broke off; break up post-dispersal regroupings
  effect: groups < 50 people dispersed 60–80% on arrival, 1–4 arrests; groups 50–300 dispersed 20–40%
  legit cost: -2 per operation baseline, -10 on "violent incident" (p=0.05 per op, x2 if unit fatigue>60)
  cooldown_s: 120 per group ; fatigue: +4
```

### 2.12 Push toward a dispersal route, leaving an exit (FR *dispersion*, *manœuvre de dispersion*, "toujours laisser une porte de sortie"; EN dispersal with open exit)

**What it is.** The textbook way to end an unlawful gathering:
1. Sommations.
2. Identify one or more exit routes, ideally toward metro or RER stations and away from sensitive zones.
3. Seal the other directions.
4. Push with lines, gas or water toward the exit.
5. Follow up with mobile units to stop re-forming.

The 2021 SNMO makes the exit a legal requirement even for encirclements [src: Reporterre]. This is the **default endgame** of most Paris demos. Authorised marches dissolve at the arrival square (Nation, Vauban) and police clear stragglers toward metro lines.

**Preconditions.**
- The exit route is actually passable. Width matters: flow ≈ 1.2 persons/m/s at best (Weidmann maximum) [src: https://arxiv.org/pdf/physics/0506170].
- Metro stations may be closed by the RATP on police request. If so, the crowd must walk out.

**How it ends.** The area is empty. Splinter groups are handled by motorcycle units.

**Risks.** If the exit leads toward something the crowd wants (shops, the Élysée), dispersal turns into a wild march (*manif sauvage*). Gilets jaunes groups often dispersed into roaming bands [src: Senate r18-450].

**Game AI spec**
```
DispersalPush:
  plan: choose exit E maximising (distance from sensitive zones, metro access, width) ; seal other k exits (units = k cordons)
  sequence: Sommations (2.14) -> wait 60–120 s -> LineAdvance/TearGas/WaterCannon toward E -> MotoSnatch follow-up
  exit_capacity_pps = 1.2 * exit_width_m  (cap; if crowd outflow demand > 1.5x capacity -> crush/panic risk)
  effect: crowd moves toward E; on reaching E, each tick 70% of crowd that passes becomes 'dispersed' (leaves game)
          30% become roaming groups of 20–200 that may re-form if leaders present (reform_p = 0.3/30 min)
  anger: +3 (if lawful, sommations done) ; +10 if no sommations or exit blocked
  success metric: crowd in target zone < 10% of initial within 30 min
```

### 2.13 Sensitive-zone protection: Élysée / Beauvau (FR *protection des points sensibles*, *périmètre interdit*, *zone rouge*; EN protected perimeter)

**What it is.**
- A layered perimeter around the Élysée (55 rue du Faubourg Saint-Honoré) and the Interior Ministry (Place Beauvau), often extended to the lower Champs-Élysées, Concorde and the Assemblée nationale.
- It is formalised by **prefectoral orders banning gatherings** (*arrêtés d'interdiction*) [src: https://www.publicsenat.fr/article/politique/gilets-jaunes-paris-saccage-et-paris-epargne-la-capitale-aux-deux-visages-139715 ; e.g. arrêtés 2023-00311, 2023-00324 https://www.ldh-france.org/wp-content/uploads/2023/05/Arrete-n%C2%B02023-00311-du-22-mars-2023.pdf].
- Physically: trucks with multi-metre **anti-intrusion barriers** blocking street entrances, with a small door for residents who show ID [src: https://www.europe1.fr/node/275650]. Behind the barriers sit static units, the Garde républicaine (Élysée's own guard) and armoured vehicles.

**Three-layer model.**
1. **Outer filter ring** (300–800 m): preventive checks, BRAV-M patrols, banned-area enforcement (fines, dispersal).
2. **Hard ring** (50–300 m): anti-intrusion barriers on every street into the Élysée/Beauvau block, plus 1 section each, plus a water cannon on the main approaches (Concorde, rue Royale, Champs-Élysées/Rond-Point).
3. **Core:** Élysée guard. Reaching it is the player's win condition. Make it a very strong but **finite** defence.

**Risks.** Perimeter duty soaks up units (a "fixed point"). The Gilets jaunes showed that protecting the Élysée left fewer units elsewhere, so the Champs-Élysées and Étoile were sacked (1 Dec 2018, 16 Mar 2019) [src: Senate r18-450].

**Game AI spec**
```
SensitivePerimeter:
  rings: outer (radius 600 m, soft), hard (radius 200 m, barrier per entry street), core (Élysée)
  hard_ring entries (approx.): rue du Faubourg Saint-Honoré E & W of Élysée, avenue de Marigny, rue de l'Élysée,
                       avenue Gabriel, rue des Saussaies, rue de Miromesnil (Beauvau), rue d'Anjou, rue Boissy-d'Anglas,
                       rue Royale/Concorde side — 8–12 entries
  per entry: 1 barrier truck (impassable while guarded) + 1 LineSection ; main approaches +1 WaterCannon
  barrier breach: requires crowd_push > 3x cordon AND radicals >= 200 at entry for 120 s (rare); or guard unit removed
  outer ring: arrêté d'interdiction active -> any gathering inside gets immediate sommations + MotoSnatch
  minimum allocation rule: never < 25% of available units on perimeter when a crowd > 5 000 is within 1.5 km
  escalation trigger: crowd inside outer ring -> commander releases reserves to perimeter and enables Kettle option
```

### 2.14 Sommations before force (FR *sommations*; EN dispersal warnings / legal warnings)

**Legal procedure (CSI L211-9, R211-11).**
- An unlawful gathering may be dispersed by force **after two sommations without effect**.
- They are issued by an authorised official (prefect, commissaire, OPJ) wearing the **tricolour sash**, so they are clearly identifiable. They are announced by loudspeaker and each is accompanied by **red flares**.
- An OPJ stays next to the unit commander, and specifies the type of force or munition before each use.
- Exception: force without sommations if police are attacked or cannot otherwise defend the ground they hold [src: https://www2.assemblee-nationale.fr/questions/detail/14/qe/88293/(vue)/pdf].
- The 2020/2021 SNMO modernised the wording: "**Nous allons faire usage de la force. Quittez immédiatement les lieux.**" (formerly "Obéissance à la loi, dispersez-vous") [src: https://reporterre.net/Revision-en-trompe-l-oeil-des-mesures-de-maintien-de-l-ordre]. The SNMO also adds illuminated signs and social-media messaging [src: SNMO wiki].
- People who stay after sommations commit the offence of participating in an unlawful gathering, which is why they enable arrests.

**Game AI spec**
```
Sommations:
  actor: any Company with an attached 'Authority' token (commissaire/OPJ); 1 per company
  sequence: S1 (announce + red flare) -> wait 30–60 s -> S2 -> wait 30–60 s -> force allowed in radius 150 m for 30 min
  audibility: loudspeaker 100–150 m in street; crowd beyond it not "warned" (if force used on unwarned crowd -> legit -5)
  effect: 10–25% of moderates leave on S1, +5–10% on S2 (lower if anger > 70; higher if liaison active)
          converts remaining participants to "unlawful assembly" -> arrests legal, snatch legit penalty halved
  skip (self-defence): allowed if police unit took projectiles in last 60 s; legit -3 if crowd sees it as unjustified
  cooldown: valid 30 min per area
```

### 2.15 Dialogue, liaison, de-escalation (FR *dialogue / contact avec les organisateurs*, *équipes de liaison*; EN liaison policing, Police Liaison Teams, dialogue police)

**What it is.**
- Negotiating routes with organisers and union stewards (*service d'ordre*).
- Liaison officers in light uniform circulating in the crowd.
- Communicating intentions over loudspeaker, signs and social media.
- A **low-profile posture**: riot units kept out of sight in vans, and only offenders targeted.

**Evidence.**
- Sweden built its **dialogue police** after the Gothenburg 2001 shootings. They are credited with reducing conflict at demonstrations [src: https://eprints.whiterose.ac.uk/id/eprint/76312/ ; https://polis.osce.org/dialogue-policing].
- **Euro 2004 (Portugal):** areas using low-profile, behaviour-based policing saw **1 England fan arrested** despite more than a million visitors, and **0.4%** of ~2,000 observed crowd-police interactions were disorderly. The only serious violence was in an area policed the traditional riot-gear way [src: https://danielcoyle.com/stop-escalation-spiral/ ; Stott et al. 2007 https://dspace.stir.ac.uk/handle/1893/10289].
- **UK Police Liaison Teams** were evaluated by Stott, Scothern & Gorringe in 2013 [src: Whiterose link].
- The French SNMO aims for better dialogue and communication but remains force-centred [src: SNMO wiki].

**When it's used.** Early in the day, with authorised marches, with stewarded union blocks. It is the doctrinal first step of the escalation ladder.

**Risks.**
- Little effect on organised black bloc groups.
- Liaison credibility collapses after any indiscriminate force.

**Game AI spec**
```
Liaison:
  units: LiaisonTeam (2–4 officers), cost tiny
  effect per active team embedded with a crowd (radius 100 m):
     anger -1/10 min (min floor = radicals% * 100), legit +1/10 min
     moderates won't join radicals' actions (radicals 'isolated': their actions don't raise crowd anger)
     intel: reveals crowd intent/next waypoint with p = 0.3/15 min
     steward cooperation: union-stewarded blocks self-police -> radicals% in that block -50%
  low_profile posture (riot units in vans, out of LOS): anger growth x0.5; response time +60–120 s
  broken by: any indiscriminate force within 300 m -> liaison effect suspended 60 min, legit -5 extra
```

---

## 3. Command-level AI: allocating forces over a day and a week

### 3.1 Real command structure (Paris)

- The **Préfet de police** is the operational authority for public order in Paris. The **DOPC** (Direction de l'ordre public et de la circulation) runs the command room.
- UFM units (CRS/EGM) are allocated from national reserves by the Interior Ministry (UCFM coordination) on the prefect's request, often **days ahead** based on intelligence from the Renseignement territorial / DRPP.
- Field command is organised in **sectors**, each led by a commissaire with a set of companies and squadrons. The prefect holds a central reserve.
- **Command latency.** The Senate found ~30 min between field requests and authorisation on 16 Mar 2019 [src: Senate r18-450]. After that failure, the prefect was replaced and command was decentralised to sector leaders, with more offensive mobility. This is a good in-game "reform event".

### 3.2 Escalation ladder (game)

| Level | Name | Real analogue | Tactics unlocked | Constraints |
|---|---|---|---|---|
| 0 | Accompaniment | authorised union march | Liaison, StaticCordon on sensitive streets, channelling | riot units low-profile |
| 1 | Firm framing | tension, isolated incidents | + Sommations, LineAdvance, MotoSnatch on breakaways | snatch only on visible offences |
| 2 | Dispersal | unlawful gathering after sommations | + TearGas, WaterCannon, Charge, DispersalPush, SplitMarch | exit required |
| 3 | Offensive | sustained violence (Gilets jaunes Dec 2018) | + Pincer, FilterExit kettle, mass arrests, armoured vehicles, GENL | legal and opinion penalties per use |
| 4 | Hardline | crisis (perimeter threatened) | + full Kettle, preventive mass checks, area bans citywide | large opinion and legitimacy costs; political "recall" risk |

Escalation inputs:
- Violence events: property damage, attacks on police.
- Crowd inside the outer perimeter.
- Political pressure: the government "orders firmness" after bad TV days.

De-escalation inputs:
- Calm periods.
- Opinion turning against police (e.g. after injury incidents).

Escalating raises the political "firmness" meter. Each level up costs `opinion` over time but gives faster crowd control.

### 3.3 Daily allocation (utility over sectors)

A **day** runs: briefing (06:00–09:00) → pre-positioning → march window (13:00–19:00 for unions; Gilets jaunes from 10:00) → evening breakaway/riot window (18:00–23:00) → night (small units only).

Allocation algorithm [design]:
1. **Intelligence.** Declared routes are known 100% (unions declare them to the prefecture 3 days ahead). Undeclared intents (Gilets jaunes "Champs" calls, social media) are revealed with probability p_intel per region, based on the player's chatter and leaders' visibility.
2. **Fixed obligations first.** Élysée/Beauvau perimeter (min 25%), Assemblée, ministries, plus preventive filtering at major stations (Saint-Lazare, Gare du Nord/Est, Gare de Lyon) on high-threat days (Gilets jaunes: 7,300–14,000 checks a day [src: Senate r18-450]).
3. **Route framing.** Along the declared route, cordon side streets that lead toward sensitive zones, not all side streets. Put the head of the march under a company and the tail under one.
4. **Mobile reserves.** Keep **30–40%** of forces as mobile reserves (companies in vans, BRAV-M, water cannon) at central staging points: Concorde, Invalides, Bastille, République, Opéra. Post-Dec 2018 doctrine favoured mobility over fixed points [src: Senate r18-450 ; https://www.publicsenat.fr/actualites/politique/lbd-pourquoi-les-forces-de-l-ordre-ont-rectifie-le-tir-139320].
5. **Re-allocation.** Every 15 min of game time: score each sector by threat = crowd_size × anger × proximity_to_sensitive × radicals%, and move reserves to the top-scoring sector. Apply **command latency** (60–300 s for sector-internal moves, 600–1,800 s for prefect-level reserve release).

### 3.4 Weekly allocation (7 days)

- **Reinforcements from the provinces.** CRS rotate monthly and EGM are deployed from all over France. When warning is given 24–72 h ahead, the prefect can request extra companies. Game: +2 to +6 companies arrive at 06:00 the next day if requested by 18:00 and if the national pool allows it. The pool shrinks when other cities are also protesting: the Gilets jaunes was national, and 106 EGM + 57 CRS were committed at once nationwide [src: AN QE 15521].
- **Cumulative fatigue.** Use the §1.5 carry-over. A unit engaged hard on 3 consecutive days should be ineffective on day 4 unless rested. The Gilets jaunes showed forces chaining weekends without rest, and unions described a system at breaking point [src: tendanceouest ; europe1].
- **Munitions.** Gas and LBD stocks per day, with a national resupply limit. Usage was heavily front-loaded during the Gilets jaunes: 50–60% of all LBD shots in 4 weeks [src: Senate r18-450].
- **Learning.** After each day the AI updates:
  - **Hot spots:** where damage happened, so it pre-positions more there.
  - **Player tactics:** if the player used side streets, it raises cordons on side streets.
  - **Political posture:** after a damaging day (Champs-Élysées sacked), the government orders bans (Champs-Élysées *périmètre interdit* from 23 Mar 2019 [src: https://www.lavenir.net/actu/monde/2019/03/22/gilets-jaunes-des-interdictions-de-manifester-decidees-dans-plusieurs-villes-ON4HCKMZARE3XCMCHRN2WFJR54/]), raises escalation and adds preventive checks.
- **Weekly shape** (Gilets jaunes-like arc, used as a default script):
  - Day 1: under-prepared. Static, moderate forces.
  - Day 2: surge after the first violence.
  - Days 3–4: maximum deployment with armour and mobility (8 Dec 2018 style).
  - Days 5–6: fatigue and political scrutiny of injuries force selective tactics.
  - Day 7: final stand with all reserves on the perimeter.

---

## 4. Crowd response model

### 4.1 Density and speed (pedestrian dynamics)

**Weidmann (1993) fundamental diagram** [src: https://arxiv.org/pdf/physics/0506170 ; https://arxiv.org/pdf/1908.07208]:
- Free walking speed v₀ = **1.34 m/s**.
- Jam density ρ_max = **5.4 p/m²**.
- v(ρ) = v₀ · (1 − exp(−1.913 · (1/ρ − 1/5.4))).
- Specific flow J = ρ·v peaks at about **1.2 persons/m/s at ~1.75 p/m²** (speed ≈ 0.7 m/s).

**Fruin Level of Service, walkways** [src: https://gkstill.com/CV/PhD/Chapter3.html ; https://www.fhwa.dot.gov/publications/research/safety/pedbike/98107/section3.cfm]:

| LoS | Space m²/p | Density p/m² | Flow p/min/m | Game meaning |
|---|---|---|---|---|
| A | > 3.25 | < 0.31 | < 23 | dispersed, mobile |
| B | 2.32–3.25 | 0.31–0.43 | 23–33 | loose crowd |
| C | 1.39–2.32 | 0.43–0.72 | 33–49 | normal march |
| D | 0.93–1.39 | 0.72–1.08 | 49–66 | dense march |
| E | 0.46–0.93 | 1.08–2.15 | 66–82 | packed; max flow; stop-and-go |
| F | < 0.46 | > 2.15 | erratic | jammed; crush risk above ~4–5 p/m² |

**Game rules of thumb** [design from the above]:
- A typical march moves at **0.8–1.0 m/s** at 1–1.5 p/m².
- Marchers occupy about **2–3 m² each**, so 10,000 people in a 30 m boulevard is a column roughly 700–1,000 m long. Paris marches of 50,000+ stretch for kilometres and take hours to pass a point.
- Exit and bottleneck capacity is **1.2 p/m/s** (≈ 70 p/m/min).
- Fleeing speed: desired speed 2–5 m/s. The "faster-is-slower" effect applies: above about 1.5 m/s desired speed at a bottleneck, clogging and arching reduce outflow [src: Helbing, Farkas, Vicsek 2000 https://arxiv.org/pdf/cond-mat/0009448]. Model it by reducing exit capacity by 20–40% when the crowd is in panic.

### 4.2 Crowd state variables

For each crowd entity:
- `size`
- `density`
- `composition`: moderates, union stewards, radicals, opportunists/looters, bystanders.
- `anger`, `cohesion`, `morale`, `legit` (perception of police), `masked%` (gas protection).
- `leaders_present`

### 4.3 Response table by tactic (summary of §2)

| Tactic | Immediate displacement | Lasting dispersal | Anger | Cohesion | Legit | Notes |
|---|---|---|---|---|---|---|
| Liaison | 0 | 0 | −1/10 min | 0 | +1/10 min | isolates radicals |
| Sommations | 0 | 10–35% of moderates | +0–2 | 0 | +0 (lawful) | enables force |
| Static cordon | stops flow | 0 | +1/min in contact | +2 | 0 | |
| Line advance | 0.3–0.6 m/s | 5% | +2/50 m | +3 | −1 | |
| Charge | 20–60 m | 5–15% | +8 | +5 | −3 (−8 if injuries) | |
| Tear gas | 40–120 m | 10–30% then habituation | +6 | +5 | −4 (−8 in residential streets) | 60–70% re-form in 3–8 min |
| Water cannon | 10–30 m per burst | 10–20% of front | +3 | +2 | −2 | |
| Snatch (discriminate) | 0 | 0 | +2 local | 0 | +2 | |
| Snatch (indiscriminate) | 0 | 0 | +10 | +8 | −8 | |
| Kettle with filter | 0 | drains at throughput | +2/10 min | +5 | −3 | hardens remaining core |
| Full kettle | 0 | 0 | +5/10 min | +10 | −10/−20 | attracts outside crowds |
| Mass arrests | — | removes 20–40% | +10 | +10 | −10 | 2023: 283 of 292 cases dropped |

### 4.4 Tear gas behaviour model (detailed)

1. **Detection.** At grenade impact, crowd within 15 m flees immediately. Crowd 15–40 m away hesitates for 3–10 s, then moves.
2. **Direction.** Away from the cloud, biased **upwind** and toward the widest open exit. Never toward police lines unless there is no other exit; in that case, panic and a surge at the police line.
3. **Distance.** Until local concentration is below threshold, typically 40–120 m.
4. **Re-form.** Groups with leaders, anger > 50, and masked% > 20 re-form after 3–8 min. Others dissolve into streets: 10–30% are permanently dispersed on the first gassing, decaying ×0.6 with each repeat (habituation).
5. **Radicalisation.** Each gassing adds +5% to masked% the next day (people learn) and +2–5 to radicals% if many bystanders were gassed (ESIM).

### 4.5 ESIM: how indiscriminate force changes crowds

Mechanism [src: https://impact.ref.ac.uk/casestudies/CaseStudy.aspx?Id=28487 ; https://www.sussex.ac.uk/research/documents/rcs-drury-press-ready.pdf ; Keele HK study https://keele.ac.uk/kpac/newsandblogs/2020/november/new-study-on/hong-kong-protests.php]:
1. Crowd members see their own actions as legitimate.
2. Police treat the whole crowd as dangerous.
3. Police act indiscriminately.
4. Crowd members share a common fate and redefine their identity as "us vs police". Conflict becomes legitimate and they feel **empowered**.
5. Formerly peaceful people now support or join confrontation.

Conversely, differentiated, facilitating policing prevents this (Euro 2004 [src: Stott et al. 2007]).

Game implementation [design]:
```
on police action A affecting set S of crowd members:
   discriminate = fraction of S who committed visible offences
   if discriminate < 0.5:   # indiscriminate
       legit   -= k_A * (1 - discriminate)          # k: charge 5, gas 6, water 3, kettle 15, LBD-injury 10
       cohesion += 0.5 * k_A
       radicals% += 0.02 * k_A * (1 - legit/100)     # conversion of moderates
       anger  += k_A
       opinion -= 0.2 * k_A * media_presence
   else:
       legit   += 1
       radicals isolated: moderates distance themselves (radicals' actions don't raise group anger) for 15 min

crowd size dynamics (per hour, per day):
   recruitment_rate ∝ (anger/100) * (1 - legit/100) * opinion_sympathy
   next-day turnout multiplier = 1 + 0.3*(anger_avg-50)/50 + 0.2*(injury_events>0) - 0.2*(fatigue_of_movement)
   # heavy-handed day -> bigger, angrier next day; calm day -> smaller turnout
   police morale/fatigue → "unauthorised force" chance = 0.02 * (fatigue/50) * (anger_of_crowd/50) per contact minute
```

**Opinion anchors.**
- 283 of 292 Concorde custody cases dropped (2023), driving criticism of illegitimate arrests [src: AN QE 6780].
- BRAV-M dissolution petition ~264k signatures [src: BRAV-M wiki].
- ~13,000 LBD shots and multiple maimings during the Gilets jaunes led the government to withdraw the GLI-F4 grenade [src: HRW 2020 link].

Model this as a **national opinion meter**: police over-reach feeds the player's mobilisation, while visible rioting and looting feeds the police's political latitude.

---

## 5. Geography notes for central Paris

Widths are approximate and should be confirmed on the map data.

### 5.1 Classic march routes (east and south, "left-bank and eastern axes")
- **République → Bastille → Nation** via Bd du Temple / Bd des Filles-du-Calvaire / Bd Beaumarchais, then Rue du Faubourg Saint-Antoine or Bd Voltaire. This is the archetypal union route, e.g. 19 Jan 2023 République→Nation [src: https://www.evous.fr/paris/Vivre-a-Paris/social-crise-chomage-et-conflits/Parcours-manifestation-Paris-reforme-retraites-1195275.html].
- **Place d'Italie → Invalides (Place Vauban)** via Av. des Gobelins, Bd de Port-Royal, Bd du Montparnasse, Bd des Invalides, Av. de Villars (31 Jan 2023, 13 Oct 2023) [src: evous ; https://www.lejournaltoulousain.fr/paris/manifestation-du-6-avril-voici-le-parcours-prevu-a-paris-213587].
- **Bastille → Nation**, **Montparnasse → Invalides**, **Denfert-Rochereau → Bastille/Nation** are the other common variants.
- These routes are wide Haussmann boulevards (30–40 m) that are easy to channel. Authorities favour the east and south because they keep crowds **away** from the Élysée and ministries in the 8th arrondissement.
- In game terms, the player's challenge is to break from the authorised route and head west/north-west toward the 8th.

### 5.2 Gilets jaunes geography (west, "symbolic axes")
- They converged on the **Champs-Élysées / Étoile** (undeclared). Fighting happened at Étoile and the avenues radiating from it (Kléber, Foch, Friedland, Wagram), with spillover to rue de Rivoli, Hôtel-de-Ville, Opéra and Saint-Lazare [src: https://fr.vikidia.org/wiki/Gilets_jaunes ; https://www.politis.fr/articles/2018/12/le-1er-decembre-les-gilets-jaunes-ont-pris-paris-39685].
- Étoile has 12 radiating avenues, so it is impossible to cordon completely with a few units. That is a key reason static positions were overrun on 1 Dec 2018.
- The Champs-Élysées (~70 m wide, ~1.9 km long) needs vehicles or water cannon to hold. It was banned to demonstrations from March 2019 [src: lavenir.net link above].

### 5.3 The government quarter (target zone)
- **Élysée Palace**: entrance on rue du Faubourg Saint-Honoré (~10–12 m wide, a narrow medieval-scale street), gardens on Av. Gabriel facing the Champs-Élysées gardens.
- **Place Beauvau** (Interior Ministry) is just east, at the junction of Faubourg Saint-Honoré, Av. de Marigny and rue de Miromesnil.
- Approach chokepoints into the block:
  - (a) **Rond-Point des Champs-Élysées / Av. de Marigny / Av. Matignon** from the north-west.
  - (b) **Concorde → rue Royale → Faubourg Saint-Honoré** and **Concorde → Av. Gabriel** from the south-east. Concorde is a huge open square, hard to hold without water cannon, but its exits are few and wide.
  - (c) **rue Boissy-d'Anglas, rue d'Anjou, rue de Miromesnil, rue de la Boétie** from the north and east. These are narrow streets, cheap to block with one section plus a barrier truck.
  - (d) **Madeleine** area from the north-east.
- Gilets jaunes and pension-reform security perimeters routinely covered **Élysée + Beauvau + lower Champs-Élysées + Concorde + Assemblée nationale** [src: Europe 1 / Public Sénat links in §2.13; prefectoral arrêtés 2023].
- **Concorde in 2023.** On 16–17 Mar 2023, after the 49.3, a spontaneous gathering of more than 6,000 at Concorde was dispersed: 292 arrests on 16 Mar, 61 on 17 Mar [src: AN QE 6780]. It was then banned by arrêté [src: LDH/arrêtés]. Concorde is the natural rally point nearest the Élysée and the Assemblée, so the AI must always hold it.
- **Assemblée nationale** (Palais Bourbon) sits across the **Pont de la Concorde**. Bridges are perfect chokepoints: 1 company plus a water cannon holds a bridge of about 30 m.

### 5.4 Bridges and Île de la Cité
- Île de la Cité hosts the **Préfecture de police** (Bd du Palais), the Palais de Justice and Notre-Dame. Bridges from the right bank: Pont Neuf, Pont au Change, Pont Notre-Dame, Pont d'Arcole. From the left bank: Pont Saint-Michel, Petit-Pont, Pont au Double, Pont de l'Archevêché. Pont Saint-Louis connects to Île Saint-Louis.
- In game terms, each bridge is a ~15–30 m chokepoint that 1–2 sections can seal. The island is an easy police fortress and a trap for crowds that cross, because it has few exits.
- Seine bridges between the left bank and the 8th (Pont Alexandre III, Pont de la Concorde, Pont des Invalides) are the police's main tool for keeping left-bank marches (Italie→Invalides) away from the Élysée.

### 5.5 Map heuristics for the AI
- Tag every street segment with width, side streets and length. Tag nodes (intersections) with degree; high-degree "star" nodes like Étoile, Nation and République are hard to seal. Tag bridges as chokepoints.
- Precompute "cordon cost" per node = Σ(width of incoming streets)/13 sections.
- **Cheap-to-hold gateways to the 8th:** bridges (Concorde, Alexandre III, Invalides), rue Royale, Faubourg Saint-Honoré west of rue Royale, rue de Rivoli at Concorde (Tuileries side), Bd Malesherbes / Madeleine.
- **Expensive:** Étoile (12 avenues), Concorde (open), Champs-Élysées width.

---

## 6. Recommended v1 police AI

A two-level AI:
- **Commander** (strategic, ticks every 15 game-minutes): decides allocation and escalation.
- **Sector controllers** (tactical, tick every 5–10 s): use **utility scoring** to pick a tactic for each unit group from a small state machine.

### 6.1 Commander loop
```
every 15 min:
  update intel (declared routes, observed crowds, leader sightings with p_intel)
  escalation_level = f(violence_events_last_hour, crowd_in_outer_ring, political_pressure, opinion)
  enforce fixed obligations:
     perimeter >= max(25% forces, required_entries * 1 section)
     key chokepoints (bridges to 8th, Concorde) held if any crowd > 2 000 within 2 km
  threat score per sector s:
     T(s) = Σ crowds c: size_c * (anger_c/50) * (1+radicals%_c*5) / (1 + dist_to_élysée_km_c)
  move reserves toward argmax T (apply command latency 600–1 800 s; reduced to 300 s after "decentralisation" reform event)
  rotate units with fatigue > 70 out; request provincial reinforcements if projected need > available for tomorrow
end-of-day: update hot-spot map, player-pattern memory, munitions, fatigue carry-over, next-day escalation baseline
```

### 6.2 Sector controller: unit-group states
```
States: STAGED -> MOVING -> HOLDING (cordon) -> ENGAGING (tactic) -> RECOVERING -> STAGED
Transitions:
  STAGED->MOVING: assigned by commander/sector
  HOLDING->ENGAGING: utility(tactic) > hold_utility + hysteresis(10)
  ENGAGING->HOLDING: tactic complete/timeout/cooldown
  any->RECOVERING: fatigue > 85 or casualties > 30%
```

### 6.3 Utility scoring (pick the highest valid option per group)

Each option is valid only if it is allowed at the current escalation level and its preconditions are met (units, geometry, sommations).

| Priority | Option | Utility formula (sketch) |
|---|---|---|
| 1 | **Protect perimeter** (hold/reinforce entry) | `100 * crowd_within(300 m of entry) / cordon_strength`, always considered first |
| 2 | **Block chokepoint toward the 8th** (bridge, rue Royale, Concorde exits) | `80 * crowd_heading_to_8th * (1/eta_min)` |
| 3 | **Liaison / low profile** | `40 * (1 - anger/100) * stewarded%`; zero if escalation ≥ 3 |
| 4 | **Sommations** | `50` if escalation ≥ 1, crowd unlawful or in banned zone, and not yet warned |
| 5 | **Channel** (cordon side streets on the crowd's path) | `60 * side_streets_toward_sensitive / units_needed` |
| 6 | **Split march** | `55 * crowd_size/5 000 * has_gap * leaders_in_front` (split off the head with the leaders) |
| 7 | **Dispersal push to exit** | `50 * (escalation≥2) * exit_quality * (crowd in banned zone)` |
| 8 | **Tear gas** | `45 * (escalation≥2) * wind_favourable * exit_exists * (1 - masked%) * (1 - residential_penalty)` |
| 9 | **Water cannon** | `45 * (escalation≥2) * street_width≥15 m * (fire_or_barricade ? 1.5 : 1)` |
| 10 | **Charge** | `40 * projectile_rate * (1 - density/4)` |
| 11 | **Snatch / MotoSnatch** | `35 * visible_offenders * (1 - density/2)`; Moto variant for groups < 300 off-route |
| 12 | **Pincer** | `50 * (two groups available within sync window) * crowd_isolated` |
| 13 | **Filter kettle / Funnel-trap** | `60 * (escalation≥3) * violent_group_isolated * geometry_score`, minus legitimacy cost |
| 14 | **Full kettle** | escalation 4 only; `70 * crowd_inside_hard_ring` |

Every option subtracts a **legitimacy cost term**:
`U -= λ_opinion * expected_legit_loss * media_presence`

λ rises as public opinion falls. This lets the AI self-moderate realistically: firm early, more careful after controversies. The ESIM backfire is built in, so the player can win by **provoking over-reaction** (bigger crowds next day) or by **staying peaceful and out-manoeuvring** (exploiting side streets, fatigue and command latency).

### 6.4 Player counterplay levers this AI creates (sanity checklist)
- **Command latency** and **fatigue**: multi-pronged marches and late-day breakaways stretch units.
- **Star intersections** (Étoile, République, Nation) are hard to seal. Bridges and narrow streets are easy for police.
- **Wind and narrow streets** change gas effectiveness. Masks grow with exposure.
- **Legitimacy**: police over-reach grows tomorrow's crowd. Rioting gives police latitude (escalation and bans).
- **Exit doctrine**: police must leave an exit, which the player can exploit (or which can be a trap).

---

## Source list (main)
- SNMO 2020/2021 and Conseil d'État 10 June 2021 n°444849: https://www.conseil-etat.fr/fr/arianeweb/CE/decision/2021-06-10/444849 ; https://reporterre.net/Revision-en-trompe-l-oeil-des-mesures-de-maintien-de-l-ordre ; https://blog.landot-avocats.net/2021/12/29/voici-la-version-mise-a-jour-du-schema-national-du-maintien-de-lordre-snmo/ ; https://fr.wikipedia.org/wiki/Sch%C3%A9ma_national_du_maintien_de_l%27ordre
- Sommations (CSI L211-9/R211-11): https://www2.assemblee-nationale.fr/questions/detail/14/qe/88293/(vue)/pdf
- Senate report on maintien de l'ordre after Acte XVIII (r18-450): https://www.senat.fr/rap/r18-450/r18-450_mono.html
- CRS: https://fr.wikipedia.org/wiki/Compagnies_r%C3%A9publicaines_de_s%C3%A9curit%C3%A9 ; EGM: https://fr.wikipedia.org/wiki/Gendarmerie_mobile ; https://questions.assemblee-nationale.fr/dyn/14/questions/QANR5L14QE88310.pdf
- BRAV-M: https://fr.wikipedia.org/wiki/Brigade_de_r%C3%A9pression_de_l%27action_violente_motoris%C3%A9e
- Gilets jaunes mobilisation and fatigue: https://questions.assemblee-nationale.fr/dyn/15/questions/QANR5L15QE15521.pdf ; https://www.interieur.gouv.fr/fr/Archives/Archives-des-actualites/2018-Actualites/Rassemblements-du-8-decembre-le-bilan
- Pension reform 2023: https://www2.assemblee-nationale.fr/questions/detail/16/qe/6780/(vue)/pdf
- Weapons: https://www.acatfrance.fr/public/carteid-armes.pdf ; https://en.wikipedia.org/wiki/Wasserwerfer_10000
- UK: https://en.wikipedia.org/wiki/Police_support_unit_(United_Kingdom) ; https://mentalhealthlaw.co.uk/Austin_v_Commissioner_of_Police_of_the_Metropolis_(2009)_UKHL_5 ; https://gtr.ukri.org/project/966FC713-6EC6-4E6F-900D-5543250AAB0C
- Hong Kong: https://hongkongfp.com/2019/12/10/hong-kong-police-used-crowd-control-weapons-30000-times-since-june-6000-arrests/ ; https://en.wikipedia.org/wiki/2019_Hong_Kong_Polytechnic_University_campus_conflict
- Crowd psychology: https://impact.ref.ac.uk/casestudies/CaseStudy.aspx?Id=28487 ; https://www.sussex.ac.uk/research/documents/rcs-drury-press-ready.pdf ; https://dspace.stir.ac.uk/handle/1893/10289 ; https://eprints.whiterose.ac.uk/id/eprint/76312/
- Pedestrian dynamics: https://arxiv.org/pdf/physics/0506170 ; https://gkstill.com/CV/PhD/Chapter3.html ; https://arxiv.org/pdf/cond-mat/0009448
