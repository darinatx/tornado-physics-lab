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

/** Arrow keys held for turning in place. */
export interface TurnKeys {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

export const FLY_KEY_MAP: Readonly<Record<string, keyof FlyKeys>> = {
  KeyW: "forward", KeyS: "back", KeyA: "left", KeyD: "right",
  KeyE: "up", PageUp: "up", KeyQ: "down", PageDown: "down",
};
export const TURN_KEY_MAP: Readonly<Record<string, keyof TurnKeys>> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

export interface KeyLike {
  code: string;
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** Release every flying and turning key. */
export function releaseAll(keys: FlyKeys, turn: TurnKeys): void {
  Object.assign(keys, NO_KEYS);
  Object.assign(turn, { left: false, right: false, up: false, down: false });
}

/**
 * Update the held keys for a key event (REND-16). A key-up always releases its key, whatever has
 * focus or modifiers. ⌘, Ctrl or Alt pressed releases everything: macOS sends no key-up for keys
 * released while ⌘ is held, so they would otherwise stay held. Key-downs while typing in a field
 * are ignored. Returns true when the event was used (the page shouldn't also act on it).
 */
export function keyEvent(keys: FlyKeys, turn: TurnKeys, e: KeyLike, down: boolean, typing: boolean): boolean {
  keys.fast = e.shiftKey;
  if (down && (e.metaKey || e.ctrlKey || e.altKey || e.key === "Meta")) {
    releaseAll(keys, turn);
    return false;
  }
  const tk = TURN_KEY_MAP[e.code];
  const k = FLY_KEY_MAP[e.code];
  if (!tk && !k) return false;
  if (!down) {
    if (tk) turn[tk] = false;
    else keys[k!] = false;
    return false;
  }
  if (typing) return false;
  if (tk) turn[tk] = true;
  else keys[k!] = true;
  return true;
}

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

/**
 * Starting view (REND-17): over the town on the side the tornado is coming toward, looking
 * back at it. `center` is the tornado's position, `dir` its heading (unit, horizontal),
 * `townHalf` half the town's square extent (m).
 */
export function startView(center: { x: number; z: number }, dir: { x: number; z: number }, townHalf: number, cloudBase: number): { camera: Vec3; target: Vec3 } {
  // Where the track enters the town square (slab method); 0 if it starts inside.
  let tIn = 0;
  for (const [c, d] of [[center.x, dir.x], [center.z, dir.z]] as const) {
    if (Math.abs(d) < 1e-9) continue;
    const t1 = (-townHalf - c) / d;
    const t2 = (townHalf - c) / d;
    tIn = Math.max(tIn, Math.min(t1, t2));
  }
  const ahead = Math.max(CAMERA.startMinAhead, tIn + CAMERA.startInsideTown);
  const right = { x: -dir.z, z: dir.x };
  const side = CAMERA.startSide * ahead;
  return {
    camera: { x: center.x + dir.x * ahead + right.x * side, y: CAMERA.startHeight, z: center.z + dir.z * ahead + right.z * side },
    target: { x: center.x, y: cloudBase * CAMERA.startLookUp, z: center.z },
  };
}
