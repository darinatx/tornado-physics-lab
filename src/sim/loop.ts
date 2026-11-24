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
import { DEBRIS } from "../config/debris";
import type { World } from "./world";
import { defaultParams } from "./types";
import type { SimConfig, SimFrame, SimSnapshot, TornadoParams } from "./types";
import { DETAIL } from "../config/structure";
import { buildFraming } from "../core/structure/framing";
import { removedOnEntry } from "../core/structure/survey";
import { DetailView } from "./detailBackend";
import type { DetailBackend } from "./detailBackend";
import { ZoneSelector } from "./detailZone";

export interface Sim {
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
  readonly world: Pick<World, "buildings" | "buildingAt">;
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
  let world: World = createWorld(seed, withBuildings);
  let debris = new DebrisField(seed);

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
  let zone = new ZoneSelector();
  const detailView = new DetailView();
  let detailN = 0;
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
    const enter = ops.enter.map((i) => {
      const b = world.buildings[i]!;
      b.detail = true;
      b.rev++;
      const framing = buildFraming(b);
      detailView.add(i, b, framing);
      const gone = removedOnEntry(b, framing);
      return { index: i, removed: gone.flatMap((g, id) => (g ? [id] : [])) };
    });
    // Nothing in the zone and nothing changing: don't make the sim wait on an empty step.
    if (!enter.length && !ops.exit.length && zone.active.size === 0) return;
    detail.post({ n: detailN++, tornado: pre.tornado, terrain: pre.terrain, enter, exit: ops.exit });
  }

  function applyDetail(): void {
    if (!detail) return;
    for (const r of detail.drain()) {
      stepMs += (r.ms - stepMs) * 0.05;
      detailView.apply(r.poses);
      for (let k = 0; k < r.dods.length; k += 2) world.setDod(world.buildings[r.dods[k]!]!, r.dods[k + 1]!);
      // The inspector's failure list: connection failures by type, in order.
      for (const f of r.failLog) {
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
      for (const f of r.frozen)
        if (f.undamaged) {
          // Untouched: back to the component model, which draws it the same.
          world.buildings[f.index]!.detail = false;
          world.buildings[f.index]!.rev++;
          detailView.remove(f.index);
        }
    }
  }

  function startPosition(): Vec2 {
    // Center the full path on the origin so the whole lifecycle stays on the map.
    const d = headingDir(headingDeg);
    const half = (lifetime(params) * params.translationSpeed) / 2;
    return { x: -d.x * half, z: -d.z * half };
  }

  function makeSnapshot(): SimSnapshot {
    const t = stepCount * dt;
    const lc = lifecycle(t, params);
    const d = headingDir(headingDeg);
    return Object.freeze({
      time: t,
      step: stepCount,
      terrain: params.terrain,
      cloudBase: params.cloudBase,
      phase: lc.phase,
      lifetime: lifetime(params),
      damageVersion: world.version,
      damageHistogram: Object.freeze([...world.histogram]),
      debris: Object.freeze({ ...debris.stats }),
      tornado: Object.freeze({
        center: Object.freeze({ x: center.x, z: center.z }),
        velocity: Object.freeze({ x: d.x * params.translationSpeed, z: d.z * params.translationSpeed }),
        vMax: lc.vMax,
        rMax: lc.rMax,
        alpha: params.alpha,
        inflowRatio: params.inflowRatio,
        inflowDepth: params.inflowDepth,
        updraftMax: params.updraftMax,
        overshoot: params.overshoot,
        zPeak: params.zPeak,
        rotation: params.rotation,
      }),
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
    prev = curr;
    const pre = makeSnapshot();
    const damageStep = stepCount % DAMAGE_STEP_INTERVAL === 0;
    if (stepCount % DETAIL.stepEvery === 0) detailStep(pre);
    if (damageStep) {
      world.update(dt * DAMAGE_STEP_INTERVAL, pre.tornado, pre.terrain, pre.time, (b, rec) => debris.spawnFrom(b, rec));
    }
    if (stepCount % DEBRIS.stepInterval === 0) {
      debris.step(dt * DEBRIS.stepInterval, pre.tornado, pre.terrain, damageStep, pre.time, pre.cloudBase);
    }
    curr = makeSnapshot();
  }

  function reset(newSeed?: number): void {
    applyPending();
    if (newSeed !== undefined) currentSeed = newSeed;
    rng = createRng(currentSeed);
    world = createWorld(currentSeed, withBuildings);
    debris = new DebrisField(currentSeed);
    zone = new ZoneSelector();
    detailView.clear();
    detailN = 0;
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
        step();
        acc -= dt;
        if (detail) applyDetail();
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
    get debris() {
      return debris;
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
