/**
 * What town debris sees of a detailed house (Spec 10 v0.7): a component-model copy of it whose
 * wall panels, windows, garage door, roof sections and bays stand exactly while their members
 * stand in the detail physics, as of a fixed lag behind it. The detail physics runs ahead of the
 * sim's results by a variable amount (in workers), so the copy follows the members' first moves
 * as of `cutoff` = the newest detail step whose results are certain to have arrived (the sim
 * never runs more than the bounded lead ahead of them). Same seed and inputs → same copy at the
 * same step, whatever the timing.
 */
import { LAYOUT } from "../config/buildings";
import type { Building, FailureRecord, QueuedImpact } from "../core/damage/types";
import type { Framing } from "../core/structure/framing";
import { roofSectionOf } from "../core/structure/survey";

const GONE = { part: "wallPanel", index: 0, time: 0, load: 0, capacity: 0, mph: 0, sign: 0, wind: { x: 0, y: 0, z: 0 } } as FailureRecord;

interface Tracked {
  copy: Building;
  /** Per member: which component it stands for (−1: none). */
  panelFrame: Int32Array;
  panelPane: Int32Array;
  garage: Uint8Array;
  section: Int32Array;
  bay: Int32Array;
  /** Totals per component, and how many of their members have moved so far (as of cutoff). */
  frames: number[];
  framesMoved: number[];
  sheets: number[];
  sheetsMoved: number[];
  rafters: number[];
  raftersMoved: number[];
  /** First moves not yet applied: [detail step, member], in step order. */
  events: [number, number][];
  next: number;
  seen: Uint8Array;
}

export class DetailStandIns {
  private readonly houses = new Map<number, Tracked>();

  /** A house entered the detail zone (before its first result). */
  add(index: number, b: Building, f: Framing): void {
    const n = f.members.length;
    const t: Tracked = {
      copy: {
        ...b,
        detail: false,
        standInFor: b.id,
        standIn: undefined,
        panels: b.panels.map((p) => ({ ...p })),
        panes: b.panes.map((p) => ({ ...p })),
        sections: b.sections.map((s) => ({ ...s })),
        bays: b.bays.map((x) => ({ ...x })),
        garage: b.garage ? { ...b.garage } : null,
        sweep: { ...b.sweep, failed: null },
        siding: b.siding.map((x) => ({ ...x })),
        impacts: [],
      } as Building,
      panelFrame: new Int32Array(n).fill(-1),
      panelPane: new Int32Array(n).fill(-1),
      garage: new Uint8Array(n),
      section: new Int32Array(n).fill(-1),
      bay: new Int32Array(n).fill(-1),
      frames: b.panels.map(() => 0),
      framesMoved: b.panels.map(() => 0),
      sheets: b.sections.map(() => 0),
      sheetsMoved: b.sections.map(() => 0),
      rafters: b.bays.map(() => 0),
      raftersMoved: b.bays.map(() => 0),
      events: [],
      next: 0,
      seen: new Uint8Array(n),
    };
    const oh = LAYOUT.overhang;
    const colW = (b.width + 2 * oh) / b.nx;
    const colOf = (x: number) => Math.min(b.nx - 1, Math.max(0, Math.floor((x + b.width / 2 + oh) / colW)));
    for (const m of f.members) {
      if (m.kind === "wallFrame" && m.panel !== undefined) {
        t.panelFrame[m.id] = m.panel;
        t.frames[m.panel]!++;
      } else if (m.kind === "pane" && m.panel !== undefined) t.panelPane[m.id] = m.panel;
      else if (m.kind === "garageDoor") t.garage[m.id] = 1;
      else if (m.kind === "roofSheet") {
        const at = roofSectionOf(b, m);
        const s = b.sections.findIndex((x) => x.col === at.col && x.slope === at.slope && x.row === at.row);
        if (s >= 0) {
          t.section[m.id] = s;
          t.sheets[s]!++;
        }
      } else if (m.kind === "rafterPair") {
        const c = colOf(m.pos.x);
        t.bay[m.id] = c;
        t.rafters[c]!++;
      }
    }
    // Before anything moves, the copy is the house as it entered (members of components that
    // had already failed arrive as moves at the entry step).
    this.houses.set(index, t);
    b.standIn = t.copy;
  }

  remove(index: number, b: Building): void {
    this.houses.delete(index);
    delete b.standIn;
  }

  /** Record first moves from one detail result (poses: [house, member, …] × 9 floats). */
  record(n: number, poses: Float32Array): void {
    for (let k = 0; k < poses.length; k += 9) {
      const t = this.houses.get(poses[k]!);
      if (!t) continue;
      const m = poses[k + 1]!;
      if (t.seen[m]) continue;
      t.seen[m] = 1;
      t.events.push([n, m]);
    }
  }

  /** Town debris hits on detailed houses since the last call, to send to the detail engine. */
  readonly forward: { index: number; impact: QueuedImpact }[] = [];

  /** Surfaces that went at the last advance: [stand-in, part, index] (their lodged pieces fall free). */
  readonly gone: [Building, FailureRecord["part"], number][] = [];

  /** Apply every first move at or before detail step `cutoff`. */
  advance(cutoff: number): void {
    this.gone.length = 0;
    for (const [index, t] of this.houses) {
      // Hits from the town's debris go to the detail physics (Spec 10 slice B).
      for (const impact of t.copy.impacts) this.forward.push({ index, impact });
      t.copy.impacts.length = 0;
      let changed = false;
      while (t.next < t.events.length && t.events[t.next]![0] <= cutoff) {
        const m = t.events[t.next++]![1];
        changed = true;
        const c = t.copy;
        const p = t.panelFrame[m]!;
        if (p >= 0 && ++t.framesMoved[p]! >= t.frames[p]! && !c.panels[p]!.failed) {
          c.panels[p]!.failed = GONE;
          this.gone.push([c, "wallPanel", p]);
        }
        const pp = t.panelPane[m]!;
        if (pp >= 0) for (const pane of c.panes) if (pane.panel === pp) pane.failed = GONE;
        if (t.garage[m] && c.garage && !c.garage.failed) {
          c.garage.failed = GONE;
          this.gone.push([c, "garage", c.garage.panel]);
        }
        const s = t.section[m]!;
        if (s >= 0 && ++t.sheetsMoved[s]! * 2 >= t.sheets[s]! && !c.sections[s]!.deck) {
          c.sections[s]!.deck = GONE;
          this.gone.push([c, "roofDeck", s]);
        }
        const y = t.bay[m]!;
        if (y >= 0 && ++t.raftersMoved[y]! >= t.rafters[y]! && !c.bays[y]!.failed) {
          c.bays[y]!.failed = GONE;
          this.gone.push([c, "roofBay", y]);
        }
      }
      if (changed) t.copy.rev++;
    }
  }

  clear(): void {
    this.houses.clear();
    this.forward.length = 0;
  }
}
