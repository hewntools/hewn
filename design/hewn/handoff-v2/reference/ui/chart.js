// Hewn chart helper (v2: adds lineChart), served at /_platform/chart.js on every Hewn origin.
// SVG built with DOM APIs (no innerHTML); colours come from ui.css tokens (--c1..--c8).
//
//   import { barChart } from "/_platform/chart.js";
//   barChart(document.getElementById("chart"), {
//     labels: ["W40", "W41", "W42"],
//     series: [{ name: "Running", values: [12, 20, 15] }, { name: "Cycling", values: [30, 0, 45] }],
//     stacked: true,
//     unit: "km",
//   });

const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  for (const c of children) n.append(c);
  return n;
};
const color = (i) => `var(--c${(i % 8) + 1})`;
const fmt = (v) => (Math.abs(v) >= 100 ? Math.round(v).toString() : Number(v.toFixed(Math.abs(v) < 10 ? 2 : 1)).toString());

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v);
}

/** Vertical bar chart, grouped or stacked. Replaces the container's contents. */
export function barChart(container, { labels, series, stacked = false, unit = "", height = 240 }) {
  const width = 640;
  const pad = { top: 12, right: 8, bottom: 28, left: 40 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const totals = labels.map((_, i) => (stacked ? series.reduce((a, s) => a + (s.values[i] || 0), 0) : Math.max(0, ...series.map((s) => s.values[i] || 0))));
  const max = niceMax(Math.max(0, ...totals));
  const y = (v) => pad.top + innerH - (v / max) * innerH;
  const band = innerW / Math.max(labels.length, 1);
  const barW = stacked ? band * 0.5 : (band * 0.72) / Math.max(series.length, 1);

  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  const grid = el("g", { class: "grid" });
  const axis = el("g", { class: "axis" });
  for (let t = 0; t <= 4; t++) {
    const v = (max / 4) * t;
    grid.append(el("line", { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }));
    axis.append(el("text", { x: pad.left - 6, y: y(v) + 4, "text-anchor": "end" }, fmt(v)));
  }
  const step = Math.ceil(labels.length / 12);
  labels.forEach((l, i) => {
    if (i % step === 0) axis.append(el("text", { x: pad.left + band * i + band / 2, y: height - 8, "text-anchor": "middle" }, String(l)));
  });
  svg.append(grid, axis);

  const bars = el("g");
  labels.forEach((label, i) => {
    let base = 0;
    series.forEach((s, si) => {
      const v = s.values[i] || 0;
      if (!v) return;
      const x = stacked ? pad.left + band * i + (band - barW) / 2 : pad.left + band * i + (band * 0.14) + barW * si;
      const top = stacked ? y(base + v) : y(v);
      const h = stacked ? y(base) - y(base + v) : y(0) - y(v);
      bars.append(el("rect", { x, y: top, width: barW, height: Math.max(h, 0.5), rx: 1, fill: s.color ?? color(si) }, el("title", {}, `${label} · ${s.name}: ${fmt(v)}${unit ? " " + unit : ""}`)));
      base += v;
    });
  });
  svg.append(bars);

  const legend = document.createElement("div");
  legend.className = "legend";
  if (series.length > 1) {
    series.forEach((s, si) => {
      const item = document.createElement("span");
      const swatch = document.createElement("i");
      swatch.style.background = s.color ?? color(si);
      item.append(swatch, document.createTextNode(s.name));
      legend.append(item);
    });
  }
  container.classList.add("chart");
  container.replaceChildren(svg, legend);
}

/** Line chart, one or more series. Replaces the container's contents. */
export function lineChart(container, { labels, series, unit = "", height = 200 }) {
  const width = 640;
  const pad = { top: 12, right: 8, bottom: 28, left: 40 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const y = (v) => pad.top + innerH - (v / max) * innerH;
  const x = (i) => pad.left + (labels.length > 1 ? (innerW * i) / (labels.length - 1) : innerW / 2);
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  const grid = el("g", { class: "grid" });
  const axis = el("g", { class: "axis" });
  for (let t = 0; t <= 4; t++) {
    const v = (max / 4) * t;
    grid.append(el("line", { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }));
    axis.append(el("text", { x: pad.left - 6, y: y(v) + 4, "text-anchor": "end" }, fmt(v)));
  }
  const step = Math.ceil(labels.length / 12);
  labels.forEach((l, i) => { if (i % step === 0) axis.append(el("text", { x: x(i), y: height - 8, "text-anchor": "middle" }, String(l))); });
  svg.append(grid, axis);
  series.forEach((s, si) => {
    const c = s.color ?? color(si);
    const pts = s.values.map((v, i) => `${x(i)},${y(v || 0)}`).join(" ");
    svg.append(el("polyline", { class: "line", points: pts, stroke: c }));
    s.values.forEach((v, i) => svg.append(el("rect", { x: x(i) - 3, y: y(v || 0) - 3, width: 6, height: 6, rx: 1, fill: c }, el("title", {}, `${labels[i]} · ${s.name}: ${fmt(v || 0)}${unit ? " " + unit : ""}`))));
  });
  const legend = document.createElement("div");
  legend.className = "legend";
  if (series.length > 1) series.forEach((s, si) => { const it = document.createElement("span"); const sw = document.createElement("i"); sw.style.background = s.color ?? color(si); it.append(sw, document.createTextNode(s.name)); legend.append(it); });
  container.classList.add("chart");
  container.replaceChildren(svg, legend);
}
