import { describe, expect, test } from "vitest";
import { windComponents } from "../../src/core/wind/windField";
import { baseState } from "../helpers";

// With α = 1 and no overshoot, the field aloft must reproduce the classic Rankine vortex:
// solid-body rotation in the core, potential vortex (v ∝ 1/r) outside.
describe("validation — classic Rankine vortex", () => {
  test("matches the analytic Rankine profile within 0.5% aloft", () => {
    const s = baseState({ alpha: 1, overshoot: 1 });
    for (let r = 10; r <= 2000; r += 10) {
      const analytic = r <= s.rMax ? (s.vMax * r) / s.rMax : (s.vMax * s.rMax) / r;
      const model = windComponents(r, 400, s, "open").tangential;
      expect(Math.abs(model - analytic) / analytic).toBeLessThan(0.005);
    }
  });

  test("circulation outside the core is constant (Γ = 2πr·v)", () => {
    const s = baseState({ alpha: 1, overshoot: 1 });
    const gamma = (r: number) => 2 * Math.PI * r * windComponents(r, 400, s, "open").tangential;
    const g0 = gamma(200);
    for (const r of [300, 600, 1200, 2400]) expect(Math.abs(gamma(r) - g0) / g0).toBeLessThan(1e-9);
  });
});
