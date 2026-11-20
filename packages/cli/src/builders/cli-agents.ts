// SPDX-License-Identifier: AGPL-3.0-or-later
// One descriptor per coding-agent CLI Hewn runs (Claude Code, Codex, OpenCode): what the builder wiring, the intake,
// setup, doctor, the workbench and Settings › AI need to know about each. Another agent is one more entry here, with
// its run functions in cli.ts and intake.ts. (The sandbox profile and the activity formatters still name agents
// themselves: a later pass.)
import type { JobModel, ModelCatalog } from "@hewntools/host-workerd/surface/host.ts";
import type { Intake } from "@hewntools/host-workerd/surface/intake-types.ts";
import { claudeIntake, codexIntake, opencodeIntake } from "../intake.ts";
import { join } from "node:path";
import { claudeBuilder, codexBuilder, modelUnavailableText, OPENCODE_READER_RULES, opencodeBuilder, opencodeHome } from "./cli.ts";
import { claudeCatalog, codexCatalog, MODEL_REJECTED, modelRejectReason, noteModelFailure, noteModelRan, opencodeCatalog } from "./models.ts";
import { builderHome, codexEnv, signedIn } from "./sign-in.ts";
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
  /** Its models, for Settings › AI and the model menu in the chat box: as its builder home on this Hewn sees them, once signed in. */
  catalog(platformHome: string): Promise<ModelCatalog>;
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
    catalog: async () => claudeCatalog(),
    builder: claudeBuilder,
    intake: claudeIntake,
  },
  codex: {
    name: "codex",
    harnessId: "codex",
    label: "Codex",
    bin: "codex",
    install: "npm install -g @openai/codex",
    catalog: async (platformHome) => codexCatalog((await signedIn("codex", platformHome)) ? codexEnv(builderHome(platformHome, "codex"), process.env) : undefined),
    builder: codexBuilder,
    intake: codexIntake,
  },
  opencode: {
    name: "opencode",
    harnessId: "opencode",
    label: "OpenCode",
    bin: "opencode",
    install: "curl -fsSL https://opencode.ai/install | bash",
    // Its logins and providers in its builder home are what a build runs on; before its sign-in, your own OpenCode's.
    catalog: async (platformHome) => {
      if (!(await signedIn("opencode", platformHome))) return opencodeCatalog();
      const home = builderHome(platformHome, "opencode");
      const run = await opencodeHome(home, { rules: OPENCODE_READER_RULES, db: join(home, "models.db") });
      try {
        return await opencodeCatalog(run.env);
      } finally {
        run.done();
      }
    },
    builder: opencodeBuilder,
    intake: opencodeIntake,
  },
};

export const CLI_AGENT_NAMES = Object.keys(CLI_AGENTS) as CliAgentName[];
export const isCliAgent = (name: string): name is CliAgentName => Object.hasOwn(CLI_AGENTS, name);

/** The builders by name (the workbench's `builders`). */
export const BUILDERS: Record<string, CapabilityBuilder> = Object.fromEntries(CLI_AGENT_NAMES.map((n) => [n, CLI_AGENTS[n].builder]));

/** Each agent's model list, for the catalogs Settings › AI, the intake and the Inbox read (`modelCatalogs`). */
export const cliCatalogs = (platformHome: string): Record<string, () => Promise<ModelCatalog>> => Object.fromEntries(CLI_AGENT_NAMES.map((n) => [n, () => CLI_AGENTS[n].catalog(platformHome)]));

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
