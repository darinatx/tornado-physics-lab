/**
 * Pressure deficit from cyclostrophic balance (Spec 01 v1.3, v1.10): dp/dr = ρ·v_t²/r with the
 * Rankine swirl aloft and its free-vortex tail beyond r_o. Height-independent near the ground
 * (imposed from above).
 */
import { AIR_DENSITY } from "../../config/atmosphere";
import { OUTER_DECAY } from "../../config/wind";
import type { TornadoState } from "./types";

/** The deficit's pieces for a state, in Pa: q = ρ·V_max², at R_max, at r_o, at the center. */
export function deficitTerms(s: TornadoState) {
  const R = Math.max(s.rMax, 1e-6);
  const ro = OUTER_DECAY.radiusRatio * R;
  const ao = OUTER_DECAY.exponent;
  const q = AIR_DENSITY * s.vMax * s.vMax;
  const m = Math.pow(OUTER_DECAY.radiusRatio, -2 * s.alpha);
  const atRo = (q * m) / (2 * ao);
  const atR = (q * (1 - m)) / (2 * s.alpha) + atRo;
  return { R, ro, ao, q, atRo, atR, center: atR + q / 2 };
}

/** Pressure drop below the far-field value at radius r (Pa, ≥ 0). */
export function pressureDeficit(r: number, s: TornadoState): number {
  if (s.tunnel) return s.tunnel.deficit;
  const { R, ro, ao, q, atRo, atR } = deficitTerms(s);
  if (r >= ro) return atRo * Math.pow(ro / r, 2 * ao);
  if (r >= R) return atRo + ((q / (2 * s.alpha)) * (Math.pow(R / r, 2 * s.alpha) - Math.pow(R / ro, 2 * s.alpha)));
  return atR + 0.5 * q * (1 - (r * r) / (R * R));
}

export function centralDeficit(s: TornadoState): number {
  return pressureDeficit(0, s);
}
