// SPDX-License-Identifier: AGPL-3.0-or-later
// Retry and Ask builder to fix carry on from the failed build's workspace (and its builder's session), as a later
// attempt does, instead of starting over from the tool's version (#87). A change's retry says it's one.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { editJson, installSeed, setup } from "./helpers.ts";

/** Half the work, then a test that fails: the build fails with that work in its workspace. */
const halfDone = (ws: string) => {
  writeFileSync(join(ws, "src", "half.ts"), "export const half = 1;\n");
  editJson(join(ws, "tests", "cases.json"), (cases) => (cases[0].expect = { runCount: 99 }));
};
/** The rest: the test fixed. */
const finish = (ws: string) => editJson(join(ws, "tests", "cases.json"), (cases) => (cases[0].expect = { runCount: 0 }));

describe("a retry carries on from the failed build's workspace", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());
  /** The transcript's line where the build's workspace opened. */
  const opened = async (buildId: string) => /\[platform\] (opened.*)/.exec((await t.platform.buildTranscript(USER, buildId)) ?? "")?.[1] ?? "";

  test("a change: Retry carries on (its first attempt resumes), and Ask builder to fix too; the log says it's a retry", async () => {
    const failed = await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "add a half" }), halfDone);
    assert.equal(failed.status, "failed");
    const seen: { half: boolean; continues?: string; builder: string }[] = [];
    const look = (ws: string, job: { carriesOn?: string }) => void seen.push({ half: existsSync(join(ws, "src", "half.ts")), continues: job.carriesOn, builder: readFileSync(join(ws, "BUILDER.md"), "utf8") });
    const again = await t.build(() => t.platform.retryBuild(USER, failed.buildId), (ws, job) => (look(ws, job), halfDone(ws)));
    assert.equal(again.status, "failed");
    assert.match(await opened(again.buildId), new RegExp(`^opened from v1 \\(retry of ${failed.buildId}\\), carrying on from its workspace, builder: script$`));
    const fixed = await t.build(() => t.platform.retryBuild(USER, again.buildId, { fix: true }), (ws, job) => (look(ws, job), finish(ws)));
    assert.equal(fixed.status, "promoted", fixed.log.join("\n"));
    assert.deepEqual(seen.map(({ half, continues }) => ({ half, continues })), [
      { half: true, continues: "failed" },
      { half: true, continues: "failed" },
    ]);
    assert.match(seen[1].builder, /The previous build failed/, "BUILDER.md is the retry's: with why it failed");
  });

  test("a change retried after another change went live starts from the new version (carrying on would undo it)", async () => {
    const failed = await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "add a half" }), halfDone);
    await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "another" }), (ws) => writeFileSync(join(ws, "src", "other.ts"), "export const other = 1;\n"));
    let seen: { half: boolean; other: boolean; continues?: string } | undefined;
    const fresh = await t.build(() => t.platform.retryBuild(USER, failed.buildId), (ws, job) => void (seen = { half: existsSync(join(ws, "src", "half.ts")), other: existsSync(join(ws, "src", "other.ts")), continues: job.carriesOn }));
    assert.equal(fresh.status, "promoted", fresh.log.join("\n"));
    assert.deepEqual(seen, { half: false, other: true, continues: undefined });
    assert.match(await opened(fresh.buildId), new RegExp(`^opened from v2 \\(retry of ${failed.buildId}\\), builder: script$`));
  });

  test("Stop, then Retry: it carries on from the stopped build's workspace, told the owner stopped it (no failure to fix)", async () => {
    // The builder writes half its work, then waits until the owner stops the build.
    let wrote!: () => void;
    const halfway = new Promise<void>((r) => (wrote = r));
    t.queue(async (ws, job) => {
      writeFileSync(join(ws, "src", "half.ts"), "export const half = 1;\n");
      wrote();
      await new Promise((r) => job.signal?.addEventListener("abort", r, { once: true }));
      throw Object.assign(new Error("cancelled"), { cancelled: true });
    });
    const started = await t.platform.modify(USER, { capabilityId: "running-log", request: "add a half" });
    await halfway;
    t.platform.cancelBuild(USER, started.buildId);
    const stopped = await t.platform.settle(started.buildId);
    assert.equal(stopped.status, "cancelled");
    let seen: { half: boolean; carriesOn?: string; feedback?: string } | undefined;
    const done = await t.build(() => t.platform.retryBuild(USER, stopped.buildId), (ws, job) => void (seen = { half: existsSync(join(ws, "src", "half.ts")), carriesOn: job.carriesOn, feedback: job.feedback }));
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.deepEqual(seen, { half: true, carriesOn: "stopped", feedback: undefined });
    assert.match(await opened(done.buildId), new RegExp(`^opened from v1 \\(retry of ${stopped.buildId}\\), carrying on from its workspace, builder: script$`));
  });

  test("Stop, then Retry at once: the retry waits for the stopped builder to exit before it copies the workspace", async () => {
    // A builder slow to stop: told to, it still writes for a while, then exits.
    let wrote!: () => void;
    const halfway = new Promise<void>((r) => (wrote = r));
    t.queue(async (ws, job) => {
      writeFileSync(join(ws, "src", "half.ts"), "export const half = 1;\n");
      wrote();
      await new Promise((r) => job.signal?.addEventListener("abort", r, { once: true }));
      await new Promise((r) => setTimeout(r, 600));
      writeFileSync(join(ws, "src", "late.ts"), "export const late = 1;\n");
      throw Object.assign(new Error("cancelled"), { cancelled: true });
    });
    const started = await t.platform.modify(USER, { capabilityId: "running-log", request: "add a half" });
    await halfway;
    // Stop and Retry back to back, as the owner's two clicks can be (no settle in between).
    t.platform.cancelBuild(USER, started.buildId);
    let seen: { half: boolean; late: boolean; carriesOn?: string } | undefined;
    const done = await t.build(() => t.platform.retryBuild(USER, started.buildId), (ws, job) => void (seen = { half: existsSync(join(ws, "src", "half.ts")), late: existsSync(join(ws, "src", "late.ts")), carriesOn: job.carriesOn }));
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.deepEqual(seen, { half: true, late: true, carriesOn: "stopped" });
  });

  test("a stopped builder that never exits holds a retry only so long (the workbench's stopWaitMs); it carries on from the workspace as it is", async () => {
    t.cleanup();
    t = setup({ stopWaitMs: 300 });
    await installSeed(t.platform);
    let wrote!: () => void;
    const halfway = new Promise<void>((r) => (wrote = r));
    let exit!: () => void;
    t.queue(async (ws) => {
      writeFileSync(join(ws, "src", "half.ts"), "export const half = 1;\n");
      wrote();
      // Deaf to the Stop until the test lets it go.
      await new Promise<void>((r) => (exit = r));
      throw Object.assign(new Error("cancelled"), { cancelled: true });
    });
    const started = await t.platform.modify(USER, { capabilityId: "running-log", request: "add a half" });
    await halfway;
    t.platform.cancelBuild(USER, started.buildId);
    const t0 = Date.now();
    let waited = 0;
    let seen: { half: boolean; carriesOn?: string } | undefined;
    const done = await t.build(() => t.platform.retryBuild(USER, started.buildId), (ws, job) => void ((waited = Date.now() - t0), (seen = { half: existsSync(join(ws, "src", "half.ts")), carriesOn: job.carriesOn })));
    exit();
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.deepEqual(seen, { half: true, carriesOn: "stopped" });
    assert.ok(waited >= 300 && waited < 5000, `the retry started ${waited} ms after the Stop`);
    await t.platform.settle(started.buildId);
  });

  test("a new tool: Retry carries on from the failed create's workspace", async () => {
    const draft = (ws: string) => {
      editJson(join(ws, "capability.json"), (m) => (m.operations = [{ name: "ping", description: "ping", version: 1, sideEffect: "read", inputSchema: { type: "object", additionalProperties: false, properties: {} }, outputSchema: { type: "object" } }]));
      writeFileSync(join(ws, "src", "index.ts"), 'export const operations = { "ping@1": () => ({ pong: true }) };\n');
      writeFileSync(join(ws, "tests", "cases.json"), JSON.stringify([{ name: "ping", operation: "ping", input: {}, expect: { pong: false } }]));
    };
    const failed = await t.build(() => t.platform.create(USER, { name: "Pinger", purpose: "pings", requirements: "answer ping" }), draft);
    assert.equal(failed.status, "failed");
    let carried = false;
    const done = await t.build(
      () => t.platform.retryBuild(USER, failed.buildId),
      (ws, job) => {
        carried = !!job.carriesOn && readFileSync(join(ws, "src", "index.ts"), "utf8").includes("pong");
        writeFileSync(join(ws, "tests", "cases.json"), JSON.stringify([{ name: "ping", operation: "ping", input: {}, expect: { pong: true } }]));
      },
    );
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.ok(carried, "its first attempt saw the failed build's code");
    assert.match(await opened(done.buildId), new RegExp(`^opened \\(retry of ${failed.buildId}\\), carrying on from its workspace, builder: script$`));
  });

  test("Ask builder to fix, sent from the box: the owner's words go on a retry of the failed build (retryOf: it stays traceable), which carries on from it", async () => {
    // An agent's change that failed, then the owner's fix of it from the Change drawer.
    const failed = await t.build(() => t.platform.modify(t.claude, { capabilityId: "running-log", request: "add a half" }), halfDone);
    assert.equal(failed.status, "failed");
    let half = false;
    let builder = "";
    const fixed = await t.build(
      () => t.platform.modify(USER, { capabilityId: "running-log", request: "The test expects 99 runs; it should expect 0.", failed: failed.buildId }),
      (ws, job) => ((half = existsSync(join(ws, "src", "half.ts")) && job.carriesOn === "failed"), (builder = readFileSync(join(ws, "BUILDER.md"), "utf8")), finish(ws)),
    );
    assert.equal(fixed.status, "promoted", fixed.log.join("\n"));
    assert.ok(half, "it carried on from the failed build's workspace");
    const b = t.platform.getBuild(USER, fixed.buildId);
    assert.equal(b.requestedBy, "user", "the owner's build");
    assert.equal((b.request as { retryOf?: string }).retryOf, failed.buildId, "a retry of the agent's build: the chain is there to follow");
    assert.match(String((b.request as { request?: string }).request), /^add a half\n\n--- Fix request ---\nThe test expects 99 runs; it should expect 0\.$/);
    assert.match(builder, /The test expects 99 runs; it should expect 0\./);
    // Once: the failed build was retried.
    await assert.rejects(t.platform.modify(USER, { capabilityId: "running-log", request: "again", failed: failed.buildId }), /already retried/);
  });

  test("Ask builder to fix from the box is the owner's, on a failed build of that tool, with something in the box", async () => {
    const failed = await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "add a half" }), halfDone);
    await assert.rejects(t.platform.modify(t.claude, { capabilityId: "running-log", request: "fix it", failed: failed.buildId }), (e: any) => e.code === "forbidden");
    await assert.rejects(t.platform.modify(USER, { capabilityId: "running-log", request: "   ", failed: failed.buildId }), (e: any) => e.code === "invalid_request");
    await assert.rejects(t.platform.modify(USER, { capabilityId: "running-log", request: "fix it", failed: "b-nope" }), (e: any) => e.code === "conflict");
    await assert.rejects(t.platform.create(USER, { name: "x", purpose: "x", requirements: "fix it", failed: failed.buildId }), (e: any) => e.code === "conflict" && /isn't a new tool that failed/.test(e.message));
  });

  test("a new tool's Ask builder to fix, sent from the New page: carries on from the failed create, keeping its name", async () => {
    const draft = (ws: string) => {
      editJson(join(ws, "capability.json"), (m) => (m.operations = [{ name: "ping", description: "ping", version: 1, sideEffect: "read", inputSchema: { type: "object", additionalProperties: false, properties: {} }, outputSchema: { type: "object" } }]));
      writeFileSync(join(ws, "src", "index.ts"), 'export const operations = { "ping@1": () => ({ pong: true }) };\n');
      writeFileSync(join(ws, "tests", "cases.json"), JSON.stringify([{ name: "ping", operation: "ping", input: {}, expect: { pong: false } }]));
    };
    const failed = await t.build(() => t.platform.create(USER, { name: "Pinger", purpose: "pings", requirements: "answer ping" }), draft);
    assert.equal(failed.status, "failed");
    let carried = false;
    const done = await t.build(
      () => t.platform.create(USER, { name: "whatever the intake named it", purpose: "-", requirements: "ping should answer pong: true", failed: failed.buildId }),
      (ws, job) => {
        carried = !!job.carriesOn && readFileSync(join(ws, "src", "index.ts"), "utf8").includes("pong");
        writeFileSync(join(ws, "tests", "cases.json"), JSON.stringify([{ name: "ping", operation: "ping", input: {}, expect: { pong: true } }]));
      },
    );
    assert.equal(done.status, "promoted", done.log.join("\n"));
    assert.ok(carried);
    assert.equal(done.capabilityId, failed.capabilityId);
    assert.equal((t.platform.getBuild(USER, done.buildId).request as { retryOf?: string }).retryOf, failed.buildId);
  });
});
