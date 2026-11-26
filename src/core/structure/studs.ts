/**
 * Stud bending (Spec 09 v0.18): a wall frame's studs span from the sill to the top plate and
 * break in bending under the wall's out-of-plane load.
 */
import { LUMBER, STUD_BENDING } from "../../config/structure";

/** Bending capacity of one stud (N·m): MOR · S · k_sys, S = b·d²/6. */
export function studCapacity(): number {
  const [b, d] = LUMBER.stud;
  return (STUD_BENDING.mor * b * d * d) / 6 * STUD_BENDING.systemFactor;
}

/**
 * Bending moment in each of `n` studs (N·m) carrying the wall's total out-of-plane load `W` (N)
 * over height `H` (m): simply supported when braced at the top, a cantilever from the sill when not.
 */
export function studMoment(W: number, H: number, n: number, braced: boolean): number {
  return (W * H) / ((braced ? 8 : 2) * Math.max(n, 1));
}
