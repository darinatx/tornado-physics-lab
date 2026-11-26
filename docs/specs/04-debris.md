# Spec 04 — Debris

Status: Approved (v2.7) — flight, landing, re-lofting; heavy pieces as rigid bodies; hits on houses per Spec 10

## Purpose

Turn failed building parts into flying pieces with real mass, size and aerodynamics, so you
can see what a tornado does with roofs and walls, and so Phase 4 can compute what those pieces
hit and how hard.

## Model

### Piece types

Every piece is one real object with realistic size and mass. Three aerodynamic families,
following the debris classes in the wind-engineering literature (Wills, Lee & Wyatt 2002;
Tachikawa 1983):

| Kind | Family | Size (m) | Mass (kg) | C_D·A (m²) | C_L·A (m²) | Source part |
|---|---|---|---|---|---|---|
| Shingle | sheet | 1.0 × 0.33 × 0.005 | 1.0 | 0.23 | 0.066 | roof covering |
| Siding strip | sheet | 3.8 × 0.25 × 0.003 | 1.5 | 0.67 | 0.19 | siding, walls |
| OSB sheathing | sheet | 2.4 × 1.2 × 0.012 | 16 | 2.0 | 0.58 | roof deck, roof, walls |
| Garage door panel | sheet | 2.4 × 0.55 × 0.04 | 12 | 0.92 | 0.26 | garage door |
| Rafter (2×6) | rod | 3.6 × 0.14 × 0.04 | 8 | 0.35 | 0 | roof structure |
| Stud (2×4) | rod | 2.4 × 0.09 × 0.04 | 4.5 | 0.15 | 0 | walls |
| Glass shard | compact | 0.15 × 0.15 × 0.005 | 0.25 | 0.018 | 0 | windows |
| Wall chunk | compact | 0.5 × 0.5 × 0.15 | 18 | 0.2 | 0 | walls, slab |

C_D·A for sheets and rods is averaged over random tumbling: 0.7 × length × width (about 0.64
of the plan-view area times C_D ≈ 1.1). Compact pieces use 0.8 × face area. Sheets autorotate,
which gives them lift, C_L·A = 0.2 × length × width (C_L ≈ 0.3, tumble-averaged), at right
angles to the relative wind with a random spin sense.

### Flight

```
v_rel = w(x) − v                          w from windAt (Spec 01)
F = ½ρ·(C_D·A)·|v_rel|·v_rel             drag
  + ½ρ·(C_L·A)·|v_rel|²·ê_L              lift (sheets), ê_L ⟂ v_rel
  + m·g                                   gravity
```

Integration is semi-implicit in the drag term, so it stays stable even for light, draggy
pieces like shingles at the physics step:

```
k = ½ρ·(C_D·A)·|v_rel| / m
v' = (v + dt·(g + F_lift/m + k·w)) / (1 + k·dt)
x' = x + v'·dt
```

The spin rate is ω ≈ 0.6·|v_rel| / L for sheets, 0.4·|v_rel| / L for rods and 0.3·|v_rel| / L
for compact pieces (Tachikawa's autorotation measurements). It drives the visual tumbling.

### Turbulent dispersion

The wind field (Spec 01) is a smooth mean flow, so every piece from one house would follow the
same streamlines and land on one line. Real near-ground wind gusts by 20% (open), 30%
(suburban) or 40% (urban) of its mean speed (over a roughness field, read at the piece's local
z₀, Spec 17). Each flying or sliding piece therefore feels its
own gust, a first-order random process (Ornstein–Uhlenbeck) with that intensity, a 2 s
correlation time and half the intensity vertically, using the pool's seeded RNG. Tumbling
sheets also get a random lift roll of up to ±90° about the relative wind, since their spin
axis has no preferred orientation, so their lift pushes sideways as well as up. Together these
fan a house's debris out downwind instead of leaving a thin streak.

### Ground

- Pieces never go below the ground: contact is at the piece's lowest corner given its size
  and current tilt, not its center, so a tumbling 4 m panel doesn't sink in. On landing they bounce a little (restitution 0.2) and
  lose horizontal speed to sliding friction (μ_k = 0.5).
- Landed debris snags on grass, crops, fences and other debris, so it takes more to start it
  moving than to keep it moving: a resting piece holds unless drag beats μ_s·(m·g − F_up)
  with μ_s = 1.2. It lifts off again when the upward aerodynamic force F_up beats its weight.
  A sliding piece comes to rest once it's slow and the holding force can keep it.
- **Drag on the ground.** A piece lying or sliding on the ground is pushed by the area its box
  actually shows the wind (its projection across the flow, C_D 1.2), plus skin friction on its
  top face (C_f 0.05 × length × width); never more than its tumbling average. A wall panel or
  sheet lying flat shows the wind only its edge; a 2×4 lying end-on, only its end. (Airborne
  pieces keep the tumble-averaged drag.)
- **Lift on the ground.** A sheet lying or sliding on the ground gets suction lift over its
  top face, ½ρ·(C_L·A)·|v_rel,h|², always upward (as in the resting rule), whichever way it
  would tumble in the air. When that lifts it clear, the wind has got under its leading edge,
  which pitches it nose-up: it leaves the ground tumbling in the sense that gives upward lift
  (spin +1; the initial angle of attack sets an autorotating plate's spin, Tachikawa 1983). A
  piece on the ground feels the wind 0.2 m above the ground (above a slab top on a slab), like
  resting pieces; the wind at its own few-millimetre height would be the profile's floor value.
- **Rough ground.** Real ground isn't flat: clods, furrows, grass tufts, ruts, curbs and other
  debris. A sliding piece runs over a bump with probability 1 − e^(−d/λ_b) over a slide of
  distance d (bump spacing λ_b = 1 m open, 1.5 m suburban, 2 m urban; over a roughness field,
  read at the piece's local z₀, Spec 17). Each bump is a ramp of
  slope tan θ drawn uniformly from 0 to 0.4 (up to ~22°). The piece is deflected along it: it
  keeps the speed along the ramp and loses the part into it (no rebound), so
  v_up = v_h·cos θ·sin θ and v_h → v_h·cos²θ; a piece longer than a bump (1 m) pivots over it
  on its trailing edge, so its center rises at half that rate. Its leading edge rides up first, so it leaves
  nose-up, tumbling in the upward-lift sense (spin +1), as on any lift-off from the ground.
  Bumps both slow sliding debris (like extra friction) and hop it into the wind: if the wind
  can carry it, it flies on; otherwise it lands again. The same applies to light pieces from
  detailed houses (Spec 09), with a per-house seeded RNG.
- **Tumbling starts clear of the ground.** A piece only autorotates once its lowest point is
  half its own length above the ground: rotation needs room, and close to the ground a plate
  rides on the air under it. A short hop over a bump keeps the piece's attitude instead of
  spinning it through a big angle and snapping it flat on landing ("flapping").
- **Snagging:** light pieces (shingles, siding) can be pushed along by even moderate
  ground-level wind, and in reality they travel until they catch on a fence, crop row, shrub
  or other debris. A sliding piece snags with probability 1 − e^(−d/λ) over a slide of
  distance d, with mean free path λ = 30 m (open), 15 m (suburban), 8 m (urban; over a roughness
  field, read at the piece's local z₀, Spec 17). A snagged
  piece is pinned against its obstacle by the wind: it's released only when the wind swings
  around to pull it back the way it came (and drag beats the holding friction), or when the
  wind lifts it over. A passing tornado's wind turns about 180°, so pinned debris moves in
  short hops rather than riding along with the vortex.
- **Debris field:** resting pieces more than 3·R_max from the tornado can't be moved by the
  ground-level wind there, so they move to a permanent debris field: drawn, never simulated
  again, and never recycled (up to 150,000 pieces). Each piece is drawn once: drawing settled
  pieces as several copies (tried first) made one landing piece look like several; the
  component rubble supplies the real density instead. This keeps the whole damage path's debris
  visible while freeing the active pool.
  Resting pieces are re-checked at 30 Hz, and only within 6·R_max of the tornado.

### Spawning from components (Phase 4)

Each failed component releases pieces shaped and placed like itself, so what leaves the
house is what you saw fail:

| Component | Released as |
|---|---|
| Siding on a wall panel | 1 siding strip torn off that panel's face (stands for ~12) |
| Roof covering section | 2 shingles from that section |
| Roof deck section | one sheet the size of the section (deck + covering), 10 kg/m² |
| Roof bay | one roof panel per slope with its sections' size and pitch, 18 kg/m², or 2 bare rafters per slope if the deck was already gone |
| Window pane | 2 glass shards at the pane |
| Garage door | one door panel, 12 kg/m² |
| Wall panel | one wall panel of its size, 25 kg/m², tipping in its fall direction |
| Partition | 2 studs and 2 wall chunks (shards: 10 studs, 5 chunks), and the wall itself as panels of at most 4 m where it stood, tipping over in the wind's direction (v2.4) |
| Core room | 2 studs and 3 chunks, and its four walls as panels, tipping over in the wind's direction (v2.4) |
| Slab swept | 4 studs and 6 chunks; everything lying on the slab is carried off (v2.3) |

Pieces with house-specific sizes compute drag and lift from their own dimensions (same
formulas as the table above).

**Launch:** a roof section or deck panel that fails in uplift (not one that collapsed because a
bearing wall fell) leaves moving: upward at √(2·a·0.5 m) with a = net uplift force / mass, and
downwind at 0.3 × the wind's horizontal speed. It tears away and tumbles into the storm.

**Rubble:** if the wind at the moment of failure can neither lift a piece nor overcome its
holding friction (and it isn't a launched roof piece), it doesn't fly: it drops beside or onto the house (a wall panel falls flat
in its fall direction; roof pieces land on the slab) and goes straight into the debris field.
That's where much of a destroyed house's material ends up. If the active pool is completely
full of flying pieces, a component piece is placed as rubble rather than dropped. Heavy pieces
(v2.4) are never placed: they fall from where the component stood (see Heavy pieces).

**Mass bookkeeping:** every component has a mass, and each house's failed mass is split into
rubble, ground debris, flying debris and lofted debris.

### Far from the core (v2.2)

A flying piece more than `farStepRmax` (1.5) core radii from the tornado's center is advanced on
every other debris step (30 Hz), by the time since it last was; on alternate steps by its id, so
half of them are stepped each time. The wind out there changes over seconds, not tenths. A piece
that comes nearer is stepped every step again.

Decision: at the light-debris peak of an EF5 (~3,000 flying pieces, 83% of the sim's compute),
96% of the flying pieces are beyond 1.5 core radii.

### Heavy pieces are rigid bodies (v2.0)

A piece of at least **40 kg** that stands for one real object (a wall panel, roof section, deck
section, garage door, a heavy chunk) doesn't use the point model above. It is a rigid box of its
own dimensions in the **heavy-debris world**, a physics world (Rapier) stepped with the debris
step on the sim thread, the same treatment the detail zone gives its members above 40 kg
(Spec 09):

- **Wind:** the plate force on the box's face at its own position and velocity, with rotational
  drag (Spec 09's loose-member aerodynamics, `rigidAero`), from the mean wind at its center.
- **What it meets:** the ground, every slab, the standing walls, roof sections and gables of
  the houses near it (Spec 10's town colliders, with holes at broken windows and doors; a
  detailed house as its stand-in), and the other heavy pieces: it lands, slides, catches,
  leans and stacks with contact friction 0.6. Light pieces don't meet it.
- **Its own house:** it starts where the component was, with the launch velocity above, and
  falls from there (v2.4: never placed where it would land). A wall panel or garage door tips
  about its base edge in its fall direction, its top edge starting at 1.5 m/s; a roof piece
  whose bearing wall fell drops from the roof. For its first 0.5 s it passes the walls and roof of its own house
  that it overlaps when made (it is tearing away from them), and only while it still overlaps
  them; the rest of its house and its own slab stop it from the start.
- **Hits:** contact with a house's wall, roof or gable is an impact on that surface (Spec 10),
  with the body's mass and the normal speed from the contact impulse, ignoring the source house
  for the first 0.5 s and resting contact.
- **Snagging (v2.4):** a body sliding on the ground (not a slab) catches on a fence, tree,
  shrub, curb or other debris as light pieces do: with probability 1 − e^(−d/λ) over a slide of
  d, λ = 30 m open, 15 m suburban, 8 m urban (each body's distances drawn from its own seeded
  stream). A snag stops its horizontal motion into the obstacle and pins it there: it moves
  again only away from it (the wind swung round), or once it is lifted 0.5 m clear (over it).
- **Rest:** a body still (below 0.1 m/s and 0.1 rad/s) for 0.5 s that the wind can't move is
  put to sleep (the detail zone's rubble rule: the wind would keep nudging it awake). It stays
  put until the wind on it could lift it or push it past friction (μ 0.6), then wakes. It is
  retired into the permanent debris field where it lies once it has slept 2 s and the tornado
  has passed it (behind the center, beyond 1.5·R_max), or the tornado is beyond
  `settleRangeRmax`·R_max; at most 400 bodies at once (past that the longest-resting sleepers
  retire). A sleeping body keeps only the houses it lies on or against as colliders.
- **Stepping:** Rapier's soft CCD reaches past how far each body can move in a step, spin
  included (as the detail zone's loose bodies); 8 solver iterations.
- **Bookkeeping:** it is a piece like any other (mass ledger, rendering, pass-through checks);
  the point model skips it while it is rigid.
- **Swept slab (v2.3):** when a town house's slab is swept (DOD 10), what lies on it is carried
  off (counted as swept mass). From v2.4 heavy pieces lying on it are first woken and given 2 s
  (walls still toppling and pieces still moving settle, and the wind gets its chance); those
  still lying on it then are carried off. What is carried off: its own rubble, any house's pieces lying there in the permanent
  debris field (retired heavy ones included), heavy pieces at rest or creeping on it (below
  3 m/s) in the heavy world, and its own heavy pieces still falling or sliding over its slab
  (any speed, below its roof's top), including those that failed in the same step as the sweep. Light pieces still in the active pool are left to the point
  model, which re-checks resting pieces against the wind. "On it" is the slab's footprint and below 1.5 m above its top, as
  Spec 09's DOD 10 survey. Heavy pieces moving faster are left to the wind.

**Where it runs (v2.1):** the heavy-debris world runs in a Web Worker in the app (in-process in
tests and tools), beside the sim, like the detail zone (Spec 09). Each debris step the sim
sends it the step's tornado, the new heavy pieces (dimensions, mass, pose, velocity, house) and
the houses whose state changed since it last sent them (Spec 10's town states; a detailed house
as its stand-in); the engine keeps its own copies of the houses. It returns each moving piece's
pose and velocity, which pieces came to rest, woke or were retired, and the hits on houses. The
sim applies a step's results **8 debris steps (0.13 s) after it**, whatever the worker's timing,
and never runs further ahead than that (it slows down instead): a new heavy piece stays where it
appeared for 0.13 s, then moves, always 0.13 s behind; its hits damage houses 0.13 s late. Same
seed and inputs → same results in-process, in a worker, or lagging by a varying amount.

Decisions:
- **Heavy pieces fall where they stood, and snag (v2.4):** at the user's report that walls
  vanished or reappeared flat on the ground: failed walls were placed straight where they
  would land (a point-model shortcut). As rigid bodies they can tip over instead. Snagging is
  the point model's rule for sliding debris; the heavy world's ground was a flat plane with
  nothing to catch on.
- **No suction lift on heavy pieces lying flat (v2.4, the user's choice):** tried with the point
  model's sheet rule (C_L·A = 0.2·L·W at the 0.2 m wind, at the upwind quarter, only on
  contact). It tipped panels into the wind in EF3+ winds and they flew with the storm: in the
  alignment patch 3% of failed mass within 5 m and 58% of heavy mass still moving at the end,
  even with snagging; an EF5 grew to ~4,500 moving bodies, about twice the cost at the peak.
  The flight is likely physical (wind-borne debris studies, e.g. Wills et al. 2002, put loose
  panels' flight threshold lower still), but the detailed houses' loose members lack it too.
  The user chose rubble near houses and speed. Without it a panel lying flat gets no lift
  (zero angle of attack), so the swept slab's carry-off after 2 s remains.
- **A swept slab takes heavy pieces too (v2.3):** since v2.0 heavy rubble left the rubble list
  the sweep clears, so EF5 slabs rated DOD 10 kept their wall panels and roof sections. A flat
  panel on a slab shows the wind little area, and the 400-body cap retires sleepers to the
  permanent field, so the wind alone leaves them there. The sweep's threshold is the load that
  carries the house's last contents off (Spec 03), so it carries off what lies on the slab too.
  The engine does it the step it learns of the sweep; pieces it retired in the lag before that
  are caught as their results arrive, so nothing depends on timing. Its own pieces still coming
  down over it go too: they are what is left of the house the sweep load acts on (before, 5
  panels torn off in the last 0.2 s before a sweep landed on 3 of 25 swept slabs in an EF5).
- **A worker, with a fixed lag:** the heavy world was up to ~65% of the sim's compute late in an
  EF5 (≈2,000 moving bodies), all on the thread that also draws. The lag keeps the run
  deterministic (the detail zone's mechanism); 0.13 s leaves room for 4× sim speed at 60 frames
  a second.
- **Same physics for heavy debris in both house models.** The paired comparison (Phase 6) showed
  destroyed town houses leaving ~1% of their material within 5 m against 20–48% for detailed
  ones: as points, 300 kg wall panels slid and skimmed with the tornado for ~1.3 km. A box with
  real contacts digs a corner, rests on other rubble, and catches on slabs and walls, as the
  detail zone's members do. 40 kg is the detail zone's own cutoff (DETAIL.lightKg).
- **On the sim thread, stepped with the debris step:** deterministic with no worker lag.
  Cost (EF4 through the default town, headless): ~1.2 ms per debris step at the peak (~900
  bodies, most of them flying); the sim's own compute rises from ~3.3 to ~5.6 s per 20 s of
  sim at the worst point. Without retirement, bodies piled up to 7,000 (4× the compute).
- **Mean wind, no gust model:** as for detailed members; gusts matter for light pieces.

### Spawning (Phase 3 representative sets)

When a part fails (Spec 03), it releases a representative set of pieces from where that part
is: the roof at roof height, walls between the ground and the eaves, windows on their face.
Each spawned piece stands for `represents` real objects, so totals stay physical (Phase 4 uses
this to compute hit rates).

| Part | Spawned |
|---|---|
| Siding & trim | 3 siding strips |
| Roof covering | 8 shingles |
| Windows (per face) | 4 glass shards |
| Garage door | 4 panels |
| Roof deck | 4 OSB sheets |
| Roof structure | 6 rafters, 6 OSB sheets, 6 shingles |
| Exterior walls | 6 studs, 4 siding strips, 3 OSB sheets |
| Most walls | 6 studs, 4 wall chunks |
| All walls | 6 studs, 4 wall chunks |
| Remaining structure | 4 studs, 6 wall chunks |

Pieces start at rest; the local wind picks them up.

### Budget

At most 3,000 pieces are simulated at once. When the pool is full, the oldest resting piece is
frozen in place into the debris field (never erased); if every piece is airborne, the new
spawn is skipped and counted. Pieces leaving
the 12 km map are removed.

**Lofted into the storm:** the core updraft (30 m/s by default) exceeds the falling speed of
light pieces (a shingle falls at about 8 m/s), so they climb. Real tornadoes do this: debris
shows up on radar kilometers high and falls out tens of kilometers downstream. Above the cloud
base this model has no storm flow, so pieces that reach it are removed and counted as
"lofted into the storm".

Debris is stepped at 60 Hz (every 2nd physics step); the semi-implicit drag keeps it stable.

## Interface

```ts
// src/core/debris/piece.ts
function stepPiece(p: Piece, w: Vec3, dt: number): void;   // flight + ground contact
function restingForces(p: Piece, w: Vec3): { drag: number; up: number; weight: number };

// src/core/debris/field.ts
class DebrisField {
  constructor(seed: number, cap?: number);
  spawnFrom(b: Building, rec: FailureRecord): void;
  step(dt: number, s: TornadoState, terrain: Terrain, checkResting: boolean): void;   // Terrain: Spec 17
  readonly pieces: readonly Piece[];
  readonly stats: DebrisStats;   // airborne, resting, skipped, maxSpeed, maxHeight
}
```

## Parameters

Piece table above; μ_k = 0.5, μ_s = 1.2, restitution 0.2, cap 3,000. Values live in `src/config/debris.ts`.

## Acceptance criteria

- **DEB-01**: In still air, every kind falls at its analytic terminal speed √(2mg / (ρ·C_D·A)) (±1%).
- **DEB-02**: In a uniform horizontal wind with gravity off, a compact piece's speed follows the
  exact quadratic-drag solution u(t) = U − U / (1 + U·k₀·t), k₀ = ½ρ·C_D·A / m (±1%).
- **DEB-03**: Lift: a sheet with upward spin sense carries farther before landing than the
  same sheet with lift switched off, and lift is perpendicular to the relative wind.
- **DEB-04**: Ground contact: pieces never go below the ground; a resting piece stays put when
  drag < μ_s·(mg − F_up) and F_up < mg, slides when drag exceeds that, and lifts off when
  F_up > mg.
- **DEB-10**: Snagging: sliding pieces snag at the specified mean free path (within 10% over
  many trials); a snagged piece stays pinned while the wind pushes it into its obstacle and is
  released when the wind reverses.
- **DEB-11**: Resting pieces beyond 3·R_max move to the permanent debris field unchanged,
  freeing the active pool; resting pieces near the tornado stay active.
- **DEB-12** *(validation)*: After an EF4 pass, the debris field's spread across the path
  (interquartile range) is at least 60% of its source houses' spread; heavy pieces (wall
  panels, lumber, wall chunks) travel a median under 150 m, and light sheets (shingles,
  siding) travel farther.
- **DEB-05**: Each failure spawns the specified pieces within the part's location (roof pieces
  at roof height over the footprint, window shards on their face), deterministically.
- **DEB-06**: The pool never exceeds its cap; a full pool freezes its oldest resting piece into
  the debris field (never erasing it) and counts skipped spawns.
- **DEB-07** *(sanity)*: In a tornado, no piece moves faster than the fastest wind it has met
  plus its terminal speed, with 20% margin for lift.
- **DEB-09**: Pieces that rise above the cloud base are removed and counted as lofted.
- **DEB-13**: In a steady uniform wind, debris from one house lands in a fan, not a line: the
  across-wind spread σ is between 8% and 40% of the mean downwind distance.
- **DEB-14**: Component spawning: each failed component releases the pieces in the component
  table, at its own position (and, for panels and roof pieces, its size and orientation).
- **DEB-15**: Rubble: a component whose piece the current wind can neither lift nor slide goes
  straight into the debris field next to its house; one that can move enters the active pool.
- **DEB-16** *(validation)*: Mass bookkeeping: rubble + ground + flying + lofted + skipped
  mass equals the failed component mass (±1%), and after an EF4 pass at least 35% of each
  destroyed house's (envelope) mass lies within 50 m of it. Only the envelope is modeled; real
  houses also leave floors and contents, most of which stay put.
- **DEB-17**: A roof section or deck panel leaves its house moving upward and downwind, with
  the upward speed set by its net uplift force.
- **DEB-18**: A sheet on the ground lifts off when its suction lift beats its weight, whatever
  its tumble sense, and leaves the ground tumbling with upward lift; below that it stays down.
- **DEB-19**: Rough ground: sliding pieces hit bumps at the terrain's spacing (within 10% over
  many trials); each bump keeps the speed along its ramp (v_up = v_h·cos θ·sin θ,
  v_h → v_h·cos²θ, θ up to atan 0.4; half the rise for pieces over 1 m) and leaves the piece
  tumbling nose-up; in a strong wind a light sheet that would only slide on flat ground gets
  airborne and carried off, while a heavy panel only hops and stays near where it was.
- **DEB-20**: A piece within half its length of the ground doesn't tumble (its orientation is
  unchanged by a low hop); higher up it tumbles at the specified rate.
- **DEB-21**: On the ground, drag uses the piece's projected area across the wind (C_D 1.2) plus
  skin friction on its top face: a flat-lying sheet gets far less drag than its tumbling
  average, a 2×4 end-on less than side-on, and a fallen 290 kg wall panel in a 60 m/s wind
  shuffles but stays near where it fell.
- **DEB-22**: Heavy pieces (≥ 40 kg, one real object) are rigid boxes of their dimensions in the
  heavy-debris world; lighter ones stay on the point model. A wall panel dropped on the ground
  in still air comes to rest lying on it, inside no slab and no other box; two dropped on each
  other stack.
- **DEB-23**: A heavy piece driven into a standing house's wall stops at it (no pass-through)
  and its hit is an impact on that wall (Spec 10); its own house's walls don't stop it for its
  first 0.5 s, its own slab does.
- **DEB-24**: Rubble stays: in the alignment patch on the town model (EF4, track 330 m from
  the patch, houses out to 130 m), the compared houses keep at least 15% of their failed mass
  within 5 m of their footprints (detailed houses there: 20–48%; before v2.0: 1%), and at least
  90% of the heavy pieces' mass has come to rest by the end. (The wind tunnel's uniform wind is
  no test of this: it blows everywhere at once, so even detailed houses keep ~5% there.)
- **DEB-25**: A resting heavy piece wakes only when the wind on it could lift it or push it past
  friction, and is retired to the permanent debris field once the tornado is out of range;
  same seed and inputs → identical heavy-piece poses.
- **DEB-26**: The heavy-debris world's results are applied 8 debris steps after their step: the
  same run gives identical heavy-piece poses and house damage with the engine in-process, run
  late by a varying amount, or (by the same code path) in a worker; the sim never runs more than
  8 steps ahead of it.
- **DEB-28**: A swept slab is clean: when a town house's slab is swept, no piece is left lying
  on it (footprint, below 1.5 m above its top) — heavy ones at rest in the heavy world, retired
  to the debris field before or during the 8-step lag, and any house's pieces in the permanent
  debris field, and the house's own heavy pieces over its slab below its roof's top at any speed — and
  their mass counts as swept; another house's heavy piece moving above 3 m/s and pieces beside
  the slab stay. From v2.4 heavy pieces lying on it are given 2 s of wind first.
- **DEB-27**: Flying pieces beyond 1.5 core radii are advanced every other step by twice the
  step: a cloud of pieces far from the core ends up where it does stepped every step (mean
  position within 2% of the distance travelled), and each piece is stepped on half the steps.
- **DEB-29**: A heavy wall panel that fails starts upright where it stood and tips about its
  base edge in its fall direction, coming to rest flat on the slab (fell in) or leaning off its
  edge (fell out) with no jump between steps of more than its speed allows.
- **DEB-31**: A failed interior wall (partition or core room) is released as wall-sized panels
  where it stood (at most 4 m long each; partitions as drawn, the core room's four walls) whose
  mass with its shards is the wall's (20 kg/m²), each starting upright and tipping in the
  wind's direction across it, as exterior walls do.
- **DEB-30**: A heavy body sliding on the ground snags at the terrain's mean free path (within
  10% over many draws), stops dead against its obstacle, stays pinned while pushed into it, and
  is free again once moving away from it or lifted 0.5 m clear.
- **DEB-08**: Same seed and same failures → identical debris trajectories.

## Simplifications / out of scope

- Light pieces don't collide with each other or with heavy ones; heavy pieces (v2.0) collide
  with each other, slabs and houses.
- Orientation doesn't feed back into the aerodynamics: drag and lift use tumble-averaged
  coefficients (standard for debris-flight models).
- Pieces are rigid and don't break further.
- Only a representative sample of real pieces is simulated (see `represents`).

## Changelog

- v2.7 (Phase 7 slice C): the pool tells the ground track (Spec 19) when a light piece lands on
  open ground (with its speed before the step) and when it slides along it (`DebrisField.marks`);
  read-only, no effect on the debris.
- v2.6 (Phase 7): over a roughness field (Spec 17) the per-terrain tables (turbulence
  intensity, snag mean free path, bump spacing) are read at the piece's local z₀, linear in
  log z₀ between the class values (`tableAt`); a class gives its own values as before.
  Also: pieces skipped by the far-field alternate stepping, and airborne heavy pieces, now count
  in the pool's fastest and highest stats (they were counted airborne but left out of the maxima;
  found when the new terrain moved INST-10's highest piece onto a skipped step).
- v2.5: for debris replay (Spec 13): a dispersion switch (`DebrisField.dispersion`, on in every
  real run; off holds gusts at zero), and `launch` takes a piece's own state (shape and mass
  for reference missiles; lift roll, spin sign, gust, stepping phase, last-stepped time and
  ground contact for replayed pieces). The far-piece alternate stepping uses the piece's
  stepping phase (its id's parity unless set). Nothing changes for pieces made by the town.
- v2.4: heavy pieces fall from where the component stood (walls and garage doors tip over)
  instead of being placed, and snag while sliding on the ground (DEB-29, DEB-30); interior
  walls are released as wall panels where they stood, not just studs and chunks (DEB-31); a swept
  slab's heavy pieces get 2 s before what still lies there is carried off, and retired ones are
  handed back to the heavy world for it. Found by the user: walls vanished, or reappeared flat
  on the ground, and interior walls just disappeared. Suction lift on lying heavy panels was
  tried and dropped (see Decisions).
- v2.3: a swept slab carries off every piece lying on it, heavy ones included (DEB-28): since
  v2.0 heavy rubble wasn't on the list the sweep cleared, so DOD 10 slabs kept their panels.
- v2.2: pieces far from the core advanced at 30 Hz (DEB-27), for speed (an EF5 was very slow).
- v2.1: the heavy-debris world runs beside the sim (a worker in the app), its results applied at a
  fixed 8-step lag (DEB-26), at the user's request: an EF5 was very slow.
- v2.0: heavy pieces as rigid bodies (DEB-22–25), at the user's request to make town and
  detailed houses look alike: destroyed town houses left almost no rubble (wall panels and roof
  sections skimmed off with the tornado for ~1.3 km).
- v1.9: `DebrisField.launch` (a piece of a given kind, point, velocity and orientation joins the field,
  counted as spawned) and an impact observer (`onImpact`, read-only), for the wind tunnel (Spec 12).
- v1.8: drag on the ground from the piece's projected area (DEB-21). Found in the paired detail
  vs component comparison: fallen wall panels were pushed like sails (tumble-averaged area on a
  panel lying flat), slid, hopped, flew into neighbors and knocked their walls down, so town
  houses lost all their walls and material at 110–150 mph.
- v1.7: rough ground (DEB-19); tumbling starts only half a length clear of the ground (DEB-20). Found by the user: small pieces such as siding and drywall
  kept sliding along the ground instead of hopping and getting airborne again, as they do on
  real rough ground.
- v1.6: lift on the ground is upward suction, and lift-off sets the nose-up tumble sense
  (DEB-18); pieces on the ground feel the wind at 0.2 m; slabs are ground (Spec 10). Found by
  the user: debris on the ground kept sliding and almost never got airborne again. Half the
  sheets tumbled in the down-lift sense, so on the ground their lift pressed them down, and
  sliding pieces read the wind at a few millimetres. In an EF4 pass, re-lofting rose from 10% of
  grounded pieces to 29%, and half as many pieces ended up on the ground at all.
- v1.5: pieces hit component houses (Spec 10): bounce, go through broken windows, or lodge in
  walls and roofs; lodged pieces fall free when their surface fails. Each piece records its
  source house's position for spreading representative copies.

- Pieces settling flat keep their heading (was a yaw derived from the piece id), so a piece
  that lands doesn't twist (Phase 5 slice B).

- v1.4: component spawning, rubble, mass bookkeeping, frozen (not erased) overflow, debris
  field drawn with multiplicity (DEB-14 to DEB-16; DEB-06 updated). Found by the user: hardly
  any debris was left in town (about 7 pieces and 0.2 t per destroyed house).
- v1.3: turbulent dispersion (per-piece gusts) and random lift roll (DEB-13). Found by the
  user: each house's debris landed in a thin straight streak, sorted by kind.
- v1.2: permanent debris field (DEB-11); snag release depends on wind direction (DEB-10);
  landing-spread validation (DEB-12). Found by the user: debris landed in a single narrow
  band 100–250 m right of the path. Causes: recycling erased earlier debris, near-ground wind
  was too strong (Spec 01 v1.5), and snagged debris escaped whenever drag beat 3× its weight,
  so it rode along with the tornado for ~1 km.
- v1.1: cap lowered to 3,000: a full pool of 6,000 airborne pieces cost ~220 ms per simulated
  second. A worker thread is a Phase 6 option.
- v1.1: snagging on obstacles while sliding (DEB-10).
- v1.1: static holding friction μ_s = 1.2 for landed debris (snagging).
- v1.1: pieces above the cloud base are removed as lofted into the storm (DEB-09), since the
  model has no storm flow there and they otherwise hung aloft and filled the pool; debris
  stepped at 60 Hz for cost.
- v1.0: written and approved for Phase 3.
