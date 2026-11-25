import { describe, expect, test } from "vitest";
import { HEAVY } from "../../src/config/debris";
import { createSim } from "../../src/sim/loop";
import { ALIGNMENT_PATCHES, patchTornado } from "../harness/alignment";

describe("Spec 04 v2.0 — rubble stays near destroyed town houses", () => {
  test("DEB-24: in the alignment patch, town houses keep ≥ 15% of their failed mass within 5 m, and their heavy pieces come to rest", () => {
    const spec = { ...ALIGNMENT_PATCHES[0]!, offset: 330 };
    const { p, start, end } = patchTornado(spec);
    const sim = createSim({ area: { x: spec.x, z: spec.z, radius: spec.radius }, start }, 1, p);
    while (sim.time < end) sim.advance(0.25);
    let failed = 0;
    let near = 0;
    let heavy = 0;
    let heavyMoving = 0;
    const pieces = [...sim.debris.pieces, ...sim.debris.settled];
    for (const b of sim.world.buildings) {
      if (Math.hypot(b.x - spec.x, b.z - spec.z) > spec.compare!) continue;
      failed += sim.debris.massBySource.get(b.id) ?? 0;
      const c = Math.cos(b.yaw);
      const s = Math.sin(b.yaw);
      for (const q of pieces) {
        if (q.sourceId !== b.id || q.hidden) continue;
        const m = q.def.mass * q.represents;
        const dx = q.pos.x - b.x;
        const dz = q.pos.z - b.z;
        const out = Math.hypot(Math.max(Math.abs(dx * c - dz * s) - b.width / 2, 0), Math.max(Math.abs(dx * s + dz * c) - b.depth / 2, 0));
        if (out <= 5) near += m;
        if (q.represents === 1 && q.def.mass >= HEAVY.minKg) {
          heavy += m;
          if (!q.resting) heavyMoving += m;
        }
      }
    }
    console.log(`DEB-24: failed ${failed.toFixed(0)} kg, within 5 m ${((100 * near) / failed).toFixed(0)}%, heavy still moving ${((100 * heavyMoving) / heavy).toFixed(0)}%`);
    expect(failed).toBeGreaterThan(10000);
    expect(near / failed).toBeGreaterThanOrEqual(0.15);
    expect(heavyMoving / heavy).toBeLessThanOrEqual(0.1);
  }, 120_000);
});
