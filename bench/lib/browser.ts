// SPDX-License-Identifier: AGPL-3.0-or-later
// A headless Chromium driven over the DevTools protocol (Node's WebSocket, no dependencies): full-page
// screenshots at desktop and phone sizes in light and dark, errors on the page, and a quick click-through.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrowser } from "@hewntools/cli/visual.ts";

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string };

export interface Viewport {
  name: string;
  width: number;
  height: number;
  mobile: boolean;
  scale: number;
}
export const DESKTOP: Viewport = { name: "desktop", width: 1280, height: 900, mobile: false, scale: 1 };
export const PHONE: Viewport = { name: "mobile", width: 390, height: 844, mobile: true, scale: 2 };

export interface Page {
  goto(url: string, settleMs?: number): Promise<void>;
  scheme(value: "light" | "dark"): Promise<void>;
  /** The whole page (up to `maxHeight` CSS px), as PNG. */
  shot(maxHeight?: number): Promise<Buffer>;
  eval<T = unknown>(expression: string): Promise<T>;
  /** Uncaught exceptions, console.error, and failed loads, since the last `clear()`. */
  errors: string[];
  /** The tool's API calls that answered with an error status. */
  apiErrors: string[];
  /** alert/confirm/prompt dialogs the page opened (each dismissed). */
  dialogs: string[];
  clear(): void;
  close(): Promise<void>;
}

export interface Browser {
  page(v: Viewport): Promise<Page>;
  close(): Promise<void>;
}

export async function launchBrowser(binary = process.env.HEWN_BROWSER ?? findBrowser()): Promise<Browser> {
  if (!binary) throw new Error("no Chromium-based browser found (set HEWN_BROWSER, or `npx playwright install chromium-headless-shell`)");
  const profile = mkdtempSync(join(tmpdir(), "hewn-bench-browser-"));
  const child = spawn(binary, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars", "--mute-audio", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let exited = false;
  child.on("exit", () => (exited = true));
  const portFile = join(profile, "DevToolsActivePort");
  const until = Date.now() + 30_000;
  while (!existsSync(portFile) || readFileSync(portFile, "utf8").split("\n").length < 2) {
    if (exited || Date.now() > until) throw new Error(`the browser (${binary}) didn't start`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const [port, path] = readFileSync(portFile, "utf8").split("\n");
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise<void>((resolve, reject) => ((ws.onopen = () => resolve()), (ws.onerror = () => reject(new Error("couldn't connect to the browser")))));
  let next = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const listeners = new Set<(m: Msg) => void>();
  ws.onmessage = (e) => {
    const m: Msg = JSON.parse(String(e.data));
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else for (const l of listeners) l(m);
  };
  // Nothing waits forever: a page that blocks (a dialog, an endless loop) fails the call instead.
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 60_000) =>
    new Promise<any>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => (pending.delete(id), reject(new Error(`${method} took over ${timeoutMs / 1000}s`))), timeoutMs);
      pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  return {
    async page(v) {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const s = (method: string, params: Record<string, unknown> = {}) => send(method, params, sessionId);
      const errors: string[] = [];
      const apiErrors: string[] = [];
      const dialogs: string[] = [];
      let loaded: (() => void) | undefined;
      let loads = 0;
      const onMsg = (m: Msg) => {
        if (m.sessionId !== sessionId) return;
        if (m.method === "Page.loadEventFired") loaded?.();
        // alert/confirm/prompt block the page until answered: dismiss them (a confirm is cancelled) and note it.
        if (m.method === "Page.javascriptDialogOpening") {
          dialogs.push(`${m.params.type}: ${String(m.params.message).slice(0, 120)}`);
          void send("Page.handleJavaScriptDialog", { accept: false }, sessionId).catch(() => {});
        }
        if (m.method === "Runtime.exceptionThrown") errors.push(`uncaught: ${m.params.exceptionDetails.exception?.description?.split("\n")[0] ?? m.params.exceptionDetails.text}`);
        if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(`console.error: ${m.params.args.map((a: any) => a.value ?? a.description ?? "").join(" ").slice(0, 300)}`);
        if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !/\/api\/|favicon\.ico/.test(m.params.entry.url ?? "")) errors.push(`${m.params.entry.source}: ${m.params.entry.text}`);
        if (m.method === "Network.responseReceived" && /\/api\/invoke$/.test(m.params.response.url) && m.params.response.status >= 400) apiErrors.push(`${m.params.response.status} ${m.params.response.url.replace(/^.*\/tools\//, "/tools/")}`);
      };
      listeners.add(onMsg);
      await Promise.all([s("Page.enable"), s("Runtime.enable"), s("Log.enable"), s("Network.enable")]);
      await s("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.scale, mobile: v.mobile });
      if (v.mobile) await s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      const page: Page = {
        errors,
        apiErrors,
        dialogs,
        clear: () => ((errors.length = 0), (apiErrors.length = 0), (dialogs.length = 0)),
        async goto(url, settleMs = 1500) {
          const load = new Promise<void>((r) => (loaded = r));
          // A fresh load every time: the same URL with only a fragment would be a same-document
          // navigation (no load event, no new page).
          const u = new URL(url);
          u.searchParams.set("_load", String(++loads));
          await s("Page.navigate", { url: u.href });
          const timedOut = await Promise.race([load.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 30_000))]);
          if (timedOut) errors.push("page didn't finish loading in 30s");
          await new Promise((r) => setTimeout(r, settleMs));
        },
        async scheme(value) {
          await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
          await new Promise((r) => setTimeout(r, 400));
        },
        async shot(maxHeight = 5000) {
          const { cssContentSize } = await s("Page.getLayoutMetrics");
          const height = Math.min(Math.max(Math.ceil(cssContentSize.height), v.height), maxHeight);
          const { data } = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: v.width, height, scale: 1 } });
          return Buffer.from(data, "base64");
        },
        async eval<T>(expression: string) {
          const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
          return r.result.value as T;
        },
        async close() {
          listeners.delete(onMsg);
          await send("Target.closeTarget", { targetId }).catch(() => {});
        },
      };
      return page;
    },
    async close() {
      ws.close();
      const gone = exited ? Promise.resolve() : new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGKILL");
      await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // a temp dir
      }
    },
  };
}

/**
 * How far (CSS px) anything sticks out past the right edge on this screen: the page itself, or an
 * element that's cut off because the page hides what overflows. Elements inside a deliberate
 * scroller or clipping box (a carousel, a table-wrap) don't count.
 */
export const overflowX = (page: Page, screenWidth?: number) =>
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
 * What a builder should fix on this screen, measured: elements that stick out past the screen's
 * right edge (outermost ones, with how far), and text cut short (an ellipsis or clipped text).
 */
export const layoutDefects = (page: Page, screenWidth: number) =>
  page.eval<{ sticksOut: string[]; cutShort: string[] }>(`(() => {
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

/** What the bench clicks: visible, enabled controls that don't delete, archive or reset anything. */
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
export async function clickThrough(page: Page, url: string, limit = 20): Promise<ClickResult> {
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
