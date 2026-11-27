# Spec 17 — Terrain Roughness and Ground Cover

Status: Approved (v1.1) — Phase 7. Scope from the user, 2026-11-26. Technical choices are made
and recorded below (CLAUDE.md rule 1).

## Purpose

Today one terrain class (open, suburban or urban) is picked from a dropdown and applied to the
whole map. In the real world the town sets it: the wind slows near the ground over a
neighborhood because of the houses in it, and runs faster over the fields around it. This spec
makes ground roughness a property of the place, worked out from what is actually there, and
draws the ground to match.

- **Main sim:** roughness comes from the generated town only. There is no terrain control.
- **Structure lab:** roughness follows the surroundings by default, and the user can override it
  to test a house as if it stood in other terrain.

## Model

### Roughness length from what stands there

The wind-engineering measure of roughness is the **roughness length z₀** (m). A 20 m grid covers
the town plus a 1.5 km margin; beyond it the ground is open farmland. Each cell's z₀ comes
from its **ground cover** plus the **buildings** within a 200 m square window centred on it (one
block: lot-scale gaps such as street crossings are averaged out, as morphometric roughness maps
do with 100–500 m cells):

- **Ground cover** (Spec 05 layout): **farmland** outside the town (crops and pasture,
  z₀ = 0.03 m), **lawn** across the neighborhood's lots and streets (mowed grass, z₀ = 0.008 m),
  **pavement** for urban zones (z₀ = 0.001 m; no urban zones exist until Phases 11 and 13).
- **Buildings**, by the Macdonald, Griffiths & Hall (1998) model, which covers sparse to dense
  arrays and so serves today's houses and the later urban buildings alike:

  ```
  λp = footprint area / window area                     plan-area density
  λf = mean frontal area / window area                  frontal density (averaged over wind directions)
  h  = area-weighted mean standing height
  d/h  = 1 + A^(−λp) · (λp − 1)                          A = 4.43
  z₀/h = (1 − d/h) · exp( −[ 0.5 · β_M · C_D / κ² · (1 − d/h) · λf ]^(−1/2) )
                                                         β_M = 1.0, C_D = 1.2, κ = 0.4
  z₀ = max(z₀ cover, z₀ buildings)
  ```

  A house's **standing height** is what still stands of it in the component model (Spec 03; a
  detailed house's stand-in): h = f_w·wall height + f_r·roof rise / 2, with f_w the fraction of
  wall length standing and f_r the fraction of roof area still on. Its footprint counts in
  proportion to h over its full height and its frontal area is its mean projected width × h.
  Below the rubble height (1 m, Spec 04) it is a 1 m pile over the whole slab; a swept slab
  adds nothing. The fallen part of a footprint is **rubble**: the ground under it reads
  z₀ = 0.05 m (Wieringa's "rough open with scattered obstacles"), blended in ln z₀ with the
  cover by the rubble fraction of the window (fully rubble-rough at 10% of it). So a flattened
  neighborhood becomes smoother (about 0.05 m against 0.19 m standing), and the near-ground
  wind there strengthens, as it does across a real debris field.

For the default town (lots ~23 × 47 m, one-story houses, 10% empty lots), λp ≈ 0.10,
λf ≈ 0.04 and h ≈ 4 m, giving z₀ = 0.18–0.22 m (β ≈ 0.20; measured, seed 1): suburban without
trees (published suburban values with trees run 0.3–0.5 m; Phase 9 adds the trees).

### From z₀ to the wind profile

Spec 01's power law needs an exponent β. β follows z₀ continuously, through the three values
the wind field already uses, one decade of z₀ apart:

```
β(z₀) = 0.22 + 0.11 · log10(z₀ / 0.3 m),   clamped to [0.08, 0.40]
z₀ = 0.03 m → 0.11 (open)    0.3 m → 0.22 (suburban)    3 m → 0.33 (urban)
```

The anchors are standard terrain categories (Davenport–Wieringa roughness classes: open flat
land with low crops ≈ 0.03 m, suburbs ≈ 0.3 m, city centres ≥ 2 m). Every other per-terrain
table (Spec 04's turbulence intensity, snag distance and bump spacing) is interpolated the same
way, linearly in log10 z₀ between its open, suburban and urban values, held flat outside them.

The **terrain class** shown to the user is z₀ < 0.1 m open, 0.1–1 m suburban, ≥ 1 m urban (the
geometric midpoints between the anchors).

### Upwind fetch: the wind adjusts gradually

Wind crossing from fields into town doesn't slow at the first house. A new, slower layer (an
internal boundary layer) grows from the edge and deepens downwind; at roof height the wind is
mostly adjusted within a few hundred metres and fully within about a kilometre (Elliott 1958,
Wood 1982; ASCE 7 asks for 800 m of uniform upwind terrain before an exposure applies). So the
β a point feels depends on the ground **upwind** of it:

```
ln z₀,eff(x, θ) = Σ w(s) · ln z₀(x − s·û(θ)) / Σ w(s),    w(s) = exp(−s / L)
β(x, θ)       = β(z₀,eff)                                   L = 250 m
```

(95% of the weight lies within 3L = 750 m and 98% within 1 km.)

where û(θ) is the direction the wind blows toward. Roughness is averaged in ln z₀, the standard
blend for patchy terrain (Taylor 1987). The field is precomputed for 16 wind directions and read
by bilinear interpolation in space and linear interpolation between the two nearest
directions. `windAt` takes the direction from the horizontal wind at z_p (above the friction
layer, where roughness doesn't change it), then applies the local β below z_p.

### Updates

Every 2 s of sim time, at fixed sim times (determinism), the houses whose damage changed are
read again; if any changed, the local z₀ is recomputed (summed-area tables over the window) and
the directional fields rebuilt by a recursive exponential filter: E(x) = a·E(x − Δû) +
(1 − a)·ln z₀(x), with Δ = √2·cell and a = exp(−Δ/L), swept across the grid from the upwind
side (the upstream point is at a fixed grid offset, so every node it reads is already done).
The cost is proportional to cells × directions, not × fetch length. Each update makes a new,
immutable field with the next version number; workers (Spec 04's heavy debris, Spec 09's
detail zone) receive a field once and then only its version.

### Where it applies

- **Wind (Spec 01):** `windAt` takes the terrain as either a uniform class or this field. The
  vortex friction layer and the carried wind below 10 m both use the local β.
- **EF readout (Spec 07):** on the EF scale's own basis, the open-terrain 10 m 3-s gust: the
  peak is searched around the core with the open class (z₀ 0.03 m), whatever the ground there.
  Damage still uses the local wind; only the reported rating is standardized (v1.1, BL-021).
- **Debris (Spec 04):** turbulence intensity, snag distance and bump spacing use the local z₀
  where the piece is.
- **Wind tunnel and lab steady wind (Spec 12):** the tunnel's power law uses the β at each point
  for the tunnel's direction.

### Main sim

- The terrain dropdown is removed from the parameters panel. The sim always uses the field
  built from the generated town.
- The probe shows the local terrain: class, local and upwind-weighted z₀, and the β the wind
  feels there (for the wind direction at that moment).

### Structure lab

- A **Terrain** setting in the lab's setup: **Auto** (default), **Open**, **Suburban**, **Urban**.
  - **Auto** builds the field from the lab's own houses exactly as the town does: lawn under the
    neighborhood ring (at its chosen density) and farmland beyond it; an open field is farmland
    with only the block's own houses (open class at the block).
  - **Open / Suburban / Urban** apply that class uniformly (z₀ = 0.03, 0.3 or 3 m), whatever the
    surroundings, so a house can be tested in terrain its surroundings don't create.
- A replay in its recorded wind keeps the recording's roughness (Spec 13 already keeps the
  recording's terrain): the recording stores, at each field update, the target's local ln z₀
  and its upwind-weighted ln z₀ for the 16 directions in the target's frame; the replay applies
  them as a uniform field turned to the receiving house, and the Terrain setting is locked.
- The lab ground follows the terrain it is using (below).

### Ground cover (Spec 06)

The ground is drawn by cover, with no roads, road edges or section lines in any texture
(roads come with city generation, Phase 13):

- **Farmland** (open country): today's field patchwork and crop rows, without its section-line
  roads.
- **Lawn** (residential lots and streets): short, even, mowed grass; slightly greener and finer
  than the fields, with faint mowing stripes and per-lot variation in shade.
- **Pavement** (urban): concrete, light grey, with joint lines and wear. Not used in the main
  sim until urban zones exist; the lab shows it with the Urban override.

Cover boundaries are blended over about 5 m so the town edge doesn't show a hard seam. The lawn
is laid out as the town's lots (aligned with its blocks); streets are the same grass. In the
lab, an override draws its class's cover over the whole ground, matching the wind, which uses
that class everywhere (Open → farmland, Suburban → lawn, Urban → pavement); Auto draws the
surroundings' real cover. Ground cover and the roughness layer are one material on one surface,
so nothing lying on the ground fights it for depth.

### Roughness layer (Spec 06, Spec 07)

A **Ground roughness** checkbox in the Layers panel, off by default, in the main sim and the
lab. When on, the ground is tinted by the roughness the wind actually feels:

- **What it shows:** the effective z₀ (upwind fetch included) for the wind direction at z_p
  over each cell at that moment. The town edge reads as a gradient a few hundred metres wide,
  and the gradient moves with the wind direction around the tornado.
- **Colours:** a continuous sequential scale in log10 z₀ from 0.001 m (smoothest) to 3 m
  (roughest), colour-blind safe, with ticks at the class boundaries (0.1 and 1 m). The tint is
  semi-transparent (about 45% opacity) and drawn on the ground only, under houses and debris.
- **Legend:** shown while the layer is on: the scale, the three class names at their ranges,
  and the typical z₀ of farmland, lawn, the default town and a city centre.
- **Updates:** with the field (every 2 s of sim time); the effective z₀ per cell is recomputed
  for the current wind directions at the same times. The layer only reads the field (Spec 06:
  rendering never writes sim state).
- **Lab:** with an override the layer is uniform at the class's z₀; with Auto it shows the
  surroundings' field.

### Ground damage tracks (Spec 19)

The marks a tornado leaves on the ground (lodged crops, scoured soil, debris gouges) are a
change to the ground cover. Spec 19 defines them as a track grid that feeds this field's cover
roughness and is drawn by the same ground material (Phase 7, slice C).

## Interface

```ts
// src/core/terrain/roughness.ts (pure)
interface RoughnessField {
  kind: "field"; version: number;     // version: next per builder; each update is a new field
  cell: number; originX: number; originZ: number; nx: number; nz: number;   // m, nodes
  lnZ0: Float32Array;                 // ln z₀ of what stands at each node
  eff: Float32Array[];                // 16 directions: upwind-weighted ln z₀
  outsideLn: number;                  // ln z₀ beyond the grid
}
type Terrain = TerrainClass | RoughnessField;
function macdonaldZ0(lambdaP: number, lambdaF: number, h: number): number;   // m
function betaFromZ0(z0: number): number;
function interpByZ0(table: Record<TerrainClass, number>, z0: number): number;
function tableAt(table: Record<TerrainClass, number>, t: Terrain, x: number, z: number): number;
function terrainClassOf(z0: number): TerrainClass;
function betaAt(t: Terrain, x: number, z: number, dirRad: number): number;
function z0At(t: Terrain, x: number, z: number): number;       // local
function effZ0At(t: Terrain, x: number, z: number, dirRad: number): number;
function uniformField(z0: number, version?: number): RoughnessField;
class RoughnessBuilder { constructor(cover: GroundCover, bounds); apply(o: Obstacle, ±1); rebuild(); field }
class TerrainSender { pack(t: Terrain): TerrainMsg } class TerrainCache { resolve(m: TerrainMsg): Terrain }

// src/sim/terrain.ts
function obstacleOf(b: Building | HouseSpec): Obstacle;
class TownRoughness { constructor(cover: GroundCover, buildings); update(buildings): boolean; field }
function townCover(extent: number): GroundCover;

// src/core/wind/windField.ts (Spec 01 v2.0)
function windAt(p: Vec3, s: TornadoState, terrain: Terrain): Vec3;
function fetchDirection(p: Vec3, s: TornadoState): number;     // rad, the wind at z_p over p

// src/sim/types.ts
TornadoParams.terrain: TerrainClass | "auto";                    // "auto" by default
SimSnapshot.terrain: Terrain; SimSnapshot.groundCover: GroundCover | null;
SimConfig.cover?: GroundCover; SimConfig.terrainAt?: (t: number) => Terrain;   // the lab
```

## Parameters

| Name | Unit | Value | Source / note |
|---|---|---|---|
| grid cell | m | 20 | resolves a lot; 281 × 281 nodes for the town with its margin |
| density window | m | 200 square | one block; morphometric maps use 100–500 m (a 100 m window read street crossings as near-open) |
| grid margin | m | 1500 | beyond the 1 km fetch, so the town edge is fully resolved |
| z₀ farmland / lawn / pavement | m | 0.03 / 0.008 / 0.001 | Wieringa (1993) roughness classes |
| A, β_M, C_D, κ | – | 4.43, 1.0, 1.2, 0.4 | Macdonald et al. (1998), staggered arrays |
| rubble height | m | 1.0 | Spec 04 rubble |
| z₀ rubble / full at | m / – | 0.05 / 10% of the window | Wieringa "rough open, scattered obstacles" (0.03–0.1 m) |
| β anchors | – | 0.11 / 0.22 / 0.33 at z₀ = 0.03 / 0.3 / 3 m | Spec 01 values; roughness classes |
| β clamp | – | 0.08–0.40 | keeps very smooth or very rough cells physical |
| fetch length L | m | 250 | internal-boundary-layer growth (Elliott 1958, Wood 1982); 95% at 750 m, near ASCE 7-22 §26.7.3's 800 m fetch |
| directions | – | 16 | 22.5° sectors |
| update interval | s (sim) | 2 | buildings fail over seconds; deterministic times |
| cover blend | m | 5 | hides the seam at the town edge |

All values go in `src/config/terrain.ts`.

## Acceptance criteria

- **TERR-01**: The same seed and layout give an identical roughness field (every z₀ and β equal),
  and a run with the field is deterministic (same seed and inputs, same results).
- **TERR-02**: `macdonaldZ0` matches the Macdonald (1998) formula (±1e-9 relative) and its
  published curve: for λp = λf rising from 0.05, z₀/h rises to a peak near 0.1–0.15 at
  λ ≈ 0.15–0.2 and falls beyond. An empty cell's z₀ equals its cover's.
- **TERR-03**: In the default town, every cell more than 1 km inside the neighborhood's edge has
  z₀ in 0.1–0.4 m (suburban class); farmland more than 1 km from the town is open (z₀ = 0.03 m).
- **TERR-04**: `betaFromZ0` gives exactly 0.11, 0.22 and 0.33 at z₀ = 0.03, 0.3 and 3 m, rises
  monotonically and stays within 0.08–0.40. `interpByZ0` returns each table's own values at
  the anchors.
- **TERR-05**: Fetch: for wind blowing straight into the town across its edge, β rises
  monotonically from the edge inward; at the edge it is below the midpoint of the open and
  interior values, and 750 m in it is within 5% of the interior value.
- **TERR-06**: Direction: at a point 200 m inside the town's west edge, β for wind from the west
  (fetch over farmland) is smaller than for wind from the east (fetch over the town).
- **TERR-07**: `windAt` with a uniform field (every cell z₀ = 0.03, 0.3 or 3 m) equals `windAt`
  with the matching class (±1e-6 relative), and with a class argument it is unchanged from
  Spec 01 v1.9.
- **TERR-08**: Flattening every house in a 600 m square lowers z₀ at its centre to the
  lawn-and-rubble value at the next update (within 2 s of sim time) and raises the 5 m wind
  speed there (same tornado state).
- **TERR-09**: Debris turbulence intensity, snag distance and bump spacing follow the local z₀
  (`interpByZ0`), and equal Spec 04's class values at the anchors.
- **TERR-10**: Main sim: the parameters panel has no terrain control; the sim's terrain is the
  field built from the town; the probe shows class, local and upwind z₀ and β at the point.
- **TERR-11**: Lab: the Terrain setting offers Auto, Open, Suburban and Urban (Auto by default).
  Auto with the neighborhood gives the field built from the lab's surroundings (suburban at the
  block); Auto with an open field is open at the block; an override is uniform at its class. A replay in its recorded wind
  uses the recording's roughness and locks the setting.
- **TERR-12**: Ground cover: town lots and streets are lawn, outside the town is farmland, and no
  ground texture draws roads or section lines. In the lab an override draws its class's cover
  over the whole ground (Open farmland, Suburban lawn, Urban pavement).
- **TERR-14**: Roughness layer: off by default; when on, each cell's colour maps the effective
  z₀ for the current wind direction there (the same value the wind uses, within one step of its
  512-step colour table), the
  town edge shows a gradient rather than a step, the legend appears, and the layer refreshes
  at each field update. Turning it on or off changes no sim state (identical run either way).
- **TERR-13**: Cost: building the field for the default town takes ≤ 200 ms at startup (measured
  ~60 ms); an update after houses fail takes ≤ 15 ms on the main thread (median; measured
  ~11 ms); `windAt` over the field costs ≤ 1.6× `windAt` over a class near the ground (1 M calls;
  measured ~1.5×: the direction, two sector reads and the shared factors); a roughness-layer
  refresh takes ≤ 15 ms (measured 6–10 ms).
- **TERR-25**: The EF readout is on the EF scale's basis: its peak speed equals the open-terrain
  value (the same tornado state with the open class) whether the core is over farmland, the
  town or scoured ground, while the wind at a point (and so damage) still follows the local
  roughness.

## Simplifications / out of scope

- The fetch follows a straight line upwind along the wind at that point. Near the core the air
  arriving at a point actually came round a spiral, so the fetch there is approximate.
- One fetch length for every height in the friction layer (real adjustment is faster near the
  ground and slower higher up).
- No displacement height: the profile starts at the ground, not at d. For one-story houses d is
  about 1 m; it will matter for urban buildings (Phase 11).
- Frontal density is averaged over wind directions rather than taken for each one.
- No local speed-up or sheltering between individual buildings (Spec 01): roughness changes the
  mean profile over an area, not the flow around each house.
- No trees until Phase 9; they will add to z₀ through the same model (trees are the main reason
  real suburbs reach 0.3–0.5 m).
- No roads, water, woods or terrain height (hills, valleys); roads and zoning come with city
  generation (Phase 13).

## Decisions

Made by Claude, prioritizing realism; see CLAUDE.md.

1. **z₀ from building geometry (Macdonald 1998), not a zone label.** It is computed from what
   stands, so the same code serves today's houses, the later building types and dense cities,
   and it drops as buildings fail. A label per zone could do neither.
2. **β through the existing anchors.** The wind field, presets and Phases 1–6 calibration all
   use 0.11 / 0.22 / 0.33. A continuous β(z₀) through those values keeps every class result
   unchanged (TERR-07) while letting roughness vary smoothly between them.
3. **Upwind fetch with an exponential weight (L = 250 m).** Real wind adjusts over
   hundreds of metres after a roughness change; switching β at the town edge would put a
   discontinuity in the wind that no real storm has. Averaging in ln z₀ is the standard
   effective-roughness blend.
4. **Precomputed for 16 directions.** The wind direction changes all the time around a tornado;
   16 fields read by interpolation cost a few lookups per `windAt`, where computing the fetch
   per query would cost ~50.
5. **Roughness updates as buildings fail.** A flattened neighborhood really is smoother.
   Updating every 2 s at fixed sim times keeps runs deterministic and costs little.
6. **Lab override is uniform.** Its purpose is to test a house in a chosen exposure; a uniform
   class is the clean case, and Auto covers the realistic one.
7. **Lab ground follows the override.** The ground shows the terrain the wind is using, so what
   you see matches the physics.
8. **The layer shows effective z₀, not local z₀** (recommended by Claude, accepted by the user 2026-11-26). The
   effective value is what drives the wind and the damage; the probe still reports both.

## Changes to other specs (made with v1.0)

- **Spec 01** v2.0: `windAt(p, s, terrain: Terrain)`; local β below z_p; WIND-14 and WIND-20 hold
  for classes and for fields.
- **Spec 04**: per-terrain debris tables read through `interpByZ0` at the piece's position.
- **Spec 05**: the layout exports the ground cover (farmland, lawn); "one terrain roughness"
  simplification removed.
- **Spec 06**: ground drawn by cover (farmland, lawn, pavement), section-line roads removed;
  the roughness layer and its legend.
- **Spec 07**: terrain dropdown removed; probe and inspector show the local terrain (local and
  effective z₀, class, β); Ground roughness checkbox in the Layers panel.
- **Spec 12** v0.3: the tunnel's power law uses the β at each point for its direction.
- **Spec 13**: Terrain setting (Auto, Open, Suburban, Urban); LAB-03 replaced by TERR-11; the
  recording keeps its β field.

## Changelog

- v1.1 (2026-11-26, BL-021, the user's "fix"): the EF readout reports the open-terrain 10 m
  wind, as the EF scale defines its speeds; with the local β it read low over town and high over
  the storm's own scoured track (TERR-25).
- v1.0 (2026-11-26, Phase 7 build): approved and built. Changes from the draft, from the build:
  the density window is 200 m (a 100 m window read street crossings as near-open, z₀ 0.05 m
  among 0.19 m); the fetch is a recursive exponential filter (no hard 1 km cut-off; 98% of the
  weight within 1 km); standing height and rubble roughness (0.05 m) made explicit; each update
  is a new field (versions per builder) so workers and in-process engines see the same one;
  the EF readout's peak search reads β at each point; the tunnel reads β at each point for its
  direction; a recording keeps the target's z₀ per direction; a lab override draws its cover
  over the whole ground; cost budgets set from measurement (TERR-13).
- v0.2: Ground roughness layer (TERR-14) at the user's request (2026-11-26): an optional ground
  tint by effective z₀ with a legend.
- v0.1: initial draft at the user's request (2026-11-26): roughness from building density with
  upwind fetch, ground cover to match, main-sim control removed, lab override.
