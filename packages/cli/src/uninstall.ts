// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { KeySource } from "./supervisor/master-key.ts";
import { MARKDOWN, removeBlock } from "./setup/blocks.ts";
import { type Exec, type Harness, opencodeConfigDir } from "./setup/harnesses.ts";

/**
 * `hewn uninstall`: what Hewn put outside its own folders, undone. The service, the agents'
 * registrations and pointer blocks, the `hewn` command. Your data, backups, the checkout and the
 * secrets key are listed with how to remove them, never removed by Hewn itself.
 */
export interface UninstallStep {
  describe: string;
  run: () => void;
}

export function uninstallPlan(o: {
  homeRoot: string;
  backupDir: string;
  appDir: string;
  /** The npm package (not a checkout). */
  bundled?: boolean;
  /** Its npm prefix (uninstall from the same one). */
  npmPrefix?: string;
  userHome: string;
  harnesses: Harness[];
  exec: Exec;
  service: { installed: boolean; uninstall: () => void };
  /** Folders install.sh may have linked `hewn` into. */
  binDirs: string[];
  keySource: KeySource;
  linux: boolean;
}): { steps: UninstallStep[]; leftovers: string[] } {
  const steps: UninstallStep[] = [];
  if (o.service.installed) steps.push({ describe: "stop and remove the background service", run: o.service.uninstall });

  // OpenCode has no `mcp remove`: its entry is listed below for the owner to take out.
  const forget: Record<string, string[]> = { "claude-code": ["claude", "mcp", "remove", "--scope", "user", "hewn"], codex: ["codex", "mcp", "remove", "hewn"] };
  for (const h of o.harnesses) {
    const argv = forget[h.agentId];
    if (!argv || !h.registered(o.userHome)) continue;
    steps.push({ describe: `remove Hewn from ${h.label} (${argv.join(" ")})`, run: () => o.exec(argv[0], argv.slice(1)) });
  }
  for (const file of [join(o.userHome, ".claude", "CLAUDE.md"), join(o.userHome, ".codex", "AGENTS.md"), join(opencodeConfigDir(o.userHome), "AGENTS.md")]) {
    if (existsSync(file) && readFileSync(file, "utf8").includes(MARKDOWN.begin)) {
      steps.push({ describe: `remove the Hewn pointer block from ${file}`, run: () => void removeBlock(file, MARKDOWN) });
    }
  }

  // A checkout's `hewn` is install.sh's symlink to cli.ts; the npm package's is npm's own (npm uninstall removes it).
  const cli = o.bundled ? undefined : realpathSync(join(o.appDir, "packages", "cli", "src", "cli.ts"));
  for (const dir of cli ? o.binDirs : []) {
    const link = join(dir, "hewn");
    try {
      if (lstatSync(link).isSymbolicLink() && realpathSync(link) === cli) steps.push({ describe: `remove the hewn command (${link})`, run: () => rmSync(link) });
    } catch {
      // not there
    }
  }

  const home = (() => {
    try {
      return realpathSync(o.homeRoot);
    } catch {
      return o.homeRoot;
    }
  })();
  const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const opencode = o.harnesses.find((h) => h.agentId === "opencode");
  const leftovers = [
    `your data: rm -rf ${q(o.homeRoot)}`,
    ...(opencode?.registered(o.userHome) ? [`Hewn in OpenCode: take "hewn" out of "mcp" in ${join(opencodeConfigDir(o.userHome), "opencode.json")} (or .jsonc)`] : []),
    ...(existsSync(o.backupDir) ? [`backups: rm -rf ${q(o.backupDir)}`] : []),
    o.bundled ? `Hewn itself: npm uninstall -g${o.npmPrefix ? ` --prefix ${q(o.npmPrefix)}` : ""} @hewntools/cli` : `Hewn itself (this checkout): rm -rf ${q(o.appDir)}`,
    o.keySource === "keychain"
      ? `the secrets key: security delete-generic-password -s hewn-master -a ${q(home)}`
      : o.keySource === "libsecret"
        ? `the secrets key: secret-tool clear service hewn-master home ${q(home)}`
        : "the secrets key (master.key) goes with the data folder",
    ...(o.linux ? ["lingering (keeps your user services running after logout): loginctl disable-linger, if nothing else needs it"] : []),
  ];
  return { steps, leftovers };
}
