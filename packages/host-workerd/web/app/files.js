// SPDX-License-Identifier: AGPL-3.0-or-later
// The code browser (U4, Q5): the one place code is shown, wherever it comes in (a version's
// Files, a Hub page's Source code, the install sheet, updates). Files on the left; on the right
// the file, as Changes (a git-style unified diff against the version before) or as Source.
import { api, enc, h, skeleton } from "../kit.js";
import { put } from "./frame.js";
import { segmented } from "./widgets.js";

export { codeBrowser, versionSource };

/** Where a tool's version's code comes from: `list()` the files, `file(path)` one of them. */
const versionSource = (id, version) => ({
  label: `v${version}`,
  list: () => api(`/capabilities/${enc(id)}/code?version=${version}`),
  file: (path) => api(`/capabilities/${enc(id)}/code?version=${version}&path=${enc(path)}`),
});

const kb = (n) => (n < 1024 ? `${n} B` : `${Math.round(n / 102.4) / 10} KB`);

/** One line of code: its number(s), then the text with its + or − mark. */
function codeLine(cls, old, now, text) {
  return h("div", { class: `code-line ${cls}` }, old !== null && h("span", { class: "no" }, old ?? ""), h("span", { class: "no" }, now ?? ""), h("span", { class: "t" }, text));
}

/** Changes: each hunk's @@ header, then its lines with both line numbers. */
function changesView(file) {
  if (!file.hunks.length) return h("div", { class: "code-empty" }, file.status === "same" ? "No changes in this file." : "Nothing to show.");
  return file.hunks.map((hk) => [
    h("div", { class: "code-line hunk" }, h("span", { class: "t" }, `@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@`)),
    hk.lines.map((l) => codeLine(l.type === "+" ? "add" : l.type === "-" ? "del" : "", l.old, l.new, `${l.type === "+" ? "+ " : l.type === "-" ? "− " : "  "}${l.text}`)),
  ]);
}

/** Source: the file with one gutter. */
const sourceView = (file) => (file.text === "" ? h("div", { class: "code-empty" }, "An empty file.") : file.text.replace(/\n$/, "").split("\n").map((t, i) => codeLine("", null, i + 1, t)));

/**
 * The browser itself, for a source ({ label, list, file }). `mode`: "changes" or "source" (default:
 * changes when there's a version before with changes, else source).
 */
function codeBrowser(src, { mode: wanted } = {}) {
  const side = h("nav", { class: "side-list code-files", "aria-label": "Files" }, skeleton("80%", "60%", "70%"));
  const path = h("span", { class: "mono small grow clip-1" });
  const toggle = h("span", {});
  const body = h("div", { class: "code-body" }, skeleton("60%", "80%", "40%"));
  const el = h("div", { class: "code-browser" }, side, h("div", { class: "card code-pane" }, h("div", { class: "code-head" }, path, toggle), body));
  let data = null;
  let mode = wanted;
  let current = null;
  const shown = () => (mode === "changes" ? data.files.filter((f) => f.status !== "same") : data.files.filter((f) => f.status !== "removed").sort((a, b) => a.path.localeCompare(b.path)));
  const drawSide = () =>
    put(
      side,
      h("div", { class: "eyebrow" }, mode === "changes" ? `Changed since v${data.base}` : `${src.label} · ${shown().length} files`),
      shown().map((f) =>
        h(
          "button",
          { class: "mono", "aria-pressed": String(f.path === current), title: f.path, onclick: () => open(f.path) },
          h("span", { class: "clip-1 grow" }, f.path),
          mode === "changes" && f.added > 0 && h("span", { class: "small add-n" }, `+${f.added}`),
          mode === "changes" && f.removed > 0 && h("span", { class: "small del-n" }, `−${f.removed}`),
          mode === "changes" && f.status === "added" && !f.added && h("span", { class: "small faint" }, "new"),
          mode === "changes" && f.status === "removed" && !f.removed && h("span", { class: "small faint" }, "gone"),
        ),
      ),
    );
  const open = async (p) => {
    current = p;
    path.textContent = p;
    drawSide();
    body.classList.toggle("source", mode === "source");
    put(body, skeleton("60%", "80%", "40%"));
    try {
      const f = await src.file(p);
      if (current !== p) return;
      const meta = data.files.find((x) => x.path === p);
      put(body, f.binary ? h("div", { class: "code-empty" }, `Not text (${kb(meta?.size ?? 0)}), so not shown.`) : mode === "changes" ? changesView(f) : sourceView(f));
    } catch (e) {
      put(body, h("div", { class: "code-empty" }, e.message || String(e)));
    }
  };
  const setMode = (m) => {
    mode = m;
    const list = shown();
    open(list.some((f) => f.path === current) ? current : list[0]?.path ?? data.files[0]?.path);
  };
  (async () => {
    try {
      data = await src.list();
      const changed = data.files.some((f) => f.status !== "same");
      if (!data.base || !changed) mode = "source";
      mode ??= "changes";
      if (data.base && changed) put(toggle, segmented([["changes", "Changes"], ["source", "Source"]], mode, setMode, { label: "Show" }));
      const first = shown().find((f) => /^src\/index\.[jt]s$/.test(f.path)) ?? shown()[0];
      if (first) open(first.path);
      else put(side, h("div", { class: "eyebrow" }, "No files"));
    } catch (e) {
      put(side, h("div", { class: "small faint" }, e.message || String(e)));
      put(body);
    }
  })();
  return el;
}
