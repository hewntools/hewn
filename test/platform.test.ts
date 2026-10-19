// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { PlatformError } from "@hewntools/core/errors.ts";
import { nodePlatform } from "@hewntools/test-host/index.ts";
import { installSeed, setup, TOKENS } from "./helpers.ts";

const rejectsWith = (code: string) => (e: unknown) => e instanceof PlatformError && e.code === code;

describe("discovery and invocation", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());

  test("list returns public summaries only", () => {
    const list = t.platform.list(t.codex);
    assert.deepEqual(list.map((c) => c.id), ["running-log"]);
    assert.deepEqual(list[0].operations, ["record_run@1", "list_runs@1", "get_summary@1"]);
    assert.deepEqual(t.platform.list(t.codex, { operation: "record_run" }).length, 1);
    assert.deepEqual(t.platform.list(t.codex, { operation: "nope" }).length, 0);
    assert.deepEqual(t.platform.list(t.codex, { tag: "running" }).length, 1);
  });

  test("get exposes the manifest, not implementation internals", () => {
    const m = t.platform.get(t.codex, "running-log");
    const text = JSON.stringify(m);
    assert.equal(m.id, "running-log");
    for (const leak of ["state.db", "versions", "contentHash", "migrations", t.home.root]) {
      assert.ok(!text.includes(leak), `manifest leaks ${leak}`);
    }
  });

  test("record via one agent, read via another", async () => {
    await t.platform.invoke(t.claude, {
      capabilityId: "running-log",
      operation: "record_run",
      operationVersion: 1,
      input: { distanceKm: 5, durationSeconds: 1680, date: "2026-10-03" },
    });
    const { result, operation } = await t.platform.invoke(t.codex, { capabilityId: "running-log", operation: "get_summary" });
    assert.equal(operation, "get_summary@1");
    assert.deepEqual(result, {
      runCount: 1,
      totalDistanceKm: 5,
      totalDurationSeconds: 1680,
      averageDistanceKm: 5,
      averagePaceSecondsPerKm: 336,
    });
  });

  test("state survives a platform restart", async () => {
    await t.platform.invoke(t.claude, {
      capabilityId: "running-log",
      operation: "record_run",
      input: { distanceKm: 3, durationSeconds: 1000 },
    });
    t.platform.close();
    const fresh = nodePlatform(t.home);
    const { result } = await fresh.invoke(t.codex, { capabilityId: "running-log", operation: "list_runs" });
    assert.equal((result as any).runs.length, 1);
    fresh.close();
  });

  test("input is validated against the contract", async () => {
    await assert.rejects(
      t.platform.invoke(t.claude, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: "far" } }),
      rejectsWith("invalid_input"),
    );
  });

  test("unknown operation or version is not_found", async () => {
    await assert.rejects(t.platform.invoke(t.codex, { capabilityId: "running-log", operation: "delete_all" }), rejectsWith("not_found"));
    await assert.rejects(
      t.platform.invoke(t.codex, { capabilityId: "running-log", operation: "list_runs", operationVersion: 9 }),
      rejectsWith("not_found"),
    );
  });

  test("a tampered version blob is refused when it is loaded", async () => {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const hash = t.platform.registry.getVersion("running-log", 1)!.contentHash;
    const blob = `${t.home.root}/blobs/versions/${hash}.json`;
    const v = JSON.parse(readFileSync(blob, "utf8"));
    v.bundle = v.bundle.replace("runCount: r.n", "runCount: 999");
    writeFileSync(blob, JSON.stringify(v));
    t.platform.close();
    const fresh = nodePlatform(t.home);
    await assert.rejects(fresh.invoke(t.codex, { capabilityId: "running-log", operation: "list_runs" }), /failed its integrity check/);
    fresh.close();
    t.platform = nodePlatform(t.home); // for cleanup
  });
});

describe("authorization", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());

  test("unknown token does not authenticate", () => {
    assert.equal(t.platform.agentStore.authenticate("nope"), undefined);
    assert.equal(t.platform.agentStore.authenticate(undefined), undefined);
  });

  test("codex cannot create or modify, or cancel a build claude requested", async () => {
    await assert.rejects(t.platform.create(t.codex, { name: "X", purpose: "x", requirements: "x" }), rejectsWith("forbidden"));
    await assert.rejects(t.platform.modify(t.codex, { capabilityId: "running-log", request: "x" }), rejectsWith("forbidden"));
    t.queue(() => new Promise(() => {}));
    const b = await t.platform.modify(t.claude, { capabilityId: "running-log", request: "x" });
    assert.throws(() => t.platform.cancelBuild(t.codex, b.buildId), rejectsWith("forbidden"));
    t.platform.cancelBuild(t.claude, b.buildId);
  });

  test("visibility limits build tools: get, wait, retry and after", async () => {
    t.queue(() => new Promise(() => {}));
    const b = await t.platform.modify(t.claude, { capabilityId: "running-log", request: "x" });
    const narrow = { id: "narrow", kind: "agent" as const, scopes: new Set(["create", "modify"] as const), capabilities: new Set(["other"]) };
    assert.throws(() => t.platform.getBuild(narrow, b.buildId), rejectsWith("not_found"));
    await assert.rejects(t.platform.waitForBuild(narrow, b.buildId, { timeoutMs: 10 }), rejectsWith("not_found"));
    t.platform.cancelBuild(t.claude, b.buildId);
    await assert.rejects(t.platform.retryBuild(narrow, b.buildId), rejectsWith("not_found"));
    await assert.rejects(t.platform.create(narrow, { name: "Other", purpose: "x", requirements: "x", after: b.buildId }), rejectsWith("not_found"));
    assert.equal(t.platform.getBuild(t.claude, b.buildId).status, "cancelled", "the requester still sees it");
  });

  test("visibility limits list, get and invoke", async () => {
    assert.deepEqual(t.platform.list(t.outsider), []);
    assert.throws(() => t.platform.get(t.outsider, "running-log"), rejectsWith("not_found"));
    await assert.rejects(t.platform.invoke(t.outsider, { capabilityId: "running-log", operation: "list_runs" }), rejectsWith("not_found"));
  });

  test("scopes come from the agent's approval, not the caller", () => {
    const a = t.platform.agentStore.authenticate(TOKENS.codex)!;
    assert.deepEqual([...a.scopes].sort(), ["discover", "invoke"]);
  });
});
