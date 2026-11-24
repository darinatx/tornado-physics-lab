/**
 * Point measurement for the inspect probe (Spec 07, INST-04). Pure.
 */
import { AIR_DENSITY } from "../../config/atmosphere";
import type { Vec3 } from "../math/vec";
import { efRating, msToMph } from "./efScale";
import type { EFRating } from "./efScale";
import { pressureDeficit } from "./pressure";
import type { TerrainClass, TornadoState } from "./types";
import { carriedFactors, envFactor, windAt } from "./windField";

export interface ProbeReading {
  point: Vec3;
  /** Ground-relative horizontal speed (m/s). */
  speed: number;
  mph: number;
  ef: EFRating | null;
  /** Direction the wind blows FROM, degrees clockwise from north (meteorological). */
  fromDeg: number;
  /** Storm-relative swirl around the axis (m/s); positive = cyclonic. */
  tangential: number;
  /** Storm-relative radial flow (m/s); negative = inward. */
  radial: number;
  /** Vertical flow (m/s); positive = up. */
  vertical: number;
  /** Pressure drop below ambient (Pa). */
  pressureDeficit: number;
  /** Dynamic pressure ½ρV² from the full 3D ground-relative wind (Pa). */
  dynamicPressure: number;
  /** Distance from the vortex axis (m). */
  distance: number;
  inCore: boolean;
  side: "left" | "right" | "center";
}

export function probeAt(p: Vec3, s: TornadoState, terrain: TerrainClass): ProbeReading {
  const w = windAt(p, s, terrain);
  const speed = Math.hypot(w.x, w.z);
  const dx = p.x - s.center.x;
  const dz = p.z - s.center.z;
  const r = Math.hypot(dx, dz);

  // Storm-relative components in the cylindrical frame (the carried wind removed).
  const carried = envFactor(p.y, terrain) * carriedFactors(r, s);
  const sx = w.x - carried * s.velocity.x;
  const sz = w.z - carried * s.velocity.z;
  let tangential = 0;
  let radial = 0;
  if (r > 1e-9) {
    const ux = dx / r;
    const uz = dz / r;
    radial = sx * ux + sz * uz;
    tangential = (sx * uz - sz * ux); // projection on the cyclonic unit (uz, −ux)
  }

  // North is −Z, east is +X. Bearing the wind blows toward, then flip to "from".
  const toward = (Math.atan2(w.x, -w.z) * 180) / Math.PI;
  const fromDeg = (((toward + 180) % 360) + 360) % 360;

  // Side of the path: right = velocity × up = (−v.z, v.x) on the ground plane.
  const vmag = Math.hypot(s.velocity.x, s.velocity.z);
  let side: ProbeReading["side"] = "center";
  if (vmag > 1e-9 && r > 1e-6) {
    const rightDot = (dx * -s.velocity.z + dz * s.velocity.x) / vmag;
    side = Math.abs(rightDot) < 1e-6 ? "center" : rightDot > 0 ? "right" : "left";
  }

  return {
    point: { ...p },
    speed,
    mph: msToMph(speed),
    ef: efRating(speed),
    fromDeg,
    tangential,
    radial,
    vertical: w.y,
    pressureDeficit: pressureDeficit(r, s),
    dynamicPressure: 0.5 * AIR_DENSITY * (w.x * w.x + w.y * w.y + w.z * w.z),
    distance: r,
    inCore: r < s.rMax,
    side,
  };
}
