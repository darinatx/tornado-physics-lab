import { describe, expect, test } from "vitest";
import { AIR_DENSITY, GRAVITY } from "../../src/config/atmosphere";
import { DEBRIS, DEBRIS_KINDS, SPAWN_TABLE } from "../../src/config/debris";
import type { DebrisKind } from "../../src/config/debris";
import { DebrisField } from "../../src/core/debris/field";
import { liftForce, restingForces, snag, stepPiece, terminalSpeed, wakeIfForced } from "../../src/core/debris/piece";
import type { Piece } from "../../src/core/debris/piece";
import type { FailureRecord } from "../../src/core/damage/types";
import { createRng } from "../../src/sim/rng";
import { baseState } from "../helpers";
import { exactHouse, median } from "../houseHelpers";
import { PRESETS } from "../../src/config/presets";
import { createSim } from "../../src/sim/loop";

function piece(kind: DebrisKind, y = 100, o: Partial<Piece> = {}): Piece {
  return {
    id: 1, kind, pos: { x: 0, y, z: 0 }, vel: { x: 0, y: 0, z: 0 }, q: [0, 0, 0, 1], spin: 1,
    resting: false, snagged: false, snagDir: null, bornAt: 0, restedAt: Infinity, represents: 1, color: 0, sourceId: 0,
    maxWindMet: 0, liftOn: true, ...o,
  };
}
const rec = (part: FailureRecord["part"], face?: number): FailureRecord => ({ part, face, time: 1, load: 1, capacity: 0, mph: 100 });
const still = { x: 0, y: 0, z: 0 };

describe("Spec 04 — debris", () => {
  test("DEB-11: resting pieces left behind move to the permanent debris field", () => {
    const f = new DebrisField(8);
    f.spawnFrom(exactHouse(), rec("roofStructure"));
    const n = f.pieces.length;
    for (const p of f.pieces) {
      p.resting = true;
      p.pos.y = 0;
    }
    // Tornado far away: everything settles, frees the pool, and stays put.
    const away = baseState({ center: { x: 5000, z: 0 }, rMax: 150 });
    const before = f.pieces.map((p) => ({ ...p.pos }));
    f.step(1 / 60, away, "open", true, 0);
    expect(f.pieces.length).toBe(0);
    expect(f.settled.length).toBe(n);
    expect(f.stats.settled).toBe(n);
    expect(f.settled.map((p) => p.pos)).toEqual(before);
    // Near the tornado, resting pieces stay in the active pool.
    const g = new DebrisField(8);
    g.spawnFrom(exactHouse(), rec("roofCover"));
    for (const p of g.pieces) p.resting = true;
    g.step(1 / 60, baseState({ vMax: 1 }), "open", false, 0);
    expect(g.settled.length).toBe(0);
  });


  test("DEB-01: terminal speed in still air", () => {
    for (const kind of Object.keys(DEBRIS_KINDS) as DebrisKind[]) {
      const p = piece(kind, 1e6, { liftOn: false });
      for (let i = 0; i < 60 * 120; i++) stepPiece(p, still, 1 / 60);
      const k = DEBRIS_KINDS[kind];
      const vt = Math.sqrt((2 * k.mass * GRAVITY) / (AIR_DENSITY * k.cda));
      expect(terminalSpeed(kind)).toBeCloseTo(vt, 9);
      expect(Math.abs(-p.vel.y / vt - 1), kind).toBeLessThan(0.01);
    }
  });

  test("DEB-02: quadratic-drag solution in uniform wind (gravity cancelled)", () => {
    const kind: DebrisKind = "chunk";
    const k = DEBRIS_KINDS[kind];
    const U = 50;
    const k0 = (0.5 * AIR_DENSITY * k.cda) / k.mass;
    // Cancel gravity with an equal upward wind-free trick: integrate horizontally only by
    // holding y high and resetting vertical velocity each step (gravity doesn't couple when v.y = 0).
    const p = piece(kind, 1e6, { liftOn: false });
    const dt = 1 / 60;
    for (let i = 1; i <= 600; i++) {
      p.vel.y = 0;
      stepPiece(p, { x: U, y: 0, z: 0 }, dt);
      if (i % 60 === 0) {
        const t = i * dt;
        const exact = U - U / (1 + U * k0 * t);
        expect(Math.abs(p.vel.x / exact - 1), `t=${t}`).toBeLessThan(0.01);
      }
    }
  });

  test("DEB-03: lift carries a sheet farther and is perpendicular to the relative wind", () => {
    const fly = (liftOn: boolean) => {
      const p = piece("osb", 30, { liftOn, spin: 1 });
      let t = 0;
      while (p.pos.y > 0 && t < 120) {
        stepPiece(p, { x: 40, y: 0, z: 0 }, 1 / 60);
        t += 1 / 60;
      }
      return p.pos.x;
    };
    expect(fly(true)).toBeGreaterThan(fly(false) * 1.2);
    for (const rel of [{ x: 30, y: 5, z: -10 }, { x: -3, y: -20, z: 8 }, { x: 0, y: 2, z: 40 }]) {
      const L = liftForce(piece("shingle"), rel);
      expect(Math.abs(L.x * rel.x + L.y * rel.y + L.z * rel.z)).toBeLessThan(1e-9 * Math.hypot(L.x, L.y, L.z) * Math.hypot(rel.x, rel.y, rel.z) + 1e-9);
    }
    expect(liftForce(piece("stud"), { x: 30, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
  });

  test("DEB-04: ground contact — never below ground; hold, slide, lift off", () => {
    const p = piece("osb", 20);
    for (let i = 0; i < 600; i++) {
      stepPiece(p, { x: 10, y: -5, z: 3 }, 1 / 60);
      expect(p.pos.y).toBeGreaterThanOrEqual(0);
    }
    // Hold: drag below μ_s·(mg − up).
    const hold = piece("osb", 0, { resting: true });
    const weak = { x: 3, y: 0, z: 0 };
    const f = restingForces(hold, weak);
    expect(f.drag).toBeLessThan(DEBRIS.holdFriction * (f.weight - f.up));
    expect(wakeIfForced(hold, weak)).toBe(false);
    // Slide: strong horizontal wind.
    const slide = piece("stud", 0, { resting: true });
    const gust = { x: 40, y: 0, z: 0 };
    const g = restingForces(slide, gust);
    expect(g.drag).toBeGreaterThan(DEBRIS.holdFriction * (g.weight - g.up));
    expect(wakeIfForced(slide, gust)).toBe(true);
    expect(slide.pos.y).toBe(0);
    // Lift off: a sheet's suction lift beats its weight.
    const sheet = piece("osb", 0, { resting: true });
    const hurricane = { x: 60, y: 0, z: 0 };
    expect(restingForces(sheet, hurricane).up).toBeGreaterThan(restingForces(sheet, hurricane).weight);
    expect(wakeIfForced(sheet, hurricane)).toBe(true);
    expect(sheet.pos.y).toBeGreaterThan(0);
  });

  test("DEB-05: failures spawn the specified pieces at the part's location", () => {
    const b = exactHouse();
    const field = new DebrisField(1);
    for (const part of ["roofCover", "roofStructure", "exteriorWalls", "garage"] as const) {
      const before = field.pieces.length;
      field.spawnFrom(b, rec(part));
      const added = field.pieces.slice(before);
      const expected = SPAWN_TABLE[part].reduce((a, [, n]) => a + n, 0);
      expect(added.length).toBe(expected);
      for (const [kind, n] of SPAWN_TABLE[part]) expect(added.filter((p) => p.kind === kind).length).toBe(n);
      for (const p of added) {
        expect(Math.abs(p.pos.x - b.x)).toBeLessThanOrEqual(b.width / 2 + 0.11);
        expect(Math.abs(p.pos.z - b.z)).toBeLessThanOrEqual(b.depth / 2 + 0.11);
        if (part === "roofCover" || part === "roofStructure") expect(p.pos.y).toBeGreaterThanOrEqual(b.wallHeight);
        else expect(p.pos.y).toBeLessThanOrEqual(b.wallHeight);
        expect(p.represents).toBeGreaterThanOrEqual(1);
      }
    }
    // Window shards sit on their face (face 0 = local +X, yaw 0).
    const before = field.pieces.length;
    field.spawnFrom(b, rec("windows", 0));
    for (const p of field.pieces.slice(before)) expect(p.pos.x).toBeCloseTo(b.x + b.width / 2 + 0.1, 6);
    // Deterministic.
    const a = new DebrisField(9);
    const c = new DebrisField(9);
    a.spawnFrom(b, rec("roofStructure"));
    c.spawnFrom(b, rec("roofStructure"));
    expect(a.pieces).toEqual(c.pieces);
  });

  test("DEB-06: pool cap, recycling the oldest resting piece, counted skips", () => {
    const b = exactHouse();
    const field = new DebrisField(2, 20);
    for (let i = 0; i < 5; i++) field.spawnFrom(b, rec("roofCover")); // 40 requested
    expect(field.pieces.length).toBe(20);
    expect(field.stats.skipped).toBe(20);
    // Rest two pieces; the older one is recycled first.
    field.pieces[3]!.resting = true;
    field.pieces[3]!.restedAt = 10;
    field.pieces[7]!.resting = true;
    field.pieces[7]!.restedAt = 5;
    const oldId = field.pieces[7]!.id;
    field.spawnFrom(b, rec("windows", 1)); // 4 shards: 2 recycle, 2 skip
    expect(field.pieces.length).toBe(20);
    expect(field.pieces.some((p) => p.id === oldId)).toBe(false);
    expect(field.stats.skipped).toBe(22);
  });

  test("DEB-07: no piece outruns the fastest wind it met plus its terminal speed (+20%)", () => {
    const s = baseState({ vMax: 75, rMax: 200, velocity: { x: 15, z: 0 } });
    const field = new DebrisField(5);
    const rng = createRng(5);
    for (let i = 0; i < 40; i++) {
      const b = exactHouse();
      b.x = (rng() - 0.5) * 300;
      b.z = (rng() - 0.5) * 300;
      field.spawnFrom(b, rec(i % 2 ? "roofStructure" : "exteriorWalls"));
    }
    for (let i = 0; i < 60 * 40; i++) {
      field.step(1 / 60, s, "open", i % 2 === 0, i / 60, 500);
      if (i % 30 !== 0) continue;
      for (const p of field.pieces) {
        const v = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
        expect(v).toBeLessThanOrEqual(1.2 * (p.maxWindMet + terminalSpeed(p.kind)) + 1e-6);
      }
    }
  });

  test("DEB-08: same seed and failures → identical trajectories", () => {
    const run = () => {
      const s = baseState({ vMax: 60, velocity: { x: 12, z: 0 } });
      const f = new DebrisField(3);
      f.spawnFrom(exactHouse(), rec("roofStructure"));
      for (let i = 0; i < 600; i++) f.step(1 / 60, s, "open", i % 2 === 0, i / 60, 500);
      return f.pieces.map((p) => [p.pos, p.vel, p.q, p.resting]);
    };
    expect(run()).toEqual(run());
  });

  test("DEB-09: pieces above the cloud base are removed as lofted", () => {
    const f = new DebrisField(4);
    f.spawnFrom(exactHouse(), rec("roofCover"));
    const s = baseState({ vMax: 0, updraftMax: 0 });
    // Pieces just under a 320 m cloud base, rising fast: one short step carries them through.
    for (const p of f.pieces) {
      p.pos.y = 319.9;
      p.vel.y = 50;
    }
    f.step(0.01, s, "open", false, 0, 320);
    expect(f.pieces.length).toBe(0);
    expect(f.stats.lofted).toBe(8);
  });

  test("DEB-10: snagging at the mean free path, and snagged pieces hold harder", () => {
    // Slide many stud pieces through a steady strong wind and measure the distance to snag.
    const s = baseState({ vMax: 0, updraftMax: 0, velocity: { x: 0, z: 0 } });
    const f = new DebrisField(6, 4000);
    const b = exactHouse({}, 0);
    for (let i = 0; i < 400; i++) f.spawnFrom(b, rec("allWalls"));
    const studs = f.pieces.filter((p) => p.kind === "stud");
    for (const p of f.pieces) {
      p.pos.y = 0;
      p.vel = { x: 8, y: 0, z: 0 };
    }
    // Zero wind: pieces coast to a stop or snag. Keep them sliding at 8 m/s to measure λ.
    let snagged = 0;
    let distance = 0;
    for (let i = 0; i < 2000; i++) {
      for (const p of studs) if (!p.resting) p.vel = { x: 8, y: 0, z: 0 };
      f.step(1 / 60, s, "open", false, i / 60);
      distance += studs.filter((p) => !p.resting).length * 8 / 60;
    }
    snagged = studs.filter((p) => p.snagged).length;
    const lambda = distance / snagged;
    expect(Math.abs(lambda / DEBRIS.snagDistance.open - 1)).toBeLessThan(0.1);

    // A snagged piece is pinned while the wind pushes it into its obstacle...
    const p = piece("stud", 0, { vel: { x: 5, y: 0, z: 0 } });
    snag(p);
    const into = { x: 40, y: 0, z: 0 };
    const rf = restingForces(p, into);
    expect(rf.drag).toBeGreaterThan(DEBRIS.holdFriction * (rf.weight - rf.up)); // would slide if free
    expect(wakeIfForced(p, into)).toBe(false);
    // ...and released once the wind swings around to pull it back.
    expect(wakeIfForced(p, { x: -40, y: 0, z: 5 })).toBe(true);
    expect(p.snagged).toBe(false);
  });
});
