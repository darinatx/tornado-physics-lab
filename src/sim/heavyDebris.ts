/**
 * The heavy-debris world (Spec 04 v2.0): pieces of 40 kg or more from town houses (wall panels,
 * roof sections, deck sections, garage doors, heavy chunks) as rigid boxes in a Rapier world on
 * the sim thread, stepped with the debris step. They meet the ground, slabs, the standing parts
 * of the houses around them (Spec 10's town colliders) and each other; the wind acts on them as
 * on the detail zone's loose members (Spec 09's plate aerodynamics). Their Piece objects stay in
 * the debris field (rendering, bookkeeping, checks); this world writes their poses.
 */
import RAPIER from "@dimforge/rapier3d-simd-compat";
import { DEBRIS, HEAVY } from "../config/debris";
import { DETAIL } from "../config/structure";
import { GRAVITY } from "../config/atmosphere";
import type { Building } from "../core/damage/types";
import type { HeavySink } from "../core/debris/field";
import type { Piece } from "../core/debris/piece";
import type { Vec3 } from "../core/math/vec";
import { rigidAero } from "../core/structure/aero";
import { lyingOnSlab, overSlab } from "../core/impact/envelope";
import { IMPACT } from "../config/impacts";
import type { BodyPlate } from "../core/structure/aero";
import type { TerrainClass, TornadoState } from "../core/wind/types";
import { windAt } from "../core/wind/windField";
import { buildTownColliders, FIXED_GROUPS } from "./townColliders";
import type { TownHit } from "./structureWorld";

/** Zero velocity (never mutated). */
const STILL: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });
/** Ground extent (m), as the detail zone's. */
const GROUND_HALF = 10000;

interface Heavy {
  p: Piece;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  /** Index of the house it came from (−1: none). */
  source: number;
  bornAt: number;
  mass: number;
  plates: BodyPlate[];
  dims: [number, number, number];
  /** Its own house's surfaces it overlapped when made (it is tearing away from them: no
   *  contact with them for HEAVY.separationS); null until found, after its first step. */
  ignore: Set<number> | null;
  /** Order it was taken in (staggers its wind sampling). */
  k: number;
  /** Full CCD on (fast). */
  ccd: boolean;
  /** Wind at it, as last sampled. */
  wind: Vec3 | null;
  /** Moving slower than the rubble speeds since (s), or null. */
  stillSince: number | null;
  /** Asleep since (s), or null while awake. */
  asleepSince: number | null;
  /** Houses around it when it fell asleep (kept built while it sleeps). */
  houses: number[] | null;
  /** Snagging (Spec 04 v2.4): ground slid since its last snag (m), its snags so far, the draw
   *  for the next one (its distance is −λ·ln u), and the obstacle it is pinned against: the
   *  direction it was moving and how far along that it may go. */
  slid: number;
  snags: number;
  snagU: number;
  pin: { x: number; z: number; s: number } | null;
}

/**
 * A body's `n`-th snag draw in (0, 1] (Spec 04 v2.4): a hash of its id and n, so the same body
 * snags at the same places in-process, in a worker or lagging.
 */
export function snagDraw(id: number, n: number): number {
  let h = (Math.imul(id | 0, 0x9e3779b1) ^ Math.imul((n | 0) + 0x7f4a7c15, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return (h + 1) / 4294967296;
}

interface BuiltHouse {
  rev: number;
  /** The building the colliders were built from (a detailed house's stand-in changes object). */
  from: Building;
  colliders: RAPIER.Collider[];
}

export class HeavyDebris implements HeavySink {
  readonly world: RAPIER.World;
  private readonly events: RAPIER.EventQueue;
  private readonly bodies: Heavy[] = [];
  private readonly byCollider = new Map<number, Heavy>();
  /** Houses built as colliders, by index; and each collider's house and envelope plane. */
  private readonly built = new Map<number, BuiltHouse>();
  private readonly houseOf = new Map<number, number>();
  private readonly planeOf = new Map<number, number>();
  private readonly indexById: Map<number, number>;
  private readonly forces: Vec3[] = [];
  private stepCount = 0;
  /** Swept slabs whose heavy pieces have the wind until `at` (s), by house index (Spec 04 v2.4). */
  private readonly sweeps: { index: number; at: number }[] = [];
  private taken = 0;
  private time = 0;
  /** Hits on houses since the last step's call (drained by `step`'s caller). */
  readonly hits: TownHit[] = [];
  /** Wall time (ms) by phase, for profiling. */
  readonly ms = { houses: 0, aero: 0, physics: 0, poses: 0 };

  constructor(
    private readonly buildings: readonly Building[],
    private readonly near: (x: number, z: number) => readonly Building[],
    dt: number,
  ) {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = dt;
    this.world.integrationParameters.numSolverIterations = HEAVY.solverIterations;
    this.events = new RAPIER.EventQueue(true);
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(GROUND_HALF, 20, GROUND_HALF).setTranslation(0, -20, 0).setFriction(HEAVY.friction).setCollisionGroups(FIXED_GROUPS));
    this.indexById = new Map(buildings.map((b, i) => [b.id, i]));
  }

  /** Bodies in the world now (moving or resting). */
  get count(): number {
    return this.bodies.length;
  }

  take(p: Piece, b: Building, time: number): void {
    const [L, W, T] = p.def.dims;
    const volume = Math.max(L * W * T, 1e-6);
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(p.pos.x, p.pos.y, p.pos.z)
      .setRotation({ x: p.q[0], y: p.q[1], z: p.q[2], w: p.q[3] })
      .setLinvel(p.vel.x, p.vel.y, p.vel.z)
      .setAngvel(p.angVel ?? STILL)
      .setSoftCcdPrediction(HEAVY.softCcd);
    const body = this.world.createRigidBody(desc);
    // Box axes as the debris model's: X length, Y thickness, Z width.
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(L / 2, T / 2, W / 2)
        .setDensity(p.def.mass / volume)
        .setFriction(HEAVY.friction)
        .setRestitution(HEAVY.restitution)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS)
        .setContactForceEventThreshold(HEAVY.hitWeights * p.def.mass * GRAVITY),
      body,
    );
    // One plate: the box's broad face (normal along its thickness), with rotational drag about
    // its in-plane axes.
    const plates: BodyPlate[] = [{ id: 0, pos: { x: 0, y: 0, z: 0 }, n: { x: 0, y: 1, z: 0 }, area: L * W, ext: { a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 0, z: 1 }, la: L, lb: W } }];
    const h: Heavy = { p, body, collider, source: this.indexById.get(b.id) ?? -1, bornAt: time, mass: p.def.mass, plates, dims: [L, W, T], asleepSince: null, houses: null, stillSince: null, ignore: null, wind: null, ccd: false, k: this.taken++, slid: 0, snags: 0, snagU: snagDraw(p.id, 0), pin: null };
    this.bodies.push(h);
    this.byCollider.set(collider.handle, h);
    p.q = [p.q[0], p.q[1], p.q[2], p.q[3]];
    p.vel = { x: p.vel.x, y: p.vel.y, z: p.vel.z };
    p.resting = false;
    p.grounded = false;
  }

  /** Its own house's walls and roof that it overlaps when made don't stop it for its first
   *  moments (it is tearing away from them); its own slab and the rest of its house do. */
  private readonly hooks: RAPIER.PhysicsHooks = {
    filterContactPair: (c1, c2) => {
      const a = this.byCollider.get(c1);
      const b = this.byCollider.get(c2);
      const h = a ?? b;
      if (!h) return RAPIER.SolverFlags.COMPUTE_IMPULSE;
      const other = a ? c2 : c1;
      const house = this.houseOf.get(other);
      if (house === undefined || house !== h.source || !this.planeOf.has(other) || this.time - h.bornAt >= HEAVY.separationS) return RAPIER.SolverFlags.COMPUTE_IMPULSE;
      // Its own house's walls and roof: not those it overlaps as it tears away (all of them
      // until that's known, its first step); the rest stop it.
      return !h.ignore || h.ignore.has(other) ? null : RAPIER.SolverFlags.COMPUTE_IMPULSE;
    },
    filterIntersectionPair: () => true,
  };

  /** The house a piece hit stands for (a detailed house: its stand-in, as the sim's debris sees it). */
  private standing(b: Building): Building {
    return b.detail && b.standIn ? b.standIn : b;
  }

  /** Build or rebuild the colliders of the houses within reach of any body; drop the others
   *  once nothing has wanted them for a while (a body moving in and out would rebuild them). */
  private updateHouses(): void {
    const want = this.want;
    want.clear();
    for (const h of this.bodies) {
      // A sleeping body keeps only the house it lies on or against (its slab and walls hold it);
      // the rest come back the step it wakes.
      const asleep = h.asleepSince !== null;
      if (asleep && h.houses) {
        for (const i of h.houses) want.add(i);
        continue;
      }
      const t = h.body.translation();
      // High up there's nothing to hit: houses are built as it comes down.
      if (t.y > HEAVY.highY) {
        h.houses = null;
        continue;
      }
      const reach = asleep ? HEAVY.restReach : HEAVY.houseReach;
      let mine: number[] | null = asleep ? [] : null;
      for (const b of this.near(t.x, t.z)) {
        if (Math.hypot(b.x - t.x, b.z - t.z) > Math.hypot(b.width, b.depth) / 2 + reach) continue;
        const i = this.indexById.get(b.id);
        if (i === undefined) continue;
        want.add(i);
        mine?.push(i);
      }
      h.houses = mine;
    }
    for (const i of want) this.wantedAt.set(i, this.stepCount);
    for (const [i, built] of this.built)
      if (!want.has(i) && this.stepCount - (this.wantedAt.get(i) ?? 0) > HEAVY.keepHouseSteps) {
        this.removeHouse(built);
        this.built.delete(i);
        this.wantedAt.delete(i);
      }
    // Rebuild what changed (a failed component, a broken window): in index order.
    const order = this.order;
    order.length = 0;
    for (const i of want) {
      const b = this.standing(this.buildings[i]!);
      const had = this.built.get(i);
      if (!had || had.from !== b || had.rev !== b.rev) order.push(i);
    }
    order.sort((a, b) => a - b);
    for (const i of order) {
      const b = this.standing(this.buildings[i]!);
      const had = this.built.get(i);
      if (had) this.removeHouse(had);
      const planes = new Map<number, number>();
      const colliders = buildTownColliders(this.world, b, planes);
      for (const c of colliders) {
        this.houseOf.set(c.handle, i);
        c.setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS);
      }
      for (const [k, v] of planes) this.planeOf.set(k, v);
      this.built.set(i, { rev: b.rev, from: b, colliders });
    }
  }
  private readonly capped = new Set<Heavy>();
  private readonly want = new Set<number>();
  private readonly order: number[] = [];
  private readonly wantedAt = new Map<number, number>();

  private removeHouse(built: BuiltHouse): void {
    for (const c of built.colliders) {
      this.houseOf.delete(c.handle);
      this.planeOf.delete(c.handle);
      this.world.removeCollider(c, false);
    }
  }

  /**
   * One debris step: wind on every body (a sleeping one only wakes when the wind could move
   * it), the physics step, hits on houses, poses back to the pieces, and retirement into the
   * permanent debris field once the tornado has left a resting body behind.
   */
  step(s: TornadoState, terrain: TerrainClass, time: number): void {
    this.time = time;
    // Swept slabs whose wind has had its time: what still lies there goes (in sweep order).
    while (this.sweeps.length && this.sweeps[0]!.at <= time) this.carryOff(this.sweeps.shift()!.index);
    if (!this.bodies.length) return;
    let t0 = performance.now();
    this.updateHouses();
    this.ms.houses += performance.now() - t0;
    t0 = performance.now();
    const checkSleepers = this.stepCount++ % HEAVY.wakeEvery === 0;
    for (const h of this.bodies) {
      const body = h.body;
      const asleep = body.isSleeping();
      if (asleep && !checkSleepers) continue;
      body.resetForces(false);
      body.resetTorques(false);
      const com = body.worldCom();
      const tr = body.translation();
      const r = body.rotation();
      const q: [number, number, number, number] = [r.x, r.y, r.z, r.w];
      const v = asleep ? STILL : body.linvel();
      // The wind at a piece changes over tenths of a second: sampled every other step (and at
      // once for a new body).
      if (!h.wind || asleep || (this.stepCount + h.k) % 2 === 0) h.wind = windAt(com, s, terrain);
      const w = h.wind;
      if (asleep && Math.hypot(w.x, w.y, w.z) < 0.5) continue;
      const { force: F, torque: Tq } = rigidAero({ t: tr, q, com, v, w: asleep ? STILL : body.angvel() }, h.plates, () => w, w, this.forces);
      // Could the wind lift it or push it past friction?
      const Wt = h.mass * GRAVITY;
      const holds = F.y < Wt && Math.hypot(F.x, F.z) < HEAVY.friction * (Wt - F.y);
      if (asleep) {
        if (holds) continue;
      } else {
        // Still for a moment, and the wind can't move it: put it to sleep (the wind would keep
        // nudging it awake otherwise; the detail zone's rubble rule).
        const v = body.linvel();
        const om = body.angvel();
        if (Math.hypot(v.x, v.y, v.z) < DETAIL.rubbleSpeed && Math.hypot(om.x, om.y, om.z) < DETAIL.rubbleSpin) {
          h.stillSince ??= this.time;
          if (holds && this.time - h.stillSince >= DETAIL.rubbleAfterS) {
            body.sleep();
            continue;
          }
        } else h.stillSince = null;
      }
      body.addForce(F, asleep);
      body.addTorque(Tq, asleep);
    }
    this.ms.aero += performance.now() - t0;
    t0 = performance.now();
    // Soft CCD reaches past how far each body can move this step, spin included (Spec 10
    // v0.13, as the detail zone's loose bodies): fast thin sheets would end a step inside a wall.
    const dt = this.world.timestep;
    for (const h of this.bodies) {
      if (h.body.isSleeping()) continue;
      const v = h.body.linvel();
      const w = h.body.angvel();
      const radius = Math.hypot(h.dims[0], h.dims[1], h.dims[2]) / 2;
      const reach = (Math.hypot(v.x, v.y, v.z) + Math.hypot(w.x, w.y, w.z) * radius) * dt * HEAVY.ccdMargin;
      h.body.setSoftCcdPrediction(Math.max(HEAVY.softCcd, reach));
      // Moving more than half its thickness a step: full (time-of-impact) CCD, or a thin sheet
      // landing hard ends the step sunk into the ground.
      // (Not while it still overlaps a surface of its own house it is tearing away from: Rapier's
      // CCD doesn't consult the contact filter, so it would stop the piece there.)
      const clear = this.time - h.bornAt >= HEAVY.separationS || (h.ignore !== null && h.ignore.size === 0);
      const fast = clear && Math.hypot(v.x, v.y, v.z) * dt > h.dims[2] / 2;
      if (fast !== h.ccd) {
        h.body.enableCcd(fast);
        h.ccd = fast;
      }
    }
    this.world.step(this.events, this.hooks);
    // New bodies: which of their own house's surfaces they overlap (queries see colliders added
    // this step only now).
    // Young bodies: which of their own house's surfaces they still overlap. Only those are
    // passed (new bodies: queries see colliders added this step only now); once clear of a
    // surface, it stops them again.
    for (const h of this.bodies) {
      if (h.ignore && (h.ignore.size === 0 || this.time - h.bornAt >= HEAVY.separationS)) continue;
      const now = new Set<number>();
      if (h.source >= 0) {
        // Shrunk in its plane: neighbors that only touch it along an edge (the next roof
        // section, the next wall panel) still stop it.
        const [L, W, T] = h.dims;
        const core = new RAPIER.Cuboid(Math.max(L / 2 - HEAVY.edgeShrink, 0.01), T / 2, Math.max(W / 2 - HEAVY.edgeShrink, 0.01));
        this.world.intersectionsWithShape(h.body.translation(), h.body.rotation(), core, (c) => {
          if (this.houseOf.get(c.handle) === h.source && this.planeOf.has(c.handle) && (!h.ignore || h.ignore.has(c.handle))) now.add(c.handle);
          return true;
        });
      }
      h.ignore = now;
    }
    this.drainHits();
    this.ms.physics += performance.now() - t0;
    t0 = performance.now();
    const range = DEBRIS.settleRangeRmax * s.rMax;
    const sv = Math.hypot(s.velocity.x, s.velocity.z);
    // Over the cap: the longest-resting sleepers go first, then the slowest pieces creeping on
    // the ground (as of the last step).
    const over = this.bodies.length - HEAVY.maxBodies;
    const capped = this.capped;
    capped.clear();
    if (over > 0) {
      const ranked: [number, Heavy][] = [];
      for (const h of this.bodies) {
        // Not one the wind of a swept slab still has (it would be out of the sweep's reach).
        if (this.sweeps.length && this.inSweep(h)) continue;
        if (h.asleepSince !== null) ranked.push([h.asleepSince - 1e9, h]);
        else if (h.p.pos.y < HEAVY.creepY) {
          const v = Math.hypot(h.p.vel.x, h.p.vel.y, h.p.vel.z);
          if (v < HEAVY.creepSpeed) ranked.push([v, h]);
        }
      }
      ranked.sort((a, b) => a[0] - b[0] || a[1].p.id - b[1].p.id);
      for (let k = 0; k < Math.min(over, ranked.length); k++) capped.add(ranked[k]![1]);
    }
    let j = 0;
    for (const h of this.bodies) {
      const p = h.p;
      const asleep = h.body.isSleeping();
      // A sleeping body hasn't moved: its pose is as last written.
      if (!asleep || h.asleepSince === null) {
        this.keepAbove(h);
        this.snag(h, terrain);
        const t = h.body.translation();
        const r = h.body.rotation();
        p.pos.x = t.x;
        p.pos.y = t.y;
        p.pos.z = t.z;
        p.q[0] = r.x;
        p.q[1] = r.y;
        p.q[2] = r.z;
        p.q[3] = r.w;
        const v = h.body.linvel();
        p.vel.x = v.x;
        p.vel.y = v.y;
        p.vel.z = v.z;
      }
      p.resting = asleep;
      if (asleep) {
        h.asleepSince ??= time;
        p.restedAt = Math.min(p.restedAt, time);
      } else {
        h.asleepSince = null;
        p.restedAt = Infinity;
      }
      const t = p.pos;
      const gone = Math.abs(t.x) > GROUND_HALF - 50 || Math.abs(t.z) > GROUND_HALF - 50 || t.y < -5 || ![t.x, t.y, t.z].every(Number.isFinite);
      const dx = t.x - s.center.x;
      const dz = t.z - s.center.z;
      const behind = sv > 0 && dx * s.velocity.x + dz * s.velocity.z < 0 && Math.hypot(dx, dz) > HEAVY.retireRmax * s.rMax;
      const settled = h.asleepSince !== null && time - h.asleepSince >= HEAVY.retireAfterS;
      const left = s.vMax <= 0 || Math.hypot(dx, dz) > range || (settled && behind);
      if (gone || (asleep && left) || capped.has(h)) {
        // Retired: the debris field keeps it where it lies (or drops a lost one).
        this.byCollider.delete(h.collider.handle);
        this.world.removeRigidBody(h.body);
        p.rigid = false;
        p.resting = true;
        p.grounded = true;
        p.vel = { x: 0, y: 0, z: 0 };
        p.restedAt = time;
        p.settleNow = true;
        if (gone) p.hidden = true;
        continue;
      }
      this.bodies[j++] = h;
    }
    this.bodies.length = j;
    this.ms.poses += performance.now() - t0;
  }

  /**
   * House `index`'s slab was swept (Spec 04 v2.4): the bodies on it are woken and left to the
   * wind for HEAVY.sweepGraceS, then what still lies there is carried off (`carryOff`).
   */
  sweep(index: number): void {
    const b = this.buildings[index];
    if (!b) return;
    for (const h of this.bodies)
      if (h.body.isSleeping() && lyingOnSlab(b, h.body.translation())) {
        h.body.wakeUp();
        h.asleepSince = null;
      }
    this.sweeps.push({ index, at: this.time + HEAVY.sweepGraceS });
  }

  /**
   * Carry off what lies on house `index`'s swept slab (Spec 04 v2.3): bodies at rest or creeping
   * on it (below HEAVY.creepSpeed), and its own pieces still coming down over it at any speed
   * (what is left of the house). Other faster ones are left to the wind.
   */
  carryOff(index: number): void {
    const b = this.buildings[index];
    if (!b) return;
    const roofTop = IMPACT.slabTop + b.wallHeight + b.roofRise;
    let j = 0;
    for (const h of this.bodies) {
      const t = h.body.translation();
      const v = h.body.linvel();
      const at = { x: t.x, y: t.y, z: t.z };
      const lying = Math.hypot(v.x, v.y, v.z) < HEAVY.creepSpeed && lyingOnSlab(b, at);
      const ownFalling = h.source === index && at.y < roofTop && overSlab(b, at);
      if (lying || ownFalling) {
        this.byCollider.delete(h.collider.handle);
        this.world.removeRigidBody(h.body);
        const p = h.p;
        p.pos = at;
        p.rigid = false;
        p.resting = true;
        p.grounded = true;
        p.vel = { x: 0, y: 0, z: 0 };
        p.restedAt = this.time;
        p.settleNow = true;
        p.hidden = true;
        p.swept = true;
        continue;
      }
      this.bodies[j++] = h;
    }
    this.bodies.length = j;
  }

  /**
   * Nothing ends a step sunk into the ground or a slab (Spec 10 IMP-15/16): a thin sheet landing
   * hard sinks a few cm into Rapier's soft contact even with CCD. Its lowest corner is set back
   * on the surface under its center and its downward speed dropped (a stiffer contact).
   */
  private keepAbove(h: Heavy): void {
    const t = h.body.translation();
    const r = h.body.rotation();
    const [L, W, T] = h.dims;
    // Half the box's vertical extent: box X = L, Y = T, Z = W (as the debris model's).
    const rxY = 2 * (r.x * r.y + r.w * r.z);
    const ryY = 1 - 2 * (r.x * r.x + r.z * r.z);
    const rzY = 2 * (r.y * r.z - r.w * r.x);
    const sup = 0.5 * (Math.abs(rxY) * L + Math.abs(ryY) * T + Math.abs(rzY) * W);
    const floor = this.floorAt(t);
    const sink = floor - (t.y - sup);
    if (sink <= HEAVY.sinkTolerance) return;
    h.body.setTranslation({ x: t.x, y: t.y + sink, z: t.z }, true);
    const v = h.body.linvel();
    if (v.y < 0) h.body.setLinvel({ x: v.x, y: 0, z: v.z }, true);
  }

  /**
   * Snagging on the ground (Spec 04 v2.4): a body sliding on the ground catches on an obstacle
   * after −λ·ln u of sliding; it is then pinned (no motion into the obstacle) until it moves
   * away from it or is lifted HEAVY.snagClear above the ground.
   */
  private snag(h: Heavy, terrain: TerrainClass): void {
    const b = h.body;
    const t = b.translation();
    const floor = this.floorAt(t);
    const low = this.lowest(h, t, b.rotation()) - floor;
    const v = b.linvel();
    if (h.pin) {
      const along = v.x * h.pin.x + v.z * h.pin.z;
      if (low > HEAVY.snagClear || along < -HEAVY.snagRelease) {
        h.pin = null;
        return;
      }
      const s = t.x * h.pin.x + t.z * h.pin.z;
      if (s > h.pin.s) b.setTranslation({ x: t.x - (s - h.pin.s) * h.pin.x, y: t.y, z: t.z - (s - h.pin.s) * h.pin.z }, true);
      if (along > 0) b.setLinvel({ x: v.x - along * h.pin.x, y: v.y, z: v.z - along * h.pin.z }, true);
      return;
    }
    // Sliding on the ground (slabs are smooth concrete): the distance since its last pose.
    if (floor > 0 || low > HEAVY.snagGap) return;
    const dx = t.x - h.p.pos.x;
    const dz = t.z - h.p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) return;
    h.slid += d;
    if (h.slid < -DEBRIS.snagDistance[terrain] * Math.log(h.snagU)) return;
    // Caught: stopped dead against it, where it reached it.
    const over = h.slid + DEBRIS.snagDistance[terrain] * Math.log(h.snagU);
    const dir = { x: dx / d, z: dz / d };
    const at = { x: t.x - dir.x * over, y: t.y, z: t.z - dir.z * over };
    b.setTranslation(at, true);
    const along = v.x * dir.x + v.z * dir.z;
    b.setLinvel({ x: v.x - Math.max(along, 0) * dir.x, y: v.y, z: v.z - Math.max(along, 0) * dir.z }, true);
    h.pin = { x: dir.x, z: dir.z, s: at.x * dir.x + at.z * dir.z };
    h.slid = 0;
    h.snagU = snagDraw(h.p.id, ++h.snags);
  }

  /** On a swept slab whose wind still has it (as `carryOff` would take it then). */
  private inSweep(h: Heavy): boolean {
    const t = h.body.translation();
    for (const { index } of this.sweeps) {
      const b = this.buildings[index]!;
      if (lyingOnSlab(b, t) || (h.source === index && overSlab(b, t))) return true;
    }
    return false;
  }

  /** The surface under a point: a slab top or the ground. */
  private floorAt(t: Vec3): number {
    for (const b of this.near(t.x, t.z)) if (overSlab(b, t)) return IMPACT.slabTop;
    return 0;
  }

  /** Height of a body's lowest corner. */
  private lowest(h: Heavy, t: Vec3, r: { x: number; y: number; z: number; w: number }): number {
    const [L, W, T] = h.dims;
    const rxY = 2 * (r.x * r.y + r.w * r.z);
    const ryY = 1 - 2 * (r.x * r.x + r.z * r.z);
    const rzY = 2 * (r.y * r.z - r.w * r.x);
    return t.y - 0.5 * (Math.abs(rxY) * L + Math.abs(ryY) * T + Math.abs(rzY) * W);
  }

  /** Contacts with houses' walls, roofs and gables: impacts there (Spec 10), resting contact and
   *  a piece's own house during its first moments left out. */
  private drainHits(): void {
    const dt = this.world.timestep;
    this.events.drainContactForceEvents((e) => {
      for (const [mine, other] of [[e.collider1(), e.collider2()], [e.collider2(), e.collider1()]] as const) {
        const h = this.byCollider.get(mine);
        if (!h) continue;
        const plane = this.planeOf.get(other);
        const house = this.houseOf.get(other);
        if (plane === undefined || house === undefined) continue;
        if (house === h.source && this.time - h.bornAt < HEAVY.separationS && (!h.ignore || h.ignore.has(other))) continue;
        const col = this.world.getCollider(other);
        if (!col) continue;
        const t = h.body.translation();
        const d = [...h.dims].sort((a, b) => b - a) as [number, number, number];
        this.hits.push({
          house,
          plane,
          point: { x: t.x, y: t.y, z: t.z },
          mass: h.mass,
          vn: (e.totalForceMagnitude() * dt) / Math.max(h.mass, 1e-6),
          dims: d,
          family: d[2] < 0.3 ? "sheet" : "compact",
          label: h.p.def.label,
        });
      }
    });
  }

  dispose(): void {
    this.world.free();
    this.events.free();
  }
}
