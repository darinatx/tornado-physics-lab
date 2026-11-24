/**
 * Detail-house survey and hand-off (Spec 09 slice B): the degree of damage of a member-level
 * house by the component model's rules, and which members a house entering the detail zone
 * no longer has because their components already failed in the component model.
 */
import { LAYOUT } from "../../config/buildings";
import { SLAB_TOP } from "../../config/structure";
import type { Building, RoofSection } from "../damage/types";
import type { Vec3 } from "../math/vec";
import { floorPlan } from "./framing";
import type { Framing, Member } from "./framing";

/** Roof section (component model) a roof member sits in, by its house-local position. */
export function roofSectionOf(b: Pick<Building, "width" | "depth" | "nx">, m: Member): { col: number; slope: -1 | 1; row: 0 | 1 } {
  const oh = LAYOUT.overhang;
  const colW = (b.width + 2 * oh) / b.nx;
  const col = Math.min(b.nx - 1, Math.max(0, Math.floor((m.pos.x + b.width / 2 + oh) / colW)));
  const halfRun = b.depth / 2 + oh;
  return { col, slope: m.pos.z < 0 ? -1 : 1, row: Math.abs(m.pos.z) > halfRun / 2 ? 0 : 1 };
}

const sameSection = (a: { col: number; slope: number; row: number }, s: RoofSection) => a.col === s.col && a.slope === s.slope && a.row === s.row;

/** Members to leave out of a house entering the detail zone (Spec 09 hand-off table). */
export function removedOnEntry(b: Building, f: Framing): boolean[] {
  const gone = f.members.map(() => false);
  if (b.sweep.failed) return gone.fill(true);
  const plan = floorPlan(b);
  const oh = LAYOUT.overhang;
  const colW = (b.width + 2 * oh) / b.nx;
  const colOf = (x: number) => Math.min(b.nx - 1, Math.max(0, Math.floor((x + b.width / 2 + oh) / colW)));
  const bayGone = b.bays.map((s) => !!s.failed);
  // Interior walls: the failed share of the ordinary partitions, in plan order; the bathroom's
  // walls with the core room.
  const ordinary = plan.map((w, i) => (w.core ? -1 : i)).filter((i) => i >= 0);
  const share = b.partitions.length ? b.partitions.filter((p) => p.failed).length / b.partitions.length : 0;
  const wallGone = new Set(ordinary.slice(0, Math.round(share * ordinary.length)));
  if (b.coreRoom.failed) plan.forEach((w, i) => w.core && wallGone.add(i));
  for (const m of f.members) {
    let g = false;
    if (m.panel !== undefined) {
      const p = m.panel;
      // A fallen wall leaves its sill plate bolted to the slab.
      if (b.panels[p]!.failed && m.kind !== "sillPlate") g = true;
      else if (m.kind === "siding" && b.siding[p]?.failed) g = true;
      else if (m.kind === "pane" && b.panes.some((q) => q.panel === p && q.failed)) g = true;
      else if (m.kind === "garageDoor" && b.garage?.failed) g = true;
    } else if (m.wall !== undefined) {
      g = wallGone.has(m.wall);
    } else if (m.kind === "rafterPair" || m.kind === "ceiling") {
      g = bayGone[colOf(m.pos.x)]!;
    } else if (m.kind === "roofSheet" || m.kind === "roofShingle") {
      const at = roofSectionOf(b, m);
      if (bayGone[at.col]) g = true;
      const s = b.sections.find((x) => sameSection(at, x));
      if (s?.deck) g = true;
      if (m.kind === "roofShingle" && s?.cover) g = true;
    }
    gone[m.id] = g;
  }
  // Shingles go with their roof sheet.
  for (const c of f.connections) if (c.to >= 0 && gone[c.to] && f.members[c.from]!.kind === "roofShingle") gone[c.from] = true;
  return gone;
}

/**
 * Survey DOD of a detailed house (Spec 09 table): the component model's rules applied to
 * members. `attached` says what still stands; `pose` gives a member's house-local position
 * (only used to check whether anything rests on the slab).
 */
export function surveyDetail(
  b: Pick<Building, "width" | "depth">,
  f: Framing,
  attached: readonly boolean[],
  intact: readonly boolean[],
  localPos: (id: number) => Vec3 | null,
): number {
  const count = (pred: (m: Member) => boolean) => {
    let all = 0;
    let lost = 0;
    for (const m of f.members)
      if (pred(m)) {
        all++;
        if (!attached[m.id]) lost++;
      }
    return { all, lost, frac: all ? lost / all : 0 };
  };
  const frames = count((m) => m.kind === "wallFrame");
  const plan = floorPlan(b as Building);
  const walls = count((m) => m.kind === "partition");
  const ordinaryWalls = count((m) => m.kind === "partition" && !plan[m.wall!]?.core);
  // Swept clean: nothing left standing or resting on the slab but sill plates still bolted
  // down (the classic picture of EF4–5 damage).
  const everything = count((m) => m.kind !== "sillPlate");
  if (everything.lost === everything.all) {
    const onSlab = f.members.some((m) => {
      if (m.kind === "sillPlate" && attached[m.id]) return false;
      const p = localPos(m.id);
      return p && Math.abs(p.x) < b.width / 2 && Math.abs(p.z) < b.depth / 2 && p.y < SLAB_TOP + 1.5;
    });
    if (!onSlab) return 10;
  }
  if (frames.lost === frames.all && walls.lost === walls.all) return 9;
  if (frames.frac >= 0.75 && ordinaryWalls.lost === ordinaryWalls.all) return 8;
  if (frames.frac >= 0.5) return 7;
  if (count((m) => m.kind === "rafterPair").frac >= 1 / 3) return 6;
  // DOD 5 (whole house shifted off its foundation) isn't represented: the wall frames aren't
  // tied into one box that could slide; it is reached together with DOD 6.
  void intact;
  const shingles = count((m) => m.kind === "roofShingle");
  if (shingles.frac >= 0.2 || count((m) => m.kind === "roofSheet").lost > 0 || count((m) => m.kind === "garageDoor").lost > 0) return 4;
  if (count((m) => m.kind === "pane").lost > 0) return 3;
  if (shingles.lost > 0) return 2;
  if (count((m) => m.kind === "siding" || m.kind === "wallSheet").lost > 0) return 1;
  return 0;
}
