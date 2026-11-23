/**
 * Component layout of a one-story gable house (Spec 03 v2). Local frame: X along the width
 * (ridge), Z along the depth, Y up; faces 0:+X, 1:+Z, 2:−X, 3:−Z (front).
 */
import { AREAL_MASS, LAYOUT } from "../../config/buildings";
import type { Vec2, Vec3 } from "../math/vec";
import type { Building, HouseSpec, RoofSection, WallPanel } from "./types";

export const LOCAL_NORMALS: readonly Vec2[] = [
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
  { x: 0, z: -1 },
];

/** Along-face unit vector for face k (right-handed with the normal). */
export function faceTangent(k: number): Vec2 {
  const n = LOCAL_NORMALS[k]!;
  return { x: -n.z, z: n.x };
}

export function faceLength(b: Pick<HouseSpec, "width" | "depth">, k: number): number {
  return k % 2 === 0 ? b.depth : b.width;
}

export function columns(width: number): number {
  return Math.max(2, Math.round(width / LAYOUT.panelTarget));
}

export function endPanels(depth: number): number {
  return Math.max(2, Math.round(depth / LAYOUT.panelTarget));
}

/** Local → world for a house (applies yaw, position and any shift). */
export function toWorld(b: Pick<Building, "x" | "z" | "yaw" | "shift">, lx: number, ly: number, lz: number, shifted = true): Vec3 {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const ox = shifted ? (b.shift?.x ?? 0) : 0;
  const oz = shifted ? (b.shift?.z ?? 0) : 0;
  return { x: b.x + ox + lx * c + lz * s, y: ly, z: b.z + oz - lx * s + lz * c };
}

/** Local center of a wall panel at height h (m). */
export function panelCenter(b: Pick<HouseSpec, "width" | "depth">, p: WallPanel, h: number): Vec3 {
  const n = LOCAL_NORMALS[p.face]!;
  const t = faceTangent(p.face);
  const half = p.face % 2 === 0 ? b.width / 2 : b.depth / 2;
  return { x: n.x * half + t.x * p.u, y: h, z: n.z * half + t.z * p.u };
}

/** Lays out wall panels and roof sections; capacities are filled in by createHouse. */
export function layoutPanels(spec: HouseSpec, rng: () => number): { panels: WallPanel[]; sections: RoofSection[]; nx: number; ne: number } {
  const nx = columns(spec.width);
  const ne = endPanels(spec.depth);
  const panels: WallPanel[] = [];
  for (let face = 0; face < 4; face++) {
    const n = face % 2 === 0 ? ne : nx;
    const len = faceLength(spec, face) / n;
    for (let i = 0; i < n; i++) {
      const u = -faceLength(spec, face) / 2 + (i + 0.5) * len;
      // Roof column over this panel: eave walls follow the columns; end walls use the end bay.
      let col: number;
      if (face === 3) col = i; // tangent +X: u increases with x
      else if (face === 1) col = nx - 1 - i; // tangent −X
      else col = face === 0 ? nx - 1 : 0;
      const isGarage = spec.hasGarage && face === 3 && i === 0;
      panels.push({
        face,
        u,
        len,
        col,
        isGarage,
        hasWindow: !isGarage && rng() < LAYOUT.windowShare,
        cap: 0,
        failed: null,
      });
    }
  }
  const sections: RoofSection[] = [];
  for (let col = 0; col < nx; col++)
    for (const slope of [-1, 1] as const)
      for (const row of [0, 1] as const)
        sections.push({
          col,
          slope,
          row,
          // Corner zones (end column, eave row) carry the highest suction.
          edge: (col === 0 || col === nx - 1) && row === 0,
          area: 0,
          coverCap: 0,
          deckCap: 0,
          cover: null,
          deck: null,
        });
  for (const s of sections) s.area = sectionGeometry(spec, nx, s).area;
  return { panels, sections, nx, ne };
}

/** Geometry of a roof section in local coordinates: center, size and pitch. */
export function sectionGeometry(b: Pick<HouseSpec, "width" | "depth" | "wallHeight" | "roofRise">, nx: number, s: RoofSection) {
  const oh = LAYOUT.overhang;
  const halfRun = b.depth / 2 + oh;
  const pitch = Math.atan2(b.roofRise, b.depth / 2);
  const slopeLen = halfRun / Math.cos(pitch);
  const colW = (b.width + 2 * oh) / nx;
  const x = -b.width / 2 - oh + (s.col + 0.5) * colW;
  // Row 0 covers the outer half of the slope (toward the eave), row 1 the inner half.
  const frac = s.row === 0 ? 0.75 : 0.25;
  const z = s.slope * halfRun * frac;
  // Height along the slope line from the eave (wallHeight − oh·tan) to the ridge.
  const eaveY = b.wallHeight - oh * Math.tan(pitch);
  const y = eaveY + (b.wallHeight + b.roofRise - eaveY) * (1 - frac);
  return { center: { x, y, z }, width: colW, length: slopeLen / 2, pitch: s.slope * pitch, area: colW * (slopeLen / 2) };
}

/** Component masses (kg) for bookkeeping and debris. */
export function panelMass(b: Pick<HouseSpec, "wallHeight">, p: WallPanel): number {
  return AREAL_MASS.wallPanel * p.len * b.wallHeight;
}
