import { describe, expect, test } from "vitest";
import { AIR_DENSITY } from "../../src/config/atmosphere";
import { APC_TAU, CP, CPI, DEAD_LOAD, LAYOUT } from "../../src/config/buildings";
import { bayLoad, computeHouseLoads, coverLoad, deckLoad, faceCp, faceNormal, internalCp, updateApc, wallSigned } from "../../src/core/damage/loads";
import { exactHouse, rec } from "../houseHelpers";

describe("Spec 02 — loads", () => {
  test("LOAD-01: q = ½ρ|V|² from the 3D wind", () => {
    const L = computeHouseLoads(exactHouse(), { x: 30, y: 8, z: -12 });
    expect(L.q).toBeCloseTo(0.5 * AIR_DENSITY * (30 ** 2 + 8 ** 2 + 12 ** 2), 9);
  });

  test("LOAD-02: windward / side / leeward C_p for any yaw and wind direction", () => {
    for (const yaw of [0, 0.3, 1.2, Math.PI, 4.0]) {
      for (let k = 0; k < 4; k++) {
        const n = faceNormal(yaw, k);
        for (const off of [-0.6, 0, 0.6]) {
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
    const cp = [CP.windward, CP.side, CP.leeward, CP.side]; // wind toward −X
    const enclosed = exactHouse();
    expect(internalCp(enclosed, cp)).toBe(CPI.enclosed);
    const ww = exactHouse();
    const wPane = ww.panes.findIndex((p) => ww.panels[p.panel]!.face === 0);
    if (wPane >= 0) {
      ww.panes[wPane]!.failed = rec("window", wPane);
      ww.breached = true;
      expect(internalCp(ww, cp)).toBeCloseTo(0.75 * CP.windward, 12);
    }
    const lw = exactHouse();
    const panel = lw.panels.findIndex((p) => p.face === 2);
    lw.panels[panel]!.failed = rec("wallPanel", panel);
    lw.breached = true;
    expect(internalCp(lw, cp)).toBeCloseTo(0.75 * CP.leeward, 12);
    // Two openings: area-weighted.
    const both = exactHouse();
    const p0 = both.panels.findIndex((p) => p.face === 0);
    const p1 = both.panels.findIndex((p) => p.face === 1);
    both.panels[p0]!.failed = rec("wallPanel", p0);
    both.panels[p1]!.failed = rec("wallPanel", p1);
    both.breached = true;
    const a0 = both.panels[p0]!.len * both.wallHeight;
    const a1 = both.panels[p1]!.len * both.wallHeight;
    expect(internalCp(both, cp)).toBeCloseTo((0.75 * (a0 * CP.windward + a1 * CP.side)) / (a0 + a1), 12);
    expect(LAYOUT.paneSize).toBeGreaterThan(0);
  });

  test("LOAD-04: atmospheric pressure change lags while sealed, equalizes once breached", () => {
    const rate = 300;
    const sealed = exactHouse();
    let p = 0;
    for (let t = 0; t <= 30; t += 1 / 30) p = updateApc(sealed, rate * t, 1 / 30);
    expect(Math.abs(p - rate * APC_TAU.sealed) / (rate * APC_TAU.sealed)).toBeLessThan(0.03);
    const lag = p;
    for (let i = 0; i < 600; i++) p = updateApc(sealed, rate * 30, 1 / 30);
    expect(Math.abs(p)).toBeLessThan(1e-3 * lag);
    const open = exactHouse();
    open.breached = true;
    updateApc(open, 0, 1);
    for (let i = 0; i < 15; i++) p = updateApc(open, 5000, 1 / 30);
    expect(Math.abs(p)).toBeLessThan(0.01 * 5000);
  });

  test("LOAD-05: roof uplift grows with C_pi and APC and is reduced by dead load", () => {
    const wind = { x: -40, y: 0, z: 0 };
    const enclosed = exactHouse();
    const L0 = computeHouseLoads(enclosed, wind);
    expect(bayLoad(L0, 0)).toBeCloseTo(L0.q * (-CP.roofAverage + CPI.enclosed) - DEAD_LOAD.roof, 9);
    const field = enclosed.sections.find((s) => !s.edge)!;
    expect(deckLoad(L0, field, 0)).toBeCloseTo(L0.q * (-CP.deckField + CPI.enclosed) - DEAD_LOAD.deck, 9);
    const breached = exactHouse();
    const i = breached.panels.findIndex((p) => p.face === 0); // windward for wind toward −X
    breached.panels[i]!.failed = rec("wallPanel", i);
    breached.breached = true;
    expect(bayLoad(computeHouseLoads(breached, wind), 0)).toBeGreaterThan(bayLoad(L0, 0));
    expect(bayLoad(L0, 500)).toBeCloseTo(bayLoad(L0, 0) + 500, 9);
  });

  test("LOAD-06: corner sections carry more; wall loads push in windward, pull out elsewhere", () => {
    const b = exactHouse();
    const L = computeHouseLoads(b, { x: -40, y: 0, z: 0 });
    const corner = b.sections.find((s) => s.edge)!;
    const field = b.sections.find((s) => !s.edge)!;
    expect(coverLoad(L, corner, 0)).toBeGreaterThan(coverLoad(L, field, 0));
    expect(deckLoad(L, corner, 0)).toBeGreaterThan(deckLoad(L, field, 0));
    expect(wallSigned(L, 0, 0)).toBeGreaterThan(0); // windward face pushed in
    for (const f of [1, 2, 3]) expect(wallSigned(L, f, 0)).toBeLessThan(0); // side/leeward pulled out
  });
});
