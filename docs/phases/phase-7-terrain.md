# Phase 7 — Terrain from the Town

Status: In progress (build started 2026-11-26)

## Goal

Ground roughness follows what is actually on the ground. Over open fields the near-ground wind
runs fast; crossing into the neighborhood it slows over a few hundred metres as the houses
take hold; where the tornado flattens the houses, the ground gets smoother and the wind
strengthens again. The ground looks like what it is: fields in open country, mowed lawn in
the neighborhood, concrete in urban areas (once they exist). The main sim has no terrain
setting any more; the structure lab can override it.

## Slices

- **A — Roughness field and the wind:** Spec 17's z₀ grid from cover and buildings (Macdonald),
  β(z₀), the 16-direction upwind fetch, updates as houses fail; `windAt` on a field; debris
  tables by z₀; EF readout at the tornado's centre. Checked by tests and a script that prints
  the field across the town edge for a seed. TERR-01 to TERR-09, TERR-13.
- **B — Ground, panels and lab:** ground cover textures (farmland without section roads, lawn,
  pavement) and the blended town edge; terrain dropdown removed; probe and inspector show
  the local terrain; the lab's Terrain setting and its ground; the Ground roughness layer
  and its legend. Demo below. TERR-10 to TERR-12, TERR-14.
- **C — Profiling** (CLAUDE.md rule 9, Phase loop step 4), before the preliminary gate:
  profile the benchmark scenes (`npm run bench`) and the browser frame, since the ground shader,
  cover mask and roughness layer are render work. List the top hotspots, each with an
  estimated gain as a range; confirm each one with the benchmark once it's done. Do the cheap,
  large wins here; put bigger ones in `docs/backlog.md` (category `perf`) for the user, and
  structural work goes to the performance phase. Record before/after numbers below. Known
  candidates: the roughness update (~11 ms every 2 s of sim time while houses fail),
  `windAt` over a field (~1.5× a class near the ground), the layer refresh (6–10 ms).
  **Blocked:** `npm run bench` is Phase 6's slice D and isn't built yet; slices A and B were
  never benchmarked, so they get one run against the new baseline when it exists.
- **D — Validation, in its own session alongside Phase 8** (CLAUDE.md Phase loop step 6):
  `npm run verify`; z₀ against published values for comparable neighborhoods; the
  adjustment length at the town edge against internal-boundary-layer data; damage and EF
  readout for an EF2 and an EF4 preset through town before and after (the town was open
  terrain until now). Findings in `docs/backlog.md`.

## Specs touched

- [17 — Terrain roughness and ground cover](../specs/17-terrain.md): new (TERR-01 to TERR-14)
- [01 — Wind field](../specs/01-wind-field.md): `windAt` on a roughness field (v2.0)
- [04 — Debris](../specs/04-debris.md): per-terrain tables by local z₀
- [05 — City](../specs/05-city.md): ground cover from the layout
- [06 — Rendering](../specs/06-rendering.md): ground by cover, no section roads; roughness layer
- [07 — Instruments](../specs/07-instruments.md): terrain dropdown removed; probe and inspector terrain; Ground roughness checkbox
- [12 — Wind tunnel](../specs/12-wind-tunnel.md): terrain at the target
- [13 — Structure lab](../specs/13-structure-lab.md): Terrain setting; LAB-03 replaced

## Demo checklist

Reviewed by the user 2026-11-26: "demo looks good".

- [x] Main sim: no terrain control in the panel
- [x] Ground: fields outside town, mowed lawn across the neighborhood, no roads or section lines,
      no hard seam at the town edge
- [x] Probe over a field, at the town edge and deep in town: class, z₀ and β change, and β at the
      edge depends on which way the wind blows
- [x] EF3 preset from the fields into town: the probe's 5 m wind drops as it crosses the edge
      over a few hundred metres, not at once
- [x] After the core passes, probe the flattened area: z₀ lower, near-ground wind higher than
      in the standing town beside it
- [x] Lab: Terrain Auto / Open / Suburban / Urban; the ground changes to match (Urban shows
      concrete); the same pass gives less roof wind over Urban than Open; a recorded-wind
      replay locks the setting
- [x] Ground roughness layer: off to start; turned on, fields read smooth, the town rough, the
      edge a gradient a few hundred metres wide that shifts as the tornado and its wind move
      past; the legend shows the classes
- [x] With the layer on, the track behind the core fades toward smooth as houses come down
- [x] In the lab, an override turns the layer uniform; Auto shows the surroundings

## Slice notes

- **A and B built together (2026-11-26).** Spec 17 v1.0; TERR-01 to TERR-14 pass.
  - Default town (seed 1): z₀ 0.18–0.22 m inside (β ≈ 0.20, suburban), farmland 0.03 m. Wind
    from the fields: β 0.115 at the edge, 0.16 at 200 m, 0.19 at 500 m, 0.197 at 750 m; from
    the town side 0.19 at the edge. Flattened 600 m square: z₀ 0.05 m at its centre.
    (`npx tsx scripts/terrain-field.ts`)
  - Cost (TERR-13): build ~60 ms; update ~11 ms median (all houses read by revision, local
    z₀ by summed-area tables, 16 fetch sweeps); `windAt` over the field ~1.5× a class near the
    ground; layer refresh 6–10 ms. A 100 m density window read street crossings as near-open,
    so the window is one block (200 m).
  - The town used to run as open country (the old default), so near-ground winds in town are
    now lower for the same tornado (swirl at 10 m: 0.5^0.20 against 0.5^0.11, about 6% less over the interior).
  - INST-10 found a pre-existing stats gap: far-field pieces skipped on alternate steps, and
    airborne heavy pieces, were left out of the fastest/highest stats. Fixed (Spec 04 v2.6).
  - Phase 6 validation was running in its own worktree (from `cacaedf`) while this slice
    changed `src/core`, `src/sim` and `src/config`; the user chose to let it continue
    (2026-11-26). Its results describe the pre-terrain code: rerun its checks that involve
    near-ground wind or debris in town on this code.
  - Benchmark: none run. `npm run bench` (rule 9) doesn't exist yet; it's Phase 6's slice D.
    Slices A and B get one run when it does (exit criterion above).

## Exit criteria

Preliminary sign-off (lets Phase 8 start; tag `phase-7-prelim`):

- [x] Spec 17 approved (v1.0); Specs 01, 04, 05, 06, 07, 12, 13 updated
- [x] Slice A: TERR-01 to TERR-09, TERR-13 pass
- [x] Slice B: TERR-10 to TERR-12, TERR-14 pass; demo reviewed by the user (2026-11-26)
- [ ] Benchmark run for slices A and B against the baseline once `npm run bench` exists;
      any scene more than 10% slower explained, and fixed or logged
- [ ] Slice C, profiling: hotspots listed with estimated and confirmed gains; cheap wins
      done, the rest in the backlog (`perf`); before/after numbers recorded
- [ ] `npm run verify:fast` passes
- [ ] Specs updated, simplifications note and retro written
- [ ] User's preliminary sign-off; tag `phase-7-prelim`
- [ ] Pull request from `phase-7-terrain` into `main`, merged when the user says so; branch deleted
- [ ] After the merge: remove the temporary `tornado-sim-phase-7` entry from `.claude/launch.json`
      in the main folder (uncommitted there; it serves this worktree on port 5173)

Final sign-off (tag `phase-7-done`):

- [ ] Slice D, validation, in its own session on `validate-phase-7` (from the `phase-7-prelim`
      tag), merged into `main` by pull request; findings in `docs/backlog.md`
- [ ] Every Phase 7 backlog item decided by the user (fix, defer, accept); "fix" items fixed
- [ ] User's final sign-off; tag `phase-7-done` on `main`
