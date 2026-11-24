/**
 * The simulated world (Spec 08 v1.2): the neighborhood and its damage state.
 */
import { DAMAGE_RANGE_RMAX } from "../config/buildings";
import { MS_PER_MPH } from "../config/units";
import { updateBuilding } from "../core/damage/building";
import type { Building, FailureRecord } from "../core/damage/types";
import { pressureDeficit } from "../core/wind/pressure";
import type { TerrainClass, TornadoState } from "../core/wind/types";
import { windAt } from "../core/wind/windField";
import { generateNeighborhood } from "./city";

export interface World {
  readonly buildings: readonly Building[];
  buildingAt(x: number, z: number): Building | null;
  /** Increases whenever any building's damage changes. */
  readonly version: number;
  /** Count of buildings at each DOD 0–10. */
  readonly histogram: readonly number[];
  /** Set a detailed house's surveyed DOD (Spec 09 slice B). */
  setDod(b: Building, dod: number): void;
  update(
    dt: number,
    s: TornadoState,
    terrain: TerrainClass,
    time: number,
    onFail?: (b: Building, rec: FailureRecord) => void,
  ): void;
}

export function createWorld(seed: number, withBuildings = true): World {
  const hood = withBuildings ? generateNeighborhood(seed) : { buildings: [] as Building[], buildingAt: () => null };
  const histogram = new Array<number>(11).fill(0);
  histogram[0] = hood.buildings.length;
  let version = 0;
  const p = { x: 0, y: 0, z: 0 };

  return {
    buildings: hood.buildings,
    buildingAt: hood.buildingAt,
    get version() {
      return version;
    },
    histogram,
    setDod(b, dod) {
      if (dod === b.dod) return;
      histogram[b.dod]!--;
      histogram[dod]!++;
      b.dod = dod;
      b.rev++;
      version++;
    },
    update(dt, s, terrain, time, onFail) {
      const range = DAMAGE_RANGE_RMAX * s.rMax;
      const active = s.vMax > 0;
      let changed = false;
      for (const b of hood.buildings) {
        if (b.dod >= 10 && !b.detail) continue;
        const r = Math.hypot(b.x - s.center.x, b.z - s.center.z);
        if (b.detail) {
          // The detail engine owns its damage; the inspector still shows its peak wind.
          if (active && r <= range) {
            p.x = b.x;
            p.y = b.roofHeight;
            p.z = b.z;
            const w = windAt(p, s, terrain);
            b.peakMph = Math.max(b.peakMph, Math.hypot(w.x, w.y, w.z) / MS_PER_MPH);
          }
          continue;
        }
        // Far houses feel only the translation wind; keep updating only while venting.
        if ((!active || r > range) && b.deficitIn < 1) continue;
        p.x = b.x;
        p.y = b.roofHeight;
        p.z = b.z;
        const before = b.dod;
        const cb = onFail ? (rec: FailureRecord) => onFail(b, rec) : undefined;
        if (updateBuilding(b, windAt(p, s, terrain), pressureDeficit(r, s), dt, time, cb)) {
          changed = true;
          if (b.dod !== before) {
            histogram[before]!--;
            histogram[b.dod]!++;
          }
        }
      }
      if (changed) version++;
    },
  };
}
