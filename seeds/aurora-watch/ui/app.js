// SPDX-License-Identifier: Apache-2.0
"use strict";
(() => {
  const app = document.getElementById("app");
  const toasts = document.getElementById("toasts");
  const HOUR = 3_600_000;
  const RATING_WORD = { none: "Too light", low: "Low", possible: "Possible", good: "Good" };
  const RANK = { none: 0, low: 1, possible: 2, good: 3 };
  const BROWSER_TZ = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
  })();
  const PICKS = [
    { name: "Tromsø", latitude: 69.65, longitude: 18.96, timezone: "Europe/Oslo" },
    { name: "Abisko", latitude: 68.35, longitude: 18.83, timezone: "Europe/Stockholm" },
    { name: "Rovaniemi", latitude: 66.5, longitude: 25.73, timezone: "Europe/Helsinki" },
    { name: "Reykjavík", latitude: 64.15, longitude: -21.94, timezone: "Atlantic/Reykjavik" },
    { name: "Fairbanks", latitude: 64.84, longitude: -147.72, timezone: "America/Anchorage" },
    { name: "Yellowknife", latitude: 62.45, longitude: -114.37, timezone: "America/Edmonton" },
  ];

  const S = {
    place: null,
    dark: null, // dark_window for tonight
    tonightDate: null,
    tonight: null, // stored forecast for tonight
    nights: [],
    limit: 14,
    fetch: "idle", // the one fetch on open: idle | fetching | failed | done
    autoTried: false,
    refreshing: false,
    refreshError: null,
    loadError: null,
    formOpen: false,
    selected: null,
  };
  const ribbons = {}; // key -> { f, empty, showNow }
  const skies = {}; // key -> sky description for the sky window

  // ---------- helpers ----------

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmtKp = (kp) => String(Number(Number(kp).toFixed(2)));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

  async function call(op, input = {}) {
    try {
      const out = await hewn.call(op, input);
      if (out && out.error) return { ok: false, message: out.message || String(out.error) };
      return { ok: true, value: out && out.result !== undefined ? out.result : null };
    } catch {
      return { ok: false, message: "Couldn't reach Aurora Watch. Check your connection and try again." };
    }
  }

  const fmts = new Map();
  function fmt(opts, tz) {
    const key = JSON.stringify([opts, tz]);
    let f = fmts.get(key);
    if (!f) {
      try { f = new Intl.DateTimeFormat(opts.locale ?? undefined, { ...opts, locale: undefined, timeZone: tz }); }
      catch { f = new Intl.DateTimeFormat(undefined, { ...opts, locale: undefined, timeZone: "UTC" }); }
      fmts.set(key, f);
    }
    return f;
  }
  const tz = () => S.place?.timezone || BROWSER_TZ;
  function parts(ms, zone = tz()) {
    const p = {};
    for (const x of fmt({ locale: "en-CA", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, zone).formatToParts(new Date(ms))) p[x.type] = x.value;
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) };
  }
  const hhmm = (ms) => {
    const p = parts(ms);
    return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  };
  function addDays(date, n) {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  const dateMs = (date) => Date.parse(`${date}T12:00:00Z`);
  const dayLong = (date) => fmt({ weekday: "long", day: "numeric", month: "long" }, "UTC").format(dateMs(date));
  const dayShort = (date) => fmt({ weekday: "short", day: "numeric", month: "short" }, "UTC").format(dateMs(date));
  const weekday = (date) => fmt({ weekday: "short" }, "UTC").format(dateMs(date));
  const dayNum = (date) => String(Number(date.slice(8, 10)));

  /** "tonight", "last night", or "Sunday 15 February". */
  function nightName(date) {
    if (S.tonightDate && date === S.tonightDate) return "Tonight";
    if (S.tonightDate && date === addDays(S.tonightDate, -1)) return "Last night";
    return dayLong(date);
  }

  /** "today 14:00", "yesterday 21:10", "15 Feb, 15:00", in the place's time. */
  function fetchedText(iso) {
    const ms = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(ms)) return "at an unknown time";
    const d = parts(ms).date;
    const today = parts(Date.now()).date;
    if (d === today) return `today ${hhmm(ms)}`;
    if (d === addDays(today, -1)) return `yesterday ${hhmm(ms)}`;
    const sameYear = d.slice(0, 4) === today.slice(0, 4);
    const day = fmt({ day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) }, "UTC").format(dateMs(d));
    return `${day}, ${hhmm(ms)}`;
  }

  const coord = (v, pos, neg) => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? pos : neg}`;

  function toast(text) {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = text;
    toasts.append(el);
    setTimeout(() => el.remove(), 3200);
  }

  // ---------- small drawings ----------

  /** Where tonight sits on the low / possible / good scale. */
  function scaleHTML(rating) {
    const n = RANK[rating] ?? 0;
    const steps = [["low", "Low"], ["possible", "Possible"], ["good", "Good"]];
    const label = rating === "none" ? "Too light for aurora" : `Chance ${RATING_WORD[rating] || rating}, on a scale of low, possible, good`;
    return `<div class="scale" role="img" aria-label="${esc(label)}">${steps
      .map(([k, w], i) => `<span class="sc-step ${n >= i + 1 ? "on" : ""} ${n === i + 1 ? "here" : ""}" data-rating="${k}"><i></i>${w}</span>`)
      .join("")}</div>`;
  }

  /** The lit part of a moon disc at (cx, cy), lit by `f` (0 new … 1 full). */
  function moonLit(cx, cy, r, f, fill) {
    if (f >= 0.99) return `<circle cx="${cx}" cy="${cy}" r="${r}" style="fill:${fill}"/>`;
    if (f <= 0.01) return "";
    const rx = (r * Math.abs(1 - 2 * f)).toFixed(2);
    const sweep = f > 0.5 ? 1 : 0;
    return `<path d="M${cx} ${cy - r} A${r} ${r} 0 0 1 ${cx} ${cy + r} A${rx} ${r} 0 0 ${sweep} ${cx} ${cy - r}Z" style="fill:${fill}"/>`;
  }

  /** A moon disc lit by `b` (0 new … 1 full). */
  function moonSVG(b, size = 34) {
    const c = size / 2, r = size / 2 - 1.5;
    const f = Math.max(0, Math.min(1, Number(b) || 0));
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${c}" cy="${c}" r="${r}" fill="var(--surface-3)" stroke="var(--border-strong)" stroke-width="1"/>${moonLit(c, c, r, f, "var(--moon)")}</svg>`;
  }

  const ICON = {
    refresh: `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 6.2A5.4 5.4 0 0 0 3.1 5"/><path d="M2.8 9.8A5.4 5.4 0 0 0 12.9 11"/><path d="M13.4 2.6v3.6H9.8"/><path d="M2.6 13.4V9.8h3.6"/></svg>`,
    pin: `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M8 14.5s4.6-4.3 4.6-8a4.6 4.6 0 0 0-9.2 0c0 3.7 4.6 8 4.6 8Z"/><circle cx="8" cy="6.5" r="1.7"/></svg>`,
  };

  /** A small deterministic random source, so a night's sky looks the same every time. */
  function rng(seed) {
    let h = 2166136261 >>> 0;
    for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return () => {
      h = (h + 0x6d2b79f5) | 0;
      let t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- the sky window ----------

  /** Describe a night's sky from a stored forecast (or just the dark window). */
  function skyOf(f, key, { known = true } = {}) {
    return {
      key,
      date: f.night_date || f.date || S.tonightDate || "",
      dark: !!(f.dark_start && f.dark_end),
      known,
      kp: known ? f.kp_max ?? null : null,
      cloud: known ? f.cloud_avg_pct ?? null : null,
      moon: f.moon_brightness ?? null,
      darkStart: f.dark_start || null,
    };
  }

  function skySVG(s, W) {
    const p = S.place;
    const phone = W < 480;
    const H = Math.round(Math.max(168, Math.min(260, W * (phone ? 0.5 : 0.46))));
    const R = rng(`${s.date}|${p.latitude}|${p.longitude}`);
    const k = s.key;
    const hz = H * 0.8;
    const moonB = Math.max(0, Math.min(1, Number(s.moon) || 0));
    const cloud = s.cloud === null || s.cloud === undefined ? 0 : Math.max(0, Math.min(100, s.cloud)) / 100;
    const hasAurora = s.dark && s.known && s.kp !== null && s.kp !== undefined;
    let st = 0;
    if (hasAurora) {
      st = Math.max(0, Math.min(1, s.kp / Math.max(3, p.kp_good * 2.2)));
      if (s.kp + 1e-9 < p.kp_possible) st *= 0.35;
      else if (s.kp + 1e-9 < p.kp_good) st *= 0.75;
    }
    const strong = st > 0.68;
    const o = [];
    o.push(`<defs>
      <linearGradient id="sk-${k}" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" style="stop-color:var(${s.dark ? "--sky-top" : "--dusk-top"})"/>
        <stop offset=".75" style="stop-color:var(${s.dark ? "--sky-low" : "--dusk-low"})"/>
      </linearGradient>
      <linearGradient id="ray-${k}" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" style="stop-color:var(--sky-violet);stop-opacity:0"/>
        <stop offset=".3" style="stop-color:var(--sky-violet);stop-opacity:${strong ? 0.6 : 0.14}"/>
        <stop offset=".72" style="stop-color:var(--sky-aurora);stop-opacity:.95"/>
        <stop offset="1" style="stop-color:var(--sky-aurora);stop-opacity:0"/>
      </linearGradient>
      <radialGradient id="mg-${k}"><stop offset="0" style="stop-color:var(--sky-moon);stop-opacity:.5"/><stop offset="1" style="stop-color:var(--sky-moon);stop-opacity:0"/></radialGradient>
      <filter id="bl-${k}" x="-5%" y="-20%" width="110%" height="140%"><feGaussianBlur stdDeviation="${phone ? 1.4 : 1.8}"/></filter>
      <filter id="cl-${k}" x="-40%" y="-80%" width="180%" height="260%"><feGaussianBlur stdDeviation="${(H * 0.045).toFixed(1)}"/></filter>
    </defs>`);
    o.push(`<rect width="${W}" height="${H}" fill="url(#sk-${k})"/>`);

    // stars, washed out by moonlight and hidden by cloud
    if (s.dark) {
      const vis = (1 - 0.55 * moonB) * (1 - (s.known ? 0.92 * cloud : 0));
      const n = Math.round((W * H) / 1300);
      const st0 = [];
      for (let i = 0; i < n; i++) {
        const x = R() * W, y = R() * hz * 0.96, r = 0.35 + R() ** 3 * 1.15, a = (0.25 + R() * 0.75) * vis, tw = R() < 0.14;
        if (a < 0.06) continue;
        st0.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" style="fill:var(--sky-star);opacity:${a.toFixed(2)}${tw ? `;animation-delay:-${(R() * 4).toFixed(1)}s` : ""}"${tw ? ' class="twinkle"' : ""}/>`);
      }
      o.push(`<g>${st0.join("")}</g>`);
    }

    // the moon, with a halo as bright as it is
    if (s.moon !== null && s.moon !== undefined) {
      const mr = Math.max(9, Math.min(15, W * 0.024));
      const mx = W * (phone ? 0.84 : 0.86), my = H * 0.2;
      o.push(`<circle cx="${mx}" cy="${my}" r="${(mr * (2.4 + 3.2 * moonB)).toFixed(1)}" fill="url(#mg-${k})" style="opacity:${(0.15 + 0.85 * moonB).toFixed(2)}"/>`);
      o.push(`<circle cx="${mx}" cy="${my}" r="${mr}" style="fill:var(--sky-moon-dark)"/>`);
      o.push(moonLit(mx, my, mr, moonB, "var(--sky-moon)"));
    }

    // aurora curtains: rays along wavy arcs, as tall as Kp is strong for this place
    if (hasAurora && st > 0.02) {
      const rays = [];
      const bands = 3;
      for (let b = 0; b < bands; b++) {
        const x0 = W * (-0.08 + b * 0.27 + R() * 0.12), len = W * (0.42 + R() * 0.38);
        const base = hz - H * (0.08 + b * 0.06 + R() * 0.05);
        const amp = H * (0.03 + R() * 0.05), freq = (2 * Math.PI) / (W * (0.28 + R() * 0.3)), ph = R() * 6.28;
        const hMax = H * (0.2 + 0.5 * st) * (1 - b * 0.1);
        const step = phone ? 2.6 : 3;
        for (let x = x0; x < x0 + len; x += step) {
          if (x < -4 || x > W + 4) continue;
          const t = (x - x0) / len;
          const env = Math.sin(Math.PI * t) ** 0.6;
          const y = base - amp * Math.sin(x * freq + ph);
          const h = hMax * env * (0.5 + 0.5 * R());
          if (h < 3) continue;
          const a = (0.3 + 0.55 * st) * (0.55 + 0.45 * R());
          rays.push(`<rect x="${x.toFixed(1)}" y="${(y - h).toFixed(1)}" width="${(step * 0.85).toFixed(1)}" height="${h.toFixed(1)}" fill="url(#ray-${k})" style="opacity:${a.toFixed(2)}"/>`);
        }
      }
      o.push(`<g class="curtains" filter="url(#bl-${k})">${rays.join("")}</g>`);
    }

    // cloud: a haze over the whole sky plus soft banks, as thick as the cover
    if (s.known && cloud > 0.02) {
      o.push(`<rect width="${W}" height="${hz}" style="fill:var(--sky-cloud);opacity:${(cloud * 0.5).toFixed(2)}"/>`);
      const n = Math.round(3 + cloud * 9);
      const banks = [];
      for (let i = 0; i < n; i++) {
        const cx = R() * W * 1.1 - W * 0.05, cy = H * (0.08 + R() * 0.62);
        const rx = W * (0.1 + R() * 0.16) * (0.6 + cloud * 0.7), ry = H * (0.05 + R() * 0.07);
        banks.push(`<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" style="fill:var(--sky-cloud);opacity:${((0.4 + 0.5 * R()) * cloud).toFixed(2)}"/>`);
      }
      o.push(`<g class="clouds" filter="url(#cl-${k})">${banks.join("")}</g>`);
    }

    // hills, and a cabin with its light on
    const ridge = (yBase, rough, n) => {
      const pts = [];
      for (let i = 0; i <= n; i++) pts.push([(i / n) * W, yBase - R() * rough]);
      let d = `M0 ${H} L${pts[0][0]} ${pts[0][1].toFixed(1)}`;
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
        d += ` Q${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
      }
      const last = pts[pts.length - 1];
      return { d: `${d} L${last[0]} ${last[1].toFixed(1)} L${W} ${H}Z`, pts };
    };
    const far = ridge(hz - H * 0.02, H * 0.14, phone ? 7 : 10);
    o.push(`<path d="${far.d}" style="fill:var(--sky-ridge-2)"/>`);
    const near = ridge(hz + H * 0.08, H * 0.08, phone ? 5 : 8);
    o.push(`<path d="${near.d}" style="fill:var(--sky-ridge)"/>`);
    if (s.dark) {
      const cx = W * (phone ? 0.58 : 0.6);
      const seg = near.pts.findIndex((q) => q[0] >= cx);
      const a = near.pts[Math.max(0, seg - 1)], b = near.pts[Math.max(0, seg)];
      const gy = Math.max(a[1], b[1]) + 2;
      const cw = phone ? 12 : 15, ch = cw * 0.62;
      o.push(`<g style="fill:var(--sky-ridge)"><rect x="${cx}" y="${gy - ch}" width="${cw}" height="${ch + 4}"/><path d="M${cx - 2} ${gy - ch + 0.5} L${cx + cw / 2} ${gy - ch - cw * 0.45} L${cx + cw + 2} ${gy - ch + 0.5}Z"/></g>`);
      o.push(`<rect x="${cx + cw * 0.58}" y="${gy - ch * 0.72}" width="${(cw * 0.22).toFixed(1)}" height="${(cw * 0.22).toFixed(1)}" style="fill:var(--sky-window)"/>`);
    }

    let label;
    if (!s.dark) label = "Too light for aurora: the sky never gets properly dark.";
    else if (!s.known) label = `A dark sky from ${s.darkStart ? hhmm(Date.parse(s.darkStart)) : "nightfall"}; Kp and cloud come with the forecast.`;
    else label = `The night sky drawn from the forecast: aurora at Kp ${s.kp !== null ? fmtKp(s.kp) : "unknown"} against ${fmtKp(p.kp_good)} needed here, ${Math.round(cloud * 100)}% cloud, moon ${Math.round(moonB * 100)}% lit.`;
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${o.join("")}</svg>`;
  }

  function skyCaption(s) {
    const p = S.place;
    if (!s.dark) return `<span class="sc"><b>Too light</b><small>The sun stays above −12°</small></span>`;
    if (!s.known || s.kp === null) {
      return `<span class="sc"><b>${s.darkStart ? `Dark from ${hhmm(Date.parse(s.darkStart))}` : "Dark tonight"}</b><small>Kp and cloud come with the forecast</small></span>`;
    }
    const above = s.kp + 1e-9 >= p.kp_good;
    const left = `<span class="sc"><b>Kp ${fmtKp(s.kp)}</b><small>${above ? `${fmtKp(p.kp_good)} is enough here` : `${fmtKp(p.kp_good)} needed here`}</small></span>`;
    const right = s.cloud === null ? "" : `<span class="sc r"><b>${Math.round(s.cloud)}%</b><small>cloud</small></span>`;
    return left + right;
  }

  function skyFigure(s, cls = "") {
    skies[s.key] = s;
    return `<figure class="sky-fig ${cls}"><div class="sky" data-sky="${esc(s.key)}"></div><figcaption class="sky-cap">${skyCaption(s)}</figcaption></figure>`;
  }

  function glyph(size = 56) {
    const cells = [[0, 2], [1, 1], [2, 0], [3, 1], [4, 2], [0, 3], [1, 2], [2, 1], [3, 2], [4, 3], [0, 4], [2, 4], [4, 4]];
    return `<svg width="${size}" height="${size}" viewBox="-0.5 -0.5 6 6" aria-hidden="true" shape-rendering="crispEdges">${cells
      .map(([x, y]) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${y >= 3 ? "var(--teal)" : "var(--aurora)"}"/>`)
      .join("")}</svg>`;
  }

  // ---------- the night ribbon ----------

  function ribbonSVG(r, W) {
    const f = r.f;
    const place = S.place;
    const phone = W < 560;
    const padL = 42, padR = 8, top = 22, kpH = phone ? 120 : 160, gap = 8, cloudH = 24, axisH = 20;
    const cloudTop = top + kpH + gap;
    const H = cloudTop + cloudH + axisH;
    const ds = Date.parse(f.dark_start), de = Date.parse(f.dark_end);
    const edge = Math.min(2 * HOUR, Math.max(HOUR, (de - ds) * 0.12));
    const x0 = ds - edge, x1 = de + edge;
    const iw = W - padL - padR;
    const X = (t) => padL + ((Math.min(Math.max(t, x0), x1) - x0) / (x1 - x0)) * iw;
    const kps = (f.kp_slots || []).map((s) => s.kp);
    const good = place.kp_good, possible = place.kp_possible;
    const yMax = Math.min(9, Math.max(4, Math.ceil(Math.max(good, 0, ...kps) + 0.5)));
    const Y = (kp) => top + kpH - (kp / yMax) * kpH;
    const o = [];

    const at = (t) => (((X(t) - padL) / iw) || 0).toFixed(4);
    o.push(`<defs>
      <linearGradient id="nt-${r.key}" x1="${padL}" x2="${padL + iw}" y1="0" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0" style="stop-color:var(--night);stop-opacity:0"/>
        <stop offset="${at(ds)}" style="stop-color:var(--night);stop-opacity:.16"/>
        <stop offset="${at(de)}" style="stop-color:var(--night);stop-opacity:.16"/>
        <stop offset="1" style="stop-color:var(--night);stop-opacity:0"/>
      </linearGradient>
      <linearGradient id="gg-${r.key}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style="stop-color:var(--aurora);stop-opacity:.4"/><stop offset=".7" style="stop-color:var(--aurora);stop-opacity:1"/></linearGradient>
      <linearGradient id="gp-${r.key}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style="stop-color:var(--teal);stop-opacity:.4"/><stop offset=".7" style="stop-color:var(--teal);stop-opacity:1"/></linearGradient>
    </defs>`);

    // darkness, with twilight fading in and out
    o.push(`<rect x="${padL}" y="${top}" width="${iw}" height="${kpH}" rx="6" fill="url(#nt-${r.key})"/>`);
    if (X(de) - X(ds) > 70) o.push(`<text class="rb-dark" x="${X(ds) + 6}" y="${top + 13}">dark ${hhmm(ds)}</text>`);

    // Kp grid
    const step = yMax <= 5 ? 1 : 3;
    for (let k = 0; k <= yMax; k += step) {
      o.push(`<line x1="${padL}" x2="${padL + iw}" y1="${Y(k)}" y2="${Y(k)}" stroke="var(--border)" ${k ? 'stroke-dasharray="2 4"' : ""}/>`);
      o.push(`<text class="rb-tick" x="${padL - 6}" y="${Y(k) + 3.5}" text-anchor="end">${k}</text>`);
    }
    o.push(`<text class="rb-side" x="${padL - 6}" y="${top - 8}" text-anchor="end">Kp</text>`);

    // Kp curtains, 3-hour slots
    const kpLabels = [];
    for (const s of f.kp_slots || []) {
      const t0 = Date.parse(s.time), t1 = t0 + 3 * HOUR;
      if (t1 <= x0 || t0 >= x1) continue;
      const xa = X(t0) + 1, xb = X(t1) - 1, w = xb - xa;
      if (w <= 0) continue;
      const h = Math.max(1.5, (s.kp / yMax) * kpH);
      const fill = s.kp + 1e-9 >= good ? `url(#gg-${r.key})` : s.kp + 1e-9 >= possible ? `url(#gp-${r.key})` : "color-mix(in oklch, var(--slate) 45%, transparent)";
      o.push(`<rect x="${xa.toFixed(1)}" y="${(top + kpH - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3" style="fill:${fill}"><title>${hhmm(t0)}–${hhmm(t1)}: Kp ${fmtKp(s.kp)}</title></rect>`);
      if (w >= 26) kpLabels.push(`<text class="rb-kp" x="${(xa + w / 2).toFixed(1)}" y="${(top + kpH - h - 4).toFixed(1)}" text-anchor="middle">${fmtKp(s.kp)}</text>`);
    }

    // what this place needs
    const yG = Y(good), yP = Y(possible);
    const tag = (text, cls, yBase) => {
      const w = text.length * 5.8 + 10;
      const xr = padL + iw - 2;
      return `<rect x="${(xr - w).toFixed(1)}" y="${(yBase - 11).toFixed(1)}" width="${w.toFixed(1)}" height="15" rx="4" fill="var(--surface-solid)" fill-opacity=".92"/>` +
        `<text class="rb-thresh ${cls}" x="${xr - 5}" y="${yBase}" text-anchor="end">${text}</text>`;
    };
    o.push(`<line x1="${padL}" x2="${padL + iw}" y1="${yG}" y2="${yG}" stroke="var(--aurora)" stroke-width="1.5" stroke-dasharray="6 4"/>`);
    // on a phone the tags would sit on the bars; the legend names both lines there
    const thresholds = phone ? [] : [tag(`good here from Kp ${fmtKp(good)}`, "t-good", yG - 5)];
    if (possible > 0) {
      o.push(`<line x1="${padL}" x2="${padL + iw}" y1="${yP}" y2="${yP}" stroke="var(--teal)" stroke-width="1.5" stroke-dasharray="2 4"/>`);
      const below = Math.abs(yP - yG) < 18;
      if (!phone) thresholds.push(tag(`possible from ${fmtKp(possible)}`, "t-possible", below ? yP + 14 : yP - 5));
    }
    // drawn after the bars (below) so the labels stay readable over them
    const thresholdLabels = thresholds.join("");

    // cloud band, hourly
    o.push(`<rect x="${padL}" y="${cloudTop}" width="${iw}" height="${cloudH}" rx="4" fill="var(--surface-2)"/>`);
    o.push(`<text class="rb-side" x="${padL - 6}" y="${cloudTop + cloudH / 2 + 3.5}" text-anchor="end">Cloud</text>`);
    const veils = [];
    for (const c of f.cloud_slots || []) {
      const t0 = Date.parse(c.time), t1 = t0 + HOUR;
      if (t1 <= x0 || t0 >= x1) continue;
      const xa = X(t0), w = X(t1) - xa;
      if (w <= 0) continue;
      const pct = Math.max(0, Math.min(100, c.pct)) / 100;
      const a = (0.08 + 0.92 * pct).toFixed(2);
      o.push(`<rect x="${xa.toFixed(1)}" y="${cloudTop}" width="${(w + 0.4).toFixed(1)}" height="${cloudH}" fill="var(--cloud)" fill-opacity="${a}"><title>${hhmm(t0)}: ${Math.round(c.pct)}% cloud</title></rect>`);
      // the same cloud, veiling the sky above: what it hides of the aurora
      if (pct > 0.05) veils.push(`<rect x="${xa.toFixed(1)}" y="${top}" width="${(w + 0.4).toFixed(1)}" height="${kpH}" style="fill:var(--veil);opacity:${(pct * 0.62).toFixed(2)}"/>`);
    }
    if (veils.length) o.push(`<g pointer-events="none">${veils.join("")}</g>`);
    o.push(kpLabels.join(""));
    if (r.empty) {
      o.push(`<text class="rb-side" x="${padL + iw / 2}" y="${top + kpH / 2}" text-anchor="middle">Kp and cloud come with the forecast</text>`);
    }

    o.push(thresholdLabels);

    // best hour
    const b = f.best_hour;
    let bestX = null;
    if (b && b.start && b.end) {
      const bs = Date.parse(b.start), be = Date.parse(b.end);
      const xa = X(bs), w = Math.max(3, X(be) - xa);
      bestX = xa + w / 2;
      o.push(`<rect x="${xa.toFixed(1)}" y="${top - 3}" width="${w.toFixed(1)}" height="${cloudTop + cloudH - top + 6}" rx="5" fill="var(--violet)" fill-opacity=".08" stroke="var(--violet)" stroke-width="1.5"/>`);
      o.push(`<text class="rb-best" x="${bestX.toFixed(1)}" y="${top - 8}" text-anchor="middle">best</text>`);
    }

    // now
    const now = Date.now();
    if (r.showNow && now > x0 && now < x1) {
      const xn = X(now);
      o.push(`<line x1="${xn}" x2="${xn}" y1="${top - 2}" y2="${cloudTop + cloudH + 2}" stroke="var(--text-2)" stroke-width="1.2" stroke-dasharray="1 3"/>`);
      if (bestX === null || Math.abs(bestX - xn) > 36) o.push(`<text class="rb-now" x="${xn}" y="${top - 8}" text-anchor="middle">now</text>`);
    }

    // local hours along the bottom
    const pxPerHour = iw / ((x1 - x0) / HOUR);
    const hStep = [1, 2, 3, 4, 6].find((h) => h * pxPerHour >= (phone ? 40 : 46)) ?? 6;
    const q = 15 * 60_000;
    for (let t = Math.ceil(x0 / q) * q; t <= x1; t += q) {
      const p = parts(t);
      if (p.minute !== 0 || p.hour % hStep !== 0) continue;
      const x = X(t);
      if (x < padL + 14 || x > padL + iw - 14) continue;
      o.push(`<line x1="${x}" x2="${x}" y1="${cloudTop + cloudH}" y2="${cloudTop + cloudH + 4}" stroke="var(--border-strong)"/>`);
      o.push(`<text class="rb-tick" x="${x}" y="${H - 3}" text-anchor="middle">${String(p.hour).padStart(2, "0")}:00</text>`);
    }

    const summary = r.empty
      ? `Tonight is dark from ${hhmm(ds)} to ${hhmm(de)}; Kp and cloud come with the forecast.`
      : `Kp through the night, highest ${kps.length ? fmtKp(Math.max(...kps)) : "unknown"} against ${fmtKp(good)} for a good chance here; cloud ${f.cloud_avg_pct ?? "unknown"}% on average; dark from ${hhmm(ds)} to ${hhmm(de)}.`;
    return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(summary)}">${o.join("")}</svg>`;
  }

  function drawRibbons() {
    for (const el of app.querySelectorAll(".plot[data-key]")) {
      const r = ribbons[el.dataset.key];
      const w = Math.round(el.clientWidth);
      if (!r || !w || el.dataset.w === String(w)) continue;
      el.dataset.w = String(w);
      try { el.innerHTML = ribbonSVG(r, w); } catch { el.innerHTML = ""; }
    }
    for (const el of app.querySelectorAll(".sky[data-sky]")) {
      const s = skies[el.dataset.sky];
      const w = Math.round(el.clientWidth);
      if (!s || !w || el.dataset.w === String(w)) continue;
      el.dataset.w = String(w);
      try { el.innerHTML = skySVG(s, w); } catch { el.innerHTML = ""; }
    }
  }
  let resizeQueued = false;
  window.addEventListener("resize", () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; drawRibbons(); });
  });

  function legend(empty) {
    const p = S.place;
    if (empty) return `<div class="legend"><span><i class="lg-dark"></i>Dark window (sun below −12°)</span></div>`;
    return `<div class="legend">
      <span><i class="lg-good"></i>Kp good here (${fmtKp(p.kp_good)}+)</span>
      ${p.kp_possible > 0 ? `<span><i class="lg-possible"></i>Possible (${fmtKp(p.kp_possible)}+)</span><span><i class="lg-weak"></i>Too weak</span>` : `<span><i class="lg-possible"></i>Possible (any Kp reaches here)</span>`}
      <span><i class="lg-line"></i>Good from Kp ${fmtKp(p.kp_good)}</span>
      ${p.kp_possible > 0 ? `<span><i class="lg-line dotted"></i>Possible from Kp ${fmtKp(p.kp_possible)}</span>` : ""}
      <span><i class="lg-cloud"></i>Cloud, veiling the sky above</span>
      <span><i class="lg-dark"></i>Dark window</span>
      <span><i class="lg-best"></i>Best hour</span>
    </div>`;
  }

  function ribbonFigure(f, key, { empty = false, showNow = false, head = "" } = {}) {
    const top = head ? `<div class="ribbon-head">${head}</div>` : "";
    if (!f.dark_start || !f.dark_end) {
      delete ribbons[key];
      return `<div class="ribbon">${top}<div class="too-light">${moonSVG(1, 28)}<span>The sun stays above −12° all night here: too light for aurora.</span></div></div>`;
    }
    ribbons[key] = { f, empty, showNow, key };
    return `<figure class="ribbon">${top}<div class="plot" data-key="${esc(key)}"></div>${legend(empty)}</figure>`;
  }

  // ---------- facts ----------

  function factsHTML({ darkStart, darkEnd, moonB, moonLabel, best, hasForecast }) {
    let dark;
    if (darkStart && darkEnd) {
      const s = Date.parse(darkStart), e = Date.parse(darkEnd);
      dark = `<div class="fact-value">${hhmm(s)}–${hhmm(e)}</div><div class="fact-sub">${plural(Math.round((e - s) / HOUR), "hour", "hours")} of darkness</div>`;
    } else {
      dark = `<div class="fact-value soft">Too light</div><div class="fact-sub">The sun stays above −12°</div>`;
    }
    let moon;
    if (moonB !== null && moonB !== undefined) {
      const pct = Math.round(moonB * 100);
      const note = moonB >= 0.6 ? ", bright" : moonB <= 0.2 ? ", dark skies" : "";
      moon = `<div class="moon-row">${moonSVG(moonB, 26)}<span class="fact-value">${pct}%</span></div><div class="fact-sub">${esc(cap(moonLabel || "moon"))}${note}</div>`;
    } else moon = `<div class="fact-value soft">–</div><div class="fact-sub">Not known</div>`;
    let bestH;
    if (best && best.start && best.end) {
      const s = best.start_local || hhmm(Date.parse(best.start));
      const e = best.end_local || hhmm(Date.parse(best.end));
      const bits = [];
      if (best.kp !== null && best.kp !== undefined) bits.push(`Kp ${fmtKp(best.kp)}`);
      if (best.cloud_pct !== null && best.cloud_pct !== undefined) bits.push(`${Math.round(best.cloud_pct)}% cloud`);
      bestH = `<div class="fact-value">${esc(s)}–${esc(e)}</div><div class="fact-sub">${bits.join(", ") || "Highest Kp, clearest sky"}</div>`;
    } else if (!hasForecast) {
      bestH = `<div class="fact-value soft">–</div><div class="fact-sub">Comes with the forecast</div>`;
    } else {
      bestH = `<div class="fact-value soft">–</div><div class="fact-sub">${darkStart ? "No hour stands out" : "No dark hours"}</div>`;
    }
    return `<div class="facts">
      <div class="fact f-dark"><div class="fact-label"><i class="lg-dark" aria-hidden="true"></i>Dark window</div>${dark}</div>
      <div class="fact f-moon"><div class="fact-label">Moon</div>${moon}</div>
      <div class="fact f-best"><div class="fact-label"><i class="lg-best" aria-hidden="true"></i>Best hour</div>${bestH}</div>
    </div>`;
  }

  const factsOf = (f) => factsHTML({ darkStart: f.dark_start, darkEnd: f.dark_end, moonB: f.moon_brightness, moonLabel: f.moon_label, best: f.best_hour, hasForecast: true });

  // ---------- regions ----------

  function shell() {
    app.innerHTML = `<div id="r-bar"></div><div id="r-form"></div><div id="r-tonight"></div><div id="r-latest"></div><div id="r-history"></div>`;
  }
  const region = (id) => document.getElementById(id);

  function renderBar() {
    const p = S.place;
    const zone = p.timezone.replace(/_/g, " ");
    const there = p.timezone === BROWSER_TZ ? `Times in ${esc(zone)}` : `${esc(zone)} time, ${hhmm(Date.now())} there`;
    region("r-bar").innerHTML = `<header class="place-bar">
      <span class="brand-glyph">${glyph(30)}</span>
      <div class="place-id"><h1>${esc(p.name)}</h1>
        <div class="place-meta"><span class="num">${coord(p.latitude, "N", "S")}&nbsp;&nbsp;${coord(p.longitude, "E", "W")}</span><span>${there}</span></div>
      </div>
      <button type="button" class="quiet" data-act="change-place" aria-expanded="${S.formOpen}">${ICON.pin}Change place</button>
    </header>`;
  }

  function renderTonight() {
    const el = region("r-tonight");
    if (!el) return;
    const t = S.tonight, d = S.dark;
    const head = `<div class="sec-head"><h2>Tonight</h2>${S.tonightDate ? `<span class="when">${esc(dayLong(S.tonightDate))}</span>` : ""}</div>`;
    let verdict;
    const busy = S.refreshing || S.fetch === "fetching";
    const refreshBtn = `<button type="button" class="primary refresh ${S.refreshing ? "spinning" : ""}" data-act="refresh" ${busy ? "disabled" : ""}>${ICON.refresh}${S.refreshing ? "Refreshing…" : "Refresh"}</button>`;
    if (t) {
      verdict = `<div class="verdict" data-rating="${esc(t.rating)}">
        ${head}
        <div class="word">${esc(RATING_WORD[t.rating] || t.rating)}</div>
        ${scaleHTML(t.rating)}
        ${t.verdict ? `<p class="verdict-line">${esc(t.verdict)}</p>` : ""}
        <p class="reason">${esc(t.reason)}</p>
        <div class="actions-row">${refreshBtn}<span class="fetched">Fetched ${esc(fetchedText(t.fetched_at))}</span></div>
        ${S.refreshError ? `<div class="notice danger" role="alert">${esc(S.refreshError)}</div>` : ""}
      </div>`;
    } else if (S.fetch === "fetching") {
      verdict = `<div class="verdict" data-rating="unknown">
        ${head}
        <div class="word muted-word">Checking the forecast…</div>
        <p class="reason"><span class="checking"><span class="dot"></span>Asking NOAA for Kp and MET Norway for cloud</span></p>
        <div class="actions-row">${refreshBtn}</div>
      </div>`;
    } else {
      const failed = S.fetch === "failed";
      verdict = `<div class="verdict" data-rating="unknown">
        ${head}
        <div class="word muted-word">No forecast yet</div>
        <p class="reason">${failed ? "What's known without the network is shown here." : "Refresh to rate tonight."}</p>
        <div class="actions-row">${refreshBtn}</div>
        ${failed && !S.refreshError ? `<div class="notice info">Couldn't get tonight's forecast: you may be offline, or the forecast sources (NOAA and MET Norway) aren't approved yet.</div>` : ""}
        ${S.refreshError ? `<div class="notice danger" role="alert">${esc(S.refreshError)}</div>` : ""}
      </div>`;
    }

    let sky = "", fig = "";
    if (t) {
      sky = skyFigure(skyOf(t, "tonight"));
      fig = ribbonFigure(t, "tonight", { showNow: true, head: factsOf(t) });
    } else if (d) {
      const facts = factsHTML({ darkStart: d.dark_start, darkEnd: d.dark_end, moonB: d.moon_brightness, moonLabel: d.moon_label, best: null, hasForecast: false });
      sky = skyFigure(skyOf({ ...d, night_date: d.date }, "tonight", { known: false }));
      fig = ribbonFigure({ dark_start: d.dark_start, dark_end: d.dark_end, kp_slots: [], cloud_slots: [], best_hour: null }, "tonight", { empty: true, showNow: true, head: facts });
    } else {
      delete ribbons.tonight;
      delete skies.tonight;
    }
    const loadErr = S.loadError ? `<div class="notice danger load-error" role="alert">${esc(S.loadError)}</div>` : "";
    el.innerHTML = `<section class="tonight" aria-label="Tonight"><div class="hero ${sky ? "" : "solo"}">${verdict}${sky}</div>${fig}${loadErr}</section>`;
    drawRibbons();
  }

  function nightBody(f, key) {
    return `<div class="night-top">
        <div class="night-text">
          <div class="mini-verdict" data-rating="${esc(f.rating)}">
            <span class="word">${esc(RATING_WORD[f.rating] || f.rating)}</span>
            ${f.verdict ? `<p class="verdict-line">${esc(f.verdict)}</p>` : ""}
          </div>
          <p class="reason">${esc(f.reason)}</p>
          <p class="fetched">Fetched ${esc(fetchedText(f.fetched_at))}</p>
        </div>
        ${skyFigure(skyOf(f, key), "mini")}
      </div>
      ${ribbonFigure(f, key, { head: factsOf(f) })}`;
  }

  function renderLatest() {
    const el = region("r-latest");
    if (!el) return;
    const latest = S.nights.find((n) => n.night_date !== S.tonightDate);
    if (S.tonight || !latest) {
      el.innerHTML = "";
      delete ribbons.latest;
      delete skies.latest;
      return;
    }
    el.innerHTML = `<section class="latest" aria-label="Latest fetched night">
      <div class="sec-head"><h2>Latest fetched night</h2><span class="when">${esc(nightName(latest.night_date) === "Last night" ? `Last night, ${dayLong(latest.night_date)}` : dayLong(latest.night_date))}</span></div>
      ${nightBody(latest, "latest")}
    </section>`;
    drawRibbons();
  }

  function insightHTML(nights) {
    const n = nights.length;
    const withChance = nights.filter((x) => x.rating === "good" || x.rating === "possible");
    const best = [...nights].sort((a, b) =>
      (RANK[b.rating] ?? 0) - (RANK[a.rating] ?? 0) || (b.kp_max ?? -1) - (a.kp_max ?? -1) || (a.cloud_avg_pct ?? 101) - (b.cloud_avg_pct ?? 101),
    )[0];
    const bestBit = best && best.kp_max !== null
      ? ` Best: <strong>${esc(dayShort(best.night_date))}</strong>, Kp ${fmtKp(best.kp_max)} with ${Math.round(best.cloud_avg_pct ?? 0)}% cloud.`
      : "";
    if (!withChance.length) return `<p class="insight">None of ${n === 1 ? "this night" : `these ${n} nights`} had a real chance here.${bestBit}</p>`;
    return `<p class="insight"><strong>${withChance.length} of ${plural(n, "night", "nights")}</strong> had a chance here.${bestBit}</p>`;
  }

  /** good | possible | weak: how strong a Kp is for this place, before cloud. */
  function kpClass(kp) {
    const p = S.place;
    if (kp + 1e-9 >= p.kp_good) return "good";
    if (p.kp_possible > 0 && kp + 1e-9 >= p.kp_possible) return "possible";
    return p.kp_possible > 0 ? "weak" : "possible";
  }

  function stripHTML(nights) {
    const p = S.place;
    const list = [...nights].reverse(); // oldest left, newest right
    const yMax = Math.min(9, Math.max(4, Math.ceil(Math.max(p.kp_good, 0, ...list.map((x) => x.kp_max ?? 0)) + 0.5)));
    const pct = (kp) => `${((kp / yMax) * 100).toFixed(1)}%`;
    const showPossible = p.kp_possible > 0 && Math.abs(p.kp_possible - p.kp_good) / yMax > 0.08;
    // a Kp label (about 18% of the column tall) that would sit on a threshold line goes just above it
    const lines = [p.kp_good, ...(showPossible ? [p.kp_possible] : [])];
    const labelAt = (kp) => {
      let at = (kp / yMax) * 100;
      for (const l of lines) {
        const lp = (l / yMax) * 100;
        if (lp >= at - 1 && lp < at + 19) at = lp + 2;
      }
      return `${at.toFixed(1)}%`;
    };
    const cols = list.map((x) => {
      const dark = !!(x.dark_start && x.dark_end);
      const kp = x.kp_max;
      const word = RATING_WORD[x.rating] || x.rating;
      const label = `${dayLong(x.night_date)}: ${word}${kp !== null ? `, Kp max ${fmtKp(kp)}` : ""}${x.cloud_avg_pct !== null ? `, ${Math.round(x.cloud_avg_pct)}% cloud` : ""}`;
      const veil = x.cloud_avg_pct === null ? "" : `<span class="nc-veil" style="height:${Math.max(0, Math.min(100, x.cloud_avg_pct)).toFixed(0)}%"></span>`;
      const bar = !dark || kp === null
        ? `<span class="nc-light"></span>`
        : `<span class="nc-bar k-${kpClass(kp)}" style="height:${pct(kp)}">${veil}</span>`;
      return `<button type="button" class="night-col ${x.night_date === S.tonightDate ? "is-tonight" : ""}" data-act="night" data-night="${esc(x.night_date)}" data-rating="${esc(x.rating)}" aria-pressed="${S.selected === x.night_date}" aria-label="${esc(label)}" title="${esc(label)}">
        <span class="nc-box"><span class="nc-kp" style="bottom:${dark && kp !== null ? labelAt(kp) : "0%"}">${kp !== null ? fmtKp(kp) : "–"}</span>${bar}</span>
        <span class="nc-rate"></span>
        <span class="nc-day">${x.night_date === S.tonightDate ? "Tonight" : esc(weekday(x.night_date))}</span>
        <span class="nc-date">${esc(dayNum(x.night_date))}</span>
      </button>`;
    });
    return `<div class="strip-wrap"><div class="strip ${showPossible ? "with-possible" : ""}" style="--n:${list.length};--g:${pct(p.kp_good)};--p:${pct(p.kp_possible)}">${cols.join("")}</div></div>`;
  }

  function renderHistory() {
    const el = region("r-history");
    if (!el) return;
    const nights = S.nights;
    if (!nights.length) {
      delete ribbons.detail;
      delete skies.detail;
      el.innerHTML = `<section class="history" aria-label="Recent nights">
        <div class="sec-head"><h2>Recent nights</h2></div>
        <div class="empty-nights"><strong>No nights fetched yet</strong>Every night Aurora Watch fetches lands here, so you can see how the season is going.</div>
      </section>`;
      return;
    }
    const oldest = nights[nights.length - 1].night_date, newest = nights[0].night_date;
    const range = oldest === newest ? dayShort(newest) : `${dayShort(oldest)} to ${dayShort(newest)}`;
    const sel = S.selected && nights.find((x) => x.night_date === S.selected);
    if (!sel) { S.selected = null; delete ribbons.detail; delete skies.detail; }
    const more = S.limit < 60 && nights.length >= S.limit
      ? `<button type="button" class="ghost" data-act="show-all">Show up to 60 nights</button>` : "";
    el.innerHTML = `<section class="history" aria-label="Recent nights">
      <div class="sec-head"><h2>Recent nights</h2><span class="when">${esc(range)}</span></div>
      ${insightHTML(nights)}
      ${stripHTML(nights)}
      <div class="strip-foot">
        <div class="legend"><span><i class="lg-good"></i>Highest Kp, good here</span>${S.place.kp_possible > 0 ? `<span><i class="lg-possible"></i>Possible</span><span><i class="lg-weak"></i>Too weak</span>` : `<span><i class="lg-possible"></i>Possible</span>`}<span><i class="lg-veil"></i>Cloud cover, from the top</span><span><i class="lg-line"></i>Good from Kp ${fmtKp(S.place.kp_good)}</span><span><i class="lg-rate"></i>The night's chance</span></div>
        ${more}
      </div>
      ${sel ? `<div class="night-detail" id="night-detail">
        <div class="detail-head"><h3>${esc(nightName(sel.night_date) === dayLong(sel.night_date) ? dayLong(sel.night_date) : `${nightName(sel.night_date)}, ${dayLong(sel.night_date)}`)}</h3>
          <button type="button" class="ghost sm" data-act="close-detail">Close</button></div>
        ${nightBody(sel, "detail")}
      </div>` : ""}
    </section>`;
    const wrap = el.querySelector(".strip-wrap");
    if (wrap) wrap.scrollLeft = wrap.scrollWidth;
    drawRibbons();
  }

  function renderMain() {
    if (!region("r-bar")) shell();
    renderBar();
    renderForm();
    renderTonight();
    renderLatest();
    renderHistory();
  }

  // ---------- the place form ----------

  let tzOptions = null;
  function tzDatalist() {
    if (tzOptions === null) {
      let zones = [];
      try { zones = Intl.supportedValuesOf("timeZone"); } catch { zones = []; }
      tzOptions = zones.map((z) => `<option value="${esc(z)}"></option>`).join("");
    }
    return `<datalist id="tz-list">${tzOptions}</datalist>`;
  }

  function formHTML(first) {
    const p = first ? null : S.place;
    const v = (x) => (x === null || x === undefined ? "" : esc(x));
    return `<form class="place-form" novalidate>
      ${first ? "" : `<h2>Change place</h2>`}
      <div class="picks-label">${first ? "Start from a well-known aurora spot, or enter your own" : "Well-known aurora spots"}</div>
      <div class="picks">${PICKS.map((k, i) => `<button type="button" class="chip plain" data-act="pick" data-i="${i}">${esc(k.name)}</button>`).join("")}</div>
      <label class="field"><span class="label">Name</span>
        <input type="text" name="name" autocomplete="off" placeholder="e.g. Cabin by the lake" value="${v(p?.name)}"></label>
      <div class="grid2">
        <label class="field"><span class="label">Latitude</span>
          <input type="text" name="latitude" autocomplete="off" placeholder="69.65" value="${v(p?.latitude)}">
          <span class="hint">Decimal degrees, north positive. Paste “lat, lon” to fill both.</span></label>
        <label class="field"><span class="label">Longitude</span>
          <input type="text" name="longitude" autocomplete="off" placeholder="18.96" value="${v(p?.longitude)}">
          <span class="hint">Decimal degrees, east positive</span></label>
      </div>
      <label class="field"><span class="label">Time zone</span>
        <input type="text" name="timezone" list="tz-list" autocomplete="off" spellcheck="false" value="${v(p?.timezone ?? BROWSER_TZ)}">
        <span class="hint">Nights and times follow it. This device is on ${esc(BROWSER_TZ)}.</span></label>
      ${tzDatalist()}
      <div class="notice move-warn" hidden></div>
      <div class="notice danger form-error" role="alert" hidden></div>
      <div class="form-actions">
        <button type="submit" class="primary">Save place</button>
        ${first ? "" : `<button type="button" class="ghost" data-act="cancel-place">Cancel</button>`}
      </div>
    </form>`;
  }

  function renderForm() {
    const el = region("r-form");
    if (!el) return;
    if (!S.formOpen) { el.innerHTML = ""; return; }
    if (el.querySelector("form")) return; // keep what's being typed
    el.innerHTML = `<div class="place-panel">${formHTML(false)}</div>`;
    wireForm(el.querySelector("form"), false);
    el.querySelector("input[name=name]").focus();
  }

  function renderSetup() {
    Object.keys(ribbons).forEach((k) => delete ribbons[k]);
    Object.keys(skies).forEach((k) => delete skies[k]);
    app.innerHTML = `<section class="setup">
      <div class="setup-hero">${glyph(56)}<div>
        <h1>Where do you watch from?</h1>
        <p class="lede">Aurora Watch rates each night there: NOAA's Kp forecast against what your latitude needs, MET Norway's cloud cover, how dark it gets and the moon.</p>
      </div></div>
      <div class="place-panel">${formHTML(true)}</div>
    </section>`;
    const form = app.querySelector("form");
    wireForm(form, true);
    form.querySelector("input[name=name]").focus();
  }

  /** "69.65", "69,65", "69.65 N", "18.96° W" → number; "" → null; nonsense → NaN. */
  function parseCoord(raw) {
    const s = String(raw).trim();
    if (!s) return null;
    const m = s.match(/^([+-]?\d+(?:[.,]\d+)?)\s*°?\s*([NSEWnsew])?$/);
    if (!m) return NaN;
    let n = Number(m[1].replace(",", "."));
    if (m[2] && /[SWsw]/.test(m[2])) n = -Math.abs(n);
    return n;
  }

  function wireForm(form, first) {
    const f = (n) => form.elements.namedItem(n);
    const errBox = form.querySelector(".form-error");
    const warn = form.querySelector(".move-warn");
    const submit = form.querySelector("button[type=submit]");

    const checkMove = () => {
      if (first || !S.place) return;
      const lat = parseCoord(f("latitude").value), lon = parseCoord(f("longitude").value);
      const moved = Number.isFinite(lat) && Number.isFinite(lon) && (lat !== S.place.latitude || lon !== S.place.longitude);
      const n = S.nights.length;
      if (moved && n) {
        const what = n < S.limit ? `the ${plural(n, "night", "nights")} stored for ${S.place.name}` : `all nights stored for ${S.place.name}`;
        warn.textContent = `New coordinates clear ${what}. Renaming alone keeps them.`;
        warn.hidden = false;
        submit.textContent = "Move and clear nights";
      } else {
        warn.hidden = true;
        submit.textContent = "Save place";
      }
    };

    f("latitude").addEventListener("input", (e) => {
      const m = e.target.value.match(/^\s*([+-]?\d+(?:\.\d+)?)\s*[,;\s]\s*([+-]?\d+(?:\.\d+)?)\s*$/);
      if (m) { f("latitude").value = m[1]; f("longitude").value = m[2]; }
      checkMove();
    });
    f("longitude").addEventListener("input", checkMove);
    for (const el of form.querySelectorAll("input")) el.addEventListener("input", () => el.removeAttribute("aria-invalid"));

    form.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act=pick]");
      if (!b) return;
      const k = PICKS[Number(b.dataset.i)];
      f("name").value = k.name;
      f("latitude").value = k.latitude;
      f("longitude").value = k.longitude;
      f("timezone").value = k.timezone;
      for (const el of form.querySelectorAll("input")) el.removeAttribute("aria-invalid");
      errBox.hidden = true;
      checkMove();
      submit.focus();
    });
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !first) { S.formOpen = false; renderForm(); renderBar(); region("r-bar")?.querySelector("[data-act=change-place]")?.focus(); }
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      errBox.hidden = true;
      const lat = parseCoord(f("latitude").value), lon = parseCoord(f("longitude").value);
      const local = [];
      if (lat === null || Number.isNaN(lat)) { local.push("Latitude needs a number in decimal degrees, e.g. 69.65"); f("latitude").setAttribute("aria-invalid", "true"); }
      if (lon === null || Number.isNaN(lon)) { local.push("Longitude needs a number in decimal degrees, e.g. 18.96"); f("longitude").setAttribute("aria-invalid", "true"); }
      if (local.length) {
        errBox.textContent = local.join(". ") + ".";
        errBox.hidden = false;
        form.querySelector("[aria-invalid=true]")?.focus();
        return;
      }
      const label = submit.textContent;
      submit.disabled = true;
      submit.textContent = "Saving…";
      const r = await call("set_place", { name: f("name").value, latitude: lat, longitude: lon, timezone: f("timezone").value.trim() });
      submit.disabled = false;
      submit.textContent = label;
      if (!r.ok) {
        const msg = r.message || "That place couldn't be saved.";
        errBox.textContent = /[.!?]$/.test(msg) ? msg : msg + ".";
        errBox.hidden = false;
        const marks = [["name", /name/i], ["latitude", /latitude/i], ["longitude", /longitude/i], ["timezone", /time zone/i]];
        for (const [n, re] of marks) if (re.test(msg)) f(n).setAttribute("aria-invalid", "true");
        form.querySelector("[aria-invalid=true]")?.focus();
        return;
      }
      const before = S.place;
      S.place = r.value;
      S.formOpen = false;
      S.tonight = null;
      S.dark = null;
      S.fetch = "idle";
      S.autoTried = false;
      S.refreshError = null;
      S.selected = null;
      Object.keys(ribbons).forEach((k) => delete ribbons[k]);
      Object.keys(skies).forEach((k) => delete skies[k]);
      shell();
      renderBar();
      region("r-tonight").innerHTML = `<div class="loading" aria-hidden="true"><span class="skeleton" style="width:100%;height:180px;margin-top:24px"></span></div>`;
      toast(before ? `Watching from ${S.place.name}` : `Saved ${S.place.name}`);
      await loadTonight();
    });
  }

  // ---------- data ----------

  async function reloadNights() {
    const n = await call("list_nights", { limit: S.limit });
    if (n.ok && n.value) S.nights = n.value.nights || [];
  }

  async function loadTonight() {
    const dw = await call("dark_window");
    S.dark = dw.ok ? dw.value : null;
    if (dw.ok && dw.value) S.tonightDate = dw.value.date;
    const [t, n] = await Promise.all([
      call("get_tonight", S.tonightDate ? { date: S.tonightDate } : {}),
      call("list_nights", { limit: S.limit }),
    ]);
    S.tonight = t.ok ? t.value : null;
    S.nights = n.ok && n.value ? n.value.nights || [] : [];
    S.loadError = [dw, t, n].find((x) => !x.ok)?.message ?? null;
    renderMain();

    if (!S.tonight && !S.autoTried && !S.loadError) {
      S.autoTried = true;
      S.fetch = "fetching";
      renderTonight();
      renderLatest();
      const r = await call("fetch_tonight", { ...(S.tonightDate ? { date: S.tonightDate } : {}), quiet: true });
      if (r.ok && r.value) {
        S.tonight = r.value;
        S.fetch = "done";
        await reloadNights();
      } else {
        S.fetch = "failed";
      }
      renderTonight();
      renderLatest();
      renderHistory();
    }
  }

  async function refresh() {
    if (S.refreshing) return;
    S.refreshing = true;
    S.refreshError = null;
    renderTonight();
    const dw = await call("dark_window");
    if (dw.ok && dw.value) { S.dark = dw.value; S.tonightDate = dw.value.date; }
    const r = await call("fetch_tonight", S.tonightDate ? { date: S.tonightDate } : {});
    S.refreshing = false;
    if (!r.ok) {
      S.refreshError = r.message;
    } else if (r.value) {
      S.tonight = r.value;
      S.fetch = "done";
      S.loadError = null;
      await reloadNights();
      toast("Tonight's forecast is up to date");
    }
    renderTonight();
    renderLatest();
    renderHistory();
    region("r-tonight")?.querySelector("[data-act=refresh]")?.focus();
  }

  // ---------- events ----------

  app.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || !app.contains(b)) return;
    const act = b.dataset.act;
    if (act === "change-place") {
      S.formOpen = !S.formOpen;
      renderForm();
      b.setAttribute("aria-expanded", String(S.formOpen));
    } else if (act === "cancel-place") {
      S.formOpen = false;
      renderForm();
      renderBar();
      region("r-bar")?.querySelector("[data-act=change-place]")?.focus();
    } else if (act === "refresh") {
      refresh();
    } else if (act === "night") {
      S.selected = S.selected === b.dataset.night ? null : b.dataset.night;
      const scroll = region("r-history").querySelector(".strip-wrap")?.scrollLeft;
      renderHistory();
      const wrap = region("r-history").querySelector(".strip-wrap");
      if (wrap && scroll !== undefined) wrap.scrollLeft = scroll;
      region("r-history").querySelector(`[data-night="${CSS.escape(b.dataset.night)}"]`)?.focus();
      if (S.selected) region("r-history").querySelector("#night-detail")?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    } else if (act === "close-detail") {
      const was = S.selected;
      S.selected = null;
      renderHistory();
      if (was) region("r-history").querySelector(`[data-night="${CSS.escape(was)}"]`)?.focus();
    } else if (act === "show-all") {
      S.limit = 60;
      b.disabled = true;
      await reloadNights();
      renderHistory();
    }
  });

  // ---------- start ----------

  async function boot() {
    const p = await call("get_place");
    if (!p.ok) {
      app.innerHTML = `<div class="notice danger load-error" role="alert">Aurora Watch can't open yet: ${esc(p.message)}</div>`;
      return;
    }
    S.place = p.value;
    if (!S.place) { renderSetup(); return; }
    await loadTonight();
  }

  boot().catch(() => {
    app.innerHTML = `<div class="notice danger load-error" role="alert">Something went wrong opening Aurora Watch. Reload to try again.</div>`;
  });
})();
