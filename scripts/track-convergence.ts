/**
 * Phase 7 validation (slice E, check 5): where the lodged rows converge across a preset's track,
 * against an idealized translating vortex (the Rankine-plus-inflow model tree-fall studies fit
 * their surveys with: Holland et al. 2006, Beck & Dotzek 2010, Karstens et al. 2013).
 * The tornado heads +X, cyclonic (counter-clockwise from above), so its right side, where
 * swirl and forward motion add, is +Z. Offsets are + toward the right side.
 *   npx tsx scripts/track-convergence.ts [presetId ...]
 */
import { PRESETS } from "../src/config/presets";
import { createSim } from "../src/sim/loop";
import { TRACK_STATE } from "../src/sim/groundTrack";
import { initRapier } from "../src/sim/structureWorld";

/** Best cut z: south of it rows point +z, north of it −z (TERR-16's rule). */
function convergence(rows: { z: number; w: number }[]) {
  let best = -1, line = NaN;
  for (const { z: cut } of rows) {
    const score = rows.filter(({ z, w }) => (z < cut ? w > 0 : w < 0)).length;
    if (score > best) (best = score), (line = cut);
  }
  return { line, agree: best / rows.length };
}

/** Idealized vortex: Rankine swirl V (r ≤ R: V·r/R, beyond: V·R/r), inflow k·v_t toward the
 *  centre, translation G·V along +X. Each point's "fall" is the direction of its peak wind. */
function idealLine(G: number, k: number) {
  const R = 1, V = 1, rows: { z: number; w: number }[] = [];
  for (let z = -2.5; z <= 2.5; z += 0.01) {
    let peak = 0, w = 0;
    for (let x = -8; x <= 8; x += 0.002) {
      // Point (0, z) relative to a centre at (x, 0): offset (−x, z).
      const dx = -x, dz = z, r = Math.hypot(dx, dz);
      if (r < 1e-9) continue;
      const vt = r <= R ? (V * r) / R : (V * R) / r;
      const ux = dx / r, uz = dz / r;
      const hx = vt * uz - k * vt * ux + G * V;
      const hz = -vt * ux - k * vt * uz;
      const s = Math.hypot(hx, hz);
      if (s > peak) (peak = s), (w = hz / s);
    }
    if (peak >= 0.6) rows.push({ z, w }); // rows that fall: the damaging part of the track
  }
  return convergence(rows);
}

console.log("Idealized vortex (offset in R_max, + = right side where swirl and motion add):");
for (const G of [0.2, 0.35, 0.5]) {
  const cells = [0, 0.5, 1, 1.5].map((k) => {
    const c = idealLine(G, k);
    return `inflow ${k}: ${c.line >= 0 ? "+" : ""}${c.line.toFixed(2)} (${(100 * c.agree).toFixed(0)}%)`;
  });
  console.log(`  G = V_trans/V_max ${G}: ${cells.join(" | ")}`);
}

await initRapier();
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ["ef1-small", "ef2-cone", "ef3-strong"];
for (const id of ids) {
  const pr = PRESETS.find((p) => p.id === id)!;
  const params = { ...pr.params, tUp: 0, tMature: 900, tRope: 0, heading: 0, turnRate: 0 };
  const v = params.translationSpeed ?? 12, R = params.rMax ?? 150;
  const sim = createSim({ buildings: false, cover: { base: "farmland", rects: [] }, start: { x: -4 * R - 2000, z: 3000 } }, 1, params);
  while (sim.time < (8 * R + 2000) / v) sim.advance(1 / 30);
  const tr = sim.snapshot.groundTrack;
  const st = sim.snapshot.tornado;
  const lines: number[] = [], agrees: number[] = [];
  let lodgedL = Infinity, lodgedR = -Infinity;
  for (let x = -2100; x <= -1900; x += 20) {
    const rows: { z: number; w: number }[] = [];
    for (let dz = -3 * R + 1; dz < 3 * R; dz += 2) {
      const c = tr.cellAt(x, 3000 + dz);
      if (!c || c.state < TRACK_STATE.lodged) continue;
      rows.push({ z: dz, w: Math.sin(c.dirRad) });
      lodgedL = Math.min(lodgedL, dz);
      lodgedR = Math.max(lodgedR, dz);
    }
    if (rows.length < 10) continue;
    const c = convergence(rows);
    lines.push(c.line);
    agrees.push(c.agree);
  }
  lines.sort((a, b) => a - b);
  const med = lines[Math.floor(lines.length / 2)] ?? NaN;
  const mid = (lodgedL + lodgedR) / 2;
  const G = v / st.vMax;
  console.log(`${id}: V ${st.vMax} R ${R} v ${v} (G ${G.toFixed(2)}, inflow ratio ${st.inflowRatio}) | lodged from ${lodgedL} to ${lodgedR} m (mid ${mid.toFixed(0)}) | convergence line median ${med} m = ${(med / R).toFixed(2)} R_max from the vortex path, ${(med - mid).toFixed(0)} m from the lodged strip's middle | ${lines.length} cuts, agreement ${(100 * Math.min(...agrees)).toFixed(0)}–${(100 * Math.max(...agrees)).toFixed(0)}%`);
  const ideal = idealLine(G, st.inflowRatio);
  console.log(`  idealized vortex at the same G and inflow: ${ideal.line.toFixed(2)} R_max`);
  sim.dispose();
}
process.exit(0);
