/**
 * Dust tracers drawn as soft points (Spec 06, REND-07): the wind-lofted dust and debris cloud
 * at the base of the tornado. Shared by the simulator and the structure lab.
 */
import * as THREE from "three";
import type { TerrainClass, TornadoState } from "../core/wind/types";
import { DEFAULT_TRACER_OPTIONS, TracerField } from "./tracers";
import type { TracerOptions } from "./tracers";

function dustSprite(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.5)");
  grad.addColorStop(0.6, "rgba(255,255,255,0.15)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export interface DustLayer {
  readonly points: THREE.Points;
  /** Advance to sim time t (s); time going backwards (a restart) clears the dust. */
  update(t: number, s: TornadoState, terrain: TerrainClass, cloudBase: number): void;
  clear(): void;
}

/** Up to `count` tracers drawn `size` metres across; "emission" spreads them over the whole
 *  dust-lifting area with the count following the emission (town), "core" keeps a fixed count
 *  around the core (lab). */
export function createDustLayer(count: number, size: number, seed = 99, area: TracerOptions["area"] = "emission"): DustLayer {
  const tracers = new TracerField(count, seed, { ...DEFAULT_TRACER_OPTIONS, area });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(tracers.positions, 3));
  const tint = new Float32Array(count * 3);
  let h = 12345;
  for (let i = 0; i < count; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    const v = 0.75 + 0.35 * ((h >>> 8) / 16777216);
    tint[i * 3] = 0.2 * v;
    tint[i * 3 + 1] = 0.17 * v;
    tint[i * 3 + 2] = 0.14 * v;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(tint, 3));
  const points = new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      size,
      map: dustSprite(),
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  points.frustumCulled = false;
  let lastTime = 0;
  return {
    points,
    update(t, s, terrain, cloudBase) {
      const dt = t - lastTime;
      if (dt < 0) tracers.clear();
      tracers.update(Math.min(Math.max(dt, 0), 0.5), s, terrain, cloudBase);
      lastTime = t;
      // Only the tracers in use are uploaded and drawn.
      geo.setDrawRange(0, tracers.inUse);
      const attr = geo.attributes.position as THREE.BufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, tracers.inUse * 3);
      attr.needsUpdate = true;
    },
    clear() {
      tracers.clear();
      lastTime = 0;
      geo.attributes.position!.needsUpdate = true;
    },
  };
}
