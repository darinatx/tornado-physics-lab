/**
 * Validation of detailed houses against DI 2 (Spec 09 slice C, STR-21): standard houses passed
 * through simulated strong tornadoes (the same cases as the component model's calibration);
 * Kaplan–Meier median peak wind at first reaching each DOD vs the DI 2 expected speed.
 *   npx tsx scripts/validate-detail.ts [houses=40] [seed=100] [workers=8]
 * Runs houses in parallel child processes.
 */
import { fork } from "node:child_process";
import { DI2_DODS } from "../src/config/buildings";
import { createHouse } from "../src/core/damage/building";
import { kmMedian, samplePassCase } from "../src/core/damage/steadyRamp";
import { randomHouseSpec } from "../src/sim/city";
import { detailPass } from "../src/sim/detailPass";
import { createRng } from "../src/sim/rng";
import { initRapier } from "../src/sim/structureWorld";

const [n = 40, seed = 100, workers = 8] = process.argv.slice(2).map(Number);

/** Case i of the sample (same houses and tornadoes for every run with this seed). */
function runCase(i: number) {
  const rng = createRng(seed + i * 7919);
  const b = createHouse(randomHouseSpec(i, rng, 0, 0, rng() * Math.PI * 2, "standard"), rng);
  const c = samplePassCase(rng);
  return detailPass(b, c.state, "open", c.offset);
}

if (process.env.VALIDATE_CHILD) {
  await initRapier();
  const ids = JSON.parse(process.env.VALIDATE_CHILD) as number[];
  for (const i of ids) process.send!({ i, r: runCase(i) });
  process.exit(0);
} else {
  const results: ReturnType<typeof runCase>[] = [];
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: workers }, (_, w) => {
      const ids = Array.from({ length: n }, (_, i) => i).filter((i) => i % workers === w);
      return new Promise<void>((done) => {
        const child = fork(process.argv[1]!, process.argv.slice(2), { env: { ...process.env, VALIDATE_CHILD: JSON.stringify(ids) }, execArgv: process.execArgv });
        child.on("message", (m: { i: number; r: ReturnType<typeof runCase> }) => {
          results[m.i] = m.r;
          process.stderr.write(".");
        });
        child.on("exit", () => done());
      });
    }),
  );
  console.log(`\n${n} houses in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const done = results.filter(Boolean);
  if (process.env.VALIDATE_JSON) {
    // Machine-readable: KM median per DOD (for the STR-21 validation test).
    const medians = DI2_DODS.map((r) =>
      kmMedian(done.map((x) => (Number.isFinite(x.first[r.dod]!) ? { t: x.first[r.dod]!, observed: true } : { t: x.peak, observed: false }))),
    );
    console.log("JSON " + JSON.stringify({ houses: done.length, medians }));
  }
  for (const r of DI2_DODS) {
    const med = kmMedian(done.map((x) => (Number.isFinite(x.first[r.dod]!) ? { t: x.first[r.dod]!, observed: true } : { t: x.peak, observed: false })));
    const reached = done.filter((x) => Number.isFinite(x.first[r.dod]!)).length;
    console.log(
      `DOD ${String(r.dod).padStart(2)}: median ${Number.isFinite(med) ? med.toFixed(0).padStart(3) : "  –"} mph  expected ${r.expected} (${r.lower}–${r.upper})  ` +
        `${Number.isFinite(med) ? `${((med / r.expected - 1) * 100).toFixed(0).padStart(4)}%` : "     "}  reached ${reached}/${done.length}`,
    );
  }
  console.log("final DODs:", done.map((x) => x.dod).join(","));
  // Which connections go first: KM median peak wind at first failure, per kind.
  const labels = [...new Set(done.flatMap((x) => Object.keys(x.firstFail)))];
  const rows = labels.map((l) => {
    const med = kmMedian(done.map((x) => (x.firstFail[l] !== undefined ? { t: x.firstFail[l]!, observed: true } : { t: x.peak, observed: false })));
    return [med, `  ${l}: ${Number.isFinite(med) ? med.toFixed(0) : "–"} mph (${done.filter((x) => x.firstFail[l] !== undefined).length}/${done.length})`] as const;
  });
  console.log("first failure, median peak wind:\n" + rows.sort((a, b) => a[0] - b[0]).map((r) => r[1]).join("\n"));
}
