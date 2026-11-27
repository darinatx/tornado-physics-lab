/**
 * Phase 7 validation (slice E): how much of the EF readout in "auto" terrain comes from the
 * storm's own ground track (Spec 19 lowers z₀ where crops are lodged or soil scoured). Runs a
 * preset through town and, every 0.5 s, reads the 10 m peak over the sim's field and over a
 * field of the same buildings without the track (rebuilt every 10 s).
 *   npx tsx scripts/readout-track.ts [presetId = ef4-wedge]
 */
import { EF_REFERENCE_HEIGHT } from "../src/config/wind";
import { PRESETS } from "../src/config/presets";
import { CITY } from "../src/sim/city";
import { createSim } from "../src/sim/loop";
import { initRapier } from "../src/sim/structureWorld";
import { TownRoughness, townCover } from "../src/sim/terrain";
import { peakGroundSpeed } from "../src/core/wind/peak";
import { msToMph } from "../src/core/wind/efScale";

await initRapier();
const id = process.argv[2] ?? "ef4-wedge";
const pr = PRESETS.find((p) => p.id === id)!;
const sim: any = createSim({}, 1, { ...pr.params, terrain: "auto" });
const half = CITY.extent / 2;
let plain: TownRoughness | null = null;
let best = { withTrack: 0, noTrack: 0, open: 0, t: 0 };
let n = 0, sumDiff = 0, maxDiff = 0;
while (sim.time < sim.snapshot.lifetime) {
  sim.advance(0.5);
  const s = sim.snapshot;
  if (s.phase === "dissipated") break;
  if (!plain || Math.round(s.time * 2) % 20 === 0) plain = new TownRoughness(townCover(CITY.extent), sim.world.buildings);
  const c = s.tornado.center;
  if (!(Math.abs(c.x) < half && Math.abs(c.z) < half && s.phase === "mature")) continue;
  const a = msToMph(peakGroundSpeed(s.tornado, s.terrain, EF_REFERENCE_HEIGHT));
  const b = msToMph(peakGroundSpeed(s.tornado, plain.field, EF_REFERENCE_HEIGHT));
  const o = msToMph(peakGroundSpeed(s.tornado, "open", EF_REFERENCE_HEIGHT));
  if (a > best.withTrack) best = { withTrack: a, noTrack: b, open: o, t: s.time };
  n++, (sumDiff += a - b), (maxDiff = Math.max(maxDiff, a - b));
}
console.log(`${id}: in town, mature, ${n} samples | peak readout with track ${best.withTrack.toFixed(1)} mph at t ${best.t} s (same moment: no track ${best.noTrack.toFixed(1)}, open ${best.open.toFixed(1)}) | track adds mean ${(sumDiff / n).toFixed(1)}, max ${maxDiff.toFixed(1)} mph`);
process.exit(0);
