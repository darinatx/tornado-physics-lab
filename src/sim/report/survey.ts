/**
 * The damage survey (Spec 16): the storm rated by the EF method from the damage alone, built from
 * the storm record by pure functions, with the sim's true wind beside it.
 */
import { DI2_DODS } from "../../config/buildings";
import type { ConstructionClass } from "../../config/buildings";
import { COMPASS16, REPORT } from "../../config/report";
import { MS_PER_MPH } from "../../config/units";
import { efFromDamage } from "../../core/damage/building";
import { efRating } from "../../core/wind/efScale";
import type { EFRating } from "../../core/wind/efScale";
import type { StormRecord, TrackSample } from "../stormRecord";
import { compassOf } from "../stormRecord";

export interface SurveyPoint {
  /** Building index in the record, and its id. */
  index: number;
  id: number;
  x: number;
  z: number;
  /** Along-track distance (m) and signed cross-track offset (m, + to the left of travel). */
  along: number;
  cross: number;
  /** Damage indicator (DI 2: one- or two-family residences). */
  di: 2;
  dod: number;
  description: string;
  cls: ConstructionClass;
  /** Survey speed (mph) and its EF, with the DOD's range (lower and upper bound). */
  mph: number;
  ef: EFRating | null;
  lowMph: number;
  highMph: number;
  efLow: EFRating | null;
  efHigh: EFRating | null;
  basis: string;
  /** The sim's true peaks (mph): at 10 m (the EF definition) and at roof height. */
  true10Mph: number;
  trueRoofMph: number;
  /** Survey speed minus the true 10 m peak (mph). */
  biasMph: number;
  /** The true 10 m peak falls outside the DOD's bounds. */
  outside: boolean;
  /** Sim time it was first damaged (s), from its DOD history. */
  firstDamaged: number | null;
  /** Its EF is above the rating: no second point within the corroboration radius reaches its
   *  speed, so it was set aside for the rating (kept in the table, map and statistics). */
  uncorroborated: boolean;
  /** No failure of the house was caused by the wind (only debris impacts and the roof bays that
   *  fell with a wall, Spec 16 v1.11): kept in the table, map and DOD counts, but not used for
   *  the rating, path, contours, start and end, or bias. */
  debrisOnly: boolean;
}

/** One along-track section of a contour: its along range and the cross-track span it covers. */
export interface ContourSection {
  k: number;
  a0: number;
  a1: number;
  lo: number;
  hi: number;
}

export interface Contour {
  ef: EFRating;
  /** Runs of consecutive sections (a gap in along-track sections starts a new run). */
  runs: ContourSection[][];
}

export interface PathFigures {
  /** Path length along the track (m) and maximum width (m). */
  length: number;
  maxWidth: number;
  /** Along-track position (m) of the widest section's start. */
  widestAt: number | null;
}

export interface PathEnd {
  t: number | null;
  x: number;
  z: number;
  /** Distance (m) and compass bearing (deg) from the town center, and the 16-point name. */
  distance: number;
  bearing: number;
  compass: string;
}

export interface Survey {
  points: SurveyPoint[];
  /** Buildings in the true swath (EF0 wind or more at 10 m) with no damage: mapped, not rated. */
  noDamage: { index: number; x: number; z: number; true10Mph: number }[];
  /** The rating (Spec 16 v1.9): the EF of the corroborated speed (null: nothing rated). */
  rating: EFRating | null;
  /** Estimated peak wind (mph): the highest survey speed two points within the corroboration
   *  radius both reach (the lower of the pair); with no such pair, the highest point's. */
  ratingMph: number;
  /** The point that set the rating, the pair's lower one (index into points), or null. */
  ratingPoint: number | null;
  /** The pair's other point, at the rating speed or above (index), or null if uncorroborated. */
  corroboratingPoint: number | null;
  /** The rating is backed by two points within the corroboration radius. */
  corroborated: boolean;
  /** Points whose EF is above the rating (indices into points), in point order. */
  uncorroborated: number[];
  /** Debris-damage points (indices into points), in point order. */
  debrisOnly: number[];
  /** The true peak: the swath's maximum (mph), its EF and where. */
  truePeak: { mph: number; ef: EFRating | null; x: number; z: number } | null;
  path: { survey: PathFigures; true: PathFigures };
  contours: { survey: Contour[]; true: Contour[] };
  start: PathEnd | null;
  end: PathEnd | null;
  bias: { mean: number; sd: number; outside: number[] };
}

const mph = (ms: number) => ms / MS_PER_MPH;

/** The track as a polyline for along/cross projection: the samples while the tornado was on
 *  the ground (V_max > 0), or all of them if it never was. */
export class TrackLine {
  private readonly xs: number[] = [];
  private readonly zs: number[] = [];
  private readonly cum: number[] = [];

  constructor(track: readonly TrackSample[]) {
    let pts = track.filter((t) => t.vMax > 0);
    if (pts.length < 2) pts = [...track];
    // Thin to ≥ 25 m spacing (keeps projection cheap; the track is smooth).
    let last: TrackSample | null = null;
    for (const p of pts) {
      if (last && Math.hypot(p.x - last.x, p.z - last.z) < 25 && p !== pts[pts.length - 1]) continue;
      if (last && Math.hypot(p.x - last.x, p.z - last.z) < 1e-6) continue;
      this.push(p.x, p.z);
      last = p;
    }
    if (this.xs.length === 1) {
      // A stationary tornado: a short segment along its heading.
      const h = ((pts[0]?.heading ?? 90) * Math.PI) / 180;
      this.push(this.xs[0]! + Math.sin(h), this.zs[0]! - Math.cos(h));
    }
    if (this.xs.length === 0) {
      this.push(0, 0);
      this.push(1, 0);
    }
  }

  private push(x: number, z: number): void {
    const n = this.xs.length;
    this.cum.push(n ? this.cum[n - 1]! + Math.hypot(x - this.xs[n - 1]!, z - this.zs[n - 1]!) : 0);
    this.xs.push(x);
    this.zs.push(z);
  }

  get length(): number {
    return this.cum[this.cum.length - 1]!;
  }

  /** Along-track distance and signed cross-track offset (+ left of travel) of a point. Before
   *  the start and past the end, the first and last segments are extended. */
  project(x: number, z: number): { along: number; cross: number } {
    const n = this.xs.length;
    let best = Infinity;
    let along = 0;
    let cross = 0;
    for (let i = 0; i < n - 1; i++) {
      const ax = this.xs[i]!;
      const az = this.zs[i]!;
      const dx = this.xs[i + 1]! - ax;
      const dz = this.zs[i + 1]! - az;
      const L2 = dx * dx + dz * dz;
      let u = ((x - ax) * dx + (z - az) * dz) / L2;
      if (i > 0) u = Math.max(u, 0);
      if (i < n - 2) u = Math.min(u, 1);
      const px = ax + u * dx;
      const pz = az + u * dz;
      const d2 = (x - px) ** 2 + (z - pz) ** 2;
      if (d2 < best) {
        best = d2;
        const L = Math.sqrt(L2);
        along = this.cum[i]! + u * L;
        // Left of travel: with north = −Z and east = +X, left of direction (dx, dz) is (dz, −dx).
        cross = ((x - ax) * dz - (z - az) * dx) / L;
      }
    }
    return { along, cross };
  }

  /** World position at an along-track distance and cross-track offset. */
  at(along: number, cross: number): { x: number; z: number } {
    const n = this.xs.length;
    let i = 0;
    while (i < n - 2 && this.cum[i + 1]! < along) i++;
    const ax = this.xs[i]!;
    const az = this.zs[i]!;
    const dx = this.xs[i + 1]! - ax;
    const dz = this.zs[i + 1]! - az;
    const L = Math.hypot(dx, dz);
    const u = (along - this.cum[i]!) / L;
    return { x: ax + u * dx + (cross * dz) / L, z: az + u * dz - (cross * dx) / L };
  }
}

interface Located {
  along: number;
  cross: number;
  ef: EFRating | null;
}

/** Path length and maximum width of a set of located points (`pad`: width each point covers). */
export function pathFigures(pts: readonly { along: number; cross: number }[], pad = 0): PathFigures {
  if (!pts.length) return { length: 0, maxWidth: 0, widestAt: null };
  let a0 = Infinity;
  let a1 = -Infinity;
  const sec = new Map<number, { lo: number; hi: number }>();
  for (const p of pts) {
    a0 = Math.min(a0, p.along);
    a1 = Math.max(a1, p.along);
    const k = Math.floor(p.along / REPORT.section);
    const s = sec.get(k);
    if (s) {
      s.lo = Math.min(s.lo, p.cross);
      s.hi = Math.max(s.hi, p.cross);
    } else sec.set(k, { lo: p.cross, hi: p.cross });
  }
  let maxWidth = 0;
  let widestAt: number | null = null;
  for (const [k, s] of [...sec.entries()].sort((a, b) => a[0] - b[0])) {
    const w = s.hi - s.lo + pad;
    if (w > maxWidth) {
      maxWidth = w;
      widestAt = k * REPORT.section;
    }
  }
  return { length: a1 - a0, maxWidth, widestAt };
}

/** EF contours (Spec 16): for each EF level, the cross-track span of the points rated at or
 *  above it in each along-track section, padded by `margin`, joined into runs. */
export function contours(pts: readonly Located[], margin: number = REPORT.contourMargin): Contour[] {
  const out: Contour[] = [];
  for (let n = 0; n <= 5; n++) {
    const sec = new Map<number, ContourSection>();
    for (const p of pts) {
      if (p.ef === null || p.ef < n) continue;
      const k = Math.floor(p.along / REPORT.section);
      const s = sec.get(k);
      if (s) {
        s.lo = Math.min(s.lo, p.cross - margin);
        s.hi = Math.max(s.hi, p.cross + margin);
      } else sec.set(k, { k, a0: k * REPORT.section, a1: (k + 1) * REPORT.section, lo: p.cross - margin, hi: p.cross + margin });
    }
    if (!sec.size) continue;
    const list = [...sec.values()].sort((a, b) => a.k - b.k);
    const runs: ContourSection[][] = [];
    for (const s of list) {
      const run = runs[runs.length - 1];
      if (run && run[run.length - 1]!.k === s.k - 1) run.push(s);
      else runs.push([s]);
    }
    out.push({ ef: n as EFRating, runs });
  }
  return out;
}

/** A contour run as a closed world-space polygon (left edge forward, right edge back). */
export function runPolygon(line: TrackLine, run: readonly ContourSection[]): { x: number; z: number }[] {
  const left = run.flatMap((s) => [line.at(s.a0, s.hi), line.at(s.a1, s.hi)]);
  const right = [...run].reverse().flatMap((s) => [line.at(s.a1, s.lo), line.at(s.a0, s.lo)]);
  return [...left, ...right];
}

function pathEnd(p: { x: number; z: number; t: number | null }, center: { x: number; z: number }): PathEnd {
  const dx = p.x - center.x;
  const dz = p.z - center.z;
  const bearing = compassOf(dx, dz);
  return { t: p.t, x: p.x, z: p.z, distance: Math.hypot(dx, dz), bearing, compass: COMPASS16[Math.round(bearing / 22.5) % 16]! };
}

/** Every swath cell at EF0 or more: center and peak (m/s). */
export function swathCells(record: StormRecord): { x: number; z: number; v: number }[] {
  const { cell: C, tile: T, tiles } = record.swath;
  const out: { x: number; z: number; v: number }[] = [];
  for (const t of tiles)
    for (let j = 0; j < T; j++)
      for (let i = 0; i < T; i++) {
        const v = t.peak[i + j * T]!;
        if (v > 0) out.push({ x: (t.ti * T + i + 0.5) * C, z: (t.tj * T + j + 0.5) * C, v });
      }
  return out;
}

/**
 * The corroborated rating (Spec 16 v1.9, REP-16): over every pair of rated points within the
 * corroboration radius, the lower of the two speeds; the largest of those sets the rating. The
 * pair's lower point is the rating point, the other the corroborating point. With no pair, the
 * highest point rates alone (an isolated house), uncorroborated. Ties go to the lower index.
 * Points are visited from the fastest down, so the search stops at the first speed with a
 * neighbour at or above it.
 */
export function corroboratedRating(
  points: readonly { x: number; z: number; mph: number; ef: EFRating | null }[],
  radius: number = REPORT.corroborationRadius,
): { ratingPoint: number | null; corroboratingPoint: number | null } {
  const order = points.flatMap((p, i) => (p.ef === null ? [] : [i])).sort((a, b) => points[b]!.mph - points[a]!.mph || a - b);
  if (!order.length) return { ratingPoint: null, corroboratingPoint: null };
  const r2 = radius * radius;
  // Points at or above the current speed, in a grid of radius-sized cells.
  const grid = new Map<string, number[]>();
  const key = (cx: number, cz: number) => `${cx},${cz}`;
  for (let g = 0; g < order.length; ) {
    // One speed at a time: every point at this speed joins before any is checked, so two
    // equal points corroborate each other.
    const mph = points[order[g]!]!.mph;
    let h = g;
    while (h < order.length && points[order[h]!]!.mph === mph) {
      const p = points[order[h]!]!;
      const k = key(Math.floor(p.x / radius), Math.floor(p.z / radius));
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(order[h]!);
      h++;
    }
    const group = order.slice(g, h).sort((a, b) => a - b);
    for (const i of group) {
      const p = points[i]!;
      const cx = Math.floor(p.x / radius);
      const cz = Math.floor(p.z / radius);
      let best: number | null = null;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++)
          for (const j of grid.get(key(cx + dx, cz + dz)) ?? []) {
            if (j === i) continue;
            const q = points[j]!;
            if ((q.x - p.x) ** 2 + (q.z - p.z) ** 2 > r2) continue;
            if (best === null || q.mph > points[best]!.mph || (q.mph === points[best]!.mph && j < best)) best = j;
          }
      if (best !== null) return { ratingPoint: i, corroboratingPoint: best };
    }
    g = h;
  }
  return { ratingPoint: order[0]!, corroboratingPoint: null };
}

/** The survey (Spec 16): survey points, rating, path, contours, start and end, and bias. */
export function buildSurvey(record: StormRecord): Survey {
  const line = new TrackLine(record.track);
  const points: SurveyPoint[] = [];
  const noDamage: Survey["noDamage"] = [];
  for (const b of record.buildings) {
    if (b.dod < 1) {
      if (b.peak10 >= REPORT.threshold) noDamage.push({ index: b.index, x: b.x, z: b.z, true10Mph: mph(b.peak10) });
      continue;
    }
    const row = DI2_DODS.find((r) => r.dod === b.dod)!;
    const est = efFromDamage(b.dod, b.cls);
    const { along, cross } = line.project(b.x, b.z);
    const t10 = mph(b.peak10);
    const first = b.dodHistory.find(([, d]) => d >= 1);
    points.push({
      index: b.index,
      id: b.id,
      x: b.x,
      z: b.z,
      along,
      cross,
      di: 2,
      dod: b.dod,
      description: row.text,
      cls: b.cls,
      mph: est.mph,
      ef: est.ef,
      lowMph: row.lower,
      highMph: row.upper,
      efLow: est.low,
      efHigh: est.high,
      basis: est.basis,
      true10Mph: t10,
      trueRoofMph: mph(b.peakRoof),
      biasMph: est.mph - t10,
      outside: t10 < row.lower || t10 > row.upper,
      firstDamaged: first ? first[0] : b.firstFail,
      uncorroborated: false,
      debrisOnly: b.failures.length > 0 && b.failures.every((f) => f.cause !== "wind"),
    });
  }

  // Wind-damage points rate the storm and outline its path; debris-damage points don't (v1.11).
  const wind = points.filter((p) => !p.debrisOnly);
  const { ratingPoint, corroboratingPoint } = corroboratedRating(points.map((p) => (p.debrisOnly ? { ...p, ef: null } : p)));
  const rp = ratingPoint === null ? null : points[ratingPoint]!;
  const rating = rp ? rp.ef : null;
  const uncorroborated: number[] = [];
  points.forEach((p, i) => {
    if (!p.debrisOnly && rating !== null && p.ef !== null && p.ef > rating) {
      p.uncorroborated = true;
      uncorroborated.push(i);
    }
  });
  // Contours: each point at its EF or the rating, whichever is lower (v1.9).
  const contourPts = wind.map((p) => ({ along: p.along, cross: p.cross, ef: rating === null || p.ef === null ? p.ef : (Math.min(p.ef, rating) as EFRating) }));

  // True swath.
  const cells = swathCells(record);
  let top: { x: number; z: number; v: number } | null = null;
  for (const c of cells) if (!top || c.v > top.v) top = c;
  const located = cells.map((c) => ({ ...line.project(c.x, c.z), ef: efRating(c.v) }));

  // The path (length, width, start and end): wind-damage points the survey rates EF0 or more,
  // as the EF0 contour outlines (v1.11); a point rated below EF0 is mapped, not counted.
  const onPath = wind.filter((p) => p.ef !== null);
  let first: SurveyPoint | null = null;
  let last: SurveyPoint | null = null;
  for (const p of onPath) {
    if (!first || p.along < first.along) first = p;
    if (!last || p.along > last.along) last = p;
  }

  const n = wind.length;
  const mean = n ? wind.reduce((s, p) => s + p.biasMph, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(wind.reduce((s, p) => s + (p.biasMph - mean) ** 2, 0) / (n - 1)) : 0;

  return {
    points,
    noDamage,
    rating,
    ratingMph: rp ? rp.mph : 0,
    ratingPoint,
    corroboratingPoint,
    corroborated: corroboratingPoint !== null,
    uncorroborated,
    debrisOnly: points.flatMap((p, i) => (p.debrisOnly ? [i] : [])),
    truePeak: top ? { mph: mph(top.v), ef: efRating(top.v), x: top.x, z: top.z } : null,
    path: { survey: pathFigures(onPath), true: pathFigures(located, record.swath.cell) },
    contours: { survey: contours(contourPts), true: contours(located) },
    start: first ? pathEnd({ x: first.x, z: first.z, t: first.firstDamaged }, record.townCenter) : null,
    end: last ? pathEnd({ x: last.x, z: last.z, t: last.firstDamaged }, record.townCenter) : null,
    bias: { mean, sd, outside: points.flatMap((p, i) => (p.outside && !p.debrisOnly ? [i] : [])) },
  };
}
