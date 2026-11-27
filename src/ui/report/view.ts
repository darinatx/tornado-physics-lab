/**
 * The report page (Spec 16): the rendered report in an overlay over the frozen scene, with
 * sorting, map layer toggles, point → row, and print (the whole report, or the summary alone).
 */
import type { Report } from "../../sim/report/report";
import { renderReport } from "./html";
import "./report.css";

export interface ReportView {
  readonly open: boolean;
  close(): void;
}

let current: { el: HTMLElement; close: () => void } | null = null;

/** Show a report (replacing any open one). `onClose` runs when the user closes it. */
export function showReport(report: Report, o: { onClose?: () => void; extraButtons?: { label: string; title: string; run: () => void }[] } = {}): ReportView {
  current?.close();
  const el = document.createElement("div");
  el.className = "rp-overlay";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", report.title);
  const bar = document.createElement("div");
  bar.className = "rp-bar rp-noprint";
  const titleEl = document.createElement("span");
  titleEl.className = "rp-bar-title";
  titleEl.textContent = `${report.title} · ${report.mark}`;
  bar.appendChild(titleEl);
  const button = (label: string, title: string, run: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", run);
    bar.appendChild(b);
    return b;
  };
  const nav = document.createElement("select");
  nav.title = "Jump to a section";
  for (const [id, name] of [
    ["rp-summary", "1. Summary"], ["rp-narrative", "2. Narrative"], ["rp-map", "3. Track map"], ["rp-table", "4. Damage survey"],
    ["rp-timeline", "5. Intensity timeline"], ["rp-failures", "6. How the houses failed"], ["rp-debris", "7. Debris"], ["rp-stats", "8. Statistics"], ["rp-methods", "9. Methods"],
  ]) {
    const opt = document.createElement("option");
    opt.value = id!;
    opt.textContent = name!;
    nav.appendChild(opt);
  }
  nav.addEventListener("change", () => el.querySelector(`#${nav.value}`)?.scrollIntoView({ behavior: "smooth" }));
  bar.appendChild(nav);
  button("🖨 Print summary", "Print (or save as PDF) the one-page summary alone", () => print("summary"));
  button("🖨 Print report", "Print (or save as PDF) the whole report, summary on page 1", () => print("all"));
  for (const x of o.extraButtons ?? []) button(x.label, x.title, x.run);
  const close = () => {
    el.remove();
    document.body.classList.remove("rp-printing", "rp-print-summary");
    window.removeEventListener("keydown", onKey);
    if (current?.el === el) current = null;
    o.onClose?.();
  };
  button("✕ Close", "Close the report (the scene stays as it is)", close);
  const body = document.createElement("div");
  body.className = "rp-scroll";
  body.innerHTML = renderReport(report);
  el.append(bar, body);
  document.body.appendChild(el);

  function print(what: "summary" | "all") {
    document.body.classList.add("rp-printing");
    document.body.classList.toggle("rp-print-summary", what === "summary");
    const done = () => {
      document.body.classList.remove("rp-printing", "rp-print-summary");
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  window.addEventListener("keydown", onKey);

  // Map layers.
  for (const input of body.querySelectorAll<HTMLInputElement>("input[data-layer]")) {
    input.addEventListener("change", () => {
      for (const g of body.querySelectorAll<SVGElement>(`#rp-map .rp-layer-${input.dataset.layer}`)) g.style.display = input.checked ? "" : "none";
    });
  }
  // Point → its row.
  body.querySelector("#rp-map svg")?.addEventListener("click", (e) => {
    const p = (e.target as Element).closest?.("[data-point]")?.getAttribute("data-point");
    if (!p) return;
    const row = body.querySelector<HTMLElement>(`#rp-row-${p}`);
    if (!row) return;
    for (const r of body.querySelectorAll(".rp-hl")) r.classList.remove("rp-hl");
    row.classList.add("rp-hl");
    row.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  // Sortable table.
  const table = body.querySelector<HTMLTableElement>("#rp-table table");
  if (table) {
    let sortCol = -1;
    let asc = true;
    table.querySelectorAll("th").forEach((th, i) => {
      th.addEventListener("click", () => {
        asc = sortCol === i ? !asc : true;
        sortCol = i;
        const tbody = table.tBodies[0]!;
        const rows = [...tbody.rows];
        const key = (r: HTMLTableRowElement) => r.cells[i]!.dataset.v ?? "";
        const num = rows.every((r) => key(r) === "" || !Number.isNaN(Number(key(r))));
        rows.sort((a, b) => {
          const x = key(a);
          const y = key(b);
          const c = num ? (x === "" ? -Infinity : Number(x)) - (y === "" ? -Infinity : Number(y)) : x.localeCompare(y);
          return asc ? c : -c;
        });
        for (const r of rows) tbody.appendChild(r);
        table.querySelectorAll("th").forEach((h, k) => h.setAttribute("aria-sort", k === i ? (asc ? "ascending" : "descending") : "none"));
      });
    });
  }
  current = { el, close };
  return {
    get open() {
      return el.isConnected;
    },
    close,
  };
}
