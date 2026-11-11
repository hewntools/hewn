// SPDX-License-Identifier: AGPL-3.0-or-later
// S1–S4 Share…: one sheet that grows. What's in it on top (the scan's findings by file and line,
// masked, each with Show; the sample data), the ways to share below as rows (a file, a link), then
// the links that still work, each with Revoke. S3 a link: one version, an expiry, the link shown
// once. Write it yourself: a tool's sample data, edited by hand.
import { api, appIcon, confirmDialog, enc, fail, h, modal, setWallpaper, sheetActions, skeleton, svg, tintOf, toast, caps } from "../kit.js";
import { backBar, go, hues, put, stillHere, view } from "./frame.js";
import { plural } from "./intake.js";
import { download, openChange } from "./tool-actions.js";
import { segmented } from "./widgets.js";

export { samplePage, shareButton, shareIcon, shareSheet };

/** The share mark everyone knows: a box with an arrow out of it. */
const shareIcon = () =>
  svg(
    "svg",
    { class: "ico", viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" },
    svg("path", { d: "M12 3v12" }),
    svg("path", { d: "M7.5 7.5 12 3l4.5 4.5" }),
    svg("path", { d: "M8.5 10.5H6.5a1.5 1.5 0 0 0-1.5 1.5v7.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V12a1.5 1.5 0 0 0-1.5-1.5h-2" }),
  );
/** Share… as a top-bar button, with its mark. `version`: open on that version (a version's page) rather than the live one. */
const shareButton = (c, { version } = {}) => h("button", { class: "with-icon", onclick: () => shareSheet(c, { version }).catch(fail) }, shareIcon(), "Share…");

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
      // One of your own keys is a danger row (it stops the share) and stays masked; the rest warn, with Show.
      const finding = (f) => {
        const key = f.kind === "secret";
        const sub = h("span", { class: "sub" }, `${f.label} · ${f.masked}`);
        const show = !key && h("button", { class: "ghost sm" }, "Show");
        if (show)
          show.addEventListener("click", () => {
            const open = show.textContent === "Show";
            sub.textContent = `${f.label} · ${open ? f.text : f.masked}`;
            show.textContent = open ? "Hide" : "Show";
          });
        return h("li", {}, h("span", { class: `dot ${key ? "danger" : "warn"}` }), h("div", { class: "grow" }, h("span", { class: "mono small" }, `${f.file}:${f.line}`), sub), show);
      };
      // After a link is made or revoked: the list again, on the version picked.
      const reload = async () => {
        check = await api(`/capabilities/${enc(c.id)}/share?version=${check.version}`);
        draw();
      };
      const revoke = async (l) => {
        if (!(await confirmDialog({ title: "Revoke this link?", body: `Nobody can install ${c.name} v${l.version} from it any more. Anyone who already did keeps their copy.`, confirm: "Revoke", danger: true }))) return;
        await api(`/capabilities/${enc(c.id)}/links/${enc(l.id)}`, { method: "DELETE" });
        await reload();
      };
      const draw = () => {
        put(pick, check.versions.map((v) => h("option", { value: v, selected: v === check.version }, `v${v}`)));
        const keys = check.findings.filter((f) => f.kind === "secret");
        const warnings = check.findings.filter((f) => f.kind !== "secret");
        const where = [...new Set(keys.map((f) => `${f.file}:${f.line}`))];
        const sampleRow = check.sample
          ? h("li", {}, h("span", { class: "dot ok" }), h("div", { class: "grow" }, h("span", {}, "Sample data"), h("span", { class: "sub" }, `sample/calls.json · ${plural(check.sample.calls, "call")} · always included`)))
          : check.connection
            ? h("li", {}, h("span", { class: "dot ok" }), h("div", { class: "grow" }, h("span", {}, "No sample data needed"), h("span", { class: "sub" }, "A connection has none of its own to show. Whoever installs it signs in with their own account.")))
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
          keys.length > 0 &&
            h(
              "div",
              { class: "notice danger info-notice" },
              h("span", { class: "grow" }, keys.length === 1 ? [h("span", { class: "mono" }, where[0]), ` is ${keys[0].label}. Remove it, then share again.`] : `${keys.length} of your own keys are in it (below). Remove them, then share again.`),
              h("button", { class: "sm", onclick: () => (close(), openChange(c, { m: `Remove the ${where.length > 1 ? "values" : "value"} hard-coded in ${where.join(", ")}; ${where.length > 1 ? "they" : "it"} must not be in the code. Read ${where.length > 1 ? "them" : "it"} from a setting or a key the tool asks for instead.` })) }, "Change…"),
            ),
          h(
            "div",
            {},
            h("div", { class: "eyebrow share-eyebrow" }, `What's in it · ${check.files} files`),
            h("ul", { class: "list" }, keys.map(finding), warnings.map(finding), sampleRow),
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
              check.address
                ? h("li", {}, h("div", { class: "grow" }, h("span", {}, "Link"), h("span", { class: "sub" }, "Anyone with it can install this version")), h("button", { class: "sm", disabled: blocked, onclick: () => linkSheet(c, check.version).then(reload).catch(fail) }, "Create…"))
                : h("li", {}, h("div", { class: "grow" }, h("span", {}, "Link"), h("span", { class: "sub" }, "Links need a public address")), h("button", { class: "link sm", onclick: () => (close(), go("#/settings/remote")) }, "Set up remote access ›")),
            ),
          ),
          check.links.length > 0 &&
            h(
              "div",
              {},
              h("div", { class: "eyebrow share-eyebrow" }, `Links · ${check.links.length}`),
              h("ul", { class: "list" }, check.links.map((l) => h("li", {}, h("div", { class: "grow" }, h("span", {}, `v${l.version}`), h("span", { class: "sub" }, `${timeLeft(l.expiresAt)} · ${plural(l.downloads, "download")}`)), h("button", { class: "sm ghost danger", onclick: () => revoke(l).catch(fail) }, "Revoke")))),
            ),
        );
      };
      draw();
      return [h("div", { class: "row sheet-head" }, appIcon(c, { size: 44 }), h("div", { class: "grow sheet-title" }, `Share ${c.name}`), pick), body, sheetActions(h("button", { onclick: () => close() }, "Done"))];
    },
    { width: 560 },
  );
}

/** How long a link still works: "6 days left", "5 hours left", or "until you revoke it". */
function timeLeft(expiresAt) {
  if (!expiresAt) return "until you revoke it";
  // Rounded: a 7-day link made a moment ago has 7 days left, not 6.
  const hours = (new Date(expiresAt).getTime() - Date.now()) / 3600_000;
  const days = Math.round(hours / 24);
  return days >= 2 ? `${days} days left` : hours >= 1 ? `${plural(Math.round(hours), "hour")} left` : "less than an hour left";
}

/** What each choice in Expires sends, and says. */
const EXPIRES = [
  ["1d", "1 day"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["never", "Never"],
];

/**
 * S3 a link to one version: pick how long it works (7 days unless you pick another), Create link,
 * then the link with Copy. Shown once: Hewn keeps only a fingerprint of it.
 */
function linkSheet(c, version) {
  return modal(
    (close) => {
      let expires = "7d";
      const line = h("div", { class: "small" });
      const sayLine = () => {
        line.className = expires === "never" ? "small error" : "small muted";
        line.textContent = expires === "never" ? "Anyone with this link can install this tool until you revoke it." : `Anyone with this link can install this version for ${EXPIRES.find(([k]) => k === expires)[1]}, until you revoke it.`;
      };
      const pick = segmented(EXPIRES, expires, (k) => ((expires = k), sayLine()), { label: "Expires" });
      pick.classList.add("self-start");
      sayLine();
      const status = h("div", { class: "small error" });
      const create = h("button", { class: "primary" }, "Create link");
      const actions = sheetActions(h("button", { onclick: () => close() }, "Cancel"), create);
      const result = h("div", { class: "stack-sm" });
      create.addEventListener("click", async () => {
        create.disabled = true;
        status.textContent = "";
        try {
          const made = await api(`/capabilities/${enc(c.id)}/links`, { method: "POST", body: { version, expires } });
          pick.querySelectorAll("button").forEach((b) => (b.disabled = true));
          const field = h("input", { type: "text", class: "mono grow", value: made.url, readOnly: true, "aria-label": "The link" });
          field.addEventListener("focus", () => field.select());
          const copy = h("button", { onclick: () => navigator.clipboard.writeText(made.url).then(() => toast("Link copied"), fail) }, "Copy");
          put(result, h("div", { class: "row tight" }, field, copy), h("div", { class: "small faint" }, "Copy it now: Hewn keeps only a fingerprint of the link, so it can't show it again. Share… lists it, with Revoke."));
          put(actions, h("button", { class: "primary", onclick: () => close() }, "Done"));
        } catch (e) {
          status.textContent = e.message;
          create.disabled = false;
        }
      });
      return [
        h("div", { class: "sheet-title" }, `Link to ${c.name} v${version}`),
        h("div", { class: "small muted" }, "A newer version needs a new link, so it's checked again."),
        h("div", { class: "stack-sm" }, h("div", { class: "eyebrow" }, "Expires"), pick, line),
        result,
        status,
        actions,
      ];
    },
    { width: 480 },
  );
}

/**
 * Write it yourself: sample/calls.json by hand (the override; Ask builder is the usual way).
 * Saving makes a new version with no builder; validation replays it on an empty tool first.
 */
async function samplePage(id) {
  const here = stillHere();
  view(backBar("Info", `#/c/${enc(id)}`), h("main", { class: "column", style: { "--w": "900px" } }, skeleton("40%", "90%", "70%")));
  const [cap, all] = await Promise.all([api(`/capabilities/${enc(id)}`), caps(true)]);
  if (!here()) return;
  const c = all.get(id) ?? { id, name: cap.name };
  setWallpaper(await hues([tintOf(c)]));
  const version = c.version ?? cap.versions[0]?.version;
  const has = (await api(`/capabilities/${enc(id)}/data`).catch(() => null))?.sample;
  const current = has ? await api(`/capabilities/${enc(id)}/code?version=${version}&path=${enc("sample/calls.json")}`).catch(() => null) : null;
  if (!here()) return;
  // A start: one call per operation that writes, with its required fields left for you to fill.
  const writes = cap.operations.filter((o) => o.sideEffect === "write" && !o.deprecated);
  const today = new Date().toISOString().slice(0, 10);
  const example = (sch = {}) => sch.enum?.[0] ?? (sch.type === "string" ? (sch.format === "date" ? today : "") : sch.type === "integer" || sch.type === "number" ? 0 : sch.type === "boolean" ? false : sch.type === "array" ? [] : sch.type === "object" ? {} : "");
  const callOf = (o) => ({ operation: o.name, input: Object.fromEntries((o.inputSchema?.required ?? []).map((k) => [k, example(o.inputSchema?.properties?.[k])])) });
  // One call per line, as builders write it.
  const oneLine = (x) => JSON.stringify(x, null, 1).replace(/\n\s*/g, " ");
  const format = (calls) => `[\n${calls.map((x) => `  ${oneLine(x)}`).join(",\n")}\n]\n`;
  const text = h("textarea", { class: "code-edit", rows: 20, spellcheck: false, "aria-label": "sample/calls.json" }, current?.text ?? format(writes.slice(0, 3).map(callOf)));
  const insert = (o) => {
    try {
      const calls = JSON.parse(text.value || "[]");
      if (!Array.isArray(calls)) throw new Error();
      text.value = format([...calls, callOf(o)]);
    } catch {
      text.value = `${text.value.trimEnd()}\n${oneLine(callOf(o))}\n`;
    }
    text.focus();
  };
  // What each operation takes: its fields, their types, which are required (*), and + Add for a call.
  const fieldsOf = (o) =>
    Object.entries(o.inputSchema?.properties ?? {}).map(([k, sch]) =>
      h("span", { class: "sample-field" }, h("span", { class: "mono" }, `${k}${(o.inputSchema?.required ?? []).includes(k) ? "*" : ""}`), h("span", { class: "faint" }, ` ${sch.enum ? sch.enum.map((x) => JSON.stringify(x)).join(" | ") : sch.format ?? sch.type ?? "any"}`)),
    );
  const guide = h(
    "div",
    { class: "card info-section sample-guide" },
    h("div", { class: "info-section-head" }, h("span", { class: "eyebrow" }, "The format")),
    h("pre", { class: "log sample-example" }, `[\n  { "operation": "${writes[0]?.name ?? "add_item"}",\n    "input": { … } },\n  { "operation": "…", "version": 1,\n    "input": { … } }\n]`),
    h("div", { class: "small muted" }, "A list of calls, run in order on an empty tool. ", h("span", { class: "mono" }, "input"), " is what the operation takes; ", h("span", { class: "mono" }, "version"), " pins an operation version (else the newest)."),
    h("div", { class: "info-section-head" }, h("span", { class: "eyebrow" }, `What it takes · ${writes.length}`)),
    h(
      "ul",
      { class: "list" },
      writes.length
        ? writes.map((o) => h("li", {}, h("div", { class: "grow col" }, h("span", { class: "mono" }, o.name), h("span", { class: "sub sample-fields" }, fieldsOf(o))), h("button", { class: "sm", onclick: () => insert(o) }, "+ Add")))
        : h("li", {}, h("span", { class: "grow muted" }, "Nothing it does writes, so there's nothing to fill.")),
    ),
    h("div", { class: "small faint" }, "* required. Made-up names and places, never yours."),
  );
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
      { class: "column info", style: { "--w": "1100px" } },
      h("div", { class: "info-head" }, appIcon(c, { size: 44 }), h("div", { class: "grow col" }, h("h1", { class: "title-lg" }, `Sample data · ${cap.name}`), h("span", { class: "muted small" }, "sample/calls.json · what the tool looks like in use"))),
      h(
        "div",
        { class: "small muted" },
        "Calls to its operations, in order, that show it in use: when someone installs it with sample data, and in its screenshots. Use local writes with made-up entries, or a local read for a tool with no data of its own. No keys, settings, network, other tools or model, and nothing of your own. ",
        h("button", { class: "link sm", onclick: () => openChange(c, { m: ASK_SAMPLE }) }, "Ask builder instead ›"),
      ),
      h(
        "div",
        { class: "sample-cols" },
        h(
          "div",
          { class: "stack-md grow" },
          h("div", { class: "card code-pane" }, h("div", { class: "code-head" }, h("span", { class: "mono small grow" }, "sample/calls.json")), text),
          status,
          h("div", { class: "row end" }, h("a", { class: "btn", href: `#/c/${enc(id)}` }, "Cancel"), save),
          h("div", { class: "small faint" }, "Saving makes a new version (no builder runs). It goes live only if every call replays without an error on an empty tool."),
        ),
        guide,
      ),
    ),
  );
}
