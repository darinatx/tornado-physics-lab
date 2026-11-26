# Spec 12 — Wind Tunnel (Test Harness)

Status: Approved (v0.2) — Stage 1 (headless tunnel, launcher, record, checks, parallel runner).
Stage 2 (tornado replay, ramp-to-failure fragility, reference missile tests, timestep
convergence, viewer) is outlined at the end.

## Purpose

Most damage and debris checks so far run a tornado through a patch of town. They take minutes,
and when one fails it is hard to tell which piece, house or model caused it. The wind tunnel
puts **one house** in a scripted wind and fires **known debris** at it, through exactly the code
the town uses, so each finding comes down to one piece, one surface and one model, and runs in
seconds. Scenarios are data, seeded and deterministic, and run in parallel as fast as the CPU
allows at the sim's fixed timesteps.

## Model

### Layout

- **Target:** one house at the origin, from a full house spec (size, yaw, construction class,
  garage) or a seeded random one, on the **component model** (Spec 03) or the **detailed model**
  (Spec 09). A detailed target is in the detail zone from the first detail step to the end of
  the run: it never leaves the zone or freezes.
- **Donors:** houses that are only debris sources for detailed members (below). A donor is a
  detailed house with every member removed, so all that stands is its slab; launches rebuild the
  members they fire as free bodies. Donors stand 80 m to either side of the target, across
  the wind's mean direction (speed-weighted over the schedule), out of the flow onto it:
  - **same group:** in the target's physics group (as a house in its street row is), so its
    pieces are in the target's physics world;
  - **other group:** in a physics group of its own, so its pieces meet the target only
    through stand-ins (Spec 10), as pieces from another part of town do.
  The tunnel names the groups itself (in town a group is a street row); everything else about
  groups is unchanged.
- **Nothing else:** no town. The houses are given to the sim as an explicit layout (Spec 08).

### Wind

A tunnel flow replaces the tornado for the whole sim: town damage, debris and the detail engine
all read it through the same `windAt` and `pressureDeficit` (Spec 01).

```
U(z)  = U10 · envFactor(z, terrain)            = U10 · (z / 10 m)^β below 10 m, U10 above (Spec 01)
wind  = U(z) · (cos θ, 0, −sin θ) + (0, w · min(z / 10 m, 1), 0)
deficit = Δp (Pa, uniform over the tunnel)
```

- θ is the direction the wind blows **toward**, deg, 0 = +X, counter-clockwise from above (the
  same convention as the tornado heading).
- A schedule of keyframes `{ t, mph, dirDeg, w?, deficit? }` sets U10, θ, w and Δp over time.
  Values between keyframes are linear in time; direction turns along the shorter arc; before
  the first and after the last keyframe they hold.
- Speeds in scenario files are in mph at 10 m (the EF-scale boundary, converted once);
  everything inside is SI.

Decisions:
- **Same code, not a copy.** The tunnel flow is an optional field of the wind state the sim
  already hands to every subsystem (`TornadoState.tunnel`): `windAt` and `pressureDeficit`
  return the tunnel's values when it is set. Every model, the worker message and the
  range checks then take the tunnel without a second path to drift from the town's. The state
  marks the whole tunnel as in range (center at the target, core radius 10⁶ m, never behind).
- **Power-law profile with the terrain's β**, as Spec 01 uses for the environmental wind; it
  is what a boundary-layer wind tunnel reproduces.
- **Vertical wind ramps from zero at the ground** to w at 10 m: air can't flow through the
  ground; a uniform w would lift resting pieces unphysically.
- **Mean flow, the sim's own gusts.** Houses see the mean wind, as in town; debris adds the
  Spec 04 turbulence as everywhere else. A gusty test scripts its gusts as keyframes.

### Debris launcher

Each launch fires one piece at a time `t`, from a point, with a velocity (a speed and a
direction, or aimed at a point on the target: a house-local surface point such as the center
of a pane or a wall panel), optionally spinning:

| Source | What it is | Where it lives |
|---|---|---|
| `town` | a Spec 04 piece kind (shingle, siding, OSB, stud, rafter, glass, chunk, …), or a component-sized piece | the town's debris field (main thread) |
| `detail-same` | the named member kind(s) of the same-group donor (siding, wall sheet, roof sheet, shingle strip, fascia, trim, door, …) | the target's physics world |
| `detail-other` | the same, from the other-group donor | another physics world |

- **Town pieces** join the debris field at the first debris step at or after `t`, at the point
  with the velocity, oriented as given (default: end-on, the piece's long axis along its
  velocity, as missile tests fire lumber), standing for `represents` real objects (default 1).
  From then on they move only under Spec 04 physics and hit houses only under Spec 10. The mass
  ledger (DEB-16) counts them as spawned.
- **Detailed members** are released in their donor at the first detail step at or after `t`:
  the chosen members become one free body through the same body-making code as members torn
  loose by the wind, moved so their center is at the launch point, with the velocity and spin.
  Their contacts count from the launch (no 0.5 s separation grace: they were never attached).
  From then on they are ordinary detail debris (Rapier, then the light-piece model).

Where each pair meets is then decided by the zones, exactly as in town:

| Piece → target | Path |
|---|---|
| town → component | envelope hit (Spec 10) |
| town → detailed | the detailed house's stand-in (IMP-18), forwarded to the engine (IMP-20) |
| detail-same → detailed | Rapier contacts in the shared world (IMP-21) |
| detail-other → detailed | the target's stand-in in the donor's world, hits applied at the cutoff (IMP-20) |
| detail → component | the town stand-in in the donor's world, impacts queued at the cutoff (IMP-20) |

Decisions:
- **Donors, not a special body type.** Launched members are real members of a real (stripped)
  house, so ownership, poses, light-piece hand-off and impact reporting are the ones town debris
  uses. The donor's slab is real too, which is why donors stand out of the flow.
- **Launch at the next step, never between steps**, so launches are deterministic and need no
  sub-step physics.

### Running

- Headless: no rendering, no clock. The runner advances the sim 1/60 s at a time (each debris
  step is observed) as fast as the CPU allows. The physics steps are fixed (1/120 s sim,
  1/60 s detail) and never change, so running faster than real time changes nothing in the
  result. The detail engine runs in-process, step for step.
- Parallel: the runner spreads scenarios over worker threads (one sim each; each loads its own
  Rapier). Scenarios share nothing, so the result of each is the same alone or in a pool.

### Record

Every run keeps:
- **Samples** at 10 Hz: time, the tunnel's U10 (mph) and direction, wind speed at the target's
  roof height (mph), deficit (Pa), the target's DOD and failure count.
- **Events**, in time order:
  - every failure of the target: component failures (part, index, load, capacity, mph, cause,
    missile) or detailed connection failures (label, load, capacity, mph);
  - every impact on the target, counting representative copies: surface, component, missile
    label, mass, normal speed, the measure and threshold, and what it did (broke, perforated,
    siding or shingles torn, impulse force); with the path it came by (`debris` = the town's
    field, `detail` = from the detail engine);
  - every launch: when it actually entered the sim, its source and piece.
- **Launch tracks:** each launched piece's closest approach to the target and its final
  position.
- **Pass-through:** the independent pass-through checker (tests/harness/passthrough.ts) observes
  every debris piece and detailed member at every debris step and all rubble once a second;
  any crossing is in the record, and ground dips are counted apart with the deepest.

A scenario's checks read the record. Every scenario also requires zero pass-through.

## Interface

```ts
// src/core/wind/types.ts
interface TunnelFlow { u10: number; dirDeg: number; w: number; deficit: number }   // m/s, deg, m/s, Pa
interface TornadoState { …; tunnel?: TunnelFlow }

// src/sim/tunnel.ts — the tunnel as a sim (reusable by a viewer in stage 2)
interface TunnelScenario {
  name: string; seed?: number; seconds: number;
  target: { model: "component" | "detail"; spec?: Partial<HouseSpec>; cls?: ConstructionClass };
  terrain?: TerrainClass;
  wind: { t: number; mph: number; dirDeg: number; w?: number; deficit?: number }[];
  launches?: Launch[];
}
function createTunnel(s: TunnelScenario): Promise<Tunnel>;   // sim + target index + launcher
function tunnelFlow(wind: TunnelScenario["wind"], t: number): TunnelFlow;

// tests/harness/tunnel.ts — running, recording, checking
function runTunnel(s: TunnelScenario, opts?: { chunk?: number }): Promise<TunnelRecord>;
// scripts/tunnel.ts — the parallel runner: npm run tunnel [-- name-filter]
```

Hooks this adds to other specs: `SimConfig.houses`, `tunnel`, `detailSet` (with each house's
physics group and whether it enters stripped), `taps` (read-only observers) and `inject`
(launches at the debris and detail steps) (Spec 08); `DebrisField.launch` and its impact
observer (Spec 04); `DetailStep.launches` and a group key on entering houses (Spec 09).

## Parameters

Donor offset 80 m; samples at 10 Hz; vertical-wind ramp height 10 m; launches at 60 Hz step
boundaries. Values live in `src/config/tunnel.ts`.

## Acceptance criteria

- **TUN-01**: Tunnel flow: `windAt` gives U10·envFactor(z, terrain) along θ plus the ramped
  vertical wind, and `pressureDeficit` gives Δp, everywhere; keyframes interpolate linearly in
  time, direction along the shorter arc, and hold outside the schedule.
- **TUN-02**: Layout: the sim holds exactly the target (at the origin, with its spec) and the
  donors (same group: in the target's physics world; other group: in another; both 80 m across
  the wind); a detailed target is in the zone from the first detail step and stays for the whole
  run; a component target is never detailed.
- **TUN-03**: The tunnel's wind drives the damage: with no wind nothing fails, in either model;
  a steady 200 mph wind tears the roof off a standard house in either model; a component
  target's failures under the tunnel are the same as `updateBuilding` driven directly with the
  same roof-height wind and deficit, up to its first debris impact.
- **TUN-04**: Town launches: the piece appears in the debris field at the first debris step at
  or after its time, at its point with its velocity and orientation, counted in the mass
  ledger, and then moves only by Spec 04 physics.
- **TUN-05**: Detailed launches: the members leave the donor as one free body at the first
  detail step at or after the launch time, centered on the launch point with the launch
  velocity, and their contacts count from the launch.
- **TUN-06**: All five paths work: a piece fired at a window of the target breaks that pane,
  for each of town → component, town → detailed, detail-same → detailed, detail-other →
  detailed and detail → component; the record shows the pane's failure, and the impact with the
  path it came by wherever the sim resolves it (every path but detail-same → detailed, which
  Rapier resolves inside the engine).
- **TUN-07**: Every scenario is checked for pass-through at every debris step (debris and
  detailed members) and for rubble once a second, and fails on any crossing of a house's walls,
  roof or slab. Dips below the ground (the open Rapier contact-softness item of Spec 10) are
  counted with their depth in the record and the report, and don't fail it, as in IMP-17/19.
- **TUN-08**: Record and determinism: the record has the samples, failures, impacts and
  launches above; the same scenario gives an identical record however the run is chunked, and
  alone or in the parallel runner.
- **TUN-09**: The runner runs scenarios on several worker threads at once, reports each
  scenario's sim time, wall time, speed (× real time), events and check results, and exits
  non-zero if any check fails.
- **TUN-10**: Speed: a 10 s scenario runs at least 10× real time with a component target and
  at least 1× with a detailed target (one core, the scenario library's shot scenarios).

## Simplifications / out of scope

- Uniform in plan: the tunnel has no vortex (no swirl, no radial gradient, no core passage).
  Stage 2's tornado replay plays back the wind a tornado pass gives at one point.
- Houses see the mean flow (no gust structure smaller than the house), as in town.
- A detailed member launch is one body per launch (several members fly together only if listed
  in one launch).

## Stage 2 outline (not yet approved)

- Tornado replay: record wind, deficit and updraft at the target point through a preset pass,
  play it back in the tunnel.
- Ramp-to-failure: slow ramps, the wind at each component's failure, fragility curves across
  seeds, compared with the DI 2 expected values.
- Reference missile tests (IMP-12 by actual launches): ASTM E1996 2×4 cannon, ICC 500 / FEMA
  P-361 shelter missile, small-missile glass tests.
- Timestep convergence: a scenario at half the timestep gives the same outcome.
- Viewer: pick a scenario in the app and watch it, or replay a record.

## Changelog

- v0.2: the launcher (`src/sim/launcher.ts`), the record (`src/sim/runRecord.ts`) and the
  pass-through checker (`src/sim/passThrough.ts`) moved into the sim so the structure lab
  (Spec 13) uses the same ones; the tunnel's behavior and record are unchanged. Launches can
  aim at any house, carry an exact velocity, or arrive at their aim at a given speed.
- v0.1: first version, at the user's request: a wind-tunnel harness to find physics and damage
  issues faster than town passes (Phase 6, ahead of slice C).
