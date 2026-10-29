// SPDX-License-Identifier: AGPL-3.0-or-later
// A build: its page, or the panel in the change drawer.
import { actorLabel, api, appIcon, builderLabel, caps, confirmDialog, enc, errorBox, fail, h, invalidateCaps, kindTag, setWallpaper, skeleton, stepRow, tintOf } from "../kit.js";
import { AGENT_CATALOG, agentTile, catalogOf } from "./agents.js";
import { shotUrl } from "./appearance.js";
import { go, hues, moment, onLeave, put, sandboxNotice, topBar, view } from "./frame.js";
import { grantsSheet, signInDialog } from "./grants.js";
import { modelWords } from "./home.js";
import { pollInbox } from "./inbox.js";
import { conversationThread } from "./intake.js";
import { titleCase } from "./models.js";
import { changeList, reviewChanges, reviewOp, reviewRequest, reviewTitle } from "./review.js";
import { openCapability } from "./tool-actions.js";
import { addWidgetSheet, widgetPreview } from "./widgets.js";

export { askedBy, buildModelWords, buildPage, buildPanel, chargeWords, installedFrom, kindWord, LIVE_BUILD, milestones, mmss, retryable, unresolvedFailures, waitingPill };

// ---------- B3 / B4 / H2–H6: a build (its page, or in the change drawer) ----------

const STEPS = [
  ["spec", "Spec agreed"],
  ["code", "Writing code"],
  ["tests", "Running tests"],
  ["auth", "Your authorization"],
];
/** Where an install came from, as its build request says, in the words Hewn uses everywhere (`sourceWords` in the core): "from Hub", "from <host>" or "from a file". */
const installedFrom = (b) => {
  const s = b.request?.source;
  return s?.from === "hub" ? "from Hub" : s?.from === "link" ? `from ${s.host ?? "a link"}` : "from a file";
};
/** A tool installed from a file or from Hub has no builder: its milestones are the file's (R4). */
const installSteps = (b) => [
  ["spec", b.request?.source?.from === "hub" ? "From Hub" : "From the file"],
  ["code", "Unpacked"],
  ["tests", "Running tests"],
  ["auth", "Your authorization"],
];
/** No builder runs: an install from a file, Hub or a directory, or a change that needs none. */
const noBuilder = (b) => b.builder === "keep" || b.builder === "bundle" || String(b.builder ?? "").startsWith("copy:");
/** Retry runs the same builder again; an install from a file or your own edit had none (Hewn refuses), so you do it again instead. */
const retryable = (b) => b.builder !== "bundle" && b.builder !== "keep";
const stepsOf = (b) => (b.builder === "bundle" ? installSteps(b) : STEPS);
const mmss = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
const BUILD_KIND = { create: "new", modify: "change", widgets: "widgets" };
const LIVE_BUILD = new Set(["waiting", "open", "building", "validating"]);
/** A build's kind in words: a change that only touched the manifest is a quick change. */
const kindWord = (b) => (b.builder === "keep" || b.request?.manifestOnly ? "quick change" : BUILD_KIND[b.kind] ?? b.kind);

/**
 * Failed builds nobody has dealt with yet: not retried, and nothing of that tool promoted since (a
 * later change replaced it). These are what "needs you" means for builds.
 */
const unresolvedFailures = (builds) =>
  builds.filter((b) => b.status === "failed" && !builds.some((x) => x.request?.retryOf === b.buildId || x.request?.autoRetryOf === b.buildId) && !builds.some((x) => x.capabilityId === b.capabilityId && (x.kind === b.kind || b.kind === "create") && x.status === "promoted" && x.createdAt > b.createdAt));

/** V6 A build that waits its turn says for what, the same in the drawer, the Inbox and Activity. */
const waitingPill = (b) => kindTag(b.queued ? "waiting for the change before it" : "waiting", "warn");

/** Real milestones only (no progress bars): spec ✓ code ✓ tests 4/6 you, or waiting. */
function milestones(b) {
  if (b.status === "waiting") return h("span", { class: "milestones" }, waitingPill(b));
  const at = STEPS.findIndex(([k]) => k === (b.step?.step ?? "code"));
  const tests = b.tests ?? b.step?.tests;
  return h(
    "span",
    { class: "milestones" },
    kindTag("spec ✓", "ok"),
    at > 1 ? kindTag("code ✓", "ok") : h("span", { class: "pill accent with-dot" }, "code"),
    at === 2 ? h("span", { class: "pill accent with-dot" }, tests ? `tests ${tests.passed}/${tests.total}` : "tests") : at > 2 ? kindTag("tests ✓", "ok") : kindTag("tests"),
    at === 3 ? h("span", { class: "pill warn with-dot" }, "you") : kindTag("you"),
  );
}

async function buildPage(id) {
  const panel = buildPanel(id, {});
  view(...moment({ left: "-60px", bottom: "-20px" }, topBar(""), sandboxNotice(), h("div", { class: "build-center" }, panel.el)));
}

/**
 * One build, live: the steps, then how it ended. The log is always there: following the builder
 * while it works, collapsed under "Show log" once it succeeds, open by default when it fails (H6).
 * `compact`: in the change drawer (P3); `onPromoted(b)`: what to show there when it's live (P4).
 */
/** What a build runs on, in words ("Fable · high effort"; the model it ran on, once the builder says). */
const buildModelWords = (b) => (b.model && (b.model.ran || b.model.model || b.model.effort) ? modelWords({ model: b.model.ran ?? b.model.model, effort: b.model.effort }) : "");
/** What the builder's host charged, as it says it: "12 points" (1 decimal at most). */
const chargeWords = (c) => (c ? `${Math.round(c.amount * 10) / 10} ${c.unit}` : "");

/**
 * Who builds it on what, as a labelled strip across the card: who asked (if not you), the builder,
 * the model, the effort (a meter) and whose account it runs on.
 */
function buildMeta(b) {
  const who = actorLabel(b.requestedBy);
  const asked = who && who !== "You" && !String(b.requestedBy).startsWith("ui:");
  const model = b.model?.ran ?? b.model?.model;
  const efforts = ["low", "medium", "high", "xhigh", "max"];
  const level = b.model?.effort ? Math.max(0, efforts.indexOf(b.model.effort)) + 1 : 0;
  const cell = (label, value, sub, title) => h("div", { class: "meta-cell", title: title ?? "" }, h("span", { class: "meta-label" }, label), h("span", { class: "meta-value" }, value), sub && h("span", { class: "meta-sub" }, sub));
  // "claude-fable-5-5" reads as "Fable 5.5" (the full name on hover); other names as they are.
  const pretty = (m) => /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m)?.slice(1).reduce((name, n, i) => (i ? `${name}${i === 1 ? " " : "."}${n}` : n[0].toUpperCase() + n.slice(1)), "") ?? modelWords({ model: m });
  return h(
    "div",
    { class: "build-meta" },
    asked && cell("Asked by", [agentTile(catalogOf({ id: b.requestedBy })?.id ?? b.requestedBy, who, 18), who]),
    cell("Builder", [agentTile(AGENT_CATALOG.find((c) => c.tool === b.builder)?.id ?? b.builder, builderLabel(b.builder), 18), builderLabel(b.builder)], b.builder !== "remote" && "on your account"),
    cell("Model", model ? pretty(model) : "Default", null, model),
    cell("Effort", [h("span", { class: "meter", "aria-hidden": "true" }, efforts.map((_, i) => h("i", { class: i < level ? "on" : "" }))), b.model?.effort ? b.model.effort[0].toUpperCase() + b.model.effort.slice(1) : "Default"]),
  );
}

/** "Codex asked · " when an agent asked for the build (it runs on the owner's builder account all the same). */
const askedBy = (b) => {
  const who = actorLabel(b.requestedBy);
  return who && who !== "You" ? `${who} asked · ` : "";
};

/** "Built with Claude Code · claude-fable-5-5 · high effort", and why it wasn't the model asked for. */
const builtWith = (b) =>
  b.builder &&
  b.builder !== "agent" &&
  !noBuilder(b) &&
  h("div", { class: "small faint" }, `Built with ${builderLabel(b.builder)}${buildModelWords(b) ? ` · ${buildModelWords(b)}` : ""}${b.charge ? ` · ${chargeWords(b.charge)}` : ""}`);

function buildPanel(id, { compact = false, onPromoted } = {}) {
  const card = h("div", { class: compact ? "build-panel stack-md" : "card build-card" }, skeleton("50%", "80%"));
  const cancelBtn = h("button", { class: "sm" }, "Cancel build");
  const logPre = h("pre", { class: `log ${compact ? "short" : "tail"}` });
  let follow = true;
  let logScroll = 0;
  logPre.addEventListener("scroll", () => {
    follow = logPre.scrollTop + logPre.clientHeight >= logPre.scrollHeight - 4;
    logScroll = logPre.scrollTop;
  });
  const keepScroll = () => (logPre.scrollTop = follow ? logPre.scrollHeight : logScroll);
  const logLine = (text) => {
    const m = /^(\d\d:\d\d:\d\d) (.*)$/.exec(text);
    logPre.append(m ? h("span", { class: "t" }, m[1]) : "", m ? ` ${m[2]}` : text, "\n");
  };
  /** The log, folded: "Show log" / "Hide log". */
  const logBlock = (open) => {
    const toggle = h("button", { class: "link sm" }, open ? "Hide log" : "Show log");
    const wrap = h("div", { class: "stack-sm" }, h("div", { class: "row between" }, h("span", { class: "eyebrow" }, "Log"), toggle), logPre);
    logPre.hidden = !open;
    toggle.addEventListener("click", () => ((logPre.hidden = !logPre.hidden), (toggle.textContent = logPre.hidden ? "Show log" : "Hide log"), keepScroll()));
    return wrap;
  };

  (async () => {
    const [b0, all, context] = await Promise.all([api(`/builds/${enc(id)}`), caps(true).catch(() => new Map()), api(`/builds/${enc(id)}/context`).catch(() => ({}))]);
    let b = b0;
    const cap = () => all.get(b.capabilityId) ?? { id: b.capabilityId, name: b.request?.name ?? b.capabilityId };
    if (!compact) setWallpaper(await hues([tintOf(cap()), 125]));
    // Elapsed time of the current attempt (the honest number while code is being written).
    let startedAt = Date.now() - (b0.progress?.elapsedSeconds ?? 0) * 1000;
    const clockEl = h("div", { class: "mono muted small" });
    const seen = new Map(); // step → first seen (ms), for durations
    let step = b.step;
    // "Spec agreed" opens to the spec the builder works from (kept open across redraws).
    const specText = String(b.request?.requirements ?? b.request?.request ?? "").trim();
    const specView = specText ? h("details", { class: "spec-step" }, h("summary", {}, "Spec agreed"), h("pre", { class: "spec-text" }, specText)) : null;
    // The conversation that led to it (kept with the build); an agent's build has none.
    const convoView = context.conversation?.length ? h("details", { class: "spec-step" }, h("summary", {}, "Conversation"), conversationThread(context.conversation, { mode: b.kind === "create" ? "create" : "modify", cap: cap(), all, version: b.resultVersion })) : null;
    const head = (icon, title, sub, right) => h("div", { class: "row build-head" }, icon, h("div", { class: "grow col" }, h("div", { class: "build-title" }, title), sub && h("div", { class: "small muted" }, sub)), right);

    const live = () => {
      const at = STEPS.findIndex(([k]) => k === (step?.step ?? "code"));
      if (step && !seen.has(step.step)) seen.set(step.step, Date.now());
      const meta = (k, i) => {
        if (k === "tests" && step?.tests) return `${step.tests.passed} / ${step.tests.total}`;
        const start = seen.get(k);
        const next = STEPS[i + 1] && seen.get(STEPS[i + 1][0]);
        return i < at && start && next ? mmss(next - start) : "";
      };
      const waitingAgent = b.builder === "agent";
      const base = cap().version;
      if (b.status === "waiting") {
        // H2: what it waits for, linking to that build.
        const dep = b.dependsOn;
        put(
          card,
          head(appIcon(cap(), { size: compact ? 36 : 56 }), cap().name, null, waitingPill(b)),
          h("div", { class: "small muted row tight wrap" }, "Starts once ", dep ? h("a", { href: `#/b/${enc(dep)}` }, b.queued ? "the change before it" : "the build it needs") : "the build it needs", " is done · you can leave"),
          logBlock(false),
        );
        return;
      }
      put(
        card,
        head(
          appIcon(cap(), { size: compact ? 36 : 56, progress: step?.step === "tests" && step.tests?.total ? step.tests.passed / step.tests.total : 0, waiting: !(step?.step === "tests") }),
          compact && b.kind !== "create" ? `Building v${(base ?? 0) + 1}` : cap().name,
          waitingAgent ? `Waiting for ${actorLabel(b.requestedBy, all)} to build it · you can leave` : null,
          clockEl,
        ),
        !waitingAgent && (noBuilder(b) ? h("div", { class: "small faint" }, b.builder === "bundle" ? `Installed ${installedFrom(b)}: no builder runs. Its own tests run as for any build.` : "No builder runs.") : buildMeta(b)),
        convoView,
        h("ol", { class: "steps" }, stepsOf(b).map(([k, label], i) => stepRow(k === "spec" && specView ? specView : label, i < at ? "done" : i === at ? "live" : "todo", meta(k, i)))),
        logPre,
        h("div", { class: "row between" }, h("span", { class: "small faint" }, compact && base ? `v${base} keeps working meanwhile` : "You can leave; it keeps building."), cancelBtn),
      );
      logPre.hidden = false;
      keepScroll();
      tickClock();
    };
    const tickClock = () => (clockEl.textContent = mmss(Date.now() - startedAt));
    const clockTimer = setInterval(tickClock, 1000);
    onLeave(() => clearInterval(clockTimer));

    const ready = async () => {
      const detail = await api(`/capabilities/${enc(b.capabilityId)}`).catch(() => null);
      invalidateCaps();
      const fresh = await caps(true).catch(() => all);
      for (const [k, v] of fresh) all.set(k, v);
      const c = all.get(b.capabilityId) ?? cap();
      const tests = b.tests ? `${b.tests.passed} of ${b.tests.total} tests passed` : "";
      const connection = detail?.kind === "connection";
      const signIn = connection && detail.operations.some((o) => o.name === "connect");
      if (detail && !detail.status.ready && !connection) {
        step = { step: "auth" };
        live();
        if (!(await grantsSheet(b.capabilityId)))
          return put(card, head(appIcon(c, { size: compact ? 36 : 64, badge: "warn" }), `${c.name} needs you`, "Built. Authorize it to use it.", h("button", { class: "primary", onclick: () => grantsSheet(b.capabilityId).then((ok) => ok && ready()) }, "Authorize…")), logBlock(false));
      }
      if (compact && onPromoted) return put(card, head(appIcon(c, { size: 36 }), `${c.name} · v${b.resultVersion ?? ""}`, [kindWord(b), tests].filter(Boolean).join(" · ")), onPromoted(b), logBlock(false));
      // H4: a quick change (manifest only): no builder, no steps.
      if (b.builder === "keep" || b.request?.manifestOnly)
        return put(card, head(appIcon(c, { size: 56 }), `${c.name} · v${b.resultVersion ?? ""}`, `${titleCase(String(b.request?.request ?? "changed").replace(/^use /, "uses "))}. No builder needed.`, kindTag("quick change", "ok")), h("div", { class: "row tight" }, h("a", { class: "btn primary", href: `#/c/${enc(c.id)}` }, "Done")));
      // H3: widgets only: each in every size it offers, and Add to Home.
      if (b.kind === "widgets") {
        const w = (detail?.widgets ?? []).filter((x) => !b.request?.request || String(b.request.request).includes(x.title));
        return put(
          card,
          head(appIcon(c, { size: 56 }), `New widgets · ${c.name}`, "Only adds widgets. The tool itself is unchanged.", kindTag("done", "ok")),
          h(
            "div",
            { class: "stack-md" },
            (w.length ? w : detail?.widgets ?? []).map((x) =>
              h(
                "div",
                { class: "stack-sm" },
                h("div", { class: "row between" }, h("span", { class: "strong" }, x.title), h("button", { class: "sm primary", onclick: () => addWidgetSheet({ capabilityId: c.id, widget: x.name }) }, "Add to Home")),
                h("div", { class: "widget-sizes" }, x.sizes.map((s) => widgetPreview(c, c.id, { ...x, name: x.name }, { size: s }).el)),
              ),
            ),
          ),
          logBlock(false),
        );
      }
      // H5: a new connection ends with its sign-in, not Open.
      if (connection && (signIn || !detail.status.ready))
        return put(
          card,
          head(appIcon(c, { size: 56 }), `${c.name} is ready`, tests),
          h("div", { class: "notice warn-soft" }, h("span", { class: "grow" }, signIn ? "Sign in to finish setting it up." : "Set it up to finish.")),
          h("div", { class: "row tight" }, h("a", { class: "btn", href: "#/accounts" }, "Later"), h("button", { class: "primary", onclick: () => (signIn && detail.status.pendingGrants.length === 0 ? signInDialog(c.id) : grantsSheet(c.id)).then(() => go(`#/c/${enc(c.id)}`)) }, signIn ? "Sign in" : "Set up")),
          logBlock(false),
        );
      put(
        card,
        head(appIcon(c, { size: 64 }), `${c.name} is ready`, b.kind === "create" ? `Added to ${connection ? "Accounts" : "Home"}${tests ? ` · ${tests}` : ""}` : `Updated to v${b.resultVersion ?? "?"}${tests ? ` · ${tests}` : ""}`, h("button", { class: "primary lg", onclick: () => openCapability({ ...c, ready: true }).catch(fail) }, "Open")),
        builtWith(b),
        b.screenshot && h("img", { class: "build-shot", src: shotUrl(id), alt: `${c.name}, as rendered during validation` }),
        convoView,
        specView,
        logBlock(false),
      );
    };

    // Paused by the builder's host with its work kept: not a failure. Continue picks it up (a retry), Stop ends it.
    const paused = (f) => {
      const cont = h("button", { class: "primary" }, "Continue");
      const stop = h("button", {}, "Stop");
      const busy = (on) => (cont.disabled = stop.disabled = on);
      cont.addEventListener("click", async () => {
        busy(true);
        try {
          const next = await api(`/builds/${enc(id)}/retry`, { method: "POST" });
          compact ? (put(card), card.replaceWith(buildPanel(next.buildId, { compact, onPromoted }).el)) : go(`#/b/${next.buildId}`);
        } catch (e) {
          busy(false);
          fail(e);
        }
      });
      stop.addEventListener("click", async () => {
        busy(true);
        try {
          settle(await api(`/builds/${enc(id)}/cancel`, { method: "POST" }));
        } catch (e) {
          busy(false);
          fail(e);
        }
      });
      put(
        card,
        head(appIcon(cap(), { size: compact ? 36 : 56, badge: "warn" }), "Paused", `${cap().name} · ${kindWord(b)}`),
        h("div", { class: "notice warn" }, h("span", {}, f.detail)),
        builtWith(b),
        convoView,
        specView,
        // Continued already: the choice is made; the build that carries it on is one link away.
        b.continuedAs ? h("div", { class: "small muted row tight wrap" }, "Continued as ", h("a", { href: `#/b/${enc(b.continuedAs)}` }, b.continuedAs)) : retryable(b) && h("div", { class: "row tight" }, cont, stop),
        logBlock(false),
      );
      requestAnimationFrame(keepScroll);
    };

    const failed = () => {
      const f = b.failure ?? { title: "The build didn't pass", detail: b.log.at(-1) ?? "" };
      if (f.paused) return paused(f);
      const attempt = f.attempt && f.maxAttempts ? ` · attempt ${f.attempt} of ${f.maxAttempts}` : "";
      // Refused by the builder's host (e.g. over the month's builds): asking it to fix can't help.
      const refused = /^refused: /.test([...b.log].reverse().find((l) => /FAILED: /.test(l))?.split("FAILED: ")[1] ?? "");
      const fix = !refused && !noBuilder(b) && h("button", { class: "primary" }, "Ask builder to fix");
      const retry = retryable(b) && h("button", { class: refused || !fix ? "primary" : "" }, "Retry");
      const again = (path, btn) => async () => {
        btn.disabled = true;
        try {
          const next = await api(`/builds/${enc(id)}/${path}`, { method: "POST" });
          compact ? (put(card), card.replaceWith(buildPanel(next.buildId, { compact, onPromoted }).el)) : go(`#/b/${next.buildId}`);
        } catch (e) {
          btn.disabled = false;
          fail(e);
        }
      };
      if (fix) fix.addEventListener("click", again("fix", fix));
      if (retry) retry.addEventListener("click", again("retry", retry));
      if (!compact) setWallpaper([25, 250]);
      put(
        card,
        head(appIcon(cap(), { size: compact ? 36 : 56, badge: "danger" }), f.title, `${cap().name} · ${kindWord(b)}${attempt}`),
        f.detail && h("div", { class: "notice danger" }, h("span", {}, f.detail)),
        builtWith(b),
        b.screenshot && h("img", { class: "build-shot", src: shotUrl(id), alt: "The screen as rendered during validation" }),
        convoView,
        specView,
        retry ? h("div", { class: "row tight" }, fix, retry) : h("div", { class: "small muted" }, b.builder === "bundle" ? "No builder ran: install the file again to try once more." : "No builder ran: make the change again to try once more."),
        logBlock(true),
      );
      requestAnimationFrame(keepScroll);
    };

    const cancelled = () => {
      const retry = retryable(b) && h("button", { class: "primary" }, "Start again");
      if (retry) retry.addEventListener("click", async () => {
        retry.disabled = true;
        try {
          go(`#/b/${(await api(`/builds/${enc(id)}/retry`, { method: "POST" })).buildId}`);
        } catch (e) {
          retry.disabled = false;
          fail(e);
        }
      });
      put(card, head(appIcon(cap(), { size: compact ? 36 : 56 }), "Build cancelled", `${cap().name} · nothing changed`), h("div", { class: "row tight" }, retry, !compact && h("a", { class: "btn", href: "#/" }, "Home")), logBlock(false));
    };

    const inReview = () => {
      const decide = (approve, btn) => async () => {
        btn.disabled = true;
        try {
          const r = await api(`/builds/${enc(id)}/${approve ? "approve" : "reject"}`, { method: "POST" });
          invalidateCaps();
          pollInbox();
          settle(r);
        } catch (e) {
          btn.disabled = false;
          fail(e);
        }
      };
      const yes = h("button", { class: "primary" }, "Allow");
      const no = h("button", {}, "Don't allow");
      yes.addEventListener("click", decide(true, yes));
      no.addEventListener("click", decide(false, no));
      const changes = reviewChanges(b.review);
      // Only a changed screen is worth a look (validation renders it on empty data).
      const shot = b.screenshot && (!changes || b.review.changes.ui);
      put(
        card,
        head(appIcon(cap(), { size: compact ? 36 : 56, badge: "warn" }), reviewTitle(b, all), "It passed its checks. It goes live only if you allow it."),
        b.review.newOperations.length > 0 && h("div", { class: "eyebrow" }, "New"),
        ...b.review.newOperations.map((o) => reviewOp(o, { full: true })),
        changes && [h("div", { class: "eyebrow" }, changes.every(([ok]) => ok) ? "Nothing else changes" : "Also"), changeList(changes)],
        shot && [h("div", { class: "eyebrow" }, "The screen after the change (rendered with no data)"), h("img", { class: "build-shot", src: shotUrl(id), alt: "The screen as rendered during validation" })],
        reviewRequest(b, all),
        h("div", { class: "row tight" }, yes, no),
        logBlock(false),
      );
    };

    const settle = (v) => {
      b = v;
      if (b.status === "review") return inReview();
      if (b.status === "promoted") return ready();
      if (b.status === "failed") return failed();
      if (b.status === "cancelled") return cancelled();
      // Agent-built and still open: the agent submits when it's done.
      step = b.step ?? step;
      live();
      const t = setTimeout(() => api(`/builds/${enc(id)}`).then(settle).catch(() => {}), 5000);
      onLeave(() => clearTimeout(t));
    };

    // Cancel while the builder works.
    cancelBtn.addEventListener("click", async () => {
      if (!(await confirmDialog({ title: "Cancel this build?", body: "The builder stops and nothing changes. You can start it again later.", confirm: "Cancel build", cancel: "Keep building", danger: true }))) return;
      try {
        settle(await api(`/builds/${enc(id)}/cancel`, { method: "POST" }));
      } catch (e) {
        fail(e);
      }
    });
    // The transcript replays (live or finished, kept for 30 days), then "done".
    const finished = !LIVE_BUILD.has(b.status) && b.status !== "open";
    if (!finished) live();
    const es = new EventSource(`/api/builds/${enc(id)}/events`);
    onLeave(() => es.close());
    es.addEventListener("line", (e) => {
      logLine(JSON.parse(e.data));
      if (follow) logPre.scrollTop = logPre.scrollHeight;
    });
    es.addEventListener("step", (e) => {
      if (finished) return;
      step = JSON.parse(e.data);
      live();
    });
    es.addEventListener("done", (e) => {
      es.close();
      if (!logPre.childNodes.length) for (const l of b.log) logLine(l);
      settle(JSON.parse(e.data));
    });
    es.addEventListener("error", () => {
      if (!finished || card.querySelector(".build-head")) return;
      es.close();
      for (const l of b.log) logLine(l);
      settle(b);
    });
    if (finished) return;
    // Pick up the icon as soon as the builder has written it (it does that first), and the attempt clock.
    const tick = setInterval(async () => {
      const [v, fresh] = await Promise.all([api(`/builds/${enc(id)}`).catch(() => null), caps(true).catch(() => null)]);
      if (fresh) for (const [k, x] of fresh) all.set(k, x);
      if (v?.progress) startedAt = Date.now() - v.progress.elapsedSeconds * 1000;
      if (v && b.status === "waiting" && v.status !== "waiting") b = v;
      if (v?.step && LIVE_BUILD.has(v.status)) ((step = v.step), live());
    }, 4000);
    onLeave(() => clearInterval(tick));
  })().catch((e) => put(card, errorBox(e)));
  return { el: card };
}
