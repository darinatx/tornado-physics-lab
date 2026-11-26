/**
 * Benchmark (Spec 18): two seeded scenes, ms per physics step by section, against the baseline.
 *   npm run bench                 run and compare with bench/baseline.json
 *   npm run bench -- --save       run and save as the new baseline
 *   npm run bench -- --runs 3     more runs per scene (each figure is the minimum)
 *   npm run bench -- --scene ef4-town
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareReports, disposeErrors, formatReport, runBench } from "../src/bench/bench";
import type { BenchReport } from "../src/bench/bench";
import { initRapier } from "../src/sim/structureWorld";

await initRapier();
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const save = args.includes("--save");
const baselinePath = join(import.meta.dirname, "..", "bench", "baseline.json");
let commit = "unknown";
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim() + (execSync("git status --porcelain -- src", { encoding: "utf8" }).trim() ? " (with uncommitted src changes)" : "");
} catch {
  /* not a git checkout */
}
const t0 = performance.now();
const report = runBench({ runs: Number(opt("--runs") ?? 2), ...(opt("--scene") ? { scenes: [opt("--scene")!] } : {}), commit, log: (s) => console.error(s) });
const base: BenchReport | null = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
console.log(`\nBenchmark at ${commit}, ${report.machine.cpu} (${report.machine.cores} cores), Node ${report.machine.node}, ${report.runs} runs per scene, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
if (base) console.log(`Baseline: ${base.commit}, ${base.date.slice(0, 10)}\n`);
console.log(formatReport(report, base ? compareReports(base, report) : undefined));
if (disposeErrors.length) console.log(`\nShutdown errors (BL-013, measurement unaffected): ${disposeErrors.length}× ${disposeErrors[0]}`);
if (save) {
  writeFileSync(baselinePath, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nSaved as the baseline: ${baselinePath}`);
} else if (!base) console.log("\nNo baseline yet: run with --save to make one.");
