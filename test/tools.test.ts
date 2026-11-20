// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolStatus } from "@hewntools/cli/setup/tools.ts";

test("first run / doctor / Settings › AI: a missing builder CLI comes with its install, one not signed in on this Hewn with where to sign in, in words", async () => {
  const s = await toolStatus("/nowhere", (bin) => bin !== "codex", async (name) => (name === "claude" ? false : undefined));
  assert.deepEqual(s, [
    { name: "claude", label: "Claude Code", harnessId: "claude-code", found: true, loggedIn: false, fix: "Not signed in on this Hewn · sign in from the terminal on the machine that runs it" },
    { name: "codex", label: "Codex", harnessId: "codex", found: false, fix: "Install it: npm install -g @openai/codex" },
    // Its CLI didn't say: no fix.
    { name: "opencode", label: "OpenCode", harnessId: "opencode", found: true },
  ]);
  assert.ok(s.every((t) => !/hewn builder/.test(t.fix ?? "")), "no command for the web");
  const ok = await toolStatus("/nowhere", () => true, async () => true);
  assert.ok(ok.every((t) => t.found && t.loggedIn && !t.fix));
});
