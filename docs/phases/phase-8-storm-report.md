# Phase 8 — Storm Report

Status: In progress (started 2026-11-26 on `phase-8-storm-report`, from `main` after Phase 7's
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

- [16 — Storm report](../specs/16-storm-report.md): new, approved v1.0 (REP-01 to REP-15)
- [07 — Instruments & UI](../specs/07-instruments.md): Stop & Report, Preview and Open report in the Run panel (v1.17)
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

## Exit criteria

Preliminary (lets Phase 9 start):

- [x] Spec 16 approved (v1.0); Specs 07 (v1.17) and 08 (v1.9) updated
- [x] Slice A: REP-02 to REP-09 pass
- [ ] Slice B: REP-01, REP-10 to REP-13 pass; demo reviewed by the user
- [ ] Slice C: REP-14, REP-15 pass
- [ ] Benchmark run at the end of slices A, B and C; regressions over 10% explained
- [ ] Slice D, profiling: hotspots with estimated and confirmed gains; before/after recorded
- [ ] `npm run verify:fast` passes
- [ ] Specs updated, simplifications note and retro written
- [ ] User's preliminary sign-off; tag `phase-8-prelim`; pull request into `main`, merged when
      the user says so; branch deleted

Final:

- [ ] Validation (slice E) merged; every Phase 8 backlog item decided; "fix" items merged
- [ ] Final sign-off; tag `phase-8-done` on `main`
