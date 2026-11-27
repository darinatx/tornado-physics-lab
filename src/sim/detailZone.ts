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
import type { TornadoState } from "../core/wind/types";
import { TerrainCache } from "../core/terrain/roughness";
import type { Terrain, TerrainMsg } from "../core/terrain/roughness";
import { windAt } from "../core/wind/windField";
import { CITY, streetRowOf } from "./city";
import { LOCAL_NORMALS } from "../core/damage/layout";
import { buildTownColliders, townCopy } from "./townColliders";
import type { TownState } from "./townColliders";

/** Validation scripts only: give each detailed house its own physics world (no neighbor hits),
 *  to measure how much a street row's shared debris adds to the damage. */
export const detailOptions = { worldPerHouse: false };
import { DetailHouse, StructureWorld } from "./structureWorld";
import type { TownHit } from "./structureWorld";
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

  /** @param maxHouses How many houses the zone takes (DETAIL.maxHouses; fewer in fast tests).
   *  @param fixed Exactly these houses, wherever the spot is (the wind tunnel, Spec 12). */
  constructor(
    private readonly maxHouses: number = DETAIL.maxHouses,
    private readonly fixed?: readonly number[],
    /** The fixed houses enter at once, whatever the tornado does, and never leave (the lab). */
    private readonly pinned = false,
  ) {}

  /** The houses around the detail spot: the N nearest it (ties by index). */
  private around(focus: { x: number; z: number }, buildings: readonly Building[]): number[] {
    if (this.fixed) return [...this.fixed];
    const key = `${focus.x},${focus.z},${buildings.length}`;
    if (key !== this.focusKey) {
      this.focusKey = key;
      this.chosen = buildings
        .map((b, i) => [Math.hypot(b.x - focus.x, b.z - focus.z), i] as const)
        .sort((p, q) => p[0] - q[0] || p[1] - q[1])
        .slice(0, this.maxHouses)
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
    if (this.pinned && this.fixed) {
      if (focus) for (const i of this.fixed) if (!this.active.has(i)) (this.active.add(i), ops.enter.push(i));
      return ops;
    }
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
      if ((!this.fixed && this.active.size >= this.maxHouses) || ops.enter.length >= DETAIL.maxEnterPerStep) break;
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
  terrain: TerrainMsg;
  /** Entering houses with the members their component failures already removed, and the
   *  physics group to put them in (default: their street row). */
  enter: { index: number; removed: number[]; group?: string }[];
  /** Launches (Spec 12): members of a house sent flying as one free body. */
  launches?: DetailLaunch[];
  exit: number[];
  /** Houses around the zone whose state changed since last sent (Spec 10 v0.6). */
  town?: TownState[];
  /** Houses whose connection loads to send back (Spec 13 member inspector). */
  inspect?: readonly number[];
  /** The town's debris hitting detailed houses (Spec 10 slice B): pane breaks and wall pushes. */
  debrisHits?: { index: number; surface: string; component: number; face: number; broke: boolean; perforated?: boolean; force: number; coverTorn?: boolean; sidingTorn?: boolean; at?: Vec3 }[];
}

/** A launch in the detail zone (Spec 12): house `index`'s `members` become one free body whose
 *  center is at `center`, moving at `vel` (m/s) and spinning at `spin` (rad/s), turned so the
 *  group's longest axis lies along `axis` if given. */
export interface DetailLaunch {
  index: number;
  members: number[];
  center: Vec3;
  vel: Vec3;
  spin: Vec3;
  axis?: Vec3;
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
  failLog: { house: number; label: string; load: number; capacity: number; mph: number; con: number }[];
  /** Asked-for houses' connection loads (N) and attached members (1/0) this step (Spec 13). */
  inspect?: { house: number; loads: Float32Array; attached: Uint8Array }[];
  /** Hits on houses around the zone this step (Spec 10 slice B), in order. */
  townHits: TownHit[];
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
  private terrain: Terrain = "suburban";
  private readonly terrains = new TerrainCache();
  /** Debug: the phase of the group that ran last (for crash reports). */
  phase = "";
  private readonly wind: WindSource = {
    at: (p: Vec3) => (this.tornado ? windAt(p, this.tornado, this.terrain) : { x: 0, y: 0, z: 0 }),
    deficit: (x: number, z: number) =>
      this.tornado ? pressureDeficit(Math.hypot(x - this.tornado.center.x, z - this.tornado.center.z), this.tornado) : 0,
  };

  /** The engine's copies of the houses around the zone (never the sim's objects), a grid of
   *  them for light pieces, and a version per house that increases with each new state. */
  private readonly town = new Map<number, Building>();
  private readonly townGrid = new Map<string, Building[]>();
  private readonly townIndex = new Map<Building, number>();
  private readonly townVersion = new Map<number, number>();
  /** Per physics group: the version of each house its stand-ins were built from. */
  private readonly builtVersion = new WeakMap<StructureWorld, Map<number, number>>();

  constructor(private readonly buildings: readonly Building[]) {}

  private townNear = (x: number, z: number): readonly Building[] =>
    this.townGrid.get(`${Math.floor(x / CITY.cell)},${Math.floor(z / CITY.cell)}`) ?? NONE;

  /** Apply house states from the sim (Spec 10 v0.6). */
  private applyTown(states: readonly TownState[]): void {
    for (const st of states) {
      const had = this.town.get(st.index);
      const c = townCopy(this.buildings[st.index]!, st, had);
      if (!had) {
        this.town.set(st.index, c);
        this.townIndex.set(c, st.index);
        const r = Math.hypot(c.width, c.depth) / 2 + 3;
        for (let i = Math.floor((c.x - r) / CITY.cell); i <= Math.floor((c.x + r) / CITY.cell); i++)
          for (let j = Math.floor((c.z - r) / CITY.cell); j <= Math.floor((c.z + r) / CITY.cell); j++) {
            const k = `${i},${j}`;
            const list = this.townGrid.get(k);
            if (list) list.push(c);
            else this.townGrid.set(k, [c]);
          }
      }
      this.townVersion.set(st.index, (this.townVersion.get(st.index) ?? 0) + 1);
    }
  }

  /** Hook a new physics group up to the houses around the zone. */
  private attachTown(sw: StructureWorld): void {
    const built = new Map<number, number>();
    this.builtVersion.set(sw, built);
    sw.townNear = this.townNear;
    const build = (i: number, c: Building) => {
      const old = sw.townColliders.get(i);
      if (old) sw.removeTownColliders(old);
      const cols = buildTownColliders(sw.world, c, sw.townPlaneOf);
      for (const col of cols) sw.townHouseOf.set(col.handle, { x: c.x, z: c.z, index: i, b: c });
      sw.townColliders.set(i, cols);
      built.set(i, this.townVersion.get(i) ?? 0);
    };
    // Pieces that fly farther than the houses built up front: build what's around them.
    sw.ensureTown = (x, z) => {
      for (const c of this.townNear(x, z)) {
        const i = this.townIndex.get(c)!;
        if (sw.townColliders.has(i) || sw.houses.some((h) => h.building.id === c.id)) continue;
        if (Math.hypot(x - c.x, z - c.z) > Math.hypot(c.width, c.depth) / 2 + 30) continue;
        build(i, c);
      }
    };
    // Changes are applied just before the physics step: Rapier's queries only see added or
    // removed colliders after a step, so rebuilding earlier would leave a one-step gap.
    // The houses this group watches: within reach of its own houses (found when its houses
    // change) and any it has built stand-ins for.
    let reachFor = -1;
    let reach: number[] = [];
    sw.beforePhysics = () => {
      if (reachFor !== sw.houses.length) {
        reachFor = sw.houses.length;
        const set = new Set<number>();
        for (const h of sw.houses)
          for (let gx = -1; gx <= 1; gx++)
            for (let gz = -1; gz <= 1; gz++)
              for (const c of this.townNear(h.building.x + gx * CITY.cell * 2, h.building.z + gz * CITY.cell * 2)) {
                if (Math.hypot(h.building.x - c.x, h.building.z - c.z) < DETAIL.townReach) set.add(this.townIndex.get(c)!);
              }
        reach = [...set].sort((a, b) => a - b);
      }
      const watch = new Set<number>(reach);
      for (const i of sw.townColliders.keys()) watch.add(i);
      for (const i of [...watch].sort((a, b) => a - b)) {
        const c = this.town.get(i)!;
        const own = sw.houses.find((h) => h.building.id === c.id);
        if (own) {
          // One of this world's own houses: its stand-ins go once its members are all built.
          const old = own.complete ? sw.townColliders.get(i) : undefined;
          if (old) {
            sw.removeTownColliders(old);
            sw.townColliders.delete(i);
          }
          continue;
        }
        const has = sw.townColliders.has(i);
        if (has && built.get(i) === this.townVersion.get(i)) continue;
        build(i, c);
      }
    };
  }

  step(msg: DetailStep): DetailResult {
    const t0 = performance.now();
    this.tornado = msg.tornado;
    this.terrain = this.terrains.resolve(msg.terrain);
    for (const sw of this.worlds.values()) {
      sw.terrain = this.terrain;
      sw.roofFactor = msg.tornado.tunnel ? 1 : DETAIL.tornadoRoofFactor;
    }
    if (msg.town?.length) this.applyTown(msg.town);
    const poses: number[] = [];
    const push = (i: number, h: DetailHouse, id: number) => {
      const p = h.memberPose(id);
      poses.push(i, id, p.pos.x, p.pos.y, p.pos.z, p.q[0], p.q[1], p.q[2], p.q[3]);
    };
    for (const e of msg.enter) {
      const b = this.buildings[e.index]!;
      const key = detailOptions.worldPerHouse ? `house:${e.index}` : (e.group ?? streetRowOf(b));
      let sw = this.worlds.get(key);
      if (!sw) {
        sw = new StructureWorld();
        sw.terrain = this.terrain;
        sw.roofFactor = msg.tornado.tunnel ? 1 : DETAIL.tornadoRoofFactor;
        this.attachTown(sw);
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
    // The town's debris hitting detailed houses: a broken pane breaks; a push on a wall loads
    // that wall's frame (as a contact force, through the load path).
    for (const d of msg.debrisHits ?? []) {
      const h = this.houses.get(d.index);
      if (!h || h.frozen) continue;
      const b = h.building;
      // A perforation is a hole in the envelope (Spec 10 v0.12): face 0–3, or 4 for the roof.
      if (d.perforated) h.addHole(d.face);
      // The attached member of a kind nearest the hit point (house-local), within `reach` m.
      const house = h;
      const nearest = (ok: (m: (typeof house.framing.members)[number]) => boolean, reach: number) => {
        if (!d.at) return undefined;
        let best: number | undefined;
        let bd = reach;
        for (const m of house.framing.members) {
          if (!ok(m) || !house.isAttached(m.id)) continue;
          const dd = Math.hypot(m.pos.x - d.at.x, m.pos.y - d.at.y, m.pos.z - d.at.z);
          if (dd < bd) (bd = dd), (best = m.id);
        }
        return best;
      };
      // Torn cladding (Spec 10 v0.17): the shingle patch or siding course hit loses its fasteners.
      if (d.surface === "roof" && d.coverTorn) {
        const id = nearest((m) => m.kind === "roofShingle", 1.5);
        if (id !== undefined) h.tearOff(id);
      }
      if ((d.surface === "wall" || d.surface === "gable") && d.sidingTorn) {
        const id = nearest((m) => m.kind === "siding" && m.face === d.face, 1.5);
        if (id !== undefined) h.tearOff(id);
      }
      // A roof hit pushes on the sheathing panel it struck, inward along the roof's normal.
      if (d.surface === "roof" && d.force > 0) {
        const id = nearest((m) => m.kind === "roofSheet", 2);
        if (id !== undefined) {
          const n = h.framing.members[id]!.normal;
          const c = Math.cos(b.yaw);
          const sn = Math.sin(b.yaw);
          h.addContact(id, -(n.x * c + n.z * sn) * d.force, -n.y * d.force, -(-n.x * sn + n.z * c) * d.force);
        }
        continue;
      }
      if (d.surface === "pane" && d.broke) {
        const panel = b.panes[d.component]?.panel;
        const shard = h.framing.members.find((m) => m.kind === "pane" && m.panel === panel && h.isAttached(m.id));
        if (shard) h.hitGlass(shard.id, Infinity, "compact");
      } else if (d.force > 0 && (d.surface === "wall" || d.surface === "gable" || d.surface === "garage")) {
        const kind = d.surface === "gable" ? "gableFrame" : "wallFrame";
        const m = h.framing.members.find((q) => q.kind === kind && (kind === "gableFrame" ? q.face === d.face : q.panel === d.component) && h.isAttached(q.id));
        if (!m) continue;
        // Inward, along the face's normal (house-local → world).
        const n = LOCAL_NORMALS[d.face]!;
        const c = Math.cos(b.yaw);
        const sn = Math.sin(b.yaw);
        h.addContact(m.id, -(n.x * c + n.z * sn) * d.force, 0, -(-n.x * sn + n.z * c) * d.force);
      }
    }
    // Launches (Spec 12), for the houses this engine has.
    for (const l of msg.launches ?? []) this.houses.get(l.index)?.launch(l.members, l.center, l.vel, l.spin, l.axis);
    let groupMs = 0;
    const townHits: TownHit[] = [];
    for (const sw of this.worlds.values()) {
      const t = performance.now();
      try {
        sw.step(this.wind);
      } finally {
        this.phase = sw.phase;
      }
      groupMs = Math.max(groupMs, performance.now() - t);
      townHits.push(...sw.townHits);
      sw.townHits.length = 0;
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
          for (const f of h.failures.slice(this.failCount.get(i)!)) failLog.push({ house: i, label: f.label, load: f.load, capacity: f.capacity, mph: f.mph, con: f.con });
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
      // Freeze once released and settled, or after the timeout once every piece is down and
      // only creeping (one the wind keeps nudging may stop where it is; one in flight, falling
      // or toppling must come down first).
      let creeping = false;
      if (h.releasedAt !== null && moved && sw.time - h.releasedAt > DETAIL.settleTimeout) {
        if (h.unsettled()) h.creepSince = null;
        else h.creepSince ??= sw.time;
        creeping = h.creepSince !== null && sw.time - h.creepSince >= DETAIL.creepForS - 1e-9;
      }
      if (h.releasedAt !== null && (!moved || creeping)) {
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
    const inspect: NonNullable<DetailResult["inspect"]> = [];
    for (const i of msg.inspect ?? []) {
      const h = this.houses.get(i);
      if (!h) continue;
      inspect.push({ house: i, loads: h.conLoad.slice(), attached: Uint8Array.from(h.framing.members, (m) => (h.isAttached(m.id) ? 1 : 0)) });
    }
    return { n: msg.n, poses: new Float32Array(poses), dods: new Int32Array(dods), frozen, failures: new Int32Array(failures), failLog, townHits, ms: performance.now() - t0, groupMs, ...(inspect.length ? { inspect } : {}) };
  }

  /** The physics world a house is in (tests and the wind tunnel). */
  worldFor(index: number): StructureWorld | undefined {
    return this.worldOf.get(index);
  }

  dispose(): void {
    for (const sw of this.worlds.values()) sw.dispose();
    this.worlds.clear();
  }
}

const NONE: readonly Building[] = [];

function removedFlags(ids: number[], into: boolean[]): boolean[] | undefined {
  if (!ids.length) return undefined;
  for (const id of ids) into[id] = true;
  return into;
}

function houseQ(b: Building): [number, number, number, number] {
  return [0, Math.sin(b.yaw / 2), 0, Math.cos(b.yaw / 2)];
}
