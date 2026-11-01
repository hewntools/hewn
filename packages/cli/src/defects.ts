// SPDX-License-Identifier: AGPL-3.0-or-later
// What a builder should fix on its UI, measured in the browser: what sticks out past the screen's
// edge, text cut short, things drawn over each other, page errors, and controls that break the page
// when clicked. Hewn's visual
// check (visual.ts) and the build-quality bench (bench/) both measure with these, so they agree.

/** A page in a headless browser, as the measures drive it. */
export interface MeasuredPage {
  /** A fresh load of `url`, then `settleMs` for its first API calls and rendering. */
  goto(url: string, settleMs?: number): Promise<void>;
  eval<T = unknown>(expression: string): Promise<T>;
  /** Uncaught exceptions, console.error, and failed loads, since the last `clear()`. */
  errors: string[];
  /** The tool's API calls that answered with an error status. */
  apiErrors: string[];
  /** alert/confirm/prompt dialogs the page opened (each dismissed). */
  dialogs: string[];
  clear(): void;
}

/**
 * How far (CSS px) anything sticks out past the right edge on this screen: the page itself, or an
 * element that's cut off because the page hides what overflows. Elements inside a deliberate
 * scroller or clipping box (a carousel, a table-wrap) don't count.
 */
export const overflowX = (page: Pick<MeasuredPage, "eval">, screenWidth?: number) =>
  page.eval<number>(`(() => {
    // A phone widens its layout viewport to fit content that overflows: measure against the screen.
    const vw = ${screenWidth ?? "window.innerWidth"};
    let worst = Math.max(0, document.documentElement.scrollWidth - vw);
    const contained = (el) => {
      for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        const o = getComputedStyle(a).overflowX;
        if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true;
      }
      return false;
    };
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const st = getComputedStyle(el);
      if (st.visibility === "hidden" || st.position === "fixed") continue;
      const out = r.right - vw;
      if (out > worst && !contained(el)) worst = out;
    }
    return Math.round(worst);
  })()`);

/**
 * Text and controls that cover each other, as the eye sees it: a line of text, an SVG label, a form
 * control or a button whose box overlaps another's by at least 4 px each way and a third of the
 * smaller one. Text is measured line by line by its glyphs' boxes (a Range), cut to what its clipping
 * boxes show, so a short label in a wide block, a sentence that wraps around a link or text kept for
 * screen readers doesn't count. A thing inside another (a button's own label) doesn't count, nor what's
 * fixed or sticky (drawn over the page on purpose), nor text over an image or a chart's shapes.
 */
const OVERLAPS = `(() => {
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
  const words = (el) => (el.textContent || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().replace(/\\s+/g, " ").slice(0, 40);
  // Its boxes as shown: none when it (or what holds it) is hidden, fixed, sticky or clipped away; else cut to every box that clips it.
  const shownBoxes = (el, boxes) => {
    // A closed <details>'s content has boxes but isn't drawn.
    if (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) return [];
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const st = getComputedStyle(a);
      if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0 || st.position === "fixed" || st.position === "sticky" || st.clipPath !== "none" || (st.clip && st.clip !== "auto")) return [];
      if (a !== el && (st.overflowX !== "visible" || st.overflowY !== "visible")) {
        const c = a.getBoundingClientRect();
        boxes = boxes.map((r) => ({ left: Math.max(r.left, c.left), top: Math.max(r.top, c.top), right: Math.min(r.right, c.right), bottom: Math.min(r.bottom, c.bottom) }));
      }
    }
    return boxes.filter((r) => r.right - r.left >= 4 && r.bottom - r.top >= 4);
  };
  // A line's box is its font's whole height; the glyphs fill about its middle (big type set tight often
  // reaches into the line above or below without touching it).
  const glyphs = (r) => ({ left: r.left, right: r.right, top: r.top + r.height * 0.2, bottom: r.bottom - r.height * 0.2 });
  const things = [];
  const add = (el, rects) => {
    const boxes = shownBoxes(el, rects.map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })));
    if (boxes.length && things.length < 400) things.push({ el, boxes });
  };
  // Controls (an SVG shape's box isn't its shape: a chart's segments aren't counted).
  const controls = 'button, input:not([type="hidden"]), select, textarea, [role="button"]';
  for (const el of document.body.querySelectorAll(controls)) if (!(el instanceof SVGElement)) add(el, [el.getBoundingClientRect()]);
  // SVG text (a chart's labels), as drawn.
  for (const el of document.body.querySelectorAll("svg text")) if (words(el)) add(el, [glyphs(el.getBoundingClientRect())]);
  // HTML text: each element's own runs, line by line; not a control's own label.
  const lines = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const el = t.parentElement;
    if (!el || !t.textContent.trim() || el.closest("svg, script, style, noscript, " + controls)) continue;
    const range = document.createRange();
    range.selectNodeContents(t);
    lines.set(el, [...(lines.get(el) || []), ...range.getClientRects()]);
  }
  for (const [el, rects] of lines) add(el, rects.map(glyphs));
  const area = (r) => (r.right - r.left) * (r.bottom - r.top);
  const out = [];
  for (let i = 0; i < things.length && out.length < 10; i++)
    for (let j = i + 1; j < things.length && out.length < 10; j++) {
      const a = things[i], b = things[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      let worst;
      for (const p of a.boxes)
        for (const q of b.boxes) {
          const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
          const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
          if (w < 4 || h < 4 || w * h < Math.min(area(p), area(q)) / 3) continue;
          if (!worst || w * h > worst.w * worst.h) worst = { w, h, x: Math.max(p.left, q.left) + w / 2, y: Math.max(p.top, q.top) + h / 2 };
        }
      if (!worst) continue;
      // The one drawn on top covers the other, as the browser hit-tests it.
      const hit = document.elementFromPoint(worst.x, worst.y);
      const [top, under] = hit && (b.el === hit || b.el.contains(hit)) ? [b, a] : [a, b];
      out.push('"' + words(top.el) + '" (' + name(top.el) + ') covers "' + words(under.el) + '" (' + name(under.el) + "), " + Math.round(worst.w) + "×" + Math.round(worst.h) + " px");
    }
  return out;
})()`;

export interface LayoutDefects {
  /** The outermost elements past the screen's right edge, with how far: "div.row ("…"): 210px past the edge, 600px wide". */
  sticksOut: string[];
  /** Text cut short by an ellipsis or clipping. */
  cutShort: string[];
  /** Text and controls drawn over each other: '"›" (span.chev) covers "Repot" (span.chip), 18×16 px'. */
  overlaps: string[];
}

/**
 * What a builder should fix on this screen, measured: elements that stick out past the screen's
 * right edge (outermost ones, with how far), text cut short (an ellipsis or clipped text), and text
 * or controls drawn over each other (see OVERLAPS).
 */
export const layoutDefects = (page: Pick<MeasuredPage, "eval">, screenWidth: number) =>
  page.eval<LayoutDefects>(`(() => {
    const vw = ${screenWidth};
    const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
    const text = (el) => (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 50);
    const contained = (el) => {
      for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        const o = getComputedStyle(a).overflowX;
        if (o === "auto" || o === "scroll" || o === "hidden" || o === "clip") return true;
      }
      return false;
    };
    const out = [];
    const flagged = new Set();
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || getComputedStyle(el).position === "fixed") continue;
      const px = Math.round(r.right - vw);
      if (px <= 1 || contained(el)) continue;
      let a = el.parentElement, inside = false;
      for (; a; a = a.parentElement) if (flagged.has(a)) { inside = true; break; }
      if (inside) continue;
      flagged.add(el);
      out.push(name(el) + (text(el) ? ' ("' + text(el) + '")' : "") + ": " + px + "px past the edge, " + Math.round(r.width) + "px wide");
    }
    const cut = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (cut.length >= 10) break;
      const st = getComputedStyle(el);
      if (el.children.length || !text(el)) continue;
      const box = el.getBoundingClientRect();
      if (box.width <= 2 || box.height <= 2) continue; // screen-reader-only text is clipped on purpose
      const clipped = el.scrollWidth > el.clientWidth + 1 && (st.textOverflow === "ellipsis" || st.overflow === "hidden" || st.overflowX === "hidden");
      if (clipped) cut.push('"' + text(el) + '" (' + name(el) + ")");
    }
    return { sticksOut: out.slice(0, 10), cutShort: cut, overlaps: ${OVERLAPS} };
  })()`);

/** What gets clicked: visible, enabled controls that don't delete, archive or reset anything. */
const CLICKABLES = `(() => {
  const risky = /delete|remove|clear|reset|archive|discard|erase|sign out|log out/i;
  const els = [...document.querySelectorAll('button, [role="button"], a.btn, input[type="submit"], input[type="button"], summary, [aria-pressed]')];
  const seen = new Set();
  const out = [];
  for (const el of els) {
    if (seen.has(el)) continue; seen.add(el);
    const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none' || el.disabled) continue;
    const label = (el.getAttribute('aria-label') || el.textContent || el.value || el.title || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
    if (risky.test(label) || risky.test(el.className || '')) continue;
    out.push({ el, label: label || el.tagName.toLowerCase() });
  }
  return out;
})()`;

export interface ClickResult {
  clickable: number;
  clicked: number;
  /** Clicks after which the page threw or logged an error (API answers with an error status are listed separately). */
  failures: { label: string; errors: string[] }[];
  apiErrors: { label: string; errors: string[] }[];
  /** Clicks that opened a browser dialog (alert, confirm, prompt) rather than the page's own UI. */
  dialogs: { label: string; dialogs: string[] }[];
}

/**
 * Click each control once, from a fresh load each time (so one click's state doesn't hide another's
 * bug): a crude check that the UI's buttons do something without breaking. Run it on a copy of the
 * state: clicks write.
 */
export async function clickThrough(page: MeasuredPage, url: string, limit = 20): Promise<ClickResult> {
  await page.goto(url);
  const labels = await page.eval<string[]>(`${CLICKABLES}.map((c) => c.label)`);
  const out: ClickResult = { clickable: labels.length, clicked: 0, failures: [], apiErrors: [], dialogs: [] };
  for (let i = 0; i < Math.min(labels.length, limit); i++) {
    await page.goto(url, 1000);
    page.clear();
    // The click runs after this call returns, so a dialog it opens can't block the call itself.
    const clicked = await page.eval<boolean>(`(() => { const c = ${CLICKABLES}[${i}]; if (!c) return false; c.el.scrollIntoView({ block: "center" }); setTimeout(() => (typeof c.el.click === "function" ? c.el.click() : c.el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })))); return true; })()`);
    if (!clicked) continue;
    out.clicked++;
    await new Promise((r) => setTimeout(r, 700));
    if (page.errors.length) out.failures.push({ label: labels[i], errors: [...new Set(page.errors)] });
    if (page.apiErrors.length) out.apiErrors.push({ label: labels[i], errors: [...new Set(page.apiErrors)] });
    if (page.dialogs.length) out.dialogs.push({ label: labels[i], dialogs: [...new Set(page.dialogs)] });
  }
  return out;
}

/** Which screen, in a builder's words: "on the phone (390 px)", "on desktop (1280 px)". */
export const onScreen = (width: number, phone: boolean) => (phone ? `on the phone (${width} px)` : `on desktop (${width} px)`);

/** One screen's measures: where (`onScreen`), its layout defects and the page's errors. */
export interface ScreenDefects {
  where: string;
  layout: LayoutDefects;
  errors: string[];
}

/**
 * The measures as a builder is told them, one line each (at most 30): per screen, what sticks out,
 * text cut short, things drawn over each other and page errors; then clicks that broke the page.
 */
export function defectLines(screens: ScreenDefects[], clicks?: ClickResult): string[] {
  const out: string[] = [];
  for (const s of screens) {
    for (const x of s.layout.sticksOut) out.push(`Sticks out ${s.where}: ${x}`);
    for (const x of s.layout.cutShort) out.push(`Text cut short ${s.where}: ${x}`);
    for (const x of s.layout.overlaps ?? []) out.push(`Drawn over each other ${s.where}: ${x}`);
    for (const e of new Set(s.errors)) out.push(`Page error ${s.where}: ${e}`);
  }
  for (const f of clicks?.failures ?? []) out.push(`Clicking "${f.label}" broke the page: ${f.errors.join("; ")}`);
  return out.slice(0, 30);
}
