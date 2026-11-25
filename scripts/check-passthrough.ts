/**
 * Pass-through check: does any debris go through a standing wall or roof, into a slab, or
 * below the ground? A short, deterministic tornado pass through the town center.
 *   npx tsx scripts/check-passthrough.ts [seconds=6] [--detail] [--cap=N] [--full]
 * --full: 20 s with the sim's own 3,000-piece cap (a longer, heavier pass).
 */
import { runPassThrough } from "../tests/harness/runPassthrough";

const args = process.argv.slice(2);
const full = args.includes("--full");
const seconds = Number(args.find((a) => /^\d/.test(a)) ?? (full ? 20 : 6));
const detail = args.includes("--detail");
const capArg = args.find((a) => a.startsWith("--cap="));
const cap = capArg ? Number(capArg.slice(6)) : full ? 3000 : 1000;
const r = await runPassThrough({ seconds, detail, cap });
const s = r.monitor.summary();
console.log(`${r.simS.toFixed(0)} s of sim in ${r.wallS.toFixed(1)} s · ${r.monitor.checked.toLocaleString()} piece-steps checked · up to ${r.peakPieces} pieces moving${detail ? " · detail zone on" : ""}`);
const kinds = Object.keys(s.counts).sort();
if (!kinds.length) console.log("No pass-through found.");
for (const k of kinds) console.log(`  ${k}: ${s.pieces[k]} pieces (${s.counts[k]} steps)`);
for (const v of s.examples)
  console.log(`    e.g. ${v.source} "${v.label}"${v.from === undefined ? "" : v.from === v.house ? " (its own house)" : ` (from #${v.from})`} ${v.kind} of house #${v.house} at t=${v.time.toFixed(2)} s, local (${v.at.x.toFixed(2)}, ${v.at.y.toFixed(2)}, ${v.at.z.toFixed(2)}) · ${v.detail}`);
process.exit(kinds.length ? 1 : 0);
