/**
 * The ground (Spec 17, Spec 06): farmland, lawn and pavement blended by a cover mask in one
 * ground material, and the roughness layer tinted into the same material. One surface, so
 * nothing lying on the ground can fight it for depth.
 */
import * as THREE from "three";
import { RENDER } from "../config/render";
import { TERRAIN } from "../config/terrain";
import type { CoverKind } from "../config/terrain";
import { coverAt, isField } from "../core/terrain/roughness";
import type { GroundCover, Terrain } from "../core/terrain/roughness";
import type { TornadoState } from "../core/wind/types";
import { fetchDirection } from "../core/wind/windField";
import { createRng } from "../sim/rng";
import { CITY } from "../sim/city";
import { TrackLayer } from "./groundTrackLayer";
import type { GroundTrack } from "../sim/groundTrack";

const canvas = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { c, g: c.getContext("2d")! };
};

function texture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Open country: field patchwork with crop rows, ~1 km tile, no roads (Spec 17). */
export function farmlandTexture(seed: number): THREE.CanvasTexture {
  const rng = createRng(seed);
  const size = 1024;
  const { c, g } = canvas(size, size);
  const palette = ["#4f5d36", "#5b6a3c", "#6b6a40", "#58663a", "#7a6f48", "#4a5733", "#66734a", "#73694a"];
  const n = 8;
  const cell = size / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      g.fillStyle = palette[Math.floor(rng() * palette.length)]!;
      g.fillRect(i * cell, j * cell, cell + 1, cell + 1);
      g.globalAlpha = 0.08;
      g.strokeStyle = rng() > 0.5 ? "#000" : "#fff";
      const vertical = rng() > 0.5;
      for (let r = 0; r < cell; r += 6) {
        g.beginPath();
        if (vertical) {
          g.moveTo(i * cell + r, j * cell);
          g.lineTo(i * cell + r, (j + 1) * cell);
        } else {
          g.moveTo(i * cell, j * cell + r);
          g.lineTo((i + 1) * cell, j * cell + r);
        }
        g.stroke();
      }
      g.globalAlpha = 1;
    }
  }
  return texture(c);
}

/**
 * Neighborhood lawn: one block's worth of lots (200 m × 110 m, Spec 05), each mowed in its own
 * shade with faint stripes; streets are left as grass (no roads yet).
 */
export function lawnTexture(seed: number): THREE.CanvasTexture {
  const rng = createRng(seed);
  const W = 1024;
  const H = Math.round((W * CITY.blockZ) / CITY.blockX);
  const { c, g } = canvas(W, H);
  const px = W / CITY.blockX; // pixels per metre
  // Streets are grass like the yards (no roads yet, Spec 17): same base shade.
  g.fillStyle = "hsl(94, 38%, 29%)";
  g.fillRect(0, 0, W, H);
  const lotW = 23 * px;
  const rowH = (H - 15 * px) / 2;
  for (let row = 0; row < 2; row++) {
    for (let k = 0; k < 8; k++) {
      const x = 7.5 * px + k * lotW;
      const y = 7.5 * px + row * rowH;
      // Each yard a slightly different shade (watering, grass type), low contrast.
      const l = 0.94 + rng() * 0.12;
      const h = 90 + rng() * 8;
      g.fillStyle = `hsl(${h}, ${35 + rng() * 6}%, ${29 * l}%)`;
      g.fillRect(x, y, lotW + 1, rowH + 1);
      // Mowing stripes, ~0.8 m wide, along or across the lot.
      g.globalAlpha = 0.06;
      const across = rng() > 0.5;
      const stripe = 0.8 * px;
      for (let s = 0, n = 0; s < (across ? rowH : lotW); s += stripe, n++) {
        g.fillStyle = n % 2 ? "#ffffff" : "#000000";
        if (across) g.fillRect(x, y + s, lotW, stripe);
        else g.fillRect(x + s, y, stripe, rowH);
      }
      g.globalAlpha = 1;
    }
  }
  // Fine grass speckle.
  g.globalAlpha = 0.05;
  for (let i = 0; i < 40000; i++) {
    g.fillStyle = rng() > 0.5 ? "#2c3d1a" : "#9fbf6a";
    g.fillRect(rng() * W, rng() * H, 1, 1);
  }
  g.globalAlpha = 1;
  return texture(c);
}

/** Urban pavement: light concrete in 5 m slabs with joints, stains and wear; 40 m tile. */
export function pavementTexture(seed: number): THREE.CanvasTexture {
  const rng = createRng(seed);
  const size = 1024;
  const { c, g } = canvas(size, size);
  const px = size / 40;
  g.fillStyle = "#a9a7a1";
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const v = 160 + Math.floor(rng() * 22);
      g.fillStyle = `rgb(${v}, ${v - 2}, ${v - 6})`;
      g.fillRect(i * 5 * px, j * 5 * px, 5 * px, 5 * px);
    }
  }
  g.globalAlpha = 0.08;
  for (let i = 0; i < 120; i++) {
    g.fillStyle = rng() > 0.5 ? "#3d3a35" : "#ffffff";
    g.beginPath();
    g.arc(rng() * size, rng() * size, 4 + rng() * 40, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 0.5;
  g.strokeStyle = "#6f6c66";
  g.lineWidth = 2;
  for (let k = 0; k <= 8; k++) {
    g.beginPath();
    g.moveTo(k * 5 * px, 0);
    g.lineTo(k * 5 * px, size);
    g.moveTo(0, k * 5 * px);
    g.lineTo(size, k * 5 * px);
    g.stroke();
  }
  g.globalAlpha = 1;
  return texture(c);
}

/** The roughness layer's colour scale (Spec 17): viridis over log10 z₀ from 0.001 to 3 m. */
export const ROUGHNESS_SCALE = {
  min: -3,
  max: Math.log10(3),
  stops: ["#440154", "#46327e", "#365c8d", "#277f8e", "#1fa187", "#4ac16d", "#a0da39", "#fde725"],
  opacity: 0.45,
} as const;

const STOP_RGB = ROUGHNESS_SCALE.stops.map((h) => new THREE.Color(h));
/** Colour for a roughness length (m) on the layer's scale (linear sRGB components 0–1). */
export function roughnessColor(z0: number, out = new THREE.Color()): THREE.Color {
  const u = Math.min(Math.max((Math.log10(z0) - ROUGHNESS_SCALE.min) / (ROUGHNESS_SCALE.max - ROUGHNESS_SCALE.min), 0), 1);
  const s = u * (STOP_RGB.length - 1);
  const k = Math.min(Math.floor(s), STOP_RGB.length - 2);
  return out.copy(STOP_RGB[k]!).lerp(STOP_RGB[k + 1]!, s - k);
}

/**
 * The roughness layer's texels (Spec 17, TERR-14): one per grid node, coloured by the upwind-
 * weighted z₀ for the wind direction over that node now; `rect` places texel centres on the
 * nodes (world x, z of the texture's corner, and its size). Pure: reads the field only.
 */
export function roughnessLayer(terrain: Terrain, s: TornadoState): { data: Uint8Array; nx: number; nz: number; z0: Float32Array; rect: { x0: number; z0: number; w: number; h: number } } {
  const f = isField(terrain) ? terrain : null;
  const nx = f ? f.nx : 1;
  const nz = f ? f.nz : 1;
  const data = new Uint8Array(nx * nz * 4);
  const z0s = new Float32Array(nx * nz);
  const lut = colorLut();
  const n = f ? f.eff.length : 1;
  const sector = TWO_PI_INV * n;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const q = i + j * nx;
      let ln: number;
      if (f) {
        const x = f.originX + i * f.cell;
        const z = f.originZ + j * f.cell;
        const dir = s.tunnel ? (-s.tunnel.dirDeg * Math.PI) / 180 : fetchDirection({ x, y: 0, z }, s);
        // Texels sit on the nodes: read the direction fields there, between the two sectors.
        let u = dir * sector;
        u -= Math.floor(u / n) * n;
        const k0 = Math.floor(u) % n;
        const t = u - Math.floor(u);
        const a0 = f.eff[k0]![q]!;
        ln = a0 + t * (f.eff[(k0 + 1) % n]![q]! - a0);
      } else ln = Math.log(TERRAIN.classZ0[terrain as "open" | "suburban" | "urban"]);
      z0s[q] = Math.exp(ln);
      const li = Math.min(LUT_N - 1, Math.max(0, Math.round(((ln * Math.LOG10E - ROUGHNESS_SCALE.min) / (ROUGHNESS_SCALE.max - ROUGHNESS_SCALE.min)) * (LUT_N - 1))));
      data[q * 4] = lut[li * 3]!;
      data[q * 4 + 1] = lut[li * 3 + 1]!;
      data[q * 4 + 2] = lut[li * 3 + 2]!;
      data[q * 4 + 3] = 255;
    }
  }
  const size = RENDER.groundSize;
  const rect = f ? { x0: f.originX - f.cell / 2, z0: f.originZ - f.cell / 2, w: nx * f.cell, h: nz * f.cell } : { x0: -size / 2, z0: -size / 2, w: size, h: size };
  return { data, nx, nz, z0: z0s, rect };
}

const TWO_PI_INV = 1 / (2 * Math.PI);
const LUT_N = 512;
let lutCache: Uint8Array | null = null;
/** sRGB bytes of the scale at LUT_N steps over its log10 z₀ range (the texture is tagged sRGB). */
function colorLut(): Uint8Array {
  if (lutCache) return lutCache;
  const out = new Uint8Array(LUT_N * 3);
  const col = new THREE.Color();
  for (let k = 0; k < LUT_N; k++) {
    const l = ROUGHNESS_SCALE.min + (k / (LUT_N - 1)) * (ROUGHNESS_SCALE.max - ROUGHNESS_SCALE.min);
    roughnessColor(Math.pow(10, l), col).convertLinearToSRGB();
    out[k * 3] = Math.round(col.r * 255);
    out[k * 3 + 1] = Math.round(col.g * 255);
    out[k * 3 + 2] = Math.round(col.b * 255);
  }
  return (lutCache = out);
}

/** The cover each class draws when the lab overrides the terrain. */
export const CLASS_COVER: Record<"open" | "suburban" | "urban", CoverKind> = { open: "farmland", suburban: "lawn", urban: "pavement" };

export interface Ground {
  readonly mesh: THREE.Mesh;
  /** Redraw the cover mask when the cover changes (by reference). */
  setCover(c: GroundCover | null): void;
  /** Show the roughness layer; refreshed for the field and wind at most every 2 s of sim time. */
  setRoughness(on: boolean, terrain: Terrain, s: TornadoState, time: number): void;
  /** Draw the ground damage tracks (Spec 19); reads the track only. */
  setTrack(track: GroundTrack | null): void;
}

const MASK = 2048;

export function createGround(scene: THREE.Scene): Ground {
  const size = RENDER.groundSize;
  const farm = farmlandTexture(7);
  farm.repeat.set(size / 1000, size / 1000);
  const lawn = lawnTexture(9);
  lawn.repeat.set(size / CITY.blockX, size / CITY.blockZ);
  // Align the lot pattern with the town's blocks (Spec 05: blocks start at −extent/2).
  lawn.offset.set((((size / 2 - CITY.extent / 2) / CITY.blockX) % 1 + 1) % 1, (((size / 2 - CITY.extent / 2) / CITY.blockZ) % 1 + 1) % 1);
  const pave = pavementTexture(13);
  pave.repeat.set(size / 40, size / 40);

  // Cover mask over the whole ground: R = lawn, G = pavement weight.
  const maskData = new Uint8Array(MASK * MASK * 4);
  const mask = new THREE.DataTexture(maskData, MASK, MASK, THREE.RGBAFormat);
  mask.magFilter = THREE.LinearFilter;
  mask.minFilter = THREE.LinearFilter;
  mask.needsUpdate = true;

  // Roughness layer texture (grid nodes); resized to the field.
  let rough = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
  const uniforms = {
    lawnMap: { value: lawn },
    paveMap: { value: pave },
    coverMask: { value: mask },
    roughMap: { value: rough },
    roughOn: { value: 0 },
    roughRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    groundSize: { value: size },
  };
  const trackLayer = new TrackLayer();
  Object.assign(uniforms, trackLayer.uniforms);
  const material = new THREE.MeshLambertMaterial({ map: farm, color: 0xb4b8ae });
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vGroundUv;")
      .replace("#include <uv_vertex>", "#include <uv_vertex>\nvGroundUv = uv;");
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec2 vGroundUv;
uniform sampler2D lawnMap;
uniform sampler2D paveMap;
uniform sampler2D coverMask;
uniform sampler2D roughMap;
uniform float roughOn;
uniform vec4 roughRect;
uniform float groundSize;
uniform mat3 lawnXf;
uniform mat3 paveXf;
${TrackLayer.glslHead}`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
{
  vec4 m = texture2D(coverMask, vGroundUv);
  vec2 wxz = vec2(vGroundUv.x - 0.5, 0.5 - vGroundUv.y) * groundSize;
  vec4 lawnC = texture2D(lawnMap, (lawnXf * vec3(vGroundUv, 1.0)).xy);
  vec4 paveC = texture2D(paveMap, (paveXf * vec3(vGroundUv, 1.0)).xy);
  diffuseColor.rgb = mix(diffuseColor.rgb, lawnC.rgb * 1.25, m.r);
  diffuseColor.rgb = mix(diffuseColor.rgb, paveC.rgb * 1.1, m.g);
  diffuseColor.rgb = trackTint(diffuseColor.rgb, wxz, m.r);
  if (roughOn > 0.5) {
    vec2 ru = (wxz - roughRect.xy) / roughRect.zw;
    vec4 rc = texture2D(roughMap, clamp(ru, 0.0, 1.0));
    diffuseColor.rgb = mix(diffuseColor.rgb, rc.rgb, ${ROUGHNESS_SCALE.opacity.toFixed(2)});
  }
}`,
      );
    lawn.updateMatrix();
    pave.updateMatrix();
    sh.uniforms.lawnXf = { value: lawn.matrix };
    sh.uniforms.paveXf = { value: pave.matrix };
  };
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2), material);
  scene.add(mesh);

  let cover: GroundCover | null | undefined;
  let roughKey = "";
  let roughT = -Infinity;
  return {
    mesh,
    setTrack(track) {
      trackLayer.sync(track);
    },
    setCover(c) {
      if (c === cover) return;
      cover = c;
      const px = size / MASK;
      // Feather each texel over the blend width by supersampling its footprint.
      const k = Math.max(1, Math.round(TERRAIN.coverBlend / px));
      for (let j = 0; j < MASK; j++) {
        // Texture row j is v = (j + 0.5)/MASK; world z = (0.5 − v)·size.
        const z = (0.5 - (j + 0.5) / MASK) * size;
        for (let i = 0; i < MASK; i++) {
          const x = ((i + 0.5) / MASK - 0.5) * size;
          let lw = 0;
          let pv = 0;
          if (c) {
            const kind = coverAt(c, x, z);
            if (k <= 1 || c.rects.length === 0) {
              lw = kind === "lawn" ? 1 : 0;
              pv = kind === "pavement" ? 1 : 0;
            } else {
              // Near a rect edge, average a few samples across the blend width.
              let n = 0;
              for (const dx of [-0.5, 0, 0.5]) {
                for (const dz of [-0.5, 0, 0.5]) {
                  const kk = coverAt(c, x + dx * TERRAIN.coverBlend, z + dz * TERRAIN.coverBlend);
                  lw += kk === "lawn" ? 1 : 0;
                  pv += kk === "pavement" ? 1 : 0;
                  n++;
                }
              }
              lw /= n;
              pv /= n;
            }
          }
          const o = (i + j * MASK) * 4;
          maskData[o] = Math.round(lw * 255);
          maskData[o + 1] = Math.round(pv * 255);
          maskData[o + 2] = 0;
          maskData[o + 3] = 255;
        }
      }
      mask.needsUpdate = true;
    },
    setRoughness(on, terrain, s, time) {
      uniforms.roughOn.value = on ? 1 : 0;
      if (!on) {
        roughKey = "";
        return;
      }
      const key = isField(terrain) ? `f${terrain.version}` : terrain;
      if (key === roughKey && Math.abs(time - roughT) < TERRAIN.updateInterval) return;
      roughKey = key;
      roughT = time;
      const { data, nx, nz, rect } = roughnessLayer(terrain, s);
      if (rough.image.width !== nx || rough.image.height !== nz) {
        rough.dispose();
        rough = new THREE.DataTexture(data, nx, nz, THREE.RGBAFormat);
        rough.magFilter = THREE.LinearFilter;
        rough.minFilter = THREE.LinearFilter;
        rough.colorSpace = THREE.SRGBColorSpace;
        uniforms.roughMap.value = rough;
      } else (rough.image.data as Uint8Array).set(data);
      rough.needsUpdate = true;
      uniforms.roughRect.value.set(rect.x0, rect.z0, rect.w, rect.h);
    },
  };
}
