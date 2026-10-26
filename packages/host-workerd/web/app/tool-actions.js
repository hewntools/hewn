// SPDX-License-Identifier: AGPL-3.0-or-later
// A tool's actions: its menu, Change…, rename, delete, icon, versions and instructions.
import {
  actorLabel,
  api,
  appIcon,
  bumpIcons,
  capRef,
  caps,
  enc,
  fail,
  glyphCells,
  h,
  hueOf,
  invalidateCaps,
  modal,
  pixelGlyph,
  rowCells,
  sheetActions,
  sheetHead,
  toast,
} from "../kit.js";
import { go, put } from "./frame.js";
import { grantsSheet } from "./grants.js";
import { route } from "./router.js";
import { toolWidgetsSheet } from "./widgets.js";

export { askFix, askFixLatest, capabilityMenu, changeHref, download, fixButton, inlineRename, instructionsSheet, memoryNotice, openCapability, openChange, rollbackTo };

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
function changeHref(c, { m, send, widget, from, fix } = {}) {
  const q = new URLSearchParams({ change: "1", ...(m ? { m } : {}), ...(send ? { send: "1" } : {}), ...(widget ? { widget } : {}), ...(from ? { from } : {}), ...(fix ? { fix } : {}) });
  return `#/${c.ui ? "app" : "run"}/${enc(c.id)}?${q}`;
}
const openChange = (c, o) => go(changeHref(c, o));

/**
 * "Ask builder to fix this" (V4): a Change to the tool with the failure attached as a file (what
 * ran it, the operation, the error, its input and last log lines) and one line in the box. The
 * owner can open the file, drop it, edit the line; nothing goes until Send.
 */
const fixText = (f) => {
  const label = actorLabel(f.caller);
  const who = /^widget:/.test(f.caller ?? "") ? "A widget" : /^schedule:/.test(f.caller ?? "") ? "A schedule" : /^(user|web|ui:)/.test(f.caller ?? "user") ? "I" : label && label !== f.caller ? label : "An agent";
  const input = f.input && f.input !== "{}" ? `\n\nInput: ${f.input}` : "";
  const logs = f.logs?.length ? `\n\nLast log lines:\n${f.logs.join("\n")}` : "";
  return `${who} ran ${f.operation} and it failed:\n${f.error}${input}${logs}`;
};
const askFix = (c, f) => {
  // The box picks it up (once) from here: too long for the address.
  sessionStorage.setItem(`hewn.fix.${c.id}`, JSON.stringify({ text: `${fixText(f)}\n\nFix it so this works.` }));
  openChange(c, { fix: "1" });
};
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
    ["Versions", () => go(`#/c/${id}/versions`)],
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
  const path = tool ? `/capabilities/${enc(tool.id)}/instructions` : "/instructions";
  const undo = h("button", { type: "button", class: "sm ghost" }, "Undo");
  // V2: one line, "Saved as a rule: always Swedish copy", with Undo.
  const el = h("div", { class: "notice ok memory-notice" }, h("span", { class: "grow memory-text" }, what === "remember" ? `Saved as a rule${tool ? ` for ${tool.name}` : ""}: ` : `Removed the rule${tool ? ` for ${tool.name}` : ""}: `, text), undo);
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
  // The id typed to confirm, as Start over and Delete forever ask.
  const ok = await modal(
    (close) => {
      const typed = h("input", { type: "text", autocomplete: "off", placeholder: c.id, "aria-label": `Type ${c.id} to confirm` });
      const yes = h("button", { class: "danger solid", disabled: true, onclick: () => close(true) }, "Delete");
      typed.addEventListener("input", () => (yes.disabled = typed.value.trim() !== c.id));
      typed.addEventListener("keydown", (e) => e.key === "Enter" && !yes.disabled && close(true));
      setTimeout(() => typed.focus());
      return [
        h("h2", {}, h("span", { class: "title-ref" }, "Delete", h("span", { class: "ref-end" }, capRef(all.get(c.id) ?? c, c.id, { size: 24 }), "?"))),
        h(
          "div",
          { class: "muted dialog-body" },
          usedBy.length
            ? [usedBy.map((u, i) => [i ? ", " : "", capRef(all.get(u.id), u.id)]), usedBy.length > 1 ? " use it and will stop working. " : " uses it and will stop working. ", "Its data is kept, so you can restore it later."]
            : "Its data is kept, so you can restore it later.",
        ),
        h("label", { class: "field flush" }, h("span", { class: "label" }, "Type ", h("b", {}, c.id), " to confirm"), typed),
        h("div", { class: "actions" }, h("button", { onclick: () => close(false) }, "Cancel"), yes),
      ];
    },
    { width: 440 },
  ).then(Boolean);
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
  const setGrid = (lit) => {
    for (const r of grid) r.fill(false);
    for (const { x, y } of lit) if (grid[y]?.[x] !== undefined) grid[y][x] = true;
  };
  setGrid(cells);
  let hue = hueOf(c);
  let saturation = Number.isInteger(c.saturation) ? c.saturation : 100;
  let mode = c.iconKind === "image" ? "image" : "glyph";
  // What the owner changed ("icon", "hue", "saturation"): Save stores only those, so a builder's
  // later colour still shows where the owner left it alone. After Use default (`defaulted`), Save
  // first clears the owner's icon, colour and saturation.
  const touched = new Set();
  let defaulted = false;
  const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/svg+xml" });
  file.addEventListener("change", () => touched.add("icon"));
  const status = h("p", { class: "small error" });
  // V3: the icon at the sizes it's seen at (Info, a row, a cap-ref), drawn as you go.
  const previews = [64, 28, 20].map(() => h("span", { class: "icon-preview" }));
  const litCount = h("span", {});
  const satLabel = h("span", {});
  const rows = () => grid.map((r) => r.map((on) => (on ? "#" : ".")).join(""));

  const tileAt = (size) => {
    const tile = h("span", { class: "app-icon", style: { "--size": `${size}px`, "--hue": hue, "--s": saturation / 100 } });
    // The default without a builder's glyph is the monogram.
    if (mode === "glyph" && defaulted && !touched.has("icon") && !grid.flat().some(Boolean)) tile.append(appIcon({ name: c.name }, { size }).firstChild);
    else if (mode === "glyph") tile.append(pixelGlyph(rowCells(rows())));
    else tile.append(appIcon({ ...c, hue, saturation }, { size }).firstChild ?? "");
    return tile;
  };
  const drawPreview = () => {
    [64, 28, 20].forEach((size, i) => put(previews[i], tileAt(size)));
    litCount.textContent = `${grid.flat().filter(Boolean).length} lit`;
    satLabel.textContent = `Saturation · ${saturation}%`;
  };
  const cellButtons = grid.map((r, y) =>
    r.map((_, x) => {
      const b = h("button", { type: "button", "aria-label": `Cell ${x + 1}, ${y + 1}`, "aria-pressed": String(grid[y][x]) });
      b.addEventListener("click", () => ((grid[y][x] = !grid[y][x]), b.setAttribute("aria-pressed", String(grid[y][x])), touched.add("icon"), drawPreview()));
      return b;
    }),
  );
  const editor = h("div", { class: "glyph-editor", role: "group", "aria-label": "Glyph, 5 by 5" }, cellButtons);
  const hueInput = h("input", { type: "range", min: 0, max: 359, value: hue, class: "hue-range", "aria-label": "Colour" });
  hueInput.addEventListener("input", () => ((hue = Number(hueInput.value)), touched.add("hue"), drawPreview()));
  // 0: black or white on grey (a black-and-white brand); 100 is the default; capped at 150 (more turns neon in dark mode).
  const satInput = h("input", { type: "range", min: 0, max: 150, step: 5, value: saturation, class: "hue-range", "aria-label": "Saturation" });
  satInput.addEventListener("input", () => ((saturation = Number(satInput.value)), touched.add("saturation"), drawPreview()));
  const panes = {
    glyph: h("div", { class: "stack-sm icon-draw" }, editor, h("span", { class: "small faint" }, litCount, " · 7–17 cells, one simple idea.")),
    image: h("label", { class: "field" }, h("span", { class: "label" }, "Image"), file, h("span", { class: "hint" }, "PNG, JPEG, WebP or SVG, up to 256 KB")),
  };
  const body = h("div", {});
  const seg = h("div", { class: "segmented self-center", role: "group", "aria-label": "Icon type" });
  const show = () => {
    put(seg, ...[["glyph", "Draw"], ["image", "Image"]].map(([k, l]) => h("button", { type: "button", "aria-pressed": String(k === mode), onclick: () => ((mode = k), touched.add("icon"), show()) }, l)));
    put(body, panes[mode]);
    drawPreview();
  };
  /** Use default: the builder's glyph, colour and saturation in the preview; Save applies them. */
  const useDefault = async () => {
    try {
      const [m, lit] = await Promise.all([api(`/capabilities/${id}`), glyphCells({ id: c.id, iconUrl: `/api/capabilities/${id}/icon?default=1` })]);
      setGrid(lit);
      cellButtons.forEach((r, y) => r.forEach((b, x) => b.setAttribute("aria-pressed", String(grid[y][x]))));
      hue = hueOf({ id: c.id, hue: m.hue });
      saturation = Number.isInteger(m.saturation) ? m.saturation : 100;
      hueInput.value = hue;
      satInput.value = saturation;
      mode = "glyph";
      defaulted = true;
      touched.clear();
      status.textContent = "";
      show();
    } catch (e) {
      status.textContent = e.message;
    }
  };
  const done = (close) => (bumpIcons(), invalidateCaps(), close(), route());
  return modal((close) => {
    const save = async () => {
      try {
        const icon = touched.has("icon");
        if (icon && mode === "glyph" && !grid.flat().some(Boolean)) return (status.textContent = "Light at least one cell.");
        if (icon && mode === "image" && !file.files[0]) return (status.textContent = "Choose an image.");
        const body = {
          ...(touched.has("hue") ? { hue } : {}),
          ...(touched.has("saturation") ? { saturation } : {}),
          ...(icon && mode === "glyph" ? { glyph: rows() } : {}),
          ...(icon && mode === "image"
            ? {
                dataUrl: await new Promise((res, rej) => {
                  const r = new FileReader();
                  r.onload = () => res(r.result);
                  r.onerror = rej;
                  r.readAsDataURL(file.files[0]);
                }),
              }
            : {}),
        };
        if (defaulted) await api(`/capabilities/${id}/icon`, { method: "DELETE" });
        if (Object.keys(body).length) await api(`/capabilities/${id}/icon`, { method: "PUT", body });
        done(close);
      } catch (e) {
        status.textContent = e.message;
      }
    };
    show();
    return [
      h("div", { class: "row sheet-head icon-head" }, previews[0], h("div", { class: "grow sheet-title" }, `Icon for ${c.name}`), previews[1], previews[2]),
      seg,
      body,
      // Both sliders the same width: the colour's sits in the same frame, without a mark.
      h("label", { class: "field" }, h("span", { class: "label" }, "Colour"), h("span", { class: "range-mark no-mark" }, hueInput)),
      // The mark under the slider: where the default (100%) is.
      h("label", { class: "field" }, h("span", { class: "label" }, satLabel), h("span", { class: "range-mark", style: { "--at": 100 / 150 }, "data-mark": "100%" }, satInput)),
      status,
      h(
        "div",
        { class: "actions flush between" },
        h("button", { class: "ghost", onclick: useDefault }, "Use default"),
        h("span", { class: "row tight" }, h("button", { onclick: () => close() }, "Cancel"), h("button", { class: "primary", onclick: save }, "Save")),
      ),
    ];
  }, { width: 480 });
}
