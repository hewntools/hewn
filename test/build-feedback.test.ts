// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { editText, SEED, setup } from "./helpers.ts";

const seed = (ws: string) => cpSync(SEED, ws, { recursive: true });

describe("build feedback: Got what you asked for?", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));
  afterEach(() => t.cleanup());

  test("yes, no with a note, or skip; once live only; owner only; shown with the build's context; gone with a purge", async () => {
    const b = await t.build(() => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r" }), seed);
    assert.equal(b.status, "promoted", b.log.join("\n"));
    assert.equal(t.platform.buildContext(USER, b.buildId).feedback, undefined);
    const no = t.platform.setBuildFeedback(USER, b.buildId, { score: "no", note: "  pace is wrong  " });
    assert.equal(no.score, "no");
    assert.equal(no.note, "pace is wrong");
    assert.ok(no.at);
    assert.deepEqual(t.platform.buildContext(USER, b.buildId).feedback, no);
    // A later answer replaces it (the note goes when there is none).
    assert.deepEqual(t.platform.setBuildFeedback(USER, b.buildId, { score: "yes" }).note, undefined);
    assert.throws(() => t.platform.setBuildFeedback(USER, b.buildId, { score: "meh" }), /score must be/);
    assert.throws(() => t.platform.setBuildFeedback(USER, b.buildId, { score: "no", note: "x".repeat(1001) }), /at most 1000/);
    assert.throws(() => t.platform.setBuildFeedback(t.claude, b.buildId, { score: "yes" }), /owner actions/);
    assert.throws(() => t.platform.setBuildFeedback(USER, "b-nope", { score: "yes" }), /no build/);
    // Not for a build that didn't go live.
    const failed = await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "break it" }), (ws) => editText(`${ws}/src/index.ts`, (s) => s.replace("runCount: r.n,", "runCount: r.n + 1,")));
    assert.equal(failed.status, "failed");
    assert.throws(() => t.platform.setBuildFeedback(USER, failed.buildId, { score: "yes" }), /isn't live/);
    t.platform.archive(USER, "running-log");
    await t.platform.purge(USER, "running-log", "running-log");
    assert.equal(t.platform.registry.buildFeedback(b.buildId), undefined);
  });

  test("the report: what each build ran on, attempts, how it ended, the answer, and the signs in the record", async () => {
    // v1 live; a failed change that is then fixed (a retry); a change soon after; a restore to v1.
    const first = await t.build(() => t.platform.create(USER, { name: "Running Log", purpose: "runs", requirements: "r" }), seed);
    t.platform.setBuildFeedback(USER, first.buildId, { score: "yes" });
    const broken = await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "break it" }), (ws) => editText(`${ws}/src/index.ts`, (s) => s.replace("runCount: r.n,", "runCount: r.n + 1,")));
    assert.equal(broken.status, "failed");
    t.queue(() => {});
    const fixed = await t.platform.settle((await t.platform.retryBuild(USER, broken.buildId, { fix: true })).buildId);
    assert.equal(fixed.status, "promoted", fixed.log.join("\n"));
    t.platform.setBuildFeedback(USER, fixed.buildId, { score: "no", note: "still wrong" });
    const third = await t.build(() => t.platform.modify(USER, { capabilityId: "running-log", request: "add notes" }), () => {});
    assert.equal(third.status, "promoted");
    await t.platform.rollback(USER, "running-log", 1);

    const report = t.platform.buildReport(USER);
    assert.equal(report.days, 30);
    const rows = report.builds;
    assert.deepEqual(
      rows.map((r) => r.buildId),
      [third.buildId, fixed.buildId, broken.buildId, first.buildId],
      "newest first",
    );
    const by = Object.fromEntries(rows.map((r) => [r.buildId, r]));
    assert.equal(by[first.buildId].kind, "create");
    assert.equal(by[first.buildId].builder, "script");
    assert.match(by[first.buildId].brief!, /^(\d+\.\d+\.\d+\+)?[0-9a-f]{12}$/);
    assert.equal(by[first.buildId].attempts, 1);
    assert.equal(by[first.buildId].feedback?.score, "yes");
    assert.deepEqual(by[first.buildId].signals, { fixed: false, changedSoon: true, restored: false, deletedSoon: false }, "the next change came within a day");
    assert.equal(by[broken.buildId].status, "failed");
    assert.match(by[broken.buildId].failure!, /test/);
    assert.equal(by[broken.buildId].signals.fixed, true, "it was retried");
    assert.deepEqual(by[fixed.buildId].feedback, { score: "no", note: "still wrong", at: by[fixed.buildId].feedback!.at });
    assert.equal(by[fixed.buildId].signals.changedSoon, true);
    assert.equal(by[third.buildId].signals.restored, true, "v3 was rolled back to v1 within a week");
    assert.equal(by[third.buildId].signals.changedSoon, false);
    // Owner only; the window is the owner's, within a day and a year, and the report says which it used.
    assert.throws(() => t.platform.buildReport(t.claude), /owner actions/);
    const narrow = t.platform.buildReport(USER, { days: 0.0001 });
    assert.equal(narrow.days, 1, "the window is at least a day");
    assert.equal(narrow.builds.length, 4);
    assert.equal(t.platform.buildReport(USER, { days: 1000 }).days, 365);
    // Deleting the tool within a day of a build going live is a sign on that build.
    t.platform.archive(USER, "running-log");
    const gone = Object.fromEntries(t.platform.buildReport(USER).builds.map((r) => [r.buildId, r.signals.deletedSoon]));
    assert.equal(gone[third.buildId], true);
    assert.equal(gone[broken.buildId], false, "a failed build didn't go live, so it wasn't deleted soon after");
  });
});
