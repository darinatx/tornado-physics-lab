import { describe, expect, test } from "vitest";
import { DI2_DODS, ROOF_BRACING_FACTOR } from "../../src/config/buildings";
import { createHouse, efFromDamage, updateBuilding } from "../../src/core/damage/building";
import { samplePassCase, steadyRamp, tornadoPass } from "../../src/core/damage/steadyRamp";
import { efRating, mphToMs } from "../../src/core/wind/efScale";
import { windAt } from "../../src/core/wind/windField";
import { randomHouseSpec } from "../../src/sim/city";
import { createRng } from "../../src/sim/rng";
import { exactHouse, median, randomHouses } from "../houseHelpers";

describe("Spec 03 — damage", () => {
  test("DMG-01: failures are permanent and DOD never decreases", () => {
    const rng = createRng(3);
    for (let i = 0; i < 40; i++) {
      const b = createHouse(randomHouseSpec(i, rng, 0, 0, rng() * 6), rng);
      const c = samplePassCase(rng);
      const s = c.state;
      let lastDod = 0;
      let lastParts = 0;
      for (let t = 0, x = -6 * s.rMax; x < 6 * s.rMax; t += 1 / 30, x += 15 / 30) {
        const st = { ...s, velocity: { x: 15, z: 0 }, center: { x, z: 0 } };
        updateBuilding(b, windAt({ x: 0, y: b.roofHeight, z: c.offset }, st, "open"), 0, 1 / 30, t);
        const parts = Object.keys(b.failed).length + b.windowFailed.filter(Boolean).length;
        expect(b.dod).toBeGreaterThanOrEqual(lastDod);
        expect(parts).toBeGreaterThanOrEqual(lastParts);
        lastDod = b.dod;
        lastParts = parts;
      }
    }
  });

  test("DMG-02: wall stages fail in order; roof bracing applies only while the roof stands", () => {
    for (const { b, rng } of randomHouses(150, 11)) {
      const c = samplePassCase(rng);
      tornadoPass(b, c.state, "open", c.offset);
      const f = b.failed;
      if (f.mostWalls) expect(f.exteriorWalls).toBeTruthy();
      if (f.allWalls) expect(f.mostWalls).toBeTruthy();
      if (f.slab) expect(f.allWalls).toBeTruthy();
      if (f.exteriorWalls && !f.roofStructure) {
        expect(f.exteriorWalls.load).toBeGreaterThan(b.capacity.exteriorWalls * ROOF_BRACING_FACTOR);
      }
    }
    // Lateral load between the unbraced and braced capacity: walls hold only with the roof on.
    const cap = 2000;
    const q = cap * 1.3; // lateral = 1.3·q must exceed cap but stay under 1.6·cap
    const speed = Math.sqrt((2 * (q / 1.3)) / 1.2);
    const strongElse = { trim: 1e9, roofCover: 1e9, windows: 1e9, garage: 1e9, roofDeck: 1e9, anchorage: 1e9, mostWalls: 1e9, allWalls: 1e9, slab: 1e9 };
    const braced = exactHouse({ ...strongElse, exteriorWalls: cap, roofStructure: 1e9 });
    updateBuilding(braced, { x: speed, y: 0, z: 0 }, 0, 1, 0);
    expect(braced.failed.exteriorWalls).toBeUndefined();
    const unbraced = exactHouse({ ...strongElse, exteriorWalls: cap, roofStructure: 1e9 });
    unbraced.failed.roofStructure = { part: "roofStructure", time: 0, load: 0, capacity: 0, mph: 0 };
    updateBuilding(unbraced, { x: speed, y: 0, z: 0 }, 0, 1, 0);
    expect(unbraced.failed.exteriorWalls).toBeTruthy();
  });

  test("DMG-03: a windward garage breach makes the roof fail at lower wind", () => {
    const strong = { windows: 1e9, garage: 1e9, roofDeck: 1e9, anchorage: 1e9, exteriorWalls: 1e9 };
    const dir = Math.PI / 2; // blowing toward +Z, into the front face (local −Z, yaw 0)
    const intact = exactHouse(strong);
    const breached = exactHouse(strong);
    breached.failed.garage = { part: "garage", time: 0, load: 0, capacity: 0, mph: 0 };
    const roofAt = (b: typeof intact) => {
      steadyRamp(b, dir);
      return b.failed.roofStructure!.mph;
    };
    expect(roofAt(breached)).toBeLessThan(roofAt(intact) - 10);
  });

  test("DMG-04: tornado passes reproduce the DI 2 expected speeds (±5%)", () => {
    const rng = createRng(4242);
    const firsts: number[][] = Array.from({ length: 11 }, () => []);
    for (let i = 0; i < 400; i++) {
      const b = createHouse(randomHouseSpec(i, rng, 0, 0, rng() * Math.PI * 2, "standard"), rng);
      const c = samplePassCase(rng);
      const f = tornadoPass(b, c.state, "open", c.offset);
      for (let d = 1; d <= 10; d++) firsts[d]!.push(f[d]!);
    }
    for (const r of DI2_DODS) {
      const m = median(firsts[r.dod]!);
      expect(Math.abs(m / r.expected - 1), `DOD ${r.dod}: median ${m} vs ${r.expected}`).toBeLessThan(0.05);
    }
  }, 60000);

  test("DMG-05: weak < standard < strong for roof-structure loss", () => {
    const dod6 = (cls: "weak" | "standard" | "strong") =>
      median(
        randomHouses(200, 77, cls).map(({ b, rng }) => {
          const c = samplePassCase(rng);
          return tornadoPass(b, c.state, "open", c.offset)[6]!;
        }),
      );
    const weak = dod6("weak");
    const standard = dod6("standard");
    const strong = dod6("strong");
    expect(weak).toBeLessThan(standard);
    expect(strong).toBeGreaterThan(standard);
  }, 60000);

  test("DMG-06: under 1% of standard houses damaged below 50 mph", () => {
    let damaged = 0;
    const houses = randomHouses(1000, 5);
    for (const { b, rng } of houses) {
      const a = rng() * Math.PI * 2;
      const ms = mphToMs(50);
      updateBuilding(b, { x: ms * Math.cos(a), y: 0, z: ms * Math.sin(a) }, 0, 10, 0);
      if (b.dod > 0) damaged++;
    }
    expect(damaged / houses.length).toBeLessThan(0.01);
  });

  test("DMG-07: same seed gives identical capacities and damage", () => {
    const run = () => {
      const rng = createRng(99);
      const b = createHouse(randomHouseSpec(0, rng, 0, 0, 1), rng);
      const c = samplePassCase(rng);
      const f = tornadoPass(b, c.state, "open", c.offset);
      return { cap: b.capacity, win: b.windowCapacity, f, failed: b.failed };
    };
    expect(run()).toEqual(run());
  });

  test("DMG-08: EF estimate and range come from the DI 2 table", () => {
    for (const r of DI2_DODS) {
      const e = efFromDamage(r.dod);
      expect(e.ef).toBe(efRating(mphToMs(r.expected)));
      expect(e.low).toBe(efRating(mphToMs(r.lower)));
      expect(e.high).toBe(efRating(mphToMs(r.upper)));
    }
    expect(efFromDamage(0).ef).toBeNull();
    expect(efFromDamage(10)).toEqual({ ef: 4, low: 3, high: 5 });
  });

  test("DMG-09: steady wind ramps land inside the DI 2 bounds", () => {
    const firsts: number[][] = Array.from({ length: 11 }, () => []);
    for (const { b, rng } of randomHouses(400, 31)) {
      const f = steadyRamp(b, rng() * Math.PI * 2);
      for (let d = 1; d <= 10; d++) firsts[d]!.push(f[d]!);
    }
    for (const r of DI2_DODS) {
      const m = median(firsts[r.dod]!);
      expect(m, `DOD ${r.dod}`).toBeGreaterThanOrEqual(r.lower);
      expect(m, `DOD ${r.dod}`).toBeLessThanOrEqual(r.upper);
    }
  }, 60000);
});
