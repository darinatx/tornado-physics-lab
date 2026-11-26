/**
 * Ground damage tracks (Spec 19): each preset's track over open farmland, mature, straight path.
 * Prints, across the path at its middle, the share of cells in each state and the dose spread.
 *   npx tsx scripts/track-calibrate.ts [presetId ...] [--slow]
 */
import { PRESETS } from "../src/config/presets";
import { createSim } from "../src/sim/loop";
import { TRACK_STATE } from "../src/sim/groundTrack";
import { initRapier } from "../src/sim/structureWorld";

await initRapier();
const slow = process.argv.includes("--slow");
const ids = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const NAMES = Object.keys(TRACK_STATE);
for (const id of ids.length ? ids : PRESETS.map((p) => p.id)) {
  const pr = PRESETS.find((p) => p.id === id)!;
  const params = { ...pr.params, tUp: 0, tMature: 600, tRope: 0, heading: 0, turnRate: 0, ...(slow ? { translationSpeed: (pr.params.translationSpeed ?? 12) / 2 } : {}) };
  const v = params.translationSpeed ?? 12;
  const R = params.rMax ?? 150;
  // Start 4 R_max before x = 0 and run until 4 R_max past it, over farmland (no town).
  const sim = createSim({ buildings: false, cover: { base: "farmland", rects: [] }, start: { x: -4 * R - 2000, z: 3000 } }, 1, params);
  const T = (8 * R) / v;
  const tEnd = (4 * R + 2000 + 4 * R) / v;
  while (sim.time < tEnd) sim.advance(1 / 30);
  const tr = sim.snapshot.groundTrack;
  // Sample a cross-section at x = -2000 (mid-path), z from 3000 - 3R to 3000 + 3R.
  const bands = { core: [] as number[], edge: [] as number[] };
  const doses: number[] = [];
  const count = (arr: number[]) => NAMES.map((n, k) => `${n} ${((100 * arr.filter((s) => s === k).length) / Math.max(arr.length, 1)).toFixed(0)}%`).filter((s) => !s.endsWith(" 0%")).join(", ");
  let lodgedWidth = 0;
  for (let x = -2100; x <= -1900; x += 4) {
    for (let dz = -3 * R; dz <= 3 * R; dz += 2) {
      const c = tr.cellAt(x, 3000 + dz);
      const st = c ? c.state : 0;
      (Math.abs(dz) <= R ? bands.core : bands.edge).push(st);
      if (Math.abs(dz) <= R && c) doses.push(c.dose);
      if (x === -2000 && st >= TRACK_STATE.lodged) lodgedWidth += 2;
    }
  }
  doses.sort((a, b) => a - b);
  const q = (f: number) => (doses.length ? doses[Math.floor(f * (doses.length - 1))]!.toFixed(1) : "–");
  console.log(`${id}${slow ? " (half speed)" : ""}: V ${params.vPeak} R ${R} v ${v} | width lodged+ ${lodgedWidth} m | core: ${count(bands.core)} | edge (R–3R): ${count(bands.edge)} | core dose p50 ${q(0.5)} p90 ${q(0.9)} max ${q(1)} | ${T.toFixed(0)} s`);
  sim.dispose();
}
process.exit(0);
