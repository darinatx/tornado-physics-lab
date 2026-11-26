# Spec 16 — Storm Report

Status: Draft (v0.1) — Phase 8. Approved when Phase 8 starts, so
`npm run trace` keeps passing until its tests exist.

## Purpose

When a run is over, the user gets the report a real tornado gets: a **damage survey** in the
form of a National Weather Service (NWS) survey (summary block, narrative, track map with EF
contours, survey points rated by the EF method), followed by an **engineering assessment**
like the studies written after major tornadoes (intensity over time, how the houses failed,
debris, statistics, methods). A **one-page summary** opens the report and prints on its own.

The sim knows what a survey team can't: the true wind everywhere. The report rates the storm
the way a survey would, from damage alone, and shows the true wind beside each rating, so the
user can see where the standard method rates too high or too low.

## Model

### Ending a run

- A **Stop & Report** control in the Run panel. It stops the sim (no more physics steps), keeps
  the frozen scene viewable (camera, inspector and probe still work) and opens the report.
- When the tornado's lifecycle ends (Spec 08), the run stops by itself and the report is
  offered (a button, not a pop-up). Repeat mode (Spec 07) skips the offer.
- **Restart** after a report starts a new run; the report stays open until closed, and can be
  saved first.
- The report can also be built mid-run without stopping (**Preview report**), labeled
  "preliminary", as real surveys issue preliminary findings.

### Storm record (sim)

A recorder in `src/sim/` observes the sim and never changes it (like Spec 12's run record):

- **Track**, every 1 s of sim time: center position, heading, forward speed, V_max, R_max,
  peak ground-relative wind (V_max + forward speed), EF of that peak (Spec 01), lifecycle phase.
- **True wind swath:** a grid of 10 m cells covering everywhere the tornado passed (the track
  ± 3 R_max, grown as it moves), each holding the peak 3-second-mean wind speed at 10 m above
  ground seen there. The 3-second mean is a running mean over physics steps of |U| at the cell
  center, the gust definition the EF scale uses.
- **Per building:** peak 3-second-mean wind at 10 m at its center (as the swath), the existing
  peak at roof height (Spec 03 `peakMph`), closest approach to the core, time of first and last
  failure, DOD over time (each change with its time), and the failure list (Spec 03, and
  Spec 09 connection failures for detailed houses), with impact failures marked (Spec 10).
- **Debris:** pieces launched (by kind and source building), lofted mass, the heaviest piece
  lofted, each piece's landing point and travel from its source, the farthest travel, impacts
  by surface and result (window broken, wall perforated, siding or covering torn).
- **Run metadata:** seed, preset or custom parameters, terrain class, physics step, sim time,
  app version, and the version of every spec in use.

### Survey (EF method)

Built from the record by pure functions in `src/sim/report/`, the way survey teams rate:

- **Survey points:** every building with DOD ≥ 1 is a point: DI (DI 2 for today's houses),
  DOD, construction class, and the Spec 03 survey speed (lower, expected or upper bound by
  construction quality) with its EF. Buildings in the true swath with no damage are "no damage"
  points (shown on the map, not rated).
- **Rating:** the highest EF among the survey points. A tornado that only crosses open ground
  at its peak is rated by what it hit, as in real surveys. The report states the rating and,
  separately, the **true peak** (the swath's maximum and its EF).
- **Path length:** along-track distance from the first to the last survey point with DOD ≥ 1,
  projected on the track. **Maximum width:** the widest cross-track span of DOD ≥ 1 points in
  any 50 m along-track section. Both also given for the true swath (EF0 wind or more).
- **EF contours:** for each EF level, in 50 m along-track sections, the cross-track span of
  survey points rated at or above it, joined into a polygon (the way NWS survey maps outline
  each rating). True-wind contours from the swath are drawn the same way, toggled on the map.
- **Start and end:** time and position of the first and last survey points, given as distance
  and compass direction from the town center (e.g. "1.2 km WSW of the town center").
- **Survey bias:** for each point, the survey speed minus the true 10 m peak; the report gives
  the mean and spread, and lists points outside the DOD's bounds.

### Full report

In order (the summary page first):

1. **Summary** (one page, below).
2. **Event summary block:** rating, estimated peak wind (survey), path length, maximum width,
   start and end time and position, forward speed and heading, duration. Deaths and injuries
   are left out (no people are simulated), with a line saying so.
3. **Narrative:** generated from the record by fixed sentence rules (no randomness): where it
   formed, how it grew, where the worst damage was and what it was, what it did to the
   neighborhood, how it ended.
4. **Track map:** top-down map of the town with the track, EF contours, survey points colored
   by DOD (Spec 06 colors), debris landing points (toggle), the true-wind swath (toggle).
   Click a point for its row in the survey table.
5. **Damage survey table:** one row per survey point: ID, position, DI, DOD and its
   description, construction class, survey speed and EF with the DOD's range, true peak at
   10 m and at roof height, bias, time first damaged. Sortable.
6. **Intensity timeline:** charts of peak wind with EF bands, R_max, forward speed and
   lifecycle phase over time, and damaged buildings over time.
7. **How the houses failed:** for the most damaged houses (every house at the rated EF, up to
   10), the failure sequence in order: time, part, wind, load against capacity, cause (wind,
   pressure, debris impact). Then the failure modes across the town: how often each part was
   the first to fail, and which cascades led to the highest DODs (Spec 03).
8. **Debris:** counts by kind, lofted mass, heaviest piece lofted, farthest travel and its
   piece, a travel-distance histogram, impacts by surface and result, buildings damaged by
   debris alone.
9. **Statistics:** buildings by DOD, by EF, share destroyed (DOD ≥ 8), damaged area.
10. **Methods and limitations:** how the survey was rated, the true-wind definition, the
    model's simplifications (from each spec's Simplifications section), and the run metadata,
    enough to rerun the same storm.

### Summary

One page: the event summary block, a small track map with EF contours, a 3–5 sentence
narrative, and four headline numbers (rating, peak wind, buildings destroyed, path length).
Printing the report puts the summary on page 1; **Print summary** prints it alone.

### Look and labeling

- Laid out like an NWS damage survey statement (summary block first, plain text narrative,
  survey map) with the engineering sections after it. Speeds in mph with m/s alongside,
  distances in miles and km, as in US reports (SI internally; converted at the UI boundary).
- Marked on every page as a **simulated storm report**. No NWS logo, office name or product
  header, so it can't be taken for an official statement if shared.

### Export

- **Print / Save as PDF** through the browser, with a print stylesheet (page breaks between
  sections, maps and charts as vector graphics).
- **Data:** JSON (the record and the survey) and CSV (the survey table).

## Interface

```ts
// src/sim/stormRecord.ts — observes the sim
class StormRecorder {
  constructor(sim: Sim);
  step(): void;                 // after each physics step
  record(): StormRecord;        // a snapshot, safe mid-run
}

// src/sim/report/ — pure
function buildSurvey(record: StormRecord): Survey;
function buildReport(record: StormRecord, survey: Survey, opts: { preliminary: boolean }): Report;
function narrative(record: StormRecord, survey: Survey): string[];

// src/ui/report/ — renders a Report as a page, prints and exports
function showReport(report: Report): void;
```

## Parameters

| Name | Value | Unit | Source |
|---|---|---|---|
| Track sample interval | 1 | s | enough for the timeline; a 10 min run is 600 samples |
| Swath cell size | 10 | m | about a house width, so each house has its own cell |
| Gust averaging window | 3 | s | EF scale wind definition (3-second gust at 10 m) |
| Survey section length | 50 | m | about two lots along the track |
| Houses in failure sequences | 10 | — | keeps the section readable |

## Acceptance criteria

- **REP-01**: Stop & Report stops the sim (no further physics steps), keeps the scene, camera
  and inspector working, and opens the report; the end of the tornado's lifecycle stops the
  run and offers the report.
- **REP-02**: The recorder never changes the sim: the same seed with and without it gives the
  same state at every step.
- **REP-03**: Determinism: the same seed and inputs give an identical report (record, survey
  and narrative text).
- **REP-04**: The true swath's 3-second mean matches an analytic check: a steady Rankine vortex
  passing a cell at a known forward speed gives the running-mean peak computed by hand
  (within 1%).
- **REP-05**: Survey points: every building with DOD ≥ 1 is a point, with the Spec 03 survey
  speed and EF for its DOD and construction class; no other building is rated.
- **REP-06**: The rating is the highest survey-point EF; a scripted track whose peak is over
  open ground is rated below its true peak, and the report shows both.
- **REP-07**: Path length and maximum width match hand-computed values for a scripted set of
  survey points, for both the survey and the true swath.
- **REP-08**: EF contours: every survey point rated EFn lies inside the EFn contour; no
  contour section spans a gap with no point at or above its level.
- **REP-09**: The survey table matches the buildings: DOD, description, survey speed, range,
  true peaks and bias, one row per point.
- **REP-10**: Failure sequences list each chosen house's failures in time order, matching
  Spec 03 and Spec 09 failure records (load > capacity for wind-caused failures, impact
  failures marked with their missile).
- **REP-11**: Debris figures match the record: counts by kind, heaviest lofted, farthest
  travel, impacts by surface and result.
- **REP-12**: The narrative names the rating, peak wind, path length, worst-hit area and the
  end, each matching the survey, and uses no randomness.
- **REP-13**: The summary page holds the summary block, map, narrative and four headline
  numbers, and they match the full report.
- **REP-14**: Exports: the JSON reloads into an identical report; the CSV has one row per
  survey point with the table's columns; print puts the summary on page 1 and every page says
  "simulated storm report".
- **REP-15**: Cost: the recorder adds under 5% to physics step time on an EF4 town pass, and
  the report builds in under 2 s.

## Simplifications / out of scope

- No people: no deaths, injuries, warnings or shelter outcomes.
- No real places: positions are relative to the town center until Phase 13 adds town and street names.
- No radar section until Phase 10 (storm structure) adds radar.
- One damage indicator (DI 2) until Phases 9 and 11 add trees and building types; each adds
  its indicators to the survey.
- The survey has no human judgment beyond the Spec 03 construction-class rule (no surveyor
  disagreement, no missed buildings).
- No saved-run library or replay from the report (Phase 15).

## Decisions

- **True wind at 10 m with a 3-second running mean:** it's the EF scale's own definition, so
  the survey speed and the true wind compare like for like. The roof-height peak is shown too,
  since that's what loaded the house.
- **Rate only from damage, like real surveys:** it reproduces their known low bias over open
  ground, which is the point of the true-wind comparison.
- **Contours from 50 m along-track sections:** simple, deterministic, and close to how survey
  maps outline each rating; no smoothing that would draw a rating where nothing was damaged.
- **Narrative from fixed rules, not a language model:** deterministic and testable (rule 6),
  and every sentence traces to a number in the record.
- **Report builder in `src/sim/report/`, page in `src/ui/report/`:** keeps the dependency rule
  (`ui → render → sim → core`) and makes the whole report testable without a browser.
- **Browser print for PDF:** no PDF library to bundle, and vector maps and charts print sharply.

- **Positions as distance and direction from the town center (user's choice, 2026-11-26):**
  the town has no named streets yet. Phase 13 (city generation) adds a seeded town name and
  street names with the road network, and the report then uses them ("near Oak St and 3rd
  Ave"), as real reports do.

## Open questions

- None.

## Changelog

- v0.1: draft at the user's request (2026-11-26): Stop & Report, storm record, EF-method
  survey with the true-wind comparison, full report and one-page summary, exports.
