import { describe, expect, test } from "vitest";
import { HEAVY, sheet } from "../../src/config/debris";
import { IMPACT } from "../../src/config/impacts";
import { MS_PER_MPH } from "../../src/config/units";
import type { Building } from "../../src/core/damage/types";
import { DebrisField } from "../../src/core/debris/field";
import { overSlab } from "../../src/core/impact/envelope";
import type { Piece } from "../../src/core/debris/piece";
import type { Vec3 } from "../../src/core/math/vec";
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
      // Same id each run: it seeds the body's snag draws (Spec 04 v2.4).
      p.id = 4242;
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

describe("Spec 04 v2.1 — heavy debris beside the sim, at a fixed lag", () => {
  test("DEB-26: same heavy-piece poses and house damage in-process or lagging by a varying amount; never more than 8 steps ahead", async () => {
    const { createSim } = await import("../../src/sim/loop");
    const { createDeferredHeavy } = await import("../../src/sim/heavyBackend");
    const { QUICK_PASS } = await import("../harness/runPassthrough");
    const { createRng } = await import("../../src/sim/rng");
    const T = 5;
    const run = (deferred: boolean) => {
      let backend: ReturnType<typeof createDeferredHeavy> | null = null;
      const sim = createSim(deferred ? { heavy: (_s, b, dt) => (backend = createDeferredHeavy(b, dt)) } : {}, 3, QUICK_PASS);
      const rng = createRng(7);
      let maxPending = 0;
      let frames = 0;
      while (sim.time < T - 1e-9) {
        // Never past T, so both runs are compared at the same sim time (a lagging frame
        // otherwise overshoots by up to a frame).
        sim.advance(Math.min(1 / 30, T - sim.time));
        frames++;
        const b = backend as ReturnType<typeof createDeferredHeavy> | null;
        if (b) {
          maxPending = Math.max(maxPending, b.pending);
          // The worker gets 0–3 steps done per frame, at random.
          b.run(Math.floor(rng() * 4));
        }
      }
      const pieces = sim.debris.pieces.filter((p) => p.def.mass >= HEAVY.minKg && p.represents === 1);
      return {
        time: sim.time,
        maxPending,
        frames,
        heavy: pieces.length,
        poses: JSON.stringify(pieces.map((p) => [p.pos.x, p.pos.y, p.pos.z, ...p.q])),
        damage: sim.world.buildings.map((b) => b.dod).join(""),
      };
    };
    const a = run(false);
    const b = run(true);
    expect(a.heavy).toBeGreaterThan(20);
    // It did lag (the sim had to wait for it) and never ran more than 8 steps ahead.
    expect(b.frames).toBeGreaterThan(a.frames);
    expect(b.maxPending).toBeLessThanOrEqual(HEAVY.lagSteps + 1);
    expect(b.time).toBeCloseTo(a.time, 9);
    expect(b.heavy).toBe(a.heavy);
    expect(b.poses).toBe(a.poses);
    expect(b.damage).toBe(a.damage);
  }, 60_000);
});

describe("Spec 04 v2.2 — far pieces at 30 Hz", () => {
  test("DEB-27: far from the core, pieces stepped every other step end up where they do stepped every step", async () => {
    const { DEBRIS } = await import("../../src/config/debris");
    const flight = (farRmax: number) => {
      const field = new DebrisField(5);
      field.farRmax = farRmax;
      // The tornado 2 km away; the pieces sit in a uniform 40 m/s wind (the tunnel flow).
      const s = { ...air(90), center: { x: -2000, z: 0 }, rMax: 300 };
      for (let i = 0; i < 200; i++) field.launch("stud", { x: i * 0.5, y: 30, z: 0 }, { x: 0, y: 0, z: 0 }, [0, 0, 0, 1], 0);
      const dt = DEBRIS.stepInterval / 120;
      let stepped = 0;
      for (let n = 0; n < 120; n++) {
        const before = field.pieces.map((p) => p.pos.x);
        field.step(dt, s, "open", false, n * dt);
        stepped += field.pieces.filter((p, i) => p.pos.x !== before[i]).length;
      }
      const ps = field.pieces;
      const mean = (f: (p: Piece) => number) => ps.reduce((a, p) => a + f(p), 0) / ps.length;
      return { x: mean((p) => p.pos.x), y: mean((p) => p.pos.y), share: stepped / (120 * 200) };
    };
    const every = flight(Infinity);
    const half = flight(1.5);
    const travelled = every.x - 50;
    expect(travelled).toBeGreaterThan(20);
    expect(Math.abs(half.x - every.x)).toBeLessThan(0.02 * travelled);
    expect(Math.abs(half.y - every.y)).toBeLessThan(0.02 * travelled);
    expect(every.share).toBeCloseTo(1, 1);
    expect(half.share).toBeCloseTo(0.5, 1);
  });
});

describe("Spec 04 v2.3–2.4 — a swept slab is clean", () => {
  const sweepRec = { part: "sweep" as const, index: 0, time: 0, load: 9e5, capacity: 1e5, mph: 200, sign: 1, wind: { x: 90, y: 0, z: 0 } };

  test("DEB-28: the heavy world carries off pieces lying on a swept slab; fast-moving ones and those beside it stay", () => {
    const house = exactHouse();
    const hx = house.width / 2;
    const h = new HeavyDebris([house], () => [house], DT);
    const on = panel(0, 1.2, 0);
    const beside = panel(hx + 4, 1, 0);
    h.take(on, NOBODY, 0);
    h.take(beside, NOBODY, 0);
    let t = run(h, air(0), 3);
    expect(on.resting && beside.resting).toBe(true);
    expect(overSlab(house, on.pos)).toBe(true);
    // Thrown across the slab inside the house (its walls stand), low: over it and fast when
    // it is carried off.
    const flying = panel(-hx + 2.5, 1.0, 2.5, { x: 8, y: 2, z: 0 });
    h.take(flying, NOBODY, t);
    t = run(h, air(0), 0.25, t);
    expect(overSlab(house, flying.pos)).toBe(true);
    expect(Math.hypot(flying.vel.x, flying.vel.y, flying.vel.z)).toBeGreaterThan(HEAVY.creepSpeed);
    h.carryOff(0);
    expect(on.hidden && on.swept && on.settleNow).toBe(true);
    expect(on.rigid).toBe(false);
    expect(beside.hidden).toBeFalsy();
    expect(flying.hidden).toBeFalsy();
    expect(h.count).toBe(2);
    // Its own house's pieces still coming down over the slab go too, at any speed.
    const own = panel(-1, 2.5, -2, { x: 3, y: -6, z: 0 });
    h.take(own, house, t);
    run(h, air(0), 2 * DT, t);
    expect(Math.hypot(own.vel.x, own.vel.y, own.vel.z)).toBeGreaterThan(HEAVY.creepSpeed);
    h.carryOff(0);
    expect(own.hidden && own.swept).toBe(true);
    expect(flying.hidden).toBeFalsy();
    expect(h.count).toBe(2);
    h.dispose();
  });

  test("DEB-28: a sweep wakes what lies on the slab and leaves it to the wind for 2 s, then carries off the rest", () => {
    const house = exactHouse();
    const h = new HeavyDebris([house], () => [house], DT);
    const on = panel(0, 1.2, 0);
    h.take(on, NOBODY, 0);
    let t = run(h, air(0), 4);
    expect(on.resting).toBe(true);
    h.sweep(0);
    expect(on.hidden).toBeFalsy();
    t = run(h, air(0), HEAVY.sweepGraceS - 0.1, t);
    expect(on.hidden).toBeFalsy();
    run(h, air(0), 0.2, t);
    expect(on.hidden && on.swept).toBe(true);
    expect(h.count).toBe(0);
    h.dispose();
  });

  test("DEB-28: the engine reports pieces still on a slab 2 s after it learns it was swept as swept", async () => {
    const { HeavyEngine, HEAVY_STATE, HEAVY_STRIDE } = await import("../../src/sim/heavyEngine");
    const { townState } = await import("../../src/sim/townColliders");
    const states = new Map<number, number>();
    const record = (r: { poses: Float32Array }) => {
      for (let o = 0; o < r.poses.length; o += HEAVY_STRIDE) states.set(r.poses[o]!, r.poses[o + 11]!);
    };
    const house = exactHouse();
    const engine = new HeavyEngine([house], DT);
    const tornado = air(0);
    let n = 0;
    const step = (town: ReturnType<typeof townState>[] = [], takes: Parameters<typeof engine.step>[0]["takes"] = []) =>
      record(engine.step({ n: n++, tornado, terrain: "open", time: n * DT, takes, town }));
    const take = (key: number, pos: Vec3, vel = { x: 0, y: 0, z: 0 }) => ({ key, label: "Wall panel", dims: [4, 2.4, 0.15] as [number, number, number], mass: 290, pos, q: [0, 0, 0, 1] as [number, number, number, number], vel, source: 0, time: n * DT });
    step([], [take(7, { x: 0, y: 1.2, z: 0 })]);
    for (let i = 0; i < 180; i++) step();
    house.sweep.failed = { part: "sweep", index: 0, time: 3, load: 1, capacity: 1, mph: 200, sign: 1, wind: { x: 0, y: 0, z: 0 } };
    // A wall panel that failed in the same step as the sweep, falling onto the slab.
    step([townState(0, house)], [take(8, { x: 1, y: 1.8, z: 2 }, { x: 0, y: -1, z: 0 })]);
    expect(states.get(7)).not.toBe(HEAVY_STATE.swept);
    for (let i = 0; i < Math.round((HEAVY.sweepGraceS + 0.1) / DT); i++) step();
    expect(states.get(7)).toBe(HEAVY_STATE.swept);
    expect(states.get(8)).toBe(HEAVY_STATE.swept);
    expect(engine.debris.count).toBe(0);
    engine.dispose();
  });

  test("DEB-28: pieces the engine retired during the lag before it saw the sweep are caught as their results arrive", async () => {
    const { LagSweeps } = await import("../../src/sim/heavyBackend");
    const house = exactHouse();
    const lag = new LagSweeps();
    const onSlab = { x: 0, y: IMPACT.slabTop + 0.1, z: 0 };
    const beside = { x: house.width / 2 + 4, y: 0.1, z: 0 };
    lag.sent(house, 20);
    // Retired in step 15 (before the engine saw the sweep in step 20): it was lying there.
    expect(lag.catches(onSlab, 15)?.id).toBe(house.id);
    expect(lag.catches(beside, 15)).toBeNull();
    // Retired in or after step 20: the engine already swept what lay there; this landed later.
    expect(lag.catches(onSlab, 20)).toBeNull();
    lag.applied(20);
    expect(lag.catches(onSlab, 15)).toBeNull();
  });

  test("DEB-28: the debris field's sweep hands retired heavy pieces back to the wind and carries off any house's light rubble on the slab", () => {
    const house = exactHouse();
    const field = new DebrisField(1);
    const taken: Piece[] = [];
    field.heavy = { take: (p) => taken.push(p) };
    const settledAt = (p: Piece) => {
      p.rigid = false;
      p.resting = true;
      p.settleNow = true;
      field.pieces.push(p);
    };
    const retired = panel(0, IMPACT.slabTop + 0.075, 0);
    const neighbors = panel(1, IMPACT.slabTop + 0.2, 1, undefined, 99);
    neighbors.def = sheet("Shingle", 0.3, 0.3, 0.01, 1);
    const beside = panel(house.width / 2 + 4, 0.075, 0);
    for (const p of [retired, neighbors, beside]) settledAt(p);
    field.step(DT * 2, air(0, 0, true), "open", false, 1);
    expect(field.settled).toContain(retired);
    field.spawnFrom(house, sweepRec);
    // The retired panel is back in the heavy world (a new piece where it lay), not deleted.
    expect(retired.hidden).toBe(true);
    const back = taken.find((p) => p.def.mass === retired.def.mass);
    expect(back).toBeDefined();
    expect(back!.pos).toEqual(retired.pos);
    expect(back!.rigid).toBe(true);
    expect(field.pieces).toContain(back);
    expect(neighbors.hidden).toBe(true);
    expect(beside.hidden).toBeFalsy();
    expect(field.massSwept).toBeCloseTo(1, 5);
  });
});

describe("Spec 04 v2.4 — heavy pieces fall where they stood", () => {
  test("DEB-29: a failed heavy wall panel starts upright where it stood and tips over onto the slab, never jumping", () => {
    const house = exactHouse();
    const field = new DebrisField(1);
    const taken: Piece[] = [];
    field.heavy = { take: (p) => taken.push(p) };
    // Pushed in (sign +1) by a wind that can't move it: it falls inward.
    field.spawnFrom(house, { part: "wallPanel", index: 1, time: 0, load: 3000, capacity: 1000, mph: 60, sign: 1, wind: { x: 1, y: 0, z: 0 } });
    const p = taken[0]!;
    expect(p).toBeDefined();
    const normal = () => {
      const [x, y, z, w] = p.q;
      // Box Y (thickness) axis in world: the broad face's normal.
      return { x: 2 * (x * y - w * z), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z + w * x) };
    };
    // Upright, at its own place, with its top tipping inward at 1.5 m/s.
    expect(Math.abs(normal().y)).toBeLessThan(0.01);
    expect(p.pos.y).toBeCloseTo(IMPACT.slabTop + house.wallHeight / 2, 5);
    expect(p.angVel).toBeDefined();
    const inward = { x: -p.pos.x, z: -p.pos.z };
    // The top's velocity: the center's plus ω × (up · H/2).
    const H2 = house.wallHeight / 2;
    const vTop = { x: -p.angVel!.z * H2 + p.vel.x, z: p.angVel!.x * H2 + p.vel.z };
    expect(vTop.x * inward.x + vTop.z * inward.z).toBeGreaterThan(0);
    expect(Math.hypot(vTop.x, vTop.z)).toBeCloseTo(1.5, 1);

    // In the heavy world (its own panel gone from the house): it tips over and lies flat on the slab.
    house.panels[1]!.failed = { part: "wallPanel", index: 1, time: 0, load: 1, capacity: 1, mph: 60, sign: 1, wind: { x: 0, y: 0, z: 0 } };
    const h = new HeavyDebris([house], () => [house], DT);
    h.take(p, house, 0);
    let last = { ...p.pos };
    let maxJump = 0;
    let t = 0;
    for (let i = 0; i < 240; i++) {
      h.step(air(0), "open", (t += DT));
      maxJump = Math.max(maxJump, Math.hypot(p.pos.x - last.x, p.pos.y - last.y, p.pos.z - last.z));
      last = { ...p.pos };
    }
    expect(Math.abs(normal().y)).toBeGreaterThan(0.95);
    expect(p.pos.y).toBeCloseTo(IMPACT.slabTop + 0.075, 1);
    expect(overSlab(house, p.pos)).toBe(true);
    expect(maxJump).toBeLessThan(0.15);
    h.dispose();
  });
});

describe("Spec 04 v2.4 — heavy pieces snag on the ground", () => {
  test("DEB-30: snag distances follow the terrain's mean free path", async () => {
    const { snagDraw } = await import("../../src/sim/heavyDebris");
    const { DEBRIS } = await import("../../src/config/debris");
    let sum = 0;
    const N = 20000;
    for (let i = 0; i < N; i++) sum += -DEBRIS.snagDistance.suburban * Math.log(snagDraw(i % 500, Math.floor(i / 500)));
    expect(sum / N / DEBRIS.snagDistance.suburban).toBeGreaterThan(0.9);
    expect(sum / N / DEBRIS.snagDistance.suburban).toBeLessThan(1.1);
    // The same body and snag number give the same draw.
    expect(snagDraw(17, 3)).toBe(snagDraw(17, 3));
  });

  test("DEB-30: a sliding panel snags at its drawn distance, stays pinned while pushed into it, and is free moving away or lifted clear", async () => {
    const { snagDraw } = await import("../../src/sim/heavyDebris");
    const { DEBRIS } = await import("../../src/config/debris");
    const lambda = DEBRIS.snagDistance.open;
    // A body whose first snag comes after 2–6 m (it slides ~19 m before friction stops it).
    let id = 1;
    while (!(-lambda * Math.log(snagDraw(id, 0)) > 2 && -lambda * Math.log(snagDraw(id, 0)) < 6)) id++;
    const D = -lambda * Math.log(snagDraw(id, 0));
    const h = new HeavyDebris([], () => [], DT);
    const p = panel(0, 0.076, 0, { x: 15, y: 0, z: 0 });
    p.id = id;
    h.take(p, NOBODY, 0);
    let t = 0;
    let stopped: number | null = null;
    for (let i = 0; i < 120 && stopped === null; i++) {
      h.step(air(0), "open", (t += DT));
      if (Math.abs(p.vel.x) < 0.3) stopped = p.pos.x;
    }
    expect(stopped).not.toBeNull();
    expect(Math.abs(stopped! - D)).toBeLessThan(0.4);
    let body: import("@dimforge/rapier3d-simd-compat").RigidBody | null = null;
    h.world.forEachRigidBody((b) => {
      if (b.isDynamic()) body = b;
    });
    const b = body!;
    // Pushed into the obstacle: it doesn't go.
    for (let i = 0; i < 30; i++) {
      b.applyImpulse({ x: 290 * 0.5, y: 0, z: 0 }, true);
      h.step(air(0), "open", (t += DT));
    }
    expect(p.pos.x).toBeLessThan(stopped! + 0.05);
    // Away from it: free.
    b.applyImpulse({ x: -290 * 5, y: 0, z: 0 }, true);
    t = run(h, air(0), 0.3, t);
    expect(p.pos.x).toBeLessThan(stopped! - 0.5);
    // Lifted clear, then pushed the first way: it goes (over the obstacle).
    const from = p.pos.x;
    b.setTranslation({ x: p.pos.x, y: 0.9, z: p.pos.z }, true);
    b.applyImpulse({ x: 290 * 8, y: 0, z: 0 }, true);
    run(h, air(0), 0.3, t);
    expect(p.pos.x).toBeGreaterThan(from + 1);
    h.dispose();
  });
});

describe("Spec 04 v2.4 — interior walls fall as walls", () => {
  test("DEB-31: a failed partition or core room is released as wall panels where it stood, tipping in the wind's direction", async () => {
    const { interiorWalls, toWorld } = await import("../../src/core/damage/layout");
    const { PARTITION_AREAL } = await import("../../src/config/structure");
    const house = exactHouse();
    const H = house.wallHeight;
    for (const [part, index] of [["partition", 0], ["partition", 1], ["coreRoom", 0]] as const) {
      const field = new DebrisField(1);
      const taken: Piece[] = [];
      field.heavy = { take: (p) => taken.push(p) };
      const wind = { x: 30, y: 0, z: 20 };
      field.spawnFrom(house, { part, index, time: 0, load: 3000, capacity: 1000, mph: 90, sign: 1, wind });
      const walls = interiorWalls(house, part, index);
      expect(walls.length).toBe(part === "coreRoom" ? 4 : 1);
      const panels = taken.filter((p) => p.def.label === "Interior wall");
      expect(panels.length).toBe(walls.reduce((a, w) => a + Math.ceil(w.len / 4 - 1e-9), 0));
      const wallMass = walls.reduce((a, w) => a + PARTITION_AREAL * w.len * H, 0);
      const all = [...field.pieces, ...field.settled];
      const total = all.reduce((a, p) => a + p.def.mass * p.represents, 0);
      expect(total).toBeCloseTo(wallMass, 0);
      for (const p of panels) {
        expect(p.def.dims[0]).toBeLessThanOrEqual(4 + 1e-9);
        // Upright where it stood: on one of the walls' lines, its center at half height.
        expect(p.pos.y).toBeCloseTo(IMPACT.slabTop + H / 2, 5);
        const onLine = walls.some((w) => {
          const c = toWorld(house, w.x, 0, w.z);
          const along = w.alongX ? { x: Math.cos(house.yaw), z: -Math.sin(house.yaw) } : { x: Math.sin(house.yaw), z: Math.cos(house.yaw) };
          const off = (p.pos.x - c.x) * -along.z + (p.pos.z - c.z) * along.x;
          const s = (p.pos.x - c.x) * along.x + (p.pos.z - c.z) * along.z;
          return Math.abs(off) < 0.05 && Math.abs(s) <= w.len / 2 + 1e-6;
        });
        expect(onLine).toBe(true);
        // Its top tips downwind.
        const vTop = { x: -p.angVel!.z * (H / 2) + p.vel.x, z: p.angVel!.x * (H / 2) + p.vel.z };
        expect(vTop.x * wind.x + vTop.z * wind.z).toBeGreaterThan(0);
      }
    }
  });
});
