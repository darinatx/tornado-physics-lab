/**
 * Profile of the detail zone (Spec 09 performance): 30 houses around a spot torn apart by the
 * default tornado, in-process, with each phase of the detail step timed. One line per 5 s of
 * sim time while houses are detailed.
 *   npx tsx scripts/profile-detail.ts [x,z=-650,1130] [engines=1]
 * Columns (ms per 1/60 s detail step): step = all engines in sequence; parallel = the slowest
 * engine (the wall time with one worker per engine); group = the costliest physics group.
 */
import RAPIER from "@dimforge/rapier3d-simd-compat";
import { createLocalBackend } from "../src/sim/detailBackend";
import { createSim } from "../src/sim/loop";
import { DetailEngine } from "../src/sim/detailZone";
import { DetailHouse, initRapier, StructureWorld } from "../src/sim/structureWorld";

await initRapier();
const T: Record<string, number> = {};
const time = (label: string, t: number) => (T[label] = (T[label] ?? 0) + performance.now() - t);
const wrap = (proto: Record<string, unknown>, name: string) => {
  const f = proto[name] as (...a: unknown[]) => unknown;
  proto[name] = function (this: unknown, ...a: unknown[]) {
    const t = performance.now();
    const r = f.apply(this, a);
    time(name, t);
    return r;
  };
};
for (const n of ["loads", "checkGroups", "aero", "stepLight"]) wrap(DetailHouse.prototype as unknown as Record<string, unknown>, n);
wrap(RAPIER.World.prototype as unknown as Record<string, unknown>, "step");
const wrapAs = (proto: Record<string, unknown>, name: string, label: string) => {
  const f = proto[name] as (...a: unknown[]) => unknown;
  proto[name] = function (this: unknown, ...a: unknown[]) {
    const t = performance.now();
    const r = f.apply(this, a);
    time(label, t);
    return r;
  };
};
wrapAs(DetailEngine.prototype as unknown as Record<string, unknown>, "step", "engine");
wrapAs(StructureWorld.prototype as unknown as Record<string, unknown>, "step", "worlds");

const [fx, fz] = (process.argv[2] ?? "-650,1130").split(",").map(Number) as [number, number];
const k = Number(process.argv[3] ?? 1);
let backend: ReturnType<typeof createLocalBackend> | null = null;
let par = 0;
let group = 0;
let steps = 0;
const sim = createSim({}, 1, {}, (_s, b) => {
  const be = createLocalBackend(b, k);
  const drain = be.drain.bind(be);
  be.drain = () => {
    const rs = drain();
    for (const r of rs) {
      par += r.ms;
      group += r.groupMs;
      steps++;
    }
    return rs;
  };
  return (backend = be);
});
sim.setDetailFocus({ x: fx, z: fz });
let snap = { ...T };
let wall = 0;
let entered = false;
const t0 = performance.now();
for (let n = 0; n < 60 * 400; n++) {
  const a = performance.now();
  sim.advance(1 / 60);
  wall += performance.now() - a;
  if (n % 300 !== 299) continue;
  const engines = (backend as ReturnType<typeof createLocalBackend> | null)?.engines ?? [];
  let houses = 0;
  let bodies = 0;
  let awake = 0;
  let worlds = 0;
  let light = 0;
  let frozen = 0;
  for (const e of engines) {
    houses += e.houses.size;
    for (const h of e.houses.values()) {
      light += (h as unknown as { light: Map<number, unknown> }).light.size;
      if (h.frozen) frozen++;
    }
    for (const sw of e.worlds.values()) {
      worlds++;
      sw.world.forEachRigidBody((b: RAPIER.RigidBody) => {
        bodies++;
        if (b.isDynamic() && !b.isSleeping()) awake++;
      });
    }
  }
  if (!houses && !entered) continue;
  entered = true;
  const d: Record<string, string> = {};
  for (const key of Object.keys(T)) d[key === "step" ? "rapier" : key] = ((T[key]! - (snap[key] ?? 0)) / 300).toFixed(1);
  console.log(
    JSON.stringify({ t: ((n + 1) / 60).toFixed(0), step: (wall / 300).toFixed(1), parallel: (par / Math.max(steps, 1)).toFixed(1), group: (group / Math.max(steps, 1)).toFixed(1), houses, worlds, bodies, awake, light, ...d }),
  );
  snap = { ...T };
  wall = par = group = steps = 0;
  if (houses && frozen === houses) break;
}
console.log("total s", ((performance.now() - t0) / 1000).toFixed(0));
