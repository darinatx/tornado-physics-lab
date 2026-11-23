/**
 * Tornado wind field (Spec 01): modified Rankine swirl, near-ground overshoot profile,
 * boundary-layer inflow, core updraft, and translation.
 *
 * World frame: Y up, ground plane X–Z. Cyclonic rotation is positive rotation about +Y
 * (counter-clockwise viewed from above).
 */
import { CELL_STRUCTURE, PROFILE_EPSILON, TERRAIN_BETA } from "../../config/wind";
import type { Vec3 } from "../math/vec";
import type { TerrainClass, TornadoState } from "./types";

/** Modified Rankine tangential speed aloft (no height factor). */
export function tangentialProfile(r: number, vMax: number, rMax: number, alpha: number): number {
  const R = Math.max(rMax, 1e-6);
  if (r <= R) return vMax * (r / R);
  return vMax * Math.pow(R / r, alpha);
}

/** S(r): overshoot strength, strongest at r = R_max, falling to 1 far from the core. */
export function overshootFactor(r: number, s: TornadoState): number {
  const R = Math.max(s.rMax, 1e-6);
  const x = (r - R) / R;
  return 1 + (s.overshoot - 1) * Math.exp(-x * x);
}

/** h(r, z): vertical profile multiplier on tangential speed. Continuous at z = z_p. */
export function heightFactor(r: number, z: number, s: TornadoState, terrain: TerrainClass): number {
  const S = overshootFactor(r, s);
  if (z < s.zPeak) {
    return S * Math.pow(Math.max(z / s.zPeak, PROFILE_EPSILON), TERRAIN_BETA[terrain]);
  }
  return 1 + (S - 1) * Math.exp(-(z - s.zPeak) / s.inflowDepth);
}

/** Simplified swirl ratio S = V_max / W_max (rotation relative to updraft). */
export function swirlRatio(s: TornadoState): number {
  if (s.updraftMax <= 0) return s.vMax > 0 ? Infinity : 0;
  return s.vMax / s.updraftMax;
}

/** b in [0, 1]: 0 = one-cell (central updraft), 1 = two-cell (central downdraft, updraft ring). */
export function twoCellBlend(s: TornadoState): number {
  const { swirlOneCell: s1, swirlTwoCell: s2 } = CELL_STRUCTURE;
  const u = Math.min(Math.max((swirlRatio(s) - s1) / (s2 - s1), 0), 1);
  return u * u * (3 - 2 * u);
}

/** Radial shape of the vertical velocity, blended between one-cell and two-cell. */
export function verticalShape(x: number, b: number): number {
  const oneCell = Math.exp(-x * x);
  const ring = x * x * Math.exp(1 - x * x);
  const xd = x / CELL_STRUCTURE.downdraftRadius;
  const twoCell = ring * ring - CELL_STRUCTURE.downdraftRatio * Math.exp(-xd * xd);
  return (1 - b) * oneCell + b * twoCell;
}

export interface WindComponents {
  /** Storm-relative tangential speed, including the height factor (m/s, ≥ 0). */
  tangential: number;
  /** Radial speed (m/s); negative = inward. */
  radial: number;
  /** Vertical speed (m/s); positive = up. */
  vertical: number;
}

/** Storm-relative cylindrical components at radius r and height z. */
export function windComponents(
  r: number,
  z: number,
  s: TornadoState,
  terrain: TerrainClass,
): WindComponents {
  const zz = Math.max(z, 0);
  const R = Math.max(s.rMax, 1e-6);
  const vt = tangentialProfile(r, s.vMax, R, s.alpha);
  const decay = Math.exp(-zz / s.inflowDepth);
  return {
    tangential: vt * heightFactor(r, zz, s, terrain),
    radial: -s.inflowRatio * vt * decay,
    vertical: s.updraftMax * verticalShape(r / R, twoCellBlend(s)) * (1 - decay),
  };
}

/** Ground-relative wind velocity at world point p (m/s). Pure and deterministic. */
export function windAt(p: Vec3, s: TornadoState, terrain: TerrainClass): Vec3 {
  const dx = p.x - s.center.x;
  const dz = p.z - s.center.z;
  const r = Math.hypot(dx, dz);
  const c = windComponents(r, p.y, s, terrain);

  let hx = 0;
  let hz = 0;
  if (r > 1e-9) {
    const ux = dx / r; // radial unit vector (outward)
    const uz = dz / r;
    // Tangential unit for rotation about +Y: ω × r̂ = (uz, -ux), sign by rotation sense.
    const tx = s.rotation * uz;
    const tz = -s.rotation * ux;
    hx = c.tangential * tx + c.radial * ux;
    hz = c.tangential * tz + c.radial * uz;
  }
  return { x: hx + s.velocity.x, y: c.vertical, z: hz + s.velocity.z };
}
