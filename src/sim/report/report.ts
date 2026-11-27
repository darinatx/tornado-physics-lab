/**
 * The storm report (Spec 16): everything the report page shows, built from the record and the
 * survey by pure functions, so the whole report is testable without a browser.
 */
import { CLASS_LABEL, DI2_DODS, PART_LABEL } from "../../config/buildings";
import type { Part } from "../../config/buildings";
import { COMPASS16, REPORT } from "../../config/report";
import { efRating } from "../../core/wind/efScale";
import type { EFRating } from "../../core/wind/efScale";
import type { DebrisRecordEntry, ImpactTally, StormRecord } from "../stormRecord";
import { compassOf } from "../stormRecord";
import { mphOf } from "./format";
import { narrative, summaryNarrative } from "./narrative";
import type { SpecDoc } from "./specDocs";
import { runPolygon, swathCells, TrackLine } from "./survey";
import type { PathEnd, Survey } from "./survey";
import { surveyRows } from "./table";
import type { SurveyRow } from "./table";

/** A survey point named in the summary: its table ID, building, DOD, class, speed and EF. */
export interface NamedPoint {
  point: string;
  building: number;
  dod: number;
  construction: string;
  mph: number;
  ef: EFRating | null;
}

export interface EventSummary {
  rating: EFRating | null;
  /** Estimated peak wind (mph), from the survey. */
  ratingMph: number;
  /** The two points that set the rating (Spec 16 v1.9) and their distance (m); the second is
   *  null when no two points were within the corroboration radius. */
  ratingBy: { point: NamedPoint; corroboratedBy: NamedPoint | null; distanceM: number | null } | null;
  /** Points above the rating, not corroborated (kept in the table). */
  uncorroborated: NamedPoint[];
  truePeakMph: number;
  truePeakEf: EFRating | null;
  pathLengthM: number;
  maxWidthM: number;
  start: PathEnd | null;
  end: PathEnd | null;
  /** Mean forward speed (m/s) and compass heading of travel while on the ground. */
  forwardSpeed: number;
  heading: number;
  headingCompass: string;
  /** Time on the ground (s): from formation to dissipation, or to when the report was made. */
  duration: number;
  formedAt: number | null;
  endedAt: number | null;
  /** The tornado had dissipated when the report was made. */
  dissipated: boolean;
  casualties: string;
}

export interface Headline {
  rating: EFRating | null;
  peakMph: number;
  destroyed: number;
  pathLengthM: number;
}

export interface MapData {
  /** Bounds of everything drawn (m), padded. */
  bounds: { x0: number; z0: number; x1: number; z1: number };
  track: { x: number; z: number }[];
  /** Contour polygons per EF level, survey and true. */
  contours: { survey: { ef: EFRating; polygons: { x: number; z: number }[][] }[]; true: { ef: EFRating; polygons: { x: number; z: number }[][] }[] };
  points: { point: string; x: number; z: number; dod: number }[];
  noDamage: { x: number; z: number }[];
  /** Houses with no survey point and no swath wind (drawn faintly for the town's shape). */
  houses: { x: number; z: number }[];
  /** Debris landing points (every one, or a deterministic sample of at most 4000). */
  landings: { x: number; z: number }[];
  /** True-wind swath as row runs of cells at one EF level. */
  swath: { x: number; z: number; w: number; h: number; ef: EFRating }[];
  townCenter: { x: number; z: number };
}

export interface TimelineData {
  t: number[];
  peakMph: number[];
  ef: (EFRating | null)[];
  rMax: number[];
  speed: number[];
  phase: string[];
  /** Buildings damaged (DOD ≥ 1) by each time. */
  damaged: number[];
}

export interface FailureStep {
  time: number;
  part: string;
  mph: number;
  load: number;
  capacity: number;
  /** "Pa", "N" (detail-zone connections), or the impact measure's unit. */
  unit: string;
  cause: "wind" | "debris" | "collapse";
  missile?: string;
}

export interface FailureHouse {
  point: string;
  building: number;
  dod: number;
  description: string;
  construction: string;
  surveyMph: number;
  true10Mph: number;
  steps: FailureStep[];
}

export interface DebrisFigures {
  launched: number;
  /** Real pieces each launched record stands for, summed. */
  launchedReal: number;
  byKind: { kind: string; count: number; mass: number }[];
  loftedMass: number;
  spawnedMass: number;
  heaviestLofted: { kind: string; mass: number; maxHeight: number } | null;
  farthest: { kind: string; distance: number; source: number; mass: number } | null;
  /** Travel distance histogram of landed pieces: bin width (m) and counts. */
  travel: { bin: number; counts: number[] };
  impacts: Record<string, ImpactTally>;
  impactsTotal: number;
  /** Buildings whose every failure was a debris impact. */
  debrisOnly: number;
}

export interface Statistics {
  total: number;
  byDod: number[];
  byEf: { ef: EFRating | null; count: number }[];
  damaged: number;
  destroyed: number;
  destroyedShare: number;
  /** Area inside the EF0 survey contour (m²) and the EF0 true swath (m²). */
  damagedArea: number;
  trueArea: number;
}

export interface Methods {
  paragraphs: string[];
  /** Rows of run metadata: label, value. */
  metadata: [string, string][];
  /** Simplifications grouped by spec. */
  simplifications: { spec: string; items: string[] }[];
  /** Mean 10 m ÷ roof-height peak over the survey points (rating basis against the local wind). */
  heightRatio: number | null;
}

export interface Report {
  preliminary: boolean;
  title: string;
  /** "Simulated storm report" (on every page; never an official product). */
  mark: string;
  simTime: number;
  summary: { block: EventSummary; headline: Headline; narrative: string[] };
  event: EventSummary;
  narrative: string[];
  map: MapData;
  table: SurveyRow[];
  timeline: TimelineData;
  failures: { houses: FailureHouse[]; firstToFail: { part: string; count: number }[]; cascades: { dod: number; sequence: string[]; count: number }[] };
  debris: DebrisFigures;
  stats: Statistics;
  methods: Methods;
  survey: Survey;
  /** The record it was built from (the JSON export carries it, Spec 16 REP-14). */
  record: StormRecord;
}

export const REPORT_MARK = "Simulated storm report";

const label = (part: string) => PART_LABEL[part as Part] ?? part;

function eventSummary(record: StormRecord, survey: Survey, rows: SurveyRow[]): EventSummary {
  const rowOf = new Map(rows.map((r) => [r.building, r.point] as const));
  const named = (i: number): NamedPoint => {
    const p = survey.points[i]!;
    return { point: rowOf.get(p.id)!, building: p.id, dod: p.dod, construction: CLASS_LABEL[p.cls], mph: p.mph, ef: p.ef };
  };
  const rp = survey.ratingPoint;
  const cp = survey.corroboratingPoint;
  const ratingBy =
    rp === null
      ? null
      : {
          point: named(rp),
          corroboratedBy: cp === null ? null : named(cp),
          distanceM: cp === null ? null : Math.hypot(survey.points[rp]!.x - survey.points[cp]!.x, survey.points[rp]!.z - survey.points[cp]!.z),
        };
  const on = record.track.filter((t) => t.vMax > 0);
  const last = record.track[record.track.length - 1];
  const dissipated = last?.phase === "dissipated";
  const formedAt = on.length ? on[0]!.t : null;
  const endedAt = on.length ? (dissipated ? on[on.length - 1]!.t : last!.t) : null;
  const forwardSpeed = on.length ? on.reduce((s, t) => s + t.speed, 0) / on.length : 0;
  // Heading of the whole path: first to last on-ground position.
  const a = on[0];
  const b = on[on.length - 1];
  const heading = a && b && (a.x !== b.x || a.z !== b.z) ? compassOf(b.x - a.x, b.z - a.z) : (last?.heading ?? 0);
  return {
    rating: survey.rating,
    ratingMph: survey.ratingMph,
    ratingBy,
    uncorroborated: survey.uncorroborated.map(named),
    truePeakMph: survey.truePeak?.mph ?? 0,
    truePeakEf: survey.truePeak?.ef ?? null,
    pathLengthM: survey.path.survey.length,
    maxWidthM: survey.path.survey.maxWidth,
    start: survey.start,
    end: survey.end,
    forwardSpeed,
    heading,
    headingCompass: COMPASS16[Math.round(heading / 22.5) % 16]!,
    duration: formedAt !== null && endedAt !== null ? endedAt - formedAt : 0,
    formedAt,
    endedAt,
    dissipated,
    casualties: "Not given: the simulation has no people (no deaths, injuries, warnings or shelters).",
  };
}

function mapData(record: StormRecord, survey: Survey, rows: SurveyRow[]): MapData {
  const line = new TrackLine(record.track);
  const poly = (cs: Survey["contours"]["survey"]) => cs.map((c) => ({ ef: c.ef, polygons: c.runs.map((r) => runPolygon(line, r)) }));
  const byIndex = new Map(survey.points.map((p) => [p.id, p] as const));
  const points = rows.map((r) => ({ point: r.point, x: byIndex.get(r.building)!.x, z: byIndex.get(r.building)!.z, dod: r.dod }));
  const rated = new Set([...survey.points.map((p) => p.index), ...survey.noDamage.map((p) => p.index)]);
  const houses = record.buildings.filter((b) => !rated.has(b.index)).map((b) => ({ x: b.x, z: b.z }));
  const landed = record.debris.pieces.filter((p) => p.fate === "landed");
  const step = Math.max(1, Math.ceil(landed.length / 4000));
  const landings = landed.filter((_, i) => i % step === 0).map((p) => ({ x: p.endX, z: p.endZ }));
  // Swath: runs of cells along each row at one EF level.
  const C = record.swath.cell;
  const T = record.swath.tile;
  const rowsMap = new Map<number, { ci: number; ef: EFRating }[]>();
  for (const t of record.swath.tiles)
    for (let j = 0; j < T; j++)
      for (let i = 0; i < T; i++) {
        const v = t.peak[i + j * T]!;
        if (!(v > 0)) continue;
        const ef = efRating(v);
        if (ef === null) continue;
        const cj = t.tj * T + j;
        let row = rowsMap.get(cj);
        if (!row) rowsMap.set(cj, (row = []));
        row.push({ ci: t.ti * T + i, ef });
      }
  const swath: MapData["swath"] = [];
  for (const [cj, row] of [...rowsMap.entries()].sort((a, b) => a[0] - b[0])) {
    row.sort((a, b) => a.ci - b.ci);
    let s = row[0]!;
    let n = 1;
    for (let k = 1; k <= row.length; k++) {
      const c = row[k];
      if (c && c.ci === s.ci + n && c.ef === s.ef) {
        n++;
        continue;
      }
      swath.push({ x: s.ci * C, z: cj * C, w: n * C, h: C, ef: s.ef });
      if (c) {
        s = c;
        n = 1;
      }
    }
  }
  // Bounds: the track, the damage and the swath, padded by 10%.
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  const grow = (x: number, z: number) => {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  };
  // Frame the damage (the survey points), so the contours and points are big enough to read; the
  // true swath and the track may run off the edge. With no damage, the swath; with no swath
  // either, the track.
  for (const p of points) grow(p.x, p.z);
  if (!points.length)
    for (const q of swath) {
      grow(q.x, q.z);
      grow(q.x + q.w, q.z + q.h);
    }
  if (!points.length && !swath.length) for (const t of record.track.filter((t) => t.vMax > 0)) grow(t.x, t.z);
  if (!Number.isFinite(x0)) {
    grow(record.townCenter.x - 500, record.townCenter.z - 500);
    grow(record.townCenter.x + 500, record.townCenter.z + 500);
  }
  const pad = Math.max(x1 - x0, z1 - z0) * 0.12 + 80;
  return {
    bounds: { x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad },
    track: record.track.filter((t) => t.vMax > 0).map((t) => ({ x: t.x, z: t.z })),
    contours: { survey: poly(survey.contours.survey), true: poly(survey.contours.true) },
    points,
    noDamage: survey.noDamage.map((p) => ({ x: p.x, z: p.z })),
    houses,
    landings,
    swath,
    townCenter: { ...record.townCenter },
  };
}

function timeline(record: StormRecord): TimelineData {
  const firsts = record.buildings.flatMap((b) => {
    const f = b.dodHistory.find(([, d]) => d >= 1);
    return f ? [f[0]] : [];
  });
  firsts.sort((a, b) => a - b);
  let k = 0;
  const damaged: number[] = [];
  for (const s of record.track) {
    while (k < firsts.length && firsts[k]! <= s.t + 1e-9) k++;
    damaged.push(k);
  }
  return {
    t: record.track.map((s) => s.t),
    peakMph: record.track.map((s) => mphOf(s.peak)),
    ef: record.track.map((s) => s.ef),
    rMax: record.track.map((s) => s.rMax),
    speed: record.track.map((s) => s.speed),
    phase: record.track.map((s) => s.phase),
    damaged,
  };
}

const UNIT: Record<string, string> = { momentum: "kg·m/s", energy: "J", pressure: "Pa" };

function failures(record: StormRecord, survey: Survey, rows: SurveyRow[]): Report["failures"] {
  const rowOf = new Map(rows.map((r) => [r.building, r] as const));
  // Houses: every house at the rated EF, the most damaged first, up to 10.
  const chosen = survey.points
    .filter((p) => p.ef !== null && p.ef === survey.rating)
    .sort((a, b) => b.dod - a.dod || b.true10Mph - a.true10Mph || a.index - b.index)
    .slice(0, REPORT.failureHouses);
  const houses: FailureHouse[] = chosen.map((p) => {
    const b = record.buildings[p.index]!;
    return {
      point: rowOf.get(p.id)!.point,
      building: p.id,
      dod: p.dod,
      description: p.description,
      construction: CLASS_LABEL[p.cls],
      surveyMph: p.mph,
      true10Mph: p.true10Mph,
      steps: b.failures.map((f) => ({
        time: f.time,
        part: label(String(f.part)),
        mph: f.mph,
        load: f.load,
        capacity: f.capacity,
        unit: f.cause === "debris" ? (UNIT[f.missile?.measure ?? "pressure"] ?? "") : f.detail ? "N" : "Pa",
        cause: f.cause,
        ...(f.missile ? { missile: `${f.missile.label}, ${f.missile.mass.toFixed(1)} kg at ${f.missile.speed.toFixed(0)} m/s` } : {}),
      })),
    };
  });
  // Failure modes across the town: the first part to fail, and the cascades to the highest DODs.
  const first = new Map<string, number>();
  for (const b of record.buildings) {
    if (b.dod < 1 || !b.failures.length) continue;
    const p = label(String(b.failures[0]!.part));
    first.set(p, (first.get(p) ?? 0) + 1);
  }
  const firstToFail = [...first.entries()].map(([part, count]) => ({ part, count })).sort((a, b) => b.count - a.count || a.part.localeCompare(b.part));
  const topDod = Math.max(0, ...record.buildings.map((b) => b.dod));
  const seqs = new Map<string, { dod: number; sequence: string[]; count: number }>();
  for (const b of record.buildings) {
    if (b.dod < Math.max(1, topDod - 1)) continue;
    const seq: string[] = [];
    for (const f of b.failures) {
      const p = label(String(f.part));
      if (!seq.includes(p)) seq.push(p);
    }
    const k = `${b.dod}|${seq.join(">")}`;
    const s = seqs.get(k);
    if (s) s.count++;
    else seqs.set(k, { dod: b.dod, sequence: seq, count: 1 });
  }
  const cascades = [...seqs.values()].sort((a, b) => b.dod - a.dod || b.count - a.count || a.sequence.join().localeCompare(b.sequence.join())).slice(0, 6);
  return { houses, firstToFail, cascades };
}

function debrisFigures(record: StormRecord): DebrisFigures {
  const P = record.debris.pieces;
  const kinds = new Map<string, { kind: string; count: number; mass: number }>();
  let launchedReal = 0;
  for (const p of P) {
    const k = kinds.get(p.kind) ?? { kind: p.kind, count: 0, mass: 0 };
    k.count += p.represents;
    k.mass += p.mass * p.represents;
    kinds.set(p.kind, k);
    launchedReal += p.represents;
  }
  let heaviest: DebrisRecordEntry | null = null;
  for (const p of P) if (p.fate === "lofted" && (!heaviest || p.mass > heaviest.mass || (p.mass === heaviest.mass && p.id < heaviest.id))) heaviest = p;
  const dist = (p: DebrisRecordEntry) => Math.hypot(p.endX - p.x, p.endZ - p.z);
  let far: DebrisRecordEntry | null = null;
  for (const p of P) if (p.fate === "landed" && (!far || dist(p) > dist(far))) far = p;
  const bin = 50;
  const counts: number[] = [];
  for (const p of P) {
    if (p.fate !== "landed") continue;
    const k = Math.floor(dist(p) / bin);
    while (counts.length <= k) counts.push(0);
    counts[k]! += p.represents;
  }
  const impacts = record.debris.impacts.bySurface;
  const debrisOnly = record.buildings.filter((b) => b.dod >= 1 && b.failures.length > 0 && b.failures.every((f) => f.cause === "debris")).length;
  return {
    launched: P.length,
    launchedReal,
    byKind: [...kinds.values()].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    loftedMass: record.debris.massLofted,
    spawnedMass: record.debris.massSpawned,
    heaviestLofted: heaviest ? { kind: heaviest.kind, mass: heaviest.mass, maxHeight: heaviest.maxHeight } : null,
    farthest: far ? { kind: far.kind, distance: dist(far), source: far.source, mass: far.mass } : null,
    travel: { bin, counts },
    impacts: { ...impacts },
    impactsTotal: Object.values(impacts).reduce((s, t) => s + t.hits, 0),
    debrisOnly,
  };
}

function statistics(record: StormRecord, survey: Survey): Statistics {
  const byDod = new Array<number>(11).fill(0);
  for (const b of record.buildings) byDod[b.dod]!++;
  const efs = new Map<EFRating | null, number>();
  for (const p of survey.points) efs.set(p.ef, (efs.get(p.ef) ?? 0) + 1);
  const byEf = ([null, 0, 1, 2, 3, 4, 5] as (EFRating | null)[]).filter((e) => efs.has(e)).map((ef) => ({ ef, count: efs.get(ef)! }));
  const damaged = survey.points.length;
  const destroyed = record.buildings.filter((b) => b.dod >= 8).length;
  const area = (c: Survey["contours"]["survey"]) => (c.find((x) => x.ef === 0)?.runs ?? []).flat().reduce((s, sec) => s + (sec.hi - sec.lo) * (sec.a1 - sec.a0), 0);
  const trueArea = swathCells(record).length * record.swath.cell * record.swath.cell;
  return { total: record.buildings.length, byDod, byEf, damaged, destroyed, destroyedShare: damaged ? destroyed / damaged : 0, damagedArea: area(survey.contours.survey), trueArea };
}

/** "P12 (DOD 10, strong construction, 220 mph, EF5)". */
export function namedText(p: NamedPoint): string {
  return `${p.point} (DOD ${p.dod}, ${p.construction.split(" ")[0]!.toLowerCase()} construction, ${p.mph} mph, ${p.ef === null ? "below EF0" : `EF${p.ef}`})`;
}

function methods(record: StormRecord, survey: Survey, event: EventSummary, specs: readonly SpecDoc[]): Methods {
  const m = record.meta;
  const ratios = survey.points.filter((p) => p.trueRoofMph > 0).map((p) => p.true10Mph / p.trueRoofMph);
  const heightRatio = ratios.length ? ratios.reduce((s, x) => s + x, 0) / ratios.length : null;
  const paragraphs = [
    "Rating. Every house with visible damage (degree of damage, DOD, 1 or more) is a survey point, rated with the Enhanced Fujita scale's Damage Indicator 2 (one- and two-family residences). The wind assigned to a point is the DOD's expected value for standard construction, its lower bound for weak construction and its upper bound for strong construction, as survey teams adjust for build quality. The tornado is rated by what it hit, so a peak over open ground leaves no mark on the rating.",
    corroborationText(event),
    "True wind. Beside each rating is the wind the simulation itself recorded: the peak ground-relative horizontal wind at 10 m at the house, on the EF scale's basis (an open-terrain 3-second gust), sampled 30 times a second. The roof-height peak is the local wind that actually loaded the house. The true-wind swath holds the same 10 m peak in 10 m cells wherever it reached EF0 (65 mph).",
    `Bias. Survey speed minus true 10 m wind, over ${survey.points.length} points: mean ${survey.bias.mean.toFixed(1)} mph, spread (standard deviation) ${survey.bias.sd.toFixed(1)} mph; ${survey.bias.outside.length} points had a true wind outside their DOD's published range. The house model's strengths are calibrated on the same basis (each DOD's expected speed matches the median 10 m open-terrain peak at houses in the town), so the bias is the survey method's own.${heightRatio !== null ? ` The local wind that loaded the houses was lower: here the 10 m peak averaged ${heightRatio.toFixed(2)}× the roof-height peak (height and the town's roughness).` : ""}`,
    `Path and contours. Path length is measured along the track between the first and last damaged houses; width is the widest cross-track spread of damaged houses in any ${REPORT.section} m section along the track. EF contours outline, section by section, the houses rated at or above each level (padded ${REPORT.contourMargin} m), so no contour is drawn where nothing at that level was damaged. True-wind figures use the swath cells at EF0 or more the same way.`,
    "Narrative. The narrative is written by fixed sentence rules from the numbers in this report, with no randomness; every sentence traces to a figure in the tables.",
  ];
  const fmtParams = Object.entries(m.params)
    .filter(([k]) => ["vPeak", "rMax", "translationSpeed", "heading", "turnRate", "tUp", "tMature", "tRope", "alpha", "inflowRatio", "updraftMax", "overshoot", "zPeak", "cloudBase"].includes(k))
    .map(([k, v]) => `${k} ${typeof v === "number" ? Math.round(v * 1000) / 1000 : String(v)}`)
    .join(", ");
  const metadata: [string, string][] = [
    ["Seed", String(m.seed)],
    ["Preset", m.preset ?? "custom"],
    ["Parameters", fmtParams],
    ["Terrain", m.terrain],
    ["Physics step", `${(m.dt * 1000).toFixed(3)} ms (1/${Math.round(1 / m.dt)} s)`],
    ["Sim time at report", `${m.simTime.toFixed(1)} s`],
    ["App version", m.appVersion],
    ["Specs", Object.entries(m.specs).map(([f, v]) => `${f.replace(/\.md$/, "")} v${v}`).join(", ") || "not recorded"],
  ];
  const simplifications = specs.filter((s) => s.approved && s.simplifications.length).map((s) => ({ spec: `${s.title} (v${s.version})`, items: s.simplifications }));
  return { paragraphs, metadata, simplifications, heightRatio };
}

/** The corroboration paragraph of Methods (Spec 16 v1.9, REP-17). */
function corroborationText(e: EventSummary): string {
  const R = REPORT.corroborationRadius;
  const rule = `Corroboration. One house can't set the rating alone: the estimated peak wind is the highest survey speed that two damaged houses within ${R} m of each other both reach (the lower of the two), and the rating is its EF, as surveyors rate the highest EF supported by more than one damage indicator and weigh each structure against its neighbours.`;
  const by = e.ratingBy;
  const how = !by
    ? ""
    : by.corroboratedBy
      ? ` Here ${namedText(by.point)} set it, corroborated by ${namedText(by.corroboratedBy)} ${Math.round(by.distanceM!)} m away.`
      : ` Here no two damaged houses were within ${R} m of each other, so the rating rests on one house, ${namedText(by.point)}: it is uncorroborated.`;
  const lone = e.uncorroborated.length
    ? ` Not corroborated (no second house within ${R} m reached their speed), kept in the table and the statistics at their own rating but not used for the tornado's: ${e.uncorroborated.map(namedText).join("; ")}.`
    : "";
  return rule + how + lone;
}

/** The whole report (Spec 16). `specs`: the spec documents, for Methods. */
export function buildReport(record: StormRecord, survey: Survey, opts: { preliminary: boolean; specs?: readonly SpecDoc[] }): Report {
  const rows = surveyRows(survey, record.townCenter);
  const event = eventSummary(record, survey, rows);
  const stats = statistics(record, survey);
  const text = narrative(record, survey);
  const headline: Headline = { rating: event.rating, peakMph: event.ratingMph, destroyed: stats.destroyed, pathLengthM: event.pathLengthM };
  return {
    preliminary: opts.preliminary,
    title: opts.preliminary ? "Preliminary storm survey" : "Storm survey",
    mark: REPORT_MARK,
    simTime: record.meta.simTime,
    summary: { block: event, headline, narrative: summaryNarrative(record, survey) },
    event,
    narrative: text,
    map: mapData(record, survey, rows),
    table: rows,
    timeline: timeline(record),
    failures: failures(record, survey, rows),
    debris: debrisFigures(record),
    stats,
    methods: methods(record, survey, event, opts.specs ?? []),
    survey,
    record,
  };
}

/** DOD description, for display. */
export const dodText = (dod: number) => DI2_DODS.find((r) => r.dod === dod)?.text ?? "No damage";
