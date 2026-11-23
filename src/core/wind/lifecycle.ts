/**
 * Tornado lifecycle (Spec 01): spin-up → mature → rope-out, with smoothstep ramps.
 */

export type Phase = "spin-up" | "mature" | "rope-out" | "dissipated";

export interface LifecycleParams {
  vPeak: number;
  rMax: number;
  tUp: number;
  tMature: number;
  tRope: number;
}

export interface LifecycleState {
  vMax: number;
  rMax: number;
  phase: Phase;
}

function smoothstep(u: number): number {
  const x = Math.min(Math.max(u, 0), 1);
  return x * x * (3 - 2 * x);
}

export function lifetime(p: LifecycleParams): number {
  return p.tUp + p.tMature + p.tRope;
}

export function lifecycle(t: number, p: LifecycleParams): LifecycleState {
  const endUp = p.tUp;
  const endMature = endUp + p.tMature;
  const end = endMature + p.tRope;

  if (t < endUp) {
    const k = smoothstep(p.tUp > 0 ? t / p.tUp : 1);
    // Vortex tightens from 1.5·R_max to R_max as it spins up.
    return { vMax: p.vPeak * k, rMax: p.rMax * (1.5 - 0.5 * k), phase: "spin-up" };
  }
  if (t < endMature) {
    return { vMax: p.vPeak, rMax: p.rMax, phase: "mature" };
  }
  if (t < end) {
    const k = smoothstep(p.tRope > 0 ? (t - endMature) / p.tRope : 1);
    // Rope-out: weakens and narrows to 0.3·R_max.
    return { vMax: p.vPeak * (1 - k), rMax: p.rMax * (1 - 0.7 * k), phase: "rope-out" };
  }
  return { vMax: 0, rMax: p.rMax * 0.3, phase: "dissipated" };
}
