/**
 * Phase 8 validation (slice E, check 4): the report's figures against hand calculations on one
 * saved run, and the JSON export's reload. Reads a report JSON (`survey-bias.ts --save`), then
 * recomputes from the raw record, independently of `src/sim/report`:
 *   - path length and maximum width, by projecting on the straight track (the presets' heading
 *     is fixed), for the survey points and for the true swath;
 *   - contours: every point inside the contour of each EF at or below its own, and no section
 *     without a point at or above its level;
 *   - debris: launched, real pieces, heaviest lofted, farthest travel, impacts total, damaged
 *     by debris alone;
 *   - statistics: damaged, destroyed;
 *   - the reload: `reportFromJson` gives the same report, and a one-digit edit is refused.
 *   npx tsx scripts/report-check.ts file.json
 */
import { readFileSync } from "node:fs";
import { MS_PER_MPH } from "../src/config/units";
import { efRating } from "../src/core/wind/efScale";
import { buildReport } from "../src/sim/report/report";
import { reportFromJson } from "../src/sim/report/export";
import type { Survey } from "../src/sim/report/survey";
import type { StormRecord } from "../src/sim/stormRecord";

const file = process.argv[2];
if (!file) throw new Error("usage: report-check.ts file.json");
const text = readFileSync(file, "utf8");
const saved = JSON.parse(text) as { record: StormRecord; survey: Survey; preliminary: boolean };
const R = saved.record;
const S = saved.survey;
const out: { check: string; report: unknown; hand: unknown; ok: boolean }[] = [];
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const add = (check: string, report: unknown, hand: unknown, ok: boolean) => out.push({ check, report, hand, ok });

// The straight track: origin at the first on-ground sample, direction from the heading.
const onGround = R.track.filter((t) => t.vMax > 0);
const o = onGround[0]!;
const a = (R.meta.params.heading * Math.PI) / 180;
const d = { x: Math.cos(a), z: -Math.sin(a) };
const along = (x: number, z: number) => (x - o.x) * d.x + (z - o.z) * d.z;
// Left of travel (north = −Z, east = +X): (d.z, −d.x)·(p − o).
const cross = (x: number, z: number) => (x - o.x) * d.z - (z - o.z) * d.x;
const straight = Math.max(...R.track.map((t) => Math.abs(cross(t.x, t.z))));
add("track straight (max offset of samples, m)", "-", +straight.toFixed(3), straight < 0.5);

function figures(pts: { x: number; z: number }[], pad: number) {
  const al = pts.map((p) => along(p.x, p.z));
  const length = pts.length ? Math.max(...al) - Math.min(...al) : 0;
  const bins = new Map<number, number[]>();
  pts.forEach((p, i) => {
    const k = Math.floor(al[i]! / 50);
    (bins.get(k) ?? bins.set(k, []).get(k)!).push(cross(p.x, p.z));
  });
  let width = 0;
  for (const c of bins.values()) width = Math.max(width, Math.max(...c) - Math.min(...c) + pad);
  return { length, width };
}
const damaged = R.buildings.filter((b) => b.dod >= 1);
const hs = figures(damaged, 0);
add("survey path length (m)", +S.path.survey.length.toFixed(1), +hs.length.toFixed(1), near(S.path.survey.length, hs.length, 1));
add("survey max width (m)", +S.path.survey.maxWidth.toFixed(1), +hs.width.toFixed(1), near(S.path.survey.maxWidth, hs.width, 1));
const C = R.swath.cell, T = R.swath.tile;
const cells: { x: number; z: number; v: number }[] = [];
for (const t of R.swath.tiles)
  for (let j = 0; j < T; j++)
    for (let i = 0; i < T; i++) {
      const v = t.peak[i + j * T]!;
      if (v > 0) cells.push({ x: (t.ti * T + i + 0.5) * C, z: (t.tj * T + j + 0.5) * C, v });
    }
const ht = figures(cells, C);
add("true path length (m)", +S.path.true.length.toFixed(1), +ht.length.toFixed(1), near(S.path.true.length, ht.length, 1));
add("true max width (m)", +S.path.true.maxWidth.toFixed(1), +ht.width.toFixed(1), near(S.path.true.maxWidth, ht.width, 1));
const below = cells.filter((c) => c.v < 65 * MS_PER_MPH).length;
add("swath cells under EF0 kept", "-", below, below === 0);
const top = cells.reduce((m, c) => Math.max(m, c.v), 0) / MS_PER_MPH;
add("true peak (mph)", +(S.truePeak?.mph ?? 0).toFixed(2), +top.toFixed(2), near(S.truePeak?.mph ?? 0, top, 0.01));

// Contours: each point inside every contour up to its EF; no section without a point at its level.
let outsideC = 0, emptySections = 0;
for (const c of S.contours.survey) {
  const secs = c.runs.flat();
  for (const p of S.points) {
    if (p.ef === null || p.ef < c.ef) continue;
    if (!secs.some((s) => p.along >= s.a0 && p.along < s.a1 && p.cross >= s.lo && p.cross <= s.hi)) outsideC++;
  }
  for (const s of secs) if (!S.points.some((p) => p.ef !== null && p.ef >= c.ef && p.along >= s.a0 && p.along < s.a1)) emptySections++;
}
add("points outside their contours", "-", outsideC, outsideC === 0);
add("contour sections with no point", "-", emptySections, emptySections === 0);
// Rating: the highest EF of the survey speeds.
const hr = Math.max(...S.points.map((p) => (p.ef === null ? -1 : p.ef)));
add("rating (EF)", S.rating, hr, S.rating === hr);
const r10 = S.points.map((p) => efRating(p.mph * MS_PER_MPH));
add("point EFs from their speeds", "-", r10.filter((e, i) => e !== S.points[i]!.ef).length, r10.every((e, i) => e === S.points[i]!.ef));

// Debris and statistics.
const report = buildReport(R, S, { preliminary: saved.preliminary });
const P = R.debris.pieces;
add("pieces launched", report.debris.launched, P.length, report.debris.launched === P.length);
const real = P.reduce((s, p) => s + p.represents, 0);
add("real pieces", report.debris.launchedReal, real, report.debris.launchedReal === real);
const lofted = P.filter((p) => p.fate === "lofted");
const heavy = lofted.reduce((m, p) => Math.max(m, p.mass), 0);
add("heaviest lofted (kg)", report.debris.heaviestLofted?.mass ?? 0, heavy, (report.debris.heaviestLofted?.mass ?? 0) === heavy);
const landed = P.filter((p) => p.fate === "landed");
const far = landed.reduce((m, p) => Math.max(m, Math.hypot(p.endX - p.x, p.endZ - p.z)), 0);
add("farthest travel (m)", +(report.debris.farthest?.distance ?? 0).toFixed(1), +far.toFixed(1), near(report.debris.farthest?.distance ?? 0, far, 0.01));
const hist = report.debris.travel.counts.reduce((s, n) => s + n, 0);
const landedReal = landed.reduce((s, p) => s + p.represents, 0);
add("travel histogram total (real pieces landed)", +hist.toFixed(3), +landedReal.toFixed(3), near(hist, landedReal, 1e-6 * landedReal));
const imp = Object.values(R.debris.impacts.bySurface).reduce((s, t) => s + t.hits, 0);
const impHouse = R.debris.impacts.byHouse.reduce((s, n) => s + n, 0);
add("impacts total", report.debris.impactsTotal, imp, report.debris.impactsTotal === imp);
add("impacts by house sum to the total", impHouse, imp, impHouse <= imp);
const dOnly = damaged.filter((b) => b.failures.length && b.failures.every((f) => f.cause === "debris")).length;
add("damaged by debris alone", report.debris.debrisOnly, dOnly, report.debris.debrisOnly === dOnly);
add("damaged (DOD ≥ 1)", report.stats.damaged, damaged.length, report.stats.damaged === damaged.length);
const destroyed = R.buildings.filter((b) => b.dod >= 8).length;
add("destroyed (DOD ≥ 8)", report.stats.destroyed, destroyed, report.stats.destroyed === destroyed);
add("true swath area (m²)", report.stats.trueArea, cells.length * C * C, report.stats.trueArea === cells.length * C * C);
add("survey table rows", report.table.length, damaged.length, report.table.length === damaged.length);
const h = report.summary.headline;
add(
  "headline (rating, peak mph, destroyed, path m)",
  `${h.rating}, ${h.peakMph}, ${h.destroyed}, ${h.pathLengthM.toFixed(0)}`,
  `${hr}, ${S.ratingMph}, ${destroyed}, ${hs.length.toFixed(0)}`,
  h.rating === hr && h.peakMph === S.ratingMph && h.destroyed === destroyed && near(h.pathLengthM, hs.length, 1),
);

// Reload.
const again = reportFromJson(text);
const same = JSON.stringify(again) === JSON.stringify(report);
add("JSON reloads into the same report", "-", same, same);
let refused = false;
try {
  // One digit of one building's peak changed: the rebuilt survey must differ.
  const f = JSON.parse(text);
  const b = f.record.buildings.find((x: { dod: number }) => x.dod >= 1);
  b.peak10 += 1;
  reportFromJson(JSON.stringify(f));
} catch {
  refused = true;
}
add("a changed file is refused", "-", refused, refused);

console.table(out);
const bad = out.filter((r) => !r.ok);
console.log(bad.length ? `FAILED: ${bad.map((r) => r.check).join("; ")}` : "All checks pass.");
process.exit(bad.length ? 1 : 0);
