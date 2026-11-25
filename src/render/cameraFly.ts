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

/** Keys held for turning in place: A/D pan, E/Q tilt. */
export interface TurnKeys {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

/** W/S along the view; arrows sideways and up/down (REND-14). */
export const FLY_KEY_MAP: Readonly<Record<string, keyof FlyKeys>> = {
  KeyW: "forward", KeyS: "back", ArrowLeft: "left", ArrowRight: "right",
  ArrowUp: "up", PageUp: "up", ArrowDown: "down", PageDown: "down",
};
/** A/D pan, Q/E tilt down/up (REND-15). */
export const TURN_KEY_MAP: Readonly<Record<string, keyof TurnKeys>> = { KeyA: "left", KeyD: "right", KeyE: "up", KeyQ: "down" };

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

/**
 * The camera and orbit point after this frame's move (REND-14). W/S go along the full view
 * direction (tilt included), ←/→ sideways along the ground, ↑/↓ straight up; any combination
 * moves at the same speed. The camera stops at eye height (forward motion into the floor stops
 * where it meets it); the orbit point keeps its direction and distance from the camera, but
 * lands on the ground where the view meets it.
 */
export function flyStep(keys: FlyKeys, dt: number, camera: Vec3, target: Vec3): { camera: Vec3; target: Vec3 } {
  const f = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  const r = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const u = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
  if (!f && !r && !u) return { camera: { ...camera }, target: { ...target } };
  const vx = target.x - camera.x;
  const vy = target.y - camera.y;
  const vz = target.z - camera.z;
  const vl = Math.hypot(vx, vy, vz);
  // View direction (3-D) and its right along the ground (forward × up).
  const fw = vl > 1e-9 ? { x: vx / vl, y: vy / vl, z: vz / vl } : { x: 0, y: 0, z: -1 };
  const hl = Math.hypot(fw.x, fw.z);
  const right = hl > 1e-9 ? { x: -fw.z / hl, z: fw.x / hl } : { x: 1, z: 0 };
  // Forward (F) and sideways/vertical (G) parts, scaled together to the flying speed.
  const F = { x: f * fw.x, y: f * fw.y, z: f * fw.z };
  const G = { x: r * right.x, y: u, z: r * right.z };
  const len = Math.hypot(F.x + G.x, F.y + G.y, F.z + G.z);
  if (len < 1e-12) return { camera: { ...camera }, target: { ...target } };
  const k = (flySpeed(camera.y, keys.fast) * dt) / len;
  // Sideways and vertical first (↓ stops at the floor), then forward, stopped where it meets it.
  const c = { x: camera.x + G.x * k, y: Math.max(CAMERA.minHeight, camera.y + G.y * k), z: camera.z + G.z * k };
  let fk = k;
  if (F.y < 0 && c.y + F.y * fk < CAMERA.minHeight) fk = Math.max(0, (CAMERA.minHeight - c.y) / F.y);
  c.x += F.x * fk;
  c.y = Math.max(CAMERA.minHeight, c.y + F.y * fk);
  c.z += F.z * fk;
  // The orbit point: same direction and distance from the camera, not below the ground.
  let L = Math.max(vl, CAMERA.minDistance);
  if (fw.y < 0 && c.y + fw.y * L < 0) L = Math.max(c.y / -fw.y, CAMERA.minDistance);
  return { camera: c, target: { x: c.x + fw.x * L, y: Math.max(0, c.y + fw.y * L), z: c.z + fw.z * L } };
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
 * Starting view (REND-17): framed on the tornado. `center` is its position, `dir` its heading
 * (unit, horizontal), `rMax` its core radius (m), `cloudBase` (m), `fovDeg` the vertical field
 * of view and `aspect` width / height. The camera sits ahead on the track and to the right, at
 * the nearest distance where ground-to-cloud-base fills ≤ 80% of the height and a 4·R_max-wide
 * debris cloud ≤ 60% of the width (at least 300 m), looking at the axis partway up.
 */
export function startView(
  center: { x: number; z: number },
  dir: { x: number; z: number },
  rMax: number,
  cloudBase: number,
  fovDeg: number,
  aspect: number,
): { camera: Vec3; target: Vec3 } {
  const h = CAMERA.startHeight;
  const half = (fovDeg / 2) * (Math.PI / 180);
  // Before the canvas has a size the aspect is 0/0: assume a widescreen view.
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const hHalf = Math.atan(Math.tan(half) * a);
  // Width: 2·atan(2·R_max / D) ≤ fill · 2·hHalf.
  const dWide = (CAMERA.startDebrisWidth * rMax) / 2 / Math.tan(CAMERA.startFillWidth * hHalf);
  // Height: atan((H − h)/D) + atan(h/D) ≤ fill · 2·half; it falls with D, so bisect.
  const maxV = CAMERA.startFillHeight * 2 * half;
  const vert = (d: number) => Math.atan(Math.max(cloudBase - h, 0) / d) + Math.atan(h / d);
  let lo = 1;
  let hi = 1e6;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (vert(mid) > maxV) lo = mid;
    else hi = mid;
  }
  const D = Math.max(CAMERA.startMinDistance, dWide, hi);
  const right = { x: -dir.z, z: dir.x };
  const s = CAMERA.startSide;
  const n = Math.hypot(1, s);
  return {
    camera: { x: center.x + ((dir.x + right.x * s) / n) * D, y: h, z: center.z + ((dir.z + right.z * s) / n) * D },
    target: { x: center.x, y: cloudBase * CAMERA.startLookUp, z: center.z },
  };
}
