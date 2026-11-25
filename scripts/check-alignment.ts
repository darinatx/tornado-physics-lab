/**
 * Detail vs component alignment report (Spec 09, STR-31): the same patches of houses on both
 * models, house by house and by wind band.
 *   npm run check:alignment [-- --solo] [--offsets=0,260,420] [--seed=1] [--radius=45]
 *   --solo: each detailed house in its own physics world (no hits from neighbors)
 */
import { ALIGNMENT_PATCHES, runPaired, summarize } from "../tests/harness/alignment";
import type { Paired, PatchSpec } from "../tests/harness/alignment";

const args = process.argv.slice(2);
const opt = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const solo = args.includes("--solo");
const seed = Number(opt("seed") ?? 1);
const radius = Number(opt("radius") ?? ALIGNMENT_PATCHES[0]!.radius);
const offsets = opt("offsets")?.split(",").map(Number);
const patches: PatchSpec[] = (offsets ?? ALIGNMENT_PATCHES.map((p) => p.offset)).map((offset) => ({ ...ALIGNMENT_PATCHES[0]!, offset, seed, radius }));

const t0 = performance.now();
const rows: Paired[] = [];
for (const p of patches) {
  const r = await runPaired(p, { soloWorlds: solo });
  console.log(`offset ${p.offset} m: ${r.length} houses (${((performance.now() - t0) / 1000).toFixed(0)} s so far)`);
  rows.push(...r);
}
const pct = (v: number) => (Number.isNaN(v) ? "  – " : `${Math.round(v * 100)}%`.padStart(4));
rows.sort((a, b) => a.peak - b.peak);
console.log(`\nper house: peak wind · DOD · walls standing · roof on · within 5 m   (detail | component)${solo ? "   [solo worlds]" : ""}`);
for (const r of rows)
  console.log(`  #${String(r.id).padEnd(5)} ${r.cls.padEnd(8)} ${String(r.peak).padStart(3)} mph  DOD ${r.detail.dod}|${r.component.dod}  wall ${pct(r.detail.wall)}|${pct(r.component.wall)}  roof ${pct(r.detail.roof)}|${pct(r.component.roof)}  near ${pct(r.detail.near)}|${pct(r.component.near)}`);
console.log("\nmedians by band (detail | component):");
for (const b of summarize(rows))
  console.log(`  ${b.label.padEnd(12)} n=${String(b.n).padStart(2)}  DOD ${b.dod[0]}|${b.dod[1]}  wall ${pct(b.wall[0])}|${pct(b.wall[1])}  roof ${pct(b.roof[0])}|${pct(b.roof[1])}  near ${pct(b.near[0])}|${pct(b.near[1])}`);
console.log(`\n${((performance.now() - t0) / 1000).toFixed(0)} s`);
