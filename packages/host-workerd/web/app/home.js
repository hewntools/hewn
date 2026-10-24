// SPDX-License-Identifier: AGPL-3.0-or-later
// Home: the first run, the grid of tools and widgets, and Edit Home; and who builds tools.
import { api, appIcon, caps, enc, fail, h, invalidateCaps, menuFrom, openMenu, setWallpaper, skeleton, tintOf, withContextMenu } from "../kit.js";
import { agentTile, agentTileOf, buildJobs, jobPicker } from "./agents.js";
import { connectDialog } from "./connect.js";
import { bar, brand, go, hewnMachine, leaving, loadSettings, moment, onKey, onLeave, put, sandboxNotice, setSettings, settings, topBar, view } from "./frame.js";
import { inboxBtn } from "./inbox.js";
import { modelChip } from "./intake.js";
import { capabilityMenu, inlineRename, openCapability } from "./tool-actions.js";
import { addWidgetSheet, SIZE_LETTER, widgetOptionsSheet, widgetTile } from "./widgets.js";

export { buildingLabel, buildsChosen, home, jobModelOf, modelWords, saveBuildModel, storedEntry };

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
  return setSettings(await api("/settings", { method: "PUT", body: { jobModels: next, intake: agent } }));
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
