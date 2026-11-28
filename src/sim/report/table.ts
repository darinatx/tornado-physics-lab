/**
 * The damage survey table (Spec 16): one row per survey point, the columns the report page and
 * the CSV export share. Speeds in mph with m/s alongside, as the report shows them.
 */
import { CLASS_LABEL } from "../../config/buildings";
import { MS_PER_MPH } from "../../config/units";
import type { EFRating } from "../../core/wind/efScale";
import type { Survey } from "./survey";

export interface SurveyRow {
  /** Survey point ID (P1, P2, … in along-track order) and building id. */
  point: string;
  building: number;
  /** Position (m) relative to the town center, and along/cross track. */
  x: number;
  z: number;
  along: number;
  cross: number;
  di: string;
  dod: number;
  description: string;
  construction: string;
  surveyMph: number;
  surveyMs: number;
  ef: string;
  rangeMph: string;
  rangeEf: string;
  true10Mph: number;
  trueRoofMph: number;
  biasMph: number;
  outsideBounds: boolean;
  firstDamagedS: number | null;
  /** False for a point above the rating with no second point near it (Spec 16 v1.9). */
  corroborated: boolean;
  /** Debris damage: no wind-caused failure, so not used for the rating or path (Spec 16 v1.11). */
  debrisOnly: boolean;
}

export const SURVEY_COLUMNS: readonly (keyof SurveyRow)[] = [
  "point", "building", "x", "z", "along", "cross", "di", "dod", "description", "construction",
  "surveyMph", "surveyMs", "ef", "rangeMph", "rangeEf", "true10Mph", "trueRoofMph", "biasMph",
  "outsideBounds", "firstDamagedS", "corroborated", "debrisOnly",
];

/** EF of a speed; below EF0 (65 mph) reads "<EF0", as a DOD's lower bound can be. */
const efText = (e: EFRating | null) => (e === null ? "<EF0" : `EF${e}`);
const r1 = (v: number) => Math.round(v * 10) / 10;

/** Survey points in along-track order, numbered P1… (the ID the map and table share). */
export function surveyRows(survey: Survey, center = { x: 0, z: 0 }): SurveyRow[] {
  return [...survey.points]
    .sort((a, b) => a.along - b.along || a.index - b.index)
    .map((p, i) => ({
      point: `P${i + 1}`,
      building: p.id,
      x: r1(p.x - center.x),
      z: r1(p.z - center.z),
      along: r1(p.along),
      cross: r1(p.cross),
      di: "DI 2",
      dod: p.dod,
      description: p.description,
      construction: CLASS_LABEL[p.cls],
      surveyMph: p.mph,
      surveyMs: r1(p.mph * MS_PER_MPH),
      ef: efText(p.ef),
      rangeMph: `${p.lowMph}–${p.highMph}`,
      rangeEf: `${efText(p.efLow)}–${efText(p.efHigh)}`,
      true10Mph: r1(p.true10Mph),
      trueRoofMph: r1(p.trueRoofMph),
      biasMph: r1(p.biasMph),
      outsideBounds: p.outside,
      firstDamagedS: p.firstDamaged === null ? null : r1(p.firstDamaged),
      corroborated: !p.uncorroborated,
      debrisOnly: p.debrisOnly,
    }));
}
