/** Inspect probe: hover tooltip and pinned probes with history (Spec 07 v1.3). */
import { PA_PER_PSF } from "../config/atmosphere";
import { RECORD_WIND_MS } from "../config/wind";
import { buildingReport } from "../core/damage/building";
import type { BuildingReport } from "../core/damage/building";
import type { Building } from "../core/damage/types";
import type { Vec3 } from "../core/math/vec";
import { probeAt } from "../core/wind/probe";
import type { ProbeReading } from "../core/wind/probe";
import { BELOW_EF0_COLOR, EF_COLORS } from "../render/arrowStyle";
import { DOD_COLORS } from "../render/houses";
import type { SimRenderer } from "../render/renderer";
import type { SimSnapshot } from "../sim/types";
import { History } from "./history";

const MAX_PINS = 4;
const HISTORY_SECONDS = 60;
const HISTORY_INTERVAL = 0.25;
const PIN_COLORS = [0x4fd1ff, 0xffb84f, 0xb388ff, 0x7dff9a];
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
const efColor = (r: ProbeReading) => hex(r.ef === null ? BELOW_EF0_COLOR : EF_COLORS[r.ef]);

function fmt(r: ProbeReading): string {
  const ef = r.ef === null ? "Below EF0" : `EF${r.ef}`;
  const dir = COMPASS[Math.round(r.fromDeg / 22.5) % 16];
  const inOut = r.radial < 0 ? "in" : "out";
  const upDown = r.vertical >= 0 ? "up" : "down";
  const side = r.side === "center" ? "on the path line" : `${r.side} of path`;
  const q = r.dynamicPressure;
  const qStr = q >= 1000 ? `${(q / 1000).toFixed(2)} kPa` : `${Math.round(q)} Pa`;
  return `
    <div class="p-ef" style="color:${efColor(r)}">${ef} <span>${Math.round(r.mph)} mph · ${r.speed.toFixed(1)} m/s</span></div>
    ${r.speed > RECORD_WIND_MS ? `<div class="p-row" style="color:#ffb84f">Hypothetical: beyond any measured tornado wind</div>` : ""}
    <div class="p-row"><b>From</b> ${dir} (${Math.round(r.fromDeg)}°)</div>
    <div class="p-row"><b>Around</b> ${Math.abs(r.tangential).toFixed(0)} m/s · <b>${inOut}</b> ${Math.abs(r.radial).toFixed(0)} m/s · <b>${upDown}</b> ${Math.abs(r.vertical).toFixed(0)} m/s</div>
    <div class="p-row"><b>Pressure drop</b> ${(r.pressureDeficit / 100).toFixed(1)} hPa</div>
    <div class="p-row"><b>Wind pressure</b> ${qStr} (${(q / PA_PER_PSF).toFixed(0)} lb/ft²)</div>
    <div class="p-row p-dim">${Math.round(r.distance)} m from center · ${side}${r.inCore ? " · inside core" : ""}</div>`;
}

const efText = (e: number | null) => (e === null ? "—" : `EF${e}`);
const kn = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} kN` : `${Math.round(n)} N`);
const kpa = (pa: number) => (pa >= 1000 ? `${(pa / 1000).toFixed(2)} kPa` : `${Math.round(pa)} Pa`);

function fmtBuilding(r: BuildingReport, hereMph: number): string {
  const col = r.dod > 0 ? hex(DOD_COLORS[r.dod]!) : "#c3ccd6";
  const est = r.estimate.ef === null
    ? "No damage"
    : `${efText(r.estimate.ef)} · ${r.estimate.mph} mph <span class="p-dim">(DOD range ${efText(r.estimate.low)}–${efText(r.estimate.high)}; ${r.estimate.basis})</span>`;
  // Town-model failures (before the house went into full detail) and connection failures in
  // the detail zone, in order of first failure.
  const rows = [
    ...r.failures.map((f) => {
      const why = [
        f.windTime < Infinity ? `${kpa(f.load)} &gt; ${kpa(f.capacity)}` : "",
        f.fellWithWall ? `${f.fellWithWall === f.count ? (f.count > 1 ? "all fell" : "fell") : `${f.fellWithWall} fell`} with a bearing wall` : "",
      ].filter(Boolean).join(" · ");
      return { time: f.time, html: `${f.label}${f.total > 1 ? `: ${f.count} of ${f.total} ${f.unit}` : ""} <span class="p-dim">first at ${Math.round(f.mph)} mph · ${why}</span>` };
    }),
    ...r.detailFailures.map((f) => ({ time: f.time, html: `${f.label}: ${f.count} of ${f.total} ${f.unit} <span class="p-dim">first at ${Math.round(f.mph)} mph · ${kn(f.load)} &gt; ${kn(f.capacity)}</span>` })),
  ].sort((a, b) => a.time - b.time);
  const fails = rows.map((x) => `<li>${x.html}</li>`).join("");
  return `
    <div class="p-ef" style="color:${col}">${r.dod > 0 ? `DOD ${r.dod}` : "Intact"} <span>${r.description}</span></div>
    <div class="p-row"><b>Survey estimate</b> ${est}</div>
    <div class="p-row"><b>House</b> #${r.id} · ${r.classLabel}</div>
    <div class="p-row"><b>Peak wind at roof</b> ${Math.round(r.peakMph)} mph · <b>now</b> ${Math.round(hereMph)} mph</div>
    ${fails ? `<div class="p-row"><b>What failed, in order</b></div><ol class="p-fails">${fails}</ol>` : ""}`;
}

interface Pin {
  point: Vec3;
  color: number;
  history: History;
  card: HTMLElement;
  body: HTMLElement;
  canvas: HTMLCanvasElement;
}

function drawSparkline(c: HTMLCanvasElement, h: History, color: number): void {
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const w = c.width;
  const hh = c.height;
  ctx.clearRect(0, 0, w, hh);
  if (h.length < 2) return;
  const max = Math.max(40, ...h.values) * 1.1;
  const t1 = h.times[h.length - 1]!;
  const t0 = t1 - HISTORY_SECONDS;
  ctx.strokeStyle = hex(color);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < h.length; i++) {
    const x = ((h.times[i]! - t0) / HISTORY_SECONDS) * w;
    const y = hh - (h.values[i]! / max) * hh;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

export interface ProbeUI {
  update(snap: SimSnapshot, probeHeight: number): void;
}

export function createProbeUI(
  canvasHost: HTMLElement,
  view: SimRenderer,
  buildingAt: (x: number, z: number) => Building | null,
  /** A click goes here first; return true if it was used (e.g. placing the detail spot). */
  interceptClick: (p: Vec3) => boolean = () => false,
): ProbeUI {
  const tooltip = document.createElement("div");
  tooltip.className = "probe-tip";
  tooltip.hidden = true;
  document.body.appendChild(tooltip);

  const dock = document.createElement("div");
  dock.className = "pin-dock";
  dock.innerHTML = `<div class="pin-head"><span>Pinned probes</span><button type="button" class="pin-clear">Clear all</button></div><div class="pin-list"></div>`;
  dock.hidden = true;
  document.body.appendChild(dock);
  const list = dock.querySelector<HTMLElement>(".pin-list")!;
  dock.querySelector<HTMLButtonElement>(".pin-clear")!.onclick = () => {
    for (const p of pins) p.card.remove();
    pins.length = 0;
    dock.hidden = true;
  };

  const hint = document.createElement("div");
  hint.className = "probe-hint";
  hint.textContent = "Hover the ground to inspect · click to pin a probe · drag to move · right-drag or arrow keys to turn · scroll to zoom · W/A/S/D to fly, E/Q up/down, Shift faster";
  document.body.appendChild(hint);

  let hover: Vec3 | null = null;
  let mouse = { x: 0, y: 0 };
  let down: { x: number; y: number } | null = null;
  const pins: Pin[] = [];
  let colorIdx = 0;

  const toNdc = (e: PointerEvent) => {
    const r = canvasHost.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1 };
  };

  canvasHost.addEventListener("pointermove", (e) => {
    mouse = { x: e.clientX, y: e.clientY };
    const n = toNdc(e);
    hover = view.pick(n.x, n.y);
  });
  canvasHost.addEventListener("pointerleave", () => {
    hover = null;
  });
  canvasHost.addEventListener("pointerdown", (e) => {
    down = { x: e.clientX, y: e.clientY };
  });
  canvasHost.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return; // a drag, not a click
    down = null;
    const n = toNdc(e);
    const p = view.pick(n.x, n.y);
    if (p && !interceptClick(p)) addPin(p);
  });

  function addPin(point: Vec3): void {
    if (pins.length >= MAX_PINS) {
      pins.shift()!.card.remove();
    }
    const color = PIN_COLORS[colorIdx++ % PIN_COLORS.length]!;
    const card = document.createElement("div");
    card.className = "pin-card";
    card.style.borderLeftColor = hex(color);
    card.innerHTML = `<button type="button" class="pin-x" title="Remove">×</button><div class="pin-body"></div><canvas width="260" height="40"></canvas><div class="pin-axis">last ${HISTORY_SECONDS} s · wind speed</div>`;
    const pin: Pin = {
      point,
      color,
      history: new History(Math.round(HISTORY_SECONDS / HISTORY_INTERVAL), HISTORY_INTERVAL),
      card,
      body: card.querySelector<HTMLElement>(".pin-body")!,
      canvas: card.querySelector<HTMLCanvasElement>("canvas")!,
    };
    card.querySelector<HTMLButtonElement>(".pin-x")!.onclick = () => {
      pins.splice(pins.indexOf(pin), 1);
      card.remove();
      dock.hidden = pins.length === 0;
    };
    list.appendChild(card);
    pins.push(pin);
    dock.hidden = false;
  }

  return {
    update(snap, probeHeight) {
      const s = snap.tornado;
      if (hover) {
        const house = buildingAt(hover.x, hover.z);
        if (house) {
          const w = probeAt({ x: house.x, y: house.roofHeight, z: house.z }, s, snap.terrain);
          tooltip.innerHTML = fmtBuilding(buildingReport(house), w.mph) + `<div class="p-row p-dim">click to pin this house</div>`;
        } else {
          const r = probeAt({ x: hover.x, y: probeHeight, z: hover.z }, s, snap.terrain);
          tooltip.innerHTML = fmt(r) + `<div class="p-row p-dim">at ${probeHeight} m above ground · click to pin</div>`;
        }
        tooltip.hidden = false;
        const pad = 16;
        const w = tooltip.offsetWidth;
        const h = tooltip.offsetHeight;
        const x = mouse.x + pad + w > window.innerWidth ? mouse.x - pad - w : mouse.x + pad;
        const y = Math.min(mouse.y + pad, window.innerHeight - h - 8);
        tooltip.style.transform = `translate(${x}px, ${y}px)`;
      } else {
        tooltip.hidden = true;
      }

      for (const pin of pins) {
        const house = buildingAt(pin.point.x, pin.point.z);
        const height = house ? house.roofHeight : probeHeight;
        const r = probeAt({ x: pin.point.x, y: height, z: pin.point.z }, s, snap.terrain);
        pin.history.push(snap.time, r.speed);
        pin.body.innerHTML = house ? fmtBuilding(buildingReport(house), r.mph) : fmt(r);
        drawSparkline(pin.canvas, pin.history, pin.color);
      }

      view.setProbes(
        hover,
        pins.map((p) => ({ point: p.point, color: p.color })),
      );
    },
  };
}
