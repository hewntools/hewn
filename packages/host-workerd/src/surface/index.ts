// SPDX-License-Identifier: AGPL-3.0-or-later
// Hewn's whole HTTP surface as one web-standard handler: the owner's web client
// (hewn.localhost), capability UIs under it (/tools/<id>/), MCP at /mcp and the OAuth endpoints agents
// connect with. Runs on Node and on workerd. Requests marked public came through the public
// listener (a reverse proxy or a tunnel, see public.ts): on the public URL's host they reach the
// web client and capability UIs too (site.ts); on any other host only MCP and OAuth.
import type { Platform } from "@hewntools/core/platform.ts";
import type { SurfaceHost } from "./host.ts";
import { json } from "./http.ts";
import type { McpSessions } from "./mcp-sessions.ts";
import { challenge, handleOAuth, OAUTH_PATHS, originOf } from "./oauth.ts";
import { CLIENT_IP_HEADER, PUBLIC_HEADER, PUBLIC_PATHS } from "./public.ts";
import { localSite, publicSite, requestHost, type Site, uiPath } from "./site.ts";
import { handleUi } from "./ui.ts";
import { handleWeb } from "./web.ts";

export type { SurfaceHost } from "./host.ts";
export { McpSessions } from "./mcp-sessions.ts";

export async function handle(platform: Platform, sessions: McpSessions, host: SurfaceHost, req: Request): Promise<Response> {
  const isPublic = req.headers.get(PUBLIC_HEADER) === "1";
  const url = new URL(req.url);
  try {
    if (isPublic) {
      const publicUrl = platform.publicUrl();
      const site = publicUrl ? publicSite(publicUrl) : undefined;
      const web = !!site?.isWeb(requestHost(req));
      let res: Response;
      if (PUBLIC_PATHS.has(url.pathname)) res = await route(platform, sessions, host, req, url, true, site);
      else if (site && web) res = await browser(platform, host, site, req, url);
      else res = json(404, { error: "not_found" });
      // The browser's own traffic stays out of the log unless it fails; agents and sign-in are always logged.
      if (!web || res.status >= 400 || req.method !== "GET") host.log(`[public] ${req.headers.get(CLIENT_IP_HEADER) ?? "?"} ${req.method} ${requestHost(req)}${url.pathname.replace(/\/~[^/]+/, "/~…")} -> ${res.status}`);
      return res;
    }
    // DNS rebinding: a web page whose own name resolves to 127.0.0.1 reaches this port with its own
    // Host (and, for MCP, its own Origin). Only loopback names answer locally.
    if (!isLoopbackName(hostName(req.headers.get("host")))) return json(421, { error: "misdirected_request", message: "this port answers only on 127.0.0.1, localhost and hewn.localhost" });
    const local = localSite(host.port);
    if (local.isWeb(req.headers.get("host"))) return await browser(platform, host, local, req, url);
    if (url.pathname === "/health") return json(200, { ok: true });
    const origin = req.headers.get("origin");
    if (url.pathname === "/mcp" && origin && origin !== "null" && !isLoopbackName(hostName(urlHost(origin)))) return json(403, { error: "forbidden", message: "MCP on this port takes no requests from web pages on other sites" });
    return await route(platform, sessions, host, req, url, false);
  } catch (e) {
    host.log(`http error: ${(e as Error).stack ?? e}`);
    return json(500, { error: "internal" });
  }
}

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "hewn.localhost", "[::1]"]);
const isLoopbackName = (name: string) => LOOPBACK_NAMES.has(name);
/** A Host header's name, lowercased, without the port. */
const hostName = (host: string | null) => (host ?? "").toLowerCase().replace(/:\d+$/, "");
const urlHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

/** A browser on a site: a capability UI under /tools/<id>/, else the web client. */
function browser(platform: Platform, host: SurfaceHost, site: Site, req: Request, url: URL): Promise<Response> {
  const ui = uiPath(url.pathname);
  return ui ? handleUi(platform, host, site, ui.capabilityId, ui.path, req) : handleWeb(platform, host, site, req);
}

async function route(platform: Platform, sessions: McpSessions, host: SurfaceHost, req: Request, url: URL, isPublic: boolean, site?: Site): Promise<Response> {
  const origin = originOf(req, isPublic);
  if (OAUTH_PATHS.has(url.pathname)) return handleOAuth(platform, req, origin, { webUrl: (site ?? localSite(host.port)).web, log: host.log });
  if (url.pathname !== "/mcp") return json(404, { error: "not_found" });
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  const agent = platform.agentStore.authenticate(token);
  if (!agent) return challenge(origin);
  return sessions.handle(req, agent);
}
