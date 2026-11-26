/**
 * Debris impact outcomes (Spec 10): fragility by surface and missile, impulse loads, and
 * applying queued impacts to a component house.
 */
import { LAYOUT } from "../../config/buildings";
import type { Part } from "../../config/buildings";
import type { DebrisFamily } from "../../config/debris";
import { IMPACT } from "../../config/impacts";
import type { Fragility } from "../../config/impacts";
import type { Building, FailureRecord, MissileInfo, QueuedImpact } from "../damage/types";
import type { Vec3 } from "../math/vec";
import type { Surface } from "./envelope";

export interface Missile {
  label: string;
  family: DebrisFamily;
  mass: number;
  /** Length, width, thickness (m). */
  dims: readonly [number, number, number];
}

/** Standard normal from two uniforms (Box–Muller). */
function boxMuller(u1: number, u2: number): number {
  return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-12))) * Math.cos(2 * Math.PI * u2);
}

/** Deterministic uniform in (0, 1) from integers (no RNG state consumed). */
export function hashUniform(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return ((h >>> 0) + 0.5) / 4294967296;
}

/** A component's own impact strength: lognormal, fixed per house, component and mode. */
export function componentThreshold(f: Fragility, houseId: number, index: number, salt: number): number {
  const z = boxMuller(hashUniform(houseId, index, salt), hashUniform(houseId, index, salt + 7919));
  return f.median * Math.exp(f.beta * z);
}

/** A per-hit draw from the field's seeded RNG. */
export function drawThreshold(f: Fragility, rng: () => number): number {
  return f.median * Math.exp(f.beta * boxMuller(rng(), rng()));
}

const SALT = { glassCompact: 1, glassSheet: 2, siding: 3, shingle: 4, glassRod: 5 } as const;
const GLASS_SALT: Record<DebrisFamily, number> = { compact: SALT.glassCompact, sheet: SALT.glassSheet, rod: SALT.glassRod };

/** A pane's breaking momentum for this missile family (kg·m/s), IMP-03. */
export function glassThreshold(b: Building, pane: number, family: DebrisFamily): number {
  const cls = b.cls === "strong" ? IMPACT.strongGlazing : 1;
  return componentThreshold(IMPACT.glass[family], b.id, pane, GLASS_SALT[family]) * cls;
}

export const sidingThreshold = (b: Building, panel: number) => componentThreshold(IMPACT.siding, b.id, panel, SALT.siding);
export const shingleThreshold = (b: Building, section: number) => componentThreshold(IMPACT.shingle, b.id, section, SALT.shingle);

/** Rods and compact pieces under the mass limit can perforate; sheets spread their contact. */
export const canPerforate = (m: Missile) => m.family !== "sheet" && m.mass < IMPACT.perforateMaxKg;

/** Impulse force on the struck component (N), capped by the missile's crushing strength. IMP-06. */
export function impulseForce(m: Missile, vn: number): number {
  const avg = (m.mass * Math.max(vn, 0) * (1 + IMPACT.restitution)) / IMPACT.contactTime;
  const crush = IMPACT.crushStrength * m.dims[1] * m.dims[2];
  return Math.min(avg, crush);
}

export interface ImpactOutcome {
  impact: QueuedImpact;
  /** What the piece does: goes through a broken window, lodges, or bounces. */
  response: "through" | "lodge" | "bounce";
}

/**
 * Decide one hit on a standing surface. `vn` is the normal speed into the surface (m/s, > 0);
 * `withForce` is false for representative copies (only the piece itself loads the component).
 */
export function resolveImpact(b: Building, surface: Surface, m: Missile, vn: number, rng: () => number, withForce = true, at?: Vec3): ImpactOutcome | null {
  if (surface.kind === "opening" || vn <= 0) return null;
  const p = m.mass * vn;
  const E = 0.5 * m.mass * vn * vn;
  const info = (measure: MissileInfo["measure"]): MissileInfo => ({ label: m.label, mass: m.mass, speed: vn, measure });
  const q: QueuedImpact = {
    surface: surface.kind, index: surface.index, face: surface.face,
    broke: false, perforated: false, sidingTorn: false, coverTorn: false,
    force: 0, measure: 0, threshold: 0, missile: info("pressure"),
    ...(at ? { at: { x: at.x, y: at.y, z: at.z } } : {}),
  };
  let response: ImpactOutcome["response"] = "bounce";
  switch (surface.kind) {
    case "pane": {
      const th = glassThreshold(b, surface.index, m.family);
      q.measure = p;
      q.threshold = th;
      q.missile = info("momentum");
      if (p > th) {
        q.broke = true;
        response = "through";
      } else if (withForce) q.force = impulseForce(m, vn);
      // The pane's panel takes an unbroken hit's push.
      q.index = surface.index;
      break;
    }
    case "garage":
    case "wall":
    case "gable":
    case "roof": {
      const kind = surface.kind === "garage" ? "garage" : surface.kind === "roof" ? "roof" : "wall";
      if (canPerforate(m)) {
        const th = drawThreshold(IMPACT.perforate[kind], rng);
        if (E > th) {
          q.perforated = true;
          q.measure = E;
          q.threshold = th;
          q.missile = info("energy");
          response = "lodge";
        }
      }
      if (surface.kind === "wall" || surface.kind === "gable") {
        if (!b.siding[surface.index]!.failed && E > sidingThreshold(b, surface.index)) {
          q.sidingTorn = true;
          if (!q.perforated) {
            q.measure = E;
            q.threshold = sidingThreshold(b, surface.index);
            q.missile = info("energy");
          }
        }
      }
      if (surface.kind === "roof" && !b.sections[surface.index]!.cover && E > shingleThreshold(b, surface.index)) {
        q.coverTorn = true;
        if (!q.perforated) {
          q.measure = E;
          q.threshold = shingleThreshold(b, surface.index);
          q.missile = info("energy");
        }
      }
      // Walls and the garage door take the push; roof hits push down, which uplift checks don't use.
      // Walls and the garage door take the push; a roof hit's push goes to a detailed house's
      // sheathing (component uplift checks don't take a downward load).
      if (withForce) q.force = impulseForce(m, vn);
      break;
    }
  }
  return { impact: q, response };
}

export type Recorder = (part: Part, index: number, load: number, capacity: number, sign?: number, debris?: MissileInfo) => FailureRecord;

/** Total perforation hole area (m²). */
export const holeArea = (b: Building) => b.holes.reduce((a, h) => a + h, 0);

/**
 * Apply a house's queued impacts (Spec 10 timing): broken panes, perforations, stripped siding
 * and shingles, and impulse pressures for this evaluation's wind checks. Returns true if any
 * component failed.
 */
export function applyImpacts(b: Building, record: Recorder): boolean {
  b.impactPa.fill(0);
  b.impactBy.fill(null);
  b.garageImpactPa = 0;
  if (!b.impacts.length) return false;
  let failed = false;
  const H = b.wallHeight;
  for (const q of b.impacts) {
    const panelIdx = q.surface === "pane" ? b.panes[q.index]!.panel : q.surface === "roof" ? -1 : q.index;
    const panel = panelIdx >= 0 ? b.panels[panelIdx]! : null;
    if (panel?.failed) continue;
    if (q.surface === "roof") {
      const s = b.sections[q.index]!;
      if (b.bays[s.col]!.failed || s.deck) continue;
      if (q.perforated) b.holes[4]! += IMPACT.holeArea;
      if (q.coverTorn && !s.cover) {
        b.coverLost[q.index] = Math.min(b.coverLost[q.index]! + IMPACT.patchArea, s.area);
        if (b.coverLost[q.index]! >= IMPACT.failFraction * s.area) {
          s.cover = record("roofCover", q.index, q.measure, q.threshold, 0, q.missile);
          failed = true;
        }
      }
      continue;
    }
    if (q.surface === "pane") {
      const pane = b.panes[q.index]!;
      if (pane.failed) continue;
      if (q.broke) {
        pane.failed = record("window", q.index, q.measure, q.threshold, 0, q.missile);
        failed = true;
        continue;
      }
    }
    if (q.surface === "garage" && b.garage && !b.garage.failed) {
      if (q.perforated) b.holes[q.face]! += IMPACT.holeArea;
      b.garageImpactPa += q.force / (LAYOUT.garageWidth * LAYOUT.garageHeight);
      continue;
    }
    if (q.perforated) b.holes[q.face]! += IMPACT.holeArea;
    if (q.sidingTorn && !b.siding[panelIdx]!.failed) {
      const area = panel!.len * H;
      b.sidingLost[panelIdx] = Math.min(b.sidingLost[panelIdx]! + IMPACT.patchArea, area);
      if (b.sidingLost[panelIdx]! >= IMPACT.failFraction * area) {
        b.siding[panelIdx]!.failed = record("siding", panelIdx, q.measure, q.threshold, 0, q.missile);
        failed = true;
      }
    }
    if (q.force > 0) {
      const pa = q.force / (panel!.len * H);
      b.impactPa[panelIdx]! += pa;
      const prev = b.impactBy[panelIdx];
      if (!prev || prev.mass * prev.speed < q.missile.mass * q.missile.speed) b.impactBy[panelIdx] = { ...q.missile, measure: "pressure" };
    }
  }
  b.impacts.length = 0;
  if (!b.breached && holeArea(b) >= IMPACT.breachArea) b.breached = true;
  return failed;
}
