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

  test("DMG-04 / DMG-15 (validation): full town runs on a held-out seed reach each DOD at the DI 2 speed on the 10 m open basis (±5%)", () => {
    const dir = mkdtempSync(join(tmpdir(), "dmg-town-"));
    execFileSync("npx", ["tsx", "scripts/calibrate-town.ts", "check", "--seeds", "3", "--out", dir], { stdio: "ignore" });
    houses = PRESETS.flatMap((p) => JSON.parse(readFileSync(join(dir, `check0-${p}-3.json`), "utf8")) as HouseOut[]);
    // DMG-04: standard houses, every DOD, against its expected speed.
    for (const r of DI2_DODS) {
      const m = median("standard", r.dod);
      expect(Math.abs(m / r.expected - 1), `DOD ${r.dod}: ${m.toFixed(1)} vs ${r.expected}`).toBeLessThan(0.05);
    }
    // DMG-15: strong houses swept clean at the upper bound.
    const dod10 = DI2_DODS[9]!;
    const s = median("strong", 10);
    expect(Math.abs(s / dod10.upper - 1), `strong DOD 10: ${s.toFixed(1)} vs ${dod10.upper}`).toBeLessThan(0.05);
  }, 3_600_000);
});
