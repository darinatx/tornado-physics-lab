/**
 * Phase 8 profiling (slice D): the EF4 town pass with the storm recorder on (as the app runs it),
 * then the report build, the page's HTML and the exports, each timed. For a CPU profile:
 *   node --cpu-prof --cpu-prof-dir=<dir> --import tsx scripts/profile-report.ts [seconds]
 * Prints ms per physics step over the benchmark window and the report timings.
 */
import { BENCH_MEASURE_S, BENCH_SCENES, BENCH_WARMUP_S, sceneStart } from "../src/bench/bench";
import { createSim } from "../src/sim/loop";
import { reportJson, surveyCsv } from "../src/sim/report/export";
import { buildReport } from "../src/sim/report/report";
import { buildSurvey } from "../src/sim/report/survey";
import { StormRecorder } from "../src/sim/stormRecord";
import { initRapier } from "../src/sim/structureWorld";
import { renderReport } from "../src/ui/report/html";

await initRapier();
const S = Number(process.argv[2] ?? BENCH_WARMUP_S + BENCH_MEASURE_S);
const scene = BENCH_SCENES.find((s) => s.id === "ef4-town")!;
const sim = createSim({ start: sceneStart(scene) }, scene.seed, scene.params);
const rec = new StormRecorder(sim);
const to = (t: number) => {
  while (sim.time < t - 1e-9) sim.advance(Math.min(1 / 60, t - sim.time));
};
to(Math.min(BENCH_WARMUP_S, S));
const s0 = sim.snapshot.step;
const t0 = performance.now();
to(S);
const ms = (performance.now() - t0) / Math.max(1, sim.snapshot.step - s0);

const time = <T>(label: string, f: () => T, n = 5): T => {
  let best = Infinity;
  let out!: T;
  for (let i = 0; i < n; i++) {
    const a = performance.now();
    out = f();
    best = Math.min(best, performance.now() - a);
  }
  console.log(`${label.padEnd(26)} ${best.toFixed(1)} ms`);
  return out;
};
console.log(`physics step with the recorder: ${ms.toFixed(3)} ms (${S} s)`);
const record = time("record()", () => rec.record());
const survey = time("buildSurvey", () => buildSurvey(record));
const report = time("buildReport", () => buildReport(record, survey, { preliminary: false }));
const html = time("renderReport (HTML string)", () => renderReport(report));
const json = time("reportJson", () => reportJson(record, survey, false));
time("surveyCsv", () => surveyCsv(survey));
console.log(`sizes: HTML ${(html.length / 1e6).toFixed(2)} MB, JSON ${(json.length / 1e6).toFixed(2)} MB; ${survey.points.length} points, ${report.map.swath.length} swath runs, ${report.map.landings.length} landings, ${record.debris.pieces.length} debris records`);
sim.dispose();
process.exit(0);
