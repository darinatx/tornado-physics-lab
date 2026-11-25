# Phase 6 — Debris Impacts

Status: In progress (started 2026-11-24)

## Goal

Debris hits what it meets. Impact momentum and energy, against test values for each surface,
break windows, punch through walls and roofs, strip siding and shingles, and heavy pieces push
walls over. Full physics in the detail zone, the component model's representative pieces
elsewhere. Pieces stop passing through standing houses.

## Slices

- **A — Impact physics and the town:** Spec 10's envelope hit test, fragility by surface and
  missile, impulse loads, holes as openings, lodged lumber, bounce; all Spec 04 debris against
  all component houses. Demo: an EF4 pass through town; windows broken downwind of destroyed
  houses, 2×4s stuck in walls, debris piled against houses, the inspector saying what debris
  broke.
- **B — Detail zone:** impact-momentum glass breakage and crushing-capped impact forces in the
  Rapier houses; town debris and detail light pieces hit detailed houses and other street rows
  (fixed-latency exchange, deterministic).
- **Wind tunnel (ahead of slice C, at the user's request, 2026-11-25):** [Spec 12](../specs/12-wind-tunnel.md)
  stage 1: one house in a scripted wind, a debris launcher across zones and models, a record,
  pass-through on every run, and a parallel runner (`npm run tunnel`). Stage 2 (tornado replay,
  fragility ramps, reference missile tests, convergence, viewer) goes with slice C.
- **C — Validation:** reference tests (IMP-12), town pass statistics (IMP-13), cost check.

## Specs touched

- [10 — Debris impacts](../specs/10-impacts.md): new; slice A approved (IMP-01 to IMP-13)
- [03 — Damage](../specs/03-damage.md): impact failures, damage areas for siding and covering
- [04 — Debris](../specs/04-debris.md): pieces collide with houses
- [12 — Wind tunnel](../specs/12-wind-tunnel.md): new; stage 1 approved (TUN-01 to TUN-10)
- [09 — Structure](../specs/09-structure.md): slice B

## Exit criteria (whole phase)

- [ ] Slice A: IMP-01 to IMP-13 pass; demo reviewed by the user
- [ ] Slice B: spec written and approved; detail-zone impacts; determinism across worker counts
- [x] Wind tunnel stage 1: TUN-01 to TUN-10 pass
- [ ] Slice C: validation passes; frame cost of impact checks measured
- [ ] All tests pass; `npm run verify` passes
- [ ] Specs updated, simplifications note and retro written
- [ ] User sign-off; commit tagged `phase-6-done`

## Slice A notes

- Built: Spec 10 v0.1 (envelope clip, fragility by surface and missile, impulse loads with the
  crushing cap, holes as openings, lodging and release, bounce, representative copies);
  Spec 03 v2.1, Spec 04 v1.5. Tests IMP-01 to IMP-13.
- EF4 pass through town (seed 1, IMP-13): 2,051 houses lost their first window to debris;
  9,462 failures by debris in all; ~1.4 M impacts counting representative copies; 10 pieces
  lodged in walls (lumber is only released late, by partitions and swept slabs).
- Cost: hit tests add ~150 ms of CPU per simulated second at the core (649 vs 501 ms, main
  thread, `npx tsx scripts/profile-impacts.ts`); the sim stays faster than real time.
- To check at the demo: window breakage now spreads well ahead of the wind damage; glass
  thresholds still have to be checked against Masters et al. (2010).

## Slice A demo feedback (2026-11-24)

The user's review found, and these were traced to physical causes:

| Seen | Cause | Fix |
|---|---|---|
| Siding through walls | hit test used the piece's center only | box extent along each plane (Spec 10 v0.2) |
| Drywall through walls | detail-zone light pieces don't hit houses | slice B |
| Debris sliding through foundations | slabs weren't solid; snagging laid pieces at ground height; walls fell flat into the slab overhang; rubble overlapped neighbors' slabs | slabs as solids, push-out after every move, walls lean on the slab edge (Spec 10 v0.2–v0.4); 0.17% of pieces still overlap a slab at rest (heavy rubble at house corners) |
| Ground debris never re-lofted | half the sheets' lift pointed down on the ground; sliding pieces felt the wind at mm height | upward suction on the ground, nose-up lift-off, wind at 0.2 m (Spec 04 v1.6) |
| Pieces just slide / flap | no rough ground; tumbling started on any tiny hop | bumps hop sliding pieces (Spec 04 v1.7); tumbling only half a length clear of the ground |
| Flicker when the camera moves | linear depth buffer over 1 m–30 km | logarithmic depth (Spec 06 v1.8) |
| Camera kept flying | macOS sends no key-up while ⌘ is held; key-ups with modifiers ignored | REND-16 (Spec 06 v1.9) |
| Camera started behind the tornado | fixed offset | start over the town ahead of the tornado, facing it (REND-17, v1.10) |

Re-lofting in an EF4 town pass (grounded ≥ 1 s, then > 1 m up): 10% of grounded pieces before,
29% with ground lift, 51% with rough ground.

## Slice B, first part: detail-zone pieces and the houses around them (2026-11-24)

Spec 10 v0.6 (IMP-17). Detail pieces no longer pass through the houses around the zone: in
the detail pass-through check (12 s, 30 detailed houses), members crossing another house or
inside its slab went from ~1,600 to ~65. Also: SIM-10 test area and start point for fast
validation runs; `npm run check:alignment` (paired detail vs component patches).

Open:
- Core passage with a detail spot runs at ~0.5× real time in the browser (Phase 5 follow-up
  reached 0.8–1.0×): more light pieces keep moving (re-lofting and rough ground), and each one
  near a house is swept against the fixed shapes (~17 ms of ~90 ms per step at the core).
- A roof can stay up on a small interior room: the load path checks connection forces only,
  not whether what's left can carry the roof without tipping.
- Detail vs component alignment: diagnosed (detailed walls tear off their sills before the
  roof-to-wall toe-nails let go, 4 kN/m sheathing nailing is a design value, not the ~6.5 kN/m
  ultimate), not yet fixed; component rubble re-moving, glass impact breakage in the detail
  zone, house contents and the alignment criterion still to do.
- Town debris still passes through detailed houses' walls (stops at their slabs).

## Zero pass-through (2026-11-24, at the user's request)

Requirement: no piece of any house passes through any other house or its components, whatever
the row, zone or model. Now enforced by tests at zero: the quick town check (unit test), the
12 s detail check (IMP-17) and a 20 s full-town check (IMP-19). Spec 10 v0.7–v0.9.

How (each found by tracing a remaining crossing):
- Town debris hits detailed houses through a lagged, deterministic stand-in (IMP-18), and the
  detail physics sees every house in town (detailed ones through the same stand-in).
- Light pieces end every step outside everything fixed (put back, or pushed out away from the
  house); light pieces' bodies get full CCD and the same check after each physics step.
- Fixed shapes share one collision group (no pairs between them), so slab colliders can reach
  0.5 m into the ground at no cost; a sheet sliding on the ground slipped under a flush slab.
- Over a slab, the slab top is the floor; all rubble is pushed clear of slabs when placed.
- Checker fixes: a detailed house's slab is flush with its frames; a shifted house's floor is
  the slab top only over the slab.

Still: a few pieces dip 2–6 cm into the ground for a frame or two (Rapier contact softness on
hard landings). Detail-zone pieces stop at other houses but don't damage them yet, and town
debris doesn't damage detailed houses yet.

## Roof follow-through (2026-11-25)

Spec 09 v0.13 (STR-31): along-ridge roof suction is measured from the standing roof's windward
edge, not the original gable, so a roof that starts to go unzips. Detail validation (STR-24,
128 houses, 214 s): every DOD within ±5% of DI 2 (DOD 7 was +20%, DOD 8 +11%). STR-31 runs in
~3 s; the damage-both-ways validation (IMP-20) was cut from 30+ min to ~90 s (6 detailed and 9
town houses; zone size is a test-only sim setting).

Paired town check (offsets 330 and 450 m): detailed houses now hold up better than town houses
in the same wind (110–150 mph: DOD 5 vs 6.5, walls standing 61% vs 29%, material nearby 80% vs
30%). Town houses get neighbor-debris impacts their isolated calibration (DMG-04) never saw, and
detailed houses in town reach less than their isolated validation predicts: both to look into.

## Wind tunnel, stage 1 (2026-11-25)

Spec 12 v0.1 (TUN-01 to TUN-10). One house (component or detailed) in a scripted wind, a debris
launcher (town pieces, and detailed members from a stripped donor house in the target's physics
group or another), a record (samples, failures, impacts with their path, launches), pass-through
at every debris step, and `npm run tunnel` (worker threads). The tunnel flow is an optional
field of the wind state, so every model runs its town code unchanged.

- Library: 13 scenarios (window shots by all five paths, 2×4 wall shots, calm and 200 mph on
  both models, a 180° wind swing), 55 sim s in ~2 s wall on 9 workers. Component targets run
  50–300× real time, detailed ones 5–20×.
- Found on its first runs:
  - Detail pieces from another physics group bounced off a detailed house's windows without
    breaking them: the sim dropped those hits. Fixed (Spec 10 v0.11).
  - The pass-through checker flagged town debris going through a detailed house's window that
    its stand-in had just broken (a false alarm). Fixed in the checker.
- Seen, not changed (Spec 10 simplifications):
  - A 2×4 that perforates a component wall (461 J at 15 m/s) bounces off a detailed house's
    wall: detailed houses get the impulse but no hole, and nothing lodges in them.
  - A piece hitting another group's detailed window bounces off it, and the window breaks
    0.25 s later (the fixed lag).
  - Detailed members still dip up to 7 cm below the ground on hard landings (9 at 200 mph):
    counted in the record, not failed, as in IMP-17/19.
- Next (stage 2, with slice C): tornado replay, ramp-to-failure fragility, reference missile
  tests, timestep convergence, a viewer if wanted.

## Pass-through and perforation fixes (2026-11-25)

- Detailed houses take perforations like component ones (Spec 10 v0.12, IMP-22): a town 2×4 that
  goes through a detailed wall lodges in it, falls free when that wall goes, and its hole counts
  in the house's internal pressure (1 m² breaches it). Found by the wind tunnel.
- IMP-19 (7 crossings) and IMP-17 (2 crossings, 3 inside a slab) were failing in the working
  tree before this; now both at zero (Spec 10 v0.13):
  - fast pieces cut house corners in one step (in through a fallen end wall, out through the
    standing front wall): after passing an opening, the rest of the step is now clipped from
    inside;
  - Rapier's soft CCD look-ahead was a fixed 0.5 m: a 31 m/s chunk (0.52 m per step) ended a step
    12 cm inside a neighbor's wall. It now scales with each body's speed and spin;
  - checker: a shifted house's floor counts only over its slab when a piece comes in low (it
    already did for pieces leaving).
- Validation, run one file at a time: IMP-13, IMP-17, IMP-19, IMP-20, DEB-12/16, STR-14, STR-18,
  STR-24 and STR-29 pass.

**Open: STR-30 (detail-zone cost) fails.** The costliest physics group averages ~21 ms per
detail step over the 30-house core passage against the 16 ms budget (worst step ~110 ms). It was
already over before these changes (23–24 ms with the fixed look-ahead; the scaled look-ahead is
slightly cheaper). Also: `detail-zone.test.ts` run whole can hit vitest's "onTaskUpdate" worker
timeout (long synchronous loops); its tests pass when run on their own.

