/** Atmosphere constants (Specs 01, 06). */

/** Near-surface air density in a warm, humid storm environment (kg/m³). */
export const AIR_DENSITY = 1.2;

/** Gravitational acceleration (m/s²). */
export const GRAVITY = 9.81;

/** Background air pressure the tornado's pressure drop is taken from (Pa): the standard
 *  sea-level pressure (ICAO standard atmosphere). The sim models only the drop; this is the
 *  assumed surroundings for showing actual pressure (Spec 07 v1.10). */
export const BACKGROUND_PRESSURE_PA = 101325;

/** Pascals per millibar (1 mb = 1 hPa). */
export const PA_PER_MB = 100;

/** 1 lb/ft² in pascals. */
export const PA_PER_PSF = 47.880259;

/** Environment parameters with UI controls. */
export const ATMOSPHERE_PARAMS = {
  cloudBase: {
    label: "Cloud base height", unit: "m", default: 500, min: 250, max: 1500, step: 10,
    source: "Lifting condensation level; tornadic storms typically have low bases (< 1000 m)",
  },
} as const;
