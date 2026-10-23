// SPDX-License-Identifier: AGPL-3.0-or-later
// Is a builder / intake CLI installed and signed in? Used by `hewn doctor` and the first run.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { OPENCODE_NO_UPDATE } from "../builders/opencode-dirs.ts";

export interface ToolStatus {
  name: "claude" | "codex" | "opencode";
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
  if (name === "opencode") {
    // Signed in to a provider, or not: OpenCode also runs on keys from the environment, on local models and on its free tier, so "no" can't be told.
    const r = spawnSync("opencode", ["auth", "list"], { encoding: "utf8", timeout: 15_000, env: { ...process.env, ...OPENCODE_NO_UPDATE } });
    const n = /(\d+)\s+credentials?/i.exec(r.stdout + r.stderr)?.[1];
    return n && Number(n) > 0 ? true : undefined;
  }
  return undefined;
}

const INSTALL: Record<ToolStatus["name"], { label: string; install: string; login: string }> = {
  claude: { label: "Claude Code", install: "npm install -g @anthropic-ai/claude-code", login: "run claude once and sign in" },
  codex: { label: "Codex", install: "npm install -g @openai/codex", login: "run codex login" },
  opencode: { label: "OpenCode", install: "curl -fsSL https://opencode.ai/install | bash", login: "run opencode auth login" },
};

export function toolStatus(which = onPath, signedIn = loggedIn): ToolStatus[] {
  return (["claude", "codex", "opencode"] as const).map((name) => {
    const found = which(name);
    const li = found ? signedIn(name) : undefined;
    const fix = !found ? `Install it: ${INSTALL[name].install}` : li === false ? `Sign in: ${INSTALL[name].login}` : undefined;
    return { name, label: INSTALL[name].label, found, ...(li === undefined ? {} : { loggedIn: li }), ...(fix ? { fix } : {}) };
  });
}
