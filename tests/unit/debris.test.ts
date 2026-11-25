import { describe, expect, test } from "vitest";
import { AIR_DENSITY, GRAVITY } from "../../src/config/atmosphere";
import { DEBRIS, DEBRIS_KINDS, SPAWN_TABLE } from "../../src/config/debris";
import type { DebrisKind } from "../../src/config/debris";
import { DebrisField } from "../../src/core/debris/field";
import { liftForce, restingForces, snag, stepPiece, terminalSpeed, wakeIfForced } from "../../src/core/debris/piece";
import type { Piece } from "../../src/core/debris/piece";
import { createRng } from "../../src/sim/rng";
import { baseState } from "../helpers";
import { exactHouse, median, rec as hrec } from "../houseHelpers";
import type { Part } from "../../src/config/buildings";
import { panelCenter } from "../../src/core/damage/layout";
import { PRESETS } from "../../src/config/presets";
import { createSim } from "../../src/sim/loop";
import { IMPACT } from "../../src/config/impacts";
import { overSlab } from "../../src/core/impact/envelope";

function piece(kind: DebrisKind, y = 100, o: Partial<Piece> = {}): Piece {
  return {
    id: 1, kind, def: DEBRIS_KINDS[kind], pos: { x: 0, y, z: 0 }, vel: { x: 0, y: 0, z: 0 }, q: [0, 0, 0, 1], spin: 1,
    resting: false, snagged: false, snagDir: null, bornAt: 0, restedAt: Infinity, represents: 1, color: 0, sourceId: 0,
    maxWindMet: 0, liftOn: true, liftRoll: 0, gust: { x: 0, y: 0, z: 0 }, ...o,
  };
}
const rec = (part: Part, index = 0, wind = { x: 1, y: 0, z: 0 }, load = 1000) => hrec(part, index, wind, load);
const still = { x: 0, y: 0, z: 0 };

describe("Spec 04 — debris", () => {
  test("DEB-13: debris from one house fans out downwind in steady wind", () => {
    const s = baseState({ vMax: 0, updraftMax: 0, velocity: { x: 40, z: 0 } });
    const f = new DebrisField(11, 5000);
    for (let i = 0; i < 15; i++)
      for (const part of ["roofCover", "siding", "window"] as const) for (let k = 0; k < 4; k++) f.spawnFrom(exactHouse(), rec(part, k));
    for (let i = 0; i < 60 * 60; i++) f.step(1 / 60, s, "open", i % 2 === 0, i / 60);
    const landed = [...f.pieces, ...f.settled].filter((p) => p.resting);
    expect(landed.length).toBeGreaterThan(100);
    const mx = landed.reduce((a, p) => a + p.pos.x, 0) / landed.length;
    const mz = landed.reduce((a, p) => a + p.pos.z, 0) / landed.length;
    const sz = Math.sqrt(landed.reduce((a, p) => a + (p.pos.z - mz) ** 2, 0) / landed.length);
    expect(mx).toBeGreaterThan(10);
    expect(sz / mx).toBeGreaterThan(0.08);
    expect(sz / mx).toBeLessThan(0.4);
  });

  test("DEB-11: resting pieces left behind move to the permanent debris field", () => {
    const f = new DebrisField(8);
    f.spawnFrom(exactHouse(), rec("partition"));
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
      while (!p.grounded && t < 120) {
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
    // Slide: strong wind across a 2×4 lying on the ground (end-on, it shows the wind only its
    // end: Spec 04 v1.8).
    const slide = piece("stud", 0, { resting: true });
    const gust = { x: 0, y: 0, z: 40 };
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

  test("DEB-05: representative pieces spawn per the table at the part's location", () => {
    const b = exactHouse();
    const field = new DebrisField(1);
    for (const part of ["siding", "roofCover", "window", "partition"] as const) {
      const before = field.pieces.length + field.settled.length;
      field.spawnFrom(b, rec(part, 0));
      const added = [...field.pieces, ...field.settled].slice(before);
      expect(added.length).toBe(SPAWN_TABLE[part].reduce((a, [, n]) => a + n, 0));
      for (const p of added) {
        expect(Math.abs(p.pos.x - b.x)).toBeLessThanOrEqual(b.width / 2 + 0.6);
        expect(Math.abs(p.pos.z - b.z)).toBeLessThanOrEqual(b.depth / 2 + 0.6);
        if (part === "roofCover") expect(p.pos.y).toBeGreaterThanOrEqual(b.wallHeight);
        expect(p.represents).toBeGreaterThanOrEqual(1);
      }
    }
    const a = new DebrisField(9);
    const c = new DebrisField(9);
    a.spawnFrom(b, rec("roofBay", 1));
    c.spawnFrom(b, rec("roofBay", 1));
    expect(a.pieces).toEqual(c.pieces);
  });

  test("DEB-06: pool cap freezes the oldest resting piece (never erases) and counts skips", () => {
    const b = exactHouse();
    const field = new DebrisField(2, 20);
    for (let i = 0; i < 20; i++) field.spawnFrom(b, rec("siding", i % b.panels.length));
    expect(field.pieces.length).toBe(20);
    field.spawnFrom(b, rec("siding", 1));
    expect(field.stats.skipped).toBe(1);
    field.pieces[3]!.resting = true;
    field.pieces[3]!.restedAt = 10;
    field.pieces[7]!.resting = true;
    field.pieces[7]!.restedAt = 5;
    const oldId = field.pieces[7]!.id;
    field.spawnFrom(b, rec("window", 0)); // 2 shards: freeze both resting pieces
    expect(field.pieces.length).toBe(20);
    expect(field.pieces.some((p) => p.id === oldId)).toBe(false);
    expect(field.settled.some((p) => p.id === oldId)).toBe(true);
    expect(field.stats.skipped).toBe(1);
  });

  test("DEB-14: each component releases a piece shaped and placed like itself", () => {
    const b = exactHouse();
    const f = new DebrisField(3);
    const strong = { x: 60, y: 0, z: 0 };
    // Wall panel: same size, at the panel.
    const pi = 1;
    f.spawnFrom(b, rec("wallPanel", pi, strong));
    const wp = [...f.pieces, ...f.settled].find((p) => p.kind === "wallPanel")!;
    const panel = b.panels[pi]!;
    expect(wp.def.dims[0]).toBeCloseTo(panel.len, 9);
    expect(wp.def.dims[1]).toBeCloseTo(b.wallHeight, 9);
    const c = panelCenter(b, panel, b.wallHeight / 2);
    if (!wp.resting) expect(Math.hypot(wp.pos.x - (b.x + c.x), wp.pos.z - (b.z + c.z))).toBeLessThan(0.5);
    // Roof bay: one panel per slope, at roof height, sized to the column.
    f.spawnFrom(b, rec("roofBay", 1, strong, 2000));
    const roofs = f.pieces.filter((p) => p.kind === "roofPanel");
    expect(roofs.length).toBe(2);
    for (const r of roofs) expect(r.pos.y).toBeGreaterThan(b.wallHeight);
    // Garage door: one door panel.
    f.spawnFrom(b, rec("garage", 0, strong));
    expect([...f.pieces, ...f.settled].filter((p) => p.kind === "garageDoor").length).toBe(1);
  });

  test("DEB-15: pieces the wind can't move become rubble beside the house", () => {
    const b = exactHouse();
    const f = new DebrisField(4);
    f.spawnFrom(b, rec("wallPanel", 0, { x: 5, y: 0, z: 0 })); // gentle wind: 290 kg panel stays
    expect(f.pieces.length).toBe(0);
    expect(f.settled.length).toBe(1);
    const r = f.settled[0]!;
    // Flat on whatever it fell onto: the slab (pushed in, it falls inward) or the ground.
    expect(r.pos.y).toBeCloseTo((overSlab(b, r.pos) ? IMPACT.slabTop : 0) + r.def.dims[2] / 2, 9);
    expect(Math.hypot(r.pos.x - b.x, r.pos.z - b.z)).toBeLessThan(Math.hypot(b.width, b.depth));
    const g = new DebrisField(4);
    g.spawnFrom(b, rec("wallPanel", 0, { x: 90, y: 0, z: 0 })); // violent wind: it moves
    expect(g.pieces.length).toBe(1);
  });

  test("DEB-17: roof pieces leave moving up and downwind, faster with more uplift", () => {
    const b = exactHouse();
    const launch = (load: number) => {
      const f = new DebrisField(5);
      f.spawnFrom(b, rec("roofBay", 0, { x: 50, y: 0, z: 0 }, load));
      return f.pieces.filter((p) => p.kind === "roofPanel");
    };
    const weak = launch(500);
    const hard = launch(3000);
    expect(weak.length).toBe(2);
    for (const p of [...weak, ...hard]) {
      expect(p.vel.y).toBeGreaterThan(0);
      expect(p.vel.x).toBeCloseTo(15, 9);
    }
    expect(hard[0]!.vel.y).toBeGreaterThan(weak[0]!.vel.y);
  });

  test("DEB-07: no piece outruns the fastest wind it met plus its terminal speed (+20%)", () => {
    const s = baseState({ vMax: 75, rMax: 200, velocity: { x: 15, z: 0 } });
    const field = new DebrisField(5);
    const rng = createRng(5);
    for (let i = 0; i < 40; i++) {
      const b = exactHouse();
      b.x = (rng() - 0.5) * 300;
      b.z = (rng() - 0.5) * 300;
      field.spawnFrom(b, rec(i % 2 ? "roofBay" : "wallPanel", i % 2 ? 1 : 2, { x: 70, y: 0, z: 0 }, 2000));
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
      f.spawnFrom(exactHouse(), rec("roofBay", 1, { x: 60, y: 0, z: 0 }, 2000));
      for (let i = 0; i < 600; i++) f.step(1 / 60, s, "open", i % 2 === 0, i / 60, 500);
      return f.pieces.map((p) => [p.pos, p.vel, p.q, p.resting]);
    };
    expect(run()).toEqual(run());
  });

  test("DEB-09: pieces above the cloud base are removed as lofted", () => {
    const f = new DebrisField(4);
    for (let k = 0; k < 4; k++) f.spawnFrom(exactHouse(), rec("roofCover", k));
    const s = baseState({ vMax: 0, updraftMax: 0 });
    // Pieces just under a 320 m cloud base, rising fast: one short step carries them through.
    for (const p of f.pieces) {
      p.pos.y = 319.9;
      p.vel.y = 50;
    }
    f.step(0.01, s, "open", false, 0, 320);
    expect(f.pieces.length).toBe(0);
    expect(f.stats.lofted).toBe(8); // 4 sections × 2 shingles
  });

  test("DEB-10: snagging at the mean free path, and snagged pieces hold harder", () => {
    // Slide many stud pieces through a steady strong wind and measure the distance to snag.
    const s = baseState({ vMax: 0, updraftMax: 0, velocity: { x: 0, z: 0 } });
    const f = new DebrisField(6, 4000);
    const b = exactHouse({}, 0);
    for (let i = 0; i < 400; i++) f.spawnFrom(b, rec("partition", i % 3));
    const studs = f.pieces.filter((p) => p.kind === "stud");
    for (const p of f.pieces) {
      p.pos.y = 0;
      p.vel = { x: 8, y: 0, z: 0 };
    }
    // Zero wind: pieces coast to a stop or snag. Keep them sliding at 8 m/s to measure λ.
    // Snagging alone: no bumps (the loop below forces every piece back to sliding speed).
    const bumps = DEBRIS.bumpSpacing.open;
    (DEBRIS.bumpSpacing as { open: number }).open = Infinity;
    let snagged = 0;
    let distance = 0;
    for (let i = 0; i < 2000; i++) {
      for (const p of studs) if (!p.resting) p.vel = { x: 8, y: 0, z: 0 };
      f.step(1 / 60, s, "open", false, i / 60);
      // Distance slid along the ground (bumps hop pieces; snagging happens while sliding).
      distance += studs.filter((p) => !p.resting).length * 8 / 60;
    }
    (DEBRIS.bumpSpacing as { open: number }).open = bumps;
    snagged = studs.filter((p) => p.snagged).length;
    const lambda = distance / snagged;
    expect(Math.abs(lambda / DEBRIS.snagDistance.open - 1)).toBeLessThan(0.1);

    // A snagged piece is pinned while the wind pushes it into its obstacle...
    const p = piece("stud", 0, { vel: { x: 0, y: 0, z: 5 } });
    snag(p);
    const into = { x: 0, y: 0, z: 40 }; // across the 2×4 (its side, not its end)
    const rf = restingForces(p, into);
    expect(rf.drag).toBeGreaterThan(DEBRIS.holdFriction * (rf.weight - rf.up)); // would slide if free
    expect(wakeIfForced(p, into)).toBe(false);
    // ...and released once the wind swings around to pull it back.
    expect(wakeIfForced(p, { x: 5, y: 0, z: -40 })).toBe(true);
    expect(p.snagged).toBe(false);
  });
  test("DEB-18: a sheet on the ground lifts off by suction whatever its tumble sense, then tumbles nose-up", () => {
    // Horizontal wind well above the shingle's lift-off speed (~16 m/s at 0.2 m).
    const w = { x: 30, y: 0, z: 0 };
    for (const spin of [1, -1] as const) {
      const p = piece("shingle", DEBRIS_KINDS.shingle.dims[2] / 2, { spin, grounded: true });
      for (let i = 0; i < 30; i++) stepPiece(p, w, 1 / 60);
      expect(p.grounded).toBe(false);
      expect(p.pos.y).toBeGreaterThan(DEBRIS_KINDS.shingle.dims[2]);
      expect(p.spin).toBe(1);
    }
    // Below lift-off it stays down (and the down-sense spin doesn't matter).
    const q = piece("shingle", DEBRIS_KINDS.shingle.dims[2] / 2, { spin: -1, grounded: true });
    for (let i = 0; i < 30; i++) stepPiece(q, { x: 8, y: 0, z: 0 }, 1 / 60);
    expect(q.pos.y).toBeCloseTo(DEBRIS_KINDS.shingle.dims[2] / 2, 6);
  });
  test("DEB-19: rough ground hops sliding pieces into the wind", async () => {
    const { bumpKick } = await import("../../src/core/debris/piece");
    // Bumps at the terrain's spacing: count over many 0.1 m slides.
    const rng = createRng(9);
    let hits = 0;
    const trials = 200000;
    for (let i = 0; i < trials; i++) {
      const p = piece("shingle", 0.0025, { grounded: true, vel: { x: 6, y: 0, z: 0 } });
      if (bumpKick(p, 0.1, DEBRIS.bumpSpacing.suburban, rng)) hits++;
    }
    const perMetre = hits / (trials * 0.1);
    expect(perMetre * DEBRIS.bumpSpacing.suburban).toBeGreaterThan(0.9);
    expect(perMetre * DEBRIS.bumpSpacing.suburban).toBeLessThan(1.1);
    // Kinematics: speed along the ramp is kept; nose-up tumble.
    const always = () => 0; // a bump for sure, slope 0 → then a slope from the next draw
    const seq = [0, 0.5];
    let k = 0;
    const p = piece("shingle", 0.0025, { grounded: true, spin: -1, vel: { x: 10, y: 0, z: 0 } });
    bumpKick(p, 1, 1, () => seq[k++]!);
    const th = Math.atan(0.5 * DEBRIS.bumpMaxSlope);
    expect(p.vel.y).toBeCloseTo(10 * Math.cos(th) * Math.sin(th), 9);
    expect(p.vel.x).toBeCloseTo(10 * Math.cos(th) ** 2, 9);
    expect(p.spin).toBe(1);
    expect(p.grounded).toBe(false);
    void always;

    // Field: in a strong steady wind (60 m/s at 10 m) on rough ground, siding hops into the wind
    // and is carried off; on smooth ground the same strip only slides. A 290 kg wall panel only
    // hops. Averages over 20 seeds.
    const run = (kind: DebrisKind, spacing: number) => {
      const saved = DEBRIS.bumpSpacing.suburban;
      (DEBRIS.bumpSpacing as { suburban: number }).suburban = spacing;
      let maxH = 0;
      let travel = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const f = new DebrisField(seed, 100);
        const p = piece(kind, DEBRIS_KINDS[kind].dims[2] / 2, { grounded: true, liftOn: true, vel: { x: 12, y: 0, z: 0 } });
        f.pieces.push(p);
        const st = baseState({ vMax: 0, updraftMax: 0, velocity: { x: 60, z: 0 } });
        let h = 0;
        for (let i = 0; i < 600; i++) {
          f.step(1 / 60, st, "suburban", i % 2 === 0, i / 60);
          h = Math.max(h, p.pos.y);
        }
        maxH += h / 20;
        travel += p.pos.x / 20;
      }
      (DEBRIS.bumpSpacing as { suburban: number }).suburban = saved;
      return { maxH, travel };
    };
    const flat = run("siding", Infinity);
    const siding = run("siding", 1.5);
    const panel = run("wallPanel", 1.5);
    expect(flat.maxH).toBeLessThan(0.1);
    expect(siding.maxH).toBeGreaterThan(1);
    expect(siding.travel).toBeGreaterThan(3 * flat.travel);
    expect(panel.maxH).toBeLessThan(0.5);
    expect(panel.travel).toBeLessThan(siding.travel / 3);
  });
  test("DEB-20: no tumbling within half a length of the ground", () => {
    const low = piece("shingle", 0.3, { vel: { x: 0, y: 0, z: 0 } }); // bottom 0.3 m up, length 1 m
    const q0 = [...low.q];
    stepPiece(low, { x: 20, y: 0, z: 0 }, 1 / 60);
    expect(low.q).toEqual(q0);
    const high = piece("shingle", 5, { vel: { x: 0, y: 0, z: 0 } });
    stepPiece(high, { x: 20, y: 0, z: 0 }, 1 / 60);
    expect(high.q).not.toEqual(q0);
  });
  test("DEB-21: drag on the ground uses the area a piece shows the wind", async () => {
    const { groundCda } = await import("../../src/core/debris/piece");
    const flat = piece("osb", 0.006);
    expect(groundCda(flat, { x: 1, y: 0, z: 0 })).toBeLessThan(DEBRIS_KINDS.osb.cda / 5);
    // A 2×4 lying with its length along x: end-on (x) shows less than side-on (z).
    const stud = piece("stud", 0.02);
    expect(groundCda(stud, { x: 1, y: 0, z: 0 })).toBeLessThan(groundCda(stud, { x: 0, y: 0, z: 1 }));
    // A fallen wall panel in a 60 m/s wind stays near where it fell.
    const f = new DebrisField(2, 100);
    const p = piece("wallPanel", DEBRIS_KINDS.wallPanel.dims[2] / 2, { grounded: true, liftOn: true });
    f.pieces.push(p);
    const st = baseState({ vMax: 0, updraftMax: 0, velocity: { x: 60, z: 0 } });
    for (let i = 0; i < 600; i++) f.step(1 / 60, st, "suburban", i % 2 === 0, i / 60);
    expect(Math.hypot(p.pos.x, p.pos.z)).toBeLessThan(20);
  });
});
