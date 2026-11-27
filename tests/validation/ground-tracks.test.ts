/**
 * Spec 19 TERR-19: preset passes over farmland give the expected ground damage tracks. Full
 * preset passes (minutes of sim time), so a validation test (`npm run verify`).
 */
import { describe, expect, test } from "vitest";
import { PRESETS } from "../../src/config/presets";
import { TRACK_STATE } from "../../src/sim/groundTrack";
import { createSim } from "../../src/sim/loop";

/** States across the path (cells within R_max, and between R_max and 3·R_max), mid-path. */
function track(id: string, speedFactor = 1) {
  const pr = PRESETS.find((p) => p.id === id)!;
  const params = { ...pr.params, tUp: 0, tMature: 900, tRope: 0, heading: 0, turnRate: 0 };
  params.translationSpeed = (params.translationSpeed ?? 12) * speedFactor;
  const v = params.translationSpeed;
  const R = params.rMax ?? 150;
  const sim = createSim({ buildings: false, cover: { base: "farmland", rects: [] }, start: { x: -4 * R - 2000, z: 3000 } }, 1, params);
  while (sim.time < (8 * R + 2000) / v) sim.advance(1 / 30);
  const tr = sim.snapshot.groundTrack;
  const core: number[] = [];
  const edge: number[] = [];
  for (let x = -2100; x <= -1900; x += 4) {
    for (let dz = -3 * R; dz <= 3 * R; dz += 2) {
      const st = tr.cellAt(x, 3000 + dz)?.state ?? 0;
      (Math.abs(dz) <= R ? core : edge).push(st);
    }
  }
  sim.dispose();
  const share = (a: number[], f: (s: number) => boolean) => a.filter(f).length / a.length;
  return { core, edge, share };
}

describe("Spec 19 — ground track calibration", () => {
  test("TERR-19: EF2 lodges without scouring; EF3 scours in patches inside the core; EF4 strips most of its core; slower scours more", () => {
    const scoured = (s: number) => s >= TRACK_STATE.thinned;
    const ef2 = track("ef2-cone");
    expect(ef2.share(ef2.core, scoured)).toBe(0);
    expect(ef2.share(ef2.core, (s) => s >= TRACK_STATE.lodged)).toBeGreaterThan(0.9);

    const ef3 = track("ef3-strong");
    const ef3core = ef3.share(ef3.core, scoured);
    expect(ef3core).toBeGreaterThan(0);
    expect(ef3core).toBeLessThan(0.5);
    expect(ef3.share(ef3.edge, scoured)).toBeLessThan(ef3core);

    const ef4 = track("ef4-wedge");
    expect(ef4.share(ef4.core, (s) => s >= TRACK_STATE.stripped)).toBeGreaterThan(0.5);
    // Crops lodged (not gone) at the edges.
    expect(ef4.share(ef4.edge, (s) => s === TRACK_STATE.lodged || s === TRACK_STATE.snapped)).toBeGreaterThan(ef4.share(ef4.edge, scoured));

    const slow = track("ef4-wedge", 0.5);
    const bare = (s: number) => s === TRACK_STATE.bare;
    expect(slow.share(slow.core, (s) => s >= TRACK_STATE.stripped)).toBeGreaterThan(ef4.share(ef4.core, (s) => s >= TRACK_STATE.stripped));
    expect(slow.share(slow.core, bare)).toBeGreaterThanOrEqual(ef4.share(ef4.core, bare));
  }, 1800000);
});
