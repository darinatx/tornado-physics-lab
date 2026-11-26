/**
 * Wind tunnel runner (Spec 12): runs a scenario headless, as fast as the CPU allows at the
 * sim's fixed steps, and keeps its record: samples, the target's failures and impacts, the
 * launches, and the pass-through check at every debris step.
 */
import { createHash } from "node:crypto";
import { createTunnel } from "../../src/sim/tunnel";
import type { Tunnel, TunnelScenario } from "../../src/sim/tunnel";
import { RunRecorder } from "../../src/sim/runRecord";
import type { TunnelRecord } from "../../src/sim/runRecord";

export type { TunnelFailure, TunnelImpact, TunnelRecord, TunnelSample } from "../../src/sim/runRecord";

export interface RunOptions {
  /** Sim seconds per advance call (default 0.25): chunking never changes the record. */
  chunk?: number;
  /** Called after every debris step, before it is recorded (tests). */
  onStep?: (t: Tunnel) => void;
}

/** The record's identity: everything but the timing. */
export function recordHash(r: TunnelRecord): string {
  const { perf: _perf, ...rest } = r;
  return createHash("sha1").update(JSON.stringify(rest)).digest("hex");
}

/** Run one scenario and keep its record. */
export async function runTunnel(s: TunnelScenario & { check?: (r: TunnelRecord) => string[] }, opts: RunOptions = {}): Promise<TunnelRecord> {
  const t0 = performance.now();
  const tun = await createTunnel(s);
  const recorder = new RunRecorder(tun.sim, tun.target, () => tun.launched, (l) => (l.piece ? l.piece.pos : (tun.launchBody(l.i)?.center ?? null)), { drive: "manual" });
  tun.onStep = (t) => {
    opts.onStep?.(t);
    recorder.step();
  };

  const chunk = opts.chunk ?? 0.25;
  let asked = 0;
  let lastYield = performance.now();
  while (asked < s.seconds - 1e-9) {
    const d = Math.min(chunk, s.seconds - asked);
    tun.advance(d);
    asked += d;
    if (performance.now() - lastYield > 1000) {
      await new Promise((r) => setImmediate(r));
      lastYield = performance.now();
    }
  }

  const rec = recorder.stop(s.name, s.seed ?? 1);
  rec.seconds = s.seconds;
  tun.dispose();
  if (s.check) rec.problems.push(...s.check(rec));
  rec.ok = rec.problems.length === 0;
  const wallS = (performance.now() - t0) / 1000;
  rec.perf = { wallS, speed: s.seconds / wallS };
  return rec;
}
