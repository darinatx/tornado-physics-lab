/**
 * Structural loads (Spec 02). Pure functions; Pa throughout.
 */
import { AIR_DENSITY } from "../../config/atmosphere";
import { APC_TAU, CP, CPI, DEAD_LOAD, OPENINGS } from "../../config/buildings";
import type { Vec2, Vec3 } from "../math/vec";
import type { Building } from "./types";

const LOCAL_NORMALS: readonly Vec2[] = [
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
  { x: 0, z: -1 },
];
const COS45 = Math.SQRT1_2;

/** Outward world-space normal of face k (0:+X, 1:+Z, 2:−X, 3:−Z in local axes). */
export function faceNormal(yaw: number, k: number): Vec2 {
  const n = LOCAL_NORMALS[k]!;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // Rotation about +Y: (x, z) → (x cos + z sin, −x sin + z cos).
  return { x: n.x * c + n.z * s, z: -n.x * s + n.z * c };
}

/** Wall area of face k (m²). Faces 0 and 2 span the depth; 1 and 3 span the width. */
export function faceArea(b: Pick<Building, "width" | "depth" | "wallHeight">, k: number): number {
  return (k % 2 === 0 ? b.depth : b.width) * b.wallHeight;
}

/** C_p of a wall face for a horizontal wind blowing toward unit direction u. */
export function faceCp(u: Vec2, n: Vec2): number {
  const mag = Math.hypot(u.x, u.z);
  if (mag < 1e-9) return 0;
  const c = -(u.x * n.x + u.z * n.z) / mag;
  if (c >= COS45 - 1e-12) return CP.windward;
  if (c <= -COS45 + 1e-12) return CP.leeward;
  return CP.side;
}

export function isBreached(b: Building): boolean {
  return b.windowFailed.some((w) => w !== null) || !!b.failed.garage || !!b.failed.roofDeck;
}

/** Internal pressure coefficient: enclosed, or dominant-opening rule over failed openings. */
export function internalCp(b: Building, u: Vec2): number {
  let area = 0;
  let sum = 0;
  for (let k = 0; k < 4; k++) {
    if (b.windowFailed[k]) {
      const a = OPENINGS.windowFraction * faceArea(b, k);
      area += a;
      sum += a * faceCp(u, faceNormal(b.yaw, k));
    }
  }
  if (b.failed.garage) {
    area += OPENINGS.garageArea;
    sum += OPENINGS.garageArea * faceCp(u, faceNormal(b.yaw, b.frontFace));
  }
  if (b.failed.roofDeck) {
    const a = OPENINGS.deckOpenFraction * b.width * b.depth;
    area += a;
    sum += a * CP.roofAverage;
  }
  if (area <= 0) return CPI.enclosed;
  return CPI.dominantOpeningFactor * (sum / area);
}

/** Advance the internal pressure lag and return p_APC (Pa, positive = outward on the envelope). */
export function updateApc(b: Building, deficitOut: number, dt: number): number {
  const tau = isBreached(b) || b.failed.roofStructure ? APC_TAU.breached : APC_TAU.sealed;
  b.deficitIn += (deficitOut - b.deficitIn) * (1 - Math.exp(-Math.max(dt, 0) / tau));
  return deficitOut - b.deficitIn;
}

export function velocityPressure(wind: Vec3): number {
  return 0.5 * AIR_DENSITY * (wind.x * wind.x + wind.y * wind.y + wind.z * wind.z);
}

export interface Loads {
  q: number;
  cpi: number;
  trim: number;
  roofCover: number;
  windows: number[];
  garage: number;
  roofDeck: number;
  roofStructure: number;
  /** Net lateral pressure across the building (Pa). */
  lateral: number;
}

export function computeLoads(b: Building, wind: Vec3, pApc: number): Loads {
  const q = velocityPressure(wind);
  const u = { x: wind.x, z: wind.z };
  const cpi = internalCp(b, u);
  const cps = [0, 1, 2, 3].map((k) => faceCp(u, faceNormal(b.yaw, k)));

  let trim = 0;
  const windows: number[] = [];
  for (let k = 0; k < 4; k++) {
    trim = Math.max(trim, q * (-cps[k]! + cpi) + pApc);
    windows.push(Math.abs(q * (cps[k]! - cpi) - pApc));
  }
  const garage = b.hasGarage ? Math.abs(q * (cps[b.frontFace]! - cpi) - pApc) : 0;
  const hasWind = Math.hypot(u.x, u.z) > 1e-9;

  return {
    q,
    cpi,
    trim,
    roofCover: q * (-CP.roofCoverEdge + cpi) + pApc,
    windows,
    garage,
    roofDeck: q * (-CP.roofDeckEdge + cpi) + pApc - DEAD_LOAD.deck,
    roofStructure: q * (-CP.roofAverage + cpi) + pApc - DEAD_LOAD.roof,
    lateral: hasWind ? q * (CP.windward - CP.leeward) : 0,
  };
}
