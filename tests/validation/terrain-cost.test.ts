/**
 * Spec 17 TERR-13: wall-clock budgets for the roughness field. Run alone (npm run verify), where
 * timings aren't skewed by the unit suite's parallel files.
 */
import { expect, test } from "vitest";
import { createWorld } from "../../src/sim/world";
import { CITY } from "../../src/sim/city";
import { TownRoughness, townCover } from "../../src/sim/terrain";
import { roughnessLayer } from "../../src/render/ground";
import type { Building } from "../../src/core/damage/types";
import { baseState } from "../helpers";

const BUDGET = { buildMs: 200, updateMs: 15, layerMs: 15 };

function flatten(b: Building): void {
  const rec = { part: "wall", index: 0, time: 0, load: 0, capacity: 0, mph: 0, sign: 1, wind: { x: 0, y: 0, z: 0 } } as never;
  for (const p of b.panels) p.failed ??= rec;
  for (const s of b.sections) s.deck ??= rec;
  b.rev++;
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1]!;

test("TERR-13: build ≤ 200 ms, update ≤ 15 ms, layer refresh ≤ 15 ms (medians)", () => {
  const buildings = createWorld(2, true).buildings;
  const builds: number[] = [];
  let tr!: TownRoughness;
  for (let r = 0; r < 3; r++) {
    const t0 = performance.now();
    tr = new TownRoughness(townCover(CITY.extent), buildings);
    builds.push(performance.now() - t0);
  }
  expect(median(builds)).toBeLessThan(BUDGET.buildMs);
  const near = buildings.filter((b) => Math.hypot(b.x, b.z) < 400);
  const ups: number[] = [];
  for (let r = 0; r < 7; r++) {
    for (const b of near.slice(r * 10, r * 10 + 10)) flatten(b);
    const t0 = performance.now();
    tr.update(buildings);
    ups.push(performance.now() - t0);
  }
  expect(median(ups)).toBeLessThan(BUDGET.updateMs);
  const s = baseState({ velocity: { x: 12, z: 0 } });
  const ls: number[] = [];
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    roughnessLayer(tr.field, s);
    ls.push(performance.now() - t0);
  }
  expect(median(ls)).toBeLessThan(BUDGET.layerMs);
});
