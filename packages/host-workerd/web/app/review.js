// SPDX-License-Identifier: AGPL-3.0-or-later
// Review of an agent's change: what's new, and what else changes.
import { actorLabel, andList, capRef, h } from "../kit.js";

export { changeList, reviewChanges, reviewOp, reviewRequest, reviewTitle, reviewWarnings, warnedWords };

// ---------- review of agents' changes ----------

const EFFECT = { read: ["Reads", "read", "accent"], write: ["Changes", "change", "warn"], destructive: ["Deletes", "delete", "danger"] };
/** "export_all@1" → "export all"; later versions say so. */
const opLabel = (key) => {
  const [name, v] = key.split("@");
  return `${name.replace(/_/g, " ")}${v && v !== "1" ? ` (v${v})` : ""}`;
};

/** "Claude Code wants to add “export all” to <Reading Log>" (the tool as a cap-ref). */
function reviewTitle(b, all) {
  const who = actorLabel(b.requestedBy, all);
  const ref = capRef(all.get(b.capabilityId), b.capabilityId);
  // A fix you asked for of a held change's warnings: held again, for you to allow.
  if (b.request?.fixOf) return h("span", { class: "title-ref" }, b.kind === "create" ? "The builder fixed the warnings in a new tool, " : "The builder fixed the warnings in ", ref);
  const ops = b.review.newOperations.map((o) => `“${opLabel(o.key)}”`);
  // A new tool: everything in it is new.
  if (b.kind === "create") return h("span", { class: "title-ref" }, b.builder === "submitted" ? `${who} wrote a new tool, ` : `${who} asked for a new tool, `, ref);
  // A change the agent wrote itself (submitted) says so; else it asked Hewn's builder for it.
  if (b.builder === "submitted") return h("span", { class: "title-ref" }, ops.length ? [`${who} wrote a change that adds ${andList(ops)} to `, ref] : [`${who} wrote a change to `, ref]);
  return h("span", { class: "title-ref" }, ops.length ? [`${who} wants to add ${andList(ops)} to `, ref] : [`${who} wants to change `, ref]);
}

/** A description's first sentence (cut at 200 characters), and the rest. */
const summaryOf = (d = "") => {
  const first = /^[\s\S]+?[.!?](?=\s|$)/.exec(d.trim())?.[0] ?? d.trim();
  return first.length > 200 ? `${first.slice(0, 199).replace(/\s+\S*$/, "")}…` : first;
};
const restOf = (d = "") => {
  const t = d.trim();
  const first = /^[\s\S]+?[.!?](?=\s|$)/.exec(t)?.[0] ?? t;
  return first.length > 200 ? t : t.slice(first.length).trim();
};

/** One new operation: what agents can do with it, what it takes and (full view) what it returned in its tests. */
function reviewOp(o, { full }) {
  const [pill, verb, tone] = EFFECT[o.sideEffect] ?? EFFECT.write;
  const takes = o.inputs ? (o.inputs.length ? `takes ${o.inputs.join(", ")}` : "no input") : null;
  return h(
    "div",
    { class: "stack-sm" },
    h("div", { class: "row tight wrap" }, h("span", { class: `pill ${tone}` }, pill), h("span", { class: "strong" }, `Agents can then ${verb}: `, h("span", { class: "muted" }, summaryOf(o.description)))),
    // Descriptions are written for agents, often a long paragraph: the first sentence above, the rest folded.
    restOf(o.description) && h("details", { class: "small review-more" }, h("summary", {}, "Full description"), h("p", { class: "muted pre-line" }, restOf(o.description))),
    h("div", { class: "small faint mono" }, [o.key, takes].filter(Boolean).join(" · ")),
    full && (o.example ? [h("div", { class: "eyebrow" }, "What it returned in its tests"), h("pre", { class: "small review-example" }, o.example)] : o.inputs && h("div", { class: "small muted" }, "No test shows what it returns.")),
  );
}

/** Everything else about the change, from the diff with the live version: [ok, text]. Null for reviews from before this was recorded. */
function reviewChanges(r) {
  const c = r.changes;
  if (!c) return null;
  return [
    r.connection && [false, "It's a connection: this code holds your sign-in for that service"],
    c.ui ? [false, "The screen changes"] : [true, "Screen unchanged"],
    c.migrations.length ? [false, `How data is stored changes (${c.migrations.join(", ")})`] : [true, "No change to how data is stored"],
    c.newGrants.length ? [false, `Asks for new access: ${c.newGrants.join(", ")} (you approve that separately)`] : [true, "No new access"],
    c.changedOperations.length ? [false, `Updates ${andList(c.changedOperations.map(opLabel))} (compatibly)`] : [true, "Existing operations unchanged"],
    c.removedOperations.length && [false, `Removes ${andList(c.removedOperations.map(opLabel))} (unused)`],
  ].filter(Boolean);
}
/**
 * What its checks found that didn't fail it, each a notice: the sentence, then the check and where.
 * `openAt(w)`: where it is opens in the card's files, at its line. Nothing when there's none.
 */
const reviewWarnings = (ws = [], { openAt } = {}) =>
  ws.length > 0 && [
    h("div", { class: "eyebrow" }, ws.length === 1 ? "Warning" : "Warnings"),
    h(
      "div",
      { class: "stack-sm" },
      ws.map((w) => {
        const where = w.file && `${w.file}${w.line ? `:${w.line}` : ""}`;
        const at = where && openAt ? h("button", { class: "link mono review-warning-at", type: "button", title: `Open ${w.file}${w.line ? ` at line ${w.line}` : ""}`, onclick: () => openAt(w) }, where) : where;
        return h("div", { class: "notice warn review-warning" }, h("span", { class: "stack-sm" }, h("span", {}, w.message), h("span", { class: "small faint mono" }, w.check, at && [" · ", at])));
      }),
    ),
  ];
/** The card's line under its title: "It passed its checks" (with 2 warnings). */
const warnedWords = (ws = []) => `It passed its checks${ws.length ? ` with ${ws.length === 1 ? "a warning" : `${ws.length} warnings`}` : ""}. It goes live only if you allow it.`;
const changeList = (items) => h("ul", { class: "small stack-sm change-list" }, items.map(([ok, text]) => h("li", { class: ok ? "muted" : "strong" }, `${ok ? "✓" : "•"} ${text}`)));

/** The agent's own words, folded: written for the builder, so not the first thing to read. */
const reviewRequest = (b, all) => b.request?.request && h("details", { class: "small" }, h("summary", {}, b.request.fixOf ? "What the builder was asked to fix" : b.builder === "submitted" ? `What ${b.submittedBy ?? actorLabel(b.requestedBy, all)} says it changes` : `What ${actorLabel(b.requestedBy, all)} asked for`), h("p", { class: "muted" }, String(b.request.request)));
