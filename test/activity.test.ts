// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeActivity, codexActivity } from "@hewntools/cli/builders/activity.ts";

const ws = "/data/builds/b-1";

test("codex events become activity lines", () => {
  assert.equal(
    codexActivity({ type: "item.started", item: { type: "command_execution", command: "/bin/zsh -lc 'node tests/x.ts'" } }, ws),
    "$ node tests/x.ts",
  );
  assert.equal(codexActivity({ type: "item.completed", item: { type: "command_execution", exit_code: 0 } }, ws), null, "success is noise");
  assert.equal(codexActivity({ type: "item.completed", item: { type: "command_execution", exit_code: 2 } }, ws), "  ↳ exit 2");
  assert.equal(
    codexActivity({ type: "item.completed", item: { type: "file_change", changes: [{ path: `${ws}/src/index.ts`, kind: "update" }] } }, ws),
    "✎ update src/index.ts",
  );
  assert.equal(codexActivity({ type: "item.completed", item: { type: "agent_message", text: "Done.\n" } }, ws), "💬 Done.");
  assert.equal(codexActivity({ type: "thread.started" }, ws), null);
});

test("claude stream-json events become activity lines", () => {
  const e = {
    type: "assistant",
    message: { content: [{ type: "text", text: "Adding notes." }, { type: "tool_use", name: "Edit", input: { file_path: `${ws}/capability.json` } }] },
  };
  assert.equal(claudeActivity(e, ws), "💬 Adding notes.\n→ Edit capability.json");
  assert.equal(claudeActivity({ type: "result", is_error: false, num_turns: 7 }, ws), "✔ builder finished (7 turns)");
  assert.equal(claudeActivity({ type: "system", subtype: "init" }, ws), null);
});

test("auth and quota failures mark the builder unavailable (no pointless retries)", async () => {
  const { UNAVAILABLE } = await import("@hewntools/cli/builders/cli.ts");
  for (const line of ["✖ Failed to authenticate: OAuth token revoked.", "Not logged in · Please run /login", "Claude AI usage limit reached"]) assert.match(line, UNAVAILABLE);
  assert.doesNotMatch("→ Edit src/auth.ts", UNAVAILABLE);
});
