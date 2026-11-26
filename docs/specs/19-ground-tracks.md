# Spec 19 — Ground Damage Tracks

Status: Draft (v0.1) — Phase 7, slice C. Requested by the user 2026-11-26 (designed in another
session). Technical choices are made below (CLAUDE.md rule 1); it becomes Approved when slice
C's build starts, so `npm run trace` keeps passing until its tests exist. Extends Spec 17: the
track is part of the ground cover and feeds the roughness field.

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
updated every **0.1 s of sim time** (12 physics steps, fixed times) for the cells within the
**active radius**: where the near-ground wind can exceed the lowest threshold (crop lodging),
found from the vortex's tangential profile, and never beyond 3·R_max. Each update samples the
wind at **2 m** (canopy and turf height) at each active cell's centre with `windAt` (the
terrain's β included, Spec 17).

Per cell:

1. **Peak wind and its direction.** The highest 2 m wind so far and the direction it blew
   toward at that moment. This is the way lodged crops and pushed-over grass lie. Because the
   swirl and the forward motion combine, the peak direction on both sides of the path points
   inward toward the track centre, ahead of the core; the pattern isn't drawn, it follows.
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
3. **Marks.** Debris gouges and drag streaks, taken from the existing debris events (Spec 04):
   a landing (a piece hits the ground faster than 5 m/s) leaves a gouge sized by the piece's
   footprint and depth by its momentum; a slide leaves a streak along its path, wider for
   heavier pieces. Stored per tile as a short list (position, direction, length, width, depth),
   capped per tile (oldest merged into the cell darkness).

### Cell state

From peak wind (lodging, by the cell's cover) and dose (scouring):

| Cover | State | When | z₀ (m) |
|---|---|---|---|
| farmland | standing | peak < 15 m/s | 0.03 (cover) |
| farmland | **lodged** (flattened, lying in the peak direction) | peak ≥ 15 m/s | 0.010 |
| farmland | **snapped and shredded** | peak ≥ 30 m/s | 0.015 |
| lawn | standing | peak < 25 m/s | 0.008 (cover) |
| lawn | **pushed over** | peak ≥ 25 m/s | 0.006 |
| both | **thinned** | D ≥ D₁ | 0.005 |
| both | **stripped** (vegetation gone, some soil) | D ≥ D₂ | 0.002 |
| both | **bare soil** (scoured) | D ≥ D₃ | 0.001 |

Scouring states override lodging; states never go back. A **gouge** or **streak** marks the
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

The renderer reads the track tiles (never writes them) into a texture per tile, sampled by the
ground material (Spec 17's single ground surface):

- **lodged / pushed over:** the cover lightened (exposed stems and leaf undersides) with
  streaks along the stored direction, so the inward pattern shows;
- **snapped and shredded:** broken, lighter and patchy;
- **thinned → stripped → bare soil:** the cover fading to brown soil, darkest at bare soil;
- **gouges and streaks:** dark soil marks.

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
  update(t: number, s: TornadoState, terrain: Terrain, debris: readonly Piece[]): void;  // every 0.1 s
  onLanding(p: Piece, speed: number): void;   onSlide(p: Piece, from: Vec2, to: Vec2): void;
  tiles(): ReadonlyMap<number, TrackTile>;    version: number;
  cellAt(x: number, z: number): TrackCell | null;     // peak, dir, dose, state
  coverLnZ0(x0: number, z0: number, x1: number, z1: number): { lnSum: number; area: number };
}
SimSnapshot.groundTrack: GroundTrack (read-only to callers)
```

## Parameters

| Name | Unit | Value | Source / note |
|---|---|---|---|
| cell / tile | m | 2 / 64 | resolves gouges and lodging rows; tiles keep it sparse |
| update interval | s (sim) | 0.1 | wind at a cell changes over seconds near the core |
| sample height | m | 2 | canopy and turf height (lodging studies measure at 1–2 m) |
| crop lodging onset | m/s | 15 | wheat/cereal canopy lodging predicted ~11.6 m/s; maize stem/root failure 16–30 m/s in field trials (Berry et al. 2021; Baker et al. 2014 lodging model) |
| crops snapped | m/s | 30 | top of the maize failure range: stems break rather than bend |
| lawn pushed over | m/s | 25 | decision: mowed turf is short and stiff and sits low in the surface layer; no field data found, set above crop lodging per the design |
| scour onset u_s | m/s at 2 m | 50 | no EF2 scouring, onset within EF3 (EF3 is 61–74 m/s at 10 m, ~51–62 m/s at 2 m over open ground) |
| debris weight k_d | m²/kg | 2 (initial) | set by TERR-19 calibration |
| D₁ / D₂ / D₃ | s | 2 / 6 / 15 (initial) | set by TERR-19 calibration against the targets above |
| z₀ of states | m | see table | Wieringa (1993) classes: flattened canopy ~0.01, short grass 0.005–0.008, bare soil 0.0002–0.005 |
| gouge landing speed | m/s | 5 | below it a piece settles without marking |

All values go in `src/config/terrain.ts` with these sources. The scour thresholds are the
weakest-sourced numbers in the model: published scouring is case reports (Jarrell 1997;
Neshoba County 2014; the December 2021 Arkansas cropland scars seen from satellite), not
measured thresholds, so they are calibrated to those outcomes and logged as a simplification.

## Acceptance criteria

- **TERR-15**: The track is deterministic (same seed and inputs, same cells) and only cells
  within the active radius are updated; a map the tornado never crosses has no tiles.
- **TERR-16**: Each cell's direction is the 2 m wind's direction at its peak; across an EF2
  pass the lodged directions on both sides of the path point inward toward the track centre
  (component toward the centreline > 0 for ≥ 80% of lodged cells on each side).
- **TERR-17**: Crops lodge at a lower wind than lawn is pushed over; in an EF1 pass lodging is
  patchy and at least twice as common on the side where swirl and forward motion add.
- **TERR-18**: Scouring depends on duration and debris: the same peak with half the forward
  speed gives a larger dose and a later-or-equal state at every cell; a debris load raises the
  dose; a wind below u_s gives none.
- **TERR-19**: Calibration: preset passes over farmland give the targets: EF2 no thinned
  cells; EF3 thinning or stripping only within R_max, under half of the core's cells; EF4
  stripped or bare across most of the core and lodged-only at the edges; a slow EF5 (half
  forward speed) more bare soil than at its usual speed.
- **TERR-20**: Track width follows the core's size, not its strength: doubling R_max at the
  same V_max roughly doubles the lodged width (±25%); raising V_max at the same R_max widens it
  by less than the lodging radius of the profile implies (bounded by 3·R_max).
- **TERR-21**: Lodged and scoured cells lower the roughness: at the next roughness update the
  node over a scoured strip has a lower z₀ than before, and the 5 m wind there is higher.
- **TERR-22**: Debris landings faster than 5 m/s leave gouges and slides leave streaks along
  their paths, at the pieces' positions; slower landings leave none.
- **TERR-23**: Drawing: the renderer only reads the track; marks persist after the core passes;
  lodged cells show streaks along their stored direction; scoured cells shade toward soil in
  stage order.
- **TERR-24**: Cost: `npm run bench` shows the track adding ≤ 3% to each scene's total ms per
  physics step.

## Simplifications / out of scope

- Scour thresholds calibrated to case reports, not measured (see Parameters).
- One sample height (2 m) for crops and turf; no crop growth stage, height or soil moisture
  (wet soil scours differently).
- Debris load counted per tile, not per cell.
- No ground marks under slabs or inside the town's lots beyond the lawn's own state.
- Trees (Phase 9) will add their own marks (fallen trunks, root balls).

## Decisions

Made by Claude, prioritizing realism; see CLAUDE.md.

1. **Its own spec, extending Spec 17.** Spec 17 is approved and tested; adding untested
   criteria to it would break the trace until slice C is built.
2. **Scour as an aeolian erosion dose, weighted by debris.** It already models how the soil's
   surface responds to wind (the dust uses it) and captures duration, which observations show
   matters more than the peak.
3. **2 m cells, sparse tiles, 0.1 s updates near the core.** Fine enough for gouges and
   lodging rows, cheap enough to stay within a few percent of a step (TERR-24).
4. **Marks from debris events, not drawn decorations.** Every mark has a piece behind it.

## Changelog

- v0.1 (2026-11-26): drafted at the user's request (another session's design).
