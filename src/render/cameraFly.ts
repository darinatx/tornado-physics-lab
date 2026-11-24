/**
 * Keyboard flying for the free camera (Spec 06 v1.7, REND-14). Pure: given the keys held, the
 * time step and the camera and orbit-point positions, the move to apply to both.
 */
import { CAMERA } from "../config/render";
import type { Vec3 } from "../core/math/vec";

export interface FlyKeys {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  fast: boolean;
}

export const NO_KEYS: FlyKeys = { forward: false, back: false, left: false, right: false, up: false, down: false, fast: false };

/** Flying speed (m/s) at a camera height (m): ~1.2 m/s per metre, clamped; ×4 with Shift. */
export function flySpeed(height: number, fast: boolean): number {
  const v = Math.min(CAMERA.flyMaxSpeed, Math.max(CAMERA.flyMinSpeed, CAMERA.flySpeedPerMetre * Math.max(height, 0)));
  return fast ? v * CAMERA.fastFactor : v;
}

/** The moves (m) to add to the camera and its orbit point this frame: the same, except that
 *  neither goes below its floor (eye height for the camera, the ground for the point). */
export function flyStep(keys: FlyKeys, dt: number, camera: Vec3, target: Vec3): { camera: Vec3; target: Vec3 } {
  const f = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  const r = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const u = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
  if (!f && !r && !u) return { camera: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 } };
  // Forward: the view direction along the ground; right: forward × up.
  let fx = target.x - camera.x;
  let fz = target.z - camera.z;
  const len = Math.hypot(fx, fz);
  if (len < 1e-9) {
    fx = 0;
    fz = -1;
  } else {
    fx /= len;
    fz /= len;
  }
  const rx = -fz;
  const rz = fx;
  const step = flySpeed(camera.y, keys.fast) * dt;
  // Horizontal moves are along the ground; together they keep the same speed diagonally.
  const h = f && r ? Math.SQRT1_2 : 1;
  const dy = u * step;
  const dx = (f * fx + r * rx) * h * step;
  const dz = (f * fz + r * rz) * h * step;
  // Never below eye height (camera) or the ground (orbit point).
  return {
    camera: { x: dx, y: Math.max(dy, CAMERA.minHeight - camera.y), z: dz },
    target: { x: dx, y: Math.max(dy, -target.y), z: dz },
  };
}

/**
 * Turn the camera in place (Spec 06 v1.7, REND-15): the new point to look at, after turning by
 * `yaw` (rad, positive = left, about the vertical) and `pitch` (rad, positive = up, about the
 * camera's right axis). The camera stays put; pitch stays within ±maxPitch of level; looking
 * down, the point lands where the view meets the ground.
 */
export function lookStep(camera: Vec3, target: Vec3, yaw: number, pitch: number): Vec3 {
  let dx = target.x - camera.x;
  let dy = target.y - camera.y;
  let dz = target.z - camera.z;
  const dist = Math.max(Math.hypot(dx, dy, dz), 1e-6);
  const flat = Math.hypot(dx, dz);
  const heading = flat > 1e-9 ? Math.atan2(dx, dz) : 0;
  const elev = Math.atan2(dy, flat);
  const h = heading + yaw;
  const e = Math.min(CAMERA.maxPitch, Math.max(-CAMERA.maxPitch, elev + pitch));
  dx = Math.sin(h) * Math.cos(e);
  dz = Math.cos(h) * Math.cos(e);
  dy = Math.sin(e);
  // Keep the same distance, but not below the ground: stop where the view meets it.
  let L = dist;
  if (camera.y + dy * L < 0) L = camera.y / -dy;
  // Looking up or level from low down, keep the point a usable distance away (it sets the
  // pan and zoom scale).
  L = Math.max(L, CAMERA.minDistance);
  return { x: camera.x + dx * L, y: Math.max(0, camera.y + dy * L), z: camera.z + dz * L };
}
