import { describe, expect, test } from "vitest";
import { advanceUntil } from "../helpers";
import { PRESETS } from "../../src/config/presets";
import { createSim } from "../../src/sim/loop";
import { median } from "../houseHelpers";

describe("validation — debris field", () => {
  test("DEB-12 / DEB-16 (validation): debris field spread and mass bookkeeping after an EF4", async () => {
    const ef4 = PRESETS.find((p) => p.id === "ef4-wedge")!;
    const sim = createSim({}, 1, ef4.params);
    const v0 = sim.snapshot.tornado.velocity;
    const sp = Math.hypot(v0.x, v0.z);
    const right = { x: -v0.z / sp, z: v0.x / sp };
    const lat = (x: number, z: number) => x * right.x + z * right.z;
    await advanceUntil(sim, () => sim.snapshot.phase === "dissipated" && sim.snapshot.debris.airborne <= 50);
    sim.advance(0.25);
    const ground = [...sim.debris.settled, ...sim.debris.pieces.filter((p) => p.resting)];
    const iqr = (a: number[]) => {
      const s = [...a].sort((x, y) => x - y);
      return s[Math.floor(s.length * 0.75)]! - s[Math.floor(s.length * 0.25)]!;
    };
    const landed = ground.map((p) => lat(p.pos.x, p.pos.z));
    const sources = ground.map((p) => lat(sim.world.buildings[p.sourceId]!.x, sim.world.buildings[p.sourceId]!.z));
    expect(iqr(landed)).toBeGreaterThan(0.6 * iqr(sources));
    const travel = (kinds: string[]) =>
      median(ground.filter((p) => kinds.includes(p.kind)).map((p) => {
        const b = sim.world.buildings[p.sourceId]!;
        return Math.hypot(p.pos.x - b.x, p.pos.z - b.z);
      }));
    const heavy = travel(["wallPanel", "stud", "rafter", "chunk"]);
    const sheets = travel(["shingle", "siding"]);
    expect(heavy).toBeLessThan(150);
    expect(sheets).toBeGreaterThan(heavy);

    // DEB-16: mass bookkeeping balances, and destroyed houses keep much of their mass nearby.
    const d = sim.debris;
    const onMap = [...d.settled.filter((p) => !p.hidden), ...d.pieces].reduce((a, p) => a + p.def.mass * p.represents, 0);
    const ledger = onMap + d.massLofted + d.massSkipped + d.massSwept + d.massLeftMap;
    expect(Math.abs(ledger / d.massSpawned - 1)).toBeLessThan(0.01);
    const destroyed = sim.world.buildings.filter((b) => b.dod >= 7);
    const near = new Map<number, number>();
    const byId = new Map(sim.world.buildings.map((b) => [b.id, b]));
    for (const p of [...d.settled.filter((q) => !q.hidden), ...d.pieces]) {
      const b = byId.get(p.sourceId)!;
      if (Math.hypot(p.pos.x - b.x, p.pos.z - b.z) < 50) near.set(b.id, (near.get(b.id) ?? 0) + p.def.mass * p.represents);
    }
    const fracs = destroyed.map((b) => (near.get(b.id) ?? 0) / (d.massBySource.get(b.id) ?? 1));
    expect(median(fracs)).toBeGreaterThanOrEqual(0.35);
  }, 180000);
});
