import { beforeAll, describe, expect, test } from "vitest";
import { createTunnel } from "../../src/sim/tunnel";
import type { Tunnel, TunnelScenario } from "../../src/sim/tunnel";
import { initRapier } from "../../src/sim/structureWorld";
import { CPI } from "../../src/config/buildings";
import { DEBRIS_KINDS } from "../../src/config/debris";
import type { DebrisKind } from "../../src/config/debris";
import { CP, LAYOUT } from "../../src/config/buildings";
import { IMPACT } from "../../src/config/impacts";
import { buildingReport, degreeOfDamage, updateBuilding } from "../../src/core/damage/building";
import { computeHouseLoads } from "../../src/core/damage/loads";
import type { Building, QueuedImpact } from "../../src/core/damage/types";
import { DebrisField } from "../../src/core/debris/field";
import type { Piece } from "../../src/core/debris/piece";
import { clipEnvelope, eaveY, insideLocal, slabHalf, surfaceAt, toLocal } from "../../src/core/impact/envelope";
import { supportHeight } from "../../src/core/debris/piece";
import { applyImpacts, glassThreshold, impulseForce, resolveImpact } from "../../src/core/impact/impact";
import type { Missile } from "../../src/core/impact/impact";
import { createRng } from "../../src/sim/rng";
import { baseState } from "../helpers";
import { exactHouse, rec } from "../houseHelpers";
import { PassThroughMonitor } from "../../src/sim/passThrough";

// exactHouse: 14 × 11 m at the origin, yaw 0, walls 3 m on a 0.3 m slab, roof rise 2 m.
const still = baseState({ vMax: 0, updraftMax: 0, velocity: { x: 0, z: 0 } });

function piece(kind: DebrisKind, pos: { x: number; y: number; z: number }, vel: { x: number; y: number; z: number }, o: Partial<Piece> = {}): Piece {
  return {
    id: 1, kind, def: DEBRIS_KINDS[kind], pos: { ...pos }, vel: { ...vel }, q: [0, 0, 0, 1], spin: 1,
    resting: false, snagged: false, snagDir: null, bornAt: 0, restedAt: Infinity, represents: 1, color: 0, sourceId: 99,
    maxWindMet: 0, liftOn: false, liftRoll: 0, gust: { x: 0, y: 0, z: 0 }, ...o,
  };
}

function fieldWith(b: Building, ...ps: Piece[]): DebrisField {
  const f = new DebrisField(3, 100);
  f.pieces.push(...ps);
  return f;
}
const targets = (b: Building) => ({ near: () => [b] });
const run = (f: DebrisField, b: Building, steps: number, onStep?: () => void) => {
  for (let i = 0; i < steps; i++) {
    f.step(1 / 60, still, "open", false, i / 60, Infinity, targets(b));
    onStep?.();
  }
};
const missile = (kind: DebrisKind, mass?: number): Missile => {
  const d = DEBRIS_KINDS[kind];
  return { label: d.label, family: d.family, mass: mass ?? d.mass, dims: d.dims };
};
/** Index of the wall panel on face f covering position u. */
const panelOn = (b: Building, face: number, u: number) => b.panels.findIndex((p) => p.face === face && Math.abs(u - p.u) <= p.len / 2);

describe("Spec 10 — debris impacts", () => {
  test("IMP-01: standing walls stop pieces; openings let them through; inside stays inside", () => {
    const b = exactHouse();
    // A shingle low on the −X end wall (below any window), flying +X.
    const p = piece("shingle", { x: -12, y: 0.6, z: 0 }, { x: 30, y: 0, z: 0 });
    const f = fieldWith(b, p);
    run(f, b, 40, () => expect(insideLocal(b, toLocal(b, p.pos), -1e-6)).toBe(false));
    expect(p.pos.x).toBeLessThan(-7);

    // Same throw with that wall panel down: it passes into the house.
    const b2 = exactHouse();
    const i = panelOn(b2, 2, 0);
    b2.panels[i]!.failed = rec("wallPanel", i);
    const p2 = piece("shingle", { x: -8, y: 0.6, z: 0 }, { x: 30, y: 0, z: 0 });
    run(fieldWith(b2, p2), b2, 12);
    expect(p2.pos.x).toBeGreaterThan(-7);

    // A piece inside can't leave through a standing wall.
    const b3 = exactHouse();
    const p3 = piece("shingle", { x: 0, y: 1.5, z: 0 }, { x: 30, y: 0, z: 0 });
    run(fieldWith(b3, p3), b3, 60, () => expect(insideLocal(b3, toLocal(b3, p3.pos), 1e-6)).toBe(true));

    // Cutting a corner in one step: in through a fallen end wall, out through the standing front
    // wall beside it (Spec 10 v0.13). The step is stopped at the front wall, from inside.
    const b4 = exactHouse();
    for (const [k, q] of b4.panels.entries()) if (q.face === 0) q.failed = rec("wallPanel", k);
    const from = { x: b4.width / 2 + 0.3, y: 1.5, z: -b4.depth / 2 + 0.2 };
    const to = { x: b4.width / 2 - 0.5, y: 1.5, z: -b4.depth / 2 - 0.3 };
    const h = clipEnvelope(b4, from, to)!;
    expect(h.entering).toBe(false);
    expect(h.plane).toBe(3);
    expect(h.surface.kind).toBe("wall");
    expect(h.t).toBeGreaterThan(0);
    expect(h.t).toBeLessThan(1);
    const h4 = clipEnvelope(b4, from, to, () => 0.05)!;
    expect(h4.entering).toBe(false);
    expect(h4.surface.kind).toBe("wall");
    // Through the field: the piece stays inside the corner (never out through the front wall).
    const p4 = piece("siding", from, { x: -0.8 * 60, y: 0, z: -0.5 * 60 });
    const f4 = fieldWith(b4, p4);
    run(f4, b4, 1);
    expect(toLocal(b4, p4.pos).z).toBeGreaterThan(-b4.depth / 2);
  });

  test("IMP-02: hits are assigned to the pane, garage door, wall panel, gable or roof section", () => {
    const b = exactHouse();
    const pane = b.panes[0]!;
    const pp = b.panels[pane.panel]!;
    const n = [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }][pp.face]!;
    const t = { x: -n.z, z: n.x };
    const half = pp.face % 2 === 0 ? b.width / 2 : b.depth / 2;
    const at = (u: number, h: number) => ({ x: n.x * half + t.x * u, y: IMPACT.slabTop + h, z: n.z * half + t.z * u });
    expect(surfaceAt(b, pp.face as 0, at(pp.u, LAYOUT.paneSill + 0.6))).toEqual({ kind: "pane", index: 0, face: pp.face });
    expect(surfaceAt(b, pp.face as 0, at(pp.u, 0.3))).toEqual({ kind: "wall", index: pane.panel, face: pp.face });
    const g = b.garage!;
    const gp = b.panels[g.panel]!;
    expect(surfaceAt(b, 3, { x: gp.u, y: 1, z: -b.depth / 2 }).kind).toBe("garage");
    // Gable above the +X end wall.
    expect(surfaceAt(b, 0, { x: b.width / 2, y: eaveY(b) + 1, z: 0.5 })).toMatchObject({ kind: "gable", face: 0 });
    // Roof: back slope, eave row, first column.
    const s = surfaceAt(b, 5, { x: -b.width / 2 + 0.5, y: eaveY(b) + 0.4, z: 4.5 });
    expect(s.kind).toBe("roof");
    expect(b.sections[s.index]).toMatchObject({ col: 0, slope: 1, row: 0 });
    // Openings: a broken pane, a fallen panel, a lost deck.
    pane.failed = rec("window", 0);
    expect(surfaceAt(b, pp.face as 0, at(pp.u, LAYOUT.paneSill + 0.6)).kind).toBe("opening");
    b.sections[s.index]!.deck = rec("roofDeck", s.index);
    expect(surfaceAt(b, 5, { x: -b.width / 2 + 0.5, y: eaveY(b) + 0.4, z: 4.5 }).kind).toBe("opening");
    // The clip finds the face a piece crosses.
    const h = clipEnvelope(b, { x: 0, y: 1, z: -10 }, { x: 0, y: 1, z: -4 })!;
    expect(h.entering).toBe(true);
    expect(h.plane).toBe(3);
    expect(h.point.z).toBeCloseTo(-b.depth / 2, 9);
  });

  test("IMP-03: glass breaks exactly above the pane's momentum threshold", () => {
    const b = exactHouse();
    const rng = createRng(1);
    const surf = { kind: "pane" as const, index: 0, face: b.panels[b.panes[0]!.panel]!.face };
    for (const kind of ["glass", "stud", "shingle"] as DebrisKind[]) {
      const m = missile(kind);
      const th = glassThreshold(b, 0, m.family);
      expect(glassThreshold(b, 0, m.family)).toBe(th); // same pane, same strength
      expect(resolveImpact(b, surf, m, (th / m.mass) * 1.001, rng)!.impact.broke).toBe(true);
      expect(resolveImpact(b, surf, m, (th / m.mass) * 0.999, rng)!.impact.broke).toBe(false);
    }
    // Medians by family, and strong glazing.
    const med = (family: "sheet" | "rod" | "compact", cls: Building["cls"]) => {
      const v = Array.from({ length: 4001 }, (_, id) => glassThreshold({ id, cls } as Building, 0, family)).sort((x, y) => x - y);
      return v[2000]!;
    };
    for (const family of ["sheet", "rod", "compact"] as const) {
      expect(med(family, "standard") / IMPACT.glass[family].median).toBeGreaterThan(0.95);
      expect(med(family, "standard") / IMPACT.glass[family].median).toBeLessThan(1.05);
      expect(med(family, "strong") / med(family, "standard")).toBeCloseTo(IMPACT.strongGlazing, 9);
    }
    // Lumber's blunt end spreads its contact more than a shingle's edge (NAHB 2002), and both
    // more than a hard compact piece.
    expect(med("rod", "standard")).toBeGreaterThan(med("sheet", "standard"));
    expect(med("sheet", "standard")).toBeGreaterThan(med("compact", "standard"));
  });

  test("IMP-04: rods and compact pieces perforate by energy, sheets never; lodged lumber falls when its wall does", () => {
    const b = exactHouse();
    const rng = createRng(2);
    const wall = { kind: "wall" as const, index: panelOn(b, 2, 0), face: 2 };
    const stud = missile("stud");
    const vAt = (E: number, m: Missile) => Math.sqrt((2 * E) / m.mass);
    const share = (m: Missile, E: number) => {
      let k = 0;
      for (let i = 0; i < 4000; i++) if (resolveImpact(b, wall, m, vAt(E, m), rng)!.impact.perforated) k++;
      return k / 4000;
    };
    expect(share(stud, IMPACT.perforate.wall.median)).toBeGreaterThan(0.46);
    expect(share(stud, IMPACT.perforate.wall.median)).toBeLessThan(0.54);
    expect(share(missile("osb"), 5000)).toBe(0);
    expect(share(missile("chunk", 80), 5000)).toBe(0);

    // A 2×4 thrown hard into the end wall lodges along its flight, then falls with the wall.
    const p = piece("stud", { x: -12, y: 0.8, z: 0.3 }, { x: 45, y: 0, z: 0 });
    const f = fieldWith(b, p);
    run(f, b, 20);
    expect(f.stats.lodged).toBe(1);
    expect(f.pieces).not.toContain(p);
    expect(f.settled).toContain(p);
    expect(p.lodgedIn).toBe(`${b.id}:w:${wall.index}`);
    // Long axis (local X of the piece) along +X, tip 0.2 m inside the wall.
    const [x, y, z, w] = p.q;
    expect(1 - 2 * (y * y + z * z)).toBeCloseTo(1, 2); // along its flight (a degree or so of fall)
    expect(p.pos.x + DEBRIS_KINDS.stud.dims[0] / 2).toBeCloseTo(-b.width / 2 + IMPACT.lodgeDepth, 2);
    void x; void w;
    f.spawnFrom(b, rec("wallPanel", wall.index));
    expect(p.hidden).toBe(true);
    expect(f.stats.lodged).toBe(0);
    expect(f.pieces.some((q) => q.kind === "stud" && !q.resting && Math.abs(q.pos.x - p.pos.x) < 1e-9)).toBe(true);
  });

  test("IMP-05: siding and shingles lose 0.5 m² per tearing hit and fail at half their area", () => {
    const b = exactHouse();
    const wi = panelOn(b, 2, 0);
    const area = b.panels[wi]!.len * b.wallHeight;
    const q = (o: Partial<QueuedImpact>): QueuedImpact => ({
      surface: "wall", index: wi, face: 2, broke: false, perforated: false, sidingTorn: false, coverTorn: false, force: 0,
      measure: 100, threshold: 15, missile: { label: "Stud (2×4)", mass: 4.5, speed: 6, measure: "energy" }, ...o,
    });
    const calm = { x: 0, y: 0, z: 0 };
    b.impacts.push(q({ sidingTorn: true }));
    updateBuilding(b, calm, 0, 1 / 30, 1);
    expect(b.sidingLost[wi]).toBeCloseTo(IMPACT.patchArea, 12);
    expect(b.siding[wi]!.failed).toBeNull();
    expect(degreeOfDamage(b)).toBe(1);
    const need = Math.ceil((IMPACT.failFraction * area) / IMPACT.patchArea);
    for (let k = 1; k < need - 1; k++) b.impacts.push(q({ sidingTorn: true }));
    updateBuilding(b, calm, 0, 1 / 30, 2);
    expect(b.siding[wi]!.failed).toBeNull();
    b.impacts.push(q({ sidingTorn: true }));
    updateBuilding(b, calm, 0, 1 / 30, 3);
    expect(b.siding[wi]!.failed?.cause).toBe("debris");

    const b2 = exactHouse();
    const si = 0;
    b2.impacts.push(q({ surface: "roof", index: si, face: 4, coverTorn: true }));
    updateBuilding(b2, calm, 0, 1 / 30, 1);
    expect(b2.coverLost[si]).toBeCloseTo(IMPACT.patchArea, 12);
    expect(degreeOfDamage(b2)).toBe(2);
    const sNeed = Math.ceil((IMPACT.failFraction * b2.sections[si]!.area) / IMPACT.patchArea);
    for (let k = 1; k < sNeed; k++) b2.impacts.push(q({ surface: "roof", index: si, face: 4, coverTorn: true }));
    updateBuilding(b2, calm, 0, 1 / 30, 2);
    expect(b2.sections[si]!.cover?.cause).toBe("debris");
  });

  test("IMP-06: impulse force with crushing cap; a heavy hit fails a panel the wind alone doesn't", () => {
    const stud = missile("stud");
    expect(impulseForce(stud, 10)).toBeCloseTo((4.5 * 10 * 1.2) / 0.1, 9);
    expect(impulseForce(stud, 1000)).toBeCloseTo(IMPACT.crushStrength * 0.09 * 0.04, 6);
    const panelPiece = missile("wallPanel");
    const wind = { x: 30, y: 0, z: 0 }; // ~67 mph: panels hold
    const make = () => {
      const b = exactHouse();
      updateBuilding(b, wind, 0, 1 / 30, 0);
      return b;
    };
    const wi = (b: Building) => panelOn(b, 2, 0);
    const a = make();
    updateBuilding(a, wind, 0, 1 / 30, 1);
    expect(a.panels[wi(a)]!.failed).toBeNull();
    const b = make();
    const hit = resolveImpact(b, { kind: "wall", index: wi(b), face: 2 }, panelPiece, 12, createRng(1))!;
    expect(hit.impact.force).toBeGreaterThan(0);
    b.impacts.push(hit.impact);
    updateBuilding(b, wind, 0, 1 / 30, 1);
    expect(b.panels[wi(b)]!.failed?.cause).toBe("debris");
    // Calm wind still applies queued impacts.
    const c = exactHouse();
    c.impacts.push(resolveImpact(c, { kind: "wall", index: wi(c), face: 2 }, panelPiece, 12, createRng(1))!.impact);
    expect(updateBuilding(c, { x: 0, y: 0, z: 0 }, 0, 1 / 30, 1)).toBe(true);
    expect(c.panels[wi(c)]!.failed).not.toBeNull();
  });

  test("IMP-07: holes are openings and 1 m² of them breaches the house", () => {
    const b = exactHouse();
    const wi = panelOn(b, 2, 0);
    const n = Math.round(IMPACT.breachArea / IMPACT.holeArea);
    const hole = (): QueuedImpact => ({
      surface: "wall", index: wi, face: 2, broke: false, perforated: true, sidingTorn: false, coverTorn: false, force: 0,
      measure: 500, threshold: 250, missile: { label: "Stud (2×4)", mass: 4.5, speed: 15, measure: "energy" },
    });
    const rec0 = (part: never) => part;
    void rec0;
    for (let k = 0; k < n - 1; k++) b.impacts.push(hole());
    applyImpacts(b, () => { throw new Error("no failure expected"); });
    expect(b.breached).toBe(false);
    b.impacts.push(hole());
    applyImpacts(b, () => { throw new Error("no failure expected"); });
    expect(b.breached).toBe(true);
    expect(b.holes[2]).toBeCloseTo(n * IMPACT.holeArea, 9);
    // Wind from −X: the −X face is windward; holes only there → internal C_p = 0.75 × 0.8.
    const L = computeHouseLoads(b, { x: 30, y: 0, z: 0 });
    expect(L.cpi).toBeCloseTo(0.75 * CP.windward, 9);
  });

  test("IMP-08: a non-damaging hit bounces with restitution and doesn't speed up along the wall", () => {
    const b = exactHouse();
    const p = piece("shingle", { x: -7.1, y: 0.6, z: 0 }, { x: 10, y: 0, z: 3 });
    const f = fieldWith(b, p);
    run(f, b, 1);
    expect(p.vel.x).toBeLessThan(0);
    expect(-p.vel.x / 10).toBeGreaterThan(0.15);
    expect(-p.vel.x / 10).toBeLessThan(0.25);
    expect(Math.abs(p.vel.z)).toBeLessThanOrEqual(3);
    expect(p.pos.x).toBeLessThan(-b.width / 2);
  });

  test("IMP-09: representative copies scatter around the hit; only the piece itself pushes", () => {
    const b = exactHouse();
    const p = piece("glass", { x: -7.1, y: 0.8, z: 0 }, { x: 12, y: 0, z: 0 }, { represents: 200, origin: { x: -40, z: 0 } });
    const f = fieldWith(b, p);
    f.step(1 / 60, still, "open", false, 0, Infinity, targets(b));
    expect(f.stats.impacts).toBeGreaterThan(5);
    expect(f.stats.impacts).toBeLessThanOrEqual(IMPACT.maxCopies);
    expect(b.impacts.filter((q) => q.force > 0).length).toBeLessThanOrEqual(1);
    // σ = 0.15 × 33 m ≈ 5 m: copies reach several components.
    expect(new Set(b.impacts.map((q) => `${q.surface}:${q.index}`)).size).toBeGreaterThan(1);
  });

  test("IMP-10: impact failures carry their cause and missile, and the report counts them", () => {
    const b = exactHouse();
    const surf = { kind: "pane" as const, index: 0, face: b.panels[b.panes[0]!.panel]!.face };
    b.impacts.push(resolveImpact(b, surf, missile("shingle"), 10, createRng(1))!.impact);
    updateBuilding(b, { x: 0, y: 0, z: 0 }, 0, 1 / 30, 5);
    const r = b.panes[0]!.failed!;
    expect(r.cause).toBe("debris");
    expect(r.missile).toMatchObject({ label: "Shingle", mass: 1, speed: 10, measure: "momentum" });
    const g = buildingReport(b).failures.find((x) => x.part === "window")!;
    expect(g.byDebris).toBe(1);
    expect(g.debrisMissile?.label).toBe("Shingle");
    expect(b.dod).toBe(3);
  });

  test("IMP-11: same seed, same impacts", () => {
    const go = () => {
      const b = exactHouse();
      const ps = Array.from({ length: 30 }, (_, i) =>
        piece(i % 2 ? "stud" : "shingle", { x: -15, y: 0.5 + (i % 7) * 0.6, z: -5 + (i % 11) }, { x: 25 + i, y: 2, z: (i % 5) - 2 }, { id: i, represents: 1 + (i % 9) }),
      );
      const f = fieldWith(b, ...ps);
      run(f, b, 60);
      return JSON.stringify({ impacts: b.impacts, pos: ps.map((p) => p.pos), lodged: f.stats.lodged });
    };
    expect(go()).toBe(go());
  });
  test("IMP-14: a piece's size counts: a long strip never pokes into a standing wall", () => {
    const b = exactHouse();
    // A 3.8 m siding strip, long axis along +X (its flight), low on the −X end wall.
    const p = piece("siding", { x: -12, y: 0.6, z: 0 }, { x: 30, y: 0, z: 0 });
    const f = fieldWith(b, p);
    run(f, b, 40, () => {
      // Its box's leading end stays outside the wall plane (1 cm allowance).
      const reach = p.pos.x + DEBRIS_KINDS.siding.dims[0] / 2 * Math.abs(1 - 2 * (p.q[1] ** 2 + p.q[2] ** 2));
      expect(reach).toBeLessThan(-b.width / 2 + 0.05);
    });
  });

  test("IMP-15: slabs stop pieces sliding into them and carry pieces that land on them, swept or not", () => {
    const b = exactHouse();
    b.sweep.failed = rec("sweep", 0); // only the slab is left
    const h = slabHalf(b);
    // Sliding along the ground into the slab's side.
    const p = piece("shingle", { x: -h.x - 2, y: 0.0025, z: 0 }, { x: 8, y: 0, z: 0 }, { grounded: true });
    const f = fieldWith(b, p);
    run(f, b, 60, () => expect(p.pos.x).toBeLessThan(-h.x + 0.02));
    // Dropped onto the slab: it lands on the top, not the ground.
    const q = piece("osb", { x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: 0 });
    const g = fieldWith(b, q);
    run(g, b, 120);
    expect(q.pos.y - supportHeight(q)).toBeGreaterThan(IMPACT.slabTop - 1e-6);
    expect(q.pos.y - supportHeight(q)).toBeLessThan(IMPACT.slabTop + 0.01);
  });
  test("IMP-16: nothing stays inside a slab, and a piece snagging on a slab lies on its top", () => {
    const b = exactHouse();
    b.sweep.failed = rec("sweep", 0);
    const h = slabHalf(b);
    // Buried near the edge: pushed up onto the top (0.3 m) rather than 0.5 m out sideways.
    const p = piece("shingle", { x: -h.x + 0.5, y: 0.0025, z: 0 }, { x: 0, y: 0, z: 0 }, { grounded: true });
    // A wall panel buried deep in the middle: up onto the top too (sides are metres away).
    const q = piece("wallPanel", { x: 0, y: 0.075, z: 0 }, { x: 0, y: 0, z: 0 }, { grounded: true });
    const f = fieldWith(b, p, q);
    run(f, b, 1);
    for (const x of [p, q]) expect(x.pos.y - supportHeight(x)).toBeGreaterThan(IMPACT.slabTop - 0.011);
    // A thin sheet coming down fast onto the slab from beside it, its center ending 2 mm below
    // the top (its box only 4.5 mm in): put on the top, not left with its center in the slab.
    const t = piece("shingle", { x: -h.x - 0.3, y: IMPACT.slabTop + 0.05, z: 0 }, { x: 30, y: -3.12, z: 0 });
    const g0 = fieldWith(b, t);
    g0.step(1 / 60, still, "urban", false, 0, Infinity, targets(b));
    expect(Math.abs(t.pos.x) < h.x).toBe(true);
    expect(t.pos.y).toBeGreaterThanOrEqual(IMPACT.slabTop);
    // Sliding across a slab until it snags: it stays on the top.
    const r = piece("shingle", { x: -h.x + 0.2, y: IMPACT.slabTop + 0.0025, z: 0 }, { x: 3, y: 0, z: 0 }, { grounded: true });
    const g = new DebrisField(5, 100);
    g.pieces.push(r);
    for (let i = 0; i < 600 && !r.snagged; i++) g.step(1 / 60, still, "urban", false, i / 60, Infinity, targets(b));
    expect(r.pos.y - supportHeight(r)).toBeGreaterThan(IMPACT.slabTop - 1e-6);
  });
  test("IMP-27: a piece sliding off a slab's edge falls from it: never set down on the ground beyond the edge in the step it leaves, even inside a house shifted off its slab", () => {
    const b = exactHouse();
    // Shifted 1.5 m along +x off its foundation (Spec 03): between the slab's edge and the
    // shifted +X end wall, the house stands on bare ground.
    b.shift = { x: 1.5, z: 0 };
    const h = slabHalf(b);
    // A shingle sliding flat on the slab top, about to run off the slab's +x edge.
    const p = piece("shingle", { x: h.x - 0.25, y: IMPACT.slabTop + 0.0025, z: 0 }, { x: 20, y: 0, z: 0 }, { grounded: true });
    const f = fieldWith(b, p);
    // Every slide snags (the worst case for this rule).
    (f as unknown as { rng: () => number }).rng = () => 0;
    const mon = new PassThroughMonitor([b]);
    let y = p.pos.y;
    for (let i = 0; i < 90; i++) {
      f.step(1 / 60, still, "urban", false, i / 60, Infinity, targets(b));
      mon.observe((i + 1) / 60, [{ key: "p", source: "debris", label: p.def.label, pos: p.pos }]);
      // Off the slab it falls (0.3 m takes 0.25 s), it isn't put straight on the ground.
      expect(y - p.pos.y).toBeLessThan(0.1);
      y = p.pos.y;
    }
    expect(mon.violations).toEqual([]);
    // It ends on the ground beyond the edge.
    expect(p.pos.x).toBeGreaterThan(h.x);
    expect(p.pos.y - supportHeight(p)).toBeLessThan(0.01);
  });
  test("IMP-28: a piece that lands at a wall's foot in the step it reaches the wall stops at the wall, though the landing took its speed into it", () => {
    for (const inside of [false, true]) {
      const b = exactHouse();
      const hx = b.width / 2;
      // A shingle on its long edge, thin side toward the +X end wall, 7.5 mm from touching it
      // (outside or inside), dropping onto the slab at 4 m/s while drifting toward the wall at
      // 1 m/s: the landing's friction stops its drift in the same step.
      const s = inside ? -1 : 1;
      const p = piece("shingle", { x: hx + s * 0.01, y: IMPACT.slabTop + 0.55, z: -1.2 }, { x: -s, y: -4, z: 0 }, { q: [0, 0, Math.SQRT1_2, Math.SQRT1_2] });
      expect(supportHeight(p)).toBeCloseTo(0.5, 3);
      const f = fieldWith(b, p);
      const mon = new PassThroughMonitor([b]);
      mon.observe(0, [{ key: "p", source: "debris", label: p.def.label, pos: { ...p.pos } }]);
      for (let i = 0; i < 30; i++) {
        f.step(1 / 60, still, "urban", false, i / 60, Infinity, targets(b));
        mon.observe((i + 1) / 60, [{ key: "p", source: "debris", label: p.def.label, pos: { ...p.pos } }]);
      }
      expect(mon.violations).toEqual([]);
      expect(s * (p.pos.x - hx)).toBeGreaterThan(0);
    }
  });
  test("IMP-18: town debris hits a detailed house's stand-in, which follows its members as of the cutoff", async () => {
    const { DetailStandIns } = await import("../../src/sim/detailStandIns");
    const { buildFraming } = await import("../../src/core/structure/framing");
    const b = exactHouse();
    b.detail = true;
    const f = buildFraming(b);
    const s = new DetailStandIns();
    s.add(0, b, f);
    const c = b.standIn!;
    expect(c.panels.every((p) => !p.failed)).toBe(true);
    // The −X end wall's middle panel: its wall frame moves at detail step 10.
    const i = panelOn(b, 2, 0);
    const frame = f.members.find((m) => m.kind === "wallFrame" && m.panel === i)!;
    const poses = new Float32Array(9);
    poses[0] = 0;
    poses[1] = frame.id;
    s.record(10, poses);
    s.advance(9);
    expect(c.panels[i]!.failed).toBeNull(); // not yet: results up to step 9 only
    // A shingle thrown at the standing wall bounces off it.
    const p = piece("shingle", { x: -7.1, y: 0.6, z: 0 }, { x: 10, y: 0, z: 0 });
    const field = fieldWith(b, p);
    run(field, b, 1);
    expect(p.vel.x).toBeLessThan(0);
    s.advance(10);
    expect(c.panels[i]!.failed).not.toBeNull();
    // Now the panel is gone: the same throw passes in.
    const q = piece("shingle", { x: -7.1, y: 0.6, z: 0 }, { x: 10, y: 0, z: 0 });
    run(fieldWith(b, q), b, 3);
    expect(q.pos.x).toBeGreaterThan(-7);
  });
});

describe("Spec 10 v0.12: town debris perforating detailed houses", () => {
  beforeAll(async () => {
    await initRapier();
  });
  const engineHouse = (tun: Tunnel) => tun.worldOf(tun.target)!.houses.find((h) => h.building.id === tun.target)!;
  const shot = (o: Partial<TunnelScenario> = {}): TunnelScenario => ({
    name: "perforate-detail",
    seconds: 1.5,
    target: { model: "detail", cls: "standard" },
    wind: [{ t: 0, mph: 0, dirDeg: 0 }],
    launches: [{ t: 0.1, source: "town", kind: "stud", aim: { wall: 1 }, standoff: 4, speed: 30 }],
    ...o,
  });
  const run = async (s: TunnelScenario) => {
    const tun = await createTunnel(s);
    tun.advance(s.seconds);
    return tun;
  };

  test("IMP-22: a 2×4 that perforates a detailed wall lodges in it, and the engine gets the hole", async () => {
    const tun = await run(shot());
    const d = tun.sim.debris;
    expect(d.stats.lodgedTotal).toBe(1);
    expect(d.stats.lodged).toBe(1);
    const p = d.settled.find((x) => x.lodgedIn)!;
    // Stuck through the +X end wall along its flight, the tip 0.2 m inside.
    const b = tun.sim.world.buildings[tun.target]!;
    expect(p.pos.x).toBeCloseTo(b.width / 2 + DEBRIS_KINDS.stud.dims[0] / 2 - IMPACT.lodgeDepth, 1);
    expect(d.pieces.length).toBe(0);
    const h = engineHouse(tun);
    expect(h.holes[0]).toBeCloseTo(IMPACT.holeArea, 9);
    expect(h.holes.reduce((a, x) => a + x, 0)).toBeCloseTo(IMPACT.holeArea, 9);
    tun.dispose();
  }, 60_000);

  test("IMP-22: it falls free once the stand-in shows that wall gone", async () => {
    const tun = await run(
      shot({
        seconds: 9,
        wind: [
          { t: 0, mph: 0, dirDeg: 180 },
          { t: 1, mph: 0, dirDeg: 180 },
          { t: 5, mph: 250, dirDeg: 180 },
        ],
      }),
    );
    const si = tun.sim.world.buildings[tun.target]!.standIn!;
    expect(tun.sim.debris.stats.lodgedTotal).toBe(1);
    expect(si.panels[1]!.failed).toBeTruthy();
    expect(tun.sim.debris.stats.lodged).toBe(0);
    expect(tun.sim.debris.settled.some((x) => x.lodgedIn && !x.hidden)).toBe(false);
    tun.dispose();
  }, 120_000);

  test("IMP-22: 1 m² of holes breaches a detailed house, and they are openings at their face", async () => {
    const n = Math.ceil(IMPACT.breachArea / IMPACT.holeArea);
    const tun = await createTunnel(
      shot({
        seconds: 0.2 * n + 1,
        launches: Array.from({ length: n }, (_, i) => ({ t: 0.1 + 0.2 * i, source: "town" as const, kind: "stud" as const, aim: { wall: 1 }, standoff: 4, speed: 30 })),
      }),
    );
    tun.advance(1 / 60); // the house enters the zone at the first detail step
    const h = engineHouse(tun);
    let before = false;
    tun.onStep = () => {
      if (h.holes[0]! < IMPACT.breachArea - IMPACT.holeArea / 2) before ||= h.breached();
    };
    tun.advance(tun.scenario.seconds - 1 / 60);
    expect(tun.sim.debris.stats.lodgedTotal).toBe(n);
    expect(h.holes[0]).toBeCloseTo(n * IMPACT.holeArea, 9);
    expect(before).toBe(false);
    expect(h.breached()).toBe(true);
    // Only the holes are open, all on face 0: the internal pressure takes face 0's C_p.
    expect(h.internalCp([0.8, -0.5, -0.5, -0.3])).toBeCloseTo(CPI.dominantOpeningFactor * 0.8, 9);
    tun.dispose();
  }, 120_000);
});

describe("Spec 10 v0.14: light bodies pushed clear go back the way they came", () => {
  beforeAll(async () => {
    await initRapier();
  });
  /** A thin sheet (1 × 0.5 m) lying flat at 1.5 m, whose +z edge ends up 4 cm into exactHouse's
   *  back wall (face 1, z = 5.5 ± 0.075) from one side; returns where it ends up. */
  const pushFrom = async (side: "inside" | "outside") => {
    const RAPIER = (await import("@dimforge/rapier3d-simd-compat")).default;
    const { StructureWorld } = await import("../../src/sim/structureWorld");
    const { buildTownColliders } = await import("../../src/sim/townColliders");
    const sw = new StructureWorld();
    const b = exactHouse();
    for (const c of buildTownColliders(sw.world, b, sw.townPlaneOf)) sw.townHouseOf.set(c.handle, { x: b.x, z: b.z, index: 0 });
    sw.world.step(); // queries see new colliders after a step
    const hz = 0.25;
    const face = side === "inside" ? 5.425 : 5.575;
    const s = side === "inside" ? -1 : 1;
    const before = face + s * (hz + 0.1); // clear of the wall
    const after = face + s * (hz - 0.04); // 4 cm into it
    const body = sw.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1.5, before));
    sw.world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.004, hz), body);
    sw.world.propagateModifiedBodyPositionsToColliders();
    sw.lightBodies.set(body.handle, { slabCollider: null } as never);
    const priv = sw as unknown as { recordLightPoses(): void; keepLightBodiesClear(): void };
    priv.recordLightPoses();
    body.setTranslation({ x: 0, y: 1.5, z: after }, true);
    sw.world.propagateModifiedBodyPositionsToColliders();
    priv.keepLightBodiesClear();
    return { z: body.translation().z, after, face, hz, pushed: sw.pushed.has(body.handle) };
  };

  test("IMP-01: a light body inside a house (in through an opening) is pushed back in, not out through the standing wall", async () => {
    const r = await pushFrom("inside");
    expect(r.pushed).toBe(true);
    // Clear of the wall on the inside, and moved only about as far as it overlapped (not 40 cm).
    expect(r.z + r.hz).toBeLessThanOrEqual(r.face + 0.006);
    expect(Math.abs(r.z - r.after)).toBeLessThan(0.06);
  });

  test("IMP-01: a light body that sank into a wall from outside is pushed back out, only as far as it sank", async () => {
    const r = await pushFrom("outside");
    expect(r.pushed).toBe(true);
    expect(r.z - r.hz).toBeGreaterThanOrEqual(r.face - 0.006);
    expect(Math.abs(r.z - r.after)).toBeLessThan(0.06);
  });
});

describe("Spec 10 v0.17 — roof and siding hits show", () => {
  beforeAll(async () => {
    await initRapier();
  });

  test("IMP-23: on a detailed house a torn-shingle hit takes the nearest shingle patch off, a torn-siding hit the nearest siding course, and a roof hit pushes the sheet struck", async () => {
    const { createLab } = await import("../../src/sim/lab");
    const { createLocalBackend } = await import("../../src/sim/detailBackend");
    for (const target of ["roof", "wall"] as const) {
      const engines: ReturnType<typeof createLocalBackend>[] = [];
      const lab = await createLab({ houses: 1, cls: "standard", surroundings: "open", seed: 3, donors: false, dispersion: false }, { kind: "steady", keys: [{ t: 0, mph: 0, dirDeg: 0 }] }, { passThrough: false, detail: (_s, b) => (engines.push(createLocalBackend(b, 1)), engines[0]!) });
      const b = lab.sim.world.buildings[0]!;
      lab.advance(0.5);
      const hits: QueuedImpact[] = [];
      lab.sim.observe({ impact: (h, q) => h === 0 && hits.push(q) });
      // A 2×4 down onto the front slope, or end-on into a solid wall panel of the front.
      const roofAim = { point: { x: 2, y: 0.1 + b.wallHeight + b.roofRise * 0.6, z: -b.depth * 0.2 } };
      const wall = b.panels.findIndex((p) => p.face === 3 && !p.hasWindow && !p.isGarage);
      if (target === "roof") lab.fireMissile("icc500-v", 0, roofAim);
      else lab.launch({ source: "town", kind: "stud", house: 0, aim: { wall }, standoff: 4, speed: 12 });
      // A contact force on the sheet: watch the engine's house when the hit arrives.
      const h = engines[0]!.engines[0]!.houses.get(0)!;
      const before = h.failures.length;
      let pushed: number | null = null;
      const addContact = h.addContact.bind(h);
      h.addContact = (id, x, y, z) => {
        if (h.framing.members[id]!.kind === "roofSheet") pushed = id;
        addContact(id, x, y, z);
      };
      lab.advance(1.5);
      const q = hits[0]!;
      expect(q, target).toBeDefined();
      expect(q.at).toBeDefined();
      const torn = h.failures.slice(before);
      const near = (kind: string, face?: number) => {
        let best = -1;
        let bd = Infinity;
        for (const m of h.framing.members) {
          if (m.kind !== kind || (face !== undefined && m.face !== face)) continue;
          const d = Math.hypot(m.pos.x - q.at!.x, m.pos.y - q.at!.y, m.pos.z - q.at!.z);
          if (d < bd) (bd = d), (best = m.id);
        }
        return best;
      };
      if (target === "roof") {
        expect(q.coverTorn).toBe(true);
        expect(q.force).toBeGreaterThan(0);
        const id = near("roofShingle");
        expect(h.isAttached(id)).toBe(false);
        expect(torn.map((f) => f.label)).toContain("Shingle nails & sealant");
        expect(torn.every((f) => f.load === Infinity)).toBe(true);
        expect(pushed).toBe(near("roofSheet"));
      } else {
        expect(q.sidingTorn).toBe(true);
        const id = near("siding", 3);
        expect(h.isAttached(id)).toBe(false);
        expect(torn.some((f) => h.framing.members[h.framing.connections[f.con]!.from]!.id === id)).toBe(true);
      }
      lab.dispose();
    }
  }, 60000);

});

describe("Spec 10 v0.18 — impacts on arrival, presses in a sustained contact (BL-031)", () => {
  // exactHouse's west wall (face 2, plane −x) is at x = −7; a shingle 1.5 m up, driven at it.
  const pinned = (b: Building, p: Piece, steps: number, t0 = 0, f = fieldWith(b, p)) => {
    for (let i = 0; i < steps; i++) {
      // The wind holds it to the wall: each step it is driven back at 5 m/s, as a 60 Hz step
      // re-accelerates a pinned piece (a·Δt).
      p.vel = { x: 5, y: 0, z: 1 };
      p.pos.y = 1.5;
      p.resting = p.grounded = false;
      p.q = [0, 0, 0, 1];
      f.step(1 / 60, still, "open", false, t0 + i / 60, Infinity, targets(b));
    }
    return f;
  };

  test("IMP-25: a piece pinned on a wall makes one impact, not one per step", () => {
    const b = exactHouse();
    const p = piece("shingle", { x: -7.55, y: 1.5, z: 0 }, { x: 5, y: 0, z: 1 });
    const f = pinned(b, p, 60);
    expect(f.stats.impacts).toBe(1);
    expect(b.impacts).toHaveLength(1);
    // Every later contact was a press: it stays outside the wall with no rebound.
    expect(p.pos.x).toBeLessThan(-b.width / 2);
    expect(p.vel.x).toBeCloseTo(0, 9);
  });

  test("IMP-25: a press zeroes the normal speed, doesn't speed it up along the wall, and loads nothing", () => {
    const b = exactHouse();
    const p = piece("shingle", { x: -7.55, y: 1.5, z: 0 }, { x: 5, y: 0, z: 1 });
    const f = pinned(b, p, 1);
    expect(p.vel.x).toBeLessThan(0); // the arrival bounced (IMP-08)
    b.impacts.length = 0;
    p.vel = { x: 5, y: 0, z: 3 };
    f.step(1 / 60, still, "open", false, 1 / 60, Infinity, targets(b));
    expect(p.vel.x).toBeCloseTo(0, 9);
    expect(Math.abs(p.vel.z)).toBeLessThanOrEqual(3);
    expect(p.pos.x).toBeLessThan(-b.width / 2);
    expect(b.impacts).toHaveLength(0);
    expect(f.stats.impacts).toBe(1);
  });

  test("IMP-25: re-armed more than 0.1 s after the last contact, or on another plane", () => {
    const b = exactHouse();
    const p = piece("shingle", { x: -7.55, y: 1.5, z: 0 }, { x: 5, y: 0, z: 1 });
    const f = pinned(b, p, 10);
    expect(f.stats.impacts).toBe(1);
    // Away from the wall for 0.15 s (no contact), then back: a new arrival.
    const tAway = 10 / 60;
    p.pos = { x: -9, y: 1.5, z: 0 };
    p.vel = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 9; i++) {
      p.pos.y = 1.5;
      p.vel = { x: 0, y: 0, z: 0 };
      p.resting = p.grounded = false;
      f.step(1 / 60, still, "open", false, tAway + i / 60, Infinity, targets(b));
    }
    p.pos = { x: -7.52, y: 1.5, z: 0 };
    pinned(b, p, 1, tAway + 9 / 60, f);
    expect(f.stats.impacts).toBe(2);
    // Straight on to the front wall (face 0, z = +5.5) at once: another plane, another arrival.
    p.pos = { x: 0, y: 1.5, z: 5.7 };
    p.vel = { x: 0, y: 0, z: -5 };
    p.q = [0, 0, 0, 1];
    f.step(1 / 60, still, "open", false, tAway + 10 / 60, Infinity, targets(b));
    expect(f.stats.impacts).toBe(3);
  });

  test("IMP-25: a contact just under 0.1 s after the last is still the same episode", () => {
    const b = exactHouse();
    const p = piece("shingle", { x: -7.55, y: 1.5, z: 0 }, { x: 5, y: 0, z: 1 });
    const f = pinned(b, p, 1);
    p.pos = { x: -7.52, y: 1.5, z: 0 };
    pinned(b, p, 1, 5 / 60, f); // 5 steps (0.083 s) after the last contact
    expect(f.stats.impacts).toBe(1);
  });
});

describe("Spec 10 v0.18 — a corner cut stops on the piece's own path", () => {
  test("IMP-01: a long piece in through an opening and against a standing wall from inside in one step stays on its path", () => {
    const b = exactHouse();
    for (const [k, q] of b.panels.entries()) if (q.face === 0) q.failed = rec("wallPanel", k);
    const from = { x: b.width / 2 + 0.3, y: 1.5, z: -b.depth / 2 + 0.2 };
    const to = { x: b.width / 2 - 0.5, y: 1.5, z: -b.depth / 2 - 0.3 };
    // A siding strip turned with its 3.8 m length across the front wall: set off from that wall
    // by its box, its center would jump 1.9 m off its path.
    const p = piece("siding", from, { x: (to.x - from.x) * 60, y: 0, z: (to.z - from.z) * 60 }, { q: [0, Math.SQRT1_2, 0, Math.SQRT1_2] });
    const f = fieldWith(b, p);
    f.step(1 / 60, still, "open", false, 0, Infinity, targets(b));
    const l = toLocal(b, p.pos);
    expect(l.z).toBeGreaterThan(-b.depth / 2); // still inside the front wall
    expect(l.x).toBeLessThan(b.width / 2); // in through the fallen end wall
    // On the segment it flew (to within 2 cm): never placed across a wall it didn't cross.
    const d = { x: to.x - from.x, z: to.z - from.z };
    const t = ((p.pos.x - from.x) * d.x + (p.pos.z - from.z) * d.z) / (d.x * d.x + d.z * d.z);
    const off = Math.hypot(p.pos.x - (from.x + t * d.x), p.pos.z - (from.z + t * d.z));
    expect(off).toBeLessThan(0.02);
  });
});
