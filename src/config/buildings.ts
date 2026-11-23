/**
 * Building constants (Specs 02, 03). Pressures in Pa, speeds in mph where noted.
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
  roofDeckEdge: -1.2,
  roofCoverEdge: -1.8,
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

/** Wall bracing from an attached roof structure. */
export const ROOF_BRACING_FACTOR = 1.6;

/** Parts of a house, in DOD order. */
export const PARTS = [
  "trim",
  "roofCover",
  "windows",
  "garage",
  "roofDeck",
  "anchorage",
  "roofStructure",
  "exteriorWalls",
  "mostWalls",
  "allWalls",
  "slab",
] as const;
export type Part = (typeof PARTS)[number];

/** DOD reached when each part fails. Windows count per face; any face → DOD 3. */
export const PART_DOD: Record<Part, number> = {
  trim: 1,
  roofCover: 2,
  windows: 3,
  garage: 4,
  roofDeck: 4,
  anchorage: 5,
  roofStructure: 6,
  exteriorWalls: 7,
  mostWalls: 8,
  allWalls: 9,
  slab: 10,
};

export const PART_LABEL: Record<Part, string> = {
  trim: "Siding & trim",
  roofCover: "Roof covering",
  windows: "Windows",
  garage: "Garage door",
  roofDeck: "Roof deck",
  anchorage: "Foundation anchorage",
  roofStructure: "Roof structure",
  exteriorWalls: "Exterior walls",
  mostWalls: "Most walls",
  allWalls: "All walls",
  slab: "Remaining structure",
};

/**
 * Base capacities (Pa) for a standard house. Calibrated by scripts/calibrate-houses.ts so that
 * standard houses passed through simulated tornadoes reach each DI 2 DOD at a median peak
 * wind equal to its expected speed (DMG-04).
 */
export const BASE_CAPACITY: Record<Part, number> = {
  trim: 569,
  roofCover: 1547,
  windows: 1591,
  garage: 1302,
  roofDeck: 1775,
  anchorage: 3738,
  roofStructure: 868,
  exteriorWalls: 2170,
  mostWalls: 3612,
  allWalls: 4714,
  slab: 7457,
};

/** Fragility: lognormal dispersion (β = σ of ln). */
export const FRAGILITY = {
  houseQuality: 0.12,
  partScatter: 0.18,
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
  weak: { roofStructure: 0.7, anchorage: 0.6, exteriorWalls: 0.85, mostWalls: 0.85, allWalls: 0.85 },
  standard: {},
  strong: {
    roofStructure: 1.6,
    anchorage: 1.6,
    exteriorWalls: 1.3,
    mostWalls: 1.3,
    allWalls: 1.3,
    windows: 1.4,
    garage: 1.5,
    roofDeck: 1.3,
  },
};

/** Opening areas as fractions / sizes. */
export const OPENINGS = {
  /** Window area as a fraction of each wall face. */
  windowFraction: 0.12,
  /** Garage door area (m²): 16 × 7 ft. */
  garageArea: 10.4,
  /** Roof area opened when the deck fails, as a fraction of roof area. */
  deckOpenFraction: 0.2,
} as const;

/** Damage is evaluated every N physics steps (30 Hz at dt = 1/120). */
export const DAMAGE_STEP_INTERVAL = 4;

/** Houses farther than this many R_max from the axis are skipped. */
export const DAMAGE_RANGE_RMAX = 6;
