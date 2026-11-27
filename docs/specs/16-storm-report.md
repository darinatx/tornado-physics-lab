# Spec 16 — Storm Report

Status: Approved (v1.7) — Phase 8. Requested by the user 2026-11-26.

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
- When the tornado's lifecycle ends (Spec 08), the run stops by itself 3 s of sim time later
  (the same wait as repeat, so the last debris lands) and the report is offered (an Open
  report button, not a pop-up). Repeat mode (Spec 07) skips the offer.
- **Restart** after a report starts a new run; the report stays open until closed, and can be
  saved first.
- The report can also be built mid-run without stopping (**Preview report**), labeled
  "preliminary", as real surveys issue preliminary findings.

### Storm record (sim)

A recorder in `src/sim/` observes the sim and never changes it (like Spec 12's run record):

- **Track**, every 1 s of sim time: center position, heading, forward speed, V_max, R_max,
  peak ground-relative wind at 10 m (the EF readout's, Spec 01 and INST-02, which includes the
  near-ground overshoot), EF of that peak, lifecycle phase.
- **True wind swath:** a sparse grid of 10 m cells in tiles (like Spec 19's), created only
  where the tornado passed, each holding the peak ground-relative horizontal wind at 10 m
  above ground seen at the cell center, on the EF scale's basis: the open-terrain wind
  (`windAt` with the open class, as the EF readout uses since Spec 17 v1.1, TERR-25).
  The field's speeds are already 3-second-gust equivalent (Spec 01), so the peak is taken
  directly, with no further averaging. Cells are sampled within the **active radius**, as often
  as the peak needs: a fixed point's wind changes only as the core moves past it (the field is
  steady in the storm's frame, apart from the slow lifecycle), so between samples Δt apart it
  misses at most about v·Δt / (2·R_max) of the peak. Δt is the largest whole number of damage
  steps (30 Hz) that keeps that under 0.5%, at most 8 (0.27 s). The **active radius** is where an upper bound on the 10 m wind (tangential profile at that radius
  plus forward speed, with the overshoot and radial factors at their largest) can exceed EF0
  (29 m/s); a cell is skipped when the bound at its distance can't beat the peak it already
  holds. Beyond 1.5·R_max cells are sampled every 4th time, beyond 3·R_max every 8th (their
  wind changes more slowly; staggered so each sample covers a share of them).
- **Per building:** peak wind at 10 m at its center (sampled like the swath, on the same
  open-terrain basis, every damage update while it's within 6·R_max), the existing peak at
  roof height (Spec 03 `peakMph`, the local wind that loaded it),
  closest approach to the core, time of first and last failure, DOD over time (each change
  with its time, read by the recorder after each damage update; Spec 03 is unchanged), and the
  failure list (Spec 03, and Spec 09 connection failures for detailed houses), with impact
  failures marked (Spec 10).
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

1. **Summary** (one page, below), which holds the **event summary block**: rating, estimated
   peak wind (survey), true peak wind, path length, maximum width, start and end time and
   position, forward speed and heading, duration. Deaths and injuries are left out (no people
   are simulated), with a line saying so. The block appears once, as in a survey statement.
2. **Narrative:** generated from the record by fixed sentence rules (no randomness): where it
   formed, how it grew, where the worst damage was and what it was, what it did to the
   neighborhood, how it ended.
3. **Track map:** top-down map of the town with the track, EF contours, survey points colored
   by DOD (Spec 06 colors), debris landing points (toggle), the true-wind swath (toggle).
   Click a point for its row in the survey table.
4. **Damage survey table:** one row per survey point: ID, position, DI, DOD and its
   description, construction class, survey speed and EF with the DOD's range, true peak at
   10 m and at roof height, bias, time first damaged. Sortable.
5. **Intensity timeline:** charts of peak wind with EF bands, R_max, forward speed and
   lifecycle phase over time, and damaged buildings over time.
6. **How the houses failed:** for the most damaged houses (every house at the rated EF, up to
   10), the failure sequence in order: time, part, roof-height wind, load against capacity,
   cause (wind: the net pressure beat the part's capacity; debris impact, with its missile;
   or a roof bay that fell with its bearing wall, which no wind load broke). Then the failure modes across the town: how often each part was
   the first to fail, and which cascades led to the highest DODs (Spec 03).
7. **Debris:** counts by kind, lofted mass, heaviest piece lofted, farthest travel and its
   piece, a travel-distance histogram, impacts by surface and result (tallied in the record,
   not kept one by one: a strong pass resolves millions of contacts), buildings damaged by
   debris alone.
8. **Statistics:** buildings by DOD, by EF, share destroyed (DOD ≥ 8), damaged area.
9. **Methods and limitations:** how the survey was rated, the true-wind definition, the
   model's simplifications (from each spec's Simplifications section), and the run metadata,
   enough to rerun the same storm.

### Summary

One page: the event summary block, a small track map with EF contours, a 3–5 sentence
narrative (the rating, path, worst damage and end sentences of the full narrative), and four
headline numbers (rating, peak wind, buildings destroyed, path length). The maps frame the
damage (the survey points; the swath when nothing was hit, the track when the swath is empty
too), so the contours and points are big enough to read; contour outlines are drawn over the
points with a light casing, and the contours, points, true swath and debris landings each
have a checkbox. Path widths are given in
yards with metres, as surveys give them.
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
- **Data:** JSON (the record and the survey) and CSV (the survey table: a header row of the
  column names, then one row per survey point with every column). **📂 Open saved report** in
  the Run panel reloads a JSON into the same report; the survey is rebuilt from the record and
  must match the saved one, so a changed file is refused.
- **Print layout:** each section starts a new page; collapsed sections open for printing; the
  survey table prints on landscape pages in small type so every column fits; the browser's own
  print (Cmd/Ctrl+P) prints the whole report.

## Interface

```ts
// src/sim/stormRecord.ts — observes the sim through its taps (Spec 08: step, impact,
// detailFailure, debrisStep, debrisGone) and snapshot
class StormRecorder {
  constructor(sim: Sim, opts?: { appVersion?: string; specs?: Record<string, string>; townCenter?: { x: number; z: number } });
  record(): StormRecord;        // a snapshot, safe mid-run; plain data (JSON round-trips it)
  dispose(): void;              // stop observing
}

// src/sim/report/ — pure
function buildSurvey(record: StormRecord): Survey;
function surveyRows(survey: Survey, center?: { x: number; z: number }): SurveyRow[];
function buildReport(record: StormRecord, survey: Survey, opts: { preliminary: boolean; specs?: SpecDoc[] }): Report;
function narrative(record: StormRecord, survey: Survey): string[];
function summaryNarrative(record: StormRecord, survey: Survey): string[];
function reportJson(record: StormRecord, survey: Survey, preliminary: boolean): string;
function reportFromJson(text: string, specs?: SpecDoc[]): Report;   // throws on a changed file
function surveyCsv(survey: Survey, center?: { x: number; z: number }): string;
function parseSpecDoc(file: string, markdown: string): SpecDoc;     // Methods: versions, simplifications

// src/ui/report/ — the page, the Run panel's control, print and downloads
function renderReport(report: Report): string;                      // HTML with inline SVG
function showReport(report: Report, opts?: { onClose?: () => void }): { readonly open: boolean; close(): void };
function createReportControl(sim: Sim, o: { autoRepeat: () => boolean; specs?: SpecDoc[] }): ReportControl;
//   stopAndReport(), preview(), current(), tick() (stops the run when the lifecycle ends), reset()
```

## Parameters

| Name | Value | Unit | Source |
|---|---|---|---|
| Track sample interval | 1 | s | enough for the timeline; a 10 min run is 600 samples |
| Swath cell size | 10 | m | about a house width, so each house has its own cell |
| Swath and building sample interval | 1–8 | damage steps (1/30 s) | Δt ≤ 0.01·R_max / v: under 0.5% of a peak missed (a 300 m wedge at 15 m/s: 0.2 s; a 40 m rope at 8 m/s: 1/30 s) |
| Full debris scan | 0.25 | s | heights and landings; new pieces are caught every debris step |
| Swath threshold | 29 | m/s | EF0 lower bound (65 mph) |
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
- **REP-04**: The true swath matches an analytic check: a steady vortex passing cells at known
  offsets and forward speed gives, in each cell, the peak of its ground-relative 10 m wind
  computed by hand from the profile (within 1%), and no cell outside the active radius ever
  held EF0 wind.
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
- The track is sampled once a second; the timeline charts show those samples.
- The true wind is sampled, not integrated: a peak can be missed by up to 0.5% between samples
  (the sampling bound), and houses are sampled at their center only.
- Debris landings are read every 0.25 s, so a landing time is known to within that; a piece
  that lands and lifts again between reads keeps its earlier landing.
- Contours are drawn section by section (stepped edges), not smoothed as a surveyor would draw
  them by hand.
- Impact counts are every contact the impact model resolves, including glancing and repeated
  ones (Spec 10), so they run far above the number of pieces.
- The report page is built for a desktop browser and US Letter paper.

## Decisions

- **True wind is the field's 10 m peak, not a further 3-second mean:** the EF scale rates the
  3-second gust at 10 m, and Spec 01's speeds are already 3-second-gust equivalent, so a second
  running mean would average twice and bias the true wind low. The roof-height peak is shown
  too, since that's what loaded the house.
- **Bias is measured against the 10 m wind, on the same basis as the calibration (v1.7):**
  since Spec 03 v2.5 the capacities are calibrated so each DOD's expected speed matches the
  median 10 m open-terrain peak at town houses, the basis the survey assigns, so the bias
  measures the EF method itself, not the height or the town's roughness. The Methods section
  says so and still gives the mean 10 m ÷ roof-height ratio over the survey points, as the
  difference between the wind that rates a house and the local wind that loaded it. (v1.0–v1.6:
  the calibration was at roof height and the ratio explained part of the bias, BL-029.)
- **True 10 m wind on the open-terrain basis (v1.1, after BL-021):** the DOD speeds the survey
  assigns are open-terrain 10 m gusts, and the EF readout reports that basis (Spec 17 v1.1), so
  the true wind beside each rating is on it too; otherwise town roughness would show up as a
  survey bias. The roof-height peak stays the local wind, since that's what loaded the house.
- **Swath sampled within an active radius, as often as the peak needs (v1.5):** the interval
  follows from the missed-peak bound (v·Δt / 2·R_max ≤ 0.5%), which keeps REP-04's 1%;
  sampling every damage step regardless cost 0.40 ms per step on the EF4 pass (12.8% with the
  debris scan, over REP-15's 5%). Skipping rings that can't raise any peak is Spec 19's trick
  and changes no result.
- **Spec versions in the metadata read from `docs/specs` at build time:** they can't drift
  from the documents.
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

- v1.7 (BL-029): Methods and the bias decision follow Spec 03 v2.5's calibration on the 10 m
  open basis; the 10 m ÷ roof ratio is now context, not a correction to the bias.

- v1.6 (2026-11-26, the user's demo review): the maps frame the survey points (not the whole
  swath, which squeezed the damage into a corner); contour outlines over the points with a
  light casing, smaller points, checkboxes for contours and points.
- v1.5 (2026-11-26, slice C, REP-15): the wind sampling interval follows the missed-peak bound
  instead of every damage step; debris heights and landings read every 0.25 s (new pieces every
  debris step). The recorder went from 12.8% to about 1% of the EF4 pass's physics step.
- v1.4 (2026-11-26, slice C): Open saved report; the CSV's layout; the print layout (from
  the user's review: collapsed sections and the clipped survey table).
- v1.3 (2026-11-26, the user's demo review): the event summary block is on the summary page
  only; its separate page repeated it word for word. Sections renumbered 1–9.
- v1.2 (2026-11-26, slice B): the run stops 3 s after the lifecycle ends (the repeat wait, so
  debris lands); failure causes are wind, debris impact or a bay falling with its wall (the
  model has no separate "pressure" failure: wind failures are net pressure); impacts tallied;
  summary narrative sentences and map framing stated; widths in yards.
- v1.1 (2026-11-26, slice A, after merging BL-021 from `main`): the track peak, swath and
  building 10 m peaks are on the open-terrain basis, like the EF readout (Spec 17 v1.1).
- v1.0 (2026-11-26, Phase 8 start): approved. The true wind is the field's 10 m peak with no
  second 3-second mean (Spec 01 speeds are already gust equivalent); the swath is a sparse
  tiled grid sampled at 30 Hz within an EF0 active radius instead of a fixed ± 3·R_max band
  (which misses EF0 wind beyond it on strong tornadoes); DOD history is read by the recorder,
  so Spec 03 doesn't change; bias explained against the roof-height calibration. REP-04
  rewritten to match.
- v0.1: draft at the user's request (2026-11-26): Stop & Report, storm record, EF-method
  survey with the true-wind comparison, full report and one-page summary, exports.
