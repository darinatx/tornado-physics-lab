/**
 * Load-path solver (Spec 09): external forces flow from each member to its intact supports,
 * split equally; connections fail when their non-compressive load exceeds capacity.
 */
import type { Vec3 } from "../math/vec";
import type { Framing } from "./framing";

export interface LoadPathResult {
  /** Load magnitude on each connection (N), tension/shear only. */
  loads: number[];
  /** Load vector delivered to each connection's support. */
  vectors: Vec3[];
  /** Connections whose load exceeds capacity. */
  failed: number[];
  /** Total force delivered to the slab (or to group roots when solving a subset). */
  toRoots: Vec3;
}

/**
 * Solve over `subset` (member ids; all members if omitted). Members with no intact support
 * inside the subset (or the slab, when `slabIsSupport`) are roots: their accumulated load is
 * balanced elsewhere (by the ground or by the group's inertia).
 */
export function solveLoadPath(
  f: Framing,
  forces: Vec3[],
  intact: boolean[],
  subset?: number[],
  slabIsSupport = true,
  /** Optional: adjust a member's accumulated load before it goes to its supports (e.g. the
   *  share a braced wall sends into the roof diaphragm instead). Returns the load it keeps. */
  relieve?: (id: number, t: Vec3) => Vec3,
): LoadPathResult {
  const n = f.members.length;
  const inSet = new Uint8Array(n);
  if (subset) for (const id of subset) inSet[id] = 1;
  else inSet.fill(1);
  // Running totals per member (x, y, z), seeded with its own external force.
  const T = new Float64Array(3 * n);
  for (let id = 0; id < n; id++) {
    if (!inSet[id]) continue;
    const F = forces[id]!;
    T[3 * id] = F.x;
    T[3 * id + 1] = F.y;
    T[3 * id + 2] = F.z;
  }
  const loads = new Array<number>(f.connections.length).fill(0);
  const vectors: Vec3[] = new Array(f.connections.length);
  const failed: number[] = [];
  const toRoots: Vec3 = { x: 0, y: 0, z: 0 };
  const sup: number[] = [];
  // Highest level first: supports always sit at a lower level.
  for (const id of levelOrder(f).desc) {
    if (!inSet[id]) continue;
    sup.length = 0;
    for (const c of f.supportsOf[id]!) {
      const to = f.connections[c]!.to;
      if (intact[c] && (to === -1 ? slabIsSupport : inSet[to] === 1)) sup.push(c);
    }
    let tx = T[3 * id]!;
    let ty = T[3 * id + 1]!;
    let tz = T[3 * id + 2]!;
    if (relieve) {
      const kept = relieve(id, { x: tx, y: ty, z: tz });
      toRoots.x += tx - kept.x;
      toRoots.y += ty - kept.y;
      toRoots.z += tz - kept.z;
      tx = kept.x;
      ty = kept.y;
      tz = kept.z;
    }
    if (sup.length === 0) {
      toRoots.x += tx;
      toRoots.y += ty;
      toRoots.z += tz;
      continue;
    }
    const k = 1 / sup.length;
    const sx = tx * k;
    const sy = ty * k;
    const sz = tz * k;
    for (const c of sup) {
      const con = f.connections[c]!;
      vectors[c] = { x: sx, y: sy, z: sz };
      // Compression into the support is carried by bearing, not by the fasteners.
      const along = sx * con.axis.x + sy * con.axis.y + sz * con.axis.z;
      const comp = along < 0 ? along : 0;
      const l = Math.hypot(sx - comp * con.axis.x, sy - comp * con.axis.y, sz - comp * con.axis.z);
      loads[c] = l;
      if (l > con.capacity) failed.push(c);
      if (con.to === -1) {
        toRoots.x += sx;
        toRoots.y += sy;
        toRoots.z += sz;
      } else {
        const j = 3 * con.to;
        T[j] = T[j]! + sx;
        T[j + 1] = T[j + 1]! + sy;
        T[j + 2] = T[j + 2]! + sz;
      }
    }
  }
  for (let c = 0; c < vectors.length; c++) vectors[c] ??= { x: 0, y: 0, z: 0 };
  return { loads, vectors, failed, toRoots };
}

const orders = new WeakMap<Framing, { asc: number[]; desc: number[] }>();
/** Member ids by load-path level (cached per framing: the graph never changes). */
function levelOrder(f: Framing): { asc: number[]; desc: number[] } {
  let o = orders.get(f);
  if (!o) {
    const asc = f.members.map((m) => m.id).sort((a, b) => f.members[a]!.level - f.members[b]!.level || a - b);
    o = { asc, desc: [...asc].reverse() };
    orders.set(f, o);
  }
  return o;
}

/** Members with an intact path to the slab. */
export function attachedToSlab(f: Framing, intact: boolean[]): boolean[] {
  const att = f.members.map(() => false);
  for (const id of levelOrder(f).asc) {
    const m = f.members[id]!;
    att[m.id] = f.supportsOf[m.id]!.some((c) => {
      const con = f.connections[c]!;
      return intact[c] && (con.to === -1 || att[con.to]!);
    });
  }
  return att;
}

/** Group members (from `candidates`) that are still connected to each other by intact connections. */
export function groupsOf(f: Framing, intact: boolean[], candidates: number[]): number[][] {
  const inSet = new Set(candidates);
  const parent = new Map<number, number>();
  for (const id of candidates) parent.set(id, id);
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const c of f.connections) {
    if (!intact[c.id] || c.to < 0) continue;
    if (inSet.has(c.from) && inSet.has(c.to)) parent.set(find(c.from), find(c.to));
  }
  const groups = new Map<number, number[]>();
  for (const id of candidates) {
    const r = find(id);
    const g = groups.get(r);
    if (g) g.push(id);
    else groups.set(r, [id]);
  }
  return [...groups.values()];
}
