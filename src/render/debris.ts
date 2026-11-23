/**
 * Flying-debris layer (Spec 06 v1.4, REND-09): one instanced unit box per piece.
 */
import * as THREE from "three";
import { COMPONENT_KINDS, SETTLED_COPIES_MAX } from "../config/debris";
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
export function debrisInstance(p: Piece, enlargeSmall = 1): DebrisInstance {
  const [L, W, T] = p.def.dims;
  // Full-size components (wall panels, roof sections…) are never enlarged.
  const enlarge = COMPONENT_KINDS.has(p.kind) ? 1 : enlargeSmall;
  // Physics already keeps the piece's lowest corner on the ground; an enlarged resting piece
  // is raised by its extra drawn thickness so it doesn't sink in.
  const y = p.pos.y + (p.resting ? ((enlarge - 1) * T) / 2 : 0);
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

/** How many copies a settled piece is drawn as: more for pieces standing for many real objects. */
export function settledCopies(p: Piece): number {
  return Math.max(1, Math.min(SETTLED_COPIES_MAX, Math.round(Math.log2(1 + p.represents))));
}

/** Deterministic jitter for copy k of a piece (m and rad). */
function copyJitter(p: Piece, k: number): { dx: number; dz: number; yaw: number } {
  if (k === 0) return { dx: 0, dz: 0, yaw: 0 };
  const h = Math.sin(p.id * 12.9898 + k * 78.233) * 43758.5453;
  const r = (h - Math.floor(h)) * 2.5;
  const a = ((p.id * 2.399963 + k * 1.7) % (2 * Math.PI));
  return { dx: r * Math.cos(a), dz: r * Math.sin(a), yaw: a };
}

/**
 * The permanent debris field (Spec 04 v1.4): append-only, drawn with multiplicity. Rewrites
 * everything after a reset, a sweep (hidden rubble), an overflow shift or a size change.
 */
export interface SettledLayer {
  readonly mesh: THREE.InstancedMesh;
  sync(settled: readonly Piece[], enlarge: number, dropped: number, version: number): void;
}

export function createSettledLayer(capacity: number): SettledLayer {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), capacity);
  mesh.frustumCulled = false;
  mesh.count = 0;
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const yq = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const scl = new THREE.Vector3();
  const color = new THREE.Color();
  mesh.setColorAt(0, color.setHex(0xffffff));
  let writtenPieces = 0;
  let cursor = 0;
  let last = { list: null as readonly Piece[] | null, enlarge: -1, dropped: -1, version: -1 };

  return {
    mesh,
    sync(settled, enlarge, dropped, version) {
      const full =
        settled !== last.list || enlarge !== last.enlarge || dropped !== last.dropped || version !== last.version || settled.length < writtenPieces;
      if (full) {
        writtenPieces = 0;
        cursor = 0;
      }
      const start = cursor;
      for (let i = writtenPieces; i < settled.length && cursor < capacity; i++) {
        const p = settled[i]!;
        if (p.hidden) continue;
        const d = debrisInstance(p, enlarge);
        for (let k = 0; k < settledCopies(p) && cursor < capacity; k++) {
          const j = copyJitter(p, k);
          pos.set(d.position[0] + j.dx, d.position[1], d.position[2] + j.dz);
          q.set(...d.quaternion);
          if (k > 0) q.premultiply(yq.setFromAxisAngle(up, j.yaw));
          scl.set(...d.scale);
          mesh.setMatrixAt(cursor, m.compose(pos, q, scl));
          mesh.setColorAt(cursor, color.setHex(d.color));
          cursor++;
        }
      }
      writtenPieces = settled.length;
      if (cursor !== start || full) {
        mesh.count = cursor;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      last = { list: settled, enlarge, dropped, version };
    },
  };
}

export function createDebrisLayer(capacity: number): DebrisLayer {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), capacity);
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
