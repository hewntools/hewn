// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { Platform } from "@hewntools/core/platform.ts";
import { handle, McpSessions, type SurfaceHost } from "@hewntools/host-workerd/surface/index.ts";
import { gatePublic, RateLimiter } from "@hewntools/host-workerd/surface/public.ts";

/** Node http ↔ the web-standard surface handler. */
export async function bridge(req: IncomingMessage, res: ServerResponse, handler: (r: Request) => Promise<Response>) {
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const x of Array.isArray(v) ? v : [v]) headers.append(k, x);
  }
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : (Readable.toWeb(req) as ReadableStream),
    signal: abort.signal,
    duplex: "half", // Node needs this for streaming request bodies
  };
  const response = await handler(new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`, init));
  const out: Record<string, string | string[]> = {};
  response.headers.forEach((v, k) => {
    if (k !== "set-cookie") out[k] = v;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  res.writeHead(response.status, out);
  if (!response.body) return void res.end();
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (!res.write(chunk)) await new Promise((r) => res.once("drain", r));
    }
  } catch {
    // client went away
  }
  res.end();
}

/** Hewn HTTP surface: web client, capability UIs, MCP at /mcp and OAuth. */
export function startServer(platform: Platform, port: number, host: (actualPort: number) => SurfaceHost, bind = "127.0.0.1"): Promise<Server & { surface?: SurfaceHost }> {
  let surface: SurfaceHost | undefined;
  let sessions: McpSessions | undefined;
  const server: Server & { surface?: SurfaceHost } = createServer((req, res) => {
    surface ??= server.surface = host((server.address() as AddressInfo).port);
    sessions ??= new McpSessions(platform, surface.log, (p) => surface!.asset(p));
    bridge(req, res, (r) => handle(platform, sessions!, surface!, r)).catch((e) => {
      console.error(e);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  // Open MCP sessions hold notification streams: end them, or close() would wait forever.
  const close = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    sessions?.dispose();
    setImmediate(() => server.closeAllConnections());
    return close(cb);
  }) as typeof server.close;
  return new Promise((resolve) => server.listen(port, bind, () => resolve(server)));
}

/**
 * The public listener a tunnel points at: only MCP and OAuth, rate limited, each request
 * logged. Forwards to the main surface.
 */
export function startPublicServer(main: Server, port: number, log: (line: string) => void, limiter = new RateLimiter(), proxySecret?: string): Promise<Server> {
  const target = () => (main.address() as AddressInfo).port;
  const server = createServer((req, res) => {
    bridge(req, res, async (r) => {
      const gated = gatePublic(r, limiter, log, proxySecret);
      if (gated instanceof Response) return gated;
      const url = new URL(gated.url);
      const headers = new Headers(gated.headers);
      // Hop-by-hop headers stay here; the public host travels as x-forwarded-host.
      if (!headers.has("x-forwarded-host") && headers.has("host")) headers.set("x-forwarded-host", headers.get("host")!);
      for (const h of ["host", "connection", "content-length", "transfer-encoding", "keep-alive"]) headers.delete(h);
      return fetch(`http://127.0.0.1:${target()}${url.pathname}${url.search}`, {
        method: gated.method,
        headers,
        // Small requests (OAuth forms, JSON-RPC): buffered.
        body: gated.method === "GET" || gated.method === "HEAD" ? undefined : await gated.arrayBuffer(),
        signal: gated.signal,
        redirect: "manual",
      });
    }).catch((e) => {
      log(`[public] proxy error: ${(e as Error).message}${(e as { cause?: Error }).cause ? ` (${(e as { cause: Error }).cause.message})` : ""}`);
      if (!res.headersSent) res.writeHead(502).end();
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

export const serverUrl = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`;
