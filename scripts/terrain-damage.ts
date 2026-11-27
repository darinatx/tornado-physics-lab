/**
 * Phase 7 validation (slice E, check 4): a preset's full pass through the default town with the
 * town as open country ("open", the pre-Phase-7 default) and with its own roughness ("auto").
 * Prints houses damaged and destroyed, the DOD histogram, and the peak 10 m EF readout (over
 * the whole run, and while the centre is inside the town).
 *   npx tsx scripts/terrain-damage.ts [presetId = ef2-cone] [open|auto ...] [--seed N]
 */
import { PRESETS } from "../src/config/presets";
import { CITY } from "../src/sim/city";
import { createSim } from "../src/sim/loop";
import { initRapier } from "../src/sim/structureWorld";
import { computeReadout } from "../src/ui/readout";

await initRapier();
const args = process.argv.slice(2);
const seedAt = args.indexOf("--seed");
const seed = seedAt >= 0 ? Number(args[seedAt + 1]) : 1;
const plain = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--seed");
const id = plain[0] ?? "ef2-cone";
const terrains = plain.slice(1).length ? plain.slice(1) : ["open", "auto"];
const pr = PRESETS.find((p) => p.id === id)!;
const half = CITY.extent / 2;
for (const terrain of terrains) {
  const t0 = performance.now();
  const sim = createSim({}, seed, { ...pr.params, terrain: terrain as never });
  let peak = 0, peakTown = 0, sumTown = 0, nTown = 0;
  const life = sim.snapshot.lifetime;
  while (sim.time < life) {
    sim.advance(0.5);
    const s = sim.snapshot;
    if (s.phase === "dissipated") break;
    const r = computeReadout(s);
    peak = Math.max(peak, r.mph);
    const c = s.tornado.center;
    if (Math.abs(c.x) < half && Math.abs(c.z) < half && s.phase === "mature") {
      peakTown = Math.max(peakTown, r.mph);
      sumTown += r.mph;
      nTown++;
    }
  }
  const s = sim.snapshot;
  const r = computeReadout(s);
  console.log(JSON.stringify({ preset: id, terrain, seed, simS: Math.round(s.time), wallS: Math.round((performance.now() - t0) / 1000), houses: r.tally.total, damaged: r.tally.damaged, destroyed: r.tally.destroyed, hist: s.damageHistogram, peakMph: +peak.toFixed(1), peakTownMph: +peakTown.toFixed(1), meanTownMatureMph: nTown ? +(sumTown / nTown).toFixed(1) : null, debris: { spawned: r.debris } }));
  sim.dispose();
}
process.exit(0);
