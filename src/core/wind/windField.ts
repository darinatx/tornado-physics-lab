/**
 * Tornado wind field (Spec 01): modified Rankine swirl, near-ground overshoot profile,
 * boundary-layer inflow, core updraft, and translation.
 *
 * World frame: Y up, ground plane X–Z. Cyclonic rotation is positive rotation about +Y
 * (counter-clockwise viewed from above).
 */
import { CELL_STRUCTURE, ENV_REFERENCE_HEIGHT, ENV_SURFACE_WIND, OUTER_DECAY, PROFILE_EPSILON, TERRAIN_BETA, WIND_PARAMS } from "../../config/wind";
import type { Vec3 } from "../math/vec";
import type { TerrainClass, TornadoState, TunnelFlow } from "./types";
import { TUNNEL } from "../../config/tunnel";
import { betaAt, isField } from "../terrain/roughness";
import type { RoughnessField, Terrain } from "../terrain/roughness";

/** n_o for a state: its outer reach, or the default (Spec 01 v1.11). At least 1. */
export function outerReach(s: { readonly outerReach?: number }): number {
  return Math.max(s.outerReach ?? WIND_PARAMS.outerReach.default, 1);
}

/**
 * Modified Rankine tangential speed aloft (no height factor): r^(−α) out to r_o = n_o·R_max,
 * then a free vortex (Spec 01 v1.10).
 */
export function tangentialProfile(
  r: number,
  vMax: number,
  rMax: number,
  alpha: number,
  reach: number = WIND_PARAMS.outerReach.default,
): number {
  const R = Math.max(rMax, 1e-6);
  if (r <= R) return vMax * (r / R);
  const n = Math.max(reach, 1);
  const ro = n * R;
  if (r <= ro) return vMax * Math.pow(R / r, alpha);
  return vMax * Math.pow(1 / n, alpha) * Math.pow(ro / r, OUTER_DECAY.exponent);
}

/** S(r): overshoot strength, strongest at r = R_max, falling to 1 far from the core. */
export function overshootFactor(r: number, s: TornadoState): number {
  const R = Math.max(s.rMax, 1e-6);
  const x = (r - R) / R;
  return 1 + (s.overshoot - 1) * Math.exp(-x * x);
}

/** h(r, z): vertical profile multiplier on tangential speed. Continuous at z = z_p. */
export function heightFactor(r: number, z: number, s: TornadoState, terrain: TerrainClass | number): number {
  const S = overshootFactor(r, s);
  if (z < s.zPeak) {
    return S * Math.pow(Math.max(z / s.zPeak, PROFILE_EPSILON), typeof terrain === "number" ? terrain : TERRAIN_BETA[terrain]);
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

/** Storm-relative cylindrical components at radius r and height z (terrain: a class or β). */
export function windComponents(
  r: number,
  z: number,
  s: TornadoState,
  terrain: TerrainClass | number,
): WindComponents {
  const zz = Math.max(z, 0);
  const R = Math.max(s.rMax, 1e-6);
  const vt = tangentialProfile(r, s.vMax, R, s.alpha, outerReach(s));
  const decay = Math.exp(-zz / s.inflowDepth);
  return {
    tangential: vt * heightFactor(r, zz, s, terrain),
    radial: -s.inflowRatio * vt * decay,
    vertical: s.updraftMax * verticalShape(r / R, twoCellBlend(s)) * (1 - decay),
  };
}

/** Surface-layer factor for the environmental (translation) wind: 1 at ≥ 10 m, power law below
 *  (terrain: a class or β). */
export function envFactor(z: number, terrain: TerrainClass | number): number {
  if (z >= ENV_REFERENCE_HEIGHT) return 1;
  return Math.pow(Math.max(z / ENV_REFERENCE_HEIGHT, PROFILE_EPSILON), typeof terrain === "number" ? terrain : TERRAIN_BETA[terrain]);
}

/**
 * The carried wind as a multiple of V_trans (Spec 01 v1.8): g·V_trans + (1 − g)·V_env with
 * g = 1 inside R_max and the swirl's shape v_t / V_max beyond (v1.10), and V_env = V_trans·min(1, U_env / |V_trans|).
 */
export function carriedFactors(r: number, s: TornadoState): number {
  const g = r <= s.rMax ? 1 : tangentialProfile(r, 1, s.rMax, s.alpha, outerReach(s));
  const speed = Math.hypot(s.velocity.x, s.velocity.z);
  const env = speed > ENV_SURFACE_WIND ? ENV_SURFACE_WIND / speed : 1;
  return g + (1 - g) * env;
}

/**
 * β at p for a roughness field (Spec 17): read for the direction of the horizontal wind at z_p,
 * above the friction layer, where roughness doesn't turn it.
 */
function localBeta(p: Vec3, s: TornadoState, f: Terrain, r: number, dx: number, dz: number): number {
  if (!isField(f)) return TERRAIN_BETA[f];
  return betaAt(f, p.x, p.z, windDirAtPeak(s, r, dx, dz));
}

function windDirAtPeak(s: TornadoState, r: number, dx: number, dz: number): number {
  let hx = 0;
  let hz = 0;
  if (r > 1e-9) {
    const R = Math.max(s.rMax, 1e-6);
    const vt = tangentialProfile(r, s.vMax, R, s.alpha) * overshootFactor(r, s);
    const vr = -s.inflowRatio * tangentialProfile(r, s.vMax, R, s.alpha) * Math.exp(-s.zPeak / s.inflowDepth);
    const ux = dx / r;
    const uz = dz / r;
    hx = vt * s.rotation * uz + vr * ux;
    hz = -vt * s.rotation * ux + vr * uz;
  }
  const k = carriedFactors(r, s);
  hx += k * s.velocity.x;
  hz += k * s.velocity.z;
  return Math.atan2(hz, hx);
}

/** Direction (rad, from +X toward +Z) of the horizontal wind at z_p over p: the direction the
 *  roughness fetch is read for (Spec 17). */
export function fetchDirection(p: Vec3, s: TornadoState): number {
  const dx = p.x - s.center.x;
  const dz = p.z - s.center.z;
  return windDirAtPeak(s, Math.hypot(dx, dz), dx, dz);
}

/** β the wind at p feels (Spec 17): the class value, or the field's for the wind's direction. */
export function windBeta(p: Vec3, s: TornadoState, terrain: Terrain): number {
  if (s.tunnel) return isField(terrain) ? betaAt(terrain, p.x, p.z, (-s.tunnel.dirDeg * Math.PI) / 180) : TERRAIN_BETA[terrain];
  const dx = p.x - s.center.x;
  const dz = p.z - s.center.z;
  return localBeta(p, s, terrain, Math.hypot(dx, dz), dx, dz);
}

/** Ground-relative wind velocity at world point p (m/s). Pure and deterministic. */
export function windAt(p: Vec3, s: TornadoState, terrain: Terrain): Vec3 {
  if (s.tunnel) return tunnelWind(p, s.tunnel, terrain);
  if (isField(terrain)) return windOverField(p, s, terrain);
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
  const e = envFactor(p.y, terrain);
  const k = carriedFactors(r, s);
  return { x: hx + e * k * s.velocity.x, y: c.vertical, z: hz + e * k * s.velocity.z };
}

/**
 * windAt over a roughness field (Spec 17): the same components as windComponents, with β read
 * for the direction of the wind at z_p over p (above the friction layer, where roughness doesn't
 * turn it), each shared factor computed once.
 */
function windOverField(p: Vec3, s: TornadoState, f: RoughnessField): Vec3 {
  const dx = p.x - s.center.x;
  const dz = p.z - s.center.z;
  const r = Math.hypot(dx, dz);
  const zz = Math.max(p.y, 0);
  const R = Math.max(s.rMax, 1e-6);
  const vt = tangentialProfile(r, s.vMax, R, s.alpha);
  const S = overshootFactor(r, s);
  const k = carriedFactors(r, s);
  const ux = r > 1e-9 ? dx / r : 0;
  const uz = r > 1e-9 ? dz / r : 0;
  const tx = s.rotation * uz;
  const tz = -s.rotation * ux;
  // Roughness only matters below z_p (vortex) and 10 m (carried wind).
  let beta = 0;
  if (zz < s.zPeak || zz < ENV_REFERENCE_HEIGHT) {
    const vtp = vt * S;
    const vrp = -s.inflowRatio * vt * Math.exp(-s.zPeak / s.inflowDepth);
    const hx = vtp * tx + vrp * ux + k * s.velocity.x;
    const hz = vtp * tz + vrp * uz + k * s.velocity.z;
    beta = betaAt(f, p.x, p.z, Math.atan2(hz, hx));
  }
  const h = zz < s.zPeak ? S * Math.pow(Math.max(zz / s.zPeak, PROFILE_EPSILON), beta) : 1 + (S - 1) * Math.exp(-(zz - s.zPeak) / s.inflowDepth);
  const decay = Math.exp(-zz / s.inflowDepth);
  const tangential = vt * h;
  const radial = -s.inflowRatio * vt * decay;
  const vertical = s.updraftMax * verticalShape(r / R, twoCellBlend(s)) * (1 - decay);
  const e = p.y >= ENV_REFERENCE_HEIGHT ? 1 : Math.pow(Math.max(p.y / ENV_REFERENCE_HEIGHT, PROFILE_EPSILON), beta);
  const hx = r > 1e-9 ? tangential * tx + radial * ux : 0;
  const hz = r > 1e-9 ? tangential * tz + radial * uz : 0;
  return { x: hx + e * k * s.velocity.x, y: vertical, z: hz + e * k * s.velocity.z };
}

/** Wind tunnel wind at p (Spec 12): U10·envFactor(z) along the direction, plus the ramped vertical
 *  wind. Over a roughness field, β is read at p for the tunnel's direction (Spec 17). */
export function tunnelWind(p: Vec3, f: TunnelFlow, terrain: Terrain): Vec3 {
  const a = (f.dirDeg * Math.PI) / 180;
  const beta = isField(terrain) ? (p.y < ENV_REFERENCE_HEIGHT ? betaAt(terrain, p.x, p.z, -a) : 0) : terrain;
  const u = f.u10 * envFactor(p.y, beta);
  return { x: u * Math.cos(a), y: f.w * Math.min(Math.max(p.y, 0) / TUNNEL.wRampHeight, 1), z: -u * Math.sin(a) };
}
