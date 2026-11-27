# Spec 13 — Structure Lab (v2)

Status: Approved (v1.1) — scope approved by the user 2026-11-25. Supersedes Spec 09's
"Structure lab (slice A)" section.

## Purpose

A close-up bench for a few houses: watch them come apart, inspect any member, and fire debris
at them. Unlike the slice A lab (`src/sim/structureLab.ts`), it is not a separate mini-sim.
It runs the **real sim** (the same `createSim`, damage, debris, impacts, heavy debris and
detail engine in workers as the town) on a small explicit layout, and uses the **main
renderer, camera and inspector**. So whatever the lab shows is what the town does.

## Model

### Layout

- **Lab block:** 1 to 12 detailed houses (default 1) in a grid of ⌈√N⌉ columns at 28 m lot
  spacing, centered on the origin, the lab's standard house size (14 × 11 m, 3 m walls, 2 m
  roof rise), ±3° placement jitter, each its own draw from the lab seed (as Spec 09 STR-23):
  house i's spec and its random layout and capacities come from its own stream, seeded by the
  lab seed and i (`HouseSpec.drawSeed`), so a block house is the same house with or without
  surroundings. They're given to the sim as an explicit
  layout (`SimConfig.houses`, Spec 12) and are all in the detail set from the first step
  (`detailSet`, one physics group named `lab`), so they never leave the zone or freeze.
- **Surroundings** (user setting):
  - **Neighborhood** (default): the block sits in the town's lot pattern, with component-model
    houses (Spec 03) on every lot within 130 m of the block's edge: the town's own houses for
    the lab seed (Spec 05), less any within 3 m of a lab lot (28 m square around each lab house).
  - **Neighbor density** (neighborhood only): 0.25× to 1.75× (default 1×, the town's own pattern,
    about 6.5 houses per hectare). The whole lot pattern (blocks, streets, lot frontage, setbacks)
    is scaled by 1/√density about the block, so the number of houses per area goes with density
    and every house keeps its real size; the same seed lays out the same houses in the same order.
    1.75× is about the densest that fits (lots ~17 m wide for houses up to 16 m); 0.25× is a
    rural road (46 m lots). They take damage, shed
    debris, block and catch debris, all through the town code.
  - **Open field:** nothing but the block.
- **Terrain** (setup option, Spec 17 v1.0): Auto (default) builds the roughness field from the
  surroundings as the town does (lawn under a neighborhood, farmland around and under an open
  field, the houses' own roughness); Open, Suburban or Urban apply that class everywhere and draw
  its ground (farmland, lawn, pavement).
- **Construction mix:** how many of the block's houses are weak, standard and strong (Spec 03
  classes), together 1–12; the grid fills in that order (weak first). Each house's capacities
  are its class's, its own draw from the lab seed as before.
- **Block model** (setup option): detailed (default) or component. A component block compares
  the two models in the same lab, and is what LAB-14 replays onto.
- **Donors:** Spec 12's stripped donor houses, which exist only as sources for launched detailed
  members. Always there, 4 km from the block and not drawn (a launch carries the member to its
  launch point, so where the donor stands doesn't matter, and nothing should meet its bare slab;
  found by the user: an empty slab beside the lab).
- **Seed:** a field in the panel (default 3, as now). The same seed and inputs give the same run.

Decisions:
- **Same code, not a copy.** The slice A lab had its own wind, start rule and stepping. Every
  difference from the town was a place for the two to drift (terrain, lifecycle, no
  surroundings, no heavy-debris worker). Building on the sim removes all of them at once.
- **One physics group for the block.** All lab houses share one Rapier world, so their debris
  meets in full physics, as before. In town a group is a street row; the block is small enough
  to afford one world (cost limit LAB-11).
- **Own draw stream per lab house.** In an explicit layout the houses otherwise draw their
  layout and capacities in order from one stream, so adding neighbors would change the lab
  house. Replay needs the receiving house to be the recorded one.
- **Density by spacing, not by thinning:** scaling the pattern keeps the town's layout (rows facing
  streets, the empty-lot share) at every density; thinning lots at random would give gaps no
  real neighborhood has, and couldn't go above 1×. Real neighbors, not a statistical stand-in: a
  measured debris stream keyed by local wind was tried (v0.5) and failed its check against real
  neighbors (3.4× too few hits), because debris arrival depends on where a house sits in the
  vortex, not only on its wind.
- **Neighborhood by default, out to 130 m.** The alignment work (Phase 6,
  2026-11-25) showed that upwind houses as debris sources change a detailed house's outcome
  from DOD 4 to DOD 7–10 at the same wind. A house alone in a field is the exception, not
  the town's case. Component houses are cheap, so the ring costs little.

### Wind

Two modes, both through the sim's one wind state (`TornadoState`, with Spec 12's `tunnel`
field for steady wind):

- **Steady wind:** the Spec 12 tunnel flow. The panel's speed (mph at 10 m), direction and
  ramp set it live. Each change is written as a keyframe at the current sim time, so a run
  is still a deterministic schedule that can be replayed.
- **Tornado pass:** pick a preset (Spec 07), a heading, and the block's offset from the track.
  The preset fills in the tornado's settings, which can then be changed: the main simulator's
  controls (strength, core radius, forward speed, cloud base, and the advanced wind settings:
  outer falloff, inflow strength and depth, updraft, near-ground boost, height of strongest
  winds), the spin direction, and for a full lifecycle its forming, full-strength and dying
  times. Changing one marks the preset "Custom". The track stays straight (no path curve: the
  pass is aimed at the block). Lifecycle (user setting):
  - **Full lifecycle** (default): the preset's own lifecycle (Spec 08), with the start time and
    point chosen so the tornado reaches the closest point to the block at the middle of its
    mature stage.
  - **Mature throughout:** the preset's mature V_max and R_max for the whole pass, starting
    at the nearest distance (at least 2·R_max) where the roof wind at **every house in the
    layout**, the neighbors included, is under the pass's calm threshold (40 mph, see
    Parameters).
  Choosing a mode shows its settings; nothing starts until its button is pressed.
- **Default:** the lab opens in tornado-pass mode with the houses built in calm air; the tornado
  starts only on "Send tornado" (which rebuilds the houses). Any other rebuild in pass mode
  returns to calm air and waits again.

Decisions:
- **Live edits as keyframes:** dragging a slider mid-run stays deterministic and recordable;
  nothing reads frame time.
- **Full lifecycle by default** (v0.3, at the user's request): it grows from nothing far away,
  as in town. Mature throughout stays for studying a house at a fixed strength.
- **Calm at every house, no R_enter cap** (v0.3): the start was first judged at the lab block
  only and capped at the detail zone's entry distance; the neighbors, up to 130 m nearer the
  tornado, started in damaging wind (found by the user). The lab's houses are pinned in the
  detail set, so the entry cap has no purpose there.

### Debris launcher

The lab fires debris through the tunnel's launch path (Spec 12 "Debris launcher", the sim's
`inject` hook), so every piece moves and hits by the town's code:

- **What:** any Spec 04 town piece kind (shingle, siding, OSB, 2×4, rafter, glass, chunk, …), or
  a real detailed member from a donor: a roof or wall sheathing panel, a siding course, a shingle
  patch, a rafter pair, a fascia board, an entry door. Each shot takes the donor's next unused
  member of that kind; it flies in the lab's physics group, so it meets the lab houses in full
  physics. Members start 4 m out (the tunnel's stand-off), not 10: they aren't steered to
  arrive, and from 10 m a broadside sheathing panel lands short.
- **Reference missiles** (presets): ASTM E1996 Missile A (2 g steel ball at 39.6 m/s), B (2×4,
  0.91 kg at 15.3 m/s), C (2.05 kg at 12.2 m/s), D (4.1 kg at 15.3 m/s), E (4.1 kg at 24.4 m/s);
  ICC 500 / FEMA P-361 shelter missile (6.8 kg 2×4 at 44.7 m/s horizontal, 30 m/s vertical).
- **Aim:** click a surface of a lab house (pane, wall panel, roof, door) for a house-local aim
  point, or give a direction. The piece starts 10 m out from the aim point along the reverse of
  its velocity, end-on (lumber) or flat (sheets), with optional spin.
- **Arrival speed:** test standards give the speed at impact. A missile's launch velocity is
  solved so that, flying by the debris field's own integrator (drag, gravity, the wind blowing
  at launch), it reaches the aim point at the standard's speed. Each missile flies with its
  standard's length and mass (ASTM E1996 Table 2 lengths: B 525 mm, C 1.2 m, D and E 2.4 m;
  ICC 500 about 12 ft; missile A an 8 mm ball).
- **Fire** launches one piece at the next step. **Stream** launches `rate` pieces per second
  from upwind (2–40 m above the ground, random aims over the chosen face, seeded), until it's
  stopped. Stream is the "ambient missile" environment for straight-wind tests.
- Every launch goes in the log with what it hit (Spec 12 record: impacts with path, measure,
  threshold and result).

### Debris replay

Real debris on a house, without the neighbors and repeatable: record the debris that reaches a
house in a pass, then fire exactly that at the lab block.

**Recording.** Any run with a target house can record: a town run in the main sim (the
inspector's "Record debris at this house" on a pinned house) or a lab run in a neighborhood.
Around the target sits a **capture box**: its footprint grown by 10 m on every side, from the
ground to 30 m. Every piece that crosses into the box from outside is recorded once, at the
debris step where it crosses (a neighbor's piece born inside the box, from a next-door wall
standing in it, where it's first seen):
- time, kind (Spec 04 kind, heavy-debris body, or detailed member kind), mass, size,
  `represents`;
- position, orientation, velocity and spin, **in the target's frame** (relative to its center
  and yaw).
Also kept, so a replayed piece moves as the recorded one did: its lift roll, spin sign, current
gust, stepping phase and last-stepped time (which alternate debris steps a far piece is
advanced on, Spec 04 v2.2), and whether it lies on the ground. A detailed member's velocity is its pose change over the last debris step; its spin is
not recorded (it replays without spin). The target's own debris and pieces that already touched it are left out; a
neighbor's piece born inside the box (next-door walls stand inside it, lots being 23 m wide) is
recorded where it's first seen. The recording also keeps the wind that went with it: the tornado's
preset, lifecycle state and track relative to the target (or the tunnel schedule). It's saved
as JSON, with the run's seed and the code version.

**Replay.** In the lab, pick a recording and a lab house to receive it (or the block's center
for a block). Each recorded piece is launched through the Spec 12 launch path at the first step
at or after its time, in the recorded state, moved into the receiving house's frame. Town and
heavy pieces replay as themselves. A detailed member replays as a donor member of the same
kind (the donors turn on), or as the Spec 04 kind with the same mass and size if no donor has
that kind. Wind (user setting):
- **Recorded wind** (default): the recording's tornado (or schedule), placed relative to the
  receiving house as it was relative to the target;
- **Debris only:** no wind. Pieces keep their entry momentum and then fall under gravity. This
  separates what the debris does from what the wind does.
- **Any lab wind:** the recorded debris under a steady wind or another pass.

During a replay the surroundings are "open field": the neighbors' debris is already in the
recording, and live neighbors would count it twice.

Decisions:
- **Capture box at 10 m out, 30 m up.** Close enough that a piece's path to the house after
  recording is short (its turbulence draws barely matter), far enough that it hasn't reached
  the house yet. Nearly all windborne debris in surveys travels below 30 m.
- **Record at the boundary, not at the source.** A recording made in town has all the town's
  causes folded in (which houses failed, when, where their pieces went), but replays without
  simulating any of them.
- **Turbulence:** the debris field draws turbulence from one shared stream (`field.ts`), so a
  replayed piece gets different gusts than in the original run. Over ≤ 15 m of path the
  difference is small. **Dispersion off** (`SimConfig.dispersion = false`, test and lab
  setting) holds every gust at zero; then a piece's flight to the house draws nothing from the
  stream, and its first hit replays exactly (LAB-14) if it gets there without touching the
  ground. Later hits can differ, and so can a piece that lands on the way: an impact's outcome
  (perforation) and landing (snagging, bumps) draw from the shared stream.
- **What dispersion-on replay keeps:** which pieces reach the house and how hard they hit
  first, not the raw impact count (a strip pressed against a wall registers an impact every
  step for each represented copy). The replay reads slightly slower (−4 to −12% per pass): the
  pieces that reached the box were partly picked by favorable gusts, and fresh gusts regress
  to the mean. Three passes keep the sampling noise (about 30 pieces each) inside ±10%.
- **Terrain is part of the wind:** the recording keeps the terrain its wind blew over (a class,
  or with a roughness field the target's local and upwind-weighted z₀ for each direction at each
  field update, Spec 17), and a replay in the recorded wind uses it, even with no neighbors (open
  field); the Terrain setting is locked while it runs.
- **Target-frame storage:** one recording replays at any lab house, heading or yaw.

### View, camera and inspection

- **Renderer:** the main renderer (Spec 06): the same camera keys and mouse (REND-14 to 17),
  layers, funnel, dust, debris, and the detailed houses' member view. "Follow tornado" is off
  by default. The start view frames the block; on a pass, it looks up the track from beyond
  the block, as now.
- **Cutaway:** hides roof members that are still attached (view only), as now.
- **Wind arrows** (option, off by default): the main simulator's ground-level wind arrows, the
  grid centered on the block (in town it follows the tornado).
- **Inspector:** the Spec 07 probe and pins on any house, exactly as in town (hover summary,
  click to pin, the pinned card's graph and failure list); the lab's own clicks (aiming) come
  first only while aiming.
- **Readout:** the Spec 07 tornado readout (EF, speeds, lifecycle phase, damage tally of the lab
  houses and neighbors; the hidden donors aren't counted) during a pass, as in town; in steady wind a wind box (10 m and roof-height wind). A line under it gives
  the lab's counts (houses, connections broken, launches).
- **Component details** (lab houses): a pinned lab house's card has "Show component details",
  which colors that house's attached members by their highest connection utilization (green 0 →
  yellow → red 1), makes clicks on its members open the member inspector, and lists its
  connection failures in the card, newest first (house, wind, label, member, load > capacity);
  "Hide" ends all three. Several houses can show it at once. There is no separate failure log
  (neighbors' cards list what failed on them, as in town). In a pass the readout is the only
  box; in steady wind a wind box (10 m and roof wind, the lab's counts) takes its place.
- **Member inspector** (lab houses in the stress view): click a member to see its kind, mass, and every
  connection with its live load, capacity and utilization (load / capacity), plus when and in
  what wind it failed. These are the engine's own values, sent with the detail step's state.
- **Utilization colors:** the stress view's colors, from the same values.
- **Failure log:** in each lab house's component details (above).

### Time

Pause, 0.25× to 4×, **step** (one detail step, 1/60 s), and rebuild with the same seed. The sim
advances at fixed steps; the speed only sets how many steps run per frame. When physics can't
keep up, the run slows down (the slow-motion message, as in town).

### Detail level

Lab houses are always built at the highest detail level available: Spec 14 components and
contents and Spec 15 trees, once those are built. The town's detail zone uses whatever level its
time budget allows (Spec 14).

### Record

The lab keeps the Spec 12 record (samples, failures, impacts, launches, pass-through) for the
current run. **Export** saves it as JSON for the wind-tunnel checks.

## Interface

```ts
// src/sim/lab.ts: the lab as a sim configuration (replaces src/sim/structureLab.ts)
interface LabSetup {
  houses: number;                       // 1–12
  cls: ConstructionClass;
  surroundings: "neighborhood" | "open";
  seed: number;
  donors: boolean;
  model?: "detail" | "component";       // block model, default detail
  specs?: Partial<HouseSpec>[];         // per-house overrides (tests)
  dispersion?: boolean;                 // default true
}
type LabWind =
  | { kind: "steady"; keys: WindKey[] }                 // Spec 12 schedule
  | { kind: "pass"; presetId: string; headingDeg: number; offset: number; lifecycle: "mature" | "full"; params?: Partial<TornadoParams> };  // params over the preset's
  | { kind: "track"; presetId: string; lifecycle: "mature" | "full"; params: Partial<TornadoParams>; start: { x: number; z: number } };  // replay
function createLab(setup: LabSetup, wind: LabWind, opts?: { workers?: boolean; replay?: ReplaySpec }): Promise<Lab>;
interface Lab {
  sim: Sim;
  block: number[];                      // sim building indices of the lab houses
  setSteady(mph: number, dirDeg: number, w?: number): void;   // keyframe at the current time
  launch(l: Launch): void;              // Spec 12 launch, at the next step
  stream(s: StreamSpec | null): void;
  memberInfo(house: number, member: number): MemberInfo | null;
  record: TunnelRecord;
  recordDebris(house: number): DebrisRecorder;
}
// A replay is a lab built for it (no neighbors, the recording's launches and wind):
interface ReplaySpec { recording: DebrisRecording; house: number | "block"; wind: "recorded" | "none" | "lab" }

// src/sim/debrisRecorder.ts: used by the main sim and the lab
interface DebrisRecording {
  version: number;
  seed: number;
  target: { width: number; depth: number; yaw: number };
  wind: { kind: "pass"; presetId: string; track: TrackInTargetFrame; lifecycle: "mature" | "full" }
      | { kind: "steady"; keys: WindKey[] };
  pieces: RecordedPiece[];   // in time order, target frame
}
function recordDebrisAt(sim: Sim, building: number, wind: DebrisRecording["wind"], opts: { seed: number }): DebrisRecorder;
```

`src/labMain.ts` becomes the lab's panel on top of `createRenderer`, `createProbeUI` and the
worker backends, as `src/main.ts` uses them.

## Parameters

| Name | Value | Unit | Source |
|---|---|---|---|
| lot spacing | 28 | m | Spec 09 (typical suburban frontage) |
| max lab houses | 12 | – | Spec 09 measured cost limit; re-measured by LAB-11 |
| neighborhood reach | 130 | m from block edge | Phase 6 alignment check (upwind debris sources) |
| launch stand-off | 10 | m | far enough to reach launch speed in free flight, close enough to hit the aim |
| stream height | 2–40 | m | the height band where windborne debris is dense in surveys |
| capture box margin | 10 | m beyond the footprint | short replayed path to the house, still before it arrives |
| capture box height | 30 | m | nearly all windborne debris in surveys travels below it |
| pass calm threshold | 40 | mph roof-height wind | below it ~0.15% of component houses lose any part in steady wind (Spec 03 v2.5's siding, 428 Pa); was 50 with Spec 03 v2.4's 633 Pa, the same margin (50 × √(428/633) ≈ 41) |

## Acceptance criteria

- **LAB-01**: The lab is the sim: it builds with `createSim` on an explicit layout, the lab
  houses are in the detail set from the first step in one group, and no lab-only physics
  module exists.
- **LAB-02**: Layout: N houses (1–12) in a grid of ⌈√N⌉ columns at 28 m spacing centered on the
  origin; with "neighborhood", component houses fill every town lot within 130 m of the
  block's edge and none overlaps the block; with "open", the sim holds only the block (and
  donors, if on).
- **LAB-04**: Steady wind: the lab's wind equals the Spec 12 tunnel flow for its keyframes, and
  a mid-run slider change is a keyframe at that sim time (replaying the keys gives the same run).
- **LAB-05**: Tornado pass, mature: starts at the nearest distance (≥ 2·R_max) where every
  house's roof wind is under the calm threshold (no house fails in the first second), constant V_max and
  R_max, straight track; the pass ends as far past the block as it started.
- **LAB-06**: Tornado pass, full lifecycle: the closest approach to the block falls at the
  middle of the preset's mature stage.
- **LAB-07**: Determinism: the same setup, wind and launches give the same failures, impacts
  and final poses, with the detail engine in a worker or in-process (STR-08 and STR-22 carried
  over).
- **LAB-16**: Tornado settings: a pass's params are the preset's with the given ones over them
  (heading and path curve always the pass's own), for both lifecycles; a mature pass still holds
  its (custom) V_max and R_max throughout and starts calm at every house.
- **LAB-17**: Member missiles: the lab panel always builds the donors; firing a member kind launches the
  donor's next unused member of that kind (a different one each shot) in the lab's physics group,
  aimed as a missile; with none left the shot is refused, not the run.
- **LAB-18**: Neighbor density: at density d the neighborhood ring has d × the houses per area of
  the town's pattern within reach (±15% over the ring), at 1 exactly the town's lots; no two houses
  (ring or block) overlap, and none reaches into a lab lot.
- **LAB-19**: Lab inspection: a pinned house's card offers the stress view exactly for lab
  houses (detailed); in it each attached member's color is its highest connection utilization on
  the green–yellow–red scale, members of other houses keep their own colors, and a member click
  opens the member inspector only for a house in the stress view.
- **LAB-20**: Construction mix: a block of w weak, s standard and t strong houses has w + s + t
  houses (capped at 12), the first w weak, the next s standard and the last t strong; a house's
  spec and draws depend only on its seed, position in the grid and class.
- **LAB-08**: Launcher: a reference missile aimed at a pane hits that pane, in still air and in
  steady wind (its impact is in the record with the missile's mass, and its normal speed within
  5% of the standard's: the 10 m path arcs a few degrees). Missile presets match their standards' mass
  and speed. A stream launches at its rate, seeded.
- **LAB-09**: Member inspector: the load, capacity and utilization shown for a connection equal
  the engine's values for that step; a failed connection shows its failure time and wind.
- **LAB-10**: Zero pass-through in a lab run: an EF3 direct hit on 4 houses in a neighborhood,
  checked by the Spec 10 pass-through checker at every debris step.
- **LAB-11**: Cost: the costliest second of an EF3 direct hit runs at ≥ 0.5× real time with 4
  lab houses and ≥ 0.25× with 12, in the worker setup (measured on the dev machine; the
  max-houses limit follows the measurement).
- **LAB-12**: The record exports as JSON that the tunnel's checks read unchanged.
- **LAB-13**: Recording: every piece that enters the capture box from outside is recorded once,
  with its state at the crossing step equal to the debris field's (in the target's frame);
  pieces from the target itself and pieces that touched it are left out; the recording keeps
  its wind, seed and version.
- **LAB-14**: Replay matches the recording: a recording made around a component target and
  replayed onto the same house (same spec and draws), in the recorded wind with debris
  dispersion off in both runs, gives each recorded piece whose path from the box edge to the
  house stays off the ground the same first impact on the house (surface, component, debris
  step). With dispersion on, over three town passes (seeds 3, 5, 7), the number of recorded
  pieces that hit the house and their mean first-hit normal speed are within ±10% of the
  recording runs'.
- **LAB-15**: Replay frames and wind: a recording replays at any lab house and yaw with the
  pieces in that house's frame. "Debris only" has zero wind throughout. A replay runs with no
  neighbor houses. Replays are deterministic.

## Simplifications / out of scope

- The neighborhood ring is component-model only. More detailed houses means more lab houses.
- One physics group for the block, even when it spans what in town would be two street rows.
- No saved runs or replay in the app beyond the record export (Phase 15).
- A recorded detailed member replays without spin.
- Replay is exact only for each piece's first hit, and only with dispersion off (see Debris
  replay).

## Changelog

- v1.1 (2026-11-26, BL-029): the mature pass's calm threshold 50 → 40 mph roof wind. Spec 03
  v2.5 calibrates houses on the EF scale's 10 m open basis, so component siding is weaker in
  local wind (428 Pa, was 633) and 8% of houses lost siding at 50 mph; 40 mph keeps the old
  margin. The pass starts farther out (the far field decays slowly). LAB-05 unchanged in intent.

- v1.0 (2026-11-26, Phase 7): terrain from the surroundings' roughness field (Spec 17), with a
  Terrain setting (Auto, Open, Suburban, Urban); LAB-03 retired, replaced by TERR-11; a
  recording keeps the roughness at its target.
- v0.9 (2026-11-26, the user's request): the block's construction mix (LAB-20), weak, standard
  and strong counts within the 12-house limit.

- v0.8 (2026-11-26, the user's request): opens in tornado-pass mode, waiting in calm air until
  "Send tornado".

- v0.7 (2026-11-26, the user's request): the town's probe and tornado readout in the lab; the
  component stress view per pinned lab house (LAB-19) replaces the global utilization toggle and
  the always-on member clicks.

- v0.6 (2026-11-26, the user's choice): neighbor density for the real neighborhood (LAB-18); the
  v0.5 stream removed. A neighbor's piece born inside the capture box (next-door walls stand
  inside it) is recorded where first seen.
- v0.5 (2026-11-26, at the user's request, removed in v0.6): a measured debris stream from upwind
  standing in for neighbors, with a density setting. Its check against real neighbors failed (93
  hits against 317; arrivals too high and fast for a house in the vortex's path).

- v0.4 (2026-11-26, the user's review): the tornado's settings can be changed from the preset's
  (LAB-16); donors are always there and the launcher fires real members (LAB-17) — the "Upwind
  donors" setting had no way to be used from the panel.

- v0.3 (2026-11-26, the user's review): full lifecycle is the default; a mature pass starts calm
  at every house, the neighbors included, with no R_enter cap; picking a wind mode doesn't start
  it. Rebuilds keep the camera; a rebuilt lab draws its houses new.

- v0.2: approved (2026-11-25). Built the same day; what the build settled: missiles arrive at
  their standard's speed (launch solved in the wind blowing); a replay is a lab built for it;
  the recording keeps its terrain; LAB-14's exact check covers pieces whose path stays off the
  ground, and its dispersion-on check counts pieces reaching the house over three passes; the
  detail and heavy-debris workers build an explicit layout's houses (they rebuilt the town
  from the seed); a light piece inside a house is pushed toward its inside, not out through its
  wall, when a rebuilt shape overlaps it (found by LAB-10). Earlier in v0.2: Build decisions: each lab house draws from its own stream
  (`HouseSpec.drawSeed`) so it is the same house with or without surroundings; the
  neighborhood is the town's own houses kept clear of the lab lots; a component block model
  option; `SimConfig.dispersion` to hold gusts at zero; recordings keep each piece's lift
  roll, spin sign, gust and stepping phase; LAB-14 made exact for each piece's first hit
  (later hits draw from the shared stream).

- v0.1: draft at the user's request (2026-11-25): rebuild the lab on the real sim, the main
  renderer and the tunnel's launcher, so the lab shows exactly what the town does. Debris
  replay (LAB-13 to LAB-15) added at the user's request: record the debris that reaches a house
  in a pass and replay it in the lab, with the recorded wind, no wind or any lab wind.
