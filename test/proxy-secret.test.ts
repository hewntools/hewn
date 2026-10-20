// SPDX-License-Identifier: AGPL-3.0-or-later
// HEWN_PROXY_SECRET: a host whose public listener is reachable directly as well as through its own
// proxy takes public requests only from that proxy.
import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, describe, test } from "node:test";
import { CLIENT_IP_HEADER, gatePublic, PROXY_SECRET_HEADER, PUBLIC_HEADER, RateLimiter } from "@hewntools/host-workerd/surface/public.ts";
import { startTestHost, type TestHost } from "./workerd-helpers.ts";

const SECRET = "s3cret-from-the-router";

describe("the public gate with a proxy secret", () => {
  const req = (headers: Record<string, string> = {}) => new Request("http://127.0.0.1:7718/mcp", { method: "POST", headers, body: "{}" });
  const gate = (r: Request, secret?: string) => {
    const logs: string[] = [];
    return { out: gatePublic(r, new RateLimiter(), (l) => void logs.push(l), secret), logs };
  };

  test("unset or empty: unchanged, and a stray secret header is still removed", () => {
    for (const secret of [undefined, ""]) {
      const { out } = gate(req({ "x-forwarded-for": "203.0.113.5", [PROXY_SECRET_HEADER]: "whatever" }), secret);
      assert.ok(out instanceof Request);
      assert.equal(out.headers.get(PUBLIC_HEADER), "1");
      assert.equal(out.headers.get(CLIENT_IP_HEADER), "203.0.113.5");
      assert.equal(out.headers.has(PROXY_SECRET_HEADER), false);
    }
  });

  test("set, with the right header: passes, the header is gone, X-Forwarded-* honoured", () => {
    const { out } = gate(req({ [PROXY_SECRET_HEADER]: SECRET, "x-forwarded-for": "198.51.100.1, 203.0.113.5", "x-forwarded-host": "alice.example.net" }), SECRET);
    assert.ok(out instanceof Request);
    assert.equal(out.headers.has(PROXY_SECRET_HEADER), false);
    assert.equal(out.headers.get(CLIENT_IP_HEADER), "203.0.113.5");
    assert.equal(out.headers.get("x-forwarded-host"), "alice.example.net");
  });

  test("set, header missing or wrong: 403, logged without the secret or the claimed address", async () => {
    for (const given of [undefined, "", "nope", SECRET.slice(0, -1), `${SECRET}x`, SECRET.toUpperCase()]) {
      const { out, logs } = gate(req({ "x-forwarded-for": "203.0.113.5", ...(given === undefined ? {} : { [PROXY_SECRET_HEADER]: given }) }), SECRET);
      assert.ok(out instanceof Response, String(given));
      assert.equal(out.status, 403);
      assert.equal((await out.json()).error, "forbidden");
      assert.equal(logs.length, 1);
      assert.match(logs[0], /^\[public\] .* -> 403/);
      assert.doesNotMatch(logs[0], /s3cret|203\.0\.113\.5/);
    }
  });

  test("refused before the rate limit: direct traffic doesn't use up the proxy's budget", () => {
    const limiter = new RateLimiter({ mcp: { perClient: 1, total: 1, windowMs: 60_000 } } as any);
    for (let i = 0; i < 3; i++) assert.equal((gatePublic(req(), limiter, () => {}, SECRET) as Response).status, 403);
    assert.ok(gatePublic(req({ [PROXY_SECRET_HEADER]: SECRET }), limiter, () => {}, SECRET) instanceof Request);
  });
});

describe("workerd: the public socket with HEWN_PROXY_SECRET", () => {
  let h: TestHost;
  before(async () => {
    h = await startTestHost({ proxySecret: SECRET });
  });
  after(() => h.stop());
  /** With a real Host header (fetch won't send one). */
  const status = (path: string, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const u = new URL(`${h.sv.publicUrl}${path}`);
      request({ host: u.hostname, port: u.port, path, headers }, (res) => (res.resume(), resolve(res.statusCode!))).on("error", reject).end();
    });

  test("X-Forwarded-Host counts only with the secret; without it, 403", async () => {
    const meta = "/.well-known/oauth-authorization-server";
    const withSecret = await fetch(`${h.sv.publicUrl}${meta}`, { headers: { "x-forwarded-host": "alice.example.net", [PROXY_SECRET_HEADER]: SECRET } });
    assert.equal(withSecret.status, 200);
    assert.equal((await withSecret.json()).issuer, "https://alice.example.net");
    for (const headers of [{ "x-forwarded-host": "alice.example.net" }, { "x-forwarded-host": "alice.example.net", [PROXY_SECRET_HEADER]: "wrong" }] as Record<string, string>[]) {
      const res = await fetch(`${h.sv.publicUrl}${meta}`, { headers });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, "forbidden");
    }
    const mcp = await fetch(`${h.sv.publicUrl}/mcp`, { method: "POST", headers: { [PROXY_SECRET_HEADER]: SECRET, "x-forwarded-host": "alice.example.net" }, body: "{}" });
    assert.equal(mcp.status, 401);
    assert.match(mcp.headers.get("www-authenticate")!, /https:\/\/alice\.hewn\.tools\//);
  });

  test("the web client on the public URL's host: only through the proxy", async () => {
    await h.sv.admin("call", { method: "setPublicUrl", args: ["https://alice.example.net"] });
    try {
      assert.equal(await status("/", { host: "alice.example.net", [PROXY_SECRET_HEADER]: SECRET }), 401, "the sign-in page");
      assert.equal(await status("/", { host: "alice.example.net" }), 403);
      assert.equal(await status("/", { host: "hewn-alice.internal.example", "x-forwarded-host": "alice.example.net" }), 403, "a spoofed X-Forwarded-Host goes nowhere");
    } finally {
      await h.sv.admin("call", { method: "setPublicUrl", args: [null] });
    }
  });

  test("the local socket is not affected", async () => {
    assert.equal((await fetch(`${h.sv.url}/health`)).status, 200);
    assert.equal((await fetch(`${h.sv.url}/.well-known/oauth-authorization-server`)).status, 200);
  });
});
