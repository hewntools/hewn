// SPDX-License-Identifier: AGPL-3.0-or-later
// Hewn web client: the owner's surface. Plain DOM, no innerHTML anywhere: capability output is
// untrusted and is only ever inserted as text. Screens follow the design handoffs (pass 1: A1–E3;
// pass 2: F–P, design/hewn/DESIGN-SYSTEM.md "Pass 2").

import {
  actorLabel,
  ago,
  api,
  appIcon,
  BRAND,
  builderLabel,
  bumpIcons,
  capRef,
  caps,
  chip,
  CLI,
  clock,
  commandBlock,
  confirmDialog,
  empty,
  enc,
  errorBox,
  fail,
  formSheet,
  glyphCells,
  h,
  hueOf,
  iconUrl,
  invalidateCaps,
  kindTag,
  menuFrom,
  modal,
  openMenu,
  pickerSheet,
  pixelGlyph,
  postStream,
  rememberAgents,
  requestRows,
  requestSheet,
  rowCells,
  setWallpaper,
  sheetActions,
  sheetHead,
  sheetSteps,
  skeleton,
  stepRow,
  tintOf,
  toast,
  withContextMenu,
} from "./kit.js";
import { addPasskey, knownPasskeys, passkeyError, passkeysSupported } from "./passkey.js";

const app = document.getElementById("app");
const go = (hash) => (location.hash === hash ? route() : (location.hash = hash));

// ---------- appearance (client-only) ----------
/** Dark mode now: the owner's choice in Settings, else the system's. */
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
/** A build's validation screenshot in the current appearance. */
const shotUrl = (buildId) => `/api/builds/${enc(buildId)}/screenshot${isDark() ? "?scheme=dark" : ""}`;

const THEME_KEY = "hewn.theme";
function applyTheme(t = localStorage.getItem(THEME_KEY) ?? "system") {
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
applyTheme();
document.title = BRAND;

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

/** replaceChildren, skipping the false/null/"" that conditional children produce. */
const put = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false && n !== ""));
const view = (...nodes) => put(app, ...nodes);

/** Platform settings: the persistent "sandbox off" notice, the owner's time zone and jobs. */
let settings = null;
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
const brandTile = (size = 28) => h("span", { class: "app-icon brand", style: { "--size": `${size}px` } }, brandGlyph());
const brand = () => h("a", { class: "brand-link", href: "#/" }, brandTile(), h("span", { class: "brand-name" }, BRAND));

const NAV = [
  ["Home", "#/", "home"],
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

// ---------- the Inbox: Needs you + Activity (replaces the builds chip, the Agents dot and Home's notices) ----------

const BELL = ["..#..", ".###.", ".###.", "#####", "..#.."];
const inboxCount = h("span", { class: "inbox-count", hidden: true });
const inboxBuilding = h("span", { class: "inbox-building", hidden: true, title: "Building" });
const inboxBtn = h("button", { class: "inbox-btn", "aria-label": "Inbox", "aria-haspopup": "dialog", "aria-expanded": "false", title: "Inbox (i)" }, pixelGlyph(rowCells(BELL)), inboxCount, inboxBuilding);
inboxBtn.addEventListener("click", (e) => (e.stopPropagation(), toggleInbox()));
const inboxPanel = h("div", { class: "menu inbox-panel", role: "dialog", "aria-label": "Inbox" });
let inboxData = { needs: [], building: [] };
let inboxTab = "needs";
/** Blocking calls already shown as a banner, so a dismissed one doesn't come back until it changes. */
const banner = h("div", { class: "toast blocking-banner", role: "alert", hidden: true });
document.body.append(banner);

const closeInbox = (focus = false) => {
  inboxPanel.remove();
  inboxBtn.setAttribute("aria-expanded", "false");
  if (focus) inboxBtn.focus();
};
function toggleInbox() {
  if (inboxPanel.isConnected) return closeInbox();
  inboxTab = "needs";
  document.body.append(inboxPanel);
  inboxBtn.setAttribute("aria-expanded", "true");
  renderInbox();
  pollInbox(true);
}
document.addEventListener("click", (e) => inboxPanel.isConnected && !inboxPanel.contains(e.target) && !inboxBtn.contains(e.target) && !e.target.closest?.("dialog, .menu.context") && closeInbox());
window.addEventListener("hashchange", () => closeInbox());

/** The icon for an Inbox row: the tool's, an agent's tile, or Hewn's own for Models. */
function needIcon(n, all, size = 36) {
  if (n.capabilityId) return appIcon(all.get(n.capabilityId) ?? { id: n.capabilityId, name: n.title }, { size });
  if (n.kind === "agent") return agentTile(n.title, n.title, size);
  return h("span", { class: "app-icon", style: { "--size": `${size}px`, "--hue": 125 } }, n.kind === "spend" ? "$" : "·");
}

/** What a Needs-you row opens: its own sheet (or page). */
async function openNeed(n) {
  closeInbox();
  try {
    if (n.kind === "grant") await grantsSheet(n.capabilityId);
    else if (n.kind === "connection") await (n.action === "Sign in" ? signInDialog(n.capabilityId) : grantsSheet(n.capabilityId));
    else if (n.kind === "build" || n.kind === "review") go(`#/b/${enc(n.buildId)}`);
    else if (n.kind === "agent") {
      const p = (await api("/agents/pending")).find((x) => x.id === n.id);
      if (p) await agentRequestSheet(p);
    } else if (n.kind === "confirmation") {
      const c = (await api("/confirmations")).find((x) => x.id === n.id);
      if (c) await confirmationSheet(c);
    } else if (n.kind === "schedule") {
      const x = (await api("/schedules")).find((s) => s.id === n.id);
      if (x?.status === "paused") {
        const cap = await api(`/capabilities/${enc(x.capabilityId)}`);
        await schedulesSheet({ ...((await caps()).get(x.capabilityId) ?? {}), ...cap }, runnableOps(cap));
      } else if (x) await proposalSheet(x);
    } else if (n.kind === "model") {
      const c = (await caps(true)).get(n.capabilityId);
      if (n.action === "Replace…" && c) await toolModelSheet(c, { replace: true });
      else await grantsSheet(n.capabilityId);
    } else if (n.kind === "builder-model") go("#/settings/ai");
    else if (n.kind === "spend") {
      const c = n.capabilityId && (await caps()).get(n.capabilityId);
      if (c) await toolModelSheet(c);
      else go("#/settings/ai/models");
    }
  } catch (e) {
    fail(e);
  }
  pollInbox();
  if (location.hash === "" || location.hash === "#/") route();
}

/** One Activity row, compact (the Inbox's Recent). */
function recentRow(i, all) {
  const g = groupItems([i])[0];
  const li = activityRow(g, all, true);
  li.classList.add("small");
  return li;
}

async function renderInbox() {
  if (!inboxPanel.isConnected) return;
  const all = await caps().catch(() => new Map());
  const { needs, building, recent } = inboxData;
  const tab = (key, label) => h("button", { "aria-pressed": String(inboxTab === key), onclick: (e) => (e.stopPropagation(), (inboxTab = key), renderInbox(), key === "activity" && pollInbox(true)) }, label);
  const head = h("div", { class: "inbox-head" }, h("div", { class: "segmented" }, tab("needs", `Needs you · ${needs.length}`), tab("activity", "Activity")), h("a", { class: "link sm", href: "#/activity" }, "All activity ›"));
  // The whole row opens it; what it opens to stays in the row's label.
  const needRow = (n) =>
    h(
      "div",
      { class: "inbox-row link", role: "button", tabindex: 0, "aria-label": `${n.title}: ${n.detail}. ${n.action}`, onclick: () => openNeed(n), onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), openNeed(n)) },
      h("span", { class: `dot ${n.severity}` }),
      needIcon(n, all),
      h("div", { class: "grow" }, h("span", { class: "title" }, n.title), h("span", { class: "small muted clip-1" }, n.detail)),
      h("span", { class: "faint", "aria-hidden": "true" }, "›"),
    );
  const buildRow = (b) => {
    const c = all.get(b.capabilityId) ?? { id: b.capabilityId, name: b.name };
    const lit = b.step?.step === "tests" && b.tests?.total ? b.tests.passed / b.tests.total : 0;
    // The whole row opens the build.
    return h(
      "a",
      { class: "inbox-row link", href: `#/b/${enc(b.buildId)}` },
      h("span", { class: "dot live" }),
      appIcon(c, { size: 36, progress: lit, waiting: !lit }),
      h("div", { class: "grow" }, h("span", { class: "title" }, b.name), h("span", { class: "small muted" }, b.status === "waiting" ? "Waiting" : buildingLabel({ ...(b.step ?? {}), tests: b.tests }))),
      h("span", { class: "faint", "aria-hidden": "true" }, "›"),
    );
  };
  const recentList = (n) => (recent ? h("ul", { class: "list inbox-recent" }, recent.slice(0, n).map((i) => recentRow(i, all))) : skeleton("70%", "50%"));
  put(
    inboxPanel,
    head,
    inboxTab === "needs"
      ? [
          needs.length ? needs.map(needRow) : h("div", { class: "inbox-row muted small" }, "Nothing needs you."),
          building.length > 0 && [h("hr"), h("div", { class: "eyebrow inbox-eyebrow" }, "Building"), building.map(buildRow)],
          h("hr"),
          h("div", { class: "eyebrow inbox-eyebrow" }, "Recent"),
          recentList(3),
        ]
      : recentList(6),
  );
}

let inboxTimer = null;
async function pollInbox(withRecent = false) {
  clearTimeout(inboxTimer);
  if (!document.hidden) {
    const next = await api(`/inbox${inboxPanel.isConnected || withRecent ? "?recent=1" : ""}`).catch(() => null);
    if (next) {
      inboxData = { ...next, recent: next.recent ?? inboxData.recent };
      const n = next.needs.length;
      inboxCount.hidden = !n;
      inboxCount.textContent = String(n);
      inboxCount.classList.toggle("danger", next.needs.some((x) => x.severity === "danger"));
      inboxBuilding.hidden = !next.building.length;
      inboxBtn.setAttribute("aria-label", n ? `Inbox, ${n} need${n === 1 ? "s" : ""} you` : "Inbox");
      showBanner(next.needs.filter((x) => x.kind === "confirmation"));
      renderInbox();
    }
  }
  inboxTimer = setTimeout(pollInbox, inboxData.building?.length ? 4000 : 15000);
}
window.refreshInbox = pollInbox;

// ---------- the command palette (⌘K, "/"): tools, places and actions in one search ----------

/** 5×5 glyphs for the palette's actions and places (Hewn's pixel style, no UI icon set): [hue, rows]. */
const PALETTE_GLYPHS = {
  plus: [125, ["..#..", "..#..", "#####", "..#..", "..#.."]],
  widget: [200, ["##.##", "##.##", ".....", "##.##", "##.##"]],
  edit: [30, ["...##", "..###", ".###.", "###..", "#...."]],
  agent: [300, [".###.", ".###.", ".....", "#####", "#####"]],
  link: [180, ["##...", "#.#..", ".###.", "..#.#", "...##"]],
  hammer: [55, ["#####", "#####", "..#..", "..#..", "..#.."]],
  ask: [250, ["#####", "#...#", "#####", ".#...", "#...."]],
  backup: [160, ["..#..", "..#..", "#.#.#", ".###.", "#####"]],
  appearance: [270, [".###.", "###.#", "###.#", "###.#", ".###."]],
  keys: [220, ["#####", "#.#.#", "#####", "#...#", "#####"]],
  home: [125, ["..#..", ".###.", "#####", "##.##", "##.##"]],
  bell: [40, BELL],
  activity: [10, ["#.###", ".....", "#.###", ".....", "#.###"]],
  key: [80, [".###.", ".#.#.", ".###.", "..#..", "..##."]],
  settings: [210, ["#.#.#", ".###.", "##.##", ".###.", "#.#.#"]],
  chip: [190, ["#####", "#...#", "#.#.#", "#...#", "#####"]],
};
/** A small tile with a pixel glyph, for things that aren't tools. */
const glyphTile = ([hue, rows], size) => h("span", { class: "app-icon", style: { "--size": `${size}px`, "--hue": hue }, "aria-hidden": "true" }, pixelGlyph(rowCells(rows)));

/**
 * Everything the palette offers: tools (open; Change… and Info when you type), connections, places
 * (pages and Settings sections) and actions. Each: [label, group, run, icon?, words?, more?].
 */
async function paletteItems() {
  const all = [...(await caps().catch(() => new Map())).values()].filter((c) => c.version || c.building);
  const tools = all.filter((c) => c.kind !== "connection");
  const tile = (key) => glyphTile(PALETTE_GLYPHS[key], 24);
  const place = (label, href, words = "", glyph = "settings") => [label, "Go to", () => go(href), tile(glyph), words];
  const act = (label, fn, words = "", glyph = "plus") => [label, "Do", fn, tile(glyph), words];
  return [
    ...tools.map((c) => [c.name, "Tools", () => openCapability(c).catch(fail), appIcon(c, { size: 24 }), `${c.purpose ?? ""} ${c.id} open`]),
    ...tools.map((c) => [`Change ${c.name}…`, "Tools", () => openChange(c), appIcon(c, { size: 24 }), `${c.id} modify edit`, true]),
    ...tools.map((c) => [`${c.name} · Info`, "Tools", () => go(`#/c/${enc(c.id)}`), appIcon(c, { size: 24 }), `${c.id} details grants schedules widgets versions`, true]),
    ...all.filter((c) => c.kind === "connection").map((c) => [c.name, "Connections", () => go(`#/c/${enc(c.id)}`), appIcon(c, { size: 24 }), `${c.id} account sign in`]),
    act("New tool", () => go("#/new"), "make create build", "plus"),
    act("Add a widget", () => addWidgetSheet(), "home", "widget"),
    act("Edit Home", () => (location.hash === "" || location.hash === "#/" ? keyHandlers.get("e")?.() : (go("#/"), setTimeout(() => keyHandlers.get("e")?.(), 600))), "layout arrange widgets", "edit"),
    act("Connect an agent", () => connectDialog(), "claude codex opencode chatgpt mcp", "agent"),
    act("Add a connection", () => addConnectionSheet(), "account service", "link"),
    // Hosted: the host builds; the model is under Settings › AI.
    !settings?.hosted && act("Who builds tools…", () => jobPicker({ thenModel: true }), "builder intake job model", "hammer"),
    act("Back up now", () => api("/backups", { method: "POST" }).then((b) => toast(`Backed up · ${Math.round(b.bytes / 1024)} KB`), fail), "backup", "backup"),
    act(`Switch to ${isDark() ? "light" : "dark"} appearance`, () => {
      const t = isDark() ? "light" : "dark";
      localStorage.setItem(THEME_KEY, t);
      applyTheme(t);
    }, "theme dark light mode", "appearance"),
    act("Keyboard shortcuts", () => shortcutsDialog(), "keys help", "keys"),
    place("Home", "#/", "", "home"),
    place("Inbox", location.hash, "needs you", "bell"),
    place("Activity", "#/activity", "log calls history", "activity"),
    place("Builds", "#/activity?view=builds", "", "hammer"),
    place("Agents", "#/agents", "", "agent"),
    place("Accounts", "#/accounts", "connections", "key"),
    ...SECTIONS.map(([k, label]) => place(`Settings › ${label}`, `#/settings/${k}`)),
    place("Settings › AI › Models", "#/settings/ai/models", "provider key budget spend tier", "chip"),
  ]
    .filter(Boolean)
    .map(([label, group, run, icon, words = "", more = false]) => ({ label, group, run: label === "Inbox" ? () => toggleInbox() : run, icon, words: `${label} ${words}`.toLowerCase(), more }));
}

/** ⌘K: one search over tools, places and actions. Arrows move, Enter runs, Esc closes. */
async function commandPalette() {
  closeInbox();
  const items = await paletteItems();
  return modal(
    (close) => {
      const input = h("input", { type: "search", class: "palette-input", placeholder: "Search tools, pages and actions", "aria-label": "Search", autofocus: true, autocomplete: "off" });
      const list = h("ul", { class: "palette-list", role: "listbox" });
      let shown = [];
      let at = 0;
      const run = (it) => (close(), setTimeout(() => it.run()));
      const render = () => {
        const q = input.value.trim().toLowerCase();
        const words = q.split(/\s+/).filter(Boolean);
        // Names first ("run" finds Running Log before a tool whose purpose mentions a long run), then the rest.
        const named = (it) => words.every((w) => it.label.toLowerCase().includes(w));
        const hits = items.filter((it) => (q ? words.every((w) => it.words.includes(w)) : !it.more));
        shown = (q ? [...hits.filter(named), ...hits.filter((it) => !named(it))] : hits).slice(0, 40);
        at = Math.min(at, Math.max(0, shown.length - 1));
        let group = null;
        put(
          list,
          shown.flatMap((it, i) => [
            it.group !== group && ((group = it.group), h("li", { class: "eyebrow palette-group", role: "presentation" }, it.group)),
            h("li", { class: `palette-item ${i === at ? "active" : ""}`, role: "option", "aria-selected": String(i === at), onclick: () => run(it), onmousemove: () => i !== at && ((at = i), render()) }, it.icon ?? h("span", { class: "palette-dot" }), h("span", { class: "grow" }, it.label)),
          ]),
          !shown.length && h("li", { class: "muted small palette-empty" }, "Nothing matches."),
        );
        list.querySelector(".active")?.scrollIntoView({ block: "nearest" });
      };
      input.addEventListener("input", () => ((at = 0), render()));
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") (e.preventDefault(), (at = Math.min(at + 1, shown.length - 1)), render());
        else if (e.key === "ArrowUp") (e.preventDefault(), (at = Math.max(at - 1, 0)), render());
        else if (e.key === "Enter" && shown[at]) (e.preventDefault(), run(shown[at]));
      });
      render();
      return [input, list];
    },
    { width: 560, cls: "palette" },
  );
}

/** The one exception to "everything goes to the Inbox": an agent blocked on a destructive call. */
function showBanner(blocking) {
  if (!blocking.length) return (banner.hidden = true);
  const first = blocking[0];
  const who = first.detail.replace(/ wants to run .*$/, "");
  put(banner, h("span", { class: "dot danger" }), h("span", {}, `${who} is waiting for you`), h("button", { class: "sm", onclick: () => openNeed(first) }, "Review"));
  banner.hidden = false;
}

// ---------- tool actions (menu, change, rename, delete, icon, versions) ----------

async function openCapability(c) {
  if (c.building && !c.version) return go(`#/b/${c.building.buildId}`);
  if (!c.ready && !(await grantsSheet(c.id))) return;
  go(c.ui ? `#/app/${enc(c.id)}` : `#/run/${enc(c.id)}`);
}

/**
 * Change… always opens the tool with the change drawer beside it (P1): its own UI, or the Run view
 * for a tool without one (P5). `m`: text to put in the composer; `send`: send it at once; `from`: the
 * build whose conversation the intake continues from.
 */
function changeHref(c, { m, send, widget, from } = {}) {
  const q = new URLSearchParams({ change: "1", ...(m ? { m } : {}), ...(send ? { send: "1" } : {}), ...(widget ? { widget } : {}), ...(from ? { from } : {}) });
  return `#/${c.ui ? "app" : "run"}/${enc(c.id)}?${q}`;
}
const openChange = (c, o) => go(changeHref(c, o));

/**
 * "Ask builder to fix this": a Change to the tool, the message written for the builder from one
 * failed call (what ran it, the operation, the error, its input and last log lines). The owner
 * reads it, can edit it, and sends it.
 */
const fixText = (f) => {
  const label = actorLabel(f.caller);
  const who = /^widget:/.test(f.caller ?? "") ? "A widget" : /^schedule:/.test(f.caller ?? "") ? "A schedule" : /^(user|web|ui:)/.test(f.caller ?? "user") ? "I" : label && label !== f.caller ? label : "An agent";
  const input = f.input && f.input !== "{}" ? `\n\nInput: ${f.input}` : "";
  const logs = f.logs?.length ? `\n\nLast log lines:\n${f.logs.join("\n")}` : "";
  return `${who} ran ${f.operation} and it failed:\n${f.error}${input}${logs}\n\nFix it so this works.`;
};
const askFix = (c, f) => openChange(c, { m: fixText(f) });
/** The newest recorded failure that matches (Hewn keeps the last ten per tool), else what's known here. */
const askFixLatest = async (c, match, fallback) => askFix(c, (await api(`/capabilities/${enc(c.id)}/failures`).catch(() => [])).find(match) ?? fallback);
const fixButton = (onclick, cls = "sm") => h("button", { class: cls, type: "button", onclick }, "Ask builder to fix this");

/** The tool menu, grouped (F7): use · look closer · personalise · delete. The same on Home, Info and opened tools. */
function capabilityMenu(c, { rename, editHome, hidden, show } = {}) {
  const id = enc(c.id);
  const connection = c.kind === "connection";
  return [
    ["Open", () => openCapability(c).catch(fail)],
    ["Change…", () => openChange(c)],
    ["Info", () => go(`#/c/${id}`)],
    "-",
    !connection && ["Widgets…", () => toolWidgetsSheet(c).catch(fail)],
    ["Activity", () => go(`#/activity?capability=${id}`)],
    ["Versions…", () => versionsDialog(c).catch(fail)],
    "-",
    rename && ["Rename", rename],
    ["Set icon…", () => iconDialog(c).catch(fail)],
    ["Export data", () => download(`/api/capabilities/${id}/export`)],
    hidden && show && ["Show on Home", show],
    editHome && ["Edit Home", editHome],
    "-",
    ["Delete…", () => deleteDialog(c), { danger: true }],
  ];
}

/** Download a file from the API (the session cookie goes along; nothing is opened). */
const download = (href) => {
  const a = h("a", { href, download: "" });
  document.body.append(a);
  a.click();
  a.remove();
};

/** Roll a tool back to `version` (Undo rolls forward again). */
async function rollbackTo(c, version) {
  const id = enc(c.id);
  const r = await api(`/capabilities/${id}/rollback`, { method: "POST", body: { version } });
  invalidateCaps();
  toast(`${c.name} is back on v${r.to}`, { undo: () => api(`/capabilities/${id}/rollback`, { method: "POST", body: { version: r.from } }).then(() => (invalidateCaps(), route())) });
  return r;
}

/** Versions and rollback: each version with what led to it (the conversation, the spec, the builder's log), and restoring an earlier one. */
async function versionsDialog(c) {
  const id = enc(c.id);
  const detail = await api(`/capabilities/${id}`);
  const active = (await caps(true)).get(c.id)?.version;
  return modal(
    (close) => [
      sheetHead(appIcon(c, { size: 44 }), `Versions · ${c.name}`),
      h("div", { class: "stack-sm version-panes" }, detail.versions.map((v) => versionPane(c, v, v.version === active, close))),
      h("div", { class: "small faint" }, "Restoring keeps the data. It's refused if a newer version changed the data in a way older code can't read."),
      sheetActions(h("button", { onclick: () => close() }, "Done")),
    ],
    { width: 640 },
  );
}

/**
 * One version: when and who asked, Restore (or active), and at the bottom what led to it, kept
 * for the tool's life: the conversation with the intake, the spec the builder worked from, the
 * builder's log (each loaded when opened). "Continue from here" opens a change picking up that
 * conversation.
 */
function versionPane(c, v, isActive, close) {
  const who = actorLabel(v.requestedBy);
  const spec = String(v.request?.requirements ?? v.request?.request ?? "").trim();
  /** An expander whose content comes when it's first opened. */
  const lazy = (summary, load) => {
    const body = h("div", { class: "stack-sm" }, skeleton("60%", "40%"));
    const d = h("details", { class: "spec-step" }, h("summary", {}, summary), body);
    let loaded = false;
    d.addEventListener("toggle", async () => {
      if (!d.open || loaded) return;
      loaded = true;
      try {
        put(body, await load());
      } catch (e) {
        put(body, h("div", { class: "small faint" }, e.message || String(e)));
      }
    });
    return d;
  };
  const kept = v.buildId
    ? [
        lazy("Conversation", async () => {
          const ctx = await api(`/builds/${enc(v.buildId)}/context`);
          return ctx.conversation?.length ? conversationThread(ctx.conversation, { mode: v.kind === "create" ? "create" : "modify", cap: c, all: await caps(true).catch(() => new Map()), version: v.version }) : h("div", { class: "small faint" }, who && who !== "You" ? `${who} asked for it; there was no conversation.` : "No conversation was kept.");
        }),
        spec && h("details", { class: "spec-step" }, h("summary", {}, "Spec"), h("pre", { class: "spec-text" }, spec)),
        lazy("Builder's log", async () => {
          const t = await api(`/builds/${enc(v.buildId)}/transcript`);
          return t.text ? h("pre", { class: "log tail" }, t.text.split("\n").slice(-500).join("\n")) : h("div", { class: "small faint" }, "No log was kept.");
        }),
        v.conversation && h("button", { class: "link sm self-start", onclick: () => (close(), go(changeHref(c, { from: v.buildId }))) }, "Continue from here ›"),
      ]
    : [];
  return h(
    "div",
    { class: "version-pane" },
    h(
      "div",
      { class: "row tight" },
      h("span", { class: "pill" }, `v${v.version}`),
      h("div", { class: "grow" }, h("span", {}, `${v.kind === "create" ? "Built" : "Changed"} ${ago(v.createdAt)}${who && who !== "You" ? ` · ${who} asked` : ""}`), h("span", { class: "sub clip" }, v.request?.request ?? v.request?.purpose ?? "")),
      isActive ? h("span", { class: "pill ok with-dot" }, "active") : h("button", { class: "sm", onclick: () => rollbackTo(c, v.version).then(() => (close(), route()), fail) }, "Restore"),
    ),
    kept.length ? h("div", { class: "stack-sm version-kept" }, kept) : null,
  );
}

/**
 * The owner's standing rules for building, one per line: for every tool (no `c`), or for one tool.
 * The intake adds to them when the owner states a rule; the builder reads them on every build.
 * Resolves true when saved.
 */
async function instructionsSheet(c) {
  const path = c ? `/capabilities/${enc(c.id)}/instructions` : "/instructions";
  const { lines } = await api(path);
  return modal(
    (close) => {
      const text = h("textarea", { rows: 8, class: "instructions", "aria-label": "Instructions", placeholder: c ? "e.g. Keep it to one screen" : "e.g. Swedish copy in every screen" }, lines.join("\n"));
      const save = h("button", { type: "button", class: "primary" }, "Save");
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          await api(path, { method: "PUT", body: { text: text.value } });
          toast("Instructions saved");
          close(true);
        } catch (e) {
          save.disabled = false;
          fail(e);
        }
      });
      const hint = c
        ? h("div", { class: "small faint" }, "One rule per line, for this tool only. Rules for every tool are under ", h("a", { href: "#/settings/ai", onclick: () => close(false) }, "Settings › AI"), ".")
        : h("div", { class: "small faint" }, "One rule per line, for every tool you build. The intake adds to these when you tell it a rule; the builder reads them on every build.");
      setTimeout(() => text.focus());
      return [sheetHead(c ? appIcon(c, { size: 44 }) : null, c ? `Instructions · ${c.name}` : "Instructions for building"), h("div", { class: "stack-md" }, text, hint), sheetActions(h("button", { type: "button", onclick: () => close(false) }, "Cancel"), save)];
    },
    { width: 560 },
  );
}

/** What the intake remembered (or dropped) for later builds, shown as saved, with Undo. */
function memoryNotice(what, { scope, text }, cap) {
  const tool = scope === "tool" ? cap : null;
  const where = tool ? `${tool.name}'s builder instructions` : "global builder instructions";
  const path = tool ? `/capabilities/${enc(tool.id)}/instructions` : "/instructions";
  const undo = h("button", { type: "button", class: "link sm" }, "Undo");
  const el = h("div", { class: "notice info memory-notice" }, h("div", { class: "grow col" }, h("span", { class: "strong" }, what === "remember" ? `Saved to ${where}` : `Removed from ${where}`), h("span", { class: "memory-text" }, text)), undo);
  undo.addEventListener("click", async () => {
    undo.disabled = true;
    try {
      const { lines } = await api(path);
      const next = what === "remember" ? lines.filter((l) => l !== text) : lines.includes(text) ? lines : [...lines, text];
      await api(path, { method: "PUT", body: { text: next.join("\n") } });
      put(el, h("span", { class: "grow muted" }, what === "remember" ? `Not saved: ${text}` : `Kept: ${text}`));
    } catch (e) {
      undo.disabled = false;
      fail(e);
    }
  });
  return el;
}

/** Inline rename: the label becomes an input. Enter saves, Esc cancels. */
function inlineRename(c, labelEl, { onSaved } = {}) {
  const input = h("input", { type: "text", class: "rename", value: c.name, maxLength: 60, "aria-label": `Rename ${c.name}` });
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    input.replaceWith(labelEl);
    if (!save || !name || name === c.name) return;
    try {
      await api(`/capabilities/${enc(c.id)}/rename`, { method: "POST", body: { name } });
      invalidateCaps();
      labelEl.textContent = name;
      c.name = name;
      toast(`Renamed to ${name}`);
      onSaved?.(name);
    } catch (e) {
      fail(e);
    }
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  for (const ev of ["click", "pointerdown", "contextmenu"]) input.addEventListener(ev, (e) => e.stopPropagation());
  input.addEventListener("blur", () => finish(true));
  labelEl.replaceWith(input);
  input.focus();
  input.select();
}

async function deleteDialog(c) {
  const [detail, all] = await Promise.all([api(`/capabilities/${enc(c.id)}`).catch(() => ({ usedBy: [] })), caps()]);
  const usedBy = detail.usedBy ?? [];
  const ok = await confirmDialog({
    title: h("span", { class: "title-ref" }, "Delete", h("span", { class: "ref-end" }, capRef(all.get(c.id) ?? c, c.id, { size: 24 }), "?")),
    body: usedBy.length
      ? [usedBy.map((u, i) => [i ? ", " : "", capRef(all.get(u.id), u.id)]), usedBy.length > 1 ? " use it and will stop working. " : " uses it and will stop working. ", "Its data is kept, so you can restore it later."]
      : "Its data is kept, so you can restore it later.",
    confirm: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/capabilities/${enc(c.id)}`, { method: "DELETE", body: { confirm: c.id } });
    invalidateCaps();
    toast(`Deleted ${c.name}`, {
      dot: "",
      undo: async () => {
        await api(`/capabilities/${enc(c.id)}/restore`, { method: "POST" });
        invalidateCaps();
        toast(`Restored ${c.name}`);
        route();
      },
    });
    go(c.kind === "connection" ? "#/accounts" : "#/");
  } catch (e) {
    fail(e);
  }
}

const SEEDS = [".....", ".....", ".....", ".....", "....."];

/** Set icon (N3), a Picker: draw a 5×5 glyph or use an image, pick its hue and saturation, or go back to the default. */
async function iconDialog(c) {
  const id = enc(c.id);
  const cells = await (c.iconKind === "glyph" ? glyphCells(c) : Promise.resolve([]));
  const grid = SEEDS.map((r) => [...r].map(() => false));
  for (const { x, y } of cells) if (grid[y]?.[x] !== undefined) grid[y][x] = true;
  let hue = hueOf(c);
  let saturation = Number.isInteger(c.saturation) ? c.saturation : 100;
  let mode = c.iconKind === "image" ? "image" : "glyph";
  const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/svg+xml" });
  const status = h("p", { class: "small error" });
  const preview = h("span", { class: "icon-preview" });
  const rows = () => grid.map((r) => r.map((on) => (on ? "#" : ".")).join(""));

  const drawPreview = () => {
    const tile = h("span", { class: "app-icon", style: { "--size": "48px", "--hue": hue, "--s": saturation / 100 } });
    if (mode === "glyph") tile.append(pixelGlyph(rowCells(rows())));
    else tile.append(appIcon({ ...c, hue, saturation }, { size: 48 }).firstChild ?? "");
    put(preview, tile);
  };
  const editor = h(
    "div",
    { class: "glyph-editor", role: "group", "aria-label": "Glyph, 5 by 5" },
    grid.flatMap((r, y) =>
      r.map((_, x) => {
        const b = h("button", { type: "button", "aria-label": `Cell ${x + 1}, ${y + 1}`, "aria-pressed": String(grid[y][x]) });
        b.addEventListener("click", () => ((grid[y][x] = !grid[y][x]), b.setAttribute("aria-pressed", String(grid[y][x])), drawPreview()));
        return b;
      }),
    ),
  );
  const hueInput = h("input", { type: "range", min: 0, max: 359, value: hue, class: "hue-range", "aria-label": "Colour" });
  hueInput.addEventListener("input", () => ((hue = Number(hueInput.value)), drawPreview()));
  // 0: black or white on grey (a black-and-white brand); 100 is the default; capped at 150 (more turns neon in dark mode).
  const satInput = h("input", { type: "range", min: 0, max: 150, step: 5, value: saturation, class: "hue-range", "aria-label": "Saturation" });
  satInput.addEventListener("input", () => ((saturation = Number(satInput.value)), drawPreview()));
  const panes = {
    glyph: h("div", { class: "stack-sm" }, editor, h("span", { class: "small faint" }, "7–17 lit cells, one simple idea.")),
    image: h("label", { class: "field" }, h("span", { class: "label" }, "Image"), file, h("span", { class: "hint" }, "PNG, JPEG, WebP or SVG, up to 256 KB")),
  };
  const body = h("div", {});
  const seg = h("div", { class: "segmented self-start", role: "group", "aria-label": "Icon type" });
  const show = () => {
    put(seg, ...[["glyph", "Draw"], ["image", "Image"]].map(([k, l]) => h("button", { type: "button", "aria-pressed": String(k === mode), onclick: () => ((mode = k), show()) }, l)));
    put(body, panes[mode]);
    drawPreview();
  };
  const done = (close) => (bumpIcons(), invalidateCaps(), close(), route());
  return modal((close) => {
    const save = async () => {
      try {
        if (mode === "glyph") {
          if (!grid.flat().some(Boolean)) return (status.textContent = "Light at least one cell.");
          await api(`/capabilities/${id}/icon`, { method: "PUT", body: { glyph: rows(), hue, saturation } });
        } else {
          if (!file.files[0]) return (status.textContent = "Choose an image.");
          const dataUrl = await new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(r.result);
            r.onerror = rej;
            r.readAsDataURL(file.files[0]);
          });
          await api(`/capabilities/${id}/icon`, { method: "PUT", body: { dataUrl, hue, saturation } });
        }
        done(close);
      } catch (e) {
        status.textContent = e.message;
      }
    };
    show();
    return [
      sheetHead(preview, `Icon for ${c.name}`),
      seg,
      body,
      h("label", { class: "field" }, h("span", { class: "label" }, "Colour"), hueInput),
      h("label", { class: "field" }, h("span", { class: "label" }, "Saturation"), satInput),
      status,
      h(
        "div",
        { class: "actions flush between" },
        h("button", { class: "ghost", onclick: () => api(`/capabilities/${id}/icon`, { method: "DELETE" }).then(() => done(close)).catch((e) => (status.textContent = e.message)) }, "Use default"),
        h("span", { class: "row tight" }, h("button", { onclick: () => close() }, "Cancel"), h("button", { class: "primary", onclick: save }, "Save")),
      ),
    ];
  }, { width: 440 });
}

// ---------- F1 first run / F2 Home / F4 Edit Home ----------

/**
 * "Builds tools": the intake talks a request through and proposes it, the builder builds it. One
 * agent does both; the settings keep both keys (`intake`, `builder`) and the web client sets them together.
 */
const jobChosen = (s, key) => !!s && (s.hosted || s.jobsChosen?.includes(key) || s.firstRunDone === true);
/** Both jobs have an agent (the first run asks until they do). */
const buildsChosen = (s) => jobChosen(s, "builder") && jobChosen(s, "intake");
/** The model and effort the owner picked for a job on an agent ({} = the agent's default). */
const jobModelOf = (s, key, agent = s?.[key]) => s?.jobModels?.[key]?.[agent] ?? {};
/**
 * Save the model and effort for building tools on `agent` (the builder): both halves, and the intake
 * on the same agent (an older split heals on the next save). "default" and unset keys are dropped.
 */
const saveBuildModel = async (s, agent, m) => {
  const clean = Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined && v !== "default"));
  const next = structuredClone(s.jobModels ?? {});
  for (const k of ["builder", "intake"]) next[k] = { ...(next[k] ?? {}), [agent]: clean };
  return (settings = await api("/settings", { method: "PUT", body: { jobModels: next, intake: agent } }));
};
/** A model choice in words: "Default model", "Fable" (a family), or the full name. */
const modelWords = (m = {}, catalog) => {
  const name = !m.model ? "Default model" : catalog?.models.find((x) => x.id === m.model)?.label ?? (/^[a-z]+$/.test(m.model) ? m.model[0].toUpperCase() + m.model.slice(1) : m.model);
  return m.effort ? `${name} · ${m.effort} effort` : name;
};

async function home({ editing = false } = {}) {
  // Redrawn in place (a layout save, a build starting or ending): stop the last drawing's timers first.
  for (const fn of leaving.splice(0)) fn();
  view(topBar("home"), h("main", { class: "home" }, h("div", { class: "home-grid" }, Array.from({ length: 6 }, () => h("span", { class: "skeleton tile-skeleton" })))));
  // Connections live under Accounts, not on Home.
  const onHome = (cs) => [...cs.values()].filter((c) => c.kind !== "connection");
  const [all0, homeData] = await Promise.all([caps(true), api("/home").catch(() => ({ layout: [], gallery: [] }))]);
  const list = onHome(all0);
  setWallpaper(list.map(tintOf), { dim: !list.length });
  // The first run's moment screen, until a tool exists (even after leaving it once).
  if (!list.some((c) => c.version || c.building)) return firstRun();

  // One grid: the owner's layout of icons and widgets, then whatever it doesn't place yet (new
  // tools land last, next to "New"). Tools hidden from Home keep their place, hidden, for search.
  const tiles = new Map();
  const widgets = [];
  const hiddenIds = new Set(homeData.layout.filter((e) => e.type === "icon" && e.hidden).map((e) => e.id));
  const byId = new Map(list.map((c) => [c.id, c]));
  const items = [];
  const addTile = (c) => {
    const t = tile(c, { hidden: hiddenIds.has(c.id), editHome: () => enterEdit(), show: () => (hiddenIds.delete(c.id), saveLayout(grid, widgets, hiddenIds).then(() => home(), fail)) });
    tiles.set(c.id, t);
    t.el.hidden = hiddenIds.has(c.id);
    items.push(t.el);
  };
  for (const e of homeData.layout) {
    const c = byId.get(e.id);
    if (!c) continue;
    if (e.type === "icon" && !tiles.has(c.id)) addTile(c);
    if (e.type === "widget") {
      // Its options (the operation's input), when it takes any: set when placed, changeable here.
      const gw = homeData.gallery.find((g) => g.capabilityId === e.id)?.widgets.find((x) => x.name === e.widget);
      const options = Object.keys(gw?.inputSchema?.properties ?? {}).length ? () => widgetOptionsSheet(w.entry, c, gw).then((saved) => saved && home(), fail) : undefined;
      const w = widgetTile(e, c, { remove: () => (w.el.remove(), widgets.splice(widgets.indexOf(w), 1), saveLayout(grid, widgets, hiddenIds).then(() => home(), fail)), options });
      widgets.push(w);
      items.push(w.el);
    }
  }
  for (const c of list) if (!tiles.has(c.id)) addTile(c);
  const add = newTile();
  const grid = h("div", { class: "home-grid" }, items, add);
  const shown = list.filter((c) => !hiddenIds.has(c.id)).length;
  const cells = shown + widgets.reduce((n, w) => n + (w.entry.size === "small" ? 1 : 2), 0) + 1;
  grid.style.setProperty("--n", String(cells));
  enableReorder(grid, () => !grid.classList.contains("editing") && saveLayout(grid, widgets, hiddenIds).then(() => invalidateCaps(), fail));
  // Widgets draw their last view at once, then refresh (now if it's over a minute old), then on their interval while Home is open.
  const timers = widgets.flatMap((w, i) => {
    if (w.entry.missing) return [];
    const stale = !w.entry.at || Date.now() - Date.parse(w.entry.at) > 60_000;
    return [stale ? setTimeout(w.refresh, i * 150) : 0, setInterval(w.refresh, Math.max(w.entry.refreshMs ?? 1_800_000, 300_000))];
  });
  onLeave(() => timers.forEach((t) => (clearTimeout(t), clearInterval(t))));

  // F4 Edit Home: tiles wiggle, × hides a tool or removes a widget, S/M/L cycles a widget's size.
  const header = topBar("home");
  const main = h("main", { class: "home" }, h("div", { class: "home-inner" }, grid));
  const addWidgetBtn = h("button", {}, "+ Add widget");
  const doneBtn = h("button", { class: "primary" }, "Done");
  const editBar = bar({ left: h("div", { class: "glass-bar" }, addWidgetBtn), center: h("span", { class: "small muted edit-hint" }, "Drag to move · tap S/M/L to resize"), right: h("div", { class: "glass-bar" }, doneBtn) });
  const controls = [];
  function enterEdit() {
    if (grid.classList.contains("editing")) return;
    grid.classList.add("editing");
    header.replaceWith(editBar);
    for (const c of list) {
      const t = tiles.get(c.id);
      if (t.el.hidden) continue;
      const x = h("button", { class: "edit-x", "aria-label": `Hide ${c.name} from Home`, onclick: (e) => (e.stopPropagation(), hiddenIds.add(c.id), (t.el.hidden = true)) }, "×");
      t.el.append(x);
      controls.push(x);
    }
    for (const w of widgets) {
      const x = h("button", { class: "edit-x", "aria-label": `Remove ${w.entry.title ?? w.entry.widget}`, onclick: (e) => (e.stopPropagation(), w.el.remove(), widgets.splice(widgets.indexOf(w), 1)) }, "×");
      w.el.append(x);
      controls.push(x);
      const sizes = w.entry.sizes ?? [];
      if (sizes.length > 1) {
        const tag = h("button", { class: "size-tag", "aria-label": "Size" }, SIZE_LETTER[w.entry.size]);
        tag.addEventListener("click", (e) => {
          e.stopPropagation();
          w.resize(sizes[(sizes.indexOf(w.entry.size) + 1) % sizes.length]);
          tag.textContent = SIZE_LETTER[w.entry.size];
        });
        w.el.append(tag);
        controls.push(tag);
      }
    }
    add.hidden = true;
  }
  const exitEdit = () => saveLayout(grid, widgets, hiddenIds).then(() => home(), fail);
  doneBtn.addEventListener("click", exitEdit);
  addWidgetBtn.addEventListener("click", () => saveLayout(grid, widgets, hiddenIds).then(() => addWidgetSheet({ onAdded: () => home({ editing: true }) }), fail));
  // Taps don't open anything while editing.
  grid.addEventListener("click", (e) => grid.classList.contains("editing") && !e.target.closest(".edit-x, .size-tag") && (e.stopPropagation(), e.preventDefault()), true);
  grid.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".tile, .tile-widget") || grid.classList.contains("editing")) return;
    e.preventDefault();
    openMenu([["Edit Home", enterEdit]], e.clientX, e.clientY);
  });
  main.addEventListener("contextmenu", (e) => {
    if (e.target !== main && !e.target.classList.contains("home-inner")) return;
    e.preventDefault();
    if (!grid.classList.contains("editing")) openMenu([["Edit Home", enterEdit]], e.clientX, e.clientY);
  });
  onKey("e", enterEdit);
  onKey("Escape", () => grid.classList.contains("editing") && exitEdit());
  view(header, sandboxNotice(), main);
  if (editing) enterEdit();

  // Building tiles fill in live; when a build starts or finishes the grid is rebuilt.
  const signature = (cs) => cs.map((c) => `${c.id}:${!!c.building}:${c.ready}:${c.lastBuild?.status}:${c.requests}`).join("|");
  let last = signature(list);
  const poll = async () => {
    if (!document.body.contains(grid)) return;
    const next = onHome(await caps(true).catch(() => new Map()));
    const busy = grid.querySelector("input.rename") || document.querySelector(".menu.context") || grid.classList.contains("editing");
    if (signature(next) !== last && !busy) return home();
    for (const c of next) if (c.building) tiles.get(c.id)?.update(c);
    last = busy ? last : signature(next);
    timer = setTimeout(poll, list.some((c) => c.building) || next.some((c) => c.building) ? 2500 : 15000);
  };
  let timer = setTimeout(poll, list.some((c) => c.building) ? 2500 : 15000);
  onLeave(() => clearTimeout(timer));
}

/** Home label for a building tile: real milestones only (there's no honest % while code is written). */
const buildingLabel = (b) => (b.step === "tests" && b.tests ? `Testing ${b.tests.passed}/${b.tests.total}` : b.step === "auth" ? "Needs you" : b.step === "waiting" ? "Waiting" : "Building…");

/** Home's layout as it stands in the grid: icons (hidden ones too) and widgets in DOM order. */
const layoutOf = (grid, widgets, hiddenIds) =>
  [...grid.querySelectorAll(".tile[data-id], .tile-widget[data-key]")].flatMap((el) => {
    if (el.dataset.id) return [{ type: "icon", id: el.dataset.id, ...(hiddenIds.has(el.dataset.id) ? { hidden: true } : {}) }];
    const w = widgets.find((x) => x.el === el);
    return w ? [storedEntry(w.entry)] : [];
  });
/** A Home entry as the layout stores it (without the view and other fields the server adds). */
const storedEntry = (e) => (e.type === "icon" ? { type: "icon", id: e.id, ...(e.hidden ? { hidden: true } : {}) } : { type: "widget", key: e.key, id: e.id, widget: e.widget, size: e.size, ...(e.input ? { input: e.input } : {}) });
const saveLayout = (grid, widgets, hiddenIds = new Set()) => api("/home/layout", { method: "PUT", body: { entries: layoutOf(grid, widgets, hiddenIds) } });

/** Drag icons and widgets to reorder Home (desktop). The layout is saved as an owner preference. */
function enableReorder(grid, save) {
  let dragged = null;
  const order = () => [...grid.querySelectorAll(".tile[data-id], .tile-widget[data-key]")].map((t) => t.dataset.id ?? t.dataset.key).join();
  let before = order();
  for (const el of grid.querySelectorAll(".tile[data-id], .tile-widget[data-key]")) {
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      dragged = el;
      el.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", el.dataset.id ?? el.dataset.key);
    });
    el.addEventListener("dragend", async () => {
      el.classList.remove("dragging");
      dragged = null;
      if (order() === before) return;
      before = order();
      save();
    });
    el.addEventListener("dragover", (e) => {
      if (!dragged || dragged === el) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      el.parentNode.insertBefore(dragged, e.clientX < r.left + r.width / 2 ? el : el.nextSibling);
    });
  }
}

function tile(c, { hidden = false, editHome, show } = {}) {
  const label = h("span", { class: "tile-label" });
  const iconSlot = h("span", { class: "tile-icon" });
  const el = h("div", { class: "tile", role: "button", tabindex: 0, "data-id": c.building && !c.version ? undefined : c.id }, iconSlot, label);
  const render = (cap) => {
    Object.assign(c, cap);
    const failed = c.lastBuild?.status === "failed";
    const needsYou = !c.ready || c.requests > 0;
    const more = c.building ? null : h("span", { class: "more", "aria-hidden": "true", onclick: (e) => (e.stopPropagation(), menuFrom(more, items())) }, "•••");
    // Lit cells follow real progress: none while code is written (the glyph pulses), then tests passed / total.
    const b = c.building;
    const lit = !b ? undefined : b.step === "tests" && b.tests?.total ? b.tests.passed / b.tests.total : b.step === "auth" ? 1 : 0;
    put(iconSlot, appIcon(c, { size: 80, badge: b ? null : failed ? "danger" : needsYou ? "warn" : null, more, progress: lit, waiting: !!b && (b.step === "spec" || b.step === "code") }));
    label.textContent = c.building ? buildingLabel(c.building) : c.name;
    label.classList.toggle("muted", !!c.building);
    el.setAttribute("aria-label", c.building ? `${c.name}, building` : `${c.name}${failed ? ", last build failed" : needsYou ? ", needs you" : ""}`);
    el.title = c.purpose ?? "";
  };
  const items = () => (c.building && !c.version ? [["Show build", () => go(`#/b/${c.building.buildId}`)]] : capabilityMenu(c, { rename: () => inlineRename(c, label), editHome, hidden, show }));
  // While it builds, the tile opens the build.
  const open = () => (c.building ? go(`#/b/${enc(c.building.buildId)}`) : openCapability(c).catch(fail));
  el.addEventListener("click", open);
  el.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && e.target === el && (e.preventDefault(), open()));
  withContextMenu(el, items);
  render(c);
  return { el, update: render };
}

/** "New": straight to the intake (it handles widget and schedule requests too). */
function newTile() {
  return h("a", { class: "tile", href: "#/new", "aria-label": "New tool" }, h("span", { class: "tile-icon" }, h("span", { class: "app-icon add", style: { "--size": "80px" } }, "+")), h("span", { class: "tile-label muted" }, "New"));
}

// ---------- widgets on Home ----------

const SIZE_LABEL = { small: "Small", medium: "Medium", large: "Large" };
const SIZE_LETTER = { small: "S", medium: "M", large: "L" };
let widgetRenderer;
const renderer = async () => (widgetRenderer ??= (await import("/_platform/widgets.js")).renderWidget);

/**
 * A placed widget (F6): the platform draws its view model (no tool code on Home). It shows the
 * cached view first; a failed refresh keeps that view and says how old it is. Tap opens the tool.
 */
function widgetTile(e, c, { remove, options }) {
  const slot = h("div", { class: "widget-slot" });
  const staleNote = h("span", { class: "jw-stale-note", hidden: true });
  const el = h("div", { class: `tile-widget w-${e.size}`, role: "button", tabindex: 0, "data-key": e.key }, slot, staleNote);
  el.setAttribute("aria-label", `${e.title ?? e.widget}, ${c.name} widget`);
  const draw = async () => {
    if (e.missing) return put(slot, h("div", { class: `jw jw-${e.size}` }, h("div", { class: "jw-title" }, c.name), h("div", { class: "jw-empty" }, "This widget is gone from the tool. Remove it in Edit Home.")));
    if (!e.view) return put(slot, h("div", { class: `jw jw-${e.size}` }, h("div", { class: "jw-title" }, e.title), h("span", { class: "skeleton widget-skeleton" })));
    (await renderer())(slot, e.view, { size: e.size, title: e.title, onButton: press, icon: widgetIcon(c) });
  };
  // Stale: the last view stays, with how old it is (an amber dot) instead of a "!".
  const mark = () => {
    staleNote.hidden = !e.error;
    put(staleNote, h("span", { class: "dot warn" }), e.at ? ago(e.at) : "not refreshed");
    staleNote.title = e.error ? `Couldn't refresh: ${e.error}` : "";
    el.classList.toggle("stale", !!e.error);
  };
  const refresh = async () => {
    try {
      Object.assign(e, await api(`/home/widgets/${enc(e.key)}/refresh`, { method: "POST" }));
    } catch (err) {
      e.error = err.message;
    }
    mark();
    await draw();
  };
  // A widget's button runs one of the tool's own operations, as the owner; destructive ones are
  // confirmed first. The button stays disabled until the widget has redrawn.
  async function press(b, btn) {
    const [name, version] = b.operation.split("@");
    try {
      const cap = await api(`/capabilities/${enc(c.id)}`);
      const op = cap.operations.find((o) => o.name === name && o.version === Number(version));
      if (!op) throw new Error(`${c.name} has no ${b.operation}`);
      if (op.sideEffect === "destructive" && !(await confirmDialog({ title: `${b.label}?`, body: `Runs ${name} on ${c.name}. It changes or removes data, and can't be undone.`, confirm: b.label, danger: true }))) return;
      btn.disabled = true;
      await api(`/capabilities/${enc(c.id)}/invoke`, { method: "POST", body: { operation: name, operationVersion: Number(version), input: b.input ?? {} } });
      await refresh();
    } catch (err) {
      btn.disabled = false;
      fail(err);
    }
  }
  const resize = (size) => {
    e.size = size;
    el.className = `tile-widget w-${size}`;
    draw();
  };
  const section = /^ui#(.+)$/.exec(e.open ?? "")?.[1];
  const open = () => (c.building && !c.version ? go(`#/b/${c.building.buildId}`) : c.ui && e.open ? go(`#/app/${enc(c.id)}${section ? `?at=${enc(section)}` : ""}`) : openCapability(c).catch(fail));
  el.addEventListener("click", open);
  el.addEventListener("keydown", (ev) => (ev.key === "Enter" || ev.key === " ") && ev.target === el && (ev.preventDefault(), open()));
  withContextMenu(el, () => [
    ["Open", open],
    !e.missing && ["Refresh", refresh],
    !e.missing && options && !el.closest(".editing") && ["Options…", options],
    !e.missing && ["Change…", () => openChange(c, { widget: e.widget })],
    // It couldn't refresh: the error, its operation and input go to the builder.
    !e.missing && e.error && ["Ask builder to fix this…", () => askFixLatest(c, (f) => f.caller === `widget:${c.id}/${e.widget}`, { caller: `widget:${c.id}/${e.widget}`, operation: e.widget, error: e.error, input: JSON.stringify(e.input ?? {}) }).catch(fail)],
    "-",
    ["Remove widget", remove, { danger: true }],
  ]);
  mark();
  draw();
  return { el, entry: e, refresh, resize };
}

/** The tool's icon as the widget renderer draws it in the corner (the same in agent chats). */
const widgetIcon = (c) => ({ id: c.id, name: c.name, hue: hueOf(c), ...(Number.isInteger(c.saturation) ? { saturation: c.saturation } : {}), ...(c.iconKind ? { kind: c.iconKind, src: iconUrl(c) } : {}) });

const TEMPLATE_LABEL = { stat: "Number", list: "List", chart: "Chart", progress: "Progress", text: "Text" };

/** A segmented switch; `on(value)` when one is chosen. */
function segmented(options, value, on, { label = "" } = {}) {
  const el = h("div", { class: "segmented", role: "group", "aria-label": label });
  const draw = (v) =>
    put(
      el,
      options.map(([k, text]) =>
        h("button", { type: "button", "aria-pressed": String(k === v), onclick: () => (draw(k), on(k)) }, text),
      ),
    );
  draw(value);
  return el;
}

/** A widget's live preview at a size (Home's cell sizes), on its own stage. */
function widgetPreview(cap, capabilityId, w, { size, input = {} }) {
  const slot = h("div", { class: "widget-slot" });
  const preview = h("div", { class: `widget-preview w-${size}` }, slot);
  let viewModel = null;
  let problem = null;
  const draw = async (s = size) => {
    size = s;
    preview.className = `widget-preview w-${size}`;
    if (problem) return put(slot, h("div", { class: `jw jw-${size}` }, h("div", { class: "jw-title" }, w.title), h("div", { class: "jw-empty" }, problem)));
    if (!viewModel) return put(slot, h("div", { class: `jw jw-${size}` }, h("div", { class: "jw-title" }, w.title), h("span", { class: "skeleton widget-skeleton" })));
    (await renderer())(slot, viewModel, { size, title: w.title, onButton: () => {}, icon: widgetIcon(cap) });
  };
  const load = async (inp = input) => {
    try {
      viewModel = (await api("/home/preview", { method: "POST", body: { id: capabilityId, widget: w.name, input: inp } })).view;
      problem = null;
    } catch (err) {
      problem = `Can't show it right now: ${err.message}`;
    }
    draw();
  };
  draw();
  load();
  return { el: h("div", { class: "widget-preview-stage" }, preview), draw, load };
}

/**
 * F5 Add a widget: a Form sheet that only adds to Home. Filter by tool, see the widget live at the
 * size you pick, add it. Making new widgets goes to the intake ("Describe a new one ›").
 */
async function addWidgetSheet({ capabilityId, widget, onAdded } = {}) {
  const [{ gallery }, all] = await Promise.all([api("/home"), caps(true)]);
  const offered = gallery.flatMap((g) => g.widgets.map((w) => ({ g, w, cap: all.get(g.capabilityId) ?? { id: g.capabilityId, name: g.name } })));
  let only = capabilityId ?? null;
  let pick = offered.find((x) => x.g.capabilityId === capabilityId && (!widget || x.w.name === widget)) ?? offered[0];
  let added = false;
  await modal(
    (close) => {
      const body = h("div", { class: "stack-md" });
      const render = () => {
        const shown = offered.filter((x) => !only || x.g.capabilityId === only);
        if (!shown.includes(pick)) pick = shown[0];
        const filters = h(
          "div",
          { class: "row tight wrap" },
          h("button", { class: `chip plain ${only ? "" : "selected"}`, onclick: () => ((only = null), render()) }, "All"),
          [...new Set(offered.map((x) => x.g.capabilityId))].map((id) => {
            const c = all.get(id) ?? offered.find((x) => x.g.capabilityId === id).cap;
            return chip(c, undefined, { class: `chip ${only === id ? "selected" : ""}`, onclick: () => ((only = id), render()) });
          }),
        );
        if (!pick) return put(body, filters, h("p", { class: "muted" }, "None of your tools has widgets yet."), footer(null));
        const { w, g, cap } = pick;
        let size = w.sizes.includes("medium") ? "medium" : w.sizes[0];
        const required = new Set(w.inputSchema?.required ?? []);
        const fields = Object.entries(w.inputSchema?.properties ?? {}).map(([n, s]) => [n, field(n, s, required.has(n))]);
        const readInput = () => Object.fromEntries(fields.map(([n, f]) => [n, f.read()]).filter(([, v]) => v !== undefined));
        const preview = widgetPreview(cap, g.capabilityId, w, { size });
        for (const [, f] of fields) f.el.addEventListener("change", () => preview.load(readInput()));
        const which =
          shown.length > 1 &&
          h(
            "div",
            { class: "segmented widget-which" },
            shown.map((x) => h("button", { type: "button", "aria-pressed": String(x === pick), onclick: () => ((pick = x), render()) }, x.w.title)),
          );
        const addBtn = h("button", { class: "primary" }, "Add to Home");
        addBtn.addEventListener("click", async () => {
          try {
            addBtn.disabled = true;
            const input = readInput();
            await api("/home/widgets", { method: "POST", body: { id: g.capabilityId, widget: w.name, size, ...(Object.keys(input).length ? { input } : {}) } });
            toast(`${w.title} is on Home`);
            added = true;
            close();
          } catch (err) {
            addBtn.disabled = false;
            fail(err);
          }
        });
        put(
          body,
          filters,
          which,
          preview.el,
          h(
            "div",
            { class: "row between" },
            h("div", { class: "col" }, h("span", { class: "strong" }, w.title), h("span", { class: "small muted row tight" }, capRef(cap, g.capabilityId), w.description ? `· ${w.description}` : "")),
            w.sizes.length > 1 ? segmented(w.sizes.map((s) => [s, SIZE_LABEL[s]]), size, (s) => ((size = s), preview.draw(s)), { label: "Size" }) : h("span", { class: "small faint" }, SIZE_LABEL[size]),
          ),
          fields.length ? h("div", { class: "fields" }, fields.map(([, f]) => f.el)) : null,
          footer(addBtn),
        );
      };
      const footer = (addBtn) =>
        h(
          "div",
          { class: "row between" },
          h("button", { class: "link", onclick: () => describeNewWidget(only ? all.get(only) : pick?.cap, close) }, "Describe a new one ›"),
          h("span", { class: "row tight" }, h("button", { onclick: () => close() }, "Cancel"), addBtn),
        );
      render();
      return [h("h2", { class: "flush" }, "Add a widget"), body];
    },
    { width: 520 },
  );
  if (added) onAdded ? onAdded() : (location.hash === "" || location.hash === "#/") && route();
}

/** A placed widget's options: the form it was added with, filled in, live preview; saves the layout with the new input. */
async function widgetOptionsSheet(e, c, w) {
  let saved = false;
  await modal(
    (close) => {
      const required = new Set(w.inputSchema?.required ?? []);
      const fields = Object.entries(w.inputSchema?.properties ?? {}).map(([n, s]) => [n, field(n, s, required.has(n))]);
      for (const [n, f] of fields) f.write(e.input?.[n]);
      const readInput = () => Object.fromEntries(fields.map(([n, f]) => [n, f.read()]).filter(([, v]) => v !== undefined));
      const preview = widgetPreview(c, e.id, w, { size: e.size, input: e.input ?? {} });
      for (const [, f] of fields) f.el.addEventListener("change", () => preview.load(readInput()));
      const saveBtn = h("button", { class: "primary", type: "submit" }, "Save");
      const form = h(
        "form",
        {
          class: "stack-md",
          onsubmit: async (ev) => {
            ev.preventDefault();
            try {
              saveBtn.disabled = true;
              const input = readInput();
              // The layout as stored, with this widget's input replaced.
              const { layout } = await api("/home");
              const entries = layout.map((x) => storedEntry(x.key === e.key ? { ...x, input: Object.keys(input).length ? input : undefined } : x));
              await api("/home/layout", { method: "PUT", body: { entries } });
              saved = true;
              close();
            } catch (err) {
              saveBtn.disabled = false;
              fail(err);
            }
          },
        },
        preview.el,
        h("div", { class: "fields" }, fields.map(([, f]) => f.el)),
        sheetActions(h("button", { type: "button", onclick: () => close() }, "Cancel"), saveBtn),
      );
      return [sheetHead(appIcon(c, { size: 44 }), e.title ?? w.title, c.name), form];
    },
    { width: 520 },
  );
  return saved;
}

/** New widgets come from the intake, for one tool (it suggests a few; only the ticked ones are built). */
async function describeNewWidget(cap, close) {
  let c = cap;
  if (!c) {
    const targets = [...(await caps()).values()].filter((x) => x.kind !== "connection" && x.version);
    if (!targets.length) return fail(new Error("Make a tool first"));
    const id = await pickerSheet({ title: "New widgets for…", options: targets.map((t) => ({ value: t.id, label: t.name, tile: appIcon(t, { size: 28 }) })), confirm: "Next", unchanged: false });
    c = id && targets.find((t) => t.id === id);
  }
  if (!c) return;
  close?.();
  openChange(c, { widget: "new" });
}

/** Info › Widgets (N4): what a tool offers, which are on Home, add one, delete one from the tool. */
async function toolWidgetsSheet(c) {
  const [{ gallery, layout }, detail] = await Promise.all([api("/home"), api(`/capabilities/${enc(c.id)}`)]);
  const offered = gallery.find((g) => g.capabilityId === c.id)?.widgets ?? [];
  const onHome = (w) => layout.filter((e) => e.type === "widget" && e.id === c.id && e.widget === w.name).length;
  return modal(
    (close) => [
      sheetHead(appIcon(c, { size: 44 }), `Widgets · ${c.name}`),
      offered.length
        ? h(
            "ul",
            { class: "list" },
            offered.map((w) =>
              h(
                "li",
                {},
                h("div", { class: "grow" }, h("span", {}, w.title), h("span", { class: "sub" }, [w.description, w.sizes.map((s) => SIZE_LETTER[s]).join(", ")].filter(Boolean).join(" · "))),
                // On Home already: another copy only makes sense with other settings.
                onHome(w) > 0 && h("span", { class: "pill ok" }, "on Home"),
                (!onHome(w) || Object.keys(w.inputSchema?.properties ?? {}).length > 0) && h("button", { class: "sm", onclick: () => (close(), addWidgetSheet({ capabilityId: c.id, widget: w.name })) }, onHome(w) ? "Add another" : "Add to Home"),
                h(
                  "button",
                  {
                    class: "ghost sm danger",
                    onclick: async () => {
                      if (!(await confirmDialog({ title: `Delete “${w.title}”?`, body: `It's removed from ${c.name} (a quick change, no builder) and from Home. The tool and its data stay.`, confirm: "Delete widget", danger: true }))) return;
                      try {
                        const b = await api(`/capabilities/${enc(c.id)}/widgets/${enc(w.name)}`, { method: "DELETE" });
                        close();
                        go(`#/b/${enc(b.buildId)}`);
                      } catch (e) {
                        fail(e);
                      }
                    },
                  },
                  "Delete…",
                ),
              ),
            ),
          )
        : h("p", { class: "muted" }, `${c.name} has no widgets yet.`),
      h("div", { class: "row between" }, detail.kind !== "connection" ? h("button", { class: "link", onclick: () => (close(), openChange(c, { widget: "new" })) }, "Describe a new one ›") : h("span", {}), h("button", { onclick: () => close() }, "Done")),
    ],
    { width: 520 },
  );
}

/** Starters for the first build: real builds by the chosen builder, so the first one is also the test. */
const STARTERS = [
  {
    name: "Reading List",
    label: "Reading list",
    purpose: "Books and articles I want to read, with where I am on each.",
    requirements: "Operations: add_item (title, optional author/url, status to_read by default), set_status (to_read | reading | done, optional note), list_items (optional status filter; newest first). Keep a finished date when an item is marked done.",
  },
  {
    name: "Habit Tracker",
    label: "Habit tracker",
    purpose: "Daily habits I check off, with streaks.",
    requirements: "Operations: add_habit (name), check_in (habit, date defaulting to today), list_habits (each with today's status, current streak and longest streak). A habit can be checked in once per day.",
  },
  {
    name: "Running Log",
    label: "Running log",
    purpose: "My runs: distance, time and how it felt, with weekly totals.",
    requirements: "Operations: record_run (distanceKm, durationSeconds, optional date defaulting to today and notes), list_runs (newest first, optional limit), get_summary (totals and pace for this week, last week and all time).",
  },
];

/**
 * F1 First run: one moment screen in place of Welcome and the empty Home. Agents on this machine,
 * who works for Hewn (chosen by the owner, never automatically), then the first thing to make.
 * No Skip: leaving without building shows it again until a tool exists.
 */
async function firstRun() {
  setWallpaper([125, 250], { dim: true });
  const machine = await hewnMachine();
  const agentsCard = h("div", { class: "card first-card" }, skeleton("60%"));
  const jobsCard = h("div", { class: "card first-card" }, skeleton("50%"));
  const make = h("div", { class: "stack-sm first-make" });
  let builderOk = false;

  // Hosted: no agents on the machine, and the host builds (no step 2).
  const hosted = !!settings?.hosted;
  const renderAgents = async () => {
    if (hosted)
      return put(
        agentsCard,
        h("div", { class: "eyebrow card-eyebrow" }, "1 · Connect your agents"),
        h("ul", { class: "list" }, h("li", {}, h("div", { class: "grow" }, h("span", {}, "claude.ai, ChatGPT and other agents"), h("span", { class: "sub" }, "They use your tools, and can build new ones")), h("button", { class: "sm", onclick: () => connectDialog().then(renderAll) }, "Connect…"))),
      );
    const harnesses = await api("/setup/agents").catch(() => []);
    const local = harnesses.filter((x) => x.found && !x.cloud);
    put(
      agentsCard,
      h("div", { class: "eyebrow card-eyebrow" }, `1 · Agents on ${machine.word}`),
      h(
        "ul",
        { class: "list" },
        local.length
          ? local.map((x) =>
              h(
                "li",
                {},
                agentTile(x.agentId, x.label),
                h("div", { class: "grow" }, h("span", {}, x.label), h("span", { class: "sub" }, x.connected ? "Connected" : "Found")),
                x.connected ? h("span", { class: "pill ok with-dot" }, "connected") : h("button", { class: "primary sm", onclick: () => connectDialog(x.agentId).then(renderAll) }, "Connect"),
              ),
            )
          : h("li", {}, h("div", { class: "grow" }, h("span", {}, "None found"), h("span", { class: "sub" }, "Install Claude Code, Codex or OpenCode and sign in")), h("button", { class: "sm", onclick: renderAgents }, "Look again")),
        h("li", {}, h("div", { class: "grow" }, h("span", { class: "muted" }, "claude.ai, ChatGPT and other agents")), h("button", { class: "ghost sm", onclick: () => connectDialog().then(renderAll) }, "Connect…")),
      ),
    );
  };
  const renderJobs = async () => {
    if (hosted) {
      builderOk = true;
      jobsCard.hidden = true;
      return renderMake();
    }
    const [{ tools, ready }, s] = await Promise.all([buildJobs(), loadSettings()]);
    builderOk = buildsChosen(s) && ready(tools.find((t) => t.name === s.builder));
    const t = tools.find((x) => x.name === s?.builder);
    const chosen = buildsChosen(s);
    put(
      jobsCard,
      h("div", { class: "eyebrow card-eyebrow" }, "2 · Who builds your tools"),
      h(
        "ul",
        { class: "list" },
        h(
          "li",
          {},
          chosen && t ? agentTileOf(t, 28) : null,
          h("div", { class: "grow" }, h("span", {}, "Builds tools"), h("span", { class: "sub" }, chosen && t ? `${t.label} · ${ready(t) ? "signed in" : t.fix ?? "not ready"}` : "Not chosen")),
          h("button", { class: "sm", onclick: () => jobPicker().then(renderAll) }, "Choose…"),
        ),
      ),
    );
    renderMake();
  };
  const renderMake = () => {
    // The intake's box: the message, then the model it builds with and Send (the same as New tool).
    const ask = h("textarea", { class: "composer-input", rows: 1, placeholder: "Track my coffee beans and how I rated each brew", "aria-label": "Describe it", disabled: !builderOk });
    const next = h("button", { type: "submit", class: "lg", disabled: !builderOk }, "Send");
    const start = () => ask.value.trim() && go(`#/new?m=${enc(ask.value.trim())}&send=1`);
    ask.addEventListener("input", () => ((ask.style.height = "auto"), (ask.style.height = `${ask.scrollHeight + ask.offsetHeight - ask.clientHeight}px`)));
    ask.addEventListener("keydown", (e) => e.key === "Enter" && !e.shiftKey && !e.isComposing && (e.preventDefault(), start()));
    const starters = STARTERS.map((st) =>
      h(
        "button",
        {
          class: "chip plain",
          disabled: !builderOk,
          title: st.purpose,
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              const b = await api("/capabilities", { method: "POST", body: { name: st.name, purpose: st.purpose, requirements: st.requirements } });
              invalidateCaps();
              go(`#/b/${b.buildId}`);
            } catch (err) {
              e.currentTarget.disabled = false;
              fail(err);
            }
          },
        },
        st.label,
      ),
    );
    make.classList.toggle("disabled", !builderOk);
    put(
      make,
      h("div", { class: "eyebrow" }, hosted ? "2 · Make something" : "3 · Make something"),
      h("form", { class: "composer boxed", onsubmit: (e) => (e.preventDefault(), start()) }, ask, h("div", { class: "composer-tools" }, builderOk && modelChip(), next)),
      h("div", { class: "row tight wrap" }, starters),
    );
  };
  const renderAll = () => Promise.all([renderAgents(), renderJobs()]);
  view(
    moment(
      { right: "20px", top: "140px", opacity: 0.28 },
      bar({ left: brand(), right: inboxBtn }),
      h(
        "main",
        { class: "first-run" },
        h("div", { class: "stack-sm" }, h("div", { class: "display first-display" }, "Make your own tools."), h("div", { class: "muted lead" }, "Every agent you connect can use them.")),
        agentsCard,
        jobsCard,
        make,
      ),
    ),
  );
  renderAll();
}

// ---------- A4 opened tool, A5 Run view, and the change drawer (P1–P5) ----------

/**
 * Bar for an opened tool (its own UI, or the Run view): back, icon + name + version, Change… (pressed
 * while the drawer is open) and •••.
 */
function appBar(c, { onChange } = {}) {
  const name = h("span", {}, c.name);
  const more = h("button", { "aria-label": "More", onclick: () => menuFrom(more, capabilityMenu(c, { rename: () => inlineRename(c, name) })) }, "•••");
  const change = h("button", { "aria-pressed": "false", onclick: () => onChange?.() }, "Change…");
  const el = bar({
    left: c.kind === "connection" ? glassBack(c.name, `#/c/${enc(c.id)}`) : glassBack("Home", "#/"),
    center: h("div", { class: "app-title" }, appIcon(c, { size: 28 }), name, c.version && h("span", { class: "pill" }, `v${c.version}`)),
    right: h("div", { class: "glass-bar" }, change, more),
  });
  return { el, change };
}

/**
 * The change drawer beside an opened tool (P1): the intake as a component, then the build (P3),
 * then "vN is ready" with Reload and Undo (P4). The tool stays live on the left. Closing it while
 * a build runs is fine: the tile and the Inbox take over.
 */
function changeDrawer(c, q, { onReload, onClose, noUi = false }) {
  const body = h("div", { class: "drawer-body" });
  const close = h("button", { class: "ghost sm icon-only", "aria-label": "Close", onclick: () => onClose() }, "×");
  const el = h("aside", { class: "drawer", "aria-label": `Change ${c.name}` }, h("div", { class: "drawer-head" }, h("span", { class: "row tight" }, h("span", { class: "eyebrow" }, "Change"), capRef(c)), close), body);
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
    else for (const k of ["change", "m", "send", "widget", "from"]) p.delete(k);
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
      for (const k of ["m", "send", "widget", "from"]) q.delete(k);
      setUrl(false);
    } else drawer?.focus();
  };
  if (q.get("change") === "1") open();
  /** Open the drawer (if it isn't), with `text` in the composer when given; without, what's typed stays. */
  drawerApi.open = (text) => (toggle(true), text === undefined ? drawer?.focus() : drawer?.setText(text));
  return [barEl, layout];
}

async function appPage(id, q) {
  document.body.classList.add("app-mode");
  // ?at=<section>: a widget's tap opens the UI there ("open": "ui#today").
  const at = q?.get("at");
  const openUrl = async () => (await api(`/capabilities/${enc(id)}/open`, { method: "POST", ...(at ? { body: { section: at } } : {}) })).url;
  const [all, url] = await Promise.all([caps(true), openUrl()]);
  const c = all.get(id) ?? { id, name: id };
  // Sandboxed without allow-same-origin (the server's CSP says the same): the app runs on an
  // opaque origin and cannot touch or navigate the web client.
  const frame = h("iframe", { class: "app-frame loading", src: url, title: c.name, sandbox: "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals", allow: "clipboard-write" });
  const scrollKey = `hewn.scroll.${id}`;
  const subtitle = h("span", { class: "app-subtitle muted" });
  const reload = async () => {
    invalidateCaps();
    frame.classList.add("loading");
    frame.src = await openUrl();
    // The bar's version follows (v1 → v2).
    const now = (await caps(true).catch(() => new Map())).get(c.id);
    const pill = barEl.querySelector(".app-title .pill");
    if (now?.version && pill) pill.textContent = `v${now.version}`;
  };
  const drawerApi = {};
  const [barEl, layout] = withDrawer(c, q, frame, { reload, api: drawerApi });
  barEl.querySelector(".app-title")?.append(subtitle);
  askFeedbackOnOpen(c, drawerApi);
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
      const y = Number(sessionStorage.getItem(scrollKey) ?? 0);
      if (y > 0) frame.contentWindow.postMessage({ hewn: 1, type: "restore-scroll", y }, "*");
    }
  };
  window.addEventListener("message", onMessage);
  onLeave(() => window.removeEventListener("message", onMessage));
  // Older apps (or a slow first paint): don't stay invisible.
  const reveal = setInterval(() => frame.classList.remove("loading"), 1500);
  onLeave(() => clearInterval(reveal));
  view(barEl, fixSlot, layout);
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
  document.body.classList.add("app-mode");
  const [cap, all] = await Promise.all([api(`/capabilities/${enc(id)}`), caps(true)]);
  const c = all.get(id) ?? { id, name: cap.name, kind: cap.kind };
  setWallpaper(await hues([tintOf(c)]));
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
  view(barEl, sandboxNotice(), layout);
  if (selected) select(selected);
  askFeedbackOnOpen(c, drawerApi);
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
    !cap.status.ready && h("div", { class: "notice" }, h("span", { class: "grow" }, cap.status.missingModel && !cap.status.pendingGrants.length ? "Needs a model." : "Needs your authorization."), h("button", { class: "sm", onclick: () => grantsSheet(id).then((ok) => ok && route()) }, "Review")),
    h("form", { class: "card run-form", onsubmit: run }, h("div", { class: "muted small" }, op.description), fields.length ? h("div", { class: "fields" }, fields.map(([, f]) => f.el)) : null, h("div", { class: "actions flush" }, runBtn)),
    result,
  ];
}

// ---------- D1 / D2 / O4: the grants sheet (a Request; approved, the same rows with Revoke) ----------

/** Capability-ref text for an authorization item: "Write to <Running Log>", "Reach host", "SECRET". */
function grantText(i, all) {
  if (i.kind === "capability") {
    const verb = i.sideEffect === "read" ? "Read" : i.sideEffect === "destructive" ? "Change" : i.sideEffect === "missing" ? "Use" : "Write to";
    return h("span", { class: "row tight wrap" }, `${verb} `, capRef(all.get(i.target), i.target));
  }
  if (i.kind === "host") return h("span", {}, `Reach ${i.grant.slice(5)}`);
  if (i.kind === "model") return h("span", {}, "Use a model");
  return h("span", { class: "mono" }, i.grant.slice(7));
}
const kindPill = (i) =>
  i.kind === "capability"
    ? kindTag(i.sideEffect === "read" ? "read" : i.sideEffect === "missing" ? "missing" : "write", i.sideEffect === "read" ? "" : i.sideEffect === "missing" ? "danger" : "accent")
    : kindTag(i.kind, i.kind === "model" ? "accent" : "");

const TIERS = ["light", "standard", "strong", "max"];
/** About what one call costs on a model: a typical 1,500 tokens in and 500 out. */
const perCall = (price) => price && price.input * 1500 + price.output * 500;
const tierModel = (m, tier) => {
  const prov = m?.providers.find((p) => p.id === m.provider);
  const id = prov?.tiers[tier];
  const x = id && prov.models.find((y) => y.id === id);
  return id ? { prov, id, name: x?.name ?? id, price: x?.price ?? m.prices[`${prov.id}/${id}`] } : null;
};

/**
 * The model a tool needs, set up inline (O4): no provider yet means a key, right here. Tools call a
 * model with an API key, not through an agent, so an agent's login doesn't cover it. `onReady(ok)`
 * after each check.
 */
function providerKeyBlock(m, onReady) {
  let chosen = m.providers.find((p) => !p.keySet)?.id ?? "anthropic";
  const select = h("select", { class: "provider-select", "aria-label": "Provider" }, m.providers.map((p) => h("option", { value: p.id, selected: p.id === chosen }, PROVIDERS[p.id].label)));
  const key = h("input", { type: "password", autocomplete: "off", placeholder: "Paste API key", "aria-label": "API key" });
  const status = h("div", { class: "small faint" });
  let timer;
  const check = async () => {
    if (!key.value.trim()) return onReady(false);
    status.textContent = "Checking the key…";
    try {
      let next = await api(`/models/keys/${chosen}`, { method: "PUT", body: { key: key.value.trim() } });
      if (next.provider !== chosen) next = await api("/models", { method: "PUT", body: { provider: chosen } });
      put(status, h("span", { class: "dot ok" }), ` ${PROVIDERS[chosen].label} key works`);
      onReady(true, next);
    } catch (e) {
      status.textContent = e.message;
      onReady(false);
    }
  };
  select.addEventListener("change", () => ((chosen = select.value), key.value && check()));
  key.addEventListener("input", () => (clearTimeout(timer), onReady(false), (timer = setTimeout(check, 700))));
  // The first provider: also the monthly budget every tool's model calls are checked against.
  const budget = h("input", { type: "number", min: 0, step: 1, value: m.monthlyCapUsd, class: "model-cap", "aria-label": "Monthly budget in USD" });
  const el = h(
    "div",
    { class: "inset-block stack-sm" },
    h("div", { class: "small" }, "Tools call a model directly with an API key, not through an agent, so your Claude Code or Codex login doesn't cover it."),
    h("div", { class: "row tight nowrap" }, select, key),
    status,
    !m.provider && h("div", { class: "row tight nowrap budget-row" }, h("div", { class: "grow col" }, h("span", { class: "small" }, "Monthly budget"), h("span", { class: "small faint" }, "For all tools; calls stop once it's spent")), h("span", { class: "small faint" }, "$"), budget),
  );
  el.saveBudget = async () => {
    if (m.provider || Number(budget.value) === m.monthlyCapUsd || budget.value === "") return;
    await api("/models", { method: "PUT", body: { monthlyCapUsd: Number(budget.value) } });
  };
  return el;
}

/**
 * What a tool may do: pending (a Request, "wants to", one Authorize) or approved ("is allowed to",
 * revoke with Undo). A model is a grant row with a tier select; with no provider yet, the key goes
 * in right here. Resolves true if the tool ended up ready.
 */
async function grantsSheet(capId) {
  const id = enc(capId);
  const [cap, all] = await Promise.all([api(`/capabilities/${id}`), caps()]);
  const c = all.get(capId) ?? { id: capId, name: cap.name };
  const items = cap.authorization?.items ?? [];
  // A connection with a sign-in step gets its secrets by signing in (after authorizing), not by pasting.
  const signIn = cap.kind === "connection" && cap.operations.some((o) => o.name === "connect");
  const missingSecrets = new Set(signIn ? [] : cap.status.missingSecrets);
  const missingConfig = (cap.authorization?.config ?? []).filter((x) => x.value === null);
  const modelReq = cap.requires?.model;
  const m = modelReq ? await api("/models").catch(() => null) : null;
  // No usable provider: the key block, even when the grant itself is approved.
  // Hosted: the host runs tools' model calls; no key to give.
  const needsKey = !!modelReq && !!m && !m.host && (!m.provider || !m.providers.find((p) => p.id === m.provider)?.keySet);
  const pending = items.filter((i) => !i.approved || (i.kind === "secret" && missingSecrets.has(i.grant.slice(7))) || (i.kind === "model" && needsKey));
  const thenSignIn = async (ready) => (signIn && !ready && (await api(`/capabilities/${id}`)).status.missingSecrets.length ? signInDialog(capId) : ready);

  if (!pending.length && !missingConfig.length && signIn && cap.status.missingSecrets.length) return signInDialog(capId);
  const requests = cap.authorization?.requests ?? [];
  const requestedBy = requests[0]?.requestedBy ?? cap.versions?.[0]?.requestedBy;

  if (!pending.length && !missingConfig.length) {
    await modal((close) => approvedSheet(capId, c, cap, items, all, close), { width: 480 });
    invalidateCaps();
    return (await api(`/capabilities/${id}`).catch(() => cap)).status.ready;
  }

  const secrets = new Map();
  const config = new Map();
  /** Grant → its switch, for pending host and capability grants (the owner may leave some out). */
  const picks = new Map();
  let tier = modelReq?.tier ?? null;
  let keyOk = !needsKey;
  let check = () => {};
  const keyBlock = needsKey ? providerKeyBlock(m, (ok) => ((keyOk = ok), check())) : null;
  return modal(
    (close) => {
      const authorize = h("button", { class: "primary", disabled: true }, "Authorize");
      check = () => (authorize.disabled = !keyOk || [...secrets.entries()].some(([name, input]) => missingSecrets.has(name) && !input.value) || [...config.values()].some((input) => !input.value.trim()));
      authorize.addEventListener("click", async () => {
        authorize.disabled = true;
        try {
          await keyBlock?.saveBudget();
          for (const [name, input] of config) await api(`/capabilities/${id}/config/${enc(name)}`, { method: "PUT", body: { value: input.value.trim() } });
          for (const [name, input] of secrets) if (input.value) await api(`/capabilities/${id}/secrets/${enc(name)}`, { method: "PUT", body: { value: input.value } });
          const left = [...picks].filter(([, sw]) => !sw.checked).map(([grant]) => grant);
          // A different tier than asked for: a quick change (manifest only) that carries its own grant.
          const otherTier = modelReq?.tier && tier && tier !== modelReq.tier;
          const modelGrant = items.find((i) => i.kind === "model")?.grant;
          if (!left.length && !otherTier) await api(`/capabilities/${id}/grants/approve`, { method: "POST" });
          else for (const i of pending) if (!i.approved && !left.includes(i.grant) && !(otherTier && i.grant === modelGrant)) await api(`/capabilities/${id}/grants/approve`, { method: "POST", body: { grant: i.grant } });
          if (otherTier) {
            await api(`/capabilities/${id}/model`, { method: "POST", body: { tier } });
            toast(`${c.name} will use the ${tier} tier`);
          }
          invalidateCaps();
          const now = await api(`/capabilities/${id}`);
          if (!otherTier) toast(now.status.ready ? `${c.name} is ready` : "Authorized");
          close(now.status.ready);
        } catch (e) {
          fail(e);
          check();
        }
      });
      const configRow = (x) => {
        const input = h("input", { type: "text", autocomplete: "off", placeholder: x.description, oninput: check });
        config.set(x.name, input);
        return { pill: kindTag("setting"), main: h("span", { class: "mono" }, x.name), sub: x.description, extra: input };
      };
      const row = (i) => {
        const secretName = i.kind === "secret" ? i.grant.slice(7) : null;
        let input = null;
        if (secretName && !signIn) {
          input = h("input", { type: "password", autocomplete: "off", placeholder: missingSecrets.has(secretName) ? "Paste value" : "Set · paste to replace", oninput: check });
          secrets.set(secretName, input);
        }
        if (i.kind === "model") {
          if (!modelReq?.tier) return { pill: kindPill(i), main: h("span", {}, `Use ${modelReq?.model ?? "a model"}`), sub: "A specific model" };
          const asked = tierModel(m, modelReq.tier);
          const cost = perCall(asked?.price);
          const select = h("select", { class: "tier-select", "aria-label": "Tier" }, TIERS.map((t) => h("option", { value: t, selected: t === tier }, `${titleCase(t)} tier`)));
          select.addEventListener("change", () => (tier = select.value));
          return { pill: kindPill(i), main: h("span", {}, "Use a model"), sub: `Asked for ${titleCase(modelReq.tier)}${cost ? ` · about ${usd(cost)} a call` : ""}`, control: select };
        }
        let sw = null;
        if (!secretName && !i.approved) {
          sw = h("input", { type: "checkbox", class: "switch", checked: true, "aria-label": "Allow" });
          picks.set(i.grant, sw);
        }
        return {
          pill: kindPill(i),
          main: grantText(i, all),
          sub: i.kind === "capability" ? i.grant.split("/").at(-1).split("@")[0] : i.kind === "secret" ? i.description : null,
          mono: i.kind === "capability",
          extra: input,
          control: sw,
        };
      };
      check();
      return [
        sheetHead(appIcon(c, { size: 48 }), `${c.name} wants to`, requestedBy && `Requested by ${actorLabel(requestedBy, all)}`),
        requests[0]?.note && h("div", { class: "small quote" }, `“${requests[0].note}”`),
        cap.status.missingDependencies?.length > 0 && h("div", { class: "notice danger" }, h("span", {}, "Depends on operations that no longer exist. ", h("a", { href: changeHref(c) }, "Change it"))),
        cap.status.unsupportedAbi && h("div", { class: "notice danger" }, h("span", {}, `This version ${cap.status.unsupportedAbi}. Upgrade Hewn, or roll it back.`)),
        requestRows([...missingConfig.map(configRow), ...pending.map(row)]),
        keyBlock,
        h(
          "div",
          { class: "small faint" },
          signIn ? "Next, you sign in to the service here in Hewn. Agents never see your password or tokens." : pending.some((i) => i.kind === "secret") ? "Secrets go to your Keychain only." : null,
        ),
        sheetActions(h("button", { onclick: () => close(false) }, "Not now"), authorize),
      ];
    },
    { width: 480 },
  )
    .then(Boolean)
    .then(thenSignIn);
}

function approvedSheet(capId, c, cap, items, all, close) {
  const id = enc(capId);
  const list = h("ul", { class: "list" });
  const render = (current) => {
    put(
      list,
      ...current.map((i) => {
        const isSecret = i.kind === "secret";
        const action = i.kind === "model" ? null : h("button", { class: "link sm" }, isSecret ? "Replace" : "Revoke");
        const li = h("li", {}, kindPill(i), h("div", { class: "grow" }, grantText(i, all), isSecret && i.description && h("span", { class: "sub" }, i.description), i.kind === "model" && h("span", { class: "sub" }, i.label)), action);
        action?.addEventListener("click", async () => {
          if (isSecret) {
            const input = h("input", { type: "password", autocomplete: "off", placeholder: "Paste new value" });
            const save = h("button", { class: "sm primary" }, "Save");
            save.addEventListener("click", async () => {
              if (!input.value) return input.focus();
              try {
                await api(`/capabilities/${id}/secrets/${enc(i.grant.slice(7))}`, { method: "PUT", body: { value: input.value } });
                toast(`Replaced ${i.grant.slice(7)}`);
                render(current);
              } catch (e) {
                fail(e);
              }
            });
            li.querySelector(".grow").append(h("span", { class: "row tight" }, input, save));
            action.remove();
            return input.focus();
          }
          try {
            await api(`/capabilities/${id}/grants/revoke`, { method: "POST", body: { grant: i.grant } });
            const rest = current.filter((x) => x !== i);
            render(rest);
            toast(`Revoked ${i.kind === "host" ? "host access" : "access"}`, {
              dot: "",
              undo: async () => {
                await api(`/capabilities/${id}/grants/approve`, { method: "POST", body: { grant: i.grant } });
                render(current);
                toast("Restored");
              },
            });
          } catch (e) {
            fail(e);
          }
        });
        return li;
      }),
    );
    if (!current.length) put(list, h("li", {}, h("span", { class: "dot ok" }), h("span", { class: "grow muted" }, "Needs nothing outside itself")));
  };
  render(items.filter((i) => i.approved));
  return [sheetHead(appIcon(c, { size: 48 }), `${c.name} is allowed to`), list, sheetActions(h("button", { class: "primary", onclick: () => close(true) }, "Done"))];
}

/**
 * I4 Sign in to a connection's service: a stepped Form (the connection's own steps: account, then
 * a code…), one step per screen, ending on a check mark and its health. Nothing typed here is
 * stored by the browser.
 */
async function signInDialog(capId) {
  const [cap, all] = await Promise.all([api(`/capabilities/${enc(capId)}`), caps()]);
  const c = all.get(capId) ?? { id: capId, name: cap.name };
  const op = cap.operations.filter((o) => o.name === "connect").sort((a, b) => b.version - a.version)[0];
  if (!op) return false;
  return modal(
    (close) => {
      const sub = h("div", { class: "small faint" });
      const body = h("div", { class: "stack-md" });
      const labels = ["Account"];
      const step = (schema, state, message, at) => {
        sub.textContent = at > 0 ? `Step ${at + 1} of ${labels.length}` : "";
        const props = Object.entries(schema.properties ?? {}).filter(([name]) => name !== "state");
        const fields = props.map(([name, sch]) => {
          const secret = sch.format === "password" || sch.writeOnly || /pass|token|secret|key/i.test(name);
          const code = /code|otp|mfa/i.test(name);
          const input = h("input", { type: secret ? "password" : "text", class: code ? "code-input" : "", autocomplete: secret ? "current-password" : code ? "one-time-code" : "off", spellcheck: "false" });
          return { name, sch, input, el: h("label", { class: "field" }, h("span", { class: "label" }, sch.title ?? name), input, sch.description && h("span", { class: "hint" }, sch.description)) };
        });
        const submit = h("button", { class: "primary", type: "submit" }, "Sign in");
        const form = h(
          "form",
          {
            class: "stack-md",
            onsubmit: async (e) => {
              e.preventDefault();
              submit.disabled = true;
              const input = state ? { state } : {};
              for (const f of fields) if (f.input.value !== "") input[f.name] = f.sch.type === "integer" || f.sch.type === "number" ? Number(f.input.value) : f.input.value;
              try {
                const r = await api(`/capabilities/${enc(capId)}/connect`, { method: "POST", body: { input } });
                if (r.status === "needs_input") {
                  if (labels.length < at + 2) labels.push(/code/i.test(JSON.stringify(r.inputSchema ?? {})) ? "Code" : "Next");
                  return step(r.inputSchema ?? { properties: {} }, r.state, r.message, at + 1);
                }
                invalidateCaps();
                const health = await api(`/capabilities/${enc(capId)}/health`).catch(() => null);
                const [dot, word] = HEALTH[health?.status] ?? ["ok", "Connected"];
                sub.textContent = "";
                put(
                  body,
                  sheetSteps(labels, labels.length),
                  h("div", { class: "signed-in" }, h("span", { class: "check-mark", "aria-hidden": "true" }, "✓"), h("div", { class: "col" }, h("span", { class: "strong" }, `Signed in to ${c.name}`), h("span", { class: "small muted row tight" }, h("span", { class: `dot ${dot}` }), word, health?.detail ? ` · ${health.detail}` : ""))),
                  sheetActions(h("button", { class: "primary", onclick: () => close(true) }, "Done")),
                );
              } catch (err) {
                submit.disabled = false;
                fail(err);
              }
            },
          },
          sheetSteps(labels, at),
          message && h("div", { class: "notice" }, h("span", {}, message)),
          fields.map((f) => f.el),
          h("div", { class: "small faint" }, `Your password goes only to ${c.name}; Hewn keeps the token.`),
          sheetActions(at > 0 ? h("button", { type: "button", onclick: () => ((labels.length = 1), step(op.inputSchema, undefined, undefined, 0)) }, "Back") : h("button", { type: "button", onclick: () => close(false) }, "Cancel"), submit),
        );
        put(body, form);
        fields[0]?.input.focus();
      };
      step(op.inputSchema, undefined, undefined, 0);
      return [h("div", { class: "row sheet-head" }, appIcon(c, { size: 44 }), h("div", { class: "grow col" }, h("div", { class: "sheet-title" }, `Sign in to ${c.name}`), sub)), body];
    },
    { width: 440 },
  ).then(Boolean);
}

// ---------- K: schedules ----------

/** "daily 07:00" → "Daily 07:00", "weekly mon 07:00" → "Weekly Mon 07:00"; cron stays as it is. */
const cadenceText = (c = "") => c.replace(/^(hourly|daily|weekly)\b/, (w) => titleCase(w)).replace(/\b(mon|tue|wed|thu|fri|sat|sun)\b/, (d) => titleCase(d));
/** "in 3 h", "in 12 min", "tomorrow": how far off a run is. */
const inFuture = (iso) => {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return d === 1 ? "tomorrow" : `in ${d} days`;
};

/** Text kept to two lines, with a caret that shows all of it (long text only). */
function expandable(text, cls = "") {
  const body = h("span", { class: "clamp-2" }, text);
  if (text.length <= 90) return h("span", { class: cls }, text);
  const caret = h("button", { type: "button", class: "caret-btn", "aria-expanded": "false", "aria-label": "Show the whole message" });
  caret.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = caret.getAttribute("aria-expanded") !== "true";
    caret.setAttribute("aria-expanded", String(open));
    caret.setAttribute("aria-label", open ? "Show less" : "Show the whole message");
    body.classList.toggle("clamp-2", !open);
  });
  return h("span", { class: `${cls} expandable` }, body, caret);
}

/** "operation_failed: fetch_tonight@1 failed: NOAA is unreachable" → "NOAA is unreachable". */
const runFailure = (outcome, operation) => String(outcome).replace(/^\w+: /, "").replace(new RegExp(`^${operation.split("@")[0]}(@\\d+)? failed: `), "");

/**
 * K1 + K2 Schedules for one tool: each schedule a row with a switch and its next run (paused ones
 * say why and offer Resume), then a New schedule block with preset cadences in the owner's time zone.
 */
async function schedulesSheet(c, ops) {
  const runnable = ops.filter((o) => o.sideEffect !== "destructive");
  const zone = settings?.timeZone ?? browserZone();
  return modal(
    (close) => {
      const list = h("ul", { class: "list" });
      const act = (id, body, message) => async () => {
        try {
          await api(`/schedules/${enc(id)}`, body ? { method: "PUT", body } : { method: "DELETE" });
          toast(message);
          render();
        } catch (e) {
          fail(e);
        }
      };
      const render = async () => {
        const all = (await api("/schedules").catch(() => [])).filter((x) => x.capabilityId === c.id);
        put(
          list,
          all.length
            ? all.map((x) => {
                const sw = h("input", { type: "checkbox", class: "switch", checked: x.status === "active", "aria-label": "On" });
                sw.addEventListener("change", () => act(x.id, { status: sw.checked ? "active" : "paused" }, sw.checked ? "Schedule on" : "Schedule paused")());
                const failed = x.lastRunAt && x.lastOutcome && x.lastOutcome !== "ok";
                const sub =
                  x.status === "proposed"
                    ? h("span", { class: "sub" }, `${cadenceText(x.cadence)} · proposed by ${actorLabel(x.createdBy)}`)
                    : x.status === "paused"
                      ? h("span", { class: `sub ${x.pausedReason ? "danger-text" : ""}` }, x.pausedReason ? `${cadenceText(x.cadence)} · paused after ${x.failures} failures in a row` : `${cadenceText(x.cadence)} · paused`)
                      : h("span", { class: "sub" }, `${cadenceText(x.cadence)}${x.nextRunAt ? ` · next ${inFuture(x.nextRunAt)}` : ""}`);
                // Why the last run failed, and when: the tool's own words, without the call's prefixes.
                const why = failed && expandable(`Last run ${ago(x.lastRunAt)} failed: ${runFailure(x.lastOutcome, x.operation)}`, "sub danger-text");
                const fix = failed && h("button", { class: "link sm self-start", type: "button", onclick: () => (close?.(), askFixLatest(c, (f) => f.caller === `schedule:${x.id}`, { caller: `schedule:${x.id}`, operation: x.operation, error: runFailure(x.lastOutcome, x.operation), input: JSON.stringify(x.input ?? {}) }).catch(fail)) }, "Ask builder to fix this");
                return h(
                  "li",
                  {},
                  h("div", { class: "grow" }, h("span", { class: "mono" }, x.operation.split("@")[0]), sub, why, fix),
                  x.status === "proposed" ? h("button", { class: "sm primary", onclick: act(x.id, { status: "active" }, "Schedule enabled") }, "Enable") : x.status === "paused" && x.pausedReason ? h("button", { class: "sm", onclick: act(x.id, { status: "active" }, "Resumed") }, "Resume") : sw,
                  h("button", { class: "ghost sm icon-only", "aria-label": "Delete schedule", onclick: act(x.id, null, "Schedule deleted") }, "×"),
                );
              })
            : h("li", {}, h("span", { class: "grow muted" }, "Nothing runs on a timetable.")),
        );
      };
      render();
      if (!runnable.length) return [sheetHead(appIcon(c, { size: 44 }), `Schedules · ${c.name}`), list, sheetActions(h("button", { onclick: () => close() }, "Done"))];
      // New schedule: an operation, a preset cadence, a time.
      const op = h("select", { "aria-label": "Operation" }, runnable.map((o) => h("option", { value: o.name }, o.name)));
      let kind = "daily";
      const time = h("input", { type: "time", value: "07:00", class: "time-input", "aria-label": "At" });
      const day = h("select", { "aria-label": "Day", class: "day-select" }, ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => h("option", { value: d }, titleCase(d))));
      const cron = h("input", { type: "text", class: "code", placeholder: "0 7 * * 1-5", "aria-label": "Cron" });
      const when = h("div", { class: "row tight" });
      const drawWhen = () =>
        put(when, kind === "hourly" ? null : kind === "custom" ? cron : [kind === "weekly" && day, time], h("span", { class: "small faint" }, `${zone} · your time zone`));
      const cadence = () => (kind === "hourly" ? "hourly" : kind === "custom" ? cron.value.trim() : kind === "weekly" ? `weekly ${day.value} ${time.value}` : `daily ${time.value}`);
      drawWhen();
      const add = h("button", { class: "primary" }, "Add schedule");
      add.addEventListener("click", async () => {
        try {
          add.disabled = true;
          await api("/schedules", { method: "POST", body: { capabilityId: c.id, operation: op.value, cadence: cadence() } });
          toast(`Scheduled ${op.value}: ${cadenceText(cadence())}`);
          render();
        } catch (e) {
          fail(e);
        } finally {
          add.disabled = false;
        }
      });
      return [
        sheetHead(appIcon(c, { size: 44 }), `Schedules · ${c.name}`),
        list,
        h(
          "div",
          { class: "inset-block stack-sm" },
          h("div", { class: "eyebrow" }, "New schedule"),
          op,
          segmented([["hourly", "Hourly"], ["daily", "Daily"], ["weekly", "Weekly"], ["custom", "Custom"]], kind, (k) => ((kind = k), drawWhen()), { label: "Cadence" }),
          when,
        ),
        sheetActions(h("button", { onclick: () => close() }, "Done"), add),
      ];
    },
    { width: 480 },
  );
}

/** K3 An agent's proposed schedule, as a Request: what would run and when; Decline or Enable. */
async function proposalSheet(x) {
  const all = await caps().catch(() => new Map());
  const c = all.get(x.capabilityId) ?? { id: x.capabilityId, name: x.capabilityId };
  const cap = await api(`/capabilities/${enc(x.capabilityId)}`).catch(() => null);
  const [opName] = x.operation.split("@");
  const op = cap?.operations.find((o) => o.name === opName);
  const who = actorLabel(x.createdBy, all);
  const when = /^(hourly|daily|weekly)/.test(x.cadence) ? cadenceText(x.cadence).replace(/^(Daily|Weekly)( \w{3})? (\d\d:\d\d)$/, (_, w, d, t) => `${w.toLowerCase()}${d ?? ""} at ${t}`).replace(/^Hourly$/, "every hour") : `on “${x.cadence}”`;
  return requestSheet({
    icon: appIcon(c, { size: 48 }),
    title: `${who} wants to run ${opName} ${when}`,
    sub: `It runs as you, with what ${c.name} is already allowed to do`,
    quote: x.note,
    rows: [{ pill: op ? sidePill(op.sideEffect) : kindTag("run"), main: capRef(c, x.capabilityId), sub: `${opName} · ${cadenceText(x.cadence)}${x.input && Object.keys(x.input).length ? ` · ${JSON.stringify(x.input)}` : ""}`, mono: false }],
    decline: "Decline",
    accept: "Enable",
    onAccept: async (close) => {
      await api(`/schedules/${enc(x.id)}`, { method: "PUT", body: { status: "active" } });
      toast(`Scheduled ${opName}: ${cadenceText(x.cadence)}`);
      close(true);
    },
    onDecline: async (close) => {
      await api(`/schedules/${enc(x.id)}`, { method: "DELETE" });
      toast("Declined the schedule");
      close(false);
    },
  }).then((r) => (pollInbox(), r));
}

// ---------- J3: a tool's model (tier or a pinned model, and its own cap) ----------

/**
 * J3 One Picker for a tool's model: a tier (it follows Models) or one specific model, and this
 * month's spend with its own cap. A change is a quick change (a new version, no builder).
 */
async function toolModelSheet(c, { replace = false } = {}) {
  const [cap, m] = await Promise.all([api(`/capabilities/${enc(c.id)}`), api("/models")]);
  // Hosted: the tiers are the host's (labels from its model list), and the cap is in its unit.
  const hostTiers = m.host ? (await api("/tools/remote/models").catch(() => null))?.tiers ?? {} : null;
  const req = cap.requires?.model;
  if (!req) return fail(new Error(`${c.name} doesn't use a model`));
  const prov = m.providers.find((p) => p.id === m.provider);
  let pinned = req.model ?? null;
  let tier = req.tier ?? null;
  const retired = cap.status.retiredModel;
  const rows = m.spend.rows.filter((r) => r.capabilityId === c.id);
  const spent = rows.reduce((n, r) => n + r.costUsd, 0);
  const calls = rows.reduce((n, r) => n + r.calls, 0);
  const hostUsed = m.host?.charges.byCapability.filter((x) => x.capabilityId === c.id) ?? [];
  const unit = hostUsed[0]?.unit ?? m.host?.charges.totals[0]?.unit ?? "Credits";
  const used = Math.round(hostUsed.reduce((n, x) => n + x.amount, 0) * 100) / 100;
  return modal(
    (close) => {
      const ok = h("button", { class: "primary" }, "Save");
      const pickLine = h("span", { class: "sub" });
      const modelChanged = () => (pinned ? pinned !== req.model : tier !== req.tier);
      const capChanged = () => capInput.value.trim() !== String(own ?? "");
      // One Save for both: the cap (a setting) and the model (a quick change: a new version, no builder).
      const sync = () => {
        ok.disabled = !modelChanged() && !capChanged();
        pickLine.textContent = pinned ? `${pinned}${retired && pinned === req.model ? " · no longer available" : ""}` : "Pin one model";
      };
      const radio = (checked, onChange) => {
        const r = h("input", { type: "radio", name: "cap-model", checked });
        r.addEventListener("change", onChange);
        return r;
      };
      const tierRadios = {};
      const tierRows = (m.tierNames ?? TIERS).map((t) => {
        const x = tierModel(m, t);
        tierRadios[t] = radio(!pinned && tier === t, () => ((tier = t), (pinned = null), sync()));
        if (hostTiers) return h("label", { class: "job-option" }, tierRadios[t], h("span", { class: "grow col" }, h("span", {}, `${titleCase(t)} tier`), h("span", { class: "sub" }, hostTiers[t] ?? TIER_TEXT[t])));
        return h("label", { class: "job-option" }, tierRadios[t], h("span", { class: "grow col" }, h("span", {}, `${titleCase(t)} tier`), h("span", { class: "sub" }, x ? `${x.name}${x.price ? ` · about ${usd(perCall(x.price))} a call` : ""}` : "Not set up")));
      });
      const pickModel = async () => {
        const p = pinned ? m.providers.find((x) => pinned.startsWith(`${x.id}/`)) ?? prov : prov;
        const successor = retired?.successor?.slice((p?.id.length ?? 0) + 1);
        const id = p ? await modelPicker({ title: replace ? `Replace ${req.model}` : "Pin a model", sub: `${c.name} always uses this model, whatever the tiers say.`, prov: p, current: pinned?.slice(p.id.length + 1), suggested: successor ?? null }) : null;
        if (id) pinned = `${p.id}/${id}`;
        else if (!pinned && tier) tierRadios[tier].checked = true;
        sync();
      };
      const specific = h("label", { class: "job-option" }, radio(!!pinned, pickModel), h("span", { class: "grow col" }, h("span", {}, "A specific model"), pickLine));
      // This month: what it spent, and its own cap (inline).
      // Hosted: in the host's unit, from what it charged this tool's model calls.
      const capsKey = m.host ? "capabilityCapsHost" : "capabilityCapsUsd";
      const own = m[capsKey][c.id];
      const capInput = h("input", { type: "number", min: 0, step: 1, value: own ?? "", placeholder: "No cap", class: "model-cap", "aria-label": m.host ? `Cap in ${unit} a month` : "Cap in USD a month" });
      capInput.addEventListener("input", () => sync());
      const saveCap = async () => {
        const caps = { ...m[capsKey] };
        if (capInput.value.trim() === "") delete caps[c.id];
        else caps[c.id] = Number(capInput.value);
        await api("/models", { method: "PUT", body: { [capsKey]: caps } });
        toast(capInput.value.trim() === "" ? `${c.name}: no cap of its own` : m.host ? `${c.name}: at most ${Number(capInput.value)} ${unit} a month` : `${c.name}: at most $${Number(capInput.value)} a month`);
        pollInbox();
      };
      ok.addEventListener("click", async () => {
        try {
          ok.disabled = true;
          if (capChanged()) await saveCap();
          if (!modelChanged()) return close(true);
          const b = await api(`/capabilities/${enc(c.id)}/model`, { method: "POST", body: pinned ? { model: pinned } : { tier } });
          close(true);
          go(`#/b/${enc(b.buildId)}`);
        } catch (e) {
          ok.disabled = false;
          fail(e);
        }
      });
      sync();
      if (replace && retired) setTimeout(pickModel);
      return [
        sheetHead(appIcon(c, { size: 44 }), `${c.name} · model`, retired ? `${retired.model} is no longer available` : null),
        // Hosted: tiers only (the host runs what each tier names).
        h("fieldset", { class: "job" }, tierRows, !m.host && specific),
        h(
          "div",
          { class: "inset-block row between" },
          h("div", { class: "col" }, h("span", { class: "eyebrow" }, "This month"), h("span", {}, m.host ? `${used} ${unit} · ${calls ? `${calls} call${calls === 1 ? "" : "s"}` : "no calls yet"}` : `${usd(spent)} · ${calls ? `${calls} call${calls === 1 ? "" : "s"}` : "no calls yet"}`)),
          h("span", { class: "row tight nowrap" }, h("span", { class: "small faint" }, m.host ? "Cap" : "Cap $"), capInput, m.host && h("span", { class: "small faint" }, unit)),
        ),
        sheetActions(h("button", { onclick: () => close(false) }, "Cancel"), ok),
      ];
    },
    { width: 480 },
  );
}

// ---------- I: Accounts and connections ----------

const HEALTH = {
  connected: ["ok", "Connected"],
  expired: ["warn", "Expired"],
  broken: ["danger", "Not working"],
  needs_setup: ["warn", "Needs setup"],
};

/** I1 Accounts: one row per connection; a button only when it needs you. */
async function accountsPage() {
  page("accounts", 720, h("h1", { class: "flush" }, "Accounts"), skeleton("60%", "90%", "70%"));
  const [{ connections }, all] = await Promise.all([api("/accounts"), caps(true)]);
  setWallpaper(await hues([260, 200]));
  const building = [...all.values()].filter((c) => c.kind === "connection" && c.building);
  const row = (x) => {
    const c = all.get(x.id) ?? { id: x.id, name: x.name };
    const b = c.building;
    const [dot, word] = b ? ["live", `building · ${buildingLabel(b).toLowerCase()}`] : (HEALTH[x.health?.status] ?? ["warn", x.health?.status ?? "needs setup"]);
    const needsGrants = !b && (x.status?.pendingGrants.length > 0 || x.status?.missingConfig.length > 0);
    const action = b
      ? null
      : needsGrants
        ? h("button", { class: "primary sm", onclick: (e) => (e.stopPropagation(), grantsSheet(x.id).then(() => route())) }, "Set up")
        : x.signIn && x.health?.status !== "connected"
          ? h("button", { class: "primary sm", onclick: (e) => (e.stopPropagation(), signInDialog(x.id).then((ok) => ok && route())) }, "Sign in")
          : x.health?.status === "needs_setup"
            ? h("button", { class: "primary sm", onclick: (e) => (e.stopPropagation(), grantsSheet(x.id).then(() => route())) }, "Set up")
            : null;
    const lit = b?.step === "tests" && b.tests?.total ? b.tests.passed / b.tests.total : b ? 0 : undefined;
    const href = b && !c.version ? `#/b/${enc(b.buildId)}` : `#/c/${enc(x.id)}`;
    return h(
      "li",
      { class: "link account-row", tabindex: 0, onclick: () => go(href), onkeydown: (e) => e.key === "Enter" && go(href) },
      appIcon(c, { size: 40, progress: lit, waiting: b && !lit }),
      h(
        "div",
        { class: "grow" },
        h("span", { class: "strong" }, x.name),
        h(
          "span",
          { class: "sub row tight wrap" },
          h("span", { class: `dot ${dot}` }),
          word.toLowerCase(),
          // What health@1 says about it ("The session ended on 12 October"), when it says more than the word.
          !b && x.health?.detail && [h("span", { class: "faint" }, "·"), h("span", { class: "clip-1 health-detail" }, x.health.detail)],
          !b && [h("span", { class: "faint" }, "·"), "used by", x.usedBy?.length ? x.usedBy.map((u) => capRef(all.get(u.id), u.id, { size: 18 })) : h("span", {}, "nothing yet")],
        ),
      ),
      action,
    );
  };
  const newOnes = building.filter((c) => !c.version).map((c) => ({ id: c.id, name: c.name, usedBy: [] }));
  page(
    "accounts",
    720,
    h("div", { class: "row between" }, h("h1", { class: "flush" }, "Accounts"), h("button", { onclick: () => addConnectionSheet() }, "Add a connection")),
    h("div", { class: "card list-card" }, h("ul", { class: "list" }, [...connections, ...newOnes].length ? [...connections, ...newOnes].map(row) : h("li", {}, h("span", { class: "grow muted" }, "No connections yet")))),
  );
  // While a connection builds, check every few seconds; redraw when a build starts or ends.
  const conns = () => [...all.values()].filter((c) => c.kind === "connection");
  const signature = (cs) => cs.map((c) => `${c.id}:${c.building?.buildId ?? ""}:${c.building?.step ?? ""}:${c.building?.tests?.passed ?? ""}:${c.version}`).join("|");
  const last = signature(conns());
  if (!conns().some((c) => c.building)) return;
  const poll = async () => {
    if (!location.hash.startsWith("#/accounts")) return;
    const now = [...(await caps(true).catch(() => new Map())).values()].filter((c) => c.kind === "connection");
    if (signature(now) !== last) return accountsPage();
    timer = setTimeout(poll, 2500);
  };
  let timer = setTimeout(poll, 2500);
  onLeave(() => clearTimeout(timer));
}

const SERVICES = ["Todoist", "Notion", "Ghost", "Strava", "Garmin"];

/** I3 Add a connection: name the service; the intake takes it from there, in connection mode. */
function addConnectionSheet() {
  return formSheet({
    title: "Add a connection",
    build: (close) => {
      const input = h("input", { type: "text", placeholder: "Which service?", "aria-label": "Which service?", autocomplete: "off" });
      const next = h("button", { class: "primary", type: "submit", disabled: true }, "Next");
      input.addEventListener("input", () => (next.disabled = !input.value.trim()));
      const submit = (e) => (e?.preventDefault(), input.value.trim() && (close(), go(`#/new?connection=${enc(input.value.trim())}`)));
      setTimeout(() => input.focus());
      return h(
        "form",
        { class: "stack-md", onsubmit: submit },
        h("label", { class: "field" }, h("span", { class: "label" }, "Service"), input),
        h("div", { class: "row tight wrap" }, SERVICES.map((s) => h("button", { type: "button", class: "chip plain", onclick: () => ((input.value = s), (next.disabled = false), input.focus()) }, s))),
        h("div", { class: "small faint" }, "It's built like a tool. You approve what it needs."),
        sheetActions(h("button", { type: "button", onclick: () => close() }, "Cancel"), next),
      );
    },
  });
}

// ---------- N4 Info / I2 connection page ----------

/** Text with the owner's tool names rendered as cap-refs. */
function richText(text, all, self) {
  const others = [...all.values()].filter((c) => c.id !== self && c.name.length > 2).sort((a, b) => b.name.length - a.name.length);
  if (!others.length || !text) return [text];
  const re = new RegExp(`(${others.map((c) => c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  return text.split(re).map((part) => {
    const c = others.find((x) => x.name === part);
    return c ? capRef(c) : part;
  });
}

/** A tool's status as pills: needs you, building or a failed build, the version, who built it, when. */
function statusPills(c, cap, all) {
  const latest = cap.versions[0];
  return h(
    "div",
    { class: "row tight wrap" },
    c.building
      ? h("a", { class: "pill accent with-dot", href: `#/b/${enc(c.building.buildId)}` }, buildingLabel(c.building).toLowerCase())
      : c.lastBuild?.status === "failed"
        ? h("a", { class: "pill danger with-dot", href: `#/b/${enc(c.lastBuild.buildId)}` }, "build failed")
        : cap.status.ready
          ? h("span", { class: "pill ok with-dot" }, "ready")
          : h("span", { class: "pill warn with-dot" }, "needs you"),
    latest && h("span", { class: "pill" }, `v${c.version ?? latest.version}`),
    latest && h("span", { class: "pill" }, `built by ${latest.builder === "agent" ? actorLabel(latest.requestedBy, all).replace(/^You$/, "you") : builderLabel(latest.builder)}`),
    latest && h("span", { class: "pill" }, ago(latest.createdAt)),
  );
}

async function infoPage(id) {
  view(backBar("Home", "#/"), h("main", { class: "column", style: { "--w": "760px" } }, skeleton("50%", "30%", "90%", "70%")));
  const [cap, all] = await Promise.all([api(`/capabilities/${enc(id)}`), caps(true)]);
  const c = all.get(id) ?? { id, name: cap.name, ui: !!cap.ui?.available, ready: cap.status.ready, kind: cap.kind };
  setWallpaper(await hues([tintOf(c)]));
  if (cap.kind === "connection") return connectionPage(c, cap, all);
  const ops = runnableOps(cap);
  const items = cap.authorization?.items ?? [];
  const uses = (cap.requires?.capabilities ?? []).map((u) => u.id);
  const usedBy = (cap.usedBy ?? []).map((u) => u.id);
  const name = h("span", {}, cap.name);
  const more = h("button", { "aria-label": "More", onclick: () => menuFrom(more, capabilityMenu(c, { rename: () => inlineRename(c, name) })) }, "•••");

  // "Change it" opens the tool with the drawer (P1) and sends the text.
  const ask = h("input", { type: "text", class: "bare", placeholder: `What should ${cap.name} also do?`, "aria-label": "Change it" });
  const composer = h(
    "form",
    { class: "card composer-card", onsubmit: (e) => (e.preventDefault(), ask.value.trim() && openChange(c, { m: ask.value.trim(), send: true })) },
    h("span", { class: "eyebrow accent" }, "Change it"),
    ask,
    h("button", { type: "submit", class: "primary lg" }, "Ask"),
  );

  // One list of rows, each opening its sheet or page.
  const infoRow = (label, value, onOpen, dot) =>
    h("li", { class: "link info-row", tabindex: 0, onclick: onOpen, onkeydown: (e) => e.key === "Enter" && onOpen() }, h("span", { class: "info-key" }, label), h("div", { class: "grow row tight" }, dot && h("span", { class: `dot ${dot}` }), h("span", { class: "muted clip-1" }, value)));
  const pendingN = items.filter((i) => !i.approved).length;
  const rows = h("ul", { class: "list" });
  const fill = async () => {
    const [scheds, home, m, instr] = await Promise.all([api("/schedules").catch(() => []), api("/home").catch(() => ({ layout: [], gallery: [] })), cap.requires?.model ? api("/models").catch(() => null) : null, api(`/capabilities/${enc(id)}/instructions`).catch(() => ({ lines: [] }))]);
    const mine = scheds.filter((x) => x.capabilityId === id);
    const paused = mine.filter((x) => x.status === "paused");
    const widgets = home.gallery.find((g) => g.capabilityId === id)?.widgets ?? [];
    const placed = home.layout.filter((e) => e.type === "widget" && e.id === id).length;
    const spent = m ? m.spend.rows.filter((r) => r.capabilityId === id).reduce((n, r) => n + r.costUsd, 0) : 0;
    const req = cap.requires?.model;
    const latest = cap.versions[0];
    put(
      rows,
      infoRow("Operations", ops.length ? `${ops.length} · ${ops.map((o) => o.name).join(", ")}` : "None", () => go(`#/run/${enc(id)}`)),
      infoRow("Allowed to", items.length ? `${items.length}${pendingN ? ` · ${pendingN} pending` : ""}` : "Nothing outside itself", () => grantsSheet(id).then(() => route()), pendingN ? "warn" : null),
      req && infoRow("Model", `${req.tier ? `${titleCase(req.tier)} tier` : req.model}${m ? ` · ${usd(spent)} this month` : ""}`, () => toolModelSheet(c).then((ok) => ok || route()), cap.status.retiredModel ? "danger" : cap.status.missingModel ? "warn" : null),
      infoRow("Schedules", mine.length ? [mine.filter((x) => x.status === "active").map((x) => cadenceText(x.cadence)).join(", "), paused.length ? `${paused.length} paused` : "", mine.some((x) => x.status === "proposed") ? "1 proposed" : ""].filter(Boolean).join(" · ") || "None" : "None", () => schedulesSheet(c, ops).then(() => route()), paused.some((x) => x.pausedReason) ? "danger" : mine.some((x) => x.status === "proposed") ? "warn" : null),
      infoRow("Widgets", widgets.length ? `${widgets.length} · ${placed} on Home` : "None", () => toolWidgetsSheet(c).then(() => route())),
      infoRow("Instructions", instr.lines.length ? `${plural(instr.lines.length, "rule")} for this tool` : "None · rules for every tool are under Settings › AI", () => instructionsSheet(c).then(() => route())),
      latest && infoRow("Versions", `v${c.version ?? latest.version} · ${ago(latest.createdAt)}`, () => versionsDialog(c)),
    );
  };
  fill();
  const connected = [...new Set([...uses, ...usedBy])];
  view(
    backBar("Home", "#/", h("div", { class: "glass-bar" }, more)),
    sandboxNotice(),
    h(
      "main",
      { class: "column info", style: { "--w": "760px" } },
      h(
        "div",
        { class: "info-head" },
        appIcon(c, { size: 72 }),
        h(
          "div",
          { class: "grow col" },
          h("h1", { class: "title-xl" }, name),
          h("div", { class: "muted row tight wrap" }, richText(cap.purpose, all, id), connected.length > 0 && [h("span", { class: "faint" }, "·"), uses.length ? "uses" : "used by", connected.map((x) => capRef(all.get(x), x))]),
        ),
        h("button", { class: "lg", onclick: () => openCapability(c).catch(fail) }, "Open"),
      ),
      statusPills(c, cap, all),
      composer,
      h("div", { class: "card list-card" }, rows),
    ),
  );
}

/**
 * I2 A connection's page: its health; Operations on the left (each opens the Run view, health shows
 * its last result); Used by and Settings (sign-in, its config as one form, one Save) on the right.
 */
async function connectionPage(c, cap, all) {
  const id = c.id;
  const name = h("span", {}, cap.name);
  const more = h("button", { "aria-label": "More", onclick: () => menuFrom(more, capabilityMenu(c, { rename: () => inlineRename(c, name) })) }, "•••");
  const ops = runnableOps(cap);
  const signIn = cap.operations.some((o) => o.name === "connect");
  const healthLine = h("div", { class: "muted row tight" }, skeleton("40%"));
  const healthRow = h("li", {}, h("div", { class: "grow" }, h("span", { class: "mono" }, "health"), h("span", { class: "sub" }, "Checking…")));
  const config = cap.authorization?.config ?? [];
  const inputs = config.map((x) => ({ x, input: h("input", { type: "text", value: x.value ?? "", placeholder: x.description, autocomplete: "off" }) }));
  const save = h("button", { class: "primary sm" }, "Save");
  save.addEventListener("click", async () => {
    try {
      save.disabled = true;
      for (const { x, input } of inputs) if (input.value !== (x.value ?? "")) await api(`/capabilities/${enc(id)}/config/${enc(x.name)}`, { method: "PUT", body: { value: input.value } });
      toast("Settings saved");
      route();
    } catch (e) {
      save.disabled = false;
      fail(e);
    }
  });
  const needsSetup = !cap.status.ready && (cap.status.pendingGrants.length || cap.status.missingConfig.length);
  view(
    backBar("Accounts", "#/accounts", h("div", { class: "glass-bar" }, h("a", { href: changeHref(c) }, "Change…"), more)),
    sandboxNotice(),
    h(
      "main",
      { class: "column info", style: { "--w": "900px" } },
      h(
        "div",
        { class: "info-head" },
        appIcon(c, { size: 64 }),
        h("div", { class: "grow col" }, h("h1", { class: "title-xl" }, name), healthLine),
        needsSetup && h("button", { class: "primary", onclick: () => grantsSheet(id).then(() => route()) }, "Set up"),
      ),
      h(
        "div",
        { class: "info-grid" },
        h(
          "div",
          { class: "card list-card" },
          h("div", { class: "eyebrow" }, "Operations"),
          h(
            "ul",
            { class: "list" },
            ops.filter((o) => o.name !== "health").map((op) => h("li", { class: "link", tabindex: 0, onclick: () => go(`#/run/${enc(id)}?op=${enc(op.name)}`), onkeydown: (e) => e.key === "Enter" && go(`#/run/${enc(id)}?op=${enc(op.name)}`) }, h("div", { class: "grow" }, h("span", { class: "mono" }, op.name), h("span", { class: "sub" }, op.description)), sidePill(op.sideEffect))),
            healthRow,
          ),
        ),
        h(
          "div",
          { class: "stack-md" },
          h("div", { class: "card connected" }, h("div", { class: "eyebrow" }, "Used by"), cap.usedBy?.length ? h("div", { class: "row tight wrap" }, cap.usedBy.map((u) => chip(all.get(u.id) ?? { id: u.id, name: u.name }, undefined, { href: `#/c/${enc(u.id)}` }))) : h("span", { class: "muted small" }, "Nothing yet")),
          (signIn || inputs.length > 0) &&
            h(
              "div",
              { class: "card settings-card" },
              signIn && h("div", { class: "setting" }, h("div", { class: "grow" }, h("span", {}, "Sign-in"), h("span", { class: "sub" }, cap.status.missingSecrets.length ? "Not signed in" : "Signed in")), h("button", { class: cap.status.missingSecrets.length ? "sm primary" : "sm", onclick: () => signInDialog(id).then((ok) => ok && route()) }, cap.status.missingSecrets.length ? "Sign in" : "Sign in again")),
              inputs.map(({ x, input }) => h("div", { class: "setting stacked" }, h("div", { class: "grow" }, h("span", { class: "mono" }, x.name), h("span", { class: "sub" }, x.description)), input)),
              inputs.length > 0 && h("div", { class: "row end settings-save" }, save),
            ),
        ),
      ),
    ),
  );
  api(`/capabilities/${enc(id)}/health`)
    .then((hl) => {
      const [dot, word] = HEALTH[hl.status] ?? ["warn", hl.status];
      put(healthLine, h("span", { class: `dot ${dot}` }), `${word} · checked ${ago(hl.checkedAt)}`, hl.detail && h("span", { class: "faint clip-1" }, ` · ${hl.detail}`));
      put(healthRow, h("div", { class: "grow" }, h("span", { class: "mono" }, "health"), h("span", { class: "sub" }, `Checked ${ago(hl.checkedAt)}${hl.detail ? ` · ${hl.detail}` : ""}`)), h("span", { class: `pill ${dot}` }, hl.status === "connected" ? "ok" : word.toLowerCase()));
    })
    .catch((e) => put(healthLine, h("span", { class: "dot danger" }), e.message));
}

// ---------- B1 / G: the intake (a page, or a component in the change drawer) and the proposal card ----------

const slug = (s) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** #/new: the intake as a moment screen. `?connection=<service>` asks for a connection only. */
async function intakePage(q) {
  const service = q.get("connection");
  setWallpaper(await hues(service ? [260, 200] : [125, 250]));
  const intake = intakeView({ mode: "create", q, connection: service, onBuilt: (b) => go(`#/b/${enc(b.buildId)}`) });
  view(...moment({ right: "-20px", top: "60px" }, backBar(service ? "Accounts" : "Home", service ? "#/accounts" : "#/"), h("div", { class: "moment-col" }, intake.el)));
  intake.focus();
}

/**
 * The intake conversation. `mode` "create" (a new tool, or a connection) or "modify" (a change to
 * `cap`, in the drawer). Every reply that proposes something is one proposalCard; an earlier
 * proposal collapses to a line when a revised one arrives (G3). `onBuilt(build)` after a build starts.
 */
function intakeView({ mode, cap, q, embedded = false, connection = null, onBuilt }) {
  const capId = cap?.id;
  let all = new Map();
  caps().then((m) => (all = m)).catch(() => {});
  const widgetParam = q?.get("widget");
  const widgetsMode = widgetParam === "new";
  let focus = null;
  const messages = [];
  const thread = h("div", { class: "thread", "aria-live": "polite" });
  // Picking up an earlier conversation ("Continue from here" on a version, or the card on a change):
  // its turns show at the top as they were (proposals as cards), and go to the intake as context.
  let from = q?.get("from") || null;
  const earlierEl = h("div", { class: "thread earlier", hidden: true });
  thread.prepend(earlierEl);
  const continueFrom = async (buildId) => {
    from = buildId;
    // The cards name the tools a draft uses, so the map comes first.
    const [b, ctx, m] = await Promise.all([api(`/builds/${enc(buildId)}`), api(`/builds/${enc(buildId)}/context`), caps().catch(() => all)]);
    all = m;
    put(earlierEl, h("div", { class: "small faint earlier-label" }, `Earlier · the conversation that made v${b.resultVersion ?? "?"}`), conversationNodes(ctx.conversation ?? [], { mode: b.kind === "create" ? "create" : "modify", cap, all, version: b.resultVersion }));
    earlierEl.hidden = false;
  };
  if (from) continueFrom(from).catch(fail);
  // A change to a tool with a conversation behind it: a card in the chat offers to pick it up.
  const offer = h("div", { class: "card continue-card", hidden: true });
  thread.append(offer);
  if (mode === "modify" && capId && !from && !widgetsMode) {
    api(`/capabilities/${enc(capId)}`)
      .then(async (d) => {
        const last = d.versions?.find((v) => v.buildId);
        const ctx = last ? await api(`/builds/${enc(last.buildId)}/context`).catch(() => ({})) : {};
        if (!ctx.conversation?.length) return;
        put(
          offer,
          h("div", { class: "continue-title" }, "Continue the last conversation?"),
          h("div", { class: "small muted" }, `The chat that made v${last.version} comes along, so you don't explain the tool again.`),
          h("div", { class: "row tight continue-actions" }, h("button", { type: "button", class: "sm primary", onclick: () => (offer.remove(), continueFrom(last.buildId).catch(fail)) }, "Continue"), h("button", { type: "button", class: "sm ghost", onclick: () => offer.remove() }, "Start fresh")),
        );
        offer.hidden = false;
      })
      .catch(() => {});
  }
  // Grows with the text; Enter sends, Shift+Enter for a new line.
  const input = h("textarea", {
    class: "composer-input",
    rows: embedded ? 3 : 1,
    placeholder: connection ? `What should your tools do with ${connection}?` : mode === "create" ? "Track my coffee beans and how I rated each brew" : widgetsMode ? "The next word to practise, with buttons to grade it" : "e.g. show pace per km in the table",
    "aria-label": "Message",
  });
  input.value = q?.get("m") || (widgetsMode ? "Suggest some widgets." : connection ? `A connection to ${connection}, so my tools can use it.` : "");
  const grow = () => ((input.style.height = "auto"), (input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`));
  input.addEventListener("input", grow);
  // Text put in for you ("Ask builder to fix this"): tall enough to read it whole, once it's on screen.
  let tries = 0;
  const growWhenShown = () => (input.offsetParent ? grow() : ++tries < 120 && requestAnimationFrame(growWhenShown));
  if (input.value) requestAnimationFrame(growWhenShown);
  window.addEventListener("resize", grow);
  onLeave(() => window.removeEventListener("resize", grow));
  input.addEventListener("keydown", (e) => e.key === "Enter" && !e.shiftKey && !e.isComposing && (e.preventDefault(), composer.requestSubmit()));
  const send = h("button", { type: "submit", class: embedded ? "" : "lg" }, "Send");
  // One box: the message, then the model it builds with (Settings › AI, changeable right here) and Send.
  // One session id for the conversation.
  const session = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // After a round of questions: the owner's way to stop them and get a draft on the intake's assumptions.
  const draftNow = h("button", { type: "button", class: "ghost sm", hidden: true, onclick: () => ((input.value = "Draft it now with your assumptions, and list them."), composer.requestSubmit()) }, "Draft now");
  // Images and files for the request: pasted, dropped or attached; uploaded as they're added, sent as refs.
  const pending = [];
  const chips = h("div", { class: "attachments", hidden: true });
  const picker = h("input", { type: "file", multiple: true, accept: "image/*,text/*,.csv,.json,.md,.txt,.yaml,.yml,.toml,.sql,.js,.ts,.py,.sh,.html,.css", hidden: true, "aria-label": "Files to attach" });
  const attach = h("button", { type: "button", class: "ghost sm", onclick: () => picker.click() }, "Attach");
  const syncChips = () => ((chips.hidden = !pending.length), put(chips, pending.map((a) => attachmentChip(a, () => (pending.splice(pending.indexOf(a), 1), syncChips())))), syncSend());
  // Per message: up to 5 images and 10 files (Hewn checks the same as the message is sent).
  const perMessage = { image: 5, file: 10 };
  const addFiles = async (files) => {
    for (const f of files) {
      const kind = /^image\//.test(f.type) ? "image" : "file";
      if (pending.filter((a) => a.kind === kind).length >= perMessage[kind]) {
        fail(new Error(`Up to ${perMessage[kind]} ${kind}s per message`));
        continue;
      }
      try {
        pending.push(await uploadAttachment(f, session));
        syncChips();
      } catch (e) {
        fail(e);
      }
    }
  };
  picker.addEventListener("change", () => (addFiles([...picker.files]), (picker.value = "")));
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) (e.preventDefault(), addFiles(files));
  });
  const composer = h("form", { class: "composer boxed" }, chips, input, h("div", { class: "composer-tools" }, attach, picker, draftNow, modelChip(), send));
  composer.addEventListener("dragover", (e) => (e.preventDefault(), composer.classList.add("drop")));
  composer.addEventListener("dragleave", () => composer.classList.remove("drop"));
  composer.addEventListener("drop", (e) => (e.preventDefault(), composer.classList.remove("drop"), addFiles([...(e.dataTransfer?.files ?? [])])));
  composer.prepend(offer);
  const heading = embedded
    ? h("div", { class: "drawer-title" }, widgetsMode ? "What should its widgets show?" : "What should change?")
    : h("div", { class: "stack-sm" }, h("div", { class: "eyebrow" }, connection ? "New connection" : "New tool"), h("div", { class: "display" }, connection ? `Connect ${connection}` : "What should it do?"));
  const el = embedded ? h("div", { class: "drawer-intake" }, heading, thread, composer) : h("div", { class: "stack-lg" }, heading, h("div", { class: "chat-col" }, thread, composer));
  const say = (who, text, attachments) => thread.append(h("div", { class: `bubble ${who}` }, text, attachmentsView(attachments)));
  const syncSend = () => send.classList.toggle("primary", !!input.value.trim() || pending.length > 0);
  input.addEventListener("input", syncSend);
  syncSend();

  let latest = null;
  /** A new proposal: the one before it collapses to one line that can be opened again. */
  const showProposal = (card, summary) => {
    if (latest) {
      const old = latest;
      old.card.classList.add("superseded");
      old.card.querySelectorAll("button, input").forEach((b) => (b.disabled = true));
      old.card.hidden = true;
      const line = h("button", { class: "earlier-proposal link small" }, `Earlier proposal · ${old.summary} · replaced ▸`);
      line.addEventListener("click", () => ((old.card.hidden = !old.card.hidden), (line.textContent = `Earlier proposal · ${old.summary} · replaced ${old.card.hidden ? "▸" : "▾"}`)));
      old.card.before(line);
    }
    latest = { card, summary };
    thread.append(card);
    card.scrollIntoView({ block: "nearest" });
  };
  const keepTalking = () => input.focus();

  const ask = async (e) => {
    e?.preventDefault();
    const text = input.value.trim();
    // One turn at a time: the box is disabled while the intake answers (Draft now submits through here too).
    if (!text || input.disabled) return;
    // A message may be attachments alone ("like this", with a screenshot).
    if (!text && !pending.length) return;
    // Text put in from the address (m=, "Ask builder to fix this") is sent: a redraw mustn't put it back.
    const [path, qs = ""] = location.hash.split("?");
    const params = new URLSearchParams(qs);
    if (params.has("m")) {
      params.delete("m");
      params.delete("send");
      history.replaceState(null, "", `${path}${params.size ? `?${params}` : ""}`);
    }
    if (focus === null && widgetParam && !widgetsMode && capId) focus = ((await api(`/capabilities/${enc(capId)}`).catch(() => null))?.widgets ?? []).find((w) => w.name === widgetParam) ?? false;
    // What was attached goes with this turn, as refs (the bytes are already up).
    const attachments = pending.splice(0).map(({ ref, kind, name, mediaType, bytes, width, height }) => ({ ref, kind, name, mediaType, bytes, width, height }));
    syncChips();
    messages.push({ role: "user", content: text, ...(attachments.length ? { attachments } : {}) });
    heading.hidden = embedded;
    offer.remove();
    say("me", text, attachments);
    input.value = "";
    input.placeholder = ""; // the example is for an empty conversation
    grow();
    syncSend();
    const typing = h("div", { class: "bubble them typing", role: "status", "aria-label": "Thinking" }, h("i"), h("i"), h("i"));
    const activity = h("div", { class: "small faint intake-activity" });
    const live = h("div", { class: "thread" });
    thread.append(live, typing, activity);
    input.disabled = true;
    draftNow.disabled = true;
    // While it answers, Send is Stop: the request closes and the intake stops.
    const stop = new AbortController();
    const stopBtn = h("button", { type: "button", class: `stop-btn ${embedded ? "" : "lg"}`, "aria-label": "Stop", title: "Stop", onclick: () => stop.abort() }, h("span", { class: "stop-square", "aria-hidden": "true" }));
    send.replaceWith(stopBtn);
    const showProgress = (p) => {
      if (p.activity) activity.textContent = `${p.activity}…`;
      if (p.message === undefined && p.questions === undefined) return;
      activity.textContent = "";
      put(live, p.message || p.questions?.length ? h("div", { class: "bubble them" }, chatText(p.message, p.questions)) : null);
    };
    try {
      let reply = null;
      let failure = null;
      await postStream("/intake", (name, data) => (name === "progress" ? showProgress(data) : name === "reply" ? (reply = data) : name === "error" && (failure = data.message)), { mode, capabilityId: capId, ...(focus ? { widget: focus.name } : {}), messages, session, ...(from ? { earlier: { buildId: from } } : {}) }, stop.signal);
      if (failure || !reply) throw new Error(failure ?? "The intake didn't answer");
      typing.remove();
      live.remove();
      activity.remove();
      // Questions come as one message, with the questions as a list; a proposal's message sits above its card.
      if (reply.message && reply.kind !== "questions") say("them", reply.message);
      draftNow.hidden = reply.kind !== "questions";
      // What it remembered (or dropped) for later builds: shown as saved, with Undo.
      for (const [what, list] of [["remember", reply.saved?.remember ?? []], ["forget", reply.saved?.forget ?? []]]) for (const x of list) thread.append(memoryNotice(what, x, cap));
      const nextVersion = capId ? await api(`/capabilities/${enc(capId)}`).then((d) => Math.max(0, ...d.versions.map((v) => v.version)) + 1).catch(() => null) : null;
      const ctx = { mode, cap, all, connection, keepTalking, onBuilt, embedded, nextVersion, messages, done: (text) => thread.append(h("div", { class: "notice ok" }, h("span", {}, text))) };
      if (reply.kind === "questions") {
        messages.push({ role: "intake", content: [reply.message, ...reply.questions].filter(Boolean).join("\n"), reply });
        say("them", chatText(reply.message, reply.questions));
      } else if (reply.kind === "widgets") {
        // Remembered as text, so a follow-up ("make the second one bigger") can refer to them.
        messages.push({ role: "intake", content: [reply.message, ...reply.proposals.map((p, i) => `${i + 1}. ${p.title} (${p.template}; ${p.sizes.join(", ")}${p.replaces ? `; replaces ${p.replaces}` : ""}): ${p.shows}`)].filter(Boolean).join("\n"), reply });
        if (!reply.proposals.length) say("them", "No widgets to suggest for this. Say what you'd like to see.");
        else showProposal(...proposalCard("widgets", reply.proposals, ctx));
      } else if (reply.kind === "ideas") {
        // Remembered in full, so "build the first two" or "make #3 simpler" revises them rather than starting over.
        messages.push({ role: "intake", content: [reply.message, `IDEAS\n${reply.ideas.map((d, i) => `${i + 1}. ${draftText(d)}`).join("\n\n")}`].filter(Boolean).join("\n\n"), reply });
        showProposal(...proposalCard("ideas", reply.ideas, ctx));
      } else if (reply.kind === "schedules") {
        messages.push({ role: "intake", content: [reply.message, `SCHEDULES\n${scheduleText(reply.schedules)}`].filter(Boolean).join("\n\n"), reply });
        showProposal(...proposalCard("schedules", reply.schedules, ctx));
      } else {
        // The whole draft, so "Keep talking" changes it instead of starting over.
        messages.push({ role: "intake", content: [reply.message, `DRAFT\n${draftText(reply.draft)}`].filter(Boolean).join("\n\n"), reply });
        showProposal(...proposalCard("draft", [reply.draft], ctx));
      }
    } catch (err) {
      typing.remove();
      live.remove();
      activity.remove();
      if (stop.signal.aborted) {
        // Stopped: the message goes back in the composer, out of the conversation.
        messages.pop();
        thread.lastElementChild?.classList.contains("me") && thread.lastElementChild.remove();
        input.value = text;
        thread.append(h("div", { class: "small faint" }, "Stopped."));
        return;
      }
      thread.append(errorBox(err));
      // Widgets don't need the intake: the builder can still make what was asked (or pick itself).
      if (widgetsMode) thread.append(h("div", { class: "row tight" }, h("button", { onclick: () => buildWidgets(cap, /^suggest some widgets\.?$/i.test(text) ? "" : text, messages).then(onBuilt, fail) }, "Build without suggestions")));
    } finally {
      stopBtn.replaceWith(send);
      input.disabled = false;
      draftNow.disabled = false;
      syncSend();
      grow();
      input.focus();
    }
  };
  composer.addEventListener("submit", ask);
  // Opened with text to send (Info's "Change it", the first run, a new widget), send it.
  if ((q?.get("send") === "1" || widgetsMode || connection) && input.value.trim()) setTimeout(ask);
  return {
    el,
    focus: () => (input.focus(), grow()),
    setText: (t) => ((input.value = t), syncSend(), input.focus(), grow()),
  };
}

/** The intake's message and its questions as one chat message: paragraphs, the questions numbered. */
const chatText = (message, questions) => [message, ...(questions ?? []).filter(Boolean).map((q, i) => `${i + 1}. ${q}`)].filter(Boolean).join("\n\n");

/** Start a widgets build (only widgets change). `conversation`: the chat that led to it, kept with the build. */
const buildWidgets = (cap, request, conversation) => api(`/capabilities/${enc(cap.id)}/widgets`, { method: "POST", body: { ...(request ? { request } : {}), ...(conversation?.length ? { conversation } : {}) } });

/**
 * In the intake's chat box: the model building runs on, and its menu, like a chat app's. It is the
 * Settings › AI choice, changed right here: the current model, an effort slider, then the other
 * models (and a full name).
 */
function modelChip() {
  const name = h("span", {}, "Model");
  const effortEl = h("span", { class: "faint" });
  const chip = h("button", { type: "button", class: "ghost sm model-chip", "aria-haspopup": "menu", title: "Model for building (Settings › AI)" }, name, effortEl, h("span", { class: "caret", "aria-hidden": "true" }));
  let ctx = null;
  let menu = null;
  const cap = (x) => (x ? x[0].toUpperCase() + x.slice(1) : "");
  const load = async () => {
    const s = await api("/settings");
    ctx = { s, bCat: await api(`/tools/${enc(s.builder)}/models`) };
    return ctx;
  };
  const labelOf = (cat, id) => cat?.models.find((m) => m.id === (id ?? "default"))?.label ?? id ?? "Default";
  const paint = () => {
    const m = jobModelOf(ctx.s, "builder");
    name.textContent = labelOf(ctx.bCat, m.model);
    effortEl.textContent = cap(m.effort);
  };
  load().then(paint).catch(() => (chip.hidden = true));

  /** Save the builder's model and effort. In order: a slider moved right after a model pick must not write over it. */
  let saving = Promise.resolve();
  const save = (change) => (saving = saving.then(() => saveNow(change)));
  const saveNow = async (change) => {
    try {
      ctx.s = await saveBuildModel(ctx.s, ctx.s.builder, { ...jobModelOf(ctx.s, "builder"), ...change });
      paint();
    } catch (e) {
      fail(e);
    }
  };
  const row = (main, sub, { checked = false, onClick } = {}) =>
    h(
      "button",
      { type: "button", role: "menuitemradio", "aria-checked": String(checked), class: "mm-row", onclick: (e) => (e.stopPropagation(), onClick?.()) },
      h("span", { class: "grow col" }, h("span", {}, main), sub && h("span", { class: "sub" }, sub)),
      checked && h("span", { class: "model-tick", "aria-hidden": "true" }, "✓"),
    );
  /** The current model, the effort slider, then the other models. */
  const section = (cat) => {
    const cur = jobModelOf(ctx.s, "builder");
    const curId = cur.model ?? "default";
    const curModel = cat.models.find((m) => m.id === curId) ?? { id: curId, label: curId, description: "A model by its full name" };
    const efforts = curModel.efforts ?? cat.models[0]?.efforts ?? [];
    const others = cat.models.filter((m) => m.id !== curId);
    // The slider: Default (the model's own), then its levels in order.
    const stops = [undefined, ...efforts];
    const value = h("span", { class: "faint" });
    const slider = h("input", { type: "range", min: 0, max: stops.length - 1, step: 1, value: Math.max(0, stops.indexOf(cur.effort)), "aria-label": "Effort", class: "effort-slider" });
    const show = () => (value.textContent = stops[slider.value] ? cap(stops[slider.value]) : curModel.defaultEffort ? `Default (${curModel.defaultEffort})` : "Default");
    show();
    slider.addEventListener("input", show);
    slider.addEventListener("change", () => save({ effort: stops[slider.value] }));
    const pick = (id) => save({ model: id, effort: cur.effort && (cat.models.find((m) => m.id === id)?.efforts ?? []).includes(cur.effort) ? cur.effort : undefined }).then(render);
    const other = !cat.other ? null : h("input", { type: "text", class: "mono sm", placeholder: cat.otherHint ? `Another: ${cat.otherHint}` : "Another model, by name", "aria-label": "Another model, by name" });
    other?.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), other.value.trim() && pick(other.value.trim())));
    // A model that failed lately says so (the list can't tell on its own).
    const sub = (m) => [m.description, m.failed && `didn't run ${ago(m.failed.at)}: ${m.failed.reason}`].filter(Boolean).join(" · ");
    return [
      row(curModel.label, sub(curModel), { checked: true }),
      efforts.length > 0 && h("label", { class: "mm-effort" }, h("span", { class: "row between" }, h("span", {}, "Effort"), value), slider),
      others.length > 0 && h("hr"),
      others.map((m) => row(m.label, sub(m), { onClick: () => pick(m.id) })),
      other && h("div", { class: "mm-other" }, other),
    ];
  };
  const render = () => {
    if (!menu) return;
    put(menu, section(ctx.bCat));
    place();
  };
  /** Fixed to the viewport, next to the chip, never off screen (the drawer is narrow and near the edge). */
  const place = () => {
    const r = chip.getBoundingClientRect();
    const w = Math.min(380, innerWidth - 16);
    menu.style.width = `${w}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    const below = innerHeight - r.bottom - 14;
    const above = r.top - 14;
    menu.style.maxHeight = "";
    const hgt = menu.getBoundingClientRect().height;
    const up = hgt > below && above > below;
    const room = Math.max(160, up ? above : below);
    menu.style.maxHeight = `${room}px`;
    menu.style.top = up ? `${Math.max(8, r.top - 6 - Math.min(hgt, room))}px` : `${r.bottom + 6}px`;
  };
  const close = () => {
    menu?.remove();
    menu = null;
    chip.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", outside, true);
    document.removeEventListener("keydown", onKey, true);
    removeEventListener("resize", close);
    removeEventListener("blur", close);
  };
  const outside = (e) => menu && !menu.contains(e.target) && !chip.contains(e.target) && close();
  const onKey = (e) => e.key === "Escape" && (e.stopPropagation(), close(), chip.focus());
  chip.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (menu) return close();
    try {
      await load();
    } catch (err) {
      return fail(err);
    }
    menu = h("div", { class: "menu model-menu", role: "menu" });
    document.body.append(menu);
    chip.setAttribute("aria-expanded", "true");
    render();
    menu.querySelector("input[type=range], button")?.focus();
    document.addEventListener("click", outside, true);
    document.addEventListener("keydown", onKey, true);
    addEventListener("resize", close);
    // A click in a tool (its own frame) never reaches this page; the page losing focus to it does.
    addEventListener("blur", close);
  });
  onLeave(close);
  return chip;
}

const scheduleText = (list) => list.map((x) => `- ${x.operation} ${x.cadence}${x.why ? ` (${x.why})` : ""}`).join("\n");


/** Attachments as a message shows them: thumbnails, file names. */
const attachmentsView = (list) => (list?.length ? h("div", { class: "attachments" }, list.map((a) => attachmentChip(a))) : null);

/** One attachment: a thumbnail or the file's name, and (in the box, before sending) × to drop it. */
const attachmentChip = (a, onRemove) =>
  h(
    "span",
    { class: "attachment" },
    a.kind === "image" ? h("img", { src: `/api/attachments/${enc(a.ref)}`, alt: a.name, title: a.name }) : h("span", { class: "file-chip", title: a.name }, a.name),
    onRemove && h("button", { type: "button", class: "x", "aria-label": `Remove ${a.name}`, onclick: onRemove }, "×"),
  );

/**
 * Upload one pasted, dropped or picked file for the request: an image is resized first (long side
 * at most 1568 px, what the models read well), a text file goes as it is. Resolves the attachment
 * (its ref and what it is) once Hewn has it.
 */
async function uploadAttachment(file, session) {
  const image = /^image\//.test(file.type);
  if (!image && file.size > 256 * 1024) throw new Error(`${file.name}: a file may be at most 256 KB`);
  const blob = image ? await resizeImage(file) : file;
  if (image && blob.size > 2 * 1024 * 1024) throw new Error(`${file.name || "The image"} is too large even after resizing`);
  const data = await new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] ?? "");
    r.onerror = () => no(r.error);
    r.readAsDataURL(blob);
  });
  return api("/attachments", { method: "POST", body: { session, kind: image ? "image" : "file", name: file.name || (image ? "pasted.png" : "pasted.txt"), mediaType: image ? blob.type : file.type || "text/plain", data } });
}

/**
 * A pasted or dropped image no bigger than the models read well: long side at most 1568 px. One
 * already within that (and a type Hewn takes) goes as it is, a GIF's animation included; one that
 * needs shrinking, or another type, is redrawn as PNG (JPEG stays JPEG).
 */
async function resizeImage(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error(`${file.name || "The image"} can't be read`);
  const scale = Math.min(1, 1568 / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) && file.size <= 2 * 1024 * 1024) return (bitmap.close?.(), file);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const type = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
  return new Promise((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error("couldn't read the image"))), type, 0.9));
}

/**
 * "Got what you asked for?", asked once as a toast when a tool is opened after a build went live
 * (its newest version's build, within a week, no answer yet): Yes, Not quite (which opens the
 * change drawer, so what's off becomes the next change), or × to skip. The answer stays in your
 * Hewn; nothing is sent anywhere.
 */
async function askFeedbackOnOpen(c, drawerApi) {
  const d = await api(`/capabilities/${enc(c.id)}`).catch(() => null);
  const last = d?.versions?.find((v) => v.buildId);
  if (!last || Date.now() - Date.parse(last.createdAt) > 7 * 86400_000) return;
  const ctx = await api(`/builds/${enc(last.buildId)}/context`).catch(() => null);
  if (!ctx || ctx.feedback) return;
  // Once per version in this browser: ignoring it is an answer too.
  const askedKey = `hewn.asked.${c.id}`;
  if (localStorage.getItem(askedKey) === String(last.version)) return;
  localStorage.setItem(askedKey, String(last.version));
  let region = document.querySelector(".toast-region");
  if (!region) document.body.append((region = h("div", { class: "toast-region", role: "status", "aria-live": "polite" })));
  // An answer that didn't reach Hewn is asked for again next time.
  const send = (score) =>
    api(`/builds/${enc(last.buildId)}/feedback`, { method: "POST", body: { score } }).catch((e) => {
      localStorage.removeItem(askedKey);
      throw e;
    });
  const el = h("div", { class: "toast feedback-toast" });
  const gone = () => el.remove();
  put(
    el,
    h("span", { class: "dot info" }),
    h("span", {}, `v${last.version} · got what you asked for?`),
    h("button", { class: "link sm", onclick: () => send("yes").then(() => (gone(), toast("Noted.")), fail) }, "Yes"),
    h("button", { class: "link sm", onclick: () => send("no").then(() => (gone(), drawerApi.open?.()), fail) }, "Not quite"),
    h("button", { class: "ghost sm icon-only", "aria-label": "Skip", title: "Skip", onclick: () => send("skip").then(gone, fail) }, "×"),
  );
  region.append(el);
  onLeave(gone);
}
/**
 * The reply an intake turn kept as text only was (conversations from before replies were kept):
 * the message, then the draft, ideas, schedules or widgets as `draftText` and friends wrote them.
 * The summary pills (operations, widgets, model) weren't written down, so the card goes without.
 */
function legacyReply(content, mode) {
  const m = /^([^]*?)(?:^|\n\n)(DRAFT|IDEAS|SCHEDULES)\n([^]*)$/.exec(content ?? "");
  if (m) {
    const message = m[1].trim();
    if (m[2] === "SCHEDULES") return { kind: "schedules", message, schedules: parseSchedules(m[3]) };
    if (m[2] === "DRAFT") return { kind: "draft", message, draft: parseDraft(m[3], mode) };
    // Ideas are numbered, a blank line apart, each starting "Name: purpose"; a numbered list inside one stays with it.
    const ideas = [];
    for (const part of m[3].split(/\n\n(?=\d+\. [^\n:]{1,80}: )/)) {
      if (part.startsWith(`${ideas.length + 1}. `) || !ideas.length) ideas.push(part.replace(/^\d+\. /, ""));
      else ideas[ideas.length - 1] += `\n\n${part}`;
    }
    return { kind: "ideas", message, ideas: ideas.map((s) => parseDraft(s, "create")) };
  }
  // Widgets: "1. Title (template; sizes[; replaces name]): shows" lines after the message.
  const lines = (content ?? "").split("\n");
  const numbered = lines.filter((l) => /^\d+\. /.test(l));
  const proposals = numbered.map((l) => /^\d+\. (.+?) \((\w+); ([a-z, ]+?)(?:; replaces (.+?))?\): ([^]*)$/.exec(l)).filter(Boolean);
  if (!proposals.length || proposals.length !== numbered.length) return null;
  return { kind: "widgets", message: lines.filter((l) => !/^\d+\. /.test(l)).join("\n").trim(), proposals: proposals.map(([, title, template, sizes, replaces, shows]) => ({ title, template, sizes: sizes.split(", "), ...(replaces ? { replaces } : {}), shows })) };
}
const parseSchedules = (text) =>
  text
    .split("\n")
    .map((l) => /^- (\S+) (.*?)(?: \((.*)\))?$/.exec(l))
    .filter(Boolean)
    .map(([, operation, cadence, why]) => ({ operation, cadence, ...(why ? { why } : {}) }));
/** `draftText` read back: name + purpose (a create), the spec, the connection step, the schedules. */
function parseDraft(text, mode) {
  const d = {};
  let rest = text;
  const sched = /\nSchedules:\n((?:- .*(?:\n|$))+)$/.exec(rest);
  if (sched) {
    d.schedules = parseSchedules(sched[1]);
    rest = rest.slice(0, sched.index);
  }
  const conn = /\nFirst (builds|changes) the connection ([^:\n]+): ([^]*)$/.exec(rest);
  if (conn) {
    const [head, ...body] = conn[3].split("\n");
    d.connection = conn[1] === "builds" ? { mode: "create", name: conn[2], purpose: head, requirements: body.join("\n") } : { mode: "modify", capabilityId: conn[2], request: conn[3] };
    rest = rest.slice(0, conn.index);
  }
  const named = mode !== "modify" && /^([^\n:]{1,80}): (.*)\n?/.exec(rest);
  if (named) {
    d.name = named[1];
    d.purpose = named[2];
    rest = rest.slice(named[0].length);
  }
  if (mode === "modify") d.request = rest;
  else d.requirements = rest;
  return d;
}

/**
 * A kept conversation (what led to a build), as the chat looked: the owner's turns, the intake's
 * questions, and its proposals as the cards they were (read-only). `ctx`: { mode, cap, all } for the cards.
 */
const conversationThread = (turns, ctx = {}) => h("div", { class: "thread kept" }, conversationNodes(turns, ctx));
const conversationNodes = (turns, ctx = {}) =>
  turns.map((t) => {
    // A turn kept as text only (from before replies were kept) is read back into the reply it was.
    const r = t.role === "intake" ? (t.reply ?? legacyReply(t.content, ctx.mode)) : null;
    if (r?.kind === "questions") return h("div", { class: "bubble them" }, [r.message, ...(r.questions ?? []).map((q, i) => `${i + 1}. ${q}`)].filter(Boolean).join("\n\n"));
    const list = r?.kind === "draft" ? [r.draft] : r?.kind === "ideas" ? r.ideas : r?.kind === "widgets" ? r.proposals : r?.kind === "schedules" ? r.schedules : null;
    if (list?.length && "cap" in ctx) {
      const mode = ctx.mode ?? (r.kind === "draft" && r.draft?.name ? "create" : "modify");
      const card = proposalCard(r.kind, list, { mode, cap: ctx.cap ?? null, all: ctx.all ?? new Map(), connection: null, keepTalking: () => {}, onBuilt: () => {}, embedded: true, messages: [], done: () => {}, nextVersion: ctx.version, readOnly: true })[0];
      return [r.message && h("div", { class: "bubble them" }, r.message), card];
    }
    return h("div", { class: `bubble ${t.role === "user" ? "me" : "them"}` }, t.content, attachmentsView(t.attachments));
  });

/** A draft (or one idea) in full, as the intake's own turn in the conversation. */
const draftText = (d) =>
  [
    d.name && `${d.name}: ${d.purpose}`,
    d.requirements ?? d.request,
    d.connection && (d.connection.mode === "create" ? `First builds the connection ${d.connection.name}: ${d.connection.purpose}\n${d.connection.requirements}` : `First changes the connection ${d.connection.capabilityId}: ${d.connection.request}`),
    d.schedules?.length && `Schedules:\n${scheduleText(d.schedules)}`,
  ]
    .filter(Boolean)
    .join("\n");

/** Suggested schedules, ticked: leaving one ticked is the owner's approval. */
function scheduleTicks(list = []) {
  const rows = list.map((x) => ({ x, box: h("input", { type: "checkbox", checked: true }) }));
  const el = rows.length > 0 && h("div", { class: "schedule-ticks col" }, rows.map(({ x, box }) => h("label", { class: "check small" }, box, h("span", {}, `${x.operation} · ${cadenceText(x.cadence)}`, x.why && h("span", { class: "faint" }, ` · ${x.why}`)))));
  return { el, chosen: () => rows.filter((r) => r.box.checked).map(({ x }) => ({ operation: x.operation, cadence: x.cadence })), set: (on) => rows.forEach((r) => (r.box.disabled = !on)) };
}

/**
 * Start a draft's build: its connection first, then the draft waiting for it. `connections` spans a
 * batch, so drafts sharing a connection build it once (or change it one after another). `after`: a
 * build the draft (and its connection) waits for too. `schedules`: the ones the owner left ticked,
 * set up once the draft's build promotes. `conversation`: the chat that led here, kept with each build.
 */
async function startDraft(mode, d, cap, { connections = new Map(), after, schedules = [], conversation } = {}) {
  const keep = conversation?.length ? { conversation } : {};
  const conn = d.connection;
  let first = null;
  if (conn) {
    const key = conn.mode === "create" ? `new:${slug(conn.name)}` : conn.capabilityId;
    const prev = connections.get(key);
    const wait = after ?? prev?.buildId;
    first =
      conn.mode === "create"
        ? prev ?? (await api("/capabilities", { method: "POST", body: { name: conn.name, purpose: conn.purpose, requirements: conn.requirements, kind: "connection", ...(after ? { after } : {}), ...keep } }))
        : await api(`/capabilities/${enc(conn.capabilityId)}/modify`, { method: "POST", body: { request: conn.request, ...(wait ? { after: wait } : {}), ...keep } });
    connections.set(key, first);
  }
  const wait = first?.buildId ?? after;
  const w = { ...(wait ? { after: wait } : {}), ...(schedules.length ? { schedules } : {}), ...keep };
  return mode === "create" ? api("/capabilities", { method: "POST", body: { name: d.name, purpose: d.purpose, requirements: d.requirements, ...w } }) : api(`/capabilities/${enc(cap.id)}/modify`, { method: "POST", body: { request: d.request, ...w } });
}

/** The id the platform gives a new tool with this name (the intake names ideas it builds on this way). */
const capabilityId = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * The order to start ideas in, and what each waits for. Ideas that build on another idea (it's in
 * their `uses`) start after it; the rest start side by side. A build waits for one build only, so
 * when an idea needs two that aren't built yet (two ideas, or an idea and its connection) the
 * whole batch runs one after another.
 */
function buildPlan(ideas) {
  const ids = new Set(ideas.map((d) => capabilityId(d.name)));
  const needs = (d) => (d.spec?.uses ?? []).filter((u) => ids.has(u) && u !== capabilityId(d.name));
  const order = [];
  const visit = (d, path = new Set()) => {
    if (order.includes(d) || path.has(d)) return;
    path.add(d);
    for (const u of needs(d)) visit(ideas.find((x) => capabilityId(x.name) === u), path);
    order.push(d);
  };
  ideas.forEach((d) => visit(d));
  return { order, needs, serial: ideas.some((d) => needs(d).length + (d.connection ? 1 : 0) > 1) };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * G1 One proposal card for every reply that proposes something: a draft (new tool, change or
 * connection), ideas for several tools, widgets, or schedules. A row per item (tick box when there
 * are several, icon, name, purpose, summary pills), ▸ opens its details (G2). Returns [card, summary].
 */
function proposalCard(kind, list, ctx) {
  // `readOnly`: a card from a kept conversation: as it was, nothing to tick or build.
  const { mode, cap, all, connection, keepTalking, onBuilt, embedded, messages, done, readOnly = false } = ctx;
  const ideas = kind === "ideas";
  const plan = ideas ? buildPlan(list) : null;
  const byId = new Map();
  const rows = list.map((d, i) => {
    const box = h("input", { type: "checkbox", checked: kind === "widgets" ? i < 2 : kind === "ideas" ? list.length === 1 || d.connection?.mode !== "create" : true, "aria-label": "Build this" });
    const r = { d, box, ticks: scheduleTicks(kind === "schedules" ? [] : d.schedules) };
    if (ideas) byId.set(capabilityId(d.name), r);
    return r;
  });
  const single = rows.length === 1;
  const build = h("button", { class: `primary ${embedded ? "" : "lg"}` });
  const chosen = () => rows.filter((r) => r.box.checked);
  // "Keep talking" sets this proposal aside: Build greys out, the next reply brings a new one (or Draft now does).
  let talking = false;
  const count = () => {
    const n = chosen().length;
    build.disabled = n === 0 || talking;
    build.textContent =
      kind === "widgets"
        ? single
          ? list[0].replaces ? "Change widget" : "Build widget"
          : `Build ${plural(n, "widget")}`
        : kind === "schedules"
          ? n <= 1 ? "Set schedule" : `Set ${n} schedules`
          : connection
            ? "Build connection"
            : mode === "modify"
              ? "Build change"
              : `Build ${plural(n, "tool")}`;
  };
  // An idea comes with the ideas it builds on; leaving one out leaves out what builds on it.
  const tick = (r, on) => {
    r.box.checked = on;
    if (!ideas) return;
    if (on) plan.needs(r.d).forEach((u) => !byId.get(u).box.checked && tick(byId.get(u), true));
    else rows.filter((x) => x.box.checked && plan.needs(x.d).includes(capabilityId(r.d.name))).forEach((x) => tick(x, false));
  };
  rows.forEach((r) => r.box.addEventListener("change", () => (tick(r, r.box.checked), count())));
  if (readOnly) rows.forEach((r) => ((r.box.disabled = true), r.ticks.set(false)));

  const preview = (d) => (kind === "widgets" || kind === "schedules" || mode === "modify" ? cap : { id: slug(d.name ?? connection ?? "new"), name: d.name ?? connection });
  const toolPills = (d) => {
    const spec = d.spec ?? { operations: [], uses: [], hosts: [], secrets: [] };
    const on = plan ? plan.needs(d) : [];
    return [
      spec.operations.length > 0 && kindTag(plural(spec.operations.length, "operation")),
      (spec.widgets ?? []).length > 0 && kindTag(plural(spec.widgets.length, "widget"), "accent"),
      ...on.map((u) => kindTag(`builds on ${byId.get(u).d.name}`, "warn")),
      d.schedules?.length > 0 && kindTag(plural(d.schedules.length, "schedule"), "accent"),
      spec.model && kindTag(`${spec.model} model`),
      d.connection && kindTag(d.connection.mode === "create" ? "needs a new connection" : "changes a connection", "warn"),
    ];
  };
  const details = (r) => {
    const d = r.d;
    if (kind === "widgets") return [h("div", { class: "small muted" }, `${TEMPLATE_LABEL[d.template] ?? d.template} · ${d.sizes.map((s) => SIZE_LABEL[s] ?? s).join(", ")}`), d.replaces && h("div", { class: "small muted" }, `Replaces the current “${d.replaces}” widget`), h("div", { class: "small faint" }, "The tool itself stays as it is.")];
    if (kind === "schedules") return [h("div", { class: "small muted" }, d.why), h("div", { class: "small faint" }, "Nothing gets built. Pause or change it under Info › Schedules.")];
    const spec = d.spec ?? { operations: [], uses: [], hosts: [], secrets: [] };
    const on = plan ? plan.needs(d) : [];
    const existing = spec.uses.filter((u) => !on.includes(u));
    const details = h("pre", { class: "spec-text", hidden: true }, d.requirements ?? d.request);
    return [
      on.length > 0 && h("div", { class: "small row tight wrap" }, h("span", { class: "dot warn" }), "Builds on ", on.map((u) => capRef({ id: u, name: byId.get(u).d.name })), ", so it's built after"),
      existing.length > 0 && h("div", { class: "small row tight wrap" }, "Uses ", existing.map((u) => capRef(all.get(u), u))),
      (spec.hosts.length > 0 || spec.secrets.length > 0) && h("div", { class: "small row tight wrap" }, "Needs ", spec.hosts.map((x) => kindTag(x)), spec.secrets.map((x) => kindTag(`secret ${x}`))),
      connectionLine(d.connection, all),
      spec.operations.length > 0 && h("div", { class: "row tight wrap" }, spec.operations.map((o) => kindTag(o.name, o.sideEffect === "read" ? "" : "accent"))),
      r.ticks.el,
      (spec.widgets ?? []).map((w) => h("div", { class: "small" }, `Widget: ${w}`)),
      spec.model && h("div", { class: "small" }, `Model: ${spec.model} tier`),
      details,
      h("button", { class: "link self-start", onclick: (e) => ((details.hidden = !details.hidden), (e.target.textContent = details.hidden ? "Show spec" : "Hide spec")) }, "Show spec"),
    ];
  };
  const row = (r) => {
    const d = r.d;
    const p = preview(d);
    // What it builds on, needs and runs: always in view (the raw spec stays behind "Show spec").
    const block = h("div", { class: "inset-block stack-sm" }, details(r));
    const name = kind === "widgets" ? d.title : kind === "schedules" ? d.operation : mode === "modify" ? `${cap.name} · v${ctx.nextVersion ?? (cap.version ?? 0) + 1}` : d.name;
    const purpose = kind === "widgets" ? d.shows : kind === "schedules" ? cadenceText(d.cadence) : mode === "modify" ? d.request : d.purpose;
    const pills = kind === "widgets" ? [kindTag(TEMPLATE_LABEL[d.template] ?? d.template), kindTag(d.sizes.map((s) => SIZE_LETTER[s]).join(" "))] : kind === "schedules" ? [kindTag("schedule", "accent")] : toolPills(d);
    return h(
      "li",
      { class: "proposal-row" },
      !single && r.box,
      appIcon(p, { size: 40 }),
      h("div", { class: "grow" }, h("span", { class: "strong" }, name), h("span", { class: "sub clip" }, purpose), h("div", { class: "row tight wrap proposal-pills" }, pills.filter(Boolean)), block),
    );
  };

  build.addEventListener("click", async () => {
    build.disabled = true;
    rows.forEach((r) => (r.box.disabled = true));
    const reenable = () => (rows.forEach((r) => (r.box.disabled = false)), count());
    try {
      if (kind === "widgets") {
        const picked = chosen().map((r) => r.d);
        // A replacement keeps its widget's name, so it stays where it is on Home.
        const b = await buildWidgets(cap, `Build exactly ${picked.length === 1 ? "this widget" : "these widgets"}:\n${picked.map((p, i) => `${i + 1}. ${p.replaces ? `Change the existing widget "${p.replaces}" (keep its name, give it a new operation version) into ` : ""}"${p.title}" (${p.template}; ${p.sizes.join(", ")}): ${p.shows}`).join("\n")}`, messages);
        return onBuilt(b);
      }
      if (kind === "schedules") {
        let n = 0;
        for (const { d } of chosen()) {
          try {
            await api("/schedules", { method: "POST", body: { capabilityId: cap.id, operation: d.operation, cadence: d.cadence } });
            n++;
          } catch (e) {
            fail(new Error(`${d.operation} ${d.cadence}: ${e.message || e}`));
          }
        }
        if (!n) return reenable();
        toast(n === 1 ? "Schedule set" : `${n} schedules set`);
        return embedded ? done(n === 1 ? "Schedule set. It's under Info › Schedules." : `${n} schedules set. They're under Info › Schedules.`) : go(`#/c/${enc(cap.id)}`);
      }
      if (connection) {
        // Only the connection: the intake may have drafted a tool around it.
        const d = list[0];
        const c = d.connection?.mode === "create" ? d.connection : d;
        const b = await api("/capabilities", { method: "POST", body: { name: c.name, purpose: c.purpose, requirements: c.requirements, kind: "connection", ...(messages?.length ? { conversation: messages } : {}) } });
        invalidateCaps();
        return onBuilt(b);
      }
      if (mode === "modify") {
        const b = await startDraft("modify", list[0], cap, { schedules: rows[0].ticks.chosen(), conversation: messages });
        invalidateCaps();
        return onBuilt(b);
      }
      // New tools: side by side, or after the ones they build on.
      const p = buildPlan(chosen().map((r) => r.d));
      const connections = new Map();
      const builds = new Map();
      const started = [];
      const failed = [];
      for (const d of p.order) {
        const dep = p.needs(d).map((u) => builds.get(u));
        if (dep.some((b) => !b)) {
          failed.push(`${d.name}: what it builds on didn't start`);
          continue;
        }
        try {
          const ticks = rows.find((x) => x.d === d).ticks;
          const b = await startDraft("create", d, null, { connections, after: p.serial ? started.at(-1)?.buildId : dep[0]?.buildId, schedules: ticks.chosen(), conversation: messages });
          builds.set(capabilityId(d.name), b);
          started.push(b);
        } catch (e) {
          failed.push(`${d.name}: ${e.message || e}`);
        }
      }
      if (started.length) invalidateCaps();
      if (failed.length) toast(`Couldn't start ${failed.join("; ")}`, { dot: "danger", ms: 15000 });
      if (!started.length) return reenable();
      if (started.length === 1 && !failed.length) return onBuilt(started[0]);
      // Several at once: Home, where each new tool is a tile that fills in as it builds.
      toast(`Building ${started.length} tools`);
      go("#/");
    } catch (e) {
      fail(e);
      reenable();
    }
  });
  count();
  const n = rows.length;
  const summary = kind === "widgets" ? plural(n, "widget") : kind === "schedules" ? plural(n, "schedule") : connection ? "connection" : mode === "modify" ? "change" : plural(n, "tool");
  const card = h(
    "div",
    { class: "card spec-card proposal" },
    h("div", { class: "eyebrow" }, `Proposal · ${summary}`),
    h("ul", { class: "list" }, rows.map(row)),
    // Say what spends the owner's account before it happens (a schedule-only proposal builds nothing).
    kind !== "schedules" && !readOnly && h("div", { class: "small faint" }, settings?.builder === "remote" ? `${builderLabel("remote")} builds it.` : `${settings?.builder ? builderLabel(settings.builder) : "Your builder"} builds it, on its own account: your subscription, API key or cloud provider.`),
    !readOnly && h("div", { class: "row end tight" }, h("button", { onclick: () => ((talking = true), count(), keepTalking()) }, "Keep talking"), build),
  );
  return [card, summary];
}

// Only connections hold credentials: a connection to build (or change) first, then the draft waits for it.
const connectionLine = (conn, all) =>
  conn &&
  h(
    "div",
    { class: "small row tight wrap" },
    h("span", { class: "dot warn" }),
    conn.mode === "create" ? h("span", { class: "grow row tight wrap" }, "First builds the connection", capRef({ id: slug(conn.name), name: conn.name }), "(it holds the sign-in; set up under Accounts)") : ["First changes the connection ", capRef(all.get(conn.capabilityId), conn.capabilityId), `: ${conn.request}`],
  );

// ---------- B3 / B4 / H2–H6: a build (its page, or in the change drawer) ----------

const STEPS = [
  ["spec", "Spec agreed"],
  ["code", "Writing code"],
  ["tests", "Running tests"],
  ["auth", "Your authorization"],
];
const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const BUILD_KIND = { create: "new", modify: "change", widgets: "widgets" };
const LIVE_BUILD = new Set(["waiting", "open", "building", "validating"]);
/** A build's kind in words: a change that only touched the manifest is a quick change. */
const kindWord = (b) => (b.builder === "keep" || b.request?.manifestOnly ? "quick change" : BUILD_KIND[b.kind] ?? b.kind);

/**
 * Failed builds nobody has dealt with yet: not retried, and nothing of that tool promoted since (a
 * later change replaced it). These are what "needs you" means for builds.
 */
const unresolvedFailures = (builds) =>
  builds.filter((b) => b.status === "failed" && !builds.some((x) => x.request?.retryOf === b.buildId || x.request?.autoRetryOf === b.buildId) && !builds.some((x) => x.capabilityId === b.capabilityId && (x.kind === b.kind || b.kind === "create") && x.status === "promoted" && x.createdAt > b.createdAt));

/** Real milestones only (no progress bars): spec ✓ code ✓ tests 4/6 you, or waiting. */
function milestones(b) {
  if (b.status === "waiting") return h("span", { class: "milestones" }, kindTag("waiting", "warn"));
  const at = STEPS.findIndex(([k]) => k === (b.step?.step ?? "code"));
  const tests = b.tests ?? b.step?.tests;
  return h(
    "span",
    { class: "milestones" },
    kindTag("spec ✓", "ok"),
    at > 1 ? kindTag("code ✓", "ok") : h("span", { class: "pill accent with-dot" }, "code"),
    at === 2 ? h("span", { class: "pill accent with-dot" }, tests ? `tests ${tests.passed}/${tests.total}` : "tests") : at > 2 ? kindTag("tests ✓", "ok") : kindTag("tests"),
    at === 3 ? h("span", { class: "pill warn with-dot" }, "you") : kindTag("you"),
  );
}

async function buildPage(id) {
  const panel = buildPanel(id, {});
  view(...moment({ left: "-60px", bottom: "-20px" }, topBar(""), sandboxNotice(), h("div", { class: "build-center" }, panel.el)));
}

/**
 * One build, live: the steps, then how it ended. The log is always there: following the builder
 * while it works, collapsed under "Show log" once it succeeds, open by default when it fails (H6).
 * `compact`: in the change drawer (P3); `onPromoted(b)`: what to show there when it's live (P4).
 */
/** What a build runs on, in words ("Fable · high effort"; the model it ran on, once the builder says). */
const buildModelWords = (b) => (b.model && (b.model.ran || b.model.model || b.model.effort) ? modelWords({ model: b.model.ran ?? b.model.model, effort: b.model.effort }) : "");
/** What the builder's host charged, as it says it: "12 points" (1 decimal at most). */
const chargeWords = (c) => (c ? `${Math.round(c.amount * 10) / 10} ${c.unit}` : "");

/**
 * Who builds it on what, as a labelled strip across the card: who asked (if not you), the builder,
 * the model, the effort (a meter) and whose account it runs on.
 */
function buildMeta(b) {
  const who = actorLabel(b.requestedBy);
  const asked = who && who !== "You" && !String(b.requestedBy).startsWith("ui:");
  const model = b.model?.ran ?? b.model?.model;
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  const level = b.model?.effort ? Math.max(0, efforts.indexOf(b.model.effort)) + 1 : 0;
  const cell = (label, value, sub, title) => h("div", { class: "meta-cell", title: title ?? "" }, h("span", { class: "meta-label" }, label), h("span", { class: "meta-value" }, value), sub && h("span", { class: "meta-sub" }, sub));
  // "claude-fable-5-5" reads as "Fable 5.5" (the full name on hover); other names as they are.
  const pretty = (m) => /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m)?.slice(1).reduce((name, n, i) => (i ? `${name}${i === 1 ? " " : "."}${n}` : n[0].toUpperCase() + n.slice(1)), "") ?? modelWords({ model: m });
  return h(
    "div",
    { class: "build-meta" },
    asked && cell("Asked by", [agentTile(catalogOf({ id: b.requestedBy })?.id ?? b.requestedBy, who, 18), who]),
    cell("Builder", [agentTile(AGENT_CATALOG.find((c) => c.tool === b.builder)?.id ?? b.builder, builderLabel(b.builder), 18), builderLabel(b.builder)], b.builder !== "remote" && "on your account"),
    cell("Model", model ? pretty(model) : "Default", null, model),
    cell("Effort", [h("span", { class: "meter", "aria-hidden": "true" }, efforts.map((_, i) => h("i", { class: i < level ? "on" : "" }))), b.model?.effort ? b.model.effort[0].toUpperCase() + b.model.effort.slice(1) : "Default"]),
  );
}

/** "Codex asked · " when an agent asked for the build (it runs on the owner's builder account all the same). */
const askedBy = (b) => {
  const who = actorLabel(b.requestedBy);
  return who && who !== "You" ? `${who} asked · ` : "";
};

/** "Built with Claude Code · claude-fable-5-5 · high effort", and why it wasn't the model asked for. */
const builtWith = (b) =>
  b.builder &&
  !["keep", "agent"].includes(b.builder) &&
  !b.builder.startsWith("copy:") &&
  h("div", { class: "small faint" }, `Built with ${builderLabel(b.builder)}${buildModelWords(b) ? ` · ${buildModelWords(b)}` : ""}${b.charge ? ` · ${chargeWords(b.charge)}` : ""}`);

function buildPanel(id, { compact = false, onPromoted } = {}) {
  const card = h("div", { class: compact ? "build-panel stack-md" : "card build-card" }, skeleton("50%", "80%"));
  const cancelBtn = h("button", { class: "sm" }, "Cancel build");
  const logPre = h("pre", { class: `log ${compact ? "short" : "tail"}` });
  let follow = true;
  let logScroll = 0;
  logPre.addEventListener("scroll", () => {
    follow = logPre.scrollTop + logPre.clientHeight >= logPre.scrollHeight - 4;
    logScroll = logPre.scrollTop;
  });
  const keepScroll = () => (logPre.scrollTop = follow ? logPre.scrollHeight : logScroll);
  const logLine = (text) => {
    const m = /^(\d\d:\d\d:\d\d) (.*)$/.exec(text);
    logPre.append(m ? h("span", { class: "t" }, m[1]) : "", m ? ` ${m[2]}` : text, "\n");
  };
  /** The log, folded: "Show log" / "Hide log". */
  const logBlock = (open) => {
    const toggle = h("button", { class: "link sm" }, open ? "Hide log" : "Show log");
    const wrap = h("div", { class: "stack-sm" }, h("div", { class: "row between" }, h("span", { class: "eyebrow" }, "Log"), toggle), logPre);
    logPre.hidden = !open;
    toggle.addEventListener("click", () => ((logPre.hidden = !logPre.hidden), (toggle.textContent = logPre.hidden ? "Show log" : "Hide log"), keepScroll()));
    return wrap;
  };

  (async () => {
    const [b0, all, context] = await Promise.all([api(`/builds/${enc(id)}`), caps(true).catch(() => new Map()), api(`/builds/${enc(id)}/context`).catch(() => ({}))]);
    let b = b0;
    const cap = () => all.get(b.capabilityId) ?? { id: b.capabilityId, name: b.request?.name ?? b.capabilityId };
    if (!compact) setWallpaper(await hues([tintOf(cap()), 125]));
    // Elapsed time of the current attempt (the honest number while code is being written).
    let startedAt = Date.now() - (b0.progress?.elapsedSeconds ?? 0) * 1000;
    const clockEl = h("div", { class: "mono muted small" });
    const seen = new Map(); // step → first seen (ms), for durations
    let step = b.step;
    // "Spec agreed" opens to the spec the builder works from (kept open across redraws).
    const specText = String(b.request?.requirements ?? b.request?.request ?? "").trim();
    const specView = specText ? h("details", { class: "spec-step" }, h("summary", {}, "Spec agreed"), h("pre", { class: "spec-text" }, specText)) : null;
    // The conversation that led to it (kept with the build); an agent's build has none.
    const convoView = context.conversation?.length ? h("details", { class: "spec-step" }, h("summary", {}, "Conversation"), conversationThread(context.conversation, { mode: b.kind === "create" ? "create" : "modify", cap: cap(), all, version: b.resultVersion })) : null;
    const head = (icon, title, sub, right) => h("div", { class: "row build-head" }, icon, h("div", { class: "grow col" }, h("div", { class: "build-title" }, title), sub && h("div", { class: "small muted" }, sub)), right);

    const live = () => {
      const at = STEPS.findIndex(([k]) => k === (step?.step ?? "code"));
      if (step && !seen.has(step.step)) seen.set(step.step, Date.now());
      const meta = (k, i) => {
        if (k === "tests" && step?.tests) return `${step.tests.passed} / ${step.tests.total}`;
        const start = seen.get(k);
        const next = STEPS[i + 1] && seen.get(STEPS[i + 1][0]);
        return i < at && start && next ? mmss(next - start) : "";
      };
      const waitingAgent = b.builder === "agent";
      const base = cap().version;
      if (b.status === "waiting") {
        // H2: what it waits for, linking to that build.
        const dep = b.dependsOn;
        put(
          card,
          head(appIcon(cap(), { size: compact ? 36 : 56 }), cap().name, null, kindTag("waiting", "warn")),
          h("div", { class: "small muted row tight wrap" }, "Starts once ", dep ? h("a", { href: `#/b/${enc(dep)}` }, b.queued ? "the change before it" : "the build it needs") : "the build it needs", " is done · you can leave"),
          logBlock(false),
        );
        return;
      }
      put(
        card,
        head(
          appIcon(cap(), { size: compact ? 36 : 56, progress: step?.step === "tests" && step.tests?.total ? step.tests.passed / step.tests.total : 0, waiting: !(step?.step === "tests") }),
          compact && b.kind !== "create" ? `Building v${(base ?? 0) + 1}` : cap().name,
          waitingAgent ? `Waiting for ${actorLabel(b.requestedBy, all)} to build it · you can leave` : null,
          clockEl,
        ),
        !waitingAgent && buildMeta(b),
        convoView,
        h("ol", { class: "steps" }, STEPS.map(([k, label], i) => stepRow(k === "spec" && specView ? specView : label, i < at ? "done" : i === at ? "live" : "todo", meta(k, i)))),
        logPre,
        h("div", { class: "row between" }, h("span", { class: "small faint" }, compact && base ? `v${base} keeps working meanwhile` : "You can leave; it keeps building."), cancelBtn),
      );
      logPre.hidden = false;
      keepScroll();
      tickClock();
    };
    const tickClock = () => (clockEl.textContent = mmss(Date.now() - startedAt));
    const clockTimer = setInterval(tickClock, 1000);
    onLeave(() => clearInterval(clockTimer));

    const ready = async () => {
      const detail = await api(`/capabilities/${enc(b.capabilityId)}`).catch(() => null);
      invalidateCaps();
      const fresh = await caps(true).catch(() => all);
      for (const [k, v] of fresh) all.set(k, v);
      const c = all.get(b.capabilityId) ?? cap();
      const tests = b.tests ? `${b.tests.passed} of ${b.tests.total} tests passed` : "";
      const connection = detail?.kind === "connection";
      const signIn = connection && detail.operations.some((o) => o.name === "connect");
      if (detail && !detail.status.ready && !connection) {
        step = { step: "auth" };
        live();
        if (!(await grantsSheet(b.capabilityId)))
          return put(card, head(appIcon(c, { size: compact ? 36 : 64, badge: "warn" }), `${c.name} needs you`, "Built. Authorize it to use it.", h("button", { class: "primary", onclick: () => grantsSheet(b.capabilityId).then((ok) => ok && ready()) }, "Authorize…")), logBlock(false));
      }
      if (compact && onPromoted) return put(card, head(appIcon(c, { size: 36 }), `${c.name} · v${b.resultVersion ?? ""}`, [kindWord(b), tests].filter(Boolean).join(" · ")), onPromoted(b), logBlock(false));
      // H4: a quick change (manifest only): no builder, no steps.
      if (b.builder === "keep" || b.request?.manifestOnly)
        return put(card, head(appIcon(c, { size: 56 }), `${c.name} · v${b.resultVersion ?? ""}`, `${titleCase(String(b.request?.request ?? "changed").replace(/^use /, "uses "))}. No builder needed.`, kindTag("quick change", "ok")), h("div", { class: "row tight" }, h("a", { class: "btn primary", href: `#/c/${enc(c.id)}` }, "Done")));
      // H3: widgets only: each in every size it offers, and Add to Home.
      if (b.kind === "widgets") {
        const w = (detail?.widgets ?? []).filter((x) => !b.request?.request || String(b.request.request).includes(x.title));
        return put(
          card,
          head(appIcon(c, { size: 56 }), `New widgets · ${c.name}`, "Only adds widgets. The tool itself is unchanged.", kindTag("done", "ok")),
          h(
            "div",
            { class: "stack-md" },
            (w.length ? w : detail?.widgets ?? []).map((x) =>
              h(
                "div",
                { class: "stack-sm" },
                h("div", { class: "row between" }, h("span", { class: "strong" }, x.title), h("button", { class: "sm primary", onclick: () => addWidgetSheet({ capabilityId: c.id, widget: x.name }) }, "Add to Home")),
                h("div", { class: "widget-sizes" }, x.sizes.map((s) => widgetPreview(c, c.id, { ...x, name: x.name }, { size: s }).el)),
              ),
            ),
          ),
          logBlock(false),
        );
      }
      // H5: a new connection ends with its sign-in, not Open.
      if (connection && (signIn || !detail.status.ready))
        return put(
          card,
          head(appIcon(c, { size: 56 }), `${c.name} is ready`, tests),
          h("div", { class: "notice warn-soft" }, h("span", { class: "grow" }, signIn ? "Sign in to finish setting it up." : "Set it up to finish.")),
          h("div", { class: "row tight" }, h("a", { class: "btn", href: "#/accounts" }, "Later"), h("button", { class: "primary", onclick: () => (signIn && detail.status.pendingGrants.length === 0 ? signInDialog(c.id) : grantsSheet(c.id)).then(() => go(`#/c/${enc(c.id)}`)) }, signIn ? "Sign in" : "Set up")),
          logBlock(false),
        );
      put(
        card,
        head(appIcon(c, { size: 64 }), `${c.name} is ready`, b.kind === "create" ? `Added to ${connection ? "Accounts" : "Home"}${tests ? ` · ${tests}` : ""}` : `Updated to v${b.resultVersion ?? "?"}${tests ? ` · ${tests}` : ""}`, h("button", { class: "primary lg", onclick: () => openCapability({ ...c, ready: true }).catch(fail) }, "Open")),
        builtWith(b),
        b.screenshot && h("img", { class: "build-shot", src: shotUrl(id), alt: `${c.name}, as rendered during validation` }),
        convoView,
        specView,
        logBlock(false),
      );
    };

    const failed = () => {
      const f = b.failure ?? { title: "The build didn't pass", detail: b.log.at(-1) ?? "" };
      const attempt = f.attempt && f.maxAttempts ? ` · attempt ${f.attempt} of ${f.maxAttempts}` : "";
      // Refused by the builder's host (e.g. over the month's builds): asking it to fix can't help.
      const refused = /^refused: /.test([...b.log].reverse().find((l) => /FAILED: /.test(l))?.split("FAILED: ")[1] ?? "");
      const fix = !refused && h("button", { class: "primary" }, "Ask builder to fix");
      const retry = h("button", { class: refused ? "primary" : "" }, "Retry");
      const again = (path, btn) => async () => {
        btn.disabled = true;
        try {
          const next = await api(`/builds/${enc(id)}/${path}`, { method: "POST" });
          compact ? (put(card), card.replaceWith(buildPanel(next.buildId, { compact, onPromoted }).el)) : go(`#/b/${next.buildId}`);
        } catch (e) {
          btn.disabled = false;
          fail(e);
        }
      };
      if (fix) fix.addEventListener("click", again("fix", fix));
      retry.addEventListener("click", again("retry", retry));
      if (!compact) setWallpaper([25, 250]);
      put(
        card,
        head(appIcon(cap(), { size: compact ? 36 : 56, badge: "danger" }), f.title, `${cap().name} · ${kindWord(b)}${attempt}`),
        f.detail && h("div", { class: "notice danger" }, h("span", {}, f.detail)),
        builtWith(b),
        b.screenshot && h("img", { class: "build-shot", src: shotUrl(id), alt: "The screen as rendered during validation" }),
        convoView,
        specView,
        h("div", { class: "row tight" }, fix, retry),
        logBlock(true),
      );
      requestAnimationFrame(keepScroll);
    };

    const cancelled = () => {
      const retry = h("button", { class: "primary" }, "Start again");
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        try {
          go(`#/b/${(await api(`/builds/${enc(id)}/retry`, { method: "POST" })).buildId}`);
        } catch (e) {
          retry.disabled = false;
          fail(e);
        }
      });
      put(card, head(appIcon(cap(), { size: compact ? 36 : 56 }), "Build cancelled", `${cap().name} · nothing changed`), h("div", { class: "row tight" }, retry, !compact && h("a", { class: "btn", href: "#/" }, "Home")), logBlock(false));
    };

    const inReview = () => {
      const decide = (approve, btn) => async () => {
        btn.disabled = true;
        try {
          const r = await api(`/builds/${enc(id)}/${approve ? "approve" : "reject"}`, { method: "POST" });
          invalidateCaps();
          pollInbox();
          settle(r);
        } catch (e) {
          btn.disabled = false;
          fail(e);
        }
      };
      const yes = h("button", { class: "primary" }, "Allow");
      const no = h("button", {}, "Don't allow");
      yes.addEventListener("click", decide(true, yes));
      no.addEventListener("click", decide(false, no));
      const changes = reviewChanges(b.review);
      // Only a changed screen is worth a look (validation renders it on empty data).
      const shot = b.screenshot && (!changes || b.review.changes.ui);
      put(
        card,
        head(appIcon(cap(), { size: compact ? 36 : 56, badge: "warn" }), reviewTitle(b, all), "It passed its checks. It goes live only if you allow it."),
        b.review.newOperations.length > 0 && h("div", { class: "eyebrow" }, "New"),
        ...b.review.newOperations.map((o) => reviewOp(o, { full: true })),
        changes && [h("div", { class: "eyebrow" }, changes.every(([ok]) => ok) ? "Nothing else changes" : "Also"), changeList(changes)],
        shot && [h("div", { class: "eyebrow" }, "The screen after the change (rendered with no data)"), h("img", { class: "build-shot", src: shotUrl(id), alt: "The screen as rendered during validation" })],
        reviewRequest(b, all),
        h("div", { class: "row tight" }, yes, no),
        logBlock(false),
      );
    };

    const settle = (v) => {
      b = v;
      if (b.status === "review") return inReview();
      if (b.status === "promoted") return ready();
      if (b.status === "failed") return failed();
      if (b.status === "cancelled") return cancelled();
      // Agent-built and still open: the agent submits when it's done.
      step = b.step ?? step;
      live();
      const t = setTimeout(() => api(`/builds/${enc(id)}`).then(settle).catch(() => {}), 5000);
      onLeave(() => clearTimeout(t));
    };

    // Cancel while the builder works.
    cancelBtn.addEventListener("click", async () => {
      if (!(await confirmDialog({ title: "Cancel this build?", body: "The builder stops and nothing changes. You can start it again later.", confirm: "Cancel build", cancel: "Keep building", danger: true }))) return;
      try {
        settle(await api(`/builds/${enc(id)}/cancel`, { method: "POST" }));
      } catch (e) {
        fail(e);
      }
    });
    // The transcript replays (live or finished, kept for 30 days), then "done".
    const finished = !LIVE_BUILD.has(b.status) && b.status !== "open";
    if (!finished) live();
    const es = new EventSource(`/api/builds/${enc(id)}/events`);
    onLeave(() => es.close());
    es.addEventListener("line", (e) => {
      logLine(JSON.parse(e.data));
      if (follow) logPre.scrollTop = logPre.scrollHeight;
    });
    es.addEventListener("step", (e) => {
      if (finished) return;
      step = JSON.parse(e.data);
      live();
    });
    es.addEventListener("done", (e) => {
      es.close();
      if (!logPre.childNodes.length) for (const l of b.log) logLine(l);
      settle(JSON.parse(e.data));
    });
    es.addEventListener("error", () => {
      if (!finished || card.querySelector(".build-head")) return;
      es.close();
      for (const l of b.log) logLine(l);
      settle(b);
    });
    if (finished) return;
    // Pick up the icon as soon as the builder has written it (it does that first), and the attempt clock.
    const tick = setInterval(async () => {
      const [v, fresh] = await Promise.all([api(`/builds/${enc(id)}`).catch(() => null), caps(true).catch(() => null)]);
      if (fresh) for (const [k, x] of fresh) all.set(k, x);
      if (v?.progress) startedAt = Date.now() - v.progress.elapsedSeconds * 1000;
      if (v && b.status === "waiting" && v.status !== "waiting") b = v;
      if (v?.step && LIVE_BUILD.has(v.status)) ((step = v.step), live());
    }, 4000);
    onLeave(() => clearInterval(tick));
  })().catch((e) => put(card, errorBox(e)));
  return { el: card };
}

// ---------- review of agents' changes ----------

const EFFECT = { read: ["Reads", "read", "accent"], write: ["Changes", "change", "warn"], destructive: ["Deletes", "delete", "danger"] };
/** "export_all@1" → "export all"; later versions say so. */
const opLabel = (key) => {
  const [name, v] = key.split("@");
  return `${name.replace(/_/g, " ")}${v && v !== "1" ? ` (v${v})` : ""}`;
};
const andList = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** "Claude Code wants to add “export all” to <Reading Log>" (the tool as a cap-ref). */
function reviewTitle(b, all) {
  const who = actorLabel(b.requestedBy, all);
  const ref = capRef(all.get(b.capabilityId), b.capabilityId);
  const ops = b.review.newOperations.map((o) => `“${opLabel(o.key)}”`);
  return h("span", { class: "title-ref" }, ops.length ? [`${who} wants to add ${andList(ops)} to `, ref] : [`${who} wants to change `, ref]);
}

/** A description's first sentence (cut at 200 characters), and the rest. */
const summaryOf = (d = "") => {
  const first = /^[\s\S]+?[.!?](?=\s|$)/.exec(d.trim())?.[0] ?? d.trim();
  return first.length > 200 ? `${first.slice(0, 199).replace(/\s+\S*$/, "")}…` : first;
};
const restOf = (d = "") => {
  const t = d.trim();
  const first = /^[\s\S]+?[.!?](?=\s|$)/.exec(t)?.[0] ?? t;
  return first.length > 200 ? t : t.slice(first.length).trim();
};

/** One new operation: what agents can do with it, what it takes and (full view) what it returned in its tests. */
function reviewOp(o, { full }) {
  const [pill, verb, tone] = EFFECT[o.sideEffect] ?? EFFECT.write;
  const takes = o.inputs ? (o.inputs.length ? `takes ${o.inputs.join(", ")}` : "no input") : null;
  return h(
    "div",
    { class: "stack-sm" },
    h("div", { class: "row tight wrap" }, h("span", { class: `pill ${tone}` }, pill), h("span", { class: "strong" }, `Agents can then ${verb}: `, h("span", { class: "muted" }, summaryOf(o.description)))),
    // Descriptions are written for agents, often a long paragraph: the first sentence above, the rest folded.
    restOf(o.description) && h("details", { class: "small review-more" }, h("summary", {}, "Full description"), h("p", { class: "muted pre-line" }, restOf(o.description))),
    h("div", { class: "small faint mono" }, [o.key, takes].filter(Boolean).join(" · ")),
    full && (o.example ? [h("div", { class: "eyebrow" }, "What it returned in its tests"), h("pre", { class: "small review-example" }, o.example)] : o.inputs && h("div", { class: "small muted" }, "No test shows what it returns.")),
  );
}

/** Everything else about the change, from the diff with the live version: [ok, text]. Null for reviews from before this was recorded. */
function reviewChanges(r) {
  const c = r.changes;
  if (!c) return null;
  return [
    r.connection && [false, "It's a connection: this code holds your sign-in for that service"],
    c.ui ? [false, "The screen changes"] : [true, "Screen unchanged"],
    c.migrations.length ? [false, `How data is stored changes (${c.migrations.join(", ")})`] : [true, "No change to how data is stored"],
    c.newGrants.length ? [false, `Asks for new access: ${c.newGrants.join(", ")} (you approve that separately)`] : [true, "No new access"],
    c.changedOperations.length ? [false, `Updates ${andList(c.changedOperations.map(opLabel))} (compatibly)`] : [true, "Existing operations unchanged"],
    c.removedOperations.length && [false, `Removes ${andList(c.removedOperations.map(opLabel))} (unused)`],
  ].filter(Boolean);
}
const changeList = (items) => h("ul", { class: "small stack-sm change-list" }, items.map(([ok, text]) => h("li", { class: ok ? "muted" : "strong" }, `${ok ? "✓" : "•"} ${text}`)));

/** The agent's own words, folded: written for the builder, so not the first thing to read. */
const reviewRequest = (b, all) => b.request?.request && h("details", { class: "small" }, h("summary", {}, `What ${actorLabel(b.requestedBy, all)} asked for`), h("p", { class: "muted" }, String(b.request.request)));

// ---------- C3 / H1: Activity (All · Builds · Calls · Access) ----------

const dayLabel = (iso) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};

/** Consecutive calls by the same agent to the same tool collapse into one row. */
function groupItems(items) {
  const out = [];
  for (const i of items) {
    const prev = out.at(-1);
    // A model call belongs to the tool call logged just above it (same tool and caller).
    if (i.kind === "model" && prev?.kind === "calls" && prev.actor === i.actor && prev.capabilityId === i.capabilityId) {
      (prev.models ??= []).push(i);
      continue;
    }
    if (i.kind === "call" && prev?.kind === "calls" && prev.actor === i.actor && prev.capabilityId === i.capabilityId && dayLabel(prev.items[0].at) === dayLabel(i.at)) prev.items.push(i);
    else if (i.kind === "call") out.push({ kind: "calls", actor: i.actor, capabilityId: i.capabilityId, at: i.at, items: [i] });
    else if (i.kind === "model" && prev?.kind === "models" && prev.capabilityId === i.capabilityId && dayLabel(prev.items[0].at) === dayLabel(i.at)) prev.items.push(i);
    else if (i.kind === "model") out.push({ kind: "models", actor: i.actor, capabilityId: i.capabilityId, at: i.at, items: [i] });
    else out.push(i);
  }
  return out;
}

function activityRow(g, all, showCap) {
  const who = actorLabel(g.actor, all);
  const ref = showCap && g.capabilityId ? capRef(all.get(g.capabilityId), g.capabilityId) : null;
  const on = (...parts) => h("span", { class: "row tight wrap" }, parts.flat(Infinity).filter(Boolean).map((p) => (typeof p === "string" ? h("span", {}, p) : p)));
  let dot = "";
  let text;
  let expand = null;
  if (g.kind === "calls") {
    const errors = g.items.filter((c) => c.outcome !== "ok");
    const spent = (g.models ?? []).reduce((n, x) => n + x.costUsd, 0);
    const modelNote = g.models?.length ? h("span", { class: "faint" }, `model ${usd(spent)}`) : "";
    if (g.items.length === 1) {
      const c = g.items[0];
      dot = c.outcome === "ok" ? "ok" : "danger";
      text = on(h("span", { class: "mono" }, c.operation.split("@")[0]), c.outcome === "ok" ? "" : /timed? ?out/i.test(c.outcome) ? "timed out" : "failed", modelNote, ref && ["on", ref]);
    } else {
      dot = errors.length === g.items.length ? "danger" : errors.length ? "warn" : "ok";
      text = on(`${who} made ${g.items.length} calls`, ref && ["to", ref], errors.length ? h("span", { class: "faint" }, `${errors.length} failed`) : "", modelNote);
    }
    // One call or several, the row opens the same way: each call's version, error, time taken.
    expand = h(
      "ul",
      { class: "list nested", hidden: true },
      g.items.map((c) => h("li", {}, h("span", { class: `dot ${c.outcome === "ok" ? "" : "danger"}` }), h("div", { class: "grow" }, h("span", { class: "mono small" }, c.operation), c.outcome !== "ok" && h("span", { class: "sub" }, c.outcome.replace(/^ERROR /, ""))), h("span", { class: "mono faint small" }, `${c.ms}ms`), h("span", { class: "mono faint small time" }, clock(c.at)))),
    );
  } else if (g.kind === "models") {
    const failed = g.items.filter((x) => x.outcome === "failed");
    const cost = g.items.reduce((n, x) => n + x.costUsd, 0);
    const model = (x) => x.model.replace(/^[a-z]+\//, "");
    const tokens = (x) => `${x.inputTokens.toLocaleString()} in · ${x.outputTokens.toLocaleString()} out`;
    dot = failed.length === g.items.length ? "danger" : failed.length ? "warn" : "";
    if (g.items.length === 1) {
      const x = g.items[0];
      text = on("Model", h("span", { class: "mono" }, model(x)), x.outcome === "failed" ? h("span", { class: "faint" }, `failed: ${x.error ?? ""}`) : h("span", { class: "faint" }, `${tokens(x)} · ${usd(x.costUsd)}`), ref && ["·", ref]);
    } else {
      text = on(`${g.items.length} model calls`, h("span", { class: "faint" }, usd(cost)), failed.length ? h("span", { class: "faint" }, `${failed.length} failed`) : "", ref && ["·", ref]);
      expand = h(
        "ul",
        { class: "list nested", hidden: true },
        g.items.map((x) => h("li", {}, h("span", { class: `dot ${x.outcome === "failed" ? "danger" : ""}` }), h("div", { class: "grow" }, h("span", { class: "mono small" }, model(x)), h("span", { class: "sub" }, x.outcome === "failed" ? x.error ?? "failed" : tokens(x))), h("span", { class: "mono faint small" }, usd(x.costUsd)), h("span", { class: "mono faint small time" }, clock(x.at)))),
      );
    }
  } else if (g.kind === "build") {
    const what = g.buildKind === "create" ? "Built" : "Changed to";
    // What it ran on: "· Fable · high effort" (the model the builder reported, once it did).
    const ran = [buildModelWords({ model: g.buildModel }), chargeWords(g.charge)].filter(Boolean).join(" · ");
    if (g.outcome === "promoted") text = on(`${what} v${g.version}`, ref && ["·", ref], ran && h("span", { class: "faint" }, `· ${ran}`));
    else if (g.outcome === "failed") (dot = "danger"), (text = on(`Build failed: ${g.reason || g.failure?.title || "see log"}`, ref && ["·", ref], g.charge && h("span", { class: "faint" }, `· ${chargeWords(g.charge)}`)));
    else if (g.outcome === "cancelled") text = on("Build cancelled", ref && ["·", ref]);
    else (dot = "live"), (text = on("Building…", ref && ["·", ref]));
  } else if (g.kind === "lifecycle") {
    // Schedule details read "created <id>: op@1 daily 07:00" / "paused <id> after 3 failures": drop the id.
    const sm = /^(\w+) [\w-]+:? ?(.*)$/.exec(g.detail ?? "");
    const schedule = sm ? `Schedule ${sm[1]}${sm[2] ? `: ${sm[2].replace(/@\d+/, "")}` : ""}` : "Schedule";
    const words = { delete: "Deleted", restore: "Restored", purge: "Permanently deleted", rollback: `Rolled back ${g.detail}`, schedule };
    dot = g.outcome === "purge" || g.outcome === "delete" ? "warn" : "";
    text = on(words[g.outcome] ?? g.outcome, ref && ["·", ref]);
  } else if (g.kind === "authority") {
    const subject = actorLabel(g.subject, all);
    const words = {
      agent_connected: () => ((dot = "ok"), on(`Connected ${subject}`, g.detail && h("span", { class: "faint" }, g.detail))),
      agent_declined: () => on(`Declined ${g.subject}`),
      agent_revoked: () => ((dot = "warn"), on(`Disconnected ${subject}`)),
      agent_scopes: () => on(`${subject} may now: ${g.detail || "nothing"}`),
      agent_capabilities: () => on(`${subject} sees: ${g.detail === "*" ? "everything" : g.detail || "nothing"}`),
      secret_set: () => on("Set secret", h("span", { class: "mono" }, g.subject), ref && ["·", ref]),
      secret_removed: () => ((dot = "warn"), on("Removed secret", h("span", { class: "mono" }, g.subject), ref && ["·", ref])),
      destructive_confirmed: () => ((dot = "warn"), on(`Let ${subject} run`, h("span", { class: "mono" }, (g.detail ?? "").split("@")[0]), ref && ["on", ref])),
      destructive_rejected: () => on(`Stopped ${subject} running`, h("span", { class: "mono" }, (g.detail ?? "").split("@")[0]), ref && ["on", ref]),
      models_set: () => on("Changed model settings", h("span", { class: "faint" }, g.detail)),
      model_key_set: () => on(`Set the ${PROVIDERS[g.subject]?.label ?? g.subject} API key`),
      model_key_removed: () => ((dot = "warn"), on(`Removed the ${PROVIDERS[g.subject]?.label ?? g.subject} API key`)),
      model_budget_80: () => ((dot = "warn"), on(`Model spend passed 80% of ${g.subject === "all" ? "the monthly cap" : "its cap"}`, h("span", { class: "faint" }, g.detail), g.subject !== "all" && ref && ["·", ref])),
      passkey_added: () => ((dot = "ok"), on(`Added passkey “${g.subject}”`, h("span", { class: "faint" }, g.detail))),
      passkey_removed: () => ((dot = "warn"), on(`Removed passkey “${g.subject}”`, h("span", { class: "faint" }, g.detail))),
      public_url_set: () => on(g.subject === "none" ? "Removed the public address" : "Set the public address", g.subject !== "none" && h("span", { class: "mono" }, g.subject)),
      model_retired: () => ((dot = "warn"), on(h("span", { class: "mono" }, g.subject), "is no longer available", g.detail && h("span", { class: "faint" }, g.detail), ref && ["·", ref])),
    };
    text = (words[g.outcome] ?? (() => on(g.outcome)))();
  } else {
    const grant = g.grant.startsWith("capability:") ? [capRef(all.get(g.grant.slice(11).split("/")[0]), g.grant.slice(11).split("/")[0])] : [g.grant.replace(/^host:/, "").replace(/^secret:/, "")];
    if (g.outcome === "approve") (dot = "ok"), (text = on(`${who} authorized`, ...grant, ref && ["for", ref]));
    else if (g.outcome === "revoke") text = on("Revoked", ...grant, ref && ["for", ref]);
    else (dot = "warn"), (text = on("Asked for access", ref && ["for", ref]));
  }
  const href = g.kind === "build" ? `#/b/${g.buildId}` : null;
  const li = h(
    "li",
    { class: href || expand ? "link" : "", tabindex: href || expand ? 0 : undefined },
    h("span", { class: `dot ${dot}` }),
    h("div", { class: "grow" }, text, expand),
    h("span", { class: "pill" }, who),
    h("span", { class: "mono faint small time" }, clock(g.at)),
  );
  const act = (e) => {
    if (expand && !expand.contains(e.target)) expand.hidden = !expand.hidden;
    else if (href) go(href);
  };
  if (href || expand) li.addEventListener("click", act), li.addEventListener("keydown", (e) => e.key === "Enter" && act(e));
  return li;
}

const ACTIVITY_VIEWS = [
  ["all", "All", ""],
  ["builds", "Builds", "build"],
  ["calls", "Calls", "call,model"],
  ["access", "Access", "grant,authority"],
];

async function activityPage(q) {
  page("", 760, skeleton());
  const capability = q.get("capability") ?? "";
  const agent = q.get("agent") ?? "";
  const viewKey = ACTIVITY_VIEWS.some(([k]) => k === q.get("view")) ? q.get("view") : "all";
  const [all, agents] = await Promise.all([caps(true), api("/agents").catch(() => [])]);
  setWallpaper(await hues(capability && all.get(capability) ? [tintOf(all.get(capability))] : []));
  const setQ = (k, v) => {
    const p = new URLSearchParams({ view: viewKey, capability, agent });
    v ? p.set(k, v) : p.delete(k);
    for (const [key, val] of [...p]) if (!val || (key === "view" && val === "all")) p.delete(key);
    go(`#/activity${[...p].length ? `?${p}` : ""}`);
  };
  const capChip = capability
    ? h("button", { class: "chip selected", onclick: () => setQ("capability", "") }, appIcon(all.get(capability) ?? { id: capability, name: capability }, { size: 24 }), all.get(capability)?.name ?? capability, h("span", { class: "x", "aria-label": "Clear" }, "×"))
    : h("button", { class: "chip plain" }, "All tools", h("span", { class: "caret" }));
  if (!capability) capChip.addEventListener("click", () => menuFrom(capChip, [...all.values()].filter((c) => c.version).map((c) => [capRef(c), () => setQ("capability", c.id)])));
  const agentChip = agent
    ? h("button", { class: "chip plain selected" }, agent === "you" ? "You" : actorLabel(agent, all), h("span", { class: "x", "aria-label": "Clear" }, "×"))
    : h("button", { class: "chip plain" }, "All agents", h("span", { class: "caret" }));
  agentChip.addEventListener("click", () => (agent ? setQ("agent", "") : menuFrom(agentChip, [["You", () => setQ("agent", "you")], ...agents.map((a) => [actorLabel(a.id, all), () => setQ("agent", a.id)])])));
  const seg = h("div", { class: "segmented" }, ACTIVITY_VIEWS.map(([k, label]) => h("button", { "aria-pressed": String(k === viewKey), onclick: () => setQ("view", k === "all" ? "" : k) }, label)));
  const head = [h("div", { class: "row between wrap" }, h("h1", { class: "flush" }, "Activity"), seg), h("div", { class: "row tight" }, capChip, viewKey !== "builds" && agentChip)];

  if (viewKey === "builds") return buildsView(head, capability, all);

  const cardEl = h("div", { class: "card timeline" });
  const more = h("button", { class: "ghost self-center" }, "Show more");
  let items = [];
  const kinds = ACTIVITY_VIEWS.find(([k]) => k === viewKey)[2];
  const load = async (before) => {
    const p = new URLSearchParams({ ...(capability ? { capability } : {}), ...(agent ? { agent } : {}), ...(before ? { before } : {}), ...(kinds ? { kinds } : {}), limit: "120" });
    const r = await api(`/activity?${p}`);
    items = [...items, ...r.items];
    render();
    more.hidden = !r.next;
    more.onclick = () => load(r.next).catch(fail);
  };
  const render = () => {
    if (!items.length) return cardEl.replaceWith(empty("Nothing yet", capability || agent || kinds ? "Nothing matches these filters." : "Calls, builds and access changes show up here."));
    const days = new Map();
    for (const g of groupItems(items)) {
      const d = dayLabel(g.at);
      if (!days.has(d)) days.set(d, []);
      days.get(d).push(g);
    }
    put(cardEl, ...[...days].map(([d, gs]) => [h("div", { class: "eyebrow" }, d), h("ul", { class: "list" }, gs.map((g) => activityRow(g, all, !capability)))]).flat());
  };
  page("", 760, head, cardEl, more);
  more.hidden = true;
  await load();
}

/**
 * H1 Activity › Builds: in progress, failed (and not dealt with), earlier. Real milestones only, no
 * progress bars. Live while something builds.
 */
async function buildsView(head, only, all0) {
  const load = () => Promise.all([api("/builds?n=200&brief=1"), caps(true).catch(() => all0)]);
  const root = h("div", { class: "card timeline builds" });
  const render = (builds, all) => {
    const list = only ? builds.filter((b) => b.capabilityId === only) : builds;
    const failed = new Set(unresolvedFailures(builds).map((b) => b.buildId));
    const live = list.filter((b) => LIVE_BUILD.has(b.status) || b.status === "review");
    const open = list.filter((b) => failed.has(b.buildId));
    const rest = list.filter((b) => !LIVE_BUILD.has(b.status) && b.status !== "review" && !failed.has(b.buildId));
    const nameOf = (b) => all.get(b.capabilityId)?.name ?? b.request?.name ?? b.capabilityId;
    const sub = (b) => {
      if (b.status === "waiting") return h("span", { class: "sub row tight" }, "Waiting for ", b.dependsOn ? h("a", { href: `#/b/${enc(b.dependsOn)}` }, b.queued ? "the change before it" : "another build") : "another build");
      if (b.status === "review") return h("span", { class: "sub" }, `${actorLabel(b.requestedBy, all)} changed it: it waits for you`);
      if (LIVE_BUILD.has(b.status)) return h("span", { class: "sub row tight" }, askedBy(b) && h("span", { class: "faint" }, `${askedBy(b)}on your ${builderLabel(b.builder)}`), milestones(b));
      const first = String(b.request?.request || b.request?.purpose || "").split("\n")[0];
      return h("span", { class: "sub clip-1" }, (b.status === "failed" && b.failure?.title) || (first.length > 140 ? `${first.slice(0, 140)}…` : first) || (b.kind === "widgets" ? "Suggested by the builder" : " "));
    };
    const right = (b) =>
      b.status === "promoted"
        ? kindTag(b.resultVersion ? `v${b.resultVersion}` : "done", "ok")
        : b.status === "failed"
          ? failed.has(b.buildId)
            ? h("button", { class: "sm", onclick: (e) => (e.stopPropagation(), api(`/builds/${enc(b.buildId)}/retry`, { method: "POST" }).then((n) => go(`#/b/${n.buildId}`), fail)) }, "Retry")
            : kindTag("failed", "danger")
          : b.status === "review"
            ? h("span", { class: "pill warn with-dot" }, "needs you")
            : b.status === "waiting"
              ? kindTag("waiting", "warn")
              : LIVE_BUILD.has(b.status)
                ? h("span", { class: "mono faint small" }, b.progress ? mmss(b.progress.elapsedSeconds * 1000) : "")
                : kindTag(b.status);
    const row = (b) => {
      const c = all.get(b.capabilityId) ?? { id: b.capabilityId, name: nameOf(b) };
      const lit = b.step?.step === "tests" && b.tests?.total ? b.tests.passed / b.tests.total : 0;
      return h(
        "li",
        { class: "link build-row", tabindex: 0, onclick: () => go(`#/b/${enc(b.buildId)}`), onkeydown: (e) => e.key === "Enter" && go(`#/b/${enc(b.buildId)}`) },
        appIcon(c, { size: 36, ...(LIVE_BUILD.has(b.status) ? { progress: lit, waiting: !lit } : {}), badge: failed.has(b.buildId) ? "danger" : null }),
        h("div", { class: "grow" }, h("span", {}, `${nameOf(b)} · ${kindWord(b)}`), sub(b)),
        h("span", { class: "small faint" }, LIVE_BUILD.has(b.status) ? "" : ago(b.updatedAt ?? b.createdAt)),
        right(b),
      );
    };
    const section = (title, items) => items.length > 0 && [h("div", { class: "eyebrow" }, title), h("ul", { class: "list" }, items.map(row))];
    put(root, !list.length && h("div", { class: "muted small builds-empty" }, "No builds yet."), section("In progress", live), section("Failed", open), section(open.length || live.length ? "Earlier" : "Recent", rest));
    return live.length > 0;
  };
  const [b0, a0] = await load();
  page("", 760, head, root);
  let timer;
  const poll = async () => {
    if (!document.body.contains(root)) return;
    const next = await load().catch(() => null);
    if (!document.body.contains(root)) return;
    timer = setTimeout(poll, !next || render(...next) ? 2500 : 15000);
  };
  timer = setTimeout(poll, render(b0, a0) ? 2500 : 15000);
  onLeave(() => clearTimeout(timer));
}

// ---------- L: Agents (agents that use your tools), O: who works for Hewn ----------

const SCOPES = [
  ["discover", "See your tools", "see your tools"],
  ["invoke", "Use them", "use tools"],
  ["create", "Make new ones", "make tools"],
  ["modify", "Change existing ones", "change tools"],
];
/** Scopes in words: "see, use, make". */
const scopeWords = (scopes) => {
  const s = new Set(scopes);
  const parts = [s.has("discover") && "see", s.has("invoke") && "use", s.has("create") && "make", s.has("modify") && "change"].filter(Boolean);
  return parts.length ? parts.join(", ") : "no access";
};

/**
 * Agents Hewn knows about. `where`: local (a CLI or app on this computer), cloud, or any (another MCP
 * client). `connect`: how to connect it (a harness id, "cloud", "other"), absent = coming soon.
 * `tool`: the CLI Hewn runs for its jobs (local agents only); `buildSoon`: could, later.
 * `apps`: it draws widgets in the chat (MCP Apps).
 */
const AGENT_CATALOG = [
  { id: "claude-code", label: "Claude Code", where: "local", connect: "claude-code", tool: "claude" },
  { id: "codex", label: "Codex", where: "local", connect: "codex", tool: "codex" },
  { id: "codex-desktop", label: "Codex Desktop", where: "local", connect: "codex-desktop", shares: "codex", apps: true },
  { id: "opencode", label: "OpenCode", where: "local", connect: "opencode", tool: "opencode" },
  { id: "claude-desktop", label: "Claude Desktop", where: "local", connect: "cloud-desktop", shares: "claude", match: /^claude(-ai)?$/, apps: true },
  { id: "gemini-cli", label: "Gemini CLI", where: "local", buildSoon: true },
  { id: "cursor", label: "Cursor", where: "local", apps: true },
  { id: "vscode", label: "VS Code (Copilot)", where: "local", apps: true },
  { id: "claude", label: "claude.ai", where: "cloud", connect: "cloud", match: /^claude(-ai)?$/, apps: true },
  { id: "chatgpt", label: "ChatGPT", where: "cloud", connect: "cloud", apps: true },
  { id: "gemini", label: "Gemini", where: "cloud" },
];
/**
 * Agents' tiles: [hue, logo, saturation %] (web/logos/, Simple Icons and LobeHub; see SOURCES.md).
 * Saturation 0 for the black-and-white brands: their logo black or white on grey.
 */
const TILES = { "claude-code": [30, "claude"], claude: [30, "claude"], "claude-desktop": [30, "claude"], codex: [200, "openai", 0], "codex-desktop": [200, "openai", 0], opencode: [90, "opencode", 0], chatgpt: [160, "openai", 0], "gemini-cli": [250, "googlegemini"], gemini: [250, "googlegemini"], cursor: [0, "cursor", 0], vscode: [220, "githubcopilot", 0] };
/** A tile with a brand's logo as a mask (it takes the tile's glyph colour), or the monogram. */
const logoTile = (hue, logo, letters, size, saturation = 100) =>
  h("span", { class: "app-icon", style: { "--size": `${size}px`, "--hue": hue, "--s": saturation / 100 }, "aria-hidden": "true" }, logo ? h("span", { class: "icon-mask logo", style: { "mask-image": `url(/logos/${logo}.svg)`, "-webkit-mask-image": `url(/logos/${logo}.svg)` } }) : letters);
/** An agent's tile, by id (claude-code-2 → claude-code) or by its name. */
const agentTile = (id, label = id, size = 44) => {
  if (id === "remote") return brandTile(size);
  const entry = AGENT_CATALOG.find((c) => id === c.id || String(id).startsWith(`${c.id}-`) || c.label === label || c.label === id);
  const [hue, logo, saturation] = TILES[entry?.id ?? id] ?? [260, null];
  return logoTile(hue, logo, String(label).replace(/[^A-Za-z]/g, "").slice(0, 2).toUpperCase() || "AG", size, saturation);
};
/** A model provider's tile. */
const providerTile = (id, size = 28) => logoTile({ anthropic: 30, openai: 160, openrouter: 250 }[id] ?? 200, id, PROVIDERS[id]?.label[0] ?? "?", size, { openai: 0, openrouter: 0 }[id]);
/** The catalog entry an MCP connection belongs to (for its tile), by id: claude-code, claude-code-2 … */
const catalogOf = (a) => AGENT_CATALOG.find((c) => a.id === c.id || a.id.startsWith(`${c.id}-`) || c.match?.test(a.id));
/** The local CLI an agent identity runs as, when Hewn can give it jobs (claude-code → claude). */
const toolOf = (a) => catalogOf(a)?.tool;

/** Hewn's jobs: who does them, and the CLIs that can (installed, signed in). */
async function buildJobs() {
  const [tools, s] = await Promise.all([api("/tools").catch(() => []), api("/settings")]);
  for (const t of tools) if (t.remote) rememberAgents([{ id: t.name, name: t.label }]);
  const ready = (t) => !!t?.found && t.loggedIn !== false;
  const label = (name) => tools.find((t) => t.name === name)?.label ?? name;
  return { tools, settings: s, ready, label };
}

/** Save who does these jobs (and that the owner chose them). */
async function setJobs(keys, tool) {
  const s = await api("/settings");
  settings = await api("/settings", { method: "PUT", body: { ...Object.fromEntries(keys.map((k) => [k, tool])), jobsChosen: [...new Set([...(s.jobsChosen ?? []), ...keys])] } });
  return settings;
}

const ALL_JOBS = ["intake", "builder"];
const agentTileOf = (t, size) => agentTile(t.harnessId ?? t.name, t.label, size);

/**
 * O2 Who builds tools: the signed-in agents on this machine (and the host's builder, if it runs
 * one); the agent talks requests through and builds them. `thenModel`: open the model sheet next
 * (switching agent means choosing its model; it remembers the last one).
 */
async function jobPicker({ thenModel = false } = {}) {
  const [{ tools, settings: s, ready }, machine] = await Promise.all([buildJobs(), hewnMachine()]);
  const options = [
    ...tools.map((t) => ({
      value: t.name,
      label: t.label,
      tile: agentTileOf(t, 28),
      disabled: !ready(t),
      sub: !ready(t) ? t.fix ?? "Not installed" : t.remote ? "" : `On ${machine.word} · signed in`,
    })),
    ...AGENT_CATALOG.filter((c) => c.buildSoon).map((c) => ({ value: c.id, label: c.label, tile: agentTile(c.id, c.label, 28), disabled: true, sub: "Coming soon" })),
  ];
  const chosen = buildsChosen(s) ? s.builder : null;
  const pick = await pickerSheet({ title: "Who builds tools?", options, value: chosen, note: "It talks each request through with you, then builds it.", confirm: (v) => `Use ${tools.find((t) => t.name === v)?.label ?? "it"}`, unchanged: false });
  if (!pick) return null;
  await setJobs(ALL_JOBS, pick);
  const t = tools.find((x) => x.name === pick);
  toast(`${t?.label ?? pick} builds tools`);
  if (thenModel && pick !== chosen) await modelSheet(t ?? { name: pick, label: pick });
  return pick;
}

/**
 * O3 The model and effort for building tools on one agent, from the agent's own list: Default
 * lets the CLI decide, a family (Fable) follows the newest, a pinned model stays put (once it's
 * gone, builds fail saying so until another is picked). Other… takes a full name.
 */
async function modelSheet(t) {
  // Read afresh: a provider signed in to since the last look shows at once.
  const [catalog, s] = await Promise.all([api(`/tools/${enc(t.name)}/models?fresh=1`), api("/settings")]);
  const cur = jobModelOf(s, "builder", t.name);
  const kindWords = { default: "lets it decide", family: "follows the newest", pinned: "stays on this one" };
  return formSheet({
    icon: agentTileOf(t, 44),
    title: "Model for building tools",
    sub: t.label,
    width: 520,
    build: (close) => {
      let chosen = cur.model ?? "default";
      const listed = catalog.models.some((m) => m.id === chosen);
      const name = `model-${Math.random().toString(36).slice(2)}`;
      const other = h("input", { type: "text", placeholder: catalog.otherHint ?? "model name", "aria-label": "Model name", value: listed ? "" : chosen, class: "mono" });
      const effort = h("select", { "aria-label": "Effort" });
      const efforts = () => (chosen === "" ? catalog.models[0]?.efforts ?? [] : catalog.models.find((m) => m.id === chosen)?.efforts ?? catalog.models[0]?.efforts ?? []);
      const effortField = h("label", { class: "field" }, h("span", { class: "label" }, "Effort"), effort);
      // The effort field shows for a model with levels; a model without has nothing to pick.
      const fillEffort = (keep) => {
        const list = efforts();
        const def = catalog.models.find((m) => m.id === chosen)?.defaultEffort;
        put(effort, h("option", { value: "" }, def ? `Default (${def})` : "Default"), list.map((e) => h("option", { value: e, selected: e === keep }, e[0].toUpperCase() + e.slice(1))));
        effortField.hidden = !list.length;
      };
      const rows = catalog.models.map((m) => {
        const radio = h("input", { type: "radio", name, checked: m.id === chosen });
        radio.addEventListener("change", () => ((chosen = m.id), fillEffort(effort.value)));
        // The model's own description (a family's or the default's says what it does), its successor, and whether it failed lately.
        const sub = [m.description ?? kindWords[m.kind], m.upgrade && `${m.upgrade} replaces it`, m.failed && `didn't run ${ago(m.failed.at)}: ${m.failed.reason}`].filter(Boolean).join(" · ");
        return h("label", { class: "job-option" }, radio, h("span", { class: "grow col" }, h("span", {}, m.label), sub && h("span", { class: "sub" }, sub)));
      });
      if (catalog.other) {
        const radio = h("input", { type: "radio", name, checked: !listed });
        const pickOther = () => ((radio.checked = true), (chosen = other.value.trim()), fillEffort(effort.value));
        radio.addEventListener("change", pickOther);
        other.addEventListener("input", pickOther);
        rows.push(h("label", { class: "job-option" }, radio, h("span", { class: "grow col" }, h("span", {}, "Other…"), h("span", { class: "sub" }, catalog.otherHint ? `By its full name (${catalog.otherHint})` : "By its full name"), other)));
      }
      fillEffort(cur.effort);
      const save = h("button", { class: "primary" }, "Save");
      save.addEventListener("click", async () => {
        const model = chosen && chosen !== "default" ? chosen : undefined;
        try {
          await saveBuildModel(s, t.name, { model, effort: effort.value || undefined });
          toast(`Builds tools: ${modelWords({ model, effort: effort.value || undefined }, catalog)}`);
          close(true);
        } catch (e) {
          fail(e);
        }
      });
      return [
        h("fieldset", { class: "job" }, rows),
        h("label", { class: "field" }, h("span", { class: "label" }, "Effort"), effort),
        h("div", { class: "small faint" }, "Agents that ask for a build can pick a model too, from the ones you allow (Settings › AI)."),
        sheetActions(h("button", { onclick: () => close() }, "Cancel"), save),
      ];
    },
  });
}

/** O4 The models agents may ask a build to use, for the agent that builds (Default always). */
async function agentModelsSheet(t) {
  const [catalog, s] = await Promise.all([api(`/tools/${enc(t.name)}/models`), api("/settings")]);
  const allowed = new Set(catalog.agentModels ?? ["default"]);
  const extra = [...allowed].filter((id) => !catalog.models.some((m) => m.id === id)).map((id) => ({ id, label: id, kind: "pinned" }));
  return formSheet({
    icon: agentTileOf(t, 44),
    title: "Models agents may ask for",
    sub: `When an agent asks ${t.label} for a build`,
    width: 520,
    build: (close) => {
      const boxes = [...catalog.models, ...extra].map((m) => ({ m, box: h("input", { type: "checkbox", checked: m.id === "default" || allowed.has(m.id), disabled: m.id === "default" }) }));
      const save = h("button", { class: "primary" }, "Save");
      save.addEventListener("click", async () => {
        const list = boxes.filter((b) => b.box.checked).map((b) => b.m.id);
        try {
          settings = await api("/settings", { method: "PUT", body: { agentModels: { ...(s.agentModels ?? {}), [t.name]: list } } });
          toast(`Agents may ask for ${list.length === 1 ? "the default only" : `${list.length} models`}`);
          close(true);
        } catch (e) {
          fail(e);
        }
      });
      return [
        h("div", { class: "stack-xs" }, boxes.map(({ m, box }) => h("label", { class: "check" }, box, h("span", {}, m.label, m.description && h("span", { class: "faint" }, ` · ${m.description}`))))),
        h("div", { class: "small faint" }, "An agent asking for one you haven't ticked gets told which it may use; nothing is built. Your own choices aren't limited."),
        sheetActions(h("button", { onclick: () => close() }, "Cancel"), save),
      ];
    },
  });
}

/** L1 Agents: one row per agent identity, with the parts it plays (role chips). */
async function agentsPage() {
  page("agents", 720, skeleton());
  const [agents, all, jobs, machine] = await Promise.all([api("/agents"), caps().catch(() => new Map()), buildJobs(), hewnMachine()]);
  rememberAgents(agents);
  setWallpaper(await hues([300, 125]));
  const { settings: s } = jobs;
  const from = (a) => (a.via === "local" ? `On ${machine.word}` : a.via === "tunnel" ? `Through ${a.address ?? "the public address"}` : "Connected");
  const roleChips = (a) => {
    const tool = toolOf(a);
    const jobChip = a.via === "local" && tool && s.builder === tool && buildsChosen(s) && h("a", { class: "pill", href: "#/settings/ai", onclick: (e) => e.stopPropagation() }, "builds tools");
    return h("div", { class: "role-chips" }, h("span", { class: "pill accent" }, "uses your tools"), jobChip);
  };
  const recent = (a) => a.lastUsedAt && Date.now() - Date.parse(a.lastUsedAt) < 5 * 60000;
  const row = (a) =>
    h(
      "li",
      { class: "link agent-row", tabindex: 0, onclick: () => agentSheet(a, all).then(() => route()), onkeydown: (e) => e.key === "Enter" && agentSheet(a, all).then(() => route()) },
      agentTile(catalogOf(a)?.id ?? a.id, a.name),
      h(
        "div",
        { class: "grow stack-xs" },
        h("span", { class: "row tight strong" }, h("span", { class: `dot ${recent(a) ? "ok" : ""}` }), a.name),
        h("span", { class: "sub" }, `${from(a)} · ${scopeWords(a.scopes)}${a.capabilities !== "*" ? " · some tools" : ""} · ${a.lastUsedAt ? ago(a.lastUsedAt) : "not used yet"}`),
        roleChips(a),
      ),
    );
  page(
    "agents",
    720,
    h("div", { class: "row between" }, h("h1", { class: "flush" }, "Agents"), h("button", { class: "primary", onclick: () => addSheet().then(() => !location.hash.startsWith("#/settings/ai/models") && route()) }, "Add…")),
    h("div", { class: "card list-card" }, h("ul", { class: "list" }, agents.length ? agents.map(row) : h("li", {}, h("span", { class: "grow muted" }, "No agents connected yet."), h("button", { class: "sm", onclick: () => connectDialog().then(() => route()) }, "Connect an agent")))),
    h("div", { class: "small faint" }, "What Hewn itself runs AI for is under ", h("a", { href: "#/settings/ai" }, "Settings › AI"), "."),
  );
}

/**
 * L2 An agent: its scopes as switches (each saves at once, with Undo), "only some tools" as a tool
 * picker, and Disconnect. Replaces the inline Edit.
 */
function agentSheet(a, all) {
  const max = new Set(a.maxScopes ?? SCOPES.map(([s]) => s));
  return modal(
    (close) => {
      const switches = h("div", { class: "settings-list" });
      const save = async (body, message, undo) => {
        const next = await api(`/agents/${enc(a.id)}`, { method: "PUT", body });
        Object.assign(a, body.scopes ? { scopes: body.scopes } : {}, body.capabilities ? { capabilities: body.capabilities } : {}, next?.scopes ? { scopes: next.scopes } : {});
        render();
        toast(message, { undo });
      };
      const render = () => {
        put(
          switches,
          SCOPES.filter(([scope]) => max.has(scope)).map(([scope, text, verb]) => {
            const sw = h("input", { type: "checkbox", class: "switch", checked: a.scopes.includes(scope), "aria-label": text });
            sw.addEventListener("change", () => {
              const before = [...a.scopes];
              const scopes = sw.checked ? [...new Set([...before, scope])] : before.filter((x) => x !== scope);
              save({ scopes }, sw.checked ? `${a.name} can now ${verb}` : `${a.name} can no longer ${verb}`, () => save({ scopes: before }, `Undone: ${a.name} settings restored`)).catch((e) => ((sw.checked = !sw.checked), fail(e)));
            });
            return h("label", { class: "setting compact" }, h("div", { class: "grow" }, h("span", {}, text)), sw);
          }),
          (() => {
            const some = a.capabilities !== "*";
            const sw = h("input", { type: "checkbox", class: "switch", checked: some, "aria-label": "Only some tools" });
            sw.addEventListener("change", () => save({ capabilities: sw.checked ? [] : "*" }, sw.checked ? `${a.name} sees no tools until you pick some` : `${a.name} sees all your tools`).catch(fail));
            return [
              h("label", { class: "setting compact" }, h("div", { class: "grow" }, h("span", {}, "Only some tools")), sw),
              some &&
                h(
                  "div",
                  { class: "row tight wrap cap-pick" },
                  [...all.values()]
                    .filter((c) => c.version)
                    .map((c) => {
                      const on = a.capabilities.includes(c.id);
                      return chip(c, undefined, {
                        class: `chip ${on ? "selected" : ""}`,
                        "aria-pressed": String(on),
                        onclick: () => {
                          const next = on ? a.capabilities.filter((x) => x !== c.id) : [...a.capabilities, c.id];
                          save({ capabilities: next }, on ? `${a.name} no longer sees ${c.name}` : `${a.name} sees ${c.name}`).catch(fail);
                        },
                      });
                    }),
                ),
            ];
          })(),
        );
      };
      render();
      const disconnect = h("button", { class: "ghost danger" }, "Disconnect");
      disconnect.addEventListener("click", async () => {
        if (!(await confirmDialog({ title: `Disconnect ${a.name}?`, body: "It loses all access on its next call. It can ask to connect again, and you approve it again.", confirm: "Disconnect", danger: true }))) return;
        try {
          await api(`/agents/${enc(a.id)}`, { method: "DELETE" });
          toast(`Disconnected ${a.name}`);
          close();
        } catch (e) {
          fail(e);
        }
      });
      return [
        sheetHead(agentTile(catalogOf(a)?.id ?? a.id, a.name, 44), a.name, `${a.via === "local" ? "On Hewn's machine" : a.via === "tunnel" ? `Through ${a.address ?? "the public address"}` : "Connected"}${a.createdAt ? ` · connected ${ago(a.createdAt)}` : ""}`),
        switches,
        h("div", { class: "actions flush between" }, disconnect, h("button", { class: "primary", onclick: () => close() }, "Done")),
      ];
    },
    { width: 480 },
  );
}

/**
 * An agent asking to connect, as a Request: who it is (its name is self-asserted, so where it
 * returns to is shown too), the code its browser shows, and what it may do. Unticking narrows;
 * nothing can be added beyond what it asked for.
 */
async function agentRequestSheet(p, { inline } = {}) {
  const all = await caps().catch(() => new Map());
  const picked = new Set(p.suggested);
  const name = h("input", { type: "text", value: p.suggestedName, "aria-label": "Agent name", maxlength: 40 });
  const currentCaps = Array.isArray(p.current?.capabilities) ? p.current.capabilities : null;
  const onlySome = h("input", { type: "checkbox", class: "switch", checked: !!currentCaps, "aria-label": "Only some tools" });
  const capList = h("div", { class: "cap-pick row tight wrap", hidden: !currentCaps }, [...all.values()].filter((c) => c.version).map((c) => h("label", { class: "chip plain" }, h("input", { type: "checkbox", value: c.id, checked: !!currentCaps?.includes(c.id) }), appIcon(c, { size: 20 }), c.name)));
  onlySome.addEventListener("change", () => (capList.hidden = !onlySome.checked));
  const decide = async (approve) => {
    const body = approve ? { approve: true, name: name.value.trim() || p.suggestedName, scopes: [...picked], capabilities: onlySome.checked ? [...capList.querySelectorAll("input:checked")].map((x) => x.value) : "*" } : { approve: false };
    const r = await api(`/agents/pending/${enc(p.id)}`, { method: "POST", body });
    toast(approve ? `${name.value.trim() || p.suggestedName} is connected` : `Declined ${p.clientName}`);
    pollInbox();
    return approve ? r.agentId ?? true : null;
  };
  const rows = SCOPES.filter(([scope]) => p.requested.includes(scope)).map(([scope, text]) => {
    const sw = h("input", { type: "checkbox", class: "switch", checked: picked.has(scope), "aria-label": text });
    sw.addEventListener("change", () => (sw.checked ? picked.add(scope) : picked.delete(scope)));
    const added = p.current && !p.current.scopes.includes(scope);
    // "Change existing ones" stays amber on purpose: an agent that can change tools can change what
    // the code behind your data does (owner, 2026-10-19).
    return { pill: kindTag(scope === "discover" || scope === "invoke" ? "use" : "make", scope === "modify" ? "warn" : ""), main: h("span", {}, text), sub: added ? "New: it doesn't have this now" : null, control: sw };
  });
  const extra = h(
    "div",
    { class: "stack-sm" },
    h("label", { class: "setting compact" }, h("div", { class: "grow" }, h("span", {}, "Only some tools")), onlySome),
    capList,
    h("label", { class: "field" }, h("span", { class: "label" }, p.reconnects ? `Name · replaces “${p.reconnects}” if kept` : "Name"), name),
    h("div", { class: "small faint row tight" }, "Check the code matches the one in its browser window:", h("code", { class: "user-code" }, p.userCode)),
  );
  const opts = {
    icon: agentTile(p.clientName, p.clientName, 48),
    title: `${p.clientName} wants to connect`,
    sub: `${p.via === "local" ? "On Hewn's machine" : `Through ${p.address ?? "the public address"}`} · returns to ${p.redirectHost} · ${ago(p.createdAt)}`,
    rows,
    extra,
    decline: "Decline",
    accept: "Approve",
    onAccept: async (close) => close(await decide(true)),
    onDecline: async (close) => close(await decide(false)),
  };
  if (!inline) return requestSheet(opts);
  // Inside the Connect sheet: the same Request, in place.
  const el = h("div", { class: "card pending-card stack-md" }, sheetHead(opts.icon, opts.title, opts.sub), requestRows(rows), extra, sheetActions(h("button", { onclick: () => decide(false).then(inline, fail) }, "Decline"), h("button", { class: "primary", onclick: () => decide(true).then(inline, fail) }, "Approve")));
  return el;
}

/**
 * L3 An agent's destructive call, as a Request: what it wants to delete, on which tool and with
 * what input, its note, and a timer; Stop or Allow once. The agent is blocked until you decide.
 */
async function confirmationSheet(c) {
  const all = await caps().catch(() => new Map());
  const cap = all.get(c.capabilityId) ?? { id: c.capabilityId, name: c.capabilityId };
  const who = actorLabel(c.agentId, all);
  const [op] = c.operation.split("@");
  const ids = c.input && typeof c.input === "object" ? Object.entries(c.input).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ") : "";
  const words = op.replace(/_/g, " ");
  const timer = h("span", {});
  const tick = () => (timer.textContent = `It's waiting · ${mmss(Date.now() - Date.parse(c.createdAt))}`);
  tick();
  const t = setInterval(tick, 1000);
  const decide = (approve) => async (close) => {
    await api(`/confirmations/${enc(c.id)}`, { method: "POST", body: { approve } });
    toast(approve ? `${who} may run it now` : "Stopped it");
    pollInbox();
    close(approve);
  };
  return requestSheet({
    icon: agentTile(c.agentId, who, 48),
    title: `${who} wants to ${words}`,
    sub: timer,
    rows: [{ pill: kindTag("destructive", "danger"), main: h("span", { class: "row tight wrap" }, h("span", { class: "mono" }, op), "on", capRef(cap, c.capabilityId)), sub: ids || "no input", mono: true }],
    quote: c.note,
    decline: "Stop",
    accept: "Allow once",
    danger: true,
    onAccept: decide(true),
    onDecline: decide(false),
  }).finally(() => clearInterval(t));
}

/**
 * O5 Add…: the three ways AI touches Hewn, so adding something also teaches the model: an agent
 * that uses your tools, an agent that works for Hewn, a model provider.
 */
/** Resolves once the chosen flow (if any) is done. */
async function addSheet() {
  const next = await modal(
    (close) => {
      const choice = (hue, glyph, title, sub, fn) =>
        h("li", { class: "link add-choice", tabindex: 0, onclick: () => close(fn), onkeydown: (e) => e.key === "Enter" && close(fn) }, h("span", { class: "app-icon md", style: { "--hue": hue } }, glyph), h("div", { class: "grow" }, h("span", { class: "strong" }, title), h("span", { class: "sub" }, sub)));
      return [
        h("h2", { class: "flush" }, "Add"),
        h(
          "ul",
          { class: "list" },
          choice(30, "↘", "An agent that uses your tools", "Claude Code, Codex, OpenCode, claude.ai, ChatGPT, any MCP client", () => connectDialog()),
          // Hosted: the host builds; there are no agents on the machine to work for Hewn.
          !settings?.hosted && choice(125, "↗", "An agent that works for Hewn", "Builds tools · runs on this machine", () => hewnAgentsSheet()),
          // Hosted: tools that think run on the host's models.
          !settings?.hosted && choice(200, "$", "A model provider", "Anthropic, OpenAI, OpenRouter · for tools that think", () => go("#/settings/ai/models")),
        ),
        sheetActions(h("button", { onclick: () => close() }, "Close")),
      ];
    },
    { width: 520 },
  );
  // After the sheet has closed: a route() in between would close the next sheet as it opens.
  if (typeof next === "function") await next();
}

/**
 * O7 Agents for Hewn's jobs: the CLIs on this machine (installed, signed in, or coming soon). "How"
 * shows the one sign-in command; "Use" opens the job picker. Look again after installing.
 */
function hewnAgentsSheet() {
  return modal(
    (close) => {
      const list = h("ul", { class: "list" }, h("li", {}, skeleton("60%")));
      const detail = h("div", {});
      const render = async () => {
        const [{ tools, ready, settings: s }, machine] = await Promise.all([buildJobs(), hewnMachine()]);
        const does = (t) => (s.builder === t.name && buildsChosen(s) ? ["builds tools"] : []);
        put(
          list,
          tools.map((t) =>
            h(
              "li",
              {},
              agentTile(t.harnessId ?? t.name, t.label),
              h("div", { class: "grow" }, h("span", {}, t.label), h("span", { class: "sub" }, !t.found ? "Not installed" : ready(t) ? ["Installed · signed in", ...does(t)].join(" · ") : "Installed · not signed in")),
              ready(t)
                ? h("button", { class: "primary sm", onclick: () => pickJob(t) }, "Use")
                : h("button", { class: "sm", onclick: () => put(detail, h("div", { class: "stack-sm" }, h("div", { class: "small" }, `${t.label}, in a terminal on ${machine.word}:`), commandBlock(t.fix?.replace(/^(Install it|Sign in): (run )?/, "") ?? t.name)) ) }, "How"),
            ),
          ),
          AGENT_CATALOG.filter((c) => c.buildSoon).map((c) => h("li", { class: "soon" }, agentTile(c.id, c.label), h("div", { class: "grow" }, h("span", {}, c.label), h("span", { class: "sub" }, "Coming soon")))),
        );
      };
      const pickJob = async (t) => {
        await setJobs(ALL_JOBS, t.name);
        toast(`${t.label} builds tools`);
        render();
      };
      render();
      return [h("h2", { class: "flush" }, `Agents on this machine`), list, detail, h("div", { class: "actions flush between" }, h("button", { class: "ghost", onclick: render }, "Look again"), h("button", { class: "primary", onclick: () => close() }, "Done"))];
    },
    { width: 520 },
  );
}

// ---------- L4: Connect an agent ----------

/** Connect an agent. `agentId` (claude-code, codex) skips the list and connects that one; "cloud" and "other" open those steps. */
function connectDialog(agentId) {
  return modal(
    (close, dlg) => {
      const body = h("div", { class: "stack-lg" }, h("div", { class: "sheet-title" }, "Connect an agent"), skeleton("80%", "60%"));
      const back = () => h("div", { class: "actions flush between" }, h("button", { class: "ghost", onclick: showList }, "‹ Back"), h("button", { onclick: () => close() }, "Done"));
      const steps = (...items) => h("ol", { class: "steps plain small" }, items.filter(Boolean).map((s) => h("li", {}, s)));
      const showList = async () => {
        let list = [];
        let err = null;
        const machine = await hewnMachine();
        // Hosted: no agents on the machine to list; everything connects through the public address.
        if (!settings?.hosted) {
          try {
            list = await api("/setup/agents");
          } catch (e) {
            err = e;
          }
        }
        if (agentId === "cloud" || agentId === "other" || agentId === "cloud-desktop") {
          const how = agentId;
          agentId = undefined;
          return manual(how !== "other", how === "cloud-desktop");
        }
        const direct = agentId && list.find((x) => x.agentId === agentId && x.found);
        if (direct) {
          agentId = undefined;
          return connecting(direct);
        }
        put(
          body,
          h("div", { class: "sheet-title" }, "Connect an agent"),
          err && errorBox(err),
          h(
            "ul",
            { class: "list" },
            machine.here === "public" && h("li", {}, agentTile("claude-code", "Claude Code"), h("div", { class: "grow" }, h("span", {}, "An agent on the device you're using"), h("span", { class: "sub" }, "It connects to Hewn's public address")), h("button", { class: "sm", onclick: () => remote() }, "How")),
            list.map((x) => {
              const via = x.via && list.find((y) => y.agentId === x.via);
              const sub = x.cloud ? "Through your public address, like claude.ai" : !x.found ? `Not found on ${machine.word}` : x.connected ? "Connected" : `Found on ${machine.word}`;
              const button = x.cloud
                ? h("button", { class: "sm", onclick: () => manual(true, true) }, "How")
                : x.found && (!via || via.found)
                  ? x.connected
                    ? h("button", { class: "ghost sm", onclick: () => connecting(x) }, "Sign in again")
                    : h("button", { class: "primary sm", onclick: () => connecting(x) }, "Connect")
                  : null;
              return h("li", { class: x.found || x.cloud ? "" : "soon" }, agentTile(x.agentId, x.label), h("div", { class: "grow" }, h("span", {}, x.label), h("span", { class: "sub" }, sub)), button);
            }),
            h("li", {}, agentTile("claude", "claude.ai"), h("div", { class: "grow" }, h("span", {}, "claude.ai, ChatGPT"), h("span", { class: "sub" }, "Through your public address")), h("button", { class: "sm", onclick: () => manual(true) }, "How")),
            h("li", {}, h("span", { class: "app-icon md add" }, "+"), h("div", { class: "grow" }, h("span", {}, "Anything else"), h("span", { class: "sub" }, "MCP address + sign-in")), h("button", { class: "sm", onclick: () => manual(false) }, "How")),
          ),
          h("div", { class: "small faint" }, `Coming soon: ${AGENT_CATALOG.filter((c) => !c.connect).map((c) => c.label).join(", ")}.`),
          sheetActions(h("button", { onclick: () => close() }, "Close")),
        );
      };

      // An agent on the owner's own computer, reaching Hewn on a server through the public address.
      const remote = async () => {
        const m = await api("/setup/manual").catch((e) => (fail(e), null));
        if (!m?.publicUrl) return;
        put(
          body,
          h("div", { class: "sheet-title" }, "An agent on your device"),
          commandBlock(m.publicUrl, "Address"),
          steps("Add Hewn as a streamable HTTP MCP server with the address above.", "Its sign-in opens in your browser: approve it there.", "Claude Code only has a terminal for this. Paste:"),
          commandBlock(`claude mcp add --transport http hewn ${m.publicUrl}`),
          back(),
        );
      };

      const manual = async (cloud, desktop = false) => {
        const m = await api("/setup/manual").catch((e) => (fail(e), null));
        if (!m) return;
        const address = cloud || settings?.hosted ? m.publicUrl : m.url;
        put(
          body,
          h("div", { class: "sheet-title" }, desktop ? "Claude Desktop" : cloud ? "claude.ai and ChatGPT" : "Another MCP client"),
          cloud && !address && settings?.hosted
            ? h("div", { class: "notice" }, h("span", {}, "Your address isn't ready yet. Try again in a minute."))
            : cloud && !address
            ? [h("div", { class: "notice" }, h("span", {}, m.tunnel?.kind ? `Your tunnel is ${m.tunnel.state}${m.tunnel.error ? `: ${m.tunnel.error}` : ""}.` : "Agents in the cloud need a public address. Only MCP and sign-in go through it.")), h("div", { class: "small" }, "Start a tunnel in a terminal (only a terminal can):"), commandBlock(`${CLI} tunnel start --quick`)]
            : commandBlock(address, "Address"),
          address &&
            (desktop
              ? steps("Settings › Connectors › Add custom connector, and paste the address.", "Connect: approve it in Hewn when it asks.", "Paste the text below into Settings › Profile.")
              : cloud
                ? steps("claude.ai: Settings › Connectors › Add custom connector. ChatGPT: Settings › Connectors › Create.", "Paste the address. Connect, then approve it in Hewn.", "Paste the text below into your profile or custom instructions, so it thinks of Hewn.")
                : steps("Add Hewn as a streamable HTTP MCP server with this address.", "It signs in with OAuth: approve it in Hewn when it asks.")),
          cloud && address && m.pointer && commandBlock(m.pointer, "Instructions"),
          back(),
        );
      };

      const connecting = async (x) => {
        const words = (s) => (s.kind === "cleanup" ? "Removing the old token" : s.kind === "register" ? `Adding ${BRAND} to ${x.label}` : s.kind === "pointer" ? `Telling ${x.label} where to look` : `${x.label} signs in`);
        let plan = [];
        const state = []; // per step: done | live | fail
        let error = null;
        let finished = false;
        let lastLine = "";
        let signIn = null; // the sign-in page, for when no browser opened by itself
        const waiting = h("div", { class: "stack-md" });
        const offer = h("div", {});
        const render = () => {
          const labels = plan.map(words);
          const states = labels.map((_, i) => state[i] ?? (i === state.length && !error ? "live" : "todo"));
          put(
            body,
            sheetHead(agentTile(x.agentId, x.label, 44), finished && !error ? `${x.label} is connected` : `Connecting ${x.label}`, finished && !error ? h("span", { class: "pill accent" }, "uses your tools") : null),
            !finished && h("ol", { class: "steps" }, labels.map((l, i) => stepRow(l, states[i], i === plan.length - 1 && states[i] === "live" ? lastLine : "", states[i] === "fail" ? error : null))),
            error && errorBox(new Error(error)),
            !finished && !error && signIn && h("div", { class: "small" }, "No browser page opened? ", h("a", { href: signIn, target: "_blank", rel: "noopener" }, "Open the sign-in page"), "."),
            waiting,
            finished && !error && offer,
            finished && !error && h("div", { class: "small faint" }, "Start a new session so it sees the tools."),
            (error || finished) && sheetActions(error ? h("button", { onclick: showList }, "Back") : h("button", { class: "primary", onclick: () => close(true) }, "Done")),
          );
        };
        // O6: an agent on this machine can also build tools for Hewn; it starts unticked.
        const showOffer = async () => {
          const tool = AGENT_CATALOG.find((c) => c.connect === x.agentId)?.tool;
          if (!tool) return;
          const { tools, ready, settings: s, label } = await buildJobs();
          if (!ready(tools.find((t) => t.name === tool))) return;
          // Already the one building tools: nothing to offer.
          if (buildsChosen(s) && s.builder === tool) return;
          const sw = h("input", { type: "checkbox", class: "switch", "aria-label": "Build tools" });
          sw.addEventListener("change", async () => {
            try {
              if (sw.checked) await setJobs(ALL_JOBS, tool);
            } catch (e) {
              sw.checked = false;
              fail(e);
            }
          });
          put(
            offer,
            h("div", { class: "eyebrow" }, "It can also work for Hewn"),
            h("label", { class: "setting compact" }, h("div", { class: "grow" }, h("span", {}, "Build tools"), h("span", { class: "sub" }, `Today: ${buildsChosen(s) ? label(s.builder) : "nobody"}`)), sw),
          );
        };
        // While it signs in, its request appears here to approve without leaving the sheet.
        const seen = new Set((await api("/agents/pending").catch(() => [])).map((p) => p.id));
        let poll = null;
        const watch = () => {
          if (poll) return;
          poll = setInterval(async () => {
            const fresh = (await api("/agents/pending").catch(() => [])).filter((p) => !seen.has(p.id));
            if (!fresh.length) return;
            fresh.forEach((p) => seen.add(p.id));
            put(waiting, await agentRequestSheet(fresh[0], { inline: () => put(waiting) }));
          }, 1500);
        };
        dlg.addEventListener("close", () => clearInterval(poll), { once: true });
        dlg.addEventListener("cancel", (e) => !finished && !error && plan.length && e.preventDefault(), { once: true });
        render();
        try {
          await postStream(`/setup/agents/${enc(x.agentId)}`, (name, data) => {
            if (name === "plan") plan = data.steps;
            if (name === "step") data.ok ? (state[data.index] = "done") : ((state[data.index] = "fail"), (error = data.error));
            if (name === "login") {
              if (data.waiting) watch();
              if (data.line) lastLine = data.line.length > 90 ? `${data.line.slice(0, 90)}…` : data.line;
              if (data.authorizeUrl) signIn = data.authorizeUrl;
            }
            if (name === "done") {
              finished = true;
              clearInterval(poll);
              put(waiting);
              showOffer();
            }
            render();
          });
        } catch (e) {
          error = e.message;
          render();
        }
      };

      showList();
      return body;
    },
    { width: 520 },
  );
}

// ---------- Settings: General · AI · Remote access · Data · About ----------

const SECTIONS = [
  ["general", "General"],
  ["ai", "AI"],
  ["remote", "Remote access"],
  ["data", "Data"],
  ["about", "About"],
];

/** A settings page: the left list of sections, then this one. */
function settingsFrame(section, ...content) {
  view(
    topBar("settings"),
    sandboxNotice(),
    h(
      "main",
      { class: "settings-layout" },
      h("nav", { class: "side-list", "aria-label": "Settings" }, h("div", { class: "eyebrow" }, "Settings"), SECTIONS.map(([k, label]) => h("a", { class: "side-item", href: `#/settings/${k}`, "aria-current": k === section ? "page" : undefined }, label))),
      h("div", { class: "settings-main" }, content),
    ),
  );
}
const setting = (title, sub, ...control) => h("div", { class: "setting" }, h("div", { class: "grow" }, h("span", {}, title), sub && h("span", { class: "sub" }, sub)), control);
const settingsCard = (...rows) => h("div", { class: "card settings-card" }, rows);

async function settingsPage(section = "general", sub) {
  settingsFrame(section, skeleton());
  setWallpaper(await hues([200, 125]));
  if (section === "ai" && sub === "models") return modelsPage();
  if (section === "ai") return aiSection();
  if (section === "remote") return remoteSection();
  if (section === "data") return dataSection();
  if (section === "about") return aboutSection();
  return generalSection();
}

const saveSettings = async (change, message) => {
  try {
    settings = await api("/settings", { method: "PUT", body: change });
    toast(message);
  } catch (e) {
    fail(e);
  }
  route();
};

/** N1 General: appearance, the owner's time zone, the sandbox. */
async function generalSection() {
  const s = (settings = await api("/settings"));
  const sandbox = h("input", { type: "checkbox", class: "switch danger", checked: s.sandbox, "aria-label": "Sandbox" });
  sandbox.addEventListener("change", async () => {
    if (sandbox.checked) return saveSettings({ sandbox: true }, "Sandbox is on");
    const ok = await confirmDialog({ title: "Turn off the sandbox?", body: "Tool code and builders then run with your full access, network included, until you turn it back on.", confirm: "Turn off", danger: true });
    if (ok) saveSettings({ sandbox: false }, "Sandbox is off");
    else sandbox.checked = true;
  });
  const theme = localStorage.getItem(THEME_KEY) ?? "system";
  const appearance = segmented([["system", "System"], ["dark", "Dark"], ["light", "Light"]], theme, (v) => (v === "system" ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, v), applyTheme(v)), { label: "Appearance" });
  const zone = s.timeZone ?? browserZone();
  settingsFrame(
    "general",
    h("h1", { class: "flush" }, "General"),
    settingsCard(
      setting("Appearance", null, appearance),
      setting("Time zone", `${zone}${zone === browserZone() ? " · from this browser" : ""} · new schedules use it`, h("button", { class: "sm", onclick: () => timeZoneSheet(zone) }, "Change")),
      // Hosted: the host runs the sandbox.
      !s.hosted && setting("Sandbox", "Confines tool code and its network access", sandbox),
    ),
  );
}

function timeZoneSheet(current) {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [current];
  return formSheet({
    title: "Time zone",
    sub: "New schedules run in it. Schedules you already have keep theirs.",
    build: (close) => {
      const select = h("select", { "aria-label": "Time zone" }, zones.map((z) => h("option", { value: z, selected: z === current }, z)));
      return [
        h("label", { class: "field" }, h("span", { class: "label" }, "Time zone"), select),
        h("button", { class: "link self-start", onclick: () => (select.value = browserZone()) }, `Use this browser's (${browserZone()})`),
        sheetActions(h("button", { onclick: () => close() }, "Cancel"), h("button", { class: "primary", onclick: () => (close(), saveSettings({ timeZone: select.value }, `Time zone: ${select.value}`)) }, "Save")),
      ];
    },
  });
}

/**
 * O1 Settings › AI: what Hewn runs AI for. Building tools (talking a request through, then building
 * it) runs one agent, on this machine and its own account, or the host's builder. Thinking inside
 * tools is a metered API call with your key.
 */
async function aiSection() {
  const [{ tools, settings: s, ready }, m, machine] = await Promise.all([buildJobs(), api("/models").catch(() => null), hewnMachine()]);
  const tile = (t) => agentTileOf(t, 20);
  const builder = tools.find((x) => x.name === s.builder);
  const catalogs = new Map([[s.builder, await api(`/tools/${enc(s.builder)}/models`).catch(() => null)]]);
  const agentWords = (t) => (t.remote && ready(t) ? t.label : `${t.label}${t.remote ? "" : ` on ${machine.word}`} · ${ready(t) ? "signed in" : t.fix ?? "not ready"}`);
  /** Who builds tools, on which model; Change picks the agent, Model… the model and effort. */
  const buildsRow = () => {
    const chosen = buildsChosen(s);
    return h(
      "div",
      { class: "setting" },
      h("div", { class: "grow" }, h("span", { class: "strong" }, "Builds tools"), h("span", { class: "sub row tight" }, chosen && builder ? [tile(builder), `${agentWords(builder)} · ${modelWords(jobModelOf(s, "builder"), catalogs.get(builder.name))}`] : "Not chosen")),
      chosen && builder && h("button", { class: "sm", onclick: () => modelSheet(builder).then((saved) => saved && route()) }, "Model…"),
      // Hosted: the host builds; only the model and effort are the owner's.
      !s.hosted && h("button", { class: "sm", onclick: () => jobPicker({ thenModel: true }).then(() => route()) }, chosen ? "Change" : "Choose…"),
    );
  };
  const n = s.maxBuildAttempts;
  const attempts = h(
    "span",
    { class: "stepper" },
    h("button", { "aria-label": "Fewer attempts", disabled: n <= 1, onclick: () => saveSettings({ maxBuildAttempts: n - 1 }, `Build attempts: ${n - 1}`) }, "−"),
    h("output", { title: "Build attempts" }, String(n)),
    h("button", { "aria-label": "More attempts", disabled: n >= 5, onclick: () => saveSettings({ maxBuildAttempts: n + 1 }, `Build attempts: ${n + 1}`) }, "+"),
  );
  const builds = buildsRow();
  // As the server has it (the owner's ticks, else its default for this agent).
  const allowed = catalogs.get(s.builder)?.agentModels ?? ["default"];
  const asks =
    builder &&
    h(
      "div",
      { class: "setting" },
      h("div", { class: "grow" }, h("span", { class: "strong" }, "Agents may ask for"), h("span", { class: "sub" }, allowed.map((id) => catalogs.get(s.builder)?.models.find((x) => x.id === id)?.label ?? id).join(", "))),
      h("button", { class: "sm", onclick: () => agentModelsSheet(builder).then((saved) => saved && route()) }, "Change…"),
    );
  const prov = m?.provider && m.providers.find((p) => p.id === m.provider);
  // The owner's standing rules for building: the intake remembers them, the builder reads them on every build.
  const rules = await api("/instructions").then((r) => r.lines).catch(() => []);
  const instructions = h(
    "div",
    { class: "setting" },
    h("div", { class: "grow" }, h("span", { class: "strong" }, "Instructions for building"), h("span", { class: "sub clip-1" }, rules.length ? `${plural(rules.length, "rule")} · ${rules.join(" · ")}` : "None yet · tell the intake a rule, or write one here")),
    h("button", { class: "sm", onclick: () => instructionsSheet().then((saved) => saved && route()) }, "Edit…"),
  );
  settingsFrame(
    "ai",
    h("div", { class: "row between" }, h("h1", { class: "flush" }, "AI"), h("button", { onclick: () => addSheet().then(() => !location.hash.startsWith("#/settings/ai/models") && route()) }, "Add…")),
    settingsCard(
      h("div", { class: "setting-with-extra" }, builds, h("div", { class: "row tight attempts" }, h("span", { class: "small faint" }, "Build attempts"), attempts)),
      asks,
      instructions,
      h(
        "div",
        { class: "setting" },
        h(
          "div",
          { class: "grow" },
          h("span", { class: "strong" }, "Thinks inside tools"),
          h(
            "span",
            { class: "sub row tight" },
            // Hosted: included; what was used this month (it's implied who runs them).
            m?.host
              ? m.host.charges.totals.length ? `${m.host.charges.totals.map(creditWords).join(", ")} used this month` : "Included"
              : prov
                ? [providerTile(prov.id, 20), `${PROVIDERS[prov.id].label} API · your key · ${usd(m.spend.totalUsd)} of ${usd(m.spend.capUsd)} this month`]
                : "No provider yet · your key, metered",
          ),
        ),
        h("a", { class: "btn sm", href: "#/settings/ai/models" }, "Models ›"),
      ),
    ),
    !builder?.remote && h("div", { class: "small faint" }, "Building runs on the agent's own account (a subscription, an API key or a cloud provider), including builds an agent asks for. Thinking inside tools uses your model key, metered."),
    h("div", { class: "small faint" }, "Agents that use your tools are on ", h("a", { href: "#/agents" }, "Agents"), "."),
  );
}

/** M1 Remote access: the public address (DNS and Caddy behind Set up…), passkeys, signed-in browsers. */
async function remoteSection() {
  const [remote, sessions] = await Promise.all([api("/remote").catch(() => null), api("/sessions").catch(() => [])]);
  const removePasskey = (p) => async () => {
    if (!(await confirmDialog({ title: `Remove “${p.name}”?`, body: settings?.hosted ? "That device then signs in from your account again." : "That device then needs a sign-in link from the server again.", confirm: "Remove", danger: true }))) return;
    try {
      await api(`/passkeys/${enc(p.id)}`, { method: "DELETE" });
      toast("Passkey removed");
      route();
    } catch (e) {
      fail(e);
    }
  };
  const addHere = async () => {
    try {
      await addPasskey(deviceName(navigator.userAgent));
      toast("Passkey added");
      route();
    } catch (e) {
      fail(new Error(passkeyError(e)));
    }
  };
  const revoke = (x) => async () => {
    try {
      await api(`/sessions/${enc(x.id)}`, { method: "DELETE" });
      toast("Signed out that browser");
      route();
    } catch (e) {
      fail(e);
    }
  };
  const signOut = async () => {
    await api("/sessions/signout", { method: "POST" }).catch(() => {});
    location.reload();
  };
  const setUp = () =>
    formSheet({
      title: "Public address",
      sub: remote?.url ?? "Not set",
      width: 520,
      build: (close) => [
        remote?.url
          ? [
              h("div", { class: "small" }, "1. DNS: an A record at your DNS provider."),
              remote.records.map((r) => commandBlock(`${r.name}  ${r.type}  ${r.value}`, "Record")),
              h("div", { class: "small" }, `2. HTTPS: a reverse proxy for ${new URL(remote.url).host}, forwarding to Hewn's public listener (keep the Host header; ${CLI} url prints its exact address). Caddy:`),
              commandBlock(`${new URL(remote.url).host} {\n  reverse_proxy ${remote.proxyTo}\n}`, "Caddy block"),
              h("div", { class: "small" }, "3. Sign in on your phone or laptop with a link from the server, then add a passkey there:"),
              commandBlock(`${CLI} open --print`),
            ]
          : [h("div", { class: "small" }, "Give Hewn an address you own, on the machine it runs on (only a terminal can):"), commandBlock(`${CLI} url https://hewn.example.com`), h("div", { class: "small faint" }, "It then prints the DNS record and the reverse proxy setup.")],
        sheetActions(h("button", { class: "primary", onclick: () => close() }, "Done")),
      ],
    });
  settingsFrame(
    "remote",
    h("h1", { class: "flush" }, "Remote access"),
    // Hosted: the address is the host's; nothing to set up.
    settingsCard(setting("Public address", remote?.url ? remote.url : settings?.hosted ? "Not set up yet" : "Not set: Hewn is only on this machine", !settings?.hosted && h("button", { class: "sm", onclick: setUp }, "Set up…"))),
    remote &&
      h(
        "div",
        { class: "card settings-card" },
        h("div", { class: "eyebrow card-eyebrow" }, "Passkeys"),
        remote.passkeys.map((p) => setting(p.name, `${p.works ? "Passkey" : `For ${p.host}, not the current address`} · added ${ago(p.createdAt)} · last used ${p.lastUsedAt ? ago(p.lastUsedAt) : "never"}`, h("button", { class: "sm ghost danger", onclick: removePasskey(p) }, "Remove"))),
        !remote.passkeys.length && setting("None yet", settings?.hosted ? "Added on the device that uses them: sign in there from your account, then add one." : remote.url ? `Added on the device that uses them: sign in there with ${CLI} open --print, then add one.` : "Passkeys work on the public address."),
        // Not once this browser has one for this address (made here, or signed in with).
        remote.here === "public" && passkeysSupported() && !remote.passkeys.some((p) => p.works && knownPasskeys().includes(p.id)) && setting("Add a passkey", "On this device: it signs in with Face ID, a fingerprint or the screen lock", h("button", { class: "sm", onclick: addHere }, "Add passkey")),
      ),
    h(
      "div",
      { class: "card settings-card" },
      h("div", { class: "eyebrow card-eyebrow" }, "Signed-in browsers"),
      sessions.map((x) => setting(deviceName(x.userAgent), `${x.current ? "This browser · " : ""}last used ${x.lastSeenAt ? ago(x.lastSeenAt) : "never"} · signed in ${x.createdAt ? ago(x.createdAt) : "earlier"}`, x.current ? h("button", { class: "sm", onclick: signOut }, "Sign out") : h("button", { class: "sm ghost danger", onclick: revoke(x) }, "Sign out"))),
    ),
  );
}

/** N2 Data: backups (with a warning when they share a disk with the data), call logs, deleted tools. */
async function dataSection() {
  const [s, backups, deleted] = await Promise.all([api("/settings"), api("/backups").catch(() => null), api("/capabilities?archived=1").catch(() => [])]);
  settings = s;
  const restore = (d) => async () => {
    try {
      await api(`/capabilities/${enc(d.id)}/restore`, { method: "POST" });
      invalidateCaps();
      toast(`Restored ${d.name}`);
      route();
    } catch (e) {
      fail(e);
    }
  };
  // Delete forever keeps type-the-name (decided): it can't be undone.
  const purge = (d) => async () => {
    const typed = h("input", { type: "text", placeholder: d.name, autocomplete: "off", "aria-label": "Type the name to confirm" });
    const ok = await modal(
      (close) => {
        const yes = h("button", { class: "danger solid", disabled: true, onclick: () => close(true) }, "Delete forever");
        typed.addEventListener("input", () => (yes.disabled = typed.value.trim() !== d.name));
        return [
          h("h2", { class: "title-ref" }, "Delete ", capRef(d, d.id, { size: 24 }), " forever?"),
          h("div", { class: "muted dialog-body" }, "Its code, versions, data, logs and secrets are removed. This can't be undone; backups are the only way back."),
          h("label", { class: "field" }, h("span", { class: "label" }, "Type ", h("b", {}, d.name), " to confirm"), typed),
          sheetActions(h("button", { onclick: () => close(false) }, "Cancel"), yes),
        ];
      },
      { width: 440 },
    );
    if (!ok) return;
    try {
      await api(`/capabilities/${enc(d.id)}/purge`, { method: "POST", body: { confirm: d.id } });
      toast(`${d.name} permanently deleted`, { dot: "" });
      route();
    } catch (e) {
      fail(e);
    }
  };
  const backupBtn = h("button", { class: "sm" }, "Back up now");
  backupBtn.addEventListener("click", async () => {
    backupBtn.disabled = true;
    try {
      const b = await api("/backups", { method: "POST" });
      toast(`Backed up · ${Math.round(b.bytes / 1024)} KB`);
      route();
    } catch (e) {
      backupBtn.disabled = false;
      fail(e);
    }
  });
  const folderSheet = () =>
    formSheet({
      title: "Backup folder",
      build: (close) => {
        const input = h("input", { type: "text", class: "code", value: s.backupDir ?? "", placeholder: backups?.dir ?? "", "aria-label": "Backup folder" });
        return [
          h("label", { class: "field" }, h("span", { class: "label" }, "Folder"), input, h("span", { class: "hint" }, "An absolute path. Another disk is safer.")),
          h(
            "div",
            { class: "actions flush between" },
            s.backupDir ? h("button", { class: "ghost", onclick: () => (close(), saveSettings({ backupDir: null }, "Backup folder reset to the default")) }, "Use default") : h("span", {}),
            h("span", { class: "row tight" }, h("button", { onclick: () => close() }, "Cancel"), h("button", { class: "primary", onclick: () => (close(), saveSettings({ backupDir: input.value.trim() || null }, "Backup folder saved")) }, "Save")),
          ),
        ];
      },
    });
  const options = [[7, "1 week"], [14, "2 weeks"], [30, "1 month"], [90, "3 months"], [365, "1 year"], [0, "Forever"]];
  if (!options.some(([v]) => v === s.logRetentionDays)) options.push([s.logRetentionDays, `${s.logRetentionDays} days`]);
  const keep = h("select", { class: "setting-select", "aria-label": "Keep call logs" }, options.map(([v, l]) => h("option", { value: v, selected: v === s.logRetentionDays }, l)));
  keep.addEventListener("change", () => saveSettings({ logRetentionDays: Number(keep.value) }, `Call logs: ${options.find(([v]) => v === Number(keep.value))[1].toLowerCase()}`));
  const last = backups?.backups?.[0];
  settingsFrame(
    "data",
    h("h1", { class: "flush" }, "Data"),
    // Hosted: the host keeps backups off the machine; the folder is its business.
    !s.hosted && backups?.sameDisk && h("div", { class: "notice" }, h("span", {}, "Backups are on the same disk as your data. If the disk fails, both are lost.")),
    settingsCard(
      backups && setting("Backups", last ? `Last ${ago(last.at)} · ${Math.round(last.bytes / 1024)} KB · nightly, 7 daily and 4 weekly kept` : "Nightly; 7 daily and 4 weekly kept. Never includes secrets.", backupBtn),
      !s.hosted && backups && h("div", { class: "setting" }, h("div", { class: "grow" }, h("span", {}, "Folder"), h("span", { class: "sub mono" }, backups.dir)), h("button", { class: "sm", onclick: folderSheet }, "Change")),
      setting("Keep call logs", "Builds, grants and access changes are always kept", keep),
    ),
    deleted.length > 0 &&
      h(
        "div",
        { class: "card settings-card" },
        h("div", { class: "eyebrow card-eyebrow" }, "Deleted tools"),
        deleted.map((d) => h("div", { class: "setting" }, appIcon(d, { size: 32 }), h("div", { class: "grow" }, h("span", {}, d.name), h("span", { class: "sub" }, `Deleted ${ago(d.archivedAt)} · data kept`)), h("button", { class: "ghost sm danger", onclick: purge(d) }, "Delete forever…"), h("button", { class: "sm", onclick: restore(d) }, "Restore"))),
      ),
  );
}

/** N5 About: version, data format and ABI; up to date or the upgrade command; shortcuts, docs, licence. */
/** The public docs and changelog, on GitHub. */
const DOCS_URL = "https://github.com/hewntools/hewn/tree/main/docs#readme";
const CHANGELOG_URL = "https://github.com/hewntools/hewn/blob/main/CHANGELOG.md";

async function aboutSection() {
  const [status, machine] = await Promise.all([api("/status").catch(() => ({})), hewnMachine()]);
  const newer = status.latest && status.version && cmpVersion(status.latest, status.version) > 0;
  settingsFrame(
    "about",
    h("h1", { class: "flush" }, "About"),
    h(
      "div",
      { class: "card about-card" },
      brandTile(56),
      h("div", { class: "grow col" }, h("span", { class: "about-name" }, `${BRAND} ${status.version ?? ""}`), h("span", { class: "small muted" }, [status.dataFormat && `Data format ${status.dataFormat}`, status.abi && `ABI ${status.abi}`, !settings?.hosted && `on ${machine.word}`].filter(Boolean).join(" · "))),
      newer ? h("span", { class: "pill warn with-dot" }, "update") : status.latest ? h("span", { class: "pill ok with-dot" }, "up to date") : h("span", { class: "pill" }, "can't check now"),
    ),
    newer &&
      h(
        "div",
        { class: "card stack-sm upgrade-card" },
        h("span", { class: "strong" }, `${status.latest} is out`),
        (status.notes ?? []).map((r) => releaseNotes(r, status.notes.length > 1)),
        // Hosted: the host moves this Hewn to new releases.
        settings?.hosted
          ? h("div", { class: "small muted" }, "Upgrades happen for you. Your tools and data stay.")
          : [h("div", { class: "small muted" }, "Upgrade from a terminal. Backups run first; your tools and data stay."), commandBlock(`${CLI} upgrade`)],
        h("a", { class: "small", href: CHANGELOG_URL, target: "_blank", rel: "noopener" }, "What's new ›"),
      ),
    settingsCard(
      setting("Docs", "Getting started, building tools, agents, your data", h("a", { class: "btn sm", href: DOCS_URL, target: "_blank", rel: "noopener" }, "Open")),
      setting("Keyboard shortcuts", null, h("button", { class: "sm", onclick: shortcutsDialog }, "Show")),
      setting("Licence", "AGPL-3.0-or-later · spec and UI kit Apache-2.0"),
    ),
  );
}

/** One release's notes, as the changelog has them: "**Title.** The rest" bullets, the title in bold. */
function releaseNotes(r, labelled) {
  const item = (text) => {
    const m = /^\*\*(.+?)\*\*\s*(.*)$/.exec(text);
    const plain = (t) => t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    return h("li", {}, m ? [h("span", { class: "strong" }, plain(m[1])), " ", plain(m[2])] : plain(text));
  };
  return h("div", { class: "stack-xs release-notes" }, labelled && h("span", { class: "eyebrow" }, r.version), h("ul", { class: "small" }, r.items.map(item)));
}

/** "0.3.4" vs "0.3.3": >0 when a is newer. Pre-releases sort before their release. */
function cmpVersion(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).replace(/^v/, "").split("-");
    return [...core.split(".").map(Number), pre ? 0 : 1];
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

// ---------- J1 Settings › AI › Models ----------

const PROVIDERS = {
  anthropic: { label: "Anthropic", sub: "Claude models", keys: "https://console.anthropic.com/settings/keys" },
  openai: { label: "OpenAI", sub: "GPT models", keys: "https://platform.openai.com/api-keys" },
  openrouter: { label: "OpenRouter", sub: "Many vendors with one key", keys: "https://openrouter.ai/keys" },
};
const TIER_TEXT = { light: "Quick, cheap work: tags, short explanations", standard: "Most work", strong: "Harder reasoning", max: "The most capable" };
const usd = (n) => (n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : "$0");
const perM = (p) => `${usd(p.input * 1e6)} / ${usd(p.output * 1e6)}`;
const titleCase = (t) => t[0].toUpperCase() + t.slice(1);
const modelLabel = (prov, id) => prov.models.find((x) => x.id === id)?.name ?? id;

/** O8 A provider's key: a Form that checks it (no tokens spent). Resolves the new /models, or null. */
function keySheet(m, providerId, { use = false } = {}) {
  return formSheet({
    title: `${PROVIDERS[providerId].label} API key`,
    sub: "Tools call models with it, metered; they never see it.",
    build: (close) => {
      const key = h("input", { type: "password", autocomplete: "off", placeholder: "Paste API key", "aria-label": "API key" });
      const save = h("button", { class: "primary" }, "Check and save");
      const submit = async () => {
        if (!key.value.trim()) return key.focus();
        save.disabled = true;
        try {
          let next = await api(`/models/keys/${providerId}`, { method: "PUT", body: { key: key.value.trim() } });
          if (use && next.provider !== providerId) next = await api("/models", { method: "PUT", body: { provider: providerId } });
          toast(`${PROVIDERS[providerId].label} key works`);
          close(next);
        } catch (e) {
          save.disabled = false;
          fail(e);
        }
      };
      save.addEventListener("click", submit);
      key.addEventListener("keydown", (e) => e.key === "Enter" && submit());
      setTimeout(() => key.focus());
      return [
        h("label", { class: "field" }, h("span", { class: "label" }, "Key"), key, h("span", { class: "hint" }, "Get one at ", h("a", { href: PROVIDERS[providerId].keys, target: "_blank", rel: "noopener noreferrer" }, PROVIDERS[providerId].keys.replace(/^https:\/\//, "")))),
        sheetActions(h("button", { onclick: () => close(null) }, "Cancel"), save),
      ];
    },
  });
}

/** Pick one of a provider's models (search, price, images, the suggested one marked). Resolves the id or null. */
function modelPicker({ title, sub, prov, current, suggested }) {
  const search = h("input", { type: "search", placeholder: "Search models", "aria-label": "Search models" });
  const list = h("div", { class: "model-list" });
  return modal(
    (close) => {
      const render = () => {
        const q = search.value.trim().toLowerCase();
        const rows = prov.models.filter((x) => !q || x.id.toLowerCase().includes(q) || (x.name ?? "").toLowerCase().includes(q));
        put(
          list,
          rows.slice(0, 200).map((x) =>
            h(
              "button",
              { class: `model-row ${x.id === current ? "current" : ""}`, onclick: () => close(x.id) },
              h("span", { class: "grow col" }, h("span", {}, x.name ?? x.id, x.id === suggested && h("span", { class: "pill accent model-badge" }, "suggested")), h("span", { class: "sub mono" }, x.id)),
              h("span", { class: "col model-meta" }, h("span", { class: "small" }, x.price ? perM(x.price) : "no price"), h("span", { class: "sub" }, x.images ? "text · images" : x.images === false ? "text only" : "")),
            ),
          ),
          !rows.length && h("div", { class: "muted small" }, "No models match."),
        );
      };
      search.addEventListener("input", render);
      render();
      setTimeout(() => search.focus());
      return [sheetHead(null, title, sub), search, list, sheetActions(h("button", { onclick: () => close(null) }, "Cancel"))];
    },
    { width: 520 },
  );
}

/** Choose the model for one tier from what the active provider's key can use. */
async function tierPicker(m, tier) {
  const prov = m.providers.find((p) => p.id === m.provider);
  const id = await modelPicker({ title: `${titleCase(tier)} tier`, sub: `${TIER_TEXT[tier]}. Price per million tokens in / out.`, prov, current: prov.tiers[tier], suggested: prov.suggested.tiers[tier] });
  if (!id) return null;
  try {
    const next = await api("/models", { method: "PUT", body: { tiers: { [prov.id]: { [tier]: id } } } });
    toast(`${titleCase(tier)}: ${modelLabel(prov, id)}`);
    return next;
  } catch (e) {
    fail(e);
    return null;
  }
}

/** An owner-set price for a model the catalog doesn't price. */
function priceDialog(m, model) {
  const cur = m.prices[model];
  const input = h("input", { type: "number", min: 0, step: "0.01", value: cur ? cur.input * 1e6 : "", "aria-label": "Input price" });
  const output = h("input", { type: "number", min: 0, step: "0.01", value: cur ? cur.output * 1e6 : "", "aria-label": "Output price" });
  return formSheet({
    title: "Set a price",
    sub: model,
    build: (close) => [
      h("label", { class: "field" }, h("span", { class: "label" }, "Input, USD per million tokens"), input),
      h("label", { class: "field" }, h("span", { class: "label" }, "Output, USD per million tokens"), output),
      sheetActions(
        h("button", { onclick: () => close(null) }, "Cancel"),
        h(
          "button",
          {
            class: "primary",
            onclick: async () => {
              try {
                const prices = Object.fromEntries(Object.entries(m.prices).map(([k, v]) => [k, { input: v.input * 1e6, output: v.output * 1e6 }]));
                prices[model] = { input: Number(input.value), output: Number(output.value) };
                close(await api("/models", { method: "PUT", body: { prices } }));
                toast("Price saved");
              } catch (e) {
                fail(e);
              }
            },
          },
          "Save",
        ),
      ),
    ],
  });
}

/** The monthly cap for all tools that use a model. */
function capSheet(m) {
  return formSheet({
    title: "Monthly cap",
    sub: "Calls that could go over it are refused before they're made.",
    build: (close) => {
      const input = h("input", { type: "number", min: 0, step: 1, value: m.monthlyCapUsd, "aria-label": "Monthly cap in USD" });
      setTimeout(() => input.focus());
      return [
        h("label", { class: "field" }, h("span", { class: "label" }, "USD a month"), input),
        sheetActions(
          h("button", { onclick: () => close(null) }, "Cancel"),
          h("button", { class: "primary", onclick: () => api("/models", { method: "PUT", body: { monthlyCapUsd: Number(input.value) } }).then((next) => (toast(`Monthly cap: $${Number(input.value)}`), pollInbox(), close(next)), fail) }, "Save"),
        ),
      ];
    },
  });
}

/** A meter of blocks: `on` of `n` lit (warn once it passes 80%). */
const meter = (n, on, warn) => h("div", { class: `blocks ${warn ? "warn" : ""}`, style: { "--cols": n }, role: "meter", "aria-valuemin": 0, "aria-valuemax": n, "aria-valuenow": on }, Array.from({ length: n }, (_, i) => h("i", { class: i < on ? "on" : "" })));

/**
 * J1 Models: this month's spend first (you check it monthly), then the providers (in use, key
 * saved, no key), then the tiers. Pinned models only when a tool has one; caps per tool are on each
 * tool's model sheet (J3).
 */
/** "12.37 Credits": a host's charge as given (2 decimals at most). */
const creditWords = (t) => `${Math.round(t.amount * 100) / 100} ${t.unit}`;
const CHARGE_KINDS = { build: "builds", intake: "talking requests through", model: "tools that think" };

/**
 * Hosted: tools' model calls run on the host's models and count in its unit (Credits). No
 * providers, keys or USD caps: what each tier runs on, and what was used this month.
 */
async function hostedModelsPage(m, all) {
  const catalog = await api(`/tools/remote/models`).catch(() => null);
  const back = h("a", { class: "link back-inline", href: "#/settings/ai" }, "‹ AI");
  const { totals, rows } = m.host.charges;
  const tierRow = (tier) => {
    const users = m.usage[tier] ?? [];
    return h(
      "div",
      { class: "setting tier-row" },
      h("div", { class: "tier-name strong" }, titleCase(tier)),
      h("div", { class: "grow" }, h("span", {}, catalog?.tiers?.[tier] ?? "Picked for you"), h("span", { class: "sub" }, [TIER_TEXT[tier], users.length ? `used by ${users.map((u) => u.name).join(", ")}` : null].filter(Boolean).join(" · "))),
    );
  };
  settingsFrame(
    "ai",
    h("div", { class: "row tight baseline" }, back, h("h1", { class: "flush" }, "Models")),
    h(
      "div",
      { class: "card stack-sm month-card" },
      h("span", { class: "eyebrow" }, "This month"),
      totals.length ? totals.map((t) => h("div", { class: "row tight baseline" }, h("span", { class: "big-figure" }, creditWords(t)), h("span", { class: "muted" }, "used"))) : h("div", { class: "muted" }, "Nothing used yet"),
      rows.length > 0 && h("div", { class: "small muted" }, rows.map((r) => `${creditWords(r)} on ${CHARGE_KINDS[r.kind] ?? r.kind}`).join(" · ")),
    ),
    h("div", { class: "card settings-card" }, h("div", { class: "eyebrow card-eyebrow" }, "Tiers"), m.tierNames.map(tierRow)),
    m.pinned.length > 0 &&
      h(
        "div",
        { class: "card settings-card" },
        h("div", { class: "eyebrow card-eyebrow" }, "Pinned models"),
        m.pinned.map((c) => h("div", { class: "setting" }, appIcon(all.get(c.id) ?? c, { size: 28 }), h("div", { class: "grow" }, h("span", {}, c.name), h("span", { class: "sub mono" }, c.model)))),
      ),
  );
}

async function modelsPage() {
  const [m, all] = await Promise.all([api("/models"), caps().catch(() => new Map())]);
  if (m.host) return hostedModelsPage(m, all);
  const reload = (next) => next && route();
  const back = h("a", { class: "link back-inline", href: "#/settings/ai" }, "‹ AI");
  const spend = m.spend;
  const pct = spend.capUsd > 0 ? Math.min(1, spend.totalUsd / spend.capUsd) : 1;
  const prov = m.providers.find((p) => p.id === m.provider);
  const providerRow = (p) => {
    const inUse = p.id === m.provider;
    const status = !p.keySet ? "No key" : p.check?.ok ? `${inUse ? "In use · " : ""}key works` : p.check?.error ?? "Key saved";
    const checkBtn = p.keySet && p.check && !p.check.ok && h("button", { class: "sm ghost", onclick: () => api(`/models/check/${p.id}`, { method: "POST" }).then(() => route(), fail) }, "Check again");
    return h(
      "div",
      { class: "setting" },
      providerTile(p.id, 32),
      h("div", { class: "grow" }, h("span", { class: inUse ? "strong" : "" }, PROVIDERS[p.id].label), h("span", { class: `sub ${p.keySet && p.check && !p.check.ok ? "danger-text" : ""}` }, inUse && p.check?.ok && h("span", { class: "dot ok" }), ` ${status}`)),
      checkBtn,
      inUse
        ? kindTag("in use", "ok")
        : p.keySet
          ? h("button", { class: "sm", onclick: () => api("/models", { method: "PUT", body: { provider: p.id } }).then(() => (toast(`Now using ${PROVIDERS[p.id].label}`), route()), fail) }, "Use")
          : h("button", { class: "sm", onclick: () => keySheet(m, p.id, { use: !m.provider }).then(reload) }, "Add key"),
    );
  };
  const tierRow = (tier) => {
    const id = prov?.tiers[tier];
    const x = id && prov.models.find((y) => y.id === id);
    const price = x?.price ?? (id && m.prices[`${prov.id}/${id}`]);
    const users = m.usage[tier] ?? [];
    return h(
      "div",
      { class: "setting tier-row" },
      h("div", { class: "tier-name strong" }, titleCase(tier)),
      h(
        "div",
        { class: "grow" },
        h("span", {}, id ? modelLabel(prov, id) : "Not set"),
        h("span", { class: "sub row tight wrap" }, [price ? `${perM(price)} per M` : id ? "no price known" : TIER_TEXT[tier], users.length ? `used by ${users.length}` : null].filter(Boolean).join(" · "), users.length > 0 && users.slice(0, 3).map((u) => capRef(all.get(u.id), u.id, { size: 16 }))),
        id && !price && h("button", { class: "link sm self-start", onclick: () => priceDialog(m, `${prov.id}/${id}`).then(reload) }, "Set price…"),
      ),
      prov && h("button", { class: "ghost sm", onclick: () => tierPicker(m, tier).then(reload) }, "Change"),
    );
  };
  const differs = prov && Object.keys(prov.suggested.tiers).length && m.tierNames.some((t) => (prov.tiers[t] ?? null) !== (prov.suggested.tiers[t] ?? null));
  const reset = () =>
    api("/models", { method: "PUT", body: { tiers: { [prov.id]: Object.fromEntries(m.tierNames.map((t) => [t, prov.suggested.tiers[t] ?? null])) } } }).then(() => (toast("Tiers reset to the suggestion"), route()), fail);
  const refreshBtn = h("button", { class: "link sm" }, "Refresh");
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    const r = await api("/models/catalog", { method: "POST" }).catch((e) => ({ error: e.message }));
    if (r.error) fail(new Error(r.error));
    route();
  });
  settingsFrame(
    "ai",
    h("div", { class: "row tight baseline" }, back, h("h1", { class: "flush" }, "Models")),
    h(
      "div",
      { class: "card stack-sm month-card" },
      h("div", { class: "row between" }, h("span", { class: "eyebrow" }, "This month"), h("button", { class: "link sm", onclick: () => capSheet(m).then(reload) }, "Change cap")),
      h("div", { class: "row tight baseline" }, h("span", { class: "big-figure" }, usd(spend.totalUsd)), h("span", { class: "muted" }, `of ${usd(spend.capUsd)}`)),
      meter(40, Math.round(pct * 40), pct >= 0.8),
    ),
    h("div", { class: "card settings-card" }, m.providers.map(providerRow)),
    prov &&
      h(
        "div",
        { class: "card settings-card" },
        h("div", { class: "row between card-eyebrow" }, h("span", { class: "eyebrow" }, "Tiers"), differs ? h("button", { class: "link sm", onclick: reset }, "Use suggested") : null),
        m.tierNames.map(tierRow),
      ),
    m.pinned.length > 0 &&
      h(
        "div",
        { class: "card settings-card" },
        h("div", { class: "eyebrow card-eyebrow" }, "Pinned models"),
        m.pinned.map((c) => h("div", { class: "setting" }, appIcon(all.get(c.id) ?? c, { size: 28 }), h("div", { class: "grow" }, h("span", {}, c.name), h("span", { class: `sub ${c.retired ? "danger-text" : ""}` }, c.retired ? `${c.model} is no longer available` : `${c.model}${c.problem ? ` · ${c.problem}` : ""}`)), h("button", { class: c.retired ? "sm primary" : "sm", onclick: () => toolModelSheet(all.get(c.id) ?? c, { replace: !!c.retired }) }, c.retired ? "Replace…" : "Change"))),
      ),
    h("div", { class: "small faint row tight" }, h("span", {}, m.catalog.error ?? (m.catalog.fetchedAt ? `Prices from OpenRouter's model list · updated ${ago(m.catalog.fetchedAt)}` : "Prices not loaded yet")), refreshBtn),
  );
}

// ---------- M3: add a passkey (after a sign-in link on the public address) ----------

async function passkeyPage() {
  const remote = await api("/remote").catch(() => null);
  if (remote?.here !== "public") return go("#/");
  const name = h("input", { type: "text", value: deviceName(navigator.userAgent), "aria-label": "Name", maxLength: 40 });
  const status = h("div", { class: "small danger-text", role: "status" });
  const add = h("button", { class: "primary lg wide" }, "Add passkey");
  add.addEventListener("click", async () => {
    add.disabled = true;
    status.textContent = "";
    try {
      await addPasskey(name.value.trim() || deviceName(navigator.userAgent));
      toast("Passkey added");
      go("#/");
    } catch (e) {
      status.textContent = passkeyError(e);
      add.disabled = false;
    }
  });
  const device = /iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Android/.test(navigator.userAgent) ? "phone" : "device";
  const unlock = /iPhone|iPad/.test(navigator.userAgent) ? "Face ID" : /Mac/.test(navigator.userAgent) ? "Touch ID" : "a fingerprint or the screen lock";
  // The art takes the room above the form, in the page's flow: on a phone it would run under the heading.
  const art = h("pre", {});
  if (window.hewnAscii) onLeave(window.hewnAscii(art, { cols: 64, rows: 40 }));
  view(
    h(
      "div",
      { class: "moment" },
      h(
        "main",
        { class: "signin" },
        h("div", { class: "signin-art", "aria-hidden": "true" }, art),
        h("div", { class: "display signin-title" }, `Add this ${device}`),
        h("div", { class: "muted" }, `Next time it signs in with ${unlock}.`),
        passkeysSupported() ? [h("label", { class: "field" }, h("span", { class: "label" }, "Name"), name), add, h("a", { class: "btn ghost wide", href: "#/" }, "Not now"), status] : [h("div", { class: "muted" }, "This browser can't make passkeys."), h("a", { class: "btn lg wide", href: "#/" }, "Continue")],
      ),
    ),
  );
}

/** "iPhone", "Chrome on macOS": a default name for this device, good enough to tell your own apart. */
function deviceName(ua = "") {
  if (!ua) return "A browser";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "A browser";
  const os = /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

// ---------- router ----------

function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  return { page: parts[0] ?? "", id: parts[1], sub: parts[2], q: new URLSearchParams(qs ?? "") };
}

let routing = 0;
async function route() {
  for (const fn of leaving.splice(0)) fn();
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  const n = ++routing;
  const { page: p, id, sub, q } = parseHash();
  document.body.classList.remove("app-mode");
  if (p !== "") setWallpaper(await hues(), { dim: true });
  if (n !== routing) return;
  try {
    if (p === "") return await home();
    if (p === "app") return await appPage(id, q);
    if (p === "run") return await runPage(id, q);
    if (p === "c") return await infoPage(id);
    if (p === "new") return await intakePage(q);
    if (p === "b") return await buildPage(id);
    if (p === "activity") return await activityPage(q);
    if (p === "agents") return await agentsPage();
    if (p === "accounts") return await accountsPage();
    if (p === "settings") return await settingsPage(id, sub);
    if (p === "passkey") return await passkeyPage();
    page("", 680, empty("Not found", "That page doesn't exist."), h("a", { class: "btn self-center", href: "#/" }, "Home"));
  } catch (e) {
    if (n === routing) page("", 680, errorBox(e), h("a", { class: "btn self-start", href: "#/" }, "‹ Home"));
  }
}

window.addEventListener("hashchange", () => (route(), pollInbox()));
loadSettings().then(() => (route(), pollInbox()));
