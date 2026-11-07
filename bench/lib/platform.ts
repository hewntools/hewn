// SPDX-License-Identifier: AGPL-3.0-or-later
// A throwaway Hewn for one bench result: the real platform (builds, validation with the render check,
// promotion) on the in-process runtime, building with the real Claude Code builder.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { USER } from "@hewntools/core/auth.ts";
import { Platform } from "@hewntools/core/platform.ts";
import { openHome } from "@hewntools/cli/home.ts";
import { localWorkbench } from "@hewntools/cli/workbench.ts";
import { claudeBuilder } from "@hewntools/cli/builders/cli.ts";
import type { BuildJob, CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import { chromiumCheck } from "@hewntools/cli/visual.ts";
import { dirBlobs } from "@hewntools/test-host/blobs.ts";
import { inProcessRuntime } from "@hewntools/test-host/runtime.ts";
import { nodeSql } from "@hewntools/test-host/sql.ts";
import { MemorySecretStore } from "@hewntools/test-host/secrets.ts";
import type { Pass } from "@hewntools/core/passes.ts";
import type { Served } from "./ui-server.ts";

export interface BenchPlatformOptions {
  /** The brief builds run on (default: none; a platform that only serves and seeds). */
  brief?: string;
  model?: string;
  effort?: string;
  /** Run the builder under the OS sandbox, as Hewn does (default true). */
  sandbox?: boolean;
  /** Where each attempt's transcript (.log, .jsonl) is copied. */
  transcripts?: string;
  log?: (line: string) => void;
  /** Who builds (default: Claude Code, as Hewn runs it). Tests pass a scripted one. */
  builder?: CapabilityBuilder;
  /** Hewn's own passes on a new tool's build (its pipeline), in order. Default: none (the bench runs its arms' passes itself). */
  passes?: Pass[];
}

export interface BenchPlatform {
  platform: Platform;
  root: string;
  /** Files dropped into the next build's workspace (relative path → source file), removed after it. */
  extraFiles: Record<string, string>;
  close(): void;
}

export function benchPlatform(root: string, o: BenchPlatformOptions = {}): BenchPlatform {
  const home = openHome(root);
  const extraFiles: Record<string, string> = {};
  const builder: CapabilityBuilder = {
    name: "claude",
    build: async (job: BuildJob) => {
      for (const [rel, from] of Object.entries(extraFiles)) {
        mkdirSync(dirname(join(job.workspace, rel)), { recursive: true });
        cpSync(from, join(job.workspace, rel));
      }
      try {
        await (o.builder ?? claudeBuilder).build(job);
      } finally {
        for (const rel of Object.keys(extraFiles)) rmSync(join(job.workspace, rel.split("/")[0]), { recursive: true, force: true });
        if (o.transcripts) {
          mkdirSync(o.transcripts, { recursive: true });
          for (const ext of [".log", ".jsonl"]) {
            const from = job.logPath.replace(/\.log$/, ext);
            if (existsSync(from)) cpSync(from, join(o.transcripts, `${job.buildId}-a${job.attempt}${ext}`));
          }
        }
      }
    },
  };
  const platform = new Platform({
    sql: nodeSql(home.db),
    blobs: dirBlobs(join(home.root, "blobs")),
    runtime: inProcessRuntime(home),
    workbench: localWorkbench({ root: home.builds, builders: { claude: builder }, confineTo: () => (o.sandbox === false ? undefined : home.root), visualCheck: chromiumCheck() }),
    secrets: new MemorySecretStore(),
    brief: o.brief ?? "",
    designSystem: async () => readFileSync(new URL(import.meta.resolve("@hewntools/ui/ui.css")), "utf8"),
    logger: o.log,
    builder: () => "claude",
    maxBuildAttempts: () => 3,
    buildPasses: () => o.passes ?? [],
    buildModel: () => ({ ...(o.model ? { model: o.model } : {}), ...(o.effort ? { effort: o.effort } : {}) }),
    agentBuildModels: () => ["default", ...(o.model ? [o.model] : [])],
    modelEfforts: async () => (o.effort ? [o.effort] : undefined),
  });
  return { platform, root, extraFiles, close: () => platform.close() };
}

/** Settle a build, approving it if it waits for the owner's review. */
export async function settle(platform: Platform, buildId: string) {
  const v = await platform.settle(buildId);
  return v.status === "review" ? platform.approveBuild(USER, buildId) : v;
}

/** Write the active version's files to `dir` (the UI is served from there). */
export async function exportVersion(platform: Platform, capabilityId: string, version: number, dir: string) {
  const { files } = await platform.loadVersion(capabilityId, version);
  rmSync(dir, { recursive: true, force: true });
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
}

/** The tool's UI as Hewn serves it, calling its operations on this platform's state. */
export function served(platform: Platform, capabilityId: string, versionDir: string): Served {
  const manifest = JSON.parse(readFileSync(join(versionDir, "capability.json"), "utf8"));
  return {
    id: capabilityId,
    uiDir: join(versionDir, "ui"),
    manifest: { ...manifest, status: { ready: true, missingSecrets: [], missingConfig: [], pendingGrants: [], missingDependencies: [] } },
    invoke: async (body) => {
      const r: any = await platform.invoke(USER, { capabilityId, operation: body.operation, operationVersion: body.operationVersion, input: body.input });
      return { result: r?.result !== undefined ? r.result : r };
    },
  };
}

/** Call an operation as the owner; its result, or a thrown error with the operation's message. */
export const caller = (platform: Platform, capabilityId: string) => async (operation: string, input: Record<string, unknown> = {}) => {
  const r: any = await platform.invoke(USER, { capabilityId, operation, input });
  return r?.result !== undefined ? r.result : r;
};
