/**
 * The town's roughness field (Spec 17): built from the ground cover and the buildings, and
 * updated at fixed sim times as buildings lose height.
 */
import { TERRAIN } from "../config/terrain";
import { RoughnessBuilder } from "../core/terrain/roughness";
import type { GroundCover, Obstacle, RoughnessField } from "../core/terrain/roughness";
import type { Building, HouseSpec } from "../core/damage/types";

/** What a house adds to the roughness as it stands now (Spec 17). A detailed house reads its stand-in. */
export function obstacleOf(bIn: Building | HouseSpec): Obstacle {
  const footprint = bIn.width * bIn.depth;
  const fullH = bIn.wallHeight + bIn.roofRise / 2;
  // Mean projected width of a w × d rectangle over all wind directions: (2/π)(w + d).
  const projW = (2 / Math.PI) * (bIn.width + bIn.depth);
  // A spec (not yet built) stands intact.
  if (!("panels" in bIn)) return { x: bIn.x, z: bIn.z, footprint, frontal: projW * fullH, height: fullH, rubble: 0 };
  const b = bIn.detail && bIn.standIn ? bIn.standIn : bIn;
  if (b.sweep.failed) return { x: bIn.x, z: bIn.z, footprint: 0, frontal: 0, height: 0, rubble: 0 };
  let wl = 0;
  let wUp = 0;
  for (const p of b.panels) {
    wl += p.len;
    if (!p.failed) wUp += p.len;
  }
  let ra = 0;
  let rUp = 0;
  for (const s of b.sections) {
    ra += s.area;
    if (!s.deck && !b.bays[s.col]!.failed) rUp += s.area;
  }
  const fw = wl > 0 ? wUp / wl : 0;
  const fr = ra > 0 ? rUp / ra : 0;
  const h = fw * b.wallHeight + fr * (b.roofRise / 2);
  const s = Math.min(1, h / fullH);
  if (h < TERRAIN.rubbleHeight) {
    // Down to rubble: a low pile over the whole slab.
    return { x: bIn.x, z: bIn.z, footprint, frontal: projW * TERRAIN.rubbleHeight, height: TERRAIN.rubbleHeight, rubble: footprint };
  }
  return { x: bIn.x, z: bIn.z, footprint: footprint * s, frontal: projW * h, height: h, rubble: footprint * (1 - s) };
}

/** The neighborhood's cover (Spec 05): lawn over the town's square, farmland around it. */
export function townCover(extent: number): GroundCover {
  const h = extent / 2;
  return { base: "farmland", rects: [{ x0: -h, z0: -h, x1: h, z1: h, kind: "lawn" }] };
}

/** Cover for an explicit layout (Spec 13): lawn over the houses' area (plus a lot), or none. */
export function layoutCover(buildings: readonly { x: number; z: number }[], lawn: boolean, pad = 25): GroundCover {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const b of buildings) {
    x0 = Math.min(x0, b.x);
    z0 = Math.min(z0, b.z);
    x1 = Math.max(x1, b.x);
    z1 = Math.max(z1, b.z);
  }
  if (!buildings.length) x0 = z0 = x1 = z1 = 0;
  const bounds = { x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad };
  return { base: "farmland", rects: lawn && buildings.length ? [{ ...bounds, kind: "lawn" }] : [], bounds };
}

/** A building's damage revision (its stand-in's when detailed); −1 for a spec. */
const revOf = (b: Building | HouseSpec): number => ("panels" in b ? (b.detail && b.standIn ? -2 - b.standIn.rev : b.rev) : -1);

const same = (a: Obstacle, b: Obstacle) => a.footprint === b.footprint && a.frontal === b.frontal && a.height === b.height && a.rubble === b.rubble;

export class TownRoughness {
  private readonly builder: RoughnessBuilder;
  private readonly obstacles: (Obstacle | null)[];
  /** Each building's damage revision when last read (−1: a spec, never changes). */
  private readonly revs: number[];
  readonly cover: GroundCover;

  constructor(cover: GroundCover, buildings: readonly (Building | HouseSpec)[]) {
    this.cover = cover;
    let bx = cover.bounds;
    if (!bx) {
      bx = { x0: 0, z0: 0, x1: 0, z1: 0 };
      for (const r of cover.rects) bx = { x0: Math.min(bx.x0, r.x0), z0: Math.min(bx.z0, r.z0), x1: Math.max(bx.x1, r.x1), z1: Math.max(bx.z1, r.z1) };
      for (const b of buildings) bx = { x0: Math.min(bx.x0, b.x), z0: Math.min(bx.z0, b.z), x1: Math.max(bx.x1, b.x), z1: Math.max(bx.z1, b.z) };
    }
    this.builder = new RoughnessBuilder(cover, bx);
    this.revs = buildings.map(revOf);
    this.obstacles = buildings.map((b) => {
      const o = obstacleOf(b);
      this.builder.apply(o, 1);
      return o;
    });
    this.builder.rebuild();
  }

  get field(): RoughnessField {
    return this.builder.field;
  }

  /** Re-read every building; rebuild if any changed. Returns whether the field changed. */
  update(buildings: readonly (Building | HouseSpec)[]): boolean {
    let changed = false;
    buildings.forEach((b, i) => {
      const rev = revOf(b);
      if (rev === this.revs[i]) return;
      this.revs[i] = rev;
      const o = obstacleOf(b);
      const old = this.obstacles[i];
      if (old && same(old, o)) return;
      if (old) this.builder.apply(old, -1);
      this.builder.apply(o, 1);
      this.obstacles[i] = o;
      changed = true;
    });
    if (changed) this.builder.rebuild();
    return changed;
  }
}
