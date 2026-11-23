import type { Vec2 } from "../math/vec";

export type TerrainClass = "open" | "suburban" | "urban";

/** Instantaneous tornado state: everything windAt needs (Spec 01). */
export interface TornadoState {
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
