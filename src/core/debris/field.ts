/**
 * Debris pool (Spec 04): spawning from failures, stepping, recycling, stats.
 */
import { DEBRIS, DEBRIS_COLORS, SPAWN_TABLE } from "../../config/debris";
import type { DebrisKind } from "../../config/debris";
import type { Part } from "../../config/buildings";
import { createRng } from "../math/rng";
import { faceNormal } from "../damage/loads";
import type { Building, FailureRecord } from "../damage/types";
import type { TerrainClass, TornadoState } from "../wind/types";
import { windAt } from "../wind/windField";
import { isSliding, snag, stepPiece, wakeIfForced } from "./piece";
import type { Piece } from "./piece";

export interface DebrisStats {
  airborne: number;
  resting: number;
  skipped: number;
  /** Pieces carried up into the storm above the cloud base (removed). */
  lofted: number;
  /** Pieces in the permanent debris field. */
  settled: number;
  /** Fastest live piece (m/s). */
  maxSpeed: number;
  /** Highest live piece (m). */
  maxHeight: number;
}

/** Approximate count of real objects a failed part releases, per kind. */
function realCount(b: Building, part: Part, kind: DebrisKind): number {
  const roofArea = b.width * b.depth * 1.15;
  const perim = 2 * (b.width + b.depth);
  const wallArea = perim * b.wallHeight;
  switch (part) {
    case "trim": return 20;
    case "roofCover": return (0.2 * roofArea) / 0.33;
    case "windows": return 30;
    case "garage": return 4;
    case "roofDeck": return (0.2 * roofArea) / 2.88;
    case "roofStructure":
      return kind === "rafter" ? (2 * b.width) / 0.6 : kind === "osb" ? (0.8 * roofArea) / 2.88 : (0.8 * roofArea) / 0.33;
    case "exteriorWalls":
      return kind === "stud" ? perim / 0.4 : kind === "siding" ? (0.5 * wallArea) / 0.95 : (0.5 * wallArea) / 2.88;
    case "mostWalls":
    case "allWalls": return kind === "stud" ? 15 : 40;
    case "slab": return kind === "stud" ? 10 : 60;
    default: return 1;
  }
}

const ROOF_PARTS = new Set<Part>(["roofCover", "roofDeck", "roofStructure"]);

export class DebrisField {
  readonly pieces: Piece[] = [];
  readonly stats: DebrisStats = { airborne: 0, resting: 0, skipped: 0, lofted: 0, settled: 0, maxSpeed: 0, maxHeight: 0 };
  /** Permanent debris field: resting pieces the tornado has left behind (append-only). */
  readonly settled: Piece[] = [];
  /** Pieces dropped from the front of `settled` when it overflows. */
  settledDropped = 0;
  private nextId = 0;
  private readonly rng: () => number;

  constructor(
    seed: number,
    readonly cap: number = DEBRIS.cap,
    readonly settledCap: number = DEBRIS.settledCap,
  ) {
    this.rng = createRng(seed ^ 0x5bd1e995);
  }

  /** Release the pieces for one failure record (Spec 04 spawn table). */
  spawnFrom(b: Building, rec: FailureRecord, time = rec.time): void {
    const rng = this.rng;
    const ox = b.x + (b.shift?.x ?? 0);
    const oz = b.z + (b.shift?.z ?? 0);
    const c = Math.cos(b.yaw);
    const s = Math.sin(b.yaw);
    const toWorld = (lx: number, lz: number) => ({ x: ox + lx * c + lz * s, z: oz - lx * s + lz * c });

    for (const [kind, count] of SPAWN_TABLE[rec.part]) {
      const represents = Math.max(realCount(b, rec.part, kind) / count, 1);
      for (let i = 0; i < count; i++) {
        let lx: number;
        let lz: number;
        let y: number;
        if (rec.part === "windows" || rec.part === "garage" || rec.part === "trim") {
          // On a wall face: the window's face, the garage's front face, or any face for siding.
          const face = rec.part === "windows" ? rec.face ?? 0 : rec.part === "garage" ? b.frontFace : Math.floor(rng() * 4);
          const n = faceNormal(0, face); // local normal
          const along = rng() - 0.5;
          lx = n.x !== 0 ? (n.x * b.width) / 2 + n.x * 0.1 : along * b.width;
          lz = n.z !== 0 ? (n.z * b.depth) / 2 + n.z * 0.1 : along * b.depth;
          y = rec.part === "windows" ? 1.0 + rng() * 1.2 : 0.3 + rng() * (b.wallHeight - 0.3);
        } else {
          lx = (rng() - 0.5) * b.width;
          lz = (rng() - 0.5) * b.depth;
          y = ROOF_PARTS.has(rec.part)
            ? b.wallHeight + 0.3 + rng() * b.roofRise * 0.8
            : 0.3 + rng() * (b.wallHeight - 0.3);
        }
        const p = toWorld(lx, lz);
        // Random initial orientation.
        const u1 = rng();
        const u2 = rng();
        const u3 = rng();
        const sq1 = Math.sqrt(1 - u1);
        const sq2 = Math.sqrt(u1);
        const piece: Piece = {
          id: this.nextId++,
          kind,
          pos: { x: p.x, y, z: p.z },
          vel: { x: 0, y: 0, z: 0 },
          q: [sq1 * Math.sin(2 * Math.PI * u2), sq1 * Math.cos(2 * Math.PI * u2), sq2 * Math.sin(2 * Math.PI * u3), sq2 * Math.cos(2 * Math.PI * u3)],
          spin: rng() < 0.5 ? 1 : -1,
          resting: false,
          snagged: false,
          snagDir: null,
          bornAt: time,
          restedAt: Infinity,
          represents,
          color: kind === "shingle" ? b.roofColor : kind === "siding" ? b.wallColor : DEBRIS_COLORS[kind] ?? 0x999999,
          sourceId: b.id,
          maxWindMet: 0,
          liftOn: true,
        };
        this.add(piece);
      }
    }
  }

  private add(p: Piece): void {
    if (this.pieces.length < this.cap) {
      this.pieces.push(p);
      return;
    }
    // Recycle the oldest resting piece; if everything is airborne, skip.
    let oldest = -1;
    let t = Infinity;
    this.pieces.forEach((q, i) => {
      if (q.resting && q.restedAt < t) {
        t = q.restedAt;
        oldest = i;
      }
    });
    if (oldest < 0) {
      this.stats.skipped++;
      return;
    }
    this.pieces[oldest] = p;
  }

  /** Advance all airborne pieces; re-check resting ones near the tornado when asked. */
  step(dt: number, s: TornadoState, terrain: TerrainClass, checkResting: boolean, time = 0, cloudBase = Infinity): void {
    const range = DEBRIS.settleRangeRmax * s.rMax;
    const probe = { x: 0, y: DEBRIS.restSampleHeight, z: 0 };
    let airborne = 0;
    let resting = 0;
    let maxSpeed = 0;
    let maxHeight = 0;
    let removed = false;

    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i]!;
      if (p.resting) {
        const near = s.vMax > 0 && Math.hypot(p.pos.x - s.center.x, p.pos.z - s.center.z) < range;
        if (!near) {
          // The tornado has left it behind: move it to the permanent debris field.
          this.settle(p);
          this.pieces[i] = null as unknown as Piece;
          removed = true;
          continue;
        }
        if (checkResting) {
          probe.x = p.pos.x;
          probe.z = p.pos.z;
          wakeIfForced(p, windAt(probe, s, terrain));
        }
        if (p.resting) {
          resting++;
          continue;
        }
      }
      stepPiece(p, windAt(p.pos, s, terrain), dt);
      if (isSliding(p)) {
        // Chance to catch on an obstacle grows with distance slid (mean free path by terrain).
        const d = Math.hypot(p.vel.x, p.vel.z) * dt;
        if (this.rng() < 1 - Math.exp(-d / DEBRIS.snagDistance[terrain])) snag(p);
      }
      const lofted = p.pos.y > cloudBase;
      if (lofted || Math.abs(p.pos.x) > DEBRIS.mapHalf || Math.abs(p.pos.z) > DEBRIS.mapHalf) {
        if (lofted) this.stats.lofted++;
        this.pieces[i] = null as unknown as Piece;
        removed = true;
        continue;
      }
      if (p.resting) {
        p.restedAt = time;
        resting++;
        continue;
      }
      airborne++;
      maxSpeed = Math.max(maxSpeed, Math.hypot(p.vel.x, p.vel.y, p.vel.z));
      maxHeight = Math.max(maxHeight, p.pos.y);
    }
    if (removed) {
      let j = 0;
      for (const p of this.pieces) if (p) this.pieces[j++] = p;
      this.pieces.length = j;
    }
    Object.assign(this.stats, { airborne, resting, maxSpeed, maxHeight, settled: this.settled.length });
  }

  private settle(p: Piece): void {
    this.settled.push(p);
    if (this.settled.length > this.settledCap) {
      this.settled.shift();
      this.settledDropped++;
    }
  }
}

