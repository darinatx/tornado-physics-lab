import { beforeAll, describe, expect, test } from "vitest";
import { DETAIL } from "../../src/config/structure";
import type { ConstructionClass } from "../../src/config/buildings";
import type { Building } from "../../src/core/damage/types";
import { buildFraming, floorPlan } from "../../src/core/structure/framing";
import { solveLoadPath } from "../../src/core/structure/loadpath";
import { removedOnEntry, roofSectionOf, surveyDetail } from "../../src/core/structure/survey";
import type { TornadoState } from "../../src/core/wind/types";
import { mphToMs } from "../../src/core/wind/efScale";
import { ZoneSelector } from "../../src/sim/detailZone";
import { initRapier, StructureWorld } from "../../src/sim/structureWorld";
import type { WindSource } from "../../src/sim/structureWorld";
import { exactHouse } from "../houseHelpers";

const fail = {} as never; // a failure record: only its presence matters here

function tornado(cx: number, vMax = 70, rMax = 100, vx = 20): TornadoState {
  return {
    center: { x: cx, z: 0 },
    velocity: { x: vx, z: 0 },
    vMax,
    rMax,
    alpha: 0.6,
    inflowRatio: 0.5,
    inflowDepth: 50,
    updraftMax: 20,
    overshoot: 1.3,
    zPeak: 50,
    rotation: 1,
  };
}

/** Houses every 10 m along the x axis. */
function row(n: number, x0 = -2000): Building[] {
  return Array.from({ length: n }, (_, i) => ({ x: x0 + i * 10, z: 0 }) as Building);
}

const steady = (mph: number, dirDeg = 0): WindSource => {
  const u = mphToMs(mph);
  const a = (dirDeg * Math.PI) / 180;
  return { at: () => ({ x: u * Math.cos(a), y: 0, z: -u * Math.sin(a) }), deficit: () => 0 };
};

beforeAll(async () => {
  await initRapier();
});

describe("Spec 09 slice B — detail zone", () => {
  test("STR-13: the houses around the chosen spot enter as the tornado nears, and leave for good once it has passed", () => {
    const houses = row(400);
    const focus = { x: 0, z: 0 };
    const chosen = new Set(
      houses
        .map((b, i) => [Math.abs(b.x), i] as const)
        .sort((p, q) => p[0] - q[0] || p[1] - q[1])
        .slice(0, DETAIL.maxHouses)
        .map(([, i]) => i),
    );
    const run = () => {
      const sel = new ZoneSelector();
      const hist: string[] = [];
      const entered = new Set<number>();
      for (let x = -1500; x < 1200; x += 10) {
        const s = tornado(x);
        const o = sel.update(s, houses, focus);
        hist.push(JSON.stringify(o));
        expect(o.enter.length).toBeLessThanOrEqual(DETAIL.maxEnterPerStep);
        expect(sel.active.size).toBeLessThanOrEqual(DETAIL.maxHouses);
        const enterR = DETAIL.enterRmax * s.rMax + DETAIL.enterLeadS * 20;
        for (const i of o.enter) {
          expect(chosen.has(i)).toBe(true); // only houses around the spot
          expect(Math.abs(houses[i]!.x - x)).toBeLessThan(enterR); // the tornado is near
          expect(entered.has(i)).toBe(false); // never re-enters
          entered.add(i);
        }
        // Nearest the tornado first.
        for (let k = 1; k < o.enter.length; k++) expect(Math.abs(houses[o.enter[k]!]!.x - x)).toBeGreaterThanOrEqual(Math.abs(houses[o.enter[k - 1]!]!.x - x));
        for (const i of o.exit) {
          const d = houses[i]!.x - x;
          expect(d < 0 && Math.abs(d) > DETAIL.exitRmax * s.rMax).toBe(true);
        }
      }
      expect(entered).toEqual(chosen); // every chosen house was detailed
      expect(sel.active.size).toBe(0); // and all left once the tornado passed
      return hist;
    };
    // Deterministic: the same tornado history gives the same zone history.
    expect(run()).toEqual(run());
    // No spot: no detail. Dissipated: everything leaves.
    expect(new ZoneSelector().update(tornado(0), houses, null).enter).toEqual([]);
    const sel = new ZoneSelector();
    for (let k = 0; k < 20; k++) sel.update(tornado(-100), houses, focus);
    expect(sel.active.size).toBeGreaterThan(0);
    sel.update(tornado(-100, 0), houses, focus);
    expect(sel.active.size).toBe(0);
  });

  test("STR-14: hand-off removes exactly the members of failed components", () => {
    const b = exactHouse();
    const f = buildFraming(b);
    expect(removedOnEntry(b, f).some(Boolean)).toBe(false); // undamaged: complete
    const d = exactHouse();
    d.panels[1]!.failed = fail;
    d.siding[4]!.failed = fail;
    const pane = d.panes[0]!;
    pane.failed = fail;
    const sec = d.sections[0]!;
    sec.cover = fail;
    d.coreRoom.failed = fail;
    const gone = removedOnEntry(d, f);
    const plan = floorPlan(d);
    for (const m of f.members) {
      let expected = false;
      if (m.panel === 1 && m.kind !== "sillPlate") expected = true; // the sill plate stays bolted down
      if (m.panel === 4 && m.kind === "siding") expected = true;
      if (m.panel === pane.panel && m.kind === "pane") expected = true;
      if (m.kind === "roofShingle") {
        const at = roofSectionOf(d, m);
        if (at.col === sec.col && at.slope === sec.slope && at.row === sec.row) expected = true;
      }
      if (m.wall !== undefined && plan[m.wall]!.core) expected = true;
      expect(gone[m.id], `${m.kind} ${m.id}`).toBe(expected);
    }
    // A swept slab enters empty.
    d.sweep.failed = fail;
    expect(removedOnEntry(d, f).every(Boolean)).toBe(true);
  });

  test("STR-14: the detailed house starts without the removed members; the rest stands or falls", () => {
    const d = exactHouse();
    d.siding[0]!.failed = fail;
    const f = buildFraming(d);
    const gone = removedOnEntry(d, f);
    const sw = new StructureWorld();
    const h = sw.addHouse(d, gone);
    for (const m of f.members) {
      if (gone[m.id]) {
        expect(h.lost[m.id]).toBe(true);
        expect(h.isAttached(m.id)).toBe(false);
      } else expect(h.isAttached(m.id)).toBe(true);
    }
    sw.dispose();
  });

  test("STR-15: envelope APC push rises as the deficit arrives, then vents; loose members feel the wind where they are", () => {
    const sw = new StructureWorld();
    const h = sw.addHouse(exactHouse());
    let deficit = 0;
    const asked: number[] = [];
    const src: WindSource = {
      at: (p) => {
        asked.push(p.y);
        return { x: 0, y: 0, z: 0 };
      },
      deficit: () => deficit,
    };
    for (let i = 0; i < 3; i++) sw.step(src); // starts in equilibrium with no deficit
    deficit = 400; // a sudden drop, below what the weakest connection needs: the house stays sealed
    for (let i = 0; i < 6; i++) sw.step(src); // 0.1 s: barely vented (sealed τ = 2 s)
    const early = h.apc;
    expect(early).toBeGreaterThan(350);
    expect(h.failures.length).toBe(0);
    for (let i = 0; i < 60 * 4; i++) sw.step(src);
    expect(h.apc).toBeLessThan(early * 0.2); // vented
    expect(h.apc).toBeGreaterThan(0);
    // A loose member: wind is sampled at its own height, not just at the roof.
    h.addContact(h.framing.members.find((m) => m.kind === "roofShingle")!.id, 0, 1e5, 0);
    asked.length = 0;
    for (let i = 0; i < 3; i++) sw.step({ ...src, at: (p) => (asked.push(p.y), { x: 1, y: 0, z: 0 }) });
    expect(asked.some((y) => Math.abs(y - h.building.roofHeight) > 0.05)).toBe(true);
    sw.dispose();
  });

  test("STR-16: survey DOD follows the member table", () => {
    const b = exactHouse();
    const f = buildFraming(b);
    const plan = floorPlan(b);
    const intact = f.connections.map(() => true);
    const att = () => f.members.map(() => true);
    const pos = (id: number) => f.members[id]!.pos;
    const lose = (a: boolean[], pred: (m: (typeof f.members)[number]) => boolean, share = 1) => {
      const ids = f.members.filter(pred).map((m) => m.id);
      for (const id of ids.slice(0, Math.ceil(ids.length * share))) a[id] = false;
      return a;
    };
    const dod = (a: boolean[], i = intact, p: (id: number) => typeof f.members[0]["pos"] | null = pos) => surveyDetail(b, f, a, i, p);
    expect(dod(att())).toBe(0);
    expect(dod(lose(att(), (m) => m.kind === "wallSheet", 0.01))).toBe(1);
    expect(dod(lose(att(), (m) => m.kind === "roofShingle", 0.01))).toBe(2);
    expect(dod(lose(att(), (m) => m.kind === "pane", 0.01))).toBe(3);
    expect(dod(lose(att(), (m) => m.kind === "roofShingle", 0.2))).toBe(4);
    expect(dod(lose(att(), (m) => m.kind === "garageDoor"))).toBe(4);
    // DOD 5 (shifted house) isn't represented: lost anchorage alone doesn't raise the survey.
    const anchor = f.connections.find((c) => c.to === -1 && f.members[c.from]!.kind === "sillPlate")!;
    expect(dod(att(), intact.map((_, i) => i !== anchor.id))).toBe(0);
    expect(dod(lose(att(), (m) => m.kind === "rafterPair", 0.34))).toBe(6);
    expect(dod(lose(att(), (m) => m.kind === "wallFrame", 0.5))).toBe(7);
    const eight = lose(lose(att(), (m) => m.kind === "wallFrame", 0.75), (m) => m.kind === "partition" && !plan[m.wall!]!.core);
    expect(dod(eight)).toBe(8);
    expect(dod(lose(lose(att(), (m) => m.kind === "wallFrame"), (m) => m.kind === "partition"))).toBe(9);
    const none = f.members.map(() => false);
    expect(dod(none, intact, () => ({ x: 0, y: 0.5, z: 0 }))).toBe(9); // debris still on the slab
    expect(dod(none, intact, () => null)).toBe(10);
    // Sill plates still bolted down don't stop a slab from being swept clean.
    const sills = f.members.map((m) => m.kind === "sillPlate");
    expect(dod(sills, intact, (id) => (sills[id] ? f.members[id]!.pos : null))).toBe(10);
  });

  test("STR-17: a loose member from one house hits the next house and loads its connections", () => {
    const sw = new StructureWorld();
    const a = sw.addHouse(exactHouse());
    const nb = exactHouse();
    const b = sw.addHouse({ ...nb, x: 16 } as Building);
    // Wind only over house A, blowing toward B: anything touching B came from A.
    const src: WindSource = { at: (p) => (p.x < 8 ? { x: mphToMs(160), y: 0, z: 0 } : { x: 0, y: 0, z: 0 }), deficit: () => 0 };
    let hits = 0;
    const orig = b.addContact.bind(b);
    b.addContact = (id, x, y, z) => {
      if (b.isAttached(id)) hits++;
      orig(id, x, y, z);
    };
    for (let i = 0; i < 60 * 8 && hits === 0; i++) sw.step(src);
    expect(a.failures.length).toBeGreaterThan(0);
    expect(hits).toBeGreaterThan(0);
    sw.dispose();
  }, 120000);

  test("STR-19: below 35 mph with small APC nothing can fail, so skipping the solve changes nothing", () => {
    for (const cls of ["weak", "standard", "strong"] as ConstructionClass[]) {
      const b = { ...exactHouse(), cls } as Building;
      const sw = new StructureWorld();
      const h = sw.addHouse(b);
      for (let dir = 0; dir < 360; dir += 15) {
        const a = (dir * Math.PI) / 180;
        // This house's own calm threshold (its weakest connection after the variability).
        const u = mphToMs(DETAIL.calmMph * Math.sqrt(Math.min(1, h.framing.weakest)));
        const w = { x: u * Math.cos(a), y: 0, z: -u * Math.sin(a) };
        const ids = h.framing.members.map((m) => m.id);
        for (const local of [true, false]) {
          const res = solveLoadPath(h.framing, h.attachedForces(local, w, DETAIL.calmApcPa * h.framing.weakest), h.intact, ids, true);
          const relevant = res.failed.filter((c) => !!h.framing.connections[c]!.cladding === local);
          expect(relevant, `${cls} ${dir}°`).toEqual([]);
        }
      }
      sw.step(steady(DETAIL.calmMph * Math.sqrt(Math.min(1, h.framing.weakest)) - 1));
      expect(h.calmSkipped).toBe(true);
      sw.step(steady(DETAIL.calmMph + 10));
      expect(h.calmSkipped).toBe(false);
      sw.dispose();
    }
  });

  test("STR-20: light members hand off to the debris model without a jump; a torn-apart house keeps few rigid bodies", () => {
    const sw = new StructureWorld();
    const h = sw.addHouse(exactHouse());
    let src = steady(150, 30);
    let checked = 0;
    for (let i = 0; i < 60 * 12; i++) {
      if (i === 60 * 6) src = steady(0); // the tornado has passed
      // Members about to hand off: single-member light bodies.
      const before = new Map<number, { p: ReturnType<typeof h.memberPose>; v: { x: number; y: number; z: number }; w: number }>();
      for (const [handle, g] of h.groupBodies) {
        if (g.length !== 1) continue;
        const body = sw.world.getRigidBody(handle);
        const w = body.angvel();
        before.set(g[0]!, { p: h.memberPose(g[0]!), v: body.linvel(), w: Math.hypot(w.x, w.y, w.z) });
      }
      const lightBefore = new Set(h.light.keys());
      sw.step(src);
      for (const [id, { piece }] of h.light) {
        if (lightBefore.has(id) || !before.has(id)) continue;
        // Just handed off: one step's motion from where it was, same orientation, same speed.
        // (Small pieces near the ground may be laid flat: barely visible, and allowed.)
        if (piece.def.dims[0] < DETAIL.smallPieceM && piece.grounded) continue;
        // (A piece whose first step ran into something fixed was stopped there: a collision,
        // not the hand-off — Spec 10 v0.6.)
        if (piece.blocked) continue;
        const b = before.get(id)!;
        const a = h.memberPose(id);
        const dt = 1 / 60;
        const jump = Math.hypot(a.pos.x - b.p.pos.x - b.v.x * dt, a.pos.y - b.p.pos.y - b.v.y * dt, a.pos.z - b.p.pos.z - b.v.z * dt);
        // Allow one step of drag and gravity acceleration (semi-implicit: a·dt²).
        const vrel = mphToMs(150) + Math.hypot(b.v.x, b.v.y, b.v.z);
        const acc = (0.5 * 1.2 * piece.def.cda * vrel * vrel) / piece.def.mass + 9.81;
        expect(jump, `member ${id}`).toBeLessThan(0.02 + acc * dt * dt + b.w * dt * piece.def.dims[0]);
        // Turned by no more than its own spin (as a body, or tumbling on the debris model).
        const dot = Math.min(1, Math.abs(a.q.reduce((s2, v, k) => s2 + v * b.p.q[k]!, 0)));
        const tumble = (0.6 * (mphToMs(150) + Math.hypot(b.v.x, b.v.y, b.v.z))) / piece.def.dims[0];
        expect(2 * Math.acos(dot)).toBeLessThan((b.w + tumble) * dt + 0.02);
        // Its new velocity is the body's, up to one step of acceleration (or zero at rest).
        if (!piece.resting) expect(Math.hypot(piece.vel.x - b.v.x, piece.vel.z - b.v.z)).toBeLessThan(acc * dt + b.w * piece.def.dims[0] + 0.5);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(h.failures.length).toBeGreaterThan(200); // torn apart
    expect(h.groupBodies.size).toBeLessThan(60); // once the wind has passed
    sw.dispose();
  }, 300000);
  test("IMP-21: glass in a detailed house breaks by impact momentum above its threshold, whole pane at once", async () => {
    const { glassThreshold } = await import("../../src/core/impact/impact");
    const sw = new StructureWorld();
    const b = exactHouse();
    const h = sw.addHouse(b);
    const shard = h.framing.members.find((m) => m.kind === "pane")!;
    const paneIdx = b.panes.findIndex((q) => q.panel === shard.panel);
    const th = glassThreshold(b, paneIdx, "compact");
    const shards = h.framing.members.filter((m) => m.kind === "pane" && m.pane === shard.pane);
    expect(h.hitGlass(shard.id, th * 0.98, "compact")).toBe(false);
    expect(shards.every((m) => h.isAttached(m.id))).toBe(true);
    expect(h.hitGlass(shard.id, th * 1.02, "compact")).toBe(true);
    expect(shards.every((m) => !h.isAttached(m.id))).toBe(true);
    // Other panes are untouched.
    expect(h.framing.members.filter((m) => m.kind === "pane" && m.pane !== shard.pane).every((m) => h.isAttached(m.id))).toBe(true);
    sw.dispose();
  });
  test("IMP-20: town debris on a detailed house reaches the engine (pane breaks); stand-in hits are forwarded", async () => {
    const { DetailEngine } = await import("../../src/sim/detailZone");
    const { DetailStandIns } = await import("../../src/sim/detailStandIns");
    const { resolveImpact } = await import("../../src/core/impact/impact");
    const { createRng } = await import("../../src/sim/rng");
    const b = exactHouse();
    b.detail = true;
    // Town debris hits the detailed house's stand-in: the hit is queued there and forwarded.
    const s = new DetailStandIns();
    s.add(0, b, buildFraming(b));
    const pane = 0;
    const face = b.panels[b.panes[pane]!.panel]!.face;
    const hit = resolveImpact(b.standIn!, { kind: "pane", index: pane, face }, { label: "Shingle", family: "sheet", mass: 1, dims: [1, 0.33, 0.005] }, 15, createRng(1))!;
    expect(hit.impact.broke).toBe(true);
    b.standIn!.impacts.push(hit.impact);
    s.advance(0);
    expect(s.forward).toHaveLength(1);
    // The engine breaks that pane.
    const e = new DetailEngine([b]);
    const t = tornado(-5000);
    e.step({ n: 0, tornado: t, terrain: "open", enter: [{ index: 0, removed: [] }], exit: [] });
    for (let n = 1; n < 6; n++) e.step({ n, tornado: t, terrain: "open", enter: [], exit: [] });
    const h = e.houses.get(0)!;
    const shards = h.framing.members.filter((m) => m.kind === "pane" && m.panel === b.panes[pane]!.panel);
    expect(shards.every((m) => h.isAttached(m.id))).toBe(true);
    const q = s.forward[0]!.impact;
    e.step({ n: 6, tornado: t, terrain: "open", enter: [], exit: [], debrisHits: [{ index: 0, surface: q.surface, component: q.index, face: q.face, broke: q.broke, force: q.force }] });
    expect(shards.every((m) => !h.isAttached(m.id))).toBe(true);
    e.dispose();
  });
  test("STR-32: rubble resting on a town house's stand-in falls when that house's roof and walls go", async () => {
    const { DetailEngine } = await import("../../src/sim/detailZone");
    const { townState } = await import("../../src/sim/townColliders");
    const a = exactHouse();
    const b = exactHouse();
    b.x = 20;
    b.id = 1;
    const e = new DetailEngine([a, b]);
    const t = tornado(-5000, 1);
    let n = 0;
    const step = (town?: ReturnType<typeof townState>[]) => e.step({ enter: n === 0 ? [{ index: 0, removed: [] }] : [], n: n++, tornado: t, terrain: "open", exit: [], town });
    step([townState(1, b)]);
    const h = e.houses.get(0)!;
    while (!h.complete) step();
    // Three of A's rafter pairs, dropped onto B's roof just above B's own rafters: they rest
    // there like a saddle and become rubble.
    const rafters = h.framing.members.filter((m) => m.kind === "rafterPair").sort((p, q) => p.pos.x - q.pos.x || p.pos.z - q.pos.z);
    const ids = rafters.slice(10, 13).map((m) => m.id);
    const orig = h.memberPose(ids[0]!).pos;
    const body = h.launch(ids, { x: b.x, y: 10, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })!;
    // Exactly over B's own rafters (same house, 20 m along), 5 cm up.
    const now = h.memberPose(ids[0]!).pos;
    const bt = body.translation();
    body.setTranslation({ x: bt.x + orig.x + b.x - now.x, y: bt.y + orig.y + 0.05 - now.y, z: bt.z + orig.z - now.z }, true);
    const handle = body.handle;
    for (let k = 0; k < 60 * 4 && !h.rubble.has(handle); k++) step();
    expect(h.rubble.has(handle)).toBe(true);
    const eave = b.wallHeight + 0.2;
    const y0 = h.memberPose(ids[0]!).pos.y;
    expect(y0).toBeGreaterThan(eave); // on B's roof
    // B's roof and walls go (every bay and panel): its stand-in is rebuilt without them, and
    // the rafters drop to the ground.
    const gone = { part: "roofBay", index: 0, time: 0, load: 0, capacity: 0, mph: 0, sign: 0, wind: { x: 0, y: 0, z: 0 } } as const;
    b.bays.forEach((x) => (x.failed = { ...gone }));
    b.panels.forEach((x) => (x.failed = { ...gone, part: "wallPanel" }));
    step([townState(1, b)]);
    for (let k = 0; k < 60 * 3; k++) step();
    expect(h.memberPose(ids[0]!).pos.y).toBeLessThan(y0 - 1);
    e.dispose();
  }, 60000);

  test("STR-33: a house past its settle timeout freezes only once every piece is down and creeping, never in the air", async () => {
    const { DetailEngine } = await import("../../src/sim/detailZone");
    const a = exactHouse();
    const e = new DetailEngine([a]);
    const t = tornado(-5000, 1);
    let n = 0;
    const step = (exit: number[] = []) => e.step({ enter: n === 0 ? [{ index: 0, removed: [] }] : [], n: n++, tornado: t, terrain: "open", exit });
    step();
    const h = e.houses.get(0)!;
    while (!h.complete) step();
    // A wall frame thrown up at 15 m/s, spinning (~3 s in the air, then it topples and slides
    // flat), and the house leaves the zone with its settle timeout already over.
    const frame = h.framing.members.find((m) => m.kind === "wallFrame")!;
    h.launch([frame.id], { x: 0, y: 8, z: 30 }, { x: 0, y: 15, z: 0 }, { x: 0.5, y: 0, z: 0 });
    step([0]);
    h.releasedAt = -DETAIL.settleTimeout - 1;
    let frozenAt = -1;
    let downFor = 0;
    for (let k = 0; k < 60 * 15 && frozenAt < 0; k++) {
      const r = step();
      if (r.frozen.length) frozenAt = k;
      else downFor = h.unsettled() ? 0 : downFor + 1;
    }
    // It came down first, and froze only after a second of creeping: flat on the ground.
    expect(frozenAt).toBeGreaterThan(60 * 3);
    expect(downFor).toBeGreaterThanOrEqual(60 * DETAIL.creepForS - 1);
    expect(h.frozen).toBe(true);
    expect(h.memberPose(frame.id).pos.y).toBeLessThan(0.5);
    e.dispose();
  }, 60000);
});
