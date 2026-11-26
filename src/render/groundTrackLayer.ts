/**
 * Drawing the ground damage tracks (Spec 19): each track tile becomes one row of an atlas
 * texture (32 × 32 cells flattened to 1024 texels, so a tile uploads as one contiguous range),
 * and an index texture maps world tiles to atlas rows. The ground material samples both. Reads
 * the track only.
 */
import * as THREE from "three";
import { RENDER } from "../config/render";
import type { GroundTrack, TrackTile } from "../sim/groundTrack";
import { TRACK_TILE_M } from "../sim/groundTrack";
import { TRACK } from "../config/terrain";

/** How the track is drawn (Spec 19): flattened vegetation lightens and streaks, soil shows
 *  through as the scour dose builds, debris marks darken. All continuous, per cell. */
export const TRACK_COLOR = {
  /** Lightening of fully flattened vegetation (exposed stems and leaf undersides). */
  flatten: 0.18,
  /** Straw tint of crops flattened well past lodging (broken stalks), mottled. */
  straw: 0.22,
  /** Darkest a debris mark draws (fraction toward the mark colour). */
  markMax: 0.55,
  soilColor: "#5d4733",
  strawColor: "#b9a46c",
  markColor: "#33261a",
} as const;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * One tile's texels, RGBA per cell: R = how flattened (0–255, from just below the cell's own
 * lodging threshold), G = direction (0–255), B = mark, A = how much soil shows (0–255, from its
 * dose against its own erodibility). Continuous, so edges follow each cell's own strength.
 */
export function trackTexels(t: TrackTile, out = new Uint8Array(t.state.length * 4)): Uint8Array {
  const lnThin = Math.log(0.4 * TRACK.dose.thinned);
  const lnBare = Math.log(TRACK.dose.bare);
  for (let c = 0; c < t.state.length; c++) {
    const k = { kv: t.kv[c]!, ks: t.ks[c]! };
    const thr = (t.cover[c] === 1 ? TRACK.lawnFlatten : TRACK.cropLodge) * k.kv;
    const flat = t.cover[c] === 2 ? 0 : smooth(0.85, 1.35, t.peak[c]! / thr);
    const dose = t.dose[c]!;
    const soil = dose > 0 ? smooth(lnThin + Math.log(k.ks), lnBare + Math.log(k.ks), Math.log(dose)) : 0;
    out[c * 4] = Math.round(flat * 255);
    out[c * 4 + 1] = t.dir[c]!;
    out[c * 4 + 2] = t.mark[c]!;
    out[c * 4 + 3] = Math.round(soil * 255);
  }
  return out;
}

const ROW = 1024;

export class TrackLayer {
  readonly uniforms = {
    trackAtlas: { value: null as unknown as THREE.DataTexture },
    trackIndex: { value: null as unknown as THREE.DataTexture },
    trackRows: { value: 1 },
    trackIdx: { value: new THREE.Vector3(1, 0, TRACK_TILE_M) }, // size, offset, tile size (m)
  };
  private rows = 0;
  private atlasData = new Uint8Array(0);
  private atlas: THREE.DataTexture;
  private readonly idxSize: number;
  private readonly idxOff: number;
  private readonly idxData: Uint8Array;
  private readonly index: THREE.DataTexture;
  private track: GroundTrack | null = null;
  private readonly slot = new Map<TrackTile, number>();
  private readonly seen = new Map<TrackTile, number>();
  private seenVersion = -1;
  private lastSync = -Infinity;

  constructor() {
    this.idxSize = Math.ceil(RENDER.groundSize / TRACK_TILE_M) + 2;
    this.idxOff = Math.floor(this.idxSize / 2);
    this.idxData = new Uint8Array(this.idxSize * this.idxSize * 4);
    this.index = new THREE.DataTexture(this.idxData, this.idxSize, this.idxSize, THREE.RGBAFormat);
    this.index.magFilter = this.index.minFilter = THREE.NearestFilter;
    this.index.needsUpdate = true;
    this.atlas = this.makeAtlas(64);
    this.uniforms.trackIndex.value = this.index;
    this.uniforms.trackIdx.value.set(this.idxSize, this.idxOff, TRACK_TILE_M);
  }

  private makeAtlas(rows: number): THREE.DataTexture {
    const data = new Uint8Array(ROW * rows * 4);
    data.set(this.atlasData.subarray(0, Math.min(this.atlasData.length, data.length)));
    this.atlasData = data;
    this.rows = rows;
    const t = new THREE.DataTexture(data, ROW, rows, THREE.RGBAFormat);
    t.magFilter = t.minFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    this.atlas?.dispose();
    this.atlas = t;
    this.uniforms.trackAtlas.value = t;
    this.uniforms.trackRows.value = rows;
    return t;
  }

  /** Bring the textures up to date with the track (cheap when nothing changed). */
  sync(track: GroundTrack | null): void {
    if (track !== this.track) {
      this.track = track;
      this.slot.clear();
      this.seen.clear();
      this.seenVersion = -1;
      this.idxData.fill(0);
      this.index.needsUpdate = true;
    }
    if (!track || track.version === this.seenVersion) return;
    // The whole atlas uploads on a change (no partial uploads in three 0.170): at most 4 times a second.
    const now = performance.now();
    if (now - this.lastSync < 250 && this.seenVersion >= 0) return;
    this.lastSync = now;
    this.seenVersion = track.version;
    let dirty = false;
    const buf = new Uint8Array(ROW * 4);
    for (const t of track.list) {
      if (this.seen.get(t) === t.version) continue;
      this.seen.set(t, t.version);
      let s = this.slot.get(t);
      if (s === undefined) {
        s = this.slot.size;
        this.slot.set(t, s);
        if (s >= this.rows) {
          this.makeAtlas(this.rows * 2);
        }
        const ix = t.ti + this.idxOff;
        const iz = t.tj + this.idxOff;
        if (ix >= 0 && iz >= 0 && ix < this.idxSize && iz < this.idxSize) {
          const o = (ix + iz * this.idxSize) * 4;
          this.idxData[o] = s & 255;
          this.idxData[o + 1] = (s >> 8) & 255;
          this.idxData[o + 2] = 255;
          this.idxData[o + 3] = 255;
          this.index.needsUpdate = true;
        }
      }
      this.atlasData.set(trackTexels(t, buf), s * ROW * 4);
      dirty = true;
    }
    if (dirty) this.atlas.needsUpdate = true;
  }

  /** GLSL for the ground material: tints diffuseColor by the track at world (x, z). */
  static readonly glslHead = `
uniform sampler2D trackAtlas;
uniform sampler2D trackIndex;
uniform float trackRows;
uniform vec3 trackIdx;
float trackHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec3 trackTint(vec3 base, vec2 wxz, float lawn) {
  vec2 tc = floor(wxz / trackIdx.z);
  vec4 e = texture2D(trackIndex, (tc + trackIdx.y + 0.5) / trackIdx.x);
  if (e.b < 0.5) return base;
  float slot = floor(e.r * 255.0 + 0.5) + 256.0 * floor(e.g * 255.0 + 0.5);
  vec2 cell = floor((wxz - tc * trackIdx.z) / 2.0);
  float u = (cell.x + cell.y * 32.0 + 0.5) / 1024.0;
  vec4 t = texture2D(trackAtlas, vec2(u, (slot + 0.5) / trackRows));
  vec3 c = base;
  float lay = t.r;
  if (lay > 0.0) {
    // Flattened vegetation: lighter, streaked along the direction it lies.
    float a = t.g * 6.2831853;
    vec2 across = vec2(-sin(a), cos(a));
    float streak = 0.5 + 0.5 * sin(dot(wxz, across) * 7.85);
    c *= 1.0 + lay * (${TRACK_COLOR.flatten.toFixed(3)} + 0.07 * (streak - 0.5));
    // Broken stalks: a faint straw mottle over ~6 m patches, crops only.
    float mott = trackHash(floor(wxz / 6.0));
    c = mix(c, vec3(${hexVec(TRACK_COLOR.strawColor)}), ${TRACK_COLOR.straw.toFixed(3)} * smoothstep(0.75, 1.0, lay) * mott * (1.0 - lawn));
  }
  // Soil showing through, with a little patch-to-patch variation in its colour.
  c = mix(c, vec3(${hexVec(TRACK_COLOR.soilColor)}) * (0.9 + 0.2 * trackHash(floor(wxz / 4.0))), t.a * 0.95);
  c = mix(c, vec3(${hexVec(TRACK_COLOR.markColor)}), min(t.b * 2.0, ${TRACK_COLOR.markMax.toFixed(2)}));
  return c;
}`;
}

/** A hex colour as linear-space GLSL vec3 components. */
function hexVec(hex: string): string {
  const c = new THREE.Color(hex);
  return `${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)}`;
}
