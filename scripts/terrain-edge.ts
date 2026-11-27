/**
 * Phase 7 validation (slice E, check 3): the wind's adjustment length at the town edge. For
 * wind blowing straight into the town across each of its four edges (and diagonally across a
 * corner), how far in β reaches 50% and 90% of its rise from the upwind (open) value to the
 * interior value. β is averaged over lines across the edge (one every 100 m along it, the
 * middle 1.6 km), so single streets don't decide it. Compared with an ideal step in ln z₀ under
 * the spec's exponential weight: 50% at L·ln 2, 90% at L·ln 10.
 *   npx tsx scripts/terrain-edge.ts [seed]
 */
import { TERRAIN } from "../src/config/terrain";
import { createWorld } from "../src/sim/world";
import { CITY } from "../src/sim/city";
import { TownRoughness, townCover } from "../src/sim/terrain";
import { betaFromZ0, effZ0At, z0At } from "../src/core/terrain/roughness";

const seed = Number(process.argv[2] ?? 1);
const world = createWorld(seed, true);
const f = new TownRoughness(townCover(CITY.extent), world.buildings).field;
const half = CITY.extent / 2;
const L = TERRAIN.fetchLength;
console.log(`seed ${seed}; fetch L = ${L} m; ideal step: 50% at ${(L * Math.LN2).toFixed(0)} m, 90% at ${(L * Math.LN10).toFixed(0)} m, 95% at ${(L * Math.log(20)).toFixed(0)} m`);
// Each case: wind direction θ (toward), the edge origin, the inward unit vector, the along-edge unit.
const cases = [
  { name: "from W (toward +X)", th: 0, o: (a: number) => [-half, a], n: [1, 0] },
  { name: "from E (toward −X)", th: Math.PI, o: (a: number) => [half, a], n: [-1, 0] },
  { name: "from N (toward +Z)", th: Math.PI / 2, o: (a: number) => [a, -half], n: [0, 1] },
  { name: "from S (toward −Z)", th: -Math.PI / 2, o: (a: number) => [a, half], n: [0, -1] },
];
const ds: number[] = [];
for (let d = -300; d <= 1500; d += 10) ds.push(d);
for (const c of cases) {
  const beta = ds.map((d) => {
    let s = 0, n = 0, zl = 0;
    for (let a = -800; a <= 800; a += 100) {
      const [x0, z0] = c.o(a);
      const x = x0! + c.n[0]! * d, z = z0! + c.n[1]! * d;
      s += betaFromZ0(effZ0At(f, x, z, c.th));
      zl += Math.log(z0At(f, x, z));
      n++;
    }
    return { d, b: s / n, local: Math.exp(zl / n) };
  });
  const b0 = beta.find((p) => p.d === -300)!.b;
  // Interior: mean over 1200–1500 m in.
  const inner = beta.filter((p) => p.d >= 1200);
  const bi = inner.reduce((a, p) => a + p.b, 0) / inner.length;
  const at = (frac: number) => beta.find((p) => p.b >= b0 + frac * (bi - b0))?.d ?? NaN;
  const edgeLocal = beta.find((p) => p.local >= 0.1)?.d;
  console.log(`${c.name}: β upwind ${b0.toFixed(3)}, interior ${bi.toFixed(3)} | 50% at ${at(0.5)} m, 90% at ${at(0.9)} m, 95% at ${at(0.95)} m in | β at 800 m: ${beta.find((p) => p.d === 800)!.b.toFixed(3)} (${(100 * (beta.find((p) => p.d === 800)!.b - b0) / (bi - b0)).toFixed(0)}%) | local z₀ first ≥ 0.1 m at ${edgeLocal} m`);
}
