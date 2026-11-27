/**
 * The narrative (Spec 16): plain sentences written by fixed rules from the record and the
 * survey. No randomness; every sentence traces to a number in the report (REP-12).
 */
import { COMPASS16 } from "../../config/report";
import type { StormRecord, TrackSample } from "../stormRecord";
import { compassOf } from "../stormRecord";
import { compassWord, distText, mphOf, placeText, speedText, timeText, widthText } from "./format";
import type { Survey } from "./survey";

/** Radius (m) around the rating point counted as the worst-hit area. */
export const WORST_AREA_M = 250;

const BASIS: Record<string, string> = {
  weak: "weak construction, so rated at the low end of its range",
  standard: "standard construction",
  strong: "strong construction, so rated at the high end of its range",
};

export function placeOf(x: number, z: number, center: { x: number; z: number }): { distance: number; compass: string } {
  const dx = x - center.x;
  const dz = z - center.z;
  return { distance: Math.hypot(dx, dz), compass: COMPASS16[Math.round(compassOf(dx, dz) / 22.5) % 16]! };
}

interface Facts {
  on: TrackSample[];
  last: TrackSample | undefined;
  dissipated: boolean;
}

function facts(record: StormRecord): Facts {
  const on = record.track.filter((t) => t.vMax > 0);
  const last = record.track[record.track.length - 1];
  return { on, last, dissipated: last?.phase === "dissipated" && on.length > 0 };
}

/** Each sentence by its rule, keyed so the summary can pick its own. */
function sentences(record: StormRecord, survey: Survey): Record<string, string> {
  const c = record.townCenter;
  const { on, last, dissipated } = facts(record);
  const out: Record<string, string> = {};
  if (!on.length) {
    out.formed = "No tornado touched down during the run.";
    return out;
  }
  const f = on[0]!;
  const end = on[on.length - 1]!;
  const speed = on.reduce((s, t) => s + t.speed, 0) / on.length;
  const heading = f.x !== end.x || f.z !== end.z ? compassOf(end.x - f.x, end.z - f.z) : f.heading;
  out.formed = `The tornado formed ${placeText(placeOf(f.x, f.z, c))} ${timeText(f.t)} into the run and moved ${compassWord(COMPASS16[Math.round(heading / 22.5) % 16]!)} at about ${speedText(mphOf(speed))}.`;
  const peak = Math.max(...on.map((t) => t.peak));
  const mature = on.find((t) => t.phase === "mature");
  out.grew =
    f.phase === "mature" || !mature
      ? `It was at full strength from the start, with peak winds of ${speedText(mphOf(peak))} at 10 m.`
      : `It reached full strength ${timeText(mature.t - f.t)} after forming, with peak winds of ${speedText(mphOf(peak))} at 10 m.`;

  const rp = survey.ratingPoint === null ? null : survey.points[survey.ratingPoint]!;
  if (!rp) {
    out.rating = "No house was damaged, so the survey could not rate it.";
  } else {
    out.rating = `The damage survey rates it EF${survey.rating}, with estimated peak winds of ${speedText(survey.ratingMph)}, from a house ${placeText(placeOf(rp.x, rp.z, c))} rated DOD ${rp.dod} (${rp.description.toLowerCase()}) with ${BASIS[rp.cls]}.`;
    out.path = `Its damage path was ${distText(survey.path.survey.length)} long and up to ${widthText(survey.path.survey.maxWidth)} wide.`;
    const destroyed = record.buildings.filter((b) => b.dod >= 8 && Math.hypot(b.x - rp.x, b.z - rp.z) <= WORST_AREA_M).length;
    const where = placeText(placeOf(rp.x, rp.z, c));
    out.worst =
      destroyed > 0
        ? `The worst damage was ${where}, where ${destroyed} house${destroyed === 1 ? " was" : "s were"} destroyed (DOD 8 or more) within ${WORST_AREA_M} m.`
        : `The worst damage was ${where}; no house there was destroyed outright.`;
    const damaged = survey.points.length;
    const destroyedAll = record.buildings.filter((b) => b.dod >= 8).length;
    out.town = `In all, ${damaged} of the ${record.buildings.length} houses in town were damaged and ${destroyedAll} destroyed.`;
  }
  if (survey.truePeak) {
    const t = survey.truePeak;
    const cmp =
      survey.rating === null || t.ef === null
        ? ""
        : t.ef > survey.rating
          ? ", higher than the survey's rating: the survey can only rate what the wind hit"
          : t.ef < survey.rating
            ? ", lower than the survey's rating"
            : ", the same EF as the survey's rating";
    out.truth = `The simulation's own wind record peaked at ${speedText(t.mph)} (EF${t.ef}) at 10 m ${placeText(placeOf(t.x, t.z, c))}${cmp}.`;
  }
  out.end = dissipated
    ? `It roped out and dissipated ${placeText(placeOf(end.x, end.z, c))} ${timeText(end.t)} into the run, ${timeText(end.t - f.t)} after it formed.`
    : `The run ended ${timeText(last!.t)} in, with the tornado still on the ground (${last!.phase}) ${placeText(placeOf(last!.x, last!.z, c))}.`;
  return out;
}

const ORDER = ["formed", "grew", "rating", "path", "worst", "town", "truth", "end"];
const SUMMARY = ["rating", "path", "worst", "end"];

/** The full narrative, in order. */
export function narrative(record: StormRecord, survey: Survey): string[] {
  const s = sentences(record, survey);
  return ORDER.flatMap((k) => (s[k] ? [s[k]!] : []));
}

/** The summary's 3–5 sentences: the rating, the path, the worst damage and the end. */
export function summaryNarrative(record: StormRecord, survey: Survey): string[] {
  const s = sentences(record, survey);
  const out = SUMMARY.flatMap((k) => (s[k] ? [s[k]!] : []));
  if (out.length < 3) return ORDER.flatMap((k) => (s[k] ? [s[k]!] : [])).slice(0, 3);
  return out;
}
