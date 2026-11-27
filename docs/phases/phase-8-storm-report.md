# Phase 8 — Storm Report

Status: In progress, slices A–C built; slice D (profiling) next (started 2026-11-26 on `phase-8-storm-report`, from `main` after Phase 7's
preliminary sign-off). Spec 16 approved (v1.0).

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

- [ ] EF4 preset through town; Stop & Report mid-path; the scene stays frozen and inspectable
- [ ] Summary page: rating, peak wind, path, four numbers, map, narrative
- [ ] Track map: contours, survey points, true-wind swath toggle; click a point → its row
- [ ] Survey table: a house rated above or below its true wind, and why (its DOD's bounds)
- [ ] Failure sequence for the worst house reads in order and matches the inspector
- [ ] A run left to the end of the lifecycle offers the report
- [ ] Print the summary alone and the full report; open the JSON and CSV

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

## Exit criteria

Preliminary (lets Phase 9 start):

- [x] Spec 16 approved (v1.0, now v1.5); Specs 07 (v1.18) and 08 (v1.9) updated
- [x] Slice A: REP-02 to REP-09 pass
- [ ] Slice B: REP-01, REP-10 to REP-13 pass; demo reviewed by the user
- [x] Slice C: REP-14, REP-15 pass
- [x] Benchmark run at the end of slices A, B and C; regressions over 10% explained (Phase 7's)
- [ ] Slice D, profiling: hotspots with estimated and confirmed gains; before/after recorded
- [ ] `npm run verify:fast` passes
- [ ] Specs updated, simplifications note and retro written
- [ ] User's preliminary sign-off; tag `phase-8-prelim`; pull request into `main`, merged when
      the user says so; branch deleted

Final:

- [ ] Validation (slice E) merged; every Phase 8 backlog item decided; "fix" items merged
- [ ] Final sign-off; tag `phase-8-done` on `main`
