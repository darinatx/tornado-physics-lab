# Spec 03 — Damage Model

Status: Approved (v1.2) — Phase 2 scope: one- and two-family houses (EF Damage Indicator 2)

## Purpose

Decide which parts of a building fail, in what order, and what damage rating (Degree of
Damage, DOD) and EF estimate that adds up to, the way a National Weather Service survey would.

## Model

### Damage indicator and degrees of damage

Houses use EF-scale Damage Indicator 2 (one- or two-family residences). Each DOD has an
expected wind speed and a lower–upper bound (mph, 3-second gust):

| DOD | Damage | Lower | Expected | Upper | Part that fails |
|---|---|---|---|---|---|
| 1 | Threshold of visible damage | 53 | 65 | 80 | siding and trim |
| 2 | Loss of roof covering (< 20%), gutters, siding | 63 | 79 | 97 | roof covering |
| 3 | Broken glass in doors and windows | 79 | 96 | 114 | windows |
| 4 | Uplift of roof deck, > 20% covering lost; garage door collapse | 81 | 97 | 116 | roof deck or garage door |
| 5 | Entire house shifts off foundation | 103 | 121 | 141 | foundation anchorage |
| 6 | Large sections of roof structure removed | 104 | 122 | 142 | roof structure |
| 7 | Top-floor exterior walls collapsed | 113 | 132 | 153 | exterior walls |
| 8 | Most walls collapsed except small interior rooms | 127 | 152 | 178 | most walls |
| 9 | All walls collapsed | 142 | 170 | 198 | all walls |
| 10 | Slab swept clean | 165 | 200 | 220 | remaining structure |

*Values transcribed from the EF scale's DI 2 table (WSEC 2006); to be checked against the
source document.*

### Parts, capacities and fragility

Each house has the parts in the table. Each part has a **capacity** (Pa of net load from
Spec 02) and fails, permanently, the first time its load exceeds its capacity. Capacities are
random per house so identical houses don't all fail at once (fragility):

```
capacity = base × class factor × house quality × part scatter
house quality ~ lognormal(median 1, β = 0.12)    shared by all parts of a house
part scatter ~ lognormal(median 1, β = 0.18)     independent per part
```

The base capacities are **calibrated against simulated tornado passes**, because that's what
the EF scale's expected speeds describe: the wind that caused the damage. Standard houses are
passed near the core of strong translating tornadoes (V_max 55–80 m/s, R_max 150–300 m,
10–18 m/s forward speed, random headings and offsets within ±0.8·R_max). For each DOD, the
median peak wind a house had felt when it first reached that DOD must match the table's
expected value. Swinging wind direction, internal pressure and venting all act during
calibration, so they shape the *spread* and *order* of damage without being double-counted.
`scripts/calibrate-houses.ts` reproduces the values.

A first calibration in steady wind turned out biased: in steady wind, side-wall windows break
first and *lower* the internal pressure, which shields the roof. In a real tornado the wind
direction swings and the pressure drops quickly, so that shield is unreliable, and roofs
failed about 15 mph too early. Calibrating in tornado passes removed the bias.

### Order and dependencies

- Exterior walls are 1.6× stronger while the roof structure is attached (the roof braces them).
- Most walls can fail only after the exterior walls; all walls only after most walls; the slab
  is swept clean only after all walls.
- The roof covering, deck and structure stop carrying load once the roof structure is gone.

### Construction classes

| Class | Share | Factors |
|---|---|---|
| Weak (older, toe-nailed roof, few anchors) | 25% | roof structure ×0.7, anchorage ×0.6, walls ×0.85 |
| Standard | 55% | ×1 |
| Strong (hurricane straps, anchor bolts, impact windows) | 20% | roof structure ×1.6, anchorage ×1.6, walls ×1.3, windows ×1.4, garage ×1.5, deck ×1.3 |

### Damage rating and EF estimate

A house's DOD is the highest DOD whose part has failed. As in EF-scale survey practice, the
assigned wind speed is adjusted within that DOD's lower–upper bounds by construction quality:

| Class | Assigned speed |
|---|---|
| Weak | lower bound (it failed at less wind than a typical house) |
| Standard | expected value |
| Strong | upper bound (it took more wind than a typical house) |

The EF estimate is the EF of the assigned speed, reported with the DOD's full range. This is how
real EF5 ratings arise: a well-built house swept off its slab is rated at 220 mph (EF5), while
a typical one swept clean is rated 200 mph (EF4) and a weak one 165 mph (EF3).

### Update rate

Damage is evaluated at 30 Hz (every 4th physics step) for houses within 6·R_max of the
tornado; farther houses see only the translation wind, which is below every threshold.

## Interface

```ts
// src/core/damage/building.ts
function createHouse(spec: HouseSpec, rng: () => number): Building;
function updateBuilding(b: Building, wind: Vec3, deficitOut: number, dt: number, time: number): boolean; // true if damage changed
function degreeOfDamage(b: Building): number;            // 0–10
function efFromDamage(dod: number): { ef: EFRating | null; low: EFRating | null; high: EFRating | null };
function buildingReport(b: Building): BuildingReport;     // for the inspector
```

## Parameters

Base capacities, class factors and fragility β live in `src/config/buildings.ts`.

## Acceptance criteria

- **DMG-01**: Failures are permanent and the DOD never decreases.
- **DMG-02**: Dependencies hold: no house has a later wall stage failed without the earlier
  ones, and exterior walls get the 1.6× bracing bonus only while the roof structure stands.
- **DMG-03**: Cascade: for otherwise identical houses in the same wind, a windward garage
  breach makes the roof structure fail at a lower wind speed than with no breach.
- **DMG-04** *(validation)*: In simulated tornado passes (as described above, independent
  sample), standard houses reach each DOD at a median peak wind within ±5% of the DI 2
  expected value.
- **DMG-09** *(validation)*: In steady wind ramps from all directions, standard houses reach
  each DOD at a median speed inside the DI 2 lower–upper bounds.
- **DMG-05**: Weak houses reach DOD 6 at a lower median speed than standard ones, and strong
  houses at a higher one.
- **DMG-06**: Below 50 mph steady wind, fewer than 1% of standard houses show any damage.
- **DMG-07**: Same seed → identical capacities and identical damage histories.
- **DMG-08**: The EF estimate for each DOD uses the lower bound for weak houses, the expected
  value for standard ones and the upper bound for strong ones, and the range comes from the
  lower and upper bounds.
- **DMG-10** *(validation)*: Strong houses passing through the core of an EF5-strength tornado
  can be surveyed EF5; no house passing through an EF4-strength tornado (peak wind < 200 mph)
  is surveyed EF5.

## Simplifications / out of scope

- Only DI 2 houses in Phase 2. Other indicators (mobile homes, apartments, commercial,
  trees, poles) arrive with the city in Phase 4.
- Windows fail from pressure only. Debris impacts, the main cause of broken windows in real
  tornadoes, arrive in Phase 4, and calibration will be revisited then.
- Quasi-static: no dynamic amplification or fatigue from gusting.
- One story: "top-floor exterior walls" means the exterior walls.

## Changelog

- v1.2: survey estimate adjusted within the DOD bounds by construction quality (DMG-08 updated,
  DMG-10 added). Before this, DOD 10 always rated EF4 (200 mph expected), so even an EF5
  tornado could never produce an EF5 survey rating.
- v1.1: calibration moved from steady wind to tornado passes (steady wind biased roof failures
  early); DMG-04 updated and DMG-09 added for the steady-wind check.
- v1.0: written and approved for Phase 2.
