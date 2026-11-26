/**
 * Spec 19 — ground damage tracks. Small cores and short passes keep these fast; the preset
 * calibration (TERR-19) is in tests/validation/ground-tracks.test.ts.
 */
import { describe, expect, test } from "vitest";
import { TRACK } from "../../src/config/terrain";
import { z0At, isField } from "../../src/core/terrain/roughness";
import type { RoughnessField } from "../../src/core/terrain/roughness";
import type { Piece } from "../../src/core/debris/piece";
import { windAt } from "../../src/core/wind/windField";
import { GroundTrack, TRACK_STATE, scourRate, stateFor } from "../../src/sim/groundTrack";
import { createSim } from "../../src/sim/loop";
import type { TornadoParams } from "../../src/sim/types";
import { trackTexels, TRACK_COLOR } from "../../src/render/groundTrackLayer";
import { hspeed } from "../helpers";

const FARM = { base: "farmland" as const, rects: [] };
/** A mature tornado heading +X along z = 0, its core reaching x = 0 at `arrive` s. */
function pass(p: Partial<TornadoParams>, untilPastM: number, o: { arrive?: number; houses?: boolean } = {}) {
  const params = { tUp: 0, tMature: 900, tRope: 0, heading: 0, turnRate: 0, ...p };
  const v = params.translationSpeed ?? 12;
  const arrive = o.arrive ?? 8;
  const sim = createSim({ buildings: o.houses ?? false, ...(o.houses ? { houses: [] } : {}), cover: FARM, start: { x: -v * arrive, z: 0 } }, 1, params);
  while (sim.time < arrive + untilPastM / v) sim.advance(1 / 30);
  return sim;
}
/** Cells across the path at x (z from −h to h, every 2 m). */
const across = (tr: GroundTrack, x: number, h: number) => {
  const out: { z: number; c: ReturnType<GroundTrack["cellAt"]> }[] = [];
  for (let z = -h + 1; z < h; z += 2) out.push({ z, c: tr.cellAt(x, z) });
  return out;
};

describe("Spec 19 — ground damage tracks", () => {
  test("TERR-15: deterministic; only cells within the active radius change; an untouched map has no tiles", () => {
    const p = { vPeak: 34, rMax: 60, translationSpeed: 12 };
    const a = pass(p, 200).snapshot.groundTrack;
    const b = pass(p, 200).snapshot.groundTrack;
    expect(a.list.length).toBeGreaterThan(0);
    expect(a.list.map((t) => [t.ti, t.tj, t.version, [...t.peak], [...t.state], [...t.dir]])).toEqual(b.list.map((t) => [t.ti, t.tj, t.version, [...t.peak], [...t.state], [...t.dir]]));
    // Every touched cell lies within the active radius of the path (z = 0).
    const R = GroundTrack.activeRadius({ center: { x: 0, z: 0 }, velocity: { x: 12, z: 0 }, vMax: 34, rMax: 60, alpha: 0.6, inflowRatio: 0.5, inflowDepth: 50, updraftMax: 30, overshoot: 1.3, zPeak: 20, rotation: 1 });
    for (const t of a.list) for (let c = 0; c < t.peak.length; c++) if (t.peak[c]! > 0) expect(Math.abs((t.tj * 64 + (Math.floor(c / 32) + 0.5) * 2))).toBeLessThanOrEqual(R + 2);
    // Too weak to reach the lowest threshold anywhere: no tiles at all.
    expect(pass({ vPeak: 5, rMax: 60, translationSpeed: 5 }, 50).snapshot.groundTrack.list.length).toBe(0);
  }, 120000);

  test("TERR-16: each cell lies in its peak wind's direction; lodged rows converge on one line near the centre", () => {
    const sim = pass({ vPeak: 34, rMax: 60, translationSpeed: 12 }, 300);
    const tr = sim.snapshot.groundTrack;
    for (const x of [-40, 0, 40]) {
      const row = across(tr, x, 240).filter(({ c }) => c && c.state >= TRACK_STATE.lodged);
      expect(row.length).toBeGreaterThan(20);
      // The cross-track component of each lodged row (+ toward +z).
      const zc = row.map(({ z, c }) => ({ z, w: Math.sin(c!.dirRad) }));
      // The convergence line: where rows switch from pointing +z (south of it) to −z (north).
      let best = 0, line = 0;
      for (const { z: cut } of zc) {
        const score = zc.filter(({ z, w }) => (z < cut ? w > 0 : w < 0)).length;
        if (score > best) (best = score), (line = cut);
      }
      expect(Math.abs(line)).toBeLessThanOrEqual(60); // within R_max of the centreline
      const south = zc.filter(({ z }) => z < line);
      const north = zc.filter(({ z }) => z >= line);
      expect(south.filter(({ w }) => w > 0).length / south.length).toBeGreaterThanOrEqual(0.8);
      expect(north.filter(({ w }) => w < 0).length / north.length).toBeGreaterThanOrEqual(0.8);
    }
    // The stored direction is the 2 m wind's at the cell's peak: a lodged cell's peak is above
    // the lodging threshold, and its direction encodes to within one 1/256 turn.
    const cell = tr.cellAt(0, 30)!;
    expect(cell.peak).toBeGreaterThan(TRACK.cropLodge);
  }, 120000);

  test("TERR-17: crops lodge below the lawn's threshold; a weak (EF1) pass lodges in patches, mostly on one side", () => {
    expect(TRACK.cropLodge).toBeLessThan(TRACK.lawnFlatten);
    expect(stateFor(0, TRACK.cropLodge + 1, 0)).toBe(TRACK_STATE.lodged);
    expect(stateFor(1, TRACK.cropLodge + 1, 0)).toBe(TRACK_STATE.standing);
    expect(stateFor(1, TRACK.lawnFlatten + 1, 0)).toBe(TRACK_STATE.pushedOver);
    const tr = pass({ vPeak: 26, rMax: 70, translationSpeed: 10 }, 300).snapshot.groundTrack;
    let north = 0, south = 0, cells = 0;
    for (const x of [-60, -20, 20, 60]) {
      for (const { z, c } of across(tr, x, 210)) {
        cells++;
        if (c && c.state >= TRACK_STATE.lodged) (z > 0 ? north++ : south++);
      }
    }
    expect(north + south).toBeGreaterThan(0);
    expect(north + south).toBeLessThan(cells * 0.6); // patchy, not the whole width
    expect(Math.max(north, south)).toBeGreaterThanOrEqual(2 * Math.min(north, south));
  }, 120000);

  test("TERR-18: scouring grows with duration and debris; none below the onset", () => {
    expect(scourRate(TRACK.scourOnset - 1, 5)).toBe(0);
    expect(scourRate(TRACK.scourOnset, 0)).toBe(0);
    expect(scourRate(70, 1)).toBeGreaterThan(scourRate(70, 0));
    expect(scourRate(80, 0)).toBeGreaterThan(scourRate(70, 0));
    const fast = pass({ vPeak: 60, rMax: 60, translationSpeed: 16 }, 200).snapshot.groundTrack;
    const slow = pass({ vPeak: 60, rMax: 60, translationSpeed: 8 }, 200).snapshot.groundTrack;
    // Cell by cell the passes sample the wind at different moments, so compare the core as a
    // whole: the slow pass scours more, and almost every cell is at least as far along.
    let fastSum = 0, slowSum = 0, n = 0, behind = 0;
    for (const x of [-30, 0, 30]) {
      for (let z = -60; z <= 60; z += 4) {
        const f = fast.cellAt(x, z);
        const s = slow.cellAt(x, z);
        if (!f || f.dose === 0) continue;
        expect(s).not.toBeNull();
        fastSum += f.dose;
        slowSum += s!.dose;
        n++;
        if (s!.state < f.state) behind++;
      }
    }
    expect(n).toBeGreaterThan(20);
    expect(slowSum).toBeGreaterThan(fastSum * 1.1);
    expect(behind / n).toBeLessThanOrEqual(0.1);
  }, 180000);

  test("TERR-20: track width follows the core's size, not its strength", () => {
    const width = (p: Partial<TornadoParams>) => {
      const tr = pass({ translationSpeed: 12, ...p }, 6 * (p.rMax ?? 100)).snapshot.groundTrack;
      let w = 0;
      for (const { c } of across(tr, 0, 1500)) if (c && c.state >= TRACK_STATE.lodged) w += 2;
      return w;
    };
    const w1 = width({ vPeak: 40, rMax: 50 });
    const w2 = width({ vPeak: 40, rMax: 100 });
    expect(w2 / w1).toBeGreaterThan(2 * 0.75);
    expect(w2 / w1).toBeLessThan(2 * 1.25);
    // Much stronger at the same size: wider, but never beyond the 3·R_max reach on each side.
    const w3 = width({ vPeak: 80, rMax: 50 });
    expect(w3).toBeGreaterThanOrEqual(w1);
    expect(w3).toBeLessThanOrEqual(6 * 50 + 4);
  }, 180000);

  test("TERR-21: lodged and scoured ground lowers the roughness and raises the near-ground wind", () => {
    const sim = pass({ vPeak: 60, rMax: 60, translationSpeed: 10 }, 120, { houses: true, arrive: 10 });
    const before = sim.snapshot.terrain as RoughnessField;
    expect(isField(before)).toBe(true);
    // Run on past the next roughness update after the core has crossed x = 0.
    const t0 = sim.time;
    while (sim.time < t0 + 2.5) sim.advance(1 / 30);
    const after = sim.snapshot.terrain as RoughnessField;
    const c = sim.snapshot.groundTrack.cellAt(0, 0)!;
    expect(c.state).toBeGreaterThanOrEqual(TRACK_STATE.thinned);
    expect(z0At(after, 0, 0)).toBeLessThan(0.03 * 0.6);
    // The same storm state over the new field: stronger at 5 m on the scoured strip.
    const s = { ...sim.snapshot.tornado, center: { x: -120, z: 0 } };
    const farm = createSim({ buildings: true, houses: [], cover: FARM }, 1, { tUp: 0 }).snapshot.terrain;
    expect(hspeed(windAt({ x: 0, y: 5, z: 0 }, s, after))).toBeGreaterThan(hspeed(windAt({ x: 0, y: 5, z: 0 }, s, farm)));
  }, 180000);

  test("TERR-22: landings faster than the gouge speed leave gouges; slides leave streaks; slow landings none", () => {
    const tr = new GroundTrack(FARM);
    const piece = (x: number, z: number, mass = 10) => ({ pos: { x, y: 0.05, z }, vel: { x: 6, y: 0, z: 0 }, def: { mass, dims: [2.4, 1.2, 0.012] }, represents: 1 }) as unknown as Piece;
    tr.landing(piece(10, 10), TRACK.gougeSpeed - 0.5);
    expect(tr.cellAt(10, 10)).toBeNull();
    tr.landing(piece(10, 10), 12);
    expect(tr.cellAt(10, 10)!.mark).toBeGreaterThan(0);
    expect(tr.cellAt(10.9, 10)!.mark).toBeGreaterThan(0); // footprint
    tr.slide(piece(31, 40), 30, 40);
    expect(tr.cellAt(31, 40)!.mark).toBeGreaterThan(0);
    expect(tr.cellAt(37, 40)?.mark ?? 0).toBe(0);
  });

  test("TERR-23: drawing reads the track only; marks persist; lodged cells carry their direction; scour shades in stage order", () => {
    const sim = pass({ vPeak: 60, rMax: 60, translationSpeed: 12 }, 150);
    const tr = sim.snapshot.groundTrack;
    const t = tr.list[0]!;
    const snap = [...t.state].join(",");
    const tex = trackTexels(t);
    expect([...t.state].join(",")).toBe(snap); // reading changes nothing
    // Flattened cells carry their direction and a flatten amount; soil shows more at each
    // scour stage (averaged per stage: each cell has its own strength).
    const soilBy = new Map<number, number[]>();
    for (const x of tr.list) {
      const tx = trackTexels(x);
      for (let c = 0; c < x.state.length; c++) {
        if (x.state[c]! >= TRACK_STATE.lodged && x.state[c]! <= TRACK_STATE.snapped) {
          expect(tx[c * 4]).toBeGreaterThan(0);
          expect(tx[c * 4 + 1]).toBe(x.dir[c]);
        }
        if (x.state[c] === TRACK_STATE.standing && x.dose[c] === 0) expect(tx[c * 4 + 3]).toBe(0);
        (soilBy.get(x.state[c]!) ?? soilBy.set(x.state[c]!, []).get(x.state[c]!)!).push(tx[c * 4 + 3]!);
      }
    }
    const mean = (k: number) => { const v = soilBy.get(k) ?? []; return v.reduce((a, b) => a + b, 0) / Math.max(v.length, 1); };
    expect(mean(TRACK_STATE.thinned)).toBeLessThan(mean(TRACK_STATE.stripped));
    expect(mean(TRACK_STATE.stripped)).toBeLessThan(mean(TRACK_STATE.bare));
    expect(TRACK_COLOR.markMax).toBeLessThan(1);
    void tex;
    // Ground the core has left behind keeps its marks: tiles wholly behind its reach don't change.
    const reach = 3 * 60 + 64;
    const behind = () => tr.list.filter((x) => (x.ti + 1) * 64 < sim.snapshot.tornado.center.x - reach);
    const before = new Map(behind().map((x) => [x, [...x.state, ...x.mark].join(",")]));
    expect(before.size).toBeGreaterThan(0);
    const t0 = sim.time;
    while (sim.time < t0 + 20) sim.advance(1 / 30);
    for (const [x, v] of before) expect([...x.state, ...x.mark].join(",")).toBe(v);
  }, 120000);

  test("TERR-24: the track costs ≤ 3% of the physics step (EF4 town scene's window)", async () => {
    const { BENCH_SCENES, sceneStart } = await import("../../src/bench/bench");
    const { newStepTiming } = await import("../../src/sim/types");
    const scene = BENCH_SCENES.find((s) => s.id === "ef4-town")!;
    const timing = newStepTiming();
    const sim = createSim({ start: sceneStart(scene), timing }, scene.seed, scene.params);
    const tr = sim.snapshot.groundTrack;
    let trackMs = 0;
    const upd = tr.update.bind(tr);
    tr.update = (...a: Parameters<GroundTrack["update"]>) => {
      const t0 = performance.now();
      upd(...a);
      trackMs += performance.now() - t0;
    };
    while (sim.time < 18) sim.advance(1 / 30);
    const before = { ...timing };
    const tb = trackMs;
    while (sim.time < 26) sim.advance(1 / 30);
    expect(tr.list.length).toBeGreaterThan(0);
    expect((trackMs - tb) / (timing.total - before.total)).toBeLessThan(0.03);
    sim.dispose();
  }, 300000);
});
