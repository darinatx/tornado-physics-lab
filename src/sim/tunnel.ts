/**
 * Wind tunnel (Spec 12): one house in a scripted wind, with debris fired at it, through the
 * same sim, debris field and detail engine as the town. Headless; the runner, record and checks
 * live in tests/harness/tunnel.ts.
 */
import type { ConstructionClass } from "../config/buildings";
import { TUNNEL } from "../config/tunnel";
import type { HouseSpec } from "../core/damage/types";
import type { Vec3 } from "../core/math/vec";
import type { TerrainClass } from "../core/wind/types";
import { randomHouseSpec } from "./city";
import { createLocalBackend } from "./detailBackend";
import { Launcher } from "./launcher";
import type { Launch, Launched } from "./launcher";
import type { Sim } from "./loop";
import { createRng } from "./rng";
import { initRapier } from "./structureWorld";
import type { StructureWorld } from "./structureWorld";
import type { SimConfig, SimTaps } from "./types";
import { createSim } from "./loop";
import { tunnelFlow } from "./tunnelFlow";
import type { WindKey } from "./tunnelFlow";

export { tunnelFlow, tunnelState } from "./tunnelFlow";
export type { WindKey } from "./tunnelFlow";

export { aimPoint } from "./launcher";
export type { Aim, Launch, Launched, MemberLaunch, TownLaunch } from "./launcher";

export interface TunnelScenario {
  name: string;
  seed?: number;
  seconds: number;
  target: { model: "component" | "detail"; spec?: Partial<HouseSpec>; cls?: ConstructionClass };
  terrain?: TerrainClass;
  wind: readonly WindKey[];
  launches?: readonly Launch[];
}

export interface Tunnel {
  readonly sim: Sim;
  readonly scenario: TunnelScenario;
  /** Index of the target in the sim's buildings, and of the donors. */
  readonly target: number;
  readonly donors: { same?: number; other?: number };
  readonly launched: Launched[];
  /** The sim's observers: set their fields to record (the harness does). */
  readonly taps: SimTaps;
  /** Advance by `seconds` of sim time, 1/60 s at a time (each debris step), calling `onStep`
   *  after each; chunking never changes the result. */
  advance(seconds: number): void;
  onStep: ((t: Tunnel) => void) | null;
  /** The physics world a house is in (detail zone), if any. */
  worldOf(index: number): StructureWorld | undefined;
  /** Where launch i's members are now (detailed launches). */
  launchBody(i: number): { center: Vec3; vel: Vec3; members: number[]; bornAt: number } | null;
  dispose(): void;
}

const DEG = Math.PI / 180;

/** Mean wind direction over the schedule (deg), weighted by speed; the first key's if calm. */
function meanDir(keys: readonly WindKey[]): number {
  let x = 0;
  let z = 0;
  for (const k of keys) {
    x += k.mph * Math.cos(k.dirDeg * DEG);
    z += k.mph * Math.sin(k.dirDeg * DEG);
  }
  return Math.hypot(x, z) > 1e-9 ? Math.atan2(z, x) / DEG : (keys[0]?.dirDeg ?? 0);
}

/** Build the tunnel: the target (and any donors) as the sim's houses, the flow as its wind. */
export async function createTunnel(s: TunnelScenario): Promise<Tunnel> {
  const seed = s.seed ?? 1;
  const launches = s.launches ?? [];
  const rng = createRng(seed);
  const spec: HouseSpec = { ...randomHouseSpec(0, rng, 0, 0, 0, s.target.cls), ...s.target.spec, id: 0, x: 0, z: 0 };
  const houses: HouseSpec[] = [spec];
  const donors: { same?: number; other?: number } = {};
  const across = (meanDir(s.wind) + 90) * DEG;
  const side = { x: Math.cos(across), z: -Math.sin(across) };
  const donor = (sign: number): number => {
    houses.push({ ...spec, id: houses.length, x: sign * side.x * TUNNEL.donorOffset, z: sign * side.z * TUNNEL.donorOffset });
    return houses.length - 1;
  };
  if (launches.some((l) => l.source === "detail-same")) donors.same = donor(1);
  if (launches.some((l) => l.source === "detail-other")) donors.other = donor(-1);

  const detailSet: NonNullable<SimConfig["detailSet"]>[number][] = [];
  if (s.target.model === "detail") detailSet.push({ index: 0, group: "tunnel:target" });
  if (donors.same !== undefined) detailSet.push({ index: donors.same, group: "tunnel:target", stripped: true });
  if (donors.other !== undefined) detailSet.push({ index: donors.other, group: "tunnel:other", stripped: true });
  const needDetail = detailSet.length > 0;
  await initRapier();

  const launcher = new Launcher(() => tun.sim.world.buildings, 0, donors);
  for (const l of launches) launcher.add(l);
  const launched = launcher.launched;
  const inject = launcher.inject;
  let tun: Tunnel;

  // Observers: the harness fills them in after creation (it owns the record).
  const taps: SimTaps = {};
  let backend: ReturnType<typeof createLocalBackend> | null = null;
  const sim = createSim(
    { houses, tunnel: (t) => tunnelFlow(s.wind, t), ...(needDetail ? { detailSet } : {}), taps, inject },
    seed,
    { terrain: s.terrain ?? "open" },
    needDetail ? (_seed, b) => (backend = createLocalBackend(b, 1)) : undefined,
  );
  if (needDetail) sim.setDetailFocus({ x: 0, z: 0 });

  let want = 0;
  let done = 0;
  tun = {
    sim,
    scenario: s,
    target: 0,
    donors,
    launched,
    taps,
    onStep: null,
    advance(seconds) {
      want += seconds;
      const n = Math.floor(want * 60 + 1e-6);
      while (done < n) {
        sim.advance(1 / 60);
        done++;
        tun.onStep?.(tun);
      }
    },
    worldOf(index) {
      return backend?.engines[0]?.worldFor(index);
    },
    launchBody(i) {
      const l = launched.find((x) => x.i === i);
      if (!l || l.house === undefined || !backend) return null;
      const h = backend.engines[0]!.houses.get(l.house);
      return h ? h.freeState(l.members![0]!) : null;
    },
    dispose() {
      backend?.dispose();
    },
  };
  return tun;
}
