// SPDX-License-Identifier: AGPL-3.0-or-later
// Try it: a held build's screen on a copy of the owner's data. Writes stay in the copy, no schedule runs on it, and it
// goes when the owner decides or its hour is up (by the wall clock, also when the hour passed while Hewn was down).
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { TRY_MS } from "@hewntools/core/platform/trying.ts";
import { FIXTURES, installFrom, setup } from "./helpers.ts";

describe("Try it on a held build", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installFrom(t.platform, join(FIXTURES, "ui-counter"));
    await t.platform.invoke(USER, { capabilityId: "ui-counter", operation: "increment" });
  });
  afterEach(() => t.cleanup());

  /** An agent's change to the counter, held for the owner. */
  const held = async () => {
    t.queue((ws) => appendFileSync(join(ws, "src", "index.ts"), "\n// changed\n"));
    const b = await t.platform.settle((await t.platform.modify(t.claude, { capabilityId: "ui-counter", request: "a comment" })).buildId);
    assert.equal(b.status, "review", b.log.join("\n"));
    return b.buildId;
  };
  const count = async () => (await t.platform.invoke(USER, { capabilityId: "ui-counter", operation: "get" })).result as { count: number };
  const tries = async () => (await t.platform.runtime.listStates("ui-counter", "")).filter((s) => s.startsWith("try"));

  test("it runs the candidate on a copy of the owner's data: a write stays in the copy; only the owner opens it", async () => {
    const id = await held();
    await assert.rejects(t.platform.tryBuild(t.claude, id), (e: any) => e.code === "forbidden");
    const opened = await t.platform.tryBuild(USER, id);
    assert.ok(opened.ticket && opened.key && opened.endsAt > Date.now() + TRY_MS - 60_000);
    // The copy starts as the owner's data is: one tap.
    assert.deepEqual((await t.platform.tryInvoke(id, { operation: "get" })).result, await count());
    await t.platform.tryInvoke(id, { operation: "increment" });
    await t.platform.tryInvoke(id, { operation: "increment" });
    assert.equal(((await t.platform.tryInvoke(id, { operation: "get" })).result as { count: number }).count, (await count()).count + 2);
    assert.equal((await count()).count, 1, "the owner's own data is as it was");
    // Opened again: the same copy, a new ticket.
    const again = await t.platform.tryBuild(USER, id);
    assert.equal(again.key, opened.key);
    assert.equal(((await t.platform.tryInvoke(id, { operation: "get" })).result as { count: number }).count, 3);
  });

  test("a call in it is the owner's activity, and never a change a backup should keep", async () => {
    const id = await held();
    await t.platform.tryBuild(USER, id);
    const before = t.platform.idleActivity();
    await t.platform.tryInvoke(id, { operation: "increment" });
    const after = t.platform.idleActivity();
    assert.ok((after.lastCallAt ?? 0) >= Date.now() - 5000, "the call counts");
    assert.equal(after.changedAt, before.changedAt, "the copy's write isn't one to back up");
  });

  test("no schedule runs on the copy", async () => {
    const id = await held();
    await t.platform.tryBuild(USER, id);
    const s = t.platform.createSchedule(USER, { capabilityId: "ui-counter", operation: "increment", cadence: "daily 07:00" });
    await t.platform.runDueSchedules(Date.parse(s.nextRunAt as unknown as string) || (s.nextRunAt as number));
    assert.equal((await count()).count, 2, "it ran on the live tool");
    assert.equal(((await t.platform.tryInvoke(id, { operation: "get" })).result as { count: number }).count, 1, "not on the copy");
  });

  test("it goes when the owner decides: allowed, or not", async () => {
    for (const decide of ["approveBuild", "rejectBuild"] as const) {
      const id = await held();
      await t.platform.tryBuild(USER, id);
      assert.equal((await tries()).length, 1);
      await t.platform[decide](USER, id);
      assert.deepEqual(await tries(), [], `${decide}: the copy is gone`);
      assert.equal(await t.platform.tryKey(id), undefined);
      await assert.rejects(t.platform.tryInvoke(id, { operation: "get" }), (e: any) => e.code === "not_found");
    }
  });

  test("it goes after an hour by the wall clock, also when the hour passed while Hewn was down", async () => {
    const id = await held();
    await t.platform.tryBuild(USER, id);
    await t.platform.sweepTries(Date.now() + TRY_MS - 60_000);
    assert.equal((await tries()).length, 1, "within its hour");
    // Hewn starts again (or wakes) past the hour: the start's cleanup sweeps it before anything is served.
    await t.platform.cleanup(Date.now() + TRY_MS + 1);
    assert.deepEqual(await tries(), []);
    assert.equal(await t.platform.tryKey(id), undefined);
  });
});
