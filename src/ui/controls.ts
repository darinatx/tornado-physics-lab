/** Control definitions derived from config (INST-01). Pure; no DOM. */
import { ATMOSPHERE_PARAMS } from "../config/atmosphere";
import { PATH_PARAMS } from "../config/sim";
import { WIND_PARAMS } from "../config/wind";
import type { TornadoParams } from "../sim/types";

export type ControlGroup = "Basic" | "Advanced";

export interface ControlDef {
  key: keyof TornadoParams;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  default: number;
  group: ControlGroup;
  help: string;
}

/** Plain-language labels and tooltips. */
const UI: Partial<Record<keyof TornadoParams, { label: string; group: ControlGroup; help: string }>> = {
  vPeak: {
    label: "Strength", group: "Basic",
    help: "Peak spinning wind speed above the ground. Higher = stronger tornado and higher EF rating. Winds near rooftop height run about 30% faster than this. Above ~94 m/s the tornado exceeds the strongest winds ever measured (≈302 mph) and is hypothetical, up to ~400 mph.",
  },
  rMax: {
    label: "Size (core radius)", group: "Basic",
    help: "Distance from the center to the ring of strongest wind. Small = thin rope tornado; large = wide wedge.",
  },
  translationSpeed: {
    label: "Forward speed", group: "Basic",
    help: "How fast the tornado travels across the ground. It also makes the right side of the path stronger than the left.",
  },
  heading: {
    label: "Direction of travel", group: "Basic",
    help: "Compass-style heading of the path. 0° = east, 90° = north. Most real tornadoes move toward the northeast (about 45–60°).",
  },
  cloudBase: {
    label: "Cloud base height", group: "Basic",
    help: "Height of the storm's cloud base. A lower base lets the visible funnel reach the ground; a higher base leaves a funnel stub with a dust whirl beneath.",
  },
  alpha: {
    label: "Outer wind falloff", group: "Advanced",
    help: "How quickly winds weaken outside the core. Higher = winds drop off faster with distance.",
  },
  inflowRatio: {
    label: "Inflow strength", group: "Advanced",
    help: "How strongly air rushes inward along the ground into the tornado.",
  },
  inflowDepth: {
    label: "Inflow layer depth", group: "Advanced",
    help: "How deep the layer of inward-rushing air near the ground is.",
  },
  updraftMax: {
    label: "Core updraft", group: "Advanced",
    help: "Speed of the rising air. Strong rotation with a weak updraft turns the tornado two-celled: air sinks in the center and rises in a ring.",
  },
  overshoot: {
    label: "Near-ground boost", group: "Advanced",
    help: "How much faster winds are just above the ground (near rooftop height) than higher up, as radar observes in real tornadoes.",
  },
  zPeak: {
    label: "Height of strongest winds", group: "Advanced",
    help: "Height above the ground where winds are strongest.",
  },
  turnRate: {
    label: "Path curve", group: "Advanced",
    help: "Makes the path curve. Positive curves left, negative curves right. 0 = straight.",
  },
};

export function buildControlDefs(): ControlDef[] {
  const sources = [
    ...Object.entries(WIND_PARAMS),
    ...Object.entries(PATH_PARAMS),
    ...Object.entries(ATMOSPHERE_PARAMS),
  ] as [keyof TornadoParams, { label: string; unit: string; default: number; min: number; max: number; step: number }][];
  const defs = sources.map(([key, d]) => {
    const ui = UI[key];
    return {
      key,
      label: ui?.label ?? d.label,
      unit: d.unit,
      min: d.min,
      max: d.max,
      step: d.step,
      default: d.default,
      group: ui?.group ?? ("Advanced" as const),
      help: ui?.help ?? d.label,
    };
  });
  const order: (keyof TornadoParams)[] = ["vPeak", "rMax", "translationSpeed", "heading", "cloudBase"];
  return defs.sort((a, b) => {
    const ia = order.indexOf(a.key);
    const ib = order.indexOf(b.key);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}
