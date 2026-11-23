import { BASE_CAPACITY } from "../src/config/buildings";
import type { ConstructionClass, Part } from "../src/config/buildings";
import { createHouse } from "../src/core/damage/building";
import type { Building } from "../src/core/damage/types";
import { randomHouseSpec } from "../src/sim/city";
import { createRng } from "../src/sim/rng";

/** A house with exactly the base capacities (no scatter), for deterministic load tests. */
export function exactHouse(overrides: Partial<Record<Part, number>> = {}, yaw = 0, hasGarage = true): Building {
  const rng = createRng(1);
  const spec = { ...randomHouseSpec(0, rng, 0, 0, 0, "standard"), yaw, hasGarage, frontFace: 3, width: 14, depth: 11, wallHeight: 3, roofRise: 2 };
  const b = createHouse(spec, rng);
  const caps = { ...BASE_CAPACITY, ...overrides };
  const cap = b.capacity as Record<string, number>;
  for (const k of Object.keys(cap)) cap[k] = caps[k as Part];
  (b.windowCapacity as number[]).fill(caps.windows);
  return b;
}

export function randomHouses(n: number, seed: number, cls: ConstructionClass = "standard"): { b: Building; rng: () => number }[] {
  const rng = createRng(seed);
  return Array.from({ length: n }, (_, i) => ({
    b: createHouse(randomHouseSpec(i, rng, 0, 0, rng() * Math.PI * 2, cls), rng),
    rng,
  }));
}

export const median = (a: number[]) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
};
