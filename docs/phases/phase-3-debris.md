# Phase 3 — Flying Debris

Status: Done (signed off 2026-11-23)

## Goal

Failed building parts become real flying objects (shingles, plywood, lumber, glass, wall
chunks) with realistic mass and aerodynamics. They're lofted, carried and dropped by the
tornado's wind, and slide or lift off again from the ground.

## Specs touched

- [04 — Debris](../specs/04-debris.md): DEB-01 to DEB-10
- [01 — Wind field](../specs/01-wind-field.md): WIND-20 (surface-layer environmental wind)
- [06 — Rendering](../specs/06-rendering.md): REND-09
- [07 — Instruments](../specs/07-instruments.md): INST-10
- [08 — Sim loop](../specs/08-sim-loop.md): SIM-09
- [ADR 0002](../decisions/0002-custom-debris-integrator.md): custom integrator, no physics engine

## Deliverables

- `src/config/debris.ts`, `src/core/debris/` (piece physics, pool, spawning)
- Failure events from the damage model into the debris pool
- Instanced debris rendering with tumbling; debris stats in the readout; layer toggle
- Tests for every criterion

## Exit criteria (all required)

- [x] All DEB, WIND-20, REND-09, INST-10 and SIM-09 tests pass (81 tests, 79 criteria, including the DMG-08/DMG-10 survey fix and DEB-11/DEB-12)
- [x] `npm run verify` passes
- [x] Demo: an EF4 lofts sheets hundreds of meters and light pieces travel farther than heavy
      ones (shingles/siding/OSB reach 200–400 m up and travel up to ~1.1 km; lumber and wall
      chunks stay within 5 m of the ground and travel 40–60 m median)
- [x] Demo: debris litters the ground across the damage path (permanent debris field; at the
      default 1.8 km view pieces are specks even at ×3)
- [x] Real-time cost stays modest with a full pool (~120 ms per simulated second, about 12% of
      one core at 1×)
- [x] Specs updated (01 → v1.5, 03 → v1.2, 04 → v1.2, 06 → v1.4, 07 → v1.5, 08 → v1.3), simplifications
      note and retro written
- [x] User sign-off; commit tagged `phase-3-done`

## Simplifications note

- Tumble-averaged drag and lift; orientation drives visuals only.
- No debris-on-debris collisions and no impacts on buildings yet (Phase 4).
- Pieces don't break apart further.
- Only a representative sample is simulated (3,000 at once); each piece stands for many real
  objects.
- Above the cloud base there's no storm flow, so pieces that reach it are removed as lofted
  into the storm instead of falling out downstream.
- Ground obstacles are a statistical snag distance, not real fences or trees.

## Retro

- The first full run showed three problems the unit tests couldn't: debris hung above the
  cloud base forever, light pieces skidded across the map forever, and a full pool cost a
  third of a CPU core. Measuring an end-to-end run before building visuals caught all three.
- One root cause was in the wind model, not the debris: the environmental wind didn't slow
  near the ground. Fixing it in Spec 01 (WIND-20) was more honest than tuning debris friction
  to compensate.
- Snagging as a mean free path (DEB-10) is a simple, testable stand-in for fences, crops and
  shrubs, and it fixed the never-settling debris.
- Found during review: the survey rating could never reach EF5, because DOD 10's expected
  speed (200 mph) is EF4. Spec 03 v1.2 now adjusts the rating within the DOD bounds by
  construction quality, as real surveys do; an EF5 run surveys its 159 swept strong houses as
  EF5, and an EF4 run produces none (DMG-10).
- Found during review: debris landed in one narrow band right of the path. Recycling erased
  earlier debris, near-ground wind was too strong (1 m profile floor), and snagged debris
  escaped whenever drag beat 3× its weight. Fixed with a permanent debris field, a 0.1 m
  floor (Spec 01 v1.5) and direction-dependent snag release; DEB-12 checks the spread.
- Whole-tornado validation runs made the suite take 2.5 minutes; `npm run test:fast` runs unit
  tests in ~30 s and `verify` keeps the full set for gates.
- Real-size debris is invisible from storm-chaser distance. The ×3 display option is clearly
  labeled; proper close-up camera modes belong in Phase 5.
