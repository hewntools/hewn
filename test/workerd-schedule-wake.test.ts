// SPDX-License-Identifier: AGPL-3.0-or-later
// A schedule after the machine wakes from sleep. workerd's alarm waits on a clock that stops while the machine
// sleeps, and re-arming it for the same time changes nothing: woken a little before a schedule's time (as a host
// that suspends Hewn wakes it, or a laptop's lid opened), the alarm would fire that much later than the time. The
// supervisor's resume check runs it by the wall clock instead. Here the wall clock is the test's (`wall`), and the
// alarm is armed hours ahead in real time, so it never fires: whatever runs, the resume check ran.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { FIXTURES } from "./helpers.ts";
import { startTestHost, type TestHost } from "./workerd-helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600_000;
/** "HH:MM" (owner's time zone, the machine's here) `hours` from now, for a daily cadence. */
const clock = (hours: number) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(Date.now() + hours * HOUR));

describe("a schedule after the machine wakes from sleep (workerd host)", () => {
  let h: TestHost;
  let offset = 0;
  // A look every 50 ms; a jump is a resume past 10 minutes (the wall clock is walked in smaller steps).
  const JUMP = 600_000;
  before(async () => {
    h = await startTestHost({ resume: { intervalMs: 50, jumpMs: JUMP, recheckMs: HOUR, wall: () => Date.now() + offset } });
    const r = await h.sv.admin("install", { name: "Runaway", purpose: "runs on", dir: join(FIXTURES, "runaway"), wait: true });
    assert.equal(r.status, "promoted", r.log.join("\n"));
  });
  after(() => h?.stop());

  const rows = async (tag: string): Promise<number> => (await h.invoke("runaway", "count")).result.rows[tag] ?? 0;
  const schedule = async (id: string) => (await h.sv.admin("schedules", { capabilityId: "runaway" })).find((x: any) => x.id === id);
  /** The wall clock to `at` (ms), at once: the machine woke there. */
  const wake = async (at: number) => {
    offset = at - Date.now();
    await sleep(300);
  };
  /** The wall clock on to `at` (ms) in steps under a jump, as time passing. */
  const walk = async (at: number) => {
    for (let wall = Date.now() + offset; wall < at; wall = Date.now() + offset) {
      offset += Math.min(JUMP / 2, at - wall);
      await sleep(60);
    }
  };

  test("woken a minute before a schedule's time, it runs when the time comes, within a look, and once", async () => {
    const s = await h.sv.admin("schedules", { capabilityId: "runaway", operation: "tick", input: { tag: "on-time" }, cadence: `daily ${clock(10)}` });
    const at: number = (await schedule(s.id)).nextRunAt;
    await wake(at - 60_000);
    // Its time, by the platform's clock too; the alarm stays armed hours ahead (it doesn't fire here).
    await h.sv.admin("schedules/fire", { id: s.id, arm: false });
    await sleep(300);
    assert.equal(await rows("on-time"), 0, "not before its time");
    await walk(at + 5_000);
    let n = 0;
    for (let i = 0; i < 40 && !n; i++, await sleep(50)) n = await rows("on-time");
    assert.equal(n, 1, "run within a look of its time");
    await walk(at + 2 * HOUR);
    await sleep(300);
    assert.equal(await rows("on-time"), 1, "once");
    // Gone, so the next test's schedule is the next alarm (this one's next run is still ahead in real time).
    await h.sv.admin("call", { method: "deleteSchedule", args: [s.id] });
  });

  test("a schedule changed after the wake: the time the supervisor kept may be early, and that look's reply moves it on", async () => {
    const s = await h.sv.admin("schedules", { capabilityId: "runaway", operation: "tick", input: { tag: "changed" }, cadence: `daily ${clock(16)}` });
    const first: number = (await schedule(s.id)).nextRunAt;
    await wake(first - 60_000);
    // Later by an hour: workerd's alarm is armed again, for a new time (that one would fire right).
    await h.sv.admin("schedules", { id: s.id, change: { cadence: `daily ${clock(17)}` } });
    const later: number = (await schedule(s.id)).nextRunAt;
    assert.equal(later - first, HOUR);
    await walk(first + 10_000);
    await sleep(300);
    assert.equal(await rows("changed"), 0, "nothing due at the old time");
    await h.sv.admin("schedules/fire", { id: s.id, arm: false });
    await walk(later + 5_000);
    let n = 0;
    for (let i = 0; i < 40 && !n; i++, await sleep(50)) n = await rows("changed");
    assert.equal(n, 1, "run at the new time");
  });
});
