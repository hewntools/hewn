// SPDX-License-Identifier: AGPL-3.0-or-later
// The public path: what a reverse proxy or a tunnel (cloudflared, Tailscale Funnel) reaches. MCP
// and the OAuth endpoints answer on any host; the web client and capability UIs only on the
// public URL's hosts (the surface decides, see index.ts). Admin never answers here. Requests are
// rate limited per client address (and in total).
import { OAUTH_PATHS } from "./oauth.ts";

/** Header the public listener sets on everything it forwards (local requests never need it). */
export const PUBLIC_HEADER = "x-hewn-public";
export const CLIENT_IP_HEADER = "x-hewn-client-ip";
/**
 * Header a trusted proxy in front of the public listener sends (HEWN_PROXY_SECRET). Removed from
 * every request here, whether or not a secret is set, so it never reaches the surface or logs.
 */
export const PROXY_SECRET_HEADER = "x-hewn-proxy-secret";

export const PUBLIC_PATHS = new Set(["/mcp", ...OAUTH_PATHS]);

interface Rule {
  /** Requests allowed per window, per client address. */
  perClient: number;
  /** Requests allowed per window from everyone together. */
  total: number;
  windowMs: number;
}

const MIN = 60_000;
export const RULES: Record<string, Rule> = {
  register: { perClient: 10, total: 60, windowMs: 60 * MIN },
  authorize: { perClient: 20, total: 100, windowMs: 10 * MIN },
  poll: { perClient: 120, total: 600, windowMs: MIN },
  token: { perClient: 60, total: 300, windowMs: MIN },
  metadata: { perClient: 60, total: 600, windowMs: MIN },
  mcp: { perClient: 600, total: 2000, windowMs: MIN },
  /** Sign-in links and passkey sign-in: nobody needs many. */
  signin: { perClient: 30, total: 120, windowMs: 10 * MIN },
  /** The web client and capability UIs on the public URL. */
  web: { perClient: 1200, total: 3000, windowMs: MIN },
};

const ruleFor = (path: string) =>
  path === "/register" ? "register" : path === "/authorize" ? "authorize" : path === "/authorize/poll" ? "poll" : path === "/token" || path === "/revoke" ? "token" : path === "/mcp" ? "mcp"
  : path === "/auth" || path.startsWith("/passkey/") ? "signin" : PUBLIC_PATHS.has(path) ? "metadata" : "web";

/** Fixed-window counters, in memory (one process serves the public path). */
export class RateLimiter {
  private counts = new Map<string, { start: number; n: number }>();
  private rules: Record<string, Rule>;
  constructor(rules = RULES) {
    this.rules = rules;
  }

  /** Seconds to wait, or 0 if the request may go ahead (and is counted). */
  take(rule: string, client: string, now = Date.now()): number {
    const r = this.rules[rule];
    if (this.counts.size > 50_000) this.counts.clear();
    for (const [key, limit] of [[`${rule}|${client}`, r.perClient], [`${rule}|*`, r.total]] as const) {
      const c = this.counts.get(key);
      if (c && now - c.start < r.windowMs && c.n >= limit) return Math.ceil((c.start + r.windowMs - now) / 1000);
    }
    for (const key of [`${rule}|${client}`, `${rule}|*`]) {
      const c = this.counts.get(key);
      if (!c || now - c.start >= r.windowMs) this.counts.set(key, { start: now, n: 1 });
      else c.n++;
    }
    return 0;
  }
}

/**
 * The client's address: the last X-Forwarded-For hop, the one the proxy in front of Hewn added
 * (Caddy, nginx's proxy_add_x_forwarded_for, Cloudflare in front of cloudflared). Earlier hops and
 * CF-Connecting-IP are whatever the client sent when Hewn isn't behind Cloudflare.
 */
export function clientAddress(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",").pop()?.trim() || "unknown";
}

/** Constant-time string comparison (only the secret's length shows in timing). */
function sameSecret(given: string, secret: string): boolean {
  let diff = given.length ^ secret.length;
  for (let i = 0; i < secret.length; i++) diff |= (given.charCodeAt(i) | 0) ^ secret.charCodeAt(i);
  return diff === 0;
}

/**
 * Gate a request that came in over the public listener. Returns a refusal, or the request to
 * forward (marked public, with the client address).
 *
 * With a proxy secret (HEWN_PROXY_SECRET, for a host whose public listener is reachable directly
 * as well as through its proxy), only requests carrying it in x-hewn-proxy-secret get through;
 * the rest get 403 before their X-Forwarded-For or X-Forwarded-Host is looked at.
 */
export function gatePublic(req: Request, limiter: RateLimiter, log: (line: string) => void, proxySecret?: string): Response | Request {
  const url = new URL(req.url);
  if (proxySecret && !sameSecret(req.headers.get(PROXY_SECRET_HEADER) ?? "", proxySecret)) {
    log(`[public] ? ${req.method} ${url.pathname} -> 403 (not from the trusted proxy)`);
    return new Response(JSON.stringify({ error: "forbidden", message: "not from the trusted proxy" }), { status: 403, headers: { "content-type": "application/json" } });
  }
  const ip = clientAddress(req);
  if (url.pathname.startsWith("/_admin/")) {
    log(`[public] ${ip} ${req.method} ${url.pathname} -> 404 (not exposed)`);
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
  }
  const wait = limiter.take(ruleFor(url.pathname), ip);
  if (wait) {
    log(`[public] ${ip} ${req.method} ${url.pathname} -> 429 (retry in ${wait}s)`);
    return new Response(JSON.stringify({ error: "rate_limited", message: `Too many requests; retry in ${wait}s` }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(wait) },
    });
  }
  const headers = new Headers(req.headers);
  headers.delete(PROXY_SECRET_HEADER);
  headers.set(PUBLIC_HEADER, "1");
  headers.set(CLIENT_IP_HEADER, ip);
  return new Request(req, { headers });
}
