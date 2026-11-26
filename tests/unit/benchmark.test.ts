/**
 * Spec 18 — benchmark. Short windows keep these fast; the full scenes run in `npm run bench`.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SIM_DEFAULTS } from "../../src/config/sim";
import { BENCH_FLAG, BENCH_SCENES, compareReports, machine, runScene, SECTIONS } from "../../src/bench/bench";
import type { BenchReport, SceneResult } from "../../src/bench/bench";

const SHORT = { warmupS: 0.5, measureS: 0.5 };
const scene = (id: string) => BENCH_SCENES.find((s) => s.id === id)!;

describe("Spec 18 — benchmark", () => {
  test("BENCH-01: exactly two seeded scenes; a scene run twice gives the same fingerprint", () => {
    expect(BENCH_SCENES.map((s) => s.id)).toEqual(["ef4-town", "detail-core"]);
    for (const s of BENCH_SCENES) expect(Number.isInteger(s.seed)).toBe(true);
    for (const s of BENCH_SCENES) expect(runScene(s, SHORT).fingerprint).toBe(runScene(s, SHORT).fingerprint);
  }, 300000);

  test("BENCH-02: the timing hook changes no physics", () => {
    for (const s of BENCH_SCENES) expect(runScene(s, { ...SHORT, timing: false }).fingerprint).toBe(runScene(s, SHORT).fingerprint);
  }, 300000);

  test("BENCH-03: steps in the window, every section ≥ 0 and summing to the total; detail only in detail-core", () => {
    for (const s of BENCH_SCENES) {
      const r = runScene(s, SHORT);
      expect(r.steps).toBe(Math.round(SHORT.measureS / SIM_DEFAULTS.dt));
      for (const k of ["total", ...SECTIONS] as const) expect(r.ms[k]).toBeGreaterThanOrEqual(0);
      const sum = SECTIONS.reduce((a, k) => a + r.ms[k], 0);
      expect(Math.abs(sum - r.ms.total)).toBeLessThan(1e-9 + r.ms.total * 1e-9);
      expect(r.ms.total).toBeGreaterThan(0);
      if (s.detail) {
        expect(r.counts.detailed).toBeGreaterThan(0);
        expect(r.ms.detail).toBeGreaterThan(0);
      } else expect(r.counts.detailed).toBe(0);
    }
  }, 300000);

  const result = (id: string, ms: Partial<SceneResult["ms"]>, fingerprint = "aaaa"): SceneResult => ({
    id,
    steps: 2400,
    ms: { total: 10, damage: 2, debris: 3, heavy: 1, detail: 3, other: 1, ...ms },
    counts: { flying: 0, resting: 0, heavy: 0, damaged: 0, detailed: 0 },
    fingerprint,
  });
  const report = (scenes: SceneResult[], cpu = "cpu"): BenchReport => ({ version: 1, commit: "x", date: "2026-11-26T00:00:00Z", machine: { cpu, cores: 8, node: "v1" }, runs: 2, scenes });

  test("BENCH-04: changes in ms and percent; flags exactly >10% and >0.05 ms slower; reports physics and machine changes", () => {
    const base = report([result("ef4-town", {}), result("detail-core", { debris: 0.2 })]);
    const now = report([result("ef4-town", { total: 11.2, damage: 2.19, heavy: 1.06 }, "bbbb"), result("detail-core", { debris: 0.24 })], "other cpu");
    const c = compareReports(base, now);
    const at = (s: string, k: string) => c.changes.find((x) => x.scene === s && x.section === k)!;
    expect(at("ef4-town", "total").deltaMs).toBeCloseTo(1.2, 9);
    expect(at("ef4-town", "total").change).toBeCloseTo(0.12, 9);
    // total +12% and +1.2 ms: flagged. damage +9.5%: not. heavy +6%: not. detail-core debris +20% but +0.04 ms: below the noise floor.
    expect(c.flagged.map((x) => `${x.scene}/${x.section}`)).toEqual(["ef4-town/total"]);
    expect(at("detail-core", "debris").change).toBeGreaterThan(BENCH_FLAG.fraction);
    expect(c.physicsChanged).toEqual(["ef4-town"]);
    expect(c.machineChanged).toBe(true);
    expect(compareReports(base, base).flagged).toEqual([]);
  });

  test("BENCH-05: a saved baseline carries report, commit, date, machine and Node version, and reads back the same", () => {
    const r = { ...report([result("ef4-town", {})]), machine: machine(), commit: "abc1234" };
    expect(r.machine.node).toBe(process.version);
    expect(r.machine.cores).toBeGreaterThan(0);
    const dir = mkdtempSync(join(tmpdir(), "bench-"));
    const p = join(dir, "baseline.json");
    writeFileSync(p, JSON.stringify(r, null, 2));
    const back = JSON.parse(readFileSync(p, "utf8")) as BenchReport;
    expect(back).toEqual(r);
    for (const k of ["commit", "date", "machine", "scenes"] as const) expect(back[k]).toBeDefined();
    // The CLI writes exactly this shape (scripts/bench.ts).
    const cli = readFileSync(join(import.meta.dirname, "../../scripts/bench.ts"), "utf8");
    expect(cli).toMatch(/writeFileSync\(baselinePath, JSON\.stringify\(report/);
  });
});
