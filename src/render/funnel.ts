/**
 * Condensation funnel mesh (Spec 06 v1.2). Its shape comes from funnelRadius() (physics);
 * the shader adds streaks that rotate at the core's angular rate V_max / R_max.
 */
import * as THREE from "three";
import { funnelBottom, funnelRadius } from "../core/wind/condensation";
import type { TornadoState } from "../core/wind/types";

const NZ = 64; // rings
const NA = 72; // segments around

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vWorld;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vN = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uSpin;
  uniform float uOpacity;
  uniform vec3 uColor;
  uniform vec3 uDust;
  uniform vec3 uLight;
  varying vec2 vUv;
  varying vec3 vN;
  varying vec3 vWorld;
  #include <fog_pars_fragment>

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float a = 0.5, s = 0.0;
    for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 7.1; a *= 0.5; }
    return s;
  }

  void main() {
    float u = vUv.x - uSpin;
    float ang = 6.2831853 * u;
    // Seamless around the funnel: sample noise on a circle, sheared with height (helical).
    vec2 q = vec2(cos(ang), sin(ang)) * 2.2 + vec2(vUv.y * 5.0, -vUv.y * 3.0);
    float n = fbm(q * 1.7);
    float streak = 0.5 + 0.5 * sin(6.2831853 * (u * 7.0) + vUv.y * 18.0 + n * 3.0);
    float shade = mix(0.72, 1.12, n) * (0.88 + 0.12 * streak);

    float lambert = 0.55 + 0.45 * max(dot(normalize(vN), normalize(uLight)), 0.0);
    vec3 col = mix(uColor, uDust, smoothstep(0.35, 0.0, vUv.y)) * shade * lambert;

    vec3 viewDir = normalize(cameraPosition - vWorld);
    float rim = abs(dot(normalize(vN), viewDir));
    float alpha = uOpacity * (0.45 + 0.55 * rim);
    alpha *= smoothstep(0.0, 0.05, vUv.y);           // soft tip
    alpha *= 1.0 - smoothstep(0.55, 0.97, vUv.y);    // merge into the cloud base
    alpha *= 0.75 + 0.35 * n;

    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export interface Funnel {
  readonly mesh: THREE.Mesh;
  update(s: TornadoState, cloudBase: number, time: number): void;
}

export function createFunnel(): Funnel {
  const verts = NZ * (NA + 1);
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const idx: number[] = [];
  for (let k = 0; k < NZ; k++) {
    for (let j = 0; j <= NA; j++) {
      const v = k * (NA + 1) + j;
      uv[v * 2] = j / NA;
      uv[v * 2 + 1] = k / (NZ - 1);
      if (k < NZ - 1 && j < NA) {
        const a = v;
        const b = v + NA + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uSpin: { value: 0 },
        uOpacity: { value: 0.92 },
        uColor: { value: new THREE.Color(0xa3a9b0) },
        uDust: { value: new THREE.Color(0x7d6e5c) },
        uLight: { value: new THREE.Vector3(-0.6, 0.5, 0.4) },
      },
    ]),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;

  return {
    mesh,
    update(s, cloudBase, time) {
      const bottom = funnelBottom(s, cloudBase);
      if (s.vMax < 1 || bottom > cloudBase - 10) {
        mesh.visible = false;
        return;
      }
      mesh.visible = true;
      const R = Math.max(s.rMax, 1);
      // Above ~1.6·R_max the funnel blends into the wall cloud; cap the flare there.
      const cap = 1.6 * R;
      for (let k = 0; k < NZ; k++) {
        const t = k / (NZ - 1);
        // Denser rings near the tip, where the shape changes fastest.
        const z = bottom + (cloudBase - bottom) * Math.pow(t, 1.4);
        const r = Math.max(funnelRadius(z, s, cloudBase, cap), t === 0 ? 0 : 0.5);
        // Gentle sway, strongest near the tip.
        const sway = 0.06 * R * (1 - t);
        const ox = sway * Math.sin(time * 0.37 + t * 2.5);
        const oz = sway * Math.cos(time * 0.29 + t * 3.1);
        for (let j = 0; j <= NA; j++) {
          const a = (j / NA) * Math.PI * 2;
          const v = (k * (NA + 1) + j) * 3;
          // Increasing a = counter-clockwise seen from above (rotation about +Y).
          pos[v] = s.center.x + ox + r * Math.cos(a);
          pos[v + 1] = z;
          pos[v + 2] = s.center.z + oz - r * Math.sin(a);
        }
      }
      geo.attributes.position!.needsUpdate = true;
      geo.computeVertexNormals();
      const omega = s.vMax / R; // rad/s, solid-body rotation of the core
      material.uniforms.uSpin!.value = (s.rotation * omega * time) / (2 * Math.PI);
    },
  };
}
