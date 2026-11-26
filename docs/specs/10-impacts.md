# Spec 10 — Debris Impacts

Status: Approved (v0.14) — Phase 6 slice A (impact physics and component houses) and the first
part of slice B (detail-zone pieces hit the houses around them). The rest of slice B is outlined
at the end.

## Purpose

Flying debris is one of the main ways tornadoes damage buildings: it breaks windows (which
opens the house to internal pressure), punches through walls and roofs, strips siding and
shingles, and heavy pieces knock walls down. This spec makes the debris of Spec 04 hit the
houses it meets, with damage decided by the impact's momentum and energy against test values
for each kind of surface. Pieces no longer pass through standing houses.

## Model

### Envelope

A component house's envelope is a convex solid in its local frame (Spec 03 axes, including any
shift off the foundation): the box |x| ≤ W/2, |z| ≤ D/2, 0 ≤ y ≤ y_eave, under the two roof
planes y ≤ y_eave + rise · (1 − |z| / (D/2)), with y_eave = slab top + wall height. The
overhang isn't part of the solid. The surface is divided into what stands there:

| Surface | Where | Component |
|---|---|---|
| Wall face | eave walls (±z), end walls (±x) up to y_eave | the wall panel at that position along the face |
| Window | the pane's 1.2 × 1.2 m square in its panel | the pane |
| Garage door | 4.9 × 2.2 m in its panel | the garage door |
| Gable | end walls above y_eave | the end wall's panel at that position (no windows) |
| Roof plane | front and back slopes | the roof section at that column, slope and row |

**Openings** are where the surface is gone: a failed wall panel (and the gable above it), a
broken pane, a failed garage door, a roof section whose deck or bay has failed. A swept house
has no envelope.

Decisions:
- Convex solid, no overhang: a few-percent area error at the eaves, and it makes the hit test
  an exact segment clip.
- Surfaces belong to components already in Spec 03, so every impact changes something the
  damage model, the survey and the inspector already know about.

### Hit detection

Every debris step (60 Hz), each airborne or sliding piece's center moves along a segment.
For each component house near the segment's end, the segment is clipped against the envelope
(Cyrus–Beck):

- **Entering** (starts outside, crosses a surface): if the crossing point is on an opening,
  the piece passes in, and the rest of the step is clipped from inside (it may still leave
  through a standing surface in the same step: a corner cut); otherwise it is an impact on that
  surface.
- **Leaving** (starts inside, crosses a standing surface from inside): the piece bounces back
  inside, with no damage (debris that got into a house stays in it until an opening lets it
  out).
- Pieces that start inside and leave through an opening pass freely.

**Piece size.** The piece touches a surface when its box does, not its center: from outside,
each plane of the solid is moved out by half the piece's box extent along that plane's normal
(in its current orientation); from inside, moved in by it. A piece that turns into a surface
without its center moving (tumbling next to a wall) is a hit at the start of the step on the
least-penetrated plane. The contact point (the center projected onto the real surface) picks
the component.

**Slabs.** Every house keeps its slab, a 0.3 m concrete box (component houses: 0.3 m wider
than the walls on each side, as drawn; detailed houses: flush with the wall frames), even when
everything on it has gone. A piece low on the ground that runs into a slab's side bounces off
it like a curb (no damage). A piece on or above a slab has the slab top as its ground: it
lands, slides and rests there, and rubble that falls onto a slab lies on it.

A wall panel that falls outward pivots on the slab's outer edge and comes to rest leaning:
its base on the slab top at the edge, its top on the ground (a wall slides off its sill as it
tips over; lying flat, half of it would be inside the slab's overhang).

Nothing stays inside a slab: a piece whose box ends a step overlapping one (after a bounce at
a wall's base, tumbling, or spawning) is pushed out the shortest way, up onto the top or out
past the nearest side, and loses its speed into the slab; a piece whose center is off the slab
always goes out past the side (it can't hang half on the slab). This is checked after the
piece has moved, bounced and snagged. A piece that snags while sliding on a slab is laid flat
on the slab top.

Decisions:
- Box extent along each plane normal (the exact separation for a box against a plane): cheap
  (seven dot products per house tested), and long siding strips and lumber no longer poke
  through walls. Debris is stepped at 60 Hz, so a 60 m/s piece moves 1 m per step and the
  segment test never tunnels.
- The slab is a step to climb, not a ramp: a piece crosses onto it only from above (flying or
  bouncing), as debris against a real 0.3 m slab edge does.
- Detailed houses (Spec 09) are skipped until slice B.

### What an impact does

The impact's measures use the normal component of the piece's velocity, v_n = −v·n̂ (n̂ the
outward surface normal):

```
momentum   p = m · v_n                     (kg·m/s)
energy     E = ½ · m · v_n²                (J)
```

Each surface has one or more failure modes with lognormal fragility (median, β). Strong
construction (impact-rated windows) multiplies the glazing threshold by 1.4, as in Spec 03.

| Surface | Mode | Measure | Median | β | Applies to |
|---|---|---|---|---|---|
| Window (annealed) | breaks | p | 0.4 kg·m/s | 0.5 | rods and compact pieces (edge, corner or point contact) |
| Window (annealed) | breaks | p | 1.2 kg·m/s | 0.5 | sheets (contact spread over a face or long edge) |
| Wall (vinyl siding, 12 mm OSB) | perforated | E | 250 J | 0.4 | rods and compact pieces under 60 kg |
| Roof (shingles, 12 mm OSB deck) | perforated | E | 250 J | 0.4 | rods and compact pieces under 60 kg |
| Garage door (steel, foam core) | perforated | E | 150 J | 0.4 | rods and compact pieces under 60 kg |
| Vinyl siding | torn | E | 15 J | 0.5 | any piece hitting a wall face |
| Shingles | torn off | E | 60 J | 0.5 | any piece hitting a roof plane |

Sources and checks:
- Glass: residential annealed glass breaks under very light debris; Masters, Gurley, Shah &
  Fernandez (2010, *Engineering Structures*) built momentum fragility curves for annealed
  window glass from ~600 impacts and found momentum the better predictor. Small-missile tests
  (ASTM E1996: 2 g steel ball at 39.6 m/s, 0.08 kg·m/s) are the standard that impact-rated
  glazing must pass. *The medians above are set from that work's range and still have to be
  checked against the paper's tables.* A shingle at 10 m/s carries 10 kg·m/s: any real debris
  hit at storm speeds breaks ordinary glass, as surveys show.
- Walls: a 4.1 kg (9 lb) 2×4 at 15.2 m/s (34 mph, ~470 J) went through vinyl- and
  fiber-cement-sided walls with 1/2 in. OSB sheathing (BIA-sponsored test, reported by NAHB);
  Texas Tech found 2×4 missiles pass through wood-frame walls with little damage to the
  missile; tornado shelters are designed for a 6.8 kg (15 lb) 2×4 at 44.7 m/s (100 mph,
  6.8 kJ; FEMA P-361 / ICC 500). Median 250 J gives a 95% chance for the 34 mph test and
  certainty at the shelter missile.
- Siding: vinyl siding is brittle in impact (a few joules cracks it in ASTM D4226 dart tests);
  tearing it off the nails takes more, hence 15 J.
- Shingles: UL 2218 hail-impact classes (steel balls, 5–30 J); ordinary shingles crack at the
  low end, and tearing them off takes more, hence 60 J.

Sheets (shingles, siding, plywood, wall and roof panels) don't perforate: their contact
spreads over an edge or face. Pieces of 60 kg or more are panels and sections whose effect is
the impulse load below.

**Fragility draws.** A pane's breaking threshold is a property of that pane (its flaws), fixed
per house and pane by a hash of their ids, so repeated hits on one pane meet the same
strength. Siding and shingle thresholds are likewise per component. Perforation depends on
where it lands (on a stud or between studs) and how the piece is turned, so it's drawn per hit
from the debris field's seeded RNG.

**Impulse load.** Every impact on a wall face or garage door also pushes on that component:

```
F = min( m · v_n · (1 + e) / τ ,  σ_c · A_c )
e = 0.2 (restitution), τ = 0.1 s (contact time), σ_c = 5 MPa, A_c = the piece's smallest cross-section (width × thickness)
```

τ is the wood-on-wood contact duration used in Spec 09 (framing crushes and flexes); σ_c is
lumber's crushing strength perpendicular to the grain (~4–7 MPa), so a piece can't deliver
more force than its own end crushes at. F spread over the component's area is an equivalent
pressure, added inward to that component's net load at the next damage evaluation (Spec 03).
Quasi-static: a wall panel's natural period (~0.05–0.1 s) is close to τ, so dynamic
amplification is about 1. Impacts on roof planes push down, which Spec 03's uplift checks
don't use, so they cause only perforation and shingle damage.

**Damage areas.** One hit damages a patch, not a whole component:

- A torn siding hit strips 0.5 m² from its panel; the panel's siding counts as failed (Spec 03,
  released as debris) once half its area is stripped.
- A torn-off shingle hit removes 0.5 m² from its section; the section's covering counts as
  failed once half its area is gone.
- A perforation makes a 0.04 m² hole (the piece plus torn sheathing).

For the survey, any siding stripped by debris counts as DOD 1 and any shingles torn off as
DOD 2 (visible damage, as a surveyor sees it); DOD 4's 20% covering rule uses the lost area.

**Internal pressure.** Holes from perforations are openings in Spec 02's internal-pressure
rule (their area at their face's C_p). The house counts as breached (fast pressure venting)
once its holes add up to 1 m², about one window's worth.

### What happens to the piece

| Outcome | Piece |
|---|---|
| Broke a window | goes through into the house at 80% of its speed |
| Perforated | lodges: it stops, stuck through the surface along its flight direction with 0.2 m inside, and joins the debris field; if that surface later fails, it falls free again |
| Otherwise | bounces: v_n → −e·v_n (e = 0.2); tangential speed reduced by friction μ = 0.5 against the normal impulse; placed just outside the surface |

Sliding pieces stop against walls this way, so debris piles up against houses.

### Representative pieces

A simulated piece stands for `represents` real objects (Spec 04) that left the house together
and fanned out on the way (DEB-13: across-wind spread 8–40% of the distance). When it hits,
its copies hit around the same point: each copy's point is scattered on the surface plane
with σ = 0.15 × the distance the piece has traveled from its source house (0.5 m to 10 m),
and each copy that lands on the solid is its own impact at that point, with its own surface,
window and draws. Copies that land off the envelope miss. The piece's motion and its impulse
load are its own (the copies arrive spread out in time). At most 64 copies are evaluated per
hit.

### Timing

Hits are found during the debris step and queued on the house; the house's next damage
evaluation (30 Hz) applies them first, then the wind loads. A house with queued impacts is
evaluated even when it would otherwise be skipped (calm, or out of range). Failures caused by
impacts are recorded like any other (and release their debris), marked with their cause and
the missile.

### Detail-zone pieces and the houses around them (slice B, first part)

Pieces from detailed houses live in the detail physics (Spec 09): rigid chunks in Rapier, light
pieces on the Spec 04 model inside the same engine. They hit the houses around the zone too:

- **What the engine knows.** With every detail step, the sim sends the state of each house
  in town whose damage changed since it last sent it: which wall panels, panes,
  garage door, roof sections and bays still stand, whether it is swept or shifted, and whether it
  is in the detail zone itself. Steps are processed in order, so the engine always sees the same
  states at the same step, and runs stay deterministic whatever the worker timing or count.
- **Stand-ins.** Each physics group builds static colliders for the houses within 100 m of its
  own houses, and for any house a moving piece comes within 30 m of: every slab, and for houses
  on the component model their standing wall panels (with holes where a window or the garage
  door is broken), roof sections and gables, as drawn. A house's stand-ins are rebuilt just
  before the physics step after its state changes (Rapier's queries see added or removed
  colliders only after a step). A house's own stand-ins in its group stay until all its members
  are built. Detailed houses in other groups appear through their stand-in (below): the
  walls, windows and roof still standing in their own group, as of the bounded lag.
- **Light pieces** sweep their box along each step's motion against everything fixed (standing
  detailed houses, rubble, stand-ins), stop where it first touches and bounce (restitution 0.2,
  friction 0.5), land on other houses' slabs and are pushed out of them as town debris is. A
  piece that turns into a surface during a step is put back as it was turned before. A piece
  still tangled in its own house where it tore off is let work itself free.
- **Rigid chunks** collide with the stand-ins like anything else, with soft CCD so a fast chunk
  can't skip through a thin wall or slab edge in one step: the look-ahead is 1.5× the farthest
  any part of the body can move in the step (its speed plus its spin times its radius), and at
  least 0.5 m (v0.13).
- Impacts on stand-ins don't damage the houses they stand for yet (they stop the pieces only).

**Town debris and detailed houses.** The town's debris (main thread) hits each detailed house
through a component-model copy of it: a wall panel stands while its wall frame stands in the
detail physics, a window while its glass does, the garage door likewise, a roof section while
at least half its roof sheets do, a bay while any of its rafter pairs does. The copy follows the
members' first moves as of the newest detail step whose results are certain to have arrived
(the step count minus the bounded lead, Spec 09), so the same seed gives the same copy at the
same step whatever the worker timing; it lags the detail physics by at most 0.25 s. Hits on it
bounce, pass through broken windows, or perforate and lodge (below).

**Nothing inside anything fixed.** After every step:
- A light piece that ends overlapping something fixed (other than its own house while still
  tangled there) goes back to where and how it was, or, if it already overlapped, is pushed out
  1 cm at a time along the surface's normal until clear.
- A light piece's body in its first half second (still on Rapier) is checked the same way after
  the physics step and pushed out. (Full CCD was tried for these bodies and dropped: Rapier's
  time-of-impact search could hang on a body wedged between shapes.)
- "Out" for a body is the side of the surface it was on before the step: the surface's normal
  toward where it was then (a piece inside a house, in through an opening, is pushed back in,
  not out through a standing wall). Only a piece that already overlapped the surface then (or a
  light piece on the debris model, which goes back to where it was unless it already overlapped)
  falls back to away from the house the surface belongs to (in a thin layer — siding,
  sheathing, glass — the raw contact normal can point into the house), never downward.
- Each push moves the body's colliders with it at once, so a body moves out only as far as it
  overlapped (to within the 1 cm step).
- Fixed things (the ground, slabs, standing houses, stand-ins) are one collision group that only
  meets moving pieces, and slab colliders reach 0.5 m into the ground: a sheet sliding flat along
  the ground otherwise met the slab's bottom edge right at the ground and slipped under it.
- Every house in town is sent to the detail engine (pieces can fly far), not just those near
  the zone; stand-ins are built near moving pieces.
- The town's debris: a piece whose center is over a slab stands on it (nothing gets under a
  slab), and all rubble, leaning or flat, is pushed clear of slabs when placed.

Decisions:
- Send states, not geometry: the engine keeps its own copy of each house (never the sim's
  object, which an in-process engine shares) and builds the shapes itself.
- Slabs flush with the ground, not reaching into it: overlapping the ground collider made Rapier
  pair every slab with it each step (~6 ms per step with nothing moving); soft CCD covers
  tunneling instead.

## Interface

```ts
// src/core/impact/envelope.ts (pure)
function clipEnvelope(b: Building, from: Vec3, to: Vec3): EnvelopeHit | null;
// src/core/impact/impact.ts (pure)
function resolveImpact(b: Building, hit: EnvelopeHit, missile: Missile, rng: () => number): ImpactOutcome;
function impulseForce(missile: Missile, vn: number): number;
function applyImpacts(b: Building, time: number, record: Recorder): boolean;  // used by updateBuilding
// src/core/debris/field.ts
step(dt, s, terrain, checkResting, time, cloudBase, targets?: ImpactTargets): void;
```

## Parameters

Fragility table above; e = 0.2, μ = 0.5, τ = 0.1 s, σ_c = 5 MPa; patch areas 0.5 m², hole
0.04 m², breach at 1 m² of holes; copy scatter 0.15 × distance (0.5–10 m), 64 copies at most.
Values live in `src/config/impacts.ts`.

## Acceptance criteria

- **IMP-01**: A piece whose step enters a standing part of a house's envelope ends outside it,
  never inside a wall or roof; a piece entering through an opening (failed panel, broken pane,
  gone roof section) passes in; a piece inside a house can't leave through a standing surface.
- **IMP-02**: A hit is assigned to the surface it lands on: the pane, the garage door, the wall
  panel (including the gable above an end wall) or the roof section at that point.
- **IMP-03**: A window breaks exactly when the normal momentum exceeds that pane's threshold;
  the threshold medians and β follow the table by piece family, are 1.4× for strong houses,
  and are the same for every hit on one pane.
- **IMP-04**: Rods and compact pieces under 60 kg perforate walls, roofs and garage doors
  according to the energy fragility; sheets never do. A perforating piece lodges in the
  surface, along its flight direction, and falls free if that surface later fails.
- **IMP-05**: Siding and shingles lose 0.5 m² per tearing hit; the component fails once half its
  area is gone; any loss counts for DOD 1 / DOD 2.
- **IMP-06**: Impulse load: F = min(m·v_n·(1+e)/τ, σ_c·A_c) on the struck wall panel or garage
  door, applied at the next evaluation even if the house would be skipped as calm; a heavy
  enough impact fails a wall panel that the wind alone would not.
- **IMP-07**: Holes count as openings in the internal-pressure rule, and 1 m² of holes breaches
  the house.
- **IMP-08**: Bounce: after a non-damaging hit the normal speed is reversed and scaled by e, and
  the tangential speed doesn't increase.
- **IMP-09**: Representative copies: a piece standing for N objects produces up to min(N, 64)
  impact evaluations scattered around its hit point by the specified σ; only its own impulse
  loads the component.
- **IMP-10**: Impact failures are recorded with cause "debris" and the missile's kind, mass and
  normal speed; the inspector shows how many of each part debris broke.
- **IMP-11**: Same seed → identical impacts and damage.
- **IMP-12** *(validation)*: Reference tests reproduced by the model: a 4.1 kg 2×4 at 15.2 m/s
  end-on perforates a standard wall with probability ≥ 90%, the 6.8 kg 2×4 at 44.7 m/s with
  ≥ 99.9%; a 1 kg shingle at 10 m/s breaks a standard pane with probability ≥ 99%; a 0.25 kg
  shard at 1 m/s breaks it with probability ≤ 50%.
- **IMP-14**: A piece's size counts: a long piece's box never reaches into a standing wall it
  is flying at (it is stopped when its box touches).
- **IMP-15**: Slabs: a piece sliding into a slab's side stays outside it; a piece falling onto
  a slab comes to rest on its top; a swept house's slab still does both.
- **IMP-16**: Nothing ends a step inside a slab: a piece overlapping one is pushed out the
  shortest way (onto the top or past the nearest side), and a piece snagging on a slab lies
  on its top.
- **IMP-17** *(validation)*: Detail-zone pieces hit the houses around them: in the detail
  pass-through check (12 s, 30 detailed houses at the town center), no detail member crosses
  another house's standing wall or roof or ends up inside its slab (about 1,600 before), and
  every house within reach of a physics group has stand-ins that match its state.
- **IMP-19** *(validation)*: In a 20 s town pass with up to 3,000 debris pieces, no debris or
  rubble crosses any house's standing wall or roof or ends up inside any slab.
- **IMP-18**: Town debris hits a detailed house's stand-in: its panels, windows, garage door,
  roof sections and bays stand exactly while their members (as listed above) have not moved as
  of the cutoff step, and a piece thrown at a standing wall of a detailed house bounces off it.
- **IMP-20**: Damage both ways: a detail piece hitting a town house's stand-in queues an impact
  on that house's component (resolved with the town rules) at the cutoff step; town debris
  hitting a detailed house's stand-in reaches the detail engine and breaks a pane above its
  threshold or loads the hit member; the same seed gives the same impacts at the same steps
  whatever the worker timing.
- **IMP-22**: Perforation of detailed houses: a town piece that perforates a detailed house's
  stand-in lodges in it (never bounces off a surface it perforated) and falls free once the
  stand-in shows that surface gone; the detail engine counts the hole as an opening at its face
  in the internal pressure, and 1 m² of holes breaches the house.
- **IMP-21**: Glass in a detailed house breaks when a piece hits it with momentum above the
  pane's threshold (and not below), whole pane at once.
- **IMP-13** *(validation)*: In an EF4 pass through the town, debris breaks the first window
  of some houses (before the wind broke any there), lumber lodges in walls (at some point in the
  pass; most falls out again when its wall comes down), no piece is left inside a slab, and the
  debris mass ledger still balances (DEB-16). The isolated-house calibration (DMG-04) has no debris and is
  unchanged.

## Simplifications / out of scope

- Hits between town debris and detailed houses, and detail pieces and town houses, take
  effect up to 0.25 s after they happen (the fixed lag that keeps runs deterministic).

- Pieces don't hit each other.
- Roof impacts don't push roof sections down; impacts don't weaken connections without failing
  them (no fatigue).
- Partly stripped siding and partly torn-off shingles aren't drawn until the component fails.
- Debris inside a house falls to the slab; it doesn't hit interior walls.

### Damage both ways (slice B, second part)

Stand-ins stop pieces; this makes their hits count, deterministically, at the same fixed lag
the stand-ins already use (results for detail step n are applied at the sim's detail step
n + lead, which they are certain to have reached):

- **Detail pieces on detailed houses in other groups** (v0.11): the same, on the house's
  stand-in, which forwards the hit to the detail engine as below.
- **Detail pieces on town houses.** Each stand-in collider knows the component it stands for
  (wall panel, pane, garage door, roof section, gable). A hit on it — a Rapier contact between a
  moving piece and the collider, or a light piece's sweep stopping at it — is reported with the
  piece's mass, shape family and normal speed (from the contact impulse: v_n = J / (m·(1 + e))
  for rigid pieces). The sim resolves it with the same rules as town debris (resolveImpact:
  glass, perforation, siding, shingles, impulse load) and queues it on the house.
- **Town debris on detailed houses.** A hit on a detailed house's stand-in is sent to the
  detail engine with the next step (component, missile, normal speed). There, a pane hit above
  the pane's momentum threshold breaks the pane (all its glazing lets go); a hit on a wall panel
  or roof section adds its impulse force (Spec 10 impulse load) to the nearest attached member
  of that component as a contact force, through the load path like any other impact.
- **Perforation of detailed houses** (v0.12). A town piece that perforates a detailed house's
  wall, gable, garage door or roof (the same energy fragility as a component house) lodges in
  the stand-in exactly as in a component house: stuck through the surface along its flight,
  0.2 m inside. It falls free when the stand-in shows that surface gone (its wall frame, garage
  door, roof sheets or rafters moved, as of the cutoff), as a component house's failure frees
  it. The hole (0.04 m²) is sent to the detail engine with the hit: it is an opening in the
  detailed house's internal pressure at its face's C_p (the roof's average for the roof), and
  1 m² of holes breaches the house, the same rule as a component house (IMP-07).
- **Glass in detailed houses breaks by impact.** A moving piece hitting a pane's shard (Rapier
  contact, or a light piece's sweep) breaks the pane when the impact momentum exceeds the pane's
  threshold (the town's per-pane fragility, IMP-03), instead of only through quasi-static load.



## Slice B outline (detail zone; not yet approved)

- Glass in detailed houses breaks by impact momentum (the same fragility) from Rapier contact
  impulses, not only by quasi-static load.
- Impact forces capped by the crushing strength (σ_c · A_c), as above.
- Ground contact: pieces landing hard in the detail zone still dip 2–3 cm into the ground for a
  frame or two (Rapier contact softness; doubling the solver iterations didn't remove it).

## Changelog

- v0.14: light bodies pushed clear go back out the side they came from, and only as far as they
  overlapped (IMP-01, IMP-17). A detail-zone shingle in through a fallen back-wall panel of town
  house #1855 tipped 4 cm into the standing panel beside it from inside; the push-out took
  "away from the house" as out and dragged it through that panel to the outside. And the push
  loop never moved the body's colliders (Rapier moves them with their body only at the next
  step), so every check saw the same overlap and every push ran the full 40 cm. Now each
  body's collider poses are recorded before the step, out is the surface's normal toward that
  pose (away from the house only if it already overlapped then), and colliders follow each
  push.
- v0.13: soft CCD look-ahead scales with each body's speed and spin (1.5× its reach per step,
  at least 0.5 m). A fixed 0.5 m let a gable chunk at 31 m/s (0.52 m per step) end a step 12 cm
  into a neighbor's wall, and a tumbling wall section sink 3 cm into a slab edge (IMP-17).
  Also: a step that enters through an opening is clipped on from inside: if it would leave
  through a standing surface before it ends, that is a hit from inside (the piece bounces back
  in). A straight step crosses the convex envelope at most twice. Found by tracing IMP-19's
  crossings: fast pieces cut house corners in one 1/60 s step, in through a fallen end wall
  and out through the standing front wall beside it.
- v0.12: town debris perforates detailed houses like component ones (IMP-22): it lodges in the
  stand-in, falls free when that surface goes, and the hole counts in the detailed house's
  internal pressure. Before, a 2×4 that went through a component wall (461 J at 15 m/s) bounced
  off a detailed one with no hole: found by the wind tunnel (Spec 12), fixed at the user's
  request.
- v0.11: a detail piece hitting the stand-in of a detailed house in another physics group now
  damages it: the hit is resolved on that house's stand-in and forwarded to the detail engine,
  like the town's debris hits (IMP-20). Before, the sim dropped it (it skipped detailed houses),
  so the piece bounced and the window stayed whole. Found by the wind tunnel (Spec 12, TUN-06).
- v0.10: damage both ways between the detail zone and the town, and glass in detailed houses
  breaking by impact momentum (IMP-20, IMP-21), applied at the same fixed lag as the stand-ins.
- v0.9: zero pass-through (IMP-17 tightened to zero, IMP-19), at the user's request ("no pieces
  of any house passing through any other house or its components"). Fixed: pieces flying past
  the houses the engine knew; thin sheets sinking into walls and slipping under slab edges;
  pieces turning into thin glass; stand-in rebuild gaps; push-out directions in thin layers.
- v0.8: detailed houses in other physics groups are their stand-ins there (walls and roof),
  not just their slab. Found by the user: a roof chunk flew through a detailed house in the
  next street row.
- v0.7: town debris hits detailed houses through a lagged stand-in (IMP-18), at the user's
  request (it still passed through their walls).
- v0.6: detail-zone pieces hit the houses around the zone (IMP-17), first part of slice B. The
  user saw rubble from detailed houses pass through other houses and foundations: the detail
  physics only knew its own street row's houses. Fixed along the way: stand-ins rebuilt mid-step
  left a one-step gap; heavy chunks flew beyond the houses built up front; pieces turning into
  a wall weren't caught by the sweep; pieces tangled in their own house were pinned and flipped.
- v0.5: cladding tears off lying in its surface's plane (siding and glass in the wall, shingles
  along the slope) and component pieces start at the drawn height (above the slab); the hit
  test also follows the piece's center and only counts surfaces it moves into; corner crossings
  belong to the nearest panel. Found by a fast pass-through check (tests/harness).
- v0.4: outward-fallen walls lean on the slab edge; pieces whose box (not just center) is
  under a slab edge are pushed out, also after snagging. The user still saw pieces slide under
  foundations: measuring each piece's box (not its center) found long pieces and fallen walls
  reaching under slab edges.
- v0.3: pieces pushed out of slabs, and snagging on a slab lays a piece on its top (IMP-16).
  Found by the user: objects still slid under foundations. About 8% of debris ended inside a
  slab: snagging laid pieces flat at ground height whatever they were sliding on, and bounces
  at a wall's base left pieces overlapping the slab's overhang.
- v0.2: piece size in the hit test and slabs as solids (IMP-14, IMP-15), after the user saw
  siding and drywall pass through walls and ground debris slide through foundations.
  (Drywall comes from detailed houses, whose light pieces don't hit houses until slice B.)
- v0.1: written and approved for Phase 6 slice A.
