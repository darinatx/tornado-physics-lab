# Phase 7 — Storm Report

Status: Spec review (drafted 2026-11-26). Starts after the Phase 6 gate.

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

## Specs touched

- [16 — Storm report](../specs/16-storm-report.md): new (REP-01 to REP-15)
- [07 — Instruments & UI](../specs/07-instruments.md): Stop & Report in the Run panel
- [08 — Sim loop](../specs/08-sim-loop.md): a stopped state; the lifecycle end stops the run
- [03 — Damage](../specs/03-damage.md): DOD history per building

## Demo checklist

- [ ] EF4 preset through town; Stop & Report mid-path; the scene stays frozen and inspectable
- [ ] Summary page: rating, peak wind, path, four numbers, map, narrative
- [ ] Track map: contours, survey points, true-wind swath toggle; click a point → its row
- [ ] Survey table: a house rated above or below its true wind, and why (its DOD's bounds)
- [ ] Failure sequence for the worst house reads in order and matches the inspector
- [ ] A run left to the end of the lifecycle offers the report
- [ ] Print the summary alone and the full report; open the JSON and CSV

## Exit criteria (whole phase)

- [ ] Spec 16 approved
- [ ] Slice A: REP-02 to REP-09 pass
- [ ] Slice B: REP-01, REP-10 to REP-13 pass; demo reviewed by the user
- [ ] Slice C: REP-14, REP-15 pass
- [ ] All tests pass; `npm run verify` passes
- [ ] Specs updated, simplifications note and retro written
- [ ] User sign-off; commit tagged `phase-7-done`
