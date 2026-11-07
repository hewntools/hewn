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
const KID_COLOURS = 5;
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const state = {
  kids: [],
  lastKidId: null, // the kid picked for the next quote
  filterKid: null, // kid id, or null for everyone
  q: "",
  quotes: [], // the visible, filtered page of the list
  total: 0,
  all: [], // every quote, for the timeline and the spotlight
  otd: [], // on this day, earlier years
  seen: new Set(), // on-this-day quotes already spotlighted
  spot: null, // { q, src: "otd" | "random" | "picked" }
  editing: null,
};

// ---------- helpers ----------

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v; // static markup only
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) n.append(c);
  return n;
}

const NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}, ...children) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c) n.append(c);
  return n;
}

const PENCIL = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6 2.6a1.6 1.6 0 0 1 2.3 0l.5.5a1.6 1.6 0 0 1 0 2.3L6 12.8l-3.4.9.9-3.4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';

function isoOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function localToday() {
  return isoOf(new Date());
}
const day = (iso) => new Date(iso + "T12:00:00");
const DAY = 86400000;

const dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
function formatDate(iso) {
  const days = Math.round((day(localToday()) - day(iso)) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return `${days} days ago`;
  return dateFmt.format(day(iso));
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

function kidVars(id) {
  const slot = ((((Number(id) || 1) - 1) % KID_COLOURS) + KID_COLOURS) % KID_COLOURS;
  return `--kid: var(--k${slot}); --kid-ink: var(--k${slot}-ink)`;
}

function avatar(id, name, big = false) {
  return el("span", { class: big ? "avatar lg" : "avatar", style: kidVars(id), "aria-hidden": "true", text: (name || "?").trim().charAt(0) });
}

// "7 y 6 m" → big numbers, small units.
function ageNode(age) {
  if (!age) return null;
  const n = el("span", { class: "age", "aria-label": `aged ${age.replace(/\by\b/, "years").replace(/\bm\b/, "months")}` });
  const re = /(\d+)\s*([a-z]+)/gi;
  let m;
  while ((m = re.exec(age))) n.append(el("b", { text: m[1], "aria-hidden": "true" }), el("small", { text: m[2], "aria-hidden": "true" }));
  if (!n.childNodes.length) n.textContent = age;
  return n;
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
      el(
        "button",
        {
          type: "button",
          class: "kid-chip",
          style: kidVars(k.id),
          "aria-pressed": String(k.id === state.lastKidId),
          onclick: () => {
            state.lastKidId = k.id;
            renderKidPicker();
          },
        },
        avatar(k.id, k.name),
        k.name,
      ),
    );
  }
}

function renderKidFilter() {
  const box = $("kid-filter");
  box.replaceChildren();
  if (state.kids.length < 2) return;
  const chip = (label, id) =>
    el(
      "button",
      {
        type: "button",
        class: id === null ? "kid-chip sm everyone" : "kid-chip sm",
        style: id === null ? null : kidVars(id),
        "aria-pressed": String(state.filterKid === id),
        onclick: () => {
          state.filterKid = id;
          renderKidFilter();
          loadQuotes();
        },
      },
      el("span", { class: "swatch", "aria-hidden": "true" }),
      label,
    );
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
  await refreshQuotes();
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
  await Promise.all([loadKids(), refreshQuotes()]);
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

// ---------- the quote list ----------

function quoteRow(q) {
  if (state.editing === q.id) return editRow(q);
  return el(
    "li",
    { class: "q", style: kidVars(q.kid_id) },
    el(
      "div",
      { class: "q-bubble" },
      el("p", { class: "q-text", text: q.text }),
      el("button", {
        type: "button",
        class: "ghost q-edit",
        title: "Edit",
        html: PENCIL,
        "aria-label": `Edit "${q.text.slice(0, 40)}"`,
        onclick: () => {
          state.editing = q.id;
          renderQuotes();
          document.querySelector(".edit-form textarea")?.focus();
        },
      }),
    ),
    el(
      "div",
      { class: "q-by" },
      avatar(q.kid_id, q.kid),
      el("div", { class: "q-who" }, el("span", { class: "q-name", text: q.kid }), q.context ? el("span", { class: "q-ctx", text: q.context }) : null),
      el("div", { class: "q-when" }, ageNode(q.age_at_time), el("span", { class: "q-date", text: formatDate(q.said_on) })),
    ),
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
    await Promise.all([loadKids(), refreshQuotes()]);
  });
  const form = el(
    "form",
    { class: "edit-form", novalidate: true },
    el("label", { class: "field", style: "margin-top: 0" }, el("span", { class: "label", text: "Quote" }), text),
    el(
      "div",
      { class: "two" },
      el("label", { class: "field" }, el("span", { class: "label", text: "Who said it" }), kid),
      el("label", { class: "field" }, el("span", { class: "label", text: "When" }), date),
    ),
    el("label", { class: "field" }, el("span", { class: "label", text: "Where or what was happening" }), context),
    err,
    el(
      "div",
      { class: "edit-actions" },
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
    await Promise.all([loadKids(), refreshQuotes()]);
  });
  return el("li", { class: "q editing", style: kidVars(q.kid_id) }, form);
}

const BUBBLE_ART =
  '<svg viewBox="0 0 64 52" aria-hidden="true"><path d="M8 4h36a6 6 0 0 1 6 6v18a6 6 0 0 1-6 6H22l-10 8v-8H8a6 6 0 0 1-6-6V10a6 6 0 0 1 6-6z" fill="var(--k0)" opacity=".9"/><path d="M30 18h26a5 5 0 0 1 5 5v13a5 5 0 0 1-5 5h-3v7l-8-7H30a5 5 0 0 1-5-5V23a5 5 0 0 1 5-5z" fill="var(--k1)" opacity=".85"/></svg>';

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
        el(
          "div",
          { class: "empty-quotes" },
          el("span", { html: BUBBLE_ART }),
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

// ---------- everything: timeline + spotlight ----------

async function loadAll() {
  const r = await call("list_quotes", { limit: 1000 });
  if (r.error) return; // the list shows its own error; the visuals just stay as they were
  state.all = r.result.quotes;
}

async function loadOnThisDay() {
  const r = await call("on_this_day", { date: localToday() });
  state.otd = r.error ? [] : r.result.quotes;
}

async function refreshQuotes() {
  await Promise.all([loadQuotes(), loadAll(), loadOnThisDay()]);
  syncSpot();
  renderVisuals();
}

function nextSpot() {
  const cur = state.spot?.q.id;
  const otd = state.otd.find((q) => !state.seen.has(q.id) && q.id !== cur);
  if (otd) {
    state.seen.add(otd.id);
    state.spot = { q: otd, src: "otd" };
    return;
  }
  let pool = state.all.filter((q) => q.id !== cur);
  // The newest is already at the top of the list; bring back something older.
  if (pool.length > 1 && state.all[0]) pool = pool.filter((q) => q.id !== state.all[0].id);
  if (!pool.length) {
    state.spot = state.all[0] ? { q: state.all[0], src: "random" } : null;
    return;
  }
  state.spot = { q: pool[Math.floor(Math.random() * pool.length)], src: "random" };
}

function syncSpot() {
  if (state.spot) {
    const id = state.spot.q.id;
    const otd = state.otd.find((q) => q.id === id);
    const fresh = otd ?? state.all.find((q) => q.id === id);
    if (!fresh) state.spot = null;
    else state.spot = { q: fresh, src: state.spot.src === "otd" && !otd ? "random" : state.spot.src };
  }
  if (!state.spot) nextSpot();
}

function spotLabel(s) {
  if (s.src === "otd") return s.q.years_ago === 1 ? "On this day, a year ago" : `On this day, ${s.q.years_ago} years ago`;
  if (s.src === "picked") return `From ${monthFmt.format(day(s.q.said_on))}`;
  return "Remember this one?";
}

function renderSpot(animate = false) {
  const card = $("spot");
  const s = state.spot;
  card.hidden = !s;
  $("hero").classList.toggle("solo", !s);
  if (!s) return;
  card.setAttribute("style", kidVars(s.q.kid_id));
  $("spot-label").textContent = spotLabel(s);
  $("spot-text").textContent = s.q.text;
  $("spot-by").replaceChildren(
    avatar(s.q.kid_id, s.q.kid, true),
    el("span", { class: "name" }, s.q.kid, s.q.age_at_time ? el("span", { class: "when", text: ` at ${s.q.age_at_time}` }) : null),
    el("span", { class: "when", text: formatDate(s.q.said_on) }),
    s.q.context ? el("span", { class: "when", text: s.q.context }) : null,
  );
  $("spot-next").hidden = state.all.length < 2 && state.otd.length < 2;
  if (animate && !reducedMotion) {
    card.classList.remove("swap");
    void card.offsetWidth;
    card.classList.add("swap");
  }
}

$("spot-next").addEventListener("click", () => {
  nextSpot();
  renderSpot(true);
  renderTimeline();
});

function pickFromTimeline(q) {
  state.spot = { q, src: "picked" };
  renderSpot(true);
  renderTimeline(q.id);
  if (window.innerWidth < 820) $("spot").scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
}

function renderInsight() {
  const box = $("insight");
  const parts = [];
  const total = state.all.length;
  if (state.kids.length > 1 && total > 1) {
    const counts = state.kids.map((k) => ({ k, n: state.all.filter((q) => q.kid_id === k.id).length })).sort((a, b) => b.n - a.n);
    if (counts[0].n > counts[1].n) parts.push(`${counts[0].k.name} has said the most: ${counts[0].n} of ${total}.`);
  }
  const today = day(localToday());
  for (const k of state.kids) {
    const last = state.all.find((q) => q.kid_id === k.id); // newest first
    if (!last) {
      parts.push(`Nothing from ${k.name} yet.`);
      break;
    }
    if ((today - day(last.said_on)) / DAY > 60) {
      parts.push(`Nothing from ${k.name} since ${monthFmt.format(day(last.said_on))}.`);
      break;
    }
  }
  box.textContent = parts.join(" ");
  box.hidden = !parts.length;
}

function renderTimeline(focusId = null) {
  const card = $("timeline-card");
  const box = $("timeline");
  if (!state.all.length || !state.kids.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const W = Math.max(260, Math.round(box.clientWidth || 640));
  const today = day(localToday());
  const dates = state.all.map((q) => day(q.said_on));
  const first = new Date(Math.min(...dates));
  const last = new Date(Math.max(today, ...dates));
  let start = new Date(first.getFullYear(), 0, 1, 12);
  let end = new Date(last.getTime() + Math.max(14, (last - start) / DAY * 0.05) * DAY);
  if ((end - start) / DAY < 270) start = new Date(end.getTime() - 270 * DAY);
  const padL = 2;
  const padR = 2;
  const x = (d) => padL + ((d - start) / (end - start)) * (W - padL - padR);
  const pxPerYear = (365 * DAY * (W - padL - padR)) / (end - start);

  const laneH = 62;
  const lanesH = state.kids.length * laneH;
  const H = lanesH + 24;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "group", "aria-label": "Quotes over time, one line per kid" });

  // Years
  const step = Math.max(1, Math.ceil(44 / pxPerYear));
  let lastYearX = -Infinity;
  for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
    const d = new Date(y, 0, 1, 12);
    if (d < start || d > end) continue;
    const gx = x(d);
    if (gx > 8) svg.append(svgEl("line", { class: "gridline", x1: gx, x2: gx, y1: 0, y2: lanesH }));
    if ((y - start.getFullYear()) % step === 0 && gx + 34 < W) {
      svg.append(svgEl("text", { class: "yr", x: gx + 4, y: H - 6, text: String(y) }));
      lastYearX = gx;
    }
  }
  const tx = x(today);
  state.kids.forEach((k, i) => svg.append(svgEl("line", { class: "now-line", x1: tx, x2: tx, y1: i * laneH + 24, y2: i * laneH + 52 })));
  if (tx - lastYearX > 80) svg.append(svgEl("text", { class: "now", x: tx, y: H - 6, "text-anchor": "end", text: "Today" }));

  const spotId = state.spot?.q.id;
  state.kids.forEach((k, i) => {
    const y0 = i * laneH;
    const by = y0 + 36;
    const g = svgEl("g", { style: kidVars(k.id) });
    const qs = state.all.filter((q) => q.kid_id === k.id).sort((a, b) => (a.said_on < b.said_on ? -1 : 1));

    const countText = qs.length === 0 ? "No quotes yet" : qs.length === 1 ? "1 quote" : `${qs.length} quotes`;
    // Rough widths keep the name, age and count from running into each other on a narrow phone.
    const maxName = Math.max(6, Math.floor((W - countText.length * 7.5 - 16) / 9));
    const shown = k.name.length > maxName ? k.name.slice(0, maxName - 1) + "…" : k.name;
    const name = svgEl("text", { class: "lane-name", x: padL, y: y0 + 16 }, document.createTextNode(shown));
    if (k.name !== shown) name.append(svgEl("title", { text: k.name }));
    if (k.age && shown.length * 9 + 8 + k.age.length * 7 + countText.length * 7.5 + 16 < W) name.append(svgEl("tspan", { class: "lane-age", dx: 8, text: k.age }));
    g.append(name);
    g.append(svgEl("text", { class: "lane-count", x: W - padR, y: y0 + 16, "text-anchor": "end", text: countText }));

    // Life line: from birth (or their first quote) to today.
    const born = k.birthdate ? day(k.birthdate) : null;
    const from = born ? Math.max(padL, x(born)) : qs.length ? x(day(qs[0].said_on)) : padL;
    g.append(svgEl("rect", { class: "life", x: from, y: by - 4, width: Math.max(4, tx - from), height: 8, rx: 4 }));

    // Birthdays
    if (born) {
      const every = Math.max(1, Math.ceil(26 / pxPerYear));
      for (let y = start.getFullYear(); y <= today.getFullYear(); y++) {
        const bd = new Date(y, born.getMonth(), born.getDate(), 12);
        const age = y - born.getFullYear();
        if (age < 1 || bd < start || bd > today || age % every) continue;
        const bx = x(bd);
        g.append(svgEl("line", { class: "bday", x1: bx, x2: bx, y1: by - 9, y2: by + 9 }));
        g.append(svgEl("text", { class: "bday-t", x: Math.min(W - 12, Math.max(12, bx)), y: by + 22, "text-anchor": "middle", text: `${age} y` }));
      }
    }

    // Quotes
    let prev = -Infinity;
    let stack = 0;
    for (const q of qs) {
      const cx = x(day(q.said_on));
      stack = cx - prev < 11 ? stack + 1 : 0;
      prev = cx;
      const cy = by + (stack === 0 ? 0 : (stack % 2 ? -1 : 1) * Math.ceil(stack / 2) * 7);
      if (q.id === spotId) g.append(svgEl("circle", { class: "ring", cx, cy, r: 12 }));
      const label = `${q.kid}, ${formatDate(q.said_on)}: ${q.text}`;
      const dot = svgEl(
        "circle",
        {
          class: "dot",
          cx,
          cy,
          r: q.id === spotId ? 7.5 : 6.5,
          tabindex: 0,
          role: "button",
          "aria-label": label,
          "data-qid": q.id,
          onclick: () => pickFromTimeline(q),
          onkeydown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              pickFromTimeline(q);
            }
          },
        },
        svgEl("title", { text: label }),
      );
      g.append(dot);
    }
    svg.append(g);
  });

  box.replaceChildren(svg);
  if (focusId !== null) box.querySelector(`[data-qid="${focusId}"]`)?.focus({ preventScroll: true });
}

function renderVisuals() {
  renderSpot();
  renderTimeline();
  renderInsight();
}

let lastWidth = 0;
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const w = $("timeline").clientWidth;
    if (w && w !== lastWidth) {
      lastWidth = w;
      renderTimeline();
    }
  }, 120);
});

// ---------- page ----------

function renderAll(keepKidCardOpen = false) {
  const hasKids = state.kids.length > 0;
  $("loading").hidden = true;
  renderKidCard(!hasKids || keepKidCardOpen);
  $("hero").hidden = !hasKids;
  $("all").hidden = !hasKids;
  $("add-kid").hidden = !hasKids;
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
    await refreshQuotes();
    lastWidth = $("timeline").clientWidth;
    $("text").focus({ preventScroll: true });
  } else {
    $("kid-name").focus();
  }
}

start();
