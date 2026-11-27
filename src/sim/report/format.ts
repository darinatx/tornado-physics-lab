/**
 * Report units and wording (Spec 16): speeds in mph with m/s alongside, distances in miles and
 * km, as US reports give them. SI inside; converted only here, at the report's boundary.
 */
import { MS_PER_MPH } from "../../config/units";

export const M_PER_MI = 1609.344;
export const M_PER_YD = 0.9144;

export const mphOf = (ms: number) => ms / MS_PER_MPH;

/** "142 mph (63 m/s)". */
export function speedText(mph: number): string {
  return `${Math.round(mph)} mph (${Math.round(mph * MS_PER_MPH)} m/s)`;
}

/** "1.36 mi (2.19 km)" for long distances; "350 yd (320 m)" under a quarter mile. */
export function distText(m: number): string {
  if (m < M_PER_MI / 4) return `${Math.round(m / M_PER_YD / 10) * 10} yd (${Math.round(m / 10) * 10} m)`;
  return `${(m / M_PER_MI).toFixed(2)} mi (${(m / 1000).toFixed(2)} km)`;
}

/** Path width as surveys give it: "750 yd (686 m)". */
export function widthText(m: number): string {
  return `${Math.round(m / M_PER_YD / 10) * 10} yd (${Math.round(m)} m)`;
}

/** "1.2 km (0.7 mi)": positions relative to the town center. */
export function placeDist(m: number): string {
  if (m < 100) return "at";
  return `${(m / 1000).toFixed(1)} km (${(m / M_PER_MI).toFixed(1)} mi)`;
}

/** "1.2 km (0.7 mi) WSW of the town center", or "at the town center". */
export function placeText(p: { distance: number; compass: string }): string {
  return p.distance < 100 ? "at the town center" : `${placeDist(p.distance)} ${p.compass} of the town center`;
}

/** Sim time as "2 min 05 s" (or "45 s"). */
export function timeText(t: number): string {
  const s = Math.max(0, Math.round(t));
  const m = Math.floor(s / 60);
  return m ? `${m} min ${String(s % 60).padStart(2, "0")} s` : `${s} s`;
}

/** Compass point names for a heading, as words ("northeast"). */
const WORDS: Record<string, string> = {
  N: "north", NNE: "north-northeast", NE: "northeast", ENE: "east-northeast", E: "east", ESE: "east-southeast", SE: "southeast", SSE: "south-southeast",
  S: "south", SSW: "south-southwest", SW: "southwest", WSW: "west-southwest", W: "west", WNW: "west-northwest", NW: "northwest", NNW: "north-northwest",
};
export const compassWord = (c: string) => WORDS[c] ?? c;
