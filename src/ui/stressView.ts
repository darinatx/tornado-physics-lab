/**
 * Component stress view (Spec 13 v0.7, LAB-19): a lab house's attached members colored by how
 * close their connections are to failing. Pure; reads the sim's detail view, never writes it.
 */
import type { MemberStyle } from "../render/detailLayer";
import type { DetailView } from "../sim/detailBackend";

/** Utilization 0 → 1 as green → yellow → red (beyond 1: red). */
export function utilColor(u: number): number {
  const k = Math.max(0, Math.min(1, u));
  const r = Math.round(255 * Math.min(1, 2 * k));
  const g = Math.round(255 * Math.min(1, 2 * (1 - k)));
  return (r << 16) | (g << 8) | 40;
}

/** A member's highest connection utilization (load / capacity) at the last detail step. */
export function memberUtilization(view: DetailView, house: number, member: number): number {
  const h = view.houses.get(house);
  const ins = view.inspection.get(house);
  if (!h || !ins) return 0;
  let u = 0;
  for (const c of h.framing.supportsOf[member]!) {
    const cap = h.framing.connections[c]!.capacity;
    if (cap > 0) u = Math.max(u, ins.loads[c]! / cap);
  }
  return u;
}

/** Is the stress view offered for this house? Lab houses built member by member only. */
export function stressOffered(view: DetailView, block: readonly number[], house: number): boolean {
  return block.includes(house) && view.houses.has(house);
}

/**
 * The style for the houses in the stress view (their attached members by utilization), plus the
 * cutaway (roof members still attached hidden) on every lab house; other members untouched.
 */
export function stressStyle(view: DetailView, block: readonly number[], stressed: ReadonlySet<number>, cutaway: boolean, roofKinds: ReadonlySet<string>): MemberStyle | null {
  if (!stressed.size && !cutaway) return null;
  return (house, member) => {
    const h = view.houses.get(house);
    if (!h || !block.includes(house)) return null;
    const ins = view.inspection.get(house);
    const attached = ins ? ins.attached[member] === 1 : true;
    const out: { hidden?: boolean; color?: number } = {};
    if (cutaway && attached && roofKinds.has(h.framing.members[member]!.kind)) out.hidden = true;
    if (stressed.has(house) && attached && ins) out.color = utilColor(memberUtilization(view, house, member));
    return out.hidden || out.color !== undefined ? out : null;
  };
}
