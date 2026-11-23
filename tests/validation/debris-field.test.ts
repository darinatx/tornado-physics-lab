import { describe, expect, test } from "vitest";
import { PRESETS } from "../../src/config/presets";
import { createSim } from "../../src/sim/loop";
import { median } from "../houseHelpers";

describe("validation — debris field", () => {
  test("DEB-12 (validation): the debris field spreads across the path like its sources", () => {
    const ef4 = PRESETS.find((p) => p.id === "ef4-wedge")!;
    const sim = createSim({}, 1, ef4.params);
    const v0 = sim.snapshot.tornado.velocity;
    const sp = Math.hypot(v0.x, v0.z);
    const right = { x: -v0.z / sp, z: v0.x / sp };
    const lat = (x: number, z: number) => x * right.x + z * right.z;
    while (sim.snapshot.phase !== "dissipated" || sim.snapshot.debris.airborne > 50) sim.advance(0.25);
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
    const heavy = travel(["stud", "rafter", "chunk"]);
    const sheets = travel(["osb", "garagePanel"]);
    expect(heavy).toBeLessThan(150);
    expect(sheets).toBeGreaterThan(heavy);
  }, 180000);
});
