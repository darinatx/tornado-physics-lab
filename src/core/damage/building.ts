/**
 * Component house damage model (Spec 03 v2): fragility-sampled component capacities,
 * permanent failures, cascades, DOD from what's missing, survey EF estimate.
 */
import {
  BASE_CAPACITY,
  BAY_NEIGHBOR_FACTOR,
  CORNER_BRACING_FACTOR,
  CP_FREESTANDING,
  DEAD_LOAD,
  PANEL_NEIGHBOR_FACTOR,
  CLASS_FACTORS,
  CLASS_LABEL,
  DI2_DODS,
  FRAGILITY,
  LAYOUT,
  PART_LABEL,
  PART_UNIT,
  ROOF_BRACING_FACTOR,
} from "../../config/buildings";
import type { ConstructionClass, Part } from "../../config/buildings";
import { MS_PER_MPH } from "../../config/units";
import type { Vec3 } from "../math/vec";
import { efRating, mphToMs } from "../wind/efScale";
import type { EFRating } from "../wind/efScale";
import { layoutPanels } from "./layout";
import { bayLoad, computeHouseLoads, coverLoad, deckLoad, faceNormal, sidingLoad, updateApc, velocityPressure, wallSigned } from "./loads";
import type { Building, FailureRecord, HouseSpec, Simple } from "./types";

/** Standard normal via Box–Muller from a seeded uniform RNG. */
function normal(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export function lognormal(rng: () => number, beta: number): number {
  return Math.exp(beta * normal(rng));
}

export function createHouse(spec: HouseSpec, rng: () => number, base: Record<Part, number> = BASE_CAPACITY): Building {
  const { panels, sections, nx, ne } = layoutPanels(spec, rng);
  const quality = lognormal(rng, FRAGILITY.houseQuality);
  const factors = CLASS_FACTORS[spec.cls];
  const cap = (p: Part) =>
    base[p] * (factors[p] ?? 1) * quality * lognormal(rng, p === "roofCover" ? FRAGILITY.coverScatter : FRAGILITY.partScatter);
  const simple = (p: Part): Simple => ({ cap: cap(p), failed: null });

  for (const p of panels) p.cap = cap("wallPanel");
  const panes = panels.flatMap((p, i) => (p.hasWindow ? [{ panel: i, cap: cap("window"), failed: null }] : []));
  const gi = panels.findIndex((p) => p.isGarage);
  const garage = gi >= 0 ? { panel: gi, cap: cap("garage"), failed: null } : null;
  const siding = panels.map(() => simple("siding"));
  for (const s of sections) {
    s.coverCap = cap("roofCover");
    s.deckCap = cap("roofDeck");
  }
  const bays = Array.from({ length: nx }, () => simple("roofBay"));
  // Rafters bear on the top plate of the front and back walls; the end bays also on their
  // gable end wall. The top plate can bridge one missing panel but not two in a row.
  const at = (face: number, col: number) => panels.findIndex((p) => p.face === face && p.col === col);
  const bayWalls = Array.from({ length: nx }, (_, col) => ({
    eave: [1, 3].map((face) => ({
      under: at(face, col),
      neighbors: [at(face, col - 1), at(face, col + 1)].filter((i) => i >= 0),
    })),
    gable: col === 0 ? panels.flatMap((p, i) => (p.face === 2 ? [i] : [])) : col === nx - 1 ? panels.flatMap((p, i) => (p.face === 0 ? [i] : [])) : [],
  }));
  const partitions = Array.from({ length: LAYOUT.partitions }, () => simple("partition"));

  // Corners: the last panel of face f meets the first panel of face (f + 1) mod 4.
  const cornerPartner = panels.map(() => -1);
  for (let f = 0; f < 4; f++) {
    const mine = panels.flatMap((p, i) => (p.face === f ? [i] : []));
    const next = panels.flatMap((p, i) => (p.face === (f + 1) % 4 ? [i] : []));
    const a = mine[mine.length - 1]!;
    const b2 = next[0]!;
    cornerPartner[a] = b2;
    cornerPartner[b2] = a;
  }

  return {
    ...spec,
    roofHeight: spec.wallHeight + spec.roofRise / 2,
    nx,
    ne,
    panels,
    panes,
    garage,
    siding,
    sections,
    bays,
    bayWalls,
    cornerPartner,
    partitions,
    coreRoom: simple("coreRoom"),
    anchorage: simple("anchorage"),
    sweep: simple("sweep"),
    deficitIn: 0,
    peakMph: 0,
    dod: 0,
    shift: null,
    rev: 0,
    normals: [0, 1, 2, 3].map((k) => faceNormal(spec.yaw, k)),
    breached: false,
    minCap: 0,
  };
}

/** Smallest capacity among intact components, allowing for the worst cascade weakening. */
export function minIntactCap(b: Building): number {
  let m = Infinity;
  const take = (c: number) => {
    if (c < m) m = c;
  };
  b.siding.forEach((s, i) => !s.failed && !b.panels[i]!.failed && take(s.cap));
  b.sections.forEach((s) => {
    if (b.bays[s.col]!.failed || s.deck) return;
    if (!s.cover) take(s.coverCap);
    take(s.deckCap + DEAD_LOAD.deck);
  });
  b.bays.forEach((s) => !s.failed && take((s.cap + DEAD_LOAD.roof) * BAY_NEIGHBOR_FACTOR * BAY_NEIGHBOR_FACTOR));
  b.panes.forEach((s) => !s.failed && take(s.cap));
  if (b.garage && !b.garage.failed) take(b.garage.cap);
  b.panels.forEach((s) => !s.failed && take(s.cap * PANEL_NEIGHBOR_FACTOR * PANEL_NEIGHBOR_FACTOR));
  b.partitions.forEach((s) => !s.failed && take(s.cap));
  if (!b.coreRoom.failed) take(b.coreRoom.cap);
  if (!b.anchorage.failed) take(b.anchorage.cap);
  if (!b.sweep.failed) take(b.sweep.cap);
  return m;
}

/** Largest net-load coefficient any component can see (|C_p| + |C_pi| bounds, free-standing). */
const MAX_LOAD_COEFF = 2.6;

/** The top plate can't bridge two missing panels in a row, and a gable can't stand on half a wall. */
export function bayUnsupported(b: Building, col: number): boolean {
  const w = b.bayWalls[col]!;
  const down = (i: number) => !!b.panels[i]!.failed;
  for (const e of w.eave) if (down(e.under) && e.neighbors.some(down)) return true;
  if (w.gable.length && w.gable.filter(down).length >= w.gable.length / 2) return true;
  return false;
}

const countFailed = (list: readonly { failed: FailureRecord | null }[]) => list.reduce((a, c) => a + (c.failed ? 1 : 0), 0);

/** Degree of damage from what's missing (Spec 03 v2 table, DMG-11). */
export function degreeOfDamage(b: Building): number {
  if (b.sweep.failed) return 10;
  const nS = b.sections.length;
  const coverLost = b.sections.filter((s) => s.cover || s.deck || b.bays[s.col]!.failed).length;
  const deckLost = b.sections.some((s) => s.deck);
  const bayFrac = countFailed(b.bays) / b.bays.length;
  const panelFrac = countFailed(b.panels) / b.panels.length;
  const partsDown = countFailed(b.partitions);
  let dod = 0;
  if (b.siding.some((s) => s.failed)) dod = 1;
  if (coverLost > 0) dod = 2;
  if (b.panes.some((p) => p.failed)) dod = 3;
  if (coverLost / nS >= 0.2 || deckLost || b.garage?.failed) dod = 4;
  if (b.anchorage.failed) dod = 5;
  if (bayFrac >= 1 / 3 - 1e-9) dod = 6;
  if (panelFrac >= 0.5) dod = 7;
  if (panelFrac >= 0.75 && partsDown === b.partitions.length) dod = 8;
  if (panelFrac === 1 && partsDown === b.partitions.length && b.coreRoom.failed) dod = 9;
  return dod;
}

/**
 * Advance one damage evaluation. `wind` is the ground-relative wind at roof height (m/s),
 * `deficitOut` the tornado's pressure deficit at the house (Pa). Returns true if anything failed.
 */
export function updateBuilding(
  b: Building,
  wind: Vec3,
  deficitOut: number,
  dt: number,
  time: number,
  onFail?: (rec: FailureRecord) => void,
): boolean {
  if (b.sweep.failed) return false;
  const mph = Math.hypot(wind.x, wind.y, wind.z) / MS_PER_MPH;
  if (mph > b.peakMph) b.peakMph = mph;
  const pApc = updateApc(b, deficitOut, dt);
  // Calm for this house: nothing intact can fail at this wind and pressure change.
  if (b.minCap === 0) b.minCap = minIntactCap(b);
  // Gravity doesn't wait for wind: an unsupported roof bay still has to come down.
  const calm = velocityPressure(wind) * MAX_LOAD_COEFF + Math.abs(pApc) < b.minCap;
  if (calm && !(b.breached && b.bays.some((bay, i) => !bay.failed && bayUnsupported(b, i)))) return false;
  const w = { x: wind.x, y: wind.y, z: wind.z };
  const record = (part: Part, index: number, load: number, capacity: number, sign = 0): FailureRecord => {
    const rec: FailureRecord = { part, index, time, load, capacity, mph, sign, wind: w };
    if (part === "window" || part === "garage" || part === "wallPanel" || part === "roofDeck" || part === "roofBay") b.breached = true;
    onFail?.(rec);
    return rec;
  };

  // Structural support (bracing, neighbors, open house) is judged from the state at the start
  // of this evaluation: load redistribution and toppling take time. Pressure effects (new
  // openings changing C_pi) still cascade within the evaluation.
  const bayDown0 = b.bays.map((x) => !!x.failed);
  const panelDown0 = b.panels.map((x) => !!x.failed);
  const open0 = panelDown0.filter(Boolean).length >= b.panels.length / 2 || bayDown0.every(Boolean);
  let changed = false;
  for (let pass = 0; pass < 8; pass++) {
    const L = computeHouseLoads(b, wind);
    let any = false;

    b.siding.forEach((sd, k) => {
      const panel = b.panels[k]!;
      if (sd.failed || panel.failed) return;
      const load = sidingLoad(L, panel.face, pApc);
      if (load > sd.cap) {
        sd.failed = record("siding", k, load, sd.cap);
        any = true;
      }
    });

    // Roof: bays (progressive), then covering and deck on standing bays.
    const bLoad = bayLoad(L, pApc);
    b.bays.forEach((bay, i) => {
      if (bay.failed) return;
      const neighbors = (bayDown0[i - 1] ? 1 : 0) + (bayDown0[i + 1] ? 1 : 0);
      const capEff = bay.cap * Math.pow(BAY_NEIGHBOR_FACTOR, neighbors);
      if (bLoad > capEff) {
        bay.failed = record("roofBay", i, bLoad, capEff);
        any = true;
      }
    });
    b.sections.forEach((s, i) => {
      if (b.bays[s.col]!.failed || s.deck) return;
      const dl = deckLoad(L, s, pApc);
      if (dl > s.deckCap) {
        s.deck = record("roofDeck", i, dl, s.deckCap);
        any = true;
        return;
      }
      const cl = coverLoad(L, s, pApc);
      if (!s.cover && cl > s.coverCap) {
        s.cover = record("roofCover", i, cl, s.coverCap);
        any = true;
      }
    });

    // Openings and wall panels.
    b.panes.forEach((pane, i) => {
      const panel = b.panels[pane.panel]!;
      if (pane.failed || panel.failed) return;
      const load = Math.abs(wallSigned(L, panel.face, pApc));
      if (load > pane.cap) {
        pane.failed = record("window", i, load, pane.cap);
        any = true;
      }
    });
    if (b.garage && !b.garage.failed && !b.panels[b.garage.panel]!.failed) {
      const load = Math.abs(wallSigned(L, 3, pApc));
      if (load > b.garage.cap) {
        b.garage.failed = record("garage", 0, load, b.garage.cap);
        any = true;
      }
    }
    const open = open0;
    const wh = Math.hypot(wind.x, wind.z);
    b.panels.forEach((p, i) => {
      if (p.failed) return;
      const braced = !bayDown0[p.col];
      // Walls lean on their neighbors: each fallen neighbor on the same wall weakens it.
      const prev = b.panels[i - 1];
      const next = b.panels[i + 1];
      const fallen = (prev?.face === p.face && panelDown0[i - 1] ? 1 : 0) + (next?.face === p.face && panelDown0[i + 1] ? 1 : 0);
      const partner = b.cornerPartner[i]!;
      const corner = partner >= 0 && !panelDown0[partner] ? CORNER_BRACING_FACTOR : 1;
      const capEff = p.cap * (braced ? ROOF_BRACING_FACTOR : 1) * corner * Math.pow(PANEL_NEIGHBOR_FACTOR, fallen);
      let signed = wallSigned(L, p.face, pApc);
      if (open && wh > 1e-9) {
        // Open house: a standing panel acts like a free-standing wall (wind on both faces).
        const n = faceNormal(b.yaw, p.face);
        const c = -(wind.x * n.x + wind.z * n.z) / wh; // > 0: wind hits the outside face
        const fs = L.q * CP_FREESTANDING * Math.abs(c);
        if (fs > Math.abs(signed)) signed = c >= 0 ? fs : -fs;
      }
      if (Math.abs(signed) > capEff) {
        p.failed = record("wallPanel", i, Math.abs(signed), capEff, signed >= 0 ? 1 : -1);
        any = true;
      }
    });

    // A roof bay can't stand without its bearing walls: it collapses onto the slab.
    b.bays.forEach((bay, i) => {
      if (bay.failed) return;
      if (bayUnsupported(b, i)) {
        bay.failed = record("roofBay", i, 1, 0, -1);
        any = true;
      }
    });

    const panelsDown = countFailed(b.panels);
    const standingFrac = 1 - panelsDown / b.panels.length;
    if (panelsDown >= b.panels.length / 2) {
      b.partitions.forEach((pt, i) => {
        if (!pt.failed && L.lateral > pt.cap) {
          pt.failed = record("partition", i, L.lateral, pt.cap);
          any = true;
        }
      });
    }
    if (!b.coreRoom.failed && panelsDown >= b.panels.length * 0.75 && L.lateral > b.coreRoom.cap) {
      b.coreRoom.failed = record("coreRoom", 0, L.lateral, b.coreRoom.cap);
      any = true;
    }
    if (!b.anchorage.failed && standingFrac >= 0.5 && L.lateral * standingFrac > b.anchorage.cap) {
      b.anchorage.failed = record("anchorage", 0, L.lateral * standingFrac, b.anchorage.cap);
      const h = Math.hypot(wind.x, wind.z) || 1;
      b.shift = { x: (2 * wind.x) / h, z: (2 * wind.z) / h };
      any = true;
    }
    if (panelsDown === b.panels.length && countFailed(b.partitions) === b.partitions.length && b.coreRoom.failed && L.lateral > b.sweep.cap) {
      b.sweep.failed = record("sweep", 0, L.lateral, b.sweep.cap);
      any = true;
    }

    if (!any) break;
    changed = true;
    if (b.sweep.failed) break;
  }
  if (changed) {
    b.dod = degreeOfDamage(b);
    b.rev++;
    b.minCap = minIntactCap(b);
  }
  return changed;
}

export interface EFEstimate {
  ef: EFRating | null;
  low: EFRating | null;
  high: EFRating | null;
  /** Wind speed the survey assigns (mph), or 0 with no damage. */
  mph: number;
  /** Why that speed was chosen within the DOD's bounds. */
  basis: string;
}

const RATING_BASIS: Record<ConstructionClass, string> = {
  weak: "rated at the lower bound: below-average construction fails at lower wind",
  standard: "rated at the expected value for typical construction",
  strong: "rated at the upper bound: well-built (straps, anchor bolts) needs more wind to fail",
};

/** Survey-style EF estimate, adjusted within the DOD's bounds by construction quality. */
export function efFromDamage(dod: number, cls: ConstructionClass = "standard"): EFEstimate {
  const row = DI2_DODS.find((r) => r.dod === dod);
  if (!row) return { ef: null, low: null, high: null, mph: 0, basis: "" };
  const mph = cls === "weak" ? row.lower : cls === "strong" ? row.upper : row.expected;
  return {
    ef: efRating(mphToMs(mph)),
    low: efRating(mphToMs(row.lower)),
    high: efRating(mphToMs(row.upper)),
    mph,
    basis: RATING_BASIS[cls],
  };
}

/** Every failure record in a house. */
export function allFailures(b: Building): FailureRecord[] {
  const out: FailureRecord[] = [];
  const push = (r: FailureRecord | null | undefined) => r && out.push(r);
  b.siding.forEach((s) => push(s.failed));
  b.sections.forEach((s) => {
    push(s.cover);
    push(s.deck);
  });
  b.bays.forEach((s) => push(s.failed));
  b.panes.forEach((s) => push(s.failed));
  push(b.garage?.failed);
  b.panels.forEach((s) => push(s.failed));
  b.partitions.forEach((s) => push(s.failed));
  push(b.coreRoom.failed);
  push(b.anchorage.failed);
  push(b.sweep.failed);
  return out;
}

export interface FailureGroup {
  part: Part;
  label: string;
  count: number;
  total: number;
  unit: string;
  /** First failure of this part type. */
  time: number;
  load: number;
  capacity: number;
  mph: number;
}

export interface BuildingReport {
  id: number;
  classLabel: string;
  dod: number;
  description: string;
  estimate: EFEstimate;
  peakMph: number;
  /** Failures grouped by part type, in order of first failure. */
  failures: FailureGroup[];
}

export function partTotal(b: Building, part: Part): number {
  switch (part) {
    case "siding": return b.panels.length;
    case "roofCover":
    case "roofDeck": return b.sections.length;
    case "roofBay": return b.bays.length;
    case "window": return b.panes.length;
    case "wallPanel": return b.panels.length;
    case "partition": return b.partitions.length;
    default: return 1;
  }
}

export function buildingReport(b: Building): BuildingReport {
  const groups = new Map<Part, FailureGroup>();
  for (const r of allFailures(b)) {
    const g = groups.get(r.part);
    if (!g) {
      groups.set(r.part, {
        part: r.part, label: PART_LABEL[r.part], count: 1, total: partTotal(b, r.part), unit: PART_UNIT[r.part],
        time: r.time, load: r.load, capacity: r.capacity, mph: r.mph,
      });
    } else {
      g.count++;
      if (r.time < g.time) Object.assign(g, { time: r.time, load: r.load, capacity: r.capacity, mph: r.mph });
    }
  }
  const row = DI2_DODS.find((r) => r.dod === b.dod);
  return {
    id: b.id,
    classLabel: CLASS_LABEL[b.cls],
    dod: b.dod,
    description: row ? row.text : "No damage",
    estimate: efFromDamage(b.dod, b.cls),
    peakMph: b.peakMph,
    failures: [...groups.values()].sort((a, c) => a.time - c.time),
  };
}
