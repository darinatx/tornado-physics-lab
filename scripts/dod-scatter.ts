/**
 * DOD onset scatter (BL-028 recheck): from `calibrate-town.ts check` output, the Kaplan–Meier
 * distribution of the 10 m open-terrain peak at which each class first reached each DOD, pooled
 * over the runs: quantiles, the lognormal σ they imply (ln speed), and the share of houses
 * reaching the DOD below DI 2's lower bound, below 146 mph and below its upper bound.
 *   npx tsx scripts/calibrate-town.ts check --seeds 1,3,7 --out dir
 *   npx tsx scripts/dod-scatter.ts dir [file-filter]
 */
import { readdirSync, readFileSync } from "node:fs";
import { DI2_DODS } from "../src/config/buildings";
type H = { cls: string; first: (number | null)[]; peak10: number; dod: number };
const dir = process.argv[2]!; const filt = process.argv[3] ?? "";
const files = readdirSync(dir).filter((f) => /^check0-.*-\d+\.json$/.test(f) && f.includes(filt));
const runs: H[][] = files.map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")));
const DI2 = DI2_DODS.map((r) => [r.dod, r.lower, r.expected, r.upper]);
function curve(s: { t: number; observed: boolean }[]) {
  s.sort((a, b) => a.t - b.t || (a.observed === b.observed ? 0 : a.observed ? -1 : 1));
  let atRisk = s.length, surv = 1; const pts: [number, number][] = [];
  let i = 0;
  while (i < s.length) { const t = s[i]!.t; let e = 0, r = 0;
    while (i < s.length && s[i]!.t === t) { if (s[i]!.observed) e++; r++; i++; }
    if (e > 0 && atRisk > 0) { surv *= 1 - e / atRisk; pts.push([t, 1 - surv]); }
    atRisk -= r; }
  return pts; // [speed, F]
}
const q = (c: [number, number][], p: number) => c.find(([, F]) => F >= p)?.[0] ?? NaN;
const F = (c: [number, number][], v: number) => { let f = 0; for (const [t, x] of c) if (t <= v) f = x; return f; };
for (const cls of ["weak", "standard", "strong"]) {
  console.log(`== ${cls} (${files.length} runs ${filt})`);
  for (const [d, lo, ex, hi] of DI2) {
    const s = runs.flat().filter((h) => h.cls === cls && h.peak10 > 0).map((h) => (h.first[d!] != null ? { t: h.first[d!]!, observed: true } : { t: h.peak10, observed: false }));
    const c = curve(s); const n = s.filter((x) => x.observed).length;
    const q05 = q(c, .05), q10 = q(c, .1), q25 = q(c, .25), q50 = q(c, .5), q75 = q(c, .75);
    const sig = Math.log(q50 / q10) / 1.2816, sigU = Math.log(q75 / q50) / 0.6745;
    console.log(`DOD ${String(d).padStart(2)} n=${String(n).padStart(5)} q05 ${q05.toFixed(0)} q10 ${q10.toFixed(0)} q25 ${q25.toFixed(0)} q50 ${q50.toFixed(0)} q75 ${q75.toFixed(0)} | σlow(q10) ${sig.toFixed(3)} σ(q75) ${sigU.toFixed(3)} | F(lo=${lo}) ${(F(c, lo!)*100).toFixed(1)}% F(146) ${(F(c,146)*100).toFixed(1)}% F(hi=${hi}) ${(F(c,hi!)*100).toFixed(1)}% exp ${ex}`);
  }
}
