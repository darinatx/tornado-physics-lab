import type { TornadoState } from "../src/core/wind/types";

export function baseState(o: Partial<TornadoState> = {}): TornadoState {
  return {
    center: { x: 0, z: 0 },
    velocity: { x: 0, z: 0 },
    vMax: 60,
    rMax: 150,
    alpha: 0.6,
    inflowRatio: 0.5,
    inflowDepth: 50,
    updraftMax: 30,
    overshoot: 1.3,
    zPeak: 20,
    rotation: 1,
    ...o,
  };
}

export const hspeed = (w: { x: number; z: number }) => Math.hypot(w.x, w.z);
