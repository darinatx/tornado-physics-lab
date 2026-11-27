/**
 * The calibration setting for house capacities (Spec 03 v2.5): the default town's house sites
 * and its intact roughness field (Spec 17), so calibration passes load houses the way the town
 * does. Built once per process (~0.1 s).
 */
import { CALIBRATION } from "../config/buildings";
import type { ConstructionClass, Part } from "../config/buildings";
import { createHouse } from "../core/damage/building";
import { tornadoPass } from "../core/damage/steadyRamp";
import type { TornadoState } from "../core/wind/types";
import { PRESETS } from "../config/presets";
import { defaultParams } from "./types";
import type { Building } from "../core/damage/types";
import type { RoughnessField } from "../core/terrain/roughness";
import { CITY, randomHouseSpec } from "./city";
import { createRng } from "./rng";
import { TownRoughness, townCover } from "./terrain";
import { createWorld } from "./world";

export interface CalibrationTown {
  terrain: RoughnessField;
  /** Every house site of the town: position (m) and yaw (rad). */
  sites: readonly { x: number; z: number; yaw: number }[];
}

let cached: CalibrationTown | null = null;

export function calibrationTown(): CalibrationTown {
  if (cached) return cached;
  const world = createWorld(CALIBRATION.townSeed, true);
  const terrain = new TownRoughness(townCover(CITY.extent), world.buildings).field;
  cached = { terrain, sites: world.buildings.map((b) => ({ x: b.x, z: b.z, yaw: b.yaw })) };
  return cached;
}

/**
 * A calibration pass the way the presets hit the town (Spec 03 v2.5): one of the EF1–EF5
 * presets at its mature strength and size (its own profile, Spec 01 defaults otherwise), a
 * random heading, and the house anywhere within ±CALIBRATION.offsetRmax·R_max of the track, so
 * light damage comes from the outer flow as it does in town, not only from near the core.
 */
export function sampleTownPassCase(rng: () => number): { state: TornadoState; offset: number } {
  const ids = CALIBRATION.presets;
  const id = ids[Math.floor(rng() * ids.length)];
  const pr = PRESETS.find((x) => x.id === id)!;
  const p = { ...defaultParams(), ...pr.params };
  const heading = rng() * Math.PI * 2;
  const v = p.translationSpeed;
  return {
    state: {
      center: { x: 0, z: 0 },
      velocity: { x: v * Math.cos(heading), z: v * Math.sin(heading) },
      vMax: p.vPeak,
      rMax: p.rMax,
      alpha: p.alpha,
      outerReach: p.outerReach,
      inflowRatio: p.inflowRatio,
      inflowDepth: p.inflowDepth,
      updraftMax: p.updraftMax,
      overshoot: p.overshoot,
      zPeak: p.zPeak,
      rotation: p.rotation,
    },
    offset: (rng() * 2 - 1) * CALIBRATION.offsetRmax * p.rMax,
  };
}

/** A censored first-reach sample for the Kaplan–Meier median (Spec 03). */
export interface ReachSample {
  t: number;
  observed: boolean;
}

/**
 * `n` houses of class `cls` at random town sites, each passed by a random preset tornado
 * (`sampleTownPassCase`) in the town's roughness. Returns, per DOD 1..10, the 10 m open-terrain
 * first-reach samples (censored at the pass's 10 m peak), the mean 10 m open ÷ roof-height
 * ratio at first reach (`ratio[d]`, 1 where none reached it), and the houses themselves.
 */
export function townPassSamples(
  n: number,
  seed: number,
  cls: ConstructionClass = "standard",
  base?: Record<Part, number>,
  vMax?: number,
): { samples: ReachSample[][]; houses: { b: Building; peak10Mph: number }[]; ratio: number[] } {
  const town = calibrationTown();
  const rng = createRng(seed);
  const samples: ReachSample[][] = Array.from({ length: 11 }, () => []);
  const houses: { b: Building; peak10Mph: number }[] = [];
  const ratioSum = new Array<number>(11).fill(0);
  const ratioN = new Array<number>(11).fill(0);
  for (let i = 0; i < n; i++) {
    const site = town.sites[Math.floor(rng() * town.sites.length)]!;
    const b = createHouse(randomHouseSpec(i, rng, site.x, site.z, site.yaw, cls), rng, base);
    const c = sampleTownPassCase(rng);
    const r = tornadoPass(b, vMax ? { ...c.state, vMax } : c.state, town.terrain, c.offset, site);
    for (let d = 1; d <= 10; d++)
      samples[d]!.push(Number.isFinite(r.first[d]!) ? { t: r.first[d]!, observed: true } : { t: r.peak10Mph, observed: false });
    for (let d = 1; d <= 10; d++)
      if (Number.isFinite(r.first[d]!)) {
        ratioSum[d]! += r.first[d]! / r.firstRoof[d]!;
        ratioN[d]!++;
      }
    houses.push({ b, peak10Mph: r.peak10Mph });
  }
  const ratio = ratioSum.map((s, d) => (ratioN[d]! ? s / ratioN[d]! : 1));
  return { samples, houses, ratio };
}
