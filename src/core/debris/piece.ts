/**
 * One debris piece: tumble-averaged drag and lift, gravity, ground contact (Spec 04).
 */
import { AIR_DENSITY, GRAVITY } from "../../config/atmosphere";
import { DEBRIS, DEBRIS_KINDS } from "../../config/debris";
import type { DebrisKind } from "../../config/debris";
import type { Vec3 } from "../math/vec";

export interface Piece {
  id: number;
  kind: DebrisKind;
  pos: Vec3;
  vel: Vec3;
  /** Orientation quaternion (x, y, z, w). */
  q: [number, number, number, number];
  /** Spin sense: +1 gives upward lift in a horizontal relative wind. */
  spin: 1 | -1;
  resting: boolean;
  /** Caught on an obstacle while sliding. */
  snagged: boolean;
  /** Horizontal direction the piece was moving when it snagged (unit), or null. */
  snagDir: { x: number; z: number } | null;
  bornAt: number;
  restedAt: number;
  /** Real objects this simulated piece stands for. */
  represents: number;
  color: number;
  /** House that shed it. */
  sourceId: number;
  /** Fastest wind this piece has met (m/s), for the DEB-07 sanity check. */
  maxWindMet: number;
  /** Lift switch, for tests. */
  liftOn: boolean;
}

export function terminalSpeed(kind: DebrisKind): number {
  const k = DEBRIS_KINDS[kind];
  return Math.sqrt((2 * k.mass * GRAVITY) / (AIR_DENSITY * k.cda));
}

/** Lift force for relative wind `rel` (N). Perpendicular to rel; upward for horizontal rel when spin = +1. */
export function liftForce(p: Piece, rel: Vec3): Vec3 {
  const k = DEBRIS_KINDS[p.kind];
  const zero = { x: 0, y: 0, z: 0 };
  if (k.cla <= 0 || !p.liftOn) return zero;
  // axis = rel × up = (−rel.z, 0, rel.x); lift direction = axis × rel.
  const ax = -rel.z;
  const az = rel.x;
  const lx = -rel.x * rel.y;
  const ly = rel.x * rel.x + rel.z * rel.z;
  const lz = -rel.z * rel.y;
  const lmag = Math.hypot(lx, ly, lz);
  if (Math.hypot(ax, az) < 1e-9 || lmag < 1e-12) return zero;
  const relMag2 = rel.x * rel.x + rel.y * rel.y + rel.z * rel.z;
  const f = (p.spin * 0.5 * AIR_DENSITY * k.cla * relMag2) / lmag;
  return { x: f * lx, y: f * ly, z: f * lz };
}

/** Forces on a piece lying on the ground in wind w (N): horizontal drag, upward force, weight. */
export function restingForces(p: Piece, w: Vec3): { drag: number; up: number; weight: number } {
  const k = DEBRIS_KINDS[p.kind];
  const mag = Math.hypot(w.x, w.y, w.z);
  const wh = Math.hypot(w.x, w.z);
  const drag = 0.5 * AIR_DENSITY * k.cda * mag * wh;
  // A flat sheet on the ground gets suction lift regardless of spin sense.
  const lift = k.cla > 0 && p.liftOn ? 0.5 * AIR_DENSITY * k.cla * wh * wh : 0;
  const up = 0.5 * AIR_DENSITY * k.cda * mag * w.y + lift;
  return { drag, up, weight: k.mass * GRAVITY };
}

function quatMul(a: readonly number[], b: readonly number[]): [number, number, number, number] {
  const [ax, ay, az, aw] = a as [number, number, number, number];
  const [bx, by, bz, bw] = b as [number, number, number, number];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Flat on the ground with a deterministic yaw. */
export function flatten(p: Piece): void {
  const a = (p.id * 2.399963) % (2 * Math.PI);
  p.q = [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
}

/** Try to wake a resting piece. Returns true if it starts moving. */
export function wakeIfForced(p: Piece, w: Vec3): boolean {
  const f = restingForces(p, w);
  if (f.up > f.weight) {
    p.resting = false;
    p.snagged = false;
    p.snagDir = null;
    p.pos.y = 0.05;
    return true;
  }
  if (f.drag > DEBRIS.holdFriction * Math.max(f.weight - f.up, 0)) {
    // A snagged piece is pinned against its obstacle unless the wind now pulls it back.
    const pinned = p.snagged && p.snagDir !== null && w.x * p.snagDir.x + w.z * p.snagDir.z >= 0;
    if (!pinned) {
      p.resting = false;
      p.snagged = false;
      p.snagDir = null;
      return true;
    }
  }
  return false;
}

/** True while a piece is sliding along the ground. */
export function isSliding(p: Piece): boolean {
  return !p.resting && p.pos.y === 0 && p.vel.y === 0;
}

/** Catch a sliding piece on an obstacle. */
export function snag(p: Piece): void {
  const vh = Math.hypot(p.vel.x, p.vel.z);
  p.snagDir = vh > 1e-9 ? { x: p.vel.x / vh, z: p.vel.z / vh } : null;
  p.vel.x = p.vel.y = p.vel.z = 0;
  p.resting = true;
  p.snagged = true;
  flatten(p);
}

/** Advance an airborne or sliding piece by dt in local wind w. */
export function stepPiece(p: Piece, w: Vec3, dt: number): void {
  const k = DEBRIS_KINDS[p.kind];
  const v = p.vel;
  const rel = { x: w.x - v.x, y: w.y - v.y, z: w.z - v.z };
  const relMag = Math.hypot(rel.x, rel.y, rel.z);
  const wMag = Math.hypot(w.x, w.y, w.z);
  if (wMag > p.maxWindMet) p.maxWindMet = wMag;

  const kd = (0.5 * AIR_DENSITY * k.cda * relMag) / k.mass;
  const L = liftForce(p, rel);
  const ax = L.x / k.mass;
  const ay = L.y / k.mass - GRAVITY;
  const az = L.z / k.mass;
  // Semi-implicit in drag: stable for light, draggy pieces.
  const inv = 1 / (1 + kd * dt);
  v.x = (v.x + dt * (ax + kd * w.x)) * inv;
  v.y = (v.y + dt * (ay + kd * w.y)) * inv;
  v.z = (v.z + dt * (az + kd * w.z)) * inv;
  p.pos.x += v.x * dt;
  p.pos.y += v.y * dt;
  p.pos.z += v.z * dt;

  // Tumbling about the horizontal axis perpendicular to the relative wind.
  if (relMag > 1e-6) {
    let axx = -rel.z;
    let axz = rel.x;
    const am = Math.hypot(axx, axz);
    if (am > 1e-9) {
      axx /= am;
      axz /= am;
      const omega = (k.spinRate * relMag) / k.dims[0];
      const half = (p.spin * omega * dt) / 2;
      const s = Math.sin(half);
      p.q = quatMul([axx * s, 0, axz * s, Math.cos(half)], p.q);
    }
  }

  // Ground contact.
  if (p.pos.y <= 0) {
    p.pos.y = 0;
    if (v.y < 0) {
      const impact = -v.y;
      v.y = impact > DEBRIS.minBounceSpeed ? DEBRIS.restitution * impact : 0;
      // Friction impulse from the landing.
      const vh = Math.hypot(v.x, v.z);
      if (vh > 0) {
        const keep = Math.max(vh - DEBRIS.friction * impact, 0) / vh;
        v.x *= keep;
        v.z *= keep;
      }
    }
    if (v.y === 0) {
      // Sliding: Coulomb friction against the normal force left after aerodynamic uplift.
      const f = restingForces(p, w);
      const normal = Math.max(f.weight - f.up, 0);
      const vh = Math.hypot(v.x, v.z);
      if (vh > 0) {
        const dv = (DEBRIS.friction * normal * dt) / k.mass;
        const keep = Math.max(vh - dv, 0) / vh;
        v.x *= keep;
        v.z *= keep;
      }
      if (Math.hypot(v.x, v.z) < DEBRIS.restSpeed && f.up < f.weight && f.drag <= DEBRIS.holdFriction * normal) {
        v.x = v.y = v.z = 0;
        p.resting = true;
        flatten(p);
      }
    }
  }
}
