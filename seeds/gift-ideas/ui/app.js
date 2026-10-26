// SPDX-License-Identifier: Apache-2.0
// Gift ideas UI: upcoming occasions, quick "Add idea", people and a person sheet.

const WINDOW_DAYS = 90;

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
const monthDayFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", timeZone: "UTC" });
const numFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const MONTHS = Array.from({ length: 12 }, (_, i) =>
  new Intl.DateTimeFormat(undefined, { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2000, i, 1))));

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

function readyPill(u) {
  if (u.ready === "bought") return `<span class="pill ok with-dot">Bought</span>`;
  if (u.ready === "ideas") return `<span class="pill accent">${u.idea_count} ${u.idea_count === 1 ? "idea" : "ideas"}</span>`;
  return `<span class="pill ${u.days_until <= 21 ? "warn" : ""}">Nothing yet</span>`;
}

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

async function refresh() {
  const today = localToday();
  const [list, up, stored] = await Promise.all([
    call("list_people", { today }),
    call("upcoming", { today, days: WINDOW_DAYS }),
    call("get_prepared"),
  ]);
  people = list.people;
  $("#loading").classList.add("hidden");
  $("#load-error").classList.add("hidden");
  if (people.length === 0) {
    $("#main").classList.add("hidden");
    $("#first-run").classList.remove("hidden");
    birthdayFieldsOnce($("#first-form"));
    $("#first-form").elements.name.focus();
    return;
  }
  $("#first-run").classList.add("hidden");
  $("#main").classList.remove("hidden");
  renderUpcoming(up.occasions.map((u) => ({ ...u, suggestion_count: stored.prepared.find((r) => r.person_id === u.person_id && r.date === u.date)?.suggestions.length ?? 0 })));
  renderPeople();
  renderPersonPicker();
}

function birthdayFieldsOnce(form) {
  const box = $("[data-birthday]", form);
  if (!box.firstElementChild) birthdayFields(box, "");
}

function renderUpcoming(list) {
  const ul = $("#upcoming");
  $("#window-note").textContent = `Next ${WINDOW_DAYS} days`;
  if (list.length === 0) {
    ul.innerHTML = `<li><span class="muted">Nothing in the next ${WINDOW_DAYS} days.</span></li>`;
    return;
  }
  ul.innerHTML = list.slice(0, 8).map((u) => {
    const who = u.person_name ? `${esc(u.person_name)} <span class="muted">· ${esc(u.name)}</span>` : esc(u.name);
    const turning = u.turning ? ` · turns ${u.turning}` : "";
    const attrs = u.person_id ? `class="link" tabindex="0" role="button" data-person="${u.person_id}"` : "";
    return `<li ${attrs}>
      <div class="grow"><span>${who}</span><span class="sub">${esc(formatDate(u.date))}${turning}</span>${u.ready === "none" && u.days_until <= 21 && u.suggestion_count ? `<span class="sub">${u.suggestion_count} suggestions ready</span>` : ""}</div>
      ${u.person_id ? readyPill(u) : ""}
      <span class="days when">${daysText(u.days_until)}</span>
    </li>`;
  }).join("");
}

function renderPeople() {
  $("#people").innerHTML = people.map((p) => {
    const next = p.next_occasion;
    const bits = [];
    if (p.relation) bits.push(esc(p.relation));
    if (next) bits.push(`${esc(next.name)} ${daysText(next.days_until)}`);
    const counts = [];
    if (p.idea_count) counts.push(`${p.idea_count} ${p.idea_count === 1 ? "idea" : "ideas"}`);
    if (p.bought_count) counts.push(`${p.bought_count} bought`);
    return `<li class="link" tabindex="0" role="button" data-person="${p.id}">
      <div class="grow"><span>${esc(p.name)}</span><span class="sub">${bits.join(" · ")}</span></div>
      <span class="days">${counts.join(" · ") || "no ideas yet"}</span>
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
    const li = e.target.closest("[data-person]");
    if (li) openPerson(Number(li.dataset.person));
  };
  for (const id of ["#upcoming", "#people"]) {
    const ul = $(id);
    ul.addEventListener("click", openFrom);
    ul.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openFrom(e); }
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
  if (p.relation) facts.push(esc(p.relation));
  if (p.birthday) facts.push(`Birthday ${esc(formatBirthday(p.birthday))}${nb && nb.turning ? ` (turns ${nb.turning})` : ""}`);
  if (next) facts.push(`${esc(next.name)} ${daysText(next.days_until)}`);

  const giftRow = (g, buttons) => {
    const meta = [];
    if (g.price !== null) meta.push(numFmt.format(g.price));
    if (g.status !== "idea" || g.occasion !== "other") meta.push(g.occasion === "birthday" ? "Birthday" : g.occasion === "christmas" ? "Christmas" : "Other");
    if (g.year && g.status !== "given") meta.push(String(g.year));
    const link = g.link ? ` <a href="${esc(g.link)}" target="_blank" rel="noopener noreferrer">Link</a>` : "";
    return `<li>
      <div class="grow"><span>${esc(g.idea)}${link}</span>${meta.length ? `<span class="sub">${meta.join(" · ")}</span>` : ""}</div>
      <div class="actions-inline">${buttons}</div>
    </li>`;
  };
  const delBtn = (g) => `<button type="button" class="ghost sm danger" data-del="${g.id}" aria-label="Delete ${esc(g.idea)}">Delete</button>`;

  const ideas = data.ideas.length
    ? `<ul class="list">${data.ideas.map((g) => giftRow(g, `<button type="button" class="sm" data-status="bought" data-gift="${g.id}">Bought</button>${delBtn(g)}`)).join("")}</ul>`
    : `<p class="muted small">No ideas yet.</p>`;
  const bought = data.bought.length
    ? `<section><div class="eyebrow">Bought</div><ul class="list">${data.bought.map((g) => giftRow(g, `<button type="button" class="sm" data-status="given" data-gift="${g.id}">Given</button>${delBtn(g)}`)).join("")}</ul></section>`
    : "";
  const given = data.given_by_year.length
    ? `<section><div class="eyebrow">Given before</div>${data.given_by_year.map((y) => `
        <div class="small muted year-head">${y.year ?? "Earlier"}</div>
        <ul class="list">${y.gifts.map((g) => giftRow(g, delBtn(g))).join("")}</ul>`).join("")}</section>`
    : "";

  $("#pd-body").innerHTML = `
    <div class="dialog-head">
      <div><h2 id="pd-name">${esc(p.name)}</h2><div class="muted small">${facts.join(" · ")}</div></div>
      <button type="button" class="ghost sm" data-close>Close</button>
    </div>

    <section>
      <form id="wish-form">
        <div class="two">
          <label class="field"><span class="label">Add note</span><input name="text" required maxlength="1000" placeholder="Something they said or wished for"></label>
          <label class="field"><span class="label">Date</span><input name="date" type="date" required value="${localToday()}"></label>
        </div>
        <div class="notice danger hidden" data-error></div>
        <button type="submit">Add note</button>
      </form>
      <ul class="list">${data.notes_log.map((n) => `<li><div class="grow"><span>${esc(n.text)}</span><span class="sub">${esc(new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(n.date + "T12:00:00")))}</span></div><button type="button" class="ghost danger" data-delete-note="${n.id}">Delete</button></li>`).join("")}</ul>
      <div id="note-error" class="notice danger hidden"></div>
      <form id="notes-form" novalidate>
        <label class="field"><span class="label">Notes</span>
          <textarea name="notes" maxlength="5000" placeholder="Interests, sizes, wishes">${esc(keep.notes ?? p.notes)}</textarea>
        </label>
        <div class="notice danger hidden" data-error></div>
        <div class="form-actions"><button type="submit" class="sm">Save notes</button><button type="button" class="ghost sm" data-edit>Edit details</button></div>
      </form>
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
    </section>

    <section>
      <div class="row between"><span class="eyebrow">Ideas</span>
        <button type="button" class="sm primary" id="suggest">Suggest ideas</button></div>
      ${ideas}
      <div id="prepared"><ul class="list">${data.prepared.flatMap((r) => r.suggestions).map((s, i) => `<li class="suggestion"><div class="grow"><span>${esc(s.idea)}</span><span class="sub">${esc(s.why)}</span></div><button type="button" data-save-prepared="${i}">Save idea</button></li>`).join("")}</ul></div>
      <div id="suggestions"></div>
    </section>
    ${bought}
    ${given}

    <section>
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
  const suggestions = data.prepared.flatMap((r) => r.suggestions);
  dialog.querySelectorAll("[data-save-prepared]").forEach((b) => b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await call("save_suggestion", { person_id: p.id, ...suggestions[Number(b.dataset.savePrepared)] });
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
  $("[data-edit]", form).addEventListener("click", () => {
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
        box.innerHTML = `<p class="muted small" style="margin-top: 12px">No new ideas this time. Adding more to the notes helps.</p>`;
        return;
      }
      box.innerHTML = `<div class="eyebrow" style="margin-top: 16px">Suggestions</div>
        <ul class="list">${r.suggestions.map((s, i) => `<li class="suggestion">
          <div class="grow"><span>${esc(s.idea)}</span>${s.why ? `<span class="sub">${esc(s.why)}</span>` : ""}</div>
           <button type="button" class="sm" data-add-suggestion="${i}">Save idea</button>
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
    else if (people.length) $("#idea-form").elements.idea.focus();
  })
  .catch((err) => {
    $("#loading").classList.add("hidden");
    const box = $("#load-error");
    box.textContent = err.message;
    box.classList.remove("hidden");
  });
