/**
 * Cost of heavy debris as rigid bodies (Spec 04 v2.0) in an EF4 town pass: wall time per 20 s
 * of sim, bodies in the heavy-debris world, houses built as colliders there, and its time by
 * phase (houses, aero, physics, poses).
 *   npx tsx scripts/profile-heavy.ts [sim seconds = 520]
 */
import { PRESETS } from "../src/config/presets";
import { createSim } from "../src/sim/loop";
import { initRapier } from "../src/sim/structureWorld";

await initRapier();
const seconds = Number(process.argv[2] ?? 520);
const ef4 = PRESETS.find((p) => p.id === "ef4-wedge")!;
const sim = createSim({}, 1, ef4.params);
let last = performance.now();
for (let s = 1; s <= seconds; s++) {
  sim.advance(1);
  if (s % 20) continue;
  const h = sim._heavy?.() ?? null;
  const ms = h ? Object.entries(h.ms).map(([k, v]) => `${k} ${Math.round(v)}`).join(", ") : "";
  console.log(`t ${String(s).padStart(4)} s: ${String(Math.round(performance.now() - last)).padStart(6)} ms per 20 sim s   bodies ${String(h?.count ?? 0).padStart(5)}   ${ms}`);
  if (h) for (const k of Object.keys(h.ms) as (keyof typeof h.ms)[]) h.ms[k] = 0;
  last = performance.now();
}
