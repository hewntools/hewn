// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Agent, USER } from "@hewntools/core/auth.ts";
import type { BuildJob, CapabilityBuilder } from "@hewntools/cli/builders/types.ts";
import type { BuildView, Platform } from "@hewntools/core/platform.ts";
import { type Home, openHome } from "@hewntools/cli/home.ts";
import { nodeSurfaceHost } from "@hewntools/test-host/surface.ts";
import type { SetupHooks } from "@hewntools/cli/setup/hooks.ts";
import type { Intake } from "@hewntools/cli/intake.ts";
import { startServer } from "@hewntools/test-host/server.ts";
import { nodePlatform, type NodePlatformOptions } from "@hewntools/test-host/index.ts";
import { MemorySecretStore } from "@hewntools/test-host/secrets.ts";

export const SEED = resolve(import.meta.dirname, "../seeds/running-log");
export const FIXTURES = resolve(import.meta.dirname, "fixtures");
/** Access tokens of the test agents, minted by each setup() (as an approved OAuth flow would). */
export const TOKENS = { claude: "", codex: "", outsider: "" };

/** What a test builder does to the workspace (stands in for Claude/Codex editing files). */
export type Script = (workspace: string, job: BuildJob) => void | Promise<void>;

export function setup(opts: NodePlatformOptions & { attempts?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hewn-test-"));
  const home = openHome(root);
  // Each platform build runs the next queued script (one per builder attempt).
  const scripts: Script[] = [];
  const scripted: CapabilityBuilder = {
    name: "script",
    build: async (job) => {
      const s = scripts.shift();
      if (!s) throw new Error("test builder: no script queued for this attempt");
      await s(job.workspace, job);
    },
  };
  const platform = nodePlatform(home, {
    secrets: new MemorySecretStore(),
    builders: { script: scripted },
    builder: () => "script",
    maxBuildAttempts: () => opts.attempts ?? 1,
    ...opts,
  });
  const store = platform.agentStore;
  const approve = (name: string, scopes: Agent["scopes"] extends ReadonlySet<infer S> ? S[] : never, caps: "*" | string[] = "*") => store.issue(store.approveDirect(name, scopes, caps)).access_token;
  TOKENS.claude = approve("claude-code", ["discover", "invoke", "create", "modify"]);
  TOKENS.codex = approve("codex", ["discover", "invoke"]);
  TOKENS.outsider = approve("outsider", ["discover", "invoke"], ["something-else"]);
  const agent = (token: string): Agent => store.authenticate(token)!;
  return {
    home,
    platform,
    claude: agent(TOKENS.claude),
    codex: agent(TOKENS.codex),
    outsider: agent(TOKENS.outsider),
    /**
     * Queue builder scripts, start a build, and wait for it to finish. An agent's change that waits
     * for the owner's review is approved as the owner (review itself: review.test.ts).
     */
    async build(start: () => Promise<BuildView>, ...edits: Script[]): Promise<BuildView> {
      scripts.push(...edits);
      const b = await start();
      const done = await platform.settle(b.buildId);
      return done.status === "review" ? platform.approveBuild(USER, b.buildId) : done;
    },
    /** Queue scripts for builds started elsewhere (e.g. through MCP or the web API). */
    queue(...edits: Script[]) {
      scripts.push(...edits);
    },
    cleanup: () => {
      platform.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Install a capability from a directory (copy builder), as `hewn install` does. */
export async function installFrom(platform: Platform, dir: string, name?: string) {
  const manifest = JSON.parse(readFileSync(join(dir, "capability.json"), "utf8"));
  const started = await platform.install(USER, { name: name ?? manifest.name, purpose: manifest.purpose, builder: `copy:${dir}` });
  const result = await platform.settle(started.buildId);
  if (result.status !== "promoted") throw new Error(result.log.join("\n"));
  return result;
}

export const installSeed = (platform: Platform) => installFrom(platform, SEED);

/** Simulates a builder editing a workspace file. */
export function editJson(path: string, fn: (v: any) => void) {
  const v = JSON.parse(readFileSync(path, "utf8"));
  fn(v);
  writeFileSync(path, JSON.stringify(v, null, 2));
}

export function editText(path: string, fn: (s: string) => string) {
  writeFileSync(path, fn(readFileSync(path, "utf8")));
}

/** A platform whose builds go to `b` (resolved per build, so a test can swap it). */
export const platformWith = (home: Home, b: () => CapabilityBuilder, opts: Omit<NodePlatformOptions, "builders" | "builder"> & { attempts?: number } = {}) =>
  nodePlatform(home, {
    secrets: new MemorySecretStore(),
    ...opts,
    builders: () => ({ [b().name]: b() }),
    builder: () => b().name,
    maxBuildAttempts: () => opts.attempts ?? 3,
  });

/** Start the HTTP surface (web client, UIs, MCP) for a test platform on a free port. */
export const serve = (platform: Platform, home: Home, opts: { intake?: Intake; setup?: SetupHooks; log?: (l: string) => void } = {}) =>
  startServer(platform, 0, (port) => nodeSurfaceHost(home, { port, log: opts.log ?? (() => {}), intake: opts.intake, setup: opts.setup }));
