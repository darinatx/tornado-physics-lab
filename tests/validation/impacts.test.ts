import { describe, expect, test } from "vitest";
import { advanceUntil } from "../helpers";
import { DEBRIS_KINDS } from "../../src/config/debris";
import { PRESETS } from "../../src/config/presets";
import type { Building } from "../../src/core/damage/types";
import { allFailures } from "../../src/core/damage/building";
import { resolveImpact } from "../../src/core/impact/impact";
import type { Missile } from "../../src/core/impact/impact";
import { createSim } from "../../src/sim/loop";
import { createRng } from "../../src/sim/rng";
import { exactHouse } from "../houseHelpers";
import { IMPACT } from "../../src/config/impacts";
import { overSlab } from "../../src/core/impact/envelope";
import { supportHeight } from "../../src/core/debris/piece";

const twoByFour = (mass: number): Missile => ({ label: "2×4", family: "rod", mass, dims: DEBRIS_KINDS.stud.dims });

describe("validation — debris impacts", () => {
  test("IMP-12 (validation): published missile tests", () => {
    const b = exactHouse();
    const rng = createRng(7);
    const wall = { kind: "wall" as const, index: 0, face: b.panels[0]!.face };
    const share = (m: Missile, v: number) => {
      let k = 0;
      for (let i = 0; i < 20000; i++) if (resolveImpact(b, wall, m, v, rng)!.impact.perforated) k++;
      return k / 20000;
    };
    // 9 lb 2×4 at 34 mph through a vinyl-sided OSB wall (BIA test); the 15 lb shelter missile at 100 mph.
    expect(share(twoByFour(4.1), 15.2)).toBeGreaterThanOrEqual(0.9);
    expect(share(twoByFour(6.8), 44.7)).toBeGreaterThanOrEqual(0.999);
    // Glass over many panes, by impact momentum p (kg·m/s).
    const glass = (kind: "shingle" | "stud" | "glass", p: number) => {
      const d = DEBRIS_KINDS[kind];
      const m: Missile = { label: d.label, family: d.family, mass: d.mass, dims: d.dims };
      let k = 0;
      for (let id = 0; id < 5000; id++) {
        const h = { ...b, id } as Building;
        if (resolveImpact(h, { kind: "pane", index: 0, face: 0 }, m, p / d.mass, rng)!.impact.broke) k++;
      }
      return k / 5000;
    };
    // Shingles on 3.18 mm annealed glass (Shah 2008; Masters et al. 2010): mean breaking momentum
    // 4.71 kg·m/s, lowest seen 2.35, highest 7.04.
    expect(glass("shingle", 4.71)).toBeGreaterThanOrEqual(0.4);
    expect(glass("shingle", 4.71)).toBeLessThanOrEqual(0.6);
    expect(glass("shingle", 2.35)).toBeLessThanOrEqual(0.05);
    expect(glass("shingle", 7.04)).toBeGreaterThanOrEqual(0.85);
    // 2×4s on annealed glass (NAHB 2002): 50% breakage at 2.3–2.5 lbf·s (10.2–11.1 kg·m/s).
    expect(glass("stud", 10.2)).toBeGreaterThanOrEqual(0.4);
    expect(glass("stud", 11.1)).toBeLessThanOrEqual(0.6);
    // A shard dropped onto a pane at 1 m/s rarely breaks it.
    expect(glass("glass", 0.25)).toBeLessThanOrEqual(0.5);
  });

  test("IMP-13 (validation): an EF4 through town breaks windows with debris and lodges lumber", async () => {
    const ef4 = PRESETS.find((p) => p.id === "ef4-wedge")!;
    const sim = createSim({}, 1, ef4.params);
    await advanceUntil(sim, () => sim.snapshot.phase === "dissipated" && sim.snapshot.debris.airborne <= 50);
    const firstWindowByDebris = sim.world.buildings.filter((b) => {
      const w = allFailures(b).filter((r) => r.part === "window").sort((a, c) => a.time - c.time);
      return w.length > 0 && w[0]!.cause === "debris";
    });
    expect(firstWindowByDebris.length).toBeGreaterThan(0);
    expect(sim.snapshot.debris.impacts).toBeGreaterThan(0);
    // Lumber lodges in walls (most of it falls out again when its wall comes down).
    expect(sim.snapshot.debris.lodgedTotal).toBeGreaterThan(0);
    // Nothing left inside a slab.
    const buried = [...sim.debris.pieces, ...sim.debris.settled.filter((p) => !p.hidden)].filter(
      (p) => !p.lodgedIn && p.pos.y - supportHeight(p) < IMPACT.slabTop - 0.02 && sim.world.near(p.pos.x, p.pos.z).some((b) => overSlab(b, p.pos)),
    );
    expect(buried.length).toBe(0);
    const d = sim.debris;
    const onMap = [...d.settled.filter((p) => !p.hidden), ...d.pieces].reduce((a, p) => a + p.def.mass * p.represents, 0);
    const ledger = onMap + d.massLofted + d.massSkipped + d.massSwept + d.massLeftMap;
    expect(Math.abs(ledger / d.massSpawned - 1)).toBeLessThan(0.01);
    const debrisFails = sim.world.buildings.flatMap((b) => allFailures(b)).filter((r) => r.cause === "debris");
    console.log(`IMP-13: ${firstWindowByDebris.length} houses lost their first window to debris; ${debrisFails.length} debris failures; ${d.stats.impacts} impacts; ${d.stats.lodgedTotal} lodged (${d.stats.lodged} still stuck)`);
  }, 300000);
});
