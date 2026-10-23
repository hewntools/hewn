// SPDX-License-Identifier: AGPL-3.0-or-later
// One descriptor per coding-agent CLI Hewn runs (Claude Code, Codex, OpenCode): what the builder wiring, the intake,
// setup, doctor, the workbench and Settings › AI need to know about each. Another agent is one more entry here, with
// its run functions in cli.ts and intake.ts. (The sandbox profile and the activity formatters still name agents
// themselves: a later pass.)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { JobModel, ModelCatalog } from "@hewntools/host-workerd/surface/host.ts";
import type { Intake } from "@hewntools/host-workerd/surface/intake-types.ts";
import { claudeIntake, codexIntake, opencodeIntake } from "../intake.ts";
import { claudeBuildHome, claudeBuilder, codexBuildHome, codexBuilder, modelUnavailableText, opencodeBuildHome, opencodeBuilder } from "./cli.ts";
import { claudeCatalog, codexCatalog, MODEL_REJECTED, modelRejectReason, noteModelFailure, noteModelRan, opencodeCatalog } from "./models.ts";
import { OPENCODE_NO_UPDATE } from "./opencode-dirs.ts";
import type { CapabilityBuilder } from "./types.ts";

export type CliAgentName = "claude" | "codex" | "opencode";

export interface CliAgent {
  /** Hewn's name for it as a builder and an intake (`builder` / `intake` in the settings). */
  name: CliAgentName;
  /** Its id as an agent connected to Hewn (the harness): Claude Code's differs from its builder name. */
  harnessId: string;
  label: string;
  /** The command on PATH. */
  bin: string;
  /** How to install it, for the first run and `hewn doctor`. */
  install: string;
  /** How to sign in, for the same. */
  login: string;
  /** Signed in? `undefined`: can't tell. */
  loggedIn(): boolean | undefined;
  /** Its models, for Settings › AI and the model menu in the chat box. */
  catalog(): Promise<ModelCatalog>;
  /** Where a build's home lives: one per build, removed with the workspace. */
  buildHome(platformHome: string, buildId: string): string;
  builder: CapabilityBuilder;
  /**
   * The intake on it (one request, one reply), confined like a build, on the owner's model for building: the run
   * itself. `cliIntake` below is the one to call: it adds what every CLI shares (a model that won't run stops it,
   * in the owner's words, and the lists remember).
   */
  intake(platformRoot: string, model: JobModel): Intake;
}

export const CLI_AGENTS: Record<CliAgentName, CliAgent> = {
  claude: {
    name: "claude",
    harnessId: "claude-code",
    label: "Claude Code",
    bin: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    login: "run claude once and sign in",
    // Its login: the credentials file where there is one, else (macOS) the Keychain item.
    loggedIn: () => {
      if (existsSync(join(homedir(), ".claude", ".credentials.json"))) return true;
      if (platform() === "darwin") return spawnSync("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials"]).status === 0;
      return false;
    },
    catalog: async () => claudeCatalog(),
    buildHome: claudeBuildHome,
    builder: claudeBuilder,
    intake: claudeIntake,
  },
  codex: {
    name: "codex",
    harnessId: "codex",
    label: "Codex",
    bin: "codex",
    install: "npm install -g @openai/codex",
    login: "run codex login",
    loggedIn: () => {
      const r = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
      return r.status === 0 && /logged in/i.test(r.stdout + r.stderr);
    },
    catalog: codexCatalog,
    buildHome: codexBuildHome,
    builder: codexBuilder,
    intake: codexIntake,
  },
  opencode: {
    name: "opencode",
    harnessId: "opencode",
    label: "OpenCode",
    bin: "opencode",
    install: "curl -fsSL https://opencode.ai/install | bash",
    login: "run opencode auth login",
    // Signed in to a provider, or not: it also runs on keys from the environment, on local models and on its free tier, so "no" can't be told.
    loggedIn: () => {
      const r = spawnSync("opencode", ["auth", "list"], { encoding: "utf8", timeout: 15_000, env: { ...process.env, ...OPENCODE_NO_UPDATE } });
      const n = /(\d+)\s+credentials?/i.exec(r.stdout + r.stderr)?.[1];
      return n && Number(n) > 0 ? true : undefined;
    },
    catalog: opencodeCatalog,
    buildHome: opencodeBuildHome,
    builder: opencodeBuilder,
    intake: opencodeIntake,
  },
};

export const CLI_AGENT_NAMES = Object.keys(CLI_AGENTS) as CliAgentName[];
export const isCliAgent = (name: string): name is CliAgentName => Object.hasOwn(CLI_AGENTS, name);

/** The builders by name (the workbench's `builders`). */
export const BUILDERS: Record<string, CapabilityBuilder> = Object.fromEntries(CLI_AGENT_NAMES.map((n) => [n, CLI_AGENTS[n].builder]));

/** Each agent's model list, for the catalogs Settings › AI, the intake and the Inbox read (`modelCatalogs`). */
export const cliCatalogs = (): Record<string, () => Promise<ModelCatalog>> => Object.fromEntries(CLI_AGENT_NAMES.map((n) => [n, CLI_AGENTS[n].catalog]));

/**
 * The intake on one of the CLIs, on the owner's model for building (`run`, Settings › AI): one the CLI won't run
 * stops it with a reason the owner can act on (pick another), never a quiet switch to the default; the lists
 * remember which model failed.
 */
export function cliIntake(which: CliAgentName, platformRoot: string, run: JobModel = {}): Intake {
  const once = CLI_AGENTS[which].intake(platformRoot, run);
  return async (req, onProgress, signal) => {
    try {
      const reply = await once(req, onProgress, signal);
      if (run.model) noteModelRan(which, run.model);
      return reply;
    } catch (e) {
      if (run.model && !signal?.aborted && MODEL_REJECTED.test((e as Error).message)) {
        const reason = modelRejectReason((e as Error).message);
        noteModelFailure(which, run.model, reason);
        throw new Error(modelUnavailableText(run.model, reason));
      }
      throw e;
    }
  };
}
