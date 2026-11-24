/**
 * Draws a member-level house (Spec 09) from its members' poses: one instanced box per shape.
 */
import * as THREE from "three";
import type { Framing, MemberKind } from "../core/structure/framing";
import { qmul, qrot } from "../core/structure/framing";
import type { MemberPose } from "../sim/structureLab";

export interface StructureView {
  readonly group: THREE.Group;
  update(pose: (id: number) => MemberPose, hidden: (id: number) => boolean): void;
}

const KIND_ORDER: MemberKind[] = ["wallFrame", "sillPlate", "gableFrame", "partition", "door", "drywall", "wallSheet", "siding", "trim", "pane", "garageDoor", "rafterPair", "roofSheet", "roofShingle", "ceiling", "fascia"];

/**
 * Unit right-triangle prism: right angle at the origin, legs along +x (−x when mirrored) and
 * +y, z from −0.5 to 0.5. The mirrored version has its own vertices and winding so lighting
 * matches (a negative scale would flip its normals).
 */
function triGeometry(mirror: boolean): THREE.BufferGeometry {
  const sx = mirror ? -1 : 1;
  const g = new THREE.BufferGeometry();
  const v = [0, 0, -0.5, sx, 0, -0.5, 0, 1, -0.5, 0, 0, 0.5, sx, 0, 0.5, 0, 1, 0.5];
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  const idx = [0, 2, 1, 3, 4, 5, 0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 2, 0, 3, 2, 3, 5];
  if (mirror) for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2]!, idx[i + 1]!];
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

type SlotKey = MemberKind | "tri" | "triM" | "triGlass";

export function createStructureView(f: Framing): StructureView {
  const group = new THREE.Group();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const tri = triGeometry(false);
  const triM = triGeometry(true);
  const keys: SlotKey[] = [...KIND_ORDER, "tri", "triM", "triGlass"];
  const slots = new Map<SlotKey, { member: number; shape: number }[]>();
  for (const k of keys) slots.set(k, []);
  for (const m of f.members)
    m.shapes.forEach((sh, si) => slots.get(sh.tri ? (m.kind === "pane" ? "triGlass" : sh.tri.mirror ? "triM" : "tri") : m.kind)!.push({ member: m.id, shape: si }));
  const meshes = new Map<SlotKey, THREE.InstancedMesh>();
  for (const k of keys) {
    const n = slots.get(k)!.length;
    if (!n) continue;
    const mat =
      k === "pane" || k === "triGlass"
        ? new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.7 })
        : new THREE.MeshLambertMaterial();
    const mesh = new THREE.InstancedMesh(k === "tri" || k === "triGlass" ? tri : k === "triM" ? triM : box, mat, n);
    mesh.frustumCulled = false;
    const color = new THREE.Color();
    slots.get(k)!.forEach((s, i) => mesh.setColorAt(i, color.setHex(f.members[s.member]!.color)));
    group.add(mesh);
    meshes.set(k, mesh);
  }
  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);

  return {
    group,
    update(pose, hidden) {
      for (const [k, mesh] of meshes) {
        slots.get(k)!.forEach((s, i) => {
          if (hidden(s.member)) {
            mesh.setMatrixAt(i, zero);
            return;
          }
          const p = pose(s.member);
          const sh = f.members[s.member]!.shapes[s.shape]!;
          const off = qrot(p.q, sh.pos);
          const q = qmul(p.q, sh.q);
          pos.set(p.pos.x + off.x, p.pos.y + off.y, p.pos.z + off.z);
          quat.set(q[0], q[1], q[2], q[3]);
          scl.set(sh.size[0], sh.size[1], sh.size[2]);
          mesh.setMatrixAt(i, m4.compose(pos, quat, scl));
        });
        mesh.instanceMatrix.needsUpdate = true;
      }
    },
  };
}
