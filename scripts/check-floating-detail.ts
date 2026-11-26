/**
 * Floating detail pieces (Spec 09): pieces of detailed houses left in mid-air.
 *   npx tsx scripts/check-floating-detail.ts [preset=ef4-wedge] [x,z=-650,1130]
 * Reports, with the sim time:
 *  - frozen in flight: a house froze (settled or timed out) with a piece unsupported (nothing
 *    under its colliders within 5 cm) or a light piece airborne;
 *  - floating rubble: a resting-rubble body (fixed) whose support has gone;
 *  - frozen on a town house: a frozen piece resting only on a town house's stand-in, whose
 *    state changed after the freeze (its roof or walls may be gone from under it).
 */
import RAPIER from "@dimforge/rapier3d-simd-compat";
import { PRESETS } from "../src/config/presets";
import { DETAIL } from "../src/config/structure";
import { supportHeight } from "../src/core/debris/piece";
import { createLocalBackend } from "../src/sim/detailBackend";
import { DetailEngine } from "../src/sim/detailZone";
import { createSim } from "../src/sim/loop";
import { DetailHouse, initRapier, StructureWorld } from "../src/sim/structureWorld";

await initRapier();
const presetId = process.argv[2] ?? "ef4-wedge";
const [fx, fz] = (process.argv[3] ?? "-650,1130").split(",").map(Number) as [number, number];
const preset = PRESETS.find((p) => p.id === presetId)!;

type Light = { piece: { pos: { y: number; x: number; z: number }; resting: boolean } & Parameters<typeof supportHeight>[0] };
const sim0 = { t: 0 };
const events: string[] = [];
const counts: Record<string, number> = {};
const note = (kind: string, s: string) => {
  counts[kind] = (counts[kind] ?? 0) + 1;
  if (events.length < 80) events.push(`${sim0.t.toFixed(1).padStart(6)} s  ${kind.padEnd(22)} ${s}`);
};

/** What's under a body: "none", "ground", "town:<i>", or "piece". */
function support(sw: StructureWorld, body: RAPIER.RigidBody): string {
  const world = sw.world;
  const own = new Set<number>();
  for (let i = 0; i < body.numColliders(); i++) own.add(body.collider(i).handle);
  let found = "none";
  for (let i = 0; i < body.numColliders(); i++) {
    const c = body.collider(i);
    const t = c.translation();
    world.intersectionsWithShape({ x: t.x, y: t.y - 0.05, z: t.z }, c.rotation(), c.shape, (o) => {
      if (own.has(o.handle)) return true;
      const town = sw.townHouseOf.get(o.handle);
      if (town) {
        if (found === "none") found = `town:${town.index}`;
        return true;
      }
      found = sw.owner.has(o.handle) ? "piece" : "ground";
      return false;
    });
    if (found !== "none" && !found.startsWith("town")) return found;
  }
  return found;
}

let engine: DetailEngine | null = null;
const worldOfHouse = new Map<DetailHouse, StructureWorld>();
const watchTown: { house: number; town: number; version: number; y: number }[] = [];
const townVersion = () => (engine as unknown as { townVersion: Map<number, number> }).townVersion;

{
  const proto = DetailHouse.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const f = proto.freeze!;
  proto.freeze = function (this: DetailHouse) {
    const sw = worldOfHouse.get(this);
    if (sw && !this.frozen) {
      const timedOut = this.releasedAt !== null && sw.time - this.releasedAt > DETAIL.settleTimeout;
      const idx = this.building.id;
      const bodies: [number, string][] = [...[...this.groupBodies.keys()].map((h) => [h, "body"] as [number, string]), ...[...this.rubble.keys()].map((h) => [h, "rubble"] as [number, string])];
      for (const [handle, kind] of bodies) {
        const b = sw.world.getRigidBody(handle);
        const y = b.worldCom().y;
        const v = b.linvel();
        const sp = Math.hypot(v.x, v.y, v.z);
        const s = support(sw, b);
        if (s === "none") note("frozen in flight", `house ${idx} ${kind} y=${y.toFixed(1)} m v=${sp.toFixed(1)} m/s ${timedOut ? "(timeout)" : ""}`);
        else if (s.startsWith("town:")) {
          const town = Number(s.slice(5));
          watchTown.push({ house: idx, town, version: townVersion().get(town) ?? 0, y });
        }
      }
      for (const { piece } of (this as unknown as { light: Map<number, Light> }).light.values()) {
        const h = piece.pos.y - supportHeight(piece);
        if (!piece.resting && h > 0.5) note("frozen in flight", `house ${idx} light y=${piece.pos.y.toFixed(1)} m ${timedOut ? "(timeout)" : ""}`);
      }
    }
    return f.apply(this);
  };
}
{
  const proto = StructureWorld.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const f = proto.step!;
  const reported = new Set<string>();
  proto.step = function (this: StructureWorld, ...a: unknown[]) {
    for (const h of this.houses) worldOfHouse.set(h, this);
    const r = f.apply(this, a);
    if (this.stepCount % 30 === 0)
      for (const h of this.houses) {
        if (h.frozen) continue;
        for (const handle of h.rubble.keys()) {
          const key = `${h.building.id}:${handle}`;
          if (reported.has(key)) continue;
          const b = this.world.getRigidBody(handle);
          if (support(this, b) === "none") {
            reported.add(key);
            note("floating rubble", `house ${h.building.id} y=${b.worldCom().y.toFixed(1)} m`);
          }
        }
      }
    return r;
  };
}

let backend = null as ReturnType<typeof createLocalBackend> | null;
const sim = createSim({}, 1, preset.params, (_s, b) => (backend = createLocalBackend(b, 1)));
sim.setDetailFocus({ x: fx, z: fz });
let entered = false;
for (let n = 0; n < 60 * 600; n++) {
  sim.advance(1 / 60);
  sim0.t = sim.time;
  engine = backend?.engines[0] ?? null;
  if (!engine) continue;
  if (engine.houses.size) entered = true;
  if (entered && [...engine.houses.values()].every((h) => h.frozen)) break;
}
// Run on a while (the town's houses keep changing as the tornado moves on).
for (let n = 0; n < 60 * 60; n++) sim.advance(1 / 60);
for (const w of watchTown) {
  const now = townVersion().get(w.town) ?? 0;
  if (now !== w.version) note("frozen on town house", `house ${w.house} piece y=${w.y.toFixed(1)} m on town house ${w.town} (changed ${now - w.version}× after freeze)`);
}
console.log(`preset ${preset.id} spot ${fx},${fz}: ${JSON.stringify(counts)} (on town stand-ins at freeze: ${watchTown.length})`);
for (const e of events) console.log(e);
