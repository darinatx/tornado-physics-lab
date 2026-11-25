import { describe, expect, test } from "vitest";
import { runPassThrough } from "../harness/runPassthrough";
import { PassThroughMonitor } from "../harness/passthrough";
import { exactHouse } from "../houseHelpers";

/**
 * Pass-through check (Spec 10): a short, deterministic tornado pass through the town center,
 * every debris piece judged at every debris step against standing walls, roofs and slabs. Fast
 * (~3 s): 6 s of sim, at most 1,000 pieces. For details on a failure, run
 * `npm run check:passthrough` (add `--detail` for the detail zone, `--full` for a longer pass).
 */
describe("Spec 10 — debris never passes through houses or foundations", () => {
  test("IMP-01, IMP-15, IMP-16: no debris goes through a standing wall or roof, into a slab, or below the ground", async () => {
    const r = await runPassThrough();
    const s = r.monitor.summary(1);
    const lines = s.examples.map((v) => `${v.source} "${v.label}" ${v.kind} of house #${v.house} at t=${v.time.toFixed(2)} s (${v.detail})`);
    expect(r.peakPieces).toBeGreaterThan(200); // the pass did make debris
    expect(s.pieces, lines.join("\n")).toEqual({});
  }, 60000);

  test("the checker itself: flags real pass-through, not entries through openings or resting pieces", () => {
    const b = { ...exactHouse(), id: 1, x: 0, z: 0, yaw: 0 }; // 14 × 11 m, walls 3 m, on a 0.3 m slab
    const run = (path: { x: number; y: number; z: number }[], prep?: () => void) => {
      const house = { ...b, panels: b.panels.map((p) => ({ ...p })), panes: b.panes.map((p) => ({ ...p })) };
      prep?.call(null);
      const m = new PassThroughMonitor([house]);
      path.forEach((pos, i) => m.observe(i / 60, [{ key: "a", source: "debris", label: "test", pos }]));
      return { m, house };
    };
    // Straight through the +X end wall at mid height: flagged going in.
    expect(run([{ x: 9, y: 1.5, z: 0 }, { x: 5, y: 1.5, z: 0 }]).m.violations.map((v) => v.kind)).toEqual(["through wall"]);
    // Through the whole house in one step: in and out.
    expect(run([{ x: 9, y: 1.5, z: 0 }, { x: -9, y: 1.5, z: 0 }]).m.violations.map((v) => v.kind).sort()).toEqual(["out through wall", "through wall"]);
    // A house shifted 2 m −X off its slab, every wall down: a piece sliding in low from −X over
    // the bare ground beside the slab isn't coming up through a floor; over the slab it would be.
    {
      const house = { ...b, shift: { x: -2, z: 0 }, panels: b.panels.map((p) => ({ ...p, failed: {} as never })) };
      const slide = (x0: number, x1: number) => {
        const m = new PassThroughMonitor([house]);
        m.observe(0, [{ key: "a", source: "debris", label: "t", pos: { x: x0, y: 0.05, z: 0 } }]);
        m.observe(1 / 60, [{ key: "a", source: "debris", label: "t", pos: { x: x1, y: 0.35, z: 0 } }]);
        return m.violations.map((v) => v.kind);
      };
      // The shifted house spans x −9…5; the slab x −7.3…7.3. Bare ground under the house: x < −7.3.
      expect(slide(-9.5, -8)).toEqual([]);
      expect(slide(-5.2, -4.8)).toContain("inside slab");
    }
    // Through a failed wall panel: an opening, not flagged.
    {
      const house = { ...b, panels: b.panels.map((p) => ({ ...p, failed: p.face === 0 ? ({} as never) : null })) };
      const m = new PassThroughMonitor([house]);
      m.observe(0, [{ key: "a", source: "debris", label: "t", pos: { x: 9, y: 1.5, z: 0 } }]);
      m.observe(1 / 60, [{ key: "a", source: "debris", label: "t", pos: { x: 5, y: 1.5, z: 0 } }]);
      expect(m.violations).toEqual([]);
    }
    // Grazing along the wall (within 2 cm): not flagged.
    expect(run([{ x: 7.05, y: 1.5, z: -2 }, { x: 6.99, y: 1.5, z: 2 }]).m.violations).toEqual([]);
    // Resting on the slab top, sliding on the ground past it: fine. Inside it, or below ground: flagged.
    expect(run([{ x: 7.1, y: 0.31, z: 0 }, { x: 7.15, y: 0.31, z: 0 }]).m.violations).toEqual([]);
    expect(run([{ x: 9, y: 0.05, z: 0 }, { x: 8.5, y: 0.05, z: 0 }]).m.violations).toEqual([]);
    expect(run([{ x: 9, y: 0.05, z: 0 }, { x: 7.2, y: 0.05, z: 0 }]).m.violations.map((v) => v.kind)).toEqual(["inside slab"]);
    expect(run([{ x: 30, y: -0.5, z: 0 }]).m.violations.map((v) => v.kind)).toEqual(["below ground"]);
    // Down through the roof, and in through an open roof section.
    expect(run([{ x: 0, y: 8, z: 2 }, { x: 0, y: 3.5, z: 2 }]).m.violations.map((v) => v.kind)).toEqual(["through roof"]);
    {
      const house = { ...b, bays: b.bays.map(() => ({ cap: 0, failed: {} as never })) };
      const m = new PassThroughMonitor([house]);
      m.observe(0, [{ key: "a", source: "debris", label: "t", pos: { x: 0, y: 8, z: 2 } }]);
      m.observe(1 / 60, [{ key: "a", source: "debris", label: "t", pos: { x: 0, y: 3.5, z: 2 } }]);
      expect(m.violations).toEqual([]);
    }
  });
});
