/**
 * Fixed-timestep simulation loop (Spec 08).
 */
import { SIM_DEFAULTS } from "../config/sim";
import { lifecycle, lifetime } from "../core/wind/lifecycle";
import type { Vec2 } from "../core/math/vec";
import { createRng } from "./rng";
import { defaultParams } from "./types";
import type { SimConfig, SimFrame, SimSnapshot, TornadoParams } from "./types";

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
): Sim {
  const dt = config.dt ?? SIM_DEFAULTS.dt;
  const maxFrameDt = config.maxFrameDt ?? SIM_DEFAULTS.maxFrameDt;

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
    curr = makeSnapshot();
  }

  function reset(newSeed?: number): void {
    applyPending();
    if (newSeed !== undefined) currentSeed = newSeed;
    rng = createRng(currentSeed);
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
      while (acc >= dt - 1e-12) {
        step();
        acc -= dt;
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
  };
}
