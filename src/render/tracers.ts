/**
 * Dust tracers (Spec 06 v1.2, REND-07). Massless particles advected by windAt.
 * Pure state; no Three.js. Uses its own seeded RNG (visual only).
 */
import { windAt } from "../core/wind/windField";
import type { TerrainClass, TornadoState } from "../core/wind/types";
import { RENDER } from "../config/render";
import { createRng } from "../sim/rng";

/** y value for hidden (dead) tracers, far below the ground. */
export const HIDDEN_Y = -1e4;

export interface TracerOptions {
  /** Ground wind needed to loft dust (m/s). */
  liftSpeed: number;
  /** Max advection substep (s). */
  maxSubstep: number;
  /** Lowest height a tracer may sit at (m). */
  minHeight: number;
}

export const DEFAULT_TRACER_OPTIONS: TracerOptions = {
  liftSpeed: RENDER.dustLiftSpeed,
  maxSubstep: 0.05,
  minHeight: 0.5,
};

export class TracerField {
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

  private trySpawn(i: number, s: TornadoState, terrain: TerrainClass): void {
    const a = this.rng() * Math.PI * 2;
    const r = s.rMax * (0.2 + 1.8 * Math.sqrt(this.rng()));
    const x = s.center.x + r * Math.cos(a);
    const z = s.center.z + r * Math.sin(a);
    const y = this.opts.minHeight + this.rng() * 12;
    const w = windAt({ x, y: 3, z }, s, terrain);
    if (Math.hypot(w.x, w.z) < this.opts.liftSpeed) {
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
  }

  /** Advance all tracers by dt seconds of sim time. */
  update(dt: number, s: TornadoState, terrain: TerrainClass, cloudBase: number): void {
    const maxY = 0.8 * cloudBase;
    const maxR = 4 * s.rMax;
    const active = s.vMax > 1;
    const n = Math.max(1, Math.ceil(dt / this.opts.maxSubstep));
    const h = dt / n;
    const p = { x: 0, y: 0, z: 0 };
    // Spawn a limited number per frame so the cloud builds up rather than popping in.
    let spawnBudget = Math.max(20, Math.round(this.count * 0.04));

    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      if (!this.isAlive(i) || this.age[i]! >= this.life[i]!) {
        if (active && dt > 0 && spawnBudget > 0) {
          spawnBudget--;
          this.trySpawn(i, s, terrain);
        } else {
          this.hide(i);
        }
        continue;
      }
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
  }
}
