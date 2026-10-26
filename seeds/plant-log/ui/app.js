// SPDX-License-Identifier: Apache-2.0
// Plant Log UI: what needs water today, then every plant by window.

const app = document.getElementById("app");
const toasts = document.getElementById("toasts");
const datalist = document.getElementById("locations");

async function call(operation, input = {}) {
  let body;
  try {
    const r = await fetch("/api/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hewn-ui": "1" },
      body: JSON.stringify({ operation, input }),
    });
    body = await r.json();
  } catch {
    throw new Error("Couldn't reach Plant Log. Check your connection and try again.");
  }
  if (!body || body.error || !("result" in body)) {
    throw new Error((body && (body.message || body.error)) || "Something went wrong. Try again.");
  }
  return body.result;
}

const state = {
  list: null, // list_plants result
  plant: null, // get_plant result
  filter: "", // location filter ("" = all)
  addOpen: false,
  unchecked: new Set(), // due plants the owner unticked
  lastAdd: { location: "", water: 7 },
};

// ---------- formatting ----------

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function span(n) {
  if (n < 60) return plural(n, "day");
  if (n < 365) return `${Math.round(n / 30)} months`;
  const y = Math.round(n / 365);
  return plural(y, "year");
}

function ago(n) {
  if (n === null || n === undefined) return "";
  if (n < 0) return until(-n);
  if (n === 0) return "today";
  if (n === 1) return "yesterday";
  return `${span(n)} ago`;
}

function until(n) {
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  return `in ${span(n)}`;
}

function late(p) {
  if (p.status === "today") return "today";
  if (p.days_overdue === 1) return "1 day late";
  return `${span(p.days_overdue)} late`;
}

function dateLabel(iso, today) {
  const [y, m, d] = iso.split("-").map(Number);
  const sameYear = today && today.slice(0, 4) === iso.slice(0, 4);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function daysBetween(a, b) {
  const n = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
  };
  return Math.round(n(b) - n(a));
}

const EVENT_LABEL = { watered: "Watered", fed: "Fed", repotted: "Repotted", note: "Note" };

const MAX_PHOTO_BYTES = 30 * 1024 * 1024;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That image couldn't be read. Try a JPEG or PNG photo."));
    img.src = src;
  });
}

async function downscalePhoto(file) {
  if (!file.type || !file.type.startsWith("image/")) {
    throw new Error("That file isn't a photo. Choose an image.");
  }
  if (file.size > MAX_PHOTO_BYTES) {
    throw new Error("That photo is too large (over 30 MB). Try a smaller one.");
  }
  let bitmap = null;
  let fallback = null;
  try {
    if (typeof createImageBitmap === "function") {
      try {
        bitmap = await createImageBitmap(file);
      } catch {
        bitmap = null;
      }
    }
    if (!bitmap) {
      const url = URL.createObjectURL(file);
      try {
        fallback = await loadImage(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const img = bitmap || fallback;
    const w = img.width || img.naturalWidth;
    const h = img.height || img.naturalHeight;
    const longest = Math.max(w, h);
    const scale = longest ? Math.min(1, 1280 / longest) : 1;
    const width = Math.max(1, Math.round(w * scale));
    const height = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("This browser couldn't prepare the photo. Try another one.");
    g.fillStyle = "white";
    g.fillRect(0, 0, width, height);
    g.drawImage(img, 0, 0, width, height);
    let data = canvas.toDataURL("image/jpeg", 0.82);
    let image = data.slice(data.indexOf(",") + 1);
    if (image.length * 0.75 > 4.5 * 1024 * 1024) {
      data = canvas.toDataURL("image/jpeg", 0.55);
      image = data.slice(data.indexOf(",") + 1);
    }
    return { image, media_type: "image/jpeg" };
  } finally {
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
  }
}

async function identifyPhoto(file, resultsEl) {
  resultsEl.innerHTML = `<div class="skeleton" style="height: 64px"></div>`;
  try {
    const payload = await downscalePhoto(file);
    return await call("identify_plant", payload);
  } catch (e) {
    resultsEl.innerHTML = "";
    throw e;
  }
}

function showCandidates(resultsEl, errorEl, res, onPick) {
  if (res.not_a_plant) {
    resultsEl.innerHTML = `<div class="notice info">That photo doesn't look like a plant. Try a photo of the whole plant in good light.</div>`;
    return;
  }
  const candidates = Array.isArray(res.candidates) ? res.candidates : [];
  if (!candidates.length) {
    resultsEl.innerHTML = `<div class="notice info">Couldn't tell which plant this is. Try a clearer photo.</div>`;
    return;
  }
  resultsEl.innerHTML = `
    <div class="candidates">
      <div class="eyebrow">Likely plants</div>
      <ul class="list">${candidates
        .map((c, i) => {
          const pct = Math.round(c.confidence * 100);
          const feed = c.feed_every_days ? ` · feed every ${c.feed_every_days} days` : "";
          return `
          <li>
            <span class="grow">
              <span class="name">${esc(c.common_name)} <span class="pill ${pct < 50 ? "warn" : "ok"}">${pct}%</span></span>
              ${c.species ? `<span class="sub">${esc(c.species)}</span>` : ""}
              ${c.care_note ? `<span class="sub">${esc(c.care_note)}</span>` : ""}
              <span class="sub">Water every ${c.water_every_days} days${feed}</span>
            </span>
            <button type="button" class="sm" data-pick="${i}">Use</button>
          </li>`;
        })
        .join("")}</ul>
    </div>`;
  resultsEl.querySelectorAll("[data-pick]").forEach((b) => {
    b.addEventListener("click", async () => {
      const c = candidates[Number(b.dataset.pick)];
      b.disabled = true;
      errorEl.hidden = true;
      try {
        const message = await onPick(c, b);
        if (message && resultsEl.isConnected) resultsEl.innerHTML = `<div class="notice ok">${esc(message)}</div>`;
      } catch (e) {
        showError(errorEl, e.message);
      } finally {
        if (b.isConnected) b.disabled = false;
      }
    });
  });
}

function wirePhotoIdentify(button, input, resultsEl, errorEl, onPick) {
  button.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    input.value = "";
    if (!file) return;
    errorEl.hidden = true;
    await busy(button, async () => {
      try {
        const res = await identifyPhoto(file, resultsEl);
        showCandidates(resultsEl, errorEl, res, onPick);
      } catch (e) {
        showError(errorEl, e.message);
      }
    });
  });
}

// ---------- feedback ----------

function toast(message, action) {
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.innerHTML = `<span>${esc(message)}</span>`;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sm";
    b.textContent = action.label;
    b.addEventListener("click", () => {
      el.remove();
      action.run();
    });
    el.append(b);
  }
  toasts.append(el);
  setTimeout(() => el.remove(), action ? 7000 : 3500);
}

function showError(el, message) {
  if (!el) return toast(message);
  el.textContent = message;
  el.hidden = false;
}

const dialog = document.getElementById("confirm");
function confirmDelete(title, text, yes = "Delete") {
  document.getElementById("confirm-title").textContent = title;
  document.getElementById("confirm-text").textContent = text;
  document.getElementById("confirm-yes").textContent = yes;
  return new Promise((resolve) => {
    const done = (answer) => {
      dialog.removeEventListener("close", onClose);
      dialog.removeEventListener("click", onClick);
      if (dialog.open) dialog.close();
      resolve(answer);
    };
    const onClose = () => done(false);
    const onClick = (e) => {
      const b = e.target.closest("[data-answer]");
      if (b) done(b.dataset.answer === "yes");
    };
    dialog.addEventListener("close", onClose);
    dialog.addEventListener("click", onClick);
    dialog.showModal();
  });
}

async function busy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } finally {
    if (button && button.isConnected) button.disabled = false;
  }
}

// ---------- routing ----------

function route() {
  const m = location.hash.match(/^#plant-(\d+)$/);
  return m ? { name: "plant", id: Number(m[1]) } : { name: "home" };
}

async function show() {
  const r = route();
  try {
    if (r.name === "plant") {
      const [plant, list] = await Promise.all([call("get_plant", { id: r.id }), call("list_plants")]);
      state.plant = plant;
      state.list = list;
      renderPlant();
    } else {
      state.list = await call("list_plants");
      renderHome();
    }
    fillLocations();
  } catch (e) {
    app.innerHTML = `
      <div class="notice danger"><p>${esc(e.message)}</p></div>
      <div class="row"><a class="btn" href="#">Back to all plants</a><button type="button" data-action="retry">Try again</button></div>`;
  } finally {
    app.removeAttribute("aria-busy");
  }
}

function fillLocations() {
  datalist.innerHTML = (state.list?.locations ?? []).map((l) => `<option value="${esc(l)}"></option>`).join("");
}

// ---------- home ----------

function addFormHtml(today, firstPlant) {
  return `
  <form class="card" id="add-form" novalidate>
    <div class="row between">
      <h2>${firstPlant ? "Your first plant" : "Add a plant"}</h2>
      <button type="button" class="ghost sm" data-action="identify-add">Identify from photo</button>
    </div>
    <input type="file" accept="image/*" capture="environment" data-photo="add" hidden>
    <div id="identify-results" aria-live="polite"></div>
    <div class="notice danger" id="identify-error" hidden></div>
    <label class="field"><span class="label">Name</span>
      <input type="text" name="name" required maxlength="80" placeholder="Monstera" autocomplete="off"></label>
    <div class="two">
      <label class="field"><span class="label">Window or room</span>
        <input type="text" name="location" list="locations" maxlength="80" placeholder="Kitchen window" value="${esc(state.lastAdd.location)}" autocomplete="off"></label>
      <label class="field"><span class="label">Species</span>
        <input type="text" name="species" maxlength="120" placeholder="Monstera deliciosa" autocomplete="off"></label>
    </div>
    <div class="two">
      <label class="field"><span class="label">Water every (days)</span>
        <input type="number" name="water_every_days" required min="1" max="3650" step="1" value="${state.lastAdd.water}"></label>
      <label class="field"><span class="label">Feed every (days)</span>
        <input type="number" name="feed_every_days" min="1" max="3650" step="1" placeholder="Not tracked"></label>
    </div>
    <label class="field"><span class="label">Last watered</span>
      <input type="date" name="last_watered" value="${esc(today)}" max="${esc(today)}">
      <span class="hint">Leave empty if you don't know: it will be due today.</span></label>
    <label class="field"><span class="label">Notes</span>
      <textarea name="notes" maxlength="500" rows="2" placeholder="Light, watering, anything to remember"></textarea></label>
    <div class="notice danger" id="add-error" hidden></div>
    <div class="actions">
      ${firstPlant ? "" : `<button type="button" class="ghost" data-action="close-add">Cancel</button>`}
      <button type="submit" class="primary">Add plant</button>
    </div>
  </form>`;
}

function dueHtml(list) {
  const due = list.plants.filter((p) => p.status === "overdue" || p.status === "today");
  if (!due.length) {
    const next = list.plants.find((p) => p.status === "ok");
    return `
    <section class="card" id="due">
      <div class="eyebrow">Needs water today</div>
      <p class="muted" style="margin: var(--s2) 0 0">All watered.${next ? ` Next: ${esc(next.name)}, ${until(next.days_until)}.` : ""}</p>
    </section>`;
  }
  const checked = due.filter((p) => !state.unchecked.has(p.id)).length;
  const rows = due
    .map((p) => {
      const where = [p.location, p.last_watered ? `watered ${ago(p.watered_days_ago)}` : "never watered"].filter(Boolean).join(" · ");
      return `
      <li class="${p.status === "overdue" ? "late" : ""}">
        <label>
          <input type="checkbox" data-due="${p.id}" ${state.unchecked.has(p.id) ? "" : "checked"}>
          <span class="grow"><span class="name">${esc(p.name)}</span><span class="sub">${esc(where)}</span></span>
          <span class="pill ${p.status === "overdue" ? "bad" : "warn"}">${esc(late(p))}</span>
        </label>
        <a class="btn ghost icon-only" href="#plant-${p.id}" aria-label="Open ${esc(p.name)}">›</a>
      </li>`;
    })
    .join("");
  return `
  <section class="card" id="due">
    <div class="row between"><span class="eyebrow">Needs water today</span><span class="muted small">${plural(due.length, "plant")}</span></div>
    <ul class="list due-list">${rows}</ul>
    <div class="row" style="margin-top: var(--s3)">
      <button type="button" class="primary" data-action="water-selected" ${checked ? "" : "disabled"}>Watered selected${checked ? ` (${checked})` : ""}</button>
      <button type="button" class="ghost" data-action="toggle-all">${checked === due.length ? "Select none" : "Select all"}</button>
    </div>
    <div class="notice danger" id="water-error" hidden></div>
  </section>`;
}

function plantRowHtml(p) {
  const watered = p.last_watered ? `Watered ${ago(p.watered_days_ago)}` : "Never watered";
  const extra = p.feed_status === "overdue" || p.feed_status === "today" ? " · feed due" : "";
  const pill =
    p.status === "ok"
      ? `<span class="pill">${esc(until(p.days_until))}</span>`
      : `<span class="pill ${p.status === "overdue" ? "bad" : "warn"}">${esc(late(p))}</span>`;
  return `
    <li class="link ${p.status === "overdue" ? "late" : ""}">
      <a class="row-link" href="#plant-${p.id}">
        <span class="grow"><span class="name">${esc(p.name)}</span><span class="sub">${esc(watered + extra)}</span></span>
        ${pill}
      </a>
    </li>`;
}

function allPlantsHtml(list) {
  const locs = list.locations;
  if (state.filter && !locs.includes(state.filter)) state.filter = "";
  const shown = state.filter ? list.plants.filter((p) => p.location === state.filter) : list.plants;
  const groups = [];
  for (const loc of [...locs, null]) {
    const ps = shown.filter((p) => (p.location ?? null) === loc);
    if (ps.length) groups.push({ loc, ps });
  }
  const chips =
    locs.length > 1
      ? `<div class="chips" role="group" aria-label="Filter by window">
          <button type="button" class="chip plain" data-filter="" aria-pressed="${state.filter === ""}">All</button>
          ${locs.map((l) => `<button type="button" class="chip plain" data-filter="${esc(l)}" aria-pressed="${state.filter === l}">${esc(l)}</button>`).join("")}
        </div>`
      : "";
  return `
  <section>
    <h2>All plants</h2>
    ${chips}
    ${groups
      .map(
        (g) => `
      <div class="group">
        <div class="eyebrow">${esc(g.loc ?? "No window set")}</div>
        <ul class="list">${g.ps.map(plantRowHtml).join("")}</ul>
      </div>`,
      )
      .join("")}
  </section>`;
}

function renderHome() {
  const list = state.list;
  document.title = "Plant Log";
  if (!list.plants.length) {
    app.innerHTML = `
      <header class="top"><h1>Plants</h1></header>
      <div class="empty">
        <strong>No plants yet</strong>
        <span>Add a plant with its window and how often it needs water. Plant Log tells you which ones need water each day.</span>
      </div>
      ${addFormHtml(list.today, true)}`;
    wireAddForm();
    app.querySelector('#add-form [name="name"]').focus();
    return;
  }
  app.innerHTML = `
    <header class="top row between">
      <h1>Plants</h1>
      ${state.addOpen ? "" : `<button type="button" data-action="open-add">Add plant</button>`}
    </header>
    ${state.addOpen ? addFormHtml(list.today, false) : ""}
    ${dueHtml(list)}
    ${allPlantsHtml(list)}`;
  if (state.addOpen) {
    wireAddForm();
    app.querySelector('#add-form [name="name"]').focus();
  }
}

function wireAddForm() {
  const form = document.getElementById("add-form");
  const photoInput = form.querySelector('[data-photo="add"]');
  const photoButton = form.querySelector('[data-action="identify-add"]');
  if (photoInput && photoButton) {
    wirePhotoIdentify(
      photoButton,
      photoInput,
      document.getElementById("identify-results"),
      document.getElementById("identify-error"),
      (c) => {
        const set = (name, value) => {
          const field = form.querySelector(`[name="${name}"]`);
          if (field && value !== undefined && value !== null) field.value = value;
        };
        set("name", c.common_name);
        if (c.species) set("species", c.species);
        set("water_every_days", c.water_every_days);
        set("feed_every_days", c.feed_every_days ?? "");
        if (c.care_note) set("notes", c.care_note);
        return `Filled in ${c.common_name}. Review the details and save.`;
      },
    );
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = document.getElementById("add-error");
    err.hidden = true;
    const f = new FormData(form);
    const name = String(f.get("name") || "").trim();
    if (!name) {
      form.classList.add("tried");
      return showError(err, "Give the plant a name.");
    }
    const water = Number(f.get("water_every_days"));
    if (!Number.isInteger(water) || water < 1) {
      form.classList.add("tried");
      return showError(err, "Water every needs a whole number of days, at least 1.");
    }
    const input = { name, water_every_days: water };
    const loc = String(f.get("location") || "").trim();
    if (loc) input.location = loc;
    const species = String(f.get("species") || "").trim();
    if (species) input.species = species;
    const notes = String(f.get("notes") || "").trim();
    if (notes) input.notes = notes;
    const feed = String(f.get("feed_every_days") || "").trim();
    if (feed) {
      const n = Number(feed);
      if (!Number.isInteger(n) || n < 1) return showError(err, "Feed every needs a whole number of days, or leave it empty.");
      input.feed_every_days = n;
    }
    const last = String(f.get("last_watered") || "");
    if (last) input.last_watered = last;
    const button = form.querySelector('[type="submit"]');
    await busy(button, async () => {
      try {
        const plant = await call("add_plant", input);
        state.lastAdd = { location: loc, water };
        state.addOpen = false;
        toast(`${plant.name} added`);
        await show();
      } catch (ex) {
        showError(err, ex.message);
      }
    });
  });
}

// ---------- plant page ----------

function statHtml(value, label, cls = "") {
  return `<div class="stat"><div class="value ${cls}">${value}</div><div class="label">${esc(label)}</div></div>`;
}

function renderPlant() {
  const p = state.plant;
  const today = p.today;
  document.title = `${p.name} · Plant Log`;
  const sub = [p.species, p.location].filter(Boolean).join(" · ");
  const identifyMissing = !p.species;

  const waterValue =
    p.status === "ok"
      ? esc(until(p.days_until))
      : esc(p.status === "today" ? "Today" : late(p));
  const stats = [
    statHtml(waterValue, "Next water", p.status === "overdue" ? "bad" : ""),
    statHtml(p.last_watered ? esc(ago(p.watered_days_ago)) : "Never", "Last watered"),
  ];
  if (p.feed_every_days) {
    const feedValue = p.feed_status === "ok" ? until(p.feed_days_until) : p.feed_status === "today" ? "Today" : `${span(p.feed_days_overdue)} late`;
    stats.push(statHtml(esc(feedValue), "Next feed", p.feed_status === "overdue" ? "bad" : ""));
  }
  if (p.last_repotted) stats.push(statHtml(esc(ago(p.repotted_days_ago)), "Last repotted"));

  const history = p.events.length
    ? `<ul class="list history">${p.events
        .map((e) => {
          const when = `${dateLabel(e.date, today)} · ${ago(daysBetween(e.date, today))}`;
          return `
          <li>
            <span class="grow">
              <span class="name">${esc(EVENT_LABEL[e.type] ?? e.type)}</span>
              <span class="sub">${esc(when)}</span>
              ${e.text ? `<span class="history-text">${esc(e.text)}</span>` : ""}
            </span>
            <button type="button" class="ghost danger" data-del-event="${e.id}" aria-label="Delete this ${esc((EVENT_LABEL[e.type] ?? e.type).toLowerCase())} entry">Delete</button>
          </li>`;
        })
        .join("")}</ul>`
    : `<p class="muted">Nothing logged yet.</p>`;

  app.innerHTML = `
    <div><a class="btn ghost back" href="#">‹ All plants</a></div>
    <header>
      <h1>${esc(p.name)}</h1>
      ${sub ? `<p class="muted" style="margin:0">${esc(sub)}</p>` : ""}
    </header>
    <div class="stats">${stats.join("")}</div>

    <section class="card">
      <div class="date-field">
        <label class="label" for="log-date">Date</label>
        <input type="date" id="log-date" value="${esc(today)}" max="${esc(today)}">
      </div>
      <div class="log-actions">
        <button type="button" class="primary" data-log="watered">Watered</button>
        <button type="button" data-log="fed">Fed</button>
        <button type="button" data-log="repotted">Repotted</button>
      </div>
      <form class="note-form" id="note-form">
        <input type="text" name="text" maxlength="500" placeholder="Add a note, e.g. new leaf" aria-label="Note">
        <button type="submit">Add note</button>
      </form>
      <div class="notice danger" id="log-error" hidden style="margin-top: var(--s3)"></div>
    </section>

    <section>
      <h2>History</h2>
      ${history}
    </section>

    <form class="card" id="edit-form">
      <div class="row between">
        <h2>Details</h2>
        ${identifyMissing ? `<button type="button" class="ghost sm" data-action="identify-plant">Identify from photo</button>` : ""}
      </div>
      ${identifyMissing ? `<input type="file" accept="image/*" capture="environment" data-photo="plant" hidden>` : ""}
      <div id="identify-plant-results" aria-live="polite"></div>
      <div class="notice danger" id="identify-plant-error" hidden></div>
      <label class="field"><span class="label">Name</span>
        <input type="text" name="name" required maxlength="80" value="${esc(p.name)}"></label>
      <div class="two">
        <label class="field"><span class="label">Window or room</span>
          <input type="text" name="location" list="locations" maxlength="80" value="${esc(p.location ?? "")}" autocomplete="off"></label>
        <label class="field"><span class="label">Species</span>
          <input type="text" name="species" maxlength="120" value="${esc(p.species ?? "")}"></label>
      </div>
      <div class="two">
        <label class="field"><span class="label">Water every (days)</span>
          <input type="number" name="water_every_days" required min="1" max="3650" step="1" value="${p.water_every_days}"></label>
        <label class="field"><span class="label">Feed every (days)</span>
          <input type="number" name="feed_every_days" min="1" max="3650" step="1" value="${p.feed_every_days ?? ""}" placeholder="Not tracked"></label>
      </div>
      <label class="field"><span class="label">Notes</span>
        <textarea name="notes" maxlength="500" rows="3">${esc(p.notes ?? "")}</textarea></label>
      <div class="notice danger" id="edit-error" hidden></div>
      <div class="actions">
        <button type="button" class="ghost danger" data-action="delete-plant">Delete plant</button>
        <span class="spacer"></span>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>`;

  const photoInput = app.querySelector('[data-photo="plant"]');
  const photoButton = app.querySelector('[data-action="identify-plant"]');
  if (photoInput && photoButton) {
    wirePhotoIdentify(
      photoButton,
      photoInput,
      document.getElementById("identify-plant-results"),
      document.getElementById("identify-plant-error"),
      async (c) => {
        if (!c.species) throw new Error("The recognizer didn't suggest a botanical name. Try another photo.");
        await call("update_plant", { id: p.id, species: c.species });
        toast(`Species added: ${c.species}`);
        await show();
        return null;
      },
    );
  }

  document.getElementById("note-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const text = String(new FormData(form).get("text") || "").trim();
    const err = document.getElementById("log-error");
    err.hidden = true;
    if (!text) return showError(err, "Write something for the note.");
    await busy(form.querySelector("button"), () => logEvent("note", text, err));
  });

  document.getElementById("edit-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const err = document.getElementById("edit-error");
    err.hidden = true;
    const f = new FormData(form);
    const name = String(f.get("name") || "").trim();
    if (!name) return showError(err, "Give the plant a name.");
    const water = Number(f.get("water_every_days"));
    if (!Number.isInteger(water) || water < 1) return showError(err, "Water every needs a whole number of days, at least 1.");
    const feedRaw = String(f.get("feed_every_days") || "").trim();
    const feed = feedRaw ? Number(feedRaw) : null;
    if (feed !== null && (!Number.isInteger(feed) || feed < 1)) return showError(err, "Feed every needs a whole number of days, or leave it empty.");
    const input = {
      id: p.id,
      name,
      location: String(f.get("location") || "").trim() || null,
      species: String(f.get("species") || "").trim() || null,
      notes: String(f.get("notes") || "").trim() || null,
      water_every_days: water,
      feed_every_days: feed,
    };
    await busy(form.querySelector('[type="submit"]'), async () => {
      try {
        await call("update_plant", input);
        toast("Saved");
        await show();
      } catch (ex) {
        showError(err, ex.message);
      }
    });
  });
}

async function logEvent(type, text, err) {
  const p = state.plant;
  const date = document.getElementById("log-date")?.value || p.today;
  const input = { plant_id: p.id, type, date };
  if (text) input.text = text;
  try {
    await call("log_event", input);
    const label = type === "note" ? "Note added" : `${EVENT_LABEL[type]} ${date === p.today ? "today" : dateLabel(date, p.today)}`;
    toast(label);
    await show();
  } catch (ex) {
    showError(err, ex.message);
  }
}

// ---------- actions ----------

app.addEventListener("change", (e) => {
  const box = e.target.closest("[data-due]");
  if (!box) return;
  const id = Number(box.dataset.due);
  if (box.checked) state.unchecked.delete(id);
  else state.unchecked.add(id);
  renderHome();
  app.querySelector(`[data-due="${id}"]`)?.focus();
});

app.addEventListener("click", async (e) => {
  const t = e.target.closest("button, [data-action]");
  if (!t) return;

  if (t.dataset.filter !== undefined) {
    state.filter = t.dataset.filter;
    renderHome();
    app.querySelector(`[data-filter="${CSS.escape(state.filter)}"]`)?.focus();
    return;
  }

  if (t.dataset.log) {
    const err = document.getElementById("log-error");
    err.hidden = true;
    await busy(t, () => logEvent(t.dataset.log, null, err));
    return;
  }

  if (t.dataset.delEvent) {
    const id = Number(t.dataset.delEvent);
    const ev = state.plant.events.find((x) => x.id === id);
    await busy(t, async () => {
      try {
        await call("delete_event", { id });
        const plantId = state.plant.id;
        toast(`${EVENT_LABEL[ev.type]} entry deleted`, {
          label: "Undo",
          run: async () => {
            try {
              const input = { plant_id: plantId, type: ev.type, date: ev.date };
              if (ev.text) input.text = ev.text;
              await call("log_event", input);
              await show();
            } catch (ex) {
              toast(ex.message);
            }
          },
        });
        await show();
      } catch (ex) {
        showError(document.getElementById("log-error"), ex.message);
      }
    });
    return;
  }

  switch (t.dataset.action) {
    case "retry":
      app.setAttribute("aria-busy", "true");
      await show();
      break;
    case "open-add":
      state.addOpen = true;
      renderHome();
      break;
    case "close-add":
      state.addOpen = false;
      renderHome();
      break;
    case "toggle-all": {
      const due = state.list.plants.filter((p) => p.status === "overdue" || p.status === "today");
      const allChecked = due.every((p) => !state.unchecked.has(p.id));
      state.unchecked = allChecked ? new Set(due.map((p) => p.id)) : new Set();
      renderHome();
      app.querySelector('[data-action="toggle-all"]')?.focus();
      break;
    }
    case "water-selected": {
      const ids = state.list.plants
        .filter((p) => (p.status === "overdue" || p.status === "today") && !state.unchecked.has(p.id))
        .map((p) => p.id);
      if (!ids.length) return;
      await busy(t, async () => {
        try {
          const res = await call("water", { plant_ids: ids });
          state.unchecked.clear();
          const names = res.watered.map((w) => w.name);
          toast(names.length === 1 ? `${names[0]} watered` : `Watered ${plural(names.length, "plant")}`);
          await show();
        } catch (ex) {
          showError(document.getElementById("water-error"), ex.message);
        }
      });
      break;
    }
    case "delete-plant": {
      const p = state.plant;
      const n = p.events.length;
      const ok = await confirmDelete(
        `Delete ${p.name}?`,
        n
          ? `This removes the plant and its ${n} history ${n === 1 ? "entry" : "entries"}. It can't be undone.`
          : "This removes the plant. It can't be undone.",
        "Delete plant",
      );
      if (!ok) return;
      await busy(t, async () => {
        try {
          await call("delete_plant", { id: p.id });
          toast(`${p.name} deleted`);
          state.plant = null;
          location.hash = "";
        } catch (ex) {
          showError(document.getElementById("edit-error"), ex.message);
        }
      });
      break;
    }
  }
});

window.addEventListener("hashchange", () => {
  window.scrollTo(0, 0);
  show();
});

show();
