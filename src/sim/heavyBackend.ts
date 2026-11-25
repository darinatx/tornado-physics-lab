/**
 * Where the heavy-debris engine runs (Spec 04 v2.1): in a Web Worker in the app, or in-process
 * (tests, tools). Both process steps strictly in order with their own inputs, so results don't
 * depend on timing.
 */
import type { Building } from "../core/damage/types";
import { HeavyEngine } from "./heavyEngine";
import type { HeavyResult, HeavyStep } from "./heavyEngine";
import type { Vec3 } from "../core/math/vec";
import { lyingOnSlab } from "../core/impact/envelope";

/**
 * Sweeps the engine hasn't caught up with (Spec 04 v2.3, DEB-28): the engine carries off what
 * lies on a slab the step it learns of the sweep, but pieces it retired to the debris field in
 * the steps before that are still on their way back to the sim. Those are caught as they arrive.
 */
export class LagSweeps {
  private list: { house: Building; n: number }[] = [];
  /** `house` swept: the engine learns of it in step `n`. */
  sent(house: Building, n: number): void {
    this.list.push({ house, n });
  }
  /** A piece retired in step `n` at `pos`: was it lying on a slab swept after that? */
  catches(pos: Vec3, n: number): boolean {
    for (const s of this.list) if (s.n > n && lyingOnSlab(s.house, pos)) return true;
    return false;
  }
  /** Results through step `n` are applied: sweeps the engine saw by then can't catch more. */
  applied(n: number): void {
    if (this.list.length) this.list = this.list.filter((s) => s.n > n);
  }
  clear(): void {
    this.list = [];
  }
}

export interface HeavyBackend {
  /** Queue one step. */
  post(step: HeavyStep): void;
  /** Results finished since the last call, in order. */
  drain(): HeavyResult[];
  /** Number of the last step finished (−1 if none). */
  readonly done: number;
  /** Start over for a new town. */
  reset(seed: number, buildings: readonly Building[]): void;
  dispose(): void;
}

/** Runs the engine in-process, right away (needs `initRapier()` first). */
export function createLocalHeavy(buildings: readonly Building[], dt: number): HeavyBackend & { readonly engine: HeavyEngine } {
  let engine = new HeavyEngine(buildings, dt);
  let out: HeavyResult[] = [];
  let done = -1;
  return {
    get engine() {
      return engine;
    },
    post(step) {
      out.push(engine.step(step));
      done = step.n;
    },
    drain() {
      const r = out;
      out = [];
      return r;
    },
    get done() {
      return done;
    },
    reset(_seed, b) {
      engine.dispose();
      engine = new HeavyEngine(b, dt);
      out = [];
      done = -1;
    },
    dispose() {
      engine.dispose();
    },
  };
}

/** In-process, but steps run only when `run(k)` is called: stands in for a worker that lags
 *  behind by a varying amount (DEB-26). */
export function createDeferredHeavy(buildings: readonly Building[], dt: number): HeavyBackend & { run(k: number): void; readonly pending: number } {
  const local = createLocalHeavy(buildings, dt);
  let queue: HeavyStep[] = [];
  return {
    post(step) {
      queue.push(step);
    },
    run(k) {
      for (const s of queue.splice(0, k)) local.post(s);
    },
    get pending() {
      return queue.length;
    },
    drain: () => local.drain(),
    get done() {
      return local.done;
    },
    reset(seed, b) {
      queue = [];
      local.reset(seed, b);
    },
    dispose: () => local.dispose(),
  };
}

/** Messages to the worker. */
export type ToHeavyWorker = { type: "reset"; seed: number; dt: number } | { type: "step"; step: HeavyStep };
/** Messages from the worker. */
export type FromHeavyWorker = { type: "ready" } | { type: "result"; result: HeavyResult } | { type: "error"; message: string };

/** Runs the engine in a Web Worker (browser only). The worker rebuilds the town from the seed. */
export function createWorkerHeavy(seed: number, dt: number): HeavyBackend {
  const worker = new Worker(new URL("./heavyWorker.ts", import.meta.url), { type: "module" });
  let out: HeavyResult[] = [];
  let done = -1;
  let epoch = 0;
  worker.onmessage = (e: MessageEvent<FromHeavyWorker & { epoch?: number }>) => {
    const m = e.data;
    if (m.type === "result" && m.epoch === epoch) {
      out.push(m.result);
      done = m.result.n;
    } else if (m.type === "error") console.error("heavy debris worker:", m.message);
  };
  const send = (m: ToHeavyWorker) => worker.postMessage({ ...m, epoch });
  send({ type: "reset", seed, dt });
  return {
    post(step) {
      send({ type: "step", step });
    },
    drain() {
      const r = out;
      out = [];
      return r;
    },
    get done() {
      return done;
    },
    reset(s) {
      epoch++;
      out = [];
      done = -1;
      send({ type: "reset", seed: s, dt });
    },
    dispose() {
      worker.terminate();
    },
  };
}
