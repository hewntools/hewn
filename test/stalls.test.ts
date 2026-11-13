// SPDX-License-Identifier: AGPL-3.0-or-later
// Stalls: what was running when Hewn stopped responding, told so after the restart, and a tool that
// does it 3 times within an hour suspended until the owner resumes it. (On workerd, with a real
// stall and the watchdog: workerd-runaway.test.ts.)
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { USER } from "@hewntools/core/auth.ts";
import type { Platform } from "@hewntools/core/platform.ts";
import { nodePlatform } from "@hewntools/test-host/index.ts";
import { FIXTURES, installFrom, installSeed, setup } from "./helpers.ts";

const code = (p: Platform, capabilityId: string, what: string, state = "", caller = "codex") => p.registry.codeStarted({ capabilityId, state, what, caller });
const running = (p: Platform) => p.registry.db.prepare("SELECT capability_id, state, what, caller FROM running_code").all().map((r) => ({ ...r }));
const stalled = (p: Platform, id: string) => p.logLines(id, 100).filter((l) => / ERROR stalled: /.test(l));
const min = (n: number) => new Date(Date.parse("2026-11-11T10:00:00.000Z") + n * 60_000).toISOString();

describe("stalls", () => {
  let t: ReturnType<typeof setup>;
  const restarted: Platform[] = [];
  /** A new platform on the same home: Hewn after a restart (`stalledAt`: the watchdog's, if it was one). */
  const restart = (stalledAt?: string) => {
    const p = nodePlatform(t.home);
    restarted.push(p);
    return { p, out: p.recoverStall(stalledAt) };
  };
  beforeEach(async () => {
    t = setup();
    await installFrom(t.platform, join(FIXTURES, "runaway"));
    await installSeed(t.platform);
  });
  afterEach(() => {
    for (const p of restarted.splice(0)) p.close();
    t.cleanup();
  });

  test("a call is written down while it runs, and only then", async () => {
    const call = t.platform.invoke(t.codex, { capabilityId: "runaway", operation: "slow", input: { ms: 200 } });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(running(t.platform), [{ capability_id: "runaway", state: "", what: "slow@1", caller: "codex" }]);
    await call;
    assert.deepEqual(running(t.platform), []);
    await assert.rejects(t.platform.invoke(t.codex, { capabilityId: "runaway", operation: "tick", input: { tag: 1 } }), /invalid_input|inputSchema/);
    assert.deepEqual(running(t.platform), [], "a call refused before it runs isn't written down");
  });

  test("after a restart for a stall, each tool that was running is told so in its log and Activity, once; after another restart, nothing is", () => {
    code(t.platform, "runaway", "spin@1");
    code(t.platform, "runaway", "count@1", "", "schedule:sch-1");
    code(t.platform, "running-log", "list_runs@1", "", "claude-code → run-feeder");
    // Not a build's, not the tool's own data: only cleared.
    code(t.platform, "running-log", "list_runs@1", "backup:before-v2");
    const other = restart();
    assert.deepEqual(other.out, { tools: [], suspended: [], builds: [] }, "a restart that wasn't for a stall blames nothing");
    assert.deepEqual(running(other.p), [], "and clears what was written down");
    assert.deepEqual(stalled(other.p, "runaway"), []);

    code(other.p, "runaway", "spin@1");
    code(other.p, "runaway", "count@1", "", "schedule:sch-1");
    code(other.p, "running-log", "list_runs@1", "", "claude-code → run-feeder");
    const { p, out } = restart(min(0));
    assert.deepEqual(out, { tools: ["runaway", "running-log"], suspended: [], builds: [] });
    assert.equal(stalled(p, "runaway").length, 2);
    assert.match(stalled(p, "runaway").join("\n"), /^\S+ codex spin@1 ERROR stalled: Hewn stopped responding while this ran and was restarted \d+ms$/m);
    assert.match(stalled(p, "running-log")[0], / claude-code → run-feeder list_runs@1 ERROR stalled: /);
    assert.deepEqual(p.registry.lifecycleEvents().filter((e) => e.action === "stalled").map((e) => [e.capabilityId, e.detail, e.actor]).sort(), [["runaway", "count@1", "hewn"], ["runaway", "spin@1", "hewn"], ["running-log", "list_runs@1", "hewn"]]);
    assert.equal(p.readiness("runaway").ready, true, "once isn't enough to suspend it");
    // The same stall, said again (a restart of the restart): nothing more.
    code(p, "runaway", "spin@1");
    assert.deepEqual(restart(min(0)).out.tools, []);
  });

  test("3 stalls within an hour suspend a tool; spread wider, they don't", () => {
    let p = t.platform;
    const stall = (at: number) => {
      code(p, "runaway", "spin@1");
      const r = restart(min(at));
      p = r.p;
      return r.out;
    };
    assert.deepEqual(stall(0).suspended, []);
    assert.deepEqual(stall(40).suspended, []);
    assert.deepEqual(stall(70).suspended, [], "the first was more than an hour before the third");
    assert.equal(p.suspension("runaway"), undefined);
    assert.deepEqual(stall(80).suspended, ["runaway"]);
    assert.deepEqual(p.suspension("runaway"), { at: min(80), reason: "it kept Hewn from responding 3 times within an hour" });
    assert.deepEqual(stall(81).suspended, [], "suspended once");
    assert.equal(p.suspension("running-log"), undefined, "only the tool that was running");
  });

  test("a suspended tool's calls, widgets and schedules are refused, saying why, until the owner resumes it", async () => {
    let p = t.platform;
    const s = p.createSchedule(USER, { capabilityId: "runaway", operation: "tick", input: { tag: "scheduled" }, cadence: "hourly" });
    for (const at of [0, 1, 2]) {
      code(p, "runaway", "spin@1");
      p = restart(min(at)).p;
    }
    const st = p.readiness("runaway");
    assert.equal(st.ready, false);
    assert.deepEqual(st.suspended, { at: min(2), reason: "it kept Hewn from responding 3 times within an hour" });
    assert.match(st.userAction!, /^Hewn suspended it: it kept Hewn from responding 3 times within an hour\. It runs again once the owner resumes it .*hewn resume runaway/);
    assert.equal(p.list(t.codex).find((c) => c.id === "runaway")?.ready, false);
    await assert.rejects(p.invoke(t.codex, { capabilityId: "runaway", operation: "tick", input: { tag: "x" } }), (e: any) => e.code === "not_ready" && /^runaway is suspended: it kept Hewn from responding 3 times within an hour\. It runs again once the owner resumes it$/.test(e.message) && !!e.details.suspended);
    await assert.rejects(p.widget(USER, "runaway", "rows"), /runaway is suspended/);
    p.schedules.update(s.id, { nextRunAt: Date.now() - 1000 });
    await p.runDueSchedules();
    const refused = p.listSchedules(USER, "runaway")[0];
    assert.match(refused.lastOutcome!, /^not_ready: runaway is suspended: /);
    assert.equal(refused.failures, 0, "not the schedule's failure: it doesn't pause");
    assert.equal(refused.status, "active");
    assert.ok(refused.nextRunAt! > Date.now(), "it stays on its timetable");
    assert.equal((await p.invoke(t.codex, { capabilityId: "running-log", operation: "list_runs" })).result !== undefined, true, "other tools run on");

    assert.throws(() => p.resume(t.claude, "runaway"), /owner/);
    p.resume(USER, "runaway");
    assert.throws(() => p.resume(USER, "runaway"), /isn't suspended/);
    assert.equal(p.readiness("runaway").ready, true);
    await p.invoke(t.codex, { capabilityId: "runaway", operation: "tick", input: { tag: "after" } });
    assert.deepEqual(p.registry.lifecycleEvents().filter((e) => ["suspend", "resume"].includes(e.action)).map((e) => [e.action, e.actor]), [["resume", "user"], ["suspend", "hewn"]]);
    // Its count starts over.
    for (const at of [3, 4]) {
      code(p, "runaway", "spin@1");
      p = restart(min(at)).p;
    }
    assert.equal(p.suspension("runaway"), undefined);
  });

  test("a suspended connection says so under Accounts", async () => {
    await installFrom(t.platform, join(FIXTURES, "site-connection"));
    t.platform.setConfig(USER, "site-connection", "SITE_URL", "https://example.com");
    t.platform.setSecret(USER, "site-connection", "API_KEY", "k");
    t.platform.approveGrants(USER, "site-connection");
    let p = t.platform;
    for (const at of [0, 1, 2]) {
      code(p, "site-connection", "site@1");
      p = restart(min(at)).p;
    }
    const health = await p.connectionHealth(USER, "site-connection");
    assert.deepEqual([health.status, health.detail], ["needs_setup", "suspended: it kept Hewn from responding 3 times within an hour"]);
  });

  test("a build whose own code was running fails for that reason and isn't retried; the live tool isn't blamed", async () => {
    let release!: () => void;
    t.queue(() => new Promise<void>((r) => (release = r)));
    const opened = await t.platform.modify(t.claude, { capabilityId: "runaway", request: "change" });
    while (!release) await new Promise((r) => setTimeout(r, 10));
    code(t.platform, "runaway", "tick@1", `test:${opened.buildId}`, "validation");
    const { p, out } = restart(min(0));
    assert.deepEqual(out, { tools: [], suspended: [], builds: [opened.buildId] });
    assert.deepEqual(await p.recoverInterruptedBuilds(), [], "not retried");
    const b = p.getBuild(t.claude, opened.buildId);
    assert.equal(b.status, "failed");
    assert.deepEqual([b.failure?.title, b.failure?.detail], ["Its code kept Hewn from responding", "Running tick@1 never let go (an endless loop?), so Hewn was restarted. It wasn't tried again: it would do the same."]);
    assert.deepEqual(stalled(p, "runaway"), []);
    release();
  });
});
