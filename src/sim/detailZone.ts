/**
 * Detail zone in town (Spec 09 slice B).
 *
 * - `ZoneSelector` (runs in the sim, deterministic): which houses enter and leave the zone,
 *   from the tornado state alone.
 * - `DetailEngine` (runs in workers in the app, in-process in tests): one structure world per
 *   street row (Spec 09 performance), stepping the detailed houses in the tornado's wind and
 *   returning what changed.
 * - Message types between them.
 */
import { DETAIL } from "../config/structure";
import type { Building } from "../core/damage/types";
import type { Vec3 } from "../core/math/vec";
import { surveyDetail } from "../core/structure/survey";
import { qconj, qrot } from "../core/structure/framing";
import { pressureDeficit } from "../core/wind/pressure";
import type { TerrainClass, TornadoState } from "../core/wind/types";
import { windAt } from "../core/wind/windField";
import { streetRowOf } from "./city";
import { DetailHouse, StructureWorld } from "./structureWorld";
import type { WindSource } from "./structureWorld";

/** Houses entering and leaving the zone this detail step (indices into the building list). */
export interface ZoneOps {
  enter: number[];
  exit: number[];
}

export class ZoneSelector {
  /** Houses in the zone now. */
  readonly active = new Set<number>();
  /** Houses that have left; they never re-enter. */
  readonly done = new Set<number>();
  private focusKey = "";
  private chosen: number[] = [];

  /** The houses around the detail spot: the N nearest it (ties by index). */
  private around(focus: { x: number; z: number }, buildings: readonly Building[]): number[] {
    const key = `${focus.x},${focus.z},${buildings.length}`;
    if (key !== this.focusKey) {
      this.focusKey = key;
      this.chosen = buildings
        .map((b, i) => [Math.hypot(b.x - focus.x, b.z - focus.z), i] as const)
        .sort((p, q) => p[0] - q[0] || p[1] - q[1])
        .slice(0, DETAIL.maxHouses)
        .map(([, i]) => i);
    }
    return this.chosen;
  }

  /** Distance from the spot to the farthest of its detail houses (m). */
  radius(buildings: readonly Building[], focus: { x: number; z: number } | null): number {
    if (!focus || !buildings.length) return 0;
    const chosen = this.around(focus, buildings);
    return Math.max(0, ...chosen.map((i) => Math.hypot(buildings[i]!.x - focus.x, buildings[i]!.z - focus.z)));
  }

  update(s: TornadoState, buildings: readonly Building[], focus: { x: number; z: number } | null): ZoneOps {
    const ops: ZoneOps = { enter: [], exit: [] };
    const speed = Math.hypot(s.velocity.x, s.velocity.z);
    const alive = s.vMax >= 1;
    // Leave: the tornado has passed (house behind it, beyond R_exit) or has dissipated.
    const exitR = DETAIL.exitRmax * s.rMax;
    for (const i of [...this.active].sort((a, b) => a - b)) {
      const b = buildings[i]!;
      const dx = b.x - s.center.x;
      const dz = b.z - s.center.z;
      const behind = dx * s.velocity.x + dz * s.velocity.z < 0;
      if (!alive || (behind && Math.hypot(dx, dz) > exitR)) {
        this.active.delete(i);
        this.done.add(i);
        ops.exit.push(i);
      }
    }
    if (!alive || !focus) return ops;
    // Enter: houses around the spot, once the tornado is within R_enter, nearest it first.
    const enterR = DETAIL.enterRmax * s.rMax + DETAIL.enterLeadS * speed;
    const cands: [number, number][] = [];
    for (const i of this.around(focus, buildings)) {
      if (this.active.has(i) || this.done.has(i)) continue;
      const b = buildings[i]!;
      const d = Math.hypot(b.x - s.center.x, b.z - s.center.z);
      if (d < enterR) cands.push([d, i]);
    }
    cands.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [, i] of cands) {
      if (this.active.size >= DETAIL.maxHouses || ops.enter.length >= DETAIL.maxEnterPerStep) break;
      this.active.add(i);
      ops.enter.push(i);
    }
    return ops;
  }
}

/** One detail step, in order, from the sim to the engine. */
export interface DetailStep {
  /** Detail step number (0, 1, 2, …). */
  n: number;
  tornado: TornadoState;
  terrain: TerrainClass;
  /** Entering houses with the members their component failures already removed. */
  enter: { index: number; removed: number[] }[];
  exit: number[];
}

/** What changed in one detail step. */
export interface DetailResult {
  n: number;
  /** Changed member poses: [house, member, px, py, pz, qx, qy, qz, qw] × k, house-local
   *  members in world space; lost members have py = −1e4. */
  poses: Float32Array;
  /** Survey changes: [house, dod] × k. */
  dods: Int32Array;
  /** Houses that froze this step, and whether they ended undamaged (back to the component
   *  model's drawing). */
  frozen: { index: number; undamaged: boolean }[];
  /** New connection failures this step (count per house: [house, n] × k). */
  failures: Int32Array;
  /** The new failures themselves (for the inspector). */
  failLog: { house: number; label: string; load: number; capacity: number; mph: number }[];
  /** Wall-clock time the step took (ms), for the status line (not part of the results). */
  ms: number;
  /** Wall-clock time of the costliest physics group's step (ms; not part of the results). */
  groupMs: number;
}

/** Steps the zone's houses: one structure world per street row (physics group). */
export class DetailEngine {
  /** Physics groups by street row, in the order they were created. */
  readonly worlds = new Map<string, StructureWorld>();
  private readonly worldOf = new Map<number, StructureWorld>();
  readonly houses = new Map<number, DetailHouse>();
  private dod = new Map<number, number>();
  private failCount = new Map<number, number>();
  /** Bodies seen last step per house (to report members of newly created bodies). */
  private seen = new Map<number, Set<number>>();
  /** Lost members already reported per house. */
  private lostReported = new Map<number, number>();
  private tornado: TornadoState | null = null;
  private terrain: TerrainClass = "suburban";
  /** Debug: the phase of the group that ran last (for crash reports). */
  phase = "";
  private readonly wind: WindSource = {
    at: (p: Vec3) => (this.tornado ? windAt(p, this.tornado, this.terrain) : { x: 0, y: 0, z: 0 }),
    deficit: (x: number, z: number) =>
      this.tornado ? pressureDeficit(Math.hypot(x - this.tornado.center.x, z - this.tornado.center.z), this.tornado) : 0,
  };

  constructor(private readonly buildings: readonly Building[]) {}

  step(msg: DetailStep): DetailResult {
    const t0 = performance.now();
    this.tornado = msg.tornado;
    this.terrain = msg.terrain;
    const poses: number[] = [];
    const push = (i: number, h: DetailHouse, id: number) => {
      const p = h.memberPose(id);
      poses.push(i, id, p.pos.x, p.pos.y, p.pos.z, p.q[0], p.q[1], p.q[2], p.q[3]);
    };
    for (const e of msg.enter) {
      const b = this.buildings[e.index]!;
      const key = streetRowOf(b);
      let sw = this.worlds.get(key);
      if (!sw) {
        sw = new StructureWorld();
        this.worlds.set(key, sw);
      }
      this.worldOf.set(e.index, sw);
      const h = sw.addHouse(b, removedFlags(e.removed, []), true);
      this.houses.set(e.index, h);
      this.seen.set(e.index, new Set());
      this.dod.set(e.index, 0);
      this.failCount.set(e.index, 0);
      // Members removed or already fallen on entry.
      for (const m of h.framing.members) if (!h.isAttached(m.id)) push(e.index, h, m.id);
    }
    for (const i of msg.exit) {
      const h = this.houses.get(i);
      if (h) h.releasedAt = this.worldOf.get(i)!.time;
    }
    let groupMs = 0;
    for (const sw of this.worlds.values()) {
      const t = performance.now();
      try {
        sw.step(this.wind);
      } finally {
        this.phase = sw.phase;
      }
      groupMs = Math.max(groupMs, performance.now() - t);
    }

    const dods: number[] = [];
    const failures: number[] = [];
    const frozen: { index: number; undamaged: boolean }[] = [];
    const failLog: DetailResult["failLog"] = [];
    for (const [i, h] of this.houses) {
      if (h.frozen) continue;
      const sw = this.worldOf.get(i)!;
      // Poses of everything moving, newly loose or newly lost.
      const seen = this.seen.get(i)!;
      const now = new Set<number>();
      for (const [handle, group] of h.groupBodies) {
        now.add(handle);
        const body = sw.world.getRigidBody(handle);
        if (!seen.has(handle) || !body.isSleeping()) h.bodyPoses(body, group, i, poses);
      }
      // Members lost since last reported (a body left the area or went invalid).
      if (h.lostMembers !== (this.lostReported.get(i) ?? 0)) {
        this.lostReported.set(i, h.lostMembers);
        for (const m of h.framing.members) if (h.lost[m.id]) push(i, h, m.id);
      }
      h.lightPoses(i, poses);
      this.seen.set(i, now);
      // Survey when anything changed.
      const nf = h.failures.length;
      const moved = h.movingGroups > 0;
      // (Survey at 10 Hz while pieces move; at once on new failures.)
      if (nf !== this.failCount.get(i) || (moved && sw.stepCount % 6 === 0)) {
        if (nf !== this.failCount.get(i)) {
          failures.push(i, nf - this.failCount.get(i)!);
          for (const f of h.failures.slice(this.failCount.get(i)!)) failLog.push({ house: i, label: f.label, load: f.load, capacity: f.capacity, mph: f.mph });
        }
        this.failCount.set(i, nf);
        const inv = qconj(houseQ(h.building));
        const d = surveyDetail(
          h.building,
          h.framing,
          h.framing.members.map((m) => h.isAttached(m.id)),
          h.intact,
          (id) => {
            if (h.lost[id]) return null;
            const p = h.memberPose(id).pos;
            return qrot(inv, { x: p.x - h.building.x, y: p.y, z: p.z - h.building.z });
          },
        );
        if (d !== this.dod.get(i)) {
          this.dod.set(i, d);
          dods.push(i, d);
        }
      }
      // Freeze once released and settled (or after the timeout).
      if (h.releasedAt !== null && (!moved || sw.time - h.releasedAt > DETAIL.settleTimeout)) {
        h.freeze();
        frozen.push({ index: i, undamaged: h.failures.length === 0 && !h.lost.some(Boolean) });
      }
    }
    // A group whose houses have all frozen has nothing left to simulate.
    for (const [key, sw] of this.worlds)
      if (sw.houses.every((h) => h.frozen)) {
        sw.dispose();
        this.worlds.delete(key);
      }
    return { n: msg.n, poses: new Float32Array(poses), dods: new Int32Array(dods), frozen, failures: new Int32Array(failures), failLog, ms: performance.now() - t0, groupMs };
  }

  dispose(): void {
    for (const sw of this.worlds.values()) sw.dispose();
    this.worlds.clear();
  }
}

function removedFlags(ids: number[], into: boolean[]): boolean[] | undefined {
  if (!ids.length) return undefined;
  for (const id of ids) into[id] = true;
  return into;
}

function houseQ(b: Building): [number, number, number, number] {
  return [0, Math.sin(b.yaw / 2), 0, Math.cos(b.yaw / 2)];
}
