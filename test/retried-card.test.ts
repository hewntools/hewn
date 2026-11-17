// SPDX-License-Identifier: AGPL-3.0-or-later
// A failed (or stopped) build that was retried says by which build, and how that one stands, so its card offers
// no Retry or Ask builder to fix that would only be refused (#88).
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { editJson, installSeed, setup } from "./helpers.ts";

const breakTests = (ws: string) => editJson(join(ws, "tests", "cases.json"), (cases) => (cases[0].expect = { runCount: 99 }));

describe("a retried build says by which build", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());

  test("failed, retried, the retry failed and was retried, that one promoted: the first build names the newest, promoted as v2", async () => {
    const first = await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "a change" }), breakTests);
    assert.equal(first.status, "failed");
    assert.equal(t.platform.getBuild(USER, first.buildId).retriedAs, undefined, "not retried yet");
    const second = await t.build(() => t.platform.retryBuild(USER, first.buildId), breakTests);
    assert.deepEqual(t.platform.getBuild(USER, first.buildId).retriedAs, { id: second.buildId, status: "failed" });
    // Fixed for real (a retry may carry on from the broken workspace).
    const third = await t.build(() => t.platform.retryBuild(USER, second.buildId, { fix: true }), (ws) => editJson(join(ws, "tests", "cases.json"), (cases) => (cases[0].expect = { runCount: 0 })));
    assert.equal(third.status, "promoted", third.log.join("\n"));
    for (const b of [first, second]) {
      const view = t.platform.getBuild(USER, b.buildId);
      assert.deepEqual(view.retriedAs, { id: third.buildId, status: "promoted", version: 2 });
      assert.match(view.instructions!, new RegExp(`^Retried as build ${third.buildId} \\(promoted\\)\\.`));
    }
    assert.equal(t.platform.getBuild(USER, third.buildId).retriedAs, undefined);
  });
});
