/**
 * One debris piece: tumble-averaged drag and lift, gravity, ground contact (Spec 04).
 */
import { AIR_DENSITY, GRAVITY } from "../../config/atmosphere";
import { DEBRIS, DEBRIS_KINDS, GROUND_DRAG } from "../../config/debris";
import type { DebrisKind, DebrisKindDef } from "../../config/debris";
import type { Vec3 } from "../math/vec";

export interface Piece {
  id: number;
  kind: DebrisKind;
  /** Physical properties: the kind's, or sized to the failed component. */
  def: DebrisKindDef;
  pos: Vec3;
  vel: Vec3;
  /** Orientation quaternion (x, y, z, w). */
  q: [number, number, number, number];
  /** Spin sense: +1 gives upward lift in a horizontal relative wind. */
  spin: 1 | -1;
  resting: boolean;
  /** Caught on an obstacle while sliding. */
  snagged: boolean;
  /** In contact with the ground (resting or sliding). */
  grounded?: boolean;
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
  /** Roll of the lift vector about the relative wind (rad): 0 = straight up, ± = sideways. */
  liftRoll: number;
  /** This piece's current turbulent gust (m/s), added to the mean wind. */
  gust: Vec3;
  /** Hidden from the debris field (rubble carried off when its slab was swept). */
  hidden?: boolean;
  /** A heavy piece moving as a rigid body in the heavy-debris world (Spec 04 v2.0): the point
   *  model leaves it alone while set. */
  rigid?: boolean;
  /** Retired from the heavy-debris world: the field moves it to the permanent debris field. */
  settleNow?: boolean;
  /** Where its source house stands (m), for spreading representative copies (Spec 10). */
  origin?: { x: number; z: number };
  /** Stuck through a house surface (Spec 10): its key in the field's lodged list. */
  lodgedIn?: string;
  /** Detail zone: has been clear of the house it tore off (Spec 10 v0.6). */
  clearOfHouse?: boolean;
  /** Detail zone: its last step ended against something fixed (it was stopped there). */
  blocked?: boolean;
}

export function terminalSpeed(kindOrPiece: DebrisKind | Piece): number {
  const k = typeof kindOrPiece === "string" ? DEBRIS_KINDS[kindOrPiece] : kindOrPiece.def;
  return Math.sqrt((2 * k.mass * GRAVITY) / (AIR_DENSITY * k.cda));
}

/** Lift force for relative wind `rel` (N). Perpendicular to rel; upward for horizontal rel when spin = +1. */
export function liftForce(p: Piece, rel: Vec3): Vec3 {
  const k = p.def;
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
  let ox = lx / lmag;
  let oy = ly / lmag;
  let oz = lz / lmag;
  if (p.liftRoll) {
    // Rotate the lift direction about the relative wind: mix in the horizontal side axis.
    const am = Math.hypot(ax, az);
    const c = Math.cos(p.liftRoll);
    const s = Math.sin(p.liftRoll);
    ox = c * ox + (s * ax) / am;
    oy = c * oy;
    oz = c * oz + (s * az) / am;
  }
  const m = f * lmag;
  return { x: m * ox, y: m * oy, z: m * oz };
}

/**
 * Drag area (C_D·A, m²) of a piece on the ground for flow along unit direction d (Spec 04
 * v1.8): the area its box actually shows that flow (C_D 1.2), plus skin friction on its top
 * face (C_f 0.05). Not its tumbling average: a wall panel lying flat shows the wind only its
 * edge. Box axes: X length, Y thickness, Z width.
 */
export function groundCda(p: Piece, d: Vec3): number {
  const [x, y, z, w] = p.q;
  const [L, W, T] = p.def.dims;
  const ax = { x: 1 - 2 * (y * y + z * z), y: 2 * (x * y + w * z), z: 2 * (x * z - w * y) };
  const ay = { x: 2 * (x * y - w * z), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z + w * x) };
  const az = { x: 2 * (x * z + w * y), y: 2 * (y * z - w * x), z: 1 - 2 * (x * x + y * y) };
  const dot = (a: Vec3) => Math.abs(a.x * d.x + a.y * d.y + a.z * d.z);
  // Projected area: each face pair's area times how squarely it faces the flow.
  const projected = dot(ax) * W * T + dot(ay) * L * W + dot(az) * L * T;
  return Math.min(GROUND_DRAG.cd * projected + GROUND_DRAG.skin * L * W, p.def.cda);
}

/** Forces on a piece lying on the ground in wind w (N): horizontal drag, upward force, weight. */
export function restingForces(p: Piece, w: Vec3): { drag: number; up: number; weight: number } {
  const k = p.def;
  const mag = Math.hypot(w.x, w.y, w.z);
  const wh = Math.hypot(w.x, w.z);
  const dragArea = wh > 1e-9 ? groundCda(p, { x: w.x / wh, y: 0, z: w.z / wh }) : 0;
  const drag = 0.5 * AIR_DENSITY * dragArea * mag * wh;
  // A flat sheet on the ground gets suction lift regardless of spin sense.
  const lift = k.cla > 0 && p.liftOn ? 0.5 * AIR_DENSITY * k.cla * wh * wh : 0;
  const up = 0.5 * AIR_DENSITY * groundCda(p, UP) * mag * w.y + lift;
  return { drag, up, weight: k.mass * GRAVITY };
}

const UP: Vec3 = { x: 0, y: 1, z: 0 };

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

/**
 * Half the vertical extent of a piece in its current orientation (m): how high its center
 * must be for its lowest corner to touch the ground. Box axes: X = length, Y = thickness,
 * Z = width.
 */
export function supportHeight(p: Piece): number {
  const [x, y, z, w] = p.q;
  const [L, W, T] = p.def.dims;
  const rxY = 2 * (x * y + w * z);
  const ryY = 1 - 2 * (x * x + z * z);
  const rzY = 2 * (y * z - w * x);
  return 0.5 * (Math.abs(rxY) * L + Math.abs(ryY) * T + Math.abs(rzY) * W);
}

/** Flat on the ground keeping its heading and which face is up, center half its thickness up. */
export function flatten(p: Piece): void {
  const [x, y, z, w] = p.q;
  // Long axis (+X) in the world, projected on the ground.
  const lx = 1 - 2 * (y * y + z * z);
  const lz = 2 * (x * z - w * y);
  const a = Math.hypot(lx, lz) > 1e-3 ? Math.atan2(-lz, lx) : (p.id * 2.399963) % (2 * Math.PI);
  const yaw: [number, number, number, number] = [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
  // Face down stays face down: thickness axis (+Y) pointing down → turned over about its length.
  const faceDown = 1 - 2 * (x * x + z * z) < 0;
  p.q = faceDown ? quatMul(yaw, [1, 0, 0, 0]) : yaw;
  p.pos.y = p.def.dims[2] / 2;
  p.grounded = true;
}

/** Try to wake a resting piece. Returns true if it starts moving. */
export function wakeIfForced(p: Piece, w: Vec3): boolean {
  const f = restingForces(p, w);
  if (f.up > f.weight) {
    p.resting = false;
    p.snagged = false;
    p.snagDir = null;
    p.grounded = false;
    p.pos.y += 0.05;
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
  return !p.resting && !!p.grounded && p.vel.y === 0;
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
  const k = p.def;
  const v = p.vel;
  const rel = { x: w.x - v.x, y: w.y - v.y, z: w.z - v.z };
  const relMag = Math.hypot(rel.x, rel.y, rel.z);
  const wMag = Math.hypot(w.x, w.y, w.z);
  if (wMag > p.maxWindMet) p.maxWindMet = wMag;

  const wasGrounded = !!p.grounded;
  // On the ground, the area it shows the relative wind (Spec 04 v1.8); aloft, tumble-averaged.
  const cda = wasGrounded && relMag > 1e-9 ? groundCda(p, { x: rel.x / relMag, y: rel.y / relMag, z: rel.z / relMag }) : k.cda;
  const kd = (0.5 * AIR_DENSITY * cda * relMag) / k.mass;
  // Lying on the ground, a sheet's lift is suction over its top face: always upward, whichever
  // way it would tumble (Spec 04 v1.6), as in restingForces.
  const L = wasGrounded && k.cla > 0 && p.liftOn ? { x: 0, y: 0.5 * AIR_DENSITY * k.cla * (rel.x * rel.x + rel.z * rel.z), z: 0 } : liftForce(p, rel);
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

  // Tumbling about the horizontal axis perpendicular to the relative wind: only once clear of
  // the ground by half its length (autorotation needs room; a hop over a bump just rides low).
  if (relMag > 1e-6 && !p.grounded && p.pos.y - supportHeight(p) > DEBRIS.tumbleClearance * k.dims[0]) {
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

  // Ground contact at the piece's lowest corner, not its center.
  const floor = supportHeight(p);
  p.grounded = p.pos.y <= floor;
  // Lifted off the ground: the wind got under its leading edge, which pitches it nose-up, so it
  // starts tumbling in the sense that gives upward lift (Tachikawa 1983).
  if (wasGrounded && !p.grounded) p.spin = 1;
  if (p.grounded) {
    p.pos.y = floor;
    if (v.y < 0) {
      const impact = -v.y;
      v.y = impact > DEBRIS.minBounceSpeed ? DEBRIS.restitution * impact : 0;
      // A piece that stops bouncing settles flat and slides on its face.
      if (v.y === 0) flatten(p);
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

/**
 * Rough ground (Spec 04 v1.7): a sliding piece crossing a slide of `d` metres may run over a
 * bump, a ramp of slope tan θ ~ U(0, max). It keeps its speed along the ramp and loses the part
 * into it: v_up = v_h·cos θ·sin θ, v_h → v_h·cos²θ; leading edge first, so it leaves nose-up
 * (spin +1). Returns true if it hit one.
 */
export function bumpKick(p: Piece, d: number, spacing: number, rng: () => number): boolean {
  if (rng() >= 1 - Math.exp(-d / spacing)) return false;
  const th = Math.atan(rng() * DEBRIS.bumpMaxSlope);
  const c = Math.cos(th);
  // A piece longer than a bump pivots on its trailing edge: its center rises at half the rate.
  const pivot = p.def.dims[0] > DEBRIS.bumpLength ? 0.5 : 1;
  p.vel.y = Math.hypot(p.vel.x, p.vel.z) * c * Math.sin(th) * pivot;
  p.vel.x *= c * c;
  p.vel.z *= c * c;
  p.pos.y += 1e-4; // just off the ground
  p.grounded = false;
  p.spin = 1;
  return true;
}
