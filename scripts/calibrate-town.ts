/**
 * In-town calibration of BASE_CAPACITY (Spec 03 v2.5, BL-029). Full preset storms through the
 * default town on its own roughness ("auto"), debris and rubble included: for each DOD, the
 * Kaplan–Meier median 10 m open-terrain peak at a standard house when it first reached that DOD
 * (the storm recorder's `peak10` at that moment) should equal DI 2's expected speed, and weak
 * and strong houses' should equal its lower and upper bounds (the class factors, v2.6). Each round
 * runs every preset × seed in parallel, then rescales each calibrated part by
 * (target / median)², damped and clamped. The parts' relative strengths start from the
 * isolated-pass calibration (`scripts/calibrate-houses.ts`).
 *
 *   npx tsx scripts/calibrate-town.ts driver [--rounds 3] [--seeds 1,2] [--out dir] [--caps start.json]
 *   npx tsx scripts/calibrate-town.ts check --seeds 3,7 [--caps caps.json]   (one pass, no update)
 *   npx tsx scripts/calibrate-town.ts run <preset> <seed> <caps.json> <out.json>   (one storm)
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_CAPACITY, CLASS_FACTORS, DI2_DODS, PARTS, PART_CALIBRATION_DOD } from "../src/config/buildings";
import type { Part } from "../src/config/buildings";

/** What a round calibrates: the standard house's capacities (Pa) and the weak and strong class
 *  factors (–). A caps file holding only capacities (v2.5's format) leaves the factors as they are. */
interface Calib {
  base: Record<Part, number>;
  weak: Partial<Record<Part, number>>;
  strong: Partial<Record<Part, number>>;
}
const readCalib = (file: string): Calib => {
  const j = JSON.parse(readFileSync(file, "utf8")) as Calib | Record<Part, number>;
  return "base" in j ? (j as Calib) : { base: j as Record<Part, number>, weak: { ...CLASS_FACTORS.weak }, strong: { ...CLASS_FACTORS.strong } };
};
const applyCalib = (c: Calib) => {
  Object.assign(BASE_CAPACITY, c.base);
  for (const cls of ["weak", "strong"] as const) {
    const f = CLASS_FACTORS[cls] as Partial<Record<Part, number>>;
    for (const k of Object.keys(f) as Part[]) delete f[k];
    Object.assign(f, c[cls]);
  }
};
import { PRESETS } from "../src/config/presets";
import { MS_PER_MPH } from "../src/config/units";
import { kmMedian } from "../src/core/damage/steadyRamp";

const PRESET_IDS = ["ef2-cone", "ef3-strong", "ef4-wedge", "ef5-extreme"];
const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

interface HouseOut {
  cls: string;
  /** 10 m open peak (mph) when the house first reached DOD d, index d (null if never). */
  first: (number | null)[];
  peak10: number;
  dod: number;
}

async function runOne(preset: string, seed: number, capsFile: string, outFile: string): Promise<void> {
  // Capacities for this run: createHouse reads BASE_CAPACITY when the town is built.
  applyCalib(readCalib(capsFile));
  // Diagnostic: hold the roughness field at the intact town's (no updates as houses fall).
  if (process.env.FREEZE_ROUGHNESS) {
    const { TERRAIN } = await import("../src/config/terrain");
    (TERRAIN as { updateInterval: number }).updateInterval = 1e9;
  }
  const { createSim } = await import("../src/sim/loop");
  const { StormRecorder } = await import("../src/sim/stormRecord");
  const { initRapier } = await import("../src/sim/structureWorld");
  await initRapier();
  const pr = PRESETS.find((p) => p.id === preset)!;
  const sim = createSim({}, seed, pr.params);
  const rec = new StormRecorder(sim);
  const peak10 = (rec as unknown as { peak10: Float64Array }).peak10;
  const B = sim.world.buildings;
  const first: (number | null)[][] = B.map(() => new Array<number | null>(11).fill(null));
  const lastDod = B.map(() => 0);
  let lastVersion = -1;
  const life = sim.snapshot.lifetime;
  while (sim.time < life + 3) {
    sim.advance(sim.dt);
    const v = sim.snapshot.damageVersion;
    if (v === lastVersion) continue;
    lastVersion = v;
    for (let i = 0; i < B.length; i++) {
      const d = B[i]!.dod;
      if (d <= lastDod[i]!) continue;
      for (let k = lastDod[i]! + 1; k <= d; k++) first[i]![k] = peak10[i]! / MS_PER_MPH;
      lastDod[i] = d;
    }
    if (sim.snapshot.phase === "dissipated" && sim.time > life + 3) break;
  }
  const out: HouseOut[] = B.map((b, i) => ({ cls: b.cls, first: first[i]!, peak10: peak10[i]! / MS_PER_MPH, dod: b.dod }));
  writeFileSync(outFile, JSON.stringify(out));
  // The storm report's survey of the same run (the rating against the true peak).
  const { buildSurvey } = await import("../src/sim/report/survey");
  const { efRating } = await import("../src/core/wind/efScale");
  const sv = buildSurvey(rec.record());
  const truePeak = Math.max(0, ...rec.record().track.map((t) => t.peak)) / MS_PER_MPH;
  const bias = sv.points.map((q) => q.biasMph);
  const summary = {
    preset,
    seed,
    rating: sv.rating,
    ratingMph: sv.ratingMph,
    truePeakMph: +truePeak.toFixed(1),
    truePeakEf: efRating(truePeak * MS_PER_MPH),
    biasMean: +(bias.reduce((a, x) => a + x, 0) / Math.max(1, bias.length)).toFixed(1),
    points: bias.length,
    damaged: B.filter((b) => b.dod >= 1).length,
    destroyed: B.filter((b) => b.dod >= 8).length,
  };
  writeFileSync(outFile.replace(/\.json$/, ".summary.json"), JSON.stringify(summary));
}

function runAll(seeds: number[], capsFile: string, dir: string, tag: string): Promise<HouseOut[][]> {
  const jobs = PRESET_IDS.flatMap((p) => seeds.map((s) => ({ p, s, out: join(dir, `${tag}-${p}-${s}.json`) })));
  return Promise.all(
    jobs.map(
      (j) =>
        new Promise<HouseOut[]>((resolve, reject) => {
          const c = spawn("npx", ["tsx", "scripts/calibrate-town.ts", "run", j.p, String(j.s), capsFile, j.out], { stdio: ["ignore", "ignore", "inherit"] });
          c.on("exit", (code) => (code === 0 ? resolve(JSON.parse(readFileSync(j.out, "utf8")) as HouseOut[]) : reject(new Error(`${j.p} seed ${j.s}: exit ${code}`))));
        }),
    ),
  );
}

/** KM medians per DOD over houses of one class (censored at their 10 m peak). */
function medians(runs: HouseOut[][], cls: string): number[] {
  const m: number[] = [0];
  for (let d = 1; d <= 10; d++) {
    const s = runs.flat().filter((h) => h.cls === cls && h.peak10 > 0).map((h) => (h.first[d] !== null ? { t: h.first[d]!, observed: true } : { t: h.peak10, observed: false }));
    m.push(kmMedian(s));
  }
  return m;
}

function report(runs: HouseOut[][], label: string): { standard: number[]; weak: number[]; strong: number[] } {
  const m = { standard: medians(runs, "standard"), weak: medians(runs, "weak"), strong: medians(runs, "strong") };
  const pct = (got: number, t: number) => `${((got / t - 1) * 100).toFixed(1)}%`.padStart(6);
  console.log(`${label}: KM median 10 m open peak at first reach (mph) — weak vs lower, standard vs expected, strong vs upper:`);
  for (const r of DI2_DODS)
    console.log(
      `  DOD ${String(r.dod).padStart(2)}: weak ${m.weak[r.dod]!.toFixed(1).padStart(6)} (${pct(m.weak[r.dod]!, r.lower)})  ` +
        `standard ${m.standard[r.dod]!.toFixed(1).padStart(6)} (${pct(m.standard[r.dod]!, r.expected)})  ` +
        `strong ${m.strong[r.dod]!.toFixed(1).padStart(6)} (${pct(m.strong[r.dod]!, r.upper)})`,
    );
  return m;
}

const mode = args[0];
if (mode === "run") {
  await runOne(args[1]!, Number(args[2]), args[3]!, args[4]!);
} else {
  const seeds = (opt("--seeds") ?? (mode === "check" ? "3,7" : "1,2")).split(",").map(Number);
  const dir = opt("--out") ?? "calibrate-town-out";
  mkdirSync(dir, { recursive: true });
  let calib: Calib = opt("--caps") ? readCalib(opt("--caps")!) : { base: { ...BASE_CAPACITY }, weak: { ...CLASS_FACTORS.weak }, strong: { ...CLASS_FACTORS.strong } };
  const rounds = mode === "check" ? 1 : Number(opt("--rounds") ?? 3);
  for (let round = 0; round < rounds; round++) {
    const capsFile = join(dir, `caps-${mode}-${round}.json`);
    writeFileSync(capsFile, JSON.stringify(calib));
    const t0 = performance.now();
    const runs = await runAll(seeds, capsFile, dir, `${mode}${round}`);
    const m = report(runs, `${mode} round ${round} (seeds ${seeds.join(",")}, ${((performance.now() - t0) / 1000).toFixed(0)} s)`);
    for (const p of PRESET_IDS) for (const s of seeds) console.log("  " + readFileSync(join(dir, `${mode}${round}-${p}-${s}.summary.json`), "utf8"));
    if (mode === "check") break;
    // Pressure ∝ speed²; damped (0.8) and clamped per round, since debris also reaches some DODs.
    const step = (target: number, got: number) => (Number.isFinite(got) ? Math.min(1.35, Math.max(0.75, Math.pow(target / got, 2 * 0.8))) : 0.8);
    const next: Calib = { base: { ...calib.base }, weak: { ...calib.weak }, strong: { ...calib.strong } };
    for (const p of PARTS) {
      const d = PART_CALIBRATION_DOD[p];
      if (!d) continue;
      const r = DI2_DODS[d - 1]!;
      next.base[p] = Math.round(calib.base[p] * step(r.expected, m.standard[d]!));
      // Class factors: weak houses to the lower bound, strong to the upper (Spec 03 v2.6).
      next.weak[p] = +((calib.weak[p] ?? 1) * step(r.lower, m.weak[d]!)).toFixed(3);
      next.strong[p] = +((calib.strong[p] ?? 1) * step(r.upper, m.strong[d]!)).toFixed(3);
    }
    calib = next;
    console.log(`after round ${round}:`, JSON.stringify(calib));
  }
  writeFileSync(join(dir, `caps-${mode}-final.json`), JSON.stringify(calib));
}
