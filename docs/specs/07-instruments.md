# Spec 07 — Instruments & UI

Status: Approved (v1.3) — Phase 1 criteria; later criteria are added in later phases

## Purpose

Let the user control the tornado and inspect the physics: parameter controls, live readouts,
probes, graphs, the damage-swath map and the "explain" panel. Instruments read sim state; they
never change physics, except through the documented parameter controls.

## Model

Phase 1 scope:
- **Presets:** one-click tornadoes from EF0 to EF5, each a realistic archetype (rope, cone,
  wedge) with matching size, forward speed, updraft, cloud base and lifetime. Choosing one
  restarts the run. Editing any slider afterwards switches the label to "Custom".
- **Parameter panel, in plain language:**
  - *Basic* (open): strength, size, forward speed, heading, cloud base height.
  - *Display*: wind arrows, funnel, dust, probe height.
  - *Run*: sim speed, camera follow, repeat, restart.
  - *Advanced physics* (collapsed): every other Spec 01 parameter.

  Every control has a hover tooltip explaining what it does in everyday terms.
- **Inspect probe:** hovering over the ground shows a tooltip with the conditions at that spot,
  at the probe height (default 10 m):
  - wind speed (mph and m/s), EF rating and direction it blows from;
  - its parts: around the tornado, inward/outward, up/down;
  - pressure drop (hPa);
  - wind pressure on a surface, q = ½ρV² (Pa and lb/ft²), which Spec 03 will use for damage;
  - distance from the center, and whether the spot is inside the core and left or right of
    the path.

  Clicking pins a probe (up to 4). Pinned probes stay fixed on the ground and show live
  readings plus a 60-second speed history, so you can watch a tornado pass over a spot.
  Pins can be removed individually or all at once.
- **EF readout:** the current EF rating and the peak ground-relative speed (mph and m/s),
  computed with `efRating` from Spec 01, plus the vortex structure (one-cell, transitioning,
  two-cell) and swirl ratio.
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
function probeAt(p: Vec3, s: TornadoState, terrain: TerrainClass): ProbeReading;   // pure

// src/config/presets.ts
const PRESETS: Preset[];   // { id, name, ef, description, params: Partial<TornadoParams> }

// src/ui/history.ts
class History { constructor(capacity: number, interval: number); push(t: number, v: number): void; }

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
| historySeconds / interval | s | 60 / 0.25 | pinned-probe history |

## Acceptance criteria

- **INST-01**: Every parameter in Spec 01's table that has a range has a control with that
  range and default, and changing it changes the next `windAt` result.
- **INST-02**: The EF readout matches `efRating(peak speed)` for the current state, and
  shows speed in both mph and m/s.
- **INST-03**: The readout's vortex structure label matches the Spec 01 blend: one-cell when
  b < 0.1, two-cell when b > 0.9, transitioning otherwise, and it shows the swirl ratio.
- **INST-04**: `probeAt` agrees with `windAt` (speed and components), `pressureDeficit` and
  q = ½ρV² at the same point, and reports the correct side of the path and core membership.
- **INST-05**: Every preset, run to its mature phase, produces the EF rating it's labeled with.
- **INST-06**: Every preset only sets known parameters, with values inside their control ranges.
- **INST-07**: Probe history records at most one sample per interval, keeps at most
  `capacity` samples (oldest dropped), and clears when time goes backwards (restart).

## Simplifications / out of scope

- No mobile layout in Phase 1.

## Decisions

1. **Controls:** lil-gui for Phase 1 (fast and dependable). A custom panel is revisited in the
   Phase 5 polish pass.

## Changelog

- v1.3: presets, plain-language panel with tooltips, inspect probe with pinning and history
  (INST-04 to INST-07).
- v1.2: vortex structure and swirl ratio in the readout (INST-03).
- v1.1: INST-01 scoped to ranged parameters (β, ε are fixed constants); arrow spacing 40 m;
  extra run controls listed.
- v1.0: Phase 1 criteria approved; lil-gui chosen.
- v0.1: Phase 1 criteria drafted.
