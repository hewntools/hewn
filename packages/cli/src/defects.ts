// SPDX-License-Identifier: AGPL-3.0-or-later
// What a builder should fix on its UI, measured in the browser: what sticks out past the screen's
// edge, text cut short, page errors, and controls that break the page when clicked. Hewn's visual
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

export interface LayoutDefects {
  /** The outermost elements past the screen's right edge, with how far: "div.row ("…"): 210px past the edge, 600px wide". */
  sticksOut: string[];
  /** Text cut short by an ellipsis or clipping. */
  cutShort: string[];
}

/**
 * What a builder should fix on this screen, measured: elements that stick out past the screen's
 * right edge (outermost ones, with how far), and text cut short (an ellipsis or clipped text).
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
    return { sticksOut: out.slice(0, 10), cutShort: cut };
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
 * text cut short and page errors; then clicks that broke the page.
 */
export function defectLines(screens: ScreenDefects[], clicks?: ClickResult): string[] {
  const out: string[] = [];
  for (const s of screens) {
    for (const x of s.layout.sticksOut) out.push(`Sticks out ${s.where}: ${x}`);
    for (const x of s.layout.cutShort) out.push(`Text cut short ${s.where}: ${x}`);
    for (const e of new Set(s.errors)) out.push(`Page error ${s.where}: ${e}`);
  }
  for (const f of clicks?.failures ?? []) out.push(`Clicking "${f.label}" broke the page: ${f.errors.join("; ")}`);
  return out.slice(0, 30);
}
