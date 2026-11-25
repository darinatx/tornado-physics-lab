# Spec 09 — Structural Physics (Detail Zone)

Status: Approved (v0.14) — Phase 5 slices A (structure lab), B (detail zone in town) and C (validation)

## Purpose

Simulate houses at framing-member level, with real connections and rigid-body physics, so
damage and motion emerge from forces: connections break when loaded past their strength, and
whatever is no longer connected to the ground moves, topples, tumbles and collides on its own.
Used for the detail zone (ADR 0003); the Phase 4 component model covers everything else.

## Model

### Members

A detailed house is built from members, each a rigid box with real dimensions and density:

| Member | Size (m) | Notes |
|---|---|---|
| Bottom (sill) plate, top plate | 2×4 lumber along each wall panel | per Phase 4 wall panel |
| Studs | 0.09 × 0.04 × wall height | 0.6 m spacing |
| Wall sheathing | OSB 0.012 thick, up to 1.2 × 2.4 | covers each panel's outer face |
| Wall drywall | 12.7 mm gypsum, 10 kg/m², on the inside face of every exterior wall, cut like the sheathing | screwed to the studs |
| Corners | the long (eave) walls run through to the outside corner; end walls butt between them; the long walls' sheathing laps over the end walls' edge | no overlapping frames |
| Casing | 1×4 white trim around every window and door (with a sill at windows), on top of the sheathing | trim nails, 0.8 kN |
| Rough openings | windows, doors and the garage door are framed openings: studs stop at a doubled 2×10 header (cripples above, and below a window's rough sill), jack studs at each side; sheathing is cut around them | the frame collides as the solid wall around its openings |
| Window pane | 1.2 × 1.2 × 0.006 annealed glass in the opening, made of 18 triangular shards (3 × 3 cells split diagonally, ~0.4 m) | where the panel has a window |
| Exterior doors | front (dark red) and back (into the kitchen): insulated steel, 0.91 × 2.03 × 0.045, 17 kg/m², inswing | front door in the panel next to the garage; back door behind it |
| Garage door | 4.9 × 2.2 × 0.04 | front panel with a garage |
| Interior doors | hollow core 0.76 × 2.03 × 0.035, 7 kg/m², closed; the garage-to-house door is a solid exterior-type door | in the floor plan's doorways |
| Rafters | 2×6, eave to ridge, sitting on the wall top plates (the roof surface starts one rafter depth above the wall) | 0.6 m spacing, both slopes |
| Ridge board | 2×8 along the ridge | in segments per rafter bay |
| Roof sheathing | OSB 0.012, up to 1.2 × 2.4 | on each slope |
| Shingles | 2 × 2 patches per roof sheet | the outer layer; peel first |
| Ceiling joist | 2×6 across the house in each rafter pair, + 3 kg/m² insulation | ties the pair like a truss |
| Gable ends | stud frame up to the roof line on each end wall; two right-triangle sheathing panels meeting under the ridge | true triangular shapes (render and collision) |
| Ceiling | 12.7 mm drywall, 1.2 × 2.4 m sheets screwed under the ceiling joists | hangs from the joists; leaves with the roof |
| Fascia and soffit | one continuous trim board along each eave, plus a soffit panel closing the underside of the overhang | nailed to every rafter |
| Interior walls | the floor plan below, 2×4 studs with drywall both sides (0.115 m), cut for doorways | 20 kg/m² |

### Floor plan

A typical one-story, three-bedroom ranch (~150 m²). Front is −Z, the garage at the front-left:

- **Garage** in the front-left column, ~6 m deep, walled off from the house, with a solid door
  into the kitchen.
- **Living room** at the front and **kitchen** behind it, open to each other.
- **Bedroom wing** on the right (from 61% of the width): a 1.1 m **hallway** along the width,
  entered through a cased opening; **two bedrooms** in front of it; behind it the
  **bathroom** (2.1 × 2.4 m, the small interior room that survives longest), a **walk-in
  closet** behind the bath, and the **primary bedroom**. Every room has a door.

Positions scale with the house's width and depth (`floorPlan()`, constants in
`config/structure.ts`).

Densities: lumber 500 kg/m³, OSB 650 kg/m³ (+ 10 kg/m² shingles on roof sheathing), glass
2500 kg/m³, garage door 12 kg/m².

### Connections (the load path)

Every member is connected to what supports it. Connections form a directed acyclic graph
from roof sheathing down to the slab:

Capacities are mean **ultimate** strengths from laboratory tests (what the connection actually
breaks at), not design values, which are deliberately 2–3× lower:

| Connection | From → to | Capacity (standard house) | Source |
|---|---|---|---|
| Shingle nails & sealant | shingle patch → roof sheet | 1.8 kPa × patch area | sealed shingles (~38 psf; tests ~30–80 psf, aged lower); with the patch-to-patch scatter the weak ones go first |
| Siding nails | vinyl siding → wall sheathing | 0.4 kPa × area | aged vinyl siding, commonly lost in 60–70 mph gusts (calibrated, DOD 1) |
| Roof sheathing nails | sheet → rafters under it | 4.0 kPa × sheet area | 8d nails at 6/12 in., ~80 psf mean |
| Gable end nailing | gable frame → end wall frames | 1.75 kN per metre of shared plate | 16d face nails at 16 in., ~0.7 kN lateral each |
| Partition to slab | partition → slab | 2.5 kN per metre | powder-actuated pins at 24 in. (~1.5 kN each) plus nailing at wall intersections |
| Ceiling screws | ceiling sheet → joists over it | 0.6 kPa × sheet area | drywall screw pull-through |
| Rafter-to-wall (toe-nails) | rafter pair → top plates of front and back walls | 2.5 kN each | 3 × 16d toe-nails; tests ~400–700 lbf, calibrated against DI 2 DOD 6 |
| Ceiling joist toe-nails | rafter pair (its joist) → the same top plates | 1.2 kN each | 3 × 8d toe-nails, scaled with the rafter toe-nails |
| Wall sheathing nails | sheet → wall frame | 4.0 kPa × sheet area | |
| Window glazing | each shard → wall frame | 2.5 kPa × shard area, either direction (glass breaks in bending, no bearing side); when any shard's glazing fails the whole pane breaks | annealed glass |
| Door latch & hinges | exterior door → wall frame | 2.4 kPa × door area, inward only (pushed outward it bears on the stop) | inswing entry door, ~50 psf |
| Garage door track | door → wall frame | 1.3 kPa × door area, either direction (it buckles inward or pulls out of its tracks) | standard door |
| Drywall screws | wall drywall → wall frame | 0.6 kPa × sheet area, pulled inward only (outward it bears on the studs) | pull-through |
| Interior door hinges | door → its wall | 1.5 kN | three hinges screwed into the jamb |
| Wall to sill plate | wall frame → its sill plate | 1 kN per stud on the plate + 6.5 kN per metre | 2 × 16d end-nails per stud; sheathing nailed along the plate (8d at 6 in., ~1.0 kN mean ultimate each) |
| Sill anchorage | sill plate → slab | 10 kN per bolt; bolts ≤ 1.83 m apart with one within 0.3 m of each plate end, ≥ 2 per plate (IRC R403.1.6) | bolt + washer pull-through |

Rafter pairs are A-frames (both rafters together) bearing on the front and back walls; ridge
boards and corner nailing are not modeled in slice A.

Construction classes scale capacities like Spec 03 (weak: toe-nails ×0.7, anchorage ×0.6,
sheathing ×0.85; strong: hurricane straps at 6.0 kN instead of toe-nails, anchorage ×1.6,
glazing ×1.4, sheathing ×1.3).

A wall panel's frame (top plate + studs) is one member; its sill (bottom) plate is a separate
member bolted to the slab, so a wall that falls leaves its sill plate behind, as in real
damage. Exterior walls carry vinyl siding over OSB sheathing (OSB shows where siding is gone).

**Variability** (as Spec 03): every connection's capacity is scaled by a house-wide quality
factor (lognormal β 0.12) and its own scatter (β 0.10; shingles 0.15), and every shingle also
by a house-wide covering-condition factor (β 0.30: age and sealing), deterministic per house.
Most of the variation is shared by the house; per-connection scatter alone would make the
weakest of ~300 shingles fail far too early. A house's calm-skip threshold scales with its
weakest connection.

### Loads

- **Attached members:** the Spec 02 net pressure for the member's surface (wall face C_p and
  C_pi, roof C_p, APC) times its area, along its surface normal; plus gravity. As in building
  codes, two pressure sets are used: **local** (components and cladding: shingle C_p −1.8
  corner / −1.0 field, deck −1.2 / −0.8) to check cladding fasteners (shingles, sheathing,
  siding, glazing, doors), and **main-structure** pressures to check the framing. For the
  roof these are the ASCE 7 MWFRS values for a ~20° gable: wind across the ridge −0.7 on the
  windward slope and −0.6 on the leeward; wind along it −0.9 within one roof height h of the
  windward edge, −0.5 to 2h, −0.3 beyond; blended by cos²/sin² of the wind's angle to the
  ridge. The windward edge is where the standing roof begins: the gable while the whole roof
  stands, the leading edge of what's left once part of it is gone (the flow separates there;
  a gap of more than 1.5 rafter bays starts a new edge), so a roof that starts to go unzips. Wind acts on the roof deck only where its shingles are gone, and on wall sheathing only
  where its siding is gone. Siding has a vented cavity behind it: it feels outside pressure
  only (no internal pressure, no APC).
- **APC** (Spec 02): the inside deficit lags the outside one (τ 2 s sealed, 0.05 s once any
  envelope opening exists); a house starts in equilibrium when it enters the simulation (it
  enters far from the core, where the deficit changes slowly).
- **Open house** (Spec 03's rule): once half the wall sheathing or half the roof deck is gone,
  the exterior wall pieces still standing take free-standing wall loads (net C_p 1.3) and the
  exposed framing (frames, rafters, gables) takes drag on its lumber (C_D 1.2: 2.0 for one
  sharp-edged member, reduced for members in line).
- **Interior walls** get free-standing loads scaled by the share of exterior wall that's gone
  (wind reaches them through it). Rooms work as boxes: while at least two walls of a group (the
  bathroom's, or the other interior walls) stand, each wall keeps 30% of its broadside load
  (the walls it meets carry the rest in-plane); the bathroom is sheltered by half again.
- **Detached members:** flat-plate aerodynamics on their actual orientation:
  F_n = ½ρ·C_N·A·|v_rel|·(v_rel·n̂)·n̂ with C_N = 1.2, plus skin friction C_f = 0.05 along the
  plate. Lift, flipping and tumbling emerge; no tumble-averaged coefficients. A spinning plate
  also gets rotational drag about each in-plane axis, τ = −½ρ·C_N·w·ω|ω|·L⁴/32 (span L across
  the axis, width w along it). Members sheltered while attached (drywall, ceiling) still fly
  as plates once loose. A piece at rest stays asleep until the wind can lift it or beat
  friction (μ = 0.6).

### Load-path solver

**Bracing and overturning.** A wall frame still braced at the top by the roof framing (eave
walls: rafters bearing on them; end walls: any of the four outermost rafter pairs on their
side, through the ceiling diaphragm) sends half its out-of-plane load up into the diaphragm
(a wall spans floor to ceiling). A gable braced by either of its nearest rafter pairs sends a
third (a triangular wall's top reaction). An unbraced wall is a cantilever from its sill
plate: it fails when the moment of its out-of-plane load (at mid-height) beats the base's
moment capacity, 2.5 kN·m per metre (studs and sheathing nailed to the plate), raised by half
per standing neighbor on the same wall (lapped top plates) and doubled while its corner partner
on the perpendicular wall stands. A gable sitting on a wall doesn't brace it.

**Roof load sharing.** Roof sheets run 2.4 m along the ridge, tying each rafter to its
neighbors. A rafter's hold-downs on a wall fail when the mean demand/capacity of it and up to
three neighbors each side (still holding, on the same wall) exceeds 1, so a weak rafter is
held by its neighbors and roof sections let go together.

Each step, external forces (wind + gravity, and contact forces from impacts) on every attached
member flow down the graph: a member's total load (its own plus what its dependents pass on)
splits equally among its intact supports. A connection fails when its load exceeds its
capacity. Then every member with no intact path to the slab is detached; detached members still
connected to each other move together as one rigid body. Inside a moving body the same check
runs with inertial relief (each member's load minus its mass × the body's acceleration,
including the centripetal ω×(ω×r) term of its spin), checked at 15 Hz and on every impact, so
a flying roof section held by weak links (ceiling screws, a few sheets) tears apart mid-air.

### Rigid bodies

Rapier (ADR 0003): the intact house is a fixed body; each detached group is a dynamic
compound body built from its members' boxes, starting with the house's pose and zero velocity
(or the parent body's velocity at that point when splitting a moving group). Contacts with
the ground, the slab and other bodies are Rapier's. Impact forces come from contact force
events, converted from Rapier's one-step impulse to a realistic 0.1 s wood-on-wood contact
duration (framing crushes and flexes; a one-step spike overstates the peak several-fold), and
are added to the hit member's load when well above its own weight (resting contact).

### Structure lab (slice A)

A separate view (`?lab`) with one detailed standard house on open ground and a steady wind
whose speed and direction the user controls (mph), plus a log of connection failures with
their load and capacity.

**Houses.** The lab holds 1 to 12 houses (default 1): a block in a grid of ⌈√N⌉ columns at
28 m lot spacing, centered on the origin, all the lab's standard size and facing the same way (with the town's ±3° placement jitter),
each its own draw from the lab's seed (garage side, capacity scatter). They share one physics
world, so debris from one house hits the next. The failure log names the house.

Decisions:
- 28 m lots: a typical suburban frontage (about 20–30 m), close enough that debris reaches
  the neighbours.
- At most 12: measured on an Apple M5 under a direct EF3 hit, up to 4 houses keep real time and
  12 drop to about half speed in the worst second; beyond that it's mostly slow motion.

**Tornado pass.** Instead of steady wind, the user can send a tornado across the lab house:
pick a strength preset (Spec 07, EF0 to the hypothetical ~400 mph), the track's heading and
its offset from the house (the block's center when there are several) (positive: house to the right of the track, where the translation
adds to the rotation for a cyclonic tornado). The tornado holds its preset's mature V_max and
R_max for the whole pass and moves in a straight line at the preset's translation speed. It
starts upwind at the nearest distance (at least 2·R_max) where every house's roof-height wind is
under 50 mph (at most R_enter, the detail zone's entry distance), and the pass ends once it is as far past the house (block center) as it started before it; then the
wind is calm and the pieces settle. The house feels exactly what a detail-zone house feels
(the Spec 01 wind on open terrain and the Spec 02 pressure deficit with APC venting); its
inside pressure starts equal to the outside, since it stood in the far field as it built up. The
funnel and the wind-lofted dust cloud are drawn as in Spec 06 (condensation funnel and
dust tracers; the funnel reaches the ground only when the pressure drop is large enough).

Decisions:
- Mature strength throughout, no lifecycle: the lab studies one building, and a lifecycle
  would make the result depend on when the tornado happens to arrive.
- Start where the roof-height wind is under 50 mph: below that nothing can fail (the weakest
  connection needs ~75 mph). The far field decays slowly (∝ r^−α), so a lower threshold would
  start an EF4 several kilometres out and add minutes of waiting with nothing happening.
- Open terrain: the lab house stands alone on open ground, so it gets no upwind roughness.

### Detail zone in town (slice B)

**One physics world per street row.** The detailed houses of a street row share one Rapier
world (ground, each house's slab and fixed body, and every loose piece), so debris from one
house hits the next house and those impacts load its connections like any other contact.
Rows are separate worlds (see Detail zone performance).

**Which houses.** The user picks a spot in town; until they do, there is no detail zone (the
whole town runs on the component model at full speed). The N_max = 30 houses nearest that spot are the detail houses
(about as many as can be torn apart at once near real time, ~1–2 ms each per step). Each
enters the zone once the tornado's center is within R_enter = 4·R_max + 20 s × translation
speed (well before it feels damaging wind, so the hand-off is normally invisible), nearest
the tornado first and at most 3 per step (spreading the build cost). A house leaves the zone
once the tornado has passed it: it is behind the tornado (relative position against the
direction of travel) and farther than R_exit = 6·R_max, or the tornado has dissipated. A house
that has left stays detailed: its pieces keep simulating until they come to rest (or for 20 s
at most), then freeze in place with their final state; a house that left untouched goes back
to the component model. Moving the spot applies at the next step; houses already detailed
stay. Selection uses only the tornado state and the spot, so it's deterministic.

**Light pieces.** A loose piece lighter than 40 kg, a single member (shingle, glass shard,
sheet, drywall, trim, door) or a small nailed-together chunk (a roof sheet with its shingles),
leaves the rigid-body world 0.5 s after it tears free, once it is airborne high enough to
tumble freely (center above half its length + 0.5 m) or at rest (kept exactly as it lies), small
(under 1 m: laying it flat is barely visible), or sliding flat on its face (within 5°; never while tumbling or rolling along the ground, which the debris
model would lay flat at once), and flies on the
Spec 04 debris model (tumble-averaged drag and lift, ground contact, stepped at 60 Hz so its
motion stays smooth on screen), keeping its shape,
position, velocity and orientation. The tear-off itself stays fully simulated; afterwards it
no longer collides with other pieces or houses (like the town's debris until Phase 6).
Structural members (wall frames, rafters, interior walls, gable ends, the garage door) and
every multi-member chunk stay rigid bodies. This keeps a torn-apart house at ~30 rigid
bodies instead of ~650.

**Hand-off from the component model.** A detailed house is built from its framing, minus the
members of any components that already failed in the component model:

| Failed component | Members removed |
|---|---|
| Siding of a panel | that panel's wall sheathing |
| Window pane | its shards |
| Garage door | the garage door |
| Roof covering section | the shingles in that section |
| Roof deck section | the roof sheets in that section (and their shingles) |
| Roof bay | its column's rafter pairs, roof sheets, shingles, ceiling, fascia segments over it |
| Wall panel | its frame, sheathing, drywall, panes, doors and trim |
| Interior partitions / core room | the matching share of interior walls / the bathroom walls, with their doors |
| Slab swept | everything |

Whatever is left without support falls at once (the component model's state already had it
down). From then on the component model skips the house and spawns no component debris for
it; the house's loose members are its debris.

**Wind.** Envelope pressures use the Spec 01 wind at the house's roof height (as the
component model does), plus the atmospheric pressure change: outside, the tornado's pressure
deficit; inside, the deficit vents in with the Spec 02 time constant (2 s sealed, 0.05 s once
any envelope opening exists). The difference pushes every envelope member outward. Loose
members feel the full 3-D wind field (including updrafts) at their own position.

**Calm skip and rate.** An attached house whose roof-height wind is under 55 mph, with no
impact on any member and an APC difference under 100 Pa, skips the load-path solve: nothing
can fail there (checked for every class and direction: the first failure, aged shingles on a
weak house, needs 66 mph; 55 mph leaves ~30% margin on load). Otherwise the attached
structure is checked at 30 Hz, like the component model (wind loads change over tenths of a
second), houses on alternate steps; a house that something hits is checked that step.

**Survey.** A detailed house's DOD uses the component-model rules (Spec 03) applied to its
members:

| DOD | Condition |
|---|---|
| 1 | any wall sheathing lost |
| 2 | any shingle patch lost |
| 3 | any window broken |
| 4 | ≥ 20% of shingles lost, any roof sheet lost, or the garage door gone |
| 5 | not represented (the wall frames aren't tied into one box that could slide off the slab); reached with DOD 6 |
| 6 | ≥ 1/3 of rafter pairs gone |
| 7 | ≥ 50% of wall frames down |
| 8 | ≥ 75% of wall frames down and every interior wall except the bathroom's |
| 9 | every wall frame and interior wall down |
| 10 | slab swept clean: every member gone and nothing resting on the slab |

**Worker and timing.** The shared world runs in a Web Worker at 60 Hz (every second step of
the 120 Hz sim). The sim sends each detail step with the tornado state and the zone changes,
in order; the worker returns member poses for anything moving, survey results and failures.
The sim never runs more than 0.25 s of sim time ahead of the last detail step the worker
finished: when the detail physics is heavy, the whole simulation slows down rather than the
houses lagging behind the tornado. The same seed gives the same detail results whatever the
frame timing (steps are processed in order with their own inputs).

**Rendering.** Detailed houses are drawn member by member (the Spec 06 house drawing hides
them); intact houses' members are placed once, and only moving members are updated per
frame. With damage colors on, their outer finish (siding, shingles) takes the house's DOD
color, as the component houses do; bare sheathing and framing keep their materials.

### Detail zone performance (Phase 5 follow-up)

Goal: the 30-house core passage at or near real time, without fewer houses or coarser
members. Measured before (one worker, per 1/60 s detail step at the core): ~95 ms, of which
Rapier ~38 (1,600 awake bodies, ~1,000 of them barely moving on the ground), wind on rigid
pieces ~20, load checks ~15, light pieces ~7, bookkeeping ~15. After: ~50 ms of work per step
in all (awake bodies ~700–900), spread over 8 street-row groups; the costliest group averages
~11 ms (STR-30), and in the browser with 6 workers the sim holds 0.8–1.0× real time through
the core passage (it was 0.2–0.3×).

**Bookkeeping.** Member poses sent to the screen are computed from each body's (or light
piece's) pose read once, and lost members are reported only when the count changes.

**Rapier SIMD build.** The same engine version built with WebAssembly SIMD (ADR 0003): ~40%
faster solver, same behaviour; runs are deterministic within the build.

**Wind on rigid pieces.** Each member's plate normal, area and offset are fixed in its body's
frame, so they're computed once when the body is made, not from the member's world pose every
step. Results are the same as before.

**Resting rubble.** A rigid piece that has been still (speed under 0.1 m/s, spin under
0.1 rad/s) for 0.5 s while touching only the ground, a slab, other rubble or other still
pieces becomes fixed in place, exactly where it lies (a light piece at rest moves to the
debris model instead, as one Rapier put to sleep does): real debris at rest doesn't tremble,
and Rapier no longer solves it. A piece leaning on a standing house stays a body, so its
weight keeps loading the structure (Rapier has no contact between two fixed bodies). It comes back to life, with zero velocity, when
- the wind on it could move it (lift above its weight, or sideways force above friction),
  checked 4 times a second, as for resting light pieces;
- a moving piece hits it (a contact force event above the impact threshold); or
- a piece it touches comes back to life (a pile wakes together: a piece resting or leaning
  on another may lose its support).
Moving pieces still hit and pile onto rubble, and impacts on it are reported as before.

**Entry without a stall.** Building a house's colliders (~1,150) takes ~30 ms. Entering
houses are built over several steps, at most 400 colliders per step in total, in entry order
(a count, not a time budget, so runs stay deterministic). A house is loaded and can fail only
once complete; it enters ~20 s before the tornado's damaging winds reach it, so this delay is
never visible.

**Physics groups and workers.** Each street row (the houses on one side of one street within
a block, up to 8) is its own physics group with its own Rapier world. Groups step
independently with the same tornado state, so they run in parallel on several workers
(as many as the CPU allows, up to 6; at least 1), and the results don't depend on how many
workers there are. Pieces from one house still hit its side neighbours (10 m apart); they
don't hit houses in other rows (41 m across the street, 69 m back to back) until Phase 6
(debris impacts). The sim waits for the slowest worker under the same 0.25 s lead rule.

## Interface

```ts
// src/core/structure/framing.ts (pure)
function buildFraming(b: Building): Framing;  // members + connections (DAG to the slab)
// src/core/structure/loadpath.ts (pure)
function solveLoadPath(f: Framing, forces: Vec3[], intact: boolean[]): { loads: number[]; failed: number[] };
function detachedGroups(f: Framing, intact: boolean[], attached: boolean[]): number[][];
// src/core/structure/aero.ts (pure)
function plateForce(...): Vec3;
// src/sim/structureLab.ts
class StructureLab { step(): void; setWind(mph, dirDeg): void; startTornado(pass): void; ... }
```

## Acceptance criteria

- **STR-01**: The framing has the specified members (studs at 0.6 m, sheathing covering each
  wall panel and roof slope, rafters at 0.6 m on both slopes), all inside the house envelope.
- **STR-02**: The connection graph is acyclic, and every member has a path to the slab.
- **STR-03**: Load-path equilibrium: with no failures, the sum of loads delivered to the slab
  equals the sum of external forces on the house (±1e-6 relative).
- **STR-04**: Equal sharing: a member with n intact supports passes 1/n of its load to each.
- **STR-05**: A connection loaded past its capacity fails, and exactly the members that lose
  every path to the slab are detached, grouped by their remaining connections.
- **STR-06**: Plate aerodynamics: the normal force is zero for a plate edge-on to the wind,
  maximal face-on, and always along the plate normal.
- **STR-07**: In the lab, a standard house in rising steady wind loses roof members (rafters or
  roof sheathing) before any wall frame comes off its sill, and once the wind stops every loose
  member comes to rest on the ground (never below it), with none lost.
- **STR-09**: Cladding connections are checked with local pressures and framing connections
  with area-averaged pressures; wind loads the deck only where its shingles are gone; interior
  walls carry no wind until the envelope is mostly gone.
- **STR-10**: Inertial relief: inside a free-flying group, member loads are the external
  force minus each member's share of the group's acceleration (translation and spin), so they
  sum to zero and vanish when force per mass is uniform; in the lab, flying sections tear apart
  in flight from wind and spin alone, without an impact.
- **STR-11**: The house has a front and a back door in real openings (no sheathing over
  them), and an interior door or cased opening into every room: from the front door, every
  part of the floor is reachable without passing through a wall. Interior walls don't
  intersect each other or the exterior walls.
- **STR-12**: Glass breaks under pressure in either direction; a broken pane falls apart into
  its 18 triangular shards, each a separate loose piece.
- **STR-13**: Zone selection: only the N_max houses nearest the chosen spot are detailed; each
  enters once the tornado is within R_enter (nearest the tornado first, at most 3 per step);
  a house leaves once the tornado is past it (behind, beyond R_exit) or has dissipated, and
  never re-enters. No spot → no detail. Same tornado history → same zone history.
- **STR-14**: Hand-off: an undamaged house enters with every member attached; a house entering
  with failed components starts without exactly the mapped members, and the component model
  no longer updates it or spawns debris for it.
- **STR-15**: Tornado wind: envelope loads use the wind at roof height and the vented
  pressure deficit (sealed house: outward push grows as the deficit arrives, then relaxes
  as it vents); loose members feel the wind at their own position.
- **STR-16**: The survey DOD of a detailed house follows the table above.
- **STR-17**: Shared world: a loose member from one detailed house can hit another detailed
  house in its street row, and the impact is added to the hit member's load.
- **STR-18**: The sim never runs more than 0.25 s ahead of the detail physics, and two runs
  with the same seed but different frame timing give identical detail failures.
- **STR-20**: A light loose piece hands off to the debris model without a jump (except a piece
  under 1 m on the ground, which may be laid flat): its pose and velocity are continuous
  across the hand-off (up to one step of its own acceleration and
  spin), and once the wind has passed a torn-apart house keeps under 60 rigid bodies.
- **STR-19**: Calm skip: below 55 mph with no impacts and small APC, skipping the solve gives
  the same result as solving (no failures), for every construction class.
- **STR-26**: Resting rubble: a still rigid piece touching only the ground, a slab, rubble or
  still pieces (not a standing house) becomes fixed
  exactly where it lies after 0.5 s; wind that could move it, an impact, or a piece it touches
  waking brings it back to life with zero velocity.
- **STR-27**: Wind on rigid pieces from body-frame plates equals the per-member world-pose
  computation (relative difference under 1e-9).
- **STR-28**: Entering houses are built over several steps (at most 400 colliders per step);
  an incomplete house carries no loads and doesn't fail; the completed house has the same
  members and colliders as one built at once.
- **STR-29**: Each street row is its own physics group; the same run with the groups spread
  over 1 or 3 workers gives identical results.
- **STR-30** *(validation)*: Over a 30-house core passage, the costliest physics group's
  detail step averages under 16 ms (real time when groups run in parallel).
- **STR-31**: Roof follow-through: the along-ridge roof pressure is measured from the windward
  edge of the roof still standing (the last rafter pair before a gap of more than 1.5 bays, or
  the gable); in a rising wind from any direction, a lab house goes from a third of its rafter
  pairs gone to two thirds, and from there to half its wall frames down, within ~15 mph each.
- **STR-24** *(validation)*: Standard detailed houses passed through simulated strong
  tornadoes (the Spec 03 calibration cases) reach each DOD at a Kaplan–Meier median peak wind
  within ±10% of the DI 2 expected value (DOD 5, not represented, is reached with DOD 6), on a
  sample of 128 houses.
- **STR-25**: Load-path mechanics: a braced wall sends half its out-of-plane load to the
  diaphragm and an unbraced one fails by overturning at the base-moment capacity (more with a
  standing neighbor); rafter hold-downs fail by their neighborhood's mean demand; the roof
  MWFRS coefficients follow the table; siding feels no APC; a house enters in APC equilibrium;
  connection variability is deterministic per house.
- **STR-08**: The lab is deterministic: same wind history → same failures.
- **STR-21**: Lab tornado pass: the tornado starts upwind where the house's roof-height wind is
  under 50 mph (at least 2·R_max and at most R_enter away), moves in a straight line at its translation speed with
  constant mature V_max and R_max, and the house's wind and outside deficit equal the Spec 01
  wind (open terrain) and Spec 02 deficit for that tornado state, with no APC jump at the start; the pass ends once the
  tornado is behind the house and as far away again, and the wind is then calm.
- **STR-22**: A lab tornado pass is deterministic: same preset, heading and offset → same failures.
- **STR-23**: The lab builds N houses (1–12) in a grid of ⌈√N⌉ columns at 28 m spacing centered
  on the origin, in one shared world; a pass starts where every house's roof wind is under
  50 mph.

## Simplifications / out of scope (slice A)

- Slice A: one house, steady straight-line wind. Slice B: the detail zone in town.
- Component-model debris (houses outside the zone) passes through detailed houses without
  colliding (debris impacts are Phase 6).
- A house that was shifted off its foundation in the component model enters unshifted.
- Wall frames are one group per panel; studs don't break individually.
- DOD 5 (house shifted off its foundation) isn't represented: the wall frames aren't tied into
  one box that could slide.
- Rigid pieces don't hit houses or pieces in other street rows (separate physics groups)
  until Phase 6.
- Light pieces fly without turbulence; they land on their own house's slab or the ground (not
  on other pieces or other slabs).

## Changelog

- v0.14: detail steps can carry launches (`DetailStep.launches`, Spec 12): the listed members of a
  house become one free body at a point with a velocity, through the same body-making code as
  members torn loose, with their contacts counting at once; an entering house may name its
  physics group (default: its street row).
- v0.13: roof follow-through (STR-31): the along-ridge roof suction zones are measured from the
  standing roof's windward edge, not the original gable. Before, once the windward part of a
  roof was gone the rest sat in the mild −0.3 zone and stayed up ~30 mph longer than DI 2 says
  (DOD 6 → DOD 7: 122 → 132 mph); walls, braced by whatever roof remained, stood with it.

- v0.12: wall-to-sill nailing at its mean ultimate (6.5 kN/m, was 4 kN/m, a design-level value),
  at the user's request to make detailed and town houses look alike. Before, a wall frame tore
  off its sill under roof uplift before the roof's toe-nails let go, and the whole house came
  down in one step (DOD 7 at ~97 mph in some houses). Validation (STR-24, 128 houses) now:
  DOD 1–6 within 5%, DOD 9 +3%, DOD 10 −1%, but DOD 7 +20% and DOD 8 +11% (outside ±10%):
  walls only lose their bracing as the rest of the roof comes off, which the detail model
  spreads over ~30 mph (DI 2: ~10 mph). Wall base moment (1.3–2.5 kN·m/m) makes no difference.
  Open: how fast the rest of a roof follows once part of it is gone. Light pieces hit and stop
  at the houses around the zone (Spec 10 v0.6–v0.9); glass breaks by impact (Spec 10 IMP-21);
  soft CCD on loose pieces; fixed shapes in one collision group.

- v0.11: detail zone performance at the user's request (keep the detail, make it faster):
  Rapier SIMD build, body-frame wind on rigid pieces, resting rubble, entry spread over steps,
  a physics world per street row run on several workers (STR-26–30). Pieces no longer hit
  houses in other street rows until Phase 6. STR-24 now uses 128 houses: with 64 a DOD's median
  moved ~±5% between runs that differ only in rounding (chaotic tumbling), enough to cross the
  limit (DOD 7: +5% → +11% from rounding alone; +6% on 128).
- v0.10: no detail spot by default; the user picks one. With the default spot on the town
  center, every run tore 30 detailed houses apart at the start and played in slow motion.
- v0.9: slice C, validation against DI 2 in tornado passes (STR-24, STR-25). Physics added
  or fixed while validating: ASCE 7 MWFRS roof pressures; ceiling-joist toe-nails; gable bottom
  plate nailed along its length, braced through the roof diaphragm; code anchor-bolt spacing;
  sill plates as their own members; vinyl siding with a vented cavity; diaphragm bracing and
  overturning of unbraced walls, with neighbor and corner bracing; free-standing loads on an
  opened house's exterior walls and drag on exposed framing; interior shelter and box action;
  roof load sharing between rafters; house-wide and per-connection variability. Fixed: houses
  started with the full tornado pressure deficit as an instant APC push (popped ceilings at
  ~50 mph); an end wall counted as braced by the gable sitting on it. DOD 5 dropped from the
  survey (frames can't slide as one box). Calibrated within published ranges: shingles 1.8 kPa,
  siding 0.4 kPa, rafter toe-nails 2.5 kN; interior box share and wall base moment.

- v0.8: lab house count (1–12, STR-23) at the user's request, with a measured cost limit.

- v0.7: tornado pass in the lab (STR-21, STR-22), at the user's request: a preset tornado
  crosses the lab house on a chosen track, with the detail zone's wind and pressure deficit.

- v0.6: slice B written and approved: shared world, zone selection, hand-off, tornado wind
  and APC, calm skip, survey, worker with bounded lead (STR-13–19). Revised the same day after
  profiling: 120 houses torn apart at once left ~50,000 pieces (240 ms per step vs 16 ms);
  the user chose detail around a spot they pick (30 houses); light pieces move to the
  Spec 04 model after tearing free (STR-20).

- v0.5 (cont.): wall sheets are notched around openings (L/U-shaped, as builders cut them)
  instead of leaving seams and slivers at opening edges; casing; corner framing fixed (frames
  overlapped at corners); slab sized to the walls. Physics fixes after the user saw debris
  dancing at zero wind and flickering on the ground: colliders shrank 5 mm through the
  thickness too (12 mm sheets collided 4 mm thick), collider mass came from the unshrunk
  volume (thin parts 1/3 too light), no rotational drag, and every resting piece was woken
  each step so none ever slept.
- v0.5: real floor plan (garage, living room, kitchen, hallway, three bedrooms, bathroom,
  walk-in closet) with interior doors; front and back doors; framed rough openings cut
  through studs and sheathing; drywall on the inside of exterior walls; glass that shatters into shards (STR-11, STR-12), all after
  user review. Fixed: panes and the garage door could only fail outward (their connections
  treated inward pressure as bearing on the frame), which hid the classic windward failures; loose drywall (wall and ceiling) had no air drag
  and fell like a brick, now it flies as a plate.
- v0.4: in-flight breakup by inertial relief (STR-10), after the user saw large chunks fly
  off intact; before, flying groups only broke on impact.
- v0.3: triangular gable sheathing, ceiling drywall, eave fascia (user review).
- v0.2: shingles, gable ends, ceiling joists with ceiling mass, interior walls (user review);
  local vs area-averaged pressures (STR-09).
- v0.1: slice A written and approved.
