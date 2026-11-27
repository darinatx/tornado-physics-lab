/**
 * Print the town's roughness field across its west edge (Spec 17): local and upwind-weighted
 * z₀ and β for wind from the west and from the east, and the cost of building it.
 *   npx tsx scripts/terrain-field.ts [seed]
 */
import { createWorld } from "../src/sim/world";
import { CITY } from "../src/sim/city";
import { TownRoughness, townCover } from "../src/sim/terrain";
import { betaFromZ0, effZ0At, terrainClassOf, z0At } from "../src/core/terrain/roughness";

const seed = Number(process.argv[2] ?? 1);
const world = createWorld(seed, true);
let t0 = performance.now();
const tr = new TownRoughness(townCover(CITY.extent), world.buildings);
const build = performance.now() - t0;
const f = tr.field;
console.log(`grid ${f.nx}×${f.nz} (${f.nx * f.nz} nodes), built in ${build.toFixed(0)} ms, ${world.buildings.length} houses`);
const edge = -CITY.extent / 2;
console.log("x from west edge (m) | local z0 | eff z0 (wind from W) | β W | eff z0 (wind from E) | β E | class W");
for (const d of [-1000, -500, -200, -100, 0, 50, 100, 200, 300, 500, 750, 1000, 1300]) {
  const x = edge + d;
  const z = 7;
  const loc = z0At(f, x, z);
  const w = effZ0At(f, x, z, 0); // blowing toward +X: from the west
  const e = effZ0At(f, x, z, Math.PI);
  console.log(`${String(d).padStart(6)} | ${loc.toFixed(3)} | ${w.toFixed(3)} | ${betaFromZ0(w).toFixed(3)} | ${e.toFixed(3)} | ${betaFromZ0(e).toFixed(3)} | ${terrainClassOf(w)}`);
}
// Update cost: flatten 30 houses near the center and update.
for (const b of world.buildings.filter((b) => Math.hypot(b.x, b.z) < 150)) {
  b.rev++;
  for (const p of b.panels) p.failed = { part: "wall", index: 0, time: 0, load: 0, capacity: 0, mph: 0, sign: 1, wind: { x: 0, y: 0, z: 0 } } as never;
}
t0 = performance.now();
tr.update(world.buildings);
console.log(`update ${(performance.now() - t0).toFixed(1)} ms; center z0 after flattening: ${z0At(tr.field, 0, 0).toFixed(3)}`);
