# Spec 07 — Instruments & UI

Status: Approved (v1.18) — Phases 1–4

## Purpose

Let the user control the tornado and inspect the physics: parameter controls, live readouts,
probes, graphs, the damage-swath map and the "explain" panel. Instruments read sim state; they
never change physics, except through the documented parameter controls.

## Model

Phase 1 scope:
- **Spawning:** the app opens with the tornado not yet spawned: the sim holds at time 0 (the
  lifecycle's zero strength, so no funnel and no wind) and the town waits in calm air. A
  **🌪 Spawn tornado** button at the top of the panel starts it at the chosen sim speed (the
  hint line says to press it). Restart and choosing a preset return to waiting. Repeat-on-
  dissipation keeps going without a new press.
- **Presets:** one-click tornadoes from EF0 to EF5, each a realistic archetype (rope, cone,
  wedge) with matching size, forward speed, updraft, cloud base and lifetime. Choosing one
  restarts the run. Editing any slider afterwards switches the label to "Custom".
- **Parameter panel, in plain language:**
  - *Basic* (open): strength, size, forward speed, heading, cloud base height.
  - *Display*: wind arrows, funnel, dust, ground roughness (Spec 17), probe height.
  - *Run*: sim speed, camera follow, repeat (off by default), restart, **Stop & Report**,
    **Preview report** and **Open saved report** (a report saved as JSON) (Spec 16). After Stop & Report, or when the lifecycle ends the run, the
    sim-speed control is disabled and an **Open report** button stays in the panel until
    Restart.
  - Damage colors are off by default.
  - *Advanced physics* (collapsed): every other Spec 01 parameter. There is no terrain
    setting: the ground roughness comes from the town (Spec 17).

  Every control has a hover tooltip explaining what it does in everyday terms.
- **Inspect probe:** hovering over the ground shows a tooltip with the conditions at that spot,
  at the probe height (default 10 m):
  - wind speed (mph and m/s), EF rating and direction it blows from;
  - its parts: around the tornado, inward/outward, up/down;
  - air pressure (mb) and its drop below the background (see Decisions 2);
  - wind pressure on a surface, q = ½ρV² (Pa and lb/ft²), which Spec 03 will use for damage;
  - the ground (Spec 17): terrain class, roughness length z₀ upwind-weighted and at the spot,
    and the power-law exponent β the wind feels there;
  - distance from the center, and whether the spot is inside the core and left or right of
    the path.

  Hovering over a house switches the tooltip to a short **building summary**: current DOD
  with its description, the survey estimate (EF with the assigned speed, the DOD's range and
  the reason), construction class, peak and current wind at the roof, and its distance from
  the tornado's core edge (the radius of maximum wind, R_max): now, and the closest it came
  (Spec 03), or "inside the core". Once the tornado has dissipated there is no core, so the
  live distance gives way to "dissipated" and only the closest approach stays.

  Clicking pins a probe (up to 4). Pinned probes stay fixed on the ground and show live
  readings plus a history graph covering the whole run, from the start to dissipation (the
  time axis is the tornado's lifetime; lines grow left to right from when the pin was placed),
  so you can watch a tornado pass over a spot. The
  graph overlays wind speed (solid line in the pin's color, mph scale on the left) and the
  air pressure (thinner dashed line with a light fill hanging from the background pressure at
  the top, mb scale on the right, falling like a barometer), with labelled scales and a legend. A pinned
  house is the full **building inspector**: the summary, then the graph, then each part type
  that failed, in order of first failure: how many of how many (e.g. "Roof covering: 6 of 16
  sections"), with the first failure's wind speed, load and capacity, so every failure is
  explainable. Roof bays that came down because a bearing wall under them fell show that
  instead of a load ("3 fell with a bearing wall"): no wind load broke them. A house in the
  structural detail zone (Spec 09) also lists its connection failures there, by connection
  type (e.g. "Rafter to wall: 12 of 30 connections", loads in kN), in the same order, after
  whatever its components lost before it entered; its peak wind keeps updating.
  Pins can be removed individually or all at once.
- **Layout:** panels never cover each other at any window size. The EF readout and the pinned
  probes share the left column (the pins below the readout, scrolling in the space left); the
  camera-key hint and the detail-zone status share the bottom-center column (the status above
  the hint).
- **Slow-motion status:** while houses are in structural detail, a line says how many. Whenever
  the sim runs slower than its speed setting, whatever the cause (detail or heavy-debris
  physics holding it back, Spec 09 and Spec 04, or frames too slow to keep up, SIM-02), the
  line shows, with or without detail houses, and gives the measured sim rate: "slow motion ·
  0.42× real time", sim seconds advanced per real second over the last second of frames (two
  significant figures). It counts as slow once at least 0.5 s has been measured and the rate is
  below 95% of the speed setting. Frames longer than 1 s (a tab coming back from hidden) are
  left out, and a restart clears the measurement.
- **EF readout:** the current EF rating and the peak ground-relative speed (mph and m/s),
  computed with `efRating` from Spec 01, plus the vortex structure (one-cell, transitioning,
  two-cell) and swirl ratio, plus a neighborhood tally: houses damaged (DOD ≥ 1) and destroyed
  (DOD ≥ 7), and debris stats: pieces airborne and on the ground, the fastest piece's speed
  and the highest piece's height.
- **Wind visualization:** a grid of arrows over the ground plane at a chosen height (default
  10 m), colored by speed band (one color per EF level, gray below EF0).

Later phases add the probe tool, radial-profile graph, failure-count graph, damage-swath map
and explain panel.

## Interface

```ts
// src/ui/controls.ts: pure control definitions derived from config
function buildControlDefs(): ControlDef[];

// src/ui/params.ts: lil-gui panel; changes go through sim.setParams
function createPanel(sim: Sim, onFollowChange: (follow: boolean) => void): Panel;

// src/core/wind/probe.ts
function probeAt(p: Vec3, s: TornadoState, terrain: Terrain): ProbeReading;   // pure; Terrain: Spec 17

// src/config/presets.ts
const PRESETS: Preset[];   // { id, name, ef, description, params: Partial<TornadoParams> }

// src/ui/history.ts
class History { constructor(capacity: number, interval: number); push(t: number, v: number, v2?: number): void; }

// src/ui/readout.ts
function computeReadout(snap: SimSnapshot): Readout;   // pure
function mountReadout(host: HTMLElement): { update(r: Readout): void };
```

## Parameters

| Name | Unit | Default | Note |
|---|---|---|---|
| arrowGridSpacing | m | 40 | wind-visualization density |
| arrowHeight | m | 10 | sampling height |
| probeHeight | m | 10 | range 2–200 |
| maxPins | – | 4 | |
| history span / interval | s | run lifetime (up to 3,600) / 0.25 | pinned-probe history (wind speed and air pressure) |
| sim-rate window / max frame / min measured | s | 1 / 1 / 0.5 | measured sim rate in the slow-motion status; slow below 95% of the speed setting |
| background pressure | Pa | 101,325 | standard sea-level pressure; shown in mb (1 mb = 100 Pa) |

## Acceptance criteria

- **INST-01**: Every parameter in Spec 01's table that has a range has a control with that
  range and default, and changing it changes the next `windAt` result.
- **INST-02**: The EF readout matches `efRating(peak speed)` for the current state, and
  shows speed in both mph and m/s.
- **INST-12**: For a detailed house, the report lists every connection failure from the detail
  engine, grouped by connection type with correct counts and totals, and its peak wind is at
  least the wind at each of those failures.
- **INST-11**: The readout and probe flag any wind above 135 m/s (≈302 mph, the strongest ever
  measured) as hypothetical, and only then.
- **INST-10**: Debris stats match the debris pool: airborne and resting counts, maximum
  speed and maximum height over live pieces.
- **INST-08**: The building report matches the building: DOD and description, EF estimate and
  range from Spec 03, peak wind, and failure groups in order of first failure, with correct
  counts, the first wind-caused failure's load > capacity, and the count of roof bays that fell
  with a bearing wall.
- **INST-09**: The neighborhood tally equals the count of houses at DOD ≥ 1 and DOD ≥ 7.
- **INST-03**: The readout's vortex structure label matches the Spec 01 blend: one-cell when
  b < 0.1, two-cell when b > 0.9, transitioning otherwise, and it shows the swirl ratio.
- **INST-04**: `probeAt` agrees with `windAt` (speed and components), `pressureDeficit` and
  q = ½ρV² at the same point, and reports the correct side of the path and core membership.
- **INST-05**: Every preset, run to its mature phase, produces the EF rating it's labeled with.
- **INST-06**: Every preset only sets known parameters, with values inside their control ranges.
- **INST-07**: Probe history records at most one sample per interval, keeps at most
  `capacity` samples (oldest dropped), and clears when time goes backwards (restart); a second
  value (pressure drop) is kept in step with the first.
- **INST-13**: The building summary shows the distance from the core edge now
  (distance to the axis − R_max) and the closest approach from Spec 03, both in m, or "inside
  the core" when ≤ 0; after dissipation it shows "dissipated" in place of the live distance
  and keeps the closest; it has no failure list, and the pinned inspector has the summary, then
  the graph, then the failure list.
- **INST-14**: The panel starts with damage colors, repeat-on-dissipation and follow off.
- **INST-15**: Air pressure is shown in millibars as the background pressure (1013.25 mb)
  minus the pressure drop: `airPressureMb(Δp) = (101,325 Pa − Δp) / 100`.
- **INST-16**: The sim rate is sim time advanced ÷ real time over the last 1 s of frames,
  ignoring frames longer than 1 s and clearing when sim time goes backwards; the sim counts as
  slow once ≥ 0.5 s is measured and the rate is below 95% of the speed setting (never when
  paused); the slow-motion status shows whenever it's slow, with or without detail houses, as
  "N× real time" to two significant figures.
- **INST-17**: The tornado waits to be spawned: at start, and after Restart or a new preset,
  the sim doesn't advance (time stays 0, no wind); Spawn starts it at the chosen speed, and a
  speed chosen while waiting applies on spawn.

## Simplifications / out of scope

- No mobile layout in Phase 1.

## Decisions

1. **Controls:** lil-gui for Phase 1 (fast and dependable). A custom panel is revisited in the
   Phase 5 polish pass.
2. **Distance to the core edge (R_max); actual air pressure on the graph (v1.10):** R_max is
   the standard, well-defined edge of a tornado's core (peak winds); a damaging-wind edge moves
   with gusts and height. The graph shows air pressure, not wind pressure on a surface (½ρV²,
   which would only repeat the wind line): pressure falls toward the axis, so the two lines
   show the core's structure (wind peaks at the edge, pressure bottoms out at the center). The
   sim models only the drop below the surroundings (Spec 01), so actual pressure assumes the
   standard sea-level 1013.25 mb (the town is flat at sea level; real storm environments run
   a few mb either side, which shifts the line but not its shape). Millibars at the user's
   request (the unit used in US storm reports; equal to hPa). Lines, not bars: both are
   continuous samples at 4 Hz.

3. **Measured sim rate, not the speed setting (v1.11):** the slow-motion line reports what the
   sim actually achieved (sim s per real s), since the point is how far it has fallen behind
   real time; a 1 s window steadies it without hiding changes. It's relative to real time, so a
   2× speed setting that only reaches 0.8× shows 0.8×.

## Changelog

- v1.18 (Phase 8 slice C): Open saved report in the Run panel.
- v1.17 (Phase 8): Stop & Report, Preview report and Open report in the Run panel (Spec 16).
- v1.16 (Phase 7): the terrain dropdown is gone (the town sets the roughness); the probe shows
  the ground's class, z₀ and β; a Ground roughness display toggle (Spec 17, TERR-10, TERR-14).
- v1.15: at the user's request, the tornado waits to be spawned (Spawn tornado button;
  Restart and presets wait again) (INST-17).
- v1.14: follow starts off (INST-14), at the user's request (Spec 06 v1.13).
- v1.13: after dissipation the building summary stops showing a live distance to the core
  edge (it kept climbing as the dissipated state drifted on with the storm) and shows
  "dissipated · closest N m" (INST-13).
- v1.12: the slow-motion line shows whenever the measured rate falls behind the speed setting,
  not only when detail houses lag: it was hidden without a detail spot, and frames over 0.25 s
  (where the sim drops time) were left out of the rate, hiding that slowdown too (INST-16).
- v1.11: at the user's request: the slow-motion status shows the measured sim rate (INST-16).

- v1.10: at the user's request: the hover summary drops the failure list (it stays in the
  pinned inspector) and gains distance from the core edge, now and closest (INST-13); the pin
  graph overlays pressure drop on wind speed, above the failure list; damage colors and repeat
  start off (INST-14); panels stack in columns so pins can't cover the readout and the key
  hint can't run into the detail status. The pin graph spans the whole run, start to
  dissipation, not the last 60 s. Air pressure is shown in mb from a standard background
  (INST-15).

- v1.9: roof bays that fell with a bearing wall are shown as such, not as "1 Pa > 0 Pa"
  (INST-08 updated).
- v1.8: the inspector shows a detailed house's connection failures and keeps its peak wind
  current (INST-12); before, both froze when the house entered the detail zone.
- v1.7: inspector groups component failures by part type (INST-08 updated).
- v1.6: hypothetical-wind flag and a ~400 mph what-if preset (INST-11).
- v1.5: debris stats in the readout (INST-10).
- v1.4: building inspector and neighborhood tally (INST-08, INST-09).
- v1.3: presets, plain-language panel with tooltips, inspect probe with pinning and history
  (INST-04 to INST-07).
- v1.2: vortex structure and swirl ratio in the readout (INST-03).
- v1.1: INST-01 scoped to ranged parameters (β, ε are fixed constants); arrow spacing 40 m;
  extra run controls listed.
- v1.0: Phase 1 criteria approved; lil-gui chosen.
- v0.1: Phase 1 criteria drafted.
