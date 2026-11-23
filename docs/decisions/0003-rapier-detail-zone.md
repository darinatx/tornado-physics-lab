# ADR 0003 — Rigid-body engine (Rapier) for a structural detail zone

Date: 2026-11-23
Status: Proposed (Phase 5)

## Context

ADR 0002 chose a custom debris integrator over a physics engine, noting: "If stacking or
articulated collapse ever matters, revisit with Rapier." The user now wants realistic,
physics-based buildings: many more components, damage that emerges from forces, and real
toppling, hinging and collisions. That needs joints that break under load, contact and
stacking, which is exactly what a rigid-body engine provides.

A browser rigid-body engine handles roughly 5,000–10,000 active bodies at 60 Hz. A
member-level house is ~300–600 bodies, so only ~20–40 houses can be breaking apart at once
(intact houses sleep at near-zero cost).

## Decision

- Use Rapier (WebAssembly) in a Web Worker for a **detail zone**: the ~100–200 houses nearest
  the camera and the tornado path, simulated at member level with breakable joints.
- Keep the Phase 4 calibrated component model for every other building, and as the reference
  the detail-zone houses are validated against (same DI 2 table, same loads).
- Hand-off: a house entering the zone is rebuilt from its current component state; one leaving
  it keeps its final state.
- Aerodynamic loads stay ours (Spec 02); Rapier applies them as forces on members and handles
  joints, contact and collisions. Debris inside the zone becomes Rapier bodies, enabling true
  impacts (Phase 6).

## Consequences

- ~1.5 MB WebAssembly, async start-up, and a worker boundary for state.
- Determinism needs Rapier's deterministic build and a fixed step; replay (Phase 11) must allow
  for it.
- Two building models to keep consistent; validation tests compare them.
