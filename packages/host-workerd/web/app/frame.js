// SPDX-License-Identifier: AGPL-3.0-or-later
// The page frame: navigation, shortcuts, the current screen's cleanups, the platform settings and
// the top bars every screen uses.
import { api, BRAND, caps, h, menuFrom, modal, pixelGlyph, rememberAgents, rowCells, tintOf } from "../kit.js";
import { closeInbox, inboxBtn, inboxPanel, toggleInbox } from "./inbox.js";
import { commandPalette } from "./palette.js";
import { route } from "./router.js";

export {
  backBar,
  bar,
  brand,
  brandTile,
  browserZone,
  glassBack,
  go,
  hewnMachine,
  holdDraws,
  hues,
  keyHandlers,
  leaving,
  loadSettings,
  moment,
  onKey,
  onLeave,
  page,
  put,
  releaseHeld,
  sandboxNotice,
  setSettings,
  settings,
  shortcutsDialog,
  stillHere,
  topBar,
  view,
};

const app = document.getElementById("app");
const go = (hash) => (location.hash === hash ? route() : (location.hash = hash));

// ---------- page frame ----------

/**
 * Keyboard shortcuts (desktop): single keys when you're not typing. Screens add their own with
 * onKey(); global ones: n new, h home, i inbox, a activity, b builds, g agents, u accounts,
 * , settings, ? this list.
 */
const keyHandlers = new Map();
const onKey = (key, fn) => (keyHandlers.set(key, fn), onLeave(() => keyHandlers.get(key) === fn && keyHandlers.delete(key)));
const SHORTCUTS = [
  ["n", "New tool", () => go("#/new")],
  ["h", "Home", () => go("#/")],
  ["e", "Edit Home", null],
  ["i", "Inbox", () => toggleInbox()],
  ["a", "Activity", () => go("#/activity")],
  ["b", "Builds", () => go("#/activity?view=builds")],
  ["g", "Agents", () => go("#/agents")],
  ["u", "Accounts", () => go("#/accounts")],
  [",", "Settings", () => go("#/settings")],
  ["/", "Search and commands (⌘K)", () => commandPalette()],
  ["?", "Shortcuts", () => shortcutsDialog()],
];
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.altKey) return (e.preventDefault(), document.querySelector("dialog.palette[open]") ? null : commandPalette());
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  const t = e.target;
  if (e.key === "Escape" && inboxPanel.isConnected) return (e.preventDefault(), closeInbox(true));
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (document.querySelector("dialog[open]")) return;
  const fn = keyHandlers.get(e.key) ?? SHORTCUTS.find(([k, , f]) => k === e.key && f)?.[2];
  if (fn) (e.preventDefault(), fn());
});
function shortcutsDialog() {
  return modal((close) => [
    h("h2", {}, "Shortcuts"),
    h("dl", { class: "kv" }, SHORTCUTS.map(([k, label]) => [h("dt", {}, h("code", {}, k)), h("dd", {}, label)]), h("dt", {}, h("code", {}, "Esc")), h("dd", {}, "Close a dialog, menu or the Inbox")),
    h("div", { class: "actions flush" }, h("button", { onclick: () => close() }, "Done")),
  ], { width: 360 });
}

/** Cleanups for the current screen (streams, timers, animations), run on navigation. */
let leaving = [];
const onLeave = (fn) => leaving.push(fn);
/**
 * For a page that waits before it draws: call it as the page starts, then after each wait ask the
 * function it returns whether to go on. It says no once the page has been left (the router went on
 * to another page, or this one is drawn again), so a slow page can't draw over the one after it.
 */
const stillHere = () => {
  let here = true;
  onLeave(() => (here = false));
  return () => here;
};

/** replaceChildren, skipping the false/null/"" that conditional children produce. */
const put = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false && n !== ""));
/**
 * The page on screen stays until the next one is ready. While the router holds it for a route
 * (`holdDraws(n)`), a loading draw (aria-busy) is held back, and the latest one is drawn only if
 * the router stops waiting first (`releaseHeld(n)`: it gave up, or the route is done); a real draw
 * goes on screen at once and the hold stays the route's, so no other draw can end it early.
 * Otherwise every page change flashed a skeleton and built the page again downwards.
 */
let holding = null;
let held = null;
const isBusy = (n) => n instanceof Element && (n.matches('[aria-busy="true"]') || !!n.querySelector('[aria-busy="true"]'));
const view = (...nodes) => {
  if (holding !== null && nodes.flat(Infinity).some(isBusy)) return void (held = nodes);
  held = null;
  put(app, ...nodes);
};
const holdDraws = (route) => ((holding = route), (held = null));
const releaseHeld = (route) => {
  if (holding !== route) return;
  holding = null;
  if (held) put(app, ...held);
  held = null;
};

/** Platform settings: the persistent "sandbox off" notice, the owner's time zone and jobs. */
let settings = null;
/** Only this module can assign `settings` (an import is read-only): the others go through this. */
const setSettings = (s) => (settings = s);
/** The browser's time zone: the default for the owner's, until they set one. */
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const loadSettings = async () => {
  settings = await api("/settings").catch(() => null);
  // Taken from the browser the first time, editable under Settings › General.
  if (settings && !settings.timeZone && browserZone()) settings = await api("/settings", { method: "PUT", body: { timeZone: browserZone() } }).catch(() => settings);
  // The host's builder goes by the name the host gives it, which only /tools knows: once per load.
  if (settings?.builder === "remote" || settings?.intake === "remote") for (const t of await api("/tools").catch(() => [])) if (t.remote) rememberAgents([{ id: t.name, name: t.label }]);
  return settings;
};
const sandboxNotice = () =>
  settings?.sandbox === false &&
  !settings.hosted &&
  h("div", { class: "notice danger sandbox-off" }, h("span", {}, "Sandbox is off. Tool code runs with your full access. ", h("a", { href: "#/settings/general" }, "Settings")));

const GLYPH = ["##..#", ".#..#", ".####", ".#..#", ".#..#"];
const brandGlyph = () => pixelGlyph(rowCells(GLYPH));
const brandTile = (size = 28) => h("span", { class: `app-icon brand${size < 24 ? " mini" : ""}`, style: { "--size": `${size}px` } }, brandGlyph());
const brand = () => h("a", { class: "brand-link", href: "#/" }, brandTile(), h("span", { class: "brand-name" }, BRAND));

const NAV = [
  ["Home", "#/", "home"],
  ["Hub", "#/hub", "hub"],
  ["Agents", "#/agents", "agents"],
  ["Accounts", "#/accounts", "accounts"],
  ["Settings", "#/settings", "settings"],
];
/**
 * The one top bar every screen uses: left / centre / right slots on a fixed-height grid, so the
 * brand, back buttons and glass bars sit in the same place everywhere.
 */
const bar = ({ left, center, right } = {}) =>
  h("header", { class: "topbar" }, h("div", { class: "topbar-left" }, left), h("div", { class: "topbar-center" }, center), h("div", { class: "topbar-right" }, right));
const glassBack = (label, href) => h("div", { class: "glass-bar" }, h("a", { href }, `‹ ${label}`));

/**
 * Main pages: brand left; the four tabs and the Inbox right. On a phone the tabs fold into a ☰
 * menu while the Inbox stays visible.
 */
const topBar = (active) => {
  const menuBtn = h("button", { "aria-label": "Menu" }, "☰");
  menuBtn.addEventListener("click", () => menuFrom(menuBtn, NAV.map(([label, href]) => [label, () => go(href)])));
  return bar({
    left: brand(),
    right: [
      h("button", { class: "palette-btn", "aria-label": "Search and commands", title: "Search and commands (⌘K)", onclick: () => commandPalette() }, h("span", {}, "Search"), h("kbd", {}, /Mac/i.test(navigator.platform) ? "⌘K" : "Ctrl K")),
      h("nav", { class: "glass-bar main-nav", "aria-label": "Main" }, NAV.map(([label, href, key]) => h("a", { href, "aria-current": key === active ? "page" : undefined }, label))),
      h("div", { class: "glass-bar nav-menu" }, menuBtn),
      inboxBtn,
    ],
  });
};

/** Moment screens and Info: a back button, optional actions on the right. */
const backBar = (label, href, right) => bar({ left: glassBack(label, href), right });

/** A standard page: top bar, notices, a centred column of the given width. */
const page = (active, width, ...content) => view(topBar(active), sandboxNotice(), h("main", { class: "column", style: { "--w": `${width}px` } }, content));

/** The ASCII H, only on moment screens. Returns [field, ...rest] wrapper so the rest sits above it. */
function moment(asciiPos, ...content) {
  const pre = h("pre", { style: asciiPos });
  if (window.hewnAscii) {
    const stop = window.hewnAscii(pre, { cols: 64, rows: 40 });
    onLeave(stop);
  }
  return [h("div", { class: "ascii-field", "aria-hidden": "true" }, pre), h("div", { class: "moment" }, content)];
}

async function hues(first = []) {
  const list = [...(await caps().catch(() => new Map())).values()];
  return [...first, ...list.map(tintOf)].slice(0, 4);
}

/** "this Mac" / "this computer" / "this server": where Hewn (and the agents it runs) live. */
let machineWords = null;
async function hewnMachine() {
  if (machineWords) return machineWords;
  const [status, remote] = await Promise.all([api("/status").catch(() => ({})), api("/remote").catch(() => ({}))]);
  const local = remote.here !== "public";
  const word = !local ? "this server" : /Mac/i.test(navigator.platform) ? "this Mac" : "this computer";
  return (machineWords = { word, name: status.machine ?? null, here: remote.here ?? "local", text: `${word}${status.machine && !local ? ` (${status.machine})` : ""}` });
}
