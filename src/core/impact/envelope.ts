/**
 * Component house envelope (Spec 10): a convex solid (walls under two roof planes) clipped
 * against a debris piece's step, and the surface each point on it belongs to.
 */
import { LAYOUT } from "../../config/buildings";
import { IMPACT } from "../../config/impacts";
import { HEAVY } from "../../config/debris";
import type { Vec3 } from "../math/vec";
import { faceTangent } from "../damage/layout";
import type { Building, SurfaceKind } from "../damage/types";

/** Plane ids: 0–3 the wall faces (Spec 03 face numbers), 4 the ground, 5 back slope (+z), 6 front slope (−z). */
export type PlaneId = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface Surface {
  kind: SurfaceKind | "opening";
  index: number;
  /** Face 0–3, or 4 for the roof. */
  face: number;
}

export interface EnvelopeHit {
  /** Fraction of the step at the crossing (0–1). */
  t: number;
  /** True: entering from outside; false: leaving from inside. */
  entering: boolean;
  plane: PlaneId;
  /** Crossing point (world) and the plane's outward unit normal (world). */
  point: Vec3;
  normal: Vec3;
  /** Crossing point in the house's local frame. */
  local: Vec3;
  surface: Surface;
}

interface Plane {
  n: Vec3;
  d: number;
}

/** Eave height (m above ground): slab top plus wall height. */
export const eaveY = (b: Pick<Building, "wallHeight">) => IMPACT.slabTop + b.wallHeight;

/** The solid's planes in local axes: inside where n·p ≤ d. */
export function envelopePlanes(b: Pick<Building, "width" | "depth" | "wallHeight" | "roofRise">): Plane[] {
  const ye = eaveY(b);
  const k = b.roofRise / (b.depth / 2);
  const m = Math.hypot(1, k);
  return [
    { n: { x: 1, y: 0, z: 0 }, d: b.width / 2 },
    { n: { x: 0, y: 0, z: 1 }, d: b.depth / 2 },
    { n: { x: -1, y: 0, z: 0 }, d: b.width / 2 },
    { n: { x: 0, y: 0, z: -1 }, d: b.depth / 2 },
    { n: { x: 0, y: -1, z: 0 }, d: 0 },
    // y + k·z ≤ ye + rise, normalized.
    { n: { x: 0, y: 1 / m, z: k / m }, d: (ye + b.roofRise) / m },
    { n: { x: 0, y: 1 / m, z: -k / m }, d: (ye + b.roofRise) / m },
  ];
}

const planeCache = new WeakMap<Building, Plane[]>();
export function planesOf(b: Building): Plane[] {
  let p = planeCache.get(b);
  if (!p) {
    p = envelopePlanes(b);
    planeCache.set(b, p);
  }
  return p;
}

/** World → house local (applies the shift and inverse yaw). */
export function toLocal(b: Building, p: Vec3): Vec3 {
  const dx = p.x - (b.x + (b.shift?.x ?? 0));
  const dz = p.z - (b.z + (b.shift?.z ?? 0));
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  return { x: dx * c - dz * s, y: p.y, z: dx * s + dz * c };
}

/** House-local direction → world. */
export function dirToWorld(b: Building, v: Vec3): Vec3 {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c };
}

/** Local point → world. */
export function pointToWorld(b: Building, l: Vec3): Vec3 {
  const w = dirToWorld(b, l);
  return { x: w.x + b.x + (b.shift?.x ?? 0), y: l.y, z: w.z + b.z + (b.shift?.z ?? 0) };
}

/** Houses near a point, for hit tests (the town's spatial grid). */
export interface ImpactTargets {
  near(x: number, z: number): readonly Building[];
}

/** Whether the house still has an envelope to hit (component model, not swept). */
export function hasEnvelope(b: Building): boolean {
  return !b.detail && !b.sweep.failed;
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** True if a local point is inside (or on) the solid, within `eps`. */
export function insideLocal(b: Building, l: Vec3, eps = 1e-9, skip = -1): boolean {
  const planes = planesOf(b);
  for (let i = 0; i < planes.length; i++) {
    if (i === skip) continue;
    if (dot(planes[i]!.n, l) > planes[i]!.d + eps) return false;
  }
  return true;
}

/** Half a body's extent along a world unit direction (m): makes the hit test see its size. */
export type Extent = (n: Vec3) => number;

interface Clip {
  t: number;
  entering: boolean;
  plane: number;
  /** Center at the crossing and its projection onto the real plane (the contact point), local. */
  center: Vec3;
  contact: Vec3;
}

/**
 * Clip a moving body (center a → a + dir, local) against a convex solid of planes, accounting
 * for the body's size (Spec 10 v0.2): from outside, the solid grown by the body's half-extent
 * along each plane normal; from inside (center in the real solid), shrunk by it. A body already
 * overlapping at the start is a crossing at t = 0 on its least-penetrated plane.
 */
function clipConvex(planes: readonly Plane[], a: Vec3, dir: Vec3, off: readonly number[]): Clip | null {
  let inside = true;
  for (const { n, d } of planes) if (dot(n, a) > d) inside = false;
  const sign = inside ? -1 : 1;
  let tIn = 0;
  let tOut = 1;
  let pin = -1;
  let pout = -1;
  let overlapPlane = -1;
  let overlapDepth = Infinity;
  let allIn = true;
  for (let i = 0; i < planes.length; i++) {
    const { n } = planes[i]!;
    const d = planes[i]!.d + sign * off[i]!;
    const num = d - dot(n, a);
    if (num < 0) allIn = false;
    if (inside ? num < overlapDepth : num < overlapDepth) {
      overlapDepth = num;
      overlapPlane = i;
    }
    const den = dot(n, dir);
    if (Math.abs(den) < 1e-12) {
      if (num < 0 && !inside) return null; // parallel and outside this plane
      continue;
    }
    const t = num / den;
    if (den < 0) {
      if (t > tIn) {
        tIn = t;
        pin = i;
      }
    } else if (t < tOut) {
      tOut = t;
      pout = i;
    }
  }
  let t: number;
  let plane: number;
  if (inside) {
    if (!allIn) {
      // Already touching a surface from inside.
      t = 0;
      plane = overlapPlane;
    } else {
      if (pout < 0 || tOut >= 1) return null; // stays inside
      t = tOut;
      plane = pout;
    }
  } else if (allIn) {
    // Overlapping already (it turned into the surface, or started that way): the face its
    // center is outside of (the farthest outside, at a corner).
    t = 0;
    let best = -Infinity;
    plane = overlapPlane;
    for (let i = 0; i < planes.length; i++) {
      const out = dot(planes[i]!.n, a) - planes[i]!.d;
      if (out > best) {
        best = out;
        plane = i;
      }
    }
  } else {
    if (tIn > tOut || pin < 0 || tIn > 1) return null;
    t = tIn;
    plane = pin;
  }
  const center = { x: a.x + dir.x * t, y: a.y + dir.y * t, z: a.z + dir.z * t };
  const { n, d } = planes[plane]!;
  const k = dot(n, center) - d;
  return { t, entering: !inside, plane, center, contact: { x: center.x - n.x * k, y: center.y - n.y * k, z: center.z - n.z * k } };
}

/**
 * Clip a step from `from` to `to` (world) against the envelope. Returns the first crossing of
 * the solid's boundary along the step, or null: entering if the step starts outside, leaving
 * if it starts inside. With `ext`, the moving body's size counts (it touches when its box
 * reaches the surface).
 */
export function clipEnvelope(b: Building, from: Vec3, to: Vec3, ext?: Extent): EnvelopeHit | null {
  const a = toLocal(b, from);
  const e = toLocal(b, to);
  const dir = { x: e.x - a.x, y: e.y - a.y, z: e.z - a.z };
  const planes = planesOf(b);
  const hit = (c: Clip | null): EnvelopeHit | null =>
    !c || c.plane === 4 // the ground is the ground's business
      ? null
      : {
          t: c.t,
          entering: c.entering,
          plane: c.plane as PlaneId,
          point: pointToWorld(b, c.contact),
          normal: dirToWorld(b, planes[c.plane]!.n),
          local: c.contact,
          surface: surfaceAt(b, c.plane as PlaneId, c.contact),
        };
  const center = hit(clipConvex(planes, a, dir, ZERO_OFF));
  if (!ext) return throughAndOut(b, a, dir, planes, center) ?? center;
  // The box touching a surface, and the center itself crossing one (a long piece moving along a
  // wall can touch it beside an opening yet cross standing wall): the first that isn't an opening.
  const box = hit(clipConvex(planes, a, dir, planes.map((p, i) => (i !== 4 ? ext(dirToWorld(b, p.n)) : 0))));
  // Only surfaces it is moving into (from outside: against the outward normal; from inside:
  // along it). A long piece can overlap one wall while moving away from it toward another.
  const into = (h: EnvelopeHit) => {
    const n = planes[h.plane]!.n;
    const d = n.x * dir.x + n.y * dir.y + n.z * dir.z;
    return h.entering ? d < 0 : d > 0;
  };
  const solid = [box, center].filter((h): h is EnvelopeHit => !!h && h.surface.kind !== "opening" && into(h));
  if (solid.length) return solid.reduce((x, y) => (y.t < x.t ? y : x));
  return throughAndOut(b, a, dir, planes, center) ?? box ?? center;
}

/**
 * A step that enters through an opening can leave through a standing surface before it ends
 * (a fast piece cutting a corner: in through a fallen end wall, out through the front wall
 * beside it). A straight step crosses a convex solid at most twice, so after the center passes
 * in through an opening, clip the rest of the step from inside (Spec 10 v0.13).
 */
function throughAndOut(b: Building, a: Vec3, dir: Vec3, planes: readonly Plane[], center: EnvelopeHit | null): EnvelopeHit | null {
  if (!center || !center.entering || center.surface.kind !== "opening") return null;
  const t0 = center.t + 1e-6;
  if (t0 >= 1) return null;
  const start = { x: a.x + dir.x * t0, y: a.y + dir.y * t0, z: a.z + dir.z * t0 };
  const rest = { x: dir.x * (1 - t0), y: dir.y * (1 - t0), z: dir.z * (1 - t0) };
  const c = clipConvex(planes, start, rest, ZERO_OFF);
  if (!c || c.entering || c.plane === 4) return null;
  const surface = surfaceAt(b, c.plane as PlaneId, c.contact);
  if (surface.kind === "opening") return null;
  return {
    t: t0 + (1 - t0) * c.t,
    entering: false,
    plane: c.plane as PlaneId,
    point: pointToWorld(b, c.contact),
    normal: dirToWorld(b, planes[c.plane]!.n),
    local: c.contact,
    surface,
  };
}

const ZERO_OFF = [0, 0, 0, 0, 0, 0, 0];

/** Half-size of a house's slab footprint (m), as drawn: wider than the walls for component houses. */
export function slabHalf(b: Building): { x: number; z: number } {
  const m = b.detail || b.standInFor !== undefined ? IMPACT.detailSlabMargin : IMPACT.slabMargin;
  return { x: b.width / 2 + m, z: b.depth / 2 + m };
}

/** World → slab local (the slab never shifts). */
function toSlabLocal(b: Building, p: Vec3): Vec3 {
  const dx = p.x - b.x;
  const dz = p.z - b.z;
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  return { x: dx * c - dz * s, y: p.y, z: dx * s + dz * c };
}

/** Is a world point over the house's slab? */
/** Lying on a slab (Spec 04 v2.3): over its footprint and less than HEAVY.sweptHeight above its
 *  top. A swept slab carries off what lies on it. */
export function lyingOnSlab(b: Building, p: Vec3): boolean {
  return p.y < IMPACT.slabTop + HEAVY.sweptHeight && overSlab(b, p);
}

export function overSlab(b: Building, p: Vec3): boolean {
  const l = toSlabLocal(b, p);
  const h = slabHalf(b);
  return Math.abs(l.x) <= h.x && Math.abs(l.z) <= h.z;
}

export interface SlabHit {
  entering: boolean;
  /** The slab's top (true) or a side. */
  top: boolean;
  point: Vec3;
  normal: Vec3;
}

/**
 * A body's step against a house's slab (a 0.3 m concrete box every house keeps, swept or not):
 * hitting a side stops it like a curb; the top is ground to land on (Spec 10 v0.2).
 */
export function clipSlab(b: Building, from: Vec3, to: Vec3, ext?: Extent): SlabHit | null {
  const h = slabHalf(b);
  const planes: Plane[] = [
    { n: { x: 1, y: 0, z: 0 }, d: h.x },
    { n: { x: 0, y: 0, z: 1 }, d: h.z },
    { n: { x: -1, y: 0, z: 0 }, d: h.x },
    { n: { x: 0, y: 0, z: -1 }, d: h.z },
    { n: { x: 0, y: 1, z: 0 }, d: IMPACT.slabTop },
  ];
  const a = toSlabLocal(b, from);
  const e = toSlabLocal(b, to);
  const dir = { x: e.x - a.x, y: e.y - a.y, z: e.z - a.z };
  const off = planes.map((p) => (ext ? ext(dirToWorld(b, p.n)) : 0));
  // The ground is the slab's bottom: nothing passes under it.
  const c = clipConvex(planes, a, dir, off);
  if (!c || !c.entering) return null;
  const n = planes[c.plane]!.n;
  return {
    entering: true,
    top: c.plane === 4,
    point: { ...dirToWorld(b, c.contact), x: dirToWorld(b, c.contact).x + b.x, z: dirToWorld(b, c.contact).z + b.z, y: c.contact.y },
    normal: dirToWorld(b, n),
  };
}

/** The panel on face `face` at position u along it (the nearest one at a corner), or −1. */
function panelAt(b: Building, face: number, u: number): number {
  let best = -1;
  let gap = Infinity;
  for (let i = 0; i < b.panels.length; i++) {
    const p = b.panels[i]!;
    if (p.face !== face) continue;
    const g = Math.abs(u - p.u) - p.len / 2;
    if (g <= 1e-9) return i;
    if (g < gap) {
      gap = g;
      best = i;
    }
  }
  return gap < 0.5 ? best : -1;
}

/** The surface (component) at a local point on plane `plane` (Spec 10 table). */
export function surfaceAt(b: Building, plane: PlaneId, l: Vec3): Surface {
  const open = (face: number): Surface => ({ kind: "opening", index: -1, face });
  if (plane === 4) return open(-1);
  if (plane <= 3) {
    const face = plane;
    const t = faceTangent(face);
    const u = t.x * l.x + t.z * l.z;
    const pi = panelAt(b, face, u);
    if (pi < 0) return open(face);
    const panel = b.panels[pi]!;
    if (panel.failed) return open(face);
    const h = l.y - IMPACT.slabTop;
    if (l.y > eaveY(b)) {
      // Gable: sits on its end wall and goes with the end bay (as drawn).
      const col = face === 0 ? b.nx - 1 : 0;
      if (b.bays[col]!.failed || b.panels.some((p) => p.face === face && p.failed)) return open(face);
      return { kind: "gable", index: pi, face };
    }
    if (panel.isGarage && b.garage) {
      const gw = Math.min(LAYOUT.garageWidth, panel.len * 0.9);
      if (Math.abs(u - panel.u) <= gw / 2 && h <= LAYOUT.garageHeight) {
        return b.garage.failed ? open(face) : { kind: "garage", index: pi, face };
      }
    }
    if (panel.hasWindow && Math.abs(u - panel.u) <= LAYOUT.paneSize / 2 && h >= LAYOUT.paneSill && h <= LAYOUT.paneSill + LAYOUT.paneSize) {
      const k = b.panes.findIndex((p) => p.panel === pi);
      if (k >= 0) return b.panes[k]!.failed ? open(face) : { kind: "pane", index: k, face };
    }
    return { kind: "wall", index: pi, face };
  }
  // Roof planes: 5 = back slope (+z), 6 = front slope (−z).
  const slope = plane === 5 ? 1 : -1;
  const oh = LAYOUT.overhang;
  const colW = (b.width + 2 * oh) / b.nx;
  const col = Math.min(b.nx - 1, Math.max(0, Math.floor((l.x + b.width / 2 + oh) / colW)));
  const halfRun = b.depth / 2 + oh;
  const row = Math.abs(l.z) > halfRun / 2 ? 0 : 1;
  const si = b.sections.findIndex((s) => s.col === col && s.slope === slope && s.row === row);
  const s = b.sections[si]!;
  if (b.bays[col]!.failed || s.deck) return open(4);
  return { kind: "roof", index: si, face: 4 };
}
