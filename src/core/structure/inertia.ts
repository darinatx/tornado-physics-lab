/**
 * Inertial relief for a free-flying rigid group (Spec 09, STR-10).
 * The group accelerates as a whole, so each member's connections carry only the part of its
 * external force not spent accelerating its own mass with the group:
 *   f_i = F_i − m_i·(ΣF/M) − m_i·ω×(ω×r_i)
 * Gravity acts on every member in proportion to its mass, so it cancels and is left out.
 */
import type { Vec3 } from "../math/vec";

export function inertialRelief(masses: number[], forces: Vec3[], pos: Vec3[], com: Vec3, w: Vec3): Vec3[] {
  let M = 0;
  const F = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < masses.length; i++) {
    M += masses[i]!;
    F.x += forces[i]!.x;
    F.y += forces[i]!.y;
    F.z += forces[i]!.z;
  }
  const a = { x: F.x / M, y: F.y / M, z: F.z / M };
  return masses.map((m, i) => {
    const rx = pos[i]!.x - com.x;
    const ry = pos[i]!.y - com.y;
    const rz = pos[i]!.z - com.z;
    const wx = w.y * rz - w.z * ry;
    const wy = w.z * rx - w.x * rz;
    const wz = w.x * ry - w.y * rx;
    const cx = w.y * wz - w.z * wy;
    const cy = w.z * wx - w.x * wz;
    const cz = w.x * wy - w.y * wx;
    const f = forces[i]!;
    return { x: f.x - m * (a.x + cx), y: f.y - m * (a.y + cy), z: f.z - m * (a.z + cz) };
  });
}
