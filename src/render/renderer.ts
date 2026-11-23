/**
 * Three.js renderer (Spec 06 v1.2). Reads snapshots; never writes sim state.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RENDER } from "../config/render";
import type { Building } from "../core/damage/types";
import type { Vec3 } from "../core/math/vec";
import type { SimSnapshot } from "../sim/types";
import { computeArrowField, createArrowField } from "./arrowField";
import { arrowColor, arrowLength } from "./arrowStyle";
import { createEnvironment } from "./environment";
import { createFunnel } from "./funnel";
import { createHouseLayer } from "./houses";
import { interpolateTornado } from "./interpolate";
import { TracerField } from "./tracers";

export interface Layers {
  arrows: boolean;
  funnel: boolean;
  tracers: boolean;
}

export interface SimRenderer {
  draw(prev: SimSnapshot, curr: SimSnapshot, alpha: number): void;
  resize(width: number, height: number): void;
  setFollow(follow: boolean): void;
  setLayers(l: Layers): void;
  pick(ndcX: number, ndcY: number): Vec3 | null;
  setProbes(hover: Vec3 | null, pins: { point: Vec3; color: number }[]): void;
  setDamageColors(on: boolean): void;
  dispose(): void;
}

function arrowGeometry(): THREE.BufferGeometry {
  // Unit arrow along +X, centered on the origin, lying flat on the ground.
  const s = new THREE.Shape();
  s.moveTo(-0.5, -0.1);
  s.lineTo(0.15, -0.1);
  s.lineTo(0.15, -0.5);
  s.lineTo(0.5, 0);
  s.lineTo(0.15, 0.5);
  s.lineTo(0.15, 0.1);
  s.lineTo(-0.5, 0.1);
  s.closePath();
  const g = new THREE.ShapeGeometry(s);
  g.rotateX(-Math.PI / 2);
  return g;
}

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

export function createRenderer(host: HTMLElement, getBuildings: () => readonly Building[]): SimRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, host.clientWidth / host.clientHeight, 1, 30000);
  const env = createEnvironment(scene);

  // Wind arrows.
  const fieldOpts = { spacing: RENDER.arrowGridSpacing, range: RENDER.arrowRange, height: RENDER.arrowHeight };
  const field = createArrowField(fieldOpts);
  const arrows = new THREE.InstancedMesh(
    arrowGeometry(),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false }),
    field.count,
  );
  arrows.frustumCulled = false;
  const color = new THREE.Color();
  for (let k = 0; k < field.count; k++) arrows.setColorAt(k, color.setHex(0xffffff));
  scene.add(arrows);

  // Houses.
  const houses = createHouseLayer();
  scene.add(houses.group);
  let damageColors = true;

  // R_max ring.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.985, 1.0, 128).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
  );
  ring.position.y = 2;
  scene.add(ring);

  // Funnel.
  const funnel = createFunnel();
  scene.add(funnel.mesh);

  // Dust tracers.
  const tracers = new TracerField(RENDER.tracerCount, 99);
  const tracerGeo = new THREE.BufferGeometry();
  tracerGeo.setAttribute("position", new THREE.BufferAttribute(tracers.positions, 3));
  const tint = new Float32Array(RENDER.tracerCount * 3);
  {
    let seed = 12345;
    for (let i = 0; i < RENDER.tracerCount; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const v = 0.75 + 0.35 * ((seed >>> 8) / 16777216);
      tint[i * 3] = 0.2 * v;
      tint[i * 3 + 1] = 0.17 * v;
      tint[i * 3 + 2] = 0.14 * v;
    }
  }
  tracerGeo.setAttribute("color", new THREE.BufferAttribute(tint, 3));
  const tracerPoints = new THREE.Points(
    tracerGeo,
    new THREE.PointsMaterial({
      size: RENDER.tracerSize,
      map: dustSprite(),
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  tracerPoints.frustumCulled = false;
  scene.add(tracerPoints);
  let lastTime = 0;

  // Probe markers.
  const hoverRing = new THREE.Mesh(
    new THREE.RingGeometry(6, 9, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }),
  );
  hoverRing.position.y = 1;
  hoverRing.visible = false;
  scene.add(hoverRing);
  const pinMeshes: THREE.Group[] = [];
  for (let i = 0; i < 4; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 50, 8), mat);
    pole.position.y = 25;
    const head = new THREE.Mesh(new THREE.SphereGeometry(5, 16, 12), mat);
    head.position.y = 52;
    g.add(pole, head);
    g.visible = false;
    scene.add(g);
    pinMeshes.push(g);
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  controls.minDistance = 40;
  controls.maxDistance = 9000;

  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();

  let follow = true;
  let placed = false;
  let layers: Layers = { arrows: false, funnel: true, tracers: true };
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  return {
    draw(prev, curr, alpha) {
      const s = interpolateTornado(prev.tornado, curr.tornado, alpha);
      const t = prev.time + (curr.time - prev.time) * alpha;
      const active = s.vMax > 0.5;

      // Arrows.
      arrows.visible = layers.arrows;
      if (layers.arrows) {
        computeArrowField(s, curr.terrain, fieldOpts, field);
        for (let k = 0; k < field.count; k++) {
          const v = field.speed[k]!;
          const len = arrowLength(v, RENDER.maxArrowLength);
          const width = RENDER.maxArrowWidth * (0.3 + 0.7 * (len / RENDER.maxArrowLength));
          pos.set(field.x[k]!, RENDER.arrowDrawHeight, field.z[k]!);
          q.setFromAxisAngle(up, field.angle[k]!);
          scl.set(Math.max(len, 0.01), 1, width);
          arrows.setMatrixAt(k, m.compose(pos, q, scl));
          arrows.setColorAt(k, color.setHex(arrowColor(v)));
        }
        arrows.instanceMatrix.needsUpdate = true;
        if (arrows.instanceColor) arrows.instanceColor.needsUpdate = true;
      }

      ring.visible = active;
      ring.scale.set(s.rMax, 1, s.rMax);
      ring.position.set(s.center.x, 2, s.center.z);

      env.update(s.center, s.rMax, curr.cloudBase);
      houses.sync(getBuildings(), curr.damageVersion, damageColors);

      funnel.mesh.visible = layers.funnel;
      if (layers.funnel) funnel.update(s, curr.cloudBase, t);

      // Tracers advance with sim time; a restart (time going backwards) clears them.
      const dt = t - lastTime;
      if (dt < 0) tracers.clear();
      tracers.update(Math.min(Math.max(dt, 0), 0.5), s, curr.terrain, curr.cloudBase);
      lastTime = t;
      tracerPoints.visible = layers.tracers;
      tracerGeo.attributes.position!.needsUpdate = true;

      // Camera.
      if (!placed) {
        // Storm-chaser view: ~1.8 km away, below the cloud base, looking slightly up.
        const d = 1800;
        const h = Math.min(120, curr.cloudBase * 0.3);
        controls.target.set(s.center.x, curr.cloudBase * 0.45, s.center.z);
        camera.position.set(s.center.x - d * 0.5, h, s.center.z + d * 0.87);
        placed = true;
      } else if (follow) {
        const dx = s.center.x - controls.target.x;
        const dz = s.center.z - controls.target.z;
        controls.target.x += dx;
        controls.target.z += dz;
        camera.position.x += dx;
        camera.position.z += dz;
      }
      controls.update();
      renderer.render(scene, camera);
    },
    resize(width, height) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    },
    setFollow(f) {
      follow = f;
    },
    setLayers(l) {
      layers = { ...l };
    },
    setDamageColors(on) {
      damageColors = on;
    },
    pick(ndcX, ndcY) {
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
      if (!raycaster.ray.intersectPlane(groundPlane, hit)) return null;
      const half = RENDER.groundSize / 2;
      if (Math.abs(hit.x) > half || Math.abs(hit.z) > half) return null;
      return { x: hit.x, y: 0, z: hit.z };
    },
    setProbes(hover, pins) {
      hoverRing.visible = hover !== null;
      if (hover) hoverRing.position.set(hover.x, 1, hover.z);
      pinMeshes.forEach((g, i) => {
        const p = pins[i];
        g.visible = !!p;
        if (p) {
          g.position.set(p.point.x, 0, p.point.z);
          for (const c of g.children) ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setHex(p.color);
        }
      });
    },
    dispose() {
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
