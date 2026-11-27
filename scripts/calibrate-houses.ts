/**
 * Stage 1 of Spec 03 v2.5's calibration (relative strengths; DMG-16): standard houses at the default town's sites,
 * in its roughness field, passed through simulated strong tornadoes, should reach each DI 2 DOD
 * at a median 10 m open-terrain peak (the EF scale's basis) equal to its expected speed.
 * Also prints the roof-height medians, the strong houses' DOD 10 median (DMG-15) and the
 * steady-ramp medians for reference.
 * Its output is stage 2's starting point: save it as JSON and pass it to
 * `scripts/calibrate-town.ts driver --caps`, which sets the scale in full town runs.
 *   npx tsx scripts/calibrate-houses.ts
 */
import { BASE_CAPACITY, DI2_DODS, PARTS, PART_CALIBRATION_DOD as PART_DOD } from "../src/config/buildings";
import type { ConstructionClass, Part } from "../src/config/buildings";
import { createHouse } from "../src/core/damage/building";
import { kmMedian, steadyRamp } from "../src/core/damage/steadyRamp";
import { townPassSamples } from "../src/sim/calibrationTown";
import { randomHouseSpec } from "../src/sim/city";
import { createRng } from "../src/sim/rng";


function passMedians(base: Record<Part, number>, n: number, seed: number, cls: ConstructionClass = "standard"): number[] {
  return townPassSamples(n, seed, cls, base).samples.map((a) => (a.length ? kmMedian(a) : 0));
}

function steadyMedians(base: Record<Part, number>, n: number, seed: number): number[] {
  const rng = createRng(seed);
  const samples: { t: number; observed: boolean }[][] = Array.from({ length: 11 }, () => []);
  for (let i = 0; i < n; i++) {
    const b = createHouse(randomHouseSpec(i, rng, 0, 0, rng() * Math.PI * 2, "standard"), rng, base);
    const f = steadyRamp(b, rng() * Math.PI * 2);
    for (let d = 1; d <= 10; d++) samples[d]!.push(Number.isFinite(f[d]!) ? { t: f[d]!, observed: true } : { t: 280, observed: false });
  }
  return samples.map((a) => (a.length ? kmMedian(a) : 0));
}

const base = { ...BASE_CAPACITY };
for (let round = 0; round < 20; round++) {
  // Same houses and tornadoes every round (common random numbers) so the iteration converges.
  const m = passMedians(base, 700, 100);
  const worst = Math.max(...DI2_DODS.map((r) => Math.abs(m[r.dod]! / r.expected - 1)));
  console.log(`round ${round}: worst error ${(worst * 100).toFixed(1)}%`);
  for (const p of PARTS) {
    if (!PART_DOD[p]) continue;
    const target = DI2_DODS[PART_DOD[p] - 1]!.expected;
    const got = m[PART_DOD[p]]!;
    base[p] *= Number.isFinite(got) ? Math.pow(target / got, 2 * (round < 10 ? 0.5 : 0.3)) : 0.7;
  }
}
const pass = passMedians(base, 800, 7);
const strong = passMedians(base, 400, 9, "strong");
console.log(`strong DOD 10: ${strong[10]!.toFixed(0)} mph (DMG-15 target ${DI2_DODS[9]!.upper})`);
const steady = steadyMedians(base, 600, 8);
for (const r of DI2_DODS) {
  console.log(
    `DOD ${r.dod}: tornado ${pass[r.dod]!.toFixed(0)} mph, steady ${steady[r.dod]} mph ` +
      `(expected ${r.expected}, band ${r.lower}–${r.upper})`,
  );
}
console.log("BASE_CAPACITY =", JSON.stringify(Object.fromEntries(Object.entries(base).map(([k, v]) => [k, Math.round(v)])), null, 2));
