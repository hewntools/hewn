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
import { editText, FIXTURES } from "./helpers.ts";
import { startTestHost, type TestHost } from "./workerd-helpers.ts";

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

    h.queue((ws) => writeFileSync(join(ws, "migrations", "002_note.sql"), "ALTER TABLE ticks ADD COLUMN note TEXT;"));
    const changed = await h.sv.admin("modify", { capabilityId: "runaway", request: "add a note", wait: true });
    assert.equal(changed.status, "promoted", changed.log.join("\n"));
    assert.equal(await rows("schedule"), 1, "the data came through the migration");
    await h.invoke("runaway", "tick", { tag: "after-change" });
    assert.equal(await rows("after-change"), 1);
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

  test("code that never yields: the restart says which tool was running, and the third time within an hour suspends it until the owner resumes it", async () => {
    const s = await h.sv.admin("schedules", { capabilityId: "runaway", operation: "tick", input: { tag: "scheduled" }, cadence: "daily 05:00" });
    for (let i = 1; i <= 3; i++) {
      const before = h.sv.restarts();
      await assert.rejects(h.invoke("runaway", "spin"), "the stuck call fails");
      await until(() => h.sv.restarts() > before);
      await until(() => fetch(`${h.sv.url}/health`).then((r) => r.ok, () => false));
      const log: string[] = (await h.sv.admin("logs", { capabilityId: "runaway", n: 50 })).lines;
      assert.equal(log.filter((l) => /^\S+ user spin@1 ERROR stalled: Hewn stopped responding while this ran and was restarted \d+ms$/.test(l)).length, i, log.join("\n"));
      const st = await h.sv.admin("readiness", { capabilityId: "runaway" });
      assert.equal(!!st.suspended, i === 3, `suspended only the third time (${i})`);
    }
    const st = await h.sv.admin("readiness", { capabilityId: "runaway" });
    assert.equal(st.ready, false);
    assert.match(st.suspended.reason, /kept Hewn from responding 3 times within an hour/);
    assert.match(st.userAction, /resumes it/);
    // Calls, widgets and schedules are refused, each saying why.
    await assert.rejects(h.invoke("runaway", "tick"), /runaway is suspended: it kept Hewn from responding 3 times within an hour/);
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
    assert.deepEqual(activity.map((i: any) => `${i.outcome} ${i.detail}`).sort(), ["stalled spin@1", "stalled spin@1", "stalled spin@1", "suspend it kept Hewn from responding 3 times within an hour"]);
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
    const before = h.sv.restarts();
    const started = await h.sv.admin("modify", { capabilityId: "runaway", request: "spin in its tests" });
    await until(() => h.sv.restarts() > before);
    await until(() => fetch(`${h.sv.url}/health`).then((r) => r.ok, () => false));
    const build = (await h.sv.admin("call", { method: "getBuild", args: [started.buildId] })).result;
    assert.equal(build.status, "failed");
    assert.equal(build.failure.title, "Its code kept Hewn from responding");
    assert.match(build.failure.detail, /^Running tick@1 never let go .*It wasn't tried again/);
    await sleep(1000);
    const builds = (await h.sv.admin("status")).builds;
    assert.ok(!builds.some((b: any) => b.request?.autoRetryOf === started.buildId), "not retried");
    assert.equal(h.sv.restarts(), before + 1, "Hewn was restarted once");
    assert.equal(await stalls(), blamed, "nothing in the live tool's log");
    assert.equal((await h.sv.admin("readiness", { capabilityId: "runaway" })).ready, true);
    await h.invoke("runaway", "tick", { tag: "still-live" });
    assert.equal(await rows("still-live"), 1);
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

/** The web API as the signed-in owner (on Hewn's own host name, which fetch can't send). */
async function signedIn(h: TestHost): Promise<(path: string) => Promise<any>> {
  const get = (path: string, cookie = "") =>
    new Promise<{ status: number; headers: Record<string, any>; body: string }>((ok, fail) => {
      const r = request({ host: "127.0.0.1", port: h.port, path, headers: { host: `hewn.localhost:${h.port}`, ...(cookie ? { cookie } : {}), "x-hewn-ui": "1" } }, (m) => {
        let body = "";
        m.on("data", (d) => (body += d));
        m.on("end", () => ok({ status: m.statusCode!, headers: m.headers, body }));
      });
      r.on("error", fail);
      r.end();
    });
  const { ticket } = await h.sv.admin("web-ticket");
  const cookie = String((await get(`/auth?ticket=${ticket}`)).headers["set-cookie"]).split(";")[0];
  return async (path) => {
    const r = await get(path, cookie);
    if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status} ${r.body}`);
    return JSON.parse(r.body);
  };
}
