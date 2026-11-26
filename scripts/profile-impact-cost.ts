/**
 * Phase 6 slice C validation (BL-002): frame cost of impact checks in the default EF4 town pass
 * with a detail spot picked (the STR-30 case, 30 detailed houses at -650,1130), in-process.
 * Two runs: impacts on (as shipped) and town-debris hit tests off (`world.near` returns no
 * houses, as scripts/profile-impacts.ts does). In each, over 30 s of sim time from the first
 * detail-zone connection failure (STR-30's window), it reports per frame (1/60 s, one detail
 * step): the whole frame's wall time, the detail step's costliest physics group, and the time
 * inside the detail zone's impact checks (light-piece sweeps against fixed shapes, overlap and
 * push-out, stand-in hit records). Turning town hit tests off also changes what happens (fewer
 * windows broken, fewer pieces stopped at houses), so "off" is not the same storm minus the checks.
 *   npx tsx scripts/profile-impact-cost.ts [on|off|both=both] [preset id|default=ef4-wedge]
 * Records only: patches prototypes for timing; changes no model code.
 */
import { PRESETS } from "../src/config/presets";
import { SIM_DEFAULTS } from "../src/config/sim";
import { DETAIL } from "../src/config/structure";
import { createLocalBackend } from "../src/sim/detailBackend";
import { createSim } from "../src/sim/loop";
import { initRapier, StructureWorld, DetailHouse } from "../src/sim/structureWorld";
import { defaultParams } from "../src/sim/types";

await initRapier();
let impactMs = 0;
// One depth for all wrappers: a check called from inside another is counted once.
let depth = 0;
const wrap = (proto: object, name: string) => {
  const p = proto as Record<string, (...a: unknown[]) => unknown>;
  const f = p[name];
  if (!f) throw new Error(`no ${name}`);
  p[name] = function (this: unknown, ...a: unknown[]) {
    if (depth) return f.apply(this, a);
    depth++;
    const t = performance.now();
    try {
      return f.apply(this, a);
    } finally {
      impactMs += performance.now() - t;
      depth--;
    }
  };
};
// Detail-zone impact checks (Spec 10 slice B): what the light pieces do near houses and the
// stand-ins' hit records. Nested calls are counted once.
for (const n of ["keepLightBodiesClear", "castLight", "overlappingFixed", "overlapsFixed", "recordTownHit", "outward"]) wrap(StructureWorld.prototype, n);
for (const n of ["blockLight", "keepClear", "bounceLight", "hitGlass"]) wrap(DetailHouse.prototype, n);

const modes = (process.argv[2] ?? "both") === "both" ? ["on", "off"] : [process.argv[2]!];
const presetId = process.argv[3] ?? "ef4-wedge";
const params = presetId === "default" ? {} : PRESETS.find((p) => p.id === presetId)!.params;
{
  const d = { ...defaultParams(), ...params };
  console.log(`default tornado: vPeak ${d.vPeak} m/s, rMax ${d.rMax} m, translation ${d.translationSpeed} m/s`);
}
for (const mode of modes) {
  const groupMs: number[] = [];
  const stepMs: number[] = [];
  const impMs: number[] = [];
  let firstFail = -1;
  const sim = createSim({}, 1, params, (_s, b) => {
    const be = createLocalBackend(b, 1);
    const drain = be.drain.bind(be);
    be.drain = () => {
      const rs = drain();
      for (const r of rs) {
        if (firstFail < 0 && r.failures.length) firstFail = groupMs.length;
        groupMs.push(r.groupMs);
      }
      return rs;
    };
    return be;
  });
  if (mode === "off") (sim.world as unknown as { near: unknown }).near = () => [];
  sim.setDetailFocus({ x: -650, z: 1130 });
  const perStep = DETAIL.stepEvery * SIM_DEFAULTS.dt;
  const wantDetail = Math.round(30 / perStep);
  const t0 = performance.now();
  let impacts0 = 0;
  for (let n = 0; n < 60 * 300; n++) {
    impactMs = 0;
    const a = performance.now();
    sim.advance(1 / 60);
    const ms = performance.now() - a;
    if (firstFail >= 0) {
      if (!stepMs.length) impacts0 = sim.debris.stats.impacts;
      stepMs.push(ms);
      impMs.push(impactMs);
      if (groupMs.length >= firstFail + wantDetail) break;
    }
  }
  const core = groupMs.slice(firstFail, firstFail + wantDetail);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  const pct = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * q)] ?? NaN;
  const out = {
    mode,
    presetId,
    simSteps: stepMs.length,
    stepMean: +mean(stepMs).toFixed(2),
    stepP95: +pct(stepMs, 0.95).toFixed(1),
    stepMax: +Math.max(...stepMs).toFixed(0),
    groupMean: +mean(core).toFixed(2),
    groupMax: +Math.max(...core).toFixed(0),
    detailImpactChecksMean: +mean(impMs).toFixed(2),
    townImpacts: sim.debris.stats.impacts - impacts0,
    wallS: +((performance.now() - t0) / 1000).toFixed(0),
  };
  console.log("JSON " + JSON.stringify(out));
  sim.dispose();
}
