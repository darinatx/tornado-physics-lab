/**
 * Terrain roughness and ground cover (Spec 17). Every value has its unit and source.
 */

/** Ground cover kinds (Spec 17, Spec 05 layout). */
export type CoverKind = "farmland" | "lawn" | "pavement";

export const TERRAIN = {
  /** Grid cell (m). Resolves a lot. */
  cell: 20,
  /** Side of the square window buildings are averaged over (m): one block (Spec 05: 200 m ×
   *  110 m); morphometric roughness maps use 100–500 m. A 100 m window read street crossings as
   *  near-open (z₀ 0.05 m among suburban 0.19 m). */
  window: 200,
  /** Grid margin beyond the buildings and cover (m): past the ~1 km fetch, so the edge is resolved. */
  margin: 1500,
  /** Roughness length of each ground cover (m). Wieringa (1993) roughness classes. */
  z0Cover: { farmland: 0.03, lawn: 0.008, pavement: 0.001 } as Record<CoverKind, number>,
  /** Roughness length of a rubble- and debris-strewn lot (m): Wieringa's "rough open, scattered
   *  obstacles" class (0.03–0.1). */
  z0Rubble: 0.05,
  /** Rubble covering this fraction of the window counts as fully rubble-rough (–). */
  rubbleFullFraction: 0.1,
  /** Height of a fallen house's rubble (m), Spec 04 rubble. */
  rubbleHeight: 1.0,
  /** Macdonald, Griffiths & Hall (1998) constants for staggered arrays. */
  macdonald: { A: 4.43, betaM: 1.0, cd: 1.2, kappa: 0.4 },
  /** β(z₀) = β_ref + perDecade·log10(z₀ / z0Ref): through Spec 01's 0.11 / 0.22 / 0.33 at
   *  z₀ = 0.03 / 0.3 / 3 m (Davenport–Wieringa classes). */
  beta: { z0Ref: 0.3, ref: 0.22, perDecade: 0.11, min: 0.08, max: 0.4 },
  /** The z₀ each terrain class stands for (m), one decade apart. */
  classZ0: { open: 0.03, suburban: 0.3, urban: 3 },
  /** Class boundaries (m): geometric midpoints between the class z₀ values. */
  classBounds: { suburban: 0.1, urban: 1.0 },
  /** e-folding length of the upwind fetch weight (m): internal-boundary-layer growth
   *  (Elliott 1958, Wood 1982); ~95% adjusted after 3L = 750 m, near ASCE 7's 800 m fetch. */
  fetchLength: 250,
  /** Wind directions the fetch is precomputed for (22.5° sectors). */
  directions: 16,
  /** Sim time between roughness updates as buildings fail (s). */
  updateInterval: 2,
  /** Ground-cover blend at boundaries (m), drawing only. */
  coverBlend: 5,
} as const;
