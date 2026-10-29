// SPDX-License-Identifier: AGPL-3.0-or-later
// A headless Chromium driven over the DevTools protocol (Node's WebSocket, no dependencies): full-page
// screenshots at desktop and phone sizes in light and dark, and errors on the page. What's measured on
// it (overflow, layout defects, the click-through) is Hewn's own, in @hewntools/cli/defects.ts.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeasuredPage } from "@hewntools/cli/defects.ts";
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

export interface Page extends MeasuredPage {
  scheme(value: "light" | "dark"): Promise<void>;
  /** The whole page (up to `maxHeight` CSS px), as PNG. */
  shot(maxHeight?: number): Promise<Buffer>;
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
