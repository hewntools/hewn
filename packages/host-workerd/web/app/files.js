// SPDX-License-Identifier: AGPL-3.0-or-later
// The code browser (U4, Q5): the one place code is shown, wherever it comes in (a version's
// Files, a Hub page's Source code, the install sheet, updates). Files on the left; on the right
// the file, as Changes (a git-style unified diff against the version before) or as Source.
import { api, enc, h, skeleton } from "../kit.js";
import { put } from "./frame.js";
import { highlighter } from "./highlight.js";
import { segmented } from "./widgets.js";

export { codeBrowser, versionSource };

/** Where a tool's version's code comes from: `list()` the files, `file(path)` one of them. */
const versionSource = (id, version) => ({
  label: `v${version}`,
  list: () => api(`/capabilities/${enc(id)}/code?version=${version}`),
  file: (path) => api(`/capabilities/${enc(id)}/code?version=${version}&path=${enc(path)}`),
});

const kb = (n) => (n < 1024 ? `${n} B` : `${Math.round(n / 102.4) / 10} KB`);

/** Lines drawn at most: a longer file (or diff) shows this many, then how many more there are. */
const MAX_LINES = 5000;
const more = (n) => n > 0 && h("div", { class: "code-empty" }, `${n.toLocaleString("en")} more ${n === 1 ? "line" : "lines"} not shown.`);

/** A file's lines, as the diff counts them (CRLF as LF, no line after the final newline). */
const linesOf = (text) => (text === "" ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/** One line of code: its number(s), then the text (highlighted) after its + or − mark. */
function codeLine(cls, old, now, mark, text) {
  return h("div", { class: `code-line ${cls}` }, old !== null && h("span", { class: "no" }, old ?? ""), h("span", { class: "no" }, now ?? ""), h("span", { class: "t" }, mark && h("span", { class: "mark" }, mark), text));
}

/** A file without hunks: unchanged, changed only where lines don't show it, or empty (added or removed). */
const NO_HUNKS = { same: "No changes in this file.", changed: "Only line endings or the final newline changed.", added: "An empty file.", removed: "An empty file." };

/** Changes: each hunk's @@ header, then its lines with both line numbers. */
function changesView(file, path) {
  if (!file.hunks.length) return h("div", { class: "code-empty" }, NO_HUNKS[file.status]);
  const hl = highlighter(path);
  // Each hunk starts where the file above it leaves off (it may open inside a comment or a template string).
  const above = highlighter(path);
  const lines = linesOf(file.text);
  let read = 0;
  let room = MAX_LINES;
  const out = [];
  for (const hk of file.hunks) {
    if (room <= 0) break;
    above.skip(lines.slice(read, hk.newStart - 1));
    read = Math.max(read, hk.newStart - 1);
    hl.state = above.state;
    const drawn = hk.lines.slice(0, room);
    room -= drawn.length;
    out.push(
      h("div", { class: "code-line hunk" }, h("span", { class: "t" }, `@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@`)),
      drawn.map((l) => codeLine(l.type === "+" ? "add" : l.type === "-" ? "del" : "", l.old, l.new, l.type === "+" ? "+ " : l.type === "-" ? "− " : "  ", hl.line(l.text))),
    );
  }
  const total = file.hunks.reduce((n, hk) => n + hk.lines.length, 0);
  return [out, more(total - (MAX_LINES - room))];
}

/** Source: the file with one gutter. */
function sourceView(file, path, text = file.text) {
  if (text === "") return h("div", { class: "code-empty" }, "An empty file.");
  const hl = highlighter(path);
  const lines = linesOf(text);
  return [lines.slice(0, MAX_LINES).map((t, i) => codeLine("", null, i + 1, null, hl.line(t))), more(lines.length - MAX_LINES)];
}

/** A JSON file laid out (two-space indents), when that isn't how it was written and fits in what's drawn; else null. */
function prettyJson(path, text) {
  if (!/\.json$/i.test(path)) return null;
  try {
    const pretty = `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
    return pretty.trimEnd() === text.trimEnd() || linesOf(pretty).length > MAX_LINES ? null : pretty;
  } catch {
    return null;
  }
}

/**
 * The browser itself, for a source ({ label, list, file }): Changes when there's a version before
 * and something changed, else Source. `at`: open this file at this line (a finding's "Show"),
 * highlighted, in Source.
 */
function codeBrowser(src, { at } = {}) {
  const side = h("nav", { class: "side-list code-files", "aria-label": "Files" }, skeleton("80%", "60%", "70%"));
  const path = h("span", { class: "mono small grow clip-1" });
  const toggle = h("span", {});
  // JSON written compactly reads laid out; As written shows the file's own lines.
  const jsonToggle = h("span", {});
  let pretty = true;
  const body = h("div", { class: "code-body" }, skeleton("60%", "80%", "40%"));
  const el = h("div", { class: "code-browser" }, side, h("div", { class: "card code-pane" }, h("div", { class: "code-head" }, path, jsonToggle, toggle), body));
  let data = null;
  let mode = "source";
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
    // The file on screen stays (dimmed) until the next one is ready: no blank, no jump.
    body.setAttribute("aria-busy", "true");
    try {
      const f = await src.file(p);
      if (current !== p) return;
      const meta = data.files.find((x) => x.path === p);
      body.classList.toggle("source", mode === "source");
      const laidOut = mode === "source" && !f.binary ? prettyJson(p, f.text) : null;
      put(jsonToggle, laidOut && segmented([["pretty", "Pretty"], ["raw", "As written"]], pretty ? "pretty" : "raw", (k) => ((pretty = k === "pretty"), open(p)), { label: "JSON" }));
      put(body, f.binary ? h("div", { class: "code-empty" }, `Not text (${kb(meta?.size ?? 0)}), so not shown.`) : mode === "changes" ? changesView(f, p) : sourceView(f, p, laidOut && pretty ? laidOut : f.text));
      body.scrollTop = 0;
      if (at?.line && p === at.path && mode === "source") {
        const line = body.querySelectorAll(".code-line")[at.line - 1];
        line?.classList.add("hl");
        line?.scrollIntoView({ block: "center" });
      }
    } catch (e) {
      if (current !== p) return;
      put(body, h("div", { class: "code-empty" }, e.message || String(e)));
    }
    if (current === p) body.removeAttribute("aria-busy");
  };
  const setMode = (m) => {
    mode = m;
    const list = shown();
    open(list.some((f) => f.path === current) ? current : list[0]?.path ?? data.files[0]?.path);
  };
  // Ready once the first file is on screen: a page or sheet can wait for it rather than show the skeleton.
  let markReady;
  el.ready = new Promise((r) => (markReady = r));
  (async () => {
    try {
      data = await src.list();
      if (data.base && data.files.some((f) => f.status !== "same")) {
        if (!at) mode = "changes";
        put(toggle, segmented([["changes", "Changes"], ["source", "Source"]], mode, setMode, { label: "Show" }));
      }
      const first = (at && shown().find((f) => f.path === at.path)) ?? shown().find((f) => /^src\/index\.[jt]s$/.test(f.path)) ?? shown()[0];
      if (first) await open(first.path);
      else put(side, h("div", { class: "eyebrow" }, "No files"));
    } catch (e) {
      put(side, h("div", { class: "small faint" }, e.message || String(e)));
      put(body);
    }
  })().finally(() => markReady());
  return el;
}
