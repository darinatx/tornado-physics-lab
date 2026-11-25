/**
 * Spec 12 — Wind tunnel: the tunnel drives the real models, launches across zones, pass-through
 * on every run, the parallel runner and its speed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { updateBuilding, allFailures } from "../../src/core/damage/building";
import type { Building } from "../../src/core/damage/types";
import { pressureDeficit } from "../../src/core/wind/pressure";
import { windAt } from "../../src/core/wind/windField";
import { DAMAGE_STEP_INTERVAL } from "../../src/config/buildings";
import { SIM_DEFAULTS } from "../../src/config/sim";
import { initRapier } from "../../src/sim/structureWorld";
import { createTunnel, tunnelState, tunnelFlow } from "../../src/sim/tunnel";
import type { TunnelScenario } from "../../src/sim/tunnel";
import { recordHash, runTunnel } from "../harness/tunnel";
import { SCENARIOS, SHOT_PATHS, windowShot } from "../tunnel/scenarios";

const root = join(import.meta.dirname, "..", "..");
const byName = (n: string) => SCENARIOS.find((s) => s.name === n)!;

beforeAll(async () => {
  await initRapier();
});

describe("Spec 12 wind tunnel: the wind drives the damage", () => {
  test("TUN-03: no wind, no failures, in either model", async () => {
    for (const m of ["component", "detail"]) {
      const r = await runTunnel(byName(`steady/${m}/0mph`));
      expect(r.failures).toEqual([]);
      expect(r.problems).toEqual([]);
    }
  }, 120_000);

  test("TUN-03: a steady 200 mph wind takes the roof off a standard house in either model", async () => {
    for (const m of ["component", "detail"]) {
      const r = await runTunnel(byName(`steady/${m}/200mph`));
      expect(r.problems, m).toEqual([]);
      expect(r.final.dod, m).toBeGreaterThanOrEqual(4);
    }
  }, 300_000);

  test("TUN-03: a component target fails exactly as updateBuilding driven with the same wind, up to its first debris impact", async () => {
    const sc: TunnelScenario = {
      name: "same-as-direct",
      seconds: 8,
      target: { model: "component", cls: "weak" },
      wind: [
        { t: 0, mph: 40, dirDeg: 20 },
        { t: 8, mph: 190, dirDeg: 50, deficit: 600 },
      ],
    };
    const tun = await createTunnel(sc);
    const twin: Building = structuredClone(tun.sim.world.buildings[tun.target]!);
    const r = await runTunnel(sc);
    const firstHit = r.impacts.length ? r.impacts[0]!.t : Infinity;
    const dt = SIM_DEFAULTS.dt * DAMAGE_STEP_INTERVAL;
    const p = { x: twin.x, y: twin.roofHeight, z: twin.z };
    for (let n = DAMAGE_STEP_INTERVAL; n * SIM_DEFAULTS.dt < Math.min(firstHit, sc.seconds); n += DAMAGE_STEP_INTERVAL) {
      const t = n * SIM_DEFAULTS.dt;
      const s = tunnelState(tunnelFlow(sc.wind, t));
      updateBuilding(twin, windAt(p, s, "open"), pressureDeficit(0, s), dt, t);
    }
    const direct = allFailures(twin).map((f) => `${f.part}:${f.index}@${f.time.toFixed(4)}`).sort();
    const tunnel = r.failures.flatMap((f) => (f.model === "component" && f.t < firstHit ? [`${f.part}:${f.index}@${f.t.toFixed(4)}`] : [])).sort();
    expect(direct.length).toBeGreaterThan(0);
    expect(tunnel).toEqual(direct);
    tun.dispose();
  }, 120_000);
});

describe("Spec 12 wind tunnel: detailed launches", () => {
  test("TUN-05: launched members leave the donor as one free body at the launch point and velocity, counting contacts at once", async () => {
    const tun = await createTunnel({
      name: "detail-launch",
      seconds: 1,
      target: { model: "detail", cls: "standard" },
      wind: [{ t: 0, mph: 0, dirDeg: 0 }],
      // Low enough that the pair stays a Rapier body (higher up it goes straight to the light-piece model).
      launches: [{ t: 0.305, source: "detail-same", member: "siding", count: 2, from: { x: -6, y: 1.4, z: 9 }, speed: 12, dir: { x: 0, y: 0, z: -1 } }],
    });
    tun.advance(0.3);
    expect(tun.launched.length).toBe(0);
    tun.advance(1 / 60);
    const l = tun.launched[0]!;
    // Detail steps every 1/60 s: the first at or after 0.305 s is 19/60.
    expect(l.time).toBeCloseTo(19 / 60, 9);
    expect(l.members!.length).toBe(2);
    const body = tun.launchBody(0)!;
    expect(body.members).toEqual(l.members);
    // Its first step has run: one step of flight from the launch point.
    expect(Math.hypot(body.center.x + 6, body.center.y - 1.4, body.center.z - 9 + 12 / 60)).toBeLessThan(0.05);
    expect(body.vel.z).toBeCloseTo(-12, 0);
    expect(Math.abs(body.vel.x)).toBeLessThan(0.1);
    // Never attached: no separation grace.
    expect(body.bornAt).toBeLessThanOrEqual(l.time - 0.5);
    tun.dispose();
  }, 60_000);
});

describe("Spec 12 wind tunnel: all five paths", () => {
  for (const p of SHOT_PATHS)
    test(`TUN-06: a piece fired at a window breaks it: ${p.id}`, async () => {
      const r = await runTunnel(windowShot(p));
      expect(r.problems).toEqual([]);
      expect(r.final.panes[0]).toBe(true);
    }, 60_000);
});

describe("Spec 12 wind tunnel: pass-through on every run", () => {
  test("TUN-07: every library scenario runs the checker at every debris step, and a crossing fails the scenario", async () => {
    // A piece moved through a standing wall between steps (a deliberate bug) must be caught.
    const sc: TunnelScenario = {
      name: "planted-crossing",
      seconds: 1,
      target: { model: "component", cls: "standard" },
      wind: [{ t: 0, mph: 0, dirDeg: 0 }],
      launches: [{ t: 0.1, source: "town", kind: "stud", from: { x: -12, y: 1.5, z: 0 }, speed: 5, dir: { x: 1, y: 0, z: 0 } }],
    };
    const clean = await runTunnel(sc);
    expect(clean.passThrough.total).toBe(0);
    expect(clean.checks.debrisSteps).toBe(60);
    expect(clean.checks.rubbleChecks).toBe(1);
    const bad = await runTunnel(sc, {
      onStep: (tun) => {
        const p = tun.sim.debris.pieces[0];
        // Teleport it from just outside the −X wall to the house's center.
        if (p && Math.abs(tun.sim.time - 0.5) < 1e-6) p.pos = { x: 0, y: 1.5, z: 0 };
      },
    });
    expect(bad.passThrough.total).toBeGreaterThan(0);
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(" ")).toMatch(/pass-through/);
  }, 60_000);
});

describe("Spec 12 wind tunnel: runner", () => {
  const run = (args: string[]) => spawnSync("npx", ["tsx", "scripts/tunnel.ts", ...args], { cwd: root, encoding: "utf8", timeout: 300_000 });

  test("TUN-09: runs scenarios on several workers, reports each, and exits non-zero on a failing check", () => {
    const ok = run(["--workers", "2", "--json", "window-shot/town", "wall-shot/component"]);
    expect(ok.status, ok.stderr).toBe(0);
    const rows = JSON.parse(ok.stdout.slice(ok.stdout.indexOf("[")));
    expect(rows.length).toBe(4);
    expect(new Set(rows.map((r: { worker: number }) => r.worker)).size).toBe(2);
    for (const r of rows) {
      expect(r.ok).toBe(true);
      expect(r.simS).toBeGreaterThan(0);
      expect(r.wallS).toBeGreaterThan(0);
      expect(r.speed).toBeCloseTo(r.simS / r.wallS, 6);
    }
    const bad = run(["--workers", "2", "selftest/fails", "window-shot/town-component"]);
    expect(bad.status).not.toBe(0);
    expect(bad.stdout + bad.stderr).toMatch(/fails by design/);
  }, 300_000);

  test("TUN-08: a scenario's record is the same alone and in the parallel runner", async () => {
    const names = ["window-shot/other-detail", "swing/component/120mph"];
    const out = execFileSync("npx", ["tsx", "scripts/tunnel.ts", "--workers", "2", "--json", ...names], { cwd: root, encoding: "utf8", timeout: 300_000 });
    const rows: { name: string; hash: string }[] = JSON.parse(out.slice(out.indexOf("[")));
    for (const n of names) {
      const alone = await runTunnel(byName(n));
      expect(rows.find((r) => r.name === n)!.hash).toBe(recordHash(alone));
    }
  }, 300_000);
});

describe("Spec 12 wind tunnel: speed", () => {
  test("TUN-10: 10 s runs at ≥ 10× real time with a component target and ≥ 1× with a detailed one", async () => {
    const shot = (model: "component" | "detail"): TunnelScenario => ({
      name: `speed/${model}`,
      seconds: 10,
      target: { model, cls: "standard" },
      wind: [{ t: 0, mph: 90, dirDeg: 0 }],
      launches: [
        { t: 1, source: "town", kind: "stud", aim: { pane: 0 }, standoff: 6, speed: 30 },
        { t: 2, source: model === "detail" ? "detail-same" : "town", ...(model === "detail" ? { member: "siding" } : { kind: "osb" }), aim: { wall: 1 }, standoff: 6, speed: 25 } as never,
      ],
    });
    const c = await runTunnel(shot("component"));
    const d = await runTunnel(shot("detail"));
    expect(c.problems).toEqual([]);
    expect(d.problems).toEqual([]);
    expect(c.perf.speed).toBeGreaterThanOrEqual(10);
    expect(d.perf.speed).toBeGreaterThanOrEqual(1);
  }, 300_000);
});
