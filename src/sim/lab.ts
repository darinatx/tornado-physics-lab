/**
 * Structure lab (Spec 13): the real sim on a small explicit layout. A block of 1–12 houses (in
 * the detail set from the first step, one physics group), optionally inside the town's lot
 * pattern of component houses; steady wind (Spec 12 flow) or a tornado pass; the tunnel's
 * launcher; the run record; debris recording and replay. No lab-only physics.
 */
import { LAB } from "../config/structure";
import { LAB_LAUNCH, LAB_LAYOUT, LAB_PASS_CALM_MPH, REFERENCE_MISSILES } from "../config/lab";
import type { ConstructionClass } from "../config/buildings";
import { compact, DEBRIS, DEBRIS_KINDS, rod, sheet } from "../config/debris";
import type { DebrisKind, DebrisKindDef } from "../config/debris";
import { DETAIL } from "../config/structure";
import { PRESETS } from "../config/presets";
import { SIM_DEFAULTS } from "../config/sim";
import { IMPACT } from "../config/impacts";
import { LOCAL_NORMALS, faceTangent } from "../core/damage/layout";
import type { Building, HouseSpec } from "../core/damage/types";
import type { Vec3 } from "../core/math/vec";
import { buildFraming } from "../core/structure/framing";
import type { MemberKind } from "../core/structure/framing";
import { mphToMs } from "../core/wind/efScale";
import type { TerrainClass } from "../core/wind/types";
import { windAt } from "../core/wind/windField";
import { generateNeighborhood, randomHouseSpec } from "./city";
import { createLocalBackend, createWorkerBackend } from "./detailBackend";
import { createWorkerHeavy } from "./heavyBackend";
import type { DetailBackend } from "./detailBackend";
import { frameOf, recordDebrisAt, seriesTerrain } from "./debrisRecorder";
import { layoutCover, TownRoughness } from "./terrain";
import type { Terrain } from "../core/terrain/roughness";
import type { DebrisRecorder, DebrisRecording } from "./debrisRecorder";
import type { HeavyBackend } from "./heavyBackend";
import { Launcher, toWorldPt } from "./launcher";
import type { Aim, Launch, Launched } from "./launcher";
import { createSim } from "./loop";
import type { Sim } from "./loop";
import { createRng } from "./rng";
import { RunRecorder } from "./runRecord";
import type { TunnelRecord } from "./runRecord";
import { initRapier } from "./structureWorld";
import { tunnelFlow } from "./tunnelFlow";
import type { WindKey } from "./tunnelFlow";
import { defaultParams } from "./types";
import type { SimConfig, TornadoParams } from "./types";

export interface LabSetup {
  /** 1–12. */
  houses: number;
  cls: ConstructionClass;
  /** Construction mix (Spec 13 v0.9): weak, standard and strong counts, filled in that order;
   *  overrides `houses` and `cls` when given (total capped at 12). */
  mixCounts?: { weak: number; standard: number; strong: number };
  surroundings: "neighborhood" | "open";
  seed: number;
  donors: boolean;
  /** Block model (default detail). */
  model?: "detail" | "component";
  /** Per-house spec overrides (tests). */
  specs?: Partial<HouseSpec>[];
  /** Debris dispersion (default on). */
  dispersion?: boolean;
  /** Neighbor density, × the town's lot pattern (0.25–1.75, default 1; neighborhood only). */
  density?: number;
  /** Terrain (Spec 17): "auto" (default) = the roughness of the surroundings; a class = that
   *  class everywhere. */
  terrain?: TerrainClass | "auto";
}

export type LabWind =
  | { kind: "steady"; keys: WindKey[] }
  /** `params` over the preset's (heading and path curve are always the pass's own). */
  | { kind: "pass"; presetId: string; headingDeg: number; offset: number; lifecycle: "mature" | "full"; params?: Partial<TornadoParams> }
  /** An explicit track (replay of a recording): params, and where it is at sim time 0. */
  | { kind: "track"; presetId: string; lifecycle: "mature" | "full"; params: Partial<TornadoParams>; start: { x: number; z: number } };

/** A launch whose time defaults to the next step. */
export type LaunchInput = Launch extends infer L ? (L extends Launch ? Omit<L, "t"> & { t?: number } : never) : never;

export interface StreamSpec {
  kind: DebrisKind;
  /** Pieces per second. */
  rate: number;
  /** House aimed at (default the first lab house) and its face (0–3, local +X, +Z, −X, −Z), or
   *  "windward" (the face the wind blows onto now). */
  house?: number;
  face?: number | "windward";
  /** m/s; default the wind speed where the piece starts. */
  speed?: number;
}

export interface ReplaySpec {
  recording: DebrisRecording;
  /** Lab house (block position) receiving it, or the block's center. */
  house: number | "block";
  wind: "recorded" | "none" | "lab";
}

export interface ConnectionInfo {
  id: number;
  label: string;
  /** Supporting member id, or −1 for the slab. */
  to: number;
  toKind: string;
  capacity: number;
  /** N, at the engine's last solve. */
  load: number;
  utilization: number;
  intact: boolean;
  failed: { time: number; mph: number; load: number } | null;
}

export interface MemberInfo {
  house: number;
  member: number;
  kind: MemberKind;
  mass: number;
  attached: boolean;
  /** Detail step the loads are from. */
  step: number;
  connections: ConnectionInfo[];
  /** Highest utilization of its intact connections. */
  utilization: number;
}

export interface LabOptions {
  /** Run the detail and heavy-debris engines in Web Workers (the app), given the layout. */
  workers?: boolean;
  /** Detail engine (default in-process, one engine). */
  detail?: (seed: number, buildings: readonly Building[]) => DetailBackend;
  heavy?: SimConfig["heavy"];
  replay?: ReplaySpec;
  /** Pass-through check in the record (default on). */
  passThrough?: boolean;
}

export interface Lab {
  readonly sim: Sim;
  readonly setup: LabSetup;
  readonly wind: LabWind;
  /** The terrain setting in use (Spec 17): "auto", a class, or "recorded" (a replay's). */
  readonly terrain: TerrainClass | "auto" | "recorded";
  /** Sim building indices of the lab houses, the ring houses and the donors. */
  readonly block: number[];
  readonly ring: number[];
  readonly donors: { same?: number; other?: number };
  readonly launcher: Launcher;
  /** The steady-wind schedule (live edits append to it). */
  readonly keys: WindKey[];
  /** Keyframe a new steady wind at the current sim time (over `rampS` seconds, default one step). */
  setSteady(mph: number, dirDeg: number, opts?: { w?: number; rampS?: number }): void;
  /** Queue a launch (default: at the next step); returns its number. */
  launch(l: LaunchInput): number;
  /** Fire a reference missile at a house's aim. */
  fireMissile(id: string, house: number, aim: Aim, opts?: { t?: number }): number;
  /** Fire the donor's next unused member of a kind at a house's aim (LAB-17); throws when the
   *  donor has none left, or there's no donor. */
  fireMember(kind: MemberKind, house: number, aim: Aim, speed: number, opts?: { t?: number }): number;
  /** Members of a kind the donor has left. */
  membersLeft(kind: MemberKind): number;
  stream(s: StreamSpec | null): void;
  readonly streaming: StreamSpec | null;
  memberInfo(house: number, member: number): MemberInfo | null;
  /** The Spec 12 record of the run, for the first lab house (or `recordTarget`). */
  record(): TunnelRecord;
  /** Start recording the debris reaching a house. */
  recordDebris(house: number): DebrisRecorder;
  /** Advance by `seconds` at fixed 1/60 s chunks (headless use). */
  advance(seconds: number): void;
  dispose(): void;
}

const DEG = Math.PI / 180;
const headingDir = (deg: number) => ({ x: Math.cos(deg * DEG), z: -Math.sin(deg * DEG) });

/** Seeds per lab house: its spec stream and its draw stream (layout and capacities). */
const mix = (seed: number, i: number, k: number) => ((seed * 0x9e3779b1) ^ (i * 0x85ebca77) ^ (k * 0xc2b2ae3d)) >>> 0;

/** The block: N houses in ⌈√N⌉ columns at lot spacing, centered on the origin. */
/** The block's classes, in grid order: the mix (weak, then standard, then strong), capped at
 *  the lab's limit, or `houses` of `cls`. */
export function blockClasses(setup: Pick<LabSetup, "houses" | "cls" | "mixCounts">): ConstructionClass[] {
  const m = setup.mixCounts;
  const list: ConstructionClass[] = m
    ? [...Array<ConstructionClass>(Math.max(0, Math.round(m.weak))).fill("weak"), ...Array<ConstructionClass>(Math.max(0, Math.round(m.standard))).fill("standard"), ...Array<ConstructionClass>(Math.max(0, Math.round(m.strong))).fill("strong")]
    : Array<ConstructionClass>(Math.max(1, Math.round(setup.houses))).fill(setup.cls);
  if (!list.length) list.push(setup.cls);
  return list.slice(0, LAB.maxHouses);
}

export function labBlockSpecs(setup: Pick<LabSetup, "houses" | "cls" | "seed" | "specs" | "mixCounts">): HouseSpec[] {
  const classes = blockClasses(setup);
  const n = classes.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const out: HouseSpec[] = [];
  for (let i = 0; i < n; i++) {
    const x = ((i % cols) - (cols - 1) / 2) * LAB.lotSpacing;
    const z = (Math.floor(i / cols) - (rows - 1) / 2) * LAB.lotSpacing;
    const rng = createRng(mix(setup.seed, i, 1));
    out.push({ ...randomHouseSpec(i, rng, x, z, 0, classes[i]), ...LAB_LAYOUT.house, drawSeed: mix(setup.seed, i, 2), ...setup.specs?.[i], id: i });
  }
  return out;
}

/** Half-extents of the block's lots (m). */
function blockHalf(specs: readonly HouseSpec[]): { x: number; z: number } {
  let x = 0;
  let z = 0;
  for (const s of specs) {
    x = Math.max(x, Math.abs(s.x) + LAB.lotSpacing / 2);
    z = Math.max(z, Math.abs(s.z) + LAB.lotSpacing / 2);
  }
  return { x, z };
}

/** The town's houses on lots within reach of the block's edge, clear of the lab lots. */
export function ringSpecs(seed: number, block: readonly HouseSpec[], density = 1): HouseSpec[] {
  const half = blockHalf(block);
  const reach = LAB_LAYOUT.reach;
  const out: HouseSpec[] = [];
  // Density (Spec 13 v0.6): the town's pattern scaled about the block by 1/√density; houses keep
  // their size, so houses per area go with density. The same houses, in the same order.
  const k = 1 / Math.sqrt(Math.min(LAB_LAYOUT.maxDensity, Math.max(LAB_LAYOUT.minDensity, density)));
  const keep = (b0: Building) => {
    const b = { ...b0, x: b0.x * k, z: b0.z * k };
    const dx = Math.max(0, Math.abs(b.x) - half.x);
    const dz = Math.max(0, Math.abs(b.z) - half.z);
    if (Math.hypot(dx, dz) > reach) return false;
    const r = Math.hypot(b.width, b.depth) / 2 + LAB_LAYOUT.lotClear;
    for (const s of block) {
      const ex = Math.max(0, Math.abs(b.x - s.x) - LAB.lotSpacing / 2);
      const ez = Math.max(0, Math.abs(b.z - s.z) - LAB.lotSpacing / 2);
      if (Math.hypot(ex, ez) < r) return false;
    }
    return true;
  };
  for (const b of generateNeighborhood(seed, keep).buildings)
    out.push({ id: 0, x: b.x * k, z: b.z * k, yaw: b.yaw, width: b.width, depth: b.depth, wallHeight: b.wallHeight, roofRise: b.roofRise, cls: b.cls, frontFace: b.frontFace, hasGarage: b.hasGarage, wallColor: b.wallColor, roofColor: b.roofColor });
  return out;
}

/** Farthest a mature pass starts (m): the far field decays slowly, so the calm search stops. */
const PASS_MAX_START = 5000;

/** A preset's tornado params. */
function presetParams(id: string): TornadoParams {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown preset ${id}`);
  return { ...defaultParams(), ...p.params };
}

/**
 * The pass's params and start point (Spec 13, Spec 09 STR-21's rule carried over). Mature: the
 * preset's V_max and R_max throughout, from the nearest distance (≥ 2·R_max, ≤ R_enter) where
 * every house's roof wind is under LAB_PASS_CALM_MPH, to as far past the block; then calm. Full: the
 * preset's lifecycle, timed so the closest approach falls at the middle of its mature stage.
 */
export function passTrack(w: Extract<LabWind, { kind: "pass" }>, houses: readonly HouseSpec[], terrainIn: TerrainClass | "auto" | Terrain, everyHouse: readonly HouseSpec[] = houses): { params: TornadoParams; start: { x: number; z: number }; startDistance: number } {
  // The track's params keep the setting; the calm test reads the terrain itself (a field for "auto").
  const terrain: Terrain = terrainIn === "auto" ? "open" : terrainIn;
  const setting: TerrainClass | "auto" = typeof terrainIn === "string" ? terrainIn : "auto";
  const base = { ...presetParams(w.presetId), ...w.params, heading: w.headingDeg, turnRate: 0, terrain: setting };
  const dir = headingDir(w.headingDeg);
  const right = { x: -dir.z, z: dir.x };
  let cx = 0;
  let cz = 0;
  for (const h of houses) {
    cx += h.x;
    cz += h.z;
  }
  cx /= houses.length;
  cz /= houses.length;
  // Closest point of the track to the block's center.
  const P = { x: cx - right.x * w.offset, z: cz - right.z * w.offset };
  const v = base.translationSpeed;
  if (w.lifecycle === "full") {
    const lead = v * (base.tUp + base.tMature / 2);
    return { params: base, start: { x: P.x - dir.x * lead, z: P.z - dir.z * lead }, startDistance: lead };
  }
  // Calm at every house in the layout (the neighbors too: they reach 130 m nearer the start).
  const roofs = everyHouse.map((h) => ({ x: h.x, y: h.wallHeight + h.roofRise / 2, z: h.z }));
  const calmMs = mphToMs(LAB_PASS_CALM_MPH);
  const state = (d: number) => ({
    center: { x: P.x - dir.x * d, z: P.z - dir.z * d },
    velocity: { x: dir.x * v, z: dir.z * v },
    vMax: base.vPeak,
    rMax: base.rMax,
    alpha: base.alpha,
    outerReach: base.outerReach,
    inflowRatio: base.inflowRatio,
    inflowDepth: base.inflowDepth,
    updraftMax: base.updraftMax,
    overshoot: base.overshoot,
    zPeak: base.zPeak,
    rotation: base.rotation,
  });
  const calm = (d: number) =>
    roofs.every((r) => {
      const u = windAt(r, state(d), terrain);
      return Math.hypot(u.x, u.y, u.z) < calmMs;
    });
  // No detail-zone entry cap: the lab's houses are pinned in the detail set, and a capped start
  // left the neighbors in damaging wind at the first step.
  let d = 2 * base.rMax;
  while (d < PASS_MAX_START && !calm(d)) d = Math.min(d + 10, PASS_MAX_START);
  const params = { ...base, tUp: 0, tMature: (2 * d) / v, tRope: 0 };
  return { params, start: { x: P.x - dir.x * d, z: P.z - dir.z * d }, startDistance: d };
}

/** The def a recorded piece flies with (its own mass and size, its kind's family). */
function recordedDef(kind: DebrisKind, mass: number, dims: [number, number, number]): DebrisKindDef {
  const k = DEBRIS_KINDS[kind];
  const make = k.family === "sheet" ? sheet : k.family === "rod" ? rod : compact;
  return make(k.label, dims[0], dims[1], dims[2], mass);
}

/** A recording's pieces as launches into a receiving frame. */
export function replayLaunches(rec: DebrisRecording, frame: Pick<Building, "x" | "z" | "yaw">): Launch[] {
  const f = frameOf(frame);
  const out: Launch[] = [];
  for (const p of rec.pieces) {
    const from = f.toWorld(p.pos);
    const vel = f.dirToWorld(p.vel);
    if (p.source === "town") {
      const kind = p.kind as DebrisKind;
      out.push({
        t: p.t,
        source: "town",
        kind,
        from,
        vel,
        speed: Math.hypot(vel.x, vel.y, vel.z),
        q: f.qToWorld(p.q),
        represents: p.represents,
        state: {
          def: recordedDef(kind, p.mass, p.dims),
          ...(p.liftRoll !== undefined ? { liftRoll: p.liftRoll } : {}),
          ...(p.spin !== undefined ? { spin: p.spin } : {}),
          ...(p.gust ? { gust: f.dirToWorld(p.gust) } : {}),
          ...(p.stepPhase !== undefined ? { stepPhase: p.stepPhase } : {}),
          ...(p.angVel ? { angVel: f.dirToWorld(p.angVel) } : {}),
          ...(p.steppedTo !== undefined ? { steppedTo: p.steppedTo } : {}),
          ...(p.grounded ? { grounded: true } : {}),
        },
      });
    } else {
      out.push({ t: p.t, source: "detail-same", member: p.kind as MemberKind, from, vel, speed: Math.hypot(vel.x, vel.y, vel.z) });
    }
  }
  return out;
}

/** The recording's wind, placed around a receiving frame as it was around the target. */
export function replayWind(rec: DebrisRecording, frame: Pick<Building, "x" | "z" | "yaw">): LabWind {
  const f = frameOf(frame);
  const yawDeg = frame.yaw / DEG;
  if (rec.wind.kind === "steady") return { kind: "steady", keys: rec.wind.keys.map((k) => ({ ...k, dirDeg: k.dirDeg + yawDeg })) };
  const tr = rec.wind.track;
  const s = f.toWorld({ x: tr.start.x, y: 0, z: tr.start.z });
  return { kind: "track", presetId: rec.wind.presetId, lifecycle: rec.wind.lifecycle, params: { ...tr.params, heading: tr.headingDeg + yawDeg, turnRate: 0 }, start: { x: s.x, z: s.z } };
}

/** Build the lab. */
export async function createLab(setupIn: LabSetup, windIn: LabWind, opts: LabOptions = {}): Promise<Lab> {
  await initRapier();
  const replay = opts.replay;
  // A replay runs with no neighbors: their debris is already in the recording (Spec 13).
  const setup: LabSetup = { ...setupIn, ...(replay ? { surroundings: "open" as const } : {}) };
  const model = setup.model ?? "detail";
  const blockSpecs = labBlockSpecs(setup);
  const ring = setup.surroundings === "neighborhood" ? ringSpecs(setup.seed, blockSpecs, setup.density ?? 1) : [];
  const houses: HouseSpec[] = [...blockSpecs, ...ring];
  // Terrain (Spec 17): the setting; "auto" builds the field from the surroundings (lawn under a
  // neighborhood, farmland around); a replay in its recorded wind keeps the recording's.
  const recorded = replay?.wind === "recorded" ? replay.recording.terrain : undefined;
  const terrain: TerrainClass | "auto" = recorded === undefined ? (setupIn.terrain ?? "auto") : typeof recorded === "string" ? recorded : "auto";
  const cover = layoutCover([...blockSpecs, ...ring], setup.surroundings === "neighborhood");
  const fieldNow = (): Terrain => (terrain === "auto" ? new TownRoughness(cover, houses).field : terrain);
  const block = blockSpecs.map((_, i) => i);
  const ringIdx = ring.map((_, i) => blockSpecs.length + i);

  // The receiving frame for a replay.
  const frameFor = (h: number | "block") => {
    if (h !== "block") return blockSpecs[h]!;
    const yaw = blockSpecs.reduce((a, s) => a + s.yaw, 0) / blockSpecs.length;
    return { x: 0, z: 0, yaw };
  };
  let wind = windIn;
  let replayed: Launch[] = [];
  if (replay) {
    const fr = frameFor(replay.house);
    if (replay.wind === "recorded") wind = replayWind(replay.recording, fr);
    else if (replay.wind === "none") wind = { kind: "steady", keys: [{ t: 0, mph: 0, dirDeg: 0 }] };
    replayed = replayLaunches(replay.recording, fr);
  }

  // Donors (Spec 12): stripped houses beyond the ring, sources for detailed members only.
  const donors: { same?: number; other?: number } = {};
  const wantDonors = setup.donors || replayed.some((l) => l.source !== "town");
  if (wantDonors) {
    // Far out of the scene: launches carry a member to its launch point, so where the donor
    // stands doesn't matter, and nothing should meet its bare slab.
    const off = LAB_LAYOUT.donorDistance;
    const base = { ...blockSpecs[0]!, yaw: 0 };
    delete (base as Partial<HouseSpec>).drawSeed;
    houses.push({ ...base, id: houses.length, x: off, z: 0 });
    donors.same = houses.length - 1;
    houses.push({ ...base, id: houses.length, x: -off, z: 0 });
    donors.other = houses.length - 1;
  }
  houses.forEach((h, i) => (h.id = i));

  const detailSet: NonNullable<SimConfig["detailSet"]>[number][] = [];
  if (model === "detail") for (const i of block) detailSet.push({ index: i, group: "lab" });
  if (donors.same !== undefined) detailSet.push({ index: donors.same, group: "lab", stripped: true });
  if (donors.other !== undefined) detailSet.push({ index: donors.other, group: "lab:other", stripped: true });

  // Wind.
  const keys: WindKey[] = wind.kind === "steady" ? wind.keys.map((k) => ({ ...k })) : [];
  let initial: Partial<TornadoParams> = { terrain };
  let start: { x: number; z: number } | undefined;
  if (wind.kind === "pass") {
    const tr = passTrack(wind, blockSpecs, typeof recorded === "object" ? "open" : fieldNow(), [...blockSpecs, ...ring]);
    initial = { ...tr.params, terrain };
    start = tr.start;
  } else if (wind.kind === "track") {
    // A town recording carries all its params (its preset may be "custom").
    initial = { ...(PRESETS.some((p) => p.id === wind.presetId) ? presetParams(wind.presetId) : defaultParams()), ...wind.params, terrain };
    start = wind.start;
  }

  let lab: Lab;
  let backend: DetailBackend | null = null;
  const launcher = new Launcher(() => lab.sim.world.buildings, block[0]!, donors);
  for (const l of replayed) launcher.add(l);
  const sim = createSim(
    {
      houses,
      cover,
      ...(typeof recorded === "object" ? { terrainAt: seriesTerrain(recorded, frameFor(replay!.house).yaw) } : {}),
      ...(detailSet.length ? { detailSet, detailPinned: true } : {}),
      ...(wind.kind === "steady" ? { tunnel: (t: number) => tunnelFlow(keys, t) } : {}),
      ...(start ? { start } : {}),
      ...(opts.workers ? { heavy: (seed: number, _b: readonly Building[], dt: number) => createWorkerHeavy(seed, dt, houses) } : opts.heavy ? { heavy: opts.heavy } : {}),
      ...(model === "detail" ? { inspect: block } : {}),
      dispersion: setup.dispersion ?? true,
      inject: launcher.inject,
    },
    setup.seed,
    initial,
    detailSet.length ? (s, b) => (backend = opts.workers ? createWorkerBackend(s, b, undefined, houses) : (opts.detail ?? ((_s, bb) => createLocalBackend(bb, 1)))(s, b)) : undefined,
  );
  if (detailSet.length) sim.setDetailFocus({ x: 0, z: 0 });

  // Aimed launches arrive at their aim in the wind blowing now (frozen over the short flight).
  launcher.wind = (p) => windAt(p, sim.snapshot.tornado, sim.snapshot.terrain);
  const debrisDt = SIM_DEFAULTS.dt * DEBRIS.stepInterval;
  const launchPos = (l: Launched): Vec3 | null => l.piece?.pos ?? null;
  const recorder = new RunRecorder(sim, block[0]!, () => launcher.launched, launchPos, { passThrough: opts.passThrough ?? true });

  // Stream (Spec 13): pieces from upwind at a rate, seeded.
  let streamSpec: StreamSpec | null = null;
  const streamRng = createRng(setup.seed ^ 0x51a7e3);
  let streamAcc = 0;
  const streamStep = (time: number) => {
    const s = streamSpec;
    if (!s) return;
    streamAcc += s.rate * debrisDt;
    const house = s.house ?? block[0]!;
    const b = sim.world.buildings[house]!;
    const st = sim.snapshot.tornado;
    while (streamAcc >= 1) {
      streamAcc -= 1;
      const roof = windAt({ x: b.x, y: b.roofHeight, z: b.z }, st, sim.snapshot.terrain);
      const wl = Math.hypot(roof.x, roof.z);
      const wd = wl > 1e-6 ? { x: roof.x / wl, z: roof.z / wl } : { x: 1, z: 0 };
      let face: number;
      if (s.face === undefined || s.face === "windward") {
        // The face the wind blows onto: outward normal most against the wind (house-local).
        const lw = frameOf(b).dirToLocal({ x: wd.x, y: 0, z: wd.z });
        face = 0;
        let best = Infinity;
        LOCAL_NORMALS.forEach((n, k) => {
          const d = n.x * lw.x + n.z * lw.z;
          if (d < best) (best = d), (face = k);
        });
      } else face = s.face;
      const n = LOCAL_NORMALS[face]!;
      const t = faceTangent(face);
      const len = face % 2 === 0 ? b.depth : b.width;
      const halfN = face % 2 === 0 ? b.width / 2 : b.depth / 2;
      const u = (streamRng() - 0.5) * len * 0.9;
      const y = IMPACT.slabTop + 0.3 + streamRng() * (b.wallHeight - 0.6);
      const aim = toWorldPt(b, { x: n.x * halfN + t.x * u, y, z: n.z * halfN + t.z * u });
      const [h0, h1] = LAB_LAUNCH.streamHeight;
      const from = { x: aim.x - wd.x * LAB_LAUNCH.streamUpwind, y: h0 + streamRng() * (h1 - h0), z: aim.z - wd.z * LAB_LAUNCH.streamUpwind };
      const w = windAt(from, st, sim.snapshot.terrain);
      const speed = s.speed ?? Math.max(1, Math.hypot(w.x, w.y, w.z));
      launcher.add({ t: time + debrisDt, source: "town", kind: s.kind, from, dir: { x: aim.x - from.x, y: aim.y - from.y, z: aim.z - from.z }, speed });
    }
  };
  const detachStream = sim.observe({ debrisStep: streamStep });

  const nextT = () => sim.time + 1e-9;
  const memberUsed = new Map<MemberKind, number>();
  let donorFraming: ReturnType<typeof buildFraming> | null = null;
  let want = 0;
  let done = 0;
  lab = {
    sim,
    setup,
    wind,
    terrain: typeof recorded === "object" ? "recorded" : terrain,
    block,
    ring: ringIdx,
    donors,
    launcher,
    keys,
    setSteady(mph, dirDeg, o = {}) {
      if (wind.kind !== "steady") throw new Error("setSteady needs steady wind");
      const t = sim.time;
      const now = tunnelFlow(keys, t);
      // Future keys are replaced; the change starts from what blows now.
      while (keys.length && keys[keys.length - 1]!.t > t) keys.pop();
      keys.push({ t, mph: now.u10 / mphToMs(1), dirDeg: now.dirDeg, w: now.w, deficit: now.deficit });
      keys.push({ t: t + Math.max(o.rampS ?? 0, SIM_DEFAULTS.dt), mph, dirDeg, w: o.w ?? 0 });
    },
    launch(l) {
      return launcher.add({ ...l, t: l.t ?? nextT() } as Launch);
    },
    fireMissile(id, house, aim, o = {}) {
      const m = REFERENCE_MISSILES.find((x) => x.id === id);
      if (!m) throw new Error(`unknown missile ${id}`);
      const t = o.t ?? nextT();
      const state = { def: m.def };
      if (m.vertical) {
        // Straight down onto the roof: at the aimed point, or the ridge's middle.
        const b = sim.world.buildings[house]!;
        const local = "point" in aim ? aim.point : { x: 0, y: IMPACT.slabTop + b.wallHeight + b.roofRise, z: 0 };
        const p = toWorldPt(b, local);
        return launcher.add({ t, source: "town", kind: m.kind, label: m.name, house, aim: { point: local }, from: { x: p.x, y: p.y + LAB_LAUNCH.standoff, z: p.z }, speed: m.speed, state, arrive: true });
      }
      const from = "point" in aim ? standoffFrom(sim.world.buildings[house]!, aim.point) : undefined;
      return launcher.add({ t, source: "town", kind: m.kind, label: m.name, house, aim, ...(from ? { from } : {}), standoff: LAB_LAUNCH.standoff, speed: m.speed, state, arrive: true });
    },
    fireMember(kind, house, aim, speed, o = {}) {
      if (donors.same === undefined) throw new Error("no donor house: build the lab with donors");
      const left = lab.membersLeft(kind);
      if (left <= 0) throw new Error(`the donor has no ${kind} left`);
      const nth = (memberUsed.get(kind) ?? 0);
      memberUsed.set(kind, nth + 1);
      // Real members aren't steered to arrive (they fly in the rigid-body physics): from closer in,
      // as the wind tunnel fires them, so a broadside panel's drag doesn't bring it down short.
      const from = "point" in aim ? standoffFrom(sim.world.buildings[house]!, aim.point, LAB_LAUNCH.memberStandoff) : undefined;
      return launcher.add({ t: o.t ?? nextT(), source: "detail-same", member: kind, nth, house, aim, ...(from ? { from } : {}), standoff: LAB_LAUNCH.memberStandoff, speed });
    },
    membersLeft(kind) {
      if (donors.same === undefined) return 0;
      donorFraming ??= buildFraming(sim.world.buildings[donors.same]!);
      return donorFraming.members.filter((m) => m.kind === kind).length - (memberUsed.get(kind) ?? 0);
    },
    stream(s) {
      streamSpec = s;
      streamAcc = 0;
    },
    get streaming() {
      return streamSpec;
    },
    memberInfo(house, member) {
      const h = sim.detail.houses.get(house);
      if (!h) return null;
      const m = h.framing.members[member];
      if (!m) return null;
      const ins = sim.detail.inspection.get(house);
      const failed = sim.detail.failedAt.get(house);
      const attached = (id: number) => (ins ? ins.attached[id] === 1 : true);
      const connections: ConnectionInfo[] = h.framing.supportsOf[member]!.map((c) => {
        const con = h.framing.connections[c]!;
        const load = ins ? ins.loads[c]! : 0;
        const f = failed?.get(c) ?? null;
        const intact = !f && attached(con.from) && (con.to < 0 || attached(con.to));
        return { id: c, label: con.label, to: con.to, toKind: con.to < 0 ? "slab" : h.framing.members[con.to]!.kind, capacity: con.capacity, load, utilization: con.capacity > 0 ? load / con.capacity : 0, intact, failed: f };
      });
      return {
        house,
        member,
        kind: m.kind,
        mass: m.mass,
        attached: attached(member),
        step: ins?.n ?? -1,
        connections,
        utilization: Math.max(0, ...connections.filter((c) => c.intact).map((c) => c.utilization)),
      };
    },
    record() {
      return recorder.snapshot(`lab ${setup.houses}×${model} ${wind.kind}`, setup.seed);
    },
    recordDebris(house) {
      const b = sim.world.buildings[house]!;
      const f = frameOf(b);
      let w: DebrisRecording["wind"];
      if (wind.kind === "steady") w = { kind: "steady", keys: keys.map((k) => ({ ...k, dirDeg: k.dirDeg - b.yaw / DEG })) };
      else {
        const p = sim.params;
        // Where the tornado was at time 0: its start point.
        const s0 = start!;
        const l = f.toLocal({ x: s0.x, y: 0, z: s0.z });
        w = { kind: "pass", presetId: wind.presetId, lifecycle: wind.lifecycle, track: { start: { x: l.x, z: l.z }, headingDeg: p.heading - b.yaw / DEG, params: { ...p } } };
      }
      return recordDebrisAt(sim, house, w, { seed: setup.seed, dispersion: setup.dispersion ?? true });
    },
    advance(seconds) {
      want += seconds;
      const n = Math.floor(want * 60 + 1e-6);
      while (done < n) {
        sim.advance(1 / 60);
        done++;
      }
    },
    dispose() {
      detachStream();
      recorder.stop("", 0);
      sim.dispose();
    },
  };
  return lab;
}

/**
 * Where a shot at a house-local point starts: the launch stand-off out along the surface's
 * outward normal there (the roof slope's above the eaves, else the nearest wall's), so it comes
 * in square to the surface, as test missiles do.
 */
export function standoffFrom(b: Building, l: Vec3, d: number = LAB_LAUNCH.standoff): Vec3 {
  const eave = IMPACT.slabTop + b.wallHeight;
  let n: Vec3;
  if (l.y > eave && Math.abs(l.x) <= b.width / 2 + 1) {
    const pitch = Math.atan2(b.roofRise, b.depth / 2);
    n = { x: 0, y: Math.cos(pitch), z: (l.z < 0 ? -1 : 1) * Math.sin(pitch) };
  } else {
    const gaps = [b.width / 2 - l.x, b.depth / 2 - l.z, b.width / 2 + l.x, b.depth / 2 + l.z];
    const abs = gaps.map(Math.abs);
    const f = LOCAL_NORMALS[abs.indexOf(Math.min(...abs))]!;
    n = { x: f.x, y: 0, z: f.z };
  }
  return toWorldPt(b, { x: l.x + n.x * d, y: l.y + n.y * d, z: l.z + n.z * d });
}

/** Roof-height wind (m/s) at a house now. */
export function roofWind(sim: Sim, b: Building): number {
  const w = windAt({ x: b.x, y: b.roofHeight, z: b.z }, sim.snapshot.tornado, sim.snapshot.terrain);
  return Math.hypot(w.x, w.y, w.z);
}

