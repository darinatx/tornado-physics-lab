import { describe, expect, test } from "vitest";
import { efRating, mphToMs, msToMph } from "../../src/core/wind/efScale";
import { lifecycle } from "../../src/core/wind/lifecycle";
import { AIR_DENSITY } from "../../src/config/atmosphere";
import { CELL_STRUCTURE, WIND_PARAMS } from "../../src/config/wind";
import { peakGroundSpeed } from "../../src/core/wind/peak";
import { pressureDeficit } from "../../src/core/wind/pressure";
import { envFactor, heightFactor, swirlRatio, twoCellBlend, windAt, windComponents } from "../../src/core/wind/windField";
import { baseState, hspeed } from "../helpers";

describe("Spec 01 — wind field", () => {
  test("WIND-01: |v_t| peaks at R_max aloft", () => {
    const s = baseState();
    let bestR = 0;
    let best = -1;
    for (let r = 5; r <= 800; r += 0.5) {
      const v = hspeed(windAt({ x: r, y: 300, z: 0 }, s, "open"));
      if (v > best) {
        best = v;
        bestR = r;
      }
    }
    expect(Math.abs(bestR - s.rMax) / s.rMax).toBeLessThan(0.01);
  });

  test("WIND-02: axisymmetric without translation", () => {
    const s = baseState();
    for (const r of [30, 150, 400]) {
      for (const z of [2, 20, 100]) {
        const speeds = Array.from({ length: 8 }, (_, i) => {
          const a = (i / 8) * Math.PI * 2;
          return hspeed(windAt({ x: r * Math.cos(a), y: z, z: r * Math.sin(a) }, s, "suburban"));
        });
        for (const v of speeds) expect(Math.abs(v - speeds[0]!)).toBeLessThan(1e-9);
      }
    }
  });

  test("WIND-03: right side faster than left by 2·|V_trans|", () => {
    const vt = 12;
    const s = baseState({ velocity: { x: vt, z: 0 } }); // moving +X; right of path is +Z
    const right = hspeed(windAt({ x: 0, y: 300, z: s.rMax }, s, "open"));
    const left = hspeed(windAt({ x: 0, y: 300, z: -s.rMax }, s, "open"));
    expect(Math.abs(right - left - 2 * vt) / (2 * vt)).toBeLessThan(0.01);
  });

  test("WIND-04: inflow at 4δ is < 5% of its surface value", () => {
    const s = baseState();
    for (const r of [50, 150, 400]) {
      const surface = windComponents(r, 0, s, "open").radial;
      const aloft = windComponents(r, 4 * s.inflowDepth, s, "open").radial;
      expect(Math.abs(aloft / surface)).toBeLessThan(0.05);
    }
  });

  test("WIND-05: radial flow is inward near the ground", () => {
    const s = baseState();
    for (let r = 1; r <= 1500; r += 7) {
      const w = windAt({ x: r, y: 2, z: 0 }, s, "open");
      expect(w.x).toBeLessThan(0); // radial direction is +X here
    }
  });

  test("WIND-06: one-cell updraft in the core; |v_z| < 5% of W_max at 2·R_max in every regime", () => {
    const oneCell = baseState({ vMax: 60, updraftMax: 80 }); // S = 0.75 ≤ S₁
    expect(swirlRatio(oneCell)).toBeLessThanOrEqual(CELL_STRUCTURE.swirlOneCell);
    for (const r of [0, 30, 75, 120]) {
      expect(windAt({ x: r, y: 50, z: 0 }, oneCell, "open").y).toBeGreaterThan(0);
    }
    for (const updraftMax of [80, 40, 30, 20, 10]) {
      const s = baseState({ updraftMax });
      for (const z of [10, 50, 500]) {
        expect(Math.abs(windAt({ x: 2 * s.rMax, y: z, z: 0 }, s, "open").y)).toBeLessThan(0.05 * s.updraftMax);
      }
    }
  });

  test("WIND-07: outer decay follows r^(−α)", () => {
    const s = baseState();
    const rs = [300, 450, 600, 900, 1200];
    const pts = rs.map((r) => [Math.log(r), Math.log(windComponents(r, 300, s, "open").tangential)] as const);
    const n = pts.length;
    const mx = pts.reduce((a, p) => a + p[0], 0) / n;
    const my = pts.reduce((a, p) => a + p[1], 0) / n;
    const slope =
      pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
    expect(Math.abs(-slope - s.alpha) / s.alpha).toBeLessThan(0.02);
  });

  test("WIND-08: deterministic", () => {
    const s = baseState({ velocity: { x: 7, z: -3 } });
    const p = { x: 123.4, y: 17, z: -56.7 };
    expect(windAt(p, s, "urban")).toEqual(windAt(p, s, "urban"));
  });

  test("WIND-09: finite everywhere, including r = 0 and z = 0", () => {
    const states = [baseState(), baseState({ rMax: 1e-9 }), baseState({ vMax: 0 }), baseState({ velocity: { x: 5, z: 5 } })];
    const pts = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 500, z: 0 },
      { x: 1e-12, y: 0, z: 0 },
      { x: 150, y: 0, z: 0 },
      { x: 1e5, y: 1e4, z: -1e5 },
      { x: 10, y: -5, z: 10 },
    ];
    for (const s of states)
      for (const p of pts)
        for (const t of ["open", "suburban", "urban"] as const) {
          const w = windAt(p, s, t);
          expect(Number.isFinite(w.x) && Number.isFinite(w.y) && Number.isFinite(w.z)).toBe(true);
        }
  });

  test("WIND-10: EF bounds map correctly", () => {
    const cases: [number, number | null][] = [
      [0, null], [64, null], [65, 0], [85, 0], [86, 1], [110, 1], [111, 2],
      [135, 2], [136, 3], [165, 3], [166, 4], [200, 4], [201, 5], [320, 5],
    ];
    for (const [mph, ef] of cases) expect(efRating(mphToMs(mph)), `${mph} mph`).toBe(ef);
  });

  test("WIND-11: rotation = −1 mirrors the field (left side stronger)", () => {
    const vt = 12;
    const s = baseState({ velocity: { x: vt, z: 0 }, rotation: -1 });
    const right = hspeed(windAt({ x: 0, y: 300, z: s.rMax }, s, "open"));
    const left = hspeed(windAt({ x: 0, y: 300, z: -s.rMax }, s, "open"));
    expect(left).toBeGreaterThan(right);
    // Mirror: the cyclonic field at (x, z) equals the anticyclonic one at (x, −z), reflected.
    const cyc = baseState({ velocity: { x: vt, z: 0 } });
    const a = windAt({ x: 40, y: 15, z: 90 }, cyc, "open");
    const b = windAt({ x: 40, y: 15, z: -90 }, s, "open");
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.z).toBeCloseTo(-a.z, 9);
    expect(b.y).toBeCloseTo(a.y, 9);
  });

  test("WIND-12: lifecycle spins up, matures and ropes out", () => {
    const p = { vPeak: 70, rMax: 200, tUp: 60, tMature: 180, tRope: 90 };
    expect(lifecycle(0, p).vMax).toBe(0);
    const mature = lifecycle(150, p);
    expect(mature.vMax).toBe(70);
    expect(mature.phase).toBe("mature");
    const end = lifecycle(330, p);
    expect(end.vMax).toBe(0);
    expect(end.rMax).toBeLessThan(mature.rMax);
    expect(lifecycle(300, p).phase).toBe("rope-out");
    expect(lifecycle(30, p).phase).toBe("spin-up");
  });

  test("WIND-13: peak tangential speed at z_p equals S_peak·V_max, → V_max aloft", () => {
    const s = baseState();
    let bestZ = 0;
    let best = -1;
    for (let z = 0; z <= 400; z += 0.25) {
      const v = windComponents(s.rMax, z, s, "open").tangential;
      if (v > best) {
        best = v;
        bestZ = z;
      }
    }
    expect(Math.abs(bestZ - s.zPeak)).toBeLessThanOrEqual(0.25);
    expect(Math.abs(best - s.overshoot * s.vMax) / (s.overshoot * s.vMax)).toBeLessThan(0.01);
    const aloft = windComponents(s.rMax, s.zPeak + 5 * s.inflowDepth, s, "open").tangential;
    expect(Math.abs(aloft - s.vMax) / s.vMax).toBeLessThan(0.01);
  });

  test("WIND-14: urban terrain slows near-ground wind more than open terrain", () => {
    const s = baseState();
    const p = { x: 150, y: 5, z: 0 };
    expect(hspeed(windAt(p, s, "urban"))).toBeLessThan(hspeed(windAt(p, s, "open")));
  });

  test("WIND-16: two-cell vortex has a central downdraft and an updraft ring at R_max", () => {
    const s = baseState({ vMax: 90, updraftMax: 30 }); // S = 3 ≥ S₂
    expect(twoCellBlend(s)).toBe(1);
    expect(windAt({ x: 0, y: 100, z: 0 }, s, "open").y).toBeLessThan(0);
    expect(windAt({ x: s.rMax, y: 100, z: 0 }, s, "open").y).toBeGreaterThan(0);
    let bestR = 0;
    let best = -Infinity;
    for (let r = 0; r <= 3 * s.rMax; r += 0.5) {
      const w = windAt({ x: r, y: 100, z: 0 }, s, "open").y;
      if (w > best) {
        best = w;
        bestR = r;
      }
    }
    expect(Math.abs(bestR - s.rMax) / s.rMax).toBeLessThan(0.02);
  });

  test("WIND-17: axis vertical flow falls smoothly from updraft to downdraft as swirl rises", () => {
    const { swirlOneCell: s1, swirlTwoCell: s2 } = CELL_STRUCTURE;
    const w = 30;
    let prev = Infinity;
    for (let i = 0; i <= 300; i++) {
      const S = s1 + ((s2 - s1) * i) / 300;
      const v = windAt({ x: 0, y: 100, z: 0 }, baseState({ vMax: S * w, updraftMax: w }), "open").y;
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      if (Number.isFinite(prev)) expect(prev - v).toBeLessThan(0.01 * w); // no jumps
      prev = v;
    }
    expect(windAt({ x: 0, y: 100, z: 0 }, baseState({ vMax: s1 * w, updraftMax: w }), "open").y).toBeGreaterThan(0);
    expect(prev).toBeLessThan(0);
  });

  test("WIND-18: center pressure deficit = ρ·V²·(1/(2α) + ½)", () => {
    for (const [vMax, alpha] of [[60, 0.6], [30, 1.0], [90, 0.5]] as const) {
      const s = baseState({ vMax, alpha });
      const expected = AIR_DENSITY * vMax * vMax * (1 / (2 * alpha) + 0.5);
      expect(Math.abs(pressureDeficit(0, s) - expected) / expected).toBeLessThan(1e-9);
    }
  });

  test("WIND-19: pressure deficit is continuous, monotone, and in cyclostrophic balance", () => {
    const s = baseState();
    const R = s.rMax;
    expect(Math.abs(pressureDeficit(R - 1e-9, s) - pressureDeficit(R, s)) / pressureDeficit(R, s)).toBeLessThan(1e-6);
    let prev = Infinity;
    for (let r = 0; r <= 3000; r += 5) {
      const p = pressureDeficit(r, s);
      expect(p).toBeLessThanOrEqual(prev);
      prev = p;
    }
    for (const r of [20, 75, 140, 160, 300, 900]) {
      const h = 1e-3;
      const dpdr = (pressureDeficit(r + h, s) - pressureDeficit(r - h, s)) / (2 * h);
      const vt = r <= R ? (s.vMax * r) / R : s.vMax * Math.pow(R / r, s.alpha);
      const expected = -(AIR_DENSITY * vt * vt) / r;
      expect(Math.abs(dpdr - expected) / Math.abs(expected)).toBeLessThan(0.005);
    }
  });

  test("WIND-21: the strongest setting stays within measured tornado winds", () => {
    const at = (v: number) => peakGroundSpeed(baseState({ vMax: v, rMax: 300, velocity: { x: 15, z: 0 } }), "open", 10);
    expect(at(94)).toBeLessThanOrEqual(135);
    const maxMph = msToMph(at(WIND_PARAMS.vPeak.max));
    expect(maxMph).toBeGreaterThanOrEqual(380);
    expect(maxMph).toBeLessThanOrEqual(400);
  });

  test("WIND-20: environmental wind follows the surface layer below 10 m", () => {
    const s = baseState({ vMax: 0, velocity: { x: 15, z: 0 } }); // no vortex: environment only
    for (const z of [10, 50, 300]) expect(hspeed(windAt({ x: 0, y: z, z: 0 }, s, "open"))).toBeCloseTo(15, 9);
    const at1 = hspeed(windAt({ x: 0, y: 1, z: 0 }, s, "open"));
    expect(at1).toBeLessThan(15);
    expect(at1).toBeCloseTo(15 * envFactor(1, "open"), 9);
    expect(hspeed(windAt({ x: 0, y: 1, z: 0 }, s, "urban"))).toBeLessThan(at1);
  });

  test("WIND-15: vertical profile is continuous at z_p", () => {
    const s = baseState();
    for (const t of ["open", "suburban", "urban"] as const) {
      for (const r of [50, 150, 600]) {
        const below = heightFactor(r, s.zPeak - 1e-9, s, t);
        const at = heightFactor(r, s.zPeak, s, t);
        expect(Math.abs(below - at) / at).toBeLessThan(1e-6);
      }
    }
  });
});
