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
    const seen: { half: boolean; continues?: boolean; builder: string }[] = [];
    const look = (ws: string, job: { carriesOn?: boolean }) => void seen.push({ half: existsSync(join(ws, "src", "half.ts")), continues: job.carriesOn, builder: readFileSync(join(ws, "BUILDER.md"), "utf8") });
    const again = await t.build(() => t.platform.retryBuild(USER, failed.buildId), (ws, job) => (look(ws, job), halfDone(ws)));
    assert.equal(again.status, "failed");
    assert.match(await opened(again.buildId), new RegExp(`^opened from v1 \\(retry of ${failed.buildId}\\), carrying on from its workspace, builder: script$`));
    const fixed = await t.build(() => t.platform.retryBuild(USER, again.buildId, { fix: true }), (ws, job) => (look(ws, job), finish(ws)));
    assert.equal(fixed.status, "promoted", fixed.log.join("\n"));
    assert.deepEqual(seen.map(({ half, continues }) => ({ half, continues })), [
      { half: true, continues: true },
      { half: true, continues: true },
    ]);
    assert.match(seen[1].builder, /The previous build failed/, "BUILDER.md is the retry's: with why it failed");
  });

  test("a change retried after another change went live starts from the new version (carrying on would undo it)", async () => {
    const failed = await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "add a half" }), halfDone);
    await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "another" }), (ws) => writeFileSync(join(ws, "src", "other.ts"), "export const other = 1;\n"));
    let seen: { half: boolean; other: boolean; continues?: boolean } | undefined;
    const fresh = await t.build(() => t.platform.retryBuild(USER, failed.buildId), (ws, job) => void (seen = { half: existsSync(join(ws, "src", "half.ts")), other: existsSync(join(ws, "src", "other.ts")), continues: job.carriesOn }));
    assert.equal(fresh.status, "promoted", fresh.log.join("\n"));
    assert.deepEqual(seen, { half: false, other: true, continues: undefined });
    assert.match(await opened(fresh.buildId), new RegExp(`^opened from v2 \\(retry of ${failed.buildId}\\), builder: script$`));
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
});
