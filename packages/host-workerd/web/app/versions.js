// SPDX-License-Identifier: AGPL-3.0-or-later
// A tool's versions (U3) and one version (U4): what led to it, kept for the tool's life (the
// conversation with the intake, the spec the builder worked from, the builder's log), its files
// in the code browser, Continue from here and Restore, under Info's top bar.
import { actorLabel, ago, api, builderLabel, capRef, caps, confirmDialog, enc, fail, h, setWallpaper, skeleton, tintOf } from "../kit.js";
import { buildModelWords } from "./build.js";
import { codeBrowser, versionSource } from "./files.js";
import { backBar, go, hues, put, sandboxNotice, stillHere, view } from "./frame.js";
import { conversationThread } from "./intake.js";
import { shareButton } from "./share.js";
import { changeHref, rollbackTo, toolActions } from "./tool-actions.js";

export { madeBy, versionRow, versionPage, versionsPage };

/** What a version changed, in one line: the request that led to it. */
const changed = (v) => String(v.request?.request ?? v.request?.purpose ?? "").split("\n")[0].trim();
/**
 * How a version came to be, in words: built with a builder, asked for by an agent, installed from
 * files (no builder ran), or a quick change (a new tier or model, no builder either).
 */
const madeBy = (v, all) =>
  v.builder === "agent" ? `asked for by ${actorLabel(v.requestedBy, all)}` : /^copy:/.test(v.builder ?? "") ? "installed" : v.builder === "bundle" ? "installed from a file" : v.builder === "keep" ? "a quick change" : `built with ${builderLabel(v.builder)}`;
const capital = (s) => s[0].toUpperCase() + s.slice(1);

/** One version as a list row: "v4 · live", what it changed, when and by what; Details opens it. */
function versionRow(c, v, active, all) {
  const what = changed(v);
  return h(
    "li",
    {},
    v.version === active && h("span", { class: "dot ok" }),
    h("div", { class: "grow" }, h("span", {}, v.version === active ? `v${v.version} · live` : `v${v.version}`), h("span", { class: "sub clip-1" }, [what, ago(v.createdAt), madeBy(v, all)].filter(Boolean).join(" · "))),
    h("button", { class: "sm ghost", onclick: () => go(`#/c/${enc(c.id)}/v/${v.version}`) }, "Details"),
  );
}

async function load(id) {
  const [cap, all] = await Promise.all([api(`/capabilities/${enc(id)}`), caps(true)]);
  const c = all.get(id) ?? { id, name: cap.name, kind: cap.kind };
  setWallpaper(await hues([tintOf(c)]));
  return { cap, all, c, active: c.version ?? cap.versions[0]?.version };
}

/** Info's top bar, the same on a tool's version pages. */
const toolBar = (c) => backBar("Home", "#/", toolActions(c, { extra: shareButton(c) }));
/** Back to the tool's Info: the tool itself, at the top left of the page. */
const backRef = (c, id, cls = "") => h("a", { class: `back-ref ${cls}`.trim(), href: `#/c/${enc(id)}` }, "‹", capRef(c, id, { size: 28 }));

/** U3 Every version of a tool, newest first. */
async function versionsPage(id) {
  const here = stillHere();
  view(backBar("Home", "#/"), h("main", { class: "column", style: { "--w": "760px" } }, skeleton("40%", "90%", "90%")));
  const { cap, all, c, active } = await load(id);
  if (!here()) return;
  view(
    toolBar(c),
    sandboxNotice(),
    h(
      "main",
      { class: "column info", style: { "--w": "760px" } },
      backRef(c, id, "self-start"),
      h("h1", { class: "title-lg" }, "Versions"),
      h("div", { class: "card info-section" }, h("ul", { class: "list" }, cap.versions.map((v) => versionRow(c, v, active, all)))),
    ),
  );
}

/** The parts of a version, as the left menu (as Settings has). */
const PARTS = [
  ["conversation", "Conversation"],
  ["spec", "Spec"],
  ["log", "Log"],
  ["files", "Files"],
];

/**
 * U4 One version: Info's top bar with the tool as its back button, the left menu of its parts
 * (Conversation · Spec · Log · Files), each in a panel, and its actions (Continue from here,
 * Restore) with its title, which leads with the version.
 */
async function versionPage(id, n, q) {
  const here = stillHere();
  const frame = (top, side, ...content) => view(top, sandboxNotice(), h("main", { class: "settings-layout version-layout" }, side, h("div", { class: "settings-main" }, content)));
  frame(backBar("Home", "#/"), h("nav", { class: "side-list" }), skeleton("40%", "30%", "90%", "70%"));
  const { cap, all, c, active } = await load(id);
  const v = cap.versions.find((x) => x.version === n);
  if (!v) throw new Error(`${cap.name} has no version ${n}`);
  const build = v.buildId ? await api(`/builds/${enc(v.buildId)}`).catch(() => null) : null;
  if (!here()) return;
  const spec = String(v.request?.requirements ?? v.request?.request ?? "").trim();
  const who = actorLabel(v.requestedBy, all);
  const panel = h("div", { class: "card version-panel" });
  const parts = {
    conversation: async () => {
      const ctx = v.buildId ? await api(`/builds/${enc(v.buildId)}/context`) : null;
      return ctx?.conversation?.length
        ? conversationThread(ctx.conversation, { mode: v.kind === "create" ? "create" : "modify", cap: c, all, version: v.version })
        : h("div", { class: "muted" }, who && who !== "You" ? `${who} asked for it; there was no conversation.` : "No conversation was kept.");
    },
    spec: async () => (spec ? h("pre", { class: "spec-text" }, spec) : h("div", { class: "muted" }, "No spec was kept.")),
    log: async () => {
      const t = v.buildId ? await api(`/builds/${enc(v.buildId)}/transcript`) : null;
      return t?.text ? h("pre", { class: "log version-log" }, t.text.split("\n").slice(-500).join("\n")) : h("div", { class: "muted" }, "No log was kept.");
    },
    files: async () => codeBrowser(versionSource(id, v.version)),
  };
  let part = parts[q?.get("tab")] ? q.get("tab") : "conversation";
  const menu = h("nav", { class: "side-list", "aria-label": `v${v.version}` });
  // The tool on top, as the way back to its Info; then the version's parts.
  const drawMenu = () => put(menu, backRef(c, id, "side-back"), PARTS.map(([k, label]) => h("button", { "aria-pressed": String(k === part), onclick: () => show(k) }, label)));
  // Switching parts keeps the page (and the URL, for a reload) without a new route.
  const show = async (k) => {
    part = k;
    drawMenu();
    history.replaceState(null, "", `#/c/${enc(id)}/v/${n}${k === "conversation" ? "" : `?tab=${k}`}`);
    // Files (the code browser) widens the page: code reads best with room beside its list of files.
    panel.closest("main")?.classList.toggle("wide", k === "files");
    panel.setAttribute("aria-busy", "true");
    try {
      const el = await parts[k]();
      // A part that loads more itself (the code browser) is swapped in once it's ready (or after a moment).
      if (el?.ready) await Promise.race([el.ready, new Promise((r) => setTimeout(r, 800))]);
      if (part === k) put(panel, el);
    } catch (e) {
      if (part === k) put(panel, h("div", { class: "muted" }, e.message || String(e)));
    }
    panel.removeAttribute("aria-busy");
  };
  const restore =
    v.version !== active &&
    h(
      "button",
      {
        onclick: async () => {
          const ok = await confirmDialog({ title: `Restore v${v.version}?`, body: `${cap.name} goes back to v${v.version}'s code. Its data stays as it is; restoring is refused if a newer version changed the data in a way older code can't read.`, confirm: "Restore" });
          if (ok) rollbackTo(c, v.version).then(() => go(`#/c/${enc(id)}`), fail);
        },
      },
      "Restore…",
    );
  const resume = v.conversation && h("button", { onclick: () => go(changeHref(c, { from: v.buildId })) }, "Continue from here");
  const made = [capital(madeBy(v, all)), build && buildModelWords(build), ago(v.createdAt)].filter(Boolean).join(" · ");
  // What it was asked to do: three lines, the rest a click away (a builder's request can run long).
  const text = changed(v) || `${cap.name}, version ${v.version}`;
  const long = text.length > 220;
  const what = h("h1", { class: `version-what${long ? " clamped" : ""}` }, text);
  if (long) what.addEventListener("click", () => what.classList.toggle("clamped"));
  if (long) what.title = "Click to show all of it, or less";
  frame(
    toolBar(c),
    menu,
    h(
      "div",
      { class: "info-head version-head" },
      h("span", { class: "version-tile", "aria-label": `Version ${v.version}` }, `v${v.version}`),
      h(
        "div",
        { class: "grow col" },
        what,
        h("div", { class: "row tight wrap" }, v.version === active && h("span", { class: "pill ok with-dot" }, "live"), h("span", { class: "muted small" }, made)),
      ),
      (resume || restore) && h("div", { class: "row tight version-actions" }, resume, restore),
    ),
    panel,
  );
  show(part);
}
