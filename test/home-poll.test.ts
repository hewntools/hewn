// SPDX-License-Identifier: AGPL-3.0-or-later
// Home asks for the tool list every few seconds while it's open: an answer reads no icon and no build log, and an
// unchanged list is a 304 the browser answers from its own cache.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { installSeed, serve, setup } from "./helpers.ts";

describe("Home's tool list, as an open Home polls it", () => {
  let t: ReturnType<typeof setup>;
  let server: Server;
  let port: number;
  let cookie = "";
  const http = (path: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((res, rej) => {
      const r = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: { host: `hewn.localhost:${port}`, ...(cookie ? { cookie } : {}), "x-hewn-ui": "1", ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...o.headers } }, (m) => {
        let body = "";
        m.on("data", (d) => (body += d));
        m.on("end", () => res({ status: m.statusCode!, headers: m.headers, body }));
      });
      r.on("error", rej);
      r.end(o.body !== undefined ? JSON.stringify(o.body) : undefined);
    });
  const poll = (headers: Record<string, string> = {}) => http("/api/capabilities", { headers: { "x-hewn-refresh": "1", ...headers } });

  before(async () => {
    t = setup();
    await installSeed(t.platform);
    // The owner's own icon (an image, kept as a blob), and a change whose build failed.
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    await t.platform.setIcon(USER, "running-log", { type: "image/png", data: Buffer.from(png, "base64") });
    t.queue((ws) => writeFileSync(join(ws, "tests/cases.json"), JSON.stringify([{ name: "never", operation: "get_summary", input: {}, expect: { runCount: 99 } }])));
    const failed = await t.platform.settle((await t.platform.modify(USER, { capabilityId: "running-log", request: "Break it" })).buildId);
    assert.equal(failed.status, "failed", failed.log.join("\n"));
    server = await serve(t.platform, t.home);
    port = (server.address() as AddressInfo).port;
    const r = await http(`/auth?ticket=${t.platform.createWebTicket(USER)}`);
    cookie = String(r.headers["set-cookie"]).split(";")[0];
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    t.cleanup();
  });

  test("a burst of polls reads no icon and parses no build log after the first", async () => {
    const first = await poll();
    assert.equal(first.status, 200);
    const rl = JSON.parse(first.body).find((c: { id: string }) => c.id === "running-log");
    assert.equal(rl.iconKind, "image");
    assert.equal(rl.lastBuild.status, "failed");
    const blobs: string[] = [];
    const logs: string[] = [];
    const { blobs: store, registry } = t.platform;
    const get = store.get.bind(store);
    const getBuild = registry.getBuild.bind(registry);
    store.get = (key) => (blobs.push(key), get(key));
    registry.getBuild = (id) => (logs.push(id), getBuild(id));
    try {
      for (let i = 0; i < 20; i++) assert.equal((await poll()).status, 200);
    } finally {
      store.get = get;
      registry.getBuild = getBuild;
    }
    assert.deepEqual(blobs.filter((k) => k.startsWith("icons/")), [], "no icon read");
    assert.deepEqual(logs, [], "no build read for its log");
    // The page's own icon request still has it.
    assert.equal((await http("/api/capabilities/running-log/icon")).headers["content-type"], "image/png");
  });

  test("an unchanged list is a 304 with no body; a change is a new list", async () => {
    const a = await poll();
    const etag = String(a.headers.etag);
    assert.match(etag, /^"[0-9a-f]{32}"$/);
    assert.equal(a.headers["cache-control"], "private, no-cache");
    const same = await poll({ "if-none-match": etag });
    assert.equal(same.status, 304);
    assert.equal(same.body, "");
    assert.equal((await http("/api/capabilities/running-log/icon", { method: "PUT", body: { hue: 120 } })).status, 200);
    const changed = await poll({ "if-none-match": etag });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.etag, etag);
    assert.equal(JSON.parse(changed.body).find((c: { id: string }) => c.id === "running-log").hue, 120);
  });

  test("the icon's kind comes from what icon() would serve: an owner's image, a builder's glyph, or none", async () => {
    assert.equal(await t.platform.iconKind("running-log"), "image");
    await t.platform.setIcon(USER, "running-log", null);
    assert.equal(await t.platform.iconKind("running-log"), null, "the seed ships no ui/icon.svg");
    assert.equal((await t.platform.icon("running-log")) ?? null, null);
  });
});
