/**
 * Debris impact constants (Spec 10). SI units: kg·m/s (momentum), J (energy), N, Pa, m, s.
 */
import { SLAB_TOP } from "./structure";

export interface Fragility {
  /** Median threshold (kg·m/s for momentum, J for energy). */
  median: number;
  /** Lognormal dispersion (σ of ln). */
  beta: number;
}

export const IMPACT = {
  /**
   * Annealed window glass breaking momentum (normal component). Momentum predicts breakage
   * better than energy (Masters, Gurley, Shah & Fernandez 2010, Engineering Structures, ~600
   * impacts on residential annealed glass). Point/edge contact (rods, compact pieces) breaks
   * at lower momentum than a sheet's spread contact. To be checked against the paper's tables.
   */
  glass: {
    point: { median: 0.4, beta: 0.5 } as Fragility,
    sheet: { median: 1.2, beta: 0.5 } as Fragility,
  },
  /** Impact-rated glazing on strong houses (Spec 03 class factor for windows). */
  strongGlazing: 1.4,
  /**
   * Perforation energy (normal component), rods and compact pieces under `perforateMaxKg`.
   * Wall: vinyl siding over 12 mm OSB; a 4.1 kg 2×4 at 15.2 m/s (~470 J) went through
   * vinyl- and fiber-cement-sided walls with 1/2 in. OSB (BIA-sponsored test, NAHB brief);
   * shelters are designed for 6.8 kg at 44.7 m/s (6.8 kJ, FEMA P-361 / ICC 500).
   * Roof: shingles over 12 mm OSB deck, same sheathing. Garage door: thin steel, foam core.
   */
  perforate: {
    wall: { median: 250, beta: 0.4 } as Fragility,
    roof: { median: 250, beta: 0.4 } as Fragility,
    garage: { median: 150, beta: 0.4 } as Fragility,
  },
  /** Heavier pieces are panels and sections: they load, they don't perforate (kg). */
  perforateMaxKg: 60,
  /** Vinyl siding torn by an impact (J): brittle; a few J cracks it (ASTM D4226 dart tests). */
  siding: { median: 15, beta: 0.5 } as Fragility,
  /** Shingles torn off by an impact (J): UL 2218 hail classes are 5–30 J for cracking. */
  shingle: { median: 60, beta: 0.5 } as Fragility,
  /** Area stripped or torn off per tearing hit (m²); the component fails at half its area. */
  patchArea: 0.5,
  failFraction: 0.5,
  /** Hole per perforation (m²): the piece plus torn sheathing. */
  holeArea: 0.04,
  /** Holes adding up to this (m², about one window) breach the house. */
  breachArea: 1,
  /** Restitution and friction of a bounce off a house surface. */
  restitution: 0.2,
  friction: 0.5,
  /** Contact duration (s), as Spec 09's wood-on-wood impacts. */
  contactTime: 0.1,
  /** Crushing strength perpendicular to the grain (Pa; lumber ~4–7 MPa). */
  crushStrength: 5e6,
  /** A perforating piece lodges with this much of it inside (m). */
  lodgeDepth: 0.2,
  /** A piece that broke a window keeps this share of its speed. */
  throughGlassKeep: 0.8,
  /** Representative copies scatter σ = this × distance from the source house, clamped (m). */
  copyScatter: 0.15,
  copyScatterMin: 0.5,
  copyScatterMax: 10,
  maxCopies: 64,
  /** Top of the house slab (m): walls stand on it (Spec 06 drawing). */
  slabTop: SLAB_TOP,
  /** Slab overhang past the walls (m): component houses as drawn; detailed houses' slab is
   *  flush with the wall frames (half a stud depth). */
  slabMargin: 0.3,
  detailSlabMargin: 0.045,
} as const;
