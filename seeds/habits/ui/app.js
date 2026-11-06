// SPDX-License-Identifier: Apache-2.0
(() => {
  "use strict";

  const WEEKS = 5;
  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => new Date(`${s}T12:00:00`);
  const addDays = (s, n) => {
    const d = parse(s);
    d.setDate(d.getDate() + n);
    return iso(d);
  };
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  const plural = (n, one, many) => (n === 1 ? one : many);
  const fmtWeekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
  const fmtDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" });
  const fmtShort = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  const fmtWd = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });
  const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  /** The five Monday-aligned weeks ending with the week that holds `today`. */
  function range(today) {
    const weekday = (parse(today).getDay() + 6) % 7; // Monday = 0
    const start = addDays(today, -weekday - 7 * (WEEKS - 1));
    const span = weekday + 1 + 7 * (WEEKS - 1);
    return { start, span };
  }

  const state = {
    today: iso(new Date()),
    start: "",
    span: 0,
    day: null,
    hist: null,
    pending: new Set(),
  };

  async function call(operation, input) {
    try {
      const out = await hewn.call(operation, input);
      if (!out || out.error) return { error: (out && out.message) || "Something went wrong. Try again." };
      return { result: out.result };
    } catch {
      return { error: "Couldn't reach Habits just now. Try again in a moment." };
    }
  }

  function toast(text) {
    const t = document.createElement("div");
    t.className = "toast";
    t.setAttribute("role", "status");
    t.textContent = text;
    $("toasts").append(t);
    setTimeout(() => t.remove(), 4500);
  }

  // ---------- Loading ----------

  let loadSeq = 0;
  async function load() {
    const seq = ++loadSeq;
    const today = state.today;
    const { start, span } = range(today);
    const [day, hist] = await Promise.all([
      call("get_day", { date: today }),
      call("get_history", { to: today, days: span }),
    ]);
    if (seq !== loadSeq || state.pending.size) return; // a newer load or a tap in flight wins
    if (day.error) {
      if (state.day) toast(day.error);
      else showLoadError(day.error);
      return;
    }
    $("load-error").hidden = true;
    state.day = day.result;
    state.hist = hist.error ? null : hist.result;
    state.start = start;
    state.span = span;
    render();
  }

  function showLoadError(message) {
    $("load-error-text").textContent = message;
    $("load-error").hidden = false;
    $("habits").hidden = true;
  }

  // ---------- Today ----------

  function render() {
    renderToday();
    renderWeeks();
  }

  const LINK = '<svg viewBox="0 0 20 12" aria-hidden="true"><rect x="1.5" y="2" width="10" height="8" rx="4"/><rect x="8.5" y="2" width="10" height="8" rx="4"/></svg>';

  function tile(h) {
    const atRisk = !h.done && h.streak > 0;
    const status = h.done
      ? "Done today"
      : atRisk
        ? `Keep the ${h.streak}-day run going`
        : "";
    const label = `${h.name}: ${h.done ? "done today" : "not done yet"}, ${h.streak}-day streak`;
    const cls = ["habit", atRisk ? "at-risk" : "", h.streak > 0 ? "" : "no-run"].join(" ").replace(/\s+/g, " ").trim();
    const streak = h.streak > 0
      ? `<span class="streak">${LINK}<b>${h.streak}</b><small>${plural(h.streak, "day", "days")}</small></span>`
      : '<span class="streak" aria-hidden="true"></span>';
    return `<li><button type="button" class="${cls}" data-id="${esc(h.habitId)}" aria-pressed="${h.done}" aria-label="${esc(label)}"${state.pending.has(h.habitId) ? ' aria-busy="true"' : ""}>
      <span class="tick">${CHECK}</span>
      <span class="name">${esc(h.name)}${status ? `<span class="state">${esc(status)}</span>` : ""}</span>
      ${streak}
    </button></li>`;
  }

  function renderToday() {
    const d = parse(state.today);
    $("today-wd").textContent = fmtWeekday.format(d);
    $("today-date").textContent = fmtDate.format(d);
    const habits = state.day.habits;
    const list = $("habits");
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id : null;
    list.hidden = habits.length === 0;
    $("first").hidden = habits.length > 0;
    list.innerHTML = habits.map(tile).join("");
    if (focused) {
      const again = list.querySelector(`[data-id="${CSS.escape(focused)}"]`);
      if (again) again.focus();
    }
    renderMeter(habits);
    renderInsight(habits);
  }

  /** Today as a chain seen from the side: one link per habit, lit when it's done. */
  function renderMeter(habits) {
    const meter = $("meter");
    const total = habits.length;
    meter.hidden = total === 0;
    if (!total) return;
    const done = habits.filter((h) => h.done).length;
    const all = done === total;
    meter.classList.toggle("all", all);
    meter.setAttribute("role", "img");
    meter.setAttribute("aria-label", all ? `All ${total} done today` : `${done} of ${total} done today`);
    $("meter-count").innerHTML = all
      ? `<b>${total}</b><span>All done</span>`
      : `<b>${done}</b><span>of ${total} done</span>`;

    const lw = total > 10 ? 26 : total > 6 ? 34 : 44; // link length
    const lh = Math.round(lw * 0.6);
    const sw = lw > 30 ? 5 : 4;
    const step = Math.round(lw * 0.66);
    const pad = sw;
    const W = lw + step * (total - 1) + pad * 2;
    const H = lh + pad * 2 + 4;
    const box = $("meter-chain");
    // Rebuild only when the number of links changes, so lit links can transition.
    if (box.dataset.n !== String(total)) {
      let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">`;
      for (let i = 0; i < total; i++) {
        // Links sit a little up and down in turn, like a chain hanging loose.
        const y = pad + (i % 2 ? 4 : 0);
        s += `<rect class="link" x="${pad + i * step}" y="${y}" width="${lw}" height="${lh}" rx="${lh / 2}" style="stroke-width:${sw}"/>`;
      }
      box.innerHTML = s + "</svg>";
      box.dataset.n = String(total);
    }
    const links = box.querySelectorAll(".link");
    habits.forEach((h, i) => links[i] && links[i].classList.toggle("on", h.done));
  }

  /** One line computed from today and the history: the thing worth knowing right now. */
  function renderInsight(habits) {
    const el = $("insight");
    const total = habits.length;
    if (!total) {
      el.hidden = true;
      return;
    }
    const done = habits.filter((h) => h.done).length;
    const left = total - done;
    const lanes = new Map(state.hist ? state.hist.habits.map((l) => [l.habitId, l]) : []);
    const q = (s) => `<q>${esc(s)}</q>`;
    let text;
    const risk = habits.filter((h) => !h.done && h.streak > 0).sort((a, b) => b.streak - a.streak)[0];
    const record = habits
      .filter((h) => h.done && h.streak >= 3 && lanes.get(h.habitId) && lanes.get(h.habitId).best <= h.streak)
      .sort((a, b) => b.streak - a.streak)[0];
    if (left === 0) {
      text = total === 1 ? "Done for today. The chain grew by one link." : `Every chain grew by a link today.`;
      if (record) text += ` ${q(record.name)} is at its best run yet: ${record.streak} days.`;
    } else if (risk) {
      text = `${q(risk.name)} has a ${risk.streak}-day run riding on today.`;
    } else if (record) {
      text = `New best for ${q(record.name)}: ${record.streak} days in a row.`;
    } else if (done === 0) {
      text = "Tap a habit when it's done, and its chain begins.";
    } else {
      text = `${left} to go. ${done === 1 ? "One" : done} down already.`;
    }
    el.innerHTML = text;
    el.classList.toggle("risk", !!risk && left > 0);
    el.hidden = false;
  }

  async function toggle(id) {
    if (state.pending.has(id) || !state.day) return;
    const h = state.day.habits.find((x) => x.habitId === id);
    if (!h) return;
    const was = h.done;
    const before = { done: h.done, streak: h.streak };
    const lane = state.hist ? state.hist.habits.find((x) => x.habitId === id) : null;
    const laneBefore = lane ? { days: lane.days.slice(), streak: lane.streak, best: lane.best } : null;

    // Show it at once; the server's answer follows.
    h.done = !was;
    h.streak = Math.max(0, h.streak + (was ? -1 : 1));
    if (lane) {
      lane.days = was ? lane.days.filter((d) => d !== state.today) : [...lane.days, state.today].sort();
      lane.streak = h.streak;
      lane.best = Math.max(lane.best, h.streak);
    }
    state.pending.add(id);
    render();

    const res = await call(was ? "undo_check_in" : "check_in", { habitId: id, date: state.today });
    state.pending.delete(id);
    if (res.error) {
      Object.assign(h, before);
      if (lane) Object.assign(lane, laneBefore);
      render();
      toast(`Couldn't save "${h.name}". ${res.error}`);
      return;
    }
    if (!was && typeof res.result.streak === "number") h.streak = res.result.streak;
    if (!state.pending.size) load();
    else render();
  }

  $("habits").addEventListener("click", (e) => {
    const btn = e.target.closest("button.habit");
    if (btn) toggle(btn.dataset.id);
  });

  // ---------- Add ----------

  $("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("add-name");
    const btn = $("add-btn");
    const err = $("add-error");
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return;
    }
    btn.disabled = true;
    const res = await call("add_habit", { name });
    btn.disabled = false;
    if (res.error) {
      err.textContent = res.error;
      err.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }
    err.hidden = true;
    input.removeAttribute("aria-invalid");
    input.value = "";
    await load();
    input.focus();
  });

  $("add-name").addEventListener("input", () => {
    if (!$("add-error").hidden) {
      $("add-error").hidden = true;
      $("add-name").removeAttribute("aria-invalid");
    }
  });

  $("retry").addEventListener("click", () => {
    $("load-error").hidden = true;
    $("habits").hidden = false;
    load();
  });

  // ---------- Weeks ----------

  function renderWeeks() {
    const sec = $("weeks");
    const hist = state.hist;
    if (!hist || !hist.habits.length) {
      sec.hidden = true;
      return;
    }
    sec.hidden = false;
    // Before any habit has a past or a check-in the board is all promise: say so in the subtitle.
    const started = hist.habits.some((h) => h.days.length || h.since < state.today);
    $("weeks-sub").textContent = started
      ? "The last five weeks. Each day you check off links to the one before it; a missed day leaves a gap."
      : "Your chains start today. Each day you check off links to the one before it, right here.";
    const elapsedFrom = (h) => {
      const from = h.since > state.start ? h.since : state.start;
      return Math.max(1, Math.round((parse(state.today) - parse(from)) / 864e5) + 1);
    };
    $("lanes").innerHTML = hist.habits
      .map((h) => {
        const n = h.days.length;
        const of = Math.min(elapsedFrom(h), state.span);
        const summary = `${h.name}: checked off on ${n} of the last ${of} ${plural(of, "day", "days")}`;
        const best = h.best
          ? `Best run <b>${h.best}</b> ${plural(h.best, "day", "days")}`
          : h.since >= state.today
            ? "Started today"
            : "No runs yet";
        return `<li class="lane board-row" data-id="${esc(h.habitId)}">
          <div class="lane-label"><span class="lane-name">${esc(h.name)}</span><span class="lane-best">${best}</span></div>
          <div class="chain" role="img" aria-label="${esc(summary)}"></div>
        </li>`;
      })
      .join("");
    lastWidth = 0;
    draw();
  }

  function geometry(W) {
    const cols = WEEKS * 7;
    const gap = W < 520 ? 5 : 10;
    const colW = (W - gap * (WEEKS - 1)) / cols;
    const x = (i) => i * colW + Math.floor(i / 7) * gap;
    return { cols, gap, colW, x };
  }

  const r1 = (n) => Math.round(n * 10) / 10;

  function drawAxis(g, W) {
    const t = state.span - 1;
    const showWeekdays = g.colW >= 13;
    const height = showWeekdays ? 34 : 24;
    let s = `<svg viewBox="0 0 ${r1(W)} ${height}" height="${height}">`;
    for (let k = 0; k < WEEKS; k++) {
      const d = addDays(state.start, 7 * k);
      s += `<text class="wk" x="${r1(g.x(7 * k) + 1)}" y="12">${esc(fmtShort.format(parse(d)))}</text>`;
    }
    if (showWeekdays) {
      for (let i = 0; i < g.cols; i++) {
        const cx = g.x(i) + g.colW / 2;
        s += `<text class="wd${i === t ? " today" : ""}" x="${r1(cx)}" y="29" text-anchor="middle">${esc(fmtWd.format(parse(addDays(state.start, i))))}</text>`;
      }
    } else {
      const cx = g.x(t) + g.colW / 2;
      s += `<path class="today-mark" d="M${r1(cx - 4)} 17 h8 l-4 5 z"/>`;
    }
    $("axis").innerHTML = s + "</svg>";
  }

  function laneSvg(h, g, W) {
    const t = state.span - 1;
    const H = g.colW >= 14 ? 20 : 13;
    const height = H + 8;
    const cy = height / 2;
    const done = new Set(h.days);
    const dates = [];
    for (let i = 0; i <= t; i++) dates.push(addDays(state.start, i));
    const isDone = (i) => done.has(dates[i]);
    let sIdx = dates.findIndex((d) => d >= h.since);
    if (h.since < state.start) sIdx = 0;
    if (sIdx < 0) sIdx = t;
    const center = (i) => g.x(i) + g.colW / 2;
    const inset = Math.min(2, g.colW * 0.14);
    const cw = g.colW - 2 * inset; // one day's cell
    const crx = Math.min(cw / 2, 5);
    const cell = (cls, i) =>
      `<rect class="${cls}" x="${r1(g.x(i) + inset)}" y="${r1(cy - H / 2)}" width="${r1(cw)}" height="${H}" rx="${r1(crx)}"/>`;

    // Narrow phone cells are too small for dashes: draw them as plain outlines.
    let s = `<svg viewBox="0 0 ${r1(W)} ${height}" height="${height}" aria-hidden="true"${g.colW < 12 ? ' class="narrow"' : ""}>`;
    s += `<rect class="band" x="${r1(g.x(t) - 1)}" y="0" width="${r1(g.colW + 2)}" height="${height}" rx="5"/>`;

    // Before tracking: a faint dot per day. Tracked days missed: an empty cell, the gap in the chain.
    const dotR = Math.max(1.1, Math.min(1.7, g.colW * 0.1));
    for (let i = 0; i < sIdx; i++) s += `<circle class="pre" cx="${r1(center(i))}" cy="${cy}" r="${r1(dotR)}"/>`;
    for (let i = sIdx; i < t; i++) if (!isDone(i)) s += cell("gap", i);
    if (!isDone(t)) s += cell("due", t);
    // The rest of this week, still ahead.
    for (let i = t + 1; i < g.cols; i++) s += cell("ahead", i);

    // Runs of consecutive days become one capsule; the run still alive is solid.
    const liveEnd = isDone(t) ? t : t - 1;
    for (let i = 0; i <= t; ) {
      if (!isDone(i)) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 <= t && isDone(j + 1)) j++;
      const live = j === liveEnd;
      const len = live ? Math.max(h.streak, j - i + 1) : j - i + 1;
      const carries = i === 0 && len > j - i + 1; // continues from before the window
      const x0 = carries ? -6 : g.x(i) + inset;
      const x1 = g.x(j) + g.colW - inset;
      const w = Math.max(x1 - x0, 5);
      const kind = live ? "live" : "past";
      s += `<rect class="run ${kind}" x="${r1(x0)}" y="${r1(cy - H / 2)}" width="${r1(w)}" height="${H}" rx="${r1(Math.min(H / 2, w / 2))}"/>`;
      const label = String(len);
      const known = live || i > 0;
      if (known && len >= 2 && w >= label.length * 7 + 10) {
        s += `<text class="run-n ${kind}" x="${r1(x0 + w / 2)}" y="${r1(cy + 0.5)}">${label}</text>`;
      }
      i = j + 1;
    }
    return s + "</svg>";
  }

  let lastWidth = 0;
  function draw() {
    if (!state.hist || $("weeks").hidden) return;
    const W = $("axis").clientWidth;
    if (!W || W === lastWidth) return;
    lastWidth = W;
    const g = geometry(W);
    drawAxis(g, W);
    const byId = new Map(state.hist.habits.map((h) => [h.habitId, h]));
    for (const li of $("lanes").children) {
      const h = byId.get(li.dataset.id);
      if (h) li.querySelector(".chain").innerHTML = laneSvg(h, g, W);
    }
  }

  let frame = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  });

  // ---------- A new day ----------

  function rollover() {
    const now = iso(new Date());
    if (now !== state.today && !state.pending.size) {
      state.today = now;
      load();
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") rollover();
  });
  setInterval(rollover, 60000);

  // ---------- Start ----------

  load().then(() => {
    if (state.day && !state.day.habits.length) $("add-name").focus();
  });
})();
