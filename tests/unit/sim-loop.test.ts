import { describe, expect, test } from "vitest";
import { SIM_DEFAULTS } from "../../src/config/sim";
import { createSim } from "../../src/sim/loop";
import { createRng } from "../../src/sim/rng";

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
});
