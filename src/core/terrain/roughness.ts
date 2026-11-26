/**
 * Terrain roughness (Spec 17): roughness length z₀ from ground cover and building density
 * (Macdonald, Griffiths & Hall 1998), β(z₀) for Spec 01's power law, and an upwind-fetch
 * weighted z₀ for each wind direction. Pure: no DOM, no randomness.
 */
import { TERRAIN } from "../../config/terrain";
import type { CoverKind } from "../../config/terrain";
import { TERRAIN_BETA } from "../../config/wind";
import type { TerrainClass } from "../wind/types";

/**
 * A roughness map (read-only data, safe to post to a worker). Values are natural logs of z₀
 * (m) at grid nodes; node (i, j) sits at (originX + i·cell, originZ + j·cell).
 */
export interface RoughnessField {
  readonly kind: "field";
  /** Increases whenever the values change. Counted per builder (deterministic): a sender is
   *  reset whenever its sim makes a new builder, so a receiver never mixes two builders' fields. */
  version: number;
  readonly cell: number;
  readonly originX: number;
  readonly originZ: number;
  readonly nx: number;
  readonly nz: number;
  /** ln z₀ of what stands at each node (cover and buildings), nx·nz, index i + j·nx. */
  readonly lnZ0: Float32Array;
  /** ln z₀ weighted over the upwind fetch, one array per direction k (the wind blowing toward
   *  angle 2πk/16 from +X, counter-clockwise from above). */
  readonly eff: Float32Array[];
  /** ln z₀ beyond the grid. */
  readonly outsideLn: number;
}

/** A uniform class, or a map. */
export type Terrain = TerrainClass | RoughnessField;

/** A field posted to a worker: the field itself the first time, then only its version. */
export type TerrainMsg = Terrain | { readonly ref: number };

/** Sender side: the field when it is new to the receiver, else a reference. */
export class TerrainSender {
  private sent = -1;
  pack(t: Terrain): TerrainMsg {
    if (!isField(t)) return t;
    if (t.version === this.sent) return { ref: t.version };
    this.sent = t.version;
    return t;
  }
  reset(): void {
    this.sent = -1;
  }
}

/** Receiver side: the last field received. */
export class TerrainCache {
  private last: RoughnessField | null = null;
  resolve(m: TerrainMsg): Terrain {
    if (typeof m === "string") return m;
    if ("ref" in m) {
      if (!this.last || this.last.version !== m.ref) throw new Error(`roughness field ${m.ref} was never received`);
      return this.last;
    }
    this.last = m;
    return m;
  }
}

export const isField = (t: Terrain | TerrainMsg): t is RoughnessField => typeof t === "object" && "kind" in t;

/** Macdonald et al. (1998) roughness length of an obstacle array (m). */
export function macdonaldZ0(lambdaP: number, lambdaF: number, h: number): number {
  if (!(lambdaP > 0) || !(lambdaF > 0) || !(h > 0)) return 0;
  const { A, betaM, cd, kappa } = TERRAIN.macdonald;
  const dh = 1 + Math.pow(A, -lambdaP) * (lambdaP - 1);
  const k = 0.5 * betaM * (cd / (kappa * kappa)) * (1 - dh) * lambdaF;
  return h * (1 - dh) * Math.exp(-1 / Math.sqrt(k));
}

/** Power-law exponent for a roughness length (Spec 17): 0.11 / 0.22 / 0.33 at 0.03 / 0.3 / 3 m. */
export function betaFromZ0(z0: number): number {
  return betaFromLnZ0(Math.log(z0));
}

const LN10 = Math.LN10;
const LN_REF = Math.log(TERRAIN.beta.z0Ref);
export function betaFromLnZ0(lnZ0: number): number {
  const b = TERRAIN.beta;
  const v = b.ref + (b.perDecade * (lnZ0 - LN_REF)) / LN10;
  return v < b.min ? b.min : v > b.max ? b.max : v;
}

/** The class a roughness length falls in (Spec 17 bounds). */
export function terrainClassOf(z0: number): TerrainClass {
  return z0 >= TERRAIN.classBounds.urban ? "urban" : z0 >= TERRAIN.classBounds.suburban ? "suburban" : "open";
}

const LN_CLASS = {
  open: Math.log(TERRAIN.classZ0.open),
  suburban: Math.log(TERRAIN.classZ0.suburban),
  urban: Math.log(TERRAIN.classZ0.urban),
};

/** A per-class table read at z₀: linear in log z₀ between the class values, flat outside. */
export function interpByZ0(table: Readonly<Record<TerrainClass, number>>, z0: number): number {
  const l = Math.log(z0);
  if (l <= LN_CLASS.open) return table.open;
  if (l >= LN_CLASS.urban) return table.urban;
  if (l <= LN_CLASS.suburban) {
    const t = (l - LN_CLASS.open) / (LN_CLASS.suburban - LN_CLASS.open);
    return table.open + t * (table.suburban - table.open);
  }
  const t = (l - LN_CLASS.suburban) / (LN_CLASS.urban - LN_CLASS.suburban);
  return table.suburban + t * (table.urban - table.suburban);
}

/** Bilinear read of a node array at (x, z); nodes beyond the grid read `outside`. */
function sample(f: RoughnessField, a: Float32Array, x: number, z: number): number {
  if (f.nx === 1 && f.nz === 1) return a[0]!;
  const gx = (x - f.originX) / f.cell;
  const gz = (z - f.originZ) / f.cell;
  if (!(gx >= 0 && gz >= 0 && gx <= f.nx - 1 && gz <= f.nz - 1)) {
    // Within one cell of the edge, blend toward the outside value; beyond it, outside.
    if (gx < -1 || gz < -1 || gx > f.nx || gz > f.nz || !Number.isFinite(gx + gz)) return f.outsideLn;
  }
  const i0 = Math.floor(gx);
  const j0 = Math.floor(gz);
  const tx = gx - i0;
  const tz = gz - j0;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= f.nx || j >= f.nz ? f.outsideLn : a[i + j * f.nx]!);
  const a0 = at(i0, j0) + tx * (at(i0 + 1, j0) - at(i0, j0));
  const a1 = at(i0, j0 + 1) + tx * (at(i0 + 1, j0 + 1) - at(i0, j0 + 1));
  return a0 + tz * (a1 - a0);
}

const TWO_PI = 2 * Math.PI;

/** ln of the fetch-weighted z₀ at (x, z) for wind blowing toward angle dir (rad). */
export function effLnZ0(f: RoughnessField, x: number, z: number, dir: number): number {
  const n = f.eff.length;
  let s = (dir / TWO_PI) * n;
  s -= Math.floor(s / n) * n;
  const k0 = Math.floor(s) % n;
  const t = s - Math.floor(s);
  const a = sample(f, f.eff[k0]!, x, z);
  return t === 0 ? a : a + t * (sample(f, f.eff[(k0 + 1) % n]!, x, z) - a);
}

/** β the wind feels at (x, z) blowing toward dir (rad). */
export function betaAt(t: Terrain, x: number, z: number, dir: number): number {
  if (!isField(t)) return TERRAIN_BETA[t];
  return betaFromLnZ0(effLnZ0(t, x, z, dir));
}

/** Local z₀ of what stands at (x, z) (m). */
export function z0At(t: Terrain, x: number, z: number): number {
  if (!isField(t)) return TERRAIN.classZ0[t];
  return Math.exp(sample(t, t.lnZ0, x, z));
}

/** Fetch-weighted z₀ at (x, z) for wind blowing toward dir (m). */
export function effZ0At(t: Terrain, x: number, z: number, dir: number): number {
  if (!isField(t)) return TERRAIN.classZ0[t];
  return Math.exp(effLnZ0(t, x, z, dir));
}

/** A uniform field at one z₀ (m), the grid a single node (Spec 17 TERR-07). */
export function uniformField(z0: number, version = 1): RoughnessField {
  const l = Math.log(z0);
  return {
    kind: "field",
    version,
    cell: TERRAIN.cell,
    originX: 0,
    originZ: 0,
    nx: 1,
    nz: 1,
    lnZ0: Float32Array.of(l),
    eff: Array.from({ length: TERRAIN.directions }, () => Float32Array.of(l)),
    outsideLn: l,
  };
}

// ---- Building the field ----

/** What a building adds to the roughness (Spec 17). */
export interface Obstacle {
  x: number;
  z: number;
  /** Standing footprint (m²). */
  footprint: number;
  /** Mean frontal area over wind directions (m²). */
  frontal: number;
  /** Standing height (m). */
  height: number;
  /** Rubble footprint (m²). */
  rubble: number;
}

/** Ground cover: a base cover and rectangles over it (later ones win). */
export interface GroundCover {
  base: CoverKind;
  rects: readonly { x0: number; z0: number; x1: number; z1: number; kind: CoverKind }[];
  /** Area the grid must cover (before its margin); default the rects and the buildings. */
  bounds?: { x0: number; z0: number; x1: number; z1: number };
}

export function coverAt(c: GroundCover, x: number, z: number): CoverKind {
  let k = c.base;
  for (const r of c.rects) if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) k = r.kind;
  return k;
}

/**
 * The mutable builder behind a field: per-node building sums and cover, so failed buildings
 * update it incrementally. Owned by the sim; `field` is what everyone reads.
 */

export class RoughnessBuilder {
  /** The current field. Each rebuild makes a new one (versions are immutable). */
  field: RoughnessField;
  private nextVersion = 1;
  private readonly geom: { cell: number; originX: number; originZ: number; nx: number; nz: number; outsideLn: number };
  private readonly cover: Float32Array;
  private readonly foot: Float64Array;
  private readonly front: Float64Array;
  private readonly hFoot: Float64Array;
  private readonly rubble: Float64Array;
  private readonly dirs: { ux: number; uz: number }[];
  private readonly half: number;

  constructor(cover: GroundCover, bounds: { x0: number; z0: number; x1: number; z1: number }) {
    const cell = TERRAIN.cell;
    const m = TERRAIN.margin;
    const originX = Math.floor((bounds.x0 - m) / cell) * cell;
    const originZ = Math.floor((bounds.z0 - m) / cell) * cell;
    const nx = Math.ceil((bounds.x1 + m - originX) / cell) + 1;
    const nz = Math.ceil((bounds.z1 + m - originZ) / cell) + 1;
    const n = nx * nz;
    const outsideLn = Math.log(TERRAIN.z0Cover[cover.base]);
    this.geom = { cell, originX, originZ, nx, nz, outsideLn };
    this.field = this.blank();
    this.cover = new Float32Array(n);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) this.cover[i + j * nx] = Math.log(TERRAIN.z0Cover[coverAt(cover, originX + i * cell, originZ + j * cell)]);
    }
    this.foot = new Float64Array(n);
    this.front = new Float64Array(n);
    this.hFoot = new Float64Array(n);
    this.rubble = new Float64Array(n);
    this.half = Math.floor(TERRAIN.window / cell / 2);
    this.dirs = Array.from({ length: TERRAIN.directions }, (_, k) => {
      const a = (k / TERRAIN.directions) * TWO_PI;
      return { ux: Math.cos(a), uz: Math.sin(a) };
    });
  }

  private blank(): RoughnessField {
    const n = this.geom.nx * this.geom.nz;
    return { kind: "field", version: 0, ...this.geom, lnZ0: new Float32Array(n), eff: Array.from({ length: TERRAIN.directions }, () => new Float32Array(n)) };
  }

  private node(x: number, z: number): number {
    const f = this.field;
    const i = Math.round((x - f.originX) / f.cell);
    const j = Math.round((z - f.originZ) / f.cell);
    if (i < 0 || j < 0 || i >= f.nx || j >= f.nz) return -1;
    return i + j * f.nx;
  }

  /** Add (sign +1) or remove (−1) an obstacle's sums. */
  apply(o: Obstacle, sign: 1 | -1): void {
    const q = this.node(o.x, o.z);
    if (q < 0) return;
    this.foot[q] = this.foot[q]! + sign * o.footprint;
    this.front[q] = this.front[q]! + sign * o.frontal;
    this.hFoot[q] = this.hFoot[q]! + sign * o.height * o.footprint;
    this.rubble[q] = this.rubble[q]! + sign * o.rubble;
  }

  /** Recompute local z₀ everywhere and the fetch fields; bumps the version. */
  rebuild(): void {
    this.field = this.blank();
    this.localAll();
    this.fetch();
    this.field.version = this.nextVersion++;
  }

  private localAll(): void {
    const f = this.field;
    const { nx, nz } = f;
    const h = this.half;
    const area = TERRAIN.window * TERRAIN.window;
    const winNodes = (2 * h + 1) * (2 * h + 1);
    const lnRubble = Math.log(TERRAIN.z0Rubble);
    // Summed-area tables (exclusive) of the per-node sums.
    const W = nx + 1;
    const sat = (src: Float64Array | Float32Array) => {
      const t = new Float64Array(W * (nz + 1));
      for (let j = 0; j < nz; j++) {
        let row = 0;
        for (let i = 0; i < nx; i++) {
          row += src[i + j * nx]!;
          t[i + 1 + (j + 1) * W] = t[i + 1 + j * W]! + row;
        }
      }
      return t;
    };
    const sFoot = sat(this.foot);
    const sFront = sat(this.front);
    const sH = sat(this.hFoot);
    const sRub = sat(this.rubble);
    const sCov = sat(this.cover);
    const box = (t: Float64Array, i: number, j: number) => {
      const a = Math.max(i - h, 0);
      const b = Math.max(j - h, 0);
      const c = Math.min(i + h + 1, nx);
      const d = Math.min(j + h + 1, nz);
      return t[c + d * W]! - t[a + d * W]! - t[c + b * W]! + t[a + b * W]!;
    };
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        // Window nodes past the grid edge count as outside cover with no buildings.
        const a = Math.max(i - h, 0);
        const b = Math.max(j - h, 0);
        const c = Math.min(i + h + 1, nx);
        const d = Math.min(j + h + 1, nz);
        const inside = (c - a) * (d - b);
        const lnCover = (box(sCov, i, j) + (winNodes - inside) * f.outsideLn) / winNodes;
        const foot = box(sFoot, i, j);
        const rub = box(sRub, i, j);
        const fr = Math.min(1, Math.max(0, rub) / (TERRAIN.rubbleFullFraction * area));
        let ln = (1 - fr) * lnCover + fr * lnRubble;
        if (foot > 1e-9) {
          const zb = macdonaldZ0(foot / area, box(sFront, i, j) / area, box(sH, i, j) / foot);
          if (zb > 0) ln = Math.max(ln, Math.log(zb));
        }
        f.lnZ0[i + j * nx] = ln;
      }
    }
  }

  /**
   * Fetch weighting for each direction: E(x) = a·E(x − Δû) + (1 − a)·lnZ0(x), a = exp(−Δ/L),
   * with Δ = √2·cell. The upstream point is at a fixed grid offset, so its bilinear weights are
   * the same everywhere, and sweeping rows and columns from the upwind side reads only nodes
   * already done (Δ = √2·cell keeps the node itself out of its own stencil).
   */
  private fetch(): void {
    const f = this.field;
    const { nx, nz, cell, outsideLn: out } = f;
    const step = Math.SQRT2 * cell;
    const a = Math.exp(-step / TERRAIN.fetchLength);
    const b1 = 1 - a;
    const g = step / cell;
    const L = f.lnZ0;
    for (let k = 0; k < this.dirs.length; k++) {
      const { ux, uz } = this.dirs[k]!;
      const E = f.eff[k]!;
      const ox = -ux * g;
      const oz = -uz * g;
      const fi = Math.floor(ox + 1e-9);
      const fj = Math.floor(oz + 1e-9);
      const tx = Math.max(0, ox - fi);
      const tz = Math.max(0, oz - fj);
      const w00 = (1 - tx) * (1 - tz);
      const w10 = tx > 1e-12 ? tx * (1 - tz) : 0;
      const w01 = tz > 1e-12 ? (1 - tx) * tz : 0;
      const w11 = tx > 1e-12 && tz > 1e-12 ? tx * tz : 0;
      const iUp = ox <= 0; // sweep i ascending when the upstream point is to the −X side
      const jUp = oz <= 0;
      const at = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= nz ? out : E[i + j * nx]!);
      for (let jj = 0; jj < nz; jj++) {
        const j = jUp ? jj : nz - 1 - jj;
        const j0 = j + fj;
        const rowIn = j0 >= 0 && j0 + 1 < nz;
        for (let ii = 0; ii < nx; ii++) {
          const i = iUp ? ii : nx - 1 - ii;
          const i0 = i + fi;
          const p = i + j * nx;
          let up: number;
          if (rowIn && i0 >= 0 && i0 + 1 < nx) {
            const q = i0 + j0 * nx;
            up = w00 * E[q]! + w10 * E[q + 1]! + w01 * E[q + nx]! + w11 * E[q + nx + 1]!;
          } else {
            up = w00 * at(i0, j0) + (w10 && w10 * at(i0 + 1, j0)) + (w01 && w01 * at(i0, j0 + 1)) + (w11 && w11 * at(i0 + 1, j0 + 1));
          }
          E[p] = a * up + b1 * L[p]!;
        }
      }
    }
  }
}

/** A per-class table (Spec 04's debris tables) at (x, z): the class's own value, or read at the
 *  field's local z₀ there. */
export function tableAt(table: Readonly<Record<TerrainClass, number>>, t: Terrain, x: number, z: number): number {
  return isField(t) ? interpByZ0(table, z0At(t, x, z)) : table[t];
}
