# Spec 14 — House Detail Level 2 (More Components and Contents)

Status: Draft (v0.1) — scope for user review. Values marked *to source* are technical and are
settled (with a cited source) before approval; they don't need the user.

## Purpose

Today's detailed house (Spec 09) is a bare frame: walls, roof, windows, doors, drywall and
interior walls. Real houses add parts that fail early and loudly (porches, chimneys, brick
veneer, fences), a roof that's usually a truss, and several tonnes of contents that become a
large share of the debris field (furniture, appliances, mattresses, cabinets). This spec adds
them as **detail level 2**. Level 1 is today's house.

Level 2 is part of the shared house model, not a lab feature. The lab always builds level 2;
the town's detail zone uses it when its time budget allows; the component model gets the
matching mass and debris, so detailed and town houses still agree.

## Model

### Detail levels

| Level | Contents | Where |
|---|---|---|
| 1 | Spec 09 house (today) | town detail zone while level 2 is over budget |
| 2 | level 1 + the components and contents below | the lab; the town detail zone when it fits STR-30's budget |

The component model (Spec 03/04) has no levels: it gets level 2's extra parts as
calibrated components and debris (below), so a town house and a detailed house of the same
spec stay aligned (the alignment check).

### New structural components

Each is members and connections in the Spec 09 sense (rigid boxes with real size and density,
connections with ultimate capacities), loaded by Spec 02 pressures and failing through the
same load-path solver.

| Component | Share of houses | Members | Key connections (ultimate) |
|---|---|---|---|
| **Roof trusses** (instead of rafters + ceiling joists) | 70% (most one-story houses since ~1970) | Fink trusses of 2×4 chords and webs at 0.6 m, each one rigid member group; gable-end truss; lateral bracing | truss-to-plate toe-nails as today's rafter toe-nails, or hurricane clips by construction class; truss plates at heel and peak *to source* (Wolfe & LaBissoniere 1991; Shanmugam et al. 2009) |
| **Front porch** | 50% | shed roof over the front door (rafters, sheathing, shingles), beam, 2–3 posts (4×4) | ledger to wall (nails or lag screws), post to beam (toe-nails), post base to stoop (unanchored or post base) *to source* |
| **Masonry chimney** | 25% (fireplace) | brick stack, 0.6 × 1.0 m, rising 1 m above the ridge, in 0.5 m courses as members; flashing | unreinforced masonry in flexure at the roof line, flexural tensile strength *to source* (TMS 402, ~0.3–0.7 MPa); courses break apart as heavy debris |
| **Brick veneer** (cladding option, instead of vinyl siding) | 30% (by region; *to source* from census of construction) | brick wythe panels per wall panel, 90 mm, ~1,900 kg/m³ | corrugated ties, one per 0.25 m² (TMS 402), pull-out/buckling *to source*; veneer falls as panels and brick chunks |
| **Gutters and downspouts** | 80% | aluminum K-gutter along each eave, 0.6 kg/m, in 3 m lengths; downspouts at corners | hangers at 0.6 m *to source* |
| **HVAC condenser** | 90% | 0.75 m cube, 80 kg, on a pad beside the house | none (resting, μ = 0.4 on concrete) or two straps (by construction class) |
| **Backyard fence** | 60% | wood privacy fence, 1.8 m, 2.4 m panels, posts set in concrete | post base moment capacity *to source* (wood post in footing); pickets to rails (nails), panels fly as sheets |

Decisions:
- **Trusses as the default roof.** A typical ranch built after ~1970 has a truss roof, not
  stick framing. The truss is stiffer and fails at the heel connection and through the
  gable-end bracing, which differs from rafters. Rafters stay for the other 30%.
- **Porches and chimneys** are among the earliest failures EF surveys note (DI 2, DOD 2–3 area).
  Brick veneer and fences are major heavy and sheet debris sources in survey photos.
- **Only parts with a clear wind failure or debris role.** Screens, shutters, roof vents,
  insulation as loose fill and window frames are left out: small mass, no structural role.

### Contents

A furnished house's contents, room by room (Spec 09 floor plan), each a rigid box or a few
boxes with real size and mass.

| Room | Items (mass, kg; anchorage) |
|---|---|
| Kitchen | base cabinets with countertop (60/m; screwed to studs), upper cabinets (25/m; screwed to studs), refrigerator (110; free), range (60; free), dishwasher (35; in cabinet), table (30) and 4 chairs (6 each) |
| Living room | sofa (55), armchair (30), coffee table (15), TV on stand (25), bookcase with books (70) |
| Bedrooms (each) | bed frame and mattress (queen 30 mattress + 25 frame; full 25 + 20 in smaller rooms), dresser (60), nightstand (12) |
| Bathroom | bathtub (steel 50 or cast iron 140; set on a mortar bed with drain: anchored), toilet (40; bolted), vanity (35; screwed) |
| Closet | clothes and boxes (40) |
| Garage | water heater (full: 50 gal tank 55 kg + 190 kg water; strapped to studs), washer (75), dryer (55), shelving with bins (60; free), car (Phase 10) |

Total: about 2.5–3.5 t, close to the ~30 kg/m² mean sustained residential live load from load
surveys (ASCE 7 commentary; *to source* the exact survey value) over a 150 m² house.

Physics:
- **At rest:** asleep on the slab until the wind can slide them (μ by material: wood on
  concrete 0.5, appliance feet 0.4) or lift them; free items aren't connected to anything.
- **Wind on contents:** drag on their exposed area (C_D 1.2, boxes), scaled the way Spec 09
  scales interior-wall loads: by the share of exterior wall gone, and sheltered while two walls
  of their room stand.
- **Anchored items** (cabinets, tub, toilet, vanity, water heater) are members with
  connections: screws to studs (*to source*, ~1 kN per #10 screw in shear), straps, bolts. A
  cabinet leaves with its wall when the wall goes.
- **Once loose:** Rapier rigid bodies, then light-piece hand-off under 40 kg (Spec 09), as
  members are. They hit houses and members through Spec 10.
- **Inside pressure:** contents don't change the house's internal volume or APC (simplification).

### Component (town) model

Each component house carries level 2's parts as calibrated components and debris:
- **Debris kinds** (Spec 04): mattress, cushion/chair, appliance (heavy), cabinet, brick
  chunk, chimney course, gutter length, fence panel, porch post. Plus **fines**: representative
  small missiles (papers, roofing nails, small objects) at a calibrated count, the ambient
  small-missile environment Phase 6 found missing.
- **When:** contents leave as Spec 03 already describes ("carries the house's last contents
  off"), now with the inventory above; porch, chimney, veneer and fence are new Spec 03 parts
  with fragilities calibrated against the detailed level 2 house (the Phase 4 way).

### Rendering

Simple shapes in plausible colors (cabinet wood, white appliances, fabric). They can be seen
through broken windows, open walls and the lab's cutaway. Brick veneer and chimneys are
textured as brick.

## Parameters

All sizes, masses, densities and capacities live in `src/config/structure.ts` (and
`debris.ts` for the new kinds), each with its unit and source, as Spec 09's do.

## Acceptance criteria

- **HSE-01**: A level 2 house has every component above at its share across seeds (±5% over
  1,000 houses), and every member is inside the house's lot and doesn't overlap another.
- **HSE-02**: Truss roof: under uplift, it fails at the heel connections first, the whole
  truss as one piece; with clips it holds to a higher wind than with toe-nails by the
  capacity ratio (±10%).
- **HSE-03**: Porch: the porch roof feels the underside pressure of an overhang (Spec 02) and
  lifts before the main roof in a wind toward the front.
- **HSE-04**: Chimney: fails in flexure at the roof line at the wind its masonry strength gives
  (±10%), and its courses fall as heavy debris.
- **HSE-05**: Brick veneer: ties fail by their capacity; veneer panels fall away from the wall;
  the sheathing behind is then exposed to wind.
- **HSE-06**: Contents mass per house falls within 25–40 kg/m² of floor area across seeds.
- **HSE-07**: Free contents stay at rest until the wind beats friction or weight; anchored
  contents leave only when their connections fail or their wall goes.
- **HSE-08**: Contents in the bathroom stay in place in houses that reach DOD ≤ 7 (the small
  interior room stands), and none remains on a DOD 10 slab.
- **HSE-09**: DI 2 validation at level 2: detailed level 2 houses reproduce the DI 2 table
  within ±5% per DOD (as STR-24).
- **HSE-10**: Alignment: town (component) houses and detailed level 2 houses of the same specs
  in the same pass agree within the alignment check's tolerances.
- **HSE-11**: Debris: the town debris field after an EF4 pass contains contents kinds and
  fines in the share the inventory gives (±20%), and the mass ledger (DEB-16) balances.
- **HSE-12**: Zero pass-through for every new part and content, in the lab and town checks
  (IMP-17, IMP-19, LAB-10).
- **HSE-13**: Cost: level 2's cost per detailed house is measured; the town detail zone uses
  level 2 only if STR-30 passes with it, otherwise level 1.

## Simplifications / out of scope

- Contents don't change internal volume or APC, and nothing inside the house channels flow.
- No basements, second stories or attached decks (Phase 10 building types).
- Cars in driveways and garages wait for Phase 10 (vehicles).
- Water, rain and debris inside the house (soaking, ceiling collapse from water) aren't modeled.

## Changelog

- v0.1: draft at the user's request (2026-11-25): more components and house contents for the
  structure lab and the detail zone, and the matching debris for the town.
