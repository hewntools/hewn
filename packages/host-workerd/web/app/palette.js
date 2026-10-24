// SPDX-License-Identifier: AGPL-3.0-or-later
// The command palette (⌘K, "/"): tools, places and actions in one search.
import { api, appIcon, caps, enc, fail, h, modal, pixelGlyph, rowCells, toast } from "../kit.js";
import { addConnectionSheet } from "./accounts.js";
import { jobPicker } from "./agents.js";
import { applyTheme, isDark, THEME_KEY } from "./appearance.js";
import { connectDialog } from "./connect.js";
import { go, keyHandlers, put, settings, shortcutsDialog } from "./frame.js";
import { BELL, closeInbox, toggleInbox } from "./inbox.js";
import { SECTIONS } from "./settings.js";
import { openCapability, openChange } from "./tool-actions.js";
import { addWidgetSheet } from "./widgets.js";

export { commandPalette };

// ---------- the command palette (⌘K, "/"): tools, places and actions in one search ----------

/** 5×5 glyphs for the palette's actions and places (Hewn's pixel style, no UI icon set). */
const PALETTE_GLYPHS = {
  plus: ["..#..", "..#..", "#####", "..#..", "..#.."],
  widget: ["##.##", "##.##", ".....", "##.##", "##.##"],
  edit: ["...##", "..###", ".###.", "###..", "#...."],
  agent: [".###.", ".###.", ".....", "#####", "#####"],
  link: ["##...", "#.#..", ".###.", "..#.#", "...##"],
  hammer: ["#####", "#####", "..#..", "..#..", "..#.."],
  ask: ["#####", "#...#", "#####", ".#...", "#...."],
  backup: ["..#..", "..#..", "#.#.#", ".###.", "#####"],
  appearance: [".###.", "###.#", "###.#", "###.#", ".###."],
  keys: ["#####", "#.#.#", "#####", "#...#", "#####"],
  home: ["..#..", ".###.", "#####", "##.##", "##.##"],
  bell: BELL,
  activity: ["#.###", ".....", "#.###", ".....", "#.###"],
  key: [".###.", ".#.#.", ".###.", "..#..", "..##."],
  settings: ["#.#.#", ".###.", "##.##", ".###.", "#.#.#"],
  chip: ["#####", "#...#", "#.#.#", "#...#", "#####"],
};
/** A small tile with a pixel glyph, for Hewn's own actions and places: ink on grey (saturation 0), like Home's New; colour is for tools. */
const glyphTile = (rows, size) => h("span", { class: "app-icon", style: { "--size": `${size}px`, "--s": 0 }, "aria-hidden": "true" }, pixelGlyph(rowCells(rows)));

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
