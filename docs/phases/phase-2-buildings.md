# Phase 2 — Buildings and Damage

Status: Done (signed off 2026-11-23)

## Goal

A neighborhood of about 4,300 houses that the tornado damages through real wind-engineering
physics. Each house is made of parts with calibrated capacities, damage cascades through
internal pressure and venting, and every house gets a survey-style damage rating (DOD) and EF
estimate you can inspect.

## Specs touched

- [02 — Loads](../specs/02-loads.md): LOAD-01 to LOAD-05
- [03 — Damage](../specs/03-damage.md): DMG-01 to DMG-09
- [05 — City](../specs/05-city.md): CITY-01 to CITY-04 (test neighborhood)
- [06 — Rendering](../specs/06-rendering.md): REND-08
- [07 — Instruments](../specs/07-instruments.md): INST-08, INST-09
- [08 — Sim loop](../specs/08-sim-loop.md): SIM-08

## Deliverables

- `src/config/buildings.ts`: DI 2 table, pressure coefficients, calibrated capacities
- `src/core/damage/`: loads, fragility, building state, reports
- `src/sim/city.ts`, `src/sim/world.ts`: neighborhood and damage updates in the loop
- `src/render/houses.ts`: instanced houses with damage visuals
- Inspector in the probe tooltip; neighborhood tally in the readout
- Tests for every criterion, including the DI 2 calibration check (DMG-04)

## Exit criteria (all required)

- [x] All LOAD, DMG, CITY, REND-08, INST-08/09 and SIM-08 tests pass (64 tests, 62 criteria)
- [x] `npm run verify` passes
- [x] Demo: an EF4 leaves a swath of DOD 7–10 houses in the core and lighter damage at the edges
      (77–90% destroyed within 150 m of the centerline, fading to DOD 1–2 at the fringe)
- [x] Demo: the right side of the path shows heavier damage than the left (damage reaches
      1 km right of the path but stops about 450 m left)
- [x] Demo: hovering a house explains its failures (parts in order, with load vs capacity)
- [x] Specs updated wherever the implementation differed (03 → v1.1: tornado-pass calibration)
- [x] Simplifications note and retro written
- [x] User sign-off; commit tagged `phase-2-done`

## Simplifications note

Compared with real houses in a real tornado:
- Pressure coefficients are code-style sector values (windward, side, leeward), not the
  higher, tornado-specific values measured in lab simulators; calibration absorbs the difference.
- Windows break from pressure alone. In real tornadoes most break from flying debris, which
  arrives in Phase 3–4.
- Houses are one-story boxes with gable roofs, all DI 2; no neighbors sheltering each other.
- The whole town uses the map's terrain roughness (open country in the presets).
- Damage is quasi-static: no dynamic shaking, fatigue or progressive tearing of roof covering.
- The DI 2 speed table was entered from memory of the EF-scale documentation and should be
  checked against the source.

## Retro

- The first calibration, in steady wind, was biased. Side-wall windows broke first and lowered
  the internal pressure, shielding the roof; in a moving tornado that shield is unreliable, so
  roofs came off about 15 mph early. Checking the in-sim result against the survey table
  caught it. Calibrating with actual tornado passes fixed it and is closer to what the EF
  scale means.
- Using the same houses every calibration round (common random numbers) turned a noisy,
  oscillating calibration into one that converges within 2.5%.
- Simulating the whole neighborhood made wind-only tests 50× slower; a `buildings: false`
  option kept the suite under 10 s.
- The hidden preview pane throttles frames and freezes screenshots, so final visuals need a
  look on a visible screen.
