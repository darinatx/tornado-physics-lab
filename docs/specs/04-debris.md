# Spec 04 — Debris

Status: Approved (v1.2) — Phase 3 scope: flight, landing and re-lofting. Impacts on buildings arrive in Phase 4.

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

### Ground

- Pieces never go below the ground. On landing they bounce a little (restitution 0.2) and
  lose horizontal speed to sliding friction (μ_k = 0.5).
- Landed debris snags on grass, crops, fences and other debris, so it takes more to start it
  moving than to keep it moving: a resting piece holds unless drag beats μ_s·(m·g − F_up)
  with μ_s = 1.2. It lifts off again when the upward aerodynamic force F_up beats its weight.
  A sliding piece comes to rest once it's slow and the holding force can keep it.
- **Snagging:** light pieces (shingles, siding) can be pushed along by even moderate
  ground-level wind, and in reality they travel until they catch on a fence, crop row, shrub
  or other debris. A sliding piece snags with probability 1 − e^(−d/λ) over a slide of
  distance d, with mean free path λ = 30 m (open), 15 m (suburban), 8 m (urban). A snagged
  piece is pinned against its obstacle by the wind: it's released only when the wind swings
  around to pull it back the way it came (and drag beats the holding friction), or when the
  wind lifts it over. A passing tornado's wind turns about 180°, so pinned debris moves in
  short hops rather than riding along with the vortex.
- **Debris field:** resting pieces more than 3·R_max from the tornado can't be moved by the
  ground-level wind there, so they move to a permanent debris field: drawn, never simulated
  again, and never recycled (up to 60,000 pieces). This keeps the whole damage path's debris
  visible while freeing the active pool.
  Resting pieces are re-checked at 30 Hz, and only within 6·R_max of the tornado.

### Spawning

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

At most 3,000 pieces exist at once (each stands for many real objects; see `represents`). When the pool is full, the oldest resting piece is
recycled; if every piece is airborne, the new spawn is skipped and counted. Pieces leaving
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
  step(dt: number, s: TornadoState, terrain: TerrainClass, checkResting: boolean): void;
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
  (interquartile range) is at least 60% of its source houses' spread; heavy pieces (lumber,
  wall chunks) travel a median under 150 m, and sheets travel farther.
- **DEB-05**: Each failure spawns the specified pieces within the part's location (roof pieces
  at roof height over the footprint, window shards on their face), deterministically.
- **DEB-06**: The pool never exceeds its cap; full pools recycle the oldest resting piece first
  and count skipped spawns.
- **DEB-07** *(sanity)*: In a tornado, no piece moves faster than the fastest wind it has met
  plus its terminal speed, with 20% margin for lift.
- **DEB-09**: Pieces that rise above the cloud base are removed and counted as lofted.
- **DEB-08**: Same seed and same failures → identical debris trajectories.

## Simplifications / out of scope

- Pieces don't collide with each other or (until Phase 4) with buildings.
- Orientation doesn't feed back into the aerodynamics: drag and lift use tumble-averaged
  coefficients (standard for debris-flight models).
- Pieces are rigid and don't break further.
- Only a representative sample of real pieces is simulated (see `represents`).

## Changelog

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
