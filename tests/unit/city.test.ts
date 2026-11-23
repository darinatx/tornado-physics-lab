import { describe, expect, test } from "vitest";
import { CITY, generateNeighborhood } from "../../src/sim/city";

const hood = generateNeighborhood(1);

describe("Spec 05 — neighborhood", () => {
  test("CITY-01: deterministic per seed", () => {
    const again = generateNeighborhood(1);
    expect(again.buildings.map((b) => [b.x, b.z, b.yaw, b.cls, b.panels.map((p) => p.cap)])).toEqual(
      hood.buildings.map((b) => [b.x, b.z, b.yaw, b.cls, b.panels.map((p) => p.cap)]),
    );
    const other = generateNeighborhood(2);
    expect(other.buildings.map((b) => b.cls)).not.toEqual(hood.buildings.map((b) => b.cls));
  });

  test("CITY-02: no overlapping footprints and no houses in streets", () => {
    const bs = hood.buildings;
    expect(bs.length).toBeGreaterThan(3000);
    // Bounding circles never overlap (stronger than footprint overlap).
    const grid = new Map<string, number[]>();
    bs.forEach((b, i) => {
      const k = `${Math.floor(b.x / 30)},${Math.floor(b.z / 30)}`;
      grid.set(k, [...(grid.get(k) ?? []), i]);
    });
    bs.forEach((b, i) => {
      const r = Math.hypot(b.width, b.depth) / 2;
      for (let di = -1; di <= 1; di++)
        for (let dj = -1; dj <= 1; dj++)
          for (const j of grid.get(`${Math.floor(b.x / 30) + di},${Math.floor(b.z / 30) + dj}`) ?? []) {
            if (j <= i) continue;
            const o = bs[j]!;
            expect(Math.hypot(b.x - o.x, b.z - o.z)).toBeGreaterThan(r + Math.hypot(o.width, o.depth) / 2);
          }
    });
    const half = CITY.extent / 2;
    const inStreet = (v: number, block: number) => {
      const m = (((v + half) % block) + block) % block;
      return m < CITY.street / 2 || m > block - CITY.street / 2;
    };
    for (const b of bs) {
      const c = Math.cos(b.yaw);
      const s = Math.sin(b.yaw);
      for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const x = b.x + (lx * b.width) / 2 * c + (lz * b.depth) / 2 * s;
        const z = b.z - (lx * b.width) / 2 * s + (lz * b.depth) / 2 * c;
        expect(inStreet(x, CITY.blockX) || inStreet(z, CITY.blockZ)).toBe(false);
      }
    }
  });

  test("CITY-03: construction-class shares within ±3%", () => {
    const n = hood.buildings.length;
    const share = (c: string) => hood.buildings.filter((b) => b.cls === c).length / n;
    expect(Math.abs(share("weak") - 0.25)).toBeLessThan(0.03);
    expect(Math.abs(share("standard") - 0.55)).toBeLessThan(0.03);
    expect(Math.abs(share("strong") - 0.2)).toBeLessThan(0.03);
  });

  test("CITY-04: buildingAt finds the house under a point and null in streets", () => {
    for (const b of hood.buildings.slice(0, 300)) {
      expect(hood.buildingAt(b.x, b.z)).toBe(b);
      expect(hood.buildingAt(b.x + 0.4 * b.width * Math.cos(b.yaw), b.z - 0.4 * b.width * Math.sin(b.yaw))).toBe(b);
    }
    const half = CITY.extent / 2;
    expect(hood.buildingAt(-half + 2, 37)).toBeNull(); // on a street line
    expect(hood.buildingAt(5000, 5000)).toBeNull();
  });
});
