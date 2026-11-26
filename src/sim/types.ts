import { ATMOSPHERE_PARAMS } from "../config/atmosphere";
import { SIM_DEFAULTS } from "../config/sim";
import { LIFECYCLE_DEFAULTS, WIND_PARAMS } from "../config/wind";
import type { DebrisStats } from "../core/debris/field";
import type { Phase } from "../core/wind/lifecycle";
import type { TerrainClass, TornadoState, TunnelFlow } from "../core/wind/types";
import type { HouseSpec, QueuedImpact } from "../core/damage/types";
import type { DebrisField } from "../core/debris/field";
import type { Piece } from "../core/debris/piece";
import type { DetailLaunch } from "./detailZone";

/** Everything the user can tune about the tornado and its path. */
export interface TornadoParams {
  vPeak: number;
  rMax: number;
  alpha: number;
  outerReach: number;
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
    outerReach: w.outerReach.default,
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
  /** Increases whenever any building's damage changes. */
  readonly damageVersion: number;
  /** Count of buildings at each DOD 0–10. */
  readonly damageHistogram: readonly number[];
  /** Debris pool stats (Spec 04). */
  readonly debris: Readonly<DebrisStats>;
}

export interface SimConfig {
  /** Where the heavy-debris engine runs (Spec 04 v2.1): default in-process; a worker in the app. */
  heavy?: (seed: number, buildings: readonly import("../core/damage/types").Building[], dt: number) => import("./heavyBackend").HeavyBackend;
  dt: number;
  maxFrameDt: number;
  /** Generate the neighborhood (default true). Tests of the wind alone can turn it off. */
  buildings: boolean;
  /** Validation runs: only the houses within this circle (SIM-10). */
  area?: { x: number; z: number; radius: number };
  /** Validation runs: where the tornado starts (default: its path centered on the origin). */
  start?: { x: number; z: number };
  /** Validation runs: how many houses the detail zone takes (default DETAIL.maxHouses). */
  detailHouses?: number;
  /** Wind tunnel (Spec 12): these houses instead of the generated town. */
  houses?: readonly HouseSpec[];
  /** Wind tunnel: the flow at sim time t, replacing the tornado everywhere. */
  tunnel?: (t: number) => TunnelFlow;
  /** Wind tunnel: exactly these houses enter the detail zone (once a spot is set), each in the
   *  named physics group (default: its street row), `stripped` = with every member removed. */
  detailSet?: readonly { index: number; group?: string; stripped?: boolean }[];
  /** The lab (Spec 13): the detail set enters at the first detail step, all at once, wherever
   *  the tornado is, and never leaves. */
  detailPinned?: boolean;
  /** Benchmark timing (Spec 18): wall-clock ms per section, accumulated. Read-only: nothing in
   *  the physics reads it. */
  timing?: StepTiming;
  /** Read-only observers (Spec 08 v1.5). More can be added with `sim.observe`. */
  taps?: SimTaps;
  /** Turbulent debris dispersion (Spec 13; default on). Off: gusts held at zero (replay tests). */
  dispersion?: boolean;
  /** Detailed houses whose connection loads come back with every detail step (Spec 13, the
   *  lab's member inspector). */
  inspect?: readonly number[];
  /** Launches (Spec 12): called at every debris step before the debris moves, and at every
   *  detail step for the launches it carries. */
  inject?: {
    debris?(time: number, field: DebrisField): void;
    detail?(time: number): DetailLaunch[];
  };
}

/** Wall-clock time per section of the physics step (ms, accumulated; Spec 18). `steps` counts
 *  physics steps; `total` covers each step and the detail results applied after it. */
export interface StepTiming {
  steps: number;
  total: number;
  damage: number;
  debris: number;
  heavy: number;
  detail: number;
}

export function newStepTiming(): StepTiming {
  return { steps: 0, total: 0, damage: 0, debris: 0, heavy: 0, detail: 0 };
}

/** Observers: they see what happens and must not change it. */
export interface SimTaps {
  /** An impact on a house (index into the buildings), by the town's debris field ("debris")
   *  or a detail-zone piece's hit applied in the sim ("detail"). */
  impact?(house: number, q: QueuedImpact, path: "debris" | "detail", piece: Piece | null, time: number): void;
  /** A connection failure in a detailed house, as the sim receives it. */
  detailFailure?(house: number, f: { label: string; load: number; capacity: number; mph: number; con?: number }, time: number): void;
  /** After every debris step (`time` = the step's start), once the debris has moved (Spec 13). */
  debrisStep?(time: number): void;
}

export interface SimFrame {
  prev: SimSnapshot;
  curr: SimSnapshot;
  /** Fraction of a step left in the accumulator, for render interpolation. In [0, 1). */
  alpha: number;
}
