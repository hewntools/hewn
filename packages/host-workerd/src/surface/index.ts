// SPDX-License-Identifier: AGPL-3.0-or-later
// Hewn's whole HTTP surface as one web-standard handler: the owner's web client
// (hewn.localhost), capability UIs under it (/tools/<id>/), MCP at /mcp and the OAuth endpoints agents
// connect with, and share links (/share/<token>). Runs on Node and on workerd. Requests marked
// public came through the public listener (a reverse proxy or a tunnel, see public.ts): on the
// public URL's host they reach the web client and capability UIs too (site.ts); on any other host
// only MCP, OAuth, the Agent Skill, a pack's download link, share links and robots.txt.
import { PlatformError } from "@hewntools/core/errors.ts";
import type { Platform } from "@hewntools/core/platform.ts";
import { PACK_PATH } from "@hewntools/core/platform/submissions.ts";
import type { SurfaceHost } from "./host.ts";
import { body, json } from "./http.ts";
import type { McpSessions } from "./mcp-sessions.ts";
import { challenge, handleOAuth, OAUTH_PATHS, originOf } from "./oauth.ts";
import { CLIENT_IP_HEADER, loggedPath, PUBLIC_HEADER, PUBLIC_PATHS, RateLimiter, ROBOTS_TXT, SHARE_PREFIX, SHARE_ROBOTS } from "./public.ts";
import { localSite, publicSite, requestHost, type Site, uiPath } from "./site.ts";
import { handleUi } from "./ui.ts";
import { handleWeb, PUBLIC_FILES, skillResponse } from "./web.ts";
import { SKILL_URL } from "@hewntools/core/skill.ts";

export type { SurfaceHost } from "./host.ts";
export { McpSessions } from "./mcp-sessions.ts";

export async function handle(platform: Platform, sessions: McpSessions, host: SurfaceHost, req: Request): Promise<Response> {
  const url = new URL(req.url);
  // The host's /health and a page's own refreshes (Home's widgets, a poll) leave the idle report alone.
  if (url.pathname === "/health" || req.headers.get(REFRESH_HEADER) === "1") return answer(platform, sessions, host, req);
  const activity = platform.activity;
  const intake = host.intake;
  const res = await answer(platform, sessions, intake ? { ...host, intake: (r, onProgress, signal) => intake(r, onProgress, signal).finally(activity.intake()) } : host, req);
  return counted(activity, req, url, res);
}

/** A page's own refresh (Home's widgets, a poll): the web client marks it, and the idle report ignores it. What a page can't mark (an EventSource, an <img>) is PAGE_OWN_FETCHES. */
export const REFRESH_HEADER = "x-hewn-refresh";

/** A build's events, and a tool's or a build's icon: fetched by an open page on its own (see counted()). */
const PAGE_OWN_FETCHES = /^\/api\/(builds\/[^/]+\/events|(capabilities|builds)\/[^/]+\/icon)$/;

/**
 * The idle report (core platform/activity.ts) counts the owner and their agents: a request once answered, unless it
 * was refused (anyone not signed in gets a 401 or a 404) or is one anyone may make (the files the sign-in page loads,
 * the Agent Skill, the OAuth endpoints and their metadata, robots.txt: what a scanner on a public address reaches); a
 * stream each time it writes; and a change made in the web client (any request that isn't a GET) as one a backup should
 * keep. A tool call counts itself. A share link's download counts: someone was given the link. What an open page
 * fetches on its own doesn't count: a build's events (a browser reconnects them, and each replays the log; the build
 * counts itself) and a tool's icon (redrawn as the page ticks).
 */
function counted(activity: Platform["activity"], req: Request, url: URL, res: Response): Response {
  if (res.status >= 400 || OAUTH_PATHS.has(url.pathname) || url.pathname.startsWith("/.well-known/") || url.pathname === SKILL_URL || url.pathname === "/robots.txt" || PUBLIC_FILES.has(url.pathname.slice(1))) return res;
  if (req.method === "GET" && PAGE_OWN_FETCHES.test(url.pathname)) return res;
  activity.request();
  if (url.pathname.startsWith("/api/") && req.method !== "GET" && req.method !== "HEAD") activity.changed();
  if (!res.body || !/^(text\/event-stream|application\/x-ndjson)/.test(res.headers.get("content-type") ?? "")) return res;
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      const { value, done } = await reader.read();
      if (done) return void c.close();
      activity.streamWrote();
      c.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, res);
}

async function answer(platform: Platform, sessions: McpSessions, host: SurfaceHost, req: Request): Promise<Response> {
  const isPublic = req.headers.get(PUBLIC_HEADER) === "1";
  const url = new URL(req.url);
  try {
    if (isPublic) {
      const publicUrl = platform.publicUrl();
      const site = publicUrl ? publicSite(publicUrl) : undefined;
      const web = !!site?.isWeb(requestHost(req));
      let res: Response;
      if (url.pathname.startsWith(SHARE_PREFIX)) res = await shareLink(platform, host, req, url, true);
      else if (url.pathname === "/robots.txt") res = new Response(ROBOTS_TXT, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
      else if (PUBLIC_PATHS.has(url.pathname) || url.pathname.startsWith(PACK_PATH)) res = await route(platform, sessions, host, req, url, true, site);
      else if (site && web) res = await browser(platform, host, site, req, url);
      else res = json(404, { error: "not_found" });
      // The browser's own traffic stays out of the log unless it fails; agents and sign-in are always logged.
      if (!web || res.status >= 400 || req.method !== "GET") host.log(`[public] ${req.headers.get(CLIENT_IP_HEADER) ?? "?"} ${req.method} ${requestHost(req)}${loggedPath(url.pathname)} -> ${res.status}`);
      return res;
    }
    // DNS rebinding: a web page whose own name resolves to 127.0.0.1 reaches this port with its own
    // Host (and, for MCP, its own Origin). Only loopback names answer locally.
    if (!isLoopbackName(hostName(req.headers.get("host")))) return json(421, { error: "misdirected_request", message: "this port answers only on 127.0.0.1, localhost and hewn.localhost" });
    if (url.pathname.startsWith(SHARE_PREFIX)) return await shareLink(platform, host, req, url, false);
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

/**
 * Where a link given to an agent (a pack's download) points: the local address it reached (its host
 * is a loopback name, checked above), or on the public listener the public URL when there is one,
 * else the host the request was forwarded for, if that is a host name (and a port). Undefined: the
 * agent gets the link's path only.
 */
export function linkOrigin(origin: string, isPublic: boolean, publicUrl: string | undefined): string | undefined {
  if (!isPublic) return origin;
  if (publicUrl) return publicUrl;
  const host = origin.replace(/^https:\/\//, "");
  return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/i.test(host) && !host.includes("..") ? origin : undefined;
}

/**
 * A pack's download link (capabilities_pack's `download`): the token is the key, minted for one
 * agent's pack inside its authenticated call, good once and for minutes. Anything else is a 404,
 * the same whether the token never was, was used, ran out or its agent lost the pack.
 */
async function packDownload(platform: Platform, req: Request, token: string): Promise<Response> {
  const zip = req.method === "GET" && /^[A-Za-z0-9_-]{43}$/.test(token) ? await platform.packDownload(token) : undefined;
  if (!zip) return json(404, { error: "not_found" });
  return new Response(body(zip), { headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="hewn-pack.zip"', "cache-control": "no-store", "referrer-policy": "no-referrer" } });
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

/**
 * A share link: the bundle of the version it was made for, to anyone with the link, until it
 * expires or is revoked. Every answer, a refusal too, tells search engines to keep out.
 */
/** Share links' per-link limit (public.ts RULES.shareLink), counted once a link is known to work. */
const linkLimiter = new RateLimiter();

async function shareLink(platform: Platform, host: SurfaceHost, req: Request, url: URL, isPublic: boolean): Promise<Response> {
  const headers = { ...SHARE_ROBOTS, "cache-control": "no-store", "referrer-policy": "no-referrer" };
  if (req.method !== "GET") return json(405, { error: "method_not_allowed" }, { ...headers, allow: "GET" });
  const token = url.pathname.slice(SHARE_PREFIX.length);
  // A revoked or expired link says so at once, however often it was fetched.
  if (!platform.shareLinkWorks(token)) return json(404, { error: "not_found" }, headers);
  const wait = isPublic ? linkLimiter.take("shareLink", url.pathname) : 0;
  if (wait) return json(429, { error: "rate_limited", message: `Too many requests; retry in ${wait}s` }, { ...headers, "retry-after": String(wait) });
  try {
    const { name, bundle } = await platform.sharedBundle(token);
    return new Response(body(bundle), { status: 200, headers: { ...headers, "content-type": "application/zip", "content-disposition": `attachment; filename="${name}"`, "x-content-type-options": "nosniff" } });
  } catch (e) {
    if (e instanceof PlatformError && e.code === "not_found") return json(404, { error: "not_found" }, headers);
    host.log(`share link error: ${(e as Error).stack ?? e}`);
    return json(500, { error: "internal" }, headers);
  }
}

/** A browser on a site: a capability UI under /tools/<id>/, else the web client. */
function browser(platform: Platform, host: SurfaceHost, site: Site, req: Request, url: URL): Promise<Response> {
  const ui = uiPath(url.pathname);
  return ui ? handleUi(platform, host, site, ui.capabilityId, ui.path, req) : handleWeb(platform, host, site, req);
}

async function route(platform: Platform, sessions: McpSessions, host: SurfaceHost, req: Request, url: URL, isPublic: boolean, site?: Site): Promise<Response> {
  const origin = originOf(req, isPublic);
  // Where an agent reaches MCP, it finds the Skill too.
  if (url.pathname === SKILL_URL) return req.method === "GET" ? skillResponse(platform) : json(405, { error: "method_not_allowed" });
  if (OAUTH_PATHS.has(url.pathname)) return handleOAuth(platform, req, origin, { webUrl: (site ?? localSite(host.port)).web, hosted: !!host.hosted, log: host.log });
  if (url.pathname.startsWith(PACK_PATH)) return packDownload(platform, req, url.pathname.slice(PACK_PATH.length));
  if (url.pathname !== "/mcp") return json(404, { error: "not_found" });
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  const agent = platform.agentStore.authenticate(token);
  if (!agent) return challenge(origin);
  return sessions.handle(req, agent, linkOrigin(origin.url, isPublic, platform.publicUrl()));
}
