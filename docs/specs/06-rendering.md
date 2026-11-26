# Spec 06 — Rendering

Status: Approved (v1.16) — Phases 1–4

## Purpose

Draw the simulation with Three.js. Rendering only reads sim state; it never changes it, and it
can be removed without affecting physics results.

## Model

Phase 1 scope:
- **Scene:** a 6 km × 6 km ground plane with a faint 100 m grid for scale (Y-up, meters), sky-colored background, a sun light
  and an ambient light.
- **Camera:** a perspective camera that can go anywhere above the ground, from street level
  (eye height, 1.7 m) to the whole map. It starts over the town center, 100 m up, facing where
  the tornado spawns (REND-17). Mouse, as in map apps: drag (one finger) to slide over the
  ground, right-drag (or Ctrl/⌘/Shift + drag) to turn the camera in place, like turning your
  head (left/right, and up/down to 85° from level), scroll to zoom toward the cursor (down to
  2 m from the point you look at). Keyboard: W/S forward and back level along the ground, A/D
  left and right, ↑/↓ (or Page Up/Down) height, ←/→ turn in place (90°/s), Q/E tilt down and
  up, Shift 4× faster (REND-14, REND-15); flying speed scales with height (~1.2 m/s per metre
  above the ground, 10–1,000 m/s), so you creep along a street and cross the town quickly from
  high up. The camera and the point it looks at never go below 1.7 m and 0 m. The keys work
  whatever has focus except a text field being typed in (REND-16). **Follow** ("Camera follows
  tornado", off to start): turning it on turns the camera to the core without moving it, then
  carries it along with the tornado (REND-19). While following, the camera always faces the
  core: zoom heads straight at it, ↑/↓ keep facing it, and anything that would point the camera
  elsewhere (sliding, W/A/S/D, turning in place) turns follow off, so the checkbox is ticked
  exactly when the camera is following and facing the core. A hint line lists the controls.
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
  W/S forward and back level along the ground in the direction the camera faces (tilt doesn't
  change the height), A/D left and right along the ground, ↑/↓ (and PageUp/PageDown) straight
  up and down. The camera never goes below 1.7 m. The orbit point keeps its direction and
  distance from the camera, but never goes below the ground (it lands where the view meets it).
- **REND-15**: Turning moves only the point the camera looks at: the camera stays put, the
  look direction rotates by the yaw about the vertical and by the pitch about the camera's
  right axis, pitch stays within ±85° of level, and the look point never goes below the
  ground (looking down, it lands where the view meets the ground). Keys: ←/→ turn left/right,
  Q/E tilt down/up; right-drag turns too.
- **REND-17**: The starting view is over the center of town, 100 m up, facing where the
  tornado spawns: looking at its axis at 40% of the cloud-base height (if it spawns within
  1 m of the town center, along its heading). Follow is off to start.
- **REND-16**: Held keys never stick: a key-up always releases its key (whatever has focus or
  modifiers), pressing ⌘, Ctrl or Alt releases every flying and turning key (macOS sends no
  key-up for keys released while ⌘ is held), and so does the page losing focus or visibility.
  The camera keys work whatever has focus (the side panel's checkboxes, menus, buttons and
  sliders included, and the keys don't also change them), except a text or number field being
  typed in; Enter or Escape there ends typing.
- **REND-18**: A new run (restart, preset, repeat) never moves the camera: it stays where it
  is, looking where it was. Follow stays as it was, carrying the camera with the new tornado's
  motion from there (the jump to the new start point is not a move to follow).
- **REND-19**: Turning follow on never moves the camera: it stays where it is and turns,
  over 0.6 s (eased), to look at the core's center on the ground, the middle of the R_max
  ring (if it is within 1 m of the axis, it keeps its heading and looks out along it). From then on it moves
  with the tornado, by the tornado's motion, so its angle to the tornado stays the same. While
  following it keeps facing the core: zooming goes straight toward the look point (not the
  cursor), height changes keep the look point on the axis, and moving along the ground or
  turning in place turns follow off.
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

1. **Start over the town, facing the spawn (v1.13, replacing v1.11's framing on the
   tornado):** at the user's request: you see the town and the tornado coming toward it, and
   follow starts off. 100 m up clears the houses and trees and shows the town's layout; the
   look point sits partway up the funnel so the tornado is in view rather than the ground at
   its foot.
5. **Follow turns to the core rather than moving the camera (v1.14):** at the user's request:
   v1.13 kept the view angle by sliding the camera until its old look point sat on the core,
   which jumped the camera by however far that point was from the tornado (kilometres, after
   flying around). The camera now stays put and turns to the core, eased so the view doesn't
   snap.
6. **Follow means facing the core (v1.15):** found by the user: turning in place or zooming
   toward the cursor while following left the camera aimed away with follow still ticked, so
   clicking the box turned follow off instead of re-aiming. Anything that aims the camera away
   now ends follow (as moving already did), and zoom goes straight at the core while following.
7. **Follow aims at the core's ground center (v1.16):** found by the user: aiming at the axis
   40% of the way up to the cloud base put the ring's far edge in the middle of the screen from
   a low camera (the raised point lines up with the far side of the ring), not its center. The
   ground center is the core's center wherever the camera is; the funnel rises above it. The
   start view keeps its raised aim, since it looks at the spawn from far off to show the funnel.
2. **Forward is level (v1.12, replacing v1.11's forward along the view):** at the user's
   request, W/S keep the height and ↑/↓ set it, like walking or a drone holding altitude, so
   looking down while moving doesn't lose height. The heading is the view's direction along the
   ground (the pitch limit of ±85° keeps it defined).
3. **Keys from anywhere but a text field (v1.12):** at the user's request, the keys keep
   flying after a click in the side panel. Text and number fields still get their keys while
   being typed in (arrows move the caret, letters type); Enter or Escape hands the keys back.
   Arrow keys on a focused menu would change its choice, so the camera takes them instead.
4. **A new run leaves the camera alone (v1.12):** at the user's request. The start view
   (REND-17) is placed only on the first load.

## Changelog

- v1.16: follow aims at the core's center on the ground, the middle of the R_max ring, not
  40% of the way up the axis (REND-19). Found by the user: from a low camera the ring's far
  edge sat in the middle of the screen.

- v1.15: while following, the camera keeps facing the core: turning in place ends follow and
  zoom heads straight at the core (REND-19). The camera description is brought up to date
  with the v1.12–v1.14 controls.

- v1.14: turning follow on no longer jumps the camera: it stays put and turns to face the
  core over 0.6 s (REND-19 rewritten). Found by the user.

- v1.13: at the user's request: the camera starts over the town center, 100 m up, facing the
  spawn point, with follow off (REND-17 rewritten); turning follow on keeps the angle and
  moves the camera to look at the core (REND-19).

- v1.12: new key layout at the user's request: W/S forward and back level, A/D left and right,
  ↑/↓ height, ←/→ turn, Q/E tilt (REND-14, REND-15). The keys work after clicking in the side
  panel (REND-16). A new run no longer moves the camera (REND-18): follow mode carried it
  across the jump to the new start point.

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
