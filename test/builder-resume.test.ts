// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { claudeArgs, claudeBuildHome, codexArgs, forgetSession, noteSession, pruneCodexSessions, resumePrompt, sessionOf } from "@hewntools/cli/builders/cli.ts";
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
    assert.deepEqual(first.slice(0, 4), ["-p", builderPromptOf(first), "--session-id", "11111111-1111-4111-8111-111111111111"]);
    assert.match(first[1], /Read BUILDER\.md/);
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

  test("the workbench removes what a build's builder kept: Claude Code's config dir, Codex's old sessions", async () => {
    const home = mkdtempSync(join(tmpdir(), "hewn-wb-"));
    const wb = localWorkbench({ root: join(home, "builds"), builders: {} });
    const claude = claudeBuildHome(home, "b-1");
    mkdirSync(join(claude, "projects"), { recursive: true });
    const sessions = join(home, "builder-home", "codex", ".codex", "sessions", "2026", "10", "20");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "old.jsonl"), "{}");
    utimesSync(join(sessions, "old.jsonl"), new Date(Date.now() - 3 * 86400_000), new Date(Date.now() - 3 * 86400_000));
    writeFileSync(join(sessions, "new.jsonl"), "{}");
    noteSession("claude", "b-1", "s");
    await wb.remove("b-1");
    assert.ok(!existsSync(claude));
    assert.ok(!existsSync(join(sessions, "old.jsonl")) && existsSync(join(sessions, "new.jsonl")));
    assert.equal(sessionOf("claude", job({ buildId: "b-1", attempt: 2 })), undefined);
    pruneCodexSessions("/nowhere/at/all");
  });
});

const builderPromptOf = (args: string[]) => args[args.indexOf("-p") + 1] ?? args.at(-1)!;
