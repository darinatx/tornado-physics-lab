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

/** Keys held for turning in place: ←/→ turn, E/Q tilt. */
export interface TurnKeys {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

/** W/S forward/back level, A/D left/right, ↑/↓ height (Spec 06 v1.12, REND-14). */
export const FLY_KEY_MAP: Readonly<Record<string, keyof FlyKeys>> = {
  KeyW: "forward", KeyS: "back", KeyA: "left", KeyD: "right",
  ArrowUp: "up", PageUp: "up", ArrowDown: "down", PageDown: "down",
};
/** ←/→ turn, Q/E tilt down/up (REND-15). */
export const TURN_KEY_MAP: Readonly<Record<string, keyof TurnKeys>> = { ArrowLeft: "left", ArrowRight: "right", KeyE: "up", KeyQ: "down" };

/** Input types that aren't typed into: the camera keys still work with these focused. */
const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "button", "submit", "reset", "color", "file", "image"]);

/**
 * Whether the focused element is a text field being typed in (REND-16): only then do the
 * camera keys go to it. Checkboxes, menus, buttons and sliders don't take them.
 */
export function isTyping(el: { tagName: string; type?: string; isContentEditable?: boolean } | null): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") return !NON_TEXT_INPUTS.has((el.type ?? "").toLowerCase());
  return false;
}

/** How far follow mode carries the camera this frame (REND-18): with the tornado's motion,
 *  but not across the jump to a new run's start point. */
export function followDelta(from: { x: number; z: number } | null, to: { x: number; z: number }, newRun: boolean): { x: number; z: number } {
  if (!from || newRun) return { x: 0, z: 0 };
  return { x: to.x - from.x, z: to.z - from.z };
}

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
 * The camera and orbit point after this frame's move (REND-14). W/S go level along the ground
 * in the direction the camera faces (tilt doesn't change the height), A/D sideways along the
 * ground, ↑/↓ straight up; any combination moves at the same speed. The camera stops at eye
 * height; the orbit point keeps its direction and distance from the camera, but lands on the
 * ground where the view meets it.
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
  // View direction (3-D), its heading along the ground and its right (heading × up). The pitch
  // limit keeps the heading defined.
  const fw = vl > 1e-9 ? { x: vx / vl, y: vy / vl, z: vz / vl } : { x: 0, y: 0, z: -1 };
  const hl = Math.hypot(fw.x, fw.z);
  const head = hl > 1e-9 ? { x: fw.x / hl, z: fw.z / hl } : { x: 0, z: -1 };
  const right = { x: -head.z, z: head.x };
  // Level forward/sideways and vertical parts, scaled together to the flying speed.
  const m = { x: f * head.x + r * right.x, y: u, z: f * head.z + r * right.z };
  const len = Math.hypot(m.x, m.y, m.z);
  if (len < 1e-12) return { camera: { ...camera }, target: { ...target } };
  const k = (flySpeed(camera.y, keys.fast) * dt) / len;
  const c = { x: camera.x + m.x * k, y: Math.max(CAMERA.minHeight, camera.y + m.y * k), z: camera.z + m.z * k };
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
 * Starting view (Spec 06 v1.13, REND-17): over the town center `town`, CAMERA.startHeight up,
 * looking at the spawn point's axis at CAMERA.startLookUp of the cloud base (m). If the tornado
 * spawns on top of the town center, it looks along its heading `dir` (unit, horizontal).
 */
export function startView(
  town: { x: number; z: number },
  spawn: { x: number; z: number },
  dir: { x: number; z: number },
  cloudBase: number,
): { camera: Vec3; target: Vec3 } {
  const camera = { x: town.x, y: CAMERA.startHeight, z: town.z };
  const y = cloudBase * CAMERA.startLookUp;
  if (Math.hypot(spawn.x - town.x, spawn.z - town.z) < 1) {
    const L = Math.max(CAMERA.minDistance, 300);
    return { camera, target: { x: town.x + dir.x * L, y, z: town.z + dir.z * L } };
  }
  return { camera, target: { x: spawn.x, y, z: spawn.z } };
}

/**
 * Turning follow on (Spec 06 v1.16, REND-19): the point to look at, the core's center on the
 * ground (the middle of the R_max ring). The camera isn't moved. On the axis (within 1 m), it
 * looks out along its current heading `heading` (unit, horizontal).
 */
export function aimAtCore(camera: Vec3, center: { x: number; z: number }, heading: { x: number; z: number }): Vec3 {
  if (Math.hypot(center.x - camera.x, center.z - camera.z) < 1) {
    const L = Math.max(CAMERA.minDistance, 300);
    return { x: camera.x + heading.x * L, y: 0, z: camera.z + heading.z * L };
  }
  return { x: center.x, y: 0, z: center.z };
}

/**
 * The look point `t` seconds into the eased turn (REND-19) from looking at `from` to looking at
 * `to`, with the camera fixed: the direction turns along the great circle between the two and
 * the distance changes in step, eased in and out over CAMERA.followTurnTime.
 */
export function turnToward(camera: Vec3, from: Vec3, to: Vec3, t: number): Vec3 {
  const T = CAMERA.followTurnTime;
  if (t >= T) return { ...to };
  const x = Math.max(0, t / T);
  const e = x * x * (3 - 2 * x);
  const a = { x: from.x - camera.x, y: from.y - camera.y, z: from.z - camera.z };
  const b = { x: to.x - camera.x, y: to.y - camera.y, z: to.z - camera.z };
  const la = Math.max(Math.hypot(a.x, a.y, a.z), 1e-9);
  const lb = Math.max(Math.hypot(b.x, b.y, b.z), 1e-9);
  const u = { x: a.x / la, y: a.y / la, z: a.z / la };
  const v = { x: b.x / lb, y: b.y / lb, z: b.z / lb };
  const cos = Math.min(1, Math.max(-1, u.x * v.x + u.y * v.y + u.z * v.z));
  const w = Math.acos(cos);
  let d: Vec3;
  if (w < 1e-6) d = v;
  else {
    const sw = Math.sin(w);
    // Opposite directions have no unique great circle: go round through the vertical side.
    const k0 = sw > 1e-6 ? Math.sin((1 - e) * w) / sw : 1 - e;
    const k1 = sw > 1e-6 ? Math.sin(e * w) / sw : e;
    d = { x: u.x * k0 + v.x * k1, y: u.y * k0 + v.y * k1, z: u.z * k0 + v.z * k1 };
    const dl = Math.max(Math.hypot(d.x, d.y, d.z), 1e-9);
    d = { x: d.x / dl, y: d.y / dl, z: d.z / dl };
  }
  const L = la + (lb - la) * e;
  return { x: camera.x + d.x * L, y: Math.max(0, camera.y + d.y * L), z: camera.z + d.z * L };
}

/** A camera input, for deciding whether follow carries on (REND-19). */
export type CameraInput = "move" | "slide" | "turn" | "height" | "zoom";

/**
 * Whether follow stays on after this input (Spec 06 v1.15, REND-19): following means facing the
 * core, so inputs that keep the look point on it (height, zoom straight at it) keep following,
 * and those that move or aim the camera elsewhere (W/A/S/D, sliding, turning) end it.
 */
export function keepsFollow(input: CameraInput): boolean {
  return input === "height" || input === "zoom";
}
