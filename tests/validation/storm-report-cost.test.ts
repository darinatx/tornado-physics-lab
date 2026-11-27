/**
 * Spec 16, REP-15 (cost): the storm recorder adds under 5% to the physics step on the EF4 town
 * pass (the benchmark's scene and window, Spec 18), and the report builds in under 2 s. Timing
 * budgets live in tests/validation, where nothing else runs alongside (see BL-025).
 */
import { describe, expect, test } from "vitest";
import { BENCH_MEASURE_S, BENCH_SCENES, BENCH_WARMUP_S, sceneStart } from "../../src/bench/bench";
import { createSim } from "../../src/sim/loop";
import { buildReport } from "../../src/sim/report/report";
import { buildSurvey } from "../../src/sim/report/survey";
import { StormRecorder } from "../../src/sim/stormRecord";

const scene = BENCH_SCENES.find((s) => s.id === "ef4-town")!;

/** ms per physics step over the benchmark window, with or without the recorder. */
function run(record: boolean): { ms: number; rec: StormRecorder | null } {
  const sim = createSim({ start: sceneStart(scene) }, scene.seed, scene.params);
  const rec = record ? new StormRecorder(sim) : null;
  const to = (t: number) => {
    while (sim.time < t - 1e-9) sim.advance(Math.min(1 / 60, t - sim.time));
  };
  to(BENCH_WARMUP_S);
  const s0 = sim.snapshot.step;
  const t0 = performance.now();
  to(BENCH_WARMUP_S + BENCH_MEASURE_S);
  const ms = (performance.now() - t0) / (sim.snapshot.step - s0);
  sim.dispose();
  return { ms, rec };
}

describe("Spec 16 — storm report cost", () => {
  test("REP-15: the recorder adds under 5% to the EF4 town pass's physics step; the report builds in under 2 s", () => {
    // Alternating pairs, each figure the minimum (noise only adds), as the benchmark does.
    let off = Infinity;
    let on = Infinity;
    let rec: StormRecorder | null = null;
    for (let i = 0; i < 2; i++) {
      off = Math.min(off, run(false).ms);
      const r = run(true);
      on = Math.min(on, r.ms);
      rec = r.rec;
    }
    const extra = (on - off) / off;
    console.log(`REP-15: ${off.toFixed(3)} ms/step without the recorder, ${on.toFixed(3)} with it (${(extra * 100).toFixed(1)}%)`);
    expect(extra).toBeLessThan(0.05);
    const t0 = performance.now();
    const record = rec!.record();
    const report = buildReport(record, buildSurvey(record), { preliminary: false });
    const buildMs = performance.now() - t0;
    console.log(`REP-15: report built in ${buildMs.toFixed(0)} ms (${report.survey.points.length} survey points)`);
    expect(report.survey.points.length).toBeGreaterThan(500);
    expect(buildMs).toBeLessThan(2000);
  }, 600_000);
});
