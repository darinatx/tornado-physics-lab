/// <reference lib="webworker" />
/**
 * Web Worker running the heavy-debris engine (Spec 04 v2.1). It rebuilds the same town from the
 * seed (generation is deterministic), then processes steps in order.
 */
import { generateNeighborhood } from "./city";
import type { FromHeavyWorker, ToHeavyWorker } from "./heavyBackend";
import { HeavyEngine } from "./heavyEngine";
import { initRapier } from "./structureWorld";

let engine: HeavyEngine | null = null;
let queue: (ToHeavyWorker & { epoch: number })[] = [];
let ready = false;

const post = (m: FromHeavyWorker & { epoch?: number }, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

function handle(m: ToHeavyWorker & { epoch: number }): void {
  if (m.type === "reset") {
    engine?.dispose();
    engine = new HeavyEngine(generateNeighborhood(m.seed).buildings, m.dt);
    return;
  }
  if (!engine) return;
  try {
    const result = engine.step(m.step);
    post({ type: "result", result, epoch: m.epoch }, [result.poses.buffer]);
  } catch (e) {
    post({ type: "error", message: (e as Error).message });
  }
}

self.onmessage = (e: MessageEvent<ToHeavyWorker & { epoch: number }>) => {
  if (!ready) {
    queue.push(e.data);
    return;
  }
  handle(e.data);
};

initRapier().then(() => {
  ready = true;
  for (const m of queue) handle(m);
  queue = [];
  post({ type: "ready" });
});
