/**
 * Debris pool (Spec 04 v1.4): component-shaped spawning, rubble, stepping, freezing on
 * overflow, permanent debris field, mass bookkeeping.
 */
import { AREAL_MASS, LAYOUT } from "../../config/buildings";
import { DEBRIS, DEBRIS_COLORS, DEBRIS_KINDS, SPAWN_TABLE, TURBULENCE, sheet } from "../../config/debris";
import type { DebrisKind, DebrisKindDef } from "../../config/debris";
import { createRng } from "../math/rng";
import type { Vec3 } from "../math/vec";
import { faceTangent, LOCAL_NORMALS, panelCenter, sectionGeometry, toWorld } from "../damage/layout";
import type { Building, FailureRecord } from "../damage/types";
import type { TerrainClass, TornadoState } from "../wind/types";
import { windAt } from "../wind/windField";
import { isSliding, restingForces, snag, stepPiece, wakeIfForced } from "./piece";
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

type Q = [number, number, number, number];

/** Quaternion from an orthonormal basis: the box's local X, Y, Z axes in world space. */
export function quatFromBasis(x: Vec3, y: Vec3, z: Vec3): Q {
  const m00 = x.x, m10 = x.y, m20 = x.z;
  const m01 = y.x, m11 = y.y, m21 = y.z;
  const m02 = z.x, m12 = z.y, m22 = z.z;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const S = Math.sqrt(tr + 1) * 2;
    return [(m21 - m12) / S, (m02 - m20) / S, (m10 - m01) / S, 0.25 * S];
  }
  if (m00 > m11 && m00 > m22) {
    const S = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [0.25 * S, (m01 + m10) / S, (m02 + m20) / S, (m21 - m12) / S];
  }
  if (m11 > m22) {
    const S = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / S, 0.25 * S, (m12 + m21) / S, (m02 - m20) / S];
  }
  const S = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / S, (m12 + m21) / S, 0.25 * S, (m10 - m01) / S];
}

/** House-local horizontal direction → world. */
function dirWorld(b: Building, lx: number, ly: number, lz: number): Vec3 {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  return { x: lx * c + lz * s, y: ly, z: -lx * s + lz * c };
}

const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

/** Approximate count of real objects a failure releases per representative piece kind. */
function realCount(b: Building, rec: FailureRecord, kind: DebrisKind): number {
  switch (rec.part) {
    case "siding": return (b.panels[rec.index]!.len * b.wallHeight) / 0.95;
    case "roofCover": return sectionGeometry(b, b.nx, b.sections[rec.index]!).area / 0.33;
    case "window": return 30;
    case "partition": return kind === "stud" ? 10 : 25;
    case "sweep": return kind === "stud" ? 10 : 60;
    default: return 1;
  }
}

export class DebrisField {
  readonly pieces: Piece[] = [];
  readonly stats: DebrisStats = { airborne: 0, resting: 0, skipped: 0, lofted: 0, settled: 0, maxSpeed: 0, maxHeight: 0 };
  /** Permanent debris field: resting pieces the tornado has left behind (append-only). */
  readonly settled: Piece[] = [];
  /** Pieces dropped from the front of `settled` when it overflows. */
  settledDropped = 0;
  /** Bumped when settled pieces are hidden (swept rubble), so renderers rewrite. */
  settledVersion = 0;
  /** Mass bookkeeping (kg, counting `represents`). DEB-16. */
  massSpawned = 0;
  massLofted = 0;
  massSkipped = 0;
  massSwept = 0;
  massLeftMap = 0;
  readonly massBySource = new Map<number, number>();
  private nextId = 0;
  private readonly rng: () => number;
  private readonly rubbleOf = new Map<number, Piece[]>();

  constructor(
    seed: number,
    readonly cap: number = DEBRIS.cap,
    readonly settledCap: number = DEBRIS.settledCap,
  ) {
    this.rng = createRng(seed ^ 0x5bd1e995);
  }

  private makePiece(b: Building, kind: DebrisKind, def: DebrisKindDef, pos: Vec3, q: Q | null, color: number, represents: number, time: number): Piece {
    const rng = this.rng;
    let quat = q;
    if (!quat) {
      const u1 = rng();
      const u2 = rng();
      const u3 = rng();
      const a = Math.sqrt(1 - u1);
      const c = Math.sqrt(u1);
      quat = [a * Math.sin(2 * Math.PI * u2), a * Math.cos(2 * Math.PI * u2), c * Math.sin(2 * Math.PI * u3), c * Math.cos(2 * Math.PI * u3)];
    }
    return {
      id: this.nextId++,
      kind,
      def,
      pos,
      vel: { x: 0, y: 0, z: 0 },
      q: quat,
      spin: rng() < 0.5 ? 1 : -1,
      resting: false,
      snagged: false,
      snagDir: null,
      bornAt: time,
      restedAt: Infinity,
      represents,
      color,
      sourceId: b.id,
      maxWindMet: 0,
      liftOn: true,
      liftRoll: (rng() * 2 - 1) * TURBULENCE.maxLiftRoll,
      gust: { x: 0, y: 0, z: 0 },
    };
  }

  /** Release the pieces for one component failure (Spec 04 v1.4). */
  spawnFrom(b: Building, rec: FailureRecord, time = rec.time): void {
    const rng = this.rng;
    const out: { p: Piece; rubble?: () => void; launched?: boolean }[] = [];
    const H = b.wallHeight;
    const up: Vec3 = { x: 0, y: 1, z: 0 };

    // Representative pieces (shingles, siding, glass, studs, chunks).
    for (const [kind, count] of SPAWN_TABLE[rec.part]) {
      const represents = Math.max(realCount(b, rec, kind) / count, 1);
      for (let i = 0; i < count; i++) {
        let l: Vec3;
        if (rec.part === "siding") {
          // Strips tear off the face of the panel that lost its siding.
          const panel = b.panels[rec.index]!;
          const n = LOCAL_NORMALS[panel.face]!;
          const c = panelCenter(b, { ...panel, u: panel.u + (rng() - 0.5) * panel.len * 0.8 }, 0.3 + rng() * (H - 0.6));
          l = { x: c.x + n.x * 0.12, y: c.y, z: c.z + n.z * 0.12 };
        } else if (rec.part === "roofCover") {
          const g = sectionGeometry(b, b.nx, b.sections[rec.index]!);
          l = { x: g.center.x + (rng() - 0.5) * g.width * 0.8, y: g.center.y, z: g.center.z };
        } else if (rec.part === "window") {
          const panel = b.panels[b.panes[rec.index]!.panel]!;
          const n = LOCAL_NORMALS[panel.face]!;
          const c = panelCenter(b, panel, LAYOUT.paneSill + LAYOUT.paneSize / 2);
          l = { x: c.x + n.x * 0.1, y: c.y + (rng() - 0.5), z: c.z + n.z * 0.1 };
        } else {
          l = { x: (rng() - 0.5) * b.width, y: 0.3 + rng() * (H - 0.3) * (rec.part === "sweep" ? 0.2 : 1), z: (rng() - 0.5) * b.depth };
        }
        const pos = toWorld(b, l.x, l.y, l.z);
        const color = kind === "shingle" ? b.roofColor : kind === "siding" ? b.wallColor : DEBRIS_COLORS[kind] ?? 0x999999;
        out.push({ p: this.makePiece(b, kind, DEBRIS_KINDS[kind], pos, null, color, represents, time) });
      }
    }

    // Component-shaped pieces.
    if (rec.part === "wallPanel") {
      const panel = b.panels[rec.index]!;
      const n = LOCAL_NORMALS[panel.face]!;
      const t = faceTangent(panel.face);
      const c = panelCenter(b, panel, H / 2);
      const xw = dirWorld(b, t.x, 0, t.z);
      const nw = dirWorld(b, n.x, 0, n.z);
      const mass = AREAL_MASS.wallPanel * panel.len * H;
      const def = sheet("Wall panel", panel.len, H, 0.15, mass);
      const p = this.makePiece(b, "wallPanel", def, toWorld(b, c.x, c.y, c.z), quatFromBasis(xw, nw, up), b.wallColor, 1, time);
      // Pushed in → topples inward; pulled out → outward.
      const fall = rec.sign >= 0 ? -1 : 1;
      p.vel = { x: fall * 1.5 * nw.x, y: 0, z: fall * 1.5 * nw.z };
      out.push({
        p,
        rubble: () => {
          // Lies flat beside its base, in the direction it fell.
          p.pos = toWorld(b, c.x + fall * n.x * (H / 2), 0, c.z + fall * n.z * (H / 2));
          p.q = quatFromBasis(xw, up, cross(xw, up));
        },
      });
    } else if (rec.part === "roofDeck" || rec.part === "roofBay") {
      const secs =
        rec.part === "roofDeck"
          ? [b.sections[rec.index]!]
          : b.sections.filter((s) => s.col === rec.index && !s.deck);
      // A bay releases one panel per slope (both rows together); a deck failure one section.
      const groups = rec.part === "roofDeck" ? [secs] : [-1, 1].map((sl) => secs.filter((s) => s.slope === sl)).filter((g) => g.length);
      for (const g of groups) {
        const geos = g.map((s) => sectionGeometry(b, b.nx, s));
        const len = geos.reduce((a, x) => a + x.length, 0);
        const cx = geos.reduce((a, x) => a + x.center.x, 0) / geos.length;
        const cy = geos.reduce((a, x) => a + x.center.y, 0) / geos.length;
        const cz = geos.reduce((a, x) => a + x.center.z, 0) / geos.length;
        const width = geos[0]!.width;
        const pitch = geos[0]!.pitch;
        const covered = g.some((s) => !s.cover);
        const areal = rec.part === "roofBay" ? AREAL_MASS.roofPanel : AREAL_MASS.deckSection;
        const def = sheet(rec.part === "roofBay" ? "Roof section" : "Roof deck section", width, len, rec.part === "roofBay" ? 0.25 : 0.05, areal * width * len);
        const xw = dirWorld(b, 1, 0, 0);
        // Down-slope direction along the slope: local (0, −sin, ±cos) rotated by yaw.
        const slopeDir = dirWorld(b, 0, -Math.sin(Math.abs(pitch)), Math.sign(pitch) * Math.cos(pitch));
        const normal = cross(slopeDir, xw);
        const yAxis = normal.y >= 0 ? normal : { x: -normal.x, y: -normal.y, z: -normal.z };
        const zAxis = cross(xw, yAxis);
        const p = this.makePiece(
          b,
          rec.part === "roofBay" ? "roofPanel" : "deckSheet",
          def,
          toWorld(b, cx, cy, cz),
          quatFromBasis(xw, yAxis, zAxis),
          covered ? b.roofColor : DEBRIS_COLORS.osb!,
          1,
          time,
        );
        // Lifted off (sign ≥ 0): uplift beat its connections and weight, so it leaves the house
        // moving. Net uplift force over its area accelerates it through ~0.5 m of lift; it also
        // picks up about a third of the wind's horizontal speed as it tears free.
        // Collapsed (sign < 0): a bearing wall fell, so it drops onto the slab.
        const lifted = rec.part === "roofDeck" || rec.sign >= 0;
        if (lifted) {
          const accel = (Math.max(rec.load, 0) * width * len) / def.mass;
          p.vel = { x: 0.3 * rec.wind.x, y: Math.sqrt(2 * accel * 0.5), z: 0.3 * rec.wind.z };
        }
        out.push({
          p,
          launched: lifted,
          rubble: () => {
            p.pos = toWorld(b, cx, 0.3, cz * 0.6);
            p.q = quatFromBasis(xw, up, cross(xw, up));
          },
        });
      }
      if (rec.part === "roofBay" && secs.length === 0) {
        // Deck already gone: bare rafters.
        for (const sl of [-1, 1])
          for (let i = 0; i < 2; i++) {
            const lx = -b.width / 2 + (rec.index + 0.3 + 0.4 * i) * (b.width / b.nx);
            const pos = toWorld(b, lx, b.wallHeight + b.roofRise / 2, (sl * b.depth) / 4);
            out.push({ p: this.makePiece(b, "rafter", DEBRIS_KINDS.rafter, pos, null, DEBRIS_COLORS.rafter!, 1, time) });
          }
      }
    } else if (rec.part === "garage" && b.garage) {
      const panel = b.panels[b.garage.panel]!;
      const n = LOCAL_NORMALS[panel.face]!;
      const t = faceTangent(panel.face);
      const c = panelCenter(b, panel, LAYOUT.garageHeight / 2);
      const xw = dirWorld(b, t.x, 0, t.z);
      const nw = dirWorld(b, n.x, 0, n.z);
      const def = sheet("Garage door", LAYOUT.garageWidth, LAYOUT.garageHeight, 0.05, AREAL_MASS.garageDoor * LAYOUT.garageWidth * LAYOUT.garageHeight);
      const p = this.makePiece(b, "garageDoor", def, toWorld(b, c.x + n.x * 0.1, c.y, c.z + n.z * 0.1), quatFromBasis(xw, nw, up), DEBRIS_COLORS.garagePanel!, 1, time);
      out.push({ p, rubble: () => {
        p.pos = toWorld(b, c.x - n.x * 1.5, 0, c.z - n.z * 1.5);
        p.q = quatFromBasis(xw, up, cross(xw, up));
      } });
    } else if (rec.part === "sweep") {
      // The slab is swept: rubble lying on it goes with it.
      for (const r of this.rubbleOf.get(b.id) ?? []) {
        if (r.hidden) continue;
        r.hidden = true;
        this.massSwept += r.def.mass * r.represents;
      }
      this.settledVersion++;
    }

    // Rubble or flight: can the wind at failure move it at all? (DEB-15)
    for (const { p, rubble, launched } of out) {
      const m = p.def.mass * p.represents;
      this.massSpawned += m;
      this.massBySource.set(b.id, (this.massBySource.get(b.id) ?? 0) + m);
      // Roof pieces that failed in uplift always leave; others drop as rubble if the wind
      // can't move them, or if the active pool is completely full of flying pieces.
      const poolFull = this.pieces.length >= this.cap && !this.pieces.some((q) => q.resting);
      if (rubble && ((!launched && !this.canMove(p, rec.wind)) || poolFull)) {
        rubble();
        p.pos.y = p.def.dims[2] / 2; // lying flat on the ground
        p.grounded = true;
        p.vel = { x: 0, y: 0, z: 0 };
        p.resting = true;
        p.restedAt = time;
        this.settle(p);
        const list = this.rubbleOf.get(b.id);
        if (list) list.push(p);
        else this.rubbleOf.set(b.id, [p]);
        continue;
      }
      this.add(p);
    }
  }

  /** Whether wind w can lift a piece or push it past its holding friction. */
  canMove(p: Piece, w: Vec3): boolean {
    const f = restingForces(p, w);
    return f.up > f.weight || f.drag > DEBRIS.holdFriction * Math.max(f.weight - f.up, 0);
  }

  private add(p: Piece): void {
    if (this.pieces.length < this.cap) {
      this.pieces.push(p);
      return;
    }
    // Freeze the oldest resting piece into the debris field (never erase it).
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
      this.massSkipped += p.def.mass * p.represents;
      return;
    }
    this.settle(this.pieces[oldest]!);
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
      const w = windAt(p.pos, s, terrain);
      this.updateGust(p, w, dt, terrain);
      w.x += p.gust.x;
      w.y += p.gust.y;
      w.z += p.gust.z;
      stepPiece(p, w, dt);
      if (isSliding(p)) {
        // Chance to catch on an obstacle grows with distance slid (mean free path by terrain).
        const d = Math.hypot(p.vel.x, p.vel.z) * dt;
        if (this.rng() < 1 - Math.exp(-d / DEBRIS.snagDistance[terrain])) snag(p);
      }
      const lofted = p.pos.y > cloudBase;
      if (lofted || Math.abs(p.pos.x) > DEBRIS.mapHalf || Math.abs(p.pos.z) > DEBRIS.mapHalf) {
        if (lofted) {
          this.stats.lofted++;
          this.massLofted += p.def.mass * p.represents;
        } else {
          this.massLeftMap += p.def.mass * p.represents;
        }
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

  /** Exact discrete Ornstein–Uhlenbeck update of a piece's gust, scaled to the local wind. */
  private updateGust(p: Piece, w: { x: number; y: number; z: number }, dt: number, terrain: TerrainClass): void {
    const sigma = TURBULENCE.intensity[terrain] * Math.hypot(w.x, w.z);
    const a = Math.exp(-dt / TURBULENCE.timeScale);
    const b = Math.sqrt(1 - a * a) * sigma;
    p.gust.x = a * p.gust.x + b * this.normal();
    p.gust.y = a * p.gust.y + b * TURBULENCE.verticalRatio * this.normal();
    p.gust.z = a * p.gust.z + b * this.normal();
  }

  private spare: number | null = null;
  private normal(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    const u1 = Math.max(this.rng(), 1e-12);
    const u2 = this.rng();
    const r = Math.sqrt(-2 * Math.log(u1));
    this.spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  }

  private settle(p: Piece): void {
    p.resting = true;
    p.vel.x = p.vel.y = p.vel.z = 0;
    this.settled.push(p);
    if (this.settled.length > this.settledCap) {
      this.settled.shift();
      this.settledDropped++;
    }
  }
}

