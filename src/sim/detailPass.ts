/**
 * A detailed (member-level) house passing through a translating tornado (Spec 09 slice C):
 * the same measurement as the component model's `tornadoPass` (DMG-04), so the two models
 * can be validated against the DI 2 table the same way.
 */
import { MS_PER_MPH } from "../config/units";
import type { Building } from "../core/damage/types";
import { qconj, qrot } from "../core/structure/framing";
import { surveyDetail } from "../core/structure/survey";
import { pressureDeficit } from "../core/wind/pressure";
import type { TornadoState } from "../core/wind/types";
import { windAt } from "../core/wind/windField";
import { STRUCT_DT, StructureWorld } from "./structureWorld";
import type { WindSource } from "./structureWorld";
import type { Terrain } from "../core/terrain/roughness";

export interface DetailPassResult {
  /** For each DOD d (index), the peak roof-height wind (mph) felt when it first reached DOD ≥ d. */
  first: number[];
  /** Peak roof-height wind over the whole pass (mph). */
  peak: number;
  /** Final DOD. */
  dod: number;
  /** Peak wind (mph) when each kind of connection first failed. */
  firstFail: Record<string, number>;
  /** Every connection failure, in order (for diagnosis). */
  failures: import("./structureWorld").StructureFailure[];
}

/** Pass a tornado over a detailed house at the origin, offset sideways from the track. */
export function detailPass(b: Building, s: TornadoState, terrain: Terrain = "open", lateralOffset = 0): DetailPassResult {
  const first = new Array<number>(11).fill(Infinity);
  const speed = Math.hypot(s.velocity.x, s.velocity.z);
  const dir = { x: s.velocity.x / speed, z: s.velocity.z / speed };
  const right = { x: -dir.z, z: dir.x };
  const house = { ...b, x: right.x * lateralOffset, z: right.z * lateralOffset } as Building;
  const span = 6 * s.rMax;
  let state: TornadoState = { ...s, center: { x: -dir.x * span, z: -dir.z * span } };
  const wind: WindSource = {
    at: (p) => windAt(p, state, terrain),
    deficit: (x, z) => pressureDeficit(Math.hypot(x - state.center.x, z - state.center.z), state),
  };
  const sw = new StructureWorld();
  sw.terrain = terrain;
  const h = sw.addHouse(house);
  const roof = { x: house.x, y: house.roofHeight, z: house.z };
  const inv = qconj([0, Math.sin(house.yaw / 2), 0, Math.cos(house.yaw / 2)]);
  let peak = 0;
  let dod = 0;
  const firstFail: Record<string, number> = {};
  for (let x = -span, k = 0; x <= span; x += speed * STRUCT_DT, k++) {
    state = { ...s, center: { x: dir.x * x, z: dir.z * x } };
    const w = windAt(roof, state, terrain);
    peak = Math.max(peak, Math.hypot(w.x, w.y, w.z) / MS_PER_MPH);
    const before = h.failures.length;
    sw.step(wind);
    for (let j = before; j < h.failures.length; j++) firstFail[h.failures[j]!.label] ??= peak;
    if (h.failures.length !== before) {
      // Diagnostics: when the last exterior wall frame and the last interior wall came down.
      const allDown = (k: string) => h.framing.members.every((m) => m.kind !== k || !h.isAttached(m.id));
      if (allDown("wallFrame")) firstFail["(all wall frames down)"] ??= peak;
      if (allDown("partition")) firstFail["(all interior walls down)"] ??= peak;
    }
    // Survey on new failures, and at 10 Hz while pieces move (for "slab swept clean").
    if (h.failures.length !== before || k % 6 === 0) {
      dod = Math.max(
        dod,
        surveyDetail(house, h.framing, h.framing.members.map((m) => h.isAttached(m.id)), h.intact, (id) => {
          if (h.lost[id]) return null;
          const p = h.memberPose(id).pos;
          return qrot(inv, { x: p.x - house.x, y: p.y, z: p.z - house.z });
        }),
      );
      for (let d = 1; d <= dod; d++) if (first[d] === Infinity) first[d] = peak;
    }
    if (dod >= 10) break;
  }
  const failures = [...h.failures];
  sw.dispose();
  return { first, peak, dod, firstFail, failures };
}
