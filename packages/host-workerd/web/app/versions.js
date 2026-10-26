// SPDX-License-Identifier: AGPL-3.0-or-later
// A tool's versions (U3) and one version (U4): what led to it, kept for the tool's life (the
// conversation with the intake, the spec the builder worked from, the builder's log), its files
// in the code browser, Continue from here and Restore.
import { actorLabel, ago, api, appIcon, builderLabel, caps, enc, fail, h, setWallpaper, skeleton, tintOf } from "../kit.js";
import { buildModelWords } from "./build.js";
import { codeBrowser, versionSource } from "./files.js";
import { backBar, go, hues, put, view } from "./frame.js";
import { conversationThread } from "./intake.js";
import { changeHref, rollbackTo } from "./tool-actions.js";
import { segmented } from "./widgets.js";

export { madeBy, versionRow, versionPage, versionsPage };

/** What a version changed, in one line: the request that led to it. */
const changed = (v) => String(v.request?.request ?? v.request?.purpose ?? "").split("\n")[0].trim();
/**
 * How a version came to be, in words: built with a builder, asked for by an agent, installed from
 * files (no builder ran), or a quick change (a new tier or model, no builder either).
 */
const madeBy = (v, all) =>
  v.builder === "agent" ? `asked for by ${actorLabel(v.requestedBy, all)}` : /^copy:/.test(v.builder ?? "") ? "installed" : v.builder === "keep" ? "a quick change" : `built with ${builderLabel(v.builder)}`;
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

/** U3 Every version of a tool, newest first. */
async function versionsPage(id) {
  view(backBar("Info", `#/c/${enc(id)}`), h("main", { class: "column", style: { "--w": "760px" } }, skeleton("40%", "90%", "90%")));
  const { cap, all, c, active } = await load(id);
  view(
    backBar(cap.name, `#/c/${enc(id)}`),
    h(
      "main",
      { class: "column info", style: { "--w": "760px" } },
      h("div", { class: "info-head" }, appIcon(c, { size: 48 }), h("h1", { class: "title-lg grow" }, `Versions · ${cap.name}`)),
      h("div", { class: "card info-section" }, h("ul", { class: "list" }, cap.versions.map((v) => versionRow(c, v, active, all)))),
    ),
  );
}

/** U4 One version: Conversation · Spec · Log · Files as tabs on one page, Continue from here and Restore in the bar. */
async function versionPage(id, n, q) {
  view(backBar("Info", `#/c/${enc(id)}`), h("main", { class: "column", style: { "--w": "1100px" } }, skeleton("40%", "30%", "90%", "70%")));
  const { cap, all, c, active } = await load(id);
  const v = cap.versions.find((x) => x.version === n);
  if (!v) throw new Error(`${cap.name} has no version ${n}`);
  const build = v.buildId ? await api(`/builds/${enc(v.buildId)}`).catch(() => null) : null;
  const spec = String(v.request?.requirements ?? v.request?.request ?? "").trim();
  const who = actorLabel(v.requestedBy, all);
  const body = h("div", { class: "stack-md version-body" });
  const tabs = {
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
  const first = tabs[q?.get("tab")] ? q.get("tab") : "conversation";
  const show = async (tab) => {
    put(body, skeleton("60%", "40%"));
    try {
      put(body, await tabs[tab]());
    } catch (e) {
      put(body, h("div", { class: "muted" }, e.message || String(e)));
    }
  };
  const restore = v.version !== active && h("button", { onclick: () => rollbackTo(c, v.version).then(() => go(`#/c/${enc(id)}`), fail) }, "Restore");
  const resume = v.conversation && h("button", { onclick: () => go(changeHref(c, { from: v.buildId })) }, "Continue from here");
  const made = [capital(madeBy(v, all)), build && buildModelWords(build), ago(v.createdAt)].filter(Boolean).join(" · ");
  view(
    backBar(cap.name, `#/c/${enc(id)}`, (restore || resume) && h("div", { class: "glass-bar" }, resume, restore)),
    h(
      "main",
      { class: "column info version-page", style: { "--w": "1100px" } },
      h(
        "div",
        { class: "info-head" },
        appIcon(c, { size: 44 }),
        h("div", { class: "grow col" }, h("h1", { class: "title-lg clip-1" }, [`v${v.version}`, changed(v)].filter(Boolean).join(" · ")), h("span", { class: "muted small row tight" }, made, v.version === active && h("span", { class: "pill ok with-dot" }, "live"))),
        segmented([["conversation", "Conversation"], ["spec", "Spec"], ["log", "Log"], ["files", "Files"]], first, (tab) => show(tab), { label: "Show" }),
      ),
      body,
      restore && h("div", { class: "small faint" }, "Restoring keeps the data. It's refused if a newer version changed the data in a way older code can't read."),
    ),
  );
  show(first);
}
