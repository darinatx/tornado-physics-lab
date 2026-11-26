/**
 * Wind tunnel flow schedule and wind state (Spec 12). Kept apart from the tunnel itself so the
 * sim loop can use it without importing the tunnel.
 */
import { TUNNEL } from "../config/tunnel";
import { mphToMs } from "../core/wind/efScale";
import type { TornadoState, TunnelFlow } from "../core/wind/types";
import { defaultParams } from "./types";
import type { TornadoParams } from "./types";

/** A wind keyframe: speed at 10 m (mph, the EF-scale boundary), direction it blows toward
 *  (deg, 0 = +X, counter-clockwise from above), vertical wind (m/s) and deficit (Pa). */
export interface WindKey {
  t: number;
  mph: number;
  dirDeg: number;
  w?: number;
  deficit?: number;
}

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** The tunnel's flow at time t (Spec 12): linear in time, direction along the shorter arc,
 *  held outside the schedule. */
export function tunnelFlow(keys: readonly WindKey[], t: number): TunnelFlow {
  if (!keys.length) return { u10: 0, dirDeg: 0, w: 0, deficit: 0 };
  const at = (k: WindKey): TunnelFlow => ({ u10: mphToMs(k.mph), dirDeg: k.dirDeg, w: k.w ?? 0, deficit: k.deficit ?? 0 });
  if (t <= keys[0]!.t) return at(keys[0]!);
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i]!;
    if (t > b.t) continue;
    const a = keys[i - 1]!;
    const s = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
    const lerp = (x: number, y: number) => x + (y - x) * s;
    return {
      u10: mphToMs(lerp(a.mph, b.mph)),
      dirDeg: a.dirDeg + wrap(b.dirDeg - a.dirDeg) * s,
      w: lerp(a.w ?? 0, b.w ?? 0),
      deficit: lerp(a.deficit ?? 0, b.deficit ?? 0),
    };
  }
  return at(keys[keys.length - 1]!);
}

/** The wind state the sim hands every subsystem in the tunnel: the flow, and the whole tunnel
 *  marked as in range (center at the target, never behind, a huge core radius). */
export function tunnelState(f: TunnelFlow, p: Partial<TornadoParams> = {}): TornadoState {
  const d = { ...defaultParams(), ...p };
  return Object.freeze({
    center: Object.freeze({ x: 0, z: 0 }),
    velocity: Object.freeze({ x: 0, z: 0 }),
    vMax: 1,
    rMax: TUNNEL.inRange,
    alpha: d.alpha,
    outerReach: d.outerReach,
    inflowRatio: d.inflowRatio,
    inflowDepth: d.inflowDepth,
    updraftMax: d.updraftMax,
    overshoot: d.overshoot,
    zPeak: d.zPeak,
    rotation: d.rotation,
    tunnel: Object.freeze({ ...f }),
  });
}

