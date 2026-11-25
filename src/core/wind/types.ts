import type { Vec2 } from "../math/vec";

export type TerrainClass = "open" | "suburban" | "urban";

/**
 * Wind tunnel flow (Spec 12): a power-law boundary-layer wind, uniform in plan, with a vertical
 * wind ramping up from the ground and a uniform pressure deficit.
 */
export interface TunnelFlow {
  /** Mean wind at 10 m over the terrain (m/s). */
  readonly u10: number;
  /** Direction the wind blows toward (deg, 0 = +X, counter-clockwise from above). */
  readonly dirDeg: number;
  /** Vertical wind above the ramp height (m/s, + up). */
  readonly w: number;
  /** Pressure deficit (Pa). */
  readonly deficit: number;
}

/** Instantaneous tornado state: everything windAt needs (Spec 01). */
export interface TornadoState {
  /** Wind tunnel (Spec 12): when set, the wind and deficit are the tunnel's, not the vortex's. */
  readonly tunnel?: TunnelFlow;
  /** Ground position of the vortex axis (m). */
  readonly center: Vec2;
  /** Translation velocity (m/s). */
  readonly velocity: Vec2;
  /** Current peak tangential speed aloft, after the lifecycle (m/s). */
  readonly vMax: number;
  /** Current core radius, after the lifecycle (m). */
  readonly rMax: number;
  /** Outer decay exponent. */
  readonly alpha: number;
  /** k_r: near-surface inflow / tangential ratio. */
  readonly inflowRatio: number;
  /** δ: inflow-layer depth (m). */
  readonly inflowDepth: number;
  /** W_max: core updraft (m/s). */
  readonly updraftMax: number;
  /** S_peak: near-ground overshoot factor. */
  readonly overshoot: number;
  /** z_p: height of peak winds (m). */
  readonly zPeak: number;
  /** 1 = cyclonic (counter-clockwise viewed from above). */
  readonly rotation: 1 | -1;
}
