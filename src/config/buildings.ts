/**
 * Building constants (Specs 02, 03 v2). Pressures in Pa, speeds in mph where noted.
 */

/** EF-scale Damage Indicator 2 (one- or two-family residences). Speeds in mph (3-s gust). */
export const DI2_DODS = [
  { dod: 1, lower: 53, expected: 65, upper: 80, text: "Threshold of visible damage" },
  { dod: 2, lower: 63, expected: 79, upper: 97, text: "Loss of roof covering (< 20%), gutters, siding" },
  { dod: 3, lower: 79, expected: 96, upper: 114, text: "Broken glass in doors and windows" },
  { dod: 4, lower: 81, expected: 97, upper: 116, text: "Roof deck uplifted; garage door collapsed" },
  { dod: 5, lower: 103, expected: 121, upper: 141, text: "Entire house shifted off foundation" },
  { dod: 6, lower: 104, expected: 122, upper: 142, text: "Large sections of roof structure removed" },
  { dod: 7, lower: 113, expected: 132, upper: 153, text: "Exterior walls collapsed" },
  { dod: 8, lower: 127, expected: 152, upper: 178, text: "Most walls collapsed except small interior rooms" },
  { dod: 9, lower: 142, expected: 170, upper: 198, text: "All walls collapsed" },
  { dod: 10, lower: 165, expected: 200, upper: 220, text: "Slab swept clean" },
] as const;

/** External pressure coefficients (ASCE 7 low-rise, approximate). */
export const CP = {
  windward: 0.8,
  leeward: -0.5,
  side: -0.7,
  roofAverage: -0.9,
  deckEdge: -1.2,
  deckField: -0.8,
  coverEdge: -1.8,
  coverField: -1.0,
} as const;

/** Internal pressure. */
export const CPI = {
  enclosed: 0.18,
  dominantOpeningFactor: 0.75,
} as const;

/** Atmospheric-pressure-change venting time constants (s). */
export const APC_TAU = {
  sealed: 2,
  breached: 0.05,
} as const;

/** Dead loads resisting uplift (Pa). */
export const DEAD_LOAD = {
  deck: 100,
  roof: 600,
} as const;

/** Wall-panel bracing from the roof bay above it. */
export const ROOF_BRACING_FACTOR = 1.6;
/** Bay capacity multiplier per failed neighboring bay (progressive roof failure). */
export const BAY_NEIGHBOR_FACTOR = 0.85;
/**
 * Net pressure coefficient on a free-standing wall (ASCE 7 free-standing walls, ~1.2–1.8).
 * Once a house is open (half its walls or all its roof gone), standing panels take wind on
 * both faces like a free-standing wall.
 */
export const CP_FREESTANDING = 1.3;
/** Corner panels are braced by the perpendicular wall while its corner panel stands. */
export const CORNER_BRACING_FACTOR = 1.4;
/** Wall-panel capacity multiplier per failed neighboring panel on the same wall. */
export const PANEL_NEIGHBOR_FACTOR = 0.8;

/** Component types (Spec 03 v2). */
export const PARTS = [
  "siding",
  "roofCover",
  "window",
  "garage",
  "roofDeck",
  "anchorage",
  "roofBay",
  "wallPanel",
  "partition",
  "coreRoom",
  "sweep",
] as const;
export type Part = (typeof PARTS)[number];

export const PART_LABEL: Record<Part, string> = {
  siding: "Siding",
  roofCover: "Roof covering",
  window: "Windows",
  garage: "Garage door",
  roofDeck: "Roof deck",
  anchorage: "Foundation anchorage",
  roofBay: "Roof structure (rafters)",
  wallPanel: "Exterior wall panels",
  partition: "Interior walls",
  coreRoom: "Interior core room (closet/bath)",
  sweep: "Slab swept clean",
};

/** Units for "N of M ..." in the inspector. */
export const PART_UNIT: Record<Part, string> = {
  siding: "panels",
  roofCover: "sections",
  window: "panes",
  garage: "",
  roofDeck: "sections",
  anchorage: "",
  roofBay: "bays",
  wallPanel: "panels",
  partition: "walls",
  coreRoom: "",
  sweep: "",
};

/**
 * Base capacities (Pa) for a standard house's components. Calibrated by
 * scripts/calibrate-houses.ts against simulated tornado passes over town house sites, on the
 * EF scale's basis: the 10 m open-terrain peak at first reaching each DOD (Spec 03 v2.5, DMG-04).
 */
export const BASE_CAPACITY: Record<Part, number> = {
  siding: 425,
  roofCover: 1695,
  window: 3156,
  /** Fixed, not calibrated: standard non-reinforced garage door, ~27 psf. */
  garage: 1300,
  /** Fixed, not calibrated: 8d nails at typical spacing, ~56 psf. */
  roofDeck: 2700,
  anchorage: 2097,
  roofBay: 1014,
  wallPanel: 950,
  partition: 2383,
  coreRoom: 3553,
  sweep: 5580,
};

/**
 * Calibration target: which DOD each part's capacity is tuned to (0 = fixed at an engineering
 * value; garage doors and roof deck would otherwise drift, since DOD 4 is usually reached
 * through covering loss first).
 */
export const PART_CALIBRATION_DOD: Record<Part, number> = {
  siding: 1,
  roofCover: 2,
  window: 3,
  garage: 0,
  roofDeck: 0,
  anchorage: 5,
  roofBay: 6,
  wallPanel: 7,
  partition: 8,
  coreRoom: 9,
  sweep: 10,
};

/** Calibration setting (Spec 03 v2.5): the town whose house sites and intact roughness field
 *  the calibration passes use (seed 1 is the default town, Spec 05), and the passes: the
 *  EF1–EF5 presets at mature strength, houses within ±offsetRmax·R_max of the track (–), out
 *  to about where EF5's outer flow falls under DOD 1's lower bound (r ∝ V^(−1/α): 175 → 53 mph
 *  at α 0.6 is ≈ 7·R_max at the ground; past 4·R_max few houses reach DOD 1 and are censored). */
export const CALIBRATION = {
  townSeed: 1,
  presets: ["ef1-small", "ef2-cone", "ef3-strong", "ef4-wedge", "ef5-extreme"],
  offsetRmax: 4,
} as const;

/** Fragility: lognormal dispersion (β = σ of ln). */
export const FRAGILITY = {
  houseQuality: 0.12,
  partScatter: 0.18,
  /** Roof covering varies more (nailing, sealing, age). */
  coverScatter: 0.35,
} as const;

export type ConstructionClass = "weak" | "standard" | "strong";

export const CLASS_SHARES: Record<ConstructionClass, number> = {
  weak: 0.25,
  standard: 0.55,
  strong: 0.2,
};

export const CLASS_LABEL: Record<ConstructionClass, string> = {
  weak: "Weak (older, toe-nailed roof, few anchors)",
  standard: "Standard construction",
  strong: "Strong (hurricane straps, anchor bolts, impact windows)",
};

export const CLASS_FACTORS: Record<ConstructionClass, Partial<Record<Part, number>>> = {
  // Calibrated in full town runs (Spec 03 v2.6, scripts/calibrate-town.ts): weak houses reach
  // each DOD at DI 2's lower bound, strong houses at its upper bound, as the survey assumes
  // (DMG-08, DMG-15). Garage door and deck factors are fixed engineering ratios (not calibrated).
  weak: { siding: 0.67, roofCover: 0.6, window: 0.78, anchorage: 0.57, roofBay: 0.53, wallPanel: 0.66, partition: 0.64, coreRoom: 0.64, sweep: 0.62 },
  standard: {},
  strong: { siding: 1.54, roofCover: 1.65, window: 2.17, garage: 1.5, roofDeck: 1.3, anchorage: 1.75, roofBay: 1.82, wallPanel: 1.47, partition: 1.43, coreRoom: 1.42, sweep: 1.22 },
};

/** Layout geometry (m). */
export const LAYOUT = {
  panelTarget: 4,
  windowShare: 0.6,
  paneSize: 1.2,
  paneSill: 1.0,
  garageWidth: 4.9,
  garageHeight: 2.2,
  overhang: 0.4,
  partitions: 2,
} as const;

/** Areal masses (kg/m²) for component debris (Spec 04 v1.4). */
export const AREAL_MASS = {
  wallPanel: 25,
  roofPanel: 18,
  deckSection: 10,
  garageDoor: 12,
  partition: 15,
} as const;

/** Damage is evaluated every N physics steps (30 Hz at dt = 1/120). */
export const DAMAGE_STEP_INTERVAL = 4;

/** Houses farther than this many R_max from the axis are skipped. */
export const DAMAGE_RANGE_RMAX = 6;
