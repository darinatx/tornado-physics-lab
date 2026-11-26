/**
 * Fixed-timestep simulation loop (Spec 08).
 */
import { DAMAGE_STEP_INTERVAL } from "../config/buildings";
import { SIM_DEFAULTS } from "../config/sim";
import { lifecycle, lifetime } from "../core/wind/lifecycle";
import type { Vec2 } from "../core/math/vec";
import { createRng } from "./rng";
import { createWorld } from "./world";
import { DebrisField } from "../core/debris/field";
import { DEBRIS, HEAVY } from "../config/debris";
import type { World } from "./world";
import { defaultParams } from "./types";
import type { SimConfig, SimFrame, SimSnapshot, TornadoParams } from "./types";
import { DETAIL } from "../config/structure";
import { buildFraming } from "../core/structure/framing";
import { removedOnEntry } from "../core/structure/survey";
import { DetailView } from "./detailBackend";
import type { DetailBackend } from "./detailBackend";
import { ZoneSelector } from "./detailZone";
import { DetailStandIns } from "./detailStandIns";
import type { HeavyDebris } from "./heavyDebris";
import { createLocalHeavy, LagSweeps } from "./heavyBackend";
import type { HeavyBackend } from "./heavyBackend";
import { HEAVY_STATE, HEAVY_STRIDE } from "./heavyEngine";
import type { HeavyResult, HeavyTake } from "./heavyEngine";
import type { Piece } from "../core/debris/piece";
import type { TownHit } from "./structureWorld";
import { surfaceAt, toLocal } from "../core/impact/envelope";
import type { PlaneId } from "../core/impact/envelope";
import { resolveImpact } from "../core/impact/impact";
import { townState } from "./townColliders";
import { tunnelState } from "./tunnelFlow";
import { pressureDeficit } from "../core/wind/pressure";
import type { TownState } from "./townColliders";
import { TERRAIN } from "../config/terrain";
import { CITY } from "./city";
import { TerrainSender } from "../core/terrain/roughness";
import type { GroundCover, Terrain } from "../core/terrain/roughness";
import type { TerrainClass } from "../core/wind/types";
import { TownRoughness, townCover } from "./terrain";
import { GroundTrack } from "./groundTrack";
import { TRACK } from "../config/terrain";

export interface Sim {
  /** Profiling only: the heavy-debris world, if made. */
  _heavy?: () => HeavyDebris | null;
  /** Advance by real elapsed seconds (clamped, then scaled by the time scale). */
  advance(realDtSeconds: number): SimFrame;
  /** Queue parameter changes; they apply at the start of the next step. */
  setParams(p: Partial<TornadoParams>): void;
  setTimeScale(k: number): void;
  /** Restart the run (new start position, time 0). Applies any queued params first. */
  reset(seed?: number): void;
  readonly time: number;
  readonly params: Readonly<TornadoParams>;
  readonly snapshot: SimSnapshot;
  readonly timeScale: number;
  /** The sim's seeded RNG. Nothing else may use Math.random. */
  readonly rng: () => number;
  /** The neighborhood and its damage state (read-only for callers). */
  readonly world: Pick<World, "buildings" | "buildingAt" | "near">;
  /** Detailed houses' member poses (Spec 09 slice B; read-only for callers). */
  readonly detail: DetailView;
  /** Detail physics is holding the sim back (it may not run more than 0.25 s ahead). */
  readonly detailLagging: boolean;
  /** The spot whose houses get member-level detail (null = none). Applies at the next step. */
  setDetailFocus(p: { x: number; z: number } | null): void;
  readonly detailFocus: { x: number; z: number } | null;
  /** Radius around the spot that holds its detail houses (m), for drawing it. */
  readonly detailSpotRadius: number;
  /** Detail physics cost per step (ms, smoothed), for display. */
  readonly detailStepMs: number;
  /** Stop its engines (workers): the sim can't be used afterwards. */
  dispose(): void;
  /** Add a read-only observer (Spec 13); returns its removal. Observers survive a reset. */
  observe(t: import("./types").SimTaps): () => void;
  /** Debris pool (read-only for callers). */
  readonly debris: Pick<
    DebrisField,
    "pieces" | "stats" | "cap" | "settled" | "settledDropped" | "settledVersion" | "massSpawned" | "massLofted" | "massSkipped" | "massSwept" | "massLeftMap" | "massBySource"
  >;
}

const DEG = Math.PI / 180;

function headingDir(deg: number): Vec2 {
  const a = deg * DEG;
  // Rotation about +Y by a maps +X to (cos a, -sin a).
  return { x: Math.cos(a), z: -Math.sin(a) };
}

export function createSim(
  config: Partial<SimConfig> = {},
  seed: number = SIM_DEFAULTS.seed,
  initial: Partial<TornadoParams> = {},
  /** Detail zone engine (Spec 09 slice B); none = component model everywhere. */
  makeDetail?: (seed: number, buildings: readonly import("../core/damage/types").Building[]) => DetailBackend,
): Sim {
  const dt = config.dt ?? SIM_DEFAULTS.dt;
  const maxFrameDt = config.maxFrameDt ?? SIM_DEFAULTS.maxFrameDt;
  const withBuildings = config.buildings ?? true;
  let world: World = createWorld(seed, withBuildings, config.area, config.houses);
  let debris = new DebrisField(seed);
  /** The roughness field (Spec 17), built on first use when the terrain is "auto". */
  let roughness: TownRoughness | null = null;
  /** Ground damage tracks (Spec 19), made at reset. */
  let track!: GroundTrack;
  const trackEvery = Math.max(1, Math.round(TRACK.updateInterval / dt));
  const heavyTerrain = new TerrainSender();
  const detailTerrain = new TerrainSender();
  const roughnessEvery = Math.max(1, Math.round(TERRAIN.updateInterval / dt));
  function terrainNow(): Terrain {
    if (config.terrainAt) return config.terrainAt(stepCount * dt);
    if (params.terrain !== "auto") return params.terrain;
    if (!withBuildings) return "open";
    roughness ??= new TownRoughness(config.cover ?? (config.houses ? { base: "farmland", rects: [] } : townCover(CITY.extent)), world.buildings);
    return roughness.field;
  }
  /** The ground cover to draw (Spec 17): the setting's, memoized so it changes only with it. */
  let coverMemo: { key: string; cover: GroundCover } | null = null;
  function coverNow(): GroundCover {
    const base: GroundCover = config.cover ?? (config.houses ? { base: "farmland", rects: [] } : townCover(CITY.extent));
    const key = config.terrainAt || params.terrain === "auto" ? "auto" : params.terrain;
    if (coverMemo?.key !== key) {
      const kind = ({ open: "farmland", suburban: "lawn", urban: "pavement" } as const)[key as TerrainClass];
      coverMemo = { key, cover: key === "auto" ? base : { base: kind, rects: [], ...(base.bounds ? { bounds: base.bounds } : {}) } };
    }
    return coverMemo.cover;
  }
  /**
   * Heavy pieces as rigid bodies (Spec 04 v2.0), in the heavy-debris engine beside the sim (a
   * worker in the app, Spec 04 v2.1), made when the first one is. Its results are applied
   * HEAVY.lagSteps debris steps after their step, whatever its timing.
   */
  let heavy: HeavyBackend | null = null;
  const heavyDt = dt * DEBRIS.stepInterval;
  let heavyN = 0;
  let heavyKey = 0;
  const heavyPieces = new Map<number, Piece>();
  let heavyTakes: HeavyTake[] = [];
  let heavyResults: HeavyResult[] = [];
  /** Each house's state version as last sent to the engine. */
  let heavySent: number[] = [];
  /** Swept slabs the engine hasn't caught up with (Spec 04 v2.3), and houses sent as swept. */
  const lagSweeps = new LagSweeps();
  let heavySwept: boolean[] = [];
  const attachHeavy = () => {
    debris.heavy = {
      take: (p, b, time) => {
        if (!heavy) {
          try {
            heavy = config.heavy ? config.heavy(currentSeed, world.buildings, heavyDt) : createLocalHeavy(world.buildings, heavyDt);
          } catch (e) {
            throw new Error(`heavy debris needs Rapier: call initRapier() before running the sim (${(e as Error).message})`);
          }
          heavySent = world.buildings.map(() => 0);
          heavyTerrain.reset();
        }
        const key = heavyKey++;
        heavyPieces.set(key, p);
        heavyTakes.push({ key, label: p.def.label, dims: [p.def.dims[0], p.def.dims[1], p.def.dims[2]], mass: p.def.mass, pos: { ...p.pos }, q: [p.q[0], p.q[1], p.q[2], p.q[3]], vel: { ...p.vel }, ...(p.angVel ? { angVel: { ...p.angVel } } : {}), source: indexById.get(b.id) ?? -1, time });
        p.resting = false;
        p.grounded = false;
      },
    };
  };
  attachHeavy();

  /** One heavy-debris step: the houses changed since last sent, the new pieces. */
  function heavyStep(pre: SimSnapshot): void {
    if (!heavy) return;
    const town: TownState[] = [];
    world.buildings.forEach((b, i) => {
      const k = revKey(b);
      if (heavySent[i] !== k) {
        heavySent[i] = k;
        const st = townState(i, b);
        town.push(st);
        if (st.sweep && !heavySwept[i]) {
          heavySwept[i] = true;
          lagSweeps.sent(b, heavyN);
        }
      }
    });
    heavy.post({ n: heavyN++, tornado: pre.tornado, terrain: heavyTerrain.pack(pre.terrain), time: pre.time, takes: heavyTakes, town });
    heavyTakes = [];
  }

  /** Apply the heavy-debris results up to step `cutoff`, in step order. */
  function applyHeavy(cutoff: number): void {
    if (!heavy) return;
    heavyResults.push(...heavy.drain());
    let k = 0;
    while (k < heavyResults.length && heavyResults[k]!.n <= cutoff) k++;
    if (!k) return;
    for (const r of heavyResults.splice(0, k)) {
      const P = r.poses;
      for (let o = 0; o < P.length; o += HEAVY_STRIDE) {
        const p = heavyPieces.get(P[o]!);
        if (!p) continue;
        p.pos.x = P[o + 1]!;
        p.pos.y = P[o + 2]!;
        p.pos.z = P[o + 3]!;
        p.q[0] = P[o + 4]!;
        p.q[1] = P[o + 5]!;
        p.q[2] = P[o + 6]!;
        p.q[3] = P[o + 7]!;
        p.vel.x = P[o + 8]!;
        p.vel.y = P[o + 9]!;
        p.vel.z = P[o + 10]!;
        const st = P[o + 11]!;
        if (st === HEAVY_STATE.moving) {
          p.resting = false;
          p.restedAt = Infinity;
        } else if (st === HEAVY_STATE.resting) {
          p.resting = true;
          p.restedAt = curr.time;
        } else {
          // Retired: the debris field keeps it where it lies (or drops a lost one).
          p.rigid = false;
          p.resting = true;
          p.grounded = true;
          p.vel.x = p.vel.y = p.vel.z = 0;
          p.restedAt = curr.time;
          p.settleNow = true;
          if (st === HEAVY_STATE.lost) p.hidden = true;
          // Carried off with a swept slab: by the engine, or (retired before the engine learned
          // of the sweep) here (Spec 04 v2.3).
          if (st === HEAVY_STATE.swept) {
            p.hidden = true;
            p.swept = true;
            debris.massSwept += p.def.mass * p.represents;
          }
          heavyPieces.delete(P[o]!);
          // Retired before the engine learned its slab was swept: back to the wind (v2.4).
          const on = st === HEAVY_STATE.retired ? lagSweeps.catches(p.pos, r.n) : null;
          if (on) debris.retake(p, on, curr.time);
        }
      }
      // Its hits on houses, in a fixed order.
      const hits = r.hits.sort((a, b) => a.house - b.house || a.point.x - b.point.x || a.point.z - b.point.z || a.point.y - b.point.y || a.vn - b.vn);
      for (const h of hits) applyTownHit(h, "heavy");
      lagSweeps.applied(r.n);
    }
  }
  /** Building id → index (impacts on stand-ins name the house by id). */
  let indexById = new Map<number, number>();
  /** Every observer, through one fan-out (Spec 13: the record, a recorder, the tunnel). */
  const observers = new Set<import("./types").SimTaps>(config.taps ? [config.taps] : []);
  const taps: import("./types").SimTaps = {
    impact: (...a) => {
      for (const o of observers) o.impact?.(...a);
    },
    detailFailure: (...a) => {
      for (const o of observers) o.detailFailure?.(...a);
    },
    debrisStep: (...a) => {
      for (const o of observers) o.debrisStep?.(...a);
    },
  };
  const fixedZone = config.detailSet?.map((d) => d.index);
  const detailSet = new Map((config.detailSet ?? []).map((d) => [d.index, d] as const));

  let params: TornadoParams = { ...defaultParams(), ...initial };
  let pending: Partial<TornadoParams> | null = null;
  let currentSeed = seed;
  let rng = createRng(seed);
  let stepCount = 0;
  let headingDeg = params.heading;
  let center: Vec2 = { x: 0, z: 0 };
  let acc = 0;
  let timeScale = 1;
  let prev: SimSnapshot;
  let curr: SimSnapshot;
  let detail: DetailBackend | null = null;
  let zone = new ZoneSelector(config.detailHouses, fixedZone, config.detailPinned);
  const detailView = new DetailView();
  /** Detailed houses as town debris sees them (Spec 10 v0.7). */
  const standIns = new DetailStandIns();
  /** Detail pieces' hits on houses around the zone, waiting for their cutoff (in step order). */
  const townHits: { n: number; h: TownHit }[] = [];
  /** Draws for those hits' fragility (perforation), deterministic in hit order. */
  let hitRng = createRng(seed ^ 0x2c1b3c6d);
  function applyTownHit(h: TownHit, path: "detail" | "heavy" = "detail"): void {
    const house = world.buildings[h.house];
    // A detailed house in another physics group was hit through its stand-in there: resolve
    // it on the stand-in, which forwards it to the detail engine like the town's debris hits
    // (Spec 10 v0.11).
    const b = house?.detail ? house.standIn : house;
    if (!b || b.sweep.failed) return;
    const local = toLocal(b, h.point);
    const surface = surfaceAt(b, h.plane as PlaneId, local);
    const out = resolveImpact(b, surface, { label: h.label, family: h.family, mass: h.mass, dims: h.dims }, h.vn, hitRng, true, local);
    if (out) {
      b.impacts.push(out.impact);
      taps.impact?.(h.house, out.impact, path === "heavy" ? "debris" : "detail", null, stepCount * dt);
    }
  }
  let detailN = 0;
  /** Houses that left the zone and haven't frozen yet: their pieces still need steps. */
  const settling = new Set<number>();
  let lagging = false;
  let stepMs = 0;
  // No spot until the user picks one: the detail zone is opt-in (it slows the sim while its
  // houses are torn apart).
  let focus: { x: number; z: number } | null = null;
  let pendingFocus: { x: number; z: number } | null | undefined = undefined;
  /** Detail steps the sim may be ahead of the engine. */
  const maxLead = Math.round(DETAIL.maxLeadS / (dt * DETAIL.stepEvery));

  function detailStep(pre: SimSnapshot): void {
    if (!detail) return;
    if (pendingFocus !== undefined) {
      focus = pendingFocus;
      pendingFocus = undefined;
    }
    const ops = zone.update(pre.tornado, world.buildings, focus);
    const town = townChanges();
    const enter = ops.enter.map((i) => {
      const b = world.buildings[i]!;
      b.detail = true;
      b.rev++;
      const framing = buildFraming(b);
      detailView.add(i, b, framing);
      standIns.add(i, b, framing);
      const set = detailSet.get(i);
      // A stripped house (the wind tunnel's donors) enters with every member removed.
      const gone = set?.stripped ? framing.members.map(() => true) : removedOnEntry(b, framing);
      return { index: i, removed: gone.flatMap((g, id) => (g ? [id] : [])), ...(set?.group !== undefined ? { group: set.group } : {}) };
    });
    for (const i of ops.exit) settling.add(i);
    // Nothing in the zone, nothing settling and nothing changing: don't make the sim wait on an
    // empty step. (Houses that left keep getting steps until they freeze, Spec 09 v0.15: before,
    // the last ones to leave were never stepped again, their pieces hanging wherever they were.)
    if (!enter.length && !ops.exit.length && zone.active.size === 0 && settling.size === 0) return;
    // Sent: these states are now what the engine has.
    for (const st of town) sentRev.set(st.index, revKey(world.buildings[st.index]!));
    // The town's debris hits on detailed houses since the last step (Spec 10 slice B).
    const debrisHits = standIns.forward.splice(0).map(({ index, impact: q }) => ({ index, surface: q.surface, component: q.index, face: q.face, broke: q.broke, perforated: q.perforated, force: q.force, ...(q.coverTorn ? { coverTorn: true } : {}), ...(q.sidingTorn ? { sidingTorn: true } : {}), ...(q.at ? { at: q.at } : {}) }));
    const launches = config.inject?.detail?.(pre.time);
    detail.post({ n: detailN++, tornado: pre.tornado, terrain: detailTerrain.pack(pre.terrain), enter, exit: ops.exit, town, debrisHits, ...(launches?.length ? { launches } : {}), ...(config.inspect?.length ? { inspect: config.inspect } : {}) });
  }

  /**
   * Houses whose state the engine doesn't have yet (Spec 10 v0.9): every house in town (pieces
   * can fly far), sent again whenever its damage changes; a detailed house as its stand-in.
   * Deterministic: decided from the sim's state at this step, posted in step order.
   */
  const sentRev = new Map<number, number>();
  /** A house's state version: its revision, or (detailed) minus its stand-in's revision. */
  const revKey = (b: import("../core/damage/types").Building) => (b.detail && b.standIn ? -1 - b.standIn.rev : b.rev);
  function townChanges(): TownState[] {
    if (!focus) return [];
    const out: TownState[] = [];
    world.buildings.forEach((b, i) => {
      if (sentRev.get(i) !== revKey(b)) out.push(townState(i, b));
    });
    return out;
  }

  function applyDetail(): void {
    if (!detail) return;
    for (const r of detail.drain()) {
      stepMs += (r.ms - stepMs) * 0.05;
      detailView.apply(r.poses);
      if (r.inspect) for (const x of r.inspect) detailView.inspected(x.house, x.loads, x.attached, r.n);
      standIns.record(r.n, r.poses);
      for (const h of r.townHits) townHits.push({ n: r.n, h });
      for (let k = 0; k < r.dods.length; k += 2) world.setDod(world.buildings[r.dods[k]!]!, r.dods[k + 1]!);
      // The inspector's failure list: connection failures by type, in order.
      for (const f of r.failLog) {
        taps.detailFailure?.(f.house, f, curr.time);
        if (f.con !== undefined) detailView.failed(f.house, f.con, { time: curr.time, mph: f.mph, load: f.load });
        const b = world.buildings[f.house]!;
        const list = (b.detailFailures ??= []);
        const g = list.find((x) => x.label === f.label);
        if (g) g.count++;
        else {
          // Glass breaks a whole pane at once (one failure for all its shards): count windows.
          const framing = detailView.houses.get(f.house)?.framing;
          const cons = framing ? framing.connections.filter((c) => c.label === f.label) : [];
          const panes = new Set(cons.map((c) => framing!.members[c.from]!.pane));
          const glass = cons.length > 0 && !panes.has(undefined);
          list.push({ label: f.label, count: 1, total: glass ? panes.size : cons.length, unit: glass ? "windows" : "connections", time: curr.time, load: f.load, capacity: f.capacity, mph: f.mph });
        }
      }
      for (const f of r.frozen) settling.delete(f.index);
      for (const f of r.frozen)
        if (f.undamaged) {
          // Untouched: back to the component model, which draws it the same.
          world.buildings[f.index]!.detail = false;
          world.buildings[f.index]!.rev++;
          detailView.remove(f.index);
          standIns.remove(f.index, world.buildings[f.index]!);
        }
    }
  }

  function startPosition(): Vec2 {
    if (config.start) return { x: config.start.x, z: config.start.z };
    // Center the full path on the origin so the whole lifecycle stays on the map.
    const d = headingDir(headingDeg);
    const half = (lifetime(params) * params.translationSpeed) / 2;
    return { x: -d.x * half, z: -d.z * half };
  }

  function makeSnapshot(): SimSnapshot {
    const t = stepCount * dt;
    const lc = lifecycle(t, params);
    const d = headingDir(headingDeg);
    const tornado = config.tunnel
      ? tunnelState(config.tunnel(t), params)
      : Object.freeze({
          center: Object.freeze({ x: center.x, z: center.z }),
          velocity: Object.freeze({ x: d.x * params.translationSpeed, z: d.z * params.translationSpeed }),
          vMax: lc.vMax,
          rMax: lc.rMax,
          alpha: params.alpha,
          outerReach: params.outerReach,
          inflowRatio: params.inflowRatio,
          inflowDepth: params.inflowDepth,
          updraftMax: params.updraftMax,
          overshoot: params.overshoot,
          zPeak: params.zPeak,
          rotation: params.rotation,
        });
    return Object.freeze({
      time: t,
      step: stepCount,
      terrain: terrainNow(),
      groundCover: coverNow(),
      groundTrack: track,
      cloudBase: params.cloudBase,
      phase: lc.phase,
      lifetime: lifetime(params),
      damageVersion: world.version,
      damageHistogram: Object.freeze([...world.histogram]),
      debris: Object.freeze({ ...debris.stats }),
      tornado,
    });
  }

  function applyPending(): void {
    if (!pending) return;
    const headingChanged = pending.heading !== undefined && pending.heading !== params.heading;
    params = { ...params, ...pending };
    if (headingChanged) headingDeg = params.heading;
    pending = null;
  }

  function step(): void {
    applyPending();
    const d = headingDir(headingDeg);
    center = {
      x: center.x + d.x * params.translationSpeed * dt,
      z: center.z + d.z * params.translationSpeed * dt,
    };
    headingDeg += params.turnRate * dt;
    stepCount++;
    // Roughness follows the buildings as they fail, at fixed sim times (Spec 17).
    if (roughness && params.terrain === "auto" && stepCount % roughnessEvery === 0) roughness.update(world.buildings, track);
    prev = curr;
    const pre = makeSnapshot();
    const damageStep = stepCount % DAMAGE_STEP_INTERVAL === 0;
    // Ground damage tracks (Spec 19), at fixed sim times.
    if (stepCount % trackEvery === 0) track.update(trackEvery * dt, pre.tornado, pre.terrain, debris.pieces);
    const T = config.timing;
    let t0 = T ? performance.now() : 0;
    if (stepCount % DETAIL.stepEvery === 0) detailStep(pre);
    if (T) {
      const t1 = performance.now();
      T.detail += t1 - t0;
      t0 = t1;
    }
    if (damageStep) {
      world.update(dt * DAMAGE_STEP_INTERVAL, pre.tornado, pre.terrain, pre.time, (b, rec) => debris.spawnFrom(b, rec));
    }
    if (T) {
      const t1 = performance.now();
      T.damage += t1 - t0;
      t0 = t1;
    }
    if (stepCount % DEBRIS.stepInterval === 0) {
      // Detailed houses as of the newest detail step whose results are certain to be in.
      const cutoff = detailN - maxLead - 1;
      standIns.advance(cutoff);
      // Pieces lodged in a detailed house's surfaces that are now gone fall free (Spec 10 v0.12).
      for (const [c, part, index] of standIns.gone) debris.releaseSurface(c, part, index);
      // Detail pieces' hits on the houses around the zone, at the same cutoff (Spec 10 slice B).
      let k = 0;
      while (k < townHits.length && townHits[k]!.n <= cutoff) k++;
      if (k) {
        // In a fixed order (not the workers'), so the draws don't depend on the worker count.
        const due = townHits.splice(0, k).sort((a, b) => a.n - b.n || a.h.house - b.h.house || a.h.point.x - b.h.point.x || a.h.point.z - b.h.point.z || a.h.point.y - b.h.point.y || a.h.vn - b.h.vn);
        for (const t of due) applyTownHit(t.h);
      }
      config.inject?.debris?.(pre.time, debris);
      // Heavy pieces first, so the debris field's counts see where they are now.
      if (heavy) {
        const th = T ? performance.now() : 0;
        heavyStep(pre);
        applyHeavy(heavyN - 1 - HEAVY.lagSteps);
        if (T) T.heavy += performance.now() - th;
      }
      const td = T ? performance.now() : 0;
      debris.step(dt * DEBRIS.stepInterval, pre.tornado, pre.terrain, damageStep, pre.time, pre.cloudBase, world);
      if (T) T.debris += performance.now() - td;
      if (observers.size) taps.debrisStep?.(pre.time);
    }
    curr = makeSnapshot();
  }

  function reset(newSeed?: number): void {
    applyPending();
    if (newSeed !== undefined) currentSeed = newSeed;
    rng = createRng(currentSeed);
    world = createWorld(currentSeed, withBuildings, config.area, config.houses);
    debris = new DebrisField(currentSeed);
    roughness = null;
    track = new GroundTrack(coverNow());
    debris.marks = track;
    heavyTerrain.reset();
    detailTerrain.reset();
    debris.dispersion = config.dispersion ?? true;
    heavy?.dispose();
    heavy = null;
    heavyN = 0;
    heavyKey = 0;
    heavyPieces.clear();
    heavyTakes = [];
    heavyResults = [];
    heavySwept = [];
    lagSweeps.clear();
    attachHeavy();
    indexById = new Map(world.buildings.map((b, i) => [b.id, i]));
    debris.onImpact = (b, q, p) => {
      if (observers.size) taps.impact?.(indexById.get(b.standInFor ?? b.id) ?? -1, q, "debris", p, stepCount * dt);
    };
    zone = new ZoneSelector(config.detailHouses, fixedZone, config.detailPinned);
    settling.clear();
    detailView.clear();
    standIns.clear();
    townHits.length = 0;
    hitRng = createRng(currentSeed ^ 0x2c1b3c6d);
    detailN = 0;
    sentRev.clear();
    if (makeDetail && withBuildings) {
      if (detail) detail.reset(currentSeed, world.buildings);
      else detail = makeDetail(currentSeed, world.buildings);
    }
    stepCount = 0;
    acc = 0;
    headingDeg = params.heading;
    center = startPosition();
    curr = makeSnapshot();
    prev = curr;
    // Houses have stood in the far field while the storm built up: inside pressure starts equal
    // to outside (as a detailed house entering the zone does, Spec 09). Only a tornado that
    // starts at full strength (the lab's mature pass) has a deficit at time 0.
    if (!config.tunnel)
      for (const b of world.buildings) b.deficitIn = pressureDeficit(Math.hypot(b.x - curr.tornado.center.x, b.z - curr.tornado.center.z), curr.tornado);
  }

  reset();

  return {
    advance(realDtSeconds: number): SimFrame {
      const real = Math.min(Math.max(realDtSeconds, 0), maxFrameDt);
      acc += real * timeScale;
      // Tolerance keeps step counts identical however the same time is split across calls.
      applyDetail();
      lagging = false;
      while (acc >= dt - 1e-12) {
        // Never run more than maxLeadS ahead of the detail physics: slow down instead.
        if (detail && detailN - 1 - detail.done >= maxLead) {
          lagging = true;
          acc = Math.min(acc, dt);
          break;
        }
        // …nor further ahead of the heavy-debris engine than its lag (Spec 04 v2.1).
        if (heavy && (stepCount + 1) % DEBRIS.stepInterval === 0 && heavyN - 1 - heavy.done >= HEAVY.lagSteps) {
          lagging = true;
          acc = Math.min(acc, dt);
          break;
        }
        const T = config.timing;
        const t0 = T ? performance.now() : 0;
        step();
        acc -= dt;
        if (detail) {
          const ta = T ? performance.now() : 0;
          applyDetail();
          if (T) T.detail += performance.now() - ta;
        }
        if (T) {
          T.total += performance.now() - t0;
          T.steps++;
        }
      }
      if (acc < 0) acc = 0;
      const alpha = Math.min(acc / dt, 1 - 1e-9);
      return { prev, curr, alpha };
    },
    setParams(p) {
      pending = { ...(pending ?? {}), ...p };
    },
    setTimeScale(k) {
      timeScale = Math.max(0, k);
    },
    reset,
    get time() {
      return stepCount * dt;
    },
    get params() {
      return { ...params, ...(pending ?? {}) };
    },
    get snapshot() {
      return curr;
    },
    get timeScale() {
      return timeScale;
    },
    get rng() {
      return rng;
    },
    get world() {
      return world;
    },
    /** Profiling only. */
    _heavy: () => (heavy as { engine?: { debris: HeavyDebris } } | null)?.engine?.debris ?? null,
    get debris() {
      return debris;
    },
    dispose() {
      heavy?.dispose();
      heavy = null;
      detail?.dispose();
      detail = null;
    },
    observe(t) {
      observers.add(t);
      return () => observers.delete(t);
    },
    get detail() {
      return detailView;
    },
    get detailLagging() {
      return lagging;
    },
    setDetailFocus(p) {
      pendingFocus = p ? { x: p.x, z: p.z } : null;
    },
    get detailFocus() {
      return pendingFocus !== undefined ? pendingFocus : focus;
    },
    get detailStepMs() {
      return stepMs;
    },
    get detailSpotRadius() {
      return zone.radius(world.buildings, pendingFocus !== undefined ? pendingFocus : focus);
    },
  };
}
