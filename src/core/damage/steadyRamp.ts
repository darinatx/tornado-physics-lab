/**
 * Quasi-static wind ramp used for calibration and validation (DMG-04): steady wind from a
 * fixed direction, raised 1 mph at a time, cascades resolved at each step, no pressure deficit.
 */
import { DAMAGE_STEP_INTERVAL } from "../../config/buildings";
import { REPORT } from "../../config/report";
import { SIM_DEFAULTS } from "../../config/sim";
import { MS_PER_MPH } from "../../config/units";
import { pressureDeficit } from "../wind/pressure";
import type { TornadoState } from "../wind/types";
import { windAt } from "../wind/windField";
import { mphToMs } from "../wind/efScale";
import { updateBuilding } from "./building";
import type { Building } from "./types";
import type { Terrain } from "../terrain/roughness";

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


/** What a tornado pass measured at the house (Spec 03 v2.5). */
export interface PassResult {
  /** For each DOD d, the peak 10 m open-terrain wind (mph) at the house's site when it first
   *  reached DOD ≥ d (Infinity if never): the EF scale's basis, which DI 2's speeds describe. */
  first: number[];
  /** The same at roof height in the pass's terrain (mph): the local wind that loaded it. */
  firstRoof: number[];
  /** Peak 10 m open-terrain wind over the pass (mph), for censoring. */
  peak10Mph: number;
}

/**
 * A house passing through a translating tornado (DMG-04). The house stands at `site` (offset
 * sideways from the track by `lateralOffset`) and is loaded by the local roof-height wind in
 * `terrain`; DOD speeds are read from the 10 m open-terrain wind there, as the EF readout and
 * the storm recorder read them (Spec 17 v1.1, Spec 16 v1.1).
 */
export function tornadoPass(
  b: Building,
  s: TornadoState,
  terrain: Terrain = "open",
  lateralOffset = 0,
  site: { x: number; z: number } = { x: 0, z: 0 },
): PassResult {
  const first = new Array<number>(11).fill(Infinity);
  const firstRoof = new Array<number>(11).fill(Infinity);
  const R = s.rMax;
  const speed = Math.hypot(s.velocity.x, s.velocity.z);
  const dir = { x: s.velocity.x / speed, z: s.velocity.z / speed };
  const right = { x: -dir.z, z: dir.x };
  const dt = SIM_DEFAULTS.dt * DAMAGE_STEP_INTERVAL;
  const span = 8 * R;
  let peak = 0;
  let peak10 = 0;
  // The house sits at the site; the track passes `lateralOffset` to its left.
  const hx = site.x;
  const hz = site.z;
  const cx = hx - right.x * lateralOffset;
  const cz = hz - right.z * lateralOffset;
  const p = { x: hx, y: b.roofHeight, z: hz };
  const p10 = { x: hx, y: REPORT.height, z: hz };
  for (let t = 0, x = -span; x <= span; t += dt, x += speed * dt) {
    const state: TornadoState = { ...s, center: { x: cx + dir.x * x, z: cz + dir.z * x } };
    const w = windAt(p, state, terrain);
    peak = Math.max(peak, Math.hypot(w.x, w.y, w.z) / MS_PER_MPH);
    const w10 = windAt(p10, state, "open");
    peak10 = Math.max(peak10, Math.hypot(w10.x, w10.z) / MS_PER_MPH);
    const r = Math.hypot(hx - state.center.x, hz - state.center.z);
    updateBuilding(b, w, pressureDeficit(r, state), dt, t);
    for (let d = 1; d <= b.dod; d++)
      if (first[d] === Infinity) {
        first[d] = peak10;
        firstRoof[d] = peak;
      }
    if (b.dod >= 10) break;
  }
  return { first, firstRoof, peak10Mph: peak10 };
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


/**
 * Kaplan–Meier median for censored first-reach data: each house either reached the DOD at
 * `t` (observed) or never did by its peak wind `t` (censored). Returns Infinity if the
 * survival curve never drops to 0.5.
 */
export function kmMedian(samples: { t: number; observed: boolean }[]): number {
  const s = [...samples].sort((a, b) => a.t - b.t || (a.observed === b.observed ? 0 : a.observed ? -1 : 1));
  let atRisk = s.length;
  let surv = 1;
  let i = 0;
  while (i < s.length) {
    const t = s[i]!.t;
    let events = 0;
    let removed = 0;
    while (i < s.length && s[i]!.t === t) {
      if (s[i]!.observed) events++;
      removed++;
      i++;
    }
    if (events > 0 && atRisk > 0) {
      surv *= 1 - events / atRisk;
      if (surv <= 0.5) return t;
    }
    atRisk -= removed;
  }
  return Infinity;
}
