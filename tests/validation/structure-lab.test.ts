/**
 * Spec 13 — Structure lab, full passes: zero pass-through (LAB-10), cost (LAB-11), debris
 * recording (LAB-13) and replay accuracy (LAB-14).
 */
import { beforeAll, describe, expect, test } from "vitest";
import { DEBRIS } from "../../src/config/debris";
import { SIM_DEFAULTS } from "../../src/config/sim";
import { DETAIL } from "../../src/config/structure";
import type { Piece } from "../../src/core/debris/piece";
import { createLocalBackend } from "../../src/sim/detailBackend";
import type { DetailBackend } from "../../src/sim/detailBackend";
import { frameOf, inCaptureBox } from "../../src/sim/debrisRecorder";
import { createLab } from "../../src/sim/lab";
import type { Lab, LabSetup, LabWind } from "../../src/sim/lab";
import { initRapier } from "../../src/sim/structureWorld";

beforeAll(async () => {
  await initRapier();
});

const ef3Hit: LabWind = { kind: "pass", presetId: "ef3-strong", headingDeg: 0, offset: 0, lifecycle: "mature" };
const setup = (p: Partial<LabSetup> = {}): LabSetup => ({ houses: 4, cls: "standard", surroundings: "neighborhood", seed: 3, donors: false, ...p });

/** Run until the tornado is `past` m beyond the block center (or the pass ends). */
async function runPast(lab: Lab, past: number): Promise<void> {
  const s0 = lab.sim.snapshot.tornado;
  const v = Math.hypot(s0.velocity.x, s0.velocity.z);
  const toCenter = Math.hypot(s0.center.x, s0.center.z);
  const end = Math.min((toCenter + past) / v, lab.sim.snapshot.lifetime);
  let last = performance.now();
  while (lab.sim.time < end - 1e-9) {
    lab.advance(0.25);
    if (performance.now() - last > 1000) {
      await new Promise((r) => setImmediate(r));
      last = performance.now();
    }
  }
}

describe("Spec 13 lab: full passes", () => {
  test("LAB-10: zero pass-through in an EF3 direct hit on 4 houses in a neighborhood", async () => {
    const lab = await createLab(setup(), ef3Hit);
    await runPast(lab, 1.5 * 170);
    const r = lab.record();
    console.log(`LAB-10: ${r.checks.debrisSteps} debris steps, ${r.checks.observed} piece-steps checked, ${r.passThrough.total} crossings`, JSON.stringify(r.passThrough.examples.slice(0, 3)));
    expect(r.checks.debrisSteps).toBeGreaterThan(1000);
    expect(r.checks.observed).toBeGreaterThan(100000);
    expect(r.passThrough.total).toBe(0);
    lab.dispose();
  }, 1800000);

  test("LAB-11: the costliest second of an EF3 direct hit runs at ≥ 0.5× real time with 4 lab houses and ≥ 0.25× with 12", async () => {
    // In the worker setup the detail engine runs beside the sim, so a second of sim takes as long
    // as the engine's costliest physics group needs for that second (the lab is one group).
    for (const [n, floor] of [[4, 0.5], [12, 0.25]] as const) {
      const perStep: { t: number; ms: number }[] = [];
      const make = (_s: number, b: Parameters<typeof createLocalBackend>[0]): DetailBackend => {
        const be = createLocalBackend(b, 1);
        const drain = be.drain.bind(be);
        be.drain = () => {
          const rs = drain();
          for (const x of rs) perStep.push({ t: x.n * DETAIL.stepEvery * SIM_DEFAULTS.dt, ms: x.groupMs });
          return rs;
        };
        return be;
      };
      const lab = await createLab(setup({ houses: n }), ef3Hit, { detail: make, passThrough: false });
      await runPast(lab, 1.5 * 170);
      const bySecond = new Map<number, number>();
      for (const p of perStep) bySecond.set(Math.floor(p.t), (bySecond.get(Math.floor(p.t)) ?? 0) + p.ms);
      const worst = Math.max(...bySecond.values());
      const speed = 1000 / worst;
      console.log(`LAB-11: ${n} houses, costliest second ${worst.toFixed(0)} ms of physics → ${speed.toFixed(2)}× real time`);
      expect(speed).toBeGreaterThanOrEqual(floor);
      lab.dispose();
    }
  }, 1800000);

  test("LAB-13: every piece entering the capture box from outside is recorded once, in the target's frame, with its wind, seed and version", async () => {
    const lab = await createLab(setup({ houses: 1, model: "component" }), ef3Hit, { passThrough: false });
    const target = lab.block[0]!;
    const b = lab.sim.world.buildings[target]!;
    const rec = lab.recordDebris(target);
    // An independent tally from the debris field itself.
    const f = frameOf(b);
    const state = new Map<Piece, { inside: boolean; excluded: boolean; crossed: number }>();
    const expected: { t: number; pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number }; kind: string }[] = [];
    const debrisDt = SIM_DEFAULTS.dt * DEBRIS.stepInterval;
    lab.sim.observe({
      impact: (house, _q, _path, p) => {
        const s = p && state.get(p);
        if (house === target && s && s.crossed === 0) s.excluded = true;
      },
      debrisStep: (time) => {
        for (const p of lab.sim.debris.pieces) {
          if (!p || p.hidden) continue;
          const l = f.toLocal(p.pos);
          const now = inCaptureBox(b, l);
          const s = state.get(p);
          if (!s) {
            // Neighbors' pieces born inside count where first seen; the target's own never.
            const own = p.sourceId === b.id;
            state.set(p, { inside: now, excluded: own, crossed: 0 });
            if (now && !own) {
              state.get(p)!.crossed = 1;
              expected.push({ t: time + debrisDt, pos: l, vel: f.dirToLocal(p.vel), kind: p.kind });
            }
            continue;
          }
          if (!s.inside && now && !s.excluded && s.crossed === 0) {
            s.crossed++;
            expected.push({ t: time + debrisDt, pos: l, vel: f.dirToLocal(p.vel), kind: p.kind });
          }
          s.inside = now;
        }
      },
    });
    await runPast(lab, 1.5 * 170);
    const out = rec.stop();
    console.log(`LAB-13: ${out.pieces.length} pieces recorded`);
    expect(out.pieces.length).toBeGreaterThan(20);
    expect(out.pieces.length).toBe(expected.length);
    const key = (x: { t: number; pos: { x: number } }) => `${x.t.toFixed(6)}:${x.pos.x.toFixed(6)}`;
    const want = [...expected].sort((a, c) => key(a).localeCompare(key(c)));
    const got = [...out.pieces].sort((a, c) => key(a).localeCompare(key(c)));
    got.forEach((p, i) => {
      const e = want[i]!;
      expect(p.t).toBeCloseTo(e.t, 9);
      expect(p.kind).toBe(e.kind);
      for (const k of ["x", "y", "z"] as const) {
        expect(p.pos[k]).toBeCloseTo(e.pos[k], 9);
        expect(p.vel[k]).toBeCloseTo(e.vel[k], 9);
      }
      // Outside the box one step before, inside now: crossing pieces only.
      expect(inCaptureBox(b, p.pos)).toBe(true);
    });
    // None from the target itself.
    expect(out.wind.kind).toBe("pass");
    expect(out.seed).toBe(3);
    expect(out.version).toBe(1);
    expect(out.target.width).toBe(b.width);
    lab.dispose();
  }, 1800000);

  test("LAB-14: a replay onto the same house, in the recorded wind with dispersion off, gives each airborne piece the same first impact; with dispersion on, the pieces reaching the house and their first-hit speed within ±10% over three passes", async () => {
    const streamWind: LabWind = { kind: "steady", keys: [{ t: 0, mph: 100, dirDeg: 0 }] };
    const recordRun = async (dispersion: boolean, wind: LabWind = ef3Hit, seed = 3) => {
      const lab = await createLab(setup({ houses: 1, model: "component", dispersion, seed, ...(wind === streamWind ? { surroundings: "open" } : {}) }), wind, { passThrough: false });
      // In steady wind: an ambient stream of pieces from upwind (Spec 13), so most arrive airborne.

      const target = lab.block[0]!;
      const rec = lab.recordDebris(target);
      // Each recorded piece's first impact on the target, by its index in the recording.
      const first = new Map<Piece, string>();
      const firstVn = new Map<Piece, number>();
      const all: { vn: number }[] = [];
      const allPieces: { vn: number; p: Piece }[] = [];
      /** Last debris step each piece lay on the ground before its first hit on the target. */
      const lastGround = new Map<Piece, number>();
      const hitOther = new Set<Piece>();
      lab.sim.observe({
        debrisStep: (time) => {
          for (const p of lab.sim.debris.pieces) if (p && p.grounded && !first.has(p)) lastGround.set(p, time);
        },
        impact: (house, q, _path, p, time) => {
          if (!p) return;
          // A neighbor hit on the way: the replay has no neighbors.
          if (house !== target) {
            if (!first.has(p)) hitOther.add(p);
            return;
          }
          if (!first.has(p)) (first.set(p, `${q.surface}#${q.index}@${Math.round(time * 60)}`), firstVn.set(p, q.missile.speed));
          all.push({ vn: q.missile.speed });
          allPieces.push({ vn: q.missile.speed, p });
        },
      });
      if (wind === streamWind) {
        lab.stream({ kind: "stud", rate: 6, face: "windward" });
        lab.advance(4);
        lab.stream({ kind: "shingle", rate: 6, face: "windward" });
        lab.advance(4);
        lab.stream(null);
        lab.advance(2);
      }
      else await runPast(lab, 1.5 * 170);
      const out = rec.stop();
      const recorded = new Set(rec.sources);
      const allBy = allPieces.map((x) => ({ vn: x.vn, recorded: recorded.has(x.p) }));
      lab.dispose();
      return { out, first, firstVn, all, allBy, sources: rec.sources, lastGround, hitOther };
    };
    const replayRun = async (recording: Awaited<ReturnType<typeof recordRun>>["out"], dispersion: boolean, seed = 3) => {
      const lab = await createLab(setup({ houses: 1, model: "component", dispersion, seed }), ef3Hit, { passThrough: false, replay: { recording, house: 0, wind: "recorded" } });
      const seconds = recording.seconds;
      const firstByLaunch = new Map<number, string>();
      const firstVn = new Map<number, number>();
      const all: { vn: number }[] = [];
      const launchOf = new Map<Piece, number>();
      lab.sim.observe({
        impact: (house, q, _path, p, time) => {
          if (house !== 0 || !p) return;
          if (!launchOf.size) for (const l of lab.launcher.launched) if (l.piece) launchOf.set(l.piece, l.i);
          let i = launchOf.get(p);
          if (i === undefined) {
            for (const l of lab.launcher.launched) if (l.piece) launchOf.set(l.piece, l.i);
            i = launchOf.get(p);
          }
          if (i === undefined) return; // the house's own debris
          if (!firstByLaunch.has(i)) (firstByLaunch.set(i, `${q.surface}#${q.index}@${Math.round(time * 60)}`), firstVn.set(i, q.missile.speed));
          all.push({ vn: q.missile.speed });
        },
      });
      lab.advance(seconds);
      lab.dispose();
      return { firstByLaunch, firstVn, all };
    };

    // Dispersion off: each recorded piece's first hit on the house is the same in the replay.
    const a = await recordRun(false, streamWind);
    expect(a.out.pieces.length).toBeGreaterThan(40);
    const b = await replayRun(a.out, false);
    let hits = 0;
    let airborne = 0;
    const diffs: string[] = [];
    const debrisDt = SIM_DEFAULTS.dt * DEBRIS.stepInterval;
    a.out.pieces.forEach((rp, k) => {
      const src = a.sources[k];
      // Only a path that stays off the ground replays exactly: landing draws from the shared
      // stream (snagging, bumps), Spec 13.
      const g = src ? a.lastGround.get(src) : undefined;
      if (!src || (g !== undefined && g >= rp.t - debrisDt - 1e-9)) return;
      // Heavy pieces fly in the rigid-body engine; a piece that hit a neighbor first met
      // something the replay doesn't have.
      if (rp.heavy || src.rigid || a.hitOther.has(src)) return;
      airborne++;
      const orig = a.first.get(src);
      const rep = b.firstByLaunch.get(k);
      if (orig || rep) hits++;
      if (orig !== rep) diffs.push(`#${k} ${a.out.pieces[k]!.kind}: ${orig} vs ${rep}`);
    });
    console.log(`LAB-14: ${a.out.pieces.length} recorded, ${airborne} stay off the ground, ${hits} of those hit the house; ${diffs.length} differ`, diffs.slice(0, 8));
    expect(hits).toBeGreaterThan(20);
    expect(diffs).toEqual([]);

    // Dispersion on, over a town pass (three seeds): the recorded pieces that reach the house
    // and their first-hit normal speed. (Raw impact counts are dominated by a few strips pressed
    // against a wall, an impact every step for each represented copy: not a measure of arrival.)
    let nRec = 0;
    let nRep = 0;
    let vRec = 0;
    let vRep = 0;
    for (const seed of [3, 5, 7]) {
      const c = await recordRun(true, ef3Hit, seed);
      const d = await replayRun(c.out, true, seed);
      c.out.pieces.forEach((_p, k) => {
        const src = c.sources[k];
        const v = src ? c.firstVn.get(src) : undefined;
        if (v !== undefined) (nRec++, (vRec += v));
        const w = d.firstVn.get(k);
        if (w !== undefined) (nRep++, (vRep += w));
      });
    }
    console.log(`LAB-14 dispersion on: ${nRec} vs ${nRep} recorded pieces hit; mean first vn ${(vRec / nRec).toFixed(2)} vs ${(vRep / nRep).toFixed(2)} m/s`);
    expect(nRec).toBeGreaterThan(60);
    expect(Math.abs(nRep / nRec - 1)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(vRep / nRep / (vRec / nRec) - 1)).toBeLessThanOrEqual(0.1);
  }, 3600000);
});

