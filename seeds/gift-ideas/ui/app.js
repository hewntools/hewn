// SPDX-License-Identifier: Apache-2.0
// Gift ideas UI: the gift year ring, what's coming up, quick "Save idea", people and a person sheet.

const WINDOW_DAYS = 90;
const YEAR_DAYS = 366;
const DAY = 86400000;

const $ = (sel, root = document) => root.querySelector(sel);

async function call(operation, input = {}, operationVersion = 1) {
  let res;
  try {
    const r = await fetch("/api/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hewn-ui": "1" },
      body: JSON.stringify({ operation, input, operationVersion }),
    });
    res = await r.json();
  } catch {
    throw new Error("Couldn't reach Gift Ideas. Try again.");
  }
  if (res && res.error) throw new Error(res.message || res.error);
  return res.result;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function localToday() {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  return ["year", "month", "day"].map((t) => parts.find((p) => p.type === t).value).join("-");
}

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const longTodayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const monthDayFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", timeZone: "UTC" });
const shortMonthDayFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
const monthShortFmt = new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" });
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", timeZone: "UTC" });
const noteDateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const numFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const MONTHS = Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat(undefined, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, i, 1))));

function utcOf(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function formatDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return dateFmt.format(new Date(y, m - 1, d));
}

function formatBirthday(b) {
  if (!b) return "";
  const parts = b.split("-").map(Number);
  const [m, d] = parts.length === 3 ? [parts[1], parts[2]] : parts;
  const md = monthDayFmt.format(new Date(Date.UTC(2000, m - 1, d)));
  return parts.length === 3 ? `${md} ${parts[0]}` : md;
}

function daysText(n) {
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  return `in ${n} days`;
}

function farText(n) {
  if (n < 60) return daysText(n);
  const months = Math.round(n / 30.44);
  return `in ${months} months`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- gift box glyph

const GLYPH = `<rect x="1.5" y="5" width="13" height="9.5" rx="2"/><path class="rib" d="M8 5v9.5M1.5 9h13"/><path class="bow" d="M8 5C6.2 1.6 3 2.4 4.6 5M8 5c1.8-3.4 5-2.6 3.4 0"/>`;

/** State classes for one occasion: bought, ideas, or nothing yet (amber when it's close). */
function stateOf(u) {
  if (u.ready === "bought") return "g-bought";
  if (u.ready === "ideas") return "g-ideas";
  return u.days_until <= 21 ? "g-none g-soon" : "g-none";
}

function box(state) {
  return `<svg class="box ${state}" viewBox="0 0 16 16" aria-hidden="true">${GLYPH}</svg>`;
}

function statusText(u) {
  if (u.ready === "bought") return u.bought_count > 1 ? `${u.bought_count} bought` : "Bought";
  if (u.ready === "ideas") return plural(u.idea_count, "idea", "ideas");
  return u.suggestion_count ? `Nothing yet, ${plural(u.suggestion_count, "suggestion", "suggestions")} ready` : "Nothing yet";
}

// ---------------------------------------------------------------- small helpers

function toast(message, action) {
  const region = $("#toasts");
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span>${esc(message)}</span>`;
  if (action) {
    const b = document.createElement("button");
    b.className = "sm";
    b.textContent = action.label;
    b.addEventListener("click", () => { el.remove(); action.run(); });
    el.append(b);
  }
  region.append(el);
  setTimeout(() => el.remove(), action ? 7000 : 3500);
}

function showError(form, message) {
  const box = $("[data-error]", form);
  box.textContent = message;
  box.classList.remove("hidden");
}

function clearError(form) {
  const box = $("[data-error]", form);
  box.textContent = "";
  box.classList.add("hidden");
}

// ---------------------------------------------------------------- birthday fields

function birthdayFields(container, value) {
  const parts = value ? value.split("-") : [];
  const [y, m, d] = parts.length === 3 ? parts : ["", parts[0] ?? "", parts[1] ?? ""];
  container.innerHTML = `
    <select name="b_month" aria-label="Birthday month">
      <option value="">Month</option>
      ${MONTHS.map((name, i) => `<option value="${i + 1}" ${Number(m) === i + 1 ? "selected" : ""}>${esc(name)}</option>`).join("")}
    </select>
    <input type="number" name="b_day" min="1" max="31" placeholder="Day" aria-label="Birthday day" inputmode="numeric" value="${d ? Number(d) : ""}">
    <input type="number" name="b_year" min="1900" max="2100" placeholder="Year" aria-label="Birth year (optional)" inputmode="numeric" value="${y ? Number(y) : ""}">`;
}

/** "" when left empty, "MM-DD" or "YYYY-MM-DD"; throws when half filled in. */
function readBirthday(form) {
  const m = form.elements.b_month.value;
  const d = form.elements.b_day.value.trim();
  const y = form.elements.b_year.value.trim();
  if (!m && !d && !y) return "";
  if (!m || !d) throw new Error("Pick both a month and a day for the birthday, or leave it empty.");
  const p = (n) => String(n).padStart(2, "0");
  const md = `${p(Number(m))}-${p(Number(d))}`;
  if (y) {
    if (!/^\d{4}$/.test(y)) throw new Error("The year needs four digits.");
    return `${y}-${md}`;
  }
  return md;
}

// ---------------------------------------------------------------- state and rendering

let people = [];
let lastPersonId = null;
let showAllAgenda = false;
let lastYear = [];
let lastToday = localToday();

async function refresh() {
  const today = localToday();
  const [list, up, stored] = await Promise.all([
    call("list_people", { today }),
    call("upcoming", { today, days: YEAR_DAYS }),
    call("get_prepared"),
  ]);
  people = list.people;
  $("#loading").classList.add("hidden");
  $("#load-error").classList.add("hidden");
  $("#today-note").textContent = longTodayFmt.format(new Date(utcOf(today)));
  if (people.length === 0) {
    $("#main").classList.add("hidden");
    $("#first-run").classList.remove("hidden");
    birthdayFieldsOnce($("#first-form"));
    $("#first-form").elements.name.focus();
    return;
  }
  $("#first-run").classList.add("hidden");
  $("#main").classList.remove("hidden");
  lastToday = today;
  lastYear = up.occasions.map((u) => ({
    ...u,
    suggestion_count: stored.prepared.find((r) => r.person_id === u.person_id && r.date === u.date)?.suggestions.length ?? 0,
  }));
  renderYear();
  renderPeople();
  renderPersonPicker();
}

function birthdayFieldsOnce(form) {
  const box = $("[data-birthday]", form);
  if (!box.firstElementChild) birthdayFields(box, "");
}

/** Occasions that share a date and name (Christmas Eve for everyone) become one group. */
function groupOccasions(list) {
  const groups = [];
  const byKey = new Map();
  for (const u of list) {
    const key = u.kind === "birthday" ? `b|${u.person_id}|${u.date}` : `${u.kind}|${u.name}|${u.date}`;
    let g = byKey.get(key);
    if (!g) {
      g = { kind: u.kind, name: u.name, date: u.date, days_until: u.days_until, turning: u.turning, items: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.items.push(u);
  }
  return groups;
}

function groupTitle(g) {
  if (g.kind === "birthday" && g.items[0].person_name) return `${g.items[0].person_name}'s birthday`;
  return g.name;
}

/** The one person a group is about, when there is exactly one. */
function soloPerson(g) {
  return g.items.length === 1 && g.items[0].person_id ? g.items[0] : null;
}

function renderYear() {
  const year = lastYear;
  const groups = groupOccasions(year);
  renderRing(year, groups);
  renderAgenda(groups);
}

// ---------------------------------------------------------------- the gift year ring

const RC = 170;
const RR = 116;
const f1 = (n) => n.toFixed(1);

function polar(d, r) {
  const a = (d / YEAR_DAYS) * 2 * Math.PI - Math.PI / 2;
  return [RC + r * Math.cos(a), RC + r * Math.sin(a)];
}

function arc(d0, d1, r) {
  const [x0, y0] = polar(d0, r);
  const [x1, y1] = polar(d1, r);
  const large = d1 - d0 > YEAR_DAYS / 2 ? 1 : 0;
  return `M${f1(x0)} ${f1(y0)}A${r} ${r} 0 ${large} 1 ${f1(x1)} ${f1(y1)}`;
}

function renderRing(year, groups) {
  const t = utcOf(lastToday);
  const [y, m] = lastToday.split("-").map(Number);
  const covered = year.filter((u) => u.person_id && u.ready === "bought").length;
  const label = `The year ahead: ${plural(year.length, "occasion", "occasions")}, ${covered} with a gift bought.`;
  let s = `<title id="ring-label">${esc(label)}</title>`;
  s += `<circle class="ring-track" cx="${RC}" cy="${RC}" r="${RR}"/>`;
  s += `<path class="ring-window" d="${arc(0.5, WINDOW_DAYS, RR)}"/>`;

  for (let k = 0; k <= 12; k++) {
    const dFirst = (Date.UTC(y, m - 1 + k, 1) - t) / DAY;
    if (k > 0 && dFirst > 0 && dFirst < YEAR_DAYS - 1) {
      const [x0, y0] = polar(dFirst, RR - 11);
      const [x1, y1] = polar(dFirst, RR + 11);
      s += `<line class="ring-tick" x1="${f1(x0)}" y1="${f1(y0)}" x2="${f1(x1)}" y2="${f1(y1)}"/>`;
    }
    const mid = (Date.UTC(y, m - 1 + k, 15) - t) / DAY;
    if (mid >= 5 && mid <= YEAR_DAYS - 5) {
      const [lx, ly] = polar(mid, RR + 30);
      s += `<text class="ring-month${k === 0 ? " now" : ""}" x="${f1(lx)}" y="${f1(ly)}" text-anchor="middle" dominant-baseline="central">${esc(monthShortFmt.format(new Date(Date.UTC(y, m - 1 + k, 15))))}</text>`;
    }
  }
  // Today: a small pointer just outside the track, so a marker on the same days stays clear.
  const [tx, ty] = polar(0, RR + 16);
  s += `<path class="ring-today" d="M${f1(tx - 6.5)} ${f1(ty - 6)}h13l-6.5 8z"><title>Today</title></path>`;

  // Occasions close together stack inwards so they don't cover each other.
  const clusters = [];
  for (const u of year) {
    const last = clusters[clusters.length - 1];
    if (last && u.days_until - last.d <= 7) last.items.push(u);
    else clusters.push({ d: u.days_until, items: [u] });
  }
  let i = 0;
  for (const c of clusters) {
    c.items.slice(0, 3).forEach((u, k) => {
      const [x, yy] = polar(c.d, RR - k * 20);
      const tip = `${u.person_name ? `${u.kind === "birthday" ? `${u.person_name}'s birthday` : `${u.name}, ${u.person_name}`}` : u.name}, ${formatDate(u.date)}${u.person_id ? `: ${statusText(u)}` : ""}`;
      if (!u.person_id) {
        s += `<g transform="translate(${f1(x)} ${f1(yy)})"><circle class="ring-general" r="4.5"><title>${esc(tip)}</title></circle></g>`;
        return;
      }
      s += `<g transform="translate(${f1(x)} ${f1(yy)})"><g class="gift ${stateOf(u)}" data-person="${u.person_id}" style="animation-delay:${i++ * 45}ms">
        <title>${esc(tip)}</title><rect class="hit" x="-11" y="-11" width="22" height="22"/>
        <g transform="translate(-9 -9.5) scale(1.125)">${GLYPH}</g></g></g>`;
    });
    if (c.items.length > 3) {
      const [x, yy] = polar(c.d, RR - 3 * 20 + 2);
      s += `<text class="ring-more" x="${f1(x)}" y="${f1(yy)}" text-anchor="middle" dominant-baseline="central">+${c.items.length - 3}</text>`;
    }
  }
  $("#ring").innerHTML = s;
  $("#legend").innerHTML = `
    <span>${box("g-bought")}Bought</span>
    <span>${box("g-ideas")}Ideas saved</span>
    <span>${box("g-none")}Nothing yet</span>
    <span><i class="swatch"></i>Next ${WINDOW_DAYS} days</span>`;
  renderCenter(groups);
}

function renderCenter(groups) {
  const el = $("#ring-center");
  if (!groups.length) {
    el.innerHTML = `<div class="rc"><span class="rc-what">A quiet year</span><span class="rc-label">Add a birthday to see it here</span></div>`;
    return;
  }
  const g = groups[0];
  const solo = soloPerson(g);
  const n = g.days_until;
  const num = n === 0 ? `<span class="rc-num word">Today</span>`
    : n === 1 ? `<span class="rc-num word">Tomorrow</span>`
    : `<span class="rc-num">${n}<small>days</small></span>`;
  let status = "";
  const withPerson = g.items.filter((u) => u.person_id);
  if (solo) status = `<span class="rc-status">${box(stateOf(solo))}${esc(statusText(solo))}</span>`;
  else if (withPerson.length) {
    const bought = withPerson.filter((u) => u.ready === "bought").length;
    const state = bought === withPerson.length ? "g-bought" : withPerson.some((u) => u.ready === "none") ? stateOf({ ready: "none", days_until: n }) : "g-ideas";
    status = `<span class="rc-status">${box(state)}${bought} of ${withPerson.length} bought</span>`;
  }
  const inner = `<span class="rc-label">Next up</span>${num}<span class="rc-what">${esc(groupTitle(g))}</span>${status}`;
  el.innerHTML = solo
    ? `<button type="button" class="rc" data-person="${solo.person_id}">${inner}</button>`
    : `<div class="rc">${inner}</div>`;
}

// ---------------------------------------------------------------- coming up

function renderAgenda(allGroups) {
  $("#window-note").textContent = `Next ${WINDOW_DAYS} days`;
  const groups = allGroups.filter((g) => g.days_until <= WINDOW_DAYS);
  const inWindow = lastYear.filter((u) => u.person_id && u.days_until <= WINDOW_DAYS);

  // How ready the next 90 days are, as one bar.
  const counts = { bought: 0, ideas: 0, none: 0 };
  for (const u of inWindow) counts[u.ready]++;
  $("#readiness").innerHTML = inWindow.length ? `
    <div class="meter" role="img" aria-label="${counts.bought} bought, ${counts.ideas} with ideas, ${counts.none} with nothing yet">
      ${counts.bought ? `<span class="m-bought" style="flex:${counts.bought}"></span>` : ""}
      ${counts.ideas ? `<span class="m-ideas" style="flex:${counts.ideas}"></span>` : ""}
      ${counts.none ? `<span class="m-none" style="flex:${counts.none}"></span>` : ""}
    </div>
    <p class="meter-note"><span><b>${counts.bought}</b>bought</span><span><b>${counts.ideas}</b>with ideas</span><span><b>${counts.none}</b>nothing yet</span></p>` : "";

  const ul = $("#upcoming");
  if (groups.length === 0) {
    ul.innerHTML = `<li class="agenda-empty">Nothing in the next ${WINDOW_DAYS} days.</li>`;
  } else {
    const shown = showAllAgenda ? groups : groups.slice(0, 8);
    ul.innerHTML = shown.map(agendaRow).join("");
  }

  const laterBox = $("#later");
  const extra = groups.length > 8
    ? `<button type="button" class="ghost sm more-btn" id="agenda-more">${showAllAgenda ? "Show fewer" : `Show all ${groups.length}`}</button>`
    : "";
  const room = Math.min(4, Math.max(0, 6 - groups.length));
  const later = allGroups.filter((g) => g.days_until > WINDOW_DAYS).slice(0, room);
  laterBox.innerHTML = extra + (later.length ? `
    <h3 class="later-head">Later</h3>
    <ul class="later">${later.map((g) => {
      const solo = soloPerson(g);
      const who = !solo && g.items.some((u) => u.person_name) ? `, ${g.items.map((u) => u.person_name).filter(Boolean).join(", ")}` : "";
      const attrs = solo ? `class="link" tabindex="0" role="button" data-person="${solo.person_id}"` : "";
      return `<li ${attrs}><span class="d">${esc(shortMonthDayFmt.format(new Date(utcOf(g.date))))}</span>
        <span class="t">${esc(groupTitle(g))}${esc(who)}</span><span class="w">${farText(g.days_until)}</span></li>`;
    }).join("")}</ul>` : "");
  const more = $("#agenda-more");
  if (more) more.addEventListener("click", () => { showAllAgenda = !showAllAgenda; renderAgenda(allGroups); });
}

function agendaRow(g) {
  const solo = soloPerson(g);
  const d = new Date(utcOf(g.date));
  const near = g.days_until <= 7;
  const attrs = solo ? `class="occ link${near ? " near" : ""}" tabindex="0" role="button" data-person="${solo.person_id}"` : `class="occ${near ? " near" : ""}"`;
  const turning = g.turning ? ` <span class="turning">turns ${g.turning}</span>` : "";
  const withPerson = g.items.filter((u) => u.person_id);
  let chips;
  if (!withPerson.length) chips = `<span class="shared">Shared occasion</span>`;
  else chips = `<div class="chips">${withPerson.map((u) => {
    const showName = !(g.kind === "birthday" && solo);
    const st = statusText(u);
    const label = showName
      ? `<b>${esc(u.person_name)}</b> <span class="s">${esc(st.charAt(0).toLowerCase() + st.slice(1))}</span>`
      : `<span class="s">${esc(st)}</span>`;
    const state = u.ready === "none" && u.days_until <= 21 ? "none soon" : u.ready;
    return solo
      ? `<span class="st ${state}">${box(stateOf(u))}<span>${label}</span></span>`
      : `<button type="button" class="st ${state}" data-person="${u.person_id}">${box(stateOf(u))}<span>${label}</span></button>`;
  }).join("")}</div>`;
  return `<li ${attrs}>
    <div class="tag" aria-hidden="true"><span class="tag-m">${esc(monthShortFmt.format(d))}</span><span class="tag-d">${d.getUTCDate()}</span></div>
    <div class="occ-main"><span class="occ-title">${esc(groupTitle(g))}${turning}</span>${chips}</div>
    <div class="occ-when"><span class="n">${daysText(g.days_until)}</span><span class="wd">${esc(weekdayFmt.format(d))}</span></div>
  </li>`;
}

// ---------------------------------------------------------------- people

function renderPeople() {
  $("#people").innerHTML = people.map((p) => {
    const next = p.next_occasion;
    const shelfMax = 10;
    const boxes = [];
    for (let i = 0; i < p.bought_count; i++) boxes.push(box("g-bought"));
    for (let i = 0; i < p.idea_count; i++) boxes.push(box("g-ideas"));
    const extra = boxes.length > shelfMax ? `<span class="count">+${boxes.length - shelfMax}</span>` : "";
    const counts = [];
    if (p.idea_count) counts.push(plural(p.idea_count, "idea", "ideas"));
    if (p.bought_count) counts.push(`${p.bought_count} bought`);
    const shelf = boxes.length
      ? `${boxes.slice(0, shelfMax).join("")}${extra}<span class="count">${counts.join(", ")}</span>`
      : `${box("g-none")}<span class="count">No ideas yet</span>`;
    const initial = esc([...p.name.trim()][0]?.toUpperCase() ?? "?");
    return `<li class="person" tabindex="0" role="button" data-person="${p.id}">
      <span class="avatar" aria-hidden="true">${initial}</span>
      <span class="p-name">${esc(p.name)}</span>
      <span class="p-rel">${esc(p.relation || " ")}</span>
      ${next ? `<div class="p-next"><span>${esc(next.name)}</span><span class="w${next.days_until <= 7 ? " near" : ""}">${daysText(next.days_until)}</span></div>` : ""}
      <div class="shelf">${shelf}</div>
    </li>`;
  }).join("");
}

function renderPersonPicker() {
  const select = $("#idea-form").elements.person_id;
  const current = select.value || (lastPersonId ? String(lastPersonId) : "");
  // People are already ordered by whose occasion is next: the likely choice comes first.
  select.innerHTML = people.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  if (current && people.some((p) => String(p.id) === current)) select.value = current;
}

// ---------------------------------------------------------------- forms

function bindFirstForm() {
  const form = $("#first-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError(form);
    const button = $("button[type=submit]", form);
    const name = form.elements.name.value.trim();
    if (!name) { showError(form, "Write a name."); form.elements.name.focus(); return; }
    let birthday;
    try { birthday = readBirthday(form); } catch (err) { showError(form, err.message); return; }
    button.disabled = true;
    try {
      await call("add_person", { name, ...(birthday ? { birthday } : {}) });
      form.reset();
      toast(`Added ${name}`);
      await refresh();
    } catch (err) {
      showError(form, err.message);
    } finally {
      button.disabled = false;
    }
  });
}

function bindPersonForm() {
  const form = $("#person-form");
  const open = () => {
    birthdayFieldsOnce(form);
    form.classList.remove("hidden");
    $("#show-add-person").classList.add("hidden");
    form.elements.name.focus();
  };
  const close = () => {
    form.reset();
    clearError(form);
    form.classList.add("hidden");
    $("#show-add-person").classList.remove("hidden");
  };
  $("#show-add-person").addEventListener("click", open);
  $("[data-cancel]", form).addEventListener("click", close);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError(form);
    const button = $("button[type=submit]", form);
    const name = form.elements.name.value.trim();
    if (!name) { showError(form, "Write a name."); form.elements.name.focus(); return; }
    let birthday;
    try { birthday = readBirthday(form); } catch (err) { showError(form, err.message); return; }
    const relation = form.elements.relation.value.trim();
    button.disabled = true;
    try {
      await call("add_person", { name, ...(relation ? { relation } : {}), ...(birthday ? { birthday } : {}) });
      close();
      toast(`Added ${name}`);
      await refresh();
    } catch (err) {
      showError(form, err.message);
    } finally {
      button.disabled = false;
    }
  });
}

function bindIdeaForm() {
  const form = $("#idea-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError(form);
    const button = $("button[type=submit]", form);
    const person_id = Number(form.elements.person_id.value);
    const idea = form.elements.idea.value.trim();
    const link = form.elements.link.value.trim();
    const priceRaw = form.elements.price.value.trim();
    if (!person_id) { showError(form, "Pick who it's for."); return; }
    if (!idea) { showError(form, "Write the idea."); form.elements.idea.focus(); return; }
    const price = priceRaw === "" ? null : Number(priceRaw);
    if (price !== null && (!Number.isFinite(price) || price < 0)) { showError(form, "The price should be a number."); return; }
    button.disabled = true;
    try {
      await call("add_gift", {
        person_id, idea, today: localToday(),
        ...(link ? { link } : {}),
        ...(price !== null ? { price } : {}),
      });
      lastPersonId = person_id;
      form.elements.idea.value = "";
      form.elements.link.value = "";
      form.elements.price.value = "";
      const who = people.find((p) => p.id === person_id)?.name ?? "them";
      toast(`Saved for ${who}`);
      await refresh();
      form.elements.idea.focus();
    } catch (err) {
      showError(form, err.message);
    } finally {
      button.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- person sheet

const dialog = $("#person-dialog");
let openId = null;

function bindLists() {
  const openFrom = (e) => {
    const el = e.target.closest("[data-person]");
    if (el) openPerson(Number(el.dataset.person));
  };
  for (const id of ["#upcoming", "#people", "#ring-wrap", "#later"]) {
    const root = $(id);
    root.addEventListener("click", openFrom);
    root.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-person]")) { e.preventDefault(); openFrom(e); }
    });
  }
  dialog.addEventListener("close", () => {
    openId = null;
    currentPerson = null;
    if (location.hash.startsWith("#person-")) history.replaceState(null, "", location.pathname + location.search);
  });
}

async function openPerson(id) {
  openId = id;
  if (location.hash !== `#person-${id}`) history.replaceState(null, "", `#person-${id}`);
  $("#pd-body").innerHTML = `<span class="skeleton" style="height: 28px; width: 50%"></span>
    <span class="skeleton" style="height: 120px; margin-top: 16px"></span>`;
  if (!dialog.open) dialog.showModal();
  await renderPerson(id);
}

const occasionLabel = (o) => (o === "birthday" ? "Birthday" : o === "christmas" ? "Christmas Eve" : "Other");

async function renderPerson(id, keep = {}) {
  let data;
  try {
    data = await call("get_person", { id, today: localToday() }, 2);
    data.prepared = (await call("get_prepared", { person_id: id })).prepared;
  } catch (err) {
    $("#pd-body").innerHTML = `<div class="notice danger">${esc(err.message)}</div>
      <div class="actions"><button type="button" data-close>Close</button></div>`;
    $("[data-close]", dialog).addEventListener("click", () => dialog.close());
    return;
  }
  if (openId !== id) return;
  const p = data.person;
  const next = data.next_occasion;
  const nb = data.next_birthday;

  const facts = [];
  if (p.relation) facts.push(`<div><dt>Relation</dt><dd>${esc(p.relation)}</dd></div>`);
  if (p.birthday) facts.push(`<div><dt>Birthday</dt><dd>${esc(formatBirthday(p.birthday))}${nb && nb.turning ? `<small>turns ${nb.turning}</small>` : ""}</dd></div>`);
  if (next) facts.push(`<div><dt>Next up</dt><dd>${esc(next.name)}<small>${daysText(next.days_until)}</small></dd></div>`);

  const giftRow = (g, buttons) => {
    const sub = [];
    if (g.status !== "idea" || g.occasion !== "other") sub.push(occasionLabel(g.occasion));
    if (g.year && g.status !== "given") sub.push(String(g.year));
    const link = g.link ? ` <a href="${esc(g.link)}" target="_blank" rel="noopener noreferrer">Link</a>` : "";
    const state = g.status === "idea" ? "g-ideas" : g.status === "bought" ? "g-bought" : "g-given";
    return `<li>
      ${box(state)}
      <div class="grow"><span>${esc(g.idea)}${link}</span>${sub.length ? `<span class="sub">${esc(sub.join(" "))}</span>` : ""}</div>
      ${g.price !== null && g.price !== undefined ? `<span class="price">${numFmt.format(g.price)}</span>` : ""}
      <div class="actions-inline">${buttons}</div>
    </li>`;
  };
  const delBtn = (g) => `<button type="button" class="ghost sm danger" data-del="${g.id}" aria-label="Delete ${esc(g.idea)}">Delete</button>`;

  const ideas = data.ideas.length
    ? `<ul class="gifts">${data.ideas.map((g) => giftRow(g, `<button type="button" class="sm" data-status="bought" data-gift="${g.id}">Bought</button>${delBtn(g)}`)).join("")}</ul>`
    : `<p class="empty-line">No ideas yet. Ask for suggestions, or jot one down on the main page.</p>`;
  const bought = data.bought.length
    ? `<section><h3>Bought</h3><ul class="gifts">${data.bought.map((g) => giftRow(g, `<button type="button" class="sm" data-status="given" data-gift="${g.id}">Given</button>${delBtn(g)}`)).join("")}</ul></section>`
    : "";
  const given = data.given_by_year.length
    ? `<section><h3>Given before</h3>${data.given_by_year.map((y) => `
        <div class="year-head">${y.year ?? "Earlier"}</div>
        <ul class="gifts">${y.gifts.map((g) => giftRow(g, delBtn(g))).join("")}</ul>`).join("")}</section>`
    : "";
  const prepared = data.prepared.flatMap((r) => r.suggestions);

  $("#pd-body").innerHTML = `
    <div class="dialog-head">
      <span class="avatar" aria-hidden="true">${esc([...p.name.trim()][0]?.toUpperCase() ?? "?")}</span>
      <h2 id="pd-name">${esc(p.name)}</h2>
      <button type="button" class="ghost sm" data-close>Close</button>
    </div>
    ${facts.length ? `<dl class="facts">${facts.join("")}</dl>` : ""}
    <div class="form-actions"><button type="button" class="sm" data-edit>Edit details</button></div>
    <form id="details-form" class="hidden" novalidate>
      <div class="two">
        <label class="field"><span class="label">Name</span><input type="text" name="name" required maxlength="100" value="${esc(p.name)}"></label>
        <label class="field"><span class="label">Relation</span><input type="text" name="relation" maxlength="100" value="${esc(p.relation ?? "")}"></label>
      </div>
      <div class="field-label" style="margin-top: var(--s3)">Birthday</div>
      <div class="birthday" data-birthday></div>
      <div class="notice danger hidden" data-error style="margin-top: var(--s3)"></div>
      <div class="form-actions"><button type="submit" class="sm primary">Save</button><button type="button" class="ghost sm" data-cancel>Cancel</button></div>
    </form>

    <section>
      <div class="sec-head"><h3>Ideas</h3>
        <button type="button" class="sm primary" id="suggest">Suggest ideas</button></div>
      ${ideas}
      <div id="prepared">${prepared.length ? `<ul class="gifts suggest">${prepared.map((s, i) => `<li class="suggestion">${box("g-none")}<div class="grow"><span>${esc(s.idea)}</span><span class="sub">${esc(s.why)}</span></div><div class="actions-inline"><button type="button" class="sm" data-save-prepared="${i}">Save idea</button></div></li>`).join("")}</ul>` : ""}</div>
      <div id="suggestions"></div>
    </section>
    ${bought}
    ${given}

    <section>
      <h3>Notes</h3>
      <form id="wish-form">
        <div class="two">
          <label class="field"><span class="label">Something they said or wished for</span><input name="text" required maxlength="1000" placeholder="e.g. Wants a new rain jacket"></label>
          <label class="field"><span class="label">Date</span><input name="date" type="date" required value="${localToday()}"></label>
        </div>
        <div class="notice danger hidden" data-error></div>
        <button type="submit" class="sm">Add note</button>
      </form>
      ${data.notes_log.length ? `<ul class="gifts">${data.notes_log.map((n) => `<li><div class="grow"><span>${esc(n.text)}</span><span class="sub">${esc(noteDateFmt.format(new Date(n.date + "T12:00:00")))}</span></div><div class="actions-inline"><button type="button" class="ghost sm danger" data-delete-note="${n.id}">Delete</button></div></li>`).join("")}</ul>` : ""}
      <div id="note-error" class="notice danger hidden"></div>
      <form id="notes-form" novalidate>
        <label class="field"><span class="label">Interests, sizes, wishes</span>
          <textarea name="notes" maxlength="5000" placeholder="Loves hiking, shoe size 39">${esc(keep.notes ?? p.notes)}</textarea>
        </label>
        <div class="notice danger hidden" data-error></div>
        <div class="form-actions"><button type="submit" class="sm">Save notes</button></div>
      </form>
    </section>

    <section class="danger-zone">
      <div id="delete-zone"><button type="button" class="ghost danger sm" id="delete-person">Delete ${esc(p.name)}</button></div>
    </section>`;

  $("[data-close]", dialog).addEventListener("click", () => dialog.close());
  bindNotes(p);
  const wish = $("#wish-form");
  wish.addEventListener("submit", async (e) => {
    e.preventDefault(); clearError(wish);
    const b = $("button", wish); b.disabled = true;
    try {
      await call("add_note", { person_id: p.id, text: wish.elements.text.value, date: wish.elements.date.value });
      await renderPerson(p.id, { notes: $("#notes-form").elements.notes.value });
      $("#wish-form").elements.text.focus();
    } catch (err) { showError(wish, err.message); b.disabled = false; }
  });
  dialog.querySelectorAll("[data-delete-note]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this dated note permanently?")) return;
    b.disabled = true;
    try { await call("delete_note", { id: Number(b.dataset.deleteNote) }); await renderPerson(p.id, { notes: $("#notes-form").elements.notes.value }); }
    catch (err) { b.disabled = false; const box = $("#note-error"); box.textContent = err.message; box.classList.remove("hidden"); }
  }));
  dialog.querySelectorAll("[data-save-prepared]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await call("save_suggestion", { person_id: p.id, ...prepared[Number(b.dataset.savePrepared)] });
      await Promise.all([renderPerson(p.id, { notes: $("#notes-form").elements.notes.value }), refresh()]);
      toast("Idea saved");
    } catch (err) { b.disabled = false; toast(err.message); }
  }));
  bindDetails(p);
  currentPerson = p;
  bindSuggest(p);
  bindDeletePerson(p, data);
}

function bindNotes(p) {
  const form = $("#notes-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError(form);
    const button = $("button[type=submit]", form);
    button.disabled = true;
    try {
      await call("update_person", { id: p.id, notes: form.elements.notes.value });
      toast("Notes saved");
    } catch (err) {
      showError(form, err.message);
    } finally {
      button.disabled = false;
    }
  });
  $("[data-edit]", dialog).addEventListener("click", () => {
    const details = $("#details-form");
    birthdayFields($("[data-birthday]", details), p.birthday ?? "");
    details.classList.remove("hidden");
    details.elements.name.focus();
  });
}

function bindDetails(p) {
  const form = $("#details-form");
  $("[data-cancel]", form).addEventListener("click", () => { clearError(form); form.classList.add("hidden"); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearError(form);
    const name = form.elements.name.value.trim();
    if (!name) { showError(form, "Write a name."); return; }
    let birthday;
    try { birthday = readBirthday(form); } catch (err) { showError(form, err.message); return; }
    const button = $("button[type=submit]", form);
    button.disabled = true;
    try {
      await call("update_person", { id: p.id, name, relation: form.elements.relation.value.trim() || null, birthday: birthday || null });
      toast("Saved");
      await Promise.all([renderPerson(p.id, { notes: $("#notes-form").elements.notes.value }), refresh()]);
    } catch (err) {
      showError(form, err.message);
      button.disabled = false;
    }
  });
}

let currentPerson = null;

// Bound once: the sheet body is re-rendered, the listener stays.
function bindGiftButtons() {
  $("#pd-body").addEventListener("click", async (e) => {
    const p = currentPerson;
    if (!p) return;
    const statusBtn = e.target.closest("[data-status]");
    const delBtn = e.target.closest("[data-del]");
    if (statusBtn) {
      statusBtn.disabled = true;
      const status = statusBtn.dataset.status;
      try {
        await call("update_gift", { id: Number(statusBtn.dataset.gift), status });
        toast(status === "bought" ? "Marked as bought" : "Marked as given");
        await Promise.all([renderPerson(p.id, { notes: $("#notes-form").elements.notes.value }), refresh()]);
      } catch (err) {
        statusBtn.disabled = false;
        toast(err.message);
      }
    } else if (delBtn) {
      delBtn.disabled = true;
      const id = Number(delBtn.dataset.del);
      try {
        const before = await findGift(p.id, id);
        await call("delete_gift", { id });
        await Promise.all([renderPerson(p.id, { notes: $("#notes-form").elements.notes.value }), refresh()]);
        toast(`Deleted "${before?.idea ?? "gift"}"`, before ? {
          label: "Undo",
          run: async () => {
            try {
              await call("add_gift", {
                person_id: before.person_id, idea: before.idea, occasion: before.occasion, status: before.status,
                ...(before.link ? { link: before.link } : {}),
                ...(before.price !== null ? { price: before.price } : {}),
                ...(before.year !== null ? { year: before.year } : {}),
              });
              if (openId === p.id) await renderPerson(p.id);
              await refresh();
            } catch (err) {
              toast(err.message);
            }
          },
        } : undefined);
      } catch (err) {
        delBtn.disabled = false;
        toast(err.message);
      }
    }
  });
}

async function findGift(personId, giftId) {
  const d = await call("get_person", { id: personId, today: localToday() });
  const all = [...d.ideas, ...d.bought, ...d.given_by_year.flatMap((y) => y.gifts)];
  return all.find((g) => g.id === giftId) ?? null;
}

function bindSuggest(p) {
  const btn = $("#suggest");
  btn.addEventListener("click", async () => {
    const box = $("#suggestions");
    btn.disabled = true;
    box.innerHTML = `<span class="skeleton" style="height: 18px; margin-top: 12px"></span>
      <span class="skeleton" style="height: 18px; margin-top: 8px; width: 80%"></span>
      <span class="skeleton" style="height: 18px; margin-top: 8px; width: 60%"></span>`;
    try {
      const r = await call("suggest_gifts", { person_id: p.id, today: localToday() });
      if (!r.suggestions.length) {
        box.innerHTML = `<p class="empty-line">No new ideas this time. Adding more to the notes helps.</p>`;
        return;
      }
      box.innerHTML = `<div class="year-head">Suggestions</div>
        <ul class="gifts suggest">${r.suggestions.map((s, i) => `<li class="suggestion">
          ${boxSvg("g-none")}
          <div class="grow"><span>${esc(s.idea)}</span>${s.why ? `<span class="sub">${esc(s.why)}</span>` : ""}</div>
          <div class="actions-inline"><button type="button" class="sm" data-add-suggestion="${i}">Save idea</button></div>
        </li>`).join("")}</ul>`;
      box.querySelectorAll("[data-add-suggestion]").forEach((b) => {
        b.addEventListener("click", async (e) => {
          e.stopPropagation();
          const s = r.suggestions[Number(b.dataset.addSuggestion)];
          b.disabled = true;
          try {
            await call("add_gift", { person_id: p.id, idea: s.idea, today: localToday() });
            b.textContent = "Added";
            toast(`Saved "${s.idea}"`);
            refresh().catch(() => {});
          } catch (err) {
            b.disabled = false;
            toast(err.message);
          }
        });
      });
    } catch (err) {
      box.innerHTML = `<div class="notice danger" style="margin-top: 12px">${esc(err.message)}</div>`;
    } finally {
      btn.disabled = false;
    }
  });
}

// `box` is shadowed by local variables in some handlers; this alias keeps the glyph reachable.
const boxSvg = box;

function bindDeletePerson(p, data) {
  const zone = $("#delete-zone");
  $("#delete-person").addEventListener("click", () => {
    const n = data.ideas.length + data.bought.length + data.given_by_year.reduce((s, y) => s + y.gifts.length, 0);
    zone.innerHTML = `<div class="notice danger">
        <div class="stack" style="flex: 1">
          <span>Delete ${esc(p.name)}${n ? ` and ${n} ${n === 1 ? "gift" : "gifts"} (ideas and history)` : ""}? This can't be undone.</span>
          <div class="row"><button type="button" class="danger solid sm" id="confirm-delete">Delete</button>
          <button type="button" class="ghost sm" id="cancel-delete">Cancel</button></div>
        </div>
      </div>`;
    $("#cancel-delete").addEventListener("click", () => {
      zone.innerHTML = `<button type="button" class="ghost danger sm" id="delete-person">Delete ${esc(p.name)}</button>`;
      bindDeletePerson(p, data);
    });
    const confirmBtn = $("#confirm-delete");
    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      try {
        await call("delete_person", { id: p.id });
        dialog.close();
        toast(`Deleted ${p.name}`);
        await refresh();
      } catch (err) {
        confirmBtn.disabled = false;
        toast(err.message);
      }
    });
  });
}

// ---------------------------------------------------------------- start

bindFirstForm();
bindPersonForm();
bindIdeaForm();
bindLists();
bindGiftButtons();

refresh()
  .then(() => {
    const m = /^#person-(\d+)$/.exec(location.hash);
    if (m && people.some((p) => p.id === Number(m[1]))) openPerson(Number(m[1]));
    else if (people.length) $("#idea-form").elements.idea.focus({ preventScroll: true });
  })
  .catch((err) => {
    $("#loading").classList.add("hidden");
    const box = $("#load-error");
    box.textContent = err.message;
    box.classList.remove("hidden");
  });
