// SPDX-License-Identifier: AGPL-3.0-or-later
// Agents are OAuth clients the owner approved. An MCP client registers itself (dynamic client
// registration), sends the owner's browser to /authorize, and waits; the owner sees a pending
// request in the web client (or `hewn agents pending`) and approves it, possibly narrowing what it
// asked for. Only token hashes are stored. Revoking an agent deletes its tokens: the next call fails.
import { type Agent, type AgentInfo, type Scope, SCOPES, validScopes } from "./auth.ts";
import { PlatformError } from "./errors.ts";
import type { Sql } from "./ports.ts";
import { randomToken, sha256 } from "./sha256.ts";

/** What an agent asks for when it doesn't say. */
export const AGENT_SCOPES: Scope[] = [...SCOPES];

const ACCESS_TTL = 60 * 60 * 1000;
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000;
const REQUEST_TTL = 15 * 60 * 1000;
const CODE_TTL = 5 * 60 * 1000;
/** Waiting requests per way in: requests through the tunnel can't fill the queue local agents use. */
const MAX_PENDING = { local: 20, tunnel: 10 } as const;
const MAX_CLIENTS = 200;

/** OAuth protocol errors (RFC 6749 §5.2 codes), answered as `{error, error_description}`. */
export class OAuthError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface ClientInfo {
  clientId: string;
  name: string;
  redirectUris: string[];
  public: boolean;
}

export interface PendingRequest {
  id: string;
  clientName: string;
  /** Where the agent's tokens go: the part the owner can actually trust (names are self-asserted). */
  redirectHost: string;
  requested: Scope[];
  /** Pre-checked at approval: what it asked for, or on a reconnect only what the agent has now. */
  suggested: Scope[];
  /** On a reconnect: what the agent may do now (the owner may have narrowed it since it first connected). */
  current: { scopes: Scope[]; capabilities: "*" | string[] } | null;
  userCode: string;
  via: "local" | "tunnel";
  /** The host it is connecting through (hewn.example.com, a tunnel's, 127.0.0.1:7717). */
  address: string | null;
  createdAt: string;
  /**
   * An existing agent this would reconnect: the same client, or the same name on this machine (one
   * Claude Code per machine). Otherwise the suggested name gets a number, so a second laptop's
   * Claude Code never silently replaces the first.
   */
  reconnects: string | null;
  /** "Claude Code", or "Claude Code (2)" when another Claude Code is connected (its id: claude-code-2). */
  suggestedName: string;
}

export interface AgentDetails extends AgentInfo {
  name: string;
  /** What the agent asked for when approved: scopes can be narrowed and restored up to this. */
  maxScopes: Scope[];
  clientName: string;
  via: "local" | "tunnel" | "test";
  /** The host it connected through (127.0.0.1:7717, hewn.example.com, a tunnel's), from its approval. */
  address: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Tokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const now = () => Date.now();
const iso = (t: number) => new Date(t).toISOString();
const json = <T>(s: string): T => JSON.parse(s) as T;

/** BASE64URL(SHA256(verifier)), the PKCE S256 challenge. */
export function pkceChallenge(verifier: string): string {
  const hex = sha256(verifier);
  let s = "";
  for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The name a client registers with, minus decorations: "Claude Code (hewn)" → "Claude Code". */
export const agentName = (clientName: string) => clientName.replace(/\s*\([^)]*\)\s*$/, "").trim() || clientName;

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/** "Claude Code" → "claude-code". */
export const slug = (name: string) =>
  name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";

/** Redirect URIs an agent may use: https, or http on this machine (local agents' callbacks). */
export function allowedRedirect(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
}

/** Loopback redirects match on everything but the port (RFC 8252 §7.3: the client picks a free one). */
function sameRedirect(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  const a = new URL(registered);
  const b = new URL(presented);
  return a.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

/** Short code shown on the authorize page and the approval card, so the owner can match them. */
function userCode(): string {
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(6));
  const c = [...b].map((x) => alphabet[x % alphabet.length]).join("");
  return `${c.slice(0, 3)}-${c.slice(3)}`;
}

export class AgentStore {
  private sql: Sql;
  /** Last `last_used_at` write per agent (written at most once a minute). */
  private touched = new Map<string, number>();
  /** Called when agents or their scopes change (open MCP sessions refresh their tool lists). */
  onChange: (agentId: string) => void = () => {};

  constructor(sql: Sql) {
    this.sql = sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL,
        secret_hash TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_requests (
        id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
        state TEXT, code_challenge TEXT NOT NULL, scopes TEXT NOT NULL, resource TEXT, user_code TEXT NOT NULL,
        via TEXT NOT NULL, status TEXT NOT NULL, agent_id TEXT, code_hash TEXT, issuer TEXT NOT NULL,
        created_at TEXT NOT NULL, decided_at TEXT);
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, client_id TEXT, scopes TEXT NOT NULL, max_scopes TEXT NOT NULL,
        capabilities TEXT NOT NULL, via TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT, address TEXT);
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        hash TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, client_id TEXT, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS oauth_tokens_agent ON oauth_tokens (agent_id);`);
  }

  // ---------- resource server ----------

  authenticate(token: string | undefined): Agent | undefined {
    if (!token) return undefined;
    const t = this.sql.prepare("SELECT agent_id, expires_at FROM oauth_tokens WHERE hash = ? AND kind = 'access'").get(sha256(token));
    if (!t || t.expires_at <= now()) return undefined;
    const agent = this.get(t.agent_id);
    if (!agent) return undefined;
    const last = this.touched.get(agent.id) ?? 0;
    if (now() - last > 60_000) {
      this.touched.set(agent.id, now());
      this.sql.prepare("UPDATE agents SET last_used_at = ? WHERE id = ?").run(iso(now()), agent.id);
    }
    return agent;
  }

  /** The agent as it is now (scopes may have changed since its token was checked). */
  get(id: string): Agent | undefined {
    const r = this.sql.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    if (!r) return undefined;
    const caps = json<"*" | string[]>(r.capabilities);
    return { id: r.id, kind: "agent", scopes: new Set(json<Scope[]>(r.scopes)), capabilities: caps === "*" ? "*" : new Set(caps) };
  }

  list(): AgentDetails[] {
    return this.sql
      .prepare("SELECT a.*, c.name AS client_name FROM agents a LEFT JOIN oauth_clients c ON c.client_id = a.client_id ORDER BY a.created_at")
      .all()
      .map((r) => ({
        id: r.id,
        name: r.name,
        scopes: json(r.scopes),
        maxScopes: json(r.max_scopes),
        capabilities: json(r.capabilities),
        clientName: r.client_name ?? r.name,
        via: r.via,
        address: r.address ?? null,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at ?? null,
      }));
  }

  /**
   * Change an agent's scopes (within what it was approved for: never wider), its capability
   * allowlist, or revoke it (its tokens die with it).
   */
  update(id: string, change: { scopes?: Scope[]; capabilities?: "*" | string[] } | "revoke"): void {
    const r = this.sql.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    if (!r) throw new PlatformError("not_found", `no agent '${id}'`);
    if (change === "revoke") {
      this.sql.prepare("DELETE FROM oauth_tokens WHERE agent_id = ?").run(id);
      this.sql.prepare("DELETE FROM agents WHERE id = ?").run(id);
    } else {
      if (change.scopes) {
        const max = new Set(json<Scope[]>(r.max_scopes));
        const wider = validScopes(change.scopes).filter((s) => !max.has(s));
        if (wider.length) throw new PlatformError("forbidden", `'${id}' was approved for ${[...max].join(", ") || "nothing"}; reconnect it to ask for ${wider.join(", ")}`);
        this.sql.prepare("UPDATE agents SET scopes = ? WHERE id = ?").run(JSON.stringify(change.scopes), id);
      }
      if (change.capabilities) this.sql.prepare("UPDATE agents SET capabilities = ? WHERE id = ?").run(JSON.stringify(change.capabilities), id);
    }
    this.onChange(id);
  }

  // ---------- registration (RFC 7591) ----------

  register(meta: Record<string, unknown>): Record<string, unknown> {
    const uris = meta.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && allowedRedirect(u))) {
      throw new OAuthError("invalid_redirect_uri", "redirect_uris must be https URLs or http URLs on this machine (127.0.0.1 / localhost)");
    }
    const grants = (meta.grant_types as string[] | undefined) ?? ["authorization_code", "refresh_token"];
    if (!grants.includes("authorization_code")) throw new OAuthError("invalid_client_metadata", "Hewn only supports the authorization_code grant (with refresh_token)");
    const method = (meta.token_endpoint_auth_method as string | undefined) ?? "client_secret_basic";
    if (!["none", "client_secret_basic", "client_secret_post"].includes(method)) throw new OAuthError("invalid_client_metadata", `unsupported token_endpoint_auth_method ${method}`);
    const name = String(meta.client_name ?? "").trim().slice(0, 80) || new URL(uris[0] as string).hostname;
    const count = this.sql.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get()!.n as number;
    if (count >= MAX_CLIENTS) this.pruneClients(0);
    if ((this.sql.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get()!.n as number) >= MAX_CLIENTS) {
      throw new OAuthError("temporarily_unavailable", "too many registered clients; revoke unused agents", 503);
    }
    const clientId = `hewn_c_${randomToken(16)}`;
    const secret = method === "none" ? undefined : `hewn_cs_${randomToken(32)}`;
    this.sql
      .prepare("INSERT INTO oauth_clients (client_id, name, redirect_uris, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(clientId, name, JSON.stringify(uris), secret ? sha256(secret) : null, iso(now()));
    return {
      client_id: clientId,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: method,
    };
  }

  client(clientId: string): ClientInfo | undefined {
    const r = this.sql.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId);
    return r && { clientId: r.client_id, name: r.name, redirectUris: json(r.redirect_uris), public: !r.secret_hash };
  }

  // ---------- authorization ----------

  /**
   * Validate an authorization request. Errors about the client or redirect URI must not
   * redirect (the caller shows them); `redirectError` carries the ones that go back to the client.
   */
  startAuthorization(
    p: Record<string, string | undefined>,
    ctx: { via: "local" | "tunnel"; issuer: string },
  ): { id: string; secret: string; userCode: string; clientName: string; redirectHost: string } {
    const client = p.client_id ? this.client(p.client_id) : undefined;
    if (!client) throw new OAuthError("invalid_client", "unknown client_id: the agent should register again");
    const redirect = p.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirect || !client.redirectUris.some((u) => sameRedirect(u, redirect))) throw new OAuthError("invalid_request", "redirect_uri doesn't match the registered one");
    const back = (code: string, message: string) => Object.assign(new OAuthError(code, message), { redirectTo: redirectWithError(redirect, code, message, p.state, ctx.issuer) });
    if (p.response_type !== "code") throw back("unsupported_response_type", "response_type must be code");
    if (!p.code_challenge || p.code_challenge_method !== "S256") throw back("invalid_request", "PKCE with S256 is required");
    // Scopes Hewn doesn't know (e.g. "openid", or ones from older versions) are ignored, not an error.
    const asked = (p.scope ?? "").trim().split(/\s+/).filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
    const requested: Scope[] = asked.length ? [...new Set(asked)] : AGENT_SCOPES;
    this.expireRequests();
    // A reloaded authorize page (same client, same PKCE challenge) replaces its earlier request.
    this.sql.prepare("DELETE FROM oauth_requests WHERE status = 'pending' AND client_id = ? AND code_challenge = ?").run(client.clientId, p.code_challenge);
    const pending = this.sql.prepare("SELECT COUNT(*) AS n FROM oauth_requests WHERE status = 'pending' AND via = ?").get(ctx.via)!.n as number;
    if (pending >= MAX_PENDING[ctx.via]) throw back("temporarily_unavailable", "too many connection requests are waiting for the owner");
    const id = randomToken(12);
    const secret = randomToken(24);
    const code = userCode();
    this.sql
      .prepare(
        `INSERT INTO oauth_requests (id, secret_hash, client_id, redirect_uri, state, code_challenge, scopes, resource, user_code, via, status, issuer, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(id, sha256(secret), client.clientId, redirect, p.state ?? null, p.code_challenge, JSON.stringify(requested), p.resource ?? null, code, ctx.via, ctx.issuer, iso(now()));
    return { id, secret, userCode: code, clientName: client.name, redirectHost: new URL(redirect).host };
  }

  pending(): PendingRequest[] {
    this.expireRequests();
    return this.sql
      .prepare("SELECT r.*, c.name AS client_name FROM oauth_requests r JOIN oauth_clients c ON c.client_id = r.client_id WHERE r.status = 'pending' ORDER BY r.created_at DESC")
      .all()
      .map((r) => {
        const requested = json<Scope[]>(r.scopes);
        const { name: suggestedName, reconnects } = this.suggestName(r);
        const current = reconnects ? this.currentGrant(reconnects) : null;
        return {
          id: r.id,
          clientName: r.client_name,
          redirectHost: new URL(r.redirect_uri).host,
          requested,
          suggested: current ? requested.filter((s) => current.scopes.includes(s)) : requested,
          current,
          userCode: r.user_code,
          via: r.via,
          address: hostOf(r.issuer),
          createdAt: r.created_at,
          reconnects,
          suggestedName,
        };
      });
  }

  /** What an existing agent may do now, or null. */
  private currentGrant(agentId: string): PendingRequest["current"] {
    const a = this.sql.prepare("SELECT scopes, capabilities FROM agents WHERE id = ?").get(agentId);
    return a ? { scopes: json<Scope[]>(a.scopes), capabilities: json<"*" | string[]>(a.capabilities) } : null;
  }

  /** See PendingRequest.reconnects. */
  private suggestName(r: Record<string, any>): { name: string; reconnects: string | null } {
    const base = agentName(r.client_name);
    const id = slug(base);
    // This name and its numbered copies: "claude-code", "claude-code-2" …
    const copies = this.sql
      .prepare("SELECT id, client_id, via FROM agents WHERE id = ? OR id LIKE ?")
      .all(id, `${id}-%`)
      .filter((a) => a.id === id || new RegExp(`^${id}-\\d+$`).test(String(a.id)));
    const again = copies.find((a) => a.client_id === r.client_id) ?? (r.via === "local" ? copies.find((a) => a.via === "local") : undefined);
    if (again) return { name: again.id === id ? base : `${base} (${String(again.id).slice(id.length + 1)})`, reconnects: String(again.id) };
    const taken = new Set(copies.map((a) => String(a.id)));
    if (!taken.has(id)) return { name: base, reconnects: null };
    for (let n = 2; ; n++) if (!taken.has(`${id}-${n}`)) return { name: `${base} (${n})`, reconnects: null };
  }

  /**
   * The owner's decision. Approval may narrow the requested scopes, never widen them. Naming it
   * like an existing agent reconnects that agent (its old tokens stop working); scopes and tools
   * left unsaid then stay as the owner last set them, so reconnecting never quietly widens it.
   */
  decide(id: string, d: { approve: false } | { approve: true; name?: string; scopes?: Scope[]; capabilities?: "*" | string[] }): { agentId?: string } {
    this.expireRequests();
    const r = this.sql.prepare("SELECT r.*, c.name AS client_name FROM oauth_requests r JOIN oauth_clients c ON c.client_id = r.client_id WHERE r.id = ?").get(id);
    if (!r || r.status !== "pending") throw new PlatformError("not_found", "no such pending connection request (it may have expired: ask the agent to connect again)");
    if (!d.approve) {
      this.sql.prepare("UPDATE oauth_requests SET status = 'denied', decided_at = ? WHERE id = ?").run(iso(now()), id);
      return {};
    }
    const requested = json<Scope[]>(r.scopes);
    const name = d.name?.trim() || this.suggestName(r).name;
    const agentId = slug(name);
    if (agentId === "user" || agentId === "web") throw new PlatformError("invalid_request", `'${agentId}' is reserved`);
    const current = this.currentGrant(agentId);
    const scopes = validScopes(d.scopes ?? (current ? requested.filter((s) => current.scopes.includes(s)) : requested));
    const wider = scopes.filter((s) => !requested.includes(s));
    if (wider.length) throw new PlatformError("forbidden", `the agent didn't ask for ${wider.join(", ")}; approval can only narrow what it asked for`);
    const caps = d.capabilities ?? current?.capabilities ?? "*";
    const at = iso(now());
    this.sql.prepare("DELETE FROM oauth_tokens WHERE agent_id = ?").run(agentId);
    this.sql
      .prepare(
        `INSERT INTO agents (id, name, client_id, scopes, max_scopes, capabilities, via, address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, client_id = excluded.client_id, scopes = excluded.scopes,
           max_scopes = excluded.max_scopes, capabilities = excluded.capabilities, via = excluded.via, address = excluded.address`,
      )
      .run(agentId, name, r.client_id, JSON.stringify(scopes), JSON.stringify(requested), JSON.stringify(caps), r.via, hostOf(r.issuer), at);
    this.sql.prepare("UPDATE oauth_requests SET status = 'approved', agent_id = ?, decided_at = ? WHERE id = ?").run(agentId, at, id);
    // Other requests from the same client (an earlier attempt, another tab) are moot now.
    this.sql.prepare("DELETE FROM oauth_requests WHERE status = 'pending' AND client_id = ?").run(r.client_id);
    this.onChange(agentId);
    return { agentId };
  }

  /**
   * The authorize page polls with its secret. Once decided, it gets where to send the browser:
   * back to the agent with a one-time code, or with access_denied.
   */
  poll(id: string, secret: string): { status: "pending" | "expired" } | { status: "approved" | "denied"; redirect: string } {
    this.expireRequests();
    const r = this.sql.prepare("SELECT * FROM oauth_requests WHERE id = ?").get(id);
    if (!r || sha256(secret) !== r.secret_hash) return { status: "expired" };
    if (r.status === "pending") return { status: "pending" };
    if (r.status === "denied") return { status: "denied", redirect: redirectWithError(r.redirect_uri, "access_denied", "the owner declined", r.state, r.issuer) };
    if (r.status !== "approved") return { status: "expired" };
    const code = `hewn_ac_${randomToken(24)}`;
    this.sql.prepare("UPDATE oauth_requests SET status = 'code', code_hash = ?, decided_at = ? WHERE id = ?").run(sha256(code), iso(now()), id);
    const u = new URL(r.redirect_uri);
    u.searchParams.set("code", code);
    if (r.state != null) u.searchParams.set("state", r.state);
    u.searchParams.set("iss", r.issuer);
    return { status: "approved", redirect: u.toString() };
  }

  // ---------- token endpoint ----------

  /** Client authentication at the token endpoint: public clients prove possession with PKCE only. */
  private authClient(clientId: string | undefined, secret: string | undefined): ClientInfo {
    const r = clientId ? this.sql.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId) : undefined;
    if (!r) throw new OAuthError("invalid_client", "unknown client", 401);
    if (r.secret_hash && (!secret || sha256(secret) !== r.secret_hash)) throw new OAuthError("invalid_client", "client authentication failed", 401);
    return { clientId: r.client_id, name: r.name, redirectUris: json(r.redirect_uris), public: !r.secret_hash };
  }

  exchangeCode(p: { code?: string; code_verifier?: string; redirect_uri?: string; client_id?: string; client_secret?: string }): Tokens {
    const client = this.authClient(p.client_id, p.client_secret);
    if (!p.code || !p.code_verifier) throw new OAuthError("invalid_request", "code and code_verifier are required");
    const r = this.sql.prepare("SELECT * FROM oauth_requests WHERE code_hash = ?").get(sha256(p.code));
    if (!r) throw new OAuthError("invalid_grant", "unknown or used authorization code");
    // One use only. A replayed code also voids what the first use issued (RFC 6749 §10.5).
    this.sql.prepare("UPDATE oauth_requests SET status = 'used' WHERE id = ?").run(r.id);
    if (r.status !== "code") {
      if (r.agent_id) this.sql.prepare("DELETE FROM oauth_tokens WHERE agent_id = ? AND client_id = ?").run(r.agent_id, r.client_id);
      throw new OAuthError("invalid_grant", "authorization code already used");
    }
    if (r.client_id !== client.clientId) throw new OAuthError("invalid_grant", "code was issued to another client");
    if (now() - Date.parse(r.decided_at) > CODE_TTL) throw new OAuthError("invalid_grant", "authorization code expired");
    if (p.redirect_uri && p.redirect_uri !== r.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri mismatch");
    if (pkceChallenge(p.code_verifier) !== r.code_challenge) throw new OAuthError("invalid_grant", "PKCE verification failed");
    if (!this.sql.prepare("SELECT id FROM agents WHERE id = ?").get(r.agent_id)) throw new OAuthError("invalid_grant", "the agent was revoked");
    return this.issue(r.agent_id, client.clientId);
  }

  refresh(p: { refresh_token?: string; client_id?: string; client_secret?: string }): Tokens {
    const client = this.authClient(p.client_id, p.client_secret);
    const hash = p.refresh_token ? sha256(p.refresh_token) : "";
    const t = this.sql.prepare("SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'refresh'").get(hash);
    if (!t || t.expires_at <= now()) throw new OAuthError("invalid_grant", "refresh token expired or revoked: connect again");
    if (t.client_id !== client.clientId) throw new OAuthError("invalid_grant", "refresh token was issued to another client");
    // Rotation: the old refresh token is spent.
    this.sql.prepare("DELETE FROM oauth_tokens WHERE hash = ?").run(hash);
    if (!this.sql.prepare("SELECT id FROM agents WHERE id = ?").get(t.agent_id)) throw new OAuthError("invalid_grant", "the agent was revoked");
    return this.issue(t.agent_id, client.clientId);
  }

  /** RFC 7009: revoking either token of a pair ends the pair's access (we revoke the agent's tokens for this client). */
  revokeToken(token: string | undefined) {
    if (!token) return;
    const t = this.sql.prepare("SELECT * FROM oauth_tokens WHERE hash = ?").get(sha256(token));
    if (t) this.sql.prepare("DELETE FROM oauth_tokens WHERE agent_id = ? AND client_id IS ?").run(t.agent_id, t.client_id);
  }

  /** Mint an access + refresh token pair for an approved agent. */
  issue(agentId: string, clientId: string | null = null): Tokens {
    const r = this.sql.prepare("SELECT scopes FROM agents WHERE id = ?").get(agentId);
    if (!r) throw new PlatformError("not_found", `no agent '${agentId}'`);
    const access = `hewn_at_${randomToken(32)}`;
    const refresh = `hewn_rt_${randomToken(32)}`;
    const ins = this.sql.prepare("INSERT INTO oauth_tokens (hash, agent_id, kind, client_id, expires_at) VALUES (?, ?, ?, ?, ?)");
    ins.run(sha256(access), agentId, "access", clientId, now() + ACCESS_TTL);
    ins.run(sha256(refresh), agentId, "refresh", clientId, now() + REFRESH_TTL);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: json<Scope[]>(r.scopes).join(" ") };
  }

  /** An agent approved directly by the owner (tests), without the browser round trip. */
  approveDirect(name: string, scopes: Scope[], capabilities: "*" | string[] = "*"): string {
    const id = slug(name);
    this.sql
      .prepare("INSERT OR REPLACE INTO agents (id, name, client_id, scopes, max_scopes, capabilities, via, created_at) VALUES (?, ?, NULL, ?, ?, ?, 'test', ?)")
      .run(id, name, JSON.stringify(validScopes(scopes)), JSON.stringify(AGENT_SCOPES), JSON.stringify(capabilities), iso(now()));
    return id;
  }

  // ---------- housekeeping ----------

  private expireRequests() {
    const cutoff = iso(now() - REQUEST_TTL);
    this.sql.prepare("DELETE FROM oauth_requests WHERE created_at < ? AND status IN ('pending', 'denied', 'approved', 'code', 'used')").run(cutoff);
  }

  /** Clients that never became (or no longer are) an agent, after `olderThanMs`. */
  private pruneClients(olderThanMs: number) {
    this.sql
      .prepare("DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM agents WHERE client_id IS NOT NULL) AND client_id NOT IN (SELECT client_id FROM oauth_requests)")
      .run(iso(now() - olderThanMs));
  }

  cleanup(): { tokens: number; clients: number } {
    const t = this.sql.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE expires_at <= ?").get(now())!.n as number;
    this.sql.prepare("DELETE FROM oauth_tokens WHERE expires_at <= ?").run(now());
    this.expireRequests();
    const before = this.sql.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get()!.n as number;
    this.pruneClients(24 * 60 * 60 * 1000);
    const after = this.sql.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get()!.n as number;
    return { tokens: t, clients: before - after };
  }
}

function redirectWithError(redirect: string, code: string, description: string, state: string | null | undefined, issuer: string): string {
  const u = new URL(redirect);
  u.searchParams.set("error", code);
  u.searchParams.set("error_description", description);
  if (state != null) u.searchParams.set("state", state);
  u.searchParams.set("iss", issuer);
  return u.toString();
}
