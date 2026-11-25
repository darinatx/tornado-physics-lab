# Spec 08 — Simulation Loop

Status: Approved (v1.5)

## Purpose

Advance the world in fixed physics steps independent of frame rate, own all simulation state,
and provide deterministic, replayable runs.

## Model

- **Fixed timestep:** physics runs at dt = 1/120 s. Each frame adds real elapsed time to an
  accumulator and runs as many steps as fit. Real elapsed time per frame is clamped to 0.25 s
  to avoid a "spiral of death" after a stall. The leftover fraction (alpha = accumulator / dt)
  is passed to the renderer for interpolation.
- **Time scale:** a sim-speed multiplier (0, 0.25, 0.5, 1, 2, 4) scales elapsed time before it
  enters the accumulator. 0 pauses.
- **Start position:** chosen so the full lifecycle path is centered on the map origin.
- **Tornado motion:** the center moves along a path, either a straight heading or a gentle
  curve (constant turn rate), at the translation speed. `TornadoState.velocity` is the path
  tangent × speed.
- **Lifecycle:** each step evaluates `lifecycle(t)` (Spec 01) to set vMax and rMax.
- **Randomness:** one seeded PRNG (mulberry32), owned by the sim. Nothing else may use
  `Math.random`.
- **World:** the sim owns the neighborhood (Spec 05). It's generated from the seed on reset and
  updated by the damage model (Spec 03) every 4th step. Snapshots carry a `damageVersion`
  counter and the DOD histogram (count of houses at each DOD), so the renderer and UI can tell
  when anything changed without the snapshot copying every house.
- **Debris:** the sim owns a seeded debris pool (Spec 04). Failures reported by the damage
  model spawn pieces; airborne pieces advance every step, and resting pieces are re-checked
  every 4th step. Snapshots carry the debris stats.
- **Snapshots:** after each step, an immutable `SimSnapshot` (time, tornado state) is made
  available to the renderer and UI.

- **Test area (validation):** a sim can be limited to the houses within a radius of a point
  (`area`), and the tornado can start at a given point (`start`) instead of halfway back along
  its path. With `tUp = 0` it is mature from the first step. Validation runs use this to pass a
  mature tornado over a small patch of houses without building or simulating the whole town.

## Interface

```ts
// src/sim/loop.ts
function createSim(config: SimConfig, seed: number): Sim;
interface SimConfig {
  dt: number; maxFrameDt: number; buildings: boolean;
  area?: { x: number; z: number; radius: number };   // only houses within (validation)
  start?: { x: number; z: number };                  // tornado start (default: path centered on the origin)
}
interface Sim {
  advance(realDtSeconds: number): { prev: SimSnapshot; curr: SimSnapshot; alpha: number };
  setParams(p: Partial<TornadoParams>): void;   // applied at the next step
  setTimeScale(k: number): void;
  reset(seed?: number): void;
  readonly time: number;
}

// src/sim/rng.ts
function createRng(seed: number): () => number;   // uniform in [0, 1)
```

## Parameters

| Name | Unit | Default | Note |
|---|---|---|---|
| dt | s | 1/120 | physics step |
| maxFrameDt | s | 0.25 | clamp on elapsed real time |
| heading | deg | 60 | 0 = +X, counter-clockwise; typical real tornado tracks run southwest → northeast |
| turnRate | deg/s | 0 | 0 = straight path |

## Acceptance criteria

- **SIM-01**: Advancing by 0.25 s in one call or in 15 calls of 1/60 s yields the same state
  (within 1e-9). (A single 1 s call would be clamped by SIM-02.)
- **SIM-02**: Elapsed real time per frame is clamped to `maxFrameDt`.
- **SIM-03**: alpha is always in [0, 1).
- **SIM-04**: Two sims with the same seed and inputs produce identical snapshots; different
  seeds produce different RNG sequences.
- **SIM-05**: Parameter changes from `setParams` take effect at the next step, not mid-step.
- **SIM-06**: With turnRate = 0 the center moves in a straight line at the translation speed
  (distance after t seconds = speed · t, ±1e-6).
- **SIM-09**: Every new failure spawns its debris in the same step; reset empties the pool;
  snapshot debris stats match the pool.
- **SIM-08**: Reset restores the neighborhood to undamaged; the damage version increases
  whenever any house's damage changes; the histogram always sums to the number of houses.
- **SIM-10**: With an `area`, the world holds exactly the town's houses whose centers lie within
  it (same houses, same ids and properties as in the full town); with a `start`, the tornado
  starts there; with tUp = 0 it is at full strength from the first step.
- **SIM-07**: Time scale 0 pauses (state unchanged); time scale 2 advances twice as far as 1.

## Simplifications / out of scope

- Path is a simple straight line or arc. Steering by the parent storm is out of scope.

## Changelog

- v1.5: for the wind tunnel (Spec 12): an explicit house layout (`houses`) instead of the generated
  town, a tunnel flow schedule (`tunnel`) that replaces the tornado, the houses the detail zone takes
  (`detailSet`: with each one's physics group and whether it enters stripped), read-only
  observers (`taps`: impacts on houses, detailed failures) and launch injection (`inject`: called
  at each debris step and each detail step).
- v1.4: test area and start point for fast validation runs (SIM-10), at the user's request
  (paired detail/component checks without a whole town or a forming tornado).

- v1.3: debris in the loop (SIM-09).
- v1.2: world, damage version and DOD histogram (SIM-08).
- v1.1: SIM-01 uses 0.25 s (a 1 s call conflicts with the SIM-02 clamp); start position and
  setTimeScale documented.
- v1.0: written and approved.
