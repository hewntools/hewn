// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MARKDOWN } from "@hewntools/cli/setup/blocks.ts";
import { harnesses } from "@hewntools/cli/setup/harnesses.ts";
import { uninstallPlan } from "@hewntools/cli/uninstall.ts";

test("hewn uninstall: removes the service, registrations, pointers and its own hewn link; lists the data", () => {
  const root = mkdtempSync(join(tmpdir(), "hewn-uninst-"));
  try {
    const user = join(root, "user");
    const app = join(root, "app");
    const other = join(root, "other-app");
    for (const d of [join(user, ".claude"), join(user, ".codex"), join(app, "packages", "cli", "src"), join(other, "packages", "cli", "src"), join(root, "bin"), join(root, "bin2")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(app, "packages", "cli", "src", "cli.ts"), "");
    writeFileSync(join(other, "packages", "cli", "src", "cli.ts"), "");
    symlinkSync(join(app, "packages", "cli", "src", "cli.ts"), join(root, "bin", "hewn"));
    symlinkSync(join(other, "packages", "cli", "src", "cli.ts"), join(root, "bin2", "hewn")); // another install's: left alone
    writeFileSync(join(user, ".claude.json"), JSON.stringify({ mcpServers: { hewn: { url: "x" } } }));
    writeFileSync(join(user, ".claude", "CLAUDE.md"), `# Mine\n\n${MARKDOWN.begin}\nuse hewn\n${MARKDOWN.end}\n`);
    const ran: string[] = [];
    let serviceRemoved = false;
    const plan = uninstallPlan({
      homeRoot: join(root, "data"),
      backupDir: join(root, "backups"),
      appDir: app,
      userHome: user,
      harnesses: harnesses(),
      exec: (cmd, a) => void ran.push([cmd, ...a].join(" ")),
      service: { installed: true, uninstall: () => void (serviceRemoved = true) },
      binDirs: [join(root, "bin"), join(root, "bin2")],
      keySource: "keychain",
      linux: false,
    });
    assert.deepEqual(plan.steps.map((s) => s.describe.split(" (")[0]), [
      "stop and remove the background service",
      "remove Hewn from Claude Code",
      `remove the Hewn pointer block from ${join(user, ".claude", "CLAUDE.md")}`,
      "remove the hewn command",
    ]);
    for (const s of plan.steps) s.run();
    assert.ok(serviceRemoved);
    assert.deepEqual(ran, ["claude mcp remove --scope user hewn"]);
    assert.equal(readFileSync(join(user, ".claude", "CLAUDE.md"), "utf8"), "# Mine\n");
    assert.ok(!existsSync(join(root, "bin", "hewn")));
    assert.ok(existsSync(join(root, "bin2", "hewn")), "another checkout's hewn stays");
    assert.ok(existsSync(join(app, "packages", "cli", "src", "cli.ts")), "Hewn never deletes itself or data");
    assert.match(plan.leftovers.join("\n"), /rm -rf '.*data'[\s\S]*security delete-generic-password -s hewn-master/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hewn uninstall, npm package: no checkout to look for; npm removes the command", () => {
  const root = mkdtempSync(join(tmpdir(), "hewn-uninst-npm-"));
  try {
    const plan = uninstallPlan({
      homeRoot: join(root, ".hewn"),
      backupDir: join(root, ".hewn-backups"),
      appDir: join(root, "lib", "node_modules", "@hewntools", "cli"),
      bundled: true,
      userHome: join(root, "user"),
      harnesses: [],
      exec: () => {},
      service: { installed: false, uninstall: () => {} },
      binDirs: [join(root, "bin")],
      keySource: "file",
      linux: true,
    });
    assert.deepEqual(plan.steps, []);
    assert.match(plan.leftovers.join("\n"), /Hewn itself: npm uninstall -g @hewntools\/cli/);
    assert.doesNotMatch(plan.leftovers.join("\n"), /this checkout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
