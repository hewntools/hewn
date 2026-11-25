// SPDX-License-Identifier: AGPL-3.0-or-later
// Try it: a held build's screen on a copy of the owner's data. Writes stay in the copy, no schedule runs on it, and it
// goes when the owner decides or its hour is up (by the wall clock, also when the hour passed while Hewn was down).
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { TRY_MS, type TryOpened } from "@hewntools/core/platform/trying.ts";
import { idleStatus } from "@hewntools/cli/supervisor/idle.ts";
import { FIXTURES, installFrom, serve, setup } from "./helpers.ts";

/** Until `ok` holds (what ends on its own, a moment after the call that ends it). */
const until = async (ok: () => Promise<boolean> | boolean, what: string) => {
  for (let i = 0; i < 100; i++) if (await ok()) return;
  else await new Promise((r) => setTimeout(r, 10));
  assert.fail(what);
};

describe("Try it on a held build", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installFrom(t.platform, join(FIXTURES, "ui-counter"));
    await t.platform.invoke(USER, { capabilityId: "ui-counter", operation: "increment" });
  });
  afterEach(() => t.cleanup());

  /** An agent's change to the counter, held for the owner. */
  const held = async () => {
    t.queue((ws) => appendFileSync(join(ws, "src", "index.ts"), "\n// changed\n"));
    const b = await t.platform.settle((await t.platform.modify(t.claude, { capabilityId: "ui-counter", request: "a comment" })).buildId);
    assert.equal(b.status, "review", b.log.join("\n"));
    return b.buildId;
  };
  const count = async () => (await t.platform.invoke(USER, { capabilityId: "ui-counter", operation: "get" })).result as { count: number };
  const tries = async () => (await t.platform.runtime.listStates("ui-counter", "")).filter((s) => s.startsWith("try"));
  const open = async (id: string) => (await t.platform.tryBuild(USER, id)) as TryOpened;
  /** The open Try its' record, to move a clock or lose an entry as a crash would. */
  const record = () => t.platform.registry.getKv<Record<string, { endsAt: number; ready?: boolean }>>("try:open") ?? {};
  const setRecord = (r: Record<string, unknown>) => t.platform.registry.setKv("try:open", r);

  test("it runs the candidate on a copy of the owner's data: a write stays in the copy; only the owner opens it", async () => {
    const id = await held();
    await assert.rejects(t.platform.tryBuild(t.claude, id), (e: any) => e.code === "forbidden");
    const opened = await open(id);
    assert.ok(opened.ticket && opened.key && opened.endsAt > Date.now() + TRY_MS - 60_000);
    // The copy starts as the owner's data is: one tap.
    assert.deepEqual((await t.platform.tryInvoke(id, { operation: "get" })).result, await count());
    await t.platform.tryInvoke(id, { operation: "increment" });
    await t.platform.tryInvoke(id, { operation: "increment" });
    assert.equal(((await t.platform.tryInvoke(id, { operation: "get" })).result as { count: number }).count, (await count()).count + 2);
    assert.equal((await count()).count, 1, "the owner's own data is as it was");
    // Opened again: the same copy, a new ticket.
    const again = await open(id);
    assert.equal(again.key, opened.key);
    assert.equal(((await t.platform.tryInvoke(id, { operation: "get" })).result as { count: number }).count, 3);
  });

  test("a call in it is the owner's activity, and never a change a backup should keep", async () => {
    const id = await held();
    await t.platform.tryBuild(USER, id);
    const before = t.platform.idleActivity();
    await t.platform.tryInvoke(id, { operation: "increment" });
    const after = t.platform.idleActivity();
    assert.ok((after.lastCallAt ?? 0) >= Date.now() - 5000, "the call counts");
    assert.equal(after.changedAt, before.changedAt, "the copy's write isn't one to back up");
  });

  test("no schedule runs on the copy", async () => {
    const id = await held();
    await t.platform.tryBuild(USER, id);
    const s = t.platform.createSchedule(USER, { capabilityId: "ui-counter", operation: "increment", cadence: "daily 07:00" });
    await t.platform.runDueSchedules(Date.parse(s.nextRunAt as unknown as string) || (s.nextRunAt as number));
    assert.equal((await count()).count, 2, "it ran on the live tool");
    assert.equal(((await t.platform.tryInvoke(id, { operation: "get" })).result as { count: number }).count, 1, "not on the copy");
  });

  test("it goes when the owner decides: allowed, or not", async () => {
    for (const decide of ["approveBuild", "rejectBuild"] as const) {
      const id = await held();
      await t.platform.tryBuild(USER, id);
      assert.equal((await tries()).length, 1);
      await t.platform[decide](USER, id);
      assert.deepEqual(await tries(), [], `${decide}: the copy is gone`);
      assert.equal(await t.platform.tryKey(id), undefined);
      await assert.rejects(t.platform.tryInvoke(id, { operation: "get" }), (e: any) => e.code === "not_found");
    }
  });

  test("it goes after an hour by the wall clock, also when the hour passed while Hewn was down", async () => {
    const id = await held();
    await t.platform.tryBuild(USER, id);
    await t.platform.sweepTries(Date.now() + TRY_MS - 60_000);
    assert.equal((await tries()).length, 1, "within its hour");
    // Hewn starts again (or wakes) past the hour: the start's cleanup sweeps it before anything is served.
    await t.platform.cleanup(Date.now() + TRY_MS + 1);
    assert.deepEqual(await tries(), []);
    assert.equal(await t.platform.tryKey(id), undefined);
  });
  test("its page goes on with the open one and never makes a copy itself; two starts at once make one copy", async () => {
    const id = await held();
    assert.deepEqual(await t.platform.tryBuild(USER, id, { reopen: true }), { open: false });
    assert.deepEqual(await tries(), [], "a reload with none open makes none");
    const [a, b] = (await Promise.all([t.platform.tryBuild(USER, id), t.platform.tryBuild(USER, id)])) as TryOpened[];
    assert.equal(a.key, b.key, "two tabs: one Try it");
    assert.notEqual(a.ticket, b.ticket);
    assert.equal((await tries()).length, 1);
    await t.platform.tryInvoke(id, { operation: "increment" });
    const reopened = (await t.platform.tryBuild(USER, id, { reopen: true })) as TryOpened;
    assert.equal(reopened.key, a.key);
    assert.equal(((await t.platform.tryInvoke(id, { operation: "get" })).result as { count: number }).count, 2, "the same copy");
  });

  test("a copy that can't be made leaves nothing: no copy, no entry", async () => {
    const id = await held();
    const runtime = t.platform.runtime;
    const migrate = runtime.migrate;
    runtime.migrate = async () => {
      throw new Error("a migration failed on the owner's data");
    };
    try {
      await assert.rejects(t.platform.tryBuild(USER, id), /a migration failed/);
    } finally {
      runtime.migrate = migrate;
    }
    assert.deepEqual(await tries(), []);
    assert.deepEqual(record(), {});
    assert.ok((await open(id)).key, "and it can be opened again");
  });

  test("a stopped held build ends its Try it, and its address with it", async () => {
    const id = await held();
    await open(id);
    t.platform.cancelBuild(USER, id);
    await until(async () => (await tries()).length === 0, "the copy goes");
    assert.equal(await t.platform.tryKey(id), undefined);
    assert.equal(await t.platform.tryFile(id, "/"), undefined);
    assert.deepEqual(record(), {});
  });

  test("a copy that can't be dropped keeps its entry, ended, until a sweep drops it", async () => {
    const id = await held();
    await open(id);
    const runtime = t.platform.runtime;
    const drop = runtime.dropState;
    runtime.dropState = async () => {
      throw new Error("the tools are restarting");
    };
    try {
      await t.platform.rejectBuild(USER, id);
    } finally {
      runtime.dropState = drop;
    }
    assert.equal(await t.platform.tryKey(id), undefined, "ended for the owner at once");
    await t.platform.sweepTries();
    assert.deepEqual(await tries(), []);
    assert.deepEqual(record(), {});
    assert.equal(t.platform.nextTryEndAt(), null);
  });

  test("past its hour, it ends when it's next looked at, before anything is served", async () => {
    const id = await held();
    const opened = await open(id);
    assert.equal(t.platform.nextTryEndAt(), opened.endsAt, "the host's alarm covers its end");
    setRecord({ ...record(), [id]: { ...record()[id], endsAt: Date.now() - 1 } });
    assert.equal(await t.platform.tryKey(id), undefined);
    assert.deepEqual(await tries(), []);
    assert.equal(t.platform.nextTryEndAt(), null);
  });

  test("at start, a copy whose Try it is over goes (its entry lost, or past its hour); an open one stays", async () => {
    const id = await held();
    await open(id);
    await t.platform.recoverInterruptedBuilds();
    assert.equal((await tries()).length, 1, "open and within its hour: kept across a restart");
    setRecord({});
    await t.platform.recoverInterruptedBuilds();
    assert.deepEqual(await tries(), [], "a copy with no entry goes");
    await open(id);
    setRecord({ ...record(), [id]: { ...record()[id], ready: false } });
    await t.platform.recoverInterruptedBuilds();
    assert.deepEqual(await tries(), [], "a copy Hewn stopped making goes");
    assert.deepEqual(record(), {});
  });

  test("its code holding Hewn's tools ends the Try it and says so on the card; the tool isn't struck", async () => {
    const id = await held();
    await open(id);
    t.platform.registry.codeStarted({ capabilityId: "ui-counter", state: `try:${id}`, what: "increment@1", caller: "ui:try-it" });
    const out = t.platform.recoverStall(new Date().toISOString());
    assert.deepEqual(out, { tools: [], suspended: [], builds: [] });
    await until(async () => (await tries()).length === 0, "the copy goes");
    assert.match(t.platform.getBuild(USER, id).log.at(-1) ?? "", /^Try it: .*increment@1.*the Try it ended/);
    assert.equal(t.platform.registry.getKv("stalls:ui-counter"), undefined, "no strike on the tool");
    assert.equal(t.platform.getBuild(USER, id).status, "review", "the build still waits for the owner");
  });

  test("an open Try it with no call running lets the Hewn go idle", async () => {
    const id = await held();
    await open(id);
    await t.platform.tryInvoke(id, { operation: "increment" });
    const now = Date.now() + 11 * 60_000;
    assert.equal(idleStatus(t.platform.idleActivity(), { lastAt: now, backedUpToday: true }, { now, afterSeconds: 600 }).idle, true);
  });
});

describe("Try it's address", () => {
  let t: ReturnType<typeof setup>;
  let server: Server;
  let port: number;
  let cookie = "";
  beforeEach(async () => {
    t = setup();
    await installFrom(t.platform, join(FIXTURES, "ui-counter"));
    server = await serve(t.platform, t.home);
    port = (server.address() as AddressInfo).port;
    cookie = String((await http(`/auth?ticket=${t.platform.createWebTicket(USER)}`)).headers["set-cookie"]).split(";")[0];
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    t.cleanup();
  });

  const http = (path: string, o: { method?: string; headers?: Record<string, string>; body?: unknown; web?: boolean } = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((res, rej) => {
      const r = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: { host: `hewn.localhost:${port}`, ...(o.web && cookie ? { cookie } : {}), ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...o.headers } }, (m) => {
        let body = "";
        m.on("data", (d) => (body += d));
        m.on("end", () => res({ status: m.statusCode!, headers: m.headers, body }));
      });
      r.on("error", rej);
      r.end(o.body !== undefined ? JSON.stringify(o.body) : undefined);
    });
  const framed = { "sec-fetch-dest": "iframe" };
  const held = async () => {
    t.queue((ws) => appendFileSync(join(ws, "src", "index.ts"), "\n// changed\n"));
    const b = await t.platform.settle((await t.platform.modify(t.claude, { capabilityId: "ui-counter", request: "a comment" })).buildId);
    assert.equal(b.status, "review", b.log.join("\n"));
    return b.buildId;
  };
  /** Open it as the page does: the web client's POST, then the ticket in the frame. */
  const signIn = async (id: string) => {
    const r = await http(`/api/builds/${id}/try`, { method: "POST", web: true, headers: { "x-hewn-ui": "1" } });
    assert.equal(r.status, 200, r.body);
    const { ticket, key } = JSON.parse(r.body) as TryOpened;
    const auth = await http(`/try/${id}/auth?ticket=${ticket}`, { headers: framed });
    assert.equal(auth.status, 200, auth.body);
    return { key, session: /#hewn_session=([\w-]+)/.exec(auth.body)![1] };
  };
  const invoke = (id: string, key: string, session: string, headers: Record<string, string> = { "x-hewn-ui": "1" }) =>
    http(`/try/${id}/~${key}/api/invoke`, { method: "POST", headers: { authorization: `Hewn ${session}`, ...headers }, body: { operation: "get" } });

  test("every answer is sandboxed with no popups, errors and the ticket page included; only Hewn frames it", async () => {
    const id = await held();
    const { key } = await signIn(id);
    for (const [path, headers] of [[`/try/${id}/~${key}/`, framed], [`/try/${id}/~${key}/nope.html`, framed], [`/try/${id}/auth?ticket=bogus`, framed], [`/try/${id}/auth?ticket=bogus`, {}], [`/try/${id}/~wrongkeywrongkey12/`, framed], [`/try/${id}/~${key}/api/manifest`, {}], [`/try/${id}/~${key}`, {}]] as const) {
      const csp = String((await http(path, { headers })).headers["content-security-policy"]);
      assert.match(csp, /^sandbox allow-scripts /, path);
      assert.doesNotMatch(csp, /allow-popups|allow-same-origin/, path);
      assert.match(csp, new RegExp(`frame-ancestors http://hewn\\.localhost:${port};`), path);
    }
  });

  test("its pages open only in a frame: the ticket page and its HTML refused as a page of their own", async () => {
    const id = await held();
    const { key } = await signIn(id);
    assert.equal((await http(`/try/${id}/~${key}/`)).status, 403);
    assert.equal((await http(`/try/${id}/~${key}/`, { headers: { "sec-fetch-dest": "document" } })).status, 403);
    assert.equal((await http(`/try/${id}/~${key}/`, { headers: framed })).status, 200);
    const { ticket } = JSON.parse((await http(`/api/builds/${id}/try`, { method: "POST", web: true, headers: { "x-hewn-ui": "1" } })).body) as TryOpened;
    assert.equal((await http(`/try/${id}/auth?ticket=${ticket}`)).status, 403);
    assert.equal((await http(`/try/${id}/auth?ticket=${ticket}`, { headers: framed })).status, 200, "the ticket wasn't used up by the refusal");
  });

  test("its API: its own session only (not the live tool's), the header, no foreign origin; a wrong key is nothing", async () => {
    const id = await held();
    const { key, session } = await signIn(id);
    assert.equal((await invoke(id, key, session)).status, 200);
    assert.equal((await invoke(id, key, session, {})).status, 403, "no X-Hewn-UI");
    assert.equal((await invoke(id, key, session, { "x-hewn-ui": "1", origin: "https://evil.example" })).status, 403);
    assert.equal((await invoke(id, "wrongkeywrongkey12", session)).status, 404);
    const live = t.platform.redeemUiTicket(t.platform.createUiTicket("ui-counter"), "ui-counter")!;
    assert.equal((await invoke(id, key, live)).status, 401, "the live tool's session doesn't open a Try it");
    assert.equal((await http(`/tools/ui-counter/~${t.platform.uiKey("ui-counter")}/api/invoke`, { method: "POST", headers: { authorization: `Hewn ${session}`, "x-hewn-ui": "1" }, body: { operation: "get" } })).status, 401, "nor a Try it's the live tool");
  });

  test("ended: nothing at its address answers (its key is gone), and it can't be opened again", async () => {
    const id = await held();
    const { key, session } = await signIn(id);
    await t.platform.rejectBuild(USER, id);
    assert.equal((await http(`/try/${id}/~${key}/`, { headers: framed })).status, 404);
    assert.equal((await invoke(id, key, session)).status, 404);
    assert.equal((await http(`/try/${id}/auth?ticket=x`, { headers: framed })).status, 401);
    assert.equal((await http(`/api/builds/${id}/try`, { method: "POST", web: true, headers: { "x-hewn-ui": "1" } })).status, 409);
  });

  test("opening it and its calls are the owner's activity, never a change a backup should keep", async () => {
    const id = await held();
    const before = t.platform.idleActivity();
    await new Promise((r) => setTimeout(r, 5));
    const { key, session } = await signIn(id);
    const r = await http(`/try/${id}/~${key}/api/invoke`, { method: "POST", headers: { authorization: `Hewn ${session}`, "x-hewn-ui": "1" }, body: { operation: "increment" } });
    assert.equal(r.status, 200, r.body);
    const after = t.platform.idleActivity();
    assert.ok(after.lastRequestAt! > (before.lastRequestAt ?? 0), "the owner's request counts");
    assert.ok(after.lastCallAt! > (before.lastCallAt ?? 0), "the call counts");
    assert.equal(after.changedAt, before.changedAt, "neither is a change");
  });
});
