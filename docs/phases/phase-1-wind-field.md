# Phase 1 — Wind Field

Status: Done (signed off 2026-11-23)

## Goal

A tunable tornado vortex over open farmland, with a live EF readout, strength presets, an inspect
probe, and a physics-shaped condensation funnel with a dust cloud. No buildings yet. This phase
proves out the physics core and the spec → test → code loop.

Scope added during the phase, at the user's request: the inspect probe and pins, presets and a
plain-language panel (Spec 07 v1.3), and the first visual pass pulled forward from Phase 5
(Spec 06 v1.2).

## Specs touched

- [01 — Wind Field](../specs/01-wind-field.md): all criteria (WIND-01 to WIND-19)
- [07 — Instruments](../specs/07-instruments.md): INST-01 to INST-07
- [06 — Rendering](../specs/06-rendering.md): REND-01 to REND-07
- [08 — Simulation loop](../specs/08-sim-loop.md): SIM-01 to SIM-07

## Before building

- [x] Spec 01 approved (v1.0; open questions resolved, see its Decisions section)
- [x] Spec 07 Phase 1 criteria approved
- [x] Spec 06 Phase 1 section approved
- [x] Spec 08 (sim loop) approved

## Deliverables

- `src/config/wind.ts`: all Spec 01 parameters with units and sources
- `src/core/wind/`: `types.ts`, `windField.ts`, `efScale.ts`, `lifecycle.ts`
- `src/core/math/`: small Vec2/Vec3 helpers (no Three.js dependency)
- `src/sim/loop.ts`: fixed-timestep loop and tornado translation along a path
- `src/render/`: scene, ground plane, orbit camera, instanced arrow field
- `src/ui/`: parameter panel and EF readout
- `tests/unit/wind-field.test.ts`, `instruments.test.ts`, `rendering.test.ts`, `sim-loop.test.ts`
- `tests/validation/rankine-analytic.test.ts`: comparison against the analytic Rankine profile

## Exit criteria (all required)

- [x] All WIND-*, INST-*, REND-* and SIM-* tests pass (42 tests, 40 criteria)
- [x] `npm run verify` passes (typecheck, tests, trace)
- [x] Demo: dragging V_peak changes the arrows and the EF readout live (EF4 → EF5 at 100 m/s)
- [x] Demo: with translation on, the right side of the path is visibly stronger
- [x] Demo: the lifecycle plays spin-up → mature → rope-out (phase shown in the readout)
- [ ] Steady 60 fps: physics, arrows and 8,000 dust tracers cost a few ms per frame. Not
      measured on a visible screen (the preview pane was hidden); deferred to the Phase 6
      performance pass, accepted at sign-off
- [x] Specs updated wherever the implementation differed (01 → v1.3, 06 → v1.2, 07 → v1.3, 08 → v1.1)
- [x] Demo: each preset shows its EF rating; hovering inspects conditions; clicking pins a probe
- [x] Demo: EF4 wedge funnel reaches the ground wrapped in a debris cloud; EF2 shows a funnel
      stub over a rising dust column
- [x] Simplifications note written (below)
- [x] User sign-off; commit tagged `phase-1-done`

## Simplifications note

Compared with a real tornado, this phase's wind field:
- is an analytic vortex, not a solved flow, so mass continuity between the inflow, updraft and
  swirl is not strictly enforced;
- has no turbulence or suction vortices; speeds represent 3-second gusts;
- treats the far field as a uniform wind equal to the tornado's forward motion;
- uses one terrain roughness everywhere, so buildings don't yet slow or channel the wind;
- runs a compressed lifecycle (5.5 minutes) so a whole tornado fits on screen.

## Retro

- Writing criteria as numbers paid off immediately: two of them (WIND-03, WIND-13) were
  ambiguous once inflow was included near the ground, and the tests exposed it before any
  visuals did.
- SIM-01 as first written conflicted with the SIM-02 frame clamp. Criteria within one spec
  need a consistency read before approval.
- The arrows were too small to read at the default camera distance; visual parameters need a
  look in the browser before the spec values are final.
- INST-06 caught a real bug: the strength slider's 30 m/s minimum excluded EF0/EF1 tornadoes,
  because the near-ground boost means weak tornadoes need less wind aloft than assumed.
- The hidden preview pane throttles frames, which made the dust look wrong. Stepping frames
  manually (and a headless height-distribution check) separated a throttling artifact from a
  physics problem.
