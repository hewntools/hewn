// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import { PlatformError } from "@hewntools/core/errors.ts";
import { installSeed, setup } from "./helpers.ts";

const HOUR = 3600_000;
const code = (c: string) => (e: unknown) => e instanceof PlatformError && e.code === c;

describe("schedules", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await installSeed(t.platform);
  });
  afterEach(() => t.cleanup());

  const runs = async () => ((await t.platform.invoke(USER, { capabilityId: "running-log", operation: "list_runs" })).result as any).runs;

  test("the owner's schedule runs when due, as schedule:<id>, and shows in the call log", async () => {
    const s = t.platform.createSchedule(USER, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: 1, durationSeconds: 300 }, cadence: "hourly" });
    assert.equal(s.status, "active");
    assert.ok(s.nextRunAt! > Date.now() && s.nextRunAt! <= Date.now() + HOUR);
    assert.deepEqual(await t.platform.runDueSchedules(Date.now()), [], "not due yet");
    assert.deepEqual(await t.platform.runDueSchedules(s.nextRunAt!), [{ id: s.id, ok: true }]);
    assert.equal((await runs()).length, 1);
    const after = t.platform.listSchedules(USER)[0];
    assert.equal(after.lastOutcome, "ok");
    assert.ok(after.nextRunAt! > s.nextRunAt!, "next run moved on");
    assert.match(t.platform.logLines("running-log", 10).join("\n"), new RegExp(`schedule:${s.id} record_run@1 ok`));
  });

  test("agents can only propose; a proposal never runs until the owner enables it", async () => {
    const p = t.platform.proposeSchedule(t.codex, { capabilityId: "running-log", operation: "get_summary", cadence: "daily 07:00", note: "morning summary" });
    assert.equal(p.status, "proposed");
    assert.equal(p.nextRunAt, null);
    assert.deepEqual(await t.platform.runDueSchedules(Date.now() + 48 * HOUR), []);
    assert.throws(() => t.platform.updateSchedule(t.claude, p.id, { status: "active" }), code("forbidden"));
    assert.throws(() => t.platform.createSchedule(t.claude, { capabilityId: "running-log", operation: "get_summary", cadence: "hourly" }), code("forbidden"));
    const on = t.platform.updateSchedule(USER, p.id, { status: "active" });
    assert.ok(on.nextRunAt);
    assert.ok(t.platform.registry.lifecycleEvents().some((e) => e.action === "schedule" && /enabled/.test(e.detail)));
  });

  test("repeated failures pause the schedule, with the reason", async () => {
    const s = t.platform.createSchedule(USER, { capabilityId: "running-log", operation: "record_run", input: { distanceKm: 1, durationSeconds: 300, date: "2026-10-01" }, cadence: "hourly" });
    // Break it: the capability goes away (archived) so every run fails.
    t.platform.archive(USER, "running-log");
    for (let i = 0; i < 3; i++) await t.platform.runDueSchedules(Date.now() + (i + 1) * 2 * HOUR);
    const after = t.platform.schedules.get(s.id)!;
    assert.equal(after.status, "paused");
    assert.equal(after.failures, 3);
    assert.match(after.pausedReason!, /3 failures/);
    assert.equal(t.platform.nextScheduleAt(), null);
  });

  test("only read and write operations; bad cadences and inputs are refused", async () => {
    assert.throws(() => t.platform.createSchedule(USER, { capabilityId: "running-log", operation: "record_run", input: {}, cadence: "hourly" }), code("invalid_input"));
    assert.throws(() => t.platform.createSchedule(USER, { capabilityId: "running-log", operation: "get_summary", cadence: "* * * * *" }), /at most every 5 minutes/);
    assert.throws(() => t.platform.createSchedule(USER, { capabilityId: "running-log", operation: "get_summary", cadence: "sometimes" }), /cadence must be/);
    assert.throws(() => t.platform.createSchedule(USER, { capabilityId: "running-log", operation: "nope", cadence: "hourly" }), code("not_found"));
  });
});
