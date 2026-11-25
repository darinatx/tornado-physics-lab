/**
 * Wind tunnel scenario library (Spec 12). Each scenario is data plus checks on its record; the
 * runner (`npm run tunnel`) runs them in parallel, and every scenario also requires zero
 * pass-through.
 *
 * Add a scenario whenever a damage or debris issue is reported: reproduce it here first.
 */
import type { TunnelScenario } from "../../src/sim/tunnel";
import type { TunnelRecord } from "../harness/tunnel";

export interface LibraryScenario extends TunnelScenario {
  /** Problems found in the record (empty = pass). */
  check?: (r: TunnelRecord) => string[];
  /** Left out of the default run (selftests). */
  hidden?: boolean;
}

const calm = [{ t: 0, mph: 0, dirDeg: 0 }];

/** Paths a window shot can take (Spec 12): the piece's source and the target's model. */
export const SHOT_PATHS = [
  { id: "town-component", source: "town", model: "component", path: "debris" },
  { id: "town-detail", source: "town", model: "detail", path: "debris" },
  { id: "same-detail", source: "detail-same", model: "detail", path: null },
  { id: "other-detail", source: "detail-other", model: "detail", path: "detail" },
  { id: "detail-component", source: "detail-same", model: "component", path: "detail" },
] as const;

/** A piece fired at pane 0 (end wall +X) from 3 m out at 20 m/s, in still air. */
export function windowShot(p: (typeof SHOT_PATHS)[number]): LibraryScenario {
  const launch =
    p.source === "town"
      ? ({ t: 0.1, source: "town", kind: "stud", aim: { pane: 0 }, standoff: 3, speed: 20 } as const)
      : ({ t: 0.1, source: p.source, member: "siding", aim: { pane: 0 }, standoff: 3, speed: 20 } as const);
  return {
    name: `window-shot/${p.id}`,
    seconds: 1.5,
    target: { model: p.model, cls: "standard" },
    wind: calm,
    launches: [launch],
    check: (r) => {
      const out: string[] = [];
      if (!r.final.panes[0]) out.push("pane 0 not broken");
      if (p.path && !r.impacts.some((i) => i.path === p.path && i.surface === "pane" && i.index === 0)) out.push(`no impact on pane 0 by the ${p.path} path`);
      return out;
    },
  };
}

/** A 2×4 end-on at a wall panel between windows: never through the wall (it lodges or bounces). */
function wallShot(model: "component" | "detail", speed: number): LibraryScenario {
  return {
    name: `wall-shot/${model}/${speed}ms`,
    seconds: 2,
    target: { model, cls: "standard" },
    wind: calm,
    launches: [{ t: 0.1, source: "town", kind: "stud", aim: { wall: 1 }, standoff: 4, speed }],
    check: (r) => {
      const hit = r.impacts.find((i) => i.surface === "wall");
      if (!hit) return ["the stud never hit the wall"];
      // A perforating stud lodges, in either model (Spec 10 IMP-04, IMP-22).
      return hit.perforated && r.lodged.total === 0 ? ["the stud perforated the wall but didn't lodge"] : [];
    },
  };
}

/** Steady wind on each model: nothing at calm; the roof comes off at 200 mph. */
function steady(model: "component" | "detail", mph: number): LibraryScenario {
  return {
    name: `steady/${model}/${mph}mph`,
    seconds: mph ? 10 : 5,
    target: { model, cls: "standard" },
    wind: [{ t: 0, mph, dirDeg: 0 }],
    check: (r) => {
      if (mph === 0) return r.failures.length ? [`${r.failures.length} failures in still air`] : [];
      return r.final.decks.some(Boolean) || r.final.bays.some(Boolean) ? [] : ["roof still on at " + mph + " mph"];
    },
  };
}

export const SCENARIOS: LibraryScenario[] = [
  ...SHOT_PATHS.map(windowShot),
  wallShot("component", 15.2),
  wallShot("component", 44.7),
  wallShot("detail", 15.2),
  steady("component", 0),
  steady("detail", 0),
  steady("component", 200),
  steady("detail", 200),
  {
    name: "swing/component/120mph",
    seconds: 12,
    target: { model: "component", cls: "standard" },
    // Wind veering 180° as a tornado passes to one side.
    wind: [
      { t: 0, mph: 60, dirDeg: 0 },
      { t: 4, mph: 130, dirDeg: 60 },
      { t: 8, mph: 130, dirDeg: 120 },
      { t: 12, mph: 60, dirDeg: 180 },
    ],
    launches: [
      { t: 3, source: "town", kind: "shingle", from: { x: -25, y: 4, z: 0 }, speed: 30, dir: { x: 1, y: 0, z: 0 }, represents: 20 },
      { t: 6, source: "town", kind: "stud", from: { x: -20, y: 3, z: -10 }, speed: 35, aim: { point: { x: 0, y: 1.5, z: 0 } } },
    ],
  },
  // Selftest: the runner must report a failing check (TUN-09).
  { name: "selftest/fails", seconds: 0.2, target: { model: "component" }, wind: calm, hidden: true, check: () => ["fails by design"] },
];
