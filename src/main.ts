import { createRenderer } from "./render/renderer";
import { createSim } from "./sim/loop";
import { createWorkerBackend } from "./sim/detailBackend";
import { createPanel } from "./ui/params";
import { createProbeUI } from "./ui/probe";
import { computeReadout, mountReadout } from "./ui/readout";
import "./style.css";

const app = document.getElementById("app")!;
// Member-level detail zone in a worker (Spec 09 slice B).
const sim = createSim({}, undefined, {}, (seed) => createWorkerBackend(seed));
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
document.body.appendChild(detailStatus);
const panel = createPanel(sim, (state) => {
  view.setFollow(state.follow);
  view.setLayers({ arrows: state.arrows, funnel: state.funnel, tracers: state.tracers, debris: state.debris });
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
});
const readout = mountReadout(document.body);
const probe = createProbeUI(app, view, (x, z) => sim.world.buildingAt(x, z), (p) => {
  if (!pickingSpot) return false;
  pickingSpot = false;
  spotHint.hidden = true;
  sim.setDetailFocus({ x: p.x, z: p.z });
  return true;
});

/** Seconds to wait after dissipation before repeating. */
const REPEAT_DELAY = 3;
let last = performance.now();
let readoutTimer = 0;

function frame(now: number): void {
  const realDt = (now - last) / 1000;
  last = now;
  const f = sim.advance(realDt);
  if (panel.state.autoRepeat && f.curr.phase === "dissipated" && f.curr.time > f.curr.lifetime + REPEAT_DELAY) {
    sim.reset();
  }
  view.draw(f.prev, f.curr, f.alpha);
  probe.update(f.curr, panel.state.probeHeight);

  readoutTimer -= realDt;
  if (readoutTimer <= 0) {
    readout.update(computeReadout(f.curr));
    const n = sim.detail.houses.size;
    detailStatus.hidden = n === 0;
    detailStatus.textContent = `${n} house${n === 1 ? "" : "s"} in full structural detail${sim.detailLagging ? " · slow motion while they come apart" : ""}`;
    readoutTimer = 0.1;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener("resize", () => view.resize(app.clientWidth, app.clientHeight));

if (import.meta.env.DEV) {
  Object.assign(window, { sim, view });
}
