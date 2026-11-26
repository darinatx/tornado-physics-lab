/**
 * Structure lab constants (Spec 13). SI units. Lot spacing and the house limit are in
 * `LAB` (config/structure.ts, Spec 09).
 */
import { compact, rod } from "./debris";
import type { DebrisKind, DebrisKindDef } from "./debris";

export const LAB_LAYOUT = {
  /** The lab's standard house (m): Spec 09 slice A's bench house. */
  house: { width: 14, depth: 11, wallHeight: 3, roofRise: 2 },
  /** Neighborhood ring: town lots within this distance of the block's edge (m). Phase 6
   *  alignment check: upwind houses out to 130 m as debris sources. */
  reach: 130,
  /** A town house within this distance of a lab lot is left out (m): no overlapping lots. */
  lotClear: 3,
  /** Donor houses stand this far from the block (m): out of the scene and of any debris's reach,
   *  inside the physics ground (±10 km). */
  donorDistance: 4000,
  /** Neighbor density range (× the town's lot pattern; Spec 13 v0.6): 1.75× leaves lots ~17 m wide
   *  for houses up to 16 m; 0.25× is a rural road with 46 m lots. */
  minDensity: 0.25,
  maxDensity: 1.75,
  /** Default lab seed (Spec 09, unchanged). */
  seed: 3,
} as const;

export const LAB_LAUNCH = {
  /** A launch aimed at a surface starts this far out (m): free flight to reach launch speed,
   *  close enough to hit the aim. */
  standoff: 10,
  /** Real members start this close (m): they fly in the rigid-body physics without being steered
   *  to arrive, and from 10 m a broadside panel's drag brings it down short (the tunnel's 4 m). */
  memberStandoff: 4,
  /** Stream start heights above the ground (m): where windborne debris is dense in surveys. */
  streamHeight: [2, 40] as const,
  /** Stream start distance upwind of the aimed face (m). */
  streamUpwind: 25,
} as const;

export const LAB_RECORDING = {
  /** Capture box: the target's footprint grown by this on every side (m). */
  boxMargin: 10,
  /** Capture box height (m): nearly all windborne debris in surveys travels below it. */
  boxHeight: 30,
} as const;

/** Spec 09's pass start rule: roof-height wind under this (mph) where the pass begins. */
export const LAB_PASS_CALM_MPH = 50;

export interface ReferenceMissile {
  id: string;
  name: string;
  /** Spec 04 kind it flies as (its shape and aerodynamics), scaled to `mass`. */
  kind: DebrisKind;
  /** kg. */
  mass: number;
  /** m/s. */
  speed: number;
  /** Fired straight down at a roof (ICC 500 vertical). */
  vertical?: boolean;
  /** Its shape, size and mass as a Spec 04 piece. */
  def: DebrisKindDef;
  source: string;
}

/** A nominal 2×4 (38 × 89 mm) of length L (m) and mass m (kg). */
const twoByFour = (label: string, L: number, m: number) => rod(label, L, 0.089, 0.038, m);

/**
 * Reference missiles. ASTM E1996-17 Table 2 (missiles A–E); ICC 500-2020 / FEMA P-361 shelter
 * missile (15 lb 2×4 at 100 mph horizontal, 67 mph vertical).
 */
export const REFERENCE_MISSILES: readonly ReferenceMissile[] = [
  // Missile A: 2 g steel ball, ~8 mm (ASTM: 2 ± 0.1 g).
  { id: "astm-a", name: "ASTM E1996 A (2 g steel ball, 39.6 m/s)", kind: "chunk", mass: 0.002, speed: 39.6, def: compact("Steel ball (missile A)", 0.008, 0.008, 0.008, 0.002), source: "ASTM E1996 Table 2" },
  // B–E: 2×4 lumber of 525 mm, 1.2 m, 2.4 m and 2.4 m (ASTM E1996 Table 2 lengths).
  { id: "astm-b", name: "ASTM E1996 B (2×4, 0.91 kg, 15.3 m/s)", kind: "stud", mass: 0.91, speed: 15.3, def: twoByFour("2×4 (missile B)", 0.525, 0.91), source: "ASTM E1996 Table 2" },
  { id: "astm-c", name: "ASTM E1996 C (2×4, 2.05 kg, 12.2 m/s)", kind: "stud", mass: 2.05, speed: 12.2, def: twoByFour("2×4 (missile C)", 1.2, 2.05), source: "ASTM E1996 Table 2" },
  { id: "astm-d", name: "ASTM E1996 D (2×4, 4.1 kg, 15.3 m/s)", kind: "stud", mass: 4.1, speed: 15.3, def: twoByFour("2×4 (missile D)", 2.4, 4.1), source: "ASTM E1996 Table 2" },
  { id: "astm-e", name: "ASTM E1996 E (2×4, 4.1 kg, 24.4 m/s)", kind: "stud", mass: 4.1, speed: 24.4, def: twoByFour("2×4 (missile E)", 2.4, 4.1), source: "ASTM E1996 Table 2" },
  // ICC 500: 15 lb (6.8 kg) 2×4, about 12 ft (3.66 m), 100 mph horizontal, 67 mph vertical.
  { id: "icc500-h", name: "ICC 500 shelter (2×4, 6.8 kg, 44.7 m/s)", kind: "stud", mass: 6.8, speed: 44.7, def: twoByFour("2×4 (ICC 500)", 3.66, 6.8), source: "ICC 500-2020 §305.1.1" },
  { id: "icc500-v", name: "ICC 500 shelter, roof (2×4, 6.8 kg, 30 m/s down)", kind: "stud", mass: 6.8, speed: 30, vertical: true, def: twoByFour("2×4 (ICC 500)", 3.66, 6.8), source: "ICC 500-2020 §305.1.1" },
];
