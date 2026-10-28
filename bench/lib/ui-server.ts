// SPDX-License-Identifier: AGPL-3.0-or-later
// Tool UIs served the way Hewn serves them: at /tools/<id>/~<key>/ with the same CSP sandbox and session
// shim, the design system at /_platform/, and /api/invoke going to that tool's own state. One server
// can serve many results side by side, each under its own key.
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { sourceAsset } from "@hewntools/cli/assets.ts";
import { uiCsp, withShim } from "@hewntools/host-workerd/surface/ui.ts";

export interface Served {
  id: string;
  /** The tool's ui/ directory. */
  uiDir: string;
  manifest: unknown;
  /** Runs an operation; returns the body the real UI API sends ({ result }), throws its error. */
  invoke: (body: { operation: string; operationVersion?: number; input?: unknown }) => Promise<unknown>;
}

export const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".md": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
};

export type Extra = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> | boolean;

export interface UiServer {
  web: string;
  /** Where the owner (or a browser) opens a result's UI. */
  url: (key: string, id: string) => string;
  close: () => Promise<void>;
}

export async function readBody(r: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of r) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startUiServer(lookup: (key: string) => Served | undefined | Promise<Served | undefined>, opts: { port?: number; host?: string; extra?: Extra } = {}): Promise<UiServer> {
  let web = "";
  const server = createServer(async (r, res) => {
    try {
      const url = new URL(r.url ?? "/", web);
      const asset = /^\/_platform\/([a-z.]+)$/.exec(url.pathname)?.[1];
      if (asset) {
        const data = await sourceAsset(`platform-ui/${asset}`);
        if (data) return void res.writeHead(200, { "content-type": TYPES[extname(asset)] ?? "text/plain", "access-control-allow-origin": "*" }).end(data);
      }
      const m = /^\/tools\/([a-z0-9][a-z0-9-]*)\/~([A-Za-z0-9_-]+)(\/.*)$/.exec(url.pathname);
      if (!m) {
        if (opts.extra && (await opts.extra(r, res, url))) return;
        return void res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      }
      const [, id, key, path] = m;
      const s = await lookup(key);
      const csp = uiCsp(web, id);
      const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json", "content-security-policy": csp, "access-control-allow-origin": "null" }).end(JSON.stringify(body));
      if (!s || s.id !== id) return json(404, { error: "not found" });
      if (path.startsWith("/api/") && r.method === "OPTIONS") {
        return void res.writeHead(204, { "access-control-allow-origin": "null", "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "authorization, content-type, x-hewn-ui" }).end();
      }
      if (path === "/api/manifest") return json(200, s.manifest);
      if (path === "/api/invoke" && r.method === "POST") {
        try {
          return json(200, await s.invoke(JSON.parse((await readBody(r)) || "{}")));
        } catch (e) {
          return json(400, { error: (e as { code?: string }).code ?? "operation_failed", message: (e as Error).message });
        }
      }
      if (path.startsWith("/api/")) return json(404, { error: "not found" });
      const rel = path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
      const file = join(s.uiDir, rel);
      if (!file.startsWith(s.uiDir + "/") || !existsSync(file) || !statSync(file).isFile()) return json(404, { error: "not found" });
      const type = TYPES[extname(file)] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": type, "content-security-policy": csp, "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(type.startsWith("text/html") ? withShim(readFileSync(file, "utf8")) : readFileSync(file));
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(String((e as Error).stack ?? e));
    }
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  web = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    web,
    url: (key, id) => `${web}/tools/${id}/~${key}/#hewn_session=bench`,
    close: () => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
  };
}
