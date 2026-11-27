/**
 * Storm record (Spec 16): what the run did, kept for the storm report. Observes the sim through
 * its taps and snapshot and never changes it (REP-02).
 *
 * - the track, every second;
 * - the true-wind swath: the peak ground-relative 10 m wind in 10 m cells, sampled at the damage
 *   rate within the radius where the wind can reach EF0;
 * - per building: the 10 m peak at its center, its roof-height peak, closest approach, DOD
 *   history and failures;
 * - debris: launches, landings, pieces lofted or carried off the map, impacts.
 */
import { REPORT } from "../config/report";
import { DAMAGE_RANGE_RMAX } from "../config/buildings";
import type { ConstructionClass, Part } from "../config/buildings";
import { MS_PER_MPH } from "../config/units";
import { allFailures } from "../core/damage/building";
import type { MissileInfo, QueuedImpact, SurfaceKind } from "../core/damage/types";
import type { Piece } from "../core/debris/piece";
import { efRating } from "../core/wind/efScale";
import type { EFRating } from "../core/wind/efScale";
import { peakGroundSpeed } from "../core/wind/peak";
import type { TornadoState } from "../core/wind/types";
import { carriedFactors, outerReach, overshootFactor, tangentialProfile, windAt } from "../core/wind/windField";
import { isField } from "../core/terrain/roughness";
import type { Sim } from "./loop";
import type { SimSnapshot, TornadoParams } from "./types";

export interface TrackSample {
  /** Sim time (s). */
  t: number;
  x: number;
  z: number;
  /** Compass heading of travel (deg, 0 = north, clockwise). */
  heading: number;
  /** Forward speed (m/s). */
  speed: number;
  vMax: number;
  rMax: number;
  /** Peak ground-relative 10 m wind (m/s), as the EF readout finds it. */
  peak: number;
  ef: EFRating | null;
  phase: string;
}

export interface SwathTile {
  ti: number;
  tj: number;
  /** Peak 10 m wind per cell (m/s; 0 = never reached EF0), index ci + cj·tile. */
  peak: number[];
}

export interface FailureEntry {
  time: number;
  /** Component part (Spec 03) or a detailed house's connection label (Spec 09). */
  part: Part | string;
  index: number;
  /** Load and capacity: Pa for component failures, N for connections, the impact measure for
   *  debris failures. */
  load: number;
  capacity: number;
  /** Roof-height wind when it failed (mph). */
  mph: number;
  cause: "wind" | "debris";
  /** Detail-zone connection failure (Spec 09). */
  detail?: true;
  missile?: MissileInfo;
}

export interface BuildingRecord {
  index: number;
  id: number;
  x: number;
  z: number;
  cls: ConstructionClass;
  /** Peak ground-relative horizontal wind at 10 m at its center (m/s). */
  peak10: number;
  /** Peak wind at roof height (m/s; Spec 03 `peakMph`). */
  peakRoof: number;
  /** Closest approach to the core edge (m; negative inside; null if never near). */
  closestEdge: number | null;
  dod: number;
  /** Each DOD change: [time (s), new DOD]. */
  dodHistory: [number, number][];
  firstFail: number | null;
  lastFail: number | null;
  failures: FailureEntry[];
}

export type DebrisFate = "flying" | "landed" | "lofted" | "leftMap" | "removed";

export interface DebrisRecordEntry {
  id: number;
  kind: string;
  /** Source building index (−1 if unknown). */
  source: number;
  /** Mass of one piece (kg) and how many real pieces it stands for. */
  mass: number;
  represents: number;
  /** Launch time and position. */
  t: number;
  x: number;
  z: number;
  /** Highest it went (m). */
  maxHeight: number;
  fate: DebrisFate;
  /** Where it last came to rest (landed), or where it left the pool. */
  endX: number;
  endZ: number;
  endT: number;
}

/** Impacts on one kind of surface, and what they did (Spec 10). Counts are impact events. */
export interface ImpactTally {
  hits: number;
  broke: number;
  perforated: number;
  sidingTorn: number;
  coverTorn: number;
}

export interface ImpactRecord {
  bySurface: Record<SurfaceKind, ImpactTally>;
  /** Impact events per building (index), and the first impact's time (s, null if none). */
  byHouse: number[];
  firstAt: (number | null)[];
}

export interface RunMetadata {
  seed: number;
  preset: string | null;
  params: TornadoParams;
  terrain: string;
  dt: number;
  simTime: number;
  appVersion: string;
  /** Spec file → version in use (Spec 16: read from docs/specs at build time). */
  specs: Record<string, string>;
}

export interface StormRecord {
  meta: RunMetadata;
  /** The town center the report gives positions from (m). */
  townCenter: { x: number; z: number };
  track: TrackSample[];
  swath: { cell: number; tile: number; tiles: SwathTile[] };
  buildings: BuildingRecord[];
  debris: { pieces: DebrisRecordEntry[]; impacts: ImpactRecord; massSpawned: number; massLofted: number };
}

export interface RecorderOptions {
  preset?: string | null;
  appVersion?: string;
  specs?: Record<string, string>;
  townCenter?: { x: number; z: number };
}

const tileKey = (ti: number, tj: number) => (ti + 32768) * 65536 + (tj + 32768);

/**
 * Upper bound on the ground-relative horizontal wind at height z and radius r (m/s): swirl with
 * its overshoot and the smoothest terrain's height factor, the full inflow, and the full carried
 * wind. (Same terms as windAt and windOverField; each bounded from above.)
 */
export function windBound(r: number, s: TornadoState, z: number = REPORT.height): number {
  const R = Math.max(s.rMax, 1e-6);
  const vt = tangentialProfile(r, s.vMax, R, s.alpha, outerReach(s));
  const S = overshootFactor(r, s);
  const hf = z < s.zPeak ? S * Math.pow(Math.max(z / s.zPeak, 1e-6), REPORT.betaMin) : Math.max(S, 1);
  return Math.hypot(vt * hf, s.inflowRatio * vt) + carriedFactors(r, s) * Math.hypot(s.velocity.x, s.velocity.z);
}

/** Radius (m) beyond which the 10 m wind can't reach `threshold`: 0 if it can't anywhere. */
export function activeRadius(s: TornadoState, threshold: number = REPORT.threshold, cap = 10): number {
  if (!(s.vMax > 0)) return 0;
  const R = Math.max(s.rMax, 1e-6);
  let peak = 0;
  for (let r = 0; r <= R; r += R / 20) peak = Math.max(peak, windBound(r, s));
  if (peak < threshold) return 0;
  for (let r = R; r <= cap * R; r += 0.05 * R) if (windBound(r, s) < threshold) return r + 0.05 * R;
  return cap * R;
}

export class StormRecorder {
  private readonly sim: Sim;
  private readonly opts: RecorderOptions;
  private readonly detach: () => void;
  private lastStep = -1;
  private pass = 0;
  private track: TrackSample[] = [];
  private tiles = new Map<number, Float32Array>();
  private tileOrder: number[] = [];
  private peak10: Float64Array = new Float64Array(0);
  private lastDod: Int8Array = new Int8Array(0);
  private dodHistory: [number, number][][] = [];
  private detailFails: FailureEntry[][] = [];
  private lastVersion = -1;
  private pieces = new Map<number, DebrisRecordEntry>();
  private wasResting = new Map<number, boolean>();
  private impacts: ImpactRecord = emptyImpacts(0);
  private trackEvery: number;
  /** Bound per ring of REPORT.ring metres, for the current tornado state. */
  private rings = new Float64Array(0);

  constructor(sim: Sim, opts: RecorderOptions = {}) {
    this.sim = sim;
    this.opts = opts;
    this.trackEvery = Math.max(1, Math.round(REPORT.trackInterval / sim.dt));
    this.clear();
    this.detach = sim.observe({
      step: () => this.step(),
      impact: (house, q, _path, piece, time) => this.impact(house, q, piece, time),
      detailFailure: (house, f, time) => {
        (this.detailFails[house] ??= []).push({ time, part: f.label, index: f.con ?? -1, load: f.load, capacity: f.capacity, mph: f.mph, cause: "wind", detail: true });
      },
      debrisStep: () => this.scanDebris(),
      debrisGone: (p, why, time) => {
        const e = this.pieces.get(p.id) ?? this.addPiece(p);
        e.fate = why;
        e.endX = p.pos.x;
        e.endZ = p.pos.z;
        e.endT = time;
        e.maxHeight = Math.max(e.maxHeight, p.pos.y);
      },
    });
  }

  /** Stop observing the sim. */
  dispose(): void {
    this.detach();
  }

  private clear(): void {
    const n = this.sim.world.buildings.length;
    this.track = [];
    this.tiles.clear();
    this.tileOrder = [];
    this.peak10 = new Float64Array(n);
    this.lastDod = new Int8Array(n);
    this.sim.world.buildings.forEach((b, i) => (this.lastDod[i] = b.dod));
    this.dodHistory = Array.from({ length: n }, () => []);
    this.detailFails = [];
    this.lastVersion = -1;
    this.pieces.clear();
    this.wasResting.clear();
    this.impacts = emptyImpacts(n);
    this.pass = 0;
    this.lastStep = this.sim.snapshot.step;
    this.sampleTrack(this.sim.snapshot);
  }

  /** After each physics step (the sim calls it through its taps). */
  step(): void {
    const snap = this.sim.snapshot;
    // A reset started a new run: start a new record.
    if (snap.step <= this.lastStep) this.clear();
    this.lastStep = snap.step;
    if (snap.step % this.trackEvery === 0) this.sampleTrack(snap);
    if (snap.step % REPORT.sampleEvery === 0) {
      this.sampleWind(snap);
      this.readDods(snap.time);
    }
  }

  private sampleTrack(snap: SimSnapshot): void {
    const s = snap.tornado;
    // On the EF scale's basis: open-terrain 10 m gusts (Spec 17 v1.1, TERR-25), as the readout.
    const peak = peakGroundSpeed(s, "open");
    this.track.push({
      t: snap.time,
      x: s.center.x,
      z: s.center.z,
      heading: compassOf(s.velocity.x, s.velocity.z),
      speed: Math.hypot(s.velocity.x, s.velocity.z),
      vMax: s.vMax,
      rMax: s.rMax,
      peak,
      ef: s.vMax > 0 ? efRating(peak) : null,
      phase: snap.phase,
    });
  }

  /** The swath and the buildings' 10 m peaks, for this damage step. */
  private sampleWind(snap: SimSnapshot): void {
    const s = snap.tornado;
    if (s.tunnel || !(s.vMax > 0)) return;
    const n = this.pass++;
    const R = Math.max(s.rMax, 1e-6);
    const reachB = DAMAGE_RANGE_RMAX * R;
    const reachS = activeRadius(s);
    const reach = Math.max(reachB, reachS);
    // Ring bounds: the bound is largest at R_max and falls away on both sides, so a ring's
    // largest value is at the end nearer R_max (or at R_max inside it). 0.1% margin.
    const ring = REPORT.ring;
    const nr = Math.ceil(reach / ring) + 2;
    if (this.rings.length < nr) this.rings = new Float64Array(nr);
    const rings = this.rings;
    for (let k = 0; k < nr; k++) rings[k] = windBound(Math.min(Math.max(R, k * ring), (k + 1) * ring), s) * 1.001;
    const inner2 = (1.5 * R) ** 2;
    const far2 = (3 * R) ** 2;
    const everyAt = (d2: number) => (d2 > far2 ? REPORT.farEvery : d2 > inner2 ? REPORT.outerEvery : 1);
    const p = { x: 0, y: REPORT.height, z: 0 };
    // The EF scale's basis (Spec 16 v1.1): open-terrain 10 m wind, whatever the ground, as the
    // EF readout (Spec 17 v1.1). The roof-height peak (Spec 03) stays the local wind.
    const terrain = "open" as const;
    const thr = REPORT.threshold;

    // Swath cells.
    if (reachS > 0) {
      const C = REPORT.cell;
      const T = REPORT.tile;
      const cx = s.center.x;
      const cz = s.center.z;
      const i0 = Math.floor((cx - reachS) / C);
      const i1 = Math.floor((cx + reachS) / C);
      const j0 = Math.floor((cz - reachS) / C);
      const j1 = Math.floor((cz + reachS) / C);
      const R2 = reachS * reachS;
      let lastKey = NaN;
      let tile: Float32Array | undefined;
      for (let cj = j0; cj <= j1; cj++) {
        const z = (cj + 0.5) * C;
        const dz = z - cz;
        for (let ci = i0; ci <= i1; ci++) {
          const x = (ci + 0.5) * C;
          const dx = x - cx;
          const d2 = dx * dx + dz * dz;
          if (d2 > R2) continue;
          const every = everyAt(d2);
          if (every > 1 && (n + ci + cj) % every !== 0) continue;
          const ti = Math.floor(ci / T);
          const tj = Math.floor(cj / T);
          const k = tileKey(ti, tj);
          if (k !== lastKey) {
            tile = this.tiles.get(k);
            lastKey = k;
          }
          const idx = ci - ti * T + (cj - tj * T) * T;
          const cur = tile ? tile[idx]! : 0;
          const b = rings[Math.floor(Math.sqrt(d2) / ring)]!;
          if (b < thr || b <= cur) continue;
          p.x = x;
          p.z = z;
          const w = windAt(p, s, terrain);
          const v = Math.hypot(w.x, w.z);
          if (v < thr || v <= cur) continue;
          if (!tile) {
            tile = new Float32Array(T * T);
            this.tiles.set(k, tile);
            this.tileOrder.push(k);
          }
          tile[idx] = v;
        }
      }
    }

    // Buildings: the 10 m wind at the center, within the damage range.
    const B = this.sim.world.buildings;
    const rb2 = reachB * reachB;
    for (let i = 0; i < B.length; i++) {
      const b = B[i]!;
      const dx = b.x - s.center.x;
      const dz = b.z - s.center.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > rb2) continue;
      const every = everyAt(d2);
      if (every > 1 && (n + i) % every !== 0) continue;
      const cur = this.peak10[i]!;
      if (rings[Math.floor(Math.sqrt(d2) / ring)]! <= cur) continue;
      p.x = b.x;
      p.z = b.z;
      const w = windAt(p, s, terrain);
      const v = Math.hypot(w.x, w.z);
      if (v > cur) this.peak10[i] = v;
    }
  }

  private readDods(time: number): void {
    const version = this.sim.snapshot.damageVersion;
    if (version === this.lastVersion) return;
    this.lastVersion = version;
    const B = this.sim.world.buildings;
    for (let i = 0; i < B.length; i++) {
      const d = B[i]!.dod;
      if (d !== this.lastDod[i]) {
        this.lastDod[i] = d;
        this.dodHistory[i]!.push([time, d]);
      }
    }
  }

  private addPiece(p: Piece): DebrisRecordEntry {
    const e: DebrisRecordEntry = {
      id: p.id,
      kind: p.def.label ?? String(p.kind),
      source: p.sourceId,
      mass: p.def.mass,
      represents: p.represents,
      t: p.bornAt,
      x: p.origin?.x ?? p.pos.x,
      z: p.origin?.z ?? p.pos.z,
      maxHeight: p.pos.y,
      fate: "flying",
      endX: p.pos.x,
      endZ: p.pos.z,
      endT: p.bornAt,
    };
    this.pieces.set(p.id, e);
    return e;
  }

  /** After each debris step: new pieces, heights, and where pieces came to rest. */
  private scanDebris(): void {
    const time = this.sim.snapshot.time;
    for (const p of this.sim.debris.pieces) {
      const e = this.pieces.get(p.id) ?? this.addPiece(p);
      if (p.pos.y > e.maxHeight) e.maxHeight = p.pos.y;
      const rest = p.resting || !!p.grounded;
      if (rest && !this.wasResting.get(p.id)) {
        e.fate = p.hidden ? "removed" : "landed";
        e.endX = p.pos.x;
        e.endZ = p.pos.z;
        e.endT = time;
      } else if (!rest && e.fate === "landed") e.fate = "flying";
      this.wasResting.set(p.id, rest);
    }
  }

  private impact(house: number, q: QueuedImpact, _piece: Piece | null, time: number): void {
    const I = this.impacts;
    const t = I.bySurface[q.surface];
    t.hits++;
    if (q.broke) t.broke++;
    if (q.perforated) t.perforated++;
    if (q.sidingTorn) t.sidingTorn++;
    if (q.coverTorn) t.coverTorn++;
    if (house >= 0 && house < I.byHouse.length) {
      I.byHouse[house]!++;
      if (I.firstAt[house] === null) I.firstAt[house] = time;
    }
  }

  /** A snapshot of the record, safe mid-run (plain data: JSON round-trips it). */
  record(): StormRecord {
    const sim = this.sim;
    const snap = sim.snapshot;
    const tiles: SwathTile[] = [...this.tileOrder]
      .map((k) => ({ k, ti: Math.floor(k / 65536) - 32768, tj: (k % 65536) - 32768 }))
      .sort((a, b) => a.tj - b.tj || a.ti - b.ti)
      .map(({ k, ti, tj }) => ({ ti, tj, peak: Array.from(this.tiles.get(k)!, (v) => v) }));
    const buildings: BuildingRecord[] = sim.world.buildings.map((b, i) => {
      const failures: FailureEntry[] = allFailures(b).map((f) => ({
        time: f.time,
        part: f.part,
        index: f.index,
        load: f.load,
        capacity: f.capacity,
        mph: f.mph,
        cause: f.cause === "debris" ? "debris" : "wind",
        ...(f.missile ? { missile: { ...f.missile } } : {}),
      }));
      for (const f of this.detailFails[i] ?? []) failures.push({ ...f });
      failures.sort((a, c) => a.time - c.time);
      return {
        index: i,
        id: b.id,
        x: b.x,
        z: b.z,
        cls: b.cls,
        peak10: this.peak10[i]!,
        peakRoof: b.peakMph * MS_PER_MPH,
        closestEdge: Number.isFinite(b.closestEdge) ? b.closestEdge : null,
        dod: b.dod,
        dodHistory: this.dodHistory[i]!.map(([t, d]) => [t, d] as [number, number]),
        firstFail: failures.length ? failures[0]!.time : null,
        lastFail: failures.length ? failures[failures.length - 1]!.time : null,
        failures,
      };
    });
    const pieces = [...this.pieces.values()].sort((a, b) => a.id - b.id).map((e) => ({ ...e }));
    const params = { ...sim.params } as TornadoParams;
    return {
      meta: {
        seed: sim.seed,
        preset: this.opts.preset ?? null,
        params,
        terrain: isField(snap.terrain) ? "auto (from the town)" : String(snap.terrain),
        dt: sim.dt,
        simTime: snap.time,
        appVersion: this.opts.appVersion ?? "dev",
        specs: { ...(this.opts.specs ?? {}) },
      },
      townCenter: { ...(this.opts.townCenter ?? { x: 0, z: 0 }) },
      track: this.track.map((t) => ({ ...t })),
      swath: { cell: REPORT.cell, tile: REPORT.tile, tiles },
      buildings,
      debris: { pieces, impacts: copyImpacts(this.impacts), massSpawned: sim.debris.massSpawned, massLofted: sim.debris.massLofted },
    };
  }
}

const SURFACES: readonly SurfaceKind[] = ["pane", "garage", "wall", "gable", "roof"];

function emptyImpacts(n: number): ImpactRecord {
  const bySurface = {} as Record<SurfaceKind, ImpactTally>;
  for (const k of SURFACES) bySurface[k] = { hits: 0, broke: 0, perforated: 0, sidingTorn: 0, coverTorn: 0 };
  return { bySurface, byHouse: new Array<number>(n).fill(0), firstAt: new Array<number | null>(n).fill(null) };
}

function copyImpacts(I: ImpactRecord): ImpactRecord {
  const bySurface = {} as Record<SurfaceKind, ImpactTally>;
  for (const k of SURFACES) bySurface[k] = { ...I.bySurface[k] };
  return { bySurface, byHouse: [...I.byHouse], firstAt: [...I.firstAt] };
}

/** Compass bearing (deg, 0 = north, clockwise) of a ground-plane vector. North is −Z, east +X. */
export function compassOf(x: number, z: number): number {
  const a = (Math.atan2(x, -z) * 180) / Math.PI;
  return (a + 360) % 360;
}
