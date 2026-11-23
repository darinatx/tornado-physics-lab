/** Simulation-loop constants (Spec 08). */
export const SIM_DEFAULTS = {
  /** Physics step (s). */
  dt: 1 / 120,
  /** Clamp on real elapsed time per frame (s), to avoid a spiral of death after a stall. */
  maxFrameDt: 0.25,
  /** Path heading (deg). 0 = +X (east), counter-clockwise from above; 60 ≈ ENE. */
  heading: 60,
  /** Path turn rate (deg/s). 0 = straight. */
  turnRate: 0,
  seed: 1,
} as const;

/** Allowed sim-speed multipliers. 0 pauses. */
export const TIME_SCALES = [0, 0.25, 0.5, 1, 2, 4] as const;

/** Ranged path controls (UI). */
export const PATH_PARAMS = {
  heading: { label: "Heading", unit: "deg", default: SIM_DEFAULTS.heading, min: 0, max: 359, step: 1 },
  turnRate: { label: "Turn rate", unit: "deg/s", default: SIM_DEFAULTS.turnRate, min: -0.5, max: 0.5, step: 0.01 },
} as const;
