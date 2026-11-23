import { describe, expect, test } from "vitest";
import { AIR_DENSITY, GRAVITY } from "../../src/config/atmosphere";
import { condensationDeficit, funnelBottom, funnelRadius } from "../../src/core/wind/condensation";
import { EF_LOWER_MPH, efRating, mphToMs } from "../../src/core/wind/efScale";
import { pressureDeficit } from "../../src/core/wind/pressure";
import { HIDDEN_Y, TracerField } from "../../src/render/tracers";
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
      expect(r).toBeLessThanOrEqual(4 * s.rMax);
    }
    expect(alive).toBeGreaterThan(1000);
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
});
