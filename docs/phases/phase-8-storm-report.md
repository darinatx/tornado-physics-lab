# Phase 8 — Storm Report

Status: Preliminary sign-off (2026-11-26); validation (slice E) and the final gate to come.
Slices A–D done; demo reviewed by the user.
Built on `phase-8-storm-report`, branched from `main` after Phase 7's preliminary sign-off.
Spec 16 approved (v1.0, now v1.6).

## Goal

Stop a run and get the report a real tornado gets: a damage survey laid out like an NWS one,
rated by the EF method from the damage alone, followed by an engineering assessment of how the
houses failed and where the debris went, with a one-page summary on top. Beside every survey
rating, the true wind the sim recorded there.

## Slices

- **A — Record and survey:** the storm recorder (track, true-wind swath, per-building peaks and
  failures, debris) and the survey (points, rating, path length and width, EF contours, bias).
  No UI yet; checked by tests and a script that prints the survey for a seed. REP-02 to REP-09.
- **B — Report page and summary:** Stop & Report and Preview report, the report page with the
  map, tables, timeline charts, failure sequences, debris and statistics, the narrative, the
  summary page. Demo: an EF4 town pass, stopped and reported. REP-01, REP-10 to REP-13.
- **C — Export and cost:** print stylesheet and Save as PDF, JSON and CSV export, recorder and
  build cost. REP-14, REP-15.
- **D — Profiling:** profile the two benchmark scenes with the recorder on and the report
  build; hotspots with estimated and confirmed gains; cheap wins done, larger ones to the
  backlog (`perf`).
- **E — Validation (own session, after the preliminary gate):** `validate-phase-8` from the
  `phase-8-prelim` tag; survey bias over many seeded passes against published survey-bias
  studies, records to `docs/backlog.md`.

Each of A–C ends with `npm run bench` against the saved baseline, noted below.

## Specs touched

- [16 — Storm report](../specs/16-storm-report.md): new, approved v1.0, now v1.5 (REP-01 to REP-15)
- [07 — Instruments & UI](../specs/07-instruments.md): Stop & Report, Preview, Open report and Open saved report in the Run panel (v1.18)
- [08 — Sim loop](../specs/08-sim-loop.md): a stopped state; the lifecycle end stops the run (v1.9)
- [03 — Damage](../specs/03-damage.md): unchanged (the recorder reads DOD history itself)

## Demo checklist

- [x] EF4 preset through town; Stop & Report mid-path; the scene stays frozen and inspectable
- [x] Summary page: rating, peak wind, path, four numbers, map, narrative
- [x] Track map: contours, survey points, true-wind swath toggle; click a point → its row
- [x] Survey table: a house rated above or below its true wind, and why (its DOD's bounds)
- [x] Failure sequence for the worst house reads in order and matches the inspector
- [x] A run left to the end of the lifecycle offers the report
- [x] Print the summary alone and the full report; open the JSON and CSV

Reviewed by the user 2026-11-26 (all items pass). Changes from the review: the duplicate event
summary page dropped, print opens collapsed sections and fits the survey table, and the map
framed on the damage with contours drawn over the points.

## Slice notes

- **Slice A — record and survey** (2026-11-26). `StormRecorder` (`src/sim/stormRecord.ts`),
  `buildSurvey` and the survey table (`src/sim/report/`), `scripts/storm-survey.ts`. The sim
  loop gained `stop()`/`stopped`, `dt`/`seed`, a `step` observer tap and a `debrisGone` tap
  (the debris field's read-only `onGone`). REP-02 to REP-09 pass.
  - Merged `main` mid-slice (Phase 7 validation and close, BL-021). After BL-021 the report's
    true 10 m wind is on the open-terrain basis like the EF readout (Spec 16 v1.1).
  - The first record kept every impact event: 3.4 million in 50 s, a 498 MB JSON. Impacts are
    now tallied by surface and result, and per house (9 MB for the EF4 pass).
  - Recorder cost (`storm-survey.ts --cost`, the benchmark's 15–35 s window of the EF4 town
    pass): 8.74 → 9.11 ms per step, +4.2% (under REP-15's 5%; measured before the switch to the
    open-terrain basis, which skips the roughness lookup and only makes it cheaper). Record and
    survey build: 22 ms.
  - Seed 1, EF4 pass, 35 s: rated EF4 (200 mph) against a true 10 m peak of 180 mph; survey
    minus true wind −11.7 ± 17.6 mph; 476 of 1,296 points outside their DOD's bounds; 10 m ÷
    roof-height peak 1.13. For the validation slice to examine.
  - Benchmark (`npm run bench`, against the Phase 6 baseline): `ef4-town` 8.93 → 8.46,
    `detail-core` 50.69 → 62.92 ms per step. The flagged sections (debris, other, detail) are
    Phase 7's, already recorded and explained in its slice notes (same end state: 1,296 houses
    damaged); the benchmark runs without the recorder, so slice A adds nothing there.

- **Slice B — report page and summary** (2026-11-26). `buildReport` and the narrative
  (`src/sim/report/report.ts`, `narrative.ts`, `format.ts`, `specDocs.ts`); the page
  (`src/ui/report/`: `html.ts` renders the report as HTML with inline SVG maps and charts,
  `view.ts` the overlay with sorting, map layers, point → row and print, `runControl.ts` Stop &
  Report, Preview and the lifecycle-end stop); Run panel buttons; spec documents and the
  commit bundled at build time for Methods. REP-01, REP-10 to REP-13 pass.
  - Checked in the app (default EF4 wedge, seed 1): Preview mid-run (labeled preliminary, sim
    keeps running), Stop & Report (sim frozen, scene and readout stay, Open report shown, speed
    disabled), map point → its table row, column sorting, Close, Restart (everything cleared).
    No console errors. The lifecycle-end stop is covered by REP-01 in the unit tests; not yet
    watched in the app (a full lifecycle is 370 s).
  - Fixed while checking: the report sat under the control panel; the maps framed the whole
    track (damage was a corner cluster) and now frame the damage; EF band labels overlapped;
    width in yards in the narrative; load/capacity printed with enough digits that a load just
    over its capacity doesn't read as a tie.
  - For the validation slice: impacts on houses run to about 400 per launched piece (973,538
    in 74 s of the EF4 wedge, matching the sim's own counter), almost all on walls with no
    effect. The report labels them as every contact the impact model resolved; whether Spec
    10 counts repeated contacts of resting or sliding pieces is worth a look.
  - Benchmark: `ef4-town` 8.05, `detail-core` 57.91 ms per step (slice A's run: 8.46 and
    62.92), same fingerprints as slice A (`3486b6bd`, `5c536255`): the report changes no
    physics and costs nothing while the sim runs without it. Flags unchanged (Phase 7's,
    against the Phase 6 baseline).
  - `verify:fast` once failed TERR-13 (the timing ratio) with the dev server and browser
    running; it passed alone. That's BL-025, already logged.

- **Slice B follow-ups from the user's demo review** (2026-11-26): the event summary page
  repeated the summary page's block (dropped; sections 1–9, Spec 16 v1.3); printing left
  collapsed sections closed (now all open for print, and Cmd/Ctrl+P prints the report); the
  survey table was clipped after Bias on paper (landscape pages, small type, wrapping cells;
  measured to fit 10 in and 7.5 in of printable width).

- **Slice C — export and cost** (2026-11-26). `src/sim/report/export.ts`: JSON (record and
  survey; 📂 Open saved report reloads it, the survey rebuilt from the record and checked against
  the saved one) and CSV (every table column, one row per point). ⬇ JSON and ⬇ CSV in the
  report's toolbar. REP-14 (unit) and REP-15 (`tests/validation/storm-report-cost.test.ts`,
  with the other timing budgets) pass.
  - REP-15 first failed: the recorder added 12.8% to the EF4 pass's step (9.00 → 10.16 ms).
    Measured by part: wind sampling 0.40 ms per step, debris scan 0.23 ms. Fixes (Spec 16 v1.5):
    the sampling interval follows the missed-peak bound (Δt ≤ 0.01·R_max / v, 0.2 s for the EF4
    wedge instead of 1/30 s): 0.40 → 0.07 ms; the debris scan by arrays, new pieces every step,
    heights and landings every 0.25 s: 0.23 → 0.01 ms. REP-04's 1% still holds. Now 8.61 →
    8.75 ms per step (+1.6%); the report builds in 46 ms (1,296 points).
  - Checked in the app: the toolbar's ⬇ JSON and ⬇ CSV produce the files (42 points, 42 CSV
    rows; metadata with seed, preset, commit and all 19 spec versions); Open saved report is
    in the Run panel. Not watched in the app: reloading a saved file (covered by REP-14).
  - Benchmark: `ef4-town` 8.83, `detail-core` 61.25 ms per step, same fingerprints; within
    the spread of slices A and B's runs (8.05–8.83 and 57.9–62.9), so run-to-run noise. Flags
    unchanged (Phase 7's, against the Phase 6 baseline). `verify:fast`: 251 tests, trace
    complete (REP-01 to REP-15).

- **Slice D — profiling** (2026-11-26). `scripts/profile-report.ts`: the EF4 town pass with the
  recorder on (as the app runs it) over the benchmark window, then the report build, page HTML
  and exports timed; CPU profile with `node --cpu-prof --import tsx scripts/profile-report.ts`.
  Phase 8's own costs (EF4 pass, 1,296 survey points, 15,853 debris records):

  | Part | Cost | Share |
  |---|---|---|
  | Recorder, all (after slice C's fixes) | ~0.11 ms per step | 0.9% of the run's CPU (+1.6% step time, REP-15) |
  | — wind sampling (swath and buildings) | ~0.07 ms per step | 0.56% |
  | — DOD history, debris scan, impact tally, track | ~0.04 ms per step together | 0.3% |
  | `record()` + `buildSurvey` + `buildReport` | 8.6 + 5.0 + 3.9 ms, once | — |
  | Page HTML (`renderReport`), 1.58 MB | 6.9 ms, once | — |
  | JSON (10.0 MB) / CSV | 9.2 / 1.7 ms, once | — |
  | Opening the report in the browser (105 points) | 32–48 ms to paint | about 0.2 s expected at 1,300 points |
  | Scene drawn under an open report | 5.5–7 ms per frame | the whole draw, for a scene nobody sees |

  The rest of the profile is the existing physics (Rapier, impacts, damage, debris), unchanged
  by this phase; the benchmark fingerprints are the same as before slice A.

  | Change | Estimate | Measured | Kept |
  |---|---|---|---|
  | Don't redraw the scene while a report covers it (Preview while the storm runs) | 5–7 ms per frame back for the physics while a report is open; nothing otherwise | 0 draws in 2 s with a report open (3 before and after), physics ran on (480 steps); a draw is 5.5–7 ms | yes |
  | Wind sampling interval from the missed-peak bound; debris scan by arrays (done in slice C for REP-15) | −0.5 ms per step | 0.65 → 0.11 ms per step; +12.8% → +1.6% | yes |

  Considered and left: the DOD-history scan could follow changed houses only (≤ 0.01 ms per
  step); the JSON could round the debris records to millimetres (about half the 10 MB file).
  Neither is worth the code. Nothing for the backlog from this phase's own code.
  - The browser pane was hidden during the in-app checks, so its frames ran at the background
    rate (~1 per second); frame rates there aren't meaningful and aren't reported. Per-call
    timings are: physics 4.75 ms per step with the recorder, 3.97–4.85 without (no measurable
    difference); draw 5.5–7 ms whether or not a report is open.
  - The profile's "set hasAsyncGraph" (7.8% self) is the tsx loader's async hooks, present in
    any `--import tsx` run; not the sim.
  - Benchmark: `ef4-town` 8.16, `detail-core` 57.89 ms per step, same fingerprints, within the
    phase's spread (8.05–8.83, 57.9–62.9). `verify:fast`: 251 tests, trace complete.

## Exit criteria

Preliminary (lets Phase 9 start):

- [x] Spec 16 approved (v1.0, now v1.5); Specs 07 (v1.18) and 08 (v1.9) updated
- [x] Slice A: REP-02 to REP-09 pass
- [x] Slice B: REP-01, REP-10 to REP-13 pass; demo reviewed by the user (2026-11-26)
- [x] Slice C: REP-14, REP-15 pass
- [x] Benchmark run at the end of slices A, B and C; regressions over 10% explained (Phase 7's)
- [x] Slice D, profiling: hotspots with estimated and confirmed gains; before/after recorded
- [x] `npm run verify:fast` passes (251 tests, slice D)
- [x] Specs updated, simplifications note and retro written; README updated
- [x] User's preliminary sign-off (2026-11-26); tag `phase-8-prelim`
- [ ] Pull request from `phase-8-storm-report` into `main`, merged when the user says so; branch
      deleted

Final:

- [ ] Validation (slice E) merged; every Phase 8 backlog item decided; "fix" items merged
- [ ] Final sign-off; tag `phase-8-done` on `main`

## Simplifications note

The storm report (Spec 16) rates and describes the run; it changes no physics. What it leaves
out or approximates:
- **No people:** no deaths, injuries, warnings or shelters (the report says so).
- **No real places:** positions are distances and compass directions from the town center until
  Phase 13 names the town and its streets.
- **One damage indicator** (DI 2, houses) until trees (Phase 9) and other buildings (Phase 11)
  add theirs. No radar section until Phase 10.
- **A mechanical surveyor:** the construction-class rule is the only judgment; every damaged
  house is found and rated.
- **The true wind is sampled:** a peak may be missed by up to 0.5% between samples, and houses
  are sampled at their center.
- **Coarser readings:** the track is sampled once a second; debris landings are read every
  0.25 s.
- **Stepped contours:** drawn in 50 m sections along the track, not smoothed by hand.
- **Impact counts** include every glancing and repeated contact the impact model resolves
  (Spec 10).
- **Desktop and US Letter:** the page and its print layout are built for a desktop browser and
  Letter paper.

## Retro

**The spec improved before any code.** Two choices in the v0.1 draft didn't hold up:
- A second 3-second mean on the true wind would have averaged twice: Spec 01's speeds are
  already gust-equivalent.
- A fixed ±3·R_max swath band would miss EF0 wind beyond it on strong storms.
Both were caught by reading Spec 01 and the ground-track code first. Merging BL-021 mid-slice
moved the true wind to the open-terrain basis the EF readout now uses; otherwise town
roughness would have shown up as survey bias.

**Cost needed measuring twice.** Slice A measured the recorder at +4.2%, under budget. Slice C's
validation test, on the benchmark's own window and best of two, found +12.8%. A breakdown by
part showed where it went: wind sampling 0.40 ms per step, the debris scan 0.23 ms. The fix
came from the physics: a fixed point's wind changes only as the core moves past it, so the
sampling interval follows from the peak it may miss (0.2 s for a wedge instead of 1/30 s).
Now +1.6%. Lesson: a one-off measurement in a script is not a budget check. Put the budget in
a test early.

**A record can grow without bound.** The first version kept every impact: 3.4 million in 50 s,
a 498 MB JSON. The spec asked for counts by surface and result, and tallies are what it needed.
The volume itself (about 400 contacts per launched piece) went into the slice notes for
validation to look at.

**The user's review found what tests can't.** The tests checked that every page had its parts:
- a whole page repeated the summary's block word for word;
- collapsed sections printed collapsed;
- the survey table was cut off on paper;
- the contours were hard to see.
The map was framed on the whole true swath, which squeezed the damage into a corner. The first
fix still left an older framing line in place. Reading the served code in the browser found it.
Printing has no automated check beyond the stylesheet's rules, so print changes have to be
looked at.

**Browser checks need the pane visible.** Frame rates in a hidden pane are throttled to about one
per second and mean nothing; per-call timings are still valid.

**Process:** the README fell behind Phase 7's close. CLAUDE.md now has the README updated at
both gates, and that's done for this phase (below).
