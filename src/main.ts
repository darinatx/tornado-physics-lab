import { createRenderer } from "./render/renderer";
import { createSim } from "./sim/loop";
import { createPanel } from "./ui/params";
import { createProbeUI } from "./ui/probe";
import { computeReadout, mountReadout } from "./ui/readout";
import "./style.css";

const app = document.getElementById("app")!;
const sim = createSim();
const view = createRenderer(app);
const panel = createPanel(sim, (state) => {
  view.setFollow(state.follow);
  view.setLayers({ arrows: state.arrows, funnel: state.funnel, tracers: state.tracers });
});
const readout = mountReadout(document.body);
const probe = createProbeUI(app, view);

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
    readoutTimer = 0.1;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener("resize", () => view.resize(app.clientWidth, app.clientHeight));

if (import.meta.env.DEV) {
  Object.assign(window, { sim, view });
}
