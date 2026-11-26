/**
 * The heavy-debris engine (Spec 04 v2.1): the heavy-debris world with its own copies of the
 * houses, driven by step messages from the sim, so it can run in a worker. In-process and in a
 * worker it gets the same messages in the same order, so its results are the same.
 */
import type { DebrisKindDef } from "../config/debris";
import type { Building } from "../core/damage/types";
import type { Piece } from "../core/debris/piece";
import type { Vec3 } from "../core/math/vec";
import type { TornadoState } from "../core/wind/types";
import { TerrainCache } from "../core/terrain/roughness";
import type { TerrainMsg } from "../core/terrain/roughness";
import { CITY } from "./city";
import { HeavyDebris } from "./heavyDebris";
import type { TownHit } from "./structureWorld";
import { townCopy } from "./townColliders";
import type { TownState } from "./townColliders";

/** A new heavy piece, as the sim sends it. */
export interface HeavyTake {
  /** The sim's key for it (in take order). */
  key: number;
  label: string;
  /** Box: length, width, thickness (m); mass (kg). */
  dims: [number, number, number];
  mass: number;
  pos: Vec3;
  q: [number, number, number, number];
  vel: Vec3;
  /** rad/s, if it starts spinning (a wall tipping over). */
  angVel?: Vec3;
  /** Index of the house it came from (−1: none). */
  source: number;
  time: number;
}

/** One debris step, from the sim to the engine. */
export interface HeavyStep {
  n: number;
  tornado: TornadoState;
  terrain: TerrainMsg;
  time: number;
  takes: HeavyTake[];
  /** Houses whose state changed since last sent. */
  town: TownState[];
}

/** Piece states in a result: moving (or still awake), resting (asleep), retired, lost. */
/** …and swept: carried off with a swept slab it lay on (Spec 04 v2.3). */
export const HEAVY_STATE = { moving: 0, resting: 1, retired: 2, lost: 3, swept: 4 } as const;
/** Floats per piece in `poses`: key, x, y, z, qx, qy, qz, qw, vx, vy, vz, state. */
export const HEAVY_STRIDE = 12;

export interface HeavyResult {
  n: number;
  /** Pieces whose pose or state changed this step, HEAVY_STRIDE floats each. */
  poses: Float32Array;
  hits: TownHit[];
  /** Wall time of the step (ms; not part of the results). */
  ms: number;
}

export class HeavyEngine {
  /** The roughness field as last received (Spec 17). */
  private readonly terrains = new TerrainCache();
  readonly debris: HeavyDebris;
  private readonly copies: Building[];
  private readonly grid = new Map<string, Building[]>();
  private readonly stubs = new Map<number, Piece>();
  private readonly lastState = new Map<number, number>();

  constructor(buildings: readonly Building[], dt: number) {
    // The engine's own copies, as each house stands (updated by the sim's town states).
    this.copies = buildings.map((b) => townCopy(b, { index: 0, detail: false, sweep: false, shift: null, panels: b.panels.map(() => false), panes: b.panes.map(() => false), garage: false, decks: b.sections.map(() => false), bays: b.bays.map(() => false) }));
    for (const c of this.copies) {
      c.rev = 0;
      const r = Math.hypot(c.width, c.depth) / 2 + 3;
      for (let i = Math.floor((c.x - r) / CITY.cell); i <= Math.floor((c.x + r) / CITY.cell); i++)
        for (let j = Math.floor((c.z - r) / CITY.cell); j <= Math.floor((c.z + r) / CITY.cell); j++) {
          const k = `${i},${j}`;
          const list = this.grid.get(k);
          if (list) list.push(c);
          else this.grid.set(k, [c]);
        }
    }
    this.debris = new HeavyDebris(this.copies, (x, z) => this.grid.get(`${Math.floor(x / CITY.cell)},${Math.floor(z / CITY.cell)}`) ?? NONE, dt);
  }

  step(msg: HeavyStep): HeavyResult {
    const t0 = performance.now();
    const swept: number[] = [];
    for (const st of msg.town) {
      const c = this.copies[st.index]!;
      const was = !!c.sweep.failed;
      townCopy(c, st, c);
      c.rev++;
      if (!was && c.sweep.failed) swept.push(st.index);
    }
    for (const t of msg.takes) {
      const p = stub(t);
      this.stubs.set(t.key, p);
      this.debris.take(p, t.source >= 0 ? this.copies[t.source]! : NOBODY, t.time);
    }
    // Swept this step: what lies on its slab goes with it, its own pieces that failed in this
    // same step included (the sweep's own debris is all light: Spec 04 v2.3).
    for (const i of swept) this.debris.sweep(i);
    this.debris.step(msg.tornado, this.terrains.resolve(msg.terrain), msg.time);
    const out: number[] = [];
    for (const [key, p] of this.stubs) {
      const state = p.settleNow ? (p.swept ? HEAVY_STATE.swept : p.hidden ? HEAVY_STATE.lost : HEAVY_STATE.retired) : p.resting ? HEAVY_STATE.resting : HEAVY_STATE.moving;
      // A resting piece doesn't move: sent once, as it comes to rest.
      if (state === HEAVY_STATE.resting && this.lastState.get(key) === HEAVY_STATE.resting) continue;
      this.lastState.set(key, state);
      out.push(key, p.pos.x, p.pos.y, p.pos.z, p.q[0], p.q[1], p.q[2], p.q[3], p.vel.x, p.vel.y, p.vel.z, state);
      if (state >= HEAVY_STATE.retired) {
        this.stubs.delete(key);
        this.lastState.delete(key);
      }
    }
    const hits = this.debris.hits.splice(0);
    return { n: msg.n, poses: new Float32Array(out), hits, ms: performance.now() - t0 };
  }

  dispose(): void {
    this.debris.dispose();
  }
}

const NONE: readonly Building[] = [];
const NOBODY = { id: -1, x: 0, z: 0 } as Building;

/** The engine's stand-in for a sim piece: what the heavy-debris world reads and writes. */
function stub(t: HeavyTake): Piece {
  const def = { label: t.label, dims: t.dims, mass: t.mass } as unknown as DebrisKindDef;
  return {
    id: t.key,
    kind: "wallPanel",
    def,
    pos: { ...t.pos },
    vel: { ...t.vel },
    ...(t.angVel ? { angVel: { ...t.angVel } } : {}),
    q: [...t.q] as [number, number, number, number],
    spin: 1,
    resting: false,
    snagged: false,
    snagDir: null,
    bornAt: t.time,
    restedAt: Infinity,
    represents: 1,
    color: 0,
    sourceId: -1,
    maxWindMet: 0,
    liftOn: true,
    liftRoll: 0,
    gust: { x: 0, y: 0, z: 0 },
    rigid: true,
  };
}
