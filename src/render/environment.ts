/** Storm environment: ground, cloud deck, wall cloud, lighting, fog (Spec 06 v1.2). */
import * as THREE from "three";
import { RENDER } from "../config/render";
import { createRng } from "../sim/rng";
import { createGround } from "./ground";
import type { Ground } from "./ground";

function cloudTexture(seed: number): THREE.CanvasTexture {
  const rng = createRng(seed);
  const size = 512;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.fillStyle = "#565d66";
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 900; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 10 + rng() * 60;
    const shade = Math.floor(60 + rng() * 50);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${shade},${shade + 4},${shade + 10},0.35)`);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    // Draw wrapped so the texture tiles seamlessly.
    for (const dx of [-size, 0, size])
      for (const dy of [-size, 0, size]) {
        g.save();
        g.translate(dx, dy);
        g.fillRect(x - r, y - r, r * 2, r * 2);
        g.restore();
      }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function radialFade(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, "#fff");
  grad.addColorStop(0.55, "#bbb");
  grad.addColorStop(1, "#000");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

export interface Environment {
  update(center: { x: number; z: number }, rMax: number, cloudBase: number): void;
  readonly ground: Ground;
}

export function createEnvironment(scene: THREE.Scene): Environment {
  const sky = new THREE.Color(0x8793a0);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 2500, 12000);

  scene.add(new THREE.HemisphereLight(0xc4ced9, 0x4a5240, 2.0));
  const sun = new THREE.DirectionalLight(0xfff1dc, 1.4);
  sun.position.set(-3000, 1500, 2000); // low western light under the storm
  scene.add(sun);

  // Ground by cover, with the roughness layer (Spec 17).
  const ground = createGround(scene);

  // Cloud deck: a plane facing down, so it's visible from below only.
  const cloudTex = cloudTexture(11);
  cloudTex.repeat.set(10, 10);
  const deck = new THREE.Mesh(
    new THREE.PlaneGeometry(RENDER.groundSize * 2, RENDER.groundSize * 2).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: cloudTex, color: 0xb2b9c1 }),
  );
  scene.add(deck);

  // Wall cloud: a darker, lowered disk around the tornado.
  const wallTex = cloudTexture(23);
  const wall = new THREE.Mesh(
    new THREE.CircleGeometry(1, 64).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: wallTex, alphaMap: radialFade(), color: 0x7a8189, transparent: true, depthWrite: false }),
  );
  scene.add(wall);

  return {
    ground,
    update(center, rMax, cloudBase) {
      deck.position.y = cloudBase;
      const wr = Math.max(4 * rMax, 600);
      wall.scale.set(wr, 1, wr);
      wall.position.set(center.x, cloudBase - Math.min(60, cloudBase * 0.12), center.z);
    },
  };
}
