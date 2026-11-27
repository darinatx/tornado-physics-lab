import { rateText, SimRateMeter } from "./ui/simRate";
import { SIM_DEFAULTS } from "./config/sim";
import type { Building } from "./core/damage/types";
import { recordDebrisAt, townWind } from "./sim/debrisRecorder";
import type { DebrisRecorder } from "./sim/debrisRecorder";
import { createRenderer } from "./render/renderer";
import { createSim } from "./sim/loop";
import { createWorkerBackend } from "./sim/detailBackend";
import { createWorkerHeavy } from "./sim/heavyBackend";
import { initRapier } from "./sim/structureWorld";
import { createPanel } from "./ui/params";
import { createProbeUI } from "./ui/probe";
import { computeReadout, mountReadout } from "./ui/readout";
import "./style.css";
import { mountRoughnessLegend } from "./ui/roughnessLegend";
import { createReportControl } from "./ui/report/runControl";
import type { ReportControl } from "./ui/report/runControl";
import { APP_VERSION, SPEC_DOCS } from "./ui/report/specFiles";
import { showReport } from "./ui/report/view";
import { specVersions } from "./sim/report/specDocs";

const app = document.getElementById("app")!;
// Member-level detail zone in a worker (Spec 09 slice B).
// Rapier for anything on this thread (the structure lab); heavy debris and the detail zone run
// in workers (Spec 04 v2.1, Spec 09).
await initRapier();
const sim = createSim({ heavy: (seed, _buildings, dt) => createWorkerHeavy(seed, dt) }, undefined, {}, (seed, buildings) => createWorkerBackend(seed, buildings));
const view = createRenderer(
  app,
  () => sim.world.buildings,
  () => sim.debris.pieces,
  () => ({ pieces: sim.debris.settled, dropped: sim.debris.settledDropped, version: sim.debris.settledVersion }),
  () => {
    const f = sim.detailFocus;
    return { view: sim.detail, spot: f ? { ...f, r: sim.detailSpotRadius } : null };
  },
);
// Layout columns (Spec 07 v1.10): panels in a column stack, so they can never cover each other.
const leftCol = document.createElement("div");
leftCol.className = "left-col";
document.body.appendChild(leftCol);
const bottomCol = document.createElement("div");
bottomCol.className = "bottom-col";
document.body.appendChild(bottomCol);
// Placing the detail spot: the next click on the ground.
let pickingSpot = false;
const spotHint = document.createElement("div");
spotHint.className = "probe-hint spot-hint";
spotHint.textContent = "Click the ground to place the detail spot";
spotHint.hidden = true;
document.body.appendChild(spotHint);
const detailStatus = document.createElement("div");
detailStatus.className = "detail-status";
detailStatus.hidden = true;
bottomCol.appendChild(detailStatus);
let roughLegend: ReturnType<typeof mountRoughnessLegend> | null = null;
// Storm report (Spec 16): made once the panel exists (it reads the repeat setting).
let reports: ReportControl | null = null;
let reportView: ReturnType<typeof showReport> | null = null;
const openReport = (report = reports!.current()) => {
  reportView = showReport(report);
};
const panel = createPanel(sim, (state) => {
  view.setFollow(state.follow);
  view.setLayers({ arrows: state.arrows, funnel: state.funnel, tracers: state.tracers, debris: state.debris, roughness: state.roughness });
  roughLegend?.setVisible(state.roughness);
  view.setDamageColors(state.damageColors);
  view.setDebrisScale(state.enlargeDebris ? 3 : 1);
  view.setBrightness(state.brightness);
}, {
  pickDetailSpot: () => {
    pickingSpot = true;
    spotHint.hidden = false;
  },
  viewDetailSpot: () => {
    const f = sim.detailFocus;
    if (!f) return;
    panel.state.follow = false;
    view.lookAt(f.x, f.z, Math.max(120, sim.detailSpotRadius * 2.2));
  },
  stopAndReport: () => {
    if (!reports || panel.waiting) return;
    openReport(reports.stopAndReport());
  },
  previewReport: () => {
    if (!reports || panel.waiting) return;
    openReport(reports.preview());
  },
  openReport: () => reports && openReport(),
  onRestart: () => {
    reportView?.close();
    reportView = null;
    reports?.reset();
  },
});
reports = createReportControl(sim, {
  autoRepeat: () => panel.state.autoRepeat,
  specs: SPEC_DOCS,
  recorder: { appVersion: APP_VERSION, specs: specVersions(SPEC_DOCS) },
  preset: () => panel.preset,
});
reports.onOffer = (on) => panel.setStopped(on);
// Panning or flying the camera stops it following the tornado (the panel checkbox shows it).
view.onCameraMoved(() => {
  panel.state.follow = false;
});
const readout = mountReadout(leftCol);
roughLegend = mountRoughnessLegend(leftCol);
roughLegend.setVisible(panel.state.roughness);
const recorders = new Map<Building, DebrisRecorder>();
const probe = createProbeUI(app, view, (x, z) => sim.world.buildingAt(x, z), (p) => {
  if (!pickingSpot) return false;
  pickingSpot = false;
  spotHint.hidden = true;
  sim.setDetailFocus({ x: p.x, z: p.z });
  return true;
}, { dock: leftCol, hint: bottomCol }, {
  // Record the debris reaching a pinned house, for replay in the structure lab (Spec 13).
  label: (b) => {
    const r = recorders.get(b);
    return r ? `⏹ Stop and save the debris recording (${r.count} pieces)` : "⏺ Record debris at this house";
  },
  run: (b) => {
    const r = recorders.get(b);
    if (r) {
      recorders.delete(b);
      const rec = r.stop();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(rec)], { type: "application/json" }));
      a.download = `debris-recording-house-${b.id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      return;
    }
    // The track's start (sim time 0), back along the straight track from where it is now.
    const s = sim.snapshot.tornado;
    const start = { x: s.center.x - s.velocity.x * sim.time, z: s.center.z - s.velocity.z * sim.time };
    const index = sim.world.buildings.indexOf(b);
    recorders.set(b, recordDebrisAt(sim, index, townWind(sim.params, start, b, "custom"), { seed: SIM_DEFAULTS.seed }));
  },
});

/** Seconds to wait after dissipation before repeating. */
const REPEAT_DELAY = 3;
let last = performance.now();
let readoutTimer = 0;
const simRate = new SimRateMeter();

function frame(now: number): void {
  const realDt = (now - last) / 1000;
  last = now;
  const f = sim.advance(realDt);
  simRate.push(realDt, f.curr.time);
  if (panel.state.autoRepeat && f.curr.phase === "dissipated" && f.curr.time > f.curr.lifetime + REPEAT_DELAY) {
    sim.reset();
  }
  // The end of the lifecycle stops the run and offers the report (Spec 16), unless repeat is on.
  reports?.tick();
  view.draw(f.prev, f.curr, f.alpha);
  probe.update(f.curr, panel.state.probeHeight);

  readoutTimer -= realDt;
  if (readoutTimer <= 0) {
    readout.update(computeReadout(f.curr));
    const n = sim.detail.houses.size;
    const slow = simRate.isSlow(sim.timeScale);
    const parts: string[] = [];
    if (n > 0) parts.push(`${n} house${n === 1 ? "" : "s"} in full structural detail`);
    if (panel.waiting) parts.push("Press 🌪 Spawn tornado to start");
    else if (sim.stopped) parts.push("Run ended · 📄 Open report in the Run panel, or ↻ Restart");
    else if (slow) parts.push(`slow motion${n > 0 ? " while they come apart" : ""} · ${rateText(simRate.rate!)}`);
    detailStatus.hidden = parts.length === 0;
    detailStatus.textContent = parts.join(" · ");
    readoutTimer = 0.1;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener("resize", () => view.resize(app.clientWidth, app.clientHeight));

if (import.meta.env.DEV) {
  Object.assign(window, { sim, view, reports });
}
