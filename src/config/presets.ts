/**
 * Strength presets (Spec 07, INST-05/06). Each is a realistic archetype for its EF rating:
 * weak tornadoes are small, short-lived ropes; violent ones are wide, long-lived wedges with
 * low cloud bases. vPeak values are calibrated so the mature readout lands mid-band.
 */
import type { TornadoParams } from "../sim/types";

export interface Preset {
  id: string;
  name: string;
  ef: 0 | 1 | 2 | 3 | 4 | 5;
  description: string;
  params: Partial<TornadoParams>;
}

export const PRESETS: Preset[] = [
  {
    id: "ef0-rope",
    name: "EF0 · Weak rope",
    ef: 0,
    description: "A thin, brief rope tornado. Breaks branches and peels shingles.",
    params: { vPeak: 20, rMax: 40, translationSpeed: 8, updraftMax: 25, cloudBase: 550, tUp: 20, tMature: 60, tRope: 40 },
  },
  {
    id: "ef1-small",
    name: "EF1 · Small tornado",
    ef: 1,
    description: "A narrow funnel. Rips off roof coverings and pushes mobile homes off foundations.",
    params: { vPeak: 26, rMax: 70, translationSpeed: 10, updraftMax: 30, cloudBase: 500, tUp: 30, tMature: 90, tRope: 50 },
  },
  {
    id: "ef2-cone",
    name: "EF2 · Cone tornado",
    ef: 2,
    description: "A classic cone. Tears off well-built roofs and snaps large trees.",
    params: { vPeak: 34, rMax: 110, translationSpeed: 12, updraftMax: 34, cloudBase: 450, tUp: 40, tMature: 120, tRope: 60 },
  },
  {
    id: "ef3-strong",
    name: "EF3 · Strong tornado",
    ef: 3,
    description: "A thick, strong funnel. Destroys entire stories of well-built homes.",
    params: { vPeak: 42, rMax: 170, translationSpeed: 13, updraftMax: 32, cloudBase: 450, tUp: 50, tMature: 180, tRope: 80 },
  },
  {
    id: "ef4-wedge",
    name: "EF4 · Violent wedge",
    ef: 4,
    description: "A wide wedge, often wrapped in debris. Levels well-built houses.",
    params: { vPeak: 52, rMax: 300, translationSpeed: 15, updraftMax: 30, cloudBase: 400, tUp: 60, tMature: 220, tRope: 90 },
  },
  {
    id: "ef5-extreme",
    name: "EF5 · Extreme",
    ef: 5,
    description: "The rarest and strongest. Sweeps houses off their foundations.",
    params: { vPeak: 78, rMax: 350, translationSpeed: 17, updraftMax: 40, cloudBase: 400, tUp: 60, tMature: 240, tRope: 90 },
  },
];

export const DEFAULT_PRESET_ID = "ef4-wedge";
