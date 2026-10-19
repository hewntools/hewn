// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { explainFailure, testCounts } from "@hewntools/core/failure.ts";

describe("plain-language build failures", () => {
  test("failing tests: counts and the first cause", () => {
    const log = [
      "attempt 3: validating candidate",
      "attempt 3: FAILED: 2 of 6 test cases failed:\n  - test 'log_progress caps pages': expected {\"pages\":300}, got {\"pages\":350}\n  - test 'stats': expected an error, got {}",
      "FAILED: no valid candidate after 3 attempts",
    ];
    assert.deepEqual(explainFailure(log), {
      title: "2 of 6 tests didn't pass",
      detail: "log_progress caps pages didn't return what its test expected.",
      attempt: 3,
      maxAttempts: 3,
    });
    assert.deepEqual(testCounts(log), { passed: 4, total: 6 });
  });

  test("builder unavailable, restarts, contract breaks", () => {
    assert.equal(explainFailure(["attempt 1: builder codex failed: not logged in", "FAILED: builder codex is unavailable. Fix it, then retry this build."]).title, "The builder isn't available");
    assert.equal(explainFailure(["FAILED: interrupted by platform restart"]).title, "Interrupted by a restart");
    const breaking = explainFailure(["FAILED: breaking change to a published operation contract (add a new operation version instead):\n  - record_run@1 input $.date: type changed"]);
    assert.equal(breaking.title, "It would break existing callers");
    assert.equal(breaking.detail, "record_run@1 input $.date: type changed");
  });

  test("a builder that kept crashing, with no validation run", () => {
    const f = explainFailure(["attempt 1: builder claude failed: exit 1", "attempt 2: builder claude failed: exit 1", "FAILED: no valid candidate after 2 attempts"]);
    assert.deepEqual(f, { title: "The builder stopped", detail: "exit 1", attempt: 2, maxAttempts: 2 });
  });

  test("passing validation counts", () => assert.deepEqual(testCounts(["6 test cases passed"]), { passed: 6, total: 6 }));
});

describe("streamed intake replies", () => {
  test("message and questions are read from incomplete JSON as it arrives", async () => {
    const { partialReply } = await import("@hewntools/cli/intake.ts");
    assert.deepEqual(partialReply('{"kind":"questions","message":"Some'), { message: "Some" });
    assert.deepEqual(partialReply('{"kind":"questions","message":"Hi \\"you\\"\\n","questions":["One?","Tw'), { message: 'Hi "you"\n', questions: ["One?", "Tw"] });
    assert.deepEqual(partialReply('{"kind":"draft"'), {});
  });
});
