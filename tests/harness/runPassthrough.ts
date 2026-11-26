/**
 * Runs the pass-through check on a short, deterministic tornado pass through the town center
 * (the same quick tornado as the detail-zone tests), observing every debris step (60 Hz).
 * Component debris and rubble always; detail-zone members with `detail: true` (slower: Rapier).
 */
import { createLocalBackend } from "../../src/sim/detailBackend";
import { createSim } from "../../src/sim/loop";
import type { Piece } from "../../src/core/debris/piece";
import { initRapier } from "../../src/sim/structureWorld";
import { PassThroughMonitor } from "./passthrough";
import type { Tracked } from "./passthrough";

/** A short-lived EF3–4 tornado that starts inside the town (the path is centered on the origin). */
export const QUICK_PASS = { tUp: 5, tMature: 40, tRope: 5, translationSpeed: 20 };

export interface PassThroughRun {
  monitor: PassThroughMonitor;
  /** Sim seconds run, wall-clock seconds taken. */
  simS: number;
  wallS: number;
  /** Most debris pieces in flight or sliding at once. */
  peakPieces: number;
  /** The sim at the end (diagnostics). */
  sim: import("../../src/sim/loop").Sim;
}

export interface PassThroughOptions {
  /** Sim seconds to run (default 6: the first pieces tear off at ~1 s and reach other houses by
   *  ~3 s). */
  seconds?: number;
  seed?: number;
  /** Also check detail-zone members (30 houses around the origin; Rapier, slower). */
  detail?: boolean;
  /** Most debris pieces at once (default 1,000; the sim's own cap is 3,000): fewer pieces, same
   *  physics per piece. */
  cap?: number;
  rubbleEvery?: number;
}

export async function runPassThrough(opts: PassThroughOptions = {}): Promise<PassThroughRun> {
  const seconds = opts.seconds ?? 6;
  const t0 = performance.now();
  await initRapier();
  const sim = createSim({}, opts.seed ?? 3, QUICK_PASS, opts.detail ? (_s, b) => createLocalBackend(b) : undefined);
  if (opts.detail) sim.setDetailFocus({ x: 0, z: 0 });
  // Test-only: a smaller debris pool (the field reads its cap when spawning).
  (sim.debris as { cap: number }).cap = opts.cap ?? 1000;
  const monitor = new PassThroughMonitor(sim.world.buildings);
  const ids = new WeakMap<Piece, string>();
  let next = 0;
  const keyOf = (p: Piece) => ids.get(p) ?? (ids.set(p, `p${next++}`), ids.get(p)!);
  const rubbleEvery = opts.rubbleEvery ?? 30;
  let peakPieces = 0;
  for (let n = 0; n < seconds * 60; n++) {
    sim.advance(1 / 60);
    const tracked: Tracked[] = [];
    for (const p of sim.debris.pieces) {
      if (p.hidden) continue;
      tracked.push({ key: keyOf(p), source: "debris", label: p.def.label, from: p.sourceId, pos: p.pos });
    }
    peakPieces = Math.max(peakPieces, tracked.length);
    if (opts.detail) {
      for (const [i, h] of sim.detail.houses) {
        const stamps = sim.detail.stamps.get(i)!;
        for (let m = 0; m < stamps.length; m++) {
          if (!stamps[m]) continue; // never moved: still where it was built
          const o = m * 7;
          if (h.poses[o + 1]! < -1000) continue; // left the area
          tracked.push({ key: `m${i}:${m}`, source: "member", label: h.framing.members[m]!.kind, own: h.building.id, pos: { x: h.poses[o]!, y: h.poses[o + 1]!, z: h.poses[o + 2]! } });
        }
      }
    }
    monitor.observe(sim.time, tracked);
    // Rubble lies still: only check where it lies, every so often.
    if (n % rubbleEvery === 0) {
      const rubble: Tracked[] = [];
      for (const p of sim.debris.settled) if (!p.hidden) rubble.push({ key: keyOf(p), source: "rubble", label: p.def.label, pos: p.pos });
      monitor.observe(sim.time, rubble, { moveChecks: false });
    }
  }
  return { monitor, simS: sim.time, wallS: (performance.now() - t0) / 1000, peakPieces, sim };
}
