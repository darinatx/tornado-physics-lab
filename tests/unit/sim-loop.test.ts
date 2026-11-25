import { describe, expect, test } from "vitest";
import { SIM_DEFAULTS } from "../../src/config/sim";
import { createSim } from "../../src/sim/loop";
import { createRng } from "../../src/sim/rng";
import { PRESETS } from "../../src/config/presets";
import { allFailures } from "../../src/core/damage/building";

describe("Spec 08 — simulation loop", () => {
  test("SIM-01: same state however elapsed time is split", () => {
    const a = createSim();
    const b = createSim();
    a.advance(0.25);
    for (let i = 0; i < 15; i++) b.advance(1 / 60);
    expect(a.snapshot.step).toBe(b.snapshot.step);
    expect(Math.abs(a.snapshot.tornado.center.x - b.snapshot.tornado.center.x)).toBeLessThan(1e-9);
    expect(Math.abs(a.snapshot.tornado.center.z - b.snapshot.tornado.center.z)).toBeLessThan(1e-9);
    expect(a.snapshot).toEqual(b.snapshot);
  });

  test("SIM-02: real elapsed time per frame is clamped", () => {
    const s = createSim();
    s.advance(10);
    expect(s.time).toBeCloseTo(SIM_DEFAULTS.maxFrameDt, 9);
  });

  test("SIM-03: alpha is always in [0, 1)", () => {
    const s = createSim();
    for (let i = 0; i < 500; i++) {
      const { alpha } = s.advance(((i * 7919) % 97) / 1000);
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(alpha).toBeLessThan(1);
    }
  });

  test("SIM-04: same seed gives identical runs; different seeds differ", () => {
    const a = createSim({}, 42);
    const b = createSim({}, 42);
    for (let i = 0; i < 50; i++) {
      a.advance(0.02);
      b.advance(0.02);
    }
    expect(a.snapshot).toEqual(b.snapshot);
    const seqA = Array.from({ length: 5 }, a.rng);
    const seqB = Array.from({ length: 5 }, b.rng);
    expect(seqA).toEqual(seqB);
    const r1 = createRng(1);
    const r2 = createRng(2);
    expect(Array.from({ length: 5 }, r1)).not.toEqual(Array.from({ length: 5 }, r2));
  });

  test("SIM-05: setParams takes effect at the next step", () => {
    const s = createSim();
    s.advance(1);
    const before = s.snapshot;
    s.setParams({ alpha: 0.9 });
    expect(s.snapshot.tornado.alpha).toBe(before.tornado.alpha);
    s.advance(SIM_DEFAULTS.dt);
    expect(s.snapshot.tornado.alpha).toBe(0.9);
  });

  test("SIM-06: straight path at the translation speed", () => {
    const s = createSim({}, 1, { translationSpeed: 15, turnRate: 0 });
    const start = s.snapshot.tornado.center;
    const pts = [];
    for (let i = 0; i < 40; i++) {
      s.advance(0.25);
      pts.push(s.snapshot.tornado.center);
    }
    const end = pts[pts.length - 1]!;
    const dist = Math.hypot(end.x - start.x, end.z - start.z);
    expect(s.time).toBeCloseTo(10, 9);
    expect(Math.abs(dist - 15 * s.time)).toBeLessThan(1e-6);
    // Straight: every intermediate point lies on the start→end line.
    const ux = (end.x - start.x) / dist;
    const uz = (end.z - start.z) / dist;
    for (const p of pts) {
      const cross = (p.x - start.x) * uz - (p.z - start.z) * ux;
      expect(Math.abs(cross)).toBeLessThan(1e-6);
    }
  });

  test("SIM-08: world damage version, histogram and reset", () => {
    const ef4 = PRESETS.find((p) => p.id === "ef4-wedge")!;
    const sim = createSim({}, 3, ef4.params);
    const n = sim.world.buildings.length;
    expect(n).toBeGreaterThan(3000);
    expect(sim.snapshot.damageHistogram[0]).toBe(n);
    let lastVersion = sim.snapshot.damageVersion;
    let sawChange = false;
    while (sim.time < 200) {
      sim.advance(0.25);
      const snap = sim.snapshot;
      expect(snap.damageHistogram.reduce((a, b) => a + b, 0)).toBe(n);
      expect(snap.damageVersion).toBeGreaterThanOrEqual(lastVersion);
      if (snap.damageVersion > lastVersion) sawChange = true;
      lastVersion = snap.damageVersion;
    }
    expect(sawChange).toBe(true);
    const hist = sim.snapshot.damageHistogram;
    const dods = new Array(11).fill(0);
    for (const b of sim.world.buildings) dods[b.dod]++;
    expect([...hist]).toEqual(dods);
    expect(hist[0]).toBeLessThan(n);

    sim.reset();
    expect(sim.snapshot.damageHistogram[0]).toBe(sim.world.buildings.length);
    expect(sim.world.buildings.every((b) => b.dod === 0)).toBe(true);
  }, 60000);

  test("SIM-09: failures spawn debris in the same step; reset empties the pool", () => {
    const ef4 = PRESETS.find((p) => p.id === "ef4-wedge")!;
    const sim = createSim({}, 4, ef4.params);
    let lastFailures = 0;
    while (sim.time < 100) {
      sim.advance(1 / 30);
      const failures = sim.world.buildings.reduce(
        (a, b) => a + allFailures(b).length,
        0,
      );
      if (failures > lastFailures) {
        // New failures this frame: their pieces exist (or were counted as skipped/lofted).
        const d = sim.snapshot.debris;
        expect(d.airborne + d.resting + d.skipped + d.lofted).toBeGreaterThan(0);
      }
      lastFailures = failures;
      const live = sim.debris.pieces;
      expect(sim.snapshot.debris.airborne + sim.snapshot.debris.resting).toBe(live.length);
    }
    expect(sim.debris.pieces.length).toBeGreaterThan(0);
    sim.reset();
    expect(sim.debris.pieces.length).toBe(0);
    expect(sim.snapshot.debris.airborne).toBe(0);
  }, 60000);

  test("SIM-07: time scale 0 pauses, 2 runs twice as fast", () => {
    const paused = createSim();
    paused.setTimeScale(0);
    const snap = paused.snapshot;
    paused.advance(0.2);
    expect(paused.snapshot).toBe(snap);

    const one = createSim();
    const two = createSim();
    two.setTimeScale(2);
    one.advance(0.1);
    two.advance(0.1);
    expect(two.time).toBeCloseTo(2 * one.time, 9);
  });
  test("SIM-10: a test area holds exactly the town's houses within it; start point; mature from the first step", async () => {
    const { generateNeighborhood } = await import("../../src/sim/city");
    const area = { x: 0, z: 20, radius: 60 };
    const town = generateNeighborhood(1).buildings.filter((b) => Math.hypot(b.x - area.x, b.z - area.z) <= area.radius);
    const sim = createSim({ area, start: { x: -500, z: 30 } }, 1, { tUp: 0 });
    expect(sim.world.buildings.map((b) => b.id)).toEqual(town.map((b) => b.id));
    sim.world.buildings.forEach((b, i) => expect({ ...b, normals: null }).toEqual({ ...town[i]!, normals: null }));
    expect(sim.snapshot.tornado.center).toEqual({ x: -500, z: 30 });
    sim.advance(1 / 60);
    expect(sim.snapshot.tornado.vMax).toBe(sim.params.vPeak);
  });
});
