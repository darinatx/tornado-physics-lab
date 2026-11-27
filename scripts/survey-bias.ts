/**
 * Phase 8 validation (slice E, check 2): survey bias across seeded storms. One preset's full
 * lifecycle over the default town with the storm recorder on, then the EF-method survey
 * against the sim's true 10 m wind (open-terrain basis, Spec 16 v1.1):
 *   - survey speed − true 10 m peak, by DOD and by construction class;
 *   - the share of points whose true 10 m peak is outside their DOD's range (below / above);
 *   - the rating against the true peak's EF, and against the highest true 10 m peak any
 *     damaged house saw;
 *   - the 10 m ÷ roof-height peak ratio;
 *   - the rating point: its DOD, class, true winds and failure causes; the point that
 *     corroborates it, the points set aside as uncorroborated, and the highest point (the
 *     rating before Spec 16 v1.9).
 * Prints one JSON line per run. With --save <file>, also writes the run's report JSON there
 * (for the hand checks of check 4).
 *   npx tsx scripts/survey-bias.ts <presetId> [--seed N] [--save file.json]
 */
import { writeFileSync } from "node:fs";
import { PRESETS } from "../src/config/presets";
import { MS_PER_MPH } from "../src/config/units";
import { efRating } from "../src/core/wind/efScale";
import { createSim } from "../src/sim/loop";
import { reportJson } from "../src/sim/report/export";
import { buildSurvey } from "../src/sim/report/survey";
import type { SurveyPoint } from "../src/sim/report/survey";
import { StormRecorder } from "../src/sim/stormRecord";
import { initRapier } from "../src/sim/structureWorld";

await initRapier();
const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const id = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "ef4-wedge";
const seed = Number(opt("--seed") ?? 1);
const save = opt("--save");
const pr = PRESETS.find((p) => p.id === id);
if (!pr) throw new Error(`no preset ${id}`);

const t0 = performance.now();
const sim = createSim({}, seed, pr.params);
const rec = new StormRecorder(sim);
const life = sim.snapshot.lifetime;
// The whole lifecycle, then the 3 s wait for the last debris (Spec 16 "Ending a run").
while (sim.time < life + 3) {
  sim.advance(0.5);
  if (sim.snapshot.phase === "dissipated" && sim.time > life + 3) break;
}
const record = rec.record();
const survey = buildSurvey(record);
const wallS = (performance.now() - t0) / 1000;
if (save) writeFileSync(save, reportJson(record, survey, false));

/** Mean and sample sd, unrounded. */
const raw = (xs: number[]) => {
  const n = xs.length;
  const mean = n ? xs.reduce((s, x) => s + x, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { mean, sd };
};
const stats = (xs: number[]) => {
  const n = xs.length;
  const mean = n ? xs.reduce((s, x) => s + x, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean: +mean.toFixed(1), sd: +sd.toFixed(1) };
};
const group = (key: (p: SurveyPoint) => string | number) => {
  const m = new Map<string | number, SurveyPoint[]>();
  for (const p of survey.points) (m.get(key(p)) ?? m.set(key(p), []).get(key(p))!).push(p);
  return Object.fromEntries(
    [...m.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, ps]) => [
        k,
        {
          ...stats(ps.map((p) => p.biasMph)),
          below: ps.filter((p) => p.true10Mph < p.lowMph).length,
          above: ps.filter((p) => p.true10Mph > p.highMph).length,
          ratio: +raw(ps.filter((p) => p.trueRoofMph > 0).map((p) => p.true10Mph / p.trueRoofMph)).mean.toFixed(3),
          meanTrue10: +stats(ps.map((p) => p.true10Mph)).mean.toFixed(0),
          meanRoof: +stats(ps.map((p) => p.trueRoofMph)).mean.toFixed(0),
        },
      ]),
  );
};

const pts = survey.points;
const ratioAll = pts.filter((p) => p.trueRoofMph > 0).map((p) => p.true10Mph / p.trueRoofMph);
const rp = survey.ratingPoint === null ? null : pts[survey.ratingPoint]!;
const rb = rp ? record.buildings[rp.index]! : null;
const maxPt10 = pts.reduce((m, p) => Math.max(m, p.true10Mph), 0);
const causes = rb ? rb.failures.reduce<Record<string, number>>((m, f) => ((m[f.cause] = (m[f.cause] ?? 0) + 1), m), {}) : {};
// Damaged with a true 10 m peak under EF0 (65 mph): damage the wind there can't explain alone.
const subEF0 = pts.filter((p) => p.true10Mph < 65);
const debrisOnly = pts.filter((p) => {
  const b = record.buildings[p.index]!;
  return b.failures.length > 0 && b.failures.every((f) => f.cause === "debris");
});
// Points at the rating EF: how their true winds compare.
const atRating = pts.filter((p) => p.ef !== null && p.ef === survey.rating);
// Corroboration (Spec 16 v1.9): the pair that set the rating, the points set aside, and what
// the old rule (the highest point) would have rated.
const cp = survey.corroboratingPoint === null ? null : pts[survey.corroboratingPoint]!;
const brief = (p: SurveyPoint) => ({ id: p.id, dod: p.dod, cls: p.cls, mph: p.mph, ef: p.ef, true10: +p.true10Mph.toFixed(1), roof: +p.trueRoofMph.toFixed(1) });
const highest = pts.reduce<SurveyPoint | null>((m, p) => (p.ef !== null && (!m || p.mph > m.mph) ? p : m), null);

console.log(
  JSON.stringify({
    preset: id,
    seed,
    simS: Math.round(sim.time),
    wallS: Math.round(wallS),
    points: pts.length,
    noDamage: survey.noDamage.length,
    rating: survey.rating,
    ratingMph: survey.ratingMph,
    truePeak: survey.truePeak ? { mph: +survey.truePeak.mph.toFixed(1), ef: survey.truePeak.ef } : null,
    maxPoint10: { mph: +maxPt10.toFixed(1), ef: efRating(maxPt10 * MS_PER_MPH) },
    ratingPoint: rp && rb
      ? { dod: rp.dod, cls: rp.cls, mph: rp.mph, true10: +rp.true10Mph.toFixed(1), roof: +rp.trueRoofMph.toFixed(1), closestEdge: rb.closestEdge, failures: rb.failures.length, firstFail: rb.firstFail, causes }
      : null,
    corroborated: survey.corroborated,
    corroboratedBy: cp && rp ? { ...brief(cp), distance: +Math.hypot(cp.x - rp.x, cp.z - rp.z).toFixed(1) } : null,
    uncorroborated: survey.uncorroborated.map((i) => brief(pts[i]!)),
    highestPoint: highest ? brief(highest) : null,
    atRating: { ...stats(atRating.map((p) => p.true10Mph)), roof: stats(atRating.map((p) => p.trueRoofMph)).mean },
    bias: { ...stats(pts.map((p) => p.biasMph)), reported: { mean: +survey.bias.mean.toFixed(1), sd: +survey.bias.sd.toFixed(1) } },
    outside: {
      n: survey.bias.outside.length,
      share: pts.length ? +(survey.bias.outside.length / pts.length).toFixed(3) : 0,
      below: pts.filter((p) => p.true10Mph < p.lowMph).length,
      above: pts.filter((p) => p.true10Mph > p.highMph).length,
    },
    ratio10Roof: +raw(ratioAll).mean.toFixed(3),
    ratioSd: +raw(ratioAll).sd.toFixed(3),
    subEF0: subEF0.length,
    debrisOnly: debrisOnly.length,
    path: {
      survey: { length: Math.round(survey.path.survey.length), width: Math.round(survey.path.survey.maxWidth) },
      true: { length: Math.round(survey.path.true.length), width: Math.round(survey.path.true.maxWidth) },
    },
    byDod: group((p) => p.dod),
    byCls: group((p) => p.cls),
  }),
);
sim.dispose();
process.exit(0);
