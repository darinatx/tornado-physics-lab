/**
 * Calibrates BASE_CAPACITY (Spec 03, DMG-04): standard houses passed through simulated strong
 * tornadoes should reach each DI 2 DOD at a median peak wind equal to its expected speed.
 *   npx tsx scripts/calibrate-houses.ts
 */
import { BASE_CAPACITY, DI2_DODS, PARTS, PART_CALIBRATION_DOD as PART_DOD } from "../src/config/buildings";
import type { Part } from "../src/config/buildings";
import { createHouse } from "../src/core/damage/building";
import { kmMedian, samplePassCase, steadyRamp, tornadoPass } from "../src/core/damage/steadyRamp";
import { randomHouseSpec } from "../src/sim/city";
import { createRng } from "../src/sim/rng";


function passMedians(base: Record<Part, number>, n: number, seed: number): number[] {
  const rng = createRng(seed);
  const samples: { t: number; observed: boolean }[][] = Array.from({ length: 11 }, () => []);
  for (let i = 0; i < n; i++) {
    const b = createHouse(randomHouseSpec(i, rng, 0, 0, rng() * Math.PI * 2, "standard"), rng, base);
    const c = samplePassCase(rng);
    const f = tornadoPass(b, c.state, "open", c.offset);
    // Censored at the house's peak wind when it never reached the DOD.
    for (let d = 1; d <= 10; d++) samples[d]!.push(Number.isFinite(f[d]!) ? { t: f[d]!, observed: true } : { t: b.peakMph, observed: false });
  }
  return samples.map((a) => (a.length ? kmMedian(a) : 0));
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
const steady = steadyMedians(base, 600, 8);
for (const r of DI2_DODS) {
  console.log(
    `DOD ${r.dod}: tornado ${pass[r.dod]!.toFixed(0)} mph, steady ${steady[r.dod]} mph ` +
      `(expected ${r.expected}, band ${r.lower}–${r.upper})`,
  );
}
console.log("BASE_CAPACITY =", JSON.stringify(Object.fromEntries(Object.entries(base).map(([k, v]) => [k, Math.round(v)])), null, 2));
