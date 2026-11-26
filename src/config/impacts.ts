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
   * Annealed window glass breaking momentum (normal component, kg·m/s), by missile family.
   * Momentum predicts breakage better than energy (Shah 2008, UF thesis; Masters, Gurley, Shah &
   * Fernandez 2010, Engineering Structures 32:911; Bole 1999).
   * - sheet: full-weight asphalt shingles on 3.18 mm (1/8 in) annealed glass, mean threshold
   *   4.71 kg·m/s, range 2.35–7.04 (Shah 2008, Table 3-2 and §5.1.1). β: the lab scatter is
   *   ~0.2; 0.3 adds impact location, angle and edge support in real windows.
   * - rod: 2×4 lumber on annealed glass, 50% breakage at 2.3–2.5 lbf·s = 10.2–11.1 kg·m/s
   *   (NAHB Research Center 2002, for HUD). The blunt 38 × 89 mm end spreads its contact.
   * - compact: shards and rubble chunks; not tested directly. Bounded by hard point contacts
   *   (a 2 g steel ball at 0.08 kg·m/s, the ASTM E1996 small missile, breaks annealed glass)
   *   and blunt wood (~10); an estimate.
   */
  glass: {
    sheet: { median: 4.7, beta: 0.3 } as Fragility,
    rod: { median: 10.5, beta: 0.3 } as Fragility,
    compact: { median: 0.4, beta: 0.5 } as Fragility,
  },
  /** Impact-rated glazing on strong houses (Spec 03 class factor for windows). Also about the
   *  step from 3.18 to 4.76 mm annealed glass (×1.4 in breaking momentum, Shah 2008). */
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
