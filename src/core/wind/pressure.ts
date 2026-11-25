/**
 * Pressure deficit from cyclostrophic balance (Spec 01 v1.3): dp/dr = ρ·v_t²/r with the
 * Rankine swirl aloft. Height-independent near the ground (imposed from above).
 */
import { AIR_DENSITY } from "../../config/atmosphere";
import type { TornadoState } from "./types";

/** Pressure drop below the far-field value at radius r (Pa, ≥ 0). */
export function pressureDeficit(r: number, s: TornadoState): number {
  if (s.tunnel) return s.tunnel.deficit;
  const R = Math.max(s.rMax, 1e-6);
  const q = AIR_DENSITY * s.vMax * s.vMax;
  const edge = q / (2 * s.alpha);
  if (r >= R) return edge * Math.pow(R / r, 2 * s.alpha);
  return edge + 0.5 * q * (1 - (r * r) / (R * R));
}

export function centralDeficit(s: TornadoState): number {
  return pressureDeficit(0, s);
}
