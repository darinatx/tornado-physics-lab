import type { ConstructionClass, Part } from "../../config/buildings";
import type { Vec2 } from "../math/vec";

/** Geometry and identity of a house, before capacities are sampled. */
export interface HouseSpec {
  id: number;
  /** Footprint center (m). */
  x: number;
  z: number;
  /** Rotation about +Y (rad). Local +X is the width axis. */
  yaw: number;
  /** Footprint along local X (m). */
  width: number;
  /** Footprint along local Z (m). */
  depth: number;
  wallHeight: number;
  roofRise: number;
  cls: ConstructionClass;
  /** Face index (0:+X, 1:+Z, 2:−X, 3:−Z, local) that faces the street. */
  frontFace: number;
  hasGarage: boolean;
  wallColor: number;
  roofColor: number;
}

export interface FailureRecord {
  part: Part;
  /** Face index for windows. */
  face?: number;
  /** Sim time of failure (s). */
  time: number;
  /** Net load that caused it (Pa). */
  load: number;
  /** Capacity it exceeded (Pa). */
  capacity: number;
  /** Wind speed at roof height at the time (mph). */
  mph: number;
}

export interface Building extends HouseSpec {
  /** Mean roof height, where wind is sampled (m). */
  readonly roofHeight: number;
  /** Capacities (Pa). Windows are per face. */
  readonly capacity: Readonly<Record<Exclude<Part, "windows">, number>>;
  readonly windowCapacity: readonly number[];
  /** Failure records by part; windows separately per face. */
  failed: Partial<Record<Exclude<Part, "windows">, FailureRecord>>;
  windowFailed: (FailureRecord | null)[];
  /** Internal pressure deficit lagging the outside (Pa). */
  deficitIn: number;
  /** Peak wind speed experienced at roof height (mph). */
  peakMph: number;
  /** Current degree of damage (0–10). */
  dod: number;
  /** Offset after shifting off the foundation (m). */
  shift: Vec2 | null;
}
