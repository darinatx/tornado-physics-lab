/**
 * Phase 8 validation (slice E, check 3): what the storm report's impact counts are made of.
 * The EF4 town pass (the bench scene, as `storm-survey.ts` runs it) with the storm recorder on
 * and a second observer on the same impact tap that keeps, per piece:
 *   - impact events (each `onImpact`), and the debris steps they came in (an event and its
 *     representative copies share a step);
 *   - contact episodes: runs of consecutive debris steps with a contact on the same house;
 *   - the normal approach speed (vn) of each event, and whether the piece was on the ground
 *     (grounded: sliding or pinned) when it hit;
 *   - what the event did (window broken, wall perforated, siding or covering torn);
 *   - presses (Spec 10 v0.18, BL-031): contacts in a sustained episode, not resolved as impacts.
 *     They count as contact steps, so a pinned piece is still found as one after the fix.
 * Compares the totals with the recorder's tally and the sim's own counter (debris.stats.impacts).
 *   npx tsx scripts/impact-episodes.ts [--seed N] [--s 50]
 */
import { BENCH_SCENES, sceneStart } from "../src/bench/bench";
import { createSim } from "../src/sim/loop";
import { StormRecorder } from "../src/sim/stormRecord";
import { initRapier } from "../src/sim/structureWorld";

await initRapier();
const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const seed = Number(opt("--seed") ?? 1);
const S = Number(opt("--s") ?? 50);
const scene = BENCH_SCENES.find((s) => s.id === "ef4-town")!;
const sim = createSim({ start: sceneStart(scene) }, seed, scene.params);
const rec = new StormRecorder(sim);

interface Per {
  events: number;
  steps: number;
  episodes: number;
  lastStep: number;
  lastHouse: number;
  grounded: number;
  effective: number;
  represents: number;
  houses: Set<number>;
  switches: number;
  sumY: number;
  sumSpeed: number;
  kind: string;
  /** Effective events after its first 100 contact steps (a piece long in contact). */
  lateEffective: number;
  presses: number;
}
const per = new Map<number, Per>();
const vnBins = [0.25, 0.5, 1, 2, 5, 10, 20, 40, Infinity];
const vnHist = new Array<number>(vnBins.length).fill(0);
const vnHistGround = new Array<number>(vnBins.length).fill(0);
let events = 0, nullPiece = 0, effective = 0, groundedEvents = 0, slow = 0;
const bySurface: Record<string, number> = {};
let stepNo = 0;
let presses = 0;
type P = { id: number; represents: number; def: { label: string } };
const entry = (piece: P): Per => {
  let e = per.get(piece.id);
  if (!e) per.set(piece.id, (e = { events: 0, steps: 0, episodes: 0, lastStep: -10, lastHouse: -2, grounded: 0, effective: 0, represents: piece.represents, houses: new Set(), switches: 0, sumY: 0, sumSpeed: 0, kind: piece.def.label, lateEffective: 0, presses: 0 }));
  return e;
};
// Presses (Spec 10 v0.18): absent before the fix (the field has no such hook there).
const field = sim.debris as unknown as { onPress?: ((b: { id: number; standInFor?: number }, p: P) => void) | null };
// Built on first use: the town exists once the sim has run its first step.
let indexOf: Map<number, number> | null = null;
if ("onPress" in field)
  field.onPress = (b, piece) => {
    presses++;
    indexOf ??= new Map(sim.world.buildings.map((x, i) => [x.id, i]));
    const house = indexOf.get(b.standInFor ?? b.id) ?? -1;
    const e = entry(piece);
    e.presses++;
    if (e.lastStep !== stepNo) {
      e.steps++;
      if (!(e.lastHouse === house && stepNo - e.lastStep <= 3)) e.episodes++;
    }
    e.lastStep = stepNo;
    e.lastHouse = house;
  };
sim.observe({
  step: () => stepNo++,
  impact: (house, q, _path, piece) => {
    events++;
    bySurface[q.surface] = (bySurface[q.surface] ?? 0) + 1;
    const did = q.broke || q.perforated || q.sidingTorn || q.coverTorn;
    if (did) effective++;
    const vn = q.missile?.speed ?? 0;
    if (vn < 1) slow++;
    const bin = vnBins.findIndex((b) => vn < b);
    vnHist[bin]!++;
    if (!piece) {
      nullPiece++;
      return;
    }
    if (piece.grounded) {
      groundedEvents++;
      vnHistGround[bin]!++;
    }
    const e = entry(piece);
    e.events++;
    if (did) e.effective++;
    if (did && e.steps >= 100) e.lateEffective++;
    if (piece.grounded) e.grounded++;
    if (e.lastStep !== stepNo) {
      e.steps++;
      // A new episode unless it touched the same house within the last 3 physics steps
      // (debris steps can skip a step far from the core, Spec 04 v2.2).
      if (!(e.lastHouse === house && stepNo - e.lastStep <= 3)) e.episodes++;
    }
    if (e.lastHouse !== house && e.lastHouse !== -2) e.switches++;
    e.houses.add(house);
    e.sumY += piece.pos.y;
    e.sumSpeed += Math.hypot(piece.vel.x, piece.vel.y, piece.vel.z);
    e.lastStep = stepNo;
    e.lastHouse = house;
  },
});

while (sim.time < S - 1e-9) sim.advance(Math.min(1 / 60, S - sim.time));
const record = rec.record();
const recorded = Object.values(record.debris.impacts.bySurface).reduce((n, t) => n + t.hits, 0);
const launched = record.debris.pieces.length;
const list = [...per.values()];
const sum = (f: (p: Per) => number) => list.reduce((s, p) => s + f(p), 0);
const sorted = list.map((p) => p.events).sort((a, b) => a - b);
const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] ?? 0;
const top = [...list].sort((a, b) => b.events - a.events).slice(0, 8);
// Pieces with many contact steps: how many bounce between two or more houses (switching back and forth).
const heavyHitters = list.filter((p) => p.steps >= 100);
const multi = heavyHitters.filter((p) => p.switches >= 20);
const steps = sum((p) => p.steps);
const episodes = sum((p) => p.episodes);

console.log(JSON.stringify({
  seed, simS: S, launched,
  counters: { tap: events, recorder: recorded, sim: sim.debris.stats.impacts, heavyOrDetail: nullPiece },
  perLaunched: +(events / Math.max(1, launched)).toFixed(1),
  piecesThatHit: list.length,
  perHitter: { median: q(0.5), p90: q(0.9), p99: q(0.99), max: sorted[sorted.length - 1] ?? 0 },
  stepsWithContact: steps,
  presses,
  eventsPerContactStep: +(sum((p) => p.events) / Math.max(1, steps)).toFixed(1),
  meanRepresents: +(sum((p) => p.represents) / Math.max(1, list.length)).toFixed(1),
  episodes,
  stepsPerEpisode: +(steps / Math.max(1, episodes)).toFixed(1),
  eventsPerEpisode: +(sum((p) => p.events) / Math.max(1, episodes)).toFixed(1),
  grounded: { events: groundedEvents, share: +(groundedEvents / Math.max(1, events)).toFixed(3) },
  effective: { events: effective, share: +(effective / Math.max(1, events)).toFixed(4) },
  vnUnder1: { events: slow, share: +(slow / Math.max(1, events)).toFixed(3) },
  vnHist: Object.fromEntries(vnBins.map((b, i) => [`<${b}`, vnHist[i]])),
  vnHistGrounded: Object.fromEntries(vnBins.map((b, i) => [`<${b}`, vnHistGround[i]])),
  bySurface,
  repeatHitters: { steps100: heavyHitters.length, events: heavyHitters.reduce((s, p) => s + p.events, 0), effective: heavyHitters.reduce((s, p) => s + p.effective, 0), effectiveAfterStep100: heavyHitters.reduce((s, p) => s + p.lateEffective, 0), share: +(heavyHitters.reduce((s, p) => s + p.events, 0) / Math.max(1, events)).toFixed(3), switching20: multi.length, switchingEvents: multi.reduce((s, p) => s + p.events, 0) },
  top: top.map((p) => ({ kind: p.kind, houses: p.houses.size, switches: p.switches, meanY: +(p.sumY / p.events).toFixed(2), meanSpeed: +(p.sumSpeed / p.events).toFixed(2), events: p.events, steps: p.steps, episodes: p.episodes, grounded: p.grounded, effective: p.effective, presses: p.presses, represents: p.represents })),
}));
sim.dispose();
process.exit(0);
