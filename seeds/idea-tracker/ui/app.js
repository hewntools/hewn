// SPDX-License-Identifier: Apache-2.0
import { emptyStateMessage, hiddenClosedFooter } from "./empty-state.js";
import { STATUSES, OPEN, CLOSED, PILL, LABEL, groupIdeas } from "./statuses.js";
import { LIMITS, checkTitle, checkPitch, checkUrl, checkNote, splitTags, checkTag, checkTags } from "./validate.js";
import { createFakeBackend } from "./fake.js";

// ---- talking to the capability ----
// Latest contract versions, pinned so a later version can't change what the screen sees.
const VERSIONS = { add_idea: 3, update_idea: 3, add_note: 3, delete_note: 1, get_idea: 3, list_ideas: 3, list_tags: 1, delete_idea: 1 };

// ?preview=demo shows sample ideas, ?preview=empty an empty tracker, ?preview=error a tracker
// that can't be reached; none of them touches real data.
const preview = new URLSearchParams(location.search).get("preview");
const PREVIEW_NOTICE = {
  demo: "Preview with sample ideas. Nothing here is saved.",
  empty: "Preview of an empty tracker. Nothing here is saved.",
  error: "Preview of a tracker that can't be reached. Nothing here is saved.",
};
const fake = preview in PREVIEW_NOTICE ? createFakeBackend(preview) : null;

async function call(operation, input = {}) {
  if (fake) return fake(operation, input);
  try {
    const r = await fetch("/api/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hewn-ui": "1" },
      body: JSON.stringify({ operation, input, operationVersion: VERSIONS[operation] }),
    });
    return await r.json().catch(() => ({ error: "BAD_RESPONSE", message: "Jig sent a reply the page couldn't read. Try again." }));
  } catch {
    return { error: "NETWORK", message: "Couldn't reach Jig. Check the connection and try again." };
  }
}

// ---- small DOM helpers ----
const $ = (sel) => document.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let uid = 0;
const nextId = (p) => `${p}${++uid}`;

// ---- formatting ----
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function ago(iso) {
  const t = Date.parse(iso);
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.floor(s / 3600), "hour");
  const d = Math.floor(s / 86400);
  if (d < 30) return rtf.format(-d, "day");
  return dateOnly.format(new Date(t));
}

const fullDate = (iso) => dateTime.format(new Date(iso));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const short = (text, n = 60) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

function linkLabel(url) {
  try {
    const u = new URL(url);
    return (u.host + u.pathname + u.search).replace(/\/$/, "");
  } catch {
    return url;
  }
}

// ---- feedback ----
function toast(text) {
  const t = h("div", { class: "toast" }, text);
  $("#toasts").append(t);
  setTimeout(() => t.remove(), 3000);
}

const errorNotice = (res) => h("div", { class: "notice danger" }, res.message || "Something went wrong. Try again.");

// ---- building blocks ----

// Wires inline validation to a control and its .hint. Too-long input is flagged while typing;
// a missing required value only after a save attempt. Returns validate(force) -> error | null.
function validated(control, msg, check, hint = "") {
  let showing = false;
  const show = (err) => {
    showing = !!err;
    msg.textContent = err || hint;
    msg.classList.toggle("error", !!err);
    if (err) control.setAttribute("aria-invalid", "true");
    else control.removeAttribute("aria-invalid");
  };
  const validate = (force = false) => {
    const err = check(control.value);
    if (force || showing || (err && control.value.trim())) show(err);
    return err;
  };
  control.addEventListener("input", () => validate());
  show(null);
  return { validate, reset: () => show(null) };
}

// A labelled field with a hint that doubles as the inline error.
function makeField(label, control, { check, hint = "" } = {}) {
  control.id ||= nextId("f");
  const msg = h("span", { class: "hint", id: `${control.id}-msg` });
  control.setAttribute("aria-describedby", msg.id);
  const el = h("label", { class: "field" }, h("span", { class: "label" }, label), control, msg);
  const v = check ? validated(control, msg, check, hint) : null;
  if (!v) msg.textContent = hint;
  return { el, control, validate: (force) => (v ? v.validate(force) : null), reset: () => v?.reset() };
}

function textInput(attrs = {}) {
  return h("input", { type: "text", autocomplete: "off", ...attrs });
}

// Textarea where Enter (or Ctrl/Cmd+Enter with { multiline }) submits the surrounding form.
function textArea(attrs = {}, { multiline = false } = {}) {
  const ta = h("textarea", { rows: 3, ...attrs });
  ta.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" || ev.isComposing) return;
    if (multiline ? ev.metaKey || ev.ctrlKey : !ev.shiftKey) {
      ev.preventDefault();
      ta.form?.requestSubmit();
    }
  });
  return ta;
}

function statusSelect(value) {
  return h("select", {}, ...STATUSES.map((s) => {
    const o = h("option", { value: s }, LABEL[s]);
    if (s === value) o.selected = true;
    return o;
  }));
}

function statusPill(status) {
  return h("span", { class: `pill ${PILL[status] || ""}` }, LABEL[status] || status);
}

function starsReadonly(rating) {
  if (!rating) return h("span", { class: "muted" }, "Unrated");
  return h("span", { class: "stars-ro", role: "img", "aria-label": `${rating} of 5 stars` },
    h("span", { class: "on" }, "★".repeat(rating)), "☆".repeat(5 - rating));
}

// 1–5 star rating as a radio group: arrows/Home/End move, 1–5 pick, Delete or 0 clears,
// picking the current star again clears it.
function starInput(label, initial, onChange) {
  let value = initial ?? null;
  const labelId = nextId("stars");
  const onKey = (ev) => {
    const k = ev.key;
    let next;
    if (k === "ArrowRight" || k === "ArrowUp") next = Math.min(5, (value || 0) + 1);
    else if (k === "ArrowLeft" || k === "ArrowDown") next = Math.max(1, (value || 2) - 1);
    else if (k === "Home") next = 1;
    else if (k === "End") next = 5;
    else if (/^[1-5]$/.test(k)) next = Number(k);
    else if (k === "0" || k === "Delete" || k === "Backspace") next = null;
    else return;
    ev.preventDefault();
    set(next, true);
  };
  const stars = [1, 2, 3, 4, 5].map((i) => h("button", {
    type: "button", class: "ghost icon-only", role: "radio", "aria-label": plural(i, "star"),
    onclick: () => set(value === i ? null : i, true), onkeydown: onKey,
  }));
  const clear = h("button", { type: "button", class: "ghost sm", onclick: () => set(null, true) }, "Clear");
  function render() {
    stars.forEach((b, ix) => {
      const i = ix + 1;
      const on = value !== null && i <= value;
      b.classList.toggle("on", on);
      b.textContent = on ? "★" : "☆";
      b.setAttribute("aria-checked", String(value === i));
      b.tabIndex = (value ? i === value : i === 1) ? 0 : -1;
    });
    clear.hidden = value === null;
  }
  function set(v, focus) {
    value = v;
    render();
    if (focus) stars[(v || 1) - 1].focus();
    onChange?.(v);
  }
  render();
  const el = h("div", { class: "rating" },
    h("span", { class: "field-label", id: labelId }, label),
    h("div", { class: "row" }, h("div", { class: "stars", role: "radiogroup", "aria-labelledby": labelId }, ...stars), clear),
  );
  return { el, get value() { return value; }, reset: (v = null) => { value = v; render(); } };
}

// Tags as removable chips plus an input with suggestions from tags already in use.
// Comma or Enter adds; Backspace in the empty input removes the last one.
function tagEditor(label, initial = []) {
  let tags = [...initial];
  const input = textInput({ list: "tag-options", placeholder: "Add a tag", enterkeyhint: "enter" });
  const f = makeField(label, input, { hint: `Comma or Enter adds a tag. Up to ${LIMITS.tags}.` });
  const msg = f.el.querySelector(".hint");
  const hint = msg.textContent;
  const chips = h("div", { class: "row", "aria-label": `${label} added` });
  const showError = (err) => {
    msg.textContent = err || hint;
    msg.classList.toggle("error", !!err);
    if (err) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  };
  function render() {
    chips.replaceChildren(...tags.map((t) => h("button", {
      type: "button", class: "chip plain", "aria-label": `Remove tag ${t}`,
      onclick: () => {
        tags = tags.filter((x) => x !== t);
        showError(null);
        render();
        input.focus();
      },
    }, t, h("span", { class: "x", "aria-hidden": "true" }, "×"))));
  }
  function add(text) {
    for (const t of splitTags(text)) {
      if (tags.includes(t)) continue;
      const err = checkTag(t) || (tags.length >= LIMITS.tags ? `Up to ${LIMITS.tags} tags per idea.` : null);
      if (err) { showError(err); return false; }
      tags.push(t);
    }
    input.value = "";
    showError(null);
    render();
    return true;
  }
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.isComposing && input.value.trim()) { ev.preventDefault(); add(input.value); }
    else if (ev.key === "Backspace" && !input.value && tags.length) { tags.pop(); showError(null); render(); }
  });
  input.addEventListener("input", (ev) => {
    if (input.value.includes(",") || ev.inputType === "insertReplacementText") add(input.value);
  });
  input.addEventListener("blur", () => { if (input.value.trim()) add(input.value); });
  render();
  return {
    el: h("div", { class: "stack" }, f.el, chips),
    input,
    get value() { return [...tags]; },
    // Adds whatever is still typed; returns an error or null.
    commit() {
      if (input.value.trim() && !add(input.value)) return msg.textContent;
      const err = checkTags(tags);
      showError(err);
      return err;
    },
    reset(list = []) { tags = [...list]; input.value = ""; showError(null); render(); },
  };
}

// Promise-based confirm built on the shared alert dialog.
function askConfirm({ title, text, ok }) {
  const dlg = $("#confirm");
  $("#c-heading").textContent = title;
  $("#c-text").textContent = text;
  $("#c-ok").textContent = ok;
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true }));
}

// ---- state ----
const state = {
  view: "open",
  statuses: new Set(),
  tag: null,
  minRating: null,
  query: "",
  sort: "rating",
  ideas: [],
  total: 0,
  hiddenClosed: 0,
  totalIdeas: 0,
  tags: [],
  loaded: false,
};

const filtersActive = () => state.statuses.size > 0 || !!state.tag || !!state.minRating || !!state.query;

// ---- quick capture ----
const quick = $("#quick");
const qTitle = $("#q-title");
const qTitleV = validated(qTitle, $("#q-title-msg"), checkTitle);
const qPitch = makeField("Pitch", textArea({ rows: 2, placeholder: "One line: who it's for and why" }), { check: checkPitch, hint: `Up to ${LIMITS.pitch} characters` });
const qUrl = makeField("Link", textInput({ type: "url", inputmode: "url", placeholder: "https://" }), { check: checkUrl, hint: "Optional, http or https" });
const qTags = tagEditor("Tags");
const qRating = starInput("Rating", null);
const qStatus = makeField("Status", statusSelect("raw"));
const qNote = makeField("First note", textArea({ rows: 3 }, { multiline: true }), {
  check: (v) => (v.trim() ? checkNote(v) : null),
  hint: "Optional. Ctrl+Enter adds the idea.",
});
$("#q-extra").append(qPitch.el, qUrl.el, qTags.el, qRating.el, qStatus.el, qNote.el);

quick.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const errors = [
    [qTitleV.validate(true), qTitle],
    [qPitch.validate(true), qPitch.control],
    [qUrl.validate(true), qUrl.control],
    [qTags.commit(), qTags.input],
    [qNote.validate(true), qNote.control],
  ].filter(([e]) => e);
  if (errors.length) {
    const target = errors[0][1];
    if (target !== qTitle) $("#q-more").open = true;
    target.focus();
    return;
  }
  const input = { title: qTitle.value.trim(), status: qStatus.control.value };
  const pitch = qPitch.control.value.trim();
  const url = qUrl.control.value.trim();
  const note = qNote.control.value.trim();
  if (pitch) input.pitch = pitch;
  if (url) input.url = url;
  if (qTags.value.length) input.tags = qTags.value;
  if (qRating.value) input.rating = qRating.value;
  if (note) input.note = note;

  const btn = $("#q-submit");
  btn.disabled = true;
  btn.textContent = "Adding…";
  const res = await call("add_idea", input);
  btn.disabled = false;
  btn.textContent = "Add idea";
  if (res.error) { $("#q-error").replaceChildren(errorNotice(res)); return; }

  $("#q-error").replaceChildren();
  quick.reset();
  qTitleV.reset();
  for (const f of [qPitch, qUrl, qNote]) f.reset();
  qTags.reset();
  qRating.reset();
  qStatus.control.value = "raw";
  qTitle.focus();
  toast(`Added “${short(res.result.title)}”`);
  await refresh();
});

// ---- filters ----
function renderStatusChips() {
  const chips = state.view === "closed" ? CLOSED : OPEN;
  $("#status-chips").replaceChildren(...chips.map((s) => h("button", {
    type: "button", class: "chip plain", "aria-pressed": state.statuses.has(s) ? "true" : "false",
    onclick: () => {
      state.statuses.has(s) ? state.statuses.delete(s) : state.statuses.add(s);
      syncFilters();
      refresh();
    },
  }, LABEL[s])));
}

function renderTagOptions() {
  const sel = $("#f-tag");
  const tags = [...state.tags];
  if (state.tag && !tags.some((t) => t.tag === state.tag)) tags.unshift({ tag: state.tag, count: 0 });
  sel.replaceChildren(h("option", { value: "" }, "Any tag"), ...tags.map((t) => h("option", { value: t.tag }, `${t.tag} (${t.count})`)));
  sel.value = state.tag || "";
  $("#tag-options").replaceChildren(...state.tags.map((t) => h("option", { value: t.tag })));
}

function syncFilters() {
  for (const b of document.querySelectorAll("#view-toggle button")) {
    b.setAttribute("aria-pressed", b.dataset.view === state.view ? "true" : "false");
  }
  renderStatusChips();
  $("#f-tag").value = state.tag || "";
  $("#f-rating").value = state.minRating ? String(state.minRating) : "";
  $("#f-sort").value = state.sort;
  if ($("#search").value.trim() !== state.query) $("#search").value = state.query;
  $("#f-clear").hidden = !filtersActive();
}

function setView(view) {
  if (state.view === view) return;
  state.view = view;
  state.statuses.clear();
  syncFilters();
  refresh();
}

function setTag(tag) {
  state.tag = state.tag === tag ? null : tag;
  renderTagOptions();
  syncFilters();
  refresh();
}

function clearFilters() {
  state.statuses.clear();
  state.tag = null;
  state.minRating = null;
  state.query = "";
  syncFilters();
  refresh();
}

for (const b of document.querySelectorAll("#view-toggle button")) b.addEventListener("click", () => setView(b.dataset.view));
$("#f-tag").addEventListener("change", (ev) => { state.tag = ev.target.value || null; syncFilters(); refresh(); });
$("#f-rating").addEventListener("change", (ev) => { state.minRating = ev.target.value ? Number(ev.target.value) : null; syncFilters(); refresh(); });
$("#f-sort").addEventListener("change", (ev) => { state.sort = ev.target.value; refresh(); });
$("#f-clear").addEventListener("click", clearFilters);
let searchTimer = null;
$("#search").addEventListener("input", (ev) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = ev.target.value.trim(); syncFilters(); refresh(); }, 200);
});

function filterInput() {
  const input = {};
  if (state.tag) input.tag = state.tag;
  if (state.minRating) input.min_rating = state.minRating;
  if (state.query) input.query = state.query;
  return input;
}

// ---- list ----
const listWrap = $("#list-wrap");
let refreshSeq = 0;

// Open view: raw … active plus parked (the server sorts parked below live ideas).
// Closed view: shipped and killed. Selected status chips narrow either view.
async function refresh() {
  const seq = ++refreshSeq;
  listWrap.setAttribute("aria-busy", "true");
  const closedView = state.view === "closed";
  const viewStatuses = closedView ? CLOSED : OPEN;
  const picked = viewStatuses.filter((s) => state.statuses.has(s));
  const f = filterInput();
  const results = await Promise.all([
    call("list_ideas", { ...f, status: picked.length ? picked : viewStatuses, sort: state.sort, limit: 500 }),
    closedView ? { result: { total: 0 } } : call("list_ideas", { ...f, status: CLOSED, limit: 1 }),
    call("list_ideas", { status: OPEN, limit: 1 }),
    call("list_ideas", { status: CLOSED, limit: 1 }),
    call("list_ideas", { status: ["active"], limit: 1 }),
    call("list_ideas", { status: ["shipped"], limit: 1 }),
    call("list_tags", {}),
  ]);
  if (seq !== refreshSeq) return;
  listWrap.setAttribute("aria-busy", "false");
  const failed = results.find((r) => r.error);
  if (failed) { renderListError(failed); return; }
  const [list, hidden, openAll, closedAll, active, shipped, tags] = results.map((r) => r.result);
  Object.assign(state, {
    ideas: list.ideas,
    total: list.total,
    hiddenClosed: hidden.total,
    totalIdeas: openAll.total + closedAll.total,
    tags: tags.tags,
    loaded: true,
  });
  renderStats({ open: openAll.total, active: active.total, shipped: shipped.total });
  renderTagOptions();
  renderList();
}

function renderStats({ open, active, shipped }) {
  const stat = (value, label) => h("div", { class: "stat" }, h("div", { class: "value" }, String(value)), h("div", { class: "label" }, label));
  $("#stats").replaceChildren(stat(open, "Open"), stat(active, "Active"), stat(shipped, "Shipped"));
}

function renderListError(res) {
  listWrap.replaceChildren(h("div", { class: "notice danger stack" },
    h("strong", {}, "Couldn't load your ideas"),
    h("span", {}, res.message || "Something went wrong."),
    h("div", {}, h("button", { type: "button", class: "sm", onclick: refresh }, "Try again")),
  ));
}

function renderList() {
  const empty = emptyStateMessage({ totalIdeas: state.totalIdeas, visibleCount: state.ideas.length, hiddenClosedCount: state.hiddenClosed, view: state.view });
  if (empty) {
    let action = null;
    if (!state.totalIdeas) action = h("button", { type: "button", class: "primary", onclick: () => qTitle.focus() }, "Add an idea");
    else if (empty.showClosedAction) action = h("button", { type: "button", onclick: () => setView("closed") }, "Show closed ideas");
    else if (filtersActive()) action = h("button", { type: "button", onclick: clearFilters }, "Clear filters");
    listWrap.replaceChildren(h("div", { class: "empty" },
      h("strong", {}, empty.title),
      empty.hint ? h("p", { class: "muted" }, empty.hint) : null,
      action,
    ));
    return;
  }
  const grouped = state.sort === "rating" || state.sort === "status"
    ? groupIdeas(state.ideas, state.view)
    : [{ label: null, ideas: state.ideas }];
  const parts = [];
  for (const group of grouped) {
    if (group.label) parts.push(h("h2", { class: "eyebrow" }, `${group.label} · ${group.ideas.length}`));
    parts.push(h("ul", { class: "list" }, ...group.ideas.map(renderRow)));
  }
  if (state.total > state.ideas.length) parts.push(h("p", { class: "muted" }, `Showing the first ${state.ideas.length} of ${state.total}. Narrow the filters to see the rest.`));
  const footer = hiddenClosedFooter(state.hiddenClosed);
  if (footer) {
    parts.push(h("div", { class: "row" },
      h("span", { class: "muted" }, footer),
      h("button", { type: "button", class: "ghost sm", onclick: () => setView("closed") }, "Show"),
    ));
  }
  listWrap.replaceChildren(h("div", { class: "stack" }, ...parts));
}

const MAX_ROW_TAGS = 5;

function renderRow(idea) {
  const shownTags = idea.tags.slice(0, MAX_ROW_TAGS);
  const extra = idea.tags.length - shownTags.length;
  const meta = [
    ...shownTags.map((t) => h("button", {
      type: "button", class: "chip plain", "aria-pressed": state.tag === t ? "true" : "false",
      "aria-label": `Show ideas tagged ${t}`, onclick: () => setTag(t),
    }, t)),
    extra > 0 ? h("span", { class: "muted" }, `+${extra} more`) : null,
    idea.url ? h("span", { class: "muted" }, "Link") : null,
    idea.note_count ? h("span", { class: "muted" }, plural(idea.note_count, "note")) : null,
  ].filter(Boolean);
  return h("li", { class: "idea" },
    h("div", { class: "grow long" },
      h("a", { class: "idea-title", href: `#idea=${encodeURIComponent(idea.id)}` }, idea.title),
      idea.pitch ? h("div", { class: "sub muted clamp" }, idea.pitch) : null,
      meta.length ? h("div", { class: "row sub" }, ...meta) : null,
    ),
    h("div", { class: "row meta" },
      starsReadonly(idea.rating),
      statusPill(idea.status),
      h("span", { class: "muted", title: fullDate(idea.updated_at) }, ago(idea.updated_at)),
    ),
  );
}

// ---- idea detail (dialog) ----
const dlg = $("#detail");
const body = $("#detail-body");
const detail = { id: null, data: null, form: null, openedByNav: false, closing: false };

function routeId() {
  const m = location.hash.match(/^#idea=(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

window.addEventListener("hashchange", () => {
  const id = routeId();
  if (id) { detail.openedByNav = true; openIdea(id); }
  else if (dlg.open) closeDetail(true);
});

function closeButton() {
  return h("button", { type: "button", class: "ghost sm", onclick: () => requestClose() }, "Close");
}

async function openIdea(id) {
  detail.id = id;
  detail.data = null;
  detail.form = null;
  body.replaceChildren(
    h("div", { class: "row between" }, h("h2", { id: "d-heading" }, "Idea"), closeButton()),
    h("div", { class: "skeleton sk-row" }),
    h("div", { class: "skeleton sk-block" }),
    h("div", { class: "skeleton sk-row" }),
  );
  if (!dlg.open) dlg.showModal();
  const res = await call("get_idea", { id });
  if (detail.id !== id) return;
  if (res.error) {
    body.replaceChildren(
      h("div", { class: "row between" }, h("h2", { id: "d-heading" }, "Couldn't open this idea"), closeButton()),
      errorNotice(res),
      h("div", { class: "row" }, h("button", { type: "button", onclick: () => openIdea(id) }, "Try again")),
    );
    return;
  }
  renderDetail(res.result);
}

// Esc and Close ask first when there are unsaved edits.
async function requestClose() {
  if (detail.form?.dirty() && !(await askConfirm({ title: "Discard your changes?", text: "Edits you haven't saved will be lost.", ok: "Discard" }))) return;
  closeDetail();
}

dlg.addEventListener("cancel", (ev) => {
  if (detail.form?.dirty()) { ev.preventDefault(); requestClose(); }
});

function closeDetail(fromNav = false) {
  detail.closing = true;
  if (dlg.open) dlg.close();
  detail.closing = false;
  if (!fromNav && routeId()) {
    if (detail.openedByNav) history.back();
    else history.replaceState(null, "", location.pathname + location.search);
  }
  const id = detail.id;
  detail.id = null;
  detail.form = null;
  detail.openedByNav = false;
  if (id) document.querySelector(`a.idea-title[href="#idea=${CSS.escape(encodeURIComponent(id))}"]`)?.focus();
}

dlg.addEventListener("close", () => { if (!detail.closing && detail.id) closeDetail(); });

function renderDetail(d) {
  detail.data = d;
  const head = h("div", { class: "row" });
  const heading = h("h2", { id: "d-heading", class: "long" }, d.title);
  const renderHead = () => head.replaceChildren(
    statusPill(detail.data.status),
    h("span", { class: "muted", title: fullDate(detail.data.status_changed_at) }, `${LABEL[detail.data.status]} since ${ago(detail.data.status_changed_at)}`),
    h("span", { class: "muted", title: fullDate(detail.data.created_at) }, `· added ${ago(detail.data.created_at)}`),
  );
  renderHead();

  // Edit form
  const fTitle = makeField("Title", textInput({ value: d.title, required: true }), { check: checkTitle, hint: `Up to ${LIMITS.title} characters` });
  const fPitch = makeField("Pitch", textArea({ rows: 3 }), { check: checkPitch, hint: `Up to ${LIMITS.pitch} characters` });
  fPitch.control.value = d.pitch || "";
  const fUrl = makeField("Link", textInput({ type: "url", inputmode: "url", value: d.url || "", placeholder: "https://" }), { check: checkUrl, hint: "Optional, http or https" });
  const openLink = h("div", { class: "long" });
  const renderLink = () => openLink.replaceChildren(detail.data.url
    ? h("a", { href: detail.data.url, target: "_blank", rel: "noopener noreferrer" }, `Open ${linkLabel(detail.data.url)}`)
    : "");
  renderLink();
  const fTags = tagEditor("Tags", d.tags);
  const fStatus = makeField("Status", statusSelect(d.status));
  const fRating = starInput("Rating", d.rating);
  const formMsg = h("div", { "aria-live": "polite" });
  const saveBtn = h("button", { type: "submit", class: "primary" }, "Save changes");

  const patch = () => {
    const cur = detail.data;
    const p = {};
    const title = fTitle.control.value.replace(/[\r\n]+/g, " ").trim();
    const pitch = fPitch.control.value.trim();
    const url = fUrl.control.value.trim();
    if (title !== cur.title) p.title = title;
    if (pitch !== (cur.pitch || "")) p.pitch = pitch;
    if (url !== (cur.url || "")) p.url = url;
    if (fTags.value.join(",") !== cur.tags.join(",")) p.tags = fTags.value;
    if (fStatus.control.value !== cur.status) p.status = fStatus.control.value;
    if ((fRating.value ?? null) !== cur.rating) p.rating = fRating.value;
    return p;
  };

  const form = h("form", { class: "stack", novalidate: true, autocomplete: "off", "aria-label": "Edit idea" },
    fTitle.el, fPitch.el, fUrl.el, openLink, fTags.el,
    h("div", { class: "row start" }, fStatus.el, fRating.el),
    formMsg,
    h("div", { class: "actions" }, saveBtn),
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const errors = [
      [fTitle.validate(true), fTitle.control],
      [fPitch.validate(true), fPitch.control],
      [fUrl.validate(true), fUrl.control],
      [fTags.commit(), fTags.input],
    ].filter(([e]) => e);
    if (errors.length) { errors[0][1].focus(); return; }
    const p = patch();
    if (!Object.keys(p).length) { toast("Nothing to save"); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    const res = await call("update_idea", { id: d.id, ...p });
    saveBtn.disabled = false;
    saveBtn.textContent = "Save changes";
    if (detail.id !== d.id) return;
    if (res.error) { formMsg.replaceChildren(errorNotice(res)); return; }
    formMsg.replaceChildren();
    const r = res.result;
    detail.data = r;
    // Show what the server stored (trimmed text, normalized tags).
    fTitle.control.value = r.title;
    fPitch.control.value = r.pitch || "";
    fUrl.control.value = r.url || "";
    fTags.reset(r.tags);
    heading.textContent = r.title;
    renderHead();
    renderLink();
    toast("Saved");
    refresh();
  });

  // Notes
  const notesWrap = h("div", { class: "stack" });
  const fNote = makeField("New note", textArea({ rows: 3 }, { multiline: true }), { check: checkNote, hint: "Ctrl+Enter adds it" });
  const noteMsg = h("div", { "aria-live": "polite" });
  const noteBtn = h("button", { type: "submit" }, "Add note");
  const noteForm = h("form", { class: "stack", novalidate: true, "aria-label": "Add a note" },
    fNote.el, noteMsg, h("div", { class: "row" }, noteBtn));
  noteForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (fNote.validate(true)) { fNote.control.focus(); return; }
    noteBtn.disabled = true;
    noteBtn.textContent = "Adding…";
    const res = await call("add_note", { id: d.id, body: fNote.control.value.trim() });
    noteBtn.disabled = false;
    noteBtn.textContent = "Add note";
    if (detail.id !== d.id) return;
    if (res.error) { noteMsg.replaceChildren(errorNotice(res)); return; }
    noteMsg.replaceChildren();
    fNote.control.value = "";
    fNote.reset();
    detail.data = { ...detail.data, notes: res.result.notes, note_count: res.result.note_count, updated_at: res.result.updated_at };
    renderNotes();
    fNote.control.focus();
    toast("Note added");
    refresh();
  });

  function renderNotes() {
    const notes = detail.data.notes;
    notesWrap.replaceChildren(
      h("h3", { class: "eyebrow" }, notes.length ? `Notes · ${notes.length}` : "Notes"),
      noteForm,
      notes.length
        ? h("ul", { class: "list" }, ...notes.map((n, ix) => h("li", {},
            h("div", { class: "grow long" },
              h("div", { class: "pre" }, n.body),
              h("div", { class: "sub muted", title: fullDate(n.created_at) }, `${fullDate(n.created_at)} · ${ago(n.created_at)}`),
            ),
            h("button", { type: "button", class: "ghost sm danger", "aria-label": `Delete note from ${fullDate(n.created_at)}`, onclick: () => deleteNote(n, ix) }, "Delete"),
          )))
        : h("p", { class: "muted" }, "No notes yet. Jot down what you learn as the idea develops."),
    );
  }

  async function deleteNote(n, ix) {
    const ok = await askConfirm({ title: "Delete this note?", text: `The note from ${fullDate(n.created_at)} will be gone for good.`, ok: "Delete note" });
    if (!ok) return;
    const res = await call("delete_note", { id: d.id, note_id: n.id });
    if (detail.id !== d.id) return;
    if (res.error) { noteMsg.replaceChildren(errorNotice(res)); return; }
    const notes = detail.data.notes.filter((x) => x.id !== n.id);
    detail.data = { ...detail.data, notes, note_count: notes.length };
    renderNotes();
    const buttons = notesWrap.querySelectorAll("ul.list button");
    (buttons[Math.min(ix, buttons.length - 1)] || fNote.control).focus();
    toast("Note deleted");
    refresh();
  }

  // Delete idea
  const delMsg = h("div", { "aria-live": "polite" });
  const delBtn = h("button", { type: "button", class: "danger", onclick: deleteIdea }, "Delete idea");
  async function deleteIdea() {
    const n = detail.data.notes.length;
    const ok = await askConfirm({
      title: "Delete this idea?",
      text: `“${short(detail.data.title, 120)}”${n ? ` and its ${plural(n, "note")}` : ""} will be gone for good. To keep it on record, set its status to Killed instead.`,
      ok: "Delete idea",
    });
    if (!ok) return;
    delBtn.disabled = true;
    const res = await call("delete_idea", { id: d.id });
    delBtn.disabled = false;
    if (detail.id !== d.id) return;
    if (res.error) { delMsg.replaceChildren(errorNotice(res)); return; }
    const title = detail.data.title;
    detail.form = null;
    closeDetail();
    toast(`Deleted “${short(title)}”`);
    refresh();
  }

  detail.form = {
    dirty: () => Object.keys(patch()).length > 0 || !!fNote.control.value.trim() || !!fTags.input.value.trim(),
  };

  renderNotes();
  body.replaceChildren(
    h("div", { class: "row between start" }, h("div", { class: "stack long grow" }, heading, head), closeButton()),
    form,
    notesWrap,
    h("div", { class: "stack" },
      h("h3", { class: "eyebrow" }, "Delete"),
      h("div", { class: "row between" },
        h("span", { class: "muted" }, "Removes the idea, its tags and notes for good."),
        delBtn,
      ),
      delMsg,
    ),
  );
  fTitle.control.focus();
}

// ---- start ----
if (fake) {
  $("main").prepend(h("div", { class: "notice info" }, PREVIEW_NOTICE[preview]));
}
syncFilters();
refresh();
if (routeId()) openIdea(routeId());
