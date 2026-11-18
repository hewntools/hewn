// SPDX-License-Identifier: AGPL-3.0-or-later
// Hosted: the owner's allowance as the host's builder states it (GET /v1/allowance, #75): read and kept, shown on
// Settings › AI and the Models page, and in the Inbox at 80% and once used up, its renewal in the owner's time zone.
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { type HostAllowance, saneAllowance } from "@hewntools/core/models.ts";
import { hostAllowance, remoteAllowance } from "@hewntools/cli/builders/models.ts";
import { writeConfig } from "@hewntools/cli/config.ts";
import { startServer } from "@hewntools/test-host/server.ts";
import { nodeSurfaceHost } from "@hewntools/test-host/surface.ts";
import { setup } from "./helpers.ts";

/** A GET as the web client makes it (Host hewn.localhost, the session cookie). */
const getFrom = (server: Server, path: string, cookie = "") =>
  new Promise<{ status: number; headers: Record<string, any>; body: string }>((res, rej) => {
    const port = (server.address() as AddressInfo).port;
    const r = request({ host: "127.0.0.1", port, path, headers: { host: `hewn.localhost:${port}`, "x-hewn-ui": "1", ...(cookie ? { cookie } : {}) } }, (m) => {
      let body = "";
      m.on("data", (d) => (body += d));
      m.on("end", () => res({ status: m.statusCode!, headers: m.headers, body }));
    });
    r.on("error", rej);
    r.end();
  });

const ANSWER = { allowance: { unit: "Credits", used: 2000, of: 2000, resetsAt: "2026-12-01T00:00:00Z", perBuild: 250, more: null, plan: "alpha" } };

describe("the allowance, as the host states it", () => {
  test("only what makes sense is kept: unknown fields dropped, more only if https, resetsAt an instant or null", () => {
    assert.deepEqual(saneAllowance(ANSWER), { unit: "Credits", used: 2000, of: 2000, resetsAt: "2026-12-01T00:00:00.000Z", perBuild: 250, more: null });
    assert.equal(saneAllowance({ allowance: { ...ANSWER.allowance, more: "http://example.com/more" } })!.more, null);
    assert.equal(saneAllowance({ allowance: { ...ANSWER.allowance, more: "https://example.com/more" } })!.more, "https://example.com/more");
    assert.deepEqual(saneAllowance({ allowance: { unit: "Credits", used: 12, of: null, resetsAt: null, perBuild: null, more: null } }), { unit: "Credits", used: 12, of: null, resetsAt: null, perBuild: null, more: null });
    assert.equal(saneAllowance({ allowance: { ...ANSWER.allowance, resetsAt: "soon" } })!.resetsAt, null);
    for (const bad of [{}, { allowance: { ...ANSWER.allowance, used: -1 } }, { allowance: { ...ANSWER.allowance, unit: "<b>x</b>" } }, { allowance: { ...ANSWER.allowance, used: "2000" } }, null]) assert.equal(saneAllowance(bad), undefined, JSON.stringify(bad));
  });

  test("read with the builder's token; a 404 is none; kept 10 minutes, fresh reads now; a failure keeps the last good answer", async () => {
    let status = 200;
    let body: unknown = ANSWER;
    const seen: { url: string; auth: string | null }[] = [];
    const fake = (async (url: URL, init: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init.headers).get("authorization") });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    assert.equal((await remoteAllowance("https://builds.example", "tok", fake))!.used, 2000);
    assert.deepEqual(seen.at(-1), { url: "https://builds.example/v1/allowance", auth: "Bearer tok" });
    status = 404;
    assert.equal(await remoteAllowance("https://builds.example/", "tok", fake), null);

    status = 200;
    const read = hostAllowance({ url: "https://builds.example", token: "tok" }, fake);
    assert.equal((await read())!.used, 2000);
    const n = seen.length;
    body = { allowance: { ...ANSWER.allowance, used: 10 } };
    assert.equal((await read())!.used, 2000, "kept");
    assert.equal(seen.length, n, "not asked again within 10 minutes");
    assert.equal((await read(true))!.used, 10, "fresh: asked now");
    status = 500;
    assert.equal((await read(true))!.used, 10, "a failure keeps the last good answer");
    body = { nonsense: true };
    status = 200;
    assert.equal((await read(true))!.used, 10, "so does an answer that doesn't make sense");
    status = 404;
    assert.equal(await read(true), null, "a 404 is none: today's view");
  });
});

describe("the allowance on the web client and in the Inbox (hosted)", () => {
  let t: ReturnType<typeof setup>;
  let server: Server;
  let cookie = "";
  let allowance: HostAllowance | null = null;
  let asked: boolean[] = [];
  const get = (path: string) => getFrom(server, path, cookie);
  const notice = async () => JSON.parse((await get("/api/inbox")).body).needs.find((n: { id: string }) => n.id === "allowance");
  before(async () => {
    t = setup({ hostModels: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 }, model: "m" }) });
    // An owner in New York: 00:00Z on 1 December is still 30 November there.
    writeConfig(t.home, { timeZone: "America/New_York" });
    server = await startServer(t.platform, 0, (port) => nodeSurfaceHost(t.home, { port, allowance: async (fresh) => (asked.push(!!fresh), allowance) }));
    cookie = String((await get(`/auth?ticket=${t.platform.createWebTicket(USER)}`)).headers["set-cookie"]).split(";")[0];
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    t.cleanup();
  });

  test("/api/models carries it, read now for the Models page; none (404) leaves today's view", async () => {
    allowance = { unit: "Credits", used: 1500, of: 2000, resetsAt: "2026-12-01T00:00:00.000Z", perBuild: 250, more: null };
    asked = [];
    assert.deepEqual(JSON.parse((await get("/api/models?fresh=1")).body).host.allowance, allowance);
    assert.deepEqual(JSON.parse((await get("/api/models")).body).host.allowance.used, 1500);
    assert.deepEqual(asked, [true, false]);
    allowance = null;
    const m = JSON.parse((await get("/api/models")).body);
    assert.equal(m.host.allowance, null);
    assert.ok(Array.isArray(m.host.charges.totals), "the charges as before");
  });

  test("the Inbox: nothing under 80%; at 80% a warning; used up, danger, saying when they renew in the owner's time zone", async () => {
    allowance = { unit: "Credits", used: 1500, of: 2000, resetsAt: "2026-12-01T00:00:00.000Z", perBuild: 250, more: null };
    assert.equal(await notice(), undefined);
    allowance = { ...allowance, used: 1700 };
    const warn = await notice();
    assert.deepEqual([warn.title, warn.detail, warn.severity, warn.kind], ["Credits", "85% of 2000 used · they renew on 30 Nov", "warn", "spend"]);
    allowance = { ...allowance, used: 2003 };
    const done = await notice();
    assert.deepEqual([done.detail, done.severity], ["all 2000 used: builds and tools that think wait until they renew on 30 Nov", "danger"]);
    allowance = { ...allowance, resetsAt: null };
    assert.equal((await notice()).detail, "all 2000 used");
    allowance = { ...allowance, of: null };
    assert.equal(await notice(), undefined, "unmetered: nothing to warn of");
  });
});

describe("self-hosted", () => {
  test("no allowance is asked for: the Models answer has no host part, and the Inbox nothing about one", async () => {
    const t = setup();
    let asked = 0;
    const server = await startServer(t.platform, 0, (port) => nodeSurfaceHost(t.home, { port, allowance: async () => (asked++, { unit: "Credits", used: 9, of: 10, resetsAt: null, perBuild: null, more: null }) }));
    try {
      const cookie = String((await getFrom(server, `/auth?ticket=${t.platform.createWebTicket(USER)}`)).headers["set-cookie"]).split(";")[0];
      assert.equal(JSON.parse((await getFrom(server, "/api/models?fresh=1", cookie)).body).host, null);
      assert.equal(JSON.parse((await getFrom(server, "/api/inbox", cookie)).body).needs.some((n: { id: string }) => n.id === "allowance"), false);
      assert.equal(asked, 0);
    } finally {
      await new Promise((r) => server.close(r));
      t.cleanup();
    }
  });
});
