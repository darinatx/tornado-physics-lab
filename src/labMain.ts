/**
 * Structure lab (Spec 13): the real sim on a small layout, drawn by the main renderer, with the
 * town's inspector, a member inspector, the debris launcher, recording and replay.
 */
import GUI from "lil-gui";
import type { Controller } from "lil-gui";
import { DEBRIS_KINDS } from "./config/debris";
import type { DebrisKind } from "./config/debris";
import { LAB_LAYOUT, REFERENCE_MISSILES } from "./config/lab";
import { PRESETS } from "./config/presets";
import { SIM_DEFAULTS } from "./config/sim";
import { DETAIL, LAB } from "./config/structure";
import { allFailures } from "./core/damage/building";
import type { FailureRecord } from "./core/damage/types";
import { msToMph } from "./core/wind/efScale";
import { createRenderer } from "./render/renderer";
import type { MemberStyle } from "./render/detailLayer";
import type { DebrisRecorder, DebrisRecording } from "./sim/debrisRecorder";
import { createLab, roofWind, standoffFrom } from "./sim/lab";
import type { Lab, LabSetup, LabWind, ReplaySpec } from "./sim/lab";
import type { Aim } from "./sim/launcher";
import { createProbeUI } from "./ui/probe";
import { buildControlDefs } from "./ui/controls";
import { defaultParams } from "./sim/types";
import type { TornadoParams } from "./sim/types";
import type { MemberKind } from "./core/structure/framing";
import { rateText, SimRateMeter } from "./ui/simRate";
import "./style.css";

const LABELS: Record<string, string> = {
  wallFrame: "wall frame", wallSheet: "wall sheathing", pane: "window", garageDoor: "garage door", rafterPair: "rafters",
  roofSheet: "roof sheathing", roofShingle: "shingles", gableFrame: "gable end", partition: "interior wall", door: "door",
  drywall: "wall drywall", trim: "window/door trim", siding: "vinyl siding", sillPlate: "sill plate", ceiling: "ceiling drywall", fascia: "fascia",
};
const ROOF_KINDS = new Set(["rafterPair", "roofSheet", "roofShingle", "ceiling", "fascia"]);
const DEG = Math.PI / 180;

const app = document.getElementById("app")!;
const ui = {
  // Setup
  houses: 1,
  cls: "standard" as LabSetup["cls"],
  surroundings: "neighborhood" as LabSetup["surroundings"],
  density: 1,
  model: "detail" as NonNullable<LabSetup["model"]>,
  seed: 3,
  // Donors are always built: the launcher's real members come from them (Spec 13 v0.4).
  donors: true,
  // Wind
  mode: "steady" as "steady" | "pass",
  mph: 60,
  dir: 30,
  rampS: 0,
  preset: "ef3-strong",
  heading: 0,
  offset: 0,
  lifecycle: "full" as "mature" | "full",
  // Launcher
  missile: "astm-e",
  launchSpeed: 25,
  house: 1,
  aiming: false,
  streamKind: "shingle" as DebrisKind,
  streamRate: 10,
  streaming: false,
  // Replay
  replayHouse: "1",
  replayWind: "recorded" as ReplaySpec["wind"],
  // Time and view
  speed: 1,
  cutaway: false,
  utilization: false,
  follow: false,
  ringLog: false,
};

let lab: Lab;
let replay: ReplaySpec | undefined;
let recording: DebrisRecording | null = null;
let recorder: DebrisRecorder | null = null;
let building = false;
let framed = false;

/** The houses to draw: everything but the donors (bare slabs far away that only supply members). */
let drawn: { from: readonly unknown[] | null; list: readonly import("./core/damage/types").Building[] } = { from: null, list: [] };
const drawnBuildings = () => {
  const all = lab?.sim.world.buildings ?? [];
  if (drawn.from !== all) {
    const skip = new Set([lab?.donors.same, lab?.donors.other]);
    drawn = { from: all, list: all.filter((_, i) => !skip.has(i)) };
  }
  return drawn.list;
};
const view = createRenderer(
  app,
  drawnBuildings,
  () => lab?.sim.debris.pieces ?? [],
  () => (lab ? { pieces: lab.sim.debris.settled, dropped: lab.sim.debris.settledDropped, version: lab.sim.debris.settledVersion } : { pieces: [], dropped: 0, version: 0 }),
  () => (lab ? { view: lab.sim.detail, spot: null } : null),
);
view.setLayers({ arrows: false, funnel: true, tracers: true, debris: true });

const leftCol = document.createElement("div");
leftCol.className = "left-col";
document.body.appendChild(leftCol);
const bottomCol = document.createElement("div");
bottomCol.className = "bottom-col";
document.body.appendChild(bottomCol);
const info = document.createElement("div");
info.className = "readout";
leftCol.appendChild(info);
const memberCard = document.createElement("div");
memberCard.className = "pin-dock member-card";
memberCard.hidden = true;
leftCol.appendChild(memberCard);
const log = document.createElement("div");
log.className = "pin-dock lab-log";
leftCol.appendChild(log);
const status = document.createElement("div");
status.className = "detail-status";
bottomCol.appendChild(status);
const aimHint = document.createElement("div");
aimHint.className = "probe-hint spot-hint";
aimHint.textContent = "Click a lab house's wall, window or roof to aim";
aimHint.hidden = true;
document.body.appendChild(aimHint);

// --- Clicks: aim, member inspector, then the probe's pins -------------------
let inspected: { house: number; member: number } | null = null;
let consumed = false;
let down: { x: number; y: number } | null = null;
const ndc = (e: PointerEvent) => {
  const r = app.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
};
app.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY }));
app.addEventListener("pointerup", (e) => {
  consumed = false;
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || !lab) return;
  const n = ndc(e);
  const hit = view.pickMember(n.x, n.y);
  if (ui.aiming) {
    consumed = true;
    ui.aiming = false;
    aimHint.hidden = true;
    const target = hit && lab.block.includes(hit.house) ? hit : null;
    if (!target) return;
    // A house-local aim point on the surface clicked; launched along the reverse of its normal.
    const b = lab.sim.world.buildings[target.house]!;
    const c = Math.cos(b.yaw);
    const s = Math.sin(b.yaw);
    const dx = target.point.x - b.x;
    const dz = target.point.z - b.z;
    const local = { x: dx * c - dz * s, y: target.point.y, z: dx * s + dz * c };
    fire(target.house, { point: local });
    return;
  }
  if (hit && lab.block.includes(hit.house)) {
    inspected = hit;
    consumed = true;
  }
});
const probe = createProbeUI(app, view, (x, z) => lab?.sim.world.buildingAt(x, z) ?? null, () => consumed, { dock: leftCol, hint: bottomCol });

/** Fire the chosen missile at a lab house (reference missiles at their standard's speed; town
 *  pieces at 25 m/s), in square to the surface at a clicked point. */
function fire(house: number, aim: Aim): void {
  try {
    if (REFERENCE_MISSILES.some((m) => m.id === ui.missile)) {
      lab.fireMissile(ui.missile, house, aim);
      return;
    }
    if (ui.missile.startsWith("member:")) {
      // A real member from the donor, flying in full physics with the lab houses.
      lab.fireMember(ui.missile.slice(7) as MemberKind, house, aim, ui.launchSpeed);
      return;
    }
    const b = lab.sim.world.buildings[house]!;
    const from = "point" in aim ? standoffFrom(b, aim.point) : undefined;
    lab.launch({ source: "town", kind: ui.missile as DebrisKind, house, aim, ...(from ? { from } : {}), standoff: 10, speed: ui.launchSpeed, arrive: true });
  } catch (e) {
    aimHint.textContent = `Not fired: ${(e as Error).message}`;
    aimHint.hidden = false;
    setTimeout(() => ((aimHint.hidden = true), (aimHint.textContent = "Click a lab house's wall, window or roof to aim")), 2500);
  }
}

/** Real members the launcher can fire (Spec 13 v0.4). */
const MEMBER_MISSILES: [MemberKind, string][] = [
  ["roofSheet", "roof sheathing panel"],
  ["wallSheet", "wall sheathing panel"],
  ["siding", "siding course"],
  ["roofShingle", "shingle patch"],
  ["rafterPair", "rafter pair"],
  ["fascia", "fascia board"],
  ["door", "entry door"],
];

// --- Build -----------------------------------------------------------------
function setupNow(): LabSetup {
  return { houses: ui.houses, cls: ui.cls, surroundings: ui.surroundings, model: ui.model, seed: ui.seed, donors: ui.donors, density: ui.density };
}
function windNow(): LabWind {
  return ui.mode === "steady"
    ? { kind: "steady", keys: [{ t: 0, mph: ui.mph, dirDeg: ui.dir }] }
    : { kind: "pass", presetId: ui.preset, headingDeg: ui.heading, offset: ui.offset, lifecycle: ui.lifecycle, params: { ...tornado } };
}

/** The pass's tornado settings: the preset's, then whatever the user changed (Spec 13 v0.4). */
const TORNADO_KEYS = buildControlDefs().filter((d) => d.key !== "heading" && d.key !== "turnRate");
const tornado: Partial<TornadoParams> = {};
function loadPreset(id: string): void {
  const p = { ...defaultParams(), ...PRESETS.find((x) => x.id === id)!.params };
  for (const d of TORNADO_KEYS) (tornado as Record<string, number>)[d.key] = p[d.key] as number;
  tornado.rotation = p.rotation;
  tornado.tUp = p.tUp;
  tornado.tMature = p.tMature;
  tornado.tRope = p.tRope;
}
loadPreset(ui.preset);

const failSeen = new Set<FailureRecord>();
let detachLog: (() => void) | null = null;

async function build(r?: ReplaySpec): Promise<void> {
  if (building) return;
  building = true;
  replay = r;
  stopRecording(false);
  detachLog?.();
  lab?.dispose();
  log.innerHTML = "";
  log.hidden = true;
  failSeen.clear();
  inspected = null;
  ui.streaming = false;
  lab = await createLab(setupNow(), windNow(), {
    workers: true,
    passThrough: false,
    ...(r ? { replay: r } : {}),
  });
  // Lab houses' connection failures, as they arrive.
  detachLog = lab.sim.observe({
    detailFailure: (house, f) => {
      if (!lab.block.includes(house)) return;
      const m = f.con !== undefined ? lab.sim.detail.houses.get(house)?.framing.members[lab.sim.detail.houses.get(house)!.framing.connections[f.con]!.from] : undefined;
      const why = Number.isFinite(f.load) ? `${(f.load / 1000).toFixed(1)} kN > ${(f.capacity / 1000).toFixed(1)} kN` : "broken by an impact";
      logRow(`${lab.block.length > 1 ? `House ${house + 1} · ` : ""}${Math.round(f.mph)} mph · ${f.label}${m ? ` (${LABELS[m.kind] ?? m.kind})` : ""} · ${why}`);
    },
  });
  // Frame the view once, when the lab opens; rebuilds keep whatever view you have.
  if (!framed) {
    frameCamera();
    framed = true;
  }
  building = false;
}

function frameCamera(): void {
  const span = Math.ceil(Math.sqrt(ui.houses)) * LAB.lotSpacing;
  if (lab.wind.kind === "steady") {
    view.setView({ x: -22 - 0.6 * span, y: 12 + 0.45 * span, z: 26 + 0.8 * span }, { x: 0, y: 2.5, z: 0 });
    return;
  }
  // Look back up the track from beyond the block, so the tornado approaches in view.
  const s = lab.sim.snapshot.tornado;
  const v = Math.hypot(s.velocity.x, s.velocity.z) || 1;
  const dir = { x: s.velocity.x / v, z: s.velocity.z / v };
  const back = 70 + (ui.houses > 1 ? span : 0);
  view.setView({ x: dir.x * back - dir.z * 20, y: 5, z: dir.z * back + dir.x * 20 }, { x: -dir.x * 10, y: 24, z: -dir.z * 10 });
}

function logRow(text: string): void {
  const row = document.createElement("div");
  row.className = "p-row";
  row.textContent = text;
  log.prepend(row);
  log.hidden = false;
  while (log.childElementCount > 14) log.lastElementChild!.remove();
}

// --- Recording and files ---------------------------------------------------
function download(name: string, data: unknown): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function stopRecording(save: boolean): void {
  if (!recorder) return;
  const r = recorder.stop();
  recorder = null;
  recordCtl.name("⏺ Record debris at the house");
  if (save) {
    recording = r;
    download(`debris-recording-${r.pieces.length}.json`, r);
  }
}
const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = "application/json";
fileInput.onchange = async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  try {
    const r = JSON.parse(await f.text()) as DebrisRecording;
    if (!Array.isArray(r.pieces) || !r.wind) throw new Error("not a debris recording");
    recording = r;
    replayInfo.textContent = `${r.pieces.length} pieces · ${r.wind.kind === "pass" ? r.wind.presetId : "steady wind"} · ${Math.round(r.seconds)} s`;
  } catch (e) {
    replayInfo.textContent = `Couldn't read it: ${(e as Error).message}`;
  }
  fileInput.value = "";
};

// --- Panel -----------------------------------------------------------------
const gui = new GUI({ title: "Structure lab", width: 300 });
const tip = (c: Controller, t: string) => ((c.domElement.title = t), c);

const fSetup = gui.addFolder("Houses");
tip(fSetup.add(ui, "houses", 1, LAB.maxHouses, 1).name("Lab houses (more = slower)").onFinishChange(() => void build()), "Detailed houses in a block at 28 m lots, all in one physics world.");
fSetup.add(ui, "cls", { Weak: "weak", Standard: "standard", Strong: "strong" }).name("Construction").onChange(() => void build());
tip(fSetup.add(ui, "surroundings", { Neighborhood: "neighborhood", "Open field": "open" }).name("Surroundings").onChange(() => (densityCtl.enable(ui.surroundings === "neighborhood"), void build())), "Neighborhood: the town's houses on every lot within 130 m, which shed debris onto the block (suburban terrain).");
const densityCtl = tip(
  fSetup.add(ui, "density", LAB_LAYOUT.minDensity, LAB_LAYOUT.maxDensity, 0.05).name("Neighbor density (× town)").onFinishChange(() => void build()),
  "How closely the neighbors are packed. 1 = the town's lots (about 6.5 houses per hectare); 0.25 = a rural road with 46 m lots; 1.75 = dense infill. Houses keep their size; only the spacing changes.",
);
tip(fSetup.add(ui, "model", { "Detailed (members)": "detail", "Component (town model)": "component" }).name("Lab house model").onChange(() => void build()), "Compare the two house models in the same wind.");
fSetup.add(ui, "seed", 1, 9999, 1).name("Seed").onFinishChange(() => void build());
fSetup.add({ go: () => void build() }, "go").name("↻ Rebuild");

const fWind = gui.addFolder("Wind");
// Switching shows the mode's settings; nothing starts until its button is pressed.
fWind.add(ui, "mode", { "Steady wind": "steady", "Tornado pass": "pass" }).name("Wind").onChange(() => showWind());
const steadyCtls = [
  fWind.add(ui, "mph", 0, 250, 1).name("Wind speed (mph at 10 m)").onFinishChange(() => applySteady()),
  fWind.add(ui, "dir", 0, 359, 1).name("Wind toward (deg)").onFinishChange(() => applySteady()),
  tip(fWind.add(ui, "rampS", 0, 120, 1).name("Ramp over (s)"), "Changes ramp to the new value over this many seconds."),
  fWind.add({ go: () => void build() }, "go").name("↻ Rebuild in steady wind"),
];
const presetCtl = fWind
  .add(ui, "preset", Object.fromEntries(PRESETS.map((p) => [p.name, p.id])))
  .name("Tornado")
  .onChange((id: string) => {
    loadPreset(id);
    fTornado.controllersRecursive().forEach((c) => c.updateDisplay());
    presetCtl.name("Tornado");
  });
const passCtls = [
  presetCtl,
  fWind.add(ui, "heading", 0, 359, 1).name("Heading toward (deg)"),
  fWind.add(ui, "offset", -400, 400, 5).name("Block right of track (m)"),
  tip(fWind.add(ui, "lifecycle", { "Full lifecycle": "full", "Mature throughout": "mature" }).name("Lifecycle"), "Full: spin-up, mature, rope-out, timed so it passes the block mid-mature. Mature: full strength the whole way, starting where every house's roof wind is under 50 mph."),
  fWind.add({ go: () => void build() }, "go").name("🌪 Rebuild and send tornado"),
];
// The tornado's settings, from the preset; changing one makes it custom (Spec 13 v0.4).
const fTornado = gui.addFolder("Tornado settings");
fTornado.close();
const markCustom = () => presetCtl.name("Tornado (custom)");
for (const d of TORNADO_KEYS)
  tip(fTornado.add(tornado, d.key, d.min, d.max, d.step).name(`${d.label} (${d.unit})`).onChange(markCustom), d.help);
tip(fTornado.add(tornado, "rotation", { "Counter-clockwise (cyclonic)": 1, "Clockwise (anticyclonic)": -1 }).name("Spin").onChange(markCustom), "Nearly all Northern Hemisphere tornadoes spin counter-clockwise seen from above.");
for (const [key, label, max, help] of [
  ["tUp", "Forming time (s)", 300, "How long it takes to reach full strength (full lifecycle)."],
  ["tMature", "Full-strength time (s)", 900, "How long it stays at full strength (full lifecycle)."],
  ["tRope", "Dying time (s)", 300, "How long it takes to rope out (full lifecycle)."],
] as const)
  tip(fTornado.add(tornado, key, 5, max, 5).name(label).onChange(markCustom), help);
fTornado.add({ go: () => {
  loadPreset(ui.preset);
  fTornado.controllersRecursive().forEach((c) => c.updateDisplay());
  presetCtl.name("Tornado");
} }, "go").name("↺ Back to the preset's settings");

function showWind(): void {
  for (const c of steadyCtls) c.show(ui.mode === "steady");
  for (const c of passCtls) c.show(ui.mode === "pass");
  fTornado.show(ui.mode === "pass");
}
function applySteady(): void {
  if (!lab || lab.wind.kind !== "steady") return;
  lab.setSteady(ui.mph, ui.dir, { rampS: ui.rampS });
}
showWind();

const fLaunch = gui.addFolder("Debris launcher");
const missileOptions: Record<string, string> = {};
for (const m of REFERENCE_MISSILES) missileOptions[m.name] = m.id;
for (const [k, label] of MEMBER_MISSILES) missileOptions[`Real member: ${label}`] = `member:${k}`;
for (const [k, d] of Object.entries(DEBRIS_KINDS)) missileOptions[`Town piece: ${d.label}`] = k;
fLaunch.add(ui, "missile", missileOptions).name("Missile");
tip(fLaunch.add(ui, "launchSpeed", 2, 80, 1).name("Speed (m/s, not standard missiles)"), "Arrival speed for real members and town pieces; standard missiles fly at their test speed.");
const houseCtl = fLaunch.add(ui, "house", 1, LAB.maxHouses, 1).name("At house");
fLaunch.add({ aim: () => ((ui.aiming = true), (aimHint.hidden = false)) }, "aim").name("🎯 Click a surface to fire");
fLaunch.add({ go: () => lab && fire(Math.min(ui.house, lab.block.length) - 1, firstPane()) }, "go").name("Fire at a window");
fLaunch.add(ui, "streamKind", Object.fromEntries(Object.entries(DEBRIS_KINDS).map(([k, d]) => [d.label, k]))).name("Stream piece");
fLaunch.add(ui, "streamRate", 1, 40, 1).name("Stream rate (per s)").onFinishChange(() => ui.streaming && startStream());
const streamCtl = fLaunch.add(ui, "streaming").name("Stream from upwind").onChange(() => (ui.streaming ? startStream() : lab.stream(null)));

function startStream(): void {
  lab.stream({ kind: ui.streamKind, rate: ui.streamRate, house: Math.min(ui.house, lab.block.length) - 1, face: "windward" });
}
function firstPane(): Aim {
  const b = lab.sim.world.buildings[Math.min(ui.house, lab.block.length) - 1]!;
  // The window on the face toward the camera's side of the house, else the first one.
  return { pane: Math.max(0, b.panes.findIndex((p) => b.panels[p.panel]!.face === 3)) };
}

const fRecord = gui.addFolder("Record and replay");
const recordCtl = fRecord
  .add({ go: () => {
    if (recorder) return stopRecording(true);
    recorder = lab.recordDebris(Math.min(ui.house, lab.block.length) - 1);
    recordCtl.name("⏹ Stop and save the recording");
  } }, "go")
  .name("⏺ Record debris at the house");
fRecord.add({ go: () => fileInput.click() }, "go").name("📂 Load a recording…");
const replayInfo = document.createElement("div");
replayInfo.className = "preset-desc";
replayInfo.textContent = "No recording loaded";
fRecord.domElement.querySelector(".children")!.appendChild(replayInfo);
fRecord.add(ui, "replayHouse", { "House 1": "1", "House 2": "2", "House 3": "3", "House 4": "4", "Block center": "block" }).name("Replay onto");
fRecord.add(ui, "replayWind", { "Recorded wind": "recorded", "Debris only (no wind)": "none", "Lab wind": "lab" }).name("Replay wind");
fRecord.add({ go: () => {
  if (!recording) return (replayInfo.textContent = "Load or record a recording first");
  const h = ui.replayHouse === "block" ? "block" : Math.min(Number(ui.replayHouse), ui.houses) - 1;
  void build({ recording, house: h, wind: ui.replayWind });
} }, "go").name("▶ Replay (rebuilds, no neighbors)");
fRecord.add({ go: () => lab && download("lab-record.json", lab.record()) }, "go").name("⬇ Export run record");

const fTime = gui.addFolder("Time and view");
fTime.add(ui, "speed", { Paused: 0, "0.25×": 0.25, "0.5×": 0.5, "1×": 1, "2×": 2, "4×": 4 }).name("Sim speed");
fTime.add({ go: () => {
  if (!lab) return;
  ui.speed = 0;
  lab.sim.setTimeScale(1);
  lab.sim.advance(DETAIL.stepEvery * SIM_DEFAULTS.dt);
  lab.sim.setTimeScale(0);
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
} }, "go").name("⏭ Step (1/60 s)");
fTime.add(ui, "cutaway").name("Cutaway (hide roof)").onChange(applyStyle);
tip(fTime.add(ui, "utilization").name("Utilization colors").onChange(applyStyle), "Attached members colored by their most loaded connection: load / capacity, green 0 → red 1.");
fTime.add(ui, "follow").name("Follow tornado").onChange((v: boolean) => view.setFollow(v));
fTime.add(ui, "ringLog").name("Log neighborhood failures");
gui.add({ back: () => (location.search = "") }, "back").name("← Back to simulator");

function utilColor(u: number): number {
  const k = Math.max(0, Math.min(1, u));
  const r = Math.round(255 * Math.min(1, 2 * k));
  const g = Math.round(255 * Math.min(1, 2 * (1 - k)));
  return (r << 16) | (g << 8) | 40;
}
function applyStyle(): void {
  if (!ui.cutaway && !ui.utilization) return view.setMemberStyle(null);
  const style: MemberStyle = (house, member) => {
    const h = lab?.sim.detail.houses.get(house);
    if (!h || !lab.block.includes(house)) return null;
    const ins = lab.sim.detail.inspection.get(house);
    const attached = ins ? ins.attached[member] === 1 : true;
    const out: { hidden?: boolean; color?: number } = {};
    if (ui.cutaway && attached && ROOF_KINDS.has(h.framing.members[member]!.kind)) out.hidden = true;
    if (ui.utilization && attached && ins) {
      let u = 0;
      for (const c of h.framing.supportsOf[member]!) {
        const cap = h.framing.connections[c]!.capacity;
        if (cap > 0) u = Math.max(u, ins.loads[c]! / cap);
      }
      out.color = utilColor(u);
    }
    return out;
  };
  view.setMemberStyle(style);
}

// --- Frame loop ------------------------------------------------------------
const simRate = new SimRateMeter();
let last = performance.now();
let slowTimer = 0;
function frame(now: number): void {
  const realDt = (now - last) / 1000;
  last = now;
  if (lab && !building) {
    lab.sim.setTimeScale(ui.speed);
    houseCtl.max(lab.block.length);
    if (ui.house > lab.block.length) ui.house = lab.block.length;
    streamCtl.updateDisplay();
    const f = lab.sim.advance(realDt);
    simRate.push(realDt, f.curr.time);
    view.draw(f.prev, f.curr, f.alpha);
    probe.update(f.curr, 3);
    slowTimer -= realDt;
    if (slowTimer <= 0) {
      slowTimer = 0.2;
      updateInfo();
      if (ui.ringLog) ringFailures();
    }
  }
  requestAnimationFrame(frame);
}

function updateInfo(): void {
  const sim = lab.sim;
  const s = sim.snapshot.tornado;
  let roof = 0;
  let near = Infinity;
  let broken = 0;
  for (const i of lab.block) {
    const b = sim.world.buildings[i]!;
    roof = Math.max(roof, msToMph(roofWind(sim, b)));
    near = Math.min(near, Math.hypot(b.x - s.center.x, b.z - s.center.z));
    broken += (b.detailFailures ?? []).reduce((a, g) => a + g.count, 0) || (b.detail ? 0 : allFailures(b).length);
  }
  const many = lab.block.length > 1;
  const steady = !!s.tunnel;
  const passLine = steady ? "" : sim.snapshot.phase === "dissipated" ? `<div class="phase">Tornado has passed · calm</div>` : `<div class="phase">Tornado ${Math.round(near)} m ${many ? "from the nearest house" : "away"} · core radius ${Math.round(s.rMax)} m</div>`;
  info.innerHTML = `<div class="ef" style="font-size:28px">${Math.round(roof)} mph</div>
    <div class="phase">${many ? "strongest wind at roof height" : "wind at roof height"}${steady ? ` · steady ${Math.round(msToMph(s.tunnel!.u10))} mph at 10 m` : ""}</div>${passLine}
    <div class="phase">${lab.block.length} lab house${many ? "s" : ""}${lab.ring.length ? ` · ${lab.ring.length} neighbors` : ""}${replay ? " · replay" : ""} · t = ${sim.time.toFixed(1)} s</div>
    <div class="phase">${broken} ${lab.setup.model === "component" ? "component failures" : "connections broken"} · ${lab.launcher.launched.length} launched${recorder ? ` · recording ${recorder.count} pieces` : ""}</div>`;
  const lag = sim.detailLagging;
  status.hidden = !lag && ui.speed !== 0;
  status.textContent = ui.speed === 0 ? "Paused" : `Slow motion while they come apart${simRate.rate !== null ? ` · ${rateText(simRate.rate)}` : ""}`;
  updateMemberCard();
}

function updateMemberCard(): void {
  const m = inspected ? lab.memberInfo(inspected.house, inspected.member) : null;
  memberCard.hidden = !m;
  if (!m) return;
  const rows = m.connections
    .map((c) => {
      const pct = Math.round(c.utilization * 100);
      const state = c.failed ? `failed at ${c.failed.time.toFixed(1)} s, ${Math.round(c.failed.mph)} mph${Number.isFinite(c.failed.load) ? ` (${(c.failed.load / 1000).toFixed(2)} kN)` : " (impact)"}` : c.intact ? `${(c.load / 1000).toFixed(2)} / ${(c.capacity / 1000).toFixed(2)} kN · ${pct}%` : "gone (its member came off)";
      return `<div class="p-row"><b>${c.label}</b> → ${c.to < 0 ? "slab" : LABELS[c.toKind] ?? c.toKind}<br>${state}</div>`;
    })
    .join("");
  memberCard.innerHTML = `<div class="pin-head"><span>${lab.block.length > 1 ? `House ${m.house + 1} · ` : ""}${LABELS[m.kind] ?? m.kind} #${m.member}</span><button type="button" class="pin-clear">×</button></div>
    <div class="p-row">${m.mass.toFixed(1)} kg · ${m.attached ? `attached · highest utilization ${Math.round(m.utilization * 100)}%` : "loose"}</div>${rows || '<div class="p-row">No connections of its own (carried by others)</div>'}`;
  memberCard.querySelector<HTMLButtonElement>(".pin-clear")!.onclick = () => (inspected = null);
}

function ringFailures(): void {
  for (const i of lab.ring) {
    const b = lab.sim.world.buildings[i]!;
    for (const f of allFailures(b)) {
      if (failSeen.has(f)) continue;
      failSeen.add(f);
      logRow(`Neighbor ${i - lab.block.length + 1} · ${Math.round(f.mph)} mph · ${f.part} ${f.index}${f.cause ? ` (${f.cause})` : ""}`);
    }
  }
}

window.addEventListener("resize", () => view.resize(app.clientWidth, app.clientHeight));
void build().then(() => requestAnimationFrame(frame));
if (import.meta.env.DEV) Object.assign(window, { lab: () => lab, labUi: ui, labView: view, labStyle: applyStyle });
void DEG;
