// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { claudeActivity, codexActivity, USED_TOOL } from "@hewntools/cli/builders/activity.ts";
import { builderPrompt, claudeArgs, codexArgs, codexBuilder, forgetSession, noteSession, resumePrompt, runCli, sessionOf, withResume } from "@hewntools/cli/builders/cli.ts";
import { builderHome } from "@hewntools/cli/builders/sign-in.ts";
import type { BuildJob } from "@hewntools/cli/builders/types.ts";
import { readConfig } from "@hewntools/cli/config.ts";
import { openHome } from "@hewntools/cli/home.ts";
import { localWorkbench } from "@hewntools/cli/workbench.ts";

const job = (extra: Partial<BuildJob> = {}): BuildJob => ({ buildId: "b-9", capabilityId: "notes", kind: "create", workspace: "/tmp/ws", attempt: 1, logPath: "/tmp/b-9.log", platformRoot: "/tmp/home", ...extra });

describe("a later attempt resumes the builder's session", () => {
  test("sessions are per builder and build, for later attempts only, until forgotten", () => {
    assert.equal(sessionOf("claude", job({ attempt: 2 })), undefined);
    noteSession("claude", "b-9", "s-claude");
    noteSession("codex", "b-9", "t-codex");
    assert.equal(sessionOf("claude", job({ attempt: 1 })), undefined, "the first attempt never resumes");
    assert.equal(sessionOf("claude", job({ attempt: 2 })), "s-claude");
    assert.equal(sessionOf("codex", job({ attempt: 3 })), "t-codex");
    assert.equal(sessionOf("claude", job({ buildId: "b-other", attempt: 2 })), undefined);
    forgetSession("b-9");
    assert.equal(sessionOf("claude", job({ attempt: 2 })), undefined);
  });

  test("Claude Code: a session id of its own on the first attempt, --resume with the failure after; --restricted besides the file tools", () => {
    const first = claudeArgs(job(), { id: "11111111-1111-4111-8111-111111111111", resume: false });
    assert.equal(first[0], "-p");
    assert.match(first[1], /Read BUILDER\.md, the request, then BRIEF\.md, all of it \(in parts, if your reader cuts it short\), before you write anything: it is the implementation contract/);
    assert.match(first[1], /After reading BUILDER\.md, BRIEF\.md, and any OWNERS_WORDS\.md and OTHER_TOOLS\.md, write ui\/icon\.svg[^]*as your first implementation changes \(see "Icon" in BRIEF\.md\)/);
    assert.deepEqual(first.slice(2, 4), ["--session-id", "11111111-1111-4111-8111-111111111111"]);
    assert.ok(first.includes("--restricted"));
    assert.ok(first.includes("--disallowedTools") && first[first.indexOf("--disallowedTools") + 1] === "Bash");
    const again = claudeArgs(job({ attempt: 2, feedback: "test 'x' failed" }), { id: "11111111-1111-4111-8111-111111111111", resume: true });
    assert.deepEqual(again.slice(2, 4), ["--resume", "11111111-1111-4111-8111-111111111111"]);
    assert.equal(again[1], resumePrompt(job({ attempt: 2, feedback: "test 'x' failed" })));
    assert.match(again[1], /Attempt 2\. The platform validated your candidate and it FAILED:\n\ntest 'x' failed\n\nFix the candidate in place/);
    assert.doesNotMatch(again[1], /Read BUILDER\.md, the request/);
    assert.match(again[1], /with the request in BUILDER\.md and the contract in BRIEF\.md\. If you haven't read all of BRIEF\.md, read it before you change anything\./, "where they still are, and to read the brief now if it skipped it");
    assert.match(resumePrompt(job({ attempt: 2 })), /^Attempt 2\. Your previous run stopped before it finished\.[^]*with the request in BUILDER\.md and the contract in BRIEF\.md/);
    assert.ok(!again.includes("--session-id"));
  });

  test("Codex: exec's own options before `resume`, the shared ones after; no --ephemeral, so the thread is on disk", () => {
    const first = codexArgs(job());
    assert.equal(first[0], "exec");
    assert.ok(!first.includes("--ephemeral"));
    assert.ok(!first.includes("resume"));
    assert.deepEqual(first.slice(-7), ["-c", 'project_root_markers=["BUILDER.md"]', "-c", 'cli_auth_credentials_store="file"', "-C", "/tmp/ws", first.at(-1)]);
    assert.match(first.at(-1)!, /Read BUILDER\.md/);
    const again = codexArgs(job({ attempt: 2, feedback: "nope" }), "01a15811-9c22-7611-80b3-3a87c3622bfd");
    const at = again.indexOf("resume");
    assert.ok(at > 0);
    assert.deepEqual(again.slice(1, at), ["--sandbox", "danger-full-access", "-c", 'project_root_markers=["BUILDER.md"]', "-c", 'cli_auth_credentials_store="file"', "-C", "/tmp/ws"]);
    assert.deepEqual(again.slice(at + 1, at + 4), ["--ignore-user-config", "--skip-git-repo-check", "--json"]);
    assert.deepEqual(again.slice(-2), ["01a15811-9c22-7611-80b3-3a87c3622bfd", resumePrompt(job({ attempt: 2, feedback: "nope" }))]);
  });

  test("what counts as having used a tool: Claude Code's tool calls, Codex's commands and file changes", () => {
    assert.ok(USED_TOOL.test(claudeActivity({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/tmp/ws/a.ts" } }] } }, "/tmp/ws")!));
    assert.ok(USED_TOOL.test(codexActivity({ type: "item.started", item: { type: "command_execution", command: "npm test" } }, "/tmp/ws")!));
    assert.ok(USED_TOOL.test(codexActivity({ type: "item.completed", item: { type: "file_change", changes: [{ kind: "update", path: "/tmp/ws/a.ts" }] } }, "/tmp/ws")!));
    for (const line of ["💬 hello", "… thinking", "✖ thread not found", "✔ builder finished its turn", "☐ plan: x"]) assert.ok(!USED_TOOL.test(line), line);
  });

  test("a resume starts over only when it failed before any tool use; never when cancelled, logged out or the model refused", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "hewn-wr-")), "b-8.log");
    writeFileSync(log, "");
    const j = job({ buildId: "b-8", attempt: 2, feedback: "nope", logPath: log });
    const runs: (string | undefined)[] = [];
    noteSession("claude", "b-8", "s-1");
    // After a tool call: a failed attempt, the session kept for the next one.
    await assert.rejects(
      withResume("claude", j, async (r) => {
        runs.push(r);
        throw Object.assign(new Error("claude exited with 1"), { usedTools: true });
      }),
      /exited with 1/,
    );
    assert.deepEqual([...runs], ["s-1"]);
    assert.equal(sessionOf("claude", j), "s-1");
    // Before: fresh in the same attempt, the old session forgotten.
    await withResume("claude", j, async (r) => {
      runs.push(r);
      if (r) throw Object.assign(new Error("claude exited with 1"), { usedTools: false });
    });
    assert.deepEqual([...runs], ["s-1", "s-1", undefined]);
    assert.equal(sessionOf("claude", j), undefined);
    assert.match(readFileSync(log, "utf8"), /couldn't resume the earlier session; starting over/);
    for (const flag of ["cancelled", "unavailable", "modelRejected"]) {
      noteSession("claude", "b-8", "s-2");
      await assert.rejects(
        withResume("claude", j, async () => {
          throw Object.assign(new Error(flag), { usedTools: false, [flag]: true });
        }),
        new RegExp(flag),
      );
      assert.equal(sessionOf("claude", j), "s-2", `${flag}: no restart`);
    }
    forgetSession("b-8");
  });

  test("Codex, through its CLI: a resume that fails after a command or edit is a failed attempt; one that fails before starts over", async () => {
    const home = mkdtempSync(join(tmpdir(), "hewn-resume-"));
    const fake = fakeCli("codex", {
      worked: '{"type":"item.completed","item":{"type":"file_change","changes":[{"kind":"update","path":"/tmp/ws/src/index.ts"}]}}',
      gone: '{"type":"error","message":"thread not found"}',
      started: '{"type":"thread.started","thread_id":"t-new"}',
      done: '{"type":"turn.completed"}',
    });
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    process.env.PATH = `${fake.bin}:${process.env.PATH}`;
    process.env.HOME = home;
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "auth.json"), '{"tokens":"yours"}');
    // Signed in on this Hewn (its builder home), by Codex's own login.
    const own = builderHome(home, "codex");
    mkdirSync(join(own, ".codex"), { recursive: true });
    writeFileSync(join(own, ".codex", "auth.json"), '{"tokens":"the builder\'s"}');
    try {
      const ws = join(home, "ws");
      const logPath = join(home, "builds", "b-7.log");
      mkdirSync(ws);
      mkdirSync(dirname(logPath));
      const j = job({ buildId: "b-7", workspace: ws, logPath, platformRoot: undefined, attempt: 2, feedback: "nope" });
      noteSession("codex", "b-7", "t-old");
      fake.mode("after");
      await assert.rejects(codexBuilder.build(j), /codex exited with 1/);
      assert.equal(fake.calls().length, 1, "no restart on a half-changed workspace");
      assert.match(fake.calls()[0], /resume .*t-old/);
      assert.equal(sessionOf("codex", j), "t-old", "the thread stays for the next attempt");
      fake.mode("before");
      await codexBuilder.build(j);
      assert.deepEqual(fake.calls().slice(1).map((c) => c.includes(" resume ")), [true, false], "resumed, then fresh");
      assert.match(readFileSync(logPath, "utf8"), /couldn't resume the earlier session; starting over/);
      assert.equal(sessionOf("codex", j), "t-new", "the fresh run's thread is the one to resume next");
      // Its builder home's login, kept in its file; neither it nor yours read, copied or written.
      assert.ok(fake.calls().every((c) => c.includes('cli_auth_credentials_store="file"')));
      assert.equal(readFileSync(join(own, ".codex", "auth.json"), "utf8"), '{"tokens":"the builder\'s"}');
      assert.equal(readFileSync(join(home, ".codex", "auth.json"), "utf8"), '{"tokens":"yours"}');
    } finally {
      Object.assign(process.env, env);
      forgetSession("b-7");
    }
  });

  test("the workbench removes what a build's builder kept in its builder home (Claude Code's project folder, Codex's thread); the homes and other builds' stay", async () => {
    const home = mkdtempSync(join(tmpdir(), "hewn-wb-"));
    const wb = localWorkbench({ root: join(home, "builds"), builders: {} });
    await wb.open("b-1", {});
    const project = (b: string) => join(builderHome(home, "claude"), "projects", join(realpathSync(join(home, "builds")), b).replace(/[^a-zA-Z0-9]/g, "-"));
    const rollouts = join(builderHome(home, "codex"), ".codex", "sessions", "2026", "11", "20");
    for (const d of [project("b-1"), join(builderHome(home, "claude"), "projects", "other-build"), rollouts]) mkdirSync(d, { recursive: true });
    writeFileSync(join(rollouts, "rollout-2026-11-20T10-00-00-t-mine.jsonl"), "");
    writeFileSync(join(rollouts, "rollout-2026-11-20T10-00-00-t-theirs.jsonl"), "");
    noteSession("claude", "b-1", "s");
    noteSession("codex", "b-1", "t-mine");
    await wb.remove("b-1");
    assert.ok(!existsSync(project("b-1")) && !existsSync(join(rollouts, "rollout-2026-11-20T10-00-00-t-mine.jsonl")), "the build's sessions go");
    assert.ok(existsSync(join(builderHome(home, "claude"), "projects", "other-build")) && existsSync(join(rollouts, "rollout-2026-11-20T10-00-00-t-theirs.jsonl")), "another build's stay");
    assert.equal(sessionOf("claude", job({ buildId: "b-1", attempt: 2 })), undefined);
    assert.equal(sessionOf("codex", job({ buildId: "b-1", attempt: 2 })), undefined);
  });
});

/** A builder CLI on PATH that records its calls: resuming fails (before or after a tool, per `mode`), a fresh run finishes. */
function fakeCli(name: string, lines: { worked: string; gone: string; started: string; done: string }) {
  const bin = mkdtempSync(join(tmpdir(), "hewn-fake-"));
  writeFileSync(
    join(bin, name),
    `#!/bin/sh
d=$(dirname "$0")
printf '%s' "$*" | tr '\\n' ' ' >> "$d/calls"; echo >> "$d/calls"
case " $* " in *" resume "*|*" --resume "*) resuming=1;; esac
if [ -n "$resuming" ]; then
  if [ "$(cat "$d/mode")" = after ]; then echo '${lines.worked}'; exit 1; fi
  echo '${lines.gone}'; exit 1
fi
echo '${lines.started}'
echo '${lines.done}'
`,
    { mode: 0o755 },
  );
  return {
    bin,
    mode: (m: "before" | "after") => writeFileSync(join(bin, "mode"), m),
    calls: () => (existsSync(join(bin, "calls")) ? readFileSync(join(bin, "calls"), "utf8").trim().split("\n") : []),
  };
}

describe("a builder is stopped only when it does nothing (no time limit)", () => {
  const node = (code: string) => [process.execPath, ["-e", code]] as const;
  const quiet = (code: string, idleMs: number) => {
    const dir = mkdtempSync(join(tmpdir(), "hewn-idle-"));
    const ws = join(dir, "ws");
    mkdirSync(ws);
    const j = job({ buildId: "b-idle", workspace: ws, logPath: join(dir, "b-idle.log") });
    writeFileSync(j.logPath, "");
    const [cmd, args] = node(code);
    j.idleMs = idleMs;
    return { j, run: () => runCli(cmd, [...args], j, (e) => (e && typeof e === "object" ? "worked" : null), { ownState: [], denyKeychain: false }, process.env) };
  };
  const failure = (p: Promise<unknown>) => p.then(() => ({}) as any, (e) => e);

  test("a run that talks, or changes files, goes on past the idle time; one that falls silent is stopped, saying so", async () => {
    // 1.2 s of work against a 400 ms idle time: a line every 150 ms, then files every 150 ms.
    const talks = quiet("let n = 0; const t = setInterval(() => { console.log(JSON.stringify({ n })); if (++n === 8) clearInterval(t); }, 150);", 400);
    await talks.run();
    const writes = quiet("const fs = require('fs'); let n = 0; const t = setInterval(() => { fs.writeFileSync('f' + n + '.txt', 'x'); if (++n === 8) clearInterval(t); }, 150);", 400);
    await writes.run();
    // Talks, then hangs: stopped, and it had done something (so it resumes).
    const hangs = quiet("console.log('{}'); setTimeout(() => {}, 60_000);", 400);
    const e = await failure(hangs.run());
    assert.equal(e.message, "no activity for 1 minute");
    assert.equal(e.idle, true);
    assert.equal(e.active, true);
    // Never did anything: hung from the start.
    const dead = await failure(quiet("setTimeout(() => {}, 60_000);", 300).run());
    assert.equal(dead.idle, true);
    assert.equal(dead.active, false);
    // Start-up events alone (a line its formatter shows nothing for) aren't work done: hung all the same.
    const started = await failure(quiet(`console.log('"init"'); setTimeout(() => {}, 60_000);`, 300).run());
    assert.equal(started.idle, true);
    assert.equal(started.active, false);
    // Stopped by the owner before a run (between an idle stop and its resume): it doesn't start.
    const stopped = quiet("console.log('{}')", 300);
    const abort = new AbortController();
    abort.abort();
    stopped.j.signal = abort.signal;
    assert.equal((await failure(stopped.run())).cancelled, true);
  });

  test("a run stopped for no activity resumes its session in the same attempt, as many times as it works on; a hung one is a failed attempt", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "hewn-wr-")), "b-7.log");
    writeFileSync(log, "");
    const j = job({ buildId: "b-7", attempt: 1, logPath: log, idleMs: 15 * 60_000 });
    const runs: { resume?: string; resumed?: boolean; feedback?: string }[] = [];
    const lines: string[] = [];
    let n = 0;
    await withResume("claude", { ...j, onActivity: (l) => lines.push(l) }, async (resume, attempt) => {
      runs.push({ resume, resumed: attempt.resumedAfterIdle, feedback: attempt.feedback });
      noteSession("claude", "b-7", "s-7");
      if (++n < 3) throw Object.assign(new Error("no activity for 15 minutes"), { idle: true, active: true, usedTools: true });
    });
    assert.deepEqual(runs, [
      { resume: undefined, resumed: undefined, feedback: undefined },
      { resume: "s-7", resumed: true, feedback: undefined },
      { resume: "s-7", resumed: true, feedback: undefined },
    ]);
    assert.deepEqual(lines, ["no activity for 15 minutes; resuming", "no activity for 15 minutes; resuming"]);
    assert.equal(readFileSync(log, "utf8").match(/no activity for 15 minutes; resuming/g)?.length, 2);
    assert.match(resumePrompt({ ...j, attempt: 2, feedback: "test 'x' failed", resumedAfterIdle: true }), /^Hewn stopped your previous run after 15 minutes with no activity, before it finished\. Carry on in place/, "not the failure it was already given");
    // Quiet from the start: no resume, the attempt fails.
    await assert.rejects(
      withResume("claude", j, async () => {
        throw Object.assign(new Error("no activity for 15 minutes"), { idle: true, active: false, usedTools: false });
      }),
      /^Error: no activity for 15 minutes$/,
    );
    forgetSession("b-7");
  });
});

test("the idle time is platform.json's builderIdleMinutes when it's a whole number of minutes from 1 (else unset: 15); the workbench passes it to each build", async () => {
  const home = openHome(mkdtempSync(join(tmpdir(), "hewn-idle-cfg-")));
  const write = (v: unknown) => writeFileSync(join(home.root, "platform.json"), JSON.stringify({ builderIdleMinutes: v }));
  assert.equal(readConfig(home).builderIdleMinutes, undefined);
  for (const [v, want] of [[30, 30], [1, 1], [0, undefined], [2.5, undefined], ["30", undefined], [-5, undefined]] as const) {
    write(v);
    assert.equal(readConfig(home).builderIdleMinutes, want, JSON.stringify(v));
  }
  const seen: (number | undefined)[] = [];
  const wb = localWorkbench({ root: join(home.root, "builds"), builders: { probe: { name: "probe", build: async (j) => void seen.push(j.idleMs) } }, builderIdleMs: () => 7 * 60_000 });
  await wb.open("b-1", {});
  await wb.build({ buildId: "b-1", capabilityId: "x", kind: "create", builder: "probe", attempt: 1 } as any, { signal: new AbortController().signal, onActivity: () => {} });
  assert.deepEqual(seen, [7 * 60_000]);
  rmSync(home.root, { recursive: true, force: true });
});

test("a retry carries on from the failed build's workspace, the new request over it; not its builder's session, which names the old workspace's paths", async () => {
  const home = mkdtempSync(join(tmpdir(), "hewn-carry-"));
  const root = join(home, "builds");
  const wb = localWorkbench({ root, builders: {} });
  await wb.open("b-old", { "src/half.ts": new TextEncoder().encode("half"), "BUILDER.md": new TextEncoder().encode("old request") });
  noteSession("claude", "b-old", "s-old");
  assert.equal(await wb.carryOver("b-old", "b-new", { "BUILDER.md": new TextEncoder().encode("new request") }), true);
  assert.equal(readFileSync(join(root, "b-new", "src", "half.ts"), "utf8"), "half");
  assert.equal(readFileSync(join(root, "b-new", "BUILDER.md"), "utf8"), "new request");
  assert.equal(sessionOf("claude", job({ buildId: "b-new", attempt: 2 })), undefined, "nor its session");
  assert.match(builderPrompt(job({ buildId: "b-new", attempt: 1, carriesOn: "stopped" })), /an earlier build of the same request that the owner stopped before it finished: the workspace holds its work/);
  assert.match(builderPrompt(job({ buildId: "b-new", attempt: 1, carriesOn: "failed" })), /\nThis build carries on from an earlier build of the same request that didn't finish: the workspace holds its work\. Look at what's there before you write anything/);
  assert.doesNotMatch(builderPrompt(job({ buildId: "b-new", attempt: 2, carriesOn: "failed" })), /carries on from an earlier build/, "its first attempt only");
  // Nothing kept (the workspace cleaned up after a day): the retry opens afresh.
  assert.equal(await wb.carryOver("b-gone", "b-other", {}), false);
  for (const b of ["b-old", "b-new"]) await wb.remove(b);
});

