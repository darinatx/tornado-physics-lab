/**
 * Where the detail engine runs (Spec 09 slice B): in Web Workers in the app, or in-process
 * (tests, or as a fallback). Both process steps strictly in order with their own inputs, so
 * results don't depend on timing. Street rows (physics groups) are spread over several
 * engines (Spec 09 performance); each row is its own world, so results don't depend on how
 * many engines there are either.
 */
import type { Building, HouseSpec } from "../core/damage/types";
import type { Framing } from "../core/structure/framing";
import { streetRowOf } from "./city";
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

/** Spreads street rows over k engines: a row goes to the engine with the fewest houses when
 *  its first house enters; its houses stay there. */
export class DetailSplit {
  private readonly engineOfRow = new Map<string, number>();
  private readonly engineOfHouse = new Map<number, number>();
  private readonly count: number[];

  constructor(
    private readonly buildings: readonly Building[],
    readonly k: number,
  ) {
    this.count = new Array<number>(k).fill(0);
  }

  /** The step as each engine sees it (same tornado, its own houses entering and leaving). */
  split(step: DetailStep): DetailStep[] {
    const parts = Array.from({ length: this.k }, () => ({ ...step, enter: [] as DetailStep["enter"], exit: [] as number[] }));
    for (const e of step.enter) {
      const row = e.group ?? streetRowOf(this.buildings[e.index]!);
      let k = this.engineOfRow.get(row);
      if (k === undefined) {
        k = this.count.indexOf(Math.min(...this.count));
        this.engineOfRow.set(row, k);
      }
      this.count[k]!++;
      this.engineOfHouse.set(e.index, k);
      parts[k]!.enter.push(e);
    }
    for (const i of step.exit) {
      const k = this.engineOfHouse.get(i);
      if (k !== undefined) parts[k]!.exit.push(i);
    }
    return parts;
  }
}

/** One step's results from every engine, as one result. */
export function mergeResults(rs: readonly DetailResult[]): DetailResult {
  if (rs.length === 1) return rs[0]!;
  const cat = <T extends Float32Array | Int32Array>(make: new (n: number) => T, get: (r: DetailResult) => T): T => {
    const out = new make(rs.reduce((a, r) => a + get(r).length, 0));
    let o = 0;
    for (const r of rs) {
      out.set(get(r), o);
      o += get(r).length;
    }
    return out;
  };
  return {
    n: rs[0]!.n,
    poses: cat(Float32Array, (r) => r.poses),
    dods: cat(Int32Array, (r) => r.dods),
    failures: cat(Int32Array, (r) => r.failures),
    frozen: rs.flatMap((r) => r.frozen),
    failLog: rs.flatMap((r) => r.failLog),
    ...(rs.some((r) => r.inspect) ? { inspect: rs.flatMap((r) => r.inspect ?? []) } : {}),
    townHits: rs.flatMap((r) => r.townHits),
    ms: Math.max(...rs.map((r) => r.ms)),
    groupMs: Math.max(...rs.map((r) => r.groupMs)),
  };
}

/** Runs k engines in-process, right away (needs `initRapier()` first). */
export function createLocalBackend(buildings: readonly Building[], k = 1): DetailBackend & { engines: DetailEngine[] } {
  let engines = Array.from({ length: k }, () => new DetailEngine(buildings));
  let split = new DetailSplit(buildings, k);
  let out: DetailResult[] = [];
  let done = -1;
  return {
    get engines() {
      return engines;
    },
    post(step) {
      const parts = split.split(step);
      out.push(mergeResults(engines.map((e, i) => e.step(parts[i]!))));
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
      for (const e of engines) e.dispose();
      engines = Array.from({ length: k }, () => new DetailEngine(b));
      split = new DetailSplit(b, k);
      out = [];
      done = -1;
    },
    dispose() {
      for (const e of engines) e.dispose();
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
export type ToWorker = { type: "reset"; seed: number; houses?: readonly HouseSpec[] } | { type: "step"; step: DetailStep };
/** Messages from the worker. */
export type FromWorker = { type: "ready" } | { type: "result"; result: DetailResult } | { type: "error"; message: string };

/** Workers to use: as many as the CPU allows, leaving two cores for the page, up to 6. */
export function detailWorkerCount(cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4): number {
  return Math.max(1, Math.min(6, (cores || 4) - 2));
}

/** Runs the engines in Web Workers (browser only), one per worker. */
export function createWorkerBackend(seed: number, buildings: readonly Building[], k = detailWorkerCount(), houses?: readonly HouseSpec[]): DetailBackend {
  const workers = Array.from({ length: k }, () => new Worker(new URL("./detailWorker.ts", import.meta.url), { type: "module" }));
  let split = new DetailSplit(buildings, k);
  let out: DetailResult[] = [];
  let done = -1;
  let epoch = 0;
  let resultEpoch = 0;
  /** Results per step number until every worker has delivered it. */
  let pending = new Map<number, (DetailResult | undefined)[]>();
  workers.forEach((worker, w) => {
    worker.onmessage = (e: MessageEvent<FromWorker & { epoch?: number }>) => {
      const m = e.data;
      if (m.type === "result" && m.epoch === resultEpoch) {
        const n = m.result.n;
        const got = pending.get(n) ?? new Array<DetailResult | undefined>(k).fill(undefined);
        got[w] = m.result;
        pending.set(n, got);
        // Steps complete in order (each worker processes its queue in order).
        while (pending.get(done + 1)?.every(Boolean)) {
          out.push(mergeResults(pending.get(done + 1) as DetailResult[]));
          pending.delete(done + 1);
          done++;
        }
      } else if (m.type === "error") {
        console.error("detail worker:", m.message);
      }
    };
  });
  const send = (w: number, m: ToWorker) => workers[w]!.postMessage({ ...m, epoch });
  for (let w = 0; w < k; w++) send(w, { type: "reset", seed, ...(houses ? { houses } : {}) });
  return {
    post(step) {
      split.split(step).forEach((part, w) => send(w, { type: "step", step: part }));
    },
    drain() {
      const r = out;
      out = [];
      return r;
    },
    get done() {
      return done;
    },
    reset(s, b) {
      epoch++;
      resultEpoch = epoch;
      out = [];
      done = -1;
      pending = new Map();
      split = new DetailSplit(b, k);
      for (let w = 0; w < k; w++) send(w, { type: "reset", seed: s, ...(houses ? { houses } : {}) });
    },
    dispose() {
      for (const w of workers) w.terminate();
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
  /** Inspected houses (Spec 13): connection loads (N) and attached members at detail step `n`. */
  readonly inspection = new Map<number, { loads: Float32Array; attached: Uint8Array; n: number }>();
  /** Per house: failed connections, when (sim s), in what roof wind (mph) and at what load (N). */
  readonly failedAt = new Map<number, Map<number, { time: number; mph: number; load: number }>>();

  inspected(index: number, loads: Float32Array, attached: Uint8Array, n: number): void {
    if (this.houses.has(index)) this.inspection.set(index, { loads, attached, n });
  }

  failed(index: number, con: number, at: { time: number; mph: number; load: number }): void {
    let m = this.failedAt.get(index);
    if (!m) this.failedAt.set(index, (m = new Map()));
    if (!m.has(con)) m.set(con, at);
  }

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
    this.inspection.delete(index);
    this.failedAt.delete(index);
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
    this.inspection.clear();
    this.failedAt.clear();
    this.version++;
  }
}
