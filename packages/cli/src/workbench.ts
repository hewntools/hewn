// SPDX-License-Identifier: AGPL-3.0-or-later
// The Workbench port on the local machine: workspaces are directories, builders are local CLIs
// (optionally OS-sandboxed), bundles are built with esbuild. Used by the Node host and by the
// supervisor on behalf of the workerd host.
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { build as esbuild, type Plugin } from "esbuild";
import type { CapabilityBuilder } from "./builders/types.ts";
import { CLI_AGENTS } from "./builders/cli-agents.ts";
import { forgetSession } from "./builders/cli.ts";
import { isArtefact } from "@hewntools/core/files.ts";
import type { BuildJob, Files, VisualCheckArgs, VisualCheckResult, Workbench } from "@hewntools/core/ports.ts";
import type { VisualCheck } from "./visual.ts";

export interface LocalWorkbenchOptions {
  /** Where workspaces (<root>/<buildId>/) and transcripts (<root>/<buildId>.log) live. */
  root: string;
  /** Named builders ("claude", "codex", or test builders). "copy:<dir>" is always available. */
  builders: Record<string, CapabilityBuilder> | (() => Record<string, CapabilityBuilder>);
  /** Confine builders (Seatbelt / bubblewrap): this is the platform home they may not read. Unset = unconfined. */
  confineTo?: () => string | undefined;
  visualCheck?: VisualCheck;
}

/** Files of a directory as a map, artefacts (node_modules …) excluded. */
export function readTree(dir: string): Files {
  const out: Files = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (isArtefact(rel)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out[rel] = new Uint8Array(readFileSync(p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

export function writeTree(dir: string, files: Files) {
  for (const [p, b] of Object.entries(files)) {
    const target = join(dir, p);
    if (!target.startsWith(dir + "/")) throw new Error(`bad path ${p}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, b);
  }
}

/** A builder that copies a directory into the workspace (`hewn install <dir>`). */
export const copyBuilder = (from: string): CapabilityBuilder => ({
  name: `copy:${from}`,
  build: async (job) => {
    if (!existsSync(join(from, "capability.json"))) throw Object.assign(new Error(`${from} has no capability.json`), { unavailable: true });
    // Keep BUILDER.md; replace everything else with the source.
    for (const e of readdirSync(job.workspace)) if (e !== "BUILDER.md") rmSync(join(job.workspace, e), { recursive: true, force: true });
    cpSync(from, job.workspace, { recursive: true, filter: (src) => !isArtefact(relative(from, src)) });
  },
});

function npmInstall(cwd: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const out: string[] = [];
    const child = spawn("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => out.push(String(d)));
    child.stderr.on("data", (d) => out.push(String(d)));
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve(["dependencies installed (npm)"]) : reject(new Error(`npm install failed: ${out.join("").slice(-800)}`))));
  });
}

/** Marks the resolve call `insideWorkspace` makes itself, so it doesn't check its own lookup. */
const CHECKING = Symbol("inside-workspace");

/**
 * Keeps a bundle to the workspace's own files: an import that resolves (links followed) outside it
 * is refused, and so is an import attribute other than `type: "json"` (`with { type: "text" }`
 * would inline any file as a string). Without it, a tool's code (a builder's, or a shared file's)
 * could pull the machine's files into its bundle: Hewn's own settings, a key, `~/.ssh`. Its
 * `node_modules` is inside it, so npm dependencies bundle as before.
 */
function insideWorkspace(ws: string): Plugin {
  const root = realpathSync(ws);
  return {
    name: "inside-workspace",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === CHECKING) return undefined;
        const attrs = Object.entries(args.with ?? {});
        if (attrs.some(([k, v]) => k !== "type" || v !== "json")) return { errors: [{ text: `import "${args.path}" with { ${attrs.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")} }: a tool may import JSON with { type: "json" }, nothing else` }] };
        const r = await build.resolve(args.path, { kind: args.kind, importer: args.importer, namespace: args.namespace, resolveDir: args.resolveDir, with: args.with, pluginData: CHECKING });
        if (r.errors.length) return { errors: r.errors };
        if (!r.external && r.namespace === "file") {
          let real = "";
          try {
            real = realpathSync(r.path);
          } catch {
            // Not there: refused below, as outside.
          }
          if (real !== root && !real.startsWith(root + sep)) return { errors: [{ text: `"${args.path}" is outside the tool's files: a tool's code may only import its own files and its npm dependencies` }] };
        }
        return { path: r.path, external: r.external, namespace: r.namespace, sideEffects: r.sideEffects, suffix: r.suffix, pluginData: r.pluginData };
      });
    },
  };
}

/** Bundle a workspace's src/index.ts (+ npm dependencies) into one ESM module for the isolate runtime. */
export async function bundleWorkspace(ws: string): Promise<{ js: string; log: string[] }> {
  const log: string[] = [];
  const entry = ["src/index.ts", "src/index.js"].map((p) => join(ws, p)).find(existsSync);
  if (!entry) throw new Error("src/index.ts is missing");
  const pkgPath = join(ws, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (Object.keys(pkg.dependencies ?? {}).length && !existsSync(join(ws, "node_modules"))) log.push(...(await npmInstall(ws)));
  }
  const result = await esbuild({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    conditions: ["workerd", "worker", "browser", "import", "default"],
    mainFields: ["module", "main"],
    external: ["node:*", "cloudflare:*"],
    logLevel: "silent",
    absWorkingDir: ws,
    plugins: [insideWorkspace(ws)],
  }).catch((e: { errors?: { text: string; location?: { file: string; line: number } }[] }) => {
    throw new Error((e.errors ?? []).map((x) => `${x.location ? `${x.location.file}:${x.location.line}: ` : ""}${x.text}`).join("; ") || String(e));
  });
  const js = result.outputFiles[0].text;
  log.push(`bundled src/index.ts (${Math.round(js.length / 1024)} KB)`);
  return { js, log };
}

export function localWorkbench(opts: LocalWorkbenchOptions): Workbench {
  const ws = (buildId: string) => join(opts.root, buildId);
  const transcript = (buildId: string) => join(opts.root, `${buildId}.log`);
  const builders = () => (typeof opts.builders === "function" ? opts.builders() : opts.builders);
  mkdirSync(opts.root, { recursive: true });

  return {
    async open(buildId, files) {
      rmSync(ws(buildId), { recursive: true, force: true });
      mkdirSync(ws(buildId), { recursive: true });
      writeTree(ws(buildId), files);
    },
    async read(buildId) {
      return readTree(ws(buildId));
    },
    async file(buildId, path) {
      const p = join(ws(buildId), path);
      if (!p.startsWith(ws(buildId) + "/") || !existsSync(p)) return undefined;
      return new Uint8Array(readFileSync(p));
    },
    async remove(buildId) {
      rmSync(ws(buildId), { recursive: true, force: true });
      // What its builder kept between attempts: its home per build (Claude Code's config dir, Codex's and OpenCode's HOME: the session).
      for (const a of Object.values(CLI_AGENTS)) rmSync(a.buildHome(dirname(opts.root), buildId), { recursive: true, force: true });
      forgetSession(buildId);
    },
    async build(job: BuildJob, hooks) {
      // "keep": the workspace is already the candidate (an install from given files, an owner's edit); "bundle": a tool installed from a file.
      if (job.builder === "keep" || job.builder === "bundle") return;
      const builder = job.builder.startsWith("copy:") ? copyBuilder(job.builder.slice("copy:".length)) : builders()[job.builder];
      if (!builder) throw Object.assign(new Error(`unknown builder '${job.builder}'`), { unavailable: true });
      await builder.build({
        buildId: job.buildId,
        capabilityId: job.capabilityId,
        kind: job.kind,
        workspace: ws(job.buildId),
        attempt: job.attempt,
        feedback: job.feedback,
        logPath: transcript(job.buildId),
        builderName: job.builder,
        platformRoot: opts.confineTo?.(),
        signal: hooks.signal,
        onActivity: hooks.onActivity,
        ...(job.model ? { model: job.model } : {}),
        ...(job.effort ? { effort: job.effort } : {}),
        onModel: hooks.onModel,
        onCharge: hooks.onCharge,
      });
    },
    async bundle(buildId) {
      return bundleWorkspace(ws(buildId));
    },
    async note(buildId, line) {
      appendFileSync(transcript(buildId), line + "\n");
    },
    async transcript(buildId) {
      return existsSync(transcript(buildId)) ? readFileSync(transcript(buildId), "utf8") : undefined;
    },
    async removeTranscript(buildId) {
      for (const f of [transcript(buildId), transcript(buildId).replace(/\.log$/, ".jsonl")]) rmSync(f, { force: true });
    },
    ...(opts.visualCheck
      ? {
          async visualCheck(buildId: string, args: VisualCheckArgs): Promise<VisualCheckResult> {
            const r = await opts.visualCheck!({ uiDir: join(ws(buildId), "ui"), manifest: args.manifest, invoke: args.invoke, ...(args.widgets ? { widgets: args.widgets } : {}) });
            return { skipped: r.skipped, errors: r.errors, screenshot: r.screenshot ? new Uint8Array(r.screenshot) : undefined, screenshotDark: r.screenshotDark ? new Uint8Array(r.screenshotDark) : undefined };
          },
        }
      : {}),
  };
}
