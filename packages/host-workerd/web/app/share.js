// SPDX-License-Identifier: AGPL-3.0-or-later
// S1/S2 Share…: one sheet that grows. What's in it on top (the scan's findings by file and line,
// masked, each with Show; the sample data), the ways to share below as rows (a file now; a link
// in 0.4.10, Publish to Hub in 0.5). Write it yourself: a tool's sample data, edited by hand.
import { api, appIcon, enc, fail, h, modal, setWallpaper, sheetActions, skeleton, tintOf, caps } from "../kit.js";
import { backBar, go, hues, put, view } from "./frame.js";
import { download, openChange } from "./tool-actions.js";

export { samplePage, shareSheet };

/** What Ask builder asks for: sample data, written the way the brief says. */
const ASK_SAMPLE = "Add sample data: sample/calls.json with made-up entries that show what the tool does (it fills an empty tool when someone installs it, and its screenshots).";

async function shareSheet(c, { version } = {}) {
  let check = await api(`/capabilities/${enc(c.id)}/share${version ? `?version=${version}` : ""}`);
  return modal(
    (close) => {
      const body = h("div", { class: "stack-md" });
      const pick = h("select", { class: "share-version", "aria-label": "Version" });
      pick.addEventListener("change", async () => {
        try {
          check = await api(`/capabilities/${enc(c.id)}/share?version=${pick.value}`);
          draw();
        } catch (e) {
          fail(e);
        }
      });
      const finding = (f) => {
        const sub = h("span", { class: "sub" }, `${f.label} · ${f.masked}`);
        const show = h("button", { class: "ghost sm" }, "Show");
        show.addEventListener("click", () => {
          const open = show.textContent === "Show";
          sub.textContent = `${f.label} · ${open ? f.text : f.masked}`;
          show.textContent = open ? "Hide" : "Show";
        });
        return h("li", {}, h("span", { class: "dot warn" }), h("div", { class: "grow" }, h("span", { class: "mono small" }, `${f.file}:${f.line}`), sub), show);
      };
      const draw = () => {
        put(pick, check.versions.map((v) => h("option", { value: v, selected: v === check.version }, `v${v}`)));
        const secret = check.blocked?.kind === "secret" ? check.blocked : null;
        const warnings = check.findings.filter((f) => f.kind !== "secret");
        const sampleRow = check.sample
          ? h("li", {}, h("span", { class: "dot ok" }), h("div", { class: "grow" }, h("span", {}, "Sample data"), h("span", { class: "sub" }, `sample/calls.json · ${check.sample.calls} calls · always included`)))
          : h(
              "li",
              {},
              h("span", { class: "dot warn" }),
              h("div", { class: "grow" }, h("span", {}, "No sample data"), h("span", { class: "sub" }, "Needed to share, so it doesn't open empty")),
              h("button", { class: "sm ghost", onclick: () => (close(), go(`#/c/${enc(c.id)}/sample`)) }, "Write it yourself"),
              h("button", { class: "sm primary", onclick: () => (close(), openChange(c, { m: ASK_SAMPLE })) }, "Ask builder"),
            );
        const blocked = !!check.blocked;
        const name = `${c.id}.hewn.zip`;
        put(
          body,
          secret &&
            h(
              "div",
              { class: "notice danger info-notice" },
              h("span", { class: "grow" }, h("span", { class: "mono" }, `${secret.file}:${secret.line}`), ` is ${secret.label}. Remove it, then share again.`),
              h("button", { class: "sm", onclick: () => (close(), openChange(c, { m: `Remove the value hard-coded in ${secret.file}:${secret.line}; it must not be in the code. Read it from a setting or a key the tool asks for instead.` })) }, "Change…"),
            ),
          h(
            "div",
            {},
            h("div", { class: "eyebrow share-eyebrow" }, `What's in it · ${check.files} files`),
            h("ul", { class: "list" }, warnings.map(finding), sampleRow),
            h("div", { class: "small faint share-never" }, "Never in it: your data, keys, settings, conversations, logs."),
          ),
          h(
            "div",
            { class: blocked ? "share-ways off" : "share-ways" },
            h("div", { class: "eyebrow share-eyebrow" }, "Share as"),
            h(
              "ul",
              { class: "list" },
              h("li", {}, h("div", { class: "grow" }, h("span", {}, "Download"), h("span", { class: "sub mono" }, name)), h("button", { class: "sm primary", disabled: blocked, onclick: () => download(`/api/capabilities/${enc(c.id)}/share/download?version=${check.version}`) }, "Download")),
            ),
          ),
        );
      };
      draw();
      return [h("div", { class: "row sheet-head" }, appIcon(c, { size: 44 }), h("div", { class: "grow sheet-title" }, `Share ${c.name}`), pick), body, sheetActions(h("button", { onclick: () => close() }, "Done"))];
    },
    { width: 560 },
  );
}

/**
 * Write it yourself: sample/calls.json by hand (the override; Ask builder is the usual way).
 * Saving makes a new version with no builder; validation replays it on an empty tool first.
 */
async function samplePage(id) {
  view(backBar("Info", `#/c/${enc(id)}`), h("main", { class: "column", style: { "--w": "900px" } }, skeleton("40%", "90%", "70%")));
  const [cap, all] = await Promise.all([api(`/capabilities/${enc(id)}`), caps(true)]);
  const c = all.get(id) ?? { id, name: cap.name };
  setWallpaper(await hues([tintOf(c)]));
  const version = c.version ?? cap.versions[0]?.version;
  const has = (await api(`/capabilities/${enc(id)}/data`).catch(() => null))?.sample;
  const current = has ? await api(`/capabilities/${enc(id)}/code?version=${version}&path=${enc("sample/calls.json")}`).catch(() => null) : null;
  // A start: one call per operation that writes, with its required fields left for you to fill.
  const writes = cap.operations.filter((o) => o.sideEffect === "write" && !o.deprecated);
  const template = JSON.stringify(writes.slice(0, 3).map((o) => ({ operation: o.name, input: Object.fromEntries((o.inputSchema?.required ?? []).map((k) => [k, ""])) })), null, 2);
  const text = h("textarea", { class: "code-edit", rows: 20, spellcheck: false, "aria-label": "sample/calls.json" }, current?.text ?? `${template}\n`);
  const status = h("div", { class: "small error" });
  const save = h("button", { class: "primary" }, "Save as a new version");
  save.addEventListener("click", async () => {
    save.disabled = true;
    status.textContent = "";
    try {
      const b = await api(`/capabilities/${enc(id)}/sample`, { method: "POST", body: { text: text.value } });
      go(`#/b/${enc(b.buildId)}`);
    } catch (e) {
      status.textContent = e.message;
      save.disabled = false;
    }
  });
  view(
    backBar(cap.name, `#/c/${enc(id)}`),
    h(
      "main",
      { class: "column info", style: { "--w": "900px" } },
      h("div", { class: "info-head" }, appIcon(c, { size: 44 }), h("div", { class: "grow col" }, h("h1", { class: "title-lg" }, `Sample data · ${cap.name}`), h("span", { class: "muted small" }, "sample/calls.json · what the tool looks like in use"))),
      h(
        "div",
        { class: "small muted" },
        "Calls to its operations, in order, that fill an empty tool with made-up entries: when someone installs it with sample data, and in its screenshots. Plain writes only (no network, other tools or model), and nothing of your own. ",
        h("button", { class: "link sm", onclick: () => openChange(c, { m: ASK_SAMPLE }) }, "Ask builder instead ›"),
      ),
      h("div", { class: "card code-pane" }, h("div", { class: "code-head" }, h("span", { class: "mono small grow" }, "sample/calls.json"), h("span", { class: "small faint" }, writes.map((o) => o.name).join(" · "))), text),
      status,
      h("div", { class: "row end" }, h("a", { class: "btn", href: `#/c/${enc(id)}` }, "Cancel"), save),
      h("div", { class: "small faint" }, "Saving makes a new version (no builder runs). It goes live only if every call replays without an error on an empty tool."),
    ),
  );
}
