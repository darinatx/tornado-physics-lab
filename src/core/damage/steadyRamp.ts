/**
 * Quasi-static wind ramp used for calibration and validation (DMG-04): steady wind from a
 * fixed direction, raised 1 mph at a time, cascades resolved at each step, no pressure deficit.
 */
import { DAMAGE_STEP_INTERVAL } from "../../config/buildings";
import { SIM_DEFAULTS } from "../../config/sim";
import { MS_PER_MPH } from "../../config/units";
import { pressureDeficit } from "../wind/pressure";
import type { TerrainClass, TornadoState } from "../wind/types";
import { windAt } from "../wind/windField";
import { mphToMs } from "../wind/efScale";
import { updateBuilding } from "./building";
import type { Building } from "./types";

/** First speed (mph) at which the house reaches DOD ≥ d, for d = 0..10 (Infinity if never). */
export function steadyRamp(b: Building, dirRad: number, fromMph = 30, toMph = 280): number[] {
  const first = new Array<number>(11).fill(Infinity);
  first[0] = fromMph;
  for (let mph = fromMph; mph <= toMph; mph++) {
    const ms = mphToMs(mph);
    updateBuilding(b, { x: ms * Math.cos(dirRad), y: 0, z: ms * Math.sin(dirRad) }, 0, 10, mph);
    for (let d = 1; d <= b.dod; d++) if (first[d] === Infinity) first[d] = mph;
    if (b.dod >= 10) break;
  }
  return first;
}


/**
 * A house passing through a translating tornado (DMG-04): returns, for each DOD d, the peak
 * wind (mph, at roof height) the house had felt when it first reached DOD ≥ d. This is the
 * quantity the EF scale's expected speeds describe.
 */
export function tornadoPass(
  b: Building,
  s: TornadoState,
  terrain: TerrainClass = "open",
  lateralOffset = 0,
): number[] {
  const first = new Array<number>(11).fill(Infinity);
  const R = s.rMax;
  const speed = Math.hypot(s.velocity.x, s.velocity.z);
  const dir = { x: s.velocity.x / speed, z: s.velocity.z / speed };
  const right = { x: -dir.z, z: dir.x };
  const dt = SIM_DEFAULTS.dt * DAMAGE_STEP_INTERVAL;
  const span = 8 * R;
  let peak = 0;
  // Put the house at the origin offset sideways; move the vortex past it.
  const hx = right.x * lateralOffset;
  const hz = right.z * lateralOffset;
  const p = { x: hx, y: b.roofHeight, z: hz };
  for (let t = 0, x = -span; x <= span; t += dt, x += speed * dt) {
    const state: TornadoState = { ...s, center: { x: dir.x * x, z: dir.z * x } };
    const w = windAt(p, state, terrain);
    peak = Math.max(peak, Math.hypot(w.x, w.y, w.z) / MS_PER_MPH);
    const r = Math.hypot(hx - state.center.x, hz - state.center.z);
    updateBuilding(b, w, pressureDeficit(r, state), dt, t);
    for (let d = 1; d <= b.dod; d++) if (first[d] === Infinity) first[d] = peak;
    if (b.dod >= 10) break;
  }
  return first;
}

/** A random strong-tornado pass used for calibration and DMG-04 (houses pass near the core). */
export function samplePassCase(rng: () => number): { state: TornadoState; offset: number } {
  const rMax = 150 + rng() * 150;
  const heading = rng() * Math.PI * 2;
  const v = 10 + rng() * 8;
  return {
    state: {
      center: { x: 0, z: 0 },
      velocity: { x: v * Math.cos(heading), z: v * Math.sin(heading) },
      vMax: 55 + rng() * 25,
      rMax,
      alpha: 0.6,
      inflowRatio: 0.5,
      inflowDepth: 50,
      updraftMax: 30,
      overshoot: 1.3,
      zPeak: 20,
      rotation: 1,
    },
    offset: (rng() * 2 - 1) * 0.8 * rMax,
  };
}
