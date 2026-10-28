// SPDX-License-Identifier: AGPL-3.0-or-later
// The intake (a page, or in the change drawer), its proposal card, and kept conversations.
import { ago, api, appIcon, builderLabel, capRef, caps, enc, errorBox, fail, h, invalidateCaps, kindTag, markdown, postStream, setWallpaper, toast } from "../kit.js";
import { brandTile, go, hues, moment, onLeave, put, settings, stillHere, topBar, view } from "./frame.js";
import { installFromFile } from "./install.js";
import { jobModelOf, saveBuildModel } from "./home.js";
import { cadenceText } from "./schedules.js";
import { memoryNotice } from "./tool-actions.js";
import { SIZE_LABEL, SIZE_LETTER, TEMPLATE_LABEL } from "./widgets.js";

export { askFeedbackOnOpen, conversationThread, intakePage, intakeView, modelChip, plural };

// ---------- B1 / G: the intake (a page, or a component in the change drawer) and the proposal card ----------

const slug = (s) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** #/new: the intake as a moment screen. `?connection=<service>` asks for a connection only. */
async function intakePage(q) {
  const here = stillHere();
  const service = q.get("connection");
  setWallpaper(await hues(service ? [260, 200] : [125, 250]));
  if (!here()) return;
  const intake = intakeView({ mode: "create", q, connection: service, onBuilt: (b) => go(`#/b/${enc(b.buildId)}`) });
  // The normal top bar, its back button where the brand is.
  view(...moment({ right: "-20px", top: "60px" }, topBar(service ? "accounts" : "", { back: service ? ["Accounts", "#/accounts"] : ["Home", "#/"] }), h("div", { class: "moment-col" }, intake.el)));
  intake.focus();
}

/**
 * The intake conversation. `mode` "create" (a new tool, or a connection) or "modify" (a change to
 * `cap`, in the drawer). Every reply that proposes something is one proposalCard; an earlier
 * proposal collapses to a line when a revised one arrives (G3). `onBuilt(build)` after a build starts.
 */
function intakeView({ mode, cap, q, embedded = false, connection = null, onBuilt }) {
  const capId = cap?.id;
  let all = new Map();
  caps().then((m) => (all = m)).catch(() => {});
  const widgetParam = q?.get("widget");
  const widgetsMode = widgetParam === "new";
  let focus = null;
  const messages = [];
  const thread = h("div", { class: "thread", "aria-live": "polite" });
  // Picking up an earlier conversation ("Continue from here" on a version, or the card on a change):
  // its turns show at the top as they were (proposals as cards), and go to the intake as context.
  let from = q?.get("from") || null;
  const earlierEl = h("div", { class: "thread earlier", hidden: true });
  thread.prepend(earlierEl);
  const continueFrom = async (buildId) => {
    from = buildId;
    // The cards name the tools a draft uses, so the map comes first.
    const [b, ctx, m] = await Promise.all([api(`/builds/${enc(buildId)}`), api(`/builds/${enc(buildId)}/context`), caps().catch(() => all)]);
    all = m;
    put(earlierEl, h("div", { class: "small faint earlier-label" }, `Earlier · the conversation that made v${b.resultVersion ?? "?"}`), conversationNodes(ctx.conversation ?? [], { mode: b.kind === "create" ? "create" : "modify", cap, all, version: b.resultVersion }));
    earlierEl.hidden = false;
    // A long conversation comes back above: the box is where you go on, so that's where it lands.
    requestAnimationFrame(() => (composer.scrollIntoView({ block: "end" }), input.focus()));
  };
  if (from) continueFrom(from).catch(fail);
  // A change to a tool with a conversation behind it: a card in the chat offers to pick it up.
  const offer = h("div", { class: "card continue-card", hidden: true });
  thread.append(offer);
  if (mode === "modify" && capId && !from && !widgetsMode) {
    api(`/capabilities/${enc(capId)}`)
      .then(async (d) => {
        const last = d.versions?.find((v) => v.buildId);
        const ctx = last ? await api(`/builds/${enc(last.buildId)}/context`).catch(() => ({})) : {};
        if (!ctx.conversation?.length) return;
        put(
          offer,
          h("div", { class: "continue-title" }, "Continue the last conversation?"),
          h("div", { class: "small muted" }, `The chat that made v${last.version} comes along, so you don't explain the tool again.`),
          h("div", { class: "row tight continue-actions" }, h("button", { type: "button", class: "sm primary", onclick: () => (offer.remove(), continueFrom(last.buildId).catch(fail)) }, "Continue"), h("button", { type: "button", class: "sm ghost", onclick: () => offer.remove() }, "Start fresh")),
        );
        offer.hidden = false;
      })
      .catch(() => {});
  }
  // Grows with the text; Enter sends, Shift+Enter for a new line.
  const input = h("textarea", {
    class: "composer-input",
    rows: embedded ? 3 : 1,
    placeholder: connection ? `What should your tools do with ${connection}?` : mode === "create" ? "Track my coffee beans and how I rated each brew" : widgetsMode ? "The next word to practise, with buttons to grade it" : "e.g. show pace per km in the table",
    "aria-label": "Message",
  });
  input.value = q?.get("m") || (widgetsMode ? "Suggest some widgets." : connection ? `A connection to ${connection}, so my tools can use it.` : "");
  const grow = () => ((input.style.height = "auto"), (input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`));
  input.addEventListener("input", grow);
  // Text put in for you ("Ask builder to fix this"): tall enough to read it whole, once it's on screen.
  let tries = 0;
  const growWhenShown = () => (input.offsetParent ? grow() : ++tries < 120 && requestAnimationFrame(growWhenShown));
  if (input.value) requestAnimationFrame(growWhenShown);
  window.addEventListener("resize", grow);
  onLeave(() => window.removeEventListener("resize", grow));
  input.addEventListener("keydown", (e) => e.key === "Enter" && !e.shiftKey && !e.isComposing && (e.preventDefault(), composer.requestSubmit()));
  const send = h("button", { type: "submit", class: embedded ? "" : "lg" }, "Send");
  // One box: the message, then the model it builds with (Settings › AI, changeable right here) and Send.
  // One session id for the conversation.
  const session = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // After a round of questions: the owner's way to stop them and get a draft on the intake's assumptions.
  const draftNow = h("button", { type: "button", class: "link sm", hidden: true, onclick: () => ((input.value = "Draft it now with your assumptions, and list them."), composer.requestSubmit()) }, "Draft now");
  // Images and files for the request: pasted, dropped or attached; uploaded as they're added, sent as refs.
  const pending = [];
  const chips = h("div", { class: "attachments", hidden: true });
  const picker = h("input", { type: "file", multiple: true, accept: "image/*,text/*,.csv,.json,.md,.txt,.yaml,.yml,.toml,.sql,.js,.ts,.py,.sh,.html,.css", hidden: true, "aria-label": "Files to attach" });
  const attach = h("button", { type: "button", class: "ghost sm", onclick: () => picker.click() }, "Attach");
  const syncChips = () => ((chips.hidden = !pending.length), put(chips, pending.map((a) => attachmentChip(a, () => (pending.splice(pending.indexOf(a), 1), syncChips())))), syncSend());
  // Per message: up to 5 images and 10 files (Hewn checks the same as the message is sent).
  const perMessage = { image: 5, file: 10 };
  const addFiles = async (files) => {
    for (const f of files) {
      const kind = /^image\//.test(f.type) ? "image" : "file";
      if (pending.filter((a) => a.kind === kind).length >= perMessage[kind]) {
        fail(new Error(`Up to ${perMessage[kind]} ${kind}s per message`));
        continue;
      }
      try {
        pending.push(await uploadAttachment(f, session));
        syncChips();
      } catch (e) {
        fail(e);
      }
    }
  };
  picker.addEventListener("change", () => (addFiles([...picker.files]), (picker.value = "")));
  // "Ask builder to fix this": what failed goes in the box as text, as other pre-fills do; nothing sends until Send.
  const failure = capId && q?.get("fix") ? sessionStorage.getItem(`hewn.fix.${capId}`) : null;
  if (failure) {
    sessionStorage.removeItem(`hewn.fix.${capId}`);
    input.value = JSON.parse(failure).text;
    requestAnimationFrame(growWhenShown);
  }
  input.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length) (e.preventDefault(), addFiles(files));
  });
  const composer = h("form", { class: "composer boxed" }, chips, input, h("div", { class: "composer-tools" }, attach, picker, draftNow, modelChip(), send));
  composer.addEventListener("dragover", (e) => (e.preventDefault(), composer.classList.add("drop")));
  composer.addEventListener("dragleave", () => composer.classList.remove("drop"));
  composer.addEventListener("drop", (e) => (e.preventDefault(), composer.classList.remove("drop"), addFiles([...(e.dataTransfer?.files ?? [])])));
  const heading = embedded
    ? h("div", { class: "drawer-title" }, widgetsMode ? "What should its widgets show?" : "What should change?")
    : h("div", { class: "stack-sm" }, h("div", { class: "eyebrow" }, connection ? "New connection" : "New tool"), h("div", { class: "display" }, connection ? `Connect ${connection}` : "What should it do?"));
  // Q1 New: or start from a tool someone made: one in Hub, or a file someone shared (gone once you're talking).
  const option = (glyph, title, sub, props) => h(props.href ? "a" : "button", { class: "card start-option", ...props }, glyph, h("span", { class: "grow col" }, h("span", { class: "strong" }, title), h("span", { class: "small muted" }, sub)), h("span", { class: "faint" }, "›"));
  const hubLink =
    mode === "create" &&
    !connection &&
    h(
      "div",
      { class: "start-from" },
      h("div", { class: "eyebrow" }, "Or start from"),
      h(
        "div",
        { class: "start-options" },
        option(brandTile(32), "A tool in Hub", "Hewn's own, ready to install", { href: "#/hub" }),
        option(h("span", { class: "start-file", "aria-hidden": "true" }, ".zip"), "A file someone shared", "A .hewn.zip, up to 5 MB", { type: "button", onclick: () => installFromFile().catch(fail) }),
      ),
    );
  // Continue the last conversation? sits above the box, not in it.
  const el = embedded ? h("div", { class: "drawer-intake" }, heading, thread, offer, composer) : h("div", { class: "stack-lg" }, heading, h("div", { class: "chat-col" }, thread, offer, composer, hubLink));
  const say = (who, text, attachments) => (hubLink && (hubLink.hidden = true), thread.append(who === "them" ? themBubble(text) : h("div", { class: `bubble ${who}` }, text, attachmentsView(attachments))));
  const syncSend = () => send.classList.toggle("primary", !!input.value.trim() || pending.length > 0);
  input.addEventListener("input", syncSend);
  syncSend();

  let latest = null;
  /** A new proposal: the one before it collapses to one line that can be opened again. */
  const showProposal = (card, summary) => {
    if (latest) {
      const old = latest;
      old.card.classList.add("superseded");
      old.card.querySelectorAll("button, input").forEach((b) => (b.disabled = true));
      old.card.hidden = true;
      const line = h("button", { class: "earlier-proposal link small" }, `Earlier proposal · ${old.summary} · replaced ▸`);
      line.addEventListener("click", () => ((old.card.hidden = !old.card.hidden), (line.textContent = `Earlier proposal · ${old.summary} · replaced ${old.card.hidden ? "▸" : "▾"}`)));
      old.card.before(line);
    }
    latest = { card, summary };
    thread.append(card);
    card.scrollIntoView({ block: "nearest" });
  };
  const keepTalking = () => input.focus();

  const ask = async (e) => {
    e?.preventDefault();
    const text = input.value.trim();
    // One turn at a time: the box is disabled while the intake answers (Draft now submits through here too).
    if (!text || input.disabled) return;
    // A message may be attachments alone ("like this", with a screenshot).
    if (!text && !pending.length) return;
    // Text put in from the address (m=, "Ask builder to fix this") is sent: a redraw mustn't put it back.
    const [path, qs = ""] = location.hash.split("?");
    const params = new URLSearchParams(qs);
    if (params.has("m")) {
      params.delete("m");
      params.delete("send");
      history.replaceState(null, "", `${path}${params.size ? `?${params}` : ""}`);
    }
    if (focus === null && widgetParam && !widgetsMode && capId) focus = ((await api(`/capabilities/${enc(capId)}`).catch(() => null))?.widgets ?? []).find((w) => w.name === widgetParam) ?? false;
    // What was attached goes with this turn, as refs (the bytes are already up).
    const attachments = pending.splice(0).map(({ ref, kind, name, mediaType, bytes, width, height }) => ({ ref, kind, name, mediaType, bytes, width, height }));
    syncChips();
    messages.push({ role: "user", content: text, ...(attachments.length ? { attachments } : {}) });
    heading.hidden = embedded;
    offer.remove();
    say("me", text, attachments);
    input.value = "";
    input.placeholder = ""; // the example is for an empty conversation
    grow();
    syncSend();
    const typing = h("div", { class: "bubble them typing", role: "status", "aria-label": "Thinking" }, h("i"), h("i"), h("i"));
    const activity = h("div", { class: "small faint intake-activity" });
    const live = h("div", { class: "thread" });
    thread.append(live, typing, activity);
    input.disabled = true;
    draftNow.disabled = true;
    // While it answers, Send is Stop: the request closes and the intake stops.
    const stop = new AbortController();
    const stopBtn = h("button", { type: "button", class: `stop-btn ${embedded ? "" : "lg"}`, "aria-label": "Stop", title: "Stop", onclick: () => stop.abort() }, h("span", { class: "stop-square", "aria-hidden": "true" }));
    send.replaceWith(stopBtn);
    const showProgress = (p) => {
      if (p.activity) activity.textContent = `${p.activity}…`;
      if (p.message === undefined && p.questions === undefined) return;
      activity.textContent = "";
      put(live, p.message || p.questions?.length ? themBubble(chatText(p.message, p.questions)) : null);
    };
    try {
      let reply = null;
      let failure = null;
      await postStream("/intake", (name, data) => (name === "progress" ? showProgress(data) : name === "reply" ? (reply = data) : name === "error" && (failure = data.message)), { mode, capabilityId: capId, ...(focus ? { widget: focus.name } : {}), messages, session, ...(from ? { earlier: { buildId: from } } : {}) }, stop.signal);
      if (failure || !reply) throw new Error(failure ?? "The intake didn't answer");
      typing.remove();
      live.remove();
      activity.remove();
      // Questions come as one message, with the questions as a list; a proposal's message sits above its card.
      if (reply.message && reply.kind !== "questions") say("them", reply.message);
      draftNow.hidden = reply.kind !== "questions";
      // What it remembered (or dropped) for later builds: shown as saved, with Undo.
      for (const [what, list] of [["remember", reply.saved?.remember ?? []], ["forget", reply.saved?.forget ?? []]]) for (const x of list) thread.append(memoryNotice(what, x, cap));
      const nextVersion = capId ? await api(`/capabilities/${enc(capId)}`).then((d) => Math.max(0, ...d.versions.map((v) => v.version)) + 1).catch(() => null) : null;
      const ctx = { mode, cap, all, connection, keepTalking, onBuilt, embedded, nextVersion, messages, done: (text) => thread.append(h("div", { class: "notice ok" }, h("span", {}, text))) };
      if (reply.kind === "questions") {
        messages.push({ role: "intake", content: [reply.message, ...reply.questions].filter(Boolean).join("\n"), reply });
        say("them", chatText(reply.message, reply.questions));
      } else if (reply.kind === "answer") {
        // A question about Hewn, answered above (no card): remembered, so "ok, build that" follows on.
        messages.push({ role: "intake", content: reply.message, reply });
      } else if (reply.kind === "widgets") {
        // Remembered as text, so a follow-up ("make the second one bigger") can refer to them.
        messages.push({ role: "intake", content: [reply.message, ...reply.proposals.map((p, i) => `${i + 1}. ${p.title} (${p.template}; ${p.sizes.join(", ")}${p.replaces ? `; replaces ${p.replaces}` : ""}): ${p.shows}`)].filter(Boolean).join("\n"), reply });
        if (!reply.proposals.length) say("them", "No widgets to suggest for this. Say what you'd like to see.");
        else showProposal(...proposalCard("widgets", reply.proposals, ctx));
      } else if (reply.kind === "ideas") {
        // Remembered in full, so "build the first two" or "make #3 simpler" revises them rather than starting over.
        messages.push({ role: "intake", content: [reply.message, `IDEAS\n${reply.ideas.map((d, i) => `${i + 1}. ${draftText(d)}`).join("\n\n")}`].filter(Boolean).join("\n\n"), reply });
        showProposal(...proposalCard("ideas", reply.ideas, ctx));
      } else if (reply.kind === "schedules") {
        messages.push({ role: "intake", content: [reply.message, `SCHEDULES\n${scheduleText(reply.schedules)}`].filter(Boolean).join("\n\n"), reply });
        showProposal(...proposalCard("schedules", reply.schedules, ctx));
      } else {
        // The whole draft, so "Keep talking" changes it instead of starting over.
        messages.push({ role: "intake", content: [reply.message, `DRAFT\n${draftText(reply.draft)}`].filter(Boolean).join("\n\n"), reply });
        showProposal(...proposalCard("draft", [reply.draft], ctx));
      }
    } catch (err) {
      typing.remove();
      live.remove();
      activity.remove();
      if (stop.signal.aborted) {
        // Stopped: the message goes back in the composer, out of the conversation.
        messages.pop();
        thread.lastElementChild?.classList.contains("me") && thread.lastElementChild.remove();
        input.value = text;
        thread.append(h("div", { class: "small faint" }, "Stopped."));
        return;
      }
      thread.append(errorBox(err));
      // Widgets don't need the intake: the builder can still make what was asked (or pick itself).
      if (widgetsMode) thread.append(h("div", { class: "row tight" }, h("button", { onclick: () => buildWidgets(cap, /^suggest some widgets\.?$/i.test(text) ? "" : text, messages).then(onBuilt, fail) }, "Build without suggestions")));
    } finally {
      stopBtn.replaceWith(send);
      input.disabled = false;
      draftNow.disabled = false;
      syncSend();
      grow();
      input.focus();
    }
  };
  composer.addEventListener("submit", ask);
  // Opened with text to send (Info's "Change it", the first run, a new widget), send it.
  if ((q?.get("send") === "1" || widgetsMode || connection) && input.value.trim()) setTimeout(ask);
  return {
    el,
    focus: () => (input.focus(), grow()),
    setText: (t) => ((input.value = t), syncSend(), input.focus(), grow()),
  };
}

/** The intake's message and its questions as one chat message: paragraphs, the questions numbered. */
const chatText = (message, questions) => [message, ...(questions ?? []).filter(Boolean).map((q, i) => `${i + 1}. ${q}`)].filter(Boolean).join("\n\n");
/** The intake's side of the chat: its text as light Markdown (bold, lists, code); the owner's stays as typed. */
const themBubble = (text, attachments) => h("div", { class: "bubble them md" }, markdown(text), attachmentsView(attachments));

/** Start a widgets build (only widgets change). `conversation`: the chat that led to it, kept with the build. */
const buildWidgets = (cap, request, conversation) => api(`/capabilities/${enc(cap.id)}/widgets`, { method: "POST", body: { ...(request ? { request } : {}), ...(conversation?.length ? { conversation } : {}) } });

/**
 * In the intake's chat box: the model building runs on, and its menu, like a chat app's. It is the
 * Settings › AI choice, changed right here: the current model, an effort slider, then the other
 * models (and a full name).
 */
function modelChip() {
  const name = h("span", {}, "Model");
  const effortEl = h("span", { class: "faint" });
  const chip = h("button", { type: "button", class: "ghost sm model-chip", "aria-haspopup": "menu", title: "Model for building (Settings › AI)" }, name, effortEl, h("span", { class: "caret", "aria-hidden": "true" }));
  let ctx = null;
  let menu = null;
  const cap = (x) => (x ? x[0].toUpperCase() + x.slice(1) : "");
  const load = async () => {
    const s = await api("/settings");
    ctx = { s, bCat: await api(`/tools/${enc(s.builder)}/models`) };
    return ctx;
  };
  const labelOf = (cat, id) => cat?.models.find((m) => m.id === (id ?? "default"))?.label ?? id ?? "Default";
  // V2: "Claude Code · Fable · high": who builds, on what, how hard.
  const paint = () => {
    const m = jobModelOf(ctx.s, "builder");
    // Hosted builds on one builder: its name goes without saying.
    name.textContent = [ctx.s.builder !== "remote" && builderLabel(ctx.s.builder), labelOf(ctx.bCat, m.model)].filter(Boolean).join(" · ");
    effortEl.textContent = m.effort ? `· ${m.effort}` : "";
  };
  load().then(paint).catch(() => (chip.hidden = true));

  /** Save the builder's model and effort. In order: a slider moved right after a model pick must not write over it. */
  let saving = Promise.resolve();
  const save = (change) => (saving = saving.then(() => saveNow(change)));
  const saveNow = async (change) => {
    try {
      ctx.s = await saveBuildModel(ctx.s, ctx.s.builder, { ...jobModelOf(ctx.s, "builder"), ...change });
      paint();
    } catch (e) {
      fail(e);
    }
  };
  const row = (main, sub, { checked = false, onClick } = {}) =>
    h(
      "button",
      { type: "button", role: "menuitemradio", "aria-checked": String(checked), class: "mm-row", onclick: (e) => (e.stopPropagation(), onClick?.()) },
      h("span", { class: "grow col" }, h("span", {}, main), sub && h("span", { class: "sub" }, sub)),
      checked && h("span", { class: "model-tick", "aria-hidden": "true" }, "✓"),
    );
  /** The current model, the effort slider, then the other models. */
  const section = (cat) => {
    const cur = jobModelOf(ctx.s, "builder");
    const curId = cur.model ?? "default";
    const curModel = cat.models.find((m) => m.id === curId) ?? { id: curId, label: curId, description: "A model by its full name" };
    const efforts = curModel.efforts ?? cat.models[0]?.efforts ?? [];
    const others = cat.models.filter((m) => m.id !== curId);
    // The slider: Default (the model's own), then its levels in order.
    const stops = [undefined, ...efforts];
    const value = h("span", { class: "faint" });
    const slider = h("input", { type: "range", min: 0, max: stops.length - 1, step: 1, value: Math.max(0, stops.indexOf(cur.effort)), "aria-label": "Effort", class: "effort-slider" });
    const show = () => (value.textContent = stops[slider.value] ? cap(stops[slider.value]) : curModel.defaultEffort ? `Default (${curModel.defaultEffort})` : "Default");
    show();
    slider.addEventListener("input", show);
    slider.addEventListener("change", () => save({ effort: stops[slider.value] }));
    const pick = (id) => save({ model: id, effort: cur.effort && (cat.models.find((m) => m.id === id)?.efforts ?? []).includes(cur.effort) ? cur.effort : undefined }).then(render);
    const other = !cat.other ? null : h("input", { type: "text", class: "mono sm", placeholder: cat.otherHint ? `Another: ${cat.otherHint}` : "Another model, by name", "aria-label": "Another model, by name" });
    other?.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), other.value.trim() && pick(other.value.trim())));
    // A model that failed lately says so (the list can't tell on its own).
    const sub = (m) => [m.description, m.failed && `didn't run ${ago(m.failed.at)}: ${m.failed.reason}`].filter(Boolean).join(" · ");
    return [
      row(curModel.label, sub(curModel), { checked: true }),
      efforts.length > 0 && h("label", { class: "mm-effort" }, h("span", { class: "row between" }, h("span", {}, "Effort"), value), slider),
      others.length > 0 && h("hr"),
      others.map((m) => row(m.label, sub(m), { onClick: () => pick(m.id) })),
      other && h("div", { class: "mm-other" }, other),
    ];
  };
  const render = () => {
    if (!menu) return;
    put(menu, section(ctx.bCat));
    place();
  };
  /** Fixed to the viewport, next to the chip, never off screen (the drawer is narrow and near the edge). */
  const place = () => {
    const r = chip.getBoundingClientRect();
    const w = Math.min(380, innerWidth - 16);
    menu.style.width = `${w}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    const below = innerHeight - r.bottom - 14;
    const above = r.top - 14;
    menu.style.maxHeight = "";
    const hgt = menu.getBoundingClientRect().height;
    const up = hgt > below && above > below;
    const room = Math.max(160, up ? above : below);
    menu.style.maxHeight = `${room}px`;
    menu.style.top = up ? `${Math.max(8, r.top - 6 - Math.min(hgt, room))}px` : `${r.bottom + 6}px`;
  };
  const close = () => {
    menu?.remove();
    menu = null;
    chip.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", outside, true);
    document.removeEventListener("keydown", onKey, true);
    removeEventListener("resize", close);
    removeEventListener("blur", close);
  };
  const outside = (e) => menu && !menu.contains(e.target) && !chip.contains(e.target) && close();
  const onKey = (e) => e.key === "Escape" && (e.stopPropagation(), close(), chip.focus());
  chip.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (menu) return close();
    try {
      await load();
    } catch (err) {
      return fail(err);
    }
    menu = h("div", { class: "menu model-menu", role: "menu" });
    document.body.append(menu);
    chip.setAttribute("aria-expanded", "true");
    render();
    menu.querySelector("input[type=range], button")?.focus();
    document.addEventListener("click", outside, true);
    document.addEventListener("keydown", onKey, true);
    addEventListener("resize", close);
    // A click in a tool (its own frame) never reaches this page; the page losing focus to it does.
    addEventListener("blur", close);
  });
  onLeave(close);
  return chip;
}

const scheduleText = (list) => list.map((x) => `- ${x.operation} ${x.cadence}${x.why ? ` (${x.why})` : ""}`).join("\n");


/** Attachments as a message shows them: thumbnails, file names. */
const attachmentsView = (list) => (list?.length ? h("div", { class: "attachments" }, list.map((a) => attachmentChip(a))) : null);

/**
 * One attachment: a thumbnail or the file's name (opens it). In the box, before sending (V2): a
 * 64px tile with its name on it and × to drop it.
 */
const attachmentChip = (a, onRemove) => {
  const url = `/api/attachments/${enc(a.ref)}`;
  if (onRemove)
    return h(
      "span",
      { class: "attachment tile" },
      h("a", { href: url, target: "_blank", rel: "noopener", class: "attachment-open", title: a.name }, a.kind === "image" ? h("img", { src: url, alt: a.name }) : h("span", { class: "attachment-ext" }, /\.(\w{1,4})$/.exec(a.name)?.[1].toUpperCase() ?? "TXT"), h("span", { class: "attachment-name" }, a.name)),
      h("button", { type: "button", class: "x", "aria-label": `Remove ${a.name}`, onclick: onRemove }, "×"),
    );
  return h("span", { class: "attachment" }, a.kind === "image" ? h("img", { src: url, alt: a.name, title: a.name }) : h("a", { class: "file-chip", href: url, target: "_blank", rel: "noopener", title: a.name }, a.name));
};

/**
 * Upload one pasted, dropped or picked file for the request: an image is resized first (long side
 * at most 1568 px, what the models read well), a text file goes as it is. Resolves the attachment
 * (its ref and what it is) once Hewn has it.
 */
async function uploadAttachment(file, session) {
  const image = /^image\//.test(file.type);
  if (!image && file.size > 256 * 1024) throw new Error(`${file.name}: a file may be at most 256 KB`);
  const blob = image ? await resizeImage(file) : file;
  if (image && blob.size > 2 * 1024 * 1024) throw new Error(`${file.name || "The image"} is too large even after resizing`);
  const data = await new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] ?? "");
    r.onerror = () => no(r.error);
    r.readAsDataURL(blob);
  });
  return api("/attachments", { method: "POST", body: { session, kind: image ? "image" : "file", name: file.name || (image ? "pasted.png" : "pasted.txt"), mediaType: image ? blob.type : file.type || "text/plain", data } });
}

/**
 * A pasted or dropped image no bigger than the models read well: long side at most 1568 px. One
 * already within that (and a type Hewn takes) goes as it is, a GIF's animation included; one that
 * needs shrinking, or another type, is redrawn as PNG (JPEG stays JPEG).
 */
async function resizeImage(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error(`${file.name || "The image"} can't be read`);
  const scale = Math.min(1, 1568 / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) && file.size <= 2 * 1024 * 1024) return (bitmap.close?.(), file);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const type = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
  return new Promise((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error("couldn't read the image"))), type, 0.9));
}

/**
 * V5 "Got what you asked for?", asked once in a quiet strip at the foot of the tool when it's
 * opened after a build went live (its newest version's build, within a week, no answer yet): Yes,
 * Not quite (which opens the change drawer, so what's off becomes the next change), or × to skip.
 * The answer stays in your Hewn; nothing is sent anywhere.
 */
async function askFeedbackOnOpen(c, drawerApi, slot) {
  const d = await api(`/capabilities/${enc(c.id)}`).catch(() => null);
  const last = d?.versions?.find((v) => v.buildId);
  if (!last || Date.now() - Date.parse(last.createdAt) > 7 * 86400_000) return;
  const ctx = await api(`/builds/${enc(last.buildId)}/context`).catch(() => null);
  if (!ctx || ctx.feedback) return;
  // Once per version in this browser: ignoring it is an answer too.
  const askedKey = `hewn.asked.${c.id}`;
  if (localStorage.getItem(askedKey) === String(last.version)) return;
  localStorage.setItem(askedKey, String(last.version));
  // An answer that didn't reach Hewn is asked for again next time.
  const send = (score) =>
    api(`/builds/${enc(last.buildId)}/feedback`, { method: "POST", body: { score } }).catch((e) => {
      localStorage.removeItem(askedKey);
      throw e;
    });
  const el = h("div", { class: "feedback-strip", role: "status" });
  const gone = () => el.remove();
  put(
    el,
    h("span", { class: "grow" }, `v${last.version} · got what you asked for?`),
    h("button", { class: "link sm", onclick: () => send("yes").then(() => (gone(), toast("Noted.")), fail) }, "Yes"),
    h("button", { class: "link sm", onclick: () => send("no").then(() => (gone(), drawerApi.open?.()), fail) }, "Not quite"),
    h("button", { class: "ghost sm icon-only", "aria-label": "Skip", title: "Skip", onclick: () => send("skip").then(gone, fail) }, "×"),
  );
  slot.append(el);
  onLeave(gone);
}
/**
 * The reply an intake turn kept as text only was (conversations from before replies were kept):
 * the message, then the draft, ideas, schedules or widgets as `draftText` and friends wrote them.
 * The summary pills (operations, widgets, model) weren't written down, so the card goes without.
 */
function legacyReply(content, mode) {
  const m = /^([^]*?)(?:^|\n\n)(DRAFT|IDEAS|SCHEDULES)\n([^]*)$/.exec(content ?? "");
  if (m) {
    const message = m[1].trim();
    if (m[2] === "SCHEDULES") return { kind: "schedules", message, schedules: parseSchedules(m[3]) };
    if (m[2] === "DRAFT") return { kind: "draft", message, draft: parseDraft(m[3], mode) };
    // Ideas are numbered, a blank line apart, each starting "Name: purpose"; a numbered list inside one stays with it.
    const ideas = [];
    for (const part of m[3].split(/\n\n(?=\d+\. [^\n:]{1,80}: )/)) {
      if (part.startsWith(`${ideas.length + 1}. `) || !ideas.length) ideas.push(part.replace(/^\d+\. /, ""));
      else ideas[ideas.length - 1] += `\n\n${part}`;
    }
    return { kind: "ideas", message, ideas: ideas.map((s) => parseDraft(s, "create")) };
  }
  // Widgets: "1. Title (template; sizes[; replaces name]): shows" lines after the message.
  const lines = (content ?? "").split("\n");
  const numbered = lines.filter((l) => /^\d+\. /.test(l));
  const proposals = numbered.map((l) => /^\d+\. (.+?) \((\w+); ([a-z, ]+?)(?:; replaces (.+?))?\): ([^]*)$/.exec(l)).filter(Boolean);
  if (!proposals.length || proposals.length !== numbered.length) return null;
  return { kind: "widgets", message: lines.filter((l) => !/^\d+\. /.test(l)).join("\n").trim(), proposals: proposals.map(([, title, template, sizes, replaces, shows]) => ({ title, template, sizes: sizes.split(", "), ...(replaces ? { replaces } : {}), shows })) };
}
const parseSchedules = (text) =>
  text
    .split("\n")
    .map((l) => /^- (\S+) (.*?)(?: \((.*)\))?$/.exec(l))
    .filter(Boolean)
    .map(([, operation, cadence, why]) => ({ operation, cadence, ...(why ? { why } : {}) }));
/** `draftText` read back: name + purpose (a create), the spec, the connection step, the schedules. */
function parseDraft(text, mode) {
  const d = {};
  let rest = text;
  const sched = /\nSchedules:\n((?:- .*(?:\n|$))+)$/.exec(rest);
  if (sched) {
    d.schedules = parseSchedules(sched[1]);
    rest = rest.slice(0, sched.index);
  }
  const conn = /\nFirst (builds|changes) the connection ([^:\n]+): ([^]*)$/.exec(rest);
  if (conn) {
    const [head, ...body] = conn[3].split("\n");
    d.connection = conn[1] === "builds" ? { mode: "create", name: conn[2], purpose: head, requirements: body.join("\n") } : { mode: "modify", capabilityId: conn[2], request: conn[3] };
    rest = rest.slice(0, conn.index);
  }
  const named = mode !== "modify" && /^([^\n:]{1,80}): (.*)\n?/.exec(rest);
  if (named) {
    d.name = named[1];
    d.purpose = named[2];
    rest = rest.slice(named[0].length);
  }
  if (mode === "modify") d.request = rest;
  else d.requirements = rest;
  return d;
}

/**
 * A kept conversation (what led to a build), as the chat looked: the owner's turns, the intake's
 * questions, and its proposals as the cards they were (read-only). `ctx`: { mode, cap, all } for the cards.
 */
const conversationThread = (turns, ctx = {}) => h("div", { class: "thread kept" }, conversationNodes(turns, ctx));
const conversationNodes = (turns, ctx = {}) =>
  turns.map((t) => {
    // A turn kept as text only (from before replies were kept) is read back into the reply it was.
    const r = t.role === "intake" ? (t.reply ?? legacyReply(t.content, ctx.mode)) : null;
    if (r?.kind === "questions") return themBubble(chatText(r.message, r.questions));
    const list = r?.kind === "draft" ? [r.draft] : r?.kind === "ideas" ? r.ideas : r?.kind === "widgets" ? r.proposals : r?.kind === "schedules" ? r.schedules : null;
    if (list?.length && "cap" in ctx) {
      const mode = ctx.mode ?? (r.kind === "draft" && r.draft?.name ? "create" : "modify");
      const card = proposalCard(r.kind, list, { mode, cap: ctx.cap ?? null, all: ctx.all ?? new Map(), connection: null, keepTalking: () => {}, onBuilt: () => {}, embedded: true, messages: [], done: () => {}, nextVersion: ctx.version, readOnly: true })[0];
      return [r.message && themBubble(r.message), card];
    }
    return t.role === "user" ? h("div", { class: "bubble me" }, t.content, attachmentsView(t.attachments)) : themBubble(t.content, t.attachments);
  });

/** A draft (or one idea) in full, as the intake's own turn in the conversation. */
const draftText = (d) =>
  [
    d.name && `${d.name}: ${d.purpose}`,
    d.requirements ?? d.request,
    d.connection && (d.connection.mode === "create" ? `First builds the connection ${d.connection.name}: ${d.connection.purpose}\n${d.connection.requirements}` : `First changes the connection ${d.connection.capabilityId}: ${d.connection.request}`),
    d.schedules?.length && `Schedules:\n${scheduleText(d.schedules)}`,
  ]
    .filter(Boolean)
    .join("\n");

/** Suggested schedules, ticked: leaving one ticked is the owner's approval. */
function scheduleTicks(list = []) {
  const rows = list.map((x) => ({ x, box: h("input", { type: "checkbox", checked: true }) }));
  const el = rows.length > 0 && h("div", { class: "schedule-ticks col" }, rows.map(({ x, box }) => h("label", { class: "check small" }, box, h("span", {}, `${x.operation} · ${cadenceText(x.cadence)}`, x.why && h("span", { class: "faint" }, ` · ${x.why}`)))));
  return { el, chosen: () => rows.filter((r) => r.box.checked).map(({ x }) => ({ operation: x.operation, cadence: x.cadence })), set: (on) => rows.forEach((r) => (r.box.disabled = !on)) };
}

/**
 * Start a draft's build: its connection first, then the draft waiting for it. `connections` spans a
 * batch, so drafts sharing a connection build it once (or change it one after another). `after`: a
 * build the draft (and its connection) waits for too. `schedules`: the ones the owner left ticked,
 * set up once the draft's build promotes. `conversation`: the chat that led here, kept with each build.
 */
async function startDraft(mode, d, cap, { connections = new Map(), after, schedules = [], conversation } = {}) {
  const keep = conversation?.length ? { conversation } : {};
  const conn = d.connection;
  let first = null;
  if (conn) {
    const key = conn.mode === "create" ? `new:${slug(conn.name)}` : conn.capabilityId;
    const prev = connections.get(key);
    const wait = after ?? prev?.buildId;
    first =
      conn.mode === "create"
        ? prev ?? (await api("/capabilities", { method: "POST", body: { name: conn.name, purpose: conn.purpose, requirements: conn.requirements, kind: "connection", ...(after ? { after } : {}), ...keep } }))
        : await api(`/capabilities/${enc(conn.capabilityId)}/modify`, { method: "POST", body: { request: conn.request, ...(wait ? { after: wait } : {}), ...keep } });
    connections.set(key, first);
  }
  const wait = first?.buildId ?? after;
  const w = { ...(wait ? { after: wait } : {}), ...(schedules.length ? { schedules } : {}), ...keep };
  return mode === "create" ? api("/capabilities", { method: "POST", body: { name: d.name, purpose: d.purpose, requirements: d.requirements, ...w } }) : api(`/capabilities/${enc(cap.id)}/modify`, { method: "POST", body: { request: d.request, ...w } });
}

/** The id the platform gives a new tool with this name (the intake names ideas it builds on this way). */
const capabilityId = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/**
 * The order to start ideas in, and what each waits for. Ideas that build on another idea (it's in
 * their `uses`) start after it; the rest start side by side. A build waits for one build only, so
 * when an idea needs two that aren't built yet (two ideas, or an idea and its connection) the
 * whole batch runs one after another.
 */
function buildPlan(ideas) {
  const ids = new Set(ideas.map((d) => capabilityId(d.name)));
  const needs = (d) => (d.spec?.uses ?? []).filter((u) => ids.has(u) && u !== capabilityId(d.name));
  const order = [];
  const visit = (d, path = new Set()) => {
    if (order.includes(d) || path.has(d)) return;
    path.add(d);
    for (const u of needs(d)) visit(ideas.find((x) => capabilityId(x.name) === u), path);
    order.push(d);
  };
  ideas.forEach((d) => visit(d));
  return { order, needs, serial: ideas.some((d) => needs(d).length + (d.connection ? 1 : 0) > 1) };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * G1 One proposal card for every reply that proposes something: a draft (new tool, change or
 * connection), ideas for several tools, widgets, or schedules. A row per item (tick box when there
 * are several, icon, name, purpose, summary pills), ▸ opens its details (G2). Returns [card, summary].
 */
function proposalCard(kind, list, ctx) {
  // `readOnly`: a card from a kept conversation: as it was, nothing to tick or build.
  const { mode, cap, all, connection, keepTalking, onBuilt, embedded, messages, done, readOnly = false } = ctx;
  const ideas = kind === "ideas";
  const plan = ideas ? buildPlan(list) : null;
  const byId = new Map();
  const rows = list.map((d, i) => {
    const box = h("input", { type: "checkbox", checked: kind === "widgets" ? i < 2 : kind === "ideas" ? list.length === 1 || d.connection?.mode !== "create" : true, "aria-label": "Build this" });
    const r = { d, box, ticks: scheduleTicks(kind === "schedules" ? [] : d.schedules) };
    if (ideas) byId.set(capabilityId(d.name), r);
    return r;
  });
  const single = rows.length === 1;
  const build = h("button", { class: `primary ${embedded ? "" : "lg"}` });
  const chosen = () => rows.filter((r) => r.box.checked);
  // "Keep talking" sets this proposal aside: Build greys out, the next reply brings a new one (or Draft now does).
  let talking = false;
  const count = () => {
    const n = chosen().length;
    build.disabled = n === 0 || talking;
    build.textContent =
      kind === "widgets"
        ? single
          ? list[0].replaces ? "Change widget" : "Build widget"
          : `Build ${plural(n, "widget")}`
        : kind === "schedules"
          ? n <= 1 ? "Set schedule" : `Set ${n} schedules`
          : connection
            ? "Build connection"
            : mode === "modify"
              ? "Build change"
              : `Build ${plural(n, "tool")}`;
  };
  // An idea comes with the ideas it builds on; leaving one out leaves out what builds on it.
  const tick = (r, on) => {
    r.box.checked = on;
    if (!ideas) return;
    if (on) plan.needs(r.d).forEach((u) => !byId.get(u).box.checked && tick(byId.get(u), true));
    else rows.filter((x) => x.box.checked && plan.needs(x.d).includes(capabilityId(r.d.name))).forEach((x) => tick(x, false));
  };
  rows.forEach((r) => r.box.addEventListener("change", () => (tick(r, r.box.checked), count())));
  if (readOnly) rows.forEach((r) => ((r.box.disabled = true), r.ticks.set(false)));

  const preview = (d) => (kind === "widgets" || kind === "schedules" || mode === "modify" ? cap : { id: slug(d.name ?? connection ?? "new"), name: d.name ?? connection });
  const toolPills = (d) => {
    const spec = d.spec ?? { operations: [], uses: [], hosts: [], secrets: [] };
    const on = plan ? plan.needs(d) : [];
    return [
      spec.operations.length > 0 && kindTag(plural(spec.operations.length, "operation")),
      (spec.widgets ?? []).length > 0 && kindTag(plural(spec.widgets.length, "widget"), "accent"),
      ...on.map((u) => kindTag(`builds on ${byId.get(u).d.name}`, "warn")),
      d.schedules?.length > 0 && kindTag(plural(d.schedules.length, "schedule"), "accent"),
      spec.model && kindTag(`${spec.model} model`),
      d.connection && kindTag(d.connection.mode === "create" ? "needs a new connection" : "changes a connection", "warn"),
    ];
  };
  const details = (r) => {
    const d = r.d;
    if (kind === "widgets") return [h("div", { class: "small muted" }, `${TEMPLATE_LABEL[d.template] ?? d.template} · ${d.sizes.map((s) => SIZE_LABEL[s] ?? s).join(", ")}`), d.replaces && h("div", { class: "small muted" }, `Replaces the current “${d.replaces}” widget`), h("div", { class: "small faint" }, "The tool itself stays as it is.")];
    if (kind === "schedules") return [h("div", { class: "small muted" }, d.why), h("div", { class: "small faint" }, "Nothing gets built. Pause or change it under Info › Schedules.")];
    const spec = d.spec ?? { operations: [], uses: [], hosts: [], secrets: [] };
    const on = plan ? plan.needs(d) : [];
    const existing = spec.uses.filter((u) => !on.includes(u));
    const details = h("pre", { class: "spec-text", hidden: true }, d.requirements ?? d.request);
    return [
      on.length > 0 && h("div", { class: "small row tight wrap" }, h("span", { class: "dot warn" }), "Builds on ", on.map((u) => capRef({ id: u, name: byId.get(u).d.name })), ", so it's built after"),
      existing.length > 0 && h("div", { class: "small row tight wrap" }, "Uses ", existing.map((u) => capRef(all.get(u), u))),
      (spec.hosts.length > 0 || spec.secrets.length > 0) && h("div", { class: "small row tight wrap" }, "Needs ", spec.hosts.map((x) => kindTag(x)), spec.secrets.map((x) => kindTag(`secret ${x}`))),
      connectionLine(d.connection, all),
      spec.operations.length > 0 && h("div", { class: "row tight wrap" }, spec.operations.map((o) => kindTag(o.name, o.sideEffect === "read" ? "" : "accent"))),
      r.ticks.el,
      (spec.widgets ?? []).map((w) => h("div", { class: "small" }, `Widget: ${w}`)),
      spec.model && h("div", { class: "small" }, `Model: ${spec.model} tier`),
      details,
      h("button", { class: "link self-start", onclick: (e) => ((details.hidden = !details.hidden), (e.target.textContent = details.hidden ? "Show spec" : "Hide spec")) }, "Show spec"),
    ];
  };
  const row = (r) => {
    const d = r.d;
    const p = preview(d);
    // What it builds on, needs and runs: always in view (the raw spec stays behind "Show spec").
    const block = h("div", { class: "inset-block stack-sm" }, details(r));
    const name = kind === "widgets" ? d.title : kind === "schedules" ? d.operation : mode === "modify" ? `${cap.name} · v${ctx.nextVersion ?? (cap.version ?? 0) + 1}` : d.name;
    const purpose = kind === "widgets" ? d.shows : kind === "schedules" ? cadenceText(d.cadence) : mode === "modify" ? d.request : d.purpose;
    const pills = kind === "widgets" ? [kindTag(TEMPLATE_LABEL[d.template] ?? d.template), kindTag(d.sizes.map((s) => SIZE_LETTER[s]).join(" "))] : kind === "schedules" ? [kindTag("schedule", "accent")] : toolPills(d);
    return h(
      "li",
      { class: "proposal-row" },
      !single && r.box,
      appIcon(p, { size: 40 }),
      h("div", { class: "grow" }, h("span", { class: "strong" }, name), h("span", { class: "sub clip" }, purpose), h("div", { class: "row tight wrap proposal-pills" }, pills.filter(Boolean)), block),
    );
  };

  build.addEventListener("click", async () => {
    build.disabled = true;
    rows.forEach((r) => (r.box.disabled = true));
    const reenable = () => (rows.forEach((r) => (r.box.disabled = false)), count());
    try {
      if (kind === "widgets") {
        const picked = chosen().map((r) => r.d);
        // A replacement keeps its widget's name, so it stays where it is on Home.
        const b = await buildWidgets(cap, `Build exactly ${picked.length === 1 ? "this widget" : "these widgets"}:\n${picked.map((p, i) => `${i + 1}. ${p.replaces ? `Change the existing widget "${p.replaces}" (keep its name, give it a new operation version) into ` : ""}"${p.title}" (${p.template}; ${p.sizes.join(", ")}): ${p.shows}`).join("\n")}`, messages);
        return onBuilt(b);
      }
      if (kind === "schedules") {
        let n = 0;
        for (const { d } of chosen()) {
          try {
            await api("/schedules", { method: "POST", body: { capabilityId: cap.id, operation: d.operation, cadence: d.cadence } });
            n++;
          } catch (e) {
            fail(new Error(`${d.operation} ${d.cadence}: ${e.message || e}`));
          }
        }
        if (!n) return reenable();
        toast(n === 1 ? "Schedule set" : `${n} schedules set`);
        return embedded ? done(n === 1 ? "Schedule set. It's under Info › Schedules." : `${n} schedules set. They're under Info › Schedules.`) : go(`#/c/${enc(cap.id)}`);
      }
      if (connection) {
        // Only the connection: the intake may have drafted a tool around it.
        const d = list[0];
        const c = d.connection?.mode === "create" ? d.connection : d;
        const b = await api("/capabilities", { method: "POST", body: { name: c.name, purpose: c.purpose, requirements: c.requirements, kind: "connection", ...(messages?.length ? { conversation: messages } : {}) } });
        invalidateCaps();
        return onBuilt(b);
      }
      if (mode === "modify") {
        const b = await startDraft("modify", list[0], cap, { schedules: rows[0].ticks.chosen(), conversation: messages });
        invalidateCaps();
        return onBuilt(b);
      }
      // New tools: side by side, or after the ones they build on.
      const p = buildPlan(chosen().map((r) => r.d));
      const connections = new Map();
      const builds = new Map();
      const started = [];
      const failed = [];
      for (const d of p.order) {
        const dep = p.needs(d).map((u) => builds.get(u));
        if (dep.some((b) => !b)) {
          failed.push(`${d.name}: what it builds on didn't start`);
          continue;
        }
        try {
          const ticks = rows.find((x) => x.d === d).ticks;
          const b = await startDraft("create", d, null, { connections, after: p.serial ? started.at(-1)?.buildId : dep[0]?.buildId, schedules: ticks.chosen(), conversation: messages });
          builds.set(capabilityId(d.name), b);
          started.push(b);
        } catch (e) {
          failed.push(`${d.name}: ${e.message || e}`);
        }
      }
      if (started.length) invalidateCaps();
      if (failed.length) toast(`Couldn't start ${failed.join("; ")}`, { dot: "danger", ms: 15000 });
      if (!started.length) return reenable();
      if (started.length === 1 && !failed.length) return onBuilt(started[0]);
      // Several at once: Home, where each new tool is a tile that fills in as it builds.
      toast(`Building ${started.length} tools`);
      go("#/");
    } catch (e) {
      fail(e);
      reenable();
    }
  });
  count();
  const n = rows.length;
  const summary = kind === "widgets" ? plural(n, "widget") : kind === "schedules" ? plural(n, "schedule") : connection ? "connection" : mode === "modify" ? "change" : plural(n, "tool");
  const card = h(
    "div",
    { class: "card spec-card proposal" },
    h("div", { class: "eyebrow" }, `Proposal · ${summary}`),
    h("ul", { class: "list" }, rows.map(row)),
    // Say what spends the owner's account before it happens (a schedule-only proposal builds nothing).
    kind !== "schedules" && !readOnly && h("div", { class: "small faint" }, settings?.builder === "remote" ? `${builderLabel("remote")} builds it.` : `${settings?.builder ? builderLabel(settings.builder) : "Your builder"} builds it, on its own account: your subscription, API key or cloud provider.`),
    !readOnly && h("div", { class: "row end tight" }, h("button", { onclick: () => ((talking = true), count(), keepTalking()) }, "Keep talking"), build),
  );
  return [card, summary];
}

// Only connections hold credentials: a connection to build (or change) first, then the draft waits for it.
const connectionLine = (conn, all) =>
  conn &&
  h(
    "div",
    { class: "small row tight wrap" },
    h("span", { class: "dot warn" }),
    conn.mode === "create" ? h("span", { class: "grow row tight wrap" }, "First builds the connection", capRef({ id: slug(conn.name), name: conn.name }), "(it holds the sign-in; set up under Accounts)") : ["First changes the connection ", capRef(all.get(conn.capabilityId), conn.capabilityId), `: ${conn.request}`],
  );
