/**
 * Debris recording (Spec 13): every piece that crosses into a capture box around a house,
 * once, at the debris step where it crosses, in the house's frame, with the wind that went
 * with it. Used by the main sim (a pinned house) and the lab. Observes the sim; never changes it.
 */
import { DEBRIS } from "../config/debris";
import type { DebrisKind } from "../config/debris";
import { LAB_RECORDING } from "../config/lab";
import { SIM_DEFAULTS } from "../config/sim";
import type { Building } from "../core/damage/types";
import type { Piece } from "../core/debris/piece";
import type { Vec3 } from "../core/math/vec";
import type { MemberKind } from "../core/structure/framing";
import type { TerrainClass } from "../core/wind/types";
import type { Sim } from "./loop";
import type { TornadoParams } from "./types";
import type { WindKey } from "./tunnelFlow";
import { TERRAIN } from "../config/terrain";
import { effLnZ0, isField, uniformField, z0At } from "../core/terrain/roughness";
import type { RoughnessField, Terrain } from "../core/terrain/roughness";

type Q = [number, number, number, number];

/** The tornado's track in the target's frame: where it was at sim time 0 and which way it
 *  heads, relative to the target's center and yaw, with the parameters that drove it. */
export interface TrackInTargetFrame {
  start: { x: number; z: number };
  /** Heading relative to the target's yaw (deg). */
  headingDeg: number;
  params: Partial<TornadoParams>;
}

export interface RecordedPiece {
  /** Sim time (s) of the debris step that moves it next: replay launches it at that step. */
  t: number;
  /** Spec 04 kind (a light or heavy piece), or a detailed member's kind. */
  source: "town" | "member";
  kind: DebrisKind | MemberKind;
  /** Rigid body in the heavy-debris world at the crossing. */
  heavy?: boolean;
  mass: number;
  dims: [number, number, number];
  represents: number;
  /** Target frame (m, m/s, rad/s). */
  pos: Vec3;
  vel: Vec3;
  q: Q;
  angVel?: Vec3;
  /** Per-piece state the flight depends on (town pieces). */
  liftRoll?: number;
  spin?: 1 | -1;
  gust?: Vec3;
  stepPhase?: number;
  /** Sim time it was last advanced to (far pieces skip alternate steps), and lying on the ground. */
  steppedTo?: number;
  grounded?: boolean;
}

export interface DebrisRecording {
  version: number;
  /** Code version the recording was made with (the app's build, or "dev"). */
  code: string;
  seed: number;
  /** The run's debris dispersion (Spec 13): exact replay needs it off in both runs. */
  dispersion: boolean;
  target: { width: number; depth: number; yaw: number; spec: Record<string, unknown> };
  wind: { kind: "pass"; presetId: string; track: TrackInTargetFrame; lifecycle: "mature" | "full" } | { kind: "steady"; keys: WindKey[] };
  /** Terrain the wind blew over (Spec 01 roughness), part of the recorded wind: a class, or the
   *  roughness at the target over time (Spec 17). */
  terrain: TerrainClass | TerrainSeries;
  /** Seconds the recording covers (from sim time 0). */
  seconds: number;
  pieces: RecordedPiece[];
}

export const RECORDING_VERSION = 1;

/**
 * Roughness at a recording's target (Spec 17): at each field update, the local and the
 * upwind-weighted ln z₀ for each of the 16 directions, the directions in the target's frame.
 */
export interface TerrainSeries {
  kind: "series";
  samples: { t: number; lnZ0: number; eff: number[] }[];
}

/** Sample a field at a house, directions in its frame (local angle = world angle + yaw). */
export function sampleTerrain(field: RoughnessField, b: Pick<Building, "x" | "z" | "yaw">, t: number): TerrainSeries["samples"][number] {
  const n = TERRAIN.directions;
  return {
    t,
    lnZ0: Math.log(z0At(field, b.x, b.z)),
    eff: Array.from({ length: n }, (_, k) => effLnZ0(field, b.x, b.z, (2 * Math.PI * k) / n - b.yaw)),
  };
}

/**
 * A series replayed at a receiving house turned by `yaw`: at sim time t, a one-node field
 * holding the latest sample at or before t, its directions turned to the world.
 */
export function seriesTerrain(series: TerrainSeries, yaw: number): (t: number) => Terrain {
  const n = TERRAIN.directions;
  const fields = series.samples.map((smp, idx) => {
    const local = uniformField(Math.exp(smp.lnZ0));
    smp.eff.forEach((v, k) => (local.eff[k]![0] = v));
    const world = uniformField(Math.exp(smp.lnZ0), idx + 1);
    for (let k = 0; k < n; k++) world.eff[k]![0] = effLnZ0(local, 0, 0, (2 * Math.PI * k) / n + yaw);
    return world;
  });
  return (t) => {
    if (!fields.length) return "open";
    let i = 0;
    while (i + 1 < series.samples.length && series.samples[i + 1]!.t <= t + 1e-9) i++;
    return fields[i]!;
  };
}


/** World → target frame (and back) for a house at (x, z) turned by yaw. */
export function frameOf(b: Pick<Building, "x" | "z" | "yaw">) {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  // Building local → world: rotation about +Y by yaw (x' = x c + z s, z' = −x s + z c).
  const dirToLocal = (v: Vec3): Vec3 => ({ x: v.x * c - v.z * s, y: v.y, z: v.x * s + v.z * c });
  const dirToWorld = (v: Vec3): Vec3 => ({ x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c });
  const qy: Q = [0, Math.sin(b.yaw / 2), 0, Math.cos(b.yaw / 2)];
  const qyInv: Q = [0, -qy[1], 0, qy[3]];
  return {
    toLocal: (p: Vec3): Vec3 => dirToLocal({ x: p.x - b.x, y: p.y, z: p.z - b.z }),
    toWorld: (l: Vec3): Vec3 => {
      const d = dirToWorld(l);
      return { x: b.x + d.x, y: d.y, z: b.z + d.z };
    },
    dirToLocal,
    dirToWorld,
    qToLocal: (q: Q): Q => qmul(qyInv, q),
    qToWorld: (q: Q): Q => qmul(qy, q),
  };
}

function qmul(a: Q, b: Q): Q {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/** In the capture box: the footprint grown by the margin on every side, up to the box height. */
export function inCaptureBox(b: Pick<Building, "width" | "depth">, l: Vec3): boolean {
  const m = LAB_RECORDING.boxMargin;
  return Math.abs(l.x) <= b.width / 2 + m && Math.abs(l.z) <= b.depth / 2 + m && l.y <= LAB_RECORDING.boxHeight;
}

export interface DebrisRecorder {
  /** Pieces recorded so far. */
  readonly count: number;
  stop(): DebrisRecording;
  /** After `stop`: the debris field's piece each recorded piece came from (null for detailed
   *  members), in the recording's order (tests). */
  readonly sources: readonly (Piece | null)[];
}

/**
 * Record the debris reaching house `index`. `wind` describes the run's wind in the target's
 * frame (the lab knows it; the main sim builds it from its params, see `townWind`).
 */
export function recordDebrisAt(sim: Sim, index: number, wind: DebrisRecording["wind"], opts: { seed: number; code?: string; dispersion?: boolean }): DebrisRecorder {
  const b = sim.world.buildings[index]!;
  const f = frameOf(b);
  const debrisDt = SIM_DEFAULTS.dt * DEBRIS.stepInterval;
  const pieces: RecordedPiece[] = [];
  const from: (Piece | null)[] = [];
  let sources: (Piece | null)[] = [];
  /** Town pieces: inside last step? (absent = never seen), and those left out for good. */
  const inside = new WeakMap<Piece, boolean>();
  const out = new WeakSet<Piece>();
  /** Detailed members of other houses: last position and whether inside. */
  const members = new Map<string, { pos: Vec3; inside: boolean; out: boolean }>();
  const start = sim.time;
  /** The roughness at the target (Spec 17), sampled at each field update. */
  const terrainSamples: TerrainSeries["samples"] = [];
  let terrainSeen = -1;
  const sampleNow = (t: number) => {
    const tr = sim.snapshot.terrain;
    if (!isField(tr) || tr.version === terrainSeen) return;
    terrainSeen = tr.version;
    terrainSamples.push(sampleTerrain(tr, b, t));
  };
  sampleNow(start);

  const detach = sim.observe({
    impact: (house, _q, _path, p) => {
      if (house === index && p) out.add(p);
    },
    debrisStep: (time) => {
      const t = time + debrisDt;
      sampleNow(time);
      for (const p of sim.debris.pieces) {
        if (!p || p.hidden || out.has(p)) continue;
        const l = f.toLocal(p.pos);
        const now = inCaptureBox(b, l);
        const was = inside.get(p);
        inside.set(p, now);
        // The target's own debris is left out. A neighbor's piece born inside the box (next-door
        // walls stand inside it) is recorded where it's first seen; others when they cross in.
        if (p.sourceId === b.id) {
          out.add(p);
          continue;
        }
        if (!was && now) {
          out.add(p); // recorded once
          from.push(p);
          pieces.push({
            t,
            source: "town",
            kind: p.kind,
            ...(p.rigid ? { heavy: true } : {}),
            mass: p.def.mass,
            dims: [p.def.dims[0], p.def.dims[1], p.def.dims[2]],
            represents: p.represents,
            pos: l,
            vel: f.dirToLocal(p.vel),
            q: f.qToLocal(p.q),
            ...(p.angVel ? { angVel: f.dirToLocal(p.angVel) } : {}),
            liftRoll: p.liftRoll,
            spin: p.spin,
            gust: f.dirToLocal(p.gust),
            stepPhase: (p.stepPhase ?? p.id) % 2,
            ...(p.steppedTo !== undefined ? { steppedTo: p.steppedTo } : {}),
            ...(p.grounded ? { grounded: true } : {}),
          });
        }
      }
      // Detailed members flying from other houses (velocity from the pose change).
      for (const [i, h] of sim.detail.houses) {
        if (i === index) continue;
        const stamps = sim.detail.stamps.get(i)!;
        for (let m = 0; m < stamps.length; m++) {
          if (!stamps[m]) continue;
          const o = m * 7;
          const y = h.poses[o + 1]!;
          if (y < -1000) continue;
          const key = `${i}:${m}`;
          const pos = { x: h.poses[o]!, y, z: h.poses[o + 2]! };
          const l = f.toLocal(pos);
          const now = inCaptureBox(b, l);
          const prev = members.get(key);
          if (!prev) {
            members.set(key, { pos, inside: now, out: now });
            continue;
          }
          if (!prev.out && !prev.inside && now) {
            const mem = h.framing.members[m]!;
            const v = { x: (pos.x - prev.pos.x) / debrisDt, y: (pos.y - prev.pos.y) / debrisDt, z: (pos.z - prev.pos.z) / debrisDt };
            pieces.push({
              t,
              source: "member",
              kind: mem.kind,
              mass: mem.mass,
              dims: memberDims(mem),
              represents: 1,
              pos: l,
              vel: f.dirToLocal(v),
              q: f.qToLocal([h.poses[o + 3]!, h.poses[o + 4]!, h.poses[o + 5]!, h.poses[o + 6]!]),
            });
            from.push(null);
            prev.out = true;
          }
          prev.pos = pos;
          prev.inside = now;
        }
      }
    },
  });

  return {
    get count() {
      return pieces.length;
    },
    get sources() {
      return sources;
    },
    stop() {
      detach();
      const order = pieces.map((_, i) => i).sort((a, c) => pieces[a]!.t - pieces[c]!.t || a - c);
      sources = order.map((i) => from[i]!);
      const spec: Record<string, unknown> = {};
      for (const k of ["width", "depth", "wallHeight", "roofRise", "cls", "hasGarage", "yaw", "drawSeed"] as const) spec[k] = (b as unknown as Record<string, unknown>)[k];
      return {
        version: RECORDING_VERSION,
        code: opts.code ?? "dev",
        seed: opts.seed,
        dispersion: opts.dispersion ?? true,
        target: { width: b.width, depth: b.depth, yaw: b.yaw, spec },
        wind,
        terrain: (() => {
          const tr = sim.snapshot.terrain;
          return isField(tr) ? { kind: "series" as const, samples: terrainSamples } : tr;
        })(),
        seconds: sim.time - start,
        pieces: order.map((i) => pieces[i]!),
      };
    },
  };
}

/** Size of a member's bounding box (m), from its shapes. */
function memberDims(m: { shapes: { pos: Vec3; size: [number, number, number] | number[] }[] }): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const s of m.shapes) {
    x = Math.max(x, Math.abs(s.pos.x) * 2 + s.size[0]!);
    y = Math.max(y, Math.abs(s.pos.y) * 2 + s.size[1]!);
    z = Math.max(z, Math.abs(s.pos.z) * 2 + s.size[2]!);
  }
  return [x, y, z];
}

/** A town run's wind in a target's frame: its tornado params and where it started. */
export function townWind(params: Readonly<TornadoParams>, start: { x: number; z: number }, b: Pick<Building, "x" | "z" | "yaw">, presetId: string): DebrisRecording["wind"] {
  const f = frameOf(b);
  const s = f.toLocal({ x: start.x, y: 0, z: start.z });
  return { kind: "pass", presetId, lifecycle: "full", track: { start: { x: s.x, z: s.z }, headingDeg: params.heading - (b.yaw * 180) / Math.PI, params: { ...params } } };
}

