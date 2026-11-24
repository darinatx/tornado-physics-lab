/**
 * Member-level structural physics (Spec 09): one shared Rapier world holding any number of
 * detailed houses. Each house's intact structure is a fixed body; members that lose every path
 * to the slab become dynamic compound bodies. Contact forces from impacts (with the ground,
 * other pieces, or other houses) feed back into connection checks.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import { AIR_DENSITY, GRAVITY } from "../config/atmosphere";
import { APC_TAU, CP, CPI, CP_FREESTANDING } from "../config/buildings";
import { DETAIL, FRAMING_DRAG_CD, LUMBER, PLATE, ROOF_MWFRS, SLAB_TOP } from "../config/structure";
import { faceCp, faceNormal } from "../core/damage/loads";
import type { Building } from "../core/damage/types";
import { plateExtent, plateForce, pressureForce } from "../core/structure/aero";
import { buildFraming, floorPlan, qconj, qmul, qrot, shapePoints, shapeVolume } from "../core/structure/framing";
import type { Framing, Q } from "../core/structure/framing";
import { inertialRelief } from "../core/structure/inertia";
import { attachedToSlab, groupsOf, solveLoadPath } from "../core/structure/loadpath";
import type { Vec3 } from "../core/math/vec";
import { msToMph } from "../core/wind/efScale";
import { sheet } from "../config/debris";
import { flatten as flattenPiece, stepPiece, wakeIfForced } from "../core/debris/piece";
import type { Piece } from "../core/debris/piece";

export interface StructureFailure {
  time: number;
  label: string;
  member: string;
  load: number;
  capacity: number;
  /** Wind at the house's roof height when it failed (mph). */
  mph: number;
}

export interface MemberPose {
  pos: Vec3;
  q: Q;
}

/** Where the wind comes from: a steady profile (lab) or the tornado field (town). */
export interface WindSource {
  /** Ground-relative wind at a world point (m/s, world axes, including any vertical part). */
  at(p: Vec3): Vec3;
  /** Atmospheric pressure deficit at a ground position (Pa); 0 for straight-line wind. */
  deficit(x: number, z: number): number;
}

let rapierReady: Promise<void> | null = null;
export function initRapier(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

export const STRUCT_DT = 1 / 60;
/** Cap on body spin (rad/s): real tumbling debris spins a few to ~30 rad/s. */
const MAX_SPIN = 40;
/** Friction coefficient for loose pieces (wood on wood / ground), also set on every collider. */
const REST_FRICTION = 0.6;
/**
 * Effective duration of a wood-on-wood impact (s). Rapier resolves a collision within one
 * 1/60 s step; real framing crushes and flexes over ~0.05–0.15 s, so the same momentum change
 * means a several-times-lower peak force.
 */
const IMPACT_DURATION = 0.1;
/** In-flight breakup checks run every N steps (15 Hz). */
const IN_FLIGHT_EVERY = 4;
/** Ground half-size (m); pieces beyond it are retired. */
export const GROUND_HALF = 10000;

const rot = (q: Q) => ({ x: q[0], y: q[1], z: q[2], w: q[3] });

/** The shared physics world. */
export class StructureWorld {
  readonly world: RAPIER.World;
  readonly events: RAPIER.EventQueue;
  readonly houses: DetailHouse[] = [];
  /** Collider handle → owning house and member. */
  readonly owner = new Map<number, { house: DetailHouse; id: number }>();
  /** Body handle → creation time (impacts are ignored while a piece separates). */
  readonly bornAt = new Map<number, number>();
  time = 0;
  stepCount = 0;
  /** Debug: which phase of the step is running (for crash reports). */
  phase = "";

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = STRUCT_DT;
    this.events = new RAPIER.EventQueue(true);
    // Thick ground so fast debris can't cross more than half of it in one step and pop out below.
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(GROUND_HALF, 20, GROUND_HALF).setTranslation(0, -20, 0).setFriction(0.8));
  }

  /** Add a detailed house; `removed` members (already failed in the component model) are left out. */
  addHouse(b: Building, removed?: readonly boolean[]): DetailHouse {
    const h = new DetailHouse(this, b, removed);
    this.houses.push(h);
    return h;
  }

  step(wind: WindSource): void {
    this.phase = "loads";
    for (const h of this.houses) if (!h.frozen) h.loads(wind);
    this.phase = "groups";
    for (const h of this.houses) if (!h.frozen) h.checkGroups();
    this.phase = "aero";
    for (const h of this.houses) if (!h.frozen) h.aero(wind);
    for (const h of this.houses) if (!h.frozen) h.stepLight(wind);

    // Physics step; collect impact forces for the next step's checks.
    for (const h of this.houses) if (!h.frozen) h.clearContacts();
    this.phase = "world.step";
    this.world.step(this.events);
    this.phase = "events";
    // Impacts: only between a moving piece and something else, ignoring a piece's first half
    // second (it's separating from where it was attached) and forces near its own weight
    // (resting contact).
    const soften = STRUCT_DT / IMPACT_DURATION;
    this.events.drainContactForceEvents((e) => {
      const raw = e.totalForce();
      const dir = { x: raw.x * soften, y: raw.y * soften, z: raw.z * soften };
      const mag = e.totalForceMagnitude() * soften;
      const bodies = [e.collider1(), e.collider2()].map((h) => this.world.getCollider(h)?.parent());
      const young = bodies.some((b) => b && this.time - (this.bornAt.get(b.handle) ?? -1e9) < 0.5);
      if (young) return;
      // Rapier reports the force on collider 2; collider 1 gets the equal and opposite force.
      const pairs: [number, number][] = [
        [e.collider1(), -1],
        [e.collider2(), 1],
      ];
      for (const [h, sign] of pairs) {
        const o = this.owner.get(h);
        if (!o) continue;
        const m = o.house.framing.members[o.id]!;
        if (mag < 5 * m.mass * GRAVITY) continue;
        o.house.addContact(o.id, sign * dir.x, sign * dir.y, sign * dir.z);
      }
    });
    this.time += STRUCT_DT;
    this.stepCount++;
  }

  dispose(): void {
    this.world.free();
    this.events.free();
  }
}

/** One detailed house in the shared world. */
export class DetailHouse {
  readonly framing: Framing;
  readonly intact: boolean[];
  readonly failures: StructureFailure[] = [];
  /** Members retired with their body (left the area, invalid state, or removed on entry). */
  readonly lost: boolean[];
  /** Members dropped because their body's state became invalid (should stay 0). */
  lostMembers = 0;
  readonly lostWhy: Record<string, number> = {};
  /** Body handle → members, for the house's loose pieces. */
  readonly groupBodies = new Map<number, number[]>();
  /** Frozen: final state kept, no more physics. */
  frozen = false;
  /** Sim time the house left the zone (its pieces settle, then it freezes), or null. */
  releasedAt: number | null = null;
  /** Roof-height wind at the last step (mph), and whether the last load solve was skipped. */
  refMph = 0;
  calmSkipped = false;
  /** Inside pressure deficit (APC venting lag, Pa) and the last outward APC push (Pa). */
  deficitIn = 0;
  apc = 0;
  private apcStarted = false;
  private attached: boolean[];
  private contact: Vec3[];
  private touched = false;
  /** Last aerodynamic force on each member of a moving group (world axes). */
  private aeroForce: Vec3[];
  /** In-plane axes and extents of plate-like members, for rotational drag. */
  private plateExtent: ({ a: Vec3; b: Vec3; la: number; lb: number } | null)[];
  private readonly houseQ: Q;
  private readonly body: RAPIER.RigidBody;
  private slab: RAPIER.Collider | null;
  /** Body each member currently belongs to. */
  private bodyOf: (RAPIER.RigidBody | null)[] = [];
  private frozenPose: MemberPose[] | null = null;
  /** Scratch force array for in-flight checks (indexed by member id; only a group's entries are used). */
  private readonly groupForces: Vec3[] = [];
  /** Light members flying on the Spec 04 debris model: the piece, the rotation from member to
   *  piece axes, and the member-local center of the piece's box. */
  readonly light = new Map<number, LightPiece>();
  /** Member → the light piece carrying it. */
  private readonly lightOf = new Map<number, LightPiece>();

  constructor(
    private readonly sw: StructureWorld,
    readonly building: Building,
    removed?: readonly boolean[],
  ) {
    this.framing = buildFraming(building);
    const f = this.framing;
    this.intact = f.connections.map(() => true);
    this.attached = f.members.map(() => true);
    this.lost = f.members.map(() => false);
    this.contact = f.members.map(() => ({ x: 0, y: 0, z: 0 }));
    this.aeroForce = f.members.map(() => ({ x: 0, y: 0, z: 0 }));
    this.plateExtent = f.members.map((m) => (m.area > 0 || (m.plate ?? 0) > 0 ? plateExtent(m.shapes) : null));
    this.houseQ = [0, Math.sin(building.yaw / 2), 0, Math.cos(building.yaw / 2)];
    const world = sw.world;
    this.slab = world.createCollider(
      // Slab edge flush with the wall frames' outer face.
      RAPIER.ColliderDesc.cuboid((building.width + LUMBER.stud[1]) / 2, SLAB_TOP / 2, (building.depth + LUMBER.stud[1]) / 2)
        .setTranslation(building.x, SLAB_TOP / 2, building.z)
        .setRotation(rot(this.houseQ))
        .setFriction(0.8),
    );
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(building.x, 0, building.z).setRotation(rot(this.houseQ)));
    // Members already gone (component-model failures before entry) are left out entirely.
    if (removed)
      for (const m of f.members)
        if (removed[m.id]) {
          this.lost[m.id] = true;
          this.attached[m.id] = false;
          for (const c of f.supportsOf[m.id]!) this.intact[c] = false;
          for (const c of f.carriesOf[m.id]!) this.intact[c] = false;
        }
    for (const m of f.members) {
      if (this.lost[m.id]) {
        this.bodyOf[m.id] = null;
        continue;
      }
      this.addColliders(m.id, this.body);
    }
    // Anything left without support falls now.
    if (removed) this.detach();
  }

  /** Attach member `id`'s shapes to `body` (body-local frame = house-local frame). */
  private addColliders(id: number, body: RAPIER.RigidBody): void {
    const m = this.framing.members[id]!;
    // Each collider gets its share of the member's real mass (set directly: the colliders are
    // slightly shrunk for clearance, so a density would understate thin parts' mass).
    const vol = m.collision.reduce((a, s) => a + shapeVolume(s), 0);
    const dynamic = body.isDynamic();
    for (const s of m.collision) {
      const p = qrot(m.q, s.pos);
      const q = qmul(m.q, s.q);
      // 5 mm clearance so neighboring parts don't overlap once one of them comes loose; only
      // 1 mm through a thin part's thickness, or sheets and glass collide paper-thin and jitter.
      const he = (v: number) => (v < 0.05 ? Math.max(v / 2 - 0.0005, 0.002) : Math.max(v / 2 - 0.005, 0.002));
      let desc: RAPIER.ColliderDesc;
      if (s.tri) {
        // Triangular prism: convex hull of its corners, in body-local coordinates.
        const pts = shapePoints({ ...s, pos: { x: 0, y: 0, z: 0 }, q: [0, 0, 0, 1] });
        const kz = he(s.size[2]) / (s.size[2] / 2);
        const flat = new Float32Array(pts.flatMap((v) => [v.x * 0.995, v.y * 0.995, v.z * kz]));
        desc = RAPIER.ColliderDesc.convexHull(flat) ?? RAPIER.ColliderDesc.cuboid(he(s.size[0]), he(s.size[1]), he(s.size[2]));
      } else {
        desc = RAPIER.ColliderDesc.cuboid(he(s.size[0]), he(s.size[1]), he(s.size[2]));
      }
      desc
        .setTranslation(m.pos.x + p.x, m.pos.y + p.y, m.pos.z + p.z)
        .setRotation(rot(q))
        .setMass((m.mass * shapeVolume(s)) / vol)
        .setFriction(REST_FRICTION)
        .setRestitution(0.1);
      // Impact reporting only on moving pieces (a pair reports if either collider asks).
      if (dynamic) desc.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(500);
      const col = this.sw.world.createCollider(desc, body);
      this.sw.owner.set(col.handle, { house: this, id });
    }
    this.bodyOf[id] = body;
  }

  /** World pose of a member (for rendering); lost members are parked far below ground. */
  memberPose(id: number): MemberPose {
    if (this.lost[id]) return { pos: { x: 0, y: -1e4, z: 0 }, q: [0, 0, 0, 1] };
    if (this.frozenPose) return this.frozenPose[id]!;
    const m = this.framing.members[id]!;
    const lt = this.lightOf.get(id);
    if (lt) {
      // The group's frame (house-local axes, like any loose body): orientation = piece
      // orientation ⊗ (house-local → piece axes); origin back from the box center.
      const qb = qmul(lt.piece.q, lt.r);
      const off = qrot(qb, lt.c);
      const p = qrot(qb, m.pos);
      return { pos: { x: lt.piece.pos.x - off.x + p.x, y: lt.piece.pos.y - off.y + p.y, z: lt.piece.pos.z - off.z + p.z }, q: qmul(qb, m.q) };
    }
    const body = this.bodyOf[id]!;
    const t = body.translation();
    const r = body.rotation();
    // Every body's local frame is house-local (dynamic bodies start at the house's pose).
    const bq: Q = [r.x, r.y, r.z, r.w];
    const p = qrot(bq, m.pos);
    return { pos: { x: t.x + p.x, y: t.y + p.y, z: t.z + p.z }, q: qmul(bq, m.q) };
  }

  isAttached(id: number): boolean {
    return this.attached[id]!;
  }

  /** Does any envelope opening exist (a detached envelope member)? */
  private breached(): boolean {
    // Once open, always open: cache it (checked every step for every house).
    if (this.wasBreached) return true;
    for (const m of this.framing.members)
      if (!this.attached[m.id] && this.isEnvelope(m.id)) {
        this.wasBreached = true;
        return true;
      }
    return false;
  }
  private wasBreached = false;

  private isEnvelope(id: number): boolean {
    const m = this.framing.members[id]!;
    // Lost shingles leave the deck in place, and interior walls and doors aren't envelope.
    return m.area > 0 && m.kind !== "roofShingle" && m.kind !== "siding" && !(m.face < 0 && (m.kind === "partition" || m.kind === "door"));
  }

  /** Internal pressure coefficient from openings left by detached wall/roof members. */
  private internalCp(cpFace: number[]): number {
    let area = 0;
    let sum = 0;
    for (const m of this.framing.members) {
      if (this.attached[m.id] || !this.isEnvelope(m.id)) continue;
      area += m.area;
      sum += m.area * (m.face >= 0 ? cpFace[m.face]! : CP.roofAverage);
    }
    return area > 0 ? CPI.dominantOpeningFactor * (sum / area) : CPI.enclosed;
  }

  /** Wind at roof height over the house: the reference for envelope pressures (as Spec 02). */
  private reference(wind: WindSource): Vec3 {
    const b = this.building;
    return wind.at({ x: b.x, y: b.roofHeight, z: b.z });
  }

  /**
   * Forces on attached members, in house-local axes (the frame connection axes use).
   * `local` = component-and-cladding pressures (corner/field peaks) for checking fasteners of
   * small elements; otherwise area-averaged (main-structure) pressures for the framing.
   * `apc` = outward push of the atmospheric pressure change (Pa) on every envelope member.
   */
  attachedForces(local: boolean, w10: Vec3, apc = 0): Vec3[] {
    const b = this.building;
    const q = 0.5 * AIR_DENSITY * (w10.x * w10.x + w10.z * w10.z);
    const u = { x: w10.x, z: w10.z };
    const cpFace = [0, 1, 2, 3].map((k) => faceCp(u, faceNormal(b.yaw, k)));
    const cpi = this.internalCp(cpFace);
    const f = this.framing;
    // Is the envelope mostly gone? Then interior walls take wind like free-standing walls.
    let wallArea = 0;
    let wallLost = 0;
    for (const m of f.members)
      if (m.kind === "wallSheet") {
        wallArea += m.area;
        if (!this.attached[m.id]) wallLost += m.area;
      }
    // Open house (Spec 03's rule): half the walls or half the roof deck gone. Then interior
    // walls, and the exterior walls still standing, take wind like free-standing walls.
    let deckArea = 0;
    let deckLost = 0;
    for (const m of f.members)
      if (m.kind === "roofSheet") {
        deckArea += m.area;
        if (!this.attached[m.id]) deckLost += m.area;
      }
    const open = wallLost > 0.5 * wallArea || deckLost > 0.5 * deckArea;
    const wh = Math.hypot(w10.x, w10.z);
    // Main-structure roof pressures by slope and wind angle (ASCE 7 MWFRS, Spec 09 v0.7).
    const ul = qrot(qconj(this.houseQ), { x: w10.x, y: 0, z: w10.z });
    const roofCp = (m: { pos: Vec3 }) => roofMwfrsCp(m.pos, ul, b.width, b.roofHeight);
    const uh = wh > 1e-9 ? { x: ul.x / wh, y: 0, z: ul.z / wh } : null;
    // Interior walls still standing, by group (box action needs at least two).
    let coreStanding = 0;
    let otherStanding = 0;
    for (const m of f.members)
      if (m.kind === "partition" && this.attached[m.id] && m.wall !== undefined) {
        if (this.plan[m.wall]?.core) coreStanding++;
        else otherStanding++;
      }
    return f.members.map((m) => {
      const g: Vec3 = { x: 0, y: -m.mass * GRAVITY, z: 0 };
      if (!this.attached[m.id]) return g;
      if (m.area <= 0) {
        // Exposed framing in an opened-up house: drag on its lumber.
        if (!open || !uh || (m.kind !== "wallFrame" && m.kind !== "rafterPair" && m.kind !== "gableFrame")) return g;
        const A = this.lumberArea(m.id);
        const u = qrot(qconj(m.q), uh); // wind direction in the member's axes
        const k = q * FRAMING_DRAG_CD;
        const fl = qrot(m.q, { x: k * A.x * u.x * Math.abs(u.x), y: k * A.y * u.y * Math.abs(u.y), z: k * A.z * u.z * Math.abs(u.z) });
        return { x: g.x + fl.x, y: g.y + fl.y, z: g.z + fl.z };
      }
      const n = m.normal;
      let area = m.area;
      let net: number;
      if (m.kind === "partition" || (m.kind === "door" && m.face < 0)) {
        if (wh < 1e-9 || wallLost <= 0) return g;
        // Free-standing wall, sheltered by what's left of the exterior: wind reaches it in
        // proportion to the exterior wall that's gone (the bathroom box is sheltered more).
        const nw = qrot(this.houseQ, n);
        const c = (w10.x * nw.x + w10.z * nw.z) / wh;
        const core = m.wall !== undefined && !!this.plan[m.wall]?.core;
        const box = (core ? coreStanding : otherStanding) >= 2 ? DETAIL.interiorBoxShare : 1;
        const reach = (wallLost / wallArea) * box * (core ? DETAIL.coreShelter : 1);
        net = -q * CP_FREESTANDING * c * reach; // positive c: wind blows along +n, pushing the wall that way
      } else if (m.kind === "roofShingle") {
        net = -q * (-(local ? (m.edge ? CP.coverEdge : CP.coverField) : roofCp(m)) + cpi) - apc;
      } else if (m.kind === "roofSheet") {
        // Wind acts on the deck only where its shingles are gone.
        const covered = f.carriesOf[m.id]!.reduce((a, c) => {
          const s = f.connections[c]!.from;
          return a + (this.attached[s] && f.members[s]!.kind === "roofShingle" ? f.members[s]!.area : 0);
        }, 0);
        area = Math.max(m.area - covered, 0);
        if (area <= 0) return g;
        net = -q * (-(local ? (m.edge ? CP.deckEdge : CP.deckField) : roofCp(m)) + cpi) - apc;
      } else if (open && m.face >= 0 && m.kind !== "siding") {
        // A standing piece of an opened-up house: free-standing wall loads.
        if (wh < 1e-9) return g;
        const nw = qrot(this.houseQ, n);
        const c = (w10.x * nw.x + w10.z * nw.z) / wh;
        net = -q * CP_FREESTANDING * c;
      } else if (m.kind === "siding") {
        // Vented cavity behind it: outside pressure only.
        net = q * cpFace[m.face]!;
      } else if (m.face >= 0) {
        if (m.kind === "wallSheet") {
          // Wind acts on the sheathing only where its siding is gone.
          const covered = f.carriesOf[m.id]!.reduce((a, c) => {
            const s = f.connections[c]!.from;
            return a + (this.attached[s] && f.members[s]!.kind === "siding" ? f.members[s]!.area : 0);
          }, 0);
          area = Math.max(m.area - covered, 0);
          if (area <= 0) return g;
        }
        net = q * (cpFace[m.face]! - cpi) - apc; // + pushes in; APC pushes out
      } else {
        return g;
      }
      const pf = pressureForce(net, n, area);
      return { x: g.x + pf.x, y: g.y + pf.y, z: g.z + pf.z };
    });
  }

  private fail(c: number, load: number): void {
    const con = this.framing.connections[c]!;
    if (!this.intact[c]) return;
    this.intact[c] = false;
    // Glass: once any part of a pane cracks, the whole pane breaks into its shards.
    const pane = this.framing.members[con.from]!.pane;
    if (pane !== undefined)
      for (const m of this.framing.members)
        if (m.pane === pane && m.id !== con.from) for (const s of this.framing.supportsOf[m.id]!) if (this.intact[s]) this.intact[s] = false;
    this.failures.push({
      time: this.sw.time,
      label: con.label,
      member: this.framing.members[con.from]!.kind,
      load,
      capacity: con.capacity,
      mph: this.refMph,
    });
  }

  /** Turn newly unsupported members into dynamic bodies, grouped by remaining connections. */
  private detach(): void {
    const att = attachedToSlab(this.framing, this.intact);
    const loose = this.framing.members.filter((m) => this.attached[m.id] && !att[m.id] && !this.lost[m.id]).map((m) => m.id);
    for (const m of this.framing.members) if (this.lost[m.id]) att[m.id] = false;
    this.attached = att;
    if (!loose.length) return;
    for (const g of groupsOf(this.framing, this.intact, loose)) this.makeBody(g, this.body);
  }

  private makeBody(group: number[], from: RAPIER.RigidBody): void {
    // Remove the group's colliders from their current body (collect first: removing while
    // iterating isn't safe).
    const inGroup = new Set(group);
    const doomed: RAPIER.Collider[] = [];
    for (let i = 0; i < from.numColliders(); i++) {
      const c = from.collider(i);
      const o = this.sw.owner.get(c.handle);
      if (o && o.house === this && inGroup.has(o.id)) doomed.push(c);
    }
    for (const c of doomed) {
      this.sw.owner.delete(c.handle);
      this.sw.world.removeCollider(c, false);
    }
    const t = from.translation();
    const r = from.rotation();
    const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(t.x, t.y, t.z).setRotation(r).setCanSleep(true).setAngularDamping(0.3);
    if (from.isDynamic()) {
      const v = from.linvel();
      const w = from.angvel();
      desc.setLinvel(v.x, v.y, v.z).setAngvel(w);
    }
    const body = this.sw.world.createRigidBody(desc);
    for (const id of group) this.addColliders(id, body);
    this.groupBodies.set(body.handle, group);
    this.sw.bornAt.set(body.handle, this.sw.time);
  }

  clearContacts(): void {
    if (!this.touched) return;
    for (const c of this.contact) c.x = c.y = c.z = 0;
    this.touched = false;
  }

  addContact(id: number, x: number, y: number, z: number): void {
    const c = this.contact[id]!;
    c.x += x;
    c.y += y;
    c.z += z;
    this.touched = true;
  }

  /** Attached structure: load path with wind, APC, gravity and impact forces. */
  loads(wind: WindSource): void {
    const w10 = this.reference(wind);
    this.refMph = msToMph(Math.hypot(w10.x, w10.z));
    // APC: the inside deficit lags the outside one, venting faster once the envelope is open.
    const b = this.building;
    const out = wind.deficit(b.x, b.z);
    // A house entering the simulation has long since equalized with the slowly changing
    // outside pressure (it enters well away from the core): start with no difference.
    if (!this.apcStarted) {
      this.deficitIn = out;
      this.apcStarted = true;
    }
    const tau = this.breached() ? APC_TAU.breached : APC_TAU.sealed;
    this.deficitIn += (out - this.deficitIn) * (1 - Math.exp(-STRUCT_DT / tau));
    this.apc = out - this.deficitIn;
    let impact = false;
    if (this.touched) for (const m of this.framing.members) if (this.attached[m.id] && this.hasContact(m.id)) impact = true;
    // Calm skip: nothing can fail below this wind without impacts or APC (Spec 09).
    // (Scaled by this house's weakest connection: load goes as wind², so speed as its square root.)
    const calm = DETAIL.calmMph * Math.sqrt(Math.min(1, this.framing.weakest));
    this.calmSkipped = this.refMph < calm && !impact && Math.abs(this.apc) < DETAIL.calmApcPa * this.framing.weakest;
    if (this.calmSkipped) return;
    // 30 Hz like the component model (wind loads change over tenths of a second), houses on
    // alternate steps; at once when something hits it (an impact lasts one step).
    if (!impact && (this.sw.stepCount + this.building.id) % DETAIL.solveEvery !== 0) return;
    const local = this.attachedForces(true, w10, this.apc);
    const avg = this.attachedForces(false, w10, this.apc);
    if (impact) {
      const inv = qconj(this.houseQ);
      for (const m of this.framing.members) {
        if (!this.attached[m.id] || !this.hasContact(m.id)) continue;
        const c = qrot(inv, this.contact[m.id]!);
        for (const f of [local, avg]) f[m.id] = { x: f[m.id]!.x + c.x, y: f[m.id]!.y + c.y, z: f[m.id]!.z + c.z };
      }
    }
    const attachedIds = this.framing.members.filter((m) => this.attached[m.id]).map((m) => m.id);
    // Cladding fasteners against local pressures; framing against area-averaged pressures.
    const relieve = this.diaphragm();
    const resLocal = solveLoadPath(this.framing, local, this.intact, attachedIds, true, relieve);
    const resAvg = solveLoadPath(this.framing, avg, this.intact, attachedIds, true, relieve);
    const roofToWall = this.rafterHoldDowns();
    const failed = [
      ...resLocal.failed.filter((c) => this.framing.connections[c]!.cladding).map((c) => [c, resLocal.loads[c]!] as const),
      ...resAvg.failed.filter((c) => !this.framing.connections[c]!.cladding && !roofToWall.isHoldDown[c]).map((c) => [c, resAvg.loads[c]!] as const),
      ...this.sharedRafterFailures(resAvg.loads, roofToWall),
    ];
    if (failed.length) {
      for (const [c, load] of failed) this.fail(c, load);
      this.detach();
    }
  }

  /**
   * Diaphragm action (Spec 09 v0.7): a wall frame that still carries roof framing (rafters or
   * a gable) is braced at the top, so half its out-of-plane load goes up into the ceiling and
   * roof diaphragm (and on to the end walls, stiff in-plane) instead of down to its anchors.
   */
  private diaphragm(): (id: number, t: Vec3) => Vec3 {
    const f = this.framing;
    const H = this.building.wallHeight;
    return (id, t) => {
      const m = f.members[id]!;
      if (m.kind === "gableFrame") {
        // Braced at the top by the end of the roof (its nearest rafters and the sheathing over
        // them), through the roof diaphragm to the eave walls.
        if (!this.endRafters(m, DETAIL.gableBraceRafters).some((r) => this.attached[r])) return t;
        const along = (t.x * m.normal.x + t.z * m.normal.z) * DETAIL.gableDiaphragmShare;
        return { x: t.x - along * m.normal.x, y: t.y, z: t.z - along * m.normal.z };
      }
      if (m.kind !== "wallFrame") return t;
      // Braced at the top by the roof framing: eave walls by the rafters bearing on them, end
      // walls by the end rafter on their side (through the ceiling and roof diaphragm). A gable
      // sitting on a wall doesn't brace it; it only adds load.
      const braced =
        m.face === 1 || m.face === 3
          ? f.carriesOf[id]!.some((c) => this.intact[c] && this.attached[f.connections[c]!.from] && f.members[f.connections[c]!.from]!.kind === "rafterPair")
          : this.endRafters(m, DETAIL.endWallBraceRafters).some((r) => this.attached[r]);
      const n = m.normal;
      const out = t.x * n.x + t.z * n.z;
      if (braced) {
        const along = out * DETAIL.diaphragmShare;
        return { x: t.x - along * n.x, y: t.y, z: t.z - along * n.z };
      }
      // Unbraced: the wall overturns about its base when the moment of its out-of-plane load
      // (at mid-height) beats the base's moment capacity. Scale that load so the anchors' check
      // fails exactly then: load × (anchor capacity / overturning capacity).
      // (The base joint: the frame's own supports, i.e. its nailing to the sill plate.)
      const anchors = f.supportsOf[id]!.reduce((a, c) => a + (this.intact[c] ? f.connections[c]!.capacity : 0), 0);
      const len = Math.max(...m.collision.map((s) => s.pos.x + s.size[0] / 2)) - Math.min(...m.collision.map((s) => s.pos.x - s.size[0] / 2));
      // Leaning on standing neighbors (lapped top plates) and the corner post.
      const brace = 1 + DETAIL.wallNeighborBrace * this.standingNeighbors(id) + (this.cornerStands(id) ? DETAIL.wallCornerBrace : 0);
      const overturn = (brace * DETAIL.wallBaseMomentNmPerM * len) / (H / 2);
      const k = anchors > overturn ? anchors / overturn : 1;
      const extra = out * (k - 1);
      return { x: t.x + extra * n.x, y: t.y, z: t.z + extra * n.z };
    };
  }

  private planCache: ReturnType<typeof floorPlan> | null = null;
  private get plan() {
    return (this.planCache ??= floorPlan(this.building));
  }
  private framesCache: number[] | null = null;
  /** Wall frame ids by panel index (frames are built in panel order). */
  private get frameByPanel(): number[] {
    return (this.framesCache ??= this.framing.members.filter((m) => m.kind === "wallFrame").map((m) => m.id));
  }

  /** Standing frames next to this one on the same wall (0–2). */
  private standingNeighbors(id: number): number {
    const m = this.framing.members[id]!;
    const p = this.building.panels[m.panel!]!;
    let n = 0;
    this.building.panels.forEach((q, j) => {
      if (j !== m.panel && q.face === p.face && Math.abs(Math.abs(q.u - p.u) - (q.len + p.len) / 2) < 1e-6 && this.attached[this.frameByPanel[j]!]) n++;
    });
    return n;
  }

  /** Does the perpendicular wall's frame at this frame's corner still stand? */
  private cornerStands(id: number): boolean {
    const partner = this.building.cornerPartner[this.framing.members[id]!.panel!] ?? -1;
    return partner >= 0 && !!this.attached[this.frameByPanel[partner]!];
  }

  private readonly lumberAreas = new Map<number, Vec3>();
  /** Projected lumber area of a framing member facing each of its own axes (m²). */
  private lumberArea(id: number): Vec3 {
    let a = this.lumberAreas.get(id);
    if (!a) {
      a = { x: 0, y: 0, z: 0 };
      for (const s of this.framing.members[id]!.shapes) {
        const k = s.tri ? 0.5 : 1;
        a.x += k * s.size[1] * s.size[2];
        a.y += k * s.size[0] * s.size[2];
        a.z += k * s.size[0] * s.size[1];
      }
      this.lumberAreas.set(id, a);
    }
    return a;
  }

  private readonly endRafterLists = new Map<number, number[]>();
  /** The `n` rafter pairs nearest the end of the house a member faces (outermost first). */
  private endRafters(m: { id: number; normal: Vec3 }, n: number): number[] {
    const key = m.id * 16 + n;
    let list = this.endRafterLists.get(key);
    if (!list) {
      list = this.framing.members
        .filter((r) => r.kind === "rafterPair" && Math.sign(r.pos.x) === Math.sign(m.normal.x))
        .sort((a, b) => Math.abs(b.pos.x) - Math.abs(a.pos.x))
        .slice(0, n)
        .map((r) => r.id);
      this.endRafterLists.set(key, list);
    }
    return list;
  }

  private holdDowns: { isHoldDown: boolean[]; byWall: Map<number, number[][]> } | null = null;
  /** Each rafter pair's connections to each bearing wall face, rafters in order along the ridge. */
  private rafterHoldDowns() {
    if (this.holdDowns) return this.holdDowns;
    const f = this.framing;
    const isHoldDown = f.connections.map(() => false);
    const rafters = f.members.filter((m) => m.kind === "rafterPair").sort((a, b) => a.pos.x - b.pos.x);
    const byWall = new Map<number, number[][]>();
    for (const face of [1, 3]) byWall.set(face, rafters.map(() => []));
    rafters.forEach((r, i) => {
      for (const c of f.supportsOf[r.id]!) {
        const to = f.connections[c]!.to;
        const face = to >= 0 ? f.members[to]!.face : -1;
        if (face !== 1 && face !== 3) continue;
        byWall.get(face)![i]!.push(c);
        isHoldDown[c] = true;
      }
    });
    this.holdDowns = { isHoldDown, byWall };
    return this.holdDowns;
  }

  /**
   * Rafter hold-downs with load sharing through the sheathing (Spec 09 v0.7): a rafter's
   * connections to a wall fail when the mean demand/capacity of it and its neighbors (still
   * holding, on the same wall) exceeds 1.
   */
  private sharedRafterFailures(loads: number[], hd: { byWall: Map<number, number[][]> }): (readonly [number, number])[] {
    const out: (readonly [number, number])[] = [];
    const k = DETAIL.rafterSharing;
    for (const list of hd.byWall.values()) {
      const ratio = list.map((cs) => {
        const live = cs.filter((c) => this.intact[c]);
        if (!live.length) return NaN;
        return live.reduce((a, c) => a + loads[c]!, 0) / live.reduce((a, c) => a + this.framing.connections[c]!.capacity, 0);
      });
      list.forEach((cs, i) => {
        if (Number.isNaN(ratio[i]!)) return;
        let sum = 0;
        let n = 0;
        for (let j = Math.max(0, i - k); j <= Math.min(list.length - 1, i + k); j++)
          if (!Number.isNaN(ratio[j]!)) {
            sum += ratio[j]!;
            n++;
          }
        if (sum / n > 1) for (const c of cs) if (this.intact[c]) out.push([c, loads[c]!] as const);
      });
    }
    return out;
  }

  private hasContact(id: number): boolean {
    const c = this.contact[id]!;
    return c.x !== 0 || c.y !== 0 || c.z !== 0;
  }

  /**
   * Break moving groups apart where their internal connections are overloaded: by impacts, and
   * in flight by inertial relief. A flying group accelerates as a whole, so each member's
   * connections carry its own wind force minus its share of the group's acceleration
   * (translation plus the centripetal pull of the spin). Gravity cancels in free flight.
   */
  checkGroups(): void {
    const inFlightCheck = this.sw.stepCount % IN_FLIGHT_EVERY === 0;
    const world = this.sw.world;
    for (const [handle, group] of [...this.groupBodies]) {
      if (group.length < 2) continue;
      const hit = this.touched && group.some((id) => this.hasContact(id));
      const body0 = world.getRigidBody(handle);
      if (!hit && !(inFlightCheck && !body0.isSleeping())) continue;
      const r = body0.rotation();
      const inv: Q = [-r.x, -r.y, -r.z, r.w];
      const relieved = inertialRelief(
        group.map((id) => this.framing.members[id]!.mass),
        group.map((id) => this.aeroForce[id]!),
        group.map((id) => this.memberPose(id).pos),
        body0.worldCom(),
        body0.angvel(),
      );
      // Only the group's entries are read by the solver (it runs over the group subset).
      const all = this.groupForces;
      group.forEach((id, i) => {
        const c = this.contact[id]!;
        const f = relieved[i]!;
        // Into the body's own axes (its colliders use house-local geometry).
        all[id] = qrot(inv, { x: f.x + c.x, y: f.y + c.y, z: f.z + c.z });
      });
      const res = solveLoadPath(this.framing, all, this.intact, group, false);
      if (!res.failed.length) continue;
      for (const c of res.failed) this.fail(c, res.loads[c]!);
      const parts = groupsOf(this.framing, this.intact, group);
      if (parts.length < 2) continue;
      this.groupBodies.delete(handle);
      for (const p of parts) this.makeBody(p, body0);
      this.removeBody(body0);
    }
  }

  private removeBody(body: RAPIER.RigidBody): void {
    for (let i = 0; i < body.numColliders(); i++) this.sw.owner.delete(body.collider(i).handle);
    this.sw.bornAt.delete(body.handle);
    this.sw.world.removeRigidBody(body);
  }

  /** Aerodynamic forces on the house's moving groups, per member plate, from the wind where it is. */
  aero(wind: WindSource): void {
    const world = this.sw.world;
    for (const [handle, group] of [...this.groupBodies]) {
      const body = world.getRigidBody(handle);
      // Numerical safety: drop a body whose state has gone invalid; cap runaway spin.
      // Use the center of mass: the body origin is the house origin, which can swing below the
      // ground when a piece tips over even though the piece itself is above it.
      const tr = body.worldCom();
      const lv = body.linvel();
      const gone = Math.abs(tr.x) > GROUND_HALF - 50 || Math.abs(tr.z) > GROUND_HALF - 50 || tr.y < -5;
      const bad = ![tr.x, tr.y, tr.z, lv.x, lv.y, lv.z].every(Number.isFinite);
      if (gone || bad) {
        const why = bad ? "invalid" : tr.y < -5 ? "below ground" : "left the area";
        this.lostWhy[why] = (this.lostWhy[why] ?? 0) + group.length;
        this.groupBodies.delete(handle);
        this.removeBody(body);
        this.lostMembers += group.length;
        for (const id of group) {
          this.lost[id] = true;
          this.bodyOf[id] = null;
        }
        continue;
      }
      // A light piece (a member or small chunk), clear of the house: hand it to the Spec 04
      // debris model.
      if (this.sw.time - (this.sw.bornAt.get(handle) ?? 0) >= DETAIL.lightAfterS && group.reduce((a, id) => a + this.framing.members[id]!.mass, 0) < DETAIL.lightKg) {
        if (this.toLight(group, body)) continue;
      }
      const av = body.angvel();
      const spin = Math.hypot(av.x, av.y, av.z);
      if (spin > MAX_SPIN) body.setAngvel({ x: (av.x * MAX_SPIN) / spin, y: (av.y * MAX_SPIN) / spin, z: (av.z * MAX_SPIN) / spin }, true);
      body.resetForces(false);
      body.resetTorques(false);
      const asleep = body.isSleeping();
      if (asleep) {
        // A resting piece in calm air: nothing to do.
        const wc = wind.at(tr);
        if (Math.hypot(wc.x, wc.y, wc.z) < 0.5) continue;
      }
      const v = body.linvel();
      const w = body.angvel();
      // Wind varies over tens of metres: one sample at the center serves a piece smaller than a
      // few metres; large chunks sample it at each member.
      const oneSample = group.length === 1 || group.length <= 8 ? wind.at(tr) : null;
      const applied: { f: Vec3; at: Vec3; id: number }[] = [];
      let M = 0;
      const F = { x: 0, y: 0, z: 0 };
      for (const id of group) {
        const m = this.framing.members[id]!;
        M += m.mass;
        this.aeroForce[id] = { x: 0, y: 0, z: 0 };
        const plate = m.area > 0 ? m.area : (m.plate ?? 0);
        if (plate <= 0) continue;
        const pose = this.memberPose(id);
        const flat = m.kind === "roofSheet" || m.kind === "roofShingle" || m.kind === "ceiling";
        const n = qrot(pose.q, flat ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 });
        const r = { x: pose.pos.x - tr.x, y: pose.pos.y - tr.y, z: pose.pos.z - tr.z };
        const vp = { x: v.x + (w.y * r.z - w.z * r.y), y: v.y + (w.z * r.x - w.x * r.z), z: v.z + (w.x * r.y - w.y * r.x) };
        const wnd = oneSample ?? wind.at(pose.pos);
        const f = plateForce(n, plate, { x: wnd.x - vp.x, y: wnd.y - vp.y, z: wnd.z - vp.z });
        if (![f.x, f.y, f.z, pose.pos.x, pose.pos.y, pose.pos.z].every(Number.isFinite)) continue;
        applied.push({ f, at: pose.pos, id });
        F.x += f.x;
        F.y += f.y;
        F.z += f.z;
      }
      // A piece at rest stays put until the wind can lift it or overcome friction; waking it
      // for less only makes the solver re-settle it every step (visible trembling).
      if (asleep) {
        const W = M * GRAVITY;
        if (F.y < W && Math.hypot(F.x, F.z) < REST_FRICTION * (W - F.y)) continue;
      }
      for (const { f, at, id } of applied) {
        this.aeroForce[id] = f;
        // Wake only a sleeping piece the wind can move: waking resets Rapier's sleep timer,
        // so passing it every step would keep settled debris awake (and trembling) forever.
        body.addForceAtPoint(f, at, asleep);
        // Rotational drag: a plate turning about an in-plane axis sweeps air with its far
        // parts. τ = −½ρ·C_N·w·ω|ω|·L⁴/32 for span L across the axis, width w along it.
        const ext = this.plateExtent[id]!;
        if (ext) {
          const q = this.memberPose(id).q;
          const ax = qrot(q, ext.a);
          const bx = qrot(q, ext.b);
          const k = 0.5 * AIR_DENSITY * PLATE.normalCoeff;
          const wa = w.x * ax.x + w.y * ax.y + w.z * ax.z;
          const wb = w.x * bx.x + w.y * bx.y + w.z * bx.z;
          const ta = (-k * ext.la * wa * Math.abs(wa) * ext.lb ** 4) / 32;
          const tb = (-k * ext.lb * wb * Math.abs(wb) * ext.la ** 4) / 32;
          body.addTorque({ x: ax.x * ta + bx.x * tb, y: ax.y * ta + bx.y * tb, z: ax.z * ta + bx.z * tb }, asleep);
        }
      }
    }
  }

  /** Light members whose pose changed this step (moving, or just came to rest). */
  readonly lightChanged: number[] = [];
  private lightTick = 0;

  /**
   * Move a light group (one member or a small chunk) from its Rapier body onto a Spec 04
   * debris piece, if it's airborne high enough to tumble freely, small, lying flat on the
   * ground, or at rest (kept exactly as it lies). Not while a large piece tumbles or rolls
   * along the ground: the debris model would lay it flat at once. Returns true if moved.
   */
  private toLight(group: number[], body: RAPIER.RigidBody): boolean {
    // The group's box in house-local axes (the body's own frame): center and extents.
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    let mass = 0;
    for (const id of group) {
      const m = this.framing.members[id]!;
      mass += m.mass;
      for (const sh of m.shapes)
        for (const p of shapePoints(sh)) {
          const q = qrot(m.q, p);
          const v = [m.pos.x + q.x, m.pos.y + q.y, m.pos.z + q.z];
          for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k]!, v[k]!);
            hi[k] = Math.max(hi[k]!, v[k]!);
          }
        }
    }
    const d = [0, 1, 2].map((k) => Math.max(hi[k]! - lo[k]!, 0.002));
    const c: Vec3 = { x: (lo[0]! + hi[0]!) / 2, y: (lo[1]! + hi[1]!) / 2, z: (lo[2]! + hi[2]!) / 2 };
    // Piece axes: X = length, Y = thickness, Z = width (Spec 04).
    const thin = d.indexOf(Math.min(...d));
    const rest = [0, 1, 2].filter((k) => k !== thin);
    const long = d[rest[0]!]! >= d[rest[1]!]! ? rest[0]! : rest[1]!;
    const mid = rest[0] === long ? rest[1]! : rest[0]!;
    const r = axesToQuat(long, thin, mid);
    const t = body.translation();
    const rq = body.rotation();
    const qb: Q = [rq.x, rq.y, rq.z, rq.w];
    const off = qrot(qb, c);
    const center = { x: t.x + off.x, y: t.y + off.y, z: t.z + off.z };
    const v = body.linvel();
    const w = body.angvel();
    const com = body.worldCom();
    const rr = { x: center.x - com.x, y: center.y - com.y, z: center.z - com.z };
    const first = this.framing.members[group[0]!]!;
    const piece: Piece = {
      id: group[0]!,
      kind: "osb",
      def: sheet(first.kind, d[long]!, d[mid]!, d[thin]!, mass),
      pos: center,
      vel: { x: v.x + (w.y * rr.z - w.z * rr.y), y: v.y + (w.z * rr.x - w.x * rr.z), z: v.z + (w.x * rr.y - w.y * rr.x) },
      q: qmul(qb, qconj(r)),
      spin: group[0]! % 2 ? 1 : -1,
      resting: false,
      snagged: false,
      snagDir: null,
      bornAt: this.sw.time,
      restedAt: Infinity,
      represents: 1,
      color: first.color,
      sourceId: this.building.id,
      maxWindMet: 0,
      liftOn: true,
      liftRoll: 0,
      gust: { x: 0, y: 0, z: 0 },
    };
    const asleep = body.isSleeping();
    // Thickness axis (piece Y) in the world: is it lying flat?
    const [qx, , qz] = piece.q;
    const flat = 1 - 2 * (qx * qx + qz * qz) > Math.cos(DETAIL.flatTiltRad);
    const onGround = center.y - d[thin]! / 2 < 0.05;
    if (asleep) {
      piece.resting = true;
      piece.grounded = true;
      piece.vel = { x: 0, y: 0, z: 0 };
      piece.restedAt = this.sw.time;
    } else if (flat && onGround) {
      // Sliding flat on its face: the debris model's sliding state, same heading.
      flattenPiece(piece);
      piece.vel.y = 0;
    } else if (d[long]! >= DETAIL.smallPieceM && center.y < d[long]! / 2 + DETAIL.lightClearance) {
      // A large piece not high enough to tumble freely on the debris model (any orientation
      // must clear the ground): it stays a rigid body until it's higher or at rest.
      return false;
    }
    this.groupBodies.delete(body.handle);
    this.removeBody(body);
    const lp: LightPiece = { piece, r, c, members: group };
    for (const id of group) {
      this.bodyOf[id] = null;
      this.lightOf.set(id, lp);
    }
    this.light.set(group[0]!, lp);
    return true;
  }

  /** Step the house's light pieces on the Spec 04 model (no turbulence, ground contact only). */
  stepLight(wind: WindSource): void {
    this.lightChanged.length = 0;
    if (!this.light.size) return;
    // Every step (60 Hz): poses go straight to the screen without interpolation, so a coarser
    // step would show as judder. Resting pieces check the wind 4 times a second.
    const checkResting = this.lightTick++ % 15 === 0;
    for (const [key, lp] of this.light) {
      const p = lp.piece;
      if (p.resting) {
        if (!checkResting) continue;
        if (!wakeIfForced(p, wind.at({ x: p.pos.x, y: 1, z: p.pos.z }))) continue;
      }
      // The ground under it: this house's slab top, or the ground.
      const floor = this.onSlab(p.pos) ? SLAB_TOP : 0;
      p.pos.y -= floor;
      stepPiece(p, wind.at({ x: p.pos.x, y: p.pos.y + floor, z: p.pos.z }), STRUCT_DT);
      p.pos.y += floor;
      for (const id of lp.members) this.lightChanged.push(id);
      if (Math.abs(p.pos.x) > GROUND_HALF - 50 || Math.abs(p.pos.z) > GROUND_HALF - 50 || p.pos.y > 5000) {
        this.light.delete(key);
        for (const id of lp.members) {
          this.lightOf.delete(id);
          this.lost[id] = true;
        }
        this.lostWhy["left the area"] = (this.lostWhy["left the area"] ?? 0) + lp.members.length;
      }
    }
  }

  /** Is a world point over this house's slab? */
  private onSlab(p: Vec3): boolean {
    const b = this.building;
    const l = qrot(qconj(this.houseQ), { x: p.x - b.x, y: 0, z: p.z - b.z });
    const td = LUMBER.stud[1];
    return Math.abs(l.x) < (b.width + td) / 2 && Math.abs(l.z) < (b.depth + td) / 2;
  }

  /** Loose bodies and light pieces still moving. */
  get movingGroups(): number {
    let n = 0;
    for (const [h] of this.groupBodies) if (!this.sw.world.getRigidBody(h).isSleeping()) n++;
    for (const { piece } of this.light.values()) if (!piece.resting) n++;
    return n;
  }

  /** Freeze: keep every member's final pose, remove the house's bodies from the world. */
  freeze(): void {
    if (this.frozen) return;
    this.frozenPose = this.framing.members.map((m) => this.memberPose(m.id));
    for (const [h] of this.groupBodies) this.removeBody(this.sw.world.getRigidBody(h));
    this.groupBodies.clear();
    this.light.clear();
    this.lightOf.clear();
    this.removeBody(this.body);
    if (this.slab) this.sw.world.removeCollider(this.slab, false);
    this.slab = null;
    this.frozen = true;
  }
}

/** A light group flying on the Spec 04 debris model. */
interface LightPiece {
  piece: Piece;
  /** Rotation from house-local axes (the group's frame) to the piece's axes. */
  r: Q;
  /** Center of the group's box, house-local. */
  c: Vec3;
  members: number[];
}

/** Rotation taking member axes (long, thin, mid) onto piece axes (X, Y, Z), as a quaternion. */
function axesToQuat(long: number, thin: number, mid: number): Q {
  // Rows of the rotation matrix: which member axis lands on piece X, Y and Z.
  const row = (k: number): number[] => [0, 1, 2].map((j) => (j === k ? 1 : 0));
  const m = [row(long), row(thin), row(mid)];
  // A permutation can be a reflection: flip Z (the box is symmetric) to keep det = +1.
  const det =
    m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
    m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
    m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
  if (det < 0) m[2] = m[2]!.map((v) => -v);
  const [a, b, c] = m as [number[], number[], number[]];
  const tr = a[0]! + b[1]! + c[2]!;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = s / 4;
    x = (c[1]! - b[2]!) / s;
    y = (a[2]! - c[0]!) / s;
    z = (b[0]! - a[1]!) / s;
  } else if (a[0]! > b[1]! && a[0]! > c[2]!) {
    const s = Math.sqrt(1 + a[0]! - b[1]! - c[2]!) * 2;
    w = (c[1]! - b[2]!) / s;
    x = s / 4;
    y = (a[1]! + b[0]!) / s;
    z = (a[2]! + c[0]!) / s;
  } else if (b[1]! > c[2]!) {
    const s = Math.sqrt(1 + b[1]! - a[0]! - c[2]!) * 2;
    w = (a[2]! - c[0]!) / s;
    x = (a[1]! + b[0]!) / s;
    y = s / 4;
    z = (b[2]! + c[1]!) / s;
  } else {
    const s = Math.sqrt(1 + c[2]! - a[0]! - b[1]!) * 2;
    w = (b[0]! - a[1]!) / s;
    x = (a[2]! + c[0]!) / s;
    y = (b[2]! + c[1]!) / s;
    z = s / 4;
  }
  return [x, y, z, w];
}

/**
 * Main-structure pressure coefficient on a gable roof at house-local point `p` (ridge along
 * x), for local wind direction `u` (Spec 09 v0.7, ASCE 7 MWFRS): across the ridge by slope,
 * along it by distance from the windward gable edge, blended by cos² / sin² of the angle.
 */
export function roofMwfrsCp(p: Vec3, u: Vec3, width: number, h: number): number {
  const s = Math.hypot(u.x, u.z);
  if (s < 1e-9) return ROOF_MWFRS.normalLeeward;
  const cn = u.z / s; // across the ridge
  const cp = u.x / s; // along the ridge
  // Windward slope: the side the wind reaches first (z opposite to the wind's z).
  const across = p.z * u.z < 0 ? ROOF_MWFRS.normalWindward : ROOF_MWFRS.normalLeeward;
  const d = u.x >= 0 ? p.x + width / 2 : width / 2 - p.x; // from the windward gable edge
  let along: number = ROOF_MWFRS.parallel[ROOF_MWFRS.parallel.length - 1]![1];
  for (const [upTo, c] of ROOF_MWFRS.parallel)
    if (d < upTo * h) {
      along = c;
      break;
    }
  return cn * cn * across + cp * cp * along;
}
