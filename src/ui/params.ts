/** Control panel (Spec 07 v1.3): presets, basic controls, display, run, advanced physics. */
import GUI from "lil-gui";
import type { Controller } from "lil-gui";
import { DEFAULT_PRESET_ID, PRESETS } from "../config/presets";
import { TIME_SCALES } from "../config/sim";
import type { Sim } from "../sim/loop";
import { defaultParams } from "../sim/types";
import { buildControlDefs } from "./controls";
import { DEFAULT_PANEL_STATE } from "./panelDefaults";
import type { PanelState } from "./panelDefaults";
import { createSpawnGate } from "./spawnGate";

export type { PanelState } from "./panelDefaults";

export interface Panel {
  readonly state: PanelState;
  /** The tornado is waiting to be spawned (INST-17). */
  readonly waiting: boolean;
  dispose(): void;
}

const CUSTOM = "custom";

function tip(c: Controller, text: string): Controller {
  c.domElement.title = text;
  return c;
}

export function createPanel(
  sim: Sim,
  onChange: (state: PanelState) => void,
  actions: { pickDetailSpot?: () => void; viewDetailSpot?: () => void } = {},
): Panel {
  const gui = new GUI({ title: "Tornado controls", width: 300 });
  const values = { ...sim.params } as Record<string, unknown>;
  const state: PanelState = { ...DEFAULT_PANEL_STATE };
  const controllers: Controller[] = [];

  // --- Preset --------------------------------------------------------------
  const presetChoice = { preset: DEFAULT_PRESET_ID as string };
  const presetOptions: Record<string, string> = { Custom: CUSTOM };
  for (const p of PRESETS) presetOptions[p.name] = p.id;
  let applyingPreset = false;
  // The tornado waits until it's spawned (INST-17).
  const gate = createSpawnGate(sim, 1);
  const spawnCtl = tip(
    gui.add({ spawn: () => gate.spawn() }, "spawn").name("🌪 Spawn tornado"),
    "Start the tornado. The town waits in calm air until you do; Restart and a new preset wait again.",
  );
  gate.onChange = (waiting) => {
    spawnCtl.enable(waiting);
    spawnCtl.name(waiting ? "🌪 Spawn tornado" : "🌪 Tornado running");
  };
  const presetCtl = tip(
    gui.add(presetChoice, "preset", presetOptions).name("Preset"),
    "Pick a ready-made tornado. Each is a realistic example of its EF rating.",
  );
  const descEl = document.createElement("div");
  descEl.className = "preset-desc";
  presetCtl.domElement.after(descEl);

  function applyPreset(id: string): void {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    applyingPreset = true;
    const next = { ...defaultParams(), heading: sim.params.heading, ...p.params };
    Object.assign(values, next);
    sim.setParams(next);
    sim.reset();
    gate.wait();
    for (const c of controllers) c.updateDisplay();
    descEl.textContent = p.description;
    applyingPreset = false;
  }
  presetCtl.onChange((id: string) => {
    if (id === CUSTOM) descEl.textContent = "Your own settings.";
    else applyPreset(id);
  });
  const markCustom = () => {
    if (applyingPreset) return;
    presetChoice.preset = CUSTOM;
    presetCtl.updateDisplay();
    descEl.textContent = "Your own settings.";
  };
  tip(
    gui.add({ restart: () => (sim.reset(), gate.wait()) }, "restart").name("↻ Restart tornado"),
    "Start this tornado over from the beginning. It waits until you spawn it.",
  );
  if (actions.pickDetailSpot)
    tip(
      gui.add({ spot: actions.pickDetailSpot }, "spot").name("📍 Pick detail spot"),
      "Click the ground to choose where houses get full structural detail: the ~30 houses there are built from real framing and torn apart by the physics as the tornado passes. The sim slows down while they're coming apart.",
    );
  if (actions.viewDetailSpot)
    tip(gui.add({ view: actions.viewDetailSpot }, "view").name("🎥 View detail spot"), "Move the camera close to the detail spot (turns off camera follow).");
  tip(
    gui.add({ lab: () => (location.search = "?lab") }, "lab").name("🔬 Structure lab"),
    "Open one house built from real framing (studs, rafters, sheathing, windows) with breakable connections and full rigid-body physics.",
  );

  // --- Basic & advanced sliders ---------------------------------------------
  const basic = gui.addFolder("Basic");
  const advanced = gui.addFolder("Advanced physics");
  for (const d of buildControlDefs()) {
    const folder = d.group === "Basic" ? basic : advanced;
    const unit = d.unit === "–" ? "" : ` (${d.unit})`;
    const c = folder
      .add(values, d.key, d.min, d.max, d.step)
      .name(d.label + unit)
      .onChange((v: number) => {
        sim.setParams({ [d.key]: v });
        markCustom();
      });
    controllers.push(tip(c, d.help));
  }
  controllers.push(
    tip(
      advanced
        .add(values, "terrain", { "Open country": "open", Suburban: "suburban", Urban: "urban" })
        .name("Ground roughness")
        .onChange((v: "open" | "suburban" | "urban") => {
          sim.setParams({ terrain: v });
          markCustom();
        }),
      "Rougher ground (towns, cities) slows the wind near the ground more than open fields.",
    ),
    tip(
      advanced
        .add(values, "rotation", { "Counter-clockwise (normal)": 1, "Clockwise (rare)": -1 })
        .name("Spin direction")
        .onChange((v: number) => {
          sim.setParams({ rotation: v === -1 ? -1 : 1 });
          markCustom();
        }),
      "Nearly all Northern Hemisphere tornadoes spin counter-clockwise seen from above.",
    ),
  );
  for (const [key, label, max, help] of [
    ["tUp", "Forming time (s)", 300, "How long the tornado takes to reach full strength."],
    ["tMature", "Full-strength time (s)", 900, "How long it stays at full strength."],
    ["tRope", "Dying time (s)", 300, "How long it takes to rope out and dissipate."],
  ] as const) {
    controllers.push(
      tip(
        advanced.add(values, key, 5, max, 5).name(label).onChange((v: number) => {
          sim.setParams({ [key]: v });
          markCustom();
        }),
        help,
      ),
    );
  }
  advanced.close();

  // --- Display ---------------------------------------------------------------
  const display = gui.addFolder("Display");
  const emit = () => onChange(state);
  tip(
    display.add(state, "brightness", 0.5, 2, 0.05).name("Brightness").onChange(emit),
    "Scene brightness. Real tornado light is often dim under the storm; raise this to see detail.",
  );
  tip(display.add(state, "funnel").name("Funnel cloud").onChange(emit), "The visible condensation funnel, shaped by the tornado's pressure drop.");
  tip(display.add(state, "tracers").name("Dust").onChange(emit), "Fine dust carried by the wind.");
  tip(
    display.add(state, "debris").name("Flying debris").onChange(emit),
    "Pieces of failed houses (shingles, plywood, lumber, glass) flying with real mass, drag and lift.",
  );
  tip(
    display.add(state, "enlargeDebris").name("Enlarge debris ×3").onChange(emit),
    "Draws small debris (shingles, siding, glass, lumber) 3× its real size so it's visible from a distance. Wall panels and roof sections are always real size. Display only: the physics always uses real sizes and masses.",
  );
  tip(
    display.add(state, "damageColors").name("Damage colors").onChange(emit),
    "Tint houses by damage rating: yellow (minor) → orange → red → purple (swept away). Off shows their real colors.",
  );
  tip(display.add(state, "arrows").name("Wind arrows").onChange(emit), "Arrows showing wind direction and speed at 10 m, colored by EF rating.");
  tip(
    display.add(state, "probeHeight", 2, 200, 1).name("Probe height (m)").onChange(emit),
    "Height above the ground where the inspect probe measures. Hover over the ground to inspect; click to pin.",
  );

  // --- Run -------------------------------------------------------------------
  const run = { speed: 1 };
  const gateSpeed = (k: number) => gate.setSpeed(k);
  const runFolder = gui.addFolder("Run");
  tip(
    runFolder
      .add(run, "speed", Object.fromEntries(TIME_SCALES.map((k) => [k === 0 ? "Paused" : `${k}×`, k])))
      .name("Sim speed")
      .onChange(gateSpeed),
    "Speed up, slow down or pause the simulation.",
  );
  tip(runFolder.add(state, "follow").name("Camera follows tornado").listen().onChange(emit), "Keep the camera centered on the tornado.");
  tip(runFolder.add(state, "autoRepeat").name("Repeat when it dissipates"), "Start the tornado again a few seconds after it dies.");

  applyPreset(DEFAULT_PRESET_ID);

  return {
    state,
    /** Whether the tornado is waiting to be spawned (INST-17). */
    get waiting() {
      return gate.waiting;
    },
    dispose: () => gui.destroy(),
  };
}
