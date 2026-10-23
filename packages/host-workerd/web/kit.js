// SPDX-License-Identifier: AGPL-3.0-or-later
// Hewn web client toolkit: DOM helpers and the shared pieces every screen uses (icons, dialogs,
// toasts, menus, wallpaper). Plain DOM, no innerHTML anywhere: capability output is untrusted
// and is only ever inserted as text.

/** Every user-visible product name and command goes through these (the name isn't final). */
export const BRAND = "Hewn";
export const CLI = "hewn";

/**
 * The server's web-client fingerprint (x-hewn-web). If it changes while this page is open, Hewn was
 * upgraded and this page runs old code against the new server: offer a reload (not forced, so
 * nothing typed is lost).
 */
let webBuild;
function checkBuild(res) {
  const v = res.headers.get("x-hewn-web");
  if (!v || v === webBuild) return;
  const changed = webBuild !== undefined;
  webBuild = v;
  if (changed) toast(`${BRAND} was updated`, { dot: "warn", ms: Infinity, action: ["Reload", () => location.reload()] });
}

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { "x-hewn-ui": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  checkBuild(res);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || res.statusText), { data, status: res.status });
  return data;
}

/** Server-sent events over a POST (EventSource is GET-only). Calls onEvent(name, data) per event; `signal` stops it. */
export async function postStream(path, onEvent, body, signal) {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    signal,
    headers: { "x-hewn-ui": "1", accept: "text/event-stream", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  checkBuild(res);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || data.error || res.statusText);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const name = /^event: (.*)$/m.exec(chunk)?.[1];
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (name) onEvent(name, data ? JSON.parse(data) : null);
    }
  }
}

/**
 * h("div", { class: "x", onclick, style: { "--hue": 30 } }, "text", child): children are text or
 * nodes, never HTML. Styles go through CSSOM (the CSP allows no inline style attributes).
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  return fill(el, props, children);
}

const SVG = "http://www.w3.org/2000/svg";
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const c of children.flat(Infinity)) if (c) el.append(c);
  return el;
}

function fill(el, props, children) {
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style") for (const [p, x] of Object.entries(v)) x !== undefined && x !== null && el.style.setProperty(p, String(x));
    else if (k in el && k !== "list" && k !== "form") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false || c === "") continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const errorBox = (e) => h("div", { class: "notice danger" }, h("span", {}, e.message || String(e)));
export const ago = (iso) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
};
export const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
export const enc = encodeURIComponent;

export const skeleton = (...widths) =>
  h("div", { class: "stack", "aria-busy": "true", "aria-label": "Loading" }, (widths.length ? widths : ["40%", "70%", "55%"]).map((w) => h("span", { class: "skeleton", style: { width: w, height: "18px" } })));
export const empty = (title, text) => h("div", { class: "empty" }, h("strong", {}, title), text && h("span", {}, text));

// ---------- agents and actors ----------

const AGENT_LABELS = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", claude: "Claude", agent: "the asking agent", "mcp-client": "MCP client" };
/** Agents' own names (from the Agents API), for activity and cards. */
export const rememberAgents = (list) => list.forEach((a) => a.name && (AGENT_LABELS[a.id] = a.name));
/** Human name for an actor id: agents by label; the owner (web, CLI, an opened app) is "You". */
export function actorLabel(id, caps) {
  if (!id) return "";
  if (id === "web" || id === "user" || id.startsWith("ui:")) return "You";
  if (id.startsWith("capability:")) return caps?.get(id.slice(11))?.name ?? id.slice(11);
  return AGENT_LABELS[id] ?? id;
}
/** A builder by name: the CLIs Hewn runs ("claude" is Claude Code, not the claude.ai agent). */
const BUILDERS = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };
export const builderLabel = (b) => (b === "agent" ? "your agent" : BUILDERS[b] ?? AGENT_LABELS[b] ?? b);

// ---------- capabilities and their icons ----------

let capCache = null;
/** id → capability summary (Home data), shared by cap-refs across screens. */
export async function caps(refresh = false) {
  if (!capCache || refresh) capCache = api("/capabilities").then((list) => new Map(list.map((c) => [c.id, c])));
  try {
    return await capCache;
  } catch (e) {
    capCache = null;
    throw e;
  }
}
export const invalidateCaps = () => (capCache = null);

export function hueOf(cap) {
  if (Number.isInteger(cap?.hue)) return cap.hue;
  let hash = 0;
  for (const ch of cap?.id ?? "") hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}
const monogram = (name) =>
  (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

let iconVersion = Date.now();
export const bumpIcons = () => (iconVersion = Date.now());
/** Where a capability's icon file is: its own, or (while its first build runs) the build's. */
export const iconUrl = (cap) => cap.iconUrl ?? `/api/capabilities/${enc(cap.id)}/icon?v=${iconVersion}`;

/**
 * A 5×5 glyph drawn as separate pixels with a gap between them (cell 0.8, gap 0.2 of the pitch).
 * cells: [{ x, y }] unit cells; `lit` (optional) dims the rest, for building progress.
 */
export function pixelGlyph(cells, lit = cells.length) {
  return svg(
    "svg",
    // A little margin around the cells: pixels on the edge would otherwise be clipped by the svg's own box.
    { viewBox: "-0.2 -0.2 5.2 5.2", class: "glyph" },
    cells.map((c, i) => svg("rect", { x: c.x, y: c.y, width: 0.8, height: 0.8, rx: 0.08, class: i < lit ? "" : "unlit" })),
  );
}
/** Unit cells from rows like ".##..". */
export const rowCells = (rows) => rows.flatMap((r, y) => [...r].flatMap((c, x) => (c === "#" ? [{ x, y }] : [])));

/** Lit unit cells of a glyph icon, parsed as data: the SVG itself is never inserted. */
const glyphs = new Map();
const glyphsDone = new Map();
export function glyphCells(cap) {
  const key = iconUrl(cap);
  if (!glyphs.has(key)) {
    glyphs.set(
      key,
      fetch(key)
        .then((r) => (r.ok ? r.text() : ""))
        .then((text) => {
          const doc = new DOMParser().parseFromString(text, "image/svg+xml");
          const lit = new Map();
          for (const r of doc.querySelectorAll("rect")) {
            const [x, y, w, hh] = ["x", "y", "width", "height"].map((a, i) => Number(r.getAttribute(a) ?? (i < 2 ? 0 : 1)));
            if (![x, y, w, hh].every(Number.isInteger)) continue;
            for (let i = x; i < x + w; i++) for (let j = y; j < y + hh; j++) if (i >= 0 && i < 5 && j >= 0 && j < 5) lit.set(`${i},${j}`, { x: i, y: j });
          }
          const cells = [...lit.values()].sort((a, b) => a.y - b.y || a.x - b.x);
          glyphsDone.set(key, cells);
          return cells;
        })
        .catch(() => []),
    );
    // A build's icon can still change: don't keep it.
    if (cap.iconUrl) setTimeout(() => (glyphs.delete(key), glyphsDone.delete(key)), 10_000);
  }
  return glyphs.get(key);
}

/**
 * The app icon: <span class="app-icon" style="--hue:N">. Inside, in order: the owner's image,
 * the capability's glyph (a CSS mask, so it takes the tile's glyph colour), or a monogram. The
 * glyph sits centred at about 56% of the tile, with square pixels (no emoji icons: design pass 2).
 * `progress` (0–1) marks a building capability: the glyph lights up pixel by pixel.
 */
export function appIcon(cap, { size = 64, badge, more, progress, waiting = false, cls = "" } = {}) {
  // `waiting`: building with no measurable progress yet (code being written): the glyph pulses dimly.
  const building = typeof progress === "number";
  const el = h("span", { class: `app-icon ${building ? "building" : ""} ${building && waiting ? "waiting" : ""} ${cls}`.replace(/\s+/g, " ").trim(), style: { "--size": `${size}px`, "--hue": hueOf(cap) }, "aria-hidden": "true" });
  if (cap?.iconKind === "image") {
    el.append(h("img", { src: iconUrl(cap), alt: "", class: "icon-img" }));
  } else if (cap?.iconKind === "glyph") {
    // Drawn from its cells (so pixels get their gap and can light up one by one while building).
    // Until the cells are known, the file is shown as a CSS mask in the glyph colour.
    const draw = (cells) => pixelGlyph(cells, building ? Math.round(cells.length * progress) : cells.length);
    const known = glyphsDone.get(iconUrl(cap));
    if (known?.length) el.append(draw(known));
    else {
      const mask = h("span", { class: "icon-mask", style: { "mask-image": `url(${iconUrl(cap)})`, "-webkit-mask-image": `url(${iconUrl(cap)})` } });
      el.append(mask);
      glyphCells(cap).then((cells) => (cells.length ? mask.replaceWith(draw(cells)) : building && mask.classList.add("faded")));
    }
  } else {
    el.append(h("span", { class: building ? "faded" : "" }, monogram(cap?.name)));
  }
  if (badge) el.append(h("span", { class: `badge ${badge === "danger" ? "danger" : ""}` }));
  if (more) el.append(more);
  return el;
}

/** Capability references always render as icon + name (inline in text, rows, titles and Activity). */
export function capRef(cap, fallbackId, { size = 20 } = {}) {
  const c = cap ?? { id: fallbackId, name: fallbackId };
  return h("span", { class: "cap-ref" }, appIcon(c, { size }), h("span", {}, c.name));
}
/** A tool as a chip (filters, "used by"): icon + name, a link or a button. */
export const chip = (cap, label, props = {}) => h(props.href ? "a" : "button", { class: "chip", ...props }, appIcon(cap, { size: 24 }), label ?? cap.name);

// ---------- wallpaper ----------

const SPOTS = [
  { x: "-6%", y: "-18%", w: "520px" },
  { x: "62%", y: "-10%", w: "420px" },
  { x: "70%", y: "60%", w: "480px" },
  { x: "8%", y: "68%", w: "380px" },
];
/** Soft pixels behind the glass, tinted with the owner's capability hues. */
export function setWallpaper(hues, { dim = true } = {}) {
  const wp = document.getElementById("wallpaper");
  const list = (hues.length ? hues : [250, 125]).slice(0, 4);
  wp.className = `wallpaper ${dim ? "dim" : ""}`;
  wp.replaceChildren(...list.map((hue, i) => h("i", { style: { "--h": hue, "--x": SPOTS[i].x, "--y": SPOTS[i].y, "--w": SPOTS[i].w } })));
}

// ---------- toasts ----------

/** A toast at the bottom; with `undo`, an Undo button for `ms` (6 s by default); `action`: [label, fn]. */
export function toast(text, { undo, action, dot = "ok", ms = 6000 } = {}) {
  let region = document.querySelector(".toast-region");
  if (!region) document.body.append((region = h("div", { class: "toast-region", role: "status", "aria-live": "polite" })));
  const el = h(
    "div",
    { class: "toast" },
    dot && h("span", { class: `dot ${dot}` }),
    h("span", {}, text),
    undo &&
      h("button", {
        class: "link sm",
        onclick: async () => {
          el.remove();
          try {
            await undo();
          } catch (e) {
            toast(e.message, { dot: "danger" });
          }
        },
      }, "Undo"),
    action && h("button", { class: "link sm", onclick: () => (el.remove(), action[1]()) }, action[0]),
  );
  region.append(el);
  if (Number.isFinite(ms)) setTimeout(() => el.remove(), undo || action ? ms : Math.min(ms, 4000));
  return el;
}
export const fail = (e) => toast(e.message || String(e), { dot: "danger" });

// ---------- dialogs ----------

/**
 * A modal <dialog>. The browser keeps focus inside it and Esc closes it. `build(close)` returns
 * the content; resolves with whatever is passed to close().
 */
export function modal(build, { width = 440, cls = "" } = {}) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { class: `dialog ${cls}`.trim(), style: { width: `min(${width}px, 92vw)` } });
    let result;
    const close = (value) => {
      result = value;
      dlg.close();
    };
    dlg.addEventListener("close", () => (dlg.remove(), resolve(result)));
    // A click on the backdrop closes. A click on a disabled control inside also lands on the dialog
    // element (the control can't take it), so the pointer has to be outside the box too.
    dlg.addEventListener("click", (e) => {
      if (e.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
    });
    dlg.append(...[build(close, dlg)].flat(Infinity).filter(Boolean));
    document.body.append(dlg);
    dlg.showModal();
    // No field starts focused (and ringed) unless the sheet asks for it: the dialog itself takes focus.
    if (!dlg.querySelector("[autofocus]")) {
      dlg.tabIndex = -1;
      dlg.focus();
    }
  });
}

// ---------- the four dialog patterns (design pass 2) ----------
// Request (something wants something), Picker (choose one), Form (edit values, optionally in
// steps) and Confirm (title, one line, two buttons). Same <dialog>, widths of 440 or 520, the
// primary button always bottom-right.

/** A sheet's header: a 44–48px icon (or none), the title, and a faint line under it. */
export const sheetHead = (icon, title, sub) =>
  h("div", { class: "row sheet-head" }, icon, h("div", { class: "grow col" }, h("div", { class: "sheet-title" }, title), sub && h("div", { class: "small faint" }, sub)));

/** A Request's rows: a kind pill, what it is (and a sub-line), and an optional control. */
export const requestRows = (rows) =>
  h("ul", { class: "list" }, rows.filter(Boolean).map((r) => h("li", {}, r.pill, h("div", { class: "grow" }, r.main, r.sub && h("span", { class: `sub ${r.mono ? "mono" : ""}` }, r.sub), r.extra), r.control)));

/** Pill for a Request row: `kind` ("model" and writes are accent, destructive is danger). */
export const kindTag = (text, tone = "") => h("span", { class: `pill ${tone}` }, text);

/** Bottom-right actions: secondary first, then the primary. */
export const sheetActions = (...buttons) => h("div", { class: "actions flush" }, buttons);

/**
 * Request: "X wants to…", who asked, their note as a quote, the rows, then the decline and accept
 * buttons. `onAccept(close)` runs with the primary disabled; `ready()` (optional) gates it.
 * Resolves with what the handlers pass to close (decline: false).
 */
export function requestSheet({ icon, title, sub, quote, rows = [], extra, decline = "Not now", accept = "Allow", danger = false, onAccept, onDecline, width = 480 }) {
  return modal(
    (close) => {
      const yes = h("button", { class: danger ? "danger solid" : "primary" }, accept);
      const no = h("button", {}, decline);
      yes.addEventListener("click", async () => {
        yes.disabled = no.disabled = true;
        try {
          await (onAccept ? onAccept(close) : close(true));
        } catch (e) {
          fail(e);
        } finally {
          yes.disabled = no.disabled = false;
        }
      });
      no.addEventListener("click", async () => {
        try {
          await (onDecline ? onDecline(close) : close(false));
        } catch (e) {
          fail(e);
        }
      });
      return [sheetHead(icon, title, sub), quote && h("div", { class: "quote small" }, `“${quote}”`), rows.length > 0 && requestRows(rows), extra, sheetActions(no, yes)];
    },
    { width },
  );
}

/**
 * Picker: choose one of a list of radio rows. options: { value, label, sub, tile, disabled }.
 * Resolves the chosen value, or null.
 */
export function pickerSheet({ icon, title, sub, options, value = null, note, confirm: label = "Use it", width = 480, unchanged = true }) {
  return modal(
    (close) => {
      let chosen = value;
      const ok = h("button", { class: "primary" });
      const sync = () => {
        ok.disabled = chosen === null || chosen === undefined || (unchanged && chosen === value);
        ok.textContent = typeof label === "function" ? label(chosen) : label;
      };
      const name = `pick-${Math.random().toString(36).slice(2)}`;
      const rows = options.map((o) => {
        const radio = h("input", { type: "radio", name, checked: o.value === value, disabled: !!o.disabled });
        radio.addEventListener("change", () => ((chosen = o.value), sync()));
        return h("label", { class: `job-option ${o.disabled ? "unavailable" : ""}` }, radio, o.tile, h("span", { class: "grow col" }, h("span", {}, o.label), o.sub && h("span", { class: "sub" }, o.sub)), o.aside);
      });
      ok.addEventListener("click", () => close(chosen));
      sync();
      return [sheetHead(icon, title, sub), h("fieldset", { class: "job" }, rows), note && h("div", { class: "small faint" }, note), sheetActions(h("button", { onclick: () => close(null) }, "Cancel"), ok)];
    },
    { width },
  );
}

/** Step pills for a multi-step Form: "1 · Account ✓", "2 · Code". */
export const sheetSteps = (labels, at) =>
  h("div", { class: "sheet-steps" }, labels.map((l, i) => h("span", { class: `pill ${i < at ? "ok" : i === at ? "accent" : ""}` }, `${i + 1} · ${l}${i < at ? " ✓" : ""}`)));

/**
 * Form: edit values. `build(close, api)` returns the body; it calls api.actions(...) for the
 * footer. A thin wrapper so every form has the same head, widths and footer.
 */
export function formSheet({ icon, title, sub, build, width = 440 }) {
  return modal((close) => [sheetHead(icon, title, sub), build(close)].flat(Infinity), { width });
}

/** A command or address to copy: mono text on the log surface, with Copy. */
export const commandBlock = (text, what = "Command") =>
  h("div", { class: "command-block" }, h("span", {}, text), h("button", { class: "sm", onclick: () => navigator.clipboard.writeText(text).then(() => toast(`${what} copied`), fail) }, "Copy"));

/** Confirmation dialog. Resolves true when confirmed. */
export function confirmDialog({ title, body, confirm = "OK", danger = false, cancel = "Cancel" }) {
  return modal(
    (close) => [
      h("h2", {}, title),
      body && h("div", { class: "muted dialog-body" }, body),
      h("div", { class: "actions" }, h("button", { onclick: () => close(false) }, cancel), h("button", { class: danger ? "danger solid" : "primary", onclick: () => close(true) }, confirm)),
    ],
    { width: 420 },
  ).then(Boolean);
}

// ---------- menus ----------

let openMenuEl = null;
export function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
}
// Outside clicks close the menu, but not the click that opened it (it bubbles here right after).
let menuArmed = false;
document.addEventListener("click", (e) => openMenuEl && menuArmed && !openMenuEl.contains(e.target) && closeMenu());
window.addEventListener("hashchange", closeMenu);
window.addEventListener("resize", closeMenu);

/** A context menu at (x, y). items: [label, fn, { danger }] or "-" for a divider. Arrow keys move, Esc closes. */
export function openMenu(items, x, y, { returnFocus } = {}) {
  closeMenu();
  const buttons = [];
  const menu = h(
    "div",
    { class: "menu context", role: "menu" },
    items.filter(Boolean).map((it) => {
      if (it === "-") return h("hr");
      const [label, fn, o = {}] = it;
      const b = h("button", { role: "menuitem", class: o.danger ? "danger" : "", onclick: (e) => (e.stopPropagation(), closeMenu(), fn()) }, label);
      buttons.push(b);
      return b;
    }),
  );
  menu.addEventListener("keydown", (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === "ArrowDown") buttons[(i + 1) % buttons.length].focus();
    else if (e.key === "ArrowUp") buttons[(i - 1 + buttons.length) % buttons.length].focus();
    else if (e.key === "Home") buttons[0].focus();
    else if (e.key === "End") buttons.at(-1).focus();
    else if (e.key === "Escape" || e.key === "Tab") (closeMenu(), returnFocus?.focus());
    else return;
    e.preventDefault();
  });
  // Inside a modal dialog the menu must live in the dialog (the top layer covers the body).
  (returnFocus?.closest("dialog[open]") ?? document.body).append(menu);
  const r = menu.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, innerWidth - r.width - 8));
  const top = Math.max(8, Math.min(y, innerHeight - r.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  // A dialog can be the menu's containing block (it has a backdrop filter): correct to viewport coordinates.
  const at = menu.getBoundingClientRect();
  if (Math.round(at.left) !== Math.round(left) || Math.round(at.top) !== Math.round(top)) {
    menu.style.left = `${2 * left - at.left}px`;
    menu.style.top = `${2 * top - at.top}px`;
  }
  openMenuEl = menu;
  menuArmed = false;
  setTimeout(() => (menuArmed = true));
  buttons[0]?.focus();
  return menu;
}
/** Open a menu under a button. */
export const menuFrom = (btn, items) => {
  const r = btn.getBoundingClientRect();
  return openMenu(items, r.left, r.bottom + 6, { returnFocus: btn });
};

/** Long-press for touch; right-click for mouse. Suppresses the click that follows a long-press. */
export function withContextMenu(el, items) {
  let timer;
  let longPressed = false;
  el.addEventListener("contextmenu", (e) => (e.preventDefault(), openMenu(items(), e.clientX, e.clientY, { returnFocus: el })));
  el.addEventListener("keydown", (e) => (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && (e.preventDefault(), menuFrom(el, items())));
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    longPressed = false;
    timer = setTimeout(() => ((longPressed = true), openMenu(items(), e.clientX, e.clientY, { returnFocus: el })), 550);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel", "pointermove"]) el.addEventListener(ev, () => clearTimeout(timer));
  el.addEventListener("click", (e) => longPressed && (e.preventDefault(), e.stopImmediatePropagation(), (longPressed = false)), true);
  return el;
}

// ---------- progress blocks and steps ----------

/** Building-blocks progress bar: n cells, the first done ones on, then `live` live ones. */
export function blocks(n, done, { live = 0, failed = false } = {}) {
  return h(
    "div",
    { class: `blocks ${failed ? "fail" : ""}`, style: { "--cols": n === 48 ? 24 : n }, role: "progressbar", "aria-valuemin": 0, "aria-valuemax": n, "aria-valuenow": done },
    Array.from({ length: n }, (_, i) => h("i", { class: i < done ? "on" : i < done + live ? "live" : "" })),
  );
}
export const stepRow = (label, state, meta, detail) => h("li", { class: `step ${state}` }, h("span", {}, label), h("span", { class: "meta" }, meta ?? ""), detail && h("span", { class: "detail" }, detail));
