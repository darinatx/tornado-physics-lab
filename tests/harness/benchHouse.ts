/**
 * Test bench for the structure world (Spec 09): member-level houses in one shared structure
 * world under steady straight-line wind, stepped directly. Not the lab (Spec 13 runs the lab
 * on the real sim); the unit tests use it to drive the structure world on its own.
 */
import type { Building } from "../../src/core/damage/types";
import type { Vec3 } from "../../src/core/math/vec";
import { PRESETS } from "../../src/config/presets";
import { DETAIL, LAB } from "../../src/config/structure";
import type { ConstructionClass } from "../../src/config/buildings";
import { createHouse } from "../../src/core/damage/building";
import { randomHouseSpec } from "../../src/sim/city";
import { createRng } from "../../src/sim/rng";
import { mphToMs } from "../../src/core/wind/efScale";
import { pressureDeficit } from "../../src/core/wind/pressure";
import type { TornadoState } from "../../src/core/wind/types";
import { envFactor, windAt } from "../../src/core/wind/windField";
import { defaultParams } from "../../src/sim/types";
import { DetailHouse, initRapier, STRUCT_DT, StructureWorld } from "../../src/sim/structureWorld";
import type { MemberPose, StructureFailure, WindSource } from "../../src/sim/structureWorld";

export { initRapier };
export type { MemberPose };
export type LabFailure = StructureFailure;

/** A tornado pass across the lab house (Spec 09, STR-21). */
export interface LabPass {
  presetId: string;
  /** Direction of travel (deg, 0 = +X, counter-clockwise from above). */
  headingDeg: number;
  /** House's distance to the right of the track (m); negative = left. */
  offset: number;
  /** Along-track start distance before the house (m); default: where roof wind is calm. */
  startDistance?: number;
}

/** Lab seed: the same block every time. */
const LAB_SEED = 3;

/** The lab's block of n houses (STR-23): a centered grid of ⌈√n⌉ columns at lot spacing. */
export function labHouses(n: number, cls: ConstructionClass): Building[] {
  const rng = createRng(LAB_SEED);
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const out: Building[] = [];
  for (let i = 0; i < n; i++) {
    const x = ((i % cols) - (cols - 1) / 2) * LAB.lotSpacing;
    const z = (Math.floor(i / cols) - (rows - 1) / 2) * LAB.lotSpacing;
    const spec = { ...randomHouseSpec(i, rng, x, z, 0, cls), width: 14, depth: 11, wallHeight: 3, roofRise: 2 };
    out.push(createHouse(spec, rng));
  }
  return out;
}

/** Roof-height wind below which the pass may start (m/s): nothing can fail there. */
const PASS_CALM = mphToMs(50);
const PASS_SEARCH_STEP = 10; // m

export class BenchHouse {
  readonly sw: StructureWorld;
  readonly house: DetailHouse;
  windMph = 0;
  windDirDeg = 0;
  /** The pass's tornado now, or null for steady wind / once the pass is over. */
  tornado: TornadoState | null = null;
  /** A tornado pass ran and is over. */
  passDone = false;
  private passEnd = 0;
  private passSteps = 0;
  /** What the house feels: the tornado during a pass, otherwise the steady wind. */
  readonly wind: WindSource = {
    at: (p) => (this.tornado ? windAt(p, this.tornado, "open") : this.passDone ? { x: 0, y: 0, z: 0 } : this.windAtHeight(p.y)),
    deficit: (x, z) =>
      this.tornado ? pressureDeficit(Math.hypot(x - this.tornado.center.x, z - this.tornado.center.z), this.tornado) : 0,
  };

  /** Every house; `house` and `building` are the first (single-house use). */
  readonly houses: DetailHouse[];
  readonly building: Building;

  constructor(buildings: Building | readonly Building[]) {
    const list = Array.isArray(buildings) ? (buildings as readonly Building[]) : [buildings as Building];
    this.sw = new StructureWorld();
    this.houses = list.map((b) => this.sw.addHouse(b));
    this.house = this.houses[0]!;
    this.building = list[0]!;
  }

  /** Center of the block (m). */
  get blockCenter(): { x: number; z: number } {
    let x = 0;
    let z = 0;
    for (const h of this.houses) {
      x += h.building.x;
      z += h.building.z;
    }
    return { x: x / this.houses.length, z: z / this.houses.length };
  }

  get framing() {
    return this.house.framing;
  }
  get intact() {
    return this.house.intact;
  }
  get failures() {
    return this.house.failures;
  }
  get lost() {
    return this.house.lost;
  }
  get lostMembers() {
    return this.house.lostMembers;
  }
  get lostWhy() {
    return this.house.lostWhy;
  }
  get time() {
    return this.sw.time;
  }
  get movingGroups() {
    return this.house.movingGroups;
  }
  get bodyCount() {
    return this.house.groupBodies.size;
  }

  setWind(mph: number, dirDeg: number): void {
    this.windMph = mph;
    this.windDirDeg = dirDeg;
  }

  /** Send a preset tornado across the house at mature strength (STR-21). */
  startTornado(pass: LabPass): void {
    const preset = PRESETS.find((p) => p.id === pass.presetId);
    if (!preset) throw new Error(`unknown preset ${pass.presetId}`);
    const par = { ...defaultParams(), ...preset.params };
    const a = (pass.headingDeg * Math.PI) / 180;
    const dir = { x: Math.cos(a), z: -Math.sin(a) };
    const right = { x: -dir.z, z: dir.x };
    const c = this.blockCenter;
    const state = (d: number): TornadoState => ({
      center: { x: c.x - right.x * pass.offset - dir.x * d, z: c.z - right.z * pass.offset - dir.z * d },
      velocity: { x: dir.x * par.translationSpeed, z: dir.z * par.translationSpeed },
      vMax: par.vPeak,
      rMax: par.rMax,
      alpha: par.alpha,
      inflowRatio: par.inflowRatio,
      inflowDepth: par.inflowDepth,
      updraftMax: par.updraftMax,
      overshoot: par.overshoot,
      zPeak: par.zPeak,
      rotation: par.rotation,
    });
    let d = pass.startDistance;
    if (d === undefined) {
      // Nearest distance (≥ 2·R_max) where every house's roof wind is calm.
      const roofs = this.houses.map((h) => ({ x: h.building.x, y: h.building.roofHeight, z: h.building.z }));
      const calm = (dd: number) => {
        const st = state(dd);
        return roofs.every((r) => {
          const w = windAt(r, st, "open");
          return Math.hypot(w.x, w.y, w.z) < PASS_CALM;
        });
      };
      // Capped at the detail zone's entry distance (Spec 09 slice B).
      const cap = DETAIL.enterRmax * par.rMax + DETAIL.enterLeadS * par.translationSpeed;
      d = 2 * par.rMax;
      while (d < cap && !calm(d)) d = Math.min(d + PASS_SEARCH_STEP, cap);
    }
    this.tornado = state(d);
    // Houses have stood in the far field as it built up: inside pressure equals outside.
    for (const h of this.houses) h.deficitIn = this.wind.deficit(h.building.x, h.building.z);
    this.passEnd = 2 * d;
    this.passSteps = 0;
    this.passDone = false;
  }

  /** Stop a pass now (back to steady wind). */
  stopTornado(): void {
    this.tornado = null;
    this.passDone = false;
  }

  /** Ground-relative wind at height y (m/s), steady with the terrain profile. */
  windAtHeight(y: number): Vec3 {
    const u = mphToMs(this.windMph) * envFactor(Math.max(y, 0.1), "open");
    const a = (this.windDirDeg * Math.PI) / 180;
    return { x: u * Math.cos(a), y: 0, z: -u * Math.sin(a) };
  }

  memberPose(id: number): MemberPose {
    return this.house.memberPose(id);
  }

  isAttached(id: number): boolean {
    return this.house.isAttached(id);
  }

  step(): void {
    this.sw.step(this.wind);
    const s = this.tornado;
    if (!s) return;
    const v = Math.hypot(s.velocity.x, s.velocity.z);
    this.passSteps++;
    if (this.passSteps * v * STRUCT_DT >= this.passEnd - 1e-9) {
      this.tornado = null;
      this.passDone = true;
      return;
    }
    this.tornado = { ...s, center: { x: s.center.x + s.velocity.x * STRUCT_DT, z: s.center.z + s.velocity.z * STRUCT_DT } };
  }

  dispose(): void {
    this.sw.dispose();
  }
}

export const LAB_DT = STRUCT_DT;
