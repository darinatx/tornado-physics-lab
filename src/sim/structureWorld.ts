/**
 * Member-level structural physics (Spec 09): one shared Rapier world holding any number of
 * detailed houses. Each house's intact structure is a fixed body; members that lose every path
 * to the slab become dynamic compound bodies. Contact forces from impacts (with the ground,
 * other pieces, or other houses) feed back into connection checks.
 */
import RAPIER from "@dimforge/rapier3d-simd-compat";
import { AIR_DENSITY, GRAVITY } from "../config/atmosphere";
import { APC_TAU, CP, CPI, CP_FREESTANDING } from "../config/buildings";
import { DETAIL, FRAMING_DRAG_CD, LUMBER, ROOF_MWFRS, SLAB_TOP } from "../config/structure";
import { faceCp, faceNormal } from "../core/damage/loads";
import type { Building } from "../core/damage/types";
import { bodyPlates, plateExtent, pressureForce, rigidAero } from "../core/structure/aero";
import type { BodyPlate } from "../core/structure/aero";
import { buildFraming, floorPlan, qconj, qmul, qrot, shapePoints, shapeVolume } from "../core/structure/framing";
import type { Framing, Q } from "../core/structure/framing";
import { inertialRelief } from "../core/structure/inertia";
import { attachedToSlab, groupsOf, solveLoadPath } from "../core/structure/loadpath";
import type { Vec3 } from "../core/math/vec";
import { msToMph } from "../core/wind/efScale";
import type { TerrainClass } from "../core/wind/types";
import { createRng } from "../core/math/rng";
import { DEBRIS, sheet } from "../config/debris";
const DEBRIS_REST_SAMPLE = DEBRIS.restSampleHeight;
import { bumpKick, flatten as flattenPiece, isSliding, stepPiece, supportHeight as supportHeightOf, wakeIfForced } from "../core/debris/piece";
import { floorUnder, unbury } from "../core/impact/contact";
import { glassThreshold } from "../core/impact/impact";
import { FIXED_GROUPS, SLAB_DEPTH } from "./townColliders";
import { IMPACT } from "../config/impacts";
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
/** Soft-CCD look-ahead for loose pieces (m): about one 1/60 s step at 30 m/s. */
const SOFT_CCD_M = 0.5;
/** Soft CCD look-ahead as a multiple of the farthest a body's surface can move in one step. */
const CCD_MARGIN = 1.5;
/** In-flight breakup checks run every N steps (15 Hz). */
const IN_FLIGHT_EVERY = 4;
/** Ground half-size (m); pieces beyond it are retired. */
export const GROUND_HALF = 10000;
/** A collider's world bounding box, grown by `margin` (m). */
function colliderBox(c: RAPIER.Collider, margin: number): { center: Vec3; half: Vec3 } {
  const t = c.translation();
  const r = c.rotation();
  const q: Q = [r.x, r.y, r.z, r.w];
  const pts: Vec3[] = [];
  const he = c.shape.type === RAPIER.ShapeType.Cuboid ? (c.shape as RAPIER.Cuboid).halfExtents : null;
  if (he) {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) pts.push({ x: sx * he.x, y: sy * he.y, z: sz * he.z });
  } else {
    const v = (c.shape as RAPIER.ConvexPolyhedron).vertices;
    for (let i = 0; i < v.length; i += 3) pts.push({ x: v[i]!, y: v[i + 1]!, z: v[i + 2]! });
  }
  const lo = { x: Infinity, y: Infinity, z: Infinity };
  const hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of pts) {
    const w = qrot(q, p);
    lo.x = Math.min(lo.x, w.x);
    lo.y = Math.min(lo.y, w.y);
    lo.z = Math.min(lo.z, w.z);
    hi.x = Math.max(hi.x, w.x);
    hi.y = Math.max(hi.y, w.y);
    hi.z = Math.max(hi.z, w.z);
  }
  return {
    center: {
      x: t.x + (lo.x + hi.x) / 2,
      y: t.y + (lo.y + hi.y) / 2,
      z: t.z + (lo.z + hi.z) / 2,
    },
    half: {
      x: (hi.x - lo.x) / 2 + margin,
      y: (hi.y - lo.y) / 2 + margin,
      z: (hi.z - lo.z) / 2 + margin,
    },
  };
}

/** No houses around (the lab). */
const NO_HOUSES: readonly Building[] = [];

/** A piece's hit on a house around the zone, for the sim (Spec 10 slice B). */
export interface TownHit {
  house: number;
  plane: number;
  point: Vec3;
  mass: number;
  vn: number;
  dims: [number, number, number];
  family: "sheet" | "rod" | "compact";
  label: string;
}

/** Shared zero force (never mutated). */
const ZERO: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });

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
  /** Ground roughness for loose pieces' bumps (Spec 04 v1.7); the lab stands on open ground. */
  terrain: TerrainClass = "open";
  /** Houses around the zone (the engine's copies, Spec 10 v0.6): their slabs and standing
   *  walls and roofs, for light pieces; null in the lab. */
  townNear: ((x: number, z: number) => readonly Building[]) | null = null;
  /** Static colliders standing for those houses in this world, by house index. */
  readonly townColliders = new Map<number, RAPIER.Collider[]>();
  /** Stand-in collider handle → the house it stands for (index and center, for "out of it"). */
  readonly townHouseOf = new Map<number, { x: number; z: number; index: number }>();
  /** Stand-in collider handle → its envelope plane (0–3 walls, 5/6 roof slopes). */
  readonly townPlaneOf = new Map<number, number>();
  /** Hits on stand-ins this step, for the sim to turn into impacts (Spec 10 slice B). */
  readonly townHits: TownHit[] = [];

  /** Record a hit on a stand-in by a piece (mass kg, normal speed m/s, box dims L/W/T m). */
  recordTownHit(col: RAPIER.Collider, point: Vec3, mass: number, vn: number, dims: readonly [number, number, number], family: "sheet" | "rod" | "compact", label: string): void {
    const house = this.townHouseOf.get(col.handle);
    const plane = this.townPlaneOf.get(col.handle);
    if (!house || plane === undefined || vn < 1) return;
    this.townHits.push({ house: house.index, plane, point: { x: point.x, y: point.y, z: point.z }, mass, vn, dims: [dims[0], dims[1], dims[2]], family, label });
  }
  /** Build stand-ins for the houses around a point that this world doesn't have yet (pieces
   *  can fly farther than the houses built up front); set by the engine. */
  ensureTown: ((x: number, z: number) => void) | null = null;
  /** Runs just before each physics step (the engine rebuilds stand-ins for houses that changed). */
  beforePhysics: (() => void) | null = null;
  private readonly castShapes = new Map<string, RAPIER.Cuboid>();
  /** The ground: light pieces handle it themselves (Spec 04), so sweeps skip it. */
  private readonly ground: RAPIER.Collider;

  /**
   * Sweep a light piece's box from `from` to where it is now against everything that doesn't
   * move: standing detailed houses, rubble, and the houses around the zone (Spec 10 v0.6).
   */
  castLight(p: Piece, from: Vec3, q: Q = p.q): RAPIER.ColliderShapeCastHit | null {
    const d = { x: p.pos.x - from.x, y: p.pos.y - from.y, z: p.pos.z - from.z };
    if (d.x === 0 && d.y === 0 && d.z === 0) return null;
    return this.world.castShape(from, rot(q), d, this.boxOf(p, 0), 0, 1, false, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, this.ground);
  }

  /** The fixed collider a light piece's box (shrunk by 1 cm, so touching doesn't count)
   *  overlaps, if any (not its own house's while it is still tangled there). */
  overlappingFixed(p: Piece, pos: Vec3 = p.pos, q: Q = p.q): RAPIER.Collider | null {
    let found: RAPIER.Collider | null = null;
    const own = p.clearOfHouse ? null : this.ownerOfLight.get(p) ?? null;
    this.world.intersectionsWithShape(
      pos, rot(q), this.boxOf(p, 0.01),
      (c) => {
        if (own && this.owner.get(c.handle)?.house === own) return true;
        found = c;
        return false;
      },
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, this.ground,
    );
    return found;
  }

  /** Light pieces still on Rapier (their first half second): body handle → house. */
  readonly lightBodies = new Map<number, DetailHouse>();
  /** Light bodies pushed clear this step. */
  readonly pushed = new Set<number>();

  /**
   * After the physics step, no light-piece body may sit inside anything fixed other than its
   * own house (Spec 10 v0.9): a thin sheet can slip into a slab or wall without Rapier making a
   * contact for it. Pushed out along the surface's normal (1 cm at a time), it loses its
   * velocity into the surface.
   */
  private keepLightBodiesClear(): void {
    this.pushed.clear();
    for (const [handle, house] of this.lightBodies) {
      const body = this.world.getRigidBody(handle);
      if (!body || !body.isValid() || !body.isDynamic()) {
        this.lightBodies.delete(handle);
        continue;
      }
      for (let k = 0; k < 40; k++) {
        let hit: { col: RAPIER.Collider; c: RAPIER.ShapeContact } | null = null;
        for (let i = 0; i < body.numColliders() && !hit; i++) {
          const mine = body.collider(i);
          this.world.intersectionsWithShape(
            mine.translation(), mine.rotation(), mine.shape,
            (o) => {
              if (o.handle === mine.handle || o.parent()?.handle === handle || o === this.ground) return true;
              // Its own house (tangled where it tore off) and its own slab (Rapier keeps those
              // contacts; the trouble is with other houses' fixed shapes).
              if (this.owner.get(o.handle)?.house === house || o === house.slabCollider) return true;
              const c = o.contactShape(mine.shape, mine.translation(), mine.rotation(), 0);
              if (c && c.distance < -0.005) {
                hit = { col: o, c };
                return false;
              }
              return true;
            },
            RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC,
          );
        }
        if (!hit) break;
        const h = hit as { col: RAPIER.Collider; c: RAPIER.ShapeContact };
        const t = body.translation();
        const n = this.outward(h.col, h.c.normal1, body.collider(0).translation());
        this.pushed.add(handle);
        body.setTranslation({ x: t.x + n.x * 0.01, y: t.y + n.y * 0.01, z: t.z + n.z * 0.01 }, true);
        const v = body.linvel();
        const vn = v.x * n.x + v.y * n.y + v.z * n.z;
        if (vn < 0) body.setLinvel({ x: v.x - vn * n.x, y: v.y - vn * n.y, z: v.z - vn * n.z }, true);
      }
    }
  }

  /**
   * Which way is out of a fixed shape: its contact normal, turned to point away from the house
   * it belongs to (or from the shape's own center). In a thin layer (siding, sheathing, glass)
   * the contact normal alone can point into the house.
   */
  outward(col: RAPIER.Collider, n: Vec3, at: Vec3): Vec3 {
    const o = this.owner.get(col.handle);
    const town = this.townHouseOf.get(col.handle);
    const c = o ? { x: o.house.building.x, y: at.y, z: o.house.building.z } : town ? { x: town.x, y: at.y, z: town.z } : col.translation();
    const away = { x: at.x - c.x, y: o || town ? 0 : at.y - c.y, z: at.z - c.z };
    const out = n.x * away.x + n.y * away.y + n.z * away.z < 0 ? { x: -n.x, y: -n.y, z: -n.z } : { x: n.x, y: n.y, z: n.z };
    // Never down: that only leads into the ground.
    if (out.y < 0) out.y = 0;
    const l = Math.hypot(out.x, out.y, out.z);
    return l > 1e-6 ? { x: out.x / l, y: out.y / l, z: out.z / l } : { x: 0, y: 1, z: 0 };
  }

  /** The house each light piece tore off (for its own-house exemption). */
  readonly ownerOfLight = new WeakMap<Piece, DetailHouse>();

  /** A light piece's full box. */
  lightBox(p: Piece): RAPIER.Cuboid {
    return this.boxOf(p, 0);
  }

  /** Does a light piece's box (shrunk by 1 cm, so touching doesn't count) overlap anything
   *  fixed, where it is now or at the given pose? */
  overlapsFixed(p: Piece, pos: Vec3 = p.pos, q: Q = p.q, only?: DetailHouse): boolean {
    let hit = false;
    this.world.intersectionsWithShape(
      pos, rot(q), this.boxOf(p, 0.01),
      (c) => {
        if (only && this.owner.get(c.handle)?.house !== only) return true; // keep looking
        hit = true;
        return false;
      },
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, this.ground,
    );
    return hit;
  }

  private boxOf(p: Piece, shrink: number): RAPIER.Cuboid {
    const [L, W, T] = p.def.dims;
    const h = [L / 2, T / 2, W / 2].map((v) => Math.max(v - shrink, Math.min(v, 0.001)));
    const key = h.join(",");
    let shape = this.castShapes.get(key);
    if (!shape) this.castShapes.set(key, (shape = new RAPIER.Cuboid(h[0]!, h[1]!, h[2]!)));
    return shape;
  }
  /** Debug: which phase of the step is running (for crash reports). */
  phase = "";

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = STRUCT_DT;
    this.events = new RAPIER.EventQueue(true);
    // Thick ground so fast debris can't cross more than half of it in one step and pop out below.
    this.ground = this.world.createCollider(RAPIER.ColliderDesc.cuboid(GROUND_HALF, 20, GROUND_HALF).setTranslation(0, -20, 0).setFriction(0.8).setCollisionGroups(FIXED_GROUPS));
  }

  /** Add a detailed house; `removed` members (already failed in the component model) are left out. */
  addHouse(b: Building, removed?: readonly boolean[], gradual = false): DetailHouse {
    const h = new DetailHouse(this, b, removed);
    this.houses.push(h);
    if (gradual) this.building.push(h);
    else h.build(Infinity);
    return h;
  }

  /** Houses still being built, in entry order. */
  private readonly building: DetailHouse[] = [];

  /** Spend this step's collider budget on houses still being built (Spec 09: a count, so runs
   *  stay deterministic). */
  private buildPending(): void {
    let budget = DETAIL.buildCollidersPerStep;
    while (this.building.length && budget > 0) {
      const h = this.building[0]!;
      const used = h.frozen ? 0 : h.build(budget, budget === DETAIL.buildCollidersPerStep);
      budget -= used;
      if (h.complete || h.frozen) this.building.shift();
      else if (!used) break; // the next member doesn't fit this step
    }
  }

  step(wind: WindSource): void {
    this.phase = "build";
    this.buildPending();
    const live = this.houses.filter((h) => !h.frozen && h.complete);
    this.phase = "loads";
    for (const h of live) h.loads(wind);
    this.phase = "groups";
    for (const h of live) h.checkGroups();
    this.phase = "aero";
    for (const h of live) h.aero(wind);
    for (const h of live) h.stepLight(wind);

    // Houses around moving pieces: build any this world doesn't have yet (Spec 10 v0.6).
    if (this.ensureTown) this.world.forEachActiveRigidBody((b) => {
      if (!b.isDynamic()) return;
      const t = b.translation();
      this.ensureTown!(t.x, t.z);
    });
    this.beforePhysics?.();
    // Soft CCD reaches past how far each body can move this step, spin included (Spec 10
    // v0.13): a fixed look-ahead let fast pieces (31 m/s = 0.52 m per step) end a step inside
    // a wall.
    this.world.forEachActiveRigidBody((b) => {
      if (!b.isDynamic()) return;
      const v = b.linvel();
      const w = b.angvel();
      const reach = (Math.hypot(v.x, v.y, v.z) + Math.hypot(w.x, w.y, w.z) * this.radiusOf(b)) * STRUCT_DT * CCD_MARGIN;
      b.setSoftCcdPrediction(Math.max(SOFT_CCD_M, reach));
    });
    // Physics step; collect impact forces for the next step's checks.
    for (const h of live) h.clearContacts();
    this.phase = "world.step";
    this.world.step(this.events);
    this.phase = "keep clear";
    this.keepLightBodiesClear();
    this.phase = "events";
    // Impacts: only between a moving piece and something else, ignoring a piece's first half
    // second (it's separating from where it was attached) and forces near its own weight
    // (resting contact).
    const soften = STRUCT_DT / IMPACT_DURATION;
    const hitRubble: [DetailHouse, number][] = [];
    const glassHits: [DetailHouse, number, number, RAPIER.Collider][] = [];
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
      // A piece hitting a house around the zone: its stand-in (Spec 10 slice B).
      for (const [h, other] of [[e.collider1(), e.collider2()], [e.collider2(), e.collider1()]] as const) {
        if (!this.townPlaneOf.has(h)) continue;
        const oc = this.world.getCollider(other);
        const ob = oc?.parent();
        if (!oc || !ob || !ob.isDynamic()) continue;
        const m = ob.mass();
        const he = (oc.shape as RAPIER.Cuboid).halfExtents;
        const d = he ? [he.x * 2, he.y * 2, he.z * 2].sort((a, b) => b - a) : [1, 0.1, 0.05];
        const thin = d[2]! < 0.02;
        const o = this.owner.get(other);
        this.recordTownHit(this.world.getCollider(h), oc.translation(), m, (e.totalForceMagnitude() * STRUCT_DT) / Math.max(m, 1e-6), d as [number, number, number], thin ? "sheet" : d[0]! > 4 * d[1]! ? "rod" : "compact", o ? o.house.framing.members[o.id]!.kind : "debris");
      }
      for (const [h, sign] of pairs) {
        const o = this.owner.get(h);
        if (!o) continue;
        const m = o.house.framing.members[o.id]!;
        // Glass breaks by the hit's momentum (Spec 10 IMP-21): J = F·dt, p = J / (1 + e).
        if (m.kind === "pane" && o.house.isAttached(o.id)) {
          const other = this.world.getCollider(h === e.collider1() ? e.collider2() : e.collider1());
          const ob = other?.parent();
          if (ob && ob.isDynamic()) glassHits.push([o.house, o.id, (e.totalForceMagnitude() * STRUCT_DT) / 1.1, other!]);
        }
        if (mag < 5 * m.mass * GRAVITY) continue;
        // A hit on resting rubble brings it back to life.
        const r = o.house.rubbleHandleOf(o.id);
        if (r !== null) hitRubble.push([o.house, r]);
        o.house.addContact(o.id, sign * dir.x, sign * dir.y, sign * dir.z);
      }
    });
    for (const [h, r] of hitRubble) h.wakeRubble(r);
    for (const [h, id, p, other] of glassHits) {
      // The hitting piece's shape family: a thin plate spreads its contact (sheet), anything
      // else hits with an edge, corner or end.
      const o = this.owner.get(other.handle);
      const om = o ? o.house.framing.members[o.id]! : null;
      const thin = om ? Math.min(...om.shapes.map((sh) => Math.min(...sh.size))) < 0.02 && (other.parent()?.numColliders() ?? 1) <= 3 : false;
      h.hitGlass(id, p, thin ? "sheet" : "compact");
    }
    this.time += STRUCT_DT;
    this.stepCount++;
  }

  /** A body's bounding radius about its origin (m), cached per body (its colliders don't change). */
  private readonly radii = new Map<number, number>();
  /** A body was removed: its handle may be reused. */
  forgetBody(handle: number): void {
    this.radii.delete(handle);
    this.radiiCount.delete(handle);
  }
  private radiusOf(b: RAPIER.RigidBody): number {
    let r = this.radii.get(b.handle);
    if (r !== undefined && this.radiiCount.get(b.handle) === b.numColliders()) return r;
    r = 0;
    const t = b.translation();
    for (let i = 0; i < b.numColliders(); i++) {
      const c = b.collider(i);
      const p = c.translation();
      const he = (c.shape as RAPIER.Cuboid).halfExtents;
      const ext = he ? Math.hypot(he.x, he.y, he.z) : 0.5;
      r = Math.max(r, Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) + ext);
    }
    this.radii.set(b.handle, r);
    this.radiiCount.set(b.handle, b.numColliders());
    return r;
  }
  private readonly radiiCount = new Map<number, number>();

  /** Rubble (house, body handle) touching any of these colliders (their boxes overlap within
   *  1 cm: Rapier keeps no contacts between two fixed bodies); only rubble whose center of mass
   *  is above `aboveY` if given. */
  rubbleTouching(colliders: readonly RAPIER.Collider[], aboveY = -Infinity): [DetailHouse, number][] {
    const out: [DetailHouse, number][] = [];
    const seen = new Set<number>();
    const mine = new Set(colliders.map((c) => c.parent()?.handle));
    for (const c of colliders) {
      const { center, half } = colliderBox(c, 0.01);
      this.world.collidersWithAabbIntersectingAabb(center, half, (other) => {
        const p = other.parent();
        if (!p || mine.has(p.handle)) return true;
        const o = this.owner.get(other.handle);
        if (!o) return true;
        const h = o.house.rubbleHandleOf(o.id);
        if (h === null || seen.has(h)) return true;
        if (this.world.getRigidBody(h).worldCom().y <= aboveY) return true;
        seen.add(h);
        out.push([o.house, h]);
        return true;
      });
    }
    return out;
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
  /** Resting rubble: fixed-in-place loose groups (body handle → members), and since when each
   *  moving group has been still (Spec 09 performance). */
  readonly rubble = new Map<number, number[]>();
  private readonly stillSince = new Map<number, number>();
  private rubbleTick = 0;
  /** Loose bodies' plates (body frame) and masses, by body handle. */
  private readonly platesOf = new Map<number, BodyPlate[]>();
  private readonly massOf = new Map<number, number>();
  private readonly plateForces: Vec3[] = [];
  /** Light members flying on the Spec 04 debris model: the piece, the rotation from member to
   *  piece axes, and the member-local center of the piece's box. */
  readonly light = new Map<number, LightPiece>();
  /** Member → the light piece carrying it. */
  private readonly lightOf = new Map<number, LightPiece>();

  /** Seeded per house: bumps under its light pieces (Spec 04 v1.7). */
  private readonly rng: () => number;

  constructor(
    private readonly sw: StructureWorld,
    readonly building: Building,
    removed?: readonly boolean[],
  ) {
    this.framing = buildFraming(building);
    this.rng = createRng(0x6c8e9cf5 ^ Math.imul(building.id + 1, 0x9e3779b1));
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
      RAPIER.ColliderDesc.cuboid((building.width + LUMBER.stud[1]) / 2, (SLAB_TOP + SLAB_DEPTH) / 2, (building.depth + LUMBER.stud[1]) / 2)
        .setTranslation(building.x, (SLAB_TOP - SLAB_DEPTH) / 2, building.z)
        .setRotation(rot(this.houseQ))
        .setFriction(0.8)
        .setCollisionGroups(FIXED_GROUPS),
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
    this.hadRemoved = !!removed;
    for (const m of f.members) if (this.lost[m.id]) this.bodyOf[m.id] = null;
  }

  /** Members whose colliders are built so far (entry is spread over steps, Spec 09). */
  private buildNext = 0;
  private hadRemoved = false;
  /** All colliders built: the house carries loads and can fail. */
  complete = false;

  /** Build colliders for the next members, up to `budget` colliders (at least one member if
   *  `atLeastOne`); returns how many were built. Completing the house drops whatever has no
   *  support. */
  build(budget: number, atLeastOne = true): number {
    const f = this.framing;
    let used = 0;
    while (this.buildNext < f.members.length && ((atLeastOne && used === 0) || used + f.members[this.buildNext]!.collision.length <= budget)) {
      const m = f.members[this.buildNext++]!;
      if (this.lost[m.id]) continue;
      this.addColliders(m.id, this.body);
      used += m.collision.length;
    }
    if (this.buildNext >= f.members.length && !this.complete) {
      this.complete = true;
      // Anything left without support falls now.
      if (this.hadRemoved) this.detach();
    }
    return used;
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
        const pts = shapePoints({
          ...s,
          pos: { x: 0, y: 0, z: 0 },
          q: [0, 0, 0, 1],
        });
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
      // The standing house never moves: it only meets moving pieces (no pairs with the ground,
      // its slab or other fixed things).
      else if (body === this.body) desc.setCollisionGroups(FIXED_GROUPS);
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
      return {
        pos: {
          x: lt.piece.pos.x - off.x + p.x,
          y: lt.piece.pos.y - off.y + p.y,
          z: lt.piece.pos.z - off.z + p.z,
        },
        q: qmul(qb, m.q),
      };
    }
    const body = this.bodyOf[id]!;
    const t = body.translation();
    const r = body.rotation();
    // Every body's local frame is house-local (dynamic bodies start at the house's pose).
    const bq: Q = [r.x, r.y, r.z, r.w];
    const p = qrot(bq, m.pos);
    return {
      pos: { x: t.x + p.x, y: t.y + p.y, z: t.z + p.z },
      q: qmul(bq, m.q),
    };
  }

  /** World poses of the members of light pieces that moved this step (each piece's frame
   *  computed once), appended as in `bodyPoses`. */
  lightPoses(house: number, out: number[]): void {
    for (const lt of this.lightMoved) {
      if (this.lost[lt.members[0]!]) continue;
      const qb = qmul(lt.piece.q, lt.r);
      const off = qrot(qb, lt.c);
      const ox = lt.piece.pos.x - off.x;
      const oy = lt.piece.pos.y - off.y;
      const oz = lt.piece.pos.z - off.z;
      for (const id of lt.members) {
        const m = this.framing.members[id]!;
        const p = qrot(qb, m.pos);
        const q = qmul(qb, m.q);
        out.push(house, id, ox + p.x, oy + p.y, oz + p.z, q[0], q[1], q[2], q[3]);
      }
    }
  }

  /** World poses of a body's members, appended as [house, member, px, py, pz, qx, qy, qz, qw]
   *  (the body's pose read once). */
  bodyPoses(body: RAPIER.RigidBody, group: readonly number[], house: number, out: number[]): void {
    const t = body.translation();
    const r = body.rotation();
    const bq: Q = [r.x, r.y, r.z, r.w];
    for (const id of group) {
      const m = this.framing.members[id]!;
      const p = qrot(bq, m.pos);
      const q = qmul(bq, m.q);
      out.push(house, id, t.x + p.x, t.y + p.y, t.z + p.z, q[0], q[1], q[2], q[3]);
    }
  }

  isAttached(id: number): boolean {
    return this.attached[id]!;
  }

  /** Does any envelope opening exist (a detached envelope member)? */
  /** Debris perforations (m²) per face 0–3 and the roof at 4 (Spec 10 v0.12), as a component
   *  house keeps them. */
  readonly holes = [0, 0, 0, 0, 0];
  /** A perforation by the town's debris: 1 m² of holes breaches the house (IMP-07, IMP-22). */
  addHole(face: number): void {
    if (face < 0 || face > 4) return;
    this.holes[face]! += IMPACT.holeArea;
    if (this.holes.reduce((a, h) => a + h, 0) >= IMPACT.breachArea - 1e-9) this.wasBreached = true;
  }

  breached(): boolean {
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
  internalCp(cpFace: number[]): number {
    let area = 0;
    let sum = 0;
    for (const m of this.framing.members) {
      if (this.attached[m.id] || !this.isEnvelope(m.id)) continue;
      area += m.area;
      sum += m.area * (m.face >= 0 ? cpFace[m.face]! : CP.roofAverage);
    }
    // Perforations are openings once the house is breached (the component rule, Spec 02/10).
    if (this.breached())
      for (let f = 0; f < 5; f++)
        if (this.holes[f]! > 0) {
          area += this.holes[f]!;
          sum += this.holes[f]! * (f < 4 ? cpFace[f]! : CP.roofAverage);
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
    // The roof's windward edge moves as the roof comes off: its leading edge is where the
    // standing roof begins (the flow separates there), not the original gable.
    const rafterXs = f.members.filter((m) => m.kind === "rafterPair" && this.attached[m.id]).map((m) => m.pos.x).sort((a, c) => a - c);
    const edgeGap = 1.5 * LUMBER.spacing;
    const roofCp = (m: { pos: Vec3 }) => roofMwfrsCp(m.pos, ul, b.width, b.roofHeight, windwardEdgeDistance(m.pos.x, rafterXs, ul.x, b.width, edgeGap));
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
        const fl = qrot(m.q, {
          x: k * A.x * u.x * Math.abs(u.x),
          y: k * A.y * u.y * Math.abs(u.y),
          z: k * A.z * u.z * Math.abs(u.z),
        });
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
      for (const m of this.framing.members) if (m.pane === pane && m.id !== con.from) for (const s of this.framing.supportsOf[m.id]!) if (this.intact[s]) this.intact[s] = false;
    this.failures.push({
      time: this.sw.time,
      label: con.label,
      member: this.framing.members[con.from]!.kind,
      load,
      capacity: con.capacity,
      mph: this.refMph,
    });
  }

  /**
   * A piece hit a pane's shard with momentum p (kg·m/s): the pane breaks, whole, when p exceeds
   * its threshold (the town's per-pane fragility, Spec 10 IMP-03/IMP-21).
   */
  hitGlass(id: number, p: number, family: "sheet" | "compact"): boolean {
    const m = this.framing.members[id]!;
    if (m.kind !== "pane" || !this.attached[id]) return false;
    const pane = this.building.panes.findIndex((q) => q.panel === m.panel);
    if (pane < 0 || p <= glassThreshold(this.building, pane, family)) return false;
    const c = this.framing.supportsOf[id]!.find((k) => this.intact[k]);
    if (c === undefined) return false;
    this.fail(c, p);
    this.detach();
    return true;
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
    // Rubble resting on members that come loose from the standing house must come back to life.
    const supported = from.isDynamic() ? [] : this.sw.rubbleTouching(doomed);
    for (const c of doomed) {
      this.sw.owner.delete(c.handle);
      this.sw.world.removeCollider(c, false);
    }
    const t = from.translation();
    const r = from.rotation();
    // Soft CCD: a fast chunk looks ahead along its path, so it can't skip through a thin wall,
    // sheet or slab edge in one 1/60 s step (Spec 10 v0.6).
    // Light pieces (thin sheets, single members) are also checked after every physics step and
    // pushed out of anything fixed they sink into (keepLightBodiesClear). (Full CCD was tried
    // for them: Rapier's time-of-impact search could hang on a body wedged between shapes.)
    const light = group.reduce((a, id) => a + this.framing.members[id]!.mass, 0) < DETAIL.lightKg;
    const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(t.x, t.y, t.z).setRotation(r).setCanSleep(true).setAngularDamping(0.3).setSoftCcdPrediction(SOFT_CCD_M);
    if (from.isDynamic()) {
      const v = from.linvel();
      const w = from.angvel();
      desc.setLinvel(v.x, v.y, v.z).setAngvel(w);
    }
    const body = this.sw.world.createRigidBody(desc);
    if (light) this.sw.lightBodies.set(body.handle, this);
    for (const id of group) this.addColliders(id, body);
    this.groupBodies.set(body.handle, group);
    this.sw.bornAt.set(body.handle, this.sw.time);
    for (const [h, handle] of supported) h.wakeRubble(handle);
  }

  /**
   * Launch (Spec 12): `members` become one free body, centered at `center` (world), moving at
   * `vel` and spinning at `spin`, turned so their longest axis lies along `axis` if given. They
   * break away from everything else (connections among them stay as they are, so the body can
   * still come apart under load). Only members still on the house or never built (a stripped
   * donor's) can be launched; members already flying are left alone. Their contacts count at
   * once: they were never attached, so there is no separation grace. Built by the same code as
   * members torn loose.
   */
  launch(members: readonly number[], center: Vec3, vel: Vec3, spin: Vec3, axis?: Vec3): RAPIER.RigidBody | null {
    const f = this.framing;
    const ids = [...new Set(members)].filter((id) => id >= 0 && id < f.members.length && !this.lightOf.has(id) && (!this.bodyOf[id] || this.bodyOf[id] === this.body));
    if (!ids.length) return null;
    const set = new Set(ids);
    for (const id of ids) {
      this.lost[id] = false;
      this.attached[id] = false;
      for (const c of [...f.supportsOf[id]!, ...f.carriesOf[id]!]) {
        const con = f.connections[c]!;
        this.intact[c] = set.has(con.from) && (con.to < 0 ? false : set.has(con.to)) ? this.intact[c]! : false;
      }
    }
    this.makeBody(ids, this.body);
    // Whatever lost its support to the launch falls as usual.
    this.detach();
    const body = this.bodyOf[ids[0]!]!;
    // House-local center of the group's boxes, and its longest axis.
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const id of ids) {
      const m = f.members[id]!;
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
    const c: Vec3 = { x: (lo[0]! + hi[0]!) / 2, y: (lo[1]! + hi[1]!) / 2, z: (lo[2]! + hi[2]!) / 2 };
    let q: Q = this.houseQ;
    if (axis) {
      const d = [0, 1, 2].map((k) => hi[k]! - lo[k]!);
      const k = d.indexOf(Math.max(...d));
      const local: Vec3 = { x: k === 0 ? 1 : 0, y: k === 1 ? 1 : 0, z: k === 2 ? 1 : 0 };
      q = qmul(rotationBetween(qrot(this.houseQ, local), axis), this.houseQ);
    }
    const off = qrot(q, c);
    body.setRotation(rot(q), true);
    body.setTranslation({ x: center.x - off.x, y: center.y - off.y, z: center.z - off.z }, true);
    body.setLinvel(vel, true);
    body.setAngvel(spin, true);
    this.sw.bornAt.set(body.handle, this.sw.time - 1);
    return body;
  }

  /** Where a member is and how it moves: on its loose body or light piece (null if attached or
   *  lost). For tests and the wind tunnel. */
  freeState(id: number): { center: Vec3; vel: Vec3; members: number[]; bornAt: number } | null {
    const lp = this.lightOf.get(id);
    if (lp) return { center: { ...lp.piece.pos }, vel: { ...lp.piece.vel }, members: [...lp.members], bornAt: lp.piece.bornAt };
    const b = this.bodyOf[id];
    if (!b || b === this.body) return null;
    const g = this.groupBodies.get(b.handle) ?? this.rubble.get(b.handle);
    if (!g) return null;
    // The group's box center, as placed.
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const m of g) {
      const mm = this.framing.members[m]!;
      for (const sh of mm.shapes)
        for (const p of shapePoints(sh)) {
          const q = qrot(mm.q, p);
          const v = [mm.pos.x + q.x, mm.pos.y + q.y, mm.pos.z + q.z];
          for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k]!, v[k]!);
            hi[k] = Math.max(hi[k]!, v[k]!);
          }
        }
    }
    const t = b.translation();
    const r = b.rotation();
    const off = qrot([r.x, r.y, r.z, r.w], { x: (lo[0]! + hi[0]!) / 2, y: (lo[1]! + hi[1]!) / 2, z: (lo[2]! + hi[2]!) / 2 });
    const v = b.linvel();
    return { center: { x: t.x + off.x, y: t.y + off.y, z: t.z + off.z }, vel: { x: v.x, y: v.y, z: v.z }, members: [...g], bornAt: this.sw.bornAt.get(b.handle) ?? -Infinity };
  }

  /** Rubble body of a member, if it's resting rubble. */
  rubbleHandleOf(id: number): number | null {
    const b = this.bodyOf[id];
    return b && this.rubble.has(b.handle) ? b.handle : null;
  }

  /** Is the group's body touching only the ground, slabs, rubble or still pieces (not a
   *  standing house, which its weight must keep loading)? */
  private onlyFixedContacts(body: RAPIER.RigidBody): boolean {
    const world = this.sw.world;
    for (let i = 0; i < body.numColliders(); i++) {
      let ok = true;
      world.contactPairsWith(body.collider(i), (other) => {
        const p = other.parent();
        if (!p || p.handle === body.handle) return;
        // Leaning on a standing house: stays a body, so its weight keeps loading the structure
        // (two fixed bodies never touch in Rapier).
        const o = this.sw.owner.get(other.handle);
        if (p.isFixed() && o && o.house.isAttached(o.id)) {
          ok = false;
          return;
        }
        if (p.isFixed() || p.isSleeping()) return;
        // A neighbour that is itself still counts as settled (else two pieces lying against
        // each other would wait for each other forever).
        const v = p.linvel();
        const w = p.angvel();
        if (Math.hypot(v.x, v.y, v.z) >= DETAIL.rubbleSpeed || Math.hypot(w.x, w.y, w.z) >= DETAIL.rubbleSpin) ok = false;
      });
      if (!ok) return false;
    }
    return true;
  }

  /** Fix a still group in place as rubble (exactly where it lies). */
  private retire(handle: number, group: number[], body: RAPIER.RigidBody): void {
    body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
    this.groupBodies.delete(handle);
    this.stillSince.delete(handle);
    this.rubble.set(handle, group);
  }

  /** Bring rubble back to life (at rest), with any rubble touching it (resting or leaning on
   *  it: a pile wakes together). */
  wakeRubble(handle: number): void {
    const group = this.rubble.get(handle);
    if (!group) return;
    const body = this.sw.world.getRigidBody(handle);
    const touching = this.sw.rubbleTouching(Array.from({ length: body.numColliders() }, (_, i) => body.collider(i)));
    this.rubble.delete(handle);
    body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.groupBodies.set(handle, group);
    for (const [h, other] of touching) h.wakeRubble(other);
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
        for (const f of [local, avg])
          f[m.id] = {
            x: f[m.id]!.x + c.x,
            y: f[m.id]!.y + c.y,
            z: f[m.id]!.z + c.z,
          };
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
        return {
          x: t.x - along * m.normal.x,
          y: t.y,
          z: t.z - along * m.normal.z,
        };
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

  private holdDowns: {
    isHoldDown: boolean[];
    byWall: Map<number, number[][]>;
  } | null = null;
  /** Each rafter pair's connections to each bearing wall face, rafters in order along the ridge. */
  private rafterHoldDowns() {
    if (this.holdDowns) return this.holdDowns;
    const f = this.framing;
    const isHoldDown = f.connections.map(() => false);
    const rafters = f.members.filter((m) => m.kind === "rafterPair").sort((a, b) => a.pos.x - b.pos.x);
    const byWall = new Map<number, number[][]>();
    for (const face of [1, 3])
      byWall.set(
        face,
        rafters.map(() => []),
      );
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
    this.platesOf.delete(body.handle);
    this.massOf.delete(body.handle);
    for (let i = 0; i < body.numColliders(); i++) this.sw.owner.delete(body.collider(i).handle);
    this.sw.bornAt.delete(body.handle);
    this.sw.forgetBody(body.handle);
    this.sw.world.removeRigidBody(body);
  }

  /** Aerodynamic forces on the house's moving groups, per member plate, from the wind where it is. */
  aero(wind: WindSource): void {
    const world = this.sw.world;
    // Rubble the wind could now move (lift above its weight, or push past friction) wakes.
    if (this.rubble.size && this.rubbleTick++ % DETAIL.rubbleWindEvery === 0) {
      const wake: number[] = [];
      for (const [handle, group] of this.rubble) {
        const body = world.getRigidBody(handle);
        const tr = body.worldCom();
        const wc = wind.at(tr);
        if (Math.hypot(wc.x, wc.y, wc.z) < 0.5) continue;
        const rq = body.rotation();
        const plates = this.platesOf.get(handle) ?? bodyPlates(this.framing.members, group, this.plateExtent);
        this.platesOf.set(handle, plates);
        const M = this.massOf.get(handle) ?? group.reduce((a, id) => a + this.framing.members[id]!.mass, 0);
        this.massOf.set(handle, M);
        const still = { x: 0, y: 0, z: 0 };
        const { force: F } = rigidAero(
          {
            t: body.translation(),
            q: [rq.x, rq.y, rq.z, rq.w],
            com: tr,
            v: still,
            w: still,
          },
          plates,
          (p) => wind.at(p),
          group.length <= 8 ? wc : null,
          this.plateForces,
        );
        const W = M * GRAVITY;
        if (F.y >= W || Math.hypot(F.x, F.z) >= REST_FRICTION * (W - F.y)) wake.push(handle);
      }
      for (const h of wake) this.wakeRubble(h);
    }
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
      // Resting rubble: still long enough, touching only fixed things.
      if (Math.hypot(lv.x, lv.y, lv.z) < DETAIL.rubbleSpeed && spin < DETAIL.rubbleSpin) {
        const since = this.stillSince.get(handle) ?? this.sw.time;
        this.stillSince.set(handle, since);
        if (this.sw.time - since >= DETAIL.rubbleAfterS - 1e-9 && this.onlyFixedContacts(body)) {
          // A light piece at rest goes to the debris model (as a sleeping one does); the rest
          // become rubble.
          const light = this.sw.time - (this.sw.bornAt.get(handle) ?? 0) >= DETAIL.lightAfterS && (this.massOf.get(handle) ?? group.reduce((a, id) => a + this.framing.members[id]!.mass, 0)) < DETAIL.lightKg;
          if (!(light && this.toLight(group, body, true))) this.retire(handle, group, body);
          continue;
        }
      } else this.stillSince.delete(handle);
      if (spin > MAX_SPIN)
        body.setAngvel(
          {
            x: (av.x * MAX_SPIN) / spin,
            y: (av.y * MAX_SPIN) / spin,
            z: (av.z * MAX_SPIN) / spin,
          },
          true,
        );
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
      const rq = body.rotation();
      const t = body.translation();
      let plates = this.platesOf.get(handle);
      if (!plates) {
        plates = bodyPlates(this.framing.members, group, this.plateExtent);
        this.platesOf.set(handle, plates);
      }
      let M = this.massOf.get(handle);
      if (M === undefined) {
        M = group.reduce((a, id) => a + this.framing.members[id]!.mass, 0);
        this.massOf.set(handle, M);
      }
      for (const id of group) this.aeroForce[id] = ZERO;
      // Wind varies over tens of metres: one sample at the center serves a piece smaller than a
      // few metres; large chunks sample it at each member.
      const oneSample = group.length <= 8 ? wind.at(tr) : null;
      const forces = this.plateForces;
      const { force: F, torque: T } = rigidAero({ t, q: [rq.x, rq.y, rq.z, rq.w], com: tr, v, w }, plates, (p) => wind.at(p), oneSample, forces);
      // A piece at rest stays put until the wind can lift it or overcome friction; waking it
      // for less only makes the solver re-settle it every step (visible trembling).
      if (asleep) {
        const W = M * GRAVITY;
        if (F.y < W && Math.hypot(F.x, F.z) < REST_FRICTION * (W - F.y)) continue;
      }
      for (let i = 0; i < plates.length; i++) this.aeroForce[plates[i]!.id] = forces[i]!;
      // Wake only a sleeping piece the wind can move: waking resets Rapier's sleep timer, so
      // passing it every step would keep settled debris awake (and trembling) forever.
      body.addForce(F, asleep);
      body.addTorque(T, asleep);
    }
  }

  /** Light members whose pose changed this step (moving, or just came to rest). */
  readonly lightChanged: number[] = [];
  /** Light pieces that moved this step (their members are in `lightChanged`). */
  private readonly lightMoved: LightPiece[] = [];
  private lightTick = 0;

  /**
   * Move a light group (one member or a small chunk) from its Rapier body onto a Spec 04
   * debris piece, if it's airborne high enough to tumble freely, small, lying flat on the
   * ground, or at rest (kept exactly as it lies). Not while a large piece tumbles or rolls
   * along the ground: the debris model would lay it flat at once. Returns true if moved.
   */
  private toLight(group: number[], body: RAPIER.RigidBody, still = false): boolean {
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
    const c: Vec3 = {
      x: (lo[0]! + hi[0]!) / 2,
      y: (lo[1]! + hi[1]!) / 2,
      z: (lo[2]! + hi[2]!) / 2,
    };
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
    const rr = {
      x: center.x - com.x,
      y: center.y - com.y,
      z: center.z - com.z,
    };
    const first = this.framing.members[group[0]!]!;
    const piece: Piece = {
      id: group[0]!,
      kind: "osb",
      def: sheet(first.kind, d[long]!, d[mid]!, d[thin]!, mass),
      pos: center,
      vel: {
        x: v.x + (w.y * rr.z - w.z * rr.y),
        y: v.y + (w.z * rr.x - w.x * rr.z),
        z: v.z + (w.x * rr.y - w.y * rr.x),
      },
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
    const asleep = still || body.isSleeping();
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
    // Pushed clear of something fixed this step: its first pose is a collision correction.
    if (this.sw.pushed.has(body.handle)) piece.blocked = true;
    const lp: LightPiece = { piece, r, c, members: group };
    for (const id of group) {
      this.bodyOf[id] = null;
      this.lightOf.set(id, lp);
    }
    this.light.set(group[0]!, lp);
    this.sw.ownerOfLight.set(lp.piece, this);
    return true;
  }

  /** Step the house's light pieces on the Spec 04 model (no turbulence, ground contact only). */
  stepLight(wind: WindSource): void {
    this.lightChanged.length = 0;
    this.lightMoved.length = 0;
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
      // The houses around it (Spec 10 v0.6), and the ground under it: a slab top (this house's
      // or another's) or the ground.
      this.sw.ensureTown?.(p.pos.x, p.pos.z);
      const near = this.sw.townNear?.(p.pos.x, p.pos.z) ?? NO_HOUSES;
      const targets = { near: () => near };
      const floor = this.onSlab(p.pos) && p.pos.y - supportHeightOf(p) >= SLAB_TOP - 0.05 ? SLAB_TOP : near.length ? floorUnder(p, targets) : this.onSlab(p.pos) ? SLAB_TOP : 0;
      const from = { x: p.pos.x, y: p.pos.y, z: p.pos.z };
      const qFrom: Q = [p.q[0], p.q[1], p.q[2], p.q[3]];
      p.pos.y -= floor;
      // On the ground it feels the wind just above it (Spec 04 v1.6).
      stepPiece(p, wind.at({ x: p.pos.x, y: (p.grounded ? Math.max(p.pos.y, DEBRIS_REST_SAMPLE) : p.pos.y) + floor, z: p.pos.z }), STRUCT_DT);
      // Rough ground (Spec 04 v1.7): bumps hop sliding pieces into the wind.
      if (isSliding(p)) bumpKick(p, Math.hypot(p.vel.x, p.vel.z) * STRUCT_DT, DEBRIS.bumpSpacing[this.sw.terrain], this.rng);
      p.pos.y += floor;
      // Anything standing in the way (houses, rubble, other slabs): stop at it and bounce.
      // (Only near a house: in open air there is nothing to hit, and the sweep costs a query.)
      const close = (b: Building) => Math.hypot(p.pos.x - b.x, p.pos.z - b.z) < Math.hypot(b.width, b.depth) / 2 + p.def.dims[0] + 3 && p.pos.y - supportHeightOf(p) < b.wallHeight + b.roofRise + 2;
      if (close(this.building) || near.some(close)) this.blockLight(p, from, qFrom);
      if (near.length) unbury(p, targets);
      for (const id of lp.members) this.lightChanged.push(id);
      this.lightMoved.push(lp);
      if (Math.abs(p.pos.x) > GROUND_HALF - 50 || Math.abs(p.pos.z) > GROUND_HALF - 50 || p.pos.y > 5000) {
        this.light.delete(key);
        for (const id of lp.members) {
          this.lightOf.delete(id);
          this.lost[id] = true;
        }
        this.lostMembers += lp.members.length;
        this.lostWhy["left the area"] = (this.lostWhy["left the area"] ?? 0) + lp.members.length;
      }
    }
  }

  /** Stop a light piece where its box first meets something fixed, and bounce it off. */
  private blockLight(p: Piece, from: Vec3, qFrom: Q): void {
    p.blocked = false;
    // Still tangled in its own house where it tore off (a shard in its window frame, drywall
    // between studs): let it work itself free rather than pin it there. Once clear, it stays
    // clear (no need to ask again).
    if (!p.clearOfHouse) {
      if (this.sw.overlapsFixed(p, from, qFrom, this)) return;
      p.clearOfHouse = true;
    }
    const hit = this.sw.castLight(p, from);
    if (hit && hit.time_of_impact < 1) {
      // A house around the zone: the hit counts there (Spec 10 slice B).
      {
        const n = hit.normal1;
        const vn = -(p.vel.x * n.x + p.vel.y * n.y + p.vel.z * n.z);
        this.sw.recordTownHit(hit.collider, hit.witness1, p.def.mass, vn, p.def.dims, p.def.family, p.def.label);
      }
      // Into glass: its momentum may break the pane (it stops there this step either way).
      const o = this.sw.owner.get(hit.collider.handle);
      if (o) {
        const n = hit.normal1;
        const vn = -(p.vel.x * n.x + p.vel.y * n.y + p.vel.z * n.z);
        if (vn > 0) o.house.hitGlass(o.id, p.def.mass * vn, p.def.family === "sheet" ? "sheet" : "compact");
      }
      p.blocked = true;
      p.resting = false;
      const t = Math.max(hit.time_of_impact - 0.02, 0);
      p.pos = { x: from.x + (p.pos.x - from.x) * t, y: from.y + (p.pos.y - from.y) * t, z: from.z + (p.pos.z - from.z) * t };
      this.bounceLight(p, hit.normal1);
    }
    // Wherever it ended up, never inside anything fixed (a sweep misses a piece that turns
    // into a surface, or one that slips across the middle of a thin sheet it already touched).
    this.keepClear(p, from, qFrom);
  }

  /** Bounce a light piece's velocity off a surface with normal n (toward the piece). */
  private bounceLight(p: Piece, n: Vec3): void {
    const vn = -(p.vel.x * n.x + p.vel.y * n.y + p.vel.z * n.z);
    if (vn <= 0) return;
    const e = IMPACT.restitution;
    p.vel.x += (1 + e) * vn * n.x;
    p.vel.y += (1 + e) * vn * n.y;
    p.vel.z += (1 + e) * vn * n.z;
    const un = p.vel.x * n.x + p.vel.y * n.y + p.vel.z * n.z;
    const tx = p.vel.x - un * n.x;
    const ty = p.vel.y - un * n.y;
    const tz = p.vel.z - un * n.z;
    const vt = Math.hypot(tx, ty, tz);
    const keep = vt > 1e-9 ? Math.max(vt - IMPACT.friction * (1 + e) * vn, 0) / vt : 0;
    p.vel = { x: un * n.x + tx * keep, y: un * n.y + ty * keep, z: un * n.z + tz * keep };
  }

  /**
   * A light piece must end its step outside everything fixed (Spec 10 v0.9): if it only
   * overlaps now, it goes back to where (and how) it was; if it already overlapped, it is
   * pushed out along the surface's normal, 1 cm at a time, until clear.
   */
  private keepClear(p: Piece, from: Vec3, qFrom: Q): void {
    const sw = this.sw;
    const over = sw.overlappingFixed(p);
    if (!over) return;
    p.blocked = true;
    p.resting = false;
    if (!sw.overlappingFixed(p, from, qFrom)) {
      p.pos = { ...from };
      p.q = qFrom;
      const c = over.contactShape(sw.lightBox(p), p.pos, rot(p.q), 0);
      if (c) this.bounceLight(p, c.normal1);
      return;
    }
    for (let k = 0; k < 40; k++) {
      const col = sw.overlappingFixed(p);
      if (!col) break;
      // (Pushed out, never below the ground.)
      p.pos.y = Math.max(p.pos.y, supportHeightOf(p));
      const c = col.contactShape(sw.lightBox(p), p.pos, rot(p.q), 0);
      const n = sw.outward(col, c ? c.normal1 : { x: 0, y: 1, z: 0 }, p.pos);
      p.pos = { x: p.pos.x + n.x * 0.01, y: p.pos.y + n.y * 0.01, z: p.pos.z + n.z * 0.01 };
      const vn = p.vel.x * n.x + p.vel.y * n.y + p.vel.z * n.z;
      if (vn < 0) p.vel = { x: p.vel.x - vn * n.x, y: p.vel.y - vn * n.y, z: p.vel.z - vn * n.z };
    }
  }

  /** This house's slab collider (null once frozen). */
  get slabCollider(): RAPIER.Collider | null {
    return this.slab;
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
    if (!this.complete) this.build(Infinity);
    this.frozenPose = this.framing.members.map((m) => this.memberPose(m.id));
    for (const [h] of this.groupBodies) this.removeBody(this.sw.world.getRigidBody(h));
    for (const [h] of this.rubble) this.removeBody(this.sw.world.getRigidBody(h));
    this.groupBodies.clear();
    this.rubble.clear();
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
/** Shortest rotation taking unit vector a onto unit vector b. */
function rotationBetween(a: Vec3, bv: Vec3): Q {
  const l = Math.hypot(bv.x, bv.y, bv.z) || 1;
  const b = { x: bv.x / l, y: bv.y / l, z: bv.z / l };
  const d = a.x * b.x + a.y * b.y + a.z * b.z;
  if (d < -1 + 1e-9) {
    // Opposite: half a turn about any axis normal to a.
    const n = Math.abs(a.x) < 0.9 ? { x: 0, y: -a.z, z: a.y } : { x: a.z, y: 0, z: -a.x };
    const nl = Math.hypot(n.x, n.y, n.z);
    return [n.x / nl, n.y / nl, n.z / nl, 0];
  }
  const cx = a.y * b.z - a.z * b.y;
  const cy = a.z * b.x - a.x * b.z;
  const cz = a.x * b.y - a.y * b.x;
  const w = 1 + d;
  const n = Math.hypot(cx, cy, cz, w);
  return [cx / n, cy / n, cz / n, w / n];
}

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
 * along it by distance from the windward edge of the roof, blended by cos² / sin² of the angle.
 */

/**
 * The windward edge of the roof still standing, along the ridge (Spec 09 v0.13): from house-local
 * x, walk upwind along the attached rafter pairs (sorted x) until a gap wider than `gap`; the
 * edge is there, or the house end when the run reaches it. Returns the distance to it (m).
 */
export function windwardEdgeDistance(x: number, rafters: readonly number[], windAlongX: number, width: number, gap: number): number {
  const up = windAlongX >= 0 ? -1 : 1; // upwind direction along x
  const end = up * (width / 2);
  let e = x;
  // Rafters upwind of x (or at it), nearest first.
  const ordered = up < 0 ? rafters.filter((r) => r <= x + 1e-9).reverse() : rafters.filter((r) => r >= x - 1e-9);
  for (const r of ordered) {
    if (Math.abs(e - r) > gap) return Math.abs(x - e) + RAFTER_HALF_BAY;
    e = r;
  }
  // The run reaches the end of the house: the gable edge (when the end rafter stands).
  return Math.abs(e - end) <= gap ? Math.abs(x - end) : Math.abs(x - e) + RAFTER_HALF_BAY;
}
/** Half a rafter bay (m): the roof edge at a gap is half a bay beyond the last rafter. */
const RAFTER_HALF_BAY = 0.3;
export function roofMwfrsCp(p: Vec3, u: Vec3, width: number, h: number, edgeDist?: number): number {
  const s = Math.hypot(u.x, u.z);
  if (s < 1e-9) return ROOF_MWFRS.normalLeeward;
  const cn = u.z / s; // across the ridge
  const cp = u.x / s; // along the ridge
  // Windward slope: the side the wind reaches first (z opposite to the wind's z).
  const across = p.z * u.z < 0 ? ROOF_MWFRS.normalWindward : ROOF_MWFRS.normalLeeward;
  // Distance from the windward edge of the roof still standing (Spec 09 v0.13), or from the
  // windward gable when the whole roof stands.
  const d = edgeDist ?? (u.x >= 0 ? p.x + width / 2 : width / 2 - p.x);
  let along: number = ROOF_MWFRS.parallel[ROOF_MWFRS.parallel.length - 1]![1];
  for (const [upTo, c] of ROOF_MWFRS.parallel)
    if (d < upTo * h) {
      along = c;
      break;
    }
  return cn * cn * across + cp * cp * along;
}
