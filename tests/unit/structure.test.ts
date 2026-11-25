import { beforeAll, describe, expect, test } from "vitest";
import { LUMBER, SHEET } from "../../src/config/structure";
import { LAYOUT } from "../../src/config/buildings";
import { plateForce } from "../../src/core/structure/aero";
import { buildFraming } from "../../src/core/structure/framing";
import { attachedToSlab, groupsOf, solveLoadPath } from "../../src/core/structure/loadpath";
import { initRapier, LAB_DT, labHouses, StructureLab } from "../../src/sim/structureLab";
import { LAB } from "../../src/config/structure";
import { PRESETS } from "../../src/config/presets";
import { mphToMs } from "../../src/core/wind/efScale";
import { pressureDeficit } from "../../src/core/wind/pressure";
import { windAt } from "../../src/core/wind/windField";
import { exactHouse } from "../houseHelpers";

const house = () => exactHouse();

/** A point's coordinate along a wall frame's own x axis. */
function qrotInv(fr: { pos: { x: number; z: number }; q: number[] }, p: { x: number; z: number }): number {
  const yaw = 2 * Math.atan2(fr.q[1]!, fr.q[3]!);
  const dx = p.x - fr.pos.x;
  const dz = p.z - fr.pos.z;
  return dx * Math.cos(yaw) - dz * Math.sin(yaw);
}

describe("Spec 09 — structural physics", () => {
  beforeAll(async () => {
    await initRapier();
  });

  test("STR-01: framing has the specified members inside the envelope, drywalled inside", () => {
    const b = house();
    const f = buildFraming(b);
    const frames = f.members.filter((m) => m.kind === "wallFrame");
    expect(frames.length).toBe(b.panels.length);
    const extent = (m: { collision: { pos: { x: number }; size: number[] }[] }) => [
      Math.min(...m.collision.map((s) => s.pos.x - s.size[0]! / 2)),
      Math.max(...m.collision.map((s) => s.pos.x + s.size[0]! / 2)),
    ];
    const td = LUMBER.stud[1];
    frames.forEach((fr, i) => {
      const p = b.panels[i]!;
      // Corners: long (eave) walls run through to the outside corner, end walls butt between them.
      const faceLen = p.face % 2 === 0 ? b.depth : b.width;
      const corner = (end: number) => Math.abs(p.u + (end * p.len) / 2) >= faceLen / 2 - 1e-6;
      const ext = p.face % 2 === 1 ? td / 2 : -td / 2;
      const [x0, x1] = extent(fr);
      expect(x0!).toBeCloseTo(-p.len / 2 - (corner(-1) ? ext : 0), 9);
      expect(x1!).toBeCloseTo(p.len / 2 + (corner(1) ? ext : 0), 9);
      // Vertical members (studs, jacks, cripples) at no more than 0.6 m apart along the wall.
      const xs = fr.shapes.filter((s) => s.size[1] > s.size[0]).map((s) => s.pos.x).sort((a, b) => a - b);
      expect(xs[0]!).toBeLessThan(x0! + LUMBER.stud[0]);
      expect(xs[xs.length - 1]!).toBeGreaterThan(x1! - LUMBER.stud[0]);
      for (let k = 1; k < xs.length; k++) expect(xs[k]! - xs[k - 1]!).toBeLessThanOrEqual(LUMBER.spacing + 1e-6);
    });
    // Wall sheathing and drywall cover each panel (less its openings).
    for (let i = 0; i < b.panels.length; i++) {
      const p = b.panels[i]!;
      const fr = frames[i]!;
      const sheets = f.members.filter((m) => m.kind === "wallSheet" && f.connections.some((c) => c.from === m.id && c.to === fr.id));
      const area = sheets.reduce((a, m) => a + m.area, 0);
      // Wall solid = frame (above the plate) + its sill plate; openings are what's left.
      const sill = f.members.find((m) => m.kind === "sillPlate" && m.panel === i)!;
      const solidArea = fr.collision.reduce((a, s) => a + s.size[0] * s.size[1], 0) + sill.collision.reduce((a, s) => a + s.size[0] * s.size[1], 0);
      const openings = p.len * b.wallHeight - solidArea + (extent(fr)[1]! - extent(fr)[0]! - p.len) * b.wallHeight;
      // Sheathing spans the panel plus any corner overlap, less openings and trim-covered strips.
      const span = (sh: typeof sheets) => {
        const ends = sh.flatMap((m) => m.shapes.flatMap((s) => [qrotInv(fr, m.pos) + s.pos.x - s.size[0] / 2, qrotInv(fr, m.pos) + s.pos.x + s.size[0] / 2]));
        return [Math.min(...ends), Math.max(...ends)];
      };
      const [s0, s1] = span(sheets);
      const gross = (s1! - s0!) * b.wallHeight;
      // Notched sheets: the cover is complete (no gaps at the openings' edges).
      expect(area).toBeCloseTo(gross - openings, 6);
      // Drywall lines the inside face, cut the same way.
      const dry = f.members.filter((m) => m.kind === "drywall" && f.connections.some((c) => c.from === m.id && c.to === fr.id));
      const [d0, d1] = span(dry);
      expect(dry.reduce((a, m) => a + (m.plate ?? 0), 0)).toBeCloseTo((d1! - d0!) * b.wallHeight - openings, 6);
      // At outside corners the long wall's sheathing covers the end wall's edge.
      const faceLen = p.face % 2 === 0 ? b.depth : b.width;
      if (p.face % 2 === 1 && Math.abs(p.u + p.len / 2) >= faceLen / 2 - 1e-6) expect(s1!).toBeCloseTo(p.len / 2 + td / 2 + SHEET.thickness, 9);
      const solid = fr.collision.reduce((a, s) => a + s.size[0] * s.size[1], 0);
      if (p.isGarage) expect(openings).toBeCloseTo(Math.min(LAYOUT.garageWidth, p.len * 0.9) * LAYOUT.garageHeight, 6);
      expect(solid).toBeGreaterThan(0);
      for (const s of sheets)
        for (const sh of s.shapes) {
          expect(sh.size[0]).toBeLessThanOrEqual(SHEET.maxShort + 1e-9);
          expect(sh.size[1]).toBeLessThanOrEqual(SHEET.maxLong + 1e-9);
        }
    }
    const rafters = f.members.filter((m) => m.kind === "rafterPair");
    expect(rafters.length).toBe(Math.floor((b.width - LUMBER.rafter[0]) / LUMBER.spacing + 1e-9) + 1);
    for (const r of rafters) expect(r.shapes.length).toBe(3); // two rafters + ceiling joist
    expect(f.members.filter((m) => m.kind === "fascia").length).toBe(4); // fascia + soffit per eave
    // Shingles cover every roof sheet (2 × 2 patches).
    const shingles = f.members.filter((m) => m.kind === "roofShingle");
    expect(shingles.length).toBe(4 * f.members.filter((m) => m.kind === "roofSheet").length);
    // Gable ends on both end walls, with sheathing; interior walls including the core room.
    expect(f.members.filter((m) => m.kind === "gableFrame").length).toBe(2);
    const gableSheets = f.members.filter((m) => m.kind === "wallSheet" && f.connections.some((c) => c.from === m.id && f.members[c.to]?.kind === "gableFrame"));
    expect(gableSheets.length).toBe(4); // two triangles per gable end
    for (const g of gableSheets) {
      expect(g.shapes[0]!.tri).toBeTruthy();
      expect(g.area).toBeCloseTo((b.depth / 2) * (b.roofRise + LUMBER.rafter[1]) / 2, 9);
    }
    // Ceiling drywall covers the footprint.
    const ceil = f.members.filter((m) => m.kind === "ceiling");
    expect(ceil.reduce((a, m) => a + m.shapes[0]!.size[0] * m.shapes[0]!.size[2], 0)).toBeCloseTo(b.width * b.depth, 6);
    expect(f.members.filter((m) => m.kind === "partition").length).toBe(b.hasGarage ? 8 : 6);
    const roof = f.members.filter((m) => m.kind === "roofSheet");
    const slope = Math.hypot(b.depth / 2 + LAYOUT.overhang, (b.roofRise * (b.depth / 2 + LAYOUT.overhang)) / (b.depth / 2));
    expect(roof.reduce((a, m) => a + m.area, 0)).toBeCloseTo(2 * (b.width + 2 * LAYOUT.overhang) * slope, 6);
    const ridge = 0.3 + b.wallHeight + b.roofRise;
    for (const m of f.members) {
      expect(Math.abs(m.pos.x)).toBeLessThanOrEqual(b.width / 2 + LAYOUT.overhang + 0.1);
      expect(Math.abs(m.pos.z)).toBeLessThanOrEqual(b.depth / 2 + LAYOUT.overhang + 0.1);
      expect(m.pos.y).toBeLessThanOrEqual(ridge + 0.2);
      expect(m.pos.y).toBeGreaterThan(0);
    }
  });

  test("STR-02: the connection graph is acyclic and everything reaches the slab", () => {
    const f = buildFraming(house());
    for (const c of f.connections) {
      if (c.to >= 0) expect(f.members[c.from]!.level).toBeGreaterThan(f.members[c.to]!.level);
    }
    expect(attachedToSlab(f, f.connections.map(() => true)).every(Boolean)).toBe(true);
  });

  test("STR-03: load-path equilibrium", () => {
    const f = buildFraming(house());
    const forces = f.members.map((m, i) => ({ x: Math.sin(i) * 100, y: -m.mass * 9.81 + Math.cos(i) * 50, z: Math.sin(i * 0.7) * 80 }));
    const res = solveLoadPath(f, forces, f.connections.map(() => true));
    const sum = forces.reduce((a, v) => ({ x: a.x + v.x, y: a.y + v.y, z: a.z + v.z }), { x: 0, y: 0, z: 0 });
    for (const k of ["x", "y", "z"] as const) expect(Math.abs(res.toRoots[k] - sum[k])).toBeLessThan(1e-6 * Math.max(1, Math.abs(sum[k])));
  });

  test("STR-04: a member's load splits equally among its intact supports", () => {
    const f = buildFraming(house());
    const sheet = f.members.find((m) => m.kind === "roofSheet" && f.supportsOf[m.id]!.length >= 3)!;
    const forces = f.members.map(() => ({ x: 0, y: 0, z: 0 }));
    forces[sheet.id] = { x: 0, y: 900, z: 0 };
    const res = solveLoadPath(f, forces, f.connections.map(() => true));
    const sup = f.supportsOf[sheet.id]!;
    for (const c of sup) expect(res.vectors[c]!.y).toBeCloseTo(900 / sup.length, 9);
  });

  test("STR-05: failures detach exactly the members that lose every path to the slab", () => {
    const f = buildFraming(house());
    const intact = f.connections.map(() => true);
    const frame = f.members.find((m) => m.kind === "sillPlate")!; // the wall's anchored base
    const anchor = f.supportsOf[frame.id]!.find((c) => f.connections[c]!.to === -1)!;
    // Overload the anchor: a big upward pull on the sill plate.
    const forces = f.members.map(() => ({ x: 0, y: 0, z: 0 }));
    forces[frame.id] = { x: 0, y: f.connections[anchor]!.capacity * 2, z: 0 };
    const res = solveLoadPath(f, forces, intact);
    expect(res.failed).toContain(anchor);
    intact[anchor] = false;
    const att = attachedToSlab(f, intact);
    const loose = f.members.filter((m) => !att[m.id]).map((m) => m.id);
    // The sill plate and everything resting only on it, directly or through other such members
    // (the wall frame, its sheathing and the siding on it, panes, doors, trim).
    const onFrame = new Set([frame.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const m of f.members)
        if (!onFrame.has(m.id) && f.supportsOf[m.id]!.length > 0 && f.supportsOf[m.id]!.every((c) => onFrame.has(f.connections[c]!.to))) {
          onFrame.add(m.id);
          grew = true;
        }
    }
    expect(new Set(loose)).toEqual(onFrame);
    const groups = groupsOf(f, intact, loose);
    expect(groups.length).toBe(1); // still nailed together
  });

  test("STR-06: plate aerodynamics", () => {
    const n = { x: 0, y: 0, z: 1 };
    const edge = plateForce(n, 2, { x: 30, y: 0, z: 0 });
    expect(Math.abs(edge.z)).toBeLessThan(1e-9);
    const face = plateForce(n, 2, { x: 0, y: 0, z: 30 });
    const tilted = plateForce(n, 2, { x: 30 * Math.SQRT1_2, y: 0, z: 30 * Math.SQRT1_2 });
    expect(face.z).toBeGreaterThan(tilted.z);
    expect(face.x).toBe(0);
    expect(face.z).toBeCloseTo(0.5 * 1.2 * 1.2 * 2 * 900, 6);
  });

  test("STR-07: roof goes before walls; loose members come to rest on the ground", () => {
    const lab = new StructureLab(house());
    for (let mph = 40; mph <= 140; mph += 2) {
      lab.setWind(mph, 30);
      for (let i = 0; i < 30; i++) lab.step();
    }
    const firstRoof = lab.failures.findIndex((x) => x.member === "rafterPair" || x.member === "roofSheet" || x.member === "roofShingle");
    const firstWall = lab.failures.findIndex((x) => x.member === "wallFrame");
    expect(firstRoof).toBeGreaterThanOrEqual(0);
    if (firstWall >= 0) expect(lab.failures[firstRoof]!.time).toBeLessThanOrEqual(lab.failures[firstWall]!.time);
    lab.setWind(0, 30);
    for (let i = 0; i < 60 * 15; i++) lab.step();
    expect(lab.lostWhy).toEqual({});
    expect(lab.lostMembers).toBe(0);
    for (const m of lab.framing.members) {
      if (lab.lost[m.id]) continue;
      // Every part of it (each shape's center) is above the ground.
      const p = lab.memberPose(m.id);
      const [x, y, z, w] = p.q;
      for (const sh of m.shapes) {
        const v = sh.pos;
        const rotY = v.y * (1 - 2 * (x * x + z * z)) + v.x * 2 * (x * y + w * z) + v.z * 2 * (y * z - w * x);
        expect(p.pos.y + rotY, `${m.kind} ${m.id}`).toBeGreaterThan(-0.05);
      }
    }
    lab.dispose();
  }, 120000);

  test("STR-09: local vs averaged pressures, deck under shingles, sheltered interior walls", () => {
    const f = buildFraming(house());
    for (const c of f.connections) {
      const k = f.members[c.from]!.kind;
      const m = f.members[c.from]!;
      expect(!!c.cladding).toBe(["wallSheet", "siding", "pane", "garageDoor", "roofSheet", "roofShingle"].includes(k) || (k === "door" && m.face >= 0));
    }
    const lab = new StructureLab(house());
    lab.setWind(60, 30);
    const forces = (local: boolean) => lab.house.attachedForces(local, lab.windAtHeight(lab.building.roofHeight));
    const local = forces(true);
    const avg = forces(false);
    const lf = lab.framing;
    const corner = lf.members.find((m) => m.kind === "roofShingle" && m.edge)!;
    const field = lf.members.find((m) => m.kind === "roofShingle" && !m.edge)!;
    const up = (v: { y: number }, m: { mass: number }) => v.y + m.mass * 9.81;
    expect(up(local[corner.id]!, corner)).toBeGreaterThan(up(local[field.id]!, field)); // corner suction
    expect(up(avg[corner.id]!, corner)).toBeCloseTo(up(avg[field.id]!, field) * (corner.area / field.area), 6); // averaged: same pressure
    // A fully shingled sheet carries no direct wind (only its weight).
    const sheet = lf.members.find((m) => m.kind === "roofSheet")!;
    expect(local[sheet.id]!.y).toBeCloseTo(-sheet.mass * 9.81, 6);
    // Interior walls: no wind while the envelope stands.
    for (const p of lf.members.filter((m) => m.kind === "partition")) {
      expect(local[p.id]!.x).toBe(0);
      expect(local[p.id]!.z).toBe(0);
    }
    lab.dispose();
  });

  test("STR-08: the lab is deterministic", () => {
    const run = () => {
      const lab = new StructureLab(house());
      for (let mph = 60; mph <= 110; mph += 2) {
        lab.setWind(mph, 45);
        for (let i = 0; i < 20; i++) lab.step();
      }
      const out = lab.failures.map((x) => [x.label, x.member, x.time.toFixed(6)]);
      lab.dispose();
      return out;
    };
    expect(run()).toEqual(run());
  }, 120000);
});

describe("inertial relief (STR-10)", () => {
  test("STR-10: a free-flying group's internal loads sum to zero and vanish when wind per mass is uniform", async () => {
    const { inertialRelief } = await import("../../src/core/structure/inertia");
    const masses = [10, 30, 5];
    const pos = [{ x: 1, y: 0, z: 0 }, { x: -1, y: 2, z: 0 }, { x: 0, y: 0, z: 3 }];
    const com = { x: 0, y: 0, z: 0 };
    // Wind force proportional to mass: every member accelerates equally, connections carry nothing.
    const uniform = masses.map((m) => ({ x: 2 * m, y: -m, z: 0.5 * m }));
    for (const f of inertialRelief(masses, uniform, pos, com, { x: 0, y: 0, z: 0 })) {
      expect(Math.hypot(f.x, f.y, f.z)).toBeLessThan(1e-9);
    }
    // Wind on one member only: it pulls on the rest, and the loads balance.
    const one = [{ x: 0, y: 900, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
    const r = inertialRelief(masses, one, pos, com, { x: 0, y: 0, z: 0 });
    expect(r[0]!.y).toBeCloseTo(900 * (1 - 10 / 45));
    expect(r.reduce((s, f) => s + f.y, 0)).toBeCloseTo(0);
    // Spin: each member is pulled outward (centrifugal) by m·ω²·r.
    const spin = inertialRelief(masses, masses.map(() => ({ x: 0, y: 0, z: 0 })), pos, com, { x: 0, y: 4, z: 0 });
    expect(spin[0]!.x).toBeCloseTo(10 * 16 * 1);
  });

  test("STR-10: in the lab, flying sections tear apart in flight from wind and spin alone", async () => {
    await initRapier();
    const lab = new StructureLab(exactHouse());
    let inFlight = 0;
    const H = lab.house as any;
    const orig = H.fail.bind(H);
    H.fail = (c: number, load: number) => {
      const conn = lab.framing.connections[c]!;
      const groups = lab.house.groupBodies;
      const contact = H.contact as { x: number; y: number; z: number }[];
      for (const g of groups.values())
        if (g.includes(conn.from) && g.every((id) => contact[id]!.x === 0 && contact[id]!.y === 0 && contact[id]!.z === 0)) inFlight++;
      orig(c, load);
    };
    for (let mph = 60; mph <= 200 && inFlight === 0; mph++) {
      lab.setWind(mph, 30);
      for (let i = 0; i < 30; i++) lab.step();
    }
    expect(inFlight).toBeGreaterThan(0);
  }, 300000);
});

describe("openings, doors and floor plan (STR-11, STR-12)", () => {
  test("STR-11: front, back and interior doors; every room reachable through a doorway; no wall overlaps", async () => {
    const { floorPlan } = await import("../../src/core/structure/framing");
    const b = exactHouse();
    const f = buildFraming(b);
    const ext = f.members.filter((m) => m.kind === "door" && m.face >= 0);
    expect(ext.map((m) => m.face).sort()).toEqual([1, 3]); // back and front
    const plan = floorPlan(b);
    const leaves = plan.flatMap((w) => w.doors.filter((d) => d.leaf !== "none"));
    expect(f.members.filter((m) => m.kind === "door" && m.face < 0).length).toBe(leaves.length);
    // Exterior doors sit in openings: no sheathing in front of them.
    for (const d of ext) {
      // No piece of any sheet on that wall overlaps the door leaf's rectangle.
      const covered = f.members.some((s) => {
        if (s.kind !== "wallSheet" || s.face !== d.face) return false;
        const along = (v: { x: number; z: number }) => (d.face % 2 === 1 ? v.x : v.z) * (d.face === 0 || d.face === 1 ? -1 : 1);
        return s.shapes.some((sh) => {
          const sx = along(s.pos) + sh.pos.x;
          const sy = s.pos.y + sh.pos.y;
          return Math.abs(sx - along(d.pos)) < (sh.size[0] + d.shapes[0]!.size[0]) / 2 - 1e-6 && Math.abs(sy - d.pos.y) < (sh.size[1] + d.shapes[0]!.size[1]) / 2 - 1e-6;
        });
      });
      expect(covered).toBe(false);
    }
    // Rooms: flood-fill a 0.1 m grid of the footprint through doorways; every cell is reachable
    // from the front door, i.e. each room has a door (or cased opening).
    const cell = 0.1;
    const nxC = Math.round(b.width / cell);
    const nzC = Math.round(b.depth / cell);
    const blocked = (x: number, z: number) =>
      plan.some((w) => {
        const [a, c] = w.alongX ? [x, z] : [z, x];
        if (Math.abs(c - w.c) > 0.06 || a < w.a0 - 0.08 || a > w.a1 + 0.08) return false;
        return !w.doors.some((d) => Math.abs(a - d.at) < d.width / 2 - 0.02);
      });
    const seen = new Uint8Array(nxC * nzC);
    const start = ext.find((m) => m.face === 3)!;
    const q = [[Math.floor((start.pos.x + b.width / 2) / cell), 1]];
    seen[q[0]![0]! + q[0]![1]! * nxC] = 1;
    while (q.length) {
      const [i, j] = q.pop()!;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i! + di!;
        const c = j! + dj!;
        if (a < 0 || c < 0 || a >= nxC || c >= nzC || seen[a + c * nxC]) continue;
        if (blocked(-b.width / 2 + (a + 0.5) * cell, -b.depth / 2 + (c + 0.5) * cell)) continue;
        seen[a + c * nxC] = 1;
        q.push([a, c]);
      }
    }
    let open = 0;
    let reached = 0;
    for (let a = 0; a < nxC; a++)
      for (let c = 0; c < nzC; c++) {
        if (blocked(-b.width / 2 + (a + 0.5) * cell, -b.depth / 2 + (c + 0.5) * cell)) continue;
        open++;
        reached += seen[a + c * nxC]!;
      }
    expect(reached).toBe(open);
    // Interior walls don't intersect each other or the exterior walls.
    for (let i = 0; i < plan.length; i++)
      for (let j = i + 1; j < plan.length; j++) {
        const A = plan[i]!;
        const B = plan[j]!;
        if (A.alongX === B.alongX) continue;
        const [X, Z] = A.alongX ? [A, B] : [B, A];
        const crossX = Z.c > X.a0 - 0.06 && Z.c < X.a1 + 0.06;
        const crossZ = X.c > Z.a0 - 0.06 && X.c < Z.a1 + 0.06;
        expect(crossX && crossZ).toBe(false);
      }
    for (const w of plan) {
      const half = (w.alongX ? b.width : b.depth) / 2;
      expect(Math.max(Math.abs(w.a0), Math.abs(w.a1))).toBeLessThan(half - LUMBER.stud[1] / 2);
    }
  });

  test("STR-12: glass breaks from pressure either way and the whole pane falls apart into shards", async () => {
    const f = buildFraming(exactHouse());
    const shards = f.members.filter((m) => m.kind === "pane");
    const panes = new Set(shards.map((m) => m.pane));
    expect(shards.length).toBe(panes.size * 2 * 3 * 3);
    for (const m of shards) {
      expect(m.shapes[0]!.tri).toBeTruthy();
      const c = f.connections[f.supportsOf[m.id]![0]!]!;
      expect(Math.hypot(c.axis.x, c.axis.y, c.axis.z)).toBe(0); // no bearing side
    }
    // Inward push on one shard past its glazing strength: the shard's pane breaks as a whole.
    await initRapier();
    const lab = new StructureLab(exactHouse());
    const target = shards[0]!;
    const n = target.normal;
    lab.house.addContact(target.id, -n.x * 5000, 0, -n.z * 5000);
    lab.step();
    for (const m of shards) expect(lab.isAttached(m.id)).toBe(m.pane !== target.pane);
    for (const m of shards.filter((s) => s.pane === target.pane)) {
      const others = lab.house.groupBodies;
      expect([...others.values()].find((g) => g.includes(m.id))!.length).toBe(1); // loose shard
    }
    lab.dispose();
  });
});

describe("lab tornado pass (STR-21, STR-22)", () => {
  beforeAll(async () => {
    await initRapier();
  });

  const preset = (id: string) => PRESETS.find((p) => p.id === id)!.params;

  test("STR-21: the pass starts where roof wind is calm, moves straight at mature strength, with the Spec 01/02 wind", () => {
    const lab = new StructureLab(house());
    const b = lab.building;
    // Far off the track: the house never sees damaging wind, so the whole pass is cheap.
    lab.startTornado({ presetId: "ef2-cone", headingDeg: 0, offset: 2000 });
    const p = preset("ef2-cone");
    const s0 = lab.tornado!;
    expect(s0.vMax).toBe(p.vPeak);
    expect(s0.rMax).toBe(p.rMax);
    expect(Math.hypot(s0.velocity.x, s0.velocity.z)).toBeCloseTo(p.translationSpeed!, 9);
    // Heading 0 = +X; positive offset puts the house to the right of the track (+Z for +X travel).
    const along0 = b.x - s0.center.x;
    expect(along0).toBeCloseTo(2 * p.rMax!, 6); // nothing within reach: the 2·R_max minimum
    expect(b.z - s0.center.z).toBeCloseTo(2000, 6);
    for (let i = 0; i < 60; i++) lab.step();
    const s1 = lab.tornado!;
    expect(s1.center.x - s0.center.x).toBeCloseTo(p.translationSpeed! * 60 * LAB_DT, 6);
    expect(s1.center.z).toBeCloseTo(s0.center.z, 9);
    expect(s1.vMax).toBe(p.vPeak);
    // The house feels exactly the tornado's wind and deficit.
    const q = { x: b.x + 3, y: 4, z: b.z - 2 };
    expect(lab.wind.at(q)).toEqual(windAt(q, s1, "open"));
    expect(lab.wind.deficit(b.x, b.z)).toBe(pressureDeficit(Math.hypot(b.x - s1.center.x, b.z - s1.center.z), s1));
    // The pass ends once the tornado is as far past the house as it started before it.
    let steps = 60;
    while (!lab.passDone && steps < 100000) {
      lab.step();
      steps++;
    }
    expect(lab.passDone).toBe(true);
    expect(steps).toBe(Math.ceil((2 * along0) / (p.translationSpeed! * LAB_DT)));
    expect(lab.tornado).toBeNull();
    expect(lab.wind.at(q)).toEqual({ x: 0, y: 0, z: 0 });
    expect(lab.wind.deficit(b.x, b.z)).toBe(0);
    lab.dispose();
  }, 120000);

  test("STR-21: on a close track the start is the nearest point where roof wind is under 50 mph", () => {
    const lab = new StructureLab(house());
    const b = lab.building;
    lab.startTornado({ presetId: "ef4-wedge", headingDeg: 90, offset: 0 });
    const s = lab.tornado!;
    // No APC jump: the inside pressure starts equal to the outside.
    expect(lab.wind.deficit(b.x, b.z)).toBeGreaterThan(50);
    lab.step();
    expect(Math.abs(lab.house.apc)).toBeLessThan(5);
    // Heading 90°: travel toward −Z (counter-clockwise from +X seen from above).
    expect(s.velocity.z).toBeLessThan(0);
    const d = s.center.z - b.z;
    expect(d).toBeGreaterThanOrEqual(2 * s.rMax);
    const roof = (state: typeof s) => {
      const w = windAt({ x: b.x, y: b.roofHeight, z: b.z }, state, "open");
      return Math.hypot(w.x, w.y, w.z);
    };
    expect(roof(s)).toBeLessThan(mphToMs(50));
    const nearer = { ...s, center: { x: s.center.x, z: s.center.z - 10 } };
    expect(roof(nearer)).toBeGreaterThanOrEqual(mphToMs(50));
    lab.dispose();
  });

  test("STR-22: a lab tornado pass is deterministic", () => {
    const run = () => {
      const lab = new StructureLab(house());
      // Start inside the damaging winds so a short run already tears pieces off.
      lab.startTornado({ presetId: "ef3-strong", headingDeg: 20, offset: 60, startDistance: 1.3 * preset("ef3-strong").rMax! });
      for (let i = 0; i < 150; i++) lab.step();
      const out = lab.failures.map((x) => [x.label, x.member, x.time.toFixed(6)]);
      lab.dispose();
      return out;
    };
    const a = run();
    expect(a.length).toBeGreaterThan(0);
    expect(run()).toEqual(a);
  }, 120000);
});

describe("lab house count (STR-23)", () => {
  beforeAll(async () => {
    await initRapier();
  });

  test("STR-23: N houses in a centered grid at lot spacing, one shared world, calm start at every house", () => {
    for (const n of [1, 4, 5, LAB.maxHouses]) {
      const bs = labHouses(n, "standard");
      expect(bs.length).toBe(n);
      const cols = Math.ceil(Math.sqrt(n));
      const xs = [...new Set(bs.map((b) => b.x))].sort((a, b) => a - b);
      const zs = [...new Set(bs.map((b) => b.z))].sort((a, b) => a - b);
      expect(xs.length).toBe(Math.min(cols, n));
      for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeCloseTo(LAB.lotSpacing, 9);
      for (let i = 1; i < zs.length; i++) expect(zs[i]! - zs[i - 1]!).toBeCloseTo(LAB.lotSpacing, 9);
      // Centered: the grid's extents are symmetric about the origin.
      expect(xs[0]! + xs[xs.length - 1]!).toBeCloseTo(0, 9);
      expect(zs[0]! + zs[zs.length - 1]!).toBeCloseTo(0, 9);
    }
    const bs = labHouses(4, "standard");
    const lab = new StructureLab(bs);
    expect(lab.houses.length).toBe(4);
    expect(lab.sw.houses).toEqual(lab.houses);
    lab.startTornado({ presetId: "ef4-wedge", headingDeg: 0, offset: 0 });
    const s = lab.tornado!;
    for (const b of bs) {
      const w = windAt({ x: b.x, y: b.roofHeight, z: b.z }, s, "open");
      expect(Math.hypot(w.x, w.y, w.z)).toBeLessThan(mphToMs(50));
    }
    // The nearest start: 10 m closer, some house would already feel 50 mph (or it's the minimum).
    const nearer = { ...s, center: { x: s.center.x + 10, z: s.center.z } };
    const max = Math.max(...bs.map((b) => {
      const w = windAt({ x: b.x, y: b.roofHeight, z: b.z }, nearer, "open");
      return Math.hypot(w.x, w.y, w.z);
    }));
    expect(max).toBeGreaterThanOrEqual(mphToMs(50));
    lab.dispose();
  });
});

describe("Spec 09 slice C — load-path mechanics (STR-25)", () => {
  beforeAll(async () => {
    await initRapier();
  });

  test("STR-25: roof MWFRS coefficients by slope and wind angle", async () => {
    const { roofMwfrsCp } = await import("../../src/sim/structureWorld");
    const W = 14;
    const h = 4;
    const across = { x: 0, y: 0, z: 1 }; // wind toward +z: the −z slope is windward
    expect(roofMwfrsCp({ x: 0, y: 4, z: -2 }, across, W, h)).toBeCloseTo(-0.7, 9);
    expect(roofMwfrsCp({ x: 0, y: 4, z: 2 }, across, W, h)).toBeCloseTo(-0.6, 9);
    const along = { x: 1, y: 0, z: 0 }; // toward +x: the −x gable is windward
    expect(roofMwfrsCp({ x: -W / 2 + 1, y: 4, z: 1 }, along, W, h)).toBeCloseTo(-0.9, 9);
    expect(roofMwfrsCp({ x: -W / 2 + 6, y: 4, z: 1 }, along, W, h)).toBeCloseTo(-0.5, 9);
    expect(roofMwfrsCp({ x: W / 2 - 1, y: 4, z: 1 }, along, W, h)).toBeCloseTo(-0.3, 9);
    const diag = { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 };
    expect(roofMwfrsCp({ x: -W / 2 + 1, y: 4, z: -2 }, diag, W, h)).toBeCloseTo(0.5 * -0.7 + 0.5 * -0.9, 9);
  });

  test("STR-25: braced walls share with the diaphragm; unbraced ones overturn, helped by standing neighbors", () => {
    const lab = new StructureLab(house());
    const H = lab.house as any;
    const f = lab.framing;
    const frame = f.members.filter((m) => m.kind === "wallFrame" && m.face === 3)[1]!; // a front wall panel
    const out = { x: frame.normal.x * 1000, y: 0, z: frame.normal.z * 1000 };
    const along = (v: { x: number; z: number }) => v.x * frame.normal.x + v.z * frame.normal.z;
    expect(along(H.diaphragm()(frame.id, out))).toBeCloseTo(500, 6); // braced: half goes up
    // Take away the rafters bearing on it: unbraced, so its base sees the overturning demand.
    for (const c of f.carriesOf[frame.id]!) if (f.members[f.connections[c]!.from]!.kind === "rafterPair") H.attached[f.connections[c]!.from] = false;
    const k1 = along(H.diaphragm()(frame.id, out)) / 1000;
    expect(k1).toBeGreaterThan(1);
    // Fewer standing neighbors → weaker base → bigger effective demand.
    const neighbors = f.members.filter((m) => m.kind === "wallFrame" && m.face === 3 && m.id !== frame.id);
    for (const m of neighbors) H.attached[m.id] = false;
    const k0 = along(H.diaphragm()(frame.id, out)) / 1000;
    expect(k0).toBeGreaterThan(k1);
    lab.dispose();
  });

  test("STR-25: rafter hold-downs fail by their neighborhood's mean demand", () => {
    const lab = new StructureLab(house());
    const H = lab.house as any;
    const hd = H.rafterHoldDowns();
    const list: number[][] = hd.byWall.get(3);
    const loads = lab.framing.connections.map(() => 0);
    const set = (i: number, ratio: number) => {
      for (const c of list[i]!) loads[c] = ratio * lab.framing.connections[c]!.capacity;
    };
    // One overloaded rafter among comfortable neighbors is held by them…
    list.forEach((_, i) => set(i, 0.5));
    set(5, 1.6);
    expect(H.sharedRafterFailures(loads, hd).length).toBe(0);
    // …but a neighborhood that's overloaded on average lets go together.
    for (let i = 3; i <= 7; i++) set(i, 1.4);
    const failed = new Set(H.sharedRafterFailures(loads, hd).map(([c]: [number]) => c));
    for (const c of list[5]!) expect(failed.has(c)).toBe(true);
    lab.dispose();
  });

  test("STR-25: siding feels no APC; a house enters in APC equilibrium; variability is deterministic", () => {
    const lab = new StructureLab(house());
    const f = lab.framing;
    const forces = lab.house.attachedForces(true, { x: 0, y: 0, z: 0 }, 500);
    const siding = f.members.find((m) => m.kind === "siding")!;
    expect(forces[siding.id]!.x).toBeCloseTo(0, 9);
    expect(forces[siding.id]!.z).toBeCloseTo(0, 9);
    const pane = f.members.find((m) => m.kind === "pane")!; // envelope: pushed out by 500 Pa
    expect(Math.hypot(forces[pane.id]!.x, forces[pane.id]!.z)).toBeCloseTo(500 * pane.area, 6);
    // Equilibrium start: a steady outside deficit from the first step gives no push.
    const sw = lab.sw;
    sw.step({ at: () => ({ x: 0, y: 0, z: 0 }), deficit: () => 3000 });
    expect(lab.house.apc).toBeCloseTo(0, 6);
    // Variability: the same house gets the same capacities; another house different ones.
    const a = buildFraming(house());
    const b = buildFraming(house());
    expect(a.connections.map((c) => c.capacity)).toEqual(b.connections.map((c) => c.capacity));
    const other = buildFraming({ ...house(), id: 99 });
    expect(other.connections.map((c) => c.capacity)).not.toEqual(a.connections.map((c) => c.capacity));
    expect(a.weakest).toBeLessThan(1);
    expect(Math.min(...a.connections.map((c, i) => c.capacity / buildFraming(house(), { scatter: false }).connections[i]!.capacity))).toBeCloseTo(a.weakest, 9);
    lab.dispose();
  });
});

describe("Spec 09 — detail zone performance", () => {
  beforeAll(initRapier);

  test("STR-27: wind on rigid pieces from body-frame plates equals the per-member world-pose computation", async () => {
    const { bodyPlates, plateExtent, plateNormal, rigidAero } = await import("../../src/core/structure/aero");
    const { qmul, qrot } = await import("../../src/core/structure/framing");
    const f = buildFraming(house());
    // A loose roof chunk and a wall section, tumbling through a sheared wind.
    const ext = f.members.map((m) => (m.area > 0 || (m.plate ?? 0) > 0 ? plateExtent(m.shapes) : null));
    const groups = [f.members.filter((m) => m.kind === "roofSheet" || m.kind === "roofShingle").slice(0, 12).map((m) => m.id), f.members.filter((m) => m.panel === 2).map((m) => m.id)];
    const s = (() => {
      const a = 0.7;
      const q: [number, number, number, number] = [Math.sin(a / 2) * 0.6, Math.sin(a / 2) * 0.8, 0, Math.cos(a / 2)];
      return { t: { x: 3, y: 4, z: -2 }, q, com: { x: 4, y: 5, z: -1 }, v: { x: 12, y: 3, z: -5 }, w: { x: 1.5, y: -2, z: 0.7 } };
    })();
    const wind = (p: { x: number; y: number; z: number }) => ({ x: 40 + 0.5 * p.y, y: 8 - 0.2 * p.x, z: -15 + 0.3 * p.z });
    for (const group of groups) {
      const plates = bodyPlates(f.members, group, ext);
      const forces: { x: number; y: number; z: number }[] = [];
      const got = rigidAero(s, plates, wind, null, forces);
      // Reference: each member's world pose, as the detail engine did before.
      const F = { x: 0, y: 0, z: 0 };
      const T = { x: 0, y: 0, z: 0 };
      const { AIR_DENSITY } = await import("../../src/config/atmosphere");
      const { PLATE } = await import("../../src/config/structure");
      const k = 0.5 * AIR_DENSITY * PLATE.normalCoeff;
      for (const id of group) {
        const m = f.members[id]!;
        const area = m.area > 0 ? m.area : (m.plate ?? 0);
        if (area <= 0) continue;
        const o = qrot(s.q, m.pos);
        const pos = { x: s.t.x + o.x, y: s.t.y + o.y, z: s.t.z + o.z };
        const mq = qmul(s.q, m.q);
        const n = qrot(mq, plateNormal(m));
        const r = { x: pos.x - s.com.x, y: pos.y - s.com.y, z: pos.z - s.com.z };
        const w = s.w;
        const vp = { x: s.v.x + (w.y * r.z - w.z * r.y), y: s.v.y + (w.z * r.x - w.x * r.z), z: s.v.z + (w.x * r.y - w.y * r.x) };
        const wd = wind(pos);
        const fm = plateForce(n, area, { x: wd.x - vp.x, y: wd.y - vp.y, z: wd.z - vp.z });
        F.x += fm.x;
        F.y += fm.y;
        F.z += fm.z;
        T.x += r.y * fm.z - r.z * fm.y;
        T.y += r.z * fm.x - r.x * fm.z;
        T.z += r.x * fm.y - r.y * fm.x;
        const e = ext[id];
        if (e) {
          const ax = qrot(mq, e.a);
          const bx = qrot(mq, e.b);
          const wa = w.x * ax.x + w.y * ax.y + w.z * ax.z;
          const wb = w.x * bx.x + w.y * bx.y + w.z * bx.z;
          const ta = (-k * e.la * wa * Math.abs(wa) * e.lb ** 4) / 32;
          const tb = (-k * e.lb * wb * Math.abs(wb) * e.la ** 4) / 32;
          T.x += ax.x * ta + bx.x * tb;
          T.y += ax.y * ta + bx.y * tb;
          T.z += ax.z * ta + bx.z * tb;
        }
      }
      const rel = (a: number, b: number, scale: number) => Math.abs(a - b) / scale;
      const fs = Math.hypot(F.x, F.y, F.z);
      const ts = Math.hypot(T.x, T.y, T.z);
      expect(fs).toBeGreaterThan(100);
      for (const c of ["x", "y", "z"] as const) {
        expect(rel(got.force[c], F[c], fs)).toBeLessThan(1e-9);
        expect(rel(got.torque[c], T[c], ts)).toBeLessThan(1e-9);
      }
    }
  });

  test("STR-26: still pieces become fixed rubble where they lie; wind and a touching piece waking wake them", () => {
    const lab = new StructureLab(house());
    const h = lab.house;
    const world = lab.sw.world;
    for (let mph = 60; mph <= 150; mph += 3) {
      lab.setWind(mph, 30);
      for (let i = 0; i < 30; i++) lab.step();
    }
    lab.setWind(0, 30);
    // Each step: a group that turns into rubble keeps its exact pose.
    let retired = 0;
    for (let i = 0; i < 60 * 15; i++) {
      const before = new Map<number, ReturnType<typeof lab.memberPose>[]>();
      for (const [handle, group] of h.groupBodies) before.set(handle, group.map((id) => lab.memberPose(id)));
      lab.step();
      for (const [handle, poses] of before) {
        if (!h.rubble.has(handle)) continue;
        retired++;
        const group = h.rubble.get(handle)!;
        group.forEach((id, k) => {
          const p = lab.memberPose(id);
          expect(Math.hypot(p.pos.x - poses[k]!.pos.x, p.pos.y - poses[k]!.pos.y, p.pos.z - poses[k]!.pos.z)).toBeLessThan(1e-9);
        });
      }
    }
    // (A sample of pieces turning into rubble: ~4–8 with Spec 09 v0.12's sill nailing.)
    expect(retired).toBeGreaterThan(3);
    // Rubble is fixed and touches only fixed things.
    for (const [handle] of h.rubble) expect(world.getRigidBody(handle).isFixed()).toBe(true);
    // A pile wakes together: waking one piece wakes the rubble touching it.
    let pair: [number, number] | null = null;
    for (const [handle] of h.rubble) {
      const body = world.getRigidBody(handle);
      const touching = lab.sw.rubbleTouching(Array.from({ length: body.numColliders() }, (_, i) => body.collider(i)));
      if (touching.length) {
        pair = [handle, touching[0]![1]];
        break;
      }
    }
    expect(pair).not.toBeNull();
    const [base, top] = pair!;
    const tb = world.getRigidBody(top);
    h.wakeRubble(base);
    expect(h.rubble.has(base)).toBe(false);
    expect(h.rubble.has(top)).toBe(false);
    expect(tb.isDynamic()).toBe(true);
    expect(Math.hypot(tb.linvel().x, tb.linvel().y, tb.linvel().z)).toBe(0);
    // Wind that can move it brings rubble back to life. (What's left after the 150 mph ramp
    // is what 150 mph couldn't move, so the test wind has to be clearly stronger.)
    const n = h.rubble.size;
    lab.setWind(250, 30);
    for (let i = 0; i < 30; i++) lab.step();
    expect(h.rubble.size).toBeLessThan(n);
    lab.dispose();
  }, 240000);

  test("STR-28: entering houses are built over several steps; an incomplete house carries no loads", async () => {
    const { StructureWorld } = await import("../../src/sim/structureWorld");
    const { DETAIL } = await import("../../src/config/structure");
    const bs = [house(), { ...house(), id: 7, x: 30 }, { ...house(), id: 8, x: 60 }];
    const storm = { at: () => ({ x: 120, y: 0, z: 0 }), deficit: () => 8000 };
    const sw = new StructureWorld();
    const hs = bs.map((b) => sw.addHouse(b, undefined, true));
    const count = () => sw.world.colliders.len();
    let prev = count();
    let steps = 0;
    while (!hs.every((h) => h.complete)) {
      sw.step(storm);
      steps++;
      expect(count() - prev).toBeLessThanOrEqual(DETAIL.buildCollidersPerStep);
      prev = count();
      // Until complete, a house carries no loads: nothing fails, however strong the wind.
      for (const h of hs) if (!h.complete) expect(h.failures.length).toBe(0);
    }
    expect(steps).toBeGreaterThan(3);
    // The completed houses have the same colliders as houses built at once.
    const ref = new StructureWorld();
    bs.forEach((b) => ref.addHouse(b));
    const boxes = (w: InstanceType<typeof StructureWorld>) => {
      const out: string[] = [];
      w.world.forEachCollider((c) => {
        const t = c.translation();
        out.push(`${t.x.toFixed(6)},${t.y.toFixed(6)},${t.z.toFixed(6)},${c.mass().toFixed(6)}`);
      });
      return out.sort();
    };
    // (Compare before the storm moves anything: rebuild the gradual world in calm air.)
    const calm = { at: () => ({ x: 0, y: 0, z: 0 }), deficit: () => 0 };
    const sw2 = new StructureWorld();
    const hs2 = bs.map((b) => sw2.addHouse(b, undefined, true));
    while (!hs2.every((h) => h.complete)) sw2.step(calm);
    expect(boxes(sw2)).toEqual(boxes(ref));
    expect(hs2.map((h) => h.framing.members.length)).toEqual(ref.houses.map((h) => h.framing.members.length));
    sw.dispose();
    sw2.dispose();
    ref.dispose();
  });
  test("STR-31: once part of a roof is gone, the rest follows: suction is measured from the standing roof's windward edge", async () => {
    const { windwardEdgeDistance } = await import("../../src/sim/structureWorld");
    // Rafters every 0.6 m on a 12 m roof, wind toward +x: the windward end is x = −6.
    const xs = Array.from({ length: 21 }, (_, i) => -6 + i * 0.6);
    expect(windwardEdgeDistance(0, xs, 1, 12, 0.9)).toBeCloseTo(6, 9); // whole roof: from the gable
    // The windward third gone: the edge moves to where the roof now starts (half a bay beyond).
    const rest = xs.filter((x) => x > -2);
    expect(windwardEdgeDistance(0, rest, 1, 12, 0.9)).toBeCloseTo(0 - rest[0]! + 0.3, 9);
    // A gap in the middle: points behind it see an edge at the gap.
    const holed = xs.filter((x) => x < -1 || x > 1);
    expect(windwardEdgeDistance(3, holed, 1, 12, 0.9)).toBeCloseTo(3 - holed.find((x) => x > 1)! + 0.3, 9);
    // Wind the other way: measured from the +x end.
    expect(windwardEdgeDistance(0, xs, -1, 12, 0.9)).toBeCloseTo(6, 9);

    // A lab house in a rising wind: from a third of the rafters gone to two thirds, and half the
    // walls down, within ~15 mph (DI 2: roof structure 122 → exterior walls 132 mph), from any
    // direction. (A ramp, stopped as soon as both happen: about a second.)
    for (const dir of [0, 30, 90]) {
      const lab = new StructureLab(house());
      const h = lab.house;
      const raf = h.framing.members.filter((m) => m.kind === "rafterPair");
      const frames = h.framing.members.filter((m) => m.kind === "wallFrame");
      let third = 0;
      let twoThirds = 0;
      let walls = 0;
      for (let mph = 90; mph <= 220 && !(twoThirds && walls); mph += 2) {
        lab.setWind(mph, dir);
        for (let i = 0; i < 15; i++) lab.step();
        const gone = raf.filter((m) => !h.isAttached(m.id)).length / raf.length;
        if (gone >= 1 / 3) third ||= mph;
        if (gone >= 2 / 3) twoThirds ||= mph;
        if (frames.filter((m) => !h.isAttached(m.id)).length >= frames.length / 2) walls ||= mph;
      }
      expect(third, `wind ${dir}°`).toBeGreaterThan(0);
      expect(twoThirds - third, `wind ${dir}°: roof follow-through`).toBeLessThanOrEqual(16);
      expect(walls - twoThirds, `wind ${dir}°: walls after the roof`).toBeLessThanOrEqual(16);
      lab.dispose();
    }
  });
});
