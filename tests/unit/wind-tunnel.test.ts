/**
 * Spec 12 — Wind tunnel, quick checks (flow, layout, town launches, chunking).
 */
import { beforeAll, describe, expect, test } from "vitest";
import { TUNNEL } from "../../src/config/tunnel";
import { mphToMs } from "../../src/core/wind/efScale";
import { pressureDeficit } from "../../src/core/wind/pressure";
import { envFactor, windAt } from "../../src/core/wind/windField";
import { initRapier } from "../../src/sim/structureWorld";
import { createTunnel, tunnelFlow, tunnelState } from "../../src/sim/tunnel";
import type { TunnelScenario } from "../../src/sim/tunnel";
import { recordHash, runTunnel } from "../harness/tunnel";

beforeAll(async () => {
  await initRapier();
});

describe("Spec 12 wind tunnel: flow", () => {
  test("TUN-01: windAt follows the power-law profile along the scheduled direction, with the ramped vertical wind", () => {
    for (const terrain of ["open", "suburban", "urban"] as const) {
      const s = tunnelState({ u10: 50, dirDeg: 30, w: 4, deficit: 800 });
      for (const y of [0.2, 1, 3, 6, 10, 25]) {
        const w = windAt({ x: 123, y, z: -77 }, s, terrain);
        const u = 50 * envFactor(y, terrain);
        const a = (30 * Math.PI) / 180;
        expect(w.x).toBeCloseTo(u * Math.cos(a), 9);
        expect(w.z).toBeCloseTo(-u * Math.sin(a), 9);
        expect(w.y).toBeCloseTo(4 * Math.min(y / TUNNEL.wRampHeight, 1), 9);
      }
      // The same everywhere in plan; the deficit is uniform.
      const far = windAt({ x: -900, y: 3, z: 400 }, s, terrain);
      const near = windAt({ x: 0, y: 3, z: 0 }, s, terrain);
      expect(far).toEqual(near);
      expect(pressureDeficit(0, s)).toBe(800);
      expect(pressureDeficit(5000, s)).toBe(800);
    }
  });

  test("TUN-01: keyframes interpolate linearly, turn along the shorter arc, and hold outside the schedule", () => {
    const keys = [
      { t: 2, mph: 50, dirDeg: 350, deficit: 0 },
      { t: 6, mph: 150, dirDeg: 30, w: 8, deficit: 400 },
    ];
    const before = tunnelFlow(keys, 0);
    expect(before.u10).toBeCloseTo(mphToMs(50), 9);
    expect(before.dirDeg).toBeCloseTo(350, 9);
    const mid = tunnelFlow(keys, 4);
    expect(mid.u10).toBeCloseTo(mphToMs(100), 9);
    // 350° → 30° goes through 0° (40° of turn), not back through 180° (320°).
    expect(((mid.dirDeg % 360) + 360) % 360).toBeCloseTo(10, 9);
    expect(mid.w).toBeCloseTo(4, 9);
    expect(mid.deficit).toBeCloseTo(200, 9);
    const after = tunnelFlow(keys, 60);
    expect(after.u10).toBeCloseTo(mphToMs(150), 9);
    expect(((after.dirDeg % 360) + 360) % 360).toBeCloseTo(30, 9);
    expect(after.deficit).toBe(400);
  });
});

const shots: TunnelScenario = {
  name: "layout",
  seconds: 1,
  target: { model: "detail", cls: "standard" },
  wind: [{ t: 0, mph: 0, dirDeg: 90 }],
  launches: [
    { t: 0.5, source: "detail-same", member: "siding", from: { x: 0, y: 2, z: 30 }, speed: 10, dir: { x: 0, y: 0, z: -1 } },
    { t: 0.5, source: "detail-other", member: "siding", from: { x: 0, y: 2, z: 40 }, speed: 10, dir: { x: 0, y: 0, z: -1 } },
  ],
};

describe("Spec 12 wind tunnel: layout", () => {
  test("TUN-02: the target alone at the origin, donors in its physics group and another, 80 m across the wind", async () => {
    const tun = await createTunnel(shots);
    const bs = tun.sim.world.buildings;
    expect(bs.length).toBe(3);
    const t = bs[tun.target]!;
    expect(t.x).toBe(0);
    expect(t.z).toBe(0);
    const same = bs[tun.donors.same!]!;
    const other = bs[tun.donors.other!]!;
    // Physics groups, as the engine has them once the houses are in.
    tun.advance(1 / 60);
    expect(tun.worldOf(tun.donors.same!)).toBeDefined();
    expect(tun.worldOf(tun.donors.same!)).toBe(tun.worldOf(tun.target));
    expect(tun.worldOf(tun.donors.other!)).toBeDefined();
    expect(tun.worldOf(tun.donors.other!)).not.toBe(tun.worldOf(tun.target));
    // Wind toward 90° (−Z): across it is along ±X.
    for (const d of [same, other]) {
      expect(Math.hypot(d.x - t.x, d.z - t.z)).toBeGreaterThanOrEqual(TUNNEL.donorOffset - 1e-9);
      // Not upwind or downwind of the target: the along-wind offset is small next to the across-wind one.
      expect(Math.abs(d.z - t.z)).toBeLessThan(Math.abs(d.x - t.x));
    }
    tun.dispose();
  });

  test("TUN-02: a detailed target is in the zone from the first detail step for the whole run; a component target never is", async () => {
    const tun = await createTunnel({ ...shots, seconds: 4, launches: [] });
    tun.advance(1 / 60);
    expect(tun.sim.detail.houses.has(tun.target)).toBe(true);
    tun.advance(4);
    expect(tun.sim.detail.houses.has(tun.target)).toBe(true);
    expect(tun.sim.world.buildings[tun.target]!.detail).toBe(true);
    tun.dispose();

    const comp = await createTunnel({ ...shots, target: { model: "component" }, launches: [] });
    comp.advance(2);
    expect(comp.sim.world.buildings.length).toBe(1);
    expect(comp.sim.world.buildings[comp.target]!.detail).toBeFalsy();
    expect(comp.sim.detail.houses.size).toBe(0);
    comp.dispose();
  });
});

describe("Spec 12 wind tunnel: town launches", () => {
  test("TUN-04: a town piece enters at the first debris step at or after its time, at its point with its velocity, end-on, in the ledger", async () => {
    const from = { x: -12, y: 2, z: 0.3 };
    const tun = await createTunnel({
      name: "town-launch",
      seconds: 1,
      target: { model: "component" },
      wind: [{ t: 0, mph: 0, dirDeg: 0 }],
      launches: [{ t: 0.205, source: "town", kind: "stud", from, speed: 15, dir: { x: 1, y: 0, z: 0 } }],
    });
    const mass0 = tun.sim.debris.massSpawned;
    tun.advance(0.2);
    expect(tun.sim.debris.pieces.length).toBe(0);
    tun.advance(0.05);
    const l = tun.launched[0]!;
    // Debris steps every 1/60 s: the first at or after 0.205 s is 13/60 = 0.2167 s.
    expect(l.time).toBeCloseTo(13 / 60, 9);
    expect(l.at).toEqual(from);
    expect(l.vel.x).toBeCloseTo(15, 9);
    const p = tun.sim.debris.pieces[0]!;
    expect(p.def.label).toMatch(/Stud/);
    expect(p.represents).toBe(1);
    expect(tun.sim.debris.massSpawned - mass0).toBeCloseTo(p.def.mass, 9);
    // End-on: the long axis (piece X) along the launch direction.
    const [qx, qy, qz, qw] = l.q;
    const ax = 1 - 2 * (qy * qy + qz * qz);
    const ay = 2 * (qx * qy + qw * qz);
    const az = 2 * (qx * qz - qw * qy);
    expect(Math.abs(ax)).toBeCloseTo(1, 6);
    expect(Math.hypot(ay, az)).toBeLessThan(1e-6);
    // Then it flies on Spec 04 physics, from the step it entered on: ≈ v·t in calm air.
    expect(Math.abs(p.pos.x - from.x - 15 * (tun.sim.time - l.time + 1 / 60))).toBeLessThan(0.05);
    tun.dispose();
  });
});

describe("Spec 12 wind tunnel: record", () => {
  test("TUN-08: the same scenario gives an identical record however the run is chunked", async () => {
    const sc: TunnelScenario = {
      name: "chunks",
      seconds: 3,
      target: { model: "component", cls: "standard" },
      wind: [
        { t: 0, mph: 60, dirDeg: 0 },
        { t: 3, mph: 160, dirDeg: 40 },
      ],
      launches: [
        { t: 0.3, source: "town", kind: "stud", from: { x: -10, y: 1.6, z: 0 }, speed: 30, aim: { pane: 0 } },
        { t: 1.0, source: "town", kind: "osb", from: { x: -10, y: 2, z: 2 }, speed: 20, dir: { x: 1, y: 0, z: 0 } },
      ],
    };
    const a = await runTunnel(sc, { chunk: 1 / 60 });
    const b = await runTunnel(sc, { chunk: 0.25 });
    const c = await runTunnel(sc, { chunk: 1.1 });
    expect(a.samples.length).toBe(30);
    expect(recordHash(b)).toBe(recordHash(a));
    expect(recordHash(c)).toBe(recordHash(a));
    expect(a.launches.length).toBe(2);
    expect(a.samples[a.samples.length - 1]!.mph).toBeGreaterThan(140);
  });
});
