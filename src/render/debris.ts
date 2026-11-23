/**
 * Flying-debris layer (Spec 06 v1.4, REND-09): one instanced unit box per piece.
 */
import * as THREE from "three";
import { DEBRIS_KINDS } from "../config/debris";
import type { Piece } from "../core/debris/piece";

export interface DebrisInstance {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  /** Unit-box scale: length (local X), thickness (local Y), width (local Z). */
  scale: [number, number, number];
  color: number;
}

/**
 * Pure mapping from a piece to its instance transform. `enlarge` draws pieces bigger than
 * life for visibility at a distance (display only; physics always uses real sizes).
 */
export function debrisInstance(p: Piece, enlarge = 1): DebrisInstance {
  const [L, W, T] = DEBRIS_KINDS[p.kind].dims;
  // Lift a grounded piece by half its (drawn) thickness so it sits on the ground.
  const y = p.pos.y + (p.resting || p.pos.y === 0 ? (T * enlarge) / 2 : 0);
  return {
    position: [p.pos.x, y, p.pos.z],
    quaternion: [...p.q],
    scale: [L * enlarge, T * enlarge, W * enlarge],
    color: p.color,
  };
}

export interface DebrisLayer {
  readonly mesh: THREE.InstancedMesh;
  sync(pieces: readonly Piece[], enlarge: number): void;
}

/**
 * The permanent debris field: append-only, so only new pieces are written each frame.
 */
export interface SettledLayer {
  readonly mesh: THREE.InstancedMesh;
  sync(settled: readonly Piece[], enlarge: number, dropped: number): void;
}

export function createSettledLayer(capacity: number): SettledLayer {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), capacity);
  mesh.frustumCulled = false;
  mesh.count = 0;
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const color = new THREE.Color();
  mesh.setColorAt(0, color.setHex(0xffffff));
  let written = 0;
  let lastDropped = 0;
  let lastEnlarge = -1;
  let lastList: readonly Piece[] | null = null;

  return {
    mesh,
    sync(settled, enlarge, dropped) {
      // Rewrite everything after a reset, an overflow shift or a size change; else append.
      const full = settled !== lastList || dropped !== lastDropped || enlarge !== lastEnlarge || settled.length < written;
      const from = full ? 0 : written;
      const n = Math.min(settled.length, capacity);
      for (let i = from; i < n; i++) {
        const d = debrisInstance(settled[i]!, enlarge);
        pos.set(...d.position);
        q.set(...d.quaternion);
        scl.set(...d.scale);
        mesh.setMatrixAt(i, m.compose(pos, q, scl));
        mesh.setColorAt(i, color.setHex(d.color));
      }
      if (from < n || full) {
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      written = n;
      lastDropped = dropped;
      lastEnlarge = enlarge;
      lastList = settled;
    },
  };
}

export function createDebrisLayer(capacity: number): DebrisLayer {
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshLambertMaterial(),
    capacity,
  );
  mesh.frustumCulled = false;
  mesh.count = 0;
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const color = new THREE.Color();
  mesh.setColorAt(0, color.setHex(0xffffff));

  return {
    mesh,
    sync(pieces, enlarge) {
      const n = Math.min(pieces.length, capacity);
      for (let i = 0; i < n; i++) {
        const d = debrisInstance(pieces[i]!, enlarge);
        pos.set(...d.position);
        q.set(...d.quaternion);
        scl.set(...d.scale);
        mesh.setMatrixAt(i, m.compose(pos, q, scl));
        mesh.setColorAt(i, color.setHex(d.color));
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
  };
}
