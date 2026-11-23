/** Interpolation between physics snapshots (REND-03). Pure. */
import type { TornadoState } from "../core/wind/types";

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function interpolateTornado(prev: TornadoState, curr: TornadoState, alpha: number): TornadoState {
  return {
    ...curr,
    center: { x: lerp(prev.center.x, curr.center.x, alpha), z: lerp(prev.center.z, curr.center.z, alpha) },
    vMax: lerp(prev.vMax, curr.vMax, alpha),
    rMax: lerp(prev.rMax, curr.rMax, alpha),
  };
}
