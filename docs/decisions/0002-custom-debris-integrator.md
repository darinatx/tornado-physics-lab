# ADR 0002 — Custom debris integrator instead of a physics engine

Date: 2026-11-23
Status: Accepted

## Context

ADR 0001 left the choice of a rigid-body engine (Rapier or cannon-es) to Phase 3. Debris
needs aerodynamic drag and lift in a 3D wind field, ground contact with friction, determinism,
and thousands of pieces.

## Decision

Write a small, pure TypeScript integrator (`src/core/debris/`) and don't add a physics engine.

## Reasons

- Engines don't model aerodynamics; every force that matters here (drag, lift, wind-dependent
  lofting) would be custom code anyway.
- Debris-on-debris collisions don't matter for tornado damage, and they're the main thing an
  engine would add.
- A pure integrator is deterministic across machines and testable against analytic solutions
  (terminal speed, quadratic drag), which the spec requires.
- No WebAssembly loading or extra bundle size (Rapier is about 1.5 MB).

## Consequences

- Pieces don't stack or collide with each other.
- Building impacts (Phase 4) use swept-point tests against building footprints, which the
  existing spatial grid already supports.
- If stacking or articulated collapse ever matters, revisit with Rapier.
