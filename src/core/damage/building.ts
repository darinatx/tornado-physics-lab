/**
 * House damage model (Spec 03): fragility-sampled capacities, permanent failures, cascades,
 * DOD and EF estimate.
 */
import {
  BASE_CAPACITY,
  CLASS_FACTORS,
  CLASS_LABEL,
  DI2_DODS,
  FRAGILITY,
  PARTS,
  PART_DOD,
  PART_LABEL,
  ROOF_BRACING_FACTOR,
} from "../../config/buildings";
import type { Part } from "../../config/buildings";
import { MS_PER_MPH } from "../../config/units";
import type { Vec3 } from "../math/vec";
import { efRating, mphToMs } from "../wind/efScale";
import type { EFRating } from "../wind/efScale";
import { computeLoads, updateApc } from "./loads";
import type { Building, FailureRecord, HouseSpec } from "./types";

type SinglePart = Exclude<Part, "windows">;

/** Standard normal via Box–Muller from a seeded uniform RNG. */
function normal(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function lognormal(rng: () => number, beta: number): number {
  return Math.exp(beta * normal(rng));
}

export function createHouse(
  spec: HouseSpec,
  rng: () => number,
  base: Record<Part, number> = BASE_CAPACITY,
): Building {
  const quality = lognormal(rng, FRAGILITY.houseQuality);
  const factors = CLASS_FACTORS[spec.cls];
  const cap = (p: Part) => base[p] * (factors[p] ?? 1) * quality * lognormal(rng, FRAGILITY.partScatter);
  const capacity = {} as Record<SinglePart, number>;
  for (const p of PARTS) if (p !== "windows") capacity[p] = cap(p);
  const windowCapacity = [0, 1, 2, 3].map(() => cap("windows"));
  return {
    ...spec,
    roofHeight: spec.wallHeight + spec.roofRise / 2,
    capacity,
    windowCapacity,
    failed: {},
    windowFailed: [null, null, null, null],
    deficitIn: 0,
    peakMph: 0,
    dod: 0,
    shift: null,
  };
}

export function degreeOfDamage(b: Building): number {
  let dod = b.windowFailed.some((w) => w !== null) ? PART_DOD.windows : 0;
  for (const p of Object.keys(b.failed) as SinglePart[]) dod = Math.max(dod, PART_DOD[p]);
  return dod;
}

/**
 * Advance one damage evaluation. `wind` is the ground-relative wind at roof height (m/s),
 * `deficitOut` the tornado's pressure deficit at the house (Pa). Returns true if anything failed.
 */
export function updateBuilding(b: Building, wind: Vec3, deficitOut: number, dt: number, time: number): boolean {
  if (b.failed.slab) return false;
  const ms = Math.hypot(wind.x, wind.y, wind.z);
  const mph = ms / MS_PER_MPH;
  if (mph > b.peakMph) b.peakMph = mph;
  const pApc = updateApc(b, deficitOut, dt);

  const fail = (part: SinglePart, load: number, capacity: number): boolean => {
    if (b.failed[part] || load <= capacity) return false;
    b.failed[part] = { part, time, load, capacity, mph };
    return true;
  };

  let changed = false;
  // Re-evaluate after each round of failures so cascades (e.g. breach → uplift) resolve now.
  for (let pass = 0; pass < 6; pass++) {
    const L = computeLoads(b, wind, pApc);
    const roofOn = !b.failed.roofStructure;
    const wallsUp = !b.failed.exteriorWalls;
    let any = false;

    any = fail("trim", L.trim, b.capacity.trim) || any;
    if (roofOn) {
      any = fail("roofCover", L.roofCover, b.capacity.roofCover) || any;
      any = fail("roofDeck", L.roofDeck, b.capacity.roofDeck) || any;
      any = fail("roofStructure", L.roofStructure, b.capacity.roofStructure) || any;
    }
    if (wallsUp) {
      for (let k = 0; k < 4; k++) {
        if (!b.windowFailed[k] && L.windows[k]! > b.windowCapacity[k]!) {
          b.windowFailed[k] = { part: "windows", face: k, time, load: L.windows[k]!, capacity: b.windowCapacity[k]!, mph };
          any = true;
        }
      }
      if (b.hasGarage) any = fail("garage", L.garage, b.capacity.garage) || any;
    }
    if (!b.failed.anchorage && fail("anchorage", L.lateral, b.capacity.anchorage)) {
      any = true;
      const h = Math.hypot(wind.x, wind.z) || 1;
      b.shift = { x: (2 * wind.x) / h, z: (2 * wind.z) / h };
    }
    const bracing = b.failed.roofStructure ? 1 : ROOF_BRACING_FACTOR;
    any = fail("exteriorWalls", L.lateral, b.capacity.exteriorWalls * bracing) || any;
    if (b.failed.exteriorWalls) any = fail("mostWalls", L.lateral, b.capacity.mostWalls) || any;
    if (b.failed.mostWalls) any = fail("allWalls", L.lateral, b.capacity.allWalls) || any;
    if (b.failed.allWalls) any = fail("slab", L.lateral, b.capacity.slab) || any;

    if (!any) break;
    changed = true;
  }
  if (changed) b.dod = degreeOfDamage(b);
  return changed;
}

export interface EFEstimate {
  ef: EFRating | null;
  low: EFRating | null;
  high: EFRating | null;
}

export function efFromDamage(dod: number): EFEstimate {
  const row = DI2_DODS.find((r) => r.dod === dod);
  if (!row) return { ef: null, low: null, high: null };
  return {
    ef: efRating(mphToMs(row.expected)),
    low: efRating(mphToMs(row.lower)),
    high: efRating(mphToMs(row.upper)),
  };
}

export interface BuildingReport {
  id: number;
  classLabel: string;
  dod: number;
  description: string;
  estimate: EFEstimate;
  peakMph: number;
  failures: { label: string; time: number; load: number; capacity: number; mph: number }[];
}

const FACE_NAMES = ["front", "side", "back", "side"];

export function buildingReport(b: Building): BuildingReport {
  const recs: (FailureRecord & { label: string })[] = [];
  for (const r of Object.values(b.failed)) if (r) recs.push({ ...r, label: PART_LABEL[r.part] });
  b.windowFailed.forEach((r, k) => {
    if (!r) return;
    // Name faces relative to the street-facing front.
    const rel = (k - b.frontFace + 4) % 4;
    recs.push({ ...r, label: `Windows (${FACE_NAMES[rel]})` });
  });
  recs.sort((a, c) => a.time - c.time || a.load - c.load);
  const row = DI2_DODS.find((r) => r.dod === b.dod);
  return {
    id: b.id,
    classLabel: CLASS_LABEL[b.cls],
    dod: b.dod,
    description: row ? row.text : "No damage",
    estimate: efFromDamage(b.dod),
    peakMph: b.peakMph,
    failures: recs.map(({ label, time, load, capacity, mph }) => ({ label, time, load, capacity, mph })),
  };
}
