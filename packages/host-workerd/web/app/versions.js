// SPDX-License-Identifier: AGPL-3.0-or-later
// A tool's versions (U3) and one version (U4): what led to it, kept for the tool's life (the
// conversation with the intake, the spec the builder worked from, the builder's log), Continue
// from here and Restore. Both are pages under the main top bar, as Settings is.
import { actorLabel, ago, api, appIcon, builderLabel, caps, confirmDialog, enc, fail, h, setWallpaper, skeleton, tintOf } from "../kit.js";
import { buildModelWords } from "./build.js";
import { go, hues, page, put, sandboxNotice, topBar, view } from "./frame.js";
import { conversationThread } from "./intake.js";
import { changeHref, rollbackTo } from "./tool-actions.js";

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

/** Back to the tool's Info, above a page's title (the main top bar has no back button). */
const backTo = (cap, id) => h("a", { class: "btn link self-start back-link", href: `#/c/${enc(id)}` }, `‹ ${cap.name}`);

/** U3 Every version of a tool, newest first. */
async function versionsPage(id) {
  page("", 760, skeleton("40%", "90%", "90%"));
  const { cap, all, c, active } = await load(id);
  page(
    "",
    760,
    h(
      "div",
      { class: "info stack-md" },
      backTo(cap, id),
      h("div", { class: "info-head" }, appIcon(c, { size: 48 }), h("h1", { class: "title-lg grow" }, `Versions · ${cap.name}`)),
      h("div", { class: "card info-section" }, h("ul", { class: "list" }, cap.versions.map((v) => versionRow(c, v, active, all)))),
    ),
  );
}

/** The parts of a version, as the left menu (as Settings has). Later releases add to it. */
const PARTS = [
  ["conversation", "Conversation"],
  ["spec", "Spec"],
  ["log", "Log"],
];

/**
 * U4 One version: the main top bar, the left menu of its parts (Conversation · Spec · Log), each
 * in a panel, and its actions (Continue from here, Restore) with its title.
 */
async function versionPage(id, n, q) {
  const frame = (side, ...content) => view(topBar(""), sandboxNotice(), h("main", { class: "settings-layout version-layout" }, side, h("div", { class: "settings-main" }, content)));
  frame(h("nav", { class: "side-list" }), skeleton("40%", "30%", "90%", "70%"));
  const { cap, all, c, active } = await load(id);
  const v = cap.versions.find((x) => x.version === n);
  if (!v) throw new Error(`${cap.name} has no version ${n}`);
  const build = v.buildId ? await api(`/builds/${enc(v.buildId)}`).catch(() => null) : null;
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
  };
  let part = parts[q?.get("tab")] ? q.get("tab") : "conversation";
  const menu = h("nav", { class: "side-list", "aria-label": `v${v.version}` });
  const drawMenu = () => put(menu, h("div", { class: "eyebrow" }, `v${v.version}`), PARTS.filter(([k]) => parts[k]).map(([k, label]) => h("button", { "aria-pressed": String(k === part), onclick: () => show(k) }, label)));
  // Switching parts keeps the page (and the URL, for a reload) without a new route.
  const show = async (k) => {
    part = k;
    drawMenu();
    history.replaceState(null, "", `#/c/${enc(id)}/v/${n}${k === "conversation" ? "" : `?tab=${k}`}`);
    panel.closest("main")?.classList.toggle("wide", k === "files");
    panel.setAttribute("aria-busy", "true");
    try {
      const el = await parts[k]();
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
  frame(
    menu,
    backTo(cap, id),
    h(
      "div",
      { class: "info-head version-head" },
      appIcon(c, { size: 48 }),
      h(
        "div",
        { class: "grow col" },
        h("div", { class: "row tight" }, h("h1", { class: "title-lg flush" }, `v${v.version}`), v.version === active && h("span", { class: "pill ok with-dot" }, "live")),
        changed(v) && h("p", { class: "version-what" }, changed(v)),
        h("span", { class: "muted small" }, made),
      ),
      (resume || restore) && h("div", { class: "row tight version-actions" }, resume, restore),
    ),
    panel,
  );
  show(part);
}
