// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, platform, tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { VisualShot, VisualWidget } from "@hewntools/core/ports.ts";
import { sourceAsset } from "./assets.ts";
import { clickThrough, defectLines, layoutDefects, type MeasuredPage, onScreen, type ScreenDefects } from "./defects.ts";
import { uiCsp, withShim } from "@hewntools/host-workerd/surface/ui.ts";

/** The widget sheet: every widget in every size it offers, at Home's sizes, drawn by the platform renderer. */
const SHEET_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Widgets</title><link rel="stylesheet" href="/_platform/ui.css"><link rel="stylesheet" href="/sheet.css"></head><body><main id="sheet"></main><script type="module" src="/sheet.js"></script></body></html>`;
const SHEET_CSS = `body { padding: 24px; } #sheet { display: flex; flex-wrap: wrap; gap: 28px 20px; align-items: flex-start; }
figure { margin: 0; display: flex; flex-direction: column; gap: 6px; } figcaption { font: 11px var(--mono); color: var(--text-3); }
.cell { display: flex; } .cell > .jw { flex: 1; } .small { width: 112px; height: 116px; } .medium { width: 236px; height: 116px; } .large { width: 236px; height: 268px; }`;
const SHEET_JS = `import { renderWidget } from "/_platform/widgets.js";
const widgets = await (await fetch("/api/sheet")).json();
const sheet = document.getElementById("sheet");
for (const w of widgets) for (const size of w.sizes) {
  const cell = document.createElement("div");
  cell.className = "cell " + size;
  renderWidget(cell, w.view, { size, title: w.title, onButton: () => {} });
  const fig = document.createElement("figure");
  const cap = document.createElement("figcaption");
  cap.textContent = w.name + " · " + size;
  fig.append(cell, cap);
  sheet.append(fig);
}
// Content cut off at a size fails the check: the widget should drop that size or show less there.
// Revealed text counts too (it replaces the body when "Show" is tapped).
await document.fonts.ready;
await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const clipped = (el) => el && el.scrollHeight > el.clientHeight + 2;
for (const fig of sheet.children) {
  const label = fig.querySelector("figcaption").textContent;
  const body = () => fig.querySelector(".jw-body");
  if (clipped(body()) || clipped(fig.querySelector(".jw-text"))) console.error(\`widget \${label}: the content doesn't fit. Show less at this size, or don't offer it.\`);
  const show = fig.querySelector(".jw-show");
  if (show) {
    show.click();
    if (clipped(body())) console.error(\`widget \${label}: the revealed text doesn't fit. Shorten it at this size, or don't offer it.\`);
  }
}`;

/**
 * Visual validation: render a candidate capability UI in a headless Chromium-based browser, on a
 * desktop and a phone screen, collect page errors and console errors, and take screenshots. The UI
 * is served from the build workspace by a throwaway server whose API runs the candidate against the
 * state the caller gives it (a fresh, empty one checks the "empty data" case). Talks to the browser
 * over the DevTools protocol (Node's built-in WebSocket); no dependencies.
 */

export interface VisualRequest {
  /** The candidate's ui/ directory. */
  uiDir: string;
  manifest: unknown;
  /** Runs an operation on the candidate; returns the body the real UI API would send. */
  invoke: (body: { operation: string; operationVersion?: number; input?: unknown }) => Promise<unknown>;
  /** Render a sheet of these widgets (each size, platform renderer) instead of the UI. */
  widgets?: VisualWidget[];
  width?: number;
  height?: number;
  timeoutMs?: number;
  /**
   * Also measure what a builder should fix (defects.ts): what sticks out past each screen's edge,
   * text cut short, and controls that break the page when clicked. Clicks write: give it state
   * that's a copy.
   */
  measure?: boolean;
}

export interface VisualResult {
  /** Why it didn't run (no browser found); the build is not failed for that. */
  skipped?: string;
  /** From both screens, light and dark; one only the phone shows says so ("on the phone (390 px): …"). */
  errors: string[];
  /** The desktop screen as it first shows, with prefers-color-scheme: light, then dark: the build page's. */
  screenshot?: Buffer;
  screenshotDark?: Buffer;
  /**
   * The UI (not the widget sheet) whole, down to 5,000 px, 1280 and 390 px wide, light and dark: four
   * images, a long page in parts ("mobile-light", then "mobile-light-2" …; see `wholePageParts`).
   */
  shots?: VisualShot[];
  /** With `measure`: what to fix, one line each (defectLines). */
  defects?: string[];
}

export type VisualCheck = (req: VisualRequest) => Promise<VisualResult>;

/**
 * A Chromium-based browser on this machine. Playwright's headless shell first: it's a plain
 * binary with no updater. Launching an app from /Applications (Chrome, Edge…) lets its updater
 * touch the app bundle, which macOS reports as node wanting "App Management" permission.
 */
export function findBrowser(userHome = homedir(), os = platform()): string | undefined {
  if (process.env.HEWN_BROWSER && existsSync(process.env.HEWN_BROWSER)) return process.env.HEWN_BROWSER;
  const pw = os === "darwin" ? join(userHome, "Library", "Caches", "ms-playwright") : join(process.env.XDG_CACHE_HOME ?? join(userHome, ".cache"), "ms-playwright");
  if (existsSync(pw)) {
    for (const d of readdirSync(pw).filter((x) => x.startsWith("chromium_headless_shell-") || x.startsWith("chromium-")).sort().reverse()) {
      for (const sub of readdirSync(join(pw, d))) {
        for (const name of ["chrome-headless-shell", "headless_shell", "chrome"]) {
          const bin = join(pw, d, sub, name);
          if (existsSync(bin)) return bin;
        }
      }
    }
  }
  if (os === "darwin") {
    const apps = [
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
    return apps.find((a) => existsSync(a));
  }
  // Linux / WSL: a browser on PATH.
  for (const bin of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome", "microsoft-edge"]) {
    const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return undefined;
}

/** Keep a full browser quiet: no updates, sync, default apps or Keychain. */
const QUIET = [
  "--disable-component-update",
  "--disable-background-networking",
  "--no-service-autorun",
  "--disable-sync",
  "--disable-default-apps",
  "--password-store=basic",
  "--use-mock-keychain",
  "--disable-features=Translate,MediaRouter,OptimizationHints",
];

/** A screen to render on: its size in CSS px, whether it's a touch screen, and its pixels per CSS px. */
export interface Screen {
  name: string;
  width: number;
  height: number;
  mobile: boolean;
  scale: number;
}
/** The phone a UI is rendered on, here and in the build-quality bench. */
export const PHONE: Screen = { name: "mobile", width: 390, height: 844, mobile: true, scale: 2 };

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };

// The widget sheet is the platform's own page (widget views are data, rendered by widgets.js).
const SHEET_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'";
const CANDIDATE = "candidate";

/**
 * The candidate UI on a random local port, at /tools/candidate/ with the same sandbox, CSP and
 * session shim as a real UI (ui.ts), so what breaks there breaks here first.
 */
async function serveCandidate(req: VisualRequest) {
  let web = "";
  const server = createServer(async (r, res) => {
    const url = new URL(r.url ?? "/", web);
    const asset = /^\/_platform\/([a-z.]+)$/.exec(url.pathname)?.[1];
    if (asset) {
      const data = await sourceAsset(`platform-ui/${asset}`);
      if (data) return void res.writeHead(200, { "content-type": asset.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", "access-control-allow-origin": "*" }).end(data);
    }
    if (req.widgets) {
      const page = (type: string, body: string) => res.writeHead(200, { "content-type": type, "content-security-policy": SHEET_CSP, "cache-control": "no-store" }).end(body);
      if (url.pathname === "/") return page(TYPES[".html"], SHEET_HTML);
      // In ui.css's cascade layer ("hewn"), as app.css is on Home, so widgets cascade as they do there.
      if (url.pathname === "/sheet.css") return page("text/css; charset=utf-8", `@layer hewn {${SHEET_CSS}}`);
      if (url.pathname === "/sheet.js") return page(TYPES[".js"], SHEET_JS);
      if (url.pathname === "/api/sheet") return page("application/json", JSON.stringify(req.widgets));
      return void res.writeHead(404).end();
    }
    const csp = uiCsp(web, CANDIDATE);
    const prefix = `/tools/${CANDIDATE}`;
    const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json", "content-security-policy": csp, "access-control-allow-origin": "null" }).end(JSON.stringify(body));
    if (!url.pathname.startsWith(`${prefix}/`)) return json(404, { error: "not found" });
    const path = url.pathname.slice(prefix.length);
    if (path.startsWith("/api/") && r.method === "OPTIONS") {
      return void res.writeHead(204, { "access-control-allow-origin": "null", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "authorization, content-type, x-hewn-ui" }).end();
    }
    if (path === "/api/manifest") return json(200, req.manifest);
    if (path === "/api/invoke" && r.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of r) chunks.push(c as Buffer);
      try {
        return json(200, await req.invoke(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")));
      } catch (e) {
        return json(400, { error: "operation_failed", message: (e as Error).message });
      }
    }
    if (path.startsWith("/api/")) return json(404, { error: "not found" });
    const rel = path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
    const file = join(req.uiDir, rel);
    if (!file.startsWith(req.uiDir + "/") || !existsSync(file) || !statSync(file).isFile()) return json(404, { error: "not found" });
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "content-security-policy": csp, "cache-control": "no-store", "access-control-allow-origin": "*" });
    res.end(type.startsWith("text/html") ? withShim(readFileSync(file, "utf8")) : readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  web = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const entry = req.widgets ? `${web}/` : `${web}/tools/${CANDIDATE}/#hewn_session=visual-check`;
  return { url: entry, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Wait for Chromium to write its DevTools port (it picks a free one with --remote-debugging-port=0). */
async function devtoolsUrl(profile: string, timeoutMs: number, exited: () => boolean = () => false): Promise<string> {
  const file = join(profile, "DevToolsActivePort");
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && !exited()) {
    if (existsSync(file)) {
      const [port, path] = readFileSync(file, "utf8").split("\n");
      if (port && path) return `ws://127.0.0.1:${port.trim()}${path.trim()}`;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the browser didn't start");
}

/** The tallest part of a whole-page render, in image px, and the most pixels in one (see `wholePageParts`). */
const MAX_PART_PX = 2000;
const MAX_PART_PIXELS = 1_600_000;

type Msg = { id?: number; method?: string; params?: any; result?: any; error?: { message: string }; sessionId?: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tab in the browser, at one screen's size. */
export interface Page extends MeasuredPage {
  scheme(value: "light" | "dark"): Promise<void>;
  /** What's on screen, as PNG. */
  shot(): Promise<Buffer>;
  /** The whole page, down to `maxHeight` CSS px, as PNG. */
  wholePage(maxHeight?: number): Promise<Buffer>;
  /**
   * The whole page, down to `maxHeight` CSS px, in parts a model reads as they are, top to bottom: each
   * at most 2,000 px tall and 1.6 megapixels (a model's client shrinks a taller image until it can't be read).
   */
  wholePageParts(maxHeight?: number): Promise<Buffer[]>;
  close(): Promise<void>;
}

export interface Browser {
  page(screen: Screen): Promise<Page>;
  close(): Promise<void>;
}

/**
 * A headless Chromium driven over the DevTools protocol (Node's built-in WebSocket, no
 * dependencies): the visual check's, and the build-quality bench's. A browser that won't start
 * throws, saying why ("the browser (chrome) didn't start: …"). Nothing waits forever: a page that
 * blocks (an endless loop) fails the call after `callTimeoutMs`, and alert/confirm/prompt are
 * dismissed.
 */
export async function launchBrowser(binary: string, opts: { flags?: string[]; loadTimeoutMs?: number; callTimeoutMs?: number } = {}): Promise<Browser> {
  const loadTimeoutMs = opts.loadTimeoutMs ?? 30_000;
  const callTimeoutMs = opts.callTimeoutMs ?? 60_000;
  const profile = mkdtempSync(join(tmpdir(), "hewn-browser-"));
  const child = spawn(binary, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", ...QUIET, ...(opts.flags ?? []), "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let exited = false;
  child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  child.on("exit", () => (exited = true));
  child.on("error", (e) => ((exited = true), (stderr += `\nerror: ${e.message}`)));
  const close = async () => {
    // Cleanup never fails anything: wait for the browser to be gone before removing its profile
    // (it may still be writing to it), and leave leftovers to the OS temp cleaner.
    const gone = exited ? Promise.resolve() : new Promise<void>((r) => child.once("exit", () => r()));
    child.kill("SIGKILL");
    await Promise.race([gone, sleep(3000)]);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // a temp dir
    }
  };
  let ws: WebSocket;
  try {
    ws = new WebSocket(await devtoolsUrl(profile, 30_000, () => exited));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("could not connect to the browser")));
    });
  } catch {
    await close();
    const why = stderr.split("\n").map((l) => l.replace(/^\[[^\]]*\]\s*/, "").trim()).find((l) => /error|fail|denied|cannot|missing/i.test(l));
    throw new Error(`the browser (${binary.split("/").pop()}) didn't start${why ? `: ${why.slice(0, 200)}` : ""}`);
  }
  let next = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const listeners = new Set<(m: Msg) => void>();
  ws.addEventListener("message", (e) => {
    const m: Msg = JSON.parse(String(e.data));
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else for (const l of listeners) l(m);
  });
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<any>((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => (pending.delete(id), reject(new Error(`the page stopped responding (${method} took over ${callTimeoutMs / 1000}s)`))), callTimeoutMs);
      pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  return {
    async page(screen) {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const s = (method: string, params: Record<string, unknown> = {}) => send(method, params, sessionId);
      const errors: string[] = [];
      const apiErrors: string[] = [];
      const dialogs: string[] = [];
      let loaded = () => {};
      let loads = 0;
      const onMsg = (m: Msg) => {
        if (m.sessionId !== sessionId) return;
        if (m.method === "Page.loadEventFired") loaded();
        // alert/confirm/prompt block the page until answered: dismiss them (a confirm is cancelled) and note it.
        if (m.method === "Page.javascriptDialogOpening") {
          dialogs.push(`${m.params.type}: ${String(m.params.message).slice(0, 120)}`);
          void s("Page.handleJavaScriptDialog", { accept: false }).catch(() => {});
        }
        if (m.method === "Runtime.exceptionThrown") errors.push(`uncaught: ${m.params.exceptionDetails.exception?.description?.split("\n")[0] ?? m.params.exceptionDetails.text}`);
        if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(`console.error: ${m.params.args.map((a: any) => a.value ?? a.description ?? "").join(" ").slice(0, 300)}`);
        // Not the UI's fault: the browser's own favicon request, and error answers from the
        // capability's API (an operation failing on empty, offline data is data the UI shows).
        const quiet = (u = "") => /\/favicon\.ico$/.test(u) || /^https?:\/\/[^/]+(\/tools\/[a-z0-9-]+)?\/api\//.test(u);
        if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !(m.params.entry.source === "network" && quiet(m.params.entry.url))) errors.push(`${m.params.entry.source}: ${m.params.entry.text}${m.params.entry.url ? ` (${m.params.entry.url.replace(/^https?:\/\/[^/]+/, "")})` : ""}`);
        if (m.method === "Network.responseReceived" && /\/api\/invoke$/.test(m.params.response.url) && m.params.response.status >= 400) apiErrors.push(`${m.params.response.status} ${m.params.response.url.replace(/^https?:\/\/[^/]+/, "")}`);
      };
      listeners.add(onMsg);
      await Promise.all([s("Page.enable"), s("Runtime.enable"), s("Log.enable"), s("Network.enable")]);
      await s("Emulation.setDeviceMetricsOverride", { width: screen.width, height: screen.height, deviceScaleFactor: screen.scale, mobile: screen.mobile });
      if (screen.mobile) await s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
      return {
        errors,
        apiErrors,
        dialogs,
        clear: () => ((errors.length = 0), (apiErrors.length = 0), (dialogs.length = 0)),
        async goto(url, settleMs = 1500) {
          const load = new Promise<void>((r) => (loaded = r));
          // After the first, a fresh load every time: the same URL again (its fragment the same) would
          // be a same-document navigation, with no load event and no new page.
          const u = new URL(url);
          if (loads++) u.searchParams.set("_load", String(loads));
          await s("Page.navigate", { url: u.href });
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timedOut = await Promise.race([load.then(() => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(true), loadTimeoutMs)))]);
          clearTimeout(timer);
          if (timedOut) errors.push(`page didn't finish loading in ${loadTimeoutMs / 1000}s`);
          // Let the first round of API calls and rendering settle.
          await sleep(settleMs);
        },
        async eval<T>(expression: string) {
          const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
          return r.result.value as T;
        },
        async scheme(value) {
          await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
          await sleep(300);
        },
        async shot() {
          return Buffer.from((await s("Page.captureScreenshot", { format: "png" })).data, "base64");
        },
        async wholePage(maxHeight = 5000) {
          const { cssContentSize } = await s("Page.getLayoutMetrics");
          const height = Math.min(Math.max(Math.ceil(cssContentSize.height), screen.height), maxHeight);
          const { data } = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: screen.width, height, scale: 1 } });
          return Buffer.from(data, "base64");
        },
        async wholePageParts(maxHeight = 5000) {
          const { cssContentSize } = await s("Page.getLayoutMetrics");
          const height = Math.min(Math.max(Math.ceil(cssContentSize.height), screen.height), maxHeight);
          const most = Math.floor(Math.min(MAX_PART_PX / screen.scale, MAX_PART_PIXELS / (screen.width * screen.scale ** 2)));
          // Even parts: no sliver left over at the end.
          const n = Math.ceil(height / most);
          const part = Math.ceil(height / n);
          const out: Buffer[] = [];
          for (let y = 0; y < height; y += part) {
            const { data } = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y, width: screen.width, height: Math.min(part, height - y), scale: 1 } });
            out.push(Buffer.from(data, "base64"));
          }
          return out;
        },
        async close() {
          listeners.delete(onMsg);
          await send("Target.closeTarget", { targetId }).catch(() => {});
        },
      };
    },
    async close() {
      ws.close();
      await close();
    },
  };
}

export function chromiumCheck(browser: string | undefined = findBrowser()): VisualCheck {
  return async (req) => {
    if (!browser) return { skipped: "no Chromium-based browser found (Chrome, Edge, Brave or Chromium)", errors: [] };
    const desktop: Screen = { name: "desktop", width: req.width ?? 1280, height: req.height ?? 800, mobile: false, scale: 1 };
    let b: Browser;
    try {
      b = await launchBrowser(browser, { flags: [`--window-size=${desktop.width},${desktop.height}`], loadTimeoutMs: req.timeoutMs });
    } catch (e) {
      // The machine's problem, not the candidate's: skip the check (and say why) rather than fail the build.
      // Chromium won't run as root with its sandbox (containers): say how, rather than turn the sandbox off here.
      const root = process.getuid?.() === 0 ? " (Hewn runs as root: set HEWN_BROWSER to a browser that can, see docs/troubleshooting.md)" : "";
      return { skipped: `${(e as Error).message}${root}`, errors: [] };
    }
    const site = await serveCandidate(req);
    try {
      // The widget sheet: on the desktop screen, light and dark.
      if (req.widgets) {
        const sheet = await b.page(desktop);
        await sheet.goto(site.url);
        await sheet.scheme("light");
        const light = await sheet.shot();
        await sheet.scheme("dark");
        const dark = await sheet.shot();
        return { errors: [...new Set(sheet.errors)], screenshot: light, screenshotDark: dark };
      }

      // The UI: on the desktop screen (what's on screen is the build page's screenshot, light and
      // dark), then on the phone, each also whole.
      const shots: VisualShot[] = [];
      const screens: ScreenDefects[] = [];
      const render = async (screen: Screen) => {
        const page = await b.page(screen);
        await page.goto(site.url);
        await page.scheme("light");
        const layout = req.measure ? await layoutDefects(page, screen.width) : undefined;
        const whole = async (scheme: string) => (await page.wholePageParts()).forEach((png, i) => shots.push({ name: `${screen.name}-${scheme}${i ? `-${i + 1}` : ""}`, png }));
        const light = await page.shot();
        await whole("light");
        await page.scheme("dark");
        const dark = await page.shot();
        await whole("dark");
        const errors = [...page.errors];
        // The phone's first, as a builder should fix them.
        if (layout) screens.unshift({ where: onScreen(screen.width, screen.mobile), layout, errors });
        return { page, errors, light, dark };
      };
      const wide = await render(desktop);
      const phone = await render(PHONE);
      const errors = [...new Set([...wide.errors, ...phone.errors.filter((e) => !wide.errors.includes(e)).map((e) => `${onScreen(PHONE.width, true)}: ${e}`)])];
      let defects: string[] | undefined;
      if (req.measure) {
        // The click-through reloads the page for each control: after the shots, on the desktop screen.
        const clicks = await clickThrough(wide.page, site.url);
        defects = defectLines(screens, clicks);
      }
      return { errors, screenshot: wide.light, screenshotDark: wide.dark, shots, ...(defects ? { defects } : {}) };
    } finally {
      await b.close();
      await site.close().catch(() => {});
    }
  };
}
