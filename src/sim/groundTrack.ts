/**
 * Ground damage tracks (Spec 19): a sparse grid of 2 m cells near the core recording each
 * cell's peak 2 m wind and its direction, a scour dose, and debris marks. The state (lodged,
 * pushed over, thinned, stripped, bare soil) follows from those; the renderer only reads it.
 */
import { TERRAIN, TRACK } from "../config/terrain";
import type { CoverKind } from "../config/terrain";
import { coverAt } from "../core/terrain/roughness";
import type { GroundCover, Terrain } from "../core/terrain/roughness";
import type { Piece } from "../core/debris/piece";
import type { TornadoState } from "../core/wind/types";
import { carriedFactors, outerReach, overshootFactor, tangentialProfile, windAt } from "../core/wind/windField";

/** Cell states, in order of damage (they never go back). */
export const TRACK_STATE = { standing: 0, pushedOver: 1, lodged: 2, snapped: 3, thinned: 4, stripped: 5, bare: 6 } as const;
const COVER_CODE: Record<CoverKind, number> = { farmland: 0, lawn: 1, pavement: 2 };
const COVER_OF = ["farmland", "lawn", "pavement"] as const;

const N = TRACK.tile;
const CELLS = N * N;
const TILE_M = N * TRACK.cell;
/** Lattice blocks per tile side, and cells per block side (the lattice divides the tile). */
const BLOCKS = TILE_M / TRACK.lattice;
const PER = TRACK.lattice / TRACK.cell;
/** Blocks beyond 1.5·R_max update every this many passes. */
const OUTER_EVERY = 4;
/** Beyond 3·R_max (the slowest-changing wind) every this many passes. */
const FAR_EVERY = 8;

export interface TrackTile {
  /** Tile coordinates (tile i covers x in [i·64, (i+1)·64) m). */
  readonly ti: number;
  readonly tj: number;
  /** Per cell, index cx + cz·32 (cell centre at x = ti·64 + (cx + 0.5)·2). */
  readonly peak: Float32Array;
  /** Direction the wind blew toward at its peak, 0–255 over a full turn from +X toward +Z. */
  readonly dir: Uint8Array;
  readonly dose: Float32Array;
  readonly state: Uint8Array;
  /** Debris mark darkness, 0–255. */
  readonly mark: Uint8Array;
  readonly cover: Uint8Array;
  /** Per 8 m lattice block (8 × 8 per tile): the lowest peak among its cells, so a block whose
   *  wind can't beat any of them (and can't scour) is skipped. */
  readonly blockMin: Float32Array;
  /** Each cell's own plant and soil strength factors (`cellStrength`), fixed at creation. */
  readonly kv: Float32Array;
  readonly ks: Float32Array;
  /** Increases whenever anything in the tile changes. */
  version: number;
}

const key = (ti: number, tj: number) => (ti + 32768) * 65536 + (tj + 32768);

/** Scour dose rate (per s) at 2 m wind u with debris load φ (kg/m²): Spec 19's aeolian form. */
export function scourRate(u: number, phi: number): number {
  const us = TRACK.scourOnset;
  if (!(u > us)) return 0;
  const k = u / us;
  return k * k * k * (1 - 1 / (k * k)) * (1 + TRACK.debrisWeight * phi);
}

/**
 * The state a cell is in for its cover, peak wind and dose (before the never-go-back rule).
 * kv scales the plants' thresholds and ks the soil's (the cell's own strength, `cellStrength`).
 */
export function stateFor(cover: number, peak: number, dose: number, kv = 1, ks = 1): number {
  const d = TRACK.dose;
  if (cover === COVER_CODE.pavement) return TRACK_STATE.standing;
  if (dose >= d.bare * ks) return TRACK_STATE.bare;
  if (dose >= d.stripped * ks) return TRACK_STATE.stripped;
  if (dose >= d.thinned * ks) return TRACK_STATE.thinned;
  if (cover === COVER_CODE.farmland) {
    if (peak >= TRACK.cropSnap * kv) return TRACK_STATE.snapped;
    if (peak >= TRACK.cropLodge * kv) return TRACK_STATE.lodged;
  } else if (peak >= TRACK.lawnFlatten * kv) return TRACK_STATE.pushedOver;
  return TRACK_STATE.standing;
}

/** Hash of an integer lattice point and channel to [0, 1). */
function hash01(x: number, z: number, n: number): number {
  let h = Math.imul(x ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul(z + n * 0x632be5ab, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1) at a lattice spacing of `scale` cells (bilinear, smoothstepped). */
function valueNoise(gx: number, gz: number, scale: number, n: number): number {
  const fx = gx / scale;
  const fz = gz / scale;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  let tx = fx - ix;
  let tz = fz - iz;
  tx = tx * tx * (3 - 2 * tx);
  tz = tz * tz * (3 - 2 * tz);
  const a = hash01(ix, iz, n) + tx * (hash01(ix + 1, iz, n) - hash01(ix, iz, n));
  const b = hash01(ix, iz + 1, n) + tx * (hash01(ix + 1, iz + 1, n) - hash01(ix, iz + 1, n));
  return a + tz * (b - a);
}

/**
 * A cell's own plant (kv) and soil (ks) strength factors, 1 ± variation, fixed by its global cell
 * position (deterministic; no draw from any RNG stream). Mostly smooth patches ~24 m across
 * (soil and crop variation comes in patches), with a little per-cell jitter.
 */
export function cellStrength(gx: number, gz: number): { kv: number; ks: number } {
  const v = TRACK.variation;
  const f = (n: number) => 0.85 * valueNoise(gx, gz, PATCH_CELLS, n) + 0.15 * hash01(gx, gz, n + 7);
  // The sum of a smoothed and a uniform value isn't uniform; stretch it back toward ±1.
  const s = (x: number) => Math.max(-1, Math.min(1, (2 * x - 1) * 1.6));
  return { kv: 1 + v.plants * s(f(1)), ks: 1 + v.soil * s(f(2)) };
}

/** Patch size of the strength variation, in cells (12 cells = 24 m). */
const PATCH_CELLS = 12;

const STATE_LN: number[] = (() => {
  const z = TRACK.z0;
  // standing uses the cover's own z0 (NaN here: looked up per cell).
  return [NaN, Math.log(z.pushedOver), Math.log(z.lodged), Math.log(z.snapped), Math.log(z.thinned), Math.log(z.stripped), Math.log(z.bare)];
})();
const COVER_LN = COVER_OF.map((c) => Math.log(TERRAIN.z0Cover[c]));

/** ln z0 of a cell in a state on a cover. */
export function cellLnZ0(state: number, cover: number): number {
  return state === TRACK_STATE.standing ? COVER_LN[cover]! : STATE_LN[state]!;
}

export class GroundTrack {
  private readonly map = new Map<number, TrackTile>();
  /** Tiles in creation order (deterministic iteration). */
  readonly list: TrackTile[] = [];
  /** Increases whenever any tile changes. */
  version = 0;
  private lattice: Float64Array = new Float64Array(0);
  private updates = 0;

  constructor(private readonly cover: GroundCover) {}

  tile(ti: number, tj: number): TrackTile | undefined {
    return this.map.get(key(ti, tj));
  }

  private ensure(ti: number, tj: number): TrackTile {
    const k = key(ti, tj);
    let t = this.map.get(k);
    if (!t) {
      const cover = new Uint8Array(CELLS);
      for (let cz = 0; cz < N; cz++) {
        for (let cx = 0; cx < N; cx++) {
          cover[cx + cz * N] = COVER_CODE[coverAt(this.cover, ti * TILE_M + (cx + 0.5) * TRACK.cell, tj * TILE_M + (cz + 0.5) * TRACK.cell)];
        }
      }
      const kv = new Float32Array(CELLS);
      const ks = new Float32Array(CELLS);
      for (let c = 0; c < CELLS; c++) {
        const k = cellStrength(ti * N + (c % N), tj * N + Math.floor(c / N));
        kv[c] = k.kv;
        ks[c] = k.ks;
      }
      t = { ti, tj, peak: new Float32Array(CELLS), dir: new Uint8Array(CELLS), dose: new Float32Array(CELLS), state: new Uint8Array(CELLS), mark: new Uint8Array(CELLS), cover, blockMin: new Float32Array(BLOCKS * BLOCKS), kv, ks, version: 0 };
      this.map.set(k, t);
      this.list.push(t);
    }
    return t;
  }

  /** The cell at (x, z), or null where the track never reached. */
  cellAt(x: number, z: number): { peak: number; dirRad: number; dose: number; state: number; mark: number; cover: CoverKind } | null {
    const ti = Math.floor(x / TILE_M);
    const tj = Math.floor(z / TILE_M);
    const t = this.tile(ti, tj);
    if (!t) return null;
    const cx = Math.min(N - 1, Math.floor((x - ti * TILE_M) / TRACK.cell));
    const cz = Math.min(N - 1, Math.floor((z - tj * TILE_M) / TRACK.cell));
    const c = cx + cz * N;
    return { peak: t.peak[c]!, dirRad: (t.dir[c]! / 256) * 2 * Math.PI, dose: t.dose[c]!, state: t.state[c]!, mark: t.mark[c]!, cover: COVER_OF[t.cover[c]!]! };
  }

  /**
   * How far from the axis the 2 m wind can reach the weakest cell's lowest threshold (m): the
   * first radius where an upper bound on the 2 m wind (swirl with its overshoot, inflow, and the
   * full carried wind, with the smoothest terrain's height factor) drops below it. No fixed cap
   * (a 3·R_max cap cut strong tracks off along a straight line); 10·R_max as a safety limit.
   */
  static activeRadius(s: TornadoState): number {
    if (!(s.vMax > 0)) return 0;
    const umin = Math.min(TRACK.cropLodge, TRACK.lawnFlatten) * (1 - TRACK.variation.plants);
    const R = Math.max(s.rMax, 1e-6);
    const hf = Math.pow(TRACK.sampleHeight / s.zPeak, 0.08) * 1.0001; // β ≥ 0.08 (Spec 17 clamp)
    const vtr = Math.hypot(s.velocity.x, s.velocity.z);
    const bound = (r: number) => {
      const vt = tangentialProfile(r, s.vMax, R, s.alpha, outerReach(s));
      return Math.hypot(vt * overshootFactor(r, s) * hf, s.inflowRatio * vt) + carriedFactors(r, s) * vtr;
    };
    if (bound(R) < umin) return 0;
    for (let r = R; r <= 10 * R; r += 0.1 * R) if (bound(r) < umin) return r + 0.1 * R;
    return 10 * R;
  }

  /** One update over dt seconds of sim time (Spec 19). */
  update(dt: number, s: TornadoState, terrain: Terrain, debris: readonly Piece[]): void {
    if (s.tunnel) return;
    const R = GroundTrack.activeRadius(s);
    if (R <= 0) return;
    const L = TRACK.lattice;
    const cx0 = s.center.x;
    const cz0 = s.center.z;
    // The fine lattice covers the near zone (≤ 3·R_max); beyond it, `farZone` (coarser).
    const Rn = Math.min(R, 3 * s.rMax + L);
    const i0 = Math.floor((cx0 - Rn) / L);
    const i1 = Math.ceil((cx0 + Rn) / L);
    const j0 = Math.floor((cz0 - Rn) / L);
    const j1 = Math.ceil((cz0 + Rn) / L);
    const nx = i1 - i0 + 1;
    const nz = j1 - j0 + 1;
    // Wind at 2 m on the lattice (x and z components), computed only where a block needs it.
    if (this.lattice.length < nx * nz * 2) this.lattice = new Float64Array(nx * nz * 2);
    const W = this.lattice;
    W.fill(NaN, 0, nx * nz * 2);
    const p = { x: 0, y: TRACK.sampleHeight, z: 0 };
    const at = (i: number, j: number): number => {
      const q = (i + j * nx) * 2;
      if (Number.isNaN(W[q]!)) {
        p.x = (i0 + i) * L;
        p.z = (j0 + j) * L;
        const w = windAt(p, s, terrain);
        W[q] = w.x;
        W[q + 1] = w.z;
      }
      return q;
    };
    // The outer ring (beyond 1.5·R_max) changes slowly: each block there updates every
    // OUTER_EVERY-th pass, staggered, with its dose over that longer interval.
    const n = this.updates++;
    const inner2 = (1.5 * s.rMax) ** 2;
    const far2 = (3 * s.rMax) ** 2;
    // Debris load per tile: flying mass below 3 m (kg/m²).
    const load = new Map<number, number>();
    for (const q of debris) {
      if (q.resting || q.grounded || q.pos.y > TRACK.debrisHeight) continue;
      const k = key(Math.floor(q.pos.x / TILE_M), Math.floor(q.pos.z / TILE_M));
      load.set(k, (load.get(k) ?? 0) + q.def.mass * q.represents);
    }
    const tileArea = TILE_M * TILE_M;
    const umin = Math.min(TRACK.cropLodge, TRACK.lawnFlatten);
    const per = PER;
    const R2 = R * R;
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const bxc = (i0 + i + 0.5) * L - cx0;
        const bzc = (j0 + j + 0.5) * L - cz0;
        const d2 = bxc * bxc + bzc * bzc;
        const every = d2 > far2 ? FAR_EVERY : d2 > inner2 ? OUTER_EVERY : 1;
        if (every > 1 && (n + i0 + i + j0 + j) % every !== 0) continue;
        const bdt = dt * every;
        if (d2 > far2) continue;
        const a = at(i, j);
        const b = at(i + 1, j);
        const c = at(i, j + 1);
        const d = at(i + 1, j + 1);
        const smax = Math.sqrt(Math.max(W[a]! * W[a]! + W[a + 1]! * W[a + 1]!, W[b]! * W[b]! + W[b + 1]! * W[b + 1]!, W[c]! * W[c]! + W[c + 1]! * W[c + 1]!, W[d]! * W[d]! + W[d + 1]! * W[d + 1]!));
        if (smax < umin) continue;
        const bx = (i0 + i) * L;
        const bz = (j0 + j) * L;
        // The block's tile and block index (the lattice is aligned with the tiles).
        const ti = Math.floor(bx / TILE_M);
        const tj = Math.floor(bz / TILE_M);
        const bi = Math.round((bx - ti * TILE_M) / L) + Math.round((bz - tj * TILE_M) / L) * BLOCKS;
        const existing = this.tile(ti, tj);
        // Interpolated wind never exceeds the corners': nothing here can change.
        if (existing && smax <= existing.blockMin[bi]! && smax <= TRACK.scourOnset) continue;
        const t = existing ?? this.ensure(ti, tj);
        const phi = (load.get(key(ti, tj)) ?? 0) / tileArea;
        const cx0b = Math.round((bx - ti * TILE_M) / TRACK.cell);
        const cz0b = Math.round((bz - tj * TILE_M) / TRACK.cell);
        let changed = false;
        let bmin = Infinity;
        for (let v = 0; v < per; v++) {
          const z = bz + (v + 0.5) * TRACK.cell;
          const tz = (v + 0.5) / per;
          for (let u = 0; u < per; u++) {
            const ci = cx0b + u + (cz0b + v) * N;
            const x = bx + (u + 0.5) * TRACK.cell;
            const dx = x - cx0;
            const dz = z - cz0;
            if (dx * dx + dz * dz <= R2) {
              const tx = (u + 0.5) / per;
              const wx = (1 - tz) * ((1 - tx) * W[a]! + tx * W[b]!) + tz * ((1 - tx) * W[c]! + tx * W[d]!);
              const wz = (1 - tz) * ((1 - tx) * W[a + 1]! + tx * W[b + 1]!) + tz * ((1 - tx) * W[c + 1]! + tx * W[d + 1]!);
              const sp = Math.sqrt(wx * wx + wz * wz);
              if (sp >= umin) {
                let cell = false;
                if (sp > t.peak[ci]!) {
                  t.peak[ci] = sp;
                  let ang = Math.atan2(wz, wx) / (2 * Math.PI);
                  ang -= Math.floor(ang);
                  t.dir[ci] = Math.round(ang * 256) & 255;
                  cell = true;
                }
                const rate = scourRate(sp, phi);
                if (rate > 0) {
                  t.dose[ci] = t.dose[ci]! + rate * bdt;
                  cell = true;
                }
                if (cell) {
                  const st = stateFor(t.cover[ci]!, t.peak[ci]!, t.dose[ci]!, t.kv[ci]!, t.ks[ci]!);
                  if (st > t.state[ci]!) t.state[ci] = st;
                  changed = true;
                }
              }
            }
            if (t.peak[ci]! < bmin) bmin = t.peak[ci]!;
          }
        }
        t.blockMin[bi] = bmin;
        if (changed) {
          t.version++;
          this.version++;
        }
      }
    }
    if (R > 3 * s.rMax) this.farZone(n, s, terrain, R, umin);
  }

  /**
   * The far zone (3·R_max to the active radius): one wind sample per 32 m patch serves its 16
   * blocks; each patch updates every FAR_EVERY-th pass, staggered.
   */
  private farZone(n: number, s: TornadoState, terrain: Terrain, R: number, umin: number): void {
    const P = TRACK.lattice * 4;
    const cx0 = s.center.x;
    const cz0 = s.center.z;
    const near2 = (3 * s.rMax) ** 2;
    const R2 = R * R;
    const p = { x: 0, y: TRACK.sampleHeight, z: 0 };
    for (let pj = Math.floor((cz0 - R) / P); pj <= Math.ceil((cz0 + R) / P); pj++) {
      for (let pi = Math.floor((cx0 - R) / P); pi <= Math.ceil((cx0 + R) / P); pi++) {
        if ((n + pi + pj) % FAR_EVERY !== 0) continue;
        const px = (pi + 0.5) * P - cx0;
        const pz = (pj + 0.5) * P - cz0;
        const d2 = px * px + pz * pz;
        if (d2 <= near2 || d2 > R2) continue;
        p.x = (pi + 0.5) * P;
        p.z = (pj + 0.5) * P;
        const w = windAt(p, s, terrain);
        const sp = Math.sqrt(w.x * w.x + w.z * w.z);
        if (sp < umin) continue;
        for (let bj = 0; bj < 4; bj++) for (let bi = 0; bi < 4; bi++) this.farBlock(pi * P + bi * TRACK.lattice, pj * P + bj * TRACK.lattice, w, sp);
      }
    }
  }

  /**
   * A block beyond 3·R_max: the wind there is smooth over hundreds of metres and below the scour
   * onset, so one sample at the block's centre serves its 16 cells (each still with its own
   * strength), and there is no dose to add.
   */
  private farBlock(bx: number, bz: number, w: { x: number; z: number }, sp: number): void {
    const ti = Math.floor(bx / TILE_M);
    const tj = Math.floor(bz / TILE_M);
    const bi = Math.round((bx - ti * TILE_M) / TRACK.lattice) + Math.round((bz - tj * TILE_M) / TRACK.lattice) * BLOCKS;
    const existing = this.tile(ti, tj);
    if (existing && sp <= existing.blockMin[bi]!) return;
    const t = existing ?? this.ensure(ti, tj);
    let ang = Math.atan2(w.z, w.x) / (2 * Math.PI);
    ang -= Math.floor(ang);
    const dir = Math.round(ang * 256) & 255;
    const cx0b = Math.round((bx - ti * TILE_M) / TRACK.cell);
    const cz0b = Math.round((bz - tj * TILE_M) / TRACK.cell);
    let changed = false;
    let bmin = Infinity;
    for (let v = 0; v < PER; v++) {
      for (let u = 0; u < PER; u++) {
        const ci = cx0b + u + (cz0b + v) * N;
        if (sp > t.peak[ci]!) {
          t.peak[ci] = sp;
          t.dir[ci] = dir;
          const st = stateFor(t.cover[ci]!, sp, t.dose[ci]!, t.kv[ci]!, t.ks[ci]!);
          if (st > t.state[ci]!) t.state[ci] = st;
          changed = true;
        }
        if (t.peak[ci]! < bmin) bmin = t.peak[ci]!;
      }
    }
    t.blockMin[bi] = bmin;
    if (changed) {
      t.version++;
      this.version++;
    }
  }

  /** A piece hit the open ground (Spec 19): a gouge sized by its footprint, darker for more momentum. */
  landing(p: Piece, speed: number): void {
    if (speed < TRACK.gougeSpeed) return;
    const half = Math.max(p.def.dims[0], p.def.dims[1]) / 2;
    const dark = Math.min(60, Math.round(6 * Math.log1p(p.def.mass * p.represents * speed)));
    this.stamp(p.pos.x, p.pos.z, half, dark);
  }

  /** A piece slid along the open ground from (x0, z0) to its position: a drag streak. */
  slide(p: Piece, x0: number, z0: number): void {
    if (Math.hypot(p.vel.x, p.vel.z) < TRACK.streakSpeed) return;
    const d = Math.hypot(p.pos.x - x0, p.pos.z - z0);
    if (d < 1e-3) return;
    // A faint streak: about 2/255 per kg·m dragged, saturating slowly.
    const dark = Math.min(8, Math.round(Math.log1p(p.def.mass * p.represents * d)));
    if (dark > 0) this.stamp(p.pos.x, p.pos.z, 0, dark);
  }

  private stamp(x: number, z: number, half: number, dark: number): void {
    const c = TRACK.cell;
    for (let gx = Math.floor((x - half) / c); gx <= Math.floor((x + half) / c); gx++) {
      for (let gz = Math.floor((z - half) / c); gz <= Math.floor((z + half) / c); gz++) {
        const ti = Math.floor(gx / N);
        const tj = Math.floor(gz / N);
        const t = this.ensure(ti, tj);
        const ci = gx - ti * N + (gz - tj * N) * N;
        const m = Math.min(255, t.mark[ci]! + dark);
        if (m !== t.mark[ci]) {
          t.mark[ci] = m;
          t.version++;
          this.version++;
        }
      }
    }
  }

  /**
   * Mean ln z0 of the ground cover over the square [x0, x1) × [z0, z1), the track's states where
   * it reached and the cover elsewhere; null if the track never reached it (Spec 19 → Spec 17).
   */
  coverLnZ0(x0: number, z0: number, x1: number, z1: number, baseLn: number): number | null {
    const c = TRACK.cell;
    let sum = 0;
    let n = 0;
    let any = false;
    for (let gz = Math.floor(z0 / c); gz < Math.ceil(z1 / c); gz++) {
      for (let gx = Math.floor(x0 / c); gx < Math.ceil(x1 / c); gx++) {
        const t = this.tile(Math.floor(gx / N), Math.floor(gz / N));
        n++;
        if (!t) {
          sum += baseLn;
          continue;
        }
        any = true;
        const ci = gx - t.ti * N + (gz - t.tj * N) * N;
        sum += cellLnZ0(t.state[ci]!, t.cover[ci]!);
      }
    }
    return any && n ? sum / n : null;
  }
}

export const TRACK_TILE_M = TILE_M;
