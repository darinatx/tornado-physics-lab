# Spec 00 — Overview

Status: Draft (v0.1)

## Vision

A browser-based simulator where a tornado moves through a procedurally generated city and
destroys it according to wind-engineering physics. The goal is **scientifically grounded and
explainable**, not CFD-accurate: every damage outcome can be traced to a physical quantity
(wind speed, dynamic pressure, component capacity) that the user can inspect.

## Goals

- A parametric tornado wind field covering EF0–EF5, with a realistic structure: a core,
  inflow, an updraft, translation asymmetry, and an optional multi-vortex mode.
- Damage based on component capacities and fragility curves taken from the Enhanced Fujita
  scale's Damage Indicators (DIs) and Degrees of Damage (DODs).
- Failure cascades (for example, window breach → internal pressurization → roof uplift).
- Debris driven by drag and lift that can cause secondary impact damage.
- Instruments: probe any point or building, see a damage-swath map, and read the equations used.
- 60 fps on a mid-range laptop.

## Non-goals

- Full computational fluid dynamics, or two-way coupling between buildings and the flow.
- Forecasting or prediction of real storms.
- Photorealism at the expense of frame rate.

## Subsystems

| Spec | Subsystem | Layer |
|---|---|---|
| 01 | Wind field | core |
| 02 | Structural loads | core |
| 03 | Damage model | core |
| 04 | Debris | core + sim |
| 05 | City generation | sim |
| 06 | Rendering | render |
| 07 | Instruments & UI | ui |
| 08 | Simulation loop | sim |
| 09 | Structural physics (detail zone) | core + sim |
| 10 | Debris impacts | core |

## Conventions

- **Coordinates:** right-handed, Y-up. Ground plane is y = 0. Distances in meters.
- **Units:** SI internally. mph appears only in the EF-scale mapping and UI labels.
- **Time:** seconds. Physics runs on a fixed step (default 1/120 s).
- **Rotation:** cyclonic (counter-clockwise viewed from above), the Northern Hemisphere norm.
  An anticyclonic toggle may be added later.
- **Acceptance criterion IDs:** `PREFIX-NN`, unique across all specs. Prefixes: WIND, LOAD,
  DMG, DEB, CITY, REND, INST, SIM, STR, IMP.

## Spec template

Every spec has these sections: Status, Purpose, Model, Interface, Parameters, Acceptance
criteria, Simplifications / out of scope, Open questions, Changelog.

## Glossary

- **R_max**: radius of maximum tangential wind.
- **V_max**: peak tangential wind speed (ground-relative peak also includes translation).
- **q**: dynamic pressure, ½ρV² (Pa).
- **C_p**: pressure coefficient for a surface.
- **DI / DOD**: EF-scale Damage Indicator (structure type) / Degree of Damage (damage stage).
- **Fragility curve**: probability that a component fails as a function of wind speed (lognormal).

## Changelog

- v0.1: initial draft.
