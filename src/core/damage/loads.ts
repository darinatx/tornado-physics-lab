/**
 * Structural loads per component (Spec 02 v2). Pure functions; Pa throughout.
 */
import { AIR_DENSITY } from "../../config/atmosphere";
import { APC_TAU, CP, CPI, DEAD_LOAD, LAYOUT } from "../../config/buildings";
import type { Vec2, Vec3 } from "../math/vec";
import { LOCAL_NORMALS } from "./layout";
import type { Building, RoofSection } from "./types";

const COS45 = Math.SQRT1_2;

/** Outward world-space normal of face k (0:+X, 1:+Z, 2:−X, 3:−Z in local axes). */
export function faceNormal(yaw: number, k: number): Vec2 {
  const n = LOCAL_NORMALS[k]!;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // Rotation about +Y: (x, z) → (x cos + z sin, −x sin + z cos).
  return { x: n.x * c + n.z * s, z: -n.x * s + n.z * c };
}

/** C_p of a wall face for a horizontal wind blowing toward u. */
export function faceCp(u: Vec2, n: Vec2): number {
  const mag = Math.hypot(u.x, u.z);
  if (mag < 1e-9) return 0;
  const c = -(u.x * n.x + u.z * n.z) / mag;
  if (c >= COS45 - 1e-12) return CP.windward;
  if (c <= -COS45 + 1e-12) return CP.leeward;
  return CP.side;
}

export function velocityPressure(wind: Vec3): number {
  return 0.5 * AIR_DENSITY * (wind.x * wind.x + wind.y * wind.y + wind.z * wind.z);
}

export function sectionGone(b: Building, s: RoofSection): boolean {
  return !!s.deck || !!b.bays[s.col]!.failed;
}

export function isBreached(b: Building): boolean {
  return b.breached;
}

/** Internal pressure coefficient: enclosed, or the dominant-opening rule over all openings. */
export function internalCp(b: Building, cpFace: readonly number[]): number {
  if (!b.breached) return CPI.enclosed;
  let area = 0;
  let sum = 0;
  const add = (a: number, cp: number) => {
    area += a;
    sum += a * cp;
  };
  for (const pane of b.panes) {
    const panel = b.panels[pane.panel]!;
    if (pane.failed && !panel.failed) add(LAYOUT.paneSize * LAYOUT.paneSize, cpFace[panel.face]!);
  }
  if (b.garage?.failed && !b.panels[b.garage.panel]!.failed) add(LAYOUT.garageWidth * LAYOUT.garageHeight, cpFace[3]!);
  for (const p of b.panels) if (p.failed) add(p.len * b.wallHeight, cpFace[p.face]!);
  for (const s of b.sections) if (sectionGone(b, s)) add(s.area, CP.roofAverage);
  // Debris perforations (Spec 10): faces 0–3, roof at 4.
  for (let f = 0; f < 4; f++) if (b.holes[f]! > 0) add(b.holes[f]!, cpFace[f]!);
  if (b.holes[4]! > 0) add(b.holes[4]!, CP.roofAverage);
  if (area <= 0) return CPI.enclosed;
  return CPI.dominantOpeningFactor * (sum / area);
}

/** Advance the internal pressure lag and return p_APC (Pa, positive = outward on the envelope). */
export function updateApc(b: Building, deficitOut: number, dt: number): number {
  const tau = isBreached(b) ? APC_TAU.breached : APC_TAU.sealed;
  b.deficitIn += (deficitOut - b.deficitIn) * (1 - Math.exp(-Math.max(dt, 0) / tau));
  return deficitOut - b.deficitIn;
}

export interface HouseLoads {
  q: number;
  cpi: number;
  cpFace: number[];
  /** Net lateral pressure across the house (Pa). */
  lateral: number;
}

export function computeHouseLoads(b: Building, wind: Vec3): HouseLoads {
  const q = velocityPressure(wind);
  const u = { x: wind.x, z: wind.z };
  const cpFace = [faceCp(u, b.normals[0]!), faceCp(u, b.normals[1]!), faceCp(u, b.normals[2]!), faceCp(u, b.normals[3]!)];
  const hasWind = Math.hypot(u.x, u.z) > 1e-9;
  return { q, cpi: internalCp(b, cpFace), cpFace, lateral: hasWind ? q * (CP.windward - CP.leeward) : 0 };
}

export const sidingLoad = (L: HouseLoads, face: number, pApc: number) => L.q * (-L.cpFace[face]! + L.cpi) + pApc;
export const coverLoad = (L: HouseLoads, s: RoofSection, pApc: number) =>
  L.q * (-(s.edge ? CP.coverEdge : CP.coverField) + L.cpi) + pApc;
export const deckLoad = (L: HouseLoads, s: RoofSection, pApc: number) =>
  L.q * (-(s.edge ? CP.deckEdge : CP.deckField) + L.cpi) + pApc - DEAD_LOAD.deck;
export const bayLoad = (L: HouseLoads, pApc: number) => L.q * (-CP.roofAverage + L.cpi) + pApc - DEAD_LOAD.roof;
/** Signed net pressure on a wall-face element: positive pushes inward. */
export const wallSigned = (L: HouseLoads, face: number, pApc: number) => L.q * (L.cpFace[face]! - L.cpi) - pApc;
