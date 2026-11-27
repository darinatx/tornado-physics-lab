/**
 * Report export (Spec 16, REP-14): the JSON (the record and the survey; it reloads into the same
 * report) and the CSV (the survey table, one row per point, every column).
 */
import { buildReport } from "./report";
import type { Report } from "./report";
import type { SpecDoc } from "./specDocs";
import { buildSurvey } from "./survey";
import type { Survey } from "./survey";
import { SURVEY_COLUMNS, surveyRows } from "./table";
import type { StormRecord } from "../stormRecord";

export const REPORT_FORMAT = "tornado-physics-lab/storm-report";
export const REPORT_FORMAT_VERSION = 1;

export interface ReportFile {
  format: typeof REPORT_FORMAT;
  version: number;
  /** "Simulated storm report": the file says what it is, as every page does. */
  mark: string;
  preliminary: boolean;
  record: StormRecord;
  survey: Survey;
}

export function reportJson(record: StormRecord, survey: Survey, preliminary: boolean): string {
  const file: ReportFile = { format: REPORT_FORMAT, version: REPORT_FORMAT_VERSION, mark: "Simulated storm report", preliminary, record, survey };
  return JSON.stringify(file);
}

/** A saved report back as a report. The survey is rebuilt from the record (it's a pure
 *  function of it) and must match the saved one, so a file edited by hand is caught. */
export function reportFromJson(text: string, specs: readonly SpecDoc[] = []): Report {
  let file: ReportFile;
  try {
    file = JSON.parse(text) as ReportFile;
  } catch {
    throw new Error("Not a storm report file: it isn't valid JSON.");
  }
  if (file?.format !== REPORT_FORMAT) throw new Error("Not a storm report file (no Tornado Physics Lab storm-report header).");
  if (file.version > REPORT_FORMAT_VERSION) throw new Error(`This storm report file is version ${file.version}; this app reads up to version ${REPORT_FORMAT_VERSION}.`);
  const survey = buildSurvey(file.record);
  if (JSON.stringify(survey) !== JSON.stringify(file.survey)) throw new Error("The file's survey doesn't match its record (the file was changed, or it was made by a different survey version).");
  return buildReport(file.record, survey, { preliminary: file.preliminary, specs });
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The survey table as CSV: a header row of the column names, then one row per point. */
export function surveyCsv(survey: Survey, center = { x: 0, z: 0 }): string {
  const rows = surveyRows(survey, center);
  const lines = [SURVEY_COLUMNS.join(",")];
  for (const r of rows) lines.push(SURVEY_COLUMNS.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}
