/** EF readout (INST-02). */
import { EF_REFERENCE_HEIGHT, RECORD_WIND_MS } from "../config/wind";
import { efRating, msToMph } from "../core/wind/efScale";
import type { EFRating } from "../core/wind/efScale";
import type { Phase } from "../core/wind/lifecycle";
import { peakGroundSpeed } from "../core/wind/peak";
import { swirlRatio, twoCellBlend } from "../core/wind/windField";
import { BELOW_EF0_COLOR, EF_COLORS } from "../render/arrowStyle";
import type { SimSnapshot } from "../sim/types";
import type { DebrisStats } from "../core/debris/field";

export interface Tally {
  total: number;
  damaged: number;
  destroyed: number;
}

/** Houses damaged (DOD ≥ 1) and destroyed (DOD ≥ 7) from the DOD histogram (INST-09). */
export function computeTally(hist: readonly number[]): Tally {
  let total = 0;
  let damaged = 0;
  let destroyed = 0;
  hist.forEach((n, dod) => {
    total += n;
    if (dod >= 1) damaged += n;
    if (dod >= 7) destroyed += n;
  });
  return { total, damaged, destroyed };
}

export type CellStructure = "one-cell" | "transitioning" | "two-cell";

export interface Readout {
  ef: EFRating | null;
  /** True when the peak wind exceeds the strongest ever measured (INST-11). */
  hypothetical: boolean;
  /** Swirl ratio S = V_max / W_max. */
  swirl: number;
  cells: CellStructure;
  ms: number;
  mph: number;
  phase: Phase;
  time: number;
  lifetime: number;
  tally: Tally;
  debris: DebrisStats;
}

/** Pure: the readout for a snapshot. */
export function computeReadout(snap: SimSnapshot): Readout {
  const ms = peakGroundSpeed(snap.tornado, snap.terrain, EF_REFERENCE_HEIGHT);
  const b = twoCellBlend(snap.tornado);
  return {
    ef: efRating(ms),
    hypothetical: ms > RECORD_WIND_MS,
    swirl: swirlRatio(snap.tornado),
    cells: b < 0.1 ? "one-cell" : b > 0.9 ? "two-cell" : "transitioning",
    ms,
    mph: msToMph(ms),
    phase: snap.phase,
    time: snap.time,
    lifetime: snap.lifetime,
    tally: computeTally(snap.damageHistogram),
    debris: { ...snap.debris },
  };
}

const PHASE_LABEL: Record<Phase, string> = {
  "spin-up": "Spinning up",
  mature: "Mature",
  "rope-out": "Roping out",
  dissipated: "Dissipated",
};

const CELL_LABEL: Record<CellStructure, string> = {
  "one-cell": "One-cell (updraft in center)",
  transitioning: "Transitioning to two-cell",
  "two-cell": "Two-cell (downdraft in center)",
};

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

export function mountReadout(host: HTMLElement): { update(r: Readout): void } {
  const el = document.createElement("div");
  el.className = "readout";
  el.innerHTML = `
    <div class="ef"></div>
    <div class="speed"></div>
    <div class="hypo" hidden>Beyond the strongest winds ever measured (≈302 mph): hypothetical</div>
    <div class="phase"></div>
    <div class="cells"></div>
    <div class="tally"></div>
    <div class="debris"></div>
    <div class="legend">${["<EF0", "EF0", "EF1", "EF2", "EF3", "EF4", "EF5"]
      .map((l, i) => `<span><i style="background:${hex(i === 0 ? BELOW_EF0_COLOR : EF_COLORS[i - 1]!)}"></i>${l}</span>`)
      .join("")}</div>
    <div class="note">Peak ground-relative wind at ${EF_REFERENCE_HEIGHT} m (3-s gust basis)</div>`;
  host.appendChild(el);
  const ef = el.querySelector<HTMLElement>(".ef")!;
  const speed = el.querySelector<HTMLElement>(".speed")!;
  const hypo = el.querySelector<HTMLElement>(".hypo")!;
  const phase = el.querySelector<HTMLElement>(".phase")!;
  const cells = el.querySelector<HTMLElement>(".cells")!;
  const tally = el.querySelector<HTMLElement>(".tally")!;
  const debrisEl = el.querySelector<HTMLElement>(".debris")!;

  return {
    update(r) {
      ef.textContent = r.ef === null ? "Below EF0" : `EF${r.ef}`;
      ef.style.color = hex(r.ef === null ? BELOW_EF0_COLOR : EF_COLORS[r.ef]);
      speed.textContent = `${Math.round(r.mph)} mph · ${r.ms.toFixed(1)} m/s`;
      hypo.hidden = !r.hypothetical;
      const swirl = Number.isFinite(r.swirl) ? r.swirl.toFixed(1) : "∞";
      cells.textContent = r.phase === "dissipated" ? "" : `${CELL_LABEL[r.cells]} · swirl ${swirl}`;
      const t = r.tally;
      tally.innerHTML = t.total
        ? `<b>${t.damaged.toLocaleString()}</b> homes damaged · <b>${t.destroyed.toLocaleString()}</b> destroyed <span>of ${t.total.toLocaleString()}</span>`
        : "";
      const d = r.debris;
      debrisEl.innerHTML =
        d.airborne + d.resting + d.settled + d.lofted > 0
          ? `Debris: <b>${d.airborne.toLocaleString()}</b> flying · ${(d.resting + d.settled).toLocaleString()} on the ground` +
            (d.lofted ? ` · ${d.lofted.toLocaleString()} lofted into the storm` : "") +
            (d.airborne ? `<br><span>fastest ${Math.round(msToMph(d.maxSpeed))} mph · highest ${Math.round(d.maxHeight)} m</span>` : "")
          : "";
      phase.textContent = `${PHASE_LABEL[r.phase]} · ${Math.floor(r.time)} s / ${Math.round(r.lifetime)} s`;
    },
  };
}
