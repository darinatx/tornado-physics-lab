# Spec 02 — Structural Loads

Status: Approved (v2.0)

## Purpose

Turn the local wind and pressure at a building into net pressures on its parts: walls,
openings, roof covering, roof deck and roof structure. This spec computes loads only; Spec 03
decides what fails.

## Model

All loads follow the wind-engineering approach used in building codes (ASCE 7 style), adapted
to tornadoes.

### Reference wind and velocity pressure

Wind is sampled with `windAt` (Spec 01) at the building's mean roof height h. The velocity
pressure is

```
q = ½ · ρ · |V|²          (Pa, using the full 3D ground-relative wind)
```

### External pressure coefficients (C_p)

Each wall face has an outward normal n. With û the horizontal direction the wind blows toward,
c = −û·n is 1 when the wind hits the face head-on.

| Surface | Condition | C_p |
|---|---|---|
| Windward wall | c ≥ cos 45° | +0.8 |
| Leeward wall | c ≤ −cos 45° | −0.5 |
| Side wall | otherwise | −0.7 |
| Roof, whole-roof average (structure) | always | −0.9 |
| Roof deck panels (edge zones) | always | −1.2 |
| Roof covering (edges and corners) | always | −1.8 |

### Internal pressure (C_pi)

- **Enclosed** (no openings failed): C_pi = +0.18, the code value for the worst case under uplift.
- **Breached**: a failed window, garage door or roof-deck section is an opening. Using the
  dominant-opening rule, C_pi = 0.75 × (area-weighted C_p of the failed openings). A
  windward breach pressurizes the house and greatly increases roof uplift; a leeward or side
  breach does the opposite. As the tornado passes and the wind swings around, the same
  opening can change from helping to hurting.

### Atmospheric pressure change (APC)

The tornado's pressure drop Δp_out (Spec 01) arrives faster than a closed house can vent. The
internal deficit lags the external one:

```
dΔp_in/dt = (Δp_out − Δp_in) / τ        τ = 2 s sealed, 0.05 s once breached
p_APC = Δp_out − Δp_in                  (positive = pushes the envelope outward)
```

### Net loads per component (positive = toward failure)

| Component | Net load |
|---|---|
| Siding (per face) | q·(−C_p,face + C_pi) + p_APC |
| Roof covering section | q·(−C_p,cover + C_pi) + p_APC, C_p,cover = −1.8 (corner) / −1.0 (field) |
| Roof deck section | q·(−C_p,deck + C_pi) + p_APC − w_deck, C_p,deck = −1.2 (corner) / −0.8 (field) |
| Roof bay (rafters) | q·(0.9 + C_pi) + p_APC − w_roof |
| Window pane, garage door | abs(q·(C_p,face − C_pi) − p_APC) |
| Wall panel | abs(q·(C_p,face − C_pi) − p_APC); the sign says whether it's pushed in or pulled out |
| Wall panel, open house | max of the above and q·1.3·|cos θ| (free-standing wall), once half the panels or the whole roof are gone |
| Partitions, anchorage, sweep | lateral q·(C_p,windward − C_p,leeward) = 1.3·q (anchorage × standing-wall fraction) |

w_deck and w_roof are dead loads (self-weight) that resist uplift. A positive wall-panel net
(q·(C_p − C_pi) − p_APC > 0) pushes the panel inward, so it falls into the house; negative
pulls it out.

### Openings

Failed window panes (1.44 m² each), the garage door, failed deck sections (section area, at
the roof C_p) and failed wall panels (panel area) all count as openings in the dominant-opening
rule. A failed bay opens its four sections.

## Interface

```ts
// src/core/damage/loads.ts
function faceCp(windDir: Vec2, faceNormal: Vec2): number;
function internalCp(b: Building, windDir: Vec2): number;
function computeLoads(b: Building, wind: Vec3, pApc: number): Loads;   // Pa per part
function updateApc(b: Building, deficitOut: number, dt: number): number; // returns p_APC
```

## Parameters

| Name | Unit | Value | Source / note |
|---|---|---|---|
| C_p windward / leeward / side | – | +0.8 / −0.5 / −0.7 | ASCE 7 low-rise walls (approx.) |
| C_p roof avg / deck edge / cover edge | – | −0.9 / −1.2 / −1.8 | ASCE 7 roof zones (approx.) |
| C_pi enclosed | – | +0.18 | ASCE 7 |
| dominant-opening factor | – | 0.75 | Holmes, *Wind Loading of Structures* |
| τ sealed / breached | s | 2 / 0.05 | typical house leakage; lab tornado-simulator studies |
| w_deck / w_roof | Pa | 100 / 600 | ~2 psf sheathing, ~12 psf roof dead load |

Values live in `src/config/buildings.ts`.

## Acceptance criteria

- **LOAD-01**: q = ½ρ|V|² using the 3D wind at roof height.
- **LOAD-02**: Face C_p is +0.8 / −0.7 / −0.5 for windward / side / leeward across every
  building yaw and wind direction, and 0 when there's no wind.
- **LOAD-03**: C_pi is +0.18 when enclosed; with a single windward breach it's 0.75·0.8, with a
  single leeward breach 0.75·(−0.5), and it follows the area-weighted rule for several.
- **LOAD-04**: APC: with Δp_out rising, a sealed building gets a positive p_APC that tends to
  Δp_out·(1 − e^(−t/τ)) behavior; a breached building equalizes within 0.5 s; p_APC → 0 when
  Δp_out is steady.
- **LOAD-05**: Roof uplift loads increase with C_pi and p_APC and are reduced by the dead load.
- **LOAD-06**: Edge roof sections carry higher covering and deck loads than field sections in
  the same wind, and a wall panel's load sign is inward on the windward face and outward on
  side and leeward faces of an enclosed house.

## Simplifications / out of scope

- Single-zone pressure coefficients by sector (no smooth angular C_p curves, no gable/hip roof
  differences, no shielding by neighbors).
- Buildings don't change the wind field.
- Tornado-specific C_p values (which lab studies show can exceed code values) are not used;
  calibration in Spec 03 absorbs the difference.

## Changelog

- v2.0: per-component loads (roof sections by edge/field zone, bays, panels, panes) and
  more opening types (Phase 4); LOAD-06.

- v1.0: written and approved for Phase 2.
