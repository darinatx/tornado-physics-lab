/**
 * Enhanced Fujita scale mapping (Spec 01). Speeds are 3-second-gust equivalent.
 */
import { MS_PER_MPH } from "../../config/units";

export type EFRating = 0 | 1 | 2 | 3 | 4 | 5;

/** Lower bound (mph) of EF0..EF5. */
export const EF_LOWER_MPH = [65, 86, 111, 136, 166, 201] as const;

export function msToMph(ms: number): number {
  return ms / MS_PER_MPH;
}

export function mphToMs(mph: number): number {
  return mph * MS_PER_MPH;
}

/** EF rating for a wind speed in m/s; null below EF0 (65 mph). */
export function efRating(speedMs: number): EFRating | null {
  // Small tolerance so exact-boundary values survive the m/s ↔ mph round trip.
  const mph = msToMph(speedMs) + 1e-9;
  if (mph < EF_LOWER_MPH[0]) return null;
  let ef = 0;
  for (let i = 1; i < EF_LOWER_MPH.length; i++) {
    if (mph >= EF_LOWER_MPH[i]!) ef = i;
  }
  return ef as EFRating;
}
