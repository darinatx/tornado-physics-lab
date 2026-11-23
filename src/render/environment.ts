/** Storm environment: ground, cloud deck, wall cloud, lighting, fog (Spec 06 v1.2). */
import * as THREE from "three";
import { RENDER } from "../config/render";
import { createRng } from "../sim/rng";

function farmlandTexture(seed: number): THREE.CanvasTexture {
  const rng = createRng(seed);
  const size = 1024;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const palette = ["#4f5d36", "#5b6a3c", "#6b6a40", "#58663a", "#7a6f48", "#4a5733", "#66734a", "#73694a"];
  // Quarter-section style fields (1 km tile → ~8 × 8 fields), with slight jitter.
  const n = 8;
  const cell = size / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      g.fillStyle = palette[Math.floor(rng() * palette.length)]!;
      g.fillRect(i * cell, j * cell, cell + 1, cell + 1);
      // Crop rows.
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
  // Section-line roads.
  g.fillStyle = "#8b8578";
  g.fillRect(0, 0, size, 4);
  g.fillRect(0, 0, 4, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

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
}

export function createEnvironment(scene: THREE.Scene): Environment {
  const sky = new THREE.Color(0x56616d);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 1800, 10000);

  scene.add(new THREE.HemisphereLight(0xaab5c2, 0x2f3526, 1.4));
  const sun = new THREE.DirectionalLight(0xfff1dc, 0.9);
  sun.position.set(-3000, 1500, 2000); // low western light under the storm
  scene.add(sun);

  const groundTex = farmlandTexture(7);
  groundTex.repeat.set(RENDER.groundSize / 1000, RENDER.groundSize / 1000);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(RENDER.groundSize, RENDER.groundSize).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ map: groundTex, color: 0x8a8f86 }),
  );
  scene.add(ground);

  // Cloud deck: a plane facing down, so it's visible from below only.
  const cloudTex = cloudTexture(11);
  cloudTex.repeat.set(10, 10);
  const deck = new THREE.Mesh(
    new THREE.PlaneGeometry(RENDER.groundSize * 2, RENDER.groundSize * 2).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: cloudTex, color: 0x8d949c }),
  );
  scene.add(deck);

  // Wall cloud: a darker, lowered disk around the tornado.
  const wallTex = cloudTexture(23);
  const wall = new THREE.Mesh(
    new THREE.CircleGeometry(1, 64).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: wallTex, alphaMap: radialFade(), color: 0x5d636b, transparent: true, depthWrite: false }),
  );
  scene.add(wall);

  return {
    update(center, rMax, cloudBase) {
      deck.position.y = cloudBase;
      const wr = Math.max(4 * rMax, 600);
      wall.scale.set(wr, 1, wr);
      wall.position.set(center.x, cloudBase - Math.min(60, cloudBase * 0.12), center.z);
    },
  };
}
