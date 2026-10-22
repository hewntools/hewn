// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { claudeActivity, codexActivity, USED_TOOL } from "@hewntools/cli/builders/activity.ts";
import { claudeArgs, claudeBuildHome, codexArgs, codexBuildHome, codexBuilder, forgetSession, noteSession, resumePrompt, sessionOf, withResume } from "@hewntools/cli/builders/cli.ts";
import type { BuildJob } from "@hewntools/cli/builders/types.ts";
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
    assert.match(first[1], /Read BUILDER\.md/);
    assert.deepEqual(first.slice(2, 4), ["--session-id", "11111111-1111-4111-8111-111111111111"]);
    assert.ok(first.includes("--restricted"));
    assert.ok(first.includes("--disallowedTools") && first[first.indexOf("--disallowedTools") + 1] === "Bash");
    const again = claudeArgs(job({ attempt: 2, feedback: "test 'x' failed" }), { id: "11111111-1111-4111-8111-111111111111", resume: true });
    assert.deepEqual(again.slice(2, 4), ["--resume", "11111111-1111-4111-8111-111111111111"]);
    assert.equal(again[1], resumePrompt(job({ attempt: 2, feedback: "test 'x' failed" })));
    assert.match(again[1], /Attempt 2\. The platform validated your candidate and it FAILED:\n\ntest 'x' failed\n\nFix the candidate in place/);
    assert.doesNotMatch(again[1], /Read BUILDER\.md: it holds/);
    assert.ok(!again.includes("--session-id"));
  });

  test("Codex: exec's own options before `resume`, the shared ones after; no --ephemeral, so the thread is on disk", () => {
    const first = codexArgs(job());
    assert.equal(first[0], "exec");
    assert.ok(!first.includes("--ephemeral"));
    assert.ok(!first.includes("resume"));
    assert.deepEqual(first.slice(-5), ["-c", 'project_root_markers=["BUILDER.md"]', "-C", "/tmp/ws", first.at(-1)]);
    assert.match(first.at(-1)!, /Read BUILDER\.md/);
    const again = codexArgs(job({ attempt: 2, feedback: "nope" }), "01a15811-9c22-7611-80b3-3a87c3622bfd");
    const at = again.indexOf("resume");
    assert.ok(at > 0);
    assert.deepEqual(again.slice(1, at), ["--sandbox", "danger-full-access", "-c", 'project_root_markers=["BUILDER.md"]', "-C", "/tmp/ws"]);
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
      // Its home is the build's own; the login is there for a run only.
      const own = codexBuildHome(home, "b-7");
      assert.ok(existsSync(join(own, ".codex")));
      assert.ok(!existsSync(join(own, ".codex", "auth.json")));
      assert.equal(readFileSync(join(home, ".codex", "auth.json"), "utf8"), '{"tokens":"yours"}');
    } finally {
      Object.assign(process.env, env);
      forgetSession("b-7");
    }
  });

  test("the workbench removes what a build's builder kept: its home per build (Claude Code's config dir, Codex's)", async () => {
    const home = mkdtempSync(join(tmpdir(), "hewn-wb-"));
    const wb = localWorkbench({ root: join(home, "builds"), builders: {} });
    const claude = claudeBuildHome(home, "b-1");
    const codex = codexBuildHome(home, "b-1");
    const other = codexBuildHome(home, "b-2");
    for (const d of [join(claude, "projects"), join(codex, ".codex", "sessions"), join(other, ".codex")]) mkdirSync(d, { recursive: true });
    noteSession("claude", "b-1", "s");
    await wb.remove("b-1");
    assert.ok(!existsSync(claude) && !existsSync(codex), "the build's homes go");
    assert.ok(existsSync(other), "another build's stays");
    assert.equal(sessionOf("claude", job({ buildId: "b-1", attempt: 2 })), undefined);
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
