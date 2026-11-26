/**
 * Samples the wind on a world-fixed grid around the tornado. Pure computation into
 * preallocated buffers, so the renderer only has to turn them into instance matrices.
 */
import { windAt } from "../core/wind/windField";
import type { TornadoState } from "../core/wind/types";
import type { Terrain } from "../core/terrain/roughness";

export interface ArrowFieldOptions {
  spacing: number;
  range: number;
  height: number;
}

export interface ArrowField {
  readonly side: number;
  readonly count: number;
  readonly x: Float32Array;
  readonly z: Float32Array;
  /** Rotation about +Y that maps +X onto the wind direction. */
  readonly angle: Float32Array;
  /** Horizontal ground-relative speed (m/s). */
  readonly speed: Float32Array;
}

export function createArrowField(opts: ArrowFieldOptions): ArrowField {
  const side = Math.floor((2 * opts.range) / opts.spacing) + 1;
  const count = side * side;
  return {
    side,
    count,
    x: new Float32Array(count),
    z: new Float32Array(count),
    angle: new Float32Array(count),
    speed: new Float32Array(count),
  };
}

export function computeArrowField(
  s: TornadoState,
  terrain: Terrain,
  opts: ArrowFieldOptions,
  out: ArrowField,
  /** Where the grid is centered (default the tornado's center; the lab uses its block). */
  center: { x: number; z: number } = s.center,
): void {
  const { spacing, range, height } = opts;
  // Snap to the world grid so arrows don't slide as the tornado moves.
  const x0 = Math.round((center.x - range) / spacing) * spacing;
  const z0 = Math.round((center.z - range) / spacing) * spacing;
  const p = { x: 0, y: height, z: 0 };
  let k = 0;
  for (let i = 0; i < out.side; i++) {
    for (let j = 0; j < out.side; j++) {
      p.x = x0 + i * spacing;
      p.z = z0 + j * spacing;
      const w = windAt(p, s, terrain);
      out.x[k] = p.x;
      out.z[k] = p.z;
      out.speed[k] = Math.hypot(w.x, w.z);
      out.angle[k] = Math.atan2(-w.z, w.x);
      k++;
    }
  }
}
