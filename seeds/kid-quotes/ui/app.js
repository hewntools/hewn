// SPDX-License-Identifier: Apache-2.0
"use strict";

const call = (operation, input = {}) =>
  fetch("/api/invoke", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hewn-ui": "1" },
    body: JSON.stringify({ operation, input }),
  })
    .then((r) => r.json())
    .catch(() => ({ error: "network", message: "Couldn't reach Hewn. Check the connection and try again." }));

const $ = (id) => document.getElementById(id);
const PAGE = 50;

const state = {
  kids: [],
  lastKidId: null, // the kid picked for the next quote
  filterKid: null, // kid id, or null for everyone
  q: "",
  quotes: [],
  total: 0,
  editing: null,
};

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c !== null && c !== undefined) n.append(c);
  return n;
}

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
function formatDate(iso) {
  const today = localToday();
  if (iso === today) return "Today";
  const y = new Date(today + "T12:00:00");
  y.setDate(y.getDate() - 1);
  const yIso = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
  if (iso === yIso) return "Yesterday";
  return dateFmt.format(new Date(iso + "T12:00:00"));
}

function showError(box, message) {
  box.textContent = message || "Something went wrong.";
  box.hidden = false;
}

function toast(message) {
  const t = el("div", { class: "toast", role: "status", text: message });
  $("toasts").append(t);
  setTimeout(() => t.remove(), 3200);
}

function kidName(id) {
  return state.kids.find((k) => k.id === id)?.name ?? "";
}

// ---------- kids ----------

async function loadKids() {
  const r = await call("list_kids");
  if (r.error) return r;
  state.kids = Array.isArray(r.result) ? r.result : [];
  if (state.lastKidId === null || !state.kids.some((k) => k.id === state.lastKidId)) {
    // Default to whoever was quoted last.
    const recent = [...state.kids].filter((k) => k.last_quote_at).sort((a, b) => (a.last_quote_at < b.last_quote_at ? 1 : -1))[0];
    state.lastKidId = (recent ?? state.kids[0])?.id ?? null;
  }
  return r;
}

function renderKidPicker() {
  const box = $("kid-picker");
  box.replaceChildren();
  for (const k of state.kids) {
    box.append(
      el("button", {
        type: "button",
        class: "chip plain",
        "aria-pressed": String(k.id === state.lastKidId),
        text: k.name,
        onclick: () => {
          state.lastKidId = k.id;
          renderKidPicker();
        },
      }),
    );
  }
}

function renderKidFilter() {
  const box = $("kid-filter");
  box.replaceChildren();
  if (state.kids.length < 2) return;
  const chip = (label, id) =>
    el("button", {
      type: "button",
      class: "chip plain",
      "aria-pressed": String(state.filterKid === id),
      text: label,
      onclick: () => {
        state.filterKid = id;
        renderKidFilter();
        loadQuotes();
      },
    });
  box.append(chip("Everyone", null));
  for (const k of state.kids) box.append(chip(k.name, k.id));
}

function renderKidCard(open) {
  const card = $("kids-card");
  const hasKids = state.kids.length > 0;
  card.hidden = !open;
  $("kids-intro").hidden = hasKids;
  $("kid-done").hidden = !hasKids;
  $("kid-list").textContent = hasKids ? `Added: ${state.kids.map((k) => k.name).join(", ")}` : "";
}

$("kid-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("kid-error");
  err.hidden = true;
  const name = $("kid-name").value.trim();
  if (!name) {
    showError(err, "Write a name.");
    $("kid-name").focus();
    return;
  }
  const btn = $("kid-save");
  btn.disabled = true;
  const input = { name };
  if ($("kid-birthdate").value) input.birthdate = $("kid-birthdate").value;
  const r = await call("add_kid", input);
  btn.disabled = false;
  if (r.error) return showError(err, r.message);
  state.lastKidId = r.result.id;
  $("kid-name").value = "";
  $("kid-birthdate").value = "";
  await loadKids();
  toast(`${r.result.name} added`);
  renderAll(true);
  await Promise.all([loadQuotes(), loadOnThisDay()]);
  $("kid-name").focus();
});

$("kid-done").addEventListener("click", () => {
  renderKidCard(false);
  $("text").focus();
});

$("add-kid").addEventListener("click", () => {
  renderKidCard(true);
  $("kid-name").focus();
});

// ---------- quick add ----------

$("quote-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("quote-error");
  err.hidden = true;
  const text = $("text").value.trim();
  if (!text) {
    showError(err, "Write down what they said.");
    $("text").focus();
    return;
  }
  if (state.lastKidId === null) return showError(err, "Pick who said it.");
  const input = { text, kid: state.lastKidId, said_on: $("said-on").value || localToday() };
  const context = $("context").value.trim();
  if (context) input.context = context;
  const btn = $("quote-save");
  btn.disabled = true;
  const r = await call("add_quote", input);
  btn.disabled = false;
  if (r.error) return showError(err, r.message);
  $("text").value = "";
  $("context").value = "";
  $("said-on").value = localToday();
  toast(`Saved ${r.result.kid}'s quote`);
  await Promise.all([loadKids(), loadQuotes(), loadOnThisDay()]);
  renderKidFilter();
  $("text").focus();
});

// Enter saves; Shift+Enter makes a new line.
$("text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("quote-form").requestSubmit();
  }
});

// ---------- quotes ----------

function quoteMeta(q, extra) {
  return [q.kid, q.age_at_time, formatDate(q.said_on), q.context, extra].filter(Boolean).join(" · ");
}

function quoteRow(q) {
  if (state.editing === q.id) return editRow(q);
  return el(
    "li",
    {},
    el("div", { class: "grow" }, el("div", { class: "quote-text", text: q.text }), el("div", { class: "sub", text: quoteMeta(q) })),
    el("button", {
      type: "button",
      class: "ghost",
      text: "Edit",
      "aria-label": `Edit "${q.text.slice(0, 40)}"`,
      onclick: () => {
        state.editing = q.id;
        renderQuotes();
        document.querySelector(".edit-form textarea")?.focus();
      },
    }),
  );
}

function editRow(q) {
  const text = el("textarea", { maxlength: "500", required: true, "aria-label": "Quote" });
  text.value = q.text;
  const kid = el("select", { "aria-label": "Who said it" });
  for (const k of state.kids) {
    const o = el("option", { value: String(k.id), text: k.name });
    if (k.id === q.kid_id) o.selected = true;
    kid.append(o);
  }
  const date = el("input", { type: "date", required: true, "aria-label": "When" });
  date.value = q.said_on;
  const context = el("input", { type: "text", maxlength: "200", placeholder: "at dinner", "aria-label": "Where or what was happening" });
  context.value = q.context ?? "";
  const err = el("div", { class: "notice danger", role: "alert", hidden: true });
  const save = el("button", { type: "submit", class: "primary", text: "Save" });
  let armed = false;
  const del = el("button", { type: "button", class: "danger", text: "Delete" });
  del.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      del.textContent = "Delete this quote for good?";
      return;
    }
    del.disabled = true;
    const r = await call("delete_quote", { id: q.id });
    if (r.error) {
      del.disabled = false;
      return showError(err, r.message);
    }
    state.editing = null;
    toast("Quote deleted");
    await Promise.all([loadKids(), loadQuotes(), loadOnThisDay()]);
  });
  const form = el(
    "form",
    { class: "edit-form", novalidate: true },
    el("label", { class: "field", style: "margin-top: 0" }, el("span", { class: "label", text: "Quote" }), text),
    el("div", { class: "two" },
      el("label", { class: "field" }, el("span", { class: "label", text: "Who said it" }), kid),
      el("label", { class: "field" }, el("span", { class: "label", text: "When" }), date),
    ),
    el("label", { class: "field" }, el("span", { class: "label", text: "Where or what was happening" }), context),
    err,
    el("div", { class: "row" },
      save,
      el("button", { type: "button", class: "ghost", text: "Cancel", onclick: () => { state.editing = null; renderQuotes(); } }),
      el("span", { class: "spacer" }),
      del,
    ),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.hidden = true;
    if (!text.value.trim()) return showError(err, "The quote can't be empty.");
    if (!date.value) return showError(err, "Pick a date.");
    save.disabled = true;
    const r = await call("update_quote", {
      id: q.id,
      text: text.value.trim(),
      kid: Number(kid.value),
      said_on: date.value,
      context: context.value.trim() || null,
    });
    save.disabled = false;
    if (r.error) return showError(err, r.message);
    state.editing = null;
    toast("Saved");
    await Promise.all([loadKids(), loadQuotes(), loadOnThisDay()]);
  });
  return el("li", {}, form);
}

function renderQuotes() {
  const list = $("quote-list");
  list.replaceChildren(...state.quotes.map(quoteRow));
  const filtered = state.filterKid !== null || state.q;
  $("all-title").textContent = state.total === 1 ? "1 quote" : `${state.total} quotes`;
  const empty = $("list-empty");
  empty.hidden = state.quotes.length > 0;
  if (!state.quotes.length) {
    if (filtered) {
      empty.replaceChildren(el("p", { class: "muted", text: "No quotes match." }));
    } else {
      empty.replaceChildren(
        el("div", { class: "empty" },
          el("strong", { text: "No quotes yet" }),
          el("span", { text: "Write down the next funny thing they say." }),
          el("button", { type: "button", class: "primary", text: "Add the first quote", onclick: () => $("text").focus() }),
        ),
      );
    }
  }
  $("more").hidden = state.quotes.length >= state.total;
}

async function loadQuotes(append = false) {
  const input = { limit: PAGE, offset: append ? state.quotes.length : 0 };
  if (state.filterKid !== null) input.kid = state.filterKid;
  if (state.q) input.q = state.q;
  const r = await call("list_quotes", input);
  const err = $("list-error");
  if (r.error) return showError(err, r.message);
  err.hidden = true;
  state.quotes = append ? state.quotes.concat(r.result.quotes) : r.result.quotes;
  state.total = r.result.total;
  renderQuotes();
}

$("more").addEventListener("click", () => loadQuotes(true));

let searchTimer;
$("search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    loadQuotes();
  }, 250);
});

// ---------- on this day ----------

async function loadOnThisDay() {
  const r = await call("on_this_day", { date: localToday() });
  const section = $("otd");
  if (r.error || !r.result.quotes.length) {
    section.hidden = true;
    return;
  }
  $("otd-list").replaceChildren(
    ...r.result.quotes.map((q) =>
      el("li", {},
        el("div", { class: "grow" },
          el("div", { class: "quote-text", text: q.text }),
          el("div", { class: "sub", text: quoteMeta(q, q.years_ago === 1 ? "1 year ago" : `${q.years_ago} years ago`) }),
        ),
      ),
    ),
  );
  section.hidden = false;
}

// ---------- page ----------

function renderAll(keepKidCardOpen = false) {
  const hasKids = state.kids.length > 0;
  $("loading").hidden = true;
  renderKidCard(!hasKids || keepKidCardOpen);
  $("add-card").hidden = !hasKids;
  $("all").hidden = !hasKids;
  renderKidPicker();
  renderKidFilter();
}

async function start() {
  $("said-on").value = localToday();
  const r = await loadKids();
  if (r.error) {
    $("loading").hidden = true;
    const box = el("div", { class: "notice danger", role: "alert" });
    showError(box, r.message);
    $("app").append(box);
    return;
  }
  renderAll();
  if (state.kids.length) {
    await Promise.all([loadQuotes(), loadOnThisDay()]);
    $("text").focus();
  } else {
    $("kid-name").focus();
  }
}

start();
