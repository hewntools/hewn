// SPDX-License-Identifier: AGPL-3.0-or-later
// Activity: All · Builds · Calls · Access.
import { actorLabel, ago, api, appIcon, builderLabel, capRef, caps, clock, empty, enc, fail, h, kindTag, menuFrom, setWallpaper, skeleton, tintOf } from "../kit.js";
import { askedBy, buildModelWords, chargeWords, kindWord, LIVE_BUILD, milestones, mmss, unresolvedFailures, waitingPill } from "./build.js";
import { go, hues, onLeave, page, put } from "./frame.js";
import { PROVIDERS, usd } from "./models.js";

export { activityPage, activityRow, groupItems };

// ---------- C3 / H1: Activity (All · Builds · Calls · Access) ----------

const dayLabel = (iso) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};

/** Consecutive calls by the same agent to the same tool collapse into one row. */
function groupItems(items) {
  const out = [];
  for (const i of items) {
    const prev = out.at(-1);
    // A model call belongs to the tool call logged just above it (same tool and caller).
    if (i.kind === "model" && prev?.kind === "calls" && prev.actor === i.actor && prev.capabilityId === i.capabilityId) {
      (prev.models ??= []).push(i);
      continue;
    }
    if (i.kind === "call" && prev?.kind === "calls" && prev.actor === i.actor && prev.capabilityId === i.capabilityId && dayLabel(prev.items[0].at) === dayLabel(i.at)) prev.items.push(i);
    else if (i.kind === "call") out.push({ kind: "calls", actor: i.actor, capabilityId: i.capabilityId, at: i.at, items: [i] });
    else if (i.kind === "model" && prev?.kind === "models" && prev.capabilityId === i.capabilityId && dayLabel(prev.items[0].at) === dayLabel(i.at)) prev.items.push(i);
    else if (i.kind === "model") out.push({ kind: "models", actor: i.actor, capabilityId: i.capabilityId, at: i.at, items: [i] });
    else out.push(i);
  }
  return out;
}

function activityRow(g, all, showCap) {
  const who = actorLabel(g.actor, all);
  const ref = showCap && g.capabilityId ? capRef(all.get(g.capabilityId), g.capabilityId) : null;
  const on = (...parts) => h("span", { class: "row tight wrap" }, parts.flat(Infinity).filter(Boolean).map((p) => (typeof p === "string" ? h("span", {}, p) : p)));
  let dot = "";
  let text;
  let expand = null;
  if (g.kind === "calls") {
    const errors = g.items.filter((c) => c.outcome !== "ok");
    const spent = (g.models ?? []).reduce((n, x) => n + x.costUsd, 0);
    const modelNote = g.models?.length ? h("span", { class: "faint" }, `model ${usd(spent)}`) : "";
    if (g.items.length === 1) {
      const c = g.items[0];
      dot = c.outcome === "ok" ? "ok" : "danger";
      text = on(h("span", { class: "mono" }, c.operation.split("@")[0]), c.outcome === "ok" ? "" : /timed? ?out/i.test(c.outcome) ? "timed out" : "failed", modelNote, ref && ["on", ref]);
    } else {
      dot = errors.length === g.items.length ? "danger" : errors.length ? "warn" : "ok";
      text = on(`${who} made ${g.items.length} calls`, ref && ["to", ref], errors.length ? h("span", { class: "faint" }, `${errors.length} failed`) : "", modelNote);
    }
    // One call or several, the row opens the same way: each call's version, error, time taken.
    expand = h(
      "ul",
      { class: "list nested", hidden: true },
      g.items.map((c) => h("li", {}, h("span", { class: `dot ${c.outcome === "ok" ? "" : "danger"}` }), h("div", { class: "grow" }, h("span", { class: "mono small" }, c.operation), c.outcome !== "ok" && h("span", { class: "sub" }, c.outcome.replace(/^ERROR /, ""))), h("span", { class: "mono faint small" }, `${c.ms}ms`), h("span", { class: "mono faint small time" }, clock(c.at)))),
    );
  } else if (g.kind === "models") {
    const failed = g.items.filter((x) => x.outcome === "failed");
    const cost = g.items.reduce((n, x) => n + x.costUsd, 0);
    const model = (x) => x.model.replace(/^[a-z]+\//, "");
    const tokens = (x) => `${x.inputTokens.toLocaleString()} in · ${x.outputTokens.toLocaleString()} out`;
    dot = failed.length === g.items.length ? "danger" : failed.length ? "warn" : "";
    if (g.items.length === 1) {
      const x = g.items[0];
      text = on("Model", h("span", { class: "mono" }, model(x)), x.outcome === "failed" ? h("span", { class: "faint" }, `failed: ${x.error ?? ""}`) : h("span", { class: "faint" }, `${tokens(x)} · ${usd(x.costUsd)}`), ref && ["·", ref]);
    } else {
      text = on(`${g.items.length} model calls`, h("span", { class: "faint" }, usd(cost)), failed.length ? h("span", { class: "faint" }, `${failed.length} failed`) : "", ref && ["·", ref]);
      expand = h(
        "ul",
        { class: "list nested", hidden: true },
        g.items.map((x) => h("li", {}, h("span", { class: `dot ${x.outcome === "failed" ? "danger" : ""}` }), h("div", { class: "grow" }, h("span", { class: "mono small" }, model(x)), h("span", { class: "sub" }, x.outcome === "failed" ? x.error ?? "failed" : tokens(x))), h("span", { class: "mono faint small" }, usd(x.costUsd)), h("span", { class: "mono faint small time" }, clock(x.at)))),
      );
    }
  } else if (g.kind === "build") {
    const what = g.buildKind === "create" ? "Built" : "Changed to";
    // What it ran on: "· Fable · high effort" (the model the builder reported, once it did).
    const ran = [buildModelWords({ model: g.buildModel }), chargeWords(g.charge)].filter(Boolean).join(" · ");
    if (g.outcome === "promoted") text = on(`${what} v${g.version}`, ref && ["·", ref], ran && h("span", { class: "faint" }, `· ${ran}`));
    else if (g.outcome === "failed") (dot = "danger"), (text = on(`Build failed: ${g.reason || g.failure?.title || "see log"}`, ref && ["·", ref], g.charge && h("span", { class: "faint" }, `· ${chargeWords(g.charge)}`)));
    else if (g.outcome === "cancelled") text = on("Build cancelled", ref && ["·", ref]);
    else (dot = "live"), (text = on("Building…", ref && ["·", ref]));
  } else if (g.kind === "lifecycle") {
    // Schedule details read "created <id>: op@1 daily 07:00" / "paused <id> after 3 failures": drop the id.
    const sm = /^(\w+) [\w-]+:? ?(.*)$/.exec(g.detail ?? "");
    const schedule = sm ? `Schedule ${sm[1]}${sm[2] ? `: ${sm[2].replace(/@\d+/, "")}` : ""}` : "Schedule";
    const words = { delete: "Deleted", restore: "Restored", purge: "Permanently deleted", rollback: `Rolled back ${g.detail}`, schedule };
    dot = g.outcome === "purge" || g.outcome === "delete" ? "warn" : "";
    text = on(words[g.outcome] ?? g.outcome, ref && ["·", ref]);
  } else if (g.kind === "authority") {
    const subject = actorLabel(g.subject, all);
    const words = {
      agent_connected: () => ((dot = "ok"), on(`Connected ${subject}`, g.detail && h("span", { class: "faint" }, g.detail))),
      agent_declined: () => on(`Declined ${g.subject}`),
      agent_revoked: () => ((dot = "warn"), on(`Disconnected ${subject}`)),
      agent_scopes: () => on(`${subject} may now: ${g.detail || "nothing"}`),
      agent_capabilities: () => on(`${subject} sees: ${g.detail === "*" ? "everything" : g.detail || "nothing"}`),
      secret_set: () => on("Set secret", h("span", { class: "mono" }, g.subject), ref && ["·", ref]),
      secret_removed: () => ((dot = "warn"), on("Removed secret", h("span", { class: "mono" }, g.subject), ref && ["·", ref])),
      destructive_confirmed: () => ((dot = "warn"), on(`Let ${subject} run`, h("span", { class: "mono" }, (g.detail ?? "").split("@")[0]), ref && ["on", ref])),
      destructive_rejected: () => on(`Stopped ${subject} running`, h("span", { class: "mono" }, (g.detail ?? "").split("@")[0]), ref && ["on", ref]),
      models_set: () => on("Changed model settings", h("span", { class: "faint" }, g.detail)),
      model_key_set: () => on(`Set the ${PROVIDERS[g.subject]?.label ?? g.subject} API key`),
      model_key_removed: () => ((dot = "warn"), on(`Removed the ${PROVIDERS[g.subject]?.label ?? g.subject} API key`)),
      model_budget_80: () => ((dot = "warn"), on(`Model spend passed 80% of ${g.subject === "all" ? "the monthly cap" : "its cap"}`, h("span", { class: "faint" }, g.detail), g.subject !== "all" && ref && ["·", ref])),
      passkey_added: () => ((dot = "ok"), on(`Added passkey “${g.subject}”`, h("span", { class: "faint" }, g.detail))),
      passkey_removed: () => ((dot = "warn"), on(`Removed passkey “${g.subject}”`, h("span", { class: "faint" }, g.detail))),
      public_url_set: () => on(g.subject === "none" ? "Removed the public address" : "Set the public address", g.subject !== "none" && h("span", { class: "mono" }, g.subject)),
      model_retired: () => ((dot = "warn"), on(h("span", { class: "mono" }, g.subject), "is no longer available", g.detail && h("span", { class: "faint" }, g.detail), ref && ["·", ref])),
    };
    text = (words[g.outcome] ?? (() => on(g.outcome)))();
  } else {
    const grant = g.grant.startsWith("capability:") ? [capRef(all.get(g.grant.slice(11).split("/")[0]), g.grant.slice(11).split("/")[0])] : [g.grant.replace(/^host:/, "").replace(/^secret:/, "")];
    if (g.outcome === "approve") (dot = "ok"), (text = on(`${who} authorized`, ...grant, ref && ["for", ref]));
    else if (g.outcome === "revoke") text = on("Revoked", ...grant, ref && ["for", ref]);
    else (dot = "warn"), (text = on("Asked for access", ref && ["for", ref]));
  }
  const href = g.kind === "build" ? `#/b/${g.buildId}` : null;
  const li = h(
    "li",
    { class: href || expand ? "link" : "", tabindex: href || expand ? 0 : undefined },
    h("span", { class: `dot ${dot}` }),
    h("div", { class: "grow" }, text, expand),
    h("span", { class: "pill" }, who),
    h("span", { class: "mono faint small time" }, clock(g.at)),
  );
  const act = (e) => {
    if (expand && !expand.contains(e.target)) expand.hidden = !expand.hidden;
    else if (href) go(href);
  };
  if (href || expand) li.addEventListener("click", act), li.addEventListener("keydown", (e) => e.key === "Enter" && act(e));
  return li;
}

const ACTIVITY_VIEWS = [
  ["all", "All", ""],
  ["builds", "Builds", "build"],
  ["calls", "Calls", "call,model"],
  ["access", "Access", "grant,authority"],
];

async function activityPage(q) {
  page("", 760, skeleton());
  const capability = q.get("capability") ?? "";
  const agent = q.get("agent") ?? "";
  const viewKey = ACTIVITY_VIEWS.some(([k]) => k === q.get("view")) ? q.get("view") : "all";
  const [all, agents] = await Promise.all([caps(true), api("/agents").catch(() => [])]);
  setWallpaper(await hues(capability && all.get(capability) ? [tintOf(all.get(capability))] : []));
  const setQ = (k, v) => {
    const p = new URLSearchParams({ view: viewKey, capability, agent });
    v ? p.set(k, v) : p.delete(k);
    for (const [key, val] of [...p]) if (!val || (key === "view" && val === "all")) p.delete(key);
    go(`#/activity${[...p].length ? `?${p}` : ""}`);
  };
  const capChip = capability
    ? h("button", { class: "chip selected", onclick: () => setQ("capability", "") }, appIcon(all.get(capability) ?? { id: capability, name: capability }, { size: 24 }), all.get(capability)?.name ?? capability, h("span", { class: "x", "aria-label": "Clear" }, "×"))
    : h("button", { class: "chip plain" }, "All tools", h("span", { class: "caret" }));
  if (!capability) capChip.addEventListener("click", () => menuFrom(capChip, [...all.values()].filter((c) => c.version).map((c) => [capRef(c), () => setQ("capability", c.id)])));
  const agentChip = agent
    ? h("button", { class: "chip plain selected" }, agent === "you" ? "You" : actorLabel(agent, all), h("span", { class: "x", "aria-label": "Clear" }, "×"))
    : h("button", { class: "chip plain" }, "All agents", h("span", { class: "caret" }));
  agentChip.addEventListener("click", () => (agent ? setQ("agent", "") : menuFrom(agentChip, [["You", () => setQ("agent", "you")], ...agents.map((a) => [actorLabel(a.id, all), () => setQ("agent", a.id)])])));
  const seg = h("div", { class: "segmented" }, ACTIVITY_VIEWS.map(([k, label]) => h("button", { "aria-pressed": String(k === viewKey), onclick: () => setQ("view", k === "all" ? "" : k) }, label)));
  const head = [h("div", { class: "row between wrap" }, h("h1", { class: "flush" }, "Activity"), seg), h("div", { class: "row tight" }, capChip, viewKey !== "builds" && agentChip)];

  if (viewKey === "builds") return buildsView(head, capability, all);

  const cardEl = h("div", { class: "card timeline" });
  const more = h("button", { class: "ghost self-center" }, "Show more");
  let items = [];
  const kinds = ACTIVITY_VIEWS.find(([k]) => k === viewKey)[2];
  const load = async (before) => {
    const p = new URLSearchParams({ ...(capability ? { capability } : {}), ...(agent ? { agent } : {}), ...(before ? { before } : {}), ...(kinds ? { kinds } : {}), limit: "120" });
    const r = await api(`/activity?${p}`);
    items = [...items, ...r.items];
    render();
    more.hidden = !r.next;
    more.onclick = () => load(r.next).catch(fail);
  };
  const render = () => {
    if (!items.length) return cardEl.replaceWith(empty("Nothing yet", capability || agent || kinds ? "Nothing matches these filters." : "Calls, builds and access changes show up here."));
    const days = new Map();
    for (const g of groupItems(items)) {
      const d = dayLabel(g.at);
      if (!days.has(d)) days.set(d, []);
      days.get(d).push(g);
    }
    put(cardEl, ...[...days].map(([d, gs]) => [h("div", { class: "eyebrow" }, d), h("ul", { class: "list" }, gs.map((g) => activityRow(g, all, !capability)))]).flat());
  };
  page("", 760, head, cardEl, more);
  more.hidden = true;
  await load();
}

/**
 * H1 Activity › Builds: in progress, failed (and not dealt with), earlier. Real milestones only, no
 * progress bars. Live while something builds.
 */
async function buildsView(head, only, all0) {
  const load = () => Promise.all([api("/builds?n=200&brief=1"), caps(true).catch(() => all0)]);
  const root = h("div", { class: "card timeline builds" });
  const render = (builds, all) => {
    const list = only ? builds.filter((b) => b.capabilityId === only) : builds;
    const failed = new Set(unresolvedFailures(builds).map((b) => b.buildId));
    const live = list.filter((b) => LIVE_BUILD.has(b.status) || b.status === "review");
    const open = list.filter((b) => failed.has(b.buildId));
    const rest = list.filter((b) => !LIVE_BUILD.has(b.status) && b.status !== "review" && !failed.has(b.buildId));
    const nameOf = (b) => all.get(b.capabilityId)?.name ?? b.request?.name ?? b.capabilityId;
    const sub = (b) => {
      if (b.status === "waiting") return h("span", { class: "sub row tight" }, "Starts once ", b.dependsOn ? h("a", { href: `#/b/${enc(b.dependsOn)}` }, b.queued ? "the change before it" : "the build it needs") : "the build it needs", " is done");
      if (b.status === "review") return h("span", { class: "sub" }, `${actorLabel(b.requestedBy, all)} changed it: it waits for you`);
      if (LIVE_BUILD.has(b.status)) return h("span", { class: "sub row tight" }, askedBy(b) && h("span", { class: "faint" }, `${askedBy(b)}on your ${builderLabel(b.builder)}`), milestones(b));
      const first = String(b.request?.request || b.request?.purpose || "").split("\n")[0];
      return h("span", { class: "sub clip-1" }, (b.status === "failed" && b.failure?.title) || (first.length > 140 ? `${first.slice(0, 140)}…` : first) || (b.kind === "widgets" ? "Suggested by the builder" : " "));
    };
    const right = (b) =>
      b.status === "promoted"
        ? kindTag(b.resultVersion ? `v${b.resultVersion}` : "done", "ok")
        : b.status === "failed"
          ? failed.has(b.buildId)
            ? h("button", { class: "sm", onclick: (e) => (e.stopPropagation(), api(`/builds/${enc(b.buildId)}/retry`, { method: "POST" }).then((n) => go(`#/b/${n.buildId}`), fail)) }, "Retry")
            : kindTag("failed", "danger")
          : b.status === "review"
            ? h("span", { class: "pill warn with-dot" }, "needs you")
            : b.status === "waiting"
              ? waitingPill(b)
              : LIVE_BUILD.has(b.status)
                ? h("span", { class: "mono faint small" }, b.progress ? mmss(b.progress.elapsedSeconds * 1000) : "")
                : kindTag(b.status);
    const row = (b) => {
      const c = all.get(b.capabilityId) ?? { id: b.capabilityId, name: nameOf(b) };
      const lit = b.step?.step === "tests" && b.tests?.total ? b.tests.passed / b.tests.total : 0;
      return h(
        "li",
        { class: "link build-row", tabindex: 0, onclick: () => go(`#/b/${enc(b.buildId)}`), onkeydown: (e) => e.key === "Enter" && go(`#/b/${enc(b.buildId)}`) },
        appIcon(c, { size: 36, ...(LIVE_BUILD.has(b.status) ? { progress: lit, waiting: !lit } : {}), badge: failed.has(b.buildId) ? "danger" : null }),
        h("div", { class: "grow" }, h("span", {}, `${nameOf(b)} · ${kindWord(b)}`), sub(b)),
        h("span", { class: "small faint" }, LIVE_BUILD.has(b.status) ? "" : ago(b.updatedAt ?? b.createdAt)),
        right(b),
      );
    };
    const section = (title, items) => items.length > 0 && [h("div", { class: "eyebrow" }, title), h("ul", { class: "list" }, items.map(row))];
    put(root, !list.length && h("div", { class: "muted small builds-empty" }, "No builds yet."), section("In progress", live), section("Failed", open), section(open.length || live.length ? "Earlier" : "Recent", rest));
    return live.length > 0;
  };
  const [b0, a0] = await load();
  page("", 760, head, root);
  let timer;
  const poll = async () => {
    if (!document.body.contains(root)) return;
    const next = await load().catch(() => null);
    if (!document.body.contains(root)) return;
    timer = setTimeout(poll, !next || render(...next) ? 2500 : 15000);
  };
  timer = setTimeout(poll, render(b0, a0) ? 2500 : 15000);
  onLeave(() => clearTimeout(timer));
}
