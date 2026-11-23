import { describe, expect, test } from "vitest";
import { DI2_DODS, ROOF_BRACING_FACTOR } from "../../src/config/buildings";
import { allFailures, createHouse, degreeOfDamage, efFromDamage, updateBuilding } from "../../src/core/damage/building";
import { kmMedian, samplePassCase, steadyRamp, tornadoPass } from "../../src/core/damage/steadyRamp";
import type { Building } from "../../src/core/damage/types";
import { efRating, mphToMs } from "../../src/core/wind/efScale";
import { windAt } from "../../src/core/wind/windField";
import { randomHouseSpec } from "../../src/sim/city";
import { createRng } from "../../src/sim/rng";
import { exactHouse, randomHouses, rec } from "../houseHelpers";
import { DebrisField } from "../../src/core/debris/field";

type Sample = { t: number; observed: boolean };
function passSamples(houses: { b: Building; rng: () => number }[], vMax?: number): Sample[][] {
  const out: Sample[][] = Array.from({ length: 11 }, () => []);
  for (const { b, rng } of houses) {
    const c = samplePassCase(rng);
    const f = tornadoPass(b, vMax ? { ...c.state, vMax } : c.state, "open", c.offset);
    for (let d = 1; d <= 10; d++) out[d]!.push(Number.isFinite(f[d]!) ? { t: f[d]!, observed: true } : { t: b.peakMph, observed: false });
  }
  return out;
}

describe("Spec 03 — damage (component houses)", () => {
  test("DMG-01: failures are permanent and DOD never decreases", () => {
    for (const { b, rng } of randomHouses(30, 3)) {
      const c = samplePassCase(rng);
      let lastDod = 0;
      let lastN = 0;
      for (let t = 0, x = -6 * c.state.rMax; x < 6 * c.state.rMax; t += 1 / 30, x += 15 / 30) {
        const st = { ...c.state, velocity: { x: 15, z: 0 }, center: { x, z: 0 } };
        updateBuilding(b, windAt({ x: 0, y: b.roofHeight, z: c.offset }, st, "open"), 0, 1 / 30, t);
        const n = allFailures(b).length;
        expect(b.dod).toBeGreaterThanOrEqual(lastDod);
        expect(n).toBeGreaterThanOrEqual(lastN);
        lastDod = b.dod;
        lastN = n;
      }
    }
  });

  test("DMG-02: dependencies and bracing", () => {
    for (const { b, rng } of randomHouses(120, 11)) {
      const c = samplePassCase(rng);
      tornadoPass(b, c.state, "open", c.offset);
      for (const s of b.sections) {
        const bay = b.bays[s.col]!.failed;
        if (bay) {
          for (const r of [s.cover, s.deck]) if (r) expect(r.time).toBeLessThanOrEqual(bay.time);
        }
      }
      const panelTimes = b.panels.map((p) => p.failed?.time ?? Infinity).sort((x, y) => x - y);
      const halfDown = panelTimes[Math.ceil(b.panels.length / 2) - 1]!;
      for (const pt of b.partitions) if (pt.failed) expect(pt.failed.time).toBeGreaterThanOrEqual(halfDown);
      if (b.sweep.failed) {
        expect(b.panels.every((p) => p.failed && p.failed.time <= b.sweep.failed!.time)).toBe(true);
        expect(b.partitions.every((p) => p.failed)).toBe(true);
        expect(b.coreRoom.failed).toBeTruthy();
      }
    }
    // Bracing: a side-wall load between cap and 1.6·cap fails panels only once their bays are gone.
    const strong = { siding: 1e9, roofCover: 1e9, roofDeck: 1e9, window: 1e9, garage: 1e9, anchorage: 1e9, partition: 1e9, sweep: 1e9 };
    const cap = 2000;
    const q = (1.3 * cap) / (-(-0.7) + 0.18); // side panel: |q(Cp − Cpi)| = 1.3·cap
    const speed = Math.sqrt((2 * q) / 1.2);
    const braced = exactHouse({ ...strong, wallPanel: cap, roofBay: 1e9 });
    updateBuilding(braced, { x: speed, y: 0, z: 0 }, 0, 1, 0);
    const sideFaces = [1, 3];
    expect(braced.panels.filter((p) => sideFaces.includes(p.face) && p.failed).length).toBe(0);
    const unbraced = exactHouse({ ...strong, wallPanel: cap, roofBay: 1e9 });
    unbraced.bays.forEach((bay, i) => (bay.failed = rec("roofBay", i)));
    unbraced.breached = true;
    unbraced.minCap = 0;
    updateBuilding(unbraced, { x: speed, y: 0, z: 0 }, 0, 1, 0);
    expect(unbraced.panels.some((p) => p.failed)).toBe(true);
    expect(ROOF_BRACING_FACTOR).toBe(1.6);
  });

  test("DMG-03: a windward garage breach makes the first roof bay fail at lower wind", () => {
    const strong = { window: 1e9, garage: 1e9, roofDeck: 1e9, roofCover: 1e9, siding: 1e9, anchorage: 1e9, wallPanel: 1e9 };
    const dir = Math.PI / 2; // toward +Z, into the front face (local −Z) at yaw 0
    const firstBay = (b: Building) => {
      steadyRamp(b, dir);
      return Math.min(...b.bays.map((x) => x.failed?.mph ?? Infinity));
    };
    const intact = exactHouse(strong);
    const breached = exactHouse(strong);
    breached.garage!.failed = rec("garage");
    breached.breached = true;
    expect(firstBay(breached)).toBeLessThan(firstBay(intact) - 10);
  });

  test("DMG-04: tornado passes reproduce the DI 2 expected speeds (±5%)", () => {
    const rng = createRng(4242);
    const houses = Array.from({ length: 800 }, (_, i) => ({ b: createHouse(randomHouseSpec(i, rng, 0, 0, rng() * Math.PI * 2, "standard"), rng), rng }));
    const s = passSamples(houses);
    for (const r of DI2_DODS) {
      const m = kmMedian(s[r.dod]!);
      expect(Math.abs(m / r.expected - 1), `DOD ${r.dod}: ${m} vs ${r.expected}`).toBeLessThan(0.05);
    }
  }, 120000);

  test("DMG-05: weak < standard < strong for roof-structure loss", () => {
    const dod6 = (cls: "weak" | "standard" | "strong") => kmMedian(passSamples(randomHouses(200, 77, cls))[6]!);
    const weak = dod6("weak");
    const standard = dod6("standard");
    const strong = dod6("strong");
    expect(weak).toBeLessThan(standard);
    expect(strong).toBeGreaterThan(standard);
  }, 120000);

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

  test("DMG-07: same seed gives identical layouts, capacities and damage", () => {
    const run = () => {
      const rng = createRng(99);
      const b = createHouse(randomHouseSpec(0, rng, 0, 0, 1), rng);
      const c = samplePassCase(rng);
      tornadoPass(b, c.state, "open", c.offset);
      return { panels: b.panels, sections: b.sections, bays: b.bays, panes: b.panes, dod: b.dod };
    };
    expect(run()).toEqual(run());
  });

  test("DMG-08: EF estimate adjusts within the DI 2 bounds by construction quality", () => {
    for (const r of DI2_DODS) {
      const [weak, std, strong] = (["weak", "standard", "strong"] as const).map((c) => efFromDamage(r.dod, c));
      expect([weak!.mph, std!.mph, strong!.mph]).toEqual([r.lower, r.expected, r.upper]);
      expect(strong!.ef).toBe(efRating(mphToMs(r.upper)));
      expect(std!.low).toBe(efRating(mphToMs(r.lower)));
    }
    expect([efFromDamage(10, "weak").ef, efFromDamage(10).ef, efFromDamage(10, "strong").ef]).toEqual([3, 4, 5]);
  });

  test("DMG-09: steady wind ramps land inside the DI 2 bounds", () => {
    const s: Sample[][] = Array.from({ length: 11 }, () => []);
    for (const { b, rng } of randomHouses(400, 31)) {
      const f = steadyRamp(b, rng() * Math.PI * 2);
      for (let d = 1; d <= 10; d++) s[d]!.push(Number.isFinite(f[d]!) ? { t: f[d]!, observed: true } : { t: 280, observed: false });
    }
    for (const r of DI2_DODS) {
      const m = kmMedian(s[r.dod]!);
      expect(m, `DOD ${r.dod}`).toBeGreaterThanOrEqual(r.lower);
      expect(m, `DOD ${r.dod}`).toBeLessThanOrEqual(r.upper);
    }
  }, 120000);

  test("DMG-10: EF5-strength cores can produce EF5 surveys; EF4-strength ones cannot", () => {
    const survey = (vMax: number, cls: "standard" | "strong", seed: number) =>
      randomHouses(150, seed, cls).map(({ b, rng }) => {
        const c = samplePassCase(rng);
        tornadoPass(b, { ...c.state, vMax }, "open", c.offset * 0.5);
        return { ef: efFromDamage(b.dod, b.cls).ef, peak: b.peakMph };
      });
    expect(survey(85, "strong", 21).some((r) => r.ef === 5)).toBe(true);
    for (const cls of ["standard", "strong"] as const)
      for (const r of survey(50, cls, 22)) {
        expect(r.peak).toBeLessThan(200);
        expect(r.ef === 5).toBe(false);
      }
  }, 120000);

  test("DMG-11: DOD follows the component-fraction rules", () => {
    const fresh = () => exactHouse();
    const b0 = fresh();
    expect(degreeOfDamage(b0)).toBe(0);
    const b1 = fresh();
    b1.siding[0]!.failed = rec("siding");
    expect(degreeOfDamage(b1)).toBe(1);
    const b2 = fresh();
    b2.sections[0]!.cover = rec("roofCover");
    expect(degreeOfDamage(b2)).toBe(2);
    const b4 = fresh();
    const n20 = Math.ceil(b4.sections.length * 0.2);
    for (let i = 0; i < n20; i++) b4.sections[i]!.cover = rec("roofCover", i);
    expect(degreeOfDamage(b4)).toBe(4);
    const b5 = fresh();
    b5.anchorage.failed = rec("anchorage");
    expect(degreeOfDamage(b5)).toBe(5);
    const b6 = fresh();
    for (let i = 0; i < Math.ceil(b6.bays.length / 3); i++) b6.bays[i]!.failed = rec("roofBay", i);
    expect(degreeOfDamage(b6)).toBe(6);
    const b7 = fresh();
    for (let i = 0; i < Math.ceil(b7.panels.length / 2); i++) b7.panels[i]!.failed = rec("wallPanel", i);
    expect(degreeOfDamage(b7)).toBe(7);
    const b8 = fresh();
    for (let i = 0; i < Math.ceil(b8.panels.length * 0.75); i++) b8.panels[i]!.failed = rec("wallPanel", i);
    b8.partitions[0]!.failed = rec("partition", 0);
    expect(degreeOfDamage(b8)).toBe(7); // one interior wall still up
    b8.partitions[1]!.failed = rec("partition", 1);
    expect(degreeOfDamage(b8)).toBe(8); // core room may still stand
    const b9 = fresh();
    b9.panels.forEach((p, i) => (p.failed = rec("wallPanel", i)));
    b9.partitions.forEach((p, i) => (p.failed = rec("partition", i)));
    expect(degreeOfDamage(b9)).toBe(8);
    b9.coreRoom.failed = rec("coreRoom");
    expect(degreeOfDamage(b9)).toBe(9);
    b9.sweep.failed = rec("sweep");
    expect(degreeOfDamage(b9)).toBe(10);
  });

  test("DMG-13: roof bays collapse when their bearing walls fall, and drop instead of launching", () => {
    const breeze = { x: 10, y: 0, z: 0 };
    const front = (b: Building, col: number) => b.panels.findIndex((p) => p.face === 3 && p.col === col);
    // One missing panel: the top plate bridges it, the bay stands.
    const one = exactHouse();
    one.panels[front(one, 1)]!.failed = rec("wallPanel", front(one, 1));
    one.breached = true;
    one.minCap = 0;
    updateBuilding(one, breeze, 0, 1 / 30, 0);
    expect(one.bays[1]!.failed).toBeNull();
    // Two adjacent missing panels: the bay over them collapses.
    const two = exactHouse();
    for (const col of [1, 2]) two.panels[front(two, col)]!.failed = rec("wallPanel", front(two, col));
    two.breached = true;
    two.minCap = 0;
    const events: { part: string; sign: number; index: number }[] = [];
    updateBuilding(two, breeze, 0, 1 / 30, 0, (r) => events.push(r));
    expect(two.bays[1]!.failed?.sign).toBe(-1);
    expect(events.some((e) => e.part === "roofBay" && e.sign === -1)).toBe(true);
    // Half the gable end wall down: the end bay collapses.
    const gable = exactHouse();
    const ends = gable.panels.flatMap((p, i) => (p.face === 0 ? [i] : []));
    for (const i of ends.slice(0, Math.ceil(ends.length / 2))) gable.panels[i]!.failed = rec("wallPanel", i);
    gable.breached = true;
    gable.minCap = 0;
    updateBuilding(gable, breeze, 0, 1 / 30, 0);
    expect(gable.bays[gable.nx - 1]!.failed?.sign).toBe(-1);
    // A collapsed bay's debris drops: no upward launch.
    const f = new DebrisField(1);
    f.spawnFrom(two, { ...two.bays[1]!.failed!, wind: { x: 60, y: 0, z: 0 } });
    for (const p of [...f.pieces, ...f.settled].filter((q) => q.kind === "roofPanel")) expect(p.vel.y).toBeLessThanOrEqual(0);
  });

  test("DMG-12: damage is progressive across separate evaluations", () => {
    let checked = 0;
    for (const { b, rng } of randomHouses(80, 41)) {
      const c = samplePassCase(rng);
      tornadoPass(b, c.state, "open", c.offset);
      if (b.dod < 7) continue;
      checked++;
      const panelTimes = new Set(b.panels.flatMap((x) => (x.failed ? [x.failed.time] : [])));
      const all = new Set(allFailures(b).map((r) => r.time));
      expect(all.size).toBeGreaterThan(3);
      expect(panelTimes.size).toBeGreaterThanOrEqual(2);
    }
    expect(checked).toBeGreaterThan(10);
  }, 60000);
});
