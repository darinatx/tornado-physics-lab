import { describe, expect, test } from "vitest";
import { AIR_DENSITY, GRAVITY } from "../../src/config/atmosphere";
import { condensationDeficit, funnelBottom, funnelRadius } from "../../src/core/wind/condensation";
import { EF_LOWER_MPH, efRating, mphToMs } from "../../src/core/wind/efScale";
import { pressureDeficit } from "../../src/core/wind/pressure";
import { dustEmission, dustTracerCount, HIDDEN_Y, surveyDust, TracerField } from "../../src/render/tracers";
import { RENDER } from "../../src/config/render";
import { windAt } from "../../src/core/wind/windField";
import { DOD_COLORS, HOUSE_COLORS, houseInstances, houseSlots } from "../../src/render/houses";
import { rec as hrec } from "../houseHelpers";
import { debrisInstance } from "../../src/render/debris";
import { DEBRIS_KINDS } from "../../src/config/debris";
import { DebrisField } from "../../src/core/debris/field";
import { exactHouse } from "../houseHelpers";
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
      expect(r).toBeLessThanOrEqual(Math.max(4 * s.rMax, 1.5 * a.survey.radius) + 1e-6);
    }
    expect(alive).toBeGreaterThan(1000);
  });

  test("REND-12: dust lifts over the whole area above the threshold, densest where emission is", () => {
    // A wide tornado whose lifting area reaches well beyond 2·R_max.
    const s = baseState({ vMax: 70, rMax: 300, alpha: 0.6, velocity: { x: 15, z: 0 } });
    const ut = RENDER.dustLiftSpeed;
    const f = new TracerField(20000, 3);
    const spawns: { r: number; u: number }[] = [];
    for (let k = 0; k < 120; k++) {
      f.update(1e-3, s, "open", 500);
      for (let i = 0; i < f.count; i++) {
        if (!f.isAlive(i) || f.age[i] !== 0) continue; // spawned this update
        const x = f.positions[i * 3]!;
        const z = f.positions[i * 3 + 2]!;
        const w = windAt({ x, y: 3, z }, s, "open");
        spawns.push({ r: Math.hypot(x - s.center.x, z - s.center.z), u: Math.hypot(w.x, w.z) });
      }
    }
    expect(spawns.length).toBeGreaterThan(5000);
    for (const p of spawns) {
      expect(p.u).toBeGreaterThanOrEqual(ut);
      expect(p.r).toBeLessThanOrEqual(6 * s.rMax + 1e-6);
    }
    expect(spawns.some((p) => p.r > 3 * s.rMax)).toBe(true);
    // Spawn share per annulus ∝ ∫F dA over it.
    const edges = [0, 1.5, 3, 6].map((k) => k * s.rMax);
    const emissionIn = (r0: number, r1: number) => {
      let t = 0;
      for (let i = 0; i < 200; i++) {
        const r = r0 + ((i + 0.5) * (r1 - r0)) / 200;
        for (let d = 0; d < 72; d++) {
          const a = (d / 72) * 2 * Math.PI;
          const w = windAt({ x: r * Math.cos(a), y: 3, z: r * Math.sin(a) }, s, "open");
          t += dustEmission(Math.hypot(w.x, w.z), ut) * r * ((r1 - r0) / 200); // F·dA (∝ r·dr)
        }
      }
      return t;
    };
    const want = [0, 1, 2].map((j) => emissionIn(edges[j]!, edges[j + 1]!));
    const got = [0, 1, 2].map((j) => spawns.filter((p) => p.r >= edges[j]! && p.r < edges[j + 1]!).length);
    const wt = want.reduce((a, b) => a + b, 0);
    const gt = got.reduce((a, b) => a + b, 0);
    for (let j = 0; j < 3; j++) expect(Math.abs(got[j]! / gt - want[j]! / wt), `annulus ${j}`).toBeLessThan(0.03);
  });

  test("REND-13: the tracer count follows the total dust emission, within its limits", () => {
    const count = (o: Parameters<typeof baseState>[0]) => dustTracerCount(surveyDust(baseState(o), "open", RENDER.dustLiftSpeed).total);
    const typical = count({ vMax: 52, rMax: 300, alpha: 0.6, velocity: { x: 15, z: 0 } });
    expect(typical).toBeGreaterThan(10000);
    expect(typical).toBeLessThan(14000);
    expect(count({ vMax: 60, rMax: 300, alpha: 0.6, velocity: { x: 15, z: 0 } })).toBeGreaterThan(typical); // stronger
    expect(count({ vMax: 52, rMax: 400, alpha: 0.6, velocity: { x: 15, z: 0 } })).toBeGreaterThan(typical); // larger
    expect(count({ vMax: 128, rMax: 800, alpha: 0.5, velocity: { x: 30, z: 0 } })).toBe(RENDER.tracerCap);
    expect(count({ vMax: 15, rMax: 300, alpha: 0.6, velocity: { x: 5, z: 0 } })).toBe(0); // no dust lifts
    expect(count({ vMax: 20, rMax: 150, alpha: 0.6, velocity: { x: 10, z: 0 } })).toBe(RENDER.tracerMin);
    // In a field, tracers beyond the count retire as the tornado weakens.
    const f = new TracerField(RENDER.tracerCap, 4);
    const strong = baseState({ vMax: 70, rMax: 300, velocity: { x: 15, z: 0 } });
    for (let k = 0; k < 300; k++) f.update(1 / 30, strong, "open", 500);
    const before = f.target;
    const alive = () => Array.from({ length: f.count }, (_, i) => f.isAlive(i)).filter(Boolean).length;
    expect(alive()).toBeGreaterThan(0.5 * before);
    const weak = baseState({ vMax: 35, rMax: 300, velocity: { x: 10, z: 0 } });
    for (let k = 0; k < 30 * 30; k++) f.update(1 / 30, weak, "open", 500);
    expect(f.target).toBeLessThan(before);
    expect(alive()).toBeLessThanOrEqual(f.target);
  });

  test("REND-09: debris instances use the piece's size, orientation, position and color", () => {
    const f = new DebrisField(1);
    const b = exactHouse();
    f.spawnFrom(b, hrec("roofBay", 1, { x: 60, y: 0, z: 0 }, 2000));
    f.spawnFrom(b, hrec("siding", 2));
    f.spawnFrom(b, hrec("window", 0));
    for (const p of f.pieces) {
      const d = debrisInstance(p);
      const [L, W, T] = p.def.dims;
      expect(d.scale).toEqual([L, T, W]);
      expect(d.quaternion).toEqual(p.q);
      expect(d.position).toEqual([p.pos.x, p.pos.y, p.pos.z]);
      const expected = p.kind === "shingle" ? b.roofColor : p.kind === "siding" ? b.wallColor : p.color;
      expect(d.color).toBe(expected);
    }
    const small = f.pieces.find((p) => p.kind === "siding" || p.kind === "glass")!;
    const [L, W, T] = small.def.dims;
    const resting = { ...small, pos: { x: 1, y: T / 2, z: 2 }, resting: true };
    expect(debrisInstance(resting).position).toEqual([1, T / 2, 2]);
    const big = debrisInstance(resting, 3);
    expect(big.scale).toEqual([3 * L, 3 * T, 3 * W]);
    expect(big.position[1]).toBeCloseTo((3 * T) / 2, 12);
    // Full-size components are never enlarged.
    const roof = f.pieces.find((p) => p.kind === "roofPanel")!;
    expect(debrisInstance(roof, 3).scale).toEqual([roof.def.dims[0], roof.def.dims[2], roof.def.dims[1]]);
  });

  test("REND-08: houses show exactly their standing components", () => {
    const intact = exactHouse();
    const d0 = houseInstances(intact, true);
    const slots = houseSlots(intact);
    expect(d0.panels.length).toBe(intact.panels.length);
    expect(d0.roof.length).toBe(intact.sections.length);
    expect(d0.panes.length).toBe(intact.panes.length);
    expect(d0.rafters.length).toBe(0);
    expect(d0.sills.length).toBe(0);
    expect(d0.bolts.length).toBe(0);
    for (const k of Object.keys(d0) as (keyof typeof d0)[]) expect(d0[k].length).toBeLessThanOrEqual(slots[k]);
    expect(d0.panels[0]!.color).toBe(intact.wallColor); // DOD 0: no tint

    const b = exactHouse();
    b.siding[0]!.failed = hrec("siding", 0);
    b.sections[0]!.cover = hrec("roofCover", 0);
    b.sections[1]!.deck = hrec("roofDeck", 1);
    b.panels[2]!.failed = hrec("wallPanel", 2);
    b.bays[b.nx - 1]!.failed = hrec("roofBay", b.nx - 1);
    if (b.panes[0]) b.panes[0].failed = hrec("window", 0);
    b.dod = 7;
    const d = houseInstances(b, true);
    expect(d.panels.length).toBe(b.panels.length - 1);
    expect(d.sills.length).toBe(1);
    // Stripped siding and bare plywood show through the damage tint; intact surfaces are tinted.
    expect(d.panels.some((p) => p.color === HOUSE_COLORS.sheathing)).toBe(true);
    expect(d.panels.some((p) => p.color === DOD_COLORS[7])).toBe(true);
    expect(d.roof.some((r) => r.color === HOUSE_COLORS.plywood)).toBe(true);
    const goneSections = b.sections.filter((s) => s.deck || b.bays[s.col]!.failed).length;
    expect(d.roof.length).toBe(b.sections.length - goneSections);
    expect(d.rafters.length).toBe(2); // deck gone on one slope of a standing bay
    if (b.panes[0] && !b.panels[b.panes[0].panel]!.failed) expect(d.panes.some((p) => p.color === HOUSE_COLORS.brokenGlass)).toBe(true);
    expect(houseInstances(b, false).panels.some((p) => p.color === b.wallColor)).toBe(true);

    // Swept: bolts on the slab, no sills; shifted houses are offset but the slab is not.
    const s = exactHouse();
    s.panels.forEach((p, i) => (p.failed = hrec("wallPanel", i)));
    s.partitions.forEach((p, i) => (p.failed = hrec("partition", i)));
    s.coreRoom.failed = hrec("coreRoom");
    s.sweep.failed = hrec("sweep");
    const ds = houseInstances(s, true);
    expect(ds.bolts.length).toBe(8);
    expect(ds.sills.length).toBe(0);
    const sh = exactHouse();
    sh.shift = { x: 2, z: 0 };
    const dsh = houseInstances(sh, false);
    expect(dsh.slab[0]!.p[0]).toBeCloseTo(sh.x, 9);
    expect(dsh.panels[0]!.p[0] - houseInstances(exactHouse(), false).panels[0]!.p[0]).toBeCloseTo(2, 9);
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

  test("REND-14: moving goes along the view (tilt included), sideways and up, at height-scaled speed", async () => {
    const { flySpeed, flyStep, NO_KEYS, FLY_KEY_MAP } = await import("../../src/render/cameraFly");
    const { CAMERA } = await import("../../src/config/render");
    // Keys: W/S forward/back, arrows sideways and up/down.
    expect(FLY_KEY_MAP).toMatchObject({ KeyW: "forward", KeyS: "back", ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", PageUp: "up", PageDown: "down" });
    const cam = { x: 0, y: 100, z: 0 };
    const tgt = { x: 300, y: 100, z: 400 }; // level, toward +x+z (3-4-5), 500 m away
    const dt = 0.1;
    const v = 1.2 * 100;
    const moved = (r: { camera: { x: number; y: number; z: number } }, from = cam) => ({ x: r.camera.x - from.x, y: r.camera.y - from.y, z: r.camera.z - from.z });
    const off = (r: { camera: { x: number; y: number; z: number }; target: { x: number; y: number; z: number } }) => ({ x: r.target.x - r.camera.x, y: r.target.y - r.camera.y, z: r.target.z - r.camera.z });
    // W level: along the view; the orbit point keeps its offset.
    const w = flyStep({ ...NO_KEYS, forward: true }, dt, cam, tgt);
    expect(moved(w).x).toBeCloseTo(0.6 * v * dt, 9);
    expect(moved(w).z).toBeCloseTo(0.8 * v * dt, 9);
    expect(moved(w).y).toBeCloseTo(0, 9);
    expect(off(w).x).toBeCloseTo(300, 6);
    expect(off(w).z).toBeCloseTo(400, 6);
    // W tilted down 30°: along the tilted view, toward the ground.
    const down30 = { x: 0, y: 100 - 500 * Math.sin(Math.PI / 6), z: 500 * Math.cos(Math.PI / 6) };
    const wt = moved(flyStep({ ...NO_KEYS, forward: true }, dt, cam, down30));
    expect(wt.y).toBeCloseTo(-Math.sin(Math.PI / 6) * v * dt, 9);
    expect(wt.z).toBeCloseTo(Math.cos(Math.PI / 6) * v * dt, 9);
    expect(Math.abs(wt.x)).toBeLessThan(1e-9);
    // S: the opposite way.
    const s = moved(flyStep({ ...NO_KEYS, back: true }, dt, cam, down30));
    expect(s.y).toBeCloseTo(-wt.y, 9);
    // →: sideways along the ground, to the right of the view (forward × up = (−0.8, 0.6)).
    const d = moved(flyStep({ ...NO_KEYS, right: true }, dt, cam, tgt));
    expect(d.x * 0.6 + d.z * 0.8).toBeCloseTo(0, 9);
    expect(-0.8 * d.x + 0.6 * d.z).toBeCloseTo(v * dt, 9);
    expect(d.y).toBeCloseTo(0, 9);
    // ↑: straight up.
    const e = moved(flyStep({ ...NO_KEYS, up: true }, dt, cam, tgt));
    expect(Math.abs(e.x) + Math.abs(e.z)).toBeLessThan(1e-12);
    expect(e.y).toBeCloseTo(v * dt, 9);
    // Combined keys keep the same speed; Shift is 4× faster.
    const wd = moved(flyStep({ ...NO_KEYS, forward: true, right: true, up: true }, dt, cam, tgt));
    expect(Math.hypot(wd.x, wd.y, wd.z)).toBeCloseTo(v * dt, 9);
    const fast = moved(flyStep({ ...NO_KEYS, forward: true, fast: true }, dt, cam, tgt));
    expect(Math.hypot(fast.x, fast.y, fast.z)).toBeCloseTo(4 * v * dt, 9);
    // Speed limits.
    expect(flySpeed(1, false)).toBe(CAMERA.flyMinSpeed);
    expect(flySpeed(5000, false)).toBe(CAMERA.flyMaxSpeed);
    // Floor: flying forward into the ground stops at eye height (no sliding along it); ↓ too.
    const low = { x: 0, y: 2, z: 0 };
    const steep = { x: 0, y: 0, z: 1 }; // 63° down
    const into = flyStep({ ...NO_KEYS, forward: true, fast: true }, 1, low, steep);
    expect(into.camera.y).toBeCloseTo(CAMERA.minHeight, 9);
    expect(Math.hypot(into.camera.x - low.x, into.camera.z - low.z)).toBeCloseTo(0.3 / 2, 6); // stopped where it met the floor
    const q = flyStep({ ...NO_KEYS, down: true, fast: true }, 1, low, { x: 10, y: 0, z: 0 });
    expect(q.camera.y).toBeCloseTo(CAMERA.minHeight, 9);
    // The orbit point never goes below the ground: looking down it lands where the view meets it.
    const ahead = flyStep({ ...NO_KEYS, forward: true }, dt, cam, down30);
    expect(ahead.target.y).toBeGreaterThanOrEqual(0);
    expect(ahead.target.y).toBeCloseTo(0, 6);
    const dir = { x: down30.x - cam.x, y: down30.y - cam.y, z: down30.z - cam.z };
    const nd = off(ahead);
    expect(Math.atan2(nd.y, Math.hypot(nd.x, nd.z))).toBeCloseTo(Math.atan2(dir.y, Math.hypot(dir.x, dir.z)), 9);
    // No keys: no move.
    const none = flyStep(NO_KEYS, dt, cam, tgt);
    expect(none.camera).toEqual(cam);
    expect(none.target).toEqual(tgt);
  });

  test("REND-15: turning moves only the look point, around the camera", async () => {
    const { lookStep, TURN_KEY_MAP } = await import("../../src/render/cameraFly");
    const { CAMERA } = await import("../../src/config/render");
    // Keys: A/D pan, Q/E tilt down/up.
    expect(TURN_KEY_MAP).toEqual({ KeyA: "left", KeyD: "right", KeyE: "up", KeyQ: "down" });
    const cam = { x: 100, y: 20, z: -50 };
    const tgt = { x: 100, y: 20, z: 950 }; // level, looking along +z, 1 km away
    // Yaw left 90°: the view turns to +x (left of +z with y up), same distance, still level.
    const l = lookStep(cam, tgt, Math.PI / 2, 0);
    expect(l.x - cam.x).toBeCloseTo(1000, 6);
    expect(l.z - cam.z).toBeCloseTo(0, 6);
    expect(l.y).toBeCloseTo(20, 9);
    const fwd = { x: 0, z: 1 };
    const right = { x: -fwd.z, z: fwd.x }; // forward × up
    const r = lookStep(cam, tgt, -0.3, 0);
    expect((r.x - cam.x) * right.x + (r.z - cam.z) * right.z).toBeGreaterThan(0); // negative yaw turns right
    // Pitch up 30°: elevation 30°, same heading and distance.
    const u = lookStep(cam, tgt, 0, Math.PI / 6);
    expect(Math.atan2(u.y - cam.y, Math.hypot(u.x - cam.x, u.z - cam.z))).toBeCloseTo(Math.PI / 6, 9);
    expect(Math.hypot(u.x - cam.x, u.y - cam.y, u.z - cam.z)).toBeCloseTo(1000, 6);
    expect(u.x).toBeCloseTo(cam.x, 9);
    // Pitch limit.
    const up = lookStep(cam, tgt, 0, 3);
    expect(Math.atan2(up.y - cam.y, Math.hypot(up.x - cam.x, up.z - cam.z))).toBeCloseTo(CAMERA.maxPitch, 9);
    // Looking down: the point lands on the ground where the view meets it.
    const d = lookStep(cam, tgt, 0, -Math.PI / 4);
    expect(d.y).toBeCloseTo(0, 9);
    expect(d.z - cam.z).toBeCloseTo(20, 6); // 45° down from 20 m up
    // Yaw keeps pitch, and the camera itself never moves (lookStep returns only the point).
    const e = lookStep(cam, u, 1, 0);
    expect(Math.atan2(e.y - cam.y, Math.hypot(e.x - cam.x, e.z - cam.z))).toBeCloseTo(Math.PI / 6, 9);
  });
  test("REND-16: held camera keys never stick", async () => {
    const { keyEvent, NO_KEYS } = await import("../../src/render/cameraFly");
    const keys = { ...NO_KEYS };
    const turn = { left: false, right: false, up: false, down: false };
    const ev = (code: string, o: Partial<{ key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({
      code, key: o.key ?? code, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...o,
    });
    // A key-up with ⌘ held, or while typing, still releases.
    expect(keyEvent(keys, turn, ev("KeyW"), true, false)).toBe(true);
    expect(keys.forward).toBe(true);
    keyEvent(keys, turn, ev("KeyW", { metaKey: true }), false, true);
    expect(keys.forward).toBe(false);
    // ⌘ pressed while flying and turning: everything released (macOS won't send the key-ups).
    keyEvent(keys, turn, ev("KeyS"), true, false);
    keyEvent(keys, turn, ev("KeyA"), true, false);
    keyEvent(keys, turn, ev("MetaLeft", { key: "Meta", metaKey: true }), true, false);
    expect(keys.back).toBe(false);
    expect(turn.left).toBe(false);
    // Ctrl/Alt shortcuts too; key-downs while typing in a field are ignored.
    keyEvent(keys, turn, ev("ArrowLeft"), true, false);
    keyEvent(keys, turn, ev("KeyC", { ctrlKey: true }), true, false);
    expect(keys.left).toBe(false);
    expect(keyEvent(keys, turn, ev("ArrowRight"), true, true)).toBe(false);
    expect(keys.right).toBe(false);
  });
  test("REND-17: the camera starts framed on the tornado, ahead of it on its track", async () => {
    const { startView } = await import("../../src/render/cameraFly");
    const fov = 50;
    const aspect = 16 / 9;
    const half = (fov / 2) * (Math.PI / 180);
    const hHalf = Math.atan(Math.tan(half) * aspect);
    const check = (center: { x: number; z: number }, dir: { x: number; z: number }, rMax: number, cloudBase: number) => {
      const v = startView(center, dir, rMax, cloudBase, fov, aspect);
      expect(v.camera.y).toBe(30);
      expect(v.target).toMatchObject({ x: center.x, y: 0.4 * cloudBase, z: center.z });
      const rel = { x: v.camera.x - center.x, z: v.camera.z - center.z };
      const D = Math.hypot(rel.x, rel.z);
      // Ahead on the track and 30% to the right (right of the heading = (−dz, dx)).
      const along = rel.x * dir.x + rel.z * dir.z;
      const across = rel.x * -dir.z + rel.z * dir.x;
      expect(across / along).toBeCloseTo(0.3, 9);
      expect(D).toBeGreaterThanOrEqual(300 - 1e-6);
      // Frames ground to cloud base in ≤ 80% of the view height, 4·R_max in ≤ 60% of its width,
      // and is the nearest such distance (one of them is tight, or the 300 m floor).
      const vert = Math.atan((cloudBase - 30) / D) + Math.atan(30 / D);
      const wide = 2 * Math.atan((2 * rMax) / D);
      expect(vert).toBeLessThanOrEqual(0.8 * 2 * half + 1e-6);
      expect(wide).toBeLessThanOrEqual(0.6 * 2 * hHalf + 1e-6);
      const tight = Math.abs(vert - 0.8 * 2 * half) < 1e-3 || Math.abs(wide - 0.6 * 2 * hHalf) < 1e-3 || Math.abs(D - 300) < 1e-6;
      expect(tight).toBe(true);
      return D;
    };
    const ef0 = check({ x: -2800, z: 0 }, { x: 1, z: 0 }, 40, 550);
    const ef5 = check({ x: 100, z: 50 }, { x: 0, z: 1 }, 350, 400);
    // A small tornado starting far outside town is now well under a kilometre away.
    expect(ef0).toBeLessThan(1000);
    expect(ef5).toBeGreaterThan(ef0);
    // Before the canvas has a size (aspect 0/0) the view is still a real place.
    const nan = startView({ x: 0, z: 0 }, { x: 1, z: 0 }, 300, 400, fov, NaN);
    expect(Number.isFinite(nan.camera.x + nan.camera.y + nan.camera.z)).toBe(true);
  });
});
