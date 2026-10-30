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
import { CHECK_DIR } from "./builders/check.ts";
import { wrapBuilder } from "./builders/sandbox.ts";
import { dependencyProblems } from "@hewntools/core/bundle.ts";
import { ARTEFACTS, isArtefact } from "@hewntools/core/files.ts";
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

/** Files of a directory as a map, artefacts (node_modules …) excluded; `skip`: paths (files or folders) not to read either. */
export function readTree(dir: string, skip: (rel: string) => boolean = () => false): Files {
  const out: Files = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(dir, p);
      if (isArtefact(rel) || skip(rel)) continue;
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

/** Not copied for a check: its own scratch folder and the screenshots it wrote (neither is part of a version). */
const notChecked = (rel: string) => [CHECK_DIR, "screenshots"].some((d) => rel === d || rel.startsWith(`${d}/`));

/**
 * Run inside the builder's sandbox: the workspace's files as JSON on stdout (base64), with no links,
 * no artefacts and nothing `notChecked`. Reading with the builder's own eyes, a link swapped in
 * mid-copy reaches only what the builder could read itself.
 */
const COPIER = `const fs = require("node:fs"), path = require("node:path");
const [root, artefacts, skipped] = process.argv.slice(1).map((a, i) => (i ? new Set(JSON.parse(a)) : a));
const out = {};
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    const rel = path.relative(root, p);
    if (artefacts.has(e.name) || skipped.has(rel.split(path.sep)[0])) continue;
    if (e.isDirectory()) walk(p);
    else if (e.isFile()) try { out[rel] = fs.readFileSync(p).toString("base64"); } catch {}
  }
};
walk(root);
process.stdout.write(JSON.stringify(out));`;

/** A confined builder's workspace, read through its sandbox (COPIER). */
function readConfined(workspace: string, platformRoot: string): Promise<Files> {
  const { command, args } = wrapBuilder(process.execPath, ["-e", COPIER, workspace, JSON.stringify([...ARTEFACTS]), JSON.stringify([CHECK_DIR, "screenshots"])], { workspace, platformRoot, ownState: [], denyKeychain: true });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`couldn't copy the workspace to check it${err.trim() ? `: ${err.trim().split("\n").at(-1)}` : ""}`));
      try {
        const files: Files = {};
        for (const [p, b] of Object.entries(JSON.parse(Buffer.concat(out).toString("utf8")) as Record<string, string>)) if (typeof b === "string") files[p] = new Uint8Array(Buffer.from(b, "base64"));
        resolve(files);
      } catch (e) {
        reject(e as Error);
      }
    });
  });
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

/** What npm reads from a project before it installs: its settings (only the root's `.npmrc`), package.json and lockfiles. */
const NPM_READS = [".npmrc", "package.json", "package-lock.json", "npm-shrinkwrap.json"];

/**
 * npm runs on the machine itself, not in the builder's sandbox: it doesn't start unless every
 * dependency comes from the npm registry and the tool carries no npm settings (an `.npmrc` could
 * name the `git` npm runs). Validation refuses these first, with the reason; this is the last line.
 */
function npmInstall(cwd: string): Promise<string[]> {
  const files: Files = {};
  for (const p of NPM_READS) if (existsSync(join(cwd, p))) files[p] = new Uint8Array(readFileSync(join(cwd, p)));
  const problems = dependencyProblems(files);
  if (problems.length) return Promise.reject(new Error(`npm won't run for this tool: ${problems.join("; ")}`));
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
    async snapshot(buildId, to) {
      const root = opts.confineTo?.();
      const files = root ? await readConfined(ws(buildId), root) : readTree(ws(buildId), notChecked);
      rmSync(ws(to), { recursive: true, force: true });
      mkdirSync(ws(to), { recursive: true });
      // A fresh folder only Hewn writes; writeTree keeps every path inside it.
      writeTree(ws(to), files);
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
        ...(job.retryOf ? { retryOf: job.retryOf } : {}),
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
        ...(hooks.onCheck ? { check: hooks.onCheck } : {}),
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
            const r = await opts.visualCheck!({ uiDir: join(ws(buildId), "ui"), manifest: args.manifest, invoke: args.invoke, ...(args.widgets ? { widgets: args.widgets } : {}), ...(args.measure ? { measure: true } : {}) });
            return {
              skipped: r.skipped,
              errors: r.errors,
              screenshot: r.screenshot ? new Uint8Array(r.screenshot) : undefined,
              screenshotDark: r.screenshotDark ? new Uint8Array(r.screenshotDark) : undefined,
              ...(r.shots ? { shots: r.shots.map((s) => ({ name: s.name, png: new Uint8Array(s.png) })) } : {}),
              ...(r.defects ? { defects: r.defects } : {}),
            };
          },
        }
      : {}),
  };
}
