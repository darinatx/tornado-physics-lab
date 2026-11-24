/**
 * Detailed houses in town (Spec 09 slice B): every member of every detailed house, drawn from
 * the sim's member poses. Reads the DetailView; never writes sim state. Intact houses are
 * placed once; afterwards only members whose pose changed are rewritten.
 */
import * as THREE from "three";
import type { MemberKind } from "../core/structure/framing";
import type { DetailView } from "../sim/detailBackend";
import { DOD_COLORS } from "./houses";

type SlotKey = MemberKind | "tri" | "triM" | "triGlass";
const BOX_KINDS: MemberKind[] = ["wallFrame", "sillPlate", "gableFrame", "partition", "door", "drywall", "wallSheet", "siding", "trim", "pane", "garageDoor", "rafterPair", "roofSheet", "roofShingle", "ceiling", "fascia"];

/** Unit right-triangle prism (as the lab's): right angle at the origin, legs +x (−x mirrored) and +y. */
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

interface Slot {
  key: SlotKey;
  index: number;
  member: number;
  shape: number;
}

export interface DetailLayer {
  group: THREE.Group;
  /** With damage colors on, the outer finish (siding, shingles) takes the house's DOD color,
   *  as the component houses do; bare sheathing and framing keep their materials. */
  sync(view: DetailView, damageColors?: boolean): void;
}

const TINTED = new Set<string>(["siding", "roofShingle"]);

export function createDetailLayer(): DetailLayer {
  const group = new THREE.Group();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const tri = triGeometry(false);
  const triM = triGeometry(true);
  const glass = () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.7 });
  const meshes = new Map<SlotKey, THREE.InstancedMesh>();
  const used = new Map<SlotKey, number>();
  const free = new Map<SlotKey, number[]>();
  /** House → its slots, and the view version its members were last written at. */
  const houses = new Map<number, { slots: Slot[]; seen: number; tint: number }>();
  let lastVersion = -1;
  let lastColors = false;
  const m4 = new THREE.Matrix4();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const sq = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const off = new THREE.Vector3();
  const color = new THREE.Color();

  function meshFor(key: SlotKey, need: number): THREE.InstancedMesh {
    let mesh = meshes.get(key);
    if (mesh && mesh.instanceMatrix.count >= need) return mesh;
    // Grow (double) and copy what's there.
    const cap = Math.max(need, (mesh?.instanceMatrix.count ?? 512) * 2);
    const geo = key === "tri" || key === "triGlass" ? tri : key === "triM" ? triM : box;
    const mat = key === "pane" || key === "triGlass" ? glass() : new THREE.MeshLambertMaterial();
    const next = new THREE.InstancedMesh(geo, mat, cap);
    next.frustumCulled = false;
    next.setColorAt(0, color.setHex(0xffffff));
    for (let i = 0; i < cap; i++) next.setMatrixAt(i, zero);
    if (mesh) {
      next.instanceMatrix.array.set(mesh.instanceMatrix.array as Float32Array);
      if (mesh.instanceColor && next.instanceColor) next.instanceColor.array.set(mesh.instanceColor.array as Float32Array);
      group.remove(mesh);
      mesh.dispose();
    }
    next.count = used.get(key) ?? 0;
    group.add(next);
    meshes.set(key, next);
    return next;
  }

  function alloc(key: SlotKey): number {
    const f = free.get(key);
    if (f?.length) return f.pop()!;
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    const mesh = meshFor(key, n + 1);
    mesh.count = n + 1;
    return n;
  }

  function write(view: DetailView, houseIndex: number, s: Slot): void {
    const h = view.houses.get(houseIndex)!;
    const mesh = meshes.get(s.key)!;
    const o = s.member * 7;
    const p = h.poses;
    if (p[o + 1]! < -1000) {
      mesh.setMatrixAt(s.index, zero); // gone (left the area)
      return;
    }
    const sh = h.framing.members[s.member]!.shapes[s.shape]!;
    quat.set(p[o + 3]!, p[o + 4]!, p[o + 5]!, p[o + 6]!);
    off.set(sh.pos.x, sh.pos.y, sh.pos.z).applyQuaternion(quat);
    pos.set(p[o]! + off.x, p[o + 1]! + off.y, p[o + 2]! + off.z);
    sq.set(sh.q[0], sh.q[1], sh.q[2], sh.q[3]);
    scl.set(sh.size[0], sh.size[1], sh.size[2]);
    mesh.setMatrixAt(s.index, m4.compose(pos, quat.multiply(sq), scl));
  }

  return {
    group,
    sync(view, damageColors = false) {
      const colorsChanged = damageColors !== lastColors;
      lastColors = damageColors;
      const touched = new Set<SlotKey>();
      // Damage tint: rewrite a house's finish colors when its tint changes.
      for (const [i, mine] of houses) {
        const h = view.houses.get(i);
        if (!h) continue;
        const dod = h.building.dod;
        const tint = damageColors && dod > 0 ? DOD_COLORS[dod]! : -1;
        if (tint === mine.tint && !colorsChanged) continue;
        mine.tint = tint;
        for (const s of mine.slots) {
          const m = h.framing.members[s.member]!;
          if (!TINTED.has(m.kind)) continue;
          meshes.get(s.key)!.setColorAt(s.index, color.setHex(tint >= 0 ? tint : m.color));
          touched.add(s.key);
        }
      }
      if (view.version === lastVersion && !touched.size) return;
      lastVersion = view.version;
      // Houses no longer detailed: free their slots.
      for (const [i, h] of houses) {
        if (view.houses.has(i)) continue;
        for (const s of h.slots) {
          meshes.get(s.key)!.setMatrixAt(s.index, zero);
          (free.get(s.key) ?? free.set(s.key, []).get(s.key)!).push(s.index);
          touched.add(s.key);
        }
        houses.delete(i);
      }
      for (const [i, h] of view.houses) {
        let mine = houses.get(i);
        if (!mine) {
          // New house: a slot per member shape.
          const slots: Slot[] = [];
          h.framing.members.forEach((m, mi) =>
            m.shapes.forEach((sh, si) => {
              const key: SlotKey = sh.tri ? (m.kind === "pane" ? "triGlass" : sh.tri.mirror ? "triM" : "tri") : BOX_KINDS.includes(m.kind) ? m.kind : "wallSheet";
              const index = alloc(key);
              meshes.get(key)!.setColorAt(index, color.setHex(m.color));
              slots.push({ key, index, member: mi, shape: si });
              touched.add(key);
            }),
          );
          mine = { slots, seen: -1, tint: -1 };
          houses.set(i, mine);
          for (const s of slots) write(view, i, s);
          mine.seen = view.houseVersion.get(i) ?? 0;
          continue;
        }
        const v = view.houseVersion.get(i) ?? 0;
        if (v === mine.seen) continue;
        // Members whose pose changed since this house was last written.
        const stamp = view.stamps.get(i)!;
        for (const s of mine.slots) {
          if (stamp[s.member]! <= mine.seen) continue;
          write(view, i, s);
          touched.add(s.key);
        }
        mine.seen = v;
      }
      for (const k of touched) {
        const mesh = meshes.get(k)!;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    },
  };
}
