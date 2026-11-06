// SPDX-License-Identifier: Apache-2.0
"use strict";
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const SVG = "http://www.w3.org/2000/svg";

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "style") n.style.cssText = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
    return n;
  }
  function svg(tag, attrs, ...kids) {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, String(v));
    for (const c of kids) n.append(c);
    return n;
  }

  // ---------- formatting ----------
  const num = new Intl.NumberFormat();
  const dayMonth = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  const dayMonthYear = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const todayIso = () => iso(new Date());
  const parseDay = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  function dateLabel(s) {
    const d = parseDay(s);
    return d.getFullYear() === new Date().getFullYear() ? dayMonth.format(d) : dayMonthYear.format(d);
  }
  function relDay(s) {
    const days = Math.round((parseDay(todayIso()) - parseDay(s)) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 14) return `${days} days ago`;
    if (days < 60) return `${Math.round(days / 7)} weeks ago`;
    if (days < 365) return `${Math.round(days / 30)} months ago`;
    const y = Math.round(days / 365);
    return y === 1 ? "a year ago" : `${y} years ago`;
  }
  const pct = (b) => (b.pages ? Math.min(100, Math.round((b.page / b.pages) * 100)) : null);
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  const cloth = (b) => `var(--cloth-${(hash(b.bookId) % 6) + 1})`;

  // ---------- api ----------
  async function api(op, input) {
    try {
      const out = await hewn.call(op, input);
      if (!out || out.error) return { error: (out && out.message) || "That didn't work. Try again." };
      return { result: out.result };
    } catch {
      return { error: "Couldn't reach your reading list. Check the connection and try again." };
    }
  }

  function toast(msg) {
    const t = el("div", { class: "toast", role: "status" }, msg);
    $("#toasts").append(t);
    setTimeout(() => t.remove(), 3200);
  }
  function showErr(node, msg) { node.textContent = msg || ""; node.hidden = !msg; }

  // ---------- state ----------
  let books = [];
  let showAllPile = false;
  let showAllDone = false;
  let firstRender = true;

  async function load() {
    const r = await api("list_books", {});
    if (r.error) {
      showErr($("#pageError"), r.error);
      books = [];
    } else {
      showErr($("#pageError"), "");
      books = r.result.books || [];
    }
    render();
  }

  function render() {
    const reading = books.filter((b) => b.status === "reading");
    const want = books.filter((b) => b.status === "want");
    const done = books.filter((b) => b.status === "finished");
    renderReading(reading, want.length > 0, readingPace(done));
    renderPile(want);
    renderYear(done);
    renderDoneList(done);
    if (firstRender) {
      firstRender = false;
      const target = location.hash && document.getElementById(location.hash.slice(1));
      if (target) target.scrollIntoView({ block: "start" });
    }
  }

  // ---------- reading now ----------
  // Pages a day, learned from the books finished in the last year: the pages of every
  // book after the first, over the days since that first one was finished.
  function readingPace(done) {
    const today = parseDay(todayIso());
    const cutoff = today - 365 * 86400000;
    const w = done.filter((b) => b.finishedOn && b.pages && parseDay(b.finishedOn) >= cutoff).sort(byFinished);
    if (w.length < 2) return null;
    const days = (today - parseDay(w[0].finishedOn)) / 86400000;
    if (days < 14) return null;
    const pages = w.slice(1).reduce((s, b) => s + b.pages, 0);
    return pages > 0 ? pages / days : null;
  }
  function spanWords(days) {
    if (days <= 1) return "about a day";
    if (days < 14) return `about ${days} days`;
    if (days < 63) return `about ${Math.round(days / 7)} weeks`;
    return `about ${Math.round(days / 30)} months`;
  }

  function renderReading(list, hasPile, pace) {
    const wrap = $("#readingList");
    wrap.removeAttribute("aria-busy");
    $("#readingCount").textContent = list.length ? String(list.length) : "";
    wrap.replaceChildren();
    if (!list.length) {
      wrap.append(
        el("div", { class: "empty now-empty" },
          nightstandGlyph(),
          el("strong", { text: "Nothing on the nightstand" }),
          el("span", { text: hasPile ? "Start a book from your pile, or add one you've just picked up." : "Add the book you're reading and keep your place here." }),
          el("button", { type: "button", class: "primary", onclick: () => openAdd("reading") }, "Add a book I'm reading"),
        ),
      );
      return;
    }
    for (const b of list) wrap.append(nowCard(b, pace));
    fitCovers(wrap);
  }

  function nightstandGlyph() {
    return svg("svg", { width: 56, height: 40, viewBox: "0 0 56 40", class: "glyph", "aria-hidden": "true" },
      svg("rect", { x: 8, y: 26, width: 40, height: 8, rx: 2, fill: "var(--cloth-1)" }),
      svg("rect", { x: 12, y: 18, width: 34, height: 8, rx: 2, fill: "var(--cloth-2)" }),
      svg("rect", { x: 10, y: 10, width: 30, height: 8, rx: 2, fill: "var(--cloth-3)" }),
      svg("rect", { x: 4, y: 34, width: 48, height: 3, rx: 1.5, fill: "var(--text-3)" }),
    );
  }

  function nowCard(b, pace) {
    const p = pct(b);
    const atEnd = p === 100;
    const err = el("p", { class: "notice danger", role: "alert", hidden: true });
    const input = el("input", {
      type: "number", min: 0, step: 1, inputmode: "numeric", value: b.page, id: `page-${b.bookId}`,
      max: b.pages || null, "aria-describedby": `of-${b.bookId}`,
      onfocus: (e) => e.target.select(),
    });
    const save = el("button", { type: "submit" }, "Save");
    const form = el("form", { class: "page-form", novalidate: true },
      el("label", { for: `page-${b.bookId}`, text: "Page" }),
      input,
      b.pages ? el("span", { class: "of", id: `of-${b.bookId}`, text: `of ${num.format(b.pages)}` }) : null,
      save,
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const page = Number(input.value);
      if (input.value.trim() === "" || !Number.isInteger(page) || page < 0) {
        input.setAttribute("aria-invalid", "true");
        showErr(err, "Enter a whole page number.");
        input.focus();
        return;
      }
      input.removeAttribute("aria-invalid");
      showErr(err, "");
      save.disabled = true;
      save.textContent = "Saving…";
      const r = await api("set_progress", { bookId: b.bookId, page });
      if (r.error) {
        save.disabled = false;
        save.textContent = "Save";
        showErr(err, r.error);
        return;
      }
      b.page = r.result.page;
      render();
      toast(r.result.percent != null ? `${b.title}: page ${num.format(b.page)}, ${r.result.percent}%` : `${b.title}: page ${num.format(b.page)}`);
      const again = document.getElementById(`page-${b.bookId}`);
      if (again) again.focus();
    });

    const left = b.pages ? b.pages - b.page : null;
    const eta = pace && left > 0 ? `${spanWords(Math.ceil(left / pace))} at your pace` : null;
    return el("article", { class: "now-card" + (atEnd ? " at-end" : ""), style: `--cloth:${cloth(b)}`, "aria-label": b.title },
      el("div", { class: "cover", "aria-hidden": "true" },
        el("span", { class: "cover-t", text: b.title }),
        b.author ? el("span", { class: "cover-a", text: b.author }) : null,
      ),
      el("div", { class: "now-head" },
        el("div", { class: "titles" },
          el("h3", { text: b.title }),
          b.author ? el("p", { class: "author", text: b.author }) : null,
        ),
        p != null
          ? el("div", { class: "pct", "aria-label": `${p} percent read` }, el("span", { class: "big", text: String(p) }), el("span", { class: "unit", text: "%" }))
          : el("div", { class: "pct" }, el("span", { class: "unit", text: "page" }), el("span", { class: "big", text: num.format(b.page) })),
      ),
      b.pages ? bookmark(b, p) : null,
      el("p", { class: "togo" },
        el("strong", { text:
          left == null ? "No page count, so just your place."
            : atEnd ? "Last page reached."
            : b.page === 0 ? `Not started, ${num.format(b.pages)} pages ahead`
            : `${num.format(left)} ${left === 1 ? "page" : "pages"} to go` }),
        eta ? el("span", { class: "eta", text: eta }) : null,
      ),
      el("div", { class: "controls" },
        form,
        el("span", { class: "spacer" }),
        el("button", { type: "button", class: atEnd ? "primary" : "", onclick: () => openFinish(b) }, "Finished it"),
        el("button", { type: "button", class: "ghost icon-x", "aria-label": `Remove ${b.title}`, title: "Remove", onclick: () => openRemove(b) }, xIcon()),
      ),
      err,
    );
  }

  // shrink a cover's title until its longest word fits whole instead of breaking mid-word
  function fitCovers(root) {
    for (const t of $$(".cover-t", root)) {
      if (!t.clientWidth) continue; // hidden (phone covers show no text)
      let size = 10.5;
      t.style.fontSize = "";
      while (t.scrollWidth > t.clientWidth + 0.5 && size > 6.5) {
        size -= 0.5;
        t.style.fontSize = `${size}px`;
      }
    }
  }

  function bookmark(b, p) {
    return el("div", { class: "bookmark", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": b.pages, "aria-valuenow": b.page, "aria-valuetext": `page ${b.page} of ${b.pages}` },
      el("div", { class: "edge" }, el("div", { class: "read", style: `width:${p}%` })),
      el("div", { class: "ribbon", style: `left:${p}%` }),
    );
  }

  // ---------- want to read: the pile ----------
  function renderPile(want) {
    const wrap = $("#pile");
    $("#wantCount").textContent = want.length ? String(want.length) : "";
    wrap.replaceChildren();
    if (!want.length) {
      wrap.append(el("div", { class: "empty small-empty" },
        el("strong", { text: "The pile is empty" }),
        el("span", { text: "Books you mean to read wait here." }),
        el("button", { type: "button", onclick: () => openAdd("want") }, "Add one to the pile"),
      ));
      return;
    }
    const shown = showAllPile ? want : want.slice(0, 7);
    const maxPages = Math.max(...want.map((b) => b.pages || 300), 300);
    const ul = el("ul", { class: "pile", "aria-label": "Books you want to read, newest on top" });
    for (const b of shown) {
      const h = hash(b.bookId);
      const pages = b.pages || 300;
      const width = 82 + Math.round(((h % 1000) / 1000) * 14); // 82–96 % of the lane
      const thick = Math.round(38 + Math.min(1, pages / Math.max(maxPages, 600)) * 16); // 38–54 px: thicker books, more pages
      const shift = (h >>> 10) % 10; // a messy pile
      ul.append(el("li", { class: "pile-row" },
        el("div", { class: "flat", style: `--cloth:${cloth(b)};width:calc(${width}% - ${shift}px);height:${thick}px;margin-left:${shift}px`, title: [b.title, b.author].filter(Boolean).join(", ") },
          el("span", { class: "words" },
            el("span", { class: "t", text: b.title }),
            b.author ? el("span", { class: "a", text: b.author }) : null,
          ),
          b.pages ? el("span", { class: "pp", text: `${num.format(b.pages)} pages` }) : null,
        ),
        el("div", { class: "pile-actions" },
          el("button", { type: "button", class: "sm start", "aria-label": `Start ${b.title}`, onclick: (e) => startBook(b, e.currentTarget) }, "Start"),
          el("button", { type: "button", class: "ghost sm icon-x", "aria-label": `Remove ${b.title}`, title: "Remove", onclick: () => openRemove(b) }, xIcon()),
        ),
      ));
    }
    wrap.append(ul);
    if (want.length > 7) {
      wrap.append(el("button", { type: "button", class: "link more", onclick: () => { showAllPile = !showAllPile; render(); } },
        showAllPile ? "Show fewer" : `Show all ${want.length}`));
    }
  }

  function xIcon() {
    return svg("svg", { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": "true" },
      svg("path", { d: "M2 2l8 8M10 2l-8 8", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round" }));
  }

  async function startBook(b, btn) {
    btn.disabled = true;
    btn.textContent = "Starting…";
    const r = await api("set_progress", { bookId: b.bookId, page: b.page || 0 });
    if (r.error) {
      btn.disabled = false;
      btn.textContent = "Start";
      showErr($("#pageError"), `Couldn't start ${b.title}: ${r.error}`);
      return;
    }
    showErr($("#pageError"), "");
    b.status = "reading";
    render();
    toast(`${b.title} is on the nightstand`);
    const input = document.getElementById(`page-${b.bookId}`);
    if (input) { input.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); input.focus({ preventScroll: true }); }
  }

  // ---------- finished: the shelf ----------
  function byFinished(a, b) { return (a.finishedOn || "").localeCompare(b.finishedOn || ""); }

  // ---------- the year shelf: one bay per month, each finished book standing where it was finished ----------
  const monShort = new Intl.DateTimeFormat(undefined, { month: "short" });
  const monLong = new Intl.DateTimeFormat(undefined, { month: "long" });
  let shelfYear = null;

  function renderYear(done) {
    const now = new Date();
    const thisYear = now.getFullYear();
    const years = [...new Set(done.filter((b) => b.finishedOn).map((b) => Number(b.finishedOn.slice(0, 4))))].sort((a, b) => b - a);
    if (shelfYear == null || !years.includes(shelfYear)) shelfYear = !years.length || years.includes(thisYear) ? thisYear : years[0];
    const y = shelfYear;
    $("#yearH").textContent = y === thisYear ? `${y} on the shelf` : `${y}, finished`;

    const pick = $("#yearPick");
    pick.replaceChildren();
    pick.hidden = years.length < 2;
    if (years.length > 1) {
      for (const yy of years) {
        pick.append(el("button", { type: "button", class: "chip plain", "aria-pressed": String(yy === y), onclick: () => { shelfYear = yy; render(); } }, String(yy)));
      }
    }

    const inYear = done.filter((b) => (b.finishedOn || "").startsWith(`${y}-`)).sort(byFinished);
    renderFigs(inYear, y, thisYear);

    const nowMonth = y === thisYear ? now.getMonth() : 12;
    const ol = el("ol", { class: "bays", "aria-label": `Books finished in ${y}, month by month` });
    for (let m = 0; m < 12; m++) {
      const d = new Date(y, m, 1);
      const list = inYear.filter((b) => Number(b.finishedOn.slice(5, 7)) === m + 1);
      const future = y === thisYear && m > nowMonth;
      ol.append(el("li", {
        class: "bay" + (future ? " future" : "") + (y === thisYear && m === nowMonth ? " now" : "") + (list.length ? " has" : ""),
        "aria-label": `${monLong.format(d)}: ${list.length ? list.map((b) => b.title + (b.rating ? `, ${b.rating} of 5` : "")).join("; ") : future ? "still to come" : "none finished"}`,
      },
        el("div", { class: "bay-books", "aria-hidden": "true" }, ...list.map(spine)),
        el("span", { class: "mon", "aria-hidden": "true", text: monShort.format(d) }),
      ));
    }
    const wrap = $("#yearShelf");
    wrap.replaceChildren(ol);
    if (!inYear.length) {
      wrap.append(el("p", { class: "shelf-note" }, "Finished books stand here in the month you finish them, your rating in gilt on the spine."));
    }
  }

  function spine(b) {
    const h = hash(b.bookId);
    const pages = b.pages || 280;
    const w = Math.max(20, Math.min(44, Math.round(pages / 9))); // thicker for longer books
    const tall = Math.max(68 + (h % 22), Math.min(97, 52 + b.title.length * 2.4)); // % of the bay; long titles stand taller
    const label = `${b.title}${b.author ? `, ${b.author}` : ""}, finished ${dateLabel(b.finishedOn)}${b.rating ? `, rated ${b.rating} of 5` : ""}`;
    return el("div", { class: "spine", style: `--cloth:${cloth(b)};flex-basis:${w}px;height:${tall}%`, title: label },
      el("span", { class: "spine-t", text: b.title }),
      el("span", { class: "gilt-dots" }, ...Array.from({ length: b.rating || 0 }, () => el("i"))),
    );
  }

  function renderFigs(inYear, y, thisYear) {
    const box = $("#yearFigs");
    const paceLine = $("#paceLine");
    if (!inYear.length) {
      box.replaceChildren(el("p", { class: "figs-empty", text: y === thisYear ? "Nothing finished yet this year." : `Nothing finished in ${y}.` }));
      paceLine.hidden = true;
      return;
    }
    const pages = inYear.reduce((s, b) => s + (b.pages || 0), 0);
    const rated = inYear.filter((b) => b.rating);
    const avg = rated.length ? rated.reduce((s, b) => s + b.rating, 0) / rated.length : null;
    const fig = (cls, value, label, extra) => el("div", { class: "fig " + cls }, el("span", { class: "v" }, value, extra || null), el("span", { class: "l", text: label }));
    box.replaceChildren(
      fig("books", String(inYear.length), inYear.length === 1 ? "book finished" : "books finished"),
      pages ? fig("pages", num.format(pages), "pages read") : null,
      avg != null ? fig("avg", avg.toFixed(1), rated.length === 1 ? "rating" : "average rating", stars(Math.round(avg), 12)) : null,
    );
    const start = new Date(y, 0, 1);
    const end = y === thisYear ? parseDay(todayIso()) : new Date(y, 11, 31);
    const days = Math.max(1, Math.round((end - start) / 86400000) + 1);
    const per = days / inYear.length;
    if (inYear.length >= 2) {
      const every = per < 10 ? `${Math.max(1, Math.round(per))} days` : `${Math.round(per / 7)} weeks`;
      paceLine.textContent = y === thisYear ? `One book every ${every} so far this year.` : `One book every ${every} that year.`;
      paceLine.hidden = false;
    } else paceLine.hidden = true;
  }

  function stars(n, size = 14) {
    const g = svg("svg", { class: "stars", width: size * 5 + 8, height: size, viewBox: `0 0 ${5 * 20 + 8} 20`, role: "img", "aria-label": n ? `${n} of 5` : "Not rated" });
    for (let i = 0; i < 5; i++) {
      g.append(svg("path", {
        d: "M10 1.5l2.6 5.5 6 .7-4.4 4.1 1.2 6-5.4-3-5.4 3 1.2-6L1.4 7.7l6-.7z",
        transform: `translate(${i * 22} 0)`,
        class: i < n ? "on" : "off",
      }));
    }
    return g;
  }

  function renderDoneList(done) {
    const wrap = $("#doneList");
    $("#doneCount").textContent = done.length ? String(done.length) : "";
    wrap.replaceChildren();
    if (!done.length) {
      wrap.append(el("div", { class: "empty small-empty" },
        el("strong", { text: "Nothing finished yet" }),
        el("span", { text: "When you close the last page, press Finished it and rate the book." }),
      ));
      return;
    }
    const sorted = [...done].sort(byFinished).reverse();
    const shown = showAllDone ? sorted : sorted.slice(0, 6);
    const ul = el("ul", { class: "done-list", "aria-label": "Finished books, most recent first" });
    for (const b of shown) {
      ul.append(el("li", {},
        el("span", { class: "swatch", style: `--cloth:${cloth(b)}`, "aria-hidden": "true" }),
        el("span", { class: "dt", text: b.title }),
        el("span", { class: "sub", text: b.author || "" }),
        b.rating ? stars(b.rating) : el("span", { class: "unrated", text: "Not rated" }),
        el("div", { class: "when", title: b.finishedOn ? relDay(b.finishedOn) : null },
          b.finishedOn ? el("span", { class: "abs", text: dateLabel(b.finishedOn) }) : null,
          b.finishedOn ? el("span", { class: "rel", text: relDay(b.finishedOn) }) : null,
        ),
        el("button", { type: "button", class: "ghost sm icon-x", "aria-label": `Remove ${b.title}`, title: "Remove", onclick: () => openRemove(b) }, xIcon()),
      ));
    }
    wrap.append(ul);
    if (sorted.length > 6) {
      wrap.append(el("button", { type: "button", class: "link more", onclick: () => { showAllDone = !showAllDone; render(); } },
        showAllDone ? "Show fewer" : `Show all ${sorted.length}`));
    }
  }

  // ---------- add ----------
  let addStatus = "want";
  function setAddStatus(s) {
    addStatus = s;
    for (const b of $$("#addForm [data-status]")) b.setAttribute("aria-pressed", String(b.dataset.status === s));
  }
  function openAdd(status) {
    const panel = $("#addPanel");
    panel.hidden = false;
    $("#addBtn").setAttribute("aria-expanded", "true");
    if (status) setAddStatus(status);
    showErr($("#addError"), "");
    panel.scrollIntoView({ block: "nearest" });
    $("#addForm [name=title]").focus();
  }
  function closeAdd() {
    $("#addPanel").hidden = true;
    $("#addBtn").setAttribute("aria-expanded", "false");
    $("#addForm").reset();
    $("#addForm [name=title]").removeAttribute("aria-invalid");
    setAddStatus("want");
    showErr($("#addError"), "");
  }
  $("#addBtn").addEventListener("click", () => ($("#addPanel").hidden ? openAdd() : closeAdd()));
  $("#addCancel").addEventListener("click", closeAdd);
  for (const b of $$("#addForm [data-status]")) b.addEventListener("click", () => setAddStatus(b.dataset.status));
  $("#addForm").addEventListener("keydown", (e) => { if (e.key === "Escape") closeAdd(); });
  $("#addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = { title: form.elements.namedItem("title"), author: form.elements.namedItem("author"), pages: form.elements.namedItem("pages") };
    const title = f.title.value.trim();
    const author = f.author.value.trim();
    const pagesRaw = f.pages.value.trim();
    if (!title) {
      f.title.setAttribute("aria-invalid", "true");
      showErr($("#addError"), "Give the book a title.");
      f.title.focus();
      return;
    }
    f.title.removeAttribute("aria-invalid");
    const input = { title, status: addStatus };
    if (author) input.author = author;
    if (pagesRaw) {
      const n = Number(pagesRaw);
      if (!Number.isInteger(n) || n < 1) { showErr($("#addError"), "Pages should be a whole number above zero."); f.pages.focus(); return; }
      input.pages = n;
    }
    const btn = $("#addSubmit");
    btn.disabled = true;
    btn.textContent = "Adding…";
    const r = await api("add_book", input);
    btn.disabled = false;
    btn.textContent = "Add book";
    if (r.error) { showErr($("#addError"), r.error); return; }
    const where = addStatus === "reading" ? "on the nightstand" : "on the pile";
    closeAdd();
    toast(`${title} is ${where}`);
    await load();
  });

  // ---------- dialogs ----------
  for (const d of $$("dialog")) {
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
    for (const c of $$("[data-close]", d)) c.addEventListener("click", () => d.close());
  }

  let finishing = null;
  let rating = 0;
  const words = ["No rating", "Didn't care for it", "It was all right", "Liked it", "Really liked it", "Loved it"];
  const starsIn = $("#starsIn");
  for (let i = 1; i <= 5; i++) {
    starsIn.append(el("button", { type: "button", class: "star-btn", "data-n": i, "aria-label": `${i} ${i === 1 ? "star" : "stars"}`, "aria-pressed": "false", onclick: () => setRating(rating === i ? 0 : i) },
      svg("svg", { viewBox: "0 0 20 20", width: 26, height: 26, "aria-hidden": "true" }, svg("path", { d: "M10 1.5l2.6 5.5 6 .7-4.4 4.1 1.2 6-5.4-3-5.4 3 1.2-6L1.4 7.7l6-.7z" }))));
  }
  function setRating(n) {
    rating = n;
    for (const b of $$(".star-btn", starsIn)) {
      const k = Number(b.dataset.n);
      b.classList.toggle("on", k <= n);
      b.setAttribute("aria-pressed", String(k === n));
    }
    $("#rateWord").textContent = words[n];
  }
  function openFinish(b) {
    finishing = b;
    setRating(0);
    $("#finishBook").textContent = b.author ? `${b.title}, by ${b.author}` : b.title;
    const d = $("#finishDate");
    d.value = todayIso();
    d.max = todayIso();
    showErr($("#finishError"), "");
    $("#finishSubmit").disabled = false;
    $("#finishDlg").showModal();
    $(".star-btn", starsIn).focus();
  }
  $("#finishForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!finishing) return;
    const date = $("#finishDate").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { showErr($("#finishError"), "Pick the day you finished it."); return; }
    const input = { bookId: finishing.bookId, date };
    if (rating) input.rating = rating;
    const btn = $("#finishSubmit");
    btn.disabled = true;
    const r = await api("finish_book", input);
    btn.disabled = false;
    if (r.error) { showErr($("#finishError"), r.error); return; }
    const t = finishing.title;
    $("#finishDlg").close();
    finishing = null;
    toast(`${t} is on the shelf`);
    await load();
  });

  let removing = null;
  function openRemove(b) {
    removing = b;
    $("#removeH").textContent = `Remove ${b.title}?`;
    const lost =
      b.status === "reading" ? `Your place${b.page ? ` (page ${num.format(b.page)})` : ""} goes with it.`
      : b.status === "finished" ? `Its ${b.rating ? `${b.rating}-star rating and ` : ""}finish date go with it.`
      : "It leaves the pile.";
    $("#removeText").textContent = `${lost} This can't be undone.`;
    showErr($("#removeError"), "");
    $("#removeSubmit").disabled = false;
    $("#removeDlg").showModal();
    $("#removeDlg [data-close]").focus();
  }
  $("#removeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!removing) return;
    const btn = $("#removeSubmit");
    btn.disabled = true;
    const r = await api("remove_book", { bookId: removing.bookId });
    btn.disabled = false;
    if (r.error) { showErr($("#removeError"), r.error); return; }
    const t = removing.title;
    $("#removeDlg").close();
    removing = null;
    toast(`Removed ${t}`);
    await load();
  });

  let fitTimer = 0;
  addEventListener("resize", () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => fitCovers(document), 150); });

  load();
})();
