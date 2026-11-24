/**
 * Member aerodynamics (Spec 09).
 * Attached members: Spec 02 net pressure on their surface. Detached members: flat-plate
 * normal force on their actual orientation plus a little skin friction.
 */
import { AIR_DENSITY } from "../../config/atmosphere";
import { PLATE } from "../../config/structure";
import type { Vec3 } from "../math/vec";
import { qrot, shapePoints } from "./framing";
import type { Member, Q, Shape } from "./framing";

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

/** A member's plate in its loose body's frame (house-local axes): fixed for the body's life. */
export interface BodyPlate {
  id: number;
  /** Member center, body frame. */
  pos: Vec3;
  /** Plate normal, body frame. */
  n: Vec3;
  area: number;
  /** In-plane axes (body frame) and lengths along them, for rotational drag; null if chunky. */
  ext: { a: Vec3; b: Vec3; la: number; lb: number } | null;
}

/** Plate normal in member axes: roof sheets, shingles and ceilings lie in x–z, the rest in x–y. */
export function plateNormal(m: Pick<Member, "kind">): Vec3 {
  return m.kind === "roofSheet" || m.kind === "roofShingle" || m.kind === "ceiling" ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
}

/** The plates of a group's members in body frame (members without a plate are left out). */
export function bodyPlates(members: readonly Member[], group: readonly number[], extents: readonly ({ a: Vec3; b: Vec3; la: number; lb: number } | null)[]): BodyPlate[] {
  const out: BodyPlate[] = [];
  for (const id of group) {
    const m = members[id]!;
    const area = m.area > 0 ? m.area : (m.plate ?? 0);
    if (area <= 0) continue;
    const e = extents[id] ?? null;
    out.push({ id, pos: m.pos, n: qrot(m.q, plateNormal(m)), area, ext: e && { a: qrot(m.q, e.a), b: qrot(m.q, e.b), la: e.la, lb: e.lb } });
  }
  return out;
}

/** A rigid body's state: origin translation, rotation, center of mass, velocity, spin. */
export interface RigidState {
  t: Vec3;
  q: Q;
  com: Vec3;
  v: Vec3;
  w: Vec3;
}

/**
 * Wind on a loose rigid piece (Spec 09): plate force on each member at its own position and
 * velocity, plus rotational drag of plates turning about an in-plane axis,
 * τ = −½ρ·C_N·w·ω|ω|·L⁴/32 for span L across the axis and width w along it. Writes each
 * plate's force to `forces[i]` and returns the total force and the torque about the center of
 * mass. `oneSample` (if given) is the wind used for every member (a small piece).
 */
export function rigidAero(s: RigidState, plates: readonly BodyPlate[], wind: (p: Vec3) => Vec3, oneSample: Vec3 | null, forces: Vec3[]): { force: Vec3; torque: Vec3 } {
  const F = { x: 0, y: 0, z: 0 };
  const T = { x: 0, y: 0, z: 0 };
  const { v, w } = s;
  const k = 0.5 * AIR_DENSITY * PLATE.normalCoeff;
  for (let i = 0; i < plates.length; i++) {
    const pl = plates[i]!;
    const o = qrot(s.q, pl.pos);
    const p = { x: s.t.x + o.x, y: s.t.y + o.y, z: s.t.z + o.z };
    const n = qrot(s.q, pl.n);
    const r = { x: p.x - s.com.x, y: p.y - s.com.y, z: p.z - s.com.z };
    const vp = { x: v.x + (w.y * r.z - w.z * r.y), y: v.y + (w.z * r.x - w.x * r.z), z: v.z + (w.x * r.y - w.y * r.x) };
    const wnd = oneSample ?? wind(p);
    const f = plateForce(n, pl.area, { x: wnd.x - vp.x, y: wnd.y - vp.y, z: wnd.z - vp.z });
    if (!(Number.isFinite(f.x) && Number.isFinite(f.y) && Number.isFinite(f.z) && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) {
      forces[i] = { x: 0, y: 0, z: 0 };
      continue;
    }
    forces[i] = f;
    F.x += f.x;
    F.y += f.y;
    F.z += f.z;
    T.x += r.y * f.z - r.z * f.y;
    T.y += r.z * f.x - r.x * f.z;
    T.z += r.x * f.y - r.y * f.x;
    const e = pl.ext;
    if (e) {
      const ax = qrot(s.q, e.a);
      const bx = qrot(s.q, e.b);
      const wa = w.x * ax.x + w.y * ax.y + w.z * ax.z;
      const wb = w.x * bx.x + w.y * bx.y + w.z * bx.z;
      const ta = (-k * e.la * wa * Math.abs(wa) * e.lb ** 4) / 32;
      const tb = (-k * e.lb * wb * Math.abs(wb) * e.la ** 4) / 32;
      T.x += ax.x * ta + bx.x * tb;
      T.y += ax.y * ta + bx.y * tb;
      T.z += ax.z * ta + bx.z * tb;
    }
  }
  return { force: F, torque: T };
}
