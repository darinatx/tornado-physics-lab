import { beforeAll, describe, expect, test } from "vitest";
import { DETAIL } from "../../src/config/structure";
import { SIM_DEFAULTS } from "../../src/config/sim";
import { createDeferredBackend, createLocalBackend } from "../../src/sim/detailBackend";
import { createSim } from "../../src/sim/loop";
import { createRng } from "../../src/sim/rng";
import { initRapier } from "../../src/sim/structureWorld";

/** A short-lived tornado that starts inside the town (the path is centered on the origin). */
const QUICK = { tUp: 5, tMature: 40, tRope: 5, translationSpeed: 20 };
const dt = SIM_DEFAULTS.dt;

beforeAll(async () => {
  await initRapier();
});

describe("Spec 09 slice B — detail zone in the sim", () => {
  test("STR-14: the component model leaves detailed houses alone (no failures or debris after entry)", () => {
    const sim = createSim({}, 3, QUICK, (_s, b) => createLocalBackend(b));
    const entered = new Map<number, number>();
    for (let t = 0; t < 8; t += 1 / 30) {
      sim.advance(1 / 30);
      for (const i of sim.detail.houses.keys()) if (!entered.has(i)) entered.set(i, sim.time);
    }
    expect(entered.size).toBeGreaterThan(20);
    for (const [i, t0] of entered) {
      const b = sim.world.buildings[i]!;
      const after = [...b.panels.map((p) => p.failed), ...b.panes.map((p) => p.failed), ...b.siding.map((s) => s.failed), ...b.sections.flatMap((s) => [s.cover, s.deck]), ...b.bays.map((s) => s.failed)]
        .filter((f) => f && f.time > t0 + 1e-9);
      expect(after.length, `house ${i}`).toBe(0);
    }
  }, 600000);

  test("STR-18: never more than 0.25 s ahead of the detail physics; frame timing doesn't change results", () => {
    const maxLead = Math.round(DETAIL.maxLeadS / (dt * DETAIL.stepEvery));
    const a = createSim({}, 3, QUICK, (_s, b) => createLocalBackend(b));
    for (let k = 0; k < 6 * 60; k++) a.advance(1 / 60);
    let deferred: ReturnType<typeof createDeferredBackend> | null = null;
    const b = createSim({}, 3, QUICK, (_s, bs) => (deferred = createDeferredBackend(bs)));
    const rng = createRng(9);
    let lagged = false;
    while (b.time < a.time - 1e-9) {
      // Uneven frames and a worker that keeps up only sometimes.
      b.advance(Math.min(0.05 * rng(), a.time - b.time));
      expect(deferred!.pending).toBeLessThanOrEqual(maxLead);
      if (b.detailLagging) lagged = true;
      deferred!.run(Math.floor(rng() * 4));
    }
    deferred!.run(1e9);
    b.advance(0); // apply the last results
    expect(lagged).toBe(true); // the limit was exercised
    expect(b.time).toBeCloseTo(a.time, 9);
    expect([...b.detail.houses.keys()]).toEqual([...a.detail.houses.keys()]);
    for (const [i, h] of a.detail.houses) expect(b.detail.houses.get(i)!.poses).toEqual(h.poses);
    expect(b.world.buildings.map((x) => x.dod)).toEqual(a.world.buildings.map((x) => x.dod));
  }, 600000);
});

describe("Spec 09 slice C — detailed houses vs DI 2", () => {
  test("STR-24: detailed standard houses in tornado passes reach each DOD within ±10% of DI 2", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { DI2_DODS } = await import("../../src/config/buildings");
    // 64 houses (seed 400, an independent sample), run in 8 parallel processes. Async, so the
    // test worker stays responsive to Vitest while it runs.
    const { stdout: out } = await promisify(execFile)("npx", ["tsx", "scripts/validate-detail.ts", "64", "400", "8"], {
      env: { ...process.env, VALIDATE_JSON: "1" },
      encoding: "utf8",
      maxBuffer: 1 << 24,
    });
    const line = out.split("\n").find((l) => l.startsWith("JSON "))!;
    const { medians } = JSON.parse(line.slice(5)) as { medians: number[] };
    for (const r of DI2_DODS) {
      const m = medians[r.dod - 1]!;
      expect(Math.abs(m / r.expected - 1), `DOD ${r.dod}: ${m.toFixed(0)} vs ${r.expected} mph`).toBeLessThanOrEqual(0.1);
    }
  }, 900000);
});
