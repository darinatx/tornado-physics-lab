import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { DI2_DODS } from "../../src/config/buildings";
import { REPORT } from "../../src/config/report";
import { MS_PER_MPH } from "../../src/config/units";
import { allFailures, efFromDamage } from "../../src/core/damage/building";
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
import { buildReport } from "../../src/sim/report/report";
import type { Report } from "../../src/sim/report/report";
import { narrative, placeOf } from "../../src/sim/report/narrative";
import { distText, placeText, speedText } from "../../src/sim/report/format";
import { parseSpecDoc } from "../../src/sim/report/specDocs";
import { createReportControl } from "../../src/ui/report/runControl";
import { renderReport } from "../../src/ui/report/html";

const SPEC_DIR = join(import.meta.dirname, "..", "..", "docs", "specs");
const SPECS = readdirSync(SPEC_DIR)
  .filter((f) => f.endsWith(".md"))
  .sort()
  .map((f) => parseSpecDoc(f, readFileSync(join(SPEC_DIR, f), "utf8")));

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
      expect(row.ef).toBe(est.ef === null ? "<EF0" : `EF${est.ef}`);
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

  // ---------------------------------------------------------------------------------------------
  // Slice B: ending the run, the report and the summary.

  test("REP-01: Stop & Report stops the sim and keeps the scene; the lifecycle's end stops the run and offers the report", () => {
    const sim = createSim(PASS_CFG, 11, PASS);
    let offers = 0;
    const ctl = createReportControl(sim, { autoRepeat: () => false, specs: SPECS });
    ctl.onOffer = (on) => (offers += on ? 1 : 0);
    while (sim.time < 8 - 1e-9) sim.advance(1 / 60);
    const before = JSON.stringify([sim.snapshot.step, sim.snapshot.tornado.center, sim.world.buildings.map((b) => [b.dod, b.rev]), sim.debris.pieces.map((p) => [p.pos.x, p.pos.y, p.pos.z])]);
    const report = ctl.stopAndReport();
    expect(sim.stopped).toBe(true);
    expect(ctl.offered).toBe(true);
    expect(offers).toBe(1);
    expect(report.preliminary).toBe(false);
    expect(report.survey.points.length).toBeGreaterThan(0);
    // No further physics steps, whatever the time scale; the frozen state stays readable.
    const step = sim.snapshot.step;
    sim.setTimeScale(4);
    for (let i = 0; i < 30; i++) {
      const f = sim.advance(0.1);
      expect(f.curr).toBe(f.prev);
      expect(f.alpha).toBe(0);
    }
    expect(sim.snapshot.step).toBe(step);
    expect(JSON.stringify([sim.snapshot.step, sim.snapshot.tornado.center, sim.world.buildings.map((b) => [b.dod, b.rev]), sim.debris.pieces.map((p) => [p.pos.x, p.pos.y, p.pos.z])])).toBe(before);
    // The inspector's lookups still work on the frozen town.
    const b = sim.world.buildings.find((x) => x.dod > 0)!;
    expect(sim.world.buildingAt(b.x, b.z)).toBe(b);
    // The report can be opened again; it is the same final report.
    expect(JSON.stringify(ctl.current())).toBe(JSON.stringify(report));
    // Restart leaves the stopped state and the offer.
    sim.reset();
    ctl.reset();
    expect(sim.stopped).toBe(false);
    expect(ctl.offered).toBe(false);
    sim.advance(0.1);
    expect(sim.snapshot.step).toBeGreaterThan(0);
    sim.dispose();

    // The lifecycle's end: a short-lived tornado over open ground stops the run by itself.
    const life = { tUp: 2, tMature: 3, tRope: 2 };
    const short = createSim({ buildings: false }, 4, { ...PASS, ...life });
    const auto = createReportControl(short, { autoRepeat: () => false });
    let offered = false;
    auto.onOffer = (on) => (offered = on);
    for (let i = 0; i < 20 * 60 && !short.stopped; i++) {
      short.advance(1 / 60);
      auto.tick();
    }
    expect(short.stopped).toBe(true);
    expect(offered).toBe(true);
    expect(short.snapshot.phase).toBe("dissipated");
    expect(short.time).toBeGreaterThan(7 + REPORT.endDelay);
    expect(short.time).toBeLessThan(7 + REPORT.endDelay + 0.1);
    expect(auto.current().preliminary).toBe(false);
    // With repeat on it never stops (the app restarts it instead).
    const rep = createSim({ buildings: false }, 4, { ...PASS, ...life });
    const ctlRep = createReportControl(rep, { autoRepeat: () => true });
    for (let i = 0; i < 20 * 60; i++) {
      rep.advance(1 / 60);
      ctlRep.tick();
    }
    expect(rep.stopped).toBe(false);
    expect(ctlRep.offered).toBe(false);
  }, 60_000);

  describe("the report", () => {
    let R: Report;
    beforeAll(() => {
      R = buildReport(recA, surveyA, { preliminary: false, specs: SPECS });
    });

    test("REP-10: failure sequences list each chosen house's failures in time order, matching the records", () => {
      const chosen = surveyA.points.filter((p) => p.ef === surveyA.rating);
      expect(R.failures.houses.length).toBe(Math.min(10, chosen.length));
      expect(R.failures.houses.length).toBeGreaterThan(0);
      for (const h of R.failures.houses) {
        const b = recA.buildings.find((x) => x.id === h.building)!;
        const p = surveyA.points.find((x) => x.id === h.building)!;
        expect(p.ef).toBe(surveyA.rating);
        expect(h.steps.length).toBe(b.failures.length);
        expect(h.steps.length).toBeGreaterThan(0);
        // The house's own component failures (Spec 03) are all there.
        const sim = A.sim.world.buildings[b.index]!;
        const own = sim.detail ? [] : allFailures(sim);
        expect(b.failures.filter((f) => !f.detail).length).toBe(own.length);
        for (let i = 0; i < h.steps.length; i++) {
          const s = h.steps[i]!;
          const f = b.failures[i]!;
          if (i > 0) expect(s.time).toBeGreaterThanOrEqual(h.steps[i - 1]!.time);
          expect(s.time).toBe(f.time);
          expect(s.load).toBe(f.load);
          expect(s.capacity).toBe(f.capacity);
          expect(s.cause).toBe(f.cause);
          if (s.cause === "wind") expect(s.load).toBeGreaterThan(s.capacity);
          if (s.cause === "debris") expect(s.missile).toBeTruthy();
        }
      }
      // Houses in order: most damaged first.
      for (let i = 1; i < R.failures.houses.length; i++) expect(R.failures.houses[i]!.dod).toBeLessThanOrEqual(R.failures.houses[i - 1]!.dod);
      // First-to-fail counts cover every damaged house with a failure.
      const withFail = recA.buildings.filter((b) => b.dod >= 1 && b.failures.length).length;
      expect(R.failures.firstToFail.reduce((n, x) => n + x.count, 0)).toBe(withFail);
    });

    test("REP-11: debris figures match the record", () => {
      const P = recA.debris.pieces;
      const D = R.debris;
      expect(D.launched).toBe(P.length);
      expect(D.byKind.reduce((n, k) => n + k.count, 0)).toBeCloseTo(P.reduce((n, p) => n + p.represents, 0), 6);
      for (const k of D.byKind) expect(k.count).toBeCloseTo(P.filter((p) => p.kind === k.kind).reduce((n, p) => n + p.represents, 0), 6);
      const lofted = P.filter((p) => p.fate === "lofted");
      if (lofted.length) expect(D.heaviestLofted!.mass).toBe(Math.max(...lofted.map((p) => p.mass)));
      else expect(D.heaviestLofted).toBeNull();
      const landed = P.filter((p) => p.fate === "landed");
      expect(landed.length).toBeGreaterThan(0);
      expect(D.farthest!.distance).toBeCloseTo(Math.max(...landed.map((p) => Math.hypot(p.endX - p.x, p.endZ - p.z))), 9);
      expect(D.travel.counts.reduce((a, b) => a + b, 0)).toBeCloseTo(landed.reduce((n, p) => n + p.represents, 0), 6);
      expect(D.impacts).toEqual(recA.debris.impacts.bySurface);
      expect(D.impactsTotal).toBe(Object.values(recA.debris.impacts.bySurface).reduce((n, t) => n + t.hits, 0));
      expect(D.impactsTotal).toBeGreaterThan(0);
      expect(D.loftedMass).toBe(recA.debris.massLofted);
      expect(D.debrisOnly).toBe(recA.buildings.filter((b) => b.dod >= 1 && b.failures.length > 0 && b.failures.every((f) => f.cause === "debris")).length);
    });

    test("REP-12: the narrative names the rating, peak wind, path length, worst-hit area and the end, with no randomness", () => {
      const spy = vi.spyOn(Math, "random");
      const text = narrative(recA, surveyA).join(" ");
      const again = narrative(recA, surveyA).join(" ");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      expect(again).toBe(text);
      expect(text).toContain(`EF${surveyA.rating}`);
      expect(text).toContain(speedText(surveyA.ratingMph));
      expect(text).toContain(distText(surveyA.path.survey.length));
      const rp = surveyA.points[surveyA.ratingPoint!]!;
      expect(text).toContain(`The worst damage was ${placeText(placeOf(rp.x, rp.z, recA.townCenter))}`);
      const last = recA.track[recA.track.length - 1]!;
      expect(text).toContain(placeText(placeOf(last.x, last.z, recA.townCenter)));
      expect(text).toContain("still on the ground");
      // A run that ended at dissipation says so.
      const ended = { ...recA, track: [...recA.track, { ...last, t: last.t + 1, phase: "dissipated", vMax: 0 }] };
      expect(narrative(ended, surveyA).join(" ")).toContain("roped out and dissipated");
    });

    test("REP-13: the summary holds the block, map, narrative and four headline numbers, matching the full report", () => {
      expect(R.summary.block).toEqual(R.event);
      expect(R.summary.headline).toEqual({ rating: R.event.rating, peakMph: R.event.ratingMph, destroyed: R.stats.destroyed, pathLengthM: R.event.pathLengthM });
      expect(R.summary.narrative.length).toBeGreaterThanOrEqual(3);
      expect(R.summary.narrative.length).toBeLessThanOrEqual(5);
      for (const s of R.summary.narrative) expect(R.narrative).toContain(s);
      const html = renderReport(R);
      const summary = html.slice(html.indexOf('id="rp-summary"'), html.indexOf('id="rp-narrative"'));
      expect(summary).toContain('class="rp-block"');
      expect(summary).toContain('class="rp-map"');
      expect(summary).toContain("rp-contour");
      for (const s of R.summary.narrative) expect(summary).toContain(s.replace(/'/g, "&#39;"));
      expect(summary).toContain(`EF${R.event.rating}`);
      expect(summary).toContain(`${Math.round(R.event.ratingMph)} mph`);
      expect(summary).toContain(`${R.stats.destroyed.toLocaleString("en-US")}</b>`);
      expect(summary).toContain(`${(R.event.pathLengthM / 1609.344).toFixed(2)} mi`);
      // The block appears once, on the summary page (v1.3: no separate event-summary page).
      expect(html.split('class="rp-block"').length - 1).toBe(1);
      expect(summary).toContain(R.event.casualties.replace(/'/g, "&#39;"));
      // The full report has every section, with the summary first.
      const ids = ["rp-summary", "rp-narrative", "rp-map", "rp-table", "rp-timeline", "rp-failures", "rp-debris", "rp-stats", "rp-methods"];
      let at = -1;
      for (const id of ids) {
        const k = html.indexOf(`id="${id}"`);
        expect(k, id).toBeGreaterThan(at);
        at = k;
      }
      // One table row per survey point.
      expect((html.match(/<tr id="rp-row-/g) ?? []).length).toBe(surveyA.points.length);
      // Methods lists the specs' simplifications.
      expect(R.methods.simplifications.length).toBeGreaterThan(5);
    });
  });
});
