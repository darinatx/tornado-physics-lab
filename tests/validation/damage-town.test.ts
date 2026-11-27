import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { DI2_DODS } from "../../src/config/buildings";
import { kmMedian } from "../../src/core/damage/steadyRamp";

/**
 * Spec 03 v2.5 calibration check in the town: the EF2–EF5 presets' full lifecycles through the
 * default town on its own roughness, held-out seed 3 (the scale was fitted on seeds 1–2), run in
 * parallel by `scripts/calibrate-town.ts check` with today's BASE_CAPACITY.
 */
interface HouseOut {
  cls: string;
  first: (number | null)[];
  peak10: number;
}

const PRESETS = ["ef2-cone", "ef3-strong", "ef4-wedge", "ef5-extreme"];

describe("validation — damage calibration in the town (Spec 03)", () => {
  let houses: HouseOut[] = [];
  const median = (cls: string, d: number) =>
    kmMedian(houses.filter((h) => h.cls === cls && h.peak10 > 0).map((h) => (h.first[d] !== null ? { t: h.first[d]!, observed: true } : { t: h.peak10, observed: false })));

  test("DMG-04 / DMG-15 (validation): full town runs on a held-out seed reach each DOD at the DI 2 speed on the 10 m open basis (±5%): standard at the expected value, weak at the lower bound, strong at the upper", () => {
    const dir = mkdtempSync(join(tmpdir(), "dmg-town-"));
    execFileSync("npx", ["tsx", "scripts/calibrate-town.ts", "check", "--seeds", "3", "--out", dir], { stdio: "ignore" });
    houses = PRESETS.flatMap((p) => JSON.parse(readFileSync(join(dir, `check0-${p}-3.json`), "utf8")) as HouseOut[]);
    // DMG-04: standard houses, every DOD, against its expected speed.
    for (const r of DI2_DODS) {
      const m = median("standard", r.dod);
      expect(Math.abs(m / r.expected - 1), `DOD ${r.dod}: ${m.toFixed(1)} vs ${r.expected}`).toBeLessThan(0.05);
    }
    // DMG-15: weak houses at the lower bound, strong houses at the upper bound, every DOD.
    for (const r of DI2_DODS) {
      const w = median("weak", r.dod);
      const st = median("strong", r.dod);
      // DOD 4 has no calibrated part (garage and deck are fixed engineering values): ±8%.
      const tol = r.dod === 4 ? 0.08 : 0.05;
      expect(Math.abs(w / r.lower - 1), `weak DOD ${r.dod}: ${w.toFixed(1)} vs ${r.lower}`).toBeLessThan(tol);
      expect(Math.abs(st / r.upper - 1), `strong DOD ${r.dod}: ${st.toFixed(1)} vs ${r.upper}`).toBeLessThan(tol);
    }
  }, 3_600_000);
});
