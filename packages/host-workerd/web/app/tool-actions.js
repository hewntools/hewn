// SPDX-License-Identifier: AGPL-3.0-or-later
// A tool's actions: its menu, Change…, rename, delete, icon, versions and instructions.
import {
  actorLabel,
  ago,
  api,
  appIcon,
  bumpIcons,
  capRef,
  caps,
  confirmDialog,
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
  skeleton,
  toast,
} from "../kit.js";
import { go, put } from "./frame.js";
import { grantsSheet } from "./grants.js";
import { conversationThread } from "./intake.js";
import { route } from "./router.js";
import { toolWidgetsSheet } from "./widgets.js";

export { askFix, askFixLatest, capabilityMenu, changeHref, fixButton, inlineRename, instructionsSheet, memoryNotice, openCapability, openChange, rollbackTo, versionsDialog };

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
