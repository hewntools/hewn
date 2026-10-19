// SPDX-License-Identifier: AGPL-3.0-or-later
// Is a builder / intake CLI installed and signed in? Used by `hewn doctor` and the first run.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export interface ToolStatus {
  name: "claude" | "codex";
  label: string;
  found: boolean;
  /** undefined: can't tell. */
  loggedIn?: boolean;
  /** What to do when it isn't ready. */
  fix?: string;
}

export const onPath = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;

export function loggedIn(name: string): boolean | undefined {
  if (name === "codex") {
    const r = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
    return r.status === 0 && /logged in/i.test(r.stdout + r.stderr);
  }
  if (name === "claude") {
    if (existsSync(join(homedir(), ".claude", ".credentials.json"))) return true;
    if (platform() === "darwin") return spawnSync("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials"]).status === 0;
    return false;
  }
  return undefined;
}

const INSTALL: Record<ToolStatus["name"], { label: string; install: string; login: string }> = {
  claude: { label: "Claude Code", install: "npm install -g @anthropic-ai/claude-code", login: "run claude once and sign in" },
  codex: { label: "Codex", install: "npm install -g @openai/codex", login: "run codex login" },
};

export function toolStatus(which = onPath, signedIn = loggedIn): ToolStatus[] {
  return (["claude", "codex"] as const).map((name) => {
    const found = which(name);
    const li = found ? signedIn(name) : undefined;
    const fix = !found ? `Install it: ${INSTALL[name].install}` : li === false ? `Sign in: ${INSTALL[name].login}` : undefined;
    return { name, label: INSTALL[name].label, found, ...(li === undefined ? {} : { loggedIn: li }), ...(fix ? { fix } : {}) };
  });
}
