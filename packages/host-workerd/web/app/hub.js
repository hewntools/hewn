// SPDX-License-Identifier: AGPL-3.0-or-later
// The Hub (Q1–Q3, Q5): one tab, one mixed grid of tools to install. In 0.4.9 it holds Hewn's own
// tools (Official), shipped with the release, so it works offline; 0.5 adds tools from others to
// the same grid. A tool's Hub page: its screens, Hewn's reading, its operations, what it needs,
// Source code, Install (or Open and Install a copy). Installing opens the one install sheet.
import { api, enc, fail, h, modal, setWallpaper, sheetActions, skeleton } from "../kit.js";
import { brandTile, hues, page, put, settings, stillHere, topBar, view } from "./frame.js";
import { bundleTile, installFromFile, installSheet, sourceSheet } from "./install.js";
import { titleCase } from "./models.js";
import { openCapability } from "./tool-actions.js";

export { hubCard, hubPage, hubToolPage };

const PER_PAGE = 9;

/** A card image's URL: it carries the release, so an upgrade's new screens aren't hidden by a cached old one. */
const imageUrl = (c, name) => `/api/hub/${enc(c.id)}/image/${name}?v=${enc(c.release)}`;

/**
 * What a tool needs, in words, for its card: nothing shown when it needs nothing; the hosts it
 * reaches; a model, in amber with "set up after install" when no model is set up (plain on hosted).
 */
function needsLine(c, modelReady) {
  const parts = [c.needs.hosts.length && `reaches ${c.needs.hosts.length > 2 ? `${c.needs.hosts.length} hosts` : c.needs.hosts.join(", ")}`, c.needs.model && (modelReady ? "uses a model" : "uses a model · set up after install"), c.needs.tools.length && `uses ${c.needs.tools.join(", ")}`].filter(Boolean);
  return h("div", { class: `small mono hub-needs ${c.needs.model && !modelReady ? "warn-text" : ""}` }, parts.join(" · "));
}

/** The Official mark: Hewn's 16px tile and the word, in the accent's ink. */
const official = () => h("span", { class: "row tight hub-official" }, brandTile(16), h("span", { class: "small" }, "Official"));

/** One card (Q2), the same on the Hub and on the hosted first run. */
function hubCard(c, { modelReady = true } = {}) {
  // The screen fills its 16:9 frame (the shots are taken at 16:9), cut at the bottom if anything.
  const shot = c.images.includes("screen") ? h("img", { src: imageUrl(c, "screen"), alt: "", loading: "lazy" }) : h("span", { class: "hub-shot-empty" }, bundleTile(c, 48));
  return h(
    "a",
    { class: "card hub-card", href: `#/hub/${enc(c.id)}` },
    h("div", { class: "hub-shot" }, shot),
    h(
      "div",
      { class: "hub-card-body" },
      h("div", { class: "row tight" }, bundleTile(c, 28), h("span", { class: "strong grow clip-1" }, c.name), c.installed && h("span", { class: "pill ok" }, "Installed")),
      h("div", { class: "small muted" }, c.line),
      needsLine(c, modelReady),
      h("div", { class: "grow" }),
      h("div", { class: "hub-card-foot" }, official()),
    ),
  );
}

/** Whether tools that use a model are ready to: a provider with a key, or hosted (its models are included). */
async function modelIsReady() {
  if (settings?.hosted) return true;
  const m = await api("/models").catch(() => null);
  return !!m && (!!m.host || !!m.providers?.find((p) => p.id === m.provider)?.keySet);
}

/** Stage an Official tool and open the install sheet (Hewn's reading ships with it; a name you have already is offered as "<name> 2"). */
async function installFromHub(id) {
  const preview = await api(`/hub/${enc(id)}/stage`, { method: "POST" });
  return installSheet(preview, { from: "From Hub · Official" });
}

/** Q2 the Hub: search, Install from a file, All · Official · popular tags, one grid, paging. */
async function hubPage(q) {
  const here = stillHere();
  page("hub", 960, skeleton("30%", "90%", "90%"));
  const [{ tools }, modelReady] = await Promise.all([api("/hub"), modelIsReady()]);
  if (!here()) return;
  let filter = q?.get("tag") ?? "all";
  let text = "";
  let at = 0;
  const grid = h("div", { class: "hub-grid" });
  const paging = h("div", { class: "row between hub-paging" });
  const chips = h("div", { class: "row tight wrap grow" });
  // Popular tags: the ones on the most tools.
  const counts = new Map();
  for (const t of tools) for (const tag of t.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const popular = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([t]) => t);
  const search = h("input", { type: "search", class: "grow", placeholder: `Search ${tools.length} tools`, "aria-label": "Search the Hub" });
  search.addEventListener("input", () => ((text = search.value.trim().toLowerCase()), (at = 0), draw()));
  const chip = (key, label) => h("button", { class: `chip plain ${filter === key ? "selected" : ""}`, onclick: () => ((filter = key), (at = 0), draw()) }, label);
  const draw = () => {
    put(chips, chip("all", "All"), h("button", { class: `chip plain ${filter === "official" ? "selected" : ""}`, onclick: () => ((filter = "official"), (at = 0), draw()) }, brandTile(16), "Official"), popular.length > 0 && h("span", { class: "chip-divider" }), popular.map((t) => chip(t, t)));
    const shown = tools.filter((t) => (filter === "all" || filter === "official" ? true : t.tags.includes(filter)) && (!text || `${t.name} ${t.line} ${t.tags.join(" ")}`.toLowerCase().includes(text)));
    put(grid, shown.length ? shown.slice(at, at + PER_PAGE).map((c) => hubCard(c, { modelReady })) : h("div", { class: "muted hub-none" }, "Nothing on the Hub matches that."));
    const pages = shown.length > PER_PAGE;
    put(
      paging,
      pages && h("span", { class: "small faint" }, `${at + 1}–${Math.min(at + PER_PAGE, shown.length)} of ${shown.length}`),
      pages && h("span", { class: "row tight" }, h("button", { class: "sm", disabled: at === 0, onclick: () => ((at -= PER_PAGE), draw()) }, "‹ Previous"), h("button", { class: "sm", disabled: at + PER_PAGE >= shown.length, onclick: () => ((at += PER_PAGE), draw()) }, "Next ›")),
    );
  };
  draw();
  page(
    "hub",
    960,
    h("div", { class: "row hub-head" }, h("h1", { class: "flush" }, "Hub"), search, h("button", { onclick: () => installFromFile().catch(fail) }, "Install from a file…")),
    h("div", { class: "row" }, chips),
    grid,
    paging,
  );
}

/** A screenshot, larger: the whole image, over the page; a click or Esc closes it. */
const enlarge = (src, alt) =>
  modal((close) => [h("img", { class: "lightbox-img", src, alt, onclick: () => close() }), sheetActions(h("button", { onclick: () => close() }, "Close"))], { width: 1200, cls: "lightbox" });

/** What it stores, from Hewn's reading, as "Keeps …" ("Plants with …" reads "Keeps plants with …"). */
const keepsLine = (s) => (/^keeps\b/i.test(s) ? s : `Keeps ${/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s}`);

/** Q3 a tool's Hub page. */
async function hubToolPage(id) {
  const here = stillHere();
  view(topBar("hub", { back: ["Hub", "#/hub"] }), h("main", { class: "column", style: { "--w": "880px" } }, skeleton("40%", "90%", "70%")));
  const [t, all] = await Promise.all([api(`/hub/${enc(id)}`), api("/capabilities").catch(() => [])]);
  if (!here()) return;
  setWallpaper(await hues([t.icon?.hue ?? 250]));
  if (!here()) return;
  // Yours, under whatever name you installed it (Hewn says which).
  const mine = t.installedAs && all.find((c) => c.id === t.installedAs);
  // The screen sets out the tool with its widget; the widget alone only when there's no screen.
  const shots = t.images.includes("screen") ? ["screen"] : t.images.filter((n) => n === "widget");
  const install = () => installFromHub(t.id).catch(fail);
  // Q5 its source: the install sheet's code browser, on the tool as it ships.
  const source = () => sourceSheet(t, { code: `/hub/${enc(t.id)}/code`, origin: "Official" }).catch(fail);
  const needs = [
    ...t.needs.hosts.map((x) => h("li", {}, h("span", { class: "pill" }, "host"), h("div", { class: "grow" }, h("span", {}, x)))),
    t.needs.model && h("li", {}, h("span", { class: "pill accent" }, "model"), h("div", { class: "grow" }, h("span", {}, "Use a model"), h("span", { class: "sub" }, `${titleCase(t.needs.model)} tier · asked on first use`))),
    ...t.needs.tools.map((x) => h("li", {}, h("span", { class: "pill accent" }, "tool"), h("div", { class: "grow" }, h("span", {}, `Uses ${x}`)))),
  ].filter(Boolean);
  const shot = (n) => {
    const src = imageUrl(t, n);
    const alt = `${t.name}: ${n === "screen" ? "its screen" : "its widget"}`;
    return h("button", { class: `hub-shot-btn ${n}`, "aria-label": `${alt}, larger`, onclick: () => enlarge(src, alt) }, h("img", { src, alt }));
  };
  view(
    topBar("hub", { back: ["Hub", "#/hub"] }),
    h(
      "main",
      { class: "column hub-page", style: { "--w": "880px" } },
      shots.length > 0 && h("div", { class: `hub-shots n${shots.length}` }, shots.map(shot)),
      h(
        "div",
        { class: "info-head" },
        bundleTile(t, 64),
        h("div", { class: "grow col" }, h("h1", { class: "title-xl" }, t.name), h("div", { class: "row tight wrap" }, h("span", { class: "pill accent" }, "Official"), h("span", { class: "pill" }, `v${t.version}`), mine && h("span", { class: "pill ok" }, "Installed"))),
        mine ? h("span", { class: "row tight" }, h("button", { onclick: install }, "Install a copy"), h("button", { class: "primary lg", onclick: () => openCapability(mine).catch(fail) }, "Open")) : h("button", { class: "primary lg", onclick: install }, "Install"),
      ),
      h(
        "div",
        { class: "hub-cols" },
        h(
          "div",
          { class: "stack-md" },
          h("div", { class: "card info-section hub-what" }, h("div", { class: "info-section-head" }, h("span", { class: "eyebrow" }, "What it does")), h("div", { class: "pretty" }, t.summary.message), t.summary.keeps && h("div", { class: "small muted" }, keepsLine(t.summary.keeps)), t.summary.reaches && h("div", { class: "small muted" }, t.summary.reaches), h("button", { class: "link self-start install-source", onclick: source }, "Source code ›")),
          h("div", { class: "card info-section" }, h("div", { class: "info-section-head" }, h("span", { class: "eyebrow" }, `Operations · ${t.operations.length}`)), h("ul", { class: "list" }, t.operations.map((o) => h("li", {}, h("div", { class: "grow" }, h("span", { class: "mono" }, o.name), o.description && h("span", { class: "sub clip-1" }, o.description)), h("span", { class: `pill ${o.sideEffect === "read" ? "" : o.sideEffect === "destructive" ? "danger" : "accent"}` }, o.sideEffect))))),
        ),
        h(
          "div",
          { class: "stack-md" },
          h("div", { class: "card info-section" }, h("div", { class: "info-section-head" }, h("span", { class: "eyebrow" }, "What it needs")), h("ul", { class: "list" }, needs.length ? needs : h("li", {}, h("span", { class: "dot ok" }), h("span", { class: "grow muted" }, "Nothing outside itself")))),
          // A version opens its code, as a version does in Info.
          h(
            "div",
            { class: "card info-section" },
            h("div", { class: "info-section-head" }, h("span", { class: "eyebrow" }, "Versions")),
            h("ul", { class: "list" }, t.versions.map((v) => h("li", { class: "link", tabindex: 0, onclick: source, onkeydown: (e) => e.key === "Enter" && source() }, h("div", { class: "grow col" }, h("span", {}, `v${v.version}`), h("span", { class: "sub" }, `${v.line} · ${new Date(v.date).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}`)), h("span", { class: "faint" }, "Source code ›")))),
          ),
        ),
      ),
    ),
  );
}
