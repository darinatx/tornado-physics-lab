/**
 * Structure lab (Spec 09 slice A): a block of member-level houses in steady wind or a tornado pass.
 */
import GUI from "lil-gui";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PRESETS } from "./config/presets";
import { RENDER } from "./config/render";
import { LAB, LUMBER, SLAB_TOP } from "./config/structure";
import { msToMph } from "./core/wind/efScale";
import { createEnvironment } from "./render/environment";
import { createDustLayer } from "./render/dust";
import { createFunnel } from "./render/funnel";
import { createStructureView } from "./render/structureView";
import { initRapier, LAB_DT, labHouses, StructureLab } from "./sim/structureLab";
import "./style.css";

const LABELS: Record<string, string> = {
  wallFrame: "wall frame",
  wallSheet: "wall sheathing",
  pane: "window",
  garageDoor: "garage door",
  rafterPair: "rafters",
  roofSheet: "roof sheathing",
  roofShingle: "shingles",
  gableFrame: "gable end",
  partition: "interior wall",
  door: "door",
  drywall: "wall drywall",
  trim: "window/door trim",
  siding: "vinyl siding",
  sillPlate: "sill plate",
  ceiling: "ceiling drywall",
  fascia: "fascia",
};

async function start(): Promise<void> {
  await initRapier();
  const app = document.getElementById("app")!;
  // Logarithmic depth: debris lies millimetres apart on the ground, far from the camera.
  const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(app.clientWidth, app.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  app.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const env = createEnvironment(scene);
  env.update({ x: 0, z: 0 }, 60, 900);
  const camera = new THREE.PerspectiveCamera(50, app.clientWidth / app.clientHeight, 0.2, 20000);
  camera.position.set(-22, 12, 26);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 2.5, 0);
  controls.enableDamping = true;
  // Allow looking up (a funnel hangs from the cloud base hundreds of metres up); the camera
  // itself is kept above the ground each frame.
  controls.maxPolarAngle = Math.PI * 0.8;

  const state = {
    mph: 60,
    dir: 30,
    ramp: false,
    rampRate: 1,
    cls: "standard" as "weak" | "standard" | "strong",
    speed: 1,
    cutaway: false,
    houses: 1,
    preset: "ef3-strong",
    heading: 0,
    offset: 0,
  };
  const funnel = createFunnel();
  scene.add(funnel.mesh);
  const dust = createDustLayer(RENDER.labTracerCount, RENDER.labTracerSize, 99, "core");
  scene.add(dust.points);
  // Cutaway: hide the roof and ceiling while they're still on the house (view only).
  const ROOF_KINDS = new Set(["rafterPair", "roofSheet", "roofShingle", "ceiling", "fascia"]);
  let lab: StructureLab;
  let views: ReturnType<typeof createStructureView>[] = [];
  let slabs: THREE.Mesh[] = [];
  const slabGeo = new THREE.BoxGeometry(1, 1, 1);
  const slabMat = new THREE.MeshLambertMaterial({ color: 0x9a978f });
  let builtCount = 0;
  /** Block size across (m), for camera framing. */
  const blockSpan = () => Math.ceil(Math.sqrt(state.houses)) * LAB.lotSpacing;

  function build(): void {
    for (const v of views) scene.remove(v.group);
    for (const m of slabs) scene.remove(m);
    lab?.dispose();
    lab = new StructureLab(labHouses(state.houses, state.cls));
    views = lab.houses.map((h) => {
      const v = createStructureView(h.framing);
      scene.add(v.group);
      return v;
    });
    // Slab edges flush with the wall frames' outer face, turned with each house.
    slabs = lab.houses.map(({ building: b }) => {
      const m = new THREE.Mesh(slabGeo, slabMat);
      m.scale.set(b.width + LUMBER.stud[1], SLAB_TOP, b.depth + LUMBER.stud[1]);
      m.position.set(b.x, SLAB_TOP / 2, b.z);
      m.rotation.y = b.yaw;
      scene.add(m);
      return m;
    });
    if (builtCount !== state.houses) {
      // Frame the whole block.
      const e = state.houses > 1 ? blockSpan() : 0;
      camera.position.set(-22 - 0.6 * e, 12 + 0.45 * e, 26 + 0.8 * e);
      controls.target.set(0, 2.5, 0);
      builtCount = state.houses;
    }
    log.innerHTML = "";
    lastLogged = lab.houses.map(() => 0);
  }

  // Panel.
  const gui = new GUI({ title: "Structure lab" });
  const steady = gui.addFolder("Steady wind");
  steady.add(state, "mph", 0, 250, 1).name("Wind speed (mph)").listen();
  steady.add(state, "dir", 0, 359, 1).name("Wind toward (deg)");
  steady.add(state, "ramp").name("Ramp wind up");
  steady.add(state, "rampRate", 0.2, 5, 0.1).name("Ramp rate (mph/s)");
  const pass = gui.addFolder("Tornado pass");
  pass.add(state, "preset", Object.fromEntries(PRESETS.map((p) => [p.name, p.id]))).name("Tornado");
  pass.add(state, "heading", 0, 359, 1).name("Heading toward (deg)");
  pass.add(state, "offset", -400, 400, 5).name("House right of track (m)");
  pass
    .add(
      {
        go: () => {
          build();
          lab.startTornado({ presetId: state.preset, headingDeg: state.heading, offset: state.offset });
          // Look back up the track from beyond the house, so the tornado approaches in view.
          const a = (state.heading * Math.PI) / 180;
          const dir = { x: Math.cos(a), z: -Math.sin(a) };
          const b = lab.blockCenter;
          const back = 70 + (state.houses > 1 ? blockSpan() : 0);
          // Far and low enough, tilted up, to keep the cloud-base funnel in frame with the houses.
          camera.position.set(b.x + dir.x * back - dir.z * 20, 5, b.z + dir.z * back + dir.x * 20);
          controls.target.set(b.x - dir.x * 10, 24, b.z - dir.z * 10);
        },
      },
      "go",
    )
    .name("🌪 Rebuild houses and send tornado");
  pass.add({ stop: () => lab.stopTornado() }, "stop").name("■ Stop tornado (back to steady wind)");
  gui.add(state, "houses", 1, LAB.maxHouses, 1).name("Houses (more = slower)").onFinishChange(build);
  gui.add(state, "cls", { Weak: "weak", Standard: "standard", Strong: "strong" }).name("Construction").onChange(build);
  gui.add(state, "speed", { Paused: 0, "0.25×": 0.25, "0.5×": 0.5, "1×": 1, "2×": 2, "4×": 4 }).name("Sim speed");
  gui.add(state, "cutaway").name("Cutaway (hide roof)");
  gui.add({ reset: () => build() }, "reset").name("↻ Rebuild houses");
  gui.add({ back: () => (location.search = "") }, "back").name("← Back to simulator");

  const info = document.createElement("div");
  info.className = "readout";
  document.body.appendChild(info);
  const log = document.createElement("div");
  log.className = "pin-dock lab-log";
  document.body.appendChild(log);
  let lastLogged: number[] = [];

  build();

  let last = performance.now();
  let acc = 0;
  function frame(now: number): void {
    const real = Math.min((now - last) / 1000, 0.1);
    last = now;
    const passing = !!lab.tornado || lab.passDone;
    if (!passing && state.ramp && state.speed > 0) state.mph = Math.min(250, state.mph + state.rampRate * real * state.speed);
    lab.setWind(state.mph, state.dir);
    acc += real * state.speed;
    // Don't fall ever further behind when the physics is heavier than real time.
    acc = Math.min(acc, 8 * LAB_DT * Math.max(state.speed, 1));
    while (acc >= LAB_DT) {
      lab.step();
      acc -= LAB_DT;
    }
    if (lab.tornado) {
      const cloudBase = PRESETS.find((p) => p.id === state.preset)!.params.cloudBase ?? 450;
      env.update(lab.tornado.center, lab.tornado.rMax, cloudBase);
      funnel.update(lab.tornado, cloudBase, lab.time);
      dust.points.visible = true;
      dust.update(lab.time, lab.tornado, "open", cloudBase);
    } else {
      env.update({ x: 0, z: 0 }, 60, 900);
      funnel.mesh.visible = false;
      if (dust.points.visible) dust.clear();
      dust.points.visible = false;
    }
    lab.houses.forEach((h, i) =>
      views[i]!.update(
        (id) => h.memberPose(id),
        (id) => !!h.lost[id] || (state.cutaway && h.isAttached(id) && ROOF_KINDS.has(h.framing.members[id]!.kind)),
      ),
    );
    controls.update();
    if (camera.position.y < 1.5) camera.position.y = 1.5;
    renderer.render(scene, camera);

    // Strongest roof-height wind and nearest tornado distance over the block.
    let roofMph = 0;
    let near = Infinity;
    const t = lab.tornado;
    let members = 0;
    let connections = 0;
    let broken = 0;
    let pieces = 0;
    let moving = 0;
    for (const h of lab.houses) {
      const b = h.building;
      const w = lab.wind.at({ x: b.x, y: b.roofHeight, z: b.z });
      roofMph = Math.max(roofMph, msToMph(Math.hypot(w.x, w.y, w.z)));
      if (t) near = Math.min(near, Math.hypot(b.x - t.center.x, b.z - t.center.z));
      members += h.framing.members.length;
      connections += h.framing.connections.length;
      broken += h.failures.length;
      pieces += h.groupBodies.size;
      moving += h.movingGroups;
    }
    const many = lab.houses.length > 1;
    const passLine = t
      ? `<div class="phase">Tornado ${Math.round(near)} m ${many ? "from the nearest house" : "away"} · core radius ${Math.round(t.rMax)} m</div>`
      : lab.passDone
        ? `<div class="phase">Tornado has passed · calm</div>`
        : "";
    info.innerHTML = `<div class="ef" style="font-size:28px">${Math.round(passing ? roofMph : state.mph)} mph</div>
      <div class="phase">${passing ? (many ? "strongest wind at roof height" : "wind at roof height") : "steady wind"}</div>${passLine}
      <div class="phase">${many ? `${lab.houses.length} houses · ` : ""}${members} members · ${connections} connections</div>
      <div class="phase">${broken} connections broken · ${pieces} loose pieces (${moving} moving)</div>`;
    // New failures from every house, oldest first, so the newest ends on top.
    const fresh: { f: (typeof lab.failures)[number]; i: number }[] = [];
    lab.houses.forEach((h, i) => {
      for (const f of h.failures.slice(lastLogged[i] ?? 0)) fresh.push({ f, i });
      lastLogged[i] = h.failures.length;
    });
    if (fresh.length) {
      fresh.sort((a, b) => a.f.time - b.f.time || a.i - b.i);
      for (const { f, i } of fresh.slice(-14)) {
        const row = document.createElement("div");
        row.className = "p-row";
        row.textContent = `${many ? `House ${i + 1} · ` : ""}${Math.round(f.mph)} mph · ${f.label} (${LABELS[f.member] ?? f.member}) · ${(f.load / 1000).toFixed(1)} kN > ${(f.capacity / 1000).toFixed(1)} kN`;
        log.prepend(row);
      }
      while (log.childElementCount > 14) log.lastElementChild!.remove();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.addEventListener("resize", () => {
    camera.aspect = app.clientWidth / app.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(app.clientWidth, app.clientHeight);
  });
  if (import.meta.env.DEV) Object.assign(window, { lab: () => lab, labState: state });
}

void start();
