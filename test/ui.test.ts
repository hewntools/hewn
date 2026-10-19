// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import { installSeed, setup, installFrom, serve } from "./helpers.ts";

const FIXTURE = resolve(import.meta.dirname, "fixtures/ui-counter");

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

describe("UI as a client", () => {
  let t: ReturnType<typeof setup>;
  let server: Server;
  let port: number;

  const http = (host: string, path: string, opts: { method?: string; cookie?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    new Promise<Res>((res, rej) => {
      const r = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: opts.method ?? "GET",
          headers: { host: `${host}:${port}`, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
        },
        (m) => {
          let body = "";
          m.on("data", (d) => (body += d));
          m.on("end", () => res({ status: m.statusCode!, headers: m.headers, body }));
        },
      );
      r.on("error", rej);
      r.end(opts.body ? JSON.stringify(opts.body) : undefined);
    });

  /** Where a capability's UI is served: under its UI key. */
  const ui = (id: string) => `/tools/${id}/~${t.platform.uiKey(id)}`;
  /** Redeem a ticket; the session token comes back in the fragment of the continue-URL. */
  const signIn = async (id: string) => {
    const r = await http("hewn.localhost", `/tools/${id}/auth?ticket=${t.platform.createUiTicket(id)}`);
    assert.equal(r.status, 200);
    const token = /#hewn_session=([\w-]+)/.exec(r.body)?.[1];
    assert.ok(token, r.body);
    return token!;
  };
  const invoke = (token: string, operation: string, headers: Record<string, string> = { "x-hewn-ui": "1" }) =>
    http("hewn.localhost", `${ui("ui-counter")}/api/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Hewn ${token}`, ...headers },
      body: { operation, input: {} },
    });

  before(async () => {
    t = setup();
    await installSeed(t.platform);
    await installFrom(t.platform, FIXTURE, "UI Counter");
    server = await serve(t.platform, t.home);
    port = (server.address() as AddressInfo).port;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    t.cleanup();
  });

  test("without its UI key nothing under /tools/<id>/ answers, as for a tool that doesn't exist; archived tools neither", async () => {
    for (const p of ["/tools/ui-counter/", "/tools/ui-counter/index.html", "/tools/ui-counter/~wrongkeywrongkey12/", "/tools/no-such-tool/", "/tools/no-such-tool/~abc/"]) {
      const r = await http("hewn.localhost", p);
      assert.equal(r.status, 404, p);
      assert.equal(r.body, JSON.stringify({ error: "not found" }), p);
    }
    const r = await http("hewn.localhost", `${ui("ui-counter")}/`);
    assert.equal(r.status, 200);
    assert.equal(r.headers["referrer-policy"], "no-referrer", "the address holds the key");
    t.platform.archive(USER, "ui-counter");
    assert.equal((await http("hewn.localhost", `${ui("ui-counter")}/`)).status, 404);
    t.platform.restore(USER, "ui-counter");
  });

  test("the API needs a session token; static UI files need only the UI key", async () => {
    assert.equal((await invoke("bogus", "get")).status, 401);
    assert.equal((await http("hewn.localhost", `${ui("ui-counter")}/api/invoke`, { method: "POST", headers: { "x-hewn-ui": "1" } })).status, 401);
    assert.equal((await http("hewn.localhost", `${ui("ui-counter")}/`)).status, 200);
  });

  test("tickets are single use and hand the token over in the URL fragment", async () => {
    const ticket = t.platform.createUiTicket("ui-counter");
    const r = await http("hewn.localhost", `/tools/ui-counter/auth?ticket=${ticket}`);
    assert.match(r.body, /url=http:\/\/hewn\.localhost:\d+\/tools\/ui-counter\/~[\w-]{16,}\/#hewn_session=/);
    assert.equal(r.headers["set-cookie"], undefined, "no cookies: they don't survive cross-site iframes");
    assert.equal((await http("hewn.localhost", `/tools/ui-counter/auth?ticket=${ticket}`)).status, 401);
  });

  test("a widget's tap opens the UI at a section; anything but a plain name is dropped", async () => {
    const r = await http("hewn.localhost", `/tools/ui-counter/auth?ticket=${t.platform.createUiTicket("ui-counter")}&section=today`);
    assert.match(r.body, /\/tools\/ui-counter\/~[\w-]+\/#hewn_session=[^"&]+&section=today"/);
    const bad = await http("hewn.localhost", `/tools/ui-counter/auth?ticket=${t.platform.createUiTicket("ui-counter")}&section=${encodeURIComponent('x"><script>')}`);
    assert.doesNotMatch(bad.body, /section|script/);
  });

  test("served pages get the session shim; a sandbox (opaque origin), their own API only, framable only by Hewn", async () => {
    const r = await http("hewn.localhost", `${ui("ui-counter")}/`);
    assert.match(r.body, /<head[^>]*><script src="\/_platform\/session.js"><\/script>/);
    const csp = String(r.headers["content-security-policy"]);
    assert.match(csp, /^sandbox allow-scripts /);
    assert.doesNotMatch(csp, /allow-same-origin/);
    assert.match(csp, new RegExp(`connect-src http://hewn\\.localhost:${port}/tools/ui-counter/;`));
    assert.match(csp, new RegExp(`frame-ancestors http://hewn\\.localhost:${port};`));
    assert.equal((await http("hewn.localhost", "/_platform/session.js")).headers["access-control-allow-origin"], "*", "modules load cross-origin");
  });

  test("every answer under /tools/<id>/ is sandboxed, errors and the ticket page included", async () => {
    for (const path of [`${ui("ui-counter")}/nope.html`, "/tools/ui-counter/auth?ticket=bogus", `/tools/ui-counter/auth?ticket=${t.platform.createUiTicket("ui-counter")}`, `${ui("ui-counter")}/api/manifest`, "/tools/ui-counter", ui("ui-counter")]) {
      assert.match(String((await http("hewn.localhost", path)).headers["content-security-policy"]), /^sandbox /, path);
    }
    assert.equal((await http("hewn.localhost", ui("ui-counter"))).headers.location, `http://hewn.localhost:${port}${ui("ui-counter")}/`);
  });

  test("the API answers the UI's opaque origin (a CORS preflight, then Origin: null)", async () => {
    const pre = await http("hewn.localhost", `${ui("ui-counter")}/api/invoke`, { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,x-hewn-ui" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers["access-control-allow-origin"], "null");
    const r = await invoke(await signIn("ui-counter"), "get", { "x-hewn-ui": "1", origin: "null" });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.headers["access-control-allow-origin"], "null");
  });

  test("UI invokes public operations through the platform", async () => {
    const token = await signIn("ui-counter");
    const r = await invoke(token, "increment");
    assert.equal(r.status, 200, r.body);
    assert.equal(JSON.parse(r.body).result.count, 1);
    assert.equal(JSON.parse((await invoke(token, "get")).body).result.count, 1);
  });

  test("unknown API paths are not routed to invoke", async () => {
    const token = await signIn("ui-counter");
    const r = await http("hewn.localhost", `${ui("ui-counter")}/api/whatever`, { method: "POST", headers: { authorization: `Hewn ${token}`, "x-hewn-ui": "1" } });
    assert.equal(r.status, 404);
  });

  test("CSRF: custom header required, foreign Origin refused", async () => {
    const token = await signIn("ui-counter");
    assert.equal((await invoke(token, "increment", {})).status, 403);
    assert.equal((await invoke(token, "increment", { "x-hewn-ui": "1", origin: "http://evil.localhost:1" })).status, 403);
    assert.equal((await invoke(token, "increment", { "x-hewn-ui": "1", origin: `http://hewn.localhost:${port}` })).status, 403, "not even the web client's origin");
  });

  test("a session for one capability is useless on another capability's origin", async () => {
    const token = await signIn("ui-counter");
    const r = await http("hewn.localhost", `${ui("running-log")}/api/manifest`, { headers: { authorization: `Hewn ${token}`, "x-hewn-ui": "1" } });
    assert.equal(r.status, 401);
  });

  test("the UI credential is limited to its own capability", async () => {
    const agent = t.platform.uiAgent(await signIn("ui-counter"), "ui-counter")!;
    assert.equal(agent.id, "ui:ui-counter");
    await assert.rejects(
      t.platform.invoke(agent, { capabilityId: "running-log", operation: "list_runs" }),
      (e) => e instanceof PlatformError && e.code === "not_found",
    );
    await assert.rejects(t.platform.modify(agent, { capabilityId: "ui-counter", request: "x" }), (e) => e instanceof PlatformError && e.code === "forbidden");
  });

  test("no path traversal out of ui/", async () => {
    for (const p of [`${ui("ui-counter")}/..%2Fcapability.json`, `${ui("ui-counter")}/..%2F..%2F..%2Fagents.json`, `${ui("ui-counter")}/%2e%2e/capability.json`]) {
      const r = await http("hewn.localhost", p);
      assert.notEqual(r.status, 200, p);
      assert.doesNotMatch(r.body, /"operations"/, p);
    }
  });

  test("capabilities without a UI cannot be opened", () => {
    assert.throws(() => t.platform.createUiTicket("running-log"), (e) => e instanceof PlatformError && e.code === "not_found");
  });

  test("ui.available without ui/index.html fails validation", async () => {
    const r = await t.build(
      () => t.platform.modify(t.claude, { capabilityId: "ui-counter", request: "drop ui" }),
      (ws) => rmSync(join(ws, "ui"), { recursive: true }),
    );
    assert.equal(r.status, "failed");
    assert.match(r.log.join("\n"), /ui\/index\.html is missing/);
  });
});
