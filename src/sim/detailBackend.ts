/**
 * Where the detail engine runs (Spec 09 slice B): in a Web Worker in the app, or in-process
 * (tests, or as a fallback). Both process steps strictly in order with their own inputs, so
 * results don't depend on timing.
 */
import type { Building } from "../core/damage/types";
import type { Framing } from "../core/structure/framing";
import { DetailEngine } from "./detailZone";
import type { DetailResult, DetailStep } from "./detailZone";

export interface DetailBackend {
  /** Queue one detail step. */
  post(step: DetailStep): void;
  /** Results finished since the last call, in order. */
  drain(): DetailResult[];
  /** Number of the last step finished (−1 if none). */
  readonly done: number;
  /** Start over for a new neighborhood. */
  reset(seed: number, buildings: readonly Building[]): void;
  dispose(): void;
}

/** Runs the engine in-process, right away (needs `initRapier()` first). */
export function createLocalBackend(buildings: readonly Building[]): DetailBackend & { engine: DetailEngine } {
  let engine = new DetailEngine(buildings);
  let out: DetailResult[] = [];
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
      engine = new DetailEngine(b);
      out = [];
      done = -1;
    },
    dispose() {
      engine.dispose();
    },
  };
}

/**
 * In-process, but steps run only when `run(k)` is called: stands in for a worker that lags
 * behind by a varying amount (STR-18).
 */
export function createDeferredBackend(buildings: readonly Building[]): DetailBackend & { run(k: number): void; readonly pending: number } {
  const local = createLocalBackend(buildings);
  let queue: DetailStep[] = [];
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
export type ToWorker = { type: "reset"; seed: number } | { type: "step"; step: DetailStep };
/** Messages from the worker. */
export type FromWorker = { type: "ready" } | { type: "result"; result: DetailResult } | { type: "error"; message: string };

/** Runs the engine in a Web Worker (browser only). */
export function createWorkerBackend(seed: number): DetailBackend {
  const worker = new Worker(new URL("./detailWorker.ts", import.meta.url), { type: "module" });
  let out: DetailResult[] = [];
  let done = -1;
  let epoch = 0;
  let resultEpoch = 0;
  worker.onmessage = (e: MessageEvent<FromWorker & { epoch?: number }>) => {
    const m = e.data;
    if (m.type === "result" && m.epoch === resultEpoch) {
      out.push(m.result);
      done = m.result.n;
    } else if (m.type === "error") {
      console.error("detail worker:", m.message);
    }
  };
  const send = (m: ToWorker) => worker.postMessage({ ...m, epoch });
  send({ type: "reset", seed });
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
      resultEpoch = epoch;
      out = [];
      done = -1;
      send({ type: "reset", seed: s });
    },
    dispose() {
      worker.terminate();
    },
  };
}

/** Member poses of the detailed houses, kept in the sim for the renderer (read-only there). */
export class DetailView {
  /** House index → its framing and current member poses (7 floats each: pos, quat). */
  readonly houses = new Map<number, { framing: Framing; poses: Float32Array; building: Building }>();
  /** Increases on any change: houses added/removed or poses moved. */
  version = 0;
  /** Per house, increases when its poses change. */
  readonly houseVersion = new Map<number, number>();
  /** Per house, per member: the house version at which that member last moved. */
  readonly stamps = new Map<number, Uint32Array>();

  add(index: number, building: Building, framing: Framing): void {
    const poses = new Float32Array(framing.members.length * 7);
    const q = [0, Math.sin(building.yaw / 2), 0, Math.cos(building.yaw / 2)] as const;
    const c = Math.cos(building.yaw);
    const s = Math.sin(building.yaw);
    framing.members.forEach((m, i) => {
      // World pose of an intact member: rotate by the house yaw, then translate.
      poses[i * 7] = building.x + m.pos.x * c + m.pos.z * s;
      poses[i * 7 + 1] = m.pos.y;
      poses[i * 7 + 2] = building.z - m.pos.x * s + m.pos.z * c;
      // q_house ⊗ q_member
      const [ax, ay, az, aw] = q;
      const [bx, by, bz, bw] = m.q;
      poses[i * 7 + 3] = aw * bx + ax * bw + ay * bz - az * by;
      poses[i * 7 + 4] = aw * by - ax * bz + ay * bw + az * bx;
      poses[i * 7 + 5] = aw * bz + ax * by - ay * bx + az * bw;
      poses[i * 7 + 6] = aw * bw - ax * bx - ay * by - az * bz;
    });
    this.houses.set(index, { framing, poses, building });
    this.houseVersion.set(index, 0);
    this.stamps.set(index, new Uint32Array(framing.members.length));
    this.version++;
  }

  remove(index: number): void {
    this.houses.delete(index);
    this.houseVersion.delete(index);
    this.stamps.delete(index);
    this.version++;
  }

  apply(poses: Float32Array): void {
    const bumped = new Map<number, number>();
    for (let k = 0; k < poses.length; k += 9) {
      const i = poses[k]!;
      const h = this.houses.get(i);
      if (!h) continue;
      let v = bumped.get(i);
      if (v === undefined) {
        v = (this.houseVersion.get(i) ?? 0) + 1;
        bumped.set(i, v);
        this.houseVersion.set(i, v);
      }
      const member = poses[k + 1]!;
      this.stamps.get(i)![member] = v;
      const o = member * 7;
      for (let j = 0; j < 7; j++) h.poses[o + j] = poses[k + 2 + j]!;
    }
    if (poses.length) this.version++;
  }

  clear(): void {
    this.houses.clear();
    this.houseVersion.clear();
    this.stamps.clear();
    this.version++;
  }
}
