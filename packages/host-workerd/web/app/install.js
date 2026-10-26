// SPDX-License-Identifier: AGPL-3.0-or-later
// R1–R4, R7 Install: one sheet for a file (and, as they arrive, a link and the Hub); only the
// "From …" line changes. R1 choose the file; R2 your builder reads the code first (the sheet fills
// in with what it found); R3 the sheet: what it does, its flags, Source code, what it will ask for
// (a preview: grants still happen after install), Name, Start with sample data; R4 the build
// page; R7 one reason and one way forward when it can't be installed.
import { api, appIcon, builderLabel, commandBlock, enc, fail, h, hueOf, kindTag, modal, pixelGlyph, satOf, sheetActions, sheetHead } from "../kit.js";
import { go, put, settings } from "./frame.js";
import { codeBrowser } from "./files.js";
import { titleCase } from "./models.js";

export { bundleTile, installFromFile, installSheet };

/** A file may be at most this big (Hewn says so too). */
const MAX_BYTES = 5 * 1024 * 1024;

/** The tile of a tool that isn't installed yet: its hue, saturation and glyph from the file. */
function bundleTile(p, size = 48) {
  const cap = { id: p.id, name: p.name, hue: p.icon?.hue ?? undefined, saturation: p.icon?.saturation ?? undefined };
  if (!p.icon?.glyph?.length) return appIcon(cap, { size });
  return h("span", { class: "app-icon", style: { "--size": `${size}px`, "--hue": hueOf(cap), "--s": satOf(cap) }, "aria-hidden": "true" }, pixelGlyph(p.icon.glyph.map(([x, y]) => ({ x, y }))));
}

/** R1: choose a file (or drop it), then the sheet. */
async function installFromFile() {
  const file = await modal(
    (close) => {
      const input = h("input", { type: "file", accept: ".zip,application/zip", hidden: true, "aria-label": "A tool's file" });
      input.addEventListener("change", () => input.files[0] && close(input.files[0]));
      const zone = h("button", { type: "button", class: "drop-zone", onclick: () => input.click() }, h("span", { class: "strong" }, "Drop a tool's file here"), h("span", { class: "small muted" }, "or choose one · a .hewn.zip someone shared, up to 5 MB"));
      zone.addEventListener("dragover", (e) => (e.preventDefault(), zone.classList.add("over")));
      zone.addEventListener("dragleave", () => zone.classList.remove("over"));
      zone.addEventListener("drop", (e) => (e.preventDefault(), zone.classList.remove("over"), e.dataTransfer?.files?.[0] && close(e.dataTransfer.files[0])));
      return [sheetHead(null, "Install from a file", "Hewn reads it before anything is installed."), zone, input, sheetActions(h("button", { onclick: () => close(null) }, "Cancel"))];
    },
    { width: 520 },
  );
  if (!file) return;
  if (file.size > MAX_BYTES) return refusal({ message: `${file.name} is ${Math.round(file.size / 104857.6) / 10} MB; a tool's file may be at most 5 MB.` });
  const data = await new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] ?? "");
    r.onerror = () => no(r.error);
    r.readAsDataURL(file);
  });
  let preview;
  try {
    preview = await api("/bundles", { method: "POST", body: { data } });
  } catch (e) {
    return refusal(e);
  }
  return readThenInstall(preview, { from: `From a file · ${file.name}` });
}

/**
 * Files and links get read by your builder before the sheet (R2); a tool whose summary ships with
 * it (Hub, the shelf) goes straight to the sheet, where Check it yourself reads it again.
 */
async function readThenInstall(p, { from }) {
  if (p.summary) return installSheet(p, { from });
  const read = await readingSheet(p, { from });
  if (read === null) return void api(`/bundles/${enc(p.token)}`, { method: "DELETE" }).catch(() => {});
  return installSheet(read === "anyway" ? p : read, { from });
}

/** Who reads it: the builder you chose (hosted: implied, so unnamed). */
const reader = () => (settings?.intake && settings.intake !== "remote" ? builderLabel(settings.intake) : null);
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** The head every install sheet shares: the tile, "Install X", and where it's from. */
const installHead = (p, from) => h("div", { class: "row sheet-head" }, bundleTile(p), h("div", { class: "grow col" }, h("div", { class: "sheet-title" }, `Install ${p.name}`), h("div", { class: "small faint" }, `${from} · v${p.version}`)));

/**
 * R2: reading the code (typing dots), then the result in the same sheet: what it does, and what it
 * found (warnings first, each with Show: the code at that line). Resolves the preview with the
 * summary (Continue), "anyway" (Install anyway: no summary) or null (Cancel).
 */
function readingSheet(p, { from }) {
  return modal(
    (close) => {
      const body = h("div", { class: "stack-md" });
      const actions = h("div", { class: "actions flush between" });
      const who = reader();
      put(body, h("div", { class: "thread" }, h("div", { class: "bubble them typing" }, h("i"), h("i"), h("i"))), h("div", { class: "small muted" }, `${who ? `${who} is reading` : "Reading"} the code to say what it does with your data. Usually under a minute.`));
      put(actions, h("button", { class: "ghost", onclick: () => close("anyway") }, "Install anyway"), h("button", { onclick: () => close(null) }, "Cancel"));
      const source = () => h("button", { class: "link self-start install-source", onclick: () => sourceSheet(p).catch(fail) }, "Source code ›");
      api(`/bundles/${enc(p.token)}/summary`, { method: "POST" })
        .then((r) => {
          const row = (f) =>
            h(
              "li",
              {},
              h("span", { class: `dot ${f.kind === "warn" ? "warn" : "ok"}` }),
              h("div", { class: "grow" }, h("span", {}, f.title), (f.detail || f.file) && h("span", { class: "sub" }, f.detail, f.detail && f.file && " · ", f.file && h("span", { class: "mono" }, `${f.file}${f.line ? `:${f.line}` : ""}`))),
              f.file && h("button", { class: "ghost sm", onclick: () => sourceSheet(p, { path: f.file, line: f.line }).catch(fail) }, "Show"),
            );
          put(
            body,
            h("div", { class: "stack-sm" }, h("div", { class: "row between" }, h("div", { class: "eyebrow" }, "What it does"), h("span", { class: "small faint" }, `${r.by && r.by !== "remote" ? `Read by ${builderLabel(r.by)}` : "Read"} · ${mmss(r.seconds)}`)), h("div", { class: "pretty" }, r.summary.message)),
            r.summary.findings.length > 0 && h("div", {}, h("div", { class: "eyebrow share-eyebrow" }, "What it found"), h("ul", { class: "list" }, r.summary.findings.map(row))),
            source(),
          );
          put(actions, h("span", {}), h("span", { class: "row tight" }, h("button", { onclick: () => close(null) }, "Cancel"), h("button", { class: "primary", onclick: () => close({ ...p, summary: r.summary, summaryBy: "yours" }) }, "Continue")));
        })
        .catch((e) => {
          put(body, h("div", { class: "notice info-notice" }, h("span", { class: "grow" }, /no builder/i.test(e.message) ? "No summary: no builder set up." : `No summary: ${e.message}`)), source());
        });
      return [installHead(p, from), body, actions];
    },
    { width: 520 },
  );
}

/** R7: why it can't be installed, and the one way forward. */
function refusal(e) {
  const newer = e.details?.refusal === "newer";
  return modal(
    (close) => [
      sheetHead(null, newer ? "This tool needs a newer Hewn" : "This file can't be installed"),
      h("p", { class: "muted" }, e.message),
      newer && (settings?.hosted ? h("p", { class: "small muted" }, "Hewn upgrades for you; try again after the next upgrade.") : [h("div", { class: "small muted" }, "Upgrade, then install it again:"), commandBlock("hewn upgrade")]),
      sheetActions(h("button", { class: "primary", onclick: () => close() }, "OK")),
    ],
    { width: 440 },
  );
}

/** What it will ask for, as the grants sheet will show it after install. */
function asksRows(a) {
  const row = (tag, main, sub) => h("li", {}, kindTag(tag, tag === "model" ? "accent" : ""), h("div", { class: "grow" }, h("span", {}, main), sub && h("span", { class: "sub" }, sub)));
  const rows = [
    ...a.hosts.map((x) => row("host", `Reach ${x}`)),
    a.model && row("model", "Use a model", [a.model.tier ? `${titleCase(a.model.tier)} tier` : a.model.model, a.model.images && "with images", "asked on first use"].filter(Boolean).join(", ").replace(/, asked/, " · asked")),
    ...a.tools.map((x) => row("write", `Use ${x.id}`, x.operations.join(", "))),
    ...a.secrets.map((x) => row("key", x)),
    ...a.config.map((x) => row("setting", x)),
  ].filter(Boolean);
  return rows.length ? rows : [h("li", {}, h("span", { class: "dot ok" }), h("span", { class: "grow muted" }, "Nothing outside itself"))];
}

/** Its code, before it's installed: the code browser on the staged file (`at`: a file and line to show). */
function sourceSheet(p, at) {
  return modal(
    (close) => [
      h("div", { class: "row sheet-head" }, bundleTile(p, 44), h("div", { class: "grow col" }, h("div", { class: "sheet-title" }, `Source code · v${p.version}`), h("div", { class: "small faint" }, `${p.name} · read-only`))),
      codeBrowser({ label: `v${p.version}`, list: () => api(`/bundles/${enc(p.token)}/code`), file: (path) => api(`/bundles/${enc(p.token)}/code?path=${enc(path)}`) }, { at }),
      sheetActions(h("button", { onclick: () => close() }, "Done")),
    ],
    { width: 1100, cls: "wide-sheet" },
  );
}

/** R3 the install sheet. `from`: the line under the title ("From a file · plant-log.hewn.zip"). */
function installSheet(p, { from }) {
  let installed = false;
  let checking = false;
  return modal(
    (close) => {
      const name = h("input", { type: "text", value: p.suggestedName, "aria-label": "Name", maxLength: 60 });
      const sample = h("input", { type: "checkbox", checked: !!p.sample });
      const status = h("div", { class: "small error" });
      const install = h("button", { class: "primary" }, "Install");
      install.addEventListener("click", async () => {
        if (!name.value.trim()) return name.focus();
        install.disabled = true;
        status.textContent = "";
        try {
          const b = await api(`/bundles/${enc(p.token)}/install`, { method: "POST", body: { name: name.value.trim(), sample: sample.checked } });
          installed = true;
          close();
          go(`#/b/${enc(b.buildId)}`);
        } catch (e) {
          status.textContent = e.message;
          install.disabled = false;
        }
      });
      const flags = (p.summary?.findings ?? []).filter((f) => f.kind === "warn");
      // Hewn's own reading ships with an Official tool; Check it yourself has your builder read it too.
      const check = p.summaryBy === "hewn" && h("button", { class: "link sm", onclick: () => ((checking = true), close()) }, "Check it yourself");
      return [
        installHead(p, from),
        h("div", { class: "stack-sm" }, h("div", { class: "row between" }, h("div", { class: "eyebrow" }, "What it does"), check), h("div", { class: "pretty" }, p.summary?.message ?? p.description ?? p.purpose)),
        flags.map((f) => h("div", { class: "notice warn" }, h("span", { class: "grow" }, f.title, f.file && h("span", { class: "mono faint" }, ` · ${f.file}${f.line ? `:${f.line}` : ""}`)))),
        h("button", { class: "link self-start install-source", onclick: () => sourceSheet(p).catch(fail) }, "Source code ›"),
        h("div", {}, h("div", { class: "eyebrow share-eyebrow" }, "It will ask for"), h("ul", { class: "list" }, asksRows(p.asks))),
        h("label", { class: "field flush" }, h("span", { class: "label" }, "Name"), name),
        p.sample && h("label", { class: "check" }, sample, " Start with sample data ", h("span", { class: "faint" }, `· ${p.sample} example ${p.sample === 1 ? "entry" : "entries"}`)),
        status,
        sheetActions(h("button", { onclick: () => close() }, "Cancel"), install),
      ];
    },
    { width: 520 },
  ).then(async () => {
    if (checking) {
      const read = await readingSheet(p, { from });
      if (read && read !== "anyway") return installSheet(read, { from });
      if (read === "anyway") return installSheet(p, { from });
    } else if (installed) return;
    // Cancelled: the staged file goes (it would anyway, after a day).
    api(`/bundles/${enc(p.token)}`, { method: "DELETE" }).catch(() => {});
  });
}

