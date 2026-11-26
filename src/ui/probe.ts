/** Inspect probe: hover tooltip and pinned probes with history (Spec 07 v1.3). */
import { BACKGROUND_PRESSURE_PA, PA_PER_MB, PA_PER_PSF } from "../config/atmosphere";
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
/** Pinned history covers the whole run, start to dissipation (Spec 07 v1.10): room for runs
 *  up to this long (s), sampled at this interval (s). */
const HISTORY_MAX_SECONDS = 3600;
const HISTORY_INTERVAL = 0.25;
const PIN_COLORS = [0x4fd1ff, 0xffb84f, 0xb388ff, 0x7dff9a];
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/** Actual air pressure (mb) for a pressure drop (Pa), from the standard sea-level background. */
export function airPressureMb(deficitPa: number): number {
  return (BACKGROUND_PRESSURE_PA - deficitPa) / PA_PER_MB;
}
const BACKGROUND_MB = BACKGROUND_PRESSURE_PA / PA_PER_MB;

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
    <div class="p-row"><b>Air pressure</b> ${airPressureMb(r.pressureDeficit).toFixed(1)} mb <span class="p-dim">(−${(r.pressureDeficit / PA_PER_MB).toFixed(1)} mb)</span></div>
    <div class="p-row"><b>Wind pressure</b> ${qStr} (${(q / PA_PER_PSF).toFixed(0)} lb/ft²)</div>
    <div class="p-row p-dim">${Math.round(r.distance)} m from center · ${side}${r.inCore ? " · inside core" : ""}</div>`;
}

const efText = (e: number | null) => (e === null ? "—" : `EF${e}`);
const kn = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} kN` : `${Math.round(n)} N`);
const kpa = (pa: number) => (pa >= 1000 ? `${(pa / 1000).toFixed(2)} kPa` : `${Math.round(pa)} Pa`);

/** Distance from the core edge (R_max) now and the closest it came (INST-13). */
export function coreDistanceText(now: number | null, closest: number): string {
  // null: the tornado has dissipated, so there is no core to measure from.
  const nowText = now === null ? "dissipated" : now <= 0 ? "inside the core now" : `${Math.round(now)} m now`;
  if (!Number.isFinite(closest)) return nowText;
  return `${nowText} · closest${closest <= 0 ? ": inside the core" : ` ${Math.round(closest)} m`}`;
}

/** The short building summary (hover, and the top of a pinned house). */
export function buildingSummary(r: BuildingReport, hereMph: number, edgeNow: number | null): string {
  const col = r.dod > 0 ? hex(DOD_COLORS[r.dod]!) : "#c3ccd6";
  const est = r.estimate.ef === null
    ? "No damage"
    : `${efText(r.estimate.ef)} · ${r.estimate.mph} mph <span class="p-dim">(DOD range ${efText(r.estimate.low)}–${efText(r.estimate.high)}; ${r.estimate.basis})</span>`;
  return `
    <div class="p-ef" style="color:${col}">${r.dod > 0 ? `DOD ${r.dod}` : "Intact"} <span>${r.description}</span></div>
    <div class="p-row"><b>Survey estimate</b> ${est}</div>
    <div class="p-row"><b>House</b> #${r.id} · ${r.classLabel}</div>
    <div class="p-row"><b>Peak wind at roof</b> ${Math.round(r.peakMph)} mph · <b>now</b> ${Math.round(hereMph)} mph</div>
    <div class="p-row"><b>From core edge</b> ${coreDistanceText(edgeNow, r.closestEdge)}</div>`;
}

/** What failed, in order of first failure (the pinned inspector only). */
export function failureList(r: BuildingReport): string {
  // Town-model failures (before the house went into full detail) and connection failures in
  // the detail zone, in order of first failure.
  const rows = [
    ...r.failures.map((f) => {
      const why = [
        f.windTime < Infinity ? `${kpa(f.load)} &gt; ${kpa(f.capacity)}` : "",
        f.fellWithWall ? `${f.fellWithWall === f.count ? (f.count > 1 ? "all fell" : "fell") : `${f.fellWithWall} fell`} with a bearing wall` : "",
        f.byDebris ? `${f.byDebris === f.count ? (f.count > 1 ? "all" : "") : f.byDebris} by debris${f.debrisMissile ? ` (first: ${f.debrisMissile.label.toLowerCase()}, ${f.debrisMissile.mass < 1 ? f.debrisMissile.mass.toFixed(2) : Math.round(f.debrisMissile.mass)} kg at ${Math.round(f.debrisMissile.speed)} m/s)` : ""}`.trim() : "",
      ].filter(Boolean).join(" · ");
      return { time: f.time, html: `${f.label}${f.total > 1 ? `: ${f.count} of ${f.total} ${f.unit}` : ""} <span class="p-dim">first at ${Math.round(f.mph)} mph · ${why}</span>` };
    }),
    ...r.detailFailures.map((f) => ({ time: f.time, html: `${f.label}: ${f.count} of ${f.total} ${f.unit} <span class="p-dim">first at ${Math.round(f.mph)} mph · ${kn(f.load)} &gt; ${kn(f.capacity)}</span>` })),
  ].sort((a, b) => a.time - b.time);
  if (!rows.length) return "";
  return `<div class="p-row"><b>What failed, in order</b></div><ol class="p-fails">${rows.map((x) => `<li>${x.html}</li>`).join("")}</ol>`;
}

/** A pinned card: readings (or the building summary), the history graph, then failures. */
export const PIN_CARD_HTML = `<button type="button" class="pin-x" title="Remove">×</button><div class="pin-body"></div>` +
  `<div class="pin-graph"><canvas></canvas><div class="pin-legend"><span class="lg-wind">wind <b></b></span><span class="lg-dp">pressure <b></b></span><span class="lg-span"></span></div></div>` +
  `<div class="pin-fails"></div>`;

/** Distance from the core edge (m) for a point. */
/** Distance from the core edge now (m), or null once the tornado has dissipated (no core). */
const edgeAt = (x: number, z: number, snap: SimSnapshot): number | null =>
  snap.phase === "dissipated" ? null : Math.hypot(x - snap.tornado.center.x, z - snap.tornado.center.z) - snap.tornado.rMax;

interface Pin {
  action?: HTMLButtonElement;
  point: Vec3;
  color: number;
  history: History;
  card: HTMLElement;
  body: HTMLElement;
  fails: HTMLElement;
  canvas: HTMLCanvasElement;
  legendWind: HTMLElement;
  legendDp: HTMLElement;
  legendSpan: HTMLElement;
}

const GRAPH_H = 72;
const DP_COLOR = "#9fb3c8";
const nice = (v: number) => {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v)!;
};

/**
 * The pin's history graph (Spec 07 v1.10): wind speed (mph, solid, left scale) and pressure
 * air pressure (mb, thinner dashed line with a light fill hanging from the background
 * pressure at the top, right scale), like a falling barometer.
 */
function drawGraph(c: HTMLCanvasElement, h: History, color: number, lifetime: number): void {
  const ctx = c.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = c.clientWidth || 260;
  if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(GRAPH_H * dpr)) {
    c.width = Math.round(cw * dpr);
    c.height = Math.round(GRAPH_H * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, GRAPH_H);
  const padL = 30;
  const padR = 32;
  const top = 4;
  const bot = GRAPH_H - 4;
  const w = cw - padL - padR;
  const hh = bot - top;
  const windMax = nice(Math.max(40, ...h.values) * 1.1);
  const dpMax = nice(Math.max(5, ...h.values2) * 1.1);
  // Frame and scales.
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 1;
  ctx.strokeRect(padL + 0.5, top + 0.5, w - 1, hh - 1);
  ctx.font = "9px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillStyle = hex(color);
  ctx.textAlign = "right";
  ctx.fillText(`${windMax}`, padL - 4, top + 4);
  ctx.fillText("0", padL - 4, bot - 4);
  ctx.fillText("mph", padL - 4, (top + bot) / 2);
  ctx.fillStyle = DP_COLOR;
  ctx.textAlign = "left";
  ctx.fillText(`${Math.round(BACKGROUND_MB)}`, padL + w + 4, top + 4);
  ctx.fillText(`${Math.round(BACKGROUND_MB - dpMax)}`, padL + w + 4, bot - 4);
  ctx.fillText("mb", padL + w + 4, (top + bot) / 2);
  if (h.length < 2) return;
  // The whole run, start to dissipation; the lines grow left to right.
  const span = Math.max(lifetime, 1);
  const t1 = h.times[h.length - 1]!;
  const X = (t: number) => padL + (Math.min(t, span) / span) * w;
  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, top, w, hh);
  ctx.clip();
  // Air pressure: hangs down from the background pressure at the top, like a falling barometer.
  const Yp = (v: number) => top + (v / dpMax) * hh;
  ctx.beginPath();
  ctx.moveTo(X(h.times[0]!), top);
  for (let i = 0; i < h.length; i++) ctx.lineTo(X(h.times[i]!), Yp(h.values2[i]!));
  ctx.lineTo(X(t1), top);
  ctx.closePath();
  ctx.fillStyle = "rgba(159,179,200,0.16)";
  ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < h.length; i++) {
    const x = X(h.times[i]!);
    const y = Yp(h.values2[i]!);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = DP_COLOR;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  // Wind speed.
  const Yw = (v: number) => bot - (v / windMax) * hh;
  ctx.beginPath();
  for (let i = 0; i < h.length; i++) {
    const x = X(h.times[i]!);
    const y = Yw(h.values[i]!);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = hex(color);
  ctx.lineWidth = 1.75;
  ctx.stroke();
  ctx.restore();
}

/** Only touch the DOM when the content changed (keeps text selectable and the layout calm). */
const shown = new WeakMap<HTMLElement, string>();
function setHtml(el: HTMLElement, html: string): void {
  if (shown.get(el) !== html) {
    shown.set(el, html);
    el.innerHTML = html;
  }
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
  /** Where the pin dock and the key hint go (layout columns, Spec 07 v1.10). */
  hosts: { dock: HTMLElement; hint: HTMLElement } = { dock: document.body, hint: document.body },
  /** A button on a pinned house's card (Spec 13: record the debris reaching it). */
  pinAction?: { label: (b: Building) => string; run: (b: Building) => void },
): ProbeUI {
  const tooltip = document.createElement("div");
  tooltip.className = "probe-tip";
  tooltip.hidden = true;
  document.body.appendChild(tooltip);

  const dock = document.createElement("div");
  dock.className = "pin-dock";
  dock.innerHTML = `<div class="pin-head"><span>Pinned probes</span><button type="button" class="pin-clear">Clear all</button></div><div class="pin-list"></div>`;
  dock.hidden = true;
  hosts.dock.appendChild(dock);
  const list = dock.querySelector<HTMLElement>(".pin-list")!;
  dock.querySelector<HTMLButtonElement>(".pin-clear")!.onclick = () => {
    for (const p of pins) p.card.remove();
    pins.length = 0;
    dock.hidden = true;
  };

  const hint = document.createElement("div");
  hint.className = "probe-hint";
  hint.textContent = "Hover to inspect · click to pin · drag to move · scroll to zoom · WASD move · ↑/↓ height · ←/→ turn · Q/E tilt · Shift faster";
  hosts.hint.appendChild(hint);

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
    card.style.setProperty("--pin", hex(color));
    card.innerHTML = PIN_CARD_HTML;
    const pin: Pin = {
      point,
      color,
      history: new History(Math.round(HISTORY_MAX_SECONDS / HISTORY_INTERVAL), HISTORY_INTERVAL),
      card,
      body: card.querySelector<HTMLElement>(".pin-body")!,
      fails: card.querySelector<HTMLElement>(".pin-fails")!,
      canvas: card.querySelector<HTMLCanvasElement>("canvas")!,
      legendWind: card.querySelector<HTMLElement>(".lg-wind b")!,
      legendDp: card.querySelector<HTMLElement>(".lg-dp b")!,
      legendSpan: card.querySelector<HTMLElement>(".lg-span")!,
    };
    if (pinAction) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pin-act";
      btn.hidden = true;
      btn.onclick = () => {
        const b = buildingAt(point.x, point.z);
        if (b) pinAction.run(b);
      };
      card.appendChild(btn);
      pin.action = btn;
    }
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
          tooltip.innerHTML = buildingSummary(buildingReport(house), w.mph, edgeAt(house.x, house.z, snap)) + `<div class="p-row p-dim">click to pin for its history and what failed</div>`;
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
        const dpMb = r.pressureDeficit / PA_PER_MB;
        // Record until the tornado dissipates (a restart clears it).
        if (snap.time <= snap.lifetime) pin.history.push(snap.time, r.mph, dpMb);
        if (house) {
          const rep = buildingReport(house);
          setHtml(pin.body, buildingSummary(rep, r.mph, edgeAt(house.x, house.z, snap)));
          setHtml(pin.fails, failureList(rep));
        } else {
          setHtml(pin.body, fmt(r));
          setHtml(pin.fails, "");
        }
        pin.legendWind.textContent = `${Math.round(r.mph)} mph`;
        pin.legendDp.textContent = `${airPressureMb(r.pressureDeficit).toFixed(1)} mb`;
        pin.legendSpan.textContent = `0–${Math.round(snap.lifetime)} s`;
        drawGraph(pin.canvas, pin.history, pin.color, snap.lifetime);
        if (pin.action) {
          pin.action.hidden = !house;
          if (house) {
            const label = pinAction!.label(house);
            if (pin.action.textContent !== label) pin.action.textContent = label;
          }
        }
      }

      view.setProbes(
        hover,
        pins.map((p) => ({ point: p.point, color: p.color })),
      );
    },
  };
}
