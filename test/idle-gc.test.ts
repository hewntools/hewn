// SPDX-License-Identifier: AGPL-3.0-or-later
// The idle GC: workerd never gives V8 idle time, so the platform collects once on the supervisor's tick after a quiet
// spell. Only the platform's process has gc(); the tick and the supervisor's own reads aren't activity.
import assert from "node:assert/strict";
import { request } from "node:http";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { config as platformConfig, toolsConfig } from "@hewntools/cli/supervisor/index.ts";
import { STORAGE_KEYS } from "@hewntools/cli/supervisor/format.ts";
import { IdleGc, tickCall } from "@hewntools/host-workerd/idle-gc.ts";
import { FIXTURES } from "./helpers.ts";
import { startTestHost, type TestHost } from "./workerd-helpers.ts";

describe("when the platform collects", () => {
  const gcs: object[] = [];
  const gc = (o: object) => void gcs.push(o);

  test("once after activity and a quiet spell; not while something runs, and not again until something new ran", () => {
    const idle = new IdleGc(gc);
    assert.deepEqual(idle.run({ lastActiveAt: 10_000, busy: false }, 30_000, 20_000), { ran: false, why: "recent", runs: 0 });
    assert.deepEqual(idle.run({ lastActiveAt: 10_000, busy: true }, 30_000, 50_000), { ran: false, why: "busy", runs: 0 });
    const ran = idle.run({ lastActiveAt: 10_000, busy: false }, 30_000, 40_000);
    assert.equal(ran.ran, true);
    assert.deepEqual(gcs, [{ type: "major", execution: "sync", flavor: "last-resort" }], "a last-resort GC: a plain major one gives back far less");
    assert.deepEqual(idle.run({ lastActiveAt: 10_000, busy: false }, 30_000, 90_000), { ran: false, why: "nothing new", runs: 1 });
    assert.equal(idle.run({ lastActiveAt: 95_000, busy: false }, 30_000, 125_000).ran, true);
    assert.equal(gcs.length, 2);
  });

  test("without gc() (a process started without --expose-gc), it says so and does nothing", () => {
    assert.deepEqual(new IdleGc(undefined).run({ lastActiveAt: 0, busy: false }, 0, 1), { ran: false, why: "no gc", runs: 0 });
  });

  test("the supervisor's own ticks and reads aren't activity; what the CLI does is", () => {
    for (const [path, body] of [["/_admin/idle-gc", {}], ["/_admin/disk", { low: false }], ["/_admin/call", { method: "idleActivity" }], ["/_admin/call", { method: "metrics" }], ["/_admin/call", { method: "nextScheduleAt" }]] as const) assert.ok(tickCall(path, body), `${path} ${JSON.stringify(body)}`);
    for (const [path, body] of [["/_admin/invoke", {}], ["/_admin/install", {}], ["/_admin/call", { method: "list" }], ["/_admin/resumed", {}]] as const) assert.ok(!tickCall(path, body), `${path} ${JSON.stringify(body)}`);
  });

  test("gc() is in the platform's process only: never the tools'", () => {
    const channel = { tools: "unix:/h/run/tools.sock", calls: "unix:/h/run/calls.sock" };
    const platform = platformConfig({ dir: "/h", keys: STORAGE_KEYS, port: 7000, publicPort: 7001, supervisorPort: 1, data: "/h", assets: { web: "/w", ui: "/u", docs: "/d", spec: "/s" }, channel });
    assert.match(platform, /^\s*v8Flags = \["--expose-gc"\],$/m);
    const tools = toolsConfig({ keys: STORAGE_KEYS, data: "/h", channel });
    assert.ok(!/v8Flags|expose-gc/.test(tools), tools);
  });
});

/** A GET on the web API as the signed-in owner; `refresh`: as a page's own poll (Home's), which the idle report ignores. */
async function owner(h: TestHost) {
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, any>; body: string }>((ok, fail) => {
      const r = request({ host: "127.0.0.1", port: h.port, path, headers: { host: `hewn.localhost:${h.port}`, "x-hewn-ui": "1", ...headers } }, (m) => {
        let body = "";
        m.on("data", (d) => (body += d));
        m.on("end", () => ok({ status: m.statusCode!, headers: m.headers, body }));
      });
      r.on("error", fail);
      r.end();
    });
  const { ticket } = await h.sv.admin("web-ticket");
  const cookie = String((await get(`/auth?ticket=${ticket}`)).headers["set-cookie"]).split(";")[0];
  return async (path: string, o: { refresh?: boolean } = {}) => {
    const r = await get(path, { cookie, ...(o.refresh ? { "x-hewn-refresh": "1" } : {}) });
    assert.equal(r.status, 200, `${path}: ${r.body}`);
  };
}

describe("the idle GC on the real host", () => {
  let h: TestHost;
  before(async () => {
    // No tick: the test asks itself, with its own quiet time (0: collect now if anything ran since the last).
    h = await startTestHost({ idleGc: false });
    const r = await h.sv.admin("install", { name: "Runaway", purpose: "runs", dir: join(FIXTURES, "runaway"), wait: true });
    assert.equal(r.status, "promoted", r.log?.join("\n"));
  });
  after(() => h?.stop());
  const ask = (quietMs: number) => h.sv.admin("idle-gc", { quietMs });
  const report = async () => (await h.sv.admin("call", { method: "idleActivity" })).result;

  test("collects after a request once it's quiet, once; the tick's own call, the health check and the supervisor's reads don't count", async () => {
    const get = await owner(h);
    await ask(0);
    await get("/api/capabilities");
    assert.equal((await ask(60_000)).why, "recent");
    const first = await ask(0);
    assert.equal(first.ran, true, JSON.stringify(first));
    assert.equal(typeof first.ms, "number");
    const before = await report();
    await fetch(`${h.sv.url}/health`);
    await h.sv.admin("call", { method: "metrics" });
    await h.sv.admin("call", { method: "nextScheduleAt" });
    await h.sv.admin("disk", { low: false, free: 1, floor: 0 });
    await h.sv.status();
    assert.deepEqual(await ask(0), { ran: false, why: "nothing new", runs: first.runs });
    // Nor does it touch the idle report: no request, and nothing for a backup.
    const later = await report();
    assert.equal(later.lastRequestAt, before.lastRequestAt);
    assert.equal(later.changedAt, before.changedAt);
  });

  test("Home's polls count, though the idle report ignores them: they're what grows the heap", async () => {
    const get = await owner(h);
    await ask(0);
    const { lastRequestAt } = await report();
    await get("/api/capabilities", { refresh: true });
    assert.equal((await report()).lastRequestAt, lastRequestAt);
    assert.equal((await ask(0)).ran, true);
  });

  test("not while a tool call runs", async () => {
    await ask(0);
    const call = h.invoke("runaway", "slow", { ms: 1500 });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await ask(0)).why, "busy");
    await call;
    assert.equal((await ask(0)).ran, true);
  });
});

describe("the supervisor's tick", () => {
  let h: TestHost;
  before(async () => {
    h = await startTestHost({ idleGc: { intervalMs: 100, quietMs: 400 } });
  });
  after(() => h?.stop());
  // Never collects itself (its quiet time never passes); says how many the tick has run.
  const runs = async () => (await h.sv.admin("idle-gc", { quietMs: 1e12 })).runs as number;
  const until = async (n: number) => {
    for (let i = 0; i < 100 && (await runs()) < n; i++) await new Promise((r) => setTimeout(r, 100));
    return runs();
  };

  test("collects once after a quiet spell, then waits for something new", async () => {
    const get = await owner(h);
    assert.ok((await until(1)) >= 1, "the start's work is collected");
    // The sign-in's own collection, if the first came before it.
    await new Promise((r) => setTimeout(r, 1000));
    const n = await runs();
    await get("/api/capabilities");
    assert.equal(await until(n + 1), n + 1);
    // Ten more quiet ticks: none of them is activity.
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(await runs(), n + 1);
  });
});
