// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolStatus } from "@hewntools/cli/setup/tools.ts";

test("first run / doctor: a missing or signed-out builder CLI comes with its fix", () => {
  const s = toolStatus((bin) => bin !== "codex", (name) => (name === "claude" ? false : undefined));
  assert.deepEqual(s, [
    { name: "claude", label: "Claude Code", found: true, loggedIn: false, fix: "Sign in: run claude once and sign in" },
    { name: "codex", label: "Codex", found: false, fix: "Install it: npm install -g @openai/codex" },
  ]);
  const ok = toolStatus(() => true, () => true);
  assert.ok(ok.every((t) => t.found && t.loggedIn && !t.fix));
});
