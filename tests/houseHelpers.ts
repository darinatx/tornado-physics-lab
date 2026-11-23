import { BASE_CAPACITY } from "../src/config/buildings";
import type { ConstructionClass, Part } from "../src/config/buildings";
import { createHouse, minIntactCap } from "../src/core/damage/building";
import type { Building } from "../src/core/damage/types";
import { randomHouseSpec } from "../src/sim/city";
import { createRng } from "../src/sim/rng";

/** A 14 × 11 m house with exactly the base capacities (no scatter), for deterministic tests. */
export function exactHouse(overrides: Partial<Record<Part, number>> = {}, yaw = 0, hasGarage = true): Building {
  const rng = createRng(1);
  const spec = { ...randomHouseSpec(0, rng, 0, 0, 0, "standard"), yaw, hasGarage, frontFace: 3, width: 14, depth: 11, wallHeight: 3, roofRise: 2 };
  const b = createHouse(spec, rng);
  const c = { ...BASE_CAPACITY, ...overrides };
  b.panels.forEach((p) => (p.cap = c.wallPanel));
  b.panes.forEach((p) => (p.cap = c.window));
  if (b.garage) b.garage.cap = c.garage;
  b.siding.forEach((s) => (s.cap = c.siding));
  b.sections.forEach((s) => {
    s.coverCap = c.roofCover;
    s.deckCap = c.roofDeck;
  });
  b.bays.forEach((s) => (s.cap = c.roofBay));
  b.partitions.forEach((s) => (s.cap = c.partition));
  b.coreRoom.cap = c.coreRoom;
  b.anchorage.cap = c.anchorage;
  b.sweep.cap = c.sweep;
  b.minCap = minIntactCap(b);
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

/** A failure record for tests. */
export const rec = (part: Part, index = 0, wind = { x: 40, y: 0, z: 0 }, load = 1000) => ({
  part, index, time: 1, load, capacity: 0, mph: 100, sign: 1, wind,
});
