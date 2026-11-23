/**
 * Peak ground-relative horizontal speed near the tornado at a given height, found by
 * sampling a polar grid around the core. Used for the EF readout (INST-02).
 */
import { EF_REFERENCE_HEIGHT } from "../../config/wind";
import { windAt } from "./windField";
import type { TerrainClass, TornadoState } from "./types";

const RADIUS_FACTORS = [0.6, 0.7, 0.8, 0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.4, 1.7, 2.0];
const ANGLES = 48;

export function peakGroundSpeed(
  s: TornadoState,
  terrain: TerrainClass,
  height = EF_REFERENCE_HEIGHT,
): number {
  let best = Math.hypot(s.velocity.x, s.velocity.z);
  if (s.vMax <= 0) return best;
  for (const f of RADIUS_FACTORS) {
    const r = f * s.rMax;
    for (let i = 0; i < ANGLES; i++) {
      const a = (i / ANGLES) * Math.PI * 2;
      const w = windAt(
        { x: s.center.x + r * Math.cos(a), y: height, z: s.center.z + r * Math.sin(a) },
        s,
        terrain,
      );
      const v = Math.hypot(w.x, w.z);
      if (v > best) best = v;
    }
  }
  return best;
}
