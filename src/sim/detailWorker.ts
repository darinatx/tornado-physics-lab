/// <reference lib="webworker" />
/**
 * Web Worker running the detail engine (Spec 09 slice B). It rebuilds the same neighborhood
 * from the seed (generation is deterministic), then processes detail steps in order.
 */
import { generateNeighborhood } from "./city";
import { DetailEngine } from "./detailZone";
import type { FromWorker, ToWorker } from "./detailBackend";
import { initRapier } from "./structureWorld";

let engine: DetailEngine | null = null;
let queue: (ToWorker & { epoch: number })[] = [];
let ready = false;

const post = (m: FromWorker & { epoch?: number }, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

function handle(m: ToWorker & { epoch: number }): void {
  if (m.type === "reset") {
    engine?.dispose();
    engine = new DetailEngine(generateNeighborhood(m.seed).buildings);
    return;
  }
  if (!engine) return;
  try {
    const result = engine.step(m.step);
    post({ type: "result", result, epoch: m.epoch }, [result.poses.buffer, result.dods.buffer, result.failures.buffer]);
  } catch (e) {
    post({ type: "error", message: `${(e as Error).message} (phase ${engine.sw.phase})` });
  }
}

self.onmessage = (e: MessageEvent<ToWorker & { epoch: number }>) => {
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
