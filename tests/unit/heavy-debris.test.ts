import { describe, expect, test } from "vitest";
import { HEAVY, sheet } from "../../src/config/debris";
import { IMPACT } from "../../src/config/impacts";
import { MS_PER_MPH } from "../../src/config/units";
import type { Building } from "../../src/core/damage/types";
import { DebrisField } from "../../src/core/debris/field";
import type { Piece } from "../../src/core/debris/piece";
import type { TornadoState } from "../../src/core/wind/types";
import { HeavyDebris } from "../../src/sim/heavyDebris";
import { exactHouse } from "../houseHelpers";

const DT = 1 / 60;

/** A uniform wind (the tunnel's flow), the "tornado" centered here with a huge radius. */
function air(mph: number, dirDeg = 0, far = false): TornadoState {
  return {
    center: { x: far ? 1e5 : 0, z: 0 },
    velocity: { x: 0, z: 0 },
    vMax: 1,
    rMax: far ? 1 : 1e6,
    alpha: 0.6,
    inflowRatio: 0,
    inflowDepth: 50,
    updraftMax: 0,
    overshoot: 1,
    zPeak: 20,
    rotation: 1,
    tunnel: { u10: mph * MS_PER_MPH, dirDeg, w: 0, deficit: 0 },
  };
}

let nextId = 1;
/** A 4 × 2.4 m wall panel, 15 cm thick, 290 kg, lying flat (box X length, Y thickness, Z width). */
function panel(x: number, y: number, z: number, vel = { x: 0, y: 0, z: 0 }, sourceId = -1): Piece {
  return {
    id: nextId++,
    kind: "wallPanel",
    def: sheet("Wall panel", 4, 2.4, 0.15, 290),
    pos: { x, y, z },
    vel: { ...vel },
    q: [0, 0, 0, 1],
    spin: 1,
    resting: false,
    snagged: false,
    snagDir: null,
    bornAt: 0,
    restedAt: Infinity,
    represents: 1,
    color: 0,
    sourceId,
    maxWindMet: 0,
    liftOn: true,
    liftRoll: 0,
    gust: { x: 0, y: 0, z: 0 },
    rigid: true,
  };
}

const NOBODY = { id: -1, x: 0, z: 0 } as Building;

function run(h: HeavyDebris, s: TornadoState, seconds: number, t0 = 0): number {
  let t = t0;
  for (let i = 0; i < Math.round(seconds / DT); i++) h.step(s, "open", (t += DT));
  return t;
}

describe("Spec 04 v2.0 — heavy pieces as rigid bodies", () => {
  test("DEB-22: heavy pieces are rigid boxes that land and stack; light ones stay on the point model", () => {
    const h = new HeavyDebris([], () => [], DT);
    const a = panel(0, 1, 0);
    const b = panel(0.3, 2, 0.2);
    h.take(a, NOBODY, 0);
    h.take(b, NOBODY, 0);
    run(h, air(0), 4);
    // Lying on the ground, and the second one on the first (half a thickness more each).
    expect(a.pos.y).toBeCloseTo(0.075, 1);
    expect(b.pos.y).toBeCloseTo(0.225, 1);
    expect(a.resting && b.resting).toBe(true);
    h.dispose();

    // The debris field hands only heavy one-object pieces to the sink.
    const field = new DebrisField(1);
    const taken: Piece[] = [];
    field.heavy = { take: (p) => taken.push(p) };
    const house = exactHouse();
    field.spawnFrom(house, { part: "wallPanel", index: 0, time: 0, load: 3000, capacity: 1000, mph: 150, sign: 1, wind: { x: 60, y: 0, z: 0 } });
    field.spawnFrom(house, { part: "siding", index: 1, time: 0, load: 3000, capacity: 1000, mph: 150, sign: 1, wind: { x: 60, y: 0, z: 0 } });
    expect(taken.length).toBe(1);
    expect(taken[0]!.def.mass).toBeGreaterThanOrEqual(HEAVY.minKg);
    expect(taken[0]!.rigid).toBe(true);
    expect(field.pieces.filter((p) => !p.rigid).every((p) => p.def.mass < HEAVY.minKg || p.represents > 1)).toBe(true);
  });

  test("DEB-23: a heavy piece stops at a standing wall and hits it; its own house's walls let it go at first, its own slab doesn't", () => {
    const house = exactHouse();
    const hx = house.width / 2;
    const h = new HeavyDebris([house], () => [house], DT);
    // Thrown at the +X end wall (face 0) from 6 m out.
    const p = panel(hx + 6, 1.6, 0, { x: -15, y: 0, z: 0 });
    h.take(p, NOBODY, 0);
    run(h, air(0), 2);
    expect(p.pos.x).toBeGreaterThan(hx);
    const hits = h.hits.filter((x) => x.house === 0);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.plane).toBe(0);
    expect(hits[0]!.vn).toBeGreaterThan(3);
    h.dispose();

    // Its own house: out through the end wall it tore from, without a hit.
    const own = new HeavyDebris([house], () => [house], DT);
    const q = panel(hx - 1.5, 1.6, 0, { x: 12, y: 0, z: 0 });
    own.take(q, house, 0);
    run(own, air(0), 1);
    expect(q.pos.x).toBeGreaterThan(hx + 1);
    expect(own.hits.length).toBe(0);
    // Its own slab holds it up.
    const r = panel(0, 1.2, 0);
    own.take(r, house, 1);
    run(own, air(0), 3, 1);
    expect(r.pos.y).toBeCloseTo(IMPACT.slabTop + 0.075, 1);
    own.dispose();
  });

  test("DEB-25: a resting piece wakes only for wind that can move it, retires once the tornado has gone, and runs the same every time", () => {
    const poses = () => {
      // A wall panel standing on its 2.4 m edge, leaning back against a house's +X end wall; the
      // wind blows away from the wall, onto its face.
      const house = exactHouse();
      const hx = house.width / 2;
      const h = new HeavyDebris([house], () => [house], DT);
      const p = panel(hx + 0.35, 1.3, 0);
      // Box X (length) along world Z, Y (thickness) along world X, Z (width) up; top tipped 5° toward the wall.
      const perm: [number, number, number, number] = [-0.5, -0.5, -0.5, 0.5];
      const a = (5 * Math.PI) / 180;
      const tip: [number, number, number, number] = [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
      const mul = (x: number[], y: number[]): [number, number, number, number] => [
        x[3]! * y[0]! + x[0]! * y[3]! + x[1]! * y[2]! - x[2]! * y[1]!,
        x[3]! * y[1]! - x[0]! * y[2]! + x[1]! * y[3]! + x[2]! * y[0]!,
        x[3]! * y[2]! + x[0]! * y[1]! - x[1]! * y[0]! + x[2]! * y[3]!,
        x[3]! * y[3]! - x[0]! * y[0]! - x[1]! * y[1]! - x[2]! * y[2]!,
      ];
      p.q = mul(tip, perm);
      h.take(p, NOBODY, 0);
      let t = run(h, air(0), 4);
      expect(p.resting).toBe(true);
      expect(p.pos.y).toBeGreaterThan(1); // still standing, leaning on the wall
      const at = { ...p.pos };
      // A light wind can't move 290 kg.
      t = run(h, air(10), 2, t);
      expect(p.resting).toBe(true);
      expect(Math.hypot(p.pos.x - at.x, p.pos.z - at.z)).toBeLessThan(0.01);
      // 150 mph on its face does.
      t = run(h, air(150), 3, t);
      expect(Math.hypot(p.pos.x - at.x, p.pos.z - at.z)).toBeGreaterThan(1);
      // Calm, tornado far away: it comes to rest and is retired to the debris field.
      t = run(h, air(0, 0, true), 8, t);
      expect(p.rigid).toBe(false);
      expect(p.resting).toBe(true);
      expect(h.count).toBe(0);
      h.dispose();
      return [p.pos.x, p.pos.y, p.pos.z, ...p.q];
    };
    expect(poses()).toEqual(poses());
  });
});
