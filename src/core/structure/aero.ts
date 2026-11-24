/**
 * Member aerodynamics (Spec 09).
 * Attached members: Spec 02 net pressure on their surface. Detached members: flat-plate
 * normal force on their actual orientation plus a little skin friction.
 */
import { AIR_DENSITY } from "../../config/atmosphere";
import { PLATE } from "../../config/structure";
import type { Vec3 } from "../math/vec";
import { shapePoints } from "./framing";
import type { Shape } from "./framing";

/**
 * Force on a flat plate of area A with unit normal n in relative wind v_rel (m/s):
 * normal part ½ρ·C_N·A·|v_rel|·(v_rel·n)·n, plus skin friction along the plate.
 */
export function plateForce(n: Vec3, area: number, vRel: Vec3): Vec3 {
  const speed = Math.hypot(vRel.x, vRel.y, vRel.z);
  if (speed < 1e-9 || area <= 0) return { x: 0, y: 0, z: 0 };
  const vn = vRel.x * n.x + vRel.y * n.y + vRel.z * n.z;
  const fn = 0.5 * AIR_DENSITY * PLATE.normalCoeff * area * speed * vn;
  // Tangential component of the relative wind drives skin friction.
  const tx = vRel.x - vn * n.x;
  const ty = vRel.y - vn * n.y;
  const tz = vRel.z - vn * n.z;
  const ff = 0.5 * AIR_DENSITY * PLATE.frictionCoeff * area * speed;
  return { x: fn * n.x + ff * tx, y: fn * n.y + ff * ty, z: fn * n.z + ff * tz };
}

/**
 * Force on an attached surface from a net pressure (Pa, positive pushes inward against the
 * outward normal n) over area A.
 */
export function pressureForce(netInward: number, n: Vec3, area: number): Vec3 {
  return { x: -netInward * area * n.x, y: -netInward * area * n.y, z: -netInward * area * n.z };
}

/**
 * A member's plate extents for rotational drag: its two in-plane axes (member-local) and the
 * lengths along them, from the bounding box of its shapes; null for chunky members.
 */
export function plateExtent(shapes: Shape[]): { a: Vec3; b: Vec3; la: number; lb: number } | null {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const s of shapes)
    for (const p of shapePoints(s)) {
      const v = [p.x, p.y, p.z];
      for (let i = 0; i < 3; i++) {
        lo[i] = Math.min(lo[i]!, v[i]!);
        hi[i] = Math.max(hi[i]!, v[i]!);
      }
    }
  const d = [0, 1, 2].map((i) => hi[i]! - lo[i]!);
  const thin = d.indexOf(Math.min(...d));
  if (d[thin]! > 0.06) return null;
  const [i, j] = [0, 1, 2].filter((k) => k !== thin) as [number, number];
  const axis = (k: number): Vec3 => ({ x: k === 0 ? 1 : 0, y: k === 1 ? 1 : 0, z: k === 2 ? 1 : 0 });
  return { a: axis(i), b: axis(j), la: d[i]!, lb: d[j]! };
}
