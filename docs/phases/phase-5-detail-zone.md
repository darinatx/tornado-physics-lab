# Phase 5 — Structural Physics Detail Zone

Status: Done (signed off 2026-11-23)

## Goal

Houses near the camera and the tornado path simulated at framing-member level: real
connections that break under load, and rigid-body physics (Rapier) for everything that comes
loose. The Phase 4 component model covers the rest of the town and is the reference.

## Slices

- **A — Structure lab:** one detailed house, steady wind control, load-path solver, member
  aerodynamics, Rapier bodies, splitting and contact forces. User reviews the look and motion.
- **B — Detail zone in town:** the 30 houses around a spot the user picks (user's choice after
  profiling showed ~120 torn-apart houses cost 15× the real-time budget), hand-off from the
  Phase 4 model, tornado wind and APC, physics in a Web Worker with a bounded lead, light
  pieces on the Spec 04 debris model.
- **C — Validation and performance:** detailed houses reproduce the DI 2 table in tornado passes;
  frame-time budget; sleeping and level of detail.

## Specs touched

- [09 — Structure](../specs/09-structure.md): STR-01 to STR-08 (slice A); STR-21–22 (lab tornado pass)
- [ADR 0003](../decisions/0003-rapier-detail-zone.md): accepted

## Exit criteria (whole phase)

- [x] Slice A demo reviewed by the user (`?lab`; doors, hallways, drywall, siding over OSB,
      notched sheathing and casing at openings, glass shards)
- [x] Slice B: detail houses around the chosen spot; hand-off has no visible pop
- [x] Slice C: detailed houses within ±10% of DI 2 expected speeds (three independent
      samples: within ±8%, ±5%; STR-24)
- [x] Slice C: frame budget — accepted at sign-off as: main thread ~16 ms per frame (draw ~6,
      advance ~10); physics in a worker, so the sim slows to ~0.15–0.3× only while the chosen
      houses are torn apart, then returns to real time. Faster core passage carried to Phase 12 (performance; renumbered 2026-11-25 and twice on 2026-11-26).
- [x] All tests pass; `npm run verify` passes
- [x] Specs updated, simplifications note and retro written
- [x] User sign-off; commit tagged `phase-5-done`

## Slice A notes (for slice C)

- Gable ends hang on three 3 kN nailings to the end-wall top plates only (no end-rafter or
  ceiling-diaphragm ties), so ~800 Pa of outward APC push alone tears them off. Real gable
  ends are a known weak point, but this is too weak.

- Roof structure lets go too early (~86 mph steady vs DI 2's ~122 mph for DOD 6): rafter
  uplift has no help from gable ends, ridge or ceiling joists yet, and attached roof loads use
  deck zone coefficients over the whole roof.
- Impact forces: now converted to a 0.1 s wood-on-wood contact duration (was a one-step
  spike). Still to do: cap by member crushing strength.
- After a sudden 95 mph gust a standard house ends at roughly DOD 6–7 (8 of 14 wall frames
  standing): too destructive, driven by the early roof lift-off and its crash.
- Gable ends are open framing (no gable sheathing), there's no separate shingle layer, and
  studs don't break individually.
- Lab tornado pass (STR-21/22): a standard house under a direct EF3 hit loses its first
  shingles at ~71 mph roof-height wind and the roof is coming apart by ~120 mph, close to the
  steady-wind behaviour above. Fixed along the way: the funnel shader didn't compile under the
  lab's logarithmic depth buffer, and the lab camera couldn't look up at a funnel aloft.

## Slice B notes (for slice C)

- Cost while the 30 spot houses are torn apart: ~50–100 ms per 1/60 s step in the browser
  worker (the sim runs at ~0.2–0.3× through the core passage, then back to real time).
  Rapier is ~40% (1,000–2,000 awake chunks and pieces still tearing loose); the rest is aero on
  bodies, the load-path solves and bookkeeping. Waiting houses cost ~4 ms per step in total.
- Entering 30 houses stalls the worker ~1 s (≈30 ms per house to build colliders).
- Light pieces fly on the Spec 04 model without turbulence and land on the ground, not on
  slabs (they can sink up to 0.3 m into a slab).
- Damage colors tint component houses only; detailed houses show their real materials.

## Slice C notes

- Validation harness: `scripts/validate-detail.ts` (tornado passes like the component model's
  calibration, parallel processes). Physics added while validating is listed in Spec 09 v0.9.
- Calibrated within published ranges: shingles 1.8 kPa, siding 0.4 kPa, rafter toe-nails
  2.5 kN, wall base moment 2.5 kN·m/m, interior box share 0.3.
- Detail cost per 1/60 s step over a 30-house pass: ~2–9 ms while houses wait, ~80–120 ms at
  the core (Rapier ~45%, member aero ~20%, load checks ~10%). The core passage plays in slow
  motion; the remaining lever is fewer/cheaper rigid bodies for chunks.

## Simplifications note

- Detail is limited to the 30 houses around a spot the user picks; the rest of the town stays
  on the Phase 4 component model.
- Members are rigid: studs, rafters and sheets don't bend or break, only connections fail.
  Load sharing (rafters through the sheathing, walls through the ceiling diaphragm, panel
  neighbors and corners) is a rule on top of the load-path solve, not a stiffness model.
- Pieces under 40 kg go to the Spec 04 debris model once clear of the house, so they don't
  collide with standing framing afterwards.
- DOD 5 (house shifted off its foundation) isn't represented: wall frames aren't tied into one
  box that could slide; it is reached together with DOD 6.
- Five strengths are calibrated within published test ranges (shingles, siding, rafter
  toe-nails, wall base moment, interior box share); the rest come from code and test values.
- Per-house variability is lognormal on build quality, covering condition and connections.
- Impact forces aren't capped by member crushing strength yet.

## Retro

The user's visual review again found real gaps: missing doors and hallways, missing drywall,
seams at windows and corners, a slab that wasn't centered, and pieces dancing at 0 wind. The
dancing came from four physical bugs (colliders too thin, wrong collider mass, no rotational
drag, bodies kept awake), not from a display issue.

Performance shaped the scope: ~120 torn-apart houses cost 15× the real-time budget, so the user
chose a picked spot of 30 houses, and light pieces hand off to the debris model.

Validation lessons: each early failure traced to missing physics rather than a strength to
tune. Examples:
- The building-code roof pressures by slope and wind angle were missing.
- Rafters weren't sharing load through the sheathing.
- Houses felt the tornado's pressure drop as a jump on entry.
- Open houses were missing free-standing wall loads, and bare framing was missing drag.

Calibrating only after those were in kept the tuned values inside published ranges.

## Follow-up: detail zone performance (after sign-off, at the user's request)

Keep the detail, make it faster (Spec 09 v0.11, STR-26–30). Core passage of 30 houses, per
1/60 s detail step: ~95 ms in one worker before → ~50 ms of work spread over 8 street-row
physics groups on 6 workers; the costliest group ~11 ms. In the browser the sim holds
0.8–1.0× real time through the core (was 0.2–0.3×).

| Change | Effect at the core |
|---|---|
| Rapier SIMD build | solver ~40% faster |
| Body-frame wind on rigid pieces, one force and torque per body | wind ~20 → ~6 ms |
| Resting rubble (and still light pieces to the debris model) | awake bodies ~1,600 → ~800 |
| Entry spread over steps (400 colliders per step) | no ~30 ms spike per house |
| One world per street row, rows spread over workers | ~4× in parallel |
| Pose bookkeeping | ~9 → ~3 ms |

Simplification added: pieces don't hit houses in other street rows (41 m across the street,
69 m back to back) until Phase 6. Profile: `npx tsx scripts/profile-detail.ts [x,z] [engines]`.
