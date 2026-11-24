/**
 * Wind-field constants (Spec 01). All values SI unless noted.
 */

export interface ParamDef {
  label: string;
  unit: string;
  default: number;
  min: number;
  max: number;
  step: number;
  source: string;
}

/** User-tunable wind parameters. Every entry gets a UI control (INST-01). */
export const WIND_PARAMS = {
  vPeak: {
    label: "Peak wind (V_peak)", unit: "m/s", default: 60, min: 15, max: 128, step: 1,
    source:
      "Aloft speed. With the near-ground overshoot and a typical forward speed, 94 m/s matches the " +
      "strongest tornado winds ever measured (~135 m/s / 302 mph, mobile radar, Bridge Creek–Moore " +
      "1999 and El Reno 2013). Settings above that are hypothetical, up to ~400 mph at 10 m.",
  },
  rMax: {
    label: "Core radius (R_max)", unit: "m", default: 150, min: 20, max: 800, step: 5,
    source: "Rope to wedge; radar-observed R_max typically 50–500 m",
  },
  alpha: {
    label: "Outer decay (α)", unit: "–", default: 0.6, min: 0.5, max: 1.0, step: 0.01,
    source: "1.0 = classic Rankine; radar-observed 0.5–0.8",
  },
  inflowRatio: {
    label: "Inflow ratio (k_r)", unit: "–", default: 0.5, min: 0, max: 1, step: 0.01,
    source: "Near-surface radial / tangential ratio",
  },
  inflowDepth: {
    label: "Inflow depth (δ)", unit: "m", default: 50, min: 10, max: 200, step: 1,
    source: "Observed corner-flow depths are tens of meters",
  },
  updraftMax: {
    label: "Core updraft (W_max)", unit: "m/s", default: 30, min: 0, max: 80, step: 1,
    source: "Radar-observed updrafts 30–80 m/s",
  },
  overshoot: {
    label: "Near-ground overshoot (S_peak)", unit: "–", default: 1.3, min: 1.0, max: 1.6, step: 0.01,
    source: "Lab vortex simulators and LES find ~1.2–1.6",
  },
  zPeak: {
    label: "Peak-wind height (z_p)", unit: "m", default: 20, min: 5, max: 60, step: 1,
    source: "Doppler-on-Wheels observations: peak winds ~10–50 m AGL",
  },
  translationSpeed: {
    label: "Forward speed (|V_trans|)", unit: "m/s", default: 12, min: 0, max: 30, step: 0.5,
    source: "Typical tornado forward speeds 10–20 m/s",
  },
} as const satisfies Record<string, ParamDef>;

export type WindParamKey = keyof typeof WIND_PARAMS;

/** Power-law exponent β by terrain roughness (standard wind-engineering values). */
export const TERRAIN_BETA = {
  open: 0.11,
  suburban: 0.22,
  urban: 0.33,
} as const;

/**
 * Numerical floor for z / z_p so speed stays nonzero at z = 0 (0.1 m with z_p = 20 m).
 * Was 0.05 (a 1 m floor), which held wind at ground level near 94% of the peak and made
 * resting debris far too mobile (Spec 01 v1.5).
 */
export const PROFILE_EPSILON = 0.005;

/**
 * One-cell → two-cell vortex structure (Spec 01 v1.2).
 * Thresholds are calibrated so, at the default W_max, EF0–2 tornadoes are one-celled, EF3
 * transitional and EF4–5 two-celled, matching mobile-radar observations of intense tornadoes.
 */
export const CELL_STRUCTURE = {
  /** Swirl ratio below which the vortex is fully one-celled. */
  swirlOneCell: 1.1,
  /** Swirl ratio above which the vortex is fully two-celled. */
  swirlTwoCell: 1.7,
  /** Central downdraft strength as a fraction of W_max (observed weaker than the updraft ring). */
  downdraftRatio: 0.5,
  /** Downdraft radius as a fraction of R_max. */
  downdraftRadius: 0.5,
} as const;

/**
 * The far-field (environmental) wind equals V_trans at and above this height and follows the
 * terrain power law below it (Spec 01 v1.4).
 */
export const ENV_REFERENCE_HEIGHT = 10;

/**
 * Environmental surface wind far from the tornado (m/s at 10 m, Spec 01 v1.8): at most this,
 * along the motion. Tornadic environments typically have 10 m winds of ~5–15 m/s, while storm
 * motion follows the 0–6 km mean wind (often 15–25 m/s); the vortex carries the full
 * translation only within its own circulation.
 */
export const ENV_SURFACE_WIND = 10;

/** Strongest tornado wind ever measured near the ground (m/s): ~302 mph, mobile radar. */
export const RECORD_WIND_MS = 135;

/** Height at which the EF rating is evaluated (m). Standard 10 m anemometer height. */
export const EF_REFERENCE_HEIGHT = 10;

/** Lifecycle durations (s). Gameplay-scaled; real lifetimes range from minutes to over an hour. */
export const LIFECYCLE_DEFAULTS = {
  tUp: 60,
  tMature: 180,
  tRope: 90,
} as const;
