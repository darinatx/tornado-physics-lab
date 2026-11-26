/**
 * Benchmark (Spec 18): two seeded scenes, ms per physics step by section, compared with a saved
 * baseline. Physics only; engines in-process.
 */
import { cpus } from "node:os";
import { PRESETS } from "../config/presets";
import { SIM_DEFAULTS } from "../config/sim";
import { createLocalBackend } from "../sim/detailBackend";
import { createSim } from "../sim/loop";
import { defaultParams, newStepTiming } from "../sim/types";
import type { StepTiming, TornadoParams } from "../sim/types";

/** Errors from shutting a scene's sim down (BL-013), reported, not fatal. */
export const disposeErrors: string[] = [];

export interface BenchScene {
  readonly id: string;
  readonly label: string;
  readonly seed: number;
  readonly params: Partial<TornadoParams>;
  /** Detail zone at the focus (in-process, one engine), or none. */
  readonly detail: boolean;
}

/** Core reaches the focus (the town centre) at this sim time (s). */
export const BENCH_ARRIVE_S = 25;
export const BENCH_WARMUP_S = 15;
export const BENCH_MEASURE_S = 20;
export const BENCH_FOCUS = { x: 0, z: 0 } as const;
/** Flag thresholds (CLAUDE.md rule 9; noise floor). */
export const BENCH_FLAG = { fraction: 0.1, ms: 0.05 } as const;

const mature = { tUp: 0, tMature: 600, tRope: 0 };

export const BENCH_SCENES: readonly BenchScene[] = [
  { id: "ef4-town", label: "EF4 town pass", seed: 1, params: { ...PRESETS.find((p) => p.id === "ef4-wedge")!.params, ...mature }, detail: false },
  { id: "detail-core", label: "30-house detail-zone core passage", seed: 1, params: { ...mature }, detail: true },
];

export const SECTIONS = ["damage", "debris", "heavy", "detail", "other"] as const;
export type Section = (typeof SECTIONS)[number];

export interface SceneResult {
  id: string;
  steps: number;
  /** ms per physics step. */
  ms: Record<Section | "total", number>;
  counts: { flying: number; resting: number; heavy: number; damaged: number; detailed: number };
  fingerprint: string;
}

/** Where the tornado starts so its core reaches the focus at BENCH_ARRIVE_S. */
export function sceneStart(scene: BenchScene): { x: number; z: number } {
  const p = { ...defaultParams(), ...scene.params };
  const a = (p.heading * Math.PI) / 180;
  const d = { x: Math.cos(a), z: -Math.sin(a) };
  const back = p.translationSpeed * BENCH_ARRIVE_S;
  return { x: BENCH_FOCUS.x - d.x * back, z: BENCH_FOCUS.z - d.z * back };
}

/** FNV-1a over a string: a short, stable fingerprint. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function runScene(scene: BenchScene, o: { warmupS?: number; measureS?: number; timing?: boolean } = {}): SceneResult {
  const warm = o.warmupS ?? BENCH_WARMUP_S;
  const meas = o.measureS ?? BENCH_MEASURE_S;
  const timing = newStepTiming();
  const sim = createSim(
    { start: sceneStart(scene), ...(o.timing === false ? {} : { timing }) },
    scene.seed,
    scene.params,
    scene.detail ? (_s, b) => createLocalBackend(b, 1) : undefined,
  );
  if (scene.detail) sim.setDetailFocus(BENCH_FOCUS);
  const chunk = 1 / 60;
  const advanceTo = (t: number) => {
    while (sim.time < t - 1e-9) sim.advance(Math.min(chunk, t - sim.time));
  };
  advanceTo(warm);
  const before: StepTiming = { ...timing };
  advanceTo(warm + meas);
  const steps = timing.steps - before.steps;
  const per = (k: keyof StepTiming) => (steps > 0 ? (timing[k] - before[k]) / steps : 0);
  const sec = { damage: per("damage"), debris: per("debris"), heavy: per("heavy"), detail: per("detail") };
  const total = per("total");
  const other = Math.max(0, total - sec.damage - sec.debris - sec.heavy - sec.detail);
  const pieces = sim.debris.pieces;
  const flying = pieces.filter((p) => !p.resting).length;
  const heavyN = pieces.filter((p) => p.rigid).length;
  const poses: number[] = [];
  for (const [i, h] of [...sim.detail.houses].sort((a, b) => a[0] - b[0])) {
    poses.push(i);
    for (let k = 0; k < h.poses.length; k += 7) poses.push(Math.round(h.poses[k]! * 1000), Math.round(h.poses[k + 1]! * 1000), Math.round(h.poses[k + 2]! * 1000));
  }
  const fingerprint = hash(
    JSON.stringify([sim.snapshot.damageHistogram, sim.snapshot.debris, sim.world.buildings.map((b) => b.dod), pieces.length, poses]),
  );
  const result: SceneResult = {
    id: scene.id,
    steps: o.timing === false ? Math.round(meas / SIM_DEFAULTS.dt) : steps,
    ms: { total: total, ...sec, other },
    counts: { flying, resting: pieces.length - flying, heavy: heavyN, damaged: sim.world.buildings.filter((b) => b.dod > 0).length, detailed: sim.detail.houses.size },
    fingerprint,
  };
  try {
    sim.dispose();
  } catch (e) {
    // Freeing a detail-zone Rapier world after a full core passage can throw a borrow error
    // (BL-013); the measurement is complete, so it only leaks this run's worlds.
    disposeErrors.push(`${scene.id}: ${(e as Error).message}`);
  }
  return result;
}

export interface BenchReport {
  version: 1;
  commit: string;
  date: string;
  machine: { cpu: string; cores: number; node: string };
  runs: number;
  scenes: SceneResult[];
}

/** Run the scenes `runs` times; each figure is the minimum over the runs (noise only adds). */
export function runBench(o: { runs?: number; scenes?: readonly string[]; commit?: string; log?: (s: string) => void } = {}): BenchReport {
  const runs = Math.max(1, o.runs ?? 2);
  const scenes = BENCH_SCENES.filter((s) => !o.scenes || o.scenes.includes(s.id));
  const out: SceneResult[] = [];
  for (const scene of scenes) {
    let best: SceneResult | null = null;
    for (let r = 0; r < runs; r++) {
      o.log?.(`${scene.id}: run ${r + 1} of ${runs}…`);
      const res = runScene(scene);
      if (!best) best = res;
      else {
        if (res.fingerprint !== best.fingerprint) throw new Error(`${scene.id}: runs differ (not deterministic)`);
        for (const k of ["total", ...SECTIONS] as const) best.ms[k] = Math.min(best.ms[k], res.ms[k]);
      }
    }
    out.push(best!);
  }
  return { version: 1, commit: o.commit ?? "unknown", date: new Date().toISOString(), machine: machine(), runs, scenes: out };
}

export function machine(): BenchReport["machine"] {
  const c = cpus();
  return { cpu: c[0]?.model ?? "unknown", cores: c.length, node: process.version };
}

export interface Change {
  scene: string;
  section: Section | "total";
  base: number;
  now: number;
  deltaMs: number;
  /** Fraction (0.1 = 10% slower). */
  change: number;
  flagged: boolean;
}

export interface Comparison {
  changes: Change[];
  flagged: Change[];
  /** Scenes whose physics differs from the baseline's. */
  physicsChanged: string[];
  missing: string[];
  machineChanged: boolean;
}

export function compareReports(base: BenchReport, now: BenchReport): Comparison {
  const changes: Change[] = [];
  const physicsChanged: string[] = [];
  const missing: string[] = [];
  for (const s of now.scenes) {
    const b = base.scenes.find((x) => x.id === s.id);
    if (!b) {
      missing.push(s.id);
      continue;
    }
    if (b.fingerprint !== s.fingerprint) physicsChanged.push(s.id);
    for (const k of ["total", ...SECTIONS] as const) {
      const deltaMs = s.ms[k] - b.ms[k];
      const change = b.ms[k] > 0 ? deltaMs / b.ms[k] : deltaMs > 0 ? Infinity : 0;
      changes.push({ scene: s.id, section: k, base: b.ms[k], now: s.ms[k], deltaMs, change, flagged: change > BENCH_FLAG.fraction && deltaMs > BENCH_FLAG.ms });
    }
  }
  const machineChanged = base.machine.cpu !== now.machine.cpu || base.machine.cores !== now.machine.cores;
  return { changes, flagged: changes.filter((c) => c.flagged), physicsChanged, missing, machineChanged };
}

/** A plain-text table of a report, with the comparison when given. */
export function formatReport(r: BenchReport, cmp?: Comparison): string {
  const lines: string[] = [];
  const f = (v: number) => v.toFixed(2).padStart(7);
  for (const s of r.scenes) {
    const scene = BENCH_SCENES.find((x) => x.id === s.id);
    lines.push(`${s.id} — ${scene?.label ?? ""} (${s.steps} steps, fingerprint ${s.fingerprint})`);
    lines.push(`  ms/step    ${["total", ...SECTIONS].map((k) => k.padStart(7)).join(" ")}`);
    lines.push(`  now        ${(["total", ...SECTIONS] as const).map((k) => f(s.ms[k])).join(" ")}`);
    if (cmp) {
      const ch = (k: Section | "total") => cmp.changes.find((c) => c.scene === s.id && c.section === k);
      lines.push(`  baseline   ${(["total", ...SECTIONS] as const).map((k) => { const c = ch(k); return c ? f(c.base) : "      –"; }).join(" ")}`);
      lines.push(`  change     ${(["total", ...SECTIONS] as const).map((k) => { const c = ch(k); return c ? `${c.change >= 0 ? "+" : ""}${Number.isFinite(c.change) ? (c.change * 100).toFixed(0) : "∞"}%${c.flagged ? "!" : ""}`.padStart(7) : "      –"; }).join(" ")}`);
    }
    const c = s.counts;
    lines.push(`  end state: ${c.flying} flying, ${c.resting} resting, ${c.heavy} heavy bodies, ${c.damaged} houses damaged, ${c.detailed} detailed`);
  }
  if (cmp) {
    if (cmp.flagged.length) lines.push(`FLAGGED (>${BENCH_FLAG.fraction * 100}% and >${BENCH_FLAG.ms} ms/step slower): ${cmp.flagged.map((c) => `${c.scene}/${c.section} ${c.base.toFixed(2)} → ${c.now.toFixed(2)} ms`).join("; ")}`);
    else lines.push("No section more than 10% slower than the baseline.");
    if (cmp.physicsChanged.length) lines.push(`Physics differs from the baseline (expected after a model change): ${cmp.physicsChanged.join(", ")}`);
    if (cmp.missing.length) lines.push(`Not in the baseline: ${cmp.missing.join(", ")}`);
    if (cmp.machineChanged) lines.push("Different machine from the baseline: timings don't compare.");
  }
  return lines.join("\n");
}
