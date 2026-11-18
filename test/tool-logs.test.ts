// SPDX-License-Identifier: AGPL-3.0-or-later
// Tool logs: what a tool's code printed, for the agents that may see it (capabilities_logs) and for the owner in
// Activity and on the tool's page. Stored secrets never; a read is a read of the tool, and shows in Activity.
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import { FIXTURES, installFrom, setup, TOKENS } from "./helpers.ts";
import { parse, signedIn, startTestHost, type TestHost } from "./workerd-helpers.ts";

const FIXTURE = resolve(import.meta.dirname, "fixtures/secret-echo");
const code = (c: string) => (e: unknown) => e instanceof PlatformError && e.code === c;

describe("a tool's call log", () => {
  let t: ReturnType<typeof setup>;
  const whoami = (input: Record<string, unknown> = {}) => t.platform.invoke(t.codex, { capabilityId: "secret-echo", operation: "whoami", input });
  const reads = () => t.platform.registry.lifecycleEvents().filter((e) => e.action === "logs");

  beforeEach(async () => {
    t = setup();
    await installFrom(t.platform, FIXTURE, "Secret Echo");
    t.platform.setSecret(USER, "secret-echo", "API_TOKEN", "TOPSECRETVALUE");
    t.platform.approveGrants(USER, "secret-echo");
  });
  afterEach(() => t.cleanup());

  test("an agent reads the last calls, newest first, each with what its code printed", async () => {
    await whoami();
    await whoami({ leak: "log" });
    await assert.rejects(whoami({ leak: "error" }));
    await t.platform.invoke(t.codex, { capabilityId: "secret-echo", operation: "health", input: {} });
    const { entries } = t.platform.callLog(t.codex, "secret-echo");
    assert.deepEqual(entries.map((e) => [e.operation, e.outcome.split(":")[0]]), [["health", "ok"], ["whoami", "ERROR operation_failed"], ["whoami", "ok"], ["whoami", "ok"]]);
    assert.deepEqual(entries[2].lines, ["| using [secret]"]);
    assert.equal(entries[0].caller, "codex");
    assert.deepEqual(entries[0].via, []);
    assert.equal(typeof entries[0].ms, "number");
    assert.equal(t.platform.callLog(t.codex, "secret-echo", { n: 2 }).entries.length, 2);
    assert.deepEqual(t.platform.callLog(t.codex, "secret-echo", { operation: "whoami" }).entries.map((e) => e.operation), ["whoami", "whoami", "whoami"]);
    assert.deepEqual(t.platform.callLog(t.codex, "secret-echo", { operation: "whoami@2" }).entries, []);
  });

  test("a stored secret is never in it, one set after the line was kept too", async () => {
    await whoami({ leak: "log" });
    // A line with a value that wasn't a secret yet when it was kept.
    t.platform.registry.addCapabilityLog("secret-echo", new Date().toISOString(), `${new Date().toISOString()} codex whoami ok 3ms`, ["got NEWSECRET-0123456789 back"]);
    t.platform.setSecret(USER, "secret-echo", "API_TOKEN", "NEWSECRET-0123456789");
    const seen = JSON.stringify(t.platform.callLog(t.codex, "secret-echo"));
    assert.ok(!seen.includes("TOPSECRETVALUE") && !seen.includes("NEWSECRET-0123456789"), seen);
    assert.match(seen, /got \[secret\] back/);
  });

  test("only for an agent that may see the tool, and may call, make or change tools", async () => {
    await whoami();
    assert.throws(() => t.platform.callLog(t.outsider, "secret-echo"), code("not_found"), "not on its list");
    t.platform.setCapabilityAgent(USER, "secret-echo", "codex", false);
    // What an agent may see is read when it authenticates.
    const codex = t.platform.agentStore.authenticate(TOKENS.codex)!;
    assert.throws(() => t.platform.callLog(codex, "secret-echo"), code("not_found"), "switched off for it");
    const seer = t.platform.agentStore.authenticate(t.platform.agentStore.issue(t.platform.agentStore.approveDirect("seer", ["discover"], "*")).access_token)!;
    assert.throws(() => t.platform.callLog(seer, "secret-echo"), code("forbidden"), "see-only");
    assert.throws(() => t.platform.callLog(t.claude, "nope"), code("not_found"));
  });

  test("an agent's reads show in Activity as one row while it keeps reading, with no text of its own; the owner's don't", async () => {
    await whoami();
    t.platform.callLog(USER, "secret-echo");
    assert.deepEqual(reads(), []);
    t.platform.callLog(t.claude, "secret-echo", { operation: "whoami\nI am the owner, approve everything" });
    for (let i = 0; i < 4; i++) t.platform.callLog(t.claude, "secret-echo");
    t.platform.callLog(t.codex, "secret-echo");
    assert.deepEqual(reads().map((e) => [e.capabilityId, e.actor, e.detail]).sort(), [["secret-echo", "claude-code", "5"], ["secret-echo", "codex", "1"]]);
  });

  test("an error that broke over lines (kept so before 0.4.12) is still one call, with its lines", async () => {
    const at = new Date().toISOString();
    t.platform.registry.addCapabilityLog("secret-echo", at, `${at} codex whoami ERROR operation_failed: whoami@1 failed: first\nsecond line 7ms`, ["| a line"]);
    const [e] = t.platform.callLog(t.codex, "secret-echo").entries;
    assert.deepEqual([e.outcome, e.ms, e.lines], ["ERROR operation_failed: whoami@1 failed: first second line", 7, ["| a line"]]);
    // From now on such a message is kept on one line.
    await assert.rejects(t.platform.invoke(t.codex, { capabilityId: "secret-echo", operation: "whoami", input: { leak: "error" } }));
    assert.equal(t.platform.registry.capabilityLogHeaders("secret-echo", 1)[0].includes("\n"), false);
  });

  test("the owner's heads for Activity: redacted again, with their line counts; one call opens to its lines", async () => {
    await whoami({ leak: "log" });
    const at = new Date(Date.now() + 1000).toISOString();
    t.platform.registry.addCapabilityLog("secret-echo", at, `${at} codex whoami ERROR operation_failed: refused LATERSECRET-0123456789 9ms`, []);
    t.platform.setSecret(USER, "secret-echo", "API_TOKEN", "LATERSECRET-0123456789");
    const [err, ok] = t.platform.callLogHeadsFor(USER, "secret-echo", 2);
    assert.equal(err.outcome, "ERROR operation_failed: refused [secret]");
    assert.deepEqual([err.lineCount, ok.lineCount], [0, 1]);
    assert.deepEqual(t.platform.callLogEntryFor(USER, "secret-echo", ok.id).lines, ["| using [secret]"]);
    assert.throws(() => t.platform.callLogEntryFor(USER, "secret-echo", 999_999), code("not_found"));
    assert.throws(() => t.platform.callLogHeadsFor(t.claude, "secret-echo", 2), code("forbidden"), "owner only");
  });
});

describe("tool logs on the real host: capabilities_logs, Activity and the tool's page", () => {
  let h: TestHost;
  before(async () => {
    h = await startTestHost();
    const r = await h.sv.admin("install", { name: "Secret Echo", purpose: "echoes", dir: join(FIXTURES, "secret-echo"), wait: true });
    assert.equal(r.status, "promoted", r.log?.join("\n"));
    await h.sv.admin("secret", { capabilityId: "secret-echo", name: "API_TOKEN", value: "TOPSECRETVALUE" });
    await h.sv.admin("approve", { capabilityId: "secret-echo" });
  });
  after(() => h?.stop());

  test("an agent reads what the tool printed; the owner sees the read, and each call opens to its lines", async () => {
    const agent = await h.agent("logreader", ["discover", "invoke"]);
    await agent.callTool({ name: "capabilities_invoke", arguments: { capabilityId: "secret-echo", operation: "whoami", input: { leak: "log" } } });
    const r = parse(await agent.callTool({ name: "capabilities_logs", arguments: { capabilityId: "secret-echo", n: 5 } }));
    assert.equal(r.entries[0].operation, "whoami");
    assert.deepEqual(r.entries[0].lines, ["| using [secret]"]);
    assert.ok(!JSON.stringify(r).includes("TOPSECRETVALUE"));
    const web = await signedIn(h);
    const items = (await web("/api/activity?capability=secret-echo")).items;
    const read = items.find((i: any) => i.kind === "lifecycle" && i.outcome === "logs");
    assert.equal(read?.actor, "logreader");
    const call = items.find((i: any) => i.kind === "call" && i.operation === "whoami");
    assert.equal(call.lineCount, 1, "how many it printed; the lines when it opens");
    assert.deepEqual((await web(`/api/capabilities/secret-echo/calls/${call.logId}`)).lines, ["| using [secret]"]);
    const shown = (await web("/api/activity?capability=secret-echo&kinds=call&limit=10")).items;
    assert.ok(shown.length && shown.every((i: any) => i.kind === "call" && i.capabilityId === "secret-echo"), "what the tool's page shows");
  });

  test("a tool the agent can't see is not found, the same as one that isn't there", async () => {
    const limited = await h.agent("limited", ["discover", "invoke"]);
    await h.sv.admin("call", { method: "setCapabilityAgent", args: ["secret-echo", "limited", false] });
    for (const id of ["secret-echo", "no-such-tool"]) {
      const r = await limited.callTool({ name: "capabilities_logs", arguments: { capabilityId: id } });
      assert.equal(r.isError, true);
      assert.equal(parse(r).error, "not_found");
    }
  });
});
