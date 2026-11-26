/**
 * The run record (Spec 12, kept by the lab too, Spec 13): samples, the target's failures and
 * impacts, the launches, and the pass-through check at every debris step. Observes the sim;
 * never changes it.
 */
import { TUNNEL } from "../config/tunnel";
import { MS_PER_MPH } from "../config/units";
import { allFailures } from "../core/damage/building";
import type { Building, FailureRecord } from "../core/damage/types";
import type { Piece } from "../core/debris/piece";
import type { Vec3 } from "../core/math/vec";
import { pressureDeficit } from "../core/wind/pressure";
import { windAt } from "../core/wind/windField";
import type { Launched } from "./launcher";
import type { Sim } from "./loop";
import { PassThroughMonitor } from "./passThrough";
import type { Tracked, Violation } from "./passThrough";

export interface TunnelSample {
  t: number;
  /** Wind at 10 m (mph) and direction (deg) in steady wind; 0 and the heading on a pass. */
  u10: number;
  dirDeg: number;
  /** Wind at the target's roof height (mph). */
  mph: number;
  deficit: number;
  dod: number;
  failures: number;
}

export type TunnelFailure =
  | { t: number; model: "component"; part: string; index: number; load: number; capacity: number; mph: number; cause?: string; missile?: string }
  | { t: number; model: "detail"; label: string; load: number; capacity: number; mph: number };

export interface TunnelImpact {
  t: number;
  path: "debris" | "detail";
  surface: string;
  index: number;
  face: number;
  missile: string;
  mass: number;
  vn: number;
  measure: number;
  threshold: number;
  broke: boolean;
  perforated: boolean;
  sidingTorn: boolean;
  coverTorn: boolean;
  force: number;
}

export interface TunnelRecord {
  name: string;
  seed: number;
  seconds: number;
  samples: TunnelSample[];
  failures: TunnelFailure[];
  impacts: TunnelImpact[];
  launches: { i: number; t: number; source: string; label: string; at: Vec3; vel: Vec3 }[];
  /** Per launch: closest approach of its center to the target's center (m), and where it ended. */
  tracks: { i: number; closest: number; final: Vec3 | null }[];
  /** Crossings of any house's walls, roof or slab (the scenario fails on any). */
  passThrough: { total: number; counts: Record<string, number>; examples: Violation[] };
  /** Pieces a few cm below the ground for a step (Rapier contact softness on hard landings, an
   *  open Spec 10 item; reported, not failed, as in IMP-17/19): count and deepest (m). */
  groundDips: { count: number; deepest: number };
  checks: { debrisSteps: number; rubbleChecks: number; observed: number };
  /** The target at the end: what's gone (a detailed target as its stand-in sees it). */
  final: { dod: number; panes: boolean[]; panels: boolean[]; decks: boolean[]; bays: boolean[]; garage: boolean | null };
  /** Pieces stuck through a house's surface at the end, and lodgings over the run (Spec 10). */
  lodged: { now: number; total: number };
  problems: string[];
  ok: boolean;
  perf: { wallS: number; speed: number };
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const v6 = (v: Vec3): Vec3 => ({ x: r6(v.x), y: r6(v.y), z: r6(v.z) });

export interface RecorderOptions {
  /** Check pass-through at every debris step (default true; costs ~1 ms per thousand pieces). */
  passThrough?: boolean;
  /** "debrisStep" (default): record after each debris step, by the sim's observer. "manual":
   *  the caller calls `step()` (the tunnel runner, after each 1/60 s advance). */
  drive?: "debrisStep" | "manual";
}

/** Keeps a run's record from the sim's observers. Call `stop()` to detach and get the record. */
export class RunRecorder {
  private readonly failures: TunnelFailure[] = [];
  private readonly impacts: TunnelImpact[] = [];
  private readonly samples: TunnelSample[] = [];
  private readonly seen = new Set<FailureRecord>();
  private readonly monitor: PassThroughMonitor | null;
  private readonly ids = new WeakMap<Piece, string>();
  private next = 0;
  private readonly checks = { debrisSteps: 0, rubbleChecks: 0, observed: 0 };
  private readonly closest = new Map<number, number>();
  private readonly perSample = Math.round(60 / TUNNEL.sampleHz);
  private readonly detach: () => void;
  private readonly t0 = performance.now();
  private readonly startTime: number;
  /** Called after each debris step's record (tests). */
  onStep: (() => void) | null = null;

  constructor(
    private readonly sim: Sim,
    /** Target house (index into the sim's buildings). */
    readonly target: number,
    private readonly launched: () => readonly Launched[],
    private readonly launchPos: (l: Launched) => Vec3 | null,
    opts: RecorderOptions = {},
  ) {
    this.monitor = opts.passThrough === false ? null : new PassThroughMonitor(sim.world.buildings);
    this.startTime = sim.time;
    this.detach = sim.observe({
      impact: (house, q, path, _p, time) => {
        if (house !== this.target) return;
        this.impacts.push({
          t: r6(time), path, surface: q.surface, index: q.index, face: q.face, missile: q.missile.label, mass: r6(q.missile.mass), vn: r6(q.missile.speed),
          measure: r6(q.measure), threshold: r6(q.threshold), broke: q.broke, perforated: q.perforated, sidingTorn: q.sidingTorn, coverTorn: q.coverTorn, force: r6(q.force),
        });
      },
      detailFailure: (house, f, time) => {
        if (house !== this.target) return;
        this.failures.push({ t: r6(time), model: "detail", label: f.label, load: r6(f.load), capacity: r6(f.capacity), mph: r6(f.mph) });
      },
      ...(opts.drive === "manual" ? {} : { debrisStep: () => this.step() }),
    });
  }

  private get b(): Building {
    return this.sim.world.buildings[this.target]!;
  }

  private keyOf(p: Piece): string {
    let k = this.ids.get(p);
    if (!k) this.ids.set(p, (k = `p${this.next++}`));
    return k;
  }

  private componentFailures(): void {
    const target = this.b;
    if (target.detail) return;
    const add: FailureRecord[] = [];
    for (const f of allFailures(target)) if (!this.seen.has(f)) (this.seen.add(f), add.push(f));
    add.sort((a, b) => a.time - b.time || a.part.localeCompare(b.part) || a.index - b.index);
    for (const f of add)
      this.failures.push({ t: r6(f.time), model: "component", part: f.part, index: f.index, load: r6(f.load), capacity: r6(f.capacity), mph: r6(f.mph), ...(f.cause ? { cause: f.cause } : {}), ...(f.missile ? { missile: f.missile.label } : {}) });
  }

  /** Record one debris step. */
  step(): void {
    const sim = this.sim;
    const target = this.b;
    const n = this.checks.debrisSteps++;
    this.componentFailures();
    if (this.monitor) {
      // Pass-through: every debris piece and detailed member, every step; rubble once a second.
      const tracked: Tracked[] = [];
      for (const p of sim.debris.pieces) if (!p.hidden) tracked.push({ key: this.keyOf(p), source: "debris", label: p.def.label, from: p.sourceId, pos: p.pos });
      for (const [i, h] of sim.detail.houses) {
        const stamps = sim.detail.stamps.get(i)!;
        for (let m = 0; m < stamps.length; m++) {
          if (!stamps[m]) continue; // never moved
          const o = m * 7;
          if (h.poses[o + 1]! < -1000) continue; // lost or never built
          tracked.push({ key: `m${i}:${m}`, source: "member", label: h.framing.members[m]!.kind, own: h.building.id, pos: { x: h.poses[o]!, y: h.poses[o + 1]!, z: h.poses[o + 2]! } });
        }
      }
      this.checks.observed += tracked.length;
      this.monitor.observe(sim.time, tracked);
      if (n % TUNNEL.rubbleEvery === TUNNEL.rubbleEvery - 1) {
        this.checks.rubbleChecks++;
        const rubble: Tracked[] = [];
        for (const p of sim.debris.settled) if (!p.hidden && !p.lodgedIn) rubble.push({ key: this.keyOf(p), source: "rubble", label: p.def.label, pos: p.pos });
        this.monitor.observe(sim.time, rubble, { moveChecks: false });
      }
    }
    // Launch tracks.
    const center = { x: target.x, y: target.wallHeight / 2, z: target.z };
    for (const l of this.launched()) {
      const pos = this.launchPos(l);
      if (!pos) continue;
      const d = Math.hypot(pos.x - center.x, pos.y - center.y, pos.z - center.z);
      this.closest.set(l.i, Math.min(this.closest.get(l.i) ?? Infinity, d));
    }
    if ((n + 1) % this.perSample === 0) {
      const s = sim.snapshot.tornado;
      const f = s.tunnel;
      const w = windAt({ x: target.x, y: target.roofHeight, z: target.z }, s, sim.snapshot.terrain);
      const heading = Math.atan2(-s.velocity.z, s.velocity.x) * (180 / Math.PI);
      this.samples.push({
        t: r6(sim.time),
        u10: r6(f ? f.u10 / MS_PER_MPH : 0),
        dirDeg: r6(f ? f.dirDeg : heading),
        mph: r6(Math.hypot(w.x, w.y, w.z) / MS_PER_MPH),
        deficit: r6(f ? pressureDeficit(0, s) : pressureDeficit(Math.hypot(target.x - s.center.x, target.z - s.center.z), s)),
        dod: target.dod,
        failures: target.detail ? (target.detailFailures ?? []).reduce((a, g) => a + g.count, 0) : allFailures(target).length,
      });
    }
    this.onStep?.();
  }

  /** The record so far (the recorder keeps running). */
  snapshot(name: string, seed: number): TunnelRecord {
    const sim = this.sim;
    const target = this.b;
    const violations = this.monitor?.violations ?? [];
    const crossings = violations.filter((v) => v.kind !== "below ground");
    const dips = violations.filter((v) => v.kind === "below ground");
    const sum = this.monitor?.summary(3) ?? { counts: {} as Record<string, number>, examples: [] as Violation[] };
    delete sum.counts["below ground"];
    for (const k of Object.keys(sum.counts)) if (k.endsWith("below ground")) delete sum.counts[k];
    sum.examples = sum.examples.filter((v) => v.kind !== "below ground");
    const total = crossings.length;
    const launched = this.launched();
    const tracks = launched
      .map((l) => {
        const pos = this.launchPos(l);
        return { i: l.i, closest: r6(this.closest.get(l.i) ?? Infinity), final: pos ? v6(pos) : null };
      })
      .sort((a, b) => a.i - b.i);
    const fin: Building = target.detail && target.standIn ? target.standIn : target;
    const rec: TunnelRecord = {
      name,
      seed,
      seconds: r6(sim.time - this.startTime),
      samples: [...this.samples],
      failures: [...this.failures],
      impacts: [...this.impacts],
      launches: launched.map((l) => ({ i: l.i, t: r6(l.time), source: l.source, label: l.label, at: v6(l.at), vel: v6(l.vel) })).sort((a, b) => a.i - b.i),
      tracks,
      passThrough: { total, counts: sum.counts, examples: sum.examples },
      groundDips: { count: dips.length, deepest: r6(Math.max(0, ...dips.map((v) => -v.at.y))) },
      checks: { ...this.checks },
      final: {
        dod: target.dod,
        panes: fin.panes.map((p) => !!p.failed),
        panels: fin.panels.map((p) => !!p.failed),
        decks: fin.sections.map((x) => !!x.deck),
        bays: fin.bays.map((x) => !!x.failed),
        garage: fin.garage ? !!fin.garage.failed : null,
      },
      lodged: { now: sim.debris.stats.lodged, total: sim.debris.stats.lodgedTotal },
      problems: [],
      ok: true,
      perf: { wallS: 0, speed: 0 },
    };
    if (total) rec.problems.push(`pass-through: ${total} (${Object.entries(sum.counts).map(([k, v]) => `${k} ${v}`).join(", ")})`);
    rec.ok = rec.problems.length === 0;
    const wallS = (performance.now() - this.t0) / 1000;
    rec.perf = { wallS, speed: rec.seconds / Math.max(wallS, 1e-9) };
    return rec;
  }

  stop(name: string, seed: number): TunnelRecord {
    this.detach();
    return this.snapshot(name, seed);
  }
}
