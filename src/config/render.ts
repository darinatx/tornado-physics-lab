/** Rendering and visualization constants (Specs 06, 07). */
export const RENDER = {
  /** Ground plane size (m, square). */
  groundSize: 12000,
  /** Arrow length at or above the EF5 threshold (m). */
  maxArrowLength: 34,
  /** Max arrow width (m). */
  maxArrowWidth: 7,
  /** Arrows are drawn within this distance of the tornado (m, half-width of a square). */
  arrowRange: 1000,
  /** Arrow grid spacing (m). Spec 07 arrowGridSpacing. */
  arrowGridSpacing: 40,
  /** Wind sampling height for arrows (m). Spec 07 arrowHeight. */
  arrowHeight: 10,
  /** Height arrows are drawn at, just above the ground (m). */
  arrowDrawHeight: 1.5,
  /** Number of dust tracers. */
  tracerCount: 8000,
  /** Dust sprite size (m). */
  tracerSize: 45,
  /** Ground wind needed to loft dust (m/s). */
  dustLiftSpeed: 25,
} as const;
