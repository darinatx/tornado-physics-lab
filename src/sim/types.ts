import { ATMOSPHERE_PARAMS } from "../config/atmosphere";
import { SIM_DEFAULTS } from "../config/sim";
import { LIFECYCLE_DEFAULTS, WIND_PARAMS } from "../config/wind";
import type { Phase } from "../core/wind/lifecycle";
import type { TerrainClass, TornadoState } from "../core/wind/types";

/** Everything the user can tune about the tornado and its path. */
export interface TornadoParams {
  vPeak: number;
  rMax: number;
  alpha: number;
  inflowRatio: number;
  inflowDepth: number;
  updraftMax: number;
  overshoot: number;
  zPeak: number;
  translationSpeed: number;
  /** deg, 0 = +X, counter-clockwise from above. */
  heading: number;
  /** deg/s. */
  turnRate: number;
  rotation: 1 | -1;
  terrain: TerrainClass;
  /** Cloud base / lifting condensation level (m). Shapes the condensation funnel. */
  cloudBase: number;
  tUp: number;
  tMature: number;
  tRope: number;
}

export function defaultParams(): TornadoParams {
  const w = WIND_PARAMS;
  return {
    vPeak: w.vPeak.default,
    rMax: w.rMax.default,
    alpha: w.alpha.default,
    inflowRatio: w.inflowRatio.default,
    inflowDepth: w.inflowDepth.default,
    updraftMax: w.updraftMax.default,
    overshoot: w.overshoot.default,
    zPeak: w.zPeak.default,
    translationSpeed: w.translationSpeed.default,
    heading: SIM_DEFAULTS.heading,
    turnRate: SIM_DEFAULTS.turnRate,
    rotation: 1,
    terrain: "open",
    cloudBase: ATMOSPHERE_PARAMS.cloudBase.default,
    ...LIFECYCLE_DEFAULTS,
  };
}

/** Immutable state after a physics step. */
export interface SimSnapshot {
  readonly time: number;
  readonly step: number;
  readonly tornado: TornadoState;
  readonly terrain: TerrainClass;
  /** Cloud base height (m). */
  readonly cloudBase: number;
  readonly phase: Phase;
  /** Total lifecycle duration (s). */
  readonly lifetime: number;
}

export interface SimConfig {
  dt: number;
  maxFrameDt: number;
}

export interface SimFrame {
  prev: SimSnapshot;
  curr: SimSnapshot;
  /** Fraction of a step left in the accumulator, for render interpolation. In [0, 1). */
  alpha: number;
}
