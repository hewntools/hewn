// SPDX-License-Identifier: AGPL-3.0-or-later
// Capability UIs, served under the web client's host at /tools/<id>/ (site.ts). Every response there
// carries a CSP `sandbox` without allow-same-origin, so the browser gives each UI page an opaque
// origin of its own, framed or opened as a page: it can't read the web client, its cookies or
// storage, or another UI's. The UI is just another client: it calls the same public operations
// as agents, as `ui:<id>` with authority limited to its capability, with a bearer token (never a
// cookie), and cross-origin (its requests say `Origin: null`).
import { text } from "@hewntools/core/files.ts";
import { sameDigest } from "@hewntools/core/sha256.ts";
import type { Platform } from "@hewntools/core/platform.ts";
import type { SurfaceHost } from "./host.ts";
import { body, errorBody, json, readJson, typeOf } from "./http.ts";
import type { Site } from "./site.ts";

/** What a UI page may do: run its scripts and forms, open links and downloads. Never allow-same-origin. */
export const UI_SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals";

/**
 * The UI may load and call only its own files and API and the design system, and may be framed
 * only by the owner's web client. `web` is the site's origin. This keeps a UI's fetches home; it
 * doesn't stop a deliberately hostile page from leaving with data by navigating or opening a
 * popup (links are allowed), which is outside a capability's network grants (threat-model.md).
 */
export const uiCsp = (web: string, capabilityId: string) => {
  const own = `${web}/tools/${capabilityId}/`;
  const files = `${own} ${web}/_platform/`;
  return `sandbox ${UI_SANDBOX}; default-src 'none'; script-src ${files} 'unsafe-inline'; style-src ${files} 'unsafe-inline'; img-src ${files} data: blob:; font-src ${files}; media-src ${own} blob:; connect-src ${own}; frame-ancestors ${web}; form-action ${own}; base-uri 'none'`;
};

/** Whether a request's Origin is the web client's (exact on the public URL, any port locally). */
export function sameOrigin(site: Site, origin: string): boolean {
  if (site.kind === "public") return origin === site.web;
  try {
    return site.isWeb(new URL(origin).host);
  } catch {
    return false;
  }
}

const SHIM = '<script src="/_platform/session.js"></script>';
/** Inject the session shim before any capability script runs. */
export const withShim = (html: string) => (/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + SHIM) : SHIM + html);

/**
 * Set the session cookie, then continue to "/" via a same-origin meta refresh rather than a 302:
 * when the sign-in link is opened from another origin (the web client), browsers withhold
 * SameSite=Strict cookies on the rest of that redirect chain.
 */
export const signedIn = (setCookie: string | string[], to = "/") => {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'", "cache-control": "no-store" });
  for (const c of [setCookie].flat()) headers.append("set-cookie", c);
  return new Response(`<!doctype html><meta http-equiv="refresh" content="0;url=${to}"><title>Signing in…</title>`, { status: 200, headers });
};

const PLATFORM_ASSETS = new Set(["ui.css", "chart.js", "widgets.js", "ascii.js", "session.js"]);

/** The shared design system, served at /_platform/* (public, no session). */
export async function platformAsset(host: SurfaceHost, path: string): Promise<Response | undefined> {
  const name = /^\/_platform\/([a-z.]+)$/.exec(path)?.[1];
  if (!name || !PLATFORM_ASSETS.has(name)) return undefined;
  const data = await host.asset(`platform-ui/${name}`);
  if (!data) return undefined;
  // Any origin may load them: capability UIs (opaque origins) import the modules with CORS.
  return new Response(body(data), { status: 200, headers: { "content-type": typeOf(name), "x-content-type-options": "nosniff", "cache-control": "no-cache", "access-control-allow-origin": "*" } });
}

/** UI session token, attached by /_platform/session.js as `Authorization: Hewn <token>`. */
const sessionToken = (req: Request) => /^Hewn\s+(\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];

// The UI's own requests come from its opaque origin: cross-origin, `Origin: null`. Code and the
// design system are public; the API answers that origin only (with the token, never a cookie).
const CORS_FILES = { "access-control-allow-origin": "*" };
const CORS_API = { "access-control-allow-origin": "null", vary: "origin" };

/**
 * `path` is inside `/tools/<id>`: `/auth?ticket=…` (the way in), else `/~<key>/…` (`/`, `/app.js`,
 * `/api/invoke`, …). Without the capability's UI key every path answers 404, as for a capability
 * that doesn't exist: which tools exist, and their code, stay the owner's.
 */
export async function handleUi(platform: Platform, host: SurfaceHost, site: Site, capabilityId: string, path: string, req: Request): Promise<Response> {
  const csp = uiCsp(site.web, capabilityId);
  // no-referrer: the address holds the UI key.
  const headers = (extra: Record<string, string> = {}) => ({ "content-security-policy": csp, "x-content-type-options": "nosniff", "cache-control": "no-store", "referrer-policy": "no-referrer", ...extra });
  const send = (status: number, body: unknown, extra: Record<string, string> = {}) => json(status, body, headers(extra));
  const url = new URL(req.url);
  const key = platform.uiKey(capabilityId);
  const base = `${site.ui(capabilityId)}/~${key}/`;

  // Ticket (from `hewn open` or the web client) → session token, handed to the page in the
  // URL fragment and kept per tab by the session shim.
  if (path === "/auth") {
    const session = platform.redeemUiTicket(url.searchParams.get("ticket") ?? "", capabilityId);
    if (!session || !key) return send(401, { error: "invalid or expired ticket; open it again from Hewn" });
    const section = /^[A-Za-z0-9_-]{1,40}$/.exec(url.searchParams.get("section") ?? "")?.[0];
    // The web client's light or dark (the system's when it has none), for session.js to put on
    // the page before any style loads.
    const theme = /^(?:light|dark)$/.exec(url.searchParams.get("theme") ?? "")?.[0];
    return new Response(`<!doctype html><meta http-equiv="refresh" content="0;url=${base}#hewn_session=${session}${section ? `&section=${section}` : ""}${theme ? `&theme=${theme}` : ""}"><title>Opening…</title>`, {
      status: 200,
      headers: headers({ "content-type": "text/html; charset=utf-8" }),
    });
  }

  const keyed = /^\/~([A-Za-z0-9_-]+)(\/.*)?$/.exec(path);
  if (!key || !keyed || !sameDigest(keyed[1], key)) return send(404, { error: "not found" });
  if (keyed[2] === undefined) return new Response(null, { status: 302, headers: headers({ location: base }) });
  path = keyed[2];

  if (path.startsWith("/api/")) {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: headers({ ...CORS_API, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "authorization, content-type, x-hewn-ui", "access-control-max-age": "600" }) });
    }
    const api = (status: number, body: unknown) => send(status, body, CORS_API);
    const agent = platform.uiAgent(sessionToken(req), capabilityId);
    if (!agent) return api(401, { error: "not signed in; open this app from Hewn" });
    // A custom header forces a CORS preflight; only the UI's own (opaque) origin passes it.
    const origin = req.headers.get("origin");
    if (req.headers.get("x-hewn-ui") !== "1" || (origin !== null && origin !== "null")) return api(403, { error: "cross-origin or missing X-Hewn-UI header" });
    try {
      if (path === "/api/manifest") return api(200, platform.get(agent, capabilityId));
      if (path !== "/api/invoke") return api(404, { error: "not found" });
      if (req.method !== "POST") return api(405, { error: "POST only" });
      const body = await readJson(req);
      host.log(`${agent.id} (user) invoke ${body.operation} ${JSON.stringify(body.input ?? {})}`);
      const out = await platform.invoke(agent, { capabilityId, operation: body.operation, operationVersion: body.operationVersion, input: body.input });
      return api(200, out);
    } catch (e) {
      return api((e as { code?: string }).code === "not_ready" ? 409 : 400, errorBody(e));
    }
  }

  // Static UI files need only the UI key (module scripts from the opaque origin carry no cookie or
  // token); all data goes through the authenticated API.
  let file: string;
  try {
    file = decodeURIComponent(path);
  } catch {
    return send(404, { error: "not found" });
  }
  const found = await platform.uiFile(capabilityId, file);
  if (!found) return send(404, { error: "not found" });
  const type = typeOf(found.path);
  return new Response(body(type.startsWith("text/html") ? withShim(text(found.data)) : found.data), { status: 200, headers: headers({ "content-type": type, ...CORS_FILES }) });
}
