import { describe, expect, test } from "vitest";
import { AIR_DENSITY } from "../../src/config/atmosphere";
import { APC_TAU, CP, CPI, DEAD_LOAD, OPENINGS } from "../../src/config/buildings";
import { computeLoads, faceArea, faceCp, faceNormal, internalCp, updateApc } from "../../src/core/damage/loads";
import { exactHouse } from "../houseHelpers";

const rec = { part: "windows" as const, time: 0, load: 0, capacity: 0, mph: 0 };

describe("Spec 02 — loads", () => {
  test("LOAD-01: q = ½ρ|V|² from the 3D wind", () => {
    const b = exactHouse();
    const L = computeLoads(b, { x: 30, y: 8, z: -12 }, 0);
    expect(L.q).toBeCloseTo(0.5 * AIR_DENSITY * (30 ** 2 + 8 ** 2 + 12 ** 2), 9);
  });

  test("LOAD-02: windward / side / leeward C_p for any yaw and wind direction", () => {
    for (const yaw of [0, 0.3, 1.2, Math.PI, 4.0]) {
      for (let k = 0; k < 4; k++) {
        const n = faceNormal(yaw, k);
        for (const off of [-0.6, 0, 0.6]) {
          // Wind blowing into face k, rotated by `off` radians (< 45° stays windward).
          const a = Math.atan2(-n.z, -n.x) + off;
          const u = { x: Math.cos(a), z: Math.sin(a) };
          expect(faceCp(u, n)).toBe(CP.windward);
          expect(faceCp(u, faceNormal(yaw, (k + 2) % 4))).toBe(CP.leeward);
          expect(faceCp(u, faceNormal(yaw, (k + 1) % 4))).toBe(CP.side);
          expect(faceCp(u, faceNormal(yaw, (k + 3) % 4))).toBe(CP.side);
        }
      }
    }
    expect(faceCp({ x: 0, z: 0 }, faceNormal(0, 0))).toBe(0);
  });

  test("LOAD-03: internal pressure, enclosed and dominant-opening rule", () => {
    const u = { x: -1, z: 0 }; // blowing toward −X: face 0 (+X) is windward, face 2 leeward
    const enclosed = exactHouse();
    expect(internalCp(enclosed, u)).toBe(CPI.enclosed);

    const ww = exactHouse();
    ww.windowFailed[0] = { ...rec, face: 0 };
    expect(internalCp(ww, u)).toBeCloseTo(0.75 * CP.windward, 12);

    const lw = exactHouse();
    lw.windowFailed[2] = { ...rec, face: 2 };
    expect(internalCp(lw, u)).toBeCloseTo(0.75 * CP.leeward, 12);

    const both = exactHouse();
    both.windowFailed[0] = { ...rec, face: 0 };
    both.windowFailed[1] = { ...rec, face: 1 };
    const a0 = OPENINGS.windowFraction * faceArea(both, 0);
    const a1 = OPENINGS.windowFraction * faceArea(both, 1);
    expect(internalCp(both, u)).toBeCloseTo((0.75 * (a0 * CP.windward + a1 * CP.side)) / (a0 + a1), 12);
  });

  test("LOAD-04: atmospheric pressure change lags while sealed, equalizes once breached", () => {
    const rate = 300; // Pa/s rising deficit
    const sealed = exactHouse();
    let p = 0;
    for (let t = 0; t <= 30; t += 1 / 30) p = updateApc(sealed, rate * t, 1 / 30);
    expect(p).toBeGreaterThan(0);
    expect(Math.abs(p - rate * APC_TAU.sealed) / (rate * APC_TAU.sealed)).toBeLessThan(0.03);
    // Steady deficit → venting catches up.
    const lag = p;
    for (let i = 0; i < 600; i++) p = updateApc(sealed, rate * 30, 1 / 30); // 20 s = 10 τ
    expect(Math.abs(p)).toBeLessThan(1e-3 * lag);

    const open = exactHouse();
    open.windowFailed[1] = { ...rec, face: 1 };
    updateApc(open, 0, 1);
    for (let i = 0; i < 15; i++) p = updateApc(open, 5000, 1 / 30); // 0.5 s after a 5 kPa jump
    expect(Math.abs(p)).toBeLessThan(0.01 * 5000);
  });

  test("LOAD-05: roof uplift grows with C_pi and APC and is reduced by dead load", () => {
    const wind = { x: -40, y: 0, z: 0 };
    const enclosed = exactHouse();
    const L0 = computeLoads(enclosed, wind, 0);
    expect(L0.roofStructure).toBeCloseTo(L0.q * (-CP.roofAverage + CPI.enclosed) - DEAD_LOAD.roof, 9);
    expect(L0.roofDeck).toBeCloseTo(L0.q * (-CP.roofDeckEdge + CPI.enclosed) - DEAD_LOAD.deck, 9);
    const breached = exactHouse();
    breached.windowFailed[0] = { ...rec, face: 0 }; // windward breach
    expect(computeLoads(breached, wind, 0).roofStructure).toBeGreaterThan(L0.roofStructure);
    expect(computeLoads(enclosed, wind, 500).roofStructure).toBeCloseTo(L0.roofStructure + 500, 9);
  });
});
