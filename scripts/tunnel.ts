/**
 * Wind tunnel runner (Spec 12, TUN-09): runs the scenario library on worker threads, as fast
 * as the CPU allows at the sim's fixed timesteps, and reports each scenario.
 *
 *   npm run tunnel                         every scenario
 *   npm run tunnel -- window-shot steady   only scenarios whose name contains a filter
 *   npm run tunnel -- --workers 4 --json   4 workers; JSON rows on stdout (the table on stderr)
 *
 * Exits non-zero if any scenario's checks fail (pass-through included). Hidden scenarios (self-
 * tests) run only when a filter names them.
 */
import { availableParallelism } from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { recordHash, runTunnel } from "../tests/harness/tunnel";
import { SCENARIOS } from "../tests/tunnel/scenarios";

export interface Row {
  name: string;
  worker: number;
  ok: boolean;
  problems: string[];
  simS: number;
  wallS: number;
  speed: number;
  failures: number;
  impacts: number;
  launches: number;
  passThrough: number;
  groundDips: number;
  deepestDip: number;
  dod: number;
  hash: string;
}

if (!isMainThread) {
  const id = workerData.id as number;
  parentPort!.on("message", async (name: string | null) => {
    if (name === null) process.exit(0);
    const s = SCENARIOS.find((x) => x.name === name)!;
    try {
      const r = await runTunnel(s);
      const row: Row = {
        name, worker: id, ok: r.ok, problems: r.problems, simS: s.seconds, wallS: r.perf.wallS, speed: r.perf.speed,
        failures: r.failures.length, impacts: r.impacts.length, launches: r.launches.length, passThrough: r.passThrough.total,
        groundDips: r.groundDips.count, deepestDip: r.groundDips.deepest, dod: r.final.dod, hash: recordHash(r),
      };
      parentPort!.postMessage(row);
    } catch (e) {
      parentPort!.postMessage({ name, worker: id, ok: false, problems: [`crashed: ${(e as Error).stack ?? e}`], simS: s.seconds, wallS: 0, speed: 0, failures: 0, impacts: 0, launches: 0, passThrough: 0, groundDips: 0, deepestDip: 0, dod: -1, hash: "" } satisfies Row);
    }
  });
} else {
  const args = process.argv.slice(2);
  let workers = Math.max(1, availableParallelism() - 1);
  let json = false;
  const filters: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--workers") workers = Math.max(1, Number(args[++i]));
    else if (a === "--json") json = true;
    else filters.push(a);
  }
  const chosen = SCENARIOS.filter((s) => (filters.length ? filters.some((f) => s.name.includes(f)) : !s.hidden));
  if (!chosen.length) {
    console.error(`no scenarios match ${filters.join(", ")}`);
    process.exit(2);
  }
  const out = json ? console.error : console.log;
  const n = Math.min(workers, chosen.length);
  out(`Wind tunnel: ${chosen.length} scenario${chosen.length > 1 ? "s" : ""} on ${n} worker${n > 1 ? "s" : ""}`);
  const t0 = performance.now();
  const queue = chosen.map((s) => s.name);
  const rows: Row[] = [];
  await new Promise<void>((resolve) => {
    let live = n;
    for (let id = 0; id < n; id++) {
      // Each worker registers tsx before loading this file, so it resolves the TypeScript
      // sources the way this process does (Node's own type stripping doesn't resolve
      // extensionless imports).
      const boot = `import("tsx/esm/api").then(({ register }) => { register(); return import(${JSON.stringify(import.meta.url)}); });`;
      const w = new Worker(boot, { eval: true, workerData: { id } });
      const next = () => w.postMessage(queue.shift() ?? null);
      w.on("message", (row: Row) => {
        rows.push(row);
        const mark = row.ok ? "✓" : "✗";
        out(`  ${mark} ${row.name.padEnd(34)} ${row.speed.toFixed(1).padStart(6)}× real time  ${row.wallS.toFixed(2)} s${row.ok ? "" : "  " + row.problems.join("; ")}`);
        next();
      });
      w.on("error", (e) => {
        console.error(`worker ${id} failed:`, e);
        process.exitCode = 1;
      });
      w.on("exit", () => {
        if (--live === 0) resolve();
      });
      next();
    }
  });
  const order = new Map(chosen.map((s, i) => [s.name, i]));
  rows.sort((a, b) => order.get(a.name)! - order.get(b.name)!);
  const wall = (performance.now() - t0) / 1000;
  // A worker that died leaves its scenarios unreported: they count as failed.
  for (const s of chosen) if (!rows.some((r) => r.name === s.name)) rows.push({ name: s.name, worker: -1, ok: false, problems: ["not run (worker failed)"], simS: s.seconds, wallS: 0, speed: 0, failures: 0, impacts: 0, launches: 0, passThrough: 0, groundDips: 0, deepestDip: 0, dod: -1, hash: "" });
  rows.sort((a, b) => order.get(a.name)! - order.get(b.name)!);
  const failed = rows.filter((r) => !r.ok);
  out("");
  out("scenario                            sim s   wall s   × real  failures  impacts  pass-thru  dips (deepest)   DOD");
  for (const r of rows)
    out(
      `${r.name.padEnd(34)} ${r.simS.toFixed(1).padStart(6)} ${r.wallS.toFixed(2).padStart(8)} ${r.speed.toFixed(1).padStart(8)} ${String(r.failures).padStart(9)} ${String(r.impacts).padStart(8)} ${String(r.passThrough).padStart(10)} ${`${r.groundDips} (${(r.deepestDip * 100).toFixed(0)} cm)`.padStart(15)} ${String(r.dod).padStart(5)}`,
    );
  const sim = rows.reduce((a, r) => a + r.simS, 0);
  out("");
  out(`${rows.length - failed.length} passed, ${failed.length} failed; ${sim.toFixed(1)} sim s in ${wall.toFixed(1)} s wall (${(sim / wall).toFixed(1)}× real time overall)`);
  for (const r of failed) out(`  ✗ ${r.name}: ${r.problems.join("; ")}`);
  if (json) console.log(JSON.stringify(rows, null, 1));
  process.exit(failed.length || process.exitCode ? 1 : 0);
}
