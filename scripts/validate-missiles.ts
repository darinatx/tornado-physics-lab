/**
 * Phase 6 slice C validation (BL-006): the reference missiles (ASTM E1996 A–E, ICC 500) fired
 * with the lab's launcher at every pane, every solid wall panel and a grid of roof points of one
 * lab house in calm air, over several seeds, for the detailed and the component model. Prints
 * break / perforation rates per missile and target, the measured normal speed, pass-through
 * crossings and member failures (detailed), as a table and one JSON line.
 *   npx tsx scripts/validate-missiles.ts [seeds=8] [cls=standard] [models=detail,component]
 * Records only: changes no model code.
 */
import { REFERENCE_MISSILES } from "../src/config/lab";
import { IMPACT } from "../src/config/impacts";
import { createLab } from "../src/sim/lab";
import type { LabWind } from "../src/sim/lab";
import { initRapier } from "../src/sim/structureWorld";

await initRapier();
const seeds = Number(process.argv[2] ?? 8);
const cls = (process.argv[3] ?? "standard") as "weak" | "standard" | "strong";
const models = (process.argv[4] ?? "detail,component").split(",") as ("detail" | "component")[];
const calm: LabWind = { kind: "steady", keys: [{ t: 0, mph: 0, dirDeg: 0 }] };
const GAP = 1.5; // s between shots: longer than any flight from the 10 m stand-off

type Target = "pane" | "wall" | "roof";
interface Row { model: string; missile: string; target: Target; shots: number; hits: number; broke: number; perf: number; vn: number[]; measure: number[]; threshold: number[]; passThrough: number; memberFails: number; restingContacts?: number; failLabels: Record<string, number>; other: Record<string, number> }
const rows = new Map<string, Row>();
const row = (model: string, missile: string, target: Target): Row => {
  const k = `${model}|${missile}|${target}`;
  if (!rows.has(k)) rows.set(k, { model, missile, target, shots: 0, hits: 0, broke: 0, perf: 0, vn: [], measure: [], threshold: [], passThrough: 0, memberFails: 0, failLabels: {}, other: {} });
  return rows.get(k)!;
};

const t0 = Date.now();
for (const model of models) {
  for (const m of REFERENCE_MISSILES) {
    const targets: Target[] = m.vertical ? ["roof"] : ["pane", "wall", "roof"];
    for (const target of targets) {
      const r = row(model, m.id, target);
      for (let seed = 1; seed <= seeds; seed++) {
        const lab = await createLab({ houses: 1, cls, surroundings: "open", seed, donors: false, model, dispersion: false }, calm, { passThrough: true });
        const b = lab.sim.world.buildings[0]!;
        const aims: Parameters<typeof lab.fireMissile>[2][] = [];
        if (target === "pane") b.panes.forEach((_p, i) => aims.push({ pane: i }));
        else if (target === "wall") b.panels.forEach((p, i) => { if (!p.isGarage) aims.push({ wall: i }); });
        else {
          // Mid-slope of both slopes, at quarter points along the width.
          for (const slope of [-1, 1]) for (const f of [-0.3, -0.1, 0.1, 0.3]) aims.push({ point: { x: f * b.width, y: IMPACT.slabTop + b.wallHeight + b.roofRise * 0.5, z: slope * b.depth * 0.25 } });
        }
        lab.advance(0.1);
        aims.forEach((a, k) => lab.fireMissile(m.id, 0, a, { t: lab.sim.time + 0.05 + k * GAP }));
        lab.advance(0.3 + aims.length * GAP + 1);
        const rec = lab.record();
        const launches = rec.launches.length;
        r.shots += launches;
        // Each shot's own arrival: its first impact within 1.2 s of launch at ≥ 30% of the
        // missile's speed (an earlier missile resting on the roof logs a slow contact every
        // debris step, which isn't this shot).
        const first = new Map<number, (typeof rec.impacts)[number]>();
        rec.launches.forEach((l, j) => {
          const i = rec.impacts.find((x) => x.t > l.t && x.t <= l.t + 1.2 && x.vn >= 0.3 * m.speed);
          if (i) first.set(j, i);
        });
        r.restingContacts = (r.restingContacts ?? 0) + rec.impacts.filter((x) => x.vn < 1).length;
        for (const i of first.values()) {
          const want = target === "pane" ? "pane" : target === "roof" ? "roof" : "wall";
          if (i.surface !== want) { r.other[i.surface] = (r.other[i.surface] ?? 0) + 1; continue; }
          r.hits++;
          if (i.broke) r.broke++;
          if (i.perforated) r.perf++;
          r.vn.push(i.vn);
          r.measure.push(i.measure);
          r.threshold.push(i.threshold);
        }
        r.passThrough += rec.passThrough.total;
        r.memberFails += rec.failures.length;
        for (const f of rec.failures) {
          const l = f.model === "detail" ? f.label.replace(/[ #]?\d+/g, "") : `${f.part}${f.cause ? ` (${f.cause})` : ""}`;
          r.failLabels[l] = (r.failLabels[l] ?? 0) + 1;
        }
        lab.dispose();
      }
      const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
      const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]! : NaN);
      console.log(`${model.padEnd(9)} ${m.id.padEnd(9)} ${target.padEnd(4)} shots ${String(r.shots).padStart(3)} hits ${String(r.hits).padStart(3)} broke ${(r.broke / Math.max(1, r.hits) * 100).toFixed(0).padStart(3)}% perf ${(r.perf / Math.max(1, r.hits) * 100).toFixed(0).padStart(3)}% vn ${mean(r.vn).toFixed(1)} measure ${med(r.measure).toPrecision(3)} thr(med) ${med(r.threshold).toPrecision(3)} passThrough ${r.passThrough} failures ${r.memberFails} other ${JSON.stringify(r.other)} fails ${JSON.stringify(r.failLabels)} slowContacts ${r.restingContacts ?? 0}  [${((Date.now() - t0) / 1000).toFixed(0)} s]`);
    }
  }
}
console.log("JSON " + JSON.stringify([...rows.values()].map(({ vn, measure, threshold, ...r }) => ({ ...r, vnMean: vn.reduce((s, x) => s + x, 0) / Math.max(1, vn.length), measureMed: [...measure].sort((a, b) => a - b)[Math.floor(measure.length / 2)] ?? null, thresholdMed: [...threshold].sort((a, b) => a - b)[Math.floor(threshold.length / 2)] ?? null }))));
