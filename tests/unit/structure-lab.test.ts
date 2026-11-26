/**
 * Spec 13 — Structure lab on the real sim: layout, terrain, winds, determinism, launcher,
 * member inspector, record export, replay frames. (Pass-through, cost, recording and replay
 * accuracy over a real pass are in tests/validation/structure-lab.test.ts.)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { REFERENCE_MISSILES } from "../../src/config/lab";
import { PRESETS } from "../../src/config/presets";
import { LAB, DETAIL } from "../../src/config/structure";
import { mphToMs } from "../../src/core/wind/efScale";
import { windAt } from "../../src/core/wind/windField";
import { createLocalBackend } from "../../src/sim/detailBackend";
import { frameOf, inCaptureBox } from "../../src/sim/debrisRecorder";
import type { DebrisRecording } from "../../src/sim/debrisRecorder";
import { createLab, labBlockSpecs, replayLaunches } from "../../src/sim/lab";
import type { LabSetup, LabWind } from "../../src/sim/lab";
import { initRapier } from "../../src/sim/structureWorld";
import { tunnelFlow } from "../../src/sim/tunnelFlow";
import { defaultParams } from "../../src/sim/types";
import { windowShot } from "../tunnel/scenarios";

beforeAll(async () => {
  await initRapier();
});

const setup = (p: Partial<LabSetup> = {}): LabSetup => ({ houses: 1, cls: "standard", surroundings: "open", seed: 3, donors: false, ...p });
const calm: LabWind = { kind: "steady", keys: [{ t: 0, mph: 0, dirDeg: 0 }] };
const preset = (id: string) => ({ ...defaultParams(), ...PRESETS.find((p) => p.id === id)!.params });

describe("Spec 13 lab: layout", () => {
  test("LAB-01: the lab is the sim: explicit layout, lab houses detailed from the first step in one group, no lab-only physics module", async () => {
    const lab = await createLab(setup({ houses: 4 }), calm);
    expect(lab.sim.world.buildings.length).toBe(4);
    lab.advance(1 / 60);
    // In the detail set from the first detail step, all in one physics world.
    expect([...lab.sim.detail.houses.keys()].sort()).toEqual([0, 1, 2, 3]);
    expect(lab.sim.world.buildings.every((b) => b.detail)).toBe(true);
    lab.advance(0.5);
    // Never leave the zone.
    expect(lab.sim.detail.houses.size).toBe(4);
    // One engine, one world for the block.
    const engines: ReturnType<typeof createLocalBackend>[] = [];
    const lab2 = await createLab(setup({ houses: 4 }), calm, { detail: (_s, b) => (engines.push(createLocalBackend(b, 1)), engines[0]!) });
    lab2.advance(1 / 30);
    expect([...engines[0]!.engines[0]!.worlds.keys()]).toEqual(["lab"]);
    lab.dispose();
    lab2.dispose();
    // The slice A lab module is gone, and nothing in src/sim steps physics of its own for the lab.
    expect(existsSync(join(import.meta.dirname, "../../src/sim/structureLab.ts"))).toBe(false);
    const labSrc = readFileSync(join(import.meta.dirname, "../../src/sim/lab.ts"), "utf8");
    expect(labSrc).not.toMatch(/new StructureWorld|\.step\(this\.wind|windAtHeight/);
    expect(readdirSync(join(import.meta.dirname, "../../src/sim")).filter((f) => /lab/i.test(f))).toEqual(["lab.ts"]);
  });

  test("LAB-02: N houses in a centered grid at 28 m; neighborhood fills town lots within 130 m, none overlapping the block; open holds only the block", async () => {
    for (const n of [1, 2, 4, 5, LAB.maxHouses]) {
      const specs = labBlockSpecs({ houses: n, cls: "standard", seed: 3 });
      expect(specs.length).toBe(n);
      const cols = Math.ceil(Math.sqrt(n));
      const xs = [...new Set(specs.map((b) => b.x))].sort((a, b) => a - b);
      const zs = [...new Set(specs.map((b) => b.z))].sort((a, b) => a - b);
      expect(xs.length).toBe(Math.min(cols, n));
      for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeCloseTo(LAB.lotSpacing, 9);
      for (let i = 1; i < zs.length; i++) expect(zs[i]! - zs[i - 1]!).toBeCloseTo(LAB.lotSpacing, 9);
      expect(xs[0]! + xs[xs.length - 1]!).toBeCloseTo(0, 9);
      expect(zs[0]! + zs[zs.length - 1]!).toBeCloseTo(0, 9);
      // ±3° jitter.
      for (const s of specs) expect(Math.abs(s.yaw)).toBeLessThanOrEqual((3 * Math.PI) / 180 + 1e-12);
    }
    const open = await createLab(setup({ houses: 4 }), calm);
    expect(open.sim.world.buildings.length).toBe(4);
    expect(open.ring).toEqual([]);
    open.dispose();
    const withDonors = await createLab(setup({ houses: 4, donors: true }), calm);
    expect(withDonors.sim.world.buildings.length).toBe(6);
    withDonors.dispose();

    const hood = await createLab(setup({ houses: 4, surroundings: "neighborhood", model: "component" }), calm);
    const bs = hood.sim.world.buildings;
    const block = hood.block.map((i) => bs[i]!);
    const half = { x: LAB.lotSpacing, z: LAB.lotSpacing }; // 2 × 2 grid: lots reach ±28 m
    expect(hood.ring.length).toBeGreaterThan(20);
    for (const i of hood.ring) {
      const b = bs[i]!;
      const dx = Math.max(0, Math.abs(b.x) - half.x);
      const dz = Math.max(0, Math.abs(b.z) - half.z);
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(130);
      // No ring house reaches into a lab lot.
      for (const s of block) {
        const ex = Math.max(0, Math.abs(b.x - s.x) - LAB.lotSpacing / 2);
        const ez = Math.max(0, Math.abs(b.z - s.z) - LAB.lotSpacing / 2);
        expect(Math.hypot(ex, ez)).toBeGreaterThan(Math.hypot(b.width, b.depth) / 2);
      }
    }
    // Every town lot in reach is there: the ring is the town's houses, less those near the block.
    const { generateNeighborhood } = await import("../../src/sim/city");
    const town = generateNeighborhood(3).buildings.filter((b) => Math.hypot(Math.max(0, Math.abs(b.x) - half.x), Math.max(0, Math.abs(b.z) - half.z)) <= 130);
    const ringKeys = new Set(hood.ring.map((i) => `${bs[i]!.x.toFixed(3)},${bs[i]!.z.toFixed(3)}`));
    const missing = town.filter((b) => !ringKeys.has(`${b.x.toFixed(3)},${b.z.toFixed(3)}`));
    for (const b of missing) {
      // Left out only for being near a lab lot.
      const near = block.some((s) => Math.hypot(Math.max(0, Math.abs(b.x - s.x) - LAB.lotSpacing / 2), Math.max(0, Math.abs(b.z - s.z) - LAB.lotSpacing / 2)) < Math.hypot(b.width, b.depth) / 2 + 3);
      expect(near).toBe(true);
    }
    // A block house is the same house with or without the ring (its own draw stream).
    const alone = await createLab(setup({ houses: 4, model: "component" }), calm);
    for (const i of hood.block) {
      const a = alone.sim.world.buildings[i]!;
      const b = bs[i]!;
      expect(b.panes.length).toBe(a.panes.length);
      expect(b.panels.map((p) => p.cap)).toEqual(a.panels.map((p) => p.cap));
    }
    hood.dispose();
    alone.dispose();
  });

  test("LAB-03: terrain is suburban in a neighborhood and open in a field", async () => {
    const a = await createLab(setup({ surroundings: "neighborhood", model: "component" }), calm);
    expect(a.sim.snapshot.terrain).toBe("suburban");
    const b = await createLab(setup({ model: "component" }), calm);
    expect(b.sim.snapshot.terrain).toBe("open");
    a.dispose();
    b.dispose();
  });
});

describe("Spec 13 lab: wind", () => {
  test("LAB-04: steady wind is the tunnel flow for its keys; a live change is a keyframe at that time, and replaying the keys gives the same run", async () => {
    const lab = await createLab(setup({ model: "component" }), { kind: "steady", keys: [{ t: 0, mph: 40, dirDeg: 30 }] });
    lab.advance(1);
    expect(lab.sim.snapshot.tornado.tunnel).toEqual(tunnelFlow(lab.keys, lab.sim.snapshot.time));
    const t = lab.sim.time;
    lab.setSteady(130, 75);
    expect(lab.keys.at(-2)!.t).toBeCloseTo(t, 12);
    expect(lab.keys.at(-2)!.mph).toBeCloseTo(40, 9);
    lab.advance(1);
    lab.setSteady(60, 10, { rampS: 2 });
    lab.advance(3);
    const s = lab.sim.snapshot;
    expect(s.tornado.tunnel).toEqual(tunnelFlow(lab.keys, s.time));
    expect(s.tornado.tunnel!.u10).toBeCloseTo(mphToMs(60), 6);
    const first = lab.record();
    // The same keys from the start: the same run.
    const again = await createLab(setup({ model: "component" }), { kind: "steady", keys: lab.keys.map((k) => ({ ...k })) });
    again.advance(5);
    const second = again.record();
    expect(second.failures).toEqual(first.failures);
    expect(second.samples).toEqual(first.samples);
    expect(first.failures.length).toBeGreaterThan(0);
    lab.dispose();
    again.dispose();
  });

  test("LAB-05: a mature pass starts by Spec 09's rule, holds V_max and R_max on a straight track, and ends as far past the block as it started", async () => {
    const p = preset("ef4-wedge");
    const lab = await createLab(setup({ model: "component" }), { kind: "pass", presetId: "ef4-wedge", headingDeg: 90, offset: 0, lifecycle: "mature" });
    const b = lab.sim.world.buildings[0]!;
    const s0 = lab.sim.snapshot.tornado;
    expect(s0.vMax).toBe(p.vPeak);
    expect(s0.rMax).toBe(p.rMax);
    // Heading 90°: toward −Z; the house straight ahead.
    expect(s0.velocity.z).toBeLessThan(0);
    const d = s0.center.z - b.z;
    expect(d).toBeGreaterThanOrEqual(2 * p.rMax);
    const roof = (c: { x: number; z: number }) => {
      const w = windAt({ x: b.x, y: b.roofHeight, z: b.z }, { ...s0, center: c }, "open");
      return Math.hypot(w.x, w.y, w.z);
    };
    expect(roof(s0.center)).toBeLessThan(mphToMs(50));
    if (d > 2 * p.rMax + 1e-6) expect(roof({ x: s0.center.x, z: s0.center.z - 10 })).toBeGreaterThanOrEqual(mphToMs(50));
    lab.advance(2);
    const s1 = lab.sim.snapshot.tornado;
    expect(s1.center.x).toBeCloseTo(s0.center.x, 9);
    expect(s0.center.z - s1.center.z).toBeCloseTo(p.translationSpeed * lab.sim.time, 6);
    expect(s1.vMax).toBe(p.vPeak);
    expect(s1.rMax).toBe(p.rMax);
    expect(lab.sim.snapshot.phase).toBe("mature");
    // Ends as far past as it started: then calm.
    const tEnd = (2 * d) / p.translationSpeed;
    expect(lab.sim.snapshot.lifetime).toBeCloseTo(tEnd, 6);
    lab.dispose();
    // A far track (never damaging): run past the end and check calm.
    const far = await createLab(setup({ model: "component" }), { kind: "pass", presetId: "ef2-cone", headingDeg: 0, offset: 2000, lifecycle: "mature" });
    const pf = preset("ef2-cone");
    const f0 = far.sim.snapshot.tornado;
    expect(far.sim.world.buildings[0]!.x - f0.center.x).toBeCloseTo(2 * pf.rMax, 6);
    expect(far.sim.world.buildings[0]!.z - f0.center.z).toBeCloseTo(2000, 6);
    far.advance(far.sim.snapshot.lifetime + 0.5);
    expect(far.sim.snapshot.phase).toBe("dissipated");
    expect(far.sim.snapshot.tornado.vMax).toBe(0);
    far.dispose();
    // In a neighborhood every house starts calm (they reach 130 m nearer the tornado): no house
    // fails in the first second.
    const hood = await createLab(setup({ model: "component", surroundings: "neighborhood" }), { kind: "pass", presetId: "ef5-extreme", headingDeg: 0, offset: 0, lifecycle: "mature" }, { passThrough: false });
    const h0 = hood.sim.snapshot.tornado;
    for (const hb of hood.sim.world.buildings) {
      const w = windAt({ x: hb.x, y: hb.roofHeight, z: hb.z }, h0, "suburban");
      expect(Math.hypot(w.x, w.y, w.z)).toBeLessThan(mphToMs(50));
    }
    hood.advance(1);
    expect(hood.sim.world.buildings.every((hb) => hb.dod === 0)).toBe(true);
    hood.dispose();
  });

  test("LAB-06: a full-lifecycle pass reaches its closest approach to the block at the middle of the mature stage", async () => {
    const p = preset("ef3-strong");
    const lab = await createLab(setup({ model: "component" }), { kind: "pass", presetId: "ef3-strong", headingDeg: 30, offset: 50, lifecycle: "full" });
    const s0 = lab.sim.snapshot.tornado;
    const v = { x: s0.velocity.x, z: s0.velocity.z };
    const sp = Math.hypot(v.x, v.z);
    // Closest approach of the straight track to the block center (origin).
    const tClosest = -(s0.center.x * v.x + s0.center.z * v.z) / (sp * sp);
    expect(tClosest).toBeCloseTo(p.tUp + p.tMature / 2, 6);
    const c = { x: s0.center.x + v.x * tClosest, z: s0.center.z + v.z * tClosest };
    expect(Math.hypot(c.x, c.z)).toBeCloseTo(50, 6);
    expect(lab.sim.snapshot.lifetime).toBeCloseTo(p.tUp + p.tMature + p.tRope, 9);
    lab.dispose();
  });
});

describe("Spec 13 lab: determinism", () => {
  test("LAB-07: same setup, wind and launches → same failures, impacts and final poses, with one detail engine or several", async () => {
    const run = async (k: number) => {
      const lab = await createLab(setup({ houses: 2 }), { kind: "steady", keys: [{ t: 0, mph: 160, dirDeg: 20 }] }, { detail: (_s, b) => createLocalBackend(b, k), passThrough: false });
      lab.launch({ source: "town", kind: "stud", house: 0, aim: { pane: 0 }, standoff: 3, speed: 30, t: 0.2 });
      lab.launch({ source: "town", kind: "osb", house: 1, aim: { wall: 1 }, standoff: 3, speed: 25, t: 0.3 });
      lab.advance(1.5);
      const r = lab.record();
      const poses = [...lab.sim.detail.houses.values()].map((h) => Array.from(h.poses).map((x) => x.toFixed(5)).join(","));
      const fails = lab.block.map((i) => lab.sim.world.buildings[i]!.detailFailures?.map((g) => `${g.label}:${g.count}`) ?? []);
      lab.dispose();
      return { failures: r.failures, impacts: r.impacts, poses, fails };
    };
    const a = await run(1);
    expect(a.failures.length).toBeGreaterThan(0);
    expect(a.impacts.length).toBeGreaterThan(0);
    expect(await run(1)).toEqual(a);
    expect(await run(2)).toEqual(a);
  }, 120000);
});

describe("Spec 13 lab: launcher and inspector", () => {
  test("LAB-08: a reference missile aimed at a pane hits it at the standard's mass and speed; presets match their standards; a stream launches at its rate, seeded", async () => {
    // ASTM E1996 Table 2 and ICC 500.
    const want: Record<string, [number, number]> = { "astm-a": [0.002, 39.6], "astm-b": [0.91, 15.3], "astm-c": [2.05, 12.2], "astm-d": [4.1, 15.3], "astm-e": [4.1, 24.4], "icc500-h": [6.8, 44.7], "icc500-v": [6.8, 30] };
    for (const m of REFERENCE_MISSILES) {
      expect([m.mass, m.speed]).toEqual(want[m.id]);
      expect(m.def.mass).toBe(m.mass);
    }
    for (const model of ["component", "detail"] as const) {
      for (const id of ["astm-b", "astm-e", "icc500-h"]) {
        const lab = await createLab(setup({ model }), calm, { passThrough: false });
        const m = REFERENCE_MISSILES.find((x) => x.id === id)!;
        const b = lab.sim.world.buildings[0]!;
        const pane = b.panes.findIndex((p) => b.panels[p.panel]!.face === 1);
        lab.fireMissile(id, 0, { pane });
        lab.advance(1.5);
        const hit = lab.record().impacts.find((i) => i.surface === "pane");
        expect(hit, `${model} ${id}`).toBeDefined();
        expect(hit!.index).toBe(pane);
        expect(hit!.mass).toBeCloseTo(m.mass, 6);
        // Arrives at the standard's speed. The record has the normal component: over the 10 m
        // stand-off the path arcs a few degrees (cos 10° = 0.985), and the hit is resolved on the
        // debris step before the crossing.
        expect(Math.abs(hit!.vn - m.speed) / m.speed).toBeLessThan(0.05);
        lab.dispose();
      }
    }
    // In wind too: the launch is solved in the wind blowing now (gusts held off here).
    {
      const lab = await createLab(setup({ model: "component", dispersion: false }), { kind: "steady", keys: [{ t: 0, mph: 60, dirDeg: 30 }] }, { passThrough: false });
      const b = lab.sim.world.buildings[0]!;
      const pane = b.panes.findIndex((p) => b.panels[p.panel]!.face === 3);
      lab.advance(0.5);
      lab.fireMissile("astm-e", 0, { pane });
      lab.advance(1.5);
      const hit = lab.record().impacts[0];
      expect(hit?.surface).toBe("pane");
      expect(hit?.index).toBe(pane);
      lab.dispose();
    }
    // A clicked point on the roof: the missile comes in square to the slope and hits the roof.
    {
      const lab = await createLab(setup({ model: "component" }), calm, { passThrough: false });
      const b = lab.sim.world.buildings[0]!;
      lab.fireMissile("icc500-h", 0, { point: { x: -3, y: 0.1 + b.wallHeight + b.roofRise * 0.5, z: -b.depth * 0.25 } });
      expect(() => lab.launch({ source: "town", kind: "stud", house: 0, aim: { point: { x: 0, y: 1, z: 0 } }, speed: 10 })).toThrow();
      lab.advance(1.5);
      const hit = lab.record().impacts[0];
      expect(hit?.surface).toBe("roof");
      expect(Math.abs(hit!.vn - 44.7) / 44.7).toBeLessThan(0.05);
      lab.dispose();
    }
    // Stream: rate × time launches, the same on every run.
    const stream = async () => {
      const lab = await createLab(setup({ model: "component" }), { kind: "steady", keys: [{ t: 0, mph: 90, dirDeg: 0 }] }, { passThrough: false });
      lab.stream({ kind: "shingle", rate: 12, face: "windward" });
      lab.advance(2);
      const out = lab.launcher.launched.map((l) => [l.time.toFixed(4), l.at.x.toFixed(4), l.at.y.toFixed(4), l.at.z.toFixed(4)]);
      // Starts in the 2–40 m band, upwind of the house (the wind blows toward +X).
      for (const l of lab.launcher.launched) {
        expect(l.at.y).toBeGreaterThanOrEqual(2);
        expect(l.at.y).toBeLessThanOrEqual(40);
        expect(l.at.x).toBeLessThan(0);
      }
      lab.dispose();
      return out;
    };
    const s1 = await stream();
    expect(Math.abs(s1.length - 24)).toBeLessThanOrEqual(1);
    expect(await stream()).toEqual(s1);
  }, 120000);

  test("LAB-09: the member inspector shows the engine's load, capacity and utilization; a failed connection shows its time and wind", async () => {
    const backends: ReturnType<typeof createLocalBackend>[] = [];
    const lab = await createLab(setup(), { kind: "steady", keys: [{ t: 0, mph: 120, dirDeg: 0 }] }, { detail: (_s, b) => (backends.push(createLocalBackend(b, 1)), backends.at(-1)!), passThrough: false });
    lab.advance(1);
    const h = backends[0]!.engines[0]!.houses.get(0)!;
    let checked = 0;
    for (const m of h.framing.members) {
      const info = lab.memberInfo(0, m.id)!;
      expect(info.kind).toBe(m.kind);
      for (const c of info.connections) {
        const con = h.framing.connections[c.id]!;
        expect(c.capacity).toBe(con.capacity);
        // Loads are those of the engine's last solve (float32 on the way).
        expect(c.load).toBeCloseTo(h.conLoad[c.id]!, 2);
        expect(c.utilization).toBeCloseTo(c.load / c.capacity, 9);
        if (c.load > 0) checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
    // Failed: time and wind as the engine reported them.
    const f = h.failures[0]!;
    expect(f).toBeDefined();
    const member = h.framing.connections[f.con]!.from;
    const info = lab.memberInfo(0, member)!;
    const c = info.connections.find((x) => x.id === f.con)!;
    expect(c.intact).toBe(false);
    expect(c.failed!.mph).toBeCloseTo(f.mph, 9);
    expect(c.failed!.load).toBeCloseTo(f.load, 9);
    expect(Math.abs(c.failed!.time - lab.sim.time)).toBeLessThan(1.1);
    lab.dispose();
  }, 60000);

  test("LAB-12: the lab's record exports as JSON that the tunnel's checks read unchanged", async () => {
    const lab = await createLab(setup(), calm);
    // The tunnel's window shot (town 2×4 at pane 0), fired in the lab.
    const shot = windowShot({ id: "town-detail", source: "town", model: "detail", path: "debris" });
    const l = shot.launches![0]!;
    lab.launch({ ...l });
    lab.advance(shot.seconds);
    const json = JSON.stringify(lab.record());
    const parsed = JSON.parse(json);
    expect(shot.check!(parsed)).toEqual([]);
    expect(Object.keys(parsed).sort()).toEqual(["checks", "failures", "final", "groundDips", "impacts", "launches", "lodged", "name", "ok", "passThrough", "perf", "problems", "samples", "seconds", "seed", "tracks"]);
    lab.dispose();
  });
});

describe("Spec 13 lab: replay frames", () => {
  test("LAB-15: a recording replays at any house and yaw in its frame; debris only is calm; no neighbors; deterministic", async () => {
    // A hand-made recording: two pieces, in the target frame.
    const rec: DebrisRecording = {
      version: 1, code: "test", seed: 3, dispersion: true, terrain: "open",
      target: { width: 14, depth: 11, yaw: 0, spec: {} },
      wind: { kind: "steady", keys: [{ t: 0, mph: 70, dirDeg: 0 }] },
      seconds: 3,
      pieces: [
        { t: 0.5, source: "town", kind: "shingle", mass: 1, dims: [1, 0.33, 0.005], represents: 1, pos: { x: -17, y: 6, z: 1 }, vel: { x: 20, y: -2, z: 1 }, q: [0, 0, 0, 1], liftRoll: 0.1, spin: 1, gust: { x: 0, y: 0, z: 0 }, stepPhase: 0 },
        { t: 1, source: "town", kind: "stud", mass: 4.5, dims: [2.4, 0.09, 0.04], represents: 1, pos: { x: -16, y: 2, z: -2 }, vel: { x: 18, y: 0, z: 0 }, q: [0, 0, 0, 1], stepPhase: 1 },
      ],
    };
    for (const [house, yawDeg] of [[0, 0], [3, 2], ["block", 0]] as const) {
      const lab = await createLab(setup({ houses: 4, surroundings: "neighborhood", model: "component", specs: [{ yaw: 0 }, {}, {}, { yaw: (yawDeg * Math.PI) / 180 }] }), calm, { replay: { recording: rec, house, wind: "recorded" } });
      // No neighbors in a replay.
      expect(lab.ring).toEqual([]);
      expect(lab.sim.world.buildings.length).toBe(4);
      const frameB = house === "block" ? { x: 0, z: 0, yaw: lab.block.reduce((a, i) => a + lab.sim.world.buildings[i]!.yaw, 0) / 4 } : lab.sim.world.buildings[house]!;
      const f = frameOf(frameB);
      const launches = replayLaunches(rec, frameB);
      lab.advance(1.2);
      expect(lab.launcher.launched.length).toBe(2);
      lab.launcher.launched.forEach((l, k) => {
        const back = f.toLocal(l.at);
        expect(back.x).toBeCloseTo(rec.pieces[k]!.pos.x, 9);
        expect(back.y).toBeCloseTo(rec.pieces[k]!.pos.y, 9);
        expect(back.z).toBeCloseTo(rec.pieces[k]!.pos.z, 9);
        const v = f.dirToLocal(l.vel);
        expect(v.x).toBeCloseTo(rec.pieces[k]!.vel.x, 9);
        expect(v.z).toBeCloseTo(rec.pieces[k]!.vel.z, 9);
        expect(l.time).toBeGreaterThanOrEqual(rec.pieces[k]!.t - 1e-9);
        expect(l.time).toBeLessThan(rec.pieces[k]!.t + 1 / 60);
      });
      expect(launches.length).toBe(2);
      // The recorded wind, turned with the receiving frame.
      expect(lab.sim.snapshot.tornado.tunnel!.dirDeg).toBeCloseTo((frameB.yaw * 180) / Math.PI, 9);
      lab.dispose();
    }
    // Debris only: zero wind throughout.
    const none = await createLab(setup({ model: "component" }), { kind: "steady", keys: [{ t: 0, mph: 150, dirDeg: 0 }] }, { replay: { recording: rec, house: 0, wind: "none" } });
    for (let i = 0; i < 4; i++) {
      none.advance(0.5);
      expect(none.sim.snapshot.tornado.tunnel!.u10).toBe(0);
    }
    none.dispose();
    // Deterministic.
    const run = async () => {
      const lab = await createLab(setup({ model: "component" }), calm, { replay: { recording: rec, house: 0, wind: "recorded" } });
      lab.advance(3);
      const r = lab.record();
      lab.dispose();
      return { impacts: r.impacts, tracks: r.tracks };
    };
    const a = await run();
    expect(a.impacts.length).toBeGreaterThan(0);
    expect(await run()).toEqual(a);
    // The capture box: footprint + 10 m, up to 30 m.
    expect(inCaptureBox({ width: 14, depth: 11 }, { x: 16.9, y: 29, z: 0 })).toBe(true);
    expect(inCaptureBox({ width: 14, depth: 11 }, { x: 17.1, y: 1, z: 0 })).toBe(false);
    expect(inCaptureBox({ width: 14, depth: 11 }, { x: 0, y: 30.5, z: 0 })).toBe(false);
  }, 60000);
});

describe("Spec 13 v0.4: tornado settings and member missiles", () => {
  test("LAB-16: a pass's params are the preset's with the given ones over them, heading and curve the pass's own, for both lifecycles", async () => {
    const custom = { vPeak: 60, rMax: 200, translationSpeed: 20, updraftMax: 10, cloudBase: 700, rotation: -1 as const, heading: 123, turnRate: 5 };
    const mature = await createLab(setup({ model: "component" }), { kind: "pass", presetId: "ef3-strong", headingDeg: 30, offset: 0, lifecycle: "mature", params: custom });
    const s0 = mature.sim.snapshot.tornado;
    expect(s0.vMax).toBe(60);
    expect(s0.rMax).toBe(200);
    expect(Math.hypot(s0.velocity.x, s0.velocity.z)).toBeCloseTo(20, 9);
    expect(s0.updraftMax).toBe(10);
    expect(s0.rotation).toBe(-1);
    expect(mature.sim.snapshot.cloudBase).toBe(700);
    // Heading and curve are the pass's own.
    expect(mature.sim.params.heading).toBe(30);
    expect(mature.sim.params.turnRate).toBe(0);
    // Still mature throughout, calm at the start.
    const b = mature.sim.world.buildings[0]!;
    const w = windAt({ x: b.x, y: b.roofHeight, z: b.z }, s0, "open");
    expect(Math.hypot(w.x, w.y, w.z)).toBeLessThan(mphToMs(50));
    mature.advance(1);
    expect(mature.sim.snapshot.tornado.vMax).toBe(60);
    mature.dispose();
    // Full lifecycle with custom times: closest approach mid-mature.
    const full = await createLab(setup({ model: "component" }), { kind: "pass", presetId: "ef3-strong", headingDeg: 0, offset: 0, lifecycle: "full", params: { tUp: 10, tMature: 50, tRope: 20, translationSpeed: 15 } });
    const f0 = full.sim.snapshot.tornado;
    expect(full.sim.snapshot.lifetime).toBeCloseTo(80, 9);
    const sp = Math.hypot(f0.velocity.x, f0.velocity.z);
    expect(-(f0.center.x * f0.velocity.x + f0.center.z * f0.velocity.z) / (sp * sp)).toBeCloseTo(35, 6);
    full.dispose();
  });

  test("LAB-17: firing a member launches the donor's next unused member of that kind in the lab's group; with none left the shot is refused", async () => {
    const backends: ReturnType<typeof createLocalBackend>[] = [];
    const lab = await createLab(setup({ donors: true }), calm, { passThrough: false, detail: (_s, b) => (backends.push(createLocalBackend(b, 1)), backends[0]!) });
    lab.advance(0.2);
    const b = lab.sim.world.buildings[0]!;
    const pane = b.panes.findIndex((p) => b.panels[p.panel]!.face === 3);
    const before = lab.membersLeft("roofSheet");
    expect(before).toBeGreaterThan(5);
    lab.fireMember("roofSheet", 0, { pane }, 20);
    lab.fireMember("roofSheet", 0, { pane }, 20);
    expect(lab.membersLeft("roofSheet")).toBe(before - 2);
    lab.advance(0.1);
    const shots = lab.launcher.launched.filter((l) => l.source === "detail-same");
    expect(shots.length).toBe(2);
    expect(shots[0]!.members).not.toEqual(shots[1]!.members);
    // In the lab's physics group, with the lab houses.
    const eng = backends[0]!.engines[0]!;
    expect(eng.worldFor(lab.donors.same!)).toBe(eng.worldFor(0));
    // It flies toward the house: the member is now near it, far from its donor.
    lab.advance(1);
    const d = lab.sim.detail.houses.get(lab.donors.same!)!;
    const m = shots[0]!.members![0]!;
    const pos = { x: d.poses[m * 7]!, z: d.poses[m * 7 + 2]! };
    expect(Math.hypot(pos.x - b.x, pos.z - b.z)).toBeLessThan(15);
    // Exhausted: refused, and the run goes on.
    const fascia = lab.membersLeft("fascia");
    for (let i = 0; i < fascia; i++) lab.fireMember("fascia", 0, { pane }, 5);
    expect(() => lab.fireMember("fascia", 0, { pane }, 5)).toThrow();
    lab.advance(0.2);
    lab.dispose();
  }, 60000);
});

describe("Spec 13 v0.6: neighbor density", () => {
  test("LAB-18: density d gives d × the houses per area of the town's pattern; at 1 the town's lots; no overlaps, none in a lab lot", async () => {
    const { ringSpecs } = await import("../../src/sim/lab");
    const block = labBlockSpecs({ houses: 4, cls: "standard", seed: 3 });
    const base = ringSpecs(3, block, 1);
    // Density 1 is the unscaled ring.
    expect(ringSpecs(3, block)).toEqual(base);
    // Rotated-rectangle overlap (separating axes), with a 0.3 m gap allowed.
    type R = { x: number; z: number; yaw: number; width: number; depth: number };
    const axes = (r: R) => [
      { x: Math.cos(r.yaw), z: -Math.sin(r.yaw) },
      { x: Math.sin(r.yaw), z: Math.cos(r.yaw) },
    ];
    const extent = (r: R, a: { x: number; z: number }) => {
      const [u, v] = axes(r);
      return (Math.abs(u!.x * a.x + u!.z * a.z) * r.width) / 2 + (Math.abs(v!.x * a.x + v!.z * a.z) * r.depth) / 2;
    };
    const overlap = (p: R, q: R) =>
      [...axes(p), ...axes(q)].every((a) => Math.abs((q.x - p.x) * a.x + (q.z - p.z) * a.z) < extent(p, a) + extent(q, a) - 0.3);
    for (const d of [0.25, 0.5, 1, 1.5, 1.75]) {
      const ring = ringSpecs(3, block, d);
      // Houses per area relative to the town's: the ring reaches the same distance at every density.
      const ratio = ring.length / base.length;
      expect(Math.abs(ratio / d - 1), `density ${d}: ${ring.length} vs ${base.length}`).toBeLessThanOrEqual(0.15);
      const all = [...ring, ...block];
      for (let i = 0; i < all.length; i++)
        for (let j = i + 1; j < all.length; j++) expect(overlap(all[i]!, all[j]!), `density ${d}: houses ${i} and ${j}`).toBe(false);
      for (const h of ring)
        for (const b of block) {
          const ex = Math.max(0, Math.abs(h.x - b.x) - LAB.lotSpacing / 2);
          const ez = Math.max(0, Math.abs(h.z - b.z) - LAB.lotSpacing / 2);
          expect(Math.hypot(ex, ez)).toBeGreaterThan(Math.hypot(h.width, h.depth) / 2);
        }
    }
    // The lab builds it.
    const lab = await createLab(setup({ houses: 4, surroundings: "neighborhood", model: "component", density: 0.5 }), calm, { passThrough: false });
    expect(lab.ring.length).toBe(ringSpecs(3, labBlockSpecs({ houses: 4, cls: "standard", seed: 3 }), 0.5).length);
    lab.dispose();
  });
});

describe("Spec 13 v0.7: lab inspection", () => {
  test("LAB-19: the stress view is offered exactly for lab houses, and colors their attached members by highest connection utilization", async () => {
    const { stressOffered, stressStyle, utilColor, memberUtilization } = await import("../../src/ui/stressView");
    const lab = await createLab(setup({ houses: 2, surroundings: "neighborhood", donors: true }), { kind: "steady", keys: [{ t: 0, mph: 110, dirDeg: 0 }] }, { passThrough: false });
    lab.advance(1);
    const view = lab.sim.detail;
    // Offered for lab houses only: not the neighbors, not the donors.
    expect(lab.block.every((i) => stressOffered(view, lab.block, i))).toBe(true);
    expect(lab.ring.some((i) => stressOffered(view, lab.block, i))).toBe(false);
    expect(stressOffered(view, lab.block, lab.donors.same!)).toBe(false);
    // Nothing shown, nothing styled.
    expect(stressStyle(view, lab.block, new Set(), false, new Set())).toBeNull();
    // House 0 in the view: each attached member's color is its utilization's.
    const style = stressStyle(view, lab.block, new Set([0]), false, new Set())!;
    const h = view.houses.get(0)!;
    const ins = view.inspection.get(0)!;
    let colored = 0;
    for (const m of h.framing.members) {
      const s = style(0, m.id);
      if (ins.attached[m.id] !== 1) {
        expect(s).toBeNull();
        continue;
      }
      let u = 0;
      for (const c of h.framing.supportsOf[m.id]!) if (h.framing.connections[c]!.capacity > 0) u = Math.max(u, ins.loads[c]! / h.framing.connections[c]!.capacity);
      expect(memberUtilization(view, 0, m.id)).toBeCloseTo(u, 12);
      expect(s!.color).toBe(utilColor(u));
      colored++;
    }
    expect(colored).toBeGreaterThan(100);
    // The other lab house keeps its own colors.
    for (const m of view.houses.get(1)!.framing.members.slice(0, 50)) expect(style(1, m.id)).toBeNull();
    // The scale: green at 0, yellow at 0.5, red at 1 and beyond.
    expect(utilColor(0)).toBe(0x00ff28);
    expect(utilColor(0.5)).toBe(0xffff28);
    expect(utilColor(1)).toBe(0xff0028);
    expect(utilColor(3)).toBe(0xff0028);
    lab.dispose();
  }, 60000);
});

describe("Spec 13 v0.9: construction mix", () => {
  test("LAB-20: w weak, s standard and t strong houses fill the grid in that order, capped at the limit; a house depends only on seed, place and class", async () => {
    const { blockClasses } = await import("../../src/sim/lab");
    const specs = labBlockSpecs({ houses: 1, cls: "standard", seed: 3, mixCounts: { weak: 2, standard: 3, strong: 4 } });
    expect(specs.length).toBe(9);
    expect(specs.map((s) => s.cls)).toEqual(["weak", "weak", "standard", "standard", "standard", "strong", "strong", "strong", "strong"]);
    // Capped at the lab's limit.
    expect(blockClasses({ houses: 1, cls: "standard", mixCounts: { weak: 10, standard: 10, strong: 10 } }).length).toBe(LAB.maxHouses);
    // Same lot, same house whatever its class (only the class differs).
    const allStd = labBlockSpecs({ houses: 9, cls: "standard", seed: 3 });
    specs.forEach((s, i) => expect({ ...s, cls: "standard" }).toEqual(allStd[i]));
    // The lab builds it, with each class's capacities.
    const lab = await createLab({ ...setup({ model: "component" }), mixCounts: { weak: 1, standard: 1, strong: 1 } }, calm, { passThrough: false });
    expect(lab.block.map((i) => lab.sim.world.buildings[i]!.cls)).toEqual(["weak", "standard", "strong"]);
    lab.dispose();
  });
});
