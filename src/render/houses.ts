import { LUMBER } from "../config/structure";
/**
 * Component houses (Spec 06 v1.5, REND-08): every wall panel, pane, roof section, rafter,
 * gable, partition, slab, sill plate and anchor bolt is its own instance, shown or hidden
 * by that component's state.
 */
import * as THREE from "three";
import { IMPACT } from "../config/impacts";
import { LAYOUT } from "../config/buildings";
import { faceTangent, LOCAL_NORMALS, panelCenter, sectionGeometry, toWorld } from "../core/damage/layout";
import type { Building } from "../core/damage/types";

/** DOD color bands: 1–2 yellow, 3–4 orange, 5–6 red-orange, 7–8 red, 9–10 purple. */
export const DOD_COLORS = [0, 0xe9cf5b, 0xe9cf5b, 0xf08c3a, 0xf08c3a, 0xe05a2e, 0xe05a2e, 0xc42b3a, 0xc42b3a, 0x7d2a8c, 0x7d2a8c] as const;

export const HOUSE_COLORS = {
  sheathing: 0xc8b08a,
  plywood: 0xb8935a,
  rafter: 0xc9a36b,
  glass: 0x6f8fa6,
  brokenGlass: 0x1c2024,
  garageDoor: 0xe6e2da,
  drywall: 0xd9d4c7,
  slab: 0x9a978f,
  sill: 0x8a6a45,
  bolt: 0x3a3c40,
} as const;

type Q = [number, number, number, number];
export interface Inst {
  p: [number, number, number];
  q: Q;
  s: [number, number, number];
  color: number;
}

export const MESHES = ["panels", "panes", "garage", "roof", "rafters", "gables", "partitions", "slab", "sills", "bolts"] as const;
export type MeshName = (typeof MESHES)[number];
export type HouseDraw = Record<MeshName, Inst[]>;

/** Slab top (m): shared with the impact envelope (Spec 10). */
const SLAB = IMPACT.slabTop;
const BOLTS = 8;

/** Slots each house needs per mesh (fixed by its layout). */
export function houseSlots(b: Building): Record<MeshName, number> {
  return {
    panels: b.panels.length,
    panes: b.panes.length,
    garage: 1,
    roof: b.sections.length,
    rafters: b.nx * 4,
    gables: 2,
    partitions: 3,
    slab: 1,
    sills: b.panels.length,
    bolts: BOLTS,
  };
}

const yawQ = (a: number): Q => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
function mul(a: Q, b: Q): Q {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
const pitchQ = (a: number): Q => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];

/** Pure: the visible component instances of a house (REND-08). */
export function houseInstances(b: Building, damageColors: boolean): HouseDraw {
  const d: HouseDraw = { panels: [], panes: [], garage: [], roof: [], rafters: [], gables: [], partitions: [], slab: [], sills: [], bolts: [] };
  const tint = damageColors && b.dod > 0 ? DOD_COLORS[b.dod]! : null;
  const H = b.wallHeight;
  const w = (lx: number, ly: number, lz: number, shifted = true): [number, number, number] => {
    const v = toWorld(b, lx, ly, lz, shifted);
    return [v.x, v.y, v.z];
  };
  const swept = !!b.sweep.failed;

  if (b.detail) {
    // Detailed house (Spec 09 slice B): its members are drawn by the detail layer; the slab
    // here matches the detail model's (flush with the wall frames).
    d.slab.push({ p: w(0, 0, 0, false), q: yawQ(b.yaw), s: [b.width + LUMBER.stud[1], SLAB, b.depth + LUMBER.stud[1]], color: HOUSE_COLORS.slab });
    return d;
  }
  d.slab.push({ p: w(0, 0, 0, false), q: yawQ(b.yaw), s: [b.width + 0.6, SLAB, b.depth + 0.6], color: HOUSE_COLORS.slab });

  b.panels.forEach((panel, i) => {
    const t = faceTangent(panel.face);
    const n = LOCAL_NORMALS[panel.face]!;
    const q = yawQ(b.yaw + Math.atan2(-t.z, t.x));
    const c = panelCenter(b, panel, 0);
    if (panel.failed) {
      if (!swept) d.sills.push({ p: w(c.x, SLAB, c.z, false), q, s: [panel.len, 0.06, 0.15], color: HOUSE_COLORS.sill });
      return;
    }
    // Bare sheathing always shows through the damage tint: stripped walls must look stripped.
    const stripped = !!b.siding[i]!.failed;
    d.panels.push({ p: w(c.x, SLAB + H / 2, c.z), q, s: [panel.len, H, 0.15], color: stripped ? HOUSE_COLORS.sheathing : tint ?? b.wallColor });
    if (panel.isGarage && b.garage && !b.garage.failed) {
      d.garage.push({ p: w(c.x + n.x * 0.09, SLAB + LAYOUT.garageHeight / 2, c.z + n.z * 0.09), q, s: [Math.min(LAYOUT.garageWidth, panel.len * 0.9), LAYOUT.garageHeight, 0.04], color: HOUSE_COLORS.garageDoor });
    }
  });
  for (const pane of b.panes) {
    const panel = b.panels[pane.panel]!;
    if (panel.failed) continue;
    const t = faceTangent(panel.face);
    const n = LOCAL_NORMALS[panel.face]!;
    const c = panelCenter(b, panel, 0);
    d.panes.push({
      p: w(c.x + n.x * 0.09, SLAB + LAYOUT.paneSill + LAYOUT.paneSize / 2, c.z + n.z * 0.09),
      q: yawQ(b.yaw + Math.atan2(-t.z, t.x)),
      s: [LAYOUT.paneSize, LAYOUT.paneSize, 0.04],
      color: pane.failed ? HOUSE_COLORS.brokenGlass : HOUSE_COLORS.glass,
    });
  }

  // Roof: sections on standing bays; rafters where the deck is gone.
  for (const s of b.sections) {
    if (b.bays[s.col]!.failed || s.deck) continue;
    const g = sectionGeometry(b, b.nx, s);
    d.roof.push({
      p: w(g.center.x, SLAB + g.center.y, g.center.z),
      q: mul(yawQ(b.yaw), pitchQ(g.pitch)),
      s: [g.width, 0.15, g.length],
      color: s.cover ? HOUSE_COLORS.plywood : tint ?? b.roofColor,
    });
  }
  for (let col = 0; col < b.nx; col++) {
    if (b.bays[col]!.failed) continue;
    for (const slope of [-1, 1] as const) {
      const exposed = b.sections.some((s) => s.col === col && s.slope === slope && s.deck);
      if (!exposed) continue;
      const g0 = sectionGeometry(b, b.nx, { col, slope, row: 0, edge: false, area: 0, coverCap: 0, deckCap: 0, cover: null, deck: null });
      const g1 = sectionGeometry(b, b.nx, { col, slope, row: 1, edge: false, area: 0, coverCap: 0, deckCap: 0, cover: null, deck: null });
      for (const f of [0.25, 0.75]) {
        const x = g0.center.x - g0.width / 2 + f * g0.width;
        d.rafters.push({
          p: w(x, SLAB + (g0.center.y + g1.center.y) / 2 - 0.1, (g0.center.z + g1.center.z) / 2),
          q: mul(yawQ(b.yaw), pitchQ(g0.pitch)),
          s: [0.05, 0.14, g0.length * 2],
          color: HOUSE_COLORS.rafter,
        });
      }
    }
  }
  for (const [face, col] of [[0, b.nx - 1], [2, 0]] as const) {
    // The gable sits on its end wall and goes with the end bay.
    if (b.bays[col]!.failed || b.panels.some((p) => p.face === face && p.failed)) continue;
    const x = (face === 0 ? 1 : -1) * (b.width / 2);
    const stripped = b.panels.some((p, i) => p.face === face && b.siding[i]!.failed);
    d.gables.push({ p: w(x, SLAB + H, 0), q: yawQ(b.yaw), s: [0.15, b.roofRise, b.depth], color: stripped ? HOUSE_COLORS.sheathing : tint ?? b.wallColor });
  }
  const parts: [number, number, number, number][] = [
    [0, b.depth / 6, b.width * 0.8, 0.12],
    [-b.width / 6, 0, 0.12, b.depth * 0.8],
  ];
  b.partitions.forEach((pt, i) => {
    if (pt.failed) return;
    const [x, z, sx, sz] = parts[i]!;
    d.partitions.push({ p: w(x, SLAB + H / 2, z), q: yawQ(b.yaw), s: [sx, H, sz], color: HOUSE_COLORS.drywall });
  });
  // Interior core room (closet/bath): a small solid box near the center.
  if (!b.coreRoom.failed) d.partitions.push({ p: w(b.width / 6, SLAB + H / 2, -b.depth / 8), q: yawQ(b.yaw), s: [2.2, H, 2.0], color: HOUSE_COLORS.drywall });
  if (swept) {
    for (let i = 0; i < BOLTS; i++) {
      const a = (i / BOLTS) * Math.PI * 2;
      const lx = Math.sign(Math.cos(a)) * Math.min(Math.abs(Math.cos(a)) * 1.5, 1) * (b.width / 2 - 0.1);
      const lz = Math.sign(Math.sin(a)) * Math.min(Math.abs(Math.sin(a)) * 1.5, 1) * (b.depth / 2 - 0.1);
      d.bolts.push({ p: w(lx, SLAB + 0.12, lz, false), q: yawQ(b.yaw), s: [0.04, 0.25, 0.04], color: HOUSE_COLORS.bolt });
    }
  }
  return d;
}

function gableGeometry(): THREE.BufferGeometry {
  // Unit triangular prism: base along Z (−0.5..0.5) at y = 0, apex at y = 1, thickness along X.
  const g = new THREE.BufferGeometry();
  const v = [
    -0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0,
    0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, 0,
  ];
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.setIndex([0, 1, 2, 3, 4, 5, 0, 2, 5, 0, 5, 4, 1, 3, 5, 1, 5, 2, 0, 4, 3, 0, 3, 1]);
  g.computeVertexNormals();
  return g;
}

export interface HouseLayer {
  readonly group: THREE.Group;
  /** Rebuild houses whose damage changed (or everything after a reset / color change). */
  sync(buildings: readonly Building[], damageColors: boolean): void;
}

export function createHouseLayer(): HouseLayer {
  const group = new THREE.Group();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const geoms: Record<MeshName, THREE.BufferGeometry> = {
    panels: box, panes: box, garage: box, roof: box, rafters: box,
    gables: gableGeometry(), partitions: box,
    slab: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    sills: box, bolts: box,
  };
  let meshes: Record<MeshName, THREE.InstancedMesh> | null = null;
  let offsets: Record<MeshName, number>[] = [];
  let slots: Record<MeshName, number>[] = [];
  let lastList: readonly Building[] | null = null;
  let lastColors: boolean | null = null;
  let revs: number[] = [];
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const color = new THREE.Color();

  function build(buildings: readonly Building[]): void {
    if (meshes) for (const k of MESHES) group.remove(meshes[k]);
    const totals = Object.fromEntries(MESHES.map((k) => [k, 0])) as Record<MeshName, number>;
    offsets = [];
    slots = [];
    for (const b of buildings) {
      const sl = houseSlots(b);
      offsets.push({ ...totals });
      slots.push(sl);
      for (const k of MESHES) totals[k] += sl[k];
    }
    meshes = Object.fromEntries(
      MESHES.map((k) => {
        const mesh = new THREE.InstancedMesh(geoms[k], new THREE.MeshLambertMaterial({ side: k === "gables" ? THREE.DoubleSide : THREE.FrontSide }), Math.max(totals[k], 1));
        mesh.frustumCulled = false;
        mesh.setColorAt(0, color.setHex(0xffffff));
        group.add(mesh);
        return [k, mesh];
      }),
    ) as unknown as Record<MeshName, THREE.InstancedMesh>;
    revs = buildings.map(() => -1);
  }

  function writeHouse(i: number, b: Building, damageColors: boolean): void {
    const d = houseInstances(b, damageColors);
    for (const k of MESHES) {
      const mesh = meshes![k];
      const base = offsets[i]![k];
      const n = slots[i]![k];
      const list = d[k];
      for (let j = 0; j < n; j++) {
        const inst = list[j];
        if (!inst) {
          mesh.setMatrixAt(base + j, zero);
          continue;
        }
        pos.set(...inst.p);
        q.set(...inst.q);
        scl.set(...inst.s);
        mesh.setMatrixAt(base + j, m.compose(pos, q, scl));
        mesh.setColorAt(base + j, color.setHex(inst.color));
      }
    }
  }

  return {
    group,
    sync(buildings, damageColors) {
      if (buildings !== lastList) build(buildings);
      const all = buildings !== lastList || damageColors !== lastColors;
      lastList = buildings;
      lastColors = damageColors;
      let any = false;
      buildings.forEach((b, i) => {
        if (!all && revs[i] === b.rev) return;
        revs[i] = b.rev;
        writeHouse(i, b, damageColors);
        any = true;
      });
      if (any && meshes) {
        for (const k of MESHES) {
          meshes[k].instanceMatrix.needsUpdate = true;
          if (meshes[k].instanceColor) meshes[k].instanceColor!.needsUpdate = true;
        }
      }
    },
  };
}
