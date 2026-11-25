import { describe, expect, test } from "vitest";
import { DEBRIS_KINDS } from "../../src/config/debris";
import { PRESETS } from "../../src/config/presets";
import { allFailures } from "../../src/core/damage/building";
import { createLocalBackend } from "../../src/sim/detailBackend";
import { createSim } from "../../src/sim/loop";
import { initRapier } from "../../src/sim/structureWorld";

/** A patch of ~20 houses, the 6 nearest its west end detailed, passed close by a mature EF4.
 *  Small on purpose (a few minutes for both runs): the detail engine's cost grows with its
 *  houses, and the check needs only some detailed houses next to some town houses. */
async function run(engines: number) {
  await initRapier();
  const preset = PRESETS.find((p) => p.id === "ef4-wedge")!;
  const heading = 60;
  const a = (heading * Math.PI) / 180;
  const d = { x: Math.cos(a), z: -Math.sin(a) };
  const back = 450;
  const sim = createSim(
    { area: { x: 0, z: 20, radius: 90 }, start: { x: -d.x * back, z: 20 - d.z * back }, detailHouses: 6 },
    1,
    { ...preset.params, heading, turnRate: 0, tUp: 0, tRope: 0, tMature: 1e6 },
    (_s, b) => createLocalBackend(b, engines),
  );
  sim.setDetailFocus({ x: -40, z: 20 });
  const end = (2 * back) / sim.params.translationSpeed;
  let last = performance.now();
  while (sim.time < end) {
    sim.advance(0.25);
    if (performance.now() - last > 1000) {
      await new Promise((r) => setImmediate(r));
      last = performance.now();
    }
  }
  const town = sim.world.buildings.filter((b) => !b.detail);
  const failures = town.flatMap((b) => allFailures(b).map((r) => `${b.id}:${r.part}:${r.index}:${r.time.toFixed(4)}:${r.cause ?? "wind"}:${r.missile?.label ?? ""}`)).sort();
  return { failures, detail: sim.world.buildings.filter((b) => b.detail).length, town: town.length };
}

describe("validation — damage both ways between the detail zone and the town", () => {
  test("IMP-20 (validation): detail pieces damage town houses; same results with 1 or 2 detail engines", async () => {
    const one = await run(1);
    const two = await run(2);
    const townLabels = new Set(Object.values(DEBRIS_KINDS).map((k) => k.label));
    const fromDetail = one.failures.filter((f) => f.includes(":debris:") && !townLabels.has(f.split(":").pop()!));
    console.log(`IMP-20: ${one.detail} detailed, ${one.town} town houses; ${one.failures.length} town failures, ${fromDetail.length} by detail-zone pieces`);
    expect(one.detail).toBeGreaterThanOrEqual(4);
    expect(fromDetail.length).toBeGreaterThan(0);
    expect(two.failures).toEqual(one.failures);
  }, 600000);
});
