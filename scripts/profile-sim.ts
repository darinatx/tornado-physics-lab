/**
 * Where the sim's time goes in a town pass, by subsystem (house damage, light debris, heavy
 * debris), every 40 sim s.
 *   npx tsx scripts/profile-sim.ts [preset = ef5-extreme] [sim seconds = 560]
 */
import { PRESETS } from "../src/config/presets";
import { createSim } from "../src/sim/loop";
import { initRapier } from "../src/sim/structureWorld";
await initRapier();
const sim: any = createSim({}, 1, PRESETS.find((p) => p.id === (process.argv[2] ?? "ef5-extreme"))!.params);
const ms = { damage: 0, spawn: 0, debris: 0 } as Record<string, number> & { damage: number; spawn: number; debris: number };
const wrap = (o: any, k: string, tag: string) => { const f = o[k].bind(o); o[k] = (...a: any[]) => { const t = performance.now(); try { return f(...a); } finally { ms[tag] = (ms[tag] ?? 0) + performance.now() - t; } }; };
wrap(sim.world, "update", "damage");
wrap(sim.debris, "step", "debris");
wrap(sim.debris, "spawnFrom", "spawn");
let last = performance.now();
for (let s = 1; s <= Number(process.argv[3] ?? 560); s++) {
  sim.advance(1);
  if (s % 40) continue;
  const h = sim._heavy?.();
  const hv = h ? Object.values(h.ms as Record<string, number>).reduce((a, b) => a + b, 0) : 0;
  const wall = performance.now() - last;
  const d = sim.debris;
  console.log(`t ${s}: ${(wall / 2000).toFixed(2)} s per 20 sim s | damage ${(ms.damage / wall * 100).toFixed(0)}% (spawn ${(ms.spawn / wall * 100).toFixed(0)}%) debris ${((ms.debris - ms.spawn * 0) / wall * 100).toFixed(0)}% heavy ${(hv / wall * 100).toFixed(0)}% other ${((wall - ms.damage - ms.debris - hv) / wall * 100).toFixed(0)}% | pieces ${d.pieces.length} settled ${d.settled.length} heavy ${h?.count ?? 0} damaged ${sim.world.buildings.filter((b: any) => b.dod > 0).length}`);
  for (const k of Object.keys(ms)) ms[k] = 0;
  if (h) for (const k of Object.keys(h.ms)) h.ms[k] = 0;
  last = performance.now();
}
