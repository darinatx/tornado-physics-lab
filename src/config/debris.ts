/**
 * Debris constants (Spec 04). Sizes in m, masses in kg.
 * Tumble-averaged aerodynamics (Wills, Lee & Wyatt 2002; Tachikawa 1983):
 *   sheets & rods: C_D·A = 0.7·L·W; sheets also C_L·A = 0.2·L·W; compact: C_D·A = 0.8·L·W.
 */
import type { Part } from "./buildings";

export type DebrisFamily = "sheet" | "rod" | "compact";

export interface DebrisKindDef {
  label: string;
  family: DebrisFamily;
  /** Length, width, thickness (m). */
  dims: readonly [number, number, number];
  mass: number;
  /** Drag coefficient × reference area (m²). */
  cda: number;
  /** Lift coefficient × reference area (m²); 0 for non-lifting pieces. */
  cla: number;
  /** Autorotation: ω = spinRate · |v_rel| / L. */
  spinRate: number;
}

const sheet = (label: string, L: number, W: number, T: number, mass: number): DebrisKindDef => ({
  label, family: "sheet", dims: [L, W, T], mass, cda: 0.7 * L * W, cla: 0.2 * L * W, spinRate: 0.6,
});
const rod = (label: string, L: number, W: number, T: number, mass: number): DebrisKindDef => ({
  label, family: "rod", dims: [L, W, T], mass, cda: 0.7 * L * W, cla: 0, spinRate: 0.4,
});
const compact = (label: string, L: number, W: number, T: number, mass: number): DebrisKindDef => ({
  label, family: "compact", dims: [L, W, T], mass, cda: 0.8 * L * W, cla: 0, spinRate: 0.3,
});

export const DEBRIS_KINDS = {
  shingle: sheet("Shingle", 1.0, 0.33, 0.005, 1.0),
  siding: sheet("Siding strip", 3.8, 0.25, 0.003, 1.5),
  osb: sheet("OSB sheathing", 2.4, 1.2, 0.012, 16),
  garagePanel: sheet("Garage door panel", 2.4, 0.55, 0.04, 12),
  rafter: rod("Rafter (2×6)", 3.6, 0.14, 0.04, 8),
  stud: rod("Stud (2×4)", 2.4, 0.09, 0.04, 4.5),
  glass: compact("Glass shard", 0.15, 0.15, 0.005, 0.25),
  chunk: compact("Wall chunk", 0.5, 0.5, 0.15, 18),
} as const satisfies Record<string, DebrisKindDef>;

export type DebrisKind = keyof typeof DEBRIS_KINDS;

/** Pieces spawned per failed part (Spec 04 table). */
export const SPAWN_TABLE: Record<Part, [DebrisKind, number][]> = {
  trim: [["siding", 3]],
  roofCover: [["shingle", 8]],
  windows: [["glass", 4]],
  garage: [["garagePanel", 4]],
  roofDeck: [["osb", 4]],
  anchorage: [],
  roofStructure: [["rafter", 6], ["osb", 6], ["shingle", 6]],
  exteriorWalls: [["stud", 6], ["siding", 4], ["osb", 3]],
  mostWalls: [["stud", 6], ["chunk", 4]],
  allWalls: [["stud", 6], ["chunk", 4]],
  slab: [["stud", 4], ["chunk", 6]],
};

export const DEBRIS = {
  /** Maximum active (simulated) pieces at once. */
  cap: 3000,
  /**
   * Maximum pieces kept in the permanent debris field. Resting pieces away from the tornado
   * move here: drawn, never simulated again, never recycled (unless this fills).
   */
  settledCap: 60000,
  /** Sliding (kinetic) friction coefficient. */
  friction: 0.5,
  /**
   * Holding (static) coefficient for landed debris: pieces snag on grass, crops, fences and
   * other debris, so starting them moving takes more than keeping them moving.
   */
  holdFriction: 1.2,
  /**
   * Mean sliding distance before a piece snags on an obstacle (m), by terrain. A snagged
   * piece is pinned against the obstacle by the wind: it's released only when the wind
   * swings around to pull it back the way it came (and drag beats the holding friction), or
   * when the wind lifts it over.
   */
  snagDistance: { open: 30, suburban: 15, urban: 8 },
  /**
   * Resting pieces farther than this many R_max from the tornado move to the permanent
   * debris field; ground-level wind out there can no longer move them.
   */
  settleRangeRmax: 3,
  /** Bounce restitution on landing (only above minBounceSpeed). */
  restitution: 0.2,
  minBounceSpeed: 2,
  /** Below this horizontal speed (m/s), a held piece comes to rest. */
  restSpeed: 0.2,
  /** Pieces beyond this |x| or |z| (m) leave the map. */
  mapHalf: 6000,
  /** Debris is stepped every N physics steps (60 Hz at dt = 1/120). */
  stepInterval: 2,
  /** Height at which resting pieces sample the wind (m). */
  restSampleHeight: 0.2,
} as const;

export const DEBRIS_COLORS: Partial<Record<DebrisKind, number>> = {
  osb: 0xb8935a,
  garagePanel: 0xe6e2da,
  rafter: 0xc9a36b,
  stud: 0xc9a36b,
  glass: 0x9fc4d8,
  chunk: 0x8f8a82,
};
