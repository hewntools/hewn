// SPDX-License-Identifier: AGPL-3.0-or-later
// An opened tool (its own UI, or the Run view) and the change drawer beside it.
import { api, appIcon, capRef, caps, confirmDialog, enc, errorBox, fail, h, invalidateCaps, menuFrom, setWallpaper, skeleton, tintOf } from "../kit.js";
import { themeNow, withTheme } from "./appearance.js";
import { buildPanel } from "./build.js";
import { bar, glassBack, hues, onLeave, put, sandboxNotice, stillHere, view } from "./frame.js";
import { grantsSheet } from "./grants.js";
import { askFeedbackOnOpen, intakeView } from "./intake.js";
import { route } from "./router.js";
import { runFailure } from "./schedules.js";
import { shareButton } from "./share.js";
import { askFix, capabilityMenu, fixButton, inlineRename, rollbackTo } from "./tool-actions.js";

export { appPage, field, runnableOps, runPage, sidePill };

// ---------- A4 opened tool, A5 Run view, and the change drawer (P1–P5) ----------

/**
 * Bar for an opened tool (its own UI, or the Run view): back, icon + name + version, Change… (pressed
 * while the drawer is open), Share… and •••, as Info has.
 */
function appBar(c, { onChange } = {}) {
  const name = h("span", {}, c.name);
  const more = h("button", { "aria-label": "More", onclick: () => menuFrom(more, capabilityMenu(c, { rename: () => inlineRename(c, name) })) }, "•••");
  const change = h("button", { "aria-pressed": "false", onclick: () => onChange?.() }, "Change…");
  const el = bar({
    left: c.kind === "connection" ? glassBack(c.name, `#/c/${enc(c.id)}`) : glassBack("Home", "#/"),
    center: h("div", { class: "app-title" }, appIcon(c, { size: 28 }), name, c.version && h("span", { class: "pill" }, `v${c.version}`)),
    right: h("div", { class: "glass-bar" }, change, shareButton(c), more),
  });
  return { el, change };
}

const DRAWER_WIDTH = "hewn.drawer.width";
// Narrower than this and the box's tools (Attach, the model, Send) no longer fit on a line.
const DRAWER_MIN = 420;
const drawerWidth = (w) => Math.round(Math.max(DRAWER_MIN, Math.min(w, window.innerWidth * 0.7, 960)));
/**
 * Drag `grip` (or press ← →) to set `el`'s width; it's kept for next time. A narrower window
 * narrows it, and the width comes back when there's room again.
 */
function resizable(el, grip) {
  let chosen = Number(localStorage.getItem(DRAWER_WIDTH)) || null;
  const fit = () => chosen && (el.style.width = `${drawerWidth(chosen)}px`);
  const set = (w) => ((chosen = drawerWidth(w)), fit());
  const keep = () => chosen && localStorage.setItem(DRAWER_WIDTH, String(chosen));
  fit();
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    const move = (m) => set(window.innerWidth - m.clientX);
    // However the drag ends (let go, cancelled, the capture lost), the page is usable again
    // (while dragging, the tool's frame doesn't take the pointer), and the width is kept once.
    const end = () => {
      for (const [type, fn] of listeners) grip.removeEventListener(type, fn);
      document.body.classList.remove("resizing");
      keep();
    };
    const listeners = [["pointermove", move], ["pointerup", end], ["pointercancel", end], ["lostpointercapture", end]];
    for (const [type, fn] of listeners) grip.addEventListener(type, fn);
  });
  grip.addEventListener("keydown", (e) => (e.key === "ArrowLeft" || e.key === "ArrowRight") && (e.preventDefault(), set(el.offsetWidth + (e.key === "ArrowLeft" ? 40 : -40)), keep()));
  window.addEventListener("resize", fit);
  onLeave(() => (window.removeEventListener("resize", fit), document.body.classList.remove("resizing")));
}

/**
 * The change drawer beside an opened tool (P1): the intake as a component, then the build (P3),
 * then "vN is ready" with Reload and Undo (P4). The tool stays live on the left. Closing it while
 * a build runs is fine: the tile and the Inbox take over.
 */
function changeDrawer(c, q, { onReload, onClose, noUi = false }) {
  const body = h("div", { class: "drawer-body" });
  const close = h("button", { class: "ghost sm icon-only", "aria-label": "Close", onclick: () => onClose() }, "×");
  // Its left edge drags to make it wider or narrower; the width is kept (in this browser).
  const grip = h("div", { class: "drawer-grip", role: "separator", "aria-orientation": "vertical", "aria-label": "Drawer width", tabindex: 0 });
  const el = h("aside", { class: "drawer", "aria-label": `Change ${c.name}` }, grip, h("div", { class: "drawer-head" }, h("span", { class: "row tight" }, h("span", { class: "eyebrow" }, "Change"), capRef(c)), close), body);
  resizable(el, grip);
  let intake = null;
  const showBuild = (buildId) => {
    intake = null;
    const panel = buildPanel(buildId, {
      compact: true,
      onPromoted: (b) => {
        const v = `v${b.resultVersion ?? ""}`;
        const notice = h("div", { class: "notice ok drawer-ready" });
        const more = () => h("button", { class: "sm", onclick: showIntake }, "Change more");
        // Undone: say so (the notice no longer names the version that's gone).
        const undo = h("button", { class: "sm ghost", onclick: () => undoChange(c, b).then(() => (onReload(), put(notice, h("span", { class: "grow" }, h("b", {}, `Back to v${(b.resultVersion ?? 2) - 1}.`)), more())), fail) }, "Undo");
        // Once reloaded, it says so (no Reload to press again), and offers the next change.
        const shown = () => put(notice, h("span", { class: "grow" }, h("b", {}, `${v} is on screen.`)), more(), undo);
        put(notice, h("span", { class: "grow" }, h("b", {}, `${v} is ready.`), " Reload to see it."), h("button", { class: "sm primary", onclick: () => (onReload(), shown()) }, "Reload"), undo);
        return notice;
      },
    });
    put(body, panel.el);
  };
  const showIntake = () => {
    intake = intakeView({ mode: "modify", cap: c, q, embedded: true, onBuilt: (b) => (invalidateCaps(), showBuild(b.buildId)) });
    put(body, intake.el);
    setTimeout(() => intake?.focus());
  };
  // A change already building: follow it here.
  if (c.building?.buildId) showBuild(c.building.buildId);
  else showIntake();
  return { el, focus: () => intake?.focus(), setText: (t) => intake?.setText(t) };
}

/** Undo a change from the drawer: back to the version before it (as Versions does). */
async function undoChange(c, b) {
  const from = (b.resultVersion ?? 1) - 1;
  if (from < 1) throw new Error("Nothing to go back to");
  await rollbackTo(c, from);
}

/** Opened tool or Run view with the drawer when ?change=1. Toggling it keeps the tool where it is. */
function withDrawer(c, q, main, { reload, noUi = false, api: drawerApi = {} }) {
  const { el: barEl, change } = appBar(c, { onChange: () => toggle() });
  const layout = h("div", { class: "with-drawer" }, h("div", { class: "drawer-main" }, main));
  let drawer = null;
  const setUrl = (open) => {
    const p = new URLSearchParams(q);
    if (open) p.set("change", "1");
    else for (const k of ["change", "m", "send", "widget", "from", "fix"]) p.delete(k);
    history.replaceState(null, "", `#/${noUi ? "run" : "app"}/${enc(c.id)}${[...p].length ? `?${p}` : ""}`);
  };
  // Closing the drawer hides it: the conversation (and a build in progress) is there again on Change.
  const shown = () => !!drawer && drawer.el.style.display !== "none";
  const open = () => {
    if (!drawer) {
      drawer = changeDrawer(c, q, { onReload: reload, onClose: () => toggle(false), noUi });
      layout.append(drawer.el);
    } else drawer.el.style.display = "";
    change.setAttribute("aria-pressed", "true");
    setUrl(true);
  };
  const toggle = (want = !shown()) => {
    if (want && !shown()) open();
    else if (!want && shown()) {
      drawer.el.style.display = "none";
      change.setAttribute("aria-pressed", "false");
      for (const k of ["m", "send", "widget", "from", "fix"]) q.delete(k);
      setUrl(false);
    } else drawer?.focus();
  };
  if (q.get("change") === "1") open();
  /** Open the drawer (if it isn't), with `text` in the composer when given; without, what's typed stays. */
  drawerApi.open = (text) => (toggle(true), text === undefined ? drawer?.focus() : drawer?.setText(text));
  return [barEl, layout];
}

async function appPage(id, q) {
  const here = stillHere();
  document.body.classList.add("app-mode");
  // ?at=<section>: a widget's tap opens the UI there ("open": "ui#today").
  const at = q?.get("at");
  const openUrl = async () => (await api(`/capabilities/${enc(id)}/open`, { method: "POST", ...(at ? { body: { section: at } } : {}) })).url;
  const [all, url] = await Promise.all([caps(true), openUrl()]);
  if (!here()) return;
  const c = all.get(id) ?? { id, name: id };
  // Sandboxed without allow-same-origin (the server's CSP says the same): the app runs on an
  // opaque origin and cannot touch or navigate the web client.
  const frame = h("iframe", { class: "app-frame loading", src: withTheme(url), title: c.name, sandbox: "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals", allow: "clipboard-write" });
  const scrollKey = `hewn.scroll.${id}`;
  const subtitle = h("span", { class: "app-subtitle muted" });
  const reload = async () => {
    invalidateCaps();
    frame.classList.add("loading");
    frame.src = withTheme(await openUrl());
    // The bar's version follows (v1 → v2).
    const now = (await caps(true).catch(() => new Map())).get(c.id);
    const pill = barEl.querySelector(".app-title .pill");
    if (now?.version && pill) pill.textContent = `v${now.version}`;
  };
  const drawerApi = {};
  const [barEl, layout] = withDrawer(c, q, frame, { reload, api: drawerApi });
  barEl.querySelector(".app-title")?.append(subtitle);
  const feedbackSlot = h("div", { class: "feedback-slot" });
  askFeedbackOnOpen(c, drawerApi, feedbackSlot);
  const fixSlot = h("div", { class: "fix-slot" });
  const showFix = async () => {
    // This screen's own failure (its calls run as ui:<id>), not an agent's or a schedule's.
    const f = (await api(`/capabilities/${enc(c.id)}/failures`).catch(() => [])).find((x) => x.caller === `ui:${c.id}`);
    if (!f || Date.now() - Date.parse(f.at) > 60_000) return;
    put(fixSlot, h("div", { class: "notice danger fix-bar" }, h("span", { class: "grow" }, `${f.operation.split("@")[0]} failed: ${runFailure(f.error, f.operation)}`), fixButton(() => askFix(c, f)), h("button", { class: "ghost sm icon-only", "aria-label": "Dismiss", onclick: () => put(fixSlot) }, "×")));
  };
  const onMessage = (e) => {
    if (e.origin !== "null" || e.source !== frame.contentWindow || e.data?.hewn !== 1) return;
    const m = e.data;
    if (m.type === "meta") {
      const title = typeof m.title === "string" ? m.title.trim() : "";
      subtitle.textContent = title && title !== c.name ? `· ${title}` : "";
      // Only a plain colour value: it's someone else's string.
      const color = typeof m.themeColor === "string" && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|oklch\([\d\s.%/]+\))$/i.test(m.themeColor.trim()) ? m.themeColor.trim() : "";
      if (color) barEl.style.setProperty("--app-theme", color);
      else barEl.style.removeProperty("--app-theme");
      barEl.classList.toggle("themed", !!color);
    }
    if (m.type === "scroll") sessionStorage.setItem(scrollKey, String(Number(m.y) || 0));
    // An operation failed in the tool's own screen: what failed comes from Hewn's record, not the page.
    if (m.type === "failed") showFix();
    if (m.type === "ready") {
      frame.classList.remove("loading");
      // A page the tool loaded itself had no fragment: tell it again.
      postTheme();
      const y = Number(sessionStorage.getItem(scrollKey) ?? 0);
      if (y > 0) frame.contentWindow.postMessage({ hewn: 1, type: "restore-scroll", y }, "*");
    }
  };
  window.addEventListener("message", onMessage);
  onLeave(() => window.removeEventListener("message", onMessage));
  // Light or dark changed (⌘K) while the tool is open.
  const postTheme = () => frame.contentWindow?.postMessage({ hewn: 1, type: "theme", theme: themeNow() }, "*");
  window.addEventListener("hewn:theme", postTheme);
  onLeave(() => window.removeEventListener("hewn:theme", postTheme));
  // Older apps (or a slow first paint): don't stay invisible.
  const reveal = setInterval(() => frame.classList.remove("loading"), 1500);
  onLeave(() => clearInterval(reveal));
  view(barEl, fixSlot, layout, feedbackSlot);
}

const isFlat = (o) => o && typeof o === "object" && !Array.isArray(o) && Object.values(o).every((v) => v === null || typeof v !== "object");

function table(rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const num = new Set(cols.filter((k) => rows.every((r) => r[k] === undefined || r[k] === null || typeof r[k] === "number")));
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, cols.map((c) => h("th", { class: num.has(c) ? "num" : "" }, c)))),
      h("tbody", {}, rows.map((r) => h("tr", {}, cols.map((c) => h("td", { class: num.has(c) ? "num" : "" }, r[c] === undefined || r[c] === null ? "" : String(r[c])))))),
    ),
  );
}

/**
 * A chart above a table of rows when they're a series: a label column (date, week, name…) and
 * numeric columns. Up to 3 series; bars for short series, a line for long ones.
 */
function seriesChart(rows) {
  if (rows.length < 3) return null;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const numeric = cols.filter((c) => rows.every((r) => typeof r[c] === "number") && !/(^id$|Id$|_id$|version)/i.test(c));
  const label = cols.find((c) => /^(date|day|week|month|year|label|name|period)$/i.test(c)) ?? cols.find((c) => rows.every((r) => typeof r[c] === "string"));
  if (!numeric.length || !label) return null;
  const el = h("div", { class: "chart result-chart" });
  const series = numeric.slice(0, 3).map((c) => ({ name: c, values: rows.map((r) => r[c]) }));
  import("/_platform/chart.js").then(({ barChart, lineChart }) => (rows.length > 24 ? lineChart : barChart)(el, { labels: rows.map((r) => String(r[label])), series, unit: series.length === 1 ? unitOf(numeric[0]) ?? "" : "" })).catch(() => el.remove());
  return el;
}

function renderResult(value) {
  if (Array.isArray(value) && value.length && value.every(isFlat)) return h("div", { class: "stack" }, seriesChart(value), table(value));
  if (Array.isArray(value) && !value.length) return h("p", { class: "muted" }, "Nothing yet.");
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    const arrays = entries.filter(([, v]) => Array.isArray(v) && v.length && v.every(isFlat));
    const scalars = entries.filter(([, v]) => v === null || typeof v !== "object");
    if (arrays.length === 1 && scalars.length + 1 === entries.length) {
      return h("div", { class: "stack" }, scalars.length > 0 && h("dl", { class: "kv" }, scalars.map(([k, v]) => [h("dt", {}, k), h("dd", {}, String(v))])), seriesChart(arrays[0][1]), table(arrays[0][1]));
    }
    if (entries.every(([, v]) => v === null || typeof v !== "object")) return h("dl", { class: "kv" }, entries.map(([k, v]) => [h("dt", {}, k), h("dd", {}, String(v))]));
  }
  return h("pre", { class: "code" }, JSON.stringify(value, null, 2));
}

/** Units read from field names: distanceKm → km, durationSeconds → s (shown, and seconds accept mm:ss). */
const UNITS = [[/Km$/, "km"], [/Meters$/, "m"], [/Seconds$|Secs?$/, "s"], [/Minutes$|Mins$/, "min"], [/Hours$/, "h"], [/Kg$/, "kg"], [/Percent$|Pct$/, "%"], [/Bpm$/, "bpm"], [/Pages$/, "pages"], [/Kcal$|Calories$/, "kcal"]];
const unitOf = (name) => UNITS.find(([re]) => re.test(name))?.[1];
/** "1:02:03", "55:12" or "300" → seconds. */
const parseDuration = (v) => {
  if (!/^\d+(:\d{1,2}){0,2}$/.test(v)) return Number.NaN;
  return v.split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0);
};

function field(name, schema, required) {
  const unit = unitOf(name);
  const label = h("span", { class: "label" }, name, required ? " *" : "", unit && h("span", { class: "unit" }, ` · ${unit}`));
  const hint = schema.description ? h("span", { class: "hint" }, schema.description) : null;
  let input;
  let read;
  const t = Array.isArray(schema.type) ? schema.type.find((x) => x !== "null") : schema.type;
  if (schema.enum) {
    input = h("select", {}, !required && h("option", { value: "" }, "—"), schema.enum.map((v) => h("option", { value: JSON.stringify(v) }, String(v))));
    read = () => (input.value === "" ? undefined : JSON.parse(input.value));
  } else if (t === "boolean") {
    input = h("input", { type: "checkbox", class: "switch" });
    read = () => (input.checked ? true : required ? false : undefined);
    return { el: h("label", { class: "field check-field" }, h("span", { class: "row between" }, label, input), hint), read, write: (v) => (input.checked = !!v) };
  } else if ((t === "number" || t === "integer") && unit === "s") {
    // Durations: type 55:12 or 1:02:03, or plain seconds.
    input = h("input", { type: "text", inputmode: "numeric", placeholder: "mm:ss", value: schema.default ?? "" });
    read = () => {
      if (input.value.trim() === "") return undefined;
      const n = parseDuration(input.value.trim());
      if (Number.isNaN(n)) throw new Error(`${name}: use mm:ss, h:mm:ss or seconds`);
      return n;
    };
  } else if (t === "number" || t === "integer") {
    input = h("input", { type: "number", step: t === "integer" ? "1" : "any", value: schema.default ?? "" });
    read = () => (input.value === "" ? undefined : Number(input.value));
  } else if (t === "string") {
    const isDate = /\\d\{4\}-\\d\{2\}-\\d\{2\}|^\^\\d\{4\}/.test(schema.pattern ?? "") || schema.format === "date";
    // Some browsers draw an empty date field with today's date in grey: it looks filled but sends
    // nothing. A required date without a default starts as today for real.
    const value = schema.default ?? (isDate && required ? new Date().toLocaleDateString("en-CA") : "");
    input = (schema.maxLength ?? 0) > 500 ? h("textarea", { rows: 3 }) : h("input", { type: isDate ? "date" : schema.format === "date-time" ? "datetime-local" : "text", value });
    read = () => (input.value === "" ? undefined : input.value);
  } else if (t === "array" && schema.items && ["string", "number", "integer"].includes(schema.items.type)) {
    input = h("input", { type: "text", placeholder: "comma, separated" });
    read = () => {
      if (input.value.trim() === "") return undefined;
      const parts = input.value.split(",").map((s) => s.trim()).filter(Boolean);
      return schema.items.type === "string" ? parts : parts.map(Number);
    };
  } else {
    input = h("textarea", { rows: 3, class: "code", placeholder: "JSON" });
    read = () => (input.value.trim() === "" ? undefined : JSON.parse(input.value));
  }
  // Required: the browser won't submit it empty, and says which field.
  if (required) input.required = true;
  // Prefill from the last run (stored per operation, in this browser).
  const write = (v) => {
    if (v === undefined || v === null) return;
    if (input.type === "checkbox") input.checked = !!v;
    else if (input.tagName === "SELECT") input.value = JSON.stringify(v);
    else input.value = Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v, null, 2) : String(v);
  };
  return { el: h("label", { class: "field" }, label, input, hint), read, write };
}

const latestOps = (operations) => {
  const latest = new Map();
  for (const op of operations) if ((latest.get(op.name)?.version ?? 0) < op.version) latest.set(op.name, op);
  return [...latest.values()];
};
/** Operations the owner can run from a form. A connection's sign-in step isn't one: it takes a password, so it has its own sheet (Sign in) and never goes into the form's saved inputs. */
const runnableOps = (cap) => latestOps(cap.operations).filter((o) => !(cap.kind === "connection" && o.name === "connect"));
const sidePill = (sideEffect) => h("span", { class: `pill ${sideEffect === "read" ? "" : sideEffect === "destructive" ? "danger" : "accent"}` }, sideEffect);

async function runPage(id, q) {
  const here = stillHere();
  document.body.classList.add("app-mode");
  const [cap, all] = await Promise.all([api(`/capabilities/${enc(id)}`), caps(true)]);
  if (!here()) return;
  const c = all.get(id) ?? { id, name: cap.name, kind: cap.kind };
  setWallpaper(await hues([tintOf(c)]));
  if (!here()) return;
  const ops = runnableOps(cap);
  let selected = ops.find((o) => o.name === q.get("op")) ?? ops[0];
  const right = h("div", { class: "run-main" });
  const rows = new Map();

  const select = (op) => {
    selected = op;
    for (const [name, b] of rows) b.setAttribute("aria-pressed", String(name === op.name));
    const p = new URLSearchParams(location.hash.split("?")[1] ?? "");
    p.set("op", op.name);
    history.replaceState(null, "", `#/run/${enc(id)}?${p}`);
    put(right, ...runForm(id, cap, op).filter(Boolean));
  };
  const list = h(
    "nav",
    { class: "side-list", "aria-label": "Operations" },
    h("div", { class: "eyebrow" }, "Operations"),
    ops.map((op) => {
      const b = h("button", { onclick: () => select(op) }, h("span", { class: "mono grow" }, op.name), sidePill(op.sideEffect));
      rows.set(op.name, b);
      return b;
    }),
    h("span", { class: "spacer" }),
    // No screen yet: a quiet way to ask for one, in the change drawer.
    !cap.ui?.available && cap.kind !== "connection" && h("div", { class: "small faint side-foot" }, h("span", {}, "Want a UI?"), h("button", { class: "link", onclick: () => drawerApi.open("Give it a proper screen") }, "Give it a proper screen ›")),
  );
  const main = h("main", { class: "run" }, list, right);
  const drawerApi = {};
  const [barEl, layout] = withDrawer(c, q, main, { reload: () => route(), noUi: true, api: drawerApi });
  const feedbackSlot = h("div", { class: "feedback-slot" });
  view(barEl, sandboxNotice(), layout, feedbackSlot);
  if (selected) select(selected);
  askFeedbackOnOpen(c, drawerApi, feedbackSlot);
}

function runForm(id, cap, op) {
  const props = op.inputSchema.properties ?? {};
  const required = new Set(op.inputSchema.required ?? []);
  const fields = Object.entries(props).map(([name, schema]) => [name, field(name, schema, required.has(name))]);
  const memoryKey = `hewn.inputs.${id}.${op.name}`;
  try {
    const remembered = JSON.parse(localStorage.getItem(memoryKey) ?? "{}");
    for (const [name, f] of fields) if (name in remembered) f.write(remembered[name]);
  } catch {
    // nothing remembered
  }
  const result = h("div", { class: "card result", hidden: true });
  const runBtn = h("button", { type: "submit", class: "primary", onclick: (e) => e.currentTarget.form?.classList.add("tried") }, "Run");
  const run = async (ev) => {
    ev.preventDefault();
    if (op.sideEffect === "destructive" && !(await confirmDialog({ title: `Run ${op.name}?`, body: "It changes or removes data, and can't be undone.", confirm: "Run", danger: true }))) return;
    const input = {};
    try {
      for (const [name, f] of fields) {
        const v = f.read();
        if (v !== undefined) input[name] = v;
      }
    } catch (e) {
      result.hidden = false;
      return put(result, errorBox(new Error(`Invalid input: ${e.message}`)));
    }
    result.hidden = false;
    put(result, skeleton("30%", "80%"));
    runBtn.disabled = true;
    const started = performance.now();
    const head = (pill) => h("div", { class: "row between result-head" }, h("div", { class: "eyebrow" }, "Result"), pill);
    try {
      const r = await api(`/capabilities/${enc(id)}/invoke`, { method: "POST", body: { operation: op.name, operationVersion: op.version, input } });
      localStorage.setItem(memoryKey, JSON.stringify(input));
      put(result, head(h("span", { class: "pill ok with-dot" }, `ok · ${Math.round(performance.now() - started)}ms`)), renderResult(r.result));
    } catch (e) {
      put(result, head(h("span", { class: "pill danger with-dot" }, `failed · ${Math.round(performance.now() - started)}ms`)), errorBox(e), fixButton(() => askFix(cap, { caller: "user", operation: `${op.name}@${op.version}`, error: e.message, input: JSON.stringify(input).slice(0, 2000) })), e.data?.details ? h("pre", { class: "code" }, JSON.stringify(e.data.details, null, 2)) : "");
    } finally {
      runBtn.disabled = false;
    }
  };
  return [
    !cap.status.ready && h("div", { class: "notice" }, h("span", { class: "grow" }, cap.status.onlySaidNo ? "You said no to what it asks for, so it can't run." : cap.status.missingModel && !cap.status.pendingGrants.length ? "Needs a model." : "Needs your authorization."), h("button", { class: "sm", onclick: () => grantsSheet(id).then((ok) => ok && route()) }, "Review")),
    h("form", { class: "card run-form", onsubmit: run }, h("div", { class: "muted small" }, op.description), fields.length ? h("div", { class: "fields" }, fields.map(([, f]) => f.el)) : null, h("div", { class: "actions flush" }, runBtn)),
    result,
  ];
}
