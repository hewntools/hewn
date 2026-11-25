// SPDX-License-Identifier: AGPL-3.0-or-later
// A schedule after the machine wakes from sleep. workerd's alarm waits on a clock that stops while the machine
// sleeps, and re-arming it for the same time changes nothing: woken a little before a schedule's time (as a host
// that suspends Hewn wakes it, or a laptop's lid opened), the alarm would fire that much later than the time. The
// supervisor's resume check runs it by the wall clock instead. Here the wall clock is the test's (`wall`), and the
// alarm is armed hours ahead in real time, so it never fires: whatever runs, the resume check ran.
import assert from "node:assert/strict";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { after, before, describe, test } from "node:test";
import { ALARM_GRACE_MS } from "@hewntools/cli/supervisor/index.ts";
import { FIXTURES } from "./helpers.ts";
import { startTestHost, type TestHost } from "./workerd-helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600_000;
/** "HH:MM" (owner's time zone, the machine's here) `hours` from now, for a daily cadence. */
const clock = (hours: number) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(Date.now() + hours * HOUR));
/** Wait until `fn` holds, at most `ms`; whether it did. */
async function until(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (await fn()) return true;
  return fn();
}

describe("a schedule after the machine wakes from sleep (workerd host)", () => {
  let h: TestHost;
  let offset = 0;
  /** Event-loop busy time added to the real one: a gap the loop was busy for (a big backup, a debugger's pause). */
  let busyOffset = 0;
  // A look every 50 ms; a jump is a resume past 10 minutes (the wall clock is walked in smaller steps). The monotonic
  // clock runs on with the wall clock, as macOS's may through a sleep: only the gap between looks shows one.
  const JUMP = 600_000;
  const log: string[] = [];
  before(async () => {
    h = await startTestHost({ resume: { intervalMs: 50, jumpMs: JUMP, recheckMs: HOUR, wall: () => Date.now() + offset, mono: () => performance.now() + offset, busy: () => performance.eventLoopUtilization().active + busyOffset }, log: (l) => void log.push(l) });
    const r = await h.sv.admin("install", { name: "Runaway", purpose: "runs on", dir: join(FIXTURES, "runaway"), wait: true });
    assert.equal(r.status, "promoted", r.log.join("\n"));
  });
  after(() => h?.stop());

  const rows = async (tag: string): Promise<number> => (await h.invoke("runaway", "count")).result.rows[tag] ?? 0;
  const schedule = async (id: string) => (await h.sv.admin("schedules", { capabilityId: "runaway" })).find((x: any) => x.id === id);
  const backups = async (): Promise<unknown[]> => (await (await fetch(`${h.sv.control.url}/control/backups`, { method: "POST", headers: { "x-hewn-control": h.sv.control.token } })).json()).backups;
  /** The wall clock to `at` (ms), at once: the machine woke there. */
  const wake = (at: number) => void (offset = at - Date.now());
  /** The wall clock on to `at` (ms) in steps under a jump, as time passing. */
  const walk = async (at: number) => {
    for (let wall = Date.now() + offset; wall < at; wall = Date.now() + offset) {
      offset += Math.min(JUMP / 2, at - wall);
      await sleep(60);
    }
  };

  test("woken a minute before a schedule's time, it runs when the time comes, within a look, and once", async () => {
    const s = await h.sv.admin("schedules", { capabilityId: "runaway", operation: "tick", input: { tag: "on-time" }, cadence: `daily ${clock(10)}` });
    try {
      const at: number = (await schedule(s.id)).nextRunAt;
      assert.ok(at - Date.now() > HOUR, "its alarm is armed hours ahead in real time: it can't fire here");
      wake(at - 60_000);
      // The wake's catch-up has replied once it has made the day's backup (this home has none yet).
      assert.ok(await until(async () => (await backups()).length > 0, 5000), "the wake's catch-up ran");
      // Its time, by the platform's clock too; the alarm stays armed hours ahead.
      await h.sv.admin("schedules/fire", { id: s.id, arm: false });
      await sleep(300);
      assert.equal(await rows("on-time"), 0, "not before its time");
      await walk(at + ALARM_GRACE_MS);
      assert.ok(await until(async () => (await rows("on-time")) === 1, 1000), "run within a look of its time and the grace");
      // hewn.log: the wake (a gap between looks, by the wall clock and the monotonic one alike), and what the late alarm's look ran.
      assert.ok(log.some((l) => /^tick gap: \d+s by the wall clock, \d+s by the monotonic one$/.test(l)), log.join("\n"));
      assert.ok(log.some((l) => /^\d+s passed between two looks \(\d+s by the monotonic clock; the machine slept, or Hewn was suspended\): resumed; catching up$/.test(l)), log.join("\n"));
      assert.ok(await until(async () => log.some((l) => l === `the schedule due ${new Date(at).toISOString()} ran by the wall clock (its alarm was late): runaway/tick (ok)`), 1000), log.join("\n"));
      // Due again (the platform's clock hasn't moved), while the next time the supervisor knows is that same time: no second run for it.
      await h.sv.admin("schedules/fire", { id: s.id, arm: false });
      await walk(at + 2 * HOUR);
      await sleep(300);
      assert.equal(await rows("on-time"), 1, "once for its time");
    } finally {
      // Gone, so the next test's schedule is the next alarm.
      await h.sv.admin("call", { method: "deleteSchedule", args: [s.id] });
    }
  });

  test("a schedule changed after the wake: the time the supervisor kept may be early, and that look's reply moves it on", async () => {
    const s = await h.sv.admin("schedules", { capabilityId: "runaway", operation: "tick", input: { tag: "changed" }, cadence: `daily ${clock(16)}` });
    const first: number = (await schedule(s.id)).nextRunAt;
    wake(first - 60_000);
    // Later by an hour: workerd's alarm is armed again, for a new time (that one would fire right).
    await h.sv.admin("schedules", { id: s.id, change: { cadence: `daily ${clock(17)}` } });
    const later: number = (await schedule(s.id)).nextRunAt;
    assert.ok(later > first);
    await walk(first + ALARM_GRACE_MS + 5_000);
    await sleep(300);
    assert.equal(await rows("changed"), 0, "the look at the old time ran nothing");
    await h.sv.admin("schedules/fire", { id: s.id, arm: false });
    await walk(later + ALARM_GRACE_MS);
    assert.ok(await until(async () => (await rows("changed")) === 1, 1000), "run at the new time: the old time's reply moved the supervisor's on");
  });

  test("a gap the event loop was busy for (a big backup, a debugger's pause) isn't a wake", async () => {
    const before = log.length;
    // The wall clock and the loop's busy time move on together: the process ran, it was only busy.
    offset += 2 * JUMP;
    busyOffset += 2 * JUMP;
    await sleep(400);
    const lines = log.slice(before);
    assert.ok(!lines.some((l) => /passed between two looks|^tick gap/.test(l)), lines.join("\n"));
  });
});
