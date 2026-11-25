/**
 * Debris contact with houses and slabs (Spec 10): shared by the town debris field and the
 * detail zone's light pieces.
 */
import { IMPACT } from "../../config/impacts";
import type { Vec3 } from "../math/vec";
import { supportHeight } from "../debris/piece";
import type { Piece } from "../debris/piece";
import { overSlab, slabHalf } from "./envelope";
import type { ImpactTargets } from "./envelope";

/** Half a piece's box extent along unit direction n (m). Box axes: X length, Y thickness, Z width. */
export function halfExtentAlong(p: Piece, n: Vec3): number {
  const [x, y, z, w] = p.q;
  const ax = { x: 1 - 2 * (y * y + z * z), y: 2 * (x * y + w * z), z: 2 * (x * z - w * y) };
  const ay = { x: 2 * (x * y - w * z), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z + w * x) };
  const az = { x: 2 * (x * z + w * y), y: 2 * (y * z - w * x), z: 1 - 2 * (x * x + y * y) };
  const [L, W, T] = p.def.dims;
  const d = (a: Vec3) => Math.abs(a.x * n.x + a.y * n.y + a.z * n.z);
  return 0.5 * (d(ax) * L + d(ay) * T + d(az) * W);
}

/** Height of the ground under a piece (m): a slab top if its center is over one (nothing can
 *  be under a slab: pieces reach it only from above, and any found low there sit on it), else 0. */
export function floorUnder(p: Piece, targets: ImpactTargets): number {
  for (const b of targets.near(p.pos.x, p.pos.z)) if (overSlab(b, p.pos)) return IMPACT.slabTop;
  return 0;
}
/**
 * A piece whose box ends up inside a slab is pushed out the shortest way: up onto the top, or
 * out past the nearest side (Spec 10 v0.3), losing its speed into the slab.
 */
export function unbury(p: Piece, targets: ImpactTargets): void {
  const bottom = p.pos.y - supportHeight(p);
  const top = IMPACT.slabTop;
  if (bottom >= top - 0.01) return;
  for (const b of targets.near(p.pos.x, p.pos.z)) {
    const h = slabHalf(b);
    const c = Math.cos(b.yaw);
    const sn = Math.sin(b.yaw);
    const dx = p.pos.x - b.x;
    const dz = p.pos.z - b.z;
    const lx = dx * c - dz * sn;
    const lz = dx * sn + dz * c;
    // Slab-local axes in the world.
    const ax = { x: c, y: 0, z: -sn };
    const az = { x: sn, y: 0, z: c };
    const outX = h.x - Math.abs(lx) + halfExtentAlong(p, ax);
    const outZ = h.z - Math.abs(lz) + halfExtentAlong(p, az);
    // Its box doesn't reach under this slab.
    if (outX <= 0.01 || outZ <= 0.01) continue;
    const centerOver = Math.abs(lx) <= h.x && Math.abs(lz) <= h.z;
    const up = top - bottom;
    // Center over the slab: onto the top if that's shortest. Center off it: out past the side
    // (it can't hang half on the slab and half in the air).
    if (centerOver && up <= outX && up <= outZ) {
      p.pos.y += up;
      if (p.vel.y < 0) p.vel.y = 0;
    } else {
      const n = outX < outZ ? { x: Math.sign(lx || 1) * ax.x, z: Math.sign(lx || 1) * ax.z } : { x: Math.sign(lz || 1) * az.x, z: Math.sign(lz || 1) * az.z };
      const d = Math.min(outX, outZ) + 0.01;
      p.pos.x += n.x * d;
      p.pos.z += n.z * d;
      const vn = p.vel.x * n.x + p.vel.z * n.z;
      if (vn < 0) {
        p.vel.x -= vn * n.x;
        p.vel.z -= vn * n.z;
      }
    }
    return;
  }
}
/** Bounce off a surface (normal n toward the piece): v_n reversed × e, friction on the rest. IMP-08. */
export function bounce(p: Piece, point: Vec3, n: Vec3, vn: number): void {
  const e = IMPACT.restitution;
  const v = p.vel;
  // Normal part −vn → +e·vn.
  v.x += (1 + e) * vn * n.x;
  v.y += (1 + e) * vn * n.y;
  v.z += (1 + e) * vn * n.z;
  const un = v.x * n.x + v.y * n.y + v.z * n.z;
  const tx = v.x - un * n.x;
  const ty = v.y - un * n.y;
  const tz = v.z - un * n.z;
  const vt = Math.hypot(tx, ty, tz);
  const keep = vt > 1e-9 ? Math.max(vt - IMPACT.friction * (1 + e) * vn, 0) / vt : 0;
  v.x = un * n.x + tx * keep;
  v.y = un * n.y + ty * keep;
  v.z = un * n.z + tz * keep;
  const ext = halfExtentAlong(p, n) + 0.01;
  p.pos = { x: point.x + n.x * ext, y: Math.max(point.y + n.y * ext, 0), z: point.z + n.z * ext };
}