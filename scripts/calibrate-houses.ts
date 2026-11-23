/**
 * Calibrates BASE_CAPACITY (Spec 03, DMG-04): standard houses passed through simulated strong
 * tornadoes should reach each DI 2 DOD at a median peak wind equal to its expected speed.
 *   npx tsx scripts/calibrate-houses.ts
 */
import { BASE_CAPACITY, DI2_DODS, PARTS, PART_DOD } from "../src/config/buildings";
import type { Part } from "../src/config/buildings";
import { createHouse } from "../src/core/damage/building";
import { samplePassCase, steadyRamp, tornadoPass } from "../src/core/damage/steadyRamp";
import { randomHouseSpec } from "../src/sim/city";
import { createRng } from "../src/sim/rng";

const median = (a: number[]) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)]! : Infinity;
};

function passMedians(base: Record<Part, number>, n: number, seed: number): number[] {
  const rng = createRng(seed);
  const firsts: number[][] = Array.from({ length: 11 }, () => []);
  for (let i = 0; i < n; i++) {
    const b = createHouse(randomHouseSpec(i, rng, 0, 0, rng() * Math.PI * 2, "standard"), rng, base);
    const c = samplePassCase(rng);
    const f = tornadoPass(b, c.state, "open", c.offset);
    for (let d = 1; d <= 10; d++) firsts[d]!.push(f[d]!);
  }
  return firsts.map(median);
}

function steadyMedians(base: Record<Part, number>, n: number, seed: number): number[] {
  const rng = createRng(seed);
  const firsts: number[][] = Array.from({ length: 11 }, () => []);
  for (let i = 0; i < n; i++) {
    const b = createHouse(randomHouseSpec(i, rng, 0, 0, rng() * Math.PI * 2, "standard"), rng, base);
    const f = steadyRamp(b, rng() * Math.PI * 2);
    for (let d = 1; d <= 10; d++) firsts[d]!.push(f[d]!);
  }
  return firsts.map(median);
}

const base = { ...BASE_CAPACITY };
for (let round = 0; round < 16; round++) {
  // Same houses and tornadoes every round (common random numbers) so the iteration converges.
  const m = passMedians(base, 400, 100);
  const worst = Math.max(...DI2_DODS.map((r) => Math.abs(m[r.dod]! / r.expected - 1)));
  console.log(`round ${round}: worst error ${(worst * 100).toFixed(1)}%`);
  for (const p of PARTS) {
    const target = DI2_DODS[PART_DOD[p] - 1]!.expected;
    const got = m[PART_DOD[p]]!;
    base[p] *= Number.isFinite(got) ? Math.pow(target / got, 2 * 0.5) : 0.7;
  }
}
const pass = passMedians(base, 600, 7);
const steady = steadyMedians(base, 600, 8);
for (const r of DI2_DODS) {
  console.log(
    `DOD ${r.dod}: tornado ${pass[r.dod]!.toFixed(0)} mph, steady ${steady[r.dod]} mph ` +
      `(expected ${r.expected}, band ${r.lower}–${r.upper})`,
  );
}
console.log("BASE_CAPACITY =", JSON.stringify(Object.fromEntries(Object.entries(base).map(([k, v]) => [k, Math.round(v)])), null, 2));
