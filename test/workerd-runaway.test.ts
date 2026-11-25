// SPDX-License-Identifier: AGPL-3.0-or-later
// Code that doesn't stop on its own, on the real workerd host: a timer a call leaves behind, a call
// past its deadline, a loop that never yields.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CALL_DEADLINE_MS } from "@hewntools/core/platform.ts";
import { editJson, editText, FIXTURES } from "./helpers.ts";
import { signedIn, startTestHost, type TestHost } from "./workerd-helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("code that doesn't stop on its own (workerd host)", () => {
  let h: TestHost;
  const rows = async (tag: string): Promise<number> => (await h.invoke("runaway", "count")).result.rows[tag] ?? 0;
  before(async () => {
    h = await startTestHost();
    const r = await h.sv.admin("install", { name: "Runaway", purpose: "runs on", dir: join(FIXTURES, "runaway"), wait: true });
    assert.equal(r.status, "promoted", r.log.join("\n"));
  });
  after(() => h?.stop());

  test("a call that returned leaves nothing running: a timer it left behind stops with it", async () => {
    assert.deepEqual((await h.invoke("runaway", "linger")).result, { started: true });
    const right = await rows("linger");
    await sleep(1000);
    assert.equal(await rows("linger"), right, "nothing written after the call returned");
  });

  test("widgets, schedules and a change's migration still work, each call starting the tool afresh", async () => {
    const agent = await h.agent("claude-code", ["discover", "invoke"]);
    const before = (await h.invoke("runaway", "widget_rows")).result.value;
    const w: any = await agent.callTool({ name: "widgets_show", arguments: { capabilityId: "runaway", widget: "rows" } });
    assert.equal(w.isError, undefined, JSON.stringify(w));
    assert.equal(w.structuredContent.view.value, before);

    const s = await h.sv.admin("schedules", { capabilityId: "runaway", operation: "tick", input: { tag: "schedule" }, cadence: "daily 06:00" });
    await h.sv.admin("schedules/fire", { id: s.id });
    let ran: any;
    for (let i = 0; i < 50 && !ran?.lastOutcome; i++) {
      await sleep(100);
      ran = (await h.sv.admin("schedules", { capabilityId: "runaway" })).find((x: any) => x.id === s.id);
    }
    assert.equal(ran.lastOutcome, "ok");
    assert.equal(await rows("schedule"), 1);

    const restarts = h.sv.toolsRestarts();
    h.queue((ws) => writeFileSync(join(ws, "migrations", "002_note.sql"), "ALTER TABLE ticks ADD COLUMN note TEXT;"));
    const changed = await h.sv.admin("modify", { capabilityId: "runaway", request: "add a note", wait: true });
    assert.equal(changed.status, "promoted", changed.log.join("\n"));
    // Its no-loss check called the old version's reads, and spin@1 never stops: the tools were restarted once, and
    // the change went on without it (the old version's code, not the change's).
    assert.ok(changed.log.some((l: string) => /no-loss check: spin@1 left out \(it worked for more than 10 seconds without a pause, so Hewn's tools were restarted\)/.test(l)), changed.log.join("\n"));
    assert.ok(changed.log.some((l: string) => /no data lost by the migrations on a copy of the tool's data/.test(l)), changed.log.join("\n"));
    await until(() => h.sv.toolsRestarts() === restarts + 1);
    assert.equal(await rows("schedule"), 1, "the data came through the migration");
    await h.invoke("runaway", "tick", { tag: "after-change" });
    assert.equal(await rows("after-change"), 1);

    // The next change's check leaves spin@1 out from the start: no second restart.
    h.queue((ws) => writeFileSync(join(ws, "migrations", "003_mood.sql"), "ALTER TABLE ticks ADD COLUMN mood TEXT;"));
    const again = await h.sv.admin("modify", { capabilityId: "runaway", request: "add a mood", wait: true });
    assert.equal(again.status, "promoted", again.log.join("\n"));
    assert.ok(again.log.some((l: string) => /no-loss check: spin@1 left out \(it stalled before\)/.test(l)), again.log.join("\n"));
    assert.ok(again.log.some((l: string) => /no data lost by the migrations on a copy of the tool's data/.test(l)), again.log.join("\n"));
    await sleep(1000);
    assert.equal(h.sv.toolsRestarts(), restarts + 1, "spin@1 wasn't called again");
    assert.equal(await rows("after-change"), 1, "the data came through both migrations");
  });

  test("a call past its deadline is stopped, and calls running on the same tool stop with it", { timeout: CALL_DEADLINE_MS + 30_000 }, async () => {
    const overrun = h.invoke("runaway", "overrun").then(() => assert.fail("overrun returned"), (e: Error) => e);
    await sleep(CALL_DEADLINE_MS - 3000);
    // Started late enough that the first call's deadline comes while it waits.
    const slow = h.invoke("runaway", "slow", { ms: 10_000 }).then(() => assert.fail("slow returned"), (e: Error) => e);
    assert.match((await overrun).message, /overrun@1 timed out/);
    assert.match((await slow).message, /slow@1 failed: stopped: runaway\/overrun@1 ran past its deadline/);
    const at = await rows("overrun");
    assert.ok(at > 100, `it wrote until its deadline (${at} rows)`);
    await sleep(1000);
    assert.equal(await rows("overrun"), at, "nothing written after the deadline");
    assert.equal(await rows("slow"), 0, "the call stopped with it never wrote");
    await h.invoke("runaway", "tick", { tag: "next" });
    assert.equal(await rows("next"), 1, "the next call starts it afresh");
  });

  test("code that never yields: the tools' restart says which tool was running, and the third time within an hour suspends it until the owner resumes it", async () => {
    const s = await h.sv.admin("schedules", { capabilityId: "runaway", operation: "tick", input: { tag: "scheduled" }, cadence: "daily 05:00" });
    for (let i = 1; i <= 3; i++) {
      const before = { platform: h.sv.restarts(), tools: h.sv.toolsRestarts() };
      await assert.rejects(h.invoke("runaway", "spin"), "the stuck call fails");
      await until(() => h.sv.toolsRestarts() > before.tools);
      assert.equal(h.sv.restarts(), before.platform, "the platform kept running");
      await until(() => fetch(`${h.sv.url}/health`).then((r) => r.ok, () => false));
      const log: string[] = (await h.sv.admin("logs", { capabilityId: "runaway", n: 50 })).lines;
      assert.equal(log.filter((l) => /^\S+ user spin@1 ERROR stalled: Hewn's tools stopped responding while this ran and were restarted \d+ms$/.test(l)).length, i, log.join("\n"));
      const st = await h.sv.admin("readiness", { capabilityId: "runaway" });
      assert.equal(!!st.suspended, i === 3, `suspended only the third time (${i})`);
    }
    const st = await h.sv.admin("readiness", { capabilityId: "runaway" });
    assert.equal(st.ready, false);
    assert.match(st.suspended.reason, /worked for more than 10 seconds without a pause 3 times within an hour/);
    assert.match(st.userAction, /resumes it/);
    // Calls, widgets and schedules are refused, each saying why.
    await assert.rejects(h.invoke("runaway", "tick"), /runaway is suspended: it worked for more than 10 seconds without a pause 3 times within an hour/);
    const agent = await h.agent("codex", ["discover", "invoke"]);
    const w: any = await agent.callTool({ name: "widgets_show", arguments: { capabilityId: "runaway", widget: "rows" } });
    assert.equal(w.isError, true);
    assert.match(JSON.stringify(w), /suspended/);
    await h.sv.admin("schedules/fire", { id: s.id });
    let refused: any;
    for (let i = 0; i < 50 && !refused?.lastOutcome; i++) {
      await sleep(100);
      refused = (await h.sv.admin("schedules", { capabilityId: "runaway" })).find((x: any) => x.id === s.id);
    }
    assert.match(refused.lastOutcome, /suspended/);
    assert.equal(refused.failures, 0, "a refusal isn't the schedule's failure");
    assert.equal(refused.status, "active");
    // The owner sees it: in the Inbox, and in Activity.
    const web = await signedIn(h);
    const inbox = await web("/api/inbox");
    assert.deepEqual(inbox.needs.filter((n: any) => n.kind === "suspended").map((n: any) => [n.capabilityId, n.action]), [["runaway", "Resume…"]]);
    const activity = (await web("/api/activity?capability=runaway")).items.filter((i: any) => i.kind === "lifecycle" && i.outcome !== "schedule");
    const lines = activity.map((i: any) => `${i.outcome} ${i.detail}`).sort();
    assert.deepEqual(lines.slice(0, 3), ["stalled spin@1", "stalled spin@1", "stalled spin@1"]);
    assert.match(lines[3], /^suspend it worked for more than 10 seconds without a pause 3 times within an hour \(spin@1 at \d\d:\d\d, spin@1 at \d\d:\d\d, spin@1 at \d\d:\d\d\)$/);
    // Resumed (hewn resume), it runs again.
    writeFileSync(join(h.root, "supervisor.json"), JSON.stringify({ url: h.sv.url, adminToken: h.sv.adminToken, control: h.sv.control, pid: process.pid }));
    assert.match(await hewn(h.root, "resume", "runaway"), /runaway resumed/);
    await h.invoke("runaway", "tick", { tag: "resumed" });
    assert.equal(await rows("resumed"), 1);
    assert.equal((await web("/api/inbox")).needs.filter((n: any) => n.kind === "suspended").length, 0);
  });

  test("a change whose tests never let go fails for that reason and isn't retried; the live tool isn't blamed", async () => {
    const stalls = async () => (await h.sv.admin("logs", { capabilityId: "runaway", n: 100 })).lines.filter((l: string) => / ERROR stalled: /.test(l)).length;
    const blamed = await stalls();
    h.queue((ws) => editText(join(ws, "src", "index.ts"), (t) => t.replace("const SPIN_IN_TESTS = false", "const SPIN_IN_TESTS = true")));
    const before = { platform: h.sv.restarts(), tools: h.sv.toolsRestarts() };
    const started = await h.sv.admin("modify", { capabilityId: "runaway", request: "spin in its tests" });
    await until(() => h.sv.toolsRestarts() > before.tools);
    await until(() => fetch(`${h.sv.url}/health`).then((r) => r.ok, () => false));
    const build = (await h.sv.admin("call", { method: "getBuild", args: [started.buildId] })).result;
    assert.equal(build.status, "failed");
    assert.equal(build.failure.title, "It worked too long without a pause");
    assert.match(build.failure.detail, /^tick@1 worked for more than 10 seconds without a pause, on test 'tick', so Hewn's tools were restarted\..*It wasn't tried again/);
    await sleep(1000);
    const builds = (await h.sv.admin("status")).builds;
    assert.ok(!builds.some((b: any) => b.request?.autoRetryOf === started.buildId), "not retried");
    assert.equal(h.sv.toolsRestarts(), before.tools + 1, "the tools were restarted once");
    assert.equal(h.sv.restarts(), before.platform, "the platform wasn't");
    assert.equal(await stalls(), blamed, "nothing in the live tool's log");
    assert.equal((await h.sv.admin("readiness", { capabilityId: "runaway" })).ready, true);
    await h.invoke("runaway", "tick", { tag: "still-live" });
    assert.equal(await rows("still-live"), 1);
  });

  /** Runaway with one operation more: its manifest entry and its code. */
  const withOp = (name: string, inputSchema: object, code: string) => (ws: string) => {
    editJson(join(ws, "capability.json"), (m) => m.operations.push({ name, description: name, version: 1, sideEffect: "write", inputSchema, outputSchema: { type: "object" } }));
    editText(join(ws, "src", "index.ts"), (t) => t.replace(/\n};\s*$/, `\n  ${code}\n};\n`));
  };

  test("Hewn's schema fuzz on workerd: a crash names the operation and the input; a loop on the 10 KB input is a stall that names it", async () => {
    h.queue(withOp("tidy", { type: "object", properties: { note: { type: ["string", "null"] } } }, `"tidy@1"(input: any) { return input.note === undefined ? {} : { note: input.note.trim() }; },`));
    const crashed = await h.sv.admin("modify", { capabilityId: "runaway", request: "tidy notes", wait: true });
    assert.equal(crashed.status, "failed", crashed.log.join("\n"));
    assert.match(crashed.log.join("\n"), /- tidy@1 crashed on null in `note`: TypeError: Cannot read properties of null \(reading 'trim'\)/);

    const before = { platform: h.sv.restarts(), tools: h.sv.toolsRestarts() };
    h.queue(withOp("chew", { type: "object", properties: { text: { type: "string" } } }, `"chew@1"(input: any) { if ((input.text ?? "").length > 5000) for (;;) {} return {}; },`));
    const stalled = await h.sv.admin("modify", { capabilityId: "runaway", request: "chew text", wait: true });
    assert.equal(stalled.status, "failed", stalled.log.join("\n"));
    assert.match(stalled.log.join("\n"), /FAILED: chew@1 worked for more than 10 seconds without a pause, on the 10 KB input in `text`, so Hewn's tools were restarted/);
    await until(() => h.sv.toolsRestarts() === before.tools + 1);
    assert.equal(h.sv.restarts(), before.platform, "the platform wasn't restarted");
    await h.invoke("runaway", "tick", { tag: "after-fuzz" });
    assert.equal(await rows("after-fuzz"), 1, "the live tool runs on");
  });
});

const CLI = fileURLToPath(new URL("../packages/cli/src/cli.ts", import.meta.url));

/** The hewn command, for the Hewn whose home is `home`. */
const hewn = (home: string, ...args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { env: { ...process.env, HEWN_HOME: home } }, (e, out, err) => (e ? reject(new Error(`hewn ${args.join(" ")}: ${err || out}`)) : resolve(out))),
  );

/** Wait until `fn` holds (at most 20 s). */
async function until(fn: () => boolean | Promise<boolean>) {
  const end = Date.now() + 20_000;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(50);
  }
}
