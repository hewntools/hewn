// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, platform, tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { VisualWidget } from "@hewntools/core/ports.ts";
import { sourceAsset } from "./assets.ts";
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
 * Visual validation: render a candidate capability UI in a headless Chromium-based browser,
 * collect page errors and console errors, and take a screenshot. The UI is served from the build
 * workspace by a throwaway server whose API runs the candidate against a fresh, empty state,
 * so this also checks the "empty data" case. Talks to the browser over the DevTools protocol
 * (Node's built-in WebSocket); no dependencies.
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
}

export interface VisualResult {
  /** Why it didn't run (no browser found); the build is not failed for that. */
  skipped?: string;
  errors: string[];
  /** Rendered with prefers-color-scheme: light, then dark (both are checked for errors). */
  screenshot?: Buffer;
  screenshotDark?: Buffer;
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

/** Minimal DevTools protocol client over the browser's WebSocket. */
function cdp(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const listeners: ((m: any) => void)[] = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else for (const l of listeners) l(m);
  });
  const open = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("could not connect to the browser")));
  });
  return {
    open,
    send: (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<any>((resolve, reject) => {
        const msg = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
        pending.set(msg.id, { resolve, reject });
        ws.send(JSON.stringify(msg));
      }),
    on: (l: (m: any) => void) => listeners.push(l),
    close: () => ws.close(),
  };
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

export function chromiumCheck(browser: string | undefined = findBrowser()): VisualCheck {
  return async (req) => {
    if (!browser) return { skipped: "no Chromium-based browser found (Chrome, Edge, Brave or Chromium)", errors: [] };
    const width = req.width ?? 1280;
    const height = req.height ?? 800;
    const timeoutMs = req.timeoutMs ?? 30_000;
    const profile = mkdtempSync(join(tmpdir(), "hewn-visual-"));
    const site = await serveCandidate(req);
    const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", ...QUIET, "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--window-size=${width},${height}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let exited = false;
    child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    child.on("exit", () => (exited = true));
    child.on("error", (e) => ((exited = true), (stderr += `\nerror: ${e.message}`)));
    const errors: string[] = [];
    try {
      let url: string;
      try {
        url = await devtoolsUrl(profile, 30_000, () => exited);
      } catch {
        // The machine's problem, not the candidate's: skip the check (and say why) rather than fail the build.
        const why = stderr.split("\n").map((l) => l.replace(/^\[[^\]]*\]\s*/, "").trim()).find((l) => /error|fail|denied|cannot|missing/i.test(l));
        // Chromium won't run as root with its sandbox (containers): say how, rather than turn the sandbox off here.
        const root = process.getuid?.() === 0 ? " (Hewn runs as root: set HEWN_BROWSER to a browser that can, see docs/troubleshooting.md)" : "";
        return { skipped: `the browser (${browser.split("/").pop()}) didn't start${why ? `: ${why.slice(0, 200)}` : ""}${root}`, errors: [] };
      }
      const client = cdp(url);
      await client.open;
      const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
      const s = (m: string, p: Record<string, unknown> = {}) => client.send(m, p, sessionId);
      let loaded!: () => void;
      const load = new Promise<void>((r) => (loaded = r));
      client.on((m) => {
        if (m.sessionId !== sessionId) return;
        if (m.method === "Page.loadEventFired") loaded();
        if (m.method === "Runtime.exceptionThrown") errors.push(`uncaught: ${m.params.exceptionDetails.exception?.description?.split("\n")[0] ?? m.params.exceptionDetails.text}`);
        if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(`console.error: ${m.params.args.map((a: any) => a.value ?? a.description ?? "").join(" ").slice(0, 300)}`);
        // Not the UI's fault: the browser's own favicon request, and error answers from the
        // capability's API (an operation failing on empty, offline data is data the UI shows).
        const quiet = (u = "") => /\/favicon\.ico$/.test(u) || /^https?:\/\/[^/]+(\/tools\/[a-z0-9-]+)?\/api\//.test(u);
        if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !(m.params.entry.source === "network" && quiet(m.params.entry.url))) errors.push(`${m.params.entry.source}: ${m.params.entry.text}${m.params.entry.url ? ` (${m.params.entry.url.replace(/^https?:\/\/[^/]+/, "")})` : ""}`);
      });
      await Promise.all([s("Page.enable"), s("Runtime.enable"), s("Log.enable")]);
      await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await s("Page.navigate", { url: site.url });
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs));
      if ((await Promise.race([load, timeout])) === "timeout") errors.push(`page didn't finish loading in ${timeoutMs / 1000}s`);
      // Let the first round of API calls and rendering settle.
      await new Promise((r) => setTimeout(r, 1500));
      const scheme = (value: "light" | "dark") => s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
      await scheme("light");
      await new Promise((r) => setTimeout(r, 300));
      const light = await s("Page.captureScreenshot", { format: "png" });
      await scheme("dark");
      await new Promise((r) => setTimeout(r, 300));
      const dark = await s("Page.captureScreenshot", { format: "png" });
      client.close();
      return { errors: [...new Set(errors)], screenshot: Buffer.from(light.data, "base64"), screenshotDark: Buffer.from(dark.data, "base64") };
    } finally {
      // Cleanup never fails the check: wait for the browser to be gone before removing its
      // profile (it may still be writing to it), and leave leftovers to the OS temp cleaner.
      const gone = exited ? Promise.resolve() : new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGKILL");
      await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
      await site.close().catch(() => {});
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // a temp dir; not worth failing a build over
      }
    }
  };
}
