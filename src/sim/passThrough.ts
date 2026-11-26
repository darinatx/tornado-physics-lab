/**
 * Pass-through check (Spec 10 IMP-01, IMP-15, IMP-16; Spec 09 slabs): watches every debris
 * piece step by step and reports any that go through a standing wall or roof, into a slab
 * (foundation), or below the ground.
 *
 * The geometry here is written independently of the impact code it checks (src/core/impact):
 * a house is the box |x| ≤ W/2, |z| ≤ D/2 from the slab top to the eaves under its two roof
 * planes, in the house frame (yaw, plus any shift off its foundation); its slab is the
 * foundation footprint (0.3 m wider than the walls each side) up to the slab top.
 *
 * Only certain violations are reported: a crossing counts only where the panel, gable or roof
 * section it crosses still stands (a broken pane, failed garage door, failed wall panel, failed
 * deck or bay is an opening anywhere on that panel or section). Detailed houses are judged
 * only while intact (DOD ≤ 2), where nothing is open.
 */
import { overSlab, slabHalf } from "../core/impact/envelope";
import { LAYOUT } from "../config/buildings";
import { SLAB_TOP } from "../config/structure";
import type { Building } from "../core/damage/types";
import type { Vec3 } from "../core/math/vec";

/** Slab overhang past the walls on each side (m, as drawn; Spec 10). */

/** Tolerances (m): a piece resting on a surface sits at most this far into it. */
const TOL = 0.02;

export type ViolationKind = "through wall" | "through roof" | "out through wall" | "out through roof" | "inside slab" | "below ground";

export interface Violation {
  kind: ViolationKind;
  /** The piece's key (one piece can be reported on several steps). */
  key: string;
  /** What moved: "debris" (component debris), "rubble", or "member" (detail zone). */
  source: string;
  label: string;
  house: number;
  time: number;
  /** Where, house-local (m). */
  at: Vec3;
  /** Depth into the slab or below ground (m), or the crossing's surface. */
  detail: string;
  /** House that shed the piece, if known. */
  from?: number;
}

export interface Tracked {
  key: string;
  source: string;
  label: string;
  pos: Vec3;
  /** House the piece belongs to (detail members: their own house, not judged against it). */
  own?: number;
  /** House that shed it (for the report). */
  from?: number;
}

/** A house in its local frame. */
interface Frame {
  b: Building;
  c: number;
  s: number;
  ox: number;
  oz: number;
  hw: number;
  hd: number;
  eave: number;
  rise: number;
}

const frames = new WeakMap<Building, Frame & { planes: { n: Vec3; d: number; tag: PlaneTag; len: number }[] }>();
/** A house's frame and planes, cached (a shift off the foundation changes them: rebuilt then). */
function frameOf(b: Building): Frame & { planes: { n: Vec3; d: number; tag: PlaneTag; len: number }[] } {
  const f = frames.get(b);
  if (f && f.ox === b.x + (b.shift?.x ?? 0) && f.oz === b.z + (b.shift?.z ?? 0)) return f;
  const g = frame(b);
  const out = { ...g, planes: planes(g).map((p) => ({ ...p, len: Math.hypot(p.n.x, p.n.y, p.n.z) })) };
  frames.set(b, out);
  return out;
}

function frame(b: Building): Frame {
  return {
    b,
    c: Math.cos(b.yaw),
    s: Math.sin(b.yaw),
    ox: b.x + (b.shift?.x ?? 0),
    oz: b.z + (b.shift?.z ?? 0),
    hw: b.width / 2,
    hd: b.depth / 2,
    eave: SLAB_TOP + b.wallHeight,
    rise: b.roofRise,
  };
}

function local(f: Frame, p: Vec3, ox = f.ox, oz = f.oz): Vec3 {
  const dx = p.x - ox;
  const dz = p.z - oz;
  return { x: dx * f.c - dz * f.s, y: p.y, z: dx * f.s + dz * f.c };
}

/** Planes of the solid as n·p ≤ d (local), with what they are. */
type PlaneTag = { face: number } | { roof: -1 | 1 } | { floor: true };
function planes(f: Frame): { n: Vec3; d: number; tag: PlaneTag }[] {
  const k = f.rise / f.hd;
  return [
    { n: { x: 1, y: 0, z: 0 }, d: f.hw, tag: { face: 0 } },
    { n: { x: 0, y: 0, z: 1 }, d: f.hd, tag: { face: 1 } },
    { n: { x: -1, y: 0, z: 0 }, d: f.hw, tag: { face: 2 } },
    { n: { x: 0, y: 0, z: -1 }, d: f.hd, tag: { face: 3 } },
    // y + k·|z| ≤ eave + rise, one plane per slope.
    { n: { x: 0, y: 1, z: k }, d: f.eave + f.rise, tag: { roof: 1 } },
    { n: { x: 0, y: 1, z: -k }, d: f.eave + f.rise, tag: { roof: -1 } },
    { n: { x: 0, y: -1, z: 0 }, d: -SLAB_TOP, tag: { floor: true } },
  ];
}

/** Segment a→b (local) against the solid: the entry and exit planes and points, if it meets it. */
function clip(f: ReturnType<typeof frameOf>, a: Vec3, b: Vec3): { tIn: number; tOut: number; inTag: PlaneTag | null; outTag: PlaneTag | null } | null {
  let tIn = 0;
  let tOut = 1;
  let inTag: PlaneTag | null = null;
  let outTag: PlaneTag | null = null;
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  for (const pl of f.planes) {
    const num = pl.d - (pl.n.x * a.x + pl.n.y * a.y + pl.n.z * a.z);
    const den = pl.n.x * d.x + pl.n.y * d.y + pl.n.z * d.z;
    if (Math.abs(den) < 1e-12) {
      if (num < 0) return null; // parallel and outside
      continue;
    }
    const t = num / den;
    if (den < 0) {
      if (t > tIn) {
        tIn = t;
        inTag = pl.tag;
      }
    } else if (t < tOut) {
      tOut = t;
      outTag = pl.tag;
    }
    if (tIn > tOut) return null;
  }
  return { tIn, tOut, inTag, outTag };
}

/** Is the surface at local point l on plane `tag` still standing (no opening there)? */
function standing(b: Building, tag: PlaneTag, l: Vec3, eave: number): boolean {
  if ("floor" in tag) return true;
  if ("roof" in tag) {
    const oh = LAYOUT.overhang;
    const colW = (b.width + 2 * oh) / b.nx;
    const col = Math.min(b.nx - 1, Math.max(0, Math.floor((l.x + b.width / 2 + oh) / colW)));
    if (b.bays[col]?.failed) return false;
    const row = Math.abs(l.z) > (b.depth / 2 + oh) / 2 ? 0 : 1;
    const sec = b.sections.find((s) => s.col === col && s.slope === tag.roof && s.row === row);
    return !sec?.deck;
  }
  // Walls (and gables above the eaves on end faces): the panel at this position along the
  // face, whichever way `u` runs (an opening under either reading counts: never a false alarm).
  const u = tag.face === 0 || tag.face === 2 ? l.z : l.x;
  const near = b.panels
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.face === tag.face && (Math.abs(u - p.u) <= p.len / 2 + 1e-6 || Math.abs(-u - p.u) <= p.len / 2 + 1e-6));
  if (!near.length) return false; // can't place it: don't accuse
  // A gable (above the eaves on an end face) goes with its end roof bay and stands on the whole
  // end wall: it's gone once the bay or any panel on that face has fallen (as drawn, Spec 10).
  if (l.y > eave && (tag.face === 0 || tag.face === 2)) {
    const col = tag.face === 0 ? b.nx - 1 : 0;
    if (b.bays[col]?.failed || b.panels.some((p) => p.face === tag.face && p.failed)) return false;
  }
  for (const { p, i } of near) {
    if (p.failed) return false;
    if (l.y <= eave) {
      // A pane broken by a debris hit this step is open, though the house records it at its
      // next damage evaluation (Spec 10 timing).
      if (b.panes.some((q, k) => q.panel === i && (q.failed || b.impacts.some((m) => m.surface === "pane" && m.index === k && m.broke)))) return false;
      // A detailed house's panes as the town's debris meets them: its stand-in (Spec 10 v0.7),
      // where a debris hit breaks a pane at once (the detail engine breaks it a step later).
      const si = b.detail ? b.standIn : undefined;
      if (si && si.panes.some((q, k) => q.panel === i && (q.failed || si.impacts.some((m) => m.surface === "pane" && m.index === k && m.broke)))) return false;
      if (b.garage && b.garage.panel === i && b.garage.failed) return false;
    }
  }
  return true;
}

export class PassThroughMonitor {
  readonly violations: Violation[] = [];
  /** Observations made (piece-steps). */
  checked = 0;
  private readonly last = new Map<string, Vec3>();
  private readonly grid = new Map<string, Building[]>();
  private readonly cell = 50;

  constructor(private readonly buildings: readonly Building[]) {
    for (const b of buildings) {
      const r = Math.hypot(b.width, b.depth) / 2 + 2;
      for (let i = Math.floor((b.x - r) / this.cell); i <= Math.floor((b.x + r) / this.cell); i++)
        for (let j = Math.floor((b.z - r) / this.cell); j <= Math.floor((b.z + r) / this.cell); j++) {
          const k = `${i},${j}`;
          (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(b);
        }
    }
  }

  private near(p: Vec3): Building[] {
    return this.grid.get(`${Math.floor(p.x / this.cell)},${Math.floor(p.z / this.cell)}`) ?? [];
  }

  /** Judge each piece's move since its last observation. */
  observe(time: number, pieces: readonly Tracked[], opts: { moveChecks?: boolean } = {}): void {
    const moveChecks = opts.moveChecks ?? true;
    for (const t of pieces) {
      this.checked++;
      const p = t.pos;
      const prev = this.last.get(t.key);
      this.last.set(t.key, { x: p.x, y: p.y, z: p.z });
      if (p.y < -TOL) this.add("below ground", t, -1, time, p, `${(-p.y).toFixed(2)} m down`);
      const cands = new Set(this.near(p));
      if (prev && moveChecks) for (const b of this.near(prev)) cands.add(b);
      for (const b of cands) {
        if (b.id === t.own) continue;
        const f = frameOf(b);
        // Foundation: the slab stays at the house's site (it doesn't shift).
        const s = local(f, p, b.x, b.z);
        // The slab as built: 0.3 m past the walls for component houses, flush with the wall
        // frames for detailed ones (Spec 10 slabHalf).
        const sh = slabHalf(b);
        if (Math.abs(s.x) < sh.x && Math.abs(s.z) < sh.z && p.y < SLAB_TOP - TOL && p.y > -1) {
          this.add("inside slab", t, b.id, time, s, `${(SLAB_TOP - p.y).toFixed(2)} m below the slab top`);
        }
        if (!prev || !moveChecks) continue;
        // Walls and roof of a house that has them.
        if (b.sweep.failed || (b.detail && b.dod > 2)) continue;
        const a = local(f, prev);
        const c = local(f, p);
        const hit = clip(f, a, c);
        if (!hit) continue;
        const at = (u: number) => ({ x: a.x + (c.x - a.x) * u, y: a.y + (c.y - a.y) * u, z: a.z + (c.z - a.z) * u });
        // Only a real crossing: the path gets more than TOL inside (not a graze along a plane).
        if (depthInside(f, at((hit.tIn + hit.tOut) / 2)) <= TOL) continue;
        // Entered through a standing surface (from outside: the segment starts outside).
        if (hit.inTag && hit.tIn > 0) {
          const l = at(hit.tIn);
          // Up through the floor only where the slab is (a shifted house stands partly on bare
          // ground), as for leaving below.
          const bare = "floor" in hit.inTag && !overSlab(b, { x: f.ox + l.x * f.c + l.z * f.s, y: l.y, z: f.oz - l.x * f.s + l.z * f.c });
          if (!bare && standing(b, hit.inTag, l, f.eave)) this.add("roof" in hit.inTag ? "through roof" : "through wall", t, b.id, time, l, describe(hit.inTag));
        }
        // Left through a standing surface (debris inside a house stays in until an opening).
        if (hit.outTag && hit.tOut < 1) {
          const l = at(hit.tOut);
          // The floor is the slab top only where the slab is: a house shifted off its
          // foundation stands partly on the bare ground (Spec 03 shift, Spec 10 slabs).
          if ("floor" in hit.outTag) {
            const w = { x: f.ox + l.x * f.c + l.z * f.s, y: l.y, z: f.oz - l.x * f.s + l.z * f.c };
            if (!overSlab(b, w)) continue;
          }
          if (standing(b, hit.outTag, l, f.eave)) this.add("roof" in hit.outTag ? "out through roof" : "out through wall", t, b.id, time, l, describe(hit.outTag));
        }
      }
    }
  }

  private add(kind: ViolationKind, t: Tracked, house: number, time: number, at: Vec3, detail: string): void {
    this.violations.push({ kind, key: t.key, source: t.source, label: t.label, house, time, at, detail, from: t.from });
  }

  /** Counts by source and kind, and a few examples of each. */
  summary(examples = 3): { counts: Record<string, number>; pieces: Record<string, number>; examples: Violation[] } {
    const counts: Record<string, number> = {};
    const keys = new Map<string, Set<string>>();
    const shown = new Map<string, number>();
    const ex: Violation[] = [];
    for (const v of this.violations) {
      const k = `${v.source}: ${v.kind}`;
      counts[k] = (counts[k] ?? 0) + 1;
      (keys.get(k) ?? keys.set(k, new Set()).get(k)!).add(v.key);
      if ((shown.get(k) ?? 0) < examples) {
        shown.set(k, (shown.get(k) ?? 0) + 1);
        ex.push(v);
      }
    }
    const pieces: Record<string, number> = {};
    for (const [k, s] of keys) pieces[k] = s.size;
    return { counts, pieces, examples: ex };
  }
}

/** How far a local point is inside the solid (m; negative outside). */
function depthInside(f: ReturnType<typeof frameOf>, l: Vec3): number {
  let d = Infinity;
  for (const pl of f.planes) d = Math.min(d, (pl.d - (pl.n.x * l.x + pl.n.y * l.y + pl.n.z * l.z)) / pl.len);
  return d;
}

function describe(tag: PlaneTag): string {
  if ("roof" in tag) return tag.roof > 0 ? "back roof slope" : "front roof slope";
  if ("floor" in tag) return "floor";
  return ["+X end wall", "back wall", "−X end wall", "front wall"][tag.face]!;
}
