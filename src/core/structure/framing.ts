/**
 * Member-level framing of a one-story gable house (Spec 09): members with real sizes and
 * masses, connected by a load-path DAG down to the slab.
 */
import { LAYOUT } from "../../config/buildings";
import { CEILING_AREAL, CEILING_DRYWALL_AREAL, CONNECTION, DOOR, DETAIL_FRAGILITY, DRYWALL_COLOR, DRYWALL_THICKNESS, SIDING, TRIM, FLOOR_PLAN, GARAGE_DOOR_AREAL, GLASS, LUMBER, OSB_COLOR, PARTITION_AREAL, SHEET, SLAB_TOP, STRUCT_CLASS } from "../../config/structure";
import { faceTangent, LOCAL_NORMALS, panelCenter } from "../damage/layout";
import type { Building } from "../damage/types";
import type { Vec3 } from "../math/vec";

export type Q = [number, number, number, number];
export type MemberKind =
  | "wallFrame"
  | "wallSheet"
  | "pane"
  | "garageDoor"
  | "gableFrame"
  | "rafterPair"
  | "roofSheet"
  | "roofShingle"
  | "ceiling"
  | "fascia"
  | "partition"
  | "door"
  | "drywall"
  | "trim"
  | "siding"
  | "sillPlate";

/**
 * A box within a member, in the member's local frame. Size is full extents (x, y, z).
 * With `tri`, it's instead a right-triangle prism: the right angle at `pos`, legs size[0]
 * along local +x (−x when `tri.mirror`) and size[1] along +y, thickness size[2] along z.
 */
export interface Shape {
  size: [number, number, number];
  pos: Vec3;
  q: Q;
  tri?: { mirror: boolean };
}

/** Corner points of a shape in its member's local frame (8 for a box, 6 for a prism). */
export function shapePoints(s: Shape): Vec3[] {
  const [a, b, c] = s.size;
  const local: Vec3[] = [];
  if (s.tri) {
    const sx = s.tri.mirror ? -a : a;
    for (const z of [-c / 2, c / 2]) local.push({ x: 0, y: 0, z }, { x: sx, y: 0, z }, { x: 0, y: b, z });
  } else {
    for (const x of [-a / 2, a / 2]) for (const y of [-b / 2, b / 2]) for (const z of [-c / 2, c / 2]) local.push({ x, y, z });
  }
  return local.map((p) => {
    const r = qrot(s.q, p);
    return { x: s.pos.x + r.x, y: s.pos.y + r.y, z: s.pos.z + r.z };
  });
}

/** Volume of a shape (m³). */
export const shapeVolume = (s: Shape) => (s.tri ? 0.5 : 1) * s.size[0] * s.size[1] * s.size[2];

export interface Member {
  id: number;
  kind: MemberKind;
  /** House-local pose of the member's origin (y up from the ground). */
  pos: Vec3;
  q: Q;
  /** Boxes drawn for this member. */
  shapes: Shape[];
  /** Boxes used for collisions (simpler than `shapes` where detail doesn't matter). */
  collision: Shape[];
  mass: number;
  /** Wind-exposed area (m²) and its outward unit normal in house-local axes (0 if sheltered). */
  area: number;
  normal: Vec3;
  /** Wall face (0–3) for wall members, −1 otherwise. */
  face: number;
  /** Roof members: corner zone (edge) or field. */
  edge: boolean;
  /** Load-path level: supports always have a lower level (slab = 0). */
  level: number;
  color: number;
  /** Plate area (m²) for aerodynamics once loose, for members sheltered while attached
   *  (area 0): interior drywall, ceiling. */
  plate?: number;
  /** Exterior-wall members: the component-model wall panel they belong to. */
  panel?: number;
  /** Interior walls and their doors: index into the floor plan's walls. */
  wall?: number;
  /** Glass shards: which window pane they belong to (a pane breaks as a whole). */
  pane?: number;
}

export interface Connection {
  id: number;
  from: number;
  /** Cladding connections (shingles, sheathing, glazing, doors) are checked with local
   *  component pressures; structural ones (rafters, gables, anchors) with area-averaged
   *  pressures, as in building codes. */
  cladding?: boolean;
  /** Supporting member id, or −1 for the slab. */
  to: number;
  capacity: number;
  /** Unit axis from the support toward the member (house-local); compression along it is free. */
  axis: Vec3;
  label: string;
}

export interface Framing {
  members: Member[];
  connections: Connection[];
  /** Connection ids where the member is `from` (its supports). */
  supportsOf: number[][];
  /** Connection ids where the member is `to` (what it carries). */
  carriesOf: number[][];
  /** Smallest capacity factor any connection got from the variability (1 = none weaker). */
  weakest: number;
}

/** Small deterministic PRNG (mulberry32) for per-house variability. */
function hashRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ident: Q = [0, 0, 0, 1];
const zero: Vec3 = { x: 0, y: 0, z: 0 };

/** Axis-aligned rectangle in a wall's own plane (x along the wall, y up). */
export interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Groups rectangles into connected pieces (rectangles sharing part of an edge). */
export function connectedPieces(rects: Rect[]): Rect[][] {
  const parent = rects.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const e = 1e-9;
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      const touchX = (Math.abs(a.x1 - b.x0) < e || Math.abs(b.x1 - a.x0) < e) && oy > e;
      const touchY = (Math.abs(a.y1 - b.y0) < e || Math.abs(b.y1 - a.y0) < e) && ox > e;
      if (touchX || touchY) parent[find(i)] = find(j);
    }
  const groups = new Map<number, Rect[]>();
  rects.forEach((r, i) => {
    const k = find(i);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  });
  return [...groups.values()];
}

/** A rectangle minus holes, as non-overlapping rectangles (pieces thinner than `min` dropped). */
export function subtractRects(r: Rect, holes: Rect[], min = 1e-3): Rect[] {
  let out = [r];
  for (const h of holes) {
    const next: Rect[] = [];
    for (const a of out) {
      if (h.x1 <= a.x0 || h.x0 >= a.x1 || h.y1 <= a.y0 || h.y0 >= a.y1) {
        next.push(a);
        continue;
      }
      const ix0 = Math.max(a.x0, h.x0);
      const ix1 = Math.min(a.x1, h.x1);
      next.push(
        { x0: a.x0, x1: ix0, y0: a.y0, y1: a.y1 },
        { x0: ix1, x1: a.x1, y0: a.y0, y1: a.y1 },
        { x0: ix0, x1: ix1, y0: a.y0, y1: Math.max(a.y0, h.y0) },
        { x0: ix0, x1: ix1, y0: Math.min(a.y1, h.y1), y1: a.y1 },
      );
    }
    out = next.filter((q) => q.x1 - q.x0 > min && q.y1 - q.y0 > min);
  }
  return out;
}
const yawQ = (a: number): Q => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const pitchQ = (a: number): Q => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
export function qmul(a: Q, b: Q): Q {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
export const qconj = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];

/** Rotate vector v by unit quaternion q. */
export function qrot(q: Q, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return { x: v.x + w * tx + (y * tz - z * ty), y: v.y + w * ty + (z * tx - x * tz), z: v.z + w * tz + (x * ty - y * tx) };
}

const boxMass = (s: [number, number, number], density: number) => s[0] * s[1] * s[2] * density;

export function buildFraming(b: Building, opts: { scatter?: boolean } = {}): Framing {
  const members: Member[] = [];
  const connections: Connection[] = [];
  const cls = STRUCT_CLASS[b.cls];
  const H = b.wallHeight;
  const up: Vec3 = { x: 0, y: 1, z: 0 };
  const add = (m: Omit<Member, "id" | "collision"> & { collision?: Shape[] }) => {
    members.push({ ...m, collision: m.collision ?? m.shapes, id: members.length });
    return members.length - 1;
  };
  const CLADDING = new Set<MemberKind>(["wallSheet", "siding", "pane", "garageDoor", "roofSheet", "roofShingle"]);
  // Exterior doors are cladding; interior doors aren't part of the envelope.
  const isCladding = (m: Member) => CLADDING.has(m.kind) || (m.kind === "door" && m.face >= 0);
  const connect = (from: number, to: number, capacity: number, axis: Vec3, label: string) =>
    connections.push({ id: connections.length, from, to, capacity, axis, label, cladding: isCladding(members[from]!) });
  let paneCount = 0;

  // --- Walls: one frame member per Phase 4 panel, with rough openings (windows, doors, the
  // garage door) framed by jack studs and headers; sheathing is cut around the openings.
  const frameOf: number[] = [];
  const nx = Math.max(2, Math.round(b.width / LAYOUT.panelTarget));
  // Front door just right of the garage panel; back door behind it, into the kitchen.
  const doorX = -b.width / 2 + 1.5 * (b.width / nx);
  const pick = (face: number) => {
    let best = -1;
    let bestD = Infinity;
    b.panels.forEach((p, i) => {
      if (p.face !== face || p.isGarage) return;
      const d = Math.abs(panelCenter(b, p, 0).x - doorX);
      if (d < bestD) [best, bestD] = [i, d];
    });
    return best;
  };
  const frontDoor = pick(3);
  const backDoor = pick(1);
  const ED = DOOR.exterior;
  b.panels.forEach((p, pi) => {
    // Every member built here belongs to this wall panel (component-model hand-off).
    const addP = (m: Parameters<typeof add>[0]) : number => add({ ...m, panel: pi });
    const t = faceTangent(p.face);
    const n = LOCAL_NORMALS[p.face]!;
    const nn: Vec3 = { x: n.x, y: 0, z: n.z };
    const yaw = Math.atan2(-t.z, t.x);
    const c = panelCenter(b, p, SLAB_TOP + H / 2);
    const q = yawQ(yaw);
    const [tw, td] = LUMBER.stud;
    const at = (x: number, y: number, z: number): Vec3 => ({ x: c.x + n.x * z + t.x * x, y: c.y + y, z: c.z + n.z * z + t.z * x });

    // Openings in frame-local coordinates (y from the panel's mid-height).
    const hasDoor = pi === frontDoor || pi === backDoor;
    const openings: (Rect & { kind: "window" | "door" | "garage" })[] = [];
    if (p.isGarage) {
      const w = Math.min(LAYOUT.garageWidth, p.len * 0.9);
      openings.push({ x0: -w / 2, x1: w / 2, y0: -H / 2, y1: -H / 2 + LAYOUT.garageHeight, kind: "garage" });
    }
    if (hasDoor) {
      const dx = p.hasWindow ? p.len / 4 : 0;
      const w = ED.width + 2 * DOOR.roughGap;
      openings.push({ x0: dx - w / 2, x1: dx + w / 2, y0: -H / 2, y1: -H / 2 + ED.height + DOOR.roughGap, kind: "door" });
    }
    if (p.hasWindow) {
      const ps = LAYOUT.paneSize;
      const wx = hasDoor ? -p.len / 4 : 0;
      const y0 = LAYOUT.paneSill - H / 2;
      openings.push({ x0: wx - ps / 2, x1: wx + ps / 2, y0, y1: y0 + ps, kind: "window" });
    }

    // Corners: long (eave) walls run through to the outside corner; end walls butt between
    // them. So corner frames of long walls extend half a stud depth, end walls' shrink by it.
    const faceLen = p.face % 2 === 0 ? b.depth : b.width;
    const atStart = p.u - p.len / 2 <= -faceLen / 2 + 1e-6;
    const atEnd = p.u + p.len / 2 >= faceLen / 2 - 1e-6;
    const long = p.face % 2 === 1;
    const frameExt = long ? td / 2 : -td / 2;
    const fx0 = -p.len / 2 - (atStart ? frameExt : 0);
    const fx1 = p.len / 2 + (atEnd ? frameExt : 0);
    // Past the frame: long walls' sheathing also covers the end wall's sheathing edge; end
    // walls' sheathing reaches the long walls' outer face.
    const sideExt = long ? SHEET.thickness : td;
    // Drywall: long walls' to the end wall's frame, end walls' to the long walls' drywall.
    const dryExt = long ? -td / 2 : -(td / 2 + DRYWALL_THICKNESS);

    // Frame: plates, studs at 0.6 m (skipping openings), jack studs, headers, sills, cripples.
    const shapes: Shape[] = [];
    const box = (x0: number, x1: number, y0: number, y1: number) => shapes.push({ size: [x1 - x0, y1 - y0, td], pos: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: 0 }, q: ident });
    const floorCuts = openings.filter((o) => o.kind !== "window").map((o) => ({ x0: o.x0, x1: o.x1, y0: -H, y1: H }));
    // The bottom (sill) plate is its own member, bolted to the slab; the frame sits on it.
    // (Its origin is on the plate itself.)
    const sillShapes: Shape[] = subtractRects({ x0: fx0, x1: fx1, y0: -H / 2, y1: -H / 2 + tw }, floorCuts).map((r) => ({
      size: [r.x1 - r.x0, r.y1 - r.y0, td], pos: { x: (r.x0 + r.x1) / 2, y: 0, z: 0 }, q: ident,
    }));
    box(fx0, fx1, H / 2 - tw, H / 2);
    const yb = -H / 2 + tw;
    const yt = H / 2 - tw;
    const flen = fx1 - fx0;
    const nStuds = Math.max(2, Math.ceil((flen - tw) / LUMBER.studSpacing - 1e-9) + 1);
    for (let i = 0; i < nStuds; i++) {
      const x = fx0 + tw / 2 + (i * (flen - tw)) / (nStuds - 1);
      const o = openings.find((o) => x + tw / 2 > o.x0 - tw && x - tw / 2 < o.x1 + tw);
      if (!o) {
        box(x - tw / 2, x + tw / 2, yb, yt);
        continue;
      }
      if (x < o.x0 || x > o.x1) continue; // replaced by the jack stud
      // Cripple studs above the header and under a window sill.
      const hTop = Math.min(o.y1 + DOOR.headerDepth, yt);
      if (yt - hTop > 0.03) box(x - tw / 2, x + tw / 2, hTop, yt);
      if (o.kind === "window" && o.y0 - tw - yb > 0.03) box(x - tw / 2, x + tw / 2, yb, o.y0 - tw);
    }
    for (const o of openings) {
      const hTop = Math.min(o.y1 + DOOR.headerDepth, yt);
      box(o.x0 - tw, o.x0, o.kind === "window" ? yb : -H / 2, hTop); // jack studs
      box(o.x1, o.x1 + tw, o.kind === "window" ? yb : -H / 2, hTop);
      box(o.x0, o.x1, o.y1, hTop); // header
      if (o.kind === "window") box(o.x0, o.x1, o.y0 - tw, o.y0); // rough sill
    }
    const mass = shapes.reduce((a, s) => a + boxMass(s.size, LUMBER.density), 0);
    // Collide as the solid wall around the openings (studs and plates are drawn individually).
    // (above the sill plate, which collides on its own).
    const collision: Shape[] = subtractRects({ x0: fx0, x1: fx1, y0: -H / 2 + tw, y1: H / 2 }, openings).map((r) => ({
      size: [r.x1 - r.x0, r.y1 - r.y0, td], pos: { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2, z: 0 }, q: ident,
    }));
    const sill = addP({
      kind: "sillPlate", pos: at(0, -H / 2 + tw / 2, 0), q, shapes: sillShapes, mass: sillShapes.reduce((a, s) => a + boxMass(s.size, LUMBER.density), 0),
      area: 0, normal: nn, face: p.face, edge: false, level: 0.5, color: 0xb08d57,
    });
    // IRC R403.1.6: bolts at most 6 ft (1.83 m) apart, one within 12 in (0.3 m) of each end
    // of the plate, at least two per plate.
    const bolts = Math.max(2, Math.ceil((p.len - 2 * CONNECTION.boltEndDistance) / CONNECTION.boltSpacing - 1e-9) + 1);
    connect(sill, -1, bolts * CONNECTION.boltN * cls.anchorage, up, "Sill anchor bolts");
    const frame = addP({ kind: "wallFrame", pos: c, q, shapes, collision, mass, area: 0, normal: nn, face: p.face, edge: false, level: 1, color: 0xc9a36b });
    frameOf.push(frame);
    // Studs end-nailed into the sill plate, and the sheathing nailed along it.
    const onPlate = shapes.filter((s) => s.size[1] > s.size[0] && Math.abs(s.pos.y - s.size[1] / 2 - yb) < 1e-6).length;
    connect(frame, sill, (onPlate * CONNECTION.studToPlateN + p.len * CONNECTION.sheathingToSillNPerM) * cls.anchorage, up, "Wall to sill plate");

    // Sheets ≤ 1.2 × 2.4 m over [x0, x1], cut around openings the way builders do: a sheet
    // that meets an opening is notched around it (L or U shape), so seams never fall at the
    // opening's edge. Each connected cut piece is one member; isolated strips under 3 cm
    // aren't hung (the casing covers them).
    const zOut = td / 2 + SHEET.thickness / 2;
    const sheets = (x0: number, x1: number, thick: number, hang: (shapes: Shape[], center: { x: number; y: number }, area: number) => void) => {
      const cols = Math.ceil((x1 - x0) / SHEET.maxShort - 1e-9);
      const rows = Math.ceil(H / SHEET.maxLong - 1e-9);
      const sw = (x1 - x0) / cols;
      for (let ci = 0; ci < cols; ci++) {
        let y0 = -H / 2;
        for (let ri = 0; ri < rows; ri++) {
          const sh = Math.min(SHEET.maxLong, H / 2 - y0);
          const cell = { x0: x0 + ci * sw, x1: x0 + (ci + 1) * sw, y0, y1: y0 + sh };
          for (const piece of connectedPieces(subtractRects(cell, openings))) {
            const area = piece.reduce((a, r) => a + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
            const bx0 = Math.min(...piece.map((r) => r.x0));
            const bx1 = Math.max(...piece.map((r) => r.x1));
            const by0 = Math.min(...piece.map((r) => r.y0));
            const by1 = Math.max(...piece.map((r) => r.y1));
            if (Math.min(bx1 - bx0, by1 - by0) < SHEET.minPiece) continue;
            const center = { x: (bx0 + bx1) / 2, y: (by0 + by1) / 2 };
            const shapes: Shape[] = piece.map((r) => ({
              size: [r.x1 - r.x0, r.y1 - r.y0, thick], pos: { x: (r.x0 + r.x1) / 2 - center.x, y: (r.y0 + r.y1) / 2 - center.y, z: 0 }, q: ident,
            }));
            hang(shapes, center, area);
          }
          y0 += sh;
        }
      }
    };
    // Outside: OSB sheathing, and vinyl siding over it. Long walls' sheathing runs past the
    // corner to cover the end wall's sheathing edge.
    sheets(fx0 - (atStart ? sideExt : 0), fx1 + (atEnd ? sideExt : 0), SHEET.thickness, (shapes, ctr, area) => {
      const sheet = addP({
        kind: "wallSheet", pos: at(ctr.x, ctr.y, zOut), q, shapes,
        mass: SHEET.density * SHEET.thickness * area, area, normal: nn, face: p.face, edge: false, level: 2, color: OSB_COLOR,
      });
      connect(sheet, frame, CONNECTION.wallSheetPa * cls.sheet * area, nn, "Wall sheathing nails");
      const vinyl = addP({
        kind: "siding", pos: at(ctr.x, ctr.y, zOut + SHEET.thickness / 2 + SIDING.thickness / 2), q,
        shapes: shapes.map((s) => ({ ...s, size: [s.size[0], s.size[1], SIDING.thickness] as [number, number, number] })),
        mass: SIDING.areal * area, area, normal: nn, face: p.face, edge: false, level: 3, color: b.wallColor,
      });
      connect(vinyl, sheet, SIDING.pa * area, nn, "Siding nails");
    });
    // Inside: drywall. Sheltered while the wall stands; pushed outward it bears on the studs,
    // pulled inward only the screws hold. End walls' drywall butts against the long walls'.
    sheets(-p.len / 2 - (atStart ? dryExt : 0), p.len / 2 + (atEnd ? dryExt : 0), DRYWALL_THICKNESS, (shapes, ctr, area) => {
      const dry = addP({
        kind: "drywall", pos: at(ctr.x, ctr.y, -(td / 2 + DRYWALL_THICKNESS / 2)), q, shapes,
        mass: CEILING_DRYWALL_AREAL * area, area: 0, plate: area, normal: nn, face: -1, edge: false, level: 2, color: DRYWALL_COLOR,
      });
      connect(dry, frame, CONNECTION.ceilingScrewPa * area, { x: -n.x, y: 0, z: -n.z }, "Drywall screws");
    });

    // Casing: 1×4 trim boards around each opening on top of the sheathing (sill at windows).
    for (const o of openings) {
      const tw2 = TRIM.width;
      const tz = zOut + SHEET.thickness / 2 + SIDING.thickness + TRIM.thickness / 2;
      const tshapes: Shape[] = [];
      const board = (x0: number, x1: number, y0: number, y1: number) =>
        tshapes.push({ size: [x1 - x0, y1 - y0, TRIM.thickness], pos: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: 0 }, q: ident });
      const yBot = o.kind === "window" ? o.y0 - tw2 : o.y0;
      board(o.x0 - tw2, o.x0, yBot, o.y1);
      board(o.x1, o.x1 + tw2, yBot, o.y1);
      board(o.x0 - tw2, o.x1 + tw2, o.y1, Math.min(o.y1 + tw2, H / 2));
      if (o.kind === "window") board(o.x0, o.x1, o.y0 - tw2, o.y0);
      const ox = (o.x0 + o.x1) / 2;
      const oy = (o.y0 + o.y1) / 2;
      for (const t of tshapes) t.pos = { x: t.pos.x - ox, y: t.pos.y - oy, z: 0 };
      const trim = addP({
        kind: "trim", pos: at(ox, oy, tz), q, shapes: tshapes,
        mass: tshapes.reduce((a, t) => a + boxMass(t.size, LUMBER.density), 0), area: 0, normal: nn, face: -1, edge: false, level: 2, color: TRIM.color,
      });
      connect(trim, frame, TRIM.nailN, nn, "Trim nails");
    }

    for (const o of openings) {
      const ox = (o.x0 + o.x1) / 2;
      if (o.kind === "window") {
        // The glass sits in the opening. It bends and breaks either way, so no bearing side
        // (zero axis); once broken the whole pane falls apart into shards (see the lab).
        const g = GLASS.shardGrid;
        const cell = LAYOUT.paneSize / g;
        const paneId = paneCount++;
        for (let i = 0; i < g; i++)
          for (let j = 0; j < g; j++)
            for (const half of [0, 1]) {
              const cx = o.x0 + (i + 0.5) * cell;
              const cy = o.y0 + (j + 0.5) * cell;
              const area = (cell * cell) / 2;
              const shard = addP({
                kind: "pane", pos: at(cx, cy, 0), q,
                shapes: [{ size: [cell, cell, GLASS.thickness], pos: { x: half ? cell / 2 : -cell / 2, y: half ? cell / 2 : -cell / 2, z: 0 }, q: half ? [0, 0, 1, 0] : ident, tri: { mirror: false } }],
                mass: GLASS.density * GLASS.thickness * area, area, normal: nn, face: p.face, edge: false, level: 3, color: 0x6f8fa6, pane: paneId,
              });
              connect(shard, frame, CONNECTION.glazingPa * cls.glazing * area, zero, "Window glazing");
            }
      } else if (o.kind === "door") {
        // Inswing door: pushed outward it bears on the stop; inward only the latch and hinges hold.
        const size: [number, number, number] = [ED.width, ED.height, ED.thickness];
        const area = ED.width * ED.height;
        const door = addP({
          kind: "door", pos: at(ox, -H / 2 + ED.height / 2, 0), q, shapes: [{ size, pos: { x: 0, y: 0, z: 0 }, q: ident }],
          mass: ED.areal * area, area, normal: nn, face: p.face, edge: false, level: 2, color: pi === frontDoor ? 0x7a2e2a : 0xe6e2da,
        });
        connect(door, frame, CONNECTION.extDoorPa * cls.glazing * area, { x: -n.x, y: 0, z: -n.z }, "Door latch & hinges");
      } else {
        const w = o.x1 - o.x0;
        const size: [number, number, number] = [w, LAYOUT.garageHeight, 0.04];
        const door = addP({
          kind: "garageDoor", pos: at(ox, -H / 2 + LAYOUT.garageHeight / 2, 0), q, shapes: [{ size, pos: { x: 0, y: 0, z: 0 }, q: ident }],
          mass: GARAGE_DOOR_AREAL * w * LAYOUT.garageHeight, area: w * LAYOUT.garageHeight, normal: nn, face: p.face, edge: false, level: 2, color: 0xe6e2da,
        });
        // Rollers in the tracks hold it both ways; it fails by buckling inward or pulling out.
        connect(door, frame, CONNECTION.garageDoorPa * w * LAYOUT.garageHeight, zero, "Garage door track");
      }
    }
  });

  // --- Roof: rafter pairs at 0.6 m bearing on front and back wall frames; sheathing sheets.
  const oh = LAYOUT.overhang;
  const halfRun = b.depth / 2 + oh;
  const pitch = Math.atan2(b.roofRise, b.depth / 2);
  const slopeLen = halfRun / Math.cos(pitch);
  const [rw, rd] = LUMBER.rafter;
  // Rafters sit on top of the wall's top plate, so the roof surface starts a rafter depth
  // (the heel) above the wall, not at it.
  const heel = rd;
  const eaveY = SLAB_TOP + H + heel - oh * Math.tan(pitch);
  const ridgeY = SLAB_TOP + H + heel + b.roofRise;
  const frameAt = (face: number, x: number) => {
    let best = -1;
    let bd = Infinity;
    b.panels.forEach((p, i) => {
      if (p.face !== face) return;
      const c = panelCenter(b, p, 0);
      const d = Math.abs(c.x - x);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return frameOf[best]!;
  };
  const rafterXs: number[] = [];
  for (let x = -b.width / 2 + rw / 2; x <= b.width / 2 - rw / 2 + 1e-9; x += LUMBER.spacing) rafterXs.push(x);
  const rafterOf: number[] = [];
  for (const x of rafterXs) {
    // Rafters stop just behind the fascia (real tails are plumb-cut; a square-cut box would
    // poke its lower corner out past the fascia).
    const tailTrim = 0.15;
    const len = slopeLen - tailTrim;
    const shapes: Shape[] = [-1, 1].map((s) => {
      const along = len / 2; // center distance from the ridge, along the slope
      return {
        size: [rw, rd, len] as [number, number, number],
        pos: { x: 0, y: -along * Math.sin(pitch) - rd / 2, z: s * along * Math.cos(pitch) },
        q: pitchQ(s * pitch),
      };
    });
    // Ceiling joist: ties the pair across the house at the wall tops, like a truss bottom chord.
    shapes.push({ size: [rw, rd, b.depth], pos: { x: 0, y: SLAB_TOP + H + rd / 2 - ridgeY, z: 0 }, q: ident });
    // Plus the ceiling drywall and insulation hung from that joist's strip of ceiling.
    const mass = shapes.reduce((a, s) => a + boxMass(s.size, LUMBER.density), 0) + CEILING_AREAL * LUMBER.spacing * b.depth;
    const r = add({ kind: "rafterPair", pos: { x, y: ridgeY, z: 0 }, q: ident, shapes, mass, area: 0, normal: up, face: -1, edge: false, level: 2, color: 0xc9a36b });
    rafterOf.push(r);
    const cap = b.cls === "strong" ? CONNECTION.strapN : CONNECTION.rafterToWallN * cls.rafter * CONNECTION.roofSystemFactor;
    connect(r, frameAt(3, x), cap, up, b.cls === "strong" ? "Hurricane straps" : "Rafter toe-nails");
    connect(r, frameAt(1, x), cap, up, b.cls === "strong" ? "Hurricane straps" : "Rafter toe-nails");
    // The ceiling joist bears on the same top plates with its own toe-nails.
    connect(r, frameAt(3, x), CONNECTION.joistToWallN * cls.rafter * CONNECTION.roofSystemFactor, up, "Ceiling joist toe-nails");
    connect(r, frameAt(1, x), CONNECTION.joistToWallN * cls.rafter * CONNECTION.roofSystemFactor, up, "Ceiling joist toe-nails");
  }
  const totalW = b.width + 2 * oh;
  const cols = Math.ceil(totalW / SHEET.maxLong - 1e-9);
  const rows = Math.ceil(slopeLen / SHEET.maxShort - 1e-9);
  const sl = totalW / cols;
  const sh = slopeLen / rows;
  for (const s of [-1, 1] as const) {
    const q = pitchQ(s * pitch);
    const n = qrot(q, up);
    for (let ci = 0; ci < cols; ci++) {
      const x = -totalW / 2 + (ci + 0.5) * sl;
      for (let ri = 0; ri < rows; ri++) {
        const along = (ri + 0.5) * sh; // from the ridge down
        const z = s * along * Math.cos(pitch);
        const y = ridgeY - along * Math.sin(pitch) + SHEET.thickness / 2 + rd / 2 * 0;
        const size: [number, number, number] = [sl, SHEET.thickness, sh];
        const area = sl * sh;
        const corner = (ci === 0 || ci === cols - 1) && ri === rows - 1;
        const sheetPos = { x, y: y + 0.01, z };
        const sheet = add({
          kind: "roofSheet", pos: sheetPos, q, shapes: [{ size, pos: { x: 0, y: 0, z: 0 }, q: ident }],
          mass: boxMass(size, SHEET.density), area, normal: n, face: -1,
          edge: corner, level: 3, color: OSB_COLOR,
        });
        const under = rafterOf.filter((_, k) => Math.abs(rafterXs[k]! - x) <= sl / 2 + 1e-9);
        const per = (CONNECTION.roofSheetPa * cls.sheet * area) / Math.max(under.length, 1);
        for (const r of under) connect(sheet, r, per, n, "Roof sheathing nails");
        // Shingles: 2 × 2 patches per sheet, each held by its own nails and sealant strip.
        for (const dx of [-1, 1])
          for (const dz of [-1, 1]) {
            const ss: [number, number, number] = [sl / 2, 0.008, sh / 2];
            const off = qrot(q, { x: (dx * sl) / 4, y: SHEET.thickness / 2 + 0.004, z: (dz * sh) / 4 });
            const shingle = add({
              kind: "roofShingle", pos: { x: sheetPos.x + off.x, y: sheetPos.y + off.y, z: sheetPos.z + off.z }, q,
              shapes: [{ size: ss, pos: { x: 0, y: 0, z: 0 }, q: ident }],
              mass: SHEET.shingleAreal * ss[0] * ss[2], area: ss[0] * ss[2], normal: n, face: -1,
              edge: corner, level: 4, color: b.roofColor,
            });
            connect(shingle, sheet, CONNECTION.shinglePa * cls.sheet * ss[0] * ss[2], n, "Shingle nails & sealant");
          }
      }
    }
  }

  // --- Fascia: one continuous trim board along each eave, nailed to every rafter tail.
  for (const s of [-1, 1]) {
    const len = b.width + 2 * oh;
    const size: [number, number, number] = [len, 0.2, 0.025];
    const fid = add({
      kind: "fascia", pos: { x: 0, y: eaveY - 0.08, z: s * (halfRun + 0.0125) }, q: ident,
      shapes: [{ size, pos: { x: 0, y: 0, z: 0 }, q: ident }],
      mass: boxMass(size, LUMBER.density), area: 0, normal: { x: 0, y: 0, z: s }, face: -1, edge: false, level: 3, color: 0xf2f1ec,
    });
    for (const r of rafterOf) connect(fid, r, 1500, { x: 0, y: 0, z: s }, "Fascia nails");
    // Soffit: closes the underside of the overhang from the wall face to the fascia.
    const wallFace = b.depth / 2 + LUMBER.stud[1] / 2 + SHEET.thickness;
    const depth = halfRun - wallFace;
    const ssize: [number, number, number] = [len, 0.012, depth];
    const sid = add({
      kind: "fascia", pos: { x: 0, y: eaveY - 0.18 + 0.006, z: s * (wallFace + depth / 2) }, q: ident,
      shapes: [{ size: ssize, pos: { x: 0, y: 0, z: 0 }, q: ident }],
      mass: boxMass(ssize, SHEET.density), area: 0, normal: { x: 0, y: -1, z: 0 }, face: -1, edge: false, level: 3, color: 0xf2f1ec,
    });
    for (const r of rafterOf) connect(sid, r, 800, { x: 0, y: -1, z: 0 }, "Soffit nails");
  }

  // --- Ceiling: 12.7 mm drywall screwed to the underside of the ceiling joists.
  {
    const cols = Math.ceil(b.width / SHEET.maxLong - 1e-9);
    const rows = Math.ceil(b.depth / SHEET.maxShort - 1e-9);
    const cw = b.width / cols;
    const cd = b.depth / rows;
    const th = 0.0127;
    for (let ci = 0; ci < cols; ci++)
      for (let ri = 0; ri < rows; ri++) {
        const x = -b.width / 2 + (ci + 0.5) * cw;
        const size: [number, number, number] = [cw, th, cd];
        const ceil = add({
          kind: "ceiling", pos: { x, y: SLAB_TOP + H - th / 2, z: -b.depth / 2 + (ri + 0.5) * cd }, q: ident,
          shapes: [{ size, pos: { x: 0, y: 0, z: 0 }, q: ident }],
          mass: CEILING_DRYWALL_AREAL * cw * cd, area: 0, plate: cw * cd, normal: { x: 0, y: -1, z: 0 }, face: -1, edge: false, level: 3, color: 0xeceae4,
        });
        const joists = rafterOf.filter((_, k) => Math.abs(rafterXs[k]! - x) <= cw / 2 + 1e-9);
        for (const r of joists) connect(ceil, r, (CONNECTION.ceilingScrewPa * cw * cd) / Math.max(joists.length, 1), { x: 0, y: -1, z: 0 }, "Ceiling screws");
      }
  }

  // --- Gable ends: a stud frame on each end wall up to the roof line, with sheathing strips.
  for (const face of [0, 2]) {
    const n = LOCAL_NORMALS[face]!;
    const t = faceTangent(face);
    const yaw = Math.atan2(-t.z, t.x);
    const q = yawQ(yaw);
    const x0 = n.x * (b.width / 2);
    const base = SLAB_TOP + H;
    const rise = b.roofRise + LUMBER.rafter[1]; // up to the raised roof line (rafter heel)
    const height = (u: number) => rise * Math.max(0, 1 - Math.abs(u) / (b.depth / 2));
    const [tw, td] = LUMBER.stud;
    const shapes: Shape[] = [{ size: [b.depth, tw, td], pos: { x: 0, y: tw / 2, z: 0 }, q: ident }];
    for (let u = -b.depth / 2 + LUMBER.studSpacing; u < b.depth / 2 - 0.1; u += LUMBER.studSpacing) {
      const h = height(u) - tw;
      if (h > 0.1) shapes.push({ size: [tw, h, td], pos: { x: u, y: tw + h / 2, z: 0 }, q: ident });
    }
    const gable = add({
      kind: "gableFrame", pos: { x: x0, y: base, z: 0 }, q, shapes,
      mass: shapes.reduce((a, s) => a + boxMass(s.size, LUMBER.density), 0),
      area: 0, normal: { x: n.x, y: 0, z: n.z }, face, edge: false, level: 3, color: 0xc9a36b,
    });
    // Bottom plate nailed to the end wall's top plate along its length…
    b.panels.forEach((p, i) => {
      if (p.face === face) connect(gable, frameOf[i]!, CONNECTION.gablePlateNPerM * p.len * cls.sheet, up, "Gable end nailing");
    });
    // (Its top is braced by the end rafter through the roof diaphragm: see the load solver.)
    // Sheathing: two right triangles meeting under the ridge, shaped exactly to the roof line.
    const zOut = td / 2 + SHEET.thickness / 2;
    const half = b.depth / 2;
    for (const side of [1, -1]) {
      const area = (half * rise) / 2;
      // Member origin at the triangle's centroid; the shape's right angle sits under the ridge.
      const cu = (side * half) / 3;
      const cy = rise / 3;
      const size: [number, number, number] = [half, rise, SHEET.thickness];
      const sheet = add({
        kind: "wallSheet",
        pos: { x: x0 + n.x * zOut + t.x * cu, y: base + cy, z: n.z * zOut + t.z * cu },
        q,
        shapes: [{ size, pos: { x: -cu, y: -cy, z: 0 }, q: ident, tri: { mirror: side < 0 } }],
        mass: SHEET.density * SHEET.thickness * area, area, normal: { x: n.x, y: 0, z: n.z }, face, edge: false, level: 4, color: OSB_COLOR,
      });
      connect(sheet, gable, CONNECTION.wallSheetPa * cls.sheet * area, { x: n.x, y: 0, z: n.z }, "Gable sheathing nails");
      const zs = SHEET.thickness / 2 + SIDING.thickness / 2;
      const vinyl = add({
        kind: "siding",
        pos: { x: x0 + n.x * (zOut + zs) + t.x * cu, y: base + cy, z: n.z * (zOut + zs) + t.z * cu },
        q,
        shapes: [{ size: [half, rise, SIDING.thickness], pos: { x: -cu, y: -cy, z: 0 }, q: ident, tri: { mirror: side < 0 } }],
        mass: SIDING.areal * area, area, normal: { x: n.x, y: 0, z: n.z }, face, edge: false, level: 5, color: b.wallColor,
      });
      connect(vinyl, sheet, SIDING.pa * area, { x: n.x, y: 0, z: n.z }, "Siding nails");
    }
  }

  // --- Interior: the floor plan's walls (studs + drywall), cut for doorways, with door leaves.
  for (const [wi, w] of floorPlan(b).entries()) {
    const h = H - 0.03; // stops just under the ceiling drywall
    const len = w.a1 - w.a0;
    const mid = (w.a0 + w.a1) / 2;
    const T = FLOOR_PLAN.wallThickness;
    // Wall-local: x along the wall (+x or +z), y from mid-height.
    const holes: Rect[] = w.doors.map((d) => {
      const half = (d.leaf === "none" ? d.width : DOOR[d.leaf === "solid" ? "exterior" : "interior"].width + 2 * DOOR.roughGap) / 2;
      return { x0: d.at - mid - half, x1: d.at - mid + half, y0: -h / 2, y1: -h / 2 + DOOR.interior.height + DOOR.roughGap };
    });
    const parts = subtractRects({ x0: -len / 2, x1: len / 2, y0: -h / 2, y1: h / 2 }, holes);
    const shapes: Shape[] = parts.map((r) => ({ size: [r.x1 - r.x0, r.y1 - r.y0, T], pos: { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2, z: 0 }, q: ident }));
    const solid = parts.reduce((a, r) => a + (r.x1 - r.x0) * (r.y1 - r.y0), 0);
    // Wall axis: along x, or along z (yaw −90° turns local +x into +z).
    const q = w.alongX ? ident : yawQ(-Math.PI / 2);
    const along = (a: number): Vec3 => (w.alongX ? { x: a, y: 0, z: w.c } : { x: w.c, y: 0, z: a });
    const normal: Vec3 = w.alongX ? { x: 0, y: 0, z: 1 } : { x: -1, y: 0, z: 0 };
    const c0 = along(mid);
    const pid = add({
      kind: "partition", pos: { x: c0.x, y: SLAB_TOP + h / 2, z: c0.z }, q, shapes,
      mass: PARTITION_AREAL * solid, area: solid, normal, face: -1, edge: false, level: 1, color: DRYWALL_COLOR, wall: wi,
    });
    // Bottom plate nailed to the slab along the solid length.
    const base = parts.filter((r) => r.y0 <= -h / 2 + 1e-6).reduce((a, r) => a + (r.x1 - r.x0), 0);
    connect(pid, -1, CONNECTION.partitionNPerM * base * cls.anchorage, up, "Partition to slab");
    for (const d of w.doors) {
      if (d.leaf === "none") continue;
      const D = d.leaf === "solid" ? DOOR.exterior : DOOR.interior;
      const p = along(d.at);
      const area = D.width * D.height;
      const door = add({
        kind: "door", pos: { x: p.x, y: SLAB_TOP + D.height / 2, z: p.z }, q, shapes: [{ size: [D.width, D.height, D.thickness], pos: { x: 0, y: 0, z: 0 }, q: ident }],
        mass: D.areal * area, area, normal, face: -1, edge: false, level: 2, color: 0xf2efe8, wall: wi,
      });
      connect(door, pid, CONNECTION.interiorDoorN, zero, "Interior door hinges");
    }
  }

  const supportsOf = members.map(() => [] as number[]);
  const carriesOf = members.map(() => [] as number[]);
  for (const c of connections) {
    supportsOf[c.from]!.push(c.id);
    if (c.to >= 0) carriesOf[c.to]!.push(c.id);
  }
  // Variability (Spec 03 fragility, Spec 09 v0.7): a house-wide quality factor and a scatter
  // per connection (nailing, sealing, age), lognormal, deterministic for the house.
  let weakest = 1;
  if (opts.scatter !== false) {
    const rng = hashRng(b.id * 2654435761 + 0x5eed);
    const normal = () => {
      const u1 = Math.max(rng(), 1e-12);
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * rng());
    };
    const clamp = (z: number) => Math.max(-2.5, Math.min(2.5, z));
    const F = DETAIL_FRAGILITY;
    const quality = Math.exp(F.houseQuality * clamp(normal()));
    const covering = Math.exp(F.coveringCondition * clamp(normal()));
    for (const c of connections) {
      const shingle = members[c.from]!.kind === "roofShingle";
      const k = quality * (shingle ? covering : 1) * Math.exp((shingle ? F.shingle : F.connection) * clamp(normal()));
      c.capacity *= k;
      weakest = Math.min(weakest, k);
    }
  }
  return { members, connections, supportsOf, carriesOf, weakest };
}

/** An interior wall: along x at z = c (or along z at x = c), from a0 to a1, with doorways. */
export interface PlanWall {
  alongX: boolean;
  c: number;
  a0: number;
  a1: number;
  /** Encloses the bathroom (the small interior room that stands longest). */
  core?: boolean;
  /** Doorway centres along the wall; "none" is a cased opening of the given width. */
  doors: { at: number; leaf: "hollow" | "solid" | "none"; width: number }[];
}

/**
 * Interior walls of the floor plan (Spec 09): garage at the front-left (−X, front −Z), living
 * room and kitchen in the middle, the bedroom wing on the right with a hallway along X:
 * two bedrooms in front of it, the bathroom, a walk-in closet and the primary bedroom behind.
 */
export function floorPlan(b: Pick<Building, "width" | "depth" | "hasGarage">): PlanWall[] {
  const P = FLOOR_PLAN;
  const W = b.width;
  const D = b.depth;
  const nx = Math.max(2, Math.round(W / LAYOUT.panelTarget));
  const T = P.wallThickness / 2 + 0.0075; // trim at T-junctions and the exterior walls
  const xg = -W / 2 + W / nx; // garage side wall (the garage door panel's edge)
  const zg = -D / 2 + Math.min(P.garageDepth, P.garageDepthShare * D);
  const xw = -W / 2 + P.wingStartShare * W; // bedroom wing
  const zh0 = -P.hallWidth / 2;
  const zh1 = P.hallWidth / 2;
  const xb = (xw + W / 2) / 2; // between the two front bedrooms
  const xp = xw + P.bathWidth; // bathroom | primary bedroom
  const zc = zh1 + P.bathDepth; // bathroom | closet
  const hollow = (at: number) => ({ at, leaf: "hollow" as const, width: DOOR.interior.width });
  const walls: PlanWall[] = [];
  if (b.hasGarage) {
    // Garage-to-house door (solid, fire-rated) into the kitchen.
    walls.push({ alongX: true, c: zg, a0: -W / 2 + T, a1: xg - T, doors: [{ at: (-W / 2 + xg) / 2, leaf: "solid", width: DOOR.exterior.width }] });
    walls.push({ alongX: false, c: xg, a0: -D / 2 + T, a1: zg + P.wallThickness / 2 + T, doors: [] });
  }
  walls.push(
    // Wing wall, with a cased opening into the hallway.
    { alongX: false, c: xw, a0: -D / 2 + T, a1: D / 2 - T, doors: [{ at: 0, leaf: "none", width: P.hallWidth - 0.2 }] },
    // Hallway front wall: doors to bedrooms 3 and 2.
    { alongX: true, c: zh0, a0: xw + T, a1: W / 2 - T, doors: [hollow(xw + P.doorInset), hollow(xb + P.doorInset)] },
    { alongX: false, c: xb, a0: -D / 2 + T, a1: zh0 - T, doors: [] },
    // Hallway back wall: doors to the bathroom and the primary bedroom.
    { alongX: true, c: zh1, a0: xw + T, a1: W / 2 - T, doors: [hollow(xw + P.doorInset), hollow(xp + P.doorInset)], core: true },
    // Bathroom and closet | primary bedroom, with the closet door.
    { alongX: false, c: xp, a0: zh1 + T, a1: D / 2 - T, doors: [hollow((zc + D / 2) / 2)], core: true },
    { alongX: true, c: zc, a0: xw + T, a1: xp - T, doors: [], core: true },
  );
  return walls;
}
