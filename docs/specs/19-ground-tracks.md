# Spec 19 — Ground Damage Tracks

Status: Approved (v1.0) — Phase 7, slice C. Requested by the user 2026-11-26 (designed in another
session). Technical choices are made below (CLAUDE.md rule 1). Extends Spec 17: the track is
part of the ground cover and feeds the roughness field.

## Purpose

A tornado marks the ground it crosses: crops and grass laid flat, then stripped, then the soil
scoured bare, with gouges and drag streaks where debris hit. The marks stay after the core has
passed, and survey teams read them (Phase 8's storm report uses them in open country). Here
the marks come from the physics: each patch of ground records the wind it felt, for how long
and with how much debris, and its state and look follow from that. Strength is never an input.

## Model

### The track grid (sim state)

A grid of **2 m cells** in tiles of 32 × 32 cells (64 m), created only where the tornado
reaches, so an untouched map costs nothing. It lives in `src/sim`, is deterministic, and is
updated every **0.5 s of sim time** (fixed times; the wind at a point changes over
R_max ÷ forward speed, tens of seconds) for the cells within the **active radius**: where the
near-ground wind can exceed the weakest cell's lowest threshold (crop lodging × 0.8), from an
upper bound on the 2 m wind (swirl with its overshoot, inflow and the full carried wind),
within 10·R_max. (A fixed 3·R_max cap cut strong tracks off along a straight line: the EF4
preset's 2 m wind is still ~29 m/s at 5·R_max on its strong side.) Each update samples the wind at **2 m** (canopy
and turf height) with `windAt` (the terrain's β included, Spec 17) on an 8 m lattice aligned
with the tiles, and interpolates it to the cells (the wind is smooth on the core's scale). To
keep the cost down (TERR-24):
- an 8 m block is skipped when even its strongest corner can't beat the lowest peak among its
  cells and is below the scour onset (interpolation never exceeds the corners), which is
  everything the core has passed;
- beyond 1.5·R_max, where the wind changes slowly, each block updates every fourth pass
  (staggered), its dose over that longer interval;
- beyond 3·R_max (smooth wind, below the scour onset), one wind sample per 32 m patch serves
  its cells, every eighth pass.

Per cell:

1. **Peak wind and its direction.** The highest 2 m wind so far and the direction it blew
   toward at that moment. This is the way lodged crops and pushed-over grass lie. Because the
   swirl, the inflow and the forward motion combine, the rows on each side point toward a
   convergence line near the track centre, offset toward one side (as in surveyed tree-fall
   patterns of cyclonic tornadoes, e.g. Karstens et al. 2013); the pattern isn't drawn, it
   follows.
2. **Scour dose.** Grass, crops and topsoil are removed by sustained wind and by debris
   sandblasting the surface, not by one gust (Jarrell, 1997: a slow F5 scoured fields up to
   46 cm deep). The dose grows only while the wind is above the scour onset u_s, at the rate
   of the aeolian erosion law already used for dust (Spec 06; Gillette & Passi 1988):

   ```
   dD/dt = (u/u_s)³ · (1 − (u_s/u)²) · (1 + k_d · φ)      for u > u_s, else 0
   ```

   where u is the 2 m wind and φ the **debris load**: the mass of flying debris below 3 m
   within the cell's tile in that update, per m² (kg/m², from the debris pool). A slow tornado
   holds a cell above u_s for longer, so it scours more than a fast one of the same peak.
3. **Marks.** Debris gouges and drag streaks, taken from the debris events (Spec 04): a light
   piece landing on open ground (not a slab) faster than 5 m/s darkens the cells under its
   footprint, more for more momentum (log of mass × speed, at most 60 of 255 per landing); each
   debris step a piece slides on open ground faster than 2 m/s darkens the cell it reaches
   faintly (log of mass × distance, at most 8), so a slide leaves a streak along its path.
   Marks are a darkness per cell (0–255), accumulated. Open country has few marks: no houses
   shed debris there.

### Cell state

From peak wind (lodging, by the cell's cover) and dose (scouring):

| Cover | State | When | z₀ (m) |
|---|---|---|---|
| farmland | standing | peak < 28 m/s | 0.03 (cover) |
| farmland | **lodged** (flattened, lying in the peak direction) | peak ≥ 28 m/s | 0.010 |
| farmland | **snapped and shredded** | peak ≥ 48 m/s | 0.015 |
| lawn | standing | peak < 35 m/s | 0.008 (cover) |
| lawn | **pushed over** | peak ≥ 35 m/s | 0.006 |
| both | **thinned** | D ≥ D₁ | 0.005 |
| both | **stripped** (vegetation gone, some soil) | D ≥ D₂ | 0.002 |
| both | **bare soil** (scoured) | D ≥ D₃ | 0.001 |

Each cell has its own **strength**: its plants' thresholds (lodging, snapping, pushed over)
and its soil's dose thresholds are each scaled by 1 ± 20%, fixed by the cell's position (a
deterministic smooth noise over ~24 m patches, 85%, plus a little 2 m jitter, 15%), since
soil and crop variation comes in patches tens of metres across.
Real fields and lawns aren't uniform; it gives the track ragged, patchy edges instead of
smooth contour lines. Scouring states override lodging; states never go back. A **gouge** or **streak** marks the
look only (too small to matter to z₀ at 20 m). Crops lodge at a lower wind than mowed lawn,
which is short and sits low in the surface layer.

### Roughness (Spec 17)

A track changes the ground cover, so it feeds the roughness field at its next update (every
2 s): each 20 m roughness node's cover ln z₀ is the area-weighted mean over its window of the
track cells' ln z₀ (untouched cells keep the cover's). Scoured or lodged ground is smoother,
so the near-ground wind behind the core strengthens there, as over a flattened neighborhood.
Where houses stand, the roughness keeps the near-ground wind lower, so the scoured strip
narrows through town without any special rule.

### Drawing (Spec 06)

The renderer reads the track tiles (never writes them) into a texture atlas (one row per tile)
sampled by the ground material (Spec 17's single ground surface). It draws continuous amounts
per cell, not the states, so transitions follow each cell's own strength:

- **flattened:** how far the peak wind went past the cell's own lodging threshold (from 85% of
  it, full at 135%): the vegetation lightens (up to 18%) with streaks along the stored
  direction, so the convergent rows show; well-flattened crops (not lawn) take a faint straw
  mottle over ~6 m patches (broken stalks); flattened lawn shifts toward pale, yellowish green
  (blade undersides and thatch, up to 45%) with clear lay lines, since lightening alone doesn't
  show on bright mowed grass;
- **soil showing:** rises smoothly with the dose against the cell's own erodibility (from 25%
  of the thinning dose to the bare-soil dose), so a scoured core fades out through a fringe of
  thinned, part-exposed ground; toward soil colour with slight patch variation;
- **marks:** darken toward dark soil, at most 55%.

Marks stay for the rest of the run. The track darkens where the storm strengthens and fades
where it weakens, because the cells felt that; its width follows the core's size, not its
strength, because the wind's radial reach scales with R_max.

### What to expect (the calibration targets, TERR-19)

- **EF0–1:** patchy lodging, mostly on the side where swirl and forward motion add; a faint,
  broken track; no scouring.
- **EF2:** crops lodged across the whole path in the inward pattern; lawn pushed over; light
  streaks.
- **EF3:** crops snapped and shredded, grass thinned, patchy stripping in the core; many gouges.
- **EF4–5:** crops gone near the centre and lodged only at the edges; grass and topsoil
  stripped to bare soil, most where the storm moves slowly; dense marks. Suction-vortex loops
  appear on their own once Phase 10 adds multiple vortices (no special case here).

## Interface

```ts
// src/config/terrain.ts (TRACK)
// src/sim/groundTrack.ts
class GroundTrack {
  update(dt: number, s: TornadoState, terrain: Terrain, debris: readonly Piece[]): void;  // every 0.5 s
  landing(p: Piece, speed: number): void;   slide(p: Piece, x0: number, z0: number): void;
  readonly list: TrackTile[];   version: number;
  cellAt(x: number, z: number): { peak; dirRad; dose; state; mark; cover } | null;
  coverLnZ0(x0: number, z0: number, x1: number, z1: number, baseLn: number): number | null;
}
SimSnapshot.groundTrack: GroundTrack (read-only to callers)
DebrisField.marks: { landing(p, speed); slide(p, x0, z0) } | null   // set by the sim
```

## Parameters

| Name | Unit | Value | Source / note |
|---|---|---|---|
| cell / tile / lattice | m | 2 / 64 / 8 | resolves gouges and lodging rows; tiles keep it sparse; the wind is sampled on the lattice |
| update interval | s (sim) | 0.5 (outer ring 2) | wind at a cell changes over tens of seconds |
| sample height | m | 2 | canopy and turf height (lodging studies measure at 1–2 m) |
| crop lodging onset | m/s at 2 m, 3-s gust | 28 | canopy failure 16–30 m/s in sustained wind (Berry et al. 2021; Baker et al. 2014; cereal canopies ~11.6 predicted); the sim's winds are 3-s gusts, so lodging sits at the top of that range; calibrated (TERR-19): EF0–1 patchy, EF2 across the path |
| crops snapped | m/s at 2 m | 48 | calibrated: EF3 (51–62 m/s at 2 m) snaps them, EF2 (41–50) only lodges them |
| lawn pushed over | m/s at 2 m | 35 | decision: mowed turf is short and stiff and sits low in the surface layer; no field data found; above crop lodging, per the design |
| scour onset u_s | m/s at 2 m | 50 | no EF2 scouring, onset within EF3 (EF3 is 61–74 m/s at 10 m, ~51–62 m/s at 2 m over open ground) |
| debris weight k_d | m²/kg | 2 | debris doubles the rate at 0.5 kg/m² of flying debris below 3 m; not separately calibrated (no debris in the open-country calibration) |
| D₁ / D₂ / D₃ | s | 0.5 / 1.5 / 8 | calibrated (TERR-19): EF3 core 32% thinned or stripped, EF4 core 81% stripped or bare, EF4 at half speed 100% |
| z₀ of states | m | see table | Wieringa (1993) classes: flattened canopy ~0.01, short grass 0.005–0.008, bare soil 0.0002–0.005 |
| gouge landing speed / streak speed | m/s | 5 / 2 | below them a piece settles or creeps without marking |
| cell strength variation | – | ±20% plants, ±20% soil; ~24 m patches | patch-to-patch variation in crops, turf and soil; gives lobed, patchy edges |

All values go in `src/config/terrain.ts` with these sources. The scour thresholds are the
weakest-sourced numbers in the model: published scouring is case reports (Jarrell 1997;
Neshoba County 2014; the December 2021 Arkansas cropland scars seen from satellite), not
measured thresholds, so they are calibrated to those outcomes and logged as a simplification.

## Acceptance criteria

- **TERR-15**: The track is deterministic (same seed and inputs, same cells) and only cells
  within the active radius are updated; a map the tornado never crosses has no tiles.
- **TERR-16**: Each cell's direction is the 2 m wind's direction at its peak; across an EF2-like
  pass the lodged rows converge on one line within R_max of the centreline, with ≥ 80% of the
  lodged cells on each side of it pointing toward it.
- **TERR-17**: Crops lodge at a lower wind than lawn is pushed over; in an EF1 pass lodging is
  patchy and at least twice as common on the side where swirl and forward motion add.
- **TERR-18**: Scouring depends on duration and debris: the same storm at half the forward speed
  gives > 10% more total dose over the core, with ≤ 10% of its cells at an earlier state (cell
  by cell the passes sample different moments); a debris load raises the dose rate; a wind at
  or below u_s gives none.
- **TERR-19**: Calibration: preset passes over farmland give the targets: EF2 > 90% of the core
  lodged and none scoured; EF3 scoured in under half of the core and less at the edges; EF4
  > 50% of the core stripped or bare, with more lodged or snapped than scoured at the edges;
  EF4 at half its forward speed more of the core stripped or bare, and at least as much bare
  soil. (EF5's core is bare at either speed.)
- **TERR-20**: Track width follows the core's size, not its strength: doubling R_max at the
  same V_max roughly doubles the lodged width (±25%); raising V_max at the same R_max widens it,
  never beyond the active radius on either side.
- **TERR-21**: Lodged and scoured cells lower the roughness: at the next roughness update the
  node over a scoured strip has a lower z₀ than before, and the 5 m wind there is higher.
- **TERR-22**: Debris landings faster than 5 m/s leave gouges and slides leave streaks along
  their paths, at the pieces' positions; slower landings leave none.
- **TERR-23**: Drawing: the renderer only reads the track; ground the core has left behind
  keeps its marks unchanged; lodged cells carry their stored direction to the shader; scoured
  cells shade toward soil in stage order.
- **TERR-24**: Cost: in the `ef4-town` bench scene's approach window the track's updates take
  ≤ 3% of the physics step (confirmed with `npm run bench` at the slice's benchmark run).

## Simplifications / out of scope

- Scour thresholds calibrated to case reports, not measured (see Parameters).
- One sample height (2 m) for crops and turf; no crop growth stage, height or soil moisture
  (wet soil scours differently).
- Debris load counted per tile, not per cell; only light pieces mark the ground (heavy rigid
  bodies run in their own engine and don't report landings yet).
- Cells are drawn as 2 m squares (nearest sampling), softened by the lodging streaks.
- No ground marks under slabs or inside the town's lots beyond the lawn's own state.
- Trees (Phase 9) will add their own marks (fallen trunks, root balls).

## Decisions

Made by Claude, prioritizing realism; see CLAUDE.md.

1. **Its own spec, extending Spec 17.** Spec 17 is approved and tested; adding untested
   criteria to it would break the trace until slice C is built.
2. **Scour as an aeolian erosion dose, weighted by debris.** It already models how the soil's
   surface responds to wind (the dust uses it) and captures duration, which observations show
   matters more than the peak.
3. **2 m cells, sparse tiles, 0.5 s updates, skipped blocks, a slower outer ring.** Fine enough
   for gouges and lodging rows. The first version (0.25 s, every cell each pass) cost 12.5% of
   the EF4 step; these bring it under 3% (TERR-24) without changing the calibrated result.
4. **Marks from debris events, not drawn decorations.** Every mark has a piece behind it.
5. **Lodging thresholds on the gust basis.** The published failure speeds are for sustained
   canopy wind; with them as 3-s gusts, even EF0 flattened its whole core. At the top of the
   range they give the patchy EF0–1 tracks surveys describe.

## Changelog

- v1.0 (2026-11-26, slice C build): approved and built. Thresholds calibrated on the gust basis
  (crop lodging 28, snapping 48, lawn 35 m/s at 2 m; doses 0.5 / 1.5 / 8); updates every 0.5 s on
  an 8 m lattice with skipped blocks and a slower outer ring (cost); marks are a darkness per
  cell; TERR-16 restated as convergence on one line near the centre (the line is offset, as in
  surveys); TERR-18 compares the core as a whole; TERR-19's slow case is EF4 (EF5's core is bare
  at either speed). After the user's review in the app: per-cell strength (±20%) for ragged,
  patchy edges; drawing from continuous flatten and soil amounts (the discrete states drew
  hard contour lines and a speckled straw ring); much lighter debris marks (sliding pieces
  had painted the lawn nearly black). Then, after the user's look at an EF5 track: the
  variation in ~24 m patches (per-cell variation broke the edge into speckle) and a wider
  soil fringe (from 25% of the thinning dose). Then, after the user saw a too-smooth straight
  edge on a strong track's right side: the 3·R_max cap replaced by the physical active radius
  (within 10·R_max), with a coarse far zone (one sample per 32 m, every eighth pass) to stay
  within the cost (TERR-20 restated). Then, after the user saw no change on suburban lawns (the
  sim had pushed over 59% of an EF2's core lawn and scoured 72% of an EF4's): flattened lawn
  drawn paler and yellower with lay lines.
- v0.1 (2026-11-26): drafted at the user's request (another session's design).
