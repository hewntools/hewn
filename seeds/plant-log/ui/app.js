// SPDX-License-Identifier: Apache-2.0
// Plant Log UI: a windowsill. What needs water today, the next two weeks, then every plant as a pot on its shelf.

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
  schedAll: false, // show every plant in the schedule
  unchecked: new Set(), // due plants the owner unticked
  lastAdd: { location: "", water: 7 },
};

const SCHED_DAYS = 14;
const SCHED_ROWS = 8;

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

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function isoDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function dateLabel(iso, today) {
  const sameYear = today && today.slice(0, 4) === iso.slice(0, 4);
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
    timeZone: "UTC",
  }).format(isoDate(iso));
}

const longDay = (iso) =>
  new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(isoDate(iso));
const narrowDay = (iso) => new Intl.DateTimeFormat(undefined, { weekday: "narrow", timeZone: "UTC" }).format(isoDate(iso));
const monthShort = (iso) => new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" }).format(isoDate(iso));
const oneDecimal = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function daysBetween(a, b) {
  const n = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
  };
  return Math.round(n(b) - n(a));
}

function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const isDue = (p) => p.status === "overdue" || p.status === "today";
const feedDue = (p) => p.feed_status === "overdue" || p.feed_status === "today";

const EVENT_LABEL = { watered: "Watered", fed: "Fed", repotted: "Repotted", note: "Note" };

// ---------- icons and the pot ----------

const DROP_PATH = "M6 1C6 1 1 7.2 1 10.2a5 5 0 0 0 10 0C11 7.2 6 1 6 1Z";
const drop = (cls = "") => `<svg class="${cls}" viewBox="0 0 12 16" aria-hidden="true" focusable="false"><path d="${DROP_PATH}"/></svg>`;

const ICON = {
  watered: `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 1.5S3 7.4 3 10.4a5 5 0 0 0 10 0C13 7.4 8 1.5 8 1.5Z"/></svg>`,
  fed: `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 14.5V7.5"/><path d="M8 9.5c0-3.6 2.4-6 6-6 0 3.6-2.4 6-6 6Z" fill="currentColor"/><path d="M8 10.5c0-2.8-2-4.8-5.5-4.8 0 2.8 2 4.8 5.5 4.8Z"/></svg>`,
  repotted: `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor"><rect x="1.5" y="4" width="13" height="3" rx="1"/><path d="M3 8h10l-1.3 6.2a1 1 0 0 1-1 .8H5.3a1 1 0 0 1-1-.8Z"/></svg>`,
  note: `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 4h10M3 8h10M3 12h6"/></svg>`,
  plus: `<svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>`,
  chevron: `<svg viewBox="0 0 8 14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m1.5 1.5 5 5.5-5 5.5"/></svg>`,
  window: `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="1.5" width="11" height="13" rx="1.5"/><path d="M8 1.5v13M2.5 8h11"/></svg>`,
  check: `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`,
};

const POT_BODY = "M19 66H61L56.6 94.2Q56 98 52.2 98H27.8Q24 98 23.4 94.2Z";

function ell(cx, cy, rx, ry, rot, cls = "leaf") {
  return `<ellipse class="${cls}" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"${rot ? ` transform="rotate(${rot} ${cx} ${cy})"` : ""}/>`;
}

const FOLIAGE = {
  spiky: {
    back:
      `<path class="leaf" d="M28 61C24 50 21 40 21 29C27 39 31 50 34 61Z"/>` +
      `<path class="leaf-2" d="M33 61C30 45 31 29 34 14C38 29 39 45 39 61Z"/>` +
      `<path class="leaf" d="M38 61C37 41 39 23 43 6C46 23 46 43 44 61Z"/>` +
      `<path class="leaf-2" d="M43 61C44 47 47 33 52 20C52 35 50 48 49 61Z"/>` +
      `<path class="leaf" d="M48 61C51 53 55 45 60 38C59 47 56 55 53 61Z"/>`,
    front: "",
  },
  broad: {
    back:
      `<path class="stem" d="M40 61Q37 47 27 35"/><path class="stem" d="M40 61Q43 42 52 27"/><path class="stem" d="M40 61Q40 52 41 45"/>` +
      ell(24, 32, 13, 8.5, -28) +
      `<path class="vein" d="M14.3 37.2 33.7 26.8"/>` +
      ell(54, 24, 14, 9, 24, "leaf-2") +
      `<path class="vein" d="M43 19.1 65 28.9"/>` +
      ell(41, 43, 10, 6.5, -6) +
      `<path class="vein" d="M32.5 43.9 49.5 42.1"/>`,
    front: "",
  },
  trailing: {
    back:
      ell(31, 53, 9, 6, -30) + ell(49, 52, 9, 6, 28, "leaf-2") + ell(40, 46, 8, 6.5, 0) +
      ell(34, 39, 6.5, 5, -40, "leaf-2") + ell(47, 38, 6.5, 5, 35),
    front:
      `<path class="stem" d="M20 62C12 68 12 80 17 90"/><path class="stem" d="M60 62C68 70 68 78 63 87"/>` +
      ell(14, 73, 5, 3.4, -60) + ell(17.5, 88, 5, 3.4, 50, "leaf-2") + ell(66, 73, 5, 3.4, 60, "leaf-2") + ell(63, 86, 5, 3.4, -50),
  },
  bushy: {
    back:
      `<path class="stem" d="M40 61V24M40 61 30 30M40 61 50 30"/>` +
      [
        [40, 17, 7, 5, 0],
        [31, 24, 7.5, 5, -30],
        [49, 24, 7.5, 5, 30],
        [24, 35, 8, 5.5, -20],
        [40, 31, 8, 5.5, 0],
        [56, 35, 8, 5.5, 20],
        [30, 45, 8, 5.5, -35],
        [50, 45, 8, 5.5, 35],
        [40, 50, 7, 5, 0],
        [21, 50, 6, 4.5, -10],
        [59, 50, 6, 4.5, 10],
      ]
        .map(([x, y, rx, ry, r], i) => ell(x, y, rx, ry, r, i % 2 ? "leaf-2" : "leaf"))
        .join(""),
    front: "",
  },
};

function hash(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

function kind(p) {
  const s = `${p.name} ${p.species ?? ""}`.toLowerCase();
  if (/snake|sansevieria|dracaena|aloe|cact|succulent|yucca|zamioculcas|\bzz\b|spider|grass|agave|haworthia/.test(s)) return "spiky";
  if (/pothos|epipremnum|ivy|hedera|philodendron|string of|hoya|tradescantia|trailing|vine|scindapsus|ceropegia/.test(s)) return "trailing";
  if (/fern|basil|herb|mint|parsley|thyme|rosemary|oregano|coriander|cilantro|moss|asparagus|chive|lavender/.test(s)) return "bushy";
  if (/monstera|fig|ficus|calathea|alocasia|pilea|lily|spathiphyllum|rubber|banana|bird|anthurium|begonia|maranta/.test(s)) return "broad";
  return ["broad", "spiky", "trailing", "bushy"][hash(p.name) % 4];
}

// How much of the watering interval is left: 1 just watered, 0 thirsty.
function moisture(p) {
  if (p.status !== "ok") return 0;
  return Math.max(0.1, Math.min(1, p.days_until / Math.max(1, p.water_every_days)));
}

let potSeq = 0;
function potSvg(p, opts = {}) {
  const k = opts.kind || kind(p);
  const level = opts.level ?? moisture(p);
  const mood = opts.mood ?? (p.status === "overdue" ? "parched" : p.status === "today" ? "thirsty" : "fresh");
  const id = `pot-clip-${++potSeq}`;
  const y = 98 - 28 * level; // the full mark sits a little below the rim so it reads as a level
  const f = FOLIAGE[k];
  return `<svg class="pot ${mood}" viewBox="0 0 80 100" aria-hidden="true" focusable="false">
    <defs><clipPath id="${id}"><path d="${POT_BODY}"/></clipPath></defs>
    <g class="foliage back">${f.back}</g>
    <path class="pot-body" d="${POT_BODY}"/>
    ${level > 0 ? `<rect class="pot-water" x="0" y="${y.toFixed(1)}" width="80" height="${(98 - y).toFixed(1)}" clip-path="url(#${id})"/><line class="pot-waterline" x1="0" x2="80" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" clip-path="url(#${id})"/>` : ""}
    <rect class="pot-rim" x="15" y="58" width="50" height="9" rx="2.5"/>
    ${f.front ? `<g class="foliage front">${f.front}</g>` : ""}
  </svg>`;
}

// ---------- photo identification ----------

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
      <h3>Likely plants</h3>
      <ul class="list">${candidates
        .map((c, i) => {
          const pct = Math.round(c.confidence * 100);
          const feed = c.feed_every_days ? `, feed every ${c.feed_every_days} days` : "";
          return `
          <li>
            <span class="grow">
              <span class="name">${esc(c.common_name)} <span class="pill ${pct < 50 ? "warn" : "ok"}">${pct}%</span></span>
              ${c.species ? `<span class="sub"><i>${esc(c.species)}</i></span>` : ""}
              ${c.care_note ? `<span class="sub">${esc(c.care_note)}</span>` : ""}
              <span class="sub">Water every ${c.water_every_days} days${feed}</span>
            </span>
            <button type="button" data-pick="${i}">Use</button>
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
      <button type="button" class="ghost" data-action="identify-add">Identify from photo</button>
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
  const due = list.plants.filter(isDue);
  if (!due.length) {
    const next = list.plants.find((p) => p.status === "ok");
    return `
    <section class="card today-card" id="due">
      <div class="all-done">
        <span class="done-badge">${ICON.check}</span>
        <div>
          <h2>All watered</h2>
          <p>${next ? `Next up: ${esc(next.name)}, ${esc(until(next.days_until))} (${esc(dateLabel(next.next_water, list.today))}).` : "Nothing needs water today."}</p>
        </div>
      </div>
    </section>`;
  }
  const checked = due.filter((p) => !state.unchecked.has(p.id)).length;
  const anyLate = due.some((p) => p.status === "overdue");
  const lateCount = due.filter((p) => p.status === "overdue").length;
  const rows = due
    .map((p) => {
      const last = p.last_watered ? `watered ${ago(p.watered_days_ago)}` : "never watered";
      return `
      <li class="${p.status === "overdue" ? "late" : ""}">
        <label class="due-check">
          <input type="checkbox" class="drop-check" data-due="${p.id}" ${state.unchecked.has(p.id) ? "" : "checked"}>
          <span class="mini-pot">${potSvg(p)}</span>
          <span class="due-text"><span class="name">${esc(p.name)}</span>${p.location ? `<span class="sub">${esc(p.location)}</span>` : ""}</span>
          <span class="due-when"><span class="when">${esc(p.status === "today" ? "Due today" : late(p))}</span><span class="last">${esc(cap(last))}</span></span>
        </label>
        <a class="btn ghost open-link" href="#plant-${p.id}" aria-label="Open ${esc(p.name)}">${ICON.chevron}</a>
      </li>`;
    })
    .join("");
  const label = checked ? `Mark ${checked === 1 ? "1 plant" : `${checked} plants`} watered` : "Mark watered";
  return `
  <section class="card today-card" id="due">
    <h2 class="today-title"><span class="big ${anyLate ? "late" : ""}">${due.length}</span><span>${due.length === 1 ? "plant needs" : "plants need"} water</span></h2>
    <div class="lede-row">
      <p class="today-lede">${lateCount ? `${plural(lateCount, "plant")} running late. ` : ""}Untick any you skipped.</p>
      <button type="button" class="ghost" data-action="toggle-all">${checked === due.length ? "Select none" : "Select all"}</button>
    </div>
    <ul class="due-list">${rows}</ul>
    <div class="due-actions">
      <button type="button" class="primary lg" data-action="water-selected" ${checked ? "" : "disabled"}>${ICON.watered.replace("<svg", '<svg class="btn-icon"')}${esc(label)}</button>
    </div>
    <div class="notice danger" id="water-error" hidden></div>
  </section>`;
}

// Projected care for the next SCHED_DAYS days, from each plant's next date and interval.
function projected(p, today) {
  const water = new Map(); // day offset -> "late" | "due" | "plan"
  const start = p.status === "ok" ? daysBetween(today, p.next_water) : 0;
  for (let d = start, i = 0; d < SCHED_DAYS; d += Math.max(1, p.water_every_days), i++) {
    water.set(d, i === 0 && p.status === "overdue" ? "late" : "plan");
  }
  const feed = new Map();
  if (p.feed_every_days && p.next_feed) {
    const fs = p.feed_status === "ok" ? daysBetween(today, p.next_feed) : 0;
    for (let d = fs, i = 0; d < SCHED_DAYS; d += Math.max(1, p.feed_every_days), i++) {
      feed.set(d, i === 0 && p.feed_status === "overdue" ? "late" : "plan");
    }
  }
  return { water, feed };
}

function scheduleHtml(list) {
  const today = list.today;
  const dates = Array.from({ length: SCHED_DAYS }, (_, i) => addDays(today, i));
  const weekend = dates.map((d) => {
    const w = isoDate(d).getUTCDay();
    return w === 0 || w === 6;
  });
  const all = list.plants.map((p) => ({ p, ...projected(p, today) }));
  const thisWeek = all.reduce((n, r) => n + [...r.water.keys()].filter((d) => d < 7).length, 0);
  const shown = state.schedAll ? all : all.slice(0, SCHED_ROWS);
  const head = `
    <div class="sched-row sched-days" aria-hidden="true">
      <span></span>
      ${dates.map((d, i) => `<span class="d ${i === 0 ? "today" : ""}">${esc(narrowDay(d))}<b>${isoDate(d).getUTCDate()}</b></span>`).join("")}
    </div>`;
  const rows = shown
    .map(({ p, water, feed }) => {
      const say = [...water.keys()].map((d) => (d === 0 ? (p.status === "overdue" ? `today (${late(p)})` : "today") : dateLabel(dates[d], today)));
      const cells = dates
        .map((_, i) => {
          const w = water.get(i);
          const f = feed.get(i);
          return `<span class="cell ${i === 0 ? "today" : ""} ${weekend[i] ? "weekend" : ""}">${w ? drop(`mk ${w === "late" ? "late" : ""}`) : ""}${f ? `<i class="feed-dot ${f === "late" ? "late" : ""}"></i>` : ""}</span>`;
        })
        .join("");
      return `
      <div class="sched-row">
        <a class="sched-name" href="#plant-${p.id}"><span>${esc(p.name)}</span><span class="sr">: water ${esc(say.join(", ") || "not in the next two weeks")}${feed.size ? `; feed ${esc([...feed.keys()].map((d) => (d === 0 ? "today" : dateLabel(dates[d], today))).join(", "))}` : ""}</span></a>
        ${cells.replace(/<span class="cell/g, '<span aria-hidden="true" class="cell')}
        ${water.size ? "" : `<span class="sched-later" aria-hidden="true">Next ${esc(dateLabel(p.next_water, today))} →</span>`}
      </div>`;
    })
    .join("");
  const more = all.length > SCHED_ROWS
    ? `<button type="button" class="ghost" data-action="sched-all">${state.schedAll ? "Show fewer" : `Show all ${all.length}`}</button>`
    : "";
  return `
  <section class="card sched-card" aria-labelledby="sched-title">
    <div class="sched-head">
      <h2 id="sched-title">Next two weeks</h2>
      <span class="insight"><b>${plural(thisWeek, "watering")}</b> in the next 7 days</span>
    </div>
    <div class="sched">${head}${rows}</div>
    <div class="sched-foot">
      <div class="legend" aria-hidden="true">
        <span>${drop()}Water</span>
        <span>${drop("late")}Late</span>
        ${all.some((r) => r.feed.size) ? `<span><i></i>Feed</span>` : ""}
      </div>
      ${more}
    </div>
  </section>`;
}

function potTileHtml(p) {
  const when =
    p.status === "ok" ? cap(until(p.days_until)) : p.status === "today" ? (p.last_watered ? "Water today" : "Never watered") : late(p);
  const label = `${p.name}: ${p.status === "ok" ? `water ${until(p.days_until)}` : p.status === "today" ? "needs water today" : `water ${late(p)}`}${feedDue(p) ? ", feed due" : ""}`;
  return `
    <a class="pot-tile ${p.status}" href="#plant-${p.id}" aria-label="${esc(label)}">
      <span class="pot-stage">${potSvg(p)}</span>
      <span class="pt-name">${esc(p.name)}</span>
      <span class="pt-when">${drop()}${esc(when)}</span>
      ${feedDue(p) ? `<span class="pt-feed">Feed due</span>` : ""}
    </a>`;
}

function sillHtml(list) {
  const locs = list.locations;
  if (state.filter && !locs.includes(state.filter)) state.filter = "";
  const shown = state.filter ? list.plants.filter((p) => p.location === state.filter) : list.plants;
  const groups = [];
  for (const loc of [...locs, null]) {
    const ps = shown.filter((p) => (p.location ?? null) === loc).sort((a, b) => a.name.localeCompare(b.name));
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
  <div class="sill-head">
    <h2>On the windowsill</h2>
    <span class="count">${plural(list.plants.length, "plant")}${locs.length ? ` in ${plural(locs.length, "spot")}` : ""}</span>
  </div>
  ${chips}
  <div class="sill">
    ${groups
      .map(
        (g) => `
      <section class="shelf" aria-label="${esc(g.loc ?? "No window set")}">
        <h3>${esc(g.loc ?? "No window set")}${g.ps.length > 1 ? `<span class="n">${g.ps.length}</span>` : ""}</h3>
        <div class="pots">${g.ps.map(potTileHtml).join("")}</div>
      </section>`,
      )
      .join("")}
  </div>`;
}

function renderHome() {
  const list = state.list;
  document.title = "Plant Log";
  potSeq = 0;
  if (!list.plants.length) {
    app.innerHTML = `
      <header class="top"><div><h1>Plants</h1><p class="today-date">${esc(longDay(list.today))}</p></div></header>
      <div class="empty-sill">
        ${potSvg({ name: "", status: "ok" }, { kind: "bushy", level: 0.7, mood: "fresh" })}
        <strong>Your windowsill is empty</strong>
        <span>Add a plant with its window and how often it needs water. Plant Log tells you which ones need water each day.</span>
      </div>
      ${addFormHtml(list.today, true)}`;
    wireAddForm();
    app.querySelector('#add-form [name="name"]').focus();
    return;
  }
  app.innerHTML = `
    <header class="top">
      <div><h1>Plants</h1><p class="today-date">${esc(longDay(list.today))}</p></div>
      ${state.addOpen ? "" : `<button type="button" data-action="open-add">${ICON.plus}Add plant</button>`}
    </header>
    ${state.addOpen ? addFormHtml(list.today, false) : ""}
    <div class="home-top">
      ${dueHtml(list)}
      ${scheduleHtml(list)}
    </div>
    ${sillHtml(list)}`;
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

function factHtml(label, value, cls = "") {
  return `<div><dt>${esc(label)}</dt><dd class="${cls}">${esc(value)}</dd></div>`;
}

function heroStatusHtml(p) {
  if (p.status === "ok") {
    return `<p class="hero-status">${drop()}Water ${esc(until(p.days_until))}<span class="on">${esc(dateLabel(p.next_water, p.today))}</span></p>`;
  }
  if (p.status === "today") return `<p class="hero-status today">${drop()}Needs water today</p>`;
  return `<p class="hero-status overdue">${drop()}Water is ${esc(late(p))}<span class="on">due ${esc(dateLabel(p.next_water, p.today))}</span></p>`;
}

function renderPlant() {
  const p = state.plant;
  const today = p.today;
  document.title = `${p.name} · Plant Log`;
  potSeq = 0;
  const identifyMissing = !p.species;

  const facts = [
    factHtml("Last watered", p.last_watered ? cap(ago(p.watered_days_ago)) : "Never"),
    factHtml("Water every", span(p.water_every_days)),
  ];
  if (p.feed_every_days) {
    const feedValue =
      p.feed_status === "ok" ? cap(until(p.feed_days_until)) : p.feed_status === "today" ? "Today" : `${span(p.feed_days_overdue)} late`;
    facts.push(factHtml("Next feed", feedValue, p.feed_status === "overdue" ? "bad" : p.feed_status === "today" ? "due" : ""));
  }
  if (p.last_repotted) facts.push(factHtml("Last repotted", cap(ago(p.repotted_days_ago))));

  const history = p.events.length
    ? `<ul class="history">${p.events
        .map((e) => {
          const label = EVENT_LABEL[e.type] ?? e.type;
          return `
          <li class="ev-${esc(e.type)}">
            <span class="ev-icon">${ICON[e.type] ?? ICON.note}</span>
            <span class="ev-body">
              <span class="ev-title">${esc(label)}</span>
              <span class="ev-when">${esc(dateLabel(e.date, today))}<span class="rel">${esc(ago(daysBetween(e.date, today)))}</span></span>
              ${e.text ? `<span class="history-text">${esc(e.text)}</span>` : ""}
            </span>
            <button type="button" class="ghost del" data-del-event="${e.id}" aria-label="Delete this ${esc(label.toLowerCase())} entry from ${esc(dateLabel(e.date, today))}">Delete</button>
          </li>`;
        })
        .join("")}</ul>`
    : `<p class="history-empty">Nothing logged yet. Log a watering above and it shows here.</p>`;

  app.innerHTML = `
    <div><a class="btn ghost back" href="#">‹ All plants</a></div>
    <div class="plant-layout">
      <header class="card plant-hero">
        <div class="hero-pot">${potSvg(p)}</div>
        <div class="hero-text">
          <h1>${esc(p.name)}</h1>
          ${p.species ? `<p class="species">${esc(p.species)}</p>` : ""}
          ${p.location ? `<p class="where">${ICON.window}${esc(p.location)}</p>` : ""}
          ${heroStatusHtml(p)}
        </div>
        <dl class="facts">${facts.join("")}</dl>
      </header>

      <section class="card log-card" aria-labelledby="log-title">
        <h2 id="log-title">Log care</h2>
        <div class="date-field">
          <label class="label" for="log-date">Date</label>
          <input type="date" id="log-date" value="${esc(today)}" max="${esc(today)}">
        </div>
        <div class="log-actions">
          <button type="button" class="primary" data-log="watered">${ICON.watered}Watered</button>
          <button type="button" data-log="fed">${ICON.fed}Fed</button>
          <button type="button" data-log="repotted">${ICON.repotted}Repotted</button>
        </div>
        <form class="note-form" id="note-form">
          <input type="text" name="text" maxlength="500" placeholder="Add a note, e.g. new leaf" aria-label="Note">
          <button type="submit">Add note</button>
        </form>
        <div class="notice danger" id="log-error" hidden style="margin-top: var(--s3)"></div>
      </section>

      <section class="card rhythm-card" aria-labelledby="rhythm-title">
        <div class="sched-head">
          <h2 id="rhythm-title">Care rhythm</h2>
          <div class="legend" aria-hidden="true">
            <span>${drop()}Watered</span>
            <span>${drop("late")}Gap longer than planned</span>
          </div>
        </div>
        <div class="rhythm-chart" id="rhythm"></div>
        <p class="rhythm-note" id="rhythm-note"></p>
      </section>

      <section class="card history-card" aria-labelledby="history-title">
        <h2 id="history-title">History</h2>
        ${history}
      </section>

      <details class="card edit">
        <summary>Edit details${p.notes ? `<span class="sum-sub">${esc(p.notes)}</span>` : ""}</summary>
        <form id="edit-form">
          ${identifyMissing ? `<div class="form-head"><button type="button" class="ghost" data-action="identify-plant">Identify from photo</button></div>` : ""}
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
        </form>
      </details>
    </div>`;

  drawRhythm();

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

// The care-rhythm timeline: past care as markers, gaps between waterings coloured by whether they ran long,
// and the planned next watering (and feed) ahead of today.
function drawRhythm() {
  const el = document.getElementById("rhythm");
  const noteEl = document.getElementById("rhythm-note");
  const p = state.plant;
  if (!el || !p) return;
  const W = Math.max(280, Math.floor(el.clientWidth || 640));
  const narrow = W < 520;
  const back = narrow ? 41 : 83;
  const fwd = narrow ? 10 : 16;
  const today = p.today;
  const start = addDays(today, -back);
  const end = addDays(today, fwd);
  const days = back + fwd + 1;
  const hasFeed = !!p.feed_every_days || p.events.some((e) => e.type === "fed");
  const rows = [{ key: "watered", label: "Water" }];
  if (hasFeed) rows.push({ key: "fed", label: "Feed" });
  rows.push({ key: "other", label: narrow ? "Other" : "Repot, notes" });
  const labelW = narrow ? 50 : 96;
  const padR = 10;
  const rowH = 36;
  const top = 4;
  const plotH = rows.length * rowH;
  const H = top + plotH + 26;
  const plotW = W - labelW - padR;
  const X = (iso) => labelW + ((daysBetween(start, iso) + 0.5) / days) * plotW;
  const clampX = (iso) => Math.max(labelW, Math.min(W - padR, X(iso)));
  const Y = (i) => top + i * rowH + rowH / 2;
  const inRange = (iso) => iso >= start && iso <= end;
  const rowOf = (t) => (t === "watered" ? 0 : t === "fed" && hasFeed ? 1 : rows.length - 1);
  const f1 = (n) => n.toFixed(1);
  const dropAt = (x, y, cls, title) =>
    `<path class="${cls}" transform="translate(${f1(x - 6)} ${f1(y - 9)})" d="${DROP_PATH}"><title>${esc(title)}</title></path>`;
  const out = [];
  const tx = X(today);

  out.push(`<rect class="rh-future" x="${f1(tx)}" y="${top}" width="${f1(W - padR - tx)}" height="${plotH}" rx="6"/>`);
  rows.forEach((r, i) => {
    out.push(`<line class="rh-base" x1="${labelW}" x2="${W - padR}" y1="${f1(Y(i))}" y2="${f1(Y(i))}"/>`);
    out.push(`<text class="rh-label" x="0" y="${f1(Y(i) + 4)}">${esc(r.label)}</text>`);
  });
  // month starts along the axis, and today
  const axisY = top + plotH + 17;
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    if (d.endsWith("-01")) {
      const x = X(d);
      out.push(`<line class="rh-tick" x1="${f1(x)}" x2="${f1(x)}" y1="${top}" y2="${top + plotH + 4}"/>`);
      if (Math.abs(x - tx) > 44) out.push(`<text class="rh-axis" x="${f1(x + 3)}" y="${axisY}">${esc(monthShort(d))}</text>`);
    }
  }
  out.push(`<line class="rh-today" x1="${f1(tx)}" x2="${f1(tx)}" y1="${top}" y2="${top + plotH + 4}"/>`);
  out.push(`<text class="rh-axis today" x="${f1(tx)}" y="${axisY}" text-anchor="middle">Today</text>`);

  // waterings: gaps, then plan, then markers on top
  const waterings = [...new Set(p.events.filter((e) => e.type === "watered").map((e) => e.date))].sort();
  const y0 = Y(0);
  for (let i = 1; i < waterings.length; i++) {
    const a = waterings[i - 1];
    const b = waterings[i];
    if (b < start) continue;
    const gap = daysBetween(a, b);
    out.push(`<line class="rh-gap ${gap > p.water_every_days ? "late" : ""}" x1="${f1(clampX(a))}" x2="${f1(X(b))}" y1="${f1(y0)}" y2="${f1(y0)}"><title>${esc(`${span(gap)} between waterings`)}</title></line>`);
  }
  const lastW = waterings[waterings.length - 1] || null;
  const planFrom = lastW || p.added_on || today;
  const next = p.next_water;
  if (p.status === "ok") {
    out.push(`<line class="rh-plan" x1="${f1(clampX(planFrom))}" x2="${f1(clampX(next))}" y1="${f1(y0)}" y2="${f1(y0)}"/>`);
    if (inRange(next)) out.push(dropAt(X(next), y0, "rh-next", `Next water ${dateLabel(next, today)}`));
  } else {
    if (next < today) {
      out.push(`<line class="rh-plan late" x1="${f1(clampX(next))}" x2="${f1(tx)}" y1="${f1(y0)}" y2="${f1(y0)}"><title>${esc(`Late since ${dateLabel(next, today)}`)}</title></line>`);
    }
    out.push(dropAt(tx, y0, `rh-next ${p.status === "overdue" ? "late" : "today"}`, p.status === "overdue" ? `Water ${late(p)}` : "Water today"));
  }
  if (hasFeed && p.feed_every_days && p.next_feed) {
    const fx = p.feed_status === "ok" ? p.next_feed : today;
    if (inRange(fx)) out.push(`<circle class="rh-feed-next" cx="${f1(X(fx))}" cy="${f1(Y(1))}" r="5"><title>${esc(`Next feed ${p.feed_status === "ok" ? dateLabel(fx, today) : "today"}`)}</title></circle>`);
  }
  const events = [...p.events].filter((e) => inRange(e.date)).reverse();
  for (const e of events) {
    const x = X(e.date);
    const y = Y(rowOf(e.type));
    const title = `${EVENT_LABEL[e.type] ?? e.type} ${dateLabel(e.date, today)}${e.text ? `: ${e.text}` : ""}`;
    if (e.type === "watered") out.push(dropAt(x, y, "rh-drop", title));
    else if (e.type === "fed") out.push(`<circle class="rh-feed" cx="${f1(x)}" cy="${f1(y)}" r="5.5"><title>${esc(title)}</title></circle>`);
    else if (e.type === "repotted") out.push(`<rect class="rh-repot" x="${f1(x - 5.5)}" y="${f1(y - 5.5)}" width="11" height="11" rx="2"><title>${esc(title)}</title></rect>`);
    else out.push(`<rect class="rh-note" x="${f1(x - 4.5)}" y="${f1(y - 4.5)}" width="9" height="9" rx="1.5" transform="rotate(45 ${f1(x)} ${f1(y)})"><title>${esc(title)}</title></rect>`);
  }

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`Care over the last ${span(back)} and the next ${span(fwd)}`)}">${out.join("")}</svg>`;

  if (noteEl) {
    const gaps = [];
    for (let i = 1; i < waterings.length; i++) gaps.push(daysBetween(waterings[i - 1], waterings[i]));
    if (gaps.length >= 2) {
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      const long = gaps.filter((g) => g > p.water_every_days).length;
      noteEl.innerHTML = `You water it every <b>${esc(oneDecimal.format(avg))} days</b> on average; the plan is every ${esc(span(p.water_every_days))}.${long ? ` ${esc(plural(long, "gap"))} ran longer than planned.` : " Right on rhythm."}`;
    } else if (waterings.length) {
      noteEl.textContent = `${plural(waterings.length, "watering")} logged so far. A few more and your watering rhythm shows here.`;
    } else {
      noteEl.textContent = "No waterings logged yet. Tap Watered when you water it and the rhythm starts here.";
    }
  }
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
    case "sched-all":
      state.schedAll = !state.schedAll;
      renderHome();
      app.querySelector('[data-action="sched-all"]')?.focus();
      break;
    case "toggle-all": {
      const due = state.list.plants.filter(isDue);
      const allChecked = due.every((p) => !state.unchecked.has(p.id));
      state.unchecked = allChecked ? new Set(due.map((p) => p.id)) : new Set();
      renderHome();
      app.querySelector('[data-action="toggle-all"]')?.focus();
      break;
    }
    case "water-selected": {
      const ids = state.list.plants.filter((p) => isDue(p) && !state.unchecked.has(p.id)).map((p) => p.id);
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

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (route().name === "plant" && state.plant) drawRhythm();
  }, 120);
});

show();
