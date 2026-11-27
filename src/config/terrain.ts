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

/** Ground damage tracks (Spec 19). */
export const TRACK = {
  /** Cell and tile size (m); a tile is tile × tile cells. */
  cell: 2,
  tile: 32,
  /** Sim time between updates (s). The wind at a point changes over ~R_max / forward speed
   *  (tens of seconds), so peaks are still caught. */
  updateInterval: 0.5,
  /** Wind is sampled on this lattice (m), aligned with the tiles, and interpolated to cells:
   *  smooth on the core's scale. */
  lattice: 8,
  /** Sample height (m): canopy and turf (lodging studies measure at 1–2 m). */
  sampleHeight: 2,
  /** Crop lodging onset (m/s at 2 m, 3-s gust): canopy failure is 16–30 m/s in sustained wind
   *  (Berry et al. 2021; Baker et al. 2014); the sim's winds are 3-s gusts, so lodging starts at the
   *  top of that range. Calibrated (TERR-19): EF0–1 lodge in patches, EF2 across the path. */
  cropLodge: 28,
  /** Crop stems snapped and shredded (m/s at 2 m): calibrated so EF3 (51–62 m/s at 2 m) snaps
   *  them and EF2 (41–50) only lodges them. */
  cropSnap: 48,
  /** Mowed lawn pushed over (m/s at 2 m). Decision: short, stiff turf low in the surface layer;
   *  no data; above crop lodging. */
  lawnFlatten: 35,
  /** Scour onset u_s (m/s at 2 m): no EF2 scouring, onset within EF3 (51–62 m/s at 2 m). */
  scourOnset: 50,
  /** Debris weight k_d (m²/kg) on the scour rate; set by TERR-19 calibration. */
  debrisWeight: 2,
  /** Dose thresholds (s of scour-rate time) for thinned, stripped, bare soil; TERR-19 calibration. */
  dose: { thinned: 0.5, stripped: 1.5, bare: 8 },
  /** Roughness length of each state (m), Wieringa (1993) classes. */
  z0: { lodged: 0.01, snapped: 0.015, pushedOver: 0.006, thinned: 0.005, stripped: 0.002, bare: 0.001 },
  /** Patch-to-patch variation (±fraction, uniform per cell, seeded by position): plant
   *  strength scales the lodging and snapping thresholds, soil erodibility the dose thresholds.
   *  Real fields and lawns aren't uniform; it gives tracks their ragged, patchy edges. */
  variation: { plants: 0.2, soil: 0.2 },
  /** Slides slower than this (m/s) leave no streak (a piece creeping or settling). */
  streakSpeed: 2,
  /** Landings faster than this (m/s) gouge the ground. */
  gougeSpeed: 5,
  /** Debris below this height (m) counts toward the debris load. */
  debrisHeight: 3,
} as const;
