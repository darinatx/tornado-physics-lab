/**
 * Three.js renderer (Spec 06 v1.2). Reads snapshots; never writes sim state.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { flyStep, keyEvent, lookStep, NO_KEYS, releaseAll, startView } from "./cameraFly";
import type { FlyKeys, TurnKeys } from "./cameraFly";
import { CAMERA, RENDER } from "../config/render";
import type { Building } from "../core/damage/types";
import type { Piece } from "../core/debris/piece";
import { DEBRIS } from "../config/debris";
import type { Vec3 } from "../core/math/vec";
import type { SimSnapshot } from "../sim/types";
import { computeArrowField, createArrowField } from "./arrowField";
import { arrowColor, arrowLength } from "./arrowStyle";
import { createEnvironment } from "./environment";
import { createFunnel } from "./funnel";
import { createHouseLayer } from "./houses";
import { createDetailLayer } from "./detailLayer";
import type { DetailView } from "../sim/detailBackend";
import { createDebrisLayer, createSettledLayer } from "./debris";
import { interpolateTornado } from "./interpolate";
import { createDustLayer } from "./dust";

export interface Layers {
  arrows: boolean;
  funnel: boolean;
  tracers: boolean;
  debris: boolean;
}

export interface SimRenderer {
  draw(prev: SimSnapshot, curr: SimSnapshot, alpha: number): void;
  resize(width: number, height: number): void;
  setFollow(follow: boolean): void;
  /** Look at a ground point from close by (stops following the tornado). */
  lookAt(x: number, z: number, distance: number): void;
  setLayers(l: Layers): void;
  pick(ndcX: number, ndcY: number): Vec3 | null;
  setProbes(hover: Vec3 | null, pins: { point: Vec3; color: number }[]): void;
  setDamageColors(on: boolean): void;
  setDebrisScale(scale: number): void;
  /** Scene exposure multiplier (1 = default). */
  setBrightness(exposure: number): void;
  /** Called when the user moves the camera away from following (pan or fly). */
  onCameraMoved(cb: () => void): void;
  /** Where the camera is and the point it looks at (read-only). */
  cameraPose(): { position: Vec3; target: Vec3 };
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

export function createRenderer(
  host: HTMLElement,
  getBuildings: () => readonly Building[],
  getDebris: () => readonly Piece[] = () => [],
  getSettled: () => { pieces: readonly Piece[]; dropped: number; version: number } = () => ({ pieces: [], dropped: 0, version: 0 }),
  /** Detailed houses (Spec 09 slice B) and the detail spot, if any. */
  getDetail: () => { view: DetailView; spot: { x: number; z: number; r: number } | null } | null = () => null,
  /** The tornado's mature core radius (m), for framing the start view (REND-17): while it spins
   *  up the core is wider than it will be. Defaults to the current radius. */
  getMatureRMax: (() => number) | null = null,
): SimRenderer {
  // Logarithmic depth: debris lies millimetres above the ground hundreds of metres away, which a
  // linear 1 m–30 km depth buffer can't separate (pieces flickered in and out as the camera moved).
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(host.clientWidth, host.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Linear tone mapping so the Brightness control can scale exposure.
  renderer.toneMapping = THREE.LinearToneMapping;
  renderer.toneMappingExposure = 1;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, host.clientWidth / host.clientHeight, 1, 30000);
  const env = createEnvironment(scene);
  const baseSky = (scene.background as THREE.Color).clone();

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
  let damageColors = false;

  // Flying debris.
  const debris = createDebrisLayer(DEBRIS.cap);
  const settledLayer = createSettledLayer(250000);
  scene.add(settledLayer.mesh);
  let debrisScale = 1;
  scene.add(debris.mesh);

  // R_max ring.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.985, 1.0, 128).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
  );
  ring.position.y = 2;
  scene.add(ring);

  // Detailed houses, and a dashed ring around the detail spot.
  const detail = createDetailLayer();
  scene.add(detail.group);
  const spotRing = new THREE.Mesh(
    new THREE.RingGeometry(0.97, 1.0, 96).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.6, depthWrite: false }),
  );
  spotRing.visible = false;
  scene.add(spotRing);

  // Funnel.
  const funnel = createFunnel();
  scene.add(funnel.mesh);

  // Dust tracers.
  const dust = createDustLayer(RENDER.tracerCap, RENDER.tracerSize);
  scene.add(dust.points);

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

  // Free camera (Spec 06 v1.7): orbit, map-style pan along the ground, zoom to the cursor,
  // keyboard flying; never below eye height.
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  // Any view angle (looking up from street level too); the floors below keep it above ground.
  controls.maxPolarAngle = Math.PI;
  controls.minDistance = CAMERA.minDistance;
  controls.maxDistance = CAMERA.maxDistance;
  controls.screenSpacePanning = false;
  controls.zoomToCursor = true;
  // Map-style: left-drag (one finger) slides over the ground; right-drag (or Ctrl/⌘/Shift +
  // left-drag) turns the camera in place (handled below, not OrbitControls' orbit, which swings
  // the camera around a possibly far-off point).
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
  controls.enableRotate = false;
  const turnKeys: TurnKeys = { left: false, right: false, up: false, down: false };
  let turnFrom: { x: number; y: number } | null = null;
  const turn = (yaw: number, pitch: number) => {
    const t = lookStep(camera.position, controls.target, yaw, pitch);
    controls.target.set(t.x, t.y, t.z);
    camera.lookAt(controls.target);
  };
  const keys: FlyKeys = { ...NO_KEYS };
  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  };
  const clearKeys = () => releaseAll(keys, turnKeys);
  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    if (keyEvent(keys, turnKeys, e, down, typing(e))) e.preventDefault();
  };
  const keyDown = onKey(true);
  const keyUp = onKey(false);
  // Focus leaving the page doesn't always blur the window (tab switch, an embedding app):
  // stop flying then too, since the key-ups go elsewhere.
  const onVisibility = () => {
    if (document.visibilityState !== "visible") clearKeys();
  };
  window.addEventListener("keydown", keyDown);
  window.addEventListener("keyup", keyUp);
  window.addEventListener("blur", clearKeys);
  document.addEventListener("visibilitychange", onVisibility);
  const onFocusOut = (e: FocusEvent) => {
    if (!e.relatedTarget) clearKeys();
  };
  document.addEventListener("focusout", onFocusOut);
  let movedCb: (() => void) | null = null;
  const leaveFollow = () => {
    if (!follow) return;
    follow = false;
    movedCb?.();
  };
  // A pan (plain left-drag, one finger) stops following the tornado once the pointer moves;
  // orbiting and zooming keep following.
  let panFrom: { x: number; y: number } | null = null;
  const onPointer = (e: PointerEvent) => {
    const modified = e.shiftKey || e.ctrlKey || e.metaKey;
    panFrom = e.button === 0 && !modified ? { x: e.clientX, y: e.clientY } : null;
    turnFrom = e.button === 2 || (e.button === 0 && modified) ? { x: e.clientX, y: e.clientY } : null;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (turnFrom) {
      // Mouse-look: move right to look right, up to look up.
      const k = CAMERA.turnPerPixel;
      turn(-(e.clientX - turnFrom.x) * k, -(e.clientY - turnFrom.y) * k);
      turnFrom = { x: e.clientX, y: e.clientY };
    }
    if (panFrom && Math.hypot(e.clientX - panFrom.x, e.clientY - panFrom.y) > 4) {
      panFrom = null;
      leaveFollow();
    }
  };
  const onPointerUp = () => {
    panFrom = null;
    turnFrom = null;
  };
  renderer.domElement.addEventListener("pointerdown", onPointer);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  let lastFrame = performance.now();

  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();

  let follow = true;
  /** Tornado center at the last frame (follow moves the camera by how far it went). */
  let followFrom: { x: number; z: number } | null = null;
  let recenter = false;
  let placed = false;
  let layers: Layers = { arrows: false, funnel: true, tracers: true, debris: true };
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
      houses.sync(getBuildings(), damageColors);
      const det = getDetail();
      if (det) detail.sync(det.view, damageColors);
      spotRing.visible = !!det?.spot;
      if (det?.spot) {
        const r = det.spot.r + 12; // around the houses, not through them
        spotRing.scale.set(r, 1, r);
        spotRing.position.set(det.spot.x, 1.5, det.spot.z);
      }
      debris.mesh.visible = layers.debris;
      settledLayer.mesh.visible = layers.debris;
      if (layers.debris) {
        debris.sync(getDebris(), debrisScale);
        const st = getSettled();
        settledLayer.sync(st.pieces, debrisScale, st.dropped, st.version);
      }

      funnel.mesh.visible = layers.funnel;
      if (layers.funnel) funnel.update(s, curr.cloudBase, t);

      // Tracers advance with sim time; a restart (time going backwards) clears them.
      dust.update(t, s, curr.terrain, curr.cloudBase);
      dust.points.visible = layers.tracers;

      // Camera.
      if (!placed) {
        // Framed on the tornado, ahead of it on its track (REND-17).
        const sp = Math.hypot(s.velocity.x, s.velocity.z);
        const dir = sp > 1e-9 ? { x: s.velocity.x / sp, z: s.velocity.z / sp } : { x: 1, z: 0 };
        const v = startView(s.center, dir, getMatureRMax ? getMatureRMax() : s.rMax, curr.cloudBase, camera.fov, camera.aspect);
        controls.target.set(v.target.x, v.target.y, v.target.z);
        camera.position.set(v.camera.x, v.camera.y, v.camera.z);
        camera.lookAt(controls.target);
        placed = true;
      } else if (follow && recenter) {
        const dx = s.center.x - controls.target.x;
        const dz = s.center.z - controls.target.z;
        controls.target.x += dx;
        controls.target.z += dz;
        camera.position.x += dx;
        camera.position.z += dz;
        recenter = false;
      } else if (follow && followFrom) {
        // Follow: carry the camera along as the tornado moves, keeping the view you chose
        // (turned, zoomed or tilted) rather than pulling it back onto the center.
        const dx = s.center.x - followFrom.x;
        const dz = s.center.z - followFrom.z;
        controls.target.x += dx;
        controls.target.z += dz;
        camera.position.x += dx;
        camera.position.z += dz;
      }
      followFrom = { x: s.center.x, z: s.center.z };
      // Keyboard flying (real time, not sim time: the camera moves while paused too).
      const now = performance.now();
      const fdt = Math.min((now - lastFrame) / 1000, 0.1);
      lastFrame = now;
      const yawKeys = (turnKeys.left ? 1 : 0) - (turnKeys.right ? 1 : 0);
      const pitchKeys = (turnKeys.up ? 1 : 0) - (turnKeys.down ? 1 : 0);
      if (yawKeys || pitchKeys) turn(yawKeys * CAMERA.turnRate * fdt, pitchKeys * CAMERA.turnRate * fdt);
      const mv = flyStep(keys, fdt, camera.position, controls.target);
      if (Math.abs(mv.camera.x - camera.position.x) + Math.abs(mv.camera.z - camera.position.z) > 1e-9) leaveFollow();
      camera.position.set(mv.camera.x, mv.camera.y, mv.camera.z);
      controls.target.set(mv.target.x, mv.target.y, mv.target.z);
      controls.update();
      // Floors: zooming toward the cursor can carry either below them.
      if (controls.target.y < 0) controls.target.y = 0;
      if (camera.position.y < CAMERA.minHeight) camera.position.y = CAMERA.minHeight;
      renderer.render(scene, camera);
    },
    resize(width, height) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    },
    setFollow(f) {
      // Turning follow on brings the tornado back to the middle of the view once.
      if (f && !follow) recenter = true;
      follow = f;
    },
    lookAt(x, z, distance) {
      follow = false;
      placed = true;
      controls.target.set(x, 3, z);
      // From the south-west, about 35° above the horizon.
      camera.position.set(x - distance * 0.55, distance * 0.6, z + distance * 0.58);
      controls.update();
    },
    setLayers(l) {
      layers = { ...l };
    },
    setDamageColors(on) {
      damageColors = on;
    },
    setDebrisScale(scale) {
      debrisScale = scale;
    },
    setBrightness(exposure) {
      renderer.toneMappingExposure = exposure;
      // The sky and fog color aren't tone-mapped; scale them to match.
      const sky = baseSky.clone().multiplyScalar(exposure);
      scene.background = sky;
      if (scene.fog) (scene.fog as THREE.Fog).color.copy(sky);
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
    onCameraMoved(cb) {
      movedCb = cb;
    },
    cameraPose() {
      const p = camera.position;
      const t = controls.target;
      return { position: { x: p.x, y: p.y, z: p.z }, target: { x: t.x, y: t.y, z: t.z } };
    },
    dispose() {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", clearKeys);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("focusout", onFocusOut);
      renderer.domElement.removeEventListener("pointerdown", onPointer);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
