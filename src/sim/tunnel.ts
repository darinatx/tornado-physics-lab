/**
 * Wind tunnel (Spec 12): one house in a scripted wind, with debris fired at it, through the
 * same sim, debris field and detail engine as the town. Headless; the runner, record and checks
 * live in tests/harness/tunnel.ts.
 */
import { LAYOUT } from "../config/buildings";
import type { ConstructionClass } from "../config/buildings";
import { DEBRIS_KINDS } from "../config/debris";
import type { DebrisKind } from "../config/debris";
import { IMPACT } from "../config/impacts";
import { TUNNEL } from "../config/tunnel";
import { LOCAL_NORMALS, faceTangent, panelCenter } from "../core/damage/layout";
import type { Building, HouseSpec } from "../core/damage/types";
import { quatFromBasis } from "../core/debris/field";
import type { Piece } from "../core/debris/piece";
import type { Vec3 } from "../core/math/vec";
import { buildFraming } from "../core/structure/framing";
import type { MemberKind } from "../core/structure/framing";
import type { TerrainClass } from "../core/wind/types";
import { randomHouseSpec } from "./city";
import { createLocalBackend } from "./detailBackend";
import type { DetailLaunch } from "./detailZone";
import type { Sim } from "./loop";
import { createRng } from "./rng";
import { initRapier } from "./structureWorld";
import type { StructureWorld } from "./structureWorld";
import type { SimConfig, SimTaps } from "./types";
import { createSim } from "./loop";
import { tunnelFlow } from "./tunnelFlow";
import type { WindKey } from "./tunnelFlow";

export { tunnelFlow, tunnelState } from "./tunnelFlow";
export type { WindKey } from "./tunnelFlow";

type Q = [number, number, number, number];

/** What a launch aims at on the target: a pane's center, the solid part of a wall panel at
 *  mid-height (beside its window, if any), or a house-local point. */
export type Aim = { pane: number } | { wall: number } | { point: Vec3 };

interface LaunchBase {
  /** Sim time (s): the piece enters at the first step at or after it. */
  t: number;
  /** Start point (world, m). Optional with a pane or wall aim: then `standoff` out along its normal. */
  from?: Vec3;
  aim?: Aim;
  standoff?: number;
  /** Direction of flight (any length); default toward the aim. */
  dir?: Vec3;
  /** m/s. */
  speed: number;
  /** rad/s (detailed members). */
  spin?: Vec3;
}
export interface TownLaunch extends LaunchBase {
  source: "town";
  kind: DebrisKind;
  represents?: number;
  /** Orientation; default end-on (the piece's long axis along its flight). */
  q?: Q;
}
export interface MemberLaunch extends LaunchBase {
  source: "detail-same" | "detail-other";
  member: MemberKind;
  /** Which of the donor's members of that kind (by id order), and how many fly together. */
  nth?: number;
  count?: number;
}
export type Launch = TownLaunch | MemberLaunch;

export interface TunnelScenario {
  name: string;
  seed?: number;
  seconds: number;
  target: { model: "component" | "detail"; spec?: Partial<HouseSpec>; cls?: ConstructionClass };
  terrain?: TerrainClass;
  wind: readonly WindKey[];
  launches?: readonly Launch[];
}

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

export interface Tunnel {
  readonly sim: Sim;
  readonly scenario: TunnelScenario;
  /** Index of the target in the sim's buildings, and of the donors. */
  readonly target: number;
  readonly donors: { same?: number; other?: number };
  readonly launched: Launched[];
  /** The sim's observers: set their fields to record (the harness does). */
  readonly taps: SimTaps;
  /** Advance by `seconds` of sim time, 1/60 s at a time (each debris step), calling `onStep`
   *  after each; chunking never changes the result. */
  advance(seconds: number): void;
  onStep: ((t: Tunnel) => void) | null;
  /** The physics world a house is in (detail zone), if any. */
  worldOf(index: number): StructureWorld | undefined;
  /** Where launch i's members are now (detailed launches). */
  launchBody(i: number): { center: Vec3; vel: Vec3; members: number[]; bornAt: number } | null;
  dispose(): void;
}

const DEG = Math.PI / 180;

/** Mean wind direction over the schedule (deg), weighted by speed; the first key's if calm. */
function meanDir(keys: readonly WindKey[]): number {
  let x = 0;
  let z = 0;
  for (const k of keys) {
    x += k.mph * Math.cos(k.dirDeg * DEG);
    z += k.mph * Math.sin(k.dirDeg * DEG);
  }
  return Math.hypot(x, z) > 1e-9 ? Math.atan2(z, x) / DEG : (keys[0]?.dirDeg ?? 0);
}

const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const toWorldDir = (b: Building, x: number, z: number): Vec3 => ({ x: x * Math.cos(b.yaw) + z * Math.sin(b.yaw), y: 0, z: -x * Math.sin(b.yaw) + z * Math.cos(b.yaw) });
const toWorldPt = (b: Building, l: Vec3): Vec3 => {
  const d = toWorldDir(b, l.x, l.z);
  return { x: b.x + d.x, y: l.y, z: b.z + d.z };
};

/** The aim's world point and outward normal on the target. */
export function aimPoint(b: Building, aim: Aim): { point: Vec3; normal: Vec3 | null } {
  if ("point" in aim) return { point: toWorldPt(b, aim.point), normal: null };
  const panelIndex = "pane" in aim ? b.panes[aim.pane]?.panel : aim.wall;
  const panel = panelIndex === undefined ? undefined : b.panels[panelIndex];
  if (!panel) throw new Error(`no such ${"pane" in aim ? "pane" : "wall panel"} on the target`);
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

/** End-on orientation: the piece's long axis (local X) along `dir`. */
function endOn(dir: Vec3): Q {
  const ref = Math.abs(dir.y) < 0.95 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const d = ref.x * dir.x + ref.y * dir.y + ref.z * dir.z;
  const y = norm({ x: ref.x - d * dir.x, y: ref.y - d * dir.y, z: ref.z - d * dir.z });
  const z = { x: dir.y * y.z - dir.z * y.y, y: dir.z * y.x - dir.x * y.z, z: dir.x * y.y - dir.y * y.x };
  return quatFromBasis(dir, y, z);
}

/** Build the tunnel: the target (and any donors) as the sim's houses, the flow as its wind. */
export async function createTunnel(s: TunnelScenario): Promise<Tunnel> {
  const seed = s.seed ?? 1;
  const launches = s.launches ?? [];
  const rng = createRng(seed);
  const spec: HouseSpec = { ...randomHouseSpec(0, rng, 0, 0, 0, s.target.cls), ...s.target.spec, id: 0, x: 0, z: 0 };
  const houses: HouseSpec[] = [spec];
  const donors: { same?: number; other?: number } = {};
  const across = (meanDir(s.wind) + 90) * DEG;
  const side = { x: Math.cos(across), z: -Math.sin(across) };
  const donor = (sign: number): number => {
    houses.push({ ...spec, id: houses.length, x: sign * side.x * TUNNEL.donorOffset, z: sign * side.z * TUNNEL.donorOffset });
    return houses.length - 1;
  };
  if (launches.some((l) => l.source === "detail-same")) donors.same = donor(1);
  if (launches.some((l) => l.source === "detail-other")) donors.other = donor(-1);

  const detailSet: NonNullable<SimConfig["detailSet"]>[number][] = [];
  if (s.target.model === "detail") detailSet.push({ index: 0, group: "tunnel:target" });
  if (donors.same !== undefined) detailSet.push({ index: donors.same, group: "tunnel:target", stripped: true });
  if (donors.other !== undefined) detailSet.push({ index: donors.other, group: "tunnel:other", stripped: true });
  const needDetail = detailSet.length > 0;
  await initRapier();

  // Pending launches, in time order (stable).
  const pending = launches.map((l, i) => ({ l, i })).sort((a, b) => a.l.t - b.l.t || a.i - b.i);
  const launched: Launched[] = [];
  let tun: Tunnel;
  let target: Building;
  const framings = new Map<number, ReturnType<typeof buildFraming>>();

  const resolve = (l: Launch) => {
    let at = l.from;
    let dir = l.dir ? norm(l.dir) : null;
    if (l.aim) {
      const a = aimPoint(target, l.aim);
      if (!at) {
        if (!a.normal) throw new Error("a point aim needs a start point");
        const d = l.standoff ?? TUNNEL.standoff;
        at = { x: a.point.x + a.normal.x * d, y: a.point.y, z: a.point.z + a.normal.z * d };
      }
      dir ??= norm({ x: a.point.x - at.x, y: a.point.y - at.y, z: a.point.z - at.z });
    }
    if (!at || !dir) throw new Error("a launch needs a start point and a direction or aim");
    return { at, dir, vel: { x: dir.x * l.speed, y: dir.y * l.speed, z: dir.z * l.speed } };
  };

  const taken = (kind: "town" | "detail", time: number) => {
    const out: { l: Launch; i: number }[] = [];
    while (true) {
      const k = pending.findIndex((p) => (p.l.source === "town") === (kind === "town") && p.l.t <= time + 1e-9);
      if (k < 0) break;
      out.push(pending.splice(k, 1)[0]!);
    }
    return out;
  };

  const inject: SimConfig["inject"] = {
    debris(time, field) {
      for (const { l, i } of taken("town", time)) {
        const tl = l as TownLaunch;
        const { at, dir, vel } = resolve(tl);
        const q = tl.q ?? endOn(dir);
        const piece = field.launch(tl.kind, at, vel, q, time, tl.represents ?? 1);
        launched.push({ i, time, source: "town", label: DEBRIS_KINDS[tl.kind].label, at: { ...at }, vel: { ...vel }, q: [...q], piece });
      }
    },
    detail(time) {
      const out: DetailLaunch[] = [];
      for (const { l, i } of taken("detail", time)) {
        const ml = l as MemberLaunch;
        const house = ml.source === "detail-same" ? donors.same! : donors.other!;
        let f = framings.get(house);
        if (!f) framings.set(house, (f = buildFraming(tun.sim.world.buildings[house]!)));
        const ofKind = f.members.filter((m) => m.kind === ml.member);
        const members = ofKind.slice(ml.nth ?? 0, (ml.nth ?? 0) + (ml.count ?? 1)).map((m) => m.id);
        if (!members.length) throw new Error(`the donor has no ${ml.member} #${ml.nth ?? 0}`);
        const { at, dir, vel } = resolve(ml);
        out.push({ index: house, members, center: at, vel, spin: ml.spin ?? { x: 0, y: 0, z: 0 }, axis: dir });
        launched.push({ i, time, source: ml.source, label: ml.member, at: { ...at }, vel: { ...vel }, q: [0, 0, 0, 1], house, members });
      }
      return out;
    },
  };

  // Observers: the harness fills them in after creation (it owns the record).
  const taps: SimTaps = {};
  let backend: ReturnType<typeof createLocalBackend> | null = null;
  const sim = createSim(
    { houses, tunnel: (t) => tunnelFlow(s.wind, t), ...(needDetail ? { detailSet } : {}), taps, inject },
    seed,
    { terrain: s.terrain ?? "open" },
    needDetail ? (_seed, b) => (backend = createLocalBackend(b, 1)) : undefined,
  );
  if (needDetail) sim.setDetailFocus({ x: 0, z: 0 });
  target = sim.world.buildings[0]!;

  let want = 0;
  let done = 0;
  tun = {
    sim,
    scenario: s,
    target: 0,
    donors,
    launched,
    taps,
    onStep: null,
    advance(seconds) {
      want += seconds;
      const n = Math.floor(want * 60 + 1e-6);
      while (done < n) {
        sim.advance(1 / 60);
        done++;
        tun.onStep?.(tun);
      }
    },
    worldOf(index) {
      return backend?.engines[0]?.worldFor(index);
    },
    launchBody(i) {
      const l = launched.find((x) => x.i === i);
      if (!l || l.house === undefined || !backend) return null;
      const h = backend.engines[0]!.houses.get(l.house);
      return h ? h.freeState(l.members![0]!) : null;
    },
    dispose() {
      backend?.dispose();
    },
  };
  return tun;
}
