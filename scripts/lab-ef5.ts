/**
 * One EF5 pass through a detailed lab house (Spec 09 STR-36 validation): open field, mature
 * strength, track 5 m off the house at the given heading; prints the house's DOD and peak roof
 * wind when the eye arrives, as one JSON line.
 *   npx tsx scripts/lab-ef5.ts <seed> <headingDeg>
 */
import { MS_PER_MPH } from "../src/config/units";
import { windAt } from "../src/core/wind/windField";
import { createLab } from "../src/sim/lab";

const seed = Number(process.argv[2] ?? 1);
const heading = Number(process.argv[3] ?? 0);
const lab = await createLab({ houses: 1, cls: "standard", surroundings: "open", seed, donors: false }, { kind: "pass", presetId: "ef5-extreme", headingDeg: heading, offset: 5, lifecycle: "mature" }, { passThrough: false });
const b = lab.sim.world.buildings[0]!;
let peak = 0;
lab.sim.observe({
  debrisStep: () => {
    const w = windAt({ x: b.x, y: b.roofHeight, z: b.z }, lab.sim.snapshot.tornado, lab.sim.snapshot.terrain);
    peak = Math.max(peak, Math.hypot(w.x, w.y, w.z) / MS_PER_MPH);
  },
});
const s0 = lab.sim.snapshot.tornado;
const tEye = Math.hypot(s0.center.x - b.x, s0.center.z - b.z) / Math.hypot(s0.velocity.x, s0.velocity.z);
while (lab.sim.time < tEye) lab.advance(1);
console.log("JSON " + JSON.stringify({ seed, heading, peak, dod: b.dod }));
lab.dispose();
