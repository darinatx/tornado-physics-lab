/**
 * One benchmark scene (Spec 18), for a CPU profile:
 *   node --cpu-prof --cpu-prof-dir=<dir> --import tsx scripts/profile-bench.ts <scene id>
 */
import { BENCH_SCENES, runScene } from "../src/bench/bench";
import { initRapier } from "../src/sim/structureWorld";
await initRapier();
const scene = BENCH_SCENES.find((s) => s.id === (process.argv[2] ?? "ef4-town"))!;
const r = runScene(scene);
console.log(JSON.stringify(r.ms));
process.exit(0);
