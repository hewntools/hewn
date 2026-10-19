// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER, WEB_USER } from "@hewntools/core/auth.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import { editJson, editText, FIXTURES, installFrom, installSeed, serve, setup } from "./helpers.ts";

const code = (c: string) => (e: unknown) => e instanceof PlatformError && e.code === c;

/** A change that adds `dump_runs@1` (every row: what an agent with modify could ask for). */
function addDump(ws: string) {
  editJson(join(ws, "capability.json"), (m) => {
    const list = m.operations.find((o: any) => o.name === "list_runs");
    m.operations.push({ ...structuredClone(list), name: "dump_runs", description: "Every run" });
  });
  editText(join(ws, "src", "index.ts"), (s) => s.replace('  "list_runs@1"', '  "dump_runs@1"(input: Range, ctx: Ctx) {\n    return operations["list_runs@1"](input, ctx);\n  },\n\n  "list_runs@1"'));
  editJson(join(ws, "tests", "cases.json"), (c) => c.push({ name: "dump", operation: "dump_runs", input: {}, expect: { runs: "$any" } }));
}
/** A change that adds nothing: a clearer description. */
const reword = (ws: string) => editJson(join(ws, "capability.json"), (m) => (m.purpose = `${m.purpose} (reworded)`));

describe("agents' changes wait for the owner's review", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());
  const modify = async (agent: typeof t.claude, edit: (ws: string) => void) => {
    t.queue(edit);
    return t.platform.settle((await t.platform.modify(agent, { capabilityId: "running-log", request: "change" })).buildId);
  };
  const active = () => t.platform.registry.getCapability("running-log")!.activeVersion;

  test("an agent's change that adds an operation waits; nothing changes until the owner approves", async () => {
    const before = active();
    const b = await modify(t.claude, addDump);
    assert.equal(b.status, "review", b.log.join("\n"));
    assert.deepEqual(b.review!.newOperations.map((o) => [o.key, o.sideEffect]), [["dump_runs@1", "read"]]);
    assert.equal(b.review!.connection, false);
    const op = b.review!.newOperations[0];
    assert.deepEqual(op.inputs, ["from", "to"].filter((k) => op.inputs!.includes(k)), "its input fields");
    assert.match(op.example ?? "", /"runs"/, "what it returned in its test");
    assert.deepEqual(b.review!.changes, { ui: false, migrations: [], newGrants: [], changedOperations: [], removedOperations: [] }, "nothing else changes");
    assert.match(b.instructions!, /owner's review/);
    assert.equal(active(), before, "not live");
    await assert.rejects(t.platform.invoke(t.claude, { capabilityId: "running-log", operation: "dump_runs" }), code("not_found"));
    assert.throws(() => t.platform.buildsInReview(t.claude), code("forbidden"));
    await assert.rejects(t.platform.approveBuild(t.claude, b.buildId), code("forbidden"), "an agent can't approve");
    assert.deepEqual(t.platform.buildsInReview(USER).map((x) => x.buildId), [b.buildId]);

    const done = await t.platform.approveBuild(WEB_USER, b.buildId);
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.equal(active(), before! + 1);
    await t.platform.invoke(t.claude, { capabilityId: "running-log", operation: "dump_runs" });
    assert.ok(t.platform.registry.authorityEvents().some((e) => e.action === "build_approved" && e.subject === "claude-code" && e.detail === b.buildId));
    assert.deepEqual(t.platform.buildsInReview(USER), []);
  });

  test("rejected: nothing changes, the candidate is gone, the agent sees it was turned down", async () => {
    const before = active();
    const b = await modify(t.claude, addDump);
    const blob = `versions/${b.review!.contentHash}.json`;
    assert.ok(await t.platform.blobs.get(blob));
    const r = await t.platform.rejectBuild(WEB_USER, b.buildId);
    assert.equal(r.status, "cancelled");
    assert.match(r.log.at(-1)!, /REJECTED by web/);
    assert.equal(t.platform.getBuild(t.claude, b.buildId).status, "cancelled");
    assert.equal(active(), before);
    assert.equal(await t.platform.blobs.get(blob), undefined);
    await assert.rejects(t.platform.approveBuild(USER, b.buildId), code("conflict"));
  });

  test("the owner's own changes, and agents' changes that add nothing, go live as before", async () => {
    t.queue(addDump);
    const own = await t.platform.settle((await t.platform.modify(WEB_USER, { capabilityId: "running-log", request: "dump" })).buildId);
    assert.equal(own.status, "promoted", own.log.join("\n"));
    const agents = await modify(t.claude, reword);
    assert.equal(agents.status, "promoted", agents.log.join("\n"));
  });

  test("approving after the capability moved on fails the build; retrying builds on the new version", async () => {
    const b = await modify(t.claude, addDump);
    t.queue(reword);
    await t.platform.settle((await t.platform.modify(WEB_USER, { capabilityId: "running-log", request: "reword" })).buildId);
    const r = await t.platform.approveBuild(USER, b.buildId);
    assert.equal(r.status, "failed");
    assert.match(r.log.at(-1)!, /changed since this build was checked/);
  });

  test("the agent can cancel its own change while it waits", async () => {
    const b = await modify(t.claude, addDump);
    assert.equal(t.platform.cancelBuild(t.claude, b.buildId).status, "cancelled");
  });
});

describe("a connection: any agent change waits", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installFrom(t.platform, join(FIXTURES, "secret-echo"));
  });
  afterEach(() => t.cleanup());

  test("even one that adds no operation", async () => {
    t.queue(reword);
    const b = await t.platform.settle((await t.platform.modify(t.claude, { capabilityId: "secret-echo", request: "reword" })).buildId);
    assert.equal(b.status, "review", b.log.join("\n"));
    assert.deepEqual([b.review!.connection, b.review!.newOperations], [true, []]);
  });
});

describe("grants follow the active version", () => {
  let t: ReturnType<typeof setup>;
  const dirs: string[] = [];
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
    const dir = mkdtempSync(join(tmpdir(), "hewn-feeder-"));
    dirs.push(dir);
    cpSync(join(FIXTURES, "run-feeder"), dir, { recursive: true });
    await installFrom(t.platform, dir);
    t.platform.approveGrants(USER, "run-feeder");
  });
  afterEach(() => {
    t.cleanup();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const feederGrants = () => [...t.platform.registry.grants("run-feeder")].sort();

  test("a grant the new version stops asking for is dropped; asking again means asking the owner", async () => {
    assert.deepEqual(feederGrants(), ["capability:running-log/list_runs@1", "capability:running-log/record_run@1"]);
    const narrow = await t.build(
      () => t.platform.modify(WEB_USER, { capabilityId: "run-feeder", request: "list only" }),
      (ws) => {
        editJson(join(ws, "capability.json"), (m) => (m.requires.capabilities[0].operations = ["list_runs@1"]));
        writeFileSync(join(ws, "src", "index.ts"), 'export const operations = { async "feed@1"(_: unknown, ctx: any) { await ctx.call("running-log", "list_runs@1", {}); return { added: 0 }; } };\n');
        writeFileSync(join(ws, "tests", "cases.json"), JSON.stringify([{ name: "lists", operation: "feed", input: { runs: [] }, calls: { "running-log/list_runs@1": { runs: [] } }, expect: { added: 0 } }]));
      },
    );
    assert.equal(narrow.status, "promoted", narrow.log.join("\n"));
    assert.ok(narrow.log.some((l) => /grant capability:running-log\/record_run@1 dropped/.test(l)));
    assert.deepEqual(feederGrants(), ["capability:running-log/list_runs@1"]);
    const again = await t.build(
      () => t.platform.modify(WEB_USER, { capabilityId: "run-feeder", request: "record again" }),
      (ws) => cpSync(join(FIXTURES, "run-feeder"), ws, { recursive: true }),
    );
    assert.equal(again.status, "promoted", again.log.join("\n"));
    assert.deepEqual(t.platform.readiness("run-feeder").pendingGrants, ["capability:running-log/record_run@1"]);
  });

  test("purging a capability drops the grants others hold to call it", async () => {
    t.platform.archive(USER, "running-log");
    await t.platform.purge(USER, "running-log", "running-log");
    assert.deepEqual(feederGrants(), []);
  });
});

describe("the review over the web API", () => {
  let t: ReturnType<typeof setup>;
  let server: Server;
  let port: number;
  let cookie = "";
  const http = (path: string, method = "GET", extra: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((res, rej) => {
      const r = request({ host: "127.0.0.1", port, path, method, headers: { host: `hewn.localhost:${port}`, "x-hewn-ui": "1", ...(cookie ? { cookie } : {}), ...extra } }, (m) => {
        let body = "";
        m.on("data", (d) => (body += d));
        m.on("end", () => res({ status: m.statusCode!, headers: m.headers, body }));
      });
      r.on("error", rej);
      r.end();
    });
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
    server = await serve(t.platform, t.home);
    port = (server.address() as AddressInfo).port;
    cookie = String((await http(`/auth?ticket=${t.platform.createWebTicket(USER)}`)).headers["set-cookie"]).split(";")[0];
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    t.cleanup();
  });

  test("the owner sees it in the build list and approves it; the build page shows what it adds", async () => {
    t.queue(addDump);
    const b = await t.platform.settle((await t.platform.modify(t.claude, { capabilityId: "running-log", request: "dump" })).buildId);
    const list = JSON.parse((await http("/api/builds?n=10&brief=1")).body);
    const listed = list.find((x: any) => x.buildId === b.buildId);
    assert.equal(listed.status, "review");
    assert.equal(listed.review.newOperations[0].key, "dump_runs@1");
    const r = await http(`/api/builds/${b.buildId}/approve`, "POST");
    assert.equal(r.status, 200, r.body);
    assert.equal(JSON.parse(r.body).status, "promoted");
  });

  test("turned down over the web API", async () => {
    t.queue(addDump);
    const b = await t.platform.settle((await t.platform.modify(t.claude, { capabilityId: "running-log", request: "dump" })).buildId);
    assert.equal(JSON.parse((await http(`/api/builds/${b.buildId}/reject`, "POST")).body).status, "cancelled");
  });
});
