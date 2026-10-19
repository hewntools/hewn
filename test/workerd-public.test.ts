// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { after, before, describe, test } from "node:test";
import { startTestHost, type TestHost } from "./workerd-helpers.ts";

/** The workerd socket a tunnel points at: the Public entrypoint in front of the owner's DO. */
describe("workerd: the public socket", () => {
  let h: TestHost;
  before(async () => {
    h = await startTestHost();
  });
  after(() => h.stop());
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${h.sv.publicUrl}${path}`, { headers, redirect: "manual" });
  /** With a real Host header (fetch won't send one), as a tunnel forwards it. */
  const status = (path: string, host: string) =>
    new Promise<number>((resolve, reject) => {
      const u = new URL(`${h.sv.publicUrl}${path}`);
      request({ host: u.hostname, port: u.port, path, headers: { host } }, (res) => (res.resume(), resolve(res.statusCode!))).on("error", reject).end();
    });

  test("only MCP and OAuth answer there", async () => {
    for (const path of ["/", "/api/capabilities", "/_admin/status", "/health", "/app.js", "/auth?ticket=x"]) {
      assert.equal((await get(path)).status, 404, path);
      assert.equal(await status(path, "hewn.localhost"), 404, `${path} as hewn.localhost`);
      assert.equal(await status(path, "running-log.localhost"), 404, `${path} as a capability UI`);
    }
    const as = await (await get("/.well-known/oauth-authorization-server", { "x-forwarded-host": "hewn.example.com" })).json();
    assert.equal(as.issuer, "https://hewn.example.com");
    assert.equal(await status("/.well-known/oauth-authorization-server", "hewn.localhost"), 200, "the public paths answer whatever the host");
    const mcp = await fetch(`${h.sv.publicUrl}/mcp`, { method: "POST", headers: { "x-forwarded-host": "hewn.example.com" }, body: "{}" });
    assert.equal(mcp.status, 401);
    assert.match(mcp.headers.get("www-authenticate")!, /https:\/\/hewn\.example\.com\//);
  });

  test("with a public URL: the web client on its host, sign-in by link, admin still never", async () => {
    await h.sv.admin("call", { method: "setPublicUrl", args: ["https://hewn.example.com"] });
    try {
      assert.equal(await status("/", "hewn.example.com"), 401, "the sign-in page");
      assert.equal(await status("/passkey.js", "hewn.example.com"), 200);
      assert.equal(await status("/", "other.example.net"), 404, "other hosts: MCP and OAuth only");
      assert.equal(await status("/_admin/status", "hewn.example.com"), 404);
      const { result: ticket } = await h.sv.admin("call", { method: "createWebTicket", args: [] });
      const signedIn = await new Promise<{ status: number; cookie: string }>((resolve, reject) => {
        const u = new URL(h.sv.publicUrl);
        request({ host: u.hostname, port: u.port, path: `/auth?ticket=${ticket}`, headers: { host: "hewn.example.com" } }, (res) => (res.resume(), resolve({ status: res.statusCode!, cookie: String(res.headers["set-cookie"]) }))).on("error", reject).end();
      });
      assert.equal(signedIn.status, 200);
      assert.match(signedIn.cookie, /^__Host-hewn_web=.*; Secure;/);
    } finally {
      await h.sv.admin("call", { method: "setPublicUrl", args: [null] });
    }
  });

  test("the local socket is unchanged (web client, health)", async () => {
    assert.equal((await fetch(`${h.sv.url}/health`)).status, 200);
  });

  test("registration is rate limited per client address", async () => {
    const reg = (ip: string) =>
      fetch(`${h.sv.publicUrl}/register`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250)}, ${ip}` }, body: JSON.stringify({ client_name: "x", redirect_uris: ["https://a.example/cb"] }) });
    for (let i = 0; i < 10; i++) assert.equal((await reg("192.0.2.7")).status, 201);
    const r = await reg("192.0.2.7");
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get("retry-after")) > 0);
    assert.equal((await reg("192.0.2.8")).status, 201);
    const spoofed = await fetch(`${h.sv.publicUrl}/register`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.1", "x-forwarded-for": "192.0.2.7" }, body: JSON.stringify({ client_name: "x", redirect_uris: ["https://a.example/cb"] }) });
    assert.equal(spoofed.status, 429, "the last hop counts: a client-set CF-Connecting-IP or earlier hop doesn't dodge the limit");
  });
});

/** hewn url --listen: the public socket on the network too, for a reverse proxy on another machine. */
const lan = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

/** Can this process connect to its own network address at all? */
async function reachable(address: string): Promise<boolean> {
  const server = createServer((_, res) => res.end("ok"));
  await new Promise<void>((r) => server.listen(0, address, r));
  try {
    return (await fetch(`http://${address}:${(server.address() as AddressInfo).port}/`)).ok;
  } catch {
    return false;
  } finally {
    server.close();
  }
}

describe("workerd: the public socket on the network (publicListen)", { skip: lan ? false : "no non-loopback IPv4 address here" }, () => {
  let h: TestHost;
  before(async () => {
    h = await startTestHost({ publicListen: lan });
  });
  after(() => h.stop());

  test("the public socket answers on the address; admin is still refused; the local listener stays on loopback", async (t) => {
    if (!(await reachable(lan!))) return t.skip(`connections to ${lan} are blocked here (a sandbox or firewall)`);
    const publicPort = new URL(h.sv.publicUrl).port;
    assert.equal(h.sv.publicNetwork, `http://${lan}:${publicPort}`);
    assert.equal((await fetch(`http://${lan}:${publicPort}/.well-known/oauth-authorization-server`)).status, 200);
    assert.equal((await fetch(`http://${lan}:${publicPort}/_admin/status`)).status, 404);
    assert.equal((await fetch(`${h.sv.publicUrl}/.well-known/oauth-authorization-server`)).status, 200, "loopback too, for a tunnel");
    await assert.rejects(fetch(`http://${lan}:${h.port}/health`), "the local listener (web client, admin) is not on the network");
  });
});
