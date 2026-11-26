/**
 * Where the detail zone's time goes by house state (Spec 09 performance), over one pass.
 *   npx tsx scripts/profile-detail-states.ts [preset=ef4-wedge] [x,z=-650,1130]
 * Each house's per-step work (loads, checkGroups, aero, stepLight) is timed against its state
 * that step; each physics group's shared work (the Rapier step, CCD set-up, events) is split
 * among its houses by their awake bodies plus light pieces still moving (evenly when nothing
 * moves). States: ahead (in the zone, tornado not yet past), damaging (in the zone, past,
 * load solve running), calm (in the zone, past, calm skip on), settling (left, not frozen),
 * frozen. Prints totals and, per house, when it went calm behind the tornado and when it left
 * and froze.
 */
import RAPIER from "@dimforge/rapier3d-simd-compat";
import { PRESETS } from "../src/config/presets";
import { createLocalBackend } from "../src/sim/detailBackend";
import { createSim } from "../src/sim/loop";
import { DetailEngine } from "../src/sim/detailZone";
import { DetailHouse, initRapier, StructureWorld } from "../src/sim/structureWorld";
import { DETAIL } from "../src/config/structure";

await initRapier();
const presetId = process.argv[2] ?? "ef4-wedge";
const [fx, fz] = (process.argv[3] ?? "-650,1130").split(",").map(Number) as [number, number];
const preset = PRESETS.find((p) => p.id === presetId)!;

type State = "ahead" | "damaging" | "calm" | "settling" | "frozen";
const STATES: State[] = ["ahead", "damaging", "calm", "settling", "frozen"];
const cost: Record<State, number> = { ahead: 0, damaging: 0, calm: 0, settling: 0, frozen: 0 };
const houseSteps: Record<State, number> = { ahead: 0, damaging: 0, calm: 0, settling: 0, frozen: 0 };
let engineOther = 0;
/** Cost, house-steps, failures and roof wind by distance behind the tornado (whole R_max). */
const band = new Map<string, { ms: number; steps: number; fails: number; mph: number }>();
const bandOf = (b: { x: number; z: number }): string => {
  const s = tornado!;
  const dx = b.x - s.center.x;
  const dz = b.z - s.center.z;
  if (dx * s.velocity.x + dz * s.velocity.z >= 0) return "ahead";
  return `behind ${Math.floor(Math.hypot(dx, dz) / s.rMax)}–${Math.floor(Math.hypot(dx, dz) / s.rMax) + 1} R`;
};
const bandRow = (k: string) => {
  let r = band.get(k);
  if (!r) band.set(k, (r = { ms: 0, steps: 0, fails: 0, mph: 0 }));
  return r;
};
const frozenAtT = new Map<number, number>();
let simT = 0;
let worldsTotal = 0;
let tornado = null as { center: { x: number; z: number }; velocity: { x: number; z: number }; rMax: number } | null;

const stateOf = (h: DetailHouse): State => {
  if (h.frozen) return "frozen";
  if (h.releasedAt !== null) return "settling";
  const b = h.building;
  const s = tornado!;
  const behind = (b.x - s.center.x) * s.velocity.x + (b.z - s.center.z) * s.velocity.z < 0;
  if (!behind) return "ahead";
  return h.calmSkipped ? "calm" : "damaging";
};

// Per-house methods.
const current = new WeakMap<DetailHouse, State>();
const currentBand = new WeakMap<DetailHouse, string>();
for (const name of ["loads", "checkGroups", "aero", "stepLight"]) {
  const proto = DetailHouse.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const f = proto[name]!;
  proto[name] = function (this: DetailHouse, ...a: unknown[]) {
    const t = performance.now();
    const r = f.apply(this, a);
    const dt = performance.now() - t;
    cost[current.get(this) ?? "ahead"] += dt;
    if (this.releasedAt === null) bandRow(currentBand.get(this) ?? "ahead").ms += dt;
    return r;
  };
}
let perHouseInWorld = 0;
// Shared work per physics group: the world step minus its houses' own methods.
{
  const proto = StructureWorld.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const f = proto.step!;
  proto.step = function (this: StructureWorld, ...a: unknown[]) {
    const weights: [State, number][] = [];
    for (const h of this.houses) {
      const st = stateOf(h);
      current.set(h, st);
      houseSteps[st]++;
      if (!h.frozen && h.releasedAt === null) {
        const k = bandOf(h.building);
        currentBand.set(h, k);
        const r = bandRow(k);
        r.steps++;
        r.mph += h.refMph;
      }
      if (h.frozen) continue;
      let w = 0;
      for (const [handle] of h.groupBodies) if (!this.world.getRigidBody(handle).isSleeping()) w++;
      for (const { piece } of (h as unknown as { light: Map<number, { piece: { resting: boolean } }> }).light.values()) if (!piece.resting) w++;
      weights.push([st, w]);
    }
    const before = Object.values(cost).reduce((p, q) => p + q, 0);
    const t = performance.now();
    const r = f.apply(this, a);
    const dt = performance.now() - t;
    worldsTotal += dt;
    const own = Object.values(cost).reduce((p, q) => p + q, 0) - before;
    perHouseInWorld += own;
    const shared = dt - own;
    const W = weights.reduce((p, [, w]) => p + w, 0);
    const hs = this.houses.filter((h) => !h.frozen);
    weights.forEach(([st, w], k) => {
      const share = shared * (W > 0 ? w / W : 1 / weights.length);
      cost[st] += share;
      const h = hs[k]!;
      if (h.releasedAt === null) bandRow(currentBand.get(h)!).ms += share;
    });
    return r;
  };
}
{
  const proto = DetailEngine.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const f = proto.step!;
  proto.step = function (this: DetailEngine, ...a: unknown[]) {
    tornado = (a[0] as { tornado: typeof tornado }).tornado;
    const w0 = worldsTotal;
    const t = performance.now();
    const r = f.apply(this, a);
    engineOther += performance.now() - t - (worldsTotal - w0);
    const res = r as { failLog: { house: number }[]; frozen: { index: number }[] };
    for (const f of res.failLog) bandRow(bandOf((this as unknown as { buildings: { x: number; z: number }[] }).buildings[f.house]!)).fails++;
    for (const f of res.frozen) frozenAtT.set(f.index, simT);
    return r;
  };
}

let backend = null as ReturnType<typeof createLocalBackend> | null;
const sim = createSim({}, 1, preset.params, (_s, b) => (backend = createLocalBackend(b, 1)));
sim.setDetailFocus({ x: fx, z: fz });

interface Track {
  enterT: number;
  behindT: number | null;
  /** Behind and calm (calm skip on) continuously since this time. */
  calmSinceT: number | null;
  calmSinceR: number | null;
  exitT: number | null;
  exitR: number | null;
  frozenT: number | null;
  failures: number;
  movingAtFreeze: number;
}
const track = new Map<number, Track>();
const t0 = performance.now();
let entered = false;
for (let n = 0; n < 60 * 600; n++) {
  sim.advance(1 / 60);
  simT = sim.time;
  if (n % 3600 === 3599) console.error(`progress: sim ${sim.time.toFixed(0)} s, wall ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  const e = backend?.engines[0];
  if (!e || !tornado) continue;
  const tNow = sim.time;
  const s = tornado;
  for (const [i, h] of e.houses) {
    let tr = track.get(i);
    if (!tr) {
      tr = { enterT: tNow, behindT: null, calmSinceT: null, calmSinceR: null, exitT: null, exitR: null, frozenT: null, failures: 0, movingAtFreeze: 0 };
      track.set(i, tr);
    }
    const b = h.building;
    const dx = b.x - s.center.x;
    const dz = b.z - s.center.z;
    const behind = dx * s.velocity.x + dz * s.velocity.z < 0;
    const dR = Math.hypot(dx, dz) / s.rMax;
    if (behind && tr.behindT === null) tr.behindT = tNow;
    if (tr.exitT === null) {
      if (behind && h.calmSkipped) {
        if (tr.calmSinceT === null) {
          tr.calmSinceT = tNow;
          tr.calmSinceR = dR;
        }
      } else {
        tr.calmSinceT = null;
        tr.calmSinceR = null;
      }
    }
    if (h.releasedAt !== null && tr.exitT === null) {
      tr.exitT = tNow;
      tr.exitR = dR;
    }
    if (h.frozen && tr.frozenT === null) {
      tr.frozenT = tNow;
      tr.failures = h.failures.length;
    } else if (!h.frozen) tr.movingAtFreeze = h.movingGroups;
  }
  if (e.houses.size) entered = true;
  if (entered && [...e.houses.values()].every((h) => h.frozen)) break;
}
const wall = (performance.now() - t0) / 1000;

const total = STATES.reduce((p, s) => p + cost[s], 0) + engineOther;
console.log(`preset ${preset.id} spot ${fx},${fz}  R_max ${preset.params.rMax} m  wall ${wall.toFixed(0)} s  (exitRmax ${DETAIL.exitRmax}, settleTimeout ${DETAIL.settleTimeout})`);
console.log("state      ms total   share   house-steps   ms/house-step");
for (const st of STATES)
  console.log(`${st.padEnd(10)} ${cost[st].toFixed(0).padStart(8)}  ${((100 * cost[st]) / total).toFixed(1).padStart(5)}%  ${String(houseSteps[st]).padStart(10)}   ${(cost[st] / Math.max(1, houseSteps[st])).toFixed(3)}`);
console.log(`engine     ${engineOther.toFixed(0).padStart(8)}  ${((100 * engineOther) / total).toFixed(1).padStart(5)}%   (poses, survey, freeze; all states)`);
console.log(`after passage (calm + settling): ${(((cost.calm + cost.settling) / total) * 100).toFixed(1)}%`);
console.log("in the zone, by distance behind the tornado:\nband          ms total  share   house-steps  ms/house-step  failures  mean roof mph");
const keys = [...band.keys()].sort((a, b) => (a === "ahead" ? -1 : b === "ahead" ? 1 : parseInt(a.slice(7)) - parseInt(b.slice(7))));
for (const k of keys) {
  const r = band.get(k)!;
  console.log(`${k.padEnd(12)} ${r.ms.toFixed(0).padStart(9)}  ${((100 * r.ms) / total).toFixed(1).padStart(5)}%  ${String(r.steps).padStart(10)}  ${(r.ms / Math.max(1, r.steps)).toFixed(2).padStart(10)}  ${String(r.fails).padStart(8)}  ${(r.mph / Math.max(1, r.steps)).toFixed(0).padStart(8)}`);
}
console.log("house  enter  behind  calmSince(R)   exit(R)    frozen  fails  moving@freeze");
for (const [i, tr] of [...track].sort((a, b) => a[1].enterT - b[1].enterT)) {
  const f = (v: number | null, d = 0) => (v === null ? "-" : v.toFixed(d));
  console.log(
    `${String(i).padStart(5)}  ${f(tr.enterT).padStart(5)}  ${f(tr.behindT).padStart(6)}  ${f(tr.calmSinceT).padStart(5)} (${f(tr.calmSinceR, 1)})  ${f(tr.exitT).padStart(5)} (${f(tr.exitR, 1)})  ${f(frozenAtT.get(i) ?? null).padStart(6)}  ${String(tr.failures).padStart(5)}  ${tr.movingAtFreeze}`,
  );
}
