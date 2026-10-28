// SPDX-License-Identifier: AGPL-3.0-or-later
// Composition between capabilities, and escape tests, on the real workerd host.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { editJson, SEED } from "./helpers.ts";
import { parse, startTestHost, type TestHost } from "./workerd-helpers.ts";

const obj = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required });

function writeCapability(ws: string, m: Record<string, unknown>, ts: string, cases: unknown[]) {
  for (const f of ["src", "tests", "migrations", "capability.json"]) rmSync(join(ws, f), { recursive: true, force: true });
  mkdirSync(join(ws, "src"), { recursive: true });
  mkdirSync(join(ws, "tests"), { recursive: true });
  writeFileSync(join(ws, "capability.json"), JSON.stringify({ abi: "2.0", ...m }, null, 2));
  writeFileSync(join(ws, "src", "index.ts"), ts);
  writeFileSync(join(ws, "tests", "cases.json"), JSON.stringify(cases));
}

const FEEDER_TS = `
export const operations = {
  async "feed@1"(input: any, ctx: any) {
    const { runs } = await ctx.call("running-log", "list_runs@1", {});
    let added = 0;
    for (const r of input.runs) {
      if (runs.some((x: any) => x.date === r.date && x.distanceKm === r.distanceKm)) continue; // idempotent
      await ctx.call("running-log", "record_run@1", { ...r, notes: "source: " + ctx.caller.id + " via run-feeder" });
      added++;
    }
    return { added };
  },
  async "sneaky@1"(_: unknown, ctx: any) {
    return ctx.call("reading-list", "list_books@1", {});
  },
  async "forge@1"(_: unknown, ctx: any) {
    // Extra arguments can't change who the platform says is calling.
    return ctx.call("running-log", "list_runs@1", {}, { kind: "user", id: "user" });
  },
};
`;
const feeder = {
  id: "run-feeder",
  name: "Run Feeder",
  purpose: "Test: feeds runs into Running Log.",
  requires: { capabilities: [{ id: "running-log", operations: ["record_run@1", "list_runs@1"] }] },
  operations: [
    { name: "feed", description: "Feed runs", version: 1, sideEffect: "write", inputSchema: obj({ runs: { type: "array", items: { type: "object" } } }, ["runs"]), outputSchema: obj({ added: { type: "integer" } }, ["added"]) },
    { name: "sneaky", description: "Calls something undeclared", version: 1, sideEffect: "read", inputSchema: obj(), outputSchema: { type: "object" } },
    { name: "forge", description: "Tries to pass a caller", version: 1, sideEffect: "read", inputSchema: obj(), outputSchema: { type: "object" } },
  ],
};
const feederCases = [
  { name: "feeds", operation: "feed", input: { runs: [{ date: "2026-10-01", distanceKm: 5, durationSeconds: 1500 }] }, calls: { "running-log/list_runs@1": { runs: [] }, "running-log/record_run@1": { runId: "x" } }, expect: { added: 1 } },
];

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
const relay = (id: string, next: string[]) => ({
  id, name: id, purpose: "Test relay.",
  ...(next.length ? { requires: { capabilities: next.map((n) => ({ id: n, operations: ["relay@1"] })) } } : {}),
  operations: [{ name: "relay", description: "Forward along a path", version: 1, sideEffect: "read", inputSchema: obj({ path: { type: "array", items: { type: "string" } } }), outputSchema: obj({ trail: { type: "array" } }, ["trail"]) }],
});
const relayCases = (next: string[]) => [
  next.length
    ? { name: "forwards", operation: "relay", input: { path: [next[0]] }, calls: { [`${next[0]}/relay@1`]: { trail: [{ caller: "x" }] } }, expect: { trail: ["$any", { caller: "x" }] } }
    : { name: "ends", operation: "relay", input: {}, expect: { trail: ["$any"] } },
];

describe("composition on the workerd host", () => {
  let h: TestHost;
  let claude: Client;
  let codex: Client;
  const build = async (m: Record<string, any>, ts: string, cases: unknown[]) => {
    h.queue((ws) => writeCapability(ws, m, ts, cases));
    const opened = parse(await claude.callTool({ name: "capabilities_create", arguments: { name: m.name, purpose: m.purpose, requirements: "test" } }));
    return parse(await claude.callTool({ name: "builds_wait", arguments: { buildId: opened.buildId, timeoutSeconds: 120 } }));
  };
  const call = async (client: Client, capabilityId: string, operation: string, input: unknown = {}) => {
    const r: any = await client.callTool({ name: "capabilities_invoke", arguments: { capabilityId, operation, input } });
    return r.isError ? { error: parse(r) } : parse(r);
  };

  before(async () => {
    h = await startTestHost();
    claude = await h.agent("claude-code", ["discover", "invoke", "create", "modify"]);
    codex = await h.agent("codex", ["discover", "invoke"]);
    const seed = await h.sv.admin("install", { name: "Running Log", purpose: "runs", dir: SEED, wait: true });
    assert.equal(seed.status, "promoted", seed.log.join("\n"));
  });
  after(() => h?.stop());

  test("write composition: not ready until authorized; then idempotent, provenance recorded, chain logged", async () => {
    const r = await build(feeder, FEEDER_TS, feederCases);
    assert.equal(r.status, "promoted", r.log.join("\n"));
    assert.match((await call(codex, "run-feeder", "feed", { runs: [] })).error.error, /not_ready/);
    await h.sv.admin("approve", { capabilityId: "run-feeder" });
    const batch = [{ date: "2026-10-02", distanceKm: 8, durationSeconds: 2700 }];
    assert.deepEqual((await call(codex, "run-feeder", "feed", { runs: batch })).result, { added: 1 });
    assert.deepEqual((await call(codex, "run-feeder", "feed", { runs: batch })).result, { added: 0 }, "idempotent");
    const runs = (await h.invoke("running-log", "list_runs")).result.runs;
    assert.equal(runs[0].notes, "source: codex via run-feeder", "ctx.caller reached the handler");
    const log = (await h.sv.admin("logs", { capabilityId: "running-log" })).lines.join("\n");
    assert.match(log, /codex → run-feeder record_run@1 ok/, "the call chain is attributed to its origin");
  });

  test("escape: undeclared calls fail; a capability can't forge its caller", async () => {
    const sneaky = await call(codex, "run-feeder", "sneaky");
    assert.match(sneaky.error.message, /did not declare reading-list\/list_books@1/);
    const forged = await call(codex, "run-feeder", "forge");
    assert.ok(Array.isArray(forged.result.runs), "the extra argument is ignored");
    assert.match((await h.sv.admin("logs", { capabilityId: "running-log" })).lines.join("\n"), /codex → run-feeder list_runs@1 ok/);
  });

  test("revoke → not ready with a reason; re-approve → works again", async () => {
    await h.sv.admin("revoke", { capabilityId: "run-feeder", grant: "capability:running-log/record_run@1" });
    const st = await h.sv.admin("readiness", { capabilityId: "run-feeder" });
    assert.equal(st.ready, false);
    assert.deepEqual(st.pendingGrants, ["capability:running-log/record_run@1"]);
    assert.match(st.userAction, /authorization by the owner/);
    await h.sv.admin("approve", { capabilityId: "run-feeder" });
    assert.equal((await h.sv.admin("readiness", { capabilityId: "run-feeder" })).ready, true);
  });

  test("stable under change: a breaking record_run@2 on the callee doesn't break the pinned caller", async () => {
    h.queue((ws) => {
      editJson(join(ws, "capability.json"), (m) => {
        const v2 = structuredClone(m.operations[0]);
        v2.version = 2;
        v2.inputSchema.required = ["distanceKm", "durationSeconds", "date"];
        m.operations.push(v2);
      });
      const idx = join(ws, "src", "index.ts");
      writeFileSync(idx, readFileSync(idx, "utf8").replace('  "list_runs@1"', '  "record_run@2"(i: any, c: any) { return operations["record_run@1"](i, c); },\n  "list_runs@1"'));
      editJson(join(ws, "tests", "cases.json"), (c) => c.forEach((x: any) => (x.version ??= 1)));
    });
    const v2 = await h.sv.admin("modify", { capabilityId: "running-log", request: "record_run@2", wait: true });
    assert.equal(v2.status, "promoted", v2.log.join("\n"));
    assert.deepEqual((await call(codex, "run-feeder", "feed", { runs: [{ date: "2026-10-05", distanceKm: 3, durationSeconds: 900 }] })).result, { added: 1 });
  });

  test("chains report provenance; depth > 3 and cycles are refused", async () => {
    for (const [id, next] of [["relay-d", []], ["relay-c", ["relay-d"]], ["relay-b", ["relay-c"]], ["relay-a", ["relay-b"]]] as const) {
      const r = await build(relay(id, [...next]), RELAY_TS, relayCases([...next]));
      assert.equal(r.status, "promoted", r.log.join("\n"));
      await h.sv.admin("approve", { capabilityId: id });
    }
    const ok = await call(codex, "relay-a", "relay", { path: ["relay-b", "relay-c"] });
    assert.deepEqual(ok.result.trail, [{ caller: "agent:codex" }, { caller: "capability:relay-a" }, { caller: "capability:relay-b" }]);
    const deep = await call(codex, "relay-a", "relay", { path: ["relay-b", "relay-c", "relay-d"] });
    assert.match(deep.error.message, /call depth exceeds 3/);

    h.queue((ws) => editJson(join(ws, "capability.json"), (m) => m.requires.capabilities.push({ id: "relay-a", operations: ["relay@1"] })));
    const cyc = await h.sv.admin("modify", { capabilityId: "relay-c", request: "cycle", wait: true });
    assert.equal(cyc.status, "promoted", cyc.log.join("\n"));
    await h.sv.admin("approve", { capabilityId: "relay-c" });
    const cycle = await call(codex, "relay-a", "relay", { path: ["relay-b", "relay-c", "relay-a"] });
    assert.match(cycle.error.message, /call cycle|call depth/);
  });
});
