/**
 * Condensation funnel shape (Spec 06 v1.2). Air at height z condenses when the tornado's
 * pressure drop matches the drop it would get from being lifted to the cloud base:
 * Δp(r) ≥ ρ·g·(H − z).
 */
import { AIR_DENSITY, GRAVITY } from "../../config/atmosphere";
import { deficitTerms, pressureDeficit } from "./pressure";
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
  // Invert the piecewise deficit (Spec 01 v1.10): core, r^(−α) ring, free-vortex tail.
  const { R, ro, ao, atRo, atR, center } = deficitTerms(s);
  if (need > center) return 0;
  let r: number;
  if (need >= atR) r = R * Math.sqrt(Math.max(1 - (2 * (need - atR)) / q, 0));
  else if (need >= atRo) {
    const x = ((need - atRo) * 2 * s.alpha) / q + Math.pow(R / ro, 2 * s.alpha); // (R / r)^(2α)
    r = R * Math.pow(x, -1 / (2 * s.alpha));
  } else r = ro * Math.pow(need / atRo, -1 / (2 * ao));
  return Math.min(r, maxRadius);
}

/** Height of the funnel's tip (m); 0 if it reaches the ground. */
export function funnelBottom(s: TornadoState, cloudBase: number): number {
  const center = pressureDeficit(0, s);
  return Math.min(Math.max(cloudBase - center / (AIR_DENSITY * GRAVITY), 0), cloudBase);
}
