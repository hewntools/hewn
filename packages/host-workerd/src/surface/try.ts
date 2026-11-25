// SPDX-License-Identifier: AGPL-3.0-or-later
// Try it (core platform/trying.ts): a held build's screen at /try/<build>/~<key>/, served as a tool's UI is
// (ui.ts: the same sandbox, an opaque origin, a bearer session, never a cookie), but with the candidate's own files,
// and its calls run on the build's copy of the owner's data. The key and the session last as long as the Try it.
import { text } from "@hewntools/core/files.ts";
import { sameDigest } from "@hewntools/core/sha256.ts";
import type { Platform } from "@hewntools/core/platform.ts";
import type { SurfaceHost } from "./host.ts";
import { body, errorBody, json, readJson, typeOf } from "./http.ts";
import type { Site } from "./site.ts";
import { TRY_SANDBOX, withShim } from "./ui.ts";

/** /try/<build>/…: the build's id and the rest of the path. */
export function tryPath(pathname: string): { buildId: string; path: string } | undefined {
  const m = /^\/try\/(b-[a-z0-9]{1,40})(\/.*)?$/.exec(pathname);
  return m ? { buildId: m[1], path: m[2] ?? "" } : undefined;
}

/** As uiCsp, with the Try it's own path in place of the tool's, and its own sandbox (no popups). */
const tryCsp = (web: string, buildId: string) => {
  const own = `${web}/try/${buildId}/`;
  const files = `${own} ${web}/_platform/`;
  return `sandbox ${TRY_SANDBOX}; default-src 'none'; script-src ${files} 'unsafe-inline'; style-src ${files} 'unsafe-inline'; img-src ${files} data: blob:; font-src ${files}; media-src ${own} blob:; connect-src ${own}; frame-ancestors ${web}; form-action ${own}; base-uri 'none'`;
};

/** A page of Try it's opens only in Hewn's frame (Sec-Fetch-Dest): never as a tab of its own, outside the sandbox attribute. */
const framed = (req: Request) => req.headers.get("sec-fetch-dest") === "iframe";

const sessionToken = (req: Request) => /^Hewn\s+(\S+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
const CORS_FILES = { "access-control-allow-origin": "*" };
const CORS_API = { "access-control-allow-origin": "null", vary: "origin" };

export async function handleTry(platform: Platform, host: SurfaceHost, site: Site, buildId: string, path: string, req: Request): Promise<Response> {
  const headers = (extra: Record<string, string> = {}) => ({ "content-security-policy": tryCsp(site.web, buildId), "x-content-type-options": "nosniff", "cache-control": "no-store", "referrer-policy": "no-referrer", ...extra });
  const send = (status: number, b: unknown, extra: Record<string, string> = {}) => json(status, b, headers(extra));
  const url = new URL(req.url);
  // Ended (decided, or its hour up): every path answers so, as for one that never was.
  const key = await platform.tryKey(buildId);
  const base = `${site.web}/try/${buildId}/~${key}/`;

  if (path === "/auth") {
    if (!framed(req)) return send(403, { error: "Try it opens in Hewn's page only" });
    const session = key ? await platform.redeemTryTicket(url.searchParams.get("ticket") ?? "", buildId) : undefined;
    if (!session) return send(401, { error: "this Try it has ended, or the link was used; open it again from the build" });
    const theme = /^(?:light|dark)$/.exec(url.searchParams.get("theme") ?? "")?.[0];
    return new Response(`<!doctype html><meta http-equiv="refresh" content="0;url=${base}#hewn_session=${session}${theme ? `&theme=${theme}` : ""}"><title>Opening…</title>`, { status: 200, headers: headers({ "content-type": "text/html; charset=utf-8" }) });
  }

  const keyed = /^\/~([A-Za-z0-9_-]+)(\/.*)?$/.exec(path);
  if (!key || !keyed || !sameDigest(keyed[1], key)) return send(404, { error: "not found" });
  if (keyed[2] === undefined) return new Response(null, { status: 302, headers: headers({ location: base }) });
  path = keyed[2];

  if (path.startsWith("/api/")) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: headers({ ...CORS_API, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "authorization, content-type, x-hewn-ui", "access-control-max-age": "600" }) });
    const api = (status: number, b: unknown) => send(status, b, CORS_API);
    if (!(await platform.trySignedIn(sessionToken(req), buildId))) return api(401, { error: "this Try it has ended; open it again from the build" });
    const origin = req.headers.get("origin");
    if (req.headers.get("x-hewn-ui") !== "1" || (origin !== null && origin !== "null")) return api(403, { error: "cross-origin or missing X-Hewn-UI header" });
    try {
      if (path === "/api/manifest") return api(200, { ...(await platform.tryManifest(buildId)), status: { ready: true, missingSecrets: [], missingConfig: [], pendingGrants: [], missingDependencies: [] } });
      if (path !== "/api/invoke") return api(404, { error: "not found" });
      if (req.method !== "POST") return api(405, { error: "POST only" });
      const b = await readJson(req);
      host.log(`try-it ${buildId} invoke ${b.operation}`);
      return api(200, await platform.tryInvoke(buildId, { operation: b.operation, operationVersion: b.operationVersion, input: b.input }));
    } catch (e) {
      return api((e as { code?: string }).code === "not_found" ? 410 : 400, errorBody(e));
    }
  }

  let file: string;
  try {
    file = decodeURIComponent(path);
  } catch {
    return send(404, { error: "not found" });
  }
  const found = await platform.tryFile(buildId, file).catch(() => undefined);
  if (!found) return send(404, { error: "not found" });
  const type = typeOf(found.path);
  if (type.startsWith("text/html") && !framed(req)) return send(403, { error: "Try it opens in Hewn's page only" });
  return new Response(body(type.startsWith("text/html") ? withShim(text(found.data)) : found.data), { status: 200, headers: headers({ "content-type": type, ...CORS_FILES }) });
}
