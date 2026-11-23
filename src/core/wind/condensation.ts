/**
 * Condensation funnel shape (Spec 06 v1.2). Air at height z condenses when the tornado's
 * pressure drop matches the drop it would get from being lifted to the cloud base:
 * Δp(r) ≥ ρ·g·(H − z).
 */
import { AIR_DENSITY, GRAVITY } from "../../config/atmosphere";
import { pressureDeficit } from "./pressure";
import type { TornadoState } from "./types";

/** Pressure drop needed for condensation at height z (Pa). */
export function condensationDeficit(z: number, cloudBase: number): number {
  return AIR_DENSITY * GRAVITY * Math.max(cloudBase - z, 0);
}

/** Funnel radius at height z (m); 0 where there's no condensation. */
export function funnelRadius(z: number, s: TornadoState, cloudBase: number, maxRadius = Infinity): number {
  const need = condensationDeficit(z, cloudBase);
  const q = AIR_DENSITY * s.vMax * s.vMax;
  if (q <= 0) return need <= 0 ? maxRadius : 0;
  if (need <= 0) return maxRadius;
  const R = Math.max(s.rMax, 1e-6);
  const edge = q / (2 * s.alpha);
  const center = edge + q / 2;
  if (need > center) return 0;
  const r =
    need >= edge
      ? R * Math.sqrt(Math.max(1 - (2 * (need - edge)) / q, 0))
      : R * Math.pow((2 * s.alpha * need) / q, -1 / (2 * s.alpha));
  return Math.min(r, maxRadius);
}

/** Height of the funnel's tip (m); 0 if it reaches the ground. */
export function funnelBottom(s: TornadoState, cloudBase: number): number {
  const center = pressureDeficit(0, s);
  return Math.min(Math.max(cloudBase - center / (AIR_DENSITY * GRAVITY), 0), cloudBase);
}
