// SPDX-License-Identifier: AGPL-3.0-or-later
// Hewn as an OAuth 2.1 authorization server for MCP clients (MCP authorization spec):
// protected-resource and authorization-server metadata, dynamic client registration, an
// authorize page that waits for the owner's approval in Hewn, and the token endpoint.
// Same endpoints locally (127.0.0.1) and through a tunnel; the issuer is whichever origin
// the client used.
import { OAuthError } from "@hewntools/core/agents.ts";
import { SCOPES } from "@hewntools/core/auth.ts";
import type { Platform } from "@hewntools/core/platform.ts";
import { randomToken } from "@hewntools/core/sha256.ts";
import { esc, json } from "./http.ts";

export const OAUTH_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/register",
  "/authorize",
  "/authorize/poll",
  "/token",
  "/revoke",
]);

export interface Origin {
  /** e.g. http://127.0.0.1:7717 or https://hewn.example.com */
  url: string;
  via: "local" | "tunnel";
}

/** The origin the client used: tunnels terminate TLS, so public requests are https. */
export function originOf(req: Request, isPublic: boolean): Origin {
  if (!isPublic) return { url: new URL(req.url).origin, via: "local" };
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host).split(",")[0].trim();
  return { url: `https://${host}`, via: "tunnel" };
}

/** The 401 an unauthenticated MCP request gets: where to find the authorization server. */
export function challenge(origin: Origin): Response {
  return json(401, { error: "unauthenticated", message: "Connect to Hewn with OAuth: the owner approves the agent in Hewn" }, {
    "www-authenticate": `Bearer resource_metadata="${origin.url}/.well-known/oauth-protected-resource/mcp", scope="discover invoke create modify"`,
  });
}

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version", "access-control-allow-methods": "GET, POST, OPTIONS" };
const noStore = { "cache-control": "no-store", pragma: "no-cache" };
const oauthError = (e: OAuthError) => json(e.status, { error: e.code, error_description: e.message }, { ...cors, ...noStore });

/** Form or JSON body (the token and revocation endpoints take forms; registration takes JSON). */
async function params(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  const raw = await req.text();
  if (type.includes("application/json")) return raw ? JSON.parse(raw) : {};
  return Object.fromEntries(new URLSearchParams(raw));
}

/** client_secret_basic credentials, if any. */
function basicAuth(req: Request): { id?: string; secret?: string } {
  const m = /^Basic\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!m) return {};
  const [id, secret] = atob(m[1]).split(":");
  return { id: decodeURIComponent(id ?? ""), secret: decodeURIComponent(secret ?? "") };
}

export function metadata(origin: Origin) {
  return {
    issuer: origin.url,
    authorization_endpoint: `${origin.url}/authorize`,
    token_endpoint: `${origin.url}/token`,
    registration_endpoint: `${origin.url}/register`,
    revocation_endpoint: `${origin.url}/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    scopes_supported: [...SCOPES],
    authorization_response_iss_parameter_supported: true,
    service_documentation: "https://hewn.tools",
  };
}

export async function handleOAuth(platform: Platform, req: Request, origin: Origin, opts: { webUrl?: string; hosted?: boolean; log: (line: string) => void }): Promise<Response> {
  const url = new URL(req.url);
  const store = platform.agentStore;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  try {
    switch (url.pathname) {
      case "/.well-known/oauth-protected-resource":
      case "/.well-known/oauth-protected-resource/mcp":
        return json(200, { resource: `${origin.url}/mcp`, authorization_servers: [origin.url], scopes_supported: [...SCOPES], bearer_methods_supported: ["header"], resource_name: "Hewn" }, cors);
      case "/.well-known/oauth-authorization-server":
      case "/.well-known/openid-configuration":
        return json(200, metadata(origin), cors);
      case "/register": {
        if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "POST" });
        const out = store.register(await params(req));
        opts.log(`oauth: registered client "${out.client_name}" (${origin.via})`);
        return json(201, out, { ...cors, ...noStore });
      }
      case "/authorize": {
        const p = Object.fromEntries(url.searchParams);
        try {
          const r = store.startAuthorization(p, { via: origin.via, issuer: origin.url });
          opts.log(`oauth: "${r.clientName}" asks to connect (${origin.via}, code ${r.userCode})`);
          return authorizePage(r, origin, opts.webUrl, opts.hosted);
        } catch (e) {
          if (e instanceof OAuthError && (e as OAuthError & { redirectTo?: string }).redirectTo) {
            return new Response(null, { status: 302, headers: { location: (e as OAuthError & { redirectTo: string }).redirectTo } });
          }
          if (e instanceof OAuthError) return errorPage(e.message);
          throw e;
        }
      }
      case "/authorize/poll": {
        if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "POST" });
        const b = await params(req);
        return json(200, store.poll(String(b.id ?? ""), String(b.secret ?? "")), noStore);
      }
      case "/token": {
        if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "POST" });
        const b = await params(req);
        const basic = basicAuth(req);
        const client = { client_id: basic.id ?? b.client_id, client_secret: basic.secret ?? b.client_secret };
        const tokens =
          b.grant_type === "authorization_code"
            ? store.exchangeCode({ ...b, ...client })
            : b.grant_type === "refresh_token"
              ? store.refresh({ ...b, ...client })
              : (() => {
                  throw new OAuthError("unsupported_grant_type", `unsupported grant_type ${b.grant_type ?? ""}`);
                })();
        return json(200, tokens, { ...cors, ...noStore });
      }
      case "/revoke": {
        if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, { allow: "POST" });
        store.revokeToken((await params(req)).token);
        return new Response(null, { status: 200, headers: cors });
      }
    }
    return json(404, { error: "not_found" });
  } catch (e) {
    if (e instanceof OAuthError) return oauthError(e);
    if (e instanceof SyntaxError) return oauthError(new OAuthError("invalid_request", "malformed request body"));
    throw e;
  }
}


function page(title: string, body: string, nonce?: string, script = ""): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="color-scheme" content="light dark">
<style>
body{font:16px/1.5 system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{max-width:26rem;padding:2rem 1.5rem}
h1{font-size:1.35rem;margin:0 0 .75rem}
.code{font:600 1.6rem/1 ui-monospace,monospace;letter-spacing:.12em;padding:.6rem 1rem;border:1px solid color-mix(in srgb,CanvasText 20%,transparent);border-radius:.6rem;display:inline-block;margin:.5rem 0 1rem}
.muted{opacity:.7;font-size:.9rem}
a.button{display:inline-block;padding:.55rem 1rem;border-radius:.5rem;background:#5b5bd6;color:#fff;text-decoration:none;margin:.25rem 0 1rem}
code{font-family:ui-monospace,monospace}
</style></head><body><main>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
  const csp = `default-src 'none'; style-src 'unsafe-inline'; ${nonce ? `script-src 'nonce-${nonce}'; ` : ""}connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp, "x-frame-options": "DENY", "referrer-policy": "no-referrer", ...noStore } });
}

function errorPage(message: string): Response {
  const r = page("Can't connect to Hewn", `<h1>Can't connect to Hewn</h1><p>${esc(message)}</p><p class="muted">Try connecting again from the agent.</p>`);
  return new Response(r.body, { status: 400, headers: r.headers });
}

/**
 * "Approve in your Hewn": shows the agent and a code to match against the approval card, and
 * waits. When the owner decides, the page sends the browser back to the agent.
 */
function authorizePage(r: { id: string; secret: string; userCode: string; clientName: string; redirectHost: string }, origin: Origin, webUrl?: string, hosted = false): Response {
  const nonce = randomToken(12);
  // Hosted: the owner has no terminal, and Hewn's web address is where they are anyway.
  const where =
    (origin.via === "local" || hosted) && webUrl
      ? `<a class="button" href="${esc(webUrl)}/approve?code=${encodeURIComponent(r.userCode)}" target="_blank" rel="noopener">Open Hewn to approve</a>`
      : `<p>Open Hewn on your computer (<b>Agents</b>), or run <code>hewn agents approve ${esc(r.userCode)}</code>.</p>`;
  const body = `<h1>Approve ${esc(r.clientName)} in your Hewn</h1>
<p><b>${esc(r.clientName)}</b> wants to connect to your Hewn. It returns to <b>${esc(r.redirectHost)}</b>.</p>
<p class="muted">Check that Hewn shows the same code:</p><div class="code">${esc(r.userCode)}</div>
${where}
<p class="muted" id="status" role="status">Waiting for your approval…</p>`;
  const script = `const s=document.getElementById("status");const body=new URLSearchParams({id:${JSON.stringify(r.id)},secret:${JSON.stringify(r.secret)}});
async function poll(){try{const r=await fetch("/authorize/poll",{method:"POST",body});const j=await r.json();
if(j.redirect){s.textContent=j.status==="approved"?"Approved. Returning to the agent…":"Declined. Returning to the agent…";location.replace(j.redirect);return}
if(j.status==="expired"){s.textContent="This request expired. Connect again from the agent.";return}}catch{}setTimeout(poll,1500)}poll();`;
  return page(`Approve ${r.clientName} in Hewn`, body, nonce, script);
}
