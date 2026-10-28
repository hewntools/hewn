// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import { editJson, installSeed, setup } from "./helpers.ts";

const code = (c: string) => (e: unknown) => e instanceof PlatformError && e.code === c;
const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required });

/** Write a capability workspace: manifest + implementation + test cases. */
function writeCapability(ws: string, m: Record<string, unknown>, impl: { ts: string }, cases: unknown[]) {
  for (const f of ["src", "tests", "migrations", "capability.json"]) rmSync(join(ws, f), { recursive: true, force: true });
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(join(ws, "tests"), { recursive: true });
  mkdirSync(join(ws, "migrations"), { recursive: true });
  writeFileSync(join(ws, "capability.json"), JSON.stringify({ abi: "2.0", ...m }, null, 2));
  writeFileSync(join(ws, "src", "index.ts"), impl.ts);
  writeFileSync(join(ws, "tests", "cases.json"), JSON.stringify(cases));
}

const FEEDER_TS = `
type Ctx = { call: (id: string, op: string, input?: unknown) => Promise<any>; caller: { kind: string; id: string } };
export const operations = {
  async "feed@1"(input: { runs: { date: string; distanceKm: number; durationSeconds: number }[] }, ctx: Ctx) {
    const { runs } = await ctx.call("running-log", "list_runs@1", {});
    let added = 0;
    for (const r of input.runs) {
      if (runs.some((x: any) => x.date === r.date && x.distanceKm === r.distanceKm)) continue; // idempotent
      await ctx.call("running-log", "record_run@1", { ...r, notes: "source: run-feeder" });
      added++;
    }
    return { added };
  },
  async "sneaky@1"(_: unknown, ctx: Ctx) {
    return ctx.call("reading-list", "list_books@1", {});
  },
};
`;

const feederManifest = {
  id: "run-feeder",
  name: "Run Feeder",
  purpose: "Test: feeds runs into Running Log.",
  requires: { capabilities: [{ id: "running-log", operations: ["record_run@1", "list_runs@1"] }] },
  operations: [
    {
      name: "feed", description: "Feed runs", version: 1, sideEffect: "write",
      inputSchema: obj({ runs: { type: "array", items: { type: "object" } } }, ["runs"]),
      outputSchema: obj({ added: { type: "integer" } }, ["added"]),
    },
    { name: "sneaky", description: "Calls something undeclared", version: 1, sideEffect: "read", inputSchema: obj(), outputSchema: { type: "object" } },
  ],
};
const feederCases = [
  { name: "feeds new runs", operation: "feed", input: { runs: [{ date: "2026-10-01", distanceKm: 5, durationSeconds: 1500 }] }, calls: { "running-log/list_runs@1": { runs: [] }, "running-log/record_run@1": { runId: "x" } }, expect: { added: 1 } },
  { name: "skips known runs", operation: "feed", input: { runs: [{ date: "2026-10-01", distanceKm: 5, durationSeconds: 1500 }] }, calls: { "running-log/list_runs@1": { runs: [{ date: "2026-10-01", distanceKm: 5 }] } }, expect: { added: 0 } },
];

/** A relay forwards a call down a chain and reports who called whom. */
const relayManifest = (id: string, next: string[]) => ({
  id, name: id, purpose: "Test relay.",
  ...(next.length ? { requires: { capabilities: next.map((n) => ({ id: n, operations: ["relay@1"] })) } } : {}),
  operations: [{
    name: "relay", description: "Forward along a path", version: 1, sideEffect: "read",
    inputSchema: obj({ path: { type: "array", items: { type: "string" } } }),
    outputSchema: obj({ trail: { type: "array" } }, ["trail"]),
  }],
});
const RELAY_TS = `
export const operations = {
  async "relay@1"(input: { path?: string[] }, ctx: any) {
    const me = { caller: ctx.caller.kind + ":" + ctx.caller.id };
    const [next, ...rest] = input.path ?? [];
    if (!next) return { trail: [me] };
    const out = await ctx.call(next, "relay@1", { path: rest });
    return { trail: [me, ...out.trail] };
  },
};
`;
const relayCases = (next: string[]) => [
  next.length
    ? { name: "forwards", operation: "relay", input: { path: [next[0]] }, calls: { [`${next[0]}/relay@1`]: { trail: [{ caller: "x" }] } }, expect: { trail: ["$any", { caller: "x" }] } }
    : { name: "ends", operation: "relay", input: {}, expect: { trail: ["$any"] } },
];

describe("capability ↔ capability interop", () => {
  let t: ReturnType<typeof setup>;

  const build = (m: Record<string, any>, impl: { ts: string }, cases: unknown[]) =>
    t.build(
      () => t.platform.create(USER, { name: m.name, purpose: m.purpose, requirements: "test" }),
      (ws, job) => writeCapability(ws, { ...m, id: job.capabilityId }, impl, cases),
    );
  const feed = (runs: unknown[]) => t.platform.invoke(t.codex, { capabilityId: "run-feeder", operation: "feed", input: { runs } });
  const runs = async () => ((await t.platform.invoke(t.codex, { capabilityId: "running-log", operation: "list_runs" })).result as any).runs;

  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());

  test("write + read composition through granted operations; not ready until authorized", async () => {
    const r = await build(feederManifest, { ts: FEEDER_TS }, feederCases);
    assert.equal(r.status, "promoted", r.log.join("\n"));
    assert.ok(r.log.some((l) => /calls running-log\/record_run@1, running-log\/list_runs@1/.test(l)));

    const st = t.platform.readiness("run-feeder");
    assert.deepEqual(st.pendingGrants, ["capability:running-log/record_run@1", "capability:running-log/list_runs@1"]);
    await assert.rejects(feed([]), code("not_ready"));

    const auth = t.platform.authorization("run-feeder");
    assert.deepEqual(auth.items.map((i) => i.label), ["write Running Log: record_run@1", "read Running Log: list_runs@1"]);

    t.platform.approveGrants(USER, "run-feeder");
    const batch = [{ date: "2026-10-02", distanceKm: 8, durationSeconds: 2700 }];
    assert.deepEqual((await feed(batch)).result, { added: 1 });
    assert.deepEqual((await feed(batch)).result, { added: 0 }, "idempotent");
    const all = await runs();
    assert.equal(all.length, 1);
    assert.equal(all[0].notes, "source: run-feeder");

    const log = t.platform.logLines("running-log", 100).join("\n");
    assert.match(log, /codex → run-feeder record_run@1 ok/, "call chain attributed to the origin");
  });

  test("undeclared calls are refused at runtime", async () => {
    await build(feederManifest, { ts: FEEDER_TS }, feederCases);
    t.platform.approveGrants(USER, "run-feeder");
    await assert.rejects(
      t.platform.invoke(t.codex, { capabilityId: "run-feeder", operation: "sneaky" }),
      (e: any) => e.code === "operation_failed" && /did not declare reading-list\/list_books@1/.test(e.message),
    );
  });

  test("revoking a grant or archiving the callee makes the caller not ready, with a reason", async () => {
    await build(feederManifest, { ts: FEEDER_TS }, feederCases);
    t.platform.approveGrants(USER, "run-feeder");
    t.platform.revokeGrant(USER, "run-feeder", "capability:running-log/record_run@1");
    await assert.rejects(feed([]), code("not_ready"));
    t.platform.approveGrants(USER, "run-feeder");

    t.platform.archive(USER, "running-log");
    const st = t.platform.readiness("run-feeder");
    assert.deepEqual(st.missingDependencies, ["running-log/record_run@1", "running-log/list_runs@1"]);
    assert.match(st.userAction!, /no longer exist/);
    t.platform.restore(USER, "running-log");
    assert.equal(t.platform.readiness("run-feeder").ready, true);
    assert.deepEqual(t.platform.usedBy("running-log").map((u) => u.id), ["run-feeder"]);
  });

  test("validation: unavailable callees and unmocked calls fail the build", async () => {
    const missing = await build({ ...feederManifest, requires: { capabilities: [{ id: "nope", operations: ["x@1"] }] } }, { ts: FEEDER_TS }, feederCases);
    assert.equal(missing.status, "failed");
    assert.match(missing.log.join("\n"), /nope\/x@1 does not exist/);

    const unmocked = await build({ ...feederManifest, name: "Run Feeder Two" }, { ts: FEEDER_TS }, [{ name: "no mocks", operation: "feed", input: { runs: [] } }]);
    assert.equal(unmocked.status, "failed");
    assert.match(unmocked.log.join("\n"), /no mock for running-log\/list_runs@1/);
  });

  test("callers pin contract versions: a breaking @2 on the callee doesn't break them", async () => {
    await build(feederManifest, { ts: FEEDER_TS }, feederCases);
    t.platform.approveGrants(USER, "run-feeder");
    const v2 = await t.build(
      () => t.platform.modify(USER, { capabilityId: "running-log", request: "record_run@2" }),
      (ws) => {
        editJson(join(ws, "capability.json"), (m) => {
          const v2 = structuredClone(m.operations[0]);
          v2.version = 2;
          v2.inputSchema.required = ["distanceKm", "durationSeconds", "date"];
          m.operations.push(v2);
        });
        const idx = join(ws, "src", "index.ts");
        writeFileSync(idx, readFileSync(idx, "utf8").replace('  "list_runs@1"', '  "record_run@2"(i: any, c: any) { return operations["record_run@1"](i, c); },\n  "list_runs@1"'));
        editJson(join(ws, "tests", "cases.json"), (c) => c.forEach((x: any) => (x.version ??= 1)));
      },
    );
    assert.equal(v2.status, "promoted", v2.log.join("\n"));
    assert.deepEqual((await feed([{ date: "2026-10-05", distanceKm: 3, durationSeconds: 900 }])).result, { added: 1 });
  });

  test("chains report provenance; depth and cycles are bounded", async () => {
    for (const [id, next] of [["relay-d", []], ["relay-c", ["relay-d"]], ["relay-b", ["relay-c"]], ["relay-a", ["relay-b"]]] as const) {
      const r = await build(relayManifest(id, [...next]), { ts: RELAY_TS }, relayCases([...next]));
      assert.equal(r.status, "promoted", r.log.join("\n"));
      t.platform.approveGrants(USER, id);
    }
    const ok = await t.platform.invoke(t.codex, { capabilityId: "relay-a", operation: "relay", input: { path: ["relay-b", "relay-c"] } });
    assert.deepEqual((ok.result as any).trail, [{ caller: "agent:codex" }, { caller: "capability:relay-a" }, { caller: "capability:relay-b" }]);

    await assert.rejects(
      t.platform.invoke(t.codex, { capabilityId: "relay-a", operation: "relay", input: { path: ["relay-b", "relay-c", "relay-d"] } }),
      /call depth exceeds 3/,
    );

    // cycle: let relay-c call relay-a
    const cyc = await t.build(
      () => t.platform.modify(USER, { capabilityId: "relay-c", request: "cycle" }),
      (ws) => editJson(join(ws, "capability.json"), (m) => m.requires.capabilities.push({ id: "relay-a", operations: ["relay@1"] })),
    );
    assert.equal(cyc.status, "promoted", cyc.log.join("\n"));
    t.platform.approveGrants(USER, "relay-c");
    await assert.rejects(t.platform.invoke(t.codex, { capabilityId: "relay-a", operation: "relay", input: { path: ["relay-b", "relay-c", "relay-a"] } }), /call cycle|call depth/);
  });

  test("the whole call chain shares one deadline (the outermost call's)", async () => {
    const slow = `export const operations = { async "relay@1"(input: any, ctx: any) { await new Promise((r) => setTimeout(r, 150)); return input.path?.length ? ctx.call(input.path[0], "relay@1", { path: input.path.slice(1) }) : { trail: [] }; } };`;
    for (const [id, next] of [["slow-b", []], ["slow-a", ["slow-b"]]] as const) {
      const r = await build(relayManifest(id, [...next]), { ts: slow }, [{ name: "ok", operation: "relay", input: {}, expect: { trail: [] } }]);
      assert.equal(r.status, "promoted", r.log.join("\n"));
      t.platform.approveGrants(USER, id);
    }
    // 200 ms is enough for one hop (150 ms), not for two.
    await assert.rejects(
      t.platform.invoke(t.codex, { capabilityId: "slow-a", operation: "relay", input: { path: ["slow-b"] } }, ["codex"], Date.now() + 200),
      /deadline/,
    );
    const ok = await t.platform.invoke(t.codex, { capabilityId: "slow-a", operation: "relay", input: { path: ["slow-b"] } });
    assert.deepEqual(ok.result, { trail: [] });
  });

  test("agents can request access; only the owner can grant it", async () => {
    await build(feederManifest, { ts: FEEDER_TS }, feederCases);
    const st = t.platform.requestAccess(t.codex, "run-feeder", "Needed to sync Garmin runs");
    assert.equal(st.ready, false);
    assert.equal(t.platform.authorization("run-feeder").requests[0].requestedBy, "codex");
    assert.throws(() => t.platform.approveGrants(t.codex, "run-feeder"), code("forbidden"));
    t.platform.approveGrants(USER, "run-feeder");
    assert.deepEqual(t.platform.authorization("run-feeder").requests, [], "cleared on approval");
  });

  test("the owner can say no (Deny): it stays not ready, nothing asks again for that version, agents are told; Authorize still allows it", async () => {
    await build(feederManifest, { ts: FEEDER_TS }, feederCases);
    const [write, read] = ["capability:running-log/record_run@1", "capability:running-log/list_runs@1"];
    t.platform.requestAccess(t.codex, "run-feeder", "Needed to sync runs");
    assert.throws(() => t.platform.declineGrant(t.codex, "run-feeder", write), code("forbidden"));
    assert.throws(() => t.platform.declineGrant(USER, "run-feeder", "host:example.com"), code("invalid_request"));
    t.platform.declineGrant(USER, "run-feeder", write);
    assert.equal(t.platform.readiness("run-feeder").ready, false);
    assert.deepEqual(t.platform.readiness("run-feeder").declinedGrants, [write]);
    assert.equal(t.platform.authorization("run-feeder").requests.length, 1, "one grant is still undecided: the agent's request stands");
    t.platform.declineGrant(USER, "run-feeder", read);
    const st = t.platform.readiness("run-feeder");
    assert.deepEqual(st.declinedGrants, [write, read]);
    assert.match(st.userAction!, /owner said no to .*Don't request access again/);
    assert.deepEqual(t.platform.authorization("run-feeder").requests, [], "answered");
    assert.throws(() => t.platform.requestAccess(t.codex, "run-feeder", "please"), code("forbidden"));
    await assert.rejects(t.platform.invoke(t.codex, { capabilityId: "run-feeder", operation: "feed", input: { runs: [] } }), code("not_ready"));
    assert.ok(t.platform.registry.grantEvents().some((e) => e.action === "decline" && e.grant === write && e.actor === USER.id));
    // A new version asks again.
    const v2 = await t.build(
      () => t.platform.modify(USER, { capabilityId: "run-feeder", request: "say what it is" }),
      (ws) => editJson(join(ws, "capability.json"), (m) => (m.purpose = "Test: feeds runs into Running Log, v2.")),
    );
    assert.equal(v2.status, "promoted", v2.log.join("\n"));
    assert.equal(t.platform.readiness("run-feeder").declinedGrants, undefined);
    // Authorize after a no: allowed, and a later revoke doesn't bring the old no back.
    t.platform.declineGrant(USER, "run-feeder", write);
    t.platform.approveGrant(USER, "run-feeder", write);
    t.platform.revokeGrant(USER, "run-feeder", write);
    assert.equal(t.platform.readiness("run-feeder").declinedGrants, undefined);
  });

  test("said no only: just what the owner said no to stands in the way; a secret can't be declined", async () => {
    const r = await build({ ...feederManifest, abi: "2.1", config: [{ name: "TEAM", description: "Which team's runs" }] }, { ts: FEEDER_TS }, feederCases);
    assert.equal(r.status, "promoted", r.log.join("\n"));
    const [write, read] = ["capability:running-log/record_run@1", "capability:running-log/list_runs@1"];
    assert.throws(() => t.platform.declineGrant(USER, "run-feeder", "secret:TOKEN"), /only a host, another tool's operation or a model/);
    t.platform.requestAccess(t.codex, "run-feeder", "Needed to sync runs");
    t.platform.declineGrant(USER, "run-feeder", write);
    t.platform.declineGrant(USER, "run-feeder", read);
    // Its setting is still missing: the owner has more to do, so it isn't "said no only".
    let st = t.platform.readiness("run-feeder");
    assert.deepEqual(st.declinedGrants, [write, read]);
    assert.equal(st.onlySaidNo, undefined);
    assert.doesNotMatch(st.userAction!, /said no/);
    assert.equal(t.platform.authorization("run-feeder").requests.length, 1, "the agent's request stands");
    assert.equal(t.platform.requestAccess(t.codex, "run-feeder", "the setting, please").requested, true, "not refused");
    t.platform.setConfig(USER, "run-feeder", "TEAM", "red");
    st = t.platform.readiness("run-feeder");
    assert.equal(st.onlySaidNo, true);
    assert.match(st.userAction!, /owner said no to .*Don't request access again/);
    assert.throws(() => t.platform.requestAccess(t.codex, "run-feeder", "please"), code("forbidden"));
    // Authorizing one of them leaves only the other no: the agents' requests are answered.
    t.platform.approveGrant(USER, "run-feeder", read);
    assert.equal(t.platform.readiness("run-feeder").onlySaidNo, true);
    assert.deepEqual(t.platform.authorization("run-feeder").requests, []);
  });

  test("a capability cannot call itself", async () => {
    const r = await build({ ...feederManifest, requires: { capabilities: [{ id: "run-feeder", operations: ["feed@1"] }] } }, { ts: FEEDER_TS }, feederCases);
    assert.equal(r.status, "failed");
    assert.match(r.log.join("\n"), /cannot call itself/);
  });
});

