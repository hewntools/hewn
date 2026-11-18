// SPDX-License-Identifier: AGPL-3.0-or-later
// Talking to the copy: its admin channel (as the owner, like the CLI), the supervisor's control channel, the web API
// signed in as the owner, and an agent over MCP.
import { request } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { pkceChallenge } from "../../packages/core/src/agents.ts";

export interface Ready {
  url: string;
  adminToken: string;
  control: { url: string; token: string };
  pid: number;
  startMs: number;
}

export interface WebResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export class CopyClient {
  ready: Ready;
  readonly port: number;
  private cookie = "";
  constructor(ready: Ready) {
    this.ready = ready;
    this.port = Number(new URL(ready.url).port);
  }

  /** The web client's origin (Hewn's own host name: the copy's cookies are for it). */
  get origin() {
    return `http://hewn.localhost:${this.port}`;
  }

  async admin<T = any>(path: string, body: unknown = {}, timeoutMs = 120_000): Promise<T> {
    const res = await fetch(`${this.ready.url}/_admin/${path}`, { method: "POST", headers: { "x-hewn-admin": this.ready.adminToken, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const out = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || out?.error) throw new Error(out?.message ?? out?.error ?? `HTTP ${res.status}`);
    return out as T;
  }

  /** An allow-listed core method, as the owner (`hewn`'s admin calls). */
  async call<T = any>(method: string, ...args: unknown[]): Promise<T> {
    return (await this.admin<{ result: T }>("call", { method, args })).result;
  }

  async control<T = any>(path: string, body: unknown = {}): Promise<T> {
    const res = await fetch(`${this.ready.control.url}/control/${path}`, { method: "POST", headers: { "x-hewn-control": this.ready.control.token, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`control ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  async health(): Promise<boolean> {
    return fetch(`${this.ready.url}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  }

  /** A raw request to the copy, on Hewn's own host name, with the owner's cookie once signed in. */
  web(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<WebResponse> {
    return new Promise((ok, fail) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const r = request(
        { host: "127.0.0.1", port: this.port, method, path, timeout: timeoutMs, headers: { host: `hewn.localhost:${this.port}`, "x-hewn-ui": "1", ...(this.cookie ? { cookie: this.cookie } : {}), ...(data ? { "content-type": "application/json", "content-length": data.length } : {}) } },
        (m) => {
          let text = "";
          m.setEncoding("utf8");
          m.on("data", (d) => (text += d));
          m.on("end", () => ok({ status: m.statusCode!, headers: m.headers, body: text }));
        },
      );
      r.on("timeout", () => r.destroy(new Error(`${method} ${path}: no answer in ${timeoutMs / 1000} s`)));
      r.on("error", fail);
      r.end(data);
    });
  }

  /** The web API's JSON, as the signed-in owner; throws on anything but 200. */
  async api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.web(method, path, body);
    if (r.status !== 200) throw new Error(`${method} ${path}: HTTP ${r.status} ${r.body.slice(0, 300)}`);
    return JSON.parse(r.body) as T;
  }

  /** A single-use sign-in ticket for the web client (as `hewn open` gets one). */
  async ticket(): Promise<string> {
    return (await this.admin<{ ticket: string }>("web-ticket")).ticket;
  }

  /** Sign this client in as the owner (a cookie, as a browser gets one). */
  async signIn() {
    const r = await this.web("GET", `/auth?ticket=${await this.ticket()}`);
    const set = r.headers["set-cookie"];
    const cookie = (Array.isArray(set) ? set[0] : set)?.split(";")[0];
    if (!cookie) throw new Error(`no session cookie from /auth (HTTP ${r.status})`);
    this.cookie = cookie;
  }

  /**
   * An agent signed in the way real ones are (registration, the owner's approval, PKCE), connected over MCP.
   * Its client waits a little longer than the copy's own deadlines.
   */
  async agent(name: string, scopes: string[]): Promise<Agent> {
    const base = this.ready.url;
    const redirect = "http://127.0.0.1:59998/callback";
    const reg = await (await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none" }) })).json();
    const verifier = "smoke-verifier-".padEnd(60, "x");
    const q = new URLSearchParams({ client_id: reg.client_id, response_type: "code", redirect_uri: redirect, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", scope: scopes.join(" "), state: "s" });
    const page = await (await fetch(`${base}/authorize?${q}`)).text();
    const id = /id:"([^"]+)"/.exec(page)?.[1];
    const secret = /secret:"([^"]+)"/.exec(page)?.[1];
    if (!id || !secret) throw new Error("the authorize page changed: no request id in it");
    await this.call("decideAgent", id, { approve: true, name, scopes });
    const poll = await (await fetch(`${base}/authorize/poll`, { method: "POST", body: new URLSearchParams({ id, secret }) })).json();
    const code = new URL(poll.redirect).searchParams.get("code")!;
    const tokens = await (await fetch(`${base}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect }) })).json();
    if (!tokens.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tokens).slice(0, 200)}`);
    const client = new Client({ name, version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
    return {
      client,
      tool: async (tool: string, args: Record<string, unknown>, timeoutMs = 120_000) => {
        const r = (await client.callTool({ name: tool, arguments: args }, CallToolResultSchema, { timeout: timeoutMs })) as { isError?: boolean; content: { type: string; text?: string }[] };
        const text = r.content.find((c) => c.type === "text")?.text ?? "";
        if (r.isError) throw new Error(text.slice(0, 500));
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      },
      close: () => client.close().catch(() => {}),
    };
  }
}

export interface Agent {
  client: Client;
  /** Call one of Hewn's MCP tools; its text parsed as JSON when it is. Throws on an error result. */
  tool: (name: string, args: Record<string, unknown>, timeoutMs?: number) => Promise<any>;
  close: () => Promise<void>;
}
