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
  /** Dust tracers (Spec 06 v1.6): the count follows the total dust emission (tracers per
   *  m²·(m/s)³ of ∫F dA, set so a typical tornado has ~12,000), within [tracerMin, tracerCap];
   *  the cap is the measured frame budget. */
  tracersPerEmission: 7.8e-8,
  tracerMin: 2000,
  tracerCap: 40000,
  /** Dust can lift within this many R_max of the axis (the damage range, Spec 03). */
  dustRangeRmax: 6,
  /** Seconds between dust surveys. */
  dustSurveyEvery: 0.25,
  /** Dust sprite size (m). */
  tracerSize: 45,
  /** Dust tracers in the structure lab (more, smaller: it's viewed from tens of metres,
   *  where 45 m sprites would fill the screen; visual only). */
  labTracerCount: 12000,
  /** Lab dust sprite size (m). */
  labTracerSize: 14,
  /** Ground wind needed to loft dust (m/s). */
  dustLiftSpeed: 25,
} as const;

/** Free camera (Spec 06 v1.7). */
export const CAMERA = {
  /** Lowest camera height: eye height (m). */
  minHeight: 1.7,
  /** Closest zoom to the orbit point (m). */
  minDistance: 2,
  /** Farthest zoom (m): the whole map. */
  maxDistance: 15000,
  /** Flying speed per metre of camera height (1/s), and its limits (m/s). */
  flySpeedPerMetre: 1.2,
  flyMinSpeed: 10,
  flyMaxSpeed: 1000,
  /** Shift multiplies the flying speed. */
  fastFactor: 4,
  /** Turning in place: radians per pixel of right-drag, arrow-key rate (rad/s), and the
   *  steepest look up or down from level (rad, 85°). */
  turnPerPixel: 0.004,
  turnRate: Math.PI / 2,
  maxPitch: (85 * Math.PI) / 180,
  /** Starting view (REND-17, Spec 06 v1.11): framed on the tornado, ahead on its track with
   *  this share of the distance to the right, this high (m), at least this far (m). Ground to
   *  cloud base fills at most this share of the view's height, and a debris cloud this many
   *  R_max wide at most this share of its width (framing choices, not physics). */
  startSide: 0.3,
  startHeight: 30,
  startMinDistance: 300,
  startFillHeight: 0.8,
  startFillWidth: 0.6,
  startDebrisWidth: 4,
  /** It looks at the tornado's axis this far up, as a share of the cloud base. */
  startLookUp: 0.4,
} as const;
