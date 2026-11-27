/**
 * Debris pool (Spec 04 v1.4): component-shaped spawning, rubble, stepping, freezing on
 * overflow, permanent debris field, mass bookkeeping.
 */
import { AREAL_MASS, LAYOUT } from "../../config/buildings";
import { DEBRIS, DEBRIS_COLORS, DEBRIS_KINDS, HEAVY, SPAWN_TABLE, TURBULENCE, sheet } from "../../config/debris";
import type { DebrisKind, DebrisKindDef } from "../../config/debris";
import { createRng } from "../math/rng";
import type { Vec3 } from "../math/vec";
import { faceTangent, interiorWalls, LOCAL_NORMALS, panelCenter, sectionGeometry, toWorld } from "../damage/layout";
import type { Building, FailureRecord, QueuedImpact } from "../damage/types";
import type { TornadoState } from "../wind/types";
import { windAt } from "../wind/windField";
import { bumpKick, isSliding, restingForces, snag, stepPiece, supportHeight, wakeIfForced } from "./piece";
import { IMPACT } from "../../config/impacts";
import { DRYWALL_COLOR, PARTITION_AREAL } from "../../config/structure";
import { clipEnvelope, clipSlab, hasEnvelope, insideLocal, lyingOnSlab, overSlab, planesOf, slabHalf, surfaceAt } from "../impact/envelope";
import type { EnvelopeHit, Extent, ImpactTargets, Surface } from "../impact/envelope";
import { resolveImpact } from "../impact/impact";
import { arrives, bounce, floorUnder, halfExtentAlong, unbury } from "../impact/contact";
import type { Missile } from "../impact/impact";
import type { Piece } from "./piece";
import { tableAt } from "../terrain/roughness";
import type { Terrain } from "../terrain/roughness";

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
  /** Impacts on houses so far, counting representative copies (Spec 10). */
  impacts: number;
  /** Presses so far: contacts in a sustained contact episode, not resolved as impacts (Spec 10
   *  v0.18; one per piece and step, copies not counted). */
  pressed: number;
  /** Pieces stuck through a house surface now, and lodgings over the whole run. */
  lodged: number;
  lodgedTotal: number;
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


/** Slab top: houses stand on it (Spec 10). */
const SLAB = IMPACT.slabTop;
/** Torn-off cladding starts this far outside its surface, plus its own thickness (m): the
 *  drawn wall is 0.15 m thick, centered on the component's face. */
const SPAWN_OFFSET = 0.08;

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
    // Shards; the wall itself is released as panels (Spec 04 v2.4).
    case "partition": return kind === "stud" ? 10 : 5;
    case "sweep": return kind === "stud" ? 10 : 60;
    default: return 1;
  }
}

/** Where heavy pieces go (Spec 04 v2.0): the sim's heavy-debris world. */
/** Per-piece state a replayed piece takes over from the recorded one (Spec 13). */
export interface LaunchState {
  /** Shape, size and mass other than the kind's own (the lab's reference missiles). */
  def?: DebrisKindDef;
  liftRoll?: number;
  spin?: 1 | -1;
  gust?: Vec3;
  stepPhase?: number;
  angVel?: Vec3;
  /** Sim time it was last advanced to, and whether it lay on the ground then. */
  steppedTo?: number;
  grounded?: boolean;
}

export interface HeavySink {
  /** Take a new heavy piece from house `b`, at its pose and velocity. */
  take(p: Piece, b: Building, time: number): void;
}

export class DebrisField {
  readonly pieces: Piece[] = [];
  /** Heavy pieces become rigid bodies here when set (the sim sets it); else the point model. */
  heavy: HeavySink | null = null;
  /** Ground marks (Spec 19): told of landings on and slides along open ground. Read-only use. */
  marks: { landing(p: Piece, speed: number): void; slide(p: Piece, x0: number, z0: number): void } | null = null;
  readonly stats: DebrisStats = { airborne: 0, resting: 0, skipped: 0, lofted: 0, settled: 0, maxSpeed: 0, maxHeight: 0, impacts: 0, pressed: 0, lodged: 0, lodgedTotal: 0 };
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
  private lastTime = 0;
  /** Houses for hit tests, from the last step (rubble placed between steps uses them too). */
  private targets: ImpactTargets | null = null;
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
      origin: { x: b.x, z: b.z },
    };
  }

  /** Read-only observer of every impact on a house, counting representative copies (Spec 04
   *  v1.9; the wind tunnel's record). `b` is the house hit (a detailed house's stand-in). */
  onImpact: ((b: Building, q: QueuedImpact, p: Piece) => void) | null = null;
  /** Read-only observer of every press (a contact in a sustained episode, Spec 10 v0.18). */
  onPress: ((b: Building, p: Piece) => void) | null = null;

  /** Read-only observer of a piece leaving the pool for good: carried above the cloud base
   *  ("lofted") or off the map (Spec 16's storm record). */
  onGone: ((p: Piece, why: "lofted" | "leftMap") => void) | null = null;

  /** Turbulent dispersion (Spec 13): off holds every gust at zero, so a piece's flight draws
   *  nothing from the shared stream (exact debris replay). On in every real run. */
  dispersion = true;

  /**
   * Add one piece of `kind` at `pos` with velocity `vel` and orientation `q` (Spec 04 v1.9, the
   * wind tunnel's launcher). It counts as spawned by `source` (a house id, or −1) and spreads its
   * representative copies from where it started.
   */
  launch(kind: DebrisKind, pos: Vec3, vel: Vec3, q: Q, time: number, represents = 1, source = -1, state?: LaunchState): Piece {
    const def = state?.def ?? DEBRIS_KINDS[kind];
    const p = this.makePiece({ id: source, x: pos.x, z: pos.z } as Building, kind, def, { ...pos }, q, 0x8a7f6a, represents, time);
    p.vel = { ...vel };
    // A replayed piece (Spec 13) carries the recorded one's per-piece state.
    if (state) {
      if (state.liftRoll !== undefined) p.liftRoll = state.liftRoll;
      if (state.spin !== undefined) p.spin = state.spin;
      if (state.gust) p.gust = { ...state.gust };
      if (state.stepPhase !== undefined) p.stepPhase = state.stepPhase;
      if (state.angVel) p.angVel = { ...state.angVel };
      if (state.steppedTo !== undefined) p.steppedTo = state.steppedTo;
      if (state.grounded) p.grounded = true;
    }
    const m = def.mass * represents;
    this.massSpawned += m;
    this.massBySource.set(source, (this.massBySource.get(source) ?? 0) + m);
    this.add(p);
    return p;
  }

  /** Release the pieces for one component failure (Spec 04 v1.4). */
  spawnFrom(b: Building, rec: FailureRecord, time = rec.time): void {
    const rng = this.rng;
    // `topple`: a standing piece that tips over about its base edge, toward `d` (its height `h`).
    const out: { p: Piece; rubble?: () => boolean | void; launched?: boolean; topple?: { d: Vec3; h: number } }[] = [];
    const H = b.wallHeight;
    const up: Vec3 = { x: 0, y: 1, z: 0 };
    this.releaseLodged(b, rec);

    // Representative pieces (shingles, siding, glass, studs, chunks).
    for (const [kind, count] of SPAWN_TABLE[rec.part]) {
      const represents = Math.max(realCount(b, rec, kind) / count, 1);
      for (let i = 0; i < count; i++) {
        // Where it tears off, and how it lies there (Spec 10 v0.5): siding and glass in the
        // wall's plane, shingles along the roof slope, just outside the surface. Heights are
        // above the slab top, as the house is drawn.
        let l: Vec3;
        let q: Q | null = null;
        if (rec.part === "siding" || rec.part === "window") {
          const panel = b.panels[rec.part === "siding" ? rec.index : b.panes[rec.index]!.panel]!;
          const n = LOCAL_NORMALS[panel.face]!;
          const t = faceTangent(panel.face);
          const c =
            rec.part === "siding"
              ? panelCenter(b, { ...panel, u: panel.u + (rng() - 0.5) * panel.len * 0.8 }, SLAB + 0.3 + rng() * (H - 0.6))
              : panelCenter(b, { ...panel, u: panel.u + (rng() - 0.5) * LAYOUT.paneSize * 0.8 }, SLAB + LAYOUT.paneSill + LAYOUT.paneSize / 2 + (rng() - 0.5) * LAYOUT.paneSize * 0.8);
          const off = SPAWN_OFFSET + DEBRIS_KINDS[kind].dims[2];
          l = { x: c.x + n.x * off, y: c.y, z: c.z + n.z * off };
          const xw = dirWorld(b, t.x, 0, t.z);
          const nw = dirWorld(b, n.x, 0, n.z);
          q = quatFromBasis(xw, nw, cross(xw, nw));
        } else if (rec.part === "roofCover") {
          const sec = b.sections[rec.index]!;
          const g = sectionGeometry(b, b.nx, sec);
          const pitch = Math.atan2(b.roofRise, b.depth / 2);
          // Outward roof normal (local): up and toward the slope's eave.
          const nl = { x: 0, y: Math.cos(pitch), z: sec.slope * Math.sin(pitch) };
          const off = SPAWN_OFFSET + DEBRIS_KINDS[kind].dims[2];
          l = { x: g.center.x + (rng() - 0.5) * g.width * 0.8, y: SLAB + g.center.y + nl.y * off, z: g.center.z + nl.z * off };
          const xw = dirWorld(b, 1, 0, 0);
          const nw = dirWorld(b, nl.x, nl.y, nl.z);
          q = quatFromBasis(xw, nw, cross(xw, nw));
        } else {
          l = { x: (rng() - 0.5) * b.width, y: SLAB + 0.3 + rng() * (H - 0.3) * (rec.part === "sweep" ? 0.2 : 1), z: (rng() - 0.5) * b.depth };
        }
        const pos = toWorld(b, l.x, l.y, l.z);
        const color = kind === "shingle" ? b.roofColor : kind === "siding" ? b.wallColor : DEBRIS_COLORS[kind] ?? 0x999999;
        out.push({ p: this.makePiece(b, kind, DEBRIS_KINDS[kind], pos, q, color, represents, time) });
      }
    }

    // Component-shaped pieces.
    if (rec.part === "wallPanel") {
      const panel = b.panels[rec.index]!;
      const n = LOCAL_NORMALS[panel.face]!;
      const t = faceTangent(panel.face);
      const c = panelCenter(b, panel, SLAB + H / 2);
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
        topple: { d: { x: fall * nw.x, y: 0, z: fall * nw.z }, h: H },
        rubble: () => {
          if (fall < 0) {
            // Fell inward: flat on the slab.
            p.pos = toWorld(b, c.x + fall * n.x * (H / 2), 0, c.z + fall * n.z * (H / 2));
            p.q = quatFromBasis(xw, up, cross(xw, up));
            return false;
          }
          // Fell outward: it pivots on its sill at the slab edge and comes to rest leaning, its
          // base on the slab top and its top on the ground (Spec 10 v0.4).
          const top = IMPACT.slabTop;
          const T = p.def.dims[2];
          const run = Math.sqrt(H * H - top * top);
          const zAxis = { x: (nw.x * run) / H, y: -top / H, z: (nw.z * run) / H };
          let yAxis = cross(zAxis, xw);
          if (yAxis.y < 0) yAxis = { x: -yAxis.x, y: -yAxis.y, z: -yAxis.z };
          // Pivot on the slab's outer edge.
          const base = toWorld(b, c.x + n.x * IMPACT.slabMargin, top, c.z + n.z * IMPACT.slabMargin);
          p.pos = {
            x: base.x + zAxis.x * (H / 2) + yAxis.x * (T / 2),
            y: base.y + zAxis.y * (H / 2) + yAxis.y * (T / 2),
            z: base.z + zAxis.z * (H / 2) + yAxis.z * (T / 2),
          };
          p.q = quatFromBasis(xw, yAxis, cross(xw, yAxis));
          return true;
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
          toWorld(b, cx, SLAB + cy, cz),
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
      const c = panelCenter(b, panel, SLAB + LAYOUT.garageHeight / 2);
      const xw = dirWorld(b, t.x, 0, t.z);
      const nw = dirWorld(b, n.x, 0, n.z);
      const def = sheet("Garage door", LAYOUT.garageWidth, LAYOUT.garageHeight, 0.05, AREAL_MASS.garageDoor * LAYOUT.garageWidth * LAYOUT.garageHeight);
      const p = this.makePiece(b, "garageDoor", def, toWorld(b, c.x + n.x * 0.1, c.y, c.z + n.z * 0.1), quatFromBasis(xw, nw, up), DEBRIS_COLORS.garagePanel!, 1, time);
      // It falls in (as its rubble lies).
      out.push({ p, topple: { d: { x: -nw.x, y: 0, z: -nw.z }, h: LAYOUT.garageHeight }, rubble: () => {
        p.pos = toWorld(b, c.x - n.x * 1.5, 0, c.z - n.z * 1.5);
        p.q = quatFromBasis(xw, up, cross(xw, up));
      } });
    } else if (rec.part === "partition" || rec.part === "coreRoom") {
      // The wall itself, as panels of at most 4 m where it stood, carrying its mass less the
      // shards above; each tips over in the wind's direction across it (Spec 04 v2.4).
      const walls = interiorWalls(b, rec.part, rec.index);
      const wallMass = walls.reduce((a, w) => a + PARTITION_AREAL * w.len * H, 0);
      const shards = out.reduce((a, { p }) => a + p.def.mass * p.represents, 0);
      const f = Math.max(wallMass - shards, 0) / wallMass;
      for (const w of walls) {
        const n = Math.ceil(w.len / 4 - 1e-9);
        const seg = w.len / n;
        const nw0 = dirWorld(b, w.alongX ? 0 : 1, 0, w.alongX ? 1 : 0);
        const side = nw0.x * rec.wind.x + nw0.z * rec.wind.z < 0 ? -1 : 1;
        const nw = { x: side * nw0.x, y: 0, z: side * nw0.z };
        // Box X (length) along the wall, Y (thickness) along nw, Z (height) up: X = Y × Z.
        const xw = cross(nw, up);
        const nl = { x: side * (w.alongX ? 0 : 1), z: side * (w.alongX ? 1 : 0) };
        for (let i = 0; i < n; i++) {
          const u = -w.len / 2 + (i + 0.5) * seg;
          const lx = w.x + (w.alongX ? u : 0);
          const lz = w.z + (w.alongX ? 0 : u);
          const def = sheet("Interior wall", seg, H, 0.12, PARTITION_AREAL * seg * H * f);
          const p = this.makePiece(b, "wallPanel", def, toWorld(b, lx, SLAB + H / 2, lz), quatFromBasis(xw, nw, up), DRYWALL_COLOR, 1, time);
          p.vel = { x: 1.5 * nw.x, y: 0, z: 1.5 * nw.z };
          out.push({
            p,
            topple: { d: nw, h: H },
            // Point model: flat on the slab, fallen downwind.
            rubble: () => {
              p.pos = toWorld(b, lx + nl.x * (H / 2), 0, lz + nl.z * (H / 2));
              p.q = quatFromBasis(xw, up, cross(xw, up));
              return false;
            },
          });
        }
      }
    } else if (rec.part === "sweep") {
      // The slab is swept: its rubble goes with it, and everything else lying on it in the
      // permanent debris field, other houses' pieces and retired heavy ones included (Spec 04
      // v2.3). Heavy pieces still in the heavy-debris world are swept there.
      // Heavy ones go back to the wind first (v2.4): the heavy world gives them 2 s.
      const take = (r: Piece) => {
        if (r.hidden) return;
        if (this.isHeavy(r)) {
          this.retake(r, b, time);
          return;
        }
        r.hidden = true;
        r.swept = true;
        this.massSwept += r.def.mass * r.represents;
      };
      for (const r of this.rubbleOf.get(b.id) ?? []) take(r);
      const reach = (Math.hypot(b.width, b.depth) / 2 + IMPACT.slabMargin + 1) ** 2;
      for (let i = 0, n = this.settled.length; i < n; i++) {
        const r = this.settled[i]!;
        const dx = r.pos.x - b.x;
        const dz = r.pos.z - b.z;
        if (dx * dx + dz * dz < reach && !r.hidden && lyingOnSlab(b, r.pos)) take(r);
      }
      this.settledVersion++;
    }

    // Rubble or flight: can the wind at failure move it at all? (DEB-15)
    for (const { p, rubble, launched, topple } of out) {
      const m = p.def.mass * p.represents;
      this.massSpawned += m;
      this.massBySource.set(b.id, (this.massBySource.get(b.id) ?? 0) + m);
      // Roof pieces that failed in uplift always leave; others drop as rubble if the wind
      // can't move them, or if the active pool is completely full of flying pieces.
      const poolFull = this.pieces.length >= this.cap && !this.pieces.some((q) => q.resting);
      // Heavy pieces are rigid bodies (Spec 04 v2.0): from where they fell, or moving.
      // They fall from where the component stood, never placed where they'd land (v2.4): a wall
      // or garage door tips about its base edge (top edge at HEAVY.toppleSpeed: ω = (s/h)·(up × d),
      // its center moving at s/2 along d); a piece that collapsed drops from where it was.
      if (this.isHeavy(p)) {
        if (topple) {
          const k = HEAVY.toppleSpeed / topple.h;
          p.angVel = { x: k * topple.d.z, y: 0, z: -k * topple.d.x };
          p.vel = { x: (HEAVY.toppleSpeed / 2) * topple.d.x, y: 0, z: (HEAVY.toppleSpeed / 2) * topple.d.z };
        } else if (rubble && !launched && !this.canMove(p, rec.wind)) p.vel = { x: 0, y: 0, z: 0 };
        p.rigid = true;
        this.pieces.push(p);
        this.heavy!.take(p, b, time);
        continue;
      }
      if (rubble && ((!launched && !this.canMove(p, rec.wind)) || poolFull)) {
        // Lying flat on the ground, or on the slab where it fell onto it (unless placed leaning).
        if (!rubble()) p.pos.y = (overSlab(b, p.pos) ? IMPACT.slabTop : 0) + p.def.dims[2] / 2;
        // Not half inside a slab's edge either (its own, or a close neighbor's).
        unbury(p, this.targets ?? { near: () => [b] });
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

  /** A heavy piece: a rigid body in the heavy-debris world, when there is one (Spec 04 v2.0). */
  private isHeavy(p: Piece): boolean {
    return !!this.heavy && p.represents === 1 && p.def.mass >= HEAVY.minKg;
  }

  /**
   * Hand a heavy piece resting in the debris field (or just retired to it) back to the heavy-debris
   * world where it lies (Spec 04 v2.4: a swept slab's wind gets it). The old piece is hidden and
   * a new one, the same object, takes its place.
   */
  retake(r: Piece, b: Building, time: number): Piece {
    r.hidden = true;
    this.settledVersion++;
    const p: Piece = {
      ...r, id: this.nextId++, pos: { ...r.pos }, vel: { x: 0, y: 0, z: 0 }, q: [...r.q] as Q, gust: { x: 0, y: 0, z: 0 },
      resting: false, grounded: false, hidden: false, restedAt: Infinity, rigid: true,
    };
    delete p.settleNow;
    delete p.swept;
    delete p.angVel;
    this.pieces.push(p);
    this.heavy!.take(p, b, time);
    return p;
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
      if (q.resting && !q.rigid && q.restedAt < t) {
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
  /** Pieces beyond this many core radii are advanced every other step (Spec 04 v2.2). */
  farRmax: number = DEBRIS.farStepRmax;
  private stepNo = 0;

  step(dt: number, s: TornadoState, terrain: Terrain, checkResting: boolean, time = 0, cloudBase = Infinity, targets?: ImpactTargets): void {
    this.lastTime = time;
    this.stepNo++;
    if (targets) this.targets = targets;
    const range = DEBRIS.settleRangeRmax * s.rMax;
    const probe = { x: 0, y: DEBRIS.restSampleHeight as number, z: 0 };
    let airborne = 0;
    let resting = 0;
    let maxSpeed = 0;
    let maxHeight = 0;
    let removed = false;

    for (let i = 0; i < this.pieces.length; i++) {
      const p = this.pieces[i]!;
      // Moving in the heavy-debris world (Spec 04 v2.0).
      if (p.rigid) {
        if (p.resting) resting++;
        else {
          airborne++;
          // In the stats as it stands (INST-10), though the heavy engine moves it.
          maxSpeed = Math.max(maxSpeed, Math.hypot(p.vel.x, p.vel.y, p.vel.z));
          maxHeight = Math.max(maxHeight, p.pos.y);
        }
        continue;
      }
      // Retired from it: it stays where it lies, in the permanent debris field.
      if (p.settleNow) {
        delete p.settleNow;
        if (!p.hidden) this.settle(p);
        this.pieces[i] = null as unknown as Piece;
        removed = true;
        continue;
      }
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
          const floor = targets ? floorUnder(p, targets) : 0;
          probe.x = p.pos.x;
          probe.y = floor + DEBRIS.restSampleHeight;
          probe.z = p.pos.z;
          p.pos.y -= floor;
          wakeIfForced(p, windAt(probe, s, terrain));
          p.pos.y += floor;
        }
        if (p.resting) {
          p.steppedTo = time + dt;
          resting++;
          continue;
        }
      }
      // Far from the core the wind changes slowly: such a piece is advanced every other step,
      // by the time since it last was (Spec 04 v2.2), on alternate steps by its id.
      const far = Math.hypot(p.pos.x - s.center.x, p.pos.z - s.center.z) > this.farRmax * s.rMax;
      if (far && (this.stepNo + (p.stepPhase ?? p.id)) % 2 === 1 && p.steppedTo !== undefined && p.steppedTo >= time - 1e-9) {
        airborne++;
        // Not stepped this time, but airborne all the same: in the stats (INST-10).
        maxSpeed = Math.max(maxSpeed, Math.hypot(p.vel.x, p.vel.y, p.vel.z));
        maxHeight = Math.max(maxHeight, p.pos.y);
        continue;
      }
      const pdt = p.steppedTo === undefined ? dt : Math.min(Math.max(time + dt - p.steppedTo, dt), 2 * dt);
      p.steppedTo = time + dt;
      // The ground under it: a slab top or the ground (Spec 10 v0.2).
      const floor = targets ? floorUnder(p, targets) : 0;
      // A piece lying on the ground feels the wind just above it, as resting pieces do (Spec 04 v1.6).
      const w = windAt(p.grounded ? { x: p.pos.x, y: Math.max(p.pos.y, floor + DEBRIS.restSampleHeight), z: p.pos.z } : p.pos, s, terrain);
      this.updateGust(p, w, pdt, terrain);
      w.x += p.gust.x;
      w.y += p.gust.y;
      w.z += p.gust.z;
      const fx = p.pos.x, fy = p.pos.y, fz = p.pos.z;
      const wasGrounded = p.grounded;
      const v0 = this.marks ? Math.hypot(p.vel.x, p.vel.y, p.vel.z) : 0;
      p.pos.y -= floor;
      stepPiece(p, w, pdt);
      p.pos.y += floor;
      // Ground marks (Spec 19): a landing on open ground gouges it, a slide streaks it.
      if (this.marks && floor === 0 && p.grounded) {
        if (!wasGrounded) this.marks.landing(p, v0);
        else if (isSliding(p)) this.marks.slide(p, fx, fz);
      }
      // Houses in the way (Spec 10): bounce, break through a window, or lodge.
      if (targets && this.collide(p, { x: fx, y: fy, z: fz }, targets)) {
        this.pieces[i] = null as unknown as Piece;
        removed = true;
        continue;
      }
      if (isSliding(p)) {
        const d = Math.hypot(p.vel.x, p.vel.z) * pdt;
        // Chance to catch on an obstacle grows with distance slid (mean free path by terrain).
        if (this.rng() < 1 - Math.exp(-d / tableAt(DEBRIS.snagDistance, terrain, p.pos.x, p.pos.z))) {
          // Laid flat on whatever it was sliding on: the slab top or the ground.
          const base = targets ? floorUnder(p, targets) : 0;
          p.pos.y -= base;
          snag(p);
          p.pos.y += base;
        } else {
          // Rough ground: a bump may hop it into the wind (Spec 04 v1.7).
          bumpKick(p, d, tableAt(DEBRIS.bumpSpacing, terrain, p.pos.x, p.pos.z), this.rng);
        }
      }
      // Nothing stays buried in a slab (a bounce at a wall's base, tumbling, snagging, spawning).
      if (targets) unbury(p, targets);
      const lofted = p.pos.y > cloudBase;
      if (lofted || Math.abs(p.pos.x) > DEBRIS.mapHalf || Math.abs(p.pos.z) > DEBRIS.mapHalf) {
        if (lofted) {
          this.stats.lofted++;
          this.massLofted += p.def.mass * p.represents;
        } else {
          this.massLeftMap += p.def.mass * p.represents;
        }
        this.onGone?.(p, lofted ? "lofted" : "leftMap");
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

  /** Pieces stuck through house surfaces, by surface key (Spec 10). */
  private readonly lodged = new Map<string, Piece[]>();

  /** Key of the surface a piece lodges in: wall panels (and their garage door), gables, roof sections. */
  private static lodgeKey(b: Building, s: Surface): string {
    return s.kind === "gable" ? `${b.id}:g:${s.face}` : s.kind === "roof" ? `${b.id}:r:${s.index}` : `${b.id}:w:${s.index}`;
  }

  /** A component of a detailed house's stand-in is gone (Spec 10 v0.12): what was stuck in it
   *  falls free, as when a component house's part fails. */
  releaseSurface(b: Building, part: FailureRecord["part"], index: number): void {
    this.releaseLodged(b, { part, index });
  }

  /** A failed component lets the pieces stuck in it fall free. */
  private releaseLodged(b: Building, rec: Pick<FailureRecord, "part" | "index">): void {
    if (!this.lodged.size) return;
    const keys: string[] = [];
    const endFace = (col: number) => (col === 0 ? 2 : col === b.nx - 1 ? 0 : -1);
    if (rec.part === "wallPanel") keys.push(`${b.id}:w:${rec.index}`, `${b.id}:g:${b.panels[rec.index]!.face}`);
    else if (rec.part === "garage" && b.garage) keys.push(`${b.id}:w:${b.garage.panel}`);
    else if (rec.part === "roofDeck") keys.push(`${b.id}:r:${rec.index}`);
    else if (rec.part === "roofBay") {
      b.sections.forEach((s, i) => s.col === rec.index && keys.push(`${b.id}:r:${i}`));
      const f = endFace(rec.index);
      if (f >= 0) keys.push(`${b.id}:g:${f}`);
    } else if (rec.part === "sweep") for (const k of this.lodged.keys()) if (k.startsWith(`${b.id}:`)) keys.push(k);
    for (const k of keys) {
      const list = this.lodged.get(k);
      if (!list) continue;
      this.lodged.delete(k);
      for (const p of list) {
        if (p.hidden) continue;
        p.hidden = true;
        this.settledVersion++;
        this.stats.lodged--;
        this.add({
          ...p, id: this.nextId++, pos: { ...p.pos }, vel: { x: 0, y: 0, z: 0 }, q: [...p.q] as Q, gust: { x: 0, y: 0, z: 0 },
          resting: false, grounded: false, hidden: false, lodgedIn: undefined, contact: undefined, restedAt: Infinity,
        });
      }
    }
  }

  /**
   * Test a piece's step against the houses near it (Spec 10). Returns true if it lodged (it
   * has moved to the debris field).
   */
  private collide(p: Piece, from: Vec3, targets: ImpactTargets): boolean {
    const seg = Math.hypot(p.pos.x - from.x, p.pos.z - from.z);
    const reach = p.def.dims[0] / 2 + seg + 0.5;
    const ext: Extent = (n) => halfExtentAlong(p, n);
    let best: EnvelopeHit | null = null;
    let house: Building | null = null;
    for (const site of targets.near(p.pos.x, p.pos.z)) {
      const b = site;
      if (Math.hypot(p.pos.x - b.x, p.pos.z - b.z) > Math.hypot(b.width, b.depth) / 2 + 2.5 + reach) continue;
      // Every house keeps its slab: its sides stop pieces low on the ground like a curb.
      if (Math.min(p.pos.y, from.y) < IMPACT.slabTop + p.def.dims[0]) {
        const sh = clipSlab(b, from, p.pos, ext);
        if (sh && !sh.top) {
          const vn = -(p.vel.x * sh.normal.x + p.vel.y * sh.normal.y + p.vel.z * sh.normal.z);
          if (vn > 0) {
            bounce(p, sh.point, sh.normal, vn);
            return false;
          }
        }
      }
      // A detailed house: its stand-in (Spec 10 v0.7), what stands in the detail physics.
      const e = site.detail ? site.standIn : site;
      if (!e || !hasEnvelope(e)) continue;
      if (p.pos.y > e.wallHeight + e.roofRise + reach && from.y > e.wallHeight + e.roofRise + reach) continue;
      const h = clipEnvelope(e, from, p.pos, ext);
      if (h && (!best || h.t < best.t)) {
        best = h;
        house = e;
      }
    }
    if (!best || !house || best.surface.kind === "opening") return false;
    const b = house;
    // The surface's normal toward the piece's side.
    const n = best.entering ? best.normal : { x: -best.normal.x, y: -best.normal.y, z: -best.normal.z };
    const vn = -(p.vel.x * n.x + p.vel.y * n.y + p.vel.z * n.z);
    if (vn <= 0) return false;
    if (!best.entering) {
      // From inside: the standing envelope keeps it in, no damage.
      bounce(p, best.point, n, vn);
      // In through an opening and out against a standing surface in one step: it stays on its
      // own path, just short of that surface (v0.18). Set off by its box instead, a long piece's
      // center could jump across the standing wall beside the opening; still touching, it is
      // pushed clear from inside next step.
      if (best.cut) p.pos = { x: best.point.x + n.x * 0.01, y: Math.max(best.point.y + n.y * 0.01, 0), z: best.point.z + n.z * 0.01 };
      return false;
    }
    // Held against this surface (Spec 10 v0.18): a press, not a new impact.
    if (!arrives(p, b.id, best.plane, this.lastTime)) {
      bounce(p, best.point, n, vn, 0);
      this.stats.pressed++;
      this.onPress?.(b, p);
      return false;
    }
    const m: Missile = { label: p.def.label, family: p.def.family, mass: p.def.mass, dims: p.def.dims };
    const own = resolveImpact(b, best.surface, m, vn, this.rng, true, best.local);
    if (own) {
      b.impacts.push(own.impact);
      this.stats.impacts++;
      this.onImpact?.(b, own.impact, p);
    }
    // Representative copies hit around the same point (Spec 10).
    const copies = Math.min(Math.round(p.represents), IMPACT.maxCopies) - 1;
    if (copies > 0) {
      const o = p.origin ?? { x: best.point.x, z: best.point.z };
      const sigma = Math.min(Math.max(IMPACT.copyScatter * Math.hypot(best.point.x - o.x, best.point.z - o.z), IMPACT.copyScatterMin), IMPACT.copyScatterMax);
      const pn = planesOf(b)[best.plane]!.n;
      // In-plane basis: t1 = n × up (or x), t2 = n × t1.
      let t1 = { x: -pn.z, y: 0, z: pn.x };
      const l1 = Math.hypot(t1.x, t1.z);
      t1 = l1 > 1e-6 ? { x: t1.x / l1, y: 0, z: t1.z / l1 } : { x: 1, y: 0, z: 0 };
      const t2 = { x: pn.y * t1.z - pn.z * t1.y, y: pn.z * t1.x - pn.x * t1.z, z: pn.x * t1.y - pn.y * t1.x };
      for (let k = 0; k < copies; k++) {
        const a = this.normal() * sigma;
        const c = this.normal() * sigma;
        const l = { x: best.local.x + a * t1.x + c * t2.x, y: best.local.y + a * t1.y + c * t2.y, z: best.local.z + a * t1.z + c * t2.z };
        if (!insideLocal(b, l, 1e-6, best.plane)) continue; // off the envelope: a miss
        const r = resolveImpact(b, surfaceAt(b, best.plane, l), m, vn, this.rng, false, l);
        if (r) {
          b.impacts.push(r.impact);
          this.stats.impacts++;
          this.onImpact?.(b, r.impact, p);
        }
      }
    }
    // A detailed house's stand-in takes lodged pieces like any house (Spec 10 v0.12); they fall
    // free when the stand-in shows that surface gone (releaseSurface).
    const response = own?.response ?? "bounce";
    const speed = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
    const dir = speed > 1e-9 ? { x: p.vel.x / speed, y: p.vel.y / speed, z: p.vel.z / speed } : { x: -n.x, y: -n.y, z: -n.z };
    if (response === "through") {
      p.pos = { x: best.point.x + dir.x * 0.05, y: best.point.y + dir.y * 0.05, z: best.point.z + dir.z * 0.05 };
      p.vel = { x: p.vel.x * IMPACT.throughGlassKeep, y: p.vel.y * IMPACT.throughGlassKeep, z: p.vel.z * IMPACT.throughGlassKeep };
      p.grounded = false;
      return false;
    }
    if (response === "lodge") {
      // Stuck through the surface along its flight, the tip just inside.
      const back = p.def.dims[0] / 2 - IMPACT.lodgeDepth;
      p.pos = { x: best.point.x - dir.x * back, y: best.point.y - dir.y * back, z: best.point.z - dir.z * back };
      const ref = Math.abs(dir.y) < 0.95 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
      const d = ref.x * dir.x + ref.y * dir.y + ref.z * dir.z;
      let yv = { x: ref.x - d * dir.x, y: ref.y - d * dir.y, z: ref.z - d * dir.z };
      const yl = Math.hypot(yv.x, yv.y, yv.z);
      yv = { x: yv.x / yl, y: yv.y / yl, z: yv.z / yl };
      p.q = quatFromBasis(dir, yv, cross(dir, yv));
      p.grounded = false;
      p.restedAt = this.lastTime;
      const key = DebrisField.lodgeKey(b, best.surface);
      p.lodgedIn = key;
      const list = this.lodged.get(key);
      if (list) list.push(p);
      else this.lodged.set(key, [p]);
      this.stats.lodged++;
      this.stats.lodgedTotal++;
      this.settle(p);
      return true;
    }
    bounce(p, best.point, n, vn);
    return false;
  }







  /** Exact discrete Ornstein–Uhlenbeck update of a piece's gust, scaled to the local wind. */
  private updateGust(p: Piece, w: { x: number; y: number; z: number }, dt: number, terrain: Terrain): void {
    if (!this.dispersion) {
      p.gust.x = p.gust.y = p.gust.z = 0;
      return;
    }
    const sigma = tableAt(TURBULENCE.intensity, terrain, p.pos.x, p.pos.z) * Math.hypot(w.x, w.z);
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

