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
    sim.setDetailFocus({ x: 0, z: 0 });
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
    a.setDetailFocus({ x: 0, z: 0 });
    for (let k = 0; k < 6 * 60; k++) a.advance(1 / 60);
    let deferred: ReturnType<typeof createDeferredBackend> | null = null;
    const b = createSim({}, 3, QUICK, (_s, bs) => (deferred = createDeferredBackend(bs)));
    b.setDetailFocus({ x: 0, z: 0 });
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

describe("Spec 09 — detail zone performance in the sim", () => {
  test("STR-29: each street row is its own physics group; 1 or 3 engines give identical results", async () => {
    const { streetRowOf } = await import("../../src/sim/city");
    const run = (k: number) => {
      let be: ReturnType<typeof createLocalBackend> | null = null;
      const sim = createSim({}, 3, QUICK, (_s, b) => (be = createLocalBackend(b, k)));
      sim.setDetailFocus({ x: 0, z: 0 });
      for (let n = 0; n < 8 * 60; n++) sim.advance(1 / 60);
      return { sim, be: be! };
    };
    const a = run(1);
    const b = run(3);
    // One world per street row, whichever engine hosts it.
    const rows = new Set([...a.sim.detail.houses.keys()].map((i) => streetRowOf(a.sim.world.buildings[i]!)));
    expect(rows.size).toBeGreaterThan(1);
    expect(a.be.engines[0]!.worlds.size + 0).toBeLessThanOrEqual(rows.size);
    expect(b.be.engines.filter((e) => e.houses.size > 0).length).toBeGreaterThan(1);
    for (const e of b.be.engines) for (const [key, sw] of e.worlds) for (const h of sw.houses) expect(streetRowOf(h.building)).toBe(key);
    // Identical results.
    expect([...b.sim.detail.houses.keys()].sort()).toEqual([...a.sim.detail.houses.keys()].sort());
    for (const [i, h] of a.sim.detail.houses) expect(b.sim.detail.houses.get(i)!.poses).toEqual(h.poses);
    expect(b.sim.world.buildings.map((x) => x.dod)).toEqual(a.sim.world.buildings.map((x) => x.dod));
    const moved = [...a.sim.detail.houses.values()].some((h) => h.poses.some((v, j) => j % 7 === 1 && v < -1000)) || a.sim.world.buildings.some((x) => x.detail && x.dod > 0);
    expect(moved).toBe(true);
  }, 600000);
});

describe("Spec 09 — detail zone cost", () => {
  test("STR-30: over a 30-house core passage the costliest physics group averages under 16 ms per detail step", () => {
    // The default tornado through 30 houses around a spot on its path (the profile case:
    // scripts/profile-detail.ts). Averaged from the first connection failure over 30 s.
    const groupMs: number[] = [];
    let firstFail = -1;
    const sim = createSim({}, 1, {}, (_s, b) => {
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
    sim.setDetailFocus({ x: -650, z: 1130 });
    const perStep = DETAIL.stepEvery * dt;
    for (let n = 0; n < 60 * 300 && (firstFail < 0 || groupMs.length < firstFail + 30 / perStep); n++) sim.advance(1 / 60);
    expect(firstFail).toBeGreaterThanOrEqual(0);
    const core = groupMs.slice(firstFail, firstFail + Math.round(30 / perStep));
    const mean = core.reduce((a, b) => a + b, 0) / core.length;
    console.log(`STR-30: costliest group ${mean.toFixed(1)} ms per detail step (max ${Math.max(...core).toFixed(0)})`);
    expect(mean).toBeLessThan(16);
  }, 900000);
});

describe("Spec 09 slice C — detailed houses vs DI 2", () => {
  test("STR-24: detailed standard houses in tornado passes reach each DOD within ±10% of DI 2", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { DI2_DODS } = await import("../../src/config/buildings");
    // 128 houses (seed 400, an independent sample; with 64 the KM median of a DOD moves by
    // ~±5% when the chaotic tumbling re-rolls), run in 8 parallel processes. Async, so the test
    // worker stays responsive to Vitest while it runs.
    const { stdout: out } = await promisify(execFile)("npx", ["tsx", "scripts/validate-detail.ts", "128", "400", "8"], {
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
