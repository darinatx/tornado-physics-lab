/**
 * Debris launcher (Spec 12, Spec 13): pieces fired into the sim through its `inject` hook, so
 * every one moves and hits by the town's code. Launches can be given up front (the tunnel) or
 * added while the sim runs (the lab); each enters at the first step at or after its time.
 */
import { AIR_DENSITY, GRAVITY } from "../config/atmosphere";
import { LAYOUT } from "../config/buildings";
import { DEBRIS, DEBRIS_KINDS } from "../config/debris";
import { SIM_DEFAULTS } from "../config/sim";
import type { DebrisKind, DebrisKindDef } from "../config/debris";
import { IMPACT } from "../config/impacts";
import { TUNNEL } from "../config/tunnel";
import { LOCAL_NORMALS, faceTangent, panelCenter } from "../core/damage/layout";
import type { Building } from "../core/damage/types";
import { quatFromBasis } from "../core/debris/field";
import type { LaunchState } from "../core/debris/field";
import type { Piece } from "../core/debris/piece";
import type { Vec3 } from "../core/math/vec";
import { buildFraming } from "../core/structure/framing";
import type { Framing, MemberKind } from "../core/structure/framing";
import type { DetailLaunch } from "./detailZone";
import type { SimConfig } from "./types";

export type Q = [number, number, number, number];

/** What a launch aims at on a house: a pane's center, the solid part of a wall panel at
 *  mid-height (beside its window, if any), or a house-local point. */
export type Aim = { pane: number } | { wall: number } | { point: Vec3 };

interface LaunchBase {
  /** Sim time (s): the piece enters at the first step at or after it. */
  t: number;
  /** Start point (world, m). Optional with a pane or wall aim: then `standoff` out along its normal. */
  from?: Vec3;
  aim?: Aim;
  /** House the aim is on (index into the sim's buildings; default the launcher's target). */
  house?: number;
  standoff?: number;
  /** Direction of flight (any length); default toward the aim. */
  dir?: Vec3;
  /** m/s. */
  speed: number;
  /** Exact velocity (m/s), overriding `dir` and `speed` (replayed pieces, Spec 13). */
  vel?: Vec3;
  /** rad/s (detailed members). */
  spin?: Vec3;
}
export interface TownLaunch extends LaunchBase {
  source: "town";
  kind: DebrisKind;
  represents?: number;
  /** Orientation; default end-on (the piece's long axis along its flight). */
  q?: Q;
  /** A replayed piece's own state (Spec 13). */
  state?: LaunchState;
  /** Shown in the log instead of the kind's label (reference missiles). */
  label?: string;
  /** `speed` is the speed on arrival at the aim (test standards give the impact speed): the
   *  launch velocity is solved for free flight with drag and gravity, in the wind now (still air
   *  if the launcher has no wind; Spec 13). */
  arrive?: boolean;
}
export interface MemberLaunch extends LaunchBase {
  source: "detail-same" | "detail-other";
  member: MemberKind;
  /** Which of the donor's members of that kind (by id order), and how many fly together. */
  nth?: number;
  count?: number;
}
export type Launch = TownLaunch | MemberLaunch;

/** A launch as it entered the sim. */
export interface Launched {
  i: number;
  time: number;
  source: Launch["source"];
  label: string;
  at: Vec3;
  vel: Vec3;
  q: Q;
  piece?: Piece;
  house?: number;
  members?: number[];
}

export const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const toWorldDir = (b: Building, x: number, z: number): Vec3 => ({ x: x * Math.cos(b.yaw) + z * Math.sin(b.yaw), y: 0, z: -x * Math.sin(b.yaw) + z * Math.cos(b.yaw) });
export const toWorldPt = (b: Building, l: Vec3): Vec3 => {
  const d = toWorldDir(b, l.x, l.z);
  return { x: b.x + d.x, y: l.y, z: b.z + d.z };
};

/** The aim's world point and outward normal on a house. */
export function aimPoint(b: Building, aim: Aim): { point: Vec3; normal: Vec3 | null } {
  if ("point" in aim) return { point: toWorldPt(b, aim.point), normal: null };
  const panelIndex = "pane" in aim ? b.panes[aim.pane]?.panel : aim.wall;
  const panel = panelIndex === undefined ? undefined : b.panels[panelIndex];
  if (!panel) throw new Error(`no such ${"pane" in aim ? "pane" : "wall panel"} on the house`);
  const n = LOCAL_NORMALS[panel.face]!;
  let l: Vec3;
  if ("pane" in aim) l = panelCenter(b, panel, IMPACT.slabTop + LAYOUT.paneSill + LAYOUT.paneSize / 2);
  else {
    if (panel.isGarage) throw new Error("wall aim on a garage panel");
    l = panelCenter(b, panel, IMPACT.slabTop + b.wallHeight / 2);
    if (panel.hasWindow) {
      // Beside the window: the middle of the solid strip between the pane and the panel's end.
      const t = faceTangent(panel.face);
      const off = (panel.len / 2 + LAYOUT.paneSize / 2) / 2;
      l = { x: l.x + t.x * off, y: l.y, z: l.z + t.z * off };
    }
  }
  return { point: toWorldPt(b, l), normal: toWorldDir(b, n.x, n.z) };
}

/**
 * Launch velocity for a piece to arrive at `aim` from `from` at `speed` (m/s), in still air with
 * its drag and gravity (shooting method on the point model's equations).
 */
export function arriveVelocity(from: Vec3, aim: Vec3, speed: number, def: Pick<DebrisKindDef, "cda" | "mass">, wind: (p: Vec3) => Vec3 = () => ZERO): Vec3 {
  // The debris field's own step and integrator (semi-implicit drag, Spec 04), in still air.
  const dt = SIM_DEFAULTS.dt * DEBRIS.stepInterval;
  const kd = (0.5 * AIR_DENSITY * def.cda) / def.mass;
  let v0 = norm({ x: aim.x - from.x, y: aim.y - from.y, z: aim.z - from.z });
  v0 = { x: v0.x * speed, y: v0.y * speed, z: v0.z * speed };
  const D = { x: aim.x - from.x, y: aim.y - from.y, z: aim.z - from.z };
  const dist = Math.hypot(D.x, D.y, D.z);
  const u = { x: D.x / dist, y: D.y / dist, z: D.z / dist };
  for (let it = 0; it < 30; it++) {
    // Fly until the piece reaches the aim's distance along the line of sight.
    const p = { ...from };
    const v = { ...v0 };
    let t = 0;
    while ((p.x - from.x) * u.x + (p.y - from.y) * u.y + (p.z - from.z) * u.z < dist && t < 10) {
      const w = wind(p);
      const inv = 1 / (1 + kd * Math.hypot(w.x - v.x, w.y - v.y, w.z - v.z) * dt);
      const k = kd * Math.hypot(w.x - v.x, w.y - v.y, w.z - v.z);
      v.x = (v.x + dt * k * w.x) * inv;
      v.y = (v.y + dt * (k * w.y - GRAVITY)) * inv;
      v.z = (v.z + dt * k * w.z) * inv;
      p.x += v.x * dt;
      p.y += v.y * dt;
      p.z += v.z * dt;
      t += dt;
    }
    const miss = { x: aim.x - p.x, y: aim.y - p.y, z: aim.z - p.z };
    const arrived = Math.hypot(v.x, v.y, v.z);
    const err = Math.hypot(miss.x, miss.y, miss.z);
    if (err < 1e-3 && Math.abs(arrived - speed) < 1e-3 * speed) break;
    // Aim off by the miss, and scale for the speed lost on the way.
    const k = speed / Math.max(arrived, 1e-6);
    v0 = { x: (v0.x + miss.x / Math.max(t, 1e-3)) * k, y: (v0.y + miss.y / Math.max(t, 1e-3)) * k, z: (v0.z + miss.z / Math.max(t, 1e-3)) * k };
  }
  return v0;
}

/** End-on orientation: the piece's long axis (local X) along `dir`. */
export function endOn(dir: Vec3): Q {
  const ref = Math.abs(dir.y) < 0.95 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const d = ref.x * dir.x + ref.y * dir.y + ref.z * dir.z;
  const y = norm({ x: ref.x - d * dir.x, y: ref.y - d * dir.y, z: ref.z - d * dir.z });
  const z = { x: dir.y * y.z - dir.z * y.y, y: dir.z * y.x - dir.x * y.z, z: dir.x * y.y - dir.y * y.x };
  return quatFromBasis(dir, y, z);
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

export class Launcher {
  /** The wind now (the lab sets it), for launches that must arrive at their aim. */
  wind: ((p: Vec3) => Vec3) | null = null;

  readonly launched: Launched[] = [];
  /** Waiting launches, in time order (stable by number). */
  private readonly pending: { l: Launch; i: number }[] = [];
  private count = 0;
  private readonly framings = new Map<number, Framing>();

  constructor(
    private readonly buildings: () => readonly Building[],
    /** Default house for aims. */
    public target: number,
    /** Stripped donor houses for detailed members (Spec 12). */
    readonly donors: { same?: number; other?: number } = {},
  ) {}

  /** Queue a launch; returns its number. A launch that can't be resolved is refused here,
   *  not when the sim steps. */
  add(l: Launch): number {
    if (l.aim && "point" in l.aim && !l.from) throw new Error("a point aim needs a start point");
    if (!l.aim && (!l.from || (!l.dir && !l.vel))) throw new Error("a launch needs a start point and a direction or aim");
    const i = this.count++;
    let k = this.pending.length;
    while (k > 0 && this.pending[k - 1]!.l.t > l.t) k--;
    this.pending.splice(k, 0, { l, i });
    return i;
  }

  get waiting(): number {
    return this.pending.length;
  }

  private resolve(l: Launch) {
    let at = l.from;
    let dir = l.dir ? norm(l.dir) : null;
    if (l.aim) {
      const a = aimPoint(this.buildings()[l.house ?? this.target]!, l.aim);
      if (!at) {
        if (!a.normal) throw new Error("a point aim needs a start point");
        const d = l.standoff ?? TUNNEL.standoff;
        at = { x: a.point.x + a.normal.x * d, y: a.point.y, z: a.point.z + a.normal.z * d };
      }
      dir ??= norm({ x: a.point.x - at.x, y: a.point.y - at.y, z: a.point.z - at.z });
    }
    if (l.vel && at) return { at, dir: dir ?? norm(l.vel), vel: { ...l.vel } };
    if (!at || !dir) throw new Error("a launch needs a start point and a direction or aim");
    return { at, dir, vel: { x: dir.x * l.speed, y: dir.y * l.speed, z: dir.z * l.speed } };
  }

  private taken(kind: "town" | "detail", time: number): { l: Launch; i: number }[] {
    const out: { l: Launch; i: number }[] = [];
    for (let k = 0; k < this.pending.length; ) {
      const p = this.pending[k]!;
      if (p.l.t > time + 1e-9) break;
      if ((p.l.source === "town") === (kind === "town")) out.push(this.pending.splice(k, 1)[0]!);
      else k++;
    }
    return out;
  }

  /** The sim's launch hook. */
  readonly inject: NonNullable<SimConfig["inject"]> = {
    debris: (time, field) => {
      for (const { l, i } of this.taken("town", time)) {
        const tl = l as TownLaunch;
        let { at, dir, vel } = this.resolve(tl);
        if (tl.arrive) {
          const target = { x: at.x + dir.x * 1, y: at.y + dir.y * 1, z: at.z + dir.z * 1 };
          const aim = tl.aim ? aimPoint(this.buildings()[tl.house ?? this.target]!, tl.aim).point : target;
          vel = arriveVelocity(at, aim, tl.speed, tl.state?.def ?? DEBRIS_KINDS[tl.kind], this.wind ?? undefined);
          dir = norm(vel);
        }
        const q = tl.q ?? endOn(dir);
        const piece = field.launch(tl.kind, at, vel, q, time, tl.represents ?? 1, -1, tl.state);
        this.launched.push({ i, time, source: "town", label: tl.label ?? DEBRIS_KINDS[tl.kind].label, at: { ...at }, vel: { ...vel }, q: [...q], piece });
      }
    },
    detail: (time) => {
      const out: DetailLaunch[] = [];
      for (const { l, i } of this.taken("detail", time)) {
        const ml = l as MemberLaunch;
        const house = ml.source === "detail-same" ? this.donors.same : this.donors.other;
        if (house === undefined) throw new Error(`a ${ml.source} launch needs that donor`);
        let f = this.framings.get(house);
        if (!f) this.framings.set(house, (f = buildFraming(this.buildings()[house]!)));
        const ofKind = f.members.filter((m) => m.kind === ml.member);
        const members = ofKind.slice(ml.nth ?? 0, (ml.nth ?? 0) + (ml.count ?? 1)).map((m) => m.id);
        if (!members.length) throw new Error(`the donor has no ${ml.member} #${ml.nth ?? 0}`);
        const { at, dir, vel } = this.resolve(ml);
        out.push({ index: house, members, center: at, vel, spin: ml.spin ?? { x: 0, y: 0, z: 0 }, axis: dir });
        this.launched.push({ i, time, source: ml.source, label: ml.member, at: { ...at }, vel: { ...vel }, q: [0, 0, 0, 1], house, members });
      }
      return out;
    },
  };
}
