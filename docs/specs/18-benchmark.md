# Spec 18 — Benchmark

Status: Approved (v1.0) — Phase 6 slice D (CLAUDE.md rule 9). Scenes fixed by the user: two
only, an EF4 town pass and the 30-house detail-zone core passage; adding one needs the user's OK.

## Purpose

Measure how fast the physics runs, the same way every time, so each slice can see what it cost
and the profiling pass can confirm its gains. `npm run bench` runs two seeded scenes and reports
ms per physics step, in total and by subsystem, against a saved baseline.

## Model

### Scenes

Each scene is a fixed sim setup: seed, tornado parameters, start point and window. The tornado
is mature from the start (no spin-up) and placed so its core reaches the scene's focus point,
the town centre (0, 0), at `arriveS` = 25 s. The sim runs a warm-up of 15 s (debris builds up
as the core approaches, as in a real pass), then the **measured window** of 20 s, which
centres the core passage (t = 15 to 35 s).

| ID | What | Seed | Tornado | Engines |
|---|---|---|---|---|
| `ef4-town` | EF4 town pass | 1 | EF4 preset (`ef4-wedge`), mature from t = 0 | component model, heavy debris in-process |
| `detail-core` | 30-house detail-zone core passage | 1 | default tornado, mature from t = 0 | as `ef4-town`, plus the detail zone at (0, 0) in-process with one engine (the STR-30 case) |

All engines run in-process on one thread, so every millisecond is counted once, in the section
that spends it, and runs don't depend on worker scheduling. (The app runs the detail zone and
heavy debris in workers; the bench measures the work itself.)

### What it measures

A read-only timing hook in the sim loop (`SimConfig.timing`) adds wall-clock time per section
of each physics step:

- **damage**: component-house damage, including the debris it spawns;
- **debris**: the light-debris step;
- **heavy**: the heavy-debris engine (rigid bodies);
- **detail**: the detail zone (sending a step, running it, applying its results);
- **total**: the whole step and the detail results applied after it; **other** = total minus
  the four sections (the loop, snapshots, stand-ins, town hits).

The report gives, per scene, ms per physics step for each (mean over the window), the steps
measured, and context counts at the end: flying and resting debris, heavy bodies, damaged
houses, detailed houses. A **fingerprint** of the final state (damage histogram, debris stats,
every house's DOD, detail poses) shows whether the physics is the same as another run's.

### Runs and noise

Each scene runs `--runs` times (default 2) and each figure is the minimum over the runs. The
minimum is the standard robust estimate for timing: noise only ever adds time.

### Baseline and comparison

`npm run bench -- --save` writes `bench/baseline.json`: the report plus the commit, date,
machine (CPU model, cores) and Node version. A plain `npm run bench` compares against it: for
each scene and section, the change in ms per step and in percent. A figure is **flagged** when
it is more than 10% slower *and* more than 0.05 ms per step slower (below that it is noise).
When the fingerprint differs from the baseline's, the report says the physics changed (expected
after a model change; the timing still compares the same scene). A different machine is
reported too, since timings only compare on one machine.

CLAUDE.md rule 9: run at the end of each slice; flag slowdowns with their cause; update the
baseline only for a slowdown that is accepted and explained.

## Interface

```ts
// src/sim/types.ts
interface StepTiming { steps; total; damage; debris; heavy; detail: number }   // ms, accumulated
SimConfig.timing?: StepTiming;

// src/bench/bench.ts
const BENCH_SCENES: readonly BenchScene[];
function runScene(scene: BenchScene, o?: { warmupS?: number; measureS?: number; timing?: boolean }): SceneResult;
function runBench(o?: { runs?: number; scenes?: string[] }): BenchReport;
function compareReports(base: BenchReport, now: BenchReport): Comparison;

// scripts/bench.ts  →  npm run bench [-- --save] [--runs N] [--scene id]
```

## Parameters

| Name | Unit | Value | Note |
|---|---|---|---|
| arrival | s | 25 | core at the focus point |
| warm-up / window | s | 15 / 20 | window centred on the passage |
| runs | – | 2 | minimum over runs |
| flag threshold | % / ms per step | 10 / 0.05 | CLAUDE.md rule 9; noise floor |

## Acceptance criteria

- **BENCH-01**: There are exactly two scenes, `ef4-town` and `detail-core`, with fixed seeds and
  parameters; running a scene twice gives the same fingerprint.
- **BENCH-02**: The timing hook changes no physics: a scene run with and without timing gives
  the same fingerprint.
- **BENCH-03**: A scene's result has the steps in its window (window ÷ dt), ms per step for
  total, damage, debris, heavy, detail and other, each ≥ 0, with the sections summing to the
  total; `detail-core` has detailed houses and `ef4-town` has none.
- **BENCH-04**: The comparison gives each scene's and section's change in ms and percent, flags
  exactly the figures more than 10% and more than 0.05 ms per step slower, and reports a
  changed fingerprint or machine.
- **BENCH-05**: `--save` writes a baseline with the report, commit, date, machine and Node
  version, and reading it back gives the same report.

## Simplifications / out of scope

- Physics only: rendering is profiled in the browser (Phase loop step 4), not here.
- In-process engines: worker messaging cost isn't measured.
- Timings compare only on the same machine.

## Decisions

Made by Claude (CLAUDE.md rule 1).

1. **Mature from the start, placed to arrive at 25 s.** A full lifecycle would spend minutes of
   sim time before the core reaches town; this keeps the bench to a few minutes while the
   window still has a realistic debris load from the approach.
2. **Minimum over runs.** Noise is one-sided (other processes only add time).
3. **In-process, one detail engine.** Comparable across machines with different core counts and
   matches STR-30's measurement.

## Changelog

- v1.0 (2026-11-26): initial version, approved (Phase 6 slice D).
