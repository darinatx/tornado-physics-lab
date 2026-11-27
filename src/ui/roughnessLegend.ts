/**
 * Legend for the ground roughness layer (Spec 17): the colour scale in z₀, the class ranges and
 * typical values. Shown only while the layer is on.
 */
import { TERRAIN } from "../config/terrain";
import { ROUGHNESS_SCALE } from "../render/ground";

const pos = (z0: number) => ((Math.log10(z0) - ROUGHNESS_SCALE.min) / (ROUGHNESS_SCALE.max - ROUGHNESS_SCALE.min)) * 100;

export function mountRoughnessLegend(host: HTMLElement): { setVisible(on: boolean): void } {
  const el = document.createElement("div");
  el.className = "rough-legend";
  el.hidden = true;
  const grad = ROUGHNESS_SCALE.stops.map((c, i) => `${c} ${((i / (ROUGHNESS_SCALE.stops.length - 1)) * 100).toFixed(1)}%`).join(", ");
  const ticks: [number, string][] = [
    [TERRAIN.z0Cover.lawn, "lawn"],
    [TERRAIN.z0Cover.farmland, "fields"],
    [0.2, "this town"],
    [2, "city centre"],
  ];
  const b = TERRAIN.classBounds;
  el.innerHTML = `
    <div class="rl-title">Ground roughness <span class="rl-dim">z₀, upwind-weighted</span></div>
    <div class="rl-bar" style="background: linear-gradient(to right, ${grad})">
      <i style="left:${pos(b.suburban)}%"></i><i style="left:${pos(b.urban)}%"></i>
    </div>
    <div class="rl-classes">
      <span style="left:0;width:${pos(b.suburban)}%">Open</span>
      <span style="left:${pos(b.suburban)}%;width:${pos(b.urban) - pos(b.suburban)}%">Suburban</span>
      <span style="left:${pos(b.urban)}%;width:${100 - pos(b.urban)}%">Urban</span>
    </div>
    <div class="rl-ticks">${ticks.map(([z, l]) => `<span style="left:${pos(z)}%">${l}<br>${z} m</span>`).join("")}</div>`;
  host.appendChild(el);
  return {
    setVisible(on) {
      el.hidden = !on;
    },
  };
}
