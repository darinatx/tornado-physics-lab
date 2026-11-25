# Spec 06 — Rendering

Status: Approved (v1.11) — Phases 1–4

## Purpose

Draw the simulation with Three.js. Rendering only reads sim state; it never changes it, and it
can be removed without affecting physics results.

## Model

Phase 1 scope:
- **Scene:** a 6 km × 6 km ground plane with a faint 100 m grid for scale (Y-up, meters), sky-colored background, a sun light
  and an ambient light.
- **Camera:** a perspective camera that can go anywhere above the ground, from street level
  (eye height, 1.7 m) to the whole map. It starts over the city on the side the tornado is
  coming toward: on the track 1 km inside the town from where the track enters it (at least
  1.5 km ahead of the tornado), 30% of that distance off to the right of the track, 150 m up,
  looking back at the approaching tornado (aimed at 15% of the cloud-base height on its
  axis, so the town fills the foreground). Mouse, as in map apps: drag (one finger) to slide over the ground, right-drag (or
  Ctrl/⌘/Shift + drag) to turn the camera in place, like turning your head (left/right, and
  up/down to 85° from level), scroll to zoom toward the cursor (down to 2 m from the point
  you look at). Keyboard: W/A/S/D fly forward, left, back and right along the ground in the
  direction you face, the arrow keys turn in place (90°/s), E/Q (or Page Up/Down) rise and
  sink, Shift is 4× faster;
  flying speed scales with height (~1.2 m/s per metre above the ground, 10–1,000 m/s), so you
  creep along a street and cross the town quickly from high up. The camera and the point it
  orbits never go below 1.7 m and 0 m. Keys are ignored while typing in a panel field. Sliding
  or flying turns off "Camera follows tornado" (turning and zooming keep it). With follow on,
  the camera is carried along as the tornado moves, keeping the view you chose; turning it on
  brings the tornado back to the middle of the view. A hint line lists the controls.
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
- **Dust and debris tracers:** soft particles that follow `windAt` exactly (fine dust tracks
  the air). Dust lifts wherever the ground wind (at 3 m) exceeds the lifting threshold
  u_t = 25 m/s, within the damage range (6·R_max, Spec 03), at the standard dust-emission rate
  F ∝ u³(1 − u_t²/u²) (Gillette & Passi 1988): tracers spawn near the ground at random points
  of that area, accepted in proportion to F, so the cloud is dense where winds are strong and
  thins to a haze at the edge. The number of tracers follows the total emission ∫F dA
  (surveyed 4 times a second on a polar grid): ~12,000 for the default tornado at full
  strength, at least 2,000 while any dust lifts, capped at the measured frame budget (40,000);
  beyond the count, tracers retire as they die, so the cloud grows and fades with the tornado.
  They die after their lifetime, above 0.8·H, or beyond max(4·R_max, 1.5 × the dust radius).
  They use their own seeded RNG (visual only). Heavy debris with inertia is Spec 04. (The
  structure lab keeps a fixed count around the core: it's viewed from tens of metres.)
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
| tracersPerEmission | 1/(m²·(m/s)³) | 7.8e-8 | ~12,000 tracers for the default tornado |
| tracerMin / tracerCap | – | 2000 / 40000 | measured at the cap: ~3.3 ms CPU per frame, no measurable GPU cost far or inside the cloud |
| dustRangeRmax | – | 6 | dust lifts within the damage range |
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
  tracer stays above the ground, below 0.8·H, and within max(4·R_max, 1.5 × the dust radius)
  of the axis.
- **REND-12**: Dust spawns only where the ground wind exceeds u_t, within 6·R_max, over the
  whole area where it does (a tornado whose lifting area reaches beyond 2·R_max gets dust
  there), with spawn density in proportion to the emission rate F.
- **REND-14**: Moving moves the camera and its orbit point together, at ~1.2 m/s per metre of
  height (clamped 10–1,000 m/s, ×4 with Shift), at the same speed whatever keys are combined:
  W/S along the full 3-D view direction (looking down, W moves toward the ground), ←/→ sideways
  along the ground, ↑/↓ (and PageUp/PageDown) straight up and down. The camera never goes below
  1.7 m: moving forward into the floor stops there. The orbit point keeps its direction and
  distance from the camera, but never goes below the ground (it lands where the view meets it).
- **REND-15**: Turning moves only the point the camera looks at: the camera stays put, the
  look direction rotates by the yaw about the vertical and by the pitch about the camera's
  right axis, pitch stays within ±85° of level, and the look point never goes below the
  ground (looking down, it lands where the view meets the ground). Keys: A/D pan left/right,
  Q/E tilt down/up; right-drag turns too.
- **REND-17**: The starting view frames the tornado: the camera is 30 m up, looking at the
  axis at 40% of the cloud-base height, from ahead of it on its track and 30% to the right, at
  the nearest distance (at least 300 m) where the funnel from the ground to the cloud base
  fills no more than 80% of the view's height and a 4·R_max-wide debris cloud (R_max at
  maturity: the core is wider while it spins up) no more than 60% of its width.
- **REND-16**: Held keys never stick: a key-up always releases its key (whatever has focus or
  modifiers), pressing ⌘, Ctrl or Alt releases every flying and turning key (macOS sends no
  key-up for keys released while ⌘ is held), and so does the page losing focus or visibility.
- **REND-13**: The tracer count follows the total emission, within [2,000, 40,000]: a larger
  or stronger tornado gets more tracers, a tornado lifting no dust none, and the count drops as
  the tornado weakens.

## Simplifications / out of scope

- The funnel ignores moisture variation, and the condensation criterion is the dry-adiabatic
  approximation Δp ≈ ρ·g·Δz.
- Tracers are massless dust. Inertial debris is Spec 04.
- No buildings in Phase 1.
- Visual checks (does it look right, frame rate) are demo checklist items, not unit tests.

## Decisions

1. **Start distance from framing, not the town (v1.11):** the camera is placed by what it has to
   show (ground to cloud base, the debris cloud's width) rather than the town's edge, so it is
   never kilometres away. Follow mode (on by default) keeps the offset, so the tornado doesn't
   run into the camera.
2. **Forward follows the view, including tilt (v1.11):** at the user's request, like a drone
   camera. Hitting the eye-height floor stops forward motion rather than sliding along the
   ground, so the view never changes direction unasked.

## Changelog

- v1.11: new key layout at the user's request: W/S forward and back along the view (tilt
  included), A/D pan, Q/E tilt, arrows move up/down and sideways (REND-14, REND-15). The
  starting view is framed on the tornado at a few hundred metres to ~1.5 km by its size
  (REND-17): it could start 3 km or more away when the track began far outside town.


- v1.10: the camera starts over the city ahead of the tornado, facing it (REND-17), at the
  user's request (it started behind the tornado).

- v1.9: held camera keys can't stick (REND-16). Found by the user: the camera sometimes kept
  flying forward or back. Key-ups that came with ⌘/Ctrl/Alt were ignored, macOS sends none
  for keys released while ⌘ is held, and focus could leave without a window blur.

- v1.8: logarithmic depth buffer in the main view (the lab already had one). Found by the user:
  debris lying on the ground flickered in and out as the camera moved. A shingle's top is
  2.5 mm above the ground, and with the camera's 1 m–30 km range a linear depth buffer can't
  separate the two a few hundred metres away.

- v1.7: free camera at the user's request: keyboard flying with height-scaled speed, map-style
  panning (left-drag pans, right-drag turns: with orbit on the left button the view kept
  turning around the same point), zoom to the cursor, down to street level (REND-14). Right-drag
  and the arrow keys turn the camera in place, not around a far-off point (REND-15).
- v1.6: dust lifts over the whole area where the ground wind exceeds the threshold (within
  the damage range), weighted by the dust-emission rate, and the tracer count follows the total
  emission (REND-12, REND-13; REND-07 bounds). At the user's request: the fixed 2·R_max area
  left wide tornadoes damaging far beyond their dust.
- v1.5: component houses; debris field drawn with multiplicity (REND-08 rewritten).
- v1.4: flying debris layer (REND-09); brighter default lighting and a Brightness control.
- v1.3: houses with damage visuals and damage colors (REND-08).
- v1.2: first visual pass pulled forward from Phase 5 at the user's request: physics-shaped
  condensation funnel, dust tracers, storm environment, layer toggles, picking and probe markers.
- v1.1: larger ground (whole path fits), arrow window around the tornado, bigger arrows and a
  closer camera for readability, R_max ground ring, setFollow.
- v1.0: Phase 1 scope written and approved.
