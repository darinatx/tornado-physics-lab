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

/**
 * Advance a sim until `done()`, yielding to the event loop about once a second so the test
 * runner's worker can still report progress (a minutes-long synchronous loop makes Vitest's
 * worker time out with an "onTaskUpdate" error even when every test passes).
 */
export async function advanceUntil(sim: { advance(dt: number): unknown }, done: () => boolean, step = 0.25): Promise<void> {
  let last = performance.now();
  while (!done()) {
    sim.advance(step);
    if (performance.now() - last > 1000) {
      await new Promise((r) => setImmediate(r));
      last = performance.now();
    }
  }
}
