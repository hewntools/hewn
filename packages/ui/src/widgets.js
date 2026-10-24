// SPDX-License-Identifier: Apache-2.0
// Hewn widget renderer, served at /_platform/widgets.js and inlined into the agent-chat widget
// (ui://hewn/widget). One renderer, two hosts: Home draws a widget's view model with it, and so do
// MCP Apps clients. DOM APIs only (no innerHTML): view models are capability output, untrusted.
//
//   import { renderWidget } from "/_platform/widgets.js";
//   renderWidget(el, { template: "stat", value: 7, caption: "words due" }, { size: "small", title: "Word List", icon: { id: "word-list", name: "Word List", hue: 280 } });

import { barChart, lineChart } from "./chart.js";

const node = (tag, cls, ...children) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  for (const c of children) if (c !== null && c !== undefined && c !== false) n.append(typeof c === "object" ? c : String(c));
  return n;
};

/** How many list rows fit each size. */
const ROWS = { small: 2, medium: 3, large: 5 };
/** Chart viewBox per size until the chart is laid out; then it's drawn at its box's own size. */
const CHART = { small: { width: 200, height: 110 }, medium: { width: 300, height: 110 }, large: { width: 300, height: 280 } };

const body = {
  stat: (v) => [node("div", "jw-value", String(v.value), v.unit ? node("span", "jw-unit", v.unit) : null), v.caption ? node("div", "jw-caption", v.caption) : null],
  list: (v, size) => {
    if (!v.items.length) return [node("div", "jw-empty", v.empty ?? "Nothing here.")];
    const rows = v.items.slice(0, ROWS[size] ?? 3).map((i) =>
      node("li", "jw-item", node("span", "jw-item-text", node("span", "jw-item-title", i.title), i.detail ? node("span", "jw-item-detail", i.detail) : null), i.value !== undefined ? node("span", "jw-item-value", String(i.value)) : null),
    );
    const more = v.items.length - rows.length;
    return [node("ul", "jw-list", ...rows), more > 0 ? node("div", "jw-caption jw-more", `+${more} more`) : null];
  },
  chart: (v, size) => {
    const el = node("div", "chart jw-chart");
    const kind = v.kind ?? (v.labels.length > 14 ? "line" : "bar");
    const draw = (box) => (kind === "line" ? lineChart : barChart)(el, { labels: v.labels, series: v.series, unit: v.unit ?? "", axes: size !== "small", ...box });
    draw(CHART[size] ?? CHART.medium);
    // Fill the room the widget leaves it, at 1:1 (a fixed aspect ratio would leave it a narrow strip).
    let drawn = "";
    new ResizeObserver(() => {
      const legend = el.querySelector(".legend");
      const box = { width: Math.round(el.clientWidth), height: Math.round(el.clientHeight - (legend?.offsetHeight ? legend.offsetHeight + 12 : 0)) };
      if (box.width < 60 || box.height < 40 || `${box.width}x${box.height}` === drawn) return;
      drawn = `${box.width}x${box.height}`;
      draw(box);
    }).observe(el);
    return [el, v.caption ? node("div", "jw-caption", v.caption) : null];
  },
  progress: (v) => {
    const fill = node("span", "jw-fill");
    fill.style.setProperty("width", `${Math.max(0, Math.min(100, (v.value / v.max) * 100))}%`);
    return [node("div", "jw-value jw-value-sm", v.label ?? `${v.value} / ${v.max}`), node("div", "jw-bar", fill), v.caption ? node("div", "jw-caption", v.caption) : null];
  },
  text: (v) => [node("p", "jw-text", v.text), v.caption ? node("div", "jw-caption", v.caption) : null],
};

/** A widget operation returns one view, or a view per size: the one for `size`, else the nearest. */
export function viewFor(output, size) {
  if (!output || output.template) return output;
  const order = size === "large" ? ["large", "medium", "small"] : size === "small" ? ["small", "medium", "large"] : ["medium", "large", "small"];
  return output[order.find((s) => output[s])];
}

/**
 * Whose widget it is: the capability's app icon, small, in the top-right corner. `icon`: { id,
 * name, hue?, saturation? (percent), kind?: "glyph" | "image", src? (the icon file, a URL or data: URI) }.
 */
function mark(icon) {
  let hue = icon.hue;
  if (!Number.isInteger(hue)) {
    let hash = 0;
    for (const ch of icon.id ?? "") hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    hue = hash % 360;
  }
  const el = node("span", "app-icon jw-mark");
  el.setAttribute("aria-hidden", "true");
  el.style.setProperty("--size", "16px");
  el.style.setProperty("--hue", String(hue));
  if (Number.isInteger(icon.saturation)) el.style.setProperty("--s", String(icon.saturation / 100));
  if (icon.src && icon.kind === "image") {
    const img = node("img", "icon-img");
    img.alt = "";
    img.src = icon.src;
    el.append(img);
  } else if (icon.src) {
    const glyph = node("span", "icon-mask");
    for (const p of ["mask-image", "-webkit-mask-image"]) glyph.style.setProperty(p, `url("${icon.src}")`);
    el.append(glyph);
  } else el.append((icon.name ?? "?").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase());
  return el;
}

/**
 * Draw a widget's output into `container` (replacing its contents), at `size`. `onButton(button,
 * element)` makes the view's buttons live (they run the capability's operation); without it the
 * buttons aren't shown. A `reveal` text stays hidden behind "Show" until tapped (nothing is
 * written). `icon`: the capability's icon for the corner (see mark). Returns the widget element.
 */
export function renderWidget(container, output, { size = "medium", title = "", onButton, icon } = {}) {
  const view = viewFor(output, size);
  const el = node("div", `jw jw-${size}`);
  if (icon) el.append(mark(icon)), el.classList.add("jw-marked");
  if (title) el.append(node("div", "jw-title", title));
  const draw = view && body[view.template];
  if (!draw) el.append(node("div", "jw-empty", view ? "This widget can't be shown." : ""));
  else {
    el.classList.add(`jw-t-${view.template}`);
    const content = node("div", "jw-body", ...draw(view, size));
    el.append(content);
    const row = [];
    // "Show" sits with the buttons; tapping it swaps the body for the hidden text (the answer).
    if (view.reveal) {
      const show = node("button", "jw-button jw-show", "Show");
      show.type = "button";
      show.addEventListener("click", (e) => (e.stopPropagation(), content.replaceChildren(node("div", "jw-reveal", view.reveal)), show.remove()));
      row.push(show);
    }
    for (const b of onButton ? (view.buttons ?? []).slice(0, 3) : []) {
      const btn = node("button", "jw-button", b.label);
      btn.type = "button";
      btn.addEventListener("click", (e) => (e.stopPropagation(), onButton(b, btn)));
      row.push(btn);
    }
    if (row.length) el.append(node("div", "jw-buttons", ...row)), el.classList.add("jw-has-buttons");
  }
  container.replaceChildren(el);
  if (view?.template === "list") fitList(el, view.items.length);
  return el;
}

/**
 * A list shows the rows that fit (at least one), then "+N more" if that fits too: buttons or
 * long details leave less room. Measured once the widget is laid out (it may not be in the page yet).
 */
function fitList(el, total) {
  const content = el.querySelector(".jw-body");
  const list = el.querySelector(".jw-list");
  if (!content || !list) return;
  const over = () => content.scrollHeight > content.clientHeight + 2;
  const fit = () => {
    if (!content.clientHeight) return;
    while (over() && list.children.length > 1) {
      list.lastElementChild.remove();
      const more = content.querySelector(".jw-more") ?? content.appendChild(node("div", "jw-caption jw-more"));
      more.textContent = `+${total - list.children.length} more`;
    }
    if (over()) content.querySelector(".jw-more")?.remove();
  };
  new ResizeObserver(fit).observe(content);
}
