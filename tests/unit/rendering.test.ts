import { describe, expect, test } from "vitest";
import { AIR_DENSITY, GRAVITY } from "../../src/config/atmosphere";
import { condensationDeficit, funnelBottom, funnelRadius } from "../../src/core/wind/condensation";
import { EF_LOWER_MPH, efRating, mphToMs } from "../../src/core/wind/efScale";
import { pressureDeficit } from "../../src/core/wind/pressure";
import { HIDDEN_Y, TracerField } from "../../src/render/tracers";
import { computeArrowField, createArrowField } from "../../src/render/arrowField";
import { BELOW_EF0_COLOR, EF5_THRESHOLD_MS, EF_COLORS, arrowColor, arrowLength } from "../../src/render/arrowStyle";
import { interpolateTornado } from "../../src/render/interpolate";
import { createSim } from "../../src/sim/loop";
import { baseState } from "../helpers";

describe("Spec 06 — rendering", () => {
  test("REND-01: arrow colors follow EF bands", () => {
    for (let mph = 0; mph <= 260; mph += 0.5) {
      const ms = mphToMs(mph);
      const ef = efRating(ms);
      expect(arrowColor(ms)).toBe(ef === null ? BELOW_EF0_COLOR : EF_COLORS[ef]);
    }
    expect(arrowColor(mphToMs(EF_LOWER_MPH[3]))).toBe(EF_COLORS[3]);
  });

  test("REND-02: arrow length is linear in speed and capped", () => {
    const max = 22;
    expect(arrowLength(0, max)).toBe(0);
    expect(arrowLength(20, max)).toBeCloseTo(2 * arrowLength(10, max), 12);
    expect(arrowLength(EF5_THRESHOLD_MS, max)).toBeCloseTo(max, 12);
    expect(arrowLength(EF5_THRESHOLD_MS * 3, max)).toBe(max);
  });

  test("REND-03: interpolation is exact at the ends and linear between", () => {
    const prev = baseState({ center: { x: 0, z: 10 }, vMax: 40, rMax: 100 });
    const curr = baseState({ center: { x: 10, z: 30 }, vMax: 60, rMax: 200 });
    const a0 = interpolateTornado(prev, curr, 0);
    const a1 = interpolateTornado(prev, curr, 1);
    const mid = interpolateTornado(prev, curr, 0.25);
    expect([a0.center.x, a0.center.z, a0.vMax, a0.rMax]).toEqual([0, 10, 40, 100]);
    expect([a1.center.x, a1.center.z, a1.vMax, a1.rMax]).toEqual([10, 30, 60, 200]);
    expect([mid.center.x, mid.center.z, mid.vMax, mid.rMax]).toEqual([2.5, 15, 45, 125]);
  });

  test("REND-05: funnel radius solves Δp(r) = ρ·g·(H − z) and widens with height", () => {
    const H = 500;
    for (const s of [baseState(), baseState({ vMax: 80, rMax: 300 }), baseState({ vMax: 35, alpha: 0.9 })]) {
      let prev = 0;
      for (let z = 0; z <= H; z += 2) {
        const r = funnelRadius(z, s, H, 3 * s.rMax);
        expect(r).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = r;
        if (r > 0 && r < 3 * s.rMax) {
          const need = condensationDeficit(z, H);
          expect(Math.abs(pressureDeficit(r, s) - need) / need).toBeLessThan(0.001);
        }
      }
    }
  });

  test("REND-06: funnel bottom and touchdown follow the center deficit", () => {
    const H = 500;
    const rg = AIR_DENSITY * GRAVITY;
    const weak = baseState({ vMax: 35 });
    const strong = baseState({ vMax: 80 });
    const zb = funnelBottom(weak, H);
    expect(zb).toBeGreaterThan(0);
    expect(Math.abs(pressureDeficit(0, weak) - rg * (H - zb)) / pressureDeficit(0, weak)).toBeLessThan(1e-9);
    expect(funnelRadius(zb - 1, weak, H)).toBe(0);
    expect(funnelRadius(zb + 1, weak, H)).toBeGreaterThan(0);
    expect(pressureDeficit(0, strong)).toBeGreaterThanOrEqual(rg * H);
    expect(funnelBottom(strong, H)).toBe(0);
    expect(funnelRadius(0, strong, H)).toBeGreaterThan(0);
  });

  test("REND-07: tracers are deterministic and stay in bounds", () => {
    const s = baseState({ vMax: 70, velocity: { x: 12, z: 0 } });
    const H = 500;
    const a = new TracerField(2000, 5);
    const b = new TracerField(2000, 5);
    for (let i = 0; i < 600; i++) {
      const dt = i % 7 === 0 ? 0.2 : 1 / 60;
      a.update(dt, s, "open", H);
      b.update(dt, s, "open", H);
    }
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    let alive = 0;
    for (let i = 0; i < a.count; i++) {
      const y = a.positions[i * 3 + 1]!;
      if (y === HIDDEN_Y) continue;
      alive++;
      const r = Math.hypot(a.positions[i * 3]! - s.center.x, a.positions[i * 3 + 2]! - s.center.z);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThanOrEqual(0.8 * H);
      expect(r).toBeLessThanOrEqual(4 * s.rMax);
    }
    expect(alive).toBeGreaterThan(1000);
  });

  test("REND-04: rendering computations never mutate sim state", () => {
    const sim = createSim();
    sim.advance(0.1);
    const f = sim.advance(0.1);
    expect(Object.isFrozen(f.curr) && Object.isFrozen(f.curr.tornado)).toBe(true);
    const before = JSON.stringify([f.prev, f.curr]);
    const s = interpolateTornado(f.prev.tornado, f.curr.tornado, f.alpha);
    const opts = { spacing: 50, range: 500, height: 10 };
    computeArrowField(s, f.curr.terrain, opts, createArrowField(opts));
    expect(JSON.stringify([f.prev, f.curr])).toBe(before);
  });
});
