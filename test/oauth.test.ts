// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { USER } from "@hewntools/core/auth.ts";
import { pkceChallenge } from "@hewntools/core/agents.ts";
import { serverUrl, startPublicServer } from "@hewntools/test-host/server.ts";
import { RateLimiter, RULES } from "@hewntools/host-workerd/surface/public.ts";
import { FIXTURES, installFrom, installSeed, serve, setup } from "./helpers.ts";

const verifier = "v".repeat(50);
const challenge = pkceChallenge(verifier);

describe("OAuth: the agent store", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t?.cleanup();
    t = setup();
  });
  after(() => t.cleanup());
  const store = () => t.platform.agentStore;
  const register = (uris = ["http://127.0.0.1:5000/callback"], extra: Record<string, unknown> = {}) =>
    store().register({ client_name: "Test Agent (hewn)", redirect_uris: uris, token_endpoint_auth_method: "none", ...extra }) as { client_id: string; client_secret?: string };
  const start = (clientId: string, over: Record<string, string> = {}) =>
    store().startAuthorization({ client_id: clientId, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", redirect_uri: "http://127.0.0.1:5000/callback", state: "s1", scope: "discover invoke create", ...over }, { via: "local", issuer: "http://127.0.0.1:1" });
  /** Register → authorize → approve → code → tokens. */
  const connect = (scopes?: string[]) => {
    const c = register();
    const r = start(c.client_id);
    const { agentId } = t.platform.decideAgent(USER, r.id, { approve: true, ...(scopes ? { scopes: scopes as any } : {}) });
    const poll = store().poll(r.id, r.secret) as { redirect: string };
    const code = new URL(poll.redirect).searchParams.get("code")!;
    return { c, agentId: agentId!, tokens: store().exchangeCode({ code, code_verifier: verifier, client_id: c.client_id, redirect_uri: "http://127.0.0.1:5000/callback" }), code };
  };

  test("a second agent with the same name gets a number, unless it's the same client or the same machine", () => {
    const from = (via: "local" | "tunnel", issuer: string, c = register()) => {
      const r = store().startAuthorization({ client_id: c.client_id, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", redirect_uri: "http://127.0.0.1:5000/callback", scope: "discover invoke" }, { via, issuer });
      return { c, r, pending: store().pending().find((p) => p.id === r.id)! };
    };
    const mac = from("tunnel", "https://hewn.example.com");
    assert.equal(mac.pending.suggestedName, "Test Agent");
    assert.equal(t.platform.decideAgent(USER, mac.r.id, { approve: true }).agentId, "test-agent");
    assert.equal(t.platform.agents(USER).find((a) => a.id === "test-agent")!.address, "hewn.example.com");

    const laptop = from("tunnel", "https://hewn.example.com");
    assert.deepEqual([laptop.pending.suggestedName, laptop.pending.reconnects], ["Test Agent (2)", null], "another client: never replaces the first");
    assert.equal(t.platform.decideAgent(USER, laptop.r.id, { approve: true }).agentId, "test-agent-2");

    const again = from("tunnel", "https://hewn.example.com", mac.c);
    assert.deepEqual([again.pending.suggestedName, again.pending.reconnects], ["Test Agent", "test-agent"], "the same client signing in again reconnects");

    const server = from("local", "http://127.0.0.1:7717");
    assert.equal(server.pending.suggestedName, "Test Agent (3)", "on Hewn's machine, but the existing one connected from outside");
    t.platform.decideAgent(USER, server.r.id, { approve: true });
    const serverAgain = from("local", "http://127.0.0.1:7717");
    assert.deepEqual([serverAgain.pending.suggestedName, serverAgain.pending.reconnects], ["Test Agent (3)", "test-agent-3"], "Hewn's machine signing in again (a new client) reconnects its own");
  });

  test("registration: https or loopback redirects only", () => {
    for (const bad of [["javascript:alert(1)"], ["http://evil.example/cb"], ["https://x.example/cb#frag"], []]) {
      assert.throws(() => register(bad), /redirect/);
    }
    assert.ok(register(["https://claude.ai/api/mcp/auth_callback"]).client_id.startsWith("hewn_c_"));
    const confidential = store().register({ client_name: "C", redirect_uris: ["https://a.example/cb"] }) as { client_secret: string };
    assert.ok(confidential.client_secret.startsWith("hewn_cs_"));
  });

  test("authorize: PKCE S256 is required; errors go back to the agent's redirect", () => {
    const c = register();
    assert.throws(() => start(c.client_id, { code_challenge_method: "plain" }), (e: any) => e.code === "invalid_request" && /error=invalid_request/.test(e.redirectTo));
    assert.throws(() => start("nope"), (e: any) => e.code === "invalid_client" && !e.redirectTo);
    assert.throws(() => start(c.client_id, { redirect_uri: "http://127.0.0.1:5000/other" }), (e: any) => !e.redirectTo, "mismatched redirect never redirects");
    // Loopback redirects may use any port (RFC 8252).
    assert.ok(start(c.client_id, { redirect_uri: "http://127.0.0.1:61234/callback" }).id);
  });

  test("the approval card: name without decorations, requested scopes, a code to match; reload replaces", () => {
    const c = register();
    start(c.client_id);
    const r = start(c.client_id); // the page reloaded
    const pending = t.platform.pendingAgents(USER);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, r.id);
    assert.equal(pending[0].suggestedName, "Test Agent");
    assert.deepEqual(pending[0].requested, ["discover", "invoke", "create"]);
    assert.match(pending[0].userCode, /^[A-Z0-9]{3}-[A-Z0-9]{3}$/);
    assert.equal(pending[0].redirectHost, "127.0.0.1:5000");
    // Scopes Hewn doesn't know are ignored, not an error.
    const other = start(register(["http://localhost:7000/cb"]).client_id, { redirect_uri: "http://localhost:7000/cb", scope: "openid discover" });
    assert.deepEqual(t.platform.pendingAgents(USER).find((p) => p.id === other.id)!.requested, ["discover"]);
  });

  test("approval narrows, never widens; then the full code exchange", () => {
    const c = register();
    const r = start(c.client_id);
    assert.throws(() => t.platform.decideAgent(USER, r.id, { approve: true, scopes: ["discover", "modify"] }), /didn't ask for modify/);
    assert.throws(() => t.platform.decideAgent(t.claude, r.id, { approve: true }), /owner/);
    assert.deepEqual(store().poll(r.id, r.secret), { status: "pending" });
    assert.deepEqual(store().poll(r.id, "wrong"), { status: "expired" });
    const { tokens, agentId } = connect(["discover"]);
    assert.equal(agentId, "test-agent");
    assert.equal(tokens.scope, "discover");
    const agent = store().authenticate(tokens.access_token)!;
    assert.deepEqual([...agent.scopes], ["discover"]);
    // Restoring scopes up to what it asked for is fine; beyond is not.
    t.platform.updateAgent(USER, agentId, { scopes: ["discover", "invoke"] });
    assert.throws(() => t.platform.updateAgent(USER, agentId, { scopes: ["modify"] }), /reconnect it to ask for modify/);
  });

  test("codes are one-time, bound to client, verifier and redirect; a replay voids what they issued", () => {
    const { c, tokens, code } = connect();
    assert.throws(() => store().exchangeCode({ code, code_verifier: verifier, client_id: c.client_id }), /already used|unknown/);
    assert.equal(store().authenticate(tokens.access_token), undefined, "replay revoked the first tokens");

    const c2 = register();
    const r = start(c2.client_id);
    t.platform.decideAgent(USER, r.id, { approve: true, name: "Other" });
    const code2 = new URL((store().poll(r.id, r.secret) as { redirect: string }).redirect).searchParams.get("code")!;
    assert.throws(() => store().exchangeCode({ code: code2, code_verifier: "x".repeat(50), client_id: c2.client_id }), /PKCE/);
  });

  test("tokens are stored hashed; refresh rotates; revoke cuts the agent off", () => {
    const { c, tokens, agentId } = connect();
    const raw = JSON.stringify((t.platform.agentStore as any).sql.prepare("SELECT * FROM oauth_tokens").all());
    assert.ok(!raw.includes(tokens.access_token) && !raw.includes(tokens.refresh_token), "only hashes at rest");
    const next = store().refresh({ refresh_token: tokens.refresh_token, client_id: c.client_id });
    assert.ok(store().authenticate(next.access_token));
    assert.throws(() => store().refresh({ refresh_token: tokens.refresh_token, client_id: c.client_id }), /expired or revoked/, "rotated");
    t.platform.updateAgent(USER, agentId, "revoke");
    assert.equal(store().authenticate(next.access_token), undefined);
    assert.throws(() => store().refresh({ refresh_token: next.refresh_token, client_id: c.client_id }));
  });

  test("the tunnel has its own pending cap: a full tunnel queue doesn't block local agents", () => {
    const { client_id } = register(["https://a.example/cb"]);
    const ask = (via: "local" | "tunnel", i: number) =>
      store().startAuthorization({ client_id, response_type: "code", code_challenge: pkceChallenge(`${via}-${i}-`.padEnd(50, "x")), code_challenge_method: "S256", redirect_uri: "https://a.example/cb", state: "s" }, { via, issuer: "https://hewn.example.com" });
    for (let i = 0; i < 10; i++) ask("tunnel", i);
    assert.throws(() => ask("tunnel", 10), /too many connection requests/);
    assert.doesNotThrow(() => ask("local", 0));
  });

  test("reconnecting keeps what the owner narrowed; widening again is the owner's explicit choice", () => {
    const { client_id } = register();
    const first = start(client_id, { scope: "discover invoke create modify" });
    const { agentId } = store().decide(first.id, { approve: true });
    store().update(agentId!, { scopes: ["discover"], capabilities: ["running-log"] });
    const again = start(client_id, { scope: "discover invoke create modify", code_challenge: pkceChallenge("w".repeat(50)) });
    const card = store().pending().find((p) => p.id === again.id)!;
    assert.equal(card.reconnects, agentId);
    assert.deepEqual(card.suggested, ["discover"], "pre-checked: what it has now");
    assert.deepEqual(card.current, { scopes: ["discover"], capabilities: ["running-log"] });
    store().decide(again.id, { approve: true });
    const a = store().get(agentId!)!;
    assert.deepEqual([[...a.scopes], a.capabilities === "*" ? "*" : [...a.capabilities]], [["discover"], ["running-log"]], "approved as suggested: still narrowed");
    const third = start(client_id, { scope: "discover invoke", code_challenge: pkceChallenge("z".repeat(50)) });
    store().decide(third.id, { approve: true, scopes: ["discover", "invoke"], capabilities: "*" });
    const b = store().get(agentId!)!;
    assert.deepEqual([[...b.scopes].sort(), b.capabilities], [["discover", "invoke"], "*"], "the owner widened it on purpose");
  });

  test("declined: the agent is sent back with access_denied", () => {
    const c = register();
    const r = start(c.client_id);
    t.platform.decideAgent(USER, r.id, { approve: false });
    const p = store().poll(r.id, r.secret) as { status: string; redirect: string };
    assert.equal(p.status, "denied");
    assert.equal(new URL(p.redirect).searchParams.get("error"), "access_denied");
    assert.equal(new URL(p.redirect).searchParams.get("state"), "s1");
  });
});

/** An MCP client that signs in like Claude Code would, with the owner approving in Hewn. */
function agentClient(base: string, approve: (requestId: string) => void) {
  let info: any;
  let tokens: any;
  let verifierSaved = "";
  let code: string | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: "http://127.0.0.1:59999/callback",
    clientMetadata: { client_name: "SDK Agent (hewn)", redirect_uris: ["http://127.0.0.1:59999/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] },
    clientInformation: () => info,
    saveClientInformation: (i) => void (info = i),
    tokens: () => tokens,
    saveTokens: (t) => void (tokens = t),
    saveCodeVerifier: (v) => void (verifierSaved = v),
    codeVerifier: () => verifierSaved,
    // "The browser": load the authorize page, the owner approves, the page's poll returns the redirect.
    redirectToAuthorization: async (url) => {
      const page = await (await fetch(url)).text();
      const id = /id:"([^"]+)"/.exec(page)![1];
      const secret = /secret:"([^"]+)"/.exec(page)![1];
      approve(id);
      const poll = await (await fetch(`${base}/authorize/poll`, { method: "POST", body: new URLSearchParams({ id, secret }) })).json();
      code = new URL(poll.redirect).searchParams.get("code") ?? undefined;
    },
  };
  return {
    provider,
    tokens: () => tokens,
    async connect() {
      const url = new URL(`${base}/mcp`);
      const client = new Client({ name: "sdk-agent", version: "0" });
      try {
        await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
        return client;
      } catch (e) {
        if (!code) throw e;
        const transport = new StreamableHTTPClientTransport(url, { authProvider: provider });
        await transport.finishAuth(code);
        code = undefined;
        const again = new Client({ name: "sdk-agent", version: "0" });
        await again.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
        return again;
      }
    },
  };
}

describe("OAuth over HTTP: a real MCP client signs in", () => {
  let t: ReturnType<typeof setup>;
  let server: Server;
  let base: string;
  before(async () => {
    t = setup();
    await installSeed(t.platform);
    server = await serve(t.platform, t.home);
    base = serverUrl(server).replace(/\/mcp$/, "");
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    t.cleanup();
  });

  test("401 points at the metadata; discovery documents are consistent", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
    assert.equal(res.status, 401);
    const header = res.headers.get("www-authenticate")!;
    const meta = /resource_metadata="([^"]+)"/.exec(header)![1];
    const pr = await (await fetch(meta)).json();
    assert.equal(pr.resource, `${base}/mcp`);
    const as = await (await fetch(`${pr.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
    assert.equal(as.issuer, base);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  });

  test("sign in, approved with fewer scopes: only those tools; revoke ends it on the next call", async () => {
    let agentId = "";
    const a = agentClient(base, (id) => {
      const p = t.platform.pendingAgents(USER).find((x) => x.id === id)!;
      assert.equal(p.clientName, "SDK Agent (hewn)");
      agentId = t.platform.decideAgent(USER, id, { approve: true, scopes: ["discover"] }).agentId!;
    });
    const client = await a.connect();
    assert.equal(agentId, "sdk-agent");
    const tools = (await client.listTools()).tools.map((x) => x.name).sort();
    assert.deepEqual(tools, ["capabilities_get", "capabilities_list", "hewn_docs", "schedules_list"]);
    const listed = await client.callTool({ name: "capabilities_list", arguments: {} });
    assert.match((listed.content as any)[0].text, /running-log/);
    await client.close();

    t.platform.updateAgent(USER, agentId, "revoke");
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${a.tokens().access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(res.status, 401);
  });

  test("a capability created mid-session shows up: tools/list_changed, no reconnect", async () => {
    const a = agentClient(base, (id) => void t.platform.decideAgent(USER, id, { approve: true, name: "Watcher" }));
    const client = await a.connect();
    const before = (await client.listTools()).tools.find((x) => x.name === "capabilities_invoke")!.description!;
    assert.doesNotMatch(before, /ui-counter/);
    const changed = new Promise<void>((resolve) => client.setNotificationHandler(ToolListChangedNotificationSchema, async () => resolve()));
    await new Promise((r) => setTimeout(r, 200)); // the client's notification stream is open
    await installFrom(t.platform, `${FIXTURES}/ui-counter`);
    await Promise.race([changed, new Promise((_, rej) => setTimeout(() => rej(new Error("no tools/list_changed")), 5000))]);
    const after = (await client.listTools()).tools.find((x) => x.name === "capabilities_invoke")!.description!;
    assert.match(after, /ui-counter/);
    // Scope changes reach the open session too.
    t.platform.updateAgent(USER, "watcher", { scopes: ["discover"] });
    assert.ok(!(await client.listTools()).tools.some((x) => x.name === "capabilities_invoke"));
    await client.close();
  });

  test("DNS rebinding: other Host names get 421; MCP refuses Origins from other sites", async () => {
    const send = (path: string, headers: Record<string, string>, method = "GET") =>
      new Promise<number>((resolve, reject) => {
        const u = new URL(`${base}${path}`);
        request({ host: u.hostname, port: u.port, path, method, headers }, (res) => (res.resume(), resolve(res.statusCode!))).on("error", reject).end(method === "POST" ? "{}" : undefined);
      });
    const port = new URL(base).port;
    for (const path of ["/register", "/authorize", "/mcp", "/.well-known/oauth-authorization-server", "/", "/api/capabilities"]) {
      assert.equal(await send(path, { host: `evil.example:${port}` }), 421, path);
    }
    assert.equal(await send("/.well-known/oauth-authorization-server", { host: `localhost:${port}` }), 200);
    assert.equal(await send("/mcp", { host: `127.0.0.1:${port}`, origin: "https://evil.example" }, "POST"), 403);
    assert.equal(await send("/mcp", { host: `127.0.0.1:${port}`, origin: `http://localhost:6274` }, "POST"), 401, "a local browser client still gets the challenge");
    assert.equal(await send("/mcp", { host: `127.0.0.1:${port}` }, "POST"), 401, "no Origin (a local agent) still gets the challenge");
  });

  test("an unknown session id is a 404 (the client starts over)", async () => {
    const token = t.platform.agentStore.issue(t.platform.agentStore.approveDirect("probe", ["discover"])).access_token;
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "mcp-session-id": "gone", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(res.status, 404);
  });
});

describe("the public path (what a tunnel reaches)", () => {
  let t: ReturnType<typeof setup>;
  let server: Server;
  let pub: Server;
  let base: string;
  const logs: string[] = [];
  before(async () => {
    t = setup();
    await installSeed(t.platform);
    server = await serve(t.platform, t.home, { log: (l) => void logs.push(l) });
    pub = await startPublicServer(server, 0, (l) => void logs.push(l), new RateLimiter({ ...RULES, register: { perClient: 2, total: 100, windowMs: 60_000 } }));
    base = `http://127.0.0.1:${(pub.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise((r) => pub.close(r));
    await new Promise((r) => server.close(r));
    t.cleanup();
  });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { "x-forwarded-host": "hewn.example.com", ...headers }, redirect: "manual" });
  /** With a real Host header (fetch won't send one), as a tunnel forwards it. */
  const status = (path: string, host: string) =>
    new Promise<number>((resolve, reject) => {
      const u = new URL(`${base}${path}`);
      request({ host: u.hostname, port: u.port, path, headers: { host } }, (res) => (res.resume(), resolve(res.statusCode!))).on("error", reject).end();
    });

  test("only MCP and OAuth answer; the web client, UIs, admin and health don't", async () => {
    for (const path of ["/", "/api/capabilities", "/_admin/status", "/health", "/auth?ticket=x", "/app.js"]) {
      assert.equal((await get(path)).status, 404, path);
      assert.equal(await status(path, "hewn.localhost"), 404, `${path} as hewn.localhost`);
      assert.equal(await status(path, "running-log.localhost"), 404, `${path} as a capability UI`);
    }
    assert.ok(logs.some((l) => /\[public\] .* GET \S*\/api\/capabilities -> 404/.test(l)), "logged");
    assert.ok(logs.some((l) => /\[public\] .* GET \/_admin\/status -> 404 \(not exposed\)/.test(l)), "admin refused before it reaches Hewn");
  });

  test("metadata uses the public https origin; MCP still needs a token", async () => {
    const as = await (await get("/.well-known/oauth-authorization-server")).json();
    assert.equal(as.issuer, "https://hewn.example.com");
    assert.equal(as.token_endpoint, "https://hewn.example.com/token");
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "x-forwarded-host": "hewn.example.com" }, body: "{}" });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate")!, /https:\/\/hewn\.example\.com\/\.well-known\/oauth-protected-resource\/mcp/);
  });

  test("requests that came through the tunnel are marked on the approval card", async () => {
    const reg = await (await fetch(`${base}/register`, { method: "POST", headers: { host: "hewn.example.com", "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify({ client_name: "claude.ai", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" }) })).json();
    const q = new URLSearchParams({ client_id: reg.client_id, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", redirect_uri: "https://claude.ai/api/mcp/auth_callback", state: "x" });
    const page = await get(`/authorize?${q}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /hewn agents approve/);
    const p = t.platform.pendingAgents(USER).find((x) => x.clientName === "claude.ai")!;
    assert.equal(p.via, "tunnel");
    assert.equal(p.redirectHost, "claude.ai");
  });

  test("rate limited per client address", async () => {
    const reg = (ip: string) => fetch(`${base}/register`, { method: "POST", headers: { host: "hewn.example.com", "content-type": "application/json", "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250)}, ${ip}` }, body: JSON.stringify({ client_name: "spam", redirect_uris: ["https://a.example/cb"] }) });
    assert.equal((await reg("198.51.100.1")).status, 201);
    assert.equal((await reg("198.51.100.1")).status, 201);
    const limited = await reg("198.51.100.1");
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.equal((await reg("198.51.100.2")).status, 201, "others aren't affected");
    assert.ok(logs.some((l) => /198\.51\.100\.1 POST \/register -> 429/.test(l)));
    const spoofed = await fetch(`${base}/register`, { method: "POST", headers: { host: "hewn.example.com", "content-type": "application/json", "cf-connecting-ip": "192.0.2.50", "x-forwarded-for": "198.51.100.1" }, body: JSON.stringify({ client_name: "spam", redirect_uris: ["https://a.example/cb"] }) });
    assert.equal(spoofed.status, 429, "a client-set CF-Connecting-IP doesn't dodge the limit");
  });
});
