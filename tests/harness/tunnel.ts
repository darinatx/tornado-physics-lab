/**
 * Wind tunnel runner (Spec 12): runs a scenario headless, as fast as the CPU allows at the
 * sim's fixed steps, and keeps its record: samples, the target's failures and impacts, the
 * launches, and the pass-through check at every debris step.
 */
import { createHash } from "node:crypto";
import { TUNNEL } from "../../src/config/tunnel";
import { MS_PER_MPH } from "../../src/config/units";
import { allFailures } from "../../src/core/damage/building";
import type { Building, FailureRecord, QueuedImpact } from "../../src/core/damage/types";
import type { Piece } from "../../src/core/debris/piece";
import type { Vec3 } from "../../src/core/math/vec";
import { pressureDeficit } from "../../src/core/wind/pressure";
import { windAt } from "../../src/core/wind/windField";
import { createTunnel } from "../../src/sim/tunnel";
import type { Tunnel, TunnelScenario } from "../../src/sim/tunnel";
import { PassThroughMonitor } from "./passthrough";
import type { Tracked, Violation } from "./passthrough";

export interface TunnelSample {
  t: number;
  /** Tunnel wind at 10 m (mph) and direction (deg). */
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

export interface RunOptions {
  /** Sim seconds per advance call (default 0.25): chunking never changes the record. */
  chunk?: number;
  /** Called after every debris step, before it is recorded (tests). */
  onStep?: (t: Tunnel) => void;
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const v6 = (v: Vec3): Vec3 => ({ x: r6(v.x), y: r6(v.y), z: r6(v.z) });

/** The record's identity: everything but the timing. */
export function recordHash(r: TunnelRecord): string {
  const { perf: _perf, ...rest } = r;
  return createHash("sha1").update(JSON.stringify(rest)).digest("hex");
}

/** Run one scenario and keep its record. */
export async function runTunnel(s: TunnelScenario & { check?: (r: TunnelRecord) => string[] }, opts: RunOptions = {}): Promise<TunnelRecord> {
  const t0 = performance.now();
  const tun = await createTunnel(s);
  const sim = tun.sim;
  const target = sim.world.buildings[tun.target]!;
  const failures: TunnelFailure[] = [];
  const impacts: TunnelImpact[] = [];
  const samples: TunnelSample[] = [];

  tun.taps.impact = (house: number, q: QueuedImpact, path: "debris" | "detail", _p: Piece | null, time: number) => {
    if (house !== tun.target) return;
    impacts.push({
      t: r6(time), path, surface: q.surface, index: q.index, face: q.face, missile: q.missile.label, mass: r6(q.missile.mass), vn: r6(q.missile.speed),
      measure: r6(q.measure), threshold: r6(q.threshold), broke: q.broke, perforated: q.perforated, sidingTorn: q.sidingTorn, coverTorn: q.coverTorn, force: r6(q.force),
    });
  };
  tun.taps.detailFailure = (house, f, time) => {
    if (house !== tun.target) return;
    failures.push({ t: r6(time), model: "detail", label: f.label, load: r6(f.load), capacity: r6(f.capacity), mph: r6(f.mph) });
  };
  const seen = new Set<FailureRecord>();
  const componentFailures = () => {
    if (target.detail) return;
    const add: FailureRecord[] = [];
    for (const f of allFailures(target)) if (!seen.has(f)) (seen.add(f), add.push(f));
    add.sort((a, b) => a.time - b.time || a.part.localeCompare(b.part) || a.index - b.index);
    for (const f of add)
      failures.push({ t: r6(f.time), model: "component", part: f.part, index: f.index, load: r6(f.load), capacity: r6(f.capacity), mph: r6(f.mph), ...(f.cause ? { cause: f.cause } : {}), ...(f.missile ? { missile: f.missile.label } : {}) });
  };

  const monitor = new PassThroughMonitor(sim.world.buildings);
  const ids = new WeakMap<Piece, string>();
  let next = 0;
  const keyOf = (p: Piece) => ids.get(p) ?? (ids.set(p, `p${next++}`), ids.get(p)!);
  const checks = { debrisSteps: 0, rubbleChecks: 0, observed: 0 };
  const closest = new Map<number, number>();
  const center = { x: target.x, y: target.wallHeight / 2, z: target.z };
  const roof = { x: target.x, y: target.roofHeight, z: target.z };
  const perSample = Math.round(60 / TUNNEL.sampleHz);

  const record = (t: Tunnel) => {
    opts.onStep?.(t);
    const n = checks.debrisSteps++;
    componentFailures();
    // Pass-through: every debris piece and detailed member, every step; rubble once a second.
    const tracked: Tracked[] = [];
    for (const p of sim.debris.pieces) if (!p.hidden) tracked.push({ key: keyOf(p), source: "debris", label: p.def.label, from: p.sourceId, pos: p.pos });
    for (const [i, h] of sim.detail.houses) {
      const stamps = sim.detail.stamps.get(i)!;
      for (let m = 0; m < stamps.length; m++) {
        if (!stamps[m]) continue; // never moved
        const o = m * 7;
        if (h.poses[o + 1]! < -1000) continue; // lost or never built
        tracked.push({ key: `m${i}:${m}`, source: "member", label: h.framing.members[m]!.kind, own: h.building.id, pos: { x: h.poses[o]!, y: h.poses[o + 1]!, z: h.poses[o + 2]! } });
      }
    }
    checks.observed += tracked.length;
    monitor.observe(sim.time, tracked);
    if (n % TUNNEL.rubbleEvery === TUNNEL.rubbleEvery - 1) {
      checks.rubbleChecks++;
      const rubble: Tracked[] = [];
      for (const p of sim.debris.settled) if (!p.hidden && !p.lodgedIn) rubble.push({ key: keyOf(p), source: "rubble", label: p.def.label, pos: p.pos });
      monitor.observe(sim.time, rubble, { moveChecks: false });
    }
    // Launch tracks.
    for (const l of tun.launched) {
      const pos = l.piece ? l.piece.pos : tun.launchBody(l.i)?.center;
      if (!pos) continue;
      const d = Math.hypot(pos.x - center.x, pos.y - center.y, pos.z - center.z);
      closest.set(l.i, Math.min(closest.get(l.i) ?? Infinity, d));
    }
    if ((n + 1) % perSample === 0) {
      const s = sim.snapshot.tornado;
      const f = s.tunnel!;
      const w = windAt(roof, s, sim.snapshot.terrain);
      samples.push({
        t: r6(sim.time),
        u10: r6(f.u10 / MS_PER_MPH),
        dirDeg: r6(f.dirDeg),
        mph: r6(Math.hypot(w.x, w.y, w.z) / MS_PER_MPH),
        deficit: r6(pressureDeficit(0, s)),
        dod: target.dod,
        failures: target.detail ? (target.detailFailures ?? []).reduce((a, g) => a + g.count, 0) : allFailures(target).length,
      });
    }
  };
  tun.onStep = record;

  const chunk = opts.chunk ?? 0.25;
  let asked = 0;
  let lastYield = performance.now();
  while (asked < s.seconds - 1e-9) {
    const d = Math.min(chunk, s.seconds - asked);
    tun.advance(d);
    asked += d;
    if (performance.now() - lastYield > 1000) {
      await new Promise((r) => setImmediate(r));
      lastYield = performance.now();
    }
  }

  const crossings = monitor.violations.filter((v) => v.kind !== "below ground");
  const dips = monitor.violations.filter((v) => v.kind === "below ground");
  const sum = monitor.summary(3);
  delete sum.counts["below ground"];
  for (const k of Object.keys(sum.counts)) if (k.endsWith("below ground")) delete sum.counts[k];
  sum.examples = sum.examples.filter((v) => v.kind !== "below ground");
  const total = crossings.length;
  const tracks = tun.launched
    .map((l) => {
      const pos = l.piece ? l.piece.pos : (tun.launchBody(l.i)?.center ?? null);
      return { i: l.i, closest: r6(closest.get(l.i) ?? Infinity), final: pos ? v6(pos) : null };
    })
    .sort((a, b) => a.i - b.i);
  const fin: Building = target.detail && target.standIn ? target.standIn : target;
  const rec: TunnelRecord = {
    name: s.name,
    seed: s.seed ?? 1,
    seconds: s.seconds,
    samples,
    failures,
    impacts,
    launches: tun.launched.map((l) => ({ i: l.i, t: r6(l.time), source: l.source, label: l.label, at: v6(l.at), vel: v6(l.vel) })).sort((a, b) => a.i - b.i),
    tracks,
    passThrough: { total, counts: sum.counts, examples: sum.examples },
    groundDips: { count: dips.length, deepest: r6(Math.max(0, ...dips.map((v) => -v.at.y))) },
    checks,
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
  tun.dispose();
  if (total) rec.problems.push(`pass-through: ${total} (${Object.entries(sum.counts).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  if (s.check) rec.problems.push(...s.check(rec));
  rec.ok = rec.problems.length === 0;
  const wallS = (performance.now() - t0) / 1000;
  rec.perf = { wallS, speed: s.seconds / wallS };
  return rec;
}
