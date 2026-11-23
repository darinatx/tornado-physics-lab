/**
 * Instanced houses with damage visuals (Spec 06 v1.3, REND-08).
 */
import * as THREE from "three";
import type { Building } from "../core/damage/types";

/** DOD color bands: 1–2 yellow, 3–4 orange, 5–6 red-orange, 7–8 red, 9–10 purple. */
export const DOD_COLORS = [0, 0xe9cf5b, 0xe9cf5b, 0xf08c3a, 0xf08c3a, 0xe05a2e, 0xe05a2e, 0xc42b3a, 0xc42b3a, 0x7d2a8c, 0x7d2a8c] as const;

export interface HouseVisual {
  showRoof: boolean;
  /** Wall height as a fraction of the intact height. */
  wallFrac: number;
  wallColor: number;
  roofColor: number;
  offsetX: number;
  offsetZ: number;
}

/** Pure mapping from damage state to visuals. */
export function houseVisual(b: Building, damageColors: boolean): HouseVisual {
  const f = b.failed;
  const wallFrac = f.slab ? 0 : f.allWalls ? 0.1 : f.mostWalls ? 0.3 : f.exteriorWalls ? 0.55 : 1;
  const showRoof = !f.roofStructure && !f.exteriorWalls;
  const tint = damageColors && b.dod > 0 ? DOD_COLORS[b.dod]! : null;
  return {
    showRoof,
    wallFrac,
    wallColor: tint ?? b.wallColor,
    roofColor: tint ?? b.roofColor,
    offsetX: b.shift?.x ?? 0,
    offsetZ: b.shift?.z ?? 0,
  };
}

function gableGeometry(): THREE.BufferGeometry {
  // Unit prism: base 1 × 1 at y = 0, ridge along local X at y = 1.
  const v = [
    -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, 0, -0.5, 1, 0, // front slope (−Z)
    0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 1, 0, 0.5, 1, 0, // back slope (+Z)
  ];
  const ends = [
    -0.5, 0, 0.5, -0.5, 0, -0.5, -0.5, 1, 0, // −X gable
    0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 1, 0, // +X gable
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([...v, ...ends], 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 11, 12, 13]);
  g.computeVertexNormals();
  return g;
}

export interface HouseLayer {
  readonly group: THREE.Group;
  /** Rebuild instances when the building list, damage version or color mode changes. */
  sync(buildings: readonly Building[], version: number, damageColors: boolean): void;
}

export function createHouseLayer(): HouseLayer {
  const group = new THREE.Group();
  let walls: THREE.InstancedMesh | null = null;
  let roofs: THREE.InstancedMesh | null = null;
  let slabs: THREE.InstancedMesh | null = null;
  let lastList: readonly Building[] | null = null;
  let lastVersion = -1;
  let lastColors: boolean | null = null;

  const wallGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const slabGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const roofGeo = gableGeometry();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const color = new THREE.Color();

  function rebuild(n: number): void {
    for (const mesh of [walls, roofs, slabs]) if (mesh) group.remove(mesh);
    walls = new THREE.InstancedMesh(wallGeo, new THREE.MeshLambertMaterial(), n);
    roofs = new THREE.InstancedMesh(roofGeo, new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }), n);
    slabs = new THREE.InstancedMesh(slabGeo, new THREE.MeshLambertMaterial({ color: 0x9a978f }), n);
    for (const mesh of [walls, roofs, slabs]) {
      mesh.frustumCulled = false;
      group.add(mesh);
    }
  }

  return {
    group,
    sync(buildings, version, damageColors) {
      if (buildings === lastList && version === lastVersion && damageColors === lastColors) return;
      if (buildings !== lastList || !walls || walls.count !== buildings.length) rebuild(buildings.length);
      lastList = buildings;
      lastVersion = version;
      lastColors = damageColors;

      buildings.forEach((b, i) => {
        const v = houseVisual(b, damageColors);
        q.setFromAxisAngle(up, b.yaw);
        const x = b.x + v.offsetX;
        const z = b.z + v.offsetZ;

        pos.set(b.x, 0, b.z);
        scl.set(b.width + 0.6, 0.3, b.depth + 0.6);
        slabs!.setMatrixAt(i, m.compose(pos, q, scl));

        pos.set(x, 0.3, z);
        scl.set(b.width, Math.max(b.wallHeight * v.wallFrac, 0.001), b.depth);
        walls!.setMatrixAt(i, m.compose(pos, q, scl));
        walls!.setColorAt(i, color.setHex(v.wallColor));

        pos.set(x, 0.3 + b.wallHeight, z);
        if (v.showRoof) scl.set(b.width * 1.08, b.roofRise, b.depth * 1.12);
        else scl.set(0.001, 0.001, 0.001);
        roofs!.setMatrixAt(i, m.compose(pos, q, scl));
        roofs!.setColorAt(i, color.setHex(v.roofColor));
      });
      for (const mesh of [walls!, roofs!, slabs!]) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    },
  };
}
