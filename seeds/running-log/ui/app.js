// SPDX-License-Identifier: Apache-2.0
"use strict";

(function () {
  const $ = (s) => document.querySelector(s);
  const state = {
    runs: [], week: null, month: null, lastMonth: null,
    range: "3m", showAll: false, fresh: null, loaded: false,
  };
  const LIST_LIMIT = 8;

  /* ---------- dates and numbers ---------- */
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const startOfWeek = (d) => addDays(d, -((d.getDay() + 6) % 7));
  const dayDiff = (a, b) => Math.round((parse(iso(b)) - parse(iso(a))) / 864e5);
  const todayD = () => parse(iso(new Date()));

  const nf = (d) => new Intl.NumberFormat(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const nf1 = nf(1), nf0 = nf(0);
  const fmtKm = (n) => (n >= 100 ? nf0 : nf1).format(n);
  function fmtDur(s) {
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }
  function fmtDurLong(s) {
    if (!s) return "0 min";
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    return h ? `${h} h ${pad(m)}` : `${m} min`;
  }
  function fmtPace(spk) {
    if (spk == null || !isFinite(spk)) return "–";
    const t = Math.round(spk);
    return `${Math.floor(t / 60)}:${pad(t % 60)}`;
  }
  const dfShort = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  const dfShortY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
  const dfWeekday = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
  const dfWeekdayY = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const dfFull = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const dfMonth = new Intl.DateTimeFormat(undefined, { month: "long" });
  const dfMonthShort = new Intl.DateTimeFormat(undefined, { month: "short" });
  const dfMonthYear = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });
  const dfNarrow = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });
  const dfDay = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const cap = (s) => s.replace(/^./, (c) => c.toUpperCase());

  function calDate(s) {
    const d = parse(s);
    return (d.getFullYear() === new Date().getFullYear() ? dfWeekday : dfWeekdayY).format(d);
  }
  function relLabel(s) {
    const diff = dayDiff(parse(s), new Date());
    if (diff === 0) return "Today";
    if (diff === 1) return "Yesterday";
    if (diff > 1 && diff < 7) return cap(rtf.format(-diff, "day"));
    return null;
  }
  function rangeText(a, b) {
    try { return dfShort.formatRange(a, b); } catch (_) { return `${dfShort.format(a)} – ${dfShort.format(b)}`; }
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- input parsing ---------- */
  function parseKm(str) {
    const t = str.trim().replace(",", ".");
    if (!/^\d*\.?\d+$/.test(t)) return null;
    const n = parseFloat(t);
    return n > 0 && n < 1000 ? Math.round(n * 100) / 100 : null;
  }
  function parseTime(str) {
    const t = str.trim().replace(/\./g, ":");
    if (!t) return null;
    if (/^\d+$/.test(t)) { const m = Number(t); return m > 0 ? m * 60 : null; }
    const parts = t.split(":");
    if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return null;
    const n = parts.map(Number);
    let s;
    if (n.length === 2) { if (n[1] >= 60) return null; s = n[0] * 60 + n[1]; }
    else { if (n[1] >= 60 || n[2] >= 60) return null; s = n[0] * 3600 + n[1] * 60 + n[2]; }
    return s > 0 ? s : null;
  }

  /* ---------- API ---------- */
  async function call(op, input) {
    if (!window.hewn || typeof window.hewn.call !== "function") throw new Error("Can't reach your running log right now.");
    let out;
    try { out = await window.hewn.call(op, input || {}); }
    catch (e) { throw new Error("Can't reach your running log right now."); }
    if (!out) throw new Error("Something went wrong. Try again.");
    if (out.error) throw new Error(out.message || "Something went wrong. Try again.");
    return out.result;
  }

  /* ---------- derived data ---------- */
  function byDay(runs) {
    const map = new Map();
    for (const r of runs) {
      const a = map.get(r.date) || { date: r.date, km: 0, s: 0, runs: [] };
      a.km += r.distanceKm; a.s += r.durationSeconds; a.runs.push(r);
      map.set(r.date, a);
    }
    return map;
  }
  function byWeek(runs) {
    const map = new Map();
    for (const r of runs) {
      const k = iso(startOfWeek(parse(r.date)));
      const a = map.get(k) || { km: 0, n: 0 };
      a.km += r.distanceKm; a.n += 1;
      map.set(k, a);
    }
    return map;
  }
  function bests(runs) {
    if (runs.length < 3) return { longest: null, fastest: null };
    let longest = null, fastest = null;
    for (const r of runs) {
      if (!longest || r.distanceKm > longest.distanceKm) longest = r;
      if (r.distanceKm >= 1) {
        const p = r.durationSeconds / r.distanceKm;
        if (!fastest || p < fastest.durationSeconds / fastest.distanceKm) fastest = r;
      }
    }
    return { longest, fastest };
  }
  function weekStreak(runs) {
    if (!runs.length) return 0;
    const weeks = new Set(runs.map((r) => iso(startOfWeek(parse(r.date)))));
    let w = startOfWeek(todayD());
    if (!weeks.has(iso(w))) w = addDays(w, -7);
    let n = 0;
    while (weeks.has(iso(w))) { n++; w = addDays(w, -7); }
    return n;
  }

  /* ---------- rendering: header ---------- */
  function renderHeader() {
    const el = $("#tagline");
    const runs = state.runs;
    const streakEl = $("#streak");
    if (!runs.length) {
      el.textContent = "Log your first run to start the trace.";
      streakEl.hidden = true;
      return;
    }
    const past = runs.filter((r) => r.date <= iso(new Date()));
    const last = past.length ? past[past.length - 1] : runs[runs.length - 1];
    const diff = dayDiff(parse(last.date), new Date());
    let when;
    if (diff <= 0) when = diff === 0 ? "today" : rtf.format(-diff, "day");
    else if (diff < 14) when = rtf.format(-diff, "day");
    else when = rtf.format(-Math.round(diff / 7), "week");
    el.innerHTML = `Last run <b>${esc(when)}</b>, ${esc(fmtKm(last.distanceKm))} km. ${runs.length} ${runs.length === 1 ? "run" : "runs"} on the log.`;

    // 12-week streak strip: one tile per week, shaded by volume
    const streak = weekStreak(runs);
    const wk = byWeek(runs);
    const cw = startOfWeek(todayD());
    const weeks = Array.from({ length: 12 }, (_, i) => addDays(cw, -(11 - i) * 7));
    const kms = weeks.map((w) => (wk.get(iso(w)) || { km: 0 }).km);
    const max = Math.max(1, ...kms);
    const ranWeeks = kms.filter((k) => k > 0).length;
    streakEl.innerHTML = `
      <div class="st-text">${streak >= 2 ? `<b>${streak} weeks</b> in a row` : `<b>${ranWeeks} of 12</b> weeks with a run`}</div>
      <div class="st-cells" role="img" aria-label="Ran in ${ranWeeks} of the last 12 weeks${streak >= 2 ? `, ${streak} weeks in a row` : ""}">
        ${weeks.map((w, i) => {
          const km = kms[i], now = i === 11;
          return `<i class="${km ? "on" : ""}${now ? " now" : ""}" style="--a:${(0.3 + 0.7 * (km / max)).toFixed(2)}" title="Week of ${esc(dfShort.format(w))}: ${esc(fmtKm(km))} km"></i>`;
        }).join("")}
      </div>`;
    streakEl.hidden = false;
  }

  /* ---------- rendering: scoreboard ---------- */
  function facts(s) {
    const n = s ? s.runCount : 0;
    return `<dl class="p-facts">
      <div><dt>${n === 1 ? "run" : "runs"}</dt><dd>${n}</dd></div>
      <div><dt>time</dt><dd>${s && s.totalDurationSeconds ? esc(fmtDurLong(s.totalDurationSeconds)) : "–"}</dd></div>
      <div><dt>average pace</dt><dd class="pace">${s && s.averagePaceSecondsPerKm != null ? `${fmtPace(s.averagePaceSecondsPerKm)}<small>/km</small>` : "–"}</dd></div>
    </dl>`;
  }

  function renderWeek() {
    const el = $("#week");
    const s = state.week;
    const today = todayD();
    const ws = startOfWeek(today);
    const map = byDay(state.runs);
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(ws, i), k = iso(d), a = map.get(k);
      return { d, km: a ? a.km : 0, today: k === iso(today), future: k > iso(today) };
    });
    const max = Math.max(4, ...days.map((x) => x.km));
    const ran = days.filter((x) => x.km > 0).length;
    el.innerHTML = `
      <div class="p-head"><h2>This week</h2><span class="p-range">${esc(rangeText(ws, addDays(ws, 6)))}</span></div>
      <div class="p-total"><span class="big">${esc(fmtKm(s ? s.totalDistanceKm : 0))}</span><span class="u">km</span></div>
      <div class="week-days" role="img" aria-label="Ran on ${ran} of 7 days this week">
        ${days.map((x) => `<div class="wd${x.today ? " today" : ""}${x.future ? " future" : ""}${x.km ? " ran" : ""}" title="${esc(dfWeekday.format(x.d))}${x.km ? `: ${esc(fmtKm(x.km))} km` : ""}">
          <span class="wd-km">${x.km ? esc(fmtKm(x.km)) : ""}</span>
          <div class="col">${x.km ? `<i style="--h:${Math.max(14, (x.km / max) * 100).toFixed(1)}%"></i>` : ""}</div>
          <span class="wd-l">${esc(dfNarrow.format(x.d))}</span></div>`).join("")}
      </div>
      ${facts(s)}`;
  }

  function cumulative(runs, prefix, days) {
    const per = new Array(days + 1).fill(0);
    for (const r of runs) {
      if (!r.date.startsWith(prefix)) continue;
      const d = Number(r.date.slice(8, 10));
      if (d >= 1 && d <= days) per[d] += r.distanceKm;
    }
    let c = 0;
    return per.map((v) => (c += v));
  }

  function raceSvg(cur, prev, upto, D, LD, lastShort, monthStart) {
    const W = 320, H = 116;
    const M = { l: 2, r: 50, t: 12, b: 20 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const span = Math.max(D, LD);
    const top = Math.max(10, cur[upto], prev.length ? prev[prev.length - 1] : 0) * 1.08;
    const X = (d) => M.l + (d / span) * iw;
    const Y = (v) => M.t + ih - (v / top) * ih;
    const step = (cum, end) => {
      let p = `M${X(0).toFixed(1)} ${Y(0).toFixed(1)}`;
      for (let d = 1; d <= end; d++) {
        if (cum[d] !== cum[d - 1]) p += ` H${X(d - 0.5).toFixed(1)} V${Y(cum[d]).toFixed(1)}`;
      }
      return p + ` H${X(end).toFixed(1)}`;
    };
    const parts = [];
    parts.push(`<line class="rc-base" x1="${M.l}" x2="${X(span).toFixed(1)}" y1="${M.t + ih}" y2="${M.t + ih}"/>`);
    if (prev.length) {
      const lt = prev[LD];
      parts.push(`<path class="rc-prev" d="${step(prev, LD)}"/>`);
      const ly = Math.max(M.t + 8, Math.min(M.t + ih - 14, Y(lt)));
      parts.push(`<text class="rc-lab" x="${(X(LD) + 6).toFixed(1)}" y="${ly.toFixed(1)}">${esc(lastShort)}</text>`);
      parts.push(`<text class="rc-lab n" x="${(X(LD) + 6).toFixed(1)}" y="${(ly + 13).toFixed(1)}">${esc(fmtKm(lt))}</text>`);
    }
    const line = step(cur, upto);
    parts.push(`<path class="rc-area" d="${line} V${(M.t + ih).toFixed(1)} H${X(0).toFixed(1)} Z"/>`);
    parts.push(`<path class="rc-cur" d="${line}"/>`);
    parts.push(`<line class="rc-today" x1="${X(upto).toFixed(1)}" x2="${X(upto).toFixed(1)}" y1="${M.t}" y2="${M.t + ih}"/>`);
    parts.push(`<circle class="rc-dot" cx="${X(upto).toFixed(1)}" cy="${Y(cur[upto]).toFixed(1)}" r="4"/>`);
    // day ticks: 1st, 15th, last
    const ticks = [[0.5, dfShort.format(monthStart), "start"], [14.5, "15", "middle"], [D - 0.5, String(D), "end"]];
    for (const [d, t, a] of ticks) {
      parts.push(`<text class="rc-ax" x="${X(a === "start" ? 0 : a === "end" ? D : d).toFixed(1)}" y="${H - 4}" text-anchor="${a}">${esc(t)}</text>`);
    }
    return `<svg class="race" viewBox="0 0 ${W} ${H}" aria-hidden="true">${parts.join("")}</svg>`;
  }

  function renderMonth() {
    const el = $("#month");
    const s = state.month, l = state.lastMonth;
    const t = todayD();
    const y = t.getFullYear(), mo = t.getMonth();
    const monthStart = new Date(y, mo, 1);
    const lastStart = new Date(y, mo - 1, 1);
    const D = new Date(y, mo + 1, 0).getDate();
    const LD = new Date(y, mo, 0).getDate();
    const lastName = dfMonth.format(lastStart);
    const lastShort = dfMonthShort.format(lastStart);
    const km = s ? s.totalDistanceKm : 0, lkm = l ? l.totalDistanceKm : 0;

    const cur = cumulative(state.runs, iso(monthStart).slice(0, 7), D);
    const prev = lkm > 0 ? cumulative(state.runs, iso(lastStart).slice(0, 7), LD) : [];
    let upto = t.getDate();
    for (let d = D; d > upto; d--) if (cur[d] !== cur[d - 1]) { upto = d; break; }

    let line1, line2 = "";
    if (lkm > 0) {
      const same = Math.min(t.getDate(), LD);
      const diff = cur[t.getDate()] - prev[same];
      if (Math.abs(diff) < 0.05) line1 = `Level with ${esc(lastName)} at this point`;
      else line1 = `<strong>${esc(fmtKm(Math.abs(diff)))} km</strong> ${diff > 0 ? "ahead of" : "behind"} ${esc(lastName)} at this point`;
      line2 = km >= lkm
        ? `Past ${esc(lastName)}'s ${esc(fmtKm(lkm))} km by ${esc(fmtKm(km - lkm))} km`
        : `${esc(fmtKm(lkm - km))} km to go to match ${esc(lastName)}'s ${esc(fmtKm(lkm))} km`;
    } else {
      line1 = `No runs logged in ${esc(lastName)}`;
    }
    const aria = lkm > 0
      ? `${fmtKm(km)} km so far this month, against ${fmtKm(lkm)} km in all of ${lastName}`
      : `${fmtKm(km)} km so far this month`;
    el.innerHTML = `
      <div class="p-head"><h2>${esc(cap(dfMonth.format(t)))}</h2><span class="p-range">so far this month</span></div>
      <div class="p-total"><span class="big">${esc(fmtKm(km))}</span><span class="u">km</span></div>
      <figure class="race-wrap" role="img" aria-label="${esc(aria)}">
        ${raceSvg(cur, prev, upto, D, LD, lastShort, monthStart)}
        <figcaption class="vs-cap"><span>${line1}</span>${line2 ? `<span class="sub">${line2}</span>` : ""}</figcaption>
      </figure>
      ${facts(s)}`;
  }

  /* ---------- rendering: trace chart ---------- */
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  function chartSpan() {
    const today = todayD();
    const runs = state.runs;
    const lastRun = runs.length ? parse(runs[runs.length - 1].date) : today;
    const endRef = lastRun > today ? lastRun : today;
    let start;
    if (state.range === "all") {
      start = runs.length ? parse(runs[0].date) : addDays(endRef, -27);
    } else {
      const n = { "3m": 91, "6m": 182, "1y": 365 }[state.range];
      start = addDays(endRef, -(n - 1));
      // don't draw empty weeks before the very first run
      if (runs.length) {
        const first = addDays(startOfWeek(parse(runs[0].date)), -7);
        if (first > start) start = first;
      }
    }
    if (dayDiff(start, endRef) < 27) start = addDays(endRef, -27);
    start = startOfWeek(start);
    const end = addDays(startOfWeek(endRef), 6);
    return { start, end, days: dayDiff(start, end) + 1 };
  }

  function smoothPath(pts) {
    // monotone cubic (Fritsch–Carlson): smooth, but never overshoots a run's real pace
    const n = pts.length;
    if (n < 3) return pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    const dx = [], m = [];
    for (let i = 0; i < n - 1; i++) {
      dx[i] = Math.max(1e-6, pts[i + 1].x - pts[i].x);
      m[i] = (pts[i + 1].y - pts[i].y) / dx[i];
    }
    const t = [m[0]];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    t[n - 1] = m[n - 2];
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
      if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += ` C${(pts[i].x + h).toFixed(1)} ${(pts[i].y + t[i] * h).toFixed(1)} ${(pts[i + 1].x - h).toFixed(1)} ${(pts[i + 1].y - t[i + 1] * h).toFixed(1)} ${pts[i + 1].x.toFixed(1)} ${pts[i + 1].y.toFixed(1)}`;
    }
    return d;
  }

  function renderChart() {
    const box = $("#chart");
    hideTip();
    if (!state.runs.length) {
      box.innerHTML = `<div class="trace-empty">
        <svg viewBox="0 0 160 60" aria-hidden="true">
          <line x1="4" y1="54" x2="156" y2="54" stroke="currentColor" stroke-opacity=".35" stroke-dasharray="3 4"/>
          ${[18, 30, 22, 40, 26, 46].map((h, i) => `<rect x="${14 + i * 24}" y="${54 - h}" width="10" height="${h}" rx="2" fill="var(--ember)" opacity="${0.18 + i * 0.06}"/>`).join("")}
          <path d="M19 26 C31 22 55 26 67 24 S103 12 115 16 S133 11 139 9" fill="none" stroke="var(--lake)" stroke-width="2" stroke-dasharray="4 4" opacity=".5"/>
        </svg>
        <strong>Your runs will draw here</strong>
        <p>Each run adds a bar for distance and a point on the pace line.</p>
        <button type="button" class="primary" id="empty-log">Log your first run</button>
      </div>`;
      $("#empty-log").addEventListener("click", () => { $("#f-dist").focus(); $("#f-dist").scrollIntoView({ block: "center", behavior: "smooth" }); });
      return;
    }

    const span = chartSpan();
    const map = byDay(state.runs);
    const wk = byWeek(state.runs);
    const inRange = [...map.values()].filter((a) => {
      const d = parse(a.date);
      return d >= span.start && d <= span.end;
    }).sort((a, b) => (a.date < b.date ? -1 : 1));

    if (!inRange.length) {
      box.innerHTML = `<div class="trace-empty"><strong>No runs in this span</strong>
        <p>Your latest run is further back.</p>
        <button type="button" id="see-all">Show all runs</button></div>`;
      $("#see-all").addEventListener("click", () => setRange("all"));
      return;
    }

    const W = Math.max(280, Math.round(box.clientWidth || 600));
    const phone = W < 560;
    const H = phone ? 250 : 300;
    const M = { l: 30, r: phone ? 40 : 46, t: 42, b: 26 };
    const LAB = M.t - 13; // baseline of the unit and week-total row
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const pw = iw / span.days;
    const X = (d) => M.l + (dayDiff(span.start, d) + 0.5) * pw;

    // distance axis
    const maxKm = Math.max(...inRange.map((a) => a.km));
    const kStep = niceStep(Math.max(maxKm, 2) / 4);
    const kTop = Math.ceil((maxKm * 1.04) / kStep) * kStep || kStep;
    const YK = (v) => M.t + ih - (v / kTop) * ih;

    // pace axis (faster = higher)
    const paces = inRange.filter((a) => a.km > 0).map((a) => a.s / a.km);
    let pMin = Math.min(...paces), pMax = Math.max(...paces);
    const padP = Math.max(15, (pMax - pMin) * 0.15);
    pMin -= padP; pMax += padP;
    const pStepOpts = [5, 10, 15, 20, 30, 60, 120, 300];
    const pStep = pStepOpts.find((s) => (pMax - pMin) / s <= 4) || 600;
    pMin = Math.floor(pMin / pStep) * pStep; pMax = Math.ceil(pMax / pStep) * pStep;
    if (pMax === pMin) pMax = pMin + pStep;
    const YP = (p) => M.t + ((p - pMin) / (pMax - pMin)) * ih;

    const { longest, fastest } = bests(state.runs);
    const parts = [];

    // week columns with their totals on top (the split sheet)
    const weeks = Math.ceil(span.days / 7);
    const nowWeek = iso(startOfWeek(todayD()));
    const bandW = 7 * pw;
    for (let k = 0; k < weeks; k++) {
      const ws = addDays(span.start, k * 7);
      const x = M.l + k * bandW;
      const isNow = iso(ws) === nowWeek;
      if (isNow || k % 2 === 1) parts.push(`<rect class="wkband${isNow ? " now" : ""}" x="${x.toFixed(1)}" y="${M.t - 30}" width="${bandW.toFixed(1)}" height="${ih + 30}"/>`);
      const w = wk.get(iso(ws));
      if (w && bandW >= 24) {
        const txt = bandW >= 34 ? fmtKm(w.km) : nf0.format(w.km);
        parts.push(`<text class="wk-tot${isNow ? " now" : ""}" x="${(x + bandW / 2).toFixed(1)}" y="${LAB}" text-anchor="middle">${esc(txt)}</text>`);
      }
    }

    // average pace over the span (drawn as a guide, tagged on the pace axis)
    const totKm = inRange.reduce((s, a) => s + a.km, 0);
    const totS = inRange.reduce((s, a) => s + a.s, 0);
    const avgP = totKm > 0 && inRange.length > 1 ? totS / totKm : null;
    const ya = avgP != null ? YP(avgP) : null;

    // gridlines and labels
    for (let v = 0; v <= kTop + 1e-9; v += kStep) {
      const y = YK(v).toFixed(1);
      if (v > 0) parts.push(`<line class="gl" x1="${M.l}" x2="${W - M.r}" y1="${y}" y2="${y}"/>`);
      parts.push(`<text class="ax" x="${M.l - 6}" y="${y}" dy="3.5" text-anchor="end">${esc(nf(kStep % 1 ? 1 : 0).format(v))}</text>`);
    }
    parts.push(`<text class="ax unit" x="${M.l - 6}" y="${LAB}" text-anchor="end">km</text>`);
    for (let p = pMin; p <= pMax + 1e-9; p += pStep) {
      if (ya != null && Math.abs(YP(p) - ya) < 14) continue; // the avg tag takes this spot
      parts.push(`<text class="ax pace" x="${W - M.r + 6}" y="${YP(p).toFixed(1)}" dy="3.5">${fmtPace(p)}</text>`);
    }
    parts.push(`<text class="ax pace unit" x="${W - M.r + 6}" y="${LAB}">/km</text>`);
    parts.push(`<line class="base" x1="${M.l}" x2="${W - M.r}" y1="${M.t + ih}" y2="${M.t + ih}"/>`);

    // x labels
    const labels = [];
    if (bandW >= 52) {
      let prevMonth = -1;
      for (let k = 0; k < weeks; k++) {
        const d = addDays(span.start, k * 7);
        labels.push({ x: M.l + k * bandW, text: d.getMonth() !== prevMonth ? dfShort.format(d) : String(d.getDate()) });
        prevMonth = d.getMonth();
      }
    } else {
      const monthsSpan = Math.max(1, Math.ceil(42 / (pw * 30.4)));
      let d = new Date(span.start.getFullYear(), span.start.getMonth() + 1, 1);
      let i = 0;
      const multiYear = span.start.getFullYear() !== span.end.getFullYear();
      while (d <= span.end) {
        if (i % monthsSpan === 0) {
          labels.push({ x: M.l + dayDiff(span.start, d) * pw, text: (multiYear && d.getMonth() === 0 ? dfMonthYear : dfMonthShort).format(d) });
        }
        d = new Date(d.getFullYear(), d.getMonth() + 1, 1); i++;
      }
    }
    for (const lb of labels) {
      if (lb.x + 30 > W - M.r + 10) continue;
      parts.push(`<line class="base" x1="${lb.x.toFixed(1)}" x2="${lb.x.toFixed(1)}" y1="${M.t + ih}" y2="${M.t + ih + 4}"/>`);
      parts.push(`<text class="ax" x="${(lb.x + 3).toFixed(1)}" y="${H - 6}">${esc(lb.text)}</text>`);
    }

    // bars
    const bw = Math.max(3, Math.min(20, pw * 0.72));
    for (const a of inRange) {
      const x = X(parse(a.date));
      const y = YK(a.km);
      const best = longest && a.runs.includes(longest);
      parts.push(`<rect class="bar${best ? " best" : ""}" data-date="${a.date}" x="${(x - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${(M.t + ih - y).toFixed(1)}" rx="${Math.min(3, bw / 2).toFixed(1)}"/>`);
    }

    // average pace guide, with its value tagged on the pace axis
    if (ya != null) {
      const yv = ya.toFixed(1);
      const tw = M.r - 4;
      parts.push(`<line class="avg" x1="${M.l}" x2="${W - M.r}" y1="${yv}" y2="${yv}"/>`);
      parts.push(`<rect class="avg-tag" x="${W - M.r + 2}" y="${(ya - 8).toFixed(1)}" width="${tw}" height="16" rx="4"/>`);
      parts.push(`<text class="avg-l" x="${(W - M.r + 2 + tw / 2).toFixed(1)}" y="${yv}" dy="3.5" text-anchor="middle">${fmtPace(avgP)}</text>`);
    }

    // pace thread
    const pts = inRange.filter((a) => a.km > 0).map((a) => ({ a, x: X(parse(a.date)), y: YP(a.s / a.km) }));
    if (pts.length > 1) parts.push(`<path class="thread" d="${smoothPath(pts)}"/>`);
    const r = pw < 5 ? 2.5 : 3.5;
    for (const p of pts) {
      const best = fastest && p.a.runs.includes(fastest);
      parts.push(`<circle class="dotp${best ? " best" : ""}" data-date="${p.a.date}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${best ? r + 1.5 : r}"/>`);
    }

    // hit areas
    const hw = Math.max(pw, 12);
    for (const a of inRange) {
      const x = X(parse(a.date));
      parts.push(`<rect class="hit" data-date="${a.date}" x="${(x - hw / 2).toFixed(1)}" y="${M.t}" width="${hw.toFixed(1)}" height="${ih}"/>`);
    }

    const label = `Distance and pace of ${inRange.reduce((s, a) => s + a.runs.length, 0)} runs from ${dfShort.format(span.start)} to ${dfShort.format(span.end)}, ${fmtKm(totKm)} km in total${avgP != null ? `, average pace ${fmtPace(avgP)} per km` : ""}.`;
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${parts.join("")}</svg>`;

    const svg = box.querySelector("svg");
    const showFor = (date) => {
      const a = map.get(date);
      if (!a) return;
      svg.classList.add("hovering");
      svg.querySelectorAll(".on").forEach((n) => n.classList.remove("on"));
      svg.querySelectorAll(`[data-date="${date}"]`).forEach((n) => n.classList.add("on"));
      showTip(a, X(parse(date)) * (box.clientWidth / W), W);
    };
    svg.querySelectorAll(".hit").forEach((h) => {
      h.addEventListener("pointerenter", () => showFor(h.dataset.date));
      h.addEventListener("click", () => showFor(h.dataset.date));
    });
    svg.addEventListener("pointerleave", () => {
      svg.classList.remove("hovering");
      svg.querySelectorAll(".on").forEach((n) => n.classList.remove("on"));
      hideTip();
    });
  }

  function showTip(a, x) {
    const tip = $("#tip");
    const box = $("#chart");
    const rel = relLabel(a.date);
    const note = a.runs.map((r) => r.notes).filter(Boolean).join(" / ");
    tip.innerHTML = `<div class="t-date">${esc(rel ? `${rel}, ${calDate(a.date)}` : calDate(a.date))}${a.runs.length > 1 ? ` <span class="faint">(${a.runs.length} runs)</span>` : ""}</div>
      <div class="t-grid">
        <b class="d">${esc(fmtKm(a.km))}</b><b>${esc(fmtDur(a.s))}</b><b class="p">${fmtPace(a.s / a.km)}</b>
        <span>km</span><span>time</span><span>min/km</span>
      </div>
      ${note ? `<div class="t-note">${esc(note)}</div>` : ""}`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const bx = box.offsetLeft, by = box.offsetTop;
    const maxLeft = box.clientWidth - tw;
    let left = x + 14;
    if (left > maxLeft) left = x - tw - 14;
    left = Math.max(0, Math.min(maxLeft, left));
    tip.style.left = `${bx + left}px`;
    tip.style.top = `${by + 10}px`;
  }
  function hideTip() { const t = $("#tip"); if (t) t.hidden = true; }

  /* ---------- rendering: ledger (split sheet, by week) ---------- */
  const STAR = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 0l1.5 3.2 3.5.4-2.6 2.4.7 3.5L5 7.8 1.9 9.5l.7-3.5L0 3.6l3.5-.4z"/></svg>';

  function weekName(ws) {
    const cw = startOfWeek(todayD());
    const diff = dayDiff(ws, cw);
    if (diff === 0) return "This week";
    if (diff === 7) return "Last week";
    if (diff < 0) return `Week of ${dfShort.format(ws)}`;
    return `Week of ${(ws.getFullYear() === cw.getFullYear() ? dfShort : dfShortY).format(ws)}`;
  }

  function renderLedger() {
    const list = $("#ledger");
    const runs = state.runs.slice().reverse();
    $("#runs-count").textContent = runs.length ? `${runs.length} ${runs.length === 1 ? "run" : "runs"}` : "";
    $(".ledger-head").hidden = !runs.length;
    if (!runs.length) {
      list.innerHTML = `<li class="ledger-empty">No runs yet. Your runs will be listed here, newest first, week by week.</li>`;
      $("#show-all").hidden = true;
      return;
    }
    const { longest, fastest } = bests(state.runs);
    const wk = byWeek(state.runs);
    const maxKm = Math.max(...runs.map((r) => r.distanceKm));
    const shown = state.showAll ? runs : runs.slice(0, LIST_LIMIT);
    const today = iso(new Date());
    let curWeek = null;
    const html = [];
    for (const r of shown) {
      const d = parse(r.date);
      const wsKey = iso(startOfWeek(d));
      if (wsKey !== curWeek) {
        curWeek = wsKey;
        const w = wk.get(wsKey) || { km: 0, n: 0 };
        html.push(`<li class="wk-sep${wsKey === iso(startOfWeek(todayD())) ? " now" : ""}">
          <span class="wk-name">${esc(weekName(parse(wsKey)))}</span>
          <span class="wk-sum"><b>${esc(fmtKm(w.km))}</b> km in ${w.n} ${w.n === 1 ? "run" : "runs"}</span>
        </li>`);
      }
      const isLong = longest && r.runId === longest.runId;
      const isFast = fastest && r.runId === fastest.runId;
      const tags = [];
      if (isLong) tags.push(`<span class="tag">${STAR}Longest run</span>`);
      if (isFast) tags.push(`<span class="tag">${STAR}Fastest pace</span>`);
      const pace = fmtPace(r.durationSeconds / r.distanceKm);
      html.push(`<li class="run${r.runId === state.fresh ? " fresh" : ""}" data-id="${esc(r.runId)}">
        <div class="r-date${r.date === today ? " today" : ""}" title="${esc(dfFull.format(d))}">
          <span class="sr">${esc(relLabel(r.date) ? `${relLabel(r.date)}, ` : "")}${esc(dfFull.format(d))}</span>
          <b aria-hidden="true">${d.getDate()}</b><span aria-hidden="true">${esc(r.date === today ? "Today" : dfDay.format(d))}</span>
        </div>
        <div class="r-dist${isLong ? " best" : ""}"><span class="n">${esc(fmtKm(r.distanceKm))}<small>km</small></span><span class="meter" aria-hidden="true"><i style="--w:${((r.distanceKm / maxKm) * 100).toFixed(1)}%"></i></span></div>
        <div class="r-time r" aria-label="Time ${esc(fmtDur(r.durationSeconds))}">${esc(fmtDur(r.durationSeconds))}</div>
        <div class="r-pace r${isFast ? " best" : ""}" aria-label="Pace ${pace} per km">${pace}<small>/km</small></div>
        <div class="r-note${!r.notes && !tags.length ? " no-note" : ""}">${r.notes ? `<span class="txt">${esc(r.notes)}</span>` : ""}${tags.join("")}</div>
      </li>`);
    }
    list.innerHTML = html.join("");
    const more = $("#show-all");
    more.hidden = runs.length <= LIST_LIMIT;
    more.textContent = state.showAll ? "Show fewer" : `Show all ${runs.length} runs`;
    more.setAttribute("aria-expanded", String(state.showAll));
  }

  /* ---------- form ---------- */
  const form = $("#run-form");
  const fDate = $("#f-date"), fDist = $("#f-dist"), fTime = $("#f-time"), fNote = $("#f-note");
  const saveBtn = $("#save"), formErr = $("#form-error"), repeatBtn = $("#repeat");
  const quick = [...document.querySelectorAll(".qd")];

  function syncQuick() {
    const t = todayD();
    quick.forEach((b) => b.setAttribute("aria-pressed", String(fDate.value === iso(addDays(t, -Number(b.dataset.days))))));
  }
  function resetDate() {
    const t = iso(new Date());
    fDate.value = t;
    fDate.max = t;
    syncQuick();
  }
  quick.forEach((b) => b.addEventListener("click", () => {
    fDate.value = iso(addDays(todayD(), -Number(b.dataset.days)));
    fDate.removeAttribute("aria-invalid");
    syncQuick();
  }));
  fDate.addEventListener("input", syncQuick);
  fDate.addEventListener("change", syncQuick);

  function updatePreview() {
    const km = parseKm(fDist.value), s = parseTime(fTime.value);
    const pv = $("#preview");
    if (km && s) { $("#pv-value").textContent = fmtPace(s / km); pv.classList.remove("idle"); }
    else { $("#pv-value").textContent = "–:––"; pv.classList.add("idle"); }
  }
  function showFormError(msg, field) {
    formErr.textContent = msg;
    formErr.hidden = false;
    [fDist, fTime, fDate].forEach((f) => f.removeAttribute("aria-invalid"));
    if (field) { field.setAttribute("aria-invalid", "true"); field.focus(); }
  }
  function clearFormError() {
    formErr.hidden = true;
    [fDist, fTime, fDate].forEach((f) => f.removeAttribute("aria-invalid"));
  }
  function renderRepeat() {
    const runs = state.runs;
    if (!runs.length) { repeatBtn.hidden = true; return; }
    const last = runs[runs.length - 1];
    const full = `${fmtKm(last.distanceKm)} km in ${fmtDur(last.durationSeconds)}`;
    repeatBtn.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 0 1 8.5-3.5L13 6M13 2.5V6H9.5M13 8a5 5 0 0 1-8.5 3.5L3 10M3 13.5V10h3.5"/></svg>Repeat ${esc(fmtKm(last.distanceKm))} km`;
    repeatBtn.title = `Fill in your last run: ${full}`;
    repeatBtn.setAttribute("aria-label", `Same as last run: ${full}`);
    repeatBtn.hidden = false;
    repeatBtn.onclick = () => {
      fDist.value = String(last.distanceKm);
      fTime.value = fmtDur(last.durationSeconds);
      updatePreview();
      clearFormError();
      fTime.focus();
      fTime.select();
    };
  }

  fDist.addEventListener("input", () => { updatePreview(); fDist.removeAttribute("aria-invalid"); });
  fTime.addEventListener("input", () => { updatePreview(); fTime.removeAttribute("aria-invalid"); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearFormError();
    const date = fDate.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return showFormError("Pick the day of the run.", fDate);
    const km = parseKm(fDist.value);
    if (!km) return showFormError("Enter the distance in km, like 5 or 7.5.", fDist);
    const secs = parseTime(fTime.value);
    if (!secs) return showFormError("Enter the time as minutes and seconds, like 28:30, or h:mm:ss.", fTime);
    const input = { distanceKm: km, durationSeconds: secs, date };
    const note = fNote.value.trim();
    if (note) input.notes = note;

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    let res;
    try {
      res = await call("record_run", input);
    } catch (err) {
      showFormError(err.message);
      saveBtn.disabled = false;
      saveBtn.textContent = "Save run";
      return;
    }
    state.fresh = res && res.runId;
    fDist.value = ""; fTime.value = ""; fNote.value = "";
    resetDate();
    updatePreview();
    saveBtn.disabled = false;
    saveBtn.textContent = "Save run";
    toast(`Saved ${fmtKm(km)} km at ${fmtPace(secs / km)} /km`);
    await load();
  });

  function toast(msg) {
    const region = $("#toasts");
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    region.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  /* ---------- range, list toggles ---------- */
  function setRange(r) {
    state.range = r;
    document.querySelectorAll("#ranges button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.range === r)));
    renderChart();
  }
  document.querySelectorAll("#ranges button").forEach((b) => b.addEventListener("click", () => setRange(b.dataset.range)));
  $("#show-all").addEventListener("click", () => { state.showAll = !state.showAll; renderLedger(); });
  $("#retry").addEventListener("click", () => load());

  /* ---------- load ---------- */
  function renderAll() {
    renderHeader();
    renderWeek();
    renderMonth();
    renderChart();
    renderLedger();
    renderRepeat();
  }

  async function load() {
    const t = new Date();
    const ws = startOfWeek(todayD());
    const ms = new Date(t.getFullYear(), t.getMonth(), 1);
    const me = new Date(t.getFullYear(), t.getMonth() + 1, 0);
    const lms = new Date(t.getFullYear(), t.getMonth() - 1, 1);
    const lme = addDays(ms, -1);
    try {
      const [list, week, month, lastMonth] = await Promise.all([
        call("list_runs", {}),
        call("get_summary", { from: iso(ws), to: iso(addDays(ws, 6)) }),
        call("get_summary", { from: iso(ms), to: iso(me) }),
        call("get_summary", { from: iso(lms), to: iso(lme) }),
      ]);
      state.runs = (list && Array.isArray(list.runs)) ? list.runs : [];
      state.week = week; state.month = month; state.lastMonth = lastMonth;
      state.loaded = true;
      $("#load-error").hidden = true;
    } catch (err) {
      $("#load-error-text").textContent = `Couldn't load your runs. ${err.message}`;
      $("#load-error").hidden = false;
    }
    renderAll();
    if (state.fresh) setTimeout(() => { state.fresh = null; }, 2600);
  }

  let rz = 0, lastW = 0;
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      const w = $("#chart").clientWidth;
      if (Math.abs(w - lastW) < 2) return;
      lastW = w;
      cancelAnimationFrame(rz);
      rz = requestAnimationFrame(() => { if (state.loaded) renderChart(); });
    }).observe($("#chart"));
  }

  resetDate();
  updatePreview();
  load();
})();
