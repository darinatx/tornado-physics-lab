import { beforeAll, describe, expect, test } from "vitest";
import { DI2_DODS } from "../../src/config/buildings";
import { REPORT } from "../../src/config/report";
import { MS_PER_MPH } from "../../src/config/units";
import { efFromDamage } from "../../src/core/damage/building";
import { efRating } from "../../src/core/wind/efScale";
import type { EFRating } from "../../src/core/wind/efScale";
import { windAt } from "../../src/core/wind/windField";
import { createSim } from "../../src/sim/loop";
import type { Sim } from "../../src/sim/loop";
import { buildSurvey, contours, TrackLine } from "../../src/sim/report/survey";
import type { Survey } from "../../src/sim/report/survey";
import { surveyRows } from "../../src/sim/report/table";
import { activeRadius, StormRecorder } from "../../src/sim/stormRecord";
import type { BuildingRecord, StormRecord, TrackSample } from "../../src/sim/stormRecord";
import { defaultParams } from "../../src/sim/types";

/** A mature tornado passing a small patch of town, heading east. */
const PASS = { heading: 0, translationSpeed: 18, vPeak: 72, rMax: 90, tUp: 0, tMature: 600, tRope: 0 } as const;
const PASS_CFG = { area: { x: 0, z: 0, radius: 90 }, start: { x: -200, z: 20 } } as const;
const PASS_S = 18;

/** A light per-step fingerprint of the sim's state. */
function stepPrint(sim: Sim): string {
  const s = sim.snapshot;
  const b = sim.world.buildings;
  let h = 0;
  for (const x of b) h = (h * 31 + x.dod * 7 + Math.round(x.peakMph * 1000) + x.rev) % 1e9;
  return [s.step, s.tornado.center.x, s.tornado.center.z, s.damageVersion, s.damageHistogram.join(), JSON.stringify(s.debris), h].join("|");
}

function fullPrint(sim: Sim): string {
  return JSON.stringify([
    sim.world.buildings.map((b) => [b.dod, b.peakMph, b.closestEdge, b.deficitIn]),
    sim.debris.pieces.map((p) => [p.id, p.pos.x, p.pos.y, p.pos.z, p.vel.x, p.vel.y, p.vel.z, p.resting]),
    sim.debris.massSpawned,
  ]);
}

function runPass(record: boolean, perStep?: (s: Sim) => void): { sim: Sim; rec: StormRecorder | null } {
  const sim = createSim(PASS_CFG, 11, PASS);
  const rec = record ? new StormRecorder(sim) : null;
  while (sim.time < PASS_S - 1e-9) {
    sim.advance(sim.dt);
    perStep?.(sim);
  }
  return { sim, rec };
}

// ---------------------------------------------------------------------------------------------
// Scripted records (survey tests): a straight track east from the origin.

function scriptedTrack(len = 1000, speed = 20): TrackSample[] {
  const out: TrackSample[] = [];
  for (let t = 0; t * speed <= len; t++) out.push({ t, x: t * speed, z: 0, heading: 90, speed, vMax: 60, rMax: 100, peak: 80, ef: 4, phase: "mature" });
  return out;
}

function house(index: number, x: number, z: number, dod: number, o: Partial<BuildingRecord> = {}): BuildingRecord {
  return { index, id: 100 + index, x, z, cls: "standard", peak10: 0, peakRoof: 0, closestEdge: null, dod, dodHistory: dod ? [[index, dod]] : [], firstFail: null, lastFail: null, failures: [], ...o };
}

/** Swath tiles from a list of cells (ci, cj, peak m/s). */
function swathOf(cells: [number, number, number][]): StormRecord["swath"] {
  const T = REPORT.tile;
  const tiles = new Map<string, { ti: number; tj: number; peak: number[] }>();
  for (const [ci, cj, v] of cells) {
    const ti = Math.floor(ci / T);
    const tj = Math.floor(cj / T);
    const k = `${ti},${tj}`;
    let t = tiles.get(k);
    if (!t) tiles.set(k, (t = { ti, tj, peak: new Array(T * T).fill(0) }));
    t.peak[ci - ti * T + (cj - tj * T) * T] = v;
  }
  return { cell: REPORT.cell, tile: T, tiles: [...tiles.values()] };
}

const z = () => ({ hits: 0, broke: 0, perforated: 0, sidingTorn: 0, coverTorn: 0 });

function scripted(buildings: BuildingRecord[], cells: [number, number, number][] = []): StormRecord {
  return {
    meta: { seed: 1, preset: null, params: defaultParams(), terrain: "open", dt: 1 / 120, simTime: 50, appVersion: "test", specs: {} },
    townCenter: { x: 0, z: 0 },
    track: scriptedTrack(),
    swath: swathOf(cells),
    buildings,
    debris: { pieces: [], impacts: { bySurface: { pane: z(), garage: z(), wall: z(), gable: z(), roof: z() }, byHouse: [], firstAt: [] }, massSpawned: 0, massLofted: 0 },
  };
}

const mphToMs = (m: number) => m * MS_PER_MPH;

/** Every point lies strictly inside a section of each contour at or below its EF, and every
 *  contour section holds a point at or above its level. */
function checkContours(pts: readonly { along: number; cross: number; ef: EFRating | null }[], cs: ReturnType<typeof contours>): void {
  for (const p of pts) {
    if (p.ef === null) continue;
    for (let n = 0; n <= p.ef; n++) {
      const c = cs.find((x) => x.ef === n);
      expect(c, `EF${n} contour`).toBeTruthy();
      const inside = c!.runs.some((run) => run.some((s) => p.along >= s.a0 && p.along < s.a1 && p.cross > s.lo && p.cross < s.hi));
      expect(inside, `point at ${p.along.toFixed(1)}, ${p.cross.toFixed(1)} inside EF${n}`).toBe(true);
    }
  }
  for (const c of cs)
    for (const run of c.runs)
      for (const s of run) {
        const any = pts.some((p) => p.ef !== null && p.ef >= c.ef && p.along >= s.a0 && p.along < s.a1 && p.cross > s.lo && p.cross < s.hi);
        expect(any, `EF${c.ef} section ${s.k} has a point`).toBe(true);
      }
}

describe("Spec 16 — storm report: record and survey", () => {
  let A: { sim: Sim; rec: StormRecorder | null };
  let recA: StormRecord;
  let surveyA: Survey;
  const printsA: string[] = [];
  const printsB: string[] = [];
  let fullB = "";

  beforeAll(() => {
    A = runPass(true, (s) => printsA.push(stepPrint(s)));
    const B = runPass(false, (s) => printsB.push(stepPrint(s)));
    fullB = fullPrint(B.sim);
    recA = A.rec!.record();
    surveyA = buildSurvey(recA);
  }, 120_000);

  test("REP-02: the recorder never changes the sim (same state at every step with and without it)", () => {
    expect(printsA.length).toBe(Math.round(PASS_S * 120));
    expect(printsA.length).toBe(printsB.length);
    for (let i = 0; i < printsA.length; i++) if (printsA[i] !== printsB[i]) expect(`step ${i + 1}: ${printsA[i]}`).toBe(`step ${i + 1}: ${printsB[i]}`);
    expect(fullPrint(A.sim)).toBe(fullB);
    // The pass did something worth recording.
    expect(surveyA.points.length).toBeGreaterThan(5);
    expect(recA.debris.pieces.length).toBeGreaterThan(0);
  });

  test("REP-03: the same seed and inputs give an identical record and survey", () => {
    const C = runPass(true);
    const recC = C.rec!.record();
    expect(JSON.stringify(recC)).toBe(JSON.stringify(recA));
    expect(JSON.stringify(buildSurvey(recC))).toBe(JSON.stringify(surveyA));
    // The record is plain data: a JSON round trip gives the same survey.
    expect(JSON.stringify(buildSurvey(JSON.parse(JSON.stringify(recA))))).toBe(JSON.stringify(surveyA));
  }, 120_000);

  test("REP-04: the true swath matches the hand-computed peak of a steady vortex passing each cell", () => {
    const P = { heading: 0, translationSpeed: 15, vPeak: 60, rMax: 100, tUp: 0, tMature: 600, tRope: 0 };
    const start = { x: -700, z: 0 };
    const sim = createSim({ buildings: false, start }, 3, P);
    const rec = new StormRecorder(sim);
    while (sim.time < 100 - 1e-9) sim.advance(0.25);
    const r = rec.record();
    const s0 = sim.snapshot.tornado;
    expect(s0.vMax).toBe(60);
    const reach = activeRadius(s0);
    expect(reach).toBeGreaterThan(2 * P.rMax);
    // Peak of the 10 m ground-relative wind at a cell, by hand: the vortex slides past along x
    // (z of the center fixed at 0), searched on a 0.5 m grid and refined to 1 cm.
    const at = (cx: number, cz: number, x: number) => {
      const w = windAt({ x: cx, y: REPORT.height, z: cz }, { ...s0, center: { x, z: 0 } }, "open");
      return Math.hypot(w.x, w.z);
    };
    const peakAt = (cx: number, cz: number) => {
      let best = 0;
      let bx = cx;
      for (let x = cx - 1.2 * reach; x <= cx + 1.2 * reach; x += 0.5) {
        const v = at(cx, cz, x);
        if (v > best) [best, bx] = [v, x];
      }
      for (let x = bx - 0.5; x <= bx + 0.5; x += 0.01) best = Math.max(best, at(cx, cz, x));
      return best;
    };
    const C = REPORT.cell;
    const T = REPORT.tile;
    const cellPeak = (ci: number, cj: number) => {
      const t = r.swath.tiles.find((q) => q.ti === Math.floor(ci / T) && q.tj === Math.floor(cj / T));
      return t ? t.peak[ci - t.ti * T + (cj - t.tj * T) * T]! : 0;
    };
    let compared = 0;
    // Three columns of cells the core passed fully (it ends at x = 800), across the whole swath.
    for (const ci of [-5, 3, 20]) {
      for (let cj = -Math.ceil((reach + 40) / C); cj <= Math.ceil((reach + 40) / C); cj++) {
        const truth = peakAt((ci + 0.5) * C, (cj + 0.5) * C);
        const got = cellPeak(ci, cj);
        if (truth >= REPORT.threshold * 1.01) {
          expect(Math.abs(got - truth) / truth, `cell ${ci},${cj}`).toBeLessThan(0.01);
          compared++;
        } else if (got === 0) {
          // Never held EF0: the hand-computed peak agrees (within the 1%).
          expect(truth).toBeLessThan(REPORT.threshold * 1.01);
        } else expect(Math.abs(got - truth) / truth).toBeLessThan(0.01);
      }
    }
    expect(compared).toBeGreaterThan(30);
    // No cell anywhere holds EF0 wind beyond the active radius of the track's line.
    for (const t of r.swath.tiles)
      for (let j = 0; j < T; j++)
        for (let i = 0; i < T; i++)
          if (t.peak[i + j * T]! > 0) expect(Math.abs((t.tj * T + j + 0.5) * C)).toBeLessThanOrEqual(reach + C);
  }, 60_000);

  test("REP-05: every building with DOD ≥ 1 is a survey point with the Spec 03 survey speed; no other is rated", () => {
    const damaged = recA.buildings.filter((b) => b.dod >= 1);
    expect(surveyA.points.map((p) => p.index).sort((a, b) => a - b)).toEqual(damaged.map((b) => b.index).sort((a, b) => a - b));
    for (const p of surveyA.points) {
      const b = recA.buildings[p.index]!;
      const est = efFromDamage(b.dod, b.cls);
      expect(p.dod).toBe(b.dod);
      expect(p.cls).toBe(b.cls);
      expect(p.mph).toBe(est.mph);
      expect(p.ef).toBe(est.ef);
      expect(p.efLow).toBe(est.low);
      expect(p.efHigh).toBe(est.high);
    }
    // Undamaged buildings in the EF0 swath are mapped, not rated.
    for (const q of surveyA.noDamage) expect(recA.buildings[q.index]!.dod).toBe(0);
    // A building's DOD matches the sim's.
    for (const b of recA.buildings) expect(b.dod).toBe(A.sim.world.buildings[b.index]!.dod);
  });

  test("REP-06: the rating is the highest survey-point EF; a peak over open ground is rated below its true peak", () => {
    // Houses near the start (DOD 4 standard: 97 mph, EF1; DOD 6 strong: 142 mph, EF3), and an
    // EF4 core over open fields further on, where nothing stands.
    const rec = scripted(
      [house(0, 100, 10, 4), house(1, 140, -20, 6, { cls: "strong" }), house(2, 200, 400, 0)],
      [
        [10, 0, mphToMs(100)],
        [14, -2, mphToMs(140)],
        [50, 0, mphToMs(185)],
        [51, 0, mphToMs(180)],
      ],
    );
    const s = buildSurvey(rec);
    expect(s.points.length).toBe(2);
    expect(s.rating).toBe(Math.max(...s.points.map((p) => p.ef!)));
    expect(s.rating).toBe(3);
    expect(s.ratingMph).toBe(142);
    expect(s.truePeak!.ef).toBe(4);
    expect(s.truePeak!.mph).toBeCloseTo(185, 3);
    expect(s.rating!).toBeLessThan(s.truePeak!.ef!);
    // The real pass's rating is its highest point EF too.
    expect(surveyA.rating).toBe(Math.max(...surveyA.points.map((p) => p.ef ?? -1)));
  });

  test("REP-07: path length and maximum width match hand-computed values, survey and true swath", () => {
    const rec = scripted(
      [house(0, 100, 10, 2), house(1, 120, -30, 3), house(2, 130, 40, 1), house(3, 600, 0, 5), house(4, 640, -5, 2), house(5, 300, 0, 0)],
      [
        // A band 6 cells wide (z −25 … 25) from x = 105 to 595 …
        ...Array.from({ length: 50 }, (_, i) => Array.from({ length: 6 }, (_, j) => [10 + i, j - 3, 40] as [number, number, number])).flat(),
        // … widened to 12 cells (z −55 … 55) between x = 305 and 345.
        ...Array.from({ length: 5 }, (_, i) => Array.from({ length: 12 }, (_, j) => [30 + i, j - 6, 40] as [number, number, number])).flat(),
      ],
    );
    const s = buildSurvey(rec);
    // Survey: from x = 100 to 640 along the track; widest in [100, 150): z from −30 to 40.
    expect(s.path.survey.length).toBeCloseTo(540, 6);
    expect(s.path.survey.maxWidth).toBeCloseTo(70, 6);
    expect(s.path.survey.widestAt).toBe(100);
    // True swath: cell centers from x = 105 to 595; widest [300, 350): 110 m of centers + a cell.
    expect(s.path.true.length).toBeCloseTo(490, 6);
    expect(s.path.true.maxWidth).toBeCloseTo(120, 6);
    expect(s.path.true.widestAt).toBe(300);
    // Start and end, from the town center (the origin).
    expect(s.start!.x).toBe(100);
    expect(s.start!.compass).toBe("E");
    expect(s.end!.x).toBe(640);
    expect(s.end!.distance).toBeCloseTo(Math.hypot(640, 5), 6);
  });

  test("REP-08: every survey point rated EFn lies inside the EFn contour; no section spans a gap", () => {
    // Scripted: two separate damaged stretches give two runs, with no contour across the gap.
    const rec = scripted([house(0, 100, 0, 8), house(1, 110, 30, 3), house(2, 160, -20, 6), house(3, 700, 5, 9), house(4, 720, -10, 2)]);
    const s = buildSurvey(rec);
    checkContours(s.points, s.contours.survey);
    const ef0 = s.contours.survey.find((c) => c.ef === 0)!;
    expect(ef0.runs.length).toBe(2);
    for (const run of ef0.runs) for (const sec of run) expect(sec.a0 < 200 || sec.a0 >= 700).toBe(true);
    // The real pass, survey and true contours.
    checkContours(surveyA.points, surveyA.contours.survey);
    const line = new TrackLine(recA.track);
    const T = recA.swath.tile;
    const cells = recA.swath.tiles.flatMap((t) =>
      t.peak.flatMap((v, k) => (v > 0 ? [{ ...line.project((t.ti * T + (k % T) + 0.5) * recA.swath.cell, (t.tj * T + Math.floor(k / T) + 0.5) * recA.swath.cell), ef: efRating(v) }] : [])),
    );
    expect(cells.length).toBeGreaterThan(100);
    checkContours(cells, surveyA.contours.true);
  });

  test("REP-09: the survey table has one row per point matching the building", () => {
    const rows = surveyRows(surveyA);
    expect(rows.length).toBe(recA.buildings.filter((b) => b.dod >= 1).length);
    expect(new Set(rows.map((r) => r.building)).size).toBe(rows.length);
    for (const row of rows) {
      const b = recA.buildings.find((x) => x.id === row.building)!;
      const d = DI2_DODS.find((x) => x.dod === b.dod)!;
      const est = efFromDamage(b.dod, b.cls);
      expect(row.dod).toBe(b.dod);
      expect(row.description).toBe(d.text);
      expect(row.surveyMph).toBe(est.mph);
      expect(row.ef).toBe(est.ef === null ? "—" : `EF${est.ef}`);
      expect(row.rangeMph).toBe(`${d.lower}–${d.upper}`);
      expect(row.true10Mph).toBeCloseTo(b.peak10 / MS_PER_MPH, 1);
      expect(row.trueRoofMph).toBeCloseTo(b.peakRoof / MS_PER_MPH, 1);
      expect(row.biasMph).toBeCloseTo(est.mph - b.peak10 / MS_PER_MPH, 1);
      expect(row.outsideBounds).toBe(b.peak10 / MS_PER_MPH < d.lower || b.peak10 / MS_PER_MPH > d.upper);
      // Damaged houses near the core were sampled at 10 m.
      expect(b.peak10).toBeGreaterThan(0);
    }
    // Rows run along the track (P1 first).
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.along).toBeGreaterThanOrEqual(rows[i - 1]!.along);
  });
});
