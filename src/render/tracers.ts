/**
 * Dust tracers (Spec 06 v1.2, REND-07). Massless particles advected by windAt.
 * Pure state; no Three.js. Uses its own seeded RNG (visual only).
 */
import { windAt } from "../core/wind/windField";
import type { TornadoState } from "../core/wind/types";
import { RENDER } from "../config/render";
import { createRng } from "../sim/rng";
import type { Terrain } from "../core/terrain/roughness";

/** y value for hidden (dead) tracers, far below the ground. */
export const HIDDEN_Y = -1e4;

export interface TracerOptions {
  /** Ground wind needed to loft dust (m/s). */
  liftSpeed: number;
  /** "emission": spawn over the whole area where dust lifts, weighted by the emission rate,
   *  with the count following the total emission (Spec 06 v1.6, the town). "core": uniformly
   *  around the core at a fixed count (the structure lab, viewed from tens of metres). */
  area: "emission" | "core";
  /** Max advection substep (s). */
  maxSubstep: number;
  /** Lowest height a tracer may sit at (m). */
  minHeight: number;
}

export const DEFAULT_TRACER_OPTIONS: TracerOptions = {
  liftSpeed: RENDER.dustLiftSpeed,
  area: "emission",
  maxSubstep: 0.05,
  minHeight: 0.5,
};

/**
 * Dust emission rate for ground-relative wind u (m/s) above the lifting threshold u_t:
 * F ∝ u³(1 − u_t²/u²) (the standard dust-emission form, e.g. Gillette & Passi 1988); zero
 * below the threshold. Relative units.
 */
export function dustEmission(u: number, ut: number): number {
  return u <= ut ? 0 : u * u * u * (1 - (ut * ut) / (u * u));
}

/** Where dust lifts around a tornado: the farthest radius with emission, the peak emission
 *  and the total over the area (∫F dA, m²·(m/s)³), within the damage range. */
export interface DustSurvey {
  radius: number;
  peak: number;
  total: number;
}

/** Survey the dust-lifting area on a polar grid around the center (ground wind at 3 m). */
export function surveyDust(s: TornadoState, terrain: Terrain, ut: number): DustSurvey {
  const range = RENDER.dustRangeRmax * s.rMax;
  const nDir = 24;
  const nR = 80;
  const dr = range / nR;
  let radius = 0;
  let peak = 0;
  let total = 0;
  for (let i = 0; i < nR; i++) {
    const r = (i + 0.5) * dr;
    const ring = (2 * Math.PI * r * dr) / nDir;
    for (let d = 0; d < nDir; d++) {
      const a = (d / nDir) * 2 * Math.PI;
      const w = windAt({ x: s.center.x + r * Math.cos(a), y: 3, z: s.center.z + r * Math.sin(a) }, s, terrain);
      const f = dustEmission(Math.hypot(w.x, w.z), ut);
      if (f <= 0) continue;
      radius = Math.max(radius, r + dr / 2);
      peak = Math.max(peak, f);
      total += f * ring;
    }
  }
  return { radius, peak, total };
}

/** Number of tracers for a survey: proportional to total emission, within [min, cap]. */
export function dustTracerCount(total: number, cap: number = RENDER.tracerCap): number {
  if (total <= 0) return 0;
  return Math.round(Math.min(cap, Math.max(RENDER.tracerMin, total * RENDER.tracersPerEmission)));
}

export class TracerField {
  /** Tracers in use now (the rest stay hidden); follows the emission in "emission" mode. */
  target: number;
  /** Latest dust survey ("emission" mode). */
  survey: DustSurvey = { radius: 0, peak: 0, total: 0 };
  private sinceSurvey = Infinity;

  readonly positions: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  private readonly rng: () => number;

  constructor(
    readonly count: number,
    seed: number,
    readonly opts: TracerOptions = DEFAULT_TRACER_OPTIONS,
  ) {
    this.positions = new Float32Array(count * 3);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.rng = createRng(seed);
    this.target = opts.area === "core" ? count : 0;
    for (let i = 0; i < count; i++) this.hide(i);
  }

  isAlive(i: number): boolean {
    return this.positions[i * 3 + 1]! > HIDDEN_Y / 2;
  }

  private hide(i: number): void {
    this.positions[i * 3 + 1] = HIDDEN_Y;
    this.age[i] = 0;
    this.life[i] = 0;
  }

  private trySpawn(i: number, s: TornadoState, terrain: Terrain): void {
    const a = this.rng() * Math.PI * 2;
    const emission = this.opts.area === "emission";
    // Uniform over the lifting area (emission), or the old core ring (lab).
    const r = emission ? this.survey.radius * Math.sqrt(this.rng()) : s.rMax * (0.2 + 1.8 * Math.sqrt(this.rng()));
    const x = s.center.x + r * Math.cos(a);
    const z = s.center.z + r * Math.sin(a);
    const y = this.opts.minHeight + this.rng() * 12;
    const w = windAt({ x, y: 3, z }, s, terrain);
    const u = Math.hypot(w.x, w.z);
    // Accept in proportion to the local emission rate (dense where winds are strong).
    const keep = emission ? this.survey.peak > 0 && this.rng() * this.survey.peak < dustEmission(u, this.opts.liftSpeed) : u >= this.opts.liftSpeed;
    if (!keep) {
      this.hide(i);
      return;
    }
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.age[i] = 0;
    this.life[i] = 8 + this.rng() * 18;
  }

  /** Hide every tracer (used on restart). */
  clear(): void {
    for (let i = 0; i < this.count; i++) this.hide(i);
    this.sinceSurvey = Infinity;
    if (this.opts.area === "emission") this.target = 0;
    this.highest = 0;
  }

  /** Highest tracer index that may be alive (+1): what needs drawing. */
  get inUse(): number {
    return this.highest;
  }
  private highest = 0;

  /** Advance all tracers by dt seconds of sim time. */
  update(dt: number, s: TornadoState, terrain: Terrain, cloudBase: number): void {
    const maxY = 0.8 * cloudBase;
    const emission = this.opts.area === "emission";
    // Where dust lifts and how much, 4 times a second (the tornado changes over seconds).
    if (emission) {
      this.sinceSurvey += dt;
      if (this.sinceSurvey >= RENDER.dustSurveyEvery) {
        this.sinceSurvey = 0;
        this.survey = surveyDust(s, terrain, this.opts.liftSpeed);
        this.target = Math.min(this.count, dustTracerCount(this.survey.total));
      }
    }
    const maxR = emission ? Math.max(4 * s.rMax, 1.5 * this.survey.radius) : 4 * s.rMax;
    const active = s.vMax > 1;
    const n = Math.max(1, Math.ceil(dt / this.opts.maxSubstep));
    const h = dt / n;
    const p = { x: 0, y: 0, z: 0 };
    // Spawn a limited number per frame so the cloud builds up rather than popping in.
    // (Attempts: in emission mode most are rejected in the thin fringe, so allow more.)
    let spawnBudget = Math.max(20, Math.round(this.target * (emission ? 0.12 : 0.04)));
    let highest = 0;

    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      if (!this.isAlive(i) || this.age[i]! >= this.life[i]!) {
        // Beyond the target count, tracers retire as they die.
        if (active && dt > 0 && spawnBudget > 0 && i < this.target) {
          spawnBudget--;
          this.trySpawn(i, s, terrain);
          if (this.isAlive(i)) highest = i + 1;
        } else {
          this.hide(i);
        }
        continue;
      }
      highest = i + 1;
      if (dt <= 0) continue;
      p.x = this.positions[k]!;
      p.y = this.positions[k + 1]!;
      p.z = this.positions[k + 2]!;
      for (let j = 0; j < n; j++) {
        const w = windAt(p, s, terrain);
        p.x += w.x * h;
        p.y = Math.max(p.y + w.y * h, this.opts.minHeight);
        p.z += w.z * h;
      }
      this.age[i] = this.age[i]! + dt;
      const r = Math.hypot(p.x - s.center.x, p.z - s.center.z);
      if (p.y > maxY || r > maxR) {
        this.hide(i);
        continue;
      }
      this.positions[k] = p.x;
      this.positions[k + 1] = p.y;
      this.positions[k + 2] = p.z;
    }
    this.highest = highest;
  }
}
