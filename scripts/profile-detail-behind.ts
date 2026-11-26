/**
 * What the detail zone spends its time on behind the tornado (Spec 09 performance): per-method
 * cost by distance behind, and a census of loose pieces by what they are doing.
 *   npx tsx scripts/profile-detail-behind.ts [preset=ef4-wedge] [houses=10] [stopRmax=4]
 * Stops once every house is stopRmax·R_max behind the tornado.
 */
import RAPIER from "@dimforge/rapier3d-simd-compat";
import { PRESETS } from "../src/config/presets";
import { DETAIL } from "../src/config/structure";
import { createLocalBackend } from "../src/sim/detailBackend";
import { createSim } from "../src/sim/loop";
import { DetailHouse, initRapier, StructureWorld } from "../src/sim/structureWorld";

await initRapier();
const preset = PRESETS.find((p) => p.id === (process.argv[2] ?? "ef4-wedge"))!;
const nHouses = Number(process.argv[3] ?? 10);
const stopR = Number(process.argv[4] ?? 4);
type T = { center: { x: number; z: number }; velocity: { x: number; z: number }; rMax: number };
let tornado = null as T | null;
const bandOf = (b: { x: number; z: number }): string => {
  const s = tornado!;
  const dx = b.x - s.center.x;
  const dz = b.z - s.center.z;
  if (dx * s.velocity.x + dz * s.velocity.z >= 0) return "ahead";
  const r = Math.hypot(dx, dz) / s.rMax;
  return r < 1 ? "behind 0–1" : r < 2 ? "behind 1–2" : "behind 2+";
};
const BANDS = ["ahead", "behind 0–1", "behind 1–2", "behind 2+"];
const METHODS = ["loads", "checkGroups", "aero", "stepLight", "rapier+rest"];
const cost = new Map<string, Record<string, number>>(BANDS.map((b) => [b, Object.fromEntries(METHODS.map((m) => [m, 0]))]));
const steps = new Map<string, number>(BANDS.map((b) => [b, 0]));
const cur = new WeakMap<DetailHouse, string>();
for (const name of ["loads", "checkGroups", "aero", "stepLight"]) {
  const proto = DetailHouse.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const f = proto[name]!;
  proto[name] = function (this: DetailHouse, ...a: unknown[]) {
    const t = performance.now();
    const r = f.apply(this, a);
    cost.get(cur.get(this) ?? "ahead")![name]! += performance.now() - t;
    return r;
  };
}
{
  const proto = StructureWorld.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const f = proto.step!;
  proto.step = function (this: StructureWorld, ...a: unknown[]) {
    const live = this.houses.filter((h) => !h.frozen);
    let awake = 0;
    const per = new Map<string, number>();
    for (const h of live) {
      const k = bandOf(h.building);
      cur.set(h, k);
      steps.set(k, steps.get(k)! + 1);
      let w = 1;
      for (const [handle] of h.groupBodies) if (!this.world.getRigidBody(handle).isSleeping()) w++;
      per.set(k, (per.get(k) ?? 0) + w);
      awake += w;
    }
    const before = [...cost.values()].reduce((p, c) => p + c.loads! + c.checkGroups! + c.aero! + c.stepLight!, 0);
    const t = performance.now();
    const r = f.apply(this, a);
    const dt = performance.now() - t;
    const own = [...cost.values()].reduce((p, c) => p + c.loads! + c.checkGroups! + c.aero! + c.stepLight!, 0) - before;
    for (const [k, w] of per) cost.get(k)!["rapier+rest"]! += ((dt - own) * w) / Math.max(awake, 1);
    return r;
  };
}

// Census of loose pieces, per band.
type Census = Record<string, number>;
const census = new Map<string, Census>();
let samples = 0;
const add = (k: string, what: string) => {
  const c = census.get(k) ?? {};
  c[what] = (c[what] ?? 0) + 1;
  census.set(k, c);
};
function take(sw: StructureWorld, h: DetailHouse): void {
  const k = bandOf(h.building);
  const hx = h as unknown as { onlyFixedContacts(b: RAPIER.RigidBody): boolean; stillSince: Map<number, number> };
  for (const [handle] of h.groupBodies) {
    const b = sw.world.getRigidBody(handle);
    if (b.isSleeping()) {
      add(k, "rigid: asleep");
      continue;
    }
    const v = b.linvel();
    const w = b.angvel();
    const sp = Math.hypot(v.x, v.y, v.z);
    const spin = Math.hypot(w.x, w.y, w.z);
    if (sp >= 1 || spin >= 1) add(k, "rigid: moving ≥1 m/s");
    else if (sp >= DETAIL.rubbleSpeed || spin >= DETAIL.rubbleSpin) add(k, "rigid: creeping 0.1–1 m/s");
    else if (!hx.onlyFixedContacts(b)) add(k, "rigid: still, leaning on a standing house or moving piece");
    else add(k, "rigid: still, about to become rubble");
  }
  add(k, `rubble (fixed)`);
  census.get(k)!["rubble (fixed)"]! += h.rubble.size - 1;
  for (const { piece: p } of h.light.values()) {
    const sp = Math.hypot(p.vel.x, p.vel.y, p.vel.z);
    if (p.resting) add(k, "light: resting");
    else if (!p.grounded && !sw.lightSupported(p)) add(k, "light: airborne");
    else if (sp >= DETAIL.creepSpeed) add(k, "light: sliding ≥0.2 m/s");
    else add(k, "light: jittering in place (<0.2 m/s, not resting)");
  }
}

let backend = null as ReturnType<typeof createLocalBackend> | null;
const sim = createSim({ detailHouses: nHouses }, 1, preset.params, (_s, b) => (backend = createLocalBackend(b, 1)));
sim.setDetailFocus({ x: -650, z: 1130 });
const t0 = performance.now();
for (let n = 0; n < 60 * 600; n++) {
  sim.advance(1 / 60);
  const e = backend?.engines[0];
  const s = sim.snapshot.tornado;
  tornado = s;
  if (!e || !e.houses.size) continue;
  if (n % 60 === 0) {
    samples++;
    for (const [i, h] of e.houses) if (!h.frozen) take(e.worldFor(i)!, h);
  }
  if (n % 1800 === 0) console.error(`progress: sim ${sim.time.toFixed(0)} s, wall ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  const far = [...e.houses.values()].every((h) => {
    const dx = h.building.x - s.center.x;
    const dz = h.building.z - s.center.z;
    return dx * s.velocity.x + dz * s.velocity.z < 0 && Math.hypot(dx, dz) > stopR * s.rMax;
  });
  if (far) break;
}
console.log(`${preset.id}, ${nHouses} houses, until ${stopR} R_max behind; wall ${((performance.now() - t0) / 1000).toFixed(0)} s, sim ${sim.time.toFixed(0)} s`);
console.log("\nms per house-step by method:");
console.log("band          " + METHODS.map((m) => m.padStart(12)).join("") + "       total");
for (const b of BANDS) {
  const n = Math.max(1, steps.get(b)!);
  const c = cost.get(b)!;
  const tot = METHODS.reduce((p, m) => p + c[m]!, 0);
  console.log(b.padEnd(14) + METHODS.map((m) => (c[m]! / n).toFixed(2).padStart(12)).join("") + (tot / n).toFixed(2).padStart(12) + `   (${steps.get(b)} house-steps)`);
}
console.log("\nloose pieces per house (mean of 1 Hz samples):");
for (const b of BANDS) {
  const c = census.get(b);
  if (!c) continue;
  console.log(`  ${b}:`);
  const n = (steps.get(b)! / 60) || 1;
  for (const [what, k] of Object.entries(c).sort()) console.log(`    ${what.padEnd(58)} ${(k / n).toFixed(1).padStart(7)}`);
}
