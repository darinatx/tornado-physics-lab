/**
 * Storm survey for a seed (Spec 16 slice A): an EF4 town pass with the storm recorder on, then
 * the survey printed, and the recorder's cost per physics step (REP-15).
 *   npx tsx scripts/storm-survey.ts                  EF4 town pass, seed 1, 50 s
 *   npx tsx scripts/storm-survey.ts --seed 7 --s 80
 *   npx tsx scripts/storm-survey.ts --cost           also time the same run without the recorder
 */
import { BENCH_MEASURE_S, BENCH_SCENES, BENCH_WARMUP_S, sceneStart } from "../src/bench/bench";
import { createSim } from "../src/sim/loop";
import { buildSurvey } from "../src/sim/report/survey";
import { surveyRows } from "../src/sim/report/table";
import { StormRecorder } from "../src/sim/stormRecord";
import { initRapier } from "../src/sim/structureWorld";

await initRapier();
const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const seed = Number(opt("--seed") ?? 1);
const S = Number(opt("--s") ?? 50);
const scene = BENCH_SCENES.find((s) => s.id === "ef4-town")!;

/** The run; `ms` is per physics step over the benchmark's window (15–35 s, Spec 18). */
function run(record: boolean) {
  const sim = createSim({ start: sceneStart(scene) }, seed, scene.params);
  const rec = record ? new StormRecorder(sim) : null;
  const to = (t: number) => {
    while (sim.time < t - 1e-9) sim.advance(Math.min(1 / 60, t - sim.time));
  };
  to(Math.min(BENCH_WARMUP_S, S));
  const s0 = sim.snapshot.step;
  const t0 = performance.now();
  to(Math.min(BENCH_WARMUP_S + BENCH_MEASURE_S, S));
  const ms = (performance.now() - t0) / Math.max(1, sim.snapshot.step - s0);
  to(S);
  sim.dispose();
  return { sim, rec, ms };
}

const a = run(true);
const tr = performance.now();
const record = a.rec!.record();
const survey = buildSurvey(record);
const buildMs = performance.now() - tr;
const km = (m: number) => `${(m / 1000).toFixed(2)} km (${(m / 1609.344).toFixed(2)} mi)`;
const cells = record.swath.tiles.reduce((n, t) => n + t.peak.filter((v) => v > 0).length, 0);

console.log(`Storm survey: EF4 town pass, seed ${seed}, ${S} s of sim time`);
console.log(`  rating           EF${survey.rating ?? "–"} (${survey.ratingMph} mph from point ${survey.ratingPoint ?? "–"})`);
console.log(`  true peak        ${survey.truePeak ? `${survey.truePeak.mph.toFixed(0)} mph, EF${survey.truePeak.ef}` : "–"}`);
console.log(`  survey points    ${survey.points.length} (no damage in the swath: ${survey.noDamage.length})`);
console.log(`  path length      survey ${km(survey.path.survey.length)}, true ${km(survey.path.true.length)}`);
console.log(`  max width        survey ${survey.path.survey.maxWidth.toFixed(0)} m, true ${survey.path.true.maxWidth.toFixed(0)} m`);
if (survey.start && survey.end) {
  console.log(`  start            ${km(survey.start.distance)} ${survey.start.compass} of the town center, t = ${survey.start.t?.toFixed(1)} s`);
  console.log(`  end              ${km(survey.end.distance)} ${survey.end.compass} of the town center, t = ${survey.end.t?.toFixed(1)} s`);
}
console.log(`  bias (survey − true 10 m)  mean ${survey.bias.mean.toFixed(1)} mph, sd ${survey.bias.sd.toFixed(1)} mph, outside the DOD's bounds: ${survey.bias.outside.length}`);
const ratio = survey.points.filter((p) => p.trueRoofMph > 0).map((p) => p.true10Mph / p.trueRoofMph);
if (ratio.length) console.log(`  10 m ÷ roof-height peak     mean ${(ratio.reduce((s, x) => s + x, 0) / ratio.length).toFixed(3)}`);
console.log(`  contours         ${survey.contours.survey.map((c) => `EF${c.ef}: ${c.runs.length} run(s)`).join(", ")}`);
console.log(`  record           ${record.track.length} track samples, ${cells} swath cells, ${record.debris.pieces.length} debris pieces, ${Object.values(record.debris.impacts.bySurface).reduce((n, t) => n + t.hits, 0)} impacts, ${(JSON.stringify(record).length / 1e6).toFixed(1)} MB JSON`);
console.log(`  build            ${buildMs.toFixed(0)} ms (record + survey)`);
console.log("\nFirst rows of the survey table:");
console.table(surveyRows(survey).slice(0, 8).map((r) => ({ P: r.point, DOD: r.dod, cls: r.construction.split(" ")[0], survey: r.surveyMph, EF: r.ef, range: r.rangeMph, true10: r.true10Mph, roof: r.trueRoofMph, bias: r.biasMph })));

if (args.includes("--cost")) {
  const b = run(false);
  console.log(`\nPhysics step: ${b.ms.toFixed(3)} ms without the recorder, ${a.ms.toFixed(3)} ms with it (+${(((a.ms - b.ms) / b.ms) * 100).toFixed(1)}%)`);
}
