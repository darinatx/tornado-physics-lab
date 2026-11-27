/**
 * The storm report as a page (Spec 16): an HTML string with the maps and charts as inline SVG,
 * so it prints as vector graphics and can be checked without a browser. Laid out like a damage
 * survey statement (summary block, plain narrative, survey map), then the engineering sections.
 * Marked on every page as a simulated storm report; no agency name, logo or product header.
 */
import { MS_PER_MPH } from "../../config/units";
import { EF_LOWER_MPH } from "../../core/wind/efScale";
import type { EFRating } from "../../core/wind/efScale";
import { distText, M_PER_MI, M_PER_YD, placeText, speedText, timeText } from "../../sim/report/format";
import type { MapData, Report } from "../../sim/report/report";
import { dodText } from "../../sim/report/report";
import type { SurveyRow } from "../../sim/report/table";
import { EF_COLORS } from "../../render/arrowStyle";
import { DOD_COLORS } from "../../render/houses";

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
export const efColor = (ef: EFRating | null) => (ef === null ? "#8a929c" : hex(EF_COLORS[ef]));
export const dodColor = (dod: number) => (dod <= 0 ? "#9aa3ad" : hex(DOD_COLORS[dod]!));

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const efText = (e: EFRating | null) => (e === null ? "below EF0" : `EF${e}`);
const n0 = (v: number) => Math.round(v).toLocaleString("en-US");
const f1 = (v: number) => (Math.round(v * 10) / 10).toLocaleString("en-US");

/** The mark on every page (Spec 16). */
function pageMark(r: Report, page: string): string {
  return `<div class="rp-mark"><span>${esc(r.mark.toUpperCase())}${r.preliminary ? " · PRELIMINARY" : ""}</span><span>Tornado Physics Lab · not an official statement</span><span>${esc(page)}</span></div>`;
}

// ---------------------------------------------------------------------------------------------
// Map

export interface MapOptions {
  width: number;
  height: number;
  /** Draw the survey points as clickable targets (data-point). */
  interactive?: boolean;
  /** Layers shown at first (the page toggles them). */
  landings?: boolean;
  swath?: boolean;
  labels?: boolean;
}

export function mapSvg(m: MapData, o: MapOptions): string {
  const { x0, z0, x1, z1 } = m.bounds;
  const w = x1 - x0;
  const h = z1 - z0;
  // Keep the aspect: fit the bounds in the box (north up: −Z is up, +X east).
  const k = Math.min(o.width / w, o.height / h);
  const ox = (o.width - w * k) / 2;
  const oy = (o.height - h * k) / 2;
  const X = (x: number) => (ox + (x - x0) * k).toFixed(1);
  const Y = (z: number) => (oy + (z - z0) * k).toFixed(1);
  const pts = (p: { x: number; z: number }[]) => p.map((q) => `${X(q.x)},${Y(q.z)}`).join(" ");
  const r = Math.max(1.6, Math.min(4, 9 * k));
  const parts: string[] = [];
  parts.push(`<rect x="0" y="0" width="${o.width}" height="${o.height}" class="rp-map-bg"/>`);
  // Houses outside the survey, faint, for the town's shape.
  if (m.houses.length) parts.push(`<path class="rp-map-house" d="${m.houses.map((q) => `M${X(q.x)} ${Y(q.z)}h0.01`).join("")}" stroke-width="${(r * 0.9).toFixed(1)}"/>`);
  // True-wind swath (toggle).
  parts.push(`<g class="rp-layer-swath"${o.swath ? "" : ' style="display:none"'}>`);
  for (const s of m.swath) parts.push(`<rect x="${X(s.x)}" y="${Y(s.z)}" width="${(s.w * k + 0.3).toFixed(1)}" height="${(s.h * k + 0.3).toFixed(1)}" fill="${efColor(s.ef)}" fill-opacity="0.45"/>`);
  for (const c of m.contours.true) for (const p of c.polygons) parts.push(`<polygon points="${pts(p)}" fill="none" stroke="${efColor(c.ef)}" stroke-width="1" stroke-dasharray="4 3"/>`);
  parts.push(`</g>`);
  // Survey EF contours, weakest first so stronger ones sit on top.
  for (const c of m.contours.survey) for (const p of c.polygons) parts.push(`<polygon class="rp-contour" points="${pts(p)}" fill="${efColor(c.ef)}" fill-opacity="0.16" stroke="${efColor(c.ef)}" stroke-width="1.6"/>`);
  // Track.
  if (m.track.length > 1) parts.push(`<polyline class="rp-track" points="${pts(m.track)}"/>`);
  // Debris landings (toggle).
  if (m.landings.length) parts.push(`<path class="rp-layer-landings rp-landing" d="${m.landings.map((q) => `M${X(q.x)} ${Y(q.z)}h0.01`).join("")}"${o.landings ? "" : ' style="display:none"'}/>`);
  // Undamaged houses in the swath.
  for (const q of m.noDamage) parts.push(`<circle cx="${X(q.x)}" cy="${Y(q.z)}" r="${(r * 0.8).toFixed(1)}" class="rp-nodamage"/>`);
  // Survey points by DOD color (strongest on top).
  for (const q of [...m.points].sort((a, b) => a.dod - b.dod))
    parts.push(`<circle cx="${X(q.x)}" cy="${Y(q.z)}" r="${r.toFixed(1)}" fill="${dodColor(q.dod)}" class="rp-pt"${o.interactive ? ` data-point="${q.point}"` : ""}><title>${q.point}: DOD ${q.dod}</title></circle>`);
  // Town center.
  parts.push(`<g class="rp-center"><circle cx="${X(m.townCenter.x)}" cy="${Y(m.townCenter.z)}" r="5"/><line x1="${+X(m.townCenter.x) - 8}" y1="${Y(m.townCenter.z)}" x2="${+X(m.townCenter.x) + 8}" y2="${Y(m.townCenter.z)}"/><line x1="${X(m.townCenter.x)}" y1="${+Y(m.townCenter.z) - 8}" x2="${X(m.townCenter.x)}" y2="${+Y(m.townCenter.z) + 8}"/></g>`);
  if (o.labels) parts.push(`<text x="${+X(m.townCenter.x) + 9}" y="${+Y(m.townCenter.z) - 7}" class="rp-map-label">town center</text>`);
  // North arrow and scale bar.
  const nx = o.width - 26;
  parts.push(`<g class="rp-north"><path d="M${nx} 14 l7 18 l-7 -5 l-7 5 z"/><text x="${nx}" y="46" text-anchor="middle">N</text></g>`);
  const want = w / 5;
  const nice = [100, 200, 250, 500, 1000, 2000, 2500, 5000].reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
  const sx = 14;
  const sy = o.height - 16;
  parts.push(
    `<g class="rp-scale"><line x1="${sx}" y1="${sy}" x2="${(sx + nice * k).toFixed(1)}" y2="${sy}"/><line x1="${sx}" y1="${sy - 4}" x2="${sx}" y2="${sy + 4}"/><line x1="${(sx + nice * k).toFixed(1)}" y1="${sy - 4}" x2="${(sx + nice * k).toFixed(1)}" y2="${sy + 4}"/><text x="${sx}" y="${sy - 7}">${nice >= 1000 ? `${nice / 1000} km` : `${nice} m`} (${(nice / M_PER_MI).toFixed(2)} mi)</text></g>`,
  );
  return `<svg class="rp-map" viewBox="0 0 ${o.width} ${o.height}" width="100%" role="img" aria-label="Track map with EF contours and survey points">${parts.join("")}</svg>`;
}

function mapLegend(): string {
  const ef = [0, 1, 2, 3, 4, 5].map((e) => `<span><i style="background:${efColor(e as EFRating)}"></i>EF${e}</span>`).join("");
  const dod = [1, 3, 5, 7, 9].map((d) => `<span><i class="dot" style="background:${dodColor(d)}"></i>DOD ${d}–${d + 1}</span>`).join("");
  return `<div class="rp-legend"><b>Contours</b>${ef}<b>Survey points</b>${dod}<span><i class="dot nd"></i>no damage, in the swath</span><span><i class="line"></i>track</span></div>`;
}

// ---------------------------------------------------------------------------------------------
// Charts

interface Series {
  t: number[];
  v: (number | null)[];
  color: string;
  label: string;
}

function lineChart(title: string, unit: string, series: Series[], o: { width?: number; height?: number; bands?: { from: number; to: number; color: string; label: string }[]; yMin?: number } = {}): string {
  const W = o.width ?? 640;
  const H = o.height ?? 170;
  const L = 48;
  const R = 12;
  const T = 22;
  const B = 26;
  const ts = series.flatMap((s) => s.t);
  const vs = series.flatMap((s) => s.v.filter((x): x is number => x !== null));
  if (!ts.length || !vs.length) return `<div class="rp-chart-empty">${esc(title)}: no data</div>`;
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts, t0 + 1);
  let y0 = o.yMin ?? Math.min(0, ...vs);
  let y1 = Math.max(...vs, y0 + 1);
  if (o.bands) y1 = Math.max(y1, ...o.bands.filter((b) => b.from < y1 * 1.05).map((b) => Math.min(b.to, y1 * 1.08)));
  y1 *= 1.05;
  const X = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const parts: string[] = [];
  for (const b of o.bands ?? []) {
    if (b.from > y1) continue;
    const top = Y(Math.min(b.to, y1));
    const bot = Y(Math.max(b.from, y0));
    parts.push(`<rect x="${L}" y="${top.toFixed(1)}" width="${W - L - R}" height="${(bot - top).toFixed(1)}" fill="${b.color}" fill-opacity="0.13"/>`);
    // Label a band only where it's tall enough to hold it.
    if (bot - top >= 12) parts.push(`<text x="${W - R - 3}" y="${(top + 11).toFixed(1)}" text-anchor="end" class="rp-band">${esc(b.label)}</text>`);
  }
  // Axes and ticks.
  const ticks = (a: number, b: number, n: number) => {
    const step = Math.pow(10, Math.floor(Math.log10((b - a) / n)));
    const m = [1, 2, 5, 10].find((q) => (b - a) / (q * step) <= n)! * step;
    const out: number[] = [];
    for (let v = Math.ceil(a / m) * m; v <= b + 1e-9; v += m) out.push(v);
    return out;
  };
  for (const v of ticks(y0, y1, 4)) parts.push(`<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="rp-grid"/><text x="${L - 5}" y="${(Y(v) + 3.5).toFixed(1)}" text-anchor="end">${f1(v)}</text>`);
  for (const t of ticks(t0, t1, 6)) parts.push(`<text x="${X(t).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(timeText(t))}</text>`);
  parts.push(`<line x1="${L}" x2="${L}" y1="${T}" y2="${H - B}" class="rp-axis"/><line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="rp-axis"/>`);
  for (const s of series) {
    let d = "";
    let pen = false;
    s.t.forEach((t, i) => {
      const v = s.v[i];
      if (v === null || v === undefined) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${X(t).toFixed(1)} ${Y(v).toFixed(1)}`;
      pen = true;
    });
    parts.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"/>`);
  }
  const legend = series.length > 1 ? series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join("") : "";
  return `<figure class="rp-chart"><figcaption>${esc(title)} <small>(${esc(unit)})</small>${legend ? `<span class="rp-chart-legend">${legend}</span>` : ""}</figcaption><svg viewBox="0 0 ${W} ${H}" width="100%">${parts.join("")}</svg></figure>`;
}

const PHASE_COLOR: Record<string, string> = { "spin-up": "#7fb3d5", mature: "#c0392b", "rope-out": "#d4ac0d", dissipated: "#aab7b8" };

function phaseStrip(r: Report): string {
  const { t, phase } = r.timeline;
  if (t.length < 2) return "";
  const W = 640;
  const L = 48;
  const R = 12;
  const t0 = t[0]!;
  const t1 = t[t.length - 1]!;
  const X = (v: number) => L + ((v - t0) / Math.max(t1 - t0, 1)) * (W - L - R);
  const parts: string[] = [];
  let a = 0;
  for (let i = 1; i <= t.length; i++) {
    if (i < t.length && phase[i] === phase[a]) continue;
    const x0 = X(t[a]!);
    const x1 = X(t[Math.min(i, t.length - 1)]!);
    parts.push(`<rect x="${x0.toFixed(1)}" y="4" width="${Math.max(x1 - x0, 1).toFixed(1)}" height="16" fill="${PHASE_COLOR[phase[a]!] ?? "#999"}"/>`);
    if (x1 - x0 > 50) parts.push(`<text x="${((x0 + x1) / 2).toFixed(1)}" y="16" text-anchor="middle" class="rp-phase-text">${esc(phase[a])}</text>`);
    a = i;
  }
  return `<figure class="rp-chart"><figcaption>Lifecycle phase</figcaption><svg viewBox="0 0 ${W} 24" width="100%">${parts.join("")}</svg></figure>`;
}

function efBands() {
  return [0, 1, 2, 3, 4, 5].map((e) => ({ from: EF_LOWER_MPH[e]!, to: e < 5 ? EF_LOWER_MPH[e + 1]! : 320, color: efColor(e as EFRating), label: `EF${e}` }));
}

function histogram(title: string, bin: number, counts: number[]): string {
  if (!counts.length) return `<div class="rp-chart-empty">${esc(title)}: no landed debris</div>`;
  const W = 640;
  const H = 160;
  const L = 48;
  const B = 26;
  const T = 16;
  const max = Math.max(...counts, 1);
  const bw = (W - L - 12) / counts.length;
  const bars = counts.map((c, i) => `<rect x="${(L + i * bw + 0.5).toFixed(1)}" y="${(T + (1 - c / max) * (H - T - B)).toFixed(1)}" width="${Math.max(bw - 1, 0.5).toFixed(1)}" height="${((c / max) * (H - T - B)).toFixed(1)}" class="rp-hist"><title>${i * bin}–${(i + 1) * bin} m: ${n0(c)}</title></rect>`);
  const labels: string[] = [];
  const every = Math.max(1, Math.ceil(counts.length / 8));
  for (let i = 0; i <= counts.length; i += every) labels.push(`<text x="${(L + i * bw).toFixed(1)}" y="${H - 8}" text-anchor="middle">${i * bin} m</text>`);
  return `<figure class="rp-chart"><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" width="100%"><line x1="${L}" x2="${W - 12}" y1="${H - B}" y2="${H - B}" class="rp-axis"/><text x="${L - 5}" y="${T + 4}" text-anchor="end">${n0(max)}</text>${bars.join("")}${labels.join("")}</svg></figure>`;
}

// ---------------------------------------------------------------------------------------------
// Sections

/** The event summary block, in the plain style of a survey statement. */
export function summaryBlock(r: Report): string {
  const e = r.event;
  const width = e.maxWidthM;
  const rows: [string, string][] = [
    ["Rating", efText(e.rating)],
    ["Estimated peak wind", e.rating === null ? "—" : speedText(e.ratingMph)],
    ["True peak wind (simulation, 10 m)", e.truePeakMph ? `${speedText(e.truePeakMph)} · ${efText(e.truePeakEf)}` : "—"],
    ["Path length", distText(e.pathLengthM)],
    ["Maximum path width", `${n0(width / M_PER_YD)} yd (${n0(width)} m)`],
    ["Start", e.start ? `${placeText(e.start)} · ${e.start.t === null ? "—" : timeText(e.start.t)} into the run` : "—"],
    ["End", e.end ? `${placeText(e.end)} · ${e.end.t === null ? "—" : timeText(e.end.t)} into the run` : "—"],
    ["Forward speed and heading", `${speedText(e.forwardSpeed / MS_PER_MPH)} toward the ${e.headingCompass} (${Math.round(e.heading)}°)`],
    ["Time on the ground", `${timeText(e.duration)}${e.dissipated ? "" : " (still on the ground when the report was made)"}`],
    ["Deaths and injuries", e.casualties],
  ];
  return `<dl class="rp-block">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
}

function headline(r: Report): string {
  const h = r.summary.headline;
  const cell = (big: string, small: string, cls = "") => `<div class="rp-num ${cls}"><b>${esc(big)}</b><span>${esc(small)}</span></div>`;
  return `<div class="rp-nums">${cell(efText(h.rating), "rating", "rp-num-ef")}${cell(h.rating === null ? "—" : `${Math.round(h.peakMph)} mph`, "estimated peak wind")}${cell(n0(h.destroyed), `houses destroyed (DOD 8+)`)}${cell(`${(h.pathLengthM / M_PER_MI).toFixed(2)} mi`, `path length (${(h.pathLengthM / 1000).toFixed(2)} km)`)}</div>`;
}

function summaryPage(r: Report): string {
  return `<section class="rp-page rp-summary" id="rp-summary">${pageMark(r, "Summary")}
  <header class="rp-head"><h1>${esc(r.title)}: ${esc(efText(r.event.rating))} tornado</h1><p class="rp-sub">${r.preliminary ? "Preliminary findings, made while the tornado was still on the ground. " : ""}A damage survey of a simulated storm, rated by the Enhanced Fujita method from the damage alone, with the simulation's true wind alongside.</p></header>
  ${headline(r)}
  <div class="rp-summary-grid"><div>${summaryBlock(r)}</div><div>${mapSvg(r.map, { width: 420, height: 320 })}${mapLegend()}</div></div>
  <div class="rp-narr rp-narr-short">${r.summary.narrative.map((s) => `<p>${esc(s)}</p>`).join("")}</div>
</section>`;
}

const COL_LABEL: Record<keyof SurveyRow, string> = {
  point: "Point", building: "Bldg", x: "x (m)", z: "z (m)", along: "Along (m)", cross: "Cross (m)", di: "DI", dod: "DOD", description: "Damage", construction: "Construction",
  surveyMph: "Survey (mph)", surveyMs: "(m/s)", ef: "EF", rangeMph: "DOD range (mph)", rangeEf: "EF range", true10Mph: "True 10 m (mph)", trueRoofMph: "True roof (mph)", biasMph: "Bias (mph)",
  outsideBounds: "Outside range", firstDamagedS: "First damaged (s)",
};

/** Columns shown on the page (the CSV has every one). */
const PAGE_COLS: (keyof SurveyRow)[] = ["point", "dod", "description", "construction", "surveyMph", "ef", "rangeMph", "rangeEf", "true10Mph", "trueRoofMph", "biasMph", "firstDamagedS", "along", "cross"];

export function tableHtml(rows: SurveyRow[]): string {
  const head = PAGE_COLS.map((c) => `<th data-col="${c}" title="Sort">${esc(COL_LABEL[c])}</th>`).join("");
  const body = rows
    .map((r) => {
      const cells = PAGE_COLS.map((c) => {
        const v = r[c];
        const shown = c === "construction" ? String(v).split(" ")[0] : c === "firstDamagedS" && v !== null ? timeText(Number(v)) : v === null ? "—" : v;
        const cls = c === "biasMph" && r.outsideBounds ? ' class="rp-out"' : c === "dod" ? ` style="--dod:${dodColor(r.dod)}" class="rp-dod"` : "";
        return `<td${cls} data-v="${esc(v ?? "")}">${esc(shown)}</td>`;
      }).join("");
      return `<tr id="rp-row-${r.point}" data-point="${r.point}">${cells}</tr>`;
    })
    .join("");
  return `<div class="rp-table-wrap"><table class="rp-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function failuresHtml(r: Report): string {
  const f = r.failures;
  const causeText = (s: Report["failures"]["houses"][number]["steps"][number]) =>
    s.cause === "debris" ? `debris impact${s.missile ? `: ${s.missile}` : ""}` : s.cause === "collapse" ? "fell with a bearing wall" : "wind (net pressure)";
  // Enough digits that a load just over its capacity doesn't read as a tie.
  const num = (v: number, ref: number) => (Math.abs(v - ref) < 1 && Math.abs(v) >= 1 ? f1(v) : Math.abs(v) < 10 ? f1(v) : n0(v));
  const loadText = (s: Report["failures"]["houses"][number]["steps"][number]) => (s.cause === "collapse" ? "—" : `${num(s.load, s.capacity)} / ${num(s.capacity, s.load)} ${s.unit}`);
  const houses = f.houses.length
    ? f.houses
        .map(
          (h) => `<details class="rp-seq"${h === f.houses[0] ? " open" : ""}><summary><b>${esc(h.point)}</b> · DOD ${h.dod}: ${esc(h.description)} · ${esc(h.construction.split(" ")[0])} · survey ${n0(h.surveyMph)} mph, true 10 m ${n0(h.true10Mph)} mph · ${h.steps.length} failures</summary>
<table class="rp-table rp-small"><thead><tr><th>Time</th><th>Part</th><th>Roof wind (mph)</th><th>Load / capacity</th><th>Cause</th></tr></thead><tbody>${h.steps
            .map((s) => `<tr><td>${esc(timeText(s.time))}</td><td>${esc(s.part)}</td><td>${n0(s.mph)}</td><td>${esc(loadText(s))}</td><td>${esc(causeText(s))}</td></tr>`)
            .join("")}</tbody></table></details>`,
        )
        .join("")
    : "<p>No house reached a rated EF.</p>";
  const first = f.firstToFail.length
    ? `<table class="rp-table rp-small"><thead><tr><th>First part to fail</th><th>Houses</th></tr></thead><tbody>${f.firstToFail.map((x) => `<tr><td>${esc(x.part)}</td><td>${n0(x.count)}</td></tr>`).join("")}</tbody></table>`
    : "";
  const cas = f.cascades.length
    ? `<table class="rp-table rp-small"><thead><tr><th>DOD</th><th>Sequence of parts (in order of first failure)</th><th>Houses</th></tr></thead><tbody>${f.cascades.map((c) => `<tr><td>${c.dod}</td><td>${esc(c.sequence.join(" → "))}</td><td>${c.count}</td></tr>`).join("")}</tbody></table>`
    : "";
  return `<p>The houses rated at the storm's EF (the most damaged first, up to 10), each failure in order. Wind failures give the net pressure on the part against its capacity; impact failures give the missile and its momentum, energy or impulse pressure against the threshold.</p>${houses}<h3>Failure modes across the town</h3><div class="rp-two">${first}${cas}</div>`;
}

function debrisHtml(r: Report): string {
  const d = r.debris;
  const kinds = `<table class="rp-table rp-small"><thead><tr><th>Kind</th><th>Pieces</th><th>Mass (kg)</th></tr></thead><tbody>${d.byKind
    .slice(0, 14)
    .map((k) => `<tr><td>${esc(k.kind)}</td><td>${n0(k.count)}</td><td>${n0(k.mass)}</td></tr>`)
    .join("")}</tbody></table>`;
  const imp = `<table class="rp-table rp-small"><thead><tr><th>Surface</th><th>Impacts</th><th>Broke</th><th>Perforated</th><th>Siding torn</th><th>Covering torn</th></tr></thead><tbody>${Object.entries(d.impacts)
    .map(([k, t]) => `<tr><td>${esc(k)}</td><td>${n0(t.hits)}</td><td>${n0(t.broke)}</td><td>${n0(t.perforated)}</td><td>${n0(t.sidingTorn)}</td><td>${n0(t.coverTorn)}</td></tr>`)
    .join("")}</tbody></table>`;
  const facts: [string, string][] = [
    ["Pieces launched", `${n0(d.launchedReal)} (${n0(d.launched)} tracked)`],
    ["Mass launched", `${n0(d.spawnedMass)} kg`],
    ["Lofted into the storm", `${n0(d.loftedMass)} kg`],
    ["Heaviest piece lofted", d.heaviestLofted ? `${d.heaviestLofted.kind}, ${f1(d.heaviestLofted.mass)} kg` : "none"],
    ["Farthest travel", d.farthest ? `${distText(d.farthest.distance)}: ${d.farthest.kind}, ${f1(d.farthest.mass)} kg` : "none landed"],
    ["Impacts on houses", `${n0(d.impactsTotal)} (every contact the impact model resolved, including glancing and repeated ones)`],
    ["Houses damaged by debris alone", n0(d.debrisOnly)],
  ];
  return `<dl class="rp-block rp-block-tight">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl><div class="rp-two">${kinds}${imp}</div>${histogram("Travel distance of landed debris (pieces per 50 m)", d.travel.bin, d.travel.counts)}`;
}

function statsHtml(r: Report): string {
  const s = r.stats;
  const maxD = Math.max(...s.byDod.slice(1), 1);
  const dodRows = s.byDod
    .map((c, d) => (d === 0 ? "" : `<tr><td class="rp-dod" style="--dod:${dodColor(d)}">${d}</td><td>${esc(dodText(d))}</td><td>${n0(c)}</td><td><span class="rp-hbar" style="width:${((c / maxD) * 100).toFixed(1)}%"></span></td></tr>`))
    .join("");
  const efRows = s.byEf.map((e) => `<tr><td><i class="rp-sw" style="background:${efColor(e.ef)}"></i>${esc(efText(e.ef))}</td><td>${n0(e.count)}</td></tr>`).join("");
  const facts: [string, string][] = [
    ["Houses in town", n0(s.total)],
    ["Damaged (DOD 1+)", n0(s.damaged)],
    ["Destroyed (DOD 8+)", `${n0(s.destroyed)} (${(s.destroyedShare * 100).toFixed(0)}% of damaged)`],
    ["Area inside the EF0 survey contour", `${f1(s.damagedArea / 1e6)} km² (${f1(s.damagedArea / (M_PER_MI * M_PER_MI))} mi²)`],
    ["Area of the EF0 true-wind swath", `${f1(s.trueArea / 1e6)} km² (${f1(s.trueArea / (M_PER_MI * M_PER_MI))} mi²)`],
  ];
  return `<dl class="rp-block rp-block-tight">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl><div class="rp-two"><table class="rp-table rp-small"><thead><tr><th>DOD</th><th>Damage</th><th>Houses</th><th></th></tr></thead><tbody>${dodRows}</tbody></table><table class="rp-table rp-small"><thead><tr><th>Survey EF</th><th>Houses</th></tr></thead><tbody>${efRows}</tbody></table></div>`;
}

function methodsHtml(r: Report): string {
  const m = r.methods;
  const meta = `<table class="rp-table rp-small rp-meta"><tbody>${m.metadata.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>`;
  const simp = m.simplifications.length
    ? m.simplifications.map((s) => `<details><summary>${esc(s.spec)}</summary><ul>${s.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></details>`).join("")
    : "<p>(Spec documents not loaded.)</p>";
  return `${m.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}<h3>Run metadata (enough to rerun this storm)</h3>${meta}<h3>The model's simplifications</h3><div class="rp-simp">${simp}</div>`;
}

function section(r: Report, id: string, n: number, title: string, body: string): string {
  return `<section class="rp-page" id="${id}">${pageMark(r, `${n}. ${title}`)}<h2>${n}. ${esc(title)}</h2>${body}</section>`;
}

/** The full report: the summary page first, then sections 2–10 (Spec 16). */
export function renderReport(r: Report): string {
  const tl = r.timeline;
  const timelineBody =
    lineChart("Peak wind at 10 m (EF readout's)", "mph", [{ t: tl.t, v: tl.peakMph, color: "#1f2933", label: "peak" }], { bands: efBands(), yMin: 0 }) +
    phaseStrip(r) +
    lineChart("Core radius R_max", "m", [{ t: tl.t, v: tl.rMax, color: "#2e86c1", label: "R_max" }]) +
    lineChart("Forward speed", "mph", [{ t: tl.t, v: tl.speed.map((s) => s / MS_PER_MPH), color: "#7d3c98", label: "speed" }]) +
    lineChart("Damaged houses (DOD 1+)", "houses", [{ t: tl.t, v: tl.damaged, color: "#c0392b", label: "damaged" }]);
  const toggles = `<div class="rp-toggles rp-noprint"><label><input type="checkbox" data-layer="swath"> True-wind swath and contours (dashed)</label><label><input type="checkbox" data-layer="landings"> Debris landing points</label><span class="rp-hint">Click a survey point for its row in the table.</span></div>`;
  const tableIntro = `<p>One row per survey point, along the track (P1 first). The survey speed comes from the DOD and construction class alone; the true peaks are what the simulation recorded at the house. Bias is survey minus true 10 m wind; <span class="rp-out">highlighted</span> rows had a true wind outside their DOD's range. Click a column to sort.</p>`;
  const blockIntro = `<p>${esc(r.event.casualties)}</p>`;
  return `<article class="rp-doc">
${summaryPage(r)}
${section(r, "rp-event", 2, "Event summary", summaryBlock(r) + blockIntro)}
${section(r, "rp-narrative", 3, "Narrative", `<div class="rp-narr">${r.narrative.map((s) => `<p>${esc(s)}</p>`).join("")}</div>`)}
${section(r, "rp-map", 4, "Track map", toggles + mapSvg(r.map, { width: 900, height: 620, interactive: true, labels: true }) + mapLegend())}
${section(r, "rp-table", 5, "Damage survey", tableIntro + tableHtml(r.table))}
${section(r, "rp-timeline", 6, "Intensity timeline", timelineBody)}
${section(r, "rp-failures", 7, "How the houses failed", failuresHtml(r))}
${section(r, "rp-debris", 8, "Debris", debrisHtml(r))}
${section(r, "rp-stats", 9, "Statistics", statsHtml(r))}
${section(r, "rp-methods", 10, "Methods and limitations", methodsHtml(r))}
</article>`;
}
