import { describe, expect, test } from "vitest";
import { AIR_DENSITY } from "../../src/config/atmosphere";
import { PRESETS } from "../../src/config/presets";
import { WIND_PARAMS } from "../../src/config/wind";
import { pressureDeficit } from "../../src/core/wind/pressure";
import { probeAt } from "../../src/core/wind/probe";
import { History } from "../../src/ui/history";
import { baseState } from "../helpers";
import { efRating, msToMph } from "../../src/core/wind/efScale";
import { carriedFactors, envFactor, twoCellBlend, windAt } from "../../src/core/wind/windField";
import { createSim } from "../../src/sim/loop";
import { defaultParams } from "../../src/sim/types";
import { buildControlDefs } from "../../src/ui/controls";
import { computeReadout, computeTally } from "../../src/ui/readout";
import { allFailures, buildingReport, efFromDamage, partTotal } from "../../src/core/damage/building";
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
      const carried = 12 * envFactor(p.y, "suburban") * carriedFactors(Math.hypot(p.x - s.center.x, p.z - s.center.z), s);
      expect(Math.hypot(r.tangential, r.radial)).toBeCloseTo(Math.hypot(w.x - carried, w.z), 9);
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
    // A second series (pressure drop) is kept in step with the first.
    const two = new History(5, 0.25);
    for (let i = 0; i < 100; i++) two.push(i * 0.1, i, -i);
    expect(two.values2.length).toBe(two.length);
    for (let i = 0; i < two.length; i++) expect(two.values2[i]).toBe(-two.values[i]!);
    two.push(1, 7, 8);
    expect([two.length, two.values2.length, two.values2[0]]).toEqual([1, 1, 8]);
  });

  test("INST-13: hover summary shows core-edge distance and no failure list; the pin has summary, graph, failures", async () => {
    const { buildingSummary, failureList, coreDistanceText, PIN_CARD_HTML } = await import("../../src/ui/probe");
    expect(coreDistanceText(412.4, 37.6)).toBe("412 m now · closest 38 m");
    expect(coreDistanceText(250, -20)).toBe("250 m now · closest: inside the core");
    expect(coreDistanceText(-5, -20)).toBe("inside the core now · closest: inside the core");
    expect(coreDistanceText(900, Infinity)).toBe("900 m now");
    let checked = 0;
    for (const { b, rng } of randomHouses(20, 3)) {
      const c = samplePassCase(rng);
      tornadoPass(b, c.state, "open", c.offset);
      b.closestEdge = 12;
      const r = buildingReport(b);
      expect(r.closestEdge).toBe(12);
      const sum = buildingSummary(r, 50, 300);
      expect(sum).toContain(coreDistanceText(300, 12));
      expect(sum).toContain(`DOD ${r.dod}`.replace("DOD 0", "Intact"));
      expect(sum).not.toContain("What failed");
      const fails = failureList(r);
      if (r.failures.length) {
        expect(fails).toContain("What failed, in order");
        for (const g of r.failures) expect(fails).toContain(g.label);
        checked++;
      } else expect(fails).toBe("");
    }
    expect(checked).toBeGreaterThan(0);
    // Pin card order: summary, then the graph, then the failure list.
    const i = (k: string) => PIN_CARD_HTML.indexOf(k);
    expect(i("pin-body")).toBeGreaterThan(-1);
    expect(i("pin-body")).toBeLessThan(i("<canvas"));
    expect(i("<canvas")).toBeLessThan(i("pin-fails"));
  });

  test("INST-15: air pressure in mb is the standard background minus the drop", async () => {
    const { airPressureMb } = await import("../../src/ui/probe");
    expect(airPressureMb(0)).toBeCloseTo(1013.25, 9);
    expect(airPressureMb(5000)).toBeCloseTo(963.25, 9);
    const s = baseState();
    const r = probeAt({ x: 0, y: 10, z: 0 }, s, "open");
    expect(airPressureMb(r.pressureDeficit)).toBeCloseTo(1013.25 - pressureDeficit(0, s) / 100, 9);
  });

  test("INST-14: damage colors and repeat-on-dissipation start off", async () => {
    const { DEFAULT_PANEL_STATE } = await import("../../src/ui/panelDefaults");
    expect(DEFAULT_PANEL_STATE.damageColors).toBe(false);
    expect(DEFAULT_PANEL_STATE.autoRepeat).toBe(false);
  });

  test("INST-08: building report matches the building", () => {
    let sawFell = false;
    for (const { b, rng } of randomHouses(60, 8)) {
      const c = samplePassCase(rng);
      tornadoPass(b, c.state, "open", c.offset * 2);
      const r = buildingReport(b);
      expect(r.dod).toBe(b.dod);
      expect(r.estimate).toEqual(efFromDamage(b.dod, b.cls));
      expect(r.description).toBe(b.dod ? DI2_DODS[b.dod - 1]!.text : "No damage");
      expect(r.peakMph).toBe(b.peakMph);
      const all = allFailures(b);
      expect(r.failures.reduce((a, g) => a + g.count, 0)).toBe(all.length);
      for (const g of r.failures) {
        const mine = all.filter((x) => x.part === g.part);
        expect(g.count).toBe(mine.length);
        expect(g.total).toBe(partTotal(b, g.part));
        expect(g.time).toBe(Math.min(...mine.map((x) => x.time)));
        // Load > capacity for the first failure the wind caused; bays that came down with a
        // bearing wall are counted apart.
        const fell = mine.filter((x) => x.part === "roofBay" && x.sign === -1);
        const wind = mine.filter((x) => !fell.includes(x));
        expect(g.fellWithWall).toBe(fell.length);
        sawFell ||= fell.length > 0;
        if (wind.length) {
          expect(g.windTime).toBe(Math.min(...wind.map((x) => x.time)));
          expect(g.load).toBeGreaterThan(g.capacity);
        } else expect(g.windTime).toBe(Infinity);
      }
      for (let i = 1; i < r.failures.length; i++) expect(r.failures[i]!.time).toBeGreaterThanOrEqual(r.failures[i - 1]!.time);
    }
    expect(sawFell).toBe(true); // a roof bay fell with its bearing wall somewhere
  }, 30000);

  test("INST-11: winds above the measured record are flagged as hypothetical", () => {
    const run = (vPeak: number) => {
      const sim = createSim({ buildings: false }, 1, { vPeak, rMax: 300, translationSpeed: 15 });
      while (sim.snapshot.phase !== "mature") sim.advance(0.25);
      return computeReadout(sim.snapshot);
    };
    const real = run(80);
    expect(real.ms).toBeLessThanOrEqual(135);
    expect(real.hypothetical).toBe(false);
    const whatIf = run(120);
    expect(whatIf.ms).toBeGreaterThan(135);
    expect(whatIf.hypothetical).toBe(true);
  });

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

  test("INST-12: a detailed house's report lists its detail-zone connection failures and current peak wind", async () => {
    const { initRapier } = await import("../../src/sim/structureWorld");
    const { createLocalBackend } = await import("../../src/sim/detailBackend");
    await initRapier();
    let be: ReturnType<typeof createLocalBackend> | null = null;
    const sim = createSim({}, 3, { tUp: 5, tMature: 40, tRope: 5, translationSpeed: 20 }, (_s, b) => (be = createLocalBackend(b)));
    sim.setDetailFocus({ x: 0, z: 0 });
    for (let n = 0; n < 8 * 60; n++) sim.advance(1 / 60);
    const engine = be!.engines[0]!;
    let checked = 0;
    for (const [i, h] of engine.houses) {
      if (!h.failures.length) continue;
      const b = sim.world.buildings[i]!;
      const r = buildingReport(b);
      expect(r.detailFailures.reduce((a, g) => a + g.count, 0)).toBe(h.failures.length);
      for (const g of r.detailFailures) {
        const mine = h.failures.filter((f) => f.label === g.label);
        expect(g.count).toBe(mine.length);
        const cons = h.framing.connections.filter((c) => c.label === g.label);
        const panes = new Set(cons.map((c) => h.framing.members[c.from]!.pane));
        expect(g.total).toBe(panes.has(undefined) ? cons.length : panes.size);
        expect(g.mph).toBe(mine[0]!.mph);
      }
      expect(r.peakMph).toBeGreaterThanOrEqual(Math.max(...h.failures.map((f) => f.mph)) - 1);
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
  }, 120000);
});
