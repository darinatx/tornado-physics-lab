/**
 * Detail vs component alignment (Spec 09, STR-31): the same small patch of houses, passed by the
 * same mature tornado, once on the component model and once in the detail zone. Per house: peak
 * wind, DOD, exterior wall still standing, roof still on, and the share of the house's material
 * lying within 5 m of its footprint.
 *
 * Fast by construction: only the houses within `radius` of the patch center exist (SIM-10), the
 * tornado is mature from the first step (tUp = 0) and starts just outside the distance where it
 * can damage anything in the patch.
 */
import { AREAL_MASS } from "../../src/config/buildings";
import { PRESETS } from "../../src/config/presets";
import type { Building } from "../../src/core/damage/types";
import { windAt } from "../../src/core/wind/windField";
import type { TornadoState } from "../../src/core/wind/types";
import { createLocalBackend } from "../../src/sim/detailBackend";
import { detailOptions } from "../../src/sim/detailZone";
import { createSim } from "../../src/sim/loop";
import type { Sim } from "../../src/sim/loop";
import { initRapier } from "../../src/sim/structureWorld";
import type { TornadoParams } from "../../src/sim/types";

export interface PatchSpec {
  /** Patch center (m) and radius (m): the houses whose centers lie within it. */
  x: number;
  z: number;
  radius: number;
  /** Only houses within this distance of the center are compared and detailed (default: all);
   *  the rest are town houses whose debris reaches them (m). */
  compare?: number;
  /** The track passes this far to the left of the patch center (m): positive puts the patch
   *  on the track's right, where translation adds to the rotation. */
  offset: number;
  /** Track heading (deg, 0 = +X, counter-clockwise from above). */
  heading?: number;
  seed?: number;
  preset?: string;
}

export interface HouseLook {
  id: number;
  cls: string;
  /** Peak roof-height wind (mph). */
  peak: number;
  dod: number;
  /** Exterior wall standing, roof on, material within 5 m (fractions 0–1). */
  wall: number;
  roof: number;
  near: number;
}

export interface PatchRun {
  houses: HouseLook[];
  simS: number;
  wallS: number;
}

/** Wind below this can't fail anything (Spec 09 calm skip is 55 mph); the pass starts there. */
const QUIET_MS = 22;

export function patchTornado(spec: PatchSpec): { p: TornadoParams; start: { x: number; z: number }; end: number } {
  const preset = PRESETS.find((q) => q.id === (spec.preset ?? "ef4-wedge"))!;
  const base = createSim({ buildings: false }).params;
  const heading = spec.heading ?? 60;
  const a = (heading * Math.PI) / 180;
  const d = { x: Math.cos(a), z: -Math.sin(a) };
  const right = { x: -d.z, z: d.x };
  // The track's closest point to the patch center.
  const q = { x: spec.x - right.x * spec.offset, z: spec.z - right.z * spec.offset };
  const p: TornadoParams = { ...base, ...preset.params, heading, turnRate: 0, tUp: 0, tRope: 0, tMature: 1e6 };
  // Start where the wind over the whole patch is quiet: step back along the track until the
  // strongest roof-height wind at its edge nearest the track is under QUIET_MS.
  const state = (cx: number, cz: number): TornadoState => ({
    center: { x: cx, z: cz },
    velocity: { x: d.x * p.translationSpeed, z: d.z * p.translationSpeed },
    vMax: p.vPeak, rMax: p.rMax, alpha: p.alpha, inflowRatio: p.inflowRatio, inflowDepth: p.inflowDepth,
    updraftMax: p.updraftMax, overshoot: p.overshoot, zPeak: p.zPeak, rotation: p.rotation,
  });
  let back = 2 * p.rMax;
  for (; back < 5000; back += 25) {
    const s = state(q.x - d.x * back, q.z - d.z * back);
    let worst = 0;
    for (const [ox, oz] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const w = windAt({ x: spec.x + ox * spec.radius, y: 4, z: spec.z + oz * spec.radius }, s, p.terrain === "auto" ? "open" : p.terrain);
      worst = Math.max(worst, Math.hypot(w.x, w.y, w.z));
    }
    if (worst < QUIET_MS) break;
  }
  // As far past the patch as it started before it, then a few seconds to settle.
  const end = (2 * back) / p.translationSpeed + 8;
  return { p, start: { x: q.x - d.x * back, z: q.z - d.z * back }, end };
}

function nearFootprint(b: Building, px: number, pz: number, margin: number): boolean {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const dx = px - b.x;
  const dz = pz - b.z;
  return Math.abs(dx * c - dz * s) <= b.width / 2 + margin && Math.abs(dx * s + dz * c) <= b.depth / 2 + margin;
}

function componentLook(sim: Sim, i: number): Omit<HouseLook, "id" | "cls" | "peak"> {
  const b = sim.world.buildings[i]!;
  const H = b.wallHeight;
  const wallTotal = b.panels.reduce((a, p) => a + p.len * H, 0);
  const wallUp = b.panels.reduce((a, p) => a + (p.failed ? 0 : p.len * H), 0);
  const roofTotal = b.sections.reduce((a, s) => a + s.area, 0);
  const roofUp = b.sections.reduce((a, s) => a + (s.deck || b.bays[s.col]!.failed ? 0 : s.area), 0);
  const standing = wallUp * AREAL_MASS.wallPanel + roofUp * AREAL_MASS.roofPanel;
  const failed = sim.debris.massBySource.get(b.id) ?? 0;
  let near = standing;
  for (const p of [...sim.debris.settled, ...sim.debris.pieces]) {
    if (p.hidden || p.sourceId !== b.id) continue;
    if (nearFootprint(b, p.pos.x, p.pos.z, 5)) near += p.def.mass * p.represents;
  }
  return { dod: b.dod, wall: wallUp / wallTotal, roof: roofUp / roofTotal, near: near / Math.max(standing + failed, 1e-9) };
}

function detailLook(sim: Sim, i: number): Omit<HouseLook, "id" | "cls" | "peak"> | null {
  const h = sim.detail.houses.get(i);
  if (!h) return null;
  const b = sim.world.buildings[i]!;
  const stamps = sim.detail.stamps.get(i)!;
  let wallT = 0, wallU = 0, roofT = 0, roofU = 0, massT = 0, massN = 0;
  h.framing.members.forEach((m, k) => {
    const moved = stamps[k]! > 0;
    const o = k * 7;
    massT += m.mass;
    if (!moved || (h.poses[o + 1]! > -1000 && nearFootprint(b, h.poses[o]!, h.poses[o + 2]!, 5))) massN += m.mass;
    if (m.kind === "wallFrame") {
      wallT += m.area || 1;
      if (!moved) wallU += m.area || 1;
    }
    if (m.kind === "roofSheet") {
      roofT += m.area || 1;
      if (!moved) roofU += m.area || 1;
    }
  });
  return { dod: b.dod, wall: wallU / wallT, roof: roofU / roofT, near: massN / massT };
}

/** How many houses lie within the compared radius (the detail zone's size). */
function countInner(spec: PatchSpec): number {
  const sim = createSim({ area: { x: spec.x, z: spec.z, radius: spec.radius } }, spec.seed ?? 1);
  return sim.world.buildings.filter((b) => Math.hypot(b.x - spec.x, b.z - spec.z) <= spec.compare!).length;
}

/** Run one patch on one model. */
export async function runPatch(spec: PatchSpec, detail: boolean, opts: { soloWorlds?: boolean; engines?: number } = {}): Promise<PatchRun> {
  const t0 = performance.now();
  const { p, start, end } = patchTornado(spec);
  await initRapier();
  detailOptions.worldPerHouse = !!opts.soloWorlds;
  const inner = (b: { x: number; z: number }) => Math.hypot(b.x - spec.x, b.z - spec.z) <= (spec.compare ?? Infinity);
  const sim = createSim(
    { area: { x: spec.x, z: spec.z, radius: spec.radius }, start, ...(spec.compare ? { detailHouses: countInner(spec) } : {}) },
    spec.seed ?? 1,
    p,
    detail ? (_s, b) => createLocalBackend(b, opts.engines ?? 2) : undefined,
  );
  if (detail) sim.setDetailFocus({ x: spec.x, z: spec.z });
  let last = performance.now();
  while (sim.time < end) {
    sim.advance(0.25);
    if (performance.now() - last > 1000) {
      await new Promise((r) => setImmediate(r));
      last = performance.now();
    }
  }
  detailOptions.worldPerHouse = false;
  const houses = sim.world.buildings.flatMap((b, i) => {
    if (!inner(b)) return [];
    const look = detail ? detailLook(sim, i) ?? componentLook(sim, i) : componentLook(sim, i);
    return [{ id: b.id, cls: b.cls, peak: Math.round(b.peakMph), ...look }];
  });
  return { houses, simS: sim.time, wallS: (performance.now() - t0) / 1000 };
}

export interface Paired {
  id: number;
  cls: string;
  peak: number;
  detail: HouseLook;
  component: HouseLook;
}

/** The same patch on both models, matched house by house (peak wind from the component run). */
export async function runPaired(spec: PatchSpec, opts: { soloWorlds?: boolean; engines?: number } = {}): Promise<Paired[]> {
  const c = await runPatch(spec, false);
  const d = await runPatch(spec, true, opts);
  return c.houses.map((h, k) => ({ id: h.id, cls: h.cls, peak: h.peak, component: h, detail: d.houses[k]! }));
}

export const BANDS = [
  { label: "< 110 mph", lo: 0, hi: 110 },
  { label: "110–150 mph", lo: 110, hi: 150 },
  { label: "≥ 150 mph", lo: 150, hi: Infinity },
] as const;

export interface BandSummary {
  label: string;
  n: number;
  /** Medians, detail and component. */
  dod: [number, number];
  wall: [number, number];
  roof: [number, number];
  near: [number, number];
}

const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function summarize(rows: readonly Paired[]): BandSummary[] {
  return BANDS.map((b) => {
    const r = rows.filter((x) => x.peak >= b.lo && x.peak < b.hi);
    const pair = (f: (h: HouseLook) => number): [number, number] => [median(r.map((x) => f(x.detail))), median(r.map((x) => f(x.component)))];
    return { label: b.label, n: r.length, dod: pair((h) => h.dod), wall: pair((h) => h.wall), roof: pair((h) => h.roof), near: pair((h) => h.near) };
  });
}

/** Patches that together cover the three wind bands with the EF4 preset (R_max 300 m). */
/** Houses out to 130 m exist (their debris reaches the compared ones, as in town: with nothing
 *  upwind, no debris breaks windward windows, and detailed houses stall); only those within
 *  60 m are compared and detailed. */
export const ALIGNMENT_PATCHES: PatchSpec[] = [
  { x: 0, z: 20, radius: 130, compare: 60, offset: 0 },
  { x: 0, z: 20, radius: 130, compare: 60, offset: 260 },
  { x: 0, z: 20, radius: 130, compare: 60, offset: 420 },
];
