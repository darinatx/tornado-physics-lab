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
import { reportFromJson, reportJson, surveyCsv } from "../../src/sim/report/export";
import { SURVEY_COLUMNS } from "../../src/sim/report/table";

/** A CSV line's cells (quoted cells may hold commas and doubled quotes). */
function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") out.push(cur), (cur = "");
    else cur += c;
  }
  out.push(cur);
  return out;
}

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

  test("REP-06: the rating is the EF of the corroborated speed; a peak over open ground is rated below its true peak", () => {
    // Houses near the start (DOD 6 strong: 142 mph, EF3, twice, 50 m apart, so the EF3 is
    // corroborated), and an EF4 core over open fields further on, where nothing stands.
    const rec = scripted(
      [house(0, 100, 10, 6, { cls: "strong" }), house(1, 140, -20, 6, { cls: "strong" }), house(2, 200, 400, 0)],
      [
        [10, 0, mphToMs(100)],
        [14, -2, mphToMs(140)],
        [50, 0, mphToMs(185)],
        [51, 0, mphToMs(180)],
      ],
    );
    const s = buildSurvey(rec);
    expect(s.points.length).toBe(2);
    expect(s.rating).toBe(3);
    expect(s.ratingMph).toBe(142);
    expect(s.truePeak!.ef).toBe(4);
    expect(s.truePeak!.mph).toBeCloseTo(185, 3);
    expect(s.rating!).toBeLessThan(s.truePeak!.ef!);
    // The real pass's rating is the EF of its corroborated speed (REP-16).
    expect(surveyA.rating).toBe(efRating(mphToMs(surveyA.ratingMph)));
  });

  test("REP-16: the rating speed is the highest that two points within 100 m both reach; a lone point can't set it", () => {
    const strong = { cls: "strong" as const };
    const weak = { cls: "weak" as const };
    // A lone strong DOD 10 (220 mph, EF5) beside a standard DOD 9 (170, EF4) 60 m away and a
    // strong DOD 9 (198, EF4) 90 m away; far down the track, two strong DOD 9s 101 m apart.
    // Pairs within 100 m: (A, B) 170, (A, C) 198, (B, C) 170 … so 198 mph, EF4, set by C, with A.
    const rec = scripted([
      house(0, 100, 0, 10, strong),
      house(1, 160, 0, 9),
      house(2, 100, 90, 9, strong),
      house(3, 600, 0, 9, strong),
      house(4, 701, 0, 9, strong),
      house(5, 650, 300, 4, weak),
    ]);
    const s = buildSurvey(rec);
    // By hand: every pair within 100 m, the lower speed, the largest.
    let hand = 0;
    for (const a of s.points)
      for (const b of s.points)
        if (a !== b && Math.hypot(a.x - b.x, a.z - b.z) <= REPORT.corroborationRadius) hand = Math.max(hand, Math.min(a.mph, b.mph));
    expect(hand).toBe(198);
    expect(s.ratingMph).toBe(hand);
    expect(s.rating).toBe(4);
    expect(s.corroborated).toBe(true);
    expect(s.points[s.ratingPoint!]!.id).toBe(102);
    expect(s.points[s.corroboratingPoint!]!.id).toBe(100);
    // The lone EF5 point is set aside, not re-rated.
    expect(s.points[0]!.mph).toBe(220);
    expect(s.points[0]!.ef).toBe(5);
    // 101 m doesn't corroborate; 100 m does.
    const apart = (d: number) => buildSurvey(scripted([house(0, 100, 0, 9, strong), house(1, 100 + d, 0, 9, strong), house(2, 130, 30, 6)]));
    expect(apart(101).ratingMph).toBe(122);
    expect(apart(100).ratingMph).toBe(198);
    // With no two points within 100 m, the highest point rates alone, marked uncorroborated.
    const lone = buildSurvey(scripted([house(0, 100, 0, 8), house(1, 400, 0, 6, strong), house(2, 800, 0, 3)]));
    expect(lone.rating).toBe(3);
    expect(lone.ratingMph).toBe(152);
    expect(lone.corroborated).toBe(false);
    expect(lone.points[lone.ratingPoint!]!.id).toBe(100);
    expect(lone.corroboratingPoint).toBeNull();
    expect(lone.uncorroborated).toEqual([]);
    // A single damaged house rates alone too; nothing damaged, nothing rated.
    const one = buildSurvey(scripted([house(0, 100, 0, 5)]));
    expect([one.rating, one.ratingMph, one.corroborated]).toEqual([2, 121, false]);
    const none = buildSurvey(scripted([house(0, 100, 0, 0)]));
    expect([none.rating, none.ratingPoint, none.corroboratingPoint]).toEqual([null, null, null]);
    // The real pass: no pair within 100 m reaches a higher speed than the rating.
    const P = surveyA.points.filter((p) => p.ef !== null);
    let best = 0;
    for (let i = 0; i < P.length; i++)
      for (let k = i + 1; k < P.length; k++)
        if (Math.hypot(P[i]!.x - P[k]!.x, P[i]!.z - P[k]!.z) <= REPORT.corroborationRadius) best = Math.max(best, Math.min(P[i]!.mph, P[k]!.mph));
    expect(surveyA.ratingMph).toBe(surveyA.corroborated ? best : Math.max(...P.map((p) => p.mph)));
  });

  test("REP-17: points above the rating are listed as uncorroborated and kept in the table, CSV, statistics, summary and Methods", () => {
    const strong = { cls: "strong" as const };
    const rec = scripted([house(0, 100, 0, 10, strong), house(1, 160, 0, 9), house(2, 100, 90, 8), house(3, 900, 0, 9, strong), house(4, 905, 40, 2)]);
    const s = buildSurvey(rec);
    // Pairs within 100 m: (0,1) 170, (0,2) 152, (3,4) 79 → 170 mph, EF4.
    expect(s.rating).toBe(4);
    const above = s.points.flatMap((p, i) => (p.ef !== null && p.ef > s.rating! ? [i] : []));
    expect(s.uncorroborated).toEqual(above);
    expect(s.uncorroborated.map((i) => s.points[i]!.id)).toEqual([100]);
    // Point 3 (strong DOD 9, 198 mph, EF4) is lone but not above the rating: not listed.
    for (const [i, p] of s.points.entries()) expect(p.uncorroborated).toBe(s.uncorroborated.includes(i));
    // Kept with its own DOD, speed and bias.
    const p0 = s.points[0]!;
    expect([p0.dod, p0.mph, p0.ef]).toEqual([10, 220, 5]);
    expect(s.bias.mean).toBeCloseTo(s.points.reduce((a, p) => a + p.biasMph, 0) / s.points.length, 9);
    const rows = surveyRows(s);
    expect(rows.length).toBe(5);
    for (const r of rows) expect(r.corroborated).toBe(r.building !== 100);
    expect(SURVEY_COLUMNS).toContain("corroborated");
    const csv = surveyCsv(s).trim().split(/\r?\n/);
    const head = csvCells(csv[0]!);
    const col = head.findIndex((h) => /corroborated/i.test(h));
    expect(col).toBeGreaterThanOrEqual(0);
    const p0row = csv.slice(1).map(csvCells).find((c) => c[head.findIndex((h) => /building/i.test(h))] === "100")!;
    expect(p0row[col]).toMatch(/not corroborated|false/i);
    // Summary block and Methods name it.
    const R = buildReport(rec, s, { preliminary: false });
    const html = renderReport(R);
    expect(R.event.uncorroborated.length).toBe(1);
    expect(R.event.uncorroborated[0]).toMatchObject({ building: 100, dod: 10, mph: 220, ef: 5 });
    const pid = R.event.uncorroborated[0]!.point;
    expect(R.methods.paragraphs.some((t) => t.includes(pid) && /not corroborated|uncorroborated/i.test(t))).toBe(true);
    expect(html).toContain("Not corroborated");
    // No contour above the rating; every point inside the contours of its capped EF.
    expect(Math.max(...s.contours.survey.map((c) => c.ef))).toBe(4);
  });

  test("REP-18: debris-damage points are marked and kept in the table, map and DOD counts, but not used for the rating, path, contours, ends or bias", () => {
    const fail = (cause: "wind" | "debris" | "collapse", time = 5) => ({ time, part: cause === "collapse" ? "roofBay" : "wall", index: 0, load: 2, capacity: 1, mph: 90, cause });
    const strong = { cls: "strong" as const };
    // Wind damage along the track (peaks set so the bias is defined).
    const base = [
      house(0, 100, 0, 9, { peak10: mphToMs(150), failures: [fail("wind")] }),
      house(1, 160, 20, 8, { peak10: mphToMs(140) }),
      house(2, 400, -60, 4, { peak10: mphToMs(110), failures: [fail("debris", 3), fail("wind", 4)] }),
      house(3, 800, 40, 2, { peak10: mphToMs(90), failures: [fail("wind")] }),
    ];
    const debris = [
      // Far off the track, and past both ends.
      house(4, 500, -1200, 2, { peak10: mphToMs(28), failures: [fail("debris")] }),
      house(5, -300, 0, 3, { peak10: mphToMs(40), failures: [fail("debris"), fail("collapse", 6)] }),
      house(6, 1400, 10, 2, { peak10: mphToMs(30), failures: [fail("debris")] }),
      // Next to the highest point, at a higher DOD and strong (220 mph): would corroborate or rate.
      house(7, 120, 30, 10, { ...strong, peak10: mphToMs(150), failures: [fail("debris")] }),
      house(8, 140, -30, 10, { ...strong, peak10: mphToMs(150), failures: [fail("collapse")] }),
    ];
    // Wind damage the survey rates below EF0 (weak DOD 1: 53 mph), far off the track: mapped and
    // in the table, but not on the path; it isn't debris damage.
    const subEf0 = house(9, 600, 1500, 1, { cls: "weak", peak10: mphToMs(50), failures: [fail("wind")] });
    const a = buildSurvey(scripted(base));
    const recB = scripted([...base, ...debris, subEf0]);
    const b = buildSurvey(recB);
    // Marked: only the points with no wind-caused failure (a point with none recorded is wind).
    expect(b.points.map((p) => p.debrisOnly)).toEqual([false, false, false, false, true, true, true, true, true, false]);
    expect(b.points[9]!.ef).toBeNull();
    expect(b.debrisOnly).toEqual([4, 5, 6, 7, 8]);
    // Kept: points, with their own DOD and speed.
    expect(b.points.length).toBe(10);
    expect([b.points[7]!.dod, b.points[7]!.mph]).toEqual([10, 220]);
    // Not used: rating and corroboration, path, contours, start and end, bias.
    const id = (s: Survey, i: number | null) => (i === null ? null : s.points[i]!.id);
    expect([b.rating, b.ratingMph, b.corroborated, id(b, b.ratingPoint), id(b, b.corroboratingPoint)]).toEqual([a.rating, a.ratingMph, a.corroborated, id(a, a.ratingPoint), id(a, a.corroboratingPoint)]);
    expect(b.uncorroborated).toEqual(a.uncorroborated);
    expect(b.path).toEqual(a.path);
    expect(b.contours).toEqual(a.contours);
    expect([b.start, b.end]).toEqual([a.start, a.end]);
    // The sub-EF0 point is wind damage, so it joins the bias statistics.
    const baseC = buildSurvey(scripted([...base, subEf0]));
    expect([b.bias.mean, b.bias.sd]).toEqual([baseC.bias.mean, baseC.bias.sd]);
    expect(b.bias.outside.map((i) => b.points[i]!.id)).toEqual(baseC.bias.outside.map((i) => baseC.points[i]!.id));
    // Table and CSV mark them; the map shows them; counts by DOD and the damaged total keep them.
    const rows = surveyRows(b);
    expect(rows.length).toBe(10);
    for (const r of rows) expect(r.debrisOnly).toBe(r.building >= 104 && r.building <= 108);
    expect(SURVEY_COLUMNS).toContain("debrisOnly");
    const csv = surveyCsv(b).trim().split(/\r?\n/);
    const head = csvCells(csv[0]!);
    const col = head.indexOf("debrisOnly");
    const bcol = head.indexOf("building");
    for (const line of csv.slice(1).map(csvCells)) expect(line[col]).toBe(String(Number(line[bcol]) >= 104 && Number(line[bcol]) <= 108));
    const R = buildReport(recB, b, { preliminary: false });
    expect(R.map.points.length).toBe(10);
    expect(R.stats.damaged).toBe(10);
    expect(R.stats.byDod[10]).toBe(2);
    expect(R.debris.debrisOnly).toBe(5);
    const html = renderReport(R);
    expect(html).toContain("debris damage");
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
    const capped = (v: Survey) => v.points.map((p) => ({ ...p, ef: p.ef === null || v.rating === null ? p.ef : (Math.min(p.ef, v.rating) as EFRating) }));
    checkContours(capped(s), s.contours.survey);
    for (const c of s.contours.survey) expect(c.ef).toBeLessThanOrEqual(s.rating!);
    const ef0 = s.contours.survey.find((c) => c.ef === 0)!;
    expect(ef0.runs.length).toBe(2);
    for (const run of ef0.runs) for (const sec of run) expect(sec.a0 < 200 || sec.a0 >= 700).toBe(true);
    // The real pass, survey and true contours.
    checkContours(capped(surveyA), surveyA.contours.survey);
    for (const c of surveyA.contours.survey) expect(c.ef).toBeLessThanOrEqual(surveyA.rating!);
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
      const chosen = surveyA.points.filter((p) => !p.debrisOnly && p.ef === surveyA.rating);
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
      expect(D.debrisOnly).toBe(recA.buildings.filter((b) => b.dod >= 1 && b.failures.length > 0 && b.failures.every((f) => f.cause !== "wind")).length);
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

    test("REP-14: the JSON reloads into an identical report; the CSV has one row per point; print puts the summary first and marks every page", () => {
      // JSON: the same report back, the file says what it is, and a changed file is refused.
      const text = reportJson(recA, surveyA, false);
      const back = reportFromJson(text, SPECS);
      expect(JSON.stringify(back)).toBe(JSON.stringify(R));
      expect(JSON.parse(text).mark).toBe("Simulated storm report");
      const prelim = reportFromJson(reportJson(recA, surveyA, true), SPECS);
      expect(prelim.preliminary).toBe(true);
      const tampered = JSON.parse(text);
      tampered.survey.rating = tampered.survey.rating === 5 ? 4 : 5;
      expect(() => reportFromJson(JSON.stringify(tampered))).toThrow(/doesn't match/);
      expect(() => reportFromJson("{}")).toThrow(/Not a storm report/);

      // CSV: header of the table's columns, then one row per survey point with its values.
      const lines = surveyCsv(surveyA, recA.townCenter).trimEnd().split("\r\n");
      expect(csvCells(lines[0]!)).toEqual([...SURVEY_COLUMNS]);
      expect(lines.length - 1).toBe(surveyA.points.length);
      lines.slice(1).forEach((line, i) => {
        const cells = csvCells(line);
        expect(cells.length).toBe(SURVEY_COLUMNS.length);
        const row = R.table[i]!;
        SURVEY_COLUMNS.forEach((c, k) => expect(cells[k], `${row.point} ${c}`).toBe(row[c] === null ? "" : String(row[c])));
      });
      // A description with a comma survives the round trip (DOD 2's text has two).
      expect(csvCells('2,"Loss of roof covering (< 20%), gutters, siding",x')).toEqual(["2", "Loss of roof covering (< 20%), gutters, siding", "x"]);

      // Print: the summary is the first page; every page carries the mark; each page breaks
      // after it; printing the summary alone hides every other page.
      const html = renderReport(R);
      const pages = html.split('<section class="rp-page').slice(1);
      expect(pages.length).toBe(9);
      expect(pages[0]).toMatch(/^ rp-summary" id="rp-summary"/);
      for (const p of pages) expect(p).toMatch(/<div class="rp-mark"><span>SIMULATED STORM REPORT/);
      const css = readFileSync(join(import.meta.dirname, "..", "..", "src", "ui", "report", "report.css"), "utf8");
      const print = css.slice(css.indexOf("@media print"));
      expect(print).toMatch(/\.rp-page \{[^}]*break-after: page/);
      expect(print).toMatch(/body\.rp-print-summary \.rp-page:not\(\.rp-summary\) \{\s*display: none/);
      expect(print).toMatch(/body\.rp-printing > \*:not\(\.rp-overlay\) \{\s*display: none/);
      // No agency name or logo: the page names itself a simulation.
      expect(html).not.toMatch(/National Weather Service|NWS|NOAA/);
      expect(html).toContain("not an official statement");
    });
  });
});
