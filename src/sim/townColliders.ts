/**
 * Houses around the detail zone as the detail physics sees them (Spec 10 v0.6): static Rapier
 * colliders for each one's slab and, for houses on the component model, every wall panel, roof
 * section and gable still standing (with holes where a window or the garage door is broken).
 * Pieces from detailed houses hit them instead of passing through. Built from the house's
 * component state as the sim last sent it, and rebuilt when it changes.
 */
import RAPIER from "@dimforge/rapier3d-simd-compat";
import { LAYOUT } from "../config/buildings";
import { IMPACT } from "../config/impacts";
import { faceTangent, panelCenter, sectionGeometry, toWorld } from "../core/damage/layout";
import type { Building, FailureRecord } from "../core/damage/types";
import { slabHalf } from "../core/impact/envelope";

type Q = [number, number, number, number];

/** A house's component state as the detail engine needs it (what stands, what's open). */
export interface TownState {
  index: number;
  /** In the detail zone: the state is its lagged stand-in's (Spec 10 v0.8), and its slab is
   *  the detailed house's (flush with the wall frames). */
  detail: boolean;
  sweep: boolean;
  shift: { x: number; z: number } | null;
  panels: boolean[];
  panes: boolean[];
  garage: boolean;
  /** Roof sections whose deck failed, and failed bays. */
  decks: boolean[];
  bays: boolean[];
}

/** The state of a house, to send. */
export function townState(index: number, house: Building): TownState {
  // A detailed house is sent as its stand-in: what stands in the detail physics, as of the lag.
  const b = house.detail && house.standIn ? house.standIn : house;
  return {
    index,
    detail: !!house.detail,
    sweep: !!b.sweep.failed,
    shift: b.shift ? { x: b.shift.x, z: b.shift.z } : null,
    panels: b.panels.map((p) => !!p.failed),
    panes: b.panes.map((p) => !!p.failed),
    garage: !!b.garage?.failed,
    decks: b.sections.map((s) => !!s.deck),
    bays: b.bays.map((x) => !!x.failed),
  };
}

/** Stand-in failure record: the engine only needs to know that a component is gone. */
const GONE = { part: "wallPanel", index: 0, time: 0, load: 0, capacity: 0, mph: 0, sign: 0, wind: { x: 0, y: 0, z: 0 } } as FailureRecord;

/** The engine's own copy of a house (never the sim's object), with a state applied. */
export function townCopy(b: Building, st: TownState, copy?: Building): Building {
  const c: Building =
    copy ??
    ({
      ...b,
      panels: b.panels.map((p) => ({ ...p })),
      panes: b.panes.map((p) => ({ ...p })),
      sections: b.sections.map((s) => ({ ...s })),
      bays: b.bays.map((x) => ({ ...x })),
      garage: b.garage ? { ...b.garage } : null,
      sweep: { ...b.sweep },
      siding: b.siding.map((x) => ({ ...x })),
      impacts: [],
    } as Building);
  // Walls and roof from the state; a detailed house's slab is flush with its frames.
  c.detail = false;
  c.standInFor = st.detail ? b.id : undefined;
  c.shift = st.shift;
  c.sweep.failed = st.sweep ? GONE : null;
  st.panels.forEach((f, i) => (c.panels[i]!.failed = f ? GONE : null));
  st.panes.forEach((f, i) => (c.panes[i]!.failed = f ? GONE : null));
  if (c.garage) c.garage.failed = st.garage ? GONE : null;
  st.decks.forEach((f, i) => (c.sections[i]!.deck = f ? GONE : null));
  st.bays.forEach((f, i) => (c.bays[i]!.failed = f ? GONE : null));
  return c;
}

const yawQ = (a: number): Q => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const pitchQ = (a: number): Q => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];
function mul(a: Q, b: Q): Q {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/**
 * Collision groups (Rapier: membership << 16 | filter). Things that never move (the ground,
 * slabs, standing houses, the stand-ins) are FIXED: they interact only with moving pieces, so
 * Rapier doesn't keep pairs between them (slabs reaching into the ground cost ~6 ms per step
 * with nothing moving before). Moving pieces keep the default (everything).
 */
export const FIXED_GROUPS = (0x0002 << 16) | 0x0001;
/**
 * How far a slab's collider reaches below the ground (m): a sheet sliding flat along the ground
 * would otherwise meet the slab's bottom edge right at the ground and slip under it.
 */
export const SLAB_DEPTH = 0.5;
/** Wall thickness of a component house as drawn (m). */
const WALL_T = 0.15;
const FRICTION = 0.6;

/**
 * Build the static colliders for one house: its slab always; walls, roof and gables while it is
 * on the component model and not swept. Returns them, to remove on the next change.
 */
export function buildTownColliders(world: RAPIER.World, b: Building, planes?: Map<number, number>): RAPIER.Collider[] {
  const out: RAPIER.Collider[] = [];
  const S = IMPACT.slabTop;
  // Each collider's envelope plane (Spec 10 envelope: 0–3 wall faces, 5/6 roof slopes; none for
  // the slab), so a hit on it can be turned into an impact on the right component.
  const add = (desc: RAPIER.ColliderDesc, plane = -1) => {
    const col = world.createCollider(desc.setFriction(FRICTION).setCollisionGroups(FIXED_GROUPS));
    out.push(col);
    if (plane >= 0) planes?.set(col.handle, plane);
  };
  const box = (lx: number, ly: number, lz: number, hx: number, hy: number, hz: number, q: Q, shifted = true, plane = -1) => {
    if (hx <= 0.01 || hy <= 0.01) return;
    const p = toWorld(b, lx, ly, lz, shifted);
    add(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(p.x, p.y, p.z).setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }), plane);
  };

  // The slab stays where it was poured; its collider reaches into the ground (SLAB_DEPTH).
  const sh = slabHalf(b);
  box(0, (S - SLAB_DEPTH) / 2, 0, sh.x, (S + SLAB_DEPTH) / 2, sh.z, yawQ(b.yaw), false);
  if (b.sweep.failed) return out;

  const H = b.wallHeight;
  b.panels.forEach((panel, i) => {
    if (panel.failed) return;
    const t = faceTangent(panel.face);
    const q = yawQ(b.yaw + Math.atan2(-t.z, t.x));
    const c = panelCenter(b, panel, 0);
    // Pieces of the panel around an opening (u along the face, h above the slab), as boxes.
    const holes: { u0: number; u1: number; h0: number; h1: number }[] = [];
    const pane = b.panes.findIndex((p) => p.panel === i);
    if (pane >= 0 && b.panes[pane]!.failed) holes.push({ u0: -LAYOUT.paneSize / 2, u1: LAYOUT.paneSize / 2, h0: LAYOUT.paneSill, h1: LAYOUT.paneSill + LAYOUT.paneSize });
    if (panel.isGarage && b.garage?.failed) {
      const gw = Math.min(LAYOUT.garageWidth, panel.len * 0.9);
      holes.push({ u0: -gw / 2, u1: gw / 2, h0: 0, h1: LAYOUT.garageHeight });
    }
    const part = (u0: number, u1: number, h0: number, h1: number) => {
      const uc = (u0 + u1) / 2;
      const hc = (h0 + h1) / 2;
      box(c.x + t.x * uc, S + hc, c.z + t.z * uc, (u1 - u0) / 2, (h1 - h0) / 2, WALL_T / 2, q, true, panel.face);
    };
    const L = panel.len / 2;
    if (!holes.length) part(-L, L, 0, H);
    else {
      const o = holes[0]!;
      part(-L, o.u0, 0, H); // left of the opening
      part(o.u1, L, 0, H); // right of it
      part(o.u0, o.u1, 0, o.h0); // below
      part(o.u0, o.u1, o.h1, H); // above
    }
  });

  // Roof sections on standing bays, as drawn.
  for (const s of b.sections) {
    if (b.bays[s.col]!.failed || s.deck) continue;
    const g = sectionGeometry(b, b.nx, s);
    box(g.center.x, S + g.center.y, g.center.z, g.width / 2, 0.075, g.length / 2, mul(yawQ(b.yaw), pitchQ(g.pitch)), true, s.slope === 1 ? 5 : 6);
  }

  // Gables: on their end wall, with the end bay (as drawn).
  for (const [face, col] of [[0, b.nx - 1], [2, 0]] as const) {
    if (b.bays[col]!.failed || b.panels.some((p) => p.face === face && p.failed)) continue;
    const x = (face === 0 ? 1 : -1) * (b.width / 2);
    const pts: number[] = [];
    for (const dx of [-WALL_T / 2, WALL_T / 2])
      for (const [z, y] of [[-b.depth / 2, S + H], [b.depth / 2, S + H], [0, S + H + b.roofRise]] as const) {
        const w = toWorld(b, x + dx, y, z);
        pts.push(w.x, w.y, w.z);
      }
    const hull = RAPIER.ColliderDesc.convexHull(new Float32Array(pts));
    if (hull) add(hull, face);
  }
  return out;
}
