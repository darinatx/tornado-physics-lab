import { describe, expect, test } from "vitest";
import { AIR_DENSITY } from "../../src/config/atmosphere";
import { PRESETS } from "../../src/config/presets";
import { WIND_PARAMS } from "../../src/config/wind";
import { pressureDeficit } from "../../src/core/wind/pressure";
import { probeAt } from "../../src/core/wind/probe";
import { History } from "../../src/ui/history";
import { baseState } from "../helpers";
import { efRating, msToMph } from "../../src/core/wind/efScale";
import { twoCellBlend, windAt } from "../../src/core/wind/windField";
import { createSim } from "../../src/sim/loop";
import { defaultParams } from "../../src/sim/types";
import { buildControlDefs } from "../../src/ui/controls";
import { computeReadout, computeTally } from "../../src/ui/readout";
import { buildingReport, efFromDamage } from "../../src/core/damage/building";
import { DI2_DODS } from "../../src/config/buildings";
import { samplePassCase, tornadoPass } from "../../src/core/damage/steadyRamp";
import { randomHouses } from "../houseHelpers";

describe("Spec 07 — instruments", () => {
  test("INST-01: every ranged wind parameter has a matching control that changes the wind", () => {
    const defs = buildControlDefs();
    const defaults = defaultParams();
    for (const [key, p] of Object.entries(WIND_PARAMS)) {
      const c = defs.find((d) => d.key === key);
      expect(c, `control for ${key}`).toBeDefined();
      expect([c!.min, c!.max, c!.default]).toEqual([p.min, p.max, p.default]);
      expect(defaults[key as keyof typeof defaults]).toBe(p.default);

      // Run into the mature phase, then change the parameter and compare the wind at the
      // same tornado-relative point one step later against an unchanged twin sim.
      const changed = createSim({ buildings: false });
      const control = createSim({ buildings: false });
      for (let i = 0; i < 400; i++) {
        changed.advance(0.25);
        control.advance(0.25);
      }
      changed.setParams({ [key]: p.default === p.max ? p.min : p.max });
      changed.advance(1 / 120);
      control.advance(1 / 120);
      const probe = (snap: typeof changed.snapshot) => {
        const c0 = snap.tornado.center;
        // Outside the core (so α matters) and below z_p (so the profile parameters matter).
        return windAt({ x: c0.x + 300, y: 8, z: c0.z }, snap.tornado, snap.terrain);
      };
      expect(probe(changed.snapshot), `windAt changes after setting ${key}`).not.toEqual(
        probe(control.snapshot),
      );
    }
  });

  test("INST-02: EF readout matches efRating of the peak speed, in mph and m/s", () => {
    const sim = createSim({ buildings: false });
    for (let i = 0; i < 400; i++) sim.advance(0.25); // into the mature phase
    const r = computeReadout(sim.snapshot);
    expect(sim.snapshot.phase).toBe("mature");
    expect(r.ef).toBe(efRating(r.ms));
    expect(r.mph).toBeCloseTo(msToMph(r.ms), 9);
    expect(r.ms).toBeGreaterThan(sim.snapshot.tornado.vMax); // overshoot + translation
  });

  test("INST-04: probe agrees with the wind and pressure fields", () => {
    const s = baseState({ velocity: { x: 12, z: 0 } }); // moving +X; right of path is +Z
    for (const p of [
      { x: 0, y: 10, z: 100 },
      { x: 50, y: 30, z: -400 },
      { x: -200, y: 5, z: 10 },
    ]) {
      const r = probeAt(p, s, "suburban");
      const w = windAt(p, s, "suburban");
      expect(r.speed).toBeCloseTo(Math.hypot(w.x, w.z), 9);
      expect(r.vertical).toBeCloseTo(w.y, 9);
      const d = Math.hypot(p.x, p.z);
      expect(r.distance).toBeCloseTo(d, 9);
      expect(r.pressureDeficit).toBeCloseTo(pressureDeficit(d, s), 6);
      expect(r.dynamicPressure).toBeCloseTo(0.5 * AIR_DENSITY * (w.x ** 2 + w.y ** 2 + w.z ** 2), 6);
      // Storm-relative components recombine to the storm-relative horizontal wind.
      expect(Math.hypot(r.tangential, r.radial)).toBeCloseTo(Math.hypot(w.x - 12, w.z), 9);
      expect(r.radial).toBeLessThan(0); // inflow near the ground
      expect(r.inCore).toBe(d < s.rMax);
    }
    expect(probeAt({ x: 0, y: 10, z: 100 }, s, "open").side).toBe("right");
    expect(probeAt({ x: 0, y: 10, z: -100 }, s, "open").side).toBe("left");
    expect(probeAt({ x: 0, y: 10, z: 100 }, s, "open").tangential).toBeGreaterThan(0); // cyclonic
  });

  test("INST-05: every preset produces its labeled EF rating when mature", () => {
    for (const p of PRESETS) {
      const sim = createSim({ buildings: false }, 1, p.params);
      const mid = sim.params.tUp + sim.params.tMature / 2;
      while (sim.time < mid) sim.advance(0.25);
      expect(sim.snapshot.phase).toBe("mature");
      expect(computeReadout(sim.snapshot).ef, p.name).toBe(p.ef);
    }
  });

  test("INST-06: presets only set known parameters within control ranges", () => {
    const defs = buildControlDefs();
    const known = new Set(Object.keys(defaultParams()));
    const lifecycleRanges: Record<string, [number, number]> = { tUp: [5, 300], tMature: [10, 900], tRope: [5, 300] };
    for (const p of PRESETS) {
      for (const [key, value] of Object.entries(p.params)) {
        expect(known.has(key), `${p.id}.${key} is a known parameter`).toBe(true);
        const d = defs.find((x) => x.key === key);
        const range = d ? [d.min, d.max] : lifecycleRanges[key];
        if (range && typeof value === "number") {
          expect(value, `${p.id}.${key}`).toBeGreaterThanOrEqual(range[0]!);
          expect(value, `${p.id}.${key}`).toBeLessThanOrEqual(range[1]!);
        }
      }
    }
    expect(new Set(PRESETS.map((p) => p.ef))).toEqual(new Set([0, 1, 2, 3, 4, 5]));
  });

  test("INST-07: probe history samples at the interval, caps length, clears on restart", () => {
    const h = new History(5, 0.25);
    for (let i = 0; i < 100; i++) h.push(i * 0.1, i);
    expect(h.length).toBe(5);
    for (let i = 1; i < h.length; i++) expect(h.times[i]! - h.times[i - 1]!).toBeGreaterThanOrEqual(0.25 - 1e-9);
    expect(h.times[h.length - 1]).toBeCloseTo(9.9, 9);
    h.push(1, 42); // time went backwards: restart
    expect(h.length).toBe(1);
    expect(h.values[0]).toBe(42);
  });

  test("INST-08: building report matches the building", () => {
    for (const { b, rng } of randomHouses(60, 8)) {
      const c = samplePassCase(rng);
      tornadoPass(b, c.state, "open", c.offset * 2);
      const r = buildingReport(b);
      expect(r.dod).toBe(b.dod);
      expect(r.estimate).toEqual(efFromDamage(b.dod, b.cls));
      expect(r.description).toBe(b.dod ? DI2_DODS[b.dod - 1]!.text : "No damage");
      expect(r.peakMph).toBe(b.peakMph);
      const n = Object.keys(b.failed).length + b.windowFailed.filter(Boolean).length;
      expect(r.failures.length).toBe(n);
      for (let i = 1; i < r.failures.length; i++) expect(r.failures[i]!.time).toBeGreaterThanOrEqual(r.failures[i - 1]!.time);
      for (const f of r.failures) expect(f.load).toBeGreaterThan(f.capacity);
    }
  }, 30000);

  test("INST-10: debris stats match the pool", () => {
    const ef4 = PRESETS.find((p) => p.id === "ef4-wedge")!;
    const sim = createSim({}, 2, ef4.params);
    while (sim.time < 120) sim.advance(0.25);
    const r = computeReadout(sim.snapshot);
    const live = sim.debris.pieces;
    const air = live.filter((p) => !p.resting);
    expect(r.debris.airborne).toBe(air.length);
    expect(r.debris.resting).toBe(live.length - air.length);
    expect(r.debris.airborne).toBeGreaterThan(100);
    expect(r.debris.maxSpeed).toBeCloseTo(Math.max(...air.map((p) => Math.hypot(p.vel.x, p.vel.y, p.vel.z))), 9);
    expect(r.debris.maxHeight).toBeCloseTo(Math.max(...air.map((p) => p.pos.y)), 9);
  }, 60000);

  test("INST-09: neighborhood tally counts damaged (≥ 1) and destroyed (≥ 7) houses", () => {
    expect(computeTally([10, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toEqual({ total: 65, damaged: 55, destroyed: 34 });
    expect(computeTally([5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toEqual({ total: 5, damaged: 0, destroyed: 0 });
  });

  test("INST-03: vortex structure label follows the one-cell/two-cell blend", () => {
    const cases: [number, number, string][] = [
      [20, 30, "one-cell"], // S ≈ 0.67
      [42, 30, "transitioning"], // S = 1.4
      [100, 30, "two-cell"], // S ≈ 3.3
    ];
    for (const [vPeak, updraftMax, expected] of cases) {
      const sim = createSim({ buildings: false }, 1, { vPeak, updraftMax });
      for (let i = 0; i < 400; i++) sim.advance(0.25); // mature
      const r = computeReadout(sim.snapshot);
      const b = twoCellBlend(sim.snapshot.tornado);
      expect(r.cells).toBe(b < 0.1 ? "one-cell" : b > 0.9 ? "two-cell" : "transitioning");
      expect(r.cells).toBe(expected);
      expect(r.swirl).toBeCloseTo(vPeak / updraftMax, 9);
    }
  });
});
