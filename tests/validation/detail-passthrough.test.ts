import { describe, expect, test } from "vitest";
import { runPassThrough } from "../harness/runPassthrough";

describe("validation — detail-zone pieces and the houses around them", () => {
  test("IMP-17 (validation): detail members hit other houses' walls, roofs and slabs instead of passing through", async () => {
    const r = await runPassThrough({ seconds: 12, detail: true });
    const s = r.monitor.summary(3);
    const members = Object.entries(s.pieces)
      .filter(([k]) => k.startsWith("member:") && !k.endsWith("below ground"))
      .reduce((a, [, n]) => a + n, 0);
    console.log(`IMP-17: ${members} detail members crossed another house or entered its slab`, s.pieces);
    expect(members).toBe(0);
  }, 300000);

  test("IMP-19 (validation): a long town pass: no debris or rubble goes through any house or into any slab", async () => {
    const r = await runPassThrough({ seconds: 20, cap: 3000 });
    const s = r.monitor.summary(3);
    const bad = Object.entries(s.pieces).filter(([k]) => !k.endsWith("below ground"));
    console.log("IMP-19:", s.pieces);
    expect(bad).toEqual([]);
  }, 300000);
});
