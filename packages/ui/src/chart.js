// SPDX-License-Identifier: Apache-2.0
// Hewn chart helper (v4: short charts fit, axes: false; v3: optional viewBox width; v2 added lineChart), served at /_platform/chart.js on every Hewn origin.
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

/** A line's y range: the data's own (temperatures can be negative, and 2–4° shouldn't look flat), on round ticks. */
function lineRange(values) {
  const vs = values.filter((v) => Number.isFinite(v));
  if (!vs.length) return { lo: 0, hi: 1 };
  const min = Math.min(...vs), max = Math.max(...vs);
  // Counts and amounts near zero keep zero in view; otherwise, zoom to the data.
  const from = min >= 0 && min <= (max - min) * 0.5 ? 0 : min;
  const step = niceMax((max - from || Math.abs(max) || 1) / 4);
  const lo = Math.floor(from / step) * step;
  return { lo, hi: Math.max(lo + step, Math.ceil(max / step) * step) };
}

/**
 * Room for the axes. A short chart gets two y ticks (0 and max) and tight padding, so the plot
 * keeps most of the height; `axes: false` draws the plot alone (a tiny chart).
 */
function frame({ width, height, axes, max, labels, min = 0 }) {
  if (!axes) return { pad: { top: 4, right: 4, bottom: 4, left: 4 }, ticks: [], step: 0, labelY: 0 };
  const short = height < 120;
  const ticks = short ? [min, max] : [0, 1, 2, 3, 4].map((t) => min + ((max - min) / 4) * t);
  const pad = { top: short ? 6 : 12, right: 8, bottom: short ? 18 : 28, left: 10 + 6.5 * Math.max(...ticks.map((v) => fmt(v).length)) };
  const widest = 6.5 * Math.max(1, ...labels.map((l) => String(l).length)) + 6;
  const step = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor((width - pad.left - pad.right) / widest))));
  return { pad, ticks, step, labelY: height - (short ? 4 : 8) };
}

/** Vertical bar chart, grouped or stacked. Replaces the container's contents. */
export function barChart(container, { labels, series, stacked = false, unit = "", height = 240, width = 640, axes = true }) {
  const totals = labels.map((_, i) => (stacked ? series.reduce((a, s) => a + (s.values[i] || 0), 0) : Math.max(0, ...series.map((s) => s.values[i] || 0))));
  const max = niceMax(Math.max(0, ...totals));
  const { pad, ticks, step, labelY } = frame({ width, height, axes, max, labels });
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const y = (v) => pad.top + innerH - (v / max) * innerH;
  const band = innerW / Math.max(labels.length, 1);
  const barW = stacked ? band * 0.5 : (band * 0.72) / Math.max(series.length, 1);

  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  const grid = el("g", { class: "grid" });
  const axis = el("g", { class: "axis" });
  for (const v of ticks) {
    grid.append(el("line", { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }));
    axis.append(el("text", { x: pad.left - 6, y: y(v) + 4, "text-anchor": "end" }, fmt(v)));
  }
  labels.forEach((l, i) => {
    if (step && i % step === 0) axis.append(el("text", { x: pad.left + band * i + band / 2, y: labelY, "text-anchor": "middle" }, String(l)));
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
export function lineChart(container, { labels, series, unit = "", height = 200, width = 640, axes = true }) {
  const { lo, hi } = lineRange(series.flatMap((s) => s.values));
  const { pad, ticks, step, labelY } = frame({ width, height, axes, max: hi, min: lo, labels });
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const y = (v) => pad.top + innerH - ((v - lo) / (hi - lo)) * innerH;
  const x = (i) => pad.left + (labels.length > 1 ? (innerW * i) / (labels.length - 1) : innerW / 2);
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  const grid = el("g", { class: "grid" });
  const axis = el("g", { class: "axis" });
  for (const v of ticks) {
    grid.append(el("line", { x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }));
    axis.append(el("text", { x: pad.left - 6, y: y(v) + 4, "text-anchor": "end" }, fmt(v)));
  }
  labels.forEach((l, i) => { if (step && i % step === 0) axis.append(el("text", { x: x(i), y: labelY, "text-anchor": "middle" }, String(l))); });
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
