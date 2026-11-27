import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { TERRAIN } from "../../src/config/terrain";
import { DEBRIS, TURBULENCE } from "../../src/config/debris";
import {
  betaAt,
  betaFromZ0,
  effZ0At,
  interpByZ0,
  macdonaldZ0,
  tableAt,
  uniformField,
  z0At,
} from "../../src/core/terrain/roughness";
import type { RoughnessField } from "../../src/core/terrain/roughness";
import { fetchDirection, windAt } from "../../src/core/wind/windField";
import { CITY } from "../../src/sim/city";
import { createSim } from "../../src/sim/loop";
import { TownRoughness, townCover } from "../../src/sim/terrain";
import { createWorld } from "../../src/sim/world";
import type { Building } from "../../src/core/damage/types";
import { baseState, hspeed } from "../helpers";
import { betaFromLnZ0, coverAt, effLnZ0, isField, terrainClassOf } from "../../src/core/terrain/roughness";
import { probeAt } from "../../src/core/wind/probe";
import { defaultParams } from "../../src/sim/types";
import { createLab } from "../../src/sim/lab";
import type { LabSetup, LabWind } from "../../src/sim/lab";
import { initRapier } from "../../src/sim/structureWorld";
import { ROUGHNESS_SCALE, roughnessColor, roughnessLayer } from "../../src/render/ground";
import * as THREE from "three";

const EDGE = -CITY.extent / 2;
type Town = { field: RoughnessField; buildings: readonly Building[]; tr: TownRoughness };
let cached: Town | null = null;
function town(): Town {
  if (!cached) {
    const buildings = createWorld(1, true).buildings;
    const tr = new TownRoughness(townCover(CITY.extent), buildings);
    cached = { field: tr.field, buildings, tr };
  }
  return cached;
}

/** Knock a house flat: every wall and roof section gone (as the component model leaves it). */
function flatten(b: Building): void {
  const rec = { part: "wall", index: 0, time: 0, load: 0, capacity: 0, mph: 0, sign: 1, wind: { x: 0, y: 0, z: 0 } } as never;
  for (const p of b.panels) p.failed ??= rec;
  for (const s of b.sections) s.deck ??= rec;
  b.rev++;
}

describe("Spec 17 — terrain roughness", () => {
  test("TERR-01: same seed and layout give an identical field; a run on it is deterministic", () => {
    const a = new TownRoughness(townCover(CITY.extent), createWorld(4, true).buildings).field;
    const b = new TownRoughness(townCover(CITY.extent), createWorld(4, true).buildings).field;
    expect(a.lnZ0).toEqual(b.lnZ0);
    for (let k = 0; k < a.eff.length; k++) expect(a.eff[k]).toEqual(b.eff[k]);
    const run = () => {
      const sim = createSim({ area: { x: 0, z: 0, radius: 250 } }, 7, { vPeak: 70, rMax: 120 });
      sim.advance(0.05);
      for (let i = 0; i < 40; i++) sim.advance(0.1);
      const out = { hist: sim.snapshot.damageHistogram, debris: sim.snapshot.debris, terrain: typeof sim.snapshot.terrain };
      sim.dispose();
      return out;
    };
    const r1 = run();
    expect(r1.terrain).toBe("object");
    expect(run()).toEqual(r1);
  });

  test("TERR-02: Macdonald z₀ matches the formula and its published curve", () => {
    const { A, betaM, cd, kappa } = TERRAIN.macdonald;
    for (const [lp, lf, h] of [[0.1, 0.04, 4], [0.25, 0.2, 10], [0.4, 0.3, 30]] as const) {
      const dh = 1 + Math.pow(A, -lp) * (lp - 1);
      const want = h * (1 - dh) * Math.exp(-Math.pow(0.5 * betaM * (cd / kappa ** 2) * (1 - dh) * lf, -0.5));
      expect(Math.abs(macdonaldZ0(lp, lf, h) - want) / want).toBeLessThan(1e-9);
    }
    // λp = λf = λ: z₀/h rises to a peak of ~0.1–0.15 near λ ≈ 0.15–0.2, then falls.
    let best = 0;
    let at = 0;
    for (let l = 0.05; l <= 0.6; l += 0.005) {
      const r = macdonaldZ0(l, l, 1);
      if (r > best) (best = r), (at = l);
    }
    expect(best).toBeGreaterThan(0.1);
    expect(best).toBeLessThan(0.15);
    expect(at).toBeGreaterThan(0.1);
    expect(at).toBeLessThan(0.22);
    expect(macdonaldZ0(0.5, 0.5, 1)).toBeLessThan(best);
    // An empty window is its cover: far out on the farmland, z₀ = 0.03 m.
    expect(z0At(town().field, EDGE - 1200, 0)).toBeCloseTo(TERRAIN.z0Cover.farmland, 5);
  });

  test("TERR-03: the default town is suburban inside; farmland around it is open", () => {
    const { field } = town();
    const inner = CITY.extent / 2 - 1000;
    for (let x = -inner; x <= inner; x += 20) {
      for (let z = -inner; z <= inner; z += 20) {
        const z0 = z0At(field, x, z);
        expect(z0).toBeGreaterThanOrEqual(0.1);
        expect(z0).toBeLessThanOrEqual(0.4);
      }
    }
    for (const [x, z] of [[EDGE - 1000, 0], [0, EDGE - 1200], [-EDGE + 1100, 300]] as const) expect(z0At(field, x, z)).toBeCloseTo(0.03, 5);
  });

  test("TERR-04: β(z₀) through 0.11 / 0.22 / 0.33, monotonic, clamped; tables at their anchors", () => {
    expect(betaFromZ0(0.03)).toBeCloseTo(0.11, 12);
    expect(betaFromZ0(0.3)).toBeCloseTo(0.22, 12);
    expect(betaFromZ0(3)).toBeCloseTo(0.33, 12);
    let prev = 0;
    for (let l = -8; l <= 4; l += 0.05) {
      const b = betaFromZ0(Math.exp(l));
      expect(b).toBeGreaterThanOrEqual(prev);
      expect(b).toBeGreaterThanOrEqual(0.08);
      expect(b).toBeLessThanOrEqual(0.4);
      prev = b;
    }
    const t = { open: 1, suburban: 4, urban: 9 };
    expect(interpByZ0(t, 0.03)).toBeCloseTo(1, 12);
    expect(interpByZ0(t, 0.3)).toBeCloseTo(4, 12);
    expect(interpByZ0(t, 3)).toBeCloseTo(9, 12);
    expect(interpByZ0(t, 0.001)).toBe(1);
    expect(interpByZ0(t, 50)).toBe(9);
  });

  test("TERR-05: wind into town: β rises from the edge and has adjusted 750 m in", () => {
    const { field } = town();
    const open = betaFromZ0(0.03);
    let interior = 0;
    for (let x = -400; x <= 400; x += 20) interior += betaAt(field, x, 7, 0);
    interior /= 41;
    let prev = 0;
    for (let d = 0; d <= 750; d += 50) {
      const b = betaAt(field, EDGE + d, 7, 0); // blowing toward +X: from the farmland
      expect(b).toBeGreaterThan(prev - 0.002);
      prev = b;
    }
    expect(betaAt(field, EDGE, 7, 0)).toBeLessThan((open + interior) / 2);
    expect(Math.abs(betaAt(field, EDGE + 750, 7, 0) - interior) / interior).toBeLessThan(0.05);
  });

  test("TERR-06: 200 m inside the west edge, β is lower for wind from the farmland", () => {
    const { field } = town();
    for (const z of [-500, 7, 450]) {
      const fromWest = betaAt(field, EDGE + 200, z, 0);
      const fromEast = betaAt(field, EDGE + 200, z, Math.PI);
      expect(fromWest).toBeLessThan(fromEast - 0.02);
    }
  });

  test("TERR-07: a uniform field gives the class's wind", () => {
    // With the default outer reach and a changed one (Spec 01 v1.11): the field path must use it too.
    for (const s of [baseState({ velocity: { x: 12, z: 3 } }), baseState({ velocity: { x: 12, z: 3 }, outerReach: 3 } as never)])
    for (const cls of ["open", "suburban", "urban"] as const) {
      const f = uniformField(TERRAIN.classZ0[cls]);
      for (const [x, y, z] of [[0, 0.5, 0], [150, 2, 10], [-300, 5, 80], [600, 9, -400], [40, 15, 30], [90, 40, 0]] as const) {
        const a = windAt({ x, y, z }, s, cls);
        const b = windAt({ x, y, z }, s, f);
        const m = Math.max(hspeed(a), 1e-6);
        expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) / m).toBeLessThan(1e-6);
      }
    }
  });

  test("TERR-08: flattening a neighborhood lowers z₀ at the next update and raises the 5 m wind", () => {
    const sim = createSim({ area: { x: 0, z: 0, radius: 700 } }, 3, { vPeak: 0.1 });
    const before = sim.snapshot.terrain as RoughnessField;
    const z0Before = z0At(before, 0, 0);
    expect(z0Before).toBeGreaterThan(0.1);
    for (const b of sim.world.buildings) if (Math.abs(b.x) < 300 && Math.abs(b.z) < 300) flatten(b);
    sim.advance(0.05);
    for (let i = 0; i < 20; i++) sim.advance(0.1);
    const after = sim.snapshot.terrain as RoughnessField;
    expect(after.version).not.toBe(before.version);
    const z0After = z0At(after, 0, 0);
    expect(z0After).toBeLessThan(0.06);
    expect(z0After).toBeGreaterThan(TERRAIN.z0Cover.lawn);
    const s = baseState({ center: { x: -250, z: 0 } });
    expect(hspeed(windAt({ x: 0, y: 5, z: 0 }, s, after))).toBeGreaterThan(hspeed(windAt({ x: 0, y: 5, z: 0 }, s, before)) * 1.02);
    sim.dispose();
  });

  test("TERR-09: debris tables follow the local z₀ and equal Spec 04's class values at the anchors", () => {
    const tables = [DEBRIS.snagDistance, DEBRIS.bumpSpacing, TURBULENCE.intensity];
    for (const t of tables) {
      for (const cls of ["open", "suburban", "urban"] as const) {
        expect(tableAt(t, cls, 0, 0)).toBe(t[cls]);
        expect(tableAt(t, uniformField(TERRAIN.classZ0[cls]), 0, 0)).toBeCloseTo(t[cls], 5);
      }
      const { field } = town();
      for (const [x, z] of [[0, 0], [EDGE + 100, 30], [EDGE - 500, 0]] as const) expect(tableAt(t, field, x, z)).toBeCloseTo(interpByZ0(t, z0At(field, x, z)), 12);
    }
    // In town a sliding piece snags sooner than out on the fields.
    expect(tableAt(DEBRIS.snagDistance, town().field, 0, 0)).toBeLessThan(tableAt(DEBRIS.snagDistance, town().field, EDGE - 800, 0));
    expect(effZ0At(town().field, 0, 0, 1)).toBeGreaterThan(0.1);
  });

  test("TERR-13: windAt over the field costs at most 1.6× windAt over a class (ratio; the ms budgets are in tests/validation)", () => {
    const tr = town().tr;
    const s = baseState({ velocity: { x: 12, z: 0 } });
    const pts = Array.from({ length: 1000 }, (_, i) => ({ x: ((i * 37) % 1000) - 500, y: 1 + (i % 9), z: ((i * 91) % 1000) - 500 }));
    const bench = (t: Parameters<typeof windAt>[2]) => {
      let acc = 0;
      const t1 = performance.now();
      for (let r = 0; r < 1000; r++) for (const p of pts) acc += windAt(p, s, t).x;
      return { ms: performance.now() - t1, acc };
    };
    // Interleaved, minimum of each: load lands on both sides alike.
    let cls = Infinity;
    let fld = Infinity;
    for (let r = 0; r < 5; r++) {
      cls = Math.min(cls, bench("suburban").ms);
      fld = Math.min(fld, bench(tr.field).ms);
    }
    expect(fld / cls).toBeLessThan(1.6);
  });
});

describe("Spec 17 — terrain in the sim, the lab and the ground", () => {
  beforeAll(async () => {
    await initRapier();
  });
  const labSetup = (p: Partial<LabSetup> = {}): LabSetup => ({ houses: 1, cls: "standard", surroundings: "open", seed: 3, donors: false, model: "component", ...p });
  const calm: LabWind = { kind: "steady", keys: [{ t: 0, mph: 0, dirDeg: 0 }] };

  test("TERR-10: the main sim has no terrain control and runs on the town's field; the probe shows the local terrain", () => {
    expect(defaultParams().terrain).toBe("auto");
    const params = readFileSync(join(import.meta.dirname, "../../src/ui/params.ts"), "utf8");
    expect(params).not.toMatch(/add\(values, "terrain"/);
    // The whole town: the fetch reads a kilometre upwind.
    const sim = createSim({}, 5);
    const t = sim.snapshot.terrain;
    expect(isField(t)).toBe(true);
    const s = baseState({ velocity: { x: 12, z: 0 }, center: { x: -400, z: 0 } });
    const r = probeAt({ x: 0, y: 10, z: 0 }, s, t);
    expect(r.terrain.cls).toBe("suburban");
    expect(r.terrain.z0).toBeCloseTo(z0At(t, 0, 0), 9);
    expect(r.terrain.cls).toBe(terrainClassOf(r.terrain.z0Eff));
    expect(r.terrain.beta).toBeCloseTo(betaFromZ0(r.terrain.z0Eff), 6);
    sim.dispose();
  });

  test("TERR-11: lab Terrain: Auto follows the surroundings, an override is uniform, a recorded replay keeps the recording's", async () => {
    const hood = await createLab(labSetup({ surroundings: "neighborhood" }), calm);
    expect(hood.terrain).toBe("auto");
    expect(isField(hood.sim.snapshot.terrain)).toBe(true);
    expect(z0At(hood.sim.snapshot.terrain, 0, 0)).toBeGreaterThan(0.1);
    const field = await createLab(labSetup(), calm);
    expect(terrainClassOf(z0At(field.sim.snapshot.terrain, 0, 0))).toBe("open");
    for (const cls of ["open", "suburban", "urban"] as const) {
      const o = await createLab(labSetup({ surroundings: "neighborhood", terrain: cls }), calm);
      expect(o.sim.snapshot.terrain).toBe(cls);
      o.dispose();
    }
    // Record in the neighborhood, replay in the field: the recording's roughness, setting locked.
    const pass: LabWind = { kind: "pass", presetId: "ef2-cone", headingDeg: 0, offset: 0, lifecycle: "mature" };
    const src = await createLab(labSetup({ surroundings: "neighborhood" }), pass);
    const rec = src.recordDebris(src.block[0]!);
    src.advance(1);
    const recording = rec.stop();
    expect(typeof recording.terrain).toBe("object");
    const srcField = src.sim.snapshot.terrain;
    const rep = await createLab(labSetup(), calm, { replay: { recording, house: 0, wind: "recorded" } });
    expect(rep.terrain).toBe("recorded");
    const t = rep.sim.snapshot.terrain;
    expect(isField(t) && t.nx === 1).toBe(true);
    const b = src.sim.world.buildings[src.block[0]!]!;
    // Within the interpolation between the 16 recorded directions.
    for (const dir of [0, 1, 2.5, 4]) expect(betaAt(t, 50, -20, dir)).toBeCloseTo(betaFromLnZ0(effLnZ0(srcField as RoughnessField, b.x, b.z, dir)), 3);
    for (const l of [hood, field, src, rep]) l.dispose();
  });

  test("TERR-12: town lots and streets are lawn, the rest farmland, no roads drawn; a lab override draws its class's cover", async () => {
    const sim = createSim({ area: { x: 0, z: 0, radius: 200 } }, 5);
    const c = sim.snapshot.groundCover!;
    expect(coverAt(c, 0, 0)).toBe("lawn");
    expect(coverAt(c, 7.5 + CITY.blockX * 2 - CITY.extent / 2, 3)).toBe("lawn"); // a street
    expect(coverAt(c, EDGE - 50, 0)).toBe("farmland");
    expect(coverAt(c, 0, -EDGE + 500)).toBe("farmland");
    sim.dispose();
    for (const [cls, kind] of [["open", "farmland"], ["suburban", "lawn"], ["urban", "pavement"]] as const) {
      const lab = await createLab(labSetup({ surroundings: "neighborhood", terrain: cls }), calm);
      expect(coverAt(lab.sim.snapshot.groundCover!, 0, 0)).toBe(kind);
      expect(coverAt(lab.sim.snapshot.groundCover!, 3000, 0)).toBe(kind);
      lab.dispose();
    }
    // No ground texture draws roads or section lines (the old farmland drew section-line roads).
    const ground = readFileSync(join(import.meta.dirname, "../../src/render/ground.ts"), "utf8");
    const env = readFileSync(join(import.meta.dirname, "../../src/render/environment.ts"), "utf8");
    for (const src of [ground, env]) {
      expect(src).not.toMatch(/fillRect\(0, 0, size, 4\)|fillRect\(0, 0, 4, size\)/);
      expect(src).not.toMatch(/#8b8578/);
    }
  });

  test("TERR-14: the roughness layer colours each node by the z₀ the wind feels, the edge as a gradient; it changes no sim state", () => {
    const { field } = town();
    const s = baseState({ velocity: { x: 12, z: 0 }, center: { x: -3000, z: 0 } });
    const layer = roughnessLayer(field, s);
    expect(layer.nx * layer.nz).toBe(field.nx * field.nz);
    const col = new THREE.Color();
    // Sample nodes across the west edge: colour = scale(z₀ for the wind there).
    const j = Math.round((7 - field.originZ) / field.cell);
    const zs: number[] = [];
    for (let d = -400; d <= 800; d += 20) {
      const i = Math.round((EDGE + d - field.originX) / field.cell);
      const x = field.originX + i * field.cell;
      const z = field.originZ + j * field.cell;
      const want = effZ0At(field, x, z, fetchDirection({ x, y: 0, z }, s));
      const got = layer.z0[i + j * field.nx]!;
      expect(Math.abs(Math.log(got / want))).toBeLessThan(0.02);
      roughnessColor(got, col).convertLinearToSRGB();
      const o = (i + j * field.nx) * 4;
      // Within one step of the layer's 512-step colour table.
      for (const [c, v] of [[0, col.r], [1, col.g], [2, col.b]] as const) expect(Math.abs(layer.data[o + c]! - Math.round(v * 255))).toBeLessThanOrEqual(3);
      zs.push(Math.log10(got));
    }
    // A gradient, not a step: no single 20 m cell carries more than a third of the change.
    const span = Math.max(...zs) - Math.min(...zs);
    for (let k = 1; k < zs.length; k++) expect(Math.abs(zs[k]! - zs[k - 1]!)).toBeLessThan(span / 3);
    expect(ROUGHNESS_SCALE.opacity).toBeCloseTo(0.45, 2);
    // Reading the layer every step changes nothing in the run.
    const run = (withLayer: boolean) => {
      const sim = createSim({ area: { x: 0, z: 0, radius: 200 } }, 9, { vPeak: 60, rMax: 100 });
      for (let k = 0; k < 30; k++) {
        sim.advance(0.1);
        if (withLayer) roughnessLayer(sim.snapshot.terrain, sim.snapshot.tornado);
      }
      const out = { hist: sim.snapshot.damageHistogram, debris: sim.snapshot.debris };
      sim.dispose();
      return out;
    };
    expect(run(true)).toEqual(run(false));
  });
});

describe("Spec 17 — EF readout basis (BL-021)", () => {
  test("TERR-25: the EF readout uses the open-terrain basis over any ground; the local wind still follows the roughness", async () => {
    const { computeReadout } = await import("../../src/ui/readout");
    const { peakGroundSpeed } = await import("../../src/core/wind/peak");
    const sim = createSim({}, 5, { tUp: 0, tMature: 900, tRope: 0 });
    for (let i = 0; i < 10; i++) sim.advance(0.1);
    const snap = sim.snapshot;
    expect(isField(snap.terrain)).toBe(true);
    // Over the town (the core moved there) and over farmland: same readout as the open class.
    for (const center of [{ x: 0, z: 0 }, { x: EDGE - 1500, z: 0 }]) {
      const s = { ...snap.tornado, center };
      const r = computeReadout({ ...snap, tornado: s });
      expect(r.ms).toBeCloseTo(peakGroundSpeed(s, "open", 10), 9);
    }
    // The wind at a point over the town is still slower than open terrain gives.
    const s = { ...snap.tornado, center: { x: -200, z: 0 } };
    expect(hspeed(windAt({ x: 0, y: 5, z: 0 }, s, snap.terrain))).toBeLessThan(hspeed(windAt({ x: 0, y: 5, z: 0 }, s, "open")));
    sim.dispose();
  });
});
