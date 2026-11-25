/**
 * Cost of debris hit tests (Spec 10) in an EF4 town pass: CPU time per simulated second with
 * and without them, through the core passage.
 *   npx tsx scripts/profile-impacts.ts
 */
import { PRESETS } from "../src/config/presets";
import { createSim } from "../src/sim/loop";
import { initRapier } from "../src/sim/structureWorld";

await initRapier();

const ef4 = PRESETS.find((p) => p.id === "ef4-wedge")!;
for (const hits of [true, false]) {
  const sim = createSim({}, 1, ef4.params);
  if (!hits) (sim.world as unknown as { near: unknown }).near = () => [];
  while (sim.time < 55) sim.advance(0.25);
  const c0 = process.cpuUsage();
  while (sim.time < 85) sim.advance(0.25);
  const c = process.cpuUsage(c0);
  const ms = (c.user + c.system) / 1000;
  console.log(`${hits ? "with" : "without"} hit tests: ${(ms / 30).toFixed(0)} ms per simulated second; impacts ${sim.debris.stats.impacts}, airborne ${sim.debris.stats.airborne}`);
}
