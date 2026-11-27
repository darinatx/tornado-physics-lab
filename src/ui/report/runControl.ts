/**
 * Ending a run and making its report (Spec 16, REP-01), without the DOM: Stop & Report stops
 * the sim and builds the report; Preview report builds a preliminary one while it runs; when
 * the lifecycle ends (and repeat is off) the run stops by itself and the report is offered.
 */
import { REPORT } from "../../config/report";
import type { Sim } from "../../sim/loop";
import { buildReport } from "../../sim/report/report";
import type { Report } from "../../sim/report/report";
import type { SpecDoc } from "../../sim/report/specDocs";
import { buildSurvey } from "../../sim/report/survey";
import { StormRecorder } from "../../sim/stormRecord";
import type { RecorderOptions } from "../../sim/stormRecord";

export interface ReportControl {
  readonly recorder: StormRecorder;
  /** The run ended (stopped by the user or by the lifecycle) and a report is ready to open. */
  readonly offered: boolean;
  /** Stop the run and build its (final) report. */
  stopAndReport(): Report;
  /** Build a preliminary report without stopping. */
  preview(): Report;
  /** The report for the stopped run (final), or a preview while running. */
  current(): Report;
  /** Each frame: stops the run once the lifecycle has ended, unless repeat is on. */
  tick(): void;
  /** After a restart: nothing offered. */
  reset(): void;
  onOffer?: (offered: boolean) => void;
}

export function createReportControl(
  sim: Sim,
  o: { autoRepeat: () => boolean; specs?: readonly SpecDoc[]; recorder?: RecorderOptions; preset?: () => string | null },
): ReportControl {
  const recorder = new StormRecorder(sim, o.recorder ?? {});
  let offered = false;
  const build = (preliminary: boolean) => {
    const record = recorder.record();
    if (o.preset) record.meta.preset = o.preset();
    return buildReport(record, buildSurvey(record), { preliminary, specs: o.specs ?? [] });
  };
  const offer = (on: boolean) => {
    if (offered === on) return;
    offered = on;
    ctl.onOffer?.(on);
  };
  const ctl: ReportControl = {
    recorder,
    get offered() {
      return offered;
    },
    stopAndReport() {
      sim.stop();
      offer(true);
      return build(false);
    },
    preview() {
      return build(!sim.stopped);
    },
    current() {
      return build(!sim.stopped);
    },
    tick() {
      if (sim.stopped || o.autoRepeat()) return;
      const s = sim.snapshot;
      if (s.phase === "dissipated" && s.time > s.lifetime + REPORT.endDelay) {
        sim.stop();
        offer(true);
      }
    },
    reset() {
      offer(false);
    },
  };
  return ctl;
}
