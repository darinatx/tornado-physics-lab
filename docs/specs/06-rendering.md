# Spec 06 — Rendering

Status: Approved (v1.5) — Phases 1–4

## Purpose

Draw the simulation with Three.js. Rendering only reads sim state; it never changes it, and it
can be removed without affecting physics results.

## Model

Phase 1 scope:
- **Scene:** a 6 km × 6 km ground plane with a faint 100 m grid for scale (Y-up, meters), sky-colored background, a sun light
  and an ambient light.
- **Camera:** perspective camera with orbit controls (`OrbitControls`). It starts about 1.1 km
  from the tornado, looking down at roughly 35°. An optional "follow" toggle keeps the orbit
  target on the tornado center.
- **Wind arrows:** one `InstancedMesh` of arrows on a world-fixed grid (so arrows don't slide)
  within ±arrowRange of the tornado, sampled at the arrow height (Spec 07). Each arrow points along the horizontal wind, its length scales with speed
  (capped), and its color follows the EF band of its speed (gray below EF0).
- **Condensation funnel (physics-shaped):** the visible funnel is where the pressure drop
  cools rising air enough to condense. Lifting air from height z to the cloud base H lowers
  its pressure by about ρ·g·(H − z), so cloud forms at height z wherever

  ```
  Δp(r) ≥ ρ·g·(H − z)
  ```

  This gives the funnel radius at each height by inverting Δp(r) (Spec 01). The funnel
  narrows toward the ground and ends where the center deficit equals ρ·g·(H − z). Weak
  tornadoes or high cloud bases give a funnel that doesn't reach the ground, as in real life.
  The radius is capped at 1.6·R_max, where it blends into the wall cloud. It's drawn as a
  deforming lathe mesh with a shader that streaks and rotates at the real angular rate
  V_max / R_max.
- **Dust and debris tracers:** about 8,000 soft particles that follow `windAt` exactly (fine
  dust tracks the air). They spawn at random points near the ground within 2·R_max where the
  ground wind exceeds the dust-lifting threshold (25 m/s), and die after their lifetime, above
  0.8·H, or beyond 4·R_max. They use their own seeded RNG (visual only). Heavy debris with
  inertia is Spec 04.
- **Storm environment:** a cloud deck at the cloud base, visible from below; a lowered wall
  cloud around the tornado; overcast storm lighting and fog; procedurally textured farmland.
  Lighting favors readability over a realistically dark storm, and a Brightness control
  (exposure 0.5–2×) lets the viewer adjust it.
- **Component houses (Phase 4):** each house is drawn from its components (Spec 03): wall
  panels, window panes, garage door, roof sections (covering color while intact, bare plywood
  once the covering is gone, gone with the deck), rafters (visible where the deck is gone),
  gable ends, interior partitions, slab, sill plates (visible once walls are down) and anchor
  bolts (visible on a swept slab). A panel that lost its siding shows bare sheathing, a
  section that lost its covering shows bare plywood, and a broken pane shows a dark opening;
  these always show through the damage tint, so stripped walls and roofs look stripped. Each
  failed component disappears from the house as its debris or rubble appears (Spec 04). A
  shifted house is drawn offset from its slab. "Damage colors" tints a house's remaining walls
  and roof by its DOD band: yellow (1–2), orange (3–4), red-orange (5–6), red (7–8), purple
  (9–10). Each house redraws only when its own damage changes.
- **Flying debris (Phase 3):** one instanced unit box per piece, scaled to the piece's real
  dimensions and rotated by its tumbling orientation. Colored by kind: the house's roof color
  for shingles, its wall color for siding, tan for OSB and lumber, pale blue for glass, gray for
  wall chunks. Resting pieces lie flat. A "Flying debris" layer toggle controls it.
  Real-size pieces (1–4 m) are nearly invisible from the default 1–2 km view, as they are when
  filming real tornadoes. An "Enlarge debris ×3" display option exists for spotting small
  debris from afar but is off by default: everything is drawn at true size. It changes
  drawing only, never the physics, and applies only to small pieces: full-size components
  (wall panels, roof sections, deck sections, garage doors) are always drawn at their real size.
- **R_max ring:** a faint ring on the ground at R_max.
- **Layers:** arrows, funnel and tracers can each be toggled. Arrows are off by default, so the
  first view is the storm itself; they're one click away for analysis.
- **Picking:** `pick(ndc)` returns the ground point under the cursor, for the probe (Spec 07).
- **Probe markers:** a hover ring, and a colored pole for each pinned probe.
- **Interpolation:** render positions are interpolated between the last two physics states
  with the loop's alpha (Spec 08), so motion stays smooth at any frame rate.

## Interface

```ts
// src/render/renderer.ts
function createRenderer(canvasHost: HTMLElement): SimRenderer;
interface SimRenderer {
  draw(prev: SimSnapshot, curr: SimSnapshot, alpha: number): void;
  resize(width: number, height: number): void;
  setFollow(follow: boolean): void;
  setLayers(l: { arrows: boolean; funnel: boolean; tracers: boolean }): void;
  pick(ndcX: number, ndcY: number): Vec3 | null;      // ground point under the cursor
  setProbes(hover: Vec3 | null, pins: { point: Vec3; color: number }[]): void;
  dispose(): void;
}

// src/core/wind/condensation.ts
function condensationDeficit(z: number, cloudBase: number): number;      // Pa
function funnelRadius(z: number, s: TornadoState, cloudBase: number, maxRadius?: number): number;
function funnelBottom(s: TornadoState, cloudBase: number): number;       // m

// src/render/tracers.ts: pure particle state, no Three.js
class TracerField { constructor(count: number, seed: number); update(dt, s, terrain, cloudBase): void; }
```

## Parameters

| Name | Unit | Default | Note |
|---|---|---|---|
| groundSize | m | 12000 | square; fits the longest preset path |
| tracerCount | – | 8000 | |
| dustLiftSpeed | m/s | 25 | ground wind needed to loft dust |
| maxArrowLength | m | 34 | arrow length at or above the EF5 threshold |
| maxArrowWidth | m | 7 | |
| arrowRange | m | 1000 | arrows drawn within this half-width of the tornado |

## Acceptance criteria

- **REND-01**: The arrow color mapping assigns each speed to its EF band color, using the same
  `efRating` as Spec 01, and gray below EF0.
- **REND-02**: Arrow length scales linearly with speed and is capped at `maxArrowLength`.
- **REND-03**: Interpolating snapshots with alpha = 0 gives the previous state, alpha = 1 the
  current state, and values in between are linear.
- **REND-04**: Rendering never mutates sim state (snapshots are unchanged after `draw`).
- **REND-05**: At every height with a funnel, Δp(funnelRadius(z)) equals ρ·g·(H − z) (±0.1%),
  unless capped; the radius never decreases with height.
- **REND-06**: The funnel bottom is where the center deficit equals ρ·g·(H − z); the funnel
  reaches the ground exactly when the center deficit ≥ ρ·g·H.
- **REND-09**: `debrisInstance(p, enlarge)` scales a unit box to the piece's dimensions times
  `enlarge`, uses its orientation, places it at its position (grounded pieces raised by half
  their drawn thickness), and colors it by kind as specified.
- **REND-08**: `houseInstances(b, damageColors)` shows exactly the standing components:
  failed panels, panes, sections and bays are hidden; a section shows plywood color once its
  covering is gone; rafters show only where the deck is gone and the bay stands; sill plates
  show once all walls are down; bolts only on a swept slab; shifted houses are offset; DOD
  color tints apply only in damage-color mode.
- **REND-07**: Tracers are deterministic for a given seed and update sequence, and every live
  tracer stays above the ground, below 0.8·H, and within 4·R_max of the axis.

## Simplifications / out of scope

- The funnel ignores moisture variation, and the condensation criterion is the dry-adiabatic
  approximation Δp ≈ ρ·g·Δz.
- Tracers are massless dust. Inertial debris is Spec 04.
- No buildings in Phase 1.
- Visual checks (does it look right, frame rate) are demo checklist items, not unit tests.

## Changelog

- v1.5: component houses; debris field drawn with multiplicity (REND-08 rewritten).
- v1.4: flying debris layer (REND-09); brighter default lighting and a Brightness control.
- v1.3: houses with damage visuals and damage colors (REND-08).
- v1.2: first visual pass pulled forward from Phase 5 at the user's request: physics-shaped
  condensation funnel, dust tracers, storm environment, layer toggles, picking and probe markers.
- v1.1: larger ground (whole path fits), arrow window around the tornado, bigger arrows and a
  closer camera for readability, R_max ground ring, setFollow.
- v1.0: Phase 1 scope written and approved.
