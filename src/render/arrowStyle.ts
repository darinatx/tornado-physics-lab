/** Arrow color and length mapping (REND-01, REND-02). Pure; no Three.js. */
import { EF_LOWER_MPH, efRating, mphToMs } from "../core/wind/efScale";

/** EF0..EF5 colors (hex). */
export const EF_COLORS = [0x3fa7d6, 0x4cbb6c, 0xf2d43d, 0xf39c33, 0xe0453a, 0xc03ad6] as const;
export const BELOW_EF0_COLOR = 0x6b7480;

export const EF5_THRESHOLD_MS = mphToMs(EF_LOWER_MPH[5]);

export function arrowColor(speedMs: number): number {
  const ef = efRating(speedMs);
  return ef === null ? BELOW_EF0_COLOR : EF_COLORS[ef];
}

export function arrowLength(speedMs: number, maxLength: number): number {
  return Math.min(Math.max(speedMs, 0) / EF5_THRESHOLD_MS, 1) * maxLength;
}
