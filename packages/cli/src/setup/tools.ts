// SPDX-License-Identifier: AGPL-3.0-or-later
// Is a builder / intake CLI installed and signed in? Used by `hewn doctor`, the first run and Settings › AI.
import { spawnSync } from "node:child_process";
import { CLI_AGENT_NAMES, CLI_AGENTS, type CliAgentName, isCliAgent } from "../builders/cli-agents.ts";

export interface ToolStatus {
  name: CliAgentName;
  label: string;
  /** Its id as an agent connected to Hewn (Claude Code's differs from its builder name); the web shows its tile by it. */
  harnessId?: string;
  found: boolean;
  /** undefined: can't tell. */
  loggedIn?: boolean;
  /** What to do when it isn't ready. */
  fix?: string;
}

export const onPath = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;

/** Signed in? `undefined`: can't tell (OpenCode runs on keys from the environment, local models and its free tier too). */
export const loggedIn = (name: string): boolean | undefined => (isCliAgent(name) ? CLI_AGENTS[name].loggedIn() : undefined);

export function toolStatus(which = onPath, signedIn: (name: CliAgentName) => boolean | undefined = loggedIn): ToolStatus[] {
  return CLI_AGENT_NAMES.map((name) => {
    const a = CLI_AGENTS[name];
    const found = which(a.bin);
    const li = found ? signedIn(name) : undefined;
    const fix = !found ? `Install it: ${a.install}` : li === false ? `Sign in: ${a.login}` : undefined;
    return { name, label: a.label, harnessId: a.harnessId, found, ...(li === undefined ? {} : { loggedIn: li }), ...(fix ? { fix } : {}) };
  });
}
