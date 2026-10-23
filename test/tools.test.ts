// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolStatus } from "@hewntools/cli/setup/tools.ts";

test("first run / doctor: a missing or signed-out builder CLI comes with its fix", () => {
  const s = toolStatus((bin) => bin !== "codex", (name) => (name === "claude" ? false : undefined));
  assert.deepEqual(s, [
    { name: "claude", label: "Claude Code", harnessId: "claude-code", found: true, loggedIn: false, fix: "Sign in: run claude once and sign in" },
    { name: "codex", label: "Codex", harnessId: "codex", found: false, fix: "Install it: npm install -g @openai/codex" },
    // OpenCode runs on keys from the environment, local models and its free tier too: no login can't be told, so no fix.
    { name: "opencode", label: "OpenCode", harnessId: "opencode", found: true },
  ]);
  const ok = toolStatus(() => true, () => true);
  assert.ok(ok.every((t) => t.found && t.loggedIn && !t.fix));
});
