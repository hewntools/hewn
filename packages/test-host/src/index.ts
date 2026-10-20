// SPDX-License-Identifier: AGPL-3.0-or-later
// The core on Node: what tests and local development use. Capability code runs in-process here
// (no isolation); the workerd host is the one that isolates and gates egress.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import { Platform } from "@hewntools/core/platform.ts";
import type { SecretStore } from "@hewntools/core/ports.ts";
import type { Home } from "@hewntools/cli/home.ts";
import type { VisualCheck } from "@hewntools/cli/visual.ts";
import { dirBlobs } from "./blobs.ts";
import { inProcessRuntime } from "./runtime.ts";
import { nodeSql } from "./sql.ts";
import { localWorkbench } from "@hewntools/cli/workbench.ts";
import { APP_DIR } from "@hewntools/cli/app-dir.ts";
import { readConfig } from "@hewntools/cli/config.ts";
import { agentModels, jobModel, type ModelCatalog } from "@hewntools/host-workerd/surface/host.ts";
import { offlineCatalog } from "@hewntools/cli/builders/models.ts";

export const BRIEF = readFileSync(join(APP_DIR, "spec", "builder-brief.md"), "utf8");

export interface NodePlatformOptions {
  builders?: Record<string, CapabilityBuilder> | (() => Record<string, CapabilityBuilder>);
  /** Which builder new builds use. */
  builder?: () => string | undefined;
  maxBuildAttempts?: () => number;
  logRetentionDays?: () => number;
  secrets?: SecretStore;
  logger?: (message: string) => void;
  /** Run builders under the OS sandbox (confined away from the platform home). */
  sandboxBuilders?: () => boolean;
  visualCheck?: VisualCheck;
  /** HTTP for model providers and the model catalog (Hewn passes fetch; tests pass a fake). */
  modelFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Builds that may run at once (default 5). */
  maxRunningBuilds?: number;
  /** Each builder's model list, for the efforts agents may ask for (default: without asking a CLI). */
  models?: (agent: string) => Promise<ModelCatalog>;
}

export function nodePlatform(home: Home, opts: NodePlatformOptions = {}): Platform {
  return new Platform({
    sql: nodeSql(home.db),
    blobs: dirBlobs(join(home.root, "blobs")),
    runtime: inProcessRuntime(home),
    workbench: localWorkbench({
      root: home.builds,
      builders: opts.builders ?? {},
      confineTo: () => (opts.sandboxBuilders?.() ? home.root : undefined),
      visualCheck: opts.visualCheck,
    }),
    secrets: opts.secrets,
    brief: BRIEF,
    designSystem: async () => readFileSync(new URL(import.meta.resolve("@hewntools/ui/ui.css")), "utf8"),
    logger: opts.logger,
    builder: opts.builder,
    maxBuildAttempts: opts.maxBuildAttempts,
    logRetentionDays: opts.logRetentionDays,
    timezone: () => readConfig(home).timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    modelFetch: opts.modelFetch,
    // The owner's model choices, from platform.json (Settings › AI writes them there on this host).
    buildModel: (builder) => jobModel(readConfig(home), "builder", builder),
    agentBuildModels: (builder) => agentModels(readConfig(home), builder),
    modelEfforts: async (builder, model) => (await (opts.models ?? offlineCatalog)(builder)).models.find((m) => m.id === model)?.efforts,
    maxRunningBuilds: opts.maxRunningBuilds,
  });
}
