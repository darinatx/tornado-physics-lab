# Spec 01 — Wind Field

Status: Approved (v1.10)

## Purpose

Provide the 3D wind velocity at any point and time for the current tornado state. This is the
single source of wind for loads, damage, debris and visualization. It does **not** compute
forces or damage.

## Model

Work in a storm-relative cylindrical frame centered on the vortex axis at ground level
(r = horizontal distance from the axis, z = height above ground).

### Tangential velocity (modified Rankine)

```
v_t(r) = V_max · (r / R_max)                          for r ≤ R_max
v_t(r) = V_max · (R_max / r)^α                        for R_max < r ≤ r_o
v_t(r) = V_max · (R_max / r_o)^α · (r_o / r)^α_o      for r > r_o        (r_o = n_o · R_max)
```

Radar fits of α (typically 0.5–0.8) come from the flow within a couple of core radii of the
axis. Farther out, the air spiralling in keeps its angular momentum, so the swirl falls off
like a free vortex, 1/r (α_o = 1), and the tornado's own wind fades within a few kilometres
even for the widest wedges. Carrying the slow r^(−α) decay to any distance gave EF0 winds
4 km from an EF5 core and a 5.4 km wide EF0 path. Surveyed EF5 paths are about 1–2.7 km
wide, and the widest tornado on record (El Reno, 2013) was 4.2 km.

### Vertical profile with near-ground overshoot

Real tornadoes are different from ordinary straight-line wind here. Radar (e.g. Doppler on
Wheels) and lab vortex simulators show the strongest winds **tens of meters above the
ground**, not aloft: in the "corner flow" where inflow turns upward, swirl speeds overshoot the
speed aloft. Below that peak, surface friction slows the wind, and rougher terrain slows it more.

The horizontal (tangential) speed is multiplied by a height factor h(r, z):

```
S(r)    = 1 + (S_peak - 1) · exp(-((r - R_max) / R_max)²)     overshoot, strongest near R_max

h(r, z) = S(r) · max(z / z_p, ε)^β                              for z < z_p   (friction layer)
h(r, z) = 1 + (S(r) - 1) · exp(-(z - z_p) / δ)                 for z ≥ z_p   (decays to 1 aloft)
```

The two pieces meet at z = z_p with value S(r), so the profile is continuous. `β` depends on
terrain (rougher terrain gives a bigger β and a slower near-ground wind), and ε keeps the
speed nonzero at z = 0 for numerical stability. Far from the core, S → 1 and the profile is
an ordinary rise to full speed at z_p.

### Radial inflow (boundary layer)

```
v_r(r, z) = -k_r · v_t(r) · exp(-z / δ)       (negative = inward)
```

Because v_t is linear in r inside the core, inflow automatically tapers to zero at the axis.
Air turns upward there, which is what's observed.

### Vertical velocity: one-cell and two-cell structure

Weak tornadoes are **one-celled**: air rises up the middle. Intense tornadoes are usually
**two-celled**: strong rotation drops the pressure aloft on the axis so much that air is drawn
*down* the center, while the updraft moves out into a ring near the core radius. Lab vortex
chambers show the switch is controlled by the **swirl ratio** (rotation relative to updraft),
and mobile radar shows the central downdraft and debris-free "eye" in intense tornadoes.

Swirl ratio (simplified, using the core radius as the updraft radius):

```
S = V_max / W_max
```

Blend from one-cell to two-cell between thresholds S₁ and S₂:

```
b = smoothstep((S - S₁) / (S₂ - S₁))          0 = one-cell, 1 = two-cell
x = r / R_max

one-cell shape:  f₁(x) = exp(-x²)                              updraft on the axis
two-cell shape:  f₂(x) = (x² · exp(1 - x²))² - k_d · exp(-(x / x_d)²)
                         └─ annular updraft, peak 1 at r = R_max   └─ central downdraft

v_z(r, z) = W_max · [(1 - b) · f₁(x) + b · f₂(x)] · (1 - exp(-z / δ))
```

Because S uses the current V_max, a tornado starts one-celled while spinning up and can turn
two-celled as it intensifies, then reverts while roping out. Real tornadoes do this too.

### Translation

Ground-relative wind = storm-relative wind + a carried wind. Near the vortex the air moves
with it: the carried wind is the full translation velocity `V_trans` (a horizontal vector).
With cyclonic rotation this makes the right side of the path (relative to motion) faster by
2·|V_trans| than the left, which is why real damage swaths are usually worse on the right
side. Far away it is the environmental surface wind `V_env`: a tornado is steered by the
storm's mean wind through several kilometres of depth, much stronger than the wind at the
surface, so the far-field 10 m wind is not the forward speed. Between them it blends with the
vortex's own strength:

```
g(r)   = 1 for r ≤ R_max, v_t(r) / V_max beyond      (the swirl's radial shape)
carried = g·V_trans + (1 − g)·V_env
V_env  = V_trans · min(1, U_env / |V_trans|)         along the motion, U_env = 10 m/s
```

That carried wind slows near the ground like any surface wind: it is unchanged at and above
10 m and follows the terrain power law below, (max(z/10, ε))^β.

### Pressure deficit (cyclostrophic balance)

In a tornado the inward pressure-gradient force balances the centrifugal force of the swirl
(cyclostrophic balance, dp/dr = ρ·v_t²/r). Integrating the Rankine profile aloft gives the
pressure drop relative to the far field:

```
m = n_o^(−2α)                                                  (= (R_max / r_o)^(2α))
Δp(r) = ρ·V_max² · m/(2α_o) · (r_o / r)^(2α_o)                                 for r ≥ r_o
Δp(r) = ρ·V_max² · [ ((R_max / r)^(2α) − m)/(2α) + m/(2α_o) ]                 for R_max ≤ r < r_o
Δp(r) = ρ·V_max² · [ (1 − m)/(2α) + m/(2α_o) + ½·(1 − r²/R_max²) ]            for r < R_max
```

The center deficit is ρ·V_max²·((1 − m)/(2α) + m/(2α_o) + ½). For the default tornado (60 m/s,
α 0.6) that's about 51 hPa; measured
tornado deficits range from a few hPa to about 100 hPa. Following boundary-layer theory, the
pressure field is imposed from above and taken as independent of height near the ground.
Spec 02 uses it for roof uplift; Spec 06 uses it to shape the condensation funnel.

### Lifecycle

`V_max(t) = V_peak · L(t)`, using smooth (smoothstep) ramps:
- spin-up (0 → T_up): L rises 0 → 1, and R_max shrinks from 1.5·R_max to R_max (the vortex tightens);
- mature (T_up → T_up + T_mature): L = 1;
- rope-out (T_rope): L falls 1 → 0, and R_max shrinks to 0.3·R_max (the vortex narrows into a rope).

### Gusts

Field speeds are **3-second-gust equivalent**. That's the averaging period the EF scale and
its Damage Indicators were calibrated against, so the damage model in Spec 03 can use
published failure speeds directly with no conversion. Short-period turbulent fluctuations are
not modeled in v1 (see Simplifications).

### EF rating

The EF rating comes from the peak ground-relative horizontal speed at z = 10 m, as returned by
`windAt` (so the near-ground overshoot is included). EF bounds (mph): EF0 65–85, EF1 86–110,
EF2 111–135, EF3 136–165, EF4 166–200, EF5 > 200.

## Interface

```ts
// src/core/wind/types.ts
// Vec2 is a ground-plane vector { x, z } (world Y is up).
interface TornadoState {
  center: Vec2;          // m, ground position of the axis
  velocity: Vec2;        // m/s, translation
  vMax: number;          // m/s, current peak tangential speed aloft (after lifecycle)
  rMax: number;          // m, current core radius (after lifecycle)
  alpha: number;         // outer decay exponent
  inflowRatio: number;   // k_r
  inflowDepth: number;   // δ, m
  updraftMax: number;    // W_max, m/s
  overshoot: number;     // S_peak
  zPeak: number;         // z_p, m
  rotation: 1 | -1;      // 1 = cyclonic
}
type TerrainClass = "open" | "suburban" | "urban";

// src/core/wind/windField.ts
function windAt(p: Vec3, s: TornadoState, terrain: TerrainClass): Vec3;  // m/s, world frame, ground-relative

// src/core/wind/efScale.ts
function efRating(speedMs: number): 0 | 1 | 2 | 3 | 4 | 5 | null;   // null below EF0

// src/core/wind/pressure.ts
function pressureDeficit(r: number, s: TornadoState): number;   // Pa, ≥ 0

// src/core/wind/lifecycle.ts
function lifecycle(t: number, p: LifecycleParams): { vMax: number; rMax: number };
```

`windAt` is a pure function: no side effects, no randomness, no time dependence beyond
what's in `TornadoState`.

## Parameters

| Name | Unit | Default | Range | Source / note |
|---|---|---|---|---|
| V_peak | m/s | 60 | 15–128 | aloft speed; with the near-ground overshoot and translation this spans sub-EF0 to upper EF5 (EF0 needs only ~18–22 m/s aloft) |
| R_max | m | 150 | 20–800 | rope to wedge; typical radar values 50–500 m |
| α | – | 0.6 | 0.5–1.0 | 1.0 = classic Rankine; radar-observed tornadoes typically 0.5–0.8 |
| n_o | – | 2 | — | r_o / R_max, where the decay turns to a free vortex; radar fits of α span about the first two core radii, and n_o = 2 puts the presets' EF0 path widths in the surveyed ranges (WIND-24) |
| α_o | – | 1 | — | free-vortex decay beyond r_o (angular momentum conserved by the inflow) |
| k_r | – | 0.5 | 0.0–1.0 | inflow / tangential ratio near the surface |
| δ | m | 50 | 10–200 | inflow-layer depth; observed corner-flow depths are tens of meters |
| W_max | m/s | 30 | 0–80 | core updraft; radar-observed updrafts reach 30–80 m/s |
| S_peak | – | 1.3 | 1.0–1.6 | near-ground overshoot; lab and LES studies find ~1.2–1.6 |
| z_p | m | 20 | 5–60 | height of peak winds; observed ~10–50 m |
| β (open / suburban / urban) | – | 0.11 / 0.22 / 0.33 | — | standard power-law exponents |
| ε | – | 0.005 | — | numerical floor for z / z_p (0.1 m at the default z_p) |
| S₁ / S₂ | – | 1.1 / 1.7 | — | swirl thresholds for one-cell → two-cell; calibrated so at default W_max EF0–2 are one-celled, EF3 transitional and EF4–5 two-celled, matching radar observations |
| k_d | – | 0.5 | — | central downdraft strength / W_max; observed downdrafts are weaker than the annular updraft |
| x_d | – | 0.5 | — | downdraft radius / R_max |
| ρ | kg/m³ | 1.2 | — | near-surface air density in a warm, humid storm environment |
| \|V_trans\| | m/s | 12 | 0–30 | typical forward speeds 10–20 m/s |
| T_up / T_mature / T_rope | s | 60 / 180 / 90 | — | gameplay-scaled; real lifetimes vary from minutes to over an hour |

All values live in `src/config/wind.ts`.

## Acceptance criteria

- **WIND-01**: With translation = 0 and z = 300 m, |v_t| peaks at r = R_max (±1%).
- **WIND-02**: With translation = 0, the horizontal speed is axisymmetric (equal within 1e-9
  at 8 evenly spaced angles for any fixed r, z).
- **WIND-03**: With translation V_trans, at z = 300 m (above the inflow layer), the
  ground-relative speed at r = R_max on the right of the path exceeds the left by 2·|V_trans| (±1%).
- **WIND-04**: Radial inflow at z = 4δ is < 5% of its z = 0 value at the same r.
- **WIND-05**: The radial component is inward (toward the axis) near the ground for all r > 0.
- **WIND-06**: In a one-cell vortex (S ≤ S₁) the vertical component is positive (up) in the
  core. In every regime |v_z| at r = 2·R_max is < 5% of W_max.
- **WIND-07**: At z = 300 m, between R_max and r_o, v_t decays as r^(−α) (fitted exponent within ±2%).
- **WIND-23**: At z = 300 m, beyond r_o, v_t decays as r^(−α_o) (fitted exponent within ±2%), and
  v_t is continuous at r_o (jump < 1e-9 relative).
- **WIND-08**: `windAt` is deterministic: identical inputs give identical outputs.
- **WIND-09**: `windAt` returns finite values everywhere, including r = 0 and z = 0.
- **WIND-10**: `efRating` maps the EF bounds correctly at each boundary (64, 65, 85, 86, ...
  200, 201 mph) and returns null below 65 mph.
- **WIND-11**: Setting rotation = −1 mirrors the field (the left side becomes stronger).
- **WIND-12**: With the lifecycle, V_max is 0 at t = 0, V_peak in the mature phase, and
  returns to 0 at the end of rope-out. R_max is smaller at the end of rope-out than when mature.
- **WIND-13**: At r = R_max the storm-relative tangential speed peaks at z = z_p, where it equals
  S_peak · V_max (±1%), and approaches V_max aloft (within 1% at z = z_p + 5δ).
- **WIND-14**: Near the ground (z = 5 m), urban terrain gives lower horizontal speed than
  open terrain at the same point.
- **WIND-15**: The horizontal speed profile is continuous in z at z = z_p (jump < 1e-6 relative).
- **WIND-16**: For S ≥ S₂ (two-cell), the flow on the axis is downward and the flow at
  r = R_max is upward, with the updraft peaking at R_max (±2%).
- **WIND-18**: The center pressure deficit equals ρ·V_max²·((1 − m)/(2α) + m/(2α_o) + ½) with
  m = n_o^(−2α) (±1e-9 relative); with α = α_o it is the single-power-law ρ·V_max²·(1/(2α) + ½).
- **WIND-19**: The pressure deficit is continuous at R_max and r_o, decreases monotonically with r, and
  satisfies cyclostrophic balance (dΔp/dr = −ρ·v_t²/r, numerically within 0.5%).
- **WIND-20**: The carried (translation and environmental) wind is unchanged at and above 10 m and
  reduced below it by the terrain power law; far from the core at 1 m it's slower than at 10 m,
  and slower over urban than open terrain.
- **WIND-22**: The carried wind at 10 m is g·V_trans + (1 − g)·V_env (±1e-9 relative): the full
  translation at r ≤ R_max, falling monotonically with r (g = v_t / V_max outside the core), and tending to the environmental wind
  min(|V_trans|, 10 m/s) along the motion (at 50·R_max within 15% of the way from it to V_trans).
- **WIND-21**: With a typical 15 m/s forward speed, V_peak = 94 m/s gives a 10 m peak at or
  below 135 m/s (the strongest measured tornado winds), and the maximum setting (128 m/s) gives
  380–400 mph, the hypothetical ceiling the user chose.
- **WIND-24**: Path widths match damage surveys. For the mature Spec 07 presets on open terrain,
  the EF0 path width (where the peak 10 m wind over the pass is ≥ 65 mph, both sides together)
  is 0.3–1.5 km for EF3, 0.5–2.5 km for EF4 and 1–3.5 km for EF5. Surveyed EF5 paths:
  Joplin 2011 ~1.6 km, Moore 2013 ~1.7 km, Greensburg 2007 ~2.7 km; the widest on record is
  El Reno 2013, 4.2 km, which no realistic preset may exceed.
- **WIND-17**: The axis vertical velocity decreases monotonically as S rises from S₁ to S₂,
  with no jumps (one-cell and two-cell blend smoothly).

## Simplifications / out of scope

- An analytic vortex instead of a solved flow. Mass continuity is not strictly enforced
  between the inflow, updraft and swirl components.
- The terrain class is uniform per query. No local speed-up between buildings. Phase 7 (Spec 17) makes β vary with place and wind direction.
- No short-period turbulence. Speeds represent 3-second gusts. A seeded gust-noise layer may
  be added later with its own criteria.
- In a two-cell vortex the central downdraft doesn't spread outward along the ground (the
  real near-surface outflow from the eye is not modeled); inflow is unchanged.
- The swirl ratio uses the core radius as the updraft radius; lab definitions vary, so the
  thresholds are calibrated to observed tornado behavior rather than lab values.
- No suction vortices yet. Multi-vortex mode is planned as a later spec version (WIND-2x), in Phase 10 (storm structure).
- The core pressure deficit is defined in Spec 02 (loads), not here.

## Decisions

Made by Claude, prioritizing realism; see CLAUDE.md.

1. **Gust basis:** speeds are 3-second-gust equivalent, because the EF scale and its damage
   data are calibrated to that period. Using the same basis lets Spec 03 use published failure
   speeds directly.
2. **Near-ground overshoot:** included in v1 (S_peak = 1.3 at z_p = 20 m). It's one of the
   most important real features for damage, because peak winds sit at rooftop and treetop
   height, not aloft.
3. **Inflow inside the core:** inflow follows v_t, so it tapers linearly to zero at the axis
   with no extra rule.
4. **Two-cell structure:** added in v1.2. Intense tornadoes have a central downdraft and an
   annular updraft; a single central updraft is only right for weak ones.
5. **Far-field wind (v1.8):** the translation velocity is carried with the vortex (weight
   g(r), the swirl's own radial shape), and the wind far away is an environmental surface
   wind of at most 10 m/s at 10 m (typical of tornadic environments; storm motion follows the
   0–6 km mean wind). Adding V_trans everywhere made a 30 m/s tornado blow 67 mph across the
   whole map.
6. **Outer decay (v1.10):** the r^(−α) decay holds out to r_o = 2·R_max, then turns to a free
   vortex (1/r). Radar fits of α cover the near-core flow; beyond it, angular-momentum
   conservation gives 1/r. Calibrated against damage-survey path widths: the old unbounded
   r^(−α) gave EF0 winds 4 km out on the right of an EF5 (5.4 km EF0 path, wider than the
   record). Peak winds are unchanged. Found by the user.

## Changelog

- v1.10: outer decay turns to a free vortex (1/r) beyond r_o = 2·R_max (WIND-23, WIND-24;
  WIND-07, WIND-18, WIND-19 and WIND-22 reworded). The carried wind's weight follows the same
  shape, and the pressure deficit and condensation funnel follow from it. Center deficit at
  default α drops ~11% (58 → 51 hPa for the default tornado). EF0 path widths: EF5 preset
  5.4 → 3.0 km, EF4 2.4 → 1.7 km, EF3 0.95 → 0.78 km; peaks unchanged. Found by the user (BL-017).

- v1.9: optional tunnel flow on the wind state (`TornadoState.tunnel`, Spec 12): when set, `windAt` and
  `pressureDeficit` return the wind tunnel's power-law wind and uniform deficit instead of the vortex's.
  The tornado field is unchanged.
- v1.8: the translation velocity is carried with the vortex and blends to a ≤ 10 m/s
  environmental surface wind far away (WIND-22, WIND-20 reworded). Found by the user: with a
  30 m/s forward speed, 67 mph of wind blew across the whole map and damaged houses far from
  the tornado.
- v1.7: at the user's request, V_peak may go to 128 m/s (~400 mph at 10 m) to explore
  tornadoes beyond anything observed; the UI flags winds above the record as hypothetical
  (Spec 07, INST-11).
- v1.6: V_peak maximum lowered from 135 to 94 m/s (WIND-21). V_peak is the aloft speed; with
  the near-ground overshoot and translation, 135 m/s produced ~190 m/s at rooftop level, far
  beyond any measured tornado, and damage extended unrealistically far. Found by the user.
- v1.5: ε lowered from 0.05 to 0.005. The old floor held the profile constant below 1 m, so
  wind at ground level stayed near 94% of the peak and dragged resting debris along with the
  tornado. Heights of 1 m and above (houses, EF readout) are unaffected.
- v1.4: environmental wind follows the surface-layer profile below 10 m (WIND-20). Found in
  Phase 3: debris on the ground was being pushed by the full 15 m/s storm motion and never settled.
- v1.3: V_peak range lowered to 15 m/s (INST-06 showed EF0/EF1 presets need less than 30 m/s
  aloft once the near-ground boost is counted).
- v1.3: pressure deficit from cyclostrophic balance (moved here from Spec 02 so the funnel
  and probe can use it); WIND-18 and WIND-19.
- v1.2: one-cell / two-cell vertical structure driven by the swirl ratio; WIND-06 scoped to
  one-cell; added WIND-16 and WIND-17.
- v1.1: implementation alignment: added zPeak to TornadoState and defined Vec2 as {x, z};
  WIND-03 is evaluated at 300 m and WIND-13 on the tangential component (near the ground the
  inflow adds to the horizontal speed); T_mature default 180 s so the whole path fits the map.
- v1.0: resolved the open questions (see Decisions); added the overshoot profile (replacing
  the plain power law) and WIND-13 to WIND-15; WIND-04 moved to 4δ; WIND-01 and WIND-07 now
  test at 300 m, above the overshoot layer. Approved.
- v0.1: initial draft.
