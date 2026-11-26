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
- **Structure lab v2 (at the user's request, 2026-11-25):** [Spec 13](../specs/13-structure-lab.md):
  the lab rebuilt on the real sim (explicit layout, detail set, worker backends), the main
  renderer, camera and inspector, a member inspector, a neighborhood of component houses around
  the block, the tunnel's debris launcher with reference missiles, and debris replay (record
  the debris reaching a house in a pass, replay it in the lab). Replaces the slice A lab.
  It also gives slice C's reference missile tests a place to watch them.
- **C — Validation:** reference tests (IMP-12), town pass statistics (IMP-13), cost check.
- **D — Benchmark and profiling (added 2026-11-26, at the user's request; CLAUDE.md rule 9):**
  starts after slice C's validation session finishes, because it changes `src/core` and
  `src/sim`, which validation measures. Phase 6 passed its preliminary gate before this step
  existed, so its profiling comes before the final gate instead.
  1. Spec the benchmark harness (`npm run bench`). It has two scenes only, each a short fixed
     window around the core passage, not a full run:
     - an EF4 town pass, seed 1, covering the wind field, component damage, debris and hit
       tests;
     - the 30-house detail-zone core passage, covering Rapier in the workers.
     It reports ms per physics step by subsystem, keeps a saved baseline and flags a 10%
     regression. Then build it, tests first.
  2. Profile those scenes and the browser frame. List the hotspots, each with an estimated
     gain, confirmed by the benchmark afterwards. Known starting points: STR-30 (the costliest
     detail group averages ~21 ms per step against 16 ms), the core passage at ~0.5× real time
     in the browser, and the hit tests' ~150 ms per simulated second.
  3. Do the cheap, large wins here. Bigger ones go in the backlog (`perf`). Structural work
     (level of detail, cloud cost) stays in the performance phase.

## Specs touched

- [10 — Debris impacts](../specs/10-impacts.md): new; slice A approved (IMP-01 to IMP-13)
- [03 — Damage](../specs/03-damage.md): impact failures, damage areas for siding and covering
- [04 — Debris](../specs/04-debris.md): pieces collide with houses
- [12 — Wind tunnel](../specs/12-wind-tunnel.md): new; stage 1 approved (TUN-01 to TUN-10)
- [13 — Structure lab v2](../specs/13-structure-lab.md): new; approved 2026-11-25 (LAB-01 to LAB-15)
- [09 — Structure](../specs/09-structure.md): slice B

## Exit criteria

Preliminary sign-off (lets Phase 7 start; tag `phase-6-prelim`):

- [x] Slice A: IMP-01 to IMP-13 pass; demo reviewed by the user
- [x] Slice B: detail-zone impacts (glass, perforations, roof and siding tear-off, damage both
      ways); determinism across worker counts
- [x] Wind tunnel stage 1: TUN-01 to TUN-10 pass
- [x] Structure lab v2: Spec 13 approved; LAB-01 to LAB-20 pass; lab demo reviewed by the user
- [x] `npm run verify:fast` passes
- [x] Specs updated, simplifications note and retro written
- [x] User's preliminary sign-off (2026-11-26); tag `phase-6-prelim`

Final sign-off (tag `phase-6-done`):

- [x] Slice C, validation, in its own session alongside Phase 7 (CLAUDE.md Phase loop step 6):
      `npm run verify`, the validation tests, reference missile tests on detailed houses, frame
      cost of impact checks; findings in `docs/backlog.md` (run 2026-11-26: BL-001 to BL-003
      rechecked, BL-006 run, BL-007 to BL-012 new)
- [ ] Slice D: benchmark harness specced and built (`npm run bench`, baseline saved);
      profiling report with before/after numbers; cheap wins done, the rest in the backlog
- [x] Every Phase 6 backlog item decided by the user (fix, defer, accept); "fix" items fixed
      (2026-11-26: all eleven deferred, none to fix; see `docs/backlog.md`)
- [ ] User's final sign-off; tag `phase-6-done`

## Slice A notes

- Built: Spec 10 v0.1 (envelope clip, fragility by surface and missile, impulse loads with the
  crushing cap, holes as openings, lodging and release, bounce, representative copies);
  Spec 03 v2.1, Spec 04 v1.5. Tests IMP-01 to IMP-13.
- EF4 pass through town (seed 1, IMP-13): 2,051 houses lost their first window to debris;
  9,462 failures by debris in all; ~1.4 M impacts counting representative copies; 10 pieces
  lodged in walls (lumber is only released late, by partitions and swept slabs).
- Cost: hit tests add ~150 ms of CPU per simulated second at the core (649 vs 501 ms, main
  thread, `npx tsx scripts/profile-impacts.ts`); the sim stays faster than real time.
- To check at the demo: window breakage now spreads well ahead of the wind damage. Glass
  thresholds checked against the sources (Spec 10 v0.15, 2026-11-25): shingles 4.7 kg·m/s
  (Shah 2008, the data behind Masters et al. 2010; was 1.2), lumber 10.5 (NAHB 2002 2×4 tests;
  was 0.4), compact pieces unchanged at 0.4 (estimate, no direct test). EF4 pass (seed 1)
  after the change: 1,820 houses lost their first window to debris (not comparable to the
  2,051 above, which predates later debris changes).

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


## Town difference: detailed houses less damaged than town houses (2026-11-25)

Not the neighbors, and not a detail-zone bug: each patch house alone, in the patch's own
tornado, shows the same gap (≈160 mph: component DOD 8–9, detailed DOD 4). Cause, traced in the
wind tunnel (straight-wind ramps 60→200 mph, 12 houses in 15 s): in a steady or slowly veering
wind a detailed house loses its side windows first (suction −0.7 beats windward +0.8 − C_pi),
then part of its roof; every opening is then in suction, the inside pressure goes to about
−0.45, and that holds the rest of the roof down, up to 200 mph in 2 of 8 houses. That is the
mean-flow physics. In a real storm debris breaks the windward windows first; the town model
has that folded into its DI 2 calibration, the detailed model only gets it from debris that
actually hits it. The old alignment patch (60 m) had no houses upwind, so nothing hit.

With houses out to 130 m as debris sources (only the central 60 m compared and detailed), the
same 7 houses at 330 m offset: detailed DOD 7–10, town 7–9 (60 m patch: 4 vs 8). The alignment
check now uses that layout by default (`npm run check:alignment`).

Tried and left out (each equal or worse against DI 2 in the lab's straight-wind ramp): windward
roof slope C_p by pitch per ASCE 7 (roof loss across the ridge at ~178 mph instead of ~126),
roof openings at their own slope's C_p instead of −0.9 (60° wind: roof two-thirds gone at
190 mph instead of 166), and the windward overhang's underside pressure (first failure moves to
eave sheathing, and the stall comes earlier).

Open: in straight wind without debris a detailed house can still stall (wind-tunnel ramps);
an ambient small-missile environment (gravel, branches, far-field debris that isn't modeled)
would be the physical next step, for both models together (the town model would need
recalibrating without the debris it now folds in).

## Camera and inspector changes (2026-11-25)

At the user's request: Spec 06 v1.11 (W/S along the view including tilt, A/D pan, Q/E tilt,
arrows up/down and sideways; start view framed on the tornado, REND-14/15/17), Spec 07 v1.10
(short hover summary with distance from the core edge now and closest; pinned graph of wind
and pressure drop above the failure list; damage colors and repeat off by default; layout
columns so panels can't overlap, INST-13/14), Spec 03 v2.2 (closest approach, DMG-14).
To check at the demo: the keys feel right; the start view frames the tornado for each preset;
no overlap with four pins and the slow-motion message at a narrow window.

## Structure lab v2 (2026-11-25)

Spec 13 approved and built (v0.2). The lab (`?lab`) is now the real sim on a small layout:
`src/sim/lab.ts` on `createSim`, the main renderer, camera and inspector, the workers. The slice
A lab module is gone (its steady-wind bench lives on in `tests/harness/benchHouse.ts` for the
structure unit tests). LAB-01 to LAB-15 pass.

- Block of 1–12 houses (detailed or component), in the town's lots out to 130 m (suburban) or an
  open field; steady wind (live edits are keyframes) or a pass (mature, or full lifecycle timed
  to the block).
- Launcher: ASTM E1996 A–E and ICC 500 missiles at their standard's length, mass and arrival
  speed (the launch is solved in the wind blowing); click a surface to aim; a seeded stream from
  upwind.
- Member inspector (click a member: each connection's live load, capacity, utilization, and
  when and in what wind it failed); utilization colors; cutaway; failure log.
- Debris recording at any house (lab, or a pinned house in the main sim) and replay onto a lab
  house in the recorded wind, no wind, or the lab's wind. With dispersion off, every piece that
  flies to the house without touching the ground gets the identical first hit (27 of 27);
  with dispersion on, over three EF3 passes, 95 vs 98 pieces reach the house, first-hit speed
  13.4 vs 12.4 m/s (replayed pieces lose the favorable gusts that brought them into the box).
- Cost (LAB-11, costliest second of an EF3 direct hit, physics group time): 4 houses 1.73×
  real time, 12 houses 0.52× (the slice A lab measured ~1× and ~0.5×).

Found and fixed on the way:
- The detail and heavy-debris workers rebuilt the town from the seed, so an explicit layout
  (the tunnel's, the lab's) could only run in-process (Spec 08 v1.6).
- A siding strip inside a neighbor house was pushed out through its back wall when that
  house's roof shapes were rebuilt over it (LAB-10; Spec 10 v0.16).

Open:
- **IMP-19 fails at HEAD before this work** (2 crossings in the 20 s town pass: one "through
  wall", one "out through roof", town debris), most likely since the glass thresholds changed
  (Spec 10 v0.15). Not caused by the lab; to trace.
- To check at the demo: the lab's panel and views; recording in town and replaying in the lab.

## EF5 gap in the lab (2026-11-26, the user's review)

Seen: in an EF5 mature pass through the lab, the detailed house stayed at DOD 4 while its
neighbors (component model) reached DOD 8–10 at the same wind (167 mph on the rising side).

Traced (8 seeds per case, DOD when the eye arrives):
- Neighborhood, track straight at the house (heading 0°): detailed 4/4/4/4/4/7/8/9, component
  8–9 on every seed. Open field, same track: detailed still 4 on 3 of 8 seeds at 196 mph, so
  the neighborhood isn't the cause.
- By heading (open field, 196 mph, DI 2 expects DOD 9–10): 0° gives 4–7, while 45° and 90° give
  8–10. A straight approach holds the wind square to the ridge the whole way; at a 20° pitch the
  roof's suction there is small (ASCE 7: about −0.3 windward, −0.6 leeward), and a single leeward
  opening (cpi −0.38) cancels it. Rafters reach 2% of capacity at 97 mph. Roof sheathing and a
  whole side wall's sheathing peeling off first (the neighborhood stalls) vent the house the
  same way.
- What should still destroy it is the windward wall: at 196 mph with cpi −0.38 it carries about
  1.2·q ≈ 5.4 kPa, which breaks 2×4 studs at 24 in. in bending (M ≈ 2.3 kN·m against ~2 kN·m
  ultimate). The detailed model fails walls only at their connections, not by stud bending: a
  missing failure mode (DI 2 DOD 7, windward walls blown in).
- Tried and reverted: studs at 16 in. with sheathing from fastener counts (roof 4.9 kPa from 8d
  at 6/12 tests, walls 7.4 kPa): heading 0° improved (7/9/10/4), 90° got slightly weaker, and
  STR-31 broke. Not the fix on its own; 16 in. studs belong with stud bending.

Next: stud bending failure in the detailed walls (Spec 09), with 16 in. studs, then STR-24, STR-31
and this 8-seed check (all headings) again.

Also fixed from the same review: every house starts in pressure balance with the wind (Spec 08
v1.7; a mature start put the EF5's far-field deficit on all houses at once and stripped their
siding in the first second); a mature pass starts calm at every house, neighbors included
(Spec 13 v0.3); full lifecycle is the lab default; picking a wind mode doesn't start it.

### Follow-up (2026-11-26)

- Stud bending (Spec 09 v0.18, STR-36): walls at 16 in., sheathing from test data (roof 4.9 kPa,
  walls 6 kPa). Open-field EF5: DOD 8–10 at every heading.
- Tornado roof pressures ×1.15 (Spec 09 v0.19, STR-37). Neighborhood EF5, heading 0°, 167 mph:
  8/6/6/6/9/7/4/10 (was 4/7/4/4/6/4/9/4). STR-24 (DI 2) passes. Still below DI 2 on some seeds
  (DOD 6 at 167 mph; DOD 6's upper bound is 142).
- Drawn damage marks on component houses tried and removed at the user's request.
- Push-out: back out toward the last nearby clear pose; slabs always up; inside a house means
  under its roof and clear of its walls. LAB-10 and IMP-17 at zero. IMP-19 (town debris) still
  fails as it did before this work.
- Town houses against DI 2 (full EF3/EF4/EF5 town passes, 1,509 houses, each house's own peak roof
  wind vs its final DOD): within about half a DOD of DI 2's expected value in every 10 mph band
  (+0.8 at 110–119 and 170–179 mph, −0.3 to −0.7 above 190 mph). Not too weak.
- The remaining DOD 4 stall (neighborhood, track square to the ridge, seed 7) is a cascade, not a
  bug: rafters start letting go at 117 mph, the unbraced windward and end walls tear off their
  sills, the end wall (in suction) opens the house to cpi ≈ −0.43 (ASCE 7's −0.55 × the face's
  share), and the roof's net uplift drops to ~0.4 q; the rest of the rafters reach 81% at 162 mph.
  Every step checks out against its source; no single physical cause left to fix. Median DOD
  in this setup 6.5 against DI 2's 8–9; DI 2 averages over orientation, this case holds the
  wind square to the ridge from start to eye.

## Simplifications note

Impacts (Spec 10):
- Pieces don't hit each other. Debris that gets inside a house falls to the slab without hitting
  interior walls.
- Hits between town debris and detailed houses, in either direction, take effect up to 0.25 s
  late. That fixed lag keeps runs deterministic across worker counts.
- Component houses: partly stripped siding and partly torn shingles aren't drawn until the
  component fails. Drawn marks were tried and removed at the user's request.
- Roof hits don't push a component house's roof sections down, since its checks are for uplift.
  Hits don't weaken connections they don't break (no fatigue).
- A torn shingle hit on a detailed house removes one shingle patch, about 0.7 m², against the
  component model's 0.5 m².
- A light piece pushed out of a house goes back toward its last clear pose within 0.5 m, and
  slabs always push it up. This is a correction step, not a contact solve.

Structure (Spec 09):
- Gable-end studs (above the end walls' top plates) aren't checked for bending, because their
  span varies along the gable. They still fail at their connections.
- The tornado factor (×1.15) applies to the roof's external pressure only. Walls use the
  straight-line coefficients.
- An accepted stall (BL-004): with the track square to the ridge from start to eye, one seed in
  eight stops at DOD 4 in a neighborhood EF5. This is a real cascade that DI 2 averages out
  over orientation.

Structure lab (Spec 13):
- The neighborhood ring uses the component model only. More detailed houses means more lab
  houses, up to 12 in one physics group, even where town would use two street rows.
- Neighbor density scales the town layout's spacing (0.25× to 1.75×). It doesn't change lot
  occupancy or the house mix.
- Upwind donors are hidden 4 km away. Their pieces enter as real debris.
- A statistical neighbor debris stream was tried and removed. It gave 93 hits where real
  neighbors gave 317.
- Launched real members aren't steered after release and start 4 m out. Reference missiles use
  the arrival solver.
- Replay is exact only for each piece's first hit while it is off the ground, with dispersion
  off. Recorded detailed members replay without spin.
- The wind tunnel is uniform in plan: no swirl, no core passage. Stage 2's tornado replay is
  BL-005.

## Retro

The user's live review of the lab found most of what got fixed. Examples:
- Launched debris didn't damage roofs.
- Rebuilt houses kept their damage, because the detail layer cached the old house.
- A full-strength tornado start stripped every house in the first second.
- Damage marks floated on walls that had already fallen.
- The detailed house stayed far more intact than its neighbors in an EF5.
None of these appeared in tests, so the lab and its probe earned their cost as tools for
looking.

As in Phase 5, the EF5 gap traced to missing physics rather than a strength to tune:
- Stud bending was a failure mode the model didn't have.
- Tornado roof pressure was missing. The literature's 2–3× rise includes the pressure drop at
  the core, which the sim already models, so only about 1.15× was new.
- The strong-house sweep calibration was off: 1.6, corrected to (220/200)² = 1.21.
Recalibrating would have hidden all three.

One measurement misled us. Peak wind froze once a house was swept, so swept houses looked as
if they failed at lower winds than they did. That biased the DOD 10 check. Each house's true
peak fixed it. Lesson: check what an instrument records before trusting it.

A statistical stand-in for neighbors failed its own check (93 hits against 317). Real neighbors
with a density setting cost more but are correct. A stand-in has to be validated against the
real thing before it replaces it.

Zero pass-through took several rounds. The last edge cases were ambiguous definitions: what
"inside a house" means, and which way to push a piece out. These needed exact geometric rules
(under the roof's outer surface, 0.15 m clear of the walls, slabs always up), not tolerances.
IMP-19 still fails on town debris and is logged as BL-001, high.

Process: validation kept turning into open-ended fixing and held up the phase. This led to the
two-stage gate. Preliminary sign-off moves on; validation runs in its own session and records
to `docs/backlog.md`; final sign-off waits on the user's decision on each item. Phase 6 is the
first phase to use it.
