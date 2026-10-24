// SPDX-License-Identifier: AGPL-3.0-or-later
// Widgets on Home: a placed widget, Add a widget, a widget's options, and a tool's widgets.
import { ago, api, appIcon, capRef, caps, chip, confirmDialog, enc, fail, h, hueOf, iconUrl, modal, pickerSheet, sheetActions, sheetHead, toast, withContextMenu } from "../kit.js";
import { go, put } from "./frame.js";
import { storedEntry } from "./home.js";
import { route } from "./router.js";
import { askFixLatest, openCapability, openChange } from "./tool-actions.js";
import { field } from "./tool.js";

export { addWidgetSheet, segmented, SIZE_LABEL, SIZE_LETTER, TEMPLATE_LABEL, toolWidgetsSheet, widgetOptionsSheet, widgetPreview, widgetTile };

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
