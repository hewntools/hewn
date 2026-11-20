// SPDX-License-Identifier: AGPL-3.0-or-later
// Is a builder / intake CLI installed, and signed in on this Hewn (its builder home)? Used by `hewn doctor`, the first run and Settings › AI.
import { spawnSync } from "node:child_process";
import { CLI_AGENT_NAMES, CLI_AGENTS, type CliAgentName } from "../builders/cli-agents.ts";
import { signedIn } from "../builders/sign-in.ts";

export interface ToolStatus {
  name: CliAgentName;
  label: string;
  /** Its id as an agent connected to Hewn (Claude Code's differs from its builder name); the web shows its tile by it. */
  harnessId?: string;
  found: boolean;
  /** Signed in on this Hewn (its builder home), as its own CLI says. undefined: can't tell. */
  loggedIn?: boolean;
  /** What to do when it isn't ready, for the web: installing names its command, signing in says where in words (the terminal names the command). */
  fix?: string;
}

export const onPath = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;

/** What the web says about a builder that isn't signed in on this Hewn: where to go, no command (`hewn builder sign-in` is the terminal's). */
export const SIGN_IN_FIX = "Not signed in on this Hewn · sign in from the terminal on the machine that runs it";

export async function toolStatus(platformHome: string, which = onPath, isSignedIn: (name: CliAgentName) => Promise<boolean | undefined> = (name) => signedIn(name, platformHome)): Promise<ToolStatus[]> {
  return Promise.all(
    CLI_AGENT_NAMES.map(async (name) => {
      const a = CLI_AGENTS[name];
      const found = which(a.bin);
      const li = found ? await isSignedIn(name) : undefined;
      const fix = !found ? `Install it: ${a.install}` : li === false ? SIGN_IN_FIX : undefined;
      return { name, label: a.label, harnessId: a.harnessId, found, ...(li === undefined ? {} : { loggedIn: li }), ...(fix ? { fix } : {}) };
    }),
  );
}
