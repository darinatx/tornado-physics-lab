# Spec 03 — Damage Model

Status: Approved (v2.5) — component houses (EF Damage Indicator 2), with debris impacts (Spec 10)

## Purpose

Decide which individual parts of a house fail, in what order, and what that adds up to as a
survey-style Degree of Damage (DOD) and EF estimate.

## Model

### Damage indicator and degrees of damage

Houses use EF-scale Damage Indicator 2 (one- or two-family residences). Speeds in mph,
3-second gust:

| DOD | Damage | Lower | Expected | Upper |
|---|---|---|---|---|
| 1 | Threshold of visible damage | 53 | 65 | 80 |
| 2 | Loss of roof covering (< 20%), gutters, siding | 63 | 79 | 97 |
| 3 | Broken glass in doors and windows | 79 | 96 | 114 |
| 4 | Uplift of roof deck, > 20% covering lost; garage door collapse | 81 | 97 | 116 |
| 5 | Entire house shifts off foundation | 103 | 121 | 141 |
| 6 | Large sections of roof structure removed | 104 | 122 | 142 |
| 7 | Top-floor exterior walls collapsed | 113 | 132 | 153 |
| 8 | Most walls collapsed except small interior rooms | 127 | 152 | 178 |
| 9 | All walls collapsed | 142 | 170 | 198 |
| 10 | Slab swept clean | 165 | 200 | 220 |

*Values transcribed from the EF scale's DI 2 table (WSEC 2006); to be checked against the
source document.*

### House layout (components)

A one-story gable house, ridge along its width. With n_x = max(2, round(W/4)) columns along
the width and n_e = max(2, round(D/4)) along the depth:

| Component | Count | Notes |
|---|---|---|
| Wall panels | 2·n_x + 2·n_e | about 4 m wide each, full wall height |
| Window panes | one in ~60% of non-garage panels | 1.2 × 1.2 m |
| Garage door | 0 or 1 | front wall, end panel |
| Siding | 1 per wall panel | a layer on the panel; stripped panels show bare sheathing |
| Roof sections | 4·n_x | per column: front and back slope × eave and ridge row; each has a covering layer and a deck layer |
| Roof bays (rafters) | n_x | each carries the 4 sections of its column |
| Interior partitions | 2 | |
| Interior core room | 1 | a closet or bathroom: short spans, many intersecting walls; the last thing standing |
| Anchorage, slab | 1 each | |

Roof sections in the end columns *and* the eave row are **corner** sections (highest
suction); the rest are **field** sections.

### Capacities and fragility

Each component has a capacity (Pa of net load from Spec 02) and fails permanently the first
time its load exceeds it:

```
capacity = base(part) × class factor × house quality × component scatter
house quality ~ lognormal(1, β = 0.12), shared by the house
component scatter ~ lognormal(1, β = 0.18), independent per component
                   (β = 0.35 for roof covering: nailing, sealing and age vary a lot)
```

### Dependencies and cascades

- A roof section's covering and deck only carry load while its bay stands; a bay failure
  takes its four sections with it.
- **Bearing walls:** each roof bay's rafters bear on the top plate of the front and back walls,
  and the two end bays also on their gable end walls. The top plate can bridge one missing
  panel but not two in a row. So a bay collapses when the panel under it and an adjacent panel
  on the same wall are both down, or (end bays) when half its gable end wall is down. A
  collapsed bay drops onto the slab rather than being lifted away.
- **Progressive roof failure:** a bay's capacity drops 15% for each failed neighboring bay,
  since the load it shared now concentrates on it.
- **Bracing:** a wall panel is 1.6× stronger while the roof bay above it stands (eave walls
  use their own column's bay; end walls use the end bay).
- **Progressive wall failure:** a panel's capacity drops 20% for each fallen neighbor on the
  same wall, since walls lean on each other.
- **Corner bracing:** where two walls meet, each braces the other: a corner panel is 1.4×
  stronger while the perpendicular wall's corner panel stands. Corners are typically the last
  walls standing in real EF3–EF4 damage.
- **Open house:** once half the wall panels or the whole roof are gone, the remaining panels
  carry wind on both faces like a free-standing wall (net C_p 1.3, Spec 02).
- Interior partitions load up only once at least half the exterior panels are down; the
  interior core room only once three quarters are down.
- The anchorage can fail (the house shifts) while at least half the wall panels stand.
- The slab is swept once every wall panel, partition and the core room are down and the lateral load exceeds
  the sweep capacity.
- Every failed opening (window, garage door, deck section, wall panel, bay) changes the
  internal pressure (Spec 02) immediately, within the same evaluation.
- **Structural support takes time:** bracing, neighbor support and the open-house condition
  are judged from the state at the start of each 30 Hz evaluation, so a collapse spreads over
  successive moments instead of all at once.

### Degree of damage from what's missing

A house's DOD is the highest of these that holds, judged the way a surveyor would:

| DOD | Condition |
|---|---|
| 1 | any panel's siding lost, or any siding stripped by debris |
| 2 | any roof covering section lost, or any shingles torn off by debris |
| 3 | any window pane broken |
| 4 | ≥ 20% of covering lost (sections, plus debris-torn area), any deck section lost, or the garage door failed |
| 5 | the house has shifted off its foundation |
| 6 | ≥ 1/3 of roof bays removed |
| 7 | ≥ 50% of exterior wall panels down |
| 8 | ≥ 75% of exterior panels and both partitions down (the core room may stand) |
| 9 | all exterior panels, both partitions and the core room down |
| 10 | slab swept clean |

### Calibration

Base capacities are **calibrated against simulated tornado passes on the EF scale's own basis**
(v2.5). DI 2's speeds are 3-second gusts at 10 m over open terrain, so that is the wind each DOD
is matched to: for each DOD, the median **10 m open-terrain peak** at the house (the horizontal
`windAt` wind at 10 m with terrain `"open"`, the quantity the EF readout and the storm
recorder's true wind use, Spec 17 v1.1, Spec 16 v1.1) when the house first reached that DOD must
match the table's expected value. The houses are loaded the way they are used: each one stands
at a house site of the default town (seed `CALIBRATION.townSeed`), with the intact town's
roughness field (Spec 17), and feels its own local roof-height wind in that field. Only the
reading is on the 10 m open basis; the loads stay physical.

The passes: standard houses near the core of strong translating tornadoes (V_max 55–80 m/s,
R_max 150–300 m, 10–18 m/s forward speed, random headings, offsets within ±0.8·R_max of the
house site). Houses whose peak wind never brought them to a DOD are *censored* at that peak
(their 10 m open peak; they say nothing about their strength above it), so the median is a
Kaplan–Meier estimate. `scripts/calibrate-houses.ts` reproduces the values. Garage doors
(1.3 kPa) and roof deck (2.7 kPa) are fixed at typical engineering values instead: DOD 4 is
usually reached through covering loss first, so calibrating them against it let them drift to
unrealistic strengths. (A steady-wind calibration was tried in v1.0 and found biased; a
roof-height calibration over open terrain was used until v2.4; see the changelog.)

### Construction classes

| Class | Share | Factors |
|---|---|---|
| Weak (older, toe-nailed roof, few anchors) | 25% | roof bays ×0.7, anchorage and slab sweep ×0.6, walls, partitions and core room ×0.85 |
| Standard | 55% | ×1 |
| Strong (hurricane straps, anchor bolts, impact windows) | 20% | roof bays ×1.6, anchorage ×1.6, slab sweep ×1.21, walls, partitions and core room ×1.3, windows ×1.4, garage ×1.5, deck ×1.3 |

### Survey rating

As in EF-scale practice, the assigned speed is adjusted within the DOD's bounds by
construction quality: weak → lower bound, standard → expected, strong → upper bound. The EF
estimate is the EF of that speed, reported with the DOD's range.

### Update rate

Damage is evaluated at 30 Hz for houses within 6·R_max of the tornado.

## Interface

```ts
// src/core/damage/layout.ts
function layoutHouse(spec: HouseSpec, rng: () => number): HouseComponents;
// src/core/damage/building.ts
function createHouse(spec: HouseSpec, rng: () => number): Building;
function updateBuilding(b, wind, deficitOut, dt, time, onFail?: (ev: FailureEvent) => void): boolean;
function degreeOfDamage(b: Building): number;
function efFromDamage(dod: number, cls?: ConstructionClass): EFEstimate;
function buildingReport(b: Building): BuildingReport;   // failures grouped by part type
```

## Acceptance criteria

- **DMG-01**: Failures are permanent and the DOD never decreases.
- **DMG-02**: Dependencies hold: no covering or deck section fails after its bay; partitions
  fail only after half the exterior panels; the slab is swept only after every panel and
  partition; a panel's capacity includes the 1.6× bracing exactly when its bay stands.
- **DMG-03**: Cascade: for otherwise identical houses in the same wind, a windward garage
  breach makes the first roof bay fail at a lower wind speed than with no breach.
- **DMG-04** *(validation)*: In simulated tornado passes over town house sites (independent
  sample, the calibration setting), standard houses reach each DOD at a Kaplan–Meier median
  10 m open-terrain peak within ±5% of the DI 2 expected value.
- **DMG-05**: In the same setting, weak houses reach DOD 6 at a lower median 10 m open-terrain
  peak than standard ones, and strong houses at a higher one.
- **DMG-15**: In the same setting, strong houses reach DOD 10 at a Kaplan–Meier median 10 m
  open-terrain peak within ±5% of the DI 2 upper bound (220 mph).
- **DMG-06**: Below 50 mph steady wind on the 10 m open basis (the local wind put on that basis
  as in DMG-09), fewer than 1% of standard houses show any damage.
- **DMG-07**: Same seed → identical layouts, capacities and damage histories.
- **DMG-08**: The EF estimate uses the lower bound for weak houses, the expected value for
  standard ones and the upper bound for strong ones, with the DOD's range.
- **DMG-09** *(validation)*: In steady wind ramps from all directions, standard houses reach
  each DOD at a median speed inside the DI 2 lower–upper bounds, the ramp's (local roof-height)
  speed put on the 10 m open basis by the calibration setting's mean 10 m open ÷ roof-height
  ratio at first reaching that DOD.
- **DMG-10** *(validation)*: Strong houses passing through an EF5-strength core can be
  surveyed EF5; none passing through an EF4-strength tornado (10 m open-terrain peak
  < 200 mph) are.
- **DMG-11**: The DOD equals the component-fraction rules in the table above.
- **DMG-13**: No roof bay stands over two adjacent missing panels of a bearing wall, or over
  half a missing gable end wall; a collapsed bay's failure record marks it as a collapse, and
  its debris drops instead of launching.
- **DMG-12**: Damage is progressive: in a tornado pass that reaches DOD 7, the house's failures
  happen over more than three separate evaluations and its wall panels over at least two. (A
  whole roof may lift off in one evaluation, as real roofs often do.)
- **DMG-14**: Every house records its closest approach to the core edge: the minimum over
  physics steps with an active tornado of (distance from the house center to the axis − R_max)
  at that step, in m (negative inside the core; +∞ before any); damaged, destroyed and
  detail-zone houses included.

## Simplifications / out of scope

- One-story gable houses only (hip roofs and two stories later).
- Debris impacts (Spec 10) break windows, perforate walls and roofs, strip siding and shingles
  and push on walls and the garage door; impact failures are recorded with cause "debris".
- Quasi-static: no dynamic shaking or fatigue.
- Components are rigid; a failing panel detaches whole.

## Decisions

1. **Closest approach measured to the core edge at each step (v2.2):** R_max changes over the
   tornado's life, so the edge is taken at the time, not from today's size. For the inspector
   (Spec 07); no effect on damage.
2. **DOD speeds on the EF scale's basis, houses in the town (v2.5, BL-029):** the survey (Spec 16),
   the EF readout and DI 2 all mean the 10 m open-terrain gust, so the capacities are calibrated
   to it; calibrating to the roof-height wind made the town's houses too strong by the town's
   roughness ratio. Calibrated at the default town's sites and roughness, since that is where
   houses are used; the loads stay the local roof-height wind, so the physics is unchanged.

## Changelog

- v2.5: calibration on the EF scale's basis (BL-029). DI 2's speeds are 10 m open-terrain
  gusts, but v1.1–v2.4 matched each DOD to the *roof-height* peak in passes over open terrain;
  since Spec 17 (Phase 7) the town's roughness cuts the roof-height wind to ≈ 0.88 of that, so
  the town's houses reached each DOD at 1.13–1.19× the DI 2 speed on the EF basis and the storm
  report's survey read 5–15 mph low at EF2–EF4 for that reason alone (Phase 8 validation).
  Now the DOD speed is the 10 m open-terrain peak, with houses at town sites in the town's
  roughness field (loads unchanged: local roof-height wind). `tornadoPass` takes a site and
  returns both peaks; DMG-04, -05, -10, -15 restated on the 10 m basis.
  `scripts/calibrate-houses.ts` rerun (all ten DODs within 0.7%; strong DOD 10 at 217 mph, so
  the strong sweep factor ×1.21 stays). Calibrated parts fell to 0.64–0.70 of their v2.4 values
  (Pa): siding 633 → 428, covering 2288 → 1540, windows 2094 → 1342, anchorage 2718 → 1746,
  roof bays 1593 → 1035, wall panels 1020 → 653, partitions 2637 → 1913, core room
  3967 → 2820, slab sweep 6152 → 4318; garage door and deck stay at their engineering values.
  The drop is (1/1.19–1.23)², the mean 10 m open ÷ roof-height ratio at first reach in the
  setting: the town's roughness (×0.89 at roof height) and open terrain's own height profile
  (the 10 m wind is ≈ 1.08× the ~4 m roof-height wind at β 0.11). DMG-09 now puts the steady
  ramp on the same basis with that ratio, and DMG-06 its 50 mph (≈ 41 mph local). Knock-on:
  Spec 13 v1.1's lab pass calm threshold 50 → 40 mph.

- v2.4: siding recalibrated 716 → 633 Pa for Spec 01 v1.10. The smaller pressure deficit
  outside the core (the free-vortex outer decay) put less outward load on siding as the tornado
  approached, so DOD 1 moved to 68.6 mph against 65 expected (DMG-04). `scripts/calibrate-houses.ts`
  rerun; the other parts stayed within their tolerance and keep their values. DOD 1 now 64.9 mph.
- v2.3: strong houses' slab sweep ×1.21, was ×1.6 (DMG-15). DI 2 rates well-built houses at the
  upper bound, 220 mph for DOD 10 against 200 expected: (220/200)² on the lateral pressure. At
  ×1.6 the median was ~250 mph and in town passes only 15–31% of strong houses at 220–239 mph
  were swept (found by the user: too few swept slabs in an EF5 through strong houses).
- v2.2: closest approach to the core edge recorded per house (DMG-14), at the user's request.

- v2.1: debris impacts (Spec 10): queued impacts are applied at the start of each evaluation
  (even when calm), impulse pressure adds inward to wall panels and the garage door, holes
  are openings, DOD 1/2/4 count debris-stripped area. Calibration (isolated houses) unchanged.

- v2.0: component houses (Phase 4). Bearing-wall collapse (DMG-13) added after the user saw
  roofs standing on missing walls. Parts became individual components (panels, panes,
  roof sections with covering and deck, bays, partitions); DOD judged from what's missing;
  progressive roof and wall failure, per-panel bracing, free-standing loads on open houses;
  corner-only roof edge zones and wider covering scatter; Kaplan–Meier medians for censored
  passes; DMG-11 and DMG-12 added; recalibrated (all ten DODs within ~1% in tornado passes).
- v1.2: survey estimate adjusted within the DOD bounds by construction quality.
- v1.1: calibration moved from steady wind to tornado passes (steady wind biased roof failures
  early by about 15 mph, because side-window breaches shielded the roof).
- v1.0: written and approved for Phase 2.
