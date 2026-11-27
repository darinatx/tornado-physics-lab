/**
 * Phase 7 validation (slice E): the wind's adjustment at the town edge against
 * internal-boundary-layer rules. ASCE 7-22 §26.7.3 takes an exposure to apply after 800 m of
 * uniform upwind terrain; IBL growth (Elliott 1958, Garratt 1990's equilibrium layer at ~10% of
 * the IBL depth) puts 10 m equilibrium a few hundred metres to ~1 km downwind of the change.
 * `scripts/terrain-edge.ts` prints the full profile.
 */
import { describe, expect, test } from "vitest";
import { createWorld } from "../../src/sim/world";
import { CITY } from "../../src/sim/city";
import { TownRoughness, townCover } from "../../src/sim/terrain";
import { betaFromZ0, effZ0At } from "../../src/core/terrain/roughness";

describe("Phase 7 validation — town-edge adjustment", () => {
  test("wind from the fields into town: β is ≥ 90% adjusted 800 m in (ASCE 7 fetch) and < 70% at 100 m (not at once)", () => {
    const world = createWorld(1, true);
    const f = new TownRoughness(townCover(CITY.extent), world.buildings).field;
    const edge = -CITY.extent / 2;
    const beta = (d: number) => {
      let s = 0, n = 0;
      for (let z = -800; z <= 800; z += 100) (s += betaFromZ0(effZ0At(f, edge + d, z, 0))), n++;
      return s / n;
    };
    const b0 = beta(-300);
    let bi = 0;
    for (let d = 1200; d <= 1500; d += 50) bi += beta(d) / 7;
    const frac = (d: number) => (beta(d) - b0) / (bi - b0);
    expect(frac(800)).toBeGreaterThanOrEqual(0.9);
    expect(frac(100)).toBeLessThan(0.7);
  }, 60000);
});
