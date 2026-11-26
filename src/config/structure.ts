/**
 * Structural detail constants (Spec 09). SI units.
 */
export const LUMBER = {
  density: 500,
  /** 2×4 actual size (m). */
  stud: [0.04, 0.09] as const,
  /** 2×6 actual size (m). */
  rafter: [0.04, 0.14] as const,
  spacing: 0.6,
} as const;

export const SHEET = {
  thickness: 0.012,
  density: 650,
  maxLong: 2.4,
  maxShort: 1.2,
  /** Shingles on roof sheathing (kg/m²). */
  shingleAreal: 10,
  /** Cut pieces narrower than this aren't hung; door and window trim covers the gap (m). */
  minPiece: 0.03,
} as const;

/** Annealed float glass; a broken pane falls apart into shards (a grid of cells, each split
 *  diagonally: 3 → 18 shards of ~0.4 m, the size of typical annealed-glass fragments). */
export const GLASS = { density: 2500, thickness: 0.006, shardGrid: 3 } as const;

/** Doors (m, kg/m²). Exterior: insulated steel, 36 × 80 in.; interior: hollow core, 30 × 80 in. */
export const DOOR = {
  exterior: { width: 0.91, height: 2.03, thickness: 0.045, areal: 17 },
  interior: { width: 0.76, height: 2.03, thickness: 0.035, areal: 7 },
  /** Rough opening clearance around a door leaf. */
  roughGap: 0.02,
  /** Doubled 2×10 header over openings. */
  headerDepth: 0.235,
} as const;

/**
 * Floor plan of a one-story ranch (m): garage at the front-left, living room and kitchen in
 * the middle, a bedroom wing with a hallway (2 bedrooms in front, primary bedroom, bathroom
 * and walk-in closet behind). Typical US 3-bed plan of ~150 m².
 */
export const FLOOR_PLAN = {
  /** Garage depth, capped at this share of the house depth. */
  garageDepth: 6.1,
  garageDepthShare: 0.55,
  /** Where the bedroom wing starts, as a share of the width from the left (garage) end. */
  wingStartShare: 0.61,
  hallWidth: 1.1,
  bathWidth: 2.1,
  bathDepth: 2.4,
  /** Door leaf centre from the room corner along the wall. */
  doorInset: 0.6,
  /** Wall thickness: 2×4 studs plus 12.7 mm drywall both sides. */
  wallThickness: 0.115,
} as const;
export const GARAGE_DOOR_AREAL = 12;

/**
 * Connection capacities for a standard house (Spec 09 table): mean *ultimate* strengths from
 * laboratory tests, not design (allowable) values, which are deliberately 2–3× lower.
 */
export const CONNECTION = {
  /** 8d nails at 6/12 in.: mean failure ~80 psf. */
  roofSheetPa: 4000,
  wallSheetPa: 4000,
  /** Annealed glass, 1.2 m pane. */
  glazingPa: 2500,
  /** Standard non-reinforced door. */
  garageDoorPa: 1300,
  /** Inswing entry door: latch and hinges, mean failure ~50 psf (outward, the stop bears). */
  extDoorPa: 2400,
  /** Interior door: three hinges screwed into the jamb. */
  interiorDoorN: 1500,
  /** 3 × 16d toe-nails, mean uplift failure. Tests span ~400–700 lbf (1.8–3.1 kN); 2.5 kN
   *  (~560 lbf) calibrated in tornado passes against DI 2 (roof structure loss, DOD 6). */
  rafterToWallN: 2500,
  /** Hurricane strap (H2.5-type), mean ultimate. */
  strapN: 6000,
  /** 1/2 in. anchor bolt with washer, sill-plate pull-through. */
  boltN: 10000,
  boltSpacing: 1.83,
  /** Each stud end-nailed into the sill plate (2 × 16d, withdrawal and shear). */
  studToPlateN: 1000,
  /** Wall sheathing nailed along the sill plate, per metre: 8d common at 6 in. (6.56 per metre),
   *  each ~1.0 kN mean ultimate in lateral load through 7/16 in. OSB into SPF lumber (NDS design
   *  value ~0.4 kN × the usual 2.5–3 ultimate-to-design ratio). Was 4 kN/m (a design-level
   *  value), which let walls tear off their sills before the roof's toe-nails let go. */
  sheathingToSillNPerM: 6500,
  /** First and last bolt within 12 in of the plate ends (IRC R403.1.6). */
  boltEndDistance: 0.3,
  /** Gable-end bottom plate to the end wall's top plate: 16d face nails at 16 in. (0.4 m),
   *  ~0.7 kN lateral each, per metre of shared length. */
  gablePlateNPerM: 1750,
  /** Ceiling joist toe-nailed to each bearing wall's top plate (3 × 8d, ~200–350 lbf),
   *  beside the rafter's own toe-nails; scaled with the rafter toe-nails' calibration. */
  joistToWallN: 1200,
  /** (Roof-to-wall load sharing is modeled directly: see DETAIL.rafterSharing.) */
  roofSystemFactor: 1,
  /**
   * Asphalt shingles, mean uplift failure of a sealed patch (~38 psf; sealed architectural
   * shingles test ~30–80 psf, aged ones lower). Each patch also scatters (Spec 09 v0.7), so the
   * first to go are the weak ones. Validated in tornado passes: covering loss (DOD 2) near 79 mph.
   */
  shinglePa: 1800,
  /** Drywall screws holding the ceiling to the joists (pull-through). */
  ceilingScrewPa: 600,
  /** Interior partition to the slab: powder-actuated pins at 24 in. (~1.5 kN each in shear)
   *  plus nailing at wall intersections, per metre of wall. */
  partitionNPerM: 2500,
} as const;

/** Insulation carried by the ceiling joists (kg/m²); the drywall is its own member. */
export const CEILING_AREAL = 3;
/** 12.7 mm gypsum ceiling drywall (kg/m²). */
export const CEILING_DRYWALL_AREAL = 10;

/** Interior partition walls: studs plus drywall both sides (kg/m²). */
export const PARTITION_AREAL = 20;
export const DRYWALL_COLOR = 0xd9d4c7;
/**
 * Vinyl lap siding over the wall sheathing (m, kg/m²): the outer layer, the first thing wind
 * strips off a wall (DI 2 DOD 1). The space behind it is vented to the outside, so it feels
 * only the outside pressure (no internal pressure or tornado pressure drop). Aged siding
 * (brittle locks, loose nailing) commonly comes off in 60–70 mph gusts: mean blow-off
 * ~0.4 kPa, calibrated to DI 2 DOD 1.
 */
export const SIDING = { thickness: 0.003, areal: 1.5, pa: 400 } as const;

/** Exterior casing around windows and doors: 1×4 boards (m), white, nailed through the sheathing. */
export const TRIM = { width: 0.09, thickness: 0.02, color: 0xf4f2ec, nailN: 800 } as const;
/** 1/2 in. gypsum board on the inside of exterior walls (m). */
export const DRYWALL_THICKNESS = 0.0127;
export const OSB_COLOR = 0xb8935a;

/** Class factors (Spec 09, mirroring Spec 03). */
export const STRUCT_CLASS = {
  weak: { rafter: 0.7, anchorage: 0.6, glazing: 1, sheet: 0.85 },
  standard: { rafter: 1, anchorage: 1, glazing: 1, sheet: 1 },
  strong: { rafter: 1, anchorage: 1.6, glazing: 1.4, sheet: 1.3 },
} as const;

/** Flat-plate aerodynamics for detached members. */
export const PLATE = { normalCoeff: 1.2, frictionCoeff: 0.05 } as const;

/** Drag on exposed framing lumber (studs, rafters) once a house is open: 2.0 for a single
 *  sharp-edged member, ~0.6 shielding for members standing in line behind each other. */
export const FRAMING_DRAG_CD = 1.2;

/** Slab top height (m) — matches the Phase 4 renderer. */
export const SLAB_TOP = 0.3;

/** Structure lab block (Spec 09, STR-23). */
export const LAB = {
  /** Lot spacing between house centers (m): typical suburban frontage is ~20–30 m. */
  lotSpacing: 28,
  /** Most houses (–): measured, 12 run at ~0.5× in the worst second of an EF3 hit (Apple M5). */
  maxHouses: 12,
};

/**
 * Variability of a detailed house's connections (Spec 09 v0.7), lognormal β: most of it is
 * shared by the whole house (one builder, one age); individual connections scatter less.
 */
export const DETAIL_FRAGILITY = {
  /** Whole house (workmanship): every connection. */
  houseQuality: 0.12,
  /** Whole roof covering (shingle age and sealing): every shingle of the house. */
  coveringCondition: 0.3,
  /** Each shingle patch on its own. */
  shingle: 0.15,
  /** Each other connection on its own. */
  connection: 0.1,
} as const;

/** Detail zone in town (Spec 09 slice B). */
export const DETAIL = {
  /** Each physics group builds solid stand-ins up front for the houses within this distance of
   *  its own houses (m), and more near moving pieces as they fly (Spec 10 v0.6). Heavy pieces
   *  (wall frames, roof chunks) seldom go over ~100 m. */
  townReach: 100,
  /** Entering houses' colliders built per detail step, in entry order (a house has ~1,150;
   *  ~7 ms each in Node, so 400 ≈ 2–3 ms a step instead of a ~30 ms spike per house). */
  buildCollidersPerStep: 400,
  /** Resting rubble (Spec 09 performance): a rigid piece still below these speeds (m/s, rad/s)
   *  for rubbleAfterS (s), touching only fixed things, becomes fixed in place; its wind is
   *  checked every rubbleWindEvery steps (4 Hz, as for resting light pieces). Rapier's own
   *  sleep (0.4 m/s for 2 s) never triggers for pieces the wind keeps nudging. */
  rubbleSpeed: 0.1,
  rubbleSpin: 0.1,
  rubbleAfterS: 0.5,
  rubbleWindEvery: 15,
  /** Houses enter within enterRmax·R_max + enterLeadS × translation speed of the center (m). */
  enterRmax: 4,
  enterLeadS: 20,
  /** …and leave once behind the tornado beyond exitRmax·R_max. */
  exitRmax: 6,
  /** Houses detailed around the chosen spot (the most destroyed at once that still runs near
   *  real time: ~1–2 ms per house per step while it's being torn apart). */
  maxHouses: 30,
  /** A house that left the zone freezes once its pieces rest, or after this long (s) once
   *  every piece has been down and only creeping for creepForS (s): under creepSpeed (m/s) and
   *  creepSpin (rad/s), with something under it (Spec 09 v0.15). A piece falling, toppling or
   *  sliding off a pile moves faster than this (or pauses for less than a second); one the wind
   *  nudges along the ground, slower. */
  settleTimeout: 20,
  creepSpeed: 0.2,
  creepSpin: 0.2,
  creepForS: 1,
  /** A light piece that stays within heldDrift (m) and heldTurnDeg (°) of where it was for
   *  heldAfterS (s) while touching something is held there at rest (Spec 09 v0.16). */
  heldDrift: 0.03,
  heldTurnDeg: 2,
  heldAfterS: 0.5,
  /** Calm skip: no load solve below this roof-height wind (mph) and APC push (Pa). Nothing can
   *  fail below 64 mph in any class or direction (first: aged shingles on a weak house at
   *  66 mph); 55 mph leaves ~30% margin on load. */
  calmMph: 55,
  calmApcPa: 100,
  /** A wall braced at the top by the roof framing sends this share of its out-of-plane load
   *  into the ceiling/roof diaphragm (a wall spans floor to ceiling: half each end). */
  diaphragmShare: 0.5,
  /** Roof sheathing ties each rafter to its neighbors (sheets run 2.4 m along the ridge,
   *  spanning ~4–5 rafters at 0.6 m): a
   *  rafter's hold-down fails when the mean demand/capacity over itself and this many
   *  neighbors each side (on the same wall) exceeds 1. */
  rafterSharing: 3,
  /** A gable end braced by its end rafter sends this share of its out-of-plane load into the
   *  roof diaphragm (a triangular wall under uniform load: one third reacts at the top). */
  gableDiaphragmShare: 1 / 3,
  /** An end wall's top is tied into the ceiling diaphragm: braced while any of this many
   *  outermost rafter pairs on its side (~2.4 m of ceiling) stands. */
  endWallBraceRafters: 4,
  /** A gable's top is braced while either of its nearest rafter pairs stands. */
  gableBraceRafters: 2,
  /** An unbraced wall (its roof gone) is a cantilever from its bottom plate: base moment
   *  capacity per metre of wall (N·m/m) from the bottom-plate and sheathing nailing and the
   *  corner ties. Calibrated against DI 2 DOD 7 (walls collapse soon after the roof goes). */
  wallBaseMomentNmPerM: 2500,
  /** A roofless wall panel leans on its neighbors (lapped top plates) and corner posts: its
   *  overturning capacity grows by this much per standing neighbor on the same wall… */
  wallNeighborBrace: 0.5,
  /** …and by this much while the perpendicular wall's panel at its corner stands. */
  wallCornerBrace: 1,
  /** The small bathroom box is sheltered by the walls around it: its walls feel this share of
   *  the wind reaching the other interior walls. */
  coreShelter: 0.5,
  /** Rooms work as boxes: while at least two walls of a group (the bathroom's, or the other
   *  interior walls) stand, the walls they meet at corners and T-junctions take most of each
   *  wall's broadside load in-plane, leaving it this share. */
  interiorBoxShare: 0.3,
  /** Intact structure is checked at 30 Hz (houses alternate steps); every step after an impact. */
  solveEvery: 2,
  /** The sim may run at most this far ahead of the detail physics (s). */
  maxLeadS: 0.25,
  /** Detail steps run every N sim steps (60 Hz at the 120 Hz sim step). */
  stepEvery: 2,
  /** Loose pieces (a member or a nailed-together chunk) lighter than this (kg) leave Rapier
   *  for the Spec 04 debris model… */
  lightKg: 40,
  /** …once they've been loose this long (s): the tear-off itself stays fully simulated. */
  lightAfterS: 0.5,
  /** …and are airborne, high enough to tumble freely (center above half their length plus
   *  this, m), or at rest. */
  lightClearance: 0.5,
  /** Pieces shorter than this (m) hand off even near the ground: laying them flat is barely visible. */
  smallPieceM: 1.0,
  /** A piece sliding on its face hands off when tilted less than this (rad). */
  flatTiltRad: 0.09,
  /** Most houses entering per detail step (spreads the build cost). */
  maxEnterPerStep: 3,
} as const;

/**
 * Main wind-force-resisting-system pressure coefficients on a gable roof (ASCE 7-16 Fig.
 * 27.3-1, θ ≈ 20°, h/L ≤ 0.5), for the detailed model's framing checks. Wind across the ridge:
 * windward and leeward slopes; along the ridge: by distance from the windward gable edge in
 * units of the mean roof height h. Blended by the wind's angle to the ridge.
 */
export const ROOF_MWFRS = {
  normalWindward: -0.7,
  normalLeeward: -0.6,
  /** [up to distance (× h), Cp] from the windward gable edge. */
  parallel: [
    [1, -0.9],
    [2, -0.5],
    [Infinity, -0.3],
  ] as const,
} as const;
